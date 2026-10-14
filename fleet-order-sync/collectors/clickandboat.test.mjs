import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {assertSameManifest, clickAndBoatDetailReady, collectClickAndBoat, inspectClickAndBoatDocument, LIST_URL, manifest, pageUrl, paginationPlan, validateHtmlManifest} from './clickandboat.mjs';

const row = (id = '1000002', extra = {}) => ({booking_id: id,
  url: `https://www.clickandboat.com/uk/booking/${id}/detail`, status: 'Accepted', visibleStates: ['Accepted'],
  boat_text: 'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5',
  date_text: 'from 7 to 13 November 2026 (14:00 / 10:00)', amount: '€12,705', visible: true, ...extra});
const tabs = [{text: 'In progress', filter: 'in_progress', active: true, visible: true}, {text: 'History', filter: 'history', active: false, visible: true}];
const documentData = (rows, extra = {}) => ({valid: true, account_verified:true, tabs: structuredClone(tabs), rows,
  groups: tabs.map(tab => ({name: tab.text, ids: rows.filter(row => (row.group || 'In progress') === tab.text).map(row => row.booking_id).sort()})),
  orderAnchors: [...new Set(rows.map(r => r.url))].sort(), paginations: [{items: [], structureSupported: true, empty: true}], unknownPagination: false, empty: false, ...extra});
const paginator = (current = 1, count = 2) => ({unknownPagination: false, paginations: [{structureSupported: true, empty: false, items: [
  {text: 'Previous', prev: true, next: false, disabled: current === 1},
  ...Array.from({length: count}, (_, i) => ({text: String(i + 1), active: i + 1 === current, next: false, prev: false})),
  {text: 'Next', next: true, prev: false, disabled: current === count},
]}]});

test('HTML manifest requires every server order anchor to have exactly one complete row', () => {
  validateHtmlManifest(documentData([row()]));
  for (const data of [documentData([row(), row()]), documentData([row()], {orderAnchors: [row().url, row('2').url]}),
    documentData([row()], {orderAnchors: []}), documentData([row('3', {status: null})])]) {
    assert.throws(() => validateHtmlManifest(data));
  }
});
test('server empty and schema/account must be explicit, not inferred from zero rows', () => {
  assert.throws(() => validateHtmlManifest(documentData([])), {code: 'incomplete_pages'});
  validateHtmlManifest(documentData([], {empty: true}));
  assert.throws(() => validateHtmlManifest(documentData([row()], {valid: false})), {code: 'auth_required'});
  assert.throws(() => validateHtmlManifest(documentData([row()], {tabs: tabs.slice(0, 1)})), {code: 'schema_changed'});
});

test('missing or unverified account cannot certify even an explicit empty Click&Boat list',()=>{
 for(const account_verified of [undefined,false,'true',1]){
  for(const rows of [[],[row()]])assert.throws(()=>validateHtmlManifest(documentData(rows,{account_verified,empty:!rows.length})),{code:'auth_required'});
 }
});

