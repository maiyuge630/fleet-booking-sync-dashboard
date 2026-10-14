// NauSYS as the fifth order source (user decision 2026-10-09). Rows below are
// shaped like the live list read on 2026-10-09 (client names left out).
import test from 'node:test';
import assert from 'node:assert/strict';
import {nausysOrder, collectNausys, nausysDay, nausysAmount, NAUSYS_ORDER_URL, NAUSYS_AMOUNT_BASIS, NAUSYS_AMOUNT_MISSING} from './nausys.mjs';
import {nausysEntryState, nausysSignedInAs, startNausysSearch, nausysSearchDone, nausysRows, nausysScrollTable,
  openListDialog, nausysDialogPrice, leaveNausysDialog} from '../reverse-sync/nausys-client.mjs';

const NOW = Date.parse('2026-10-09T22:00:00Z'), STAMP = new Date(NOW).toISOString();
const row = (id, change = {}) => ({id, shown_id: id, type: 'OPTION', expiry: '12.10.2026 23:59', created: '09.10.2026 13:09', creator: 'Agency',
  model: 'Grandcat 55', name: 'Tidewyn Discovery 5', from: '27.02.2027', to: '06.03.2027', ...change});
const copy = (id, change = {}) => row(id, {type: 'RESERVATION', expiry: null, created: '01.10.2026 05:53', creator: 'DEMO COLLEAGUE', ...change});

test('an agency Option or Reservation is an order; Information, our own copies and the Administrator are not', () => {
  const option = nausysOrder(row('952814834'), STAMP, NOW);
  assert.deepEqual(option, {source: 'nausys', booking_id: '952814834', boataround_slug: 'grandcat-55-tidewyn-discovery-5', start: '2027-02-27', end: '2027-03-06',
    status: 'accepted', platform_status: 'Option', url: NAUSYS_ORDER_URL, amount: null, amount_basis: NAUSYS_AMOUNT_MISSING, verified_at: STAMP,
    verification_source: 'NauSYS 订单列表：代理下的 Option 或 Reservation 算有效订单，不看付款', payment_basis: 'nausys_agency'});
  assert.equal(nausysOrder(row('1', {type: 'RESERVATION', expiry: null}), STAMP, NOW).platform_status, 'Reservation');
  assert.equal(nausysOrder(row('2', {type: 'INFORMATION', expiry: null}), STAMP, NOW), null);
  for (const creator of ['DEMO COLLEAGUE', 'USER DEMO', 'Administrator', 'agency']) assert.equal(nausysOrder(row('3', {creator}), STAMP, NOW), null, String(creator));
  assert.equal(nausysOrder(copy('952517762'), STAMP, NOW), null);
  // A creator cell that cannot be read fails the read instead of dropping orders (2026-10-10).
  for (const creator of ['', '  ', null, undefined]) assert.throws(() => nausysOrder(row('3', {creator}), STAMP, NOW), /创建者/, String(creator));
  // A valid-till earlier than the creation time means the two were swapped.
  assert.throws(() => nausysOrder(row('4', {expiry: '08.10.2026 10:00', created: '09.10.2026 13:09'}), STAMP, NOW), /有效期/);
  assert.throws(() => nausysOrder(row('5', {created: null}), STAMP, NOW), /有效期/);
});

test('the four NauSYS yachts map to the dashboard (the Lightcat is its eighth boat); an unknown name fails', () => {
  assert.equal(nausysOrder(row('1', {model: 'R-Cat 37', name: 'Tidewyn Discovery'}), STAMP, NOW).boataround_slug, 'reef-cat-37-tidewyn-discovery');
  assert.equal(nausysOrder(row('2', {model: 'Seacat 40 Open - 4 + 1 cab.', name: 'Tidewyn Discovery 2'}), STAMP, NOW).boataround_slug, 'seacat-open-40-tidewyn-discovery-2');
  assert.equal(nausysOrder(row('3', {model: 'Lightcat 400 S2', name: 'Tidewyn Discovery 6'}), STAMP, NOW).boataround_slug, 'lightcat-400-s2-tidewyn-discovery-6');
  assert.throws(() => nausysOrder(row('4', {name: 'Tidewyn Discovery 9'}), STAMP, NOW), /船名/);
  assert.throws(() => nausysOrder(row('5', {model: 'Grandcat 56'}), STAMP, NOW), /船名/);
});

