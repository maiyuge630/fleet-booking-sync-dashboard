// Inline dashboard extension; all customer text is escaped before rendering.
let MANUAL_ORDERS=null,MANUAL_ORDER_ERROR=false,MANUAL_ORDER_BUSY=false,MANUAL_ORDER_PENDING=null,MANUAL_ORDER_MESSAGE='',MANUAL_ORDER_CANCEL=null,MANUAL_ORDER_JUMP=null;
const MANUAL_ORDER_OPEN=new Set(),MANUAL_ORDER_STORAGE='fleet-manual-orders-v1';
try{const p=JSON.parse(sessionStorage.getItem(MANUAL_ORDER_STORAGE)||'null');if(p&&['add','cancel'].includes(p.action)&&typeof p.request_id==='string')MANUAL_ORDER_PENDING=p;}catch{}
function manualOrderSavePending(){try{if(MANUAL_ORDER_PENDING)sessionStorage.setItem(MANUAL_ORDER_STORAGE,JSON.stringify(MANUAL_ORDER_PENDING));else sessionStorage.removeItem(MANUAL_ORDER_STORAGE);}catch{}}
function manualOrderRecords(){return MANUAL_ORDERS?.orders||[];}
function manualOrderBookings(boat){return manualOrderRecords().filter(o=>o.active&&o.boat===boat.boataround_slug&&shiftDay(o.end,-1)>=beijingToday()).map(o=>({source:'manual',booking_id:o.id,status:o.payment_status,start:o.start,end:shiftDay(o.end,-1),manual_order:o}));}
function manualOrderBlock(h){const o=manualOrderRecords().find(o=>o.id===h.id&&o.active);return {start:h.start,end:shiftDay(h.end,-1),fleet_hold:!o,reason:o?o.name:'手动锁档',booking:o?{source:'manual',booking_id:o.id,status:o.payment_status,start:o.start,end:shiftDay(o.end,-1),manual_order:o}:null};}
function manualOrderQueryRow(b){return '<div class="occLine">'+esc(b.manual_order.name)+' · '+esc(b.manual_order.channel)+' · '+(b.status==='paid'?'已收全款':'已收定金')+'<strong>'+esc(b.start)+' 至 '+esc(b.end)+'（含当天）</strong></div>';}
function manualOrderCause(key){const o=manualOrderRecords().find(o=>'manual-hold:'+o.id===key);return o?'手动订单：'+o.name+'（'+o.channel+'）':key;}
function manualOrderTargetNote(target){const count=manualOrderRecords().filter(o=>o.active&&o.boat===target.boat&&o.end>beijingToday()).length;return count?'<p>另有 '+count+' 笔手动订单参与关档。</p>':'';}
const MANUAL_KNOWN_ORDERS=knownOrders,MANUAL_BOAT_CONFLICTS=boatBookingConflicts,MANUAL_CONFLICT_LINK=bookingConflictOrderLink;
knownOrders=function(boat){return [...MANUAL_KNOWN_ORDERS(boat),...manualOrderBookings(boat)];};
boatBookingConflicts=function(boat){return MANUAL_BOAT_CONFLICTS({...boat,bookings:[...(boat.bookings||[]),...manualOrderBookings(boat)]});};
bookingConflictOrderLink=function(b){return b.source==='manual'?'<span>'+esc(b.manual_order?.name||'手动订单')+' · '+esc(b.manual_order?.channel||'其他渠道')+'</span>':MANUAL_CONFLICT_LINK(b);};
function applyManualOrders(data){
 if(data?.ok!==true||data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!Array.isArray(data.orders)||!data.fleet_control||!Array.isArray(data.fleet_control.holds)||!Array.isArray(data.fleet_control.manual_order_ids))throw Error('manual_order_read_failed');
 const seen=new Set();for(const o of data.orders){const h=data.fleet_control.holds.find(h=>h.id===o?.id);if(!o||typeof o.id!=='string'||seen.has(o.id)||typeof o.name!=='string'||typeof o.channel!=='string'||!['paid','deposit_paid'].includes(o.payment_status)||typeof o.active!=='boolean'||!baValidDay(o.start)||!baValidDay(o.end)||o.start>=o.end||!h||h.boat!==o.boat||h.start!==o.start||h.end!==o.end||h.active!==o.active)throw Error('manual_order_read_failed');seen.add(o.id);}
 if(!MANUAL_ORDERS||data.revision>=MANUAL_ORDERS.revision)MANUAL_ORDERS=data;
 applyFleetHoldControl(data.fleet_control);MANUAL_ORDER_ERROR=false;
}
async function readManualOrders(render=true){
 try{const {response,data}=await dashboardRequest('/api/manual-orders');if(!response.ok)throw Error('manual_order_read_failed');applyManualOrders(data);}catch{MANUAL_ORDER_ERROR=true;}
 if(render){renderManualOrders();if(DATA)renderBoats();}
}
function manualOrderSync(o){return '<details class="manual-order-sync" data-manual-order-id="'+esc(o.id)+'"'+(MANUAL_ORDER_OPEN.has(o.id)?' open':'')+'><summary>查看各平台同步状态</summary>'+fleetHoldPlatformHTML(o)+'</details>';}
function manualOrderCancelButton(o){
 if(!o.active)return '';
 const disabled=MANUAL_ORDER_BUSY||MANUAL_ORDER_PENDING||MANUAL_ORDER_ERROR?' disabled':'';
 return MANUAL_ORDER_CANCEL===o.id?'<div class="manual-order-confirm"><p>取消「'+esc(o.name)+'」？将撤销这笔订单的占用，其他订单和人工锁档继续保留。</p><button type="button" data-manual-confirm="'+esc(o.id)+'"'+disabled+'>确认取消订单</button> <button type="button" data-manual-keep="'+esc(o.id)+'">保留订单</button></div>':'<button type="button" class="manual-order-cancel" data-manual-cancel="'+esc(o.id)+'"'+disabled+'>取消订单</button>';
}
function manualOrderCard(b,conflict){
 const o=b.manual_order;
 return '<article class="boat-booking manual-order-card'+(conflict?' boat-booking-conflict':'')+'" data-booking-id="'+esc(o.id)+'"><div class="boat-booking-heading"><span class="boat-booking-platform">'+esc(o.name)+'</span><span class="boat-booking-status">'+(o.payment_status==='paid'?'已收全款':'已收定金')+(conflict?'<strong class="booking-conflict-badge">疑似撞单</strong>':'')+'</span></div><p class="manual-order-channel">手动订单 · '+esc(o.channel)+'</p><div class="boat-booking-dates"><span><small>开始日期</small><strong>'+esc(b.start)+'</strong></span><span class="boat-date-arrow" aria-hidden="true">→</span><span><small>结束日期（含当天）</small><strong>'+esc(b.end)+'</strong></span></div><p class="manual-order-note">收款状态由人工确认</p>'+manualOrderSync(o)+manualOrderCancelButton(o)+'</article>';
}
function renderManualOrders(){
 const form=document.getElementById('manual-order-form');if(!form)return;
 if(MANUAL_ORDER_JUMP&&!manualOrderRecords().some(o=>o.id===MANUAL_ORDER_JUMP&&o.active))MANUAL_ORDER_JUMP=null;
 const select=form.elements.boat,options='<option value="">选择船只</option>'+(DATA?.boats||[]).map(b=>'<option value="'+esc(b.boataround_slug)+'"'+(fleetHoldBoatDisabled(b.boataround_slug)?' disabled':'')+'>'+esc(b.name)+(fleetHoldBoatDisabled(b.boataround_slug)?'（人工停用）':'')+'</option>').join('');
 if(select.dataset.options!==options){const chosen=select.value;select.innerHTML=options;select.value=chosen;select.dataset.options=options;}
 for(const n of ['start','end'])if(MANUAL_ORDERS){form.elements[n].min=MANUAL_ORDERS.fleet_control.window_start;form.elements[n].max=shiftDay(MANUAL_ORDERS.fleet_control.window_end,-1);}
 document.getElementById('manual-order-submit').disabled=MANUAL_ORDER_BUSY||!!MANUAL_ORDER_PENDING||MANUAL_ORDER_ERROR||!MANUAL_ORDERS;
 document.getElementById('manual-order-count').textContent=MANUAL_ORDERS?'· '+manualOrderRecords().filter(o=>o.active&&shiftDay(o.end,-1)>=beijingToday()).length+' 笔当前／未来订单':'';
 document.getElementById('manual-order-message').textContent=MANUAL_ORDER_ERROR?'手动订单读取失败，当前显示最近保存的记录，请重新读取。':MANUAL_ORDER_MESSAGE||(MANUAL_ORDER_PENDING?'上次提交结果尚未确认，请重试同一请求。':'保存后会出现在对应船只下方，并安排手机同步关档。');
 document.getElementById('manual-order-actions').innerHTML=(MANUAL_ORDER_ERROR?'<button type="button" id="manual-order-reload">重新读取</button>':'')+(MANUAL_ORDER_PENDING&&!MANUAL_ORDER_BUSY?'<button type="button" id="manual-order-retry">重试确认上次请求</button>':'')+(MANUAL_ORDER_JUMP?'<button type="button" id="manual-order-view">查看刚添加的订单</button>':'');
 const archive=manualOrderRecords().filter(o=>!o.active||shiftDay(o.end,-1)<beijingToday()).slice().reverse();
 document.getElementById('manual-order-history-count').textContent='已结束与已取消 · '+archive.length+' 笔';
 document.getElementById('manual-order-history-list').innerHTML=archive.length?archive.map(o=>'<article class="fleet-hold-record"><strong>'+esc(o.name)+' · '+esc(DATA?.boats?.find(b=>b.boataround_slug===o.boat)?.name||o.boat)+'</strong><p>'+esc(o.channel)+' · '+esc(o.start)+' 至 '+esc(shiftDay(o.end,-1))+'（含当天） · '+(o.active?'已结束':'已取消')+'</p>'+manualOrderSync(o)+manualOrderCancelButton(o)+'</article>').join(''):'<p>暂无历史记录。</p>';
}
const MANUAL_ORDER_ERRORS={manual_order_payment_required:'请确认已收到定金或全款，未付款订单不能计入占用。',manual_order_revision_conflict:'订单已在其他页面更新，请核对最新记录后重新提交。',manual_order_duplicate:'已经存在同名称、来源和日期的有效订单，请勿重复添加。',manual_order_outside_window:'日期超出可管理范围；每笔最多 365 天。',manual_order_invalid_dates:'日期无效，结束日期不能早于开始日期。',boat_manually_disabled:'这艘船已固定停用，不能新增订单。',phone_not_paired:'手机尚未配对，请先恢复手机连接。',invalid_manual_order:'请检查船只、名称、来源、日期及收款状态。',manual_order_limit:'已达到记录容量，请联系维护人员处理。'};
async function submitManualOrder(action,id){
 if(MANUAL_ORDER_BUSY||MANUAL_ORDER_PENDING||MANUAL_ORDER_ERROR||!MANUAL_ORDERS)return;
 const form=document.getElementById('manual-order-form');let payload={action,request_id:crypto.randomUUID(),revision:MANUAL_ORDERS.revision};
 if(action==='add'){if(!form.reportValidity())return;for(const k of ['boat','name','channel','start','end','payment_status'])payload[k]=form.elements[k].value.trim();if(payload.end<payload.start){MANUAL_ORDER_MESSAGE='结束日期不能早于开始日期。';renderManualOrders();return;}}
 else if(action==='cancel'){if(!manualOrderRecords().some(o=>o.id===id&&o.active))return;payload.id=id;}else return;
 MANUAL_ORDER_PENDING=payload;manualOrderSavePending();await sendManualOrderPending();
}
async function sendManualOrderPending(){
 if(MANUAL_ORDER_BUSY||!MANUAL_ORDER_PENDING)return;const p=MANUAL_ORDER_PENDING;MANUAL_ORDER_BUSY=true;MANUAL_ORDER_MESSAGE='正在保存订单并安排手机任务…';renderManualOrders();
 try{const {response,data}=await dashboardRequest('/api/manual-orders',p);
  if(response.status===401){location.replace('/login');throw Error('auth');}
  if(response.status===202&&data?.status==='saved_pending_sync'){
   applyManualOrders(data);MANUAL_ORDER_PENDING=null;MANUAL_ORDER_CANCEL=null;
   const activeAdded=p.action==='add'&&manualOrderRecords().some(o=>o.id===p.request_id&&o.active);
   MANUAL_ORDER_MESSAGE=p.action==='add'?(activeAdded?'手动订单已保存，已安排手机同步。请在该船订单下查看各平台回读结果。':'这次添加请求已处理，但该订单随后已取消；重试不会重新新增。请查看历史记录。'):'订单已取消，已安排手机重新核对档期；其他订单与人工保护仍然保留。';
   MANUAL_ORDER_JUMP=activeAdded?p.request_id:null;
   if(p.action==='add'){const form=document.getElementById('manual-order-form');if(['boat','name','channel','start','end','payment_status'].every(k=>form.elements[k].value.trim()===p[k]))form.reset();if(activeAdded)MANUAL_ORDER_OPEN.add(p.request_id);}
   REVERSE_READ_AT=0;void readReversePreview();
  }else if(response.status>=400&&response.status<500){MANUAL_ORDER_PENDING=null;MANUAL_ORDER_MESSAGE=MANUAL_ORDER_ERRORS[data?.error]||'请求未被接受，请重新读取并核对后再提交。';await readManualOrders(false);}
  else throw Error('uncertain');
 }catch{MANUAL_ORDER_MESSAGE='尚未确认保存结果，请重试确认上次请求，不要重复新增。';}
 finally{MANUAL_ORDER_BUSY=false;manualOrderSavePending();renderManualOrders();if(DATA){renderBoats();if(hasQuery)window.checkAvail();}}
}
document.addEventListener('submit',event=>{if(event.target?.id!=='manual-order-form')return;event.preventDefault();void submitManualOrder('add');});
document.addEventListener('click',event=>{const b=event.target?.closest?.('button');if(!b||b.disabled)return;
 if(b.id==='manual-order-reload')void readManualOrders();else if(b.id==='manual-order-retry')void sendManualOrderPending();
 else if(b.id==='manual-order-view'){const o=manualOrderRecords().find(o=>o.id===MANUAL_ORDER_JUMP),details=Array.from(document.querySelectorAll('details.boat-bookings')).find(d=>d.dataset.boatKey===o?.boat);if(details){details.open=true;details.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}
 else if(b.dataset.manualCancel){MANUAL_ORDER_CANCEL=b.dataset.manualCancel;renderManualOrders();renderBoats();}
 else if(b.dataset.manualKeep){MANUAL_ORDER_CANCEL=null;renderManualOrders();renderBoats();}
 else if(b.dataset.manualConfirm)void submitManualOrder('cancel',b.dataset.manualConfirm);
});
document.addEventListener('toggle',event=>{const e=event.target;if(e?.matches?.('details.manual-order-sync')){if(e.open)MANUAL_ORDER_OPEN.add(e.dataset.manualOrderId);else MANUAL_ORDER_OPEN.delete(e.dataset.manualOrderId);}},true);
