import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from '../phone-agent.mjs';
import {PhoneAgent} from '../phone-server/core.mjs';
import {FLEET} from '../parsers.mjs';

const {createOrderRegistry}=createRequire(import.meta.url)('./dynamic-registry.cjs');
const BASE=Date.parse('2026-09-12T08:00:00Z'),ORIGIN='https://rejection-fixture.invalid',TOKEN='r'.repeat(43);
const SOURCES=['boataround','clickandboat','samboat'];
class Storage {
  data=new Map();failPut=null;
  async get(key){return structuredClone(this.data.get(key));}
  async put(key,value){if(this.failPut?.(key,value))throw Error('injected write failure');this.data.set(key,structuredClone(value));}
  async transaction(work){return work(this);}
  async deleteAlarm(){}
}
function bucket(){const data=new Map();return {
  async get(key){const entry=data.get(key);return entry?{etag:entry.etag,json:async()=>JSON.parse(entry.text)}:null;},
  async put(key,text,{onlyIf}={}){const old=data.get(key);if(onlyIf instanceof Headers&&old)return null;
    if(onlyIf&&!(onlyIf instanceof Headers)&&onlyIf.etagMatches!==old?.etag)return null;
    const etag=crypto.randomUUID();data.set(key,{text,etag});return {etag};},
};}
function snapshot(source,clock,tag){return {source,run_id:source+'-'+tag,checked_at:new Date(clock).toISOString(),complete:true,
  expected_count:0,orders:[],scope:{kind:'current_future',from_day:'2026-09-12',fleet_slugs:FLEET.map(boat=>boat.slug)},
  pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:0}};}
async function setup(t){
  let clock=BASE;const storage=new Storage();
  const registry=createOrderRegistry({bucket:bucket(),now:()=>clock,normalizeBooking:(source,record)=>({...record,source}),
    fleetSpecs:FLEET.map(boat=>({...boat,boataround_slug:boat.slug})),
    bootstrapMap:{boataround:[],clickandboat:[],samboat:[],mapping_updated_at:new Date(BASE-60000).toISOString()}});
  const worker=new FleetPhoneAgent({storage,now:()=>clock,ingest:payload=>registry.ingestBatch(payload),registryStatus:()=>registry.status()});
  const request=(route,input,user=false)=>new Request(ORIGIN+'/api/agent/'+route,{method:input===undefined?'GET':'POST',
    headers:{...(user?{Origin:ORIGIN,'Sec-Fetch-Site':'same-origin'}:{Authorization:'Bearer '+TOKEN}),...(input===undefined?{}:{'Content-Type':'application/json'})},
    ...(input===undefined?{}:{body:JSON.stringify(input)})});
  const user=async(route,input)=>{const response=await worker.user(request(route,input,true));assert.ok(response.ok);return response.json();};
  const machine=async(route,input)=>{const response=await worker.machine(request(route,input));if(!response.ok)throw Error('remote '+response.status);return response.json();};
  const code=await user('pairing-code',{});await machine('pair',{pairing_code:code.pairing_code,name:'Rejection fixture'});
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-rejection-audit-'));
  t.after(async()=>{assert.equal(path.dirname(home),path.resolve(os.tmpdir()));await fs.rm(home,{recursive:true,force:true});});
  const page={setViewport:async()=>{},close:async()=>{}},browser={connected:true,newPage:async()=>({...page}),close:async()=>{}};
  const remote={upload:payload=>machine('order-sync',payload),heartbeat:payload=>machine('heartbeat',payload),poll:()=>machine('poll')};
  const phone=await new PhoneAgent({home,config:{paired:true},remote,now:()=>clock,browserFactory:async()=>browser,
    collectors:Object.fromEntries(SOURCES.map(source=>[source,async()=>snapshot(source,clock,'initial')]))}).init();
  t.after(()=>phone.close());
  return {phone,worker,registry,storage,home,user,machine,setClock:value=>{clock=value;},now:()=>clock};
}

