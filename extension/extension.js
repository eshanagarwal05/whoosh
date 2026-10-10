// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import WhooshCoreExtension from './extension-core.js';
import {FourFingerTouchController} from './fourfinger.js';
import {MouseScrollController} from './mouse.js';
import {WindowResizeController} from './resize.js';

const OBJECT_PATH = '/io/github/eshanagarwal05/Whoosh';
const INTERFACE_NAME = 'io.github.eshanagarwal05.Whoosh';
const MOUSE_BUS_NAME = 'io.github.eshanagarwal05.Whoosh.Mouse';
const CONFIG_HEARTBEAT_US = 1_000_000;
const MOUSE_CONFIG_HEARTBEAT_US = 1_000_000;
const MOUSE_SUPPRESSION_HEARTBEAT_US = 100_000;
const CORE_CORNER_CHAIN_US = 300_000;
const TILE_SETTLE_MS = 16;
const TILE_SETTLE_ATTEMPTS = 4;

export default class WhooshExtension extends WhooshCoreExtension {
    enable() {
        this._settings = this.getSettings();
        this._settingsSignalIds = [];
        this._backendConfigLastSignal = 0;
        this._mouseConfigLastSignal = 0;
        this._mouseSuppressionLastSignal = 0;
        this._mouseSuppressionArmed = null;
        this._mouseButtonSignalId = 0;
        this._singleTouchPausedForMultitouch = false;
        this._overviewShowingId = 0;
        this._overviewHiddenId = 0;
        this._overviewTouchscreenActive = Main.overview.visible;

        this._mouse = new MouseScrollController({
            getWindowAt: (x, y) => this._getWindowUnderPointer(x, y),
            isTitlebar: (win, x, y) =>
                this._isInMouseGestureZone(win, x, y),
            applyAction: (win, action) =>
                this._applyMouseAction(win, action),
            isEnabled: () =>
                this._mouseEnabled() || this._mouseButtonEnabled(),
            isScrollEnabled: () => this._mouseEnabled(),
            isCornerTilingEnabled: () => this._cornerTilingEnabled(),
            getCornerChainUs: () => this._cornerChainUs(),
        });
        this._mouse.enable();

        this._mouseButtonSignalId = Gio.DBus.system.signal_subscribe(
            MOUSE_BUS_NAME,
            INTERFACE_NAME,
            'MouseGesture',
            OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _objectPath, _interfaceName, _signalName, parameters) => {
                const [direction] = parameters.deep_unpack();
                if (this._mouseButtonEnabled() &&
                    /^(left|right|up|down)$/.test(direction)) {
                    this._mouse?.handleDirection(direction, true);
                }
            }
        );

