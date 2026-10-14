// Phone runtime fixes from the 2026-10-04 review: a snapshot the Worker keeps
// refusing no longer stops a source or every calendar; a run that dies early
// does not restart every five seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PhoneAgent, loadConfiguration, SOURCES} from '../core.mjs';

const NOW = Date.parse('2026-10-04T08:00:00Z');
const snapshot = (source, stamp = NOW) => ({source, run_id: source + '-' + stamp, checked_at: new Date(stamp).toISOString(), complete: true, orders: [], pagination: {complete: true}});
async function fixture(t, {upload, reverseSync = null, now = () => NOW} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-audit-'));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const config = await loadConfiguration(home); config.paired = true;
  const received = [];
  const remote = {upload: async payload => { received.push(payload); return upload(payload); }, heartbeat: async () => ({ok: true}), poll: async () => ({ok: true, enabled: true, requested_run_id: null})};
  const page = {setViewport: async () => {}, close: async () => {}};
  const browser = {connected: true, newPage: async () => ({...page}), close: async () => {}, process: () => ({kill: () => {}})};
  const collectors = Object.fromEntries(SOURCES.map(source => [source, async () => snapshot(source, now())]));
  const agent = await new PhoneAgent({home, config, remote, collectors, verifyAuth: {}, platformUrls: {}, browserFactory: async () => browser, now, reverseSync}).init();
  return {agent, home, received};
}
const files = async (home, dir) => (await fs.readdir(path.join(home, dir)).catch(() => [])).filter(f => f.endsWith('.json'));
const accept = payload => ({results: payload.snapshots.map(s => ({source: s.source, accepted: true, outcome: 'success'}))});

test('a run-ID conflict (409) is a permanent refusal, not an endless retry', async t => {
  const x = await fixture(t, {upload: payload => ({results: payload.snapshots.map(s => s.source === 'mmk'
    ? {source: 'mmk', accepted: false, status: 409, error: '同一运行编号不能提交不同快照'} : {source: s.source, accepted: true, outcome: 'success'})})});
  await x.agent.run();
  assert.deepEqual(await files(x.home, 'outbox'), []);
  assert.equal((await files(x.home, 'rejected')).length, 1);
  assert.equal(x.agent.state.sources.mmk.state, 'rejected');
});

test('an older snapshot the Worker refuses three times gives way to a newer one; an outage does not', async t => {
  let clock = NOW, refuse = true;
  const x = await fixture(t, {now: () => clock, upload: payload => {
    const s = payload.snapshots[0];
    if (s.source === 'mmk' && refuse && s.checked_at === new Date(NOW).toISOString()) return {results: [{source: 'mmk', accepted: false, status: 503, error: 'storage'}]};
    return accept(payload);
  }});
  await x.agent.run();
  const [stuck] = await files(x.home, 'outbox');
  assert.ok(stuck);
  for (let i = 0; i < 2; i++) { clock += 7 * 3600000; await x.agent.flush({retrySource: 'mmk'}); }
  // A newer MMK snapshot arrives; the refused older one is set aside.
  clock += 3 * 3600000; await x.agent.enqueue(snapshot('mmk', clock)); await x.agent.flush();
  assert.deepEqual(await files(x.home, 'outbox'), []);
  assert.ok((await files(x.home, 'rejected')).some(f => f.startsWith('superseded-')));
  assert.equal(x.agent.state.sources.mmk.state, 'synced');
  // No answer at all (network) never counts as a refusal: nothing is set aside.
  const y = await fixture(t, {now: () => clock, upload: () => { throw Object.assign(Error('offline'), {name: 'TypeError'}); }});
  await y.agent.enqueue(snapshot('mmk', clock - 3600000));
  for (let i = 0; i < 4; i++) { clock += 7 * 3600000; await y.agent.flush({retrySource: 'mmk'}); }
  await y.agent.enqueue(snapshot('mmk', clock)); await y.agent.flush();
  assert.equal((await files(y.home, 'outbox')).length, 2); assert.deepEqual(await files(y.home, 'rejected'), []);
});

test('while a refused upload waits, calendar sync still adds protection close-only; delivered uploads mean a full sync', async t => {
  const calls = [];
  let clock = NOW;
  const x = await fixture(t, {now: () => clock, reverseSync: async (agent, options = {}) => { calls.push(options.closeOnly === true); return {state: 'checked'}; },
    upload: payload => payload.snapshots[0].source === 'mmk' ? {results: [{source: 'mmk', accepted: false, status: 503, error: 'storage'}]} : accept(payload)});
  await x.agent.run();
  // First failure is recent and tried once: still deferred, as before.
  assert.deepEqual(calls, []); assert.equal(x.agent.state.reverse_pending_upload, true);
  clock += 3 * 3600000; await x.agent.run();
  assert.deepEqual(calls, [true]); assert.equal(x.agent.state.reverse_sync.close_only_reason, 'upload_pending');
  const y = await fixture(t, {reverseSync: async (agent, options = {}) => { calls.push(options.closeOnly === true); return {state: 'checked'}; }, upload: accept});
  await y.agent.run();
  assert.deepEqual(calls, [true, false]);
});

test('a refused source collected in the middle of a run also goes close-only; set-aside snapshots pass on their refusals (2026-10-09)', async t => {
  for (const source of SOURCES) {
    const calls = [];
    let clock = NOW;
    const x = await fixture(t, {now: () => clock, reverseSync: async (agent, options = {}) => { calls.push(options.closeOnly === true); return {state: 'checked'}; },
      upload: payload => payload.snapshots[0].source === source ? {results: [{source, accepted: false, status: 503, error: 'storage'}]} : accept(payload)});
    await x.agent.run();
    for (let run = 0; run < 3; run++) { clock += 3 * 3600000; await x.agent.run(); }
    assert.deepEqual(calls, [true, true, true], source);
    assert.equal((await files(x.home, 'outbox')).length <= 2, true, source);
  }
});

test('a run that dies early waits 15 minutes instead of restarting every tick', async t => {
  const x = await fixture(t, {upload: accept});
  x.agent.enqueue = async () => { throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); };
  x.agent.state.next_run_at = new Date(NOW - 1000).toISOString();
  await x.agent.tick();
  assert.equal(x.agent.state.next_run_at, new Date(NOW + 15 * 60000).toISOString());
  assert.equal(x.agent.state.run_error.code, 'ENOSPC');
  let runs = 0; const run = x.agent.run.bind(x.agent); x.agent.run = async (...args) => { runs++; return run(...args); };
  await x.agent.tick();
  assert.equal(runs, 0);
});
