'use strict';
// 未来预计收入：run the final dashboard script (the same patch chain as
// build.mjs) with fixture boats and check the summary and calendar cells.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const chain=[
 require('./phone-agent-patch.cjs').patchPhoneAgent,require('./booking-conflicts-patch.cjs').patchBookingConflicts,
 require('./manual-reschedule-patch.cjs').patchManualReschedule,require('./voltage-patch.cjs').patchVoltage,
 require('./reverse-sync/frontend-patch.cjs').patchReverse,require('./checkout-day-patch.cjs').patchCheckoutDay,
 require('./manual-unavailability-patch.cjs').patchManualUnavailability,require('./order-query-freshness-patch.cjs').patchOrderQueryFreshness,
 require('./manual-orders-patch.cjs').patchManualOrders,require('./boataround-payment-workflow-patch.cjs').patchBoataroundPaymentWorkflow,
 require('./mmk-orders-patch.cjs').patchMmkOrders];
const {patchRevenue}=require('./revenue-patch.cjs'),{patchCopyStyle}=require('./copy-style-patch.cjs');
const beforeRevenue=chain.reduce((source,patch)=>patch(source),fs.readFileSync(path.join(__dirname,'phone-agent-build/baseline-integrated-source.mjs'),'utf8'));
const final=patchCopyStyle(patchRevenue(beforeRevenue)),html=extractHTML(final);
const readScript=value=>value.match(/<script>([\s\S]*?)<\/script>/)[1],readStyle=value=>value.match(/<style>([\s\S]*?)<\/style>/)[1];
// Beijing 2026-09-10 20:00.
class TestDate extends Date{constructor(...args){super(...(args.length?args:['2026-09-10T12:00:00Z']));}static now(){return Date.parse('2026-09-10T12:00:00Z');}}
function page(){
 const nodes=new Map(),selected=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return nodes.get(id);},querySelectorAll(selector){return selected.get(selector)||[];},addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){}},Date:TestDate,URL,console,setTimeout(){},clearTimeout(){},AbortController,Intl});
 vm.runInContext(readScript(html).replace(/\binitialize\(\);\s*$/,''),context);
 return {context,node:id=>document.getElementById(id),set(boats){context.fixture=boats;vm.runInContext('DATA={boats:fixture};monthIndex=0;',context);},
  month(i){vm.runInContext('monthIndex='+i+';',context);},select(selector,elements){selected.set(selector,elements);}};
}
const order=(source,booking_id,start,end,amount,extra={})=>({source,booking_id,start,end,status:source==='samboat'?'paid':'accepted',amount,url:'https://example.invalid/'+booking_id,...extra});
const boat=(name,slug,bookings)=>({name,boataround_slug:slug,sources:{},bookings});
const fleet=()=>[
 boat('Tidewyn Discovery 5 (Grandcat 55)','ad5',[
  order('boataround','301','2026-09-07','2026-09-13','€3,000.00'),          // 6 nights, 3 already past
  order('clickandboat','401','2026-09-20','2026-09-23','€100.00')]),          // 3 nights, uneven cents
 boat('Tidewyn Discovery 2 (Seacat 40)','ad2',[
  order('boataround','302','2026-09-10','2026-09-12','€1,000.00'),
  order('samboat','501','2026-09-11','2026-09-11','$240.00'),                // day charter, in USD
  order('manual','m1','2026-09-15','2026-09-16',undefined,{status:'paid'}),
  order('clickandboat','402','2026-09-25','2026-09-27',undefined)]),
 boat('Tidewyn Dream (Wavecat 34)','dream',[order('clickandboat','403','2026-10-02','2026-10-04','€800.00',{status:'cancelled'})])];

test('the patch is applied once, keeps exact CSP hashes and survives the final copy stage',()=>{
 const policy=final.match(/"dashboard":\s*"([^"\n]+)"/)[1];
 for(const value of [readScript(html),readStyle(html)])assert.ok(policy.includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));
 assert.throws(()=>patchRevenue(patchRevenue(beforeRevenue)),/already applied/);
 assert.match(html,/<section id="revenue-panel"[\s\S]*<section id="manual-order-panel"/);
 assert.match(html,/合计把各平台（Boataround、Click&amp;Boat、SamBoat、MMK、NauSYS）和 Tidewyn Charters 直接收款相加（直接收款已付、没有日期，只计入今天起合计，不分到月份，也不同步到任何平台），不同货币分开写、不换算；点开看各平台和金额口径，再点某个平台看它每艘船的订单明细。MMK、NauSYS 的 Option 也算在内。/);
 // Each boat card carries its own folded total, just above its order list.
 assert.match(readScript(html),/bookingConflictNotice\(boat,conflicts\)\+revenueBoatDetails\(boat\)\+'<details class="boat-bookings"/);
});

