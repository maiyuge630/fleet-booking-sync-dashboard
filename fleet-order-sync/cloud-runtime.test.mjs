import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { FleetCloudSync } from './cloud-runtime.mjs';
import { FleetPhoneAgent, isPhoneMachinePath, isPhoneUserPath } from './phone-agent.mjs';
import { beijingDay } from './cloud-browser.mjs';
import { FLEET } from './parsers.mjs';
const { createOrderRegistry } = createRequire(import.meta.url)('./worker/dynamic-registry.cjs');

const CONFIG = 'cloud-sync:config';
const LAST = 'cloud-sync:last-run';
const base = Date.parse('2026-09-10T08:00:00Z');
const interval = 6 * 3600000;
const allSources = ['boataround', 'clickandboat', 'samboat'];
class MemoryStorage {
  data = new Map(); alarm = null; queue = Promise.resolve();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
  transaction(work) { const result = this.queue.then(() => work(this)); this.queue = result.catch(() => {}); return result; }
}
function bucket() {
  let serial = 0;
  const files = new Map();
  return {
    async get(key) { const item = files.get(key); return item ? { etag: item.etag, json: async () => JSON.parse(item.text) } : null; },
    async put(key, text, options = {}) {
      const old = files.get(key), check = options.onlyIf;
      if (check instanceof Headers && check.get('If-None-Match') === '*' && old) return null;
      if (check && !(check instanceof Headers) && check.etagMatches !== old?.etag) return null;
      const etag = `fixture-${++serial}`; files.set(key, { etag, text }); return { etag };
    },
  };
}
function request(path, body = {}, overrides = {}) {
  return new Request(`https://fixture.invalid/api/cloud-sync/${path}`, { method: 'POST',
    headers: { Origin: 'https://fixture.invalid', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...overrides.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')) });
}
function harness({ binding = {}, now = base } = {}) {
  let clock = now;
  const storage = new MemoryStorage(), calls = [];
  const initialRecords = Object.fromEntries(allSources.map((source,index) => [source, [{ booking_id: String(99000074+index),
    boataround_slug: FLEET[0].slug, start: '2026-10-17', end: '2026-10-24', status: 'paid', url: 'https://fixture.invalid/detail' }]]));
  const registry = createOrderRegistry({ bucket: bucket(), now: () => clock,
    normalizeBooking: (source, record) => ({ ...record, source }),
    fleetSpecs: FLEET.map(boat => ({ ...boat, boataround_slug: boat.slug })),
    bootstrapMap: { ...initialRecords, mapping_updated_at: new Date(now - 60000).toISOString() } });
  const cloud = { active: null, budget: { remainingMs: 480000 }, sources: Object.fromEntries(allSources.map(source => [source, { status: 'connected' }])) };
  let response = { status: 'finished', sources: Object.fromEntries(allSources.map(source => [source, { status: 'auth_required' }])) };
  const controller = {
    async status() { return { ...structuredClone(cloud), nextSyncAt: clock + interval }; },
    async nextAlarmAt(at) { return Math.max(clock + 1000, Math.min(at, cloud.active?.deadlineAt ?? Infinity)); },
    async closeExpiredSession() { calls.push('closeExpired'); if (cloud.active?.deadlineAt <= clock) cloud.active = null; },
    async startLogin(source) { calls.push(['login', source]); cloud.active = { kind: 'login', source, deadlineAt: clock + 120000 };
      return { status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=SECRET_LIVE', expiresAt: clock + 120000, deadlineAt: clock + 120000 }; },
    async finishLogin(source, verifier) { assert.equal(typeof verifier, 'function'); calls.push(['finish', source]); cloud.active = null; return { status: 'connected' }; },
    async runSync({ kind, collectors, verifyAuth }) { calls.push(['run', kind]); assert.equal(typeof collectors.boataround, 'function'); assert.equal(typeof verifyAuth.samboat, 'function'); return structuredClone(response); },
  };
  const options = { storage, binding, now: () => clock, controller,
    registryStatus: () => registry.status(),
    ingest: async payload => { calls.push(['ingest', structuredClone(payload)]); return registry.ingestBatch(payload); } };
  return { runtime: new FleetCloudSync(options), options, storage, calls, registry, cloud, controller, initialRecords,
    setResponse: value => { response = value; }, advance: ms => { clock += ms; }, time: () => clock,
    snapshot: (source, orders) => ({ source, run_id: `success-${source}-${clock}`, checked_at: new Date(clock).toISOString(), complete: true,
      scope: { kind: 'current_future', from_day: beijingDay(clock), fleet_slugs: FLEET.map(boat => boat.slug) },
      pagination: { complete: true, total_pages: 1, pages_read: [1], listed_count: orders.length }, expected_count: orders.length, orders }),
  };
}

test('status starts disabled, with no fabricated last run or successful platform time', async () => {
  const h = harness();
  const response = await h.runtime.handle(new Request('https://fixture.invalid/api/cloud-sync/status'));
  const body = await response.json();
  assert.equal(body.automatic_enabled, false);
  assert.equal(body.last_run, null);
  assert.ok(allSources.every(source => body.order_sync.platforms[source].last_success_at === null));
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});

test('manual queue returns 202 without collecting, ingesting, or advancing success', async () => {
  const h = harness();
  const response = await h.runtime.handle(request('run'));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'queued' });
  assert.equal((await h.storage.get(CONFIG)).manualPending, true);
  assert.equal(h.storage.alarm, base + 1000);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.get(LAST), undefined);
  assert.equal((await h.registry.status()).last_all_platforms_success_at, null);
});

test('queued work survives coordinator reconstruction and is durably claimed once', async () => {
  const h = harness();
  await h.runtime.handle(request('run'));
  const restarted = new FleetCloudSync(h.options);
  await restarted.alarm();
  await restarted.alarm();
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'run').length, 1);
  assert.equal((await h.storage.get(CONFIG)).manualPending, false);
  assert.equal(h.storage.alarm, null);
});

