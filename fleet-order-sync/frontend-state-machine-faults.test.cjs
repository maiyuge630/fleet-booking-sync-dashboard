'use strict';

// Isolated deterministic frontend transport model. No sockets, real accounts,
// browser profile, platform traffic, device access, or production writes.
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {patchOrderSync}=require('./worker/patch-order-sync.cjs');
const {patchSyncFrontend}=require('./frontend-sync-patch.cjs');
const {buildPhoneMaintenancePage}=require('./phone-agent-patch.cjs');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const base=fs.readFileSync(path.join(__dirname,'../cloudflare-boataround-orders/after/cloudflare.js'),'utf8');
const dashboard=extractHTML(patchSyncFrontend(patchOrderSync(base))),settings=buildPhoneMaintenancePage().html;
const SOURCES=['boataround','clickandboat','samboat','mmk'],START=Date.parse('2026-09-10T12:00:00Z');
const clone=value=>structuredClone(value),stamp=value=>new Date(value).toISOString();
function taskId(n){return String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';}
function defer(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

class ServiceModel{
 constructor(){this.now=START;this.serial=0;this.posts=0;this.delivery='normal';this.statusFailure=false;this.requests=[];this.state={ok:true,mode:'phone',paired:true,paired_at:stamp(START-86400000),name:'Synthetic phone',online:true,enabled:true,state:'idle',requested_run_id:null,manual_run:null,next_run_at:stamp(START+10800000),order_sync:{platforms:Object.fromEntries(SOURCES.map(source=>[source,{last_success_at:stamp(START-3600000),last_error:null}]))}};}
 queue(){if(!this.state.requested_run_id){this.now+=60000;const id=taskId(++this.serial);this.state.requested_run_id=id;this.state.manual_run={id,state:'queued',requested_at:stamp(this.now),completed_at:null,results:{}};}return {ok:true,status:'queued',requested_run_id:this.state.requested_run_id,requested_at:this.state.manual_run.requested_at};}
 begin(){this.state.state='running';this.state.manual_run.state='running';}
 receipt(source,outcome='success'){this.now+=1000;this.state.manual_run.results[source]={outcome,checked_at:stamp(this.now)};if(outcome==='success')this.state.order_sync.platforms[source].last_success_at=stamp(this.now);else this.state.order_sync.platforms[source].last_error='fetch_failed';if(this.state.manual_run.completed_at&&Object.keys(this.state.manual_run.results).length===SOURCES.length)this.state.manual_run.state='completed';}
 acknowledge(){this.now+=1000;this.state.requested_run_id=null;this.state.state='idle';this.state.manual_run.completed_at=stamp(this.now);this.state.manual_run.state=Object.keys(this.state.manual_run.results).length===SOURCES.length?'completed':'awaiting_upload';this.state.next_run_at=stamp(this.now+10800000);}
 complete(outcome='success'){this.begin();for(const source of SOURCES)this.receipt(source,source==='samboat'?outcome:'success');this.acknowledge();}
 replacePairing(){this.now+=60000;this.state={...this.state,paired_at:stamp(this.now),name:'Replacement synthetic phone',enabled:false,state:'idle',requested_run_id:null,manual_run:null,next_run_at:null};}
 data(){return {schema_version:2,boats:[],mapping_updated_at:stamp(START-3600000),order_sync:{agent:{paired:this.state.paired},automatic_enabled:this.state.enabled,next_attempt_at:this.state.next_run_at,platforms:clone(this.state.order_sync.platforms)}};}
 async fetch(url,options={}){
  this.requests.push({url,method:options.method||'GET'});
  if(url==='/api/agent/run'){
   this.posts++;if(this.delivery==='reject-before-delivery')return new Response('{"error":"agent_operation_failed"}',{status:503});if(this.delivery==='drop-before-delivery')throw new TypeError('Synthetic connection reset');
   const receipt=this.queue();if(this.delivery==='drop-after-delivery')throw new TypeError('Synthetic response lost');return new Response(JSON.stringify(receipt),{status:202});
  }
  if(url==='/api/agent/config'){this.state.enabled=JSON.parse(options.body).enabled;return new Response('{"ok":true}');}
  if(url==='/api/agent/status')return this.statusFailure?new Response('{"error":"agent_operation_failed"}',{status:503}):new Response(JSON.stringify(this.state));
  if(url==='/api/data')return new Response(JSON.stringify(this.data()));
  throw Error('Unexpected isolated model route: '+url);
 }
}

function frontend(mode,service,{now=START}={}){
 const nodes=new Map(),events=new Map(),timers=new Map();let timerSerial=0;
 class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',disabled:false,hidden:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(name,callback){events.set(name,callback);}};
 const window={location:{replace(url){window.redirect=url;}},addEventListener(){}};
 const context=vm.createContext({document,window,location:window.location,Date:FixedDate,URL,console,AbortController,TypeError,setTimeout(callback,delay){const id=++timerSerial;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},setInterval(){},clearInterval(){},fetch:service.fetch.bind(service)});
 const html=mode==='dashboard'?dashboard:settings;
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\binitialize\(\);\s*$/,'').replace('refresh();setInterval','setInterval'),context);
 if(mode==='dashboard'){context.fixtureData=service.data();vm.runInContext('DATA=fixtureData;renderBoats=()=>{};',context);}
 return {mode,context,document,nodes,events,timers,click:()=>mode==='dashboard'?context.loadData(true):context.action('run'),read:()=>mode==='dashboard'?context.loadData(false):context.refresh(),configure:enabled=>mode==='settings'?context.action(enabled?'enable':'pause'):Promise.reject(Error('Use settings to configure')),hide(){document.hidden=true;events.get('visibilitychange')?.();},async show(){document.hidden=false;events.get('visibilitychange')?.();await new Promise(resolve=>setImmediate(resolve));},button:()=>document.getElementById(mode==='dashboard'?'refreshBtn':'run'),text:()=>document.getElementById(mode==='dashboard'?'meta':'runtime').textContent,observed:()=>vm.runInContext(mode==='dashboard'?'PHONE_SYNC_STATUS':'current',context)};
}
const permutations=values=>values.length?values.flatMap((value,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[value,...rest])):[[]];

