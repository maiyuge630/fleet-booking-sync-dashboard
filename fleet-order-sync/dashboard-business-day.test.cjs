'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
// Build the dashboard patch chain from source, without overwriting build output
// while other audit tasks inspect it. The full integration suite also compares
// this chain with the final generated Worker.
const source=[
 require('./booking-conflicts-patch.cjs').patchBookingConflicts,
 require('./manual-reschedule-patch.cjs').patchManualReschedule,
 require('./voltage-patch.cjs').patchVoltage,
 require('./reverse-sync/frontend-patch.cjs').patchReverse,
 require('./checkout-day-patch.cjs').patchCheckoutDay,
 require('./manual-unavailability-patch.cjs').patchManualUnavailability,
 require('./order-query-freshness-patch.cjs').patchOrderQueryFreshness
].reduce((s,p)=>p(s),fs.readFileSync(__dirname+'/phone-agent-build/baseline-integrated-source.mjs','utf8'));
const script=extractHTML(source).match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\binitialize\(\);\s*$/,'');
function view(tz,now,checkout){
 const fixture=String.raw`
const vm=require('node:vm');let now=Date.parse(NOW);class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
const nodes=new Map(),document={addEventListener(){},querySelectorAll(){return [];},getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',value:'',addEventListener(){}});return nodes.get(id);}};
const c=vm.createContext({Date:Clock,document,window:{addEventListener(){}},URL,console});vm.runInContext(SCRIPT,c);
const b={boataround_slug:'test',bookings:[{source:'samboat',booking_id:'1',status:'paid',start:'2026-09-19',end:CHECKOUT},{source:'boataround',booking_id:'2',status:'paid',start:'2026-09-19',end:CHECKOUT}]};
const read=()=>({today:c.beijingToday(),visible:c.knownOrders(b).length,conflicts:c.dashboardBookingConflicts(b).pairs.length});
const before=read();c.renderBoats=()=>{};c.loadData=()=>{};c.initialize();
const calendar=c.calendar(b,new Clock(CHECKOUT+'T12:00:00'));const todayLabel=calendar.match(/aria-label="([0-9-]+) [^"]* 今天"/);
const result={before,query:[document.getElementById('d1').value,document.getElementById('d2').value],month:vm.runInContext('fmt(months[0])',c),highlight:todayLabel?.[1]};
now+=86400000;result.after=read();console.log(JSON.stringify(result));
`.replaceAll('NOW',JSON.stringify(now)).replaceAll('CHECKOUT',JSON.stringify(checkout)).replace('SCRIPT',JSON.stringify(script));
 const result=spawnSync(process.execPath,[],{input:fixture,env:{...process.env,TZ:tz},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
for(const tz of ['Asia/Shanghai','Pacific/Kiritimati','America/Los_Angeles'])test(tz+' keeps checkout orders and conflict until Beijing midnight',()=>{
 const value=view(tz,'2026-09-20T11:00:00Z','2026-09-20');
 assert.deepEqual(value.before,{today:'2026-09-20',visible:2,conflicts:1});
 assert.equal(value.highlight,'2026-09-20');assert.deepEqual(value.query,['2026-09-20','2026-09-21']);
 assert.deepEqual(value.after,{today:'2026-09-21',visible:0,conflicts:0});
});
for(const tz of ['America/Los_Angeles','Pacific/Kiritimati'])test(tz+' uses Beijing month and query date at month/year boundaries',()=>{
 const october=view(tz,'2026-09-30T17:00:00Z','2026-10-01');
 assert.equal(october.month,'2026-10-01');assert.deepEqual(october.query,['2026-10-01','2026-10-02']);assert.equal(october.highlight,'2026-10-01');
 const year=view(tz,'2026-12-31T11:00:00Z','2026-12-31');
 assert.equal(year.month,'2026-12-01');assert.deepEqual(year.query,['2026-12-31','2027-01-01']);assert.equal(year.highlight,'2026-12-31');
});
