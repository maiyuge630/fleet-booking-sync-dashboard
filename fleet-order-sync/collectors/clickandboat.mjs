import {FLEET, parseClickAndBoatListRow, parseClickAndBoatDetail, isAccessChallenge} from '../parsers.mjs';
export {isAccessChallenge};
import {applyClickAndBoatPaymentEvidence} from '../payment-evidence.mjs';

// Observed account page and official accountBookingInit():
// api-inspection/public-js/all.min~a342407df9.pretty.js:16480-16513.
// No global count API has been observed. HTML manifests below are independent
// of the rendered/visible rows, but are not a claimed platform-wide API total.
export const LIST_URL = 'https://www.clickandboat.com/uk/account/bookings';
const MAX_HTML = 4 * 1024 * 1024;
const MAX_PAGES = 50;
// This user-authorized reschedule remains a historical order on the platform.
// Observe its current status separately; never invent current dates or payment.
const MANUAL_OBSERVATION_ID = '1000000';
const fail = (code, message) => { const error = new Error(message || code); error.code = code; throw error; };
const check = context => {
  if (context.signal?.aborted || !Number.isFinite(context.deadlineAt) || Date.now() >= context.deadlineAt) fail('timeout', '同步超时，保留上次完整订单');
};
const timeout = (context, max = 18000) => { check(context); return Math.max(1, Math.min(max, context.deadlineAt - Date.now())); };
const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const diagnostic=(context,stage,reason='progress')=>context.reportDiagnostic?.({stage,reason});
function successfulHtml(response) {
  if (isAccessChallenge(response)) fail('challenge_required', 'Click&Boat 要求人工完成访问验证，保留上次完整订单');
  if (response?.status() === 401) fail('auth_required', 'Click&Boat 当前请求需要重新登录');
  if (!response || response.status() !== 200 || !/^text\/html(?:\s*;|$)/i.test(response.headers()['content-type'] || ''))
    fail('fetch_failed', 'Click&Boat 未返回成功的 HTML 响应，保留上次完整订单');
  return response;
}
async function navigateDetail(context, url) {
  diagnostic(context,'detail_navigation');
  const response=await context.page.goto(url, {waitUntil:'domcontentloaded',timeout:timeout(context)});
  check(context);successfulHtml(response);
}

export async function waitForClickAndBoatCondition(page, predicate, context, ...args) {
  // Readiness must progress while the screen is off and RAF delivery is paused.
  const handle = await page.waitForFunction(predicate, {timeout: timeout(context), polling: 250,
    ...(context.signal ? {signal: context.signal} : {})}, ...args);
  try { check(context); } finally { await handle?.dispose?.(); }
}

