'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
// This is a presentation warning, not the much shorter write authorization
// window. Match the existing three-hour schedule plus receipt grace period.
const QUERY_DATA_MAX_AGE_MS=(3*60+15)*60000;
const helpers=String.raw`
function queryDataIssues(now=Date.now()){
 return ['boataround','clickandboat','samboat','mmk','nausys'].flatMap(source=>{
  const state=DATA?.order_sync?.platforms?.[source],value=state?.last_success_at;
  const at=typeof value==='string'&&value.trim()?Date.parse(value):NaN;
  const reason=state?.last_error&&state.last_error!=='awaiting_first_sync'?'最近同步失败':
   !Number.isFinite(at)?'尚无成功同步记录':at>now+60000?'同步时间异常':
   state?.mode!=='dynamic'?'尚未完成全量订单核验':now-at>QUERY_DATA_MAX_AGE_MS?'数据已过期':null;
  return reason?[{source,reason,last_success_at:Number.isFinite(at)?value:null}]:[];
 });
}
function queryDataNotice(issues){
 if(!issues.length)return '';
 return '<aside class="query-warning query-data-warning" role="status"><strong>档期数据待更新，请立即同步后确认</strong><p>以下平台尚未取得可靠的最新结果；当前查询依据已保存订单，新订单或取消可能尚未反映。</p><ul>'+issues.map(item=>'<li>'+esc(srcLabel(item.source))+'：'+esc(item.reason)+'；最近成功：'+esc(item.last_success_at?syncTime(item.last_success_at):'尚未成功同步')+'</li>').join('')+'</ul></aside>';
}
`;
function patchOrderQueryFreshness(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1],oldStyle=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 let script=oldScript;
 const replace=(a,b)=>{if(script.split(a).length!==2)throw Error('Query freshness anchor changed: '+a);script=script.replace(a,()=>b);};
 replace('window.checkAvail=function(){','const QUERY_DATA_MAX_AGE_MS='+QUERY_DATA_MAX_AGE_MS+';\n'+helpers+'\nwindow.checkAvail=function(){');
 replace('let freeCount=0,busyCount=0;','const queryIssues=queryDataIssues();\n let freeCount=0,busyCount=0;');
 replace("label='可用';body='<p>'+(nights+1)+' 天内没有有效订单占用。</p>';","label='可用';body='<p>'+(nights+1)+' 天内没有有效订单占用。</p>'+(queryIssues.length?'<p class=\"query-warning query-data-caution\"><strong>数据待更新，请同步后确认。</strong><br>当前“可用”仅依据已保存订单。</p>':'');");
 replace("el.innerHTML='<p class=\"result-heading\">'","el.innerHTML=queryDataNotice(queryIssues)+'<p class=\"result-heading\">'");
 // Re-evaluate the saved snapshot's age even when the refresh request fails;
 // otherwise a result opened before expiry can stay green indefinitely.
 replace('if(hasQuery)window.checkAvail();','');
 replace('finally{ORDER_SYNC_LOADING=false;updateSyncButton();scheduleSyncStatus();}','finally{ORDER_SYNC_LOADING=false;updateSyncButton();if(hasQuery&&DATA)window.checkAvail();scheduleSyncStatus();}');
 const style=oldStyle+'\n.query-data-warning{margin-bottom:14px;border:1px solid currentColor}.query-data-warning p{margin:6px 0}.query-data-warning ul{margin:6px 0 0;padding-left:20px}.result-card .query-data-caution{color:var(--unavail-text);line-height:1.6}';
 const next=html.replace(oldScript,()=>script).replace(oldStyle,()=>style),start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);
 if(start<0||end<0)throw Error('Query freshness HTML anchor missing');
 let result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Query freshness CSP anchor missing');
 return result.replace(csp,(_,a,b,c)=>a+createHash('sha256').update(script).digest('base64')+b+createHash('sha256').update(style).digest('base64')+c);
}
module.exports={patchOrderQueryFreshness,QUERY_DATA_MAX_AGE_MS};
