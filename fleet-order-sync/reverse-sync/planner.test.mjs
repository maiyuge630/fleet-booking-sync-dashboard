import test from 'node:test';
import assert from 'node:assert/strict';
import {FLEET} from '../parsers.mjs';
import {buildPlan,segments,uncovered,SOURCE_FRESH_MS} from './planner.mjs';
import {ReverseSync,REVERSE_KEY,RECEIPT_MAX_AGE_MS} from './store.mjs';
const now=Date.parse('2026-09-13T03:00:00Z'),checked=new Date(now).toISOString(),boat=FLEET[3].slug;
const ba={booking_id:'303719',boataround_slug:boat,start:'2026-12-26',end:'2027-01-02',status:'deposit_paid',platform_status:'CONFIRMED',verified_at:checked};
const sb={booking_id:'1502428',boataround_slug:boat,start:'2027-01-01',end:'2027-01-08',status:'deposit_paid',platform_status:'Validated / Deposit Paid',verified_at:checked};
const cb={booking_id:'1250578',boataround_slug:boat,start:'2026-11-07',end:'2026-11-13',status:'accepted',customer_payment_verified:true,customer_paid_amount:100,verified_at:checked};
const data=()=>({boataround:[{...ba}],clickandboat:[{...cb}],samboat:[{...sb}],mmk:[],nausys:[]});
const status=()=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:checked,last_error:null}]))});
const target=(plan,s)=>plan.targets.find(t=>t.boat===boat&&t.target===s);

test('paid NEW and IN PROCESS are protected through checkout; missing payment cannot authorize writes',()=>{
 for(const platform_status of ['NEW','IN PROCESS']){
  const d=data();d.boataround[0]={...ba,platform_status,customer_payment:'PARTIALLY PAID'};
  const p=buildPlan(d,status(),{now});
  assert.ok(p.causes.some(c=>c.key==='boataround:303719'&&c.end==='2027-01-03'));
  assert.equal(target(p,'clickandboat').fresh,true);
  for(const payment of [undefined,'NOT PAID','REFUNDED','PAID']){
   d.boataround[0].customer_payment=payment;
   const invalid=buildPlan(d,status(),{now});
   assert.equal(invalid.causes.some(c=>c.key==='boataround:303719'),false);
   assert.equal(target(invalid,'clickandboat').release_proof.ready,false);
  }
 }
});

test('release evidence requires explicit fresh cancellation, never absence',()=>{
 const d=data();d.boataround[0].status='cancelled';d.boataround[0].platform_status='CANCELLED';
 let proof=target(buildPlan(d,status(),{now}),'clickandboat').release_proof;
 assert.equal(proof.ready,true);assert.ok(proof.orders.some(o=>o.key==='boataround:303719'&&o.state==='cancelled'));
 d.boataround=[];proof=target(buildPlan(d,status(),{now}),'clickandboat').release_proof;
 assert.equal(proof.orders.some(o=>o.key==='boataround:303719'),false);
 const failed=status();failed.platforms.samboat.last_error='expired';
 assert.equal(target(buildPlan(d,failed,{now}),'clickandboat').release_proof.ready,false);
 d.boataround=[{...ba,status:'cancelled',verified_at:'2026-09-12T00:00:00Z'}];
 assert.equal(target(buildPlan(d,status(),{now}),'clickandboat').release_proof.orders.some(o=>o.key==='boataround:303719'),false);
});

