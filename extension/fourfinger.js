// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const TOUCH_COUNT = 4;
const PINCH_IN_SCALE = 0.72;
const PINCH_OUT_SCALE = 1.28;
const MIN_INITIAL_SPREAD = 24;
const SINGLE_TOUCH_STALE_MS = 500;
const MULTITOUCH_STALE_MS = 2000;

export class FourFingerTouchController {
    constructor({
        getWindowAt,
        applyAction,
        onMultitouchBegin = null,
        onMultitouchEnd = null,
    }) {
        this._getWindowAt = getWindowAt;
        this._applyAction = applyAction;
        this._onMultitouchBegin = onMultitouchBegin;
        this._onMultitouchEnd = onMultitouchEnd;

        this._capturedEventId = 0;
        this._points = new Map();
        this._gesture = null;
        this._multitouchActive = false;
        this._staleWatchdogSource = 0;
        this._applySources = new Set();
    }

    enable() {
        if (this._capturedEventId)
            return;

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_actor, event) => this._handleCapturedEvent(event)
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        for (const sourceId of this._applySources)
            GLib.source_remove(sourceId);

        this._applySources.clear();
        this._cancelStaleWatchdog();
        this._points.clear();
        this._gesture = null;
        this._endMultitouch();
    }

    _handleCapturedEvent(event) {
        const type = event.type();

        if (type !== Clutter.EventType.TOUCH_BEGIN &&
            type !== Clutter.EventType.TOUCH_UPDATE &&
            type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.TOUCH_CANCEL) {
            return Clutter.EVENT_PROPAGATE;
        }

        const key = this._sequenceKey(event);
        if (key === null)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._points.set(key, {x, y});
        } else if (this._points.has(key)) {
            this._points.set(key, {x, y});
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._multitouchActive && this._points.size >= 2) {
            this._multitouchActive = true;
            this._onMultitouchBegin?.();
        }

        if (this._points.size > TOUCH_COUNT && this._gesture)
            this._gesture.cancelled = true;

        if (!this._gesture && this._points.size === TOUCH_COUNT)
            this._beginGesture();

        if (this._gesture && this._points.size === TOUCH_COUNT)
            this._updateGesture();

        if (type === Clutter.EventType.TOUCH_CANCEL && this._gesture)
            this._gesture.cancelled = true;

        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            this._points.delete(key);
        }

        if (this._points.size === 0) {
            this._cancelStaleWatchdog();
            this._finishGesture();
            this._endMultitouch();
        } else {
            this._refreshStaleWatchdog();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _refreshStaleWatchdog() {
        this._cancelStaleWatchdog();

        const timeoutMs = this._multitouchActive
            ? MULTITOUCH_STALE_MS
            : SINGLE_TOUCH_STALE_MS;

        this._staleWatchdogSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            timeoutMs,
            () => {
                this._staleWatchdogSource = 0;

                if (this._points.size === 0)
                    return GLib.SOURCE_REMOVE;

                if (this._gesture)
                    this._gesture.cancelled = true;

                this._points.clear();
                this._finishGesture();
                this._endMultitouch();

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelStaleWatchdog() {
        if (!this._staleWatchdogSource)
            return;

        GLib.source_remove(this._staleWatchdogSource);
        this._staleWatchdogSource = 0;
    }

    _endMultitouch() {
        if (!this._multitouchActive)
            return;

        this._multitouchActive = false;
        this._onMultitouchEnd?.();
    }

    _sequenceKey(event) {
        const sequence = event.get_event_sequence();
        if (!sequence)
            return null;

        try {
            return sequence.get_slot();
        } catch (_) {
            return null;
        }
    }

    _geometry() {
        if (this._points.size !== TOUCH_COUNT)
            return null;

        const points = [...this._points.values()];
        let centerX = 0;
        let centerY = 0;

        for (const point of points) {
            centerX += point.x;
            centerY += point.y;
        }

        centerX /= points.length;
        centerY /= points.length;

        let spread = 0;
        for (const point of points) {
            spread += Math.hypot(
                point.x - centerX,
                point.y - centerY
            );
        }

        spread /= points.length;

        return {
            centerX,
            centerY,
            spread,
        };
    }

    _beginGesture() {
        const geometry = this._geometry();
        if (!geometry || geometry.spread < MIN_INITIAL_SPREAD)
            return;

        const win = this._getWindowAt(
            geometry.centerX,
            geometry.centerY
        );

        if (!win || win.is_hidden())
            return;

        this._gesture = {
            window: win,
            initialSpread: geometry.spread,
            minScale: 1,
            maxScale: 1,
            cancelled: false,
        };
    }

    _updateGesture() {
        const gesture = this._gesture;
        const geometry = this._geometry();

        if (!gesture || !geometry || gesture.initialSpread <= 0)
            return;

        const scale = geometry.spread / gesture.initialSpread;
        gesture.minScale = Math.min(gesture.minScale, scale);
        gesture.maxScale = Math.max(gesture.maxScale, scale);
    }

    _finishGesture() {
        const gesture = this._gesture;
        this._gesture = null;

        if (!gesture || gesture.cancelled)
            return;

        const pinchedIn = gesture.minScale <= PINCH_IN_SCALE;
        const pinchedOut = gesture.maxScale >= PINCH_OUT_SCALE;

        if (!pinchedIn && !pinchedOut)
            return;

        const inwardAmount = 1 - gesture.minScale;
        const outwardAmount = gesture.maxScale - 1;
        const action =
            pinchedIn && (!pinchedOut || inwardAmount >= outwardAmount)
                ? 'close'
                : 'fullscreen';
        const win = gesture.window;

        let sourceId = 0;
        sourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._applySources.delete(sourceId);

                try {
                    if (win && !win.is_hidden())
                        this._applyAction(win, action);
                } catch (error) {
                    console.error(
                        `Whoosh four-finger touchscreen action failed: ${error}`
                    );
                }

                return GLib.SOURCE_REMOVE;
            }
        );

        this._applySources.add(sourceId);
    }
}
