import {uncovered} from './planner.mjs';
import {dateRange} from '../parsers.mjs';
import {sameBoataroundControl,boataroundReleaseCauses,isBoataroundManaged,permitsBoataroundReuse,boataroundCoverageContains} from './ba-managed.mjs';
import {fleetHoldControl,sameFleetHoldControl,retainedReleaseCauses,isFleetHoldIntent} from './fleet-hold-runtime.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const overlap=(a,b)=>a.start<b.end&&a.end>b.start;
// Click&Boat app records show no platform ID; their ID is their exact content
// (clickandboat-app-adapter.mjs). The same content may belong to a new write
// only after every earlier record with it was deleted or had vanished.
export const permitsContentIdReuse=(id,previous)=>typeof id==='string'&&id.startsWith('cbapp:')&&previous.every(a=>a.state==='released'||a.state==='record_missing');
// User instruction (2026-09-29): records the owner or colleagues made by hand
// must never be deleted. A content-identified record of ours that is missing
// from a complete read is given up at once, so an identical record appearing
// later (for example re-created by hand) is never taken for ours. Only records
// whose last night is tomorrow or later are checked: the app lists future
// periods only.
export function vanishedContentRecords(ledger,key,blocks,now){
  const tomorrow=new Date(now+8*3600000+86400000).toISOString().slice(0,10);
  return ledger.attempts.filter(a=>a.target===key&&a.state==='confirmed'&&String(a.created?.id).startsWith('cbapp:')&&a.created.end>tomorrow&&!blocks.some(b=>same(b,a.created)));
}
// The app once left one row out of a read that looked complete (AD1, 2026-10-13:
// "2-07 to 2-11" was still on the website). The executor therefore reads again
// from a fresh app first; `among` limits this to records missing from both reads.
export function forfeitVanishedContentRecords(ledger,key,blocks,now,{among=null}={}){
  let changed=false;
  for(const a of vanishedContentRecords(ledger,key,blocks,now))if(!among||among.has(a.id)){
    a.state='record_missing';a.missing_at=new Date(now).toISOString();changed=true;
  }
  return changed;
}
export function verifiedBlocks(observation,error='target_unverified') {
  if(observation?.complete!==true||observation?.identity_verified!==true||!Array.isArray(observation.blocks))throw Error(error);
  const ids=new Set();
  for(const b of observation.blocks) {
    if(typeof b?.id!=='string'||!b.id||ids.has(b.id))throw Error(error);
    try {dateRange(b.start,b.end);}catch {throw Error(error);}
    ids.add(b.id);
  }
  return observation.blocks;
}
// closeOnly also accepts a close_ready plan. Release paths never pass it, so
// opening a date keeps requiring every source to be fresh.
export function currentTarget(plan,target,now,{closeOnly=false}={}) {
  if(!Number.isFinite(Date.parse(plan?.generated_at))||Math.abs(now-Date.parse(plan.generated_at))>60000)throw Error('plan_clock_invalid');
  const matches=plan.targets?.filter(t=>t.target===target.target&&t.boat===target.boat);
  const usable=matches?.length===1&&(matches[0].fresh===true||closeOnly&&matches[0].close_ready===true);
  if(!usable||matches[0].listing_id!==target.listing_id||!same(matches[0].segments,target.segments)||!sameBoataroundControl(matches[0],target)||!sameFleetHoldControl(matches[0],target))throw Error('source_changed_or_stale');
  return matches[0];
}
/** Keeps every cancellation a fully fresh release proof shows (2026-10-10):
 * a cancelled order later drops out of the source data, and its old records
 * could then never be released. Only explicit, fresh "cancelled" states are
 * kept, for 400 days; an order that is listed again wins over this memory. */
