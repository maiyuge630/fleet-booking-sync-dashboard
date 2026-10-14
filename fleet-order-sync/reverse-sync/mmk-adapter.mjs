import {MMK_FLEET} from './mmk-plan.mjs';
import {MmkClient,reservationModel,initialOptionEvidence,matchesInitialOption,bookingFingerprint,MMK_CHECK_IN,MMK_CHECK_OUT} from './mmk-client.mjs';
import {uncovered} from './planner.mjs';
import {dateRange} from '../parsers.mjs';
import {recoverMmkResizes} from './mmk-resize.mjs';
import {beforeRequest} from './not-submitted.mjs';
const at=time=>value=>typeof value==='string'&&new RegExp('^\\d{4}-\\d{2}-\\d{2} '+time+'$').test(value);
const midnight=at('00:00:00'),boarding=at(MMK_CHECK_IN),returning=at(MMK_CHECK_OUT);
const programMarker=value=>typeof value==='string'&&value.startsWith('TidewynSync:');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const WHOLE_DAY_WRITES_BEFORE='2026-10-09T00:00:00.000Z';
// These records protect external bookings only. A later real payment or invoice
// must never be silently adopted as ours, or canceled by a release operation.
const noPaymentsOrInvoice=model=>model.paidAmount===0&&
  (model.payments==null||Array.isArray(model.payments)&&model.payments.length===0)&&!model.invoiceId;
const noFinancialActivity=model=>model.finalPrice===0&&noPaymentsOrInvoice(model);
const managedReservation=(model,block,marker,gap)=>block?.marker===marker&&block.type==='1'&&
  block.start===gap.start&&block.end===gap.end&&model.internalRemarks===marker&&
  model.freeEntry===true&&noFinancialActivity(model);
const navigationTimedOut=error=>typeof error?.message==='string'&&
  (/^Page\.navigate timed out\./.test(error.message)||/^Navigation timeout of \d+ ms exceeded$/.test(error.message));
