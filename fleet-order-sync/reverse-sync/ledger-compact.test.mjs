// Ledger compaction (2026-10-10): only detail no rule reads is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compactLedger} from './ledger-compact.mjs';
import {isBoataroundManaged, permitsBoataroundReuse} from './ba-managed.mjs';
import {permitsContentIdReuse} from './release.mjs';

const NOW = Date.parse('2026-10-10T05:00:00Z'); // 13:00 Beijing, today 2026-10-10
const calendar = [{id: 'x:1', start: '2026-12-01', end: '2026-12-05'}, {id: 'x:2', start: '2026-12-10', end: '2026-12-12'}, {id: 'x:3', start: '2027-01-01', end: '2027-01-08'}];
const attempt = (id, state, start, end, extra = {}) => ({id, target: 'samboat:1', start, end, causes: ['mmk:1'], before: calendar, state, created: {id: 'u:' + id, start, end}, ...extra});

test('past attempts go after 30 days; finished ones lose their calendar copies; others keep what is read', () => {
  const ledger = {version: 1, targets: {}, attempts: [
    attempt('old', 'released', '2026-08-01', '2026-09-09'),          // ended 31 days ago
    attempt('recent', 'confirmed', '2026-09-01', '2026-09-10'),     // ended 30 days ago: kept
    attempt('rel', 'released', '2026-12-05', '2026-12-10', {release_before: calendar, release_proof: {orders: [1, 2, 3]}}),
    attempt('conf', 'confirmed', '2026-12-04', '2026-12-11'),
    attempt('sub', 'submitting', '2026-12-04', '2026-12-11'),
    attempt('rev', 'releasing', '2026-12-04', '2026-12-11', {release_before: calendar})]};
  compactLedger(ledger, NOW);
  assert.deepEqual(ledger.attempts.map(a => a.id), ['recent', 'rel', 'conf', 'sub', 'rev']);
  const by = id => ledger.attempts.find(a => a.id === id);
  assert.deepEqual(Object.keys(by('rel')).sort(), ['before', 'causes', 'created', 'end', 'id', 'start', 'state', 'target']);
  assert.deepEqual(by('rel').before.map(b => b.id), []);
  // A confirmed record keeps the copied records overlapping its dates only.
  assert.deepEqual(by('conf').before.map(b => b.id), ['x:1', 'x:2']);
  // Being confirmed or released: untouched.
  assert.deepEqual(by('sub').before, calendar); assert.deepEqual(by('rev').release_before, calendar);
  // Idempotent.
  const again = JSON.stringify(compactLedger(structuredClone(ledger), NOW));
  assert.equal(again, JSON.stringify(ledger));
});

test('ownership and reuse decisions are the same before and after compaction', () => {
  const ba = (before) => ({id: 'g1', target: 'boataround:s', start: '2026-12-20', end: '2026-12-21', causes: ['samboat:1'], before, state: 'confirmed',
    created: {id: 's:2026-12-20', start: '2026-12-20', end: '2026-12-21', type: 3},
    boataround_managed_intent: {version: 1, generation: 'g1', control_revision: 2, coverage: {start: '2026-10-01', end: '2028-01-01'}},
    boataround_managed: {version: 1, generation: 'g1', control_revision: 2, causes: ['samboat:1']}});
  for (const before of [calendar, [...calendar, {id: 's:2026-12-20', start: '2026-12-20', end: '2026-12-21', type: 3}]])
    for (const state of ['confirmed', 'released']) {
      const original = {...ba(before), state}, compacted = compactLedger({attempts: [structuredClone(original)]}, NOW).attempts[0];
      assert.equal(isBoataroundManaged(compacted), isBoataroundManaged(original), state);
    }
  // A released Boataround day may be closed again later (reuse needs its copy).
  const released = {...ba(calendar), state: 'released'}, again = {...ba(calendar), id: 'g2', boataround_managed_intent: {...ba(calendar).boataround_managed_intent, generation: 'g2'}};
  const target = {target: 'boataround', boataround_control: {version: 1, enabled: true, revision: 2, holds: []}};
  assert.equal(permitsBoataroundReuse(again, target, compactLedger({attempts: [structuredClone(released)]}, NOW).attempts),
    permitsBoataroundReuse(again, target, [released]));
  const prior = [attempt('a', 'released', '2026-12-05', '2026-12-10'), attempt('b', 'record_missing', '2026-12-05', '2026-12-10')].map(a => ({...a, created: {id: 'cbapp:Unavailable:x'}}));
  const compacted = compactLedger({attempts: structuredClone(prior)}, NOW).attempts;
  assert.equal(permitsContentIdReuse('cbapp:Unavailable:x', compacted), permitsContentIdReuse('cbapp:Unavailable:x', prior));
});

test('a ledger of the phone\'s size shrinks; odd entries are left alone', () => {
  const big = {attempts: Array.from({length: 200}, (_, i) => attempt('r' + i, i % 2 ? 'released' : 'confirmed', '2027-02-01', '2027-02-03', {release_before: calendar}))};
  const before = JSON.stringify(big).length, after = JSON.stringify(compactLedger(big, NOW)).length;
  assert.ok(after < before * 0.6, after + ' < ' + before + ' * 0.6');
  const odd = {attempts: [{id: 'n', state: 'confirmed'}, {id: 'm', state: 'released', end: 'later'}]};
  assert.deepEqual(compactLedger(structuredClone(odd), NOW).attempts.map(a => a.id), ['n', 'm']);
  assert.equal(compactLedger(null, NOW), null);
});
