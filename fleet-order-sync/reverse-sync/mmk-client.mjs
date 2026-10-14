import {createHash} from 'node:crypto';
import {dateRange} from '../parsers.mjs';
export const MMK_URL='https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp';
// Runs in the normal page context. Only the observed MMK login route together
// with its named password field identifies an expired login; an unrelated
// password input or a slow editor is not authentication evidence.
export function mmkEntryState(){
 if(location.origin!=='https://portal.booking-manager.com')return null;
 if(location.pathname.startsWith('/wbm2/app/login_register/')&&
    document.querySelector('input[name="login_password"][type="password"]'))return 'auth_required';
 if(typeof ReservationsAPI!=='undefined'&&ReservationsAPI&&typeof ReservationsAPI.getData==='function')return 'ready';
 return null;
}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=model=>createHash('sha256').update(JSON.stringify(canonical(model))).digest('hex');
// Only a just-created, customer-free, unpaid Option may use the three default
// materializations observed in mmk-minute-diff.json. Keep complete model hashes:
// all customer, financial, date, invoice-line and unknown fields still matter.
export const emptyInitialOption=model=>model?.statusId==='2'&&model.clientId==='-1'&&
 model.guestId==null&&model.paidAmount===0&&Array.isArray(model.payments)&&
 model.payments.length===0&&!model.invoiceId;
