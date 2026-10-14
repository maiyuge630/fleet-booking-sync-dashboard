import {BOATAROUND_ACCOUNT_ID, FLEET, parseBoataroundListRow, parseBoataroundDetail, isAccessChallenge} from '../parsers.mjs';

// The vendor's list UI consumes {count,data} and uses offset/limit=20. Observe
// that UI's own requests; never read or reconstruct its authorization headers.
export const BOATAROUND_ORDERS_URL=`https://partner.boataround.com/en/${BOATAROUND_ACCOUNT_ID}/orders`;
const API_ORIGIN='https://partner-api.boataround.com';
const API_PATH=`/v1/charters/${BOATAROUND_ACCOUNT_ID}/orders`;
const DETAIL_PREFIX=BOATAROUND_ORDERS_URL+'/';
const PAGE_SIZE=20, MAX_COUNT=1000;
const fail=(code='incomplete_pages')=>{throw Object.assign(new Error(code),{code});};
function check(context){if(context.signal?.aborted||!Number.isFinite(context.deadlineAt)||Date.now()>=context.deadlineAt)fail('timeout');}
function budget(context){check(context);return Math.max(1,Math.min(18000,context.deadlineAt-Date.now()));}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export async function waitForBoataroundCondition(page,predicate,context,...args){
 const handle=await page.waitForFunction(predicate,{timeout:budget(context),polling:250,
  ...(context.signal?{signal:context.signal}:{})},...args);
 try{check(context);}finally{await handle?.dispose?.();}
}

export function validateBoataroundListEvidence({request_url,status,body}){
 let url;try{url=new URL(request_url);}catch{fail();}
 if(url.origin!==API_ORIGIN||url.pathname!==API_PATH||url.username||url.password||url.hash)fail();
 if([...url.searchParams.keys()].some(key=>!['lang','offset','limit','sort'].includes(key)))fail();
 for(const key of ['lang','offset','limit'])if(url.searchParams.getAll(key).length!==1)fail();
 if(url.searchParams.getAll('sort').length>1||url.searchParams.get('lang')!=='en_GB'||url.searchParams.get('limit')!=='20')fail();
 const rawOffset=url.searchParams.get('offset');
 if(!/^(0|[1-9]\d*)$/.test(rawOffset))fail();
 const offset=Number(rawOffset),sort=url.searchParams.get('sort');
 if(!Number.isSafeInteger(offset)||offset%PAGE_SIZE||offset>=MAX_COUNT||(sort!==null&&(!sort||sort.length>100)))fail();
 if(status===401||status===403)fail('auth_required');
 if(status!==200&&status!==204)fail('fetch_failed');
 // Only the vendor's explicit HTTP 204 convention means an empty response.
 if(status===204){if(body!==null&&body!==undefined&&body!=='')fail('schema_changed');body={count:0,data:[]};}
 if(!body||typeof body!=='object'||Array.isArray(body)||!Number.isSafeInteger(body.count)||body.count<0||body.count>MAX_COUNT||!Array.isArray(body.data))fail('schema_changed');
 const count=body.count,ids=body.data.map(row=>row?.id);
 if((count===0&&offset!==0)||(count>0&&offset>=count)||ids.length!==Math.max(0,Math.min(PAGE_SIZE,count-offset)))fail();
 if(ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))||new Set(ids).size!==ids.length)fail();
 return {offset,limit:PAGE_SIZE,sort,count,ids};
}

export function verifyBoataroundPaginationEvidence(pages){
 if(!Array.isArray(pages)||!pages.length)fail();
 const count=pages[0].count,sort=pages[0].sort;
 if(!Number.isSafeInteger(count)||count<0||count>MAX_COUNT||pages.length!==Math.max(1,Math.ceil(count/PAGE_SIZE)))fail();
 const seen=new Set();
 for(let index=0;index<pages.length;index++){
  const page=pages[index];
  if(page.count!==count||page.sort!==sort||page.offset!==index*PAGE_SIZE||page.limit!==PAGE_SIZE||!Array.isArray(page.ids)||page.ids.length!==Math.max(0,Math.min(PAGE_SIZE,count-page.offset)))fail();
  for(const id of page.ids){if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)||seen.has(id))fail();seen.add(id);}
 }
 if(seen.size!==count)fail();
 return {complete:true,total_pages:pages.length,pages_read:pages.map((_,i)=>i+1),listed_count:count};
}

// Observed expired-session flow returns HTTP 200 first, then the SPA changes
// to this exact sign-in route without issuing any account orders request.
export function boataroundLoginDetected(){
 return location.origin==='https://partner.boataround.com'&&location.pathname==='/en/login'&&
  Boolean(document.querySelector('input[type="password"]'));
}

