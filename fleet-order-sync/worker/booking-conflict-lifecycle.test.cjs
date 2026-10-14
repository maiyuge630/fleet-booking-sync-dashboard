'use strict';
// Integration boundary: real Worker normalization and dynamic snapshot storage
// feed the same per-boat conflict helper used by the dashboard. Fixtures below
// are synthetic and are never uploaded or treated as live order evidence.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {createOrderRegistry}=require('./dynamic-registry.cjs');
const {patchOrderSync}=require('./patch-order-sync.cjs');
const {findBookingConflicts,bookingIdentity}=require('../booking-conflicts.cjs');
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const clone=value=>JSON.parse(JSON.stringify(value));
const SOURCES=['boataround','clickandboat','samboat'];
const TODAY='2026-09-10', NOW=Date.parse(TODAY+'T06:00:00Z');
const SLUG='seacat-open-40-tidewyn-discovery-2';
const AUTHORIZED_RESCHEDULE='clickandboat:1000000';
const baseline=fs.readFileSync(path.resolve(__dirname,'../../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const worker=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Request,Response,Headers,URL,URLSearchParams,
  structuredClone,crypto:webcrypto,AbortSignal,fetch:()=>{throw Error('Live network is forbidden in lifecycle tests');}});
vm.runInContext(patchOrderSync(baseline).replace(/^import[^\n]+\n/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),worker);
const FLEET=clone(worker.FLEET_SPECS);

function fixture(){
  const files=new Map();let serial=0;
  const bucket={
    async get(key){const value=files.get(key);return value?{etag:value.etag,json:async()=>JSON.parse(value.body)}:null;},
    async put(key,body,{onlyIf}={}){
      const previous=files.get(key);
      if(onlyIf instanceof Headers&&onlyIf.get('If-None-Match')==='*'&&previous)return null;
      if(onlyIf&&!(onlyIf instanceof Headers)&&onlyIf.etagMatches!==previous?.etag)return null;
      const etag='conflict-test-'+ ++serial;files.set(key,{etag,body});return {etag};
    }
  };
  const empty={schema_version:2,boataround:[],clickandboat:[],samboat:[]};
  const make=(bootstrapMap=empty)=>createOrderRegistry({bucket,normalizeBooking:worker.normalizeBooking,fleetSpecs:FLEET,bootstrapMap,now:()=>NOW});
  const registry=make();
  async function view(reader=registry){
    const mapping=await reader.registry();
    const data=worker.applyBookingRegistry(clone(worker.SEED),mapping);
    assert.equal(data.booking_mapping_complete,true,'The production registry must remain a complete mapping.');
    return data.boats.map(boat=>({slug:boat.boataround_slug,bookings:clone(boat.bookings),
      conflicts:findBookingConflicts(clone(boat.bookings),TODAY)}));
  }
  return {registry,make,view};
}

function paid(source,overrides={}){
  const booking_id={boataround:'990101',clickandboat:'990102',samboat:'990103'}[source];
  const base={booking_id,boataround_slug:SLUG,start:'2026-10-17',end:'2026-10-24',
    verified_at:TODAY+'T05:00:00Z',amount:'€100.00',amount_basis:'synthetic lifecycle fixture only',...overrides};
  if(source==='boataround'){
    const detail_id=String(base.booking_id).padStart(24,'0');
    return {...base,status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID',detail_id,
      url:'https://partner.boataround.com/en/000000000000000000000000/orders/'+detail_id};
  }
  if(source==='clickandboat')return {...base,status:'accepted',platform_status:'Accepted',customer_payment_verified:true,
    customer_paid_amount:10,customer_balance_amount:90,customer_total_online_amount:100,
    customer_payment_verification_source:'synthetic fixture',url:'https://www.clickandboat.com/uk/booking/'+base.booking_id+'/detail'};
  return {...base,status:'deposit_paid',platform_status:'Deposit paid',url:'https://www.samboat.com/private/reservation/'+base.booking_id};
}

