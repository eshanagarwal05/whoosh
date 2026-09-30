// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {centeredRect, sharedEdge, pairedRects, visibleBorderRects} from './resize-geometry.js';

const contains = (r, x, y, pad = 0) => x >= r.x - pad && y >= r.y - pad &&
    x < r.x + r.width + pad && y < r.y + r.height + pad;
const rect = win => {
    const r = win.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
};

export class WindowResizeController {
    constructor(prepare) {
        this._prepare = prepare;
        this._handles = new Map();
        this._altEdges = [];
        this._altSignature = null;
        this._drag = null;
    }

    enable() {
        this._eventId = global.stage.connect('captured-event', (_actor, event) => {
            try {
                return this._event(event);
            } catch (error) {
                this._finish(false);
                console.error(`Whoosh resize failed: ${error}`);
                return Clutter.EVENT_PROPAGATE;
            }
        });
        let tick = 0;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refreshAltEdges();
            if (++tick % 5 === 0)
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    disable() {
        this._finish(false);
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._eventId)
            global.stage.disconnect(this._eventId);
        this._timer = this._eventId = 0;
        this._clearHandles();
        this._clearAltEdges();
    }

    _windows() {
        return global.display.sort_windows_by_stacking(global.get_window_actors()
            .map(a => a.meta_window).filter(w => !w.is_hidden() &&
                w.showing_on_its_workspace() && w.get_compositor_private()?.visible)).reverse();
    }

    _eligible(w) {
        return w && w.allows_resize() && w.allows_move() && !w.is_fullscreen() &&
            w.get_window_type() === Meta.WindowType.NORMAL;
    }

    _blocked() {
        return Main.overview.visible || Main.sessionMode.isLocked || Main.modalCount > 0;
    }

    _clearHandles() {
        for (const h of this._handles.values())
            h.actor.destroy();
        this._handles.clear();
    }

    _refresh() {
        if (this._drag) {
            if (this._blocked() || this._drag.windows.some(w => w.is_hidden() || !w.showing_on_its_workspace()))
                this._finish(false);
            return;
        }
        if (this._blocked() || global.display.is_grabbed()) {
            this._clearHandles();
            return;
        }
        const windows = this._windows();
        const topAt = (x, y) => windows.find(w => contains(rect(w), x, y));
        const wanted = new Set();
        for (let i = 0; i < windows.length; i++) {
            const a = windows[i];
            if (!this._eligible(a))
                continue;
            for (const b of windows.slice(i + 1)) {
                if (!this._eligible(b) || a.get_monitor() !== b.get_monitor())
                    continue;
                const edge = sharedEdge(rect(a), rect(b));
                if (!edge)
                    continue;
                const [first, second] = edge.reverse ? [b, a] : [a, b];
                const x = edge.vertical ? edge.seam : edge.middle;
                const y = edge.vertical ? edge.middle : edge.seam;
                // Do not put chrome over another window or a covered shared border.
                if (topAt(x - (edge.vertical ? 6 : 0), y - (edge.vertical ? 0 : 6)) !== first ||
                    topAt(x + (edge.vertical ? 6 : 0), y + (edge.vertical ? 0 : 6)) !== second)
                    continue;
                const key = `${first.get_stable_sequence()}:${second.get_stable_sequence()}:${edge.vertical}`;
                wanted.add(key);
                let handle = this._handles.get(key);
                if (!handle) {
                    const actor = new St.Widget({reactive: true, track_hover: true,
                        accessible_name: 'Resize both windows',
                        style: 'background-color: transparent; border: 1px solid transparent; border-radius: 5px;'});
                    actor.connect('notify::hover', () => {
                        actor.set_style(actor.hover
                            ? 'background-color: rgba(50,50,55,0.92); border: 1px solid rgba(255,255,255,0.65); border-radius: 5px;'
                            : 'background-color: transparent; border: 1px solid transparent; border-radius: 5px;');
                    });
                    handle = {actor, windows: [first, second], vertical: edge.vertical};
                    actor.connect('button-press-event', (_a, e) => {
                        if (e.get_button() !== 1)
                            return Clutter.EVENT_PROPAGATE;
                        this._begin(handle.windows, e.get_coords(), {vertical: handle.vertical});
                        return Clutter.EVENT_STOP;
                    });
                    Main.layoutManager.addChrome(actor, {trackFullscreen: true});
                    this._handles.set(key, handle);
                }
                const width = edge.vertical ? 10 : 36;
                const height = edge.vertical ? 36 : 10;
                handle.actor.set_position(Math.round(x - width / 2), Math.round(y - height / 2));
                handle.actor.set_size(width, height);
            }
        }
        for (const [key, h] of this._handles) {
            if (!wanted.has(key)) {
                h.actor.destroy();
                this._handles.delete(key);
            }
        }
    }

    _clearAltEdges() {
        for (const actor of this._altEdges)
            actor.destroy();
        this._altEdges = [];
        this._altSignature = null;
    }

