import {randomUUID} from 'node:crypto';
import {dateRange} from '../parsers.mjs';
import {uncovered} from './planner.mjs';
import {verifiedBlocks,rememberedCancellations,rangeDays} from './release.mjs';
import {fleetHoldControl,retainedReleaseCauses,verifyFleetHoldPlan} from './fleet-hold-runtime.mjs';
import {bookingFingerprint,mmkTimes} from './mmk-client.mjs';

const overlaps=(a,b)=>a.start<b.end&&a.end>b.start;
const sameRange=(a,b)=>a.start===b.start&&a.end===b.end;
const sameBlock=(a,b)=>['id','start','end','type','boat','marker','fingerprint'].every(k=>a?.[k]===b?.[k]);
const keyOf=target=>'mmk:'+target.listing_id;
const terminal=new Set(['confirmed','observed_protected','reviewed_no_record','not_submitted','releasing','released']);
const unique=values=>[...new Set(values)].sort();
const fail=message=>{throw Error(message);};
const uniqueReceipt=(attempt,target,ledger)=>ledger.attempts.filter(a=>a.target===keyOf(target)&&
 (a.created?.id===attempt.created?.id||a.response?.draft_id===attempt.created?.id)).length===1;
function merge(ranges){
 const result=[];
 for(const range of ranges.map(r=>dateRange(r.start,r.end)).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))){
  const last=result.at(-1);
  if(last&&range.start<=last.end){if(range.end>last.end)last.end=range.end;}
  else result.push({...range});
 }
 return result;
}
function intersect(a,b){return overlaps(a,b)?{start:a.start>b.start?a.start:b.start,end:a.end<b.end?a.end:b.end}:null;}
function verifiedTarget(target,now){
 if(target.target!=='mmk'||target.fresh!==true||target.source_healthy===false||!Array.isArray(target.segments))fail('mmk_resize_source_unverified');
 for(const segment of target.segments){
  dateRange(segment.start,segment.end);
  if(!Array.isArray(segment.causes)||!segment.causes.length||segment.causes.some(c=>typeof c!=='string'||!c))fail('mmk_resize_source_unverified');
 }
 verifyFleetHoldPlan(target,now);
}
function releaseProof(target,now){
 const proof=target.release_proof;
 if(proof?.ready!==true||!Array.isArray(proof.orders)||!Number.isFinite(Date.parse(proof.checked_at))||Math.abs(now-Date.parse(proof.checked_at))>60000)fail('mmk_resize_release_unverified');
 const keys=new Set();
 for(const order of proof.orders){
  if(typeof order?.key!=='string'||!order.key||keys.has(order.key)||!['active','cancelled'].includes(order.state))fail('mmk_resize_release_unverified');
  keys.add(order.key);if(order.state==='active')try{dateRange(order.start,order.end);}catch{fail('mmk_resize_release_unverified');}
 }
 return proof;
}
function shrinkAllowed(attempt,target,removed,now){
 const proof=releaseProof(target,now),causes=retainedReleaseCauses(attempt);
 for(const order of proof.orders)if(order.state==='active'&&removed.some(range=>overlaps(order,range)))fail('mmk_resize_active_protection');
 for(const hold of fleetHoldControl(target)?.holds||[])if(hold.active&&removed.some(range=>overlaps(hold,range)))fail('mmk_resize_active_protection');
 for(const key of causes){
  const matches=proof.orders.filter(order=>order.key===key);
  if(matches.length!==1||matches[0].state!=='cancelled'&&removed.some(range=>overlaps(matches[0],range)))fail('mmk_resize_release_unverified');
 }
 return proof;
}
// Only the original, uniquely receipted customer-free protection is editable.
// A date match, our marker alone, or another historical receipt grants nothing.
function owned(attempt,target,ledger,model,blockOf){
 const marker='TidewynSync:'+attempt.id+' '+attempt.causes?.join(',');
 const block=blockOf(model);
 if(attempt.state!=='confirmed'||!attempt.created?.id||
  !uniqueReceipt(attempt,target,ledger)||
  attempt.response?.marker!==marker||attempt.created.marker!==marker||
  !sameRange(attempt,attempt.created)||!sameBlock(block,attempt.created)||
  model.yacht?.id!==target.listing_id||model.statusId!=='1'||model.freeEntry!==true||
  model.bookingOrigin!==marker||model.internalRemarks!==marker||model.finalPrice!==0||model.paidAmount!==0||
  !Array.isArray(model.payments)||model.payments.length||model.invoiceId||model.clientId!=='-1'||model.guestId!==null)
  fail('mmk_resize_ownership_unverified');
 retainedReleaseCauses(attempt);
 return block;
}
function accumulatedCauses(attempt,target,range){
 const causes=[...retainedReleaseCauses(attempt)];
 for(const segment of target.segments)if(overlaps(range,segment))causes.push(...segment.causes);
 for(const order of target.release_proof?.orders||[])if(order.state==='active'&&overlaps(range,order))causes.push(order.key);
 for(const hold of fleetHoldControl(target)?.holds||[])if(hold.active&&overlaps(range,hold))causes.push('manual-hold:'+hold.id);
 if(causes.some(c=>typeof c!=='string'||!c))fail('mmk_resize_source_unverified');
 return unique(causes);
}

