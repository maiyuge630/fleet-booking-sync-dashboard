'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
function patchCheckoutDay(source){
 const html=extractHTML(source),old=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 let script=old;
 const replace=(a,b)=>{if(script.split(a).length!==2)throw Error('Checkout anchor changed: '+a);script=script.replace(a,()=>b);};
 // Match the registry's Beijing business day. A browser's local timezone must
 // not hide a still-current checkout or conflict, or choose a different month.
 replace('const baseMonth=new Date();',`function beijingToday(){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return parts.year+'-'+parts.month+'-'+parts.day;}
const baseMonth=new Date(beijingToday()+'T12:00:00');`);
 if(script.split('fmt(new Date())').length!==4)throw Error('Checkout business-day anchors changed');
 script=script.replaceAll('fmt(new Date())','beijingToday()');
 replace("const today=new Date(),tomorrow=new Date();tomorrow.setDate(today.getDate()+1);document.getElementById('d1').value=fmt(today);document.getElementById('d2').value=fmt(tomorrow);",
   "const today=beijingToday();document.getElementById('d1').value=today;document.getElementById('d2').value=shiftDay(today,1);");
 replace('validDate(booking.end)&&booking.start<booking.end;',
   "validDate(booking.end)&&(booking.start<booking.end||(booking.source==='samboat'&&booking.start===booking.end));");
 replace('b.end>today','b.end>=today');
 replace('end:shiftDay(booking.end,-1)','end:booking.end');
 replace('const end=shiftDay(d2,-1),nights=','const end=d2,nights=');
 replace("'<p>'+nights+' 晚内没有有效订单占用。","'<p>'+(nights+1)+' 天内没有有效订单占用。");
 replace('b.start<d2&&b.end>d1','b.start<=d2&&b.end>=d1');
 replace('退房日不计入占用','退船当天整天不可预订，次日才可用；MMK 按 14:00 上船、NauSYS 按 16:00 上船，都在 10:00 退船关档，退船当天下午可接新客');
 replace('没有其他平台的有效付款订单','没有需要保护的有效付款订单');
 replace(' 笔来源订单',' 笔有效订单（含本平台退船日）');
 // MMK and NauSYS ranges are nights (AGENTS.md 7.7): MMK boards 14:00 and
 // NauSYS 16:00 (since 2026-10-10), both return 10:00.
 const nights="(t.target==='mmk'||t.target==='nausys'?esc(R.start)+(t.target==='mmk'?' 14:00 至 ':' 16:00 至 ')+esc(R.end)+' 10:00':esc(R.start)+' 至 '+esc(shiftDay(R.end,-1))+'（含起止日）')";
 replace("esc(s.start)+' → '+esc(s.end)",nights.replaceAll('R.','s.'));
 replace("esc(b.start)+' → '+esc(b.end)+'</p>'",nights.replaceAll('R.','b.')+"+'</p>'");
 const next=html.replace(old,()=>script).replaceAll('按入住日至退房前一晚','按入住日至退船当天（含当天）');
 const begin=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',begin);
 let result=source.slice(0,begin)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 result=result.replace(/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+(')/,(_m,a,b)=>a+createHash('sha256').update(script).digest('base64')+b);
 return result;
}
module.exports={patchCheckoutDay};
