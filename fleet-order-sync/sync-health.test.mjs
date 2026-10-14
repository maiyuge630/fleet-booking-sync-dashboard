import test from 'node:test';
import assert from 'node:assert/strict';
import {recordSyncHealth,summarizeSyncHealth} from './sync-health.mjs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {FLEET} from './parsers.mjs';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from './phone-agent.mjs';
const {createOrderRegistry}=createRequire(import.meta.url)('./worker/dynamic-registry.cjs');
const now=Date.parse('2026-09-13T11:00:00Z'),at=new Date(now).toISOString();
const payload={snapshots:[{source:'samboat',run_id:'run1',checked_at:at,complete:true,outcome:'success'}]};
const result={source:'samboat',run_id:'run1',accepted:true,outcome:'success',received_at:at};
test('accepted observations count once across retries and survive restart',()=>{
 const first=recordSyncHealth(null,payload,{results:[result]},now);
 const second=recordSyncHealth(JSON.parse(JSON.stringify(first)),payload,{results:[{...result,idempotent:true}]},now+1000);
 assert.equal(summarizeSyncHealth(second,now+1000).success,1);
 assert.ok(!JSON.stringify(summarizeSyncHealth(second,now)).includes('run1'));
});
test('ignored uploads, no receipt, and unconfirmed rejections never become successful samples',()=>{
 for(const r of [{...result,ignored:'stale'},{...result,accepted:false},{...result,run_id:'different'},{...result,idempotent:true,received_at:undefined}]){
  assert.equal(summarizeSyncHealth(recordSyncHealth(null,payload,{results:[r]},now),now).success,0);
 }
});
test('durably accepted failure receipts count as failures and the window expires',()=>{
 const receipt={results:[{source:'samboat',accepted:false,status:422,failure_receipt:{...result,outcome:'failure',checked_at:at,error_code:'schema_changed'}}]};
 const state=recordSyncHealth(null,payload,receipt,now);
 assert.equal(summarizeSyncHealth(state,now).failure,1);
 assert.equal(summarizeSyncHealth(state,now+31*86400000).failure,0);
});

function registryFixture(){
 const files=new Map();let serial=0,clock=now;
 const bucket={async get(key){const f=files.get(key);return f?{etag:f.etag,json:async()=>JSON.parse(f.value)}:null;},
  async put(key,value,{onlyIf}={}){const prior=files.get(key);if(onlyIf instanceof Headers&&prior)return null;if(onlyIf?.etagMatches&&onlyIf.etagMatches!==prior?.etag)return null;
   const etag=String(++serial);files.set(key,{etag,value});return {etag};}};
 const registry=createOrderRegistry({bucket,normalizeBooking:(source,record)=>({...record,source}),
  fleetSpecs:FLEET.map(boat=>({...boat,boataround_slug:boat.slug})),bootstrapMap:{boataround:[],clickandboat:[],samboat:[]},now:()=>clock});
 const packet=(run_id,extra={})=>({schema_version:1,snapshots:[{source:'samboat',run_id,checked_at:new Date(clock).toISOString(),complete:true,expected_count:0,orders:[],
  scope:{kind:'current_future',from_day:'2026-09-13',fleet_slugs:FLEET.map(boat=>boat.slug)},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:0},...extra}]});
 return {registry,packet,advance:()=>{clock+=1000;},time:()=>clock};
}