test('empty occupancy never treats an unavailable external source as fresh',()=>{
 const d={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]},s=status();s.platforms.boataround.last_error='auth_required';
 const t=target(buildPlan(d,s,{now}),'clickandboat');assert.equal(t.fresh,false);assert.equal(t.release_proof.ready,false);assert.equal(t.source_healthy,false);
});
test('excluded external payment data and contradictory cancellations block fresh completion',()=>{
 const d=data();d.boataround[0].status='cancelled';
 const t=target(buildPlan(d,status(),{now}),'clickandboat');assert.equal(t.fresh,false);assert.equal(t.release_proof.ready,false);assert.equal(t.release_proof.orders.some(o=>o.key==='boataround:303719'),false);
 const e=data();e.clickandboat[0].customer_paid_amount=0;
 assert.equal(target(buildPlan(e,status(),{now}),'boataround').fresh,false);
});
test('AD2 cross-year overlap preserves both causes for two occupied days including checkout',()=>{
  const plan=buildPlan(data(),status(),{now});
  assert.deepEqual(target(plan,'clickandboat').segments,[
    {start:'2026-11-13',end:'2026-11-14',causes:['clickandboat:1250578']},
    {start:'2026-12-26',end:'2027-01-01',causes:['boataround:303719']},
    {start:'2027-01-01',end:'2027-01-03',causes:['boataround:303719','samboat:1502428']},
    {start:'2027-01-03',end:'2027-01-09',causes:['samboat:1502428']}]);
  assert.equal(target(plan,'boataround').segments.filter(s=>s.causes.includes('boataround:303719')).every(s=>s.start==='2027-01-02'&&s.end==='2027-01-03'),true);
});
test('cancellation removes its cause, never the overlapping active cause',()=>{
  const d=data();d.boataround[0].status='cancelled';
  assert.deepEqual(target(buildPlan(d,status(),{now}),'clickandboat').segments,[{start:'2026-11-13',end:'2026-11-14',causes:['clickandboat:1250578']},{start:sb.start,end:'2027-01-09',causes:['samboat:1502428']}]);
});
test('accepted without actual positive customer payment is excluded',()=>{
  for(const amount of [0,-1,NaN,Infinity,'100',undefined]){
    const d=data();d.clickandboat[0].customer_paid_amount=amount;
    assert.equal(buildPlan(d,status(),{now}).excluded[0].reason,'payment_unverified');
  }
});
test('pending and cancelled orders cannot be resurrected by old payment evidence',()=>{
  for(const state of ['pending','cancelled','completed','refused']){
    const d=data();d.clickandboat[0].status=state;
    assert.equal(buildPlan(d,status(),{now}).causes.some(c=>c.source==='clickandboat'),false);
  }
});
test('same-day checkout and check-in do not create an overlap',()=>{
  assert.deepEqual(segments([{key:'a',start:'2027-01-01',end:'2027-01-08'},{key:'b',start:'2027-01-08',end:'2027-01-10'}]),[
    {start:'2027-01-01',end:'2027-01-08',causes:['a']},{start:'2027-01-08',end:'2027-01-10',causes:['b']}]);
});
test('manual reschedule needs both authorized payment and current verification',()=>{
  const d=data(),r=d.clickandboat[0];r.booking_id='1000000';r.start='2027-03-06';r.end='2027-03-13';
  delete r.customer_payment_verified;delete r.customer_paid_amount;
  r.manual_adjustment={kind:'reschedule',verification_status:'verified',payment_evidence:{kind:'owner_settlement',amount:4200}};
  assert.equal(buildPlan(d,status(),{now}).causes.some(c=>c.key==='clickandboat:1000000'),true);
  r.manual_adjustment.verification_status='needs_review';
  assert.equal(buildPlan(d,status(),{now}).excluded[0].reason,'payment_or_adjustment_unverified');
});
test('orders collected up to 20 minutes before still count as fresh (user decision 2026-09-29)',()=>{
  const s=status(),at=age=>{for(const p of Object.values(s.platforms))p.last_success_at=new Date(now-age).toISOString();return target(buildPlan(data(),s,{now}),'clickandboat');};
  assert.equal(SOURCE_FRESH_MS,20*60000);
  assert.equal(at(15*60000).fresh,true);assert.equal(at(15*60000).release_proof.ready,true);
  assert.equal(at(SOURCE_FRESH_MS+1000).fresh,false);assert.equal(at(SOURCE_FRESH_MS+1000).release_proof.ready,false);
});

test('old or failed sources retain desired occupancy but are not fresh for writes',()=>{
  for(const alteration of [{last_error:'auth_required'},{last_success_at:new Date(now-SOURCE_FRESH_MS-100000).toISOString()},{last_success_at:null},{mode:'bootstrap'}]){
    const s=status();Object.assign(s.platforms.boataround,alteration);
    const p=buildPlan(data(),s,{now});assert.equal(target(p,'clickandboat').fresh,false);assert.equal(target(p,'clickandboat').segments.length,4);
  }
});

