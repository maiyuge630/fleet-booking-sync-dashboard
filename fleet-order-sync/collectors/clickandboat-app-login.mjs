// Click&Boat official app: saved-password login recovery (2026-10-04).
//
// Observed on the phone the same day (user-authorized logout): the app's
// login is its website in a WebView. Account menu → "Log in" → "Log in or sign
// up" with an Email field and Continue → a "Log in" page with Email, Password
// and a "Log in" button. With the phone's autofill service set to Google (the
// user switched it from ColorOS CodeBook, which needs a OnePlus account), the
// Google Password Manager offers the owner account saved for
// https://www.clickandboat.com: as a dropdown under the field or as a "use
// saved password?" dialog, followed each time by Google's question "use your
// password saved for https://www.clickandboat.com in Click&Boat?".
//
// Boundaries: only Android's own autofill is used, through ordinary taps on
// screens recognised exactly (account fingerprint, the site address, button
// texts). The program never types or reads a password: a password field's
// content is dropped while parsing, only "filled or not" is kept, and every
// screen dump file is deleted right after it is read. "Don't show again" is
// never ticked. The Credential Manager chooser ("登录 Click&Boat") leads to
// "Sign in with Google" (an account authorization, not a saved password); it is
// only ever cancelled. A verification page, an unknown screen, another account
// or a login that does not complete stops with auth_required.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {ensureScreenAwake, CLICKANDBOAT_APP, collectClickAndBoatApp} from './clickandboat-app.mjs';

