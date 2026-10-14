import {dateRange} from '../parsers.mjs';

const overlaps=(a,b)=>a.start<b.end&&a.end>b.start;
const keys=value=>Array.isArray(value)&&value.length>0&&value.every(k=>typeof k==='string'&&k.length>0)&&new Set(value).size===value.length;
const daily=a=>{try{dateRange(a.start,a.end);return Date.parse(a.end)-Date.parse(a.start)===86400000;}catch{return false;}};

/** This is the owner's explicit day-management policy, not a platform block ID. */
export function boataroundControl(target){
 if(target.target!=='boataround'||target.boataround_control===undefined)return null;
 const c=target.boataround_control;
 if(!c||c.version!==1||typeof c.enabled!=='boolean'||!Number.isSafeInteger(c.revision)||c.revision<0||!Array.isArray(c.holds))throw Error('boataround_control_unverified');
 const ids=new Set(),holds=c.holds.map(h=>{
  if(!h||typeof h.id!=='string'||!h.id||ids.has(h.id)||typeof h.active!=='boolean'||
    ['locked','release_only'].some(k=>h[k]!==undefined&&typeof h[k]!=='boolean'))throw Error('boataround_control_unverified');
  try{dateRange(h.start,h.end);}catch{throw Error('boataround_control_unverified');}
  ids.add(h.id);return {id:h.id,start:h.start,end:h.end,active:h.active,locked:h.locked===true,release_only:h.release_only===true};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return {version:1,enabled:c.enabled,revision:c.revision,holds};
}
export function sameBoataroundControl(a,b){return JSON.stringify(boataroundControl(a))===JSON.stringify(boataroundControl(b));}
export function boataroundCoverageContains(coverage,range){
 try{dateRange(coverage.start,coverage.end);dateRange(range.start,range.end);return coverage.start<=range.start&&coverage.end>=range.end;}catch{return false;}
}

function validIntent(a){
 const m=a.boataround_managed_intent;
 return !!m&&m.version===1&&typeof a.id==='string'&&!!a.id&&m.generation===a.id&&
  Number.isSafeInteger(m.control_revision)&&m.control_revision>=0&&daily(a)&&keys(a.causes)&&boataroundCoverageContains(m.coverage,a)&&
  Array.isArray(a.before)&&!a.before.some(b=>overlaps(a,b));
}
export function beginBoataroundManaged(attempt,target,coverage){
 const control=boataroundControl(target);
 if(control?.enabled&&daily(attempt)&&boataroundCoverageContains(coverage,attempt)&&Array.isArray(attempt.before)&&!attempt.before.some(b=>overlaps(attempt,b)))
  attempt.boataround_managed_intent={version:1,generation:attempt.id,control_revision:control.revision,coverage:{start:coverage.start,end:coverage.end}};
}
export function isBoataroundManaged(a){
 const m=a.boataround_managed;
 return validIntent(a)&&!!m&&m.version===1&&m.generation===a.id&&m.control_revision===a.boataround_managed_intent.control_revision&&
  keys(m.causes)&&a.causes.every(k=>m.causes.includes(k))&&a.created?.type===3&&
  typeof a.created.id==='string'&&!!a.created.id&&a.created.start===a.start&&a.created.end===a.end;
}
export function confirmBoataroundManaged(attempt,target,coverage){
 if(target.target!=='boataround'||!validIntent(attempt)||attempt.state!=='confirmed'||attempt.created?.type!==3||
   attempt.created.start!==attempt.start||attempt.created.end!==attempt.end||!boataroundCoverageContains(coverage,attempt))return;
 if(!attempt.boataround_managed)attempt.boataround_managed={version:1,generation:attempt.id,
  control_revision:attempt.boataround_managed_intent.control_revision,causes:[...attempt.causes]};
}
export function trackBoataroundCauses(ledger,key,target){
 if(target.target!=='boataround')return;
 const control=boataroundControl(target);
 for(const a of ledger.attempts.filter(a=>a.target===key&&['confirmed','releasing'].includes(a.state)&&isBoataroundManaged(a))){
  const causes=[...a.boataround_managed.causes];
  for(const s of target.segments||[])if(overlaps(a,s))causes.push(...s.causes);
  // Include native orders and release-only holds as well as write segments.
  for(const o of target.release_proof?.orders||[])if(o.state==='active'&&overlaps(a,o))causes.push(o.key);
  for(const h of control?.holds||[])if(h.active&&overlaps(a,h))causes.push('manual-hold:'+h.id);
  if(!keys([...new Set(causes)]))throw Error('boataround_control_unverified');
  a.boataround_managed.causes=[...new Set(causes)].sort();
 }
}
export function boataroundReleaseCauses(attempt,target){
 const control=boataroundControl(target);
 if(!control?.enabled||!isBoataroundManaged(attempt)||control.holds.some(h=>h.active&&overlaps(attempt,h)))return null;
 return attempt.boataround_managed.causes;
}
/** Only a completed NEW managed generation can free a synthetic day key for reuse. */
export function permitsBoataroundReuse(attempt,target,previous){
 return target.target==='boataround'&&boataroundControl(target)?.enabled===true&&validIntent(attempt)&&
  previous.every(a=>a.state==='released'&&isBoataroundManaged(a)&&a.id!==attempt.id&&a.start===attempt.start&&a.end===attempt.end)&&
  new Set(previous.map(a=>a.id)).size===previous.length;
}