const timestamp=value=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return false;
 const parsed=new Date(value.replace(' ','T')+'Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,19).replace('T',' ')===value;
};
export function initialOptionEvidence(model){
 if(!emptyInitialOption(model))throw Error('mmk_partial_write_requires_review');
 let variants=[structuredClone(model)];
 const add=change=>{variants=variants.concat(variants.map(value=>{const next=structuredClone(value);change(next);return next;}));};
 if(timestamp(model.confirmationDate))add(value=>{value.confirmationDate=model.confirmationDate.slice(0,10);});
 if(model.crewNumber&&typeof model.crewNumber==='object'&&!Array.isArray(model.crewNumber)&&model.crewNumber.total===null)
  add(value=>{value.crewNumber.total='1';});
 if(Array.isArray(model.deadlines)&&timestamp(model.deadlines[0]?.date)&&
    timestamp(model.confirmationDate)&&model.deadlines[0].date.slice(11)===model.confirmationDate.slice(11))
  add(value=>{value.deadlines[0].date=model.deadlines[0].date.slice(0,10)+' 00:00:00';});
 return {initial_fingerprint_version:2,initial_fingerprint:digest(model),
  initial_fingerprint_variants:[...new Set(variants.map(digest))]};
}
export function matchesInitialOption(model,evidence){
 if(evidence?.initial_fingerprint_version===undefined)return digest(model)===evidence?.initial_fingerprint;
 const hashes=evidence.initial_fingerprint_variants;
 return evidence.initial_fingerprint_version===2&&emptyInitialOption(model)&&
  Array.isArray(hashes)&&hashes.length>=1&&hashes.length<=8&&
  new Set(hashes).size===hashes.length&&hashes.every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash))&&
  hashes.includes(evidence.initial_fingerprint)&&hashes.includes(digest(model));
}
// Ownership concerns persisted booking identity, dates, customer, money and notes.
// UI actions, available discounts and generated invoice-line IDs are read models,
// not evidence that a human changed the reservation.
export function bookingFingerprint(model){
 const keys=['id','statusId','checkInDate','checkOutDate','bookingOrigin','internalRemarks','remarks','checkOutRemarks','checkOutNote','clientId','guestId','freeEntry','finalPrice','paidAmount','invoiceId'];
 return digest({...Object.fromEntries(keys.map(k=>[k,model[k]??null])),yachtId:model.yacht?.id});
}
// User decision 2026-10-09 (AGENTS.md 7.7): MMK protection follows the
// company's charter times, boarding 14:00 and return 10:00, so a turnover day
// stays bookable. A block [start, end) closes the nights start..end-1.
export const MMK_CHECK_IN='14:00:00',MMK_CHECK_OUT='10:00:00';
export const mmkTimes=(start,end)=>({checkInDate:start+' '+MMK_CHECK_IN,checkOutDate:end+' '+MMK_CHECK_OUT});
export function reservationModel(model,{start,end,marker}) {
  dateRange(start,end);
  return {...model,statusId:'1',...mmkTimes(start,end),
    bookingOrigin:marker,internalRemarks:marker,freeEntry:true,invoiceItems:[],
    basePrice:0,priceWithoutTax:0,finalPrice:0};
}
export class MmkClient {
 constructor(page,onReadFailure,recoverLogin,isCancelled=()=>false){Object.assign(this,{page,onReadFailure,recoverLogin,isCancelled});}
 assertActive(){if(this.isCancelled())throw Error('phone_shutdown');}
 async readEval(fn,arg){
  this.assertActive();
  try{return await this.page.evaluate(fn,arg);}catch(error){
   if(!this.onReadFailure)throw error;
   this.assertActive();
   const replacement=await this.onReadFailure();
   // Waking Chrome reconnects CDP and invalidates every Page on the old
   // connection. A retry must use a new managed page, verify its account,
   // and remain a single read retry; writes never enter this path.
   if(!replacement||replacement===this.page)throw Error('mmk_read_recovery_failed');
   this.page=replacement;this.assertActive();
   await this.open();this.assertActive();
   return this.page.evaluate(fn,arg);
  }
 }
 async open(){
  this.assertActive();
  await this.page.goto(MMK_URL,{waitUntil:'domcontentloaded',timeout:45000});
  this.assertActive();
  await this.page.waitForFunction(mmkEntryState,{polling:250,timeout:20000});
  this.assertActive();
  let state=await this.page.evaluate(mmkEntryState);
  if(state==='auth_required'&&this.recoverLogin){
   this.assertActive();
   await this.recoverLogin(this.page);
   // Login can navigate and destroy the old execution context. Wait for a
   // fresh editor, then always verify the actual account before any writes.
   this.assertActive();await this.page.goto(MMK_URL,{waitUntil:'domcontentloaded',timeout:45000});
   this.assertActive();
   await this.page.waitForFunction(mmkEntryState,{polling:250,timeout:20000});
   this.assertActive();
   state=await this.page.evaluate(mmkEntryState);
  }
  if(state==='auth_required')throw Error('mmk_auth_required');
  if(state!=='ready')throw Error('mmk_editor_unavailable');
  this.assertActive();
  const account=await this.page.evaluate(async()=>{const d=await ReservationsAPI.getData();return {serviceId:d.serviceId,isCharter:d.isCharter};});
  this.assertActive();
  if(account.serviceId!=='0000'||account.isCharter!==true)throw Error('mmk_account_mismatch');
 }
 async list(){
  const result=[],ids=new Set();
  for(let page=1;page<=100;page++){
   const d=await this.readEval(page=>fetchPost({view:'Reservations',responseType:'JSON',action:'getFilteredItems',page,pageSize:100,filters:'[]'}),page);
   if(!d||d.timedOut||!Array.isArray(d.data)||!Number.isInteger(d.itemsLeft)||d.itemsLeft<0)throw Error('mmk_list_incomplete');
   for(const r of d.data){if(!r.id||ids.has(r.id))throw Error('mmk_duplicate_page');ids.add(r.id);result.push(r);}
   if(d.itemsLeft===0)return result;
   if(!d.data.length)throw Error('mmk_empty_page');
  }
  throw Error('mmk_page_limit');
 }
 async get(id){const d=await this.readEval(id=>ReservationsAPI.getReservation(id),id);if(d?.success!==true||d.value?.id!==id)throw Error('mmk_record_read_failed');return d.value;}
 async getMany(ids){
  const models=[];
  for(let i=0;i<ids.length;i+=4){
   const batch=ids.slice(i,i+4);
   const values=await this.readEval(ids=>Promise.all(ids.map(id=>ReservationsAPI.getReservation(id))),batch);
   if(!Array.isArray(values)||values.length!==batch.length)throw Error('mmk_record_read_failed');
   for(let j=0;j<batch.length;j++){
    if(values[j]?.success!==true||values[j].value?.id!==batch[j])throw Error('mmk_record_read_failed');
    models.push(values[j].value);
   }
  }
  return models;
 }
 async create(yachtId,start){
  this.assertActive();
  // Same authenticated request as the observed ReservationsAPI method. MMK's
  // fetchRequest helper swallows HTTP/network errors and returns undefined from
  // a toast, losing the only create acknowledgement. Preserve that failure and
  // NEVER repeat the mutation automatically; the durable intent needs review.
  const d=await this.page.evaluate(async({yachtId,start})=>{
   let response;
   try{response=await fetch('/wbm2/page.html',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({view:'Reservations',responseType:'JSON',action:'createReservation',yachtId,startDate:start}).toString()});}
   catch{throw Error('mmk_create_network_uncertain');}
   if(!response.ok)throw Error('mmk_create_http_'+response.status+'_uncertain');
   try{return await response.json();}catch{throw Error('mmk_create_response_uncertain');}
  },{yachtId,start});
  if(d?.success!==true||typeof d.value?.id!=='string'||!d.value.id)throw Error('mmk_create_uncertain');return d.value.id;
 }
 async available({id,yachtId,start,end}){
  dateRange(start,end);
  const {checkInDate,checkOutDate}=mmkTimes(start,end);
  const d=await this.readEval(({id,yachtId,checkInDate,checkOutDate})=>fetchPost({view:'Reservations',responseType:'JSON',action:'isYachtAvailable',reservationId:id,newResourceId:yachtId,newStatus:'1',dateFrom:checkInDate,dateTo:checkOutDate}),{id,yachtId,checkInDate,checkOutDate});
  if(d?.success!==true||typeof d.value!=='boolean')throw Error('mmk_availability_unverified');
  return d.value;
 }
 async save(model){
  const d=await this.page.evaluate(async model=>{
   const r=await fetch('/wbm2/page.html?view=Reservations&action=save&responseType=JSON',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(model)});
   if(!r.ok)throw Error('mmk_save_http_failed');return r.json();
  },model);
  if(d?.success!==true)throw Error('mmk_save_failed');
  // MMK can populate default extras during the first read after save.
  // Use a second persisted read as the ownership receipt, not the save response.
  await this.get(model.id);
  return this.get(model.id);
 }
}

