import {uncovered} from './planner.mjs';
import {releaseOwned,verifiedBlocks,currentTarget,reconcileReleasedAttempts,permitsContentIdReuse,forfeitVanishedContentRecords,vanishedContentRecords,rememberCancellations,rememberedCancellations} from './release.mjs';
import {dateRange} from '../parsers.mjs';
import {boataroundControl,beginBoataroundManaged,confirmBoataroundManaged,trackBoataroundCauses,permitsBoataroundReuse,boataroundCoverageContains} from './ba-managed.mjs';
import {fleetHoldControl,verifyFleetHoldPlan,beginFleetHoldIntent,trackReleaseCauses} from './fleet-hold-runtime.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keyOf=t=>`${t.target}:${t.listing_id||'missing:'+t.boat}`;
// Display evidence only: never grants deletion ownership. Intersect historical
// automated attempts with a fresh calendar, subtract every currently needed day.
export function pendingReleaseRanges(attempts,blocks,expected,today){
  const ranges=[];
  for(const a of attempts)for(const b of blocks){
    const start=[a.start,b.start,today].sort().at(-1),end=a.end<b.end?a.end:b.end;
    if(start<end)ranges.push(...uncovered({start,end},expected));
  }
  const merged=[];
  for(const r of ranges.sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))){
    const last=merged.at(-1);if(last&&r.start<=last.end){if(r.end>last.end)last.end=r.end;}else merged.push({start:r.start,end:r.end});
  }
  return merged;
}
/** Single phone executor. Persist submission intent BEFORE every platform write.
 * Adapters must read the complete calendar and verify account/listing identity.
 * A persisted uncertain attempt is reconciled, never blindly submitted again.
 */
