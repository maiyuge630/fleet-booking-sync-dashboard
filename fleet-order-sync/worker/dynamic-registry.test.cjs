'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const {createOrderRegistry,ORDER_SYNC_PREFIX}=require('./dynamic-registry.cjs');
const {patchOrderSync}=require('./patch-order-sync.cjs');
const baselineSource=fs.readFileSync(path.resolve(__dirname,'../../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function load(source){const c=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Response,Request,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,setTimeout,clearTimeout,console,fetch:()=>{throw Error('No live network in tests');}});vm.runInContext(source.replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),c);return c;}
const original=load(baselineSource),candidateSource=patchOrderSync(baselineSource),worker=load(candidateSource);
function bucket(){let serial=0;const files=new Map();return {files,async get(key){const entry=files.get(key);return entry?{etag:entry.etag,json:async()=>JSON.parse(entry.value)}:null;},async put(key,value,options={}){const old=files.get(key),condition=options.onlyIf;if(condition instanceof Headers&&condition.get('If-None-Match')==='*'&&old)return null;if(condition&&!(condition instanceof Headers)&&condition.etagMatches!==old?.etag)return null;const etag='fixture-'+ ++serial;files.set(key,{etag,value});return {etag};},async delete(key){files.delete(key);}};}
function fixture(){const store=bucket();let clock=Date.parse('2026-09-10T00:00:00Z');const make=(bootstrapMap=clone(original.BOOKING_MAP))=>createOrderRegistry({bucket:store,normalizeBooking:worker.normalizeBooking,fleetSpecs:clone(worker.FLEET_SPECS),bootstrapMap,now:()=>clock});return {store,make,registry:make(),setClock:value=>{clock=Date.parse(value);}};}
// The production fleet (eight boats since the Lightcat joined on 2026-10-09).
const slugs=worker.FLEET_SPECS.map(boat=>boat.boataround_slug);
function currentMap(source){return clone(original.BOOKING_MAP[source]).filter(order=>order.end>'2026-09-09');}
function snapshot(source='boataround',orders=currentMap(source),checked_at='2026-09-09T00:00:00Z',run_id='run-one'){return {source,run_id,checked_at,complete:true,expected_count:orders.length,scope:{kind:'current_future',from_day:'2026-09-09',fleet_slugs:[...slugs]},pagination:{complete:true,total_pages:3,pages_read:[1,2,3],listed_count:orders.length},orders};}
function active(map,source){return map[source].filter(order=>['accepted','paid','deposit_paid'].includes(order.status)&&order.end>'2026-09-09');}
const paid=()=>currentMap('boataround').find(order=>order.booking_id==='280707');

test('public source status distinguishes collection time from delayed delivery, including later repeated failures',async()=>{
 const f=fixture();await f.registry.ingestSnapshot(snapshot());
 let p=(await f.make().status()).platforms.boataround;
 assert.equal(p.last_checked_at,'2026-09-09T00:00:00.000Z');assert.equal(p.last_attempt_at,'2026-09-10T00:00:00.000Z');
 for(const [hour,run_id] of [['01','first-failure'],['02','later-failure']]){
  await f.registry.ingestSnapshot({source:'boataround',run_id,checked_at:'2026-09-09T'+hour+':00:00Z',outcome:'failure',error_code:'fetch_failed'});
  p=(await f.make().status()).platforms.boataround;
  assert.equal(p.last_checked_at,'2026-09-09T'+hour+':00:00.000Z');assert.equal(p.last_success_at,'2026-09-09T00:00:00.000Z');assert.equal(p.last_error,'fetch_failed');
 }
});

test('an access check is recorded as its own failure and keeps the last complete orders',async()=>{
 const f=fixture();await f.registry.ingestSnapshot(snapshot());const before=active(await f.make().registry(),'boataround').map(o=>o.booking_id).sort();
 assert.ok(before.length>0);
 await f.registry.ingestSnapshot({source:'boataround',run_id:'challenge',checked_at:'2026-09-09T01:00:00Z',outcome:'failure',error_code:'challenge_required'});
 const p=(await f.make().status()).platforms.boataround;
 assert.equal(p.last_error,'challenge_required');assert.equal(p.last_success_at,'2026-09-09T00:00:00.000Z');
 assert.deepEqual(active(await f.make().registry(),'boataround').map(o=>o.booking_id).sort(),before);
 await assert.rejects(f.registry.ingestSnapshot({source:'boataround',run_id:'unknown-code',checked_at:'2026-09-09T02:00:00Z',outcome:'failure',error_code:'something_else'}),/同步失败类型无效/);
});

test('an order the official app lists as Accepted is registered with that basis; an unlabelled one is refused',async()=>{
 const f=fixture();
 const order={source:'clickandboat',booking_id:'1000002',url:'https://www.clickandboat.com/uk/booking/1000002/detail',boataround_slug:'grandcat-55-tidewyn-discovery-5',
  start:'2026-11-07',end:'2026-11-13',status:'accepted',platform_status:'Accepted',amount:'€12,705.00',amount_basis:'船东净收入',
  payment_basis:'platform_accepted',payment_basis_source:'Click&Boat 官方 App 订单列表状态 Accepted',verified_at:'2026-09-09T00:00:00Z'};
 await f.registry.ingestSnapshot(snapshot('clickandboat',[order]));
 const stored=(await f.make().registry()).clickandboat.find(o=>o.booking_id==='1000002');
 assert.equal(stored.status,'accepted');assert.equal(stored.payment_basis,'platform_accepted');assert.equal(stored.customer_payment_verified,undefined);
 for(const bad of [{payment_basis:undefined},{platform_status:'Pending'},{payment_basis:'guessed'}])
  await assert.rejects(f.registry.ingestSnapshot(snapshot('clickandboat',[{...order,...bad}],'2026-09-09T01:00:00Z','run-bad-'+JSON.stringify(bad).length)),/官方 App 的 Accepted|状态/);
});

test('bootstrap is one-time data recovery, never reported as successful automatic synchronization',async()=>{const f=fixture(),state=await f.registry.status();assert.equal(state.automatic_enabled,false);for(const source of ['boataround','clickandboat','samboat']){assert.equal(state.platforms[source].mode,'bootstrap');assert.equal(state.platforms[source].last_success_at,null);}assert.equal(state.last_all_platforms_success_at,null);});
test('full verified snapshot stores actual observation time and survives a new registry instance',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const state=await f.make().status();assert.equal(state.platforms.boataround.mode,'dynamic');assert.equal(state.platforms.boataround.last_success_at,'2026-09-09T00:00:00.000Z');assert.equal(state.platforms.boataround.last_attempt_at,'2026-09-10T00:00:00.000Z');assert.equal(active(await f.make().registry(),'boataround').length,17);});
test('failure preserves records and last success while recording the failed attempt',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const previous=(await f.registry.registry()).boataround;await f.registry.ingestSnapshot({source:'boataround',run_id:'run-failed',checked_at:'2026-09-09T01:00:00Z',outcome:'failure',error_code:'auth_required'});const data=await f.registry.registry(),state=await f.registry.status();assert.deepEqual(data.boataround,previous);assert.equal(state.platforms.boataround.last_success_at,'2026-09-09T00:00:00.000Z');assert.equal(state.platforms.boataround.last_error,'auth_required');});
test('incomplete pages cannot clear orders or advance success time',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const partial=snapshot('boataround',[],'2026-09-09T02:00:00Z','missing-page');partial.pagination.pages_read=[1,3];const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[partial]});assert.equal(receipt.results[0].accepted,false);assert.equal(active(await f.registry.registry(),'boataround').length,17);assert.equal(receipt.order_sync.platforms.boataround.last_error,'incomplete_pages');assert.equal(receipt.order_sync.platforms.boataround.last_success_at,'2026-09-09T00:00:00.000Z');});
test('success requires exactly all seven fleet slugs and unique complete pages',async()=>{const f=fixture();for(const change of [s=>s.scope.fleet_slugs.pop(),s=>s.scope.fleet_slugs[0]=s.scope.fleet_slugs[1],s=>s.pagination.pages_read=[1,1,3],s=>s.pagination.complete=false,s=>s.expected_count++]){const body=snapshot();change(body);await assert.rejects(f.registry.ingestSnapshot(body));}assert.equal(active(await f.registry.registry(),'boataround').length,17);});
test('verified true-empty full scope clears source records while preserving history and the authorized manual reschedule',async()=>{const f=fixture();const before=await f.registry.registry(),historical=before.clickandboat.filter(order=>order.end<='2026-09-09');const empty=snapshot('clickandboat',[]);empty.pagination={complete:true,total_pages:1,pages_read:[1],listed_count:0};await f.registry.ingestSnapshot(empty);const after=await f.registry.registry();assert.deepEqual(active(after,'clickandboat').map(order=>order.booking_id),['1000000']);assert.deepEqual(after.clickandboat.filter(order=>order.booking_id!=='1000000'),historical);const raw=JSON.parse(f.store.files.get(ORDER_SYNC_PREFIX+'clickandboat.json').value);assert.equal(raw.records.filter(order=>order.end>'2026-09-09').length,0);});
test('moved and rescheduled order identity is replaced once across the entire fleet',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const orders=currentMap('boataround'),entry=orders.find(order=>order.booking_id==='280707');entry.boataround_slug='seacat-open-40-tidewyn-discovery-2';entry.start='2026-10-21';entry.end='2026-10-28';await f.registry.ingestSnapshot(snapshot('boataround',orders,'2026-09-09T03:00:00Z','moved'));const matches=(await f.registry.registry()).boataround.filter(order=>order.booking_id==='280707');assert.equal(matches.length,1);assert.equal(matches[0].boataround_slug,entry.boataround_slug);assert.equal(matches[0].start,entry.start);assert.equal(matches[0].end,entry.end);});
test('new cancellation replaces old paid record and cannot be resurrected by static map on restart',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const orders=currentMap('boataround');Object.assign(orders.find(order=>order.booking_id==='280707'),{status:'cancelled',platform_status:'CANCELLED'});await f.registry.ingestSnapshot(snapshot('boataround',orders,'2026-09-09T04:00:00Z','cancelled'));const resetStatic=clone(original.BOOKING_MAP);resetStatic.boataround.find(order=>order.booking_id==='280707').status='paid';assert.equal((await f.make(resetStatic).registry()).boataround.find(order=>order.booking_id==='280707').status,'cancelled');});
test('user cancellation 1000001 is independently persisted and outranks a later paid source record',async()=>{const f=fixture(),orders=currentMap('samboat'),cancelled=orders.find(order=>order.booking_id==='1000001');cancelled.status='deposit_paid';for(const record of orders){if(record.status==='deposit_paid'){record.platform_status='DEPOSIT PAID';record.verification_source='Synthetic payment label for override regression only; not platform evidence';}}await f.registry.ingestSnapshot(snapshot('samboat',orders));const data=await f.make().registry();assert.equal(data.samboat.find(order=>order.booking_id==='1000001').status,'cancelled');assert.ok(f.store.files.has(ORDER_SYNC_PREFIX+'manual-overrides.json'));assert.equal(active(data,'samboat').length,2);});
test('unpaid pending remains excluded while complete raw confirmation alone is rejected',async()=>{const f=fixture();await f.registry.ingestSnapshot(snapshot());const data=await f.registry.registry();assert.equal(data.boataround.find(order=>order.booking_id==='317442').status,'pending');assert.ok(!active(data,'boataround').some(order=>order.booking_id==='317442'));const orders=currentMap('boataround');orders[0].status='confirmed';await assert.rejects(f.registry.ingestSnapshot(snapshot('boataround',orders,'2026-09-09T05:00:00Z','unknown-status')));});
test('older out-of-order packets cannot roll back dates or status',async()=>{const f=fixture();const orders=currentMap('boataround');Object.assign(orders.find(order=>order.booking_id==='280707'),{status:'cancelled',platform_status:'CANCELLED'});await f.registry.ingestSnapshot(snapshot('boataround',orders,'2026-09-09T04:00:00Z','newer'));const receipt=await f.registry.ingestSnapshot(snapshot('boataround',currentMap('boataround'),'2026-09-09T03:00:00Z','older'));assert.equal(receipt.ignored,'older_snapshot');assert.equal((await f.registry.registry()).boataround.find(order=>order.booking_id==='280707').status,'cancelled');});
test('retry is idempotent and same run ID with changed content is rejected',async()=>{const f=fixture(),body=snapshot();await f.registry.ingestSnapshot(body);assert.equal((await f.registry.ingestSnapshot(body)).idempotent,true);const other=clone(body);Object.assign(other.orders.find(order=>order.booking_id==='280707'),{status:'cancelled',platform_status:'CANCELLED'});await assert.rejects(f.registry.ingestSnapshot(other),error=>error.status===409);});
test('cross-scope old records, future-only cutoffs, and unknown scope are rejected',async()=>{const f=fixture();const a=snapshot();a.orders[0].end='2026-09-01';a.orders[0].start='2026-08-28';const b=snapshot();b.scope.from_day='2026-09-11';const c=snapshot();c.scope.kind='single_boat';for(const event of [a,b,c])await assert.rejects(f.registry.ingestSnapshot(event));});
test('scope cutoff uses Beijing day after UTC 16:00, matching the cloud controller',async()=>{const f=fixture();f.setClock('2026-09-09T16:30:00Z');const body=snapshot('boataround',[paid()],'2026-09-09T16:10:00Z','beijing-midnight');body.scope.from_day='2026-09-10';const receipt=await f.registry.ingestSnapshot(body);assert.equal(receipt.accepted,true);assert.equal((await f.registry.status()).platforms.boataround.scope.from_day,'2026-09-10');const tomorrow=clone(body);tomorrow.run_id='beijing-tomorrow';tomorrow.checked_at='2026-09-09T16:20:00Z';tomorrow.scope.from_day='2026-09-11';await assert.rejects(f.registry.ingestSnapshot(tomorrow));});
test('paid order shifted from historical cache into current future scope replaces its old identity',async()=>{const f=fixture(),map=clone(original.BOOKING_MAP),old=map.boataround.find(order=>order.booking_id==='280707');old.start='2026-07-01';old.end='2026-07-08';const reg=f.make(map);await reg.status();await reg.ingestSnapshot(snapshot());const records=(await reg.registry()).boataround.filter(order=>order.booking_id==='280707');assert.equal(records.length,1);assert.equal(records[0].start,'2026-10-17');});
test('mixed-platform success/failure preserves the failed platform independently',async()=>{const f=fixture();const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('boataround'),{source:'samboat',run_id:'failed-sb',checked_at:'2026-09-09T00:00:00Z',outcome:'failure',error_code:'fetch_failed'}]});assert.equal(receipt.results.length,2);assert.equal(receipt.order_sync.platforms.boataround.last_success_at,'2026-09-09T00:00:00.000Z');assert.equal(receipt.order_sync.platforms.samboat.last_success_at,null);assert.equal(active(await f.registry.registry(),'samboat').length,2);});
test('ingestion cannot write manual overrides and rejects duplicate platform envelopes',async()=>{const f=fixture();await assert.rejects(f.registry.ingestBatch({schema_version:1,manual_overrides:[],snapshots:[snapshot()]}));await assert.rejects(f.registry.ingestBatch({schema_version:1,snapshots:[snapshot(),snapshot()]}));});
test('concurrent newer update wins through storage compare-and-swap',async()=>{const f=fixture();await f.registry.status();const cancelled=currentMap('boataround');Object.assign(cancelled.find(order=>order.booking_id==='280707'),{status:'cancelled',platform_status:'CANCELLED'});await Promise.all([f.registry.ingestSnapshot(snapshot()),f.registry.ingestSnapshot(snapshot('boataround',cancelled,'2026-09-09T06:00:00Z','latest'))]);assert.equal((await f.registry.registry()).boataround.find(order=>order.booking_id==='280707').status,'cancelled');});
test('corrupt dynamic storage fails closed instead of repopulating an obsolete static map',async()=>{const f=fixture();await f.registry.status();await f.store.put(ORDER_SYNC_PREFIX+'boataround.json','{"schema_version":0}');await assert.rejects(f.registry.registry(),error=>error.status===503);});

