'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {patchOrderSync}=require('./worker/patch-order-sync.cjs');
const {patchSyncFrontend,buildSyncMaintenancePage}=require('./frontend-sync-patch.cjs');
const {buildPhoneMaintenancePage}=require('./phone-agent-patch.cjs');
const originalSource=fs.readFileSync(path.resolve(__dirname,'../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const backendSource=patchOrderSync(originalSource),finalSource=patchSyncFrontend(backendSource);
function loadWorker(source){const context=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Request,Response,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,console});vm.runInContext(source.replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),context);return context;}
const before=loadWorker(backendSource),after=loadWorker(finalSource);
function script(html){return html.match(/<script>([\s\S]*?)<\/script>/)[1];}
function frontend(html,maintenance=false){const nodes=new Map(),requests=[],timers=new Map(),events=new Map();let nextTimer=0;const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{id,textContent:'',innerHTML:'',disabled:false,hidden:false,value:'',href:'',addEventListener(){},removeAttribute(name){delete this[name];}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(name,fn){events.set(name,fn);}};const window={location:{replace(value){window.redirect=value;},reload(){}},addEventListener(){}};const context=vm.createContext({document,window,location:window.location,URL,console,AbortController,setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},setInterval(){return 1;},clearInterval(){},fetch:async(...args)=>{requests.push(args);return new Response('{}');}});vm.runInContext(script(html).replace(maintenance?/\binitializeSyncSettings\(\);\s*$/:/\binitialize\(\);\s*$/,''),context);return {context,nodes,document,requests,timers,events,window};}
function dataWith(state){return {schema_version:2,boats:[],generated_at:'2099-01-01T00:00:00Z',mapping_updated_at:'2026-09-08T01:25:43Z',order_sync:state};}
function setData(f,data){f.context.fixtureData=data;vm.runInContext('DATA=fixtureData;renderBoats=()=>{};',f.context);}
function allState(){return {automatic_enabled:true,next_attempt_at:'2026-09-09T06:00:00Z',platforms:{boataround:{last_success_at:'2026-09-09T00:00:00Z'},clickandboat:{last_success_at:'2026-09-09T01:00:00Z'},samboat:{last_success_at:'2026-09-09T02:00:00Z'},mmk:{last_success_at:'2026-09-09T03:00:00Z'},nausys:{last_success_at:'2026-09-09T04:00:00Z'}},cloud:{sources:{boataround:{status:'connected'},clickandboat:{status:'connected'},samboat:{status:'connected'}},budget:{remainingMs:180000,chargedMs:300000},active:null}};}
function innerStyle(html){return html.match(/<style>([\s\S]*?)<\/style>/)[1];}
function segment(source,start,end){const a=source.indexOf(start),b=end?source.indexOf(end,a+start.length):source.length;return source.slice(a,b);}

