import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {samBoatListLocation, inspectSamBoatDocument, validateSamBoatDocument, reconcileSamBoatPage,
  assertSamBoatTraversal, assertSamBoatRecheck, collectSamBoat, validateSamBoatResponse} from './samboat.mjs';

const BASE = 'https://www.samboat.com/private/reservations';
const LABELS = {'new-message':'Unread',ongoing:'Requests',confirmed:'Confirmed',archived:'Archived'};
function card(id, tab, page = 1, state = 'Completed') {
  const text = `${id}\n01 - 08 Jan 2027 in the morning\nSeacat 40 Open\n$22,501.68\n${state}`;
  return {url:`https://www.samboat.com/private/reservation/${id}?tab=${tab}&page=${page}`,text,content:text.replace(/\s+/g,' '),visible:true};
}
function doc({live=false, active='ongoing', url=BASE} = {}) {
  return {url, live, ready:true, account:true, hideProps:[],
    filters:!live || active==='archived' ? [{type:'checkbox',checked:false}] : [],
    tabs:Object.entries(LABELS).map(([id,text])=>({target:'#'+id,text})),
    panels:Object.keys(LABELS).map(id=>({id,active:id===active,
      cards:id==='new-message'?[]:[card(id==='archived'?'200':'1000001',id)],
      pages:[], controls:[], pagination:[], empty:false, busy:false}))};
}
function panel(view,id='archived'){return view.panels.find(p=>p.id===id);}
function pager(view, current, numbers=[1,2]) {
  const target=panel(view);
  target.pages=numbers.filter(n=>n!==current).map(n=>({url:BASE+'?archived='+n,text:String(n),rel:''}));
  target.pagination=[{current:[String(current)],items:[
    {text:'<',active:false,disabled:current===1,links:current===1?[]:[BASE+'?archived='+(current-1)]},
    ...numbers.map(n=>({text:String(n),active:n===current,disabled:false,links:n===current?[]:[BASE+'?archived='+n]})),
    {text:'>',active:false,disabled:current===Math.max(...numbers),links:current===Math.max(...numbers)?[]:[BASE+'?archived='+(current+1)]}
  ]}];
}
const rejects=(fn,code='incomplete_pages')=>assert.throws(fn,error=>error.code===code);

test('Unread notification counts are accepted without changing status coverage or booking totals',()=>{
  for (const count of ['',' 1',' 27',' 100']) {
    const view=doc();view.tabs[0].text='Unread'+count;
    assert.doesNotThrow(()=>validateSamBoatDocument(view));
  }
  for (const label of ['Unread pending','Unread -1','Unread 1 2','Unread 1/2','Confirmed 1']) {
    const view=doc();view.tabs[0].text=label;
    rejects(()=>validateSamBoatDocument(view),'schema_changed');
  }
  const view=doc();view.tabs[1].text='Requests 27';
  rejects(()=>validateSamBoatDocument(view),'schema_changed');
});

test('only observed pending answer actions inside their matching request cards are accepted',()=>{
 for(const [label,action] of [['Pre-paid: answer','prepaid_answer'],['Answer','answer_request']]){
  const view=doc(),target=panel(view,'ongoing'),pending=card('1654079','ongoing',1,label);
  target.cards=[pending];
  target.controls=[{tag:'button',type:'button',text:label,id:'',name:'',value:'',
    card_action:action,card_url:pending.url}];
  assert.doesNotThrow(()=>validateSamBoatDocument(view));
  for(const mutate of [
    v=>{panel(v,'ongoing').controls[0].card_url=BASE+'/not-a-card';},
    v=>{delete panel(v,'ongoing').controls[0].card_action;},
    v=>{panel(v,'ongoing').controls[0].name='hidePending';},
    v=>{panel(v,'ongoing').controls[0].type='submit';},
    v=>{panel(v,'ongoing').controls[0].text='Accept';},
    v=>{panel(v,'ongoing').controls[0].card_action=action==='prepaid_answer'?'answer_request':'prepaid_answer';},
    v=>{panel(v,'ongoing').cards[0].content=panel(v,'ongoing').cards[0].content.replace(label,'Deposit paid');},
    v=>{panel(v,'ongoing').controls.push({...panel(v,'ongoing').controls[0]});},
    v=>{panel(v,'confirmed').controls=panel(v,'ongoing').controls;panel(v,'confirmed').cards=panel(v,'ongoing').cards;},
  ]){const changed=structuredClone(view);mutate(changed);rejects(()=>validateSamBoatDocument(changed),'schema_changed');}
 }
});

test('authenticated SamBoat response classification separates login redirects, 401, and challenges',()=>{
  const response=(status=200,url=BASE,type='text/html; charset=utf-8')=>({status:()=>status,url:()=>url,headers:()=>({'content-type':type})});
  assert.equal(validateSamBoatResponse(response()),BASE);
  for(const target of ['https://www.samboat.com/login','https://www.samboat.com/login?return=/private/reservations'])
    assert.throws(()=>validateSamBoatResponse(response(200,target)),{code:'auth_required',diagnostic_reason:'login_redirect'});
  assert.throws(()=>validateSamBoatResponse(response(401)),{code:'auth_required',diagnostic_reason:'http_401'});
  for(const status of [403,429,500,503])assert.throws(()=>validateSamBoatResponse(response(status)),{code:'fetch_failed',diagnostic_reason:'http_status'});
  assert.throws(()=>validateSamBoatResponse(response(200,BASE,'application/json')),{code:'fetch_failed',diagnostic_reason:'unexpected_content_type'});
  // A path on an unrelated origin must never trigger saved-password recovery.
  rejects(()=>validateSamBoatResponse(response(200,'https://unrelated.invalid/login')),'schema_changed');
  assert.throws(()=>validateSamBoatResponse(response(200,'https://www.samboat.com/')),{code:'auth_required',diagnostic_reason:'login_redirect'});
  assert.throws(()=>validateSamBoatResponse(response(403,'https://www.samboat.com/')),{code:'fetch_failed',diagnostic_reason:'http_status'});
  assert.throws(()=>validateSamBoatResponse(response(200,'https://www.samboat.com/','application/json')),{code:'fetch_failed',diagnostic_reason:'unexpected_content_type'});
  rejects(()=>validateSamBoatResponse(response(200,'https://www.samboat.com.evil.invalid/')),'schema_changed');
  rejects(()=>samBoatListLocation('https://unrelated.invalid/login'),'schema_changed');
});

