'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
function patchBoataroundPaymentWorkflow(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const from="function orderStatus(b){return b.status==='paid'?'已付款':b.status==='deposit_paid'?'已付定金':'已接受';}";
 const to="function orderStatus(b){const paid=b.status==='paid'?'已付款':b.status==='deposit_paid'?'已付定金':'已接受';const state=String(b.platform_status||'').trim().toUpperCase();return paid+(b.source==='boataround'&&['paid','deposit_paid'].includes(b.status)?state==='NEW'?' · 待确认':state==='IN PROCESS'?' · 处理中':'':'');}";
 if(oldScript.split(from).length!==2)throw Error('Boataround payment workflow UI anchor changed');
 const script=oldScript.replace(from,()=>to),next=html.replace(oldScript,()=>script);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);
 if(start<0||end<0)throw Error('Boataround payment workflow HTML anchor missing');
 const result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Boataround payment workflow CSP anchor missing');
 return result.replace(csp,(_,a,b)=>a+createHash('sha256').update(script).digest('base64')+b);
}
module.exports={patchBoataroundPaymentWorkflow};
