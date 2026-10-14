#!/data/data/com.termux/files/usr/bin/node
// Fixed local Chrome transport, installed root:root 0700 under a root-owned
// 0700 directory. No browser commands, dynamic destinations or public listener.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT_RELAY_FILE = '/data/adb/tidewyn-fleet/native-chrome-root-relay.mjs';
export const ROOT_RELAY_NODE = '/data/data/com.termux/files/usr/bin/node';
const ROOT_DIRECTORY = path.dirname(ROOT_RELAY_FILE);
const EXPECTED_SERIAL = 'YOUR_DEVICE_SERIAL';
const SAFE_ENV = { PATH: '/system/bin:/system/xbin', HOME: ROOT_DIRECTORY };
const STATE_FILE = ROOT_DIRECTORY+'/chrome-relay-state.json';

export async function verifyRelayScope({getuid=process.getuid,platform=process.platform,lstat=fs.lstat,realpath=fs.realpath,execute=execFile,source=import.meta.url}={}) {
  if (!['linux','android'].includes(platform) || getuid?.() !== 0 || source !== pathToFileURL(ROOT_RELAY_FILE).href) throw new Error('ROOT_RELAY_SCOPE');
  for (const file of ['/data/adb', ROOT_DIRECTORY, ROOT_RELAY_FILE]) {
    const info=await lstat(file);
    if (info.isSymbolicLink() || info.uid!==0 || (info.mode&0o777)!==0o700 || (file===ROOT_RELAY_FILE ? !info.isFile() : !info.isDirectory()) || await realpath(file)!==file) throw new Error('ROOT_RELAY_SCOPE');
  }
  const serial=await new Promise((resolve,reject)=>execute('/system/bin/getprop',['ro.serialno'],{env:SAFE_ENV,timeout:2500,maxBuffer:1024,shell:false},(error,value)=>error?reject(error):resolve(value.trim())));
  if(serial!==EXPECTED_SERIAL)throw new Error('ROOT_RELAY_DEVICE');
}

// Injection points are for deterministic tests only. Production accepts no
// address, socket, limits, filesystem or command arguments from its caller.
export function createChromeRelay({createServer=net.createServer,connect=net.createConnection,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  const pairs=new Set();let server,closing=false,binding=true,idleTimer=null;
  let resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const cancelIdle=()=>{if(idleTimer!==null)clearTimer(idleTimer);idleTimer=null;};
  const armIdle=()=>{cancelIdle();if(!closing&&!pairs.size)idleTimer=setTimer(()=>stop(),120000);};
  const stop=()=>{
    if(closing)return closed;
    closing=true;cancelIdle();
    for(const pair of [...pairs])pair.finish();
    if(server?.listening)server.close(()=>resolveClosed());else if(!binding)resolveClosed();
    return closed;
  };
  server=createServer({allowHalfOpen:false},client=>{
    if(closing || pairs.size>=32){client.destroy();return;}
    cancelIdle();
    const pair={client,upstream:null,timers:[],ended:false,finish:null,closed:0};pairs.add(pair);
    pair.finish=()=>{
      if(pair.ended)return;
      pair.ended=true;
      for(const timer of pair.timers)clearTimer(timer);
      client.destroy();pair.upstream?.destroy();pairs.delete(pair);armIdle();
    };
    // A normal FIN must drain pipe's pending writes before its peer closes.
    // Destroy both immediately only for errors, timeout, stop or both closed.
    const normalClose=hadError=>{if(hadError||++pair.closed===2)pair.finish();};
    client.once('error',pair.finish);client.once('close',normalClose);
    client.setTimeout(300000,pair.finish);
    // Absolute limit exceeds one sync's bounded 8-minute collection budget.
    pair.timers.push(setTimer(pair.finish,1800000));
    let upstream;
    try { upstream=connect({path:'\0chrome_devtools_remote',allowHalfOpen:false}); }
    catch {pair.finish();return;}
    pair.upstream=upstream;
    upstream.once('error',pair.finish);upstream.once('close',normalClose);
    upstream.setTimeout(300000,pair.finish);
    const connecting=setTimer(pair.finish,5000);pair.timers.push(connecting);
    upstream.once('connect',()=>{
      clearTimer(connecting);if(pair.ended||closing)return pair.finish();
      // Native stream pipe implements backpressure; no accumulating userland
      // request buffers or parsing/logging of session-bearing traffic.
      client.pipe(upstream);upstream.pipe(client);
    });
  });
  server.on('error',()=>{binding=false;void stop();if(!server.listening)resolveClosed();});
  const ready=new Promise((resolve,reject)=>{
    const error=err=>reject(err);
    server.once('error',error);
    server.listen({host:'127.0.0.1',port:9222,exclusive:true,backlog:32},()=>{
      binding=false;
      server.removeListener('error',error);
      if(closing){server.close(()=>resolveClosed());return reject(new Error('ROOT_RELAY_STOPPED'));}
      armIdle();resolve({ready:true,port:9222});
    });
  });
  return {ready,closed,stop,get connectionCount(){return pairs.size;}};
}

export function procStartTime(text){
  const fields=String(text).slice(String(text).lastIndexOf(')')+2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19]||'')?fields[19]:null;
}