test('raw and hydrated profile h1 must prove the exact observed Click&Boat account', {timeout:20000},async t=>{
 const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&existsSync(p));
 if(!executablePath){t.skip('An installed local Chromium is needed for this DOM test');return;}
 const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
 const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
 try{
  const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
  for(const heading of ['<h1>Demo Owner</h1>','<h1>Another account</h1>','',
   '<p>Demo Owner</p>','<h1>Demo Owner</h1><h1>Demo Owner</h1>']){
   const html='<html><body>'+heading+'<h2>All your bookings</h2><div id="filter-state">'+
    '<button data-filter-class="in_progress" class="active">In progress</button><button data-filter-class="history">History</button></div>'+
    '<div id="bookings">No bookings<div class="js-inProgress"></div><div class="js-paginationHistory"></div></div><div class="pagination"></div></body></html>';
   await page.setContent(html);
   const raw=await page.evaluate(inspectClickAndBoatDocument,{html}),live=await page.evaluate(inspectClickAndBoatDocument,{});
   for(const result of [raw,live]){
    assert.equal(result.account_verified,heading==='<h1>Demo Owner</h1>');
    if(result.account_verified)validateHtmlManifest(result);else assert.throws(()=>validateHtmlManifest(result),{code:'auth_required'});
   }
  }
 }finally{await browser.close();}
});
test('identity/state/boat/dates/amount changes and missing rows all reject recheck', () => {
  const original = [row(), row('2')];
  assertSameManifest(original, original.slice().reverse());
  for (const delta of [{booking_id: '3'}, {status: 'Cancelled'}, {boat_text: 'Tidewyn Discovery 2'},
    {date_text: 'from 8 to 13 November 2026'}, {amount: '€1'}, {url: 'https://evil.test/detail'}]) {
    assert.throws(() => assertSameManifest(original, [row('1000002', delta), row('2')]));
  }
  assert.throws(() => assertSameManifest(original, [row()]), {code: 'incomplete_pages'});
  assert.throws(() => manifest([row('')]), {code: 'incomplete_pages'});
});
test('observed raw/live 26 identities are equal; evidence has empty one-page paginator', () => {
  const evidence = JSON.parse(readFileSync(new URL('../evidence/inventory-structure-20260910.json', import.meta.url))).clickandboat;
  assert.equal(evidence.raw.orderLinks.length, 26);
  assert.deepEqual([...evidence.raw.orderLinks].sort(), [...evidence.live.orderLinks].sort());
  assert.deepEqual(evidence.raw.tabs.map(tab => tab.attrs['data-filter-class']), ['in_progress', 'history']);
  assert.deepEqual(evidence.raw.groups.map(group => group.rows), [8, 18]);
  assert.equal(evidence.raw.pagination.length, 1);
  assert.deepEqual(evidence.raw.pagination[0].items, []);
});
test('known paginator supports only complete contiguous witnessed page boundaries', () => {
  assert.deepEqual(paginationPlan(paginator(1)), {pages: [1, 2], next: 2});
  assert.deepEqual(paginationPlan(paginator(2), 2), {pages: [1, 2], next: null});
  assert.throws(() => paginationPlan(paginator(1), 2), {code: 'incomplete_pages'});
  const gap = paginator(); gap.paginations[0].items[2].text = '3';
  assert.throws(() => paginationPlan(gap), {code: 'incomplete_pages'});
  const ellipsis = paginator(); ellipsis.paginations[0].items.splice(2, 0, {text: '…'});
  assert.throws(() => paginationPlan(ellipsis), {code: 'incomplete_pages'});
  assert.throws(() => paginationPlan({...paginator(), unknownPagination: true}), {code: 'incomplete_pages'});
  assert.throws(() => paginationPlan({unknownPagination: false, paginations: [{items: []}]}, 2), {code: 'incomplete_pages'});
});
test('conflicting terminal next or multiple paginators cannot silently truncate pages', () => {
  const next = paginator(2); next.paginations[0].items.at(-1).disabled = false;
  assert.throws(() => paginationPlan(next, 2), {code: 'incomplete_pages'});
  const conflict = paginator(); conflict.paginations.push(paginator(2).paginations[0]);
  assert.throws(() => paginationPlan(conflict), {code: 'incomplete_pages'});
});
test('partial HTML missing a history group or pagination shell cannot certify the remaining orders', () => {
  const complete = documentData([row()]);
  for (const groups of [complete.groups.slice(0, 1), [], [complete.groups[0], complete.groups[0]],
    [{name: 'In progress', ids: []}, {name: 'History', ids: []}]]) {
    assert.throws(() => validateHtmlManifest({...complete, groups}), {code: 'incomplete_pages'});
  }
  assert.throws(() => validateHtmlManifest({...complete, paginations: []}), {code: 'incomplete_pages'});
  assert.throws(() => paginationPlan({unknownPagination: false, paginations: []}), {code: 'incomplete_pages'});
  validateHtmlManifest(complete); // Explicitly present empty History is allowed.
});
test('zero recognized pagination items only passes for an actually empty supported container', () => {
  const data = documentData([row()]);
  assert.deepEqual(paginationPlan(data), {pages: [1], next: null});
  for (const pagination of [{items: [], structureSupported: false, empty: false},
    {items: [], structureSupported: true, empty: false}, {items: [], empty: true}]) {
    assert.throws(() => paginationPlan({...data, paginations: [pagination]}), {code: 'incomplete_pages'});
  }
});
test('page URLs follow witnessed page and existing limit; never navigate another host', () => {
  assert.equal(pageUrl(2), LIST_URL + '?page=2&limit=null');
  assert.equal(pageUrl(2, LIST_URL + '?limit=20'), LIST_URL + '?page=2&limit=20');
  for (const value of ['https://evil.test/uk/account/bookings', LIST_URL + '?unobserved=500', LIST_URL + '#x']) {
    assert.throws(() => pageUrl(2, value), {code: 'schema_changed'});
  }
  assert.throws(() => pageUrl(51), {code: 'schema_changed'});
});