test('main calendar/boat UI CSS and every business calculation remain identical',()=>{assert.equal(innerStyle(after.HTML),innerStyle(before.HTML));const old=frontend(before.HTML).context,newer=frontend(after.HTML).context;for(const name of ['confirmed','activeBookings','knownOrders','orderURL','sourceURL','orderStatus','linkedRange','knownBlocks','mergedOccupancy','dayStatus','calendar','renderBoats','initialize'])assert.equal(newer[name].toString(),old[name].toString(),name);assert.equal(newer.window.checkAvail.toString(),old.window.checkAvail.toString());});
test('login/auth/storage implementation and login policy are unchanged',()=>{assert.equal(after.LOGIN_HTML,before.LOGIN_HTML);assert.equal(after.PAGE_CSP.login,before.PAGE_CSP.login);assert.equal(segment(finalSource,'var SESSION_COOKIE =','var CACHE_KEY ='),segment(backendSource,'var SESSION_COOKIE =','var CACHE_KEY ='));assert.equal(segment(finalSource,'function orderRegistry(env)'),segment(backendSource,'function orderRegistry(env)'));});
test('all script/style CSP hashes match actual rendered content',()=>{for(const [html,csp] of [[after.HTML,after.PAGE_CSP.dashboard],[after.ORDER_SYNC_HTML,after.ORDER_SYNC_CSP]])for(const value of [script(html),innerStyle(html)])assert.ok(csp.includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));});
test('a platform access check reads as a manual verification step, distinct from login and network faults',()=>{
 let checked=0;
 for(const [html,maintenance] of [[after.HTML,false],[after.ORDER_SYNC_HTML,true]]){
  const text=frontend(html,maintenance).context.syncErrorText;if(typeof text!=='function')continue;checked++;
  assert.match(text('challenge_required'),/人工完成访问验证/);assert.match(text('challenge_required'),/已保留上次订单/);
  assert.notEqual(text('challenge_required'),text('fetch_failed'));assert.notEqual(text('challenge_required'),text('auth_required'));
 }
 assert.ok(checked>0,'syncErrorText must exist on at least one page');
});
test('main data explanation replaces static instructions and links to synchronization settings',()=>{assert.ok(after.HTML.includes('href="/sync">同步设置'));assert.ok(!after.HTML.includes('刷新仅更新公开船期'));assert.ok(!after.HTML.includes('取消需更新订单映射'));});
test('unconnected state uses verified snapshot timestamp, never public generated_at',()=>{const f=frontend(after.HTML);setData(f,dataWith({automatic_enabled:false,platforms:{}}));f.context.render();assert.match(f.document.getElementById('meta').textContent,/已核验快照时间：2026-09-08 09:25:43/);assert.match(f.document.getElementById('meta').textContent,/三平台尚未全部连接并完成同步/);assert.ok(!f.document.getElementById('meta').textContent.includes('2099'));assert.equal(f.document.getElementById('syncMode').textContent,'定时同步未启用。');});
test('partial success cannot appear as all three platforms successfully refreshed',()=>{const f=frontend(after.HTML),state=allState();state.platforms.samboat.last_success_at=null;setData(f,dataWith(state));f.context.render();assert.match(f.document.getElementById('meta').textContent,/已核验快照时间/);assert.match(f.document.getElementById('syncMode').textContent,/等待三平台首次成功/);assert.match(f.document.getElementById('bookingVerifiedAt').textContent,/SamBoat 最近成功：尚未成功同步/);});
test('three successful sources display conservative common freshness in Beijing time',()=>{const f=frontend(after.HTML);setData(f,dataWith(allState()));f.context.render();assert.equal(f.document.getElementById('meta').textContent,'最新刷新数据时间：2026-09-09 08:00:00（北京时间）');assert.match(f.document.getElementById('bookingVerifiedAt').textContent,/Click&Boat 最近成功：2026-09-09 09:00:00/);assert.match(f.document.getElementById('syncMode').textContent,/2026-09-09 14:00:00/);});
test('renewed connection is not shown as expired merely because last collection failed login',()=>{const f=frontend(after.HTML),state=allState();state.platforms.boataround.last_error='auth_required';setData(f,dataWith(state));f.context.render();assert.match(f.document.getElementById('dataIssues').textContent,/Boataround：已重新连接，等待下次同步/);});
test('refresh button queues cloud sync then reads saved data and never claims queued work completed',async()=>{const f=frontend(after.HTML);setData(f,dataWith(allState()));const requests=[];f.context.fetch=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(url==='/api/cloud-sync/run'?{status:'queued'}:dataWith(allState())),{status:200});};await f.context.loadData(true);assert.deepEqual(requests.map(item=>item.url),['/api/cloud-sync/run','/api/data']);assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.body,'{}');assert.match(f.document.getElementById('meta').textContent,/已提交云端同步.*仍显示最近保存的订单/);assert.ok(!f.document.getElementById('meta').textContent.includes('同步完成'));});
test('quota response still reads saved orders and shows a Chinese budget explanation',async()=>{const f=frontend(after.HTML);setData(f,dataWith(allState()));const calls=[];f.context.fetch=async(url)=>{calls.push(url);return new Response(JSON.stringify(url.endsWith('/run')?{status:'quota',reason:'daily_budget'}:dataWith(allState())),{status:url.endsWith('/run')?429:200});};await f.context.loadData(true);assert.equal(calls.length,2);assert.match(f.document.getElementById('meta').textContent,/免费运行预算暂时不足/);});
test('raw backend error and cookie-like content is not shown to the user',async()=>{const f=frontend(after.HTML);setData(f,dataWith(allState()));f.context.fetch=async(url)=>new Response(JSON.stringify(url.endsWith('/run')?{error:'Cookie: private-session-value'}:dataWith(allState())),{status:url.endsWith('/run')?500:200});await f.context.loadData(true);assert.ok(!f.document.getElementById('meta').textContent.includes('private-session'));assert.match(f.document.getElementById('meta').textContent,/同步服务暂时不可用/);});
test('maintenance contains only connection and scheduler controls, with no raw snapshot form or iframe',()=>{const html=after.ORDER_SYNC_HTML;assert.equal((html.match(/>连接平台<\/button>/g)||[]).length,3);assert.equal((html.match(/>完成登录<\/button>/g)||[]).length,3);for(const label of ['立即同步','启用定时同步','暂停定时同步'])assert.ok(html.includes('>'+label+'</button>'));for(const unwanted of ['<textarea','<pre','<iframe','snapshot-json','完整订单快照 JSON'])assert.ok(!html.includes(unwanted));});
test('maintenance renders connection, per-source time, automatic status and actual free budget fields',()=>{const f=frontend(after.ORDER_SYNC_HTML,true);f.context.renderSyncStatus({order_sync:allState()});assert.equal(f.document.getElementById('connection-boataround').textContent,'已连接');assert.match(f.document.getElementById('success-samboat').textContent,/2026-09-09 10:00:00/);assert.match(f.document.getElementById('budget-state').textContent,/剩余 3分00秒/);assert.equal(f.document.getElementById('enable-sync').disabled,true);assert.equal(f.document.getElementById('pause-sync').disabled,false);});
test('insufficient standard login budget explicitly labels its derived Beijing recovery time',()=>{const f=frontend(after.ORDER_SYNC_HTML,true);const text=f.context.budgetText({cloud:{budget:{remainingMs:110000,nextLoginAt:Date.parse('2026-09-09T04:34:16Z')}}});assert.match(text,/剩余 1分50秒/);assert.match(text,/预计标准登录恢复时间：2026-09-09 12:34:16（北京时间）/);assert.match(text,/现有订单已保留/);});
test('maintenance without successful collection does not say synchronization succeeded',()=>{const f=frontend(after.ORDER_SYNC_HTML,true);f.context.renderSyncStatus({order_sync:{platforms:{},automatic_enabled:false},cloud:{sources:{samboat:{status:'auth_required'}}}});assert.equal(f.document.getElementById('connection-samboat').textContent,'尚未连接');assert.match(f.document.getElementById('success-samboat').textContent,/尚未成功同步/);assert.match(f.document.getElementById('schedule-state').textContent,/未启用/);});
test('first unauthenticated alarm is not labeled as an expired prior login',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state={platforms:{samboat:{last_error:'auth_required',last_success_at:null}},cloud:{sources:{samboat:{status:'auth_required',checkedAt:null}}}};f.context.renderSyncStatus(state);assert.equal(f.document.getElementById('connection-samboat').textContent,'尚未连接');state.platforms.samboat.last_success_at='2026-09-09T00:00:00Z';assert.equal(f.context.sourceConnectionText('samboat',state),'登录已过期，请重新连接');state.platforms.samboat.last_success_at=null;state.cloud.sources.samboat.checkedAt=1790000000000;assert.equal(f.context.sourceConnectionText('samboat',state),'登录已过期，请重新连接');});
test('maintenance login creates a labeled new-window link and uses fixed login API',async()=>{const f=frontend(after.ORDER_SYNC_HTML,true),calls=[];const active=allState(),expiry=Date.now()+60000;active.cloud.active={kind:'login',source:'boataround',deadlineAt:expiry};f.context.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/login')?{status:'login_required',liveViewUrl:'https://live.browser.run/ui/view?wss=ephemeral',expiresAt:expiry}:{order_sync:active}));};await f.context.performSyncAction('login','boataround');assert.equal(calls[0].url,'/api/cloud-sync/login');assert.equal(calls[0].options.body,'{"source":"boataround"}');assert.equal(f.document.getElementById('login-link-boataround').hidden,false);assert.ok(f.document.getElementById('login-link-boataround').href.startsWith('https://'));assert.match(f.document.getElementById('login-hint-boataround').textContent,/登录窗口有效至/);assert.match(f.document.getElementById('operation-message').textContent,/返回确认/);assert.ok(!f.document.getElementById('operation-message').textContent.includes('token='));});
test('maintenance rejects unsafe login links rather than navigating or embedding them',()=>{const f=frontend(after.ORDER_SYNC_HTML,true);for(const url of ['javascript:alert(1)','http://example.com/','https://user:secret@example.com/','invalid'])assert.equal(f.context.validatedLiveView(url),null);});
test('finish and schedule actions use exact endpoint names and JSON payloads',async()=>{const f=frontend(after.ORDER_SYNC_HTML,true),calls=[];f.context.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/finish')?{status:'connected'}:url.endsWith('/config')?{status:'updated'}:{order_sync:allState()}));};await f.context.performSyncAction('finish','samboat');await f.context.performSyncAction('enable');await f.context.performSyncAction('pause');const posts=calls.filter(item=>item.options?.method==='POST');assert.deepEqual(posts.map(item=>item.url),['/api/cloud-sync/finish','/api/cloud-sync/config','/api/cloud-sync/config']);assert.deepEqual(posts.map(item=>item.options.body),['{"source":"samboat"}','{"enabled":true}','{"enabled":false}']);});
test('maintenance API errors stay Chinese and do not reveal raw technical payloads',async()=>{const f=frontend(after.ORDER_SYNC_HTML,true);f.context.fetch=async()=>new Response(JSON.stringify({error:'session_cookie=hidden-value;stacktrace'}),{status:503});await f.context.performSyncAction('run');const message=f.document.getElementById('operation-message').textContent;assert.match(message,/同步服务暂时不可用/);assert.ok(!message.includes('hidden-value'));});

function loginFailureState(){return {platforms:{},cloud:{active:null,sources:{boataround:{status:'auth_required',checkedAt:null}},lastLoginFailure:{operation:'start',source:'boataround',stage:'get_live_view',category:'protocol',at:Date.parse('2026-09-08T04:31:00Z'),elapsedMs:2300,sessionIdentified:true}}};}
test('maintenance shows a source-scoped Chinese login diagnostic in its existing issue area',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState();f.context.renderSyncStatus(state);assert.equal(f.document.getElementById('issue-boataround').textContent,'上次连接未完成：生成登录窗口链接时，云浏览器通信失败。时间：2026-09-08 12:31:00（北京时间）。');assert.equal(f.document.getElementById('issue-clickandboat').textContent,'');assert.equal(f.document.getElementById('issue-samboat').textContent,'');assert.equal(f.document.getElementById('issue-boataround').innerHTML,'');state.cloud.lastLoginFailure.operation='resume';state.cloud.lastLoginFailure.stage='connect';state.cloud.lastLoginFailure.category='provider_connect';f.context.renderSyncStatus(state);assert.match(f.document.getElementById('issue-boataround').textContent,/上次恢复登录窗口未完成：恢复云浏览器连接时，云浏览器服务暂时无法连接/);});
test('login diagnostics never echo unknown strings, inherited properties or remote secrets',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState();Object.assign(state.cloud.lastLoginFailure,{stage:'Cookie: secret-stage',category:'<img src=x onerror=secret-category>',message:'secret-message',stack:'secret-stack',sessionId:'secret-session',liveViewUrl:'https://live.browser.run/?jwt=secret-jwt',cookies:[{value:'secret-cookie'}]});f.context.renderSyncStatus(state);let text=f.document.getElementById('issue-boataround').textContent;assert.match(text,/云端登录时，原因暂未确定/);assert.doesNotMatch(text,/secret|Cookie|<img|jwt=/);for(const value of ['constructor','toString','__proto__']){state.cloud.lastLoginFailure.stage=value;state.cloud.lastLoginFailure.category=value;text=f.context.loginFailureText('boataround',state);assert.match(text,/云端登录时，原因暂未确定/);assert.ok(!text.includes(value));}state.cloud.lastLoginFailure.operation='secret-operation';assert.equal(f.context.loginFailureText('boataround',state),'');});
test('an old login diagnostic cannot override a later or simultaneous successful connection or collection',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState(),at=state.cloud.lastLoginFailure.at;state.cloud.sources.boataround={status:'connected',checkedAt:at-1};assert.match(f.context.loginFailureText('boataround',state),/上次连接未完成/);for(const checkedAt of [at,at+1]){state.cloud.sources.boataround.checkedAt=checkedAt;f.context.renderSyncStatus(state);assert.equal(f.document.getElementById('connection-boataround').textContent,'已连接');assert.equal(f.document.getElementById('issue-boataround').textContent,'');}state.cloud.sources.boataround={status:'auth_required',checkedAt:at+1000};state.platforms.boataround={last_success_at:new Date(at).toISOString()};assert.equal(f.context.loginFailureText('boataround',state),'');state.platforms.boataround.last_success_at=new Date(at-1).toISOString();assert.match(f.context.loginFailureText('boataround',state),/上次连接未完成/);});
test('a diagnostic stays hidden through the same platform active login phases',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState();for(const phase of ['launching','login','resuming','finishing','closing']){state.cloud.active={kind:'login',source:'boataround',phase,deadlineAt:Date.now()+60000};f.context.renderSyncStatus(state);assert.equal(f.document.getElementById('issue-boataround').textContent,'',phase);}state.cloud.active={kind:'login',source:'samboat',phase:'login',deadlineAt:Date.now()+60000};assert.match(f.context.loginFailureText('boataround',state),/上次连接未完成/);});
test('invalid diagnostic metadata is ignored and existing collection explanations remain available',()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState();state.platforms.boataround={last_error:'fetch_failed'};for(const at of [null,'2026-09-08T04:31:00Z',NaN,-1,0]){state.cloud.lastLoginFailure.at=at;f.context.renderSyncStatus(state);assert.equal(f.document.getElementById('issue-boataround').textContent,'平台暂时无法读取，已保留上次订单。');}});
test('failed login uses the persisted sanitized status diagnostic instead of raw response details',async()=>{const f=frontend(after.ORDER_SYNC_HTML,true),state=loginFailureState(),calls=[];state.cloud.lastLoginFailure.stage='navigate';state.cloud.lastLoginFailure.category='timeout';f.context.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/login')?{status:'unavailable',reason:'cloud_browser_unavailable',diagnostic:{stage:'secret-response-stage',message:'secret-cookie'}}:state));};await f.context.performSyncAction('login','boataround');assert.deepEqual(calls.map(item=>item.url),['/api/cloud-sync/login','/api/cloud-sync/status']);assert.match(f.document.getElementById('issue-boataround').textContent,/打开平台页面时，等待响应超时/);assert.match(f.document.getElementById('operation-message').textContent,/云端连接暂时不可用/);for(const node of f.nodes.values())assert.doesNotMatch(node.textContent,/secret-response|secret-cookie/);});

const RUN_ID='11111111-1111-4111-8111-111111111111',OLD_RUN_ID='22222222-2222-4222-8222-222222222222';
function phoneData(){const state=allState();state.agent={paired:true,online:true,state:'idle'};return dataWith(state);}
function manualStatus(phase='queued',outcomes={}){return {ok:true,mode:'phone',paired:true,online:true,enabled:true,state:phase==='running'?'running':'idle',requested_run_id:['queued','running'].includes(phase)?RUN_ID:null,manual_run:{id:RUN_ID,state:phase,requested_at:'2026-09-10T06:00:00Z',completed_at:['completed','awaiting_upload'].includes(phase)?'2026-09-10T06:04:00Z':null,results:Object.fromEntries(Object.entries(outcomes).map(([source,outcome])=>[source,{outcome,checked_at:'2026-09-10T06:03:00Z'}]))},order_sync:allState()};}
function respondPhone(f,getStatus,{runStatus=202,runResult={ok:true,status:'queued',requested_run_id:RUN_ID},data=phoneData()}={}){const calls=[];f.context.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url==='/api/agent/run'?runResult:url==='/api/agent/status'?getStatus():data),{status:url==='/api/agent/run'?runStatus:200});};return calls;}
const allSuccess={boataround:'success',clickandboat:'success',samboat:'success',mmk:'success',nausys:'success'};
test('dashboard replaces the original refresh button in place and exposes settings beside the query note',()=>{assert.equal((after.HTML.match(/id="refreshBtn"/g)||[]).length,1);assert.ok(after.HTML.includes('<button id="refreshBtn" class="secondary" type="button">立即同步</button>'));assert.match(after.HTML,/<p class="query-note">[^<]*<a href="\/sync">手机同步设置<\/a><\/p>/);});
test('phone click uses the machine queue user endpoint and polls while retaining old success times',async()=>{const f=frontend(after.HTML);setData(f,phoneData());const calls=respondPhone(f,()=>manualStatus());await f.context.loadData(true);assert.deepEqual(calls.map(x=>x.url),['/api/agent/run','/api/agent/status','/api/data']);assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body,'{}');assert.match(f.document.getElementById('meta').textContent,/同步已排队/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);assert.equal(f.document.getElementById('refreshBtn').textContent,'已排队');assert.equal(f.document.getElementById('refreshBtn').disabled,true);assert.deepEqual([...f.timers.values()].map(x=>x.delay),[5000]);assert.match(f.document.getElementById('syncMode').textContent,/每 3 小时/);});
test('a new page restores a pending manual task from the server without submitting again',async()=>{const f=frontend(after.HTML),calls=respondPhone(f,()=>manualStatus('running',{boataround:'success'}));await f.context.loadData(false);assert.deepEqual(calls.map(x=>x.url),['/api/data','/api/agent/status','/api/data']);assert.ok(calls.every(x=>x.options.method!=='POST'));assert.match(f.document.getElementById('meta').textContent,/手机正在同步本轮订单/);assert.match(f.document.getElementById('meta').textContent,/Boataround：最新订单已保存/);assert.match(f.document.getElementById('meta').textContent,/SamBoat：等待本轮结果/);assert.equal(f.document.getElementById('refreshBtn').disabled,true);});
test('phone polling proceeds from queued to actual partial failure and updates orders after status',async()=>{const f=frontend(after.HTML);setData(f,phoneData());let status=manualStatus();const calls=respondPhone(f,()=>status);await f.context.loadData(true);status=manualStatus('completed',{...allSuccess,samboat:'failure'});await f.context.loadData(false);assert.deepEqual(calls.slice(-2).map(x=>x.url),['/api/agent/status','/api/data']);assert.match(f.document.getElementById('meta').textContent,/4 个平台成功，1 个平台失败/);assert.match(f.document.getElementById('meta').textContent,/SamBoat：同步失败，保留上次订单/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/三平台最新订单已保存/);assert.equal(f.document.getElementById('refreshBtn').disabled,false);assert.equal(f.document.getElementById('refreshBtn').textContent,'立即同步');assert.deepEqual([...f.timers.values()].map(x=>x.delay),[30000]);});
test('only all three matching cloud receipts plus final phone acknowledgement show manual success',async()=>{const f=frontend(after.HTML);setData(f,phoneData());let status=manualStatus('running',allSuccess);respondPhone(f,()=>status);await f.context.loadData(true);assert.match(f.document.getElementById('meta').textContent,/正在确认手机本轮完成状态/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);status=manualStatus('completed',allSuccess);await f.context.loadData(false);assert.match(f.document.getElementById('meta').textContent,/手动同步完成，三平台最新订单已保存/);assert.match(f.document.getElementById('meta').textContent,/完成时间：2026-09-10 14:04:00（北京时间）/);});
test('an old completed manual object cannot fulfill a newly queued request',async()=>{const f=frontend(after.HTML);setData(f,phoneData());const old=manualStatus('completed',allSuccess);old.manual_run.id=OLD_RUN_ID;respondPhone(f,()=>old);await f.context.loadData(true);assert.match(f.document.getElementById('meta').textContent,/同步已排队/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);assert.equal(f.document.getElementById('refreshBtn').disabled,true);const withNewQueue={...old,requested_run_id:RUN_ID};assert.equal(f.context.phoneRunProgress(withNewQueue).phase,'queued');});
test('missing upload receipts never imply success but an acknowledged cleared queue allows retry',async()=>{const f=frontend(after.HTML);setData(f,phoneData());respondPhone(f,()=>manualStatus('awaiting_upload',{boataround:'success',clickandboat:'success'}));await f.context.loadData(false);assert.match(f.document.getElementById('meta').textContent,/本轮结果尚未全部接收/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);assert.equal(f.document.getElementById('refreshBtn').disabled,false);assert.equal(f.document.getElementById('refreshBtn').textContent,'重新同步');assert.deepEqual([...f.timers.values()].map(x=>x.delay),[5000]);});
test('invalid or unknown per-source receipt fields never establish all-platform success',()=>{const f=frontend(after.HTML);for(const change of [s=>{delete s.manual_run.results.samboat;},s=>{s.manual_run.results.samboat.checked_at='invalid';},s=>{s.manual_run.results.samboat.outcome='queued';},s=>{s.manual_run.completed_at=null;},s=>{s.requested_run_id=RUN_ID;}]){const s=manualStatus('completed',allSuccess);change(s);assert.equal(f.context.phoneRunProgress(s).successful,false);assert.doesNotMatch(f.context.phoneRunText(s,f.context.syncTime),/手动同步完成/);}});
test('repeated clicks are coalesced locally while a request is in flight and while queued',async()=>{const f=frontend(after.HTML);setData(f,phoneData());let release;const calls=respondPhone(f,()=>manualStatus()),base=f.context.fetch;f.context.fetch=async(url,options)=>{if(url==='/api/agent/run')await new Promise(resolve=>release=resolve);return base(url,options);};const first=f.context.loadData(true);await f.context.loadData(true);release();await first;await f.context.loadData(true);assert.equal(calls.filter(x=>x.url==='/api/agent/run').length,1);});
test('a lost POST response resumes the same server task on polling without resubmitting',async()=>{const f=frontend(after.HTML);setData(f,phoneData());const calls=respondPhone(f,()=>manualStatus()),base=f.context.fetch;f.context.fetch=async(url,options)=>{if(url==='/api/agent/run')throw new TypeError('network');return base(url,options);};await f.context.loadData(true);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);await f.context.loadData(false);assert.match(f.document.getElementById('meta').textContent,/同步已排队/);assert.ok(calls.every(x=>x.options.method!=='POST'));});
test('a failed manual POST keeps its error visible rather than replacing it with old completed success',async()=>{const f=frontend(after.HTML);setData(f,phoneData());respondPhone(f,()=>manualStatus('completed',allSuccess),{runStatus:503,runResult:{error:'secret-cookie'}});await f.context.loadData(true);assert.match(f.document.getElementById('meta').textContent,/同步服务暂时不可用/);assert.doesNotMatch(f.document.getElementById('meta').textContent,/secret-cookie|手动同步完成/);});
test('offline pending phone remains queued and does not time out into a false successful result',async()=>{const f=frontend(after.HTML);setData(f,phoneData());const status=manualStatus();status.online=false;respondPhone(f,()=>status);await f.context.loadData(false);assert.match(f.document.getElementById('meta').textContent,/手机暂未连接/);assert.equal(f.document.getElementById('refreshBtn').disabled,true);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);});
test('background tabs pause polling and visibility resumes a read-only status check',async()=>{const f=frontend(after.HTML);setData(f,phoneData());const calls=respondPhone(f,()=>manualStatus());await f.context.loadData(false);f.document.hidden=true;f.events.get('visibilitychange')();assert.equal(f.timers.size,0);f.document.hidden=false;f.events.get('visibilitychange')();await new Promise(resolve=>setImmediate(resolve));assert.ok(calls.filter(x=>x.url==='/api/agent/status').length>=2);assert.ok(calls.every(x=>x.options.method!=='POST'));});
test('phone polling does not reset the chosen dates, month or prior data on a status failure',async()=>{const f=frontend(after.HTML);setData(f,phoneData());f.document.getElementById('d1').value='2026-11-07';f.document.getElementById('d2').value='2026-11-13';vm.runInContext('monthIndex=3',f.context);f.context.fetch=async()=>new Response('{"error":"hidden-token"}',{status:503});await f.context.loadData(false);assert.equal(f.document.getElementById('d1').value,'2026-11-07');assert.equal(f.document.getElementById('d2').value,'2026-11-13');assert.equal(vm.runInContext('monthIndex',f.context),3);assert.equal(vm.runInContext('DATA.schema_version',f.context),2);assert.doesNotMatch(f.document.getElementById('meta').textContent,/hidden-token/);});
test('phone status authorization failure redirects to original login without exposing server payloads',async()=>{const f=frontend(after.HTML);setData(f,phoneData());f.context.fetch=async()=>new Response('{"error":"private"}',{status:401});await f.context.loadData(false);assert.equal(f.window.redirect,'/login');assert.doesNotMatch(f.document.getElementById('meta').textContent,/private/);});
test('phone maintenance shares strict manual receipts and its three-hour text has valid CSP hashes',()=>{const page=buildPhoneMaintenancePage();for(const value of [page.script,page.style])assert.ok(page.csp.includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));assert.match(page.html,/每 3 小时尝试一次/);assert.doesNotMatch(page.html,/每 6 小时/);assert.match(page.csp,/script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'/);const f=frontend(page.html.replace('refresh();setInterval','setInterval'));f.context.render(manualStatus('awaiting_upload',{boataround:'success'}));assert.match(f.document.getElementById('runtime').textContent,/本轮结果尚未全部接收/);assert.equal(f.document.getElementById('run').disabled,false);assert.equal(f.document.getElementById('run').textContent,'重新同步');f.context.render(manualStatus('completed',{...allSuccess,samboat:'failure'}));assert.match(f.document.getElementById('runtime').textContent,/1 个平台失败/);assert.equal(f.document.getElementById('run').disabled,false);});

test('retry after terminally missing uploads submits a new run and never reuses the previous partial results',async()=>{
 const f=frontend(after.HTML);setData(f,phoneData());let status=manualStatus('awaiting_upload',{boataround:'success'});status.manual_run.id=OLD_RUN_ID;
 const calls=respondPhone(f,()=>status),base=f.context.fetch;
 await f.context.loadData(false);assert.equal(f.document.getElementById('refreshBtn').disabled,false);
 f.context.fetch=async(url,options)=>{if(url==='/api/agent/run')status=manualStatus('queued');return base(url,options);};
 await f.context.loadData(true);
 assert.equal(calls.filter(call=>call.url==='/api/agent/run').length,1);assert.equal(calls.find(call=>call.url==='/api/agent/run').options.body,'{}');
 assert.match(f.document.getElementById('meta').textContent,/同步已排队/);assert.equal(f.document.getElementById('refreshBtn').disabled,true);
 assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成|Boataround：最新订单已保存/);
 status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;
 await f.context.loadData(false);assert.doesNotMatch(f.document.getElementById('meta').textContent,/手动同步完成/);
 status=manualStatus('completed',allSuccess);await f.context.loadData(false);
 assert.match(f.document.getElementById('meta').textContent,/手动同步完成，三平台最新订单已保存/);
});

test('retry is unavailable until a real completion acknowledgment clears the queue, and confirming stays blocked',async()=>{
 const fixtures=[manualStatus('queued'),manualStatus('running'),manualStatus('running',allSuccess),manualStatus('awaiting_upload',{boataround:'failure'}),manualStatus('awaiting_upload')];
 fixtures[3].requested_run_id=RUN_ID;fixtures[4].manual_run.completed_at=null;
 for(const status of fixtures){
  const f=frontend(after.HTML);setData(f,phoneData());const calls=respondPhone(f,()=>status);
  await f.context.loadData(false);assert.equal(f.context.phoneRunProgress(status).retryable,false);assert.equal(f.document.getElementById('refreshBtn').disabled,true);
  await f.context.loadData(true);assert.equal(calls.filter(call=>call.options.method==='POST').length,0);
  const page=buildPhoneMaintenancePage(),maintenance=frontend(page.html.replace('refresh();setInterval','setInterval'));
  maintenance.context.render(status);assert.equal(maintenance.document.getElementById('run').disabled,true);
 }
});

test('phone settings can retry acknowledged missing receipts without repairing or inventing them',async()=>{
 const page=buildPhoneMaintenancePage(),f=frontend(page.html.replace('refresh();setInterval','setInterval'));
 let status=manualStatus('awaiting_upload',{boataround:'failure',clickandboat:'success'});
 f.context.render(status);assert.equal(f.context.phoneRunProgress(status).pending,true);assert.equal(f.context.phoneRunProgress(status).successful,false);
 assert.equal(f.document.getElementById('run').textContent,'重新同步');assert.match(f.document.getElementById('runtime').textContent,/可以点击“重新同步”再试/);
 const calls=[];f.context.fetch=async(url,options)=>{
  calls.push({url,options});if(url==='/api/agent/run'){status=manualStatus('queued');return new Response(JSON.stringify({ok:true,status:'queued',requested_run_id:RUN_ID}),{status:202});}
  return new Response(JSON.stringify(status));
 };
 await f.context.action('run');assert.deepEqual(calls.map(call=>call.url),['/api/agent/run','/api/agent/status']);
 assert.equal(f.document.getElementById('run').disabled,true);assert.match(f.document.getElementById('runtime').textContent,/同步已排队/);
 await f.context.action('run');assert.equal(calls.filter(call=>call.url==='/api/agent/run').length,1);
});

function phoneEntry(settings){
 const f=settings?frontend(buildPhoneMaintenancePage().html.replace('refresh();setInterval','setInterval')):frontend(after.HTML);
 if(!settings)setData(f,phoneData());
 return {f,click:()=>settings?f.context.action('run'):f.context.loadData(true),read:()=>settings?f.context.refresh():f.context.loadData(false),text:()=>f.document.getElementById(settings?'runtime':'meta').textContent,button:()=>f.document.getElementById(settings?'run':'refreshBtn')};
}

test('both pages distinguish a saved manual receipt from a later automatic result, current activity and offline state',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings),status=manualStatus('completed',allSuccess);respondPhone(entry.f,()=>status);
  await entry.read();assert.match(entry.text(),/手动同步完成，三平台最新订单已保存/);
  // A later collection must not reuse the previous manual receipt as its success result.
  for(const p of Object.values(status.order_sync.platforms))p.last_success_at='2026-09-10T09:00:00Z';
  await entry.read();assert.match(entry.text(),/已收到后续同步结果/);assert.match(entry.text(),/上次手动同步结果：5 个平台成功，0 个平台失败/);
  assert.doesNotMatch(entry.text(),/三平台最新订单已保存/);assert.equal(entry.button().disabled,false);
  status.state='running';await entry.read();assert.match(entry.text(),/手机正在同步订单/);assert.doesNotMatch(entry.text(),/三平台最新订单已保存/);
  status.state='idle';status.order_sync.platforms.samboat.last_error='fetch_failed';status.order_sync.platforms.samboat.last_attempt_at='2026-09-10T12:00:00Z';status.order_sync.platforms.samboat.last_checked_at='2026-09-10T11:59:00Z';
  await entry.read();assert.match(entry.text(),/SamBoat：最近同步失败，保留上次订单/);assert.match(entry.text(),/上次手动同步结果/);
  status.online=false;await entry.read();assert.match(entry.text(),/手机暂未连接/);assert.doesNotMatch(entry.text(),/三平台最新订单已保存/);
 }
});