function observeNextListResponse(page,context){
 let settled=false,resolve,reject,timer;
 const loginAbort=new AbortController(),waitMs=budget(context),deadlineBound=context.deadlineAt-Date.now()<=18000;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 // The UI navigation may fail before this promise is awaited.
 promise.catch(()=>{});
 const cleanup=()=>{clearTimeout(timer);page.off('response',onResponse);context.signal?.removeEventListener('abort',onAbort);loginAbort.abort();};
 const finish=(error,value)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value);};
 const rejected=code=>Object.assign(new Error(code),{code});
 const onAbort=()=>finish(rejected('timeout'));
 const onResponse=response=>{
  let url;try{url=new URL(response.url());}catch{return;}
  if(url.origin!==API_ORIGIN||url.pathname!==API_PATH||response.request().method()!=='GET')return;
  page.off('response',onResponse);
  (async()=>{
   const status=response.status();let body=null;
   if(status===200){
    const contentType=String(response.headers()['content-type']??'');
    if(!/^application\/json(?:\s*;|$)/i.test(contentType))fail('schema_changed');
    const text=await response.text();if(Buffer.byteLength(text,'utf8')>2*1024*1024)fail('schema_changed');
    try{body=JSON.parse(text);}catch{fail('schema_changed');}
   }
   return validateBoataroundListEvidence({request_url:response.url(),status,body});
  })().then(value=>finish(null,value),error=>finish(error));
 };
 timer=setTimeout(()=>finish(rejected(deadlineBound?'timeout':'fetch_failed')),waitMs);
 context.signal?.addEventListener('abort',onAbort,{once:true});
 page.on('response',onResponse);
 // Keep the same bounded capture, with a cancellable timer-based auth watcher.
 // Missing account text or a slow/failed network alone is never login proof.
 void Promise.resolve().then(()=>page.waitForFunction(boataroundLoginDetected,{
  timeout:waitMs,polling:250,signal:loginAbort.signal
 })).then(async handle=>{
  if(!handle)return;
  try{
   if(context.signal?.aborted||Date.now()>=context.deadlineAt)finish(rejected('timeout'));
   else finish(rejected('auth_required'));
  }finally{await handle.dispose?.();}
 }).catch(()=>{});
 return {promise,cancel:()=>finish(rejected('fetch_failed'))};
}

