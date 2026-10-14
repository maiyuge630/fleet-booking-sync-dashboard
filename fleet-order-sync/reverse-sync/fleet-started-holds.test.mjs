import test from 'node:test';
import assert from 'node:assert/strict';
import {mutateFleetHolds,publicFleetHolds,applyFleetHolds} from './fleet-holds.mjs';
import {mutateHolds,holdWindow} from './boataround-holds.mjs';
import {buildPlan} from './planner.mjs';
import {applyBoataroundHolds} from './boataround-holds.mjs';
const now=Date.parse('2026-09-24T07:00:00Z'),boat='bluecat-42-tidewyn-discovery-3';
const request=()=>({action:'add',revision:0,request_id:crypto.randomUUID(),boat,start:'2026-09-23',end:'2027-01-23'});
test('ongoing AD3 stop retains September 23 and excludes January 23 while legacy BA remains future-only',()=>{
 const input=request(),state=mutateFleetHolds(undefined,input,now).state;
 assert.deepEqual(state.holds,[{id:input.request_id,boat,start:'2026-09-23',end:'2027-01-23',active:true}]);
 assert.equal(publicFleetHolds(state,now).window_start,'2026-09-01');
 assert.equal(publicFleetHolds(state,now).window_end,holdWindow(now).window_end);
 assert.throws(()=>mutateHolds(undefined,input,now),/hold_outside_window/);
});
test('only ongoing current-month backdating is accepted, with Beijing boundary and original range limits',()=>{
 for(const changes of [{start:'2026-08-31'},{start:'2026-09-01',end:'2026-09-24'},{start:'2026-09-23',end:'2026-09-23'},{start:'2026-09-23',end:'2027-09-24'}])
  assert.throws(()=>mutateFleetHolds(undefined,{...request(),...changes},now));
 const boundary=Date.parse('2026-09-30T16:00:00Z');
 assert.equal(publicFleetHolds({revision:0,holds:[]},boundary).window_start,'2026-10-01');
 assert.throws(()=>mutateFleetHolds(undefined,request(),boundary),/hold_outside_window/);
 const input=request(),state=mutateFleetHolds(undefined,input,now).state;
 assert.equal(mutateFleetHolds(state,input,Date.parse('2027-02-01T00:00:00Z')).idempotent,true);
});
test('started stop clips only phone execution to today and cannot broaden other boats or invent platform mappings',()=>{
 const input=request(),state=mutateFleetHolds(undefined,input,now).state;
 const mapping={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]};
 const status={platforms:Object.fromEntries(Object.keys(mapping).map(s=>[s,{mode:'dynamic',last_success_at:new Date(now).toISOString(),last_error:null}]))};
 const plan=applyFleetHolds(applyBoataroundHolds(buildPlan(mapping,status,{now}),undefined),state);
 for(const target of plan.targets.filter(t=>t.boat===boat)){
  assert.deepEqual(target.segments,[{start:'2026-09-24',end:'2027-01-23',causes:['manual-hold:'+input.request_id]}]);
  assert.equal(target.fleet_hold_control.holds[0].start,'2026-09-23');
 }
 assert.ok(plan.targets.filter(t=>t.boat!==boat).every(t=>t.segments.length===0));
 const sb=plan.targets.find(t=>t.boat===boat&&t.target==='samboat');
 assert.equal(sb.status,'mapping_unknown');assert.ok(!sb.listing_id);
});
