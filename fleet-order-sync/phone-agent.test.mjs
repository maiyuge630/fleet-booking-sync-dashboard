import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {FleetPhoneAgent,isPhoneMachinePath,isPhoneUserPath,PHONE_AGENT_KEY,PHONE_INTERVAL_MS} from './phone-agent.mjs';
import {FleetCloudSync} from './cloud-runtime.mjs';
import {CloudBrowserController} from './cloud-browser.mjs';
import {FLEET} from './parsers.mjs';
const require=createRequire(import.meta.url);
const {createOrderRegistry}=require('./worker/dynamic-registry.cjs');
const {buildPhoneMaintenancePage}=require('./phone-agent-patch.cjs');
const {patchBookingConflicts}=require('./booking-conflicts-patch.cjs');
const {patchManualReschedule}=require('./manual-reschedule-patch.cjs');
const {patchManualUnavailability}=require('./manual-unavailability-patch.cjs');
const {patchOrderQueryFreshness}=require('./order-query-freshness-patch.cjs');
const {patchVoltage}=require('./voltage-patch.cjs');
const {patchReverse}=require('./reverse-sync/frontend-patch.cjs');
const origin='https://fixture.invalid',base=Date.parse('2026-09-10T08:00:00Z'),token='a'.repeat(43),other='b'.repeat(43);
class Storage {
  data=new Map();pending=Promise.resolve();alarm=null;
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.data.set(k,structuredClone(v));}
  async delete(k){this.data.delete(k);}
  async getAlarm(){return this.alarm;}
  async setAlarm(value){this.alarm=value;}
  async deleteAlarm(){this.alarm=null;}
  transaction(work){const out=this.pending.then(()=>work(this));this.pending=out.catch(()=>{});return out;}
}
function bucket(){const m=new Map();return {
  async get(k){const item=m.get(k);return item?{etag:item.etag,json:async()=>JSON.parse(item.text)}:null;},
  async put(k,text,options={}){const old=m.get(k),c=options.onlyIf;if(c instanceof Headers&&c.get('If-None-Match')==='*'&&old)return null;if(c&&!(c instanceof Headers)&&c.etagMatches!==old?.etag)return null;const etag=crypto.randomUUID();m.set(k,{text,etag});return {etag};},async delete(k){m.delete(k);}};}
function req(path,data,options={}){const headers=new Headers(options.user?{Origin:origin,'Sec-Fetch-Site':'same-origin'}:{});if(options.token!==false&&!options.user)headers.set('Authorization','Bearer '+(options.token||token));if(data!==undefined)headers.set('Content-Type','application/json');for(const[k,v]of Object.entries(options.headers||{})){v===null?headers.delete(k):headers.set(k,v);}return new Request(origin+path,{method:options.method||(data===undefined?'GET':'POST'),headers,...(data===undefined?{}:{body:typeof data==='string'?data:JSON.stringify(data)})});}
function harness(){const storage=new Storage();let now=base;const calls=[];const registry=createOrderRegistry({bucket:bucket(),normalizeBooking:(source,r)=>({...r,source}),fleetSpecs:FLEET.map(b=>({...b,boataround_slug:b.slug})),bootstrapMap:{boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[],mapping_updated_at:new Date(base-60000).toISOString()},now:()=>now});const agent=new FleetPhoneAgent({storage,now:()=>now,ingest:p=>{calls.push(p);return registry.ingestBatch(p);},registryStatus:()=>registry.status()});return {agent,storage,calls,registry,advance:n=>{now+=n;},time:()=>now};}
async function pair(h,credential=token){const code=await (await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).json();assert.ok(code.pairing_code);const r=await h.agent.machine(req('/api/agent/pair',{pairing_code:code.pairing_code,name:'OnePlus fixture'},{token:credential}));assert.equal(r.status,200);return code;}

