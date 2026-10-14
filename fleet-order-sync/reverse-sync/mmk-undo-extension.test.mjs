// Undoing an extension (2026-10-13, AD5 XX-00001). The record was made for
// Boataround 319839 (03-06..03-20) and extended to 02-27 for NauSYS Option
// 952814834; that Option was cancelled and a new one (952921283, 02-21..02-28)
// needed the night of 02-27. The record stayed whole ("split requires review")
// and six nights stayed closed until it was fixed by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mmkBlock} from './mmk-adapter.mjs';
import {recoverMmkResizes,UNDO_REOPEN_NIGHTS} from './mmk-resize.mjs';

const NOW = Date.parse('2026-10-13T01:00:00Z'), boat = '1000000000000000003';
const seg = (start, end, causes) => ({start, end, causes});
const active = (key, start, end) => ({key, state: 'active', start, end});
const cancelled = key => ({key, state: 'cancelled'});
function owned(id, causes, start, end) {
  const marker = `TidewynSync:${id} ${causes.join(',')}`;
  const model = {id: id + '-mmk', yacht: {id: boat}, statusId: '1', freeEntry: true, finalPrice: 0, paidAmount: 0, payments: [], invoiceId: '', clientId: '-1', guestId: null,
    checkInDate: start + ' 14:00:00', checkOutDate: end + ' 10:00:00', bookingOrigin: marker, internalRemarks: marker};
  return {model, attempt: {id, target: 'mmk:' + boat, start, end, causes, created: mmkBlock(model), state: 'confirmed', response: {marker}, before: []}};
}
// `from` is the record's date before the extension.
function setup({from = '2027-03-06', start = '2027-02-27', end = '2027-03-20', segments, orders, neighbour = ['2027-02-21', '2027-02-27'], remembered = {}} = {}) {
  const old = owned('old', ['boataround:319839'], start, end);
  old.attempt.release_causes = {version: 1, causes: ['boataround:319839', 'nausys:952814834']};
  const before = mmkBlock({...old.model, checkInDate: from + ' 14:00:00'});
  old.attempt.mmk_resize = {version: 1, history: [{id: 'ext', mode: 'extend', state: 'confirmed', old: before, new: old.attempt.created, before: [],
    release_causes: ['boataround:319839', 'nausys:952814834']}]};
  const models = new Map([[old.model.id, old.model]]), attempts = [];
  if (neighbour) { const n = owned('new', ['nausys:952921283'], ...neighbour); models.set(n.model.id, n.model); attempts.push(n.attempt); }
  attempts.push(old.attempt);
  const target = {target: 'mmk', listing_id: boat, boat: 'ad5', fresh: true,
    segments: segments ?? [seg('2027-02-21', '2027-02-28', ['nausys:952921283']), seg('2027-03-06', '2027-03-20', ['boataround:319839'])],
    release_proof: {ready: true, checked_at: new Date(NOW).toISOString(),
      orders: orders ?? [cancelled('nausys:952814834'), active('nausys:952921283', '2027-02-21', '2027-02-28'), active('boataround:319839', '2027-03-06', '2027-03-20')]}};
  const ledger = {version: 1, attempts, targets: {}, cancelled_orders: remembered};
  const writes = [];
  const adapter = {read: async () => ({complete: true, identity_verified: true, blocks: [...models.values()].map(mmkBlock)}),
    client: {get: async id => structuredClone(models.get(id)), available: async () => true,
      save: async model => { writes.push([model.id, model.checkInDate.slice(0, 10), model.checkOutDate.slice(0, 10)]); models.set(model.id, structuredClone(model)); return structuredClone(model); }}};
  const run = () => recoverMmkResizes({adapter, target, ledger, guard: async () => target, save: async () => {}, blockOf: mmkBlock, now: () => NOW});
  return {run, writes, ledger, old: old.attempt, neighbour: attempts.find(a => a.id === 'new')};
}

test('an extension made for a cancelled order is undone; the night another order still needs is closed again at once', async () => {
  const f = setup();
  await f.run();
  // The old record back to its dates; then the neighbour of ours extended over 02-27.
  assert.deepEqual(f.writes, [['old-mmk', '2027-03-06', '2027-03-20'], ['new-mmk', '2027-02-21', '2027-02-28']]);
  assert.deepEqual([f.old.start, f.old.end, f.old.mmk_resize.history.at(-1).mode], ['2027-03-06', '2027-03-20', 'shrink']);
  assert.deepEqual([f.neighbour.start, f.neighbour.end], ['2027-02-21', '2027-02-28']);
  await f.run(); assert.equal(f.writes.length, 2, 'nothing more on the next run');
});

test('without a record of ours next to the reopened night, the undo alone is done; the executor writes that night', async () => {
  const f = setup({neighbour: null});
  await f.run();
  assert.deepEqual(f.writes, [['old-mmk', '2027-03-06', '2027-03-20']]);
});

test('an extension is never undone while its order is active or only missing; a remembered cancellation counts', async () => {
  // Still active: its nights are needed, so the record stays as it is.
  const live = setup({segments: [seg('2027-02-21', '2027-03-06', ['nausys:952921283', 'nausys:952814834']), seg('2027-03-06', '2027-03-20', ['boataround:319839'])],
    orders: [active('nausys:952814834', '2027-02-27', '2027-03-06'), active('nausys:952921283', '2027-02-21', '2027-02-28'), active('boataround:319839', '2027-03-06', '2027-03-20')]});
  await live.run();
  assert.equal(live.writes.length, 0); assert.equal(live.old.start, '2027-02-27');
  // Gone from the source without a cancellation: kept for review.
  const missing = setup({orders: [active('nausys:952921283', '2027-02-21', '2027-02-28'), active('boataround:319839', '2027-03-06', '2027-03-20')]});
  await missing.run();
  assert.equal(missing.writes.length, 0); assert.equal(missing.old.mmk_resize.review?.reason, 'mmk_resize_split_requires_review');
  const f = setup({orders: [active('nausys:952921283', '2027-02-21', '2027-02-28'), active('boataround:319839', '2027-03-06', '2027-03-20')],
    remembered: {'nausys:952814834': {seen_at: new Date(NOW).toISOString()}}});
  await f.run();
  assert.deepEqual(f.writes[0], ['old-mmk', '2027-03-06', '2027-03-20']);
});

test('more than the allowed needed nights inside the removed part keeps the record for review', async () => {
  // Extended from 03-06 back to 02-20; a new order needs 02-20..03-02 (10 nights).
  const f = setup({start: '2027-02-20', neighbour: null, segments: [seg('2027-02-20', '2027-03-02', ['nausys:952921283']), seg('2027-03-06', '2027-03-20', ['boataround:319839'])],
    orders: [cancelled('nausys:952814834'), active('nausys:952921283', '2027-02-20', '2027-03-02'), active('boataround:319839', '2027-03-06', '2027-03-20')]});
  assert.ok(10 > UNDO_REOPEN_NIGHTS);
  await f.run();
  assert.equal(f.writes.length, 0); assert.equal(f.old.mmk_resize.review?.reason, 'mmk_resize_split_requires_review');
});
