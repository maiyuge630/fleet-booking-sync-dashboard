import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {connectNativeBrowser,parseNativeBridgeFlag,prepareNativeChromeBridge,nativeBridgeFailureReason,readSystemBootId,acquireServerLock as acquireRealServerLock} from '../server.mjs';
// Most lock cases model synthetic PIDs. Keep them independent of host /proc;
// the dedicated process-identity tests exercise the kernel starttime reader.
const acquireServerLock=(lock,options)=>acquireRealServerLock(lock,{readProcessStart:async()=>null,...options});

test('actual service entry starts with installed noVNC and a lazy optional native Chrome connection',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-entry-test-'));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const filename=fileURLToPath(new URL('../server.mjs',import.meta.url));
  const child=spawn(process.execPath,[filename],{env:{...process.env,FLEET_PHONE_HOME:home,FLEET_PHONE_PORT:String(port),FLEET_SAMBOAT_CDP_PORT:'8879'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await fs.rm(home,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('service_start_timeout')),8000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('"event":"listening"')){clearTimeout(timer);resolve();}});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('service_exit_before_ready'));});
  });
  const base='http://127.0.0.1:'+port;
  assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true,service:'tidewyn-phone-server'});
  assert.equal((await fetch(base+'/api/status')).status,401);
  const config=JSON.parse(await fs.readFile(path.join(home,'config.json'),'utf8'));
  const headers={Authorization:'Basic '+Buffer.from(config.admin_user+':'+config.admin_password).toString('base64')};
  const status=await(await fetch(base+'/api/status',{headers})).json();
  assert.equal(status.paired,false);assert.equal(status.enabled,false);assert.equal(status.last_contact_at,null);
  assert.equal((await fetch(base+'/novnc/core/rfb.js',{headers})).status,200);
  assert.equal(JSON.stringify(status).includes(config.vnc_password),false);
  assert.equal(JSON.stringify(status).includes(config.device_token),false);
});

test('service rejects a non-loopback native endpoint before creating private configuration',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-entry-invalid-cdp-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const filename=fileURLToPath(new URL('../server.mjs',import.meta.url));
  const child=spawn(process.execPath,[filename],{env:{...process.env,FLEET_PHONE_HOME:home,FLEET_SAMBOAT_CDP_PORT:'http://192.168.1.2:8879'},windowsHide:true,stdio:'ignore'});
  const code=await new Promise(resolve=>child.once('exit',resolve));
  assert.notEqual(code,0);assert.deepEqual(await fs.readdir(home),[]);
});