test('reverse plan requires current paired machine credential and rejects browser-origin requests',async()=>{
  const h=harness();
  h.agent.reverse={machinePlan:async()=>({ok:true,targets:[]})};
  assert.equal((await h.agent.machine(req('/api/agent/reverse-plan'))).status,401);
  await pair(h);
  assert.equal((await h.agent.machine(req('/api/agent/reverse-plan',undefined,{token:other}))).status,401);
  assert.equal((await h.agent.machine(req('/api/agent/reverse-plan',{}))).status,405);
  assert.equal((await h.agent.machine(req('/api/agent/reverse-plan',undefined,{headers:{Origin:origin}}))).status,403);
  assert.deepEqual(await(await h.agent.machine(req('/api/agent/reverse-plan'))).json(),{ok:true,targets:[]});
});
test('pairing is unavailable without logged-in operator-created code and stores no plaintext',async()=>{const h=harness();assert.equal((await h.agent.machine(req('/api/agent/pair',{pairing_code:'x',name:'phone'}))).status,401);const code=await pair(h);const saved=JSON.stringify([...h.storage.data]);assert.ok(!saved.includes(code.pairing_code));assert.ok(!saved.includes(token));assert.equal((await h.agent.publicStatus()).enabled,false);assert.equal((await h.agent.publicStatus()).order_sync.latest_platform_success_at,null);});
test('codes are one-time including simultaneous pairing and expire after ten minutes',async()=>{const h=harness();const code=await(await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).json();const inputs=[token,other].map(t=>h.agent.machine(req('/api/agent/pair',{pairing_code:code.pairing_code,name:'phone'},{token:t})));assert.deepEqual((await Promise.all(inputs)).map(r=>r.status),[200,401]);const newer=await(await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).json();h.advance(600001);assert.equal((await h.agent.machine(req('/api/agent/pair',{pairing_code:newer.pairing_code,name:'phone'}))).status,401);});
test('five failed code attempts invalidate the code and malformed bearer never authenticates',async()=>{const h=harness();const c=await(await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).json();for(let i=0;i<5;i++)assert.equal((await h.agent.machine(req('/api/agent/pair',{pairing_code:'wrong',name:'phone'}))).status,401);assert.equal((await h.agent.machine(req('/api/agent/pair',{pairing_code:c.pairing_code,name:'phone'}))).status,401);await pair(h);for(const t of ['','x','a'.repeat(42),'a'.repeat(44),'a'.repeat(42)+'!'])assert.equal((await h.agent.machine(req('/api/agent/poll',undefined,{headers:{Authorization:'Bearer '+t}}))).status,401);});
test('new code revokes prior phone immediately and explicit revoke removes pending work',async()=>{const h=harness();await pair(h);await h.agent.user(req('/api/agent/run',{}, {user:true}));const newer=await(await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).json();assert.equal((await h.agent.machine(req('/api/agent/poll'))).status,401);assert.ok(newer.previous_device_revoked);await pair(h,other);assert.equal((await h.agent.machine(req('/api/agent/poll',undefined,{token:other}))).status,200);await h.agent.user(req('/api/agent/revoke',{}, {user:true}));assert.equal((await h.agent.machine(req('/api/agent/poll',undefined,{token:other}))).status,401);assert.equal((await h.agent.publicStatus()).requested_run_id,null);});
test('all operator mutations require same-origin JSON and cannot leak credentials through status',async()=>{const h=harness();for(const path of ['pairing-code','run','config','revoke'])for(const headers of [{Origin:null},{Origin:'https://evil.invalid'},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':null}])assert.equal((await h.agent.user(req('/api/agent/'+path,{}, {user:true,headers}))).status,403);await pair(h);const publicText=JSON.stringify(await h.agent.publicStatus());assert.ok(!publicText.includes('token_hash'));assert.ok(!publicText.includes('pairing_code'));for(const path of ['poll','heartbeat','order-sync'])assert.equal((await h.agent.machine(req('/api/agent/'+path,path==='poll'?undefined:{},{headers:{Origin:origin}}))).status,403);});
test('active cloud session blocks migration, and phone mode atomically pauses old plans',async()=>{const h=harness();const active={kind:'login',source:'boataround',deadlineAt:base+30000,sessionId:'PRIVATE_OLD_SESSION'};await h.storage.put('browser-sync:active',active);assert.equal((await h.agent.user(req('/api/agent/pairing-code',{}, {user:true}))).status,409);assert.deepEqual(await h.storage.get('browser-sync:active'),active);assert.equal(await h.storage.get(PHONE_AGENT_KEY),undefined);assert.ok(!JSON.stringify(await h.agent.publicStatus()).includes('PRIVATE_OLD_SESSION'));await h.storage.delete('browser-sync:active');await h.storage.put('cloud-sync:config',{enabled:true,manualPending:true,nextAttemptAt:base});await pair(h);const old=await h.storage.get('cloud-sync:config');assert.equal(old.enabled,false);assert.equal(old.manualPending,false);const controller=new CloudBrowserController({storage:h.storage,binding:{},puppeteer:{launch:()=>{throw Error("No launch allowed");},connect:()=>{throw Error("No connect allowed");}},now:h.time});const reserved=await controller._reserve('login','boataround');assert.equal(reserved.allowed,false);assert.equal(reserved.reason,'phone_sync_selected');});
test('legacy runtime endpoints and alarms cannot create browsers after phone selection',async()=>{const h=harness();await pair(h);let launches=0;const controller={closeExpiredSession:async()=>{},status:async()=>({active:null}),nextAlarmAt:async n=>n,startLogin:async()=>{launches++;},runSync:async()=>{launches++;}};const runtime=new FleetCloudSync({storage:h.storage,binding:{},controller,now:h.time,registryStatus:()=>h.registry.status(),ingest:()=>{throw Error();}});for(const path of ['login','run','config'])assert.equal((await runtime.handle(req('/api/cloud-sync/'+path,{source:'boataround',enabled:true},{user:true}))).status,409);await h.storage.put('cloud-sync:config',{enabled:true,manualPending:true,nextAttemptAt:base});await runtime.alarm();assert.equal(launches,0);assert.equal((await h.storage.get('cloud-sync:config')).enabled,false);});
test('switching during a no-browser cloud auth check cannot inject stale failures into phone state',async()=>{
 const h=harness();let started,release,ingests=0;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const controller={closeExpiredSession:async()=>{},status:async()=>({active:null}),nextAlarmAt:async n=>n,runSync:async()=>{started();await wait;return {status:'auth_required',sources:{}};}};
 const runtime=new FleetCloudSync({storage:h.storage,binding:{},controller,now:h.time,registryStatus:()=>h.registry.status(),ingest:()=>{ingests++;}});
 await h.storage.put('cloud-sync:config',{enabled:true,manualPending:true,nextAttemptAt:base});const running=runtime.alarm();await entered;
 await pair(h);release();await running;assert.equal(ingests,0);assert.equal(await h.storage.get('cloud-sync:last-run'),undefined);
 assert.equal((await h.registry.status()).platforms.boataround.last_error,'awaiting_first_sync');
});
test('poll/heartbeat are real liveness only and queued uuid acknowledgments cannot clear newer work',async()=>{const h=harness();await pair(h);const one=await(await h.agent.user(req('/api/agent/run',{}, {user:true}))).json();const two=await(await h.agent.user(req('/api/agent/run',{}, {user:true}))).json();assert.equal(one.requested_run_id,two.requested_run_id);const poll=await(await h.agent.machine(req('/api/agent/poll'))).json();assert.equal(poll.requested_run_id,one.requested_run_id);await h.agent.machine(req('/api/agent/heartbeat',{completed:true,requested_run_id:crypto.randomUUID(),state:'needs_login'}));assert.equal((await h.agent.publicStatus()).requested_run_id,one.requested_run_id);await h.agent.machine(req('/api/agent/heartbeat',{completed:true,requested_run_id:one.requested_run_id,state:'idle'}));assert.equal((await h.agent.publicStatus()).requested_run_id,null);const newer=await(await h.agent.user(req('/api/agent/run',{}, {user:true}))).json();await h.agent.machine(req('/api/agent/heartbeat',{completed:true,requested_run_id:one.requested_run_id}));assert.equal((await h.agent.publicStatus()).requested_run_id,newer.requested_run_id);assert.equal((await h.registry.status()).latest_platform_success_at,null);h.advance(180001);assert.equal((await h.agent.publicStatus()).online,false);});
test('enabled schedule accepts bounded real next attempt and pause does not forge success',async()=>{const h=harness();await pair(h);await h.agent.user(req('/api/agent/config',{enabled:true},{user:true}));const next=new Date(base+PHONE_INTERVAL_MS).toISOString();assert.equal((await h.agent.machine(req('/api/agent/heartbeat',{next_run_at:next,state:'idle'}))).status,200);assert.equal((await h.agent.publicStatus()).next_run_at,next);assert.equal((await h.agent.machine(req('/api/agent/heartbeat',{next_run_at:new Date(base+2*PHONE_INTERVAL_MS).toISOString()}))).status,400);await h.agent.user(req('/api/agent/config',{enabled:false},{user:true}));assert.equal((await h.agent.publicStatus()).next_run_at,null);assert.equal((await h.registry.status()).latest_platform_success_at,null);});
test('machine order upload enforces original 900KiB bound and accepted failure is not success',async()=>{const h=harness();await pair(h);assert.equal((await h.agent.machine(req('/api/agent/order-sync',JSON.stringify({x:'x'.repeat(900*1024)})))).status,413);const snapshot={source:'boataround',run_id:'phone-failure-fixture',checked_at:new Date(base).toISOString(),outcome:'failure',error_code:'auth_required'};const p={schema_version:1,snapshots:[snapshot]};const r=await h.agent.machine(req('/api/agent/order-sync',p));assert.equal(r.status,200);const result=await r.json();assert.equal(result.results[0].outcome,'failure');assert.equal(result.results[0].last_success_at,null);assert.equal((await h.agent.machine(req('/api/agent/order-sync',p))).status,200);const replay=await(await h.agent.machine(req('/api/agent/order-sync',p))).json();assert.equal(replay.results[0].idempotent,true);const changed=await h.agent.machine(req('/api/agent/order-sync',{schema_version:1,snapshots:[{...snapshot,error_code:'fetch_failed'}]}));assert.equal(changed.status,207);assert.equal((await changed.json()).results[0].status,409);});
test('partial receipt preserves per-source failure and stale snapshot is explicitly ignored',async()=>{const h=harness();await pair(h);const good={source:'boataround',run_id:'phone-good-fixture',checked_at:new Date(base).toISOString(),outcome:'failure',error_code:'auth_required'};const malformed={source:'clickandboat',run_id:'phone-incomplete-fixture',checked_at:new Date(base).toISOString(),outcome:'success',complete:false};const r=await h.agent.machine(req('/api/agent/order-sync',{schema_version:1,snapshots:[good,malformed]}));assert.equal(r.status,207);const p=await r.json();assert.equal(p.results[0].accepted,true);assert.equal(p.results[1].accepted,false);const stale=await h.agent.machine(req('/api/agent/order-sync',{schema_version:1,snapshots:[{...good,run_id:'phone-older-fixture',checked_at:new Date(base-1000).toISOString()}]}));assert.equal(stale.status,207);assert.equal((await stale.json()).results[0].ignored,'older_snapshot');assert.equal((await h.registry.registry()).samboat.find(r=>r.booking_id==='1000001').status,'cancelled');});
function loadContext(source){const context=vm.createContext({DurableObject:class{},puppeteer:{},FleetCloudSync,FleetPhoneAgent,isPhoneMachinePath,isPhoneUserPath,TextEncoder,TextDecoder,Response,Request,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,console,fetch:()=>{throw Error('No network allowed');}});vm.runInContext(source.replace(/^import[^\n]+\n/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),context);return context;}
test('complete upload advances only observed source times; later failure preserves its actual orders',async()=>{
 const h=harness();await pair(h);
 const order={booking_id:'99000073',boataround_slug:FLEET[0].slug,boat:FLEET[0].slug,status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID',start:'2026-10-17',end:'2026-10-24',
   detail_id:'ffffffffffffffffffffffff',url:'https://partner.boataround.com/en/000000000000000000000000/orders/ffffffffffffffffffffffff'};
 const snapshot={source:'boataround',run_id:'complete-phone-fixture',checked_at:new Date(base).toISOString(),outcome:'success',complete:true,expected_count:1,
  scope:{kind:'current_future',from_day:'2026-09-10',fleet_slugs:FLEET.map(b=>b.slug)},pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:1},orders:[order]};
 const success=await h.agent.machine(req('/api/agent/order-sync',{schema_version:1,snapshots:[snapshot]}));assert.equal(success.status,200);
 assert.equal((await success.json()).results[0].last_success_at,new Date(base).toISOString());h.advance(1000);
 const failed=await h.agent.machine(req('/api/agent/order-sync',{schema_version:1,snapshots:[{source:'boataround',run_id:'later-phone-fixture',checked_at:new Date(h.time()).toISOString(),outcome:'failure',error_code:'fetch_failed'}]}));assert.equal(failed.status,200);
 assert.equal((await h.registry.registry()).boataround[0].booking_id,order.booking_id);const status=await h.agent.publicStatus();assert.equal(status.order_sync.platforms.boataround.last_success_at,new Date(base).toISOString());assert.equal(status.order_sync.platforms.clickandboat.last_success_at,null);assert.equal(status.order_sync.last_all_platforms_success_at,null);
});
test('integration preserves reviewed conflict and manual reschedule dashboard, login, CSP and original auth while machine token is narrowly scoped',async()=>{const baseline=fs.readFileSync(new URL('./phone-agent-build/baseline-integrated-source.mjs',import.meta.url),'utf8');const reviewed=[patchBookingConflicts,patchManualReschedule,patchVoltage,patchReverse,require('./checkout-day-patch.cjs').patchCheckoutDay,patchManualUnavailability,patchOrderQueryFreshness,require('./manual-orders-patch.cjs').patchManualOrders,require('./boataround-payment-workflow-patch.cjs').patchBoataroundPaymentWorkflow,require('./mmk-orders-patch.cjs').patchMmkOrders,require('./revenue-patch.cjs').patchRevenue,require('./notebook-theme-patch.cjs').patchNotebookTheme,require('./copy-style-patch.cjs').patchCopyStyle].reduce((source,patch)=>patch(source),baseline);const before=loadContext(reviewed);const ctx=loadContext(fs.readFileSync(new URL('./integrated-source.mjs',import.meta.url),'utf8'));for(const key of ['HTML','LOGIN_HTML','PAGE_CSP','SESSION_COOKIE'])assert.deepEqual(JSON.stringify(ctx[key]),JSON.stringify(before[key]),key+' changed');const h=harness(),config={username:'fixture-only@example.invalid',iterations:100000,salt:'11'.repeat(32),pepper:'22'.repeat(32),verifier:'00'.repeat(32)},password='fictional-local-fixture-password';config.verifier=Buffer.from(await ctx.passwordVerifier(password,config)).toString('hex');const env={BUCKET:bucket(),FLEET_AUTH_CONFIG:JSON.stringify(config),PHONE_AGENT:h.agent,CLOUD_SYNC:{handle:()=>{throw Error('Not expected');}}};const dispatch=r=>ctx.server_default.fetch(r,env);for(const path of ['/api/agent/status','/api/agent/pairing-code','/api/agent/run','/api/data','/api/order-sync','/api/reverse-sync/preview','/api/manual-orders'])assert.equal((await dispatch(req(path,path.endsWith('status')||path.endsWith('data')?undefined:{}))).status,401,path);const login=await dispatch(new Request(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:config.username,password})}));assert.equal(login.status,303);const cookie=login.headers.get('Set-Cookie').split(';')[0];const c=await(await dispatch(req('/api/agent/pairing-code',{}, {user:true,headers:{Cookie:cookie}}))).json();assert.ok(c.pairing_code);assert.equal((await dispatch(req('/api/agent/pair',{pairing_code:c.pairing_code,name:'phone'}))).status,200);assert.equal((await dispatch(req('/api/agent/poll'))).status,200);assert.equal((await dispatch(req('/api/data'))).status,401);assert.equal((await dispatch(req('/api/agent/config',{enabled:true}))).status,401);assert.equal((await dispatch(req('/api/agent/poll/'))).status,401);assert.equal((await dispatch(req('/api/agent/pairing-code',{}, {user:true,headers:{Cookie:cookie,Origin:'https://evil.invalid'}}))).status,403);const runReplies=await Promise.all(['/api/agent/run','/api/cloud-sync/run'].map(path=>dispatch(req(path,{}, {user:true,headers:{Cookie:cookie}}))));assert.ok(runReplies.every(reply=>reply.status===202));const runBodies=await Promise.all(runReplies.map(reply=>reply.json()));assert.equal(runBodies[0].requested_run_id,runBodies[1].requested_run_id);assert.equal((await h.agent.publicStatus()).requested_run_id,runBodies[0].requested_run_id);assert.equal((await dispatch(req('/sync',undefined,{user:true,headers:{Cookie:cookie}}))).status,200);});
test('phone maintenance script is valid, hash-pinned and uses Beijing real-success fields',()=>{const p=buildPhoneMaintenancePage();new vm.Script(p.script);assert.ok(p.csp.includes("'sha256-"+createHash('sha256').update(p.script).digest('base64')+"'"));assert.ok(p.csp.includes("'sha256-"+createHash('sha256').update(p.style).digest('base64')+"'"));assert.ok(p.script.includes("timeZone:'Asia/Shanghai'"));assert.ok(p.script.includes('p.last_success_at'));assert.ok(!p.html.includes('window.open'));assert.ok(p.html.includes('生成一次性连接码'));});

