// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import WhooshCoreExtension from './extension-core.js';
import {FourFingerTouchController} from './fourfinger.js';

const OBJECT_PATH = '/io/github/eshanagarwal05/Whoosh';
const INTERFACE_NAME = 'io.github.eshanagarwal05.Whoosh';
const CONFIG_HEARTBEAT_US = 1_000_000;
const TILE_SETTLE_MS = 16;
const TILE_SETTLE_ATTEMPTS = 4;

export default class WhooshExtension extends WhooshCoreExtension {
    enable() {
        this._settings = this.getSettings();
        this._settingsSignalIds = [];
        this._backendConfigLastSignal = 0;
        this._fourFingerTouch = null;
        this._singleTouchPausedForMultitouch = false;

        if (this._fourFingerTouchscreenEnabled())
            this._createFourFingerController();

        try {
            super.enable();
            this._syncTouchscreenController();
            this._connectSettings();
            this._sendBackendConfiguration(true);
        } catch (error) {
            this._fourFingerTouch?.disable();
            this._fourFingerTouch = null;
            this._disconnectSettings();
            this._settings = null;
            throw error;
        }
    }

    disable() {
        this._disconnectSettings();

        this._fourFingerTouch?.disable();
        this._fourFingerTouch = null;
        this._singleTouchPausedForMultitouch = false;

        super.disable();

        this._backendConfigLastSignal = 0;
        this._settings = null;
    }

    _connectSettings() {
        const connect = (key, callback) => {
            this._settingsSignalIds.push(
                this._settings.connect(`changed::${key}`, callback)
            );
        };

        connect('touchpad-enabled', () => this._onTouchpadSettingsChanged());
        connect('touchscreen-enabled', () => this._syncTouchscreenController());
        connect(
            'four-finger-touchscreen-enabled',
            () => this._syncFourFingerController()
        );
        connect('overview-enabled', () => this._onTouchpadTargetsChanged());
        connect('dash-enabled', () => this._onTouchpadTargetsChanged());
        connect('corner-tiling-enabled', () => {
            if (!this._cornerTilingEnabled())
                this._lastHorizontal = null;
        });
        connect(
            'touchpad-sensitivity',
            () => this._sendBackendConfiguration(true)
        );
        connect(
            'corner-timing',
            () => this._sendBackendConfiguration(true)
        );
    }

    _disconnectSettings() {
        if (!this._settings || !this._settingsSignalIds)
            return;

        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);