const discovery=(endpoint='ws://127.0.0.1:9222/devtools/browser/browser-123')=>new Response(JSON.stringify({webSocketDebuggerUrl:endpoint}),{status:200,headers:{'Content-Type':'application/json; charset=UTF-8'}});
test('native discovery uses bounded fixed loopback HTTP then connects to the validated browser endpoint',async()=>{
  let request,options;const browser={disconnect:async()=>{}};
  const result=await connectNativeBrowser(9222,{fetchImpl:async(url,init)=>{request={url,init};return discovery();},connect:async value=>{options=value;return browser;}});
  assert.equal(result,browser);assert.equal(request.url,'http://127.0.0.1:9222/json/version');
  assert.equal(request.init.redirect,'error');assert.equal(request.init.method,'GET');assert.ok(request.init.signal instanceof AbortSignal);
  assert.deepEqual(options,{browserWSEndpoint:'ws://127.0.0.1:9222/devtools/browser/browser-123',defaultViewport:null,protocolTimeout:30000});
});
test('native discovery accepts the discoverable Android Chrome browser endpoint without a target id',async()=>{
  let options;const browser={disconnect:async()=>{}};
  const result=await connectNativeBrowser(9222,{fetchImpl:async()=>discovery('ws://127.0.0.1:9222/devtools/browser'),connect:async value=>{options=value;return browser;}});
  assert.equal(result,browser);assert.equal(options.browserWSEndpoint,'ws://127.0.0.1:9222/devtools/browser');assert.equal(options.defaultViewport,null);
});
test('native discovery rejects other hosts, ports, credentials, protocols and non-browser targets before connecting',async()=>{
  const invalid=[
    'ws://example.com:9222/devtools/browser/browser-123',
    'ws://127.0.0.1:9223/devtools/browser/browser-123',
    'ws://localhost:9222/devtools/browser/browser-123',
    'ws://[::1]:9222/devtools/browser/browser-123',
    'ws://name:password@127.0.0.1:9222/devtools/browser/browser-123',
    'wss://127.0.0.1:9222/devtools/browser/browser-123',
    'ws://127.0.0.1:9222/devtools/page/page-123',
    'ws://127.0.0.1:9222/devtools/browser/',
    'ws://127.0.0.1:9222/devtools/browser/id/extra',
    'ws://127.0.0.1:9222/devtools/browser/browser-123?next=external',
    'ws://127.0.0.1:9222/devtools/browser/browser-123#fragment'
  ];
  let connections=0;
  for(const endpoint of invalid)await assert.rejects(connectNativeBrowser(9222,{fetchImpl:async()=>discovery(endpoint),connect:async()=>{connections++;}}),{code:'fetch_failed'});
  assert.equal(connections,0);
});
test('native discovery rejects non-200, non-JSON, malformed and oversized bodies without accepting empty fallback data',async()=>{
  const responses=[
    new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}),
    new Response('{}',{status:201,headers:{'Content-Type':'application/json'}}),
    new Response('<html>offline</html>',{headers:{'Content-Type':'text/html'}}),
    new Response('{',{headers:{'Content-Type':'application/json'}}),
    new Response(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/browser/id',padding:'x'.repeat(65536)}),{headers:{'Content-Type':'application/json'}})
  ];
  let connections=0;
  for(const response of responses)await assert.rejects(connectNativeBrowser(9222,{fetchImpl:async()=>response,connect:async()=>{connections++;}}),{code:'fetch_failed'});
  assert.equal(connections,0);
});
test('native HTTP discovery deadline also interrupts a body that stalls after its headers',async t=>{
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  let connections=0;const start=Date.now();
  await assert.rejects(connectNativeBrowser(server.address().port,{discoveryTimeout:35,connect:async()=>{connections++;}}),{code:'fetch_failed'});
  assert.equal(connections,0);assert.ok(Date.now()-start<1000);
});
test('native connect deadline releases the caller and disconnects a late browser without closing it',async()=>{
  let resolveConnect;const events={closed:0,disconnected:0};
  const browser={close:async()=>{events.closed++;},disconnect:async()=>{events.disconnected++;}};
  const attempt=connectNativeBrowser(9222,{fetchImpl:async()=>discovery(),connectTimeout:25,connect:()=>new Promise(resolve=>{resolveConnect=resolve;})});
  await assert.rejects(attempt,{code:'fetch_failed'});resolveConnect(browser);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,{closed:0,disconnected:1});
});

