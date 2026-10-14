'use strict';
const vm=require('node:vm');
const {createHash}=require('node:crypto');

const sharedScript=String.raw`
function syncView(value){const root=value&&typeof value==='object'?value:{},state=root.order_sync&&typeof root.order_sync==='object'?root.order_sync:root;return {...state,automatic_enabled:typeof root.automatic_enabled==='boolean'?root.automatic_enabled:state.automatic_enabled===true,next_attempt_at:root.next_attempt_at||state.next_attempt_at||root.cloud?.nextSyncAt||state.cloud?.nextSyncAt||null,cloud:root.cloud||state.cloud||{}};}
function syncTime(value){const date=new Date(value??NaN);if(!Number.isFinite(date.getTime()))return '尚未成功同步';const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date),p=Object.fromEntries(parts.map(part=>[part.type,part.value]));return p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute+':'+p.second+'（北京时间）';}
function allOrderSuccess(state){const values=['boataround','clickandboat','samboat','mmk','nausys'].map(source=>state.platforms?.[source]?.last_success_at);return values.every(value=>value&&Number.isFinite(Date.parse(value)))?new Date(Math.min(...values.map(Date.parse))).toISOString():null;}
function syncModeText(state){if(!state.automatic_enabled)return '定时同步未启用。';const text=allOrderSuccess(state)?'定时同步已启用。':'定时同步已启用，等待三平台首次成功同步。';return text+(state.next_attempt_at?' 下次尝试：'+syncTime(state.next_attempt_at)+'。':'');}
function syncErrorText(code,httpStatus){const labels={auth_required:'平台登录尚未完成或已过期，请重新连接平台。',cloud_login_not_verified:'尚未确认平台登录成功，请在登录窗口完成后重试。',no_active_login:'登录窗口已关闭或过期，请重新连接平台。',session_expired:'登录窗口已过期，请重新连接平台。',session_in_progress:'已有登录或同步任务正在运行，请稍候。',busy:'已有登录或同步任务正在运行，请稍候。',daily_budget:'免费运行预算暂时不足，已保留上次订单，稍后会按计划重试。',budget_suspended:'免费运行预算已暂停使用，已保留上次订单。',quota:'免费运行预算暂时不足，已保留上次订单。',quota_exceeded:'免费运行预算暂时不足，已保留上次订单。',deadline_exceeded:'本次运行超时，已保留上次订单，请稍后重试。',timed_out:'本次运行超时，已保留上次订单，请稍后重试。',incomplete_pages:'平台订单列表尚未完整读取，已保留上次订单。',schema_changed:'平台页面暂时无法完整识别，已保留上次订单。',collector_unavailable:'该平台同步暂未接通，请稍后重试。',fetch_failed:'平台暂时无法读取，已保留上次订单。',challenge_required:'平台要求人工完成访问验证，程序无法自动通过。请在手机远程桌面的专用浏览器中完成验证，已保留上次订单。',cloud_browser_unavailable:'云端连接暂时不可用，请稍后重试。',cloud_session_unavailable:'云端登录窗口暂时不可用，请重新连接。'};if(labels[code])return labels[code];if(httpStatus===401)return '看板登录已过期，请重新登录。';if(httpStatus===403)return '登录状态或提交来源无效，请刷新本页后重试。';if(httpStatus===404)return '云端同步服务尚未接通，请稍后重试。';if(httpStatus===429)return labels.quota;if(httpStatus>=500)return '同步服务暂时不可用，已保留上次订单，请稍后重试。';return '操作暂未完成，请稍后重试或重新连接平台。';}
`;