test('amounts are spread per night from today on, exactly, and only for valid orders',()=>{
 const p=page();p.set(fleet());
 const plain=value=>JSON.parse(JSON.stringify(value));
 const ad5=plain(vm.runInContext('revenueEntries(DATA.boats[0])',p.context)),ad2=plain(vm.runInContext('revenueEntries(DATA.boats[1])',p.context));
 // BA 301: €3,000 over 6 nights → €500 a night; 09-07..09-09 are past, 09-13 is the disembark day.
 assert.deepEqual(ad5.entries.filter(e=>e.source==='boataround').map(e=>[e.day,e.minor]),[['2026-09-10',50000],['2026-09-11',50000],['2026-09-12',50000]]);
 // CB 401: €100.00 over 3 nights keeps every cent.
 assert.deepEqual(ad5.entries.filter(e=>e.source==='clickandboat').map(e=>e.minor),[3334,3333,3333]);
 // SamBoat day charter counts its one day; manual and amount-less orders are listed as not counted.
 assert.deepEqual(ad2.entries.filter(e=>e.source==='samboat').map(e=>[e.day,e.minor]),[['2026-09-11',24000]]);
 // Manual orders are listed by the panel from knownOrders (see the panel test).
 assert.deepEqual(ad2.skipped.map(b=>b.booking_id).sort(),['402']);
 // Cancelled orders are not valid orders.
 assert.equal(vm.runInContext('revenueEntries(DATA.boats[2]).entries.length',p.context),0);
});

