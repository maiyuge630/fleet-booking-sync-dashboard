'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {findBookingConflicts, bookingIdentity, BOOKING_CONFLICTS_SCRIPT} = require('./booking-conflicts.cjs');
const order = (booking_id, start, end, extra = {}) => ({source: 'boataround', booking_id, status: 'deposit_paid', start, end, ...extra});
const simple = result => ({...result, pairs: result.pairs.map(pair => ({...pair, bookings: pair.bookings.map(bookingIdentity)}))});

test('real AD2 reservations overlap two occupied days across the calendar year', () => {
  const a = order('303719', '2026-12-26', '2027-01-02');
  const b = order('1502428', '2027-01-01', '2027-01-08', {source:'samboat'});
  const result = findBookingConflicts([a,b], '2026-09-10');
  assert.deepEqual(result, {pairs:[{key:JSON.stringify(['boataround:303719','samboat:1502428']),start:'2027-01-01',end:'2027-01-03',nights:2,bookings:[a,b]}],bookingKeys:['boataround:303719','samboat:1502428']});
});

test('checkout and check-in on the same date overlap for one occupied day', () => {
  const r=findBookingConflicts([order('a','2027-01-01','2027-01-08'),order('b','2027-01-08','2027-01-15')],'2026-09-10');assert.equal(r.pairs.length,1);assert.equal(r.pairs[0].nights,1);assert.equal(r.pairs[0].start,'2027-01-08');
});

test('containment reports the actual shorter interval', () => {
  const result = findBookingConflicts([order('a','2027-01-01','2027-02-01'),order('b','2027-01-10','2027-01-13')],'2027-01-01');
  assert.equal(result.pairs.length,1);assert.equal(result.pairs[0].start,'2027-01-10');assert.equal(result.pairs[0].end,'2027-01-14');assert.equal(result.pairs[0].nights,4);
});

test('every pair is reported without truncation and booking keys are unique', () => {
  const input = Array.from({length:8},(_,i)=>order(String(i),'2027-01-01','2027-01-08'));
  const result = findBookingConflicts(input,'2026-09-10');
  assert.equal(result.pairs.length,28);assert.equal(new Set(result.pairs.map(p=>p.key)).size,28);assert.equal(result.bookingKeys.length,8);
});

test('same-platform separate orders collide while same number across platforms remains separate', () => {
  const a=order('100','2027-01-01','2027-01-03'),b=order('101','2027-01-02','2027-01-04'),c=order('100','2027-01-02','2027-01-04',{source:'samboat'});
  assert.equal(findBookingConflicts([a,b,c],'2026-09-10').pairs.length,3);
  assert.notEqual(bookingIdentity(a),bookingIdentity(c));
});

test('only normalized active statuses qualify; public blocks and pending payments do not', () => {
  const paid=order('paid','2027-01-01','2027-01-03',{status:'paid'});
  for (const status of ['cancelled','canceled','completed','refused','declined','pending','pending_payment','requested','blocked','locked','gap','confirmed','']) {
    assert.equal(findBookingConflicts([paid,order('excluded','2027-01-01','2027-01-03',{status})],'2026-09-10').pairs.length,0,status);
  }
  for (const status of ['accepted','deposit_paid','paid']) assert.equal(findBookingConflicts([paid,order('valid','2027-01-01','2027-01-03',{status})],'2026-09-10').pairs.length,1,status);
});

test('the helper trusts normalized eligibility instead of guessing from money labels', () => {
  const a=order('a','2027-01-01','2027-01-03',{status:'accepted',amount:0,customer_payment_verified:false});
  const b=order('b','2027-01-01','2027-01-03',{status:'paid'});
  assert.equal(findBookingConflicts([a,b],'2026-09-10').pairs.length,1);
});

test('duplicate copies of one booking neither self-conflict nor multiply a real pair', () => {
  const a=order('a','2027-01-01','2027-01-08'),b=order('b','2027-01-02','2027-01-04');
  assert.equal(findBookingConflicts([a,{...a}], '2026-09-10').pairs.length,0);
  assert.equal(findBookingConflicts([a,{...a},b,{...b}], '2026-09-10').pairs.length,1);
});

test('a same-identity final cancellation suppresses its stale paid duplicate regardless of order', () => {
  const a=order('1000001','2026-10-17','2026-10-27',{source:'samboat'}),b=order('b','2026-10-20','2026-10-22');
  const cancelled={source:'samboat',booking_id:'1000001',status:'cancelled'};
  for(const input of [[a,b,cancelled],[cancelled,b,a]])assert.equal(findBookingConflicts(input,'2026-09-10').pairs.length,0);
});