function snapshot(source,orders,minute){
  return {source,run_id:'conflict-test-'+source+'-'+minute,checked_at:TODAY+'T05:'+String(minute).padStart(2,'0')+':00Z',
    complete:true,expected_count:orders.length,orders:clone(orders),
    scope:{kind:'current_future',from_day:TODAY,fleet_slugs:FLEET.map(boat=>boat.boataround_slug)},
    pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length}};
}
function overlapping(){
  return {boataround:paid('boataround'),
    clickandboat:paid('clickandboat',{start:'2026-10-20',end:'2026-10-25'}),
    samboat:paid('samboat',{start:'2026-10-22',end:'2026-10-28'})};
}
async function seed(f,records=overlapping(),minute=10){
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:SOURCES.map(source=>snapshot(source,[records[source]],minute))});
  assert.ok(receipt.results.every(result=>result.accepted===true&&result.outcome==='success'));
  return records;
}
const onBoat=(view,slug=SLUG)=>view.find(boat=>boat.slug===slug);
function pairs(boat){
  return boat.conflicts.pairs.map(pair=>({ids:pair.bookings.map(bookingIdentity).sort(),
    start:pair.start,end:pair.end,nights:pair.nights})).sort((a,b)=>a.ids.join('|').localeCompare(b.ids.join('|')));
}
function pairOf(a,b,start,end,nights){return {ids:[bookingIdentity(a),bookingIdentity(b)].sort(),start,end,nights};}
function assertBookingsWithReschedule(boat,syntheticIds){
  assert.equal(boat.slug,SLUG);
  assert.deepEqual(boat.bookings.map(bookingIdentity).sort(),[...syntheticIds,AUTHORIZED_RESCHEDULE].sort(),
    'Retain exactly the expected source+ID records and the separately authorized reschedule.');
  const manual=boat.bookings.find(order=>bookingIdentity(order)===AUTHORIZED_RESCHEDULE);
  assert.equal(manual.start,'2027-03-06');assert.equal(manual.end,'2027-03-13');
  assert.equal(manual.status,'accepted');assert.equal(manual.amount,'€4,200.00');
  assert.equal(manual.url,'https://www.clickandboat.com/uk/booking/1000000/detail');
  assert.equal(manual.customer_payment_verified,undefined,'Owner-authorized settlement is not a fabricated customer API verification.');
  assert.ok(!boat.conflicts.bookingKeys.includes(AUTHORIZED_RESCHEDULE),
    'The March reschedule must not create any of the synthetic October conflicts.');
}

test('three platforms: only verified paid registry records produce all exact pairwise date intersections',async()=>{
  const f=fixture(),records=await seed(f);
  const boat=onBoat(await f.view());
  assertBookingsWithReschedule(boat,SOURCES.map(source=>source+':'+records[source].booking_id));
  assert.deepEqual(pairs(boat),[
    pairOf({...records.boataround,source:'boataround'},{...records.clickandboat,source:'clickandboat'},'2026-10-20','2026-10-25',5),
    pairOf({...records.boataround,source:'boataround'},{...records.samboat,source:'samboat'},'2026-10-22','2026-10-25',3),
    pairOf({...records.clickandboat,source:'clickandboat'},{...records.samboat,source:'samboat'},'2026-10-22','2026-10-26',4)
  ]);
  assert.equal(boat.conflicts.bookingKeys.length,3);
});