test('a later failed attempt and an active phone supersede old manual success even if no success timestamp advanced',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings),status=manualStatus('completed',allSuccess);respondPhone(entry.f,()=>status);
  status.order_sync.platforms.samboat.last_attempt_at='2026-09-10T09:00:00Z';status.order_sync.platforms.samboat.last_checked_at='2026-09-10T08:59:00Z';status.order_sync.platforms.samboat.last_error='auth_required';
  await entry.read();assert.match(entry.text(),/SamBoat：最近同步失败/);assert.doesNotMatch(entry.text(),/三平台最新订单已保存/);
  delete status.order_sync.platforms.samboat.last_attempt_at;delete status.order_sync.platforms.samboat.last_checked_at;delete status.order_sync.platforms.samboat.last_error;status.state='running';
  await entry.read();assert.match(entry.text(),/手机正在同步订单/);assert.match(entry.text(),/上次手动同步结果/);
 }
});

test('late delivery of this manual round keeps its successful result until a newer source observation arrives',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings),status=manualStatus('completed',allSuccess);respondPhone(entry.f,()=>status);
  // Both observation and receipt may arrive after the early completion ACK.
  for(const source of Object.keys(allSuccess)){
   status.manual_run.results[source].checked_at='2026-09-10T06:05:00Z';
   Object.assign(status.order_sync.platforms[source],{last_success_at:'2026-09-10T06:05:00Z',last_checked_at:'2026-09-10T06:05:00Z',last_attempt_at:'2026-09-10T06:10:00Z'});
  }
  await entry.read();assert.match(entry.text(),/手动同步完成，三平台最新订单已保存/);assert.doesNotMatch(entry.text(),/后续同步|上次手动/);
  status.order_sync.platforms.samboat.last_checked_at='2026-09-10T09:00:00Z';status.order_sync.platforms.samboat.last_error='fetch_failed';
  await entry.read();assert.match(entry.text(),/SamBoat：最近同步失败/);assert.match(entry.text(),/上次手动同步结果/);
 }
});

