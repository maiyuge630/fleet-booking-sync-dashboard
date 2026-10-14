import {FLEET, samBoatIdentity, parseSamBoatListCard, parseSamBoatDetail, SAMBOAT_DEPOSIT_PAID_LABELS, isAccessChallenge} from '../parsers.mjs';

const BASE = 'https://www.samboat.com/private/reservations';
const TABS = Object.freeze(['ongoing', 'confirmed', 'archived']);
const LABELS = Object.freeze({ongoing:'Requests', confirmed:'Confirmed', archived:'Archived'});
const DOCUMENT_LABELS = Object.freeze({'new-message':'Unread', ...LABELS});
const MAX_PAGES = 50;
function fail(code, message, reason) {
  const error = new Error(message || code); error.code = code;
  if (reason) error.diagnostic_reason = reason;
  throw error;
}
const DIAGNOSTIC_CODES = new Set(['timeout','auth_required','fetch_failed','schema_changed','incomplete_pages','challenge_required']);
const DIAGNOSTIC_REASONS = new Set(['login_redirect','http_401','http_status','unexpected_content_type',
  'tab_controls_changed','unknown_list_control','account_unverified']);
async function atStage(context, stage, operation) {
  const report = async reason => { try { await context.reportDiagnostic?.({stage,reason}); } catch {} };
  await report('progress');
  try { return await operation(); }
  catch (error) {
    if (!error.diagnostic_stage) {
      error.diagnostic_stage = stage;
      await report(DIAGNOSTIC_REASONS.has(error.diagnostic_reason) ? error.diagnostic_reason : (DIAGNOSTIC_CODES.has(error.code) ? error.code :
        /^(?:TimeoutError|AbortError)$/.test(error.name) ? 'timeout' : error.name === 'OrderParseError' ? 'schema_changed' : 'fetch_failed'));
    }
    throw error;
  }
}

// A login redirect is distinct from a changed list schema. A generic 403 may
// instead be a platform challenge, so it must not request password recovery.
export function validateSamBoatResponse(response) {
  if (!response) fail('fetch_failed', 'SamBoat navigation returned no document', 'http_status');
  let location; try { location = new URL(response.url()); } catch { fail('fetch_failed', 'SamBoat response URL is invalid'); }
  if (location.origin !== 'https://www.samboat.com' || location.username || location.password)
    fail('schema_changed', 'SamBoat navigation left its expected origin');
  if (/^\/(?:[a-z]{2}\/)?login\/?$/.test(location.pathname))
    fail('auth_required', 'SamBoat redirected to its login page', 'login_redirect');
  if (isAccessChallenge(response)) fail('challenge_required', 'SamBoat requires a manual access check');
  if (response.status() === 401) fail('auth_required', 'SamBoat session requires login', 'http_401');
  if (response.status() !== 200) fail('fetch_failed', 'SamBoat document HTTP status is not successful', 'http_status');
  if (!/^text\/html(?:;|$)/i.test(response.headers()['content-type'] || ''))
    fail('fetch_failed', 'SamBoat response is not an HTML document', 'unexpected_content_type');
  // Expired private sessions also redirect to the public homepage, where the
  // site opens its sign-in modal after hydration. This is not a list schema.
  if (location.pathname === '/')
    fail('auth_required', 'SamBoat redirected to its homepage login modal', 'login_redirect');
  return location.href;
}
function check(context) {
  if (context.signal?.aborted || !Number.isFinite(context.deadlineAt) || Date.now() >= context.deadlineAt)
    fail('timeout', 'SamBoat 同步已到截止时间，保留上次完整订单');
}
async function bounded(promise, context, maximum = 18000) {
  check(context);
  let timer, abort;
  const expiry = new Promise((_, reject) => {
    abort = () => { const error = new Error('SamBoat operation timed out'); error.code = 'timeout'; reject(error); };
    timer = setTimeout(abort, Math.max(1, Math.min(maximum, context.deadlineAt - Date.now())));
    context.signal?.addEventListener('abort', abort, {once:true});
  });
  try { const result = await Promise.race([promise, expiry]); check(context); return result; }
  finally { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); }
}

