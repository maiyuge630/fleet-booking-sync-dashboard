// MMK became the fourth order source on 2026-10-04 (user decision).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PhoneAgent, SOURCES, requirePaymentEvidence} from '../core.mjs';

const NOW = Date.parse('2026-10-04T08:00:00Z');
const config = {paired: true, device_token: 'x'.repeat(43), name: 'test'};

test('an existing state file without MMK keeps its schedule and switch; MMK starts fresh', async () => {
  assert.deepEqual(SOURCES, ['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys']);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-phone-mmk-'));
  const synced = {state: 'synced', last_success_at: '2026-10-04T07:00:00.000Z', last_attempt_at: '2026-10-04T06:58:00.000Z'};
  const stored = {version: 1, enabled: true, next_run_at: '2026-10-04T10:00:00.000Z', last_run_at: '2026-10-04T07:00:00.000Z',
    last_contact_at: null, last_requested_run_id: null, remote_error: null,
    sources: {boataround: {...synced}, clickandboat: {...synced}, samboat: {...synced}}};
  await fs.writeFile(path.join(home, 'state.json'), JSON.stringify(stored));
  const agent = await new PhoneAgent({home, config, now: () => NOW}).init();
  assert.equal(agent.state.enabled, true); assert.equal(agent.state.next_run_at, stored.next_run_at);
  assert.equal(agent.state.state_recovery, undefined);
  assert.deepEqual(agent.state.sources.boataround, synced);
  assert.deepEqual(agent.state.sources.mmk, {state: 'needs_login', last_success_at: null, last_attempt_at: null});
  assert.deepEqual((await fs.readdir(home)).filter(name => name.startsWith('state-recovery-')), []);
  const saved = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8'));
  assert.equal(saved.enabled, true); assert.equal(saved.sources.mmk.state, 'needs_login');
  // A file that really is damaged is still preserved and reset as before.
  await fs.writeFile(path.join(home, 'state.json'), JSON.stringify({...stored, sources: {...stored.sources, boataround: {state: 'nonsense'}}}));
  const reset = await new PhoneAgent({home, config, now: () => NOW}).init();
  assert.equal(reset.state.enabled, false); assert.equal(reset.state.state_recovery.reason, 'invalid_local_state');
});

test('the phone uploads an active MMK order only with the customer-assigned basis and MMK label', () => {
  const snapshot = orders => ({source: 'mmk', orders});
  const ok = {status: 'accepted', payment_basis: 'mmk_client_assigned', platform_status: 'Reservation'};
  requirePaymentEvidence('mmk', snapshot([ok, {...ok, platform_status: 'Option'}, {status: 'cancelled', platform_status: 'Option expired'}]));
  for (const bad of [{...ok, payment_basis: undefined}, {...ok, platform_status: 'Offer'}, {...ok, status: 'paid'}])
    assert.throws(() => requirePaymentEvidence('mmk', snapshot([bad])), error => error.code === 'schema_changed', JSON.stringify(bad));
});
