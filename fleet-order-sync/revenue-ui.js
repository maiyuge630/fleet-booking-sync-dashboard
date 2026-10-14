// 未来预计收入（用户 2026-10 要求）：每笔有效订单的金额按晚平均分摊，
// 只算今天及以后的晚上。上方先显示各平台（含 2026-10-04 起的 MMK、10-09 起的 NauSYS）的合计，点开看各平台；每艘船的
// 合计折叠在这艘船自己的卡片里，点开看各平台。同币种相加、不同币种分开写，
// 不换算。手动订单没有金额，不计入。
const REVENUE_SOURCES=['boataround','clickandboat','samboat','mmk','nausys','tidewyn'];
const REVENUE_BASIS={boataround:'船东净价',clickandboat:'船东净收入',samboat:'租客在线支付金额',mmk:'船东净收入（扣代理佣金）',nausys:'船东净收入（代理价，扣代理佣金）',tidewyn:'直接收款（已付）'};
const REVENUE_CODE={boataround:'BA',clickandboat:'CB',samboat:'SB',mmk:'MMK',nausys:'NS',tidewyn:'CA'};
// Tidewyn Charters's own income (user 2026-10-04): already paid directly, not an
// order on any platform and never synced to any calendar. It has no dates, so
// it counts in the today-on totals only, not in a month, a day or the calendar.
let REVENUE_DIRECT=[
 {id:'AC2',boat:'coastline-sea-journey-42-tidewyn-cruise-2',amount:'€7,300.00'},
 {id:'AD5',boat:'grandcat-55-tidewyn-discovery-5',amount:'€1,900.00'}];
