import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingReleaseRanges,ReverseExecutor} from './executor.mjs';
import {ReverseSync} from './store.mjs';
import {FLEET} from '../parsers.mjs';
const range=(start,end)=>({start,end}),all=range('2027-01-01','2027-01-09');
test('only currently closed historical automated dates are shown; manual-only dates never qualify',()=>{
 assert.deepEqual(pendingReleaseRanges([], [all], [], '2026-09-14'),[]);
 assert.deepEqual(pendingReleaseRanges([all], [], [], '2026-09-14'),[]);
 assert.deepEqual(pendingReleaseRanges([all],[range('2027-01-02','2027-01-05')],[], '2026-09-14'),[range('2027-01-02','2027-01-05')]);
});
test('subtract active orders including native bookings and trim past dates without merging across protected days',()=>{
 assert.deepEqual(pendingReleaseRanges([all,all],[all],[range('2027-01-03','2027-01-06')],'2027-01-02'),[range('2027-01-02','2027-01-03'),range('2027-01-06','2027-01-09')]);
 assert.deepEqual(pendingReleaseRanges([all],[all],[all],'2027-01-02'),[]);
});
class Storage{data=new Map();async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async transaction(fn){return fn(this);}}
function setup({collectedOnce=false}={}){let clock=Date.parse('2026-09-14T01:00:00Z');const storage=new Storage(),mapping={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]};
 const collected=clock,success=()=>new Date(collectedOnce?collected:clock).toISOString();
 const engine=new ReverseSync({storage,registry:async()=>mapping,registryStatus:async()=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_error:null,last_success_at:success()}]))}),now:()=>clock});
 return {engine,mapping,advance:(ms=1000)=>clock+=ms,stamp:()=>new Date(clock).toISOString()};
}
test('kept program records on SamBoat or Click&Boat are reported and shown like Boataround ones (2026-10-10)',async()=>{
 const f=setup(),plan=await f.engine.machinePlan();
 for(const kind of ['samboat','clickandboat']){
  const t=plan.targets.find(x=>x.target===kind&&x.listing_id);
  await f.engine.report({mode:'guarded_release',targets:[{key:t.key,state:'removal_requires_verification',checked_at:f.stamp(),segments:t.segments,retained:['a-old'],retained_ranges:[all]}]});
  const shown=(await f.engine.preview()).targets.find(x=>x.key===t.key);
  assert.deepEqual(shown.execution.retained_ranges,[all],kind);assert.deepEqual(shown.release_review.ranges,[all],kind);
  f.advance();
 }
});
test('a full check with days the platform will not close still clears an old warning (Click&Boat AD1, 2026-10-12)',async()=>{
 const f=setup(),plan=await f.engine.machinePlan(),t=plan.targets.find(x=>x.target==='clickandboat'&&x.listing_id);
 const send=(fields,mode='guarded_release')=>f.engine.report({mode,targets:[{key:t.key,checked_at:f.stamp(),segments:t.segments,...fields}]});
 const shown=async()=>(await f.engine.preview()).targets.find(x=>x.key===t.key).release_review?.ranges;
 await send({state:'removal_requires_verification',retained:['a-old'],retained_ranges:[all]});assert.deepEqual(await shown(),[all]);
 // A failed check sends no list and a close-only check none either: the warning stays.
 f.advance();await send({state:'needs_review',error:'app_not_in_foreground'});assert.deepEqual(await shown(),[all]);
 f.advance();await send({state:'needs_review',blocked:[{...range('2027-02-12','2027-02-13'),error:'cb_app_day_before_record'}]},'close_only');assert.deepEqual(await shown(),[all]);
 // A full check that kept nothing clears it, though one day stays unclosable.
 f.advance();await send({state:'needs_review',blocked:[{...range('2027-02-12','2027-02-13'),error:'cb_app_day_before_record'}],retained:[],retained_ranges:[]});
 assert.equal(await shown(),undefined);
});
test('an empty list does not clear a warning when the plan is no longer fresh',async()=>{
 const f=setup({collectedOnce:true}),t=(await f.engine.machinePlan()).targets.find(x=>x.target==='samboat'&&x.listing_id);
 const send=fields=>f.engine.report({mode:'guarded_release',targets:[{key:t.key,checked_at:f.stamp(),segments:t.segments,...fields}]});
 await send({state:'removal_requires_verification',retained:['a-old'],retained_ranges:[all]});
 f.advance(25*60000);await send({state:'needs_review',blocked:[{...all,error:'cb_app_day_before_record'}],retained:[],retained_ranges:[]});
 assert.deepEqual((await f.engine.preview()).targets.find(x=>x.key===t.key).release_review?.ranges,[all]);
});
test('a "protected" receipt for a target without a platform boat ID is shown as not mapped (review 2026-10-10)',async()=>{
 const f=setup(),plan=await f.engine.machinePlan(),t=plan.targets.find(x=>!x.listing_id);
 assert.ok(t,'the Lightcat and SamBoat gaps give unmapped targets');
 const control=plan.targets.find(x=>x.key===t.key);
 await f.engine.report({mode:'guarded_release',targets:[{key:t.key,state:'protected',checked_at:f.stamp(),segments:t.segments,fleet_hold_revision:control.fleet_hold_control?.revision,blocked:[],retained:[]}]});
 const shown=(await f.engine.preview()).targets.find(x=>x.key===t.key).execution;
 assert.equal(shown.state,'needs_review');assert.equal(shown.error,'mapping_unknown');
});
test('changed order plans preserve unresolved warnings while excluding newly paid dates and tolerating stale receipts',async()=>{
 const f=setup(),t=(await f.engine.machinePlan()).targets.find(t=>t.target==='boataround');
 const send=()=>f.engine.report({mode:'guarded_release',targets:[{key:t.key,state:'removal_requires_verification',checked_at:f.stamp(),segments:[],retained_ranges:[all]}]});
 await send();f.advance();f.mapping.clickandboat.push({booking_id:'123',boataround_slug:t.boat,start:'2027-01-01',end:'2027-01-02',status:'accepted',customer_payment_verified:true,customer_paid_amount:100,verified_at:f.stamp()});
 let result=(await f.engine.preview()).targets.find(r=>r.key===t.key);
 assert.deepEqual(result.release_review.ranges,[range('2027-01-03','2027-01-09')]);
 await send();result=(await f.engine.preview()).targets.find(r=>r.key===t.key);assert.deepEqual(result.release_review.ranges,[range('2027-01-03','2027-01-09')]);
});
test('retained dates survive cloud report, failed refresh, and are cleared only by fresh explicit empty evidence',async()=>{
 const f=setup(),t=(await f.engine.machinePlan()).targets.find(t=>t.target==='boataround');
 const report=fields=>f.engine.report({mode:'guarded_release',targets:[{key:t.key,state:'removal_requires_verification',checked_at:f.stamp(),segments:t.segments,retained:['private-ledger-id'],...fields}]});
 await report({retained_ranges:[{...all,secret:'not public'}]});
 let p=await f.engine.preview();assert.deepEqual(p.targets.find(x=>x.key===t.key).execution.retained_ranges,[all]);assert.ok(!JSON.stringify(p).includes('private-ledger-id'));
 f.advance();await report({state:'needs_review',error:'auth_required'});p=await f.engine.preview();assert.deepEqual(p.targets.find(x=>x.key===t.key).execution.retained_ranges,[all]);
 f.advance();await report({state:'protected',retained:[],retained_ranges:[],boataround_control_revision:t.boataround_control.revision,fleet_hold_revision:t.fleet_hold_control.revision});p=await f.engine.preview();assert.deepEqual(p.targets.find(x=>x.key===t.key).execution.retained_ranges,[]);
});
test('malformed and contradictory release date reports are rejected',async()=>{
 const f=setup(),t=(await f.engine.machinePlan()).targets.find(t=>t.target==='boataround');
 for(const [state,retained_ranges] of [['protected',[all]],['needs_review',[range('2027-02-30','2027-03-02')]],['needs_review',{}]])
  await assert.rejects(f.engine.report({mode:'guarded_release',targets:[{key:t.key,state,segments:t.segments,checked_at:f.stamp(),retained_ranges}]}));
});
test('executor reports actual stale closure date without modifying or claiming a manual closure',async()=>{
 let ledger={version:1,attempts:[{id:'old',target:'boataround:'+FLEET[0].slug,state:'confirmed',...all,causes:['clickandboat:123'],created:{id:'day',...all}}],targets:{}};
 const now=Date.parse('2026-09-14T01:00:00Z'),target={target:'boataround',boat:FLEET[0].slug,listing_id:FLEET[0].slug,fresh:true,segments:[],release_proof:{ready:true,checked_at:new Date(now).toISOString(),orders:[{key:'clickandboat:123',state:'cancelled'}]}};
 let blocks=[{id:'day',...all},{id:'manual',...range('2027-02-01','2027-02-03')}];
 const options={now:()=>now,load:async()=>structuredClone(ledger),save:async l=>ledger=structuredClone(l),plan:async()=>({generated_at:new Date(now).toISOString(),targets:[target]}),adapters:{boataround:{read:async()=>({complete:true,identity_verified:true,blocks}),close:async()=>{}}}};
 await new ReverseExecutor(options).run();assert.deepEqual(ledger.targets['boataround:'+FLEET[0].slug].retained_ranges,[all]);
 blocks=blocks.filter(b=>b.id==='manual');await new ReverseExecutor(options).run();assert.deepEqual(ledger.targets['boataround:'+FLEET[0].slug].retained_ranges,[]);assert.equal(ledger.targets['boataround:'+FLEET[0].slug].state,'protected');
});
