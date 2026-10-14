'use strict';
// Synthetic fixtures only. Exercise the real patched Worker and persistent
// registry; no browser, account or platform write is involved in this suite.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {createOrderRegistry}=require('./dynamic-registry.cjs');
const {patchOrderSync}=require('./patch-order-sync.cjs');
const {extractHTML}=require('../../cloudflare-migration/frontend-patch.cjs');
const {patchPhoneAgent}=require('../phone-agent-patch.cjs');
const {patchBookingConflicts}=require('../booking-conflicts-patch.cjs');
const {patchManualReschedule}=require('../manual-reschedule-patch.cjs');
const {patchVoltage}=require('../voltage-patch.cjs');
const {patchReverse}=require('../reverse-sync/frontend-patch.cjs');
const {patchCheckoutDay}=require('../checkout-day-patch.cjs');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const clone=value=>JSON.parse(JSON.stringify(value));
const baseline=fs.readFileSync(path.resolve(__dirname,'../../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const worker=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Request,Response,Headers,URL,URLSearchParams,
  structuredClone,crypto:webcrypto,AbortSignal,fetch:()=>{throw Error('No live requests in day-trip tests');}});
vm.runInContext(patchOrderSync(baseline).replace(/^import[^\n]+\n/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),worker);
// Apply the current UI generators in production order without generating or
// replacing build artifacts owned by the deployment task.
let uiSource=fs.readFileSync(path.resolve(__dirname,'../phone-agent-build/baseline-integrated-source.mjs'),'utf8');
for(const patch of [patchPhoneAgent,patchBookingConflicts,patchManualReschedule,patchVoltage,patchReverse,patchCheckoutDay])uiSource=patch(uiSource);
const uiScript=extractHTML(uiSource).match(/<script>([\s\S]*?)<\/script>/)[1];
const DAY='2026-09-26',SOURCE='samboat',ID='990040',SLUG='seacat-open-40-tidewyn-discovery-2';
const FLEET=clone(worker.FLEET_SPECS);
const checked=minute=>`2026-09-15T05:${String(minute).padStart(2,'0')}:00.000Z`;
function order(extra={}) {return {booking_id:ID,boataround_slug:SLUG,start:DAY,end:DAY,
  status:'pending',platform_status:'Pre-paid: answer',verified_at:checked(30),
  amount:'€100.00',amount_basis:'synthetic fixture',url:`https://www.samboat.com/private/reservation/${ID}`,...extra};}
function snapshot(orders,minute=30,extra={}) {return {source:SOURCE,run_id:'daytrip-'+minute,checked_at:checked(minute),complete:true,
  expected_count:orders.length,orders,scope:{kind:'current_future',from_day:'2026-09-15',fleet_slugs:FLEET.map(b=>b.boataround_slug)},
  pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length},...extra};}
function fixture() {
  const files=new Map();let serial=0;
  const bucket={async get(key){const f=files.get(key);return f?{etag:f.etag,json:async()=>JSON.parse(f.value)}:null;},
    async put(key,value,{onlyIf}={}){const f=files.get(key);if(onlyIf instanceof Headers&&f)return null;
      if(onlyIf?.etagMatches&&onlyIf.etagMatches!==f?.etag)return null;
      const etag=String(++serial);files.set(key,{value,etag});return {etag};}};
  const make=()=>createOrderRegistry({bucket,normalizeBooking:worker.normalizeBooking,fleetSpecs:FLEET,
    bootstrapMap:{schema_version:2,boataround:[],clickandboat:[],samboat:[]},now:()=>Date.parse(checked(59))});
  const registry=make();
  return {registry,make,async record(){return (await make().registry()).samboat.find(r=>r.booking_id===ID);},
    async visible(){const data=worker.applyBookingRegistry(clone(worker.SEED),await make().registry());
      return data.boats.flatMap(b=>b.bookings).filter(r=>r.source===SOURCE&&r.booking_id===ID);}};
}

