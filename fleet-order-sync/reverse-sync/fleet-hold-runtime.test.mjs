import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {currentTarget,releaseAllowed} from './release.mjs';
import {fleetHoldControl,verifyFleetHoldPlan,retainedReleaseCauses,isFleetHoldIntent} from './fleet-hold-runtime.mjs';
import {segments} from './planner.mjs';
import {MmkAdapter} from './mmk-adapter.mjs';

const now=Date.parse('2026-09-20T09:00:00Z'),stamp=new Date(now).toISOString();
const platforms=['boataround','clickandboat','samboat','mmk'];
const range={start:'2027-08-24',end:'2027-08-26'},second={start:'2027-08-25',end:'2027-08-26'};
const holdId='8ddf004a-a94e-471b-b030-1fa7edaa3613',cause='manual-hold:'+holdId;
const coverage={start:'2026-09-20',end:'2028-01-01'};
function fixture(chosen=platforms){
 let state={version:1,attempts:[],targets:{}},revision=1;
 const hold={id:holdId,...range,active:true},orders=[],rows=Object.fromEntries(chosen.map(p=>[p,[]])),counts=Object.fromEntries(chosen.map(p=>[p,{create:0,remove:0}]));
 const targets=chosen.map(p=>({target:p,boat:'ad2',listing_id:p+'-ad2',fresh:true,segments:[],release_proof:{ready:true,checked_at:stamp,orders:[]},
  ...(p==='boataround'?{boataround_control:{version:1,enabled:true,revision:7,holds:[]}}:{})}));
 function rebuild(){for(const t of targets){
  t.fleet_hold_control={version:1,revision,holds:[structuredClone(hold)]};
  if(t.boataround_control)t.boataround_control.holds=[structuredClone(hold)];
  t.segments=segments([...(hold.active?[{key:cause,...range}]:[]),...orders.filter(o=>o.state==='active')]);
  t.release_proof.orders=[{key:cause,state:hold.active?'active':'cancelled',...range},...structuredClone(orders)];
 }}rebuild();
 const adapters=Object.fromEntries(chosen.map(p=>[p,{...(p==='boataround'?{maxGapDays:1}:{}),
  read:async()=>({identity_verified:true,complete:true,coverage,blocks:structuredClone(rows[p])}),prepare:async()=>{},
  submit:async(_t,gap,_evidence,{guard})=>{await guard({beforeFirstWrite:true});counts[p].create++;
   const created={...gap,id:p==='boataround'?'boat-id:'+gap.start:p+':'+counts[p].create,type:p==='boataround'?3:'owned'};rows[p].push(created);return created;},
  remove:async(_t,owned,{guard})=>{await guard();counts[p].remove++;rows[p]=rows[p].filter(r=>r.id!==owned.id);},close:async()=>{}}]));
 const options={now:()=>now,load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);},
  plan:async()=>({generated_at:stamp,targets:structuredClone(targets)}),adapters};
 return {targets,adapters,options,rows,counts,hold,orders,rebuild,state:()=>state,setState:v=>{state=structuredClone(v);},
  cancel(){hold.active=false;revision++;rebuild();},addRevision(){revision++;rebuild();},run:()=>new ReverseExecutor(options).run()};
}
const report=(f,p)=>f.state().targets[p+':'+p+'-ad2'];

test('one two-day global hold closes all four platforms, cancels same owned records and remains idempotent',async()=>{
 const f=fixture();await f.run();assert.equal(f.state().attempts.length,5);
 assert.ok(f.state().attempts.every(isFleetHoldIntent));
 for(const p of platforms){assert.equal(f.counts[p].create,p==='boataround'?2:1);assert.equal(report(f,p).fleet_hold_revision,1);assert.equal(report(f,p).state,'protected');}
 const original=f.state().attempts.map(a=>a.id);f.cancel();await f.run();
 assert.deepEqual(f.state().attempts.map(a=>a.id),original);assert.ok(f.state().attempts.every(a=>a.state==='released'));
 for(const p of platforms){assert.equal(f.rows[p].length,0);assert.equal(f.counts[p].remove,p==='boataround'?2:1);assert.equal(report(f,p).fleet_hold_revision,2);}
 await f.run();assert.equal(f.state().attempts.length,5);assert.equal(Object.values(f.counts).reduce((n,c)=>n+c.remove,0),5);
});

