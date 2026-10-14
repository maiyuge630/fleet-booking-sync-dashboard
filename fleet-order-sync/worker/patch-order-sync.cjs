'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

function patchOrderSync(source) {
  if (typeof source !== 'string' || source.includes('function createOrderRegistry(')) throw new Error('Expected the unpatched verified Worker source');
  function replaceOnce(oldText, newText) {
    const start = source.indexOf(oldText);
    if (start < 0 || source.indexOf(oldText,start+oldText.length)>=0) throw new Error('Unexpected Worker source at '+oldText.slice(0,100));
    source=source.slice(0,start)+newText+source.slice(start+oldText.length);
  }
  // SamBoat also sells day trips with the same real check-in/check-out date.
  // Keep that source date instead of inventing a next-day checkout. Other
  // platforms retain their existing overnight-date validation.
  replaceOnce('if (!validDay(start) || !validDay(end) || end <= start)',
    "if (!validDay(start) || !validDay(end) || end < start || (end === start && source !== 'samboat'))");
  replaceOnce("const allowedStatuses = source === 'boataround' ?",
    "const allowedStatuses = ['boataround', 'samboat'].includes(source) ?");
  // MMK is the fourth order source since 2026-10-04 (user decision). Its
  // reservation link opens the Booking Manager editor on that reservation.
  // NauSYS is the fifth since 2026-10-09; it has no link to one reservation,
  // so its orders link to NauSYS's reservation list.
  const sources = "['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys']";
  replaceOnce("if (!['boataround', 'clickandboat', 'samboat'].includes(source)) throw new Error('订单来源无效');",
    "if (!"+sources+".includes(source)) throw new Error('订单来源无效');");
  replaceOnce("if (!['boataround', 'clickandboat', 'samboat'].includes(record?.source)) continue;",
    "if (!"+sources+".includes(record?.source)) continue;");
  replaceOnce("for (const source of ['boataround', 'clickandboat', 'samboat']) {",
    "for (const source of "+sources+") {");
  replaceOnce("const host = source === 'boataround' ? 'partner.boataround.com' : source === 'clickandboat' ? 'www.clickandboat.com' : 'www.samboat.com';",
    "const host = source === 'boataround' ? 'partner.boataround.com' : source === 'clickandboat' ? 'www.clickandboat.com' : source === 'mmk' ? 'portal.booking-manager.com' : source === 'nausys' ? 'app.nausys.com' : 'www.samboat.com';\n      const search = source === 'mmk' ? `?reservationId=${booking_id}` : '';");
  replaceOnce("const pathname = source === 'boataround' ? `/en/000000000000000000000000/orders/${detail_id}` : source === 'clickandboat' ? `/uk/booking/${booking_id}/detail` : `/private/reservation/${booking_id}`;",
    "const pathname = source === 'boataround' ? `/en/000000000000000000000000/orders/${detail_id}` : source === 'clickandboat' ? `/uk/booking/${booking_id}/detail` : source === 'mmk' ? '/wbm2/app/my_bookings/editor.jsp' : source === 'nausys' ? '/NauSYS-app/app/yachtReservations.xhtml' : `/private/reservation/${booking_id}`;");
  replaceOnce("parsed.pathname !== pathname || parsed.search || parsed.hash || parsed.username || parsed.password || record.url !== `https://${host}${pathname}`)",
    "parsed.pathname !== pathname || parsed.search !== search || parsed.hash || parsed.username || parsed.password || record.url !== `https://${host}${pathname}${search}`)");
  // The eighth boat (user decision 2026-10-09): Lightcat 400 S2 (Tidewyn
  // Discovery 6), only on NauSYS. Its slug is the fleet identity, not a
  // Boataround listing, so no platform calendar is read for it.
  replaceOnce('{"name":"Tidewyn Discovery 5 (Grandcat 55)","boataround_slug":"grandcat-55-tidewyn-discovery-5","clickandboat_id":100007,"samboat_id":null}];',
    '{"name":"Tidewyn Discovery 5 (Grandcat 55)","boataround_slug":"grandcat-55-tidewyn-discovery-5","clickandboat_id":100007,"samboat_id":null},{"name":"Tidewyn Discovery 6 (Lightcat 400 S2)","boataround_slug":"lightcat-400-s2-tidewyn-discovery-6","clickandboat_id":null,"samboat_id":null,"boataround":false}];');
  replaceOnce('if (!spec[idField]) continue;','if (!spec[idField] || spec[source] === false) continue;');
  replaceOnce('if (!boat[idField]) continue;','if (!boat[idField] || boat[source] === false) continue;');
  // Show MMK's and NauSYS's own state (Reservation or Option) on the order card.
  replaceOnce("  if (source === 'boataround') {\n    booking.detail_id = detail_id;",
    "  if (['mmk', 'nausys'].includes(source) && ['Reservation', 'Option'].includes(record.platform_status)) booking.platform_status = record.platform_status;\n  if (source === 'boataround') {\n    booking.detail_id = detail_id;");
  let moduleSource=fs.readFileSync(path.join(__dirname,'dynamic-registry.cjs'),'utf8');
  moduleSource=moduleSource.replace(/^'use strict';\s*/,'').replace(/^module\.exports = .*;\s*$/m,'');
  const script=`const form=document.getElementById('sync-form'),input=document.getElementById('snapshot-json'),result=document.getElementById('sync-result'),button=document.getElementById('submit-sync');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;result.textContent='正在验证并保存…';try{const payload=JSON.parse(input.value);const response=await fetch('/api/order-sync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(response.status===401){window.location.replace('/login');return;}const data=await response.json();if(!response.ok)throw new Error(data.error||'订单同步失败');result.textContent=JSON.stringify(data,null,2);}catch(error){result.textContent=error.message;}finally{button.disabled=false;}});`;
  const style=`:root{color-scheme:light dark;font-family:"Segoe UI",system-ui,sans-serif;color:#203541;background:#f1f5f7}body{margin:0;padding:28px 18px}main{max-width:900px;margin:auto;background:#fff;border:1px solid #bdcdd6;border-radius:16px;padding:24px}h1{margin-top:0;font-size:1.5rem}p{line-height:1.7;color:#526773}label{display:block;font-weight:650;margin:18px 0 8px}textarea{box-sizing:border-box;width:100%;min-height:340px;font:13px/1.5 monospace;padding:12px;border:1px solid #6e8593;border-radius:8px}button,a{font:inherit}button{margin-top:14px;min-height:48px;padding:10px 18px;background:#176674;color:white;border:0;border-radius:9px;font-weight:650;cursor:pointer}a{color:#176674}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eaf1f4;padding:16px;border-radius:8px}button:disabled{opacity:.55}button:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #176674;outline-offset:3px}@media(prefers-color-scheme:dark){:root{color:#e1ebf0;background:#142129}main{background:#1b2d38}p{color:#b3c4ce}a{color:#9cd3db}pre{background:#263c49}}`;
  const page=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>订单同步维护 · Tidewyn Charters</title><style>${style}</style></head><body><main><a href="/">返回船队订单看板</a><h1>订单同步维护</h1><p>提交已经核验的五平台订单快照（Boataround、Click&amp;Boat、SamBoat、MMK、NauSYS）。每个平台必须包含完整船队范围、日期范围和分页证据。失败平台保留上次订单。此维护入口本身不会启用定时自动同步。</p><form id="sync-form"><label for="snapshot-json">完整订单快照 JSON</label><textarea id="snapshot-json" spellcheck="false" required></textarea><button id="submit-sync" type="submit">验证并保存订单快照</button></form><pre id="sync-result" role="status" aria-live="polite">等待提交。</pre></main><script>${script}</script></body></html>`;
  const hash=value=>createHash('sha256').update(value).digest('base64');
  const csp=`default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`;
  const glue=`
var ORDER_SYNC_HTML = ${JSON.stringify(page)};
var ORDER_SYNC_CSP = ${JSON.stringify(csp)};
function orderRegistry(env) {
  return createOrderRegistry({bucket:env.BUCKET,normalizeBooking,fleetSpecs:FLEET_SPECS,bootstrapMap:BOOKING_MAP});
}
// Called only inside this Worker/DO execution context. This is not an HTTP
// bypass and creates no unauthenticated route or new login secret. A verified
// future alarm/browser runtime can invoke it directly after collection.
async function applyTrustedOrderSnapshots(env,payload) {
  return orderRegistry(env).ingestBatch(payload);
}
async function readOrderSyncBody(request) {
  if (Number(request.headers.get('Content-Length'))>ORDER_SYNC_MAX_BYTES) throw Object.assign(new Error('订单快照过大'),{status:413});
  const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('缺少订单快照'),{status:400});
  const chunks=[];let length=0,complete=false,rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const abort=()=>rejectStop(Object.assign(new Error('订单快照上传已中断'),{status:408}));
  const timer=setTimeout(()=>rejectStop(Object.assign(new Error('读取订单快照超时，请重试'),{status:408})),15000);
  request.signal.addEventListener('abort',abort,{once:true});
  try{
    if(request.signal.aborted)throw Object.assign(new Error('订单快照上传已中断'),{status:408});
    while(true){const {done,value}=await Promise.race([reader.read(),stopped]);if(done){complete=true;break;}length+=value.byteLength;if(length>ORDER_SYNC_MAX_BYTES)throw Object.assign(new Error('订单快照过大'),{status:413});chunks.push(value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw Object.assign(new Error('订单快照必须是有效JSON'),{status:400});}
  }finally{
    clearTimeout(timer);request.signal.removeEventListener('abort',abort);
    if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();
  }
}
async function orderSyncRoute(request,env) {
  if(request.method!=='POST')return json({error:'请使用POST提交订单快照'},405,{Allow:'POST'});
  if(!sameOrigin(request)||request.headers.get('Sec-Fetch-Site')!=='same-origin')return json({error:'请从已登录的本站同步维护页提交'},403);
  if((request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'订单快照必须使用JSON格式'},415);
  try{const receipt=await applyTrustedOrderSnapshots(env,await readOrderSyncBody(request));return json(receipt,receipt.results.every(result=>result.accepted)?200:207);}
  catch(error){return json({error:error.message||'订单同步暂不可用'},error.status||503);}
}
`;
  replaceOnce('var SOURCE_IDS =',moduleSource+'\n'+glue+'\nvar SOURCE_IDS =');
  const mergeStart=source.indexOf('function mergeSnapshot(data) {'),readStart=source.indexOf('async function readData(env)',mergeStart);
  if(mergeStart<0||readStart<0)throw new Error('Fleet read path was not found');
  const merge=source.slice(mergeStart,readStart);
  if(!merge.includes('return applyBookingRegistry(result);'))throw new Error('Expected static registry application in mergeSnapshot');
  source=source.slice(0,mergeStart)+merge.replace('return applyBookingRegistry(result);','return result;')+source.slice(readStart);
  replaceOnce('  return mergeSnapshot(file ? await file.json() : SEED);',
    '  const data = mergeSnapshot(file ? await file.json() : SEED);\n  const registry = orderRegistry(env);\n  const result = applyBookingRegistry(data, await registry.registry());\n  result.order_sync = await registry.status();\n  return result;');
  replaceOnce("  await env.BUCKET.put(CACHE_KEY, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });\n  return data;",
    "  await env.BUCKET.put(CACHE_KEY, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });\n  return readData(env);");
  const routeStart=source.indexOf('var server_default = {');
  const routeText=source.slice(routeStart);
  const anchor='    const url = new URL(request.url);';
  if(routeStart<0||!routeText.includes(anchor))throw new Error('Authenticated route dispatcher was not found');
  const routeInsertion=`    const url = new URL(request.url);
    if (url.pathname === '/sync') {
      if (!['GET','HEAD'].includes(request.method)) return json({error:'不支持的请求方式'},405,{Allow:'GET, HEAD'});
      return new Response(request.method==='HEAD'?null:ORDER_SYNC_HTML,{headers:{...SECURITY_HEADERS,'Content-Security-Policy':ORDER_SYNC_CSP,'Content-Type':'text/html; charset=utf-8'}});
    }
    if (url.pathname === '/api/order-sync') return orderSyncRoute(request,env);`;
  source=source.slice(0,routeStart)+routeText.replace(anchor,routeInsertion);
  return source;
}

module.exports={patchOrderSync};
