import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {VoltageService,nextVoltageRun} from './phone-server/voltage.mjs';
import {WorkerClient,writeJSON} from './phone-server/core.mjs';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from './phone-agent.mjs';
import {VOLTAGE_BOATS,VOLTAGE_KEY,normalizeVoltage} from './voltage-data.mjs';

const BASE=Date.parse('2026-09-12T09:30:00.000Z');
const readings=()=>Object.keys(VOLTAGE_BOATS).map(code=>({code,volts:13,online:true,power:'normal',low_voltage:false,source_time:'2026-09-12 17:29:00',motion_state:'stationary',stationary_time:'3 天'}));
const envelope=(now,devices=readings())=>({version:1,checked_at:new Date(now).toISOString(),next_run_at:nextVoltageRun(now),outcome:'success',devices});
function cloud(clock,intercept){
 const token='a'.repeat(43),values=new Map([[PHONE_AGENT_KEY,{token_hash:createHash('sha256').update(token).digest('hex')}]]);
 const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async transaction(f){return f(this);}};
 const agent=new FleetPhoneAgent({storage,now:()=>clock.now,ingest:()=>{throw Error('orders must not be touched');},registryStatus:async()=>({})});
 const remote=new WorkerClient({device_token:token},async(url,options)=>intercept?.(JSON.parse(options.body))||agent.machine(new Request(url,options)));
 return {remote,values};
}
async function temporaryHome(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'voltage-recovery-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));return home;}

test('all 100 schema-valid devices fit the bounded cloud voltage route',async()=>{
 const clock={now:BASE},f=cloud(clock),devices=readings();
 while(devices.length<100)devices.push({...devices[0],code:'EXTRA'+String(devices.length).padStart(25,'0')});
 // An 80-code-unit escaped value exercises the JSON byte boundary as well as
 // ordinary Chinese descriptions. Both are permitted by the existing schema.
 for(const d of devices)d.stationary_time='\ud800'.repeat(80);
 const snapshot=envelope(BASE,devices);assert.equal(normalizeVoltage(snapshot,BASE).devices.length,100);
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>32768);
 assert.deepEqual(await f.remote.request('voltage',snapshot),{ok:true});
 assert.equal(f.values.get(VOLTAGE_KEY).devices.length,100);
 await assert.rejects(f.remote.request('voltage',{...snapshot,padding:'x'.repeat(128*1024)}),{code:'worker_unavailable',status:413});
 assert.equal(f.values.get(VOLTAGE_KEY).devices.length,100);
});

test('a permanent rejection survives restart as a failure report, then fresh collection resumes',async t=>{
 const clock={now:BASE},f=cloud(clock),home=await temporaryHome(t);
 await f.remote.request('voltage',envelope(BASE-1000));const previous=structuredClone(f.values.get(VOLTAGE_KEY));
 let collects=0;
 const collect=async()=>{collects++;const data=readings();if(collects===1)data[0].volts='invalid';return data;};
 let service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();
 await service.tick();
 assert.equal(service.state.pending.outcome,'failure');assert.equal(service.state.last_error,'schema_changed');
 assert.deepEqual(f.values.get(VOLTAGE_KEY),previous);
 const rejected=JSON.parse(await fs.readFile(path.join(home,'voltage-rejected-success.json'),'utf8'));
 assert.equal(rejected.http_status,400);assert.equal(rejected.snapshot.devices[0].volts,'invalid');
 service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();
 clock.now+=60000;await service.tick();
 assert.equal(collects,1);assert.equal(service.state.pending,null);
 const failure=f.values.get(VOLTAGE_KEY);assert.equal(failure.error_code,'schema_changed');
 assert.equal(failure.last_success_at,previous.last_success_at);assert.deepEqual(failure.devices,previous.devices);
 clock.now=BASE+15*60000;await service.tick();
 assert.equal(collects,2);assert.equal(service.state.last_error,null);assert.equal(service.state.pending,null);
 assert.equal(f.values.get(VOLTAGE_KEY).error_code,null);
 assert.equal(f.values.get(VOLTAGE_KEY).last_success_at,new Date(clock.now).toISOString());
});

for(const status of [400,413,415,422])test('HTTP '+status+' rejects once, records bounded evidence and waits before recollection',async t=>{
 const clock={now:BASE},home=await temporaryHome(t);let requests=0,collects=0;
 const f=cloud(clock,()=>{requests++;return new Response('{}',{status});});
 const service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect:async()=>{collects++;return readings();}}).init();
 await service.tick();clock.now+=60000;await service.tick();
 assert.equal(service.state.pending,null);assert.equal(collects,1);assert.equal(requests,2);
 await Promise.all(Array.from({length:10},()=>service.tick()));assert.equal(requests,2);
 const rejectionFiles=(await fs.readdir(home)).filter(name=>name.startsWith('voltage-rejected-'));
 assert.deepEqual(rejectionFiles.sort(),['voltage-rejected-failure.json','voltage-rejected-success.json']);
 clock.now=Date.parse(service.state.next_run_at);await service.tick();assert.equal(collects,2);assert.equal(requests,3);
 assert.equal((await fs.readdir(home)).filter(name=>name.startsWith('voltage-rejected-')).length,2);
});

