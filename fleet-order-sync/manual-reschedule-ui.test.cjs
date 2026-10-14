'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const {patchPhoneAgent}=require('./phone-agent-patch.cjs');
const {patchBookingConflicts}=require('./booking-conflicts-patch.cjs');
const {patchManualReschedule}=require('./manual-reschedule-patch.cjs');
const original=patchBookingConflicts(patchPhoneAgent(fs.readFileSync(path.join(__dirname,'phone-agent-build/baseline-integrated-source.mjs'),'utf8'))),patched=patchManualReschedule(original);
const originalHTML=extractHTML(original),html=extractHTML(patched),readScript=value=>value.match(/<script>([\s\S]*?)<\/script>/)[1],readStyle=value=>value.match(/<style>([\s\S]*?)<\/style>/)[1];
const slug='seacat-open-40-tidewyn-discovery-2',url='https://www.clickandboat.com/uk/booking/1000000/detail';
const plain=value=>JSON.parse(JSON.stringify(value));
function record(extra={}){return {source:'clickandboat',booking_id:'1000000',boataround_slug:slug,start:'2027-03-06',end:'2027-03-13',status:'accepted',url,verified_at:'2026-09-10T09:00:00.000Z',amount:'€4,200.00',amount_basis:'船东净收入',manual_adjustment:{kind:'reschedule',original_start:'2026-03-14',original_end:'2026-03-21',recorded_at:'2026-09-10T09:00:00.000Z',verification_status:'verified',review_reason:null,platform_status:'ACCEPTED',platform_start:'2026-03-14',platform_end:'2026-03-21',platform_boat:slug,last_verified_at:'2026-09-10T09:00:00.000Z',cancelled_at:null,payment_evidence:{kind:'owner_settlement',amount:4200,currency:'EUR',paid_on:'2026-03-16',detail_url:url}},...extra};}
function boat(bookings=[]){return {name:'Tidewyn Discovery 2 (Seacat 40)',boataround_slug:slug,clickandboat_id:'synthetic-ad2',sources:{},bookings};}
function worker(source=patched){
 const context=vm.createContext({Date,URL,__name:value=>value});
 for(const name of ['bookingStatus','validDay','normalizeManualReschedule','normalizeBooking','applyBookingRegistry']){
  const start=source.indexOf('function '+name+'(');if(start<0)continue;const end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),context);
 }
 return context;
}
class TestDate extends Date{constructor(...args){super(...(args.length?args:['2026-09-10T12:00:00Z']));}static now(){return Date.parse('2026-09-10T12:00:00Z');}}
function page(value=html){
 const nodes=new Map(),expanded=[],document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return expanded;},addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){}},Date:TestDate,URL,console,setTimeout(){},clearTimeout(){},AbortController});
 vm.runInContext(readScript(value).replace(/\binitialize\(\);\s*$/,''),context);
 return {context,document,expanded,setBoats(boats){context.fixtureBoats=boats;vm.runInContext('DATA={boats:fixtureBoats};',context);},render(){context.renderBoats();return document.getElementById('boats').innerHTML;}};
}
function projected(value=record()){return plain(worker().normalizeBooking(value.source,value));}
const count=(value,needle)=>value.split(needle).length-1;

test('the appended patch updates exact dashboard CSP hashes, preserves login and rejects double application',()=>{
 assert.equal(patched.slice(patched.indexOf('var LOGIN_HTML = '),patched.indexOf('function normalizeManualReschedule(')).replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/,'$1SCRIPT$2STYLE$3'),original.slice(original.indexOf('var LOGIN_HTML = '),original.indexOf('function normalizeBooking(')).replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/,'$1SCRIPT$2STYLE$3')+'\n');
 const policy=patched.match(/"dashboard":\s*"([^"\n]+)"/)[1];for(const value of [readScript(html),readStyle(html)])assert.ok(policy.includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));
 assert.ok(readStyle(html).startsWith(readStyle(originalHTML)));assert.throws(()=>patchManualReschedule(patched),/without manual reschedule/);
});

test('normalization and registry preserve only the fixed authorized metadata on the original AD2 order',()=>{
 const w=worker(),r=record();r.manual_adjustment.extra='must disappear';r.manual_adjustment.payment_evidence.customer_paid_amount=99999;
 const result=w.applyBookingRegistry({boats:[boat()]},{boataround:[],clickandboat:[r],samboat:[],mmk:[],nausys:[]});
 assert.equal(result.booking_mapping_complete,true);assert.equal(result.boats[0].bookings.length,1);const actual=plain(result.boats[0].bookings[0]);
 assert.deepEqual(actual.manual_adjustment,record().manual_adjustment);assert.equal(actual.source,'clickandboat');assert.equal(actual.booking_id,'1000000');assert.equal(actual.url,url);assert.equal(actual.status,'accepted');assert.equal(actual.customer_payment_verified,undefined);assert.equal(actual.customer_paid_amount,undefined);
 const restored=w.applyBookingRegistry({boats:[boat([actual])]},{boataround:[],samboat:[]});assert.deepEqual(plain(restored.boats[0].bookings[0].manual_adjustment),record().manual_adjustment);
});

