'use strict';
// MMK 订单（用户 2026-10-04 决定）：看板上显示 MMK 平台名、MMK 订单链接和
// MMK 自己的状态（Reservation / Option）。有客户就算有效订单，不看付款。
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const MMK_ORDER_PREFIX='https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp?reservationId=';
// NauSYS 订单（用户 2026-10-09 决定）：代理下的 Reservation / Option，链接到 NauSYS 订单列表。
const NAUSYS_ORDER_URL='https://app.nausys.com/NauSYS-app/app/yachtReservations.xhtml';
function patchMmkOrders(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 if(oldScript.includes("src==='mmk'?'MMK'"))throw Error('MMK orders already applied');
 let script=oldScript;
 const change=(a,b)=>{if(script.split(a).length!==2)throw Error('MMK orders anchor changed: '+a);script=script.replace(a,()=>b);};
 change("src==='boataround'?'Boataround':src==='clickandboat'?'Click&Boat':'SamBoat'","src==='boataround'?'Boataround':src==='clickandboat'?'Click&Boat':src==='mmk'?'MMK':src==='nausys'?'NauSYS':'SamBoat'");
 // The Booking Manager editor opens one reservation through this exact query.
 // NauSYS (2026-10-09) has no link to one reservation: its list page.
 change('const u=new URL(booking.url);',"const u=new URL(booking.url);\n if(booking.source==='mmk')return /^\\d+$/.test(String(booking.booking_id))&&booking.url==="+JSON.stringify(MMK_ORDER_PREFIX)+"+booking.booking_id&&u.protocol==='https:'&&u.hostname==='portal.booking-manager.com'&&!u.port&&!u.username&&!u.password&&!u.hash?u.href:null;\n if(booking.source==='nausys')return /^\\d+$/.test(String(booking.booking_id))&&booking.url==="+JSON.stringify(NAUSYS_ORDER_URL)+"?u.href:null;");
 // Keep MMK's and NauSYS's own state names; payment is deliberately not part of the rule.
 change('function orderStatus(b){',"function orderStatus(b){if(b.source==='mmk')return (['Reservation','Option'].includes(b.platform_status)?b.platform_status:'已接受')+' · 不看付款';if(b.source==='nausys')return (['Reservation','Option'].includes(b.platform_status)?b.platform_status:'已接受')+' · 代理订单，不看付款';");
 const next=html.replace(oldScript,()=>script);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);if(start<0||end<0)throw Error('MMK orders HTML anchor changed');
 const result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end),csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('MMK orders CSP anchor missing');
 return result.replace(csp,(_,a,b)=>a+createHash('sha256').update(script).digest('base64')+b);
}
module.exports={patchMmkOrders};