test('real DOMParser finds raw role=tab anchors without a tablist ancestor and keeps live tabs scoped', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium','/usr/bin/chromium-browser'].find(path=>path&&existsSync(path));
  if(!executablePath){t.skip('An installed local Chromium is needed for this DOM test');return;}
  const require=createRequire(new URL('../phone-server/package.json',import.meta.url));
  const puppeteer=require('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();await page.setRequestInterception(true);
    page.on('request',request=>request.abort());
    const rawHtml='<html><body><div class="container"><nav>'+Object.entries(LABELS).map(([id,label])=>
      `<a role="tab" href="#${id}">${label}</a>`).join('')+'</nav>'+Object.keys(LABELS).map(id=>
      `<div role="tabpanel" id="${id}" class="${id==='ongoing'?'active':''}">${id==='new-message'?'':'No bookings'}</div>`).join('')+
      '<input type="checkbox" id="hideArchivedRefusedAndCancelled">'+
      '<a href="https://www.samboat.com/private/reservations/new-messages/mark-as-read?to_user_id=700000">Mark all as read</a></div></body></html>';
    assert.equal(await page.evaluate(html=>new DOMParser().parseFromString(html,'text/html').querySelectorAll('[role="tablist"] [role="tab"]').length,rawHtml),0);
    const raw=await page.evaluate(inspectSamBoatDocument,{html:rawHtml,url:BASE});
    assert.equal(raw.tabs.length,4);assert.doesNotThrow(()=>validateSamBoatDocument(raw));
    await page.setContent(rawHtml.replace('<nav>','<nav role="tablist">').replace('</body>','<a role="tab" href="#unrelated">Unrelated</a></body>'));
    const live=await page.evaluate(inspectSamBoatDocument,{url:BASE});
    assert.equal(live.tabs.length,4);assert.doesNotThrow(()=>validateSamBoatDocument(live));
    const unknown=await page.evaluate(inspectSamBoatDocument,{html:rawHtml.replace('</nav>','<a role="tab" href="#unknown">Unknown</a></nav>'),url:BASE});
    rejects(()=>validateSamBoatDocument(unknown));
  }finally{await browser.close();}
});

test('observed Unread badge and inline pending button survive SSR/live reconciliation without business clicks', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(path=>path&&existsSync(path));
  if(!executablePath){t.skip('An installed local Chromium is needed for this DOM test');return;}
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
    const evidence=(await readFile(new URL('../samboat-reliability-v14/structure-before.jsonl',import.meta.url),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(row=>row.kind==='server');
    assert.equal(evidence.account,true);assert.match(evidence.structure.tabs[0].element.text,/Unread[\s\S]+1/);
    assert.equal(evidence.structure.buttons[0].element.text,'Pre-paid: answer');
    const button='<div class="col-12 col-md-3 order-4 order-md-4 ms-md-auto text-end text-md-center"><button type="button" class="btn btn-primary btn-sm btn-md-base btn-block">Pre-paid: answer</button></div>';
    const pending=id=>`<a href="https://www.samboat.com/private/reservation/1654079?tab=${id}&page=1">\n<div>1654079</div>\n<div>26 Sep 2026</div>\n<div>Seacat 40 Open</div>\n${button}\n</a>`;
    const html='<html><body><div class="container"><nav role="tablist">'+Object.entries(LABELS).map(([id,label])=>
      `<a role="tab" href="#${id}">${label}${id==='new-message'?' <span>1</span>':''}</a>`).join('')+'</nav>'+Object.keys(LABELS).map(id=>
      `<div role="tabpanel" id="${id}" class="${id==='ongoing'?'active':''}">${['new-message','ongoing'].includes(id)?pending(id):'No bookings'}</div>`).join('')+
      '<input type="checkbox" id="hideArchivedRefusedAndCancelled"><a href="https://www.samboat.com/private/reservations/new-messages/mark-as-read?to_user_id=700000">Mark all as read</a></div></body></html>';
    await page.setContent(html);await page.evaluate(()=>{window.businessClicks=0;document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>window.businessClicks++));});
    const raw=await page.evaluate(inspectSamBoatDocument,{html,url:BASE}),live=await page.evaluate(inspectSamBoatDocument,{url:BASE});
    assert.equal(panel(raw,'ongoing').controls[0].card_action,'prepaid_answer');
    const reconciled=reconcileSamBoatPage(raw,live,'ongoing');
    assert.equal(reconciled.records.length,1);assert.equal(reconciled.records[0].status,'pending');
    assert.equal(reconciled.records[0].start,'2026-09-26');assert.equal(reconciled.records[0].end,'2026-09-26');
    assert.equal(await page.evaluate(()=>window.businessClicks),0);
    const altered=await page.evaluate(inspectSamBoatDocument,{html:html.replace('type="button" class="btn','type="button" name="status-filter" class="btn'),url:BASE});
    rejects(()=>validateSamBoatDocument(altered),'schema_changed');
    const unknown=await page.evaluate(inspectSamBoatDocument,{html:html.replace('class="active">','class="active"><button type="button">Pre-paid: answer</button>'),url:BASE});
    rejects(()=>validateSamBoatDocument(unknown),'schema_changed');
  }finally{await browser.close();}
});

test('observed Answer request survives SSR/live quote hydration without clicking or becoming paid', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(path=>path&&existsSync(path));
  if(!executablePath){t.skip('An installed local Chromium is needed for this DOM test');return;}
  const observations=(await readFile(new URL('../samboat-incident-20260920/structure.jsonl',import.meta.url),'utf8'))
    .trim().split(/\r?\n/).map(line=>JSON.parse(line));
  for(const kind of ['server','rendered']){
    const observed=observations.find(row=>row.kind===kind);assert.equal(observed.account,true);
    assert.deepEqual(observed.controls.map(item=>item.panel),['new-message','ongoing']);
    for(const item of observed.controls){
      assert.equal(item.element.text,'Answer');assert.equal(item.element.tag,'BUTTON');
      assert.deepEqual(item.element.attrs,{type:'button',class:'btn btn-primary btn-sm btn-md-base btn-block'});
      assert.equal(item.parent.attrs.class,'col-12 col-md-3 order-4 order-md-4 ms-md-auto text-end text-md-center');
    }
  }
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
    const button='<div class="col-12 col-md-3 order-4 order-md-4 ms-md-auto text-end text-md-center"><button type="button" class="btn btn-primary btn-sm btn-md-base btn-block">Answer</button></div>';
    // Synthetic price props exercise the existing component hydration contract;
    // the quote is never proof that this newly observed request was paid.
    const sourcePrice=`<price :amount="346662" :currency='{"iso":"USD","decimals":2}' :tooltip-currency='{"iso":"USD","decimals":2}' :currencies='[{"iso":"USD","change":1}]'></price>`;
    const displayPrice='<span class="text-nowrap">$10,379.31<span class="text-secondary" data-bs-toggle="tooltip" data-bs-title="Fixture quote"><svg></svg></span></span>';
    function html(live){
      const pending=id=>`<a style="display:block" href="https://www.samboat.com/private/reservation/1655830?tab=${id}&page=1">\n<div>1655830</div>\n<div>27 Feb - 06 Mar 2027 in the morning</div>\n<div>Wavecat 34 open</div>\n<div class="col-auto col-md-3 text-md-center order-3 order-md-3"><div class="fs-large fw-bold d-flex justify-content-center align-items-center gap-1">${live?displayPrice:sourcePrice}</div></div>\n${button}\n</a>`;
      return '<html><body><div class="container"><nav'+(live?' role="tablist"':'')+'>'+Object.entries(LABELS).map(([id,label])=>
        `<a role="tab" href="#${id}">${label}${id==='new-message'?' <span>1</span>':''}</a>`).join('')+'</nav>'+Object.keys(LABELS).map(id=>
        `<div role="tabpanel" id="${id}" class="${id==='ongoing'?'active':''}">${['new-message','ongoing'].includes(id)?pending(id):'No bookings'}</div>`).join('')+
        '<input type="checkbox" id="hideArchivedRefusedAndCancelled"><a href="https://www.samboat.com/private/reservations/new-messages/mark-as-read?to_user_id=700000">Mark all as read</a></div></body></html>';
    }
    await page.setContent(html(true));await page.evaluate(()=>{window.businessClicks=0;document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>window.businessClicks++));});
    const raw=await page.evaluate(inspectSamBoatDocument,{html:html(false),url:BASE}),live=await page.evaluate(inspectSamBoatDocument,{url:BASE});
    for(const view of [raw,live])for(const id of ['new-message','ongoing'])assert.equal(panel(view,id).controls[0].card_action,'answer_request');
    assert.notEqual(panel(raw,'ongoing').cards[0].content,panel(live,'ongoing').cards[0].content);
    const result=reconcileSamBoatPage(raw,live,'ongoing');assert.equal(result.records.length,1);
    assert.equal(result.records[0].status,'pending');assert.equal(result.records[0].amount,'$10,379.31');
    assert.equal(result.records[0].boataround_slug,'wavecat-34-open-tidewyn-dream');
    assert.deepEqual([result.records[0].start,result.records[0].end],['2027-02-27','2027-03-06']);
    assert.equal(result.records[0].customer_payment_verified,undefined);
    for(const changed of [html(false).replace('type="button" class="btn','type="button" name="status-filter" class="btn'),
      html(false).replace('>Answer</button>','>Answer later</button>'),
      html(false).replace('class="active">','class="active"><button type="button">Answer</button>')]){
      const invalid=await page.evaluate(inspectSamBoatDocument,{html:changed,url:BASE});
      rejects(()=>validateSamBoatDocument(invalid),'schema_changed');
    }
    assert.equal(await page.evaluate(()=>window.businessClicks),0);
  }finally{await browser.close();}
});

