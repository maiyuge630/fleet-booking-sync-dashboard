// MMK (Booking Manager) as the fourth order source (user decision 2026-10-04).
// Read-only: the same editor page and ReservationsAPI the calendar adapter
// already uses, in the phone's normal Chrome. An MMK order is a Reservation or
// Option that has a customer and is not one of our own TidewynSync blocks.
// Payment is not required. Customer-free records (maintenance, owner use,
// colleagues' manual blocks) are not orders and are never uploaded. Customer
// names and contact details are not read into the snapshot.
import {MmkClient} from '../reverse-sync/mmk-client.mjs';
import {MMK_FLEET} from '../reverse-sync/mmk-plan.mjs';
import {FLEET, OrderParseError} from '../parsers.mjs';

export const MMK_ORDER_URL = 'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp?reservationId=';
export const MMK_PAYMENT_BASIS = 'mmk_client_assigned';
// Like Boataround and Click&Boat, the owner's net: MMK's final price less the
// agency commission (15 % on the 2026-10-04 orders).
export const MMK_AMOUNT_BASIS = '船东净收入（最终价格减代理佣金）';
const MARKER = 'TidewynSync:';
// statusId → label and normalized status. Only these four are orders' states;
// Offer, Service, Owner week, Custom, Regatta, Sleep aboard and Credit are not.
export const MMK_ORDER_STATUSES = Object.freeze({
  '1': {label: 'Reservation', status: 'accepted'},
  '2': {label: 'Option', status: 'accepted'},
  '3': {label: 'Option expired', status: 'cancelled'},
  '5': {label: 'Canceled', status: 'cancelled'}
});
const SYMBOLS = {EUR: '€', USD: '$'};
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) &&
  new Date(value.replace(' ', 'T') + 'Z').toISOString().slice(0, 19).replace('T', ' ') === value;
const nextDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
// Read 2026-10-04: `currency` holds MMK's internal currency number ("0");
// the ISO code is `currencyCode` ("EUR"). The commission is a decimal string.
// A missing or unreadable price or commission gives no amount: it is listed
// as missing on the dashboard, never guessed.
function money(model) {
  const symbol = SYMBOLS[model.currencyCode];
  const commission = typeof model.commissionsValue === 'string' && /^\d+(?:\.\d+)?$/.test(model.commissionsValue) ? Number(model.commissionsValue) :
    typeof model.commissionsValue === 'number' && Number.isFinite(model.commissionsValue) && model.commissionsValue >= 0 ? model.commissionsValue : null;
  if (!symbol || commission === null || typeof model.finalPrice !== 'number' || !Number.isFinite(model.finalPrice) || model.finalPrice <= 0) return null;
  const net = Math.round((model.finalPrice - commission) * 100) / 100;
  if (!(net > 0) || net > model.finalPrice) return null;
  const [whole, cents] = net.toFixed(2).split('.');
  return symbol + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + cents;
}

