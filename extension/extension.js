// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import WhooshCoreExtension from './extension-core.js';
import {FourFingerTouchController} from './fourfinger.js';

export default class WhooshExtension extends WhooshCoreExtension {
    enable() {
        this._fourFingerTouch = new FourFingerTouchController({
            getWindowAt: (x, y) => this._getWindowUnderPointer(x, y),
            applyAction: (win, action) =>
                this._applyFourFingerTouchAction(win, action),
            onMultitouchBegin: () => this._pauseSingleTouchController(),
            onMultitouchEnd: () => this._resumeSingleTouchController(),
        });
        this._fourFingerTouch.enable();

        try {
            super.enable();
        } catch (error) {
            this._fourFingerTouch.disable();
            this._fourFingerTouch = null;
            throw error;
        }
    }

    disable() {
        this._fourFingerTouch?.disable();
        this._fourFingerTouch = null;
        this._singleTouchPausedForMultitouch = false;

        super.disable();
    }

    _pauseSingleTouchController() {
        if (this._singleTouchPausedForMultitouch || !this._touchscreen)
            return;

        this._touchscreen.disable();
        this._singleTouchPausedForMultitouch = true;
    }

    _resumeSingleTouchController() {
        if (!this._singleTouchPausedForMultitouch || !this._touchscreen)
            return;

        this._touchscreen.enable();
        this._singleTouchPausedForMultitouch = false;
    }

    _applyFourFingerTouchAction(win, action) {
        if (!win || win.is_hidden())
            return false;

        const time = global.display.get_current_time();

        if (action === 'close') {
            this._close(win, time);
            return true;
        }

        if (action === 'fullscreen') {
            this._fullscreen(win);
            this._activate(win, time);
            return true;
        }

        return false;
    }
}