test('cancelling a hold keeps overlapping paid order protected and exposes unresolved partial opening',async()=>{
 const f=fixture();await f.run();f.orders.push({key:'samboat:paid-order',state:'active',...second});f.rebuild();await f.run();f.cancel();await f.run();
 assert.equal(f.counts.boataround.remove,1);assert.deepEqual(f.rows.boataround.map(r=>({start:r.start,end:r.end})),[second]);
 for(const p of platforms.filter(p=>p!=='boataround')){
  assert.equal(f.counts[p].remove,0);assert.equal(report(f,p).state,'removal_requires_verification');assert.equal(report(f,p).fleet_hold_revision,undefined);
 }
 f.orders.splice(0);f.rebuild();await f.run(); // Missing is not cancellation.
 for(const p of platforms)assert.ok(f.rows[p].length>0);
 f.orders.push({key:'samboat:paid-order',state:'cancelled'});f.rebuild();await f.run();
 assert.ok(platforms.every(p=>f.rows[p].length===0));
});

test('later second manual hold remains a required cause even when it did not need a new write',async()=>{
 const f=fixture(['clickandboat','samboat','mmk']);await f.run();
 const later={id:'a9c498aa-37c5-4440-9c38-1e2b399edbda',...range,active:true},key='manual-hold:'+later.id;
 for(const t of f.targets){t.fleet_hold_control.holds.push(later);t.fleet_hold_control.revision=2;t.segments[0].causes.push(key);t.release_proof.orders.push({key,state:'active',...range});}
 await f.run();assert.ok(f.state().attempts.every(a=>retainedReleaseCauses(a).includes(key)));
 f.cancel();await f.run();assert.ok(Object.values(f.counts).every(c=>c.remove===0));
 for(const t of f.targets)t.release_proof.orders.push({key,state:'cancelled'});
 await f.run();assert.ok(Object.values(f.counts).every(c=>c.remove===1));
});

test('existing manual calendar blocks never acquire ownership from a global hold',async()=>{
 const f=fixture();for(const p of platforms)f.rows[p].push({...range,id:'human:'+p,type:p==='boataround'?3:'manual'});
 await f.run();f.cancel();await f.run();assert.equal(f.state().attempts.length,0);
 for(const p of platforms){assert.deepEqual(f.counts[p],{create:0,remove:0});assert.equal(f.rows[p].length,1);}
});

test('legacy BA day remains un-managed; old stable CB/SB/MMK ownership only gains additional release requirements',async()=>{
 for(const p of platforms){
  const f=fixture([p]),created={...range,id:'old-owned',type:p==='boataround'?3:'owned'};
  f.rows[p].push(created);f.setState({version:1,targets:{},attempts:[{id:'prior',target:p+':'+p+'-ad2',state:'confirmed',...range,created,before:[],causes:['boataround:old']}]});
  f.orders.push({key:'boataround:old',state:'cancelled'});f.rebuild();await f.run();f.cancel();await f.run();
  assert.equal(f.counts[p].create,0);assert.equal(f.counts[p].remove,p==='boataround'?0:1);
  assert.equal(f.state().attempts[0].boataround_managed,undefined);
 }
});

for(const phase of ['source_failed','unmapped','wrong_account','incomplete_calendar','adapter_missing','cleanup_failed'])test('one platform failure never acknowledges fleet revision or suppresses independent targets: '+phase,async()=>{
 const f=fixture(),t=f.targets[1];
 if(phase==='source_failed')t.fresh=false;
 if(phase==='unmapped')t.listing_id=null;
 if(phase==='wrong_account'||phase==='incomplete_calendar')f.adapters.clickandboat.read=async()=>({identity_verified:phase!=='wrong_account',complete:phase!=='incomplete_calendar',blocks:[]});
 if(phase==='adapter_missing')delete f.options.adapters.clickandboat;
 if(phase==='cleanup_failed')f.adapters.clickandboat.close=async()=>{throw Error('cleanup_failed');};
 await f.run();const affected=Object.entries(f.state().targets).find(([key])=>key.startsWith('clickandboat:'))[1];
 assert.equal(affected.fleet_hold_revision,undefined);assert.notEqual(affected.state,'protected');
 assert.equal(report(f,'samboat').fleet_hold_revision,1);assert.equal(report(f,'mmk').fleet_hold_revision,1);
});