const exec = promisify(execFile);
// The owner account's saved username (same account as SamBoat's).
export const CLICKANDBOAT_SAVED_ACCOUNT = '1111111111111111111111111111111111111111111111111111111111111111';
const SITE = 'https://www.clickandboat.com';
const APP_ACTIVITY = CLICKANDBOAT_APP + '/.MainActivity';
const CHROME_MAIN = 'com.android.chrome/com.google.android.apps.chrome.Main';
const GMS = 'com.google.android.gms', CREDMAN = 'com.android.credentialmanager';
const CHALLENGE = /just a moment|verify you are human|checking your browser|security verification|are you a robot|captcha|verification code|code de vérification/i;
const accountHash = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
const fail = code => { throw Object.assign(new Error(code), {code}); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const decode = value => String(value ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tidy = value => decode(value).replace(/\s+/g, ' ').trim();

/** Nodes of a `uiautomator dump --windows` (or a single hierarchy). Password
 * fields keep only whether they are filled. Repeated identical nodes (the
 * autofill popup is listed twice) are kept once. */
export function loginNodes(xml) {
  const text = String(xml ?? '').trim();
  if (!/^(?:<\?xml[^>]*\?>\s*)?<(displays|hierarchy)\b[\s\S]*<\/\1>$/.test(text)) return null;
  const seen = new Set(), nodes = [];
  for (const match of text.matchAll(/<node\b[^>]*>/g)) {
    const a = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    const password = a.password === 'true';
    const box = (a.bounds || '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number) || [0, 0, 0, 0];
    const node = {pkg: a.package || '', rid: a['resource-id'] || '', cls: a.class || '', password, filled: password && !!a.text,
      text: password ? '' : tidy(a.text), desc: password ? '' : tidy(a['content-desc']),
      clickable: a.clickable === 'true', enabled: a.enabled !== 'false', box, visible: box[2] > box[0] && box[3] > box[1]};
    const key = JSON.stringify([node.pkg, node.rid, node.cls, node.text, node.desc, node.filled, node.box]);
    if (!seen.has(key)) { seen.add(key); nodes.push(node); }
  }
  return nodes;
}

const sites = value => value.match(/https?:\/\/[A-Za-z0-9.-]+/g) || [];
const onlySite = value => sites(value).length > 0 && sites(value).every(site => site === SITE);
const one = list => list.length === 1 ? list[0] : null;
const isButton = n => n.visible && n.clickable && n.enabled;
// Dialog rows and buttons carry Android's generic ids (android:id/text1,
// android:id/button1, read 2026-10-04) or, in other versions, the app's own.
const idIs = (n, name) => n.rid === 'android:id/' + name || n.rid === n.pkg + ':id/' + name;

/** What the login flow shows now, and the one control that may be tapped. */
export function appLoginScreen(nodes, expected = CLICKANDBOAT_SAVED_ACCOUNT) {
  const v = nodes.filter(n => n.visible), all = nodes.flatMap(n => [n.text, n.desc]).filter(Boolean);
  const app = v.filter(n => n.pkg === CLICKANDBOAT_APP), gms = v.filter(n => n.pkg === GMS);
  if (all.some(value => CHALLENGE.test(value))) return {kind: 'challenge'};
  // Credential Manager chooser: its OK leads to "Sign in with Google". Cancel only.
  if (v.some(n => n.pkg === CREDMAN)) {
    const cancel = one(v.filter(n => n.pkg === CREDMAN && idIs(n, 'button2') && isButton(n) && ['取消', 'Cancel'].includes(n.text)));
    return cancel ? {kind: 'sign_in_chooser', tap: cancel} : {kind: 'unknown'};
  }
  // Google: "use your password saved for <site> in Click&Boat?"
  const warning = gms.filter(n => idIs(n, 'warning_message'));
  if (warning.length) {
    const use = one(gms.filter(n => idIs(n, 'button1') && isButton(n) && ['使用', 'Use'].includes(n.text)));
    const ok = warning.length === 1 && warning[0].text.includes('Click&Boat') && onlySite(warning[0].text) && use;
    return ok ? {kind: 'use_saved_password', tap: use} : {kind: 'unknown'};
  }
  const users = gms.filter(n => idIs(n, 'text1') && n.text.includes('@'));
  const origins = gms.filter(n => idIs(n, 'text2'));
  const mine = users.filter(user => accountHash(user.text) === expected &&
    origins.some(o => o.text === SITE && o.box[1] >= user.box[1] && o.box[1] - user.box[3] <= 40 && o.box[0] < user.box[2] && user.box[0] < o.box[2]));
  // Android's fill dialog: "use saved password to sign in to <site>?"
  const yes = v.filter(n => n.rid === 'android:id/autofill_dialog_yes');
  if (yes.length) {
    const title = gms.filter(n => idIs(n, 'title'));
    const ok = yes.length === 1 && isButton(yes[0]) && ['继续', 'Continue'].includes(yes[0].text) && title.length === 1 && onlySite(title[0].text) &&
      users.length === 1 && mine.length === 1 && origins.length === 1;
    return ok ? {kind: 'fill_dialog', tap: yes[0]} : {kind: 'unknown'};
  }
  // Autofill dropdown under the field: the owner's row for the site.
  if (origins.length || users.length) {
    if (mine.length !== 1) return {kind: 'unknown'};
    const origin = origins.find(o => o.text === SITE && o.box[1] >= mine[0].box[1] && o.box[1] - mine[0].box[3] <= 40);
    return {kind: 'dropdown', tap: {box: [Math.min(mine[0].box[0], origin.box[0]), mine[0].box[1], Math.max(mine[0].box[2], origin.box[2]), origin.box[3]]}};
  }
  const texts = new Set(app.map(n => n.text).filter(Boolean));
  const fields = app.filter(n => n.cls === 'android.widget.EditText' && !n.password && n.rid !== 'where-ts-control');
  const passwords = app.filter(n => n.password);
  if (passwords.length) {
    const email = one(fields), submit = one(app.filter(n => isButton(n) && n.text === 'Log in' && n.cls === 'android.widget.Button'));
    if (passwords.length !== 1 || !email || !submit || !texts.has('Password')) return {kind: 'unknown'};
    return {kind: 'password_step', account: accountHash(email.text) === expected, filled: passwords[0].filled, field: passwords[0], submit};
  }
  if (texts.has('Welcome to Click&Boat') && texts.has('Log in or sign up')) {
    const email = one(fields), submit = one(app.filter(n => isButton(n) && n.text === 'Continue' && n.cls === 'android.widget.Button'));
    if (!email || !submit || !isButton(email)) return {kind: 'unknown'};
    return {kind: 'email_step', value: email.text, account: accountHash(email.text) === expected, field: email, submit};
  }
  if (all.includes('Log out') || texts.has('Ahoy there Captain!') || texts.has('All your bookings')) return {kind: 'logged_in'};
  const login = one(app.filter(n => isButton(n) && n.text === 'Log in')), register = app.some(n => isButton(n) && n.text === 'Register');
  if (login && register) return {kind: 'menu_logged_out', tap: login};
  const menu = one(app.filter(n => isButton(n) && n.desc === 'account menu'));
  if (menu) return {kind: 'home', tap: menu};
  return {kind: 'unknown'};
}

/** Signs the app in again with the saved owner account, or fails with
 * auth_required (challenge_required for a verification page). */
export async function recoverClickAndBoatAppLogin({root, sleep = pause, check = () => {}, expectedAccount = CLICKANDBOAT_SAVED_ACCOUNT, file = '/data/local/tmp/fleet-cb-login-' + process.pid + '.xml'}) {
  const dump = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      try {
        await root('rm -f ' + file); await root('uiautomator dump --windows ' + file);
        const xml = await root('cat ' + file); await root('rm -f ' + file);
        const nodes = loginNodes(xml); if (nodes) return nodes;
      } catch (error) { if (error?.code === 'timeout') throw error; }
      await sleep(700);
    }
    fail('auth_required');
  };
  const tap = async (node, wait) => { check(); const [x1, y1, x2, y2] = node.box; await root(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`); await sleep(wait); };
  const counts = {};
  const limit = (kind, max) => { counts[kind] = (counts[kind] || 0) + 1; if (counts[kind] > max) fail('auth_required'); };
  let submitted = false;
  try {
    await ensureScreenAwake(root, sleep, {settle: 800});
    check(); await root('am start -S -W -n ' + APP_ACTIVITY); await sleep(2500);
    for (let step = 0; step < 45; step++) {
      await ensureScreenAwake(root, sleep);
      const screen = appLoginScreen(await dump(), expectedAccount);
      switch (screen.kind) {
        case 'logged_in': return;
        case 'challenge': fail('challenge_required');
        case 'sign_in_chooser': limit('chooser', 3); await tap(screen.tap, 1500); break;
        case 'fill_dialog': case 'dropdown': case 'use_saved_password': limit('autofill', 10); await tap(screen.tap, 2500); break;
        case 'email_step':
          if (!screen.value) { limit('field', 4); await tap(screen.field, 2500); }
          else if (!screen.account) fail('auth_required');
          else { limit('continue', 2); await tap(screen.submit, 4000); }
          break;
        case 'password_step':
          if (!screen.account) fail('auth_required');
          if (submitted) { limit('after_submit', 4); await sleep(2000); }
          else if (!screen.filled) { limit('field', 6); await tap(screen.field, 2500); }
          // One submission only; a rejected password is never retried.
          else { submitted = true; await tap(screen.submit, 6000); }
          break;
        case 'menu_logged_out': limit('menu_login', 3); await tap(screen.tap, 3500); break;
        case 'home': limit('menu', 4); await tap(screen.tap, 2500); break;
        default: limit('unknown', 8); await sleep(1500);
      }
    }
    fail('auth_required');
  } finally {
    await root('rm -f ' + file).catch(() => {});
  }
}

/** The app collector with one saved-password recovery after auth_required.
 * The recovered session is then read completely again from a fresh app. */
export async function collectClickAndBoatAppWithSavedLogin(context, {collect = collectClickAndBoatApp, recover = recoverClickAndBoatAppLogin, rootCommand, sleep = pause, now = Date.now} = {}) {
  const report = reason => { try { context.reportDiagnostic?.({stage: 'login_recovery', reason}); } catch {} };
  try { return await collect(context, {rootCommand, sleep, now}); }
  catch (error) {
    // About 1-2 minutes to sign in, then the two complete reads.
    if (error?.code !== 'auth_required' || context.signal?.aborted || !Number.isFinite(context.deadlineAt) || context.deadlineAt - now() < 240000) throw error;
    report('progress');
    const check = () => { if (context.signal?.aborted || now() >= context.deadlineAt) fail('timeout'); };
    const root = rootCommand || (async command => { check();
      return (await exec('su', ['-c', command], {timeout: Math.max(1, Math.min(15000, context.deadlineAt - now())), maxBuffer: 8 * 1024 * 1024, signal: context.signal})).stdout; });
    let wasAsleep = false, powerKnown = false, chromeWasTop = false;
    try {
      const power = await root('dumpsys power');
      powerKnown = /mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power); wasAsleep = /mWakefulness=(?:Asleep|Dozing)/.test(power);
      chromeWasTop = /topResumedActivity=[^\n]*com\.android\.chrome\//.test(await root('dumpsys activity activities'));
      await recover({root, sleep, check});
    } catch (failure) {
      const code = ['challenge_required', 'timeout'].includes(failure?.code) ? failure.code : 'auth_required';
      report(code);
      throw Object.assign(Error(code === 'timeout' ? '同步超时，保留上次完整订单' : 'Click&Boat App 未登录，保存的密码未能自动登录，保留上次完整订单'), {code});
    } finally {
      const cleanup = rootCommand || (async command => (await exec('su', ['-c', command], {timeout: 4000, maxBuffer: 65536})).stdout);
      await cleanup(chromeWasTop ? 'am start -n ' + CHROME_MAIN : 'input keyevent KEYCODE_HOME').catch(() => {});
      if (powerKnown && wasAsleep) await cleanup('input keyevent 223').catch(() => {});
    }
    return collect(context, {rootCommand, sleep, now});
  }
}
