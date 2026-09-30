const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/resize-geometry.js'), 'utf8').replaceAll('export function', 'function'), context);
const {centeredRect, sharedEdge, pairedRects} = context;
const r = {x: 100, y: 80, width: 600, height: 400};
const l = {minWidth: 100, minHeight: 80, maxWidth: 1000, maxHeight: 800};
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
    if (!x && !y) continue;
    for (const delta of [-1000, -20, 0, 30, 1000]) {
        const out = centeredRect(r, {x, y}, delta, delta, l);
        assert.equal(out.x + out.width / 2, 400);
        assert.equal(out.y + out.height / 2, 280);
        assert(out.width >= l.minWidth && out.width <= l.maxWidth);
        assert(out.height >= l.minHeight && out.height <= l.maxHeight);
        if (!x) assert.equal(out.width, r.width);
        if (!y) assert.equal(out.height, r.height);
    }
}
const b = {...r, x: 700};
assert.equal(sharedEdge(r, b).vertical, true);
assert.equal(sharedEdge(b, r).reverse, true);
assert.equal(sharedEdge(r, {...b, x: 710}), null);
assert.equal(sharedEdge(r, {...b, x: 680}), null);
assert.equal(sharedEdge(r, {...b, y: 480}), null);
assert.equal(sharedEdge(r, {...r, y: 480}).vertical, false);
for (const vertical of [true, false]) {
    const b = vertical ? {...r, x: 700} : {...r, y: 480};
    for (const delta of [-2000, -20, 0, 30, 2000]) {
        const [one, two] = pairedRects(r, b, vertical, delta, l, l);
        if (vertical) {
            assert.equal(one.x, r.x);
            assert.equal(one.x + one.width, two.x);
            assert.equal(two.x + two.width, 1300);
        } else {
            assert.equal(one.y, r.y);
            assert.equal(one.y + one.height, two.y);
            assert.equal(two.y + two.height, 880);
        }
        for (const out of [one, two]) {
            assert(out.width >= l.minWidth && out.width <= l.maxWidth);
            assert(out.height >= l.minHeight && out.height <= l.maxHeight);
        }
    }
}
console.log('Resize geometry: eight directions, center invariance, adjacency, both shared axes, and size limits passed');

// Exercise input ownership and teardown, including destruction during a drag.
let dismissed = 0, removed = 0, live = new Map(), nextId = 1;
let pointer = [700, 280];
const Clutter = {EVENT_STOP: true, EVENT_PROPAGATE: false, KEY_Escape: 27,
    ModifierType: {MOD1_MASK: 8},
    EventType: {BUTTON_PRESS: 1, BUTTON_RELEASE: 2, MOTION: 3, KEY_PRESS: 4}};
Object.assign(context, {Clutter, GLib: {source_remove: () => removed++},
    Meta: {WindowType: {NORMAL: 0}}, Main: {overview: {visible: false}, sessionMode: {isLocked: false}, modalCount: 0},
    global: {stage: {grab: () => ({dismiss: () => dismissed++}), disconnect: () => {}},
        display: {is_grabbed: () => false}}, console});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/resize.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nthis.Controller = WindowResizeController;', context);
const c = new context.Controller(() => {});
let geometry = {...r};
const win = {get_frame_rect: () => geometry, allows_resize: () => true, allows_move: () => true,
    is_fullscreen: () => false, get_window_type: () => 0,
    connect: (name, cb) => {const id = nextId++; live.set(id, cb); return id;},
    disconnect: id => live.delete(id), move_resize_frame: (_, x, y, width, height) => {geometry = {x, y, width, height};}};
c._windows = () => [win]; c._limits = () => l;
const event = (type, state = 8, key = 0) => ({type: () => type, get_button: () => 1,
    get_state: () => state, get_coords: () => pointer, get_key_symbol: () => key});