function segment(source,start,end){const at=source.indexOf(start),to=end?source.indexOf(end,at+start.length):source.length;assert.ok(at>=0&&to>=at);return source.slice(at,to);}
test('patch preserves the main UI/login/authentication/DO storage and adds no secret or automatic schedule',()=>{assert.equal(worker.HTML,original.HTML);assert.equal(worker.LOGIN_HTML,original.LOGIN_HTML);assert.equal(JSON.stringify(worker.PAGE_CSP),JSON.stringify(original.PAGE_CSP));assert.equal(segment(candidateSource,'var SESSION_COOKIE =','var CACHE_KEY ='),segment(baselineSource,'var SESSION_COOKIE =','var CACHE_KEY ='));assert.equal(segment(candidateSource,'// worker/durable-storage.js'),segment(baselineSource,'// worker/durable-storage.js'));assert.ok(!candidateSource.includes('async alarm('));assert.ok(!candidateSource.includes('FLEET_SYNC_SECRET'));});
test('maintenance CSP matches its actual inline script/style and requires no unsafe-inline',()=>{for(const tag of ['script','style']){const content=worker.ORDER_SYNC_HTML.match(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>'))[1];assert.ok(worker.ORDER_SYNC_CSP.includes("'sha256-"+createHash('sha256').update(content).digest('base64')+"'"));}assert.ok(!worker.ORDER_SYNC_CSP.includes('unsafe-inline'));});
async function authFixture(){const store=bucket(),config={username:'local-fixture@example.invalid',iterations:100000,salt:'11'.repeat(32),pepper:'22'.repeat(32),verifier:'00'.repeat(32)};config.verifier=Buffer.from(await worker.passwordVerifier('fictional-local-password',config)).toString('hex');const env={BUCKET:store,FLEET_AUTH_CONFIG:JSON.stringify(config)},form=new URLSearchParams({username:config.username,password:'fictional-local-password'});const response=await worker.server_default.fetch(new Request('https://fixture.invalid/auth/login',{method:'POST',headers:{Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded'},body:form.toString()}),env);assert.equal(response.status,303);return {store,env,cookie:response.headers.get('Set-Cookie').split(';')[0]};}
test('anonymous maintenance and ingestion requests remain behind original authentication',async()=>{const {env}=await authFixture();const page=await worker.server_default.fetch(new Request('https://fixture.invalid/sync'),env);assert.equal(page.status,303);const api=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers:{Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:'{}'}),env);assert.equal(api.status,401);});
test('authenticated ingestion rejects wrong/missing Origin or Sec-Fetch-Site, wrong methods and form bodies',async()=>{const {env,cookie}=await authFixture();for(const headers of [{Origin:'https://wrong.invalid','Sec-Fetch-Site':'same-origin'},{Origin:'https://fixture.invalid'},{'Sec-Fetch-Site':'same-origin'},{Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-site'}]){const response=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...headers},body:'{}'}),env);assert.equal(response.status,403);}assert.equal((await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{headers:{Cookie:cookie}}),env)).status,405);const form=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers:{Cookie:cookie,Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-origin','Content-Type':'text/plain'},body:'{}'}),env);assert.equal(form.status,415);});
test('authenticated same-origin upload persists live registry and readData uses it rather than static BOOKING_MAP',async()=>{const {env,cookie}=await authFixture();const orders=currentMap('boataround'),entry=orders.find(order=>order.booking_id==='280707');entry.start='2026-10-18';entry.end='2026-10-25';const now=new Date().toISOString(),body=snapshot('boataround',orders,now,'http-real-run');body.scope.from_day='2026-09-08';const response=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers:{Cookie:cookie,Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({schema_version:1,snapshots:[body]})}),env);assert.equal(response.status,200);const read=await worker.readData(env),found=read.boats.flatMap(boat=>boat.bookings).find(order=>order.source==='boataround'&&order.booking_id==='280707');assert.equal(found.start,'2026-10-18');assert.equal(found.end,'2026-10-25');assert.equal(read.order_sync.platforms.boataround.last_success_at,new Date(now).toISOString());assert.equal(read.order_sync.automatic_enabled,false);});
test('trusted internal application uses the same validated persistence path without an HTTP bypass',async()=>{const {env}=await authFixture();const body=snapshot('clickandboat',[],new Date().toISOString(),'trusted-alarm-future');body.scope.from_day='2026-09-08';body.pagination={complete:true,total_pages:1,pages_read:[1],listed_count:0};await worker.applyTrustedOrderSnapshots(env,{schema_version:1,snapshots:[body]});const data=await worker.readData(env);assert.deepEqual(Array.from(data.boats.flatMap(boat=>boat.bookings).filter(order=>order.source==='clickandboat'&&order.end>'2026-09-08'),order=>order.booking_id),['1000000']);const raw=await(await env.BUCKET.get(ORDER_SYNC_PREFIX+'clickandboat.json')).json();assert.equal(raw.records.filter(order=>order.end>'2026-09-08').length,0);});
test('public refresh response returns the newest concurrently ingested order map even if every public fetch fails',async()=>{const {env}=await authFixture();await worker.readData(env);let updated=false;const result=await worker.refreshData(env,async()=>{if(!updated){updated=true;const orders=currentMap('boataround');Object.assign(orders.find(order=>order.booking_id==='280707'),{status:'cancelled',platform_status:'CANCELLED'});const body=snapshot('boataround',orders,new Date().toISOString(),'during-public-refresh');body.scope.from_day='2026-09-08';await worker.applyTrustedOrderSnapshots(env,{schema_version:1,snapshots:[body]});}return new Response('',{status:503});});assert.ok(!result.boats.flatMap(boat=>boat.bookings).some(order=>order.source==='boataround'&&order.booking_id==='280707'));assert.equal(result.order_sync.platforms.boataround.mode,'dynamic');assert.ok(result.warning);const again=await worker.readData(env);assert.ok(!again.boats.flatMap(boat=>boat.bookings).some(order=>order.source==='boataround'&&order.booking_id==='280707'));});
test('ingestion rejects oversized bodies and invalid JSON before changing dynamic data',async()=>{const {env,cookie}=await authFixture();const headers={Cookie:cookie,Origin:'https://fixture.invalid','Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};const large=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers:{...headers,'Content-Length':String(901*1024)},body:'{}'}),env);assert.equal(large.status,413);const invalid=await worker.server_default.fetch(new Request('https://fixture.invalid/api/order-sync',{method:'POST',headers,body:'invalid-json'}),env);assert.equal(invalid.status,400);});

// These identities and amounts are intentionally synthetic. They are not an
// assertion that any real booking has paid, and never modify the bootstrap map.
function syntheticPaid(source){
 const booking_id={boataround:'99000001',clickandboat:'99000002',samboat:'99000003'}[source];
 const record={source,booking_id,boataround_slug:slugs[0],start:'2026-11-01',end:'2026-11-07',
  verified_at:'2026-09-09T00:00:00Z',amount:'€120.00',amount_basis:'Synthetic unit-test amount',verification_source:'Synthetic unit-test evidence'};
 if(source==='boataround')return {...record,detail_id:'ffffffffffffffffffffffff',url:'https://partner.boataround.com/en/000000000000000000000000/orders/ffffffffffffffffffffffff',status:'deposit_paid',platform_status:'CONFIRMED',customer_payment:'PARTIALLY PAID',agency_payment:'NOT PAID'};
 if(source==='clickandboat')return {...record,url:`https://www.clickandboat.com/uk/booking/${booking_id}/detail`,status:'accepted',platform_status:'Accepted',customer_payment_verified:true,customer_paid_amount:40,customer_balance_amount:80,customer_total_online_amount:120,customer_payment_verification_source:'Synthetic unit-test payment response'};
 return {...record,url:`https://www.samboat.com/private/reservation/${booking_id}`,status:'deposit_paid',platform_status:'Deposit paid'};
}

test('BA live workflow snapshots require exact customer payment evidence and preserve workflow state',async()=>{
 for(const platform_status of ['CONFIRMED','NEW','IN PROCESS'])for(const [status,customer_payment] of [['paid','PAID'],['deposit_paid','PARTIALLY PAID']]){
  const f=fixture(),record={...syntheticPaid('boataround'),platform_status,status,customer_payment};
  assert.equal((await f.registry.ingestSnapshot(snapshot('boataround',[record]))).accepted,true);
  const stored=(await f.make().registry()).boataround.find(r=>r.booking_id===record.booking_id);
  assert.equal(stored.platform_status,platform_status);assert.equal(stored.customer_payment,customer_payment);
 }
 for(const delta of [{customer_payment:'NOT PAID'},{customer_payment:'REFUNDED'},{customer_payment:undefined},
  {platform_status:'COMPLETED'},{platform_status:'CANCELLED'},{platform_status:undefined},{platform_status:'UNKNOWN'},
  {status:'paid',customer_payment:'PARTIALLY PAID'},{status:'deposit_paid',customer_payment:'PAID'}]){
  const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot('boataround',[{...syntheticPaid('boataround'),...delta}])),error=>error.status===422);
  assert.equal((await f.registry.status()).platforms.boataround.last_success_at,null);
 }
});

test('new CB active snapshots need positive verified customer payment and retain the real audit fields',async()=>{
 const f=fixture(),record=syntheticPaid('clickandboat');
 await f.registry.ingestSnapshot(snapshot('clickandboat',[record]));
 const stored=(await f.make().registry()).clickandboat.find(order=>order.booking_id===record.booking_id);
 for(const key of ['customer_payment_verified','customer_paid_amount','customer_balance_amount','customer_total_online_amount','customer_payment_verification_source','platform_status'])assert.equal(stored[key],record[key]);
 for(const delta of [{customer_payment_verified:false},{customer_payment_verified:'true'},{customer_payment_verified:undefined},
  {customer_paid_amount:0},{customer_paid_amount:-1},{customer_paid_amount:'40'},{customer_paid_amount:NaN},{customer_paid_amount:Infinity},
  {status:'deposit_paid'},{platform_status:'Cancelled'},{customer_balance_amount:'80'}]){
  const fresh=fixture();await assert.rejects(fresh.registry.ingestSnapshot(snapshot('clickandboat',[{...record,...delta}])),error=>error.status===422);
 }
});

test('new SamBoat active snapshots accept only observed explicit deposit-paid labels',async()=>{
 for(const platform_status of ['Deposit paid','Validated / Deposit Paid','DEPOSIT_PAID']){
  const f=fixture();assert.equal((await f.registry.ingestSnapshot(snapshot('samboat',[{...syntheticPaid('samboat'),platform_status}]))).accepted,true);
 }
 for(const delta of [{platform_status:'Confirmed'},{platform_status:'Pre-paid'},{platform_status:'Completed'},
  {platform_status:'Cancelled'},{platform_status:undefined},{status:'accepted'}]){
  const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot('samboat',[{...syntheticPaid('samboat'),...delta}])),error=>error.status===422);
 }
});

test('inactive and cancelled snapshots replace previously paid orders without requiring stale financial fields',async()=>{
 for(const source of ['boataround','clickandboat','samboat']){
  for(const status of ['pending','cancelled']){
   const f=fixture(),record=syntheticPaid(source);
   await f.registry.ingestSnapshot(snapshot(source,[record]));
   const inactive={...record,status,platform_status:status==='cancelled'?'CANCELLED':'PENDING',customer_payment:'REFUNDED',customer_payment_verified:true,customer_paid_amount:'stale prior payment'};
   delete inactive.amount;
   await f.registry.ingestSnapshot(snapshot(source,[inactive],'2026-09-09T01:00:00Z','inactive'));
   const stored=(await f.make().registry())[source].find(order=>order.booking_id===record.booking_id);
   assert.equal(stored.status,status);assert.equal(active(await f.registry.registry(),source).some(order=>order.booking_id===record.booking_id),false);
   assert.equal(Object.hasOwn(stored,'customer_paid_amount'),false);
  }
 }
});

test('cancelled snapshots need a matching current platform cancellation and preserve that proof',async()=>{
 for(const source of ['boataround','clickandboat','samboat']){
  const original=syntheticPaid(source);
  for(const platform_status of [undefined,null,'',original.platform_status,'Completed','Request cancellation','REFUNDED']){
   const f=fixture();await f.registry.ingestSnapshot(snapshot(source,[original]));
   const contradictory={...original,status:'cancelled',platform_status};
   const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot(source,[contradictory],'2026-09-09T01:00:00Z','conflicting-cancel')]});
   assert.equal(receipt.results[0].accepted,false);
   assert.equal(receipt.results[0].status,422);
   const stored=(await f.make().registry())[source].find(record=>record.booking_id===original.booking_id);
   assert.equal(stored.status,original.status,'Conflicting cancellation must retain paid occupancy');
   assert.equal(receipt.order_sync.platforms[source].last_error,'schema_changed');
  }
  for(const platform_status of ['Cancelled','CANCELED',' cancelled ']){
   const f=fixture();const cancelled={...original,status:'cancelled',platform_status};
   delete cancelled.amount;
   await f.registry.ingestSnapshot(snapshot(source,[cancelled]));
   const stored=(await f.make().registry())[source].find(record=>record.booking_id===original.booking_id);
   assert.equal(stored.status,'cancelled');assert.equal(stored.platform_status,platform_status);
  }
 }
});