test('observed SSR/live structure has four tabs, legitimate overlapping state lists and exact pager links',async()=>{
  const evidence=JSON.parse(await readFile(new URL('../evidence/inventory-structure-20260910.json',import.meta.url),'utf8')).samboat;
  assert.equal(evidence.http_status,200);
  assert.deepEqual(evidence.raw.tabs.map(t=>t.attrs.href),Object.keys(LABELS).map(id=>'#'+id));
  const getIds=(part,id)=>part.panels.find(p=>p.attrs.id===id).cards.map(c=>c.attrs.id);
  assert.deepEqual(getIds(evidence.raw,'ongoing'),getIds(evidence.raw,'confirmed'));
  assert.deepEqual(getIds(evidence.raw,'archived'),getIds(evidence.live,'archived'));
  assert.equal(getIds(evidence.raw,'archived').length,20);
  assert.equal(evidence.raw.filters[0].checked,false);
  assert.ok(evidence.raw.panels.find(p=>p.attrs.id==='archived').links.some(l=>l.attrs.href===BASE+'?archived=2'));
});

test('real DOM price normalization preserves source props and rendered money across final recheck', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(path=>path&&existsSync(path));
  if(!executablePath){t.skip('An installed local Chromium is needed for this DOM test');return;}
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
    const sourcePrice=`<price :amount="644399" :currency='{"iso":"EUR","decimals":2}' :tooltip-currency='{"iso":"EUR","decimals":2}' :currencies='[{"iso":"EUR","change":1},{"iso":"USD","change":1.1652}]'></price>`;
    const displayPrice='<span class="text-nowrap">$22,501.68<span class="text-secondary" data-bs-toggle="tooltip" data-bs-title="Equates to &lt;b&gt;6&nbsp;437,14&nbsp;€&lt;/b&gt;"><svg class="fa-base svg-price-info"></svg></span></span>';
    function html(live,price=live?displayPrice:sourcePrice){return '<html><body><div class="container"><nav'+(live?' role="tablist"':'')+'>'+Object.entries(LABELS).map(([id,label])=>`<a role="tab" href="#${id}">${label}</a>`).join('')+'</nav>'+Object.keys(LABELS).map(id=>
      `<div role="tabpanel" id="${id}" class="${id==='confirmed'?'active':''}">${id==='new-message'?'':`<a href="https://www.samboat.com/private/reservation/1502428?tab=${id}&page=1" style="display:block"><div>1502428</div><div>01 - 08 Jan 2027 in the morning</div><div>Seacat 40 Open</div><div class="col-auto col-md-3 text-md-center order-3 order-md-3"><div class="fs-large fw-bold d-flex justify-content-center align-items-center gap-1">${price}</div></div><b>Validated / Deposit Paid</b></a>`}</div>`).join('')+
      '<input type="checkbox" id="hideArchivedRefusedAndCancelled"><a href="https://www.samboat.com/private/reservations/new-messages/mark-as-read?to_user_id=700000">Mark all as read</a></div></body></html>';}
    const readRaw=source=>page.evaluate(inspectSamBoatDocument,{html:source,url:BASE});
    async function readLive(source){await page.setContent(source);return page.evaluate(inspectSamBoatDocument,{url:BASE});}
    const raw=await readRaw(html(false)),live=await readLive(html(true));
    assert.notEqual(panel(raw,'confirmed').cards[0].content,panel(live,'confirmed').cards[0].content);
    assert.equal(panel(raw,'confirmed').cards[0].content_without_price,panel(live,'confirmed').cards[0].content_without_price);
    const initial={...reconcileSamBoatPage(raw,live,'confirmed'),tab:'confirmed'};
    assert.equal(initial.records[0].amount,'$22,501.68');
    const source=panel(raw,'confirmed').cards[0].prices[0];assert.equal(source.amount_minor,'644399');assert.equal(source.currency.iso,'EUR');
    assert.equal(source.currencies[1].change,1.1652);
    for(const changedRaw of [html(false).replaceAll('644399','644400'),html(false).replaceAll('1.1652','1.17')]){
      const changed={...reconcileSamBoatPage(await readRaw(changedRaw),live,'confirmed'),tab:'confirmed'};
      rejects(()=>assertSamBoatRecheck([initial],[changed]));
    }
    const changedLive=await readLive(html(true).replaceAll('$22,501.68','$7,501.56'));
    rejects(()=>assertSamBoatRecheck([initial],[{...reconcileSamBoatPage(raw,changedLive,'confirmed'),tab:'confirmed'}]));
    rejects(()=>reconcileSamBoatPage(raw,{...live,panels:live.panels.map(p=>p.id==='confirmed'?{...p,cards:p.cards.map(c=>({...c,content_without_price:c.content_without_price+' unknown'}))}:p)},'confirmed'));
    for(const badPrice of [sourcePrice.replace(':amount="644399"',':amount="bad"'),sourcePrice+'<price></price>',sourcePrice.replace(' :currencies=', ' :unknown=')]){
      const bad=await readRaw(html(false,badPrice));rejects(()=>validateSamBoatDocument(bad),'schema_changed');
    }
    for(const badPrice of [displayPrice.replace('<svg','extra text<svg'),displayPrice.replace('$22,501.68','Seacat 40 Open'),displayPrice+'<span>extra</span>']){
      const bad=await readLive(html(true,badPrice));rejects(()=>validateSamBoatDocument(bad),'schema_changed');
    }
    // Exercise the actual DOM-to-signature path, including adjacent elements
    // without source whitespace and an empty retained price container.
    const cancelledRaw=await readRaw(html(false,'').replaceAll('Validated / Deposit Paid','Cancelled'));
    const cancelledLive=await readLive(html(true,'').replaceAll('Validated / Deposit Paid','Cancelled'));
    const cancelled={...reconcileSamBoatPage(cancelledRaw,cancelledLive,'confirmed'),tab:'confirmed'};
    assert.equal(assertSamBoatRecheck([initial],[cancelled])[0].status,'cancelled');
    assert.equal(cancelled.records[0].amount,undefined);
    for(const liveMode of [false,true]){
      const missingPrice=liveMode?await readLive(html(true,'')):await readRaw(html(false,''));
      rejects(()=>validateSamBoatDocument(missingPrice),'schema_changed');
    }
  }finally{await browser.close();}
});

