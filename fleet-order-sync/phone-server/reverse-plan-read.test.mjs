import test from 'node:test';
import assert from 'node:assert/strict';
import {readReversePlan} from './reverse-plan-read.mjs';
import {WorkerClient} from './core.mjs';
import {ReverseExecutor} from '../reverse-sync/executor.mjs';
const reset=()=>Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('socket reset'),{code:'ECONNRESET'})});
const fast={retryDelays:[0,0,0,0]};

test('two connection resets recover through a third fresh GET with no cached plan',async()=>{
 let calls=0;const current={targets:[{fresh:true,revision:7}]};
 const remote={request:async(route,body,method,options)=>{
  assert.equal(route,'reverse-plan');assert.equal(body,null);assert.equal(method,'GET');assert.ok(options.signal instanceof AbortSignal);
  if(++calls<=2)throw reset();return current;
 }};
 assert.equal(await readReversePlan(remote,fast),current);assert.equal(calls,3);
});

test('persistent connection reset is bounded and produces a safe distinct failure',async()=>{
 let calls=0;const remote={request:async()=>{calls++;throw reset();}};
 await assert.rejects(readReversePlan(remote,fast),e=>e.message==='reverse_plan_unavailable'&&e.code==='reverse_plan_unavailable');
 assert.equal(calls,5);
});

test('a longer reset burst can recover on the last allowed fresh GET',async()=>{
 let calls=0;const current={ok:true,revision:9,targets:[]};
 const actual=await readReversePlan({request:async()=>{if(++calls<5)throw reset();return current;}},fast);
 assert.equal(actual,current);assert.equal(calls,5);
});

test('only transient HTTP server failures retry; auth, schema, certificate and rate limits do not',async()=>{
 for(const error of [Object.assign(Error('device_auth_required'),{code:'device_auth_required',status:401}),
  Object.assign(Error('worker_unavailable'),{code:'worker_unavailable',status:429}),
  Object.assign(Error('worker_unavailable'),{code:'worker_unavailable',status:404}),
  Object.assign(Error('worker_response_invalid'),{code:'worker_response_invalid'}),
  Object.assign(new TypeError('fetch failed'),{cause:{code:'CERT_HAS_EXPIRED'}}),Error('programming mistake')]){
  let calls=0;await assert.rejects(readReversePlan({request:async()=>{calls++;throw error;}},fast),e=>e===error);assert.equal(calls,1);
 }
 for(const status of [500,502,503,504,520,522]){
  let calls=0;const result=await readReversePlan({request:async()=>{if(++calls===1)throw Object.assign(Error('worker_unavailable'),{code:'worker_unavailable',status});return {ok:true};}},fast);
  assert.equal(result.ok,true);assert.equal(calls,2);
 }
});

test('the total deadline also bounds a fetch implementation that ignores abort',async()=>{
 // Keep the test alive independently of production's unref'ed deadline timer.
 const alive=setTimeout(()=>{},1000);let calls=0;
 try{await assert.rejects(readReversePlan({request:async()=>{calls++;return new Promise(()=>{});}},{...fast,timeoutMs:20}),/reverse_plan_unavailable/);}
 finally{clearTimeout(alive);}
 assert.equal(calls,1);
});

test('cancellation before or during retry never starts another request',async()=>{
 const before=new AbortController();before.abort();let calls=0;
 await assert.rejects(readReversePlan({request:async()=>{calls++;}},{signal:before.signal}),{name:'AbortError'});assert.equal(calls,0);
 const during=new AbortController();
 await assert.rejects(readReversePlan({request:async()=>{calls++;setTimeout(()=>during.abort(),5);throw reset();}},{signal:during.signal,retryDelays:[50,50]}),{name:'AbortError'});
 assert.equal(calls,1);
 let closed=false;
 await assert.rejects(readReversePlan({request:async()=>{closed=true;throw reset();}},{...fast,isCancelled:()=>closed}),/phone_shutdown/);
});

test('a caller shutdown after a successful GET cannot publish its late result',async()=>{
 let closed=false;
 await assert.rejects(readReversePlan({request:async()=>{closed=true;return {ok:true};}},{isCancelled:()=>closed}),/phone_shutdown/);
});

test('retry uses a freshly parsed complete response and never retries malformed JSON',async()=>{
 let calls=0;const remote=new WorkerClient({device_token:'test'},async()=>{
  if(++calls===1)throw reset();return new Response(JSON.stringify({ok:true,targets:[],revision:2}));
 });
 assert.equal((await readReversePlan(remote,fast)).revision,2);assert.equal(calls,2);
 calls=0;const invalid=new WorkerClient({device_token:'test'},async()=>{calls++;return new Response('{');});
 await assert.rejects(readReversePlan(invalid,fast),/worker_response_invalid/);assert.equal(calls,1);
});

test('source changes during a retry still stop the executor before any platform mutation',async()=>{
 const now=Date.now(),target={target:'example',boat:'ad2',listing_id:'1',fresh:true,segments:[{start:'2026-12-05',end:'2026-12-12',causes:['paid:1']}]};
 let calls=0,writes=0,ledger;
 // Calls: initial plan, per-target plan, then the pre-write check whose first
 // try is reset and whose retry sees a changed source.
 const remote={request:async()=>{
  calls++;if(calls===3)throw reset();
  return {generated_at:new Date(now).toISOString(),targets:[calls>=4?{...target,segments:[]} :target]};
 }};
 const adapter={read:async()=>({complete:true,identity_verified:true,blocks:[]}),submit:async()=>{writes++;throw Error('should not write');}};
 const engine=new ReverseExecutor({load:async()=>null,save:async l=>{ledger=structuredClone(l);},plan:()=>readReversePlan(remote,fast),adapters:{example:adapter},now:()=>now});
 await engine.run();assert.equal(writes,0);assert.equal(ledger.targets['example:1'].error,'source_changed_or_stale');
});

test('POST requests still have exactly one attempt after a lost response',async()=>{
 for(const route of ['order-sync','reverse-report','heartbeat']){
  let calls=0;const remote=new WorkerClient({device_token:'test'},async(_url,options)=>{calls++;assert.equal(options.method,'POST');throw reset();});
  await assert.rejects(remote.request(route,{test:true}),/fetch failed/);assert.equal(calls,1);
 }
});
