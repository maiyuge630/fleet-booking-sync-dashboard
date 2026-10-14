import test from 'node:test';
import assert from 'node:assert/strict';
import {MmkAdapter,mmkBlock,unrelatedManualRecord} from './mmk-adapter.mjs';

const boat='1000000000000000001';
const native={id:'8889178168337030369',statusId:'1',yacht:{id:boat},
 checkInDate:'2027-03-07 14:00:00',checkOutDate:'2027-03-19 10:00:00',
 bookingOrigin:'',internalRemarks:'',clientId:'native-customer',paidAmount:100,payments:[{id:'native-payment'}]};
const target={listing_id:boat,segments:[{start:'2026-11-18',end:'2026-11-25'},{start:'2027-02-13',end:'2027-02-28'}]};
const managed={...native,id:'owned',checkInDate:'2027-03-10 00:00:00',checkOutDate:'2027-03-11 00:00:00',
 bookingOrigin:'TidewynSync:owned',internalRemarks:'TidewynSync:owned',paidAmount:0,payments:[]};
function fixture(models){
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 adapter.client={list:async()=>models.map(m=>({id:m.id,status:'Reservation'})),
  getMany:async ids=>ids.map(id=>models.find(m=>m.id===id)),
  get:async id=>models.find(m=>m.id===id),
  save:async()=>{throw Error('must_not_modify_native_record');},
  create:async()=>{throw Error('must_not_create_during_read');}};
 return adapter;
}

test('AD1 unrelated native March Reservation leaves November/February protection operable without adoption',async()=>{
 const before=structuredClone(native),adapter=fixture([before]);
 const result=await adapter.read(target);
 assert.equal(result.complete,true);assert.equal(result.identity_verified,true);
 assert.deepEqual(result.blocks,[]);assert.deepEqual(before,native);
 await adapter.prepare(target,target.segments[0]);
 await assert.rejects(adapter.remove(target,{id:native.id,fingerprint:'not-owned'}),/mmk_owned_record_changed/);
 assert.deepEqual(before,native);
});

test('partial-day Reservation overlapping any required night still fails closed',async()=>{
 for(const segment of [{start:'2027-03-07',end:'2027-03-08'},
  {start:'2027-03-18',end:'2027-03-19'},{start:'2027-03-10',end:'2027-03-11'}]){
  await assert.rejects(fixture([native]).read({...target,segments:[segment]}),/mmk_manual_or_partial_day_requires_review/);
 }
});

test('native Reservation overlapping managed dates awaiting release still blocks in either list order',async()=>{
 for(const segments of [target.segments,[]]){
  const releasingTarget={...target,segments};
  for(const models of [[native,managed],[managed,native]])
   await assert.rejects(fixture(models).read(releasingTarget),/mmk_manual_or_partial_day_requires_review/);
  assert.equal(unrelatedManualRecord(native,releasingTarget,[mmkBlock(managed)]),false);
 }
});

test('missing ownership fields, program markers, unknown states and invalid dates are never excluded',async()=>{
 const changes=[{bookingOrigin:undefined},{internalRemarks:null},{bookingOrigin:123},
  {bookingOrigin:'TidewynSync:owned'},{internalRemarks:'TidewynSync:owned'},
  {statusId:'unknown'},{statusId:'4'},{statusId:'6'},{statusId:'10'},{statusId:'11'},
  {checkInDate:'2027-02-30 14:00:00'},{checkOutDate:'2027-03-19 25:00:00'},
  {checkOutDate:native.checkInDate},{checkOutDate:'2027-03-01 00:00:00'},
  {checkInDate:'2027-03-07'},{yacht:{id:'other'}}];
 for(const change of changes){
  const model={...native,...change};
  assert.equal(unrelatedManualRecord(model,target,[]),false,JSON.stringify(change));
  if(change.yacht)continue;
  // A 14:00/10:00 Reservation carrying the program marker in bookingOrigin is
  // a program block since 2026-10-09: coverage only, no ownership from that.
  if(change.bookingOrigin==='TidewynSync:owned')assert.deepEqual((await fixture([model]).read(target)).blocks,[mmkBlock(model)]);
  else await assert.rejects(fixture([model]).read(target),/mmk_manual_or_partial_day_requires_review/);
 }
 assert.equal(unrelatedManualRecord(native,{listing_id:boat},[]),false);
 assert.equal(unrelatedManualRecord(native,{...target,segments:[{start:'bad',end:'date'}]},[]),false);
 assert.equal(unrelatedManualRecord(native,target,[{marker:'TidewynSync:owned',start:'bad',end:'date'}]),false);
 assert.equal(unrelatedManualRecord(native,target,undefined),false);
});

