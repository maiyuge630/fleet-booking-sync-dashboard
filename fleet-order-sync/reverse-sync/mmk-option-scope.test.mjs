import test from 'node:test';
import assert from 'node:assert/strict';
import {MmkAdapter,unrelatedManualOption,mmkBlock} from './mmk-adapter.mjs';
const boat='1000000000000000001';
const option={id:'8884287518337030369',statusId:'2',yacht:{id:boat},checkInDate:'2027-03-06 14:00:00',checkOutDate:'2027-03-19 10:00:00',bookingOrigin:'',internalRemarks:'',clientId:'real-client',paidAmount:0};
const target={listing_id:boat,segments:[{start:'2026-11-18',end:'2026-11-25'},{start:'2027-02-13',end:'2027-02-28'}]};
function fixture(models){
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 adapter.client={list:async()=>models.map(m=>({id:m.id,status:m.statusId==='2'?'Option':'Reservation'})),getMany:async ids=>ids.map(id=>models.find(m=>m.id===id)),save:async()=>{throw Error('must_not_modify_native_record');},create:async()=>{throw Error('must_not_create_during_read');}};
 return adapter;
}
test('real March native Option does not block unrelated November/February sync or count as coverage',async()=>{
 const frozen=structuredClone(option),adapter=fixture([frozen]);
 const read=await adapter.read(target);
 assert.equal(read.complete,true);assert.deepEqual(read.blocks,[]);assert.deepEqual(frozen,option);
 await adapter.prepare(target,{start:'2026-11-18',end:'2026-11-25'});
});
test('native Option touching any required night fails closed',async()=>{
 for(const segment of [{start:'2027-03-06',end:'2027-03-07'},{start:'2027-03-18',end:'2027-03-19'},{start:'2027-03-07',end:'2027-03-08'},{start:'2027-03-01',end:'2027-03-07'}]){
  await assert.rejects(fixture([option]).read({...target,segments:[segment]}),/mmk_manual_or_partial_day_requires_review/);
 }
});
test('a night starting on the Option return day is a turnover, not an overlap (2026-10-09)',async()=>{
 for(const segment of [{start:'2027-03-19',end:'2027-03-20'},{start:'2027-03-01',end:'2027-03-06'}])
  assert.deepEqual((await fixture([option]).read({...target,segments:[segment]})).blocks,[]);
});
test('native Option overlapping an old managed Reservation prevents release even outside current targets',async()=>{
 const managed={...option,id:'owned',statusId:'1',checkInDate:'2027-03-10 00:00:00',checkOutDate:'2027-03-11 00:00:00',bookingOrigin:'TidewynSync:owned'};
 for(const models of [[option,managed],[managed,option]])await assert.rejects(fixture(models).read(target),/mmk_manual_or_partial_day_requires_review/);
 assert.equal(unrelatedManualOption(option,target,[mmkBlock(managed)]),false);
});
test('an owned draft, unfamiliar status or malformed date cannot be ignored',()=>{
 for(const change of [{bookingOrigin:'TidewynSync:owned'},{internalRemarks:'TidewynSync:owned'},{statusId:'unknown'},{statusId:'1'},{checkInDate:'2027-02-30 14:00:00'},{checkOutDate:'2027-03-19 25:00:00'},{checkOutDate:option.checkInDate},{checkInDate:'2027-03-06'},{yacht:{id:'other'}}])assert.equal(unrelatedManualOption({...option,...change},target,[]),false);
 assert.equal(unrelatedManualOption(option,{listing_id:boat},[]),false);
 assert.equal(unrelatedManualOption(option,{...target,segments:[{start:'bad',end:'date'}]},[]),false);
});
test('an Option moved into a required interval between reads stops prepare',async()=>{
 const live=structuredClone(option),adapter=fixture([live]);await adapter.read(target);
 live.checkInDate='2026-11-20 14:00:00';live.checkOutDate='2026-11-22 10:00:00';
 await assert.rejects(adapter.prepare(target,{start:'2026-11-18',end:'2026-11-25'}),/mmk_manual_or_partial_day_requires_review/);
});
test('a required night runs 14:00 to 10:00: exact adjacency is disjoint, a one-second overlap is not',()=>{
 const targetNight={...target,segments:[{start:'2027-03-06',end:'2027-03-07'}]};
 assert.equal(unrelatedManualOption({...option,checkInDate:'2027-03-07 10:00:00'},targetNight,[]),true);
 assert.equal(unrelatedManualOption({...option,checkInDate:'2027-03-07 09:59:59'},targetNight,[]),false);
 assert.equal(unrelatedManualOption({...option,checkInDate:'2027-03-01 00:00:00',checkOutDate:'2027-03-06 14:00:00'},targetNight,[]),true);
 assert.equal(unrelatedManualOption({...option,checkInDate:'2027-03-01 00:00:00',checkOutDate:'2027-03-06 14:00:01'},targetNight,[]),false);
});
