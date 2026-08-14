import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const STATE_IDLE = 'idle';
const STATE_DRAGGING = 'dragging';
const STATE_CANDIDATE = 'candidate';
const STATE_COMMITTED = 'committed';

const FAST_TAU_MS = 35;
const SLOW_TAU_MS = 230;
const GAP_US = 120_000;

// A throw is not raw speed. The user must first establish a normal drag,
// then produce a short acceleration burst with a velocity peak and falloff.
const THROW_ARM_MIN_US = 100_000;
const THROW_ARM_MIN_TRAVEL = 16;
const THROW_ARM_MAX_FAST_SPEED = 1000;
const THROW_ARM_MAX_IMPULSE = 450;

const THROW_ACCEL_MIN_FAST = 1300;
const THROW_ACCEL_MIN_IMPULSE = 700;
const THROW_ACCEL_MIN_RATIO = 1.50;

const THROW_REVERSAL_MIN_SLOW = 180;
const THROW_REVERSAL_MIN_FAST = 1100;
const THROW_REVERSAL_MAX_ALIGNMENT = -0.30;

const THROW_CANDIDATE_MAX_US = 220_000;
const THROW_MIN_HITS = 3;
const THROW_MIN_TRAVEL = 28;
const THROW_MIN_PEAK_SPEED = 1300;

// The burst must clearly begin slowing again before it counts as a throw.
// This prevents sustained fast dragging from snapping.
const THROW_FALLOFF_MIN_US = 8_000;
const THROW_FALLOFF_MAX_US = 140_000;
const THROW_FALLOFF_RATIO = 0.82;

const THROW_MIN_PEAK_GAIN = 700;
const THROW_MIN_PEAK_RATIO = 1.55;

// If a candidate proves to be sustained fast dragging, do not allow
// another acceleration throw until motion has genuinely settled.
const THROW_REARM_MAX_FAST = 900;
const THROW_REARM_MAX_IMPULSE = 500;
const THROW_REARM_SETTLE_US = 100_000;
const MIN_REVERSAL_SLOW_SPEED = 180;
const MIN_REVERSAL_FAST_SPEED = 700;
const MIN_REVERSAL_ALIGNMENT = -0.18;

const STRAIGHT_RATIO = 0.42;

export class TouchscreenThrowController {
    constructor({
        getWindowAt,
        isTitlebar,
        applyAction,
    }) {
        this._getWindowAt = getWindowAt;
        this._isTitlebar = isTitlebar;
        this._applyAction = applyAction;

        this._capturedEventId = 0;
        this._touchEventId = 0;
        this._inputGrab = null;
        this._applySources = new Set();

        this._releaseInputGrab();

        this._state = STATE_IDLE;
        this._session = null;
        this._gestureCounter = 0;
    }

