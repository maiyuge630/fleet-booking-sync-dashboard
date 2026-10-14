'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const {patchPhoneAgent}=require('./phone-agent-patch.cjs');
const {patchBookingConflicts}=require('./booking-conflicts-patch.cjs');
const original=patchPhoneAgent(fs.readFileSync(path.join(__dirname,'phone-agent-build/baseline-integrated-source.mjs'),'utf8'));
const patched=patchBookingConflicts(original),oldHTML=extractHTML(original),newHTML=extractHTML(patched);
const readScript=html=>html.match(/<script>([\s\S]*?)<\/script>/)[1],readStyle=html=>html.match(/<style>([\s\S]*?)<\/style>/)[1];
class TestDate extends Date{constructor(...args){super(...(args.length?args:['2026-09-10T12:00:00Z']));}static now(){return Date.parse('2026-09-10T12:00:00Z');}}
function page(html=newHTML){
 const nodes=new Map(),expanded=[],document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return expanded;},addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){}},Date:TestDate,URL,console,setTimeout(){},clearTimeout(){},AbortController});
 vm.runInContext(readScript(html).replace(/\binitialize\(\);\s*$/,''),context);
 return {context,document,expanded,setBoats(boats){context.fixtureBoats=boats;vm.runInContext('DATA={boats:fixtureBoats};',context);},html(){return document.getElementById('boats').innerHTML;}};
}
function booking(source,id,start,end,extra={}){
 const detail_id='a'.repeat(24),url=source==='boataround'?'https://partner.boataround.com/en/000000000000000000000000/orders/'+detail_id:source==='samboat'?'https://www.samboat.com/private/reservation/'+id:'https://www.clickandboat.com/uk/booking/'+id+'/detail';
 return {source,booking_id:String(id),start,end,status:'deposit_paid',url,detail_id,amount:'€100',amount_basis:'合成测试金额',...extra};
}
function fixture(){return {name:'Test Discovery 2 (Test 40)',boataround_slug:'test-discovery-2',bookings:[booking('boataround',101,'2026-12-26','2027-01-02'),booking('samboat',202,'2027-01-01','2027-01-08')]};}
function occurrences(value,needle){return value.split(needle).length-1;}

// Since 2026-10-13 the calendar does not mark a same-day handover either: the
// user's rule (2026-10-09) is that a changeover day is no overlap, and the red
// cell on AD5's 10-24 read as an error. The day still shows as booked.
test('same-day handover is no overlap anywhere: no dashboard warning, no red order card, no red calendar day',()=>{
 const f=page(),boat=fixture();boat.bookings[1].start='2027-01-02';f.setBoats([boat]);f.context.renderBoats();
 assert.equal(f.context.boatBookingConflicts(boat).pairs.length,1);
 assert.equal(f.context.dashboardBookingConflicts(boat).pairs.length,0);
 assert.equal(f.document.getElementById('booking-conflicts-overview').hidden,true);
 assert.doesNotMatch(f.html(),/class="booking-conflicts"|boat-booking-conflict"|class="booking-conflict-badge"/);
 assert.equal(occurrences(f.html(),'data-booking-id='),2);
 assert.ok(f.html().includes('id="'+f.context.bookingConflictAnchor(boat)+'"'));
 const calendar=f.context.calendar(boat,new Date(2027,0,1));
 assert.equal(occurrences(calendar,'booking-conflict-day'),0);
 // The boat cards draw their calendars with an explicit list: the same filter applies.
 assert.equal(f.context.calendarBookingConflicts(boat).pairs.length,0);
 assert.match(String(f.context.renderBoats),/calendarBookingConflicts\(boat\)/);
 boat.bookings[1].start='2027-01-01';f.context.renderBoats();
 // Two days or more: marked red in the calendar as before.
 assert.equal(occurrences(f.context.calendar(boat,new Date(2027,0,1)),'booking-conflict-day'),2);
 assert.equal(f.document.getElementById('booking-conflicts-overview').hidden,false);
 assert.equal(occurrences(f.html(),'class="booking-conflict-badge"'),2);
});

test('patch changes only dashboard presentation and its own CSP hashes, retaining login, sync pages and endpoints byte-for-byte',()=>{
 function masked(source){const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);return (source.slice(0,start)+'DASHBOARD\n'+source.slice(end)).replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/,'$1SCRIPT$2STYLE$3');}
 assert.equal(masked(patched),masked(original));
 const hide=html=>html.replace(/<style>[\s\S]*?<\/style>/,'<style>STYLE</style>').replace(/<script>[\s\S]*?<\/script>/,'<script>SCRIPT</script>').replace('<aside class="booking-conflicts-overview" id="booking-conflicts-overview" aria-label="疑似撞单总览" hidden></aside>\n','');
 assert.equal(hide(newHTML),hide(oldHTML));assert.ok(readStyle(newHTML).startsWith(readStyle(oldHTML)));
 const old=page(oldHTML).context,current=page().context;
 for(const name of ['confirmed','activeBookings','knownOrders','orderURL','sourceURL','knownBlocks','mergedOccupancy','dayStatus','loadData','readPhoneStatus','phoneRunProgress','initialize'])assert.equal(current[name].toString(),old[name].toString(),name);
 assert.equal(current.window.checkAvail.toString(),old.window.checkAvail.toString());
});

