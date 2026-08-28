// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const OPENLOGI_DEVICE_NAME = 'OpenLogi action injector';
const OPENLOGI_TITLEBAR_GRACE_US = 750_000;
const REPEAT_GUARD_US = 120_000;
const SMOOTH_SCROLL_THRESHOLD = 1;
const DIRECTION_DOMINANCE = 1.15;

export class MouseScrollController {
    constructor({
        getWindowAt,
        isTitlebar,
        applyAction,
        isEnabled,
        isCornerTilingEnabled,
        getCornerChainUs,
    }) {
        this._getWindowAt = getWindowAt;
        this._isTitlebar = isTitlebar;
        this._applyAction = applyAction;
        this._isEnabled = isEnabled;
        this._isCornerTilingEnabled = isCornerTilingEnabled;
        this._getCornerChainUs = getCornerChainUs;

        this._capturedEventId = 0;
        this.reset();
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

        this.reset();
    }

    reset() {
        this._recentTitlebarTarget = null;
        this._lastHorizontal = null;
        this._lastAction = null;
        this._smoothTarget = null;
        this._smoothX = 0;
        this._smoothY = 0;
    }

    _handleCapturedEvent(event) {
        if (!this._isEnabled())
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();

        if (type === Clutter.EventType.MOTION) {
            this._rememberTitlebarTarget(event);
            return Clutter.EVENT_PROPAGATE;
        }

        if (type !== Clutter.EventType.SCROLL || this._isTouchpadEvent(event))
            return Clutter.EVENT_PROPAGATE;

        const now = GLib.get_monotonic_time();
        const target = this._targetForScroll(event, now);

        if (!target) {
            this._smoothTarget = null;
            this._resetSmoothScroll();
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._smoothTarget !== target) {
            this._smoothTarget = target;
            this._smoothX = 0;
            this._smoothY = 0;
        }

        const direction = this._directionFromScroll(event);

        // Once a mouse scroll begins in Whoosh's title-bar zone, reserve the
        // complete event even while a smooth wheel is accumulating movement.
        if (!direction)
            return Clutter.EVENT_STOP;

        if (this._isRepeatedAction(target, direction, now))
            return Clutter.EVENT_STOP;

        const action = this._actionForDirection(target, direction, now);

        try {
            this._applyAction(target, action);
        } catch (error) {
            console.error(`Whoosh mouse scroll action failed: ${error}`);
        }

        this._lastAction = {window: target, direction, when: now};
        return Clutter.EVENT_STOP;
    }

    _rememberTitlebarTarget(event) {
        const [x, y] = event.get_coords();
        const win = this._getWindowAt(x, y);

        if (!win || !this._isTitlebar(win, x, y))
            return;

        this._recentTitlebarTarget = {
            window: win,
            when: GLib.get_monotonic_time(),
        };
    }

    _targetForScroll(event, now) {
        const [x, y] = event.get_coords();
        const win = this._getWindowAt(x, y);

        if (win && this._isTitlebar(win, x, y)) {
            this._recentTitlebarTarget = {window: win, when: now};
            return win;
        }

        if (!this._isOpenLogiEvent(event) || !this._recentTitlebarTarget)
            return null;

        const recent = this._recentTitlebarTarget;
        if (now - recent.when > OPENLOGI_TITLEBAR_GRACE_US ||
            !recent.window || recent.window.is_hidden()) {
            this._recentTitlebarTarget = null;
            return null;
        }

        return recent.window;
    }

    _isTouchpadEvent(event) {
        const source = event.get_scroll_source();
        const device = event.get_source_device();

        return source === Clutter.ScrollSource.FINGER ||
            device?.get_device_type() ===
                Clutter.InputDeviceType.TOUCHPAD_DEVICE;
    }

    _isOpenLogiEvent(event) {
        const name = event.get_source_device()?.get_device_name?.() ?? '';
        return name === OPENLOGI_DEVICE_NAME;
    }

    _directionFromScroll(event) {
        const direction = event.get_scroll_direction();

        switch (direction) {
        case Clutter.ScrollDirection.LEFT:
            this._resetSmoothScroll();
            return 'left';
        case Clutter.ScrollDirection.RIGHT:
            this._resetSmoothScroll();
            return 'right';
        case Clutter.ScrollDirection.UP:
            this._resetSmoothScroll();
            return 'up';
        case Clutter.ScrollDirection.DOWN:
            this._resetSmoothScroll();
            return 'down';
        case Clutter.ScrollDirection.SMOOTH:
            return this._directionFromSmoothScroll(event);
        default:
            return null;
        }
    }

    _directionFromSmoothScroll(event) {
        const [dx, dy] = event.get_scroll_delta();
        this._smoothX += dx;
        this._smoothY += dy;

        const absX = Math.abs(this._smoothX);
        const absY = Math.abs(this._smoothY);
        let direction = null;

        if (absX >= SMOOTH_SCROLL_THRESHOLD &&
            absX >= absY * DIRECTION_DOMINANCE) {
            direction = this._smoothX < 0 ? 'left' : 'right';
        } else if (absY >= SMOOTH_SCROLL_THRESHOLD &&
            absY >= absX * DIRECTION_DOMINANCE) {
            direction = this._smoothY < 0 ? 'up' : 'down';
        }

        if (direction) {
            this._smoothX = 0;
            this._smoothY = 0;
        }

        return direction;
    }

    _resetSmoothScroll() {
        this._smoothX = 0;
        this._smoothY = 0;
    }

    _isRepeatedAction(win, direction, now) {
        return this._lastAction?.window === win &&
            this._lastAction.direction === direction &&
            now - this._lastAction.when <= REPEAT_GUARD_US;
    }

    _actionForDirection(win, direction, now) {
        if (direction === 'left' || direction === 'right') {
            this._lastHorizontal = {
                window: win,
                side: direction,
                when: now,
            };
            return direction;
        }

        const horizontal = this._lastHorizontal;
        this._lastHorizontal = null;

        if (this._isCornerTilingEnabled() &&
            horizontal?.window === win &&
            now - horizontal.when <= this._getCornerChainUs()) {
            const vertical = direction === 'up' ? 'top' : 'bottom';
            return `${vertical}-${horizontal.side}`;
        }

        return direction === 'up' ? 'maximize' : 'minimize';
    }
}
