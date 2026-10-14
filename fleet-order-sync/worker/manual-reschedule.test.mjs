import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {FLEET} from '../parsers.mjs';
const require=createRequire(import.meta.url);
const {createOrderRegistry,ORDER_SYNC_PREFIX}=require('./dynamic-registry.cjs');
const ID='1000000',SLUG='seacat-open-40-tidewyn-discovery-2';
const URL='https://www.clickandboat.com/uk/booking/1000000/detail';
const BASE=Date.parse('2026-09-10T09:00:00Z');
const iso=time=>new Date(time).toISOString();
function fixture(){
  const files=new Map();let revision=0,clock=BASE,run=0;
  const bucket={failAfter:0,async get(key){const file=files.get(key);return file?{etag:file.etag,json:async()=>JSON.parse(file.body)}:null;},
    async put(key,body,{onlyIf}={}){const old=files.get(key);if(onlyIf instanceof Headers&&old)return null;if(onlyIf?.etagMatches&&onlyIf.etagMatches!==old?.etag)return null;
      const etag=String(++revision);files.set(key,{etag,body});if(onlyIf?.etagMatches&&this.failAfter){this.failAfter--;throw Error('synthetic response lost after commit');}return {etag};}};
  const bootstrap={boataround:[],samboat:[],clickandboat:[{booking_id:ID,boat:SLUG,status:'accepted',start:'2026-03-14',end:'2026-03-21',url:URL,amount:'€4,200.00'}],mapping_updated_at:iso(BASE-3600000)};
  const make=()=>createOrderRegistry({bucket,normalizeBooking:(source,record)=>({...record,source}),fleetSpecs:FLEET.map(boat=>({...boat,boataround_slug:boat.slug})),bootstrapMap:bootstrap,now:()=>clock});
  const observation=changes=>({booking_id:ID,boataround_slug:SLUG,platform_status:'ACCEPTED',start:'2026-03-14',end:'2026-03-21',checked_at:iso(clock),detail_url:URL,...changes});
  const snapshot=(observations,orders=[])=>({source:'clickandboat',run_id:'manual-test-'+ ++run,checked_at:iso(clock),complete:true,expected_count:orders.length,orders,
    scope:{kind:'current_future',from_day:'2026-09-10',fleet_slugs:FLEET.map(boat=>boat.slug)},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:orders.length},
    ...(observations===undefined?{}:{manual_order_observations:observations})});
  const registry=make();return {registry,make,bucket,files,observation,snapshot,advance:ms=>{clock+=ms;},now:()=>clock,
    order:async()=>{const matches=(await make().registry()).clickandboat.filter(order=>order.booking_id===ID);assert.equal(matches.length,1);return matches[0];}};
}

test('one durable authorization replaces the old identity once without fabricating a customer payment API result',async()=>{
  const h=fixture(),first=await h.order();
  assert.equal(first.start,'2027-03-06');assert.equal(first.end,'2027-03-13');assert.equal(first.boataround_slug,SLUG);
  assert.equal(first.url,URL);assert.equal(first.amount,'€4,200.00');assert.equal(first.amount_basis,'船东净收入');assert.equal(first.status,'accepted');
  assert.equal(first.manual_adjustment.original_start,'2026-03-14');assert.equal(first.manual_adjustment.original_end,'2026-03-21');
  assert.deepEqual(first.manual_adjustment.payment_evidence,{kind:'owner_settlement',amount:4200,currency:'EUR',paid_on:'2026-03-16',detail_url:URL});
  assert.equal(Object.hasOwn(first,'customer_payment_verified'),false);assert.equal(Object.hasOwn(first,'customer_paid_amount'),false);
  assert.equal(first.manual_adjustment.verification_status,'awaiting_observation');
  h.advance(60000);assert.deepEqual(await h.order(),first);
  assert.ok(h.files.has(ORDER_SYNC_PREFIX+'manual-reschedules.json'));
  assert.equal((await h.registry.status()).platforms.clickandboat.last_success_at,null);
});

test('matching historical or platform-adjusted dates verify the observation while retaining the manual target',async()=>{
  const h=fixture();
  for(const dates of [{start:'2026-03-14',end:'2026-03-21'},{start:'2027-03-06',end:'2027-03-13'}]){
    h.advance(1000);await h.registry.ingestSnapshot(h.snapshot([h.observation(dates)]));
    const order=await h.order();assert.equal(order.start,'2027-03-06');assert.equal(order.end,'2027-03-13');
    assert.equal(order.manual_adjustment.verification_status,'verified');assert.equal(order.manual_adjustment.last_verified_at,iso(h.now()));
    assert.equal(order.manual_adjustment.platform_start,dates.start);
  }
});