test('only observed list origins, page keys and non-hiding flag are accepted',()=>{
  assert.equal(samBoatListLocation(BASE+'?hideArchivedRefusedAndCancelled=0&archived=2','archived').page,2);
  for(const url of [BASE+'?hideArchivedRefusedAndCancelled=1',BASE+'?archived=51']) rejects(()=>samBoatListLocation(url,'archived'));
  for(const url of [BASE+'?page=2',BASE+'?boat=1',BASE+'?archived=2&archived=3',BASE+'#archived',BASE.replace('www.','evil.')])
    rejects(()=>samBoatListLocation(url,'archived'),'schema_changed');
});
test('loaded raw/live documents reconcile cards independently of link totals',()=>{
  const server=doc(), live=doc({live:true,active:'confirmed'});
  assert.equal(reconcileSamBoatPage(server,live,'confirmed').records[0].booking_id,'1000001');
  live.ready=false; rejects(()=>reconcileSamBoatPage(server,live,'confirmed'));
});
test('late/missing/hidden rendered cards or changed text cannot replace a complete response',()=>{
  for(const mutate of [p=>p.cards.pop(),p=>p.cards.push(card('999','confirmed')),p=>p.cards[0].visible=false,p=>p.cards[0].content+=' changed']){
    const server=doc(), live=doc({live:true,active:'confirmed'});mutate(panel(live,'confirmed'));
    rejects(()=>reconcileSamBoatPage(server,live,'confirmed'));
  }
});
test('authentication, loading, missing tabs, unknown tabs and unknown controls fail closed',()=>{
  const cases=[['auth_required',d=>d.account=false],['incomplete_pages',d=>panel(d).busy=true],
    ['incomplete_pages',d=>d.tabs.pop()],['schema_changed',d=>d.tabs[0].text='Unknown'],
    ['schema_changed',d=>panel(d).controls.push({tag:'select',type:'',name:'status'})]];
  for(const [code,mutate]of cases){const view=doc();mutate(view);rejects(()=>validateSamBoatDocument(view),code);}
});
test('raw archive filter required; current live archive filter required; hidden cancellations always refused',()=>{
  for(const view of [doc(),doc({live:true,active:'archived'})]){
    view.filters=[];rejects(()=>validateSamBoatDocument(view),'schema_changed');
  }
  for(const mutate of [d=>d.filters[0].checked=true,d=>d.filters.push({type:'checkbox',checked:false}),d=>d.hideProps=['true']]){
    const view=doc();mutate(view);rejects(()=>validateSamBoatDocument(view));
  }
  assert.doesNotThrow(()=>validateSamBoatDocument(doc({live:true,active:'ongoing'})));
});
test('empty state cannot be inferred from no cards, while observed empty Unread is allowed',()=>{
  const view=doc();panel(view).cards=[];rejects(()=>validateSamBoatDocument(view));
  panel(view).empty=true;assert.doesNotThrow(()=>validateSamBoatDocument(view));
});
test('filters outside a tab cannot silently narrow the whole list',()=>{
  const view=doc();view.listControls=[{type:'text',id:'boat-filter',name:'boat'}];
  rejects(()=>validateSamBoatDocument(view),'schema_changed');
  view.listControls=[{type:'checkbox',id:'hideArchivedRefusedAndCancelled',checked:false}];
  assert.doesNotThrow(()=>validateSamBoatDocument(view));
});
test('actual page marker and href must agree; numeric declaration cannot lack link',()=>{
  const server=doc(),live=doc({live:true,active:'archived'});pager(server,1);pager(live,1);
  assert.deepEqual(reconcileSamBoatPage(server,live,'archived').declaredPages,[1,2]);
  for(const view of [server,live])panel(view).pagination[0].current=['2'];
  rejects(()=>reconcileSamBoatPage(server,live,'archived'));
  for(const view of [server,live]){pager(view,1);panel(view).pagination[0].items[2].links=[];}
  rejects(()=>reconcileSamBoatPage(server,live,'archived'));
});
test('unknown pager labels and wrong numeric target are rejected',()=>{
  for(const text of ['Load more','3']){
    const server=doc(),live=doc({live:true,active:'archived'});pager(server,1);pager(live,1);
    for(const view of [server,live])panel(view).pages[0].text=text;
    rejects(()=>reconcileSamBoatPage(server,live,'archived'),'schema_changed');
  }
});
test('a later page must retain the server current-page marker even if it has no links',()=>{
  const server=doc({url:BASE+'?archived=2'}),live=doc({live:true,active:'archived',url:BASE+'?archived=2'});
  rejects(()=>reconcileSamBoatPage(server,live,'archived'),'schema_changed');
});
test('ellipsis or next pointing at the current page cannot fake a terminal page',()=>{
  for(const mutate of [p=>p.pagination[0].items.push({text:'…',active:false,disabled:false,links:[]}),
    p=>p.pages.push({text:'>',rel:'',url:BASE+'?archived=1'}),
    p=>{p.pagination[0].items.at(-1).disabled=true;p.pagination[0].items.at(-1).links=[];},
    p=>p.pagination[0].items.pop()]){
    const server=doc(),live=doc({live:true,active:'archived'});pager(server,1);pager(live,1);
    for(const view of [server,live])mutate(panel(view));
    assert.throws(()=>reconcileSamBoatPage(server,live,'archived'),e=>['schema_changed','incomplete_pages'].includes(e.code));
  }
});
function simplePages(){
  return ['ongoing','confirmed','archived'].map(tab=>({tab,page:1,declaredPages:[],destinations:[],unreadIds:[],signature:tab,
    records:[{booking_id:tab==='archived'?'200':'1000001',boataround_slug:'boat',start:'2027-01-01',end:'2027-01-08',status:'completed',amount:'$1'}]}));
}
test('same booking in Requests and Confirmed deduplicates only when all business fields agree',()=>{
  const pages=simplePages();assert.equal(assertSamBoatTraversal(pages).length,2);
  for(const key of ['status','start','end','boataround_slug','amount']){
    const changed=structuredClone(pages);changed[1].records[0][key]='changed';rejects(()=>assertSamBoatTraversal(changed));
  }
});
test('page gaps, missing terminal pages and repetition within one tab refuse snapshot',()=>{
  const gap=simplePages();gap[2].declaredPages=[1,2];rejects(()=>assertSamBoatTraversal(gap));
  const duplicate=simplePages();duplicate.push({...structuredClone(duplicate[2]),page:2});rejects(()=>assertSamBoatTraversal(duplicate));
  const late=simplePages();late.push({...structuredClone(late[2]),page:3,records:[]});rejects(()=>assertSamBoatTraversal(late));
});
test('Unread is not used as a total and cannot contain an unseen booking',()=>{
  const pages=simplePages();pages[0].unreadIds=['1000001'];assert.equal(assertSamBoatTraversal(pages).length,2);
  pages[0].unreadIds=['999'];rejects(()=>assertSamBoatTraversal(pages));
});
test('final recheck compares every page, detects later archive change and missing pages',()=>{
  const before=simplePages();before.push({tab:'archived',page:2,signature:'old'});
  assert.doesNotThrow(()=>assertSamBoatRecheck(before,structuredClone(before).reverse()));
  const after=structuredClone(before);after[3].signature='new';rejects(()=>assertSamBoatRecheck(before,after));
  rejects(()=>assertSamBoatRecheck(before,before.slice(0,3)));
});
test('unknown card state stays rejected by existing parser',()=>{
  const server=doc(),live=doc({live:true,active:'confirmed'});
  for(const view of [server,live])panel(view,'confirmed').cards=[card('1000001','confirmed',1,'Unrecognized')];
  rejects(()=>reconcileSamBoatPage(server,live,'confirmed'),'BOOKING_STATUS');
});