function assertFailedSourceRecords(before,after,source) {
  if(source!=='clickandboat'){assert.deepEqual(after,before);return;}
  const manual=before.filter(record=>record.booking_id==='1000000');
  assert.equal(manual.length,1);
  assert.equal(manual[0].start,'2027-03-06');assert.equal(manual[0].end,'2027-03-13');
  assert.equal(manual[0].amount,'€4,200.00');
  const expected=structuredClone(before);
  const adjustment=expected.find(record=>record.booking_id==='1000000').manual_adjustment;
  // A platform failure changes only the manual verification health. Compare
  // the complete array so ordinary records, dates, money, payment evidence,
  // original dates and the last actual verification cannot change unnoticed.
  adjustment.verification_status='needs_review';
  adjustment.review_reason='source_sync_failed';
  assert.deepEqual(after,expected);
}

test('source failures preserve order data and success times while flagging manual verification for review', async () => {
  const h = harness();
  const before = await h.registry.registry();
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  const after = await h.registry.registry();
  for (const source of allSources) assertFailedSourceRecords(before[source],after[source],source);
  const status = await h.registry.status();
  assert.ok(allSources.every(source => status.platforms[source].last_error === 'auth_required'));
  assert.ok(allSources.every(source => status.platforms[source].last_success_at === null));
});

test('mixed result replaces only the complete successful source; failed sources retain orders', async () => {
  const h = harness();
  const before = await h.registry.registry();
  h.setResponse({ status: 'finished', sources: {
    boataround: { status: 'collected', snapshot: h.snapshot('boataround', [{ ...h.initialRecords.boataround[0], status: 'cancelled', platform_status: 'CANCELLED' }]) },
    clickandboat: { status: 'timed_out' }, samboat: { status: 'auth_required' },
  } });
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  const after = await h.registry.registry();
  assert.equal(after.boataround[0].status, 'cancelled');
  assertFailedSourceRecords(before.clickandboat,after.clickandboat,'clickandboat');
  assert.deepEqual(after.samboat, before.samboat);
  assert.equal((await h.registry.status()).platforms.boataround.last_success_at, new Date(base).toISOString());
});

test('incomplete collected snapshot is rejected by the registry and cannot clear orders', async () => {
  const h = harness();
  const before = await h.registry.registry();
  const incomplete = h.snapshot('boataround', []);
  incomplete.pagination.pages_read = [];
  h.setResponse({ status: 'finished', sources: { boataround: { status: 'collected', snapshot: incomplete } } });
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  assert.deepEqual((await h.registry.registry()).boataround, before.boataround);
  assert.equal((await h.registry.status()).platforms.boataround.last_success_at, null);
});

test('automatic alarm advances its durable next attempt by six hours and closes before collection', async () => {
  const h = harness();
  await h.runtime.handle(request('config', { enabled: true }));
  assert.equal(h.storage.alarm, base + 1000);
  h.advance(1000);
  await h.runtime.alarm();
  assert.equal((await h.storage.get(CONFIG)).nextAttemptAt, h.time() + interval);
  assert.equal(h.storage.alarm, h.time() + interval);
  const runAt = h.calls.findIndex(call => Array.isArray(call) && call[0] === 'run');
  const ingestAt = h.calls.findIndex(call => Array.isArray(call) && call[0] === 'ingest');
  assert.ok(h.calls.indexOf('closeExpired') < runAt && runAt < ingestAt);
  assert.equal(h.calls[runAt][1], 'scheduled');
});

