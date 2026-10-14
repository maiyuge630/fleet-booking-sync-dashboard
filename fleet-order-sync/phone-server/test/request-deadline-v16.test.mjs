import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkerClient,PhoneAgent,failureCode} from '../core.mjs';

const CONFIG={paired:true,device_token:'synthetic-deadline-test'};
const realTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const never=()=>new Promise(()=>{});
const drain=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function observe(promise){const result={settled:false};promise.then(value=>Object.assign(result,{settled:true,value}),error=>Object.assign(result,{settled:true,error}));return result;}
function streamResponse({read=never,cancel=never,status=200}={}){
 const stats={reads:0,cancels:0,releases:0};
 const reader={read(){stats.reads++;return read();},cancel(){stats.cancels++;return cancel();},releaseLock(){stats.releases++;}};
 return {response:{status,body:{getReader:()=>reader,cancel(){stats.cancels++;return cancel();}}},stats};
}

test('request deadline bounds a fetch that ignores abort and does not start another request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,signal;
 const client=new WorkerClient(CONFIG,(_url,options)=>{calls++;signal=options.signal;return never();});
 const result=observe(client.poll());await drain();t.mock.timers.tick(30000);await drain();
 assert.equal(result.settled,true);assert.equal(result.error?.name,'TimeoutError');assert.equal(failureCode(result.error),'fetch_failed');
 assert.equal(signal.aborted,true);assert.equal(calls,1);
});

test('one total deadline covers response reading even when read and cancel both ignore abort',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {response,stats}=streamResponse();let signal;
 const client=new WorkerClient(CONFIG,async(_url,options)=>{signal=options.signal;return response;});
 const result=observe(client.poll());await drain();assert.equal(stats.reads,1);
 t.mock.timers.tick(30000);await drain();
 assert.equal(result.settled,true);assert.equal(result.error?.name,'TimeoutError');assert.equal(signal.aborted,true);
 assert.equal(stats.cancels,1);assert.equal(stats.releases,1);
});

test('receiving a slow chunk does not reset the overall response deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const first=defer();let reads=0;
 const {response}=streamResponse({read:()=>++reads===1?first.promise:never()});
 const result=observe(new WorkerClient(CONFIG,async()=>response).poll());await drain();
 t.mock.timers.tick(20000);first.resolve({done:false,value:Buffer.from('{')});await drain();assert.equal(reads,2);
 t.mock.timers.tick(10000);await drain();assert.equal(result.settled,true);assert.equal(result.error?.name,'TimeoutError');
});

test('HTTP error classification is immediate even if response cancellation never settles',async()=>{
 for(const [status,code] of [[401,'device_auth_required'],[403,'device_auth_required'],[413,'worker_unavailable'],[503,'worker_unavailable']]){
  const {response,stats}=streamResponse({status});const result=observe(new WorkerClient(CONFIG,async()=>response).poll());await drain();
  assert.equal(result.settled,true,'HTTP '+status);assert.equal(result.error?.code,code);assert.equal(result.error?.status,status);
  assert.equal(stats.cancels,1);assert.equal(stats.reads,0);
 }
});

test('oversize response is rejected without waiting for cancel or reading more bytes',async()=>{
 const {response,stats}=streamResponse({read:async()=>({done:false,value:new Uint8Array(1024*1024+1)})});
 const result=observe(new WorkerClient(CONFIG,async()=>response).poll());await drain();
 assert.equal(result.settled,true);assert.equal(result.error?.code,'worker_response_invalid');
 assert.equal(stats.reads,1);assert.equal(stats.cancels,1);assert.equal(stats.releases,1);
});

test('an already-aborted caller starts no fetch and does not expose its arbitrary abort reason',async()=>{
 const controller=new AbortController();controller.abort('arbitrary-private-abort-detail');let calls=0;
 const client=new WorkerClient(CONFIG,async()=>{calls++;return new Response('{}');});
 const result=observe(client.request('poll',null,'GET',{signal:controller.signal}));await drain();
 assert.equal(result.settled,true);assert.equal(result.error?.name,'AbortError');assert.equal(calls,0);
 assert.ok(!String(result.error).includes('arbitrary-private-abort-detail'));
});

test('abort during fetch settles promptly and cancels a late response exactly once',async()=>{
 const controller=new AbortController(),pending=defer();let signal;const {response,stats}=streamResponse();
 const client=new WorkerClient(CONFIG,(_url,options)=>{signal=options.signal;return pending.promise;});
 const result=observe(client.request('poll',null,'GET',{signal:controller.signal}));await drain();controller.abort();await drain();
 try{assert.equal(result.settled,true);assert.equal(result.error?.name,'AbortError');assert.equal(signal.aborted,true);}
 finally{pending.resolve(response);await drain();}
 assert.equal(stats.cancels,1);assert.equal(stats.reads,0);assert.equal(result.value,undefined);
});

test('abort during body reading releases the reader despite a hanging cancel and ignores late failure',async()=>{
 const controller=new AbortController(),pending=defer();const {response,stats}=streamResponse({read:()=>pending.promise});
 const client=new WorkerClient(CONFIG,async()=>response),result=observe(client.request('poll',null,'GET',{signal:controller.signal}));
 await drain();controller.abort();await drain();
 try{assert.equal(result.settled,true);assert.equal(result.error?.name,'AbortError');assert.equal(stats.cancels,1);assert.equal(stats.releases,1);}
 finally{pending.reject(Error('late synthetic read failure'));await drain();}
 assert.equal(result.value,undefined);
});

