import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parseBoataroundDetail} from '../parsers.mjs';
import {boataroundDetailReady,boataroundLoginDetected,collectBoataround,validateBoataroundListEvidence as validate,verifyBoataroundPaginationEvidence as verify,BOATAROUND_ORDERS_URL as UI} from './boataround.mjs';

const API='https://partner-api.boataround.com/v1/charters/000000000000000000000000/orders';
const id=index=>index.toString(16).padStart(24,'0');
const request=(offset=0,extra='')=>`${API}?lang=en_GB&offset=${offset}&limit=20${extra}`;
const observed=(count,offset=0,extra='')=>({request_url:request(offset,extra),status:200,body:{count,data:Array.from({length:Math.max(0,Math.min(20,count-offset))},(_,i)=>({id:id(offset+i+1)}))}});
const row=index=>({url:UI+'/'+id(index),status:'CANCELLED',booking:`#${280000+index}\nWavecat 34 Open | Tidewyn Dream`,price:'€123',times:[{datetime:'2026-11-01T00:00:00.000Z',text:'1 Nov 2026'},{datetime:'2026-11-07T00:00:00.000Z',text:'7 Nov 2026'}]});
const makePages=count=>Array.from({length:Math.max(1,Math.ceil(count/20))},(_,index)=>({evidence:observed(count,index*20),rows:Array.from({length:Math.max(0,Math.min(20,count-index*20))},(_,i)=>row(index*20+i+1))}));

test('list contract accepts only complete count/data identities at observed 20-row offsets',()=>{
 const pages=[validate(observed(41,0)),validate(observed(41,20)),validate(observed(41,40))];
 assert.deepEqual(verify(pages),{complete:true,total_pages:3,pages_read:[1,2,3],listed_count:41});
 const unsafe=[observed(20),observed(20),observed(20),observed(20)];
 unsafe[0].body.count='20';unsafe[1].body.data.pop();unsafe[2].body.data[1].id=unsafe[2].body.data[0].id;unsafe[3].body.data[0].id='280707';
 for(const evidence of unsafe)assert.throws(()=>validate(evidence));
});
test('status/date/base/search filtering and ambiguous URL parameters never qualify as a full account list',()=>{
 for(const suffix of ['&bookingStatuses=CONFIRMED','&baseIds=x','&from=2026-01-01','&to=2026-12-31','&uuid=280707','&offset=0','&lang=en_GB','&filter=','&sort=x&sort=y']){
  assert.throws(()=>validate(observed(20,0,suffix)),{code:'incomplete_pages'});
 }
 for(const raw of ['01','-20','20.0','NaN','1000'])assert.throws(()=>validate({...observed(20),request_url:request().replace('offset=0','offset='+raw)}));
 assert.throws(()=>validate({...observed(20),request_url:request().replace('/000000000000000000000000/','/ffffffffffffffffffffffff/')}));
});
test('missing page, changed count/sort and duplicate identities across pages are rejected',()=>{
 const pages=[validate(observed(21)),validate(observed(21,20))];
 assert.throws(()=>verify(pages.slice(0,1)));
 for(const change of [{count:22},{sort:'check_in'},{ids:[pages[0].ids[0]]},{offset:40}])assert.throws(()=>verify([pages[0],{...pages[1],...change}]));
});
test('only observed-contract 200 count zero or explicit vendor 204 can prove an empty list',()=>{
 assert.equal(verify([validate(observed(0))]).listed_count,0);
 assert.equal(verify([validate({request_url:request(),status:204,body:null})]).listed_count,0);
 for(const status of [304,401,403,404,429,500,503])assert.throws(()=>validate({request_url:request(),status,body:{count:0,data:[]}}));
 assert.throws(()=>validate({request_url:request(),status:200,body:{}}),{code:'schema_changed'});
 assert.throws(()=>validate({request_url:request(),status:204,body:{count:0,data:[]}}));
});
test('real phone count and detail IDs match exactly 20 canonical DOM orders, excluding crew-list links',()=>{
 const evidence=JSON.parse(readFileSync(new URL('../evidence/inventory-structure-20260910.json',import.meta.url),'utf8')).boataround;
 assert.equal(evidence.api.http_status,304);
 const body={count:evidence.api.count,data:evidence.api.ids.map(id=>({id}))};
 // The body schema is verified independently; the actual 304 remains rejected.
 assert.throws(()=>validate({request_url:evidence.api.url,status:304,body}),{code:'fetch_failed'});
 const parsed=validate({request_url:evidence.api.url,status:200,body});
 assert.equal(parsed.count,52);assert.equal(parsed.ids.length,20);
 const exact=evidence.dom.links.filter(url=>/^https:\/\/partner\.boataround\.com\/en\/000000000000000000000000\/orders\/[a-f0-9]{24}$/.test(url));
 assert.deepEqual(exact.map(url=>url.slice(UI.length+1)),parsed.ids);
 assert.equal(evidence.dom.links.length-exact.length,2);
});

