'use strict';
// NauSYS as the fifth order source (user decision 2026-10-09): the registry
// keeps complete NauSYS snapshots and accepts an agency's Reservation or
// Option without payment evidence. Its link is NauSYS's reservation list.
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
function fixture(){const store=bucket();const make=()=>createOrderRegistry({bucket:store,normalizeBooking:worker.normalizeBooking,fleetSpecs:clone(original.FLEET_SPECS),bootstrapMap:clone(original.BOOKING_MAP),now:()=>Date.parse('2026-10-09T22:10:00Z')});return {store,make,registry:make()};}
const slugs=original.FLEET_SPECS.map(boat=>boat.boataround_slug);
const AD5='grandcat-55-tidewyn-discovery-5',LIST='https://app.nausys.com/NauSYS-app/app/yachtReservations.xhtml';
const order=(id,change={})=>({source:'nausys',booking_id:id,boataround_slug:AD5,start:'2027-02-27',end:'2027-03-06',status:'accepted',platform_status:'Option',
 payment_basis:'nausys_agency',url:LIST,amount:null,amount_basis:'NauSYS 列表不显示价格，未计入',verified_at:'2026-10-09T22:00:00.000Z',...change});
function snapshot(source,orders,checked_at='2026-10-09T22:00:00Z',run_id='nausys-run'){return {source,run_id,checked_at,complete:true,expected_count:orders.length,
 scope:{kind:'current_future',from_day:'2026-10-09',fleet_slugs:[...slugs]},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length},orders};}

test('NauSYS is the fifth registry source and starts with no orders until its first complete read',async()=>{
 assert.deepEqual(ORDER_SYNC_SOURCES,['boataround','clickandboat','samboat','mmk','nausys']);
 const f=fixture(),state=await f.registry.status(),map=await f.registry.registry();
 assert.equal(state.platforms.nausys.mode,'bootstrap');assert.equal(state.platforms.nausys.last_error,'awaiting_first_sync');assert.deepEqual(map.nausys,[]);
});

test('an agency Option, Reservation and expired Option are stored with NauSYS labels; payment is not required',async()=>{
 const f=fixture();
 const orders=[order('952814834'),order('952797145',{platform_status:'Reservation',boataround_slug:'seacat-open-40-tidewyn-discovery-2',start:'2027-01-23',end:'2027-01-30'}),
  order('952784750',{status:'cancelled',platform_status:'Option expired',payment_basis:undefined,boataround_slug:'reef-cat-37-tidewyn-discovery',start:'2026-12-11',end:'2026-12-18'})];
 const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('nausys',orders)]});
 assert.equal(receipt.results[0].accepted,true,JSON.stringify(receipt.results[0]));assert.equal(receipt.order_sync.platforms.nausys.mode,'dynamic');
 const stored=(await f.make().registry()).nausys;
 const option=stored.find(o=>o.booking_id==='952814834');
 assert.equal(option.status,'accepted');assert.equal(option.payment_basis,'nausys_agency');assert.equal(option.platform_status,'Option');
 assert.equal(option.url,LIST);assert.equal(option.boataround_slug,AD5);
 assert.equal(stored.find(o=>o.booking_id==='952797145').platform_status,'Reservation');
 const expired=stored.find(o=>o.booking_id==='952784750');assert.equal(expired.status,'cancelled');assert.equal(expired.platform_status,'Option expired');
});

test('a NauSYS order without the exact basis, label, link or boat is refused and keeps the previous orders',async()=>{
 const f=fixture();await f.registry.ingestSnapshot(snapshot('nausys',[order('1')]));
 let minute=10;
 for(const bad of [{payment_basis:undefined},{payment_basis:'mmk_client_assigned'},{platform_status:'Information'},{status:'paid'},
  {url:LIST+'?id=1'},{url:'https://app.nausys.com/NauSYS-app/app/bookinglist.xhtml'},{boataround_slug:'unknown-boat'},
  {status:'cancelled',platform_status:'Pending',payment_basis:undefined}]){
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot('nausys',[order('1',bad)],'2026-10-09T22:'+minute+':00Z','bad-'+minute)]});
  minute++;
  assert.equal(receipt.results[0].accepted,false,JSON.stringify(bad));
  assert.deepEqual((await f.make().registry()).nausys.map(o=>[o.booking_id,o.status]),[['1','accepted']]);
 }
});

test('"all platforms" needs NauSYS too',async()=>{
 const f=fixture(),empty=source=>snapshot(source,[],'2026-10-09T22:00:00Z','run-'+source);
 const four=await f.registry.ingestBatch({schema_version:1,snapshots:['boataround','clickandboat','samboat','mmk'].map(empty)});
 assert.equal(four.order_sync.last_all_platforms_success_at,null);
 const five=await f.registry.ingestBatch({schema_version:1,snapshots:[empty('nausys')]});
 assert.equal(five.order_sync.last_all_platforms_success_at,'2026-10-09T22:00:00.000Z');
});

test('the dashboard shows the NauSYS order on its boat with the list link and its state',()=>{
 const boats=clone(original.FLEET_SPECS).map(boat=>({...boat,sources:{},bookings:[]}));
 const result=worker.applyBookingRegistry({boats},{boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[order('952814834')]});
 assert.equal(result.booking_mapping_complete,true);
 const shown=clone(result.boats.find(boat=>boat.boataround_slug===AD5).bookings);
 assert.deepEqual(shown.map(b=>[b.source,b.booking_id,b.start,b.end,b.status,b.platform_status,b.url,b.link_issue]),
  [['nausys','952814834','2027-02-27','2027-03-06','accepted','Option',LIST,null]]);
});
