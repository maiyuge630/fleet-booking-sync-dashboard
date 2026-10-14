import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FLEET} from '../parsers.mjs';
import {FleetPhoneAgent,PHONE_AGENT_KEY,isPhoneUserPath,isPhoneMachinePath} from '../phone-agent.mjs';
import {ReverseSync,REPORT_KEY,RECEIPT_MAX_AGE_MS} from './store.mjs';
import {BOATAROUND_HOLDS_KEY,AC2_BOAT,readHoldState,mutateHolds,holdWindow,applyBoataroundHolds} from './boataround-holds.mjs';
import {buildPlan,SOURCE_FRESH_MS} from './planner.mjs';

const base=Date.parse('2026-09-20T06:00:00Z'),boat=FLEET[3].slug,origin='https://fixture.invalid',path='/api/reverse-sync/boataround-holds',token='t'.repeat(43);
const add=(revision=0,extra={})=>({action:'add',request_id:crypto.randomUUID(),revision,boat,start:'2027-01-01',end:'2027-01-04',...extra});
const remove=(id,revision,extra={})=>({action:'remove',request_id:crypto.randomUUID(),revision,id,...extra});
const blank=()=>({boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]});
const goodStatus=clock=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:new Date(clock).toISOString(),last_error:null}]))});
class Storage {
  data=new Map();pending=Promise.resolve();failPut=null;beforeTransaction=null;
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.data.set(k,structuredClone(v));}
  async delete(k){this.data.delete(k);}
  async deleteAlarm(){}
  transaction(work){const run=this.pending.then(async()=>{
    if(this.beforeTransaction){const fn=this.beforeTransaction;this.beforeTransaction=null;await fn();}
    const staged=new Map(structuredClone([...this.data]));
    const tx={get:async k=>structuredClone(staged.get(k)),put:async(k,v)=>{if(k===this.failPut)throw Error('injected durable failure');staged.set(k,structuredClone(v));},delete:async k=>staged.delete(k)};
    const out=await work(tx);this.data=staged;return out;
  });this.pending=run.catch(()=>{});return run;}
}
function setup(){
  const storage=new Storage(),mapping=blank(),ingested=[];let clock=base,statusFailure=null;
  const status=()=>{const s=goodStatus(clock);if(statusFailure)s.platforms.samboat.last_error=statusFailure;return s;};
  const engine=new ReverseSync({storage,registry:async()=>mapping,registryStatus:async()=>status(),now:()=>clock});
  const agent=new FleetPhoneAgent({storage,registry:async()=>mapping,registryStatus:async()=>status(),ingest:async p=>{
    ingested.push(structuredClone(p));return {results:p.snapshots.map(s=>({source:s.source,accepted:true,outcome:s.outcome,run_id:s.run_id,checked_at:s.checked_at,received_at:new Date(clock).toISOString(),error_code:s.error_code}))};
  },now:()=>clock});
  return {storage,engine,agent,mapping,ingested,clock:()=>clock,advance:ms=>clock+=ms,failSource:()=>statusFailure='auth_required'};
}
async function paired(h){await h.storage.put(PHONE_AGENT_KEY,{mode:'phone',enabled:true,token_hash:createHash('sha256').update(token).digest('hex'),name:'fixture',state:'idle',requested_run_id:null,manual_run:null});}
function request(route=path,data,headers={}){return new Request(origin+route,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin',...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});}
const heartbeat=(h,data)=>h.agent.machine(new Request(origin+'/api/agent/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)}));
const uploadOne=(h,requested_run_id,source)=>h.agent.machine(new Request(origin+'/api/agent/order-sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema_version:1,requested_run_id,snapshots:[{source,run_id:crypto.randomUUID(),checked_at:new Date(h.clock()).toISOString(),outcome:'failure',error_code:'fetch_failed'}]})}));
const target=p=>p.targets.find(t=>t.boat===boat&&t.target==='boataround');
const receipt=(h,t,extra={})=>({mode:'guarded_release',targets:[{key:t.key,state:'protected',checked_at:new Date(h.clock()).toISOString(),segments:t.segments,boataround_control_revision:t.boataround_control.revision,fleet_hold_revision:t.fleet_hold_control.revision,...extra}]});

test('all BA plans have versioned controls; AC2 is an opening veto without four years of new closure segments',async()=>{
  const h=setup(),plan=await h.engine.machinePlan();
  for(const t of plan.targets.filter(t=>t.target==='boataround')){
    assert.equal(t.boataround_control.version,1);assert.equal(t.boataround_control.revision,0);assert.equal(t.source_count,0);
    assert.equal(t.boataround_control.enabled,t.boat!==AC2_BOAT);assert.deepEqual(t.segments,[]);
  }
  const ac2=plan.targets.find(t=>t.target==='boataround'&&t.boat===AC2_BOAT),hold=ac2.boataround_control.holds[0];
  assert.equal(hold.end,'2031-01-01');assert.equal(hold.locked,true);assert.equal(hold.release_only,true);
  assert.ok(ac2.release_proof.orders.some(o=>o.key==='manual-hold:'+hold.id&&o.state==='active'));
  assert.equal((await h.engine.preview()).source_order_count,0);
});

test('active holds combine exact half-open causes only on their BA boat without inventing a paid order',()=>{
  const mapping=blank();mapping.samboat.push({booking_id:'1502428',boataround_slug:boat,start:'2027-01-02',end:'2027-01-04',status:'paid',platform_status:'Paid',verified_at:new Date(base).toISOString()});
  const input=add(),state=mutateHolds(undefined,input,base).state,before=structuredClone(mapping),plan=applyBoataroundHolds(buildPlan(mapping,goodStatus(base),{now:base}),state),t=target(plan);
  assert.deepEqual(t.segments,[{start:'2027-01-01',end:'2027-01-02',causes:['manual-hold:'+input.request_id]},{start:'2027-01-02',end:'2027-01-04',causes:['manual-hold:'+input.request_id,'samboat:1502428']},{start:'2027-01-04',end:'2027-01-05',causes:['samboat:1502428']}]);
  assert.equal(t.source_count,1);assert.equal(plan.causes.length,1);assert.deepEqual(mapping,before);
  assert.ok(t.release_proof.orders.some(o=>o.key==='manual-hold:'+input.request_id&&o.state==='active'&&o.end===input.end));
  assert.ok(plan.targets.filter(x=>x.target!=='boataround').every(x=>!JSON.stringify(x).includes('manual-hold:')));
});

test('the complete cloud engine keeps BA hold proofs out of MMK despite its shared original proof',async()=>{
  const h=setup(),input=add();await h.storage.put(BOATAROUND_HOLDS_KEY,mutateHolds(undefined,input,h.clock()).state);
  const plan=await h.engine.machinePlan(),ba=target(plan),mmk=plan.targets.find(t=>t.boat===boat&&t.target==='mmk');
  assert.ok(ba.release_proof.orders.some(o=>o.key==='manual-hold:'+input.request_id));
  assert.ok(!mmk.release_proof.orders.some(o=>o.key.startsWith('manual-hold:')));assert.deepEqual(mmk.segments,[]);
  assert.ok(plan.targets.filter(t=>t.target!=='boataround').every(t=>!JSON.stringify(t).includes('manual-hold:')));
});

test('remove persists a cancellation tombstone; re-add uses a different identity and revision',()=>{
  const input=add(),first=mutateHolds(undefined,input,base).state,second=mutateHolds(first,remove(input.request_id,1),base).state;
  assert.equal(second.holds[0].active,false);assert.equal(second.holds.length,1);
  const p=applyBoataroundHolds(buildPlan(blank(),goodStatus(base),{now:base}),second);
  assert.deepEqual(target(p).segments,[]);assert.ok(target(p).release_proof.orders.some(o=>o.key==='manual-hold:'+input.request_id&&o.state==='cancelled'));
  const third=mutateHolds(second,add(2),base).state;assert.equal(third.holds.length,2);assert.notEqual(third.holds[0].id,third.holds[1].id);assert.equal(third.revision,3);
});

test('hold evidence never makes failed or stale platform sources eligible for automatic writes',()=>{
  const state=mutateHolds(undefined,add(),base).state;
  for(const change of [{last_error:'auth_required'},{last_success_at:new Date(base-SOURCE_FRESH_MS-100000).toISOString()}]){
    const status=goodStatus(base);Object.assign(status.platforms.samboat,change);
    const t=target(applyBoataroundHolds(buildPlan(blank(),status,{now:base}),state));
    assert.equal(t.fresh,false);assert.equal(t.release_proof.ready,false);assert.equal(t.segments.length,1);
  }
});

test('bounded date window uses Beijing and handles month-end without date rollover',()=>{
  assert.deepEqual(holdWindow(Date.parse('2026-09-20T17:00:00Z')),{window_start:'2026-09-21',window_end:'2027-12-21'});
  assert.equal(holdWindow(Date.parse('2026-11-30T00:00:00Z')).window_end,'2028-02-29');
  const w=holdWindow(base);
  assert.doesNotThrow(()=>mutateHolds(undefined,add(0,{start:w.window_start,end:'2026-09-21'}),base));
  for(const dates of [{start:'2026-09-19',end:'2026-09-21'},{start:'2027-12-19',end:'2027-12-21'},{start:'2026-09-20',end:'2027-09-21'}])assert.throws(()=>mutateHolds(undefined,add(0,dates),base),/hold_outside_window/);
  for(const dates of [{start:'2027-02-30'},{end:'2027-01-01'},{start:'2027-01-05'},{start:'2027-01-01T00:00:00Z'}])assert.throws(()=>mutateHolds(undefined,add(0,dates),base),/hold_invalid_dates/);
});

test('strict mutation schema, permanent AC2 veto, and durable corruption all fail closed',()=>{
  for(const extra of [{boat:'invented'},{revision:-1},{revision:0.5},{request_id:'bad'},{extra:true},{action:'toggle'}])assert.throws(()=>mutateHolds(undefined,add(0,extra),base));
  assert.throws(()=>mutateHolds(undefined,add(0,{boat:AC2_BOAT}),base),/boat_manually_disabled/);
  assert.throws(()=>mutateHolds(undefined,remove('system-ac2-unavailable-through-2030',0),base),/hold_locked/);
  const state=mutateHolds(undefined,add(),base).state;
  for(const value of [null,{...state,version:9},{...state,revision:NaN},{...state,holds:[...state.holds,...state.holds]},{...state,holds:[{...state.holds[0],release_only:true}]}])assert.throws(()=>readHoldState(value),/hold_state_invalid/);
});

test('request retry is durable/idempotent; changed payload or old revision cannot overwrite another hold',()=>{
  const input=add(),one=mutateHolds(undefined,input,base),retry=mutateHolds(one.state,input,base+86400000);
  assert.equal(retry.idempotent,true);assert.equal(retry.changed,false);assert.deepEqual(retry.state,one.state);
  assert.throws(()=>mutateHolds(one.state,{...input,end:'2027-01-05'},base),/hold_request_conflict/);
  assert.throws(()=>mutateHolds(one.state,add(),base),e=>e.status===409&&e.revision===1);
  const same=mutateHolds(one.state,add(1),base);assert.equal(same.changed,false);assert.equal(same.state.holds.length,1);assert.equal(same.state.revision,1);
});

test('operator route is not a machine path; pairing, same-origin, and JSON are required to mutate',async()=>{
  const h=setup();assert.equal(isPhoneUserPath(path),true);assert.equal(isPhoneMachinePath(path),false);
  assert.equal((await h.agent.user(request(path,add()))).status,409);
  await paired(h);
  for(const headers of [{Origin:'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.ok([403,415].includes((await h.agent.user(request(path,add(),headers))).status));
  const missingOrigin=request(path,add());missingOrigin.headers.delete('Origin');assert.equal((await h.agent.user(missingOrigin)).status,403);
  assert.equal((await h.agent.machine(new Request(origin+path,{headers:{Authorization:'Bearer '+token}}))).status,404);
  assert.equal(await h.storage.get(BOATAROUND_HOLDS_KEY),undefined);
  const publicData=await(await h.agent.user(request())).json();assert.equal(publicData.revision,0);assert.ok(!JSON.stringify(publicData).includes('token'));
});

test('atomic durable hold save queues one real run; retry cannot create duplicate holds or run ids',async()=>{
  const h=setup();await paired(h);const input=add();
  let r=await h.agent.user(request(path,input));assert.equal(r.status,202);const first=await r.json();
  assert.equal(first.status,'saved_pending_sync');assert.equal(first.revision,1);assert.equal(first.queue.status,'queued');
  r=await h.agent.user(request(path,input));const retry=await r.json();assert.equal(retry.idempotent,true);assert.equal(retry.queue.requested_run_id,first.queue.requested_run_id);
  const s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.manual_run.state,'queued');assert.equal((await h.storage.get(BOATAROUND_HOLDS_KEY)).holds.length,1);
});

test('durable save failure rolls back both hold and queue, and the same request can safely retry',async()=>{
  const h=setup();await paired(h);const input=add();h.storage.failPut=PHONE_AGENT_KEY;
  assert.equal((await h.agent.user(request(path,input))).status,503);assert.equal(await h.storage.get(BOATAROUND_HOLDS_KEY),undefined);assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,null);
  h.storage.failPut=null;assert.equal((await h.agent.user(request(path,input))).status,202);assert.equal((await h.storage.get(BOATAROUND_HOLDS_KEY)).holds.length,1);
});

test('simultaneous operators cannot silently overwrite revisions',async()=>{
  const h=setup();await paired(h);
  const replies=await Promise.all([h.agent.user(request(path,add())),h.agent.user(request(path,add(0,{start:'2027-02-01',end:'2027-02-02'})))]);
  assert.deepEqual(replies.map(r=>r.status),[202,409]);assert.deepEqual(await replies[1].json(),{error:'hold_revision_conflict',revision:1});assert.equal((await h.storage.get(BOATAROUND_HOLDS_KEY)).holds.length,1);
});

test('hold changes during a manual run queue a following id; old ACK cannot clear that following run',async()=>{
  const h=setup();await paired(h);const first=await(await h.agent.user(request('/api/agent/run',{}))).json();
  assert.equal((await heartbeat(h,{requested_run_id:first.requested_run_id,state:'running'})).status,200);
  const added=await(await h.agent.user(request(path,add()))).json();
  assert.equal(added.queue.status,'queued_after_current');assert.notEqual(added.queue.requested_run_id,first.requested_run_id);
  let s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.requested_run_id,first.requested_run_id);assert.equal(s.manual_run.id,first.requested_run_id);
  const removed=await(await h.agent.user(request(path,remove(added.holds.find(x=>!x.locked).id,1)))).json();assert.equal(removed.queue.requested_run_id,added.queue.requested_run_id);
  for(const source of ['boataround','clickandboat','samboat','mmk','nausys'])assert.equal((await uploadOne(h,first.requested_run_id,source)).status,200);
  assert.equal((await heartbeat(h,{requested_run_id:first.requested_run_id,state:'idle',completed:true})).status,200);
  s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.requested_run_id,added.queue.requested_run_id);assert.equal(s.manual_run.state,'queued');assert.equal(s.followup_run,undefined);
  await heartbeat(h,{requested_run_id:first.requested_run_id,state:'idle',completed:true});assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,added.queue.requested_run_id);
});

test('completion ACK before the final upload preserves awaiting_upload and advances followup only after real late receipt',async()=>{
  const h=setup();await paired(h);const first=await(await h.agent.user(request('/api/agent/run',{}))).json();
  await heartbeat(h,{requested_run_id:first.requested_run_id,state:'running'});
  const input=add(),saved=await(await h.agent.user(request(path,input))).json();
  for(const source of ['boataround','clickandboat','mmk','nausys'])await uploadOne(h,first.requested_run_id,source);
  await heartbeat(h,{requested_run_id:first.requested_run_id,state:'idle',completed:true});
  let s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.requested_run_id,null);assert.equal(s.manual_run.id,first.requested_run_id);assert.equal(s.manual_run.state,'awaiting_upload');assert.equal(s.followup_run.id,saved.queue.requested_run_id);
  const retried=await(await h.agent.user(request(path,input))).json();assert.equal(retried.queue.requested_run_id,saved.queue.requested_run_id);assert.equal(retried.idempotent,true);
  await heartbeat(h,{requested_run_id:first.requested_run_id,state:'running'});s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.manual_run.state,'awaiting_upload');
  await uploadOne(h,first.requested_run_id,'samboat');s=await h.storage.get(PHONE_AGENT_KEY);
  assert.equal(h.ingested.length,5);assert.equal(s.requested_run_id,saved.queue.requested_run_id);assert.equal(s.manual_run.state,'queued');assert.equal(s.followup_run,undefined);
  await heartbeat(h,{requested_run_id:first.requested_run_id,completed:true,state:'idle'});assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,saved.queue.requested_run_id);
});

test('revoke and re-pair reservation discard old followup ids but preserve explicit holds',async()=>{
  for(const action of ['revoke','pairing-code']){
    const h=setup();await paired(h);const first=await(await h.agent.user(request('/api/agent/run',{}))).json();
    await heartbeat(h,{requested_run_id:first.requested_run_id,state:'running'});await h.agent.user(request(path,add()));
    assert.ok((await h.storage.get(PHONE_AGENT_KEY)).followup_run);
    assert.equal((await h.agent.user(request('/api/agent/'+action,{}))).status,200);
    const s=await h.storage.get(PHONE_AGENT_KEY);assert.equal(s.followup_run,undefined);assert.equal(s.requested_run_id,null);assert.equal(s.manual_run,null);
    assert.equal((await h.storage.get(BOATAROUND_HOLDS_KEY)).holds.length,1);
    assert.equal((await heartbeat(h,{requested_run_id:first.requested_run_id,completed:true})).status,401);
  }
});

test('a saved past hold stays in ownership history without repeatedly creating past calendar days',()=>{
  const input=add(),state=mutateHolds(undefined,input,base).state;
  for(const [now,expected] of [['2027-01-02T01:00:00Z',[{start:'2027-01-02',end:input.end,causes:['manual-hold:'+input.request_id]}]],['2027-01-04T01:00:00Z',[]]]){
    const t=target(applyBoataroundHolds(buildPlan(blank(),goodStatus(Date.parse(now)),{now:Date.parse(now)}),state));
    assert.deepEqual(t.segments,expected);assert.equal(t.boataround_control.holds[0].start,input.start);assert.ok(t.release_proof.orders.some(o=>o.key==='manual-hold:'+input.request_id&&o.state==='active'));
  }
});

test('a busy scheduled run keeps running while the hold requests a following manual sync',async()=>{
  const h=setup();await paired(h);await heartbeat(h,{state:'running'});
  const r=await(await h.agent.user(request(path,add()))).json();assert.equal(r.queue.status,'queued_after_current');
  await heartbeat(h,{completed:true,state:'idle'});assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,r.queue.requested_run_id);
});