test('older paid snapshots and identical old run replays cannot revive a newer cancellation',async()=>{
 for(const source of ['boataround','clickandboat','samboat']){
  const f=fixture(),record=syntheticPaid(source),originalPaid=snapshot(source,[record]);
  await f.registry.ingestSnapshot(originalPaid);
  await f.registry.ingestSnapshot(snapshot(source,[{...record,status:'cancelled',platform_status:'CANCELLED'}],'2026-09-09T02:00:00Z','cancelled-later'));
  for(const replay of [originalPaid,snapshot(source,[record],'2026-09-09T01:00:00Z','delayed-paid')]){
   const receipt=await f.registry.ingestSnapshot(replay);assert.equal(receipt.accepted,false);assert.equal(receipt.ignored,'older_snapshot');
  }
  assert.equal((await f.make().registry())[source].find(order=>order.booking_id===record.booking_id).status,'cancelled');
 }
});

test('bootstrap and already stored verified records remain readable without retroactive payment gates or writes',async()=>{
 const f=fixture();await f.registry.status();
 const baseline=(await f.registry.registry()).clickandboat;
 assert.ok(baseline.some(record=>record.status==='accepted'&&!Object.hasOwn(record,'customer_paid_amount')));
 const key=ORDER_SYNC_PREFIX+'clickandboat.json',prior=f.store.files.get(key);
 const legacy=JSON.parse(prior.value);legacy.mode='dynamic';legacy.last_success_at='2026-09-08T06:00:00.000Z';
 await f.store.put(key,JSON.stringify(legacy));
 const before={...f.store.files.get(key)};
 const after=await f.make().registry();
 assert.deepEqual(after.clickandboat,baseline);
 assert.deepEqual(f.store.files.get(key),before);
});

