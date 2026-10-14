import { CloudBrowserController, CLOUD_BROWSER_SOURCES } from './cloud-browser.mjs';
import { FREE_BROWSER_POLICY } from './cloud-browser-budget.mjs';
import { collectors, verifyAuth } from './collectors.mjs';

const CONFIG='cloud-sync:config';
const LAST='cloud-sync:last-run';
const defaults=()=>({enabled:false,nextAttemptAt:null,manualPending:false});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const sources=Object.keys(CLOUD_BROWSER_SOURCES);

async function readCloudBody(request){
 const fault=(message,status)=>Object.assign(new Error(message),{status});
 if(Number(request.headers.get('Content-Length'))>4096)throw fault('请求过大',413);
 const reader=request.body?.getReader();if(!reader)throw fault('请求格式错误',400);
 let size=0,text='',complete=false,rejectStop;const decoder=new TextDecoder();
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(fault('请求已中断',408));
 const timer=setTimeout(()=>rejectStop(fault('读取请求超时，请重试',408)),15000);
 request.signal.addEventListener('abort',abort,{once:true});
 try{
  if(request.signal.aborted)throw fault('请求已中断',408);
  while(true){const {done,value}=await Promise.race([reader.read(),stopped]);if(done){complete=true;break;}size+=value.byteLength;if(size>4096)throw fault('请求过大',413);text+=decoder.decode(value,{stream:true});}
  const value=JSON.parse(text+decoder.decode());if(!value||typeof value!=='object'||Array.isArray(value))throw fault('请求格式错误',400);return value;
 }finally{
  clearTimeout(timer);request.signal.removeEventListener('abort',abort);
  // A transport that never completes cancellation must not hold the request.
  if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();
 }
}

