import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loginNodes, appLoginScreen, recoverClickAndBoatAppLogin, collectClickAndBoatAppWithSavedLogin, CLICKANDBOAT_SAVED_ACCOUNT} from './clickandboat-app-login.mjs';
import {appNodes} from './clickandboat-app.mjs';
import {ClickAndBoatAppAdapter} from '../reverse-sync/clickandboat-app-adapter.mjs';

const owner = 'owner@example.invalid', hash = v => createHash('sha256').update(v).digest('hex'), expected = hash(owner);
const APP = 'com.clickandboat.androidphone', GMS = 'com.google.android.gms', CRED = 'com.android.credentialmanager', SITE = 'https://www.clickandboat.com';
const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const n = (pkg, {rid = '', cls = 'android.view.View', text = '', desc = '', click = false, box, password = false}) =>
  `<node package="${pkg}" resource-id="${rid}" class="${cls}" text="${esc(text)}" content-desc="${esc(desc)}" clickable="${click}" enabled="true" password="${password}" bounds="[${box.join(',').replace(/^(\d+),(\d+),/, '$1,$2][')}]"/>`;
const windows = (...nodes) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><displays><display id="0"><window index="0"><hierarchy rotation="0">${nodes.join('')}</hierarchy></window></display></displays>`;
// Screens as read from the phone on 2026-10-04 (portrait coordinates).
const S = {
  home: () => windows(n(APP, {cls: 'android.widget.Button', desc: 'account menu', click: true, box: [894, 159, 1008, 273]}), n(APP, {text: 'The best solution for your boat hire', box: [0, 312, 1080, 1032]})),
  menu: () => windows(n(APP, {cls: 'android.widget.Button', text: 'Log in', click: true, box: [3, 459, 1077, 603]}), n(APP, {cls: 'android.widget.Button', text: 'Register', click: true, box: [3, 603, 1077, 747]})),
  email: (value = '') => windows(n(APP, {cls: 'android.widget.TextView', text: 'Log in or sign up', box: [168, 162, 912, 222]}), n(APP, {cls: 'android.widget.TextView', text: 'Welcome to Click&Boat', box: [72, 339, 1008, 435]}),
    n(APP, {text: 'Email', box: [120, 555, 243, 627]}), n(APP, {rid: '_077b', cls: 'android.widget.EditText', text: value, click: true, box: [72, 507, 1008, 675]}),
    n(APP, {rid: 'where-ts-control', cls: 'android.widget.EditText', click: true, box: [108, 1722, 741, 1722]}),
    n(APP, {cls: 'android.widget.Button', text: 'Continue', click: true, box: [72, 747, 1008, 891]}), n(APP, {cls: 'android.widget.Button', text: 'Continue with Google', click: true, box: [72, 1479, 1008, 1623]})),
  chooser: () => S.email() .replace('</hierarchy>', n(CRED, {rid: CRED + ':id/alertTitle', text: '登录“Click&Boat”', box: [100, 192, 980, 270]}) + n(CRED, {rid: CRED + ':id/text1', text: owner, box: [184, 438, 900, 504]}) +
    n(CRED, {rid: 'android:id/button3', cls: 'android.widget.Button', text: '确定', click: true, box: [100, 624, 980, 756]}) + n(CRED, {rid: 'android:id/button2', cls: 'android.widget.Button', text: '取消', click: true, box: [100, 780, 980, 912]}) + '</hierarchy>'),
  dropdown: (user = owner, site = SITE) => { const rows = n(GMS, {rid: 'android:id/text1', text: user, box: [181, 853, 848, 934]}) + n(GMS, {rid: 'android:id/text2', text: site, box: [181, 934, 721, 1007]}) + n(GMS, {rid: GMS + ':id/text1', text: '管理密码', box: [157, 1055, 373, 1208]});
    return S.email().replace('</hierarchy>', rows + rows + '</hierarchy>'); },
  use: () => windows(n(GMS, {rid: GMS + ':id/warning_message', text: '要在Click&Boat中使用您已保存的https://www.clickandboat.com密码吗？', box: [136, 958, 944, 1094]}),
    n(GMS, {rid: GMS + ':id/opt_out_checkbox', cls: 'android.widget.CheckBox', text: '不再显示', click: true, box: [136, 1142, 400, 1286]}),
    n(GMS, {rid: 'android:id/button2', cls: 'android.widget.Button', text: '取消', click: true, box: [500, 1292, 740, 1436]}), n(GMS, {rid: 'android:id/button1', cls: 'android.widget.Button', text: '使用', click: true, box: [760, 1292, 1000, 1436]})),
  password: (filled = false, email = owner) => windows(n(APP, {text: 'Email', box: [114, 216, 207, 264]}), n(APP, {rid: '_1a39', cls: 'android.widget.EditText', text: email, click: true, box: [66, 192, 1005, 360]}),
    n(APP, {text: 'Password', box: [114, 456, 285, 504]}), n(APP, {rid: '_8dfe', cls: 'android.widget.EditText', text: filled ? 'secret-value' : '', click: true, password: true, box: [66, 432, 1005, 600]}),
    n(APP, {cls: 'android.widget.Button', text: 'Log in', click: true, box: [66, 672, 1005, 816]}), n(APP, {cls: 'android.widget.Button', text: 'Forgot your password?', click: true, box: [270, 888, 801, 960]})),
  fill: () => S.password().replace('</hierarchy>', n(GMS, {rid: GMS + ':id/title', text: '要使用已保存的密码登录“https://www.clickandboat.com”吗？', box: [76, 1408, 1004, 1560]}) +
    n(GMS, {rid: 'android:id/text1', text: owner, box: [52, 1656, 719, 1737]}) + n(GMS, {rid: 'android:id/text2', text: SITE, box: [52, 1737, 592, 1810]}) +
    n('android', {rid: 'android:id/autofill_dialog_no', cls: 'android.widget.Button', text: '以后', click: true, box: [108, 1846, 264, 1966]}) +
    n('android', {rid: 'android:id/autofill_dialog_yes', cls: 'android.widget.Button', text: '继续', click: true, box: [856, 1846, 1004, 1966]}) + '</hierarchy>'),
  done: () => windows(n(APP, {cls: 'android.widget.TextView', text: 'Ahoy there Captain!', box: [120, 384, 960, 480]})),
};
const inBox = (x, y, box) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
function phone(script) {
  // script: {screen, taps: {label: next}}; a tap is resolved to the node it hits.
  const f = {calls: [], screen: script.start, files: new Set()};
  f.root = async command => {
    f.calls.push(command);
    if (command === 'dumpsys power') return 'mWakefulness=Awake';
    if (command === 'dumpsys window policy') return '  KeyguardServiceDelegate\n    showing=false\n    secure=false\n';
    if (command.startsWith('uiautomator dump')) { f.files.add(command.split(' ').pop()); return ''; }
    if (command.startsWith('rm -f ')) { f.files.delete(command.slice(6)); return ''; }
    if (command.startsWith('cat ')) return typeof f.screen === 'function' ? f.screen() : S[f.screen]();
    const tap = /^input tap (\d+) (\d+)$/.exec(command);
    if (tap) {
      const xml = typeof f.screen === 'function' ? f.screen() : S[f.screen]();
      const hit = loginNodes(xml).filter(x => inBox(+tap[1], +tap[2], x.box)).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
      const label = hit ? (hit.text || hit.desc || hit.rid || (hit.password ? 'password' : '?')) : 'nothing';
      f.calls.push('hit ' + label);
      const next = script.taps[f.screen + ':' + label];
      if (next) f.screen = next;
    }
    return '';
  };
  return f;
}
const run = (f, options = {}) => recoverClickAndBoatAppLogin({root: f.root, sleep: async () => {}, expectedAccount: expected, ...options});

test('password fields keep only "filled": the value never reaches parsed nodes', () => {
  const nodes = loginNodes(S.password(true));
  assert.ok(!JSON.stringify(nodes).includes('secret-value'));
  assert.equal(nodes.find(x => x.password).filled, true);
  assert.ok(!JSON.stringify(appNodes(S.password(true).replace(/^[\s\S]*?<hierarchy[^>]*>/, '<hierarchy>').replace(/<\/hierarchy>[\s\S]*$/, '</hierarchy>'))).includes('secret-value'));
  assert.equal(loginNodes('<displays>'), null);
  assert.equal(loginNodes(S.dropdown()).filter(x => x.text === owner).length, 1, 'popup listed twice is read once');
});

test('screens are recognised exactly; only the owner row for the site is offered',() => {
  assert.equal(appLoginScreen(loginNodes(S.home()), expected).kind, 'home');
  assert.equal(appLoginScreen(loginNodes(S.menu()), expected).kind, 'menu_logged_out');
  assert.equal(appLoginScreen(loginNodes(S.email()), expected).kind, 'email_step');
  const chooser = appLoginScreen(loginNodes(S.chooser()), expected);
  assert.equal(chooser.kind, 'sign_in_chooser'); assert.equal(chooser.tap.text, '取消');
  assert.deepEqual(appLoginScreen(loginNodes(S.dropdown()), expected).tap.box, [181, 853, 848, 1007]);
  for (const xml of [S.dropdown('other@example.invalid'), S.dropdown(owner, 'https://www.clickandboat.com.evil.test'), S.dropdown(owner, 'https://clickandboat.com')])
    assert.equal(appLoginScreen(loginNodes(xml), expected).kind, 'unknown');
  assert.equal(appLoginScreen(loginNodes(S.use()), expected).tap.text, '使用');
  assert.equal(appLoginScreen(loginNodes(S.use().replace('https://www.clickandboat.com', 'https://evil.example')), expected).kind, 'unknown');
  assert.equal(appLoginScreen(loginNodes(S.fill()), expected).tap.text, '继续');
  assert.equal(appLoginScreen(loginNodes(S.password(true, 'other@example.invalid')), expected).account, false);
  assert.equal(appLoginScreen(loginNodes(S.done()), expected).kind, 'logged_in');
  assert.equal(appLoginScreen(loginNodes(windows(n(APP, {text: 'Just a moment...', box: [0, 0, 100, 100]}))), expected).kind, 'challenge');
  assert.match(CLICKANDBOAT_SAVED_ACCOUNT, /^[0-9a-f]{64}$/);
});

const flow = {start: 'home', taps: {
  'home:account menu': 'menu', 'menu:Log in': 'email', 'email:_077b': 'chooser', 'chooser:取消': 'email2',
  'email2:_077b': 'dropdown', ['dropdown:' + owner]: 'use', 'use:使用': 'emailFilled', 'emailFilled:Continue': 'fill',
  'fill:继续': 'use2', 'use2:使用': 'passwordFilled', 'passwordFilled:Log in': 'done'}};
Object.assign(S, {email2: () => S.email(), emailFilled: () => S.email(owner), use2: () => S.use(), passwordFilled: () => S.password(true)});

test('signed-out app: chooser cancelled, saved owner account used, one Log in, dumps deleted', async () => {
  const f = phone(flow); await run(f);
  assert.equal(f.screen, 'done');
  const hits = f.calls.filter(c => c.startsWith('hit '));
  assert.deepEqual(hits, ['hit account menu', 'hit Log in', 'hit _077b', 'hit 取消', 'hit _077b', 'hit ' + owner, 'hit 使用', 'hit Continue', 'hit 继续', 'hit 使用', 'hit Log in']);
  assert.ok(!hits.includes('hit 确定') && !hits.includes('hit 不再显示') && !hits.includes('hit Continue with Google'));
  assert.ok(!f.calls.some(c => c.startsWith('input text')), 'nothing is typed');
  assert.equal(f.files.size, 0, 'every screen dump is deleted');
  assert.ok(f.calls.includes('am start -S -W -n com.clickandboat.androidphone/.MainActivity'));
});
test('an app that is in fact signed in is left alone', async () => {
  const f = phone({start: 'home', taps: {'home:account menu': () => windows(n(APP, {text: 'Log out', click: true, box: [3, 1518, 1077, 1662]}))}});
  await run(f); assert.ok(!f.calls.some(c => c === 'hit Log in'));
});
test('another saved account, a rejected password or a verification page stop without retrying', async () => {
  const other = phone({start: 'email', taps: {'email:_077b': () => S.dropdown('other@example.invalid')}});
  await assert.rejects(run(other), {code: 'auth_required'}); assert.ok(!other.calls.includes('hit other@example.invalid'));
  const rejected = phone({start: 'passwordFilled', taps: {}});
  await assert.rejects(run(rejected), {code: 'auth_required'}); assert.equal(rejected.calls.filter(c => c === 'hit Log in').length, 1);
  const filledOther = phone({start: () => S.email('other@example.invalid'), taps: {}});
  await assert.rejects(run(filledOther), {code: 'auth_required'}); assert.ok(!filledOther.calls.some(c => c.startsWith('hit')));
  const challenge = phone({start: () => windows(n(APP, {text: 'Verify you are human', box: [0, 0, 100, 100]})), taps: {}});
  await assert.rejects(run(challenge), {code: 'challenge_required'});
  const locked = phone(flow); locked.root = (orig => async c => c === 'dumpsys window policy' ? '  KeyguardServiceDelegate\n    showing=true\n    secure=true\n' : orig(c))(locked.root);
  await assert.rejects(run(locked)); assert.ok(!locked.calls.some(c => c.startsWith('input tap')));
});
test('cancellation stops before the next tap', async () => {
  const f = phone(flow); let taps = 0;
  await assert.rejects(run(f, {check: () => { if (taps >= 2) throw Object.assign(Error('timeout'), {code: 'timeout'}); }, root: async c => { if (c.startsWith('input tap')) taps++; return f.root(c); }}), {code: 'timeout'});
  assert.equal(taps, 2);
});

test('collection: one recovery, then a complete new read; other faults never sign in', async () => {
  const snapshot = {complete: true}, context = {deadlineAt: 1e9, reportDiagnostic: () => {}};
  const root = async c => c === 'dumpsys power' ? 'mWakefulness=Awake' : '';
  assert.equal(await collectClickAndBoatAppWithSavedLogin(context, {rootCommand: root, now: () => 0, collect: async () => snapshot, recover: async () => assert.fail()}), snapshot);
  let collects = 0, recovers = 0;
  assert.equal(await collectClickAndBoatAppWithSavedLogin(context, {rootCommand: root, now: () => 0, collect: async () => { if (++collects === 1) throw Object.assign(Error(), {code: 'auth_required'}); return snapshot; }, recover: async () => { recovers++; }}), snapshot);
  assert.equal(collects, 2); assert.equal(recovers, 1);
  for (const code of ['schema_changed', 'incomplete_pages', 'fetch_failed', 'challenge_required', 'timeout'])
    await assert.rejects(collectClickAndBoatAppWithSavedLogin(context, {rootCommand: root, now: () => 0, collect: async () => { throw Object.assign(Error(), {code}); }, recover: async () => assert.fail()}), {code});
  let n2 = 0; await assert.rejects(collectClickAndBoatAppWithSavedLogin(context, {rootCommand: root, now: () => 0, collect: async () => { n2++; throw Object.assign(Error(), {code: 'auth_required'}); }, recover: async () => { throw Object.assign(Error(), {code: 'auth_required'}); }}), {code: 'auth_required'}); assert.equal(n2, 1);
  await assert.rejects(collectClickAndBoatAppWithSavedLogin({deadlineAt: 100000}, {rootCommand: root, now: () => 0, collect: async () => { throw Object.assign(Error(), {code: 'auth_required'}); }, recover: async () => assert.fail()}), {code: 'auth_required'});
  await assert.rejects(collectClickAndBoatAppWithSavedLogin(context, {rootCommand: root, now: () => 0, collect: async () => { throw Object.assign(Error(), {code: 'auth_required'}); }, recover: async () => { throw Object.assign(Error(), {code: 'challenge_required'}); }}), {code: 'challenge_required'});
});

test('calendar: a signed-out app is recovered once per run, then the calendar is opened again', async () => {
  let recovered = 0, opens = 0;
  const adapter = new ClickAndBoatAppAdapter({rootCommand: async () => 'mWakefulness=Awake', sleep: async () => {}, recoverLogin: async ({root, check}) => { assert.equal(typeof root, 'function'); check(); recovered++; }});
  adapter.wake = async () => {}; adapter.readList = async () => ({rows: []});
  adapter.openCalendar = async () => { if (++opens === 1) throw Error('auth_required'); };
  const target = {target: 'clickandboat', boat: 'grandcat-55-tidewyn-discovery-5', listing_id: '100007'};
  assert.equal((await adapter.read(target)).complete, true); assert.equal(recovered, 1); assert.equal(opens, 2);
  adapter.openCalendar = async () => { throw Error('auth_required'); };
  await assert.rejects(adapter.read(target), {message: 'auth_required'}); assert.equal(recovered, 1);
  const failing = new ClickAndBoatAppAdapter({rootCommand: async () => '', recoverLogin: async () => { throw Object.assign(Error('x'), {code: 'challenge_required'}); }});
  failing.wake = async () => {}; failing.openCalendar = async () => { throw Error('auth_required'); };
  await assert.rejects(failing.read(target), {message: 'platform_challenge'});
});