test('today checkout remains protected for its whole day and has active release evidence',()=>{
 const d=data();d.boataround=[{...ba,start:'2026-09-10',end:'2026-09-13'}];
 const p=buildPlan(d,status(),{now}),t=target(p,'boataround');
 assert.ok(t.segments.some(s=>s.start==='2026-09-13'&&s.end==='2026-09-14'&&s.causes.includes('boataround:303719')));
 assert.ok(t.release_proof.orders.some(o=>o.key==='boataround:303719'&&o.state==='active'&&o.end==='2026-09-14'));
});

test('manual reschedule rejects nonnumeric and nonfinite settlement amounts',()=>{
 for(const amount of ['4200',Infinity,NaN,0,-1]){
  const d=data();d.clickandboat[0].manual_adjustment={kind:'reschedule',verification_status:'verified',payment_evidence:{kind:'owner_settlement',amount}};
  const p=buildPlan(d,status(),{now});assert.ok(p.excluded.some(e=>e.key==='clickandboat:1250578'&&e.reason==='payment_or_adjustment_unverified'));
 }
});
test('missing SamBoat mapping is unknown rather than successful or absent',()=>{
  const p=buildPlan(data(),status(),{now});
  // Four boats are not on SamBoat, plus the Lightcat (eighth boat, only on NauSYS since 2026-10-09).
  assert.equal(p.targets.filter(t=>t.target==='samboat'&&t.status==='mapping_unknown').length,5);
  const lightcat=p.targets.filter(t=>t.boat==='lightcat-400-s2-tidewyn-discovery-6');
  assert.deepEqual(lightcat.map(t=>[t.target,t.listing_id,t.status]),[['boataround',null,'mapping_unknown'],['clickandboat',null,'mapping_unknown'],['samboat',null,'mapping_unknown']]);
});
test('past accepted history without payment metadata does not warn about future bookings',()=>{
 const d=data();d.clickandboat.push({booking_id:'1',boataround_slug:boat,start:'2026-03-01',end:'2026-03-08',status:'accepted'});
 const p=buildPlan(d,status(),{now});assert.deepEqual(p.excluded,[]);assert.equal(p.causes.length,3);
});
test('future-dated source or per-order evidence cannot authorize a write',()=>{
 const d=data(),s=status();d.boataround[0].verified_at=new Date(now+120000).toISOString();
 assert.equal(target(buildPlan(d,s,{now}),'clickandboat').fresh,false);
 d.boataround[0].verified_at=checked;s.platforms.boataround.last_success_at=new Date(now+120000).toISOString();
 assert.equal(target(buildPlan(d,s,{now}),'clickandboat').fresh,false);
});
test('invalid dates excluded and duplicate identities fail closed',()=>{
  const d=data();d.boataround[0].start='2026-02-30';assert.equal(buildPlan(d,status(),{now}).excluded[0].reason,'invalid_dates');
  d.boataround.push({...d.boataround[0]});assert.throws(()=>buildPlan(d,status(),{now}),/duplicate/);
});
test('existing native/manual protection only subtracts uncovered nights',()=>{
  assert.deepEqual(uncovered({start:'2026-12-26',end:'2027-01-08'},[{start:'2026-12-26',end:'2026-12-31'},{start:'2027-01-01',end:'2027-01-09'}]),[{start:'2026-12-31',end:'2027-01-01'}]);
});
class Storage {data=new Map();async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async transaction(fn){return fn(this);}}
test('repeated evidence refresh does not churn semantic revision; cancellation does',async()=>{
  const storage=new Storage(),d=data(),s=status();let clock=now;
  const engine=new ReverseSync({storage,registry:async()=>d,registryStatus:async()=>s,now:()=>clock});
  const first=await engine.preview();clock+=10000;d.boataround[0].verified_at=new Date(clock).toISOString();s.platforms.boataround.last_success_at=d.boataround[0].verified_at;
  assert.equal((await engine.preview()).revision,first.revision);
  d.boataround[0].status='cancelled';assert.equal((await engine.preview()).revision,first.revision+1);
  assert.equal((await storage.get(REVERSE_KEY)).writes_enabled,false);
});
test('corrupt ledger is not overwritten',async()=>{
  const storage=new Storage();await storage.put(REVERSE_KEY,{schema_version:9});
  const engine=new ReverseSync({storage,registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
  await assert.rejects(engine.preview(),/invalid/);assert.equal((await storage.get(REVERSE_KEY)).schema_version,9);
});
test('phone receipts match the current dates; rescheduling hides old positive results',async()=>{
 const storage=new Storage(),d=data(),engine=new ReverseSync({storage,registry:async()=>d,registryStatus:async()=>status(),now:()=>now});
 const plan=await engine.machinePlan(),t=target(plan,'clickandboat');
 await engine.report({mode:'close_only',targets:[{key:t.key,state:'protected',checked_at:checked,segments:t.segments,fleet_hold_revision:t.fleet_hold_control.revision}]});
 assert.equal(target(await engine.preview(),'clickandboat').execution.state,'protected');
 d.boataround[0].end='2027-01-03';assert.equal(target(await engine.preview(),'clickandboat').execution,undefined);
});
test('phone receipts reject unknown targets, duplicate keys and future clock values',async()=>{
 const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const p=await engine.machinePlan(),t=target(p,'clickandboat'),r={key:t.key,state:'protected',checked_at:checked,segments:t.segments,fleet_hold_revision:t.fleet_hold_control.revision};
 for(const targets of [[{...r,key:'unknown'}],[r,r],[{...r,checked_at:new Date(now+120000).toISOString()}]])await assert.rejects(engine.report({mode:'close_only',targets}));
});

test('old or source-failed positive receipts are visibly stale, not evergreen success',async()=>{
 let clock=now;const s=status(),engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>s,now:()=>clock});
 const t=target(await engine.machinePlan(),'clickandboat');
 await engine.report({mode:'guarded_release',targets:[{key:t.key,state:'protected',checked_at:checked,segments:t.segments,fleet_hold_revision:t.fleet_hold_control.revision}]});
 clock+=RECEIPT_MAX_AGE_MS+1;assert.equal(target(await engine.preview(),'clickandboat').execution.state,'stale');
 clock=now;s.platforms.boataround.last_error='expired';assert.equal(target(await engine.preview(),'clickandboat').execution.state,'stale');
});
test('delayed reports cannot erase a newer failure or unrelated target receipt',async()=>{
 const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const p=await engine.machinePlan(),a=target(p,'clickandboat'),b=target(p,'boataround');
 await engine.report({mode:'guarded_release',targets:[{...a,fleet_hold_revision:a.fleet_hold_control.revision,state:'needs_review',checked_at:checked},{...b,fleet_hold_revision:b.fleet_hold_control.revision,state:'protected',checked_at:checked,boataround_control_revision:b.boataround_control.revision}]});
 await engine.report({mode:'close_only',targets:[{...a,fleet_hold_revision:a.fleet_hold_control.revision,state:'protected',checked_at:new Date(now-1000).toISOString()}]});
 const view=await engine.preview();assert.equal(target(view,'clickandboat').execution.state,'needs_review');assert.equal(target(view,'boataround').execution.state,'protected');assert.equal(view.mode,'guarded_release');
});
test('success with outstanding work is rejected; stale inputs cannot create fresh success',async()=>{
 const s=status(),engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>s,now:()=>now});
 const t=target(await engine.machinePlan(),'clickandboat'),receipt={...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:checked};
 await assert.rejects(engine.report({mode:'guarded_release',targets:[{...receipt,retained:['old']}]}),/contradictory/);
 s.platforms.samboat.last_success_at=new Date(now-SOURCE_FRESH_MS-100000).toISOString();await engine.report({mode:'guarded_release',targets:[receipt]});
 assert.equal(target(await engine.preview(),'clickandboat').execution.state,'needs_review');
});

