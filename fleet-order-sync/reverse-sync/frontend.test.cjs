'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {extractHTML}=require('../../cloudflare-migration/frontend-patch.cjs');
const path=require('node:path'),{createHash,webcrypto}=require('node:crypto');
// Compose the same frontend stages without publishing or rewriting build files.
let source=fs.readFileSync(path.join(__dirname,'../phone-agent-build/baseline-integrated-source.mjs'),'utf8');
for(const [file,name] of [['phone-agent-patch','patchPhoneAgent'],['booking-conflicts-patch','patchBookingConflicts'],['manual-reschedule-patch','patchManualReschedule'],['voltage-patch','patchVoltage'],['reverse-sync/frontend-patch','patchReverse'],['checkout-day-patch','patchCheckoutDay'],['manual-unavailability-patch','patchManualUnavailability'],['order-query-freshness-patch','patchOrderQueryFreshness']])source=require('../'+file+'.cjs')[name](source);
const html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function fixture(storage=new Map()){
 const events={},redirects=[];
 const context=vm.createContext({document:{querySelectorAll:()=>[],addEventListener(name,handler){(events[name]||=[]).push(handler);}},window:{location:{replace:url=>redirects.push(url)}},URL,console,crypto:webcrypto,AbortController,setTimeout,clearTimeout,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),context);
 context.plan={mode:'preview',targets:[{boat:'test',target:'clickandboat',source_count:1,fresh:false,status:'preview',segments:[{start:'2027-01-01',end:'2027-01-08',causes:['<img onerror=bad>']}]}],excluded:[]};
 vm.runInContext('REVERSE_PLAN=plan;',context);context.events=events;context.redirects=redirects;context.storage=storage;return context;
}
test('preview says not written, escapes data and explicitly shows stale evidence',()=>{
 const c=fixture(),out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/尚未自动关档/);assert.match(out,/写入前需重新核查/);assert.match(out,/&lt;img/);assert.doesNotMatch(out,/<img/);
});
test('read failure does not claim success or replace existing order data',()=>{
 const c=fixture();vm.runInContext('REVERSE_ERROR=true;REVERSE_PLAN=null;',c);
 assert.match(c.boatReverse({boataround_slug:'test'}),/预览读取失败/);
 assert.doesNotMatch(c.boatReverse({boataround_slug:'test'}),/已同步/);
});
test('compiled dashboard remains valid JavaScript',()=>{new vm.Script(script);});
test('close-only receipts name the out-of-date platforms and never claim full completion or reopening',()=>{
 const c=fixture();c.plan.mode='guarded_release';c.plan.targets[0].execution={state:'protected_partial',stale_sources:['clickandboat','<b>x'],checked_at:'2026-09-29T02:00:00Z'};
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/已按现有订单设为不可预订；部分平台订单未更新，暂不恢复可预订（Click&amp;Boat、&lt;b&gt;x 订单未更新）/);
 assert.doesNotMatch(out,/所需日期已关档/);assert.doesNotMatch(out,/<b>x/);
});
test('an access check on a platform is shown as a person-to-complete step, not as a login or network fault',()=>{
 const c=fixture();c.plan.mode='guarded_release';c.plan.targets[0].execution={state:'needs_review',error:'platform_challenge',checked_at:'2026-09-29T02:00:00Z'};
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/平台要求人工完成访问验证，程序无法自动通过/);assert.doesNotMatch(out,/登录已失效/);
});

test('guarded reopening remains visibly conditional and retains review warning',()=>{
 const c=fixture();c.plan.mode='guarded_release';c.plan.targets[0].execution={state:'removal_requires_verification',checked_at:'2026-09-13T06:00:00Z'};
 const out=c.boatReverse({boataround_slug:'test'});assert.match(out,/自动开关档/);assert.match(out,/旧保护保留/);
});
test('close-only execution shows the actual receipt without claiming automatic reopening',()=>{
 const c=fixture();c.plan.mode='close_only';c.plan.targets[0].execution={state:'protected',checked_at:'2026-09-13T06:00:00Z'};
 const out=c.boatReverse({boataround_slug:'test'});assert.match(out,/开放需核对/);assert.match(out,/所需日期已关档/);assert.match(out,/北京时间/);assert.doesNotMatch(out,/尚未自动关档/);
});

test('confirmed MMK login failure gives the browser recovery action',()=>{
 const c=fixture(),target=c.plan.targets[0];c.plan.mode='guarded_release';target.target='mmk';
 target.execution={state:'needs_review',error:'mmk_auth_required',checked_at:'2026-09-13T06:00:00Z'};
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/登录已失效/);assert.match(out,/手机 Chrome/);assert.match(out,/保存的密码/);
 assert.doesNotMatch(out,/所需日期已关档/);
});

test('source freshness failure explains collecting orders again before reverse writes',()=>{
 const c=fixture();c.plan.targets[0].execution={state:'needs_review',error:'source_changed_or_stale'};
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/订单数据已变化或核验过期/);assert.match(out,/立即同步/);
});

test('cloud network check failure explains preserved dates and retry rather than expired platform login',()=>{
 const c=fixture(),target=c.plan.targets[0];target.execution={state:'needs_review',error:'reverse_plan_unavailable'};
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/手机读取云端订单计划时网络中断/);assert.match(out,/已有档期保留/);assert.match(out,/立即同步重试/);
 assert.doesNotMatch(out,/登录已失效|所需日期已关档/);
});

test('arbitrary platform error text is never rendered and successful receipt ignores an old failure',()=>{
 const c=fixture(),target=c.plan.targets[0];
 target.execution={state:'needs_review',error:'token=private-value <img src=x onerror=bad>'};
 let out=c.boatReverse({boataround_slug:'test'});assert.doesNotMatch(out,/private-value|token=|<img src=x/);
 target.execution={state:'protected',error:'mmk_auth_required'};out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/所需日期已关档/);assert.doesNotMatch(out,/登录已失效/);
});

