import test from 'node:test';
import assert from 'node:assert/strict';
import {mmkOrder, collectMmk, MMK_ORDER_URL} from './mmk.mjs';
import {mmkEntryState} from '../reverse-sync/mmk-client.mjs';
import {FLEET} from '../parsers.mjs';

const AD1 = '1000000000000000001', AD2 = '1000000000000000002';
const at = '2026-10-04T08:00:00.000Z';
// Shape observed in MMK's reservation editor (09-26 read); customer fields only by id.
const model = (change = {}) => ({id: '8889178168337030369', statusId: '1', yacht: {id: AD1, name: 'Tidewyn Discovery'},
  checkInDate: '2027-03-07 14:00:00', checkOutDate: '2027-03-19 10:00:00', clientId: '8299', clientName: 'Private Person',
  guestId: null, bookingOrigin: '', internalRemarks: '', remarks: 'call before arrival', freeEntry: false,
  basePrice: 8171, finalPrice: 7353.9, commissionsValue: '1030.9205', toBePaidAmount: 6322.9795, paidAmount: 0, payments: [], invoiceId: '',
  currency: '0', currencyCode: 'EUR', ...change});

test('a Reservation or Option with a customer is an order; payment is not required', () => {
  const reservation = mmkOrder(model(), at);
  assert.deepEqual(reservation, {source: 'mmk', booking_id: '8889178168337030369', boataround_slug: 'reef-cat-37-tidewyn-discovery',
    start: '2027-03-07', end: '2027-03-19', status: 'accepted', platform_status: 'Reservation',
    url: MMK_ORDER_URL + '8889178168337030369', amount: '€6,322.98', amount_basis: '船东净收入（最终价格减代理佣金）', verified_at: at,
    verification_source: 'MMK 预订详情：有客户的 Reservation 或 Option 算有效订单，不看付款', payment_basis: 'mmk_client_assigned'});
  // Customer names, contact details and notes never enter the snapshot.
  assert.doesNotMatch(JSON.stringify(reservation), /Private Person|call before arrival|8299/);
  const option = mmkOrder(model({statusId: '2', yacht: {id: AD2}, currencyCode: 'USD', finalPrice: 1234.5, commissionsValue: '0'}), at);
  assert.equal(option.status, 'accepted'); assert.equal(option.platform_status, 'Option');
  assert.equal(option.boataround_slug, 'seacat-open-40-tidewyn-discovery-2'); assert.equal(option.amount, '$1,234.50');
});

test('expired and cancelled orders are reported as cancelled, with the platform label', () => {
  for (const [statusId, label] of [['3', 'Option expired'], ['5', 'Canceled']]) {
    const order = mmkOrder(model({statusId}), at);
    assert.equal(order.status, 'cancelled'); assert.equal(order.platform_status, label);
    assert.equal(order.payment_basis, undefined); assert.equal(order.amount, null);
  }
});

test('blocks without a customer, our own blocks, offers and other record types are not orders', () => {
  for (const change of [{clientId: '-1'}, {clientId: ''}, {clientId: null},
    {bookingOrigin: 'TidewynSync:attempt boataround:1', internalRemarks: 'TidewynSync:attempt boataround:1'},
    {internalRemarks: 'TidewynSync:x'}, {statusId: '7'}, {statusId: '4'}, {statusId: '6'}, {statusId: '8'},
    {statusId: '10'}, {statusId: '11'}, {statusId: '12'}])
    assert.equal(mmkOrder(model(change), at), null, JSON.stringify(change));
});

test('an order on a yacht without a mapping fails the read when current, never vanishes', async () => {
  assert.deepEqual(mmkOrder(model({yacht: {id: 'unmapped-yacht'}}), at), {unmapped: true, end: '2027-03-19'});
  assert.equal(mmkOrder(model({yacht: {id: 'unmapped-yacht'}, clientId: '-1'}), at), null);
  const current = [model({yacht: {id: 'unmapped-yacht'}})], past = [model({yacht: {id: 'unmapped-yacht'}, checkInDate: '2026-05-01 14:00:00', checkOutDate: '2026-05-08 10:00:00'})];
  await assert.rejects(collectMmk({page: fakePage({first: rows(current), details: current}), fromDay: '2026-10-03'}), error => error.code === 'schema_changed');
  assert.deepEqual((await collectMmk({page: fakePage({first: rows(past), details: past}), fromDay: '2026-10-03'})).orders, []);
});