const manualBooking = extra => row('1000000', {group: 'History', visibleStates: ['Completed'],
  boat_text: 'Catamaran Seacat Seacat 40 12.00mTidewyn Discovery 2',
  date_text: 'from 14 to 21 March 2026 (14:00 / 10:00)', amount: '€4,200', ...extra});
const manualBody = (state = 'ACCEPTED', extra = {}) => detailBody(state, {id: '1000000', start: '14/03/2026', end: '21/03/2026', amount: '€4,200', ...extra});
class FakePage {
  constructor({documents, details, paid = 200, partial = false, staleTab = false, paymentError = false, paymentPending = false} = {}) {
    // Legacy inventory tests also include the one separately monitored order.
    // Place it only on history page 1 so multi-page completeness stays meaningful.
    this.documents = documents.map(doc => {
      if (doc.rows.some(row => row.booking_id === '1000000') ||
          doc.paginations?.[0]?.items?.some(item => item.active && Number(item.text) !== 1)) return doc;
      return {...doc, rows: [...doc.rows, manualBooking()],
        groups: doc.groups.map(group => group.name === 'History' ? {...group, ids: [...group.ids, '1000000'].sort()} : group),
        orderAnchors: [...doc.orderAnchors, row('1000000').url].sort()};
    }); this.details = details; this.paid = paid; this.partial = partial; this.staleTab = staleTab;
    this.paymentError = paymentError; this.paymentPending = paymentPending; this.detailReads = 0;
    this.documentIndex = -1; this.events = []; this.currentUrl = LIST_URL; this.active = 'In progress';
  }
  async setCacheEnabled(enabled) { this.events.push(['cache', enabled]); }
  async goto(url) {
    this.currentUrl = url; this.events.push(['goto', url]);
    if (new URL(url).pathname === '/uk/account/bookings') {
      this.documentIndex++; this.active = 'In progress';
      this.current = structuredClone(this.documents[Math.min(this.documentIndex, this.documents.length - 1)]);
      return {status: () => 200, url: () => url, headers: () => ({'content-type': 'text/html; charset=utf-8'}), buffer: async () => Buffer.from('server HTML')};
    }
    return {status: () => 200, headers: () => ({'content-type':'text/html; charset=utf-8'})};
  }
  async $$(selector) {
    assert.equal(selector, '#filter-state button');
    return tabs.map(tab => ({evaluate: async (_fn, name) => tab.text === name,
      click: async () => { if (!this.staleTab) this.active = tab.text; this.events.push(['click', tab.text]); }}));
  }
  async waitForFunction(_fn, _options, tab) {
    assert.equal(_options.polling, 250);
    this.events.push(['wait', tab?.text || 'detail']);
    if (tab && this.active !== tab.text) { const error = new Error('tab not selected'); error.code = 'timeout'; throw error; }
    if (!tab && !runInNewContext(`(${_fn.toString()})()`, {document: {body: {innerText: this.detailText()}}})) {
      const error = new Error('detail not ready'); error.code = 'timeout'; throw error;
    }
  }
  async evaluate(fn, input) {
    if (fn.name === 'inspectClickAndBoatDocument') {
      const result = structuredClone(this.current);
      if (input?.html) return result;
      result.tabs = result.tabs.map(tab => ({...tab, active: tab.text === this.active}));
      result.rows = result.rows.map(row => ({...row, visible: row.group === this.active}));
      if (this.partial) result.rows.pop();
      return result;
    }
    const body = this.detailText(); if (!this.currentUrl.endsWith('/1000000/detail')) this.detailReads++; return body;
  }
  detailText() { return this.currentUrl.endsWith('/1000000/detail') ? manualBody() : Array.isArray(this.details) ? this.details[Math.min(this.detailReads, this.details.length - 1)] : this.details; }
  url() { return this.currentUrl; }
  async waitForResponse(predicate) {
    if (this.paymentError) throw new Error('prices unavailable');
    if (this.paymentPending) return new Promise(() => {});
    const response = {url: () => 'https://www.clickandboat.com/api/v6/booking/prices/1250578?_locale=en-GB',
      request: () => ({method: () => 'GET'}), status: () => 200, headers: () => ({'content-type': 'application/json'}),
      buffer: async () => Buffer.from(JSON.stringify({tenantAlreadyPaidAmount: this.paid, tenantBalancePaymentAmount: 100, tenantTotalOnlineAmount: 300}))};
    assert.equal(predicate(response), true);
    return response;
  }
}
const cancelledRows = [row('1000002', {status: 'Cancelled', visibleStates: ['Cancelled'], group: 'In progress'}),
  row('2', {status: 'Cancelled', visibleStates: ['Cancelled'], group: 'History'})];
