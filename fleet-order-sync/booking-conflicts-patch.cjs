'use strict';

const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const {BOOKING_CONFLICTS_SCRIPT}=require('./booking-conflicts.cjs');

const conflictsCSS=String.raw`
/* Conflict foregrounds and surfaces form one palette in each system theme. */
:root{--conflict-bg:#fff7f7;--conflict-panel:#fff1f2;--conflict-soft:#ffebed;--conflict-text:#3b1520;--conflict-muted:#713745;--conflict-link:#8f1732;--conflict-border:#b42332;--conflict-divider:#d78f94;--conflict-badge-bg:#ffe0e4;--conflict-badge-text:#86212d;--conflict-day-bg:#ffdce0;--conflict-day-text:#86212d;--conflict-button-bg:#9f1239;--conflict-button-hover:#800f2e;--conflict-button-text:#ffffff}
@media(prefers-color-scheme:dark){:root{--conflict-bg:#321d25;--conflict-panel:#3b202b;--conflict-soft:#492833;--conflict-text:#fff4f6;--conflict-muted:#f1ccd4;--conflict-link:#ffc2ce;--conflict-border:#ff8ca0;--conflict-divider:#a85c70;--conflict-badge-bg:#ffb3c2;--conflict-badge-text:#4d0a1c;--conflict-day-bg:#702139;--conflict-day-text:#fff2f5;--conflict-button-bg:#ffb3c2;--conflict-button-hover:#ffccda;--conflict-button-text:#4d0a1c}}
.booking-conflicts,.booking-conflicts-overview{border:1px solid var(--conflict-divider);border-left:4px solid var(--conflict-border);border-radius:10px;background:var(--conflict-panel);color:var(--conflict-text);padding:14px;margin:16px 0;overflow-wrap:anywhere;scroll-margin-top:20px}
.booking-conflicts:target{outline:3px solid var(--conflict-border);outline-offset:3px}
.booking-conflicts h4,.booking-conflicts-overview strong{font-size:.9375rem;line-height:1.5;margin:0;font-weight:700}
.booking-conflicts p{font-size:.75rem;line-height:1.65;margin:6px 0 10px;color:var(--conflict-muted)}
.booking-conflicts a,.booking-conflicts a:visited,.booking-conflicts-overview a,.booking-conflicts-overview a:visited{color:var(--conflict-link);text-decoration:underline;text-underline-offset:3px;font-weight:650}
.booking-conflicts ul{list-style:none;padding:0;margin:0}.booking-conflicts li{padding:12px 0;border-top:1px solid var(--conflict-divider)}.booking-conflicts li:last-child{padding-bottom:0}
.booking-conflict-dates{display:block;font-size:.8125rem;line-height:1.65;font-variant-numeric:tabular-nums}
.booking-conflict-links,.booking-conflict-navigation{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:.8125rem;line-height:1.7;margin-top:6px}.booking-conflict-links a,.booking-conflict-navigation a{display:inline-block;padding:5px 0;max-width:100%}.booking-conflict-link-issue{font-size:.75rem;font-weight:400}
.boat-booking.boat-booking-conflict{border:1px solid var(--conflict-divider);border-left:4px solid var(--conflict-border);border-radius:10px;background:var(--conflict-bg);color:var(--conflict-text);padding:12px;margin-top:12px}.boat-booking.boat-booking-conflict:last-child{padding-bottom:12px}
.boat-booking-conflict .boat-booking-heading{flex-wrap:wrap;gap:8px}
.boat-booking-conflict .boat-booking-platform,.boat-booking-conflict .boat-booking-dates strong,.boat-booking-conflict .boat-booking-money strong{color:var(--conflict-text)}
.boat-booking-conflict .boat-booking-status,.boat-booking-conflict .boat-booking-dates small,.boat-booking-conflict .boat-date-arrow,.boat-booking-conflict .boat-booking-money small,.boat-booking-conflict .order-link-issue{color:var(--conflict-muted)}
.boat-booking-conflict .boat-booking-dates{background:var(--conflict-soft)}
.booking-conflict-badge{display:inline-block;color:var(--conflict-badge-text);background:var(--conflict-badge-bg);border:1px solid var(--conflict-divider);border-radius:4px;font-size:.6875rem;line-height:1.6;padding:1px 5px;margin-left:6px;font-weight:700}
.boat-booking-conflict .order-detail-link,.boat-booking-conflict .order-detail-link:visited{color:var(--conflict-button-text);background:var(--conflict-button-bg);border-color:var(--conflict-border)}
.boat-booking-conflict .order-detail-link:hover{background:var(--conflict-button-hover)}
.cal td.b.booking-conflict-day{background:var(--conflict-day-bg)!important;color:var(--conflict-day-text);box-shadow:inset 0 0 0 2px var(--conflict-border)}
.cal td.booking-conflict-day a,.cal td.booking-conflict-day a:visited,.cal td.booking-conflict-day .day-status{color:var(--conflict-day-text);font-weight:750}
.cal td.booking-conflict-day a:focus-visible,.booking-conflicts a:focus-visible,.booking-conflicts-overview a:focus-visible,.boat-booking-conflict .order-detail-link:focus-visible{outline:3px solid var(--conflict-border);outline-offset:3px}
@media(max-width:640px){.booking-conflicts,.booking-conflicts-overview{padding:12px}.booking-conflict-links{align-items:flex-start}.booking-conflict-links a{overflow-wrap:anywhere}}
`;

