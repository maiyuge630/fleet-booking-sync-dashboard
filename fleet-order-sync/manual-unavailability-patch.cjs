'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
// Dashboard-only owner instruction. Never add artificial orders to the registry
// or feed these dates into external platform reverse-sync plans.
const closures=[{boat:'coastline-sea-journey-42-tidewyn-cruise-2',start:'2026-09-19',end:'2030-12-31',reason:'人工停用'}];
function patchManualUnavailability(source){
 const html=extractHTML(source),old=html.match(/<script>([\s\S]*?)<\/script>/)[1];let script=old;
 function replace(a,b){if(script.split(a).length!==2)throw Error('Manual availability anchor changed: '+a);script=script.replace(a,()=>b);}
 const helpers=`const DASHBOARD_CLOSURES=${JSON.stringify(closures)};
function manualClosures(boat){return DASHBOARD_CLOSURES.filter(b=>b.boat===boat.boataround_slug);}
function manualClosureNotice(boat){return manualClosures(boat).map(b=>'<p class="query-warning"><strong>人工停用 · 不可用</strong><br>'+esc(b.start)+' 至 '+esc(b.end)+'（含当天）</p>').join('');}
`;
 replace('function knownBlocks(boat){return activeBookings(boat).map(booking=>({start:booking.start,end:booking.end,booking}));}',helpers+'function knownBlocks(boat){return [...manualClosures(boat),...activeBookings(boat).map(booking=>({start:booking.start,end:booking.end,booking}))];}');
 replace("(conflict?'撞':'订')","(conflict?'撞':status?.booking?'订':status?.fleet_hold?'手锁':'停')");
 replace("body='<p class=\"conflict\">所选日期已有 '","body=manualClosureNotice({boataround_slug:manualClosures(boat).some(b=>b.start<=d2&&b.end>=d1)?boat.boataround_slug:''})+'<p class=\"conflict\">所选日期已有 '");
 replace("'+boatReverse(boat)+''+calendar(","'+manualClosureNotice(boat)+boatReverse(boat)+''+calendar(");
 script=script.replaceAll('连续订单日期','连续不可用日期').replaceAll(' 起该连续订单结束',' 起该连续占用结束');
 const next=html.replace(old,()=>script),begin=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',begin);
 let result=source.slice(0,begin)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 result=result.replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+(')/,(_m,a,b)=>a+createHash('sha256').update(script).digest('base64')+b);
 return result;
}
module.exports={patchManualUnavailability,closures};