if(process.argv[2]==='--date-probe'){
 const now=Date.parse(process.argv[3]),service=new ServiceModel(),page=frontend('dashboard',service,{now}),booking={source:'samboat',booking_id:'17',start:'2026-09-09',end:'2026-09-11',status:'deposit_paid'},boat={name:'Date fixture',bookings:[booking]};
 console.log(JSON.stringify({browser_day:page.context.fmt(new page.context.Date()),beijing_timestamp:page.context.syncTime(now),visible_current_orders:page.context.knownOrders(boat).length,checkout_available:!page.context.dayStatus(boat,new Date(2026,8,1)).has('2026-09-11'),previous_day_occupied:page.context.dayStatus(boat,new Date(2026,8,1)).has('2026-09-10')}));
}else{
 test('all 96 endpoint/source-order/outcome traces require actual receipts and acknowledgment, including late upload after ACK',async()=>{
  for(const mode of ['dashboard','settings'])for(const order of permutations(SOURCES))for(const finalOutcome of ['success','failure']){
   const service=new ServiceModel(),page=frontend(mode,service);await page.read();await page.click();service.begin();service.receipt(order[0]);await page.read();assert.doesNotMatch(page.text(),/手动同步完成/);assert.equal(page.button().disabled,true);
   service.acknowledge();await page.read();assert.doesNotMatch(page.text(),/手动同步完成/);assert.equal(page.button().disabled,false,'Acknowledged partial upload allows an explicit retry');
   service.receipt(order[1]);await page.read();assert.doesNotMatch(page.text(),/手动同步完成/);
   service.receipt(order[2]);await page.read();assert.doesNotMatch(page.text(),/手动同步完成/);
   service.receipt(order[3],finalOutcome);await page.read();assert.equal(page.button().disabled,false);assert.equal(/手动同步完成/.test(page.text()),finalOutcome==='success');assert.equal(service.posts,1);
  }
 });

 test('hidden pages follow four newer rounds without an extra POST and do not revive an earlier completed response',async()=>{
  const service=new ServiceModel(),main=frontend('dashboard',service),maintenance=frontend('settings',service);await main.read();await maintenance.read();
  for(let round=0;round<4;round++){
   const actor=round%2?maintenance:main,observer=round%2?main:maintenance;await actor.read();await actor.click();observer.hide();const old=clone(service.state);service.complete();await actor.read();await actor.click();service.complete(round===2?'failure':'success');await observer.show();assert.equal(observer.observed().manual_run.id,service.state.manual_run.id);assert.equal(observer.button().disabled,false);
   const live=observer.context.fetch;observer.context.fetch=async url=>url==='/api/agent/status'?new Response(JSON.stringify(old)):live(url);await observer.read();observer.context.fetch=live;await observer.read();assert.equal(observer.observed().manual_run.id,service.state.manual_run.id);assert.equal(observer.button().disabled,false);
  }
  assert.equal(service.posts,8);
 });

 test('pause and enable during queued or acknowledged-partial work preserve the task and allow its late results',async()=>{
  const service=new ServiceModel(),main=frontend('dashboard',service),maintenance=frontend('settings',service);await main.read();await maintenance.read();await main.click();const id=service.state.requested_run_id;
  await maintenance.configure(false);await main.read();assert.equal(service.state.enabled,false);assert.equal(main.observed().requested_run_id,id);assert.equal(main.button().disabled,true);service.begin();service.receipt('boataround');service.acknowledge();await main.read();assert.equal(main.button().disabled,false);
  await maintenance.configure(true);assert.equal(service.state.manual_run.id,id);service.receipt('clickandboat');service.receipt('samboat');service.receipt('mmk');await main.read();await maintenance.read();assert.match(main.text(),/手动同步完成/);assert.match(maintenance.text(),/手动同步完成/);assert.equal(service.posts,1);
 });

 test('lost accepted POST responses recover from status without repeating work, even when automatic sync is paused',async()=>{
  for(const mode of ['dashboard','settings']){
   const service=new ServiceModel();service.state.enabled=false;service.delivery='drop-after-delivery';const page=frontend(mode,service);await page.read();await page.click();await page.read();assert.equal(page.observed().requested_run_id,service.state.requested_run_id);assert.equal(page.button().disabled,true);service.complete();await page.read();assert.match(page.text(),/手动同步完成/);assert.equal(page.button().disabled,false);assert.equal(service.posts,1);
  }
 });

 for(const mode of ['dashboard','settings'])for(const failure of ['reject-before-delivery','drop-before-delivery'])test(mode+': '+failure+' must not turn into the previous round success on later polling',async()=>{
   const service=new ServiceModel();service.queue();service.complete();const previousId=service.state.manual_run.id,page=frontend(mode,service);await page.read();service.delivery=failure;await page.click();assert.doesNotMatch(page.text(),/手动同步完成/);
   for(let poll=0;poll<3;poll++){await page.read();assert.equal(service.state.manual_run.id,previousId);assert.doesNotMatch(page.text(),/手动同步完成/,'No new task was ever created; the failed latest action must stay distinguishable from old success');}
   assert.equal(service.posts,1);assert.equal(page.button().disabled,false);
   service.delivery='normal';await page.click();assert.notEqual(service.state.requested_run_id,previousId);assert.match(page.text(),/同步已排队/);service.complete();await page.read();assert.match(page.text(),/手动同步完成/);assert.equal(service.posts,2);
 });

 for(const mode of ['dashboard','settings'])test(mode+': replacing the paired phone while the page is hidden must retire its never-completable old queue',async()=>{
  const service=new ServiceModel(),page=frontend(mode,service);await page.read();await page.click();const retiredId=service.state.requested_run_id;page.hide();service.replacePairing();await page.show();assert.match(page.text(),/手机已重新配对/);
  for(let poll=0;poll<3;poll++)await page.read();
  assert.equal(service.state.requested_run_id,null);assert.equal(service.state.manual_run,null);assert.equal(page.button().disabled,false,'The replacement phone has no old UUID to acknowledge');assert.doesNotMatch(page.text(),/同步已排队|手动同步完成/);
  await page.click();assert.notEqual(service.state.requested_run_id,retiredId);service.complete();await page.read();assert.match(page.text(),/手动同步完成/);assert.equal(service.posts,2);
 });

 test('missing old pairing metadata uses the server queue timestamp while older or malformed pairing readbacks cannot retire an active task',async()=>{
  for(const mode of ['dashboard','settings']){
   const service=new ServiceModel();delete service.state.paired_at;const page=frontend(mode,service);await page.read();await page.click();const active=clone(service.state),live=page.context.fetch;
   for(const paired_at of ['not-a-date',stamp(START-86400000)]){
    page.context.fetch=async(url,options)=>url==='/api/agent/status'?new Response(JSON.stringify({...active,paired_at,requested_run_id:null,manual_run:null})):live(url,options);await page.read();assert.equal(page.button().disabled,true);assert.equal(page.observed().requested_run_id,active.requested_run_id);
   }
   page.context.fetch=live;service.replacePairing();await page.read();assert.equal(page.button().disabled,false);assert.match(page.text(),/手机已重新配对/);assert.doesNotMatch(page.text(),/手动同步完成/);
  }
 });

 test('a new pairing with its own active task shows that phone state rather than acknowledging the retired task',async()=>{
  for(const mode of ['dashboard','settings']){
   const service=new ServiceModel(),page=frontend(mode,service);await page.read();await page.click();const retiredId=service.state.requested_run_id;service.replacePairing();service.queue();const currentId=service.state.requested_run_id;await page.read();assert.notEqual(currentId,retiredId);assert.equal(page.observed().requested_run_id,currentId);assert.match(page.text(),/手机已重新配对/);assert.equal(page.button().disabled,true);service.complete();await page.read();assert.match(page.text(),/手动同步完成/);assert.equal(page.button().disabled,false);assert.equal(service.posts,1,'Observing replacement phone work must not submit another task');
  }
 });

 test('late settings GET cannot undo a newly queued operation; dashboard loading prevents a competing click',async()=>{
  for(const mode of ['dashboard','settings']){
   const service=new ServiceModel();service.queue();service.complete();const old=clone(service.state),page=frontend(mode,service);await page.read();const wait=defer(),real=page.context.fetch;let held=true;page.context.fetch=async(url,options)=>{if(url==='/api/agent/status'&&held){held=false;return await wait.promise;}return real(url,options);};
   const reading=page.read();await page.click();wait.resolve(new Response(JSON.stringify(old)));await reading;if(mode==='dashboard')await page.click();await page.read();assert.equal(service.posts,1);assert.equal(page.observed().requested_run_id,service.state.requested_run_id);assert.equal(page.button().disabled,true);service.complete();await page.read();assert.equal(page.button().disabled,false);
  }
 });

 test('UTC and Beijing midnight keep checkout exclusion invariant; display timestamps explicitly use Beijing time',()=>{
  for(const timestamp of ['2026-09-10T15:59:59Z','2026-09-10T16:00:00Z','2026-09-10T23:59:59Z','2026-09-11T00:00:00Z'])for(const timezone of ['UTC','Asia/Shanghai']){
   const result=spawnSync(process.execPath,[__filename,'--date-probe',timestamp],{env:{...process.env,TZ:timezone},encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,0,result.stderr);const probe=JSON.parse(result.stdout);assert.equal(probe.checkout_available,true);assert.equal(probe.previous_day_occupied,true);assert.match(probe.beijing_timestamp,/（北京时间）$/);assert.equal(probe.visible_current_orders,probe.browser_day<'2026-09-11'?1:0);
   if(timestamp==='2026-09-10T16:00:00Z')assert.match(probe.beijing_timestamp,/2026-09-11 00:00:00/);
  }
 });
}