const context = page => ({page, fromDay: '2026-09-10', deadlineAt: Date.now() + 60000, signal: new AbortController().signal});

test('collector rejects wrong account initially, after hydration, and on final full reread',async()=>{
 for(const stage of ['first','live','final']){
  const good=documentData(cancelledRows),bad=documentData(cancelledRows,{account_verified:false});
  const page=new FakePage({documents:stage==='first'?[bad]:stage==='final'?[good,bad]:[good]});
  if(stage==='live'){
   const evaluate=page.evaluate.bind(page);
   page.evaluate=async(fn,input)=>{const result=await evaluate(fn,input);if(fn===inspectClickAndBoatDocument&&!input?.html)result.account_verified=false;return result;};
  }
  await assert.rejects(collectClickAndBoat(context(page)),{code:'auth_required'});
  assert.equal(page.events.filter(([event])=>event==='goto').length,stage==='final'?3:1);
 }
});

test('invalid Click&Boat deadlines fail before browser navigation instead of disabling time limits', async () => {
  for (const deadlineAt of [undefined, NaN, Infinity, -Infinity]) {
    const page = new FakePage({documents: [documentData(cancelledRows)]});
    await assert.rejects(collectClickAndBoat({...context(page), deadlineAt}), {code: 'timeout'});
    assert.deepEqual(page.events, []);
  }
});
test('collector waits selected tabs, covers full server set, re-fetches, and preserves cancelled records', async () => {
  const page = new FakePage({documents: [documentData(cancelledRows)]});
  const result = await collectClickAndBoat(context(page));
  assert.equal(result.orders.length, 2); assert.ok(result.orders.every(row => row.status === 'cancelled'));
  assert.equal(result.pagination.listed_count, 3); assert.equal(result.pagination.total_pages, 1);
  assert.equal(page.events.filter(event => event[0] === 'goto').length, 3);
  assert.deepEqual(page.events[0], ['cache', false]);
  assert.equal(page.events.filter(event => event[0] === 'wait').length, 5);
});
test('partial rendering or tab switch not completed rejects the entire snapshot', async () => {
  for (const extra of [{partial: true}, {staleTab: true}]) {
    await assert.rejects(collectClickAndBoat(context(new FakePage({documents: [documentData(cancelledRows)], ...extra}))));
  }
});
test('same count but a changed server identity or reactivation on recheck rejects', async () => {
  for (const change of [row('3', {status: 'Cancelled', visibleStates: ['Cancelled'], group: 'History'}),
    row('2', {status: 'Pending', visibleStates: ['Pending'], group: 'History'})]) {
    const page = new FakePage({documents: [documentData(cancelledRows), documentData([cancelledRows[0], change])]});
    await assert.rejects(collectClickAndBoat(context(page)), {code: 'incomplete_pages'});
  }
});
test('known two-page history is traversed and fully rechecked without duplicating current orders', async () => {
  const first = documentData(cancelledRows, paginator(1));
  const second = documentData([cancelledRows[0], {...cancelledRows[1], booking_id: '3', url: row('3').url}], paginator(2));
  const page = new FakePage({documents: [first, second, first, second]});
  const result = await collectClickAndBoat(context(page));
  assert.equal(result.orders.length, 3);
  assert.equal(result.pagination.listed_count, 4);
  assert.deepEqual(result.pagination.pages_read, [1, 2]);
  assert.deepEqual(page.events.filter(event => event[0] === 'goto').map(event => event[1]), [LIST_URL, pageUrl(2), row('1000000').url, LIST_URL, pageUrl(2)]);
});
test('same historical ID on separate pages rejects instead of silently deduplicating it', async () => {
  const first = documentData(cancelledRows, paginator(1));
  const second = documentData(cancelledRows, paginator(2));
  await assert.rejects(collectClickAndBoat(context(new FakePage({documents: [first, second]}))), {code: 'incomplete_pages'});
});
test('history page count changes between requests rejects even when existing rows look complete', async () => {
  const first = documentData(cancelledRows, paginator(1));
  const second = documentData([cancelledRows[0], {...cancelledRows[1], booking_id: '3', url: row('3').url}], paginator(2, 3));
  await assert.rejects(collectClickAndBoat(context(new FakePage({documents: [first, second]}))), {code: 'incomplete_pages'});
});
test('accepted actual positive payment remains required; verified zero is inactive', async () => {
  const details = readFileSync(new URL('../evidence/cb-1250578-body.txt', import.meta.url), 'utf8');
  const booking = row('1250578', {boat_text: 'Catamaran Seacat Seacat 40 12.00mTidewyn Discovery 2', amount: '€11,310', group: 'In progress'});
  for (const [paid, expected] of [[200, 'accepted'], [0, 'pending']]) {
    const page = new FakePage({documents: [documentData([booking])], details, paid});
    const result = await collectClickAndBoat(context(page));
    assert.equal(result.orders[0].status, expected);
    assert.equal(result.orders[0].customer_payment_verified, paid > 0);
  }
  const missing = new FakePage({documents: [documentData([booking])], details, paid: '200'});
  await assert.rejects(collectClickAndBoat(context(missing)), {code: 'schema_changed'});
});