class FakePage extends EventEmitter{
 constructor(rounds,{buttons=null,details={}}={}){super();this.rounds=rounds;this.round=-1;this.index=0;this.buttons=buttons;this.details=details;this.visits=[];this.location='about:blank';}
 url(){return this.location;}
 async setCacheEnabled(value){assert.equal(value,false);this.cacheDisabled=true;}
 load(index){
  this.index=index;this.current=this.rounds[this.round][index];if(!this.current)throw Error('unexpected page');
  const evidence=this.current.evidence;queueMicrotask(()=>this.emit('response',{
   url:()=>evidence.request_url,status:()=>evidence.status,headers:()=>({'content-type':this.current.contentType??'application/json'}),request:()=>({method:()=> 'GET'}),
   text:async()=>this.current.bodyText??JSON.stringify(evidence.body)
  }));
 }
 async goto(url){this.location=url;this.visits.push(url);if(url===UI){this.round++;this.load(0);}return {status:()=>200,url:()=>url,headers:()=>({'content-type':'text/html; charset=utf-8'})};}
 async $$(selector){
  assert.equal(selector,'button');const numbers=this.buttons??this.rounds[this.round].map((_,i)=>i+1);
  return numbers.map(number=>({evaluate:async(fn,text)=>fn({getClientRects:()=>[{}],disabled:false,isConnected:true,innerText:String(number),click:()=>this.load(number-1)},text),click:async()=>{throw Error('Pointer click depends on suspended screen frames');},dispose:async()=>{}}));
 }
 async waitForFunction(fn,options,arg){assert.ok(options.timeout>0);assert.equal(options.polling,250);if(arg?.ids)this.expectedIds=arg.ids;}
 async evaluate(fn){
  if(fn.name==='extractList')return {rows:this.current.rows,account:this.current.account!==false,noOrders:this.current.empty!==false&&this.current.rows.length===0};
  if(this.details[this.location])return this.details[this.location];
  throw Error('unexpected evaluate');
 }
}
const run=page=>collectBoataround({page,fromDay:'2026-09-10',deadlineAt:Date.now()+5000});
const clone=value=>structuredClone(value);