test('native bridge is explicitly opt-in and requires the fixed native CDP port',()=>{
  assert.equal(parseNativeBridgeFlag(undefined,null),false);assert.equal(parseNativeBridgeFlag(undefined,9222),false);
  assert.equal(parseNativeBridgeFlag('1',9222),true);
  for(const value of ['', '0', 'true', ' 1', 1, null])assert.throws(()=>parseNativeBridgeFlag(value,9222),{code:'invalid_native_bridge_config'});
  for(const port of [null,8879,80,9223,'9222'])assert.throws(()=>parseNativeBridgeFlag('1',port),{code:'invalid_native_bridge_config'});
});
test('native preparation executes only fixed Node and script arguments without a shell and discards output',async()=>{
  const controller=new AbortController();let call;
  const result=await prepareNativeChromeBridge({signal:controller.signal},{execFileImpl:(executable,args,options,callback)=>{
    call={executable,args,options};callback(null,'private diagnostic output','private stderr');
  }});
  assert.equal(result,undefined);assert.equal(call.executable,process.execPath);
  assert.deepEqual(call.args,[fileURLToPath(new URL('../../provision/native-chrome-bridge.mjs',import.meta.url)),'--background-root','--budget-ms','90000']);
  assert.deepEqual(call.options,{shell:false,timeout:95000,maxBuffer:65536,signal:controller.signal,windowsHide:true});
});
test('native preparation never launches for an already cancelled task',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(prepareNativeChromeBridge({signal:controller.signal},{execFileImpl:()=>{calls++;}}),{code:'fetch_failed'});
  assert.equal(calls,0);
});
test('native wake fallback opts into verified local Root reuse before authorized ADB discovery',async()=>{
  let args;
  await prepareNativeChromeBridge({forceWake:true},{execFileImpl:(_file,values,_options,callback)=>{args=values;callback(null,'','');}});
  assert.deepEqual(args.slice(1),['--background-root','--wake-chrome','--budget-ms','90000']);
});
test('native preparation propagates cancellation and sanitizes the child error',async()=>{
  const controller=new AbortController();let observedSignal;
  const preparation=prepareNativeChromeBridge({signal:controller.signal},{execFileImpl:(executable,args,options,callback)=>{
    observedSignal=options.signal;options.signal.addEventListener('abort',()=>callback(Object.assign(Error('private diagnostic'),{code:'ABORT_ERR'})),{once:true});
  }});
  controller.abort();
  await assert.rejects(preparation,error=>error.code==='fetch_failed'&&error.message==='fetch_failed'&&!error.cause);
  assert.equal(observedSignal,controller.signal);
});
test('native preparation maps timeout, output overflow, nonzero exit and synchronous launch failure to a safe failure',async()=>{
  const errors=[Object.assign(Error('private timed out'),{killed:true,signal:'SIGTERM'}),Object.assign(Error('private oversized output'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),Object.assign(Error('private exit'),{code:1})];
  for(const error of errors)await assert.rejects(prepareNativeChromeBridge({}, {execFileImpl:(executable,args,options,callback)=>{assert.equal(options.timeout,95000);assert.equal(options.maxBuffer,65536);callback(error,'private stdout','private stderr');}}),{code:'fetch_failed',message:'fetch_failed'});
  await assert.rejects(prepareNativeChromeBridge({}, {execFileImpl:()=>{throw Error('private launch error');}}),{code:'fetch_failed',message:'fetch_failed'});
});

test('native bridge diagnostics retain only a known reason and never child output or credentials',async()=>{
  const events=[];
  await assert.rejects(prepareNativeChromeBridge({}, {report:e=>events.push(e),execFileImpl:(exe,args,options,callback)=>callback(Error('private exception'),'private stdout',JSON.stringify({ok:false,code:'NO_AUTHORIZED_LOCAL_ADB',message:'private cookie or token'}))}),{code:'fetch_failed'});
  assert.equal(events.length,1);assert.equal(events[0].reason,'NO_AUTHORIZED_LOCAL_ADB');
  assert.deepEqual(Object.keys(events[0]).sort(),['at','event','reason']);
  assert.ok(!JSON.stringify(events).includes('private'));
  for(const stderr of ['private raw text',JSON.stringify({ok:false,code:'private token'}),JSON.stringify({ok:true,code:'FORWARD_CONFLICT'}),'x'.repeat(65537)])assert.equal(nativeBridgeFailureReason({},stderr),'BRIDGE_FAILED');
  assert.equal(nativeBridgeFailureReason({killed:true},''),'BRIDGE_TIMEOUT');
  assert.equal(nativeBridgeFailureReason({code:'ABORT_ERR'},''),'ABORTED');
  assert.equal(nativeBridgeFailureReason({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},''),'OUTPUT_LIMIT');
});

test('a broken diagnostic logger cannot replace the public bridge failure or hang recovery',async()=>{
  await assert.rejects(prepareNativeChromeBridge({}, {report:()=>{throw Error('logger unavailable');},execFileImpl:()=>{throw Error('launch failed');}}),{code:'fetch_failed',message:'fetch_failed'});
});

const BOOT_A='11111111-1111-4111-8111-111111111111',BOOT_B='22222222-2222-4222-8222-222222222222';
async function lockFixture(t,content) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-boot-lock-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const lockPath=path.join(home,'server.pid');if(content!==undefined)await fs.writeFile(lockPath,content);
  return {home,lockPath};
}
test('Android boot id is validated; Windows explicitly retains PID-only behavior',async()=>{
  let reads=0;
  assert.equal(await readSystemBootId({platform:'android',readFile:async filename=>{reads++;assert.equal(filename,'/proc/sys/kernel/random/boot_id');return BOOT_A+'\n';}}),BOOT_A);
  assert.equal(await readSystemBootId({platform:'win32',readFile:async()=>{reads++;throw Error('must not read');}}),null);assert.equal(reads,1);
  await assert.rejects(readSystemBootId({platform:'android',readFile:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}}),/Cannot verify/);
  await assert.rejects(readSystemBootId({platform:'android',readFile:async()=>'not-a-boot-id'}),/boot id is invalid/);
});
test('new server lock records version, PID and boot id with a released recovery gate',async t=>{
  const {home,lockPath}=await lockFixture(t);const expected={version:1,pid:12345,boot_id:BOOT_A};
  assert.deepEqual(await acquireServerLock(lockPath,{pid:12345,bootId:BOOT_A}),expected);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath,'utf8')),expected);assert.deepEqual(await fs.readdir(home),['server.pid']);
});
test('a verified different boot replaces a stale lock even when its old PID has been reused',async t=>{
  const {lockPath}=await lockFixture(t,JSON.stringify({version:1,pid:12345,boot_id:BOOT_A}));let probes=0;
  await acquireServerLock(lockPath,{pid:23456,bootId:BOOT_B,processAlive:()=>{probes++;return true;}});
  assert.equal(probes,0);assert.deepEqual(JSON.parse(await fs.readFile(lockPath,'utf8')),{version:1,pid:23456,boot_id:BOOT_B});
});
test('same-boot live processes and PID-only fallback cannot be displaced',async t=>{
  const original=JSON.stringify({version:1,pid:12345,boot_id:BOOT_A}),{lockPath}=await lockFixture(t,original);
  for(const bootId of [BOOT_A,null])await assert.rejects(acquireServerLock(lockPath,{pid:23456,bootId,processAlive:()=>true}),/already running/);
  assert.equal(await fs.readFile(lockPath,'utf8'),original);
  await acquireServerLock(lockPath,{pid:23456,bootId:BOOT_A,processAlive:()=>false});
  assert.equal(JSON.parse(await fs.readFile(lockPath,'utf8')).pid,23456);
});
test('legacy numeric locks use PID checks even when the current boot id is available',async t=>{
  const {lockPath}=await lockFixture(t,'12345\n');
  await assert.rejects(acquireServerLock(lockPath,{pid:23456,bootId:BOOT_B,processAlive:()=>true}),/already running/);
  assert.equal(await fs.readFile(lockPath,'utf8'),'12345\n');
  await acquireServerLock(lockPath,{pid:23456,bootId:null,processAlive:()=>false});
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath,'utf8')),{version:1,pid:23456,boot_id:null});
});
test('unrecognized lock data and unverified process state are preserved instead of deleted',async t=>{
  const {home,lockPath}=await lockFixture(t);
  for(const text of ['', 'not-json','{}',JSON.stringify({version:2,pid:12345,boot_id:BOOT_A}),JSON.stringify({version:1,pid:12345,boot_id:'wrong'}),JSON.stringify({version:1,pid:-1,boot_id:BOOT_A})]){
    await fs.writeFile(lockPath,text);await assert.rejects(acquireServerLock(lockPath,{pid:23456,bootId:BOOT_B,processAlive:()=>false}),/lock is invalid/);
    assert.equal(await fs.readFile(lockPath,'utf8'),text);assert.deepEqual(await fs.readdir(home),['server.pid']);
  }
  await fs.writeFile(lockPath,'12345');
  await assert.rejects(acquireServerLock(lockPath,{pid:23456,bootId:BOOT_B,processAlive:()=>{throw Object.assign(Error('unverified'),{code:'EPERM'});}}),{code:'EPERM'});
  assert.equal(await fs.readFile(lockPath,'utf8'),'12345');
});
test('concurrent recovery cannot replace another new process lock',async t=>{
  const {lockPath}=await lockFixture(t,JSON.stringify({version:1,pid:12345,boot_id:BOOT_A}));
  const results=await Promise.allSettled([23456,34567].map(pid=>acquireServerLock(lockPath,{pid,bootId:BOOT_B,processAlive:()=>true})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath,'utf8')),results.find(result=>result.status==='fulfilled').value);
});
test('abandoned filesystem gates are preserved but cannot block the kernel-owned startup gate',async t=>{
  const {home,lockPath}=await lockFixture(t,JSON.stringify({version:1,pid:12345,boot_id:BOOT_A}));
  await fs.writeFile(lockPath+'.reclaim-'+BOOT_A,'old-boot gate');
  await acquireServerLock(lockPath,{pid:23456,bootId:BOOT_B,processAlive:()=>true});
  assert.equal(JSON.parse(await fs.readFile(lockPath,'utf8')).pid,23456);
  const currentGate=lockPath+'.reclaim-'+BOOT_B;await fs.writeFile(currentGate,'unknown gate');
  await acquireServerLock(lockPath,{pid:34567,bootId:BOOT_B,processAlive:()=>false});
  assert.equal(await fs.readFile(currentGate,'utf8'),'unknown gate');assert.equal(JSON.parse(await fs.readFile(lockPath,'utf8')).pid,34567);
});
