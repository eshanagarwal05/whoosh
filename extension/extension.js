// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal
//
// Whoosh was developed with AI assistance.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TITLEBAR_HEIGHT = 56;
const CORNER_CHAIN_US = 850_000;
const TILE_ANIMATION_MS = 250;

const BUS_NAME = 'io.github.eshanagarwal05.Whoosh';
const OBJECT_PATH = '/io/github/eshanagarwal05/Whoosh';
const INTERFACE_NAME = 'io.github.eshanagarwal05.Whoosh';

export default class WhooshExtension extends Extension {
    enable() {
        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._pinchTarget = null;

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
        if (this._dbusSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._dbusSignalId);
            this._dbusSignalId = 0;
        }

        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._pinchTarget = null;
    }

    _handleAction(action) {
        const now = GLib.get_monotonic_time();
        const time = global.display.get_current_time();

        if (action === 'scroll_begin') {
            const [px, py] = global.get_pointer();
            const win = this._getWindowUnderPointer(px, py);

            // Lock the topmost title-bar window at the START of each
            // two-finger scroll gesture. This prevents a tile operation from
            // exposing a window underneath and accidentally retargeting it.
            this._scrollTarget =
                win && this._isInGestureZone(win, px, py) ? win : null;
            return;
        }

        if (action === 'pinch_begin') {
            const [px, py] = global.get_pointer();
            const win = this._getWindowUnderPointer(px, py);

            this._pinchTarget =
                win && this._isInGestureZone(win, px, py) ? win : null;
            return;
        }

        if (action === 'pinch_in' || action === 'pinch_out') {
            const win = this._pinchTarget;
            this._pinchTarget = null;
            this._lastHorizontal = null;

            if (!win || win.is_hidden())
                return;

            if (action === 'pinch_in')
                this._close(win, time);
            else
                this._moveToEmptyWorkspace(win, time);

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

        if (!win || win.is_hidden()) {
            this._clearExpiredHorizontal(now);
            return;
        }

        // For backends older than Whoosh 1.1, where scroll_begin is not
        // available, retain the pointer/title-bar check.
        if (!this._scrollTarget && !this._isInGestureZone(win, px, py)) {
            this._clearExpiredHorizontal(now);
            return;
        }

        switch (action) {
        case 'left':
            this._tileHalf(win, 'left');
            this._activate(win, time);
            this._lastHorizontal = {win, side: 'left', when: now};
            break;
        case 'right':
            this._tileHalf(win, 'right');
            this._activate(win, time);
            this._lastHorizontal = {win, side: 'right', when: now};
            break;
        case 'up':
            this._maximize(win);
            this._activate(win, time);
            this._lastHorizontal = null;
            break;
        case 'down':
            this._minimize(win);
            this._lastHorizontal = null;
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
            now - this._lastHorizontal.when <= CORNER_CHAIN_US * 2) {
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

    _activate(win, time) {
        if (!win.has_focus())
            win.activate(time);
    }

    _prepareForResize(win) {
        if (win.is_fullscreen())
            win.unmake_fullscreen();

        const maximizeFlags = win.get_maximize_flags();
        if (maximizeFlags)
            win.unmaximize(maximizeFlags);
    }

    _tileHalf(win, side) {
        this._prepareForResize(win);

        const area = win.get_work_area_current_monitor();
        const leftWidth = Math.floor(area.width / 2);
        const rightWidth = area.width - leftWidth;

        if (side === 'left') {
            this._moveResizeAnimated(
                win,
                area.x,
                area.y,
                leftWidth,
                area.height
            );
        } else {
            this._moveResizeAnimated(
                win,
                area.x + leftWidth,
                area.y,
                rightWidth,
                area.height
            );
        }
    }

    _tileCorner(win, side, vertical) {
        this._prepareForResize(win);

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

    _moveResizeAnimated(win, x, y, width, height) {
        const oldRect = win.get_frame_rect();
        const actor = win.get_compositor_private();

        // Mutter owns the actual window geometry. Clutter owns the visual
        // actor, so use a FLIP-style transform: commit final geometry first,
        // then visually transform the final actor back to the old frame and
        // ease that transform to identity.
        win.move_resize_frame(true, x, y, width, height);

        if (!actor)
            return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!actor.is_mapped())
                return GLib.SOURCE_REMOVE;

            const newRect = win.get_frame_rect();
            if (newRect.width <= 0 || newRect.height <= 0)
                return GLib.SOURCE_REMOVE;

            const scaleX = oldRect.width / newRect.width;
            const scaleY = oldRect.height / newRect.height;
            const translateX = oldRect.x - newRect.x;
            const translateY = oldRect.y - newRect.y;

            if (Math.abs(scaleX - 1) < 0.001 &&
                Math.abs(scaleY - 1) < 0.001 &&
                Math.abs(translateX) < 0.5 &&
                Math.abs(translateY) < 0.5) {
                return GLib.SOURCE_REMOVE;
            }

            for (const transition of [
                'translation-x',
                'translation-y',
                'scale-x',
                'scale-y',
            ]) {
                actor.remove_transition(transition);
            }

            actor.set_pivot_point(0, 0);
            actor.translation_x = translateX;
            actor.translation_y = translateY;
            actor.scale_x = scaleX;
            actor.scale_y = scaleY;

            actor.ease({
                translation_x: 0,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                duration: TILE_ANIMATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _maximize(win) {
        if (win.is_fullscreen())
            win.unmake_fullscreen();

        if (win.can_maximize() && !win.is_maximized())
            win.maximize();
    }

    _minimize(win) {
        if (win.can_minimize())
            win.minimize();
    }

    _close(win, time) {
        if (win.can_close())
            win.delete(time);
    }

    _moveToEmptyWorkspace(win, time) {
        const manager = global.workspace_manager;
        const current = win.get_workspace();
        const currentIndex = current.index();
        let target = null;

        for (let i = currentIndex + 1; i < manager.get_n_workspaces(); i++) {
            const candidate = manager.get_workspace_by_index(i);
            const occupied = candidate.list_windows().some(
                candidateWindow =>
                    candidateWindow !== win &&
                    !candidateWindow.is_on_all_workspaces()
            );

            if (!occupied) {
                target = candidate;
                break;
            }
        }

        if (!target)
            target = manager.append_new_workspace(false, time);

        win.change_workspace(target);
        target.activate_with_focus(win, time);
    }
}
