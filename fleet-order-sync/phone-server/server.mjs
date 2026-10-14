import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {WebSocketServer} from 'ws';
import {collectors,verifyAuth,PLATFORM_URLS} from '../collectors.mjs';
import {loadConfiguration,privateDirectory,PhoneAgent,WorkerClient,parseNativeCdpPort,fault,writeJSON} from './core.mjs';
import {createManagementServer} from './http.mjs';
import {reverseSync} from './reverse.mjs';
import {collectSamBoatWithSavedLogin} from './samboat-login.mjs';
import {collectBoataroundWithSavedLogin} from './boataround-login.mjs';
import {collectClickAndBoatAppWithSavedLogin} from '../collectors/clickandboat-app-login.mjs';
import {collectMmk} from '../collectors/mmk.mjs';
import {recoverMmkSavedLoginWithRetry} from './mmk-login.mjs';
import {collectNausys} from '../collectors/nausys.mjs';
import {recoverNausysSavedLogin} from './nausys-login.mjs';

const BOOT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROCESS_START=/^(?:0|[1-9][0-9]{0,30})$/;
export async function readProcessStartTicks(pid,{platform=process.platform,readFile=fs.readFile}={}) {
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid process identity');
  if(!['android','linux'].includes(platform))return null;
  let text;
  try {text=await readFile('/proc/'+pid+'/stat','utf8');}
  catch {throw Error('Cannot verify process start identity');}
  // comm (field 2) may contain spaces and parentheses. Fields after its final
  // ')' are fixed; field 22 is starttime, measured since boot, not wall time.
  if(typeof text!=='string'||text.length>4096||!text.startsWith(pid+' ('))throw Error('Invalid process start identity');
  const end=text.lastIndexOf(')'),fields=text.slice(end+1).trim().split(/\s+/);
  if(end<0||fields.length<20||!/^[A-Za-z]$/.test(fields[0])||!PROCESS_START.test(fields[19]))throw Error('Invalid process start identity');
  return fields[19]; // Keep as decimal text so uptime cannot lose precision.
}
export async function readSystemBootId({platform=process.platform,readFile=fs.readFile}={}) {
  // Windows has no Linux boot_id. Its locks retain the existing PID-only rule.
  if(!['android','linux'].includes(platform))return null;
  let value;
  try {value=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();}
  catch(error){
    if(platform!=='android' && ['ENOENT','ENOTDIR'].includes(error.code))return null;
    throw Error('Cannot verify current system boot id');
  }
  if(!BOOT_ID.test(value))throw Error('Current system boot id is invalid');
  return value.toLowerCase();
}

