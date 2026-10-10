const fs=require('fs'),vm=require('vm'),assert=require('assert');
const file=require('path').join(__dirname,'../extension/extension.js');
const src=fs.readFileSync(file,'utf8').replace(/^import .*;\n/gm,'').replace('export default class WhooshExtension','class WhooshExtension');
let committed=[],actor;
const win={is_hidden:()=>false,get_work_area_current_monitor:()=>({x:0,y:0,width:1000,height:800})};
class Base{_handleAction(a){if(a==='gesture_claim_begin')this._gestureClaimActive=true;else if(a==='gesture_claim_end')this._gestureClaimActive=false;else if(a==='scroll_begin')this._scrollTarget=win;else committed.push(a)}}
class Widget{constructor(){actor=this}set_position(x,y){this.x=x;this.y=y}set_size(w,h){this.w=w;this.h=h}destroy(){this.destroyed=true}}
const ctx={WhooshCoreExtension:Base,Clutter:{ModifierType:{SHIFT_MASK:1}},St:{Widget},Main:{layoutManager:{addChrome(){}}},global:{get_pointer:()=>[0,0,0],display:{get_current_time:()=>1}},console};vm.createContext(ctx);vm.runInContext(src+'\nthis.E=WhooshExtension',ctx);
const e=new ctx.E();e._moveResizeAnimated=(w,x,y,width,height)=>committed.push({x,y,width,height});e._activate=()=>{};e._touchpadEnabled=()=>true;e._cornerTilingEnabled=()=>true;
e._handleAction('gesture_claim_begin');e._handleAction('scroll_begin');e._handleAction('left');assert.equal(committed.length,0);assert.equal(actor.w,500);assert.equal(actor.h,800);
e._handleAction('up');assert.equal(e._swipePreview.action,'corner_left_up');assert.equal(actor.h,400);
e._handleAction('right');assert.equal(e._swipePreview.action,'corner_right_up');assert.equal(actor.x,500);assert.equal(committed.length,0);
e._handleAction('gesture_claim_end');assert.deepEqual(committed,[{x:500,y:0,width:500,height:400}]);assert(actor.destroyed);assert.equal(e._swipePreview,null);
e._handleAction('gesture_claim_end');assert.equal(committed.length,1);
console.log('Preview only, corner changes, reversal, release commits once, overlay cleanup passed');

let mods=1,applied=[];
ctx.global.get_pointer=()=>[0,0,mods];
ctx.global.display={get_current_time:()=>1};
e._moveResizeAnimated=(w,x,y,width,height)=>applied.push({x,y,width,height});
e._activate=()=>{};
function begin(){e._handleAction('gesture_claim_begin');e._handleAction('scroll_begin')}
begin();
e._handleAction('left');assert.equal(actor.w,333);assert.equal(actor.h,800);
e._handleAction('up');assert.equal(actor.w,333);assert.equal(actor.h,400);assert.equal(applied.length,0);
e._handleAction('gesture_claim_end');assert.deepEqual(applied.pop(),{x:0,y:0,width:333,height:400});
begin();
e._handleAction('left');assert.equal(actor.w,333);
e._handleAction('left');assert.equal(actor.w,333); // clamp at edge
for(const [x,width] of [[0,667],[333,334],[333,667],[667,333],[667,333]]) {
 e._handleAction('right');assert.equal(actor.x,x);assert.equal(actor.w,width);
}
e._handleAction('down');assert.equal(actor.h,400);assert.equal(actor.y,400);
e._handleAction('gesture_claim_end');assert.deepEqual(applied.pop(),{x:667,y:400,width:333,height:400});
begin();e._handleAction('up');assert.equal(actor.w,1000);assert.equal(actor.h,400);e._handleAction('gesture_claim_end');assert.equal(applied.pop().height,400);
begin();e._handleAction('left');mods=0;e._handleAction('up');assert.equal(actor.w,500);assert.equal(actor.h,400);e._handleAction('gesture_claim_end');assert.deepEqual(applied.pop(),{x:0,y:0,width:500,height:400});
mods=1;win.get_min_size=()=>[true,420,450];begin();e._handleAction('right');e._handleAction('down');assert.equal(actor.w,420);assert.equal(actor.x,580);assert.equal(actor.h,450);assert.equal(actor.y,350);e._handleAction('gesture_claim_end');assert.deepEqual(applied.pop(),{x:580,y:350,width:420,height:450});
console.log('Shift spatial grid, edge clamping, centered thirds, sixth corners, vertical halves, modifier changes, minimum sizes and preview/apply equality passed');

// Client minimums include window decorations, including unshifted corners.
ctx.Mtk={Rectangle:class{constructor(r){Object.assign(this,r)}}};
win.client_rect_to_frame_rect=r=>({...r,width:r.width+20,height:r.height+40});
win.get_min_size=()=>[true,600,500];
mods=0;begin();e._handleAction('right');e._handleAction('down');
assert.equal(actor.w,620);assert.equal(actor.h,540);assert.equal(actor.x,380);assert.equal(actor.y,260);
e._handleAction('gesture_claim_end');assert.deepEqual(applied.pop(),{x:380,y:260,width:620,height:540});
win.allows_resize=()=>false;win.get_frame_rect=()=>({x:50,y:50,width:700,height:600});
const fixed=e._constrainTileRect(win,{x:500,y:400,width:500,height:400});assert.deepEqual(JSON.parse(JSON.stringify(fixed)),{x:300,y:200,width:700,height:600});
win.allows_resize=()=>true;win.get_min_size=()=>[true,1200,900];
const oversized=e._constrainTileRect(win,{x:500,y:400,width:500,height:400});assert.equal(oversized.x,0);assert.equal(oversized.y,0);assert.equal(oversized.width,1220);assert.equal(oversized.height,940);
console.log('Corner minimums include decorations; fixed-size and oversized windows stay reachable');

let settle,position,guardCancelled=0;
Base.prototype._moveResizeDirect=()=>{};
ctx.GLib={PRIORITY_DEFAULT:0,SOURCE_REMOVE:false,SOURCE_CONTINUE:true,timeout_add:(p,t,cb)=>{settle=cb;return 17},source_remove:()=>{}};
e._cancelResizeGuard=()=>guardCancelled++;
const refuses={get_work_area_current_monitor:()=>({x:0,y:0,width:1000,height:800}),get_frame_rect:()=>({x:500,y:400,width:650,height:550}),move_frame:(user,x,y)=>position={x,y}};
e._moveResizeDirect(refuses,null,500,400,500,400);settle();assert.deepEqual(position,{x:350,y:250});assert.equal(guardCancelled,1);
for(let i=0;i<3;i++)settle();assert.equal(e._cornerSettleSources.size,0);
console.log('Actual application resize refusal reanchors the real window and stops impossible resize retries');