function extractList(){
 const rows=Array.from(document.querySelectorAll('[role="rowgroup"] [role="row"],tbody tr')).filter(row=>row.getClientRects().length).map(row=>{
  const cells=Array.from(row.querySelectorAll('[role="cell"],td'));
  return {status:cells[0]?.innerText,booking:cells[1]?.innerText,url:cells[1]?.querySelector('a')?.href,
   dates:cells[3]?.innerText,times:Array.from(cells[3]?.querySelectorAll('time')||[]).map(time=>({text:time.innerText,datetime:time.getAttribute('datetime')})),price:cells[4]?.innerText};
 });
 return {rows,account:document.body.innerText.includes('Tidewyn Marine'),noOrders:/no bookings|no orders|no results/i.test(document.body.innerText)};
}
function listReady({ids,prefix}){
 const rows=Array.from(document.querySelectorAll('[role="rowgroup"] [role="row"],tbody tr')).filter(row=>row.getClientRects().length);
 const urls=rows.map(row=>row.querySelector('[role="cell"] a,td a')?.href);
 return document.body.innerText.includes('Tidewyn Marine')&&urls.length===ids.length&&urls.every((url,index)=>url===prefix+ids[index])&&(ids.length>0||/no bookings|no orders|no results/i.test(document.body.innerText));
}
/** Runs in the page; wait for required rendered values without deciding status. */
export function boataroundDetailReady(){
 const text=String(document.body?.innerText??'');
 if(!/^#\d+\s+-\s+[^\r\n]+$/m.test(text))return false;
 const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const labels=['Boat','Date','Booking status','Customer payment','Agency payment','Agency price','Client price'],values={};
 for(const label of labels){
  const pattern=new RegExp('^'+label+'(?:\\s*[:\\t]\\s*(.*))?$','i');
  for(let index=0;index<lines.length;index++){
   const match=pattern.exec(lines[index]);if(!match)continue;
   const value=String(match[1]||lines[index+1]||'').replace(/\s+/g,' ').trim();
   // A label appearing before its value is not a loaded field. Ambiguous or
   // unknown actual values remain the strict parser's responsibility.
   if(value&&!labels.some(other=>other.toUpperCase()===value.toUpperCase()))values[label]??=value;
  }
 }
 if(!values.Boat||!values.Date||!values['Booking status'])return false;
 if(!['CONFIRMED','NEW','IN PROCESS'].includes(values['Booking status'].toUpperCase()))return true;
 if(!values['Customer payment'])return false;
 const payment=values['Customer payment'].toUpperCase();
 return !['PAID','PARTIALLY PAID'].includes(payment)||Boolean(values['Agency price']&&values['Client price']);
}
async function go(page,url,context){
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:budget(context)});check(context);
 // Matching content alone cannot make an error/cache response fresh evidence.
 if(isAccessChallenge(response))fail('challenge_required');
 if(response?.status()===401)fail('auth_required');
 if(!response||response.status()!==200||!/^text\/html(?:\s*;|$)/i.test(response.headers()['content-type']||''))fail('fetch_failed');
}
async function clickPage(page,number,context){
 check(context);const handles=await page.$$('button');let target=null;
 try{
  for(const handle of handles){
   if(await handle.evaluate((element,text)=>element.getClientRects().length>0&&!element.disabled&&element.innerText.trim()===text,String(number))){if(target)fail('schema_changed');target=handle;}
  }
  if(!target)fail('incomplete_pages');
  // Puppeteer's pointer click scrolls through requestAnimationFrame. Android
  // Chrome suspends those frames with the screen off. Invoke the same enabled
  // pagination button directly; response and row identity checks still apply.
  await target.evaluate(element=>{if(element.disabled||!element.isConnected)throw Error('incomplete_pages');element.click();});
 }finally{await Promise.all(handles.map(handle=>handle.dispose?.().catch(()=>{})));}
}
function rowIds(rows){
 return rows.map(row=>{if(typeof row.url!=='string'||!row.url.startsWith(DETAIL_PREFIX))fail();const id=row.url.slice(DETAIL_PREFIX.length);if(!/^[a-f0-9]{24}$/.test(id))fail();return id;});
}
function stableFields(record){return [record.booking_id,record.detail_id,record.boataround_slug,record.start,record.end,record.platform_status,record.list_price??null];}
function identityFields(record){return [record.booking_id,record.detail_id,record.boataround_slug,record.start,record.end];}
function reconcileFinalCancellations(first,final,orders){
 if(!same(first.pages,final.pages)||first.records.length!==final.records.length)fail();
 const cancellations=new Map();
 for(let index=0;index<first.records.length;index++){
  const before=first.records[index],after=final.records[index];
  if(same(stableFields(before),stableFields(after)))continue;
  // A newly observed cancellation removes occupancy immediately, even if its
  // price disappears. No other status, identity, boat, date or page change is
  // allowed to pass the complete second-read gate.
  if(after.status!=='cancelled'||before.status==='cancelled'||!same(identityFields(before),identityFields(after)))fail();
  cancellations.set(after.booking_id,after);
 }
 return orders.map(order=>cancellations.get(order.booking_id)??order);
}
async function listRound(context){
 const {page}=context,pages=[],records=[];let total=1;
 for(let number=1;number<=total;number++){
  const capture=observeNextListResponse(page,context);let evidence;
  try{if(number===1)await go(page,BOATAROUND_ORDERS_URL,context);else await clickPage(page,number,context);evidence=await capture.promise;}
  finally{capture.cancel();}
  if(evidence.offset!==(number-1)*PAGE_SIZE||(pages.length&&(evidence.count!==pages[0].count||evidence.sort!==pages[0].sort)))fail();
  total=Math.max(1,Math.ceil(evidence.count/PAGE_SIZE));
  await waitForBoataroundCondition(page,listReady,context,{ids:evidence.ids,prefix:DETAIL_PREFIX});
  const list=await page.evaluate(extractList);check(context);
  if(!list.account)fail('auth_required');
  if(!same(rowIds(list.rows),evidence.ids)||(evidence.count===0&&!list.noOrders))fail();
  const stamp=new Date().toISOString();
  records.push(...list.rows.map(row=>parseBoataroundListRow(row,{verifiedAt:stamp})));pages.push(evidence);
 }
 const pagination=verifyBoataroundPaginationEvidence(pages);
 if(new Set(records.map(row=>row.booking_id)).size!==records.length)fail();
 return {pages,records,pagination};
}

export async function collectBoataround(context){
 const {page,fromDay}=context;check(context);
 // A real phone observation returned HTTP 304 with a reusable browser body.
 // Disable this page's cache so the inventory gate requires a fresh response;
 // never infer a zero count from a bodyless 304 or treat cached data as fresh.
 await page.setCacheEnabled(false);check(context);
 const first=await listRound(context),orders=[];
 // Checkout is protected through the whole day. Recheck its payment and
 // cancellation status today instead of treating it as immutable history.
 for(const record of first.records.filter(row=>row.end>=fromDay)){
  check(context);
  if(record.requires_detail||record.requires_payment_verification){
   await go(page,record.url,context);
   await waitForBoataroundCondition(page,boataroundDetailReady,context);
   const detail=parseBoataroundDetail({bodyText:await page.evaluate(()=>document.body.innerText),url:page.url(),verifiedAt:new Date().toISOString()});
   if(detail.booking_id!==record.booking_id||detail.detail_id!==record.detail_id||detail.boataround_slug!==record.boataround_slug||detail.start!==record.start||detail.end!==record.end)fail();
   orders.push(detail);
  }else orders.push(record);
 }
 // Revisit every list page, not just page 1: unchanged totals alone do not
 // detect a replaced, cancelled or rescheduled order on a later page.
 const final=await listRound(context);
 const reconciled=reconcileFinalCancellations(first,final,orders);
 check(context);
 return {source:'boataround',run_id:crypto.randomUUID(),checked_at:new Date().toISOString(),complete:true,
  scope:{kind:'current_future',from_day:fromDay,fleet_slugs:FLEET.map(boat=>boat.slug)},
  expected_count:reconciled.length,orders:reconciled,pagination:first.pagination};
}