test('non-whitelisted prototype property names remain generic errors',()=>{
 const c=fixture(),target=c.plan.targets[0];
 for(const error of ['constructor','__proto__','toString']){
  target.execution={state:'needs_review',error};const out=c.boatReverse({boataround_slug:'test'});
  assert.match(out,/需核对，未确认完成/);assert.doesNotMatch(out,/function Object|native code|object Object/);
 }
});

test('unopened dates are visible outside collapsed details and mark only the exact days',()=>{
 const c=fixture(),t=c.plan.targets[0];t.target='boataround';t.execution={state:'removal_requires_verification',retained_ranges:[{start:'2027-01-01',end:'2027-01-03'}]};
 const boat={boataround_slug:'test',name:'Fixture boat',bookings:[]};
 const out=c.boatReverse(boat);assert.ok(out.indexOf('class="release-review"')<out.indexOf('<details'));assert.match(out,/2027-01-01 至 2027-01-02/);
 const cal=c.calendar(boat,new Date(2027,0,1),{pairs:[]});assert.equal((cal.match(/class="release-day-label"/g)||[]).length,2);assert.match(cal,/2027-01-02 恢复可预订待核验/);assert.doesNotMatch(cal,/2027-01-03 恢复可预订待核验/);
});
test('ordinary manual closures and resolved platform records get no reopen badge; every platform\'s kept records do (2026-10-10)',()=>{
 const c=fixture(),t=c.plan.targets[0],boat={boataround_slug:'test'};
 assert.equal(c.releaseReviewNotice(boat),'');
 // SamBoat and Click&Boat records the program kept are listed too (Boataround only before).
 for(const target of ['samboat','clickandboat']){
  t.target=target;t.execution={retained_ranges:[{start:'2027-01-30',end:'2027-02-06'}]};
  const out=c.releaseReviewNotice(boat);assert.match(out,new RegExp((target==='samboat'?'SamBoat':'Click&amp;Boat|Click&Boat')+'.*恢复可预订待核验'));assert.match(out,/2027-01-30 至 2027-02-05/);
 }
 t.target='boataround';t.execution.retained_ranges=[];assert.equal(c.releaseReviewNotice(boat),'');
 t.execution.retained_ranges=[{start:'<img src=x>',end:'2027-01-03'}];assert.equal(c.releaseReviewNotice(boat),'');
 t.target='unknown';t.execution.retained_ranges=[{start:'2027-01-01',end:'2027-01-03'}];assert.equal(c.releaseReviewNotice(boat),'');
});

function holdFixture(storage){
 const c=fixture(storage),t=c.plan.targets[0];
 c.plan.mode='guarded_release';t.target='boataround';t.fresh=true;t.source_count=0;
 t.boataround_control={version:1,enabled:true,revision:4,holds:[]};
 t.execution={state:'protected',checked_at:'2026-09-20T10:00:00Z',boataround_control_revision:4};
 c.control={ok:true,version:1,enabled:true,revision:4,window_start:'2026-09-20',window_end:'2027-12-20',holds:[{id:'legacy-fixture',boat:'test',start:'2027-10-01',end:'2027-10-02',active:true}]};
 c.baApplyControl(c.control);return c;
}
function stubRequest(c,fn){c.requestMock=fn;vm.runInContext('dashboardRequest=requestMock;',c);}
function response(status,data){return {response:{status,ok:status>=200&&status<300},data};}
function accepted(c,payload,revision=5){
 const holds=payload.action==='add'?[...c.control.holds,{id:'hold-1',boat:'test',start:payload.start,end:payload.end,active:true}]:c.control.holds.map(h=>h.id===payload.id?{...h,active:false}:h);
 return response(202,{ok:true,status:'saved_pending_sync',revision,holds,queue:{status:'queued',requested_run_id:'11111111-1111-4111-8111-111111111111'}});
}

test('manual hold submission includes checkout day and reports cloud save only as pending',async()=>{
 const c=holdFixture(),draft=c.baForm('test'),calls=[];draft.start='2026-12-31';draft.end='2027-01-02';
 stubRequest(c,async(url,payload)=>{calls.push({url,payload});return accepted(c,payload);});
 await c.baSubmitHold('test','add');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/reverse-sync/boataround-holds');
 assert.deepEqual({...calls[0].payload,request_id:'UUID'},{action:'add',revision:4,boat:'test',start:'2026-12-31',end:'2027-01-03',request_id:'UUID'});
 assert.match(calls[0].payload.request_id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
 const out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/2026-12-31 至 2027-01-02（含首尾）/);assert.match(out,/等待手机执行和平台回读/);assert.match(out,/云端保存不代表平台已关档/);
 assert.doesNotMatch(out,/最近回读已核对这一版/);assert.equal(draft.start,'2026-12-31');assert.equal(draft.end,'2027-01-02');
});

test('single day and leap day are inclusive; invalid, reversed, oversized and outside-window dates do not write',async()=>{
 for(const [start,end,expected] of [['2027-01-01','2027-01-01','2027-01-02'],['2028-02-29','2028-02-29','2028-03-01']]){
  const c=holdFixture(),draft=c.baForm('test');c.control.window_end='2029-01-01';c.baApplyControl(c.control);Object.assign(draft,{start,end});let sent;
  stubRequest(c,async(_url,payload)=>{sent=payload;return accepted(c,payload);});await c.baSubmitHold('test','add');assert.equal(sent.end,expected);
 }
 for(const [start,end] of [['','2027-01-01'],['2027-02-29','2027-03-01'],['2027-01-03','2027-01-02'],['2026-09-20','2027-09-20'],['2026-09-19','2026-09-20'],['2027-12-19','2027-12-20']]){
  const c=holdFixture();Object.assign(c.baForm('test'),{start,end});let calls=0;stubRequest(c,async()=>{calls++;});await c.baSubmitHold('test','add');assert.equal(calls,0,start+' '+end);assert.ok(c.baForm('test').message);
 }
});

test('rapid duplicate clicks are coalesced while accepted identical hold is not added again',async()=>{
 const c=holdFixture();Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-02'});let calls=0,finish;
 stubRequest(c,(_url,payload)=>{calls++;return new Promise(resolve=>{finish=()=>resolve(accepted(c,payload));});});
 const first=c.baSubmitHold('test','add');await c.baSubmitHold('test','add');assert.equal(calls,1);
 assert.match(c.boatReverse({boataround_slug:'test'}),/正在保存/);finish();await first;
 await c.baSubmitHold('test','add');assert.equal(calls,1);assert.match(c.baForm('test').message,/无需重复/);
});

