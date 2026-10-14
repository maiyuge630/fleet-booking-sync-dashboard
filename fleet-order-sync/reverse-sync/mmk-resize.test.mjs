import test from 'node:test';
import assert from 'node:assert/strict';
import {mmkBlock} from './mmk-adapter.mjs';
import {mmkResizeProposal,recoverMmkResizes} from './mmk-resize.mjs';
import {releaseAllowed} from './release.mjs';
const NOW=Date.parse('2026-09-26T04:00:00Z'),boat='1000000000000000002';
const range=(start,end,causes=['ba:left','ba:right'])=>({start,end,causes});
const active=(key,start,end)=>({key,state:'active',start,end});
const cancelled=key=>({key,state:'cancelled'});
const marker='TidewynSync:original ba:right';
function setup({start='2026-12-12',end='2026-12-20',segments=[range('2026-12-05','2026-12-20')],orders=[active('ba:left','2026-12-05','2026-12-12'),active('ba:right','2026-12-12','2026-12-20')]}={}){
 let current={id:'original-id',yacht:{id:boat},statusId:'1',freeEntry:true,finalPrice:0,paidAmount:0,payments:[],invoiceId:'',clientId:'-1',guestId:null,
  checkInDate:start+' 00:00:00',checkOutDate:end+' 00:00:00',bookingOrigin:marker,internalRemarks:marker};
 const target={target:'mmk',listing_id:boat,boat:'ad2',fresh:true,segments,release_proof:{ready:true,checked_at:new Date(NOW).toISOString(),orders}};
 const attempt={id:'original',target:'mmk:'+boat,start,end,causes:['ba:right'],release_causes:{version:1,causes:['ba:left','ba:right']},
  created:mmkBlock(current),state:'confirmed',response:{marker},before:[]};
 if(start==='2026-12-05')attempt.mmk_resize={version:1,history:[{id:'earlier-extension',mode:'extend',state:'confirmed',
  old:mmkBlock({...current,checkInDate:'2026-12-12 00:00:00'}),new:mmkBlock(current),before:[],release_causes:['ba:left','ba:right']}]};
 const ledger={version:1,attempts:[attempt],targets:{}},other=[];
 let writes=0,reads=0,checks=0,available=0;
 const persisted=[];
 const adapter={read:async()=>{reads++;return {complete:true,identity_verified:true,blocks:[mmkBlock(current),...other.map(mmkBlock)]};},
  client:{get:async()=>structuredClone(current),available:async arg=>{available++;assert.equal(arg.id,'original-id');return true;},
   save:async model=>{writes++;current=structuredClone(model);return structuredClone(current);}}};
 const save=async()=>{persisted.push(structuredClone(ledger));};
 const guard=async()=>{checks++;return target;};
 const run=(options={})=>recoverMmkResizes({adapter,target,ledger,guard,save,blockOf:mmkBlock,now:()=>NOW,...options});
 return {adapter,target,attempt,ledger,other,persisted,run,save,guard,model:()=>current,setModel:value=>{current=structuredClone(value);},writes:()=>writes,reads:()=>reads,checks:()=>checks,available:()=>available};
}

test('adjacent exact needed gap extends one owned ID once and persists intent before mutation',async()=>{
 const f=setup(),initial=structuredClone(f.model());
 const write=f.adapter.client.save;
 f.adapter.client.save=async model=>{
  assert.equal(f.persisted.at(-1).attempts[0].mmk_resize.history[0].state,'submitting');
  assert.equal(model.id,initial.id);assert.equal(model.bookingOrigin,initial.bookingOrigin);
  // Since 2026-10-09 every MMK program write boards 14:00 and returns 10:00.
  assert.equal(model.checkInDate,'2026-12-05 14:00:00');assert.equal(model.checkOutDate,'2026-12-20 10:00:00');return write(model);
 };
 await f.run();
 assert.equal(f.writes(),1);assert.equal(f.ledger.attempts.length,1);assert.equal(f.attempt.start,'2026-12-05');
 assert.equal(f.attempt.created.id,initial.id);assert.deepEqual(f.attempt.causes,['ba:right']);
 assert.deepEqual(f.attempt.release_causes.causes,['ba:left','ba:right']);
 assert.equal(f.attempt.mmk_resize.history[0].state,'confirmed');
 await f.run();assert.equal(f.writes(),1,'unchanged next run must not write');
});