export async function waitForSamBoatCondition(page, predicate, context, ...args) {
  check(context);
  // Android stops animation frames while the display is off. These are data
  // readiness checks, so use a timer instead of Puppeteer's default RAF poller.
  const handle = await bounded(page.waitForFunction(predicate, {
    polling:250, timeout:Math.max(1, Math.min(18000, context.deadlineAt-Date.now())),
    ...(context.signal ? {signal:context.signal} : {})
  }, ...args), context);
  if(handle?.dispose) await bounded(handle.dispose(), context);
}

export async function activateSamBoatTab(page, tab, context) {
  check(context);
  if(!TABS.includes(tab)) fail('schema_changed', 'SamBoat expected tab is invalid');
  const handle = await bounded(page.$(`[role="tablist"] [role="tab"][href="#${tab}"]`), context);
  if(!handle) fail('schema_changed', 'SamBoat expected tab is missing');
  try {
    // Invoke the existing page control without a viewport/scroll animation.
    // The selected panel, SSR/live cards and pagination are still verified.
    await bounded(handle.evaluate(element => element.click()), context);
    await waitForSamBoatCondition(page, id => document.querySelector('[role="tabpanel"].active')?.id === id,
      context, tab);
  } finally {
    if(handle.dispose) await bounded(handle.dispose(), context, 2000).catch(()=>{});
  }
}

// Only follow links that the authenticated list actually supplied. Never invent
// an API or use the unrelated global gotoPage(page) helper.
export function samBoatListLocation(value, tab = 'ongoing') {
  let url; try { url = new URL(value); } catch { fail('schema_changed', 'Invalid SamBoat list URL'); }
  if (url.origin !== 'https://www.samboat.com' || url.pathname !== '/private/reservations' || url.hash || url.username || url.password)
    fail('schema_changed', 'Unexpected SamBoat list destination');
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) fail('schema_changed', 'Duplicate SamBoat filter');
    seen.add(key);
    if (key === 'hideArchivedRefusedAndCancelled') {
      if (value !== '0') fail('incomplete_pages', 'SamBoat 归档隐藏了取消或拒绝订单');
    } else if (!TABS.includes(key) || !/^[1-9]\d*$/.test(value)) {
      fail('schema_changed', 'Unknown SamBoat list filter or page control');
    }
  }
  const page = Number(url.searchParams.get(tab) || 1);
  if (!TABS.includes(tab) || page > MAX_PAGES) fail('incomplete_pages', 'SamBoat pagination exceeds checked range');
  return {url:url.href, page};
}

