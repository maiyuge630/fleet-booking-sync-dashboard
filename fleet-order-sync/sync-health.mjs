const SOURCES=['boataround','clickandboat','samboat','mmk','nausys'];
const WINDOW=30*86400000,MAX_EVENTS=4096;
const ERRORS=['auth_required','fetch_failed','schema_changed','incomplete_pages','challenge_required'];
const validRun=v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,100}$/.test(v);
function retainedEvents(saved,now){
 return (Array.isArray(saved?.events)?saved.events:[]).filter(e=>e&&SOURCES.includes(e.source)&&validRun(e.run_id)&&
  ['success','failure'].includes(e.outcome)&&Number.isFinite(Date.parse(e.at))&&Date.parse(e.at)>now-WINDOW&&Date.parse(e.at)<=now+60000)
  .map(e=>({source:e.source,run_id:e.run_id,outcome:e.outcome,at:new Date(e.at).toISOString()})).sort((a,b)=>a.at.localeCompare(b.at));
}

// Counts accepted collection results, not HTTP retries and not unseen offline
// runs. Retaining that distinction prevents an inflated reliability claim.
export function recordSyncHealth(previous,payload,receipt,now){
 const events=retainedEvents(previous,now);
 const seen=new Set(events.map(e=>e.source+':'+e.run_id));
 for(const source of SOURCES){
  const snapshots=(Array.isArray(payload?.snapshots)?payload.snapshots:[]).filter(s=>s?.source===source),
   results=(Array.isArray(receipt?.results)?receipt.results:[]).filter(r=>r?.source===source);
  if(snapshots.length!==1||results.length!==1)continue;
  const s=snapshots[0],outer=results[0],r=outer.accepted===false?outer.failure_receipt:outer;
  const checked=Date.parse(s.checked_at),rejectedFailure=outer.accepted===false&&outer.status===422&&
   r?.source===source&&r.run_id===s.run_id&&r.outcome==='failure'&&ERRORS.includes(r.error_code)&&
   Number.isFinite(checked)&&r.checked_at===new Date(checked).toISOString();
  // Ordinary/idempotent registry receipts intentionally omit run_id. They
  // correspond to the sole submitted snapshot for this source; reject an
  // explicit mismatching ID, but do not discard the actual production shape.
  if(outer.accepted===false&&!rejectedFailure||!validRun(s.run_id)||seen.has(source+':'+s.run_id)||r?.source!==source||
   r.accepted!==true||r.ignored!==undefined||r.error!==undefined||r.run_id!==undefined&&r.run_id!==s.run_id||
   r.status!==undefined&&(!Number.isInteger(r.status)||r.status<200||r.status>=300))continue;
  const outcome=rejectedFailure?'failure':s.outcome==='failure'&&ERRORS.includes(s.error_code)?'failure':
   s.complete===true&&(s.outcome===undefined||s.outcome==='success')?'success':null;
  if(!outcome||r.outcome!==outcome&&!(r.idempotent===true&&r.outcome===undefined))continue;
  // An old replay without an original server receipt timestamp is not a new run.
  const received=Date.parse(r.received_at);
  if(r.idempotent===true&&!Number.isFinite(received))continue;
  const at=Number.isFinite(received)?received:now;
  if(at<=now-WINDOW||at>now+60000)continue;
  events.push({source,run_id:s.run_id,outcome,at:new Date(at).toISOString()});seen.add(source+':'+s.run_id);
 }
 events.sort((a,b)=>a.at.localeCompare(b.at));
 return {version:1,started_at:previous?.started_at||new Date(now).toISOString(),truncated:previous?.truncated===true||events.length>MAX_EVENTS,events:events.slice(-MAX_EVENTS)};
}

export function summarizeSyncHealth(saved,now){
 const events=retainedEvents(saved,now);
 const sources=Object.fromEntries(SOURCES.map(source=>{
  const rows=events.filter(e=>e.source===source),success=rows.filter(e=>e.outcome==='success'),failure=rows.filter(e=>e.outcome==='failure');
  return [source,{success:success.length,failure:failure.length,last_success_at:success.at(-1)?.at||null,last_failure_at:failure.at(-1)?.at||null}];
 }));
 return {window_days:30,started_at:saved?.started_at||null,coverage:'received_results_only',truncated:saved?.truncated===true,
  success:events.filter(e=>e.outcome==='success').length,failure:events.filter(e=>e.outcome==='failure').length,sources};
}