for(const phase of ['intent','final_close_guard','release_intent','final_release_guard','no_write_read'])test('control revision or contents changing at asynchronous boundaries cannot be acknowledged: '+phase,async()=>{
 const f=fixture(['samboat']);if(['release_intent','final_release_guard','no_write_read'].includes(phase))await f.run();
 if(phase.startsWith('release')||phase==='final_release_guard')f.cancel();
 if(phase==='intent'||phase==='release_intent'){
  const save=f.options.save;f.options.save=async l=>{await save(l);if(l.attempts.some(a=>a.state===(phase==='intent'?'submitting':'releasing')))f.addRevision();};
 }else if(phase==='final_close_guard')f.adapters.samboat.submit=async(_t,_g,_e,{guard})=>{f.addRevision();await guard({beforeFirstWrite:true});throw Error('unexpected_write');};
 else if(phase==='final_release_guard')f.adapters.samboat.remove=async(_t,_o,{guard})=>{f.targets[0].fleet_hold_control.holds[0].active=true;await guard();throw Error('unexpected_write');};
 else {const read=f.adapters.samboat.read;f.adapters.samboat.read=async()=>{const result=await read();f.addRevision();return result;};}
 await f.run();assert.equal(report(f,'samboat').fleet_hold_revision,undefined);assert.equal(f.counts.samboat.remove,0);
 if(phase==='intent'||phase==='final_close_guard')assert.equal(f.counts.samboat.create,0);
});

test('hold arriving after an in-flight release prevents success ACK and next run restores protection',async()=>{
 const f=fixture(['clickandboat']);await f.run();f.cancel();const remove=f.adapters.clickandboat.remove;
 f.adapters.clickandboat.remove=async(...args)=>{await remove(...args);f.hold.active=true;f.addRevision();};
 await f.run();assert.equal(report(f,'clickandboat').fleet_hold_revision,undefined);assert.equal(f.rows.clickandboat.length,0);
 await f.run();assert.equal(f.counts.clickandboat.create,2);assert.equal(report(f,'clickandboat').fleet_hold_revision,3);
});

test('uncertain created response never acquires ownership; lost DELETE is reconciled without retry',async()=>{
 for(const p of platforms){
  const f=fixture([p]);const submit=f.adapters[p].submit;
  f.adapters[p].submit=async(...args)=>{await submit(...args);throw Error('lost_create_response');};
  await f.run();f.adapters[p].submit=submit;await f.run();f.cancel();await f.run();
  assert.equal(f.counts[p].remove,p==='boataround'?1:0); // BA's separate second day has its own confirmed receipt.
  assert.equal(f.state().attempts[0].state,'observed_protected');assert.ok(f.rows[p].some(r=>r.start===range.start));
  const g=fixture([p]);await g.run();g.cancel();const remove=g.adapters[p].remove;
  g.adapters[p].remove=async(...args)=>{await remove(...args);throw Error('lost_delete_response');};
  await g.run();g.adapters[p].remove=remove;await g.run();
  assert.ok(g.state().attempts.every(a=>a.state==='released'));assert.equal(g.counts[p].remove,p==='boataround'?2:1);
 }
});