test('missing observations and source failure retain authorization and its last real verification while requesting review',async()=>{
  const h=fixture();await h.registry.ingestSnapshot(h.snapshot([h.observation()]));const verified=iso(h.now());
  h.advance(1000);await h.registry.ingestSnapshot(h.snapshot(undefined));
  let order=await h.order();assert.equal(order.status,'accepted');assert.equal(order.manual_adjustment.last_verified_at,verified);
  assert.equal(order.manual_adjustment.review_reason,'observation_missing');assert.equal(order.manual_adjustment.verification_status,'needs_review');
  const success=(await h.registry.status()).platforms.clickandboat.last_success_at;
  h.advance(1000);await h.registry.ingestSnapshot({source:'clickandboat',run_id:'source-failed',checked_at:iso(h.now()),outcome:'failure',error_code:'fetch_failed'});
  order=await h.order();assert.equal(order.manual_adjustment.review_reason,'source_sync_failed');assert.equal(order.manual_adjustment.last_verified_at,verified);
  assert.equal((await h.registry.status()).platforms.clickandboat.last_success_at,success);assert.equal(order.start,'2027-03-06');
});

test('explicit cancellation is sticky across replay, missing data, future Accepted and registry restart',async()=>{
  for(const label of ['CANCELLED','Canceled']){
    const h=fixture();const before=h.snapshot([h.observation()]);await h.registry.ingestSnapshot(before);
    h.advance(1000);await h.registry.ingestSnapshot(h.snapshot([h.observation({platform_status:label})]));const cancelled=await h.order();
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.manual_adjustment.cancelled_at,iso(h.now()));
    assert.equal((await h.make().ingestSnapshot(before)).ignored,'older_snapshot');
    h.advance(1000);await h.make().ingestSnapshot(h.snapshot(undefined));
    h.advance(1000);await h.make().ingestSnapshot(h.snapshot([h.observation()]));
    const after=await h.order();assert.equal(after.status,'cancelled');assert.equal(after.manual_adjustment.cancelled_at,cancelled.manual_adjustment.cancelled_at);
    assert.equal(after.manual_adjustment.verification_status,'cancelled');
    assert.equal((await h.registry.registry()).samboat.find(order=>order.booking_id==='1000001').status,'cancelled');
  }
});

test('an explicit ordinary current-future cancellation wins even without the extra historical observation',async()=>{
  const h=fixture();await h.registry.ingestSnapshot(h.snapshot(undefined,[{booking_id:ID,boat:SLUG,status:'cancelled',platform_status:'CANCELLED',start:'2027-03-06',end:'2027-03-13'}]));
  assert.equal((await h.order()).status,'cancelled');h.advance(1000);await h.registry.ingestSnapshot(h.snapshot([h.observation()]));
  assert.equal((await h.order()).status,'cancelled');
});

test('other platform changes request review but cannot rewrite the authorized boat, dates or amount',async()=>{
  for(const [change,reason] of [[{start:'2027-04-01',end:'2027-04-08'},'platform_dates_changed'],[{boataround_slug:FLEET[0].slug},'platform_boat_changed'],[{platform_status:'COMPLETED'},'platform_status_changed'],[{platform_status:'Pending modification'},'platform_status_changed']]){
    const h=fixture();await h.registry.ingestSnapshot(h.snapshot([h.observation(change)]));const order=await h.order();
    assert.equal(order.status,'accepted');assert.equal(order.start,'2027-03-06');assert.equal(order.end,'2027-03-13');assert.equal(order.boataround_slug,SLUG);
    assert.equal(order.amount,'€4,200.00');assert.equal(order.manual_adjustment.verification_status,'needs_review');assert.equal(order.manual_adjustment.review_reason,reason);
  }
});