// Runs inside the ordinary authenticated browser. For the independent view it
// parses the exact HTTP document response, without mounting or executing HTML.
export function inspectSamBoatDocument({html = null, url}) {
  const doc = html === null ? document : new DOMParser().parseFromString(html, 'text/html');
  const live = html === null;
  // Anonymous array entries keep esbuild keepNames helpers outside the function
  // body Puppeteer serializes, including the recursive canonicalization helper.
  const [compact, visible, href, stable] = [
    value => String(value || '').replace(/\s+/g, ' ').trim(),
    element => !live || element.getClientRects().length > 0,
    element => new URL(element.getAttribute('href'), url).href,
    value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ?
      Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value,
  ];
  const priceSlot = 'div.fs-large.fw-bold.d-flex.justify-content-center.align-items-center.gap-1';
  const [readCard] = [element => {
    const clone = element.cloneNode(true), slots = Array.from(element.querySelectorAll(priceSlot)),
      clonedSlots = Array.from(clone.querySelectorAll(priceSlot)), prices = [];
    let priceError = slots.length > 1 ? 'multiple_price_slots' : null;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index], node = slot.firstElementChild;
      if (!slot.parentElement?.matches('div.col-auto.col-md-3.text-md-center.order-3.order-md-3')) {
        priceError = 'price_slot_structure'; continue;
      }
      // A final cancelled card may retain an empty known price container. Its
      // independent visible current-status parser still must confirm Cancelled.
      if (!node && slot.children.length === 0 && !compact(slot.textContent) &&
        /(?:Cancelled|Canceled)$/i.test(compact(element.textContent))) continue;
      if (slot.children.length !== 1 || !node) { priceError = 'price_slot_structure'; continue; }
      if (!live) {
        const names = [':amount', ':currency', ':tooltip-currency', ':currencies'];
        if (node.tagName !== 'PRICE' || node.attributes.length !== names.length || names.some(name => !node.hasAttribute(name)) ||
          compact(node.textContent)) { priceError = 'raw_price_structure'; continue; }
        try {
          const amount = node.getAttribute(':amount'), currency = JSON.parse(node.getAttribute(':currency')),
            tooltipCurrency = JSON.parse(node.getAttribute(':tooltip-currency')), currencies = JSON.parse(node.getAttribute(':currencies'));
          if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || !Array.isArray(currencies) || !currencies.length ||
            ![currency,tooltipCurrency].every(item => item && /^[A-Z]{3}$/.test(item.iso) && Number.isInteger(item.decimals)))
            throw new Error('unrecognized_price_props');
          // Preserve source minor units, currencies and rates; do not infer a
          // conversion formula from the rendered USD amount.
          prices.push({kind:'source', amount_minor:amount, currency:stable(currency),
            tooltip_currency:stable(tooltipCurrency), currencies:stable(currencies)});
        } catch { priceError = 'raw_price_props'; continue; }
      } else {
        const tooltip = node.firstElementChild;
        if (!node.matches('span.text-nowrap') || node.children.length !== 1 ||
          !tooltip?.matches('span.text-secondary[data-bs-toggle="tooltip"][data-bs-title]') ||
          tooltip.children.length !== 1 || tooltip.firstElementChild?.tagName.toLowerCase() !== 'svg' ||
          compact(tooltip.textContent) || !/^[€$]\s*[\d,]+(?:\.\d{2})?$/.test(compact(node.textContent))) {
          priceError = 'rendered_price_structure'; continue;
        }
        prices.push({kind:'display', text:compact(node.textContent), tooltip:tooltip.getAttribute('data-bs-title')});
      }
      // Strip only the one observed component/span, leaving all other card
      // text and surrounding nodes subject to the original comparison.
      clonedSlots[index].firstElementChild.remove();
    }
    if (!live && element.querySelectorAll('price').length !== prices.length) priceError = 'unmatched_raw_price';
    return {url:href(element), text:live ? element.innerText : element.textContent,
      content:compact(element.textContent), content_without_price:compact(clone.textContent),
      prices, priceError, visible:visible(element)};
  }];
  // The server emits role=tab anchors before Vue adds their role=tablist parent.
  // Keep the hydrated document scoped; raw tabs still require the exact four IDs.
  const tabs = Array.from(doc.querySelectorAll(live ? '[role="tablist"] [role="tab"]' : '[role="tab"]')).map(element => ({
    target:element.getAttribute('href'), text:compact(element.textContent)
  }));
  const components = Array.from(doc.querySelectorAll('reservations-list'));
  const hideProps = components.flatMap(element => Array.from(element.attributes)
    .filter(attribute => /^(?::)?initial-hide-archived-refused-and-cancelled$/.test(attribute.name))
    .map(attribute => attribute.value));
  const listRoot = components[0] || doc.querySelector('[role="tablist"]')?.closest('.container');
  const listControls = Array.from(listRoot?.querySelectorAll('input,select') || []).map(element => ({
    type:element.getAttribute('type') || '', id:element.id, name:element.getAttribute('name') || '', checked:!!element.checked
  }));
  const panels = Array.from(doc.querySelectorAll('[role="tabpanel"]')).map(panel => {
    const anchors = Array.from(panel.querySelectorAll('a[href]'));
    const cards = anchors.filter(element => {
      try { return new URL(href(element)).pathname.startsWith('/private/reservation/'); } catch { return false; }
    }).map(readCard);
    const pages = anchors.filter(element => {
      try { return new URL(href(element)).pathname === '/private/reservations'; } catch { return false; }
    }).map(element => ({url:href(element), text:compact(element.textContent), rel:element.getAttribute('rel') || ''}));
    const labels = Array.from(panel.querySelectorAll('label'));
    const controls = Array.from(panel.querySelectorAll('input,select,button')).map(element => {
      const label = labels.find(label => label.contains(element) || (element.id && label.htmlFor === element.id));
      const card = element.closest('a[href]');
      // This observed button belongs to one order, not to a list filter. Read
      // its current pending status only; never approve, reply or click it.
      const answerText = compact(element.textContent);
      const pendingAnswer = element.tagName === 'BUTTON' && element.getAttribute('type') === 'button' &&
        ['Pre-paid: answer','Answer'].includes(answerText) &&
        element.matches('.btn.btn-primary.btn-sm.btn-md-base.btn-block') &&
        element.getAttributeNames().every(name => ['type','class'].includes(name)) &&
        element.parentElement?.matches('div.col-12.col-md-3.order-4.order-md-4.ms-md-auto.text-end.text-md-center');
      return {tag:element.tagName.toLowerCase(), id:element.id, type:element.getAttribute('type') || '',
        text:compact(label?.textContent || element.textContent), checked:!!element.checked,
        value:element.value || '', name:element.getAttribute('name') || '',
        ...(pendingAnswer && card ? {card_action:answerText==='Answer'?'answer_request':'prepaid_answer', card_url:href(card)} : {})};
    });
    const pagination = Array.from(panel.querySelectorAll('.pagination')).map(pager => ({
      current:Array.from(pager.querySelectorAll('.page-item.active')).map(item => compact(item.textContent)),
      items:Array.from(pager.querySelectorAll('.page-item')).map(item => ({text:compact(item.textContent),
        disabled:item.classList.contains('disabled'), active:item.classList.contains('active'),
        links:Array.from(item.querySelectorAll('a[href]')).map(link => href(link))}))
    }));
    return {id:panel.id, active:panel.classList.contains('active'), cards, pages, controls, pagination,
      empty:/\bno (?:requests|bookings|reservations|archived)\b/i.test(panel.textContent || ''),
      busy:!!panel.querySelector('[aria-busy="true"],.spinner-border,.spinner-grow,[role="progressbar"]')};
  });
  return {url, live, ready:!live || doc.readyState === 'complete', tabs, panels, hideProps, listControls,
    filters:Array.from(doc.querySelectorAll('#hideArchivedRefusedAndCancelled')).map(input => ({type:input.type, checked:input.checked})),
    account:Array.from(doc.querySelectorAll('a[href]')).some(element => {
      try { const link = new URL(href(element)); return link.origin === 'https://www.samboat.com' &&
        link.pathname === '/private/reservations/new-messages/mark-as-read' && link.searchParams.get('to_user_id') === '700000'; }
      catch { return false; }
    })};
}