test('cancellation is explicit; an Option counts as expired only a full day after its valid-till time', () => {
  for (const type of ['CANCELED (R)', 'CANCELED (O)', 'CANCELED', 'CANCELLED']) {
    const order = nausysOrder(row('1', {type, expiry: null}), STAMP, NOW);
    assert.deepEqual([order.status, order.platform_status, order.payment_basis], ['cancelled', 'Canceled', undefined], type);
  }
  const at = value => nausysOrder(row('2', {expiry: '12.10.2026 23:59'}), STAMP, Date.parse(value));
  assert.equal(at('2026-10-13T23:59:00Z').status, 'accepted');
  assert.deepEqual([at('2026-10-14T00:00:00Z').status, at('2026-10-14T00:00:00Z').platform_status], ['cancelled', 'Option expired']);
  assert.throws(() => nausysOrder(row('3', {expiry: null}), STAMP, NOW), /有效期/);
  assert.throws(() => nausysOrder(row('4', {type: 'BOOKING'}), STAMP, NOW), /类型/);
});

test('a cancelled row counts as a cancellation whoever it names; it is never an order (2026-10-12)', () => {
  // NauSYS names whoever cancelled: the lapsed agency Option 952784750 showed
  // "CANCELED (O) 12.10.2026 00:06 Administrator" and was dropped as "not an agency order".
  const lapsed = row('952784750', {type: 'CANCELED (O)', expiry: null, created: '12.10.2026 00:06', creator: 'Administrator',
    model: 'R-Cat 37', name: 'Tidewyn Discovery', from: '11.12.2026', to: '18.12.2026'});
  const order = nausysOrder(lapsed, STAMP, NOW);
  assert.deepEqual([order.booking_id, order.boataround_slug, order.start, order.end, order.status, order.platform_status, order.payment_basis],
    ['952784750', 'reef-cat-37-tidewyn-discovery', '2026-12-11', '2026-12-18', 'cancelled', 'Canceled', undefined]);
  for (const creator of ['USER DEMO', 'DEMO COLLEAGUE']) assert.equal(nausysOrder(copy('952836985', {type: 'CANCELED (R)', creator}), STAMP, NOW).status, 'cancelled', creator);
  // Someone else's cancelled row of an unexpected shape is left out, not a failed read.
  for (const change of [{name: 'Tidewyn Discovery 9'}, {from: '31.02.2027'}, {id: 'A1'}])
    assert.equal(nausysOrder(row('5', {type: 'CANCELED (O)', expiry: null, creator: 'Administrator', ...change}), STAMP, NOW), null, JSON.stringify(change));
  // Live rows from anyone but the agency are still not orders.
  for (const type of ['OPTION', 'RESERVATION']) assert.equal(nausysOrder(row('6', {type, creator: 'Administrator'}), STAMP, NOW), null, type);
});

test('dates and IDs are strict', () => {
  for (const change of [{from: '27.02.2027', to: '27.02.2027'}, {from: '31.02.2027'}, {to: '2027-03-06'}, {from: null}])
    assert.throws(() => nausysOrder(row('1', change), STAMP, NOW), /日期/, JSON.stringify(change));
  assert.throws(() => nausysOrder(row('A1'), STAMP, NOW), /编号/);
  assert.equal(nausysDay('2026-10-08'), '08.10.2026');
});

// A reservation's dialog as read on 2026-10-10 (an agency Option on AD1).
const priced = (id, from, to, change = {}) => ({ready: true, id, status: 'OPTION', from, to, client: {value: 4387, symbol: '€'},
  commission: {value: 615, symbol: '€'}, agency: {value: 3772, symbol: '€'}, ...change});