test('complete SamBoat snapshots preserve the two documented deposit-paid aliases',async()=>{
 for(const platform_status of ['Deposit paid only','Validated/Deposit paid']){
  const f=fixture(),order={...syntheticPaid('samboat'),platform_status};
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('samboat',[order])]});
  assert.equal(receipt.results[0].accepted,true,platform_status);assert.equal(receipt.results[0].outcome,'success');
  const saved=(await f.make().registry()).samboat.find(row=>row.booking_id===order.booking_id);
  assert.equal(saved.status,'deposit_paid');assert.equal(saved.platform_status,platform_status);
  assert.equal(receipt.order_sync.platforms.samboat.last_error,null);
 }
});

test('deposit aliases cannot authorize full payment, cancellation, or unknown payment variants',async()=>{
 for(const delta of [
  {status:'paid',platform_status:'Deposit paid only'},
  {status:'paid',platform_status:'Validated/Deposit paid'},
  {status:'cancelled',platform_status:'Deposit paid only'},
  {status:'deposit_paid',platform_status:'Deposit paid only / refunded'},
  {status:'deposit_paid',platform_status:'Validated/Deposit unpaid'},
  {status:'deposit_paid',platform_status:'Pre-paid: answer'},
  {status:'deposit_paid',platform_status:'Refunded'},
  {status:'deposit_paid',platform_status:'Deposit paid maybe'}
 ]){
  const f=fixture(),order=syntheticPaid('samboat');await f.registry.ingestSnapshot(snapshot('samboat',[order]));
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('samboat',[{...order,...delta}],'2026-09-09T01:00:00Z','bad-alias')]});
  assert.equal(receipt.results[0].accepted,false,JSON.stringify(delta));assert.equal(receipt.results[0].status,422);
  const saved=(await f.make().registry()).samboat.find(row=>row.booking_id===order.booking_id);
  assert.equal(saved.status,'deposit_paid');assert.equal(saved.platform_status,'Deposit paid');
  assert.equal(receipt.order_sync.platforms.samboat.last_success_at,'2026-09-09T00:00:00.000Z');
 }
});