test('v15 unsuccessful navigation cannot certify a paid Boataround detail even if matching HTML remains',async()=>{
 for(const [status,type,expected] of [[401,'text/html','auth_required'],[403,'text/html','fetch_failed'],
   [429,'text/html','fetch_failed'],[503,'text/html','fetch_failed'],[200,'application/json','fetch_failed']]){
  const {pages,url,paid}=cancellationFixture(),page=new FakePage([pages,clone(pages)],{details:{[url]:paid}}),go=page.goto.bind(page);
  page.goto=async target=>{const response=await go(target);return target===url?{status:()=>status,url:()=>target,headers:()=>({'content-type':type})}:response;};
  await assert.rejects(run(page),{code:expected});
  assert.equal(page.listenerCount('response'),0);
 }
});
test('collector traverses count-derived pages twice and preserves snapshot shape and inactive statuses',async()=>{
 const pages=makePages(41),page=new FakePage([pages,clone(pages)]),result=await run(page);
 assert.equal(result.complete,true);assert.equal(result.source,'boataround');assert.equal(result.expected_count,41);assert.equal(result.orders.length,41);
 assert.ok(result.orders.every(record=>record.status==='cancelled'));assert.equal(result.scope.kind,'current_future');
 assert.deepEqual(result.pagination,{complete:true,total_pages:3,pages_read:[1,2,3],listed_count:41});
 assert.equal(page.round,1);assert.equal(page.index,2);assert.equal(page.listenerCount('response'),0);assert.equal(page.cacheDisabled,true);
});
test('a missing final numeric UI page cannot silently shrink the total',async()=>{
 const page=new FakePage([makePages(41)],{buttons:[1,2]});
 await assert.rejects(run(page),{code:'incomplete_pages'});assert.equal(page.listenerCount('response'),0);
});
test('DOM/API omissions and substituted detail identities refuse a snapshot',async()=>{
 for(const mutate of [p=>p[0].rows.pop(),p=>{p[0].rows[0].url=UI+'/'+id(999);},p=>{p[0].rows[1].url=p[0].rows[0].url;}]){
  const pages=makePages(21);mutate(pages);await assert.rejects(run(new FakePage([pages])),{code:'incomplete_pages'});
 }
});
test('filtered responses and changed page counts fail before accepting UI rows',async()=>{
 const filtered=makePages(21);filtered[0].evidence.request_url+='&bookingStatuses=CONFIRMED';
 await assert.rejects(run(new FakePage([filtered])),{code:'incomplete_pages'});
 const changed=makePages(21);changed[1].evidence=observed(22,20);changed[1].rows.push(row(22));
 await assert.rejects(run(new FakePage([changed])),{code:'incomplete_pages'});
});
test('complete reread rejects same-count replacement or status/date changes on later pages',async()=>{
 for(const mutate of [
  p=>{p[1].evidence.body.data[0].id=id(999);p[1].rows[0]=row(999);},
  p=>{p[1].rows[0].status='COMPLETED';},
  p=>{p[1].rows[0].times[1]={datetime:'2026-11-08T00:00:00.000Z',text:'8 Nov 2026'};}
 ]){
  const first=makePages(21),last=clone(first);mutate(last);await assert.rejects(run(new FakePage([first,last])),{code:'incomplete_pages'});
 }
 await assert.rejects(run(new FakePage([makePages(21),makePages(20)])),{code:'incomplete_pages'});
});

test('already cancelled prices are not financial evidence and cannot restore occupancy',async()=>{
 const first=makePages(21),last=clone(first);last[1].rows[0].price='€124';
 const result=await run(new FakePage([first,last]));
 assert.ok(result.orders.every(order=>order.status==='cancelled'&&!('amount' in order)&&!('list_price' in order)));
});
test('empty result requires two explicit empty responses and visible empty UI',async()=>{
 const result=await run(new FakePage([makePages(0),makePages(0)]));assert.equal(result.orders.length,0);assert.equal(result.pagination.listed_count,0);
 const pages=makePages(0);pages[0].empty=false;await assert.rejects(run(new FakePage([pages])),{code:'incomplete_pages'});
 const failed=makePages(0);failed[0].evidence.status=503;await assert.rejects(run(new FakePage([failed])),{code:'fetch_failed'});
});
test('malformed response, unauthorized account and cancellation clean up the observer',async()=>{
 for(const change of [{contentType:'text/html'},{bodyText:'not json'},{account:false}]){
  const pages=makePages(1);Object.assign(pages[0],change);const page=new FakePage([pages]);await assert.rejects(run(page));assert.equal(page.listenerCount('response'),0);
 }
 const page=new FakePage([makePages(0)]),abort=new AbortController();abort.abort();
 await assert.rejects(collectBoataround({page,fromDay:'2026-09-10',deadlineAt:Date.now()+5000,signal:abort.signal}),{code:'timeout'});assert.equal(page.visits.length,0);
});
test('an abort while waiting for the UI API response cannot leave an observer or an empty snapshot',async()=>{
 const page=new FakePage([makePages(0)]),abort=new AbortController();
 page.goto=async()=>{queueMicrotask(()=>abort.abort());};
 await assert.rejects(collectBoataround({page,fromDay:'2026-09-10',deadlineAt:Date.now()+5000,signal:abort.signal}),{code:'timeout'});
 assert.equal(page.listenerCount('response'),0);
});