test('both buttons submit a fresh phone request and wait for that ID through stale, partial and completed responses',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings),{f}=entry;let status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;
  const calls=respondPhone(f,()=>status);await entry.read();await entry.click();
  const posts=calls.filter(call=>call.options.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/agent/run');assert.equal(posts[0].options.body,'{}');
  assert.match(entry.text(),/同步已排队/);assert.doesNotMatch(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,true);assert.equal(entry.button().textContent,'已排队');
  status=manualStatus('running',{boataround:'success'});await entry.read();assert.match(entry.text(),/手机正在同步本轮订单/);assert.match(entry.text(),/SamBoat：等待本轮结果/);assert.equal(entry.button().textContent,'同步中…');
  status=manualStatus('running',allSuccess);await entry.read();assert.match(entry.text(),/正在确认手机本轮完成状态/);assert.doesNotMatch(entry.text(),/手动同步完成/);
  status=manualStatus('completed',{...allSuccess,samboat:'failure'});await entry.read();assert.match(entry.text(),/4 个平台成功，1 个平台失败/);assert.doesNotMatch(entry.text(),/三平台最新订单已保存/);assert.equal(entry.button().disabled,false);
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
 }
});

test('HTTP success without a valid queue receipt is not reported as a queued or completed new run in either entry',async()=>{
 const receipts=[{},null,{ok:false,status:'queued',requested_run_id:RUN_ID},{ok:true,status:'queued'},{ok:true,status:'queued',requested_run_id:'invalid'},{ok:true,status:'queued',requested_run_id:RUN_ID,error:'private-cookie'}];
 for(const settings of [false,true])for(const receipt of receipts){
  const entry=phoneEntry(settings),status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;
  respondPhone(entry.f,()=>status,{runResult:receipt});await entry.read();await entry.click();
  assert.doesNotMatch(entry.text(),/同步已排队|手动同步完成|private-cookie/);assert.match(entry.text(),/无法确认|暂未完成|操作未完成/);assert.equal(entry.button().disabled,false);
 }
});

