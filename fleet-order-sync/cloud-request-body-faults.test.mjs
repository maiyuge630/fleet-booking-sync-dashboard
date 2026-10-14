import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {FleetCloudSync} from './cloud-runtime.mjs';
const require=createRequire(import.meta.url),{patchOrderSync}=require('./worker/patch-order-sync.cjs');
const patched=patchOrderSync(fs.readFileSync(new URL('../cloudflare-boataround-orders/after/cloudflare.js',import.meta.url),'utf8'));
const bodySource=patched.slice(patched.indexOf('async function readOrderSyncBody('),patched.indexOf('async function orderSyncRoute('));
const origin='https://body-fixture.invalid';
function fixture(kind){
 let writes=0;
 if(kind==='cloud'){
  const store={get:async()=>undefined,put:async()=>{writes++;},transaction:async fn=>fn(store),setAlarm:async()=>{writes++;}};
  const runtime=new FleetCloudSync({storage:store,binding:{},registryStatus:async()=>({}),controller:{status:async()=>({}),nextAlarmAt:async x=>x}});
  return {max:4096,writes:()=>writes,run:request=>runtime.handle(request),url:origin+'/api/cloud-sync/run'};
 }
 const ctx=vm.createContext({Uint8Array,TextDecoder,TextEncoder,setTimeout:(...args)=>globalThis.setTimeout(...args),clearTimeout:(...args)=>globalThis.clearTimeout(...args)});
 vm.runInContext('const ORDER_SYNC_MAX_BYTES=900*1024;'+bodySource,ctx);
 return {max:900*1024,writes:()=>writes,url:origin+'/api/order-sync',run:async request=>{try{await ctx.readOrderSyncBody(request);writes++;return new Response('{}');}catch(error){return new Response('{}',{status:error.status||500});}}};
}
const request=(f,body,signal)=>new Request(f.url,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body,signal,duplex:'half'});
for(const kind of ['cloud','manual-order']){
 test(kind+' aborted partial JSON settles without changing a plan or orders',async()=>{
  const f=fixture(kind);let control,started;const begun=new Promise(resolve=>{started=resolve;});
  const stream=new ReadableStream({start(c){control=c;c.enqueue(new TextEncoder().encode('{'));},pull(){started();},cancel(){return new Promise(()=>{});}},{highWaterMark:0});
  const abort=new AbortController(),running=f.run(request(f,stream,abort.signal));
  try{await begun;abort.abort();let timer;const result=await Promise.race([running,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),150);})]);clearTimeout(timer);assert.ok(result,'aborted body must finish even when sender never cancels');assert.equal(result.status,408);assert.equal(f.writes(),0);}
  finally{try{control.error(Error('cleanup'));}catch{}}
 });
 test(kind+' oversized streaming JSON never waits for sender cancellation',async()=>{
  const f=fixture(kind);let control;const stream=new ReadableStream({start(c){control=c;c.enqueue(new Uint8Array(f.max+1));},cancel(){return new Promise(()=>{});}}),running=f.run(request(f,stream));
  try{let timer;const result=await Promise.race([running,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),150);})]);clearTimeout(timer);assert.ok(result,'oversize cancellation must be fire-and-forget');assert.equal(result.status,413);assert.equal(f.writes(),0);}
  finally{try{control.error(Error('cleanup'));}catch{}}
 });
 test(kind+' slow incomplete JSON has a total deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(kind);let control,started;const begun=new Promise(resolve=>{started=resolve;});
  const stream=new ReadableStream({start(c){control=c;c.enqueue(new TextEncoder().encode('{'));},pull(){started();},cancel(){return new Promise(()=>{});}},{highWaterMark:0});
  const running=f.run(request(f,stream));let result;running.then(value=>{result=value;});
  try{await begun;t.mock.timers.tick(15001);for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(result,'unfinished JSON must expire after fifteen seconds');assert.equal(result.status,408);assert.equal(f.writes(),0);}
  finally{try{control.error(Error('cleanup'));}catch{}}
 });
}