const manualSources=['boataround','clickandboat','samboat','mmk','nausys'];
async function queueManual(h){return (await(await h.agent.user(req('/api/agent/run',{}, {user:true}))).json()).requested_run_id;}
function manualSnapshot(h,source,outcome='success',extra={}){
  const common={source,run_id:crypto.randomUUID(),checked_at:new Date(h.time()).toISOString(),outcome};
  return outcome==='failure'?{...common,error_code:'fetch_failed',...extra}:{...common,complete:true,expected_count:0,orders:[],
    scope:{kind:'current_future',from_day:'2026-09-10',fleet_slugs:FLEET.map(b=>b.slug)},
    pagination:{complete:true,total_pages:1,pages_read:[1],listed_count:0},...extra};
}
const uploadManual=(h,id,snapshots)=>h.agent.machine(req('/api/agent/order-sync',{schema_version:1,...(id===undefined?{}:{requested_run_id:id}),snapshots}));
const acknowledge=(h,id)=>h.agent.machine(req('/api/agent/heartbeat',{requested_run_id:id,completed:true,state:'idle'}));

test('manual status is initially null, coalesces queued clicks, and requires matching running heartbeat',async()=>{
  const h=harness();await pair(h);assert.equal((await h.agent.publicStatus()).manual_run,null);
  const [one,two]=await Promise.all([queueManual(h),queueManual(h)]);assert.equal(one,two);
  assert.deepEqual((await h.agent.publicStatus()).manual_run,{id:one,state:'queued',requested_at:new Date(base).toISOString(),completed_at:null,results:{}});
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running'}));
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running',requested_run_id:crypto.randomUUID()}));
  assert.equal((await h.agent.publicStatus()).manual_run.state,'queued');
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running',requested_run_id:one}));
  assert.equal((await h.agent.publicStatus()).manual_run.state,'running');
  assert.equal(await queueManual(h),one);
});

