'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const manualHTML=`<section id="manual-order-panel" class="fleet-hold-panel"><details id="manual-order-details"><summary>手动订单 <span id="manual-order-count"></span></summary><p>登记 WhatsApp、微信或其他渠道的已收款订单。保存后出现在对应船只的订单明细，并让手机向已配置的平台同步关档。</p><form id="manual-order-form"><div class="fleet-hold-fields manual-order-fields"><label>船只<select name="boat" required><option value="">选择船只</option></select></label><label>订单名称／客户称呼<input name="name" maxlength="100" placeholder="例如：WhatsApp · 王先生" required></label><label>订单来源<input name="channel" maxlength="60" value="WhatsApp" list="manual-order-channels" required><datalist id="manual-order-channels"><option value="WhatsApp"><option value="微信"><option value="电话"><option value="线下"><option value="其他渠道"></datalist></label><label>开始日期<input name="start" type="date" required></label><label>结束日期（含当天）<input name="end" type="date" required></label><label>已确认收款<select name="payment_status" required><option value="">请选择收款状态</option><option value="deposit_paid">已收定金</option><option value="paid">已收全款</option></select></label></div><p>开始日和结束日都占用，次日恢复可用。请核实已收款后添加；日期或名称填错可取消后重新登记。</p><button id="manual-order-submit" type="submit" disabled>保存订单并同步关档</button></form><p id="manual-order-message" role="status" aria-live="polite"></p><div id="manual-order-actions"></div><details id="manual-order-history"><summary id="manual-order-history-count">已结束与已取消</summary><div id="manual-order-history-list"></div></details></details></section>`;
const manualStyle=`.manual-order-fields{grid-template-columns:repeat(3,minmax(0,1fr))}.manual-order-card{overflow-wrap:anywhere}.manual-order-channel,.manual-order-note{font-size:.8rem;color:inherit;margin:6px 0 12px}.manual-order-sync{margin:10px 0;font-size:.8rem}.manual-order-sync summary{cursor:pointer;font-weight:650}.manual-order-card button{font:inherit;font-size:.8rem;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;padding:8px 12px;margin:5px 0;cursor:pointer}.manual-order-card button:disabled{opacity:.55;cursor:not-allowed}.manual-order-confirm{border:1px solid currentColor;border-radius:8px;padding:10px;margin-top:10px}.manual-order-confirm p{font-size:.8rem;color:inherit}.manual-order-card.boat-booking-conflict .manual-order-channel,.manual-order-card.boat-booking-conflict .manual-order-note{color:var(--conflict-muted)}#manual-order-history{margin-top:14px;padding-top:12px;border-top:1px solid #8ea8b4}@media(max-width:640px){.manual-order-fields{grid-template-columns:minmax(0,1fr)}}`;
function patchManualOrders(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1],oldStyle=html.match(/<style>([\s\S]*?)<\/style>/)[1];let script=oldScript;
 const change=(a,b)=>{if(script.split(a).length!==2)throw Error('Manual order anchor changed: '+a);script=script.replace(a,()=>b);};
 change('rows.map(b=>{','rows.map(b=>{\n   if(b.source===\'manual\')return manualOrderCard(b,conflictKeys.has(bookingIdentity(b)));');
 change("function srcLabel(src){return src==='boataround'", "function srcLabel(src){return src==='manual'?'手动订单':src==='boataround'");
 change(".map(h=>({start:h.start,end:shiftDay(h.end,-1),fleet_hold:true,reason:'手动锁档',booking:null}))", '.map(h=>manualOrderBlock(h))');
 change('const orders=activeBookings(boat).filter(', 'const orders=knownOrders(boat).filter(');
 change("orders.map(b=>'<div class=\"occLine\">'", "orders.map(b=>b.source==='manual'?manualOrderQueryRow(b):'<div class=\"occLine\">'");
 change('s.causes.map(c=>esc(c))', 's.causes.map(c=>esc(manualOrderCause(c)))');
 change('+t.segments.map(s=>', '+manualOrderTargetNote(t)+t.segments.map(s=>');
 change('renderFleetHolds();if(document.activeElement', 'renderManualOrders();renderFleetHolds();if(document.activeElement');
 change("document.getElementById('queryBtn').disabled=false;render();", "await readManualOrders(false);document.getElementById('queryBtn').disabled=false;render();");
 change('function fleetHoldListHTML(){', "function standaloneFleetHolds(){return fleetHoldRecords().filter(h=>!(FLEET_HOLD_CONTROL?.manual_order_ids||[]).includes(h.id));}\nfunction fleetHoldListHTML(){");
 change('const records=fleetHoldRecords().slice().sort(', 'const records=standaloneFleetHolds().slice().sort(');
 change("fleetHoldRecords().filter(h=>h.active).length+' 段当前锁档'", "standaloneFleetHolds().filter(h=>h.active).length+' 段当前锁档'");
 // The shared collision routine is serialized into the dashboard; include
 // one-day external orders without changing platform parser acceptance.
 change("end === start && booking.source !== 'samboat'", "end === start && !['samboat','manual'].includes(booking.source)");
 change('initialize();',fs.readFileSync(path.join(__dirname,'manual-orders-ui.js'),'utf8')+'\ninitialize();');
 const style=oldStyle+manualStyle,next=html.replace(oldScript,()=>script).replace(oldStyle,()=>style).replace('<section id="fleet-hold-panel"',manualHTML.replace('开始日和结束日都占用，次日恢复可用。','开始日和结束日都计入占用。')+'\n<section id="fleet-hold-panel"');
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);if(start<0||end<0)throw Error('Manual HTML anchor changed');
 const result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end),csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Manual CSP anchor missing');
 return result.replace(csp,(_,a,b,c)=>a+createHash('sha256').update(script).digest('base64')+b+createHash('sha256').update(style).digest('base64')+c);
}
module.exports={patchManualOrders,manualHTML};
