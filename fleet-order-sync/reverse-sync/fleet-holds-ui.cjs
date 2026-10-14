'use strict';
const fleetHoldHTML='<section id="fleet-hold-panel" class="fleet-hold-panel"><details id="fleet-hold-details"><summary>手动锁档 <span id="fleet-hold-count"></span></summary><p>选择船只和日期，向已配置的 Boataround、Click&amp;Boat、SamBoat、MMK、NauSYS 下发关档。每个平台分别核对，未配置的平台不会自动关档。</p><form id="fleet-hold-form"><div class="fleet-hold-fields"><label>船只<select id="fleet-hold-boat" name="boat" required><option value="">选择船只</option></select></label><label>开始日期<input id="fleet-hold-start" name="start" type="date" required></label><label>结束日期（含当天）<input id="fleet-hold-end" name="end" type="date" required></label></div><button id="fleet-hold-submit" type="submit">同步关档</button></form><p id="fleet-hold-message" role="status" aria-live="polite"></p><div id="fleet-hold-actions"></div><p>取消手动锁档只撤销这项保护；有效订单、其他手动锁档及平台原有人工档仍会保留。保存和取消均需等待各平台实际回读，不代表平台已关闭或已开放。</p><div id="fleet-hold-list"></div></details></section>';
const fleetHoldScript=String.raw`
let FLEET_HOLD_CONTROL=null,FLEET_HOLD_ERROR=false,FLEET_HOLD_LOADING=false,FLEET_HOLD_BUSY=false,FLEET_HOLD_PENDING=null,FLEET_HOLD_HISTORY_OPEN=false;
const FLEET_HOLD_DRAFT={boat:'',start:'',end:'',open:false},FLEET_HOLD_OPEN=new Set(),FLEET_HOLD_STORAGE='fleet-manual-holds-v1';let FLEET_HOLD_MESSAGE='';
const FLEET_HOLD_NAMES={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'};
try{const saved=JSON.parse(sessionStorage.getItem(FLEET_HOLD_STORAGE)||'null');if(saved?.draft&&['boat','start','end'].every(k=>typeof saved.draft[k]==='string'))Object.assign(FLEET_HOLD_DRAFT,{boat:saved.draft.boat,start:saved.draft.start,end:saved.draft.end,open:saved.draft.open===true});if(saved?.pending&&['add','remove'].includes(saved.pending.payload?.action)&&typeof saved.pending.payload.request_id==='string'&&Number.isInteger(saved.pending.payload.revision))FLEET_HOLD_PENDING=saved.pending;}catch{}
function saveFleetHoldDraft(){try{sessionStorage.setItem(FLEET_HOLD_STORAGE,JSON.stringify({draft:FLEET_HOLD_DRAFT,pending:FLEET_HOLD_PENDING}));}catch{}}
function fleetHoldBoatDisabled(boat){return boat==='coastline-sea-journey-42-tidewyn-cruise-2';}
function fleetHoldRecords(){return (FLEET_HOLD_CONTROL?.holds||[]).filter(h=>h&&typeof h.id==='string'&&typeof h.boat==='string'&&typeof h.active==='boolean'&&baValidDay(h.start)&&baValidDay(h.end)&&h.start<h.end);}
function fleetHoldBlocks(boat){return fleetHoldRecords().filter(h=>h.active&&h.boat===boat.boataround_slug).map(h=>({start:h.start,end:shiftDay(h.end,-1),fleet_hold:true,reason:'手动锁档',booking:null}));}
const FLEET_ORIGINAL_KNOWN_BLOCKS=knownBlocks;
knownBlocks=function(boat){return [...FLEET_ORIGINAL_KNOWN_BLOCKS(boat),...fleetHoldBlocks(boat)];};
function installFleetHoldQuery(){
 const query=window.checkAvail;window.checkAvail = function fleetHoldCheckedQuery(){
  if(!FLEET_HOLD_CONTROL||FLEET_HOLD_ERROR){const el=document.getElementById('result');el.hidden=false;el.innerHTML='<div class="query-warning">手动锁档尚未核验完整，暂不能确认可用日期。请先重新读取手动锁档设置；已有订单与锁档仍保留。</div>';return;}
  query();
 };
}
function applyFleetHoldControl(data){if(data?.ok!==true||data.version!==1||!Number.isInteger(data.revision)||data.revision<0||!Array.isArray(data.holds)||!baValidDay(data.window_start)||!baValidDay(data.window_end)||data.window_start>=data.window_end)throw Error('invalid_fleet_hold_control');if(!FLEET_HOLD_CONTROL||data.revision>=FLEET_HOLD_CONTROL.revision)FLEET_HOLD_CONTROL=data;FLEET_HOLD_ERROR=false;}
async function readFleetHoldControl(render=true){if(FLEET_HOLD_LOADING)return;FLEET_HOLD_LOADING=true;try{const {response,data}=await dashboardRequest('/api/reverse-sync/fleet-holds');if(!response.ok)throw Error('fleet_hold_read_failed');applyFleetHoldControl(data);}catch{FLEET_HOLD_ERROR=true;}finally{FLEET_HOLD_LOADING=false;if(render){renderFleetHolds();baRender();}}}
function fleetHoldPlatformState(boat,source,active=true){
 const t=REVERSE_PLAN?.targets?.find(t=>t.boat===boat&&t.target===source),name=FLEET_HOLD_NAMES[source];
 if(FLEET_HOLD_ERROR||REVERSE_ERROR||!FLEET_HOLD_CONTROL)return {source,name,kind:'error',text:'读取失败，当前平台状态未确认'};
 if(!REVERSE_PLAN)return {source,name,kind:'pending',text:'正在读取平台状态，尚未确认是否已关档'};
 if(!t||t.status==='mapping_unknown'||t.execution?.error==='mapping_unknown')return {source,name,kind:'unconfigured',text:active?'未配置，未自动关档':'未配置，取消结果未核对'};
 const e=t.execution||{},revision=FLEET_HOLD_CONTROL.revision,matching=t.fleet_hold_control?.revision===revision&&e.fleet_hold_revision===revision;
 if(matching&&e.state==='protected'&&t.fresh===true)return {source,name,kind:'confirmed',text:active?'本版已回读核对':'取消后的设置已核对；有其他保护仍会关档',checked_at:e.checked_at};
 if(matching&&e.state==='protected'&&t.fresh===false)return {source,name,kind:'historical',text:'本版曾完成回读；订单状态需重新核验',checked_at:e.checked_at};
 if(['auth_required','mmk_auth_required','nausys_auth_required','calendar_auth_unavailable'].includes(e.error))return {source,name,kind:'error',text:'平台登录已失效，尚未完成同步'};
 if(e.state==='needs_review'||e.state==='adapter_unavailable')return {source,name,kind:'error',text:'尚未完成平台核对，请查看该船跨平台档期'};
 return {source,name,kind:'pending',text:typeof PHONE_SYNC_STATUS!=='undefined'&&PHONE_SYNC_STATUS?.online===false?'手机离线，等待连接后执行':'等待手机执行和平台回读'};
}
function fleetHoldPlatformHTML(hold){return '<ul class="fleet-hold-platforms">'+Object.keys(FLEET_HOLD_NAMES).map(source=>{const s=fleetHoldPlatformState(hold.boat,source,hold.active);return '<li class="fleet-hold-'+s.kind+'"><strong>'+esc(s.name)+'</strong><span>'+esc(s.text)+(s.checked_at?' · '+esc(new Date(s.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))+' 北京时间':'')+'</span></li>';}).join('')+'</ul>';}
function fleetHoldCancellationChecked(hold){
 if(hold.active)return false;
 const configured=Object.keys(FLEET_HOLD_NAMES).map(source=>fleetHoldPlatformState(hold.boat,source,false)).filter(s=>s.kind!=='unconfigured');
 return configured.length>0&&configured.every(s=>['confirmed','historical'].includes(s.kind)&&Number.isFinite(Date.parse(s.checked_at)));
}
function fleetHoldListHTML(){
 const records=fleetHoldRecords().slice().sort((a,b)=>Number(b.active)-Number(a.active)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
 if(!records.length)return '<p>'+(!FLEET_HOLD_CONTROL?'正在读取手动锁档…':'暂无手动锁档。')+'</p>';
 const current=[],history=[];for(const h of records)(fleetHoldCancellationChecked(h)?history:current).push(h);
 const row=(h,archived=false)=>{const boat=typeof DATA!=='undefined'?DATA?.boats?.find(b=>b.boataround_slug===h.boat):null;
 return '<details class="fleet-hold-record" data-fleet-hold-id="'+esc(h.id)+'"'+(FLEET_HOLD_OPEN.has(h.id)?' open':'')+'><summary>'+esc(boat?.name||h.boat)+' · '+esc(h.start)+' 至 '+esc(shiftDay(h.end,-1))+'（含首尾） · '+(h.active?'手动锁档':archived?'已取消 · 已核对':'已取消设置 · 请查看平台回读')+'</summary>'+fleetHoldPlatformHTML(h)+(h.active?'<button type="button" class="fleet-hold-remove" data-fleet-hold-id="'+esc(h.id)+'"'+(FLEET_HOLD_BUSY||FLEET_HOLD_PENDING||FLEET_HOLD_ERROR||fleetHoldBoatDisabled(h.boat)?' disabled':'')+'>取消手动锁档</button>':'<p>这项手动锁档已取消；保留各平台结果，不据此宣称平台已开放。</p>')+'</details>';};
 return '<div id="fleet-hold-current">'+(current.length?current.map(h=>row(h)).join(''):'<p>暂无当前锁档或待处理的取消。</p>')+'</div>'+(history.length?'<details id="fleet-hold-history"'+(FLEET_HOLD_HISTORY_OPEN?' open':'')+'><summary>已取消历史 · '+history.length+' 条</summary><p>已配置平台已核对取消设置；记录留档备查。其他订单或人工保护仍可能使这些日期不可用。</p>'+history.map(h=>row(h,true)).join('')+'</details>':'');
}
function renderFleetHolds(){
 const select=document.getElementById?.('fleet-hold-boat');if(!select)return;
 const boats=typeof DATA!=='undefined'?DATA?.boats||[]:[],options='<option value="">选择船只</option>'+boats.map(b=>'<option value="'+esc(b.boataround_slug)+'"'+(fleetHoldBoatDisabled(b.boataround_slug)?' disabled':'')+'>'+esc(b.name)+(fleetHoldBoatDisabled(b.boataround_slug)?'（人工停用）':'')+'</option>').join('');
 if(select.dataset.options!==options){select.innerHTML=options;select.dataset.options=options;}
 if(document.activeElement!==select)select.value=FLEET_HOLD_DRAFT.boat;
 for(const name of ['start','end']){const input=document.getElementById('fleet-hold-'+name);if(input&&document.activeElement!==input&&input.value!==FLEET_HOLD_DRAFT[name])input.value=FLEET_HOLD_DRAFT[name];if(input&&FLEET_HOLD_CONTROL){input.min=FLEET_HOLD_CONTROL.window_start;input.max=shiftDay(FLEET_HOLD_CONTROL.window_end,-1);}}
 const details=document.getElementById('fleet-hold-details');if(details.open!==FLEET_HOLD_DRAFT.open)details.open=FLEET_HOLD_DRAFT.open;
 const button=document.getElementById('fleet-hold-submit');button.disabled=FLEET_HOLD_BUSY||!!FLEET_HOLD_PENDING||FLEET_HOLD_ERROR||!FLEET_HOLD_CONTROL||fleetHoldBoatDisabled(FLEET_HOLD_DRAFT.boat);button.textContent=FLEET_HOLD_BUSY?'正在保存…':'同步关档';
 document.getElementById('fleet-hold-count').textContent=FLEET_HOLD_CONTROL?'· '+fleetHoldRecords().filter(h=>h.active).length+' 段当前锁档':'';
 document.getElementById('fleet-hold-message').textContent=FLEET_HOLD_ERROR?'手动锁档设置读取失败，请重新读取；当前平台状态尚未确认。':FLEET_HOLD_MESSAGE||(FLEET_HOLD_PENDING?'上次保存结果尚未确认，请重试确认；不会重复新增。':'保存后由手机执行，下方分别显示各平台结果。');
 document.getElementById('fleet-hold-actions').innerHTML=(FLEET_HOLD_ERROR?'<button type="button" id="fleet-hold-reload">重新读取</button>':'')+(FLEET_HOLD_PENDING&&!FLEET_HOLD_BUSY?'<button type="button" id="fleet-hold-retry">重试确认上次请求</button>':'');
 document.getElementById('fleet-hold-list').innerHTML=fleetHoldListHTML();
}
async function submitFleetHold(action,id){
 if(FLEET_HOLD_BUSY||FLEET_HOLD_PENDING)return;
 FLEET_HOLD_DRAFT.open=true;FLEET_HOLD_MESSAGE='';
 if(!FLEET_HOLD_CONTROL||FLEET_HOLD_ERROR){FLEET_HOLD_MESSAGE='请先重新读取手动锁档设置。';renderFleetHolds();return;}
 const draft=FLEET_HOLD_DRAFT;let payload={action,revision:FLEET_HOLD_CONTROL.revision},boat=draft.boat;
 if(action==='add'){
  if(!DATA?.boats?.some(b=>b.boataround_slug===boat)||fleetHoldBoatDisabled(boat)){FLEET_HOLD_MESSAGE='请选择可使用的船只；人工停用船只不能新增锁档。';renderFleetHolds();return;}
  if(!baValidDay(draft.start)||!baValidDay(draft.end)||draft.start>draft.end){FLEET_HOLD_MESSAGE='请选择有效日期，结束日期不能早于开始日期。';renderFleetHolds();return;}
  const end=shiftDay(draft.end,1),days=(Date.parse(end+'T12:00:00Z')-Date.parse(draft.start+'T12:00:00Z'))/86400000;
  if(!baValidDay(end)||days>365||draft.start<FLEET_HOLD_CONTROL.window_start||end>FLEET_HOLD_CONTROL.window_end){FLEET_HOLD_MESSAGE='日期必须在当前可管理范围内，每段最多 365 天。';renderFleetHolds();return;}
  if(fleetHoldRecords().some(h=>h.active&&h.boat===boat&&h.start===draft.start&&h.end===end)){FLEET_HOLD_MESSAGE='已有相同的手动锁档，无需重复提交。';renderFleetHolds();return;}
  payload={...payload,boat,start:draft.start,end};
 }else if(action==='remove'){
  const hold=fleetHoldRecords().find(h=>h.id===id&&h.active);if(!hold||fleetHoldBoatDisabled(hold.boat)){FLEET_HOLD_MESSAGE='此锁档不存在或属于固定人工停用，不能取消。';renderFleetHolds();return;}boat=hold.boat;payload.id=id;
 }else return;
 try{payload.request_id=crypto.randomUUID();}catch{FLEET_HOLD_MESSAGE='浏览器无法安全创建请求，请刷新后重试。';renderFleetHolds();return;}
 FLEET_HOLD_PENDING={boat,payload};saveFleetHoldDraft();await sendFleetHoldPending();
}
async function sendFleetHoldPending(){
 if(FLEET_HOLD_BUSY||!FLEET_HOLD_PENDING)return;const pending=FLEET_HOLD_PENDING;FLEET_HOLD_BUSY=true;FLEET_HOLD_MESSAGE='正在保存设置；尚未确认平台变化…';renderFleetHolds();
 try{const {response,data}=await dashboardRequest('/api/reverse-sync/fleet-holds',pending.payload);
  if(response.status===401){window.location.replace('/login');throw Error('看板登录已过期');}
  if(response.status===202&&data?.ok===true&&data.status==='saved_pending_sync'&&Number.isInteger(data.revision)&&Array.isArray(data.holds)){
   applyFleetHoldControl({...FLEET_HOLD_CONTROL,...data,version:1});FLEET_HOLD_PENDING=null;FLEET_HOLD_MESSAGE=pending.payload.action==='add'?'手动锁档已保存。各平台是否已关档，请查看下方逐平台回读。':'取消设置已保存。各平台是否开放取决于订单和其他保护，请查看逐平台回读。';
   for(const h of fleetHoldRecords())if(h.boat===pending.boat&&((pending.payload.action==='remove'&&h.id===pending.payload.id)||(pending.payload.action==='add'&&h.start===pending.payload.start&&h.end===pending.payload.end)))FLEET_HOLD_OPEN.add(h.id);
  }else if(response.status>=400&&response.status<500){FLEET_HOLD_PENDING=null;FLEET_HOLD_MESSAGE=baHoldError(data?.error).replaceAll('人工保留','手动锁档');await readFleetHoldControl(false);}else throw Error('fleet_hold_response_uncertain');
 }catch(error){FLEET_HOLD_MESSAGE=String(error?.message).includes('登录已过期')?'看板登录已过期，请登录后重试确认。':'暂未确认请求结果。请重试确认上次请求，不要重复新增。';}
 finally{FLEET_HOLD_BUSY=false;saveFleetHoldDraft();renderFleetHolds();baRender();}
}
document.addEventListener('input',event=>{const e=event.target;if(!['fleet-hold-boat','fleet-hold-start','fleet-hold-end'].includes(e?.id))return;FLEET_HOLD_DRAFT[e.name]=e.value;FLEET_HOLD_DRAFT.open=true;saveFleetHoldDraft();});
document.addEventListener('change',event=>{const e=event.target;if(e?.id!=='fleet-hold-boat')return;FLEET_HOLD_DRAFT.boat=e.value;saveFleetHoldDraft();renderFleetHolds();});
document.addEventListener('toggle',event=>{const e=event.target;if(e?.id==='fleet-hold-details'){FLEET_HOLD_DRAFT.open=e.open;saveFleetHoldDraft();}else if(e?.id==='fleet-hold-history'){FLEET_HOLD_HISTORY_OPEN=e.open;}else if(e?.matches?.('details.fleet-hold-record')){if(e.open)FLEET_HOLD_OPEN.add(e.dataset.fleetHoldId);else FLEET_HOLD_OPEN.delete(e.dataset.fleetHoldId);}},true);
document.addEventListener('submit',event=>{if(event.target?.id!=='fleet-hold-form')return;event.preventDefault();for(const name of ['boat','start','end'])FLEET_HOLD_DRAFT[name]=event.target.elements[name].value;saveFleetHoldDraft();void submitFleetHold('add');});
document.addEventListener('click',event=>{const button=event.target?.closest?.('button');if(!button||button.disabled)return;if(button.id==='fleet-hold-reload')void readFleetHoldControl();else if(button.id==='fleet-hold-retry')void sendFleetHoldPending();else if(button.matches('.fleet-hold-remove'))void submitFleetHold('remove',button.dataset.fleetHoldId);});
`;
const fleetHoldStyles=String.raw`.fleet-hold-panel{border:1px solid #99b5c0;border-radius:12px;padding:12px 16px;margin:18px 0;color:#234354;background:#fff;min-width:0}.fleet-hold-panel summary{cursor:pointer;font-weight:700;overflow-wrap:anywhere}.fleet-hold-panel p{color:inherit;font-size:.8rem;line-height:1.6;margin:8px 0}.fleet-hold-fields{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:10px}.fleet-hold-fields label{display:grid;gap:5px;min-width:0;font-size:.8rem;color:inherit}.fleet-hold-fields input,.fleet-hold-fields select{box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:9px;border:1px solid #7795a4;border-radius:7px;background:#fff;color:#183c4c;font:inherit}.fleet-hold-panel button{font:inherit;font-size:.8rem;padding:8px 12px;border:1px solid #176577;border-radius:7px;background:#176577;color:#fff;margin-top:8px;max-width:100%;white-space:normal}.fleet-hold-panel button:disabled{opacity:.6;cursor:not-allowed}.fleet-hold-record{border-top:1px solid #b9cbd3;padding:10px 0;font-size:.8rem}.fleet-hold-platforms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;list-style:none;padding:0;margin:8px 0}.fleet-hold-platforms li{border:1px solid #9db3bd;border-radius:7px;padding:8px;overflow-wrap:anywhere;line-height:1.5;background:#f4f8fa;color:#244554}.fleet-hold-platforms strong,.fleet-hold-platforms span{display:block}.fleet-hold-platforms .fleet-hold-confirmed{border-color:#558677;background:#e9f5ef;color:#174635}.fleet-hold-platforms .fleet-hold-error,.fleet-hold-platforms .fleet-hold-unconfigured{border-color:#b2792f;background:#fff3d6;color:#56340d}.fleet-hold-platforms .fleet-hold-historical{border-style:dashed}.fleet-hold-panel .fleet-hold-remove{background:transparent;color:#145b6c;border-color:#7b9eaa}@media(max-width:600px){.fleet-hold-fields,.fleet-hold-platforms{grid-template-columns:minmax(0,1fr)}}@media(prefers-color-scheme:dark){.fleet-hold-panel{color:#e6f2f7;background:#1a303c;border-color:#7393a3}.fleet-hold-fields input,.fleet-hold-fields select{color:#e8f4f8;background:#173441;border-color:#91adba;color-scheme:dark}.fleet-hold-panel button{color:#14353f;background:#b8e5ef;border-color:#b8e5ef}.fleet-hold-panel .fleet-hold-remove{color:#b8e5ef;background:transparent;border-color:#8caebb}.fleet-hold-record{border-color:#708e9b}.fleet-hold-platforms li{background:#233e4b;color:#e4f1f7;border-color:#819eaa}.fleet-hold-platforms .fleet-hold-confirmed{background:#163f35;color:#d6f9e7;border-color:#8cceb3}.fleet-hold-platforms .fleet-hold-error,.fleet-hold-platforms .fleet-hold-unconfigured{background:#48351c;color:#ffe7b6;border-color:#d7ad69}}`;
module.exports={fleetHoldHTML,fleetHoldScript,fleetHoldStyles};
