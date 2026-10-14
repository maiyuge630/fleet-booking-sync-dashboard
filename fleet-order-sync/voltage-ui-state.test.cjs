'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const {patchPhoneAgent}=require('./phone-agent-patch.cjs');
const {patchBookingConflicts}=require('./booking-conflicts-patch.cjs');
const {patchManualReschedule}=require('./manual-reschedule-patch.cjs');
const {patchVoltage}=require('./voltage-patch.cjs');
const before=patchManualReschedule(patchBookingConflicts(patchPhoneAgent(fs.readFileSync(path.join(__dirname,'phone-agent-build/baseline-integrated-source.mjs'),'utf8'))));
const source=patchVoltage(before),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];

// This DOM model accounts for the actual failure: assigning innerHTML replaces
// every details element and discards focus. New open state is read from the
// emitted HTML, rather than retaining the previous element behind the scenes.
function fixture(){
 const nodes=new Map();let voltage=[],bookings=[];
 const document={hidden:false,activeElement:null,getElementById(id){
  if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',hidden:false,disabled:false,value:'',addEventListener(){}});
  return nodes.get(id);
 },querySelectorAll(selector){return selector==='#boats details.boat-voltage'?voltage:selector==='#boats details.boat-bookings[open]'?bookings.filter(node=>node.open):[];},addEventListener(){}};
 const container=document.getElementById('boats');let rendered='';
 Object.defineProperty(container,'innerHTML',{get(){return rendered;},set(value){
  if(voltage.some(node=>node.summary===document.activeElement))document.activeElement=null;
  rendered=value;voltage=[];bookings=[];
  for(const match of value.matchAll(/<details class="([^"]+)" data-boat-key="([^"]+)"([^>]*)>/g)){
   const node={dataset:{boatKey:match[2]},open:/\bopen\b/.test(match[3])};
   node.summary={focus(options){node.focusOptions=options;document.activeElement=this;}};node.querySelector=selector=>selector==='summary'?node.summary:null;
   (match[1].startsWith('boat-voltage')?voltage:bookings).push(node);
  }
 }});
 const context=vm.createContext({document,window:{addEventListener(){}},URL,console,AbortController,setTimeout(){},clearTimeout(){}});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),context);
 const boats=['test-a','test-b'].map((slug,index)=>({name:'Boat '+index,boataround_slug:slug,bookings:[]}));
 context.fixtureData={boats,order_sync:{voltage:{last_success_at:new Date().toISOString(),devices:boats.map((boat,index)=>({boat:boat.boataround_slug,code:'AD'+index,volts:13.2,online:true,power:'normal',low_voltage:false,source_time:'2026-09-12 12:00:00'}))}}};
 vm.runInContext('DATA=fixtureData;',context);context.renderBoats();
 return {context,document,voltage:()=>voltage,bookings:()=>bookings,render:()=>context.renderBoats(),data:context.fixtureData,markup:()=>rendered};
}

test('periodic boat rerender preserves voltage expansion and focused summary without scrolling, alongside existing order expansion',()=>{
 const f=fixture();f.voltage()[0].open=true;f.bookings()[1].open=true;f.document.activeElement=f.voltage()[0].summary;
 const old=f.voltage()[0];f.data.order_sync.voltage.devices[0].volts=13.4;f.render();
 assert.notEqual(f.voltage()[0],old);assert.equal(f.voltage()[0].open,true);assert.equal(f.voltage()[1].open,false);
 assert.equal(f.bookings()[1].open,true);assert.equal(f.bookings()[0].open,false);
 assert.equal(f.document.activeElement,f.voltage()[0].summary);assert.equal(f.voltage()[0].focusOptions.preventScroll,true);assert.match(f.markup(),/13\.40 V/);
 f.render();assert.equal(f.voltage()[0].open,true);assert.equal(f.document.activeElement,f.voltage()[0].summary);
});

test('closed focused voltage stays closed; a query-field focus is never stolen',()=>{
 const f=fixture();f.document.activeElement=f.voltage()[1].summary;f.render();
 assert.equal(f.voltage()[1].open,false);assert.equal(f.document.activeElement,f.voltage()[1].summary);
 const query=f.document.getElementById('d1');f.document.activeElement=query;f.voltage()[0].open=true;f.render();
 assert.equal(f.document.activeElement,query);assert.equal(f.voltage()[0].open,true);assert.ok(f.voltage().every(node=>!node.focusOptions));
});

test('expansion follows the boat identity through reordering and a removed telemetry widget does not focus a different boat',()=>{
 const f=fixture();f.voltage()[0].open=true;f.document.activeElement=f.voltage()[0].summary;f.data.boats.reverse();f.render();
 assert.equal(f.voltage()[1].dataset.boatKey,'test-a');assert.equal(f.voltage()[1].open,true);assert.equal(f.document.activeElement,f.voltage()[1].summary);
 f.data.order_sync.voltage.devices=f.data.order_sync.voltage.devices.filter(device=>device.boat!=='test-a');f.render();
 assert.equal(f.voltage().length,1);assert.equal(f.document.activeElement,null);assert.equal(f.voltage()[0].open,false);assert.equal(f.voltage()[0].focusOptions,undefined);
});

test('patch is scoped to dashboard and CSP, and rejects repeated application',()=>{
 const mask=value=>{const start=value.indexOf('var HTML = '),end=value.indexOf('var LOGIN_HTML = ',start);return (value.slice(0,start)+'DASHBOARD\n'+value.slice(end)).replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/,'$1SCRIPT$2STYLE$3');};
 assert.equal(mask(source),mask(before));new vm.Script(script);
 const csp=source.match(/"dashboard":\s*"([^"\n]+)"/)[1],style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 for(const value of [script,style])assert.ok(csp.includes(createHash('sha256').update(value).digest('base64')));
 assert.throws(()=>patchVoltage(source),/already applied/);
});

test('stationary time is shown as a sampled duration; offline, moving and legacy data remain distinct',()=>{
 const f=fixture(),d=f.data.order_sync.voltage.devices[0];
 Object.assign(d,{motion_state:'stationary',stationary_time:'136.4天'});f.render();assert.match(f.markup(),/静止 136\.4天/);assert.match(f.markup(),/静止时间：136\.4天（采集时）/);
 Object.assign(d,{motion_state:'offline',online:false});f.render();assert.match(f.markup(),/136\.4天（平台记录；设备离线，非当前状态）/);
 Object.assign(d,{motion_state:'moving',online:true,stationary_time:null});f.render();assert.match(f.markup(),/行驶中，无当前静止时长/);assert.doesNotMatch(f.markup(),/136\.4天/);
 delete d.motion_state;delete d.stationary_time;f.render();assert.match(f.markup(),/静止时间：尚未取得/);
});

test('a disagreement between voltage and movement online states never presents a current healthy reading',()=>{
 const f=fixture(),d=f.data.order_sync.voltage.devices[0],boat=f.data.boats[0];
 for(const change of [{online:true,motion_state:'offline'},{online:false,motion_state:'stationary'},{online:false,motion_state:'moving'}]){
  Object.assign(d,{stationary_time:'136.4天'},change);
  const markup=f.context.boatVoltage(boat);
  assert.match(markup,/voltage-warning/);assert.match(markup,/历史 · 设备离线/);assert.match(markup,/设备离线，无法确认当前电压/);
  assert.match(markup,/静止时间 · 离线/);assert.match(markup,/136\.4天（平台记录；设备离线，非当前状态）/);
  assert.doesNotMatch(markup,/电源正常|行驶中|静止时间：136\.4天（采集时）/);
 }
});
