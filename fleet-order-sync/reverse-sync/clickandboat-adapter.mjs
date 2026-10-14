import {FLEET,isoDate,isAccessChallenge} from '../parsers.mjs';
const dayAfter=d=>new Date(Date.parse(isoDate(d)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const dayBefore=d=>new Date(Date.parse(isoDate(d)+'T00:00:00Z')-86400000).toISOString().slice(0,10);
const display=d=>d.split('-').reverse().join('/');
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const calendarUrl=id=>`https://www.clickandboat.com/uk/account/listing/edit/${id}:7`;
const availabilityApi='https://www.clickandboat.com/libs/Api/API.php?rquest=ProduitDisponibilite';
const calendarTimestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
function matchesCreateResponse(response,target,gap){
  try{
    const request=response.request();
    if(response.url()!==availabilityApi||request.url()!==availabilityApi||request.method()!=='POST')return false;
    const data=JSON.parse(request.postData());
    return !!data&&typeof data==='object'&&!Array.isArray(data)&&
      !Object.hasOwn(data,'__verb')&&!Object.hasOwn(data,'Id')&&
      String(data.ProduitId)===target.listing_id&&data.ProduitDisponibiliteTypeId==='Unavailable'&&
      data.DateDebut===gap.start+' 00:00:00'&&data.DateFin===gap.end+' 00:00:00';
  }catch{return false;}
}
function verifiedHtmlResponse(response,expectedUrl){
  if(!response)throw Error('calendar_read_failed');
  let url;try{url=new URL(response.url());}catch{throw Error('calendar_read_failed');}
  if(url.origin!=='https://www.clickandboat.com'||url.username||url.password)throw Error('target_identity_unverified');
  if(isAccessChallenge(response))throw Error('platform_challenge');
  if(response.status()===401)throw Error('auth_required');
  if(response.status()!==200||!/^text\/html(?:\s*;|$)/i.test(response.headers()['content-type']||''))throw Error('calendar_read_failed');
  if(url.href!==expectedUrl)throw Error('target_identity_unverified');
}
export function normalizeRows(rows) {
  const ids=new Set();
  return rows.map(r=>{
    if(!/^\d+$/.test(r.id)||ids.has(r.id)||!['Booked','Unavailable','Breakdown','Wintering'].includes(r.type)||
      !calendarTimestamp(r.from)||!calendarTimestamp(r.to)||r.from>=r.to)throw Error('calendar_schema_changed');
    ids.add(r.id);
    // Native checkout morning does not protect that night; whole-day manual
    // blocks ending 23:59 include their final night. Partial boundary days are
    // deliberately not expanded into invented whole-day protection.
    const start=r.from.slice(11)==='00:00:00'?isoDate(r.from.slice(0,10)):dayAfter(r.from.slice(0,10));
    const end=r.to.slice(11)>='23:59:00'?dayAfter(r.to.slice(0,10)):isoDate(r.to.slice(0,10));
    return {...r,start,end};
  }).filter(r=>r.start<r.end);
}
async function rows(page) {
  await page.waitForSelector('#unavaila-list',{visible:true,timeout:20000});
  return normalizeRows(await page.$$eval('#unavaila-list li.availability',nodes=>nodes.map(e=>({id:e.getAttribute('data-availa-id'),from:e.getAttribute('data-availa-from-date'),to:e.getAttribute('data-availa-to-date'),type:e.getAttribute('data-availa-type')}))));
}
// Executed in the already verified calendar page. Template content is inert:
// it is never inserted into the page and cannot execute response HTML scripts.
export function inspectCreateResult(html) {
  if(typeof html!=='string'||!html.trim()||html.length>200000)return null;
  const template=document.createElement('template');template.innerHTML=html;
  const root=template.content,element=root.firstElementChild;
  if(root.children.length!==1||element?.tagName!=='LI'||!element.classList.contains('availability')||
    [...root.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||root.querySelectorAll('li.availability').length!==1)return null;
  return {id:element.getAttribute('data-availa-id'),from:element.getAttribute('data-availa-from-date'),
    to:element.getAttribute('data-availa-to-date'),type:element.getAttribute('data-availa-type')};
}
export function validateCreateResult(data,row,gap) {
  if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.Resultat!=='string'||!data.Resultat.trim()||data.Resultat.length>200000||
    Object.hasOwn(data,'ErreurCode')&&![0,'0'].includes(data.ErreurCode))throw Error('platform_rejected_or_unverified');
  let normalized;try{normalized=normalizeRows([row]);}catch{throw Error('platform_rejected_or_unverified');}
  const created=normalized[0];
  if(normalized.length!==1||created.type!=='Unavailable'||created.start!==gap.start||created.end!==gap.end||
    created.from!==gap.start+' 00:00:00'||created.to!==dayBefore(gap.end)+' 23:59:00')throw Error('platform_rejected_or_unverified');
  return created;
}
async function selectDate(page,selector,date) {
  isoDate(date);await page.click(selector);await page.waitForSelector('#ui-datepicker-div',{visible:true});
  const [year,month,day]=date.split('-').map(Number),goal=year*12+month-1;
  for(let step=0;step<24;step++) {
    const title=(await page.$eval('#ui-datepicker-div .ui-datepicker-title',e=>e.innerText)).trim().toLowerCase().replace(/\s+/g,' ');
    const match=/^([a-z]+) (\d{4})$/.exec(title),index=match?MONTHS.indexOf(match[1]):-1;
    if(index<0)throw Error('calendar_month_unknown');
    const current=Number(match[2])*12+index;
    if(current===goal) {
      const links=await page.$$(`#ui-datepicker-div td[data-year="${year}"][data-month="${month-1}"]:not(.ui-state-disabled) a`),matches=[];
      for(const link of links)if(await link.evaluate(e=>e.textContent.trim())===String(day))matches.push(link);
      if(matches.length!==1)throw Error('date_disabled_or_ambiguous');
      await matches[0].click();
      await page.waitForFunction((s,v)=>document.querySelector(s)?.value===v,{polling:250,timeout:5000},selector,display(date));return;
    }
    await page.click(`#ui-datepicker-div [title="${current<goal?'Next':'Previous'}"]`);
  }
  throw Error('calendar_navigation_limit');
}
export class ClickAndBoatAdapter {
  constructor({openPage,closePage}) {Object.assign(this,{openPage,closePage});}
  async read(target) {
    const boat=FLEET.find(b=>b.slug===target.boat&&b.clickandboat_id===target.listing_id);
    if(!boat)throw Error('mapping_unknown');
    if(!this.page){this.page=await this.openPage('clickandboat');await this.page.setCacheEnabled(false);}
    const page=this.page;
    if(this.listing!==target.listing_id) {
      const accountUrl='https://www.clickandboat.com/uk/account/bookings';
      verifiedHtmlResponse(await page.goto(accountUrl,{waitUntil:'domcontentloaded',timeout:45000}),accountUrl);
      await page.waitForFunction(()=>[...document.querySelectorAll('h1')].some(e=>e.innerText.trim()==='Demo Owner')&&document.body.innerText.includes('All your bookings'),{polling:250,timeout:20000});
    }
    const url=calendarUrl(target.listing_id);
    verifiedHtmlResponse(await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}),url);
    await page.waitForFunction(()=>document.body.innerText.includes('Select the dates when your boat is unavailable.'),{polling:250,timeout:20000});
    this.listing=target.listing_id;this.before=await rows(page);
    return {identity_verified:true,complete:true,blocks:this.before};
  }
  async prepare(target,gap) {
    if(this.listing!==target.listing_id)throw Error('wrong_listing');
    this.direct=false;
    // A failed selection can leave datepicker min/max bounds from a previous
    // range. Reset the form and recheck the calendar before the next interval.
    verifiedHtmlResponse(await this.page.reload({waitUntil:'domcontentloaded',timeout:45000}),calendarUrl(target.listing_id));
    const latest=await rows(this.page);
    if(JSON.stringify(latest)!==JSON.stringify(this.before))throw Error('target_changed_during_preparation');
    try {
      await selectDate(this.page,'#date-from',gap.start);await selectDate(this.page,'#date-to',dayBefore(gap.end));
    } catch(error) {
      if(error.message!=='date_disabled_or_ambiguous'&&error.name!=='TimeoutError')throw error;
      // Use the very same authenticated owner API invoked by the Add button.
      // Rental not_selectable constraints also affect the generic datepicker;
      // server-side validation remains authoritative for this owner operation.
      // Datepicker selection has not submitted anything. Recheck the calendar
      // before using the owner API with explicit dates, never uncertain fields.
      const unchanged=await rows(this.page);
      if(JSON.stringify(unchanged)!==JSON.stringify(this.before))throw Error('target_changed_during_preparation');
      await this.page.waitForFunction(()=>typeof window.CAB?.Account?.Ad?.createAvailability==='function',{polling:250,timeout:10000});
      this.direct=true;return;
    }
    await this.page.click('#availa-type');await this.page.click('#availa-type [data-value="Unavailable"]');
    const values=await this.page.$$eval('#date-from,#date-to',nodes=>nodes.map(e=>e.value));
    if(values[0]!==display(gap.start)||values[1]!==display(dayBefore(gap.end)))throw Error('form_date_mismatch');
  }
  async submit(target,gap,saveEvidence=async()=>{},{guard}={}) {
    await guard?.({beforeFirstWrite:true});
    const responsePromise=this.page.waitForResponse(r=>matchesCreateResponse(r,target,gap),{timeout:20000}).then(response=>({response}),error=>({error}));
    if(this.direct)await this.page.evaluate(({id,start,end})=>{
      if(location.origin!=='https://www.clickandboat.com'||CAB.API_URL!=='https://www.clickandboat.com/libs/Api/API.php')throw Error('owner_api_scope_changed');
      const code=CAB.Account.Ad.createAvailability({productId:id,typeId:'Unavailable',fromDate:CAB.Any.parseDate(start),toDate:CAB.Any.parseDate(end),sentFrom:document.querySelector('#publish-boat')?.dataset.sentFrom||null},()=>{},()=>{});
      if(typeof code==='number'&&code<0)throw Error('owner_api_input_rejected');
    },{id:target.listing_id,start:gap.start,end:gap.end});
    else {
      await this.page.evaluate(()=>{if(location.origin!=='https://www.clickandboat.com'||CAB.API_URL!=='https://www.clickandboat.com/libs/Api/API.php')throw Error('owner_api_scope_changed');});
      await this.page.click('#btn-add-unavaila');
    }
    const received=await responsePromise;
    if(received.error)throw Error('platform_submission_not_observed');
    const response=received.response,data=await response.json().catch(()=>null);
    await saveEvidence({http_status:response.status(),error_code:data?.ErreurCode??null,message:typeof data?.ErreurMessage==='string'?data.ErreurMessage.slice(0,200):null});
    if(!response.ok())throw Error('platform_rejected_or_failed:'+response.status());
    // The observed client appends Resultat HTML on success; ErreurCode is not
    // required in that response. A success code alone never grants ownership.
    if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers()['content-type']||'')||
      !data||typeof data!=='object'||Array.isArray(data)||typeof data.Resultat!=='string'||!data.Resultat.trim()||data.Resultat.length>200000||
      Object.hasOwn(data,'ErreurCode')&&![0,'0'].includes(data.ErreurCode))throw Error('platform_rejected_or_unverified');
    const responseCreated=validateCreateResult(data,await this.page.evaluate(inspectCreateResult,data.Resultat),gap);
    if(this.before.some(b=>b.id===responseCreated.id))throw Error('created_record_mismatch');
    await saveEvidence({http_status:response.status(),error_code:data.ErreurCode??null,response_created:responseCreated});
    verifiedHtmlResponse(await this.page.reload({waitUntil:'domcontentloaded',timeout:45000}),calendarUrl(target.listing_id));
    const after=await rows(this.page),created=after.filter(a=>!this.before.some(b=>b.id===a.id));
    if(created.length!==1||JSON.stringify(created[0])!==JSON.stringify(responseCreated)||
      this.before.some(b=>!after.some(a=>JSON.stringify(a)===JSON.stringify(b))))throw Error('created_record_mismatch');
    return created[0];
  }
  async remove(target,owned,{guard}={}) {
    if(this.listing!==target.listing_id||owned.type!=='Unavailable'||!/^\d+$/.test(owned.id)||!this.before.some(b=>JSON.stringify(b)===JSON.stringify(owned)))throw Error('release_identity_mismatch');
    await guard?.();
    await this.page.evaluate(async id=>{
      if(location.origin!=='https://www.clickandboat.com'||window.CAB?.API_V3_URL!=='https://www.clickandboat.com/api/v3'||!window.jQuery)throw Error('release_api_unavailable');
      await new Promise((resolve,reject)=>jQuery.ajax({url:CAB.API_V3_URL+'/products/unavailabilities/'+id,method:'DELETE',timeout:20000}).done(()=>resolve()).fail(()=>reject(Error('release_request_failed'))));
    },owned.id);
  }
  async close() {const page=this.page;this.page=null;this.listing=null;if(page)await this.closePage(page);}
}
