'use strict';
const {createHash}=require('node:crypto');
const {extractHTML}=require('../../cloudflare-migration/frontend-patch.cjs');
const {fleetHoldHTML,fleetHoldScript,fleetHoldStyles}=require('./fleet-holds-ui.cjs');
const presentation=String.raw`
let REVERSE_PLAN=null,REVERSE_LOADING=false,REVERSE_READ_AT=0,REVERSE_ERROR=false;
let BA_CONTROL=null,BA_CONTROL_LOADING=false,BA_CONTROL_ERROR=false,BA_HOLD_BUSY=false,BA_HOLD_PENDING=null,BA_HOLD_RENDER_DEFERRED=false;
const BA_HOLD_FORMS=new Map(),BA_HOLD_STORAGE='fleet-boataround-hold-drafts-v1';
function baValidDay(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
function baForm(boat){if(!BA_HOLD_FORMS.has(boat))BA_HOLD_FORMS.set(boat,{start:'',end:'',open:false,message:''});return BA_HOLD_FORMS.get(boat);}
function baSaveDrafts(){try{sessionStorage.setItem(BA_HOLD_STORAGE,JSON.stringify({forms:[...BA_HOLD_FORMS].map(([boat,f])=>[boat,{start:f.start,end:f.end,open:f.open}]),pending:BA_HOLD_PENDING}));}catch{}}
try{const saved=JSON.parse(sessionStorage.getItem(BA_HOLD_STORAGE)||'null');for(const [boat,f] of saved?.forms||[])if(typeof boat==='string'&&f&&typeof f.start==='string'&&typeof f.end==='string')BA_HOLD_FORMS.set(boat,{start:f.start,end:f.end,open:f.open===true,message:''});const p=saved?.pending;if(p&&typeof p.boat==='string'&&p.payload&&['add','remove'].includes(p.payload.action)&&typeof p.payload.request_id==='string'&&Number.isInteger(p.payload.revision))BA_HOLD_PENDING=p;}catch{}
function baControl(t){
 const own=t?.boataround_control;if(!own||own.version!==1||!Number.isInteger(own.revision)||!Array.isArray(own.holds))return null;
 if(BA_CONTROL&&BA_CONTROL.revision>=own.revision)return {...BA_CONTROL,enabled:own.enabled===true,holds:BA_CONTROL.holds.filter(h=>h.boat===t.boat)};
 const globalIds=new Set((t?.fleet_hold_control?.holds||[]).map(h=>h.id));
 return {...own,holds:own.holds.filter(h=>!globalIds.has(h.id))};
}
function baActiveHolds(control){return (control?.holds||[]).filter(h=>h.active===true&&typeof h.id==='string'&&baValidDay(h.start)&&baValidDay(h.end)&&h.start<h.end);}
function baApplyControl(data){
 if(data?.ok!==true||data.version!==1||data.enabled!==true||!Number.isInteger(data.revision)||data.revision<0||!Array.isArray(data.holds)||!baValidDay(data.window_start)||!baValidDay(data.window_end)||data.window_start>=data.window_end)throw Error('invalid_hold_control');
 if(!BA_CONTROL||data.revision>=BA_CONTROL.revision)BA_CONTROL=data;
 BA_CONTROL_ERROR=false;
}
function baRender(){if(typeof DATA!=='undefined'&&DATA)renderBoats();}
async function readBoataroundControl(render=true){
 if(BA_CONTROL_LOADING)return;BA_CONTROL_LOADING=true;
 try{const {response,data}=await dashboardRequest('/api/reverse-sync/boataround-holds');if(!response.ok)throw Error('hold_read_failed');baApplyControl(data);}
 catch{BA_CONTROL_ERROR=true;}
 finally{BA_CONTROL_LOADING=false;if(render)baRender();}
}
function baHoldText(t,control){
 if(control?.enabled===false)return '人工停用规则保留；只保留既有档期，不代表平台全时段已核验关档。';
 if(BA_CONTROL_ERROR)return '人工保留设置读取失败，请重新读取；当前平台状态尚未确认。';
 const e=t.execution||{};
 if(e.state==='protected'&&t.fresh===true&&e.boataround_control_revision===control?.revision)return '最近回读已核对这一版设置；平台实际保护日期以回读结果为准。';
 if(e.state==='protected'&&t.fresh===false&&e.boataround_control_revision===control?.revision)return '这一版设置曾完成平台回读；订单状态需重新核验，下次同步会重新检查。';
 if(e.boataround_control_revision===control?.revision)return '这一版设置的最新平台状态尚未确认，下次同步会重新核对。';
 return '设置待手机执行并回读确认；手机离线时等待恢复连接。云端保存不代表平台已关档。';
}
function baReconcileHoldNotice(t,control){
 const form=baForm(t.boat);if(form.notice!=='saved')return;
 if(BA_CONTROL_ERROR){form.message='人工保留设置读取失败，请重新读取；当前平台状态尚未确认。';return;}
 const sameRevision=t.execution?.boataround_control_revision===control?.revision&&control.revision>=form.saved_revision;
 if(sameRevision&&t.execution?.state==='protected'&&t.fresh===false){form.message='这一版设置曾完成平台回读；订单状态需重新核验，下次同步会重新检查。';return;}
 if(sameRevision&&(t.execution?.state!=='protected'||t.fresh!==true)){form.message='这一版设置的最新平台状态尚未确认，下次同步会重新核对。';return;}
 const confirmed=!BA_CONTROL_ERROR&&t.execution?.state==='protected'&&t.fresh===true&&t.execution.boataround_control_revision===control?.revision&&control.revision>=form.saved_revision;
 form.message=confirmed?(form.saved_action==='remove'?'当前自动管理设置已完成平台回读核对；有有效订单的日期仍会关档。':'当前人工保留设置已完成平台回读核对。'):(form.saved_action==='remove'?'已恢复自动管理，等待手机重新核对；有有效订单的日期仍会关档。':'人工保留已保存，等待手机执行和平台回读。');
}
function baHoldRows(t,control){
 const blocked=BA_HOLD_BUSY||!!BA_HOLD_PENDING,ready=control.enabled===true&&!!BA_CONTROL&&!BA_CONTROL_ERROR;
 return baActiveHolds(control).map(h=>'<li><span>'+esc(h.start)+' 至 '+esc(shiftDay(h.end,-1))+'（含首尾）'+(h.locked?'<small>人工停用 · 不可移除'+(h.release_only?' · 仅保留既有档期':'')+'</small>':'')+'</span>'+(!h.locked&&control.enabled?'<button type="button" class="ba-hold-remove" data-ba-hold-boat="'+esc(t.boat)+'" data-ba-hold-id="'+esc(h.id)+'"'+(blocked||!ready?' disabled':'')+'>恢复自动管理</button>':'')+'</li>').join('');
}
function baHoldAuxActions(boat){return (BA_CONTROL_ERROR?'<button type="button" class="ba-hold-reload">重新读取设置</button>':'')+(BA_HOLD_PENDING?.boat===boat&&!BA_HOLD_BUSY?'<button type="button" class="ba-hold-retry" data-ba-hold-boat="'+esc(boat)+'">重试确认上次保存</button>':'');}
function reverseExecutionWithTime(t){return reverseExecutionText(t)+(t.execution?.checked_at?' · '+new Date(t.execution.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' 北京时间':'');}
function refreshReverseLiveState(){
 // Refresh receipt/status siblings while leaving native date input nodes intact.
 for(const node of document.querySelectorAll('[data-reverse-execution-boat]')){
  const t=REVERSE_PLAN?.targets?.find(t=>t.boat===node.dataset.reverseExecutionBoat&&t.target===node.dataset.reverseExecutionTarget);
  node.textContent=t?reverseExecutionWithTime(t):'预览读取失败，尚未确认当前回读结果';
 }
 for(const detail of document.querySelectorAll('details.ba-holds')){
  const t=REVERSE_PLAN?.targets?.find(t=>t.boat===detail.dataset.boatKey&&t.target==='boataround'),control=baControl(t),state=detail.querySelector('.ba-hold-state'),button=detail.querySelector('button[type="submit"]');
  if(!t||!control){if(state)state.textContent='设置读取失败，尚未确认当前平台状态。';if(button)button.disabled=true;continue;}
  baReconcileHoldNotice(t,control);const form=baForm(t.boat),holds=baActiveHolds(control);
  if(state)state.textContent=baHoldText(t,control);
  const summary=detail.querySelector('summary'),list=detail.querySelector('.ba-hold-list'),empty=detail.querySelector('.ba-hold-empty'),message=detail.querySelector('.ba-hold-message'),actions=detail.querySelector('.ba-hold-actions');
  if(summary)summary.textContent='人工保留'+(holds.length?' · '+holds.length+' 段':'');
  if(list)list.innerHTML=baHoldRows(t,control);if(empty)empty.hidden=holds.length>0;
  if(message)message.textContent=form.message||(BA_HOLD_PENDING?.boat===t.boat?'上次保存结果尚未确认，请重试确认；不会重复新增。':'');
  if(actions)actions.innerHTML=baHoldAuxActions(t.boat);
  if(button){button.disabled=control.enabled!==true||!BA_CONTROL||BA_CONTROL_ERROR||BA_HOLD_BUSY||!!BA_HOLD_PENDING;button.textContent=BA_HOLD_BUSY&&BA_HOLD_PENDING?.boat===t.boat?'正在保存…':'保存人工保留';}
 }
}
function boataroundHolds(t){
 const control=baControl(t);if(!control)return '';
 baReconcileHoldNotice(t,control);
 const form=baForm(t.boat),holds=baActiveHolds(control),pending=BA_HOLD_PENDING,ownPending=pending?.boat===t.boat;
 const blocked=BA_HOLD_BUSY||!!pending,enabled=control.enabled===true,ready=enabled&&!!BA_CONTROL&&!BA_CONTROL_ERROR;
 const dates=baHoldRows(t,control);
 return '<details class="ba-holds" data-boat-key="'+esc(t.boat)+'"'+(form.open?' open':'')+'><summary>人工保留'+(holds.length?' · '+holds.length+' 段':'')+'</summary><div class="ba-hold-content"><p class="ba-hold-state">'+esc(baHoldText(t,control))+'</p><ul class="ba-hold-list">'+dates+'</ul><p class="ba-hold-empty"'+(holds.length?' hidden':'')+'>暂无人工保留日期。</p>'+(enabled?'<p>新版托管档期可随订单自动开关；需持续关档的日期请在这里保留。原有人工档不接管。</p><form class="ba-hold-form" data-ba-hold-boat="'+esc(t.boat)+'"><div class="ba-hold-dates"><label>开始日期<input type="date" name="start" required value="'+esc(form.start)+'"'+(BA_CONTROL?.window_start?' min="'+esc(BA_CONTROL.window_start)+'"':'')+(BA_CONTROL?.window_end?' max="'+esc(shiftDay(BA_CONTROL.window_end,-1))+'"':'')+(blocked?' disabled':'')+'></label><label>结束日期（含当天）<input type="date" name="end" required value="'+esc(form.end)+'"'+(BA_CONTROL?.window_start?' min="'+esc(BA_CONTROL.window_start)+'"':'')+(BA_CONTROL?.window_end?' max="'+esc(shiftDay(BA_CONTROL.window_end,-1))+'"':'')+(blocked?' disabled':'')+'></label></div><button type="submit"'+(!ready||blocked?' disabled':'')+'>'+(BA_HOLD_BUSY&&ownPending?'正在保存…':'保存人工保留')+'</button></form><p>恢复自动管理不会强制开放；仍有有效订单的日期会继续关档。每段最多 365 天。</p>':'')+'<div class="ba-hold-actions">'+baHoldAuxActions(t.boat)+'</div><p class="ba-hold-message" role="status" aria-live="polite">'+esc(form.message||(ownPending?'上次保存结果尚未确认，请重试确认；不会重复新增。':''))+'</p></div></details>';
}
function legacyBoataroundHolds(t){
 const control=baControl(t),holds=baActiveHolds(control);if(!control||(!holds.length&&BA_HOLD_PENDING?.boat!==t.boat&&baForm(t.boat).notice!=='saved'))return '';
 baReconcileHoldNotice(t,control);const form=baForm(t.boat);
 return '<details class="ba-holds" data-boat-key="'+esc(t.boat)+'"'+(form.open?' open':'')+'><summary>旧 Boataround 保留 · '+holds.length+' 段</summary><p>这些旧设置只影响 Boataround。新手动锁档请使用看板上方入口，不会把旧设置自动升级为四平台锁档。</p><p class="ba-hold-state">'+esc(baHoldText(t,control))+'</p><ul class="ba-hold-list">'+baHoldRows(t,control)+'</ul><p class="ba-hold-empty"'+(holds.length?' hidden':'')+'>暂无旧 Boataround 保留。</p><p>恢复自动管理不会强制开放；有有效订单或其他保护的日期仍会关档。</p><div class="ba-hold-actions">'+baHoldAuxActions(t.boat)+'</div><p class="ba-hold-message" role="status" aria-live="polite">'+esc(form.message)+'</p></details>';
}
function baHoldError(code){const labels={hold_invalid_dates:'日期无效，请检查开始和结束日期。',hold_outside_window:'日期超出当前可管理范围，请重新选择。',hold_limit:'人工保留数量已达上限，请先整理已有记录。',boat_manually_disabled:'这艘船已人工停用，不能在此修改。',hold_revision_conflict:'设置已被其他操作更新，请核对最新保留日期后再保存。',hold_not_found:'这条人工保留已不存在，请核对最新设置。',hold_locked:'这条记录为固定人工停用，不能移除。',invalid_hold_request:'设置未被接受，请检查输入后重试。',hold_request_conflict:'上次请求内容不一致，请重新读取设置后核对。',hold_identity_conflict:'记录标识与已有设置冲突，请重新读取后重新提交。'};return Object.hasOwn(labels,code)?labels[code]:'保存未被接受；已有设置保留，请重新读取后核对。';}
async function baSubmitHold(boat,action,id){
 if(BA_HOLD_BUSY||BA_HOLD_PENDING)return;
 const target=REVERSE_PLAN?.targets?.find(t=>t.boat===boat&&t.target==='boataround'),control=baControl(target),form=baForm(boat);form.open=true;form.notice=null;
 if(!control?.enabled||!BA_CONTROL||BA_CONTROL_ERROR){form.message='尚未读取可修改的保留设置，请重新读取。';baRender();return;}
 let payload={action,revision:BA_CONTROL.revision};
 if(action==='add'){
  if(!baValidDay(form.start)||!baValidDay(form.end)||form.start>form.end){form.message='请选择有效的开始和结束日期，结束日期不能早于开始日期。';baRender();return;}
  const end=shiftDay(form.end,1),days=(Date.parse(end+'T12:00:00Z')-Date.parse(form.start+'T12:00:00Z'))/86400000;
  if(!baValidDay(end)||days>365){form.message='每段人工保留最多 365 天，请缩短日期范围。';baRender();return;}
  if(!baValidDay(BA_CONTROL.window_start)||!baValidDay(BA_CONTROL.window_end)||form.start<BA_CONTROL.window_start||end>BA_CONTROL.window_end){form.message='日期超出当前可管理范围，请重新选择。';baRender();return;}
  if(baActiveHolds(control).some(h=>h.start===form.start&&h.end===end)){form.message='这些日期已有相同的人工保留，无需重复添加。';baRender();return;}
  payload={...payload,boat,start:form.start,end};
 }else if(action==='remove'){
  const hold=baActiveHolds(control).find(h=>h.id===id);if(!hold||hold.locked){form.message=hold?.locked?'固定人工停用不能移除。':'这条保留已不存在，请重新读取。';baRender();return;}
  payload.id=id;
 }else return;
 try{payload.request_id=crypto.randomUUID();}catch{form.message='浏览器无法安全创建保存请求，请刷新页面后重试。';baRender();return;}
 BA_HOLD_PENDING={boat,payload};baSaveDrafts();await baSendPending();
}
async function baSendPending(){
 if(BA_HOLD_BUSY||!BA_HOLD_PENDING)return;const pending=BA_HOLD_PENDING,form=baForm(pending.boat);BA_HOLD_BUSY=true;form.notice=null;form.message='正在保存，尚未确认平台变化…';baRender();
 try{
  const {response,data}=await dashboardRequest('/api/reverse-sync/boataround-holds',pending.payload);
  if(response.status===401){window.location.replace('/login');throw Error('看板登录已过期，请重新登录。');}
  if(response.status===202&&data?.ok===true&&data.status==='saved_pending_sync'&&Number.isInteger(data.revision)&&Array.isArray(data.holds)){
   baApplyControl({...BA_CONTROL,...data,version:1,enabled:true});BA_HOLD_PENDING=null;
   form.notice='saved';form.saved_revision=data.revision;form.saved_action=pending.payload.action;
   form.message=pending.payload.action==='add'?'人工保留已保存，等待手机执行和平台回读。':'已恢复自动管理，等待手机重新核对；有有效订单的日期仍会关档。';
  }else if(response.status>=400&&response.status<500){BA_HOLD_PENDING=null;form.message=baHoldError(data?.error);await readBoataroundControl(false);}
  else throw Error('hold_response_unconfirmed');
 }catch(error){form.message=String(error?.message).includes('登录已过期')?'看板登录已过期，请重新登录后重试确认。':'暂未确认保存结果。请重试确认上次保存；手机离线不等于已执行。';}
 finally{BA_HOLD_BUSY=false;baSaveDrafts();baRender();}
}
document.addEventListener('input',event=>{const input=event.target,form=input?.closest?.('form.ba-hold-form');if(!form||!['start','end'].includes(input.name))return;const draft=baForm(form.dataset.baHoldBoat);draft[input.name]=input.value;draft.open=true;baSaveDrafts();});
document.addEventListener('toggle',event=>{const detail=event.target;if(detail?.matches?.('details.ba-holds')){baForm(detail.dataset.boatKey).open=detail.open;baSaveDrafts();}},true);
document.addEventListener('focusout',event=>{if(event.target?.matches?.('.ba-hold-form input'))setTimeout(()=>{if(BA_HOLD_RENDER_DEFERRED)baRender();},0);});
document.addEventListener('submit',event=>{const form=event.target;if(!form?.matches?.('form.ba-hold-form'))return;event.preventDefault();const draft=baForm(form.dataset.baHoldBoat);draft.start=form.elements.start.value;draft.end=form.elements.end.value;baSaveDrafts();void baSubmitHold(form.dataset.baHoldBoat,'add');});
document.addEventListener('click',event=>{const button=event.target?.closest?.('button');if(!button||button.disabled)return;if(button.matches('.ba-hold-remove'))void baSubmitHold(button.dataset.baHoldBoat,'remove',button.dataset.baHoldId);else if(button.matches('.ba-hold-retry')&&BA_HOLD_PENDING?.boat===button.dataset.baHoldBoat)void baSendPending();else if(button.matches('.ba-hold-reload'))void readBoataroundControl();});
function reverseExecutionText(t){
 const e=t.execution||{},states={protected:'最近核对：所需日期已关档',protected_partial:'已按现有订单设为不可预订；部分平台订单未更新，暂不恢复可预订',stale:'核对已过期或来源异常，待重新同步',needs_review:'需核对，未确认完成',deferred:'待下轮执行',adapter_unavailable:'尚未接通',removal_requires_verification:'旧保护保留，开放需核对'};
 const control=t.target==='boataround'?baControl(t):null;
 if(control?.enabled&&e.boataround_control_revision!==control.revision)return '保留设置待手机执行和平台回读，尚未确认本版已生效';
 if(e.state==='protected')return t.segments?.length||t.source_count||baActiveHolds(control).some(h=>!h.release_only)?states.protected:'最近核对：无待关闭日期';
 if(e.state==='protected_partial'){const names={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'},list=(e.stale_sources||[]).map(s=>names[s]||s).join('、');return states.protected_partial+(list?'（'+list+' 订单未更新）':'');}
 const login='登录已失效，请在'+(t.target==='clickandboat'?'手机管理页的专用浏览器':'手机 Chrome')+'中先尝试保存的密码登录，再立即同步';
 const labels={mmk_auth_required:login,auth_required:login,calendar_auth_unavailable:login,
  source_changed_or_stale:'订单数据已变化或核验过期，请立即同步后重新核对档期',mapping_unknown:'船只映射待核对，尚未自动写入',
  coverage_unverified:'部分日期尚未核实关档，保留已有保护并等待核对',mmk_account_mismatch:'MMK 登录账号与配置不符，已停止写入',
  target_identity_unverified:'尚未确认目标船只，已停止写入',execution_budget_exhausted:'本轮档期核验超时，保留已有保护，可立即同步重试',
  platform_timeout:'平台响应超时，保留已有保护，可立即同步重试',
  platform_challenge:'平台要求人工完成访问验证，程序无法自动通过。请在手机远程桌面的专用浏览器中完成验证；已有保护保留',executor_cancelled:'本轮档期核验中断，保留已有保护，等待重新同步',cb_app_day_before_record:'Click&Boat 最少租期挡住了这一天：下一段档前放不下最少租期，客人订不了，App 也不让设为不可预订。程序没写入，不用手动处理',
  reverse_plan_unavailable:'手机读取云端订单计划时网络中断，重试后仍未完成核对；已有档期保留，可立即同步重试',
  mmk_editor_unavailable:'MMK 订单页面未准备好，请稍后立即同步重试',plan_clock_invalid:'设备时间异常，校时后需重新同步',
  mmk_availability_unverified:'MMK 可预订状态未核实，已暂停写入',mmk_dates_not_available:'MMK 日期已有占用，需核对现有记录',
  mmk_calendar_changed:'MMK 日历已变化，需重新核对',mmk_owned_record_changed:'MMK 同步记录被修改，已保留并暂停自动处理',
  mmk_partial_write_requires_review:'MMK 写入结果未完整确认，保留记录待核对',mmk_draft_requires_review:'MMK 临时记录待核对，尚未确认完成',
  target_changed_during_preparation:'目标档期在准备期间变化，已暂停写入',previous_write_uncertain:'上次写入结果未确认，待回读核对',
  previous_release_uncertain:'上次开放结果未确认，待回读核对',release_readback_failed:'开放后的平台回读未通过，尚未确认完成',
  write_readback_failed:'关档后的平台回读未通过，尚未确认完成',receipt_stale:'最近档期核验已过期，请立即同步重新核对',
  receipt_conflict:'同次档期回执不一致，需重新核对',
  cb_app_end_not_selectable:'Click&Boat 最少租期挡住了这几天：客人订不了，App 也不让选作结束日。程序没写入，不用手动处理',
  cb_app_date_not_selectable:'Click&Boat 最少租期挡住了这几天：客人订不了，App 也不让选。程序没写入，不用手动处理',
  nausys_auth_required:login,nausys_account_mismatch:'NauSYS 登录账号不是 demo-user@AGENCY，已暂停日历同步',
  nausys_list_unavailable:'NauSYS 订单页面未准备好，请稍后立即同步重试',nausys_list_incomplete:'NauSYS 订单列表未完整读取，已暂停日历同步',
  nausys_filters_set:'NauSYS 订单列表设了其他筛选条件，程序不清除；请在 NauSYS 订单列表点 Reset 后再同步',
  nausys_search_form_changed:'NauSYS 订单页面结构变化，已暂停日历同步',nausys_calendar_unavailable:'NauSYS 日历页面未准备好，请稍后立即同步重试',
  nausys_dates_not_available:'NauSYS 上这几天已被占用或不能这样订，需核对现有记录',nausys_calendar_changed:'NauSYS 日历已变化，需重新核对',
  nausys_form_mismatch:'NauSYS 录单表单与预期不符，未保存',nausys_client_not_found:'NauSYS 客户库里找不到对应的平台联系人，未保存',
  nausys_dialog_unavailable:'NauSYS 录单窗口没有打开，未保存',nausys_write_uncertain:'NauSYS 保存结果未确认，下轮按单号核对，不会重复录入',
  nausys_booking_not_confirmed:'NauSYS 已存为 Option，但还没转成正式订单；下轮继续',nausys_partial_write_requires_review:'NauSYS 上的记录与程序写入的不一致，需核对',
  nausys_owned_record_changed:'NauSYS 上程序录的订单被改过，已保留并暂停自动处理',nausys_cancel_uncertain:'NauSYS 取消结果未确认，待回读核对',
  nausys_cancel_readback_failed:'NauSYS 取消后的回读未通过，尚未确认完成',
  nausys_calendar_timeout:'NauSYS 日历查询超时，未保存；下轮再试',nausys_client_unknown:'这笔订单的来源平台在 NauSYS 客户库里没有对应联系人，未保存',
  nausys_dialog_already_open:'NauSYS 页面上还开着别的订单窗口，未保存；下轮再试',nausys_dialog_not_closed:'NauSYS 订单窗口没能关上，未保存；下轮再试',
  nausys_draft_not_saved:'NauSYS 上次录单没有存上（列表里没有这个单号），这几天下轮重新录',nausys_write_intent_required:'程序内部检查未通过（录单前没有写入记录），未保存',
  mmk_turnover_conflict:'MMK 上下一条档从当天 0 点开始，这一晚按 14:00/10:00 写会和它重叠，MMK 不让写；住这一晚必然和那条档重叠，客人也订不了。程序没写入，不用手动处理',
  mmk_no_free_draft_window:'MMK 建档要先占 7 晚草稿，这几晚前后 60 天都排满了，找不到能放草稿的地方。程序没写入，请在 MMK 上手动关这几晚',
  mmk_initial_record_changed:'MMK 新建的草稿在保存前内容变了，程序先停下没保存。下一轮会再核对这张草稿：只是 MMK 自己补的默认内容就接着用；有别的改动就停下，请人工核对这张无客人的 Option'};
 return Object.hasOwn(labels,e.error)?labels[e.error]:Object.hasOwn(states,e.state)?states[e.state]:'尚无匹配当前订单的回读结果';
}
// Every platform's kept program records (Boataround only before 2026-10-10).
const RELEASE_NAMES={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'};
function releaseReviewTargets(boat){
 const valid=r=>/^\d{4}-\d{2}-\d{2}$/.test(r?.start)&&/^\d{4}-\d{2}-\d{2}$/.test(r?.end)&&r.start<r.end;
 return (REVERSE_PLAN?.targets||[]).filter(t=>t.boat===boat.boataround_slug&&Object.hasOwn(RELEASE_NAMES,t.target))
  .map(t=>({target:t,ranges:(t.release_review?.ranges||t.execution?.retained_ranges||[]).filter(valid)})).filter(x=>x.ranges.length);
}
function releaseReviewRanges(boat){return releaseReviewTargets(boat).flatMap(x=>x.ranges);}
function releaseReviewAnchor(boat){return 'release-review-'+boat.boataround_slug;}
function releaseReviewNotice(boat){
 const groups=releaseReviewTargets(boat);if(!groups.length)return '';
 const names=groups.map(x=>RELEASE_NAMES[x.target.target]).join('、');
 return '<aside class="release-review" id="'+esc(releaseReviewAnchor(boat))+'" aria-label="'+esc(names+' 恢复可预订待核验')+'"><strong>'+esc(names)+' · 恢复可预订待核验</strong><p>以下日期是本系统以前设的不可预订，现在已没有订单需要，尚未确认恢复可预订，请核验平台日历。原手动设置保留。</p>'+groups.map(x=>{
  const checked=x.target.release_review?.checked_at||x.target.execution?.retained_checked_at;
  return '<p><strong>'+esc(RELEASE_NAMES[x.target.target])+'</strong>'+(checked?'（最近记录：'+esc(new Date(checked).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))+' 北京时间）':'')+'</p><ul>'+x.ranges.map(r=>'<li>'+esc(r.start)+(r.start===shiftDay(r.end,-1)?'':' 至 '+esc(shiftDay(r.end,-1)))+'（含起止日）</li>').join('')+'</ul>';
 }).join('')+'</aside>';
}
function boatReverse(boat){
 const key=boat.boataround_slug,items=REVERSE_PLAN?.targets?.filter(t=>t.boat===key)||[];
 const opened=Array.from(document.querySelectorAll('details.boat-reverse[open]')).some(n=>n.dataset.boatKey===key);
 const names={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'};
 const states={protected:'最近核对：所需日期已关档',protected_partial:'已按现有订单设为不可预订；部分平台订单未更新，暂不恢复可预订',stale:'核对已过期或来源异常，待重新同步',needs_review:'需核对，未确认完成',deferred:'待下轮执行',adapter_unavailable:'尚未接通',removal_requires_verification:'旧保护保留，开放需核对'};
 const note=REVERSE_ERROR?'预览读取失败，未确认任何写回结果':!REVERSE_PLAN?'正在读取预览…':REVERSE_PLAN.mode==='guarded_release'?'自动开关档':REVERSE_PLAN.mode==='close_only'?'手机自动关档 · 开放需核对':'预览 · 尚未自动关档';
 return releaseReviewNotice(boat)+'<details class="boat-reverse" data-boat-key="'+esc(key)+'"'+(opened?' open':'')+'><summary>跨平台档期 <span>'+note+'</span></summary><div class="reverse-detail"><p>以下是应保护日期；请以各平台回读结果为准。退房日不计入占用，人工锁档保留。</p>'+items.map(t=>'<section><strong>'+esc(names[t.target])+'</strong>'+(REVERSE_PLAN?.mode==='guarded_release'?'<p>'+(t.target==='mmk'?'以 Reservation 保护档期；异常保留待核对':t.target==='boataround'?(baControl(t)?.enabled?'新版托管日期自动开关档；历史档仍保留待核对':'自动关档；历史档开放需核对'):'自动开关档；异常保留待核对')+'</p>':'')+'<p data-reverse-execution-boat="'+esc(t.boat)+'" data-reverse-execution-target="'+esc(t.target)+'">'+esc(reverseExecutionWithTime(t))+'</p><p>'+(t.status==='mapping_unknown'?'船只映射待核对':!t.source_count?'没有其他平台的有效付款订单':String(t.source_count)+' 笔来源订单'+(!t.fresh?' · 写入前需重新核查订单':''))+'</p>'+(t.execution?.blocked||[]).map(b=>'<p>未完成关档：'+esc(b.start)+' → '+esc(b.end)+'</p>').join('')+t.segments.map(s=>'<p class="reverse-range">'+esc(s.start)+' → '+esc(s.end)+'<small>'+s.causes.map(c=>esc(c)).join('、')+'</small></p>').join('')+(t.target==='boataround'?boataroundHolds(t):'')+'</section>').join('')+(REVERSE_PLAN?.excluded?.some(e=>e.boat===key)?'<p>部分记录付款或改期证据不完整，已排除，需核查。</p>':'')+'</div></details>';
}
async function readReversePreview(){
 if(REVERSE_LOADING||Date.now()-REVERSE_READ_AT<30000)return;
 REVERSE_LOADING=true;REVERSE_READ_AT=Date.now();
 try{const {response,data}=await dashboardRequest('/api/reverse-sync/preview');if(!response.ok||!data.ok||!['preview','close_only','guarded_release'].includes(data.mode)||!Array.isArray(data.targets))throw Error('reverse_preview_unavailable');REVERSE_PLAN=data;REVERSE_ERROR=false;await Promise.all([readBoataroundControl(false),readFleetHoldControl(false)]);}
 catch{REVERSE_ERROR=true;REVERSE_PLAN=null;}
 finally{REVERSE_LOADING=false;if(DATA)renderBoats();}
}
`;
const styles=`.boat-reverse{margin:10px 0 14px;font-size:.75rem;border-top:1px solid #b8cdd6;padding-top:8px;color:#234354}.boat-reverse summary{cursor:pointer;font-weight:650}.boat-reverse summary span{font-weight:400;margin-left:6px}.reverse-detail{padding:6px 0;line-height:1.7}.reverse-detail p{font-size:inherit;margin:5px 0;color:inherit}.reverse-detail section{border-top:1px solid #b8cdd6;padding:8px 0}.reverse-range small{display:block;overflow-wrap:anywhere}.boat-reverse summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}.ba-holds{margin-top:8px;border:1px solid #94acb8;border-radius:8px;padding:7px 9px;min-width:0}.ba-hold-content{padding-top:4px;overflow-wrap:anywhere}.ba-hold-dates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ba-hold-dates label{display:grid;gap:3px;min-width:0;font-size:inherit;color:inherit}.ba-hold-dates input{box-sizing:border-box;min-width:0;width:100%;max-width:100%;padding:7px;font:inherit;background:#fff;color:#163a4b;border:1px solid #7896a5;border-radius:6px}.ba-holds button{font:inherit;padding:7px 10px;margin-top:6px;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;border-radius:6px;background:#176577;color:#fff;border:1px solid #176577}.ba-holds button:disabled{opacity:.6;cursor:not-allowed}.ba-hold-list{list-style:none;margin:6px 0;padding:0}.ba-hold-list li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:5px;padding:5px 0;border-bottom:1px solid #b8cdd6}.ba-hold-list small{display:block}.ba-holds .ba-hold-remove{background:transparent;color:#14576a;border-color:#779baa}.ba-hold-state,.ba-hold-message{font-weight:600}.ba-hold-message:empty{display:none}@media(max-width:380px){.ba-hold-dates{grid-template-columns:minmax(0,1fr)}}@media(prefers-color-scheme:dark){.boat-reverse{color:#e4f1fa;border-color:#6b8594}.reverse-detail section{border-color:#6b8594}.ba-holds,.ba-hold-list li{border-color:#7596a6}.ba-hold-dates input{color:#e8f4f8;background:#183744;border-color:#91aeb9;color-scheme:dark}.ba-holds button{background:#b3e4ee;color:#13343d;border-color:#b3e4ee}.ba-holds .ba-hold-remove{color:#b3e4ee;border-color:#8cb9c5;background:transparent}}`;
function patchReverse(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1],oldStyle=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 let script=oldScript;
 const renderAnchor='function renderBoats(){';
 if(script.split(renderAnchor).length!==2)throw Error('Boataround draft render anchor changed');
 // Native date inputs can contain a partially edited segment while value is empty.
 // Keep their DOM intact until focus leaves, rather than replacing it on polling.
 script=script.replace(renderAnchor,renderAnchor+"\n renderFleetHolds();if(document.activeElement?.matches?.('.ba-hold-form input')){BA_HOLD_RENDER_DEFERRED=true;refreshReverseLiveState();return;}BA_HOLD_RENDER_DEFERRED=false;");
 const anchor="'+tags+'</div>";
 if(script.split(anchor).length!==2)throw Error('Reverse boat insertion anchor changed');
 script=script.replace(anchor,"'+tags+'</div>'+boatReverse(boat)+'");
 const finish="document.getElementById('queryBtn').disabled=false;render();";
 if(script.split(finish).length!==2)throw Error('Reverse refresh insertion anchor changed');
 script=script.replace(finish,finish+'void readReversePreview();');
 script=presentation+'\n'+fleetHoldScript+'\n'+script;
 const change=(a,b)=>{if(script.split(a).length!==2)throw Error('Release calendar anchor changed: '+a);script=script.replace(a,()=>b);};
 change("map.set(day,{cls:'b',label:'不可用',booking:block.booking})", "map.set(day,{cls:'b',label:'不可用',booking:block.booking,fleet_hold:block.fleet_hold===true})");
 change("label=status||conflict?'不可用':'可用'", "label=status?.fleet_hold?'手动锁档 · 不可用':status||conflict?'不可用':'可用'");
 change("(t.target==='boataround'?boataroundHolds(t):'')", "(t.target==='boataround'?legacyBoataroundHolds(t):'')");
 change('function initialize(){', 'function initialize(){\n installFleetHoldQuery();');
 change('pairs=conflicts.pairs.filter(', 'releasePending=releaseReviewRanges(boat).some(r=>r.start<=date&&date<r.end),pairs=conflicts.pairs.filter(');
 change("(conflict?' booking-conflict-day':'')", "(conflict?' booking-conflict-day':'')+(releasePending?' release-pending-day':'')");
 change("(conflict?' 疑似撞单':'')", "(conflict?' 疑似撞单':'')+(releasePending?' 恢复可预订待核验':'')");
 change("(status||conflict?'<span class=\"day-status\">'+(conflict?'撞':'订')+'</span>':'')", "(status||conflict?'<span class=\"day-status\">'+(conflict?'撞':'订')+'</span>':'')+(releasePending?'<a class=\"release-day-label\" href=\"#'+esc(releaseReviewAnchor(boat))+'\" aria-label=\"'+esc(date+' 恢复可预订待核验')+'\">待开</a>':'')");
 const reviewStyles='.release-review{background:#fff1bf;color:#542b00;border:2px solid #a94b00;border-left-width:6px;border-radius:10px;padding:12px;margin:10px 0;scroll-margin-top:20px}.release-review strong{font-size:.9rem}.release-review p,.release-review li{color:inherit;font-size:.8rem;line-height:1.6}.release-review p{margin:6px 0}.release-review ul{margin:0;padding-left:20px}.cal td.release-pending-day{background:#fff1bf!important;color:#542b00!important;box-shadow:inset 0 0 0 2px #a94b00}.cal td .release-day-label{display:block;color:#542b00!important;font-size:.65rem;font-weight:800;text-decoration:underline}.release-review:target{outline:3px solid #a94b00;outline-offset:3px}@media(prefers-color-scheme:dark){.release-review,.cal td.release-pending-day{background:#40270a!important;color:#ffe3a1!important;border-color:#ffc65b}.cal td.release-pending-day{box-shadow:inset 0 0 0 2px #ffc65b}.cal td .release-day-label{color:#ffe3a1!important}}';
 const style=oldStyle+styles+reviewStyles+fleetHoldStyles,calendarAnchor='<section aria-labelledby="calendar-title">';
 if(html.split(calendarAnchor).length!==2)throw Error('Fleet hold panel insertion anchor changed');
 const next=html.replace(oldScript,()=>script).replace(oldStyle,()=>style).replace(calendarAnchor,()=>fleetHoldHTML+'\n'+calendarAnchor);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);
 if(start<0||end<0)throw Error('Reverse HTML anchor changed');
 const result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Reverse CSP anchor missing');
 return result.replace(csp,(_,a,b,c)=>a+createHash('sha256').update(script).digest('base64')+b+createHash('sha256').update(style).digest('base64')+c);
}
module.exports={patchReverse};