// A block [start, end) closes the nights start..end-1 (AGENTS.md 7.7). Program
// records run 14:00 to 10:00 since the user decision of 2026-10-09; the 33 the
// business side re-timed on 2026-10-05 look the same. A whole-day (midnight)
// record blocks the same nights. Any other partial-day record, including a
// customer's charter, stays unclassified and is reviewed in read().
export function mmkBlock(model){
 if(typeof model.checkInDate!=='string'||typeof model.checkOutDate!=='string'||model.checkInDate.slice(0,10)>=model.checkOutDate.slice(0,10))return null;
 if(!['1','4','6','10','11'].includes(model.statusId))return null;
 const wholeDays=midnight(model.checkInDate)&&midnight(model.checkOutDate);
 const nights=model.statusId==='1'&&programMarker(model.bookingOrigin)&&boarding(model.checkInDate)&&returning(model.checkOutDate);
 if(!wholeDays&&!nights)return null;
 return {id:model.id,start:model.checkInDate.slice(0,10),end:model.checkOutDate.slice(0,10),
   type:model.statusId,boat:model.yacht.id,marker:model.bookingOrigin||'',fingerprint:bookingFingerprint(model)};
}
// User decision 2026-10-09: a program record the business side re-timed to
// 14:00/10:00 stays ours. Adopt its new range only when the record is exactly
// our receipt apart from those two times, still free of customers and money,
// and inside the old range. Anything else is left for review, never adopted.
export function retimedProgramRecord(attempt,model,receipts){
 const old=attempt.created,block=mmkBlock(model);
 if(!old?.id||!block||same(block,old)||receipts!==1||attempt.state!=='confirmed')return null;
 if(!boarding(model.checkInDate)||!returning(model.checkOutDate)||model.id!==old.id||model.yacht?.id!==old.boat||
    block.type!=='1'||block.marker!==old.marker||model.internalRemarks!==old.marker||model.freeEntry!==true||
    !noFinancialActivity(model)||model.clientId!=='-1'||model.guestId!=null||block.start<old.start||block.end>old.end)return null;
 const original={...model,checkInDate:old.start+' 00:00:00',checkOutDate:old.end+' 00:00:00'};
 return bookingFingerprint(original)===old.fingerprint?block:null;
}
// A native Option or partial-day Reservation does not belong to this sync.
// It must not stop unrelated dates for the entire yacht. Exclude it only after
// a complete read proves that its exact times are outside every current target
// AND every existing managed block (including blocks awaiting release). The
// excluded record contributes no coverage and never acquires deletion rights.
export function unrelatedManualRecord(model,target,blocks){
 if(!['1','2'].includes(model.statusId)||model.yacht?.id!==target.listing_id||
    !Array.isArray(target.segments)||!Array.isArray(blocks)||
    [model.bookingOrigin,model.internalRemarks].some(v=>typeof v==='string'&&v.startsWith('TidewynSync:')))return false;
 // Reservation is a new exclusion: absent ownership fields are insufficient
 // evidence that it is manual. Preserve the existing Option contract.
 if(model.statusId==='1'&&[model.bookingOrigin,model.internalRemarks].some(v=>typeof v!=='string'))return false;
 const valid=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return false;
  const time=new Date(value.replace(' ','T')+'Z');
  return Number.isFinite(time.getTime())&&time.toISOString().slice(0,19).replace('T',' ')===value;
 };
 if(!valid(model.checkInDate)||!valid(model.checkOutDate)||model.checkInDate>=model.checkOutDate)return false;
 const scope=[...target.segments,...blocks.filter(b=>b.marker?.startsWith('TidewynSync:'))];
 try{for(const s of scope)dateRange(s.start,s.end);}catch{return false;}
 // Ranges are nights: a charter returning at 10:00 on a turnover day does not
 // overlap one boarding at 14:00.
 return !scope.some(s=>model.checkInDate<s.end+' '+MMK_CHECK_OUT&&model.checkOutDate>s.start+' '+MMK_CHECK_IN);
}
export function unrelatedManualOption(model,target,blocks){
 return model.statusId==='2'&&unrelatedManualRecord(model,target,blocks);
}
// MMK opens a new draft from the given day for its default length, 7 nights
// 14:00..10:00 (seen in the 2027-08-24..08-31 test). A draft that runs into
// another record is refused with HTTP 501, which leaves the write uncertain:
// AD5 2026-10-13 twice (from 02-21 into a record starting 02-27), most likely
// AD2 on 2026-09-24 too. The draft is therefore opened where its default
// nights are free, the nearest such day to the gap, and saved with the gap's
// dates as before. No free day within 60 days: nothing is written.
export const MMK_DRAFT_NIGHTS=7;
// Live test on AD2 2027-09 (2026-10-13, user authorized): a draft placed on
// 09-01 was saved as 09-05..09-08 and both test records were cancelled.
export const MMK_DRAFT_PLACEMENT=true;
const addDays=(day,days)=>new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
export function draftStart(gap,occupied,today){
 const free=start=>{
  const from=start+' '+MMK_CHECK_IN,to=addDays(start,MMK_DRAFT_NIGHTS)+' '+MMK_CHECK_OUT;
  return occupied.every(r=>typeof r.checkInDate==='string'&&typeof r.checkOutDate==='string'&&!(r.checkInDate<to&&r.checkOutDate>from));
 };
 if(free(gap.start))return gap.start;
 for(let days=1;days<=60;days++)for(const start of [addDays(gap.start,-days),addDays(gap.start,days)])if(start>today&&free(start))return start;
 throw Object.assign(Error('mmk_no_free_draft_window'),{notSubmitted:true});
}
export class MmkAdapter {
 constructor({openPage,closePage,onReadFailure,recoverLogin,isCancelled=()=>false}){Object.assign(this,{openPage,closePage,onReadFailure,recoverLogin,isCancelled});}
 async reconnect(){
  if(this.isCancelled())throw Error('phone_shutdown');
  // Retire the old owned tab before reconnecting. The phone's page manager
  // queues a failed close and retries it against its exact target on new CDP.
  const previous=this.page;this.page=null;
  if(previous)await this.closePage(previous);
  if(this.isCancelled())throw Error('phone_shutdown');
  this.page=await this.onReadFailure();
  if(this.isCancelled())throw Error('phone_shutdown');
  return this.page;
 }
 async connect(target){
  if(this.isCancelled())throw Error('phone_shutdown');
  if(!MMK_FLEET.some(b=>b.boat===target.boat&&b.listing_id===target.listing_id))throw Error('mapping_unknown');
  if(!this.page){
   const openVerified=async create=>{
    this.page=await create();
    this.client=new MmkClient(this.page,this.onReadFailure?()=>this.reconnect():null,this.recoverLogin,this.isCancelled);
    try{await this.client.open();}
    catch(error){await this.close();throw error;}
   };
   try{await openVerified(this.openPage);}
   catch(error){
    // A timed-out navigation has not read or written a booking. Retire its
    // exact tab and give a fresh page one chance; open() verifies the owner
    // again before any reservation read or mutation.
    if(!navigationTimedOut(error)||!this.onReadFailure||this.isCancelled())throw error;
    await openVerified(this.onReadFailure);
   }
  }
 }
 async recover(target,ledger,guard,save,{closeOnly=false}={}){
  await this.connect(target);
  for(const a of ledger.attempts.filter(a=>a.target==='mmk:'+target.listing_id&&!['confirmed','releasing','released','observed_protected','reviewed_no_record','not_submitted'].includes(a.state)&&a.response?.draft_id)){
   let model=await this.client.get(a.response.draft_id);
   if(model.yacht.id!==target.listing_id)throw Error('mmk_recovery_identity_mismatch');
   // An acknowledged rejected Option may already have been canceled. It is
   // safe to retire that receipt; do not reactivate it or leave it blocking all
   // later reconciliation. Unknown/manual cancellations still require review.
   if(model.statusId==='5'&&a.response.cancelled===true&&!a.created){
    a.state='not_submitted';a.reason='mmk_rejected_draft_cancelled';await save(ledger);continue;
   }
   const marker=a.response.marker;
   if(!marker)throw Error('mmk_draft_requires_review');
   let block=mmkBlock(model);
   if(model.statusId==='2'&&matchesInitialOption(model,a.response)&&!uncovered(a,target.segments).length){
    if(!noPaymentsOrInvoice(model))throw Error('mmk_partial_write_requires_review');
    await guard();
    // A manual booking can arrive while the phone is stopped. Recovering an
    // Option needs the same current availability check as a new Reservation.
    if(!await this.client.available({id:model.id,yachtId:target.listing_id,start:a.start,end:a.end}))throw Error('mmk_dates_not_available');
    const current=await this.client.get(model.id);
    if(!matchesInitialOption(current,a.response))throw Error('mmk_partial_write_requires_review');
    await guard();model=await this.client.save(reservationModel(current,{start:a.start,end:a.end,marker}));block=mmkBlock(model);
   }
   if(managedReservation(model,block,marker,a)&&
      (!a.created||a.created.fingerprint===block.fingerprint)){a.created=block;a.state='pending_readback';await save(ledger);}
   else throw Error('mmk_partial_write_requires_review');
  }
  await this.adoptRetimed(target,ledger,save);
  await recoverMmkResizes({adapter:this,target,ledger,guard,save,blockOf:mmkBlock,allowResize:!closeOnly});
 }
 // Ledger only: no platform request beyond reads. Only whole-day writes (all
 // made before MMK sync stalled on 2026-10-05) can have been re-timed. An
 // attempt with a resize in flight is left to recoverMmkResizes.
 async adoptRetimed(target,ledger,save,now=Date.now()){
  const key='mmk:'+target.listing_id,today=new Date(now+8*3600000).toISOString().slice(0,10);
  const owned=ledger.attempts.filter(a=>a.target===key&&a.state==='confirmed'&&a.created?.id&&a.end>today&&!a.mmk_nights&&
    !(Date.parse(a.submitted_at)>=Date.parse(WHOLE_DAY_WRITES_BEFORE))&&
    !a.mmk_resize?.history?.some?.(entry=>entry?.state==='submitting'));
  if(!owned.length)return;
  const models=await this.client.getMany(owned.map(a=>a.created.id));
  for(const [i,attempt] of owned.entries()){
   const receipts=ledger.attempts.filter(a=>a.target===key&&(a.created?.id===attempt.created.id||a.response?.draft_id===attempt.created.id)).length;
   const block=retimedProgramRecord(attempt,models[i],receipts);
   if(!block)continue;
   attempt.mmk_nights={version:1,adopted_at:new Date(now).toISOString(),old:{start:attempt.start,end:attempt.end,created:{...attempt.created}}};
   attempt.start=block.start;attempt.end=block.end;attempt.created=block;
   await save(ledger);
  }
 }
 async read(target){
  await this.connect(target);
  this.target=target;const list=await this.client.list(),blocks=[],unclassified=[],earlyStarts=new Set(),occupied=[];
  const ids=list.filter(item=>!['Canceled','Offer','Option expired','Credit','Custom'].includes(item.status)).map(item=>item.id);
  for(const model of await this.client.getMany(ids)){
   if(model.yacht.id!==target.listing_id)continue;
   // Every record still holding this yacht, ours or not, for draftStart.
   occupied.push({checkInDate:model.checkInDate,checkOutDate:model.checkOutDate});
   if(typeof model.checkInDate==='string'&&model.checkInDate.slice(11)<MMK_CHECK_OUT)earlyStarts.add(model.checkInDate.slice(0,10));
   const block=mmkBlock(model);
   if(block)blocks.push(block);else unclassified.push(model);
  }
  // Unknown states and relevant partial-day/manual records still fail closed.
  // Excluded native records never contribute coverage or gain deletion rights.
  for(const model of unclassified)if(!unrelatedManualRecord(model,target,blocks))throw Error('mmk_manual_or_partial_day_requires_review');
  this.before=blocks;this.earlyStarts=earlyStarts;this.occupied=occupied;return {identity_verified:true,complete:true,blocks};
 }
 /** A record boarding before 10:00 (e.g. a whole-day one from 00:00) on the
  * day a gap returns overlaps our 10:00 return, and MMK refuses the whole
  * write (found in review 2026-10-10). The night before it cannot be booked
  * either: any stay over it overlaps that record. That night is reported, the
  * rest written; no draft is created for a write MMK would refuse. */
 writableGap(gap){
  if(!this.earlyStarts?.has(gap.end))return {write:[gap],rest:[]};
  const last=new Date(Date.parse(gap.end+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  return {write:last>gap.start?[{start:gap.start,end:last}]:[],rest:[{start:last,end:gap.end,error:'mmk_turnover_conflict'}]};
 }
 async prepare(target,gap){
  if(target.listing_id!==this.target.listing_id)throw Error('wrong_listing');
  const previous=JSON.stringify(this.before),current=await this.read(target);
  if(JSON.stringify(current.blocks)!==previous||current.blocks.some(b=>b.start<gap.end&&b.end>gap.start))throw Error('mmk_calendar_changed');
  this.draft=MMK_DRAFT_PLACEMENT?{gap:{...gap},start:draftStart(gap,this.occupied,new Date(Date.now()+8*3600000).toISOString().slice(0,10))}:null;
 }
 async submit(target,gap,evidence,attempt){
  if(!attempt?.id)throw Error('mmk_write_intent_required');
  // Where the draft opens (draftStart); prepare() chose it from a full read.
  const draftAt=this.draft?.gap?.start===gap.start&&this.draft.gap.end===gap.end?this.draft.start:gap.start;
  await attempt.guard?.({beforeFirstWrite:true});
  // Noted before the request, so a review after an uncertain create knows where to look.
  await evidence({draft_start:draftAt});
  const id=await this.client.create(target.listing_id,draftAt);
  await evidence({draft_id:id,draft_start:draftAt});
  const original=await this.client.get(id);
  if(original.yacht.id!==target.listing_id||original.statusId!=='2')throw Error('mmk_initial_record_mismatch');
  // The freshly created Option may already have been changed by a person or
  // another integration before this first read. Default quoted prices may be
  // replaced by our zero-price protection, but actual money/invoices may not.
  // Check before both the Reservation save and the rejected-draft cancellation.
  if(!noPaymentsOrInvoice(original))throw Error('mmk_partial_write_requires_review');
  const marker='TidewynSync:'+attempt.id+' '+attempt.causes.join(',');
  const initial=initialOptionEvidence(original);
  await evidence({draft_id:id,draft_start:draftAt,...initial,marker});
  const available=await this.client.available({id,yachtId:target.listing_id,...gap});
  if(!available){
   const current=await this.client.get(id);
   if(matchesInitialOption(current,initial)){
    // Rejecting an unavailable interval still performs a platform mutation.
    // Recheck after both asynchronous reads; shutdown/stale evidence must not
    // bypass the same final guard used by successful Reservation writes.
    await attempt.guard?.();
    const cancelled=await this.client.save({...current,statusId:'5'});await evidence({draft_id:id,draft_start:draftAt,...initial,marker,cancelled:cancelled.statusId==='5'});
   }
   throw Error('mmk_dates_not_available');
  }
  const current=await this.client.get(id);
  if(!matchesInitialOption(current,initial)){
   // Seen once on 2026-10-13 (live test): MMK went on filling in a new draft
   // beyond the known defaults. Note which fields changed (names only) to learn them.
   const changed=Object.keys({...original,...current}).filter(k=>JSON.stringify(original[k])!==JSON.stringify(current[k])).sort();
   await evidence({draft_id:id,draft_start:draftAt,...initial,marker,initial_changed_fields:changed});
   throw Error('mmk_initial_record_changed');
  }
  // Creating the temporary Option and verifying availability may take long
  // enough for the source plan or executor budget to change.
  await attempt.guard?.();
  const saved=await this.client.save(reservationModel(current,{...gap,marker}));
  const block=mmkBlock(saved);
  if(!managedReservation(saved,block,marker,gap))throw Error('mmk_reservation_readback_failed');
  return block;
 }
 async remove(target,owned,{guard}={}){
  const current=await beforeRequest(async()=>{
   const current=await this.client.get(owned.id);
   if(current.yacht.id!==target.listing_id||current.statusId!=='1'||!current.bookingOrigin?.startsWith('TidewynSync:')||!noFinancialActivity(current)||bookingFingerprint(current)!==owned.fingerprint)throw Error('mmk_owned_record_changed');
   return current;
  });
  await guard?.();
  const saved=await this.client.save({...current,statusId:'5'});
  if(saved.statusId!=='5')throw Error('mmk_cancel_readback_failed');
 }
 async close(){
  // Cleanup can fail after a target is already detached. Do not let that stale
  // client bypass open/account verification for every later yacht in the run.
  const page=this.page;this.page=null;this.client=null;
  if(page)await this.closePage(page);
 }
}