        this._settingsSignalIds = [];
    }

    _touchpadEnabled() {
        return this._settings?.get_boolean('touchpad-enabled') ?? true;
    }

    _touchscreenEnabled() {
        return this._settings?.get_boolean('touchscreen-enabled') ?? true;
    }

    _fourFingerTouchscreenEnabled() {
        return this._settings?.get_boolean(
            'four-finger-touchscreen-enabled'
        ) ?? true;
    }

    _overviewEnabled() {
        return this._settings?.get_boolean('overview-enabled') ?? true;
    }

    _dashEnabled() {
        return this._settings?.get_boolean('dash-enabled') ?? true;
    }

    _cornerTilingEnabled() {
        return this._settings?.get_boolean('corner-tiling-enabled') ?? true;
    }

    _animationsEnabled() {
        return this._settings?.get_boolean('animations-enabled') ?? true;
    }

    _animationDuration() {
        switch (this._settings?.get_string('animation-speed')) {
        case 'fast':
            return 150;
        case 'relaxed':
            return 350;
        default:
            return 250;
        }
    }

    _onTouchpadSettingsChanged() {
        this._resetTouchpadTargets();

        if (!this._touchpadEnabled()) {
            this._sendSuppressionState(false);
            this._suppressionArmed = false;
            return;
        }

        this._sendBackendConfiguration(true);
        this._updateSuppressionState();
    }

    _onTouchpadTargetsChanged() {
        this._resetTouchpadTargets();
        this._updateSuppressionState();
    }

    _resetTouchpadTargets() {
        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._scrollOverviewTarget = null;
        this._pinchTarget = null;
        this._pinchOverviewTarget = null;
        this._scrollAppTarget = null;
        this._pinchAppTarget = null;
        this._gestureClaimActive = false;
        this._cancelPendingClose?.();
    }

    _sendBackendConfiguration(force = false) {
        if (!this._settings)
            return;

        const now = GLib.get_monotonic_time();
        if (!force &&
            now - this._backendConfigLastSignal < CONFIG_HEARTBEAT_US) {
            return;
        }

        const sensitivity = this._settings.get_string(
            'touchpad-sensitivity'
        );
        const cornerTiming = this._settings.get_string('corner-timing');

        try {
            Gio.DBus.system.emit_signal(
                null,
                OBJECT_PATH,
                INTERFACE_NAME,
                'Configuration',
                new GLib.Variant('(ss)', [sensitivity, cornerTiming])
            );
            this._backendConfigLastSignal = now;
        } catch (error) {
            console.error(`Whoosh configuration signal failed: ${error}`);
        }
    }

    _updateSuppressionState() {
        if (!this._touchpadEnabled()) {
            if (this._suppressionArmed !== false)
                this._sendSuppressionState(false);

            this._suppressionArmed = false;
            return GLib.SOURCE_CONTINUE;
        }

        const result = super._updateSuppressionState();

        if (this._suppressionArmed)
            this._sendBackendConfiguration(false);

        return result;
    }

    _handleAction(action) {
        if (!this._touchpadEnabled())
            return;

        if (!this._cornerTilingEnabled() && action.startsWith('corner_'))
            return;

        super._handleAction(action);

        if (!this._cornerTilingEnabled() &&
            (action === 'left' || action === 'right')) {
            this._lastHorizontal = null;
        }
    }

    _getOverviewWindowUnderPointer(px, py) {
        if (!this._touchpadEnabled() || !this._overviewEnabled())
            return null;

        return super._getOverviewWindowUnderPointer(px, py);
    }

    _getDashAppUnderPointer(px, py) {
        if (!this._touchpadEnabled() || !this._dashEnabled())
            return null;

        return super._getDashAppUnderPointer(px, py);
    }

    _blockOverviewTouchpadScroll(event) {
        if (!this._touchpadEnabled() || !this._overviewEnabled())
            return Clutter.EVENT_PROPAGATE;

        return super._blockOverviewTouchpadScroll(event);
    }

    _applyTouchAction(win, action) {
        if (!this._cornerTilingEnabled() &&
            (action === 'top-left' ||
             action === 'top-right' ||
             action === 'bottom-left' ||
             action === 'bottom-right')) {
            return false;
        }

        return super._applyTouchAction(win, action);
    }

    _createFourFingerController() {
        if (this._fourFingerTouch)
            return;

        this._fourFingerTouch = new FourFingerTouchController({
            getWindowAt: (x, y) => this._getWindowUnderPointer(x, y),
            applyAction: (win, action) =>
                this._applyFourFingerTouchAction(win, action),
            onMultitouchBegin: () => this._pauseSingleTouchController(),
            onMultitouchEnd: () => this._resumeSingleTouchController(),
        });
        this._fourFingerTouch.enable();
    }

    _syncFourFingerController() {
        if (this._fourFingerTouchscreenEnabled()) {
            this._createFourFingerController();
            return;
        }

        this._fourFingerTouch?.disable();
        this._fourFingerTouch = null;
        this._singleTouchPausedForMultitouch = false;
    }

    _syncTouchscreenController() {
        if (!this._touchscreen)
            return;

        if (this._touchscreenEnabled() &&
            !this._singleTouchPausedForMultitouch) {
            this._touchscreen.enable();
        } else {
            this._touchscreen.disable();
        }
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

        if (this._touchscreenEnabled())
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

    _moveResizeAnimated(win, x, y, width, height) {
        const actor = win.get_compositor_private();

        if (!this._animationsEnabled()) {
            this._moveResizeDirect(win, actor, x, y, width, height);
            return;
        }

        const oldRect = win.get_frame_rect();

        if (!actor ||
            oldRect.width <= 0 ||
            oldRect.height <= 0) {
            this._moveResizeDirect(win, actor, x, y, width, height);
            return;
        }

        this._finishTileAnimation(actor);

        let clone = null;
        const originalOpacity = actor.opacity;

        try {
            const content = actor.paint_to_content(oldRect);
            if (!content) {
                this._moveResizeDirect(win, actor, x, y, width, height);
                return;
            }

            clone = new St.Widget({content});
            clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            clone.set_pivot_point(0, 0);
            clone.set_position(oldRect.x, oldRect.y);
            clone.set_size(oldRect.width, oldRect.height);
            Main.uiGroup.add_child(clone);

            actor.opacity = 0;
            this._tileAnimations.set(actor, {
                clone,
                originalOpacity,
                settleId: 0,
            });
        } catch (error) {
            if (clone)
                clone.destroy();
            actor.opacity = originalOpacity;
            console.error(`Whoosh tile snapshot failed: ${error}`);
            this._moveResizeDirect(win, actor, x, y, width, height);
            return;
        }

        try {
            this._moveResizeDirect(win, actor, x, y, width, height);
        } catch (error) {
            console.error(`Whoosh tile resize failed: ${error}`);
            this._finishTileAnimation(actor);
            return;
        }

        let attempts = 0;
        const state = this._tileAnimations.get(actor);
        state.settleId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TILE_SETTLE_MS,
            () => {
                const current = this._tileAnimations.get(actor);
                if (!current || current.clone !== clone)
                    return GLib.SOURCE_REMOVE;

                const targetRect = win.get_frame_rect();
                const reachedTarget =
                    Math.abs(targetRect.x - x) <= 2 &&
                    Math.abs(targetRect.y - y) <= 2 &&
                    Math.abs(targetRect.width - width) <= 2 &&
                    Math.abs(targetRect.height - height) <= 2;

                if (!reachedTarget && attempts++ < TILE_SETTLE_ATTEMPTS)
                    return GLib.SOURCE_CONTINUE;

                current.settleId = 0;

                if (!reachedTarget ||
                    targetRect.width <= 0 ||
                    targetRect.height <= 0 ||
                    !actor.is_mapped()) {
                    this._finishTileAnimation(actor);
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    const scaleX = targetRect.width / oldRect.width;
                    const scaleY = targetRect.height / oldRect.height;
                    const duration = this._animationDuration();

                    actor.remove_all_transitions();
                    actor.set_pivot_point(0, 0);
                    actor.translation_x = oldRect.x - targetRect.x;
                    actor.translation_y = oldRect.y - targetRect.y;
                    actor.scale_x = 1 / scaleX;
                    actor.scale_y = 1 / scaleY;
                    actor.opacity = originalOpacity;

                    clone.ease({
                        x: targetRect.x,
                        y: targetRect.y,
                        scale_x: scaleX,
                        scale_y: scaleY,
                        opacity: 0,
                        duration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });

                    actor.ease({
                        scale_x: 1,
                        scale_y: 1,
                        translation_x: 0,
                        translation_y: 0,
                        duration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._finishTileAnimation(actor),
                    });
                } catch (error) {
                    console.error(`Whoosh tile animation failed: ${error}`);
                    this._finishTileAnimation(actor);
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }
}