test('settings does not let an older in-flight status read undo a later new request',async()=>{
 const entry=phoneEntry(true),{f}=entry,old=manualStatus('completed',allSuccess);old.manual_run.id=OLD_RUN_ID;f.context.render(old);
 let releaseOld,reads=0;const calls=[];
 f.context.fetch=async(url,options)=>{calls.push({url,options});if(url==='/api/agent/run')return new Response(JSON.stringify({ok:true,status:'queued',requested_run_id:RUN_ID}),{status:202});if(++reads===1)return await new Promise(resolve=>{releaseOld=()=>resolve(new Response(JSON.stringify(old)));});return new Response(JSON.stringify(manualStatus()));};
 const oldRead=entry.read();await entry.click();releaseOld();await oldRead;
 assert.match(entry.text(),/同步已排队/);assert.doesNotMatch(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,true);assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
});

test('settings keeps a queue acknowledged by POST when the immediate status read fails and prevents a duplicate click',async()=>{
 const entry=phoneEntry(true),{f}=entry;f.context.render(manualStatus('completed',allSuccess));const calls=[];
 f.context.fetch=async(url,options)=>{calls.push({url,options});return url==='/api/agent/run'?new Response(JSON.stringify({ok:true,status:'queued',requested_run_id:RUN_ID}),{status:202}):new Response('{"error":"private-cookie"}',{status:503});};
 await entry.click();await entry.click();assert.equal(calls.filter(call=>call.options.method==='POST').length,1);assert.equal(entry.button().disabled,true);assert.match(entry.text(),/同步已排队/);assert.match(f.document.getElementById('message').textContent,/操作未完成/);assert.doesNotMatch(f.document.getElementById('message').textContent,/private-cookie/);
});

