'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const {QUERY_DATA_MAX_AGE_MS}=require('./order-query-freshness-patch.cjs');
const source=fs.readFileSync(__dirname+'/integrated-source.mjs','utf8'),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const START=Date.parse('2026-09-19T04:00:00Z'),SOURCES=['boataround','clickandboat','samboat','mmk','nausys'];
const boat={name:'Tidewyn Dream',boataround_slug:'wavecat-34-open-tidewyn-dream',bookings:[],sources:{}};
function snapshot(at=START){return {schema_version:2,boats:[structuredClone(boat)],order_sync:{agent:{paired:true},platforms:Object.fromEntries(SOURCES.map(source=>[source,{mode:'dynamic',last_error:null,last_success_at:new Date(at).toISOString()}]))}};}
function page(data=snapshot()){
 let now=START;const nodes=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(){}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const ctx=vm.createContext({document,window:{addEventListener(){}},URL,Date:Clock,setTimeout(){},clearTimeout(){},AbortController,console});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),ctx);ctx.fixture=data;
 vm.runInContext('DATA=fixture;',ctx);
 document.getElementById('d1').value='2026-12-01';document.getElementById('d2').value='2026-12-02';
 return {ctx,document,at:value=>{now=value;},query(){ctx.window.checkAvail();return document.getElementById('result').innerHTML;}};
}

test('query warning uses the established three-hour plus fifteen-minute grace window',async()=>{
 const {RECEIPT_MAX_AGE_MS}=await import('./reverse-sync/store.mjs');assert.equal(QUERY_DATA_MAX_AGE_MS,RECEIPT_MAX_AGE_MS);
 const f=page();f.at(START+QUERY_DATA_MAX_AGE_MS);assert.doesNotMatch(f.query(),/query-data-warning|数据待更新/);
 f.at(START+QUERY_DATA_MAX_AGE_MS+1);const out=f.query();assert.match(out,/数据已过期/);assert.match(out,/数据待更新，请同步后确认/);
 for(const name of ['Boataround','Click&amp;Boat','SamBoat','MMK','NauSYS'])assert.ok(out.includes(name),name);
 assert.match(out,/2026-09-19 12:00:00（北京时间）/);
});

test('a failed source stays visibly uncertain despite a recent successful timestamp',()=>{
 const data=snapshot();data.order_sync.platforms.samboat.last_error='auth_required';const f=page(data),before=JSON.stringify(data),out=f.query();
 assert.match(out,/SamBoat：最近同步失败/);assert.doesNotMatch(out,/Boataround：最近同步失败/);
 assert.match(out,/class="badge free">可预订/);assert.match(out,/当前“可预订”仅依据已保存订单/);
 assert.equal(JSON.stringify(data),before,'presentation must not alter stored orders or status');
});

test('missing, invalid, future and bootstrap source times cannot look fresh',()=>{
 for(const value of [undefined,null,'','invalid',START,Infinity]){
  const data=snapshot();data.order_sync.platforms.boataround.last_success_at=value;
  const out=page(data).query();assert.match(out,/Boataround：尚无成功同步记录/,String(value));
 }
 for(const [change,reason] of [[{last_success_at:new Date(START+60001).toISOString()},'同步时间异常'],[{mode:'bootstrap'},'尚未完成全量订单核验']]){
  const data=snapshot();Object.assign(data.order_sync.platforms.boataround,change);assert.match(page(data).query(),new RegExp('Boataround：'+reason));
 }
 const data=snapshot();delete data.order_sync.platforms.samboat;assert.match(page(data).query(),/SamBoat：尚无成功同步记录/);
});

test('stale data does not erase a real occupied date or AC2 manual stop',()=>{
 const data=snapshot(START-86400000);data.boats[0].bookings=[{source:'samboat',booking_id:'12345',status:'paid',start:'2026-12-01',end:'2026-12-02'}];
 data.boats.push({name:'AC2',boataround_slug:'coastline-sea-journey-42-tidewyn-cruise-2',bookings:[],sources:{}});
 const out=page(data).query();assert.match(out,/0\/2 艘可预订 · 2 艘不可预订/);assert.match(out,/手动停用/);assert.match(out,/#12345/);
 assert.doesNotMatch(out,/当前“可预订”仅依据已保存订单/);assert.match(out,/档期数据待更新/);
});

test('fresh successful snapshots remove prior warnings without reloading the page',()=>{
 const f=page(snapshot(START-86400000));assert.match(f.query(),/数据已过期/);
 f.ctx.fixture=snapshot();vm.runInContext('DATA=fixture;',f.ctx);
 const out=f.query();assert.doesNotMatch(out,/query-data-warning|数据待更新|数据已过期/);assert.match(out,/1\/1 艘可预订/);
});

test('a failed refresh reevaluates an already-open query when saved data expires',async()=>{
 const f=page();assert.doesNotMatch(f.query(),/数据待更新/);f.at(START+QUERY_DATA_MAX_AGE_MS+1);
 f.ctx.dashboardRequest=async()=>{throw Error('Synthetic offline refresh');};
 await f.ctx.loadData(false);assert.match(f.document.getElementById('result').innerHTML,/数据已过期/);
});

test('query warnings use escaped platform labels and dashboard CSP matches built script and styles',()=>{
 const f=page(snapshot(START-86400000));const out=f.query();assert.match(out,/Click&amp;Boat/);
 const style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 assert.ok(source.includes(createHash('sha256').update(script).digest('base64')));
 assert.ok(source.includes(createHash('sha256').update(style).digest('base64')));
});
