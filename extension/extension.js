// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal
//

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TouchscreenThrowController} from './touchscreen.js';

const TITLEBAR_HEIGHT = 56;
const CORNER_CHAIN_US = 300_000;
const TILE_ANIMATION_MS = 250;
const TILE_SETTLE_MS = 16;
const TILE_SETTLE_ATTEMPTS = 4;
const TILE_STATE_GUARD_MS = 600;
const TILE_STATE_GUARD_INTERVAL_MS = 16;
const SUPPRESSION_POLL_MS = 30;
const SUPPRESSION_HEARTBEAT_US = 100_000;
const CLOSE_RELEASE_SETTLE_MS = 50;

const BUS_NAME = 'io.github.eshanagarwal05.Whoosh';
const OBJECT_PATH = '/io/github/eshanagarwal05/Whoosh';
const INTERFACE_NAME = 'io.github.eshanagarwal05.Whoosh';

export default class WhooshExtension extends Extension {
    enable() {
        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._scrollOverviewTarget = null;
        this._pinchTarget = null;
        this._scrollAppTarget = null;
        this._pinchAppTarget = null;
        this._gestureClaimActive = false;
        this._pendingClose = null;
        this._pendingCloseTimeoutId = 0;

        this._tileAnimations = new Map();
        this._resizeGuards = new Map();
        this._pendingAppLaunches = new Set();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._lastFocusedApp = null;
        this._lastFocusedWindow = null;
        this._focusWindowSignalId = global.display.connect(
            'notify::focus-window',
            () => this._rememberFocusedApp()
        );
        this._rememberFocusedApp();
        this._suppressionArmed = null;
        this._suppressionLastSignal = 0;
        this._suppressionPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SUPPRESSION_POLL_MS,
            () => this._updateSuppressionState()
        );
        this._updateSuppressionState();

        this._overviewScrollBlockId = global.stage.connect(
            'captured-event',
            (_actor, event) => this._blockOverviewTouchpadScroll(event)
        );

        this._touchscreen = new TouchscreenThrowController({
            getWindowAt: (x, y) =>
                this._getWindowUnderPointer(x, y),

            isTitlebar: (win, x, y) =>
                this._isInTouchGestureZone(win, x, y),

            applyAction: (win, action) =>
                this._applyTouchAction(win, action),
        });
        this._touchscreen.enable();