test('settings retains a failed retry error through the old acknowledged partial result',async()=>{
 const entry=phoneEntry(true),status=manualStatus('awaiting_upload',{boataround:'success'});status.manual_run.id=OLD_RUN_ID;
 respondPhone(entry.f,()=>status,{runStatus:503,runResult:{error:'private-cookie'}});await entry.read();await entry.click();await entry.read();
 assert.match(entry.text(),/操作未完成/);assert.doesNotMatch(entry.text(),/private-cookie|最新订单已保存/);assert.equal(entry.button().disabled,false);
});

test('settings recovers a lost POST response by reading the newly queued task without submitting twice',async()=>{
 const entry=phoneEntry(true),{f}=entry,old=manualStatus('completed',allSuccess);old.manual_run.id=OLD_RUN_ID;f.context.render(old);const calls=[];
 f.context.fetch=async(url,options)=>{calls.push({url,options});if(url==='/api/agent/run')throw new TypeError('private-cookie');return new Response(JSON.stringify(manualStatus()));};
 await entry.click();await entry.read();await entry.click();assert.equal(calls.filter(call=>call.options.method==='POST').length,1);assert.match(entry.text(),/同步已排队/);assert.doesNotMatch(entry.text(),/private-cookie|手动同步完成/);assert.equal(entry.button().disabled,true);
});