test('dashboard script and style CSP match exactly and the patch rejects repeated application',()=>{
 const csp=patched.match(/"dashboard":\s*"([^"\n]+)"/)[1];
 for(const value of [readScript(newHTML),readStyle(newHTML)])assert.ok(csp.includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));
 assert.throws(()=>patchBookingConflicts(patched),/without conflict/);
 assert.match(newHTML,/<i class="sw booked"[^>]*><\/i>不可用/);assert.match(newHTML,/<i class="sw available"[^>]*><\/i>可用/);
});

test('a cross-year overlap remains visible above collapsed per-boat details outside the selected month',()=>{
 const f=page(),boat=fixture();f.setBoats([boat]);f.context.renderBoats();const html=f.html(),anchor=f.context.bookingConflictAnchor(boat);
 assert.equal(vm.runInContext('monthIndex',f.context),0);assert.match(html,/重叠日期：2027-01-01 至 2027-01-02 · 2 天/);assert.equal(occurrences(html,'class="booking-conflicts"'),1);
 assert.ok(html.indexOf('class="booking-conflicts"')<html.indexOf('<details class="boat-bookings"'));assert.match(html,/<details class="boat-bookings" data-boat-key="test-discovery-2">/);
 assert.equal(occurrences(html,'class="boat-booking boat-booking-conflict"'),2);assert.equal(occurrences(html,'class="booking-conflict-badge"'),2);
 const overview=f.document.getElementById('booking-conflicts-overview');assert.equal(overview.hidden,false);assert.match(overview.innerHTML,/1 艘船 · 1 组重叠/);assert.ok(overview.innerHTML.includes('href="#'+anchor+'"'));
 for(const order of boat.bookings)assert.equal(occurrences(html,'href="'+order.url+'"'),2);
});

