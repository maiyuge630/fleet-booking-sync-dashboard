import {readHoldState,mutateHolds,holdWindow} from './boataround-holds.mjs';
import {segments} from './planner.mjs';

export const FLEET_HOLDS_KEY='reverse-sync:fleet-holds:v1';
// The scopes deliberately use separate durable records. Reusing the strict
// mutation schema does not migrate or broaden legacy Boataround-only holds.
export const readFleetHoldState=readHoldState;
// An ongoing stop can have begun earlier in this Beijing calendar month.
// Retain its real start in the dashboard; execution still clips to today.
// Legacy Boataround-only holds keep their original future-only date window.
export const mutateFleetHolds=(state,input,now)=>mutateHolds(state,input,now,{allowStartedRange:true,boataroundOnly:false});
export function publicFleetHolds(state,now){
  return {ok:true,version:1,revision:state.revision,holds:state.holds.map(h=>({...h})),...holdWindow(now,{allowStartedRange:true})};
}
export function applyFleetHolds(plan,value){
  const state=readFleetHoldState(value),today=new Date(Date.parse(plan.generated_at)+8*3600000).toISOString().slice(0,10);
  for(const target of plan.targets){
    const holds=state.holds.filter(h=>h.boat===target.boat).map(({boat,...h})=>h);
    target.fleet_hold_control={version:1,revision:state.revision,holds};
    target.release_proof={...target.release_proof,orders:[...target.release_proof.orders]};
    const causes=target.segments.flatMap(s=>s.causes.map(key=>({key,start:s.start,end:s.end})));
    for(const h of holds){
      const key='manual-hold:'+h.id;
      if(target.release_proof.orders.some(o=>o.key===key))throw Error('hold_identity_conflict');
      target.release_proof.orders.push(h.active?{key,state:'active',start:h.start,end:h.end}:{key,state:'cancelled'});
      if(h.active&&h.end>today)causes.push({key,start:h.start<today?today:h.start,end:h.end});
    }
    target.segments=segments(causes);
    if(target.target==='boataround'){
      const control=target.boataround_control;
      if(!control||control.holds.some(a=>holds.some(b=>b.id===a.id)))throw Error('hold_identity_conflict');
      // Keep the legacy revision: the executor also compares fleet_hold_control.
      target.boataround_control={...control,holds:[...control.holds,...holds]};
    }
    if(target.segments.length&&target.status==='no_external_orders')target.status='preview';
  }
  plan.semantic.targets=plan.targets.map(({key,listing_id,mapping_state,segments,boataround_control,fleet_hold_control})=>({key,listing_id,mapping_state,segments,fleet_hold_control,...(boataround_control?{boataround_control}:{})}));
  return plan;
}