test('settings rejects malformed status and non-JSON errors while preserving the last saved platform timestamps',async()=>{
 const entry=phoneEntry(true),{f}=entry;f.context.render(manualStatus('completed',allSuccess));const stamp=f.document.getElementById('success-boataround').textContent;
 for(const value of ['<html>private-cookie</html>',JSON.stringify({ok:true,mode:'other',paired:true})]){
  f.context.fetch=async()=>new Response(value);await entry.read();assert.match(f.document.getElementById('message').textContent,/无法识别|无法确认/);assert.doesNotMatch(f.document.getElementById('message').textContent,/private-cookie|SyntaxError/);assert.equal(f.document.getElementById('success-boataround').textContent,stamp);
 }
 f.context.fetch=async()=>new Response('{"error":"private-cookie"}',{status:401});await entry.read();assert.equal(f.window.redirect,'/login');assert.doesNotMatch(f.document.getElementById('message').textContent,/private-cookie/);
});

test('both entries follow a newer task started in another page instead of keeping their old task queued forever',async()=>{
 for(const settings of [false,true])for(const firstObservedPhase of ['queued','completed']){
  const entry=phoneEntry(settings);let status=manualStatus('queued');const calls=respondPhone(entry.f,()=>status);await entry.click();
  status=manualStatus(firstObservedPhase,firstObservedPhase==='completed'?allSuccess:{});status.manual_run.id=OLD_RUN_ID;status.manual_run.requested_at='2026-09-10T06:10:00Z';status.requested_run_id=firstObservedPhase==='queued'?OLD_RUN_ID:null;
  await entry.read();
  if(firstObservedPhase==='queued'){
   const observed=settings?vm.runInContext('current.requested_run_id',entry.f.context):vm.runInContext('PHONE_SYNC_STATUS.requested_run_id',entry.f.context);assert.equal(observed,OLD_RUN_ID,'Track the server current active ID, not the now superseded original ID');
   assert.match(entry.text(),/已切换到更新的同步任务/);
   status=manualStatus('completed',allSuccess);await entry.read();assert.doesNotMatch(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,true,'An older A completion cannot replace the newer B task');
   status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;status.manual_run.requested_at='2026-09-10T06:10:00Z';await entry.read();
  }
  assert.match(entry.text(),/已显示更新的同步任务结果/);assert.match(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,false);assert.equal(calls.filter(call=>call.options.method==='POST').length,1,'Reading another page task must never submit a replacement');
 }
});

