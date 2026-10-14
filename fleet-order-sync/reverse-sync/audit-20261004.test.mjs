// Calendar sync fixes from the 2026-10-04 review: nothing that failed before
// its first platform request may stay uncertain forever; past days are not
// required; old snapshots and unrelated open days do not block a target.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {beforeRequest} from './not-submitted.mjs';

const now = Date.parse('2026-09-13T06:30:00Z'); // Beijing 2026-09-13 14:30
const KEY = 'clickandboat:100004';
function setup({blocks = [], ledger = null, segments, proof} = {}) {
  let state = ledger;
  const target = {target: 'clickandboat', listing_id: '100004', fresh: true,
    segments: segments || [{start: '2026-12-12', end: '2026-12-19', causes: ['boataround:300000']}],
    ...(proof ? {release_proof: proof} : {})};
  const calls = {submit: 0, remove: 0};
  const adapter = {
    async read() { return {complete: true, identity_verified: true, blocks: structuredClone(blocks)}; },
    async prepare() {},
    async submit(t, gap) { calls.submit++; const created = {...gap, id: 'w' + calls.submit}; blocks.push(created); return created; },
    async remove(t, owned) { calls.remove++; blocks.splice(blocks.findIndex(b => b.id === owned.id), 1); },
    async close() {}
  };
  const options = {now: () => now, load: async () => structuredClone(state), save: async v => { state = structuredClone(v); },
    plan: async () => ({generated_at: new Date(now).toISOString(), targets: [structuredClone(target)]}), adapters: {clickandboat: adapter}};
  return {adapter, target, blocks, calls, run: () => new ReverseExecutor(options).run(), state: () => state};
}

test('a write that fails before its first request is retired and written on the next run', async () => {
  const x = setup(), original = x.adapter.submit;
  x.adapter.submit = async () => beforeRequest(async () => { throw Error('form_value_mismatch'); });
  await x.run();
  assert.equal(x.state().attempts[0].state, 'not_submitted'); assert.equal(x.state().attempts[0].reason, 'form_value_mismatch');
  x.adapter.submit = original; await x.run();
  assert.equal(x.calls.submit, 1); assert.equal(x.state().attempts[1].state, 'confirmed');
  assert.equal(x.state().targets[KEY].state, 'protected');
});

test('a release that fails before its first request keeps the record ours, then releases next run', async () => {
  const owned = {id: 'own', start: '2026-12-12', end: '2026-12-19'};
  const ledger = {version: 1, targets: {}, attempts: [{id: 'a', target: KEY, start: owned.start, end: owned.end, causes: ['boataround:9'], before: [], state: 'confirmed', created: {...owned}}]};
  const proof = {ready: true, checked_at: new Date(now).toISOString(), orders: [{key: 'boataround:9', state: 'cancelled'}]};
  const x = setup({blocks: [{...owned}], ledger, segments: [], proof}), original = x.adapter.remove;
  x.adapter.remove = async () => beforeRequest(async () => { throw Error('release_calendar_changed'); });
  await x.run();
  assert.equal(x.state().attempts[0].state, 'confirmed'); assert.ok(x.state().attempts[0].release_not_submitted_at);
  x.adapter.remove = original; await x.run();
  assert.equal(x.calls.remove, 1); assert.equal(x.state().attempts[0].state, 'released');
});

test('a stay already in progress is closed from today; past days are not required', async () => {
  const x = setup({segments: [{start: '2026-09-10', end: '2026-09-16', causes: ['mmk:1']}]});
  x.adapter.prepare = async (t, gap) => { if (gap.start < '2026-09-13') throw Error('date_disabled_or_ambiguous'); };
  await x.run();
  assert.deepEqual(x.state().attempts.map(a => [a.state, a.start, a.end]), [['confirmed', '2026-09-13', '2026-09-16']]);
  assert.equal(x.state().targets[KEY].state, 'protected');
  // The reported segments stay the plan's own.
  assert.deepEqual(x.state().targets[KEY].segments, [{start: '2026-09-10', end: '2026-09-16', causes: ['mmk:1']}]);
});

test('an unconfirmed write is confirmed although past or distant records left the list; a changed neighbour still blocks', async () => {
  const created = {id: 'mine', start: '2026-12-12', end: '2026-12-19'}, neighbour = {id: 'n', start: '2026-12-19', end: '2026-12-22'};
  const before = [{id: 'past', start: '2026-09-01', end: '2026-09-05'}, {id: 'far', start: '2027-05-01', end: '2027-05-03'}, neighbour];
  const ledger = () => ({version: 1, targets: {}, attempts: [{id: 'p', target: KEY, start: created.start, end: created.end, causes: ['boataround:300000'], before, state: 'pending_readback', created}]});
  const ok = setup({blocks: [created, neighbour], ledger: ledger()});
  await ok.run();
  assert.equal(ok.state().attempts[0].state, 'confirmed'); assert.equal(ok.state().targets[KEY].state, 'protected');
  const changed = setup({blocks: [created], ledger: ledger()});
  await changed.run();
  assert.equal(changed.state().attempts[0].state, 'pending_readback');
  assert.equal(changed.state().targets[KEY].blocked[0].error, 'previous_write_uncertain');
});

test('an unresolved attempt that has wholly passed no longer keeps the target in review', async () => {
  const ledger = {version: 1, targets: {}, attempts: [{id: 'old', target: KEY, start: '2026-09-01', end: '2026-09-05', causes: ['boataround:1'], before: [], state: 'submitting'}]};
  const x = setup({ledger});
  await x.run();
  assert.equal(x.state().targets[KEY].state, 'protected'); assert.equal(x.state().attempts[0].state, 'submitting');
});

test('a day that cannot be closed elsewhere on the listing does not stop an unrelated cancellation from opening', async () => {
  const owned = {id: 'own', start: '2026-12-12', end: '2026-12-19'};
  const ledger = {version: 1, targets: {}, attempts: [{id: 'a', target: KEY, start: owned.start, end: owned.end, causes: ['boataround:9'], before: [], state: 'confirmed', created: {...owned}}]};
  const proof = {ready: true, checked_at: new Date(now).toISOString(), orders: [{key: 'boataround:9', state: 'cancelled'}, {key: 'mmk:2', state: 'active', start: '2027-01-03', end: '2027-01-04'}]};
  const x = setup({blocks: [{...owned}], ledger, segments: [{start: '2027-01-03', end: '2027-01-04', causes: ['mmk:2']}], proof});
  x.adapter.prepare = async () => { throw Error('cb_app_day_before_record'); };
  await x.run();
  assert.equal(x.calls.remove, 1); assert.equal(x.state().attempts[0].state, 'released');
  assert.equal(x.state().targets[KEY].state, 'needs_review');
  assert.deepEqual(x.state().targets[KEY].blocked.map(b => [b.start, b.end]), [['2027-01-03', '2027-01-04']]);
});
