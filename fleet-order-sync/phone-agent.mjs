import {VOLTAGE_KEY,normalizeVoltage,mergeVoltage,currentVoltageBoats} from './voltage-data.mjs';
import {ReverseSync} from './reverse-sync/store.mjs';
import {BOATAROUND_HOLDS_KEY,readHoldState,mutateHolds,publicHolds} from './reverse-sync/boataround-holds.mjs';
import {FLEET_HOLDS_KEY,mutateFleetHolds,publicFleetHolds} from './reverse-sync/fleet-holds.mjs';
import {recordSyncHealth,summarizeSyncHealth} from './sync-health.mjs';
import {MANUAL_ORDERS_KEY,readManualOrders,publicManualOrders,mutateManualOrders} from './manual-orders.mjs';
// The phone receives a narrowly scoped machine credential, never a dashboard login.
// Pairing requires a code created through the original authenticated same-origin UI.
export const PHONE_AGENT_KEY = 'phone-agent:state';
export const PHONE_INTERVAL_MS = 3 * 60 * 60 * 1000;
const CODE_TTL = 10 * 60 * 1000, MAX_ATTEMPTS = 5, MAX_ORDER_BYTES = 900 * 1024;
const SOURCES = ['boataround','clickandboat','samboat','mmk','nausys'];
const ERRORS = ['auth_required','fetch_failed','schema_changed','incomplete_pages','challenge_required'];
const MANUAL_STATES = ['queued','running','awaiting_upload','completed'];
const validRunId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const MACHINE_PATHS = new Set(['/api/agent/pair','/api/agent/poll','/api/agent/order-sync','/api/agent/heartbeat','/api/agent/voltage','/api/agent/reverse-plan','/api/agent/reverse-report']);
const USER_PATHS = new Set(['/api/agent/status','/api/agent/pairing-code','/api/agent/run','/api/agent/config','/api/agent/revoke','/api/reverse-sync/preview','/api/reverse-sync/boataround-holds','/api/reverse-sync/fleet-holds']);
USER_PATHS.add('/api/manual-orders');
const encoder = new TextEncoder();
const response = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
  'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
}});
const fault = (code, status = 400) => Object.assign(new Error(code), {status});
const stamp = now => new Date(now).toISOString();
const initial = () => ({mode:'phone', enabled:false, pairing:null, token_hash:null,
  name:null, paired_at:null, last_seen:null, state:'idle', next_run_at:null, requested_run_id:null, manual_run:null});
