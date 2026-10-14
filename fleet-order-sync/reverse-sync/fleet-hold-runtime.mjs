import {dateRange} from '../parsers.mjs';
import {uncovered} from './planner.mjs';

const overlaps=(a,b)=>a.start<b.end&&a.end>b.start;
const keys=value=>Array.isArray(value)&&value.length>0&&value.every(k=>typeof k==='string'&&k.length>0)&&new Set(value).size===value.length;
const exactKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));

/** Control state is separate from platform booking/payment evidence. */
export function fleetHoldControl(target){
 if(target.fleet_hold_control===undefined)return null;
 const c=target.fleet_hold_control;
 if(!exactKeys(c,['version','revision','holds'])||c.version!==1||!Number.isSafeInteger(c.revision)||c.revision<0||!Array.isArray(c.holds))throw Error('fleet_hold_control_unverified');
 const ids=new Set(),holds=c.holds.map(h=>{
  if(!exactKeys(h,['id','start','end','active'])||typeof h.id!=='string'||!h.id||ids.has(h.id)||typeof h.active!=='boolean')throw Error('fleet_hold_control_unverified');
  try{dateRange(h.start,h.end);}catch{throw Error('fleet_hold_control_unverified');}
  ids.add(h.id);return {id:h.id,start:h.start,end:h.end,active:h.active};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return {version:1,revision:c.revision,holds};
}
export function sameFleetHoldControl(a,b){return JSON.stringify(fleetHoldControl(a))===JSON.stringify(fleetHoldControl(b));}
export function beginFleetHoldIntent(attempt,target){
 const control=fleetHoldControl(target);
 const causes=control?.holds.filter(h=>h.active&&attempt.causes.includes('manual-hold:'+h.id)).map(h=>'manual-hold:'+h.id).sort();
 if(causes?.length)attempt.fleet_hold_intent={version:1,generation:attempt.id,revision:control.revision,causes};
}
export function isFleetHoldIntent(attempt){
 const m=attempt.fleet_hold_intent;
 return !!m&&m.version===1&&typeof attempt.id==='string'&&!!attempt.id&&m.generation===attempt.id&&Number.isSafeInteger(m.revision)&&m.revision>=0&&
  keys(m.causes)&&Array.isArray(attempt.causes)&&m.causes.every(c=>c.startsWith('manual-hold:')&&attempt.causes.includes(c));
}
export function verifyFleetHoldPlan(target,now){
 const control=fleetHoldControl(target);
 if(!control)return;
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 for(const h of control.holds)if(h.active&&h.end>today){
  const required={start:h.start<today?today:h.start,end:h.end};
  if(uncovered(required,target.segments.filter(s=>s.causes.includes('manual-hold:'+h.id))).length)throw Error('fleet_hold_plan_unverified');
 }
 const allowed=new Set(control.holds.filter(h=>h.active).map(h=>'manual-hold:'+h.id));
 if(target.target==='boataround')for(const h of target.boataround_control?.holds||[])if(h.active)allowed.add('manual-hold:'+h.id);
 if(target.segments.some(s=>s.causes.some(c=>c.startsWith('manual-hold:')&&!allowed.has(c))))throw Error('fleet_hold_plan_unverified');
}

/** Additional reasons only restrict release. They never grant record ownership. */
export function retainedReleaseCauses(attempt){
 if(!keys(attempt.causes))throw Error('release_causes_unverified');
 const tracked=attempt.release_causes;
 if(tracked===undefined)return attempt.causes;
 if(!exactKeys(tracked,['version','causes'])||tracked.version!==1||!keys(tracked.causes)||!attempt.causes.every(c=>tracked.causes.includes(c)))throw Error('release_causes_unverified');
 return tracked.causes;
}
export function trackReleaseCauses(ledger,key,target){
 const control=fleetHoldControl(target);
 if(target.target==='boataround')return; // Its managed generation already accumulates reasons.
 for(const a of ledger.attempts.filter(a=>a.target===key&&['confirmed','releasing'].includes(a.state)&&a.created?.id)){
  const causes=[...retainedReleaseCauses(a)];
  for(const s of target.segments||[])if(overlaps(a,s))causes.push(...s.causes);
  for(const o of target.release_proof?.orders||[])if(o.state==='active'&&overlaps(a,o))causes.push(o.key);
  for(const h of control?.holds||[])if(h.active&&overlaps(a,h))causes.push('manual-hold:'+h.id);
  const unique=[...new Set(causes)].sort();
  if(!keys(unique))throw Error('release_causes_unverified');
  if(a.release_causes!==undefined||unique.some(c=>!a.causes.includes(c)))a.release_causes={version:1,causes:unique};
 }
}