export function validateSamBoatDocument(view) {
  samBoatListLocation(view.url);
  if (!view.account) fail('auth_required', 'SamBoat account could not be verified', 'account_unverified');
  if (!view.ready || view.tabs.length !== 4 || view.panels.length !== 4)
    fail('incomplete_pages', 'SamBoat document or observed tabs are not complete');
  for (const tab of Object.keys(DOCUMENT_LABELS)) {
    const controls = view.tabs.filter(item => item.target === '#' + tab);
    // Unread's notification badge changes whenever a new request/message
    // arrives. It is not a booking total and never supplies coverage evidence.
    const labelMatches = controls.length === 1 && (tab === 'new-message' ?
      /^Unread(?: [1-9]\d*)?$/.test(controls[0].text) : controls[0].text === DOCUMENT_LABELS[tab]);
    if (!labelMatches || view.panels.filter(panel => panel.id === tab).length !== 1)
      fail('schema_changed', 'SamBoat tab controls changed; no inferred status coverage', 'tab_controls_changed');
  }
  for (const value of view.hideProps || []) {
    if (!['false','0'].includes(value.trim())) fail('incomplete_pages', 'SamBoat hidden cancellations or unknown filter state');
  }
  const filters = view.filters || [];
  if (filters.length > 1 || filters.some(filter => filter.type !== 'checkbox' || filter.checked))
    fail('incomplete_pages', 'SamBoat hidden cancellation filter is active or ambiguous');
  if ((!view.live || view.panels.find(panel => panel.id === 'archived')?.active) && filters.length !== 1)
    fail('schema_changed', 'SamBoat archive filter cannot be verified');
  for (const control of view.listControls || []) {
    if (control.type === 'checkbox' && control.id === 'hideArchivedRefusedAndCancelled') {
      if (control.checked) fail('incomplete_pages', 'SamBoat archive filter is hiding cancellations');
    } else if (!(control.type === 'hidden' && control.name === '_token')) {
      fail('schema_changed', 'Unknown SamBoat list-wide filter; coverage not assumed');
    }
  }
  for (const panel of view.panels) {
    if (panel.busy) fail('incomplete_pages', 'SamBoat list is still loading');
    if (panel.cards.some(card => card.priceError)) fail('schema_changed', 'SamBoat price component structure changed');
    for (const control of panel.controls) {
      if (control.type === 'checkbox' && control.id === 'hideArchivedRefusedAndCancelled' && panel.id === 'archived') {
        if (control.checked) fail('incomplete_pages', 'SamBoat 归档隐藏了取消订单');
      } else if (((control.card_action === 'prepaid_answer' && control.text === 'Pre-paid: answer') ||
        (control.card_action === 'answer_request' && control.text === 'Answer')) && ['new-message','ongoing'].includes(panel.id) &&
        control.tag === 'button' && control.type === 'button' &&
        !control.id && !control.name && !control.value &&
        panel.controls.filter(item => item.card_url === control.card_url).length === 1 &&
        panel.cards.filter(card => card.url === control.card_url && card.content.match(/(?:^|\s)(Pre-paid: answer|Answer)$/)?.[1] === control.text).length === 1) {
        samBoatIdentity(control.card_url);
      } else if (!(control.type === 'hidden' && control.name === '_token')) {
        fail('schema_changed', 'Unknown SamBoat list control; coverage not assumed', 'unknown_list_control');
      }
    }
    if (panel.id !== 'new-message' && !panel.cards.length && !panel.empty) fail('incomplete_pages', 'SamBoat empty list lacks an explicit server empty state');
  }
  return view;
}