test('three accepted manual success receipts do not finish or clear the queue before the matching phone acknowledgment',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h),snapshots=manualSources.map(source=>manualSnapshot(h,source));
  assert.equal((await uploadManual(h,id,snapshots)).status,200);
  let status=await h.agent.publicStatus();assert.equal(status.requested_run_id,id);assert.equal(status.manual_run.state,'running');assert.equal(status.manual_run.completed_at,null);
  assert.equal(await queueManual(h),id);assert.ok(manualSources.every(source=>status.manual_run.results[source].outcome==='success'));
  assert.ok(h.calls.every(payload=>!Object.hasOwn(payload,'requested_run_id')));
  h.advance(1000);await acknowledge(h,id);status=await h.agent.publicStatus();
  assert.equal(status.manual_run.state,'completed');assert.equal(status.requested_run_id,null);assert.equal(status.manual_run.completed_at,new Date(base+1000).toISOString());
  await acknowledge(h,id);assert.deepEqual((await h.agent.publicStatus()).manual_run,status.manual_run);
});

test('accepted failures and committed permanent rejections finish as failures; a later matching result can recover its source',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);
  const snapshots=[manualSnapshot(h,'boataround','failure',{error_code:'auth_required'}),manualSnapshot(h,'clickandboat'),manualSnapshot(h,'samboat','success',{complete:false}),manualSnapshot(h,'mmk'),manualSnapshot(h,'nausys')];
  assert.equal((await uploadManual(h,id,snapshots)).status,207);
  let manual=(await h.agent.publicStatus()).manual_run;
  assert.deepEqual(manual.results.boataround,{outcome:'failure',checked_at:new Date(base).toISOString(),error_code:'auth_required'});
  assert.equal(manual.results.clickandboat.outcome,'success');
  assert.deepEqual(manual.results.samboat,{outcome:'failure',checked_at:new Date(base).toISOString(),error_code:'schema_changed'});
  h.advance(1000);await acknowledge(h,id);manual=(await h.agent.publicStatus()).manual_run;
  assert.equal(manual.state,'completed');assert.equal((await h.agent.publicStatus()).requested_run_id,null);
  const completedAt=manual.completed_at;h.advance(1000);
  assert.equal((await uploadManual(h,id,[manualSnapshot(h,'samboat')])).status,200);
  manual=(await h.agent.publicStatus()).manual_run;
  assert.equal(manual.state,'completed');assert.equal(manual.completed_at,completedAt);assert.equal(manual.results.boataround.outcome,'failure');
  assert.equal((await h.agent.publicStatus()).order_sync.platforms.boataround.last_success_at,null);
});