function revenueLabel(source){return source==='tidewyn'?'Tidewyn Charters':srcLabel(source);}
let REVENUE_DAYS=new Map(),REVENUE_BOATS=new Map(),REVENUE_LABEL='',REVENUE_SHORT='',REVENUE_OPEN=new Set();
// Each platform's orders from today on, by boat (user request 2026-10-04): the
// platform rows of the fleet total open to them. Kept open across refreshes.
let REVENUE_ORDERS=new Map(),REVENUE_PLATFORM_OPEN=new Set();
// Amounts arrive normalized as "€1,234.00" (or "$…"); anything else is not counted.
function revenueAmount(text){const m=/^([€$])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/.exec(String(text||''));return m?{currency:m[1],minor:Number(m[2].replace(/,/g,''))*100+Number(m[3])}:null;}
// Nights from boarding up to the night before disembarking; a SamBoat day
// charter (same start and end) counts as its one day.
function revenueNights(booking){if(booking.start===booking.end)return [booking.start];const days=[];for(let day=booking.start;day<booking.end;day=shiftDay(day,1))days.push(day);return days;}
function revenueBoatKey(boat){return String(boat.boataround_slug||boat.name);}
function revenueBoatCode(boat){const name=String(boat.name||'').replace(/\s*\(.*\)$/,''),m=/Tidewyn (Discovery|Cruise)(?: (\d+))?$/.exec(name);return m?'A'+m[1][0]+(m[2]||'1'):/Tidewyn Dream$/.test(name)?'Dream':name;}
// Each counted night: the order's amount split evenly, leftover cents on the
// first nights so the parts add up exactly. Orders without an amount are listed.
function revenueEntries(boat,today=beijingToday()){
 const entries=[],skipped=[];
 for(const b of activeBookings(boat)){
  // Manual orders are counted from knownOrders in renderRevenue: on the live
  // page they are not part of the platform bookings at all.
  if(b.end<today||b.source==='manual')continue;
  const amount=REVENUE_SOURCES.includes(b.source)?revenueAmount(b.amount):null;
  if(!amount){if(revenueNights(b).some(day=>day>=today))skipped.push(b);continue;}
  const nights=revenueNights(b),base=Math.floor(amount.minor/nights.length),extra=amount.minor-base*nights.length;
  nights.forEach((day,i)=>{if(day>=today)entries.push({day,source:b.source,currency:amount.currency,minor:base+(i<extra?1:0),booking:b});});
 }
 return {entries,skipped};
}
function revenueAdd(totals,entry){const key=entry.source+'|'+entry.currency;totals.set(key,(totals.get(key)||0)+entry.minor);}
function revenueMoney(currency,minor){return currency+String(Math.round(minor/100)).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
// One platform's total, e.g. "€1,234" (two currencies are shown side by side, never added).
function revenueText(totals,source){return [...totals].filter(([key])=>key.startsWith(source+'|')).map(([key,minor])=>revenueMoney(key.split('|')[1],minor)).join(' · ');}
function revenueLines(totals){return REVENUE_SOURCES.map(source=>{const value=revenueText(totals,source);return value?'<span class="revenue-line" title="'+esc(revenueLabel(source)+' · '+REVENUE_BASIS[source])+'"><small>'+REVENUE_CODE[source]+'</small> '+esc(value)+'</span>':'';}).join('');}
// Each platform on its own row with its amount basis: from today on, and for the shown month.
function revenueSummary(all,inMonth,monthLabel){
 const rows=REVENUE_SOURCES.filter(source=>revenueText(all,source)).map(source=>'<tr><th scope="row">'+esc(revenueLabel(source))+' <small>'+esc(REVENUE_BASIS[source])+'</small></th><td>'+esc(revenueText(all,source))+'</td><td>'+(esc(revenueText(inMonth,source))||'<span class="revenue-empty">—</span>')+'</td></tr>').join('');
 return rows?'<table class="revenue-summary"><thead><tr><th scope="col">平台 · 金额口径</th><th scope="col">今天起全部</th><th scope="col">'+esc(monthLabel)+'</th></tr></thead><tbody>'+rows+'</tbody></table>':'';
}
// All platforms added together (user request 2026-10-03). Amounts in
// different currencies are written side by side, never converted.
function revenueCombined(totals){const byCurrency=new Map();for(const [key,minor] of totals){const currency=key.split('|')[1];byCurrency.set(currency,(byCurrency.get(currency)||0)+minor);}return [...byCurrency].map(([currency,minor])=>revenueMoney(currency,minor)).join(' + ');}
function revenueSkippedNote(skipped){
 const manual=skipped.filter(b=>b.source==='manual').length,missing=skipped.filter(b=>b.source!=='manual');
 return manual||missing.length?'<p class="revenue-skipped">未计入：'+[manual?manual+' 笔手动订单（没有金额）':'',missing.length?missing.length+' 笔订单缺少金额（'+missing.map(b=>esc(srcLabel(b.source)+' #'+b.booking_id)).join('、')+'）':''].filter(Boolean).join('；')+'。</p>':'';
}
// One order in a platform's list, in the same card as the boat's order list:
// the order's own amount, the part counted from today (and in the shown
// month), and the verified link to the order on the platform.
function revenueOrderCard(b,counted,monthLabel){
 if(b.direct)return '<article class="boat-booking revenue-order revenue-direct" data-booking-id="'+esc(b.booking_id)+'"><div class="boat-booking-heading"><span class="boat-booking-platform">Tidewyn Charters · '+esc(b.booking_id)+'</span><span class="boat-booking-status">已付款</span></div>'
  +'<div class="boat-booking-bottom"><div class="boat-booking-money"><strong>'+esc(b.amount)+'</strong><small>直接收款，没有日期：计入今天起合计，不分到月份；不同步到任何平台</small></div></div></article>';
 const url=orderURL(b),nights=revenueNights(b).length+(b.start===b.end?' 天':' 晚');
 const action=url?'<a class="order-detail-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" aria-label="查看 '+esc(srcLabel(b.source))+' 订单 '+esc(b.booking_id)+'">查看订单 ↗</a>':'<span class="order-link-issue">'+esc(b.link_issue||'详情链接待核实')+'</span>';
 const share='<small>'+nights+' · '+(counted?'今天起计入 '+esc(revenueMoney(counted.currency,counted.all))+(counted.month?'，其中 '+esc(monthLabel)+' '+esc(revenueMoney(counted.currency,counted.month)):''):'缺少金额，未计入')+'</small>';
 return '<article class="boat-booking revenue-order" data-booking-id="'+esc(b.booking_id)+'"><div class="boat-booking-heading"><span class="boat-booking-platform">'+esc(srcLabel(b.source))+' #'+esc(b.booking_id)+'</span><span class="boat-booking-status">'+esc(orderStatus(b))+'</span></div>'
  +'<div class="boat-booking-dates"><span><small>登船</small><strong>'+esc(b.start)+'</strong></span><span class="boat-date-arrow" aria-hidden="true">→</span><span><small>退船</small><strong>'+esc(b.end)+'</strong></span></div>'
  +'<div class="boat-booking-bottom"><div class="boat-booking-money"><strong>'+esc(b.amount||'金额待补充')+'</strong>'+share+'</div>'+action+'</div></article>';
}
// A platform's orders grouped by boat (fleet order), each group by boarding date.
function revenuePlatformOrders(source,monthLabel){
 const groups=[...(REVENUE_ORDERS.get(source)?.values()||[])];
 if(!groups.length)return '<p class="revenue-empty">今天起没有订单。</p>';
 const byStart=(a,b)=>a.start.localeCompare(b.start)||String(a.booking_id).localeCompare(String(b.booking_id));
 return '<div class="revenue-platform-orders">'+groups.map(group=>{
  const rows=[...group.rows.values()].sort((a,b)=>byStart(a.booking,b.booking)),total=new Map();
  for(const row of rows)revenueAdd(total,{source,currency:row.currency,minor:row.all});
  const cards=[...rows.map(row=>revenueOrderCard(row.booking,row,REVENUE_SHORT)),...group.skipped.slice().sort(byStart).map(b=>revenueOrderCard(b,null,REVENUE_SHORT))].join('');
  return '<section class="revenue-platform-boat"><h4>'+esc(revenueBoatCode(group.boat))+' <span>'+esc(group.boat.name)+'</span><small>'+(rows.length+group.skipped.length)+' 笔'+(total.size?' · 今天起 '+esc(revenueText(total,source)):'')+'</small></h4><div class="boat-booking-list">'+cards+'</div></section>';
 }).join('')+'</div>';
}
// The fleet total's platform rows; each opens to that platform's orders.
function revenuePlatforms(all,inMonth,monthLabel){
 const sources=REVENUE_SOURCES.filter(source=>revenueText(all,source)||REVENUE_ORDERS.get(source)?.size);
 if(!sources.length)return '';
 const count=source=>[...(REVENUE_ORDERS.get(source)?.values()||[])].reduce((n,group)=>n+group.rows.size+group.skipped.length,0);
 return '<div class="revenue-platforms"><div class="revenue-platform-head" aria-hidden="true"><span>平台 · 金额口径</span><span>今天起全部</span><span>'+esc(monthLabel)+'</span></div>'+sources.map(source=>
  '<details class="revenue-platform" data-source="'+esc(source)+'"'+(REVENUE_PLATFORM_OPEN.has(source)?' open':'')+'><summary><span class="revenue-platform-name">'+esc(revenueLabel(source))+'<small>'+esc(REVENUE_BASIS[source])+' · '+count(source)+(source==='tidewyn'?' 笔收入':' 笔订单')+'，点开看明细</small></span>'
  +'<span class="revenue-platform-amount">'+(esc(revenueText(all,source))||'<span class="revenue-empty">—</span>')+'</span><span class="revenue-platform-amount">'+(esc(revenueText(inMonth,source))||'<span class="revenue-empty">—</span>')+'</span></summary>'
  +revenuePlatformOrders(source,monthLabel)+'</details>').join('')+'</div>';
}
// Top of the panel: the fleet total first, folded; opening it lists each
// platform, and each platform opens to its orders.
function revenueTotal(all,inMonth,monthLabel){
 const open=document.getElementById('revenue-total')?.open===true;
 return '<details id="revenue-total" class="revenue-total"'+(open?' open':'')+'><summary><span class="revenue-total-name"><strong>各平台合计</strong><small>点开看各平台</small></span><span class="revenue-amount revenue-amount-all">'+esc(revenueCombined(all))+'<small>今天起</small></span><span class="revenue-amount revenue-amount-month">'+(esc(revenueCombined(inMonth))||'—')+'<small>'+esc(monthLabel)+'</small></span></summary>'+revenuePlatforms(all,inMonth,monthLabel)+'</details>';
}
// Inside each boat's card, folded like the order list: the boat's
// platforms added together; opening it lists each platform.
function revenueBoatDetails(boat){
 const key=revenueBoatKey(boat),item=REVENUE_BOATS.get(key);if(!item)return '';
 const note=revenueSkippedNote(item.skipped);
 if(!item.all.size)return '<div class="boat-revenue boat-revenue-none">预计收入 <span>今天起没有订单金额</span>'+note+'</div>';
 return '<details class="boat-revenue" data-boat-key="'+esc(key)+'"'+(REVENUE_OPEN.has(key)?' open':'')+'><summary>预计收入 <span class="boat-revenue-figures"><span>今天起 <strong>'+esc(revenueCombined(item.all))+'</strong></span><span>'+esc(REVENUE_SHORT)+' <strong>'+(esc(revenueCombined(item.month))||'—')+'</strong></span></span></summary>'+revenueSummary(item.all,item.month,REVENUE_LABEL)+note+'</details>';
}
function revenueDayLabel(boat,date){
 const cell=REVENUE_DAYS.get(revenueBoatKey(boat))?.get(date);if(!cell)return '';
 const parts=REVENUE_SOURCES.map(source=>revenueText(cell,source)).filter(Boolean);
 const title=REVENUE_SOURCES.filter(source=>revenueText(cell,source)).map(source=>revenueLabel(source)+' '+revenueText(cell,source)+'（'+REVENUE_BASIS[source]+'，按晚分摊）').join('；');
 return '<span class="day-revenue" title="'+esc(date+' 预计收入：'+title)+'">'+esc(parts.join(' / '))+'</span>';
}
// Runs right before the boat cards are rebuilt, so it also remembers which
// boats' revenue the viewer had opened.
function renderRevenue(){
 const body=document.getElementById('revenue-body');if(!body||!DATA)return;
 REVENUE_OPEN=new Set(Array.from(document.querySelectorAll('#boats details.boat-revenue[open]'),el=>el.dataset.boatKey));
 REVENUE_PLATFORM_OPEN=new Set(Array.from(document.querySelectorAll('#revenue-total details.revenue-platform[open]'),el=>el.dataset.source));
 const today=beijingToday(),month=months[monthIndex],first=fmt(month),last=fmt(new Date(month.getFullYear(),month.getMonth()+1,0)),from=first>today?first:today;
 const label=month.getFullYear()+'年'+(month.getMonth()+1)+'月',since=from>first?'（今天起）':'';
 REVENUE_LABEL=label+since;REVENUE_SHORT=(String(month.getFullYear())===today.slice(0,4)?'':month.getFullYear()+'年')+(month.getMonth()+1)+'月'+since;
 document.getElementById('revenue-month').textContent=label;
 document.getElementById('revenue-prev').disabled=monthIndex===0;document.getElementById('revenue-next').disabled=monthIndex===months.length-1;
 // Manual orders (no amount) are listed as not counted; the live page adds
 // them through knownOrders, not through the platform bookings.
 const manualOf=boat=>(typeof knownOrders==='function'?knownOrders(boat):[]).filter(b=>b.source==='manual'&&revenueNights(b).some(day=>day>=today));
 const all=new Map(),inMonth=new Map(),days=new Map(),boats=DATA.boats.map(boat=>{const r=revenueEntries(boat,today);return {boat,key:revenueBoatKey(boat),entries:r.entries,skipped:[...r.skipped,...manualOf(boat)],all:new Map(),month:new Map()};});
 REVENUE_DAYS=new Map();REVENUE_BOATS=new Map(boats.map(item=>[item.key,item]));
 REVENUE_ORDERS=new Map(REVENUE_SOURCES.map(source=>[source,new Map()]));
 const orderGroup=(item,source)=>{const bySource=REVENUE_ORDERS.get(source);if(!bySource.has(item.key))bySource.set(item.key,{boat:item.boat,rows:new Map(),skipped:[]});return bySource.get(item.key);};
 for(const item of boats){
  const byDay=new Map();REVENUE_DAYS.set(item.key,byDay);
  for(const entry of item.entries){
   revenueAdd(all,entry);revenueAdd(item.all,entry);
   if(!byDay.has(entry.day))byDay.set(entry.day,new Map());revenueAdd(byDay.get(entry.day),entry);
   const rows=orderGroup(item,entry.source).rows;
   if(!rows.has(entry.booking))rows.set(entry.booking,{booking:entry.booking,currency:entry.currency,all:0,month:0});
   const row=rows.get(entry.booking);row.all+=entry.minor;
   if(entry.day<from||entry.day>last)continue;
   row.month+=entry.minor;
   revenueAdd(inMonth,entry);revenueAdd(item.month,entry);
   if(!days.has(entry.day))days.set(entry.day,new Map());revenueAdd(days.get(entry.day),entry);
  }
  // Platform orders without an amount are listed in their platform too.
  for(const b of item.skipped)if(REVENUE_SOURCES.includes(b.source))orderGroup(item,b.source).skipped.push(b);
 }
 // Tidewyn Charters's own paid income: the today-on totals only (it has no dates).
 for(const direct of REVENUE_DIRECT){
  const item=REVENUE_BOATS.get(direct.boat),amount=revenueAmount(direct.amount);if(!item||!amount)continue;
  const entry={source:'tidewyn',currency:amount.currency,minor:amount.minor};
  revenueAdd(all,entry);revenueAdd(item.all,entry);
  const booking={source:'tidewyn',booking_id:direct.id,start:'',end:'',amount:direct.amount,direct:true};
  orderGroup(item,'tidewyn').rows.set(booking,{booking,currency:amount.currency,all:amount.minor,month:0});
 }
 const skipped=revenueSkippedNote(boats.flatMap(item=>item.skipped));
 if(!all.size){body.innerHTML='<p class="revenue-empty">今天及以后没有订单金额。</p>'+skipped;return;}
 // The daily detail lists only days and boats with an amount, and stays
 // folded unless the viewer opened it (kept open across refreshes).
 const shown=boats.filter(item=>item.month.size),open=document.getElementById('revenue-details')?.open===true;
 const rows=[...days.keys()].sort().map(day=>'<tr'+(day===today?' class="revenue-today"':'')+'><th scope="row">'+esc(day.slice(5))+(day===today?' <small>今天</small>':'')+'</th>'
  +shown.map(item=>{const cell=REVENUE_DAYS.get(item.key).get(day);return '<td>'+(cell?revenueLines(cell):'')+'</td>';}).join('')+'<td>'+revenueLines(days.get(day))+'</td></tr>').join('');
 body.innerHTML=revenueTotal(all,inMonth,REVENUE_LABEL)
  +(days.size?'<details id="revenue-details" class="revenue-details"'+(open?' open':'')+'><summary>按天明细 · '+days.size+' 天有收入</summary><div class="revenue-table-wrap"><table id="revenue-table"><caption class="sr-only">'+esc(label)+' 每天预计收入</caption><thead><tr><th scope="col">日期</th>'+shown.map(item=>'<th scope="col" title="'+esc(item.boat.name)+'">'+esc(revenueBoatCode(item.boat))+'</th>').join('')+'<th scope="col">当天合计</th></tr></thead><tbody>'+rows+'</tbody><tfoot><tr><th scope="row">本月合计</th>'+shown.map(item=>'<td>'+revenueLines(item.month)+'</td>').join('')+'<td>'+revenueLines(inMonth)+'</td></tr></tfoot></table></div></details>':'<p class="revenue-empty">'+esc(label)+'今天及以后没有订单金额。</p>')
  +skipped;
}
document.getElementById('revenue-prev').addEventListener('click',()=>{monthIndex=Math.max(0,monthIndex-1);renderBoats();});
document.getElementById('revenue-next').addEventListener('click',()=>{monthIndex=Math.min(months.length-1,monthIndex+1);renderBoats();});
