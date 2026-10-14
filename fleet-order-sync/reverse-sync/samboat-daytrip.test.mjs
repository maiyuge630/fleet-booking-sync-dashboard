import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan,uncovered} from './planner.mjs';
import {mmkPlan} from './mmk-plan.mjs';
import {releaseAllowed,verifiedBlocks} from './release.mjs';
import {dateRange} from '../parsers.mjs';
import {beginBoataroundManaged,confirmBoataroundManaged} from './ba-managed.mjs';
const now=Date.parse('2026-09-15T05:00:00Z'),checked=new Date(now).toISOString();
const boat='seacat-open-40-tidewyn-discovery-2',day='2026-09-26',key='samboat:990040';
const order=(extra={})=>({booking_id:'990040',boataround_slug:boat,start:day,end:day,
  status:'deposit_paid',platform_status:'Validated / Deposit Paid',verified_at:checked,...extra});
const status=()=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys']
  .map(source=>[source,{mode:'dynamic',last_success_at:checked,last_error:null}]))});
const plan=(orders=[order()],states=status())=>buildPlan({boataround:[],clickandboat:[],samboat:orders,mmk:[],nausys:[]},states,{now});
const selected=p=>p.targets.filter(t=>t.boat===boat);
const expected=[{start:day,end:'2026-09-27',causes:[key]}];

test('verified SamBoat day trip protects exactly one real date on all targets and MMK',()=>{
  const p=plan();assert.deepEqual(p.excluded,[]);
  assert.deepEqual(p.causes.map(({start,end})=>({start,end})),[{start:day,end:'2026-09-27'}]);
  for(const t of [...selected(p),...selected(mmkPlan(p))]) {
    assert.deepEqual(t.segments,expected);assert.equal(t.fresh,true);
    assert.deepEqual(t.release_proof.orders,[{key,state:'active',start:day,end:'2026-09-27'}]);
  }
  const original=order();plan([original]);assert.equal(original.end,day,'source checkout must not be rewritten');
});

test('explicit SamBoat Paid protects the exact day and provides active proof without relabeling as a deposit',()=>{
  const record=order({status:'paid',platform_status:'Paid'}),p=plan([record]);
  assert.deepEqual(p.excluded,[]);assert.equal(p.causes.length,1);
  for(const t of [...selected(p),...selected(mmkPlan(p))]) {
    assert.deepEqual(t.segments,expected);assert.equal(t.fresh,true);
    assert.deepEqual(t.release_proof.orders,[{key,state:'active',start:day,end:'2026-09-27'}]);
  }
  assert.equal(record.status,'paid');
  for(const [state,label] of [['paid','Pre-paid: answer'],['paid','Deposit paid'],['deposit_paid','Paid'],['accepted','Paid']]) {
    const bad=plan([order({status:state,platform_status:label})]);
    assert.equal(bad.excluded[0].reason,'payment_unverified');assert.deepEqual(bad.causes,[]);
    assert.ok(selected(bad).every(t=>!t.fresh&&!t.release_proof.ready));
  }
});

test('Pre-paid pending, completed and refused day trips do not create any closure or payment cause',()=>{
  for(const state of ['pending','completed','refused']) {
    const p=plan([order({status:state,platform_status:'Pre-paid: answer'})]);
    assert.deepEqual(p.causes,[]);
    assert.ok([...selected(p),...selected(mmkPlan(p))].every(t=>t.segments.length===0));
    assert.ok(selected(p).every(t=>t.release_proof.orders.length===0));
  }
  const bad=plan([order({platform_status:'Pre-paid: answer'})]);
  assert.equal(bad.excluded[0].reason,'payment_unverified');assert.ok(selected(bad).every(t=>!t.fresh));
});

test('day-trip closure can only be released after fresh explicit cancellation, not disappearance or a failed source',()=>{
  const attempt={id:'new-daytrip-generation',state:'confirmed',before:[],start:day,end:'2026-09-27',causes:[key],created:{id:'owned-fixture',start:day,end:'2026-09-27',type:3}};
  const target=p=>({...selected(p)[0],boataround_control:{version:1,enabled:true,revision:1,holds:[]}});
  const coverage={start:'2026-09-01',end:'2027-01-01'};
  beginBoataroundManaged(attempt,target(plan()),coverage);confirmBoataroundManaged(attempt,target(plan()),coverage);
  assert.equal(releaseAllowed(attempt,target(plan()),now),false);
  assert.equal(releaseAllowed(attempt,target(plan([])),now),false);
  const cancelled=[order({status:'cancelled',platform_status:'Cancelled'})];
  assert.equal(releaseAllowed(attempt,target(plan(cancelled)),now),true);
  assert.equal(releaseAllowed({...attempt,boataround_managed:undefined},target(plan(cancelled)),now),false,'legacy BA receipt cannot reopen');
  assert.equal(releaseAllowed(attempt,selected(plan(cancelled)).find(t=>t.target==='clickandboat'),now),true,'stable platform IDs retain existing cancellation rules');
  const stale=status();stale.platforms.samboat.last_error='fetch_failed';
  assert.equal(releaseAllowed(attempt,target(plan(cancelled,stale)),now),false);
  assert.equal(releaseAllowed(attempt,target(plan([order({status:'cancelled',platform_status:'Deposit paid'})])),now),false);
});

test('one-day active protection remains while stale, blocks future writes, and composes with overlapping orders',()=>{
  const states=status();states.platforms.samboat.last_error='auth_required';
  const stale=plan([order()],states);assert.deepEqual(selected(stale)[0].segments,expected);
  assert.ok(selected(stale).every(t=>!t.fresh&&!t.release_proof.ready));
  const p=buildPlan({boataround:[{booking_id:'990041',boataround_slug:boat,start:'2026-09-25',end:day,
    status:'paid',platform_status:'CONFIRMED',verified_at:checked}],clickandboat:[],samboat:[order()],mmk:[],nausys:[]},status(),{now});
  const t=selected(p).find(t=>t.target==='clickandboat');
  assert.deepEqual(t.segments,[{start:'2026-09-25',end:day,causes:['boataround:990041']},
    {start:day,end:'2026-09-27',causes:['boataround:990041',key]}]);
});

test('narrow source-date exception keeps generic half-open write and release checks strict',()=>{
  assert.throws(()=>dateRange(day,day));
  assert.throws(()=>uncovered({start:day,end:'2026-09-27'},[{start:day,end:day}]));
  assert.throws(()=>verifiedBlocks({complete:true,identity_verified:true,blocks:[{id:'bad',start:day,end:day}]}));
  for(const source of ['boataround','clickandboat']) {
    const data={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]};
    data[source]=[order(source==='boataround'?{status:'paid',platform_status:'CONFIRMED'}:
      {status:'accepted',customer_payment_verified:true,customer_paid_amount:10})];
    assert.equal(buildPlan(data,status(),{now}).excluded[0].reason,'invalid_dates');
  }
  const p=plan([order({start:'2026-02-30',end:'2026-02-30'})]);
  assert.equal(p.excluded[0].reason,'invalid_dates');assert.deepEqual(p.causes,[]);
});