test('only fresh protected readback of the current control revision can show a hold as applied',async()=>{
  const h=setup(),t=target(await h.engine.machinePlan());
  await h.engine.report(receipt(h,t,{boataround_control_revision:undefined}));assert.notEqual(target(await h.engine.preview()).execution.state,'protected');
  h.advance(1000);await h.engine.report(receipt(h,t));let p=target(await h.engine.preview());assert.equal(p.execution.state,'protected');assert.equal(p.execution.boataround_control_revision,0);
  h.advance(1000);await h.engine.report(receipt(h,t,{state:'needs_review',error:'auth_required'}));p=target(await h.engine.preview());assert.equal(p.execution.boataround_control_revision,undefined);
  h.advance(1000);await h.engine.report(receipt(h,t));h.advance(RECEIPT_MAX_AGE_MS+1);p=target(await h.engine.preview());assert.equal(p.execution.state,'stale');assert.equal(p.execution.boataround_control_revision,undefined);
});

test('hold add/remove changes revision even when final dates match an old receipt; it cannot revive old green status',async()=>{
  const h=setup(),t=target(await h.engine.machinePlan());await h.engine.report(receipt(h,t));
  const input=add(),one=mutateHolds(undefined,input,h.clock()).state,two=mutateHolds(one,remove(input.request_id,1),h.clock()).state;
  await h.storage.put(BOATAROUND_HOLDS_KEY,two);let p=target(await h.engine.preview());assert.deepEqual(p.segments,t.segments);assert.equal(p.execution.state,'stale');assert.equal(p.execution.boataround_control_revision,undefined);
  h.advance(1000);await h.engine.report(receipt(h,t));p=target(await h.engine.preview());assert.equal(p.execution.state,'needs_review');
  h.advance(1000);await h.engine.report(receipt(h,target(await h.engine.machinePlan())));p=target(await h.engine.preview());assert.equal(p.execution.boataround_control_revision,2);
});