for(const status of [401,403,429,500,503])test('HTTP '+status+' retains exact pending across restart for recoverable delivery',async t=>{
 const clock={now:BASE},home=await temporaryHome(t);let failure=true,collects=0;
 const f=cloud(clock,()=>failure?new Response('{}',{status}):null);
 const collect=async()=>{collects++;return readings();};
 let service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();await service.tick();
 const pending=structuredClone(service.state.pending);assert.equal(pending.outcome,'success');
 assert.equal(service.state.last_upload_rejection,undefined);
 service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();
 assert.deepEqual(service.state.pending,pending);failure=false;clock.now+=60001;await service.tick();
 assert.equal(collects,1);assert.equal(service.state.pending,null);
 assert.equal(f.values.get(VOLTAGE_KEY).last_success_at,pending.checked_at);
});

for(const failingWrite of ['diagnostic','replacement'])test('failed '+failingWrite+' save cannot discard the rejected pending snapshot',async t=>{
 const clock={now:BASE},home=await temporaryHome(t),f=cloud(clock,()=>new Response('{}',{status:400}));
 let blocked=true;
 const save=async(filename,state)=>{
  if(blocked&&(failingWrite==='diagnostic'?path.basename(filename)==='voltage-rejected-success.json':path.basename(filename)==='voltage-state.json'&&state.pending?.outcome==='failure'))throw Error('disk unavailable');
  return writeJSON(filename,state);
 };
 const service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect:async()=>readings(),save}).init();await service.tick();
 assert.equal(service.state.pending.outcome,'success');
 assert.equal(JSON.parse(await fs.readFile(service.file,'utf8')).pending.outcome,'success');
 blocked=false;clock.now+=60001;await service.tick();assert.equal(service.state.pending.outcome,'failure');
});

test('successful upload with failed acknowledgement save retains pending and retries idempotently',async t=>{
 const clock={now:BASE},home=await temporaryHome(t),f=cloud(clock);let blocked=true,collects=0;
 const save=async(filename,state)=>{if(blocked&&state.pending===null)throw Error('disk unavailable');return writeJSON(filename,state);};
 const service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect:async()=>{collects++;return readings();},save}).init();
 await service.tick();assert.equal(service.state.pending.outcome,'success');
 const first=structuredClone(f.values.get(VOLTAGE_KEY));blocked=false;clock.now+=60001;await service.tick();
  assert.equal(collects,1);assert.equal(service.state.pending,null);assert.deepEqual(f.values.get(VOLTAGE_KEY),first);
});

for(const receipt of [null,{},[],{ok:false},{ok:'true'}])test('invalid successful-HTTP voltage acknowledgement '+JSON.stringify(receipt)+' retains exact pending until confirmed',async t=>{
 const clock={now:BASE},home=await temporaryHome(t);let broken=true,collects=0;
 const f=cloud(clock,()=>broken?new Response(JSON.stringify(receipt),{status:200}):null);
 const collect=async()=>{collects++;return readings();};
 let service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();
 await service.tick();
 const pending=structuredClone(service.state.pending);assert.equal(pending.outcome,'success');
 assert.equal(f.values.has(VOLTAGE_KEY),false);
 assert.deepEqual(JSON.parse(await fs.readFile(service.file,'utf8')).pending,pending);
 service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect}).init();
 broken=false;clock.now+=60001;await service.tick();
 assert.equal(collects,1);assert.equal(service.state.pending,null);
 assert.equal(f.values.get(VOLTAGE_KEY).last_success_at,pending.checked_at);
});

test('large time rollback during a permanent rejection cannot cause a tight retry loop',async t=>{
 const clock={now:BASE},home=await temporaryHome(t);let requests=0,collects=0;
 const f=cloud(clock,()=>{requests++;return new Response('{}',{status:400});});
 const service=await new VoltageService({home,remote:f.remote,now:()=>clock.now,collect:async()=>{collects++;return readings();}}).init();
 await service.tick();clock.now-=2*86400000;await service.tick();
 // The old future timestamp is invalidated once, yielding one fresh attempt.
 assert.equal(collects,2);await service.tick();const attempts=requests;
 await Promise.all(Array.from({length:10},()=>service.tick()));assert.equal(requests,attempts);
 assert.equal(service.state.pending,null);assert.equal(Date.parse(service.state.next_run_at)-clock.now,15*60000);
});