test('extension cannot bridge an unneeded gap, consume another block or overlap a pending create',async()=>{
 const disconnected=setup({segments:[range('2026-12-05','2026-12-10'),range('2026-12-12','2026-12-20')]});
 await disconnected.run();assert.equal(disconnected.writes(),0);
 const occupied=setup();occupied.other.push({...occupied.model(),id:'manual',bookingOrigin:'manual',checkInDate:'2026-12-05 00:00:00',checkOutDate:'2026-12-08 00:00:00'});
 await occupied.run();assert.equal(occupied.attempt.start,'2026-12-08');assert.equal(occupied.other[0].checkOutDate,'2026-12-08 00:00:00');
 const pending=setup();pending.ledger.attempts.push({id:'pending-create',target:'mmk:'+boat,state:'submitting',start:'2026-12-05',end:'2026-12-12'});
 await assert.rejects(pending.run(),/previous_write_uncertain/);assert.equal(pending.writes(),0);
});

test('confirmed unique receipt rejects financial, customer, manual and ownership changes',async()=>{
 for(const change of [{paidAmount:1},{finalPrice:1},{payments:[{amount:0}]},{payments:null},{invoiceId:'invoice'},
  {clientId:'customer'},{guestId:'guest'},{guestId:undefined},{freeEntry:false},{statusId:'2'},
  {internalRemarks:'manual edit'},{bookingOrigin:'manual'},{remarks:'human change'}]){
  const f=setup();f.setModel({...f.model(),...change});
  await assert.rejects(f.run(),/ownership_unverified|calendar_unverified/);assert.equal(f.writes(),0);
 }
 const duplicate=setup();duplicate.ledger.attempts.push({...structuredClone(duplicate.attempt),id:'historic',state:'released'});
 await assert.rejects(duplicate.run(),/ownership_unverified/);assert.equal(duplicate.writes(),0);
 const duplicateDraft=setup();duplicateDraft.ledger.attempts.push({id:'historic-draft',target:'mmk:'+boat,state:'not_submitted',response:{draft_id:'original-id'}});
 await assert.rejects(duplicateDraft.run(),/ownership_unverified/);assert.equal(duplicateDraft.writes(),0);
 const wrongMarker=setup();wrongMarker.attempt.response.marker='TidewynSync:other ba:right';
 await assert.rejects(wrongMarker.run(),/ownership_unverified/);
});

