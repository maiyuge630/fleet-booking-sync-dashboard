// The Worker bundle must never pull in phone-only Node APIs. On 2026-09-29 a
// shared collector list briefly routed the app collector (child_process) into
// the Worker build; the phone now wires that collector in server.mjs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the built Worker imports only modules available on Cloudflare Workers', () => {
  const build = JSON.parse(fs.readFileSync(new URL('./after/build.json', import.meta.url), 'utf8'));
  const allowed = new Set(['cloudflare:workers', 'node:buffer', 'fs/promises', 'path']);
  const imports = [...new Set(build.imports.map(item => item.path))];
  assert.deepEqual(imports.filter(path => !allowed.has(path)), []);
  const bundle = fs.readFileSync(new URL('./after/cloudflare.js', import.meta.url), 'utf8');
  assert.ok(!bundle.includes('child_process'));
});
