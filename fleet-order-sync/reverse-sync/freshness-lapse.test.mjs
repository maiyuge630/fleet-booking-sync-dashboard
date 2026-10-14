// Source freshness lapses 10 minutes after collection. A long run (Click&Boat
// app targets, 2026-09-29) outlasted it: the last targets failed as
// source_changed_or_stale on every run because they were always visited last.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ReverseExecutor} from './executor.mjs';

const NOW = Date.parse('2026-09-29T15:00:00Z'), iso = ms => new Date(ms).toISOString();
const target = id => ({target: 'samboat', boat: 'b' + id, listing_id: id, fresh: true, segments: [{start: '2026-12-01', end: '2026-12-03', causes: ['boataround:' + id]}]});

function setup(freshness, ledger = null) {
  let state = ledger, plans = 0;
  const reads = [], writes = [];
  const adapter = {
    async read(t) { reads.push(t.listing_id); return {complete: true, identity_verified: true, blocks: writes.filter(w => w.listing === t.listing_id).map(w => w.block)}; },
    async prepare() {},
    async submit(t, gap) { const block = {id: 'w' + t.listing_id, ...gap}; writes.push({listing: t.listing_id, block}); return block; },
    async close() {}};
  // freshness(n, ledger) gives the plan state: 'fresh', 'close' or 'stale'.
  const plan = async () => {
    const f = freshness(++plans, state);
    return {generated_at: iso(NOW), targets: ['1', '2', '3'].map(id => ({...target(id), fresh: f === 'fresh', close_ready: f === 'close', stale_sources: f === 'fresh' ? [] : ['boataround']}))};
  };
  const executor = new ReverseExecutor({now: () => NOW, load: async () => structuredClone(state), save: async v => { state = structuredClone(v); }, plan, adapters: {samboat: adapter}});
  return {run: () => executor.run(), state: () => state, reads, writes, plans: () => plans};
}

test('a target reached after freshness lapsed is deferred without being read, and goes first next run', async () => {
  // Freshness lapses as soon as the first target's result is saved.
  let lapses = true;
  const x = setup((n, ledger) => lapses && ledger?.targets?.['samboat:1'] ? 'stale' : 'fresh');
  await x.run();
  const states = Object.fromEntries(Object.entries(x.state().targets).map(([k, v]) => [k, v.state]));
  assert.deepEqual(states, {'samboat:1': 'protected', 'samboat:2': 'deferred', 'samboat:3': 'deferred'});
  assert.deepEqual([...new Set(x.reads)], ['1']);
  // Next run, fresh throughout: the deferred targets come before the one checked last time.
  lapses = false; x.reads.length = 0;
  await x.run();
  assert.deepEqual([...new Set(x.reads)], ['2', '3', '1']);
});

test('a target reached while only close-only is allowed still gets its missing protection', async () => {
  const x = setup(n => n <= 1 ? 'fresh' : 'close');
  await x.run();
  for (const id of ['1', '2', '3']) assert.equal(x.state().targets['samboat:' + id].state, 'protected_partial');
  assert.equal(x.writes.length, 3);
});

test('a run that starts fresh keeps its old behavior while the plan stays fresh', async () => {
  const x = setup(() => 'fresh');
  await x.run();
  for (const id of ['1', '2', '3']) assert.equal(x.state().targets['samboat:' + id].state, 'protected');
  assert.deepEqual(x.reads.filter((v, i, a) => a.indexOf(v) === i), ['1', '2', '3']);
});
