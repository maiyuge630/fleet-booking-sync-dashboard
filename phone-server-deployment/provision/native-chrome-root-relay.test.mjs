import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Duplex} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {createChromeRelay,verifyRelayScope,checkRelayOwner,localListenerInodes,procStartTime,startRelay,ROOT_RELAY_FILE,ROOT_RELAY_NODE} from './native-chrome-root-relay.mjs';
import {tryRootChromeRelay,tryRootChromeWake} from './native-chrome-bridge.mjs';

class Socket extends Duplex{
  constructor(delay=0){super({allowHalfOpen:false});this.bytes=0;this.delay=delay;}
  _read(){}
  _write(chunk,encoding,callback){setTimeout(()=>{this.bytes+=chunk.length;callback();},this.delay);}
  setTimeout(ms,callback){this.timeoutMs=ms;this.timeoutCallback=callback;}
}
function harness(){
  const server=new EventEmitter(),timers=new Map(),upstreams=[];let handler,id=0,accept;
  server.listening=false;server.close=callback=>{server.listening=false;callback?.();};
  server.listen=(options,callback)=>{assert.deepEqual(options,{host:'127.0.0.1',port:9222,exclusive:true,backlog:32});accept=()=>{server.listening=true;callback();};};
  const relay=createChromeRelay({createServer:(options,fn)=>{assert.deepEqual(options,{allowHalfOpen:false});handler=fn;return server;},connect:options=>{
    assert.deepEqual(options,{path:'\0chrome_devtools_remote',allowHalfOpen:false});const socket=new Socket();upstreams.push(socket);return socket;
  },setTimer:(fn,ms)=>{const next=++id;timers.set(next,{fn,ms});return next;},clearTimer:token=>timers.delete(token)});
  return {relay,server,timers,upstreams,listen:()=>accept(),connect:(client=new Socket())=>{handler(client);return client;},fire:ms=>{const found=[...timers.values()].find(timer=>timer.ms===ms);assert.ok(found);found.fn();}};
}
test('fixed loopback/abstract socket endpoints, finite connection limits and error cleanup',async()=>{
  const h=harness();h.listen();await h.relay.ready;
  const clients=Array.from({length:32},()=>h.connect());assert.equal(h.relay.connectionCount,32);
  const rejected=h.connect();assert.equal(rejected.destroyed,true);assert.equal(h.upstreams.length,32);
  h.upstreams[0].emit('error',new Error('socket closed'));assert.equal(clients[0].destroyed,true);assert.equal(h.relay.connectionCount,31);
  await h.relay.stop();assert.equal(h.relay.connectionCount,0);assert.equal(h.server.listening,false);assert.equal(h.timers.size,0);
});
test('no connections expire at 120 seconds; active connection gets connect/read/absolute bounds',async()=>{
  const h=harness();h.listen();await h.relay.ready;const client=h.connect();
  assert.ok(![...h.timers.values()].some(t=>t.ms===120000));assert.equal(client.timeoutMs,300000);
  h.fire(5000);assert.equal(client.destroyed,true);assert.equal(h.relay.connectionCount,0);
  h.fire(120000);await h.relay.closed;assert.equal(h.server.listening,false);
  const other=harness();other.listen();await other.relay.ready;const second=other.connect();other.upstreams[0].emit('connect');other.fire(1800000);assert.equal(second.destroyed,true);await other.relay.stop();
});
test('stop while bind is pending never leaves a listener or permits later clients',async()=>{
  const h=harness();let stopped=false;const stop=h.relay.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);h.listen();await stop;await assert.rejects(h.relay.ready,/STOPPED/);assert.equal(h.server.listening,false);assert.equal(h.connect().destroyed,true);
});
test('occupied listener is never killed/rebound and startup fails closed',async()=>{
  const h=harness();h.server.emit('error',Object.assign(new Error('busy'),{code:'EADDRINUSE'}));await assert.rejects(h.relay.ready,{code:'EADDRINUSE'});await h.relay.closed;assert.equal(h.upstreams.length,0);
});
test('normal backend FIN drains slow client output without truncating the response',async()=>{
  const h=harness();h.listen();await h.relay.ready;const client=h.connect(new Socket(25)),upstream=h.upstreams[0];
  const finished=new Promise(resolve=>client.once('finish',resolve));upstream.emit('connect');
  upstream.push(Buffer.alloc(128*1024,1));upstream.push(null);upstream.emit('close',false);
  await finished;assert.equal(client.bytes,128*1024);await h.relay.stop();
});

