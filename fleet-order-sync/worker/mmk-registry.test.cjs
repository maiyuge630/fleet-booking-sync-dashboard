'use strict';
// MMK as the fourth order source (user decision 2026-10-04): the registry keeps
// complete MMK snapshots like the other platforms and accepts a Reservation or
// Option with a customer without payment evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const {createOrderRegistry,ORDER_SYNC_SOURCES}=require('./dynamic-registry.cjs');
const {patchOrderSync}=require('./patch-order-sync.cjs');
const baselineSource=fs.readFileSync(path.resolve(__dirname,'../../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function load(source){const c=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Response,Request,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,setTimeout,clearTimeout,console,fetch:()=>{throw Error('No live network in tests');}});vm.runInContext(source.replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),c);return c;}
const original=load(baselineSource),worker=load(patchOrderSync(baselineSource));
function bucket(){let serial=0;const files=new Map();return {files,async get(key){const entry=files.get(key);return entry?{etag:entry.etag,json:async()=>JSON.parse(entry.value)}:null;},async put(key,value,options={}){const old=files.get(key),condition=options.onlyIf;if(condition instanceof Headers&&condition.get('If-None-Match')==='*'&&old)return null;if(condition&&!(condition instanceof Headers)&&condition.etagMatches!==old?.etag)return null;const etag='fixture-'+ ++serial;files.set(key,{etag,value});return {etag};}};}
function fixture(){const store=bucket();const make=()=>createOrderRegistry({bucket:store,normalizeBooking:worker.normalizeBooking,fleetSpecs:clone(original.FLEET_SPECS),bootstrapMap:clone(original.BOOKING_MAP),now:()=>Date.parse('2026-10-04T08:10:00Z')});return {store,make,registry:make()};}
const slugs=original.FLEET_SPECS.map(boat=>boat.boataround_slug);
const AD1='reef-cat-37-tidewyn-discovery',URL_PREFIX='https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp?reservationId=';
const order=(id,change={})=>({source:'mmk',booking_id:id,boataround_slug:AD1,start:'2027-03-07',end:'2027-03-19',status:'accepted',platform_status:'Reservation',
 payment_basis:'mmk_client_assigned',url:URL_PREFIX+id,amount:'€6,322.98',amount_basis:'船东净收入（最终价格减代理佣金）',verified_at:'2026-10-04T08:00:00.000Z',...change});
function snapshot(source,orders,checked_at='2026-10-04T08:00:00Z',run_id='mmk-run'){return {source,run_id,checked_at,complete:true,expected_count:orders.length,
 scope:{kind:'current_future',from_day:'2026-10-03',fleet_slugs:[...slugs]},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length},orders};}

test('MMK is a registry source and starts with no orders until its first complete read',async()=>{
 assert.deepEqual(ORDER_SYNC_SOURCES,['boataround','clickandboat','samboat','mmk','nausys']);
 const f=fixture(),state=await f.registry.status(),map=await f.registry.registry();
 assert.equal(state.platforms.mmk.mode,'bootstrap');assert.equal(state.platforms.mmk.last_error,'awaiting_first_sync');assert.deepEqual(map.mmk,[]);
});

test('a Reservation, an Option and an expired Option are stored with MMK labels; payment is not required',async()=>{
 const f=fixture();
 const orders=[order('8889178168337030369'),order('2',{platform_status:'Option',start:'2027-05-01',end:'2027-05-08'}),
  order('3',{status:'cancelled',platform_status:'Option expired',payment_basis:undefined,amount:null})];
 const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('mmk',orders)]});
 assert.equal(receipt.results[0].accepted,true);assert.equal(receipt.order_sync.platforms.mmk.mode,'dynamic');
 const stored=(await f.make().registry()).mmk;
 const reservation=stored.find(o=>o.booking_id==='8889178168337030369');
 assert.equal(reservation.status,'accepted');assert.equal(reservation.payment_basis,'mmk_client_assigned');assert.equal(reservation.platform_status,'Reservation');
 assert.equal(reservation.url,URL_PREFIX+'8889178168337030369');assert.equal(reservation.boataround_slug,AD1);assert.equal(reservation.amount,'€6,322.98');
 assert.equal(stored.find(o=>o.booking_id==='2').platform_status,'Option');
 const expired=stored.find(o=>o.booking_id==='3');assert.equal(expired.status,'cancelled');assert.equal(expired.platform_status,'Option expired');
});

test('an MMK order without the exact basis, label or link is refused and keeps the previous orders',async()=>{
 const f=fixture();await f.registry.ingestSnapshot(snapshot('mmk',[order('1')]));
 let hour=9;
 for(const bad of [{payment_basis:undefined},{payment_basis:'platform_accepted'},{platform_status:'Offer'},{status:'paid'},
  {url:URL_PREFIX+'999'},{url:'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp'},{boataround_slug:'unknown-boat'},
  {status:'cancelled',platform_status:'Pending',payment_basis:undefined}]){
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('mmk',[order('1',bad)],'2026-10-04T0'+hour+':00:00Z','bad-'+hour)]});
  hour++;
  assert.equal(receipt.results[0].accepted,false,JSON.stringify(bad));
  assert.deepEqual((await f.make().registry()).mmk.map(o=>[o.booking_id,o.status]),[['1','accepted']]);
 }
});

test('a batch may carry all four sources, and "all platforms" needs MMK too',async()=>{
 const f=fixture(),empty=source=>snapshot(source,[],'2026-10-04T08:00:00Z','run-'+source);
 const others=await f.registry.ingestBatch({schema_version:1,snapshots:['boataround','clickandboat','samboat','nausys'].map(empty)});
 assert.equal(others.order_sync.last_all_platforms_success_at,null);
 const all=await f.registry.ingestBatch({schema_version:1,snapshots:[empty('mmk')]});
 assert.equal(all.order_sync.last_all_platforms_success_at,'2026-10-04T08:00:00.000Z');
 await assert.rejects(f.registry.ingestBatch({schema_version:1,snapshots:[...ORDER_SYNC_SOURCES,'boataround'].map(empty)}),/格式无效/);
});

test('the dashboard shows the MMK order on its boat with the MMK link and state',()=>{
 const boats=clone(original.FLEET_SPECS).map(boat=>({...boat,sources:{},bookings:[]}));
 const result=worker.applyBookingRegistry({boats},{boataround:[],clickandboat:[],samboat:[],mmk:[order('8889178168337030369',{platform_status:'Option'})],nausys:[]});
 assert.equal(result.booking_mapping_complete,true);
 const shown=clone(result.boats.find(boat=>boat.boataround_slug===AD1).bookings);
 assert.deepEqual(shown.map(b=>[b.source,b.booking_id,b.start,b.end,b.status,b.platform_status,b.url,b.link_issue]),
  [['mmk','8889178168337030369','2027-03-07','2027-03-19','accepted','Option',URL_PREFIX+'8889178168337030369',null]]);
 // Without an MMK list the registry is incomplete (kept orders stay, never silently dropped).
 assert.equal(worker.applyBookingRegistry({boats:clone(boats)},{boataround:[],clickandboat:[],samboat:[],nausys:[]}).booking_mapping_complete,false);
});