test('an acknowledged run without receipts awaits uploads, and running heartbeats cannot undo its acknowledgment',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);await acknowledge(h,id);
  assert.equal((await h.agent.publicStatus()).manual_run.state,'awaiting_upload');
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running',requested_run_id:id}));
  assert.equal((await h.agent.publicStatus()).manual_run.state,'awaiting_upload');
  await uploadManual(h,id,manualSources.map(source=>manualSnapshot(h,source)));
  assert.equal((await h.agent.publicStatus()).manual_run.state,'completed');
});

test('automatic outbox uploads, stale snapshots and a prior requested UUID never become the new manual result',async()=>{
  const h=harness();await pair(h);const old=manualSnapshot(h,'boataround');
  await uploadManual(h,undefined,[old]);h.advance(1000);const id=await queueManual(h);
  // An accepted legacy idempotent retry is still older than this request.
  const replay=await(await uploadManual(h,id,[old])).json();assert.equal(replay.results[0].idempotent,true);
  await uploadManual(h,undefined,[manualSnapshot(h,'clickandboat')]);
  await uploadManual(h,crypto.randomUUID(),[manualSnapshot(h,'samboat')]);
  assert.deepEqual((await h.agent.publicStatus()).manual_run.results,{});
  await acknowledge(h,id);h.advance(1000);const newer=await queueManual(h);assert.notEqual(newer,id);
  await uploadManual(h,id,[manualSnapshot(h,'boataround')]);await acknowledge(h,id);
  const status=await h.agent.publicStatus();assert.equal(status.requested_run_id,newer);assert.equal(status.manual_run.id,newer);assert.equal(status.manual_run.state,'queued');assert.deepEqual(status.manual_run.results,{});
});