export function localListenerInodes(text){
  return String(text).split('\n').slice(1).map(line=>line.trim().split(/\s+/))
    .filter(fields=>fields[1]==='0100007F:2406'&&fields[2]==='00000000:0000'&&fields[3]==='0A'&&/^\d+$/.test(fields[9]||''))
    .map(fields=>fields[9]);
}

// The kernel, rather than mutable Chrome target IDs, proves an already-running
// listener is our fixed root helper. No TCP messages can spoof this check.
export async function checkRelayOwner({lstat=fs.lstat,readFile=fs.readFile,readdir=fs.readdir,readlink=fs.readlink}={}){
  try{
    const info=await lstat(STATE_FILE);
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o777)!==0o600||info.size>1024)return null;
    const state=JSON.parse(await readFile(STATE_FILE,'utf8'));
    if(!Number.isSafeInteger(state.pid)||state.pid<1||!/^\d+$/.test(state.start||'')||!(/^[a-f0-9]{32}$/.test(state.instance||'')))return null;
    const base='/proc/'+state.pid;
    const expected=ROOT_RELAY_NODE+'\0'+ROOT_RELAY_FILE+'\0--serve\0';
    if(await readFile(base+'/cmdline','utf8')!==expected||!/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(await readFile(base+'/status','utf8'))||procStartTime(await readFile(base+'/stat','utf8'))!==state.start)return null;
    const inodes=localListenerInodes(await readFile('/proc/net/tcp','utf8'));
    if(inodes.length!==1)return null;
    const fds=await readdir(base+'/fd');if(fds.length>256)return null;
    let owned=false;
    for(const fd of fds){if(!/^\d+$/.test(fd))continue;try{if(await readlink(base+'/fd/'+fd)==='socket:['+inodes[0]+']'){owned=true;break;}}catch{}}
    if(!owned||procStartTime(await readFile(base+'/stat','utf8'))!==state.start)return null;
    return {ready:true,port:9222,instance:state.instance,pid:state.pid,start:state.start};
  }catch{return null;}
}

async function recordRelayOwner(){
  const state={pid:process.pid,start:procStartTime(await fs.readFile('/proc/self/stat','utf8')),instance:randomBytes(16).toString('hex')};
  if(!state.start)throw new Error('ROOT_RELAY_PROCESS');
  const temporary=STATE_FILE+'.'+process.pid+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,STATE_FILE);
  if(!await checkRelayOwner())throw new Error('ROOT_RELAY_OWNER');
}

export async function startRelay({spawnImpl=spawn,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(ROOT_RELAY_NODE,[ROOT_RELAY_FILE,'--serve'],{cwd:ROOT_DIRECTORY,env:SAFE_ENV,detached:true,stdio:['ignore','ignore','ignore','ipc']});
    let settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimer(timer);
      child.removeListener('error',failed);child.removeListener('exit',exited);child.removeListener('message',message);
      if(error){try{child.kill('SIGTERM');}catch{};reject(error);}
      else{if(child.connected)child.disconnect();child.unref();resolve(true);}
    };
    const failed=()=>finish(new Error('ROOT_RELAY_START_FAILED'));
    const exited=()=>finish(new Error('ROOT_RELAY_START_FAILED'));
    const message=value=>value?.ready===true&&value?.port===9222?finish():finish(new Error('ROOT_RELAY_START_FAILED'));
    const timer=setTimer(()=>finish(new Error('ROOT_RELAY_START_TIMEOUT')),5000);
    child.once('error',failed);child.once('exit',exited);child.once('message',message);
  });
}

export async function main(args=process.argv.slice(2)) {
  if(args.length!==1 || !['--start','--serve','--check'].includes(args[0]))throw new Error('ROOT_RELAY_ARGUMENTS');
  await verifyRelayScope();
  if(args[0]==='--check'){
    const state=await checkRelayOwner();if(!state)throw new Error('ROOT_RELAY_NOT_OWNED');
    process.stdout.write(JSON.stringify(state)+'\n');return;
  }
  if(args[0]==='--start'){
    await startRelay();process.stdout.write('{"ready":true,"port":9222}\n');return;
  }
  const relay=createChromeRelay();
  const stop=()=>{void relay.stop();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    await relay.ready;
    await recordRelayOwner();
    process.send?.({ready:true,port:9222});
    if(process.connected)process.disconnect();
    await relay.closed;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await relay.stop();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,code:error.code==='EADDRINUSE'?'ROOT_RELAY_PORT_BUSY':'ROOT_RELAY_FAILED'})+'\n');process.exitCode=1;});
}