assert.equal(c._event(event(1, 0)), false);
assert.equal(c._event(event(1)), true);
assert.equal(live.size, 1);
pointer = [730, 280]; c._event(event(3));
assert.deepEqual(geometry, {x: 70, y: 80, width: 660, height: 400});
c._event(event(4, 8, 27));
assert.deepEqual(geometry, r); assert.equal(dismissed, 1); assert.equal(live.size, 0);
pointer = [700, 280]; c._event(event(1));
[...live.values()][0](); assert.equal(c._drag, null); assert.equal(dismissed, 2);
c._event(event(1)); c._event(event(2)); assert.equal(dismissed, 3);
c._event(event(1)); c._timer = 1; c.disable();
assert.equal(dismissed, 4); assert.equal(removed, 1); assert.equal(live.size, 0);
console.log('Resize input: Alt gating, pointer motion, Escape, release, window destruction, and disable cleanup passed');

// The invisible hit area stays reactive, then reveals only its hovered handle.
context.global.display.is_grabbed = () => false;
class Widget {
    constructor(props) { Object.assign(this, props); this.signals = {}; }
    connect(name, cb) {this.signals[name] = cb;}
    set_style(style) {this.style = style;}
    set_position() {}
    set_size() {}
    destroy() {}
}
context.St = {Widget};
context.Main.layoutManager = {addChrome: () => {}};
const second = {...win, get_frame_rect: () => ({...r, x: 700}), get_stable_sequence: () => 2};
win.get_monitor = second.get_monitor = () => 0;
win.get_stable_sequence = () => 1;
geometry = {...r}; c._windows = () => [win, second];
c._refresh(); assert.equal(c._handles.size, 1);
const actor = [...c._handles.values()][0].actor;
assert(actor.reactive); assert(actor.style.includes('background-color: transparent'));
actor.hover = true; actor.signals['notify::hover']();
assert(actor.style.includes('rgba(50,50,55,0.92)'));
actor.hover = false; actor.signals['notify::hover']();
assert(actor.style.includes('background-color: transparent'));
c.disable();
console.log('Shared handle: hidden by default, shown on hover, hidden on leave passed');

// Deliver the border press directly to its actor: no stage press is required.
let mods = 8;
context.global.get_pointer = () => [700, 280, mods];
win.get_work_area_current_monitor = () => ({x: 0, y: 30, width: 1600, height: 900});
c._windows = () => [win];
c._refreshAltEdges();
assert.equal(c._altEdges.length, 4);
const oldActor = c._altEdges[0];
c._refreshAltEdges(); assert.equal(c._altEdges[0], oldActor, 'stable hit areas must not be recreated');
const border = c._altEdges[3];
pointer = [700, 280];
assert.equal(border.signals['button-press-event'](border, event(1)), true);
assert(c._drag); assert.equal(c._altEdges.length, 0);
pointer = [730, 280]; c._event(event(3));
assert.deepEqual(geometry, {x: 70, y: 80, width: 660, height: 400});
c._event(event(4, 8, 27));
assert.deepEqual(geometry, r);
c._refreshAltEdges(); assert.equal(c._altEdges.length, 4);
mods = 0; c._refreshAltEdges(); assert.equal(c._altEdges.length, 0);
mods = 8; context.Main.overview.visible = true;
c._refreshAltEdges(); assert.equal(c._altEdges.length, 0);
context.Main.overview.visible = false;
c._refreshAltEdges(); c.disable(); assert.equal(c._altEdges.length, 0);
const area = {x: 0, y: 30, width: 1600, height: 900};
const cover = {x: 650, y: 50, width: 200, height: 500};
const regions = context.visibleBorderRects(r, [cover], area);
for (const b of regions) {
    assert(b.width > 0 && b.height > 0);
    assert(b.x >= area.x && b.y >= area.y);
    assert(b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
    assert(b.x + b.width <= cover.x || b.x >= cover.x + cover.width ||
        b.y + b.height <= cover.y || b.y >= cover.y + cover.height);
}
assert.equal(context.visibleBorderRects(r, [{x: 0, y: 0, width: 1600, height: 900}], area).length, 0);
console.log('Alt border capture: direct actor input, symmetric drag, stable regions, release/Overview/disable cleanup, and occlusion passed');
