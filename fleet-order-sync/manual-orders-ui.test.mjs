import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mutateManualOrders,publicManualOrders} from './manual-orders.mjs';
import {add,boat,fixedNow} from './manual-orders-20260922/fixtures.mjs';
const require=createRequire(import.meta.url),{extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const source=fs.readFileSync(new URL('./integrated-source.mjs',import.meta.url),'utf8'),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
class TestDate extends Date{constructor(...a){super(...(a.length?a:[fixedNow]));}static now(){return fixedNow;}}
function page(extra={}){
 const nodes=new Map(),document={hidden:false,addEventListener(){},querySelectorAll(){return [];},getElementById(id){if(['manual-order-form','fleet-hold-boat'].includes(id))return null;if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,addEventListener(){}});return nodes.get(id);}};
 const context=vm.createContext({document,window:{addEventListener(){}},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},Date:TestDate,URL,console,setTimeout(){},clearTimeout(){},AbortController,crypto,...extra});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),context);context.testBoat={name:'Tidewyn Discovery 2 (Seacat 40)',boataround_slug:boat,bookings:[]};vm.runInContext('DATA={boats:[testBoat]};',context);
 return {context,nodes,document,install(change){context.input=publicManualOrders(change.state,change.holds,fixedNow);vm.runInContext('applyManualOrders(input)',context);},boats(){context.renderBoats();return document.getElementById('boats').innerHTML;}};
}
test('final built page compiles and dashboard CSP matches actual script and styles',()=>{new vm.Script(script);const csp=source.match(/"dashboard":\s*"([^"\n]+)"/)[1];for(const text of [script,html.match(/<style>([\s\S]*?)<\/style>/)[1]])assert.ok(csp.includes('sha256-'+createHash('sha256').update(text).digest('base64')));assert.equal((html.match(/id="manual-order-panel"/g)||[]).length,1);});
test('manual order is rendered under its boat, escapes user text and has no fake platform link',()=>{const f=page(),p=add(0,{name:'<img src=x onerror=alert(1)>',channel:'WhatsApp <script>'}),c=mutateManualOrders(undefined,undefined,undefined,p,fixedNow);f.install(c);const content=f.boats();assert.match(content,/&lt;img/);assert.doesNotMatch(content,/<img|<script|详情链接待核实|金额待补充/);assert.match(content,/手动订单 · WhatsApp &lt;script&gt;/);assert.match(content,/已收定金/);assert.match(content,/取消订单/);assert.equal(f.context.knownOrders(f.context.testBoat).length,1);assert.equal(f.context.fleetHoldRecords().length,1);assert.equal(f.context.standaloneFleetHolds().length,0);});
test('manual calendar includes final day once and labels it as an order, not a duplicate manual lock',()=>{const f=page(),c=mutateManualOrders(undefined,undefined,undefined,add(),fixedNow);f.install(c);const cal=f.context.calendar(f.context.testBoat,new Date(2027,2,1));assert.match(cal,/aria-label="2027-03-13 不可预订"/);assert.match(cal,/aria-label="2027-03-14 可预订"/);assert.match(cal,/>预订<\/span>/);assert.doesNotMatch(cal,/>手动<\/span>/);});
test('one-day overlaps stay calendar-only; two-day overlap is flagged with customer names',()=>{const f=page(),p=add(0,{end:'2027-03-07'}),a=mutateManualOrders(undefined,undefined,undefined,p,fixedNow),b=mutateManualOrders(a.state,a.holds,undefined,add(1,{name:'Second',start:'2027-03-07',end:'2027-03-07'}),fixedNow);f.install(b);assert.equal(f.context.boatBookingConflicts(f.context.testBoat).pairs.length,1);assert.equal(f.context.dashboardBookingConflicts(f.context.testBoat).pairs.length,0);const c=mutateManualOrders(b.state,b.holds,undefined,add(2,{name:'Third',start:'2027-03-06',end:'2027-03-07'}),fixedNow);f.install(c);assert.equal(f.context.dashboardBookingConflicts(f.context.testBoat).pairs.length,1);assert.match(f.boats(),/booking-conflict-badge/);assert.doesNotMatch(f.boats(),/手动订单 #/);});
test('cancel removes occupancy and active per-boat order without erasing history',()=>{const f=page(),p=add(),one=mutateManualOrders(undefined,undefined,undefined,p,fixedNow),two=mutateManualOrders(one.state,one.holds,undefined,{action:'cancel',request_id:crypto.randomUUID(),revision:1,id:p.request_id},fixedNow);f.install(one);f.install(two);assert.equal(f.context.knownOrders(f.context.testBoat).length,0);assert.equal(f.context.knownBlocks(f.context.testBoat).length,0);assert.equal(f.context.manualOrderRecords().length,1);assert.match(f.context.calendar(f.context.testBoat,new Date(2027,2,1)),/aria-label="2027-03-06 可预订"/);});
test('older reads cannot resurrect cancelled manual order or old control revisions',()=>{const f=page(),p=add(),one=mutateManualOrders(undefined,undefined,undefined,p,fixedNow),two=mutateManualOrders(one.state,one.holds,undefined,{action:'cancel',request_id:crypto.randomUUID(),revision:1,id:p.request_id},fixedNow);f.install(two);f.install(one);assert.equal(f.context.knownOrders(f.context.testBoat).length,0);assert.equal(vm.runInContext('FLEET_HOLD_CONTROL.revision',f.context),2);});
test('missing associated hold in API response is rejected, preserving prior orders',()=>{const f=page(),one=mutateManualOrders(undefined,undefined,undefined,add(),fixedNow);f.install(one);const value=publicManualOrders(one.state,one.holds,fixedNow);value.fleet_control.holds=[];assert.throws(()=>f.context.applyManualOrders(value),/manual_order_read_failed/);assert.equal(f.context.knownOrders(f.context.testBoat).length,1);});
test('retry after another client cancels does not advertise a new active order or erase a newer form draft',async()=>{
 const f=page(),p=add(),one=mutateManualOrders(undefined,undefined,undefined,p,fixedNow),two=mutateManualOrders(one.state,one.holds,undefined,{action:'cancel',request_id:crypto.randomUUID(),revision:1,id:p.request_id},fixedNow);
 let resets=0;const form={elements:Object.fromEntries(['boat','name','channel','start','end','payment_status'].map(k=>[k,{value:k==='name'?'New unsaved guest':p[k]}])),reset(){resets++;}},get=f.document.getElementById;
 f.document.getElementById=id=>id==='manual-order-form'?form:get(id);
 f.context.renderManualOrders=()=>{};f.context.renderBoats=()=>{};f.context.readReversePreview=async()=>{};
 f.context.pending=p;vm.runInContext('MANUAL_ORDER_PENDING=pending;',f.context);
 f.context.dashboardRequest=async()=>({response:{status:202},data:{...publicManualOrders(two.state,two.holds,fixedNow),status:'saved_pending_sync',idempotent:true}});
 await f.context.sendManualOrderPending();
 assert.equal(vm.runInContext('MANUAL_ORDER_PENDING',f.context),null);assert.equal(vm.runInContext('MANUAL_ORDER_JUMP',f.context),null);
 assert.match(vm.runInContext('MANUAL_ORDER_MESSAGE',f.context),/随后已取消/);assert.equal(resets,0);assert.equal(f.context.knownOrders(f.context.testBoat).length,0);
});