test('unknown network outcome retries the same durable request after a page reload',async()=>{
 const storage=new Map(),c=holdFixture(storage);Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-02'});let firstPayload;
 stubRequest(c,async(_url,payload)=>{firstPayload=JSON.parse(JSON.stringify(payload));throw Error('network timeout');});await c.baSubmitHold('test','add');
 assert.match(c.boatReverse({boataround_slug:'test'}),/重试确认上次保存/);
 const restored=holdFixture(storage);assert.equal(restored.baForm('test').start,'2027-01-01');assert.equal(restored.baForm('test').end,'2027-01-02');
 let secondPayload;stubRequest(restored,async(_url,payload)=>{secondPayload=JSON.parse(JSON.stringify(payload));return accepted(restored,payload);});
 await restored.baSendPending();assert.deepEqual(secondPayload,firstPayload);assert.equal(vm.runInContext('BA_HOLD_PENDING',restored),null);
});

test('revision conflict reloads current settings and retains edited dates for deliberate resubmission',async()=>{
 const c=holdFixture();Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-02'});const calls=[];
 stubRequest(c,async(url,payload)=>{calls.push(payload);return payload?response(409,{error:'hold_revision_conflict',revision:6}):response(200,{...c.control,revision:6});});
 await c.baSubmitHold('test','add');assert.equal(calls.length,2);assert.equal(vm.runInContext('BA_CONTROL.revision',c),6);assert.equal(vm.runInContext('BA_HOLD_PENDING',c),null);
 assert.equal(c.baForm('test').end,'2027-01-02');assert.match(c.baForm('test').message,/其他操作更新/);assert.doesNotMatch(c.baForm('test').message,/已保存/);
});

test('401 uses the established login redirect and never claims a platform write',async()=>{
 const c=holdFixture();Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-02'});
 c.fetch=async()=>({status:401});await c.baSubmitHold('test','add');
 assert.deepEqual(c.redirects,['/login']);assert.match(c.baForm('test').message,/登录已过期/);
 assert.equal(vm.runInContext('BA_CONTROL.revision',c),4);assert.equal(c.control.holds.length,1);
});

