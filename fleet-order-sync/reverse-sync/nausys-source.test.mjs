// NauSYS as the fifth order source (user decision 2026-10-09): an agency's
// Option or Reservation closes Boataround, Click&Boat, SamBoat and MMK.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan, registryCauses, SOURCES, TARGETS} from './planner.mjs';
import {mmkPlan} from './mmk-plan.mjs';
import {FLEET} from '../parsers.mjs';

const now = Date.parse('2026-10-09T22:00:00Z'), iso = v => new Date(v).toISOString();
const boat = 'grandcat-55-tidewyn-discovery-5';
const status = (overrides = {}) => ({platforms: Object.fromEntries(SOURCES.map(s => [s, {mode: 'dynamic', last_error: null, last_success_at: iso(now), ...overrides[s]}]))});
const agency = (id, start, end, change = {}) => ({source: 'nausys', booking_id: id, boataround_slug: boat, start, end, status: 'accepted',
  platform_status: 'Option', payment_basis: 'nausys_agency', verified_at: iso(now), ...change});
const mapping = (orders = [], extra = {}) => ({boataround: [], clickandboat: [], samboat: [], mmk: [], nausys: orders, ...extra});
const target = (plan, name) => plan.targets.find(t => t.boat === boat && t.target === name);

test('NauSYS is the fifth source; calendar targets stay the three platforms (MMK planned separately)', () => {
  assert.deepEqual(SOURCES, ['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys']);
  assert.deepEqual(TARGETS, ['boataround', 'clickandboat', 'samboat']);
  assert.ok(FLEET.some(b => b.slug === boat));
  assert.throws(() => registryCauses({boataround: [], clickandboat: [], samboat: [], mmk: []}, status(), now), /reverse_registry_unavailable/);
});

test('an agency Option closes the whole stay and checkout day on the three platforms and its nights on MMK', () => {
  const plan = buildPlan(mapping([agency('952814834', '2027-02-27', '2027-03-06')]), status(), {now});
  assert.deepEqual(plan.excluded, []);
  const key = 'nausys:952814834';
  for (const name of TARGETS) {
    const t = target(plan, name);
    assert.deepEqual(t.segments, [{start: '2027-02-27', end: '2027-03-07', causes: [key]}], name);
    assert.equal(t.fresh, true); assert.equal(t.release_proof.ready, true);
    assert.deepEqual(t.release_proof.orders, [{key, state: 'active', start: '2027-02-27', end: '2027-03-07'}]);
  }
  const own = mmkPlan(plan).targets.find(t => t.boat === boat);
  assert.deepEqual(own.segments, [{start: '2027-02-27', end: '2027-03-06', causes: [key]}]);
  assert.deepEqual(own.release_proof.orders, [{key, state: 'active', start: '2027-02-27', end: '2027-03-06'}]);
});

test('a Reservation counts as well; any other basis or label is excluded and stops opening for the boat', () => {
  assert.deepEqual(buildPlan(mapping([agency('1', '2027-05-01', '2027-05-08', {platform_status: 'Reservation'})]), status(), {now}).causes.map(c => c.key), ['nausys:1']);
  for (const change of [{payment_basis: undefined}, {payment_basis: 'mmk_client_assigned'}, {platform_status: 'Information'}, {status: 'paid'}]) {
    const plan = buildPlan(mapping([agency('2', '2027-05-01', '2027-05-08', change)]), status(), {now});
    assert.deepEqual(plan.excluded, [{key: 'nausys:2', boat, reason: 'payment_unverified'}], JSON.stringify(change));
    assert.equal(target(plan, 'boataround').fresh, false);
  }
});

test('an expired or cancelled agency order is release proof only while NauSYS is fresh', () => {
  for (const label of ['Option expired', 'Canceled']) {
    const cancelled = agency('3', '2027-06-01', '2027-06-08', {status: 'cancelled', platform_status: label, payment_basis: undefined});
    const plan = buildPlan(mapping([cancelled]), status(), {now});
    assert.deepEqual(plan.causes, []);
    assert.deepEqual(target(plan, 'clickandboat').release_proof.orders, [{key: 'nausys:3', state: 'cancelled'}], label);
    const stale = buildPlan(mapping([cancelled]), status({nausys: {last_success_at: iso(now - 3600000)}}), {now});
    assert.deepEqual(target(stale, 'clickandboat').release_proof.orders, []); assert.equal(target(stale, 'clickandboat').release_proof.ready, false);
  }
});

test('a failing NauSYS read keeps its last orders closed (close-only) and never allows opening anywhere', () => {
  const orders = [agency('4', '2027-07-01', '2027-07-08', {verified_at: iso(now - 6 * 3600000)})];
  const plan = buildPlan(mapping(orders), status({nausys: {last_error: 'fetch_failed', last_success_at: iso(now - 6 * 3600000)}}), {now});
  for (const name of TARGETS) {
    const t = target(plan, name);
    assert.equal(t.fresh, false); assert.equal(t.close_ready, true); assert.deepEqual(t.stale_sources, ['nausys']);
    assert.equal(t.release_proof.ready, false); assert.deepEqual(t.segments.map(s => s.causes), [['nausys:4']]);
  }
  const own = mmkPlan(plan).targets.find(t => t.boat === boat);
  assert.equal(own.fresh, false); assert.equal(own.close_ready, true);
  // Before NauSYS has ever been read completely, nothing is fresh and close-only is not available.
  const never = buildPlan(mapping(), status({nausys: {mode: 'bootstrap', last_success_at: null, last_error: 'awaiting_first_sync'}}), {now});
  for (const t of never.targets) { assert.equal(t.fresh, false); assert.equal(t.close_ready, false); }
});