function parseServerLock(text) {
  let record;
  if(/^[1-9][0-9]*$/.test(text.trim()))record={pid:Number(text.trim()),boot_id:null};
  else {
    try{record=JSON.parse(text);}catch{throw Error('Server lock is invalid; inspect it before starting');}
    if(!record || record.version!==1 || (record.boot_id!==null && (typeof record.boot_id!=='string'||!BOOT_ID.test(record.boot_id))))throw Error('Server lock is invalid; inspect it before starting');
  }
  if(!Number.isSafeInteger(record.pid)||record.pid<=0)throw Error('Server lock is invalid; inspect it before starting');
  if(record.process_start!==undefined&&record.process_start!==null&&
    (typeof record.process_start!=='string'||!PROCESS_START.test(record.process_start)))throw Error('Server lock is invalid; inspect it before starting');
  return {...record,boot_id:record.boot_id?.toLowerCase()??null,process_start:record.process_start??null};
}
function processIsAlive(pid) {
  try{process.kill(pid,0);return true;}
  catch(error){if(error.code==='ESRCH')return false;throw error;}
}
export async function acquireServerGate(lockPath) {
  const directory=await fs.realpath(path.dirname(lockPath));
  const canonical=path.join(directory,path.basename(lockPath));
  const key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex');
  // Kernel-owned IPC endpoints disappear on process exit, including SIGKILL.
  // A filesystem reclaim marker could instead strand every subsequent start.
  const address=process.platform==='win32'?'\\\\.\\pipe\\fleet-start-'+key:
    ['android','linux'].includes(process.platform)?'\0fleet-start-'+(process.getuid?.()??0)+'-'+key:null;
  if(!address)throw Error('Unsupported server lock platform');
  const gate=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    const fail=error=>reject(error.code==='EADDRINUSE'?Error('Server lock recovery is already in progress; retry after the current starter exits'):error);
    gate.once('error',fail);
    gate.listen({path:address},()=>{gate.removeListener('error',fail);resolve();});
  });
  gate.unref();
  return gate;
}
export async function acquireServerLock(lockPath,{pid=process.pid,bootId,processAlive=processIsAlive,processStart,readProcessStart=readProcessStartTicks}={}) {
  if(bootId===undefined)bootId=await readSystemBootId();
  if(!Number.isSafeInteger(pid)||pid<=0 || (bootId!==null && (typeof bootId!=='string'||!BOOT_ID.test(bootId))))throw Error('Invalid server lock identity');
  bootId=bootId?.toLowerCase()??null;
  if(processStart===undefined)processStart=await readProcessStart(pid);
  if(processStart!==null&&(typeof processStart!=='string'||!PROCESS_START.test(processStart)))throw Error('Invalid process start identity');
  const record={version:1,pid,boot_id:bootId,...(processStart===null?{}:{process_start:processStart})};
  const gate=await acquireServerGate(lockPath);
  try {
    let oldText;
    try{oldText=await fs.readFile(lockPath,'utf8');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(oldText===undefined){
      // Publish a complete first lock atomically as well as during recovery.
      await writeJSON(lockPath,record);
    } else {
      const previous=parseServerLock(oldText);
      const previousBoot=bootId!==null && previous.boot_id!==null && previous.boot_id!==bootId;
      if(!previousBoot){
        const alive=processAlive(previous.pid);
        if(alive!==false){
          let reused=false;
          if(alive===true&&previous.process_start!==null&&processStart!==null){
            const observed=await readProcessStart(previous.pid);
            if(observed!==null&&(typeof observed!=='string'||!PROCESS_START.test(observed)))throw Error('Invalid process start identity');
            reused=observed!==null&&observed!==previous.process_start;
          }
          // A live same-PID/same-boot process may now belong to somebody else.
          // Reclaim only with different verified kernel starttime, never by
          // process name or wall-clock age. Legacy locks remain conservative.
          if(!reused)throw Error('Phone server is already running');
        }
      }
      // The gate serializes validation and this atomic replacement, so a second
      // starter cannot mistake the newly written lock for the stale one.
      await writeJSON(lockPath,record);
    }
    return record;
  } finally {
    await new Promise(resolve=>gate.close(resolve));
  }
}

export function parseNativeBridgeFlag(value,nativeCdpPort) {
  if(value===undefined)return false;
  if(value!=='1'||nativeCdpPort!==9222)throw fault('invalid_native_bridge_config');
  return true;
}

const BRIDGE_DIAGNOSTIC_CODES=new Set(['ABORTED','ADB_COMMAND_FAILED','ADB_SERVER_CONFLICT','ADB_SERVER_NOT_READY','ADB_SERVER_UNVERIFIED','ADB_VERSION_UNKNOWN','CDP_NOT_READY','CHROME_START_FAILED','DEVICE_MISMATCH','FORWARD_CONFLICT','FORWARD_NOT_VERIFIED','FORWARD_STATE_INVALID','FORWARD_STATE_WRITE_FAILED','NO_AUTHORIZED_LOCAL_ADB','PAIRING_REQUIRED','PORT_UNAVAILABLE','SCREEN_LOCKED','SCREEN_STATE_UNAVAILABLE','TOO_MANY_CANDIDATES']);
// Preserve a bounded diagnosis in the local service log, never the child output
// or exception text. The public/cloud failure contract remains unchanged.
export function nativeBridgeFailureReason(error,stderr) {
  if(error?.code==='ABORT_ERR')return 'ABORTED';
  if(error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return 'OUTPUT_LIMIT';
  if(error?.killed)return 'BRIDGE_TIMEOUT';
  if(typeof stderr==='string'&&Buffer.byteLength(stderr)<=65536){
    for(const line of stderr.trim().split('\n').slice(-8).reverse()){
      try{const event=JSON.parse(line);if(event.ok===false&&BRIDGE_DIAGNOSTIC_CODES.has(event.code))return event.code;}catch{}
    }
  }
  return 'BRIDGE_FAILED';
}
export async function prepareNativeChromeBridge({signal,forceWake=false}={}, {execFileImpl=execFile,report=event=>console.warn(JSON.stringify(event))}={}) {
  if(signal?.aborted)throw fault('fetch_failed');
  const script=fileURLToPath(new URL('../provision/native-chrome-bridge.mjs',import.meta.url));
  let reason='BRIDGE_FAILED';
  try {
    await new Promise((resolve,reject)=>{
      execFileImpl(process.execPath,[script,'--background-root',...(forceWake?['--wake-chrome']:[]),'--budget-ms','90000'],{
        shell:false,timeout:95000,maxBuffer:64*1024,signal,windowsHide:true
      },(error,stdout,stderr)=>{if(error){reason=nativeBridgeFailureReason(error,stderr);reject(error);}else resolve();});
    });
    if(signal?.aborted)throw fault('fetch_failed');
  } catch {
    try{report({event:'native_bridge_failed',reason:signal?.aborted?'ABORTED':reason,at:new Date().toISOString()});}catch{}
    throw fault('fetch_failed');
  }
}

// Lease belongs to one synchronization run. Only Chrome is unfrozen, at most
// one root preparation at a time; no wake key, screen setting or global freeze
// switch. Stop aborts outstanding preparation and removes the timer.
export async function startNativeBackgroundLease({prepare,execute=execFile,intervalMs=2000,signal}={}){
  if(signal?.aborted)return async()=>{};
  if(!prepare)prepare=(await import(new URL('../provision/native-chrome-bridge.mjs',import.meta.url))).prepareChromeBackground;
  const controller=new AbortController();let running=null,stopped=false,timer=null,stopping=null;
  const stop=()=>{
    if(stopping)return stopping;
    stopped=true;clearInterval(timer);signal?.removeEventListener('abort',onAbort);controller.abort();
    // A second shutdown caller must await the same cleanup as the first.
    stopping=Promise.resolve(running).then(()=>{});return stopping;
  };
  const onAbort=()=>{void stop();};
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted){await stop();return stop;}
  const tick=()=>{if(stopped||running)return;running=Promise.resolve().then(()=>prepare({signal:controller.signal})).catch(()=>{}).finally(()=>{running=null;});};
  try{await new Promise(resolve=>execute('su',['-c','am start -n com.android.chrome/com.google.android.apps.chrome.Main'],{timeout:10000,maxBuffer:4096,windowsHide:true,signal:controller.signal},()=>resolve()));}catch{}
  if(stopped||controller.signal.aborted){await stop();return stop;}
  tick();timer=setInterval(tick,intervalMs);timer.unref?.();
  return stop;
}

export async function connectNativeBrowser(port,{
  fetchImpl=fetch,connect=options=>puppeteer.connect(options),discoveryTimeout=5000,connectTimeout=10000
}={}) {
  parseNativeCdpPort(String(port));
  let browserWSEndpoint;
  try {
    const response=await fetchImpl('http://127.0.0.1:'+port+'/json/version',{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(discoveryTimeout)
    });
    if(response.status!==200 || !response.body ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') throw fault('fetch_failed');
    const limit=64*1024;
    const reader=response.body.getReader(),chunks=[];let size=0;
    try {
      for(;;){
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>limit){await reader.cancel().catch(()=>{});throw fault('fetch_failed');}
        chunks.push(Buffer.from(value));
      }
    } finally {reader.releaseLock();}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const endpoint=new URL(data.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:' || endpoint.hostname!=='127.0.0.1' || endpoint.port!==String(port) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(endpoint.pathname)) throw fault('fetch_failed');
    browserWSEndpoint=endpoint.href;
  } catch {throw fault('fetch_failed');}
  let timer,expired=false;
  const connection=Promise.resolve().then(()=>connect({browserWSEndpoint,defaultViewport:null,protocolTimeout:30000})).then(async browser=>{
    if(expired){
      await Promise.resolve().then(()=>browser.disconnect()).catch(()=>{});
      throw fault('fetch_failed');
    }
    return browser;
  });
  try {
    return await Promise.race([connection,new Promise((_,reject)=>{
      timer=setTimeout(()=>{expired=true;reject(fault('fetch_failed'));},connectTimeout);
    })]);
  } catch {throw fault('fetch_failed');}
  finally {clearTimeout(timer);}
}

async function main() {
if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22 or newer is required');
const require=createRequire(import.meta.url);
const home=path.resolve(process.env.FLEET_PHONE_HOME || path.join(os.homedir(),'.local/share/tidewyn-phone'));
const port=Number(process.env.FLEET_PHONE_PORT || 8788);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local port');
const nativeCdpPort=parseNativeCdpPort(process.env.FLEET_SAMBOAT_CDP_PORT);
const nativeBridgeEnabled=parseNativeBridgeFlag(process.env.FLEET_SAMBOAT_BRIDGE,nativeCdpPort);
const config=await loadConfiguration(home);
const lockPath=path.join(home,'server.pid');
await acquireServerLock(lockPath);
const profile=path.join(home,'chromium-profile');await privateDirectory(profile);
const executablePath=process.env.FLEET_CHROMIUM_PATH || '/data/data/com.termux/files/usr/bin/chromium-browser';
const browserFactory=()=>puppeteer.launch({executablePath,userDataDir:profile,headless:false,pipe:true,timeout:45000,
  env:{...process.env,DISPLAY:process.env.DISPLAY||':1'},defaultViewport:null,
  args:['--no-sandbox','--no-first-run','--no-default-browser-check','--password-store=basic','--window-size=1400,850',
    ...(process.env.FLEET_DISABLE_DEV_SHM==='1'?['--disable-dev-shm-usage']:[])]});
const nativeBrowserFactory=nativeCdpPort===null?null:()=>connectNativeBrowser(nativeCdpPort);
const prepareNativeBrowser=nativeBridgeEnabled?prepareNativeChromeBridge:null;
// Click&Boat reads its official Android app since 2026-09-29: the website's
// Cloudflare check blocks the automated browser (see clickandboat-app.mjs).
// It needs no browser page and has no login page here.
// MMK orders (since 2026-10-04) are read in the phone's normal Chrome, which
// also restores an expired MMK login through the verified Google autofill.
// Login recovery stays inside this attempt's deadline (as SamBoat's does), so a
// cancelled recovery cannot put the screen to sleep during the wake retry.
const collectMmkWithSavedLogin=context=>collectMmk(context,{recoverLogin:page=>{
  const deadlineAt=Math.min(Number.isFinite(context.deadlineAt)?context.deadlineAt:Infinity,Date.now()+75000);
  if(deadlineAt-Date.now()<15000)throw Error('mmk_auth_required');
  return recoverMmkSavedLoginWithRetry(page,{isCancelled:()=>context.signal?.aborted===true,deadlineAt});
}});
// NauSYS orders (since 2026-10-09) are read the same way, signed in as
// demo-user@AGENCY through Chrome's saved-password sheet.
const collectNausysWithSavedLogin=context=>collectNausys(context,{recoverLogin:page=>{
  const deadlineAt=Math.min(Number.isFinite(context.deadlineAt)?context.deadlineAt:Infinity,Date.now()+75000);
  if(deadlineAt-Date.now()<15000)throw Error('nausys_auth_required');
  return recoverNausysSavedLogin(page,{signal:context.signal,deadlineAt});
}});
// Boataround (since 2026-10-04) restores an expired login the same way as
// SamBoat: Chrome's saved-password sheet, owner account only. The Click&Boat
// app signs in again through Android's Google autofill (same day).
const phoneCollectors={...collectors,clickandboat:collectClickAndBoatAppWithSavedLogin,mmk:collectMmk,nausys:collectNausys,...(nativeBridgeEnabled?{boataround:collectBoataroundWithSavedLogin,samboat:collectSamBoatWithSavedLogin,mmk:collectMmkWithSavedLogin,nausys:collectNausysWithSavedLogin}:{})};
const agent=await new PhoneAgent({home,config,remote:new WorkerClient(config),collectors:phoneCollectors,pagelessSources:['clickandboat'],verifyAuth,platformUrls:PLATFORM_URLS,browserFactory,nativeBrowserFactory,prepareNativeBrowser,nativeBackgroundLease:nativeBridgeEnabled?startNativeBackgroundLease:null,reverseSync:process.env.FLEET_REVERSE_CLOSE==='1'?reverseSync:null}).init();
const novncRoot=path.resolve(path.dirname(require.resolve('@novnc/novnc')),'..');
const server=createManagementServer({agent,config,novncRoot,WebSocketServer});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
console.log(JSON.stringify({service:'tidewyn-phone-server',event:'listening',address:'127.0.0.1',port}));
const timer=setInterval(()=>void agent.tick().catch(()=>{}),5000);
void agent.tick().catch(()=>{});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);server.close();await agent.close().catch(()=>{});await fs.unlink(lockPath).catch(()=>{});process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
