import {FLEET,dateRange,isoDate} from './parsers.mjs';
import {readHoldState,holdWindow,AC2_BOAT} from './reverse-sync/boataround-holds.mjs';
import {publicFleetHolds} from './reverse-sync/fleet-holds.mjs';

export const MANUAL_ORDERS_KEY='orders:manual:v1';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{status});};
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const day=v=>{if(typeof v!=='string'||isoDate(v)!==v)throw Error('noncanonical_day');return v;};
export function readManualOrders(value){
  if(value===undefined)return {version:1,revision:0,orders:[],requests:[]};
  if(!value||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.orders)||!Array.isArray(value.requests)||value.orders.length>1000||value.requests.length>4000)fail('manual_order_state_invalid',503);
  const ids=new Set(),requests=new Set();
  for(const o of value.orders){
    if(!uuid(o?.id)||ids.has(o.id)||!FLEET.some(b=>b.slug===o.boat)||o.boat===AC2_BOAT||!text(o.name,100)||!text(o.channel,60)||!['deposit_paid','paid'].includes(o.payment_status)||typeof o.active!=='boolean'||!Number.isFinite(Date.parse(o.created_at))||!(o.cancelled_at===null&&o.active||!o.active&&Number.isFinite(Date.parse(o.cancelled_at))))fail('manual_order_state_invalid',503);
    try{day(o.start);day(o.end);dateRange(o.start,o.end);}catch{fail('manual_order_state_invalid',503);}
    ids.add(o.id);
  }
  for(const r of value.requests){if(!uuid(r?.request_id)||requests.has(r.request_id)||typeof r.fingerprint!=='string'||!Number.isSafeInteger(r.revision)||r.revision<0||r.revision>value.revision)fail('manual_order_state_invalid',503);requests.add(r.request_id);}
  return structuredClone(value);
}
// Every manual order owns its own control cause, even if another order or an
// existing manual lock has identical dates. Cancellation cannot release it.
export function checkManualOrderHolds(orders,holds){
  for(const o of orders.orders){const h=holds.holds.find(h=>h.id===o.id);if(!h||h.boat!==o.boat||h.start!==o.start||h.end!==o.end||h.active!==o.active)fail('manual_order_control_mismatch',503);}
}
export function publicManualOrders(value,holdValue,now){
  const state=readManualOrders(value),holds=readHoldState(holdValue);checkManualOrderHolds(state,holds);
  return {ok:true,version:1,revision:state.revision,orders:state.orders,fleet_control:{...publicFleetHolds(holds,now),manual_order_ids:state.orders.map(o=>o.id)}};
}
export function mutateManualOrders(value,holdValue,legacyValue,input,now){
  const state=readManualOrders(value),holds=readHoldState(holdValue),legacy=readHoldState(legacyValue);checkManualOrderHolds(state,holds);
  if(!input||!['add','cancel'].includes(input.action)||!uuid(input.request_id)||!Number.isSafeInteger(input.revision)||input.revision<0)fail('invalid_manual_order');
  const keys=input.action==='add'?['action','request_id','revision','boat','name','channel','start','end','payment_status']:['action','request_id','revision','id'];
  if(Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>input[k]===undefined))fail('invalid_manual_order');
  const fingerprint=JSON.stringify(keys.map(k=>input[k])),previous=state.requests.find(r=>r.request_id===input.request_id);
  if(previous){if(previous.fingerprint!==fingerprint)fail('manual_order_request_conflict',409);return {state,holds,changed:false,idempotent:true};}
  if(input.revision!==state.revision)fail('manual_order_revision_conflict',409);
  if(state.requests.length>=4000)fail('manual_order_limit',409);
  let changed=false;
  if(input.action==='add'){
    if(!text(input.name,100)||!text(input.channel,60)||!FLEET.some(b=>b.slug===input.boat))fail('invalid_manual_order');
    if(input.boat===AC2_BOAT)fail('boat_manually_disabled');
    if(!['deposit_paid','paid'].includes(input.payment_status))fail('manual_order_payment_required');
    // User-facing dates include the final day; convert exactly here, once.
    let end;try{day(input.start);day(input.end);end=shift(input.end,1);dateRange(input.start,end);}catch{fail('manual_order_invalid_dates');}
    const window=holdWindow(now);
    if(input.start<window.window_start||end>window.window_end||Date.parse(end)-Date.parse(input.start)>365*86400000)fail('manual_order_outside_window');
    if(holds.holds.some(h=>h.id===input.request_id)||legacy.holds.some(h=>h.id===input.request_id)||state.orders.some(o=>o.id===input.request_id))fail('hold_identity_conflict',409);
    if(state.orders.some(o=>o.active&&o.boat===input.boat&&o.name===input.name&&o.channel===input.channel&&o.start===input.start&&o.end===end))fail('manual_order_duplicate',409);
    if(state.orders.length>=1000||holds.holds.length>=1000)fail('manual_order_limit',409);
    state.orders.push({id:input.request_id,boat:input.boat,name:input.name,channel:input.channel,start:input.start,end,payment_status:input.payment_status,active:true,created_at:new Date(now).toISOString(),cancelled_at:null});
    holds.holds.push({id:input.request_id,boat:input.boat,start:input.start,end,active:true});changed=true;
  }else{
    if(!uuid(input.id))fail('invalid_manual_order');const order=state.orders.find(o=>o.id===input.id);
    if(!order)fail('manual_order_not_found',404);
    if(order.active){order.active=false;order.cancelled_at=new Date(now).toISOString();holds.holds.find(h=>h.id===order.id).active=false;changed=true;}
  }
  if(changed){state.revision++;holds.revision++;}
  if(!Number.isSafeInteger(state.revision)||!Number.isSafeInteger(holds.revision))fail('manual_order_limit',409);
  state.requests.push({request_id:input.request_id,fingerprint,revision:state.revision});
  return {state,holds,changed,idempotent:false};
}