test('remove sends identity and revision only and leaves platform reopening conditional',async()=>{
 const c=holdFixture();c.control.holds=[{id:'hold-1',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.baApplyControl(c.control);let sent;
 stubRequest(c,async(_url,payload)=>{sent=payload;return accepted(c,payload);});await c.baSubmitHold('test','remove','hold-1');
 assert.deepEqual(Object.keys(sent).sort(),['action','id','request_id','revision']);assert.equal(sent.action,'remove');assert.equal(sent.id,'hold-1');
 const out=c.boatReverse({boataround_slug:'test'});assert.match(out,/恢复自动管理不会强制开放/);assert.match(out,/有有效订单的日期仍会关档/);assert.doesNotMatch(out,/2027-01-01 至 2027-01-02/);
});

test('AC2 locked release-only protection cannot be removed or represented as all future platform dates closed',async()=>{
 const c=holdFixture(),t=c.plan.targets[0];t.boataround_control.enabled=false;
 c.control.holds=[{id:'ac2-fixed',boat:'test',start:'2026-09-19',end:'2031-01-01',active:true,locked:true,release_only:true}];c.baApplyControl(c.control);
 let calls=0;stubRequest(c,async()=>{calls++;});Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-02'});
 await c.baSubmitHold('test','add');await c.baSubmitHold('test','remove','ac2-fixed');assert.equal(calls,0);
 const out=c.boatReverse({boataround_slug:'test'});assert.match(out,/2030-12-31/);assert.match(out,/仅保留既有档期/);assert.match(out,/不代表平台全时段已核验关档/);assert.doesNotMatch(out,/class="ba-hold-remove"|class="ba-hold-form"/);
});

test('only a fresh matching protected receipt confirms current settings; unresolved and older receipts stay distinct',()=>{
 const c=holdFixture(),t=c.plan.targets[0];
 assert.match(c.boatReverse({boataround_slug:'test'}),/最近回读已核对这一版/);
 for(const scenario of [{state:'protected',revision:3,fresh:true},{state:'needs_review',revision:4,fresh:true},{state:'protected',revision:4,fresh:false}]){
  t.execution.state=scenario.state;t.execution.boataround_control_revision=scenario.revision;t.fresh=scenario.fresh;
  const out=c.boatReverse({boataround_slug:'test'});assert.doesNotMatch(out,/最近回读已核对这一版/);
  if(scenario.revision!==4){assert.match(out,/待手机执行并回读|待手机执行和平台回读/);assert.match(out,/手机离线时等待恢复连接/);}
  else if(scenario.state!=='protected')assert.match(out,/最新平台状态尚未确认/);
  else assert.match(out,/这一版设置曾完成平台回读/);
 }
});

test('automatic data rerenders and input/toggle events preserve partially filled date and disclosure state',()=>{
 const c=holdFixture(),form={dataset:{baHoldBoat:'test'}},input={name:'start',value:'2027-01-01',closest:()=>form};
 for(const handler of c.events.input)handler({target:input});
 for(const handler of c.events.toggle)handler({target:{matches:selector=>selector==='details.ba-holds',dataset:{boatKey:'test'},open:true}});
 c.boatReverse({boataround_slug:'test'});c.boatReverse({boataround_slug:'test'});
 const restored=holdFixture(c.storage),out=restored.boatReverse({boataround_slug:'test'});
 assert.match(out,/class="ba-holds" data-boat-key="test" open/);assert.equal(restored.baForm('test').start,'2027-01-01');assert.equal(restored.baForm('test').end,'');assert.doesNotMatch(out,/class="ba-hold-form"/);
});

test('polling does not rebuild a focused native date input with an unfinished segment',async()=>{
 const c=holdFixture(),input={value:'',matches:selector=>selector==='.ba-hold-form input'};
 c.document.activeElement=input;
 c.renderBoats();c.renderBoats();assert.equal(vm.runInContext('BA_HOLD_RENDER_DEFERRED',c),true);
 let redraws=0;c.redraw=()=>{redraws++;};vm.runInContext('baRender=redraw;',c);c.document.activeElement=null;
 for(const handler of c.events.focusout)handler({target:input});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(redraws,1);
});

test('late GET cannot roll saved revision backwards and failed control read disables new writes',async()=>{
 const c=holdFixture();c.baApplyControl({...c.control,revision:8});c.baApplyControl({...c.control,revision:4});assert.equal(vm.runInContext('BA_CONTROL.revision',c),8);
 stubRequest(c,async()=>response(500,{error:'upstream private token'}));await c.readBoataroundControl();
 const out=c.boatReverse({boataround_slug:'test'});assert.match(out,/设置读取失败/);assert.match(out,/class="ba-hold-remove"[^>]* disabled/);assert.doesNotMatch(out,/private token/);
});

test('hold date, identity and messages cannot inject markup or expose arbitrary API error text',()=>{
 const c=holdFixture();c.control.holds=[{id:'x" onclick="bad',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true},{id:'bad-date',boat:'test',start:'<img src=x>',end:'2027-01-03',active:true},{id:'removed',boat:'test',start:'2027-01-04',end:'2027-01-05',active:false}];c.baApplyControl(c.control);
 c.baForm('test').message='<img src=x onerror=bad>';const out=c.boatReverse({boataround_slug:'test'});
 assert.doesNotMatch(out,/<img|onclick="bad|2027-01-04/);assert.match(out,/&lt;img/);
 for(const code of ['constructor','__proto__','token=private'])assert.equal(c.baHoldError(code),'保存未被接受；已有设置保留，请重新读取后核对。');
});

test('new hold controls keep strict CSP, date input sizing, small-screen stacking and explicit dark colors',()=>{
 const style=html.match(/<style>([\s\S]*?)<\/style>/)[1],policy=source.match(/"dashboard":\s*"([^"\n]+)"/)[1];
 assert.ok(policy.includes("script-src 'sha256-"+createHash('sha256').update(script).digest('base64')+"'"));
 assert.ok(policy.includes("style-src 'sha256-"+createHash('sha256').update(style).digest('base64')+"'"));
 const out=holdFixture().boatReverse({boataround_slug:'test'});assert.doesNotMatch(out,/\son(?:click|submit|input|toggle)=/);
 assert.match(style,/\.ba-hold-dates input\{[^}]*min-width:0[^}]*width:100%/);
 assert.match(style,/@media\(max-width:380px\)\{\.ba-hold-dates\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(style,/\.ba-hold-dates input\{color:#e8f4f8;background:#183744/);
});

test('successful hold notices follow current fresh receipts after polling without a page reload',async()=>{
 for(const action of ['add','remove']){
  const c=holdFixture(),t=c.plan.targets[0];
  c.control.holds=[{id:'hold-1',boat:'test',start:'2027-01-03',end:'2027-01-04',active:true}];c.baApplyControl(c.control);
  Object.assign(c.baForm('test'),{start:'2027-01-01',end:'2027-01-01'});
  let saved;
  stubRequest(c,async(_url,payload)=>{saved=accepted(c,payload);return saved;});
  await c.baSubmitHold('test',action,action==='remove'?'hold-1':undefined);
  assert.match(c.boatReverse({boataround_slug:'test'}),/等待手机/);
  const updated={...c.control,revision:5,holds:saved.data.holds};
  t.boataround_control={version:1,enabled:true,revision:5,holds:updated.holds};
  t.execution={state:'protected',checked_at:'2026-09-20T08:45:07Z',boataround_control_revision:5};
  c.plan.ok=true;
  stubRequest(c,async url=>response(200,url.endsWith('/preview')?c.plan:updated));
  await c.readReversePreview();
  let out=c.boatReverse({boataround_slug:'test'});
  assert.match(out,/当前.*设置已完成平台回读核对/);
  assert.doesNotMatch(out,/人工保留已保存，等待手机执行和平台回读|已恢复自动管理，等待手机重新核对/);
  t.fresh=false;out=c.boatReverse({boataround_slug:'test'});assert.match(out,/这一版设置曾完成平台回读/);assert.doesNotMatch(out,/当前.*设置已完成平台回读核对/);
  t.fresh=true;c.baApplyControl({...updated,revision:6});out=c.boatReverse({boataround_slug:'test'});assert.match(out,/等待手机/);assert.doesNotMatch(out,/当前.*设置已完成平台回读核对/);
  t.execution.boataround_control_revision=6;t.execution.state='needs_review';out=c.boatReverse({boataround_slug:'test'});assert.match(out,/最新平台状态尚未确认/);assert.doesNotMatch(out,/当前.*设置已完成平台回读核对/);
 }
});

test('focused partial native date stays intact while all reverse receipts and saved notice update live',()=>{
 const c=holdFixture(),t=c.plan.targets[0];
 c.control.revision=5;c.control.holds=[{id:'hold-1',boat:'test',start:'2027-01-01',end:'2027-01-02',active:true}];c.baApplyControl(c.control);
 Object.assign(c.baForm('test'),{notice:'saved',saved_revision:5,saved_action:'add',start:'2027-01-01',end:''});
 const mmk={...t,target:'mmk',execution:{state:'needs_review',error:'mmk_auth_required'}};c.plan.targets.push(mmk);
 const execution={dataset:{reverseExecutionBoat:'test',reverseExecutionTarget:'boataround'},textContent:''},otherExecution={dataset:{reverseExecutionBoat:'test',reverseExecutionTarget:'mmk'},textContent:''};
 const nodes=Object.fromEntries(['.ba-hold-state','button[type="submit"]','summary','.ba-hold-list','.ba-hold-empty','.ba-hold-message','.ba-hold-actions'].map(key=>[key,{textContent:'',innerHTML:'',hidden:false,disabled:false}]));
 const detail={dataset:{boatKey:'test'},querySelector:selector=>nodes[selector]||null};
 Object.defineProperty(detail,'innerHTML',{set(){throw Error('must not replace input ancestor');}});
 const input={value:'',rawNativeSegment:'2027-0_',matches:selector=>selector==='.ba-hold-form input'};
 c.document.activeElement=input;c.document.getElementById=id=>{if(id==='fleet-hold-boat')return null;throw Error('must not rebuild boats while editing');};
 c.document.querySelectorAll=selector=>selector==='[data-reverse-execution-boat]'?[execution,otherExecution]:selector==='details.ba-holds'?[detail]:[];
 c.renderBoats();assert.match(execution.textContent,/待手机/);assert.match(otherExecution.textContent,/登录已失效/);assert.match(nodes['.ba-hold-message'].textContent,/等待手机/);
 t.execution={state:'protected',checked_at:'2026-09-20T08:45:07Z',boataround_control_revision:5};
 mmk.execution={state:'protected',checked_at:'2026-09-20T08:46:07Z'};
 c.renderBoats();
 assert.match(nodes['.ba-hold-state'].textContent,/最近回读已核对这一版/);assert.match(nodes['.ba-hold-message'].textContent,/已完成平台回读核对/);assert.doesNotMatch(nodes['.ba-hold-message'].textContent,/等待手机/);
 assert.match(execution.textContent,/所需日期已关档/);assert.match(otherExecution.textContent,/最近核对/);assert.doesNotMatch(otherExecution.textContent,/登录已失效/);
 assert.match(nodes['.ba-hold-list'].innerHTML,/2027-01-01/);assert.equal(c.document.activeElement,input);assert.equal(input.rawNativeSegment,'2027-0_');assert.equal(input.value,'');assert.equal(c.baForm('test').end,'');
});

test('failed control refresh withdraws saved-notice confirmation until settings are read successfully again',async()=>{
 const c=holdFixture();Object.assign(c.baForm('test'),{notice:'saved',saved_revision:4,saved_action:'add'});
 assert.match(c.boatReverse({boataround_slug:'test'}),/当前人工保留设置已完成平台回读核对/);
 stubRequest(c,async()=>response(503,{error:'temporarily_unavailable'}));await c.readBoataroundControl();
 let out=c.boatReverse({boataround_slug:'test'});
 assert.match(out,/人工保留设置读取失败/);assert.match(c.baForm('test').message,/读取失败/);assert.doesNotMatch(out,/当前人工保留设置已完成平台回读核对/);
 stubRequest(c,async()=>response(200,c.control));await c.readBoataroundControl();
 out=c.boatReverse({boataround_slug:'test'});assert.match(out,/当前人工保留设置已完成平台回读核对/);assert.doesNotMatch(out,/人工保留设置读取失败/);
});

test('an already read-back revision with stale or abnormal sources is historical confirmation, not an unexecuted setting',()=>{
 const c=holdFixture(),t=c.plan.targets[0],control=c.baControl(t);t.fresh=false;
 const text=c.baHoldText(t,control);
 assert.equal(text,'这一版设置曾完成平台回读；订单状态需重新核验，下次同步会重新检查。');
 assert.doesNotMatch(text,/待手机执行|手机离线|已过期|最近回读已核对这一版/);
 c.baApplyControl({...c.control,revision:5});const newer=c.baHoldText(t,c.baControl(t));
 assert.match(newer,/设置待手机执行并回读确认/);assert.doesNotMatch(newer,/这一版设置曾完成平台回读/);
});

test('saved add and removal notices retain historical confirmation but control-read errors take precedence',async()=>{
 for(const action of ['add','remove']){
  const c=holdFixture(),t=c.plan.targets[0];t.fresh=false;Object.assign(c.baForm('test'),{notice:'saved',saved_revision:4,saved_action:action});
  c.boataroundHolds(t);assert.equal(c.baForm('test').message,'这一版设置曾完成平台回读；订单状态需重新核验，下次同步会重新检查。');
  assert.doesNotMatch(c.baForm('test').message,/等待手机|当前.*已完成/);
  stubRequest(c,async()=>response(503,{error:'temporarily_unavailable'}));await c.readBoataroundControl();
  const out=c.boataroundHolds(t);assert.match(c.baForm('test').message,/读取失败/);assert.doesNotMatch(out,/这一版设置曾完成平台回读|当前.*已完成/);
 }
});

function fleetFixture(storage){
 const c=fixture(storage);c.fleetData={schema_version:2,boats:[{boataround_slug:'test',name:'Test boat',bookings:[]},{boataround_slug:'coastline-sea-journey-42-tidewyn-cruise-2',name:'AC2',bookings:[]}]};
 c.fleetControl={ok:true,version:1,revision:3,window_start:'2026-09-20',window_end:'2027-12-20',holds:[]};
 c.plan.ok=true;c.plan.mode='guarded_release';c.plan.targets=['boataround','clickandboat','samboat','mmk'].map(target=>({boat:'test',target,status:'ready',fresh:true,source_count:0,segments:[],fleet_hold_control:{version:1,revision:3,holds:[]},execution:{state:'protected',fleet_hold_revision:3,checked_at:'2026-09-20T09:00:00Z'}}));
 vm.runInContext('DATA=fleetData;REVERSE_PLAN=plan;applyFleetHoldControl(fleetControl);',c);
 c.fleetDraft=vm.runInContext('FLEET_HOLD_DRAFT',c);Object.assign(c.fleetDraft,{boat:'test',start:'2027-01-01',end:'2027-01-02'});
 c.renderBoats=()=>{};return c;
}
function fleetSaved(c,payload,revision=4){return response(202,{ok:true,status:'saved_pending_sync',revision,operation_revision:revision,holds:payload.action==='add'?[...c.fleetControl.holds,{id:'global-hold-1',boat:payload.boat,start:payload.start,end:payload.end,active:true}]:c.fleetControl.holds.map(h=>h.id===payload.id?{...h,active:false}:h),queue:{status:'queued'}});}

test('one global select entry replaces per-boat BA additions while active legacy holds remain BA-only',()=>{
 assert.equal((html.match(/id="fleet-hold-form"/g)||[]).length,1);assert.match(html,/<select id="fleet-hold-boat" name="boat" required>/);assert.ok(html.indexOf('id="fleet-hold-panel"')<html.indexOf('<section aria-labelledby="calendar-title">'));
 const c=fleetFixture();assert.doesNotMatch(c.boatReverse({boataround_slug:'test'}),/ba-hold-form|旧 Boataround 保留/);
 const b=holdFixture(),out=b.boatReverse({boataround_slug:'test'});assert.match(out,/旧 Boataround 保留/);assert.match(out,/只影响 Boataround/);assert.match(out,/恢复自动管理/);assert.doesNotMatch(out,/class="ba-hold-form"|保存人工保留/);
});

test('global add uses selected boat inclusive dates and new endpoint; saving does not imply four-platform completion',async()=>{
 const c=fleetFixture();let sent;
 stubRequest(c,async(path,payload)=>{assert.equal(path,'/api/reverse-sync/fleet-holds');sent=payload;return fleetSaved(c,payload);});await c.submitFleetHold('add');
 assert.equal(sent.boat,'test');assert.equal(sent.start,'2027-01-01');assert.equal(sent.end,'2027-01-03');assert.equal(sent.revision,3);assert.match(sent.request_id,/^[a-f0-9-]{36}$/);
 const list=c.fleetHoldListHTML();assert.match(list,/2027-01-01 至 2027-01-02/);assert.equal((list.match(/等待手机执行和平台回读/g)||[]).length,4);assert.doesNotMatch(list,/fleet-hold-confirmed/);
 assert.equal(c.fleetData.boats[0].bookings.length,0);assert.doesNotMatch(list,/金额|已全部|已开放/);
});

test('global cancellation retains tombstone and each result without claiming platform reopening',async()=>{
 const c=fleetFixture();c.fleetControl.holds=[{id:'h',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.applyFleetHoldControl(c.fleetControl);let sent;
 stubRequest(c,async(_path,payload)=>{sent=payload;return fleetSaved(c,payload);});await c.submitFleetHold('remove','h');
 assert.deepEqual(Object.keys(sent).sort(),['action','id','request_id','revision']);assert.equal(c.fleetHoldRecords()[0].active,false);
 let out=c.fleetHoldListHTML();assert.match(out,/已取消设置 · 请查看平台回读/);assert.match(out,/不据此宣称平台已开放/);assert.equal((out.match(/等待手机执行和平台回读/g)||[]).length,4);
 for(const t of c.plan.targets){t.fleet_hold_control.revision=4;t.execution.fleet_hold_revision=4;}
 out=c.fleetHoldListHTML();assert.equal((out.match(/取消后的设置已核对；有其他保护仍会关档/g)||[]).length,4);assert.doesNotMatch(out,/取消手动锁档<\/button>/);
});

test('four-platform feedback separates missing mappings, missing MMK, failure, stale history and a current receipt',()=>{
 const c=fleetFixture();assert.equal(c.fleetHoldPlatformState('test','boataround').kind,'confirmed');
 c.plan.targets[1].execution={state:'needs_review',error:'auth_required'};assert.match(c.fleetHoldPlatformState('test','clickandboat').text,/登录已失效/);
 c.plan.targets[2].status='mapping_unknown';assert.deepEqual(JSON.parse(JSON.stringify(c.fleetHoldPlatformState('test','samboat'))),{source:'samboat',name:'SamBoat',kind:'unconfigured',text:'未配置，未自动关档'});
 c.plan.targets=c.plan.targets.filter(t=>t.target!=='mmk');assert.equal(c.fleetHoldPlatformState('test','mmk').kind,'unconfigured');assert.match(c.fleetHoldPlatformState('test','mmk').text,/未自动关档/);
 c.plan.targets[0].fresh=false;let s=c.fleetHoldPlatformState('test','boataround');assert.equal(s.kind,'historical');assert.match(s.text,/曾完成回读/);assert.doesNotMatch(s.text,/待执行|已过期/);
 c.applyFleetHoldControl({...c.fleetControl,revision:4});s=c.fleetHoldPlatformState('test','boataround');assert.equal(s.kind,'pending');
});

test('completed cancellations move into collapsed history without hiding active holds or changing controls',()=>{
 const c=fleetFixture();c.fleetControl.holds=[{id:'cancelled',boat:'test',start:'2027-01-01',end:'2027-01-03',active:false},{id:'active',boat:'test',start:'2027-02-01',end:'2027-02-03',active:true}];c.applyFleetHoldControl(c.fleetControl);
 const before=JSON.stringify(c.fleetHoldRecords()),out=c.fleetHoldListHTML(),cut=out.indexOf('<details id="fleet-hold-history"');
 assert.ok(cut>0);assert.match(out.slice(0,cut),/data-fleet-hold-id="active"/);assert.doesNotMatch(out.slice(0,cut),/data-fleet-hold-id="cancelled"/);
 assert.match(out.slice(cut),/^<details id="fleet-hold-history"><summary>已取消历史 · 1 条/);assert.match(out.slice(cut),/data-fleet-hold-id="cancelled"/);assert.match(out.slice(cut),/已取消 · 已核对/);assert.equal(JSON.stringify(c.fleetHoldRecords()),before);
 for(const t of c.plan.targets)t.fresh=false;assert.match(c.fleetHoldListHTML(),/id="fleet-hold-history"/);
 vm.runInContext('FLEET_HOLD_HISTORY_OPEN=true;',c);assert.match(c.fleetHoldListHTML(),/<details id="fleet-hold-history" open>/);
});

test('pending, failed, unreadable and unverified cancellations remain in the main list',()=>{
 const scenarios=[c=>{c.plan.targets[0].execution.fleet_hold_revision=2;},c=>{c.plan.targets[1].execution={state:'needs_review',error:'auth_required'};},c=>{c.plan.targets[2].execution.checked_at=null;},c=>vm.runInContext('REVERSE_ERROR=true;',c),c=>vm.runInContext('FLEET_HOLD_ERROR=true;',c),c=>vm.runInContext('REVERSE_PLAN=null;',c),c=>c.applyFleetHoldControl({...c.fleetControl,revision:4})];
 for(const change of scenarios){const c=fleetFixture();c.fleetControl.holds=[{id:'cancelled',boat:'test',start:'2027-01-01',end:'2027-01-03',active:false}];c.applyFleetHoldControl(c.fleetControl);change(c);const out=c.fleetHoldListHTML();assert.doesNotMatch(out,/id="fleet-hold-history"/);assert.match(out,/id="fleet-hold-current"[\s\S]*data-fleet-hold-id="cancelled"/);assert.match(out,/已取消设置 · 请查看平台回读/);}
});

test('cancelled history requires an actual mapped receipt and retains unconfigured platform notices',()=>{
 const c=fleetFixture();c.fleetControl.holds=[{id:'cancelled',boat:'test',start:'2027-01-01',end:'2027-01-03',active:false}];c.applyFleetHoldControl(c.fleetControl);c.plan.targets=c.plan.targets.filter(t=>t.target!=='mmk');c.plan.targets[2].status='mapping_unknown';
 let out=c.fleetHoldListHTML();assert.match(out,/id="fleet-hold-history"/);/* SamBoat unmapped, MMK and NauSYS (2026-10-09) absent for this boat */assert.equal((out.match(/未配置，取消结果未核对/g)||[]).length,3);assert.doesNotMatch(out,/全部平台.*成功|四个平台.*成功/);
 c.plan.targets=[];out=c.fleetHoldListHTML();assert.doesNotMatch(out,/id="fleet-hold-history"/);assert.match(out,/id="fleet-hold-current"/);
});

test('manual-only protected segments are described as closed without inventing paid source orders',()=>{
 const c=fleetFixture();for(const t of c.plan.targets){t.source_count=0;t.segments=[{start:'2027-01-01',end:'2027-01-03',causes:['manual_hold:h']}];assert.match(c.reverseExecutionText(t),/所需日期已关档/);assert.doesNotMatch(c.reverseExecutionText(t),/无待关闭日期/);}
 for(const t of c.plan.targets){t.segments=[];assert.match(c.reverseExecutionText(t),/无待关闭日期/);}
});

test('failed or not-yet-loaded preview is unknown instead of inventing four missing mappings',()=>{
 const c=fleetFixture();vm.runInContext('REVERSE_PLAN=null;REVERSE_ERROR=false;',c);
 for(const source of ['boataround','clickandboat','samboat','mmk']){const s=c.fleetHoldPlatformState('test',source);assert.equal(s.kind,'pending');assert.match(s.text,/正在读取/);assert.doesNotMatch(s.text,/未配置/);}
 vm.runInContext('REVERSE_ERROR=true;',c);for(const source of ['boataround','clickandboat','samboat','mmk']){const s=c.fleetHoldPlatformState('test',source);assert.equal(s.kind,'error');assert.match(s.text,/读取失败/);assert.doesNotMatch(s.text,/未配置/);}
});

test('merged global holds never masquerade as legacy BA holds when the legacy endpoint has failed',()=>{
 const c=fleetFixture(),t=c.plan.targets[0],global={id:'global-only',start:'2027-01-01',end:'2027-01-03',active:true},legacy={id:'legacy-only',start:'2027-02-01',end:'2027-02-03',active:true};
 t.fleet_hold_control.holds=[global];t.boataround_control={version:1,enabled:true,revision:7,holds:[global]};vm.runInContext('BA_CONTROL=null;BA_CONTROL_ERROR=true;',c);
 assert.equal(c.legacyBoataroundHolds(t),'');assert.equal(c.baControl(t).holds.length,0);
 t.boataround_control.holds.push(legacy);const out=c.legacyBoataroundHolds(t);assert.match(out,/旧 Boataround 保留/);assert.match(out,/2027-02-01/);assert.doesNotMatch(out,/2027-01-01|global-only/);assert.match(out,/读取失败/);assert.match(out,/disabled/);
});

test('malformed/out-of-window/too-long global holds and AC2 do not issue writes',async()=>{
 for(const values of [{boat:''},{boat:'unknown'},{boat:'coastline-sea-journey-42-tidewyn-cruise-2'},{start:'2027-02-29'},{start:'2027-01-04',end:'2027-01-03'},{start:'2026-09-19'},{end:'2027-12-20'},{start:'2026-09-20',end:'2027-09-20'}]){
  const c=fleetFixture();Object.assign(c.fleetDraft,values);let calls=0;stubRequest(c,async()=>{calls++;});await c.submitFleetHold('add');assert.equal(calls,0,JSON.stringify(values));assert.ok(vm.runInContext('FLEET_HOLD_MESSAGE',c));
 }
 const c=fleetFixture();c.fleetControl.holds=[{id:'fixed',boat:'coastline-sea-journey-42-tidewyn-cruise-2',start:'2026-09-19',end:'2031-01-01',active:true}];c.applyFleetHoldControl(c.fleetControl);let calls=0;stubRequest(c,async()=>{calls++;});await c.submitFleetHold('remove','fixed');assert.equal(calls,0);
});

test('global ambiguous response retains one UUID across retries and reload; fast clicks do not duplicate',async()=>{
 const storage=new Map(),c=fleetFixture(storage);let sent,calls=0,finish;
 stubRequest(c,(_url,payload)=>{sent=JSON.parse(JSON.stringify(payload));calls++;return new Promise((_resolve,reject)=>{finish=()=>reject(Error('lost response'));});});
 const first=c.submitFleetHold('add');await c.submitFleetHold('add');assert.equal(calls,1);finish();await first;
 const restored=fleetFixture(storage);let retried;stubRequest(restored,async(_url,payload)=>{retried=JSON.parse(JSON.stringify(payload));return fleetSaved(restored,payload);});await restored.sendFleetHoldPending();assert.deepEqual(retried,sent);assert.equal(vm.runInContext('FLEET_HOLD_PENDING',restored),null);
});

test('global revision conflict and 401 keep drafts and do not claim application',async()=>{
 const c=fleetFixture();stubRequest(c,async(_url,payload)=>payload?response(409,{error:'hold_revision_conflict',revision:8}):response(200,{...c.fleetControl,revision:8}));await c.submitFleetHold('add');
 assert.equal(vm.runInContext('FLEET_HOLD_CONTROL.revision',c),8);assert.equal(c.fleetDraft.end,'2027-01-02');assert.match(vm.runInContext('FLEET_HOLD_MESSAGE',c),/其他操作更新/);
 const auth=fleetFixture();auth.fetch=async()=>({status:401});await auth.submitFleetHold('add');assert.deepEqual(auth.redirects,['/login']);assert.equal(auth.fleetHoldRecords().length,0);assert.match(vm.runInContext('FLEET_HOLD_MESSAGE',auth),/登录已过期/);
});

test('cross-control identity conflict refreshes state and allows a new distinct request',async()=>{
 const c=fleetFixture(),ids=[];let round=0;
 stubRequest(c,async(_url,payload)=>{if(!payload)return response(200,c.fleetControl);ids.push(payload.request_id);return ++round===1?response(409,{error:'hold_identity_conflict'}):fleetSaved(c,payload);});
 await c.submitFleetHold('add');assert.match(vm.runInContext('FLEET_HOLD_MESSAGE',c),/记录标识.*冲突/);assert.equal(vm.runInContext('FLEET_HOLD_PENDING',c),null);assert.equal(c.fleetHoldRecords().length,0);
 await c.submitFleetHold('add');assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.equal(c.fleetHoldRecords().length,1);
});

test('global hold calendar and query occupancy are separate from order counts, amounts and AC2 fixed stop',()=>{
 const c=fleetFixture(),boat=c.fleetData.boats[0];c.fleetControl.holds=[{id:'h',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.applyFleetHoldControl(c.fleetControl);
 assert.equal(c.activeBookings(boat).length,0);assert.equal(c.knownOrders(boat).length,0);assert.deepEqual(JSON.parse(JSON.stringify(c.mergedOccupancy(boat))),[{start:'2027-01-01',end:'2027-01-02'}]);
 let cal=c.calendar(boat,new Date(2027,0,1),{pairs:[]});assert.equal((cal.match(/>手锁<\/span>/g)||[]).length,2);assert.match(cal,/2027-01-02 手动锁档/);assert.doesNotMatch(cal,/2027-01-03 手动锁档|>订<\/span>/);
 cal=c.calendar(c.fleetData.boats[1],new Date(2027,0,1),{pairs:[]});assert.equal((cal.match(/>停<\/span>/g)||[]).length,31);assert.doesNotMatch(cal,/>手锁<\/span>/);
 c.applyFleetHoldControl({...c.fleetControl,revision:4,holds:[{...c.fleetControl.holds[0],active:false}]});assert.equal(c.mergedOccupancy(boat).length,0);assert.equal(c.fleetHoldRecords().length,1);
});

function fleetDOM(c){
 const ids=['fleet-hold-boat','fleet-hold-start','fleet-hold-end','fleet-hold-details','fleet-hold-submit','fleet-hold-count','fleet-hold-message','fleet-hold-actions','fleet-hold-list'];
 const nodes=Object.fromEntries(ids.map(id=>[id,{id,value:'',innerHTML:'',textContent:'',dataset:{},open:false,disabled:false}]));c.document.getElementById=id=>nodes[id]||null;return nodes;
}
test('global native date form keeps node and unfinished segment while 4-platform results update',()=>{
 const c=fleetFixture(),nodes=fleetDOM(c);c.fleetControl.holds=[{id:'h',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.applyFleetHoldControl(c.fleetControl);c.fleetDraft.end='';
 const input=nodes['fleet-hold-end'];input.rawNativeSegment='2027-0_';c.document.activeElement=input;c.renderFleetHolds();assert.equal(input.value,'');assert.equal(c.document.activeElement,input);
 c.plan.targets[0].fresh=false;c.renderFleetHolds();assert.match(nodes['fleet-hold-list'].innerHTML,/本版曾完成回读/);assert.equal(input.rawNativeSegment,'2027-0_');assert.equal(input.value,'');assert.equal(c.document.activeElement,input);
 assert.match(nodes['fleet-hold-boat'].innerHTML,/<option value="coastline-sea-journey-42-tidewyn-cruise-2" disabled>/);
});

test('failed global reads keep known locks but cannot show current success or unqualified query availability',async()=>{
 const c=fleetFixture();c.fleetControl.holds=[{id:'h',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.applyFleetHoldControl(c.fleetControl);
 stubRequest(c,async()=>response(503,{}));await c.readFleetHoldControl(false);assert.equal(c.fleetHoldRecords().length,1);assert.equal(c.fleetHoldPlatformState('test','boataround').kind,'error');
 const result={hidden:true,innerHTML:''};c.document.getElementById=()=>result;let queried=0;c.window.checkAvail=()=>{queried++;};c.installFleetHoldQuery();c.window.checkAvail();assert.equal(queried,0);assert.match(result.innerHTML,/手动锁档尚未核验完整/);
 c.applyFleetHoldControl(c.fleetControl);c.window.checkAvail();assert.equal(queried,1);
});

test('global records escape untrusted labels and never execute inline handlers; 320px layout stacks controls',()=>{
 const c=fleetFixture();c.fleetData.boats[0].name='<img src=x onerror=bad>';c.fleetControl.holds=[{id:'h" onclick="bad',boat:'test',start:'2027-01-01',end:'2027-01-03',active:true}];c.applyFleetHoldControl(c.fleetControl);
 const out=c.fleetHoldListHTML();assert.match(out,/&lt;img/);assert.doesNotMatch(out,/<img|onclick="bad/);
 const panel=html.slice(html.indexOf('<section id="fleet-hold-panel"'),html.indexOf('<section aria-labelledby="calendar-title">'));assert.doesNotMatch(panel,/\son(?:click|submit|change|input)=/);
 assert.match(html,/@media\(max-width:600px\)\{\.fleet-hold-fields,\.fleet-hold-platforms\{grid-template-columns:minmax\(0,1fr\)/);assert.match(html,/\.fleet-hold-fields input,\.fleet-hold-fields select\{color:#e8f4f8;background:#173441/);
});