function page(reads, {entry = ['ready'], signedIn = true, started = {ok: true}, dialogs = {}, stuck = false} = {}) {
  const calls = [];let read = 0, entries = 0, open = null;
  const frame = {url: () => 'https://app.nausys.com/NauSYS-app/app/yachtReservationDialog.xhtml?YachtReservationId=' + open, waitForFunction: async () => {},
    evaluate: async fn => {
      if (fn === nausysDialogPrice) return dialogs[open];
      if (fn === leaveNausysDialog) { calls.push('leave ' + open); if (!stuck) open = null; return true; }
      throw Error('unexpected dialog call');
    }};
  return {calls, goto: async url => calls.push('goto ' + url), waitForFunction: async () => {}, url: () => NAUSYS_ORDER_URL,
    frames: () => open ? [frame] : [],
    evaluate: async (fn, arg) => {
      if (fn === nausysEntryState) return entry[Math.min(entries++, entry.length - 1)];
      if (fn === nausysSignedInAs) { calls.push('user ' + arg); return signedIn; }
      if (fn === startNausysSearch) { calls.push('search ' + arg); return started; }
      if (fn === nausysSearchDone) return true;
      if (fn === nausysRows) return reads[Math.min(read++, reads.length - 1)];
      if (fn === nausysScrollTable) { calls.push('scroll'); return true; }
      if (fn === openListDialog) { calls.push('dialog ' + arg); open = arg; return true; }
      throw Error('unexpected page call');
    }};
}
const list = rows => ({rows, limit: rows.length, empty: false});
const context = (p, fromDay = '2026-10-09') => ({page: p, fromDay, signal: new AbortController().signal});
const fast = async () => {};

test('a collection searches twice with the same result and uploads only current agency orders', async () => {
  const rows = [row('952814834'), copy('952517762'), row('952824388', {type: 'INFORMATION', expiry: null}),
    row('9', {type: 'CANCELED (R)', expiry: null, from: '09.05.2026', to: '16.05.2026'}), row('952784750', {model: 'R-Cat 37', name: 'Tidewyn Discovery', from: '11.12.2026', to: '18.12.2026', expiry: '11.10.2026 23:59'})];
  const p = page([list(rows)]);
  const snapshot = await collectNausys(context(p), {now: () => NOW, sleep: fast});
  assert.deepEqual(snapshot.orders.map(o => [o.booking_id, o.status, o.platform_status]), [['952784750', 'accepted', 'Option'], ['952814834', 'accepted', 'Option']]);
  assert.equal(snapshot.complete, true);assert.equal(snapshot.expected_count, 2);assert.equal(snapshot.pagination.listed_count, 5);
  assert.equal(snapshot.scope.fleet_slugs.length, 8);
  // After both searches agree, each current agency order's dialog is read and left.
  assert.deepEqual(p.calls.filter(c => !c.startsWith('goto')), ['user DEMO, USER', 'search 09.10.2026', 'search 09.10.2026',
    'dialog 952784750', 'leave 952784750', 'dialog 952814834', 'leave 952814834']);
  // No dialog data: the amounts stay missing and the orders still count.
  assert.deepEqual(snapshot.orders.map(o => [o.amount, o.amount_basis]), [[null, NAUSYS_AMOUNT_MISSING], [null, NAUSYS_AMOUNT_MISSING]]);
});

