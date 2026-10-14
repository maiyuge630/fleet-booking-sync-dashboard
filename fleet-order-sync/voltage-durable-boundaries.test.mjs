import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {VoltageService,nextVoltageRun,projectReadings} from './phone-server/voltage.mjs';
import {writeJSON} from './phone-server/core.mjs';
import {normalizeVoltage,VOLTAGE_BOATS} from './voltage-data.mjs';
const BASE=Date.parse('2026-09-14T03:00:00.000Z');
const devices=()=>Object.keys(VOLTAGE_BOATS).map(code=>({code,volts:13,online:true,power:'normal',low_voltage:false,source_time:'2026-09-14 11:00:00',motion_state:'stationary',stationary_time:'1 天'}));
const snapshot=(now=BASE)=>({version:1,checked_at:new Date(now).toISOString(),next_run_at:nextVoltageRun(now),outcome:'success',devices:devices()});
const appRows=()=>devices().map(d=>({vkey:'synthetic-'+d.code,carNum:d.code,vol:d.volts,onlineStatus:1,ups:1,connTime:d.source_time}));
async function home(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voltage-durable-v15-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('disk full before the first durable telemetry save cannot send an unpersisted reading on the next tick',async t=>{
 const dir=await home(t);let now=BASE,blocked=true,requests=0,collects=0;
 const service=await new VoltageService({home:dir,now:()=>now,collect:async()=>{collects++;return devices();},save:async(f,s)=>{if(blocked)throw Object.assign(Error('full'),{code:'ENOSPC'});await writeJSON(f,s);},remote:{request:async(_action,payload)=>{requests++;const disk=JSON.parse(await fs.readFile(service.file,'utf8'));assert.deepEqual(disk.pending,payload,'every delivered snapshot must exist durably before transport');return {ok:true};}}}).init();
 await service.tick();assert.equal(requests,0);assert.equal(service.state.pending,null);
 now+=60001;await service.tick();assert.equal(requests,0,'disk remains full on retry');assert.equal(service.state.pending,null);
 blocked=false;now+=60001;await service.tick();assert.equal(requests,1);assert.equal(service.state.pending,null);assert.equal(collects,3);
 const restarted=await new VoltageService({home:dir,remote:{},now:()=>now}).init();assert.equal(restarted.state.next_run_at,nextVoltageRun(now));
});

for(const kind of ['future-pending','future-schedule'])test('failed clock-repair save preserves the last durable '+kind+' state until a successful commit',async t=>{
 const dir=await home(t);let now=BASE,blocked=true;
 const original={version:1,next_run_at:nextVoltageRun(BASE+3*86400000),pending:kind==='future-pending'?snapshot(BASE+3*86400000):null};
 await writeJSON(path.join(dir,'voltage-state.json'),original);
 const service=await new VoltageService({home:dir,now:()=>now,collect:async()=>devices(),save:async(f,s)=>{if(blocked)throw Error('disk full');await writeJSON(f,s);},remote:{request:async()=>({ok:true})}}).init();
 await service.tick();assert.deepEqual(service.state,original);assert.deepEqual(JSON.parse(await fs.readFile(service.file,'utf8')),original);
 blocked=false;now+=60001;await service.tick();assert.ok(Date.parse(service.state.next_run_at)<=now+86400000);assert.deepEqual(JSON.parse(await fs.readFile(service.file,'utf8')),service.state);
});

test('impossible source calendar dates cannot become apparently fresh fleet telemetry',()=>{
 for(const date of ['2026-02-29 12:00:00','2026-04-31 12:00:00','2026-09-31 12:00:00']){
  const rows=appRows();rows[0].connTime=date;assert.throws(()=>projectReadings(rows,[]),{code:'schema_changed'});
  const input=snapshot();input.devices[0].source_time=date;assert.throws(()=>normalizeVoltage(input,BASE),{status:400});
 }
 const valid=appRows();valid[0].connTime='2028-02-29 12:00:00';assert.equal(projectReadings(valid,[]).length,7);
});

test('the low-voltage view must refer to the same device identity as the complete fleet view',()=>{
 const rows=appRows(),wrong={...rows[0],carNum:'AD5'};
 assert.throws(()=>projectReadings(rows,[wrong]),{code:'incomplete_pages'});
 assert.equal(projectReadings(rows,[{...rows[0],vol:12}])[0].low_voltage,true,'value changes between endpoints do not change identity');
});