test('unknown control shapes, ghost causes and missing active hold segments fail before platform writes',async()=>{
 const variants=[c=>{c.version=2;},c=>{c.revision='1';},c=>{c.revision=-1;},c=>{c.holds.push({...c.holds[0]});},c=>{c.holds[0].active='true';},c=>{c.holds[0].end='2027-02-30';},c=>{c.allowOverride=true;}];
 for(const modify of variants){const f=fixture(['mmk']);modify(f.targets[0].fleet_hold_control);await f.run();assert.equal(f.counts.mmk.create,0);assert.equal(report(f,'mmk').fleet_hold_revision,undefined);}
 for(const kind of ['missing','ghost']){const f=fixture(['mmk']);if(kind==='missing')f.targets[0].segments=[];else f.targets[0].segments[0].causes.push('manual-hold:unknown');await f.run();assert.equal(f.counts.mmk.create,0);assert.equal(report(f,'mmk').error,'fleet_hold_plan_unverified');}
});

test('absence of new control cannot produce new revision ACK; all control fields participate in last guard',async()=>{
 const f=fixture(['samboat']);delete f.targets[0].fleet_hold_control;await f.run();assert.equal(report(f,'samboat').fleet_hold_revision,undefined);
 const t=fixture(['samboat']).targets[0];for(const modify of [c=>{c.revision++;},c=>{c.holds[0].end='2027-08-27';},c=>{c.holds[0].active=false;}]){
  const changed=structuredClone(t);modify(changed.fleet_hold_control);assert.throws(()=>currentTarget({generated_at:stamp,targets:[changed]},t,now),/source_changed_or_stale/);
 }
});

test('historical active holds are not cancellations; segments clip only past dates in Beijing time',()=>{
 const target={target:'mmk',fleet_hold_control:{version:1,revision:3,holds:[{id:'past',start:'2026-01-01',end:'2026-02-01',active:true},{id:'current',start:'2026-09-19',end:'2026-09-21',active:true}]},segments:[{start:'2026-09-20',end:'2026-09-21',causes:['manual-hold:current']}]};
 assert.equal(fleetHoldControl(target).holds.length,2);assert.doesNotThrow(()=>verifyFleetHoldPlan(target,now));
 target.segments=[];assert.throws(()=>verifyFleetHoldPlan(target,now),/fleet_hold_plan_unverified/);
});

test('even a new active proof absent from segments vetoes release before the next cause-tracking pass',async()=>{
 const f=fixture(['samboat']);await f.run();f.cancel();f.targets[0].release_proof.orders.push({key:'samboat:native',state:'active',...second});
 assert.equal(releaseAllowed(f.state().attempts[0],f.targets[0],now),false);await f.run();assert.equal(f.counts.samboat.remove,0);
});

test('removing a global lock releases only redundant owned blocks while separate records protect active obligations',async()=>{
 for(const p of ['clickandboat','samboat','mmk']){
  const f=fixture([p]);await f.run();f.orders.push({key:'samboat:B',state:'active',...second});f.rebuild();
  const manual={id:'independent-protection',...second,type:'manual'};f.rows[p].push(manual);await f.run();f.cancel();
  let reads=0;const read=f.adapters[p].read;f.adapters[p].read=async()=>{reads++;return read();};
  await f.run();assert.equal(f.counts[p].remove,1);assert.deepEqual(f.rows[p],[manual]);assert.equal(report(f,p).fleet_hold_revision,2);
  assert.ok(reads>=5,'both release guards reread independent protection');
 }
});

for(const change of ['independent-disappears','independent-range-changes','owned-changes','proof-disappears'])test('independent protection is rechecked at the final mutation guard: '+change,async()=>{
 const f=fixture(['samboat']);await f.run();f.orders.push({key:'clickandboat:B',state:'active',...second});f.rebuild();
 f.rows.samboat.push({id:'independent-protection',...second,type:'manual'});await f.run();f.cancel();
 const remove=f.adapters.samboat.remove;
 f.adapters.samboat.remove=async(...args)=>{
  if(change==='independent-disappears')f.rows.samboat=f.rows.samboat.filter(r=>r.id!=='independent-protection');
  if(change==='independent-range-changes')f.rows.samboat.find(r=>r.id==='independent-protection').end='2027-08-25';
  if(change==='owned-changes')f.rows.samboat.find(r=>r.id!=='independent-protection').type='human-changed';
  if(change==='proof-disappears')f.targets[0].release_proof.orders=f.targets[0].release_proof.orders.filter(o=>o.key!=='clickandboat:B');
  return remove(...args);
 };
 await f.run();assert.equal(f.counts.samboat.remove,0);assert.equal(f.state().attempts[0].state,'confirmed');assert.equal(report(f,'samboat').fleet_hold_revision,undefined);
});