for(const source of SOURCES){
  test(source+': distinct paid orders on the same platform conflict, including checkout-day turnover',async()=>{
    const f=fixture(),first=paid(source),second=paid(source,{booking_id:'990104',start:'2026-10-23',end:'2026-10-26'});
    await f.registry.ingestSnapshot(snapshot(source,[first,second],10));
    assert.equal(onBoat(await f.view()).conflicts.pairs.length,1);
    second.start=first.end;
    await f.registry.ingestSnapshot(snapshot(source,[first,second],20));
    assert.equal(onBoat(await f.view()).conflicts.pairs.length,1);
    assertBookingsWithReschedule(onBoat(await f.view()),[source+':'+first.booking_id,source+':'+second.booking_id]);
  });

  test(source+': successful cancellation removes only its conflicts; old paid replay and restart cannot restore them',async()=>{
    const f=fixture(),records=await seed(f),record=records[source];
    const before=onBoat(await f.view());assert.equal(before.conflicts.pairs.length,3);
    const oldPaid=snapshot(source,[record],15);
    const cancelled={...record,status:'cancelled',platform_status:'Cancelled'};
    const accepted=await f.registry.ingestSnapshot(snapshot(source,[cancelled],20));assert.equal(accepted.outcome,'success');
    const remaining=SOURCES.filter(value=>value!==source).map(value=>value+':'+records[value].booking_id).sort();
    let boat=onBoat(await f.view());
    assert.equal(boat.conflicts.pairs.length,1);assert.deepEqual(pairs(boat)[0].ids,remaining);
    assert.ok(!boat.bookings.some(order=>bookingIdentity(order)===source+':'+record.booking_id));
    assertBookingsWithReschedule(boat,remaining);
    const replay=await f.registry.ingestSnapshot(oldPaid);
    assert.equal(replay.accepted,false);assert.equal(replay.ignored,'older_snapshot');
    const staleBootstrap={schema_version:2,boataround:[],clickandboat:[],samboat:[],[source]:[record]};
    boat=onBoat(await f.view(f.make(staleBootstrap)));
    assert.equal(boat.conflicts.pairs.length,1);assert.deepEqual(pairs(boat)[0].ids,remaining);
    assertBookingsWithReschedule(boat,remaining);
  });

  test(source+': failed or missing-page snapshots keep conflicts until a complete success removes the missing order',async()=>{
    const f=fixture(),records=await seed(f);
    const before=pairs(onBoat(await f.view()));
    const successAt=(await f.registry.status()).platforms[source].last_success_at;
    const failure=await f.registry.ingestSnapshot({source,run_id:'conflict-failure-'+source,
      checked_at:TODAY+'T05:20:00Z',outcome:'failure',error_code:'fetch_failed'});
    assert.equal(failure.accepted,true);assert.equal(failure.outcome,'failure');
    assert.deepEqual(pairs(onBoat(await f.view())),before);
    const incomplete=snapshot(source,[],30);incomplete.pagination={complete:true,total_pages:2,pages_read:[1],listed_count:0};
    const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[incomplete]});
    assert.equal(receipt.results[0].accepted,false);assert.equal(receipt.results[0].status,422);
    assert.equal(receipt.order_sync.platforms[source].last_error,'incomplete_pages');
    assert.equal(receipt.order_sync.platforms[source].last_success_at,successAt);
    assert.deepEqual(pairs(onBoat(await f.view())),before);
    await f.registry.ingestSnapshot(snapshot(source,[],40));
    assert.equal(onBoat(await f.view()).conflicts.pairs.length,1);
    const boat=onBoat(await f.view());
    assert.ok(!boat.bookings.some(order=>bookingIdentity(order)===source+':'+records[source].booking_id));
    assertBookingsWithReschedule(boat,SOURCES.filter(value=>value!==source).map(value=>value+':'+records[value].booking_id));
  });
}

test('a complete reschedule replaces the identity once and removes only the moved booking\'s old conflicts',async()=>{
  const f=fixture(),records=await seed(f);
  const expected=pairs(onBoat(await f.view())).filter(pair=>!pair.ids.includes('boataround:'+records.boataround.booking_id));
  const moved={...records.boataround,start:'2026-10-30',end:'2026-11-03'};
  await f.registry.ingestSnapshot(snapshot('boataround',[moved],20));
  const boat=onBoat(await f.view());
  assert.deepEqual(pairs(boat),expected);
  const matches=boat.bookings.filter(order=>order.source==='boataround'&&order.booking_id===moved.booking_id);
  assert.equal(matches.length,1);assert.equal(matches[0].start,moved.start);assert.equal(matches[0].end,moved.end);
  assertBookingsWithReschedule(boat,SOURCES.map(source=>source+':'+records[source].booking_id));
});