// Undoing an extension (2026-10-13, AD5 XX-00001): a record of ours was
// extended for one more order; once every order it was extended for is
// cancelled it goes back to its dates before that extension, even when
// another order still needs a night inside the removed part. Those nights are
// closed again in the same run (an adjacent record of ours is extended, or the
// executor writes them), so at most this many needed nights are briefly open.
export const UNDO_REOPEN_NIGHTS=7;
function undoExtension(attempt,target,needed,proof,remembered){
 // The proposal is checked again while this undo is in flight ("submitting").
 const records=history(attempt).filter(e=>e.state==='confirmed'),last=records.at(-1);
 if(last?.mode!=='extend'||!sameBlock(last.new,attempt.created))return null;
 const prior=new Set([...attempt.causes,...records.slice(0,-1).flatMap(e=>e.release_causes)]);
 const added=last.release_causes.filter(c=>!prior.has(c));
 if(!added.length||added.some(c=>c.startsWith('manual-hold:')))return null;
 const cancelledKey=key=>{const m=proof.orders.filter(o=>o.key===key);return m.length===1?m[0].state==='cancelled':m.length===0&&remembered.has(key);};
 if(!added.every(cancelledKey))return null;
 const range={start:last.old.start,end:last.old.end};
 if(sameRange(range,attempt)||uncovered(range,[attempt]).length)return null;
 const removed=uncovered(attempt,[range]);
 // The record's other causes keep all their dates inside the restored range.
 for(const key of retainedReleaseCauses(attempt)){
  if(added.includes(key))continue;
  const m=proof.orders.filter(o=>o.key===key);
  if(m.length!==1||m[0].state==='active'&&removed.some(r=>overlaps(m[0],r)))return null;
 }
 const others=[...needed,...proof.orders.filter(o=>o.state==='active'),...(fleetHoldControl(target)?.holds||[]).filter(h=>h.active)];
 const reopened=merge(others.flatMap(r=>removed.map(x=>intersect(r,x))).filter(Boolean));
 if(rangeDays(reopened)>UNDO_REOPEN_NIGHTS)return null;
 return {range,reopened};
}

/** A proposal is a contiguous atomic date change. It never cancels/recreates,
 * consumes another block, crosses an unneeded gap or splits an existing ID. */