test('metadata cannot be attached to another order, boat, settlement or unapproved dates',()=>{
 const w=worker();for(const patch of [{booking_id:'999'},{start:'2027-03-05'},{end:'2027-03-14'},{url:'https://example.test/'}])assert.throws(()=>w.normalizeBooking(patch.source||'clickandboat',record(patch)),/人工改期/);
 // Reach the cross-platform authorization guard with a valid SamBoat record.
 // Accepted is intentionally not an eligible SamBoat status, so using it here
 // would only test the earlier status rejection and miss the metadata guard.
 const foreign=record({source:'samboat',status:'deposit_paid',url:'https://www.samboat.com/private/reservation/1000000'});
 const withoutAdjustment={...foreign};delete withoutAdjustment.manual_adjustment;
 assert.doesNotThrow(()=>w.normalizeBooking('samboat',withoutAdjustment));
 assert.throws(()=>w.normalizeBooking('samboat',foreign),/人工改期/);
 const mutations=[m=>m.kind='new_payment',m=>m.original_start='2026-03-13',m=>m.payment_evidence.amount=4201,m=>m.payment_evidence.currency='USD',m=>m.payment_evidence.detail_url='javascript:alert(1)',m=>m.platform_start='2027-02-30',m=>m.platform_boat='<img>',m=>m.review_reason='unknown',m=>m.recorded_at='tomorrow',m=>m.verification_status='cancelled',m=>m.cancelled_at='2026-09-10T10:00:00Z'];
 for(const mutate of mutations){const r=record();mutate(r.manual_adjustment);assert.throws(()=>w.normalizeBooking('clickandboat',r),/人工改期|已取消/);}
 const other={...boat(),boataround_slug:'another-boat',clickandboat_id:'other'};const result=w.applyBookingRegistry({boats:[other]},{boataround:[],samboat:[],mmk:[],clickandboat:[record({boataround_slug:'another-boat'})]});assert.equal(result.booking_mapping_complete,false);assert.equal(result.boats[0].bookings.length,0);assert.match(result.warning,/船只与原订单不符/);
});

test('the card stays under AD2, retains the platform link and displays the original settlement amount only once',()=>{
 const p=page(),b=boat([projected()]);p.setBoats([b]);const rendered=p.render();
 assert.equal(count(rendered,'data-booking-id="1000000"'),1);assert.match(rendered,/人工改期/);assert.match(rendered,/原航程：2026-03-14 → 2026-03-21/);assert.match(rendered,/原订单船东款已结算 · 2026-03-16/);assert.match(rendered,/本次改期沿用该笔结算款/);assert.match(rendered,/原订单已结算 · 船东净收入/);assert.equal(count(rendered,'€4,200.00'),1);assert.equal(count(rendered,'href="'+url+'"'),1);
 assert.ok(rendered.indexOf('Tidewyn Discovery 2')<rendered.indexOf('人工改期'));assert.ok(rendered.indexOf('<details class="boat-bookings"')<rendered.indexOf('人工改期'));assert.doesNotMatch(rendered,/待核对|客户已付|新增收款/);
});

test('rescheduled dates occupy precisely seven nights and release the checkout day without occupying the original dates',()=>{
 const p=page(),b=boat([projected()]),map=p.context.dayStatus(b,new Date(2027,2,1));assert.deepEqual([...map.keys()],['2027-03-06','2027-03-07','2027-03-08','2027-03-09','2027-03-10','2027-03-11','2027-03-12']);assert.equal(p.context.dayStatus(b,new Date(2026,2,1)).size,0);
 const calendar=p.context.calendar(b,new Date(2027,2,1));assert.match(calendar,/aria-label="2027-03-12 不可用"/);assert.match(calendar,/aria-label="2027-03-13 可用"/);
 p.setBoats([b]);for(const [start,end,expected] of [['2027-03-06','2027-03-13','1 艘不可用'],['2027-03-13','2027-03-14','0 艘不可用'],['2026-03-14','2026-03-21','0 艘不可用']]){p.document.getElementById('d1').value=start;p.document.getElementById('d2').value=end;p.context.window.checkAvail();assert.ok(p.document.getElementById('result').innerHTML.includes(expected));}
});

