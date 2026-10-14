// NauSYS as the fifth order source (user decision 2026-10-09, AGENTS.md 6.4).
// Read-only: NauSYS's reservation list in the phone's normal Chrome, searched
// with the page's own form (all types, ending yesterday or later) twice.
// Only bookings an agency made count: the list names the creator, and copies
// that our own users entered from other platforms are not new orders. Option
// and Reservation count without payment; Information (an enquiry) does not.
// Client names and contact details are not read into the snapshot.
import {NausysClient, NAUSYS_FLEET, NAUSYS_LIST_URL} from '../reverse-sync/nausys-client.mjs';
import {FLEET, OrderParseError} from '../parsers.mjs';

// NauSYS opens a reservation in a dialog of the list page and has no link to
// a single reservation; the order card links to the list.
export const NAUSYS_ORDER_URL = NAUSYS_LIST_URL;
export const NAUSYS_PAYMENT_BASIS = 'nausys_agency';
// The list shows no price. Since 2026-10-10 each agency order's dialog is read
// for its "Agency price" (Client price − Commission), the owner's net like MMK.
export const NAUSYS_AMOUNT_BASIS = '船东净收入（NauSYS 代理价：客户价减代理佣金）';
export const NAUSYS_AMOUNT_MISSING = 'NauSYS 代理价没读到，未计入';
// The creator column for a booking made through the agency network.
const AGENCY = 'Agency';
// An Option's "valid till" is shown without a time zone. Treat it as expired
// only a full day later, so a different zone can never open dates early.
const EXPIRY_MARGIN_MS = 24 * 3600000;
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const dmy = value => {
  const m = typeof value === 'string' && value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const iso = m[3] + '-' + m[2] + '-' + m[1];
  return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : null;
};
const dmyTime = value => {
  const m = typeof value === 'string' && value.match(/^(\d{2}\.\d{2}\.\d{4}) (\d{2}):(\d{2})$/);
  const day = m && dmy(m[1]);
  return day && Number(m[2]) < 24 && Number(m[3]) < 60 ? Date.parse(day + 'T' + m[2] + ':' + m[3] + ':00Z') : null;
};
export const nausysDay = date => date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);

/** One list row → an order, null when it is not an agency order, or
 * {unmapped} for an agency order on a yacht the dashboard does not have. */
export function nausysOrder(row, verifiedAt, now = Date.parse(verifiedAt)) {
  // Every row names its creator. A missing one means the cell changed: fail
  // rather than quietly treat every agency order as "not an order".
  if (typeof row?.creator !== 'string' || !row.creator.trim()) throw new OrderParseError('NAUSYS_CREATOR', 'NauSYS 订单创建者栏无法识别');
  const type = String(row.type || '').trim().replace(/\s+/g, ' ').toUpperCase();
  // A cancelled row names whoever cancelled it, not who made it: NauSYS's
  // "Administrator" cancelled the lapsed agency Option at 00:06 on
  // 2026-10-12. Its cancellation is still evidence about that reservation
  // number, so every cancelled row is reported. It never counts as an order,
  // and it only opens dates the program closed for that same number.
  const cancelledRow = /^CANCEL+ED( \([A-Z]\))?$/.test(type);
  if (row.creator !== AGENCY && !cancelledRow) return null;
  if (cancelledRow && row.creator !== AGENCY) {
    // Someone else's cancelled row with an unexpected shape is left out
    // rather than failing the whole read; missing evidence keeps dates closed.
    const start = dmy(row.from), end = dmy(row.to);
    const yacht = NAUSYS_FLEET.filter(item => item.name === row.name && item.model === row.model);
    if (!/^\d+$/.test(String(row.id || '')) || !start || !end || end <= start || yacht.length !== 1 || !yacht[0].boat) return null;
  }
  if (type === 'INFORMATION') return null;
  let status, label;
  if (type === 'RESERVATION') { status = 'accepted'; label = 'Reservation'; }
  else if (type === 'OPTION') {
    const expiry = dmyTime(row.expiry), created = dmyTime(row.created);
    if (expiry === null) throw new OrderParseError('NAUSYS_OPTION', 'NauSYS Option 有效期格式变化');
    // Valid-till and created are told apart only by position; a swap would
    // expire live Options a day after they were made.
    if (created === null || expiry < created) throw new OrderParseError('NAUSYS_OPTION', 'NauSYS Option 有效期和创建时间无法区分');
    [status, label] = now > expiry + EXPIRY_MARGIN_MS ? ['cancelled', 'Option expired'] : ['accepted', 'Option'];
  } else if (cancelledRow) { status = 'cancelled'; label = 'Canceled'; }
  else throw new OrderParseError('NAUSYS_TYPE', 'NauSYS 订单类型无法识别');
  if (!/^\d+$/.test(String(row.id || ''))) throw new OrderParseError('NAUSYS_ID', 'NauSYS 订单编号格式变化');
  const start = dmy(row.from), end = dmy(row.to);
  if (!start || !end || end <= start) throw new OrderParseError('NAUSYS_DATES', 'NauSYS 订单日期格式变化');
  const yacht = NAUSYS_FLEET.filter(item => item.name === row.name && item.model === row.model);
  if (yacht.length !== 1) throw new OrderParseError('NAUSYS_YACHT', 'NauSYS 船名无法识别');
  if (!yacht[0].boat) return {unmapped: true, end};
  return {source: 'nausys', booking_id: row.id, boataround_slug: yacht[0].boat, start, end,
    status, platform_status: label, url: NAUSYS_ORDER_URL, amount: null, amount_basis: NAUSYS_AMOUNT_MISSING,
    verified_at: verifiedAt,
    verification_source: 'NauSYS 订单列表：代理下的 Option 或 Reservation 算有效订单，不看付款',
    ...(status === 'accepted' ? {payment_basis: NAUSYS_PAYMENT_BASIS} : {})};
}