function mockPage({changeOnRecheck=false}={}){
  let url=BASE,active='ongoing',baseNavigations=0;
  const visits=[];
  function view(live){
    const result=doc({url,live,active});const n=Number(new URL(url).searchParams.get('archived')||1);
    panel(result).cards=[card(n===1?'200':'201','archived',n,'Cancelled')];pager(result,n);
    if(changeOnRecheck&&baseNavigations>3&&n===2)panel(result).cards=[card('299','archived',n,'Cancelled')];
    return result;
  }
  return {visits,cache:null,setCacheEnabled:async function(enabled){this.cache=enabled;},
    goto:async target=>{url=target;active='ongoing';if(target===BASE)baseNavigations++;visits.push(target);
      return {status:()=>200,headers:()=>({'content-type':'text/html; charset=utf-8'}),url:()=>url,text:async()=>'<html>mock document</html>'};},
    url:()=>url,waitForFunction:async()=>{},$:async selector=>({evaluate:async fn=>fn({click:()=>{active=/#([^"\]]+)/.exec(selector)[1];}}),dispose:async()=>{}}),
    evaluate:async(fn,args)=>{assert.equal(fn.name,'inspectSamBoatDocument');return view(!args.html);}};
}
test('collector traverses two complete passes, disables cache, preserves legacy snapshot and cancelled/completed statuses',async()=>{
  const page=mockPage(), result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  assert.equal(page.cache,false);assert.equal(page.visits.length,8);
  assert.equal(result.pagination.total_pages,4);assert.equal(result.pagination.listed_count,3);
  assert.equal(result.orders.length,3);assert.equal(result.expected_count,3);assert.equal(result.complete,true);
  assert.equal(result.orders.find(r=>r.booking_id==='1000001').status,'completed');
  assert.equal(result.orders.filter(r=>r.status==='cancelled').length,2);
});

function requestPage(stateForView=()=> 'Answer'){
  const page=mockPage(),evaluate=page.evaluate,select=page.$,clicked=[];
  page.$=async selector=>{assert.match(selector,/^\[role="tablist"\] \[role="tab"\]\[href="#(?:ongoing|confirmed|archived)"\]$/);clicked.push(selector);return select(selector);};
  page.evaluate=async(fn,args)=>{
    const view=await evaluate(fn,args),state=stateForView(page);
    for(const id of state==='Answer'?['new-message','ongoing']:['ongoing']){
      const pending=card('1655830',id,1,state);panel(view,id).cards=[pending];
      panel(view,id).controls=state==='Answer'?[{tag:'button',type:'button',text:'Answer',id:'',name:'',value:'',card_action:'answer_request',card_url:pending.url}]:[];
    }
    return view;
  };
  return Object.assign(page,{clicked});
}

test('Answer, Pre-approved and Discussion requests remain pending without blocking complete cancelled history or causing business actions',async()=>{
 for(const state of ['Answer','Pre-approved','Discussion']){
  const page=requestPage(()=>state);
  const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  assert.equal(result.complete,true);assert.equal(page.cache,false);assert.equal(page.visits.length,8);assert.equal(page.clicked.length,8);
  assert.equal(result.pagination.total_pages,4);assert.equal(result.orders.length,4);assert.equal(result.expected_count,4);
  const request=result.orders.find(order=>order.booking_id==='1655830');
  assert.equal(request.status,'pending');assert.equal(request.platform_status,state);
  assert.equal(result.orders.filter(order=>order.status==='cancelled').length,2);
  assert.ok(page.visits.every(url=>new URL(url).pathname==='/private/reservations'));
 }
});

test('normal Answer to Pre-approved to Discussion transitions require a full fresh reread, not a mixed snapshot',async()=>{
 for(const [before,after] of [['Answer','Pre-approved'],['Pre-approved','Discussion']]){
 const page=requestPage(page=>page.visits.length<=4?before:after),events=[];
 const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000,reportDiagnostic:event=>events.push(event)});
 assert.equal(page.visits.length,16);assert.equal(result.complete,true);assert.equal(result.pagination.total_pages,4);
 const request=result.orders.find(order=>order.booking_id==='1655830');assert.equal(request.status,'pending');assert.equal(request.platform_status,after);
 assert.equal(events.filter(event=>event.stage==='final_recheck'&&event.reason==='incomplete_pages').length,1);
 assert.ok(page.visits.every(url=>new URL(url).pathname==='/private/reservations'));
 }
 for(const state of ['Pre-approved paid','Discussion paid']){
 const unknown=requestPage(()=>state);
 await assert.rejects(collectSamBoat({page:unknown,fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),{code:'BOOKING_STATUS'});
 }
});

test('documented Finished card preserves completed history while full account collection continues',async()=>{
 const page=requestPage(()=> 'Finished'),result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
 assert.equal(result.complete,true);assert.equal(page.visits.length,8);assert.equal(result.pagination.total_pages,4);
 assert.equal(result.orders.find(order=>order.booking_id==='1655830').status,'completed');
 assert.equal(result.orders.filter(order=>order.status==='cancelled').length,2);
 assert.ok(page.visits.every(url=>new URL(url).pathname==='/private/reservations'));
});

test('collector diagnostics identify list schema failures without page text or account data',async()=>{
  const diagnostics=[],page=mockPage(),evaluate=page.evaluate;
  page.evaluate=async(fn,args)=>{const value=await evaluate(fn,args);value.tabs[0].text='Unread broken secret';return value;};
  await assert.rejects(collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000,
    reportDiagnostic:value=>diagnostics.push(value)}),{code:'schema_changed'});
  assert.deepEqual(diagnostics.at(-1),{stage:'raw_document',reason:'tab_controls_changed'});
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));
});