function pageSignature(panel, comparable = false) {
  return JSON.stringify({cards:panel.cards.map(card => comparable ?
    {url:card.url, content:card.content_without_price ?? card.content, price_count:card.prices?.length || 0} :
    {url:card.url, content:card.content, body:card.content_without_price ?? card.content, prices:card.prices || []}),
    pages:panel.pages.map(link => ({url:link.url,text:link.text,rel:link.rel})), pagination:panel.pagination, empty:panel.empty});
}

export function reconcileSamBoatPage(server, rendered, tab) {
  validateSamBoatDocument(server); validateSamBoatDocument(rendered);
  const expected = server.panels.find(panel => panel.id === tab);
  const actual = rendered.panels.find(panel => panel.id === tab);
  if (rendered.panels.filter(panel => panel.active).length !== 1 || !actual.active || actual.cards.some(card => !card.visible))
    fail('incomplete_pages', 'SamBoat target list is not fully visible');
  if (pageSignature(expected, true) !== pageSignature(actual, true))
    fail('incomplete_pages', 'SamBoat rendered cards or pagination differ from the HTTP document');
  const page = samBoatListLocation(server.url, tab).page;
  const destinations = new Map();
  for (const link of expected.pages) {
    const destination = samBoatListLocation(link.url, tab);
    const direction = link.rel === 'next' || /^(?:Next|[>»›→])$/i.test(link.text) ? 1 :
      link.rel === 'prev' || /^(?:Previous|Prev|[<«‹←])$/i.test(link.text) ? -1 : 0;
    if (direction && destination.page !== page + direction)
      fail('incomplete_pages', 'SamBoat next/previous link does not advance exactly one page');
    if (/^\d+$/.test(link.text)) {
      if (Number(link.text) !== destination.page) fail('schema_changed', 'SamBoat page label differs from its URL');
    } else if (!['next','prev'].includes(link.rel) && !/^(?:Next|Previous|Prev|[<>«»‹›←→])$/i.test(link.text)) {
      fail('schema_changed', 'Unknown SamBoat pagination control');
    }
    if (destinations.has(destination.page) && destinations.get(destination.page) !== destination.url)
      fail('schema_changed', 'Ambiguous SamBoat page URLs');
    destinations.set(destination.page, destination.url);
  }
  const declaredPages = [];
  if (expected.pagination.length > 1 || ((expected.pages.length || page !== 1) && expected.pagination.length !== 1))
    fail('schema_changed', 'SamBoat pagination container changed');
  for (const pager of expected.pagination) {
    if (pager.current.length !== 1 || !/^[1-9]\d*$/.test(pager.current[0]) || Number(pager.current[0]) !== page)
      fail('incomplete_pages', 'SamBoat active page marker differs from requested page');
    for (const item of pager.items) {
      if (/^[1-9]\d*$/.test(item.text)) {
        declaredPages.push(Number(item.text));
        if (!item.active && !item.links.length) fail('incomplete_pages', 'SamBoat declared page lacks a navigable link');
      } else if (!/^[<>«»‹›←→]$/.test(item.text)) fail('schema_changed', 'Unknown or omitted SamBoat pagination boundary');
      if (!item.active && !item.disabled && !item.links.length)
        fail('incomplete_pages', 'SamBoat navigation control lacks a link');
    }
    if (new Set(declaredPages).size !== declaredPages.length) fail('schema_changed', 'SamBoat page declarations repeat');
    const highest = Math.max(...declaredPages);
    for (const [pattern, atBoundary] of [[/^[<«‹←]$/, page === 1],[/^[>»›→]$/, page === highest]]) {
      const arrows = pager.items.filter(item => pattern.test(item.text));
      if (arrows.length !== 1 || arrows[0].active || arrows[0].disabled !== atBoundary ||
        (atBoundary ? arrows[0].links.length !== 0 : arrows[0].links.length !== 1))
        fail('incomplete_pages', 'SamBoat pagination beginning/end is not independently confirmed');
    }
  }
  const records = actual.cards.map(card => parseSamBoatListCard(card, {verifiedAt:new Date().toISOString()}));
  if (new Set(records.map(record => record.booking_id)).size !== records.length)
    fail('incomplete_pages', 'Duplicate SamBoat booking on one page');
  return {page, records, declaredPages, destinations:[...destinations],
    signature:JSON.stringify({server:pageSignature(expected), rendered:pageSignature(actual)}),
    unreadIds:server.panels.find(panel => panel.id === 'new-message').cards.map(card => new URL(card.url).pathname.split('/').at(-1))};
}