test('real registry success, failure, idempotent retry and schema rejection receipts count exactly once',async()=>{
 const f=registryFixture();let saved=null;
 const success=f.packet('actual-success'),receipt=await f.registry.ingestBatch(success);
 assert.equal(receipt.results[0].run_id,undefined,'exercise the actual receipt contract');
 saved=recordSyncHealth(saved,success,receipt,f.time());
 assert.equal(summarizeSyncHealth(saved,f.time()).success,1);
 const retry=await f.registry.ingestBatch(success);assert.equal(retry.results[0].idempotent,true);
 saved=recordSyncHealth(saved,success,retry,f.time());assert.equal(summarizeSyncHealth(saved,f.time()).success,1);
 // If the prior status write failed, the real idempotent receipt still carries
 // its original server time and must recover the first successful observation.
 assert.equal(summarizeSyncHealth(recordSyncHealth(null,success,retry,f.time()),f.time()).success,1);
 f.advance();const failure=f.packet('actual-failure',{outcome:'failure',error_code:'fetch_failed'});
 saved=recordSyncHealth(saved,failure,await f.registry.ingestBatch(failure),f.time());
 f.advance();const malformed=f.packet('actual-rejection',{complete:false});
 const rejected=await f.registry.ingestBatch(malformed);assert.equal(rejected.results[0].status,422);
 saved=recordSyncHealth(saved,malformed,rejected,f.time());
 const summary=summarizeSyncHealth(saved,f.time());assert.equal(summary.success,1);assert.equal(summary.failure,2);
 saved=recordSyncHealth(saved,malformed,await f.registry.ingestBatch(malformed),f.time());
 assert.equal(summarizeSyncHealth(saved,f.time()).failure,2);
 f.advance();saved=recordSyncHealth(saved,success,await f.registry.ingestBatch(success),f.time());
 assert.equal(summarizeSyncHealth(saved,f.time()).success,1,'ignored older packets never add samples');
});

test('phone machine upload integration exposes the real registry success without counting its retry',async()=>{
 const f=registryFixture(),entries=new Map(),token='a'.repeat(43),hash=createHash('sha256').update(token).digest('hex');
 const storage={async get(key){return structuredClone(entries.get(key));},async put(key,value){entries.set(key,structuredClone(value));},transaction(work){return work(this);}};
 await storage.put(PHONE_AGENT_KEY,{mode:'phone',token_hash:hash,paired_at:at,enabled:true,state:'idle'});
 const agent=new FleetPhoneAgent({storage,ingest:packet=>f.registry.ingestBatch(packet),registryStatus:()=>f.registry.status(),now:f.time});
 const packet=f.packet('machine-health-test');
 for(let i=0;i<2;i++){
  const request=new Request('https://fixture.invalid/api/agent/order-sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(packet)});
  const response=await agent.machine(request);assert.equal(response.status,200);
 }
 const health=(await agent.publicStatus()).health;assert.equal(health.success,1);assert.equal(health.failure,0);
 assert.equal(health.sources.samboat.last_success_at,at);
});

test('contradictory results or an unrelated nested failure cannot become health evidence',()=>{
 const validFailure={...result,outcome:'failure',checked_at:at,error_code:'schema_changed'};
 const bad=[{...result,outcome:'failure'},{...result,status:503},
  ...[{source:'boataround'},{run_id:'wrong'},{checked_at:'2020-01-01T00:00:00.000Z'},{error_code:'unknown'}].map(change=>
   ({source:'samboat',accepted:false,status:422,failure_receipt:{...validFailure,...change}})),
  {source:'samboat',accepted:false,status:503,failure_receipt:validFailure}];
 for(const r of bad){const summary=summarizeSyncHealth(recordSyncHealth(null,payload,{results:[r]},now),now);assert.equal(summary.success+summary.failure,0);}
});

test('retention bounds persisted events and excludes malformed, expired and future records',()=>{
 const events=Array.from({length:4097},(_,i)=>({source:'samboat',run_id:'bounded-'+i,outcome:'success',at:new Date(now-i*1000).toISOString()}));
 const saved=recordSyncHealth({events:[null,{source:'unknown',run_id:'bad',outcome:'success',at},...events]},null,null,now);
 assert.equal(saved.events.length,4096);assert.equal(saved.truncated,true);
 assert.equal(summarizeSyncHealth(saved,now).success,4096);
 assert.equal(summarizeSyncHealth(saved,now+31*86400000).success,0);
 assert.equal(summarizeSyncHealth({events:[{...result,at:new Date(now+61000).toISOString()}]},now).success,0);
 assert.equal(summarizeSyncHealth({events:{}},now).success,0);
});
