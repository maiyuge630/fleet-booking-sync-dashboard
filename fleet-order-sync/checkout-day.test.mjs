import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {buildPlan,uncovered} from './reverse-sync/planner.mjs';
import {FLEET} from './parsers.mjs';
const require=createRequire(import.meta.url),{extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const source=fs.readFileSync(new URL('./integrated-source.mjs',import.meta.url),'utf8'),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now=Date.parse('2027-01-08T01:00:00Z'),stamp=new Date(now).toISOString(),boat=FLEET[3].slug;
const mapping={boataround:[{booking_id:'303719',boataround_slug:boat,start:'2027-01-01',end:'2027-01-08',status:'deposit_paid',platform_status:'CONFIRMED',verified_at:stamp}],clickandboat:[],samboat:[],mmk:[],nausys:[]};
const status={platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:stamp,last_error:null}]))};
test('checkout day remains required today, original dates stay unchanged, repeat planning never adds extra days',()=>{
 const before=JSON.stringify(mapping);
 for(let n=0;n<3;n++){
  const p=buildPlan(mapping,status,{now});assert.equal(p.rule_version,2);
  const t=p.targets.find(t=>t.boat===boat&&t.target==='samboat');assert.deepEqual(t.segments,[{start:'2027-01-01',end:'2027-01-09',causes:['boataround:303719']}]);
  assert.equal(t.release_proof.orders[0].end,'2027-01-09');
  const own=p.targets.find(t=>t.boat===boat&&t.target==='boataround');assert.deepEqual(own.segments,[{start:'2027-01-08',end:'2027-01-09',causes:['boataround:303719']}]);
  assert.deepEqual(uncovered(t.segments[0],[{start:'2027-01-01',end:'2027-01-08'}]),[{start:'2027-01-08',end:'2027-01-09'}]);
 }
 assert.equal(JSON.stringify(mapping),before);assert.equal(buildPlan(mapping,status,{now:now+86400000}).causes.length,0);
});
test('checkout protection rolls over leap day and new year once',()=>{
 for(const [end,next] of [['2028-02-29','2028-03-01'],['2027-12-31','2028-01-01']]){
  const m=structuredClone(mapping);m.boataround[0].end=end;
  assert.equal(buildPlan(m,status,{now}).causes[0].end,next);
 }
});
test('authorized manual reschedule protects its whole new stay on the original platform too',()=>{
 const m={boataround:[],samboat:[],mmk:[],nausys:[],clickandboat:[{...mapping.boataround[0],booking_id:'1000000',status:'accepted',start:'2027-03-06',end:'2027-03-13',manual_adjustment:{kind:'reschedule',verification_status:'verified',payment_evidence:{kind:'owner_settlement',amount:4200}}}]};
 const p=buildPlan(m,status,{now});
 for(const target of ['boataround','clickandboat','samboat'])assert.deepEqual(p.targets.find(t=>t.boat===boat&&t.target===target).segments,[{start:'2027-03-06',end:'2027-03-14',causes:['clickandboat:1000000']}]);
});
function page(){
 const nodes=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(){}};
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const ctx=vm.createContext({document,window:{addEventListener(){}},Date:Clock,URL,setTimeout(){},clearTimeout(){},AbortController,console});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),ctx);
 ctx.fixture={name:'AD2',boataround_slug:boat,sources:{},bookings:[{...mapping.boataround[0],source:'boataround'}]};vm.runInContext('DATA={boats:[fixture]};',ctx);
 return {ctx,document};
}
test('calendar, current order list and query all include checkout while next day is free',()=>{
 const {ctx,document}=page();assert.equal(ctx.knownOrders(ctx.fixture).length,1);
 const days=ctx.dayStatus(ctx.fixture,new Date(2027,0,1));assert.equal(days.has('2027-01-08'),true);assert.equal(days.has('2027-01-09'),false);
 document.getElementById('d1').value='2027-01-08';document.getElementById('d2').value='2027-01-09';ctx.window.checkAvail();assert.match(document.getElementById('result').innerHTML,/所选日期已有 1 笔有效订单/);
 document.getElementById('d1').value='2027-01-09';document.getElementById('d2').value='2027-01-10';ctx.window.checkAvail();assert.match(document.getElementById('result').innerHTML,/2 天内没有有效订单占用/);
});
test('deployed dashboard CSP and date wording agree with inclusive rule',()=>{
 assert.ok(source.includes(createHash('sha256').update(script).digest('base64')));
 assert.match(html,/退船当天/);assert.doesNotMatch(html,/退房前一晚|退房日不计入占用|重叠夜/);
});
