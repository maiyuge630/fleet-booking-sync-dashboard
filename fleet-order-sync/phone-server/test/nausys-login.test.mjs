// NauSYS saved-password login (2026-10-09): Chrome's sheet for app.nausys.com
// lists demo-user@AGENCY and colleague@AGENCY; only demo-user@AGENCY may be used (user decision).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedNausysLogin, recoverNausysSavedLogin, NAUSYS_SAVED_ACCOUNT} from '../nausys-login.mjs';
const hash = v => createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const node = (rid, attrs) => `<node package="com.android.chrome" resource-id="${rid ? 'com.android.chrome:id/' + rid : ''}" ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
// Layout read from the phone on 2026-10-09 (two rows, no origin lines).
function sheet({subtitle = '您将登录 app.nausys.com', first = 'demo-user@AGENCY', second = 'colleague@AGENCY', origin = '', pkg} = {}) {
  let xml = '<hierarchy rotation="0">' + node('touch_to_fill_sheet_title', {text: '要使用已保存的密码吗？', bounds: '[177,1495][903,1651]'}) +
    node('touch_to_fill_sheet_subtitle', {text: subtitle, bounds: '[217,1651][863,1715]'}) +
    node('', {clickable: 'true', enabled: 'true', bounds: '[48,1760][1032,1981]'}) + node('username', {text: first, bounds: '[264,1802][797,1875]'}) +
    node('', {clickable: 'true', enabled: 'true', bounds: '[48,1987][1032,2208]'}) + (origin ? node('credential_origin', {text: origin, bounds: '[264,2029][684,2093]'}) : '') +
    node('username', {text: second, bounds: '[264,2093][664,2166]'}) + node('password', {text: 'secret-must-not-be-kept', password: 'true', bounds: '[264,2166][664,2200]'}) + '</hierarchy>';
  if (pkg) xml = xml.replaceAll('package="com.android.chrome"', `package="${pkg}"`);
  return xml;
}

test('only the demo-user@AGENCY row for app.nausys.com is chosen', () => {
  assert.equal(NAUSYS_SAVED_ACCOUNT, hash('demo-user@AGENCY'));
  assert.deepEqual(savedNausysLogin(sheet()), {x: 540, y: 1870});
  assert.deepEqual(savedNausysLogin(sheet({first: 'colleague@AGENCY', second: 'demo-user@AGENCY'})), {x: 540, y: 2097});
  assert.equal(savedNausysLogin(sheet({first: 'colleague@AGENCY', second: 'other@CAS'})), null);
  assert.equal(savedNausysLogin(sheet({second: 'demo-user@AGENCY'})), null, 'two demo-user rows are ambiguous');
  assert.equal(savedNausysLogin(sheet({first: 'colleague@AGENCY', second: 'demo-user@AGENCY', origin: 'www.nausys.com'})), null, 'a row saved for another site');
  for (const subtitle of ['您将登录 nausys.com', '您将登录 app.nausys.com.evil.test', 'http://app.nausys.com', '您将登录 partner.boataround.com'])
    assert.equal(savedNausysLogin(sheet({subtitle})), null, subtitle);
  assert.equal(savedNausysLogin(sheet({pkg: 'other.app'})), null);
  assert.equal(savedNausysLogin(sheet().replace('</hierarchy>', '')), null);
});

const LOGIN = 'https://app.nausys.com/NauSYS-app/login.xhtml', HOME = 'https://app.nausys.com/NauSYS-app/index.xhtml';
function fixture({autoSubmit = true, asleep = true, url = LOGIN} = {}) {
  const f = {calls: [], url, awake: !asleep, sheetOpen: false, filled: false, submits: 0};
  f.page = {url: () => f.url, waitForFunction: async () => {}, bringToFront: async () => f.calls.push('front'),
    click: async selector => { f.calls.push('click ' + selector); if (selector === '[id="loginForm:loginInput"]') f.sheetOpen = true; },
    evaluate: async fn => {
      assert.equal(f.sheetOpen, false, 'page JavaScript is not used while the native sheet is open');
      if (fn.name === 'nausysLoginForm') return f.url === LOGIN ? {login: true, username: f.filled ? 'demo-user@AGENCY' : '', filled: f.filled, submit: true, busy: false} : {login: false};
      if (fn.name === 'submitNausysLogin') { f.submits++; f.url = HOME; return true; }
      if (fn.name === 'rememberNausysLogin') { f.calls.push('remember me'); return true; }
      throw Error('unexpected evaluate ' + fn.name);
    }};
  f.rootCommand = async command => {
    f.calls.push(command);
    if (command === 'dumpsys power') return f.awake ? 'mWakefulness=Awake' : 'mWakefulness=Asleep';
    if (command === 'input keyevent 224') f.awake = true;
    if (command === 'input keyevent 223') f.awake = false;
    if (command === 'dumpsys window policy') return '  KeyguardServiceDelegate\n    showing=false\n    secure=false\n';
    if (command.startsWith('cat ')) return f.sheetOpen ? sheet() : '<hierarchy rotation="0"></hierarchy>';
    if (command.startsWith('input tap ')) { f.sheetOpen = false; f.filled = true; if (autoSubmit) f.url = HOME; }
    return '';
  };
  return f;
}
const run = f => recoverNausysSavedLogin(f.page, {rootCommand: f.rootCommand, sleep: async () => {}});

test('from a sleeping phone: one tap on demo-user@AGENCY, Chrome submits, the dump is deleted and sleep restored', async () => {
  const f = fixture(); await run(f);
  assert.deepEqual(f.calls.filter(c => c.startsWith('input tap')), ['input tap 540 1870']);
  assert.equal(f.submits, 0); assert.ok(f.calls.includes('click [id="loginForm:loginInput"]'));
  assert.ok(f.calls.indexOf('remember me') >= 0 && f.calls.indexOf('remember me') < f.calls.findIndex(c => c.startsWith('input tap')), 'Remember me is ticked before Chrome submits');
  const dump = f.calls.findIndex(c => c.startsWith('cat ')); assert.ok(f.calls.slice(dump + 1).some(c => c.startsWith('rm -f ')), 'dump deleted after reading');
  assert.equal(f.calls.at(-1), 'input keyevent 223');
});

test('a form Chrome filled but did not send is submitted exactly once', async () => {
  const f = fixture({autoSubmit: false, asleep: false}); await run(f);
  assert.equal(f.submits, 1); assert.equal(f.url, HOME); assert.ok(!f.calls.includes('input keyevent 223'));
});

test('not on NauSYS, or no usable row, fails without typing anything', async () => {
  const away = fixture({url: 'https://evil.test/NauSYS-app/login.xhtml'});
  await assert.rejects(run(away), e => e.code === 'auth_required'); assert.ok(!away.calls.some(c => c.startsWith('input tap')));
  const f = fixture();
  f.rootCommand = async command => { f.calls.push(command); if (command === 'dumpsys power') return 'mWakefulness=Awake';
    if (command.startsWith('cat ')) return f.sheetOpen ? sheet({first: 'colleague@AGENCY', second: 'other@CAS'}) : '<hierarchy rotation="0"></hierarchy>'; return ''; };
  await assert.rejects(run(f), e => e.code === 'auth_required'); assert.ok(!f.calls.some(c => c.startsWith('input tap')));
});