export function assertSamBoatTraversal(pages) {
  for (const tab of TABS) {
    const subset = pages.filter(page => page.tab === tab), numbers = subset.map(page => page.page).sort((a,b) => a-b);
    const highest = Math.max(1, ...subset.flatMap(page => [page.page, ...(page.declaredPages || []), ...page.destinations.map(([number]) => number)]));
    if (highest > MAX_PAGES || numbers.length !== highest || numbers.some((number,index) => number !== index + 1))
      fail('incomplete_pages', 'SamBoat pagination has an unread page or gap');
  }
  const records = new Map(), seenByTab = new Set();
  for (const page of pages) for (const record of page.records) {
    const scoped = page.tab + ':' + record.booking_id;
    if (seenByTab.has(scoped)) fail('incomplete_pages', 'SamBoat booking repeated on different pages of one tab');
    seenByTab.add(scoped);
    const prior = records.get(record.booking_id);
    if (prior) for (const key of ['booking_id','boataround_slug','start','end','status','amount','amount_basis']) {
      if (prior[key] !== record[key]) fail('incomplete_pages', 'SamBoat duplicate tabs disagree on current order fields');
    }
    records.set(record.booking_id, record);
  }
  for (const page of pages) for (const id of page.unreadIds || []) {
    if (!records.has(id)) fail('incomplete_pages', 'Unread SamBoat booking is missing from the complete status lists');
  }
  return [...records.values()];
}

async function readListPage(page, url, tab, context) {
  samBoatListLocation(url, tab); check(context);
  const {response, finalUrl} = await atStage(context, 'list_navigation', async () => {
    const response = await bounded(page.goto(url, {waitUntil:'domcontentloaded', timeout:Math.min(18000, context.deadlineAt-Date.now())}), context);
    const finalUrl = validateSamBoatResponse(response); samBoatListLocation(finalUrl, tab);
    if (samBoatListLocation(url, tab).page !== samBoatListLocation(finalUrl, tab).page)
      fail('incomplete_pages', 'SamBoat page request redirected to a different page');
    return {response, finalUrl};
  });
  const server = await atStage(context, 'raw_document', async () => {
    const html = await bounded(response.text(), context);
    if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) fail('incomplete_pages', 'SamBoat document exceeds checked size');
    return validateSamBoatDocument(await bounded(page.evaluate(inspectSamBoatDocument, {html, url:finalUrl}), context));
  });
  await atStage(context, 'list_ready', async () => {
    await waitForSamBoatCondition(page, () => document.readyState === 'complete', context);
    await activateSamBoatTab(page, tab, context);
  });
  return atStage(context, 'list_reconcile', async () => {
    const rendered = await bounded(page.evaluate(inspectSamBoatDocument, {url:page.url()}), context);
    return {...reconcileSamBoatPage(server, rendered, tab), tab, url:finalUrl};
  });
}