export function mmkResizeProposal(attempt,target,blocks,ledger,now=Date.now()){
 verifiedTarget(target,now);
 const needed=merge(target.segments),missing=uncovered(attempt,needed);
 let range,mode,reopened;
 if(missing.length){
  // Keep the pre-existing whole-record release semantics for untouched legacy
  // receipts. Edge shrinking belongs only to records this feature expanded.
  if(!history(attempt).some(entry=>entry.state==='confirmed'))return null;
  // An absent/stale proof must not turn a disappearance into a release.
  const proof=releaseProof(target,now);
  const protectedRanges=[...needed,...proof.orders.filter(o=>o.state==='active'),...(fleetHoldControl(target)?.holds||[]).filter(h=>h.active)];
  const retained=merge(protectedRanges.map(r=>intersect(r,attempt)).filter(Boolean));
  if(retained.length===0)return null; // Existing exact-ID full release owns this case.
  if(retained.length>1){
   // A hole in the middle is never split; an extension whose order was
   // cancelled may still be undone as a whole.
   const undo=undoExtension(attempt,target,needed,proof,rememberedCancellations(ledger));
   if(!undo)fail('mmk_resize_split_requires_review');
   ({range,reopened}=undo);mode='shrink';
  }else{
   range=retained[0];if(sameRange(range,attempt))return null;
   shrinkAllowed(attempt,target,uncovered(attempt,[range]),now);mode='shrink';
  }
 }else{
  const gaps=merge(needed.flatMap(s=>uncovered(s,blocks)));
  const left=gaps.find(g=>g.end===attempt.start),right=gaps.find(g=>g.start===attempt.end);
  if(!left&&!right)return null;
  range={start:left?.start||attempt.start,end:right?.end||attempt.end};mode='extend';
  if(uncovered(range,needed).length)fail('mmk_resize_outside_target');
 }
 const changed=mode==='extend'?uncovered(range,[attempt]):uncovered(attempt,[range]);
 if(blocks.some(b=>b.id!==attempt.created?.id&&changed.some(r=>overlaps(b,r))))fail('mmk_resize_other_record_overlap');
 for(const other of ledger.attempts.filter(a=>a!==attempt&&a.target===keyOf(target)&&!terminal.has(a.state))){
  try{dateRange(other.start,other.end);}catch{fail('mmk_resize_previous_write_uncertain');}
  if(changed.some(r=>overlaps(other,r)))fail('mmk_resize_previous_write_uncertain');
 }
 return {mode,...range,release_causes:accumulatedCauses(attempt,target,range),...(reopened?.length?{reopened}:{})};
}
function history(attempt){
 if(attempt.mmk_resize===undefined)return [];
 const record=attempt.mmk_resize;
 if(record?.version!==1||!Array.isArray(record.history))fail('mmk_resize_history_unverified');
 const ids=new Set();let pending=0;
 for(const entry of record.history){
  if(typeof entry?.id!=='string'||!entry.id||ids.has(entry.id)||!['submitting','confirmed','not_submitted'].includes(entry.state)||
   !['extend','shrink'].includes(entry.mode)||entry.old?.id!==attempt.created?.id||entry.new?.id!==attempt.created?.id||
   !Array.isArray(entry.before)||!Array.isArray(entry.release_causes)||!entry.release_causes.length||
   entry.release_causes.some(c=>typeof c!=='string'||!c)||new Set(entry.release_causes).size!==entry.release_causes.length)
   fail('mmk_resize_history_unverified');
  for(const block of [entry.old,entry.new]){
   dateRange(block.start,block.end);
   if(typeof block.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(block.fingerprint))fail('mmk_resize_history_unverified');
  }
  verifiedBlocks({complete:true,identity_verified:true,blocks:entry.before},'mmk_resize_history_unverified');
  if(sameRange(entry.old,entry.new)||entry.mode==='extend'&&uncovered(entry.old,[entry.new]).length||
   entry.mode==='shrink'&&uncovered(entry.new,[entry.old]).length||
   ['id','type','boat','marker'].some(k=>entry.old[k]!==entry.new[k]))fail('mmk_resize_history_unverified');
  ids.add(entry.id);if(entry.state==='submitting')pending++;
 }
 if(pending>1||pending===1&&record.history.at(-1).state!=='submitting')fail('mmk_resize_history_unverified');
 return record.history;
}
function othersUnchanged(blocks,entry){
 const others=blocks.filter(b=>b.id!==entry.old.id);
 return others.length===entry.before.length&&entry.before.every(b=>others.some(current=>sameBlock(b,current)));
}
function commit(attempt,entry){
 attempt.start=entry.new.start;attempt.end=entry.new.end;attempt.created={...entry.new};
 attempt.release_causes={version:1,causes:unique([...retainedReleaseCauses(attempt),...entry.release_causes])};
 entry.state='confirmed';entry.confirmed_at=new Date().toISOString();
 delete attempt.mmk_resize.review;
}
async function snapshot(adapter,target){return verifiedBlocks(await adapter.read(target),'mmk_resize_calendar_unverified');}
function sameProposal(a,b){return a&&b&&a.mode===b.mode&&sameRange(a,b);}
function mayResize(attempt,target,now){
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 if(attempt.end<=today)return false;
 const needed=merge(target.segments);
 if(uncovered(attempt,needed).length)return history(attempt).some(entry=>entry.state==='confirmed');
 return needed.some(range=>range.start<=attempt.start&&range.end>=attempt.end&&!sameRange(range,attempt));
}
const reviewableShrink=new Set(['mmk_resize_release_unverified','mmk_resize_split_requires_review','mmk_resize_active_protection','release_causes_unverified']);

/** Runs before the normal executor read. Every uncertain resize blocks this
 * yacht until a complete exact new readback proves it; old state is not retried.
 * guard must return the freshly verified current target for any new mutation. */