test('malformed outstanding dates cannot disappear into a positive receipt',async()=>{
 const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const t=target(await engine.machinePlan(),'clickandboat');
 for(const blocked of ['bad',[{start:'invalid',end:'invalid'}],[{start:'2026-02-30',end:'2026-03-02'}]])await assert.rejects(engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:checked,blocked}]}));
});
test('conflicting receipts with an identical clock cannot upgrade failure to success',async()=>{
 const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const t=target(await engine.machinePlan(),'clickandboat'),base={...t,fleet_hold_revision:t.fleet_hold_control.revision,checked_at:checked};
 await engine.report({mode:'guarded_release',targets:[{...base,state:'needs_review'}]});await engine.report({mode:'guarded_release',targets:[{...base,state:'protected'}]});
 assert.equal(target(await engine.preview(),'clickandboat').execution.state,'needs_review');
});

test('MMK login failure and known blocked causes survive report and preview as safe codes',async()=>{
 const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const p=await engine.machinePlan(),mmk=target(p,'mmk'),cb=target(p,'clickandboat');
 await engine.report({mode:'guarded_release',targets:[{...mmk,fleet_hold_revision:mmk.fleet_hold_control.revision,state:'needs_review',checked_at:checked,error:'mmk_auth_required'},
  {...cb,fleet_hold_revision:cb.fleet_hold_control.revision,state:'needs_review',checked_at:checked,blocked:[{start:cb.segments[0].start,end:cb.segments[0].end,error:'previous_write_uncertain'}]}]});
 const view=await engine.preview();assert.equal(target(view,'mmk').execution.error,'mmk_auth_required');
 assert.equal(target(view,'clickandboat').execution.error,'previous_write_uncertain');
});