/** One MMK reservation model → an order, or null when it is not an order. */
export function mmkOrder(model, verifiedAt) {
  if ([model?.bookingOrigin, model?.internalRemarks].some(value => typeof value === 'string' && value.startsWith(MARKER))) return null;
  if (typeof model?.clientId !== 'string' || !model.clientId || model.clientId === '-1') return null;
  const state = MMK_ORDER_STATUSES[model.statusId];
  if (!state) return null;
  // An order on a yacht this program does not know (e.g. a boat newly added
  // in MMK) must not vanish silently: collectMmk fails the read for a current
  // or future one, which keeps the last complete orders.
  const mapping = MMK_FLEET.find(boat => boat.listing_id === model?.yacht?.id);
  if (!mapping) return {unmapped: true, end: typeof model.checkOutDate === 'string' ? model.checkOutDate.slice(0, 10) : '9999-12-31'};
  if (typeof model.id !== 'string' || !/^\d+$/.test(model.id)) throw new OrderParseError('MMK_ID', 'MMK 订单编号格式变化');
  if (!timestamp(model.checkInDate) || !timestamp(model.checkOutDate) || model.checkOutDate <= model.checkInDate)
    throw new OrderParseError('MMK_DATES', 'MMK 订单日期格式变化');
  const start = model.checkInDate.slice(0, 10);
  // A same-day charter occupies its day; protect it like a one-night stay.
  const end = model.checkOutDate.slice(0, 10) > start ? model.checkOutDate.slice(0, 10) : nextDay(start);
  const amount = state.status === 'accepted' ? money(model) : null;
  return {source: 'mmk', booking_id: model.id, boataround_slug: mapping.boat, start, end,
    status: state.status, platform_status: state.label, url: MMK_ORDER_URL + model.id,
    amount, amount_basis: MMK_AMOUNT_BASIS, verified_at: verifiedAt,
    verification_source: 'MMK 预订详情：有客户的 Reservation 或 Option 算有效订单，不看付款',
    ...(state.status === 'accepted' ? {payment_basis: MMK_PAYMENT_BASIS} : {})};
}

const errorCode = error => {
  if (error?.name === 'OrderParseError') return 'schema_changed';
  if (['auth_required', 'fetch_failed', 'schema_changed', 'incomplete_pages'].includes(error?.code)) return error.code;
  const message = String(error?.message || '');
  if (message === 'mmk_auth_required' || message === 'mmk_account_mismatch') return 'auth_required';
  if (['mmk_list_incomplete', 'mmk_duplicate_page', 'mmk_empty_page', 'mmk_page_limit'].includes(message)) return 'incomplete_pages';
  return 'fetch_failed';
};
const manifest = rows => JSON.stringify(rows.map(row => [row.id, row.status]).sort((a, b) => a[0].localeCompare(b[0])));

export async function collectMmk({page, fromDay, signal, reportDiagnostic = () => {}}, {recoverLogin = null, now = Date.now} = {}) {
  const check = () => { if (signal?.aborted) fail('fetch_failed', 'MMK 读取已停止'); };
  const client = new MmkClient(page, null, recoverLogin ? async target => {
    reportDiagnostic({stage: 'login_recovery', reason: 'progress'});
    await recoverLogin(target);
  } : null, () => signal?.aborted === true);
  try {
    check();
    reportDiagnostic({stage: 'list_navigation', reason: 'progress'});
    await client.open();
    check();
    const first = await client.list();
    reportDiagnostic({stage: 'list_ready', reason: 'progress'});
    check();
    // Read every record's details: the list row does not say which yacht or
    // customer it belongs to. The account holds only our three yachts.
    reportDiagnostic({stage: 'detail_parse', reason: 'progress'});
    const models = await client.getMany(first.map(row => row.id));
    check();
    reportDiagnostic({stage: 'final_recheck', reason: 'progress'});
    const second = await client.list();
    if (manifest(first) !== manifest(second)) fail('incomplete_pages', 'MMK 记录在读取期间变化，保留上次订单');
    const stamp = new Date(now()).toISOString();
    const current = models.map(model => mmkOrder(model, stamp)).filter(order => order && order.end >= fromDay);
    if (current.some(order => order.unmapped)) fail('schema_changed', 'MMK 有订单在未映射的船上，保留上次订单');
    const orders = current.sort((a, b) => a.booking_id.localeCompare(b.booking_id));
    check();
    reportDiagnostic({stage: 'final_recheck', reason: 'complete'});
    return {source: 'mmk', run_id: crypto.randomUUID(), checked_at: stamp, complete: true,
      scope: {kind: 'current_future', from_day: fromDay, fleet_slugs: FLEET.map(boat => boat.slug)},
      expected_count: orders.length, orders,
      pagination: {complete: true, total_pages: 1, pages_read: [1], listed_count: first.length}};
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {code: errorCode(error)});
  }
}