        this._fourFingerTouch = new FourFingerTouchController({
            getWindowAt: (x, y) => this._getWindowUnderPointer(x, y),
            canCloseAt: (win, x, y) => this._isInGestureZone(win, x, y),
            applyAction: (win, action) =>
                this._applyFourFingerTouchAction(win, action),
            onMultitouchBegin: () => this._pauseSingleTouchController(),
            onMultitouchEnd: () => this._resumeSingleTouchController(),
        });
        try {
            super.enable();
            this._windowResize = new WindowResizeController(win => {
                this._cancelResizeGuard(win);
                const actor = win.get_compositor_private();
                if (actor)
                    this._finishTileAnimation(actor);
                this._prepareForResize(win, actor);
            });
            this._windowResize.enable();
            this._overviewShowingId = Main.overview.connect(
                'showing',
                () => this._onTouchscreenOverviewShowing()
            );
            this._overviewHiddenId = Main.overview.connect(
                'hidden',
                () => this._onTouchscreenOverviewHidden()
            );
            this._resetFourFingerTouchState();
            this._connectSettings();
            this._sendBackendConfiguration(true);
            this._sendMouseConfiguration(true);
        } catch (error) {
            this._windowResize?.disable();
            this._windowResize = null;
            this._disconnectTouchscreenOverviewSignals();
            if (this._mouseButtonSignalId) {
                Gio.DBus.system.signal_unsubscribe(
                    this._mouseButtonSignalId
                );
                this._mouseButtonSignalId = 0;
            }
            this._mouse.disable();
            this._mouse = null;
            this._fourFingerTouch.disable();
            this._fourFingerTouch = null;
            this._disconnectSettings();
            this._settings = null;
            throw error;
        }
    }

    disable() {
        for (const id of this._cornerSettleSources?.values() ?? [])
            GLib.source_remove(id);
        this._cornerSettleSources?.clear();
        this._clearSwipePreview();
        this._windowResize?.disable();
        this._windowResize = null;
        this._sendMouseSuppressionState(false);
        this._sendMouseConfiguration(true, false);
        this._disconnectSettings();
        this._disconnectTouchscreenOverviewSignals();

        if (this._mouseButtonSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._mouseButtonSignalId);
            this._mouseButtonSignalId = 0;
        }

        this._fourFingerTouch?.disable();
        this._fourFingerTouch = null;
        this._mouse?.disable();
        this._mouse = null;
        this._singleTouchPausedForMultitouch = false;

        super.disable();

        this._backendConfigLastSignal = 0;
        this._mouseConfigLastSignal = 0;
        this._mouseSuppressionLastSignal = 0;
        this._mouseSuppressionArmed = null;
        this._settings = null;
    }

    _connectSettings() {
        const connect = (key, callback) => {
            this._settingsSignalIds.push(
                this._settings.connect(`changed::${key}`, callback)
            );
        };

        connect('touchpad-enabled', () => this._onTouchpadSettingsChanged());
        connect('mouse-enabled', () => this._resetMouseState());
        connect('mouse-button-enabled', () => {
            this._resetMouseState();
            this._sendMouseConfiguration(true);
            this._updateMouseButtonState();
        });
        connect('mouse-button', () => {
            this._resetMouseState();
            this._sendMouseConfiguration(true);
        });
        connect('mouse-sensitivity', () => {
            this._resetMouseState();
            this._sendMouseConfiguration(true);
        });
        connect('touchscreen-enabled', () => this._resetTouchscreenState());
        connect(
            'four-finger-touchscreen-enabled',
            () => this._resetFourFingerTouchState()
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
        connect('corner-timing', () => {
            this._lastHorizontal = null;
            this._sendBackendConfiguration(true);
        });
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

    _mouseEnabled() {
        return this._settings?.get_boolean('mouse-enabled') ?? false;
    }

    _mouseButtonEnabled() {
        return this._settings?.get_boolean('mouse-button-enabled') ?? false;
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

    _cornerChainUs() {
        switch (this._settings?.get_string('corner-timing')) {
        case 'short':
            return 200_000;
        case 'long':
            return 450_000;
        default:
            return CORE_CORNER_CHAIN_US;
        }
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
        this._clearSwipePreview();
        this._cancelTabTargets();
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

    _resetTouchscreenState() {
        if (!this._touchscreen)
            return;

        const pausedForMultitouch = this._singleTouchPausedForMultitouch;

        this._touchscreen.disable();

        if (!pausedForMultitouch && !this._overviewTouchscreenActive)
            this._touchscreen.enable();
    }

    _resetMouseState() {
        this._mouse?.reset();
    }

    _resetFourFingerTouchState() {
        if (!this._fourFingerTouch)
            return;

        const singleTouchWasPaused = this._singleTouchPausedForMultitouch;

        this._fourFingerTouch.disable();
        this._singleTouchPausedForMultitouch = false;

        if (singleTouchWasPaused && this._touchscreen) {
            this._touchscreen.disable();
            if (!this._overviewTouchscreenActive)
                this._touchscreen.enable();
        }

        if (this._fourFingerTouchscreenEnabled() &&
            !this._overviewTouchscreenActive) {
            this._fourFingerTouch.enable();
        }
    }

    _onTouchscreenOverviewShowing() {
        // GNOME may take ownership of a native three-finger swipe without
        // delivering its final touch events to the four-finger recognizer.
        this._overviewTouchscreenActive = true;
        this._fourFingerTouch?.disable();
        this._touchscreen?.disable();
        this._singleTouchPausedForMultitouch = false;
    }

    _onTouchscreenOverviewHidden() {
        this._overviewTouchscreenActive = false;
        this._touchscreen?.disable();
        this._touchscreen?.enable();
        this._resetFourFingerTouchState();
    }

    _disconnectTouchscreenOverviewSignals() {
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }

        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }
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

    _sendMouseConfiguration(force = false, enabledOverride = null) {
        if (!this._settings)
            return;

        const now = GLib.get_monotonic_time();
        if (!force &&
            now - this._mouseConfigLastSignal <
                MOUSE_CONFIG_HEARTBEAT_US) {
            return;
        }

        const enabled = enabledOverride ?? this._mouseButtonEnabled();
        const button = this._settings.get_string('mouse-button');
        const sensitivity = this._settings.get_string('mouse-sensitivity');

        try {
            Gio.DBus.system.emit_signal(
                null,
                OBJECT_PATH,
                INTERFACE_NAME,
                'MouseConfiguration',
                new GLib.Variant(
                    '(bss)',
                    [enabled, button, sensitivity]
                )
            );
            this._mouseConfigLastSignal = now;
        } catch (error) {
            console.error(`Whoosh mouse configuration failed: ${error}`);
        }
    }

    _sendMouseSuppressionState(armed) {
        try {
            Gio.DBus.system.emit_signal(
                null,
                OBJECT_PATH,
                INTERFACE_NAME,
                'MouseSuppression',
                new GLib.Variant('(b)', [armed])
            );
        } catch (error) {
            console.error(`Whoosh mouse suppression failed: ${error}`);
        }
    }

    _updateMouseButtonState() {
        const enabled = this._mouseButtonEnabled();
        let armed = false;

        if (enabled) {
            const [px, py] = global.get_pointer();
            const win = this._getWindowUnderPointer(px, py);
            armed = Boolean(
                win && this._isInMouseGestureZone(win, px, py)
            );
        }

        const now = GLib.get_monotonic_time();
        const stateChanged = armed !== this._mouseSuppressionArmed;
        const heartbeatDue =
            armed &&
            now - this._mouseSuppressionLastSignal >=
                MOUSE_SUPPRESSION_HEARTBEAT_US;

        if (stateChanged || heartbeatDue) {
            this._sendMouseSuppressionState(armed);
            this._mouseSuppressionLastSignal = now;
        }

        this._mouseSuppressionArmed = armed;

        if (enabled)
            this._sendMouseConfiguration(false);
    }

    _updateSuppressionState() {
        let result = GLib.SOURCE_CONTINUE;

        if (!this._touchpadEnabled()) {
            if (this._suppressionArmed !== false)
                this._sendSuppressionState(false);

            this._suppressionArmed = false;
        } else {
            result = super._updateSuppressionState();

            if (this._suppressionArmed)
                this._sendBackendConfiguration(false);
        }

        this._updateMouseButtonState();
        return result;
    }

    _handleAction(action) {
        const mouseScroll =
            /^(mouse|openlogi)_scroll_(left|right|up|down)$/.exec(action);

        if (mouseScroll) {
            const [, source, direction] = mouseScroll;
            if (this._mouseEnabled()) {
                this._mouse?.handleDirection(
                    direction,
                    source === 'openlogi',
                    true
                );
            }
            return;
        }

        if (!this._touchpadEnabled())
            return;

        if (action === 'gesture_claim_begin')
            this._clearSwipePreview();

        if (action === 'gesture_claim_end') {
            const pending = this._swipePreview;
            this._clearSwipePreview();
            super._handleAction(action);
            if (pending && pending.window && !pending.window.is_hidden()) {
                this._scrollTarget = pending.window;
                this._lastHorizontal = null;
                if (pending.rect) {
                    const {x, y, width, height} = pending.rect;
                    if (pending.window.minimized)
                        pending.window.unminimize();
                    this._moveResizeAnimated(pending.window, x, y, width, height);
                    this._activate(pending.window, global.display.get_current_time());
                    if (this._scrollOverviewTarget === pending.window)
                        Main.overview.hide();
                } else {
                    super._handleAction(pending.action);
                }
                this._lastHorizontal = null;
            }
            return;
        }

        if (this._gestureClaimActive && this._scrollTarget &&
            /^(left|right|up|down)$/.test(action)) {
            this._updateSwipePreview(action);
            return;
        }

        if (/^(left|right|up|down)$/.test(action)) {
            const [, , modifiers] = global.get_pointer();
            if ((modifiers & Clutter.ModifierType.SHIFT_MASK) !== 0)
                action = `shift_${action}`;
        }

        if (!this._cornerTilingEnabled() && action.startsWith('corner_'))
            return;

        if (action === 'pinch_in' && this._gestureClaimActive) {
            this._gestureClaimActive = false;

            try {
                super._handleAction(action);
            } finally {
                this._gestureClaimActive = true;
            }

            return;
        }

        if (this._cornerTilingEnabled() &&
            (action === 'up' || action === 'down') &&
            this._lastHorizontal) {
            const now = GLib.get_monotonic_time();
            const elapsed = now - this._lastHorizontal.when;
            const limit = this._cornerChainUs();

            if (elapsed > limit) {
                this._lastHorizontal = null;
            } else if (limit > CORE_CORNER_CHAIN_US &&
                elapsed > CORE_CORNER_CHAIN_US &&
                !this._scrollAppTarget) {
                const {win, side} = this._lastHorizontal;

                if (win && !win.is_hidden()) {
                    const vertical = action === 'up' ? 'top' : 'bottom';
                    this._tileCorner(win, side, vertical);
                    this._activate(
                        win,
                        global.display.get_current_time()
                    );
                    this._lastHorizontal = null;
                    return;
                }
            }
        }

        super._handleAction(action);

        if (!this._cornerTilingEnabled() &&
            (action === 'left' || action === 'right')) {
            this._lastHorizontal = null;
        }
    }

    _clearSwipePreview() {
        this._swipePreviewActor?.destroy();
        this._swipePreviewActor = null;
        this._swipePreview = null;
    }

    _updateSwipePreview(direction) {
        const win = this._scrollTarget;
        if (!win || win.is_hidden()) {
            this._clearSwipePreview();
            return;
        }
        const previous = this._swipePreview;
        let side = previous?.side ?? null;
        let vertical = previous?.vertical ?? null;
        if (direction === 'left' || direction === 'right')
            side = direction;
        else
            vertical = direction;
        if (!this._cornerTilingEnabled()) {
            if (direction === 'left' || direction === 'right') vertical = null;
            else side = null;
        }
        const [, , modifiers] = global.get_pointer();
        const shift = (modifiers & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const horizontal = direction === 'left' || direction === 'right';
        // Shift uses a spatial thirds grid, never a wrapping size cycle.
        // Reverse through: left third, left two-thirds, center third,
        // right two-thirds, right third. Motion beyond an edge stays there.
        let column = previous?.shift ? previous.column : null;
        if (shift && horizontal) {
            const step = direction === 'left' ? -1 : 1;
            column = column === null || column === undefined
                ? step * 2 : Math.max(-2, Math.min(2, column + step));
        }
        const action = side && vertical
            ? `corner_${side}_${vertical}` : side ?? vertical;
        const area = win.get_work_area_current_monitor();
        let {x, y, width, height} = area;
        if (side) {
            if (shift) {
                column ??= side === 'left' ? -2 : 2;
                const ranges = [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3]];
                const [start, end] = ranges[column + 2];
                x = area.x + Math.round(area.width * start / 3);
                width = Math.round(area.width * end / 3) - (x - area.x);
            } else {
                width = Math.round(area.width / 2);
                x = side === 'right' ? area.x + area.width - width : area.x;
            }
        }
        if ((side && vertical) || (shift && vertical)) {
            height = Math.round(area.height / 2);
            y = vertical === 'down' ? area.y + area.height - height : area.y;
        }
        ({x, y, width, height} = this._constrainTileRect(win, {x, y, width, height}));
        this._swipePreview = {
            window: win, side, vertical, action, shift, column,
            rect: shift || side ? {x, y, width, height} : null,
        };
        if (!this._swipePreviewActor) {
            this._swipePreviewActor = new St.Widget({
                reactive: false,
                style: 'background-color: rgba(80, 150, 255, 0.25); border: 2px solid rgba(100, 170, 255, 0.9); border-radius: 12px;',
            });
            Main.layoutManager.addChrome(this._swipePreviewActor);
        }
        this._swipePreviewActor.set_position(x, y);
        this._swipePreviewActor.set_size(width, height);
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

    _isInGestureZone(win, px, py) {
        if (Main.overview.visible && !this._overviewEnabled())
            return false;

        if (!this._dashEnabled() &&
            super._getDashAppUnderPointer(px, py)) {
            return false;
        }

        return super._isInGestureZone(win, px, py);
    }

    _isInTouchGestureZone(win, px, py) {
        if (!this._touchscreenEnabled())
            return false;

        return super._isInTouchGestureZone(win, px, py);
    }

    _isInMouseGestureZone(win, px, py) {
        return super._isInGestureZone(win, px, py);
    }

    _applyTouchAction(win, action) {
        if (!this._touchscreenEnabled())
            return false;

        if (!this._cornerTilingEnabled() &&
            (action === 'top-left' ||
             action === 'top-right' ||
             action === 'bottom-left' ||
             action === 'bottom-right')) {
            return false;
        }

        return super._applyTouchAction(win, action);
    }

    _applyMouseAction(win, action) {
        if (!this._mouseEnabled() || !win || win.is_hidden())
            return false;

        if (!this._cornerTilingEnabled() &&
            (action === 'top-left' ||
             action === 'top-right' ||
             action === 'bottom-left' ||
             action === 'bottom-right')) {
            return false;
        }

        switch (action) {
        case 'left':
            this._tileHalf(win, 'left');
            break;
        case 'right':
            this._tileHalf(win, 'right');
            break;
        case 'maximize':
            this._maximize(win);
            break;
        case 'minimize':
            this._minimize(win);
            return true;
        case 'top-left':
            this._tileCorner(win, 'left', 'top');
            break;
        case 'top-right':
            this._tileCorner(win, 'right', 'top');
            break;
        case 'bottom-left':
            this._tileCorner(win, 'left', 'bottom');
            break;
        case 'bottom-right':
            this._tileCorner(win, 'right', 'bottom');
            break;
        default:
            return false;
        }

        this._activate(win, global.display.get_current_time());
        return true;
    }

    _pauseSingleTouchController() {
        if (!this._fourFingerTouchscreenEnabled() ||
            this._overviewTouchscreenActive ||
            this._singleTouchPausedForMultitouch ||
            !this._touchscreen) {
            return;
        }

        this._touchscreen.disable();
        this._singleTouchPausedForMultitouch = true;
    }

    _resumeSingleTouchController() {
        if (!this._singleTouchPausedForMultitouch || !this._touchscreen)
            return;

        this._touchscreen.disable();
        if (!this._overviewTouchscreenActive)
            this._touchscreen.enable();
        this._singleTouchPausedForMultitouch = false;
    }

    _applyFourFingerTouchAction(win, action) {
        if (!this._fourFingerTouchscreenEnabled() ||
            !win ||
            win.is_hidden()) {
            return false;
        }

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

    _moveResizeDirect(win, actor, x, y, width, height) {
        super._moveResizeDirect(win, actor, x, y, width, height);
        const area = win.get_work_area_current_monitor();
        const right = Math.abs(x + width - area.x - area.width) <= 2;
        const bottom = Math.abs(y + height - area.y - area.height) <= 2;
        this._cornerSettleSources ??= new Map();
        const old = this._cornerSettleSources.get(win);
        if (old) GLib.source_remove(old);
        let attempts = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            try {
                const actual = win.get_frame_rect();
                const targetX = right
                    ? Math.max(area.x, area.x + area.width - actual.width) : x;
                const targetY = bottom
                    ? Math.max(area.y, area.y + area.height - actual.height) : y;
                if (Math.abs(actual.width - width) > 2 ||
                    Math.abs(actual.height - height) > 2) {
                    // The application accepted a different size. Stop asking
                    // for an impossible rectangle and anchor the real frame.
                    this._cancelResizeGuard(win);
                    if (actual.x !== targetX || actual.y !== targetY)
                        win.move_frame(true, targetX, targetY);
                }
            } catch (_) {
                attempts = 4;
            }
            if (++attempts >= 4) {
                this._cornerSettleSources.delete(win);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._cornerSettleSources.set(win, id);
    }

    _constrainTileRect(win, desired) {
        const area = win.get_work_area_current_monitor();
        const current = win.get_frame_rect?.() ?? desired;
        let minWidth = 1, minHeight = 1;
        let maxWidth = Infinity, maxHeight = Infinity;
        for (const [method, minimum] of [['get_min_size', true], ['get_max_size', false]]) {
            try {
                const [known, w, h] = win[method]();
                if (!known) continue;
                const frame = win.client_rect_to_frame_rect
                    ? win.client_rect_to_frame_rect(new Mtk.Rectangle({x: 0, y: 0, width: w, height: h}))
                    : {width: w, height: h};
                if (minimum) {
                    if (w > 0) minWidth = frame.width;
                    if (h > 0) minHeight = frame.height;
                } else {
                    if (w > 0) maxWidth = frame.width;
                    if (h > 0) maxHeight = frame.height;
                }
            } catch (_) {
            }
        }
        // Dialogs and other fixed-size windows can still be positioned.
        if (win.allows_resize?.() === false) {
            minWidth = maxWidth = current.width;
            minHeight = maxHeight = current.height;
        }
        const width = Math.max(minWidth, Math.min(desired.width, maxWidth));
        const height = Math.max(minHeight, Math.min(desired.height, maxHeight));
        const anchor = (pos, size, start, span, nextSize) => {
            let result = pos;
            if (Math.abs(pos + size - start - span) <= 2)
                result = start + span - nextSize;
            else if (Math.abs(pos + size / 2 - start - span / 2) <= 2)
                result = start + Math.round((span - nextSize) / 2);
            // If the minimum exceeds the monitor, keep the title bar reachable.
            return Math.max(start, Math.min(result, start + Math.max(0, span - nextSize)));
        };
        return {
            x: anchor(desired.x, desired.width, area.x, area.width, width),
            y: anchor(desired.y, desired.height, area.y, area.height, height),
            width, height,
        };
    }

    _moveResizeAnimated(win, x, y, width, height) {
        ({x, y, width, height} = this._constrainTileRect(win, {x, y, width, height}));
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