test('dates come from the record; a same-day charter occupies its day; malformed dates fail closed', () => {
  assert.deepEqual([mmkOrder(model({checkInDate: '2027-01-02 00:00:00', checkOutDate: '2027-01-09 00:00:00'}), at)]
    .map(o => [o.start, o.end]), [['2027-01-02', '2027-01-09']]);
  const day = mmkOrder(model({checkInDate: '2027-05-01 09:00:00', checkOutDate: '2027-05-01 17:00:00'}), at);
  assert.deepEqual([day.start, day.end], ['2027-05-01', '2027-05-02']);
  for (const change of [{checkInDate: '2027-03-07'}, {checkOutDate: '2027-02-30 10:00:00'},
    {checkOutDate: '2027-03-07 14:00:00'}, {id: 'abc'}])
    assert.throws(() => mmkOrder(model(change), at), error => error.name === 'OrderParseError', JSON.stringify(change));
  // The currency is the ISO code field; currency is MMK's internal number. A missing or
  // unreadable price or commission gives no amount (listed as missing, never guessed).
  for (const change of [{currencyCode: 'THB'}, {currencyCode: undefined, currency: 'EUR'}, {finalPrice: 0}, {finalPrice: '4200'},
    {commissionsValue: null}, {commissionsValue: 'n/a'}, {commissionsValue: '9000'}]) assert.equal(mmkOrder(model(change), at).amount, null, JSON.stringify(change));
  assert.equal(mmkOrder(model({commissionsValue: 643.45795, finalPrice: 4590}), at).amount, '€3,946.54');
});

function fakePage({first, second = first, details, entry = 'ready', serviceId = '0000'}) {
  let lists = 0;
  return {lists: () => lists, goto: async () => {}, waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      if (fn === mmkEntryState) return typeof entry === 'function' ? entry() : entry;
      const text = fn.toString();
      if (text.includes('ReservationsAPI.getData')) return {serviceId, isCharter: true};
      if (text.includes('getFilteredItems')) { lists++; return {data: lists === 1 ? first : second, itemsLeft: 0, timedOut: false}; }
      if (text.includes('getReservation')) return arg.map(id => ({success: true, value: details.find(d => d.id === id)}));
      throw Error('unexpected page call');
    }};
}
const rows = details => details.map(d => ({id: d.id, status: d.statusId === '1' ? 'Reservation' : 'Other'}));

test('collection reads every record, lists twice, and uploads only current and future orders', async () => {
  const details = [model(), model({id: '1', statusId: '1', clientId: '-1', checkInDate: '2027-04-01 00:00:00', checkOutDate: '2027-04-05 00:00:00'}),
    model({id: '2', statusId: '2', checkInDate: '2026-09-01 14:00:00', checkOutDate: '2026-09-08 10:00:00'}),
    model({id: '3', statusId: '5', checkInDate: '2026-11-01 14:00:00', checkOutDate: '2026-11-08 10:00:00'})];
  const page = fakePage({first: rows(details), details});
  const snapshot = await collectMmk({page, fromDay: '2026-10-03', signal: new AbortController().signal}, {now: () => Date.parse(at)});
  assert.equal(page.lists(), 2);
  assert.equal(snapshot.source, 'mmk'); assert.equal(snapshot.complete, true); assert.equal(snapshot.checked_at, at);
  assert.deepEqual(snapshot.scope, {kind: 'current_future', from_day: '2026-10-03', fleet_slugs: FLEET.map(b => b.slug)});
  assert.deepEqual(snapshot.orders.map(o => [o.booking_id, o.status]), [['3', 'cancelled'], ['8889178168337030369', 'accepted']]);
  assert.equal(snapshot.expected_count, 2);
  assert.deepEqual(snapshot.pagination, {complete: true, total_pages: 1, pages_read: [1], listed_count: 4});
});

test('a record changing during the read keeps the last orders (incomplete), and login needs the verified recovery', async () => {
  const details = [model()];
  await assert.rejects(collectMmk({page: fakePage({first: rows(details), second: [{id: details[0].id, status: 'Canceled'}], details}),
    fromDay: '2026-10-03'}), error => error.code === 'incomplete_pages');
  await assert.rejects(collectMmk({page: fakePage({first: [], details: [], entry: 'auth_required'}), fromDay: '2026-10-03'}),
    error => error.code === 'auth_required');
  await assert.rejects(collectMmk({page: fakePage({first: [], details: [], serviceId: 'other'}), fromDay: '2026-10-03'}),
    error => error.code === 'auth_required');
  let recovered = 0, loggedIn = false;
  const page = fakePage({first: [], details: [], entry: () => loggedIn ? 'ready' : 'auth_required'});
  const snapshot = await collectMmk({page, fromDay: '2026-10-03'}, {recoverLogin: async () => { recovered++; loggedIn = true; }});
  assert.equal(recovered, 1); assert.deepEqual(snapshot.orders, []);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(collectMmk({page: fakePage({first: [], details: []}), fromDay: '2026-10-03', signal: stopped.signal}),
    error => error.code === 'fetch_failed');
});
