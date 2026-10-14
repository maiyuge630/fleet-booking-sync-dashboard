import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBoataroundListEvidence,verifyBoataroundPaginationEvidence} from './boataround.mjs';
import {paginationPlan} from './clickandboat.mjs';
import {assertSamBoatTraversal} from './samboat.mjs';
import {englishDateRange,clickAndBoatDateRange,samBoatDateRange,verifiedTimestamp,boataroundStatus,
  samBoatStatus,clickAndBoatStatus,money} from '../parsers.mjs';
import {applyClickAndBoatPaymentEvidence} from '../payment-evidence.mjs';

const clone=value=>structuredClone(value);
const stamp='2026-09-14T00:00:00.000Z';
const id=value=>value.toString(16).padStart(24,'0');
const baPage=(count,offset)=>validateBoataroundListEvidence({
  request_url:`https://partner-api.boataround.com/v1/charters/000000000000000000000000/orders?lang=en_GB&offset=${offset}&limit=20`,
  status:200,body:{count,data:Array.from({length:Math.max(0,Math.min(20,count-offset))},(_,index)=>({id:id(offset+index+1)}))},
});

test('v15 generated Boataround page boundaries never accept a gap, duplicate, count change or reordered page',()=>{
 for(const count of [0,1,19,20,21,39,40,41,52,99,100,999,1000]){
  const pages=Array.from({length:Math.max(1,Math.ceil(count/20))},(_,index)=>baPage(count,index*20));
  const result=verifyBoataroundPaginationEvidence(pages);
  assert.equal(result.listed_count,count);assert.equal(result.total_pages,pages.length);
  for(let index=0;index<pages.length;index++){
   const wrongCount=clone(pages);wrongCount[index].count++;assert.throws(()=>verifyBoataroundPaginationEvidence(wrongCount));
   const omitted=clone(pages);omitted.splice(index,1);assert.throws(()=>verifyBoataroundPaginationEvidence(omitted));
   const wrongRows=clone(pages);wrongRows[index].ids.push(id(2000+index));assert.throws(()=>verifyBoataroundPaginationEvidence(wrongRows));
   if(index>0){
    const repeated=clone(pages);repeated[index].ids[0]=repeated[0].ids[0];assert.throws(()=>verifyBoataroundPaginationEvidence(repeated));
    const reordered=clone(pages);[reordered[0],reordered[index]]=[reordered[index],reordered[0]];assert.throws(()=>verifyBoataroundPaginationEvidence(reordered));
   }
  }
 }
});

const cbPager=(current,count)=>({unknownPagination:false,paginations:[{structureSupported:true,empty:false,items:[
 {text:'Previous',prev:true,next:false,disabled:current===1},
 ...Array.from({length:count},(_,index)=>({text:String(index+1),active:index+1===current,next:false,prev:false})),
 {text:'Next',next:true,prev:false,disabled:current===count},
]}]});
test('v15 Click&Boat generated page switching retains every declared page and rejects broken boundaries',()=>{
 for(let count=2;count<=12;count++)for(let current=1;current<=count;current++){
  const data=cbPager(current,count),result=paginationPlan(data,current);
  assert.deepEqual(result.pages,Array.from({length:count},(_,index)=>index+1));assert.equal(result.next,current===count?null:current+1);
  const duplicate=clone(data);duplicate.paginations[0].items.splice(1,0,{...duplicate.paginations[0].items[1]});assert.throws(()=>paginationPlan(duplicate,current));
  const wrongBoundary=clone(data);wrongBoundary.paginations[0].items.at(-1).disabled=current!==count;assert.throws(()=>paginationPlan(wrongBoundary,current));
  const omitted=clone(data);omitted.paginations[0].items.splice(1,1);assert.throws(()=>paginationPlan(omitted,current));
  const changed=clone(data);changed.paginations.push(clone(data.paginations[0]));changed.paginations[1].items[1].text='99';assert.throws(()=>paginationPlan(changed,current));
 }
});

const sbRecord=(booking_id,status='cancelled')=>({booking_id,boataround_slug:'seacat-open-40-tidewyn-discovery-2',
 start:'2026-12-26',end:'2027-01-02',status,amount:'$100.00',amount_basis:'租客在线支付金额'});
test('v15 SamBoat page traversal deduplicates only identical cross-tab orders and never missing pages',()=>{
 for(let count=1;count<=6;count++){
  const pages=['ongoing','confirmed','archived'].flatMap((tab,tabIndex)=>Array.from({length:count},(_,index)=>({
   tab,page:index+1,declaredPages:Array.from({length:count},(_,i)=>i+1),destinations:[],unreadIds:[],
   records:[sbRecord(String(tabIndex*100+index+1))],
  })));
  assert.equal(assertSamBoatTraversal(pages).length,count*3);
  for(let index=0;index<pages.length;index++){
   const omitted=clone(pages);omitted.splice(index,1);assert.throws(()=>assertSamBoatTraversal(omitted));
   const unseen=clone(pages);unseen[index].unreadIds=['99999'];assert.throws(()=>assertSamBoatTraversal(unseen));
  }
  const same=clone(pages);same[count].records=[clone(same[0].records[0])];assert.equal(assertSamBoatTraversal(same).length,count*3-1);
  for(const field of ['status','boataround_slug','start','end','amount','amount_basis']){
   const conflict=clone(same);conflict[count].records[0][field]='changed';assert.throws(()=>assertSamBoatTraversal(conflict));
  }
 }
});