export function rememberCancellations(ledger,target,now){
  const proof=target?.release_proof;
  if(proof?.ready!==true||target.fresh!==true||!Array.isArray(proof.orders)||!Number.isFinite(Date.parse(proof.checked_at))||Math.abs(now-Date.parse(proof.checked_at))>60000)return;
  const seen=ledger.cancelled_orders&&typeof ledger.cancelled_orders==='object'?ledger.cancelled_orders:(ledger.cancelled_orders={});
  for(const o of proof.orders)if(o?.state==='cancelled'&&typeof o.key==='string'&&o.key&&!seen[o.key])seen[o.key]={seen_at:new Date(now).toISOString()};
  for(const [k,v] of Object.entries(seen))if(!(Date.parse(v?.seen_at)>now-400*86400000))delete seen[k];
}
export const rememberedCancellations=ledger=>new Set(Object.keys(ledger?.cancelled_orders&&typeof ledger.cancelled_orders==='object'?ledger.cancelled_orders:{}));
/** Days in a list of [start, end) ranges. */
export const rangeDays=ranges=>ranges.reduce((n,r)=>n+Math.round((Date.parse(r.end+'T00:00:00Z')-Date.parse(r.start+'T00:00:00Z'))/86400000),0);
/** Required dates (today or later) that only this owned record closes. */
export function onlyClosedBy(attempt,segments,blocks,today){
  const others=blocks.filter(b=>b.id!==attempt.created?.id);
  return segments.flatMap(s=>{const open=uncovered(s,blocks);return uncovered(s,others).flatMap(r=>uncovered(r,open));})
    .map(r=>({start:r.start<today?today:r.start,end:r.end})).filter(r=>r.start<r.end);
}
export function releaseAllowed(attempt,target,now,{independentBlocks=[],remembered=null,reclose=null}={}) {
  const proof=target.release_proof;
  // A replace (SamBoat/Click&Boat, 2026-10-10) closes these exact days again
  // in the same run, right after the delete.
  const reclosed=range=>Array.isArray(reclose)&&reclose.some(x=>x.start<=range.start&&x.end>=range.end);
  const independentlyProtected=range=>{
    if(!overlap(range,attempt))return true;
    const intersection={start:range.start>attempt.start?range.start:attempt.start,end:range.end<attempt.end?range.end:attempt.end};
    return uncovered(intersection,independentBlocks.filter(b=>b.id!==attempt.created?.id)).every(reclosed);
  };
  let causes;
  try{
    if(fleetHoldControl(target)?.holds.some(h=>h.active&&!independentlyProtected(h)))return false;
    causes=target.target==='boataround'?boataroundReleaseCauses(attempt,target):retainedReleaseCauses(attempt);
  }catch{return false;}
  if(proof?.ready!==true||target.fresh!==true||!Array.isArray(proof.orders)||!attempt.created?.id||
    attempt.created.start!==attempt.start||attempt.created.end!==attempt.end||!Array.isArray(causes)||!causes.length)return false;
  if(causes.some(key=>typeof key!=='string'||!key)||new Set(causes).size!==causes.length)return false;
  try {dateRange(attempt.start,attempt.end);}catch{return false;}
  if(!Number.isFinite(Date.parse(proof.checked_at))||Math.abs(now-Date.parse(proof.checked_at))>60000)return false;
  // A current obligation remains closed either by this record or by separately
  // verified blocks. Missing evidence is never replaced by mere coverage.
  for(const order of proof.orders)if(order?.state==='active'){
    try {dateRange(order.start,order.end);}catch{return false;}
    if(!independentlyProtected(order))return false;
  }
  return causes.every(key=>{
    const matches=proof.orders.filter(o=>o?.key===key);
    // An order an earlier fresh proof showed cancelled stays cancelled after
    // the source stops listing it (2026-10-10). A disappearance alone never counts.
    if(matches.length===0&&remembered?.has?.(key))return true;
    if(matches.length!==1)return false;
    const o=matches[0];
    if(o.state==='cancelled')return true;
    if(o.state!=='active')return false;
    try {dateRange(o.start,o.end);}catch{return false;}
    // Preserve legacy original-order semantics. Only a newly recorded global
    // hold intent or a subsequently tracked reason uses independent coverage;
    // so does a replace, which closes the order's remaining day again at once.
    if(overlap(o,attempt)&&attempt.causes.includes(key)&&!isFleetHoldIntent(attempt)&&!(Array.isArray(reclose)&&reclose.length))return false;
    return independentlyProtected(o);
  });
}
export async function reconcileReleasedAttempts({ledger,key,target,blocks,coverage,now,save}){
  // As in the executor: only still-listed records next to this one must be
  // unchanged (past records drop out of the lists; owners edit other dates).
  const listedFrom=new Date(now()+8*3600000).toISOString().slice(0,10);
  for(const a of ledger.attempts.filter(a=>a.target===key&&a.state==='releasing')) {
    if(target.target==='boataround'&&(!isBoataroundManaged(a)||!boataroundCoverageContains(coverage,a)))continue;
    const nearby=(a.release_before||[]).filter(b=>b.end>listedFrom&&b.start<=a.end&&b.end>=a.start);
    if(!blocks.some(b=>b.id===a.created.id)&&nearby.every(b=>blocks.some(c=>same(b,c)))){
      a.state='released';a.released_at=new Date(now()).toISOString();await save(ledger);
    }
  }
}
/** Only delete a stable, exact owned ID. An uncertain DELETE is never retried.
 * Partial ranges stay protected unless independent blocks cover retained dates.
 */