test('past intersections are excluded even when one booking continues into the future', () => {
  const a=order('a','2027-01-01','2027-01-20'),b=order('b','2027-01-01','2027-01-08');
  assert.equal(findBookingConflicts([a,b],'2027-01-08').pairs.length,1);
  assert.equal(findBookingConflicts([a,b],'2027-01-09').pairs.length,0);
});

test('an ongoing intersection keeps its true start and full overlap-night count', () => {
  const result=findBookingConflicts([order('a','2027-01-01','2027-01-20'),order('b','2027-01-05','2027-01-12')],'2027-01-10');
  assert.equal(result.pairs[0].start,'2027-01-05');assert.equal(result.pairs[0].end,'2027-01-13');assert.equal(result.pairs[0].nights,8);
});

test('strict Gregorian dates reject rollover, timestamps, empty and reversed intervals', () => {
  const baseline=order('base','2028-01-01','2028-12-31');
  for(const [start,end] of [['2028-02-30','2028-03-02'],['2027-02-29','2028-03-02'],['2028-04-31','2028-05-02'],['2028-01-01T00:00:00Z','2028-01-05'],['2028-1-1','2028-01-05'],['2028-01-05','2028-01-05'],['2028-01-06','2028-01-05'],[null,'2028-01-05'],['2028-01-01','']]) {
    assert.equal(findBookingConflicts([baseline,order('invalid',start,end)],'2028-01-01').pairs.length,0,JSON.stringify([start,end]));
  }
  for(const today of [undefined,null,'2028-02-30','2028-1-1','not-a-date'])assert.deepEqual(findBookingConflicts([baseline,baseline],today),{pairs:[],bookingKeys:[]});
});

test('UTC nights stay integral across leap day and daylight-saving transitions', () => {
  for(const [start,end,nights] of [['2028-02-28','2028-03-01',2],['2027-03-13','2027-03-16',3],['2027-11-06','2027-11-09',3],['2026-12-31','2027-01-02',2]]) {
    const result=findBookingConflicts([order('a',start,end),order('b',start,end)],'2026-01-01');assert.equal(result.pairs[0].nights,nights+1);
  }
});

test('identity validation is deterministic and missing IDs never collide accidentally', () => {
  assert.equal(bookingIdentity({source:'samboat',booking_id:1502428}),'samboat:1502428');
  assert.equal(bookingIdentity({source:' samboat ',booking_id:' 1502428 '}),'samboat:1502428');
  for(const value of [null,[],{}, {source:'samboat'}, {source:'samboat',booking_id:''}, {source:'samboat',booking_id:{}}, {source:'bad:source',booking_id:'1'}, {source:'samboat',booking_id:NaN}])assert.equal(bookingIdentity(value),null);
  assert.deepEqual(findBookingConflicts(null,'2027-01-01'),{pairs:[],bookingKeys:[]});
});

test('results sort stably without mutating input orders or the input array', () => {
  const input=[order('c','2027-02-01','2027-02-05'),order('a','2027-01-01','2027-01-08'),order('b','2027-01-02','2027-02-03')];
  const before=JSON.stringify(input);input.forEach(Object.freeze);Object.freeze(input);
  const result=findBookingConflicts(input,'2026-09-10');
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(simple(result),simple(findBookingConflicts([...input].reverse(),'2026-09-10')));
  assert.equal(result.pairs[0].start,'2027-01-02');assert.equal(result.pairs[1].start,'2027-02-01');
});

test('both functions serialize independently and the combined browser script needs no module or Node globals', () => {
  const context=vm.createContext({});
  const separateIdentity=vm.runInContext('('+bookingIdentity.toString()+')',context);
  const separateFind=vm.runInContext('('+findBookingConflicts.toString()+')',context);
  const input=[order('303719','2026-12-26','2027-01-02'),order('1502428','2027-01-01','2027-01-08',{source:'samboat'})];
  assert.equal(separateIdentity(input[0]),bookingIdentity(input[0]));
  assert.equal(JSON.stringify(separateFind(input,'2026-09-10')),JSON.stringify(findBookingConflicts(input,'2026-09-10')));
  vm.runInContext(BOOKING_CONFLICTS_SCRIPT,context);
  assert.equal(JSON.stringify(context.findBookingConflicts(input,'2026-09-10')),JSON.stringify(findBookingConflicts(input,'2026-09-10')));
});