const conflictPresentation=String.raw`
function bookingConflictAnchor(boat){return 'booking-conflicts-'+Array.from(String(boat.boataround_slug||boat.name)).map(character=>character.codePointAt(0).toString(16)).join('-');}
function boatBookingConflicts(boat){return findBookingConflicts(boat.bookings,fmt(new Date()));}
function dashboardBookingConflicts(boat){const all=boatBookingConflicts(boat),pairs=all.pairs.filter(pair=>pair.nights>=2);return {pairs,bookingKeys:[...new Set(pairs.flatMap(pair=>pair.bookings.map(bookingIdentity)))]};}
function bookingHandover(pair){const [a,b]=pair.bookings;return pair.nights===1&&(a.end===pair.start&&b.start===pair.start||b.end===pair.start&&a.start===pair.start);}
function calendarBookingConflicts(boat){const all=boatBookingConflicts(boat),pairs=all.pairs.filter(pair=>!bookingHandover(pair));return {pairs,bookingKeys:[...new Set(pairs.flatMap(pair=>pair.bookings.map(bookingIdentity)))]};}
function bookingConflictOrderLink(booking){const url=orderURL(booking),label=esc(srcLabel(booking.source)+' #'+booking.booking_id);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" aria-label="查看 '+label+' 订单详情">'+label+' ↗</a>':'<span>'+label+' <span class="booking-conflict-link-issue">（详情链接待核实）</span></span>';}
function bookingConflictNotice(boat,conflicts){if(!conflicts.pairs.length)return boatBookingConflicts(boat).pairs.length?'<span id="'+esc(bookingConflictAnchor(boat))+'"></span>':'';return '<section class="booking-conflicts" id="'+esc(bookingConflictAnchor(boat))+'" tabindex="-1" aria-label="'+esc(boat.name+' 疑似撞单')+'"><h4>疑似撞单 · '+esc(conflicts.pairs.length)+' 组重叠</h4><p>同一艘船的有效订单日期重叠，请核对双方订单和实际排船。</p><ul>'+conflicts.pairs.map(pair=>{const lastNight=shiftDay(pair.end,-1),dates=pair.start===lastNight?pair.start:pair.start+' 至 '+lastNight;return '<li><strong class="booking-conflict-dates">重叠日期：'+esc(dates)+' · '+esc(pair.nights)+' 天</strong><div class="booking-conflict-links">'+pair.bookings.map(bookingConflictOrderLink).join('<span aria-hidden="true">与</span>')+'</div></li>';}).join('')+'</ul></section>';}
function renderBookingConflictOverview(){const node=document.getElementById('booking-conflicts-overview'),boats=DATA.boats.map(boat=>({boat,conflicts:dashboardBookingConflicts(boat)})).filter(item=>item.conflicts.pairs.length);node.hidden=!boats.length;node.innerHTML=boats.length?'<strong>疑似撞单 · '+esc(boats.length)+' 艘船 · '+esc(boats.reduce((sum,item)=>sum+item.conflicts.pairs.length,0))+' 组重叠</strong><nav class="booking-conflict-navigation" aria-label="查看疑似撞单船只">'+boats.map(item=>'<a href="#'+esc(bookingConflictAnchor(item.boat))+'">'+esc(item.boat.name)+' · '+esc(item.conflicts.pairs.length)+' 组</a>').join('')+'</nav>':'';}
`;

