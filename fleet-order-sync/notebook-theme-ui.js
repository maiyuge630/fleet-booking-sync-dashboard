// 手账风看板（用户 2026-10-13 选的方向 C）：标题旁的老鼠和“立即同步”放在一起，
// 只说看板上已有的状态。干活的姿势只在手机真的在同步时出现；没有“成功”动画，
// 也不说“全部正常”——订单读到了只说“订单已更新”和时间。
const MASCOT_IMAGES={idle:'__MASCOT_IDLE__',busy:'__MASCOT_BUSY__'};
let MASCOT_READ_FAILED=false;
function mascotTime(value){
 const time=Date.parse(value);if(!Number.isFinite(time))return '';
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time)).map(x=>[x.type,x.value]));
 return Number(p.month)+'月'+Number(p.day)+'日 '+p.hour+':'+p.minute;
}
// The same problems the dashboard already flags, each with a link to it.
function mascotItems(){
 const items=[];if(!DATA)return items;
 if(MASCOT_READ_FAILED)items.push({text:'最近一次读取失败，下面是上次保存的订单',href:'#meta'});
 if(phoneMode()&&PHONE_SYNC_STATUS?.paired===false)items.push({text:'手机未配对',href:'/sync'});
 else if(phoneMode()&&PHONE_SYNC_STATUS?.online===false)items.push({text:'手机未连接',href:'/sync'});
 const run=PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS);
 if(run?.retryable)items.push({text:'上次同步没有上传完，请点“重新同步”',href:'#refreshBtn'});
 const state=syncView(DATA.order_sync);
 for(const source of ['boataround','clickandboat','samboat','mmk','nausys']){
  const error=state.platforms?.[source]?.last_error;
  if(error&&error!=='awaiting_first_sync')items.push({text:srcLabel(source)+(error==='auth_required'?' 登录已过期':' 订单读取失败'),href:'#dataIssues'});
 }
 const pairs=DATA.boats.reduce((sum,boat)=>sum+dashboardBookingConflicts(boat).pairs.length,0);
 if(pairs)items.push({text:'订单日期重叠 '+pairs+' 组',href:'#booking-conflicts-overview'});
 for(const boat of DATA.boats)if(releaseReviewTargets(boat).length)items.push({text:revenueBoatCode(boat)+' 恢复可预订待核验',href:'#'+releaseReviewAnchor(boat)});
 // Voltage cards already turn yellow for these; AD3 shows no voltage at all.
 for(const device of DATA.order_sync?.voltage?.devices||[]){
  const boat=DATA.boats.find(b=>b.boataround_slug===device.boat);if(!boat||boat.boataround_slug==='bluecat-42-tidewyn-discovery-3')continue;
  const problem=device.low_voltage?'电压过低':device.power==='power_off'?'外接电源断开':device.power==='backup_low'?'外接断电，备用电量低':'';
  if(problem)items.push({text:revenueBoatCode(boat)+' '+problem,href:'#voltage-'+boat.boataround_slug});
 }
 return items;
}
function mascotView(){
 if(!DATA)return MASCOT_READ_FAILED&&!ORDER_SYNC_LOADING?{pose:'idle',tone:'alert',title:'暂时读不到订单',detail:'请稍后点“立即同步”重试。',items:[]}:{pose:'idle',tone:'quiet',title:'正在读取订单…',detail:'',items:[]};
 const items=mascotItems(),run=PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS);
 if(run?.pending&&!run.retryable&&run.phase==='queued')return {pose:'idle',tone:'quiet',title:'同步已排队',detail:PHONE_SYNC_STATUS.online===false?'等手机连上后开始。':'等手机开始。',items};
 if(run?.pending&&!run.retryable||PHONE_SYNC_STATUS?.state==='running'){
  const counted=run?.pending&&run.phase!=='queued';
  return {pose:'busy',tone:'busy',title:'正在同步…',detail:counted?'已收到 '+Object.keys(run.results).length+'/'+run.sources.length+' 个平台':'手机正在读取各平台订单',items};
 }
 if(items.length)return {pose:'idle',tone:'alert',title:'需要你看 · '+items.length+' 项',detail:'',items};
 const state=syncView(DATA.order_sync),all=allOrderSuccess(state);
 if(!all)return {pose:'idle',tone:'quiet',title:'还有平台没有同步记录',detail:'各平台的时间见“数据说明”。',items};
 const next=phoneMode()&&state.automatic_enabled&&state.next_attempt_at?mascotTime(state.next_attempt_at):'';
 return {pose:'idle',tone:'calm',title:'订单已更新',detail:mascotTime(all)+(next?' · 下次自动同步 '+next.replace(/^.*日 /,''):''),items};
}
function renderMascot(){
 // The unit tests' stand-in pages have no dataset; a browser page always does.
 const root=document.getElementById('mascot-station');if(!root?.dataset)return;
 const view=mascotView(),image=document.getElementById('mascot-image');
 root.dataset.tone=view.tone;root.dataset.pose=view.pose;
 if(image.dataset.pose!==view.pose){image.src=MASCOT_IMAGES[view.pose];image.dataset.pose=view.pose;}
 document.getElementById('mascot-title').textContent=view.title;
 const detail=document.getElementById('mascot-detail');detail.textContent=view.detail;detail.hidden=!view.detail;
 const list=document.getElementById('mascot-items');list.hidden=!view.items.length;
 list.innerHTML=view.items.map(item=>'<li><a href="'+esc(item.href)+'">'+esc(item.text)+'</a></li>').join('');
}
// Links into folded sections open them first.
document.getElementById('mascot-items')?.addEventListener?.('click',event=>{
 const link=event.target.closest?.('a[href^="#"]');if(!link)return;
 const target=document.getElementById(link.getAttribute('href').slice(1));if(!target)return;
 event.preventDefault();
 for(let node=target.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
 target.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 const focus=target.tagName==='DETAILS'?target.querySelector('summary'):target.matches('button,a,summary,[tabindex]')?target:null;
 focus?.focus({preventScroll:true});
});
function notebookFleet(){
 const size=document.getElementById('fleet-size');if(DATA&&size)size.textContent=DATA.boats.length+'艘船 · 可查看未来15个月';
 if(typeof document.createElement!=='function')return;
 for(const node of document.querySelectorAll('#boats details.boat-voltage'))node.id='voltage-'+node.dataset.boatKey;
 for(const empty of document.querySelectorAll('#boats .boat-bookings-empty')){
  if(empty.querySelector('img'))continue;
  const image=document.createElement('img');image.className='mascot-empty';image.src=MASCOT_IMAGES.idle;image.alt='';image.width=56;image.height=56;empty.prepend(image);
 }
}
// The button now sits in plain sight beside the mascot. Background status
// reads (every 5–30 s) keep its label; it is still disabled while one runs.
let NOTEBOOK_SUBMITTING=false;
const NOTEBOOK_UPDATE_SYNC_BUTTON=updateSyncButton;
updateSyncButton=function(){
 NOTEBOOK_UPDATE_SYNC_BUTTON();
 const button=document.getElementById('refreshBtn'),run=PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS),blocked=run?.pending&&!run.retryable;
 if(button&&ORDER_SYNC_LOADING&&(NOTEBOOK_SUBMITTING||DATA))button.textContent=NOTEBOOK_SUBMITTING?'正在提交…':blocked?(run.phase==='queued'?'已排队':'同步中…'):run?.retryable?'重新同步':'立即同步';
 renderMascot();
};
const NOTEBOOK_RENDER_BOATS=renderBoats;
renderBoats=function(){NOTEBOOK_RENDER_BOATS();notebookFleet();renderMascot();};
// A finished read replaces DATA; an unchanged DATA means the read failed.
// Calls that return at once (a read already running, a run already pending)
// say nothing about the last read.
const NOTEBOOK_LOAD_DATA=loadData;
loadData=async function(force){
 const run=force&&PHONE_SYNC_STATUS&&phoneRunProgress(PHONE_SYNC_STATUS),skipped=ORDER_SYNC_LOADING||!!(run?.pending&&!run.retryable),before=DATA;
 if(!skipped)NOTEBOOK_SUBMITTING=force===true;
 try{await NOTEBOOK_LOAD_DATA(force);}
 finally{if(!skipped){NOTEBOOK_SUBMITTING=false;MASCOT_READ_FAILED=DATA===before;updateSyncButton();}}
};
renderMascot();