const statText=(start='42')=>'123 (node name) '+['S',...Array(18).fill('0'),start].join(' ');
const tcp='  sl local_address rem_address st tx rx tr tm retr uid timeout inode\n 0: 0100007F:2406 00000000:0000 0A 0:0 0:0 0 0 0 999 1\n';
function ownerFixture({state={},cmdline,uid='0',start='42',inode='999',entries=tcp,symlink=false,mode=0o600,owner=0}={}){
 const data={pid:123,start:'42',instance:'1234567890abcdef1234567890abcdef',...state};
 return {lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>symlink,uid:owner,mode,size:100}),readFile:async file=>{
   if(file.endsWith('chrome-relay-state.json'))return JSON.stringify(data);
   if(file.endsWith('/cmdline'))return cmdline??ROOT_RELAY_NODE+'\0'+ROOT_RELAY_FILE+'\0--serve\0';
   if(file.endsWith('/status'))return 'Uid:\t'+Array(4).fill(uid).join('\t')+'\n';
   if(file.endsWith('/stat'))return statText(start);
   if(file==='/proc/net/tcp')return entries;throw new Error('unexpected file');
 },readdir:async()=>['0','1','2','21'],readlink:async()=>`socket:[${inode}]`};
}
test('root-owned listener proof binds instance to exact argv, UID, starttime and loopback socket inode',async()=>{
 assert.equal(procStartTime(statText()),'42');assert.deepEqual(localListenerInodes(tcp),['999']);
 assert.equal((await checkRelayOwner(ownerFixture())).ready,true);
 for(const change of [{cmdline:'other\0'},{uid:'10345'},{start:'43'},{inode:'998'},{entries:tcp.replace('0100007F','00000000')},{symlink:true},{mode:0o666},{owner:10345},{state:{pid:'123'}},{state:{instance:'bad'}}])assert.equal(await checkRelayOwner(ownerFixture(change)),null);
});
test('scope rejects wrong root/source/path symlinks/modes/device before service startup',async()=>{
 const base={getuid:()=>0,platform:'linux',source:pathToFileURL(ROOT_RELAY_FILE).href,lstat:async file=>({isSymbolicLink:()=>false,uid:0,mode:0o700,isFile:()=>file===ROOT_RELAY_FILE,isDirectory:()=>file!==ROOT_RELAY_FILE}),realpath:async file=>file,execute:(file,args,options,cb)=>cb(null,'YOUR_DEVICE_SERIAL')};
 await verifyRelayScope(base);
 for(const change of [{getuid:()=>10345},{source:'file:///tmp/other.mjs'},{realpath:async()=>'/different'},{lstat:async()=>({isSymbolicLink:()=>true,uid:0,mode:0o700})},{execute:(a,b,c,cb)=>cb(null,'different')}])await assert.rejects(verifyRelayScope({...base,...change}));
});
test('detached start uses fixed command and empty inherited environment; acknowledges only ready child',async()=>{
 const child=new EventEmitter();child.connected=true;let killed=false,detached=false;
 child.kill=()=>{killed=true;};child.disconnect=()=>{child.connected=false;};child.unref=()=>{detached=true;};
 const start=startRelay({spawnImpl:(file,args,options)=>{assert.equal(file,ROOT_RELAY_NODE);assert.deepEqual(args,[ROOT_RELAY_FILE,'--serve']);assert.deepEqual(Object.keys(options.env).sort(),['HOME','PATH']);queueMicrotask(()=>child.emit('message',{ready:true,port:9222}));return child;}});
 assert.equal(await start,true);assert.equal(killed,false);assert.equal(detached,true);assert.equal(child.connected,false);
});