/** Runs only in the current authenticated page. Detached HTML is never executed. */
export function inspectClickAndBoatDocument({html = null} = {}) {
  const detached = html !== null;
  const doc = detached ? new DOMParser().parseFromString(html, 'text/html') : document;
  // Anonymous array entries avoid keepNames injecting an external helper into
  // this function, whose body Puppeteer serializes into the page.
  const [compact, visible] = [
    value => String(value ?? '').replace(/\s+/g, ' ').trim(),
    element => !detached && element.getClientRects().length > 0,
  ];
  const root = doc.querySelector('#bookings');
  const tabs = Array.from(doc.querySelectorAll('#filter-state button')).map(button => ({
    text: compact(button.textContent), filter: button.getAttribute('data-filter-class'),
    active: button.classList.contains('active'), visible: visible(button),
  }));
  const rows = Array.from(root?.querySelectorAll('.booking-row') || []).map(row => {
    const anchor = row.querySelector('a[href*="/booking/"][href$="/detail"]');
    let url = null; try { url = anchor ? new URL(anchor.getAttribute('href'), 'https://www.clickandboat.com').href : null; } catch {}
    const state = row.querySelector('.cell-status .status');
    return {
      url, booking_id: compact(row.querySelector('.cell-id .id')?.textContent).replace(/^N[°º]\s*/, ''),
      status: state?.getAttribute('data-state') ?? null,
      boat_text: compact(row.querySelector('.cell-details a')?.textContent),
      date_text: compact(row.querySelector('.cell-details .date')?.textContent),
      amount: compact(row.querySelector('.cell-price .total')?.textContent),
      visible: visible(row),
      visibleStates: Array.from(state?.children || []).filter(visible).map(child => compact(child.innerText)),
    };
  });
  const groups = Array.from(root?.querySelectorAll('.js-inProgress, .js-paginationHistory') || []).map(group => ({
    name: group.classList.contains('js-inProgress') && !group.classList.contains('js-paginationHistory') ? 'In progress' :
      group.classList.contains('js-paginationHistory') && !group.classList.contains('js-inProgress') ? 'History' : null,
    ids: Array.from(group.querySelectorAll('.booking-row')).map(row => compact(row.querySelector('.cell-id .id')?.textContent).replace(/^N[°º]\s*/, '')).sort(),
  }));
  const orderAnchors = Array.from(root?.querySelectorAll('a[href]') || []).map(anchor => {
    try { const url = new URL(anchor.getAttribute('href'), 'https://www.clickandboat.com');
      return /^\/uk\/booking\/\d+\/detail$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }).filter(Boolean);
  const paginations = Array.from(doc.querySelectorAll('.pagination')).map(container => ({
    // Empty means no controls, unknown descendants, or meaningful stray text.
    // An unrecognized nonempty tree must not become an invented single page.
    structureSupported: Array.from(container.childNodes).every(node =>
      node.nodeType === 8 || (node.nodeType === 3 && !compact(node.textContent)) ||
      (node.nodeType === 1 && node.tagName === 'UL' && Array.from(node.childNodes).every(child =>
        child.nodeType === 8 || (child.nodeType === 3 && !compact(child.textContent)) || (child.nodeType === 1 && child.tagName === 'LI')))) &&
      container.querySelectorAll(':scope > ul').length <= 1 && !container.querySelector('button, input, select, [role="button"]'),
    empty: !compact(container.textContent) && Array.from(container.querySelectorAll('*')).every(element =>
      element.tagName === 'UL' && element.parentElement === container),
    items: Array.from(container.querySelectorAll(':scope > ul > li')).map(item => ({
      text: compact(item.textContent), active: item.classList.contains('active'),
      disabled: item.classList.contains('disabled'),
      next: !!item.querySelector('a.next'), prev: !!item.querySelector('a.prev'),
      href: item.querySelector('a')?.getAttribute('href') ?? null,
    })),
  }));
  // Detect a replacement paginator/load-more UI rather than silently assuming one page.
  const unknownPagination = Array.from((root || doc).querySelectorAll(
    '[aria-label*="agination"], [class*="pagination"], [class*="load-more"], [class*="loadMore"], a[rel="next"], a[href*="page="], button'
  )).some(element => {
    if (element.matches('#filter-state button') || element.closest('#filter-state')) return false;
    if (element.matches('.pagination, .js-pagination, .js-paginationHistory') || element.closest('.pagination')) return false;
    if (element.matches('a[href*="page="]')) {
      try { const url = new URL(element.getAttribute('href'), 'https://www.clickandboat.com');
        if (url.pathname === '/uk/account/bookings') return true;
      } catch { return true; }
    }
    return /pagination|load.more/i.test(element.className || '') || element.hasAttribute('rel') ||
      /pagination/i.test(element.getAttribute('aria-label') || '') || /^(?:load|show) more|^next(?: page)?$/i.test(compact(element.textContent));
  });
  const empty = /no bookings|no booking yet|no reservations/i.test(root?.textContent || '');
  // Use the same observed profile h1 as AUTH_CHECKS. A generic bookings page
  // or known vessel names alone do not prove which account is currently open.
  // Check both the raw response and every hydrated page, including rereads.
  const account_verified = Array.from(doc.querySelectorAll('h1')).filter(heading => compact(heading.textContent) === 'Demo Owner').length === 1;
  return {valid: !!root && /All your bookings/i.test(doc.body?.textContent || ''), account_verified, tabs, rows, groups,
    orderAnchors: [...new Set(orderAnchors)].sort(), paginations, unknownPagination, empty};
}

export function manifest(rows) {
  const ids = new Set();
  return rows.map(row => {
    const id = String(row.booking_id ?? '');
    if (!/^\d+$/.test(id) || row.url !== `https://www.clickandboat.com/uk/booking/${id}/detail` || ids.has(id)) {
      fail('incomplete_pages', 'Click&Boat 订单编号缺失、重复或链接不匹配');
    }
    ids.add(id);
    if (!row.status || !tidy(row.boat_text) || !tidy(row.date_text)) fail('schema_changed', 'Click&Boat 订单行字段不完整');
    return [id, row.url, tidy(row.status), tidy(row.boat_text), tidy(row.date_text), tidy(row.amount)];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}
export function assertSameManifest(before, after) {
  if (JSON.stringify(manifest(before)) !== JSON.stringify(manifest(after))) {
    fail('incomplete_pages', 'Click&Boat 订单身份、状态、日期或船只在核验期间变化');
  }
}
export function validateHtmlManifest(documentData) {
  if (!documentData.valid) fail('auth_required', '未取得已登录 Click&Boat 的订单 HTML');
  if (documentData.account_verified !== true) fail('auth_required', 'Click&Boat 当前账号未通过核验，保留上次完整订单');
  const rows = manifest(documentData.rows);
  const hrefs = rows.map(row => row[1]).sort();
  if (JSON.stringify(hrefs) !== JSON.stringify(documentData.orderAnchors)) fail('incomplete_pages', '服务器订单链接与订单行不完整匹配');
  if (!rows.length && !documentData.empty) fail('incomplete_pages', '无法核实服务器空订单状态');
  const groups = documentData.groups;
  if (!Array.isArray(groups) || groups.length !== 2 ||
      groups.filter(group => group.name === 'In progress').length !== 1 ||
      groups.filter(group => group.name === 'History').length !== 1 ||
      JSON.stringify(groups.flatMap(group => group.ids).sort()) !== JSON.stringify(rows.map(row => row[0]).sort())) {
    fail('incomplete_pages', 'Click&Boat 服务器缺少完整的进行中或历史订单分组');
  }
  if (!Array.isArray(documentData.paginations) || !documentData.paginations.length ||
      documentData.paginations.some(pagination => pagination.structureSupported !== true)) {
    fail('incomplete_pages', 'Click&Boat 分页容器缺失或内部结构无法识别');
  }
  const names = documentData.tabs.map(tab => tab.text);
  if (names.length !== 2 || !names.includes('In progress') || !names.includes('History') ||
      documentData.tabs.some(tab => !tab.filter) || new Set(documentData.tabs.map(tab => tab.filter)).size !== 2) {
    fail('schema_changed', 'Click&Boat 订单标签结构已变化');
  }
}

/** Only the paginator implemented by the observed official legacy script. */
export function paginationPlan(data, currentPage = 1) {
  if (data.unknownPagination) fail('incomplete_pages', 'Click&Boat 出现未知分页或加载更多控件');
  if (!data.paginations.length || data.paginations.some(pagination => pagination.structureSupported !== true)) {
    fail('incomplete_pages', 'Click&Boat 缺少可核实分页容器或其结构未知');
  }
  const signatures = data.paginations.map(pagination => JSON.stringify(pagination.items));
  if (new Set(signatures).size !== 1) fail('incomplete_pages', 'Click&Boat 多组分页边界不一致');
  const items = data.paginations[0].items;
  // The 2026-09-10 authenticated HTML evidence has one empty .pagination.
  // It is the observed one-page representation, not an independently counted total.
  if (!items.length) {
    if (currentPage !== 1 || data.paginations.some(pagination => pagination.empty !== true)) fail('incomplete_pages', 'Click&Boat 后续页分页边界消失或分页容器并非真正为空');
    return {pages: [1], next: null};
  }
  const numeric = items.filter(item => /^\d+$/.test(item.text) && !item.next && !item.prev);
  const active = numeric.filter(item => item.active);
  if (active.length !== 1 || Number(active[0].text) !== currentPage) fail('incomplete_pages', 'Click&Boat 当前分页未选中');
  if (items.some(item => !/^\d+$/.test(item.text) && !item.next && !item.prev)) fail('incomplete_pages', 'Click&Boat 分页边界被省略或结构未知');
  const pages = numeric.map(item => Number(item.text)).sort((a, b) => a - b);
  if (!pages.length || pages.length > MAX_PAGES || pages.some((value, index) => value !== index + 1)) {
    fail('incomplete_pages', 'Click&Boat 分页编号不连续或超出核验范围');
  }
  const nexts = items.filter(item => item.next), prevs = items.filter(item => item.prev);
  if (nexts.length > 1 || prevs.length > 1 ||
      (nexts.length && nexts[0].disabled !== (currentPage === pages.at(-1))) ||
      (prevs.length && prevs[0].disabled !== (currentPage === 1))) fail('incomplete_pages', 'Click&Boat 分页前后边界不一致');
  return {pages, next: currentPage < pages.at(-1) ? currentPage + 1 : null};
}

export function pageUrl(pageNumber, initialUrl = LIST_URL) {
  const initial = new URL(initialUrl);
  if (initial.origin + initial.pathname !== LIST_URL || initial.username || initial.password || initial.hash ||
      [...initial.searchParams.keys()].some(key => !['page', 'limit'].includes(key)) ||
      ['page', 'limit'].some(key => initial.searchParams.getAll(key).length > 1) ||
      !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGES) fail('schema_changed', 'Click&Boat 分页地址无效');
  // Matches the site's observed JS, including null when limit was absent.
  return `${LIST_URL}?page=${pageNumber}&limit=${encodeURIComponent(initial.searchParams.get('limit'))}`;
}

async function navigateList(context, url) {
  diagnostic(context,'list_navigation');
  const response = await context.page.goto(url, {waitUntil: 'domcontentloaded', timeout: timeout(context)});
  check(context);
  successfulHtml(response);
  if (new URL(response.url()).origin + new URL(response.url()).pathname !== LIST_URL)
    fail('auth_required', '未取得订单列表的成功 HTML 响应');
  diagnostic(context,'raw_document');
  const body = await response.buffer();
  if (body.length > MAX_HTML) fail('incomplete_pages', 'Click&Boat 订单 HTML 超出安全核验大小');
  check(context);
  const server = await context.page.evaluate(inspectClickAndBoatDocument, {html: body.toString('utf8')});
  validateHtmlManifest(server);
  return server;
}

async function readSelectedTab(context, tab, server) {
  diagnostic(context,'list_ready');
  const {page} = context;
  const buttons = await page.$$('#filter-state button');
  let selected = null;
  for (const button of buttons) {
    if (await button.evaluate((element, name) => element.getClientRects().length > 0 && element.textContent.trim() === name, tab.text)) {
      selected = button; break;
    }
  }
  if (!selected) fail('schema_changed', 'Click&Boat 订单标签无法定位');
  await selected.click();
  await waitForClickAndBoatCondition(page, ({text, filter}) => {
    const active = Array.from(document.querySelectorAll('#filter-state button.active'));
    return document.readyState === 'complete' && active.length === 1 && active[0].textContent.trim() === text &&
      active[0].getAttribute('data-filter-class') === filter;
  }, context, tab);
  check(context);
  const live = await page.evaluate(inspectClickAndBoatDocument, {});
  validateHtmlManifest(live);
  assertSameManifest(server.rows, live.rows);
  if (live.tabs.filter(item => item.active).length !== 1 || !live.tabs.some(item => item.active && item.text === tab.text)) fail('incomplete_pages', 'Click&Boat 标签切换未完成');
  const expectedIds = live.groups.find(group => group.name === tab.text).ids;
  if (JSON.stringify(live.rows.filter(row => row.visible).map(row => row.booking_id).sort()) !== JSON.stringify(expectedIds)) {
    fail('incomplete_pages', 'Click&Boat 选中标签未显示对应分组的全部订单');
  }
  return {rows: live.rows.filter(row => row.visible), data: live};
}

async function readCompleteList(context) {
  const records = [], rawRows = [], historyIds = new Set(), pagesById = new Map();
  let currentPage = 1, totalPages = null, inProgress = null;
  while (true) {
    check(context);
    const server = await navigateList(context, currentPage === 1 ? LIST_URL : pageUrl(currentPage));
    const inProgressTab = server.tabs.find(tab => tab.text === 'In progress');
    const historyTab = server.tabs.find(tab => tab.text === 'History');
    const progress = await readSelectedTab(context, inProgressTab, server);
    const history = await readSelectedTab(context, historyTab, server);
    // All server-rendered identities must be covered exactly once by the two tabs.
    assertSameManifest(server.rows, [...progress.rows, ...history.rows]);
    const plan = paginationPlan(history.data, currentPage);
    const serverPlan = paginationPlan(server, currentPage);
    if (JSON.stringify(plan) !== JSON.stringify(serverPlan)) fail('incomplete_pages', 'Click&Boat 渲染分页与服务器分页不一致');
    if (totalPages === null) totalPages = plan.pages.length;
    if (totalPages !== plan.pages.length) fail('incomplete_pages', 'Click&Boat 分页总数在翻页时变化');
    if (inProgress === null) {
      inProgress = progress.rows; rawRows.push(...progress.rows);
      for (const row of progress.rows) pagesById.set(row.booking_id, 1);
    }
    else assertSameManifest(inProgress, progress.rows);
    for (const row of history.rows) {
      if (historyIds.has(row.booking_id)) fail('incomplete_pages', 'Click&Boat 历史订单跨页重复');
      historyIds.add(row.booking_id); rawRows.push(row); pagesById.set(row.booking_id, currentPage);
    }
    if (!plan.next) break;
    currentPage = plan.next;
  }
  manifest(rawRows); // Also rejects an ID shared by current and historical tabs.
  const stamp = new Date().toISOString();
  for (const row of rawRows) records.push(parseClickAndBoatListRow(row, {verifiedAt: stamp}));
  return {records, rawRows, totalPages, pagesById};
}

/** Only a current cancellation may supersede an otherwise stable inventory. */
function reconcileCancelledOrders(before, after, orders) {
  const previous = manifest(before.rawRows), current = manifest(after.rawRows);
  if (before.totalPages !== after.totalPages || previous.length !== current.length) {
    fail('incomplete_pages', 'Click&Boat 详情核验期间订单总数或分页总数变化');
  }
  const afterRecords = new Map(after.records.map(record => [record.booking_id, record]));
  const beforeRaw = new Map(before.rawRows.map(row => [row.booking_id, row]));
  const afterRaw = new Map(after.rawRows.map(row => [row.booking_id, row]));
  const beforeRecords = new Map(before.records.map(record => [record.booking_id, record]));
  for (let index = 0; index < previous.length; index++) {
    const oldRow = previous[index], newRow = current[index], id = oldRow[0];
    // Identity, URL, boat/date text and page placement cannot change even when cancelled.
    if ([0, 1, 3, 4].some(field => oldRow[field] !== newRow[field]) ||
        before.pagesById.get(id) !== after.pagesById.get(id)) {
      fail('incomplete_pages', 'Click&Boat 订单身份、分页、日期或船只在核验期间变化');
    }
    const oldRecord = beforeRecords.get(id), newRecord = afterRecords.get(id);
    assertDetailIdentity(oldRecord, newRecord);
    if (newRecord.status === 'cancelled') continue;
    if (JSON.stringify(oldRow) !== JSON.stringify(newRow) || oldRecord.status !== newRecord.status ||
        JSON.stringify(beforeRaw.get(id).visibleStates) !== JSON.stringify(afterRaw.get(id).visibleStates)) {
      fail('incomplete_pages', 'Click&Boat 非取消状态或金额在核验期间变化');
    }
  }
  return orders.map(record => {
    const latest = afterRecords.get(record.booking_id);
    // The cancellation parser supplies no amount; never retain earlier paid metadata.
    return latest.status === 'cancelled' ? applyClickAndBoatPaymentEvidence(latest) : record;
  });
}

function assertDetailIdentity(expected, actual) {
  if (!actual || ['booking_id', 'url', 'boataround_slug', 'start', 'end'].some(key => actual[key] !== expected[key])) {
    fail('incomplete_pages', 'Click&Boat 详情身份、船只或日期在同步时变化');
  }
}

/** Self-contained for Puppeteer: inactive details need no financial section. */
export function clickAndBoatDetailReady() {
  const lines = String(document.body?.innerText ?? '').split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const headings = lines.map((line, index) => /^Booking N[°º]\d+$/i.test(line) ? index : -1).filter(index => index >= 0);
  if (headings.length !== 1) return false;
  // Labels can render before their values. Do not end the loading wait while
  // the strict parser would only find the next label or an empty placeholder.
  const [values] = [label => lines.flatMap((line, index) => line.toUpperCase() === label ? [lines[index + 1] || ''] : [])];
  const dates = ['CHECK-IN', 'CHECK-OUT'].map(values);
  if (dates.some(entries => entries.length !== 1 || !/^\d{2}\/\d{2}\/\d{4}$/.test(entries[0]))) return false;
  const state = (lines[headings[0] + 1] || '').toUpperCase();
  if (state === 'ACCEPTED') {
    const amounts = values('NET AMOUNT (BOAT OWNER)');
    return amounts.length === 1 && /\d/.test(amounts[0]) &&
      !['CHECK-IN', 'CHECK-OUT', 'NET AMOUNT (BOAT OWNER)'].includes(amounts[0].toUpperCase());
  }
  return ['COMPLETED', 'CANCELED', 'CANCELLED', 'REFUSED', 'DECLINED', 'PENDING', 'AWAITING',
    'AWAITING-WEATHER', 'PENDING (DUE TO WEATHER CONDITIONS)'].includes(state);
}

async function readDetail(context, record) {
  diagnostic(context,'detail_ready');
  await waitForClickAndBoatCondition(context.page, clickAndBoatDetailReady, context);
  check(context);
  diagnostic(context,'detail_parse');
  const details = parseClickAndBoatDetail({bodyText: await context.page.evaluate(() => document.body.innerText),
    url: context.page.url(), boataround_slug: record.boataround_slug, verifiedAt: new Date().toISOString()});
  assertDetailIdentity(record, details);
  return details;
}

async function pricesResponse(page, record, context) {
  return page.waitForResponse(response => {
    try { const url = new URL(response.url()); return response.request().method() === 'GET' &&
      url.origin === 'https://www.clickandboat.com' && url.pathname === `/api/v6/booking/prices/${record.booking_id}`; } catch { return false; }
  }, {timeout: timeout(context, 30000)}).then(async response => {
    if (isAccessChallenge(response)) return {error_code:'challenge_required'};
    if (response.status() !== 200) return {error_code:response.status()===401?'auth_required':'fetch_failed'};
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers()['content-type'] || '')) return {error_code:'schema_changed'};
    const body = await response.buffer(); if (body.length > 65536) return {error_code:'schema_changed'};
    let parsed;try { parsed=JSON.parse(body.toString('utf8')); } catch { return {error_code:'schema_changed'}; }
    return {url: response.url(), status: response.status(), body: parsed};
  }).catch(() => ({error_code:'fetch_failed'}));
}

export async function collectClickAndBoat(context) {
  check(context);
  await context.page.setCacheEnabled(false);
  const before = await readCompleteList(context);
  let orders = [];
  // The user protects checkout day too; its current status must be refreshed.
  for (const record of before.records.filter(row => row.end >= context.fromDay)) {
    check(context);
    if (record.status !== 'accepted') { orders.push(record); continue; }
    const payment = pricesResponse(context.page, record, context);
    await navigateDetail(context, record.url);
    const details = await readDetail(context, record);
    if (details.status !== 'accepted') {
      // The already-caught response promise cannot delay an observed cancellation.
      orders.push(applyClickAndBoatPaymentEvidence(details));
      continue;
    }
    diagnostic(context,'detail_parse');
    const prices = await payment;
    // Payment may arrive after a cancellation. Re-read the current detail state
    // before applying positive evidence, preserving the same identity and dates.
    const currentDetails = await readDetail(context, record);
    if (currentDetails.status==='accepted'&&prices?.error_code) {
      diagnostic(context,'detail_parse',prices.error_code);
      fail(prices.error_code,'Click&Boat 客户付款接口未通过核验');
    }
    orders.push(applyClickAndBoatPaymentEvidence(currentDetails, prices));
  }
  const manualListed = before.records.find(record => record.booking_id === MANUAL_OBSERVATION_ID);
  if (!manualListed) fail('incomplete_pages', 'Click&Boat 人工改期订单未出现在完整列表，保留上次订单并等待核查');
  check(context);
  await navigateDetail(context, manualListed.url);
  let manualDetail = await readDetail(context, manualListed);
  // A clear cancellation in either the current detail or full list wins. Other
  // known statuses/dates are evidence for the registry to review, not payment.
  if (manualListed.status === 'cancelled') manualDetail = manualListed;
  const after = await readCompleteList(context);
  diagnostic(context,'final_recheck');
  const reconciled = reconcileCancelledOrders(before, after, [...orders, manualDetail]);
  manualDetail = reconciled.pop();
  orders = reconciled.map(record => record.booking_id === manualDetail.booking_id && manualDetail.status === 'cancelled' ?
    applyClickAndBoatPaymentEvidence(manualDetail) : record);
  check(context);
  return {source: 'clickandboat', run_id: crypto.randomUUID(), checked_at: new Date().toISOString(), complete: true,
    scope: {kind: 'current_future', from_day: context.fromDay, fleet_slugs: FLEET.map(boat => boat.slug)},
    expected_count: orders.length, orders,
    manual_order_observations: [{booking_id: manualDetail.booking_id, boataround_slug: manualDetail.boataround_slug,
      platform_status: manualDetail.platform_status, start: manualDetail.start, end: manualDetail.end,
      checked_at: manualDetail.verified_at, detail_url: manualDetail.url}],
    pagination: {complete: true, total_pages: before.totalPages, pages_read: Array.from({length: before.totalPages}, (_, index) => index + 1), listed_count: before.records.length}};
}