function patchBookingConflicts(source){
 const html=extractHTML(source),originalScript=html.match(/<script>([\s\S]*?)<\/script>/)?.[1],originalStyle=html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
 if(!originalScript||!originalStyle||originalScript.includes('function findBookingConflicts('))throw Error('Expected dashboard without conflict presentation');
 let script=originalScript;
 function replaceScript(from,to){if(script.split(from).length!==2)throw Error('Booking conflict script anchor changed: '+from.slice(0,120));script=script.replace(from,()=>to);}
 // A changeover (one order's checkout day is the next one's first day) is no
 // overlap (user rule 2026-10-09); the calendar painted AD5's 10-24 red until
 // 2026-10-13. Any other one-day overlap, such as a SamBoat day trip inside a
 // longer charter, is still marked in the calendar.
 replaceScript('function calendar(boat,month){',BOOKING_CONFLICTS_SCRIPT+'\n'+conflictPresentation+'\nfunction calendar(boat,month,conflicts=calendarBookingConflicts(boat)){');
 replaceScript("const date=fmt(new Date(month.getFullYear(),month.getMonth(),day)),status=map.get(date),label=status?'不可用':'可用',booking=status?.booking,url=booking&&orderURL(booking),title=booking?srcLabel(booking.source)+' #'+booking.booking_id+' '+booking.start+' → '+booking.end:date+' '+label;", "const date=fmt(new Date(month.getFullYear(),month.getMonth(),day)),pairs=conflicts.pairs.filter(pair=>pair.start<=date&&date<pair.end),conflict=pairs.length>0,status=map.get(date),label=status||conflict?'不可用':'可用',booking=status?.booking,url=booking&&orderURL(booking),title=conflict?date+' 不可用 · 疑似撞单 · '+pairs.map(pair=>pair.bookings.map(b=>srcLabel(b.source)+' #'+b.booking_id).join(' 与 ')).join('；'):booking?srcLabel(booking.source)+' #'+booking.booking_id+' '+booking.start+' → '+booking.end:date+' '+label;");
 replaceScript("(status?'b':'d')+(date===today?' today':'')", "(status||conflict?'b':'d')+(conflict?' booking-conflict-day':'')+(date===today?' today':'')");
 replaceScript("date+' '+label+(date===today?' 今天':'')", "date+' '+label+(conflict?' 疑似撞单':'')+(date===today?' 今天':'')");
 replaceScript("(url?'<a href=\"'+esc(url)+'\" target=\"_blank\" rel=\"noopener noreferrer\" aria-label=\"'+esc(title)+'\">'+day+'</a>':day)", "(conflict?'<a href=\"#'+esc(bookingConflictAnchor(boat))+'\" aria-label=\"'+esc(date+' 不可用，疑似撞单，查看双方订单')+'\">'+day+'</a>':url?'<a href=\"'+esc(url)+'\" target=\"_blank\" rel=\"noopener noreferrer\" aria-label=\"'+esc(title)+'\">'+day+'</a>':day)");
 replaceScript("(status?'<span class=\"day-status\">订</span>':'')", "(status||conflict?'<span class=\"day-status\">'+(conflict?'撞':'订')+'</span>':'')");
 replaceScript("const expanded=new Set(Array.from(document.querySelectorAll('#boats details.boat-bookings[open]'),el=>el.dataset.boatKey));", "const expanded=new Set(Array.from(document.querySelectorAll('#boats details.boat-bookings[open]'),el=>el.dataset.boatKey));\n renderBookingConflictOverview();");
 replaceScript("const rows=knownOrders(boat).sort((a,b)=>a.start.localeCompare(b.start)||String(a.booking_id).localeCompare(String(b.booking_id)));", "const rows=knownOrders(boat).sort((a,b)=>a.start.localeCompare(b.start)||String(a.booking_id).localeCompare(String(b.booking_id))),conflicts=dashboardBookingConflicts(boat),conflictKeys=new Set(conflicts.bookingKeys);");
 replaceScript('const url=orderURL(b),action=', 'const conflict=conflictKeys.has(bookingIdentity(b)),url=orderURL(b),action=');
 replaceScript("'<article class=\"boat-booking\" data-booking-id=\"'", "'<article class=\"boat-booking'+(conflict?' boat-booking-conflict':'')+'\" data-booking-id=\"'");
 replaceScript("esc(orderStatus(b))+'</span></div><div class=\"boat-booking-dates\">", "esc(orderStatus(b))+(conflict?'<strong class=\"booking-conflict-badge\">疑似撞单</strong>':'')+'</span></div><div class=\"boat-booking-dates\">");
 replaceScript("calendar(boat,months[monthIndex])+'<details class=\"boat-bookings\"", "calendar(boat,months[monthIndex],calendarBookingConflicts(boat))+bookingConflictNotice(boat,conflicts)+'<details class=\"boat-bookings\"");
 const style=originalStyle+conflictsCSS,boatsAnchor='<div class="boats" id="boats">';
 if(html.split(boatsAnchor).length!==2)throw Error('Booking conflict overview anchor changed');
 const nextHTML=html.replace(originalScript,()=>script).replace(originalStyle,()=>style).replace(boatsAnchor,'<aside class="booking-conflicts-overview" id="booking-conflicts-overview" aria-label="疑似撞单总览" hidden></aside>\n'+boatsAnchor);
 const htmlStart=source.indexOf('var HTML = '),loginStart=source.indexOf('var LOGIN_HTML = ',htmlStart);
 let result=source.slice(0,htmlStart)+'var HTML = '+JSON.stringify(nextHTML)+';\n'+source.slice(loginStart);
 const cspPattern=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(cspPattern.source,'g'))?.length!==1)throw Error('Booking conflict dashboard CSP anchor changed');
 result=result.replace(cspPattern,(_match,prefix,middle,suffix)=>prefix+createHash('sha256').update(script).digest('base64')+middle+createHash('sha256').update(style).digest('base64')+suffix);
 if(extractHTML(result)!==nextHTML)throw Error('Booking conflict dashboard serialization changed');
 return result;
}

module.exports={patchBookingConflicts};