test('a conflict date links to both orders in its boat notice and keeps the unavailable classification',()=>{
 const f=page(),boat=fixture(),anchor=f.context.bookingConflictAnchor(boat),html=f.context.calendar(boat,new Date(2027,0,1));
 const conflict=html.match(/<td class="b booking-conflict-day"[\s\S]*?<\/td>/)[0];
 assert.match(conflict,/aria-label="2027-01-01 不可用 疑似撞单"/);assert.match(conflict,/Boataround #101 与 SamBoat #202/);assert.ok(conflict.includes('href="#'+anchor+'"'));assert.match(conflict,/>撞<\/span>/);assert.doesNotMatch(conflict,/target="_blank"/);
 assert.equal(occurrences(html,'booking-conflict-day'),2);assert.match(html,/aria-label="2027-01-02 不可用 疑似撞单"/);assert.match(html,/aria-label="2027-01-08 可用"/);
 const noConflict=f.context.calendar({name:boat.name,bookings:[boat.bookings[1]]},new Date(2027,0,1));assert.ok(noConflict.includes('href="'+boat.bookings[1].url+'" target="_blank"'));
});

test('all overlapping pairs are shown, including same-platform orders, while separate boats do not cross-match',()=>{
 const f=page(),boat=fixture();boat.bookings.push(booking('boataround',303,'2026-12-31','2027-01-03',{detail_id:'b'.repeat(24),url:'https://partner.boataround.com/en/000000000000000000000000/orders/'+'b'.repeat(24)}));
 const other={name:'Other boat',boataround_slug:'other',bookings:[booking('samboat',404,'2026-12-26','2027-01-08')]};f.setBoats([boat,other]);f.context.renderBoats();
 assert.match(f.html(),/疑似撞单 · 3 组重叠/);assert.equal(occurrences(f.html(),'class="booking-conflict-dates"'),3);assert.equal(occurrences(f.html(),'class="boat-booking boat-booking-conflict"'),3);assert.match(f.document.getElementById('booking-conflicts-overview').innerHTML,/1 艘船 · 3 组重叠/);
 assert.equal(occurrences(f.html(),'data-booking-id="404"'),1);assert.doesNotMatch(f.html(),/boat-booking-conflict" data-booking-id="404"/);
});

test('cancelled or moved orders clear notices and red rows on rerender without closing retained details or changing selected month',()=>{
 const f=page(),boat=fixture();f.setBoats([boat]);f.expanded.push({dataset:{boatKey:boat.boataround_slug}});vm.runInContext('monthIndex=4',f.context);f.context.renderBoats();assert.match(f.html(),/疑似撞单/);
 boat.bookings[1].status='cancelled';f.context.renderBoats();assert.doesNotMatch(f.html(),/booking-conflicts"|boat-booking-conflict"|booking-conflict-day/);assert.equal(f.document.getElementById('booking-conflicts-overview').hidden,true);assert.equal(f.document.getElementById('booking-conflicts-overview').innerHTML,'');assert.match(f.html(),/<details class="boat-bookings" data-boat-key="test-discovery-2" open>/);assert.equal(vm.runInContext('monthIndex',f.context),4);
 boat.bookings[1].status='deposit_paid';boat.bookings[1].start='2027-01-03';f.context.renderBoats();assert.doesNotMatch(f.html(),/class="booking-conflicts"/);assert.equal(occurrences(f.html(),'class="boat-booking"'),2);
});

test('unaffected calendars and order rows retain the original markup for adjacent or separate bookings',()=>{
 const old=page(oldHTML),current=page(),boat=fixture();boat.bookings[1].start='2027-01-03';old.setBoats([boat]);current.setBoats([boat]);old.context.renderBoats();current.context.renderBoats();assert.equal(current.html(),old.html());
 for(const month of [new Date(2026,11,1),new Date(2027,0,1)])assert.equal(current.context.calendar(boat,month),old.context.calendar(boat,month));
});

test('notice text is escaped and platform order links retain the existing URL whitelist',()=>{
 const f=page(),boat=fixture();boat.name='<img src=x onerror=alert(1)> & "boat"';boat.boataround_slug='bad" onclick="alert(1)';boat.bookings[1].url='javascript:alert(1)';f.setBoats([boat]);f.context.renderBoats();
 const html=f.html(),overview=f.document.getElementById('booking-conflicts-overview').innerHTML;
 assert.doesNotMatch(html+overview,/<img|javascript:|onclick="/);assert.match(html,/&lt;img/);assert.match(overview,/&amp;/);assert.match(html,/SamBoat #202 <span class="booking-conflict-link-issue">（详情链接待核实）/);assert.ok(html.includes('href="'+boat.bookings[0].url+'"'));
 for(const url of ['https://evil.example/private/reservation/202','https://www.samboat.com/private/reservation/999','https://www.samboat.com/private/reservation/202?token=private']){boat.bookings[1].url=url;const notice=f.context.bookingConflictNotice(boat,f.context.boatBookingConflicts(boat));assert.ok(!notice.includes(url));assert.match(notice,/详情链接待核实/);}
});