async function readAllLists(context) {
  const pages = [];
  for (const tab of TABS) {
    const queue = [BASE], visited = new Set();
    while (queue.length) {
      check(context);
      const url = queue.shift(), number = samBoatListLocation(url, tab).page;
      if (visited.has(number)) continue;
      const result = await readListPage(context.page, url, tab, context);
      visited.add(result.page); pages.push(result);
      if (pages.length > MAX_PAGES) fail('incomplete_pages', 'SamBoat traversal exceeds checked range');
      for (const [number, href] of result.destinations) if (!visited.has(number)) queue.push(href);
    }
  }
  return {pages, records:assertSamBoatTraversal(pages)};
}

export function assertSamBoatRecheck(before, after) {
  const ordered = pages => [...pages].sort((a,b) => `${a.tab}:${a.page}`.localeCompare(`${b.tab}:${b.page}`));
  const left = ordered(before), right = ordered(after), cancelled = new Map();
  const changed = () => fail('incomplete_pages', 'SamBoat lists changed during detail verification');
  if (left.length !== right.length) changed();
  for (let index = 0; index < left.length; index++) {
    const previous = left[index], latest = right[index];
    if (previous.tab !== latest.tab || previous.page !== latest.page) changed();
    if (previous.signature === latest.signature) continue;
    if (JSON.stringify([previous.declaredPages,previous.destinations,previous.unreadIds]) !==
      JSON.stringify([latest.declaredPages,latest.destinations,latest.unreadIds]) ||
      !Array.isArray(previous.records) || !Array.isArray(latest.records) || previous.records.length !== latest.records.length) changed();
    const changes = new Map();
    for (let row = 0; row < previous.records.length; row++) {
      const old = previous.records[row], next = latest.records[row];
      if (['booking_id','boataround_slug','start','end','url'].some(key => old[key] !== next[key])) changed();
      if (old.status !== next.status) {
        if (!['deposit_paid','paid','accepted'].includes(old.status) || next.status !== 'cancelled' ||
          !/^(?:cancelled|canceled)$/i.test(next.platform_status || '')) changed();
        changes.set(old.booking_id, {old, next}); cancelled.set(next.booking_id, next);
      }
    }
    if (!changes.size) changed();
    let first, final;
    try { first = JSON.parse(previous.signature); final = JSON.parse(latest.signature); } catch { changed(); }
    if (!first || !final || typeof first !== 'object' || typeof final !== 'object') changed();
    // Only a verified current cancellation may change a card's final status or
    // its known price component. Every other byte of the normalized body, the
    // identity/order of cards, and all pagination evidence must stay identical.
    const normalize = (signature, side) => {
      let document; try { document = JSON.parse(signature); } catch { changed(); }
      if (!document || !Array.isArray(document.cards) || document.cards.length !== previous.records.length) changed();
      return {...document, cards:document.cards.map((card, row) => {
        const id = previous.records[row].booking_id, change = changes.get(id);
        if (!change) return card;
        const record = change[side], suffix = String(record.platform_status || '').replace(/\s+/g,' ').trim();
        if (typeof card.body !== 'string' || !suffix || !card.body.endsWith(suffix)) changed();
        return {...card, content:card.body.slice(0,-suffix.length), body:card.body.slice(0,-suffix.length), prices:[]};
      })};
    };
    for (const side of ['server','rendered']) {
      if (JSON.stringify(normalize(first[side], 'old')) !== JSON.stringify(normalize(final[side], 'next'))) changed();
    }
  }
  return [...cancelled.values()];
}

