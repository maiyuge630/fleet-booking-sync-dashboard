import {buildPlan as basePlan,uncovered} from './planner.mjs';
import {mmkPlan} from './mmk-plan.mjs';
import {nausysPlan} from './nausys-plan.mjs';
// MMK (2026-09) and NauSYS (2026-10-09) calendar targets follow the three platforms.
function buildPlan(...args){const p=basePlan(...args);const extra=[...mmkPlan(p).targets,...nausysPlan(p).targets];p.targets.push(...extra);p.semantic.targets.push(...extra.map(({key,listing_id,mapping_state,segments})=>({key,listing_id,mapping_state,segments})));return p;}
import {dateRange} from '../parsers.mjs';
import {BOATAROUND_HOLDS_KEY,readHoldState,publicHolds,applyBoataroundHolds} from './boataround-holds.mjs';
import {FLEET_HOLDS_KEY,readFleetHoldState,publicFleetHolds,applyFleetHolds} from './fleet-holds.mjs';
import {MANUAL_ORDERS_KEY,readManualOrders,checkManualOrderHolds} from '../manual-orders.mjs';

export const REVERSE_KEY='reverse-sync:v1:state';
export const REPORT_KEY='reverse-sync:v1:report';
export const RECEIPT_MAX_AGE_MS=(3*60+15)*60000;
// Only stable codes cross into the public dashboard. Platform exception text
// can contain URLs, account details or HTML and is never echoed to readers.
const SAFE_ERRORS=new Set(['mmk_auth_required','auth_required','source_changed_or_stale','mapping_unknown',
  'coverage_unverified','mmk_account_mismatch','execution_budget_exhausted','executor_cancelled',
  'mmk_editor_unavailable','plan_clock_invalid','mmk_availability_unverified','mmk_dates_not_available',
  'mmk_calendar_changed','mmk_owned_record_changed','mmk_partial_write_requires_review','mmk_draft_requires_review',
  'target_identity_unverified','calendar_auth_unavailable','target_changed_during_preparation',
  'calendar_scope_unverified','boataround_owned_day_changed','calendar_release_failed',
  'previous_write_uncertain','previous_release_uncertain','release_readback_failed','write_readback_failed',
  'platform_timeout','reverse_plan_unavailable','receipt_stale','receipt_conflict','platform_challenge','cb_app_day_before_record','cb_app_end_not_selectable','cb_app_date_not_selectable',
  // NauSYS (2026-10-09)
  'nausys_auth_required','nausys_account_mismatch','nausys_list_unavailable','nausys_list_incomplete','nausys_filters_set',
  'nausys_search_form_changed','nausys_calendar_unavailable','nausys_dates_not_available','nausys_calendar_changed',
  'nausys_form_mismatch','nausys_client_not_found','nausys_dialog_unavailable','nausys_write_uncertain',
  'nausys_booking_not_confirmed','nausys_partial_write_requires_review','nausys_owned_record_changed',
  'nausys_cancel_uncertain','nausys_cancel_readback_failed',
  // Review 2026-10-10: codes the NauSYS adapter can raise, and MMK's turnover night.
  'nausys_calendar_timeout','nausys_client_unknown','nausys_dialog_already_open','nausys_dialog_not_closed',
  'nausys_draft_not_saved','nausys_write_intent_required','mmk_turnover_conflict','mmk_no_free_draft_window','mmk_initial_record_changed']);
const safeError=value=>typeof value==='string'&&SAFE_ERRORS.has(value)?value:undefined;
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),x=>x.toString(16).padStart(2,'0')).join('');