test('collector reports timer/navigation failure stages and genuine login failures independently',async()=>{
  for(const [status,url,reason,code] of [[401,BASE,'http_401','auth_required'],[403,BASE,'http_status','fetch_failed'],
    [200,'https://www.samboat.com/login','login_redirect','auth_required']]){
    const page=mockPage(),diagnostics=[];
    page.goto=async()=>({status:()=>status,url:()=>url,headers:()=>({'content-type':'text/html'})});
    await assert.rejects(collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000,
      reportDiagnostic:value=>diagnostics.push(value)}),{code});
    assert.deepEqual(diagnostics.at(-1),{stage:'list_navigation',reason});
  }
  const page=mockPage(),diagnostics=[];
  page.waitForFunction=async()=>{throw Object.assign(new Error('private text'),{name:'TimeoutError'});};
  await assert.rejects(collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000,
    reportDiagnostic:value=>diagnostics.push(value)}),{name:'TimeoutError'});
  assert.deepEqual(diagnostics.at(-1),{stage:'list_ready',reason:'timeout'});
});

test('diagnostic callback failures cannot stop a valid collection or reveal exception text',async()=>{
  const result=await collectSamBoat({page:mockPage(),fromDay:'2026-09-10',deadlineAt:Date.now()+3000,
    reportDiagnostic:()=>{throw new Error('diagnostic sink unavailable');}});
  assert.equal(result.complete,true);
});
test('collector refuses a later page changed during full final recheck',async()=>{
  await assert.rejects(collectSamBoat({page:mockPage({changeOnRecheck:true}),fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),e=>e.code==='incomplete_pages');
});

test('one complete re-collection can resolve a changing final check without reusing old records',async()=>{
  const page=mockPage({changeOnRecheck:true}),events=[];
  const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000,reportDiagnostic:value=>events.push(value)});
  assert.equal(page.visits.length,16);assert.equal(result.pagination.total_pages,4);
  assert.ok(result.orders.some(order=>order.booking_id==='299'));assert.ok(!result.orders.some(order=>order.booking_id==='201'));
  const failure=events.findIndex(event=>event.stage==='final_recheck'&&event.reason==='incomplete_pages');
  assert.ok(failure>=0);assert.deepEqual(events[failure+1],{stage:'list_navigation',reason:'progress'});
  assert.equal(events.filter(event=>event.reason==='incomplete_pages').length,1);
});

test('a second changing final check fails, and the restart re-reads every page only once more',async()=>{
  const page=mockPage(),evaluate=page.evaluate,events=[];
  page.evaluate=async(fn,args)=>{
    const result=await evaluate(fn,args);
    if(new URL(result.url).searchParams.get('archived')==='2'){
      const id=String(300+Math.floor((page.visits.length-1)/4));
      panel(result).cards=[card(id,'archived',2,'Cancelled')];
    }
    return result;
  };
  await assert.rejects(collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000,reportDiagnostic:value=>events.push(value)}),{code:'incomplete_pages',diagnostic_stage:'final_recheck'});
  assert.equal(page.visits.length,16);assert.equal(events.filter(event=>event.reason==='incomplete_pages').length,2);
});

test('recheck retry cannot overrun its budget, ignore cancellation, or retry a changed raw schema',async()=>{
  const short=mockPage({changeOnRecheck:true});
  await assert.rejects(collectSamBoat({page:short,fromDay:'2026-09-10',deadlineAt:Date.now()+10000}),{code:'incomplete_pages'});
  assert.equal(short.visits.length,8);
  const controller=new AbortController(),cancelled=mockPage({changeOnRecheck:true});
  await assert.rejects(collectSamBoat({page:cancelled,fromDay:'2026-09-10',deadlineAt:Date.now()+60000,signal:controller.signal,
    reportDiagnostic:value=>{if(value.reason==='incomplete_pages')controller.abort();}}),{code:'incomplete_pages'});
  assert.equal(cancelled.visits.length,8);
  const changed=mockPage(),evaluate=changed.evaluate;
  changed.evaluate=async(fn,args)=>{const view=await evaluate(fn,args);view.tabs[0].text='Unknown';return view;};
  await assert.rejects(collectSamBoat({page:changed,fromDay:'2026-09-10',deadlineAt:Date.now()+60000}),{code:'schema_changed'});
  assert.equal(changed.visits.length,1);
});
test('expired context stops before browser access',async()=>{
  await assert.rejects(collectSamBoat({page:{},fromDay:'2026-09-10',deadlineAt:Date.now()-1}),e=>e.code==='timeout');
});

function paymentCard(tab='confirmed',state='Validated / Deposit Paid',amount='$22,501.68'){
  const value=card('1502428',tab,1,state);
  if(amount===null)value.text=value.text.replace('$22,501.68\n','');
  else value.text=value.text.replace('$22,501.68',amount);
  value.content=value.text.replace(/\s+/g,' ');
  value.content_without_price=value.content.replace(amount===null?'$22,501.68 ':amount+' ','');
  value.prices=amount===null?[]:[{kind:'display',text:amount,tooltip:'known-price'}];
  return value;
}
function checkedPage(value){
  const server=doc(),live=doc({live:true,active:'confirmed'});
  for(const view of [server,live])panel(view,'confirmed').cards=[structuredClone(value)];
  return {tab:'confirmed',...reconcileSamBoatPage(server,live,'confirmed')};
}
test('final recheck permits only a current cancellation with unchanged ID, boat, dates and page evidence',()=>{
  const before=checkedPage(paymentCard());
  for(const amount of ['$22,501.68',null,'$0.00','$1.00']){
    const after=checkedPage(paymentCard('confirmed','Cancelled',amount));
    const changes=assertSamBoatRecheck([before],[after]);
    assert.equal(changes.length,1);assert.equal(changes[0].booking_id,'1502428');assert.equal(changes[0].status,'cancelled');
  }
});
test('a cancellation cannot disguise another identity, boat, date, card body or pagination change',()=>{
  const before=checkedPage(paymentCard());
  for(const mutate of [
    c=>{c.url=c.url.replace('1502428','1502429');c.text=c.text.replace('1502428','1502429');},
    c=>{c.text=c.text.replace('Seacat 40 Open','Reefyard Reef CAT 37');},
    c=>{c.text=c.text.replace('01 - 08 Jan','02 - 08 Jan');},
    c=>{c.text='unexpected new content\n'+c.text;},
  ]){
    const value=paymentCard('confirmed','Cancelled',null);mutate(value);value.content=value.content_without_price=value.text.replace(/\s+/g,' ');
    rejects(()=>assertSamBoatRecheck([before],[checkedPage(value)]));
  }
  for(const mutate of [p=>{p.page=2;},p=>{p.destinations=[[2,BASE+'?confirmed=2']];},p=>{p.unreadIds=['1502428'];}]){
    const after=checkedPage(paymentCard('confirmed','Cancelled'));mutate(after);rejects(()=>assertSamBoatRecheck([before],[after]));
  }
});
test('final recheck never treats completion, refund price alone, or a cancellation request as final cancellation',()=>{
  const before=checkedPage(paymentCard());
  for(const state of ['Completed','Refused','Pending'])rejects(()=>assertSamBoatRecheck([before],[checkedPage(paymentCard('confirmed',state))]));
  rejects(()=>assertSamBoatRecheck([before],[checkedPage(paymentCard('confirmed','Validated / Deposit Paid','$1.00'))]));
  for(const state of ['Cancellation request','Pending modification'])assert.throws(()=>checkedPage(paymentCard('confirmed',state)),e=>e.name==='OrderParseError');
});
test('a final cancellation does not relax full signature checks for unrelated cards',()=>{
  const before=checkedPage(paymentCard()),after=checkedPage(paymentCard('confirmed','Cancelled'));
  const extraBefore=checkedPage(paymentCard('confirmed','Completed'));
  extraBefore.tab='archived';const extraAfter=structuredClone(extraBefore);extraAfter.signature=extraAfter.signature.replace('known-price','other-price');
  rejects(()=>assertSamBoatRecheck([before,extraBefore],[after,extraAfter]));
});