// Synthetic state transitions exercise cancellation races; they are not claimed
// to be newly observed platform records or proof of an external API contract.
const acceptedBooking = () => row('1250578', {
  boat_text: 'Catamaran Seacat Seacat 40 12.00mTidewyn Discovery 2', amount: '€11,310', group: 'In progress',
});
const detailBody = (state = 'ACCEPTED', {id = '1250578', start = '07/11/2026', end = '13/11/2026', amount = '€11,310'} = {}) =>
  [`Booking N°${id}`, state, 'CHECK-IN', start, 'CHECK-OUT', end,
    ...(amount === null ? [] : ['Net amount (boat owner)', amount])].join('\n');
const hasPaymentMetadata = record => Object.keys(record).some(key => /^customer_/.test(key));

test('v15 Click&Boat network and HTML failures are not falsely reported as expired login',async()=>{
 for(const [status,type,expected] of [[401,'text/html','auth_required'],[403,'text/html','fetch_failed'],
   [429,'text/html','fetch_failed'],[503,'text/html','fetch_failed'],[200,'application/json','fetch_failed']]){
  const page=new FakePage({documents:[documentData([acceptedBooking()])],details:detailBody()}),go=page.goto.bind(page);
  page.goto=async url=>{const response=await go(url);return {...response,status:()=>status,headers:()=>({'content-type':type})};};
  await assert.rejects(collectClickAndBoat(context(page)),{code:expected});
 }
});

test('v15 non-success detail response cannot reuse matching Click&Boat HTML or positive payment evidence',async()=>{
 for(const [status,type,expected] of [[401,'text/html','auth_required'],[403,'text/html','fetch_failed'],
   [429,'text/html','fetch_failed'],[503,'text/html','fetch_failed'],[200,'application/json','fetch_failed']]){
  const page=new FakePage({documents:[documentData([acceptedBooking()])],details:detailBody()}),go=page.goto.bind(page);
  page.goto=async url=>{const response=await go(url);return url.includes('/booking/')?{...response,status:()=>status,headers:()=>({'content-type':type})}:response;};
  await assert.rejects(collectClickAndBoat(context(page)),{code:expected});
  assert.equal(page.detailReads,0);
 }
});

test('v15 Click&Boat prices HTTP failures retain their reason without suppressing a current cancellation',async()=>{
 for(const [status,expected] of [[401,'auth_required'],[403,'fetch_failed'],[429,'fetch_failed'],[503,'fetch_failed']]){
  for(const cancelled of [false,true]){
   const page=new FakePage({documents:[documentData([acceptedBooking()])],details:detailBody(cancelled?'CANCELLED':'ACCEPTED')});
   page.waitForResponse=async()=>({status:()=>status,url:()=> 'https://www.clickandboat.com/api/v6/booking/prices/1250578',headers:()=>({'content-type':'application/json'})});
   if(cancelled)assert.equal((await collectClickAndBoat(context(page))).orders[0].status,'cancelled');
   else await assert.rejects(collectClickAndBoat(context(page)),{code:expected});
  }
 }
});

test('checkout-day accepted payment and final cancellation still receive fresh detail verification',async()=>{
 for(const [state,want] of [['ACCEPTED','accepted'],['CANCELLED','cancelled']]){
  const page=new FakePage({documents:[documentData([acceptedBooking()])],details:detailBody(state,{amount:state==='ACCEPTED'?'€11,310':null}),paid:200});
  const result=await collectClickAndBoat({...context(page),fromDay:'2026-11-13'});
  const order=result.orders.find(order=>order.booking_id==='1250578');
  assert.equal(order?.status,want);
  assert.equal(order?.customer_payment_verified,state==='ACCEPTED'?true:undefined);
 }
 const page=new FakePage({documents:[documentData([acceptedBooking()])]});
 const result=await collectClickAndBoat({...context(page),fromDay:'2026-11-14'});
 assert.equal(result.orders.length,0);
});