test('pending sync waits at a live login deadline without one-second alarm churn', async () => {
  const h = harness();
  await h.runtime.handle(request('login', { source: 'boataround' }));
  await h.runtime.handle(request('run'));
  assert.equal(h.storage.alarm, base + 120000);
  await h.runtime.alarm();
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'run').length, 0);
  assert.equal(h.storage.alarm, base + 120000);
  h.advance(120000);
  await h.runtime.alarm();
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'run').length, 1);
});

test('pausing automatic work preserves the login stop alarm, then deletes idle alarms', async () => {
  const h = harness();
  await h.runtime.handle(request('config', { enabled: true }));
  await h.runtime.handle(request('login', { source: 'samboat' }));
  await h.runtime.handle(request('config', { enabled: false }));
  assert.equal(h.storage.alarm, base + 120000);
  h.advance(120000);
  await h.runtime.alarm();
  assert.equal(h.storage.alarm, null);
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'run').length, 0);
});

test('cross-origin, missing browser origin metadata, and form content are rejected before mutation', async () => {
  const h = harness();
  for (const headers of [
    { Origin: 'https://evil.invalid' }, { Origin: '' },
    { 'Sec-Fetch-Site': '' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await h.runtime.handle(request('run', {}, { headers }))).status, 403);
  assert.equal((await h.runtime.handle(request('run', {}, { headers: { 'Content-Type': 'text/plain' } }))).status, 415);
  assert.equal(await h.storage.get(CONFIG), undefined);
  assert.equal(h.calls.length, 0);
});

test('invalid JSON, arrays, oversized streaming bodies, unknown sources and unsupported methods do not execute', async () => {
  const h = harness();
  assert.equal((await h.runtime.handle(request('run', '{'))).status, 400);
  assert.equal((await h.runtime.handle(request('run', '[]'))).status, 400);
  assert.equal((await h.runtime.handle(request('run', JSON.stringify({ pad: 'x'.repeat(4097) })))).status, 413);
  assert.equal((await h.runtime.handle(request('login', { source: 'https://evil.invalid' }))).status, 400);
  assert.equal((await h.runtime.handle(new Request('https://fixture.invalid/api/cloud-sync/run'))).status, 405);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.get(CONFIG), undefined);
});

test('cloud login capability appears only in its response, never persisted status or config', async () => {
  const h = harness();
  const response = await h.runtime.handle(request('login', { source: 'boataround' }));
  assert.match((await response.json()).liveViewUrl, /SECRET_LIVE/);
  assert.ok(!JSON.stringify(await h.runtime.status()).includes('SECRET_LIVE'));
  assert.ok(!JSON.stringify([...h.storage.data.entries()]).includes('SECRET_LIVE'));
  const done = await h.runtime.handle(request('finish', { source: 'boataround' }));
  assert.deepEqual(await done.json(), { status: 'connected' });
  assert.equal(h.storage.alarm, null);
});

test('unconfigured browser rejects mutations and does not pretend automatic mode is enabled', async () => {
  const h = harness({ binding: null });
  assert.equal((await h.runtime.handle(request('run'))).status, 503);
  assert.equal((await h.runtime.handle(request('config', { enabled: true }))).status, 503);
  assert.equal((await h.runtime.status()).configured, false);
  assert.equal((await h.runtime.status()).automatic_enabled, false);
  assert.equal(h.calls.length, 0);
});

test('unexpected controller failure persists a sanitized failure and retains original orders', async () => {
  const h = harness();
  const before = await h.registry.registry();
  h.controller.runSync = async () => { throw new Error('SECRET_AUTH_TOKEN'); };
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  const last = await h.storage.get(LAST);
  assert.equal(last.status, 'failed');
  assert.ok(!JSON.stringify(last).includes('SECRET'));
  assert.deepEqual(await h.registry.registry(), before);
});

test('concurrent alarm delivery does not duplicate an in-progress collection', async () => {
  const h = harness();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let count = 0;
  h.controller.runSync = async () => { count++; entered(); await wait; return { status: 'skipped', reason: 'daily_budget' }; };
  await h.runtime.handle(request('run'));
  const first = h.runtime.alarm();
  await started;
  await h.runtime.alarm();
  release();
  await first;
  assert.equal(count, 1);
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'ingest').length, 0);
});

test('runtime component requires an authenticated outer route; same-origin headers alone are not authentication', async () => {
  const h = harness();
  // Documents the integration boundary; the final worker must prevent an
  // anonymous request from reaching this internal method at all.
  assert.equal(request('run').headers.get('Cookie'), null);
  assert.equal((await h.runtime.handle(request('run'))).status, 202);
});

