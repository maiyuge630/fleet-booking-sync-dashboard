'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const presentation=String.raw`
function captureVoltageView(){
 const nodes=Array.from(document.querySelectorAll('#boats details.boat-voltage'));
 return {expanded:new Set(nodes.filter(node=>node.open).map(node=>node.dataset.boatKey)),focused:nodes.find(node=>node.querySelector('summary')===document.activeElement)?.dataset.boatKey||null};
}
function restoreVoltageFocus(view){
 if(!view.focused)return;
 const node=Array.from(document.querySelectorAll('#boats details.boat-voltage')).find(node=>node.dataset.boatKey===view.focused);
 node?.querySelector('summary')?.focus({preventScroll:true});
}
function boatVoltage(boat,view){
 // AD3 telemetry was removed from the dashboard at the owner's request; AD3
 // has no 安智连 device (AD6 is Lightcat's, 2026-10-10).
 if(boat.boataround_slug==='bluecat-42-tidewyn-discovery-3')return '';
 const state=DATA?.order_sync?.voltage,d=state?.devices?.find(d=>d.boat===boat.boataround_slug);
 if(!d)return '<div class="boat-voltage voltage-empty" aria-label="船只电压">电压<br>暂无数据</div>';
 const stale=!state.last_success_at||!Number.isFinite(Date.parse(state.last_success_at))||Date.now()-Date.parse(state.last_success_at)>36*3600000||Date.parse(state.last_success_at)>Date.now()+600000;
 const offline=!d.online||d.motion_state==='offline',old=stale||!!state.error_code||offline;
 const warning=d.low_voltage||d.power==='power_off'||d.power==='backup_low'||d.power==='unknown'||d.volts===null;
 const power={normal:'电源正常',power_off:'外接电源断开',backup_low:'外接断电／备用电量低',unknown:'电源状态未知'}[d.power]||'电源状态未知';
 const status=offline?'设备离线':d.low_voltage?'电压过低':power;
 const value=d.volts===null?'无读数':Number(d.volts).toFixed(2)+' V';
 const error={auth_required:'安智连登录已失效',root_unavailable:'手机读取权限不可用',fetch_failed:'安智连读取失败',schema_changed:'安智连数据格式变化',incomplete_pages:'安智连数据不完整'}[state.error_code]||'本次同步未成功';
 const key=String(boat.boataround_slug||boat.name);
 const movement=offline?'静止时间 · 离线':d.motion_state==='stationary'?'静止 '+(d.stationary_time||'未取得'):d.motion_state==='moving'?'行驶中':'静止时间 · 暂无';
 const stationary=offline?'静止时间：'+(d.stationary_time||'未取得')+'（平台记录；设备离线，非当前状态）':d.motion_state==='stationary'?'静止时间：'+d.stationary_time+'（采集时）':d.motion_state==='moving'?'行驶中，无当前静止时长。':'静止时间：尚未取得';
 return '<details class="boat-voltage'+(warning||old?' voltage-warning':'')+'" data-boat-key="'+esc(key)+'"'+(view?.expanded.has(key)?' open':'')+' aria-label="船只电压"><summary><span class="voltage-reading"><small>电压</small><strong>'+esc(value)+'</strong></span><span class="voltage-status">'+esc((old&&!offline?'历史 · ':'')+movement)+'</span><span class="voltage-status">'+esc((old?'历史 · ':'')+status)+' <span aria-hidden="true">⌄</span></span></summary><div class="voltage-popover">'+(old?'<p><strong>历史读数 · 非实时</strong></p>':'')+'<p>安智连设备：'+esc(d.code)+' · 每日同步一次</p>'+(old?'<p class="voltage-alert">'+esc(offline?'设备离线，无法确认当前电压。':state.error_code?error+'，保留上次读数。':'超过 36 小时未成功同步，请检查手机连接。')+'</p>':'')+'<p class="stationary-detail">'+esc(stationary)+'</p><p>采集时间：'+esc(beijingRefreshTime(state.last_success_at))+'</p><p>设备最后通信：'+esc(d.source_time||'未记录')+'（安智连原始时间）</p></div></details>';
}
`;
const styles=String.raw`
.boat-head{position:relative;align-items:flex-start}.boat-voltage{position:relative;flex:0 0 auto;max-width:138px;margin-left:auto;border:1px solid #689889;border-radius:8px;background:#effaf4;color:#163c2a;min-width:0;overflow-wrap:anywhere}
.boat-voltage>summary{display:block;list-style:none;padding:7px 9px;cursor:pointer}.boat-voltage>summary::-webkit-details-marker{display:none}.boat-voltage>summary:focus-visible{outline:3px solid currentColor;outline-offset:3px;border-radius:8px}.voltage-reading{display:flex;align-items:baseline;justify-content:flex-end;gap:5px;flex-wrap:wrap;line-height:1.3}.voltage-reading small{font-size:.6875rem}.voltage-reading strong{font-size:1rem;font-variant-numeric:tabular-nums}.voltage-status{display:block;text-align:right;font-size:.6875rem;line-height:1.5;margin-top:3px;font-weight:650}.voltage-warning{background:#fff3e1;color:#57310b;border-color:#b77b27}.voltage-empty{padding:8px 10px;font-size:.6875rem;text-align:right}
.voltage-popover{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:min(300px,calc(100vw - 76px));box-sizing:border-box;padding:12px 14px;background:#effaf4;color:inherit;border:1px solid currentColor;border-radius:8px;box-shadow:0 6px 18px #0002}.boat-voltage p{margin:5px 0;color:inherit;font-size:.75rem;line-height:1.7}.voltage-alert{font-weight:700}.voltage-warning .voltage-popover{background:#fff3e1}
@media(max-width:420px){.boat-head{gap:7px}.boat-voltage{max-width:110px}.boat-voltage>summary{padding:6px 7px}.voltage-reading strong{font-size:.875rem}.boat-head .boat-number{width:30px;height:34px;flex:0 0 30px;font-size:.75rem}.boat-head h3{font-size:.875rem}}
@media(prefers-color-scheme:dark){.boat-voltage{background:#173429;color:#e3ffef;border-color:#629b7d}.voltage-warning{background:#3e2c18;color:#ffebcb;border-color:#b98c54}.voltage-popover{background:#173429}.voltage-warning .voltage-popover{background:#3e2c18}}
`;
function patchVoltage(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1],oldStyle=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 if(oldScript.includes('function boatVoltage('))throw Error('Voltage patch already applied');
 const anchor="+'</div></div><div class=\"source-tags\">'+tags";
 if(oldScript.split(anchor).length!==2)throw Error('Boat voltage insertion anchor changed');
 const expanded="const expanded=new Set(Array.from(document.querySelectorAll('#boats details.boat-bookings[open]'),el=>el.dataset.boatKey));";
 if(oldScript.split(expanded).length!==2)throw Error('Boat details state anchor changed');
 let script=oldScript.replace('function renderBoats(){',presentation+'\nfunction renderBoats(){').replace(anchor,"+'</div>'+boatVoltage(boat,voltageView)+'</div><div class=\"source-tags\">'+tags").replace(expanded,expanded+'\n const voltageView=captureVoltageView();');
 const renderStart=script.indexOf('function renderBoats(){'),renderEnd=script.indexOf('\nfunction ',renderStart),render=script.slice(renderStart,renderEnd),finish=" }).join('');\n}";
 if(renderEnd<0||render.split(finish).length!==2)throw Error('Boat rendering completion anchor changed');
 script=script.slice(0,renderStart)+render.replace(finish," }).join('');\n restoreVoltageFocus(voltageView);\n}")+script.slice(renderEnd);
 const style=oldStyle+styles,next=html.replace(oldScript,()=>script).replace(oldStyle,()=>style);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);
 if(start<0||end<0)throw Error('HTML anchor missing');
 let result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('CSP anchor missing');
 return result.replace(csp,(_,a,b,c)=>a+createHash('sha256').update(script).digest('base64')+b+createHash('sha256').update(style).digest('base64')+c);
}
module.exports={patchVoltage};