test('unknown error messages including secrets or markup are discarded from durable and public receipts',async()=>{
 const storage=new Storage(),engine=new ReverseSync({storage,registry:async()=>data(),registryStatus:async()=>status(),now:()=>now});
 const t=target(await engine.machinePlan(),'mmk'),raw='<img onerror=alert(1)> token=private-example';
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'needs_review',checked_at:checked,error:raw,blocked:[{start:t.segments[0].start,end:t.segments[0].end,error:raw}]}]});
 assert.equal(target(await engine.preview(),'mmk').execution.error,undefined);
 assert.equal(JSON.stringify([...storage.data.values()]).includes(raw),false);
});

test('cloud plan network failure survives report and clears only after a newer verified success',async()=>{
 let clock=now;const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>clock});
 const t=target(await engine.machinePlan(),'mmk');
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'needs_review',checked_at:checked,error:'reverse_plan_unavailable'}]});
 assert.equal(target(await engine.preview(),'mmk').execution.error,'reverse_plan_unavailable');
 clock+=1000;
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:new Date(clock).toISOString()}]});
 assert.equal(target(await engine.preview(),'mmk').execution.state,'protected');
 assert.equal(target(await engine.preview(),'mmk').execution.error,undefined);
});

test('newer verified success clears prior MMK auth reason, while equal-time success cannot erase it',async()=>{
 let clock=now;const engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>status(),now:()=>clock});
 const t=target(await engine.machinePlan(),'mmk');
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'needs_review',checked_at:checked,error:'mmk_auth_required'}]});
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:checked}]});
 assert.equal(target(await engine.preview(),'mmk').execution.error,'mmk_auth_required');
 clock+=1000;await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:new Date(clock).toISOString(),error:'mmk_auth_required'}]});
 const execution=target(await engine.preview(),'mmk').execution;assert.equal(execution.state,'protected');assert.equal(execution.error,undefined);
});

test('stale successful reverse receipts expose a stable freshness reason instead of an old platform error',async()=>{
 let clock=now;const s=status(),engine=new ReverseSync({storage:new Storage(),registry:async()=>data(),registryStatus:async()=>s,now:()=>clock});
 const t=target(await engine.machinePlan(),'mmk');
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:checked}]});
 clock+=RECEIPT_MAX_AGE_MS+1;assert.equal(target(await engine.preview(),'mmk').execution.error,'receipt_stale');
 clock=now;s.platforms.samboat.last_error='auth_required';assert.equal(target(await engine.preview(),'mmk').execution.error,'source_changed_or_stale');
 s.platforms.samboat.last_error=null;s.platforms.samboat.last_success_at=new Date(now-SOURCE_FRESH_MS-100000).toISOString();
 await engine.report({mode:'guarded_release',targets:[{...t,fleet_hold_revision:t.fleet_hold_control.revision,state:'protected',checked_at:checked}]});
 assert.equal(target(await engine.preview(),'mmk').execution.error,'source_changed_or_stale');
});
