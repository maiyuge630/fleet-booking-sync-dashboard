// Replace and remembered cancellations (2026-10-10). On 10-05 an MMK order on
// AD1 (01-30 to 02-06) was cancelled and re-made from 02-06. The program's
// whole SamBoat and Click&Boat records for the old order also closed 02-06,
// still needed, so they were kept for good; and once the old order left the
// source data, no proof of its cancellation was left either.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {rememberCancellations, rememberedCancellations, onlyClosedBy, rangeDays, releaseAllowed} from './release.mjs';

const now = Date.parse('2026-10-10T06:30:00Z'), stamp = new Date(now).toISOString();
const OLD = 'mmk:old', NEW = 'mmk:new';
const NEW_ORDER = {key: NEW, state: 'active', start: '2027-02-06', end: '2027-02-14'};

function world({target = 'samboat', replaceDays = 1, remembered = true, segments = [{start: '2027-02-06', end: '2027-02-14', causes: [NEW]}],
  orders = [NEW_ORDER], oldCauses = [OLD], refuse = []} = {}) {
  const key = target + ':1';
  const old = {id: 'r:1', start: '2027-01-30', end: '2027-02-07'}, later = {id: 'r:2', start: '2027-02-07', end: '2027-02-14'};
  let blocks = [old, later], serial = 10;
  const removed = [], created = [];
  let state = {version: 1, targets: {}, attempts: [
    {id: 'a-old', target: key, start: old.start, end: old.end, causes: oldCauses, before: [], state: 'confirmed', created: {...old},
      release_causes: {version: 1, causes: [...new Set([...oldCauses, NEW])].sort()}},
    {id: 'a-later', target: key, start: later.start, end: later.end, causes: [NEW], before: [], state: 'confirmed', created: {...later}}],
    ...(remembered ? {cancelled_orders: {[OLD]: {seen_at: '2026-10-05T18:17:27.000Z'}}} : {})};
  const plan = {target, boat: 'b', listing_id: '1', fresh: true, segments, release_proof: {ready: true, checked_at: stamp, orders}};
  const adapter = {replaceDays,
    async read() { return {complete: true, identity_verified: true, blocks: structuredClone(blocks)}; },
    async prepare(t, gap) { if (refuse.includes(gap.start)) throw Error('cb_app_date_not_selectable'); },
    async submit(t, gap) { const row = {id: 'r:' + (++serial), ...gap}; blocks.push(row); created.push(row); return row; },
    async remove(t, owned, {guard} = {}) { await guard?.(); removed.push(owned.id); blocks = blocks.filter(b => b.id !== owned.id); },
    async close() {}};
  const options = {now: () => now, load: async () => structuredClone(state), save: async v => { state = structuredClone(v); },
    plan: async () => ({generated_at: stamp, targets: [structuredClone(plan)]}), adapters: {[target]: adapter}};
  return {key, run: () => new ReverseExecutor(options).run(), state: () => state, removed, created, blocks: () => blocks};
}

test('the AD1 case: the old record is deleted and its one still-needed day closed again in the same run', async () => {
  for (const target of ['samboat', 'clickandboat']) {
    const w = world({target});
    await w.run();
    assert.deepEqual(w.removed, ['r:1'], target);
    assert.deepEqual(w.created.map(r => [r.start, r.end]), [['2027-02-06', '2027-02-07']], target);
    const s = w.state(), old = s.attempts.find(a => a.id === 'a-old'), day = s.attempts.find(a => a.created?.id === 'r:11');
    assert.equal(old.state, 'released'); assert.deepEqual(old.replaced, {version: 1, reclose: [{start: '2027-02-06', end: '2027-02-07'}]});
    assert.deepEqual([day.state, day.causes], ['confirmed', [NEW]]);
    assert.equal(s.targets[w.key].state, 'protected', target);
    // Nothing more to do on the next run.
    await w.run(); assert.equal(w.removed.length, 1); assert.equal(w.created.length, 1);
  }
});

test('a moved order with the same number (shortened at its start) is replaced the same way', async () => {
  const w = world({oldCauses: [NEW], remembered: false});
  await w.run();
  assert.deepEqual(w.removed, ['r:1']); assert.deepEqual(w.created.map(r => [r.start, r.end]), [['2027-02-06', '2027-02-07']]);
});

test('without proof the old order was cancelled, nothing is deleted and the kept dates are shown', async () => {
  const w = world({remembered: false});
  await w.run();
  assert.deepEqual(w.removed, []); assert.deepEqual(w.created, []);
  const t = w.state().targets[w.key];
  assert.equal(t.state, 'removal_requires_verification');
  assert.deepEqual(t.retained_ranges, [{start: '2027-01-30', end: '2027-02-06'}]);
});

test('no replace where it is not allowed: other platforms, or more than one still-needed day', async () => {
  for (const [label, options] of [['no replace on this platform', {target: 'mmk', replaceDays: 0}],
    ['two needed days', {segments: [{start: '2027-02-05', end: '2027-02-14', causes: [NEW]}], orders: [{...NEW_ORDER, start: '2027-02-05'}]}]]) {
    const w = world(options);
    await w.run();
    assert.deepEqual(w.removed, [], label); assert.deepEqual(w.created, [], label);
    assert.ok(w.state().targets[w.key].retained_ranges.length, label);
  }
});