test('the platform rows keep the three platforms apart, per boat and per day',()=>{
 const p=page();p.set(fleet());p.context.renderRevenue();
 const body=p.node('revenue-body').innerHTML;
 assert.equal(p.node('revenue-month').textContent,'2026年9月');
 // Today-on and this-month totals: BA 3×500 + 2×500 = €2,500; CB €100; SB €240 — one row each.
 const platform=(name,basis,count,all,month)=>new RegExp('<span class="revenue-platform-name">'+name+'<small>'+basis+' · '+count+' 笔订单，点开看明细</small></span><span class="revenue-platform-amount">'+all+'</span><span class="revenue-platform-amount">'+month+'</span></summary>');
 assert.match(body,/<div class="revenue-platform-head" aria-hidden="true"><span>平台 · 金额口径<\/span><span>今天起全部<\/span><span>2026年9月（今天起）<\/span><\/div>/);
 assert.match(body,platform('Boataround','船东净价',2,'€2,500','€2,500'));
 // CB: 401 counted, 402 listed without an amount.
 assert.match(body,platform('Click&amp;Boat','船东净收入',2,'€100','€100'));
 assert.match(body,platform('SamBoat','租客在线支付金额',1,'\\$240','\\$240'));
 // The platform rows never add platforms.
 assert.doesNotMatch(body.match(/<div class="revenue-platforms">[\s\S]*?<\/summary>[\s\S]*?<\/summary>[\s\S]*?<\/summary>/)[0],/€2,600|€1,600|€1,240/);
 // Day 09-11: AD5 BA €500, AD2 BA €500 and SB €240; the day total shows BA €1,000 and SB €240 on separate lines.
 const row=body.match(/<tr[^>]*><th scope="row">09-11[\s\S]*?<\/tr>/)[0];
 assert.match(row,/<small>BA<\/small> €500[\s\S]*<small>BA<\/small> €500[\s\S]*<small>SB<\/small> \$240/);
 assert.match(row,/<small>BA<\/small> €1,000<\/span><span class="revenue-line" title="SamBoat · 租客在线支付金额"><small>SB<\/small> \$240/);
 // Past days of the current month are not listed; today is marked.
 assert.doesNotMatch(body,/>09-09</);assert.match(body,/class="revenue-today"><th scope="row">09-10 <small>今天<\/small>/);
 // The daily detail is folded, lists only the 6 days with an amount, and only
 // boats with an amount this month (short codes; Dream has none).
 assert.match(body,/<details id="revenue-details" class="revenue-details"><summary>按天明细 · 6 天有收入<\/summary>/);
 assert.match(body,/<th scope="col">日期<\/th><th scope="col" title="Tidewyn Discovery 5 \(Grandcat 55\)">AD5<\/th><th scope="col" title="Tidewyn Discovery 2 \(Seacat 40\)">AD2<\/th><th scope="col">当天合计<\/th>/);
 assert.doesNotMatch(body.match(/<details id="revenue-details"[\s\S]*<\/details>/)[0],/>Dream<|>09-13<|>09-15</);
 // Once opened it stays open when the dashboard re-renders.
 p.node('revenue-details').open=true;p.context.renderRevenue();
 assert.match(p.node('revenue-body').innerHTML,/<details id="revenue-details" class="revenue-details" open>/);
 assert.match(body,/未计入：1 笔手动订单（没有金额）；1 笔订单缺少金额（Click&amp;Boat #402）/);
 // Another month: the month table changes, the today-on total does not.
 p.month(1);p.context.renderRevenue();const october=p.node('revenue-body').innerHTML;
 assert.equal(p.node('revenue-month').textContent,'2026年10月');assert.match(october,/2026年10月今天及以后没有订单金额/);
 assert.match(october,/<span class="revenue-platform-name">Boataround<small>船东净价 · 2 笔订单，点开看明细<\/small><\/span><span class="revenue-platform-amount">€2,500<\/span><span class="revenue-platform-amount"><span class="revenue-empty">—<\/span><\/span><\/summary>/);
});

test('manual orders shown on the live page (through knownOrders only) are listed as not counted',()=>{
 const p=page();p.set(fleet().map(b=>({...b,bookings:b.bookings.filter(o=>o.source!=='manual')})));
 // The live dashboard adds manual orders in knownOrders, not in the platform bookings.
 vm.runInContext("const baseKnown=knownOrders;knownOrders=boat=>boat.boataround_slug==='ad2'?[...baseKnown(boat),{source:'manual',booking_id:'m9',start:'2026-09-20',end:'2026-09-22',status:'paid'}]:baseKnown(boat);",p.context);
 p.context.renderRevenue();
 assert.match(p.node('revenue-body').innerHTML,/未计入：1 笔手动订单（没有金额）；1 笔订单缺少金额（Click&amp;Boat #402）/);
 assert.match(vm.runInContext('revenueBoatDetails(DATA.boats[1])',p.context),/未计入：1 笔手动订单（没有金额）/);
});

test('the total adds the three platforms first and opens to each platform',()=>{
 const p=page();p.set(fleet());p.context.renderRevenue();
 const body=p.node('revenue-body').innerHTML;
 // BA €2,500 + CB €100 = €2,600; SamBoat $240 is not converted, only written side by side. Folded at first.
 assert.match(body,/^<details id="revenue-total" class="revenue-total"><summary><span class="revenue-total-name"><strong>各平台合计<\/strong><small>点开看各平台<\/small><\/span><span class="revenue-amount revenue-amount-all">€2,600 \+ \$240<small>今天起<\/small><\/span><span class="revenue-amount revenue-amount-month">€2,600 \+ \$240<small>2026年9月（今天起）<\/small><\/span><\/summary><div class="revenue-platforms">[\s\S]*<\/div><\/details>/);
 // The boats' own totals are not listed in the panel; they each carry their own total.
 assert.doesNotMatch(body,/boat-revenue|每艘船/);
 // Once opened it stays open when the dashboard re-renders.
 p.node('revenue-total').open=true;p.context.renderRevenue();
 assert.match(p.node('revenue-body').innerHTML,/^<details id="revenue-total" class="revenue-total" open>/);
});

test('each platform opens to its orders by boat, with the counted share and the verified order link',()=>{
 const p=page(),boats=fleet();
 boats[0].bookings[1].url='https://www.clickandboat.com/uk/booking/401/detail';   // a verified Click&Boat order page
 p.set(boats);p.context.renderRevenue();
 const body=p.node('revenue-body').innerHTML;
 const section=source=>body.match(new RegExp('<details class="revenue-platform" data-source="'+source+'">[\\s\\S]*?</details>'))[0];
 // Boataround: AD5 first (fleet order), then AD2; each group says how many orders and what counts from today.
 const ba=section('boataround');
 assert.match(ba,/<h4>AD5 <span>Tidewyn Discovery 5 \(Grandcat 55\)<\/span><small>1 笔 · 今天起 €1,500<\/small><\/h4>[\s\S]*<h4>AD2 <span>Tidewyn Discovery 2 \(Seacat 40\)<\/span><small>1 笔 · 今天起 €1,000<\/small><\/h4>/);
 // BA 301 already started: the whole order amount is shown, and only the nights from today are counted.
 assert.match(ba,/Boataround #301<\/span><span class="boat-booking-status">已接受<\/span>[\s\S]*?<strong>2026-09-07<\/strong>[\s\S]*?<strong>2026-09-13<\/strong>[\s\S]*?<strong>€3,000.00<\/strong><small>6 晚 · 今天起计入 €1,500，其中 9月（今天起） €1,500<\/small>/);
 // An unverified address is never linked.
 assert.match(ba,/<span class="order-link-issue">详情链接待核实<\/span>/);assert.doesNotMatch(ba,/example\.invalid/);
 // Click&Boat: the verified order page opens in a new tab; an order without an amount is listed as not counted.
 const cb=section('clickandboat');
 assert.match(cb,/<a class="order-detail-link" href="https:\/\/www\.clickandboat\.com\/uk\/booking\/401\/detail" target="_blank" rel="noopener noreferrer" aria-label="查看 Click&amp;Boat 订单 401">查看订单 ↗<\/a>/);
 assert.match(cb,/Click&amp;Boat #402[\s\S]*?<small>2 晚 · 缺少金额，未计入<\/small>/);
 // SamBoat day charter: one day; the cancelled CB order and the manual order are not platform revenue orders.
 assert.match(section('samboat'),/SamBoat #501<\/span><span class="boat-booking-status">已付款<\/span>[\s\S]*?<small>1 天 · 今天起计入 \$240，其中 9月（今天起） \$240<\/small>/);
 assert.doesNotMatch(body,/#403|#m1/);
 // Folded at first; a platform the viewer opened stays open when the dashboard re-renders.
 assert.doesNotMatch(body,/class="revenue-platform"[^>]* open>/);
 p.select('#revenue-total details.revenue-platform[open]',[{dataset:{source:'clickandboat'}}]);p.context.renderRevenue();
 assert.match(p.node('revenue-body').innerHTML,/<details class="revenue-platform" data-source="clickandboat" open>/);
 assert.match(p.node('revenue-body').innerHTML,/<details class="revenue-platform" data-source="boataround">/);
});

test('Tidewyn Charters direct income counts in the today-on totals as a fifth platform, never in a month, a day or the calendar',()=>{
 const p=page();p.set(fleet());
 // The live list names AC2 and AD5 by their real keys; the fixture boats use short keys.
 vm.runInContext("REVENUE_DIRECT=[{id:'AC2',boat:'ad2',amount:'€7,300.00'},{id:'AD5',boat:'ad5',amount:'€1,900.00'}];",p.context);
 p.context.renderRevenue();
 const body=p.node('revenue-body').innerHTML;
 // Fleet total: €2,600 from the platforms + €9,200 direct; this month's figure is unchanged.
 assert.match(body,/<span class="revenue-amount revenue-amount-all">€11,800 \+ \$240<small>今天起<\/small><\/span><span class="revenue-amount revenue-amount-month">€2,600 \+ \$240<small>2026年9月（今天起）<\/small>/);
 assert.match(body,/<span class="revenue-platform-name">Tidewyn Charters<small>直接收款（已付） · 2 笔收入，点开看明细<\/small><\/span><span class="revenue-platform-amount">€9,200<\/span><span class="revenue-platform-amount"><span class="revenue-empty">—<\/span><\/span><\/summary>/);
 const ca=body.match(/<details class="revenue-platform" data-source="tidewyn">[\s\S]*?<\/details>/)[0];
 assert.match(ca,/<h4>AD2 <span>Tidewyn Discovery 2 \(Seacat 40\)<\/span><small>1 笔 · 今天起 €7,300<\/small><\/h4>[\s\S]*Tidewyn Charters · AC2<\/span><span class="boat-booking-status">已付款<\/span>[\s\S]*<strong>€7,300.00<\/strong>/);
 assert.match(ca,/<h4>AD5 [\s\S]*1 笔 · 今天起 €1,900<\/small>[\s\S]*Tidewyn Charters · AD5[\s\S]*<strong>€1,900.00<\/strong><small>直接收款，没有日期：计入今天起合计，不分到月份；不同步到任何平台<\/small>/);
 assert.doesNotMatch(ca,/查看订单|order-link-issue/);
 // Not in the daily detail, the day cells or the month column.
 assert.doesNotMatch(body.match(/<details id="revenue-details"[\s\S]*<\/details>/)[0],/CA|7,300|1,900/);
 assert.doesNotMatch(vm.runInContext('calendar(DATA.boats[0],months[0])',p.context),/1,900|Tidewyn Charters/);
 // Each boat's own total includes it, with its own row and no month amount.
 const ad2=vm.runInContext('revenueBoatDetails(DATA.boats[1])',p.context);
 assert.match(ad2,/<span>今天起 <strong>€8,300 \+ \$240<\/strong><\/span><span>9月（今天起） <strong>€1,000 \+ \$240<\/strong>/);
 assert.match(ad2,/<th scope="row">Tidewyn Charters <small>直接收款（已付）<\/small><\/th><td>€7,300<\/td><td><span class="revenue-empty">—<\/span><\/td>/);
});

test('each boat card folds its own total, adds its three platforms and opens to each platform',()=>{
 const p=page();p.set(fleet());p.context.renderRevenue();
 const card=i=>vm.runInContext('revenueBoatDetails(DATA.boats['+i+'])',p.context);
 // AD5: BA €1,500 + CB €100 = €1,600 from today, all in September.
 assert.match(card(0),/^<details class="boat-revenue" data-boat-key="ad5"><summary>预计收入 <span class="boat-revenue-figures"><span>今天起 <strong>€1,600<\/strong><\/span><span>9月（今天起） <strong>€1,600<\/strong><\/span><\/span><\/summary>/);
 // AD2: BA €1,000 and SamBoat $240 side by side; opening it lists each platform with its own basis.
 assert.match(card(1),/<span>今天起 <strong>€1,000 \+ \$240<\/strong>/);
 assert.match(card(1),/<th scope="row">Boataround <small>船东净价<\/small><\/th><td>€1,000<\/td><td>€1,000<\/td><\/tr><tr><th scope="row">SamBoat <small>租客在线支付金额<\/small><\/th><td>\$240<\/td><td>\$240<\/td><\/tr><\/tbody><\/table>/);
 assert.doesNotMatch(card(1),/<th scope="row">Click&amp;Boat/);
 assert.match(card(1),/<p class="revenue-skipped">未计入：1 笔手动订单（没有金额）；1 笔订单缺少金额（Click&amp;Boat #402）。<\/p><\/details>$/);
 // A boat without amounts gets one plain line, nothing to open.
 assert.equal(card(2),'<div class="boat-revenue boat-revenue-none">预计收入 <span>今天起没有订单金额</span></div>');
 // A boat the viewer opened stays open after the cards are rebuilt; the others stay folded.
 p.select('#boats details.boat-revenue[open]',[{dataset:{boatKey:'ad2'}}]);p.context.renderRevenue();
 assert.match(card(1),/^<details class="boat-revenue" data-boat-key="ad2" open>/);
 assert.match(card(0),/^<details class="boat-revenue" data-boat-key="ad5">/);
 // Another year's month carries the year in the short label.
 p.select('#boats details.boat-revenue[open]',[]);p.month(4);p.context.renderRevenue();
 assert.match(card(0),/<span>2027年1月 <strong>—<\/strong><\/span>/);
});

test('each boat calendar shows the night share on future nights only',()=>{
 const p=page();p.set(fleet());p.context.renderRevenue();
 const cal=vm.runInContext('calendar(DATA.boats[0],months[0])',p.context);
 const cell=day=>cal.match(new RegExp('aria-label="2026-09-'+day+'[^"]*"[^>]*>[\\s\\S]*?</td>'))[0];
 assert.match(cell('11'),/<span class="day-revenue" title="2026-09-11 预计收入：Boataround €500（船东净价，按晚分摊）">€500<\/span>/);
 assert.doesNotMatch(cell('09'),/day-revenue/);   // past night
 assert.doesNotMatch(cell('13'),/day-revenue/);   // disembark day
 assert.match(cell('20'),/>€33</);                 // €33.34 rounded for display
});