// Shared by the dashboard and phone maintenance page. Only the server's
// request-scoped receipts can establish a successful manual synchronization.
const phoneSyncScript=String.raw`
const PHONE_SYNC_NAMES={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'};
function phoneRunId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}
function phoneQueuedRun(receipt){if(receipt?.ok!==true||receipt.status!=='queued'||!phoneRunId(receipt.requested_run_id))throw Error('暂时无法确认新的手机同步请求已排队，请读取同步状态后重试；已有订单仍保留。');return receipt.requested_run_id;}
function phoneRunRequestedAt(run){return typeof run?.requested_at==='string'&&Number.isFinite(Date.parse(run.requested_at))?run.requested_at:null;}
function phonePairingAt(status){return typeof status?.paired_at==='string'&&Number.isFinite(Date.parse(status.paired_at))?status.paired_at:null;}
function phonePairingChanged(status,reference){const current=phonePairingAt(status),previous=reference?.paired_at||reference?.requested_at;return status.paired===true&&current&&previous&&Date.parse(current)>Date.parse(previous);}
function phoneStatusForRun(value,expected){
 if(!value||value.ok!==true||value.mode!=='phone'||typeof value.paired!=='boolean'||value.requested_run_id!=null&&!phoneRunId(value.requested_run_id))throw Error('暂时无法确认手机同步状态，已有订单仍保留。');
 if(expected&&phonePairingChanged(value,expected))return {...value,pairing_changed:true,following_latest_run:false};
 const expectedId=expected?.id||expected,run=value.manual_run,requestedAt=phoneRunRequestedAt(run),previousAt=expected?.requested_at;
 if(value.paired&&expectedId&&value.requested_run_id!==expectedId&&run?.id!==expectedId){
  const validRun=phoneRunId(run?.id)&&requestedAt&&['queued','running','awaiting_upload','completed'].includes(run.state),active=validRun&&value.requested_run_id===run.id&&['queued','running','awaiting_upload'].includes(run.state)&&(!previousAt||Date.parse(requestedAt)>=Date.parse(previousAt)),newer=validRun&&previousAt&&Date.parse(requestedAt)>Date.parse(previousAt);
  if(!active&&!newer)return {...value,requested_run_id:expectedId,manual_run:null,following_latest_run:expected?.following_latest_run===true};
  return {...value,following_latest_run:true};
 }
 return expected?.following_latest_run?{...value,following_latest_run:true}:value;
}
function phoneTrackRun(status,previous){if(!previous||status.paired===false||status.pairing_changed||phoneRunProgress(status).phase==='completed')return null;const id=status.requested_run_id||status.manual_run?.id;if(!phoneRunId(id))return previous;const requestedAt=status.manual_run?.id===id?phoneRunRequestedAt(status.manual_run):null;return {id,requested_at:requestedAt||((previous.id||previous)===id?previous.requested_at:null)||null,paired_at:phonePairingAt(status)||previous.paired_at||null,following_latest_run:status.following_latest_run===true};}
function phoneRunProgress(status){
 const run=status?.manual_run,id=status?.requested_run_id;
 if(!run||!phoneRunId(run.id)||id&&run.id!==id)return {phase:id?'queued':'none',pending:!!id,retryable:false,results:{},sources:Object.keys(PHONE_SYNC_NAMES),successful:false};
 const results={};for(const source of Object.keys(PHONE_SYNC_NAMES)){const r=run.results?.[source];if(r&&['success','failure'].includes(r.outcome)&&typeof r.checked_at==='string'&&Number.isFinite(Date.parse(r.checked_at)))results[source]=r;}
 // MMK joined manual runs with the 2026-10-04 release (07:10 UTC), NauSYS with
 // the 2026-10-09 release. A run the server completed before a source joined
 // has no result for it and never will; requiring one kept the button at
 // "同步中…" (found the evening of 10-04). Every other source, and a later
 // source for any later run, must still have reported.
 const joined={mmk:'2026-10-04T07:10:00.000Z',nausys:'2026-10-10T04:00:00.000Z'};
 const sources=Object.keys(PHONE_SYNC_NAMES).filter(source=>!(run.state==='completed'&&!results[source]&&joined[source]&&Date.parse(run.requested_at)<Date.parse(joined[source])));
 const complete=run.state==='completed'&&!id&&Object.keys(results).length===sources.length&&typeof run.completed_at==='string'&&Number.isFinite(Date.parse(run.completed_at));
 const phase=complete?'completed':Object.keys(results).length===sources.length?'confirming':['queued','running','awaiting_upload'].includes(run.state)?run.state:id?'queued':'awaiting_upload';
 const retryable=phase==='awaiting_upload'&&run.state==='awaiting_upload'&&id===null&&typeof run.completed_at==='string'&&Number.isFinite(Date.parse(run.completed_at));
 return {phase,pending:!complete,retryable,results,sources,successful:complete&&Object.values(results).every(r=>r.outcome==='success'),completed_at:run.completed_at};
}
function phoneRunText(status,formatTime){
 const prefix=status.pairing_changed?'手机已重新配对，先前的同步请求已结束等待；当前显示新手机的状态。':status.following_latest_run?(phoneRunProgress(status).phase==='completed'?'已显示更新的同步任务结果。':'已切换到更新的同步任务；以下显示该任务的进度与结果。'):'';return prefix+phoneRunDetailsText(status,formatTime);
}
function phoneRunDetailsText(status,formatTime){
 const run=phoneRunProgress(status),successes=run.sources.filter(source=>run.results[source]?.outcome==='success'),failures=run.sources.filter(source=>run.results[source]?.outcome==='failure');
 const details=run.sources.map(source=>PHONE_SYNC_NAMES[source]+'：'+(run.results[source]?.outcome==='success'?'最新订单已保存':run.results[source]?.outcome==='failure'?'同步失败，保留上次订单':'等待本轮结果')).join('；');
 if(run.phase==='completed'){
  // Receipt delivery can finish after the phone's ACK. Compare each source's
  // observation with that source's manual receipt, never with server delivery
  // time or ACK time, so a late upload still completes its own manual task.
  const platforms=status.order_sync?.platforms||{},later=Object.entries(platforms).some(([source,p])=>{const receiptAt=Date.parse(run.results[source]?.checked_at),checkedAt=typeof p?.last_checked_at==='string'&&Number.isFinite(Date.parse(p.last_checked_at))?Date.parse(p.last_checked_at):Date.parse(p?.last_success_at);return Number.isFinite(receiptAt)&&checkedAt>receiptAt;});
  if(later||status.online===false||status.state==='running'||status.state==='needs_login'){
   const currentFailures=Object.keys(PHONE_SYNC_NAMES).filter(source=>platforms[source]?.last_error&&platforms[source].last_error!=='awaiting_first_sync');
   const current=status.online===false?'手机暂未连接，当前显示最近保存的订单。':status.state==='running'?'手机正在同步订单，完成后会更新各平台最近成功时间。':currentFailures.length?currentFailures.map(source=>PHONE_SYNC_NAMES[source]+'：最近同步失败，保留上次订单。').join(''):status.state==='needs_login'?'至少一个平台需要在手机的专用浏览器中登录。':'已收到后续同步结果，以各平台最近成功时间为准。';
   return current+' 上次手动同步结果：'+successes.length+' 个平台成功，'+failures.length+' 个平台失败。完成时间：'+formatTime(run.completed_at);
  }
  return (run.successful?'手动同步完成，三平台最新订单已保存。':'手动同步已结束：'+successes.length+' 个平台成功，'+failures.length+' 个平台失败。')+' '+details+'。完成时间：'+formatTime(run.completed_at);
 }
 if(run.phase==='queued')return (status.online===false?'同步已排队，手机暂未连接，等待手机恢复联络。':status.state==='running'?'同步已排队，手机正在处理已有任务。':'同步已排队，等待手机开始处理。')+' 当前继续显示最近保存的订单。';
 if(run.phase==='running')return '手机正在同步本轮订单。'+details+'。'+(status.online===false?'手机暂未收到近期心跳，正在等待恢复联络。':'');
 if(run.phase==='awaiting_upload')return '手机采集已结束，本轮结果尚未全部接收。'+details+'。'+(run.retryable?'可以点击“重新同步”再试；已有订单会继续保留。':'正在等待云端完整接收本轮结果。');
 if(run.phase==='confirming')return '三平台本轮结果已接收，正在确认手机本轮完成状态。'+details+'。';
 if(status.state==='running')return '手机正在同步订单，完成后会更新各平台最近成功时间。';
 if(status.paired===false)return '手机尚未配对，请打开同步设置。';
 if(status.online===false)return '手机暂未连接，当前显示最近保存的订单。';
 return '';
}
`;