test('a day the platform refuses to close again is reported; the old record stays released', async () => {
  const w = world({target: 'clickandboat', refuse: ['2027-02-06']});
  await w.run();
  assert.deepEqual(w.removed, ['r:1']); assert.deepEqual(w.created, []);
  const t = w.state().targets[w.key];
  assert.equal(t.state, 'needs_review');
  assert.deepEqual(t.blocked.map(b => [b.start, b.end, b.error]), [['2027-02-06', '2027-02-07', 'cb_app_date_not_selectable']]);
});

test('cancellations are remembered only from a fully fresh proof, and an order listed again wins', () => {
  const ledger = {attempts: []};
  const target = (orders, extra = {}) => ({fresh: true, release_proof: {ready: true, checked_at: stamp, orders}, ...extra});
  rememberCancellations(ledger, target([{key: 'x', state: 'cancelled'}], {fresh: false}), now);
  rememberCancellations(ledger, {fresh: true, release_proof: {ready: false, checked_at: stamp, orders: [{key: 'y', state: 'cancelled'}]}}, now);
  rememberCancellations(ledger, target([{key: 'z', state: 'cancelled'}], {release_proof: {ready: true, checked_at: '2026-10-09T00:00:00.000Z', orders: [{key: 'z', state: 'cancelled'}]}}), now);
  assert.deepEqual([...rememberedCancellations(ledger)], []);
  rememberCancellations(ledger, target([{key: OLD, state: 'cancelled'}, NEW_ORDER]), now);
  assert.deepEqual([...rememberedCancellations(ledger)], [OLD]);
  // Kept 400 days, then dropped at the next fresh proof.
  const later = now + 399 * 86400000, after = now + 401 * 86400000;
  rememberCancellations(ledger, {fresh: true, release_proof: {ready: true, checked_at: new Date(later).toISOString(), orders: []}}, later);
  assert.deepEqual([...rememberedCancellations(ledger)], [OLD]);
  rememberCancellations(ledger, {fresh: true, release_proof: {ready: true, checked_at: new Date(after).toISOString(), orders: []}}, after);
  assert.deepEqual([...rememberedCancellations(ledger)], []);
  // A remembered key counts only while the source no longer lists the order.
  const attempt = {id: 'a', start: '2027-01-30', end: '2027-02-06', causes: [OLD], created: {id: 'r:1', start: '2027-01-30', end: '2027-02-06'}};
  const proof = orders => ({target: 'samboat', fresh: true, release_proof: {ready: true, checked_at: stamp, orders}});
  assert.equal(releaseAllowed(attempt, proof([]), now, {remembered: new Set([OLD])}), true);
  assert.equal(releaseAllowed(attempt, proof([]), now, {}), false, 'a disappearance alone never counts');
  assert.equal(releaseAllowed(attempt, proof([{key: OLD, state: 'active', start: '2027-01-30', end: '2027-02-06'}]), now, {remembered: new Set([OLD])}), false);
});

test('only the needed days a record alone closes, from today, count against a replace', () => {
  const a = {start: '2026-10-08', end: '2026-10-15', created: {id: 'r:1'}};
  const blocks = [{id: 'r:1', start: '2026-10-08', end: '2026-10-15'}, {id: 'r:2', start: '2026-10-12', end: '2026-10-13'}];
  const r = onlyClosedBy(a, [{start: '2026-10-08', end: '2026-10-14'}], blocks, '2026-10-10');
  assert.deepEqual(r, [{start: '2026-10-10', end: '2026-10-12'}, {start: '2026-10-13', end: '2026-10-14'}]);
  assert.equal(rangeDays(r), 3);
});

// 2026-10-13: AD5 on Click&Boat needed two days of an old record and was fixed
// by hand; the limit is a week since then (user: fewer manual fixes).
test('up to a week of still-needed days is replaced on SamBoat and Click&Boat; more is kept', async () => {
  const {SamBoatAdapter} = await import('./samboat-adapter.mjs');
  const {ClickAndBoatAppAdapter} = await import('./clickandboat-app-adapter.mjs');
  assert.equal(new SamBoatAdapter({}).replaceDays, 7); assert.equal(new ClickAndBoatAppAdapter({rootCommand: async () => ''}).replaceDays, 7);
  for (const target of ['samboat', 'clickandboat']) {
    const two = world({target, replaceDays: 7, segments: [{start: '2027-02-05', end: '2027-02-14', causes: [NEW]}], orders: [{...NEW_ORDER, start: '2027-02-05'}]});
    await two.run();
    assert.deepEqual(two.removed, ['r:1'], target); assert.deepEqual(two.created.map(r => [r.start, r.end]), [['2027-02-05', '2027-02-07']], target);
    assert.equal(two.state().targets[two.key].state, 'protected', target);
  }
  // More needed days than the limit keep the record: see 'two needed days' above (limit 1).
});