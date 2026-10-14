import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {WebSocketServer} from 'ws';
import {PhoneAgent,loadConfiguration} from '../core.mjs';
import {startNativeBackgroundLease} from '../server.mjs';
import {createManagementServer} from '../http.mjs';
import {prepareChromeBackground} from '../../../phone-server-deployment/provision/native-chrome-bridge.mjs';

async function fixture(t,options={}) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-runtime-v15-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const config=await loadConfiguration(home);
  const agent=await new PhoneAgent({home,config,...options}).init();
  return {agent,config,home};
}

test('an already-cancelled background lease starts neither Chrome nor periodic root work',async()=>{
  const controller=new AbortController();controller.abort();let commands=0,preparations=0;
  const stop=await startNativeBackgroundLease({signal:controller.signal,
    execute:(_file,_args,_options,done)=>{commands++;done(null,'');},prepare:async()=>{preparations++;}});
  await stop();assert.equal(commands,0);assert.equal(preparations,0);
});

test('shutdown during Chrome lease startup does not begin a late root timer',async()=>{
  const controller=new AbortController();let started,finish,preparations=0,passedSignal;
  const entered=new Promise(resolve=>{started=resolve;});
  const starting=startNativeBackgroundLease({signal:controller.signal,
    execute:(_file,_args,options,done)=>{passedSignal=options.signal;finish=done;started();},
    prepare:async()=>{preparations++;},intervalMs:2});
  await entered;controller.abort();finish(Object.assign(Error('aborted'),{code:'ABORT_ERR'}));
  const stop=await starting;await stop();
  assert.equal(passedSignal?.aborted,true);assert.equal(preparations,0);
});

test('concurrent lease stop callers all wait for the same in-flight root cleanup',async()=>{
  let entered,release,secondFinished=false;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const stop=await startNativeBackgroundLease({execute:(_f,_a,_o,done)=>done(null,''),
    prepare:async()=>{entered();await gate;}});
  await ready;const first=stop(),second=stop().then(()=>{secondFinished=true;});
  await new Promise(resolve=>setImmediate(resolve));const settledEarly=secondFinished;
  release();await Promise.all([first,second]);assert.equal(settledEarly,false);
});

test('PhoneAgent shutdown aborts run-level background startup before any source begins',async t=>{
  let entered,release,startSignal,stops=0;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const {agent}=await fixture(t,{nativeBackgroundLease:async options=>{
    startSignal=options?.signal;entered();await gate;return async()=>{stops++;};
  }});
  const running=agent.run();await ready;await agent.close();release();
  assert.deepEqual(await running,{ok:false,reason:'closed'});
  assert.equal(startSignal?.aborted,true);assert.equal(stops,1);
  assert.equal(agent.state.sources.boataround.last_attempt_at,null);
});

test('a shutdown-time local sync request is rejected instead of falsely reporting started',async t=>{
  const {agent,config,home}=await fixture(t);await agent.close();let runs=0;
  const run=agent.run.bind(agent);agent.run=async(...args)=>{runs++;return run(...args);};
  const server=createManagementServer({agent,config,novncRoot:home,WebSocketServer});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/run',{method:'POST',
    headers:{Authorization:'Basic '+Buffer.from(config.admin_user+':'+config.admin_password).toString('base64'),'Content-Type':'application/json'},body:'{}'});
  const body=await response.json();assert.equal(response.status,503);assert.equal(body.ok,false);
  assert.equal(body.reason,'closed');assert.equal(runs,0);
});

test('root preparation cancellation after process discovery issues no further root command',async()=>{
  const controller=new AbortController(),commands=[];
  await assert.rejects(prepareChromeBackground({signal:controller.signal,execute:(_file,args,_opts,done)=>{
    commands.push(args[1]);if(commands.length===1)controller.abort();done(null,'123 com.android.chrome');
  }}),{code:'ABORTED'});
  assert.deepEqual(commands,['ps -A -o PID,NAME']);
});

test('a partially received sync body cannot start a job after shutdown',async t=>{
  const {agent,config,home}=await fixture(t);let runs=0;
  agent.run=async()=>{runs++;return {ok:true};};
  const server=createManagementServer({agent,config,novncRoot:home,WebSocketServer});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const socket=net.connect({port:server.address().port,host:'127.0.0.1'});
  t.after(()=>{socket.destroy();return new Promise(resolve=>server.close(resolve));});
  const bodyEntered=new Promise(resolve=>server.once('request',resolve));
  const response=new Promise((resolve,reject)=>{let data='';socket.on('data',chunk=>{data+=chunk;});socket.on('end',()=>resolve(data));socket.on('error',reject);});
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write('POST /api/run HTTP/1.1\r\nHost: 127.0.0.1:'+server.address().port+'\r\nAuthorization: Basic '+
    Buffer.from(config.admin_user+':'+config.admin_password).toString('base64')+'\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{');
  await bodyEntered;await agent.close();socket.write('}');
  assert.match(await response,/HTTP\/1\.1 503 Service Unavailable/);assert.equal(runs,0);
});