test('left cancellation shrinks only the left edge and preserves the remaining cause',async()=>{
 const f=setup({start:'2026-12-05',segments:[range('2026-12-12','2026-12-20',['ba:right'])],orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20')]});
 await f.run();assert.equal(f.writes(),1);assert.equal(f.attempt.start,'2026-12-12');assert.equal(f.attempt.end,'2026-12-20');
 assert.equal(f.attempt.mmk_resize.history.at(-1).mode,'shrink');assert.deepEqual(f.attempt.release_causes.causes,['ba:left','ba:right']);
});

test('right cancellation shrinks only the right edge, including an original still-active cause moved away',async()=>{
 const f=setup({start:'2026-12-05',segments:[range('2026-12-05','2026-12-12',['ba:left'])],orders:[active('ba:left','2026-12-05','2026-12-12'),active('ba:right','2027-02-01','2027-02-05')]});
 await f.run();assert.equal(f.writes(),1);assert.equal(f.attempt.start,'2026-12-05');assert.equal(f.attempt.end,'2026-12-12');
 assert.deepEqual(f.attempt.causes,['ba:right']);
});

test('all cancelled dates are left for existing full release; an internal hole never splits or cancels',async()=>{
 const all=setup({start:'2026-12-05',segments:[],orders:[cancelled('ba:left'),cancelled('ba:right')]});
 await all.run();assert.equal(all.writes(),0);assert.equal(all.attempt.mmk_resize.history.length,1);
 assert.equal(releaseAllowed(all.attempt,all.target,NOW),true);
 const split=setup({start:'2026-12-05',segments:[range('2026-12-05','2026-12-07',['ba:left']),range('2026-12-15','2026-12-20',['ba:right'])],
  orders:[active('ba:left','2026-12-05','2026-12-07'),active('ba:right','2026-12-15','2026-12-20')]});
 await split.run();assert.equal(split.attempt.mmk_resize.review.reason,'mmk_resize_split_requires_review');assert.equal(split.writes(),0);
});

test('missing, stale, failed, duplicate or unknown release proof never shrinks',async()=>{
 const changes=[proof=>{proof.ready=false;},proof=>{proof.checked_at=new Date(NOW-61000).toISOString();},proof=>{proof.orders=proof.orders.slice(1);},
  proof=>{proof.orders[0].state='unknown';},proof=>{proof.orders.push({...proof.orders[0]});},proof=>{proof.orders[1].end='invalid';}];
 for(const mutate of changes){
  const f=setup({start:'2026-12-05',segments:[range('2026-12-12','2026-12-20',['ba:right'])],orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20')]});
  mutate(f.target.release_proof);await f.run();assert.equal(f.attempt.mmk_resize.review.reason,'mmk_resize_release_unverified');assert.equal(f.writes(),0);
 }
});

test('all active orders and manual holds retain their dates even when omitted from paid target segments',async()=>{
 const f=setup({start:'2026-12-05',segments:[range('2026-12-12','2026-12-20',['ba:right'])],orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20'),active('new','2026-12-05','2026-12-12')]});
 await f.run();assert.equal(f.writes(),0);
 const hold=setup({start:'2026-12-05',segments:[range('2026-12-05','2026-12-12',['manual-hold:h']),range('2026-12-12','2026-12-20',['ba:right'])],
  orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20'),active('manual-hold:h','2026-12-05','2026-12-12')]});
 hold.target.fleet_hold_control={version:1,revision:1,holds:[{id:'h',active:true,start:'2026-12-05',end:'2026-12-12'}]};
 await hold.run();assert.equal(hold.writes(),0);
});

test('lost acknowledgement after saved resize is reconciled on restart with exact new fingerprint and no replay',async()=>{
 const f=setup(),write=f.adapter.client.save;
 f.adapter.client.save=async model=>{await write(model);throw Error('lost_response');};
 await assert.rejects(f.run(),/lost_response/);assert.equal(f.writes(),1);assert.equal(f.attempt.start,'2026-12-12');
 assert.equal(f.attempt.mmk_resize.history[0].state,'submitting');
 f.adapter.client.save=async()=>{throw Error('must_not_replay');};
 await f.run();assert.equal(f.writes(),1);assert.equal(f.attempt.start,'2026-12-05');
 assert.equal(f.attempt.mmk_resize.history[0].state,'confirmed');assert.equal(f.ledger.attempts.length,1);
});

test('lost request that leaves old record and altered new readbacks are never blindly retried',async()=>{
 for(const outcome of ['old','human-change','payment','other-change']){
  const f=setup(),write=f.adapter.client.save;
  f.adapter.client.save=async model=>{
   if(outcome!=='old')await write(model);
   if(outcome==='human-change')f.setModel({...f.model(),remarks:'manual edit'});
   if(outcome==='payment')f.setModel({...f.model(),payments:[{amount:0}]});
   if(outcome==='other-change')f.other.push({...f.model(),id:'new-other',bookingOrigin:'manual',checkInDate:'2027-06-01 00:00:00',checkOutDate:'2027-06-02 00:00:00'});
   throw Error('lost_response');
  };
  await assert.rejects(f.run(),/lost_response/);const writes=f.writes();
  f.adapter.client.save=async()=>{throw Error('must_not_replay');};
  await assert.rejects(f.run(),/resize_uncertain|ownership_unverified/);assert.equal(f.writes(),writes);
  assert.equal(f.attempt.mmk_resize.history[0].state,'submitting');
 }
});

test('failed persistence, cancellation and changed latest sources never reach mutation',async()=>{
 const saveFailure=setup();await assert.rejects(saveFailure.run({save:async()=>{throw Error('disk_full');}}),/disk_full/);assert.equal(saveFailure.writes(),0);
 for(const when of [1,2,3]){
  const f=setup();let guards=0;
  await assert.rejects(f.run({guard:async()=>{if(++guards===when)throw Error('executor_cancelled');return f.target;}}),/executor_cancelled/);
  assert.equal(f.writes(),0);if(when===3)assert.equal(f.attempt.mmk_resize.history[0].state,'not_submitted');
 }
 const changed=setup();let checks=0;
 await assert.rejects(changed.run({guard:async()=>++checks===3?{...changed.target,segments:[range('2026-12-12','2026-12-20',['ba:right'])]}:changed.target}),/source_changed/);
 assert.equal(changed.writes(),0);
 const legacyGuard=setup();await assert.rejects(legacyGuard.run({guard:async()=>{}}),/latest_plan_required/);assert.equal(legacyGuard.writes(),0);
});

test('manual edit after durable intent stops write; latest non-business metadata is preserved',async()=>{
 const changed=setup();const save=changed.save;
 await assert.rejects(changed.run({save:async ledger=>{await save(ledger);changed.setModel({...changed.model(),remarks:'new manual remark'});}}),/calendar_changed|ownership_unverified/);
 assert.equal(changed.writes(),0);assert.equal(changed.attempt.mmk_resize.history[0].state,'not_submitted');
 const preserved=setup(),persist=preserved.save;
 await preserved.run({save:async ledger=>{await persist(ledger);if(preserved.writes()===0)preserved.setModel({...preserved.model(),readOnlyMetadata:'fresh'});}});
 assert.equal(preserved.model().readOnlyMetadata,'fresh');
});

test('paid or invoiced save response cannot become a confirmed resize receipt',async()=>{
 for(const change of [{paidAmount:1},{payments:[{amount:0}]},{invoiceId:'new-invoice'}]){
  const f=setup(),write=f.adapter.client.save;
  f.adapter.client.save=async model=>write({...model,...change});
  await assert.rejects(f.run(),/readback_failed|ownership_unverified/);
  assert.equal(f.attempt.mmk_resize.history[0].state,'submitting');assert.equal(f.attempt.start,'2026-12-12');
 }
});

test('history retains extend then shrink generations on the same original receipt',async()=>{
 const f=setup();await f.run();
 f.target.segments=[range('2026-12-12','2026-12-20',['ba:right'])];
 f.target.release_proof.orders=[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20')];
 await f.run();assert.equal(f.writes(),2);assert.equal(f.ledger.attempts.length,1);
 assert.deepEqual(f.attempt.mmk_resize.history.map(e=>[e.mode,e.state]),[['extend','confirmed'],['shrink','confirmed']]);
 assert.deepEqual(f.attempt.release_causes.causes,['ba:left','ba:right']);
 await f.run();assert.equal(f.writes(),2);
});

test('fresh guard proof replaces the stale opening-plan proof before any shrink decision',async()=>{
 const f=setup({start:'2026-12-05',segments:[range('2026-12-12','2026-12-20',['ba:right'])],orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20')]});
 const latest=structuredClone(f.target);f.target.release_proof.checked_at=new Date(NOW-120000).toISOString();
 await f.run({guard:async()=>latest});assert.equal(f.writes(),1);assert.equal(f.attempt.start,'2026-12-12');
});

test('past receipts and unchanged current ranges require neither a fresh guard nor another complete read',async()=>{
 for(const which of ['past','unchanged']){
  const f=which==='past'?setup({start:'2026-01-01',end:'2026-01-10',segments:[],orders:[]}):setup({segments:[range('2026-12-12','2026-12-20')]});
  f.target.release_proof.ready=false;
  await f.run({guard:async()=>{throw Error('unneeded guard');}});
  assert.equal(f.reads(),0);assert.equal(f.writes(),0);
 }
});

test('untouched legacy partial coverage uses original release rules rather than newly adopting resize',async()=>{
 const f=setup({segments:[range('2026-12-15','2026-12-20',['ba:right'])],orders:[]});
 f.target.release_proof.ready=false;
 await f.run({guard:async()=>{throw Error('must not resize legacy record');}});
 assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(f.attempt.mmk_resize,undefined);
});

test('a deferred shrink never changes its receipt and successful later proof clears the review marker',async()=>{
 const f=setup({start:'2026-12-05',segments:[range('2026-12-12','2026-12-20',['ba:right'])],orders:[cancelled('ba:left'),active('ba:right','2026-12-12','2026-12-20')]});
 const receipt=structuredClone(f.attempt.created);f.target.release_proof.ready=false;
 await f.run();assert.deepEqual(f.attempt.created,receipt);assert.equal(f.attempt.start,'2026-12-05');assert.equal(f.writes(),0);
 assert.equal(f.attempt.mmk_resize.review.reason,'mmk_resize_release_unverified');
 f.target.release_proof.ready=true;await f.run();assert.equal(f.writes(),1);assert.equal(f.attempt.mmk_resize.review,undefined);
});