test('malformed record fields get a permanent schema failure receipt without losing the last valid source orders',async()=>{
 const invalidFields=[
  {booking_id:'not-an-order'}, {status:'new-unknown-state'},
  {start:'not-a-date'}, {end:'2026-10-01'}, {verified_at:'not-a-timestamp'}
 ];
 for(const source of ['boataround','clickandboat','samboat'])for(const delta of invalidFields){
  const f=fixture(),record=syntheticPaid(source);
  await f.registry.ingestSnapshot(snapshot(source,[record]));
  // A failed CB source intentionally marks its authorized manual projection
  // needs_review; ordinary source records must remain byte-for-byte unchanged.
  const readRecords=async()=>(await f.make().registry())[source].filter(order=>!order.manual_adjustment);
  const before=await readRecords();
  const malformed=snapshot(source,[{...record,...delta}],'2026-09-09T01:00:00Z','malformed-record');
  const result=await f.registry.ingestBatch({schema_version:1,snapshots:[malformed]});
  const receipt=result.results[0];
  assert.equal(receipt.status,422,`${source}: ${JSON.stringify(delta)}`);
  assert.equal(receipt.accepted,false);
  assert.equal(receipt.failure_receipt?.accepted,true);
  assert.equal(receipt.failure_receipt?.run_id,malformed.run_id);
  assert.equal(receipt.failure_receipt?.error_code,'schema_changed');
  assert.deepEqual(await readRecords(),before);
  assert.equal(result.order_sync.platforms[source].last_error,'schema_changed');
  assert.equal(result.order_sync.platforms[source].last_success_at,'2026-09-09T00:00:00.000Z');
  const retried=await f.registry.ingestBatch({schema_version:1,snapshots:[malformed]});
  assert.equal(retried.results[0].failure_receipt?.idempotent,true);
  assert.deepEqual(await readRecords(),before);
 }
});