    _edgeAt(r, x, y) {
        return {x: Math.abs(x - r.x) <= 8 ? -1 : Math.abs(x - r.x - r.width) <= 8 ? 1 : 0,
            y: Math.abs(y - r.y) <= 8 ? -1 : Math.abs(y - r.y - r.height) <= 8 ? 1 : 0};
    }

    _refreshAltEdges() {
        const [, , mods] = global.get_pointer();
        if (!(mods & Clutter.ModifierType.MOD1_MASK) || this._drag ||
            this._blocked() || global.display.is_grabbed()) {
            if (this._altEdges.length)
                this._clearAltEdges();
            return;
        }
        // Shell doesn't reliably see client-side border presses. While Alt is
        // held, transparent Shell input regions receive those presses instead,
        // just like the shared resize handle. Remove them on Alt release.
        const windows = this._windows();
        const signature = windows.map(w => [w.get_stable_sequence(), rect(w), this._eligible(w)]);
        const key = JSON.stringify(signature);
        if (key === this._altSignature)
            return;
        this._clearAltEdges();
        this._altSignature = key;
        const covered = [];
        for (const win of windows) {
            const r = rect(win);
            if (this._eligible(win)) {
                const area = win.get_work_area_current_monitor();
                for (const region of visibleBorderRects(r, covered, area)) {
                    const actor = new St.Widget({reactive: true,
                        style: 'background-color: transparent;'});
                    actor.set_position(region.x, region.y);
                    actor.set_size(region.width, region.height);
                    actor.connect('button-press-event', (_actor, event) => {
                        if (event.get_button() !== 1 ||
                            !(event.get_state() & Clutter.ModifierType.MOD1_MASK))
                            return Clutter.EVENT_PROPAGATE;
                        const [x, y] = event.get_coords();
                        const edge = this._edgeAt(rect(win), x, y);
                        if (!edge.x && !edge.y)
                            return Clutter.EVENT_PROPAGATE;
                        try {
                            this._begin([win], [x, y], {edge});
                        } catch (error) {
                            this._finish(false);
                            console.error(`Whoosh Alt resize failed: ${error}`);
                        }
                        return this._drag ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
                    });
                    Main.layoutManager.addChrome(actor, {trackFullscreen: true});
                    this._altEdges.push(actor);
                }
            }
            covered.push(r);
        }
    }

    _limits(win) {
        const get = (method, fallback) => {
            const [known, width, height] = win[method]();
            if (!known)
                return [fallback, fallback];
            const frame = win.client_rect_to_frame_rect(new Mtk.Rectangle({x: 0, y: 0, width, height}));
            return [width > 0 ? frame.width : fallback, height > 0 ? frame.height : fallback];
        };
        const [minWidth, minHeight] = get('get_min_size', 1);
        const [maxWidth, maxHeight] = get('get_max_size', Infinity);
        return {minWidth, minHeight, maxWidth, maxHeight};
    }

    _begin(windows, pointer, mode) {
        if (this._drag || this._blocked() || global.display.is_grabbed())
            return;
        const original = windows.map(rect);
        const limits = windows.map(w => this._limits(w));
        this._grab = global.stage.grab(global.stage);
        this._drag = {windows, pointer, mode, original, limits, signals: []};
        for (const w of windows) {
            this._drag.signals.push([w, w.connect('unmanaged', () => this._finish(false))]);
            this._prepare(w);
            this._apply(w, original[windows.indexOf(w)]);
        }
        this._clearHandles();
        this._clearAltEdges();
    }

    _finish(restore) {
        const d = this._drag;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        if (!d)
            return;
        for (const [w, id] of d.signals)
            w.disconnect(id);
        if (restore)
            d.windows.forEach((w, i) => this._apply(w, d.original[i]));
    }

    _apply(w, r) {
        w.move_resize_frame(true, r.x, r.y, r.width, r.height);
    }

    _event(event) {
        const type = event.type();
        if (this._drag) {
            if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._finish(true);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.BUTTON_RELEASE) {
                const d = this._drag;
                const [x, y] = event.get_coords();
                const dx = x - d.pointer[0], dy = y - d.pointer[1];
                const result = d.mode.edge
                    ? [centeredRect(d.original[0], d.mode.edge, dx, dy, d.limits[0])]
                    : pairedRects(...d.original, d.mode.vertical, d.mode.vertical ? dx : dy, ...d.limits);
                d.windows.forEach((w, i) => this._apply(w, result[i]));
                if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1)
                    this._finish(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1 ||
            !(event.get_state() & Clutter.ModifierType.MOD1_MASK) || this._blocked())
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const win = this._windows().find(w => contains(rect(w), x, y, 8));
        if (!this._eligible(win))
            return Clutter.EVENT_PROPAGATE;
        const r = rect(win);
        const edge = this._edgeAt(r, x, y);
        if (!edge.x && !edge.y)
            return Clutter.EVENT_PROPAGATE;
        this._begin([win], [x, y], {edge});
        return this._drag ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }
}