test('moving a paid order to another boat cannot leave a ghost conflict on its previous boat',async()=>{
  const f=fixture(),records=await seed(f),other=FLEET.find(boat=>boat.boataround_slug!==SLUG).boataround_slug;
  await f.registry.ingestSnapshot(snapshot('boataround',[{...records.boataround,boataround_slug:other}],20));
  const view=await f.view();
  assert.equal(onBoat(view).conflicts.pairs.length,1);
  assert.equal(onBoat(view,other).conflicts.pairs.length,0);
  assert.equal(onBoat(view,other).bookings.length,1);
  assert.equal(view.flatMap(boat=>boat.bookings).filter(order=>order.source==='boataround').length,1);
  assertBookingsWithReschedule(onBoat(view),['clickandboat:'+records.clickandboat.booking_id,'samboat:'+records.samboat.booking_id]);
});

test('the same numeric order ID on different platforms remains two distinct paid bookings',async()=>{
  const f=fixture(),id='990107';
  await f.registry.ingestBatch({schema_version:1,snapshots:[
    snapshot('boataround',[paid('boataround',{booking_id:id})],10),
    snapshot('clickandboat',[paid('clickandboat',{booking_id:id})],10)
  ]});
  const boat=onBoat(await f.view());
  assertBookingsWithReschedule(boat,['boataround:'+id,'clickandboat:'+id]);assert.equal(boat.conflicts.pairs.length,1);
  assert.deepEqual(boat.conflicts.bookingKeys.slice().sort(),['boataround:'+id,'clickandboat:'+id]);
});

test('payment evidence rejection cannot introduce a false paid conflict on any platform',async()=>{
  for(const source of SOURCES){
    const f=fixture(),records=overlapping();
    for(const other of SOURCES.filter(value=>value!==source))await f.registry.ingestSnapshot(snapshot(other,[records[other]],10));
    const candidate={...records[source]};
    if(source==='boataround')candidate.customer_payment='NOT PAID';
    else if(source==='clickandboat')candidate.customer_paid_amount=0;
    else candidate.platform_status='Confirmed';
    const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[snapshot(source,[candidate],20)]});
    assert.equal(receipt.results[0].accepted,false,source);
    assert.equal(onBoat(await f.view()).conflicts.pairs.length,1,source);
    const boat=onBoat(await f.view());
    assert.ok(!boat.bookings.some(order=>bookingIdentity(order)===source+':'+candidate.booking_id),source);
    assertBookingsWithReschedule(boat,SOURCES.filter(value=>value!==source).map(value=>value+':'+records[value].booking_id));
  }
});

test('mixed-source receipt applies the cancellation while the failed platform retains its own verified booking',async()=>{
  const f=fixture(),records=await seed(f);
  const receipt=await f.registry.ingestBatch({schema_version:1,snapshots:[
    snapshot('boataround',[{...records.boataround,status:'cancelled',platform_status:'Cancelled'}],20),
    {source:'samboat',run_id:'conflict-mixed-failure',checked_at:TODAY+'T05:20:00Z',outcome:'failure',error_code:'auth_required'}
  ]});
  assert.deepEqual(receipt.results.map(result=>result.outcome),['success','failure']);
  const boat=onBoat(await f.view());
  assert.equal(boat.conflicts.pairs.length,1);
  assert.deepEqual(pairs(boat)[0].ids,['clickandboat:'+records.clickandboat.booking_id,'samboat:'+records.samboat.booking_id]);
  assert.equal((await f.registry.status()).platforms.samboat.last_error,'auth_required');
  assertBookingsWithReschedule(boat,['clickandboat:'+records.clickandboat.booking_id,'samboat:'+records.samboat.booking_id]);
});