test('the agency price is the amount when the dialog is this order and its prices agree (2026-10-10)', async () => {
  const rows = [row('952784750', {model: 'R-Cat 37', name: 'Tidewyn Discovery', from: '11.12.2026', to: '18.12.2026', expiry: '11.10.2026 23:59'}),
    row('952814834'), row('952814835', {to: '07.03.2027'}), row('9', {type: 'CANCELED (R)', expiry: null})];
  const dialogs = {'952784750': priced('952784750', '11.12.2026', '18.12.2026'),
    // Wrong dates in the dialog, and prices that do not add up: no amount.
    '952814834': priced('952814834', '27.02.2027', '07.03.2027'),
    '952814835': priced('952814835', '27.02.2027', '07.03.2027', {agency: {value: 3800, symbol: '€'}})};
  const p = page([list(rows)], {dialogs});
  const snapshot = await collectNausys(context(p), {now: () => NOW, sleep: fast});
  // The cancelled order is still uploaded (cancellation must be explicit), without an amount.
  assert.deepEqual(snapshot.orders.map(o => [o.booking_id, o.status, o.amount, o.amount_basis]), [['9', 'cancelled', null, NAUSYS_AMOUNT_MISSING],
    ['952784750', 'accepted', '€3,772.00', NAUSYS_AMOUNT_BASIS], ['952814834', 'accepted', null, NAUSYS_AMOUNT_MISSING], ['952814835', 'accepted', null, NAUSYS_AMOUNT_MISSING]]);
  assert.ok(!p.calls.includes('dialog 9'), 'a cancelled order is not opened');
  // A dialog that does not close stops further dialogs; the read still completes.
  const stuck = page([list(rows)], {dialogs, stuck: true});
  const partial = await collectNausys(context(stuck), {now: () => NOW, sleep: fast});
  assert.equal(partial.complete, true); assert.equal(partial.orders.length, 4);
  assert.deepEqual(stuck.calls.filter(c => c.startsWith('dialog')), ['dialog 952784750']);
  assert.ok(partial.orders.every(o => o.amount === null));
});

test('the lapsed Option cancelled by NauSYS is uploaded as cancelled, so its closures can open (2026-10-12)', async () => {
  const rows = [row('952784750', {type: 'CANCELED (O)', expiry: null, created: '12.10.2026 00:06', creator: 'Administrator',
    model: 'R-Cat 37', name: 'Tidewyn Discovery', from: '11.12.2026', to: '18.12.2026'}), row('952814834'), copy('952517762', {type: 'CANCELED (R)'})];
  const p = page([list(rows)]);
  const snapshot = await collectNausys(context(p), {now: () => Date.parse('2026-10-12T01:19:00Z'), sleep: fast});
  assert.deepEqual(snapshot.orders.map(o => [o.booking_id, o.status, o.platform_status]),
    [['952517762', 'cancelled', 'Canceled'], ['952784750', 'cancelled', 'Canceled'], ['952814834', 'accepted', 'Option']]);
  assert.ok(!p.calls.includes('dialog 952784750'), 'a cancelled order is not opened');
});

test('an amount is never guessed: other currencies, other reservations or missing prices give none', () => {
  const order = {booking_id: '1', start: '2026-12-11', end: '2026-12-18'};
  assert.equal(nausysAmount(order, priced('1', '11.12.2026', '18.12.2026')), '€3,772.00');
  assert.equal(nausysAmount(order, priced('1', '11.12.2026', '18.12.2026', {status: 'RESERVATION'})), '€3,772.00');
  for (const change of [{id: '2'}, {status: 'CANCELED (R)'}, {from: '12.12.2026'}, {agency: {value: 3772, symbol: '$'}}, {commission: null},
    {agency: {value: 0, symbol: '€'}, client: {value: 615, symbol: '€'}}, {client: {value: 4400, symbol: '€'}}])
    assert.equal(nausysAmount(order, priced('1', '11.12.2026', '18.12.2026', change)), null, JSON.stringify(change));
  assert.equal(nausysAmount(order, null), null);
  assert.equal(nausysAmount({...order, booking_id: '2'}, priced('2', '11.12.2026', '18.12.2026', {client: {value: 1234567.89, symbol: '€'}, commission: {value: 0, symbol: '€'}, agency: {value: 1234567.89, symbol: '€'}})), '€1,234,567.89');
});

