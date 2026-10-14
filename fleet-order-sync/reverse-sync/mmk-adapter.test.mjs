import test from 'node:test';
import assert from 'node:assert/strict';
import {MmkAdapter,mmkBlock,draftStart,MMK_DRAFT_NIGHTS} from './mmk-adapter.mjs';
import {digest,mmkEntryState} from './mmk-client.mjs';
const target={listing_id:'1000000000000000001',segments:[{start:'2027-01-01',end:'2027-01-09'}]};
const draft={clientId:'-1',guestId:null,paidAmount:0,payments:[],id:'new1',yacht:{id:target.listing_id},statusId:'2',checkInDate:'2027-01-01 14:00:00',checkOutDate:'2027-01-08 10:00:00'};
test('Custom never counts as protection; Reservation does',()=>{
 const m={...draft,checkInDate:'2027-01-01 00:00:00',checkOutDate:'2027-01-09 00:00:00'};
 assert.equal(mmkBlock({...m,statusId:'8'}),null);
 assert.equal(mmkBlock({...m,statusId:'1'}).end,'2027-01-09');
});
test('owned record changed by a person cannot be canceled',async()=>{
 const m={...draft,statusId:'1',checkInDate:'2027-01-01 00:00:00',checkOutDate:'2027-01-09 00:00:00',bookingOrigin:'TidewynSync:test'};
 const owned=mmkBlock(m),adapter=new MmkAdapter({});
 adapter.client={get:async()=>({...m,remarks:'manual edit'}),save:async()=>{throw Error('must_not_write');}};
 await assert.rejects(adapter.remove(target,owned),/owned_record_changed/);
});
test('known unchanged draft recovers without creating another record',async()=>{
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 let saves=0,guards=0;
 adapter.client={get:async()=>draft,available:async()=>true,save:async m=>{saves++;return m;}};
 const ledger={attempts:[{target:'mmk:'+target.listing_id,state:'submitting',start:'2027-01-01',end:'2027-01-09',response:{draft_id:'new1',initial_fingerprint:digest(draft),marker:'TidewynSync:owned'}}]};
 await adapter.recover(target,ledger,async()=>{guards++;},async()=>{});
 assert.equal(saves,1);assert.equal(guards,2);assert.equal(ledger.attempts[0].state,'pending_readback');
});
test('modified draft and stale source are never overwritten',async()=>{
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 const a={target:'mmk:'+target.listing_id,state:'submitting',start:'2027-01-01',end:'2027-01-09',response:{draft_id:'new1',initial_fingerprint:digest(draft),marker:'TidewynSync:owned'}};
 adapter.client={get:async()=>({...draft,internalRemarks:'human edit'}),save:async()=>{throw Error('must_not_write');}};
 await assert.rejects(adapter.recover(target,{attempts:[a]},async()=>{},async()=>{}),/requires_review/);
 adapter.client.get=async()=>draft;
 await assert.rejects(adapter.recover(target,{attempts:[a]},async()=>{throw Error('stale');},async()=>{}),/stale/);
});
test('cancel only exact unchanged owned Reservation, not manual record',async()=>{
 const model={...draft,statusId:'1',checkInDate:'2027-01-01 00:00:00',checkOutDate:'2027-01-09 00:00:00',bookingOrigin:'manual'};
 const adapter=new MmkAdapter({});adapter.client={get:async()=>model,save:async()=>{throw Error('must_not_write');}};
 await assert.rejects(adapter.remove(target,mmkBlock(model)),/owned_record_changed/);
});

function recoverSetup(){
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 const a={target:'mmk:'+target.listing_id,state:'submitting',start:'2027-01-01',end:'2027-01-09',response:{draft_id:'new1',initial_fingerprint:digest(draft),marker:'TidewynSync:owned'}};
 let writes=0,reads=0;
 adapter.client={get:async()=>{reads++;return draft;},available:async()=>true,save:async m=>{writes++;return m;}};
 return {adapter,a,run:guard=>adapter.recover(target,{attempts:[a]},guard||(async()=>{}),async()=>{}),writes:()=>writes,reads:()=>reads};
}

