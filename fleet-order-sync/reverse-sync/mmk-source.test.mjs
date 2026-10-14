// MMK as the fourth order source (user decision 2026-10-04): its orders close
// Boataround, Click&Boat and SamBoat; MMK's own booking already occupies MMK.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan, registryCauses, SOURCES, TARGETS} from './planner.mjs';
import {mmkPlan} from './mmk-plan.mjs';
import {FLEET} from '../parsers.mjs';

const now = Date.parse('2026-10-04T02:00:00Z'), iso = v => new Date(v).toISOString();
const boat = FLEET[1].slug; // Tidewyn Discovery (AD1), on MMK
const status = (overrides = {}) => ({platforms: Object.fromEntries(SOURCES.map(s => [s, {mode: 'dynamic', last_error: null, last_success_at: iso(now), ...overrides[s]}]))});
const mmk = (id, start, end, change = {}) => ({source: 'mmk', booking_id: id, boataround_slug: boat, start, end, status: 'accepted',
  platform_status: 'Reservation', payment_basis: 'mmk_client_assigned', verified_at: iso(now), ...change});
const mapping = (orders = [], extra = {}) => ({boataround: [], clickandboat: [], samboat: [], mmk: orders, nausys: [], ...extra});
const target = (plan, name) => plan.targets.find(t => t.boat === boat && t.target === name);

test('the source list adds MMK; calendar targets stay the three platforms (MMK is planned separately)', () => {
  assert.deepEqual(SOURCES, ['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys']);
  assert.deepEqual(TARGETS, ['boataround', 'clickandboat', 'samboat']);
  assert.throws(() => registryCauses({boataround: [], clickandboat: [], samboat: []}, status(), now), /reverse_registry_unavailable/);
});

test('an MMK Reservation closes the whole stay and checkout day on the other three platforms, not on MMK', () => {
  const plan = buildPlan(mapping([mmk('8889178168337030369', '2027-03-07', '2027-03-19')]), status(), {now});
  assert.deepEqual(plan.excluded, []);
  const key = 'mmk:8889178168337030369';
  for (const name of TARGETS) {
    const t = target(plan, name);
    assert.deepEqual(t.segments, [{start: '2027-03-07', end: '2027-03-20', causes: [key]}], name);
    assert.equal(t.fresh, true); assert.equal(t.release_proof.ready, true);
    assert.deepEqual(t.release_proof.orders, [{key, state: 'active', start: '2027-03-07', end: '2027-03-20'}]);
  }
  const own = mmkPlan(plan).targets.find(t => t.boat === boat);
  assert.deepEqual(own.segments, []); assert.equal(own.status, 'no_external_orders'); assert.equal(own.fresh, true);
  // Orders from the other platforms still close MMK, as nights since 2026-10-09
  // (boarding 04-01 14:00, return 04-08 10:00).
  const withBoataround = buildPlan(mapping([mmk('8889178168337030369', '2027-03-07', '2027-03-19')], {boataround: [{booking_id: '1',
    boataround_slug: boat, start: '2027-04-01', end: '2027-04-08', status: 'paid', platform_status: 'CONFIRMED', customer_payment: 'PAID', verified_at: iso(now)}]}), status(), {now});
  assert.deepEqual(mmkPlan(withBoataround).targets.find(t => t.boat === boat).segments, [{start: '2027-04-01', end: '2027-04-08', causes: ['boataround:1']}]);
});

test('an Option with a customer counts without payment; any other basis or label is excluded', () => {
  const option = buildPlan(mapping([mmk('2', '2027-05-01', '2027-05-08', {platform_status: 'Option'})]), status(), {now});
  assert.deepEqual(option.causes.map(c => c.key), ['mmk:2']);
  for (const change of [{payment_basis: undefined}, {payment_basis: 'platform_accepted'}, {platform_status: 'Offer'}, {status: 'paid'}]) {
    const plan = buildPlan(mapping([mmk('3', '2027-05-01', '2027-05-08', change)]), status(), {now});
    assert.deepEqual(plan.excluded, [{key: 'mmk:3', boat, reason: 'payment_unverified'}], JSON.stringify(change));
    assert.equal(target(plan, 'boataround').fresh, false);
  }
});

test('an expired or cancelled MMK order is release proof only while MMK is fresh', () => {
  for (const label of ['Option expired', 'Canceled']) {
    const cancelled = mmk('4', '2027-06-01', '2027-06-08', {status: 'cancelled', platform_status: label, payment_basis: undefined});
    const plan = buildPlan(mapping([cancelled]), status(), {now});
    assert.deepEqual(plan.excluded, []); assert.deepEqual(plan.causes, []);
    assert.deepEqual(target(plan, 'samboat').release_proof.orders, [{key: 'mmk:4', state: 'cancelled'}], label);
    const stale = buildPlan(mapping([cancelled]), status({mmk: {last_success_at: iso(now - 3600000)}}), {now});
    assert.deepEqual(target(stale, 'samboat').release_proof.orders, []); assert.equal(target(stale, 'samboat').release_proof.ready, false);
  }
  // "Option expired" is an MMK term; on another platform it is not a cancellation.
  const odd = buildPlan(mapping([], {samboat: [{booking_id: '9', boataround_slug: boat, start: '2027-06-01', end: '2027-06-08', status: 'cancelled', platform_status: 'Option expired', verified_at: iso(now)}]}), status(), {now});
  assert.deepEqual(odd.excluded, [{key: 'samboat:9', boat, reason: 'cancellation_conflict'}]);
});

test('a failing MMK read keeps its last orders closed (close-only) and never allows opening', () => {
  const orders = [mmk('5', '2027-07-01', '2027-07-08', {verified_at: iso(now - 6 * 3600000)})];
  const plan = buildPlan(mapping(orders), status({mmk: {last_error: 'fetch_failed', last_success_at: iso(now - 6 * 3600000)}}), {now});
  for (const name of TARGETS) {
    const t = target(plan, name);
    assert.equal(t.fresh, false); assert.equal(t.close_ready, true); assert.deepEqual(t.stale_sources, ['mmk']);
    assert.equal(t.release_proof.ready, false); assert.deepEqual(t.segments.map(s => s.causes), [['mmk:5']]);
  }
  // Before MMK has ever been read completely, nothing is fresh and close-only is not available.
  const never = buildPlan(mapping(), status({mmk: {mode: 'bootstrap', last_success_at: null, last_error: 'awaiting_first_sync'}}), {now});
  for (const t of never.targets) { assert.equal(t.fresh, false); assert.equal(t.close_ready, false); assert.equal(t.source_healthy, false); }
});
