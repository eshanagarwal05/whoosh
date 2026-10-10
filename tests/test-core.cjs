const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname, '../extension/extension-core.js'),'utf8').replace(/^import .*;\n/gm,'').replace('export default class WhooshExtension','class WhooshExtension');
let notices=0,keys=[],mods=0,focus=true,wmClass='obsidian';let scheduled=new Map(),nextId=1;
const Clutter={ModifierType:{SHIFT_MASK:1,CONTROL_MASK:4,MOD1_MASK:8,SUPER_MASK:16},InputDeviceType:{KEYBOARD_DEVICE:3},KeyState:{PRESSED:1,RELEASED:0},KEY_Control_L:100,KEY_Shift_L:101,KEY_w:119,get_default_backend:()=>({get_default_seat:()=>({create_virtual_device:()=>({notify_keyval:(t,k,s)=>keys.push([k,s])})})})};
const GLib={PRIORITY_DEFAULT:0,SOURCE_REMOVE:false,SOURCE_CONTINUE:true,get_monotonic_time:()=>1,timeout_add:(p,t,cb)=>{const id=nextId++;scheduled.set(id,cb);return id},source_remove:id=>scheduled.delete(id)};
const context={Extension:class{},Main:{notify:()=>notices++},GLib,Clutter,global:{get_pointer:()=>[0,0,mods],display:{get_current_time:()=>1}},console};vm.createContext(context);vm.runInContext(src+'\nthis.Core=WhooshExtension;',context);
const c=new context.Core();c._tabTargets=new Set();c._tabFocusTimers=new Set();c._activate=()=>{};let windowsClosed=0;c._close=()=>windowsClosed++;
const win={is_hidden:()=>false,has_focus:()=>focus,get_wm_class:()=>wmClass,get_buffer_rect:()=>({x:0,y:0,width:600,height:400})};
for(const result of ['closed','tab-unavailable','unavailable','window','ignored','unexpected'])c._finishTabClose(win,{close:cb=>cb(result)});
assert.equal(windowsClosed,5);assert.equal(notices,0);
c._performPinchClose(win,null,1);assert.equal(windowsClosed,6);
c._finishTabClose(win,{close:cb=>cb('shortcut')});assert.deepEqual(keys,[[100,1],[119,1],[119,0],[100,0]]);
keys=[];focus=false;c._closeSelectedTab(win);assert.equal(keys.length,0);
focus=true;mods=1;c._closeSelectedTab(win);assert.equal(keys.length,0);mods=0;
wmClass='org.gnome.Ptyxis';c._closeSelectedTab(win);assert.deepEqual(keys,[[101,1],[100,1],[119,1],[119,0],[100,0],[101,0]]);
let cancelled=0,committed=0;const tab={matchesWindow:()=>true,cancel:()=>cancelled++,close:cb=>{committed++;cb('closed')}};
focus=false;c._performPinchClose(win,tab,1);const callback=[...scheduled.values()].at(-1);assert.equal(callback(),true);assert.equal(committed,0);
focus=true;assert.equal(callback(),false);assert.equal(committed,1);
c._performPinchClose(win,{...tab,matchesWindow:()=>false},1);assert.equal(cancelled,1);
focus=false;c._performPinchClose(win,tab,1);c._tabTargets.add(tab);c._cancelTabTargets();assert.equal(c._tabFocusTimers.size,0);assert.equal(cancelled,2);
console.log('Close routing, focus waits, moved-window cancellation, modifier guard, Ctrl+W and terminal Ctrl+Shift+W checks passed');

focus=true;const timersBefore=scheduled.size;const callsBefore=committed;c._performPinchClose(win,tab,1);assert.equal(committed,callsBefore+1);assert.equal(scheduled.size,timersBefore);console.log('Focused-window close has no activation timer');

let before=windowsClosed;mods=1;c._finishTabClose(win,{close:cb=>cb('shortcut')});assert.equal(windowsClosed,before+1);mods=0;
before=windowsClosed;focus=false;c._finishTabClose(win,{close:cb=>cb('shortcut')});assert.equal(windowsClosed,before+1);focus=true;
before=windowsClosed;c._finishTabClose({...win,is_hidden:()=>true},{close:cb=>cb('unavailable')});assert.equal(windowsClosed,before);
focus=false;c._performPinchClose(win,tab,1);const stalledFocus=[...scheduled.values()].at(-1);
for(let i=0;i<21;i++)stalledFocus();assert.equal(windowsClosed,before+1);focus=true;
console.log('Blocked shortcut and focus timeout close target window; hidden windows stay untouched');


// Gesture scope is captured at begin, including the exclusive bottom edge.
c._getOverviewWindowUnderPointer=()=>null;c._getDashAppUnderPointer=()=>null;
c._getWindowUnderPointer=()=>scopeWin;
const scopeWin={...win,get_frame_rect:()=>({x:100,y:100,width:600,height:400})};
let pointer=[300,300,0],pinchCloses=0,lookups=0;
context.global.get_pointer=()=>pointer;
context.TabTarget=class {constructor(){lookups++} cancel(){}};
c._performPinchClose=()=>pinchCloses++;
for(const [x,y,allowed] of [[300,120,true],[300,155,true],[300,156,false],[300,300,false],[95,120,false],[300,500,false]]){
 pointer=[x,y,0];const previous=pinchCloses,previousLookups=lookups;
 c._handleAction('pinch_begin');pointer=[300,120,0];c._handleAction('pinch_in');
 assert.equal(pinchCloses,previous+Number(allowed));assert.equal(lookups,previousLookups+Number(allowed));
}
console.log('Touchpad content pinches cannot close, even after moving into title bar');

const fourSource=fs.readFileSync(require('path').join(__dirname,'../extension/fourfinger.js'),'utf8').replace(/^import .*;\n/gm,'').replace('export class FourFingerTouchController','class FourFingerTouchController');
vm.runInContext(fourSource+'\nthis.Four=FourFingerTouchController;',context);
let touchActions=[];GLib.idle_add=(priority,cb)=>{cb();return 1};
const four=new context.Four({getWindowAt:()=>scopeWin,canCloseAt:(w,x,y)=>c._isInGestureZone(w,x,y),applyAction:(w,a)=>touchActions.push(a)});
for(const [y,scale,expected] of [[120,0.6,'close'],[300,0.6,null],[156,0.6,null],[300,1.4,'fullscreen']]){
 four._geometry=()=>({centerX:300,centerY:y,spread:60});four._beginGesture();
 four._gesture.minScale=Math.min(1,scale);four._gesture.maxScale=Math.max(1,scale);
 const previous=touchActions.length;four._finishGesture();assert.equal(touchActions.length,previous+Number(expected!==null));
 if(expected)assert.equal(touchActions.at(-1),expected);
}
console.log('Touchscreen close is title-bar only; content fullscreen still works');