/** Durable preview ledger. No platform mutation is enabled by this module. */
export class ReverseSync {
  constructor({storage,registry,registryStatus,now=Date.now}) { Object.assign(this,{storage,registry,registryStatus,now}); }
  async holds(){return publicHolds(readHoldState(await this.storage.get(BOATAROUND_HOLDS_KEY)),this.now());}
  async fleetHolds(){return publicFleetHolds(readFleetHoldState(await this.storage.get(FLEET_HOLDS_KEY)),this.now());}
  async currentPlan(){
    const mapping=await this.registry(),status=await this.registryStatus();
    const plan=applyBoataroundHolds(buildPlan(mapping,status,{now:this.now()}),await this.storage.get(BOATAROUND_HOLDS_KEY));
    const control=await this.storage.transaction(async tx=>{
      const holds=readFleetHoldState(await tx.get(FLEET_HOLDS_KEY));
      checkManualOrderHolds(readManualOrders(await tx.get(MANUAL_ORDERS_KEY)),holds);return holds;
    });
    return applyFleetHolds(plan,control);
  }
  async machinePlan() {
    const plan=await this.currentPlan();
    return {ok:true,rule_version:plan.rule_version,generated_at:plan.generated_at,targets:plan.targets};
  }
  async report(input) {
    // 8 boats x 3 platforms + MMK 3 + NauSYS 4 targets since 2026-10-09.
    if(!['close_only','guarded_release'].includes(input?.mode)||!Array.isArray(input.targets)||input.targets.length>48)throw Error('invalid_reverse_report');
    const plan=await this.machinePlan(),seen=new Set();
    const targets=input.targets.map(t=>{
      const match=plan.targets.find(p=>p.key===t.key);
      if(!match||seen.has(t.key)||!['protected','protected_partial','needs_review','deferred','adapter_unavailable','removal_requires_verification'].includes(t.state)||!Number.isFinite(Date.parse(t.checked_at))||Date.parse(t.checked_at)>this.now()+60000||this.now()-Date.parse(t.checked_at)>600000)throw Error('invalid_reverse_report');
      seen.add(t.key);
      if(t.blocked!==undefined&&!Array.isArray(t.blocked)||t.retained!==undefined&&!Array.isArray(t.retained))throw Error('invalid_reverse_report');
      for(const b of t.blocked||[]){try{dateRange(b.start,b.end);}catch{throw Error('invalid_reverse_report');}}
      if(t.retained_ranges!==undefined){
        // Every platform may report them since 2026-10-10 (Boataround only before).
        if(!Array.isArray(t.retained_ranges)||t.retained_ranges.length>1000)throw Error('invalid_reverse_report');
        for(const b of t.retained_ranges){try{dateRange(b.start,b.end);}catch{throw Error('invalid_reverse_report');}
          if(JSON.stringify(t.segments)===JSON.stringify(match.segments)&&match.segments.some(s=>s.start<b.end&&s.end>b.start))throw Error('invalid_reverse_report');}
        if(t.state==='protected'&&t.retained_ranges.length)throw Error('contradictory_reverse_report');
        // A close-only run cannot evaluate openings, so it reports none.
        if(t.state==='protected_partial')throw Error('contradictory_reverse_report');
      }
      const isProtected=t.state==='protected'||t.state==='protected_partial';
      if(isProtected&&(t.blocked?.length||t.retained?.length))throw Error('contradictory_reverse_report');
      if(t.boataround_control_revision!==undefined&&(match.target!=='boataround'||!Number.isSafeInteger(t.boataround_control_revision)||t.boataround_control_revision<0||t.boataround_control_revision>match.boataround_control.revision))throw Error('invalid_reverse_report');
      if(t.fleet_hold_revision!==undefined&&(!Number.isSafeInteger(t.fleet_hold_revision)||t.fleet_hold_revision<0||t.fleet_hold_revision>match.fleet_hold_control.revision))throw Error('invalid_reverse_report');
      const blocked=(t.blocked||[]).slice(0,30).map(b=>({start:b.start,end:b.end}));
      const valid=JSON.stringify(t.segments)===JSON.stringify(match.segments);
      const fleetValid=t.fleet_hold_revision===match.fleet_hold_control.revision;
      const controlValid=fleetValid&&(match.target!=='boataround'||t.boataround_control_revision===match.boataround_control.revision);
      // A partial receipt stays valid while the plan still allows close-only;
      // a full receipt keeps requiring every source to be fresh.
      const usable=t.state==='protected_partial'?match.fresh===true||match.close_ready===true:match.fresh;
      // A target without a platform boat ID is never "closed" (review 2026-10-10).
      const unmapped=!match.listing_id;
      const downgraded=isProtected&&(unmapped||!usable||!valid||!controlValid),state=downgraded?'needs_review':t.state;
      const stateProtected=state==='protected'||state==='protected_partial';
      const error=downgraded?(unmapped?'mapping_unknown':'source_changed_or_stale'):stateProtected?undefined:
        safeError(t.error)||(t.blocked||[]).map(b=>safeError(b.error)).find(Boolean);
      // An empty list clears an old opening warning. The phone sends one only
      // after a full guarded check (a failed or close-only check sends none).
      // A target with days its platform will not close stays "needs_review"
      // for good (Click&Boat minimum charter, AD1, 2026-10-12), so clearing
      // cannot wait for "protected" there.
      const clears=t.retained_ranges?.length===0&&valid&&(state==='protected'&&controlValid||
        input.mode==='guarded_release'&&!isProtected&&match.fresh===true);
      return {key:t.key,state,checked_at:t.checked_at,blocked,segments:valid?match.segments:null,...(error?{error}:{}),
        // Stale source names come from the server plan, never from the phone.
        ...(state==='protected_partial'?{stale_sources:[...(match.stale_sources||[])]}:{}),
        ...(match.target==='boataround'&&stateProtected&&controlValid?{boataround_control_revision:t.boataround_control_revision}:{}),
        ...(stateProtected&&controlValid?{fleet_hold_revision:t.fleet_hold_revision}:{}),
        ...(t.retained_ranges!==undefined&&valid&&(t.retained_ranges.length>0||clears)?{retained_ranges:t.retained_ranges.map(({start,end})=>({start,end})),retained_checked_at:t.checked_at}:{})};
    });
    await this.storage.transaction(async tx=>{
      const control=readHoldState(await tx.get(BOATAROUND_HOLDS_KEY));
      const fleetControl=readFleetHoldState(await tx.get(FLEET_HOLDS_KEY));
      // A hold can change while the report's order plan was being prepared.
      // Recheck its durable revision at the same commit as the receipt.
      for(const next of targets)if(next.boataround_control_revision!==undefined&&next.boataround_control_revision!==control.revision||next.fleet_hold_revision!==undefined&&next.fleet_hold_revision!==fleetControl.revision){
        next.state='needs_review';next.error='source_changed_or_stale';delete next.boataround_control_revision;delete next.fleet_hold_revision;
        if(next.retained_ranges?.length===0){delete next.retained_ranges;delete next.retained_checked_at;}
      }
      const previous=await tx.get(REPORT_KEY),merged=new Map((previous?.targets||[]).map(t=>[t.key,t]));let updated=false;
      for(const next of targets){
        const old=merged.get(next.key),stamp=Date.parse(next.checked_at),oldStamp=Date.parse(old?.checked_at);
        if(next.retained_ranges===undefined&&old?.retained_ranges){next.retained_ranges=old.retained_ranges;next.retained_checked_at=old.retained_checked_at;}
        if(old&&stamp===oldStamp&&JSON.stringify(next)!==JSON.stringify(old)){
          const conflict={...next,state:'needs_review',error:safeError(old.error)||safeError(next.error)||'receipt_conflict'};
          delete conflict.boataround_control_revision;delete conflict.fleet_hold_revision;
          merged.set(next.key,conflict);updated=true;
        }
        else if(!old||stamp>oldStamp){merged.set(next.key,next);updated=true;}
      }
      if(updated||!previous)await tx.put(REPORT_KEY,{mode:input.mode,targets:[...merged.values()],received_at:new Date(this.now()).toISOString()});
    });
    return {ok:true};
  }
  async preview() {
    const plan=await this.currentPlan();
    const report=await this.storage.get(REPORT_KEY);
    if(report)for(const target of plan.targets){
      const prior=report.targets.find(r=>r.key===target.key);
      // A newer order plan must not silently erase a still-unresolved opening
      // warning. Retain its original observation time, subtract new paid dates.
      if(prior?.retained_ranges?.length){
        const occupied=[...target.segments,...(target.release_proof?.orders||[]).filter(o=>o.state==='active')];
        target.release_review={ranges:prior.retained_ranges.flatMap(r=>uncovered(r,occupied)),checked_at:prior.retained_checked_at||prior.checked_at};
      }
      const r=report.targets.find(r=>r.key===target.key&&JSON.stringify(r.segments)===JSON.stringify(target.segments));
      if(r){const partial=r.state==='protected_partial',isProtected=r.state==='protected'||partial;
        // A partial receipt was made while some source was already failing, so
        // it stays current as long as the plan still permits close-only.
        const healthy=partial?target.fresh===true||target.close_ready===true:target.source_healthy;
        const age=this.now()-Date.parse(r.checked_at),stale=!Number.isFinite(age)||age < -60000||age>RECEIPT_MAX_AGE_MS||!healthy;
        const controlStale=r.fleet_hold_revision!==target.fleet_hold_control.revision||target.target==='boataround'&&r.boataround_control_revision!==target.boataround_control.revision;
        const expired=stale||controlStale;
        const error=expired&&isProtected?(!healthy||controlStale?'source_changed_or_stale':'receipt_stale'):isProtected?undefined:safeError(r.error);
        target.execution={state:expired&&isProtected?'stale':r.state,checked_at:r.checked_at,blocked:r.blocked||[],stale:expired,...(error?{error}:{}),
          ...(!expired&&partial?{stale_sources:r.stale_sources||[]}:{}),
          ...(!expired&&isProtected&&target.target==='boataround'?{boataround_control_revision:r.boataround_control_revision}:{}),retained_ranges:r.retained_ranges||[],retained_checked_at:r.retained_checked_at};}
      if(['protected','protected_partial'].includes(target.execution?.state)&&!target.execution.stale)target.execution.fleet_hold_revision=r.fleet_hold_revision;
    }
    const digest=await hash(plan.semantic);
    return this.storage.transaction(async tx=>{
      const control=readHoldState(await tx.get(BOATAROUND_HOLDS_KEY));
      const fleetControl=readFleetHoldState(await tx.get(FLEET_HOLDS_KEY));
      if(plan.targets.some(t=>t.target==='boataround'&&t.boataround_control.revision!==control.revision))throw Error('hold_state_changed');
      if(plan.targets.some(t=>t.fleet_hold_control.revision!==fleetControl.revision))throw Error('hold_state_changed');
      const previous=await tx.get(REVERSE_KEY);
      if (previous && previous.schema_version!==1) throw new Error('reverse_state_invalid');
      const revision=(previous?.revision||0)+(previous?.digest===digest?0:1);
      const result={schema_version:1,mode:report?.mode||'preview',revision,digest,
        generated_at:plan.generated_at,targets:plan.targets,excluded:plan.excluded,
        source_order_count:plan.causes.length,writes_enabled:!!report,
        message:report?(report.mode==='guarded_release'?'手机自动开关档；异常保留并提示核对':'手机关档回读结果；自动开放尚未启用'):'预览模式：尚未向平台自动写入档期'};
      // Persist only when occupancy or evidence actually changes, not each page view.
      const evidence=await hash({targets:plan.targets.map(t=>[t.key,t.fresh]),causes:plan.causes.map(c=>[c.key,c.verified_at]),excluded:plan.excluded});
      if(!previous||previous.digest!==digest||previous.evidence!==evidence)await tx.put(REVERSE_KEY,{...result,evidence});
      return {ok:true,...result};
    });
  }
}

