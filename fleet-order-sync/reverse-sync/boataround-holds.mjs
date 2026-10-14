import {FLEET,dateRange} from '../parsers.mjs';
import {segments} from './planner.mjs';

export const BOATAROUND_HOLDS_KEY='reverse-sync:boataround-holds:v1';
export const AC2_BOAT='coastline-sea-journey-42-tidewyn-cruise-2';
const AC2_HOLD=Object.freeze({id:'system-ac2-unavailable-through-2030',boat:AC2_BOAT,start:'2026-09-19',end:'2031-01-01',active:true,locked:true,release_only:true});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail=(code,status=400,extra={})=>{throw Object.assign(Error(code),{status,...extra});};
const initial=()=>({version:1,revision:0,holds:[],requests:[]});
export function readHoldState(value) {
  if(value===undefined)return initial();
  if(!value||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.holds)||!Array.isArray(value.requests)||value.holds.length>1000||value.requests.length>4000)fail('hold_state_invalid',503);
  const ids=new Set(),requests=new Set();
  for(const h of value.holds){
    if(!uuid(h?.id)||ids.has(h.id)||!FLEET.some(b=>b.slug===h.boat)||h.boat===AC2_BOAT||typeof h.active!=='boolean'||Object.keys(h).some(k=>!['id','boat','start','end','active'].includes(k)))fail('hold_state_invalid',503);
    try{dateRange(h.start,h.end);}catch{fail('hold_state_invalid',503);}
    ids.add(h.id);
  }
  for(const r of value.requests){if(!uuid(r?.request_id)||requests.has(r.request_id)||typeof r.fingerprint!=='string'||!Number.isSafeInteger(r.revision)||r.revision<0||r.revision>value.revision)fail('hold_state_invalid',503);requests.add(r.request_id);}
  return structuredClone(value);
}
export function holdWindow(now,{allowStartedRange=false}={}) {
  const start=new Date(now+8*3600000).toISOString().slice(0,10),date=new Date(start+'T00:00:00Z');
  const year=date.getUTCFullYear(),month=date.getUTCMonth()+15,day=Math.min(date.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
  return {window_start:allowStartedRange?start.slice(0,8)+'01':start,window_end:new Date(Date.UTC(year,month,day)).toISOString().slice(0,10)};
}
export function publicHolds(state,now) {
  return {ok:true,version:1,enabled:true,revision:state.revision,holds:[...state.holds,AC2_HOLD].map(h=>({...h})),...holdWindow(now)};
}
/** Pure durable mutation: caller commits this and the phone queue in one transaction. */
// boataroundOnly: the legacy Boataround-only holds cannot name a boat that is
// not on Boataround (the Lightcat, since 2026-10-09); fleet holds can.
export function mutateHolds(value,input,now,{allowStartedRange=false,boataroundOnly=true}={}) {
  const state=readHoldState(value);
  if(!input||typeof input!=='object'||!['add','remove'].includes(input.action)||!uuid(input.request_id)||!Number.isSafeInteger(input.revision)||input.revision<0)fail('invalid_hold_request');
  const keys=input.action==='add'?['action','request_id','revision','boat','start','end']:['action','request_id','revision','id'];
  if(Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>input[k]===undefined))fail('invalid_hold_request');
  const fingerprint=JSON.stringify(keys.map(k=>input[k]));
  const previous=state.requests.find(r=>r.request_id===input.request_id);
  if(previous){if(previous.fingerprint!==fingerprint)fail('hold_request_conflict',409);return {state,changed:false,idempotent:true,operation_revision:previous.revision};}
  if(input.revision!==state.revision)fail('hold_revision_conflict',409,{revision:state.revision});
  if(state.requests.length>=4000)fail('hold_limit',409);
  let changed=false;
  if(input.action==='add'){
    if(!FLEET.some(b=>b.slug===input.boat&&!(boataroundOnly&&b.boataround===false)))fail('invalid_hold_request');
    if(input.boat===AC2_BOAT)fail('boat_manually_disabled');
    try{dateRange(input.start,input.end);}catch{fail('hold_invalid_dates');}
    const window=holdWindow(now,{allowStartedRange});
    if(input.start<window.window_start||input.end>window.window_end||Date.parse(input.end)-Date.parse(input.start)>365*86400000||
       allowStartedRange&&input.end<=holdWindow(now).window_start)fail('hold_outside_window');
    if(!state.holds.some(h=>h.active&&h.boat===input.boat&&h.start===input.start&&h.end===input.end)){
      if(state.holds.length>=1000)fail('hold_limit',409);
      state.holds.push({id:input.request_id,boat:input.boat,start:input.start,end:input.end,active:true});changed=true;
    }
  }else{
    if(input.id===AC2_HOLD.id)fail('hold_locked',409);
    if(!uuid(input.id))fail('invalid_hold_request');
    const hold=state.holds.find(h=>h.id===input.id);
    if(!hold)fail('hold_not_found',404);
    if(hold.active){hold.active=false;changed=true;}
  }
  if(changed)state.revision++;
  if(!Number.isSafeInteger(state.revision))fail('hold_limit',409);
  state.requests.push({request_id:input.request_id,fingerprint,revision:state.revision});
  return {state,changed,idempotent:false,operation_revision:state.revision};
}
export function applyBoataroundHolds(plan,value) {
  const state=readHoldState(value);
  const today=new Date(Date.parse(plan.generated_at)+8*3600000).toISOString().slice(0,10);
  for(const target of plan.targets.filter(t=>t.target==='boataround')){
    // mmkPlan reuses the original order proof. Holds are BA-only evidence and
    // must not mutate the shared proof used by another platform.
    target.release_proof={...target.release_proof,orders:[...target.release_proof.orders]};
    const holds=[...state.holds,...(target.boat===AC2_BOAT?[AC2_HOLD]:[])].filter(h=>h.boat===target.boat).map(({boat,...h})=>h);
    target.boataround_control={version:1,enabled:target.boat!==AC2_BOAT,revision:state.revision,holds};
    const causes=target.segments.flatMap(s=>s.causes.map(key=>({key,start:s.start,end:s.end})));
    for(const h of holds){
      const key='manual-hold:'+h.id;
      target.release_proof.orders.push(h.active?{key,state:'active',start:h.start,end:h.end}:{key,state:'cancelled'});
      if(h.active&&!h.release_only&&h.end>today)causes.push({key,start:h.start<today?today:h.start,end:h.end});
    }
    target.segments=segments(causes);
    if(target.segments.length&&target.status==='no_external_orders')target.status='preview';
  }
  plan.semantic.targets=plan.targets.map(({key,listing_id,mapping_state,segments,boataround_control})=>({key,listing_id,mapping_state,segments,...(boataround_control?{boataround_control}:{})}));
  return plan;
}