test('failed or changed source observations show review text while retaining the authorized dates and settlement amount',()=>{
 for(const [verification_status,review_reason,expected] of [['awaiting_observation',null,'尚待核对平台记录'],['needs_review','observation_missing','尚未取得本轮平台记录'],['needs_review','source_sync_failed','平台同步暂未成功'],['needs_review','platform_dates_changed','平台日期已有变化'],['needs_review','platform_boat_changed','平台船只已有变化'],['needs_review','platform_status_changed','平台状态已有变化']]){
  const r=record();Object.assign(r.manual_adjustment,{verification_status,review_reason});const p=page();p.setBoats([boat([projected(r)])]);const rendered=p.render();assert.match(rendered,/待核对/);assert.ok(rendered.includes(expected));assert.match(rendered,/当前保留人工改期日期/);assert.match(rendered,/2027-03-06/);assert.equal(count(rendered,'€4,200.00'),1);
 }
});

test('manual reschedules use the existing conflict pairing and checkout boundary, preserving both original links',()=>{
 const p=page(),manual=projected(),other={source:'samboat',booking_id:'999',start:'2027-03-12',end:'2027-03-15',status:'deposit_paid',url:'https://www.samboat.com/private/reservation/999',amount:'$100',amount_basis:'合成测试金额'},b=boat([manual,other]);p.setBoats([b]);p.expanded.push({dataset:{boatKey:slug}});const rendered=p.render();
 assert.match(rendered,/重叠日期：2027-03-12 至 2027-03-13 · 2 天/);assert.equal(count(rendered,'class="boat-booking boat-booking-conflict"'),2);assert.match(rendered,/人工改期/);assert.ok(rendered.includes('href="'+url+'"'));assert.ok(rendered.includes('href="'+other.url+'"'));assert.match(rendered,/<details class="boat-bookings"[^>]+ open>/);
 other.start='2027-03-14';assert.doesNotMatch(p.render(),/class="booking-conflicts"/);assert.match(p.render(),/人工改期/);
});

test('a later cancelled record removes the manual order even when another platform is missing, without leaving occupied dates or conflict notices',()=>{
 const w=worker(),data={boats:[boat([projected()])]},cancelled=record({status:'cancelled'});cancelled.manual_adjustment.verification_status='cancelled';cancelled.manual_adjustment.cancelled_at='2026-09-10T10:00:00.000Z';
 const result=w.applyBookingRegistry(data,{clickandboat:[cancelled],samboat:[]});assert.equal(result.booking_mapping_complete,false);assert.equal(result.boats[0].bookings.length,0);const p=page();p.setBoats(result.boats);assert.doesNotMatch(p.render(),/人工改期|data-booking-id="1000000"/);assert.equal(p.context.dayStatus(result.boats[0],new Date(2027,2,1)).size,0);
});

test('unaffected bookings and sync/query functions retain existing markup and behavior',()=>{
 const old=page(originalHTML),current=page(),regular=record({booking_id:'100',start:'2027-04-01',end:'2027-04-03',url:'https://www.clickandboat.com/uk/booking/100/detail'});delete regular.manual_adjustment;const b=boat([projected(regular)]);old.setBoats([b]);current.setBoats([b]);assert.equal(current.render(),old.render());
 for(const name of ['confirmed','activeBookings','knownOrders','knownBlocks','mergedOccupancy','dayStatus','calendar','findBookingConflicts','bookingConflictNotice','orderURL','loadData','readPhoneStatus','phoneRunProgress','initialize'])assert.equal(current.context[name].toString(),old.context[name].toString(),name);assert.equal(current.context.window.checkAvail.toString(),old.context.window.checkAvail.toString());
 assert.deepEqual(plain(worker().normalizeBooking('clickandboat',regular)),plain(worker(original).normalizeBooking('clickandboat',regular)));
});

test('new text is escaped and uses theme tokens including within a red conflict card',()=>{
 const p=page(),r=projected();r.manual_adjustment.original_start='<img src=x onerror=alert(1)>';r.manual_adjustment.payment_evidence.paid_on='" onclick="alert(1)';r.manual_adjustment.verification_status='needs_review';r.manual_adjustment.platform_start='<script>';p.setBoats([boat([r])]);const rendered=p.render();assert.doesNotMatch(rendered,/<img|<script>|onclick="/);assert.match(rendered,/&lt;img/);assert.match(rendered,/&quot;/);
 const style=readStyle(html);assert.match(style,/\.manual-reschedule-note\{[^}]*background:var\(--soft\);color:var\(--text\)/);assert.match(style,/\.boat-booking-conflict \.manual-reschedule-note\{[^}]*background:var\(--conflict-soft\);color:var\(--conflict-text\)/);assert.match(style,/\.manual-reschedule-note \.manual-reschedule-review\{[^}]*background:var\(--conflict-panel\);color:var\(--conflict-text\)/);
});