test('receipt errors, contradictory outcomes, wrong sources, duplicate results and ignored entries cannot forge manual success',async()=>{
  const cases=[
    [{source:'boataround',accepted:false,outcome:'success'}],
    [{source:'boataround',accepted:true,outcome:'failure'}],
    [{source:'clickandboat',accepted:true,outcome:'success'}],
    [{source:'boataround',accepted:true,outcome:'success',ignored:'older_snapshot'}],
    [{source:'boataround',accepted:true,outcome:'success',status:422}],
    [{source:'boataround',accepted:true,outcome:'success',error:'untrusted private error'}],
    [{source:'boataround',accepted:true}],
    [{source:'boataround',accepted:true,outcome:'success',run_id:'wrong'}],
    [{source:'boataround',accepted:true,outcome:'success'},{source:'boataround',accepted:true,outcome:'success'}]
  ];
  for(const results of cases){const h=harness();await pair(h);const id=await queueManual(h);h.agent.ingest=async()=>({schema_version:1,results});await uploadManual(h,id,[manualSnapshot(h,'boataround')]);assert.deepEqual((await h.agent.publicStatus()).manual_run.results,{});}
});

test('an idempotent retry recovers manual receipt persistence failure without reclassifying a failure as success',async()=>{
  for(const outcome of ['success','failure']){
    const h=harness();await pair(h);const id=await queueManual(h),snapshot=manualSnapshot(h,'boataround',outcome),original=h.storage.put.bind(h.storage);let failOnce=true;
    h.storage.put=async(key,value)=>{if(failOnce&&key===PHONE_AGENT_KEY&&value.manual_run?.results?.boataround){failOnce=false;throw Error('simulated storage failure after actual ingest');}return original(key,value);};
    assert.equal((await uploadManual(h,id,[snapshot])).status,503);
    assert.deepEqual((await h.agent.publicStatus()).manual_run.results,{});
    const response=await uploadManual(h,id,[snapshot]);assert.equal(response.status,200);assert.equal((await response.json()).results[0].idempotent,true);
    const recorded=(await h.agent.publicStatus()).manual_run.results.boataround;assert.equal(recorded.outcome,outcome);
    if(outcome==='failure')assert.equal(recorded.error_code,'fetch_failed');
    const before=structuredClone(recorded);await uploadManual(h,id,[snapshot]);assert.deepEqual((await h.agent.publicStatus()).manual_run.results.boataround,before);
  }
});