test('observation identity, exact link, date, time and permitted fields are validated independently from ordinary orders',async()=>{
  const cases=[{booking_id:'other'},{booking_id:1000000},{detail_url:URL+'?x=1'},{detail_url:URL.replace('1000000','1234322')},
    {boataround_slug:'unknown'},{start:'2027-02-30'},{end:'2026-03-14'},{checked_at:'2026-09-10'},
    {checked_at:iso(BASE+61000)},{checked_at:iso(BASE-600001)},{amount:999},{manual_start:'2030-01-01'},{platform_status:''},{platform_status:'ACCEPTED\nCANCELLED'}];
  for(const change of cases){const h=fixture();await assert.rejects(h.registry.ingestSnapshot(h.snapshot([h.observation(change)])),error=>error.status===422);assert.equal((await h.order()).status,'accepted');}
  const h=fixture();await assert.rejects(h.registry.ingestSnapshot(h.snapshot([h.observation(),h.observation()])),error=>error.status===422);
  await assert.rejects(h.registry.ingestSnapshot({...h.snapshot([h.observation()]),source:'samboat'}),error=>error.status===422);
  await assert.rejects(h.registry.ingestSnapshot({source:'clickandboat',run_id:'failure-with-observation',checked_at:iso(BASE),outcome:'failure',error_code:'fetch_failed',manual_order_observations:[h.observation()]}),error=>error.status===422);
});

test('observations are part of the immutable run digest and an older wrapper cannot replay a cancellation or verification update',async()=>{
  const h=fixture(),first=h.snapshot([h.observation()]);await h.registry.ingestSnapshot(first);
  assert.equal((await h.registry.ingestSnapshot(first)).idempotent,true);
  const changed=structuredClone(first);changed.manual_order_observations[0].platform_status='CANCELLED';
  await assert.rejects(h.registry.ingestSnapshot(changed),error=>error.status===409);
  h.advance(1000);await h.registry.ingestSnapshot(h.snapshot([h.observation({start:'2027-04-01',end:'2027-04-08'})]));
  assert.equal((await h.registry.ingestSnapshot({...changed,run_id:'old-wrapper-new-id'})).ignored,'older_snapshot');
  assert.equal((await h.order()).status,'accepted');assert.equal((await h.order()).manual_adjustment.platform_start,'2027-04-01');
});

test('cancel observation shares the source commit, so response loss and CAS interleaving cannot resurrect it',async()=>{
  const h=fixture();await h.registry.ingestSnapshot(h.snapshot([h.observation()]));h.advance(1000);
  const cancelled=h.snapshot([h.observation({platform_status:'CANCELLED'})]);h.bucket.failAfter=1;
  const lost=await h.registry.ingestBatch({schema_version:1,snapshots:[cancelled]});assert.equal(lost.results[0].status,503);
  assert.equal((await h.order()).status,'cancelled');assert.equal((await h.make().ingestSnapshot(cancelled)).idempotent,true);
  h.advance(1000);const later=h.snapshot([h.observation()]);await Promise.all([h.make().ingestSnapshot(cancelled),h.make().ingestSnapshot(later)]);
  assert.equal((await h.order()).status,'cancelled');
});

test('automatic records cannot supply artificial manual metadata or change the authorization document',async()=>{
  const h=fixture(),other={booking_id:'99000001',boat:SLUG,status:'accepted',start:'2027-04-01',end:'2027-04-08',url:'https://fixture.invalid/other',
    customer_payment_verified:true,customer_paid_amount:10,manual_adjustment:{kind:'reschedule',original_start:'fake'}};
  await h.registry.ingestSnapshot(h.snapshot([h.observation()],[other]));
  const map=await h.registry.registry();assert.equal(Object.hasOwn(map.clickandboat.find(order=>order.booking_id===other.booking_id),'manual_adjustment'),false);
  assert.equal(map.clickandboat.length,2);assert.equal((await h.order()).amount,'€4,200.00');
  await assert.rejects(h.registry.ingestBatch({schema_version:1,snapshots:[h.snapshot(undefined)],manual_reschedules:[{booking_id:ID,start:'2030-01-01'}]}),error=>error.status===422);
});

test('corrupt persisted authorization fails closed instead of replacing it with a guessed schedule',async()=>{
  const h=fixture();await h.order();const key=ORDER_SYNC_PREFIX+'manual-reschedules.json';
  const data=JSON.parse(h.files.get(key).body);data.records[0].start='2030-01-01';h.files.set(key,{etag:'corrupt',body:JSON.stringify(data)});
  await assert.rejects(h.make().registry(),error=>error.status===503);
  assert.equal(JSON.parse(h.files.get(key).body).records[0].start,'2030-01-01');
});