test('a release with a lost acknowledgement reaches generic reconciliation without draft recovery',async()=>{
 const x=recoverSetup();x.a.state='releasing';
 x.adapter.client.get=async()=>{throw Error('releasing_must_not_be_recovered_as_create');};
 await x.run();assert.equal(x.a.state,'releasing');assert.equal(x.writes(),0);
});

test('acknowledged rejected-and-canceled draft is retired without blocking a later safe run',async()=>{
 const x=recoverSetup();x.a.response.cancelled=true;x.adapter.client.get=async()=>({...draft,statusId:'5'});
 await x.run();assert.equal(x.a.state,'not_submitted');assert.equal(x.writes(),0);
 await x.run();assert.equal(x.a.state,'not_submitted');
});

test('recovering an Option stops when another booking now occupies its dates',async()=>{
 const x=recoverSetup();x.adapter.client.available=async()=>false;
 await assert.rejects(x.run(),/dates_not_available/);assert.equal(x.writes(),0);assert.equal(x.a.state,'submitting');
});

test('recovery rechecks manual edits and source freshness after availability',async()=>{
 const x=recoverSetup();let edited=false;
 x.adapter.client.available=async()=>{edited=true;return true;};
 x.adapter.client.get=async()=>edited?{...draft,remarks:'manual update'}:draft;
 await assert.rejects(x.run(),/partial_write_requires_review/);assert.equal(x.writes(),0);
 const y=recoverSetup();let checks=0;
 await assert.rejects(y.run(async()=>{if(++checks===2)throw Error('source_changed_or_stale');}),/source_changed_or_stale/);
 assert.equal(y.writes(),0);
});

function submitSetup(){
 const adapter=new MmkAdapter({});let writes=0;const evidence=[];
 adapter.client={create:async()=>draft.id,get:async()=>draft,available:async()=>true,save:async m=>{writes++;return m;}};
 const gap={start:'2027-01-01',end:'2027-01-09'};
 const run=guard=>adapter.submit(target,gap,async e=>{evidence.push(e);},{id:'owned',causes:['boataround:1'],guard});
 return {adapter,run,evidence,writes:()=>writes};
}

test('source changed during draft creation prevents Reservation finalization',async()=>{
 const x=submitSetup();let checks=0;await assert.rejects(x.run(async()=>{if(++checks===2)throw Error('source_changed_or_stale');}),/source_changed_or_stale/);
 assert.equal(x.writes(),0);assert.equal(x.evidence.at(-1).draft_id,draft.id);
});

test('new MMK Reservation receipt must remain zero-price, unpaid and without an invoice',async()=>{
 for(const change of [{finalPrice:10},{paidAmount:10},{payments:[{id:'payment'}]},{invoiceId:'invoice'},{internalRemarks:'changed'},{freeEntry:false}]){
  const x=submitSetup();x.adapter.client.save=async m=>({...m,...change});
  await assert.rejects(x.run(),/reservation_readback_failed/);
 }
 const x=submitSetup();const block=await x.run();assert.equal(block.type,'1');assert.equal(x.writes(),1);
});

test('adding a payment entry prevents cancellation even when its total and old fingerprint are unchanged',async()=>{
 const model={...draft,statusId:'1',freeEntry:true,finalPrice:0,checkInDate:'2027-01-01 00:00:00',checkOutDate:'2027-01-09 00:00:00',bookingOrigin:'TidewynSync:owned'};
 const adapter=new MmkAdapter({});adapter.client={get:async()=>({...model,payments:[{id:'payment',amount:0}]}),save:async()=>{throw Error('must_not_write');}};
 await assert.rejects(adapter.remove(target,mmkBlock(model)),/owned_record_changed/);
});

