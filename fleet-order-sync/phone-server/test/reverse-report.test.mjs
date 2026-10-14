import assert from 'node:assert/strict';
import test from 'node:test';
import {reverseReporter} from '../reverse.mjs';
import {ReverseExecutor} from '../../reverse-sync/executor.mjs';

const NOW = Date.parse('2026-09-29T15:00:00Z'), iso = ms => new Date(ms).toISOString();

test('finished targets are reported at once, only once, and never after the dashboard window', async () => {
  let now = NOW;
  const sent = [], plan = async () => ({generated_at: iso(now), targets: [
    {key: 'a', target: 'clickandboat', listing_id: '100004'}, {key: 'b', target: 'samboat', boat: 'x'}]});
  const report = reverseReporter({plan, request: async (route, body) => sent.push([route, body.targets.map(t => t.key)]), now: () => now});
  const ledger = {targets: {'clickandboat:100004': {state: 'protected', checked_at: iso(now)}}};
  await report(ledger); await report(ledger);
  assert.deepEqual(sent, [['reverse-report', ['a']]]);
  ledger.targets['samboat:missing:x'] = {state: 'needs_review', checked_at: iso(now)};
  now += 11 * 60000; ledger.targets['clickandboat:100004'].checked_at = iso(NOW + 10 * 60000);
  await report(ledger);
  // 'b' is older than ten minutes by now; 'a' has a newer check to report.
  assert.deepEqual(sent.at(-1), ['reverse-report', ['a']]);
});

test('the executor hands each saved target result to afterTarget, and a failing hook changes nothing', async () => {
  let state = null;
  const seen = [], targets = ['1', '2'].map(id => ({target: 'samboat', boat: 'b' + id, listing_id: id, fresh: true, segments: []}));
  const adapter = {async read() { return {complete: true, identity_verified: true, blocks: []}; }, async close() {}};
  const run = hook => new ReverseExecutor({now: () => NOW, load: async () => state, save: async v => { state = structuredClone(v); },
    plan: async () => ({generated_at: iso(NOW), targets: structuredClone(targets)}), adapters: {samboat: adapter}, afterTarget: hook}).run();
  await run(async ledger => seen.push(Object.keys(ledger.targets).length));
  assert.deepEqual(seen, [1, 2]);
  await run(async () => { throw Error('dashboard unreachable'); });
  assert.deepEqual(Object.values(state.targets).map(t => t.state), ['protected', 'protected']);
});