export async function recoverMmkResizes({adapter,target,ledger,guard,save,blockOf,now=Date.now,allowResize=true}){
 const candidates=ledger.attempts.filter(a=>a.target===keyOf(target)&&a.created?.id);
 for(const attempt of candidates){
  const records=history(attempt),pending=records.find(r=>r.state==='submitting');
  if(!pending)continue;
  if(attempt.state!=='confirmed'||!sameBlock(attempt.created,pending.old)||
   !uniqueReceipt(attempt,target,ledger))fail('mmk_resize_ownership_unverified');
  const blocks=await snapshot(adapter,target),actual=await adapter.client.get(attempt.created.id);
  if(!sameBlock(blockOf(actual),pending.new)||!othersUnchanged(blocks,pending)||
   !blocks.some(b=>sameBlock(b,pending.new)))fail('mmk_resize_uncertain');
  // Validate the same customer-free ownership constraints using the proposed
  // receipt. This does not adopt a merely matching date or a changed model.
  owned({...attempt,start:pending.new.start,end:pending.new.end,created:pending.new},target,
   {...ledger,attempts:ledger.attempts.map(a=>a===attempt?{...attempt,created:pending.new}:a)},actual,blockOf);
  commit(attempt,pending);await save(ledger);
 }
 // Close-only runs finish in-flight receipts above but start no new date change:
 // a shrink is a release, and an extend would need the fully fresh proposal.
 if(!allowResize)return;
 let blocks;
 // After a shrink, one more pass: a night an undone extension reopened may
 // extend a record of ours listed before it in the ledger.
 for(let pass=0,shrunk=true;pass<2&&shrunk;pass++){shrunk=false;
 for(const attempt of candidates.filter(a=>a.state==='confirmed')){
  if(!mayResize(attempt,target,now()))continue;
  const latest=await guard();
  if(!latest||latest.target!==target.target||latest.listing_id!==target.listing_id||latest.boat!==target.boat)fail('mmk_resize_latest_plan_required');
  blocks??=await snapshot(adapter,latest);
  let proposal;
  try{proposal=mmkResizeProposal(attempt,latest,blocks,ledger,now());}
  catch(error){
   if(!reviewableShrink.has(error.message)||!uncovered(attempt,latest.segments).length)throw error;
   attempt.mmk_resize.review={reason:error.message,checked_at:new Date(now()).toISOString()};await save(ledger);continue;
  }
  if(!proposal)continue;
  // A record boarding before 10:00 on the new last day would overlap the
  // 10:00 return and MMK would refuse it on every run; leave that night to the
  // executor, which reports it (mmk_turnover_conflict, 2026-10-10).
  if(proposal.mode==='extend'&&adapter.earlyStarts?.has(proposal.end))continue;
  const model=await adapter.client.get(attempt.created.id);owned(attempt,latest,ledger,model,blockOf);
  if(!blocks.some(b=>sameBlock(b,attempt.created)))fail('mmk_resize_ownership_unverified');
  if(!await adapter.client.available({id:model.id,yachtId:latest.listing_id,start:proposal.start,end:proposal.end}))fail('mmk_resize_dates_not_available');
  const savedModel={...model,...mmkTimes(proposal.start,proposal.end)};
  const expected=blockOf(savedModel);
  if(!expected||expected.fingerprint!==bookingFingerprint(savedModel))fail('mmk_resize_receipt_invalid');
  const verified=await guard();
  if(!verified||!sameProposal(proposal,mmkResizeProposal(attempt,verified,blocks,ledger,now())))fail('mmk_resize_source_changed');
  const entry={id:randomUUID(),state:'submitting',mode:proposal.mode,old:{...attempt.created},new:expected,
   before:blocks.filter(b=>b.id!==model.id).map(b=>({...b})),
   release_causes:accumulatedCauses(attempt,verified,proposal),started_at:new Date(now()).toISOString(),
   ...(proposal.mode==='shrink'?{release_proof:structuredClone(verified.release_proof)}:{})};
  attempt.mmk_resize??={version:1,history:[]};attempt.mmk_resize.history.push(entry);
  await save(ledger);
  // Everything before client.save is read-only. Persist an explicit no-write
  // result if the final guard or identity read fails; never infer this after it.
  let writeModel;
  try{
   const freshBlocks=await snapshot(adapter,verified);
   if(!othersUnchanged(freshBlocks,entry)||!freshBlocks.some(b=>sameBlock(b,entry.old)))fail('mmk_resize_calendar_changed');
   const current=await adapter.client.get(model.id);owned(attempt,verified,ledger,current,blockOf);
   const final=await guard();
   if(!final||!sameProposal(proposal,mmkResizeProposal(attempt,final,freshBlocks,ledger,now())))fail('mmk_resize_source_changed');
   if(accumulatedCauses(attempt,final,proposal).some(c=>!entry.release_causes.includes(c)))fail('mmk_resize_source_changed');
   writeModel={...current,checkInDate:savedModel.checkInDate,checkOutDate:savedModel.checkOutDate};
  }catch(error){entry.state='not_submitted';entry.reason=error.message;await save(ledger);throw error;}
  const result=await adapter.client.save(writeModel);
  if(!sameBlock(blockOf(result),expected))fail('mmk_resize_readback_failed');
  owned({...attempt,start:expected.start,end:expected.end,created:expected},verified,
   {...ledger,attempts:ledger.attempts.map(a=>a===attempt?{...attempt,created:expected}:a)},result,blockOf);
  blocks=await snapshot(adapter,verified);
  if(!blocks.some(b=>sameBlock(b,expected))||!othersUnchanged(blocks,entry))fail('mmk_resize_readback_failed');
  commit(attempt,entry);await save(ledger);
  if(entry.mode==='shrink')shrunk=true;
 }
 }
}