test('extra coverage cannot replace missing cancellation evidence, and unchanged old records avoid unnecessary metadata writes',async()=>{
 const f=fixture(['clickandboat']);await f.run();assert.equal(f.state().attempts[0].release_causes,undefined);
 f.orders.push({key:'samboat:B',state:'active',...second});f.rebuild();f.rows.clickandboat.push({id:'independent',...second,type:'manual'});await f.run();
 f.cancel();f.targets[0].release_proof.orders=f.targets[0].release_proof.orders.filter(o=>o.key!=='samboat:B');
 await f.run();assert.equal(f.counts.clickandboat.remove,0);assert.equal(report(f,'clickandboat').fleet_hold_revision,undefined);
});

test('invalid or historical global intent never relaxes an active original booking owner',()=>{
 const f=fixture(['clickandboat']),t=f.targets[0],created={id:'owned',...range,type:'owned'};
 t.fleet_hold_control.holds=[];t.segments=[{...second,causes:['source:A']}];t.release_proof.orders=[{key:'source:A',state:'active',...second}];
 const a={id:'old',...range,created,causes:['source:A']},independentBlocks=[{id:'other',...second}];
 assert.equal(releaseAllowed(a,t,now,{independentBlocks}),false);
 a.fleet_hold_intent={version:1,generation:'wrong',revision:1,causes:[cause]};assert.equal(isFleetHoldIntent(a),false);assert.equal(releaseAllowed(a,t,now,{independentBlocks}),false);
});

test('real MMK adapter accepts a global hold as a zero-price Reservation and cancels only its unchanged own record',async()=>{
 const f=fixture(['mmk']),t=f.targets[0];t.boat='seacat-open-40-tidewyn-discovery-2';t.listing_id='1000000000000000002';
 const records=new Map(),events=[];let serial=0;
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};adapter.close=async()=>{};
 adapter.client={
  list:async()=>[...records.values()].map(m=>({id:m.id,status:m.statusId==='5'?'Canceled':'Reservation'})),
  getMany:async ids=>ids.map(id=>structuredClone(records.get(id))),get:async id=>structuredClone(records.get(id)),
  create:async(yachtId,start)=>{const id=String(++serial);records.set(id,{id,yacht:{id:yachtId},statusId:'2',clientId:'-1',guestId:null,paidAmount:0,payments:[],checkInDate:start+' 00:00:00',checkOutDate:range.end+' 00:00:00'});events.push('create-option');return id;},
  available:async()=>true,save:async model=>{events.push('save-status-'+model.statusId);records.set(model.id,structuredClone(model));return structuredClone(model);}
 };
 f.options.adapters.mmk=adapter;await f.run();const model=[...records.values()][0];
 assert.deepEqual(events,['create-option','save-status-1']);assert.equal(model.finalPrice,0);assert.equal(model.basePrice,0);assert.equal(model.priceWithoutTax,0);
 assert.equal(model.paidAmount,0);assert.deepEqual(model.payments,[]);assert.deepEqual(model.invoiceItems,[]);assert.equal(model.freeEntry,true);
 assert.equal(model.internalRemarks,model.bookingOrigin);assert.ok(model.bookingOrigin.endsWith(cause));assert.equal(model.checkInDate,range.start+' 14:00:00');assert.equal(model.checkOutDate,'2027-08-26 10:00:00');
 f.cancel();await f.run();assert.equal(records.get(model.id).statusId,'5');assert.deepEqual(events,['create-option','save-status-1','save-status-5']);
 assert.equal(f.state().attempts[0].state,'released');assert.equal(f.state().targets['mmk:'+t.listing_id].fleet_hold_revision,2);
});