test('detail readiness requires current identity/state and dates, but inactive states need no amount', () => {
  const ready = bodyText => runInNewContext(`(${clickAndBoatDetailReady.toString()})()`, {document: {body: {innerText: bodyText}}});
  assert.equal(ready(detailBody()), true);
  assert.equal(ready(detailBody('ACCEPTED', {amount: null})), false);
  for (const state of ['CANCELLED', 'CANCELED', 'REFUSED', 'PENDING', 'COMPLETED']) {
    assert.equal(ready(detailBody(state, {amount: null})), true);
  }
  for (const body of [detailBody('UNKNOWN'), detailBody() + '\nBooking N°2\nCANCELLED',
    detailBody().replace('CHECK-OUT', 'unrecognized date'), 'Cancellation policy\nCHECK-IN\nCHECK-OUT']) {
    assert.equal(ready(body), false);
  }
});

test('saved real detail fields become ready only after staged dates and net price finish rendering', () => {
  const ready = bodyText => runInNewContext(`(${clickAndBoatDetailReady.toString()})()`, {document: {body: {innerText: bodyText}}});
  // The completed body is saved platform evidence. Removing field values models
  // progressive rendering; it is not a claim of a newly observed live failure.
  const complete = readFileSync(new URL('../evidence/cb-1250578-body.txt', import.meta.url), 'utf8');
  assert.equal(ready(complete), true);
  for (const [label, pattern] of [
    ['CHECK-IN', /(CHECK-IN\r?\n)[^\r\n]+/],
    ['CHECK-OUT', /(CHECK-OUT\r?\n)[^\r\n]+/],
    ['Net amount (boat owner)', /(Net amount \(boat owner\)\r?\n)[^\r\n]+/],
  ]) {
    const pending = complete.replace(pattern, '$1');
    assert.notEqual(pending, complete, 'Real fixture must contain ' + label);
    assert.equal(ready(pending), false, label + ' must have a rendered value');
    assert.equal(ready(complete), true);
  }
  const cancelled = complete.replace(/(Booking N[°º]1250578\r?\n)Accepted/i, '$1Cancelled')
    .replace(/Net amount \(boat owner\)\r?\n[^\r\n]+\r?\n/, '');
  assert.equal(ready(cancelled), true, 'Final cancellation still needs no financial section');
  assert.equal(ready(cancelled.replace(/(CHECK-IN\r?\n)[^\r\n]+/, '$1')), false);
});

test('cancelled current detail overrides accepted list without money or any prices response', async () => {
  for (const extra of [{paymentError: true}, {paymentPending: true}, {paid: 200}]) {
    const page = new FakePage({documents: [documentData([acceptedBooking()])], details: detailBody('CANCELLED', {amount: null}), ...extra});
    const result = await collectClickAndBoat(context(page));
    assert.equal(result.orders[0].status, 'cancelled');
    assert.equal(hasPaymentMetadata(result.orders[0]), false);
    assert.equal('amount' in result.orders[0], false);
    assert.equal(page.detailReads, 1);
  }
});

test('current cancellation after payment wait wins even when prices are positive or unavailable', async () => {
  for (const extra of [{paid: 200}, {paymentError: true}]) {
    const page = new FakePage({documents: [documentData([acceptedBooking()])],
      details: [detailBody(), detailBody('CANCELLED', {amount: null})], ...extra});
    const result = await collectClickAndBoat(context(page));
    assert.equal(page.detailReads, 2);
    assert.equal(result.orders[0].status, 'cancelled');
    assert.equal(hasPaymentMetadata(result.orders[0]), false);
  }
});

test('unavailable prices cannot turn an unchanged accepted detail into a successful snapshot', async () => {
  const page = new FakePage({documents: [documentData([acceptedBooking()])], details: detailBody(), paymentError: true});
  await assert.rejects(collectClickAndBoat(context(page)), {code: 'fetch_failed'});
  assert.equal(page.detailReads, 2);
});

test('cancelled details must keep the same order identity and dates before and after payment', async () => {
  for (const delta of [{id: '2'}, {start: '08/11/2026'}, {end: '14/11/2026'}]) {
    for (const bodies of [[detailBody('CANCELLED', {...delta, amount: null})],
      [detailBody(), detailBody('CANCELLED', {...delta, amount: null})]]) {
      const page = new FakePage({documents: [documentData([acceptedBooking()])], details: bodies});
      await assert.rejects(collectClickAndBoat(context(page)));
    }
  }
});