test('auth detection requires the observed exact BA login route plus its password field',()=>{
 const detects=(origin,pathname,password)=>runInNewContext('('+boataroundLoginDetected.toString()+')()',{
  location:{origin,pathname},document:{querySelector:selector=>selector==='input[type="password"]'&&password?{}:null}
 });
 assert.equal(detects('https://partner.boataround.com','/en/login',true),true);
 for(const [origin,path,password] of [
  ['https://partner.boataround.com','/en/login',false],
  ['https://partner.boataround.com','/en/000000000000000000000000/orders',false],
  ['https://partner.boataround.com','/en/000000000000000000000000/orders',true],
  ['https://other.invalid','/en/login',true]
 ])assert.equal(detects(origin,path,password),false);
});

function captureOnlyPage({redirect=false,abort=null,onNavigate=null}={}){
 const page=new FakePage([makePages(0)]);let resolveLogin,loginSignal,disposed=false;
 page.waitForFunction=async(fn,options)=>{
  assert.equal(fn,boataroundLoginDetected);assert.equal(options.polling,250);loginSignal=options.signal;
  return new Promise((resolve,reject)=>{
   resolveLogin=resolve;
   options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});
   if(options.signal.aborted)reject(Object.assign(Error('aborted'),{name:'AbortError'}));
  });
 };
 page.goto=async()=>{
  page.location=UI;
  // HTTP 200 navigation can complete before the SPA redirects to sign-in.
  queueMicrotask(()=>{
   if(redirect){page.location='https://partner.boataround.com/en/login';resolveLogin({dispose:async()=>{disposed=true;}});}
   if(abort)abort.abort();
   onNavigate?.();
  });
  return {status:()=>200,headers:()=>({'content-type':'text/html; charset=utf-8'})};
 };
 return {page,watcherStopped:()=>loginSignal?.aborted===true,disposed:()=>disposed};
}

test('HTTP-200 navigation followed by async SPA login redirect reports auth_required and cleans capture',async()=>{
 const f=captureOnlyPage({redirect:true});
 await assert.rejects(collectBoataround({page:f.page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000}),{code:'auth_required'});
 assert.equal(f.page.listenerCount('response'),0);assert.equal(f.watcherStopped(),true);assert.equal(f.disposed(),true);
});

test('no API response without login proof remains fetch_failed and stops the auth watcher',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=captureOnlyPage({onNavigate:()=>t.mock.timers.tick(18000)});
 await assert.rejects(collectBoataround({page:f.page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000}),{code:'fetch_failed'});
 assert.equal(f.page.listenerCount('response'),0);assert.equal(f.watcherStopped(),true);
});