const mainScript=phoneSyncScript+String.raw`
let ORDER_SYNC_NOTICE='',PHONE_SYNC_STATUS=null,ORDER_SYNC_LOADING=false,ORDER_SYNC_TIMER=null,EXPECTED_MANUAL_RUN=null,FAILED_PHONE_SUBMISSION=null;
function phoneMode(){return !!DATA?.order_sync?.agent;}
function dashboardSyncText(){return ORDER_SYNC_NOTICE||(PHONE_SYNC_STATUS?phoneRunText(PHONE_SYNC_STATUS,syncTime):'');}
function updateSyncButton(){const btn=document.getElementById('refreshBtn'),run=PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS),blocked=run?.pending&&!run.retryable;btn.disabled=ORDER_SYNC_LOADING||!!blocked;btn.textContent=ORDER_SYNC_LOADING?'正在读取同步状态…':blocked?(run.phase==='queued'?'已排队':'同步中…'):run?.retryable?'重新同步':'立即同步';}
function orderSyncMetaText(){const state=syncView(DATA?.order_sync),all=allOrderSuccess(state);return all?'最新刷新数据时间：'+syncTime(all):'已核验快照时间：'+beijingRefreshTime(DATA?.mapping_updated_at)+'；三平台尚未全部连接并完成同步';}
function newerTaskAfterFailure(status,failed){const run=status?.manual_run,id=status?.requested_run_id||run?.id,requestedAt=phoneRunRequestedAt(run);return failed&&phoneRunId(id)&&run?.id===id&&requestedAt&&['queued','running','awaiting_upload','completed'].includes(run.state)&&id!==failed.previous_run_id&&(failed.previous_known||status.requested_run_id===id)&&(!failed.previous_requested_at||Date.parse(requestedAt)>Date.parse(failed.previous_requested_at));}
function render(){
 const state=syncView(DATA.order_sync),messages=[],notice=dashboardSyncText();document.getElementById('meta').textContent=orderSyncMetaText()+(notice?'；'+notice:'');
 document.getElementById('syncMode').textContent=phoneMode()?(state.automatic_enabled?'定时同步已启用，每 3 小时尝试一次。'+(state.next_attempt_at?' 下次计划：'+syncTime(state.next_attempt_at)+'。':''):'定时同步未启用。'):syncModeText(state);
 document.getElementById('bookingVerifiedAt').textContent=['boataround','clickandboat','samboat','mmk','nausys'].map(source=>srcLabel(source)+' 最近成功：'+syncTime(state.platforms?.[source]?.last_success_at)).join('；');
 if(DATA.booking_mapping_complete===false)messages.push('部分订单尚未核验完整。');
 for(const source of ['boataround','clickandboat','samboat','mmk','nausys']){const info=state.platforms?.[source],health=state.cloud?.sources?.[source];if(info?.last_error==='auth_required'&&health?.status==='connected')messages.push(srcLabel(source)+'：已重新连接，等待下次同步。');else if(info?.last_error&&info.last_error!=='awaiting_first_sync')messages.push(srcLabel(source)+'：'+syncErrorText(info.last_error));else if(health?.status==='auth_required')messages.push(srcLabel(source)+'：请到同步设置连接平台。');}
 document.getElementById('dataIssues').textContent=messages.join(' ');updateSyncButton();renderBoats();
}
async function dashboardRequest(path,payload){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,...(payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})});if(response.status===401){window.location.replace('/login');throw Error('看板登录已过期，请重新登录。');}let data;try{data=await response.json();}catch{throw Error(syncErrorText(null,response.status));}return {response,data};}
 catch(error){if(controller.signal.aborted)throw Error('暂时未收到同步服务响应，正在等待恢复连接；已有订单仍保留。');throw error;}finally{clearTimeout(timer);}
}
async function readPhoneStatus(){const {response,data}=await dashboardRequest('/api/agent/status');if(!response.ok||data?.error)throw Error(syncErrorText(data?.code||data?.error,response.status));PHONE_SYNC_STATUS=phoneStatusForRun(data,EXPECTED_MANUAL_RUN);EXPECTED_MANUAL_RUN=phoneTrackRun(PHONE_SYNC_STATUS,EXPECTED_MANUAL_RUN);}
function scheduleSyncStatus(){clearTimeout(ORDER_SYNC_TIMER);ORDER_SYNC_TIMER=null;if(!phoneMode()||document.hidden)return;ORDER_SYNC_TIMER=setTimeout(()=>loadData(false),PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS).pending||PHONE_SYNC_STATUS?.state==='running'?5000:30000);}
async function loadData(force){
 if(ORDER_SYNC_LOADING)return;
 if(force&&PHONE_SYNC_STATUS){const run=phoneRunProgress(PHONE_SYNC_STATUS);if(run.pending&&!run.retryable)return;}
 const meta=document.getElementById('meta');let phoneSubmissionPending=false;ORDER_SYNC_LOADING=true;clearTimeout(ORDER_SYNC_TIMER);updateSyncButton();if(!DATA||force)meta.textContent=force?'正在提交订单同步…':'正在读取订单…';
 try{
  let queued=false;
  if(force){
   if(phoneMode()){FAILED_PHONE_SUBMISSION={previous_run_id:PHONE_SYNC_STATUS?.requested_run_id||PHONE_SYNC_STATUS?.manual_run?.id||null,previous_requested_at:phoneRunRequestedAt(PHONE_SYNC_STATUS?.manual_run),previous_known:!!PHONE_SYNC_STATUS,paired_at:phonePairingAt(PHONE_SYNC_STATUS)};phoneSubmissionPending=true;}
   ORDER_SYNC_NOTICE='';const {response:start,data:receipt}=await dashboardRequest(phoneMode()?'/api/agent/run':'/api/cloud-sync/run',{});
   if(phoneMode()&&start.ok&&!receipt?.error){EXPECTED_MANUAL_RUN={id:phoneQueuedRun(receipt),requested_at:phoneRunRequestedAt(receipt),paired_at:phonePairingAt(PHONE_SYNC_STATUS)};queued=true;phoneSubmissionPending=false;FAILED_PHONE_SUBMISSION=null;PHONE_SYNC_STATUS={...PHONE_SYNC_STATUS,requested_run_id:EXPECTED_MANUAL_RUN.id,manual_run:null};ORDER_SYNC_NOTICE='同步已排队，手机将重新读取三平台订单，当前继续显示最近保存的订单。';}
   else if(!phoneMode()&&start.ok&&receipt?.status==='queued'){queued=true;ORDER_SYNC_NOTICE='已提交云端同步，当前仍显示最近保存的订单；稍后刷新可查看结果';}
   else if(receipt.status==='busy')ORDER_SYNC_NOTICE=syncErrorText('busy');
   else if(receipt.status==='quota'||receipt.reason)ORDER_SYNC_NOTICE=syncErrorText(receipt.reason||receipt.status,start.status);
   else if(!start.ok||receipt.error)ORDER_SYNC_NOTICE=syncErrorText(receipt.code||receipt.error,start.status);
   else ORDER_SYNC_NOTICE='同步请求已接收，当前显示最近保存的订单';
  }
  const wasPhone=phoneMode();if(wasPhone){await readPhoneStatus();if(FAILED_PHONE_SUBMISSION&&(PHONE_SYNC_STATUS.paired===false||phonePairingChanged(PHONE_SYNC_STATUS,FAILED_PHONE_SUBMISSION)||newerTaskAfterFailure(PHONE_SYNC_STATUS,FAILED_PHONE_SUBMISSION))){FAILED_PHONE_SUBMISSION=null;ORDER_SYNC_NOTICE='';}if((!force||queued)&&!FAILED_PHONE_SUBMISSION&&(PHONE_SYNC_STATUS.requested_run_id||PHONE_SYNC_STATUS.manual_run||PHONE_SYNC_STATUS.pairing_changed))ORDER_SYNC_NOTICE='';}
  let {response,data}=await dashboardRequest('/api/data');
  if(!response.ok||data.error)throw new Error(syncErrorText(data.code||data.error,response.status));
  if(data.schema_version!==2||!Array.isArray(data.boats))throw new Error('订单服务暂时不可用，请稍后重试。');
  DATA=data;if(phoneMode()&&!wasPhone){await readPhoneStatus();const refreshed=await dashboardRequest('/api/data');if(!refreshed.response.ok||refreshed.data.error||refreshed.data.schema_version!==2||!Array.isArray(refreshed.data.boats))throw Error('暂时无法读取更新后的订单，请稍后重试。');DATA=refreshed.data;}
  if(!phoneMode())PHONE_SYNC_STATUS=null;
  document.getElementById('queryBtn').disabled=false;render();if(hasQuery)window.checkAvail();
 }catch(error){const message=error instanceof TypeError?'网络连接暂时不可用，请稍后重试。':error.message;if(phoneSubmissionPending&&FAILED_PHONE_SUBMISSION)ORDER_SYNC_NOTICE=message;meta.textContent=(DATA?orderSyncMetaText()+'；':'')+message+(DATA?' 当前保留上次订单。':'');if(!DATA)document.getElementById('boats').innerHTML='<div class="loading">暂时无法读取订单，请稍后点击“立即同步”重试。</div>';}
 finally{ORDER_SYNC_LOADING=false;updateSyncButton();scheduleSyncStatus();}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(ORDER_SYNC_TIMER);ORDER_SYNC_TIMER=null;}else loadData(false);});
`;

