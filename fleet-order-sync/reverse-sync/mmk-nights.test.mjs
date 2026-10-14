// MMK half-day protection (user decision 2026-10-09, AGENTS.md 7.7): program
// records board 14:00 and return 10:00, and the 33 records the business side
// re-timed on 2026-10-05 stay ours when nothing else about them changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {MmkAdapter,mmkBlock,retimedProgramRecord,WHOLE_DAY_WRITES_BEFORE} from './mmk-adapter.mjs';

const now=Date.parse('2026-10-09T20:00:00Z'),stamp=new Date(now).toISOString();
const listing='1000000000000000003',key='mmk:'+listing,boat='grandcat-55-tidewyn-discovery-5';
const marker='TidewynSync:a1 boataround:1';
const program=(checkInDate,checkOutDate,change={})=>({id:'26-41020',yacht:{id:listing},statusId:'1',checkInDate,checkOutDate,
 bookingOrigin:marker,internalRemarks:marker,remarks:'',freeEntry:true,finalPrice:0,paidAmount:0,payments:[],invoiceId:'',clientId:'-1',guestId:null,...change});
// Boataround 12-13 to 12-19: whole days 12-13..12-19 then, nights 12-13..12-18 now.
const wholeDay=program('2026-12-13 00:00:00','2026-12-20 00:00:00');
const retimed=program('2026-12-13 14:00:00','2026-12-19 10:00:00');
const attempt=()=>({id:'a1',target:key,start:'2026-12-13',end:'2026-12-20',causes:['boataround:1'],state:'confirmed',
 submitted_at:'2026-09-13T10:00:00.000Z',confirmed_at:'2026-09-13T10:01:00.000Z',response:{draft_id:'26-41020',marker},created:mmkBlock(wholeDay),before:[]});
const night={start:'2026-12-13',end:'2026-12-19'};

function fixture(models,{attempts=[attempt()],segments=[{...night,causes:['boataround:1']}],orders=[{key:'boataround:1',state:'active',...night}]}={}){
 const records=new Map(models.map(m=>[m.id,structuredClone(m)])),events=[];let serial=0;
 let state={version:1,attempts:structuredClone(attempts),targets:{}};
 const target={target:'mmk',boat,listing_id:listing,fresh:true,segments,release_proof:{ready:true,checked_at:stamp,orders}};
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};adapter.close=async()=>{};
 adapter.client={
  list:async()=>[...records.values()].map(m=>({id:m.id,status:m.statusId==='5'?'Canceled':m.statusId==='2'?'Option':'Reservation'})),
  getMany:async ids=>{events.push('getMany:'+ids.length);return ids.map(id=>structuredClone(records.get(id)));},
  get:async id=>structuredClone(records.get(id)),
  create:async(yachtId,start)=>{const id='new-'+(++serial);events.push('create');
   records.set(id,{id,yacht:{id:yachtId},statusId:'2',clientId:'-1',guestId:null,paidAmount:0,payments:[],invoiceId:'',checkInDate:start+' 14:00:00',checkOutDate:start+' 10:00:00'});return id;},
  available:async arg=>{events.push('available:'+arg.start+'/'+arg.end);return true;},
  save:async model=>{events.push('save-status-'+model.statusId);records.set(model.id,structuredClone(model));return structuredClone(model);}};
 const options={now:()=>now,load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);},
  plan:async()=>({generated_at:stamp,targets:[structuredClone(target)]}),adapters:{mmk:adapter}};
 return {target,records,events,adapter,run:()=>new ReverseExecutor(options).run(),state:()=>state};
}

test('a re-timed program record is adopted with its new nights, without any write, and the yacht is protected',async()=>{
 const f=fixture([retimed]);await f.run();
 const a=f.state().attempts[0];
 assert.deepEqual([a.start,a.end],['2026-12-13','2026-12-19']);
 assert.deepEqual(a.created,mmkBlock(retimed));
 assert.deepEqual(a.mmk_nights.old,{start:'2026-12-13',end:'2026-12-20',created:mmkBlock(wholeDay)});
 assert.equal(f.state().targets[key].state,'protected');
 assert.ok(!f.events.some(e=>e==='create'||e.startsWith('save')),f.events.join());
 assert.deepEqual(f.records.get('26-41020'),retimed);
 // A second run neither re-reads the adopted record for adoption nor writes.
 const reads=f.events.filter(e=>e.startsWith('getMany')).length;await f.run();
 assert.equal(f.events.filter(e=>e.startsWith('getMany')).length,reads+1,'only the normal calendar read');
 assert.equal(f.state().targets[key].state,'protected');
});