test('Beijing-day snapshot remains valid after UTC16:00', async () => {
  const h = harness({ now: Date.parse('2026-09-10T17:00:00Z') });
  const paidFixtures=h.initialRecords.boataround.map(record=>({...record,platform_status:'CONFIRMED',customer_payment:'PAID'}));
  h.setResponse({ status: 'finished', sources: { boataround: { status: 'collected', snapshot: h.snapshot('boataround', paidFixtures) } } });
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  assert.equal((await h.registry.status()).platforms.boataround.last_success_at, new Date(h.time()).toISOString());
});

test('last-run accepted sources do not treat accepted failure metadata as successful snapshots', async () => {
  const h = harness();
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  assert.deepEqual((await h.storage.get(LAST)).accepted, []);
});

async function authenticatedIntegratedFixture() {
  const source = fs.readFileSync(new URL('./integrated-source.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ DurableObject: class {}, puppeteer: {}, FleetCloudSync, FleetPhoneAgent, isPhoneMachinePath, isPhoneUserPath,
    TextEncoder, TextDecoder, Response, Request, Headers, URL, URLSearchParams, structuredClone, crypto: webcrypto,
    AbortSignal, console, fetch: () => { throw new Error('No network allowed in integration tests'); } });
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, '').replace(/^export\s*\{[\s\S]*?\};\s*$/m, ''), context);
  const h = harness();
  const config = { username: 'fixture-only@example.invalid', iterations: 100000,
    salt: '11'.repeat(32), pepper: '22'.repeat(32), verifier: '00'.repeat(32) };
  const password = 'fictional-local-fixture-password';
  config.verifier = Buffer.from(await context.passwordVerifier(password, config)).toString('hex');
  const env = { BUCKET: bucket(), FLEET_AUTH_CONFIG: JSON.stringify(config), CLOUD_SYNC: h.runtime };
  env.PHONE_AGENT=new FleetPhoneAgent({storage:h.storage,ingest:()=>{throw Error('No machine ingest expected');},registryStatus:()=>h.registry.status()});
  const login = await context.server_default.fetch(new Request('https://fixture.invalid/auth/login', { method: 'POST',
    headers: { Origin: 'https://fixture.invalid', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.username, password }).toString() }), env);
  assert.equal(login.status, 303);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  return { ...h, cookie, dispatch: req => context.server_default.fetch(req, env) };
}

test('integrated worker rejects anonymous cloud status, queue, login, finish and config before runtime access', async () => {
  const h = await authenticatedIntegratedFixture();
  const requests = [new Request('https://fixture.invalid/api/cloud-sync/status'), request('run'),
    request('login', { source: 'boataround' }), request('finish', { source: 'boataround' }), request('config', { enabled: true })];
  for (const req of requests) assert.equal((await h.dispatch(req)).status, 401);
  assert.equal((await h.dispatch(new Request('https://fixture.invalid/sync'))).status, 303);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.get(CONFIG), undefined);
});

test('integrated authenticated route still enforces CSRF, then admits only the valid queued mutation', async () => {
  const h = await authenticatedIntegratedFixture();
  assert.equal((await h.dispatch(request('run', {}, { headers: { Cookie: 'fleet_session=forged' } }))).status, 401);
  assert.equal((await h.dispatch(request('run', {}, { headers: { Cookie: h.cookie, Origin: 'https://evil.invalid' } }))).status, 403);
  assert.equal((await h.dispatch(request('run', {}, { headers: { Cookie: h.cookie, 'Sec-Fetch-Site': '' } }))).status, 403);
  assert.equal(await h.storage.get(CONFIG), undefined);
  const queued = await h.dispatch(request('run', {}, { headers: { Cookie: h.cookie } }));
  assert.equal(queued.status, 202);
  assert.deepEqual(await queued.json(), { status: 'queued' });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.storage.get(CONFIG)).manualPending, true);
});

test('manual launch-rate skip retains its queue and retries at retryAt while automatic mode stays disabled', async () => {
  const h = harness();
  h.setResponse({ status: 'skipped', reason: 'launch_rate_limit', retryAt: base + 20000 });
  await h.runtime.handle(request('run'));
  await h.runtime.alarm();
  const queued = await h.storage.get(CONFIG);
  assert.equal(queued.enabled, false);
  assert.equal(queued.manualPending, true);
  assert.equal(queued.manualNotBefore, base + 20000);
  assert.equal(h.storage.alarm, base + 20000);
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'ingest').length, 0);
  h.advance(19000);
  await h.runtime.alarm();
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'run').length, 1);
  assert.equal(h.storage.alarm, base + 20000);
  h.setResponse({ status: 'auth_required', sources: Object.fromEntries(allSources.map(source => [source, { status: 'auth_required' }])) });
  h.advance(1000);
  await h.runtime.alarm();
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'run').length, 2);
  assert.equal((await h.storage.get(CONFIG)).manualPending, false);
  assert.equal((await h.storage.get(CONFIG)).enabled, false);
  assert.equal(h.storage.alarm, null);
});