const maintenanceScript=String.raw`
const PLATFORM_NAMES={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat'};
let CLOUD_SYNC_VIEW={},CLOUD_SYNC_BUSY=false,CLOUD_SYNC_TIMER=null,CLOUD_SYNC_REVISION=0;
function sameLogin(source,active){return active?.kind==='login'&&active.source===source;}
function resumableLogin(source,active){return sameLogin(source,active)&&(!active.phase||active.phase==='login')&&(!active.deadlineAt||active.deadlineAt>Date.now());}
function canStartShortLogin(state){const budget=state.cloud?.budget;return !state.cloud?.active&&!budget?.blocked&&Number.isFinite(budget?.remainingMs)&&budget.remainingMs>=110000&&budget.remainingMs<185000;}
function sourceConnectionText(source,state){const health=state.cloud?.sources?.[source],info=state.platforms?.[source],active=state.cloud?.active;if(sameLogin(source,active)){if(active.phase==='closing'||active.deadlineAt<=Date.now())return '登录窗口正在关闭';if(active.phase==='finishing')return '正在确认登录';if(active.phase==='resuming')return '正在恢复登录窗口';return '等待完成登录';}if(health?.status==='connected')return '已连接';if(info?.last_error==='auth_required'||health?.status==='auth_required')return info?.last_success_at||health?.checkedAt?'登录已过期，请重新连接':'尚未连接';return '尚未连接';}
function budgetText(state){const budget=state.cloud?.budget;if(!budget||!Number.isFinite(budget.remainingMs))return '免费运行预算：暂未读取到额度信息。';const seconds=Math.max(0,Math.floor(budget.remainingMs/1000)),time=Math.floor(seconds/60)+'分'+String(seconds%60).padStart(2,'0')+'秒';return '免费运行预算：剩余 '+time+'。'+(budget.blocked?'当前运行已暂停，订单保留。':budget.nextLoginAt?'预计标准登录恢复时间：'+syncTime(budget.nextLoginAt)+'。现有订单已保留。':'额度不足时会暂停运行并保留上次订单。');}
function loginFailureText(source,state){
 const failure=state.cloud?.lastLoginFailure,health=state.cloud?.sources?.[source];
 if(!failure||Array.isArray(failure)||failure.source!==source||!['start','resume'].includes(failure.operation)||!Number.isSafeInteger(failure.at)||failure.at<=0||sameLogin(source,state.cloud?.active))return '';
 if(health?.status==='connected'&&Number.isSafeInteger(health.checkedAt)&&health.checkedAt>=failure.at||Date.parse(state.platforms?.[source]?.last_success_at)>=failure.at)return '';
 const stages={launch:'启动云浏览器',connect:'恢复云浏览器连接',pages:'读取浏览器页面',navigate:'打开平台页面',create_cdp:'准备登录窗口',get_live_view:'生成登录窗口链接',validate_live_view:'校验登录窗口链接',detach_cdp:'移交登录窗口',update_state:'保存登录流程状态',disconnect:'释放云浏览器控制连接'};
 const categories={deadline_exceeded:'超过本次运行时间',session_expired:'本次登录已过期',missing_cloud_session:'云浏览器未返回有效会话',unexpected_page_count:'浏览器页面状态异常',invalid_live_view:'登录链接校验未通过',timeout:'等待响应超时',protocol:'云浏览器通信失败',target_closed:'远端登录页面已关闭',type_error:'当前浏览器接口暂时无法使用',aborted:'本次操作已中止',provider_acquire:'云浏览器服务未能创建会话',provider_connect:'云浏览器服务暂时无法连接',navigation:'平台页面未能打开',unknown:'原因暂未确定'};
 const stage=typeof failure.stage==='string'&&Object.hasOwn(stages,failure.stage)?stages[failure.stage]:'云端登录',category=typeof failure.category==='string'&&Object.hasOwn(categories,failure.category)?categories[failure.category]:'原因暂未确定';
 return (failure.operation==='resume'?'上次恢复登录窗口':'上次连接')+'未完成：'+stage+'时，'+category+'。时间：'+syncTime(failure.at)+'。';
}
function renderSyncStatus(value){
 const state=syncView(value);CLOUD_SYNC_VIEW=state;document.getElementById('schedule-state').textContent=syncModeText(state);document.getElementById('budget-state').textContent=budgetText(state);
 const active=state.cloud?.active;
 for(const source of Object.keys(PLATFORM_NAMES)){
  document.getElementById('connection-'+source).textContent=sourceConnectionText(source,state);document.getElementById('success-'+source).textContent='最近成功：'+syncTime(state.platforms?.[source]?.last_success_at);
  const own=sameLogin(source,active),canResume=resumableLogin(source,active),connect=document.getElementById('connect-'+source),cancel=document.getElementById('cancel-'+source);
  connect.textContent=own?'重新打开登录窗口':'连接平台';connect.disabled=CLOUD_SYNC_BUSY||!!active&&!canResume;
  const shortConnect=document.getElementById('short-connect-'+source);shortConnect.hidden=!canStartShortLogin(state);shortConnect.disabled=CLOUD_SYNC_BUSY||!canStartShortLogin(state);
  document.getElementById('finish-'+source).disabled=CLOUD_SYNC_BUSY||!canResume;
  cancel.hidden=!own;cancel.disabled=CLOUD_SYNC_BUSY;
  const issue=state.platforms?.[source]?.last_error;document.getElementById('issue-'+source).textContent=loginFailureText(source,state)||(issue&&issue!=='awaiting_first_sync'&&issue!=='auth_required'?syncErrorText(issue):'');
  const link=document.getElementById('login-link-'+source),hint=document.getElementById('login-hint-'+source);
  if(!canResume){link.hidden=true;link.removeAttribute('href');}
  if(own){hint.textContent=canResume?'登录窗口有效至 '+syncTime(active.deadlineAt)+'。窗口没打开或本页刷新后，可点“重新打开登录窗口”；放弃本次可点“取消本次登录”。':active.phase==='finishing'?'正在核对平台登录，请稍候。':'正在结束本次登录，请稍候；也可点击“取消本次登录”重试关闭。';}
  else if(active){hint.textContent='请先完成或取消 '+(PLATFORM_NAMES[active.source]||'当前')+' 的'+(active.kind==='login'?'登录':'同步')+'。';}
  else{hint.textContent=canStartShortLogin(state)?'短时连接最多45秒，包含页面加载、登录核验和保存；实际手动输入时间可能更短。':'';}
 }
 document.getElementById('run-sync').disabled=CLOUD_SYNC_BUSY||!!active;
 document.getElementById('enable-sync').disabled=CLOUD_SYNC_BUSY||state.automatic_enabled;
 document.getElementById('pause-sync').disabled=CLOUD_SYNC_BUSY||!state.automatic_enabled;
}
async function cloudRequest(path,payload){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),payload===undefined?12000:35000);
 try{const response=await fetch(path,{...(payload===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),signal:controller.signal});if(response.status===401){window.location.replace('/login');throw new Error(syncErrorText(null,401));}let data;try{data=await response.json();}catch{throw new Error(syncErrorText(null,response.status));}if(!response.ok||data.error)throw new Error(syncErrorText(data.reason||data.code||data.error,response.status));return data;}
 catch(error){if(controller.signal.aborted)throw new Error('请求暂时没有响应，正在重新检查登录状态；请勿反复创建登录窗口。');throw error;}finally{clearTimeout(timer);}
}
async function refreshSyncStatus(){const revision=++CLOUD_SYNC_REVISION;try{const state=await cloudRequest('/api/cloud-sync/status');if(revision===CLOUD_SYNC_REVISION)renderSyncStatus(state);}catch(error){if(revision===CLOUD_SYNC_REVISION)document.getElementById('operation-message').textContent=error instanceof TypeError?'网络连接暂时不可用，请稍后重试。':error.message;}}
function validatedLiveView(value){try{const url=new URL(value);return url.origin==='https://live.browser.run'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function showLoginPopupFailure(popup,initialDocument){
 try{
  if(!popup||popup.closed||!initialDocument||popup.document!==initialDocument||popup.location.href!=='about:blank')return;
  const doc=initialDocument,title=doc.createElement('h1'),detail=doc.createElement('p'),help=doc.createElement('p'),back=doc.createElement('a');
  doc.title='平台连接未完成';title.textContent='平台连接未完成';
  detail.textContent='尚未打开云端登录页面。请返回同步设置查看具体提示。';
  help.textContent='如果本次登录会话仍有效，可以选择“重新打开登录窗口”或“取消本次登录”。请勿连续重复连接。';
  back.textContent='返回同步设置';back.href=new URL('/sync',window.location.href).href;
  doc.body.replaceChildren(title,detail,help,back);
 }catch{}
}
async function performSyncAction(action,source){
 if(CLOUD_SYNC_BUSY)return;
 const shortLogin=action==='short-login';if(shortLogin){if(!canStartShortLogin(CLOUD_SYNC_VIEW)){document.getElementById('operation-message').textContent='短时连接当前不可用，请查看最新运行状态和免费预算。';return;}action='login';}
 if(action==='login'&&sameLogin(source,CLOUD_SYNC_VIEW.cloud?.active)){if(!resumableLogin(source,CLOUD_SYNC_VIEW.cloud.active)){await refreshSyncStatus();return;}action='resume';}
 let popup=null,popupDocument=null;if((action==='login'||action==='resume')&&typeof window.open==='function'){try{popup=window.open('about:blank','_blank');if(popup){popup.opener=null;popupDocument=popup.document;popupDocument.title='正在打开平台登录';popupDocument.body.textContent='正在连接平台，请稍候。';}}catch{popup=null;popupDocument=null;}}
 CLOUD_SYNC_BUSY=true;++CLOUD_SYNC_REVISION;renderSyncStatus(CLOUD_SYNC_VIEW);const message=document.getElementById('operation-message');message.textContent=action==='login'||action==='resume'?'正在准备平台登录窗口…':action==='finish'?'正在确认平台登录…':'正在提交…';
 try{
  const path='/api/cloud-sync/'+(action==='enable'||action==='pause'?'config':action),payload=source?{source,...(shortLogin?{shortLogin:true}:{})}:action==='enable'?{enabled:true}:action==='pause'?{enabled:false}:{};
  const response=await cloudRequest(path,payload);
  if(action==='login'||action==='resume'){
   const link=validatedLiveView(response.liveViewUrl);if(!link)throw new Error(response.reason==='daily_budget'?'当前免费运行预算不足以创建登录窗口。请查看上方预计恢复时间，预算恢复后再连接；现有订单已保留。':syncErrorText(response.reason||response.status));
   await refreshSyncStatus();const current=CLOUD_SYNC_VIEW.cloud?.active;
   if(!resumableLogin(source,current)||Number(current.deadlineAt)!==Number(response.deadlineAt??response.expiresAt))throw new Error('本次登录窗口已结束，请根据当前状态重新连接。');
   const element=document.getElementById('login-link-'+source);element.href=link;element.hidden=false;
   document.getElementById('login-hint-'+source).textContent='请在新窗口登录，完成后返回点击“完成登录”。窗口有效至 '+syncTime(response.expiresAt)+'。';
   if(popup&&!popup.closed){popup.location.replace(link);popup=null;}
   message.textContent=(shortLogin?'短时连接最多45秒，包含页面加载、登录核验和保存；实际手动输入时间可能更短。':'')+'请在 '+PLATFORM_NAMES[source]+' 登录窗口完成登录后返回确认。若窗口未打开，可点击下方“打开登录窗口”。';
  }else if(action==='finish'){
   if(response.status!=='connected')throw new Error(syncErrorText(response.reason||response.status));
   message.textContent=PLATFORM_NAMES[source]+' 已连接。点击“立即同步”读取最新订单。';await refreshSyncStatus();
  }else if(action==='cancel'){
   if(!['cancelled','close_pending'].includes(response.status)&&response.reason!=='no_active_login')throw new Error(syncErrorText(response.reason||response.status));
   message.textContent=response.status==='close_pending'?'正在关闭云端登录窗口，确认结束后会恢复其他平台按钮。':'本次登录已结束，可以连接其他平台。';await refreshSyncStatus();
  }else if(action==='run'){
   message.textContent=response.status==='queued'?'订单同步已排队，完成后会更新各平台成功时间。':response.status==='busy'?syncErrorText('busy'):syncErrorText(response.reason||response.status);
   await refreshSyncStatus();
  }else{if(response.reason||['unavailable','quota','skipped'].includes(response.status))throw new Error(syncErrorText(response.reason||response.status));message.textContent=action==='enable'?'定时同步已启用；实际结果以各平台最近成功时间为准。':'定时同步已暂停。';await refreshSyncStatus();}
 }catch(error){showLoginPopupFailure(popup,popupDocument);await refreshSyncStatus();message.textContent=error instanceof TypeError?'网络连接暂时不可用，请稍后重试。':error.message;}
 finally{CLOUD_SYNC_BUSY=false;renderSyncStatus(CLOUD_SYNC_VIEW);}
}
function resumeStatusUpdates(){if(CLOUD_SYNC_TIMER===null)CLOUD_SYNC_TIMER=setInterval(()=>{if(!document.hidden&&!CLOUD_SYNC_BUSY)refreshSyncStatus();},5000);if(!CLOUD_SYNC_BUSY)refreshSyncStatus();}
function initializeSyncSettings(){for(const source of Object.keys(PLATFORM_NAMES)){document.getElementById('connect-'+source).addEventListener('click',()=>performSyncAction('login',source));document.getElementById('short-connect-'+source).addEventListener('click',()=>performSyncAction('short-login',source));document.getElementById('finish-'+source).addEventListener('click',()=>performSyncAction('finish',source));document.getElementById('cancel-'+source).addEventListener('click',()=>performSyncAction('cancel',source));}document.getElementById('run-sync').addEventListener('click',()=>performSyncAction('run'));document.getElementById('enable-sync').addEventListener('click',()=>performSyncAction('enable'));document.getElementById('pause-sync').addEventListener('click',()=>performSyncAction('pause'));resumeStatusUpdates();window.addEventListener('pageshow',resumeStatusUpdates);window.addEventListener('pagehide',()=>{clearInterval(CLOUD_SYNC_TIMER);CLOUD_SYNC_TIMER=null;++CLOUD_SYNC_REVISION;});document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeStatusUpdates();});}
initializeSyncSettings();
`;