test('abort or exhausted collection deadline while auth is pending remains timeout with no stale observers',async t=>{
 const abort=new AbortController(),a=captureOnlyPage({abort});
 await assert.rejects(collectBoataround({page:a.page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000,signal:abort.signal}),{code:'timeout'});
 assert.equal(a.watcherStopped(),true);assert.equal(a.page.listenerCount('response'),0);
 t.mock.timers.enable({apis:['setTimeout']});
 const d=captureOnlyPage({onNavigate:()=>t.mock.timers.tick(5000)});
 await assert.rejects(collectBoataround({page:d.page,fromDay:'2026-09-10',deadlineAt:Date.now()+1000}),{code:'timeout'});
 assert.equal(d.watcherStopped(),true);assert.equal(d.page.listenerCount('response'),0);
});

test('a successful API capture aborts its pending login watcher on every list pass',async()=>{
 const pages=makePages(0),page=new FakePage([pages,clone(pages)]),wait=page.waitForFunction.bind(page),signals=[];
 page.waitForFunction=async(fn,options,...args)=>{
  if(fn!==boataroundLoginDetected)return wait(fn,options,...args);
  signals.push(options.signal);
  return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});if(options.signal.aborted)reject(Error('aborted'));});
 };
 const result=await run(page);assert.equal(result.expected_count,0);assert.equal(signals.length,2);
 assert.ok(signals.every(signal=>signal.aborted));assert.equal(page.listenerCount('response'),0);
});
test('customer payment and cancellation still come only from the existing detail parser',async()=>{
 const detailId='b386b5a4271f3a72a26a93d0',url=UI+'/'+detailId;
 const confirmed={url,status:'CONFIRMED',booking:'#280707\nGrandcat 55 | Tidewyn Discovery 5',price:'€15,585',times:[{datetime:'2026-10-17T00:00:00Z',text:'17 Oct 2026'},{datetime:'2026-10-24T00:00:00Z',text:'24 Oct 2026'}]};
 for(const [status,payment,want] of [['CONFIRMED','PARTIALLY PAID','deposit_paid'],['CONFIRMED','NOT PAID','pending'],['CANCELLED','NOT PAID','cancelled']]){
  const pages=[{evidence:{request_url:request(),status:200,body:{count:1,data:[{id:detailId}]}},rows:[confirmed]}];
  const body=`#280707 - Grandcat 55 | Tidewyn Discovery 5\nBoat\nGrandcat 55 | Tidewyn Discovery 5\nDate\n17 Oct 2026 - 24 Oct 2026\nBooking status\n${status}\nCustomer payment\n${payment}\nAgency payment\nPAID\nAgency price\n14,086.5 €\nClient price\n15,585 €`;
  const result=await run(new FakePage([pages,clone(pages)],{details:{[url]:body}}));assert.equal(result.orders[0].status,want);
 }
});

const cancellationFixture=()=>{
 const pages=makePages(21),target=pages[1].rows[0],url=target.url;
 target.status='CONFIRMED';
 const header=`#280021 - Wavecat 34 Open | Tidewyn Dream\nBoat\nWavecat 34 Open | Tidewyn Dream\nDate\n1 Nov 2026 - 7 Nov 2026\nBooking status\n`;
 const paid=header+'CONFIRMED\nCustomer payment\nPARTIALLY PAID\nAgency payment\nPAID\nAgency price\n€100\nClient price\n€123';
 return {pages,url,header,paid};
};

test('checkout-day paid orders and current cancellations are collected until the following day',async()=>{
 for(const [state,want] of [['paid','deposit_paid'],['cancelled','cancelled']]){
  const {pages,url,header,paid}=cancellationFixture();
  const page=new FakePage([pages,clone(pages)],{details:{[url]:state==='paid'?paid:header+'CANCELLED'}});
  const result=await collectBoataround({page,fromDay:'2026-11-07',deadlineAt:Date.now()+5000});
  assert.equal(result.orders.find(order=>order.booking_id==='280021')?.status,want);
  assert.ok(page.visits.includes(url),'checkout-day payment/cancellation must be checked in detail');
 }
 const {pages}=cancellationFixture(),page=new FakePage([pages,clone(pages)]);
 const result=await collectBoataround({page,fromDay:'2026-11-08',deadlineAt:Date.now()+5000});
 assert.equal(result.orders.length,0);
});