for(const malformed of ['count','record fields'])test(`real phone retires invalid ${malformed} while its matching manual request completes as failure`,async t=>{
  const h=await setup(t);
  const prior=snapshot('boataround',BASE,'prior');
  prior.orders=[{booking_id:'99000072',boataround_slug:FLEET[0].slug,start:'2026-10-01',end:'2026-10-08',
    url:'https://rejection-fixture.invalid/prior-paid',status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID'}];
  prior.expected_count=prior.pagination.listed_count=1;
  await h.registry.ingestSnapshot(prior);
  h.setClock(BASE+1000);const run=await h.user('run',{});
  h.phone.collectors.boataround=async()=>malformed==='count'?
    {...snapshot('boataround',h.now(),'bad-count'),expected_count:1}:
    {...snapshot('boataround',h.now(),'bad-record'),expected_count:1,
      orders:[{...prior.orders[0],status:'unknown-platform-state'}],
      pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:1}};
  await h.phone.run({requestedRunId:run.requested_run_id});
  assert.deepEqual(await fs.readdir(path.join(h.home,'outbox')),[]);
  assert.equal((await fs.readdir(path.join(h.home,'rejected'))).length,1);
  assert.equal(h.phone.state.sources.boataround.state,'rejected');
  const status=await h.worker.publicStatus();
  assert.equal(status.requested_run_id,null);
  assert.equal(status.manual_run.state,'completed');
  assert.equal(status.manual_run.results.boataround.outcome,'failure');
  assert.equal(status.manual_run.results.boataround.error_code,'schema_changed');
  assert.equal(status.manual_run.results.clickandboat.outcome,'success');
  assert.equal(status.manual_run.results.samboat.outcome,'success');
  assert.equal(status.order_sync.platforms.boataround.last_success_at,prior.checked_at);
  assert.equal((await h.registry.registry()).boataround[0].booking_id,'99000072');
  // A user retry must get a new request and recover normally, without the old
  // rejected file being relabelled or its rejected order data being accepted.
  h.setClock(BASE+2000);const retry=await h.user('run',{});assert.notEqual(retry.requested_run_id,run.requested_run_id);
  for(const source of SOURCES)h.phone.collectors[source]=async()=>snapshot(source,h.now(),'recovered');
  await h.phone.run({requestedRunId:retry.requested_run_id});
  const recovered=await h.worker.publicStatus();assert.equal(recovered.manual_run.state,'completed');
  assert.ok(SOURCES.every(source=>recovered.manual_run.results[source].outcome==='success'));
});

test('a lost manual-result write recovers from the same rejected snapshot and persisted failure receipt',async t=>{
  const h=await setup(t);const run=await h.user('run',{}),bad={...snapshot('boataround',BASE,'replayed-rejection'),expected_count:1};
  await h.phone.enqueue(bad,run.requested_run_id);
  let failOnce=true;
  h.storage.failPut=(key,value)=>{if(failOnce&&key===PHONE_AGENT_KEY&&value.manual_run?.results?.boataround){failOnce=false;return true;}return false;};
  await h.phone.flush();assert.equal(failOnce,false);
  assert.equal((await fs.readdir(path.join(h.home,'outbox'))).length,1);
  h.setClock(BASE+61000);await h.phone.flush();
  assert.equal((await fs.readdir(path.join(h.home,'outbox'))).length,0);
  const status=await h.worker.publicStatus();assert.equal(status.manual_run.results.boataround.outcome,'failure');
  assert.equal(status.manual_run.results.boataround.checked_at,bad.checked_at);
  assert.equal(status.order_sync.platforms.boataround.last_success_at,null);
});

test('bare or contradictory rejection receipts cannot invent a terminal manual result',async t=>{
  const h=await setup(t);const run=await h.user('run',{}),event=snapshot('boataround',BASE,'proof-gate');
  const proof={source:'boataround',accepted:true,outcome:'failure',error_code:'schema_changed',
    run_id:event.run_id,checked_at:event.checked_at,received_at:event.checked_at};
  const failures=[undefined,{...proof,source:'samboat'},{...proof,accepted:false},{...proof,outcome:'success'},
    {...proof,error_code:'invented'},{...proof,run_id:'other-run'},{...proof,checked_at:new Date(BASE-1000).toISOString()},
    {...proof,received_at:null},{...proof,received_at:new Date(BASE-1000).toISOString()},
    {...proof,received_at:new Date(BASE+61000).toISOString()},{...proof,ignored:'older_snapshot'},
    {...proof,error:'write failed'},{...proof,status:503}];
  for(const failure_receipt of failures){
    h.worker.ingest=async()=>({results:[{source:'boataround',accepted:false,status:422,failure_receipt}]});
    await h.machine('order-sync',{schema_version:1,requested_run_id:run.requested_run_id,snapshots:[event]});
    assert.deepEqual((await h.worker.publicStatus()).manual_run.results,{});
  }
  h.worker.ingest=async()=>({results:[{source:'boataround',accepted:false,status:503,failure_receipt:proof}]});
  await h.machine('order-sync',{schema_version:1,requested_run_id:run.requested_run_id,snapshots:[event]});
  await h.machine('heartbeat',{requested_run_id:run.requested_run_id,completed:true,state:'idle'});
  const status=await h.worker.publicStatus();assert.equal(status.manual_run.state,'awaiting_upload');
  assert.deepEqual(status.manual_run.results,{});assert.equal(status.order_sync.platforms.boataround.last_success_at,null);
});

test('a validation failure whose failure commit is unavailable stays unconfirmed and preserves earlier data',async t=>{
  const h=await setup(t);const run=await h.user('run',{});
  // An invalid checked_at also prevents the registry from committing its
  // failure envelope. It must not emit evidence merely because it saw 422.
  const event={...snapshot('boataround',BASE,'invalid-clock'),checked_at:'not-a-timestamp',expected_count:1};
  const receipt=await h.machine('order-sync',{schema_version:1,requested_run_id:run.requested_run_id,snapshots:[event]});
  assert.equal(receipt.results[0].status,422);assert.equal(receipt.results[0].failure_receipt,undefined);
  assert.deepEqual((await h.worker.publicStatus()).manual_run.results,{});
  assert.equal((await h.registry.status()).platforms.boataround.last_success_at,null);
});