test('malformed/future control revisions are rejected and non-BA targets cannot claim one',async()=>{
  const h=setup(),plan=await h.engine.machinePlan(),t=target(plan);
  for(const rev of [-1,0.5,'0',1])await assert.rejects(h.engine.report(receipt(h,t,{boataround_control_revision:rev})),/invalid_reverse_report/);
  const other=plan.targets.find(x=>x.target==='clickandboat');await assert.rejects(h.engine.report({mode:'guarded_release',targets:[{key:other.key,state:'protected',checked_at:new Date(h.clock()).toISOString(),segments:other.segments,boataround_control_revision:0}]}),/invalid_reverse_report/);
});

test('a concurrent hold edit at receipt commit invalidates the previously prepared version',async()=>{
  const h=setup(),t=target(await h.engine.machinePlan());
  h.storage.beforeTransaction=async()=>h.storage.put(BOATAROUND_HOLDS_KEY,mutateHolds(undefined,add(),h.clock()).state);
  await h.engine.report(receipt(h,t));const saved=await h.storage.get(REPORT_KEY);assert.equal(saved.targets[0].state,'needs_review');assert.equal(saved.targets[0].boataround_control_revision,undefined);
});

test('legacy empty opening reports cannot clear an unresolved warning after control activation',async()=>{
  const h=setup(),t=target(await h.engine.machinePlan()),range={start:'2027-01-01',end:'2027-01-04'};
  await h.engine.report(receipt(h,t,{state:'removal_requires_verification',retained_ranges:[range]}));h.advance(1000);
  await h.engine.report(receipt(h,t,{boataround_control_revision:undefined,retained_ranges:[]}));
  const saved=await h.storage.get(REPORT_KEY);assert.deepEqual(saved.targets[0].retained_ranges,[range]);
});