const detailReady=bodyText=>runInNewContext(`(${boataroundDetailReady.toString()})()`,{document:{body:{innerText:bodyText}}});

test('NEW/IN PROCESS on a later list page always fetch current payment and respect final cancellation',async()=>{
 for(const state of ['NEW','IN PROCESS'])for(const [payment,want] of [['PARTIALLY PAID','deposit_paid'],['PAID','paid'],['NOT PAID','pending'],['REFUNDED','pending']]){
  const {pages,url,header}=cancellationFixture();pages[1].rows[0].status=state;
  const body=header+state+'\nCustomer payment\n'+payment+'\nAgency price\n€100\nClient price\n€123';
  const page=new FakePage([pages,clone(pages)],{details:{[url]:body}}),result=await run(page);
  assert.ok(page.visits.includes(url));assert.equal(result.orders.find(r=>r.booking_id==='280021').status,want);
  const final=clone(pages);final[1].rows[0].status='CANCELLED';
  const cancelled=await run(new FakePage([pages,final],{details:{[url]:body}}));
  assert.equal(cancelled.orders.find(r=>r.booking_id==='280021').status,'cancelled');
 }
 for(const state of ['NEW','IN PROCESS']){
  const {pages,url,header}=cancellationFixture();pages[1].rows[0].status=state;
  await assert.rejects(run(new FakePage([pages,clone(pages)],{details:{[url]:header+state}})),{code:'MISSING_LABEL'});
 }
});

test('paid detail readiness waits for progressively rendered identity, payment and financial values',()=>{
 const {header}=cancellationFixture();
 for(const body of ['#280021 - Wavecat 34 Open | Tidewyn Dream',
  '#280021 - Wavecat 34 Open | Tidewyn Dream\nBooking status\nCONFIRMED',
  header,header+'CONFIRMED',header+'CONFIRMED\nCustomer payment',
  header+'CONFIRMED\nCustomer payment\nAgency price\n€100',
  header+'CONFIRMED\nCustomer payment\nPARTIALLY PAID',
  header+'CONFIRMED\nCustomer payment\nPARTIALLY PAID\nAgency price',
  header+'CONFIRMED\nCustomer payment\nPARTIALLY PAID\nAgency price\n€100\nClient price']){
  assert.equal(detailReady(body),false);
 }
 for(const payment of ['PAID','PARTIALLY PAID']){
  assert.equal(detailReady(header+`CONFIRMED\nCustomer payment\n${payment}\nAgency price\n€100\nClient price\n€123`),true);
  assert.equal(detailReady(header+`CONFIRMED\nCustomer payment: ${payment}\nAgency price\t€100\nClient price: €123`),true);
 }
});

test('terminal detail states need no financial labels; live workflows require actual payment fields',()=>{
 const {header}=cancellationFixture();
 for(const state of ['CANCELLED','CANCELED','COMPLETED'])assert.equal(detailReady(header+state),true);
 for(const state of ['NEW','IN PROCESS']){
  assert.equal(detailReady(header+state),false);
  assert.equal(detailReady(header+state+'\nCustomer payment\nPARTIALLY PAID'),false);
  assert.equal(detailReady(header+state+'\nCustomer payment\nNOT PAID'),true);
  assert.equal(detailReady(header+state+'\nCustomer payment\nPARTIALLY PAID\nAgency price\n€100\nClient price\n€123'),true);
 }
 for(const payment of ['NOT PAID','REFUNDED'])assert.equal(detailReady(header+'CONFIRMED\nCustomer payment\n'+payment),true);
 assert.equal(detailReady(header+'CONFIRMED'),false);
 for(const incomplete of [header.replace('Boat\nWavecat 34 Open | Tidewyn Dream\n',''),header.replace('Date\n1 Nov 2026 - 7 Nov 2026\n','')]){
  assert.equal(detailReady(incomplete+'CANCELLED'),false);
 }
});