test('successful split UTF-8 207 response clears its deadline without aborting the completed request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const bytes=Buffer.from('{"ok":true,"text":"船"}');let offset=0,signal;
 const {response,stats}=streamResponse({status:207,read:async()=>offset===bytes.length?{done:true}:{done:false,value:bytes.subarray(offset,++offset)}});
 const client=new WorkerClient(CONFIG,async(_url,options)=>{signal=options.signal;return response;});
 assert.deepEqual(await client.upload({snapshots:[]}),{ok:true,text:'船'});
 t.mock.timers.tick(60000);await drain();assert.equal(signal.aborted,false);assert.equal(stats.cancels,0);assert.equal(stats.releases,1);
});

test('response cancellation rejection or synchronous throw cannot replace the classified request failure',async()=>{
 for(const cancel of [()=>Promise.reject(Error('synthetic cancel rejection')),()=>{throw Error('synthetic cancel throw');}]){
  const {response}=streamResponse({status:401,cancel});const result=observe(new WorkerClient(CONFIG,async()=>response).poll());await drain();
  assert.equal(result.settled,true);assert.equal(result.error?.code,'device_auth_required');assert.equal(result.error?.status,401);
 }
});

test('ordinary fetch and body failures retain their original error and stop further reads',async()=>{
 const original=Object.assign(Error('synthetic network error'),{code:'ECONNRESET'});
 await assert.rejects(new WorkerClient(CONFIG,async()=>{throw original;}).poll(),error=>error===original);
 const {response,stats}=streamResponse({read:async()=>{throw original;},cancel:async()=>{}});
 await assert.rejects(new WorkerClient(CONFIG,async()=>response).poll(),error=>error===original);
 assert.equal(stats.reads,1);assert.equal(stats.releases,1);
});

test('a timed-out idle poll releases the agent lock and the next poll succeeds without collecting',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-request-deadline-'));const first=defer();let calls=0,collections=0;
 const remote=new WorkerClient(CONFIG,async()=>++calls===1?first.promise:new Response('{"ok":true,"enabled":false}'));
 const agent=await new PhoneAgent({home,config:CONFIG,remote,collectors:{},verifyAuth:{},platformUrls:{},browserFactory:()=>{collections++;throw Error('unexpected browser');}}).init();
 t.mock.timers.enable({apis:['setTimeout']});const running=agent.tick();let timer;
 try{
  await drain();assert.equal(agent.polling,true);t.mock.timers.tick(30000);
  const finished=await Promise.race([running.then(()=>true),new Promise(resolve=>{timer=realTimeout(()=>resolve(false),500);})]);
  realClearTimeout(timer);assert.equal(finished,true,'expired poll must release the polling lock');
  assert.equal(agent.polling,false);assert.equal(agent.state.remote_error,'poll_failed');
  await agent.tick();assert.equal(calls,2);assert.equal(collections,0);assert.equal(agent.state.remote_error,null);
 }finally{
  realClearTimeout(timer);first.resolve(new Response('{"ok":true,"enabled":false}'));await running;await agent.close();await fs.rm(home,{recursive:true,force:true});
 }
});

test('local polling diagnostics distinguish blocked, failed and successful polls without persisting them',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-poll-diagnostic-')),pending=defer();let now=Date.parse('2026-09-14T13:00:00Z');
 const agent=await new PhoneAgent({home,config:CONFIG,remote:{poll:()=>pending.promise},collectors:{},now:()=>now}).init();
 const running=agent.tick();
 try{
  await drain();let status=await agent.status();assert.equal(status.runtime.polling,true);
  assert.deepEqual(status.runtime,{polling:true,last_poll_started_at:'2026-09-14T13:00:00.000Z',last_poll_finished_at:null,last_poll_success_at:null});
  now+=1000;pending.resolve({ok:false,enabled:false});await running;status=await agent.status();
  assert.deepEqual(status.runtime,{polling:false,last_poll_started_at:'2026-09-14T13:00:00.000Z',last_poll_finished_at:'2026-09-14T13:00:01.000Z',last_poll_success_at:null});
  agent.remote.poll=async()=>({ok:true,enabled:false});now+=1000;await agent.tick();
  status=await agent.status();assert.equal(status.runtime.last_poll_success_at,'2026-09-14T13:00:02.000Z');
  const persisted=JSON.parse(await fs.readFile(path.join(home,'state.json'),'utf8'));
  assert.equal(Object.hasOwn(persisted,'runtime'),false);assert.equal(Object.hasOwn(persisted,'pollDiagnostics'),false);
  assert.deepEqual(Object.keys(status.runtime).sort(),['last_poll_finished_at','last_poll_started_at','last_poll_success_at','polling']);
 }finally{pending.resolve({ok:true,enabled:false});await running;await agent.close();await fs.rm(home,{recursive:true,force:true});}
});

test('a poll returning after close cannot update the local completion or success diagnostic',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-poll-late-')),pending=defer();let now=Date.parse('2026-09-14T13:00:00Z');
 const agent=await new PhoneAgent({home,config:CONFIG,remote:{poll:()=>pending.promise},collectors:{},now:()=>now}).init();
 const running=agent.tick();
 try{
  await drain();const before={...agent.pollDiagnostics};await agent.close();now+=300000;
  pending.resolve({ok:true,enabled:false});await running;
  assert.deepEqual(agent.pollDiagnostics,before);assert.equal(agent.pollDiagnostics.last_poll_finished_at,null);
  assert.equal(agent.state.last_contact_at,null);assert.equal(agent.polling,false);
 }finally{pending.resolve({ok:true,enabled:false});await running;await agent.close();await fs.rm(home,{recursive:true,force:true});}
});
