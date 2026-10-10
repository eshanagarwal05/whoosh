const fs=require('fs'),vm=require('vm'),assert=require('assert');
const file=require('path').join(__dirname,'../extension/extension.js');
const src=fs.readFileSync(file,'utf8').replace(/^import .*;\n/gm,'').replace('export default class WhooshExtension','class WhooshExtension');
let committed=[],actor;
const win={is_hidden:()=>false,get_work_area_current_monitor:()=>({x:0,y:0,width:1000,height:800})};
class Base{_handleAction(a){if(a==='gesture_claim_begin')this._gestureClaimActive=true;else if(a==='gesture_claim_end')this._gestureClaimActive=false;else if(a==='scroll_begin')this._scrollTarget=win;else committed.push(a)}}
class Widget{constructor(){actor=this}set_position(x,y){this.x=x;this.y=y}set_size(w,h){this.w=w;this.h=h}destroy(){this.destroyed=true}}
const ctx={WhooshCoreExtension:Base,Clutter:{ModifierType:{SHIFT_MASK:1}},St:{Widget},Main:{layoutManager:{addChrome(){}}},global:{get_pointer:()=>[0,0,0]},console};vm.createContext(ctx);vm.runInContext(src+'\nthis.E=WhooshExtension',ctx);
const e=new ctx.E();e._touchpadEnabled=()=>true;e._cornerTilingEnabled=()=>true;
e._handleAction('gesture_claim_begin');e._handleAction('scroll_begin');e._handleAction('left');assert.equal(committed.length,0);assert.equal(actor.w,500);assert.equal(actor.h,800);
e._handleAction('up');assert.equal(e._swipePreview.action,'corner_left_up');assert.equal(actor.h,400);
e._handleAction('right');assert.equal(e._swipePreview.action,'corner_right_up');assert.equal(actor.x,500);assert.equal(committed.length,0);
e._handleAction('gesture_claim_end');assert.deepEqual(committed,['corner_right_up']);assert(actor.destroyed);assert.equal(e._swipePreview,null);
e._handleAction('gesture_claim_end');assert.equal(committed.length,1);
console.log('Preview only, corner changes, reversal, release commits once, overlay cleanup passed');