test('simultaneous source uploads and a completion heartbeat preserve partial then late results under the instance lock',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);
  const results=await Promise.all([uploadManual(h,id,[manualSnapshot(h,'boataround')]),uploadManual(h,id,[manualSnapshot(h,'clickandboat','failure')]),acknowledge(h,id),uploadManual(h,id,[manualSnapshot(h,'samboat')]),uploadManual(h,id,[manualSnapshot(h,'mmk')]),uploadManual(h,id,[manualSnapshot(h,'nausys')])]);
  assert.ok(results.every(response=>response.status===200));
  const status=await h.agent.publicStatus();assert.equal(status.manual_run.state,'completed');assert.equal(status.requested_run_id,null);
  assert.equal(status.manual_run.results.clickandboat.outcome,'failure');assert.equal(Object.keys(status.manual_run.results).length,5);
});

function uuidWithVersion(id,version){return id.slice(0,14)+String(version)+id.slice(15);}
test('requested UUID validation happens before ingest while old upload envelopes remain compatible',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);
  for(const invalid of [null,42,{},[],id.toUpperCase(),'not-a-uuid',uuidWithVersion(id,3)])assert.equal((await uploadManual(h,invalid,[manualSnapshot(h,'boataround')])).status,400);
  assert.equal(h.calls.length,0);
  assert.equal((await uploadManual(h,undefined,[manualSnapshot(h,'boataround')])).status,200);
  assert.deepEqual((await h.agent.publicStatus()).manual_run.results,{});
});

test('the invalid UUID version fixture changes the version group even when the preceding group begins with 4',async()=>{
  const fixed='11111111-4444-4111-8111-111111111111',invalid=uuidWithVersion(fixed,3);
  assert.equal(invalid,'11111111-4444-3111-8111-111111111111');
  const h=harness();await pair(h);assert.equal((await uploadManual(h,invalid,[manualSnapshot(h,'boataround')])).status,400);assert.equal(h.calls.length,0);
});

test('manual public status exposes only safe fixed-source results and revoke clears the entire manual record',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);await uploadManual(h,id,[manualSnapshot(h,'boataround','failure')]);
  const saved=await h.storage.get(PHONE_AGENT_KEY);saved.manual_run.private='private credential';saved.manual_run.results.boataround.customer='private customer';saved.manual_run.results.evil={outcome:'success',checked_at:new Date(base).toISOString(),token:'private token'};await h.storage.put(PHONE_AGENT_KEY,saved);
  const status=await(await h.agent.user(req('/api/agent/status',undefined,{user:true}))).json();
  assert.deepEqual(Object.keys(status.manual_run),['id','state','requested_at','completed_at','results']);assert.deepEqual(Object.keys(status.manual_run.results),['boataround']);
  assert.ok(!JSON.stringify(status).includes('private credential'));assert.ok(!JSON.stringify(status).includes('private customer'));assert.ok(!JSON.stringify(status).includes('private token'));
  await h.agent.user(req('/api/agent/revoke',{}, {user:true}));assert.equal((await h.agent.publicStatus()).manual_run,null);
});

test('phone schedule is three hours and a six-hour next attempt is rejected',async()=>{
  assert.equal(PHONE_INTERVAL_MS,3*60*60*1000);const h=harness();await pair(h);await h.agent.user(req('/api/agent/config',{enabled:true},{user:true}));
  assert.equal((await h.agent.machine(req('/api/agent/heartbeat',{next_run_at:new Date(base+PHONE_INTERVAL_MS).toISOString()}))).status,200);
  assert.equal((await h.agent.machine(req('/api/agent/heartbeat',{next_run_at:new Date(base+6*60*60*1000).toISOString()}))).status,400);
});

test('a stale request heartbeat cannot overwrite a newer running request or its schedule',async()=>{
  const h=harness();await pair(h);await h.agent.user(req('/api/agent/config',{enabled:true},{user:true}));
  const old=await queueManual(h);await acknowledge(h,old);h.advance(1000);
  const current=await queueManual(h),next=new Date(h.time()+PHONE_INTERVAL_MS).toISOString();
  await h.agent.machine(req('/api/agent/heartbeat',{requested_run_id:current,state:'running',next_run_at:next}));
  const before=await h.agent.publicStatus();h.advance(1000);
  // Even an expired schedule in the old ACK is now harmless and drainable.
  const stale=await h.agent.machine(req('/api/agent/heartbeat',{requested_run_id:old,completed:true,state:'idle',next_run_at:new Date(base-120000).toISOString()}));
  assert.equal(stale.status,200);const after=await h.agent.publicStatus();
  assert.equal(after.requested_run_id,current);assert.equal(after.state,'running');assert.equal(after.next_run_at,next);
  assert.deepEqual(after.manual_run,before.manual_run);assert.equal(after.last_seen,new Date(h.time()).toISOString());
  assert.equal(after.order_sync.latest_platform_success_at,null);
});