test('last full list cancellation removes payment evidence including stale Accepted parent and missing amount', async () => {
  for (const state of ['Cancelled', 'Accepted']) {
    const booking = acceptedBooking();
    const cancelled = {...booking, status: state, visibleStates: ['Cancelled'], amount: '-', group: 'History'};
    const page = new FakePage({documents: [documentData([booking]), documentData([cancelled])], details: detailBody()});
    const result = await collectClickAndBoat(context(page));
    assert.equal(result.complete, true);
    assert.equal(result.orders[0].status, 'cancelled');
    assert.equal(result.orders[0].platform_status, 'Cancelled');
    assert.equal(hasPaymentMetadata(result.orders[0]), false);
    assert.equal('amount' in result.orders[0], false);
  }
});

test('final cancellation cannot excuse changed boat/date/identity or disappearance', async () => {
  const booking = acceptedBooking(), cancelled = {...booking, status: 'Cancelled', visibleStates: ['Cancelled'], amount: '-'};
  for (const rows of [[], [{...cancelled, date_text: 'from 8 to 13 November 2026 (14:00 / 10:00)'}],
    [{...cancelled, boat_text: 'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5'}],
    [{...cancelled, booking_id: '2', url: row('2').url}]]) {
    const page = new FakePage({documents: [documentData([booking]), documentData(rows, {empty: !rows.length})], details: detailBody()});
    await assert.rejects(collectClickAndBoat(context(page)), {code: 'incomplete_pages'});
  }
});

test('non-cancellation state or amount changes during final inventory remain rejected', async () => {
  const booking = acceptedBooking();
  for (const delta of [{status: 'Pending', visibleStates: ['Pending']}, {amount: '€4,000'},
    {visibleStates: ['Canceled', 'Cancelled']}]) {
    const page = new FakePage({documents: [documentData([booking]), documentData([{...booking, ...delta}])], details: detailBody()});
    await assert.rejects(collectClickAndBoat(context(page)));
  }
});

test('even cancelled historical orders cannot silently move between pages during full recheck', async () => {
  const first = documentData(cancelledRows, paginator(1));
  const third = {...cancelledRows[1], booking_id: '3', url: row('3').url};
  const second = documentData([cancelledRows[0], third], paginator(2));
  const changedFirst = documentData([cancelledRows[0], third], paginator(1));
  const changedSecond = documentData(cancelledRows, paginator(2));
  const page = new FakePage({documents: [first, second, changedFirst, changedSecond]});
  await assert.rejects(collectClickAndBoat(context(page)), {code: 'incomplete_pages'});
});
test('aborted collection cannot navigate or publish a snapshot', async () => {
  const page = new FakePage({documents: [documentData(cancelledRows)]}), data = context(page);
  data.signal = AbortSignal.abort();
  await assert.rejects(collectClickAndBoat(data), {code: 'timeout'});
  assert.equal(page.events.length, 0);
});

// Only synthetic transitions below; the baseline identity/dates are from the
// independent desktop audit, not invented payment evidence or platform edits.
function manualPage({before = [manualBooking()], after = before, body = manualBody()} = {}) {
  const page = new FakePage({documents: [documentData(before, {empty: before.length === 0})]});
  page.documents = [documentData(before, {empty: before.length === 0}), documentData(after, {empty: after.length === 0})];
  page.detailText = () => body;
  page.waitForResponse = async () => {throw new Error('Historical observation must not request payment evidence');};
  return page;
}

test('authorized historical reschedule produces only strict platform observations without current orders or payment fields', async () => {
  const audit = JSON.parse(readFileSync(new URL('../desktop-independent-audit-20260910/clickandboat-history-details.json', import.meta.url)));
  const observed = audit.observations.find(record => record.booking_id === '1000000');
  assert.equal(observed.start, '2026-03-14'); assert.equal(observed.end, '2026-03-21'); assert.equal(observed.detail_status, 'ACCEPTED');
  const page = manualPage(), result = await collectClickAndBoat(context(page));
  assert.equal(result.expected_count, 0); assert.deepEqual(result.orders, []); assert.equal(result.pagination.listed_count, 1);
  assert.equal(result.manual_order_observations.length, 1);
  const observation = result.manual_order_observations[0];
  assert.deepEqual(Object.keys(observation).sort(), ['booking_id', 'boataround_slug', 'platform_status', 'start', 'end', 'checked_at', 'detail_url'].sort());
  assert.deepEqual({...observation, checked_at: null}, {booking_id: '1000000', boataround_slug: 'seacat-open-40-tidewyn-discovery-2',
    platform_status: 'ACCEPTED', start: observed.start, end: observed.end, checked_at: null, detail_url: row('1000000').url});
  assert.ok(Number.isFinite(Date.parse(observation.checked_at))); assert.ok(observation.checked_at <= result.checked_at);
  assert.deepEqual(page.events.filter(event => event[0] === 'goto').map(event => event[1]), [LIST_URL, row('1000000').url, LIST_URL]);
  assert.ok(!JSON.stringify(result).includes('2027-03-06')); assert.ok(!JSON.stringify(observation).includes('4200'));
});

