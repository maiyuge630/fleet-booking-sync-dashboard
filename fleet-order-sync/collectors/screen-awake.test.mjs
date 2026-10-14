// ensureScreenAwake (2026-10-04): the Click&Boat app reader and calendar
// writer make the app visible before each screen read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureScreenAwake} from './clickandboat-app.mjs';

function device({power = 'Dozing', lock = true, secure = false, wakes = true, relapseAfterWake = 0} = {}) {
  const s = {power, lock, commands: [], relapses: relapseAfterWake};
  const root = async command => {
    s.commands.push(command);
    if (command === 'dumpsys power') return `mWakefulness=${s.power}`;
    if (command === 'dumpsys window policy') return `  KeyguardServiceDelegate\n    showing=${s.lock}\n    secure=${secure}\n`;
    if (command === 'input keyevent 224') { if (wakes) s.power = 'Awake'; return ''; }
    if (command === 'wm dismiss-keyguard') return '';   // on this phone it does not hold by itself
    if (command === 'input keyevent 82') { if (!secure) s.lock = false; return ''; }
    return '';
  };
  const sleep = async () => { if (s.relapses > 0 && s.power === 'Awake' && !s.lock) { s.relapses--; s.power = 'Dozing'; s.lock = true; } };
  return {s, root, sleep};
}

test('an awake, unlocked phone gets no key presses', async () => {
  const d = device({power: 'Awake', lock: false});
  await ensureScreenAwake(d.root, d.sleep);
  assert.deepEqual(d.s.commands, ['dumpsys power', 'dumpsys window policy']);
});

test('from the dozing lock screen: wake, dismiss the swipe lock with MENU, and require it to hold', async () => {
  const d = device();
  await ensureScreenAwake(d.root, d.sleep, {settle: 800});
  assert.equal(d.s.power, 'Awake'); assert.equal(d.s.lock, false);
  assert.ok(d.s.commands.includes('input keyevent 224')); assert.ok(d.s.commands.includes('input keyevent 82'));
  // Falling back to the lock screen during the settle time is caught and fixed again.
  const r = device({relapseAfterWake: 1});
  await ensureScreenAwake(r.root, r.sleep, {settle: 800});
  assert.equal(r.s.power, 'Awake'); assert.equal(r.s.lock, false); assert.equal(r.s.commands.filter(c => c === 'input keyevent 224').length, 2);
});

test('MENU is pressed only while the lock screen is still up; unreadable state gets one honest code', async () => {
  const d = device();
  const root = async command => { const out = await d.root(command); if (command === 'wm dismiss-keyguard') d.s.lock = false; return out; };
  await ensureScreenAwake(root, d.sleep);
  assert.ok(d.s.commands.includes('wm dismiss-keyguard')); assert.ok(!d.s.commands.includes('input keyevent 82'));
  for (const broken of [async () => { throw Error('Command failed: su -c dumpsys power'); }, async c => c === 'dumpsys power' ? 'mWakefulness=Awake' : 'no keyguard block'])
    await assert.rejects(ensureScreenAwake(broken, d.sleep), error => error.message === 'screen_state_unavailable');
});

test('a password lock screen is never unlocked, and a phone that never wakes is reported', async () => {
  const locked = device({secure: true});
  await assert.rejects(ensureScreenAwake(locked.root, locked.sleep), error => error.message === 'device_locked' && error.code === 'device_locked');
  assert.ok(!locked.s.commands.some(c => c.startsWith('input') || c.startsWith('wm')));
  const dead = device({wakes: false});
  await assert.rejects(ensureScreenAwake(dead.root, dead.sleep), error => error.message === 'screen_not_awake');
  assert.ok(dead.s.commands.filter(c => c === 'input keyevent 224').length <= 5);
});