test('duplicate completed or delayed running heartbeats cannot overwrite subsequent automatic activity',async()=>{
  for(const completeReceipts of [false,true]){
    const h=harness();await pair(h);await h.agent.user(req('/api/agent/config',{enabled:true},{user:true}));
    const id=await queueManual(h);
    if(completeReceipts)await uploadManual(h,id,manualSources.map(source=>manualSnapshot(h,source)));
    await acknowledge(h,id);h.advance(1000);
    const next=new Date(h.time()+PHONE_INTERVAL_MS).toISOString();
    await h.agent.machine(req('/api/agent/heartbeat',{state:'running',next_run_at:next}));
    const before=await h.agent.publicStatus();
    assert.equal(before.manual_run.state,completeReceipts?'completed':'awaiting_upload');
    for(const input of [{completed:true,state:'idle'},{state:'needs_login'},{state:'running'}]){
      h.advance(1000);
      const reply=await h.agent.machine(req('/api/agent/heartbeat',{requested_run_id:id,next_run_at:new Date(base-120000).toISOString(),...input}));
      assert.equal(reply.status,200);const after=await h.agent.publicStatus();
      assert.equal(after.state,'running');assert.equal(after.next_run_at,next);assert.equal(after.requested_run_id,null);
      assert.deepEqual(after.manual_run,before.manual_run);assert.equal(after.last_seen,new Date(h.time()).toISOString());
    }
    if(!completeReceipts){
      await uploadManual(h,id,manualSources.map(source=>manualSnapshot(h,source)));
      const after=await h.agent.publicStatus();assert.equal(after.manual_run.state,'completed');
      assert.equal(after.manual_run.completed_at,before.manual_run.completed_at);assert.equal(after.state,'running');assert.equal(after.next_run_at,next);
    }
  }
});

test('paused manual work still polls, runs and completes only on its own three receipts and ACK',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);
  const poll=await(await h.agent.machine(req('/api/agent/poll'))).json();assert.equal(poll.enabled,false);assert.equal(poll.requested_run_id,id);
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running',requested_run_id:id}));
  await uploadManual(h,id,manualSources.filter(source=>source!=='samboat').map(source=>manualSnapshot(h,source)));
  await uploadManual(h,undefined,[manualSnapshot(h,'samboat')]);await acknowledge(h,id);
  assert.equal((await h.agent.publicStatus()).manual_run.state,'awaiting_upload');
  h.advance(1000);await uploadManual(h,id,[manualSnapshot(h,'samboat')]);
  const after=await h.agent.publicStatus();assert.equal(after.manual_run.state,'completed');assert.equal(after.requested_run_id,null);
  assert.equal(after.enabled,false);assert.equal(after.next_run_at,null);assert.ok(manualSources.every(source=>after.manual_run.results[source].outcome==='success'));
});

test('an automatic heartbeat while manual work is queued stays compatible without acknowledging manual work',async()=>{
  const h=harness();await pair(h);await h.agent.user(req('/api/agent/config',{enabled:true},{user:true}));
  await h.agent.machine(req('/api/agent/heartbeat',{state:'running'}));const id=await queueManual(h);
  const next=new Date(h.time()+PHONE_INTERVAL_MS).toISOString();
  const automatic=await h.agent.machine(req('/api/agent/heartbeat',{completed:true,state:'idle',next_run_at:next}));
  assert.equal(automatic.status,200);const status=await h.agent.publicStatus();
  assert.equal(status.state,'idle');assert.equal(status.next_run_at,next);assert.equal(status.requested_run_id,id);
  assert.equal(status.manual_run.state,'queued');assert.equal(status.manual_run.completed_at,null);assert.deepEqual(status.manual_run.results,{});
});

test('an offline queued request does not expire into success and remains available after reconnect',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h);h.advance(24*60*60*1000);
  const offline=await h.agent.publicStatus();assert.equal(offline.online,false);assert.equal(offline.manual_run.state,'queued');
  assert.equal(offline.manual_run.completed_at,null);assert.deepEqual(offline.manual_run.results,{});assert.equal(offline.order_sync.latest_platform_success_at,null);
  const poll=await(await h.agent.machine(req('/api/agent/poll'))).json();assert.equal(poll.requested_run_id,id);assert.equal(poll.enabled,false);
  assert.equal(await queueManual(h),id);
});

test('the matching first ACK can drain a legacy queue without inventing a manual result',async()=>{
  const h=harness();await pair(h);const id=await queueManual(h),saved=await h.storage.get(PHONE_AGENT_KEY);
  delete saved.manual_run;await h.storage.put(PHONE_AGENT_KEY,saved);
  assert.equal((await acknowledge(h,id)).status,200);
  const after=await h.agent.publicStatus();assert.equal(after.requested_run_id,null);assert.equal(after.manual_run,null);
  assert.equal(after.order_sync.latest_platform_success_at,null);assert.equal(after.state,'idle');
});
