import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from './phone-agent.mjs';
const ORIGIN='https://body-fault-fixture.invalid',TOKEN='v'.repeat(43);
function fixture(){
 const values=new Map([[PHONE_AGENT_KEY,{mode:'phone',token_hash:createHash('sha256').update(TOKEN).digest('hex'),enabled:true,state:'idle'}]]);
 const storage={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),transaction:async f=>f(storage)};
 const agent=new FleetPhoneAgent({storage,registryStatus:async()=>({}),ingest:()=>{throw Error('not used');}});
 return {agent,values};
}
const request=(body,signal)=>new Request(ORIGIN+'/api/agent/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body,signal,duplex:'half'});

test('an aborted partial body releases the serialized phone queue without committing a heartbeat',async()=>{
 const f=fixture(),before=structuredClone(f.values.get(PHONE_AGENT_KEY));let streamController,readStarted;
 const begun=new Promise(resolve=>{readStarted=resolve;});
 const stream=new ReadableStream({start(c){streamController=c;c.enqueue(new TextEncoder().encode('{'));},pull(){readStarted();},cancel(){return new Promise(()=>{});}},{highWaterMark:0});
 const abort=new AbortController(),running=f.agent.machine(request(stream,abort.signal));
 try{
  await begun;abort.abort();
  let timer;const result=await Promise.race([running,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),150);})]);clearTimeout(timer);
  assert.ok(result,'partial aborted request must not hold the whole agent queue');assert.equal(result.status,408);
  assert.deepEqual(f.values.get(PHONE_AGENT_KEY),before);
  const poll=await f.agent.machine(new Request(ORIGIN+'/api/agent/poll',{headers:{Authorization:'Bearer '+TOKEN}}));assert.equal(poll.status,200);
 }finally{try{streamController.error(Error('fixture cleanup'));}catch{}await running;}
});

test('a slow incomplete body has a total deadline even when cancellation never settles',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();let streamController,readStarted;
 const begun=new Promise(resolve=>{readStarted=resolve;});
 const stream=new ReadableStream({start(c){streamController=c;c.enqueue(new TextEncoder().encode('{'));},pull(){readStarted();},cancel(){return new Promise(()=>{});}},{highWaterMark:0});
 const running=f.agent.machine(request(stream));let settled=null;running.then(r=>{settled=r;});
 try{
  await begun;
  // Zero prefetch ensures pull follows the receiver's first read, after its
  // body deadline was installed; no timing guess for credential verification.
  t.mock.timers.tick(30001);
  for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(settled,'every body must release the serialized queue within 30 seconds');assert.equal(settled.status,408);
  assert.equal(f.values.get(PHONE_AGENT_KEY).last_seen,undefined);
 }finally{try{streamController.error(Error('fixture cleanup'));}catch{}await running;}
});

test('oversized streaming bodies fail promptly when the sender refuses cancellation',async()=>{
 const f=fixture();let streamController;
 const stream=new ReadableStream({start(c){streamController=c;c.enqueue(new Uint8Array(5000));},cancel(){return new Promise(()=>{});}});
 const running=f.agent.machine(request(stream));
 try{let timer;const result=await Promise.race([running,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),150);})]);clearTimeout(timer);assert.ok(result);assert.equal(result.status,413);}
 finally{try{streamController.error(Error('fixture cleanup'));}catch{}/* A pending cancel in the old implementation never settles. */}
});