test('readiness does not grant meaning to unknown or cancellation-request states',()=>{
 const {header,url}=cancellationFixture(),options={url,verifiedAt:'2026-09-10T00:00:00Z'};
 for(const state of ['CANCELLATION REQUESTED','REQUEST TO CANCEL','UNKNOWN']){
  const bodyText=header+state;assert.equal(detailReady(bodyText),true);
  assert.throws(()=>parseBoataroundDetail({...options,bodyText}));
 }
 const bodyText=header+'CONFIRMED\nCustomer payment\nUNKNOWN';
 assert.equal(detailReady(bodyText),true);
 assert.throws(()=>parseBoataroundDetail({...options,bodyText}));
});

test('a detail explicitly cancelled without financial labels overrides unchanged old Confirmed lists',async()=>{
 const {pages,url,header}=cancellationFixture(),body=header+'CANCELLED';
 const page=new FakePage([pages,clone(pages)],{details:{[url]:body}});
 const wait=page.waitForFunction.bind(page);let checkedDetail=false;
 page.waitForFunction=async(fn,options,arg)=>{
  if(page.url()===url){
   const original=globalThis.document;
   try{globalThis.document={body:{innerText:body}};assert.equal(fn(),true);checkedDetail=true;}
   finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
  }
  return wait(fn,options,arg);
 };
 const result=await run(page),cancelled=result.orders.find(record=>record.booking_id==='280021');
 assert.equal(checkedDetail,true);assert.equal(cancelled.status,'cancelled');
 assert.equal(cancelled.platform_status,'CANCELLED');assert.equal('amount' in cancelled,false);
 assert.equal('customer_payment' in cancelled,false);assert.equal(result.pagination.listed_count,21);
});

test('final-page cancellation overrides paid detail with unchanged complete identity coverage even when price disappears',async()=>{
 const {pages,url,paid}=cancellationFixture(),last=clone(pages);
 last[1].rows[0].status='CANCELLED';delete last[1].rows[0].price;
 const result=await run(new FakePage([pages,last],{details:{[url]:paid}}));
 const cancelled=result.orders.find(record=>record.booking_id==='280021');
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.platform_status,'CANCELLED');
 assert.equal('amount' in cancelled,false);assert.equal('customer_payment' in cancelled,false);
 assert.deepEqual(result.pagination.pages_read,[1,2]);assert.equal(result.expected_count,21);
});

test('a cancellation cannot conceal changed boat, date, booking identity, or independent page coverage',async()=>{
 for(const mutate of [
  last=>{last[1].rows[0].booking='#280021\nGrandcat 55 | Tidewyn Discovery 5';},
  last=>{last[1].rows[0].times[1]={datetime:'2026-11-08T00:00:00.000Z',text:'8 Nov 2026'};},
  last=>{last[1].rows[0].booking='#999999\nWavecat 34 Open | Tidewyn Dream';},
  last=>{last[1].evidence.body.data[0].id=id(999);last[1].rows[0].url=UI+'/'+id(999);},
 ]){
  const {pages,url,paid}=cancellationFixture(),last=clone(pages);
  last[1].rows[0].status='CANCELLED';delete last[1].rows[0].price;mutate(last);
  await assert.rejects(run(new FakePage([pages,last],{details:{[url]:paid}})),{code:'incomplete_pages'});
 }
});

test('unchanged paid booking price changes and non-cancellation state changes still refuse the snapshot',async()=>{
 for(const mutate of [last=>{last[1].rows[0].price='€124';},last=>{last[1].rows[0].status='COMPLETED';}]){
  const {pages,url,paid}=cancellationFixture(),last=clone(pages);mutate(last);
  await assert.rejects(run(new FakePage([pages,last],{details:{[url]:paid}})),{code:'incomplete_pages'});
 }
});