export async function releaseOwned({ledger,key,target,adapter,plan,save,now,blocks,coverage,deadline=Infinity,budgetExpired=()=>now()>deadline,isCancelled=()=>false,remembered=null,onReclose=()=>{}}) {
  verifiedBlocks({complete:true,identity_verified:true,blocks},'release_calendar_unverified');
  await reconcileReleasedAttempts({ledger,key,target,blocks,coverage,now,save});
  const today=new Date(now()+8*3600000).toISOString().slice(0,10);
  // Replace (2026-10-10): an order moved onto the last day of an old one left
  // a whole SamBoat/Click&Boat record closing days no order needs. Platforms
  // whose adapter allows it may delete such a record when at most replaceDays
  // of it are still needed; the executor closes those days again at once.
  const replaceDays=Number.isInteger(adapter.replaceDays)&&adapter.replaceDays>0?adapter.replaceDays:0;
  const reclosing=(a,current)=>{const r=onlyClosedBy(a,target.segments,current,today);return !r.length?null:replaceDays&&rangeDays(r)<=replaceDays?r:false;};
  for(const a of ledger.attempts.filter(a=>a.target===key&&a.state==='confirmed'&&a.end>today)) {
    if(budgetExpired())break;
    if(isCancelled())throw Error('executor_cancelled');
    if(!uncovered(a,target.segments).length)continue;
    let reclose=reclosing(a,blocks);
    if(reclose===false)continue;
    if(!adapter.remove||!releaseAllowed(a,target,now(),{independentBlocks:blocks.filter(b=>b.id!==a.created?.id),remembered,reclose}))continue;
    // Never reacquire deletion ownership when an external ID appears in more
    // than one historical receipt, including already released records.
    const prior=ledger.attempts.filter(other=>other!==a&&other.target===key&&other.created?.id===a.created.id);
    if(prior.length&&!permitsBoataroundReuse(a,target,prior)&&!permitsContentIdReuse(a.created.id,prior))continue;
    const observed=await adapter.read(target);blocks=verifiedBlocks(observed,'release_calendar_unverified');
    if(target.target==='boataround'&&!boataroundCoverageContains(observed.coverage,a))throw Error('calendar_scope_unverified');
    if(!blocks.some(b=>same(b,a.created)))continue;
    const others=blocks.filter(b=>b.id!==a.created.id);
    // Keep the record only if removing it would open a required date (from
    // today), unless this is an allowed replace. A date that is already open for
    // another reason (e.g. a day the Click&Boat app cannot close) must not stop
    // unrelated cancellations from opening.
    reclose=reclosing(a,blocks);
    if(reclose===false)continue;
    const current=currentTarget(await plan(),target,now());
    if(budgetExpired()||!releaseAllowed(a,current,now(),{independentBlocks:others,remembered,reclose}))continue;
    if(isCancelled())throw Error('executor_cancelled');
    a.state='releasing';a.release_before=others;a.release_proof=current.release_proof;a.release_started_at=new Date(now()).toISOString();await save(ledger);
    // A fresh plan before saving intent is insufficient: both persistence and
    // an adapter's final owned-record read can await long enough for the source
    // to change. Adapters invoke this again immediately before their mutation.
    // Only this pre-request guard can restore confirmed; mutation/readback
    // errors below retain releasing so an uncertain DELETE is never retried.
    const guard=async()=>{
      try {
        if(isCancelled()||budgetExpired())throw Error(isCancelled()?'executor_cancelled':'execution_budget_exhausted');
        let latest=currentTarget(await plan(),target,now()),independentBlocks=others;
        const reliesOnOthers=(latest.release_proof?.orders||[]).some(o=>o?.state==='active'&&overlap(o,a))||fleetHoldControl(latest)?.holds.some(h=>h.active&&overlap(h,a));
        if(reliesOnOthers){
          // Only the overlap case needs this extra read. CB/SB/MMK adapters do
          // not otherwise reread all independent records at their last guard.
          const read=await adapter.read(latest),fresh=verifiedBlocks(read,'release_calendar_unverified');
          if(target.target==='boataround'&&!boataroundCoverageContains(read.coverage,a))throw Error('calendar_scope_unverified');
          if(!fresh.some(b=>same(b,a.created))||others.some(b=>!fresh.some(c=>same(b,c))))throw Error('release_independent_protection_changed');
          independentBlocks=fresh.filter(b=>b.id!==a.created.id);
          latest=currentTarget(await plan(),target,now());
        }
        if(!releaseAllowed(a,latest,now(),{independentBlocks,remembered,reclose}))throw Error('source_changed_or_stale');
        if(isCancelled()||budgetExpired())throw Error(isCancelled()?'executor_cancelled':'execution_budget_exhausted');
      } catch(error){
        a.state='confirmed';a.release_not_submitted_at=new Date(now()).toISOString();await save(ledger);throw error;
      }
    };
    await guard();
    try {await adapter.remove(target,a.created,{guard});}
    catch(error){
      // Nothing was sent: the record is still ours and still closes its dates.
      if(error?.notSubmitted===true&&a.state==='releasing'){a.state='confirmed';a.release_not_submitted_at=new Date(now()).toISOString();await save(ledger);}
      throw error;
    }
    const readback=await adapter.read(target),after=verifiedBlocks(readback,'release_readback_failed');
    if(target.target==='boataround'&&!boataroundCoverageContains(readback.coverage,a))throw Error('release_readback_failed');
    if(after.some(b=>b.id===a.created.id)||others.some(b=>!after.some(c=>same(b,c))))throw Error('release_readback_failed');
    a.state='released';a.released_at=new Date(now()).toISOString();blocks=after;
    if(reclose){a.replaced={version:1,reclose:reclose.map(({start,end})=>({start,end}))};}
    await save(ledger);
    if(reclose)await onReclose(reclose);
  }
  return blocks;
}