async function collectSamBoatOnce(context) {
  check(context);
  await bounded(context.page.setCacheEnabled(false), context);
  const initial = await readAllLists(context), orders = [];
  for (const record of initial.records) {
    // Checkout remains occupied today, so current payment/cancellation is
    // still required until the following day.
    if (record.end < context.fromDay) continue;
    check(context);
    if (['deposit_paid','paid','accepted'].includes(record.status)) {
      await atStage(context, 'detail_navigation', async () => {
        const response = await bounded(context.page.goto(record.url, {waitUntil:'domcontentloaded', timeout:Math.min(18000,context.deadlineAt-Date.now())}), context);
        const finalUrl = validateSamBoatResponse(response);
        if (samBoatIdentity(finalUrl).booking_id !== record.booking_id)
          fail('incomplete_pages', 'SamBoat detail redirected to a different booking');
      });
      await atStage(context, 'detail_ready', () => waitForSamBoatCondition(context.page, depositLabels => {
        if (document.readyState !== 'complete') return false;
        const all = String(document.body.innerText).split(/\r?\n/).map(line => line.replace(/\s+/g,' ').trim()).filter(Boolean);
        const chat = all.findIndex(line => /^(?:To contact\b|Conversation with\b|(?:Request |Booking )?History$)/i.test(line));
        const beforeChat = all.slice(0, chat < 0 ? all.length : chat);
        const headings = beforeChat.map((line,index) => /^Request n[°º]\d+$/i.test(line) ? index : -1).filter(index => index >= 0);
        if (headings.length !== 1) return false;
        const lines = beforeChat.slice(headings[0]), progress = ['Request','Pre-approve','Paid','In progress','Completed'];
        let current = -1;
        for (let index = 0; index <= lines.length-progress.length; index++) {
          if (progress.every((step, offset) => lines[index+offset] === step)) {
            if (current >= 0) return false;
            current = index+progress.length;
          }
        }
        if (current < 0 || !lines[current]) return false;
        // Terminal/unknown badges go to the strict parser without a financial
        // dependency. A still-paid booking must finish rendering its amount.
        const paidConfirmation=/^.{1,160} has paid the rent\.$/.test(lines[current]) &&
          lines[current+1]==='The reservation is confirmed.';
        if (!paidConfirmation && !depositLabels.includes(lines[current].toUpperCase())) return true;
        const price = beforeChat.indexOf('To be paid online');
        return price >= 0 && /^[€$]\s*[\d,.]+$/.test(beforeChat[price+1] || '');
      },
        context, SAMBOAT_DEPOSIT_PAID_LABELS));
      const details = await atStage(context, 'detail_parse', async () => {
        const details = parseSamBoatDetail({bodyText:await bounded(context.page.evaluate(() => document.body.innerText), context),
          url:context.page.url(), boataround_slug:record.boataround_slug, current_status:record.status, verifiedAt:new Date().toISOString()});
        const keys = details.status === 'cancelled' && /^(?:cancelled|canceled)$/i.test(details.platform_status || '') ?
          ['booking_id','boataround_slug','start','end'] : ['booking_id','boataround_slug','start','end','status','amount'];
        for (const key of keys) {
          if (record[key] !== undefined && details[key] !== record[key]) fail('incomplete_pages', 'SamBoat order changed during detail verification');
        }
        return details;
      });
      orders.push(details);
    } else orders.push(record);
  }
  const cancellations = await atStage(context, 'final_recheck', async () => {
    const recheck = await readAllLists(context);
    return new Map(assertSamBoatRecheck(initial.pages, recheck.pages).map(record => [record.booking_id, record]));
  });
  for (let index = 0; index < orders.length; index++) {
    if (cancellations.has(orders[index].booking_id)) orders[index] = cancellations.get(orders[index].booking_id);
  }
  check(context);
  return {source:'samboat', run_id:crypto.randomUUID(), checked_at:new Date().toISOString(), complete:true,
    scope:{kind:'current_future', from_day:context.fromDay, fleet_slugs:FLEET.map(boat => boat.slug)},
    // Legacy receiver's output count, not a fabricated platform-declared total.
    expected_count:orders.length, orders,
    pagination:{complete:true, total_pages:initial.pages.length,
      pages_read:initial.pages.map((_,index) => index + 1), listed_count:initial.records.length}};
}

export async function collectSamBoat(context) {
  const startedAt=Date.now();
  try { return await collectSamBoatOnce(context); }
  catch (error) {
    // Reading an order may clear its unread marker; a legitimate booking or
    // exchange-rate update can also arrive during verification. Keep every
    // comparison strict, then take one wholly new snapshot if time permits.
    // No records, signatures, payment proofs or pagination are reused.
    const requiredBudget=Math.max(45000,Math.ceil((Date.now()-startedAt)*1.25));
    if (error.code !== 'incomplete_pages' || error.diagnostic_stage !== 'final_recheck' ||
      context.signal?.aborted || context.deadlineAt-Date.now()<requiredBudget) throw error;
    return collectSamBoatOnce(context);
  }
}