test('unexpected normalizer runtime failure stays retryable and does not consume a valid run ID',async()=>{
 const f=fixture(),record=syntheticPaid('boataround');
 await f.registry.ingestSnapshot(snapshot('boataround',[record]));
 let broken=true;
 const registry=createOrderRegistry({bucket:f.store,fleetSpecs:clone(worker.FLEET_SPECS),bootstrapMap:clone(original.BOOKING_MAP),
  now:()=>Date.parse('2026-09-10T00:00:00Z'),normalizeBooking:(source,input)=>{
   if(broken&&input.booking_id===record.booking_id)throw new Error('Synthetic unexpected normalizer runtime error');
   return worker.normalizeBooking(source,input);
  }});
 const next=snapshot('boataround',[record],'2026-09-09T01:00:00Z','valid-after-runtime-failure');
 const failed=await registry.ingestBatch({schema_version:1,snapshots:[next]});
 assert.equal(failed.results[0].status,503);
 assert.equal(failed.results[0].failure_receipt,undefined);
 assert.equal(failed.order_sync.platforms.boataround.last_error,null);
 broken=false;
 const recovered=await registry.ingestBatch({schema_version:1,snapshots:[next]});
 assert.equal(recovered.results[0].accepted,true);
 assert.equal(recovered.results[0].outcome,'success');
});