function buildSyncMaintenancePage(){
 const style=`:root{color-scheme:light dark;--bg:#f1f5f7;--card:#fff;--text:#203541;--muted:#526773;--line:#bdcdd6;--accent:#176674;--soft:#eaf1f4;font-family:"Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;padding:28px 20px;background:var(--bg);color:var(--text);line-height:1.7}.shell{max-width:920px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.brand{font-size:.75rem;letter-spacing:.14em;font-weight:700;color:var(--accent);margin:0}h1{font-size:1.65rem;margin:4px 0 0}h2{font-size:1.0625rem;margin:0 0 8px}a{color:var(--accent);font-weight:600}a:visited{color:var(--accent)}.intro{margin:0 0 20px;color:var(--muted)}.platforms{display:grid;gap:14px}.platform{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--card)}.status{font-size:.9375rem;margin:0 0 6px}.time,.hint,.issue{font-size:.8125rem;color:var(--muted);margin:5px 0;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}button{min-height:46px;font:inherit;font-size:.875rem;font-weight:650;padding:9px 15px;border:1px solid var(--accent);border-radius:9px;cursor:pointer;background:var(--accent);color:#fff}.secondary{background:var(--card);color:var(--accent)}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.login-link{display:inline-block;margin-top:8px;font-size:.875rem}.controls{margin-top:22px;border:1px solid var(--line);border-radius:14px;padding:22px;background:var(--card)}.controls p{margin:5px 0 12px;color:var(--muted);font-size:.875rem}.message{font-size:.875rem;padding:14px 16px;background:var(--soft);border-radius:10px;margin-top:18px;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:640px){body{padding:22px 16px}.platform{grid-template-columns:1fr;padding:18px;gap:10px}header{align-items:flex-start}header>a{font-size:.8125rem}.controls{padding:18px}.actions button{flex:1}h1{font-size:1.4rem}}@media(prefers-color-scheme:dark){:root{--bg:#142129;--card:#1b2d38;--text:#e1ebf0;--muted:#b3c4ce;--line:#586e7b;--accent:#9cd3db;--soft:#263c49}button{color:#102e35}.secondary{color:var(--accent)}}`;
 const platformRows=[['boataround','Boataround'],['clickandboat','Click&Boat'],['samboat','SamBoat']].map(([source,label])=>`<article class="platform"><div><h2>${label.replace('&','&amp;')}</h2><p id="connection-${source}" class="status">正在读取连接状态…</p><p id="success-${source}" class="time">最近成功：尚未成功同步</p><p id="issue-${source}" class="issue"></p><a id="login-link-${source}" class="login-link" target="_blank" rel="noopener noreferrer" hidden>打开登录窗口 ↗</a><p id="login-hint-${source}" class="hint"></p></div><div class="actions"><button id="connect-${source}" class="secondary" type="button">连接平台</button><button id="short-connect-${source}" class="secondary" type="button" hidden disabled>短时连接（最多45秒）</button><button id="finish-${source}" type="button" disabled>完成登录</button><button id="cancel-${source}" class="secondary" type="button" hidden>取消本次登录</button></div></article>`).join('');
 const script=sharedScript+maintenanceScript;
 const html=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>同步设置 · Tidewyn Charters</title><style>${style}</style></head><body><main class="shell"><header><div><p class="brand">TIDEWYN CHARTERS</p><h1>同步设置</h1></div><a href="/">返回订单看板</a></header><p class="intro">依次连接三个平台，在新窗口完成登录后返回确认。同步结果保存在云端；电脑关闭后，已启用的定时同步仍可按计划运行。</p><section class="platforms" aria-label="平台连接">${platformRows}</section><section class="controls" aria-label="同步控制"><p id="schedule-state">正在读取定时同步状态…</p><p id="budget-state">正在读取免费运行预算…</p><div class="actions"><button id="run-sync" type="button">立即同步</button><button id="enable-sync" class="secondary" type="button">启用定时同步</button><button id="pause-sync" class="secondary" type="button" disabled>暂停定时同步</button></div></section><p id="operation-message" class="message" role="status" aria-live="polite">请先连接平台，再读取最新订单。</p></main><script>${script}</script></body></html>`;
 const hash=value=>createHash('sha256').update(value).digest('base64');
 const csp=`default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`;
 return {html,csp};
}

function patchSyncFrontend(source){
 const htmlAt=source.indexOf('var HTML ='),loginAt=source.indexOf('var LOGIN_HTML =',htmlAt);
 if(htmlAt<0||loginAt<0)throw new Error('Dashboard HTML markers not found');
 let html=vm.runInNewContext(source.slice(htmlAt,loginAt)+';HTML');
 const button='<button id="refreshBtn" class="secondary" type="button">刷新数据</button>';
 if(!html.includes(button))throw new Error('Dashboard refresh button anchor not found');
 html=html.replace(button,button.replace('刷新数据','立即同步'));
 const note='<p class="query-note">按入住日至退房前一晚查询，最终以平台确认为准。</p>';
 if(!html.includes(note))throw new Error('Dashboard query note anchor not found');
 html=html.replace(note,note.replace('</p>',' <a href="/sync">手机同步设置</a></p>'));
 const notes=/<details class="data-notes">[\s\S]*?<\/details>/;
 if(!notes.test(html))throw new Error('Data explanation panel not found');
 html=html.replace(notes,'<details class="data-notes"><summary>数据说明</summary><p>仅有效订单影响可用状态，按入住日至退房前一晚计算。<span id="syncMode">正在读取同步状态…</span> <a href="/sync">同步设置</a></p><p><span id="bookingVerifiedAt">正在读取各平台最近成功时间…</span></p><p id="dataIssues"></p></details>');
 const renderStart=html.indexOf('function render(){'),initStart=html.indexOf('function initialize(){',renderStart);
 if(renderStart<0||initStart<0)throw new Error('Dashboard render/loadData functions not found');
 html=html.slice(0,renderStart)+sharedScript+mainScript+html.slice(initStart);
 source=source.slice(0,htmlAt)+'var HTML = '+JSON.stringify(html)+';\n'+source.slice(loginAt);
 const cspStart=source.indexOf('var PAGE_CSP ='),cspEnd=source.indexOf('var SESSION_COOKIE =',cspStart);
 const csp=vm.runInNewContext(source.slice(cspStart,cspEnd)+';PAGE_CSP');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],scriptHash=createHash('sha256').update(script).digest('base64');
 csp.dashboard=csp.dashboard.replace(/script-src 'sha256-[A-Za-z0-9+/=]+'/,"script-src 'sha256-"+scriptHash+"'");
 source=source.slice(0,cspStart)+'var PAGE_CSP = '+JSON.stringify(csp)+';\n'+source.slice(cspEnd);
 const settings=buildSyncMaintenancePage(),pageStart=source.indexOf('var ORDER_SYNC_HTML ='),pageEnd=source.indexOf('function orderRegistry(env)',pageStart);
 if(pageStart<0||pageEnd<0)throw new Error('Apply patchOrderSync before patchSyncFrontend');
 source=source.slice(0,pageStart)+'var ORDER_SYNC_HTML = '+JSON.stringify(settings.html)+';\nvar ORDER_SYNC_CSP = '+JSON.stringify(settings.csp)+';\n'+source.slice(pageEnd);
 return source;
}

module.exports={patchSyncFrontend,buildSyncMaintenancePage,phoneSyncScript};