test('an older completed run or an inconsistent different active ID still cannot override this requested run',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings);let status=manualStatus('queued');respondPhone(entry.f,()=>status);await entry.click();
  status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;status.manual_run.requested_at='2026-09-10T05:00:00Z';await entry.read();assert.doesNotMatch(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,true);
  status=manualStatus('queued');status.requested_run_id=OLD_RUN_ID;status.manual_run.id='33333333-3333-4333-8333-333333333333';await entry.read();
  const observed=settings?vm.runInContext('current.requested_run_id',entry.f.context):vm.runInContext('PHONE_SYNC_STATUS.requested_run_id',entry.f.context);assert.equal(observed,RUN_ID);assert.equal(entry.button().disabled,true);
 }
});

test('server timestamp in the queue receipt recovers a newer completed task even if the first status request never succeeded',async()=>{
 for(const settings of [false,true]){
  const entry=phoneEntry(settings),{f}=entry;let statusFails=true,status=manualStatus('completed',allSuccess);status.manual_run.id=OLD_RUN_ID;status.manual_run.requested_at='2026-09-10T06:10:00Z';const calls=[];
  f.context.fetch=async(url,options)=>{calls.push({url,options});if(url==='/api/agent/run')return new Response(JSON.stringify({ok:true,status:'queued',requested_run_id:RUN_ID,requested_at:'2026-09-10T06:00:00Z'}),{status:202});if(url==='/api/agent/status')return statusFails?new Response('{"error":"unavailable"}',{status:503}):new Response(JSON.stringify(status));return new Response(JSON.stringify(phoneData()));};
  await entry.click();assert.equal(entry.button().disabled,true);statusFails=false;await entry.read();
  assert.match(entry.text(),/已显示更新的同步任务结果/);assert.match(entry.text(),/手动同步完成/);assert.equal(entry.button().disabled,false);assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
 }
});

test('a saved cancellation updates an existing cross-year availability query without changing its dates or selected month',async()=>{
 const f=frontend(after.HTML),data=phoneData(),boat={name:'Synthetic query boat',boataround_slug:'query-fixture',bookings:[{source:'clickandboat',booking_id:'111',status:'accepted',start:'2026-12-26',end:'2027-01-02',url:'https://www.clickandboat.com/uk/booking/111/detail',amount:'€100',amount_basis:'Synthetic'},{source:'samboat',booking_id:'222',status:'deposit_paid',start:'2027-01-01',end:'2027-01-08',url:'https://www.samboat.com/private/reservation/222',amount:'€200',amount_basis:'Synthetic'}]};data.boats=[boat];setData(f,data);
 f.document.getElementById('d1').value='2027-01-01';f.document.getElementById('d2').value='2027-01-02';vm.runInContext('monthIndex=4',f.context);f.context.window.checkAvail();assert.match(f.document.getElementById('result').innerHTML,/所选日期已有 2 笔有效订单/);
 const updated=structuredClone(data);updated.boats[0].bookings[1].status='cancelled';respondPhone(f,()=>manualStatus('completed',allSuccess),{data:updated});await f.context.loadData(false);
 assert.match(f.document.getElementById('result').innerHTML,/所选日期已有 1 笔有效订单/);assert.doesNotMatch(f.document.getElementById('result').innerHTML,/#222/);assert.match(f.document.getElementById('result').innerHTML,/#111/);assert.equal(f.document.getElementById('d1').value,'2027-01-01');assert.equal(f.document.getElementById('d2').value,'2027-01-02');assert.equal(vm.runInContext('monthIndex',f.context),4);
 f.document.getElementById('d1').value='2027-01-02';f.document.getElementById('d2').value='2027-01-03';f.context.window.checkAvail();assert.match(f.document.getElementById('result').innerHTML,/1\/1 艘可用/,'Checkout-day occupancy is released after cancellation of the other booking');
});
