// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal
//
// Whoosh was developed with AI assistance.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TITLEBAR_HEIGHT = 56;
const CORNER_CHAIN_US = 300_000;
const TILE_ANIMATION_MS = 250;
const TILE_SETTLE_MS = 16;
const TILE_SETTLE_ATTEMPTS = 4;
const TILE_STATE_GUARD_MS = 600;
const TILE_STATE_GUARD_INTERVAL_MS = 16;

const BUS_NAME = 'io.github.eshanagarwal05.Whoosh';
const OBJECT_PATH = '/io/github/eshanagarwal05/Whoosh';
const INTERFACE_NAME = 'io.github.eshanagarwal05.Whoosh';

export default class WhooshExtension extends Extension {
    enable() {
        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._pinchTarget = null;
        this._tileAnimations = new Map();
        this._resizeGuards = new Map();

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

        for (const win of [...this._resizeGuards.keys()])
            this._cancelResizeGuard(win);

        for (const actor of [...this._tileAnimations.keys()])
            this._finishTileAnimation(actor);

        this._lastHorizontal = null;
        this._scrollTarget = null;
        this._pinchTarget = null;
        this._tileAnimations.clear();
        this._resizeGuards.clear();
    }

    _handleAction(action) {
        const now = GLib.get_monotonic_time();
        const time = global.display.get_current_time();

        if (action === 'scroll_begin') {
            const [px, py] = global.get_pointer();
            const win = this._getWindowUnderPointer(px, py);

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

            if (action === 'pinch_in') {
                this._close(win, time);
            } else {
                this._fullscreen(win);
                this._activate(win, time);
            }

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

    _close(win, time) {
        this._cancelResizeGuard(win);

        if (win.can_close())
            win.delete(time);
    }
}