function bridgeFixture({occupied=false,owned=false,serial='YOUR_DEVICE_SERIAL',failStart=false,signal,onCommand=()=>{},changeOwner=false}={}){
 const commands=[];let started=owned,checks=0;
 const execute=(file,args,options,callback)=>{
  const cmd=args[1];commands.push(cmd);onCommand(cmd);
  if(cmd==='id -u')return callback(null,'0');if(cmd==='getprop ro.serialno')return callback(null,serial);
  if(cmd.endsWith(' --check'))return !started?callback(Error('absent')):callback(null,JSON.stringify({ready:true,port:9222,pid:123,start:'42',instance:changeOwner&&++checks>1?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}));
  if(cmd.endsWith(' --start')){if(failStart)return callback(Error('busy'));started=true;return callback(null,'{"ready":true,"port":9222}');}
  if(cmd.endsWith('/json/version'))return callback(null,JSON.stringify({webSocketDebuggerUrl:'ws://localhost/devtools/browser'}));
  if(cmd.endsWith('/json/list'))return callback(null,'[{"type":"page","id":"172"}]');
  throw Error('unexpected command '+cmd);
 };
 const fetchImpl=async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/browser'}),{headers:{'content-type':'application/json'}});
 return {commands,execute,fetchImpl,run:()=>tryRootChromeRelay({execute,fetchImpl,probe:async()=>occupied,signal})};
}
test('wireless-free start and same-root owner checks accept fixed relay even with numeric Android targets',async()=>{
 const f=bridgeFixture();assert.equal(await f.run(),true);assert.equal(f.commands.filter(c=>c.endsWith(' --start')).length,1);
 const cmd=f.commands.find(c=>c.endsWith(' --start'));assert.ok(cmd.includes('env -i'));assert.ok(cmd.includes("'%u:%a'"));assert.ok(cmd.includes('test ! -L'));assert.ok(!f.commands.some(c=>c.includes('settings put')||c.includes('forward --remove')));
 const reused=bridgeFixture({owned:true,occupied:true});assert.equal(await reused.run(),true);assert.ok(!reused.commands.some(c=>c.endsWith(' --start')));
});
test('unverified occupied TCP, failed start and changing owner never produce a successful Root relay',async()=>{
 for(const options of [{occupied:true},{failStart:true},{owned:true,occupied:true,changeOwner:true}]){const f=bridgeFixture(options);assert.equal(await f.run(),false);if(options.occupied)assert.ok(!f.commands.some(c=>c.endsWith(' --start')));}
});
test('wrong phone and canceled attempt issue no relay start or mutation',async()=>{
 const f=bridgeFixture({serial:'wrong'});await assert.rejects(f.run(),{code:'DEVICE_MISMATCH'});assert.equal(f.commands.length,2);
 const controller=new AbortController();controller.abort();const cancelled=bridgeFixture({signal:controller.signal});await assert.rejects(cancelled.run(),{code:'ABORTED'});assert.equal(cancelled.commands.length,0);
 const mid=new AbortController(),g=bridgeFixture({signal:mid.signal,onCommand:cmd=>{if(cmd.endsWith('/json/version'))mid.abort();}});await assert.rejects(g.run(),{code:'ABORTED'});assert.ok(!g.commands.some(c=>c.endsWith(' --start')));
});
test('normal Root wake restores missing relay after starting Chrome before falling back to ADB',async()=>{
 const commands=[];let restoreCalls=0;
 const execute=(file,args,options,cb)=>{const c=args[1];commands.push(c);cb(null,c==='id -u'?'0':c==='getprop ro.serialno'?'YOUR_DEVICE_SERIAL':c==='dumpsys window policy'?'KeyguardServiceDelegate\n  showing=false\n  secure=false\n  interactiveState=INTERACTIVE_STATE_AWAKE\n':c.startsWith('am start')?'Status: ok':'');};
 assert.equal(await tryRootChromeWake({execute,restoreRelay:async()=>{restoreCalls++;assert.ok(commands.some(c=>c.startsWith('am start')));return true;}}),true);assert.equal(restoreCalls,1);
});