test('the dialog price block is read as NauSYS shows it (text of 2026-10-10, no client fields)', () => {
  const text = 'Price calculation Discounts: Empty Client price: 4.387,00 € Commission base: 4.100,00 € Commission: 15% 615,00 € Agency price: 3.772,00 € Extras payable in advance: 1.530,00 € Total client price: 5.917,00 € Total advanced payment: 5.302,00 €';
  const saved = {document: globalThis.document, PrimeFaces: globalThis.PrimeFaces, window: globalThis.window};
  try {
    globalThis.window = globalThis;
    globalThis.PrimeFaces = {ajax: {Queue: {isEmpty: () => true}}};
    globalThis.document = {body: {innerText: text}, querySelector: () => ({innerText: '952784750 OPTION 11.12.2026 18.12.2026 R-Cat 37 - Tidewyn Discovery - 2015. Phuket'})};
    assert.deepEqual(nausysDialogPrice(), {ready: true, id: '952784750', status: 'OPTION', from: '11.12.2026', to: '18.12.2026',
      client: {value: 4387, symbol: '€'}, commission: {value: 615, symbol: '€'}, agency: {value: 3772, symbol: '€'}});
    globalThis.document.body.innerText = 'Commission: 14,02% 927,06 € Client price: 6.613,00 € Agency price: 5.685,94 €';
    assert.deepEqual(nausysDialogPrice().commission, {value: 927.06, symbol: '€'});
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

test('a list that changes between the two searches, or loads short, keeps the last orders', async () => {
  await assert.rejects(collectNausys(context(page([list([row('1')]), list([row('1', {to: '07.03.2027'})])])), {now: () => NOW, sleep: fast}), e => e.code === 'incomplete_pages');
  const short = page([{rows: [row('1')], limit: 2, empty: false}]);
  await assert.rejects(collectNausys(context(short), {now: () => NOW, sleep: fast}), e => e.code === 'incomplete_pages');
  assert.ok(short.calls.filter(c => c === 'scroll').length > 0, 'it tried to load the remaining rows');
  await assert.rejects(collectNausys(context(page([list([row('1', {shown_id: '2'})])])), {now: () => NOW, sleep: fast}), e => e.code === 'incomplete_pages');
});

test('more rows load by scrolling until the count matches', async () => {
  const all = [row('1'), row('2', {type: 'RESERVATION', expiry: null})];
  const p = page([{rows: [all[0]], limit: 2, empty: false}, list(all), list(all)]);
  const snapshot = await collectNausys(context(p), {now: () => NOW, sleep: fast});
  assert.equal(snapshot.orders.length, 2);assert.equal(p.calls.filter(c => c === 'scroll').length, 1);
});

test('an agency order on the Lightcat is uploaded; an unknown agency type, a filter or a wrong user fails the read', async () => {
  const lightcat = await collectNausys(context(page([list([row('1', {model: 'Lightcat 400 S2', name: 'Tidewyn Discovery 6'})])])), {now: () => NOW, sleep: fast});
  assert.deepEqual(lightcat.orders.map(o => o.boataround_slug), ['lightcat-400-s2-tidewyn-discovery-6']);
  await assert.rejects(collectNausys(context(page([list([row('1', {type: 'BOOKING'})])])), {now: () => NOW, sleep: fast}), e => e.code === 'schema_changed');
  await assert.rejects(collectNausys(context(page([list([])], {started: {ok: false, reason: 'filters'}})), {now: () => NOW, sleep: fast}), e => e.code === 'schema_changed');
  await assert.rejects(collectNausys(context(page([list([])], {signedIn: false})), {now: () => NOW, sleep: fast}), e => e.code === 'auth_required');
  // A past order is out of scope.
  const past = await collectNausys(context(page([list([row('1', {model: 'Lightcat 400 S2', name: 'Tidewyn Discovery 6', from: '01.05.2026', to: '08.05.2026'})])])), {now: () => NOW, sleep: fast});
  assert.deepEqual(past.orders, []);
});

test('an expired login is recovered once through the saved password, then the user is checked', async () => {
  let recovered = 0;
  const p = page([list([row('1')])], {entry: ['login', 'ready']});
  await collectNausys(context(p), {recoverLogin: async () => { recovered++; }, now: () => NOW, sleep: fast});
  assert.equal(recovered, 1);
  await assert.rejects(collectNausys(context(page([list([])], {entry: ['login']})), {now: () => NOW, sleep: fast}), e => e.code === 'auth_required');
  await assert.rejects(collectNausys(context(page([list([])], {entry: ['login']})), {recoverLogin: async () => {}, now: () => NOW, sleep: fast}), e => e.code === 'auth_required');
});
