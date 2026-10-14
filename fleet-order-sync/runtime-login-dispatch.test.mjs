import assert from 'node:assert/strict';
import test from 'node:test';
import { FleetCloudSync } from './cloud-runtime.mjs';

// Route tests use a fake controller and in-memory state; no platform/browser calls.
function harness() {
  const calls = [], values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async transaction(work) { return work(this); },
    async setAlarm() {}, async deleteAlarm() {}
  };
  const controller = {
    async status() { return { active: null }; },
    async nextAlarmAt(at) { return at; },
    async startLogin(source, options) { calls.push(['login', source, options]); return { status: 'login_required' }; },
    async finishLogin(source) { calls.push(['finish', source]); return { status: 'unexpected_finish' }; },
    async resumeLogin(source) { calls.push(['resume', source]); return { status: 'login_required', expiresAt: 200000 }; },
    async cancelLogin(source) { calls.push(['cancel', source]); return { status: 'cancelled' }; }
  };
  return { calls, runtime: new FleetCloudSync({ storage, controller, binding: {}, now: () => 100000,
    registryStatus: async () => ({}), ingest: async () => { throw Error('No ingest expected'); } }) };
}

test('login accepts only an explicit boolean short option and never forwards a client duration', async () => {
  const h = harness();
  const make = (extra, headers = {}) => new Request('https://fixture.invalid/api/cloud-sync/login', {
    method: 'POST', headers: { Origin: 'https://fixture.invalid', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ source: 'boataround', ...extra })
  });
  for (const shortLogin of ['true', 1, null, {}, []]) assert.equal((await h.runtime.handle(make({ shortLogin }))).status, 400);
  assert.equal((await h.runtime.handle(make({ shortLogin: true }, { Origin: 'https://other.invalid' }))).status, 403);
  assert.deepEqual(h.calls, []);
  for (const [extra, expected] of [[{}, false], [{ shortLogin: false }, false], [{ shortLogin: true, workMs: 999999999 }, true]]) {
    assert.equal((await h.runtime.handle(make(extra))).status, 200);
    assert.deepEqual(h.calls.at(-1), ['login', 'boataround', { shortLogin: expected }]);
  }
});

function request(action, source = 'boataround', overrides = {}) {
  const headers = new Headers({ Origin: 'https://fixture.invalid', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' });
  for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
  return new Request('https://fixture.invalid/api/cloud-sync/' + action, { method: 'POST', headers, body: JSON.stringify({ source }) });
}

for (const [action, expectedStatus] of [['resume', 'login_required'], ['cancel', 'cancelled']]) {
  test(action + ' fails closed on CSRF and dispatches only the validated platform to its matching controller method', async () => {
    const h = harness();
    for (const headers of [
      { Origin: 'https://other.invalid' }, { Origin: null },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': null }
    ]) assert.equal((await h.runtime.handle(request(action, 'boataround', headers))).status, 403);
    for (const source of ['unknown', '', null, ['boataround'], { source: 'boataround' }])
      assert.equal((await h.runtime.handle(request(action, source))).status, 400);
    assert.deepEqual(h.calls, [], 'Rejected requests must never touch the browser controller');
    for (const source of ['boataround', 'clickandboat', 'samboat']) {
      const response = await h.runtime.handle(request(action, source));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, expectedStatus);
    }
    assert.deepEqual(h.calls, ['boataround', 'clickandboat', 'samboat'].map(source => [action, source]));
  });
}