function page(bookings) {
  const nodes=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,value:'',textContent:'',dataset:{},open:false,disabled:false,addEventListener(){}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(){}};
  class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-09-15T05:00:00Z']));}static now(){return Date.parse('2026-09-15T05:00:00Z');}}
  const context=vm.createContext({document,window:{addEventListener(){}},Date:Clock,URL,setTimeout(){},clearTimeout(){},AbortController,console});
  vm.runInContext(uiScript.replace(/\binitialize\(\);\s*$/,''),context);
  context.fixture={name:'Synthetic AD2',boataround_slug:SLUG,sources:{},bookings};vm.runInContext('DATA={boats:[fixture]};',context);
  return {context,document};
}

test('SamBoat pending day trip is fully accepted without inventing a next-day checkout or showing occupancy',async()=>{
  const f=fixture();const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot([order()])]});
  assert.equal(receipt.results[0].accepted,true);
  const saved=await f.record();assert.equal(saved.start,DAY);assert.equal(saved.end,DAY);assert.equal(saved.status,'pending');
  assert.equal((await f.visible()).length,0);
  assert.equal((await f.make().status()).platforms.samboat.last_error,null);
});

test('SamBoat same-day payment, cancellation, stale replay and collection failure preserve the payment lifecycle',async()=>{
  const f=fixture();await f.registry.ingestSnapshot(snapshot([order()]));
  const paid=order({status:'deposit_paid',platform_status:'Validated / Deposit Paid',verified_at:checked(31)});
  await f.registry.ingestSnapshot(snapshot([paid],31));
  assert.equal((await f.visible()).length,1);assert.equal((await f.record()).end,DAY);
  await f.registry.ingestSnapshot(snapshot([order({status:'cancelled',platform_status:'Cancelled',verified_at:checked(33)})],33));
  assert.equal((await f.record()).status,'cancelled');assert.equal((await f.record()).end,DAY);
  assert.equal((await f.visible()).length,0);
  assert.equal((await f.registry.ingestSnapshot(snapshot([paid],32))).ignored,'older_snapshot');
  await f.registry.ingestSnapshot({source:SOURCE,run_id:'daytrip-failed',checked_at:checked(34),outcome:'failure',error_code:'fetch_failed'});
  assert.equal((await f.record()).status,'cancelled');assert.equal((await f.visible()).length,0);
});

test('SamBoat pending to explicit Paid stays fully paid, preserves its one-day dates and can later be cancelled',async()=>{
  const f=fixture();await f.registry.ingestSnapshot(snapshot([order()]));
  const paid=order({status:'paid',platform_status:'Paid',verified_at:checked(31)});
  await f.registry.ingestSnapshot(snapshot([paid],31));
  const saved=await f.record();assert.equal(saved.status,'paid');assert.equal(saved.platform_status,'Paid');
  assert.equal(saved.start,DAY);assert.equal(saved.end,DAY);
  const {context}=page(clone(await f.visible()));
  assert.equal(context.knownOrders(context.fixture)[0].status,'paid');
  assert.equal(context.dayStatus(context.fixture,new Date(2026,8,1)).has(DAY),true);
  await f.registry.ingestSnapshot(snapshot([order({status:'cancelled',platform_status:'Cancelled',verified_at:checked(32)})],32));
  assert.equal((await f.record()).status,'cancelled');assert.equal((await f.visible()).length,0);
  assert.equal((await f.registry.ingestSnapshot(snapshot([paid],31))).ignored,'older_snapshot');
});