export class ReverseExecutor {
  // afterTarget(ledger): called once each target's result is saved, so a long
  // run can report finished targets while their receipts are still recent.
  // Its failure never affects the run.
  // forceCloseOnly: add missing protection only, even on a fully fresh plan;
  // used while a collected snapshot still waits for upload (core.mjs).
  constructor({load,save,plan,adapters,now=Date.now,monotonic=()=>performance.now(),isCancelled=()=>false,budgetMs=240000,afterTarget=null,forceCloseOnly=false}) {
    Object.assign(this,{load,save,plan,adapters,now,monotonic,isCancelled,budgetMs,afterTarget,forceCloseOnly});this.busy=false;
  }
  async run() {
    if(this.busy)return {state:'busy'};
    this.busy=true;
    try {
      const deadline=this.now()+this.budgetMs;
      const monotonicDeadline=this.monotonic()+this.budgetMs;
      const budgetExpired=()=>this.now()>deadline||this.monotonic()>monotonicDeadline;
      const ledger=await this.load()||{version:1,attempts:[],targets:{}};
      if(ledger.version!==1||!Array.isArray(ledger.attempts)||!ledger.targets)throw Error('invalid_reverse_ledger');
      const initial=await this.plan();
      if(!Array.isArray(initial.targets))throw Error('invalid_reverse_plan');
      // Resume unvisited targets first, so a large fleet cannot starve behind
      // the first slow account on every run. A target whose last visit was
      // deferred, or cut short to close-only by lapsed freshness, comes before
      // fully checked ones, so every target regularly gets a complete check.
      const rank=t=>{const previous=ledger.targets[keyOf(t)];
        return [previous?.state==='deferred'?0:previous?.state==='protected_partial'||previous?.error==='source_changed_or_stale'?1:2,Date.parse(previous?.checked_at)||0];};
      const targets=[...initial.targets].sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1];});
      for(const listed of targets) {
        const key=keyOf(listed),adapter=this.adapters[listed.target];
        if(budgetExpired()||this.isCancelled()){ledger.targets[key]={state:'deferred',checked_at:new Date(this.now()).toISOString(),segments:listed.segments};continue;}
        if(!adapter){ledger.targets[key]={state:'adapter_unavailable',checked_at:new Date(this.now()).toISOString(),segments:listed.segments};continue;}
        // Source freshness lapses 10 minutes after collection, which a long run
        // (Click&Boat app targets) can outlast. Each target is taken from a
        // current plan; once a run that began fresh allows neither a full nor a
        // close-only check, the target is deferred instead of failing.
        let target=listed;
        try{const current=(await this.plan()).targets?.filter(t=>t.target===listed.target&&t.boat===listed.boat);if(current?.length===1&&keyOf(current[0])===key)target=current[0];}catch{}
        if(listed.fresh===true&&target.fresh!==true&&target.close_ready!==true){ledger.targets[key]={state:'deferred',checked_at:new Date(this.now()).toISOString(),segments:target.segments};continue;}
        try {
          if(!target.listing_id)throw Error('mapping_unknown');
          // Close-only: some source is stale but its last complete orders are
          // known. Add missing protection only; never release or resize.
          const closeOnly=this.forceCloseOnly===true||target.fresh!==true;
          if(target.fresh!==true&&target.close_ready!==true)throw Error('source_changed_or_stale');
          const latestTarget=async()=>currentTarget(await this.plan(),target,this.now(),{closeOnly});
          const baControl=boataroundControl(target);
          const fleetControl=fleetHoldControl(target);
          if(!Array.isArray(target.segments))throw Error('invalid_reverse_plan');
          for(const s of target.segments){dateRange(s.start,s.end);if(!Array.isArray(s.causes)||!s.causes.length||s.causes.some(c=>typeof c!=='string'||!c))throw Error('invalid_reverse_plan');}
          verifyFleetHoldPlan(target,this.now());
          if(adapter.recover)await adapter.recover(target,ledger,async()=>{const latest=await latestTarget();if(this.isCancelled()||budgetExpired())throw Error('executor_cancelled');return latest;},this.save,{closeOnly});
          const observed=await adapter.read(target);let before={blocks:verifiedBlocks(observed),coverage:observed.coverage};
          // A record of ours is given up only when a second read from a fresh
          // app misses it too: one read left a row out on 2026-10-13 (AD1).
          const vanished=vanishedContentRecords(ledger,key,before.blocks,this.now());
          if(vanished.length){
            const again=await adapter.read(target);before={blocks:verifiedBlocks(again),coverage:again.coverage};
            if(forfeitVanishedContentRecords(ledger,key,before.blocks,this.now(),{among:new Set(vanished.map(a=>a.id))}))await this.save(ledger);
          }
          if(baControl&&!boataroundCoverageContains(before.coverage,before.coverage))throw Error('calendar_scope_unverified');
          if(target.target==='boataround'){
            await latestTarget();
            await reconcileReleasedAttempts({ledger,key,target,blocks:before.blocks,coverage:before.coverage,now:this.now,save:this.save});
          }
          const uncertain=[];
          // Repair acknowledgement after restart only when the exact recorded ID
          // and fingerprint survived a fresh read. Matching dates alone never
          // gives us ownership of a manual record.
          // Records drop out of the platform lists once they end (the Click&Boat
          // app lists future periods; Boataround reads from today), and owners
          // change unrelated dates. Only earlier records touching this attempt
          // and still listed must be unchanged; requiring the whole old calendar
          // left such attempts unconfirmed forever. A wholly past attempt no
          // longer blocks the target.
          const listedFrom=new Date(this.now()+8*3600000).toISOString().slice(0,10);
          const nearby=attempt=>(attempt.before||[]).filter(b=>b.end>listedFrom&&b.start<=attempt.end&&b.end>=attempt.start);
          for(const attempt of ledger.attempts.filter(a=>a.target===key&&!['confirmed','observed_protected','reviewed_no_record','not_submitted','releasing','released','record_missing'].includes(a.state))) {
            if(attempt.end<=listedFrom)continue;
            if(attempt.created&&before.blocks.some(b=>same(b,attempt.created))&&nearby(attempt).every(b=>before.blocks.some(a=>same(a,b)))){
              if(target.target==='boataround'&&attempt.boataround_managed_intent&&!boataroundCoverageContains(before.coverage,attempt)){
                uncertain.push({start:attempt.start,end:attempt.end,error:'calendar_scope_unverified'});continue;
              }
              attempt.state='confirmed';confirmBoataroundManaged(attempt,target,before.coverage);
            }
            else if(!attempt.created&&uncovered(attempt,before.blocks).length===0){
              // Coverage is now independently proved, but no ownership is
              // acquired without an identified write receipt. Never auto-delete.
              attempt.state='observed_protected';attempt.observed_at=new Date(this.now()).toISOString();
            } else uncertain.push({start:attempt.start,end:attempt.end,error:'previous_write_uncertain'});
          }
          trackBoataroundCauses(ledger,key,target);
          trackReleaseCauses(ledger,key,target);
          await this.save(ledger);
          let blocks=before.blocks;const blocked=[...uncertain];
          const expected=target.segments;
          // Past days need no protection, and some platforms refuse them (the
          // Click&Boat app date picker), which used to fail a whole stay already
          // in progress. Writes and the coverage check start today (Beijing);
          // the reported plan segments stay unchanged.
          const writeFrom=new Date(this.now()+8*3600000).toISOString().slice(0,10);
          const fromToday=s=>s.end<=writeFrom?[]:[{...s,start:s.start<writeFrom?writeFrom:s.start}];
          const writeGaps=async segments=>{
          for(const segment of segments.flatMap(fromToday))for(let gap of uncovered(segment,blocks).flatMap(g=>{
            if(adapter.maxGapDays!==1)return [g];
            const days=[];for(let start=g.start;start<g.end;){const end=new Date(Date.parse(start+'T00:00:00Z')+86400000).toISOString().slice(0,10);days.push({start,end});start=end;}return days;
          }).flatMap(g=>{
            // A platform form may be unable to express part of a gap (the
            // Click&Boat app, 2026-10-04). Write what it can and report the
            // rest for review instead of failing the whole gap every run.
            if(typeof adapter.writableGap!=='function')return [g];
            const {write,rest}=adapter.writableGap(g,blocks);
            blocked.push(...rest);return write;
          })) {
            if(uncertain.some(a=>a.start<gap.end&&a.end>gap.start))continue;
            if(budgetExpired())throw Error('execution_budget_exhausted');
            if(this.isCancelled())throw Error('executor_cancelled');
            await latestTarget();
            // Preparation uses normal platform controls and cannot persist data.
            let prepared;
            try {prepared=await adapter.prepare(target,gap);}catch(error){blocked.push({...gap,error:error.message});continue;}
            // A form may accept only an earlier last day (the Click&Boat app
            // greys out some end dates, found 2026-10-10). The adapter then
            // prepares the leading part; the rest is reported for review.
            if(prepared?.end!==undefined){
              if(typeof prepared.reason!=='string'||typeof prepared.end!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(prepared.end)||!(prepared.end>gap.start&&prepared.end<gap.end))throw Error('invalid_prepared_gap');
              blocked.push({start:prepared.end,end:gap.end,error:prepared.reason});
              gap={...gap,end:prepared.end};
            }
            await latestTarget();
            if(budgetExpired())throw Error('execution_budget_exhausted');
            if(this.isCancelled())throw Error('executor_cancelled');
            const attempt={id:crypto.randomUUID(),target:key,start:gap.start,end:gap.end,causes:[...segment.causes],before:blocks,state:'submitting',submitted_at:new Date(this.now()).toISOString()};
            beginBoataroundManaged(attempt,target,before.coverage);
            beginFleetHoldIntent(attempt,target);
            ledger.attempts.push(attempt);await this.save(ledger);
            const guard=async({beforeFirstWrite=false}={})=>{
              try {
                await latestTarget();
                if(this.isCancelled()||budgetExpired())throw Error('executor_cancelled');
              } catch(error){
                // Only an adapter's explicit pre-first-request check can prove
                // it has not submitted. A later MMK guard follows a real draft
                // write and must keep that uncertain/recoverable receipt.
                if(beforeFirstWrite&&attempt.response===undefined&&attempt.created===undefined){attempt.state='not_submitted';attempt.reason=error.message;await this.save(ledger);}
                throw error;
              }
            };
            // Persisting intent is asynchronous. Recheck after it completes so
            // a changed source cannot write using the pre-save plan. Failure
            // here is known to precede the adapter call, hence safely retryable.
            try {
              if(this.isCancelled()||budgetExpired())throw Error(this.isCancelled()?'executor_cancelled':'execution_budget_exhausted');
              await guard();
            } catch(error){
              attempt.state='not_submitted';attempt.reason=error.message;await this.save(ledger);throw error;
            }
            let created;
            try {created=await adapter.submit(target,gap,async evidence=>{attempt.response=evidence;await this.save(ledger);},{id:attempt.id,causes:attempt.causes,guard});}
            catch(error){
              // An error the adapter raised before its first platform request
              // leaves nothing to verify; otherwise the gap stayed uncertain forever.
              if(error?.notSubmitted===true&&attempt.response===undefined&&attempt.created===undefined&&attempt.state==='submitting'){attempt.state='not_submitted';attempt.reason=error.message;await this.save(ledger);}
              throw error;
            }
            const prior=ledger.attempts.filter(a=>a!==attempt&&a.target===key&&a.created?.id===created?.id);
            if(!created?.id||blocks.some(b=>b.id===created.id)||prior.length&&!permitsBoataroundReuse(attempt,target,prior)&&!permitsContentIdReuse(created.id,prior)||created.start!==gap.start||created.end!==gap.end)throw Error('write_receipt_mismatch');
            attempt.created=created;attempt.state='pending_readback';await this.save(ledger);
            const readback=await adapter.read(target),after=verifiedBlocks(readback,'write_readback_failed');
            if(baControl&&!boataroundCoverageContains(readback.coverage,attempt))throw Error('write_readback_failed');
            if(!after.some(b=>same(b,created))||blocks.some(b=>!after.some(a=>same(a,b))))throw Error('write_readback_failed');
            attempt.state='confirmed';attempt.confirmed_at=new Date(this.now()).toISOString();blocks=after;
            confirmBoataroundManaged(attempt,target,readback.coverage);trackBoataroundCauses(ledger,key,target);trackReleaseCauses(ledger,key,target);
            await this.save(ledger);
          }};
          await writeGaps(expected);
          // Releasing requires an explicit cancellation proof and platform-
          // specific ownership check; absence from the plan alone never releases.
          const latest=await latestTarget();
          if(this.isCancelled())throw Error('executor_cancelled');
          rememberCancellations(ledger,latest,this.now());
          const reclosed=[];
          if(!closeOnly)blocks=await releaseOwned({ledger,key,target:latest,adapter,plan:this.plan,save:this.save,now:this.now,blocks,coverage:before.coverage,deadline,budgetExpired,isCancelled:this.isCancelled,
            remembered:rememberedCancellations(ledger),onReclose:ranges=>{reclosed.push(...ranges);}});
          // A replace closes the days still needed right away (2026-10-10).
          if(reclosed.length){
            await latestTarget();
            await writeGaps(expected.flatMap(s=>reclosed.map(r=>({...s,start:s.start>r.start?s.start:r.start,end:s.end<r.end?s.end:r.end}))).filter(s=>s.start<s.end));
          }
          // Even a no-write run must prove both current source freshness and
          // complete observed coverage. A successful earlier request is not a
          // substitute for this target's current result.
          await latestTarget();
          for(const segment of expected.flatMap(fromToday))for(const gap of uncovered(segment,blocks))
            if(!blocked.some(b=>b.start<=gap.start&&b.end>=gap.end))blocked.push({...gap,error:'coverage_unverified'});
          for(const a of ledger.attempts.filter(a=>a.target===key&&a.state==='releasing'&&a.end>writeFrom))blocked.push({start:a.start,end:a.end,error:'previous_release_uncertain'});
          const today=new Date(this.now()+8*3600000).toISOString().slice(0,10);
          const retained=ledger.attempts.filter(a=>a.target===key&&['confirmed','releasing','observed_protected'].includes(a.state)&&a.end>today&&
            uncovered({start:a.start,end:a.end},expected).length>0);
          if(closeOnly){
            // Stale sources cannot prove that an old protection may open, so
            // opening reviews are neither computed nor reported here. The
            // dashboard keeps the last fully fresh opening review meanwhile.
            const resultState=blocked.length?'needs_review':'protected_partial';
            ledger.targets[key]={state:resultState,checked_at:new Date(this.now()).toISOString(),segments:expected,blocked,retained:[],
              stale_sources:[...(target.stale_sources||[])],
              ...(baControl&&resultState==='protected_partial'?{boataround_control_revision:baControl.revision}:{}),
              ...(fleetControl&&resultState==='protected_partial'?{fleet_hold_revision:fleetControl.revision}:{})};
            continue;
          }
          // Every platform reports the dates its kept program records still
          // close without a current need (2026-10-10; Boataround only before).
          const retained_ranges=pendingReleaseRanges(retained,blocks,[...expected,...(latest.release_proof?.orders||[]).filter(o=>o.state==='active')],today);
          const remaining=target.target==='boataround'?(retained_ranges.length?retained:[]):retained;
          const resultState=blocked.length?'needs_review':remaining.length?'removal_requires_verification':'protected';
          ledger.targets[key]={state:resultState,checked_at:new Date(this.now()).toISOString(),segments:expected,blocked,retained:remaining.map(a=>a.id),retained_ranges,
            ...(baControl&&resultState==='protected'?{boataround_control_revision:baControl.revision}:{}),
            ...(fleetControl&&resultState==='protected'?{fleet_hold_revision:fleetControl.revision}:{})};
        } catch(error) {ledger.targets[key]={state:'needs_review',error:error.message,segments:target.segments,checked_at:new Date(this.now()).toISOString()};}
        finally {
          // A tab cleanup failure must not suppress the durable result or
          // prevent other independent fleet targets from being checked.
          try {await adapter.close?.();}catch(error){ledger.targets[key]={...ledger.targets[key],state:'needs_review',cleanup_error:error.message};delete ledger.targets[key].boataround_control_revision;delete ledger.targets[key].fleet_hold_revision;}
          await this.save(ledger);
          try {await this.afterTarget?.(structuredClone(ledger));}catch{}
        }
      }
      await this.save(ledger);return ledger;
    } finally {this.busy=false;}
  }
}
