// 2026-09-29: Click&Boat began answering the phone's automated browser with
// Cloudflare's "Just a moment…" check (HTTP 403, cf-mitigated: challenge).
// It must be reported as its own reason, not as a generic network failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import {collectClickAndBoat, isAccessChallenge, LIST_URL} from './clickandboat.mjs';
import {ClickAndBoatAdapter} from '../reverse-sync/clickandboat-adapter.mjs';
import {collectBoataround, BOATAROUND_ORDERS_URL} from './boataround.mjs';
import {validateSamBoatResponse} from './samboat.mjs';
import {FLEET} from '../parsers.mjs';

const response = (status, headers = {}, url = LIST_URL) => ({status: () => status, headers: () => ({'content-type': 'text/html; charset=UTF-8', ...headers}), url: () => url});
const challenge = url => response(403, {'cf-mitigated': 'challenge', server: 'cloudflare'}, url);

test('only a 403 marked by Cloudflare as a challenge counts as an access check', () => {
  assert.equal(isAccessChallenge(challenge()), true);
  assert.equal(isAccessChallenge(response(403, {'cf-mitigated': ' Challenge '})), true);
  assert.equal(isAccessChallenge(response(403)), false);
  assert.equal(isAccessChallenge(response(200, {'cf-mitigated': 'challenge'})), false);
  assert.equal(isAccessChallenge(response(503, {'cf-mitigated': 'challenge'})), false);
  assert.equal(isAccessChallenge(null), false);
});

test('the order collector stops at the check page with challenge_required and keeps the last orders', async () => {
  let gotos = 0;
  const page = {setCacheEnabled: async () => {}, goto: async () => { gotos++; return challenge(); }};
  await assert.rejects(collectClickAndBoat({page, fromDay: '2026-09-28', deadlineAt: Date.now() + 60000}),
    error => error.code === 'challenge_required' && /人工完成访问验证/.test(error.message));
  assert.equal(gotos, 1);
});

test('an ordinary 403 is still a generic read failure', async () => {
  const page = {setCacheEnabled: async () => {}, goto: async () => response(403)};
  await assert.rejects(collectClickAndBoat({page, fromDay: '2026-09-28', deadlineAt: Date.now() + 60000}), error => error.code === 'fetch_failed');
});

test('Boataround and SamBoat pages report the same check instead of a login or network fault', async () => {
  const page = {setCacheEnabled: async () => {}, on() {}, off() {}, waitForFunction: () => new Promise(() => {}), goto: async url => challenge(url)};
  await assert.rejects(collectBoataround({page, fromDay: '2026-09-28', deadlineAt: Date.now() + 60000}), error => error.code === 'challenge_required');
  const samboat = 'https://www.samboat.com/private/reservations/confirmed';
  assert.throws(() => validateSamBoatResponse(challenge(samboat)), error => error.code === 'challenge_required');
  assert.throws(() => validateSamBoatResponse(response(403, {}, samboat)), error => error.code === 'fetch_failed');
  assert.ok(BOATAROUND_ORDERS_URL.startsWith('https://partner.boataround.com/'));
});

test('the calendar adapter reports platform_challenge before reading any calendar', async () => {
  const boat = FLEET.find(b => b.clickandboat_id);
  const page = {setCacheEnabled: async () => {}, goto: async url => challenge(url), waitForFunction: async () => { throw Error('must not wait on a check page'); }};
  const adapter = new ClickAndBoatAdapter({openPage: async () => page, closePage: async () => {}});
  await assert.rejects(adapter.read({boat: boat.slug, listing_id: boat.clickandboat_id}), /^Error: platform_challenge$/);
});