test('failed tab cleanup releases the stale handle so the next MMK boat reconnects and verifies its account',async()=>{
 const closedPage={},newPage={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn.name==='mmkEntryState'?'ready':{serviceId:'0000',isCharter:true}};
 let opens=0;
 const adapter=new MmkAdapter({openPage:async()=>{opens++;return newPage;},closePage:async()=>{throw Error('tab_close_failed');}});
 adapter.page=closedPage;adapter.client={page:closedPage};
 await assert.rejects(adapter.close(),/tab_close_failed/);
 assert.equal(adapter.page,null);assert.equal(adapter.client,null);
 await adapter.connect({...target,boat:'reef-cat-37-tidewyn-discovery'});
 assert.equal(opens,1);assert.equal(adapter.page,newPage);assert.equal(adapter.client.page,newPage);
});

test('read reconnect replaces both owned adapter and client Pages and closes each exact tab',async()=>{
 const closed=[],events=[];
 const page=read=>({goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?'ready':fn.toString().includes('ReservationsAPI.getData')?{serviceId:'0000',isCharter:true}:read()});
 const old=page(async()=>{throw Error('old CDP timeout');}),fresh=page(async()=>({data:[],itemsLeft:0}));
 const adapter=new MmkAdapter({openPage:async()=>old,closePage:async p=>{closed.push(p);events.push('close');return false;},onReadFailure:async()=>{events.push('reconnect');return fresh;}});
 const result=await adapter.read({...target,boat:'reef-cat-37-tidewyn-discovery'});
 assert.deepEqual(result.blocks,[]);assert.deepEqual(events,['close','reconnect']);
 assert.equal(adapter.page,fresh);assert.equal(adapter.client.page,fresh);
 await adapter.close();assert.deepEqual(closed,[old,fresh]);assert.equal(adapter.page,null);assert.equal(adapter.client,null);
});

test('one fresh MMK page retries a read-only navigation timeout and verifies owner before listing',async()=>{
 const closed=[];let replacements=0,ownerChecks=0;
 const stale={goto:async()=>{throw Error('Page.navigate timed out. Increase the protocolTimeout setting.');}};
 const fresh={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>{
  if(fn===mmkEntryState)return 'ready';
  if(fn.toString().includes('ReservationsAPI.getData')){ownerChecks++;return {serviceId:'0000',isCharter:true};}
  assert.equal(ownerChecks,1,'owner check must precede list');
  return {data:[],itemsLeft:0};
 }};
 const adapter=new MmkAdapter({openPage:async()=>stale,onReadFailure:async()=>{replacements++;return fresh;},closePage:async page=>closed.push(page)});
 const result=await adapter.read({...target,boat:'reef-cat-37-tidewyn-discovery'});
 assert.deepEqual(result.blocks,[]);assert.equal(replacements,1);assert.equal(ownerChecks,1);
 await adapter.close();assert.deepEqual(closed,[stale,fresh]);
});

test('MMK navigation retry is at most once and never bypasses an account mismatch',async()=>{
 const closed=[];let replacements=0;
 const timedOut=()=>({goto:async()=>{throw Error('Page.navigate timed out. Increase the protocolTimeout setting.');}});
 const adapter=new MmkAdapter({openPage:async()=>timedOut(),onReadFailure:async()=>{replacements++;return timedOut();},closePage:async page=>closed.push(page)});
 await assert.rejects(adapter.connect({...target,boat:'reef-cat-37-tidewyn-discovery'}),/Page\.navigate timed out/);
 assert.equal(replacements,1);assert.equal(closed.length,2);assert.equal(adapter.page,null);assert.equal(adapter.client,null);
 const wrong={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?'ready':{serviceId:'other',isCharter:true}};
 const mismatched=new MmkAdapter({openPage:async()=>wrong,onReadFailure:async()=>{throw Error('must not reconnect wrong account');},closePage:async page=>closed.push(page)});
 await assert.rejects(mismatched.connect({...target,boat:'reef-cat-37-tidewyn-discovery'}),/mmk_account_mismatch/);
 assert.equal(mismatched.page,null);assert.equal(mismatched.client,null);assert.equal(closed.at(-1),wrong);
});