function publicManualRun(run) {
  if(!run || !validRunId(run.id) || !MANUAL_STATES.includes(run.state))return null;
  const results={};
  for(const source of SOURCES){
    const item=run.results?.[source];
    if(!item || !['success','failure'].includes(item.outcome) || !Number.isFinite(Date.parse(item.checked_at)))continue;
    results[source]={outcome:item.outcome,checked_at:stamp(Date.parse(item.checked_at)),
      ...(item.outcome==='failure'&&ERRORS.includes(item.error_code)?{error_code:item.error_code}:{})};
  }
  return {id:run.id,state:run.state,requested_at:run.requested_at,completed_at:run.completed_at??null,results};
}
function finishManualRun(state) {
  const run=state.manual_run;
  // Completion needs both the phone's matching finished acknowledgment and
  // accepted receipts for all sources. Uploads alone never clear the queue.
  if(!run?.completed_at || !SOURCES.every(source=>['success','failure'].includes(run.results?.[source]?.outcome)))return;
  run.state='completed';
  promoteHoldRun(state);
}
function newManualRun(id,now){return {id,state:'queued',requested_at:stamp(now),completed_at:null,results:{}};}
function promoteHoldRun(state){
  if(!state.requested_run_id&&state.followup_run&&(!state.manual_run||state.manual_run.state==='completed')){
    state.manual_run=state.followup_run;state.requested_run_id=state.followup_run.id;delete state.followup_run;
  }
}
function queueHoldRun(state,now){
  // A change arriving while the phone is busy must get a following run. Reusing
  // that already-running id could acknowledge a plan made before this change.
  if(state.requested_run_id||state.manual_run&&state.manual_run.state!=='completed'){
    state.followup_run ||= newManualRun(crypto.randomUUID(),now);
    return {status:'queued_after_current',requested_run_id:state.followup_run.id};
  }
  state.requested_run_id ||= crypto.randomUUID();
  if(state.manual_run?.id!==state.requested_run_id)state.manual_run=newManualRun(state.requested_run_id,now);
  return {status:state.state==='running'?'queued_after_current':'queued',requested_run_id:state.requested_run_id};
}
function associateManualReceipts(state,requestedId,payload,receipt,now) {
  const run=state.manual_run;
  if(!requestedId || run?.id!==requestedId || !Array.isArray(payload.snapshots) || !Array.isArray(receipt?.results))return;
  for(const source of SOURCES){
    const snapshots=payload.snapshots.filter(item=>item?.source===source),results=receipt.results.filter(item=>item?.source===source);
    if(snapshots.length!==1 || results.length!==1)continue;
    const snapshot=snapshots[0],outerResult=results[0],checked=Date.parse(snapshot.checked_at),requested=Date.parse(run.requested_at);
    const rejection=outerResult.failure_receipt;
    // A permanent rejection is not a successful collection. The registry may
    // nevertheless have committed a matching failure event. Only that actual
    // receipt can finish the manual source as failed after the phone retires
    // the rejected payload; a bare rejection remains unconfirmed.
    const rejectedFailure=outerResult.accepted===false&&outerResult.status===422&&
      rejection?.source===source&&rejection.accepted===true&&rejection.outcome==='failure'&&
      rejection.run_id===snapshot.run_id&&Number.isFinite(checked)&&rejection.checked_at===stamp(checked)&&
      ERRORS.includes(rejection.error_code)&&typeof rejection.received_at==='string';
    const result=rejectedFailure?rejection:outerResult;
    const received=typeof result.received_at==='string'?Date.parse(result.received_at):NaN;
    // checked_at is the phone's observation clock, whereas requested_at is the
    // server clock. A small negative offset needs proof that this exact digest
    // first reached the registry after the request, including idempotent retries.
    const receivedAfterRequest=Number.isFinite(received)&&received>=requested&&received<=now+60000;
    const afterRequest=checked>=requested?(result.received_at===undefined||receivedAfterRequest):checked>=requested-60000&&receivedAfterRequest;
    if(result.accepted!==true || result.ignored!==undefined || result.error!==undefined ||
      (result.status!==undefined&&(!Number.isInteger(result.status)||result.status<200||result.status>=300)) ||
      (result.run_id!==undefined&&result.run_id!==snapshot.run_id) ||
      typeof snapshot.run_id!=='string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(snapshot.run_id) ||
      !Number.isFinite(checked) || !afterRequest || checked>now+60000)continue;
    const outcome=rejectedFailure||snapshot.outcome==='failure'?'failure':
      (snapshot.outcome===undefined||snapshot.outcome==='success')&&snapshot.complete===true?'success':null;
    const errorCode=rejectedFailure?rejection.error_code:snapshot.error_code;
    // A legacy idempotent receipt omits outcome, but confirms the submitted
    // snapshot's exact digest. An ordinary receipt must explicitly agree.
    if(!outcome || (result.outcome!==outcome && !(result.idempotent===true&&result.outcome===undefined)) ||
      (outcome==='failure'&&!ERRORS.includes(errorCode)))continue;
    const current=run.results?.[source];
    if(current && checked<=Date.parse(current.checked_at))continue;
    run.results ||= {};
    run.results[source]={outcome,checked_at:stamp(checked),...(outcome==='failure'?{error_code:errorCode}:{})};
    if(run.state==='queued')run.state='running';
  }
  finishManualRun(state);
}
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2,'0')).join('');
}
// Both inputs are SHA-256 hex strings. All 64 positions are always compared.
function sameDigest(a, b) {
  let difference = (typeof a === 'string' && a.length === 64 ? 0 : 1) | (typeof b === 'string' && b.length === 64 ? 0 : 1);
  for (let i=0;i<64;i++) difference |= (a?.charCodeAt(i)||0) ^ (b?.charCodeAt(i)||0);
  return difference === 0;
}
function credential(request) {
  const header = request.headers.get('Authorization') || '';
  return /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
}
function sameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin && request.headers.get('Sec-Fetch-Site') === 'same-origin';
}
async function body(request, max = 4096) {
  if ((request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase() !== 'application/json') throw fault('json_required',415);
  if (Number(request.headers.get('Content-Length')) > max) throw fault('request_too_large',413);
  const reader=request.body?.getReader(); if (!reader) throw fault('invalid_json');
  let size=0, text='',complete=false; const decoder=new TextDecoder();
  let rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const abort=()=>rejectStop(fault('request_aborted',408));
  const timer=setTimeout(()=>rejectStop(fault('request_timeout',408)),15000);
  request.signal.addEventListener('abort',abort,{once:true});
  try {
    if(request.signal.aborted)throw fault('request_aborted',408);
    while (true) {
      let item;
      try {item=await Promise.race([reader.read(),stopped]);}
      catch(error){throw error?.status?error:fault('request_aborted',408);}
      if(item.done){complete=true;break;}
      size+=item.value.byteLength;
      if(size>max)throw fault('request_too_large',413);
      text+=decoder.decode(item.value,{stream:true});
    }
    try {const value=JSON.parse(text+decoder.decode());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
    catch {throw fault('invalid_json');}
  } finally {
    clearTimeout(timer);request.signal.removeEventListener('abort',abort);
    // A stalled sender/cancel hook must not hold all phone operations behind
    // this serialized request. No state is committed before the full body.
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export function isPhoneMachinePath(path) {return MACHINE_PATHS.has(path);}
export function isPhoneUserPath(path) {return USER_PATHS.has(path);}

export class FleetPhoneAgent {
  constructor({storage, ingest, registryStatus, registry=null, now=Date.now}) {Object.assign(this,{storage,ingest,registryStatus,now});this.pending=Promise.resolve();this.reverse=registry?new ReverseSync({storage,registry,registryStatus,now}):null;}
  exclusive(work) {const result=this.pending.then(work);this.pending=result.catch(()=>{});return result;}
  machine(request) {return this.exclusive(()=>this.machineRequest(request));}
  user(request,actionOverride=null) {return this.exclusive(()=>this.userRequest(request,actionOverride));}
  async selected() {return (await this.storage.get(PHONE_AGENT_KEY))?.mode === 'phone';}
  async publicStatus() {
    const [saved, registry, active] = await Promise.all([this.storage.get(PHONE_AGENT_KEY),this.registryStatus(),this.storage.get('browser-sync:active')]);
    const s=saved||initial();
    return {ok:true,mode:'phone',paired:!!s.token_hash,name:s.name,paired_at:s.paired_at,last_seen:s.last_seen,
      online:!!s.token_hash && !!s.last_seen && this.now()-Date.parse(s.last_seen)<180000,
      state:s.state,enabled:!!s.token_hash&&s.enabled,next_run_at:s.enabled?s.next_run_at:null,
      requested_run_id:s.requested_run_id,pairing_expires_at:s.pairing?stamp(s.pairing.expires_at):null,
      manual_run:publicManualRun(s.manual_run),health:summarizeSyncHealth(s.health,this.now()),
      legacy_session:active?{kind:active.kind,source:active.source,phase:active.phase,deadline_at:stamp(active.deadlineAt)}:null,
      order_sync:registry};
  }
  async dataStatus(original) {
    if(!await this.selected())return original;
    const s=await this.publicStatus();
    return {...original,automatic_enabled:s.enabled,next_attempt_at:s.next_run_at,manual_pending:!!s.requested_run_id,
      cloud:{},agent:{paired:s.paired,online:s.online,last_seen:s.last_seen,state:s.state},voltage:currentVoltageBoats(await this.storage.get(VOLTAGE_KEY))||null};
  }
  async createCode() {
    const code=Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
    const codeHash=await digest(code), expires=this.now()+CODE_TTL;
    await this.storage.transaction(async tx=>{
      // Read the same durable reservation as the cloud browser launcher. Do not
      // kill or silently abandon an existing browser session during migration.
      if(await tx.get('browser-sync:active'))throw fault('legacy_session_active',409);
      await tx.put(PHONE_AGENT_KEY,{...initial(),pairing:{hash:codeHash,expires_at:expires,attempts:0}});
      const old=await tx.get('cloud-sync:config')||{};
      await tx.put('cloud-sync:config',{...old,enabled:false,nextAttemptAt:null,manualPending:false,manualNotBefore:null});
    });
    await this.storage.deleteAlarm();
    return {ok:true,pairing_code:code,expires_at:stamp(expires),previous_device_revoked:true};
  }
  async pair(request) {
    if(request.method!=='POST')return response({error:'method_not_allowed'},405);
    // Public pairing only accepts the one-time out-of-band code. No browser
    // cookies are accepted as machine authentication and no CORS is enabled.
    if(request.headers.has('Origin') || request.headers.has('Sec-Fetch-Site'))return response({error:'machine_request_required'},403);
    const token=credential(request); if(!token)return response({error:'invalid_credential'},401);
    const input=await body(request);
    if(typeof input.pairing_code!=='string'||input.pairing_code.length>128||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\x7f]/.test(input.name))throw fault('invalid_pairing_request');
    const codeHash=await digest(input.pairing_code), tokenHash=await digest(token);
    const result=await this.storage.transaction(async tx=>{
      const state=await tx.get(PHONE_AGENT_KEY), pair=state?.pairing;
      if(!pair||pair.expires_at<=this.now()||pair.attempts>=MAX_ATTEMPTS)return {error:'pairing_unavailable',status:401};
      if(!sameDigest(pair.hash,codeHash)){
        pair.attempts++; if(pair.attempts>=MAX_ATTEMPTS)state.pairing=null;
        await tx.put(PHONE_AGENT_KEY,state);return {error:'pairing_unavailable',status:401};
      }
      if(await tx.get('browser-sync:active'))return {error:'legacy_session_active',status:409};
      await tx.put(PHONE_AGENT_KEY,{...state,token_hash:tokenHash,pairing:null,name:input.name.trim(),
        paired_at:stamp(this.now()),last_seen:stamp(this.now()),enabled:false,state:'idle'});
      return {ok:true,paired:true,enabled:false};
    });
    const {status,...payload}=result;return response(payload,status||200);
  }
  async authenticate(request) {
    if(request.headers.has('Origin')||request.headers.has('Sec-Fetch-Site'))throw fault('machine_request_required',403);
    const token=credential(request);if(!token)throw fault('unauthorized',401);
    const tokenHash=await digest(token), current=await this.storage.get(PHONE_AGENT_KEY);
    if(!sameDigest(current?.token_hash,tokenHash))throw fault('unauthorized',401);
    return tokenHash;
  }
  async updateAuthenticated(tokenHash, work) {
    return this.storage.transaction(async tx=>{
      const state=await tx.get(PHONE_AGENT_KEY);
      if(!sameDigest(state?.token_hash,tokenHash))throw fault('unauthorized',401);
      const result=work(state);state.last_seen=stamp(this.now());await tx.put(PHONE_AGENT_KEY,state);return result;
    });
  }
  async machineRequest(request) {
    const path=new URL(request.url).pathname;
    try {
      if(!MACHINE_PATHS.has(path))return response({error:'not_found'},404);
      if(path==='/api/agent/pair')return await this.pair(request);
      const hash=await this.authenticate(request);
      if(path==='/api/agent/reverse-plan') {
        if(request.method!=='GET')return response({error:'method_not_allowed'},405);
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        await this.updateAuthenticated(hash,()=>null);
        return response(await this.reverse.machinePlan());
      }
      if(path==='/api/agent/poll') {
        if(request.method!=='GET')return response({error:'method_not_allowed'},405);
        return response(await this.updateAuthenticated(hash,s=>({ok:true,enabled:s.enabled,next_run_at:s.enabled?s.next_run_at:null,requested_run_id:s.requested_run_id})));
      }
      if(request.method!=='POST')return response({error:'method_not_allowed'},405);
      if(path==='/api/agent/reverse-report') {
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        const input=await body(request,64*1024);
        await this.updateAuthenticated(hash,()=>null);
        return response(await this.reverse.report(input));
      }
      if(path==='/api/agent/voltage') {
        // Up to 100 validated devices, including 80-character movement text.
        // Keep a byte cap while allowing the complete schema-valid snapshot.
        const input=normalizeVoltage(await body(request,128*1024),this.now());
        await this.storage.transaction(async tx=>{
          const state=await tx.get(PHONE_AGENT_KEY);
          if(!sameDigest(state?.token_hash,hash))throw fault('unauthorized',401);
          const previous=await tx.get(VOLTAGE_KEY);
          await tx.put(VOLTAGE_KEY,mergeVoltage(previous,input));
        });
        return response({ok:true});
      }
      if(path==='/api/agent/order-sync') {
        const payload=await body(request,MAX_ORDER_BYTES);
        if(payload.requested_run_id!==undefined&&!validRunId(payload.requested_run_id))throw fault('invalid_run_id');
        const {requested_run_id:requestedId,...legacyPayload}=payload;
        // Recheck the current token after reading the bounded body. The original
        // registry owns normalization, cancellation overrides and replay checks.
        await this.updateAuthenticated(hash,()=>null);
        const receipt=await this.ingest(legacyPayload);
        await this.updateAuthenticated(hash,s=>{associateManualReceipts(s,requestedId,legacyPayload,receipt,this.now());s.health=recordSyncHealth(s.health,legacyPayload,receipt,this.now());});
        return response(receipt,receipt.results.every(result=>result.accepted)?200:207);
      }
      const input=await body(request);
      if(input.state!==undefined&&!['idle','running','needs_login'].includes(input.state))throw fault('invalid_state');
      if(input.completed!==undefined&&typeof input.completed!=='boolean')throw fault('invalid_completed');
      if(input.requested_run_id!==undefined&&!validRunId(input.requested_run_id))throw fault('invalid_run_id');
      return response(await this.updateAuthenticated(hash,s=>{
        // A prior request's delayed heartbeat, or a retry after its first ACK,
        // is liveness only. It must not overwrite a newer run's state/schedule.
        // Ignore its stale schedule before time-window validation so an offline
        // ACK retry can terminate harmlessly instead of retrying forever.
        if(input.requested_run_id&&(s.manual_run?
          s.manual_run.id!==input.requested_run_id||s.manual_run.completed_at:
          s.requested_run_id!==input.requested_run_id))
          return {ok:true,enabled:s.enabled,requested_run_id:s.requested_run_id,next_run_at:s.enabled?s.next_run_at:null};
        let next;
        if(input.next_run_at!==undefined) {
          next=Date.parse(input.next_run_at);
          if(!Number.isFinite(next)||next<this.now()-60000||next>this.now()+PHONE_INTERVAL_MS+60000)throw fault('invalid_next_run_at');
        }
        if(input.completed&&input.requested_run_id&&s.requested_run_id===input.requested_run_id)s.requested_run_id=null;
        if(input.requested_run_id&&s.manual_run?.id===input.requested_run_id){
          const run=s.manual_run;
          if(input.completed){
            run.completed_at ||= stamp(this.now());
            if(run.state!=='completed')run.state='awaiting_upload';
            finishManualRun(s);
          }else if(input.state==='running'&&run.state==='queued')run.state='running';
        }
        if(input.state)s.state=input.state;
        if(input.completed)promoteHoldRun(s);
        // The phone owns the three-hour schedule. Keep its last report while
        // paused, including a manual run's new due time, but do not expose a
        // paused plan as active. Enabling alone cannot invent a due time.
        if(next!==undefined)s.next_run_at=stamp(next);
        return {ok:true,enabled:s.enabled,requested_run_id:s.requested_run_id,next_run_at:s.enabled?s.next_run_at:null};
      }));
    } catch(error) {return response({error:error.status?error.message:'agent_operation_failed'},error.status||503);}
  }
  async userRequest(request, actionOverride=null) {
    const path=actionOverride||new URL(request.url).pathname;
    try {
      if(path==='/api/reverse-sync/preview') {
        if(request.method!=='GET')return response({error:'method_not_allowed'},405);
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        return response(await this.reverse.preview());
      }
      if(path==='/api/reverse-sync/boataround-holds'&&request.method==='GET'){
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        return response(await this.reverse.holds());
      }
      if(path==='/api/reverse-sync/fleet-holds'&&request.method==='GET'){
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        return response(await this.storage.transaction(async tx=>publicManualOrders(await tx.get(MANUAL_ORDERS_KEY),await tx.get(FLEET_HOLDS_KEY),this.now()).fleet_control));
      }
      if(path==='/api/manual-orders'&&request.method==='GET')return response(await this.storage.transaction(async tx=>publicManualOrders(await tx.get(MANUAL_ORDERS_KEY),await tx.get(FLEET_HOLDS_KEY),this.now())));
      if(path==='/api/agent/status'&&request.method==='GET')return response(await this.publicStatus());
      if(!USER_PATHS.has(path))return response({error:'not_found'},404);
      if(request.method!=='POST')return response({error:'method_not_allowed'},405);
      if(!sameOrigin(request))return response({error:'same_origin_required'},403);
      const input=await body(request);
      if(path==='/api/manual-orders'){
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        const result=await this.storage.transaction(async tx=>{
          const s=await tx.get(PHONE_AGENT_KEY)||initial();
          if(!s.token_hash)throw fault('phone_not_paired',409);
          const change=mutateManualOrders(await tx.get(MANUAL_ORDERS_KEY),await tx.get(FLEET_HOLDS_KEY),await tx.get(BOATAROUND_HOLDS_KEY),input,this.now());
          const queue=change.changed?queueHoldRun(s,this.now()):{status:s.followup_run?'queued_after_current':s.requested_run_id?'queued':'idle',requested_run_id:s.followup_run?.id||s.requested_run_id||null};
          await tx.put(MANUAL_ORDERS_KEY,change.state);await tx.put(FLEET_HOLDS_KEY,change.holds);await tx.put(PHONE_AGENT_KEY,s);
          return {...publicManualOrders(change.state,change.holds,this.now()),status:'saved_pending_sync',idempotent:change.idempotent,queue};
        });
        return response(result,202);
      }
      if(path==='/api/reverse-sync/boataround-holds'||path==='/api/reverse-sync/fleet-holds'){
        if(!this.reverse)return response({error:'reverse_unavailable'},503);
        const fleetScope=path==='/api/reverse-sync/fleet-holds',key=fleetScope?FLEET_HOLDS_KEY:BOATAROUND_HOLDS_KEY;
        const result=await this.storage.transaction(async tx=>{
          const s=await tx.get(PHONE_AGENT_KEY)||initial();
          if(!s.token_hash)throw fault('phone_not_paired',409);
          const manual=readManualOrders(await tx.get(MANUAL_ORDERS_KEY));
          if(input.action==='add'&&manual.orders.some(o=>o.id===input.request_id))throw fault('hold_identity_conflict',409);
          if(fleetScope&&input.action==='remove'&&manual.orders.some(o=>o.id===input.id))throw fault('manual_order_cancel_required',409);
          const other=readHoldState(await tx.get(fleetScope?BOATAROUND_HOLDS_KEY:FLEET_HOLDS_KEY));
          if(input.action==='add'&&other.holds.some(h=>h.id===input.request_id))throw fault('hold_identity_conflict',409);
          const change=(fleetScope?mutateFleetHolds:mutateHolds)(await tx.get(key),input,this.now());
          let queue={status:s.followup_run?'queued_after_current':s.requested_run_id?'queued':'idle',requested_run_id:s.followup_run?.id||s.requested_run_id||null};
          if(change.changed)queue=queueHoldRun(s,this.now());
          await tx.put(key,change.state);
          await tx.put(PHONE_AGENT_KEY,s);
          return {...(fleetScope?publicFleetHolds:publicHolds)(change.state,this.now()),...(fleetScope?{manual_order_ids:manual.orders.map(o=>o.id)}:{}),status:'saved_pending_sync',operation_revision:change.operation_revision,idempotent:change.idempotent,queue};
        });
        return response(result,202);
      }
      if(path==='/api/agent/pairing-code')return response(await this.createCode());
      if(path==='/api/agent/status')return response({error:'method_not_allowed'},405);
      const result=await this.storage.transaction(async tx=>{
        const s=await tx.get(PHONE_AGENT_KEY)||initial();
        if(path==='/api/agent/revoke') {await tx.put(PHONE_AGENT_KEY,initial());return {ok:true};}
        if(!s.token_hash)throw fault('phone_not_paired',409);
        if(path==='/api/agent/run') {
          // Coalesce repeated button clicks until the phone acknowledges this id.
          s.requested_run_id ||= crypto.randomUUID();
          if(s.manual_run?.id!==s.requested_run_id)s.manual_run={id:s.requested_run_id,state:'queued',requested_at:stamp(this.now()),completed_at:null,results:{}};
          await tx.put(PHONE_AGENT_KEY,s);
          return {ok:true,status:'queued',requested_run_id:s.requested_run_id,requested_at:s.manual_run.requested_at};
        }
        if(typeof input.enabled!=='boolean')throw fault('enabled_required');
        s.enabled=input.enabled;
        await tx.put(PHONE_AGENT_KEY,s);return {ok:true,enabled:s.enabled};
      });
      return response(result,path==='/api/agent/run'?202:200);
    }catch(error){return response({error:error.status?error.message:'agent_operation_failed',...(error.message==='hold_revision_conflict'&&Number.isSafeInteger(error.revision)?{revision:error.revision}:{})},error.status||503);}
  }
}