const paidPhoneBody=await readFile(new URL('../evidence/sb-phone-1502428-sanitized-20260910.txt',import.meta.url),'utf8');
function paidPage({detailBody=paidPhoneBody,initialState='Validated / Deposit Paid',finalState='Validated / Deposit Paid',finalAmount='$22,501.68',finalMutate=null}={}){
  let url=BASE,active='ongoing',baseNavigations=0;const visits=[],detailWaits=[],detailPredicates=[],detailPredicateArgs=[];
  function view(live){
    const result=doc({url,live,active}),recheck=baseNavigations>3,n=Number(new URL(url).searchParams.get('archived')||1);
    for(const tab of ['ongoing','confirmed']){
      const value=paymentCard(tab,recheck?finalState:initialState,recheck?finalAmount:'$22,501.68');
      if(recheck&&finalMutate){finalMutate(value);value.content=value.content_without_price=value.text.replace(/\s+/g,' ');}
      panel(result,tab).cards=[value];
    }
    panel(result).cards=[card(n===1?'200':'201','archived',n,'Cancelled')];pager(result,n);
    return result;
  }
  return {visits,detailWaits,detailPredicates,detailPredicateArgs,setCacheEnabled:async()=>{},url:()=>url,
    goto:async target=>{url=target;active='ongoing';if(target===BASE)baseNavigations++;visits.push(target);return {status:()=>200,headers:()=>({'content-type':'text/html'}),url:()=>url,text:async()=>'<html>observed page mock</html>'};},
    $:async selector=>({evaluate:async fn=>fn({click:()=>{active=/#([^"\]]+)/.exec(selector)[1];}}),dispose:async()=>{}}),
    waitForFunction:async(fn,options,...args)=>{if(url.includes('/private/reservation/')){detailPredicates.push(fn);detailPredicateArgs.push(args);const ready=vm.runInNewContext('('+fn.toString()+')(...args)',{args,document:{readyState:'complete',body:{innerText:detailBody}}});detailWaits.push(ready);assert.equal(ready,true,'Cancelled detail readiness cannot depend on a removed payment field');}},
    evaluate:async(fn,args)=>fn.name==='inspectSamBoatDocument'?view(!args.html):detailBody};
}

test('official deposit-label fixtures require hydrated money, verified detail and two complete list passes',async()=>{
 // Article 268 documents these statuses; their rendered fixtures are synthetic,
 // so this test makes no claim that these two labels were seen on the phone.
 for(const label of ['Deposit paid only','Validated/Deposit paid']){
  const detailBody=paidPhoneBody.replace('\nDeposit paid\n','\n'+label+'\n');
  const page=paidPage({detailBody,initialState:label,finalState:label});
  const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  const order=result.orders.find(order=>order.booking_id==='1502428');
  assert.equal(result.complete,true);assert.equal(result.pagination.total_pages,4);assert.equal(page.visits.length,9);
  assert.equal(order.status,'deposit_paid');assert.equal(order.platform_status,label);assert.equal(order.amount,'$22,501.68');
  assert.deepEqual(page.detailWaits,[true]);
  const ready=body=>vm.runInNewContext('('+page.detailPredicates[0].toString()+')(...args)',{
   args:page.detailPredicateArgs[0],document:{readyState:'complete',body:{innerText:body}}});
  assert.equal(ready(detailBody.replace('To be paid online\n$22,501.68\n','')),false);
  assert.equal(ready(detailBody.replace('To be paid online\n$22,501.68','To be paid online\nLoading…')),false);
  for(const broken of [detailBody.replace('To be paid online\n$22,501.68','To be paid online\n$0.00'),detailBody.replace('To be paid online\n$22,501.68','To be paid online\n$7,501.56'),
   detailBody.replace('Request n°1502428','Request n°1502429'),detailBody.replace('01 - 08 Jan','02 - 08 Jan'),
   detailBody.replace('\n'+label+'\n','\nPre-approved\n')]){
   await assert.rejects(collectSamBoat({page:paidPage({detailBody:broken,initialState:label,finalState:label}),
    fromDay:'2026-09-10',deadlineAt:Date.now()+3000}));
  }
 }
});

test('new exact deposit aliases retain current-detail and final-list cancellation priority',async()=>{
 for(const label of ['Deposit paid only','Validated/Deposit paid']){
  const body=paidPhoneBody.replace('\nDeposit paid\n','\n'+label+'\n');
  for(const page of [paidPage({initialState:label,finalState:label,detailBody:body.replace('\n'+label+'\n','\nCancelled\n').replace('To be paid online\n$22,501.68\n','')}),
   paidPage({initialState:label,finalState:'Cancelled',finalAmount:null,detailBody:body})]){
   const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
   const order=result.orders.find(order=>order.booking_id==='1502428');
   assert.equal(order.status,'cancelled');assert.equal(order.amount,undefined);assert.equal(result.complete,true);
  }
 }
});

test('a previously pre-approved request becomes active only after later Paid and fresh matching payment detail',async()=>{
 const pendingPage=paidPage({initialState:'Pre-approved',finalState:'Pre-approved'});
 const pending=await collectSamBoat({page:pendingPage,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
 assert.equal(pending.orders.find(order=>order.booking_id==='1502428').status,'pending');assert.deepEqual(pendingPage.detailWaits,[]);
 assert.ok(pendingPage.visits.every(url=>new URL(url).pathname==='/private/reservations'));
 const awaitingPayment=paidPhoneBody.replace('\nDeposit paid\n',"\nRequest pre-approved.\nWaiting for the renter's payment.\n");
 const staleDetail=paidPage({initialState:'Paid',finalState:'Paid',detailBody:awaitingPayment});
 await assert.rejects(collectSamBoat({page:staleDetail,fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),{code:'BOOKING_STATUS'});
 assert.deepEqual(staleDetail.detailWaits,[true]);
 const detailBody=paidPhoneBody.replace('\nDeposit paid\n','\nFixture renter has paid the rent.\nThe reservation is confirmed.\n');
 const paid=paidPage({initialState:'Paid',finalState:'Paid',detailBody});
 const confirmed=await collectSamBoat({page:paid,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
 assert.equal(confirmed.orders.find(order=>order.booking_id==='1502428').status,'paid');
 assert.equal(confirmed.orders.find(order=>order.booking_id==='1502428').amount,'$22,501.68');assert.deepEqual(paid.detailWaits,[true]);
 assert.equal(confirmed.complete,true);assert.equal(confirmed.pagination.total_pages,4);
});

test('Paid list state needs a fresh matching detail confirmation and payment amount before it can become active',async()=>{
  const detailBody=paidPhoneBody.replace('\nDeposit paid\n','\nFixture renter has paid the rent.\nThe reservation is confirmed.\n');
  const page=paidPage({detailBody,initialState:'Paid',finalState:'Paid'}),diagnostics=[];
  const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000,reportDiagnostic:value=>diagnostics.push(value)});
  const record=result.orders.find(order=>order.booking_id==='1502428');
  assert.equal(record.status,'paid');assert.equal(record.amount,'$22,501.68');assert.deepEqual(page.detailWaits,[true]);
  assert.ok(diagnostics.some(value=>value.stage==='detail_parse'));
  const missing=detailBody.replace('To be paid online\n$22,501.68\n','');
  assert.equal(vm.runInNewContext('('+page.detailPredicates[0].toString()+')(...args)',{args:page.detailPredicateArgs[0],document:{readyState:'complete',body:{innerText:missing}}}),false);
  for(const [status,reason,code] of [[401,'http_401','auth_required'],[403,'http_status','fetch_failed']]){
    const failedPage=paidPage({detailBody,initialState:'Paid',finalState:'Paid'}),goto=failedPage.goto,events=[];
    failedPage.goto=async url=>url.includes('/private/reservation/')?{status:()=>status,url:()=>url,headers:()=>({'content-type':'text/html'})}:goto(url);
    await assert.rejects(collectSamBoat({page:failedPage,fromDay:'2026-09-10',deadlineAt:Date.now()+3000,reportDiagnostic:value=>events.push(value)}),{code});
    assert.deepEqual(events.at(-1),{stage:'detail_navigation',reason});assert.equal(failedPage.detailWaits.length,0);
  }
});

test('a full restart after final-list change verifies every paid detail again',async()=>{
  const page=paidPage(),evaluate=page.evaluate;
  page.evaluate=async(fn,args)=>{
    const result=await evaluate(fn,args);
    if(result&&typeof result==='object'&&new URL(result.url).searchParams.get('archived')==='2'&&page.visits.length>=9)
      panel(result).cards=[card('299','archived',2,'Cancelled')];
    return result;
  };
  const result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+60000});
  assert.equal(page.visits.length,18);assert.deepEqual(page.detailWaits,[true,true]);
  assert.equal(page.visits.filter(url=>url==='https://www.samboat.com/private/reservation/1502428').length,2);
  assert.equal(result.orders.find(order=>order.booking_id==='1502428').status,'deposit_paid');
  assert.ok(result.orders.some(order=>order.booking_id==='299'));assert.ok(!result.orders.some(order=>order.booking_id==='201'));
});
test('collector publishes an explicit cancelled detail despite old paid lists and no amount label',async()=>{
  const detailBody=paidPhoneBody.replace('\nDeposit paid\n','\nCancelled\n').replace('To be paid online\n$22,501.68\n','');
  const page=paidPage({detailBody}),result=await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  const order=result.orders.find(r=>r.booking_id==='1502428');assert.equal(order.status,'cancelled');assert.equal(order.amount,undefined);
  assert.deepEqual(page.detailWaits,[true]);assert.equal(result.complete,true);assert.equal(result.pagination.total_pages,4);
});

test('checkout-day paid orders and cancellation changes remain in the complete collection scope',async()=>{
 for(const [state,want] of [['Deposit paid','deposit_paid'],['Cancelled','cancelled']]){
  const detailBody=paidPhoneBody.replace('\nDeposit paid\n','\n'+state+'\n');
  const page=paidPage({detailBody}),result=await collectSamBoat({page,fromDay:'2027-01-08',deadlineAt:Date.now()+3000});
  assert.equal(result.orders.find(order=>order.booking_id==='1502428')?.status,want);
  assert.deepEqual(page.detailWaits,[true]);
 }
 const page=paidPage(),result=await collectSamBoat({page,fromDay:'2027-01-09',deadlineAt:Date.now()+3000});
 assert.equal(result.orders.find(order=>order.booking_id==='1502428'),undefined);
 assert.deepEqual(page.detailWaits,[]);
});
test('collector applies the final full-list cancellation after an earlier paid detail',async()=>{
  const result=await collectSamBoat({page:paidPage({finalState:'Cancelled',finalAmount:null}),fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  const order=result.orders.find(r=>r.booking_id==='1502428');assert.equal(order.status,'cancelled');assert.equal(order.amount,undefined);
});
test('collector rejects a cancelled detail for changed dates or a wrong request identity',async()=>{
  const cancelled=paidPhoneBody.replace('\nDeposit paid\n','\nCancelled\n');
  for(const body of [cancelled.replace('01 - 08 Jan','02 - 08 Jan'),cancelled.replace('Request n°1502428','Request n°1502429')]){
    await assert.rejects(collectSamBoat({page:paidPage({detailBody:body}),fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),e=>e.code==='incomplete_pages'||e.name==='OrderParseError');
  }
});
test('collector retains failure protection for requested cancellation and changes accompanying final cancellation',async()=>{
  for(const state of ['Cancellation request','Pending modification'])await assert.rejects(collectSamBoat({page:paidPage({finalState:state}),fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),e=>e.name==='OrderParseError');
  await assert.rejects(collectSamBoat({page:paidPage({finalState:'Cancelled',finalAmount:null,finalMutate:c=>{c.text=c.text.replace('01 - 08 Jan','02 - 08 Jan');}}),fromDay:'2026-09-10',deadlineAt:Date.now()+3000}),e=>e.code==='incomplete_pages');
});

test('detail readiness waits for staged header, current badge and paid financial value without using navigation as payment',async()=>{
  const page=paidPage();await collectSamBoat({page,fromDay:'2026-09-10',deadlineAt:Date.now()+3000});
  assert.equal(page.detailPredicates.length,1);
  const predicate=page.detailPredicates[0].toString();
  const ready=(body,readyState='complete')=>vm.runInNewContext('('+predicate+')(...args)',{args:page.detailPredicateArgs[0],document:{readyState,body:{innerText:body}}});
  const withoutPrice=paidPhoneBody.replace('To be paid online\n$22,501.68\n','');
  assert.equal(ready(paidPhoneBody,'interactive'),false);
  assert.equal(ready('Request n°1502428'),false);
  assert.equal(ready('Request n°1502428\nRequest\nPre-approve\nPaid\nIn progress\nCompleted'),false);
  assert.equal(ready(withoutPrice),false);
  assert.equal(ready(paidPhoneBody.replace('To be paid online\n$22,501.68','To be paid online\nLoading…')),false);
  assert.equal(ready(paidPhoneBody),true);
  assert.equal(ready(withoutPrice+'\nTo be paid online\n$22,501.68'),false,'chat financial text cannot complete the current booking card');
  assert.equal(ready(paidPhoneBody.replace('Request n°1502428','Request n°1502428\nRequest n°1502429')),false);
  assert.equal(ready(paidPhoneBody.replace('Deposit paid\n','Request\nPre-approve\nPaid\nIn progress\nCompleted\nDeposit paid\n')),false);
  for(const badge of ['Cancelled','Canceled','Completed','Refused','Cancellation request','Pending modification','Some new status']){
    assert.equal(ready(withoutPrice.replace('\nDeposit paid\n','\n'+badge+'\n')),true,badge+' is ready for the strict parser, not assumed paid');
  }
});
