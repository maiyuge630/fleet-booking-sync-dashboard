import test from 'node:test';
import assert from 'node:assert/strict';
import {collectVoltage,readStationary,nextVoltageRun,projectReadings,reportPages} from './phone-server/voltage.mjs';
import {normalizeVoltage,VOLTAGE_BOATS,mergeVoltage} from './voltage-data.mjs';
const row={vkey:'private-device-id',carNum:'ADD'};
const detail=(change={})=>({errorCode:0,results:{...row,isConn:1,isOverSpeed:0,speed:0,stopTime:'136.4天',...change}});
const response=j=>new Response(JSON.stringify(j));
test('stationary duration uses verified app detail control and source text, without leaking device identity',async()=>{
 const value=await readStationary({},row,async u=>{assert.equal(u.origin,'http://api.azlmap.com');assert.equal(u.pathname,'/Link/carHomeDetail');assert.equal(u.searchParams.get('vkey'),row.vkey);assert.equal(u.searchParams.get('gpsType'),'0');return response(detail());});
 assert.deepEqual(value,{motion_state:'stationary',stationary_time:'136.4天'});
 assert.deepEqual(await readStationary({},row,async()=>response(detail({isConn:0}))),{motion_state:'offline',stationary_time:'136.4天'});
 assert.deepEqual(await readStationary({},row,async()=>response(detail({speed:2}))),{motion_state:'moving',stationary_time:null});
});
test('wrong device, missing stationary duration, unknown structure and authentication cannot be fresh success',async()=>{
 for(const change of [{vkey:'wrong'},{carNum:'AD2'},{speed:-1},{isConn:2},{stopTime:'<script>'},{stopTime:4}])await assert.rejects(readStationary({},row,async()=>response(detail(change))),/schema_changed/);
 await assert.rejects(readStationary({},row,async()=>response(detail({stopTime:null}))),/incomplete_pages/);
 await assert.rejects(readStationary({},row,async()=>new Response('',{status:401})),/auth_required/);
 await assert.rejects(readStationary({},row,async()=>{throw Error('network');}),/fetch_failed/);
});
test('daily snapshot combines full seven device identities; one failed detail rejects the atomic collection',async()=>{
 const rows=Object.keys(VOLTAGE_BOATS).map((carNum,i)=>({vkey:'key'+i,carNum,vol:13.2,onlineStatus:1,ups:1,connTime:'2026-09-12 18:00:00'}));
 let reads=0;
 const fetcher=async u=>{
  if(u.pathname==='/Device/voltageStatisticsReport'){const results=u.searchParams.has('status')?[]:rows;return response({errorCode:0,endMark:1,resultCount:results.length,extraInfo:{page:1,countTotal:results.length},results});}
  const d=rows.find(d=>d.vkey===u.searchParams.get('vkey'));assert.ok(d);reads++;
  return response(detail({...d,isConn:d.carNum==='AC1'?0:1}));
 };
 const devices=await collectVoltage(async()=>({}),fetcher);assert.equal(reads,7);assert.equal(devices.length,7);
 assert.equal(devices.find(d=>d.code==='AC1').motion_state,'offline');assert.ok(devices.every(d=>!('vkey' in d)));
 await assert.rejects(collectVoltage(async()=>({}),u=>u.searchParams.get('vkey')==='key3'?Promise.resolve(new Response('',{status:503})):fetcher(u)),/fetch_failed/);
 const now=Date.now(),snap={version:1,checked_at:new Date(now).toISOString(),next_run_at:nextVoltageRun(now),outcome:'success',devices};
 const stored=mergeVoltage(null,normalizeVoltage(snap,now));
 const failed=mergeVoltage(stored,{outcome:'failure',error_code:'fetch_failed',checked_at:new Date(now+1000).toISOString(),next_run_at:snap.next_run_at});
 assert.deepEqual(failed.devices,stored.devices);
 for(const change of [{motion_state:'bad'},{motion_state:'moving',stationary_time:'2天'},{stationary_time:null}]){const bad=structuredClone(snap);Object.assign(bad.devices[0],change);assert.throws(()=>normalizeVoltage(bad,now));}
});

test('either endpoint reporting offline keeps voltage and stationary values historical',()=>{
 const rows=Object.keys(VOLTAGE_BOATS).map((carNum,i)=>({vkey:'key'+i,carNum,vol:13.2,onlineStatus:1,ups:1,connTime:'2026-09-12 18:00:00'}));
 const movement=new Map(rows.map(d=>[d.vkey,{motion_state:'stationary',stationary_time:'2天'}]));
 movement.set(rows[0].vkey,{motion_state:'offline',stationary_time:'3天'});
 rows[1].onlineStatus=0;
 const devices=projectReadings(rows,[],movement);
 for(const index of [0,1]){assert.equal(devices[index].online,false);assert.equal(devices[index].motion_state,'offline');}
 assert.equal(devices[0].stationary_time,'3天');assert.equal(devices[1].stationary_time,'2天');
 assert.equal(devices[2].online,true);assert.equal(devices[2].motion_state,'stationary');
 const now=Date.now(),snap={version:1,checked_at:new Date(now).toISOString(),next_run_at:nextVoltageRun(now),outcome:'success',devices};
 // An older phone can still upload the old contradictory shape. The cloud must
 // protect the dashboard before that phone has installed the collector fix.
 snap.devices[0].online=true;snap.devices[1].motion_state='stationary';
 const normalized=normalizeVoltage(snap,now);
 for(const index of [0,1]){assert.equal(normalized.devices[index].online,false);assert.equal(normalized.devices[index].motion_state,'offline');}
});

test('both app endpoints stop oversized bodies and classify interrupted bodies as network failures',async()=>{
 const readers=[fetcher=>readStationary({},row,fetcher),fetcher=>reportPages({},undefined,fetcher)];
 for(const read of readers){
  let cancelled=false;
  await assert.rejects(read(async()=>new Response(new ReadableStream({
   start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},
   cancel(){cancelled=true;}
  }))),/schema_changed/);
  assert.equal(cancelled,true,'the response stream is cancelled immediately at the byte limit');
  await assert.rejects(read(async()=>new Response(new ReadableStream({
   pull(controller){controller.error(new DOMException('Connection interrupted','AbortError'));}
  }))),/fetch_failed/);
  for(const invalid of [null,[],1,'login'])await assert.rejects(read(async()=>response(invalid)),/schema_changed/);
 }
});

test('collector rejects a fleet exceeding the cloud capacity before detail fan-out, without truncating it',async()=>{
 const rows=Object.keys(VOLTAGE_BOATS).map((carNum,i)=>({vkey:'key'+i,carNum,vol:13.2,onlineStatus:1,ups:1,connTime:'2026-09-12 18:00:00'}));
 for(let i=rows.length;i<101;i++)rows.push({...rows[0],vkey:'key'+i,carNum:'EXTRA'+i});
 let requests=0;
 await assert.rejects(collectVoltage(async()=>({}),async u=>{
  requests++;assert.equal(u.pathname,'/Device/voltageStatisticsReport');
  return response({errorCode:0,endMark:0,resultCount:100,extraInfo:{page:1,countTotal:101},results:rows.slice(0,100)});
 }),/schema_changed/);
 assert.equal(requests,1,'no second page or per-device request can begin for an unuploadable snapshot');
 assert.throws(()=>projectReadings(rows,[]),/schema_changed/);
 assert.equal(projectReadings(rows.slice(0,100),[]).length,100);
});