test('historical Completed and other known inactive detail states remain explicit observations rather than cancellation or paid proof', async () => {
  for (const state of ['COMPLETED', 'PENDING', 'REFUSED', 'AWAITING-WEATHER']) {
    const result = await collectClickAndBoat(context(manualPage({body: manualBody(state, {amount: null})})));
    assert.equal(result.manual_order_observations[0].platform_status, state);
    assert.deepEqual(result.orders, []);
  }
});

test('historical manual order cancellation in detail or initial list wins without waiting for financial sections', async () => {
  for (const state of ['CANCELLED', 'CANCELED']) {
    const result = await collectClickAndBoat(context(manualPage({body: manualBody(state, {amount: null})})));
    assert.equal(result.manual_order_observations[0].platform_status, state);
    assert.equal(result.expected_count, 0);
  }
  const initial = manualBooking({status: 'Cancelled', visibleStates: ['Cancelled'], amount: '-'});
  const result = await collectClickAndBoat(context(manualPage({before: [initial]})));
  assert.equal(result.manual_order_observations[0].platform_status, 'Cancelled');
});

test('last full list can cancel the separately observed historical manual order', async () => {
  for (const status of ['Accepted', 'Cancelled']) {
    const after = manualBooking({status, visibleStates: ['Cancelled'], amount: '-'});
    const result = await collectClickAndBoat(context(manualPage({after: [after]})));
    assert.equal(result.manual_order_observations[0].platform_status, 'Cancelled');
    assert.deepEqual(result.orders, []);
  }
});

test('stable actual platform boat and date changes are reported without writing the user override into source evidence', async () => {
  const changed = manualBooking({boat_text: 'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5',
    date_text: 'from 15 to 22 March 2026 (14:00 / 10:00)'});
  const result = await collectClickAndBoat(context(manualPage({before: [changed], body: manualBody('COMPLETED', {start: '15/03/2026', end: '22/03/2026', amount: null})})));
  const observation = result.manual_order_observations[0];
  assert.equal(observation.boataround_slug, 'grandcat-55-tidewyn-discovery-5');
  assert.equal(observation.start, '2026-03-15'); assert.equal(observation.end, '2026-03-22');
  assert.equal(observation.platform_status, 'COMPLETED'); assert.equal(result.orders.length, 0);
});

test('manual observation cannot certify absent, unreadable, ambiguously loaded or inconsistent historical detail', async () => {
  await assert.rejects(collectClickAndBoat(context(manualPage({before: []}))), {code: 'incomplete_pages'});
  for (const body of [manualBody('ACCEPTED', {amount: null}), manualBody('UNKNOWN'),
    manualBody('CANCELLED', {id: '1234322', amount: null}), manualBody('CANCELLED', {start: '15/03/2026', amount: null})]) {
    await assert.rejects(collectClickAndBoat(context(manualPage({body}))));
  }
  const page = manualPage(), navigate = page.goto.bind(page);
  page.goto = async url => {if (url.endsWith('/1000000/detail')) throw new Error('offline'); return navigate(url);};
  await assert.rejects(collectClickAndBoat(context(page)), /offline/);
});

test('manual cancellation does not excuse disappearance or boat/date changes during the final inventory', async () => {
  const cancelled = manualBooking({status: 'Cancelled', visibleStates: ['Cancelled'], amount: '-'});
  for (const after of [[], [{...cancelled, date_text: 'from 15 to 22 March 2026 (14:00 / 10:00)'}],
    [{...cancelled, boat_text: 'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5'}]]) {
    await assert.rejects(collectClickAndBoat(context(manualPage({after}))), {code: 'incomplete_pages'});
  }
});

test('separately observed historical order may be found on a later fully verified history page', async () => {
  const current = cancelledRows[0], first = documentData([current], paginator(1)),
    second = documentData([current, manualBooking()], paginator(2));
  const page = manualPage(); page.documents = [first, second, first, second];
  const result = await collectClickAndBoat(context(page));
  assert.deepEqual(result.pagination.pages_read, [1, 2]); assert.equal(result.pagination.listed_count, 2);
  assert.equal(result.expected_count, 1); assert.equal(result.orders[0].booking_id, current.booking_id);
  assert.equal(result.manual_order_observations[0].booking_id, '1000000');
});
