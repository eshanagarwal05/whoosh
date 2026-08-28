// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';

const DIRECTION_DOMINANCE = 1.15;
const CORNER_THRESHOLD_RATIO = 0.85;

const BUTTON_NUMBERS = {
    primary: 1,
    middle: 2,
    secondary: 3,
    back: 8,
    forward: 9,
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
        if (this._session || !this._isEnabled())
            return Clutter.EVENT_PROPAGATE;

        const button = BUTTON_NUMBERS[this._getButton()] ?? 2;
        if (event.get_button() !== button)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const win = this._getWindowAt(x, y);

        if (!win || !this._isTitlebar(win, x, y))
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
                this._apply(session, session.side);
            } else if (
                absY >= threshold &&
                absY >= absX * DIRECTION_DOMINANCE
            ) {
                session.phase = 'complete';
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
                this._apply(session, `${vertical}-${session.side}`);
            }
        }

        return Clutter.EVENT_STOP;
    }

    _handleButtonRelease(event) {
        if (event.get_button() !== this._session.button)
            return Clutter.EVENT_PROPAGATE;

        this.reset();
        return Clutter.EVENT_STOP;
    }

    _apply(session, action) {
        const win = session.window;
        if (!win || win.is_hidden())
            return;

        try {
            this._applyAction(win, action);
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
}