    enable() {
        if (this._capturedEventId)
            return;

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_actor, event) => this._handleCapturedEvent(event)
        );

        this._touchEventId = global.stage.connect(
            'touch-event',
            (_actor, event) => this._handleStageTouchEvent(event)
        );

        this._grabBeginId = global.display.connect(
            'grab-op-begin',
            () => this._recordGrabEvent('grab-begin')
        );

        this._grabEndId = global.display.connect(
            'grab-op-end',
            () => this._recordGrabEvent('grab-end')
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._touchEventId) {
            global.stage.disconnect(this._touchEventId);
            this._touchEventId = 0;
        }

        this._releaseInputGrab();

        if (this._grabBeginId) {
            global.display.disconnect(this._grabBeginId);
            this._grabBeginId = 0;
        }

        if (this._grabEndId) {
            global.display.disconnect(this._grabEndId);
            this._grabEndId = 0;
        }

        for (const sourceId of this._applySources)
            GLib.source_remove(sourceId);

        this._applySources.clear();

        if (this._session && !this._session.finished) {
            this._session.cancelled = true;
            this._session.outcome = 'disabled';
            this._finishSession(this._session);
        }

        this._state = STATE_IDLE;
        this._session = null;
    }

    _handleCapturedEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS ||
            type === Clutter.EventType.KEY_RELEASE) {
            if (this._inputGrab) {
                this._releaseInputGrab();
            }

            return false;
        }

        if (type !== Clutter.EventType.TOUCH_BEGIN &&
            type !== Clutter.EventType.TOUCH_UPDATE &&
            type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.TOUCH_CANCEL) {
            return false;
        }

        if (type === Clutter.EventType.TOUCH_BEGIN)
            return this._handleTouchBegin(event);

        if (!this._session || !this._eventBelongsToSession(event))
            return false;

        if (type === Clutter.EventType.TOUCH_UPDATE)
            return this._handleTouchUpdate(event);

        return this._handleTouchFinish(
            event,
            type === Clutter.EventType.TOUCH_CANCEL
        );
    }

    _handleStageTouchEvent(event) {
        if (!this._session || !this._inputGrab)
            return false;

        const type = event.type();

        // A second finger does not participate in the active throw.
        if (type === Clutter.EventType.TOUCH_BEGIN)
            return true;

        if (type === Clutter.EventType.TOUCH_UPDATE)
            return this._handleTouchUpdate(event);

        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            return this._handleTouchFinish(
                event,
                type === Clutter.EventType.TOUCH_CANCEL
            );
        }

        return false;
    }

    _handleTouchBegin(event) {
        if (this._session)
            return false;

        const [x, y] = event.get_coords();
        const now = GLib.get_monotonic_time();
        const win = this._getWindowAt(x, y);

        if (!win || !this._isTitlebar(win, x, y))
            return false;

        const sequence = event.get_event_sequence();

        this._session = this._newSession(
            win,
            sequence,
            x,
            y,
            now
        );

        this._session.dragOffsetX =
            x - this._session.initialRect.x;
        this._session.dragOffsetY =
            y - this._session.initialRect.y;

        this._state = STATE_DRAGGING;
        this._recordSample(this._session, x, y, now, 'begin');

        /*
         * Claim future input for this touchscreen drag.
         *
         * Returning TRUE from captured-event handles only the current
         * event. The Clutter grab redirects the following touch events
         * to global.stage so Whoosh continues receiving the sequence.
         */
        this._inputGrab = global.stage.grab(global.stage);


        // Whoosh owns this touchscreen drag. Do not let Mutter start
        // its native title-bar grab, because that steals subsequent
        // TOUCH_UPDATE events from the extension.
        return true;
    }

    _handleTouchUpdate(event) {
        const session = this._session;
        const [x, y] = event.get_coords();
        const now = GLib.get_monotonic_time();

        /*
         * A grabbed touchscreen event can occasionally reach us through
         * both captured-event and touch-event. Ignore the second delivery
         * when it has the same coordinates and arrives essentially
         * immediately after the first one.
         *
         * Real touchscreen samples are normally several milliseconds
         * apart, while duplicate deliveries observed during testing are only about
         * 0.05-0.2 ms apart.
         */
        if (session.lastHandledTouchUs !== undefined) {
            const dtUs =
                now - session.lastHandledTouchUs;

            const samePosition =
                Math.abs(x - session.lastHandledTouchX) < 0.01 &&
                Math.abs(y - session.lastHandledTouchY) < 0.01;

            if (samePosition && dtUs < 2_000)
                return true;
        }

        session.lastHandledTouchUs = now;
        session.lastHandledTouchX = x;
        session.lastHandledTouchY = y;

        //
        // Keep only a short tail of real touchscreen motion so finger-up
        // velocity can be used as the final fling decision.
        session.releaseTrail ??= [];

        session.releaseTrail.push({
            t: now,
            x,
            y,
        });

        while (session.releaseTrail.length > 16 ||
               (session.releaseTrail.length > 1 &&
                now - session.releaseTrail[0].t > 120_000)) {
            session.releaseTrail.shift();
        }

        if (!session.firstUpdateSeen) {
            session.firstUpdateSeen = true;

        }

        if (this._state === STATE_COMMITTED) {
            this._recordSample(
                session,
                x,
                y,
                now,
                'post-commit-update'
            );
            return true;
        }

        this._moveWindowWithTouch(session, x, y);

        this._recordSample(session, x, y, now, 'update');

        const motion = this._updateMotion(session, x, y, now);

        if (!motion)
            return true;

        this._recordMotionMetrics(session, motion);

        if (motion.kind === 'gap') {
            if (this._state === STATE_CANDIDATE)
                this._abortCandidate(session, now, 'sample-gap');

            return true;
        }

        const trigger = this._findTrigger(session, motion, now);

        if (this._state === STATE_DRAGGING) {
            if (trigger)
                this._startCandidate(session, motion, trigger, now);

            return true;
        }

        if (this._state !== STATE_CANDIDATE)
            return true;

        const committed = this._advanceCandidate(
            session,
            motion,
            trigger,
            now
        );

        return committed;
    }

    _moveWindowWithTouch(session, x, y) {
        const win = session.window;

        if (!win || win.is_hidden())
            return;


        //
        // Do not trust the frame geometry immediately after
        // unmaximize(). Mutter can clear the maximized state before
        // publishing the restored window dimensions.
        if (session.touchStartedMaximized === undefined) {
            session.touchStartedMaximized =
                win.is_maximized();
        }

        if (session.touchStartedMaximized &&
            !session.maximizedRestoreComplete) {

            const origin =
                session.samples?.[0] ?? null;

            if (!origin)
                return;

            const dragTravel =
                Math.hypot(
                    x - origin.x,
                    y - origin.y
                );

            /*
             * A tap should not restore the window.
             */
            if (dragTravel < 8)
                return;

            if (!session.maximizedRestoreRequested) {
                const maximizedRect =
                    win.get_frame_rect();

                session.maximizedRestoreRequested =
                    true;

                session.maximizedOriginalWidth =
                    maximizedRect.width;

                session.maximizedOriginalHeight =
                    maximizedRect.height;

                session.restoreWaitLogged =
                    false;

                win.unmaximize();


                return;
            }

            if (win.is_maximized())
                return;

            const restoredRect =
                win.get_frame_rect();

            /*
             * The crucial test:
             *
             * If Mutter still reports the exact maximized geometry,
             * it has NOT given us the real restored frame yet.
             */
            const geometryChanged =
                Math.abs(
                    restoredRect.width -
                    session.maximizedOriginalWidth
                ) > 8 ||
                Math.abs(
                    restoredRect.height -
                    session.maximizedOriginalHeight
                ) > 8;

            if (!geometryChanged) {
                if (!session.restoreWaitLogged) {
                    session.restoreWaitLogged = true;

                }

                return;
            }

            /*
             * We now have the REAL restored geometry.
             *
             * Put the center of that restored window directly
             * underneath the current finger.
             */
            session.dragOffsetX =
                restoredRect.width / 2;

            /*
             * Keep the finger in the title-bar region vertically.
             */
            session.dragOffsetY =
                Math.max(
                    0,
                    Math.min(
                        y - restoredRect.y,
                        Math.min(
                            48,
                            restoredRect.height
                        )
                    )
                );

            session.maximizedRestoreComplete =
                true;

            const targetX =
                Math.round(
                    x - session.dragOffsetX
                );

            const targetY =
                Math.round(
                    y - session.dragOffsetY
                );

            win.move_frame(
                true,
                targetX,
                targetY
            );


            return;
        }

        const frameX = Math.round(
            x - session.dragOffsetX
        );

        const frameY = Math.round(
            y - session.dragOffsetY
        );

        win.move_frame(
            true,
            frameX,
            frameY
        );
    }

    _handleTouchFinish(event, cancelled) {
        /*
         * Input safety comes first. Never leave a Clutter grab
         * alive while doing gesture cleanup.
         */
        this._releaseInputGrab();

        const session = this._session;
        const [x, y] = event.get_coords();
        const now = GLib.get_monotonic_time();

        // TOUCH_END is the only point allowed to execute a snap.
        session.touchReleased = true;


        //
        // Finger-up itself supplies the end/falloff of a flick.
        // If the recognizer was still in CANDIDATE when TOUCH_END
        // arrived, promote sufficiently strong motion instead of
        // throwing it away as "touch-ended".
        if (!cancelled &&
            !session.pendingCommit &&
            session.candidate) {
            const candidate = session.candidate;

            const totalWeight =
                candidate.totalWeight || 0;

            const vx = totalWeight > 0
                ? candidate.weightedVx / totalWeight
                : candidate.peakVx;

            const vy = totalWeight > 0
                ? candidate.weightedVy / totalWeight
                : candidate.peakVy;

            const action =
                this._classifyVector(vx, vy);

            const reversal =
                candidate.triggerReason === 'reversal' ||
                candidate.reversalSeen;

            /*
             * Reversals are extremely distinctive, so they can use
             * slightly lower release thresholds.
             *
             * Same-direction acceleration needs more evidence.
             */
            const reversalReady =
                reversal &&
                candidate.hits >= 3 &&
                candidate.travel >= 28 &&
                candidate.peakFastSpeed >= 1200 &&
                candidate.strongestImpulse >= 1000;

            const accelerationReady =
                !reversal &&
                candidate.hits >= 3 &&
                candidate.travel >= 38 &&
                candidate.peakFastSpeed >= 1450 &&
                candidate.strongestImpulse >= 850;

            if (action &&
                (reversalReady || accelerationReady)) {
                session.pendingCommit = {
                    action,
                    vx,
                    vy,
                    speed:
                        candidate.peakFastSpeed,
                    candidate,
                    detectedAtUs: now,
                };

            }
        }

        //
        // Finger-up velocity is authoritative. If a genuine fling reaches
        // TOUCH_END without an active/pending candidate, do not lose it
        // merely because the mid-drag state machine reset.
        if (!cancelled &&
            !session.pendingCommit &&
            session.releaseTrail?.length >= 2) {

            const trail = session.releaseTrail;
            const newest = trail[trail.length - 1];

            /*
             * Measure over roughly 35-80 ms rather than a single frame.
             * This is much less sensitive to touchscreen sample noise.
             */
            let anchor = null;

            for (let i = trail.length - 2; i >= 0; i--) {
                const ageUs =
                    newest.t - trail[i].t;

                if (ageUs >= 35_000) {
                    anchor = trail[i];
                    break;
                }
            }

            if (!anchor &&
                newest.t - trail[0].t >= 20_000) {
                anchor = trail[0];
            }

            if (anchor) {
                const dt =
                    (newest.t - anchor.t) /
                    1_000_000;

                const dx =
                    newest.x - anchor.x;

                const dy =
                    newest.y - anchor.y;

                const travel =
                    Math.hypot(dx, dy);

                const vx = dx / dt;
                const vy = dy / dt;

                const releaseSpeed =
                    Math.hypot(vx, vy);

                const action =
                    this._classifyVector(vx, vy);

                /*
                 * Because execution now only occurs at finger-up, this
                 * threshold can be considerably more forgiving than the
                 * old mid-drag snap threshold.
                 *
                 * 1500 px/s over >=45 px is a deliberate fling on this
                 * touchscreen while still rejecting ordinary release.
                 */
                const releaseReady =
                    session.throwArmed &&
                    action &&
                    releaseSpeed >= 1500 &&
                    travel >= 45;

                if (releaseReady) {
                    session.pendingCommit = {
                        action,
                        vx,
                        vy,
                        speed: releaseSpeed,
                        candidate: {
                            triggerReason:
                                'release-velocity',
                            travel,
                            hits: 1,
                            strongestImpulse:
                                releaseSpeed,
                            reversalSeen: false,
                        },
                        detectedAtUs: now,
                    };

                }
            }
        }

        //
        // Strong terminal motion gets the final directional vote.
        //
        // This makes quarter tiling much easier because an earlier
        // horizontal prediction cannot mask a diagonal finger release.
        if (!cancelled) {
            const terminal =
                this._getReleaseVector(session);

            if (terminal) {
                const terminalAction =
                    this._classifyVector(
                        terminal.vx,
                        terminal.vy
                    );

                const strongTerminalMotion =
                    terminalAction &&
                    terminal.speed >= 1350 &&
                    terminal.travel >= 35;

                if (strongTerminalMotion &&
                    session.pendingCommit) {

                    const oldAction =
                        session.pendingCommit.action;

                    session.pendingCommit.action =
                        terminalAction;

                    session.pendingCommit.vx =
                        terminal.vx;

                    session.pendingCommit.vy =
                        terminal.vy;

                    session.pendingCommit.speed =
                        Math.max(
                            session.pendingCommit.speed,
                            terminal.speed
                        );

                } else if (
                    strongTerminalMotion &&
                    !session.pendingCommit &&
                    (
                        session.throwArmed ||
                        terminal.speed >= 1700
                    )
                ) {
                    /*
                     * Also acts as a final fallback for a flick whose
                     * candidate was reset immediately before finger-up.
                     */
                    session.pendingCommit = {
                        action:
                            terminalAction,
                        vx:
                            terminal.vx,
                        vy:
                            terminal.vy,
                        speed:
                            terminal.speed,
                        candidate: {
                            triggerReason:
                                'release-velocity',
                            travel:
                                terminal.travel,
                            hits: 1,
                            strongestImpulse:
                                terminal.speed,
                            reversalSeen: false,
                        },
                        detectedAtUs: now,
                    };

                }
            }
        }

        if (cancelled) {
            session.pendingCommit = null;
        } else if (session.pendingCommit) {
            const pending = session.pendingCommit;
            session.pendingCommit = null;

            const pendingAgeUs =
                now - pending.detectedAtUs;

            if (pendingAgeUs <= 650_000) {

                this._commit(
                    session,
                    pending.action,
                    pending.vx,
                    pending.vy,
                    pending.speed,
                    pending.candidate,
                    now
                );
            }
        }


        this._recordSample(
            session,
            x,
            y,
            now,
            cancelled ? 'cancel' : 'end'
        );

        session.cancelled = cancelled;
        session.endedAtUs = now;
        session.durationMs =
            (now - session.startedAtUs) / 1000;

        if (this._state === STATE_CANDIDATE) {
            this._recordEvent(
                session,
                'candidate-abort',
                now,
                {
                    reason: cancelled
                        ? 'touch-cancelled'
                        : 'touch-ended',
                }
            );
        }

        if (!session.committedAction) {
            session.outcome = cancelled
                ? 'cancelled'
                : 'missed';
        }

        this._state = STATE_IDLE;
        this._session = null;

        if (!session.applyPending)
            this._finishSession(session);

        // Whoosh owned this touchscreen sequence from TOUCH_BEGIN.
        return true;
    }

    _releaseInputGrab() {
        if (!this._inputGrab)
            return;

        try {
            this._inputGrab.dismiss();
        } catch (error) {
            console.error(
                `Whoosh could not dismiss touchscreen grab: ${error}`
            );
        }

        this._inputGrab = null;
    }

    _eventBelongsToSession(_event) {
        /*
         * Only one touchscreen session is allowed at a time.
         *
         * ClutterEventSequence is an opaque native type. Comparing the
         * GJS wrapper objects with === is not a reliable way to determine
         * whether two events belong to the same native touch sequence.
         *
         * For now, once a valid title-bar TOUCH_BEGIN owns the controller,
         * all subsequent touch update/end events are routed to that active
         * session. A second TOUCH_BEGIN is already rejected while a session
         * exists.
         */
        return this._session !== null;
    }

    _newSession(win, sequence, x, y, now) {
        const rect = win.get_frame_rect();

        return {
            schema: 2,
            gestureId: ++this._gestureCounter,
            wallTime: new Date().toISOString(),
            startedAtUs: now,
            endedAtUs: null,

            sequence,
            window: win,

            initialRect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },

            motion: {
                lastX: x,
                lastY: y,
                lastT: now,

                fastVx: 0,
                fastVy: 0,
                slowVx: 0,
                slowVy: 0,

                fastReadySamples: 0,

                maxFastSpeed: 0,
                maxSlowSpeed: 0,
                maxImpulse: 0,
                minAlignment: 1,
                reversalSeen: false,
                gapCount: 0,
            },

            candidate: null,
            committedAction: null,
            triggerReason: null,

            applyPending: false,
            appliedAction: null,
            appliedAtUs: null,

            cancelled: false,
            finished: false,
            outcome: null,

            samples: [],
            events: [],
        };
    }

    _updateMotion(session, x, y, now) {
        const state = session.motion;
        const dtUs = now - state.lastT;

        if (dtUs <= 0)
            return null;

        const dtSeconds = dtUs / 1_000_000;
        const dtMs = dtUs / 1000;
        const dx = x - state.lastX;
        const dy = y - state.lastY;

        if (dtUs > GAP_US) {
            const broadVx = dx / dtSeconds;
            const broadVy = dy / dtSeconds;

            /*
             * Sparse touchscreen streams are normal. A long gap means we
             * cannot know the instantaneous velocity, but the displacement
             * across the gap is still useful evidence of the broad drag
             * direction. Update only the slow filter and re-arm the fast one.
             */
            const gapAlpha = Math.min(
                0.75,
                1 - Math.exp(-dtMs / 600)
            );

            state.slowVx +=
                gapAlpha * (broadVx - state.slowVx);
            state.slowVy +=
                gapAlpha * (broadVy - state.slowVy);

            state.fastVx = 0;
            state.fastVy = 0;
            state.fastReadySamples = 0;
            state.gapCount++;

            state.lastX = x;
            state.lastY = y;
            state.lastT = now;

            return {
                kind: 'gap',
                x,
                y,
                dx,
                dy,
                dtUs,
                broadVx,
                broadVy,
                fastSpeed: 0,
                slowSpeed: Math.hypot(
                    state.slowVx,
                    state.slowVy
                ),
                impulseSpeed: 0,
                alignment: 1,
                reversal: false,
            };
        }

        const rawVx = dx / dtSeconds;
        const rawVy = dy / dtSeconds;

        const fastAlpha =
            1 - Math.exp(-dtMs / FAST_TAU_MS);

        const slowAlpha =
            1 - Math.exp(-dtMs / SLOW_TAU_MS);

        state.fastVx +=
            fastAlpha * (rawVx - state.fastVx);
        state.fastVy +=
            fastAlpha * (rawVy - state.fastVy);

        state.slowVx +=
            slowAlpha * (rawVx - state.slowVx);
        state.slowVy +=
            slowAlpha * (rawVy - state.slowVy);

        state.fastReadySamples++;

        state.lastX = x;
        state.lastY = y;
        state.lastT = now;

        const fastSpeed = Math.hypot(
            state.fastVx,
            state.fastVy
        );

        const slowSpeed = Math.hypot(
            state.slowVx,
            state.slowVy
        );

        const impulseX =
            state.fastVx - state.slowVx;

        const impulseY =
            state.fastVy - state.slowVy;

        const impulseSpeed = Math.hypot(
            impulseX,
            impulseY
        );

        let alignment = 1;

        if (fastSpeed > 0 && slowSpeed > 0) {
            alignment =
                (
                    state.fastVx * state.slowVx +
                    state.fastVy * state.slowVy
                ) /
                (fastSpeed * slowSpeed);
        }

        const reversal =
            state.fastReadySamples >= 2 &&
            slowSpeed >= MIN_REVERSAL_SLOW_SPEED &&
            fastSpeed >= MIN_REVERSAL_FAST_SPEED &&
            alignment <= MIN_REVERSAL_ALIGNMENT;

        return {
            kind: 'sample',
            x,
            y,
            dx,
            dy,
            dtUs,
            rawVx,
            rawVy,

            vx: state.fastVx,
            vy: state.fastVy,
            fastSpeed,

            slowVx: state.slowVx,
            slowVy: state.slowVy,
            slowSpeed,

            impulseX,
            impulseY,
            impulseSpeed,

            alignment,
            reversal,
            fastReady:
                state.fastReadySamples >= 2,
        };
    }

    _findTrigger(session, motion, now) {
        if (!motion.fastReady)
            return null;

        const origin = session.samples[0] ?? null;

        const dragDistance = origin
            ? Math.hypot(
                motion.x - origin.x,
                motion.y - origin.y
            )
            : 0;

        const gestureAgeUs =
            now - session.startedAtUs;

        /*
         * Do not recognize a throw immediately after touch-down.
         *
         * Whoosh first waits for an established, reasonably steady drag.
         * A user can therefore grab the title bar and move quickly without
         * accidentally triggering a snap.
         */
        if (!session.throwArmed) {
            const stableDrag =
                gestureAgeUs >= THROW_ARM_MIN_US &&
                dragDistance >= THROW_ARM_MIN_TRAVEL;

            if (stableDrag) {
                session.throwArmed = true;

                this._recordEvent(
                    session,
                    'throw-armed',
                    now,
                    {
                        fastSpeed: motion.fastSpeed,
                        slowSpeed: motion.slowSpeed,
                        impulseSpeed: motion.impulseSpeed,
                        dragDistance,
                    }
                );
            }

            return null;
        }

        const reversal =
            motion.slowSpeed >= THROW_REVERSAL_MIN_SLOW &&
            motion.fastSpeed >= THROW_REVERSAL_MIN_FAST &&
            motion.alignment <=
                THROW_REVERSAL_MAX_ALIGNMENT;

        if (reversal)
            return 'reversal';

        /*
         * A genuine reversal can fire even during fast movement.
         * Same-direction acceleration cannot. Once a candidate has
         * demonstrated sustained fast dragging, require 100 ms of
         * genuinely calmer motion before acceleration throws become
         * eligible again.
         */
        if (session.accelerationLocked) {
            const calm =
                motion.fastSpeed <= THROW_REARM_MAX_FAST &&
                motion.impulseSpeed <= THROW_REARM_MAX_IMPULSE;

            if (!calm) {
                session.rearmCalmSinceUs = 0;
                return null;
            }

            if (!session.rearmCalmSinceUs) {
                session.rearmCalmSinceUs = now;
                return null;
            }

            if (now - session.rearmCalmSinceUs <
                THROW_REARM_SETTLE_US) {
                return null;
            }

            session.accelerationLocked = false;
            session.rearmCalmSinceUs = 0;
            session.throwArmed = true;

            this._recordEvent(
                session,
                'throw-rearmed',
                now,
                {
                    fastSpeed: motion.fastSpeed,
                    impulseSpeed: motion.impulseSpeed,
                }
            );
        }


        const acceleration =
            motion.fastSpeed >= THROW_ACCEL_MIN_FAST &&
            motion.impulseSpeed >= THROW_ACCEL_MIN_IMPULSE &&
            motion.fastSpeed >=
                Math.max(
                    THROW_ACCEL_MIN_RATIO *
                        motion.slowSpeed,
                    THROW_ACCEL_MIN_FAST
                );

        if (acceleration)
            return 'acceleration';

        return null;
    }

    _startCandidate(session, motion, reason, now) {
        const weight =
            Math.min(motion.fastSpeed, 4000);

        session.candidate = {
            startedAtUs: now,
            lastSeenAtUs: now,

            startX: motion.x,
            startY: motion.y,
            lastX: motion.x,
            lastY: motion.y,

            hits: 1,
            travel: 0,

            weightedVx: motion.vx * weight,
            weightedVy: motion.vy * weight,
            totalWeight: weight,

            strongestImpulse: motion.impulseSpeed,
            reversalSeen:
                reason === 'reversal' ||
                motion.reversal,
            triggerReason: reason,

            startFastSpeed: motion.fastSpeed,

            peakFastSpeed: motion.fastSpeed,
            peakAtUs: now,
            peakVx: motion.vx,
            peakVy: motion.vy,
        };

        session.triggerReason = reason;
        this._state = STATE_CANDIDATE;

        this._recordEvent(
            session,
            'candidate-start',
            now,
            {
                reason,
                fastSpeed: motion.fastSpeed,
                slowSpeed: motion.slowSpeed,
                impulseSpeed: motion.impulseSpeed,
                alignment: motion.alignment,
            }
        );
    }

    _advanceCandidate(session, motion, _trigger, now) {
        const candidate = session.candidate;

        if (!candidate)
            return false;

        const ageUs =
            now - candidate.startedAtUs;

        /*
         * Sustained high-speed movement is explicitly NOT a throw.
         *
         * If the candidate remains fast for too long without producing a
         * short peak-and-fall shape, abandon it and require another stable
         * drag before Whoosh can arm again.
         */
        if (ageUs > THROW_CANDIDATE_MAX_US) {
            session.throwArmed = false;
            session.accelerationLocked = true;
            session.rearmCalmSinceUs = 0;

            this._abortCandidate(
                session,
                now,
                'sustained-fast-drag'
            );

            return false;
        }

        const averageVx =
            candidate.weightedVx /
            candidate.totalWeight;

        const averageVy =
            candidate.weightedVy /
            candidate.totalWeight;

        const averageSpeed =
            Math.hypot(
                averageVx,
                averageVy
            );

        let directionAlignment = 1;

        if (averageSpeed > 0 &&
            motion.fastSpeed > 0) {
            directionAlignment =
                (
                    averageVx * motion.vx +
                    averageVy * motion.vy
                ) /
                (
                    averageSpeed *
                    motion.fastSpeed
                );
        }

        /*
         * A candidate should describe one coherent throw direction.
         * If it breaks direction, go back to ordinary dragging and require
         * another stable drag before re-arming.
         */
        if (directionAlignment < 0.10) {
            session.throwArmed = false;
            session.accelerationLocked = true;
            session.rearmCalmSinceUs = 0;

            this._abortCandidate(
                session,
                now,
                'direction-broke'
            );

            return false;
        }

        if (directionAlignment < 0.25)
            return false;

        const stepDistance =
            Math.hypot(
                motion.x - candidate.lastX,
                motion.y - candidate.lastY
            );

        candidate.travel += stepDistance;
        candidate.lastX = motion.x;
        candidate.lastY = motion.y;
        candidate.lastSeenAtUs = now;
        candidate.hits++;

        const weight =
            Math.min(motion.fastSpeed, 4000);

        candidate.weightedVx +=
            motion.vx * weight;

        candidate.weightedVy +=
            motion.vy * weight;

        candidate.totalWeight += weight;

        candidate.strongestImpulse =
            Math.max(
                candidate.strongestImpulse,
                motion.impulseSpeed
            );

        candidate.reversalSeen =
            candidate.reversalSeen ||
            motion.reversal;

        /*
         * Track the top of the velocity burst.
         */
        if (motion.fastSpeed >
            candidate.peakFastSpeed) {
            candidate.peakFastSpeed =
                motion.fastSpeed;

            candidate.peakAtUs = now;
            candidate.peakVx = motion.vx;
            candidate.peakVy = motion.vy;
        }

        const afterPeakUs =
            now - candidate.peakAtUs;

        /*
         * The decisive distinction:
         *
         * normal fast drag:
         *      speed ───────────────
         *
         * throw:
         *      speed     /\
         *               /  \__
         *
         * We do not commit until the fast velocity has fallen
         * substantially from its peak.
         */
        const peakFell =
            candidate.peakFastSpeed >=
                THROW_MIN_PEAK_SPEED &&
            afterPeakUs >=
                THROW_FALLOFF_MIN_US &&
            afterPeakUs <=
                THROW_FALLOFF_MAX_US &&
            motion.fastSpeed <=
                candidate.peakFastSpeed *
                THROW_FALLOFF_RATIO;

        const sharpBurst =
            candidate.peakFastSpeed >=
                candidate.startFastSpeed +
                THROW_MIN_PEAK_GAIN &&
            candidate.peakFastSpeed >=
                candidate.startFastSpeed *
                THROW_MIN_PEAK_RATIO;

        const enoughEvidence =
            candidate.hits >=
                THROW_MIN_HITS &&
            candidate.travel >=
                THROW_MIN_TRAVEL;

        const reversalConfirmed =
            candidate.triggerReason === 'reversal' &&
            enoughEvidence &&
            candidate.peakFastSpeed >=
                THROW_REVERSAL_MIN_FAST;

        if (!reversalConfirmed &&
            (!peakFell ||
             !sharpBurst ||
             !enoughEvidence)) {
            return false;
        }

        const finalAverageVx =
            candidate.weightedVx /
            candidate.totalWeight;

        const finalAverageVy =
            candidate.weightedVy /
            candidate.totalWeight;

        const action =
            this._classifyVector(
                finalAverageVx,
                finalAverageVy
            );

        if (!action) {
            session.throwArmed = false;

            this._abortCandidate(
                session,
                now,
                'downward-or-unclassified'
            );

            return false;
        }

        this._recordEvent(
            session,
            'throw-peak',
            now,
            {
                peakFastSpeed:
                    candidate.peakFastSpeed,
                currentFastSpeed:
                    motion.fastSpeed,
                falloffRatio:
                    motion.fastSpeed /
                    candidate.peakFastSpeed,
                afterPeakMs:
                    afterPeakUs / 1000,
            }
        );

        this._commit(
            session,
            action,
            finalAverageVx,
            finalAverageVy,
            candidate.peakFastSpeed,
            candidate,
            now
        );

        return true;
    }

    _abortCandidate(session, now, reason) {
        if (session.candidate) {
            this._recordEvent(
                session,
                'candidate-abort',
                now,
                {
                    reason,
                    hits: session.candidate.hits,
                    travel: session.candidate.travel,
                }
            );
        }

        session.candidate = null;
        this._state = STATE_DRAGGING;
    }

    _getReleaseVector(session) {
        const trail =
            session.releaseTrail;

        if (!trail ||
            trail.length < 2) {
            return null;
        }

        const newest =
            trail[trail.length - 1];

        let anchor = null;

        /*
         * Prefer roughly 35-80 ms of motion.
         * Long enough to suppress sample noise, short enough to
         * represent the user's actual final throw direction.
         */
        for (let i = trail.length - 2; i >= 0; i--) {
            const ageUs =
                newest.t - trail[i].t;

            if (ageUs >= 40_000) {
                anchor = trail[i];
                break;
            }
        }

        if (!anchor) {
            const oldest = trail[0];

            if (newest.t - oldest.t >= 20_000)
                anchor = oldest;
        }

        if (!anchor)
            return null;

        const dt =
            (newest.t - anchor.t) /
            1_000_000;

        if (dt <= 0)
            return null;

        const dx =
            newest.x - anchor.x;

        const dy =
            newest.y - anchor.y;

        const vx = dx / dt;
        const vy = dy / dt;

        return {
            vx,
            vy,
            speed:
                Math.hypot(vx, vy),
            travel:
                Math.hypot(dx, dy),
        };
    }

    _classifyVector(vx, vy) {
        const horizontal = Math.abs(vx);
        const vertical = Math.abs(vy);

        if (horizontal === 0 && vertical === 0)
            return null;

        if (vertical <= horizontal * STRAIGHT_RATIO)
            return vx < 0 ? 'left' : 'right';

        if (horizontal <= vertical * STRAIGHT_RATIO)
            return vy < 0 ? 'maximize' : null;

        const side = vx < 0 ? 'left' : 'right';
        const verticalSide = vy < 0 ? 'top' : 'bottom';

        return `${verticalSide}-${side}`;
    }

    _commit(
        session,
        action,
        vx,
        vy,
        speed,
        candidate,
        now
    ) {


        // Recognition is allowed while touching, execution is not.

        if (!session.touchReleased) {

            session.pendingCommit = {

                action,

                vx,

                vy,

                speed,

                candidate,

                detectedAtUs: now,

            };


            session.candidate = null;

            this._state = STATE_DRAGGING;


            return;

        }

        session.committedAction = action;
        session.candidate = null;
        this._state = STATE_COMMITTED;

        this._recordEvent(
            session,
            'commit',
            now,
            {
                action,
                reason: candidate.triggerReason,
                vx,
                vy,
                speed,
                travel: candidate.travel,
                hits: candidate.hits,
                strongestImpulse:
                    candidate.strongestImpulse,
                reversal:
                    candidate.reversalSeen,
            }
        );


        this._queueApply(session, action);
    }

    _queueApply(session, action) {
        session.applyPending = true;

        let sourceId = 0;

        sourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._applySources.delete(sourceId);

                let applied = false;

                try {
                    if (session.window &&
                        !session.window.is_hidden()) {
                        applied =
                            this._applyAction(
                                session.window,
                                action
                            ) === true;
                    }
                } catch (error) {
                    console.error(
                        `Whoosh touchscreen action failed: ${error}`
                    );
                }

                const now =
                    GLib.get_monotonic_time();

                session.applyPending = false;

                if (applied) {
                    session.appliedAction = action;
                    session.appliedAtUs = now;
                    session.outcome = 'applied';

                    this._recordEvent(
                        session,
                        'tile-applied',
                        now,
                        {action}
                    );
                } else {
                    session.outcome =
                        'commit-not-applied';

                    this._recordEvent(
                        session,
                        'tile-failed',
                        now,
                        {action}
                    );
                }


                if (session.endedAtUs)
                    this._finishSession(session);

                return GLib.SOURCE_REMOVE;
            }
        );

        this._applySources.add(sourceId);
    }

    _recordMotionMetrics(session, motion) {
        const metrics = session.motion;

        metrics.maxFastSpeed =
            Math.max(
                metrics.maxFastSpeed,
                motion.fastSpeed ?? 0
            );

        metrics.maxSlowSpeed =
            Math.max(
                metrics.maxSlowSpeed,
                motion.slowSpeed ?? 0
            );

        metrics.maxImpulse =
            Math.max(
                metrics.maxImpulse,
                motion.impulseSpeed ?? 0
            );

        if (motion.kind === 'sample') {
            metrics.minAlignment =
                Math.min(
                    metrics.minAlignment,
                    motion.alignment
                );

            metrics.reversalSeen =
                metrics.reversalSeen ||
                motion.reversal;
        }
    }

    _recordGrabEvent(type) {
        const session = this._session;

        if (!session)
            return;

        const now = GLib.get_monotonic_time();

        if (type === 'grab-begin')
            session.grabBeginSeen = true;
        else if (type === 'grab-end')
            session.grabEndSeen = true;

        this._recordEvent(
            session,
            type,
            now
        );
    }

    _recordSample(session, x, y, now, phase) {
        session.samples.push({
            dtMs:
                (now - session.startedAtUs) / 1000,
            x,
            y,
            phase,
        });
    }

    _recordEvent(session, type, now, data = {}) {
        session.events.push({
            dtMs:
                (now - session.startedAtUs) / 1000,
            type,
            ...data,
        });
    }

    _finishSession(session) {
        if (session.finished)
            return;

        session.finished = true;

        // Do not retain native objects after the gesture finishes.
        session.window = null;
        session.sequence = null;
    }

}

