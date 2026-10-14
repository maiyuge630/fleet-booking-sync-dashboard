import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {FLEET} from '../parsers.mjs';
import {FleetPhoneAgent,PHONE_AGENT_KEY,isPhoneUserPath,isPhoneMachinePath} from '../phone-agent.mjs';
import {ReverseSync,REPORT_KEY,RECEIPT_MAX_AGE_MS} from './store.mjs';
import {BOATAROUND_HOLDS_KEY,AC2_BOAT,mutateHolds} from './boataround-holds.mjs';
import {FLEET_HOLDS_KEY,mutateFleetHolds,readFleetHoldState} from './fleet-holds.mjs';

const now=Date.parse('2026-09-20T06:00:00Z'),origin='https://fixture.invalid',path='/api/reverse-sync/fleet-holds',legacyPath='/api/reverse-sync/boataround-holds',token='u'.repeat(43),boat=FLEET[3].slug;
const add=(revision=0,extra={})=>({action:'add',request_id:crypto.randomUUID(),revision,boat,start:'2027-01-01',end:'2027-01-04',...extra});
const remove=(id,revision)=>({action:'remove',request_id:crypto.randomUUID(),revision,id});
class Storage {
  data=new Map();pending=Promise.resolve();failPut=null;beforeTransaction=null;
  async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async delete(k){this.data.delete(k);}async deleteAlarm(){}
  transaction(work){const run=this.pending.then(async()=>{
    if(this.beforeTransaction){const hook=this.beforeTransaction;this.beforeTransaction=null;await hook();}
    const staged=new Map(structuredClone([...this.data]));
    const tx={get:async k=>structuredClone(staged.get(k)),put:async(k,v)=>{if(k===this.failPut)throw Error('injected durable failure');staged.set(k,structuredClone(v));},delete:async k=>staged.delete(k)};
    const out=await work(tx);this.data=staged;return out;
  });this.pending=run.catch(()=>{});return run;}
}
function setup(){
  const storage=new Storage(),mapping={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]},ingested=[];let clock=now,sourceFailed=false;
  const status=()=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:new Date(clock).toISOString(),last_error:sourceFailed&&s==='samboat'?'auth_required':null}]))});
  const engine=new ReverseSync({storage,registry:async()=>mapping,registryStatus:async()=>status(),now:()=>clock});
  const agent=new FleetPhoneAgent({storage,registry:async()=>mapping,registryStatus:async()=>status(),now:()=>clock,ingest:async p=>{ingested.push(structuredClone(p));return {results:p.snapshots.map(s=>({accepted:true,...s,received_at:new Date(clock).toISOString()}))};}});
  return {storage,engine,agent,mapping,ingested,clock:()=>clock,advance:ms=>clock+=ms,failSource:()=>sourceFailed=true};
}
async function pair(h){await h.storage.put(PHONE_AGENT_KEY,{mode:'phone',enabled:true,token_hash:createHash('sha256').update(token).digest('hex'),state:'idle',requested_run_id:null,manual_run:null});}
function request(route=path,data,extra={}){return new Request(origin+route,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin',...(data!==undefined?{'Content-Type':'application/json'}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});}
const heartbeat=(h,data)=>h.agent.machine(new Request(origin+'/api/agent/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)}));
const upload=(h,id,source)=>h.agent.machine(new Request(origin+'/api/agent/order-sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schema_version:1,requested_run_id:id,snapshots:[{source,run_id:crypto.randomUUID(),checked_at:new Date(h.clock()).toISOString(),outcome:'failure',error_code:'fetch_failed'}]})}));
const selected=plan=>plan.targets.filter(t=>t.boat===boat);
const report=(h,targets,extra={})=>({mode:'guarded_release',targets:targets.map(t=>({key:t.key,state:'protected',checked_at:new Date(h.clock()).toISOString(),segments:t.segments,fleet_hold_revision:t.fleet_hold_control.revision,...(t.target==='boataround'?{boataround_control_revision:t.boataround_control.revision}:{}),...extra}))});
async function save(h,input){const change=mutateFleetHolds(await h.storage.get(FLEET_HOLDS_KEY),input,h.clock());await h.storage.put(FLEET_HOLDS_KEY,change.state);return change.state;}

test('global holds have an independent empty store and a version on every existing target without inventing MMK mappings',async()=>{
  const h=setup(),plan=await h.engine.machinePlan(),view=await h.engine.fleetHolds();
  assert.notEqual(FLEET_HOLDS_KEY,BOATAROUND_HOLDS_KEY);assert.deepEqual(view.holds,[]);assert.equal(view.revision,0);assert.equal(view.enabled,undefined);
  assert.equal(plan.targets.filter(t=>t.target==='mmk').length,3);assert.equal(plan.targets.filter(t=>t.target==='nausys').length,4);assert.equal(selected(plan).length,5);
  for(const t of plan.targets)assert.deepEqual(t.fleet_hold_control,{version:1,revision:0,holds:[]});
});

test('one global hold protects the exact entered dates on all four mapped platforms with independent proofs and no extra checkout day',async()=>{
  const h=setup(),input=add();await save(h,input);const plan=await h.engine.machinePlan(),targets=selected(plan);
  for(const t of targets){
    assert.deepEqual(t.segments,[{start:input.start,end:input.end,causes:['manual-hold:'+input.request_id]}]);assert.equal(t.source_count,0);
    assert.deepEqual(t.fleet_hold_control,{version:1,revision:1,holds:[{id:input.request_id,start:input.start,end:input.end,active:true}]});
    assert.deepEqual(t.release_proof.orders,[{key:'manual-hold:'+input.request_id,state:'active',start:input.start,end:input.end}]);
  }
  for(const a of targets)for(const b of targets)if(a!==b){assert.notEqual(a.release_proof,b.release_proof);assert.notEqual(a.release_proof.orders,b.release_proof.orders);}
  assert.equal((await h.engine.preview()).source_order_count,0);assert.ok(plan.targets.filter(t=>t.boat!==boat).every(t=>t.segments.length===0));
  assert.ok(h.mapping.boataround.length+h.mapping.clickandboat.length+h.mapping.samboat.length+h.mapping.mmk.length+h.mapping.nausys.length===0);
});

test('legacy BA scope stays BA-only; global causes merge there without changing the legacy revision',async()=>{
  const h=setup(),legacy=add(0,{start:'2027-02-01',end:'2027-02-03'}),global=add();
  await h.storage.put(BOATAROUND_HOLDS_KEY,mutateHolds(undefined,legacy,h.clock()).state);await save(h,global);
  let targets=selected(await h.engine.machinePlan()),ba=targets.find(t=>t.target==='boataround');
  assert.equal(ba.boataround_control.revision,1);assert.equal(ba.boataround_control.holds.length,2);
  for(const t of targets.filter(t=>t.target!=='boataround'))assert.ok(!JSON.stringify(t).includes(legacy.request_id));
  await save(h,remove(global.request_id,1));targets=selected(await h.engine.machinePlan());ba=targets.find(t=>t.target==='boataround');
  assert.deepEqual(ba.segments,[{start:legacy.start,end:legacy.end,causes:['manual-hold:'+legacy.request_id]}]);
  for(const t of targets)assert.ok(t.release_proof.orders.some(o=>o.key==='manual-hold:'+global.request_id&&o.state==='cancelled'));
  assert.equal((await h.engine.holds()).revision,1);assert.equal((await h.engine.fleetHolds()).revision,2);
});

test('global hold removal keeps tombstones and a new identity on re-add; missing records are never fabricated as cancellation',async()=>{
  const h=setup(),input=add();await save(h,input);await save(h,remove(input.request_id,1));
  let targets=selected(await h.engine.machinePlan());for(const t of targets){assert.deepEqual(t.segments,[]);assert.deepEqual(t.release_proof.orders,[{key:'manual-hold:'+input.request_id,state:'cancelled'}]);}
  const newer=add(2);await save(h,newer);targets=selected(await h.engine.machinePlan());
  for(const t of targets){assert.equal(t.fleet_hold_control.holds.length,2);assert.ok(t.segments[0].causes.includes('manual-hold:'+newer.request_id));}
  assert.equal((await h.storage.get(FLEET_HOLDS_KEY)).holds[0].active,false);
});

test('global holds preserve paid order causes and freshness; a failed source still blocks all automatic writes',async()=>{
  const h=setup(),input=add();h.mapping.samboat.push({booking_id:'12345',boataround_slug:boat,start:'2027-01-02',end:'2027-01-05',status:'paid',platform_status:'Paid',verified_at:new Date(h.clock()).toISOString()});
  await save(h,input);for(const t of selected(await h.engine.machinePlan())){assert.equal(t.source_count,1);assert.ok(t.segments.some(s=>s.causes.includes('samboat:12345')));}
  assert.equal((await h.engine.preview()).source_order_count,1);h.failSource();
  for(const t of selected(await h.engine.machinePlan())){assert.equal(t.fresh,false);assert.equal(t.release_proof.ready,false);}
});

test('missing target mappings remain visibly missing even when global dates are requested',async()=>{
  const h=setup(),unmappedBoat=FLEET[4].slug;await save(h,add(0,{boat:unmappedBoat}));
  const targets=(await h.engine.machinePlan()).targets.filter(t=>t.boat===unmappedBoat);
  const sb=targets.find(t=>t.target==='samboat');assert.ok(!sb.listing_id);assert.equal(sb.status,'mapping_unknown');assert.equal(sb.segments.length,1);
  assert.equal(targets.some(t=>t.target==='mmk'),false);
});

test('AC2 fixed stop stays non-removable and is not converted into four platform closure tasks',async()=>{
  const h=setup();await pair(h);
  assert.equal((await h.agent.user(request(path,add(0,{boat:AC2_BOAT})))).status,400);
  assert.equal((await h.agent.user(request(path,remove('system-ac2-unavailable-through-2030',0)))).status,409);
  const ts=(await h.engine.machinePlan()).targets.filter(t=>t.boat===AC2_BOAT);assert.ok(ts.every(t=>t.segments.length===0));
  assert.equal(ts.find(t=>t.target==='boataround').boataround_control.enabled,false);assert.ok(ts.every(t=>t.fleet_hold_control.holds.length===0));
});

test('strict date/request validation and durable corruption remain fail-closed in the new scope',()=>{
  for(const changes of [{start:'2027-02-30'},{start:'2026-08-31'},{end:'2028-01-01'},{end:'2027-01-01'},{revision:-1},{request_id:'bad'},{extra:true}])assert.throws(()=>mutateFleetHolds(undefined,add(0,changes),now));
  for(const state of [null,{version:2,revision:0,holds:[],requests:[]},{version:1,revision:0,holds:[{id:'unknown'}],requests:[]}])assert.throws(()=>readFleetHoldState(state),/hold_state_invalid/);
});

test('new operator API requires pairing and same-origin JSON and is never a machine endpoint',async()=>{
  const h=setup();assert.equal(isPhoneUserPath(path),true);assert.equal(isPhoneMachinePath(path),false);
  assert.equal((await h.agent.user(request(path,add()))).status,409);await pair(h);
  for(const headers of [{Origin:'https://foreign.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.ok([403,415].includes((await h.agent.user(request(path,add(),headers))).status));
  const r=request(path,add());r.headers.delete('Origin');assert.equal((await h.agent.user(r)).status,403);
  assert.equal((await h.agent.machine(new Request(origin+path,{headers:{Authorization:'Bearer '+token}}))).status,404);
  assert.equal(await h.storage.get(FLEET_HOLDS_KEY),undefined);
});

test('the real dashboard auth gate protects both global GET and POST; machine credentials never authorize an operator edit',async()=>{
  const h=setup();await pair(h);
  const ctx=vm.createContext({DurableObject:class{},puppeteer:{},FleetCloudSync:class{},FleetPhoneAgent,isPhoneMachinePath,isPhoneUserPath,TextEncoder,TextDecoder,Response,Request,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,console,fetch:()=>{throw Error('No network allowed');}});
  const source=fs.readFileSync(new URL('../integrated-source.mjs',import.meta.url),'utf8');
  vm.runInContext(source.replace(/^import[^\n]+\n/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),ctx);
  const values=new Map(),bucket={get:async k=>values.has(k)?{etag:'fixture',json:async()=>JSON.parse(values.get(k))}:null,put:async(k,v)=>{values.set(k,v);return {etag:'fixture'};},delete:async k=>values.delete(k)};
  const config={username:'fixture@example.invalid',iterations:100000,salt:'11'.repeat(32),pepper:'22'.repeat(32),verifier:'00'.repeat(32)},password='fixture-only-password';
  config.verifier=Buffer.from(await ctx.passwordVerifier(password,config)).toString('hex');
  const env={BUCKET:bucket,FLEET_AUTH_CONFIG:JSON.stringify(config),PHONE_AGENT:h.agent},dispatch=r=>ctx.server_default.fetch(r,env);
  for(const data of [undefined,add()])assert.equal((await dispatch(request(path,data))).status,401);
  assert.equal((await dispatch(request(path,add(),{Authorization:'Bearer '+token}))).status,401);
  const login=await dispatch(new Request(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:config.username,password})}));
  assert.equal(login.status,303);const cookie=login.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await dispatch(request(path,undefined,{Cookie:cookie}))).status,200);
  assert.equal((await dispatch(request(path,add(),{Cookie:cookie,Origin:'https://foreign.invalid'}))).status,403);
  const saved=await dispatch(request(path,add(),{Cookie:cookie}));assert.equal(saved.status,202);assert.equal((await saved.json()).status,'saved_pending_sync');
});

test('global request retries are idempotent and revision conflicts cannot create duplicate holds or run ids',async()=>{
  const h=setup();await pair(h);const input=add(),first=await(await h.agent.user(request(path,input))).json();
  assert.equal(first.status,'saved_pending_sync');assert.equal(first.queue.status,'queued');assert.equal(first.revision,1);
  const retry=await(await h.agent.user(request(path,input))).json();assert.equal(retry.idempotent,true);assert.equal(retry.queue.requested_run_id,first.queue.requested_run_id);
  assert.equal((await h.agent.user(request(path,{...input,end:'2027-01-05'}))).status,409);
  const stale=await h.agent.user(request(path,add()));assert.equal(stale.status,409);assert.equal((await stale.json()).revision,1);
  assert.equal((await h.storage.get(FLEET_HOLDS_KEY)).holds.length,1);assert.equal(await h.storage.get(BOATAROUND_HOLDS_KEY),undefined);
});

test('save and queue rollback together and a retry after durable failure can safely commit',async()=>{
  const h=setup();await pair(h);const input=add();h.storage.failPut=PHONE_AGENT_KEY;
  assert.equal((await h.agent.user(request(path,input))).status,503);assert.equal(await h.storage.get(FLEET_HOLDS_KEY),undefined);assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,null);
  h.storage.failPut=null;assert.equal((await h.agent.user(request(path,input))).status,202);assert.equal((await h.storage.get(FLEET_HOLDS_KEY)).holds.length,1);
});

test('the two scopes cannot create conflicting manual identities, including simultaneous adds',async()=>{
  for(const firstScope of [path,legacyPath]){
    const h=setup();await pair(h);const input=add(),other=firstScope===path?legacyPath:path;
    const replies=await Promise.all([h.agent.user(request(firstScope,input)),h.agent.user(request(other,input))]);
    assert.deepEqual(replies.map(r=>r.status),[202,409]);assert.equal((await replies[1].json()).error,'hold_identity_conflict');
    assert.equal(await h.storage.get(other===path?FLEET_HOLDS_KEY:BOATAROUND_HOLDS_KEY),undefined);
  }
});

test('global edits during legacy/manual work share one followup and wait for ACK plus real late uploads',async()=>{
  const h=setup();await pair(h);const first=await(await h.agent.user(request(legacyPath,add()))).json();
  await heartbeat(h,{requested_run_id:first.queue.requested_run_id,state:'running'});
  const input=add(),next=await(await h.agent.user(request(path,input))).json();assert.equal(next.queue.status,'queued_after_current');
  const cancelled=await(await h.agent.user(request(path,remove(input.request_id,1)))).json();assert.equal(cancelled.queue.requested_run_id,next.queue.requested_run_id);
  for(const source of ['boataround','clickandboat','mmk','nausys'])await upload(h,first.queue.requested_run_id,source);
  await heartbeat(h,{requested_run_id:first.queue.requested_run_id,completed:true,state:'idle'});
  let state=await h.storage.get(PHONE_AGENT_KEY);assert.equal(state.manual_run.state,'awaiting_upload');assert.equal(state.requested_run_id,null);
  await upload(h,first.queue.requested_run_id,'samboat');state=await h.storage.get(PHONE_AGENT_KEY);assert.equal(state.requested_run_id,next.queue.requested_run_id);assert.equal(h.ingested.length,5);
  await heartbeat(h,{requested_run_id:first.queue.requested_run_id,completed:true});assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,next.queue.requested_run_id);
});

test('scheduled work and pairing reset preserve the new scope queue safety',async()=>{
  const h=setup();await pair(h);await heartbeat(h,{state:'running'});const result=await(await h.agent.user(request(path,add()))).json();
  assert.equal(result.queue.status,'queued_after_current');await heartbeat(h,{completed:true,state:'idle'});assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,result.queue.requested_run_id);
  assert.equal((await h.agent.user(request('/api/agent/revoke',{}))).status,200);assert.equal((await h.storage.get(PHONE_AGENT_KEY)).requested_run_id,null);assert.equal((await h.storage.get(FLEET_HOLDS_KEY)).holds.length,1);
});

test('only matching fleet revision can acknowledge each platform; old phone receipts remain unconfirmed',async()=>{
  const h=setup(),targets=selected(await h.engine.machinePlan());
  await h.engine.report(report(h,targets,{fleet_hold_revision:undefined}));for(const t of selected(await h.engine.preview())){assert.equal(t.execution.state,'needs_review');assert.equal(t.execution.fleet_hold_revision,undefined);}
  h.advance(1000);await h.engine.report(report(h,targets));for(const t of selected(await h.engine.preview())){assert.equal(t.execution.state,'protected');assert.equal(t.execution.fleet_hold_revision,0);}
  h.advance(1000);await h.engine.report(report(h,targets.filter(t=>t.target==='samboat'),{state:'needs_review',error:'auth_required'}));
  const p=selected(await h.engine.preview());assert.equal(p.find(t=>t.target==='samboat').execution.fleet_hold_revision,undefined);assert.equal(p.find(t=>t.target==='mmk').execution.state,'protected');
});

test('same final dates after add/remove still invalidate old fleet revisions on all four platforms',async()=>{
  const h=setup(),targets=selected(await h.engine.machinePlan());await h.engine.report(report(h,targets));
  const input=add();await save(h,input);await save(h,remove(input.request_id,1));
  for(const t of selected(await h.engine.preview())){assert.deepEqual(t.segments,[]);assert.equal(t.execution.state,'stale');assert.equal(t.execution.fleet_hold_revision,undefined);}
  h.advance(1000);await h.engine.report(report(h,targets));for(const t of selected(await h.engine.preview()))assert.equal(t.execution.state,'needs_review');
  h.advance(1000);await h.engine.report(report(h,selected(await h.engine.machinePlan())));for(const t of selected(await h.engine.preview()))assert.equal(t.execution.fleet_hold_revision,2);
});

test('a legacy BA edit invalidates BA only and cannot change another platform global-hold receipt',async()=>{
  const h=setup(),input=add();await save(h,input);await h.engine.report(report(h,selected(await h.engine.machinePlan())));
  await h.storage.put(BOATAROUND_HOLDS_KEY,mutateHolds(undefined,add(0,{start:'2027-02-01',end:'2027-02-02'}),h.clock()).state);
  const targets=selected(await h.engine.preview());assert.equal(targets.find(t=>t.target==='boataround').execution,undefined);
  for(const t of targets.filter(t=>t.target!=='boataround'))assert.equal(t.execution.fleet_hold_revision,1);
});

test('invalid/future fleet revisions and commit-time changes cannot forge current completion',async()=>{
  const h=setup(),targets=selected(await h.engine.machinePlan());
  for(const value of [-1,0.5,'0',1])await assert.rejects(h.engine.report(report(h,targets,{fleet_hold_revision:value})),/invalid_reverse_report/);
  h.storage.beforeTransaction=async()=>save(h,add());await h.engine.report(report(h,targets));
  const saved=await h.storage.get(REPORT_KEY);assert.ok(saved.targets.every(t=>t.state==='needs_review'&&t.fleet_hold_revision===undefined&&t.boataround_control_revision===undefined));
});

test('stale source receipts and identical-clock conflicts do not expose a successful fleet revision',async()=>{
  const h=setup(),targets=selected(await h.engine.machinePlan());await h.engine.report(report(h,targets));
  await h.engine.report(report(h,targets,{state:'needs_review'}));let saved=await h.storage.get(REPORT_KEY);assert.ok(saved.targets.every(t=>t.fleet_hold_revision===undefined));
  h.advance(1000);await h.engine.report(report(h,targets));h.advance(RECEIPT_MAX_AGE_MS+1);
  for(const t of selected(await h.engine.preview())){assert.equal(t.execution.state,'stale');assert.equal(t.execution.fleet_hold_revision,undefined);}
});

test('old active holds remain historical evidence but only their future portion is sent for closing',async()=>{
  const h=setup(),input=add();await save(h,input);h.advance(Date.parse('2027-01-02T00:00:00Z')-h.clock());
  for(const t of selected(await h.engine.machinePlan())){assert.equal(t.segments[0].start,'2027-01-02');assert.equal(t.fleet_hold_control.holds[0].start,input.start);}
  h.advance(2*86400000);for(const t of selected(await h.engine.machinePlan())){assert.deepEqual(t.segments,[]);assert.equal(t.release_proof.orders[0].state,'active');}
});