test('a native Reservation moved into scope between read and prepare prevents a write',async()=>{
 const live=structuredClone(native),adapter=fixture([live]);
 await adapter.read(target);
 live.checkInDate='2026-11-20 14:00:00';live.checkOutDate='2026-11-22 10:00:00';
 await assert.rejects(adapter.prepare(target,target.segments[0]),/mmk_manual_or_partial_day_requires_review/);
});

test('native Reservation turnover adjacency (10:00 / 14:00) is disjoint but a one-second overlap is not',()=>{
 const scoped={...target,segments:[{start:'2027-03-06',end:'2027-03-07'}]};
 assert.equal(unrelatedManualRecord({...native,checkInDate:'2027-03-07 10:00:00'},scoped,[]),true);
 assert.equal(unrelatedManualRecord({...native,checkInDate:'2027-03-07 09:59:59'},scoped,[]),false);
 assert.equal(unrelatedManualRecord({...native,checkInDate:'2027-03-01 14:00:00',checkOutDate:'2027-03-06 14:00:00'},scoped,[]),true);
 assert.equal(unrelatedManualRecord({...native,checkInDate:'2027-03-01 14:00:00',checkOutDate:'2027-03-06 14:00:01'},scoped,[]),false);
});
test('the real SEARADAR turnover: a native 14:00/10:00 Reservation next to a program record is unrelated',async()=>{
 // AD1 2026-10-09: native 2027-02-06 14:00 to 02-13 10:00 next to the program
 // record re-timed to 02-13 14:00 to 02-27 10:00 (business log 286/288).
 const searadar={...native,id:'8914843858337030369',checkInDate:'2027-02-06 14:00:00',checkOutDate:'2027-02-13 10:00:00'};
 const program={...managed,id:'program',checkInDate:'2027-02-13 14:00:00',checkOutDate:'2027-02-27 10:00:00',clientId:'-1',guestId:null,finalPrice:0,freeEntry:true};
 const read=await fixture([searadar,program]).read({...target,segments:[{start:'2027-02-13',end:'2027-02-27'}]});
 assert.deepEqual(read.blocks,[{id:'program',start:'2027-02-13',end:'2027-02-27',type:'1',boat,marker:'TidewynSync:owned',fingerprint:mmkBlock(program).fingerprint}]);
});

test('unrelated native exception does not bypass a complete list or detail read',async()=>{
 for(const method of ['list','getMany']){
  const adapter=fixture([native]);adapter.client[method]=async()=>{throw Error('mmk_list_incomplete');};
  await assert.rejects(adapter.read(target),/mmk_list_incomplete/);
 }
});

test('full-day native Reservations retain existing read-only coverage and no deletion ownership',async()=>{
 const fullDay={...native,checkInDate:'2026-11-18 00:00:00',checkOutDate:'2026-11-25 00:00:00'};
 const adapter=fixture([fullDay]),result=await adapter.read(target);
 assert.deepEqual(result.blocks,[mmkBlock(fullDay)]);
 await assert.rejects(adapter.remove(target,result.blocks[0]),/mmk_owned_record_changed/);
});
