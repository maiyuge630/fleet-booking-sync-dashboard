'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {createOrderRegistry}=require('./dynamic-registry.cjs');
const {patchOrderSync}=require('./patch-order-sync.cjs');
const original=fs.readFileSync(path.resolve(__dirname,'../../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const worker=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Request,Response,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal});
vm.runInContext(patchOrderSync(original).replace(/^import[^\n]+\n/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),worker);
const clone=value=>JSON.parse(JSON.stringify(value));
const now=Date.parse('2026-09-10T06:00:00Z');
function fixture(){
 const files=new Map();let serial=0;
 const bucket={async get(key){const f=files.get(key);return f?{etag:f.etag,json:async()=>JSON.parse(f.value)}:null;},async put(key,value,{onlyIf}={}){const f=files.get(key);if(onlyIf instanceof Headers&&f)return null;if(onlyIf?.etagMatches&&onlyIf.etagMatches!==f?.etag)return null;const etag=String(++serial);files.set(key,{value,etag});return {etag};}};
 const registry=createOrderRegistry({bucket,normalizeBooking:worker.normalizeBooking,fleetSpecs:clone(worker.FLEET_SPECS),bootstrapMap:{schema_version:2,boataround:[],clickandboat:[],samboat:[]},now:()=>now});
 const ui=vm.createContext({document:{getElementById(){return {addEventListener(){},value:'',textContent:'',innerHTML:''};},querySelectorAll(){return [];}},window:{addEventListener(){}},console});
 vm.runInContext(worker.HTML.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/initialize\(\);\s*$/,''),ui);
 return {registry,async visible(source,bookingId){const data=worker.applyBookingRegistry(clone(worker.SEED),await registry.registry());const bookings=data.boats.flatMap(boat=>boat.bookings).filter(record=>record.source===source&&(!bookingId||record.booking_id===bookingId));ui.fixture={bookings};return {orders:vm.runInContext('activeBookings(fixture)',ui),blocks:vm.runInContext('knownBlocks(fixture)',ui)};}};
}
const slug='seacat-open-40-tidewyn-discovery-2';
function paid(source){
 const booking_id={boataround:'990001',clickandboat:'990002',samboat:'990003'}[source];
 const record={booking_id,boataround_slug:slug,start:'2026-10-17',end:'2026-10-24',verified_at:'2026-09-10T05:30:00Z',amount:'€100.00',amount_basis:'synthetic test only'};
 if(source==='boataround')return {...record,status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID',detail_id:'000000000000000000000001',url:'https://partner.boataround.com/en/000000000000000000000000/orders/000000000000000000000001'};
 if(source==='clickandboat')return {...record,status:'accepted',platform_status:'Accepted',customer_payment_verified:true,customer_paid_amount:10,customer_balance_amount:90,customer_total_online_amount:100,customer_payment_verification_source:'synthetic fixture',url:'https://www.clickandboat.com/uk/booking/'+booking_id+'/detail'};
 return {...record,status:'deposit_paid',platform_status:'Deposit paid',url:'https://www.samboat.com/private/reservation/'+booking_id};
}
function snapshot(source,orders,minute,complete=true){return {source,run_id:'synthetic-'+source+'-'+minute,checked_at:'2026-09-10T05:'+String(minute).padStart(2,'0')+':00Z',complete,expected_count:orders.length,orders,scope:{kind:'current_future',from_day:'2026-09-10',fleet_slugs:worker.FLEET_SPECS.map(boat=>boat.boataround_slug)},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length}};}
for(const source of ['boataround','clickandboat','samboat']){
 test(source+': checkout day remains current for new paid orders, cancellation and disappearance',async()=>{
  const record={...paid(source),start:'2026-09-03',end:'2026-09-10'};
  const f=fixture();
  await f.registry.ingestSnapshot(snapshot(source,[record],30));
  assert.equal((await f.registry.registry())[source].find(order=>order.booking_id===record.booking_id)?.status,record.status);
  await f.registry.ingestSnapshot(snapshot(source,[{...record,status:'cancelled',platform_status:'Cancelled'}],32));
  assert.equal((await f.registry.registry())[source].find(order=>order.booking_id===record.booking_id)?.status,'cancelled');
  const disappeared=fixture();
  await disappeared.registry.ingestSnapshot(snapshot(source,[record],30));
  await disappeared.registry.ingestSnapshot(snapshot(source,[],32));
  assert.equal((await disappeared.registry.registry())[source].find(order=>order.booking_id===record.booking_id),undefined,
    'today checkout cannot be carried as an untouched historical paid record');
 });
 test(source+': paid to cancelled removes both detail and calendar; old paid replay cannot restore',async()=>{
  const f=fixture(),record=paid(source);await f.registry.ingestSnapshot(snapshot(source,[record],30));
  let view=await f.visible(source,record.booking_id);assert.equal(view.orders.length,1);assert.equal(view.blocks.length,1);assert.equal(view.blocks[0].end,'2026-10-23');
  await f.registry.ingestSnapshot(snapshot(source,[{...record,status:'cancelled',platform_status:'Cancelled'}],32));
  view=await f.visible(source,record.booking_id);assert.equal(view.orders.length,0);assert.equal(view.blocks.length,0);
  if(source==='clickandboat')assert.deepEqual(Array.from((await f.visible(source)).orders,order=>order.booking_id),['1000000']);
  const stale=await f.registry.ingestSnapshot(snapshot(source,[record],31));assert.equal(stale.ignored,'older_snapshot');
  await f.registry.ingestSnapshot({source,run_id:'synthetic-later-failure-'+source,checked_at:'2026-09-10T05:33:00Z',outcome:'failure',error_code:'fetch_failed'});
  assert.equal((await f.visible(source,record.booking_id)).blocks.length,0);
 });
 test(source+': positive historical amounts cannot make current unpaid/pending occupy',async()=>{
  const f=fixture(),record=paid(source);await f.registry.ingestSnapshot(snapshot(source,[record],30));
  await f.registry.ingestSnapshot(snapshot(source,[{...record,status:'pending',platform_status:'Pending',customer_payment:'NOT PAID',customer_payment_verified:false,customer_paid_amount:0}],32));
  assert.equal((await f.visible(source,record.booking_id)).orders.length,0);assert.equal((await f.visible(source,record.booking_id)).blocks.length,0);
 });
 test(source+': only a full successful empty snapshot removes missing current orders',async()=>{
  const f=fixture(),record=paid(source);await f.registry.ingestSnapshot(snapshot(source,[record],30));
  const incomplete=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot(source,[],31,false)]});assert.equal(incomplete.results[0].accepted,false);assert.equal((await f.visible(source,record.booking_id)).blocks.length,1);
  await f.registry.ingestSnapshot(snapshot(source,[],32));assert.equal((await f.visible(source,record.booking_id)).blocks.length,0);
 });
}
