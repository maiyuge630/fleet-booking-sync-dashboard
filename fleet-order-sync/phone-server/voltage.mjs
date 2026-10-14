import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {loadConfiguration,WorkerClient,writeJSON,readJSON} from './core.mjs';
const execute=promisify(execFile);
const DAY=86400000;
const fail=code=>Object.assign(new Error(code),{code});
const allowedErrors=new Set(['auth_required','fetch_failed','schema_changed','incomplete_pages','root_unavailable']);
const PERMANENT_UPLOAD_STATUSES=new Set([400,413,415,422]);
const MAX_RESPONSE_BYTES=1024*1024;
const MAX_DEVICES=100; // Same complete-snapshot limit as the cloud receiver.
async function reportJSON(response){
 // Bound bytes while reading, rather than after text() has already allocated
 // an arbitrarily large response on the always-on phone.
 if(!response.body)throw fail('schema_changed');
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   length+=value.byteLength;
   if(length>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});throw fail('schema_changed');}
   chunks.push(value);
  }
 }catch(e){throw fail(e.code==='schema_changed'?'schema_changed':'fetch_failed');}
 finally{reader.releaseLock();}
 try{
  const value=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
  return value;
 }catch{throw fail('schema_changed');}
}
export function nextVoltageRun(now){ // 09:00 Beijing, independent of phone timezone.
 const shifted=new Date(now+8*3600000),day=shifted.toISOString().slice(0,10);
 const candidate=Date.parse(day+'T01:00:00.000Z');return new Date(candidate>now?candidate:candidate+DAY).toISOString();
}
const unxml=s=>s.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function readAppAuthorization(xml){
 const get=k=>unxml(xml.match(new RegExp('<string name="'+k+'">([\\s\\S]*?)</string>'))?.[1]||'');
 const authorization=get('authorization'),company=get('company_key');
 if(!authorization||!company||/[\r\n]/.test(authorization+company))throw fail('auth_required');
 return {Authorization:authorization,CompanyKey:company,Devicetype:'3',Clientversion:'9.34.0','Accept-Language':'zh-CN'};
}
export async function phoneAuthorization(){
 try{
  const {stdout}=await execute('su',['-c','cat /data/user/0/net.jerrysoft.bsms/shared_prefs/js_sp.xml'],{timeout:10000,maxBuffer:1024*1024});
  return readAppAuthorization(stdout);
 }catch(e){throw fail(e.code==='auth_required'?'auth_required':'root_unavailable');}
}
export async function reportPages(headers,status,fetchImpl=fetch){
 const all=[],seen=new Set();let total=null;
 for(let page=1;page<=10;page++){
  // Same read-only international endpoint used by the installed app. Its HTTPS
  // port was unavailable during integration. No login or device commands here.
  const url=new URL('http://api.azlmap.com/Device/voltageStatisticsReport');
  for(const [k,v] of Object.entries({page,size:100,gpsType:0,orderType:'DESC',order:'vol',...(status===undefined?{}:{status})}))url.searchParams.set(k,String(v));
  let r;try{r=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw fail('fetch_failed');}
  if([401,403].includes(r.status))throw fail('auth_required');if(r.status!==200)throw fail('fetch_failed');
  const j=await reportJSON(r);
  if(j.errorCode!==0)throw fail('auth_required');
  const count=j.extraInfo?.countTotal;
  if(!Number.isInteger(count)||count<0||count>MAX_DEVICES||!Array.isArray(j.results)||j.resultCount!==j.results.length||j.extraInfo?.page!==page||![0,1].includes(j.endMark))throw fail('schema_changed');
  if(total!==null&&total!==count)throw fail('incomplete_pages');total=count;
  for(const d of j.results){if(!d||typeof d.vkey!=='string'||!d.vkey||seen.has(d.vkey))throw fail('incomplete_pages');seen.add(d.vkey);all.push(d);}
  if(j.endMark===1){if(all.length!==total)throw fail('incomplete_pages');return all;}
  if(!j.results.length)throw fail('incomplete_pages');
 }throw fail('incomplete_pages');
}
export async function readStationary(headers,row,fetchImpl=fetch){
 const url=new URL('http://api.azlmap.com/Link/carHomeDetail');
 url.searchParams.set('vkey',row.vkey);url.searchParams.set('gpsType','0');
 let r;try{r=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw fail('fetch_failed');}
 if([401,403].includes(r.status))throw fail('auth_required');if(r.status!==200)throw fail('fetch_failed');
 const j=await reportJSON(r);
 if(j.errorCode!==0)throw fail('auth_required');const d=j.results;
 if(!d||d.vkey!==row.vkey||d.carNum!==row.carNum||![0,1].includes(d.isConn)||![0,1].includes(d.isOverSpeed)||!Number.isFinite(d.speed)||d.speed<0)throw fail('schema_changed');
 const motion_state=d.isConn===0?'offline':d.speed===0&&d.isOverSpeed===0?'stationary':'moving';
 const stationary_time=d.stopTime==null||d.stopTime===''?null:d.stopTime;
 if(stationary_time!==null&&(typeof stationary_time!=='string'||stationary_time.length>80||/[<>\x00-\x1f\x7f]/.test(stationary_time)))throw fail('schema_changed');
 if(motion_state==='stationary'&&!stationary_time)throw fail('incomplete_pages');
 return {motion_state,stationary_time:motion_state==='moving'?null:stationary_time};
}
export function projectReadings(rows,lowRows,movement=new Map()){
 if(!rows.length)throw fail('incomplete_pages');
 if(rows.length>MAX_DEVICES)throw fail('schema_changed');
 if(['ADD','AD1','AD2','AD5','AD6','AC1','AC2'].some(code=>!rows.some(d=>d.carNum===code)))throw fail('incomplete_pages');
 const known=new Set(rows.map(d=>d.vkey)),low=new Set(lowRows.map(d=>d.vkey)),codes=new Set();
 if([...low].some(k=>!known.has(k)))throw fail('incomplete_pages');
 if(lowRows.some(d=>rows.find(r=>r.vkey===d.vkey)?.carNum!==d.carNum))throw fail('incomplete_pages');
 return rows.map(d=>{
  if(typeof d.carNum!=='string'||!/^[A-Z0-9-]{1,30}$/.test(d.carNum)||codes.has(d.carNum)||![0,1].includes(d.onlineStatus)||d.vol!==null&&(typeof d.vol!=='number'||!Number.isFinite(d.vol)||d.vol<0||d.vol>200))throw fail('schema_changed');codes.add(d.carNum);
  if(typeof d.connTime!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.connTime)||!Number.isFinite(Date.parse(d.connTime.replace(' ','T')+'Z'))||new Date(d.connTime.replace(' ','T')+'Z').toISOString().slice(0,19).replace('T',' ')!==d.connTime)throw fail('schema_changed');
  const motion=movement.get(d.vkey),online=d.onlineStatus===1&&motion?.motion_state!=='offline';
  // These endpoints are sampled separately. If either reports offline, retain
  // the readings as historical instead of presenting contradictory live data.
  return {code:d.carNum,volts:d.vol,online,power:({0:'power_off',1:'normal',6:'backup_low'})[d.ups]||'unknown',low_voltage:low.has(d.vkey),source_time:d.connTime,...(motion?{...motion,motion_state:online?motion.motion_state:'offline'}:{})};
 });
}
export async function collectVoltage(auth=phoneAuthorization,fetchImpl=fetch){
 const headers=await auth(),rows=await reportPages(headers,undefined,fetchImpl),low=await reportPages(headers,4,fetchImpl);
 projectReadings(rows,low); // Validate the full device set before detail reads.
 const movement=new Map();for(const row of rows)movement.set(row.vkey,await readStationary(headers,row,fetchImpl));
 return projectReadings(rows,low,movement);
}
export class VoltageService{
 constructor({home,remote,collect=collectVoltage,now=Date.now,save=writeJSON}){Object.assign(this,{home,remote,collect,now,save});this.busy=false;this.retryAt=0;}
 async init(){this.file=path.join(this.home,'voltage-state.json');this.state=await readJSON(this.file,{version:1,next_run_at:null,pending:null});if(this.state.version!==1)throw fail('schema_changed');return this;}
 async uploadPending(){
  const pending=this.state.pending;
  try{
   const receipt=await this.remote.request('voltage',pending);
   // A successful HTTP response alone is not an acknowledgement. Keep the
   // durable reading when the receiver changes schema or returns an error
   // envelope with HTTP 200, and retry the same snapshot after recovery.
   if(receipt?.ok!==true)throw fail('invalid_receipt');
  }
  catch(error){
   // Authentication, rate limits and outages may recover: retain their exact
   // pending snapshot. Retrying a definitive schema/size rejection forever,
   // however, would prevent every later daily collection.
   if(!PERMANENT_UPLOAD_STATUSES.has(error.status))throw error;
   const checked_at=new Date(this.now()).toISOString(),next_run_at=new Date(this.now()+15*60000).toISOString();
   const diagnostic='voltage-rejected-'+(pending.outcome==='success'?'success':'failure')+'.json';
   // Two bounded files retain the latest rejected reading and failure report.
   // Persist evidence and replacement state before dropping the old pending.
   await this.save(path.join(this.home,diagnostic),{version:1,rejected_at:checked_at,http_status:error.status,snapshot:pending});
   const state={...this.state,next_run_at,last_error:'schema_changed',
    last_upload_rejection:{rejected_at:checked_at,http_status:error.status,snapshot_checked_at:pending.checked_at,diagnostic},
    pending:pending.outcome==='success'?{version:1,checked_at,next_run_at,outcome:'failure',error_code:'schema_changed'}:null};
   await this.save(this.file,state);this.state=state;
   // A small explicit failure is uploaded next tick. If that is also rejected,
   // retain its diagnosis, then wait until the 15-minute collection retry.
   return false;
  }
  const state={...this.state,pending:null};await this.save(this.file,state);this.state=state;
  return true;
 }
 async tick(){
  if(this.retryAt>this.now()+60000)this.retryAt=0;
  if(this.busy||this.now()<this.retryAt)return;this.busy=true;
  try{
   if(this.state.pending&&(Date.parse(this.state.pending.checked_at)>this.now()+600000||Date.parse(this.state.pending.checked_at)<this.now()-7*DAY)){
    const state={...this.state,pending:null,next_run_at:null};await this.save(this.file,state);this.state=state;
   }
   if(this.state.pending&&!await this.uploadPending())return;
   const now=this.now(),due=Date.parse(this.state.next_run_at);
   if(Number.isFinite(due)&&due>now+DAY+60000){const state={...this.state,next_run_at:nextVoltageRun(now)};await this.save(this.file,state);this.state=state;return;}
   if(Number.isFinite(due)&&due>now)return;
   let result;try{result={outcome:'success',devices:await this.collect()};}catch(e){result={outcome:'failure',error_code:allowedErrors.has(e.code)?e.code:'fetch_failed'};}
   const finished=this.now(),next=result.outcome==='success'?nextVoltageRun(finished):new Date(finished+15*60000).toISOString();
   const state={version:1,next_run_at:next,last_success_at:result.outcome==='success'?new Date(finished).toISOString():this.state.last_success_at||null,last_error:result.outcome==='failure'?result.error_code:null,...(this.state.last_upload_rejection?{last_upload_rejection:this.state.last_upload_rejection}:{}),pending:{version:1,checked_at:new Date(finished).toISOString(),next_run_at:next,...result}};
   // A disk failure must not leave an in-memory pending reading that the next
   // tick can upload without first persisting it for crash recovery.
   await this.save(this.file,state);this.state=state;await this.uploadPending();
  }catch{this.retryAt=this.now()+60000;}finally{this.busy=false;}
 }
}
async function main(){
 const home=path.resolve(process.env.FLEET_PHONE_HOME||path.join(os.homedir(),'.local/share/tidewyn-phone'));
 const config=await loadConfiguration(home);if(!config.paired)throw fail('auth_required');
 const service=await new VoltageService({home,remote:new WorkerClient(config)}).init();
 console.log(JSON.stringify({service:'fleet-voltage',event:'started'}));
 await service.tick();setInterval(()=>void service.tick(),60000);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
