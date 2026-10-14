import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {normalizeVoltage,mergeVoltage,VOLTAGE_BOATS,VOLTAGE_KEY,currentVoltageBoats} from './voltage-data.mjs';
import {nextVoltageRun,readAppAuthorization,reportPages,projectReadings,VoltageService} from './phone-server/voltage.mjs';
import {FleetPhoneAgent,PHONE_AGENT_KEY} from './phone-agent.mjs';
const require=createRequire(import.meta.url),{extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const now=Date.parse('2026-09-12T09:30:00.000Z');
const rows=()=>Object.keys(VOLTAGE_BOATS).map((code,i)=>({vkey:'fixture'+i,carNum:code,vol:code==='AC1'?0:13.1,onlineStatus:code==='AC1'?0:1,ups:code==='AC1'?0:1,connTime:code==='AC1'?'2026-06-10 00:24:11':'2026-09-12 17:29:00'}));
const snapshot=()=>({version:1,checked_at:new Date(now).toISOString(),next_run_at:nextVoltageRun(now),outcome:'success',devices:projectReadings(rows(),rows().filter(d=>d.carNum==='AC1'))});
test('daily plan is 09:00 Beijing across midnight and month boundaries',()=>{
 assert.equal(nextVoltageRun(now),'2026-09-13T01:00:00.000Z');
 assert.equal(nextVoltageRun(Date.parse('2026-09-12T00:59:59Z')),'2026-09-12T01:00:00.000Z');
 assert.equal(nextVoltageRun(Date.parse('2026-12-31T01:00:00Z')),'2027-01-01T01:00:00.000Z');
});
test('application auth parser decodes XML but rejects empty or multiline headers',()=>{
 const valid='<map><string name="authorization">fixture&amp;value</string><string name="company_key">company</string></map>';
 assert.equal(readAppAuthorization(valid).Authorization,'fixture&value');assert.throws(()=>readAppAuthorization('<map/>'),/auth_required/);
 assert.throws(()=>readAppAuthorization(valid.replace('fixture&amp;value','a&#10;b')),/auth_required/);
});
const response=(items,extra={})=>new Response(JSON.stringify({errorCode:0,resultCount:items.length,endMark:1,extraInfo:{page:1,countTotal:items.length},results:items,...extra}));
test('report reads only verified endpoint and requires pagination accounting',async()=>{
 let requested;assert.equal((await reportPages({},undefined,async u=>{requested=u;return response(rows());})).length,7);
 assert.equal(requested.hostname,'api.azlmap.com');assert.equal(requested.pathname,'/Device/voltageStatisticsReport');assert.equal(requested.searchParams.has('status'),false);
 await reportPages({},4,async u=>{assert.equal(u.searchParams.get('status'),'4');return response([]);});
 await assert.rejects(reportPages({},undefined,async()=>response(rows(),{extraInfo:{page:1,countTotal:8}})),/incomplete_pages/);
 await assert.rejects(reportPages({},undefined,async()=>response([rows()[0],rows()[0]])),/incomplete_pages/);
 await assert.rejects(reportPages({},undefined,async()=>new Response('login',{status:401})),/auth_required/);
 await assert.rejects(reportPages({},undefined,async()=>new Response('<html>')),/schema_changed/);
 await assert.rejects(reportPages({},undefined,async()=>response(rows(),{errorCode:1})),/auth_required/);
});
test('two pages combine without omissions; changing totals fail closed',async()=>{
 let page=0;const value=await reportPages({},undefined,async()=>{page++;return response(page===1?rows().slice(0,4):rows().slice(4),{endMark:page===1?0:1,extraInfo:{page,countTotal:7}});});assert.equal(value.length,7);
 page=0;await assert.rejects(reportPages({},undefined,async()=>{page++;return response(rows().slice(0,2),{endMark:0,extraInfo:{page,countTotal:page===1?7:8}});}),/incomplete_pages/);
});
test('collects all seven and low status directly from platform; strips locations and identifiers',()=>{
 const input=rows();input[0].lat=42;input[0].secret='private';const devices=projectReadings(input,[input[0]]);
 assert.equal(devices[0].low_voltage,true);assert.equal(devices[1].low_voltage,false);
 assert.equal(devices[0].lat,undefined);assert.equal(devices[0].vkey,undefined);
 assert.throws(()=>projectReadings(input.slice(1),[]),/incomplete_pages/);
 assert.throws(()=>projectReadings(input,[{vkey:'different'}]),/incomplete_pages/);
 input[0].vol='13';assert.throws(()=>projectReadings(input,[]),/schema_changed/);
});
test('server validates readings, fixed boat mapping, timestamps and untrusted extra fields',()=>{
 const input=snapshot();input.devices[0].boat='fake';input.devices[0].authorization='private';const clean=normalizeVoltage(input,now);
 assert.equal(clean.devices[0].boat,VOLTAGE_BOATS.ADD);assert.equal(clean.devices[0].authorization,undefined);
 // AD6 is Lightcat 400 S2's device (owner, 2026-10-10); AD3 has none.
 assert.equal(clean.devices.find(d=>d.code==='AD6').boat,'lightcat-400-s2-tidewyn-discovery-6');
 assert.ok(!Object.values(VOLTAGE_BOATS).includes('bluecat-42-tidewyn-discovery-3'));
 for(const mutate of [s=>s.devices[0].volts=Infinity,s=>s.devices[0].volts='13',s=>s.devices[0].online='true',s=>s.devices[0].source_time='bad',s=>s.devices.push(s.devices[0]),s=>s.checked_at='2099-01-01T00:00:00.000Z']){const s=snapshot();mutate(s);assert.throws(()=>normalizeVoltage(s,now));}
});
test('failure preserves old readings and freshness; replay cannot replace newer telemetry',()=>{
 const first=mergeVoltage(null,normalizeVoltage(snapshot(),now));const later={version:1,checked_at:new Date(now+1000).toISOString(),next_run_at:nextVoltageRun(now),outcome:'failure',error_code:'fetch_failed'};
 const failed=mergeVoltage(first,normalizeVoltage(later,now+1000));assert.deepEqual(failed.devices,first.devices);assert.equal(failed.last_success_at,first.last_success_at);assert.equal(failed.error_code,'fetch_failed');assert.equal(mergeVoltage(failed,normalizeVoltage(snapshot(),now)),failed);
});
test('cloud requires every configured boat in a successful voltage snapshot',()=>{
 for(const code of Object.keys(VOLTAGE_BOATS)){
  const partial=snapshot();partial.devices=partial.devices.filter(device=>device.code!==code);
  assert.throws(()=>normalizeVoltage(partial,now),{message:'invalid_voltage_snapshot',status:400},code);
 }
 const renamed=snapshot();renamed.devices[0].code='UNKNOWN';
 assert.throws(()=>normalizeVoltage(renamed,now),{message:'invalid_voltage_snapshot',status:400});
 // Additional platform devices may coexist without changing the fixed mapping.
 const extra=snapshot();extra.devices.push({...extra.devices[0],code:'EXTRA'});
 assert.equal(normalizeVoltage(extra,now).devices.at(-1).boat,null);
});
test('a truncated authenticated voltage upload cannot replace seven stored readings',async()=>{
 const token='a'.repeat(43),m=new Map([[PHONE_AGENT_KEY,{token_hash:createHash('sha256').update(token).digest('hex')}]]);
 const storage={async get(k){return structuredClone(m.get(k));},async put(k,v){m.set(k,structuredClone(v));},async transaction(f){return f(this);}};
 const agent=new FleetPhoneAgent({storage,now:()=>now+1000,ingest:()=>{throw Error('must not touch orders');},registryStatus:async()=>({})});
 const upload=input=>agent.machine(new Request('https://example.test/api/agent/voltage',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)}));
 assert.equal((await upload(snapshot())).status,200);
 const previous=structuredClone(m.get(VOLTAGE_KEY));
 const partial=snapshot();partial.checked_at=new Date(now+1000).toISOString();partial.devices=partial.devices.slice(0,1);
 const rejected=await upload(partial);
 assert.equal(rejected.status,400);assert.deepEqual(await rejected.json(),{error:'invalid_voltage_snapshot'});
 assert.deepEqual(m.get(VOLTAGE_KEY),previous);assert.equal(m.size,2);
 // A subsequent explicit failure still reports the problem without erasing data.
 const failed={version:1,outcome:'failure',checked_at:partial.checked_at,next_run_at:partial.next_run_at,error_code:'incomplete_pages'};
 assert.equal((await upload(failed)).status,200);
 assert.deepEqual(m.get(VOLTAGE_KEY).devices,previous.devices);
 assert.equal(m.get(VOLTAGE_KEY).last_success_at,previous.last_success_at);
 assert.equal(m.get(VOLTAGE_KEY).error_code,'incomplete_pages');
});
test('machine route requires paired credential; only telemetry storage changes',async()=>{
 const token='a'.repeat(43),m=new Map([[PHONE_AGENT_KEY,{token_hash:createHash('sha256').update(token).digest('hex')}]]);
 const storage={async get(k){return structuredClone(m.get(k));},async put(k,v){m.set(k,structuredClone(v));},async transaction(f){return f(this);}};
 const agent=new FleetPhoneAgent({storage,now:()=>now,ingest:()=>{throw Error('must not touch orders');},registryStatus:async()=>({})});
 const req=t=>new Request('https://example.test/api/agent/voltage',{method:'POST',headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify(snapshot())});
 assert.equal((await agent.machine(req('b'.repeat(43)))).status,401);assert.equal(m.has(VOLTAGE_KEY),false);
 assert.equal((await agent.machine(req(token))).status,200);assert.equal(m.get(VOLTAGE_KEY).devices.length,7);assert.equal(m.size,2);
});
async function service(t,remote,collect){const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-voltage-test-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));return new VoltageService({home,remote,collect,now:()=>now}).init();}
test('upload failure survives process restart without collecting again',async t=>{
 let collects=0;const s=await service(t,{request:async()=>{throw Error();}},async()=>{collects++;return snapshot().devices;});await s.tick();assert.equal(collects,1);
 const persisted=JSON.parse(await fs.readFile(s.file));assert.ok(persisted.pending);
 let uploads=0;const resumed=await new VoltageService({home:s.home,now:()=>now+60001,collect:async()=>{throw Error('unexpected collection');},remote:{request:async(route,payload)=>{assert.equal(route,'voltage');assert.equal(payload.devices.length,7);uploads++;return {ok:true};}}}).init();
 await resumed.tick();assert.equal(uploads,1);assert.equal(resumed.state.pending,null);assert.equal(resumed.state.last_success_at,new Date(now).toISOString());
});
test('failure reports error and retries in 15 minutes; concurrent ticks do not duplicate',async t=>{
 let n=0;const s=await service(t,{request:async()=>({ok:true})},async()=>{n++;throw Object.assign(Error(),{code:'auth_required'});});await Promise.all([s.tick(),s.tick()]);assert.equal(n,1);assert.equal(s.state.last_error,'auth_required');assert.equal(Date.parse(s.state.next_run_at)-now,900000);await s.tick();assert.equal(n,1);
});
test('large time rollback repairs daily deadline and future retry; small correction preserves plan',async t=>{
 const s=await service(t,{request:async()=>({ok:true})},async()=>snapshot().devices);s.state.next_run_at=new Date(now+48*3600000).toISOString();s.retryAt=now+2*86400000;await s.tick();assert.equal(s.state.next_run_at,nextVoltageRun(now));assert.equal(s.retryAt,0);
 s.state.next_run_at=new Date(now+86400000+1000).toISOString();const original=s.state.next_run_at;await s.tick();assert.equal(s.state.next_run_at,original);
});
test('website telemetry is readable, escaped, offline and stale labelled; exact CSP matches',async()=>{
 const source=await fs.readFile(new URL('./integrated-source.mjs',import.meta.url),'utf8'),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 new vm.Script(script);const csp=source.match(/"dashboard":\s*"([^"\n]+)"/)[1];for(const text of [script,style])assert.ok(csp.includes(createHash('sha256').update(text).digest('base64')));
 const start=script.indexOf('function boatVoltage('),end=script.indexOf('function renderBoats(){',start);const state=mergeVoltage(null,normalizeVoltage(snapshot(),now));
 const ctx=vm.createContext({DATA:{order_sync:{voltage:state}},Date:class extends Date{static now(){return now;}},esc:s=>String(s).replaceAll('<','&lt;'),beijingRefreshTime:s=>s});vm.runInContext(script.slice(start,end),ctx);
 assert.match(ctx.boatVoltage({boataround_slug:VOLTAGE_BOATS.AC1}),/设备离线.*历史读数/s);assert.match(ctx.boatVoltage({boataround_slug:VOLTAGE_BOATS.AD5}),/13.10 V/);
 state.error_code='auth_required';assert.match(ctx.boatVoltage({boataround_slug:VOLTAGE_BOATS.AD5}),/登录已失效/);state.error_code=null;state.last_success_at='2026-09-01T00:00:00.000Z';assert.match(ctx.boatVoltage({boataround_slug:VOLTAGE_BOATS.AD5}),/超过 36 小时/);
 state.devices[0].source_time='<img onerror=x>';assert.doesNotMatch(ctx.boatVoltage({boataround_slug:VOLTAGE_BOATS.ADD}),/<img/);
 assert.match(script,/\+'<\/div>'\+boatVoltage\(boat(?:,voltageView)?\)\+'<\/div><div class="source-tags">'/);
});
test('readings stored under the old table show on Lightcat; AD3 stays without a voltage block (2026-10-10)',async()=>{
 const old=mergeVoltage(null,normalizeVoltage(snapshot(),now));
 for(const d of old.devices)if(d.code==='AD6')d.boat='bluecat-42-tidewyn-discovery-3';
 assert.equal(currentVoltageBoats(old).devices.find(d=>d.code==='AD6').boat,'lightcat-400-s2-tidewyn-discovery-6');
 assert.equal(old.devices.find(d=>d.code==='AD6').boat,'bluecat-42-tidewyn-discovery-3');
 assert.equal(currentVoltageBoats(null),null);
 const source=await fs.readFile(new URL('./integrated-source.mjs',import.meta.url),'utf8'),script=extractHTML(source).match(/<script>([\s\S]*?)<\/script>/)[1];
 const start=script.indexOf('function boatVoltage('),end=script.indexOf('function renderBoats(){',start);
 const ctx=vm.createContext({DATA:{order_sync:{voltage:currentVoltageBoats(old)}},Date:class extends Date{static now(){return now;}},esc:s=>String(s),beijingRefreshTime:s=>s});vm.runInContext(script.slice(start,end),ctx);
 assert.match(ctx.boatVoltage({boataround_slug:'lightcat-400-s2-tidewyn-discovery-6'}),/安智连设备：AD6/);
 assert.equal(ctx.boatVoltage({boataround_slug:'bluecat-42-tidewyn-discovery-3'}),'');
});