/** A dialog read → the order's amount ("€1,234.00"), or null. Only euros;
 * the dialog must be this order (ID, status, dates) and its three prices must
 * agree, otherwise nothing is guessed. */
export function nausysAmount(order, read) {
  if (!read || read.id !== order.booking_id || !['OPTION', 'RESERVATION'].includes(read.status) || dmy(read.from) !== order.start || dmy(read.to) !== order.end) return null;
  const {client, commission, agency} = read;
  if ([client, commission, agency].some(p => !p || p.symbol !== '€' || typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0)) return null;
  if (!(agency.value > 0) || Math.abs(client.value - commission.value - agency.value) > 0.011) return null;
  const [whole, cents] = agency.value.toFixed(2).split('.');
  return '€' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + cents;
}

const errorCode = error => {
  if (error?.name === 'OrderParseError') return 'schema_changed';
  if (['auth_required', 'fetch_failed', 'schema_changed', 'incomplete_pages'].includes(error?.code)) return error.code;
  const message = String(error?.message || '');
  if (['nausys_auth_required', 'nausys_account_mismatch'].includes(message)) return 'auth_required';
  if (message === 'nausys_list_incomplete') return 'incomplete_pages';
  if (['nausys_filters_set', 'nausys_search_form_changed'].includes(message)) return 'schema_changed';
  return 'fetch_failed';
};
const manifest = rows => JSON.stringify(rows.map(row => [row.id, row.type, row.expiry, row.creator, row.name, row.from, row.to])
  .sort((a, b) => a[0].localeCompare(b[0])));

export async function collectNausys({page, fromDay, signal, reportDiagnostic = () => {}}, {recoverLogin = null, now = Date.now, sleep} = {}) {
  const check = () => { if (signal?.aborted) fail('fetch_failed', 'NauSYS 读取已停止'); };
  const client = new NausysClient(page, {recoverLogin: recoverLogin ? async target => {
    reportDiagnostic({stage: 'login_recovery', reason: 'progress'});
    await recoverLogin(target);
  } : null, isCancelled: () => signal?.aborted === true, ...(sleep ? {sleep} : {})});
  try {
    check();
    reportDiagnostic({stage: 'list_navigation', reason: 'progress'});
    await client.open();
    check();
    const first = await client.search(nausysDay(fromDay));
    reportDiagnostic({stage: 'list_ready', reason: 'progress'});
    check();
    reportDiagnostic({stage: 'final_recheck', reason: 'progress'});
    const second = await client.search(nausysDay(fromDay));
    if (manifest(first) !== manifest(second)) fail('incomplete_pages', 'NauSYS 订单在读取期间变化，保留上次订单');
    const stamp = new Date(now()).toISOString();
    reportDiagnostic({stage: 'detail_parse', reason: 'progress'});
    const current = first.map(row => nausysOrder(row, stamp, now())).filter(order => order && order.end >= fromDay);
    if (current.some(order => order.unmapped)) fail('schema_changed', 'NauSYS 有代理订单在看板没有的船上，保留上次订单');
    const orders = current.sort((a, b) => a.booking_id.localeCompare(b.booking_id));
    // Amounts only after both searches agreed. A dialog that cannot be read
    // leaves that amount missing; it never changes which orders count.
    reportDiagnostic({stage: 'amounts', reason: 'progress'});
    // At most a minute for all dialogs (about 4 s each, 2026-10-10): the
    // phone's whole NauSYS read must stay well inside its time limit, and a
    // late amount is only left missing.
    const amountsUntil = now() + 60000;
    for (const order of orders) {
      if (order.status !== 'accepted') continue;
      if (now() > amountsUntil) break;
      check();
      let read = null;
      try { read = await client.dialogPrice(order.booking_id); }
      catch (error) {
        if (signal?.aborted || error?.message === 'phone_shutdown') throw error;
        // A dialog left open would block the next ones; the rest stay missing.
        if (error?.message === 'nausys_dialog_not_closed') break;
      }
      const amount = nausysAmount(order, read);
      if (amount) Object.assign(order, {amount, amount_basis: NAUSYS_AMOUNT_BASIS});
    }
    check();
    reportDiagnostic({stage: 'final_recheck', reason: 'complete'});
    return {source: 'nausys', run_id: crypto.randomUUID(), checked_at: stamp, complete: true,
      scope: {kind: 'current_future', from_day: fromDay, fleet_slugs: FLEET.map(boat => boat.slug)},
      expected_count: orders.length, orders,
      pagination: {complete: true, total_pages: 1, pages_read: [1], listed_count: first.length}};
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {code: errorCode(error)});
  }
}
