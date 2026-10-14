import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Exercise the auth code that is actually bundled. All credentials, cookies,
// storage and time below are synthetic; no network or production secrets are used.
const source = fs.readFileSync(new URL('./integrated-source.mjs', import.meta.url), 'utf8');
const begin = 'var SECURITY_HEADERS =', end = 'var CACHE_KEY =';
assert.equal(source.split(begin).length, 2, 'Auth start must remain unambiguous');
assert.equal(source.split(end).length, 2, 'Auth end must remain unambiguous');
const authSource = source.slice(source.indexOf(begin), source.indexOf(end));
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ISSUED_AT = Date.UTC(2026, 8, 13, 0, 0, 0);
const ORIGIN = 'https://fleet-auth-fixture.example';
const PASSWORD = 'synthetic-auth-regression-password';

async function fixture() {
  let now = ISSUED_AT, sequence = 0, failReads = false, runtime;
  const rows = new Map();
  const bucket = {
    async get(key) {
      if (failReads) throw new Error('Synthetic storage unavailable');
      const row = rows.get(key);
      return row ? { etag: row.etag, json: async () => JSON.parse(row.value) } : null;
    },
    async put(key, value, options = {}) {
      const prior = rows.get(key), condition = options.onlyIf;
      if (condition instanceof Headers && condition.get('If-None-Match') === '*' && prior) return null;
      if (condition?.etagMatches && prior?.etag !== condition.etagMatches) return null;
      const etag = `synthetic-etag-${++sequence}`;
      rows.set(key, { value, etag });
      return { etag };
    },
    async delete(key) { rows.delete(key); },
  };
  function restart() {
    runtime = vm.createContext({
      Request, Response, Headers, TextEncoder, TextDecoder, URL, URLSearchParams,
      crypto: webcrypto, Date: class extends Date { static now() { return now; } },
      __name: value => value,
      LOGIN_HTML: '<!--LOGIN_ERROR--> __LOGIN_USERNAME__ __REMEMBER_CHECKED__',
    });
    vm.runInContext(authSource, runtime, { filename: 'generated-dashboard-auth-fixture.js' });
  }
  restart();
  const config = { username: 'customer1@example.invalid', iterations: 100000,
    salt: 'a'.repeat(64), pepper: 'b'.repeat(64), verifier: 'c'.repeat(64) };
  config.verifier = Buffer.from(await runtime.passwordVerifier(PASSWORD, config)).toString('hex');
  const env = { BUCKET: bucket, FLEET_AUTH_CONFIG: JSON.stringify(config) };
  const request = (path, options = {}) => new Request(ORIGIN + path, options);
  return {
    rows, restart, at: value => { now = value; }, failReads: value => { failReads = value; },
    gate: (path, options = {}) => runtime.authGate(request(path, options), env),
    async login({ remember = false, password = PASSWORD } = {}) {
      return runtime.authGate(request('/auth/login', {
        method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: config.username, password, ...(remember ? { remember: '1' } : {}) }),
      }), env);
    },
  };
}

function acceptedCookie(response) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/');
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-fleet_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  return { cookie, headers: { Cookie: cookie.split(';')[0] } };
}

test('dashboard remember-me creates a 30-day cookie and survives 1h/2h/11h/12h and isolate recreation', async () => {
  const f = await fixture(), { cookie, headers } = acceptedCookie(await f.login({ remember: true }));
  assert.match(cookie, /; Max-Age=2592000(?:;|$)/);
  assert.ok(cookie.includes(`; Expires=${new Date(ISSUED_AT + 30 * DAY).toUTCString()}`));
  const session = JSON.parse([...f.rows.entries()].find(([key]) => key.startsWith('auth/sessions/'))[1].value);
  assert.equal(session.issuedAt, ISSUED_AT);
  assert.equal(session.expiresAt, ISSUED_AT + 30 * DAY);
  assert.equal(session.rememberMe, true);
  for (const age of [0, HOUR, 2 * HOUR, 11 * HOUR, 12 * HOUR, 29 * DAY, 30 * DAY - 1]) {
    f.at(ISSUED_AT + age); f.restart();
    assert.equal(await f.gate('/api/data', { headers }), null, `Session must be valid at age ${age}`);
  }
  f.at(ISSUED_AT + 30 * DAY); f.restart();
  assert.equal((await f.gate('/api/data', { headers })).status, 401);
});

test('dashboard ordinary login remains valid past 1h/2h/11h and expires exactly at 12h', async () => {
  const f = await fixture(), { cookie, headers } = acceptedCookie(await f.login());
  assert.doesNotMatch(cookie, /Max-Age=|Expires=/);
  for (const age of [0, HOUR, 2 * HOUR, 11 * HOUR, 12 * HOUR - 1]) {
    f.at(ISSUED_AT + age); f.restart();
    assert.equal(await f.gate('/api/data', { headers }), null, `Session must be valid at age ${age}`);
  }
  f.at(ISSUED_AT + 12 * HOUR); f.restart();
  assert.equal((await f.gate('/api/data', { headers })).status, 401);
});

test('dashboard logout revokes the current remembered session and clears its cookie', async () => {
  const f = await fixture(), { headers } = acceptedCookie(await f.login({ remember: true }));
  assert.equal(await f.gate('/api/data', { headers }), null);
  const response = await f.gate('/auth/logout', { method: 'POST', headers: { ...headers, Origin: ORIGIN } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/login');
  assert.match(response.headers.get('Set-Cookie'), /__Host-fleet_session=;.*Max-Age=0/);
  f.restart();
  assert.equal((await f.gate('/api/data', { headers })).status, 401);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('auth/sessions/')).length, 0);
});

test('dashboard rejects a wrong password without creating or saving a session', async () => {
  const f = await fixture(), response = await f.login({ password: 'wrong-synthetic-password', remember: true });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('auth/sessions/')).length, 0);
});

test('dashboard storage read failure returns 503, preserves the session, and recovers without login', async () => {
  const f = await fixture(), { headers } = acceptedCookie(await f.login({ remember: true }));
  const previous = [...f.rows.entries()];
  f.failReads(true); f.restart();
  for (const path of ['/api/data', '/']) {
    const response = await f.gate(path, { headers });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Location'), null);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  assert.deepEqual([...f.rows.entries()], previous);
  f.failReads(false); f.at(ISSUED_AT + 2 * HOUR); f.restart();
  assert.equal(await f.gate('/api/data', { headers }), null);
});
