import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from '../phone-agent.mjs';
import {FLEET} from '../parsers.mjs';

const require=createRequire(import.meta.url);
const {createOrderRegistry,ORDER_SYNC_PREFIX}=require('./dynamic-registry.cjs');
const SOURCES=['boataround','clickandboat','samboat','mmk','nausys'];
const BASE=Date.parse('2026-09-10T08:00:00Z');
const ORIGIN='https://sequence-fixture.invalid',TOKEN='q'.repeat(43);
const clone=value=>structuredClone(value),iso=value=>new Date(value).toISOString();
const slugs=FLEET.map(boat=>boat.slug);
function seeded(seed){let state=seed>>>0;return ()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);}
function shuffle(values,random){const out=[...values];for(let i=out.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;}

class MemoryStorage {
  values=new Map();pending=Promise.resolve();failPut=null;
  async get(key){return clone(this.values.get(key));}
  async put(key,value){if(this.failPut?.(key,value))throw Error('injected storage write failure');this.values.set(key,clone(value));}
  async deleteAlarm(){}
  transaction(work){const result=this.pending.then(()=>work(this));this.pending=result.catch(()=>{});return result;}
}
function memoryBucket(seed){
  const random=seeded(seed),values=new Map();let revision=0;
  const tick=async()=>{for(let i=0,n=Math.floor(random()*3);i<n;i++)await Promise.resolve();};
  return {
    beforeCommit:0,afterCommit:0,conflicts:0,failureStatus:null,writeGate:null,
    holdNextUpdates(count){let release;const promise=new Promise(resolve=>{release=resolve;});this.writeGate={remaining:count,promise,release};},
    async get(key){await tick();const entry=values.get(key);return entry?{etag:entry.etag,json:async()=>JSON.parse(entry.body)}:null;},
    async put(key,body,{onlyIf}={}){
      await tick();
      if(onlyIf&&!(onlyIf instanceof Headers)&&this.writeGate){const gate=this.writeGate;if(--gate.remaining===0){this.writeGate=null;gate.release();}await gate.promise;}
      const old=values.get(key);
      if(onlyIf instanceof Headers&&onlyIf.get('If-None-Match')==='*'&&old)return null;
      if(onlyIf&&!(onlyIf instanceof Headers)&&onlyIf.etagMatches!==old?.etag){this.conflicts++;return null;}
      const update=onlyIf&&!(onlyIf instanceof Headers);
      if(update&&this.beforeCommit>0){this.beforeCommit--;throw Object.assign(Error('injected failure before commit'),this.failureStatus?{status:this.failureStatus}:{});}
      const etag=String(++revision);values.set(key,{body,etag});
      if(update&&this.afterCommit>0){this.afterCommit--;throw Object.assign(Error('injected lost response after commit'),this.failureStatus?{status:this.failureStatus}:{});}
      return {etag};
    },
    async state(source){return JSON.parse(values.get(ORDER_SYNC_PREFIX+source+'.json').body);},
  };
}
function record(source,status='cancelled',id='99000071'){
  const result={booking_id:id,boat:slugs[0],boataround_slug:slugs[0],status,
    start:'2026-10-17',end:'2026-10-24',url:'https://sequence-fixture.invalid/order/'+id};
  if(status==='cancelled')return {...result,platform_status:'Cancelled'};
  if(source==='boataround')return {...result,status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID'};
  if(source==='clickandboat')return {...result,status:'accepted',platform_status:'Accepted',customer_payment_verified:true,customer_paid_amount:10};
  if(source==='mmk')return {...result,status:'accepted',platform_status:'Reservation',payment_basis:'mmk_client_assigned'};
  if(source==='nausys')return {...result,status:'accepted',platform_status:'Reservation',payment_basis:'nausys_agency'};
  return {...result,status:'deposit_paid',platform_status:'Deposit paid'};
}
function success(source,time,tag,status='cancelled'){
  const orders=[record(source,status)];
  return {source,run_id:tag,checked_at:iso(time),complete:true,expected_count:orders.length,orders,
    scope:{kind:'current_future',from_day:'2026-09-10',fleet_slugs:slugs},
    pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length}};
}
const failure=(source,time,tag)=>({source,run_id:tag,checked_at:iso(time),outcome:'failure',error_code:'fetch_failed'});
function harness(seed=1){
  let clock=BASE;const storage=new MemoryStorage(),bucket=memoryBucket(seed);
  const makeRegistry=()=>createOrderRegistry({bucket,now:()=>clock,normalizeBooking:(source,value)=>({...value,source}),
    fleetSpecs:FLEET.map(boat=>({...boat,boataround_slug:boat.slug})),bootstrapMap:{boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[],mapping_updated_at:iso(BASE-3600000)}});
  let registry=makeRegistry(),worker;
  const restart=()=>{registry=makeRegistry();worker=new FleetPhoneAgent({storage,ingest:payload=>registry.ingestBatch(payload),registryStatus:()=>registry.status(),now:()=>clock});};
  restart();
  const request=(path,body,user=false)=>new Request(ORIGIN+'/api/agent/'+path,{
    method:body===undefined?'GET':'POST',headers:{...(user?{Origin:ORIGIN,'Sec-Fetch-Site':'same-origin'}:{Authorization:'Bearer '+TOKEN}),...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const user=async(path,body)=>{const response=await worker.user(request(path,body,true));assert.ok(response.ok);return response.json();};
  const machine=async(path,body)=>{const response=await worker.machine(request(path,body));return {status:response.status,body:await response.json()};};
  const pair=async()=>{const code=await user('pairing-code',{});assert.equal((await machine('pair',{pairing_code:code.pairing_code,name:'Seeded offline fixture'})).status,200);};
  const upload=(id,snapshot)=>machine('order-sync',{schema_version:1,...(id?{requested_run_id:id}:{}),snapshots:[snapshot]});
  return {storage,bucket,makeRegistry,restart,user,machine,pair,upload,setNow:value=>{clock=value;},get registry(){return registry;},get worker(){return worker;}};
}

test('fixed seeded replay/restart/CAS sequences cannot restore a cancellation even after a lost commit response',async()=>{
  for(const seed of [0x1234,0x7715,0xfeed]){
    const h=harness(seed),random=seeded(seed);h.setNow(BASE+3600000);
    // Exercise replay/CAS independently of the separately reproduced bug that
    // misclassifies generic storage errors as permanent validation failures.
    h.bucket.failureStatus=503;
    await h.registry.status();
    for(const source of SOURCES)assert.equal((await h.registry.ingestSnapshot(success(source,BASE,source+'-paid','paid'))).accepted,true);
    // The first cancellation commits but loses its response. Retrying after a
    // fresh registry instance must recover the exact persisted cancellation.
    h.bucket.afterCommit=1;
    const cancellations=SOURCES.map(source=>success(source,BASE+1000,source+'-cancel'));
    const first=await h.registry.ingestBatch({schema_version:1,snapshots:cancellations});
    assert.ok(first.results.some(result=>result.status===503));
    h.restart();
    const retry=await h.registry.ingestBatch({schema_version:1,snapshots:cancellations});
    assert.ok(retry.results.every(result=>result.accepted));
    const priorWatermark=Object.fromEntries(SOURCES.map(source=>[source,iso(BASE+1000)]));
    for(let round=0;round<12;round++){
      const source=SOURCES[Math.floor(random()*SOURCES.length)],freshTime=BASE+2000+round*1000;
      const inputs=shuffle([
        success(source,BASE,source+'-paid','paid'),
        success(source,BASE+500,source+'-old-'+round,'paid'),
        success(source,freshTime,source+'-newcancel-'+round),
        failure(source,freshTime+1,source+'-failure-'+round),
      ],random);
      if(round%4===0)h.bucket.beforeCommit=1;
      h.bucket.holdNextUpdates(2);
      const receipts=await Promise.all(inputs.map(snapshot=>h.makeRegistry().ingestBatch({schema_version:1,snapshots:[snapshot]})));
      for(let index=0;index<receipts.length;index++)if(receipts[index].results.some(result=>[409,503].includes(result.status)))await h.registry.ingestBatch({schema_version:1,snapshots:[inputs[index]]});
      if(round%3===0)h.restart();
      const map=await h.registry.registry();
      for(const platform of SOURCES){
        assert.equal(map[platform].find(item=>item.booking_id==='99000071').status,'cancelled',`seed ${seed}, round ${round}, ${platform}`);
        const state=await h.bucket.state(platform);
        assert.ok(state.last_checked_at>=priorWatermark[platform]);
        priorWatermark[platform]=state.last_checked_at;
      }
      assert.equal(map.samboat.find(item=>item.booking_id==='1000001').status,'cancelled');
    }
    assert.ok(h.bucket.conflicts>0,'seed must actually exercise a rejected stale etag');
  }
});

test('seeded old-request outbox, source commits, completion ACK and lost manual metadata recover as the new request only',async()=>{
  for(const seed of [0x111,0x222,0x333,0x444]){
    const h=harness(seed);await h.pair();const old=await h.user('run',{});
    await h.machine('heartbeat',{requested_run_id:old.requested_run_id,completed:true,state:'idle'});
    h.setNow(BASE+10000);const current=await h.user('run',{});h.setNow(BASE+20000);
    const stale=SOURCES.map(source=>success(source,BASE+1000,'old-'+source,'paid'));
    const fresh=SOURCES.map(source=>source==='clickandboat'?failure(source,BASE+20000,'new-'+source):success(source,BASE+20000,'new-'+source));
    let failed=false;
    h.storage.failPut=(key,value)=>{if(!failed&&key===PHONE_AGENT_KEY&&Object.keys(value.manual_run?.results||{}).length){failed=true;return true;}return false;};
    const operations=[...stale.map(snapshot=>()=>h.upload(old.requested_run_id,snapshot)),...fresh.map(snapshot=>()=>h.upload(current.requested_run_id,snapshot)),
      ()=>h.machine('heartbeat',{requested_run_id:current.requested_run_id,completed:true,state:'idle'})];
    await Promise.all(shuffle(operations,seeded(seed)).map(operation=>operation()));
    assert.equal(failed,true);
    h.storage.failPut=null;h.restart();
    // All retries retain their original UUID and timestamp. No fabricated newer
    // failure or success is used to make the completed task appear successful.
    for(const snapshot of fresh)assert.equal((await h.upload(current.requested_run_id,snapshot)).status,200);
    await h.machine('heartbeat',{requested_run_id:current.requested_run_id,completed:true,state:'idle'});
    let state=await h.worker.publicStatus();
    assert.equal(state.requested_run_id,null);assert.equal(state.manual_run.id,current.requested_run_id);assert.equal(state.manual_run.state,'completed');
    for(const source of SOURCES)assert.equal(state.manual_run.results[source].outcome,source==='clickandboat'?'failure':'success');
    assert.equal(state.manual_run.results.clickandboat.error_code,'fetch_failed');
    const finished=clone(state.manual_run);
    for(const snapshot of stale)await h.upload(old.requested_run_id,snapshot);
    await h.machine('heartbeat',{requested_run_id:old.requested_run_id,completed:true,state:'idle'});
    state=await h.worker.publicStatus();assert.deepEqual(state.manual_run,finished);
    const map=await h.registry.registry();
    for(const source of ['boataround','samboat','mmk','nausys'])assert.equal(map[source].find(item=>item.booking_id==='99000071').status,'cancelled');
    // A subsequent complete manual retry clears the real source failure. The
    // previous failed task cannot permanently lock the queue or its metadata.
    h.setNow(BASE+30000);const recovered=await h.user('run',{});h.setNow(BASE+40000);
    for(const source of SOURCES)assert.equal((await h.upload(recovered.requested_run_id,success(source,BASE+40000,'recovered-'+source))).status,200);
    await h.machine('heartbeat',{requested_run_id:recovered.requested_run_id,completed:true,state:'idle'});
    state=await h.worker.publicStatus();assert.equal(state.manual_run.state,'completed');
    assert.ok(SOURCES.every(source=>state.manual_run.results[source].outcome==='success'));
    assert.equal(state.order_sync.platforms.clickandboat.last_error,null);
  }
});

test('a transient storage failure before commit cannot consume a valid run ID as a permanent schema failure',async()=>{
    const h=harness();h.setNow(BASE+20000);
    await h.registry.ingestSnapshot(success('boataround',BASE,'prior-paid','paid'));
    h.bucket.beforeCommit=1;
    const current=success('boataround',BASE+1000,'new-cancel');
    const response=await h.registry.ingestBatch({schema_version:1,snapshots:[current]});
    assert.equal(response.results[0].status,503);
    assert.equal((await h.bucket.state('boataround')).last_run_id,'prior-paid');
    h.restart();
    const retry=await h.registry.ingestBatch({schema_version:1,snapshots:[current]});
    assert.equal(retry.results[0].accepted,true);
    assert.equal((await h.registry.registry()).boataround.find(item=>item.booking_id==='99000071').status,'cancelled');
  });

test('a backward clock never rolls back cancellation and a later request recovers after time catches up',async()=>{
  const h=harness();await h.pair();const first=await h.user('run',{});h.setNow(BASE+5000);
  const cancelled=SOURCES.map(source=>success(source,BASE+5000,'clock-before-'+source));
  for(const snapshot of cancelled)await h.upload(first.requested_run_id,snapshot);
  await h.machine('heartbeat',{requested_run_id:first.requested_run_id,completed:true,state:'idle'});
  h.setNow(BASE-20000);const backward=await h.user('run',{});
  assert.ok(backward.requested_at<first.requested_at);
  for(const source of SOURCES){
    const receipt=await h.upload(backward.requested_run_id,success(source,BASE-20000,'clock-back-'+source,'paid'));
    assert.equal(receipt.body.results[0].ignored,'older_snapshot');
  }
  await h.machine('heartbeat',{requested_run_id:backward.requested_run_id,completed:true,state:'idle'});
  for(const snapshot of cancelled)await h.upload(first.requested_run_id,snapshot);
  assert.equal((await h.worker.publicStatus()).manual_run.state,'awaiting_upload');
  assert.deepEqual((await h.worker.publicStatus()).manual_run.results,{});
  const map=await h.registry.registry();
  for(const source of SOURCES)assert.equal(map[source].find(item=>item.booking_id==='99000071').status,'cancelled');
  h.setNow(BASE+30000);const recovered=await h.user('run',{});h.setNow(BASE+35000);
  for(const source of SOURCES)await h.upload(recovered.requested_run_id,success(source,BASE+35000,'clock-recovered-'+source));
  await h.machine('heartbeat',{requested_run_id:recovered.requested_run_id,completed:true,state:'idle'});
  const state=await h.worker.publicStatus();assert.equal(state.manual_run.state,'completed');
  assert.equal(state.manual_run.id,recovered.requested_run_id);
  assert.ok(SOURCES.every(source=>state.manual_run.results[source].outcome==='success'));
});

test('fresh source results remain correlated when the phone clock is five seconds behind the request server',async()=>{
    const h=harness();await h.pair();const current=await h.user('run',{});
    // Immediate auth/fetch failure can be genuinely new yet timestamped before
    // the server request. This uses the real registry and Worker association.
    const events=SOURCES.map(source=>failure(source,BASE-5000,'clock-skew-'+source));
    let lost=false;
    h.storage.failPut=(key,value)=>{if(!lost&&key===PHONE_AGENT_KEY&&value.manual_run?.results?.boataround){lost=true;return true;}return false;};
    for(const snapshot of events){const receipt=await h.upload(current.requested_run_id,snapshot);assert.equal(receipt.status,snapshot.source==='boataround'?503:200);}
    assert.equal(lost,true);h.storage.failPut=null;
    await h.machine('heartbeat',{requested_run_id:current.requested_run_id,completed:true,state:'needs_login'});
    h.restart();
    for(const snapshot of events){const retry=await h.upload(current.requested_run_id,snapshot);assert.equal(retry.body.results[0].idempotent,true);}
    const status=await h.worker.publicStatus();
    assert.equal(status.requested_run_id,null);
    assert.equal(status.manual_run.state,'completed');
    assert.ok(SOURCES.every(source=>status.manual_run.results[source].outcome==='failure'));
  });

test('an old already committed snapshot cannot be relabeled as a new manual result, even when its phone timestamp is ahead',async()=>{
  for(const offset of [-5000,5000]){
    const h=harness();await h.pair();
    const automatic=success('boataround',BASE+offset,'automatic-before-request','paid');
    const first=await h.upload(null,automatic);
    assert.equal(first.body.results[0].received_at,iso(BASE));
    h.setNow(BASE+1000);const current=await h.user('run',{});
    const relabeled=await h.upload(current.requested_run_id,automatic);
    assert.equal(relabeled.body.results[0].idempotent,true);
    assert.equal(relabeled.body.results[0].received_at,iso(BASE));
    assert.deepEqual((await h.worker.publicStatus()).manual_run.results,{});
  }
});

test('only a bounded negative clock offset with original registry receipt proof is eligible, including a long upload delay',async()=>{
  for(const offset of [-60000,-60001]){
    const h=harness();await h.pair();const current=await h.user('run',{});
    // The first receipt arrives two hours after collection. This is a late
    // delivery of the same observation, not a new observation timestamp.
    h.setNow(BASE+2*60*60*1000);
    const snapshot=success('boataround',BASE+offset,'slow-clock-upload','paid');
    const receipt=await h.upload(current.requested_run_id,snapshot);
    assert.equal(receipt.body.results[0].accepted,true);
    assert.equal(receipt.body.results[0].received_at,iso(BASE+2*60*60*1000));
    const state=await h.worker.publicStatus();
    assert.equal(Object.hasOwn(state.manual_run.results,'boataround'),offset===-60000);
    if(offset===-60000)assert.equal(state.manual_run.results.boataround.checked_at,snapshot.checked_at);
    h.setNow(BASE+3*60*60*1000);
    const retry=await h.upload(current.requested_run_id,snapshot);
    assert.equal(retry.body.results[0].idempotent,true);
    assert.equal(retry.body.results[0].received_at,iso(BASE+2*60*60*1000));
  }
});

test('a generic lost response after a successful commit is retryable without changing the exact snapshot or receipt time',async()=>{
  const h=harness();h.setNow(BASE+20000);await h.registry.status();
  h.bucket.afterCommit=1;
  const snapshot=success('boataround',BASE+1000,'commit-before-lost-response');
  const first=await h.registry.ingestBatch({schema_version:1,snapshots:[snapshot]});
  assert.equal(first.results[0].status,503);
  const committed=await h.bucket.state('boataround');
  assert.equal(committed.last_error,null);assert.equal(committed.last_success_at,snapshot.checked_at);
  h.setNow(BASE+30000);h.restart();
  const retry=await h.registry.ingestBatch({schema_version:1,snapshots:[snapshot]});
  assert.equal(retry.results[0].idempotent,true);
  assert.equal(retry.results[0].received_at,iso(BASE+20000));
  assert.deepEqual(await h.bucket.state('boataround'),committed);
});