        this._dbusSignalId = Gio.DBus.system.signal_subscribe(
            BUS_NAME,
            INTERFACE_NAME,
            'Gesture',
            OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _objectPath, _interfaceName, _signalName, parameters) => {
                const [action] = parameters.deep_unpack();
                this._handleAction(action);
            }
        );
    }

    disable() {
        this._touchscreen?.disable();
        this._touchscreen = null;

        if (this._overviewScrollBlockId) {
            global.stage.disconnect(this._overviewScrollBlockId);
            this._overviewScrollBlockId = 0;
        }

        this._cancelPendingClose();
        this._gestureClaimActive = false;

        if (this._suppressionPollId) {
            GLib.source_remove(this._suppressionPollId);
            this._suppressionPollId = 0;
        }

        this._sendSuppressionState(false);
        this._suppressionArmed = false;
        this._suppressionLastSignal = 0;

        if (this._dbusSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSignalId);
            this._dbusSignalId = 0;
        }

        if (this._focusWindowSignalId) {
            global.display.disconnect(this._focusWindowSignalId);
            this._focusWindowSignalId = 0;
        }

        for (const cancel of [...this._pendingAppLaunches])
            cancel();

        for (const win of [...this._resizeGuards.keys()])
            this._cancelResizeGuard(win);

        for (const actor of [...this._tileAnimations.keys()])
            this._finishTileAnimation(actor);

        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._scrollOverviewTarget = null;
        this._pinchTarget = null;
        this._scrollAppTarget = null;
        this._pinchAppTarget = null;
        this._lastFocusedApp = null;
        this._lastFocusedWindow = null;
        this._windowTracker = null;
        this._pendingAppLaunches.clear();
        this._tileAnimations.clear();
        this._resizeGuards.clear();
    }

    _handleAction(action) {
        const now = GLib.get_monotonic_time();
        const time = global.display.get_current_time();

        if (action === 'gesture_claim_begin') {
            this._cancelPendingClose();
            this._gestureClaimActive = true;
            return;
        }

        if (action === 'gesture_claim_end') {
            this._gestureClaimActive = false;
            this._commitPendingClose();
            return;
        }

        if (action === 'scroll_begin') {
            const [px, py] = global.get_pointer();
            const overviewWin = this._getOverviewWindowUnderPointer(px, py);

            this._scrollOverviewTarget = overviewWin;

            if (overviewWin) {
                this._scrollAppTarget = null;
                this._scrollTarget = overviewWin;
                return;
            }

            const app = this._getDashAppUnderPointer(px, py);

            this._scrollAppTarget = app;

            if (app) {
                this._scrollTarget = null;
                return;
            }

            const win = this._getWindowUnderPointer(px, py);
            this._scrollTarget =
                win && this._isInGestureZone(win, px, py) ? win : null;
            return;
        }

        if (action === 'pinch_begin') {
            const [px, py] = global.get_pointer();
            const app = this._getDashAppUnderPointer(px, py);

            this._pinchAppTarget = app;

            if (app) {
                this._pinchTarget = null;
                return;
            }

            const win = this._getWindowUnderPointer(px, py);
            this._pinchTarget =
                win && this._isInGestureZone(win, px, py) ? win : null;
            return;
        }

        if (action === 'pinch_in' || action === 'pinch_out') {
            const app = this._pinchAppTarget;
            this._pinchAppTarget = null;
            this._lastHorizontal = null;

            if (app) {
                if (action === 'pinch_in')
                    this._quitDashApp(app);
                else
                    this._openDashAppInNewWorkspace(app, time);

                return;
            }

            const win = this._pinchTarget;
            this._pinchTarget = null;

            if (!win || win.is_hidden())
                return;

            if (action === 'pinch_in') {
                if (this._gestureClaimActive)
                    this._queueClose(win);
                else
                    this._close(win, time);
            } else {
                this._fullscreen(win);
                this._activate(win, time);
            }

            return;
        }

        if (this._scrollAppTarget) {
            const app = this._scrollAppTarget;
            this._lastHorizontal = null;

            if (action === 'up')
                this._maximizeDashApp(app, time);
            else if (action === 'down')
                this._minimizeDashApp(app);

            // Keep the target until the next scroll_begin so any corner
            // follow-up from the same physical gesture is consumed here too.
            return;
        }

        if (action.startsWith('corner_') &&
            this._handleExplicitCorner(action, now, time)) {
            return;
        }

        if ((action === 'up' || action === 'down') &&
            this._lastHorizontal &&
            now - this._lastHorizontal.when <= CORNER_CHAIN_US) {
            const {win, side} = this._lastHorizontal;

            if (win && !win.is_hidden()) {
                const vertical = action === 'up' ? 'top' : 'bottom';
                this._tileCorner(win, side, vertical);
                this._activate(win, time);
                this._lastHorizontal = null;
                return;
            }
        }

        const [px, py] = global.get_pointer();
        const win = this._scrollTarget ?? this._getWindowUnderPointer(px, py);
        const fromOverview = this._scrollOverviewTarget === win;

        if (!win || (win.is_hidden() && !fromOverview)) {
            this._clearExpiredHorizontal(now);
            return;
        }

        if (!this._scrollTarget && !this._isInGestureZone(win, px, py)) {
            this._clearExpiredHorizontal(now);
            return;
        }

        if (fromOverview && win.minimized && action !== 'down')
            win.unminimize();

        switch (action) {
        case 'left':
            this._tileHalf(win, 'left');
            this._activate(win, time);
            this._lastHorizontal = {win, side: 'left', when: now};
            if (fromOverview)
                Main.overview.hide();
            break;
        case 'right':
            this._tileHalf(win, 'right');
            this._activate(win, time);
            this._lastHorizontal = {win, side: 'right', when: now};
            if (fromOverview)
                Main.overview.hide();
            break;
        case 'up':
            this._maximize(win);
            this._activate(win, time);
            this._lastHorizontal = null;
            if (fromOverview)
                Main.overview.hide();
            break;
        case 'down':
            this._minimize(win);
            this._lastHorizontal = null;
            if (fromOverview)
                Main.overview.hide();
            break;
        default:
            this._clearExpiredHorizontal(now);
            break;
        }
    }

    _handleExplicitCorner(action, now, time) {
        const match = /^corner_(left|right)_(up|down)$/.exec(action);
        if (!match)
            return false;

        const [, side, verticalAction] = match;
        const vertical = verticalAction === 'up' ? 'top' : 'bottom';

        if (this._lastHorizontal &&
            this._lastHorizontal.side === side &&
            now - this._lastHorizontal.when <= CORNER_CHAIN_US) {
            const win = this._lastHorizontal.win;

            if (win && !win.is_hidden()) {
                this._tileCorner(win, side, vertical);
                this._activate(win, time);
                this._lastHorizontal = null;
                return true;
            }
        }

        const [px, py] = global.get_pointer();
        const win = this._scrollTarget ?? this._getWindowUnderPointer(px, py);

        if (win &&
            !win.is_hidden() &&
            (this._scrollTarget || this._isInGestureZone(win, px, py))) {
            this._tileCorner(win, side, vertical);
            this._activate(win, time);
            this._lastHorizontal = null;
            return true;
        }

        return false;
    }

    _clearExpiredHorizontal(now) {
        if (this._lastHorizontal &&
            now - this._lastHorizontal.when > CORNER_CHAIN_US) {
            this._lastHorizontal = null;
        }
    }

    _blockOverviewTouchpadScroll(event) {
        if (!Main.overview.visible ||
            event.type() !== Clutter.EventType.SCROLL) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const source = event.get_scroll_source();
        const device = event.get_source_device();

        const isTouchpad =
            source === Clutter.ScrollSource.FINGER ||
            device?.get_device_type() ===
                Clutter.InputDeviceType.TOUCHPAD_DEVICE;

        return isTouchpad
            ? Clutter.EVENT_STOP
            : Clutter.EVENT_PROPAGATE;
    }

    _getOverviewWindowUnderPointer(px, py) {
        if (!Main.overview.visible)
            return null;

        let actor = global.stage.get_actor_at_pos(
            Clutter.PickMode.ALL,
            px,
            py
        );

        while (actor) {
            const win =
                actor._delegate?.metaWindow ??
                actor.metaWindow ??
                null;

            if (win && typeof win.get_frame_rect === 'function')
                return win;

            actor = actor.get_parent();
        }

        /*
         * Pick results in Overview are not always descendants of the
         * WindowPreview actor. Fall back to walking the Overview tree
         * and compare the pointer against each preview's stage geometry.
         */
        const stack = [
            Main.layoutManager.overviewGroup,
        ];

        while (stack.length > 0) {
            const current = stack.pop();

            if (!current)
                continue;

            const win =
                current.metaWindow ??
                current._delegate?.metaWindow ??
                null;

            if (win && typeof win.get_frame_rect === 'function') {
                try {
                    const [x, y] =
                        current.get_transformed_position();
                    const [width, height] =
                        current.get_transformed_size();

                    if (width > 0 &&
                        height > 0 &&
                        px >= x &&
                        px < x + width &&
                        py >= y &&
                        py < y + height) {
                        return win;
                    }
                } catch (_) {
                }
            }

            const children = current.get_children?.() ?? [];

            for (const child of children)
                stack.push(child);
        }

        return null;
    }

    _getWindowUnderPointer(px, py) {
        const windows = global.display.list_all_windows();
        const stacked = global.display.sort_windows_by_stacking(windows);
        const activeWorkspace = global.workspace_manager.get_active_workspace();

        for (let i = stacked.length - 1; i >= 0; i--) {
            const win = stacked[i];

            if (win.is_override_redirect() ||
                win.is_hidden() ||
                !win.showing_on_its_workspace() ||
                !win.located_on_workspace(activeWorkspace)) {
                continue;
            }

            const rect = win.get_frame_rect();

            if (px >= rect.x &&
                px < rect.x + rect.width &&
                py >= rect.y &&
                py < rect.y + rect.height) {
                return win;
            }
        }

        return null;
    }

    _isInGestureZone(win, px, py) {
        const rect = win.get_frame_rect();

        return px >= rect.x &&
            px < rect.x + rect.width &&
            py >= rect.y &&
            py < rect.y + Math.min(TITLEBAR_HEIGHT, rect.height);
    }

    _isInTouchGestureZone(win, px, py) {
        const rect = win.get_frame_rect();
        const touchHeight = Math.min(48, rect.height);

        //
        // Keep the ends of the title bar native so touchscreen taps
        // can reach minimize / maximize / close buttons.
        //
        // Whoosh owns the large center section for drag/flick gestures.
        const decorationReserve =
            Math.min(
                180,
                Math.max(
                    110,
                    rect.width * 0.15
                )
            );

        const relativeX =
            px - rect.x;

        const insideHorizontalGestureZone =
            relativeX >= decorationReserve &&
            relativeX <
                rect.width - decorationReserve;

        const insideTitlebar =
            py >= rect.y &&
            py < rect.y + touchHeight;

        return insideHorizontalGestureZone &&
            insideTitlebar;
    }

    _applyTouchAction(win, action) {
        if (!win || win.is_hidden())
            return false;

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

        this._activate(
            win,
            global.display.get_current_time()
        );

        return true;
    }

    _getDashAppUnderPointer(px, py) {
        let actor = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE,
            px,
            py
        );

        if (!actor)
            return null;

        let app = null;
        let isDash = false;

        while (actor) {
            if (!app) {
                const candidate =
                    actor.app ??
                    actor._delegate?.app ??
                    null;

                if (candidate &&
                    typeof candidate.get_windows === 'function') {
                    app = candidate;
                }
            }

            const name =
                actor.get_name?.() ??
                actor.name ??
                '';

            if (name === 'dash' ||
                name === 'dashtodockContainer' ||
                name === 'dashtodockDashContainer' ||
                name === 'dashtodockDashScrollview' ||
                name === 'dashtodockBoxContainer') {
                isDash = true;
            }

            if (app && isDash)
                return app;

            actor = actor.get_parent();
        }

        return null;
    }

    _rememberFocusedApp() {
        const win = global.display.get_focus_window();
        if (!win || !this._windowTracker)
            return;

        const app = this._windowTracker.get_window_app(win);
        if (app) {
            this._lastFocusedApp = app;
            this._lastFocusedWindow = win;
        }
    }

    _sameApp(first, second) {
        if (!first || !second)
            return false;

        return first === second || first.get_id() === second.get_id();
    }

    _getAppWindowsByRecency(app) {
        return app.get_windows()
            .filter(win => !win.is_skip_taskbar())
            .sort((first, second) => {
                const firstTime = first.get_user_time();
                const secondTime = second.get_user_time();

                if (firstTime === secondTime) {
                    return second.get_stable_sequence() -
                        first.get_stable_sequence();
                }

                return global.display.xserver_time_is_before(
                    firstTime,
                    secondTime
                ) ? 1 : -1;
            });
    }

    _watchForNewAppWindow(app, existing, callback) {
        let signalId = 0;
        let timeoutId = 0;
        let done = false;

        const cancel = () => {
            if (done)
                return;

            done = true;

            if (signalId) {
                app.disconnect(signalId);
                signalId = 0;
            }

            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }

            this._pendingAppLaunches?.delete(cancel);
        };

        const check = () => {
            if (done)
                return;

            const win = app.get_windows().find(candidate =>
                !existing.has(candidate) &&
                !candidate.is_skip_taskbar()
            );

            if (!win)
                return;

            cancel();
            callback(win);
        };

        signalId = app.connect('windows-changed', check);
        timeoutId = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT,
            5000,
            () => {
                timeoutId = 0;
                cancel();
            }
        );

        this._pendingAppLaunches.add(cancel);
        return cancel;
    }

    _openNewAppWindow(app, workspaceIndex, callback) {
        if (!app.can_open_new_window())
            return false;

        const existing = new Set(app.get_windows());
        const cancel = this._watchForNewAppWindow(
            app,
            existing,
            callback
        );

        try {
            app.open_new_window(workspaceIndex);
            return true;
        } catch (error) {
            cancel();
            console.error(
                `Whoosh could not open a new ${app.get_name()} window: ${error}`
            );
            return false;
        }
    }

    _maximizeDashApp(app, time) {
        const windows = this._getAppWindowsByRecency(app);
        const rememberedFocused =
            this._sameApp(app, this._lastFocusedApp) &&
            windows.includes(this._lastFocusedWindow)
                ? this._lastFocusedWindow
                : null;
        const focused = windows.find(win =>
            win.has_focus() && win.can_maximize()
        ) ?? (
            rememberedFocused?.can_maximize()
                ? rememberedFocused
                : null
        );
        const nonFocused = windows.find(win =>
            win !== focused &&
            !win.minimized &&
            win.can_maximize()
        );
        const minimized = windows.find(win =>
            win.minimized && win.can_maximize()
        );
        const win = focused ?? nonFocused ?? minimized;

        if (win) {
            if (win.minimized)
                win.unminimize();

            this._maximize(win);
            Main.overview.hide();
            this._activate(win, time);
            return;
        }

        const opened = this._openNewAppWindow(app, -1, newWin => {
            if (newWin.minimized)
                newWin.unminimize();

            this._maximize(newWin);
            Main.overview.hide();
            this._activate(
                newWin,
                global.display.get_current_time()
            );
        });

        if (!opened) {
            console.warn(
                `Whoosh: ${app.get_name()} cannot open another window`
            );
        }
    }

    _minimizeDashApp(app) {
        for (const win of this._getAppWindowsByRecency(app))
            this._minimize(win);
    }

    _quitDashApp(app) {
        this._rememberFocusedApp();

        if (this._sameApp(app, this._lastFocusedApp)) {
            app.request_quit();
            return;
        }

        const killedPids = new Set();
        let killed = false;

        for (const win of this._getAppWindowsByRecency(app)) {
            const pid = win.get_pid();

            if (pid > 0 && killedPids.has(pid))
                continue;

            try {
                win.kill();
                killed = true;

                if (pid > 0)
                    killedPids.add(pid);
            } catch (error) {
                console.error(
                    `Whoosh could not force quit ${app.get_name()}: ${error}`
                );
            }
        }

        if (!killed)
            app.request_quit();
    }

    _openDashAppInNewWorkspace(app, time) {
        if (!app.can_open_new_window()) {
            console.warn(
                `Whoosh: ${app.get_name()} cannot open another window`
            );
            return;
        }

        const workspace =
            global.workspace_manager.append_new_workspace(true, time);

        const opened = this._openNewAppWindow(
            app,
            workspace.index(),
            win => {
                if (!win.located_on_workspace(workspace))
                    win.change_workspace(workspace);

                if (win.minimized)
                    win.unminimize();

                this._activate(
                    win,
                    global.display.get_current_time()
                );
            }
        );

        if (opened) {
            Main.overview.hide();
        } else {
            console.warn(
                `Whoosh: failed to open ${app.get_name()} on the new workspace`
            );
        }
    }

    _isChromeWindow(win) {
        const sandboxedAppId =
            win.get_sandboxed_app_id()?.toLowerCase() ?? '';
        const wmClass =
            win.get_wm_class()?.toLowerCase() ?? '';
        const wmInstance =
            win.get_wm_class_instance()?.toLowerCase() ?? '';

        return sandboxedAppId === 'com.google.chrome' ||
            wmClass === 'google-chrome' ||
            wmClass.startsWith('google-chrome-') ||
            wmInstance === 'google-chrome' ||
            wmInstance.startsWith('google-chrome-');
    }

    _sendSuppressionState(armed) {
        try {
            Gio.DBus.system.emit_signal(
                null,
                OBJECT_PATH,
                INTERFACE_NAME,
                'Suppression',
                new GLib.Variant('(b)', [armed])
            );
        } catch (error) {
            console.error(`Whoosh suppression signal failed: ${error}`);
        }
    }

    _updateSuppressionState() {
        const [px, py] = global.get_pointer();
        const overviewWin = this._getOverviewWindowUnderPointer(px, py);
        const win = this._getWindowUnderPointer(px, py);
        const dashApp = this._getDashAppUnderPointer(px, py);
        const armed = Boolean(
            overviewWin ||
            dashApp ||
            (
                win &&
                this._isInGestureZone(win, px, py)
            )
        );

        const now = GLib.get_monotonic_time();
        const stateChanged = armed !== this._suppressionArmed;
        const heartbeatDue =
            armed &&
            now - this._suppressionLastSignal >=
                SUPPRESSION_HEARTBEAT_US;

        if (stateChanged || heartbeatDue) {
            this._sendSuppressionState(armed);
            this._suppressionLastSignal = now;
        }

        this._suppressionArmed = armed;
        return GLib.SOURCE_CONTINUE;
    }

    _activate(win, time) {
        if (!win.has_focus())
            win.activate(time);
    }

    _prepareForResize(win, actor = null) {
        if (win.is_fullscreen()) {
            if (actor)
                Main.wm.skipNextEffect(actor);
            win.unmake_fullscreen();
        }

        const maximizeFlags = win.get_maximize_flags();
        if (maximizeFlags) {
            if (actor)
                Main.wm.skipNextEffect(actor);
            win.unmaximize(maximizeFlags);
        }
    }

    _tileHalf(win, side) {
        const area = win.get_work_area_current_monitor();
        const leftWidth = Math.floor(area.width / 2);
        const rightWidth = area.width - leftWidth;

        let minWidth = 0;

        try {
            const [hasMinimum, windowMinWidth] = win.get_min_size();

            if (hasMinimum)
                minWidth = windowMinWidth;
        } catch (_) {
        }

        const halfWidth =
            side === 'left' ? leftWidth : rightWidth;

        const tileWidth = Math.min(
            area.width,
            Math.max(halfWidth, minWidth)
        );

        const tileX =
            side === 'left'
                ? area.x
                : area.x + area.width - tileWidth;

        this._moveResizeAnimated(
            win,
            tileX,
            area.y,
            tileWidth,
            area.height
        );
    }

    _tileCorner(win, side, vertical) {
        const area = win.get_work_area_current_monitor();
        const leftWidth = Math.floor(area.width / 2);
        const rightWidth = area.width - leftWidth;
        const topHeight = Math.floor(area.height / 2);
        const bottomHeight = area.height - topHeight;

        const x = side === 'left' ? area.x : area.x + leftWidth;
        const y = vertical === 'top' ? area.y : area.y + topHeight;
        const width = side === 'left' ? leftWidth : rightWidth;
        const height = vertical === 'top' ? topHeight : bottomHeight;

        this._moveResizeAnimated(win, x, y, width, height);
    }

    _cancelResizeGuard(win) {
        const state = this._resizeGuards?.get(win);
        if (!state)
            return false;

        state.cancelled = true;

        if (state.timeoutId) {
            GLib.source_remove(state.timeoutId);
            state.timeoutId = 0;
        }

        this._resizeGuards.delete(win);
        return true;
    }

    _startResizeGuard(win, x, y, width, height) {
        const state = {
            timeoutId: 0,
            cancelled: false,
            deadline:
                GLib.get_monotonic_time() +
                TILE_STATE_GUARD_MS * 1000,
        };

        this._resizeGuards.set(win, state);

        state.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TILE_STATE_GUARD_INTERVAL_MS,
            () => {
                if (state.cancelled ||
                    this._resizeGuards?.get(win) !== state) {
                    state.timeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                if (GLib.get_monotonic_time() >= state.deadline) {
                    state.timeoutId = 0;
                    this._resizeGuards.delete(win);
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    if (win.is_hidden()) {
                        state.timeoutId = 0;
                        this._resizeGuards.delete(win);
                        return GLib.SOURCE_REMOVE;
                    }

                    const actor = win.get_compositor_private();
                    const fullscreen = win.is_fullscreen();

                    if (fullscreen) {
                        if (actor)
                            Main.wm.skipNextEffect(actor);

                        win.unmake_fullscreen();
                    }

                    const maximizeFlags = win.get_maximize_flags();

                    if (maximizeFlags) {
                        if (actor)
                            Main.wm.skipNextEffect(actor);

                        win.unmaximize(maximizeFlags);
                    }

                    const rect = win.get_frame_rect();
                    const wrongGeometry =
                        Math.abs(rect.x - x) > 2 ||
                        Math.abs(rect.y - y) > 2 ||
                        Math.abs(rect.width - width) > 2 ||
                        Math.abs(rect.height - height) > 2;

                    if (fullscreen || maximizeFlags || wrongGeometry) {
                        win.move_resize_frame(
                            true,
                            x,
                            y,
                            width,
                            height
                        );
                    }
                } catch (error) {
                    console.error(
                        `Whoosh tile state guard failed: ${error}`
                    );

                    state.timeoutId = 0;
                    this._resizeGuards.delete(win);
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _moveResizeDirect(win, actor, x, y, width, height) {
        const hadGuard = this._cancelResizeGuard(win);
        const needsGuard =
            hadGuard ||
            win.is_fullscreen() ||
            Boolean(win.get_maximize_flags());

        this._prepareForResize(win, actor);
        win.move_resize_frame(true, x, y, width, height);

        if (needsGuard)
            this._startResizeGuard(win, x, y, width, height);
    }

    _moveResizeAnimated(win, x, y, width, height) {
        const actor = win.get_compositor_private();
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
                        duration: TILE_ANIMATION_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });

                    actor.ease({
                        scale_x: 1,
                        scale_y: 1,
                        translation_x: 0,
                        translation_y: 0,
                        duration: TILE_ANIMATION_MS,
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

    _finishTileAnimation(actor) {
        const state = this._tileAnimations?.get(actor);
        if (!state)
            return;

        if (state.settleId)
            GLib.source_remove(state.settleId);

        actor.remove_all_transitions();
        actor.set_pivot_point(0, 0);
        actor.scale_x = 1;
        actor.scale_y = 1;
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.opacity = state.originalOpacity;

        if (state.clone)
            state.clone.destroy();

        this._tileAnimations.delete(actor);
    }

    _maximize(win) {
        this._cancelResizeGuard(win);

        if (win.is_fullscreen())
            win.unmake_fullscreen();

        if (win.can_maximize() && !win.is_maximized())
            win.maximize();
    }

    _fullscreen(win) {
        this._cancelResizeGuard(win);

        if (!win.is_fullscreen())
            win.make_fullscreen();
    }

    _minimize(win) {
        this._cancelResizeGuard(win);

        if (win.can_minimize())
            win.minimize();
    }

    _cancelPendingClose() {
        if (this._pendingCloseTimeoutId) {
            GLib.source_remove(this._pendingCloseTimeoutId);
            this._pendingCloseTimeoutId = 0;
        }

        this._pendingClose = null;
    }

    _queueClose(win) {
        this._pendingClose = win;
    }

    _commitPendingClose() {
        const win = this._pendingClose;
        this._pendingClose = null;

        if (!win)
            return;

        this._pendingCloseTimeoutId = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT,
            CLOSE_RELEASE_SETTLE_MS,
            () => {
                this._pendingCloseTimeoutId = 0;

                try {
                    if (!win.is_hidden()) {
                        this._close(
                            win,
                            global.display.get_current_time()
                        );
                    }
                } catch (error) {
                    console.error(`Whoosh delayed close failed: ${error}`);
                }
            }
        );
    }

    _close(win, time) {
        this._cancelResizeGuard(win);

        if (win.can_close())
            win.delete(time);
    }
}
