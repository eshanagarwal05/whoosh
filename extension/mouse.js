// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';

const DIRECTION_DOMINANCE = 1.15;
const CORNER_THRESHOLD_RATIO = 0.85;
const DEBUG_PREFIX = 'Whoosh mouse debug';

const BUTTON_NUMBERS = {
    primary: [1],
    middle: [2],
    secondary: [3],
    back: [8, 11],
    forward: [9, 10],
};

export class MouseGestureController {
    constructor({
        getWindowAt,
        isTitlebar,
        applyAction,
        isEnabled,
        getButton,
        getThreshold,
        isCornerTilingEnabled,
    }) {
        this._getWindowAt = getWindowAt;
        this._isTitlebar = isTitlebar;
        this._applyAction = applyAction;
        this._isEnabled = isEnabled;
        this._getButton = getButton;
        this._getThreshold = getThreshold;
        this._isCornerTilingEnabled = isCornerTilingEnabled;

        this._capturedEventId = 0;
        this._inputGrab = null;
        this._session = null;
    }

    enable() {
        if (this._capturedEventId)
            return;

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_actor, event) => this._handleCapturedEvent(event)
        );

        this._debug(
            `enabled signal=${this._capturedEventId} ` +
            `active=${this._isEnabled()} button=${this._getButton()} ` +
            `threshold=${this._getThreshold()}`
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        this.reset();
    }

    reset() {
        this._session = null;
        this._releaseInputGrab();
    }

    _handleCapturedEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS)
            return this._handleButtonPress(event);

        if (!this._session)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION)
            return this._handleMotion(event);

        if (type === Clutter.EventType.BUTTON_RELEASE)
            return this._handleButtonRelease(event);

        return Clutter.EVENT_PROPAGATE;
    }

    _handleButtonPress(event) {
        const enabled = this._isEnabled();
        const configuredButton = this._getButton();
        const buttons = BUTTON_NUMBERS[configuredButton] ?? [2];
        const button = event.get_button();

        this._debug(
            `press actual=${button} configured=${configuredButton} ` +
            `accepted=${buttons.join(',')} enabled=${enabled} ` +
            `session=${Boolean(this._session)}`
        );

        if (this._session || !enabled)
            return Clutter.EVENT_PROPAGATE;

        if (!buttons.includes(button)) {
            this._debug('press rejected: button does not match setting');
            return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();
        const win = this._getWindowAt(x, y);
        const inTitlebar = Boolean(win && this._isTitlebar(win, x, y));

        if (win) {
            const rect = win.get_frame_rect();
            this._debug(
                `target found=true zone=${inTitlebar} pointer=${x},${y} ` +
                `frame=${rect.x},${rect.y},${rect.width},${rect.height}`
            );
        } else {
            this._debug(`target found=false pointer=${x},${y}`);
        }

        if (!win || !inTitlebar)
            return Clutter.EVENT_PROPAGATE;

        this._session = {
            button,
            window: win,
            startX: x,
            startY: y,
            maxTravel: 0,
            phase: 'pending',
            side: null,
            cornerOriginY: y,
        };

        this._inputGrab = global.stage.grab(global.stage);
        this._debug(`session started button=${button}`);

        // The selected button is reserved for Whoosh in the title-bar zone.
        return Clutter.EVENT_STOP;
    }

    _handleMotion(event) {
        const session = this._session;
        const [x, y] = event.get_coords();
        const dx = x - session.startX;
        const dy = y - session.startY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        const threshold = Math.max(1, this._getThreshold());

        session.maxTravel = Math.max(
            session.maxTravel,
            Math.hypot(dx, dy)
        );

        if (session.phase === 'pending') {
            if (absX >= threshold && absX >= absY * DIRECTION_DOMINANCE) {
                session.side = dx < 0 ? 'left' : 'right';
                session.phase = 'horizontal';
                session.cornerOriginY = y;
                this._debug(
                    `horizontal commit action=${session.side} dx=${dx} dy=${dy}`
                );
                this._apply(session, session.side);
            } else if (
                absY >= threshold &&
                absY >= absX * DIRECTION_DOMINANCE
            ) {
                session.phase = 'complete';
                this._debug(
                    `vertical commit action=${dy < 0 ? 'maximize' : 'minimize'} ` +
                    `dx=${dx} dy=${dy}`
                );
                this._apply(session, dy < 0 ? 'maximize' : 'minimize');
            }
        } else if (
            session.phase === 'horizontal' &&
            this._isCornerTilingEnabled()
        ) {
            const cornerDy = y - session.cornerOriginY;
            const cornerThreshold = threshold * CORNER_THRESHOLD_RATIO;

            if (Math.abs(cornerDy) >= cornerThreshold) {
                const vertical = cornerDy < 0 ? 'top' : 'bottom';
                session.phase = 'complete';
                this._debug(
                    `corner commit action=${vertical}-${session.side} ` +
                    `cornerDy=${cornerDy}`
                );
                this._apply(session, `${vertical}-${session.side}`);
            }
        }

        return Clutter.EVENT_STOP;
    }

    _handleButtonRelease(event) {
        const button = event.get_button();
        this._debug(
            `release actual=${button} expected=${this._session.button}`
        );

        if (button !== this._session.button)
            return Clutter.EVENT_PROPAGATE;

        this.reset();
        return Clutter.EVENT_STOP;
    }

    _apply(session, action) {
        const win = session.window;
        if (!win || win.is_hidden())
            return;

        try {
            const applied = this._applyAction(win, action);
            this._debug(`apply action=${action} result=${applied}`);
        } catch (error) {
            console.error(`Whoosh mouse action failed: ${error}`);
        }
    }

    _releaseInputGrab() {
        if (!this._inputGrab)
            return;

        try {
            this._inputGrab.dismiss();
        } catch (error) {
            console.error(`Whoosh could not dismiss mouse grab: ${error}`);
        }

        this._inputGrab = null;
    }

    _debug(message) {
        console.log(`${DEBUG_PREFIX}: ${message}`);
    }
}
