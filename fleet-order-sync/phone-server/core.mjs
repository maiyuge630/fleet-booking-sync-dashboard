import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';

// MMK became the fourth order source on 2026-10-04 and NauSYS the fifth on
// 2026-10-09 (user decisions).
export const SOURCES = ['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys'];
export const INTERVAL = 3 * 60 * 60 * 1000;
const OUTBOX_MAX_BACKOFF = 6 * 60 * 60 * 1000;
const PERMANENT_UPLOAD_STATUSES = new Set([400,413,415,422]);
const MANUAL_RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const WORKER_ORIGIN = 'https://your-worker.example.workers.dev';
export function parseNativeCdpPort(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{3,4}$/.test(value)) throw fault('invalid_native_cdp_port');
  const port=Number(value);
  if (port < 1024 || port > 65535) throw fault('invalid_native_cdp_port');
  return port;
}
const ERROR_CODES = new Set(['auth_required', 'fetch_failed', 'schema_changed', 'incomplete_pages', 'challenge_required']);
const COLLECTOR_DIAGNOSTIC_STAGES=new Set(['list_navigation','raw_document','list_ready','list_reconcile','detail_navigation','detail_ready','detail_parse','final_recheck','login_recovery']);
const RUNTIME_DIAGNOSTIC_STAGES=new Set(['native_prepare','page_create','snapshot_validate']);
const DIAGNOSTIC_REASONS=new Set(['progress','complete','timeout','auth_required','fetch_failed','schema_changed','incomplete_pages','challenge_required',
  'login_redirect','http_401','http_status','unexpected_content_type','tab_controls_changed','unknown_list_control','account_unverified']);