test('navigation retry rejects a replacement page signed into another MMK owner',async()=>{
 const closed=[];let replacements=0,reads=0;
 const stale={goto:async()=>{throw Error('Page.navigate timed out. Increase the protocolTimeout setting.');}};
 const wrong={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>{
  if(fn===mmkEntryState)return 'ready';
  if(fn.toString().includes('ReservationsAPI.getData'))return {serviceId:'other',isCharter:true};
  reads++;throw Error('wrong owner must not read reservations');
 }};
 const adapter=new MmkAdapter({openPage:async()=>stale,onReadFailure:async()=>{replacements++;return wrong;},closePage:async page=>closed.push(page)});
 await assert.rejects(adapter.read({...target,boat:'reef-cat-37-tidewyn-discovery'}),/mmk_account_mismatch/);
 assert.equal(replacements,1);assert.equal(reads,0);assert.deepEqual(closed,[stale,wrong]);
 assert.equal(adapter.page,null);assert.equal(adapter.client,null);
});

test('navigation timeout with failed tab cleanup stops before opening a replacement',async()=>{
 let replacements=0;
 const stale={goto:async()=>{throw Error('Page.navigate timed out. Increase the protocolTimeout setting.');}};
 const adapter=new MmkAdapter({openPage:async()=>stale,onReadFailure:async()=>{replacements++;throw Error('must not replace after failed cleanup');},closePage:async()=>{throw Error('tab_close_failed');}});
 await assert.rejects(adapter.connect({...target,boat:'reef-cat-37-tidewyn-discovery'}),/tab_close_failed/);
 assert.equal(replacements,0);assert.equal(adapter.page,null);assert.equal(adapter.client,null);
});

test('post-login editor navigation timeout retries only a fresh owner check, not another login',async()=>{
 let logins=0,replacements=0,ownerChecks=0,closed=[];
 const stale={goto:async()=>{if(logins)throw Error('Page.navigate timed out. Increase the protocolTimeout setting.');},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?'auth_required':{serviceId:'0000',isCharter:true}};
 const fresh={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>{
  if(fn===mmkEntryState)return 'ready';
  if(fn.toString().includes('ReservationsAPI.getData')){ownerChecks++;return {serviceId:'0000',isCharter:true};}
  return {data:[],itemsLeft:0};
 }};
 const adapter=new MmkAdapter({openPage:async()=>stale,recoverLogin:async()=>{logins++;},onReadFailure:async()=>{replacements++;return fresh;},closePage:async page=>closed.push(page)});
 const result=await adapter.read({...target,boat:'reef-cat-37-tidewyn-discovery'});
 assert.deepEqual(result.blocks,[]);assert.equal(logins,1);assert.equal(replacements,1);assert.equal(ownerChecks,1);
 await adapter.close();assert.deepEqual(closed,[stale,fresh]);
});

test('shutdown while retiring old MMK tab does not open another browser page',async()=>{
 let stopped=false,reconnects=0;
 const adapter=new MmkAdapter({closePage:async()=>{stopped=true;},onReadFailure:async()=>{reconnects++;},isCancelled:()=>stopped});
 adapter.page={};
 await assert.rejects(adapter.reconnect(),/phone_shutdown/);assert.equal(reconnects,0);assert.equal(adapter.page,null);
});

test('replacement Page whose account fails validation is still owned and closed',async()=>{
 const closed=[];
 const page=(account,read)=>({goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?'ready':fn.toString().includes('ReservationsAPI.getData')?account:read()});
 const old=page({serviceId:'0000',isCharter:true},async()=>{throw Error('timeout');});
 const fresh=page({serviceId:'wrong',isCharter:true},async()=>{throw Error('must not read wrong account');});
 const adapter=new MmkAdapter({openPage:async()=>old,closePage:async p=>closed.push(p),onReadFailure:async()=>fresh});
 await assert.rejects(adapter.read({...target,boat:'reef-cat-37-tidewyn-discovery'}),/mmk_account_mismatch/);
 assert.equal(adapter.page,fresh);assert.equal(adapter.client.page,fresh);
 await adapter.close();assert.deepEqual(closed,[old,fresh]);
});