// One coordinator on the existing fleet Durable Object. Its native alarm runs
// independently of the visitor's browser and computer. No public auth bypass.
export class FleetCloudSync {
 constructor({storage,binding,puppeteer,ingest,registryStatus,now=Date.now,controller}) {
  Object.assign(this,{storage,binding,ingest,registryStatus,now});
  this.controller=controller||new CloudBrowserController({storage,binding,puppeteer,now});
  this.running=false;
 }
 async config(){return await this.storage.get(CONFIG)||defaults();}
 async change(update){return this.storage.transaction(async tx=>{const next=update(await tx.get(CONFIG)||defaults());await tx.put(CONFIG,next);return next;});}
 async status(){
  const [cfg,cloud,order_sync,last]=await Promise.all([this.config(),this.controller.status(),this.registryStatus(),this.storage.get(LAST)]);
  return {configured:!!this.binding,automatic_enabled:!!this.binding&&cfg.enabled,next_attempt_at:cfg.enabled&&cfg.nextAttemptAt?new Date(cfg.nextAttemptAt).toISOString():null,manual_pending:cfg.manualPending,cloud,order_sync,last_run:last||null};
 }
 async dataStatus(original){const status=await this.status();const {order_sync,...extras}=status;return {...original,...extras};}
 async reschedule(){
  const cfg=await this.config(),cloud=await this.controller.status();
  const at=cfg.manualPending?Math.max(this.now()+1000,cfg.manualNotBefore||0):cfg.enabled?(cfg.nextAttemptAt||this.now()+1000):Number.MAX_SAFE_INTEGER;
  if(!cloud.active&&at===Number.MAX_SAFE_INTEGER){await this.storage.deleteAlarm();return;}
  // A queued run must not poll every second during the operator's cloud login.
  const next=cloud.active?Math.max(at,cloud.active.deadlineAt):at;
  await this.storage.setAlarm(await this.controller.nextAlarmAt(next));
 }
 async handle(request){
  const path=new URL(request.url).pathname;
  if(path==='/api/cloud-sync/status'&&request.method==='GET')return json(await this.status());
  if(request.method!=='POST')return json({error:'不支持的请求方式'},405);
  if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')!=='same-origin')return json({error:'请从本站同步设置页面操作'},403);
  if((request.headers.get('Content-Type')||'').split(';')[0].trim()!=='application/json')return json({error:'请求格式错误'},415);
  if((await this.storage.get('phone-agent:state'))?.mode==='phone'&&!['/api/cloud-sync/cancel','/api/cloud-sync/resume','/api/cloud-sync/finish'].includes(path))return json({error:'已改用手机同步，请使用手机同步设置',reason:'phone_sync_selected'},409);
  if(!this.binding)return json({error:'云端浏览器尚未配置',reason:'not_configured'},503);
  let body;
  try{body=await readCloudBody(request);}
  catch(error){return json({error:error.status?error.message:'请求格式错误'},error.status||400);}
  try{
   if(['/api/cloud-sync/login','/api/cloud-sync/finish','/api/cloud-sync/resume','/api/cloud-sync/cancel'].includes(path)){
    if(!sources.includes(body.source))return json({error:'未知平台'},400);
    if(path.endsWith('/login')&&Object.hasOwn(body,'shortLogin')&&typeof body.shortLogin!=='boolean')return json({error:'短时登录选项必须为布尔值'},400);
    const result=path.endsWith('/login')?await this.controller.startLogin(body.source,{shortLogin:body.shortLogin===true}):path.endsWith('/resume')?await this.controller.resumeLogin(body.source):path.endsWith('/cancel')?await this.controller.cancelLogin(body.source):await this.controller.finishLogin(body.source,verifyAuth[body.source]);
    await this.reschedule();return json(result);
   }
   if(path==='/api/cloud-sync/run'){
    await this.change(cfg=>({...cfg,manualPending:true,manualNotBefore:null}));await this.reschedule();return json({status:'queued'},202);
   }
   if(path==='/api/cloud-sync/config'){
    if(typeof body.enabled!=='boolean')return json({error:'请指定是否开启自动同步'},400);
    await this.change(cfg=>({...cfg,enabled:body.enabled,nextAttemptAt:body.enabled?(cfg.nextAttemptAt||this.now()+1000):null}));
    await this.reschedule();return json(await this.status());
   }
   return json({error:'接口不存在'},404);
  }catch{return json({error:'云端操作暂时失败，现有订单已保留',reason:'cloud_operation_failed'},503);}
 }
 async alarm(){
  if(this.running)return;
  this.running=true;
  try{
   await this.controller.closeExpiredSession();
   if((await this.storage.get('phone-agent:state'))?.mode==='phone'){
    await this.change(cfg=>({...cfg,enabled:false,nextAttemptAt:null,manualPending:false,manualNotBefore:null}));return;
   }
   const cloud=await this.controller.status(),cfg=await this.config();
   if(!this.binding||cloud.active||(cfg.manualPending&&cfg.manualNotBefore>this.now())||(!cfg.manualPending&&(!cfg.enabled||cfg.nextAttemptAt>this.now())))return;
   const kind=cfg.manualPending?'manual':'scheduled';
   // Claim durably before remote work, preventing alarm retry replay after eviction.
   await this.change(current=>({...current,manualPending:false,nextAttemptAt:current.enabled?this.now()+FREE_BROWSER_POLICY.intervalMs:null}));
   const result=await this.controller.runSync({collectors,verifyAuth,kind});
   // An auth-required result can finish without ever reserving a browser. The
   // operator may have selected phone mode while runSync was awaiting storage.
   if((await this.storage.get('phone-agent:state'))?.mode==='phone')return;
   if(kind==='manual'&&result.status==='skipped'&&result.reason==='launch_rate_limit'&&Number.isSafeInteger(result.retryAt))await this.change(current=>({...current,manualPending:true,manualNotBefore:result.retryAt}));
   const runId=crypto.randomUUID(),stamp=new Date(this.now()).toISOString();
   let receipt=null;
   if(result.status!=='skipped'){
    const snapshots=sources.map(source=>{
     const item=result.sources?.[source];
     if(item?.status==='collected')return item.snapshot;
     return {source,run_id:runId+':'+source,checked_at:stamp,outcome:'failure',error_code:item?.status==='auth_required'?'auth_required':'fetch_failed'};
    });
    receipt=await this.ingest({schema_version:1,snapshots});
   }
   // Never persist order bodies, cookies, live-view links, or raw remote errors
   // into the public status record. Registry receipts already exclude those.
   if((await this.storage.get('phone-agent:state'))?.mode!=='phone')await this.storage.put(LAST,{attempted_at:stamp,status:result.status,reason:result.reason||null,sources:Object.fromEntries(sources.map(source=>[source,result.sources?.[source]?.status||'skipped'])),accepted:receipt?.results?.filter(r=>r.accepted&&r.outcome==='success').map(r=>r.source)||[]});
  }catch{
   await this.storage.put(LAST,{attempted_at:new Date(this.now()).toISOString(),status:'failed',reason:'cloud_operation_failed'});
  }finally{this.running=false;await this.reschedule();}
 }
}