const MAX_MANAGED_PAGES = 8;
// An unfinished platform login holds the collection lock. It must not stop
// every platform's synchronization forever (observed 2026-09-29): release it
// and close its page after this long.
export const LOGIN_SESSION_MAX_MS = 30 * 60 * 1000;
// The pinned Puppeteer CDP Target exposes the protocol target identity here.
// Never substitute a URL/name match when a target identity is unavailable.
function nativeTargetId(target) {
  const id=target?._targetId;
  return typeof id==='string'&&/^[A-Fa-f0-9]{32}$/.test(id)?id:null;
}
export const failureCode = error => ERROR_CODES.has(error?.code) ? error.code : error?.name === 'OrderParseError' ? 'schema_changed' : 'fetch_failed';
export function fault(code) { return Object.assign(new Error(code), {code}); }
export function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  await fs.chmod(directory, 0o700);
}
export async function writeJSON(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let committed=false;
  try {
    // Flush the data before the rename, so a sudden power loss or reboot
    // cannot leave an empty or truncated ledger/state file behind.
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {mode:0o600});
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, filename);
    committed=true;
  } finally {
    // A failed write/rename must not accumulate partial temporary files. Only
    // this call's generated path is eligible; preserve the original error.
    if(!committed)await fs.unlink(temporary).catch(()=>{});
  }
}
export async function readJSON(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function loadConfiguration(home) {
  await privateDirectory(home);
  const filename = path.join(home, 'config.json');
  let config = await readJSON(filename, null);
  if (!config) {
    config = {version:1, name:'一加手机服务器', worker_origin:WORKER_ORIGIN,
      device_token:randomBytes(32).toString('base64url'), admin_user:'admin',
      admin_password:randomBytes(24).toString('base64url'), vnc_password:randomBytes(6).toString('base64url'), paired:false};
    await writeJSON(filename, config);
  }
  if (!config.vnc_password) {config.vnc_password=randomBytes(6).toString('base64url');await writeJSON(filename,config);}
  if (config.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(config.device_token) || !/^[A-Za-z0-9_-]{8}$/.test(config.vnc_password) ||
      typeof config.admin_password !== 'string' || config.admin_password.length < 24 ||
      config.worker_origin !== WORKER_ORIGIN) throw fault('invalid_private_config');
  await fs.chmod(filename, 0o600);
  return config;
}

export class WorkerClient {
  constructor(config, fetchImpl = fetch) { this.config=config; this.fetch=fetchImpl; }
  async request(route, body, method='POST', {signal}={}) {
    const controller=new AbortController();let response,reader,readComplete=false,cancelled=false,stoppedError=null,rejectStopped;
    const stopped=new Promise((_,reject)=>{rejectStopped=reject;});
    // A pre-aborted caller has no fetch/read race yet. Always own this rejection.
    stopped.catch(()=>{});
    const stop=name=>{
      if(stoppedError)return;
      stoppedError=new DOMException(name==='TimeoutError'?'Worker request timed out':'Worker request aborted',name);
      controller.abort(stoppedError);rejectStopped(stoppedError);
    };
    const ensureActive=()=>{if(stoppedError)throw stoppedError;};
    const cancelBody=()=>{
      const target=reader||response?.body;if(!target||cancelled)return;cancelled=true;
      // A response's cancellation is cleanup, not another unbounded network wait.
      try{Promise.resolve(target.cancel()).catch(()=>{});}catch{}
    };
    const onAbort=()=>stop('AbortError');
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    const timer=setTimeout(()=>stop('TimeoutError'),30000);timer.unref?.();
    try {
      ensureActive();
      const fetching=Promise.resolve().then(()=>{
        ensureActive();
        return this.fetch(WORKER_ORIGIN + '/api/agent/' + route, {
          method,headers:{Authorization:'Bearer '+this.config.device_token,'Content-Type':'application/json'},
          body:method==='GET'?undefined:JSON.stringify(body||{}),redirect:'error',signal:controller.signal
        });
      }).then(value=>{
        response=value;
        // Fetch implementations may finish after abort. Never parse that late body.
        if(stoppedError)cancelBody();
        return value;
      });
      await Promise.race([fetching,stopped]);ensureActive();
      if (![200,201,207].includes(response.status)) {
        throw Object.assign(fault(response.status===401||response.status===403?'device_auth_required':'worker_unavailable'),{status:response.status});
      }
      if(!response.body)throw fault('worker_response_invalid');
      reader=response.body.getReader();const chunks=[];let bytes=0;
      for(;;){
        const {done,value}=await Promise.race([Promise.resolve().then(()=>{ensureActive();return reader.read();}),stopped]);ensureActive();
        if(done){readComplete=true;break;}
        bytes+=value.byteLength;
        // Enforce the response limit while streaming. Checking after text()
        // already allocated the entire response can exhaust the phone's RAM.
        if(bytes>1024*1024)throw fault('worker_response_invalid');
        chunks.push(value);
      }
      const text=Buffer.concat(chunks,bytes).toString('utf8');
      let result;try{result=JSON.parse(text);}catch{throw fault('worker_response_invalid');}
      return result;
    } finally {
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      if(!readComplete){cancelBody();controller.abort();}
      try{reader?.releaseLock();}catch{}
    }
  }
  pair(pairing_code) { return this.request('pair', {pairing_code, name:this.config.name}); }
  poll() { return this.request('poll', null, 'GET'); }
  upload(payload) { return this.request('order-sync', payload); }
  heartbeat(body) { return this.request('heartbeat', body); }
}

// Accepted is an order state, not a verified customer payment. An active CB
// order needs either the website's payment evidence or, since 2026-09-29 (user
// decision), the official app's Accepted label; anything else fails closed.
export function requirePaymentEvidence(source, snapshot) {
  if (source === 'clickandboat' && snapshot.orders.some(order =>
      ['accepted','paid','deposit_paid'].includes(order.status) &&
      !(order.customer_payment_verified === true && Number.isFinite(order.customer_paid_amount) && order.customer_paid_amount > 0) &&
      !(order.status === 'accepted' && order.payment_basis === 'platform_accepted' && String(order.platform_status||'').trim().toUpperCase() === 'ACCEPTED'))) {
    throw fault('schema_changed');
  }
  // MMK (user decision 2026-10-04): a Reservation or Option with a customer
  // counts without payment. It must carry exactly that basis and label.
  if (source === 'mmk' && snapshot.orders.some(order =>
      ['accepted','paid','deposit_paid'].includes(order.status) &&
      !(order.status === 'accepted' && order.payment_basis === 'mmk_client_assigned' && ['Reservation','Option'].includes(order.platform_status)))) {
    throw fault('schema_changed');
  }
  // NauSYS (user decision 2026-10-09): an agency's Reservation or Option.
  if (source === 'nausys' && snapshot.orders.some(order =>
      ['accepted','paid','deposit_paid'].includes(order.status) &&
      !(order.status === 'accepted' && order.payment_basis === 'nausys_agency' && ['Reservation','Option'].includes(order.platform_status)))) {
    throw fault('schema_changed');
  }
}

export class PhoneAgent {
  // pagelessSources: collectors that read an official app instead of a
  // browser page (Click&Boat since 2026-09-29). No browser is started for
  // them and they have no login page.
  constructor({home, config, remote, collectors, verifyAuth, platformUrls, browserFactory, nativeBrowserFactory=null, prepareNativeBrowser=null, nativeBackgroundLease=null, reverseSync=null, now=Date.now,platformTimeout=8*60*1000,pagelessSources=[]}) {
    Object.assign(this, {home,config,remote,collectors,verifyAuth,platformUrls,browserFactory,nativeBrowserFactory,prepareNativeBrowser,nativeBackgroundLease,reverseSync,now,platformTimeout});
    this.pagelessSources=new Set(pagelessSources);
    this.busy=false; this.polling=false; this.browser=null; this.nativeBrowser=null; this.loginSource=null; this.closed=false; this.managedPages=new Set();
    this.pollDiagnostics={last_poll_started_at:null,last_poll_finished_at:null,last_poll_success_at:null};
    this.pageOwnership=new Map();this.pendingPageClosures=new Set();this.closingPages=new Map();this.pageCreations=0;this.pendingDiagnosticWrites=new Set();
    this.state={version:1, enabled:false, next_run_at:null, last_run_at:null, last_contact_at:null,
      last_requested_run_id:null, remote_error:null, sources:Object.fromEntries(SOURCES.map(source => [source, {state:'needs_login', last_success_at:null, last_attempt_at:null}]))};
  }
  async init() {
    await privateDirectory(this.home);
    this.outbox=path.join(this.home,'outbox'); await privateDirectory(this.outbox);
    this.outboxQuarantine=path.join(this.home,'outbox-quarantine');await privateDirectory(this.outboxQuarantine);
    // This file is operational metadata, not the order outbox or reverse ledger.
    // Preserve a damaged file before resetting status conservatively; otherwise
    // one truncated write can make every supervised restart fail forever.
    const filename=path.join(this.home,'state.json');let raw,stored,damaged=false;
    try{raw=await fs.readFile(filename);}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(raw!==undefined){
      try{stored=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
      catch(error){if(!(error instanceof SyntaxError)&&error.code!=='ERR_ENCODING_INVALID_ENCODED_DATA')throw error;damaged=true;}
      // Never overwrite a newer schema during an accidental version rollback.
      if(stored?.version!==undefined&&stored.version!==1)throw fault('invalid_state');
      const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
      const states=new Set(['needs_login','ready','collecting','interrupted','awaiting_upload','synced','failed','rejected']);
      // A source added after this file was written (MMK 2026-10-04, NauSYS 2026-10-09) starts
      // fresh. Never treat its absence as damage: that would reset the file
      // and turn automatic collection off.
      if(record(stored)&&record(stored.sources))for(const source of SOURCES)
        if(!Object.hasOwn(stored.sources,source))stored.sources[source]={state:'needs_login',last_success_at:null,last_attempt_at:null};
      damaged ||= !record(stored)||stored.version!==1||typeof stored.enabled!=='boolean'||!record(stored.sources)||
        SOURCES.some(source=>!record(stored.sources[source])||!states.has(stored.sources[source].state));
      if(damaged){
        const backup=path.join(this.home,'state-recovery-'+createHash('sha256').update(raw).digest('hex')+'.json');
        let existing;
        try{existing=await fs.readFile(backup);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(existing!==undefined){if(!existing.equals(raw))throw fault('state_backup_conflict');}
        else{
          // Disk-full writes can leave partial files. Never publish one under
          // the final hash name: a later restart must be able to retry safely.
          const temporary=backup+'.'+randomUUID()+'.tmp';let committed=false;
          try{
            await fs.writeFile(temporary,raw,{flag:'wx',mode:0o600});
            await fs.rename(temporary,backup);committed=true;
          }finally{if(!committed)await fs.unlink(temporary).catch(()=>{});}
        }
        this.state.state_recovery={recovered_at:new Date(this.now()).toISOString(),reason:'invalid_local_state'};
      }else this.state=stored;
    }
    for (const source of SOURCES) if (this.state.sources[source]?.state === 'collecting') this.state.sources[source].state='interrupted';
    await this.saveState(); return this;
  }
  async saveState() {
    this.pendingSave=(this.pendingSave||Promise.resolve()).catch(()=>{}).then(()=>writeJSON(path.join(this.home,'state.json'),this.state));
    return this.pendingSave;
  }
  async drainDiagnosticWrites() {
    // Call only after the producing collection signal has been cancelled (or
    // close() has disabled every callback), so no new task can escape this
    // boundary. Include the whole coalescing loop, not just its current write.
    while(this.pendingDiagnosticWrites.size)await Promise.allSettled([...this.pendingDiagnosticWrites]);
  }
  async status() {
    this.refreshLoginSession();
    const pending=(await fs.readdir(this.outbox)).filter(name => name.endsWith('.json')).length;
    const quarantined=(await fs.readdir(this.outboxQuarantine)).filter(name=>name.endsWith('.json')).length;
    return {...this.state, paired:this.config.paired, busy:this.busy, login_source:this.loginSource, pending_uploads:pending,
      runtime:{polling:this.polling,...this.pollDiagnostics},
      quarantined_uploads:quarantined,local_error:quarantined?'outbox_corrupt':null};
  }
  usesNativeBrowser(source) {return ['boataround','samboat','mmk','nausys'].includes(source) && typeof this.nativeBrowserFactory === 'function';}
  refreshLoginSession() {
    if(!this.loginSource)return false;
    const page=this.loginPage;
    const browser=this.usesNativeBrowser(this.loginSource)?this.nativeBrowser:this.browser;
    let pageClosed=false;
    try {pageClosed=page?.isClosed?.()===true;}catch{}
    const expired=Number.isFinite(this.loginStartedAt)&&this.now()-this.loginStartedAt>LOGIN_SESSION_MAX_MS;
    // A live or unverified login page still belongs to the user's login flow,
    // until it closes, its browser disconnects, or it is left unfinished too long.
    if(!pageClosed && browser?.connected!==false && !expired)return false;
    this.loginPage=null;this.loginSource=null;this.loginStartedAt=null;
    if(expired && !pageClosed && browser?.connected!==false && page){void this.closeManagedPage(page).catch(()=>{});return true;}
    // A disconnected native page might still be open on the phone. Forget the
    // stale handle without issuing any close command against that browser.
    this.forgetManagedPage(page);
    return true;
  }
  forgetManagedPage(page) {
    this.managedPages.delete(page);this.pageOwnership.delete(page);this.pendingPageClosures.delete(page);
  }
  async createManagedPage(source,browser) {
    // Include in-flight newPage calls: a suspended Chrome may finish one after
    // its collection deadline. Such pages still belong to us and need cleanup.
    if(this.managedPages.size+this.pageCreations>=MAX_MANAGED_PAGES)throw fault('fetch_failed');
    this.pageCreations++;
    try {
      const page=await browser.newPage();this.managedPages.add(page);
      let targetId=null;try{targetId=nativeTargetId(page.target?.());}catch{}
      this.pageOwnership.set(page,{native:this.usesNativeBrowser(source),browser,targetId});
      // Boataround's verified order table and availability UI need the desktop
      // layout. Apply it only to our newly created BA tab, for collection,
      // intentional login and reverse sync alike; never resize a user's tab.
      if(source==='boataround'&&this.usesNativeBrowser(source)){
        try{
          if(this.closed)throw fault('fetch_failed');
          await page.setViewport({width:1440,height:900});
          if(this.nativeBackgroundLease&&typeof page.createCDPSession==='function'){
            const session=await page.createCDPSession();
            try{await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});await session.send('Page.setWebLifecycleState',{state:'active'});}
            catch(error){await session.detach().catch(()=>{});throw error;}
            // Keep this page-owned session until the managed tab closes;
            // detaching immediately would discard its emulation state.
          }
          if(this.closed)throw fault('fetch_failed');
        }catch(error){await this.closeManagedPage(page);throw error;}
      }
      return page;
    } finally {this.pageCreations--;}
  }
  async closeManagedPage(page,{browser=null}={}) {
    if (!page || !this.managedPages.has(page)) return true;
    try {if(page.isClosed?.()===true){this.forgetManagedPage(page);return true;}}catch{}
    this.pendingPageClosures.add(page);
    const owner=this.pageOwnership.get(page);
    let closing=this.closingPages.get(page);
    // A command on a disconnected CDP socket can remain pending forever.
    // Coalesce within one connection, but let a recovered connection replace
    // that command and close our exact target without waiting for the old one.
    if(closing&&owner?.native&&browser?.connected===true&&browser!==closing.browser)closing=null;
    if(!closing){
      closing={browser:browser||owner?.browser||null,promise:null};
      closing.promise=(async()=>{
        try {
          let targetPage=page;
          if(owner?.native&&browser&&browser!==owner.browser){
            // Old Page handles cannot close targets after CDP disconnect. Use
            // only the exact target captured when this agent created the page.
            if(!owner.targetId||browser.connected!==true||typeof browser.targets!=='function')return false;
            const targets=browser.targets();
            if(!Array.isArray(targets))return false;
            const target=targets.find(value=>nativeTargetId(value)===owner.targetId);
            if(!target){this.forgetManagedPage(page);return true;}
            if(typeof target.page!=='function')return false;
            targetPage=await target.page();if(!targetPage)return false;
          }
          await targetPage.close();
          this.forgetManagedPage(page);return true;
        }catch{return false;}
      })();
      this.closingPages.set(page,closing);
      void closing.promise.finally(()=>{if(this.closingPages.get(page)===closing)this.closingPages.delete(page);});
    }
    let timer;
    try {return await Promise.race([
      closing.promise,
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000);timer.unref?.();})
    ]);} finally {clearTimeout(timer);}
  }
  async cleanPendingPages(browser,native,signal) {
    for(const page of [...this.pendingPageClosures]){
      if(this.closed||signal?.aborted)throw fault('fetch_failed');
      const owner=this.pageOwnership.get(page);
      if(owner&&owner.native!==native)continue;
      if(!await this.closeManagedPage(page,{browser}))throw fault('fetch_failed');
    }
  }
  async ensureBrowser(source, signal, forceWake=false) {
    if (this.closed || signal?.aborted) throw fault('fetch_failed');
    const native=this.usesNativeBrowser(source), key=native?'nativeBrowser':'browser';
    if(native&&forceWake&&this.nativeBrowser){
      // A suspended renderer can leave a CDP socket reporting connected after
      // every command times out. A wake retry must discover a fresh socket;
      // disconnect never closes Android Chrome or any of the user's tabs.
      const stale=this.nativeBrowser;this.nativeBrowser=null;
      await Promise.resolve().then(()=>stale.disconnect()).catch(()=>{});
      if(this.closed||signal?.aborted)throw fault('fetch_failed');
    }
    if(native && typeof this.prepareNativeBrowser === 'function') {
      // Android may suspend Chrome even while the cached CDP connection appears
      // connected. Prepare the local bridge/browser before every native use.
      await this.prepareNativeBrowser({source,signal,forceWake});
      if (this.closed || signal?.aborted) throw fault('fetch_failed');
    }
    if (!this[key]?.connected) {
      const browser=await (native?this.nativeBrowserFactory():this.browserFactory());
      // A connect/launch can finish after a platform deadline or service shutdown.
      // An externally owned Android Chrome must only ever be disconnected.
      if (this.closed || signal?.aborted) {
        if(native)await browser.disconnect();
        else await browser.close();
        throw fault('fetch_failed');
      }
      this[key]=browser;
    }
    await this.cleanPendingPages(this[key],native,signal);
    if(this.closed||signal?.aborted)throw fault('fetch_failed');
    return this[key];
  }
  async pair(code) {
    if (typeof code !== 'string' || code.length < 6 || code.length > 160) throw fault('invalid_pairing_code');
    const result=await this.remote.pair(code.trim());
    if (result.ok !== true) throw fault('pairing_failed');
    this.config.paired=true;
    await writeJSON(path.join(this.home,'config.json'), this.config);
    this.state.enabled=result.enabled===true;
    await this.saveState();
    return {ok:true};
  }
  async openLogin(source) {
    if (!SOURCES.includes(source) || this.pagelessSources.has(source)) throw fault('unknown_source');
    if (this.busy || this.polling) throw fault('busy');
    this.busy=true;
    let page;
    try {
      const browser=await this.ensureBrowser(source,undefined,true);
      if (this.loginPage && !await this.closeManagedPage(this.loginPage,{browser:this.pageOwnership.get(this.loginPage)?.native?this.nativeBrowser:this.browser})) throw fault('fetch_failed');
      // This explicit login action replaces the old session only once its
      // browser is available. A failed replacement must not leave a stale lock.
      this.loginPage=null;this.loginSource=null;
      page=this.loginPage=await this.createManagedPage(source,browser);
      if(this.closed)throw fault('fetch_failed');
      if (!this.usesNativeBrowser(source)) await page.setViewport({width:1440,height:900});
      await page.goto(this.platformUrls[source], {waitUntil:'domcontentloaded', timeout:45000});
      await page.bringToFront();
      this.loginSource=source;this.loginStartedAt=this.now();
      return {ok:true, source};
    } catch (error) {
      if (page) {
        if(this.loginPage===page){this.loginPage=null;this.loginSource=null;}
        await this.closeManagedPage(page);
      }
      throw error;
    } finally { this.busy=false; }
  }
  async finishLogin() {
    if (this.busy || this.polling) throw fault('busy');
    if (!this.loginPage || !this.loginSource) throw fault('no_login_page');
    this.busy=true;
    try {
      const source=this.loginSource;
      if (!await this.verifyAuth[source](this.loginPage)) throw fault('auth_required');
      this.state.sources[source]={...this.state.sources[source], state:'ready', last_error:null};
      this.loginSource=null;
      await this.saveState();
      return {ok:true,source};
    } finally { this.busy=false; }
  }
  async enqueue(snapshot, requestedRunId=null) {
    if (requestedRunId !== null && (typeof requestedRunId !== 'string' || !MANUAL_RUN_ID.test(requestedRunId))) throw fault('invalid_requested_run_id');
    const entry={version:1,payload:{schema_version:1,...(requestedRunId?{requested_run_id:requestedRunId}:{}),snapshots:[snapshot]},attempts:0,next_attempt_at:0};
    const name=randomUUID()+'.json';
    await writeJSON(path.join(this.outbox,name),entry);
  }
  /** Snapshots still waiting for the Worker: source, tries and collection time. */
  async pendingUploads() {
    const list=[];
    for(const name of (await fs.readdir(this.outbox)).filter(name=>name.endsWith('.json'))){
      let entry=null;try{entry=await readJSON(path.join(this.outbox,name),null);}catch{}
      const snapshot=entry?.payload?.snapshots?.[0];
      list.push({source:snapshot?.source??null,attempts:Number.isSafeInteger(entry?.attempts)?entry.attempts:0,
        refusals:Number.isSafeInteger(entry?.server_refusals)?entry.server_refusals:0,checked:Date.parse(snapshot?.checked_at)||0});
    }
    return list;
  }
  async flush({retrySource=null}={}) {
    if (this.closed || !this.config.paired) return;
    const files=(await fs.readdir(this.outbox)).filter(name => /^[a-f0-9-]+\.json$/.test(name));
    const entries=[];
    for (const name of files) {
      const file=path.join(this.outbox,name);let entry,invalid=false;
      try {entry=await readJSON(file,null);}catch(error){
        if(!(error instanceof SyntaxError))throw error; // IO failures are not corrupt contents.
        invalid=true;
      }
      const snapshot=entry?.payload?.snapshots?.[0];
      invalid ||= !entry || entry.version!==1 || entry.payload?.schema_version!==1 ||
        !Array.isArray(entry.payload?.snapshots) || entry.payload.snapshots.length!==1 ||
        !snapshot || !SOURCES.includes(snapshot.source) || typeof snapshot.checked_at!=='string' || !Number.isFinite(Date.parse(snapshot.checked_at)) ||
        (entry.payload.requested_run_id!==undefined && (typeof entry.payload.requested_run_id!=='string'||!MANUAL_RUN_ID.test(entry.payload.requested_run_id)));
      if(invalid){
        // Preserve the original bytes privately for diagnosis. A unique target
        // prevents one corrupt file from replacing an earlier quarantined copy.
        const destination=path.join(this.outboxQuarantine,name+'.'+randomUUID()+'.json');
        await fs.rename(file,destination);await fs.chmod(destination,0o600);
        continue;
      }
      // These fields only control local retries, not the financial snapshot.
      // Clock corrections can move an otherwise valid deadline past the current
      // maximum. Repair them atomically without quarantining the original data.
      const attempts=Number.isSafeInteger(entry.attempts)&&entry.attempts>=0?
        Math.min(entry.attempts,Number.MAX_SAFE_INTEGER-1):0;
      const nextAttempt=Number.isSafeInteger(entry.next_attempt_at)&&entry.next_attempt_at>=0?
        Math.min(entry.next_attempt_at,this.now()+OUTBOX_MAX_BACKOFF):0;
      if(entry.attempts!==attempts || entry.next_attempt_at!==nextAttempt){
        entry.attempts=attempts;entry.next_attempt_at=nextAttempt;
        await writeJSON(file,entry);
      }
      entries.push({file,entry,name});
    }
    entries.sort((a,b)=>Date.parse(a.entry.payload.snapshots[0].checked_at)-Date.parse(b.entry.payload.snapshots[0].checked_at)||a.name.localeCompare(b.name));
    const blockedSources=new Set();let attempted=0;
    // An older snapshot the Worker itself keeps refusing must not hold back a
    // newer one of the same source: the registry ignores older snapshots after
    // a newer one anyway. Set it aside (kept privately for diagnosis) after
    // three refusals. Network outages do not count: their queue drains in order.
    const newest=new Map(entries.map(({entry})=>[entry.payload.snapshots[0].source,Date.parse(entry.payload.snapshots[0].checked_at)]));
    // Entries are oldest first, so the last one per source is its newest.
    const heirs=new Map(entries.map(item=>[item.entry.payload.snapshots[0].source,item]));
    for(const item of entries){
      const snapshot=item.entry.payload.snapshots[0];
      if((item.entry.server_refusals||0)>=3&&Date.parse(snapshot.checked_at)<newest.get(snapshot.source)){
        // The newest snapshot inherits the refusals, so a source the Worker
        // keeps refusing still counts as stuck and calendar sync goes on
        // close-only (found 2026-10-09: with NauSYS collected after MMK, every
        // source but the first and last lost this history and stayed deferred).
        const heir=heirs.get(snapshot.source);
        if((heir.entry.server_refusals||0)<item.entry.server_refusals){heir.entry.server_refusals=item.entry.server_refusals;await writeJSON(heir.file,heir.entry);}
        const rejected=path.join(this.home,'rejected');await privateDirectory(rejected);
        await fs.rename(item.file,path.join(rejected,'superseded-'+path.basename(item.file)));item.superseded=true;
      }
    }
    for (const {file,entry,superseded} of entries) {
      if (this.closed || attempted >= 12) break;
      if (superseded) continue;
      const snapshot=entry.payload.snapshots[0], source=snapshot.source;
      if(blockedSources.has(source))continue;
      if (entry.next_attempt_at > this.now() && source!==retrySource) {blockedSources.add(source);continue;}
      attempted++;
      try {
        let receipt;
        try {receipt=await this.remote.upload(entry.payload);}
        catch(error) {
          // A whole-request validation/size rejection will never accept the
          // same immutable payload. Preserve it like a per-source rejection,
          // so it cannot strand every newer snapshot behind six-hour retries.
          // Auth, rate limits, outages and uncertain replies remain retryable.
          if(!PERMANENT_UPLOAD_STATUSES.has(error.status))throw error;
          receipt={results:[{source,accepted:false,status:error.status}]};
        }
        const result=receipt.results?.find(item => item.source === source);
        // The registry refuses a different snapshot under an already committed
        // run ID with 409 for good (e.g. a lost reply, then a Worker update that
        // normalizes differently). Retrying it would block this source forever.
        const runIdConflict=result?.accepted===false&&result.status===409&&/同一运行编号不能提交不同快照/.test(String(result.error||''));
        const permanentlyRejected=result?.accepted===false&&(PERMANENT_UPLOAD_STATUSES.has(result.status)||runIdConflict);
        if (!result || (result.accepted !== true && !(result.accepted === false && (result.ignored === 'older_snapshot' || permanentlyRejected)))) throw fault('invalid_receipt');
        const expectedOutcome=snapshot.outcome === 'failure' ? 'failure' : 'success';
        if(result.accepted&&!['success','failure'].includes(result.outcome)&&result.idempotent!==true)throw fault('invalid_receipt');
        if (result.accepted && result.outcome && result.outcome !== expectedOutcome) throw fault('invalid_receipt');
        if (result.accepted && (result.outcome === 'success' || (result.idempotent === true && expectedOutcome === 'success'))) {
          this.state.sources[source]={...this.state.sources[source],state:'synced',last_success_at:snapshot.checked_at,last_error:null};
        } else if (result.accepted) {
          this.state.sources[source]={...this.state.sources[source],state:snapshot.error_code==='auth_required'?'needs_login':'failed',last_error:snapshot.error_code};
        } else {
          this.state.sources[source]={...this.state.sources[source],state:'rejected',last_error:result.ignored==='older_snapshot'?'older_snapshot':'snapshot_rejected'};
        }
        await this.saveState();
        if(permanentlyRejected){
          const rejected=path.join(this.home,'rejected');await privateDirectory(rejected);
          await fs.rename(file,path.join(rejected,path.basename(file)));
        } else await fs.unlink(file);
        this.state.remote_error=null;
      } catch (error) {
        entry.attempts++;
        // The Worker answered but did not accept it (HTTP error or a refusing
        // receipt), as opposed to no answer at all.
        if(Number.isInteger(error?.status)&&error.status!==401&&error.status!==403&&error.status!==429||error?.code==='invalid_receipt')entry.server_refusals=(entry.server_refusals||0)+1;
        entry.next_attempt_at=this.now()+Math.min(OUTBOX_MAX_BACKOFF,30000 * 2**Math.min(entry.attempts,10));
        await writeJSON(file,entry);
        blockedSources.add(source);
        this.state.remote_error=error.code === 'device_auth_required'?'device_auth_required':'upload_failed';
        if (error.code === 'device_auth_required') break;
      }
    }
    await this.saveState();
  }
  async run({requestedRunId=null,fromTick=false,resumeReverse=false}={}) {
    if (this.closed) return {ok:false,reason:'closed'};
    if (this.busy || (this.polling && !fromTick)) return {ok:false,reason:'busy'};
    this.refreshLoginSession();
    if (this.loginSource) return {ok:false,reason:'login_in_progress'};
    if (requestedRunId !== null && (typeof requestedRunId !== 'string' || !MANUAL_RUN_ID.test(requestedRunId))) throw fault('invalid_requested_run_id');
    // Only a persisted deferred upload may request this continuation. The
    // normal manual/scheduled entry still collects every source. Leave at
    // least five minutes of the ten-minute evidence window for reverse work;
    // older or failed evidence must be collected again instead of bypassed.
    if(resumeReverse&&(!this.reverseSync||!this.state.reverse_pending_upload))return {ok:false,reason:'no_deferred_reverse'};
    const reverseOnly=resumeReverse&&SOURCES.every(source=>{
      const s=this.state.sources[source],stamp=Date.parse(s.last_success_at);
      return s.state==='synced'&&!s.last_error&&s.last_collected_at===s.last_success_at&&
        Number.isFinite(stamp)&&stamp<=this.now()+60000&&this.now()-stamp<=300000;
    });
    this.busy=true;
    const started=this.now();
    const runController=new AbortController();this.activeRunController=runController;
    let heartbeatPromise=null,releaseBackground=null;
    const heartbeat=()=>{
      if(this.closed||heartbeatPromise||!this.config.paired)return;
      heartbeatPromise=(async()=>{
        try{await this.remote.heartbeat({state:'running',...(requestedRunId?{requested_run_id:requestedRunId}:{})});this.state.last_contact_at=new Date(this.now()).toISOString();}
        catch{this.state.remote_error='heartbeat_failed';}
      })().finally(()=>{heartbeatPromise=null;});
    };
    const heartbeatTimer=setInterval(()=>void heartbeat(),60000);
    void heartbeat();
    try {
      if(this.nativeBackgroundLease)try{releaseBackground=await this.nativeBackgroundLease({signal:runController.signal});}catch{/* Existing wake fallback remains available without root. */}
      for (const source of reverseOnly?[]:SOURCES) {
        if(this.closed)throw fault('agent_closed');
        let page, timer, onAbort, timedOut=false, platformBrowser,attemptCount=0;
        const native=this.usesNativeBrowser(source),pageless=this.pagelessSources.has(source);
        const controller=new AbortController();
        this.activeCollectionController=controller;
        const sourceStarted=this.now(),attemptErrors=[];
        let diagnosticSaving=false,diagnosticDirty=false;
        const persistDiagnostic=()=>{
          diagnosticDirty=true;if(diagnosticSaving)return;
          diagnosticSaving=true;
          const pending=(async()=>{
            while(diagnosticDirty&&!this.closed){diagnosticDirty=false;await this.saveState();}
          })().catch(()=>{}).finally(()=>{diagnosticSaving=false;this.pendingDiagnosticWrites.delete(pending);});
          this.pendingDiagnosticWrites.add(pending);
        };
        const recordDiagnostic=(event,{signal=controller.signal,attempt=attemptCount,runtime=false}={})=>{
          if(this.closed||signal.aborted||!event||
            !(COLLECTOR_DIAGNOSTIC_STAGES.has(event.stage)||(runtime&&RUNTIME_DIAGNOSTIC_STAGES.has(event.stage)))||
            !DIAGNOSTIC_REASONS.has(event.reason))return;
          // Copy only fixed vocabulary and agent-generated metadata. These
          // local diagnostics must never retain messages, URLs or credentials.
          const diagnostic={at:new Date(this.now()).toISOString(),stage:event.stage,reason:event.reason,attempt,
            screen_mode:pageless?'official_app':native?(this.state.sources[source].screen_mode==='wake_fallback'?'wake_fallback':'background'):'dedicated_browser'};
          const state=this.state.sources[source],previous=state.last_diagnostic;
          if(previous?.stage===diagnostic.stage&&previous?.reason===diagnostic.reason&&previous?.attempt===diagnostic.attempt)return;
          state.last_diagnostic=diagnostic;
          state.diagnostic_trace=[...(state.diagnostic_trace||[]),diagnostic].slice(-24);
          persistDiagnostic();
        };
        const finishCollection=(outcome,error_code=null)=>{
          const state=this.state.sources[source];
          state.collection_history=[...(Array.isArray(state.collection_history)?state.collection_history:[]),{
            started_at:new Date(sourceStarted).toISOString(),finished_at:new Date(this.now()).toISOString(),
            duration_ms:Math.max(0,this.now()-sourceStarted),outcome,error_code,attempts:attemptCount,
            screen_mode:state.last_diagnostic?.screen_mode??(pageless?'official_app':native?'background':'dedicated_browser'),
            last_diagnostic:state.last_diagnostic??null,attempt_errors:attemptErrors.slice(-2)
          }].slice(-30);
        };
        try {
          this.state.sources[source]={...this.state.sources[source],state:'collecting',last_attempt_at:new Date(this.now()).toISOString(),last_diagnostic:null,diagnostic_trace:[]};
          await this.saveState();
          const deadlineAt=this.now()+this.platformTimeout;
          const attempt=async(forceWake,limit)=>{
            const attemptNumber=++attemptCount;
            const attemptController=new AbortController(),signal=AbortSignal.any([controller.signal,attemptController.signal]);
            const attemptDeadline=Math.min(deadlineAt,this.now()+limit);
            let attemptPage,attemptTimer,onAttemptAbort;
            const reportDiagnostic=event=>recordDiagnostic(event,{signal,attempt:attemptNumber});
            const reportRuntime=event=>recordDiagnostic(event,{signal,attempt:attemptNumber,runtime:true});
            const task=(async()=>{
              if(pageless)return this.collectors[source]({page:null,fromDay:beijingDay(this.now()-86400000),deadlineAt:attemptDeadline,signal,reportDiagnostic});
              reportRuntime({stage:'native_prepare',reason:'progress'});
              const browser=platformBrowser=await this.ensureBrowser(source,signal,forceWake);
              if(signal.aborted)throw fault('fetch_failed');
              reportRuntime({stage:'page_create',reason:'progress'});
              attemptPage=await this.createManagedPage(source,browser);
              if(signal.aborted||this.closed){void this.closeManagedPage(attemptPage);throw fault('fetch_failed');}
              page=attemptPage;
              if(!native)await attemptPage.setViewport({width:1440,height:900});
              if(signal.aborted||this.closed)throw fault('fetch_failed');
              // Collector scope is end > fromDay. Include today's checkout
              // orders because the boat stays unavailable through today.
              return this.collectors[source]({page:attemptPage,fromDay:beijingDay(this.now()-86400000),deadlineAt:attemptDeadline,signal,reportDiagnostic});
            })();
            try{return await Promise.race([task,new Promise((_,reject)=>{
              // The outer platform/shutdown boundary must also retire this
              // attempt's timer and callbacks even when a collector ignores
              // cancellation. Otherwise a stopped run lingers for minutes.
              onAttemptAbort=()=>reject(fault('fetch_failed'));
              signal.addEventListener('abort',onAttemptAbort,{once:true});
              if(signal.aborted)onAttemptAbort();
              attemptTimer=setTimeout(()=>{
              reportRuntime({stage:this.state.sources[source].last_diagnostic?.stage||'native_prepare',reason:'timeout'});
              attemptController.abort();reject(fault('fetch_failed'));
            },limit);})]);}
            catch(error){
              const state=this.state.sources[source];
              // Preserve a collector's more precise sanitized reason. Runtime
              // classification fills only a still-in-progress stage.
              if(state.last_diagnostic?.reason==='progress')reportRuntime({stage:state.last_diagnostic.stage,reason:failureCode(error)});
              if(!this.closed)attemptErrors.push({at:new Date(this.now()).toISOString(),attempt:attemptNumber,
                error_code:failureCode(error),last_diagnostic:state.last_diagnostic??null});
              throw error;
            }
            finally{clearTimeout(attemptTimer);if(onAttemptAbort)signal.removeEventListener('abort',onAttemptAbort);attemptController.abort();await this.closeManagedPage(attemptPage);}
          };
          const workflow=(async()=>{
            if(!native){
              if(source!=='clickandboat')return attempt(false,this.platformTimeout);
              try{return await attempt(false,this.platformTimeout);}
              catch(error){
                // Click&Boat collection is read-only. Discard the partial
                // attempt and re-read every list/detail on one fresh page.
                // Do not repeat auth/schema failures, uploads or reverse writes.
                if(controller.signal.aborted||this.closed||
                  failureCode(error)!=='fetch_failed'||deadlineAt-this.now()<10000)throw error;
                return attempt(false,Math.max(1,deadlineAt-this.now()));
              }
            }
            this.state.sources[source].screen_mode='background';
            // Both native collectors verify details and every list page again.
            // A cold bridge plus full collection can exceed two minutes.
            // Keep the existing total deadline and reserve time for one retry.
            try{return await attempt(false,Math.min(240000,this.platformTimeout));}
            catch(error){
              if(controller.signal.aborted||this.closed||failureCode(error)!=='fetch_failed'||typeof this.prepareNativeBrowser!=='function'||deadlineAt-this.now()<10000)throw error;
              this.state.sources[source].screen_mode='wake_fallback';await this.saveState();
              return attempt(true,Math.max(1,deadlineAt-this.now()));
            }
          })();
          const deadline=new Promise((_,reject)=>{
            // Shutdown is a collection boundary even if a platform ignores its
            // AbortSignal. Its late result must never upload or start reverse sync.
            onAbort=()=>reject(fault('fetch_failed'));
            controller.signal.addEventListener('abort',onAbort,{once:true});
            if(controller.signal.aborted)onAbort();
            timer=setTimeout(()=>{
              recordDiagnostic({stage:this.state.sources[source].last_diagnostic?.stage||'native_prepare',reason:'timeout'},{runtime:true});
              timedOut=true;controller.abort();
              if (!native) platformBrowser?.process?.()?.kill('SIGTERM');
              reject(fault('fetch_failed'));
            },this.platformTimeout);
          });
          const snapshot=await Promise.race([workflow,deadline]);
          if(this.closed)throw fault('agent_closed');
          recordDiagnostic({stage:'snapshot_validate',reason:'progress'},{runtime:true});
          if (snapshot.source !== source || snapshot.complete !== true || !Array.isArray(snapshot.orders)) throw fault('schema_changed');
          requirePaymentEvidence(source,snapshot);
          this.state.sources[source].last_collection={
            orders:snapshot.orders.length,
            active_orders:snapshot.orders.filter(order=>['paid','deposit_paid','accepted'].includes(order.status)).length,
            listed_count:snapshot.pagination?.listed_count??null,
            total_pages:snapshot.pagination?.total_pages??null,
            customer_payment_verified:snapshot.orders.filter(order=>order.customer_payment_verified===true).length
          };
          await this.enqueue(snapshot,requestedRunId);
          this.state.sources[source]={...this.state.sources[source],state:'awaiting_upload',last_error:null,last_collected_at:snapshot.checked_at};
          recordDiagnostic({stage:'snapshot_validate',reason:'complete'},{runtime:true});
          finishCollection('success');
        } catch (error) {
          // A stopped service has not completed this source. Keep the persisted
          // collecting marker for restart recovery instead of manufacturing a
          // platform failure or acknowledging a partly completed manual run.
          if(this.closed)throw fault('agent_closed');
          const error_code=failureCode(error);
          if(this.state.sources[source].last_diagnostic?.reason==='progress')recordDiagnostic({stage:this.state.sources[source].last_diagnostic.stage,reason:error_code},{runtime:true});
          await this.enqueue({source,run_id:randomUUID(),checked_at:new Date(this.now()).toISOString(),outcome:'failure',error_code},requestedRunId);
          this.state.sources[source]={...this.state.sources[source],state:error_code==='auth_required'?'needs_login':'failed',last_error:error_code};
          finishCollection('failure',error_code);
        } finally {
          clearTimeout(timer);
          if(onAbort)controller.signal.removeEventListener('abort',onAbort);
          controller.abort();
          if(this.activeCollectionController===controller)this.activeCollectionController=null;
          await this.closeManagedPage(page);
          // enqueue/save failures can exit before the normal save/flush path.
          // No diagnostic state write may outlive this collection boundary.
          await this.drainDiagnosticWrites();
          if(timedOut){
            if(native){
              if(platformBrowser)await Promise.resolve().then(()=>platformBrowser.disconnect()).catch(()=>{});
              if(this.nativeBrowser===platformBrowser)this.nativeBrowser=null;
            }else if(this.browser===platformBrowser)this.browser=null;
          }
        }
        await this.saveState();
        // Newly collected evidence deserves one bounded delivery opportunity,
        // even if an older snapshot was deferred during a previous outage.
        // Keep old-before-new order; the first failure still stops this source.
        // Only this source bypasses its old deadline, so later source flushes
        // and idle five-second polls cannot become an outage retry storm.
        await this.flush({retrySource:source});
      }
      if(this.closed)throw fault('agent_closed');
      if(this.reverseSync&&!this.loginSource) {
        // An unacknowledged snapshot can contain a new order or cancellation.
        // Never reconcile against the previous cloud snapshot while it waits
        // in the durable, idempotent outbox. tick resumes only after delivery.
        const pending=await this.pendingUploads();
        // Only a stable code is kept: exception text can contain URLs or data.
        const failed=error=>({state:'failed',error:/^[a-z][a-z0-9_]{2,60}$/.test(String(error?.message))?error.message:'reverse_failed',checked_at:new Date(this.now()).toISOString()});
        if(pending.length){
          this.state.reverse_pending_upload=true;
          this.state.reverse_sync={state:'awaiting_upload',checked_at:new Date(this.now()).toISOString()};
          // A snapshot the Worker keeps refusing used to stop calendar sync on
          // every platform (2026-10-04 review). Once a pending upload has
          // failed three times or is older than 30 minutes, add the protection
          // the cloud already knows about, close-only: nothing is opened until
          // every snapshot is delivered and a full run follows.
          const stuck=pending.some(p=>p.attempts>=3||p.refusals>=3||this.now()-p.checked>30*60000);
          if(stuck){
            try {this.state.reverse_sync={...await this.reverseSync(this,{closeOnly:true}),close_only_reason:'upload_pending'};}
            catch(error) {this.state.reverse_sync={...failed(error),close_only_reason:'upload_pending'};}
          }
        }else{
          this.state.reverse_pending_upload=false;
          try {this.state.reverse_sync=await this.reverseSync(this);}
          catch(error) {this.state.reverse_sync=failed(error);}
        }
        await this.saveState();
      }
      if(this.closed)throw fault('agent_closed');
      if(!reverseOnly){
        this.state.last_run_at=new Date(started).toISOString();
        this.state.next_run_at=new Date(this.now()+INTERVAL).toISOString();
      }
      if (requestedRunId) this.state.last_requested_run_id=requestedRunId;
      await this.saveState();
      clearInterval(heartbeatTimer);
      if(heartbeatPromise)await heartbeatPromise;
      if(this.closed)throw fault('agent_closed');
      if (this.config.paired) {
        try {
          await this.remote.heartbeat({...(requestedRunId?{requested_run_id:requestedRunId,completed:true}:{}),next_run_at:this.state.next_run_at,
            state:SOURCES.some(source=>this.state.sources[source].state==='needs_login')?'needs_login':'idle'});
        } catch { this.state.remote_error='heartbeat_failed'; await this.saveState(); }
      }
      return {ok:true};
    } catch(error) {
      if(this.closed)return {ok:false,reason:'closed'};
      throw error;
    } finally {
      clearInterval(heartbeatTimer);runController.abort();
      if(this.activeRunController===runController)this.activeRunController=null;
      try{await releaseBackground?.();}finally{this.busy=false;}
    }
  }
  async tick() {
    if (this.closed || this.polling || this.busy || !this.config.paired) return;
    this.refreshLoginSession();
    this.polling=true;
    try {
      let pollError=null,ran=false;
      try {
        // Receive fresh requests before working through any upload backlog.
        this.pollDiagnostics.last_poll_started_at=new Date(this.now()).toISOString();
        let result;
        try{result=await this.remote.poll();}
        finally{if(!this.closed)this.pollDiagnostics.last_poll_finished_at=new Date(this.now()).toISOString();}
        if(this.closed)return;
        if (result.ok !== true || typeof result.enabled !== 'boolean') throw fault('invalid_poll');
        this.state.last_contact_at=new Date(this.now()).toISOString();
        this.pollDiagnostics.last_poll_success_at=this.state.last_contact_at;
        this.state.remote_error=null; this.state.enabled=result.enabled;
        if(result.enabled && this.state.next_run_at!==null){
          const next=Date.parse(this.state.next_run_at),now=this.now();
          // A corrected system clock (or invalid persisted date) must not
          // suspend automatic collection for days. Retain a full interval,
          // persist it, and tolerate small clock adjustments without rerunning.
          if(!Number.isFinite(next)||next>now+INTERVAL+60000){
            this.state.next_run_at=new Date(now+INTERVAL).toISOString();
            await this.saveState();
          }
        }
        const request=result.requested_run_id;
        if (request && request === this.state.last_requested_run_id) {
          // A completed manual run may be retried after an extended outage. The
          // old schedule must not make the matching completion ACK invalid.
          const next=Date.parse(this.state.next_run_at),now=this.now();
          const schedule=Number.isFinite(next)&&next>=now-60000&&next<=now+INTERVAL+60000?{next_run_at:this.state.next_run_at}:{};
          await this.remote.heartbeat({requested_run_id:request,completed:true,...schedule,state:'idle'});
        } else if (request || (result.enabled && (!this.state.next_run_at || Date.parse(this.state.next_run_at)<=this.now()))) {
          try {ran=(await this.run({requestedRunId:request||null,fromTick:true})).ok===true;}
          catch(error){
            // A run that dies early (disk full, I/O error) never reached its
            // schedule update; without this the next 5-second tick restarted it
            // at once, over and over (2026-10-04 review). Set in memory first:
            // saving may be what failed.
            this.state.next_run_at=new Date(this.now()+15*60000).toISOString();
            this.state.run_error={at:new Date(this.now()).toISOString(),code:/^[A-Za-z][A-Za-z0-9_]{2,60}$/.test(String(error?.code||error?.message))?String(error.code||error.message):'run_failed'};
            throw error;
          }
        }
      } catch(error) {pollError=error.code==='device_auth_required'?'device_auth_required':'poll_failed';}
      // run flushes after each source. A failed command poll must not strand
      // results that have already been safely collected and persisted.
      if (!ran) await this.flush();
      if(!ran&&!pollError&&this.reverseSync&&this.state.enabled&&!this.loginSource&&this.state.reverse_pending_upload&&
        !(await fs.readdir(this.outbox)).some(name=>name.endsWith('.json'))){
        ran=(await this.run({fromTick:true,resumeReverse:true})).ok===true;
      }
      if (pollError) this.state.remote_error=pollError;
      await this.saveState();
    } catch(error) {this.state.remote_error=error.code==='device_auth_required'?'device_auth_required':'poll_failed';await this.saveState();}
    finally {this.polling=false;}
  }
  async close() {
    this.closed=true;
    this.activeRunController?.abort();
    this.activeCollectionController?.abort();
    await this.drainDiagnosticWrites();
    // Only login/collector pages created by this agent are ours to close.
    // Disconnect leaves the user's native Chrome and its other tabs running.
    await Promise.allSettled([...this.managedPages].map(page=>this.closeManagedPage(page)));
    const native=this.nativeBrowser, owned=this.browser;
    this.nativeBrowser=null;this.browser=null;
    await Promise.allSettled([Promise.resolve().then(()=>native?.disconnect()),Promise.resolve().then(()=>owned?.close())]);
  }
}