// 2026-10-13, AD5: the program's create from 02-21 got HTTP 501 twice. MMK opens
// a new draft for 7 default nights; from 02-21 it ran into a record from 02-27 14:00.
test('the draft opens where its seven default nights are free, nearest to the gap (2026-10-13, AD5)',()=>{
 const rec=(a,b,from='14:00:00',to='10:00:00')=>({checkInDate:a+' '+from,checkOutDate:b+' '+to}),today='2026-10-13';
 assert.equal(MMK_DRAFT_NIGHTS,7);
 // The AD5 case: the night before the gap is free, so the draft opens there.
 assert.equal(draftStart({start:'2027-02-21',end:'2027-02-27'},[rec('2027-02-13','2027-02-20'),rec('2027-02-27','2027-03-20')],today),'2027-02-20');
 // Free from the first night: unchanged.
 assert.equal(draftStart({start:'2027-02-21',end:'2027-02-28'},[rec('2027-02-13','2027-02-20'),rec('2027-03-06','2027-03-20')],today),'2027-02-21');
 // A record returning at 10:00 on the first day does not collide; a whole-day one from 00:00 on the eighth day does.
 assert.equal(draftStart({start:'2027-02-21',end:'2027-02-23'},[rec('2027-02-14','2027-02-21')],today),'2027-02-21');
 assert.equal(draftStart({start:'2027-02-21',end:'2027-02-23'},[rec('2027-02-28','2027-03-05','00:00:00','00:00:00')],today),'2027-02-20');
 // Boxed in on both sides: the nearest free week, here after the later record.
 assert.equal(draftStart({start:'2027-02-21',end:'2027-02-23'},[rec('2027-02-14','2027-02-21'),rec('2027-02-28','2027-03-05','00:00:00','00:00:00')],today),'2027-03-05');
 // Never in the past, and nothing written when no free week is within 60 days.
 assert.notEqual(draftStart({start:'2026-10-14',end:'2026-10-15'},[rec('2026-10-16','2026-10-30')],today),'2026-10-13');
 assert.throws(()=>draftStart({start:'2027-02-21',end:'2027-02-23'},[rec('2026-11-01','2027-02-21'),rec('2027-02-23','2027-05-01')],today),
  e=>e.message==='mmk_no_free_draft_window'&&e.notSubmitted===true);
 // A record whose times cannot be read never counts as free.
 assert.throws(()=>draftStart({start:'2027-02-21',end:'2027-02-23'},[{checkInDate:null,checkOutDate:null}],today),/mmk_no_free_draft_window/);
});
test('submit opens the draft where prepare placed it, notes that day first, and saves the gap dates',async()=>{
 const x=submitSetup();const opened=[];
 x.adapter.client.create=async(yacht,start)=>{opened.push(start);return draft.id;};
 x.adapter.draft={gap:{start:'2027-01-01',end:'2027-01-09'},start:'2026-12-31'};
 const block=await x.run();
 assert.deepEqual(opened,['2026-12-31']);assert.deepEqual(x.evidence[0],{draft_start:'2026-12-31'});
 assert.equal(x.evidence.at(-1).draft_start,'2026-12-31');assert.deepEqual([block.start,block.end],['2027-01-01','2027-01-09']);
 // A placement made for another gap is not used.
 const y=submitSetup();const other=[];y.adapter.client.create=async(yacht,start)=>{other.push(start);return draft.id;};
 y.adapter.draft={gap:{start:'2027-02-01',end:'2027-02-03'},start:'2027-01-30'};
 await y.run();assert.deepEqual(other,['2027-01-01']);
});test('a new draft that changed before the save is left unsaved and the changed field names are noted (2026-10-13)',async()=>{
 const x=submitSetup();let reads=0;
 x.adapter.client.get=async()=>(++reads===1?draft:{...draft,remarks:'filled in later',crewNumber:{total:'4'}});
 await assert.rejects(x.run(),/mmk_initial_record_changed/);assert.equal(x.writes(),0);
 assert.deepEqual(x.evidence.at(-1).initial_changed_fields,['crewNumber','remarks']);
 assert.ok(!JSON.stringify(x.evidence).includes('filled in later'),'values are not kept');
});