test('current dashboard renders a paid day trip in details and only its real calendar date',async()=>{
  const f=fixture();await f.registry.ingestSnapshot(snapshot([order({status:'deposit_paid',platform_status:'Deposit paid'})]));
  const {context:c,document}=page(clone(await f.visible()));
  assert.equal(c.knownOrders(c.fixture).length,1);
  const days=c.dayStatus(c.fixture,new Date(2026,8,1));
  assert.equal(days.has('2026-09-25'),false);assert.equal(days.has(DAY),true);assert.equal(days.has('2026-09-27'),false);
  c.renderBoats();assert.match(document.getElementById('boats').innerHTML,/SamBoat #990040/);
  document.getElementById('d1').value=DAY;document.getElementById('d2').value='2026-09-27';c.window.checkAvail();
  assert.match(document.getElementById('result').innerHTML,/所选日期已有 1 笔有效订单/);
  document.getElementById('d1').value='2026-09-27';document.getElementById('d2').value='2026-09-28';c.window.checkAvail();
  assert.match(document.getElementById('result').innerHTML,/没有有效订单占用/);
});

test('day-trip overlap stays on the calendar while the dashboard keeps its two-day warning threshold',async()=>{
  const f=fixture();await f.registry.ingestSnapshot(snapshot([order({status:'deposit_paid',platform_status:'Deposit paid'})]));
  const bookings=clone(await f.visible());bookings.push({...bookings[0],source:'boataround',booking_id:'990041',start:'2026-09-25',end:'2026-09-27'});
  const {context:c,document}=page(bookings);
  assert.equal(c.boatBookingConflicts(c.fixture).pairs.length,1);assert.equal(c.boatBookingConflicts(c.fixture).pairs[0].nights,1);
  assert.equal(c.dashboardBookingConflicts(c.fixture).pairs.length,0);
  c.renderBoats();assert.equal(document.getElementById('booking-conflicts-overview').hidden,true);
  assert.match(c.calendar(c.fixture,new Date(2026,8,1)),/2026-09-26 不可用，疑似撞单/);
});

test('a Pre-paid request label cannot be promoted to active or authorize cancellation',async()=>{
  for(const status of ['paid','deposit_paid','accepted','cancelled']) {
    const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot([order({status})])),{status:422});
    assert.equal(await f.record(),undefined);
  }
});

test('SamBoat paid and deposit-paid labels cannot be substituted or inferred from other words',async()=>{
  for(const [status,platform_status] of [['paid','Deposit paid'],['deposit_paid','Paid'],['paid','Pre-paid'],
    ['paid','Pre-paid: answer'],['paid','Payment received'],['accepted','Paid'],['paid','Completed']]) {
    const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot([order({status,platform_status})])),{status:422});
    assert.equal(await f.record(),undefined);
  }
});

test('an incomplete same-day snapshot retains the prior verified paid order and its success time',async()=>{
  const f=fixture();await f.registry.ingestSnapshot(snapshot([order({status:'deposit_paid',platform_status:'Deposit paid'})]));
  const bad=snapshot([],31);bad.pagination={complete:false,total_pages:2,pages_read:[1],listed_count:1};
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[bad]});
  assert.equal(receipt.results[0].accepted,false);assert.equal((await f.record()).status,'deposit_paid');
  assert.equal((await f.make().status()).platforms.samboat.last_success_at,checked(30));
});

test('same-day exception does not relax dates for another source or reversed/invalid SamBoat dates',async()=>{
  for(const source of ['boataround','clickandboat']) {
    const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot([order()],30,{source})),{status:422});
    assert.throws(()=>worker.normalizeBooking(source,order({status:'deposit_paid'})),/日期无效/);
  }
  for(const dates of [{start:'2026-09-27',end:DAY},{start:'2026-02-30',end:'2026-02-30'},
    {start:'2026-9-26',end:'2026-9-26'},{start:'2026-09-26T09:00:00Z',end:'2026-09-26T09:00:00Z'}]) {
    const f=fixture();await assert.rejects(f.registry.ingestSnapshot(snapshot([order(dates)])),{status:422});
    assert.throws(()=>worker.normalizeBooking(SOURCE,order({...dates,status:'deposit_paid'})),/日期无效/);
  }
});
