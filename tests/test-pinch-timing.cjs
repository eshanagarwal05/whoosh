const fs=require('fs'),vm=require('vm'),assert=require('assert');
let calls=[],fail=false;
class Core {_handleAction(action){calls.push([action,this._gestureClaimActive]);if(fail)throw Error('test')}}
const source=fs.readFileSync(require('path').join(__dirname, '../extension/extension.js'),'utf8').replace(/^import .*;\n/gm,'').replace('export default class WhooshExtension','class WhooshExtension');
const ctx={WhooshCoreExtension:Core};vm.createContext(ctx);vm.runInContext(source+'\nthis.Extension=WhooshExtension;',ctx);
const e=new ctx.Extension();e._touchpadEnabled=()=>true;e._cornerTilingEnabled=()=>false;e._gestureClaimActive=true;e._pinchTabTarget={};
e._handleAction('pinch_in');assert.deepEqual(calls,[['pinch_in',false]]);assert.equal(e._gestureClaimActive,true);
fail=true;assert.throws(()=>e._handleAction('pinch_in'));assert.equal(e._gestureClaimActive,true);
console.log('Recognized pinch dispatches immediately with tab detection enabled; gesture state restored on success and error');