test('a gap returning on the day a whole-day record boards: that night is reported, not written (review 2026-10-10)',async()=>{
 const manual={id:'m1',yacht:{id:listing},statusId:'1',checkInDate:'2026-12-20 00:00:00',checkOutDate:'2026-12-25 00:00:00',bookingOrigin:'',internalRemarks:'',
  remarks:'',freeEntry:true,finalPrice:0,paidAmount:0,payments:[],invoiceId:'',clientId:'-1',guestId:null};
 const order=(start,end)=>({segments:[{start,end,causes:['boataround:1']}],orders:[{key:'boataround:1',state:'active',start,end}],attempts:[]});
 const f=fixture([manual],order('2026-12-13','2026-12-20'));await f.run();
 // The write returns 12-19 10:00; the night of 12-19 would overlap 12-20 00:00.
 assert.ok(f.events.includes('available:2026-12-13/2026-12-19'),f.events.join());
 assert.ok(!f.events.includes('available:2026-12-13/2026-12-20'));
 assert.deepEqual(f.state().targets[key].blocked,[{start:'2026-12-19',end:'2026-12-20',error:'mmk_turnover_conflict'}]);
 // A single such night: no draft is created at all, and later runs do the same.
 const g=fixture([manual],order('2026-12-19','2026-12-20'));await g.run();await g.run();
 assert.ok(!g.events.includes('create'),g.events.join());
 assert.deepEqual(g.state().targets[key].blocked,[{start:'2026-12-19',end:'2026-12-20',error:'mmk_turnover_conflict'}]);
 // A record boarding at 14:00 does not collide with a 10:00 return.
 const h=fixture([{...manual,checkInDate:'2026-12-20 14:00:00',checkOutDate:'2026-12-25 10:00:00',statusId:'1',bookingOrigin:marker,internalRemarks:marker}],order('2026-12-13','2026-12-20'));
 await h.run();assert.ok(h.events.includes('available:2026-12-13/2026-12-20'),h.events.join());
});

test('after adoption a cancelled order releases the record it owns',async()=>{
 const f=fixture([retimed],{segments:[],orders:[{key:'boataround:1',state:'cancelled'}]});await f.run();
 assert.equal(f.records.get('26-41020').statusId,'5');
 assert.equal(f.state().attempts[0].state,'released');assert.equal(f.state().targets[key].state,'protected');
});

test('any change besides the two times, a wider range, or a second receipt is never adopted',()=>{
 const a=attempt();
 assert.deepEqual(retimedProgramRecord(a,retimed,1),mmkBlock(retimed));
 // Booking Manager rows such as 26-41012 kept their last date: 12-26 14:00 to 01-01 10:00.
 assert.ok(retimedProgramRecord(a,program('2026-12-13 14:00:00','2026-12-20 10:00:00'),1));
 for(const change of [{clientId:'customer'},{guestId:'guest'},{paidAmount:5},{payments:[{amount:1}]},{finalPrice:10},{invoiceId:'inv'},
  {remarks:'human edit'},{internalRemarks:'other'},{bookingOrigin:'TidewynSync:other'},{freeEntry:false},{statusId:'2'},{yacht:{id:'other'}},
  {checkInDate:'2026-12-12 14:00:00'},{checkOutDate:'2026-12-21 10:00:00'},{checkInDate:'2026-12-13 15:00:00'},
  {checkInDate:'2026-12-14 00:00:00',checkOutDate:'2026-12-19 00:00:00'}])
  assert.equal(retimedProgramRecord(a,{...retimed,...change},1),null,JSON.stringify(change));
 assert.equal(retimedProgramRecord(a,retimed,2),null);
 assert.equal(retimedProgramRecord({...a,state:'releasing'},retimed,1),null);
 assert.equal(retimedProgramRecord(a,wholeDay,1),null,'an unchanged whole-day record needs no adoption');
});

test('an unadopted re-timed record still covers its nights but keeps the old claim visible for review',async()=>{
 const f=fixture([{...retimed,remarks:'changed by hand'}]);await f.run();
 const a=f.state().attempts[0];
 assert.deepEqual([a.start,a.end,a.mmk_nights],['2026-12-13','2026-12-20',undefined]);
 assert.equal(f.state().targets[key].state,'removal_requires_verification');
 assert.ok(!f.events.some(e=>e==='create'||e.startsWith('save')));
});

test('only whole-day era receipts are considered, never one with a resize in flight',async()=>{
 for(const change of [{submitted_at:WHOLE_DAY_WRITES_BEFORE},{mmk_resize:{version:1,history:[{state:'submitting'}]}},{mmk_nights:{version:1}}]){
  const f=fixture([retimed],{attempts:[{...attempt(),...change}]});
  await f.adapter.adoptRetimed(f.target,{version:1,attempts:[{...attempt(),...change}],targets:{}},async()=>{},now);
  assert.deepEqual(f.events,[],JSON.stringify(change));
 }
});

test('a new protection boards 14:00 and returns 10:00, next to a native charter returning that morning',async()=>{
 // The real AD1 case: SEARADAR 02-06 14:00 to 02-13 10:00 is an MMK order;
 // a SamBoat stay from 02-13 must still be closed on MMK.
 const searadar={id:'8914843858337030369',yacht:{id:listing},statusId:'1',checkInDate:'2027-02-06 14:00:00',checkOutDate:'2027-02-13 10:00:00',
  bookingOrigin:'',internalRemarks:'',clientId:'searadar',paidAmount:0,payments:[]};
 const stay={start:'2027-02-13',end:'2027-02-27'};
 const f=fixture([searadar],{attempts:[],segments:[{...stay,causes:['samboat:1']}],orders:[{key:'samboat:1',state:'active',...stay}]});
 await f.run();
 const created=[...f.records.values()].find(m=>m.id.startsWith('new-'));
 assert.deepEqual([created.checkInDate,created.checkOutDate,created.statusId],['2027-02-13 14:00:00','2027-02-27 10:00:00','1']);
 assert.ok(f.events.includes('available:2027-02-13/2027-02-27'));
 assert.equal(f.state().targets[key].state,'protected');
 assert.deepEqual(f.records.get(searadar.id),searadar);
});