const day=value=>new Date(value).toISOString().slice(0,10);
const english=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(value));
test('v15 generated explicit dates preserve cross-year and leap-day boundaries without inventing a checkout day',()=>{
 for(const base of ['2026-12-25','2028-02-25','2026-09-25'])for(let offset=0;offset<12;offset++)for(const length of [1,2,7,14]){
  const start=Date.parse(base+'T00:00:00Z')+offset*86400000,end=start+length*86400000,want={start:day(start),end:day(end)};
  assert.deepEqual(englishDateRange(`${english(start)} - ${english(end)}`),want);
  assert.deepEqual(clickAndBoatDateRange(`from ${english(start)} to ${english(end)} (14:00 / 10:00)`),want);
  assert.deepEqual(samBoatDateRange(`${english(start)} - ${english(end)} in the morning`),want);
  assert.deepEqual(samBoatDateRange(english(start)),{start:day(start),end:day(start)});
  for(const parse of [englishDateRange,samBoatDateRange])assert.throws(()=>parse(`${english(end)} - ${english(start)}`));
 }
});

test('v15 verification times reject impossible calendar dates while preserving timezone conversion and leap days',()=>{
 for(const invalid of ['2026-02-29','2026-02-30','2026-04-31','2026-06-31','2026-09-31','2026-11-31'])
  for(const zone of ['Z','+08:00','-07:00'])assert.throws(()=>verifiedTimestamp(invalid+'T12:00:00'+zone),{code:'VERIFIED_AT'});
 assert.equal(verifiedTimestamp('2028-02-29T23:59:59+08:00'),'2028-02-29T15:59:59.000Z');
 assert.equal(verifiedTimestamp('2027-01-01T00:00:00+08:00'),'2026-12-31T16:00:00.000Z');
 assert.equal(verifiedTimestamp('2026-12-31T23:59:59-07:00'),'2027-01-01T06:59:59.000Z');
});

test('v15 every accepted money representation preserves exact cents even near safe integer boundaries',()=>{
 const values=[0n,1n,9n,10n,99n,100n,101n,9999n,10000n,999999n];
 for(let offset=0n;offset<32n;offset++)values.push(BigInt(Number.MAX_SAFE_INTEGER)-offset);
 for(const minor of values)for(const symbol of ['€','$']){
  const input=minor/100n+'.'+String(minor%100n).padStart(2,'0'),result=money(symbol+input);
  assert.equal(result.minor_units,Number(minor));assert.equal(result.amount,input);
  assert.equal(result.display.slice(1).replaceAll(',',''),input);
  assert.deepEqual(money(result.display),result);
 }
 assert.throws(()=>money('€92465046093631.92'),{code:'MONEY_VALUE'});
});

test('v15 cancelled and unpaid states cannot regain occupancy from retained positive payment fields',()=>{
 const order={source:'clickandboat',booking_id:'1244141',url:'https://www.clickandboat.com/uk/booking/1244141/detail',status:'accepted',verified_at:stamp};
 const endpoint='https://www.clickandboat.com/api/v6/booking/prices/1244141?_locale=en-GB';
 for(const paid of [0,0.001,1,100,100000]){
  const response={status:200,url:endpoint,body:{tenantAlreadyPaidAmount:paid,tenantBalancePaymentAmount:100,tenantTotalOnlineAmount:200}};
  const initial=applyClickAndBoatPaymentEvidence(order,response);
  assert.equal(initial.status,paid>0?'accepted':'pending');
  for(const terminal of ['cancelled','refused','completed','pending']){
   const gone=applyClickAndBoatPaymentEvidence({...initial,status:terminal},new Proxy({},{get(){throw Error('stale response must not be read');}}));
   assert.equal(gone.status,terminal);assert.ok(!('customer_payment_verified' in gone));assert.ok(!('customer_paid_amount' in gone));
  }
 }
 for(const payment of ['PAID','PARTIALLY PAID','NOT PAID','REFUNDED',undefined,'UNKNOWN'])assert.equal(boataroundStatus('CANCELLED',payment),'cancelled');
 for(const state of ['CANCELLED','CANCELED']){assert.equal(samBoatStatus(state),'cancelled');assert.equal(clickAndBoatStatus(state),'cancelled');}
 for(const state of ['Cancellation requested','Refund pending','Paid pending'])assert.throws(()=>samBoatStatus(state));
 for(const state of ['CONFIRMED','Confirmed'])for(const payment of ['NOT PAID','REFUNDED'])assert.equal(boataroundStatus(state,payment),'pending');
});
