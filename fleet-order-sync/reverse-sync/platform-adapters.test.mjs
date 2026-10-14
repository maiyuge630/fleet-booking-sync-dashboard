import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBoataround,BoataroundAdapter} from './boataround-adapter.mjs';
import {normalizeSamBoat,SamBoatAdapter} from './samboat-adapter.mjs';
test('Boataround converts each inclusive protected day and retains native type',()=>{
 const rows=normalizeBoataround({type:1,boat_id:'b',items:[{from:'2026-12-31',to:'2027-01-01',type:5}]});
 assert.deepEqual(rows.map(r=>[r.start,r.end,r.type]),[['2026-12-31','2027-01-01',5],['2027-01-01','2027-01-02',5]]);
});
test('Boataround refuses externally managed and unrecognized calendars',()=>{
 for(const record of [{type:2,items:[]},{type:1,items:[{from:'2026-01-01',to:'2026-01-02',type:9}]},{type:1,items:[{from:'2026-02-30',to:'2026-03-02',type:3}]}])assert.throws(()=>normalizeBoataround(record));
});
test('SamBoat includes final occupied night while excluding advance-notice rules',()=>{
 const rows=normalizeSamBoat([{unavailability_type:'anticipation'},{id:4,start:'2027-01-01 00:00:00',end:'2027-01-07 00:00:00',halfday:0,unavailability_type:'reservation'}]);
 assert.deepEqual(rows,[{id:'reservation:4',start:'2027-01-01',end:'2027-01-08',type:'reservation'}]);
});
test('SamBoat refuses partial slots rather than inventing full-day coverage',()=>{
 assert.throws(()=>normalizeSamBoat([{id:4,start:'2027-01-01 00:00:00',end:'2027-01-07 00:00:00',halfday:1,unavailability_type:'reservation'}]));
});

test('SamBoat duplicate IDs fail and manual metadata edits invalidate old fingerprints',async()=>{
 const r={id:4,start:'2027-01-01 00:00:00',end:'2027-01-07 00:00:00',halfday:0,unavailability_type:'unavailability',type:null};
 assert.throws(()=>normalizeSamBoat([r,r]),/duplicate/);
 const old=normalizeSamBoat([r])[0],changed=normalizeSamBoat([{...r,type:'wintering'}])[0];assert.notDeepEqual(old,changed);
 const a=new SamBoatAdapter({});a.listing='1';a.before=[changed];await assert.rejects(a.remove({listing_id:'1'},changed),/identity/);
});
test('last-moment calendar changes fail preparation before any platform write',async()=>{
 const old={id:'1',start:'2027-01-01',end:'2027-01-02',type:3};
 for(const [Class,target] of [[BoataroundAdapter,{boat:'boat',listing_id:'1'}],[SamBoatAdapter,{boat:'boat',listing_id:'1'}]]){
  const a=new Class({});a.target='boat';a.listing='1';a.before=[old];a.read=async()=>({complete:true,identity_verified:true,blocks:[old,{...old,id:'2'}]});
  await assert.rejects(a.prepare(target,{start:'2027-01-03',end:'2027-01-04'}),/target_changed/);
 }
});
