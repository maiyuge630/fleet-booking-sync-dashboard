// A fake phone reproduces the screen structure observed in the official
// Click&Boat app on 2026-09-29 (names and contacts replaced by fixtures).
import assert from 'node:assert/strict';
import test from 'node:test';
import {appBookingRows, appNodes, appScreen, collectClickAndBoatApp, APP_PAYMENT_BASIS} from './clickandboat-app.mjs';
import {requirePaymentEvidence} from '../phone-server/core.mjs';
import {buildPlan} from '../reverse-sync/planner.mjs';

const PKG = 'com.clickandboat.androidphone';
const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let y = 0;
const n = (text, {desc = '', click = false, bounds} = {}) => ({text, desc, click, bounds: bounds ?? `[72,${y += 60}][1008,${y + 50}]`});
const xml = (nodes, pkg = PKG) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  nodes.map(x => `<node index="0" text="${esc(x.text)}" content-desc="${esc(x.desc)}" package="${pkg}" clickable="${x.click}" bounds="${x.bounds}" />`).join('') + '</hierarchy>';
const row = (id, status, boat, dates, amount, {accessBounds} = {}) => [
  n(status + ' '), n('i'), n('N°' + id), n('Fixture Renter'), n('', {desc: boat, click: true}), n(boat), n(dates),
  ...(amount ? [n(amount)] : []), n('', {desc: 'Access', click: true, bounds: accessBounds}), n('Access')];
const BOATS = {ad5: 'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5', ad2: 'Catamaran Seacat 40 Open 11.98mTidewyn Discovery 2',
  dream: 'Catamaran Wavecat 34 open 10.15mTidewyn Dream'};
const header = () => [n('All your bookings'), n('NET REVENUE IN 2026'), n('€55,927'),
  n('In progress', {click: true, bounds: '[72,1116][375,1230]'}), n('History', {click: true, bounds: '[384,1116][609,1230]'})];

// leftoverBroken: the app still shows the broken page an earlier BACK left
// (observed 2026-09-29). loadingReads: blank reads after each start.
// slowTabSwitch: reads that still show In progress after tapping History.
function device({challenge = false, secure = false, changeSecondHistory = false, manualVisibleAfterSwipes = 1, halfRenderedReads = 0,
  leftoverBroken = false, loadingReads = 2, slowTabSwitch = 0} = {}) {
  const s = {screen: leftoverBroken ? 'broken' : 'home', power: 'Dozing', lock: true, swipes: 0, historyReads: 0, progressReads: 0,
    coldStarts: 0, loadingLeft: 0, switchLag: 0, commands: [], file: ''};
  const progressRows = () => [...row('1000002', 'Accepted', BOATS.ad5, s.progressReads <= halfRenderedReads ? 'loading…' : 'from 7 to 13 November 2026 (14:00 / 10:00)', '€12,705'),
    ...row('1250578', 'Pending', BOATS.ad2, 'from 7 to 13 November 2026 (14:00 / 10:00)', '€11,310')];
  const historyRows = () => [...row('1274920', 'Completed', BOATS.dream, 'from 27 to 30 May 2026 (14:00 / 10:00)', '€2,280'),
    ...row('1300001', 'Cancelled', BOATS.dream, 'from 5 to 9 December 2026 (14:00 / 10:00)', null),
    ...row('1000000', 'Completed', BOATS.ad2, 'from 1 to 8 March 2026 (14:00 / 10:00)', '€3,100',
      {accessBounds: s.swipes >= manualVisibleAfterSwipes ? '[783,1746][1008,1860]' : '[783,2344][1008,2344]'}),
    // History is read twice per pass (stability) plus once while scrolling to the detail.
    ...(changeSecondHistory && s.historyReads > 3 ? row('1400000', 'Accepted', BOATS.dream, 'from 1 to 5 October 2026 (14:00 / 10:00)', '€900') : [])];
  const screens = {
    loading: () => [n('')],
    launcher: () => [n('Phone')],
    // The page restored by BACK lost one row's status text.
    broken: () => [...header(), ...progressRows().filter(node => !node.text.startsWith('Pending')), n('ABOUT US')],
    home: () => [n('', {desc: 'burger menu', click: true, bounds: '[810,186][870,246]'}), n('', {desc: 'account menu', click: true, bounds: '[894,159][1008,273]'}), n('Boat rentals All boat rentals')],
    menu: () => [n('', {desc: 'close', click: true, bounds: '[75,171][147,243]'}), n('', {desc: 'Bookings', click: true, bounds: '[3,603][1077,747]'}), n('Bookings'), n('', {desc: 'Log out', click: true, bounds: '[3,1518][1077,1662]'})],
    progress: () => [...header(), ...(challenge ? [n('Just a moment...')] : []), ...progressRows(), n('ABOUT US')],
    history: () => [...header(), ...historyRows(), n('ABOUT US')],
    detail: () => [n('Booking N°1000000'), n('ACCEPTED'), n('CHECK-IN'), n('06/03/2027'), n('14:00'), n('CHECK-OUT'), n('13/03/2027'), n('10:00'),
      n('Price'), n('Net amount (boat owner)'), n('€3,100'), n('fixture@example.invalid')],
  };
  const at = (x, yy) => screens[s.screen]().find(node => { const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); return node.click && x >= x1 && x <= x2 && yy >= y1 && yy <= y2 && y2 > y1; });
  const rootCommand = async command => {
    s.commands.push(command);
    if (command === 'dumpsys power') return `mWakefulness=${s.power}`;
    if (command === 'dumpsys activity activities') return 'topResumedActivity=ActivityRecord{1 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t1}';
    if (command === 'input keyevent 224') { s.power = 'Awake'; return ''; }
    if (command === 'input keyevent 223') { s.power = 'Dozing'; return ''; }
    if (command === 'dumpsys window policy') return `  KeyguardServiceDelegate\n    showing=${s.lock}\n    secure=${secure}\n`;
    if (command === 'wm dismiss-keyguard') { if (!secure) s.lock = false; return ''; }
    if (command === `am start -S -W -n ${PKG}/.MainActivity`) { s.coldStarts++; s.screen = 'loading'; s.loadingLeft = loadingReads; return 'Status: ok'; }
    if (command.startsWith('uiautomator dump ')) {
      y = 0;
      if (s.screen === 'loading' && s.loadingLeft-- <= 0) s.screen = 'home';
      let shown = s.screen;
      if (shown === 'history' && s.switchLag > 0) { s.switchLag--; shown = 'progress'; }
      else if (shown === 'history') s.historyReads++;
      if (shown === 'progress') s.progressReads++;
      s.file = xml(screens[shown](), shown === 'launcher' ? 'com.android.launcher3' : PKG); return '';
    }
    if (command.startsWith('cat ')) return s.file;
    if (command.startsWith('input tap ')) {
      const [x, yy] = command.slice(10).split(' ').map(Number), target = at(x, yy);
      const key = target?.desc || target?.text;
      if (key === 'account menu') s.screen = 'menu'; else if (key === 'Bookings') s.screen = 'progress';
      else if (key === 'History') { s.screen = 'history'; s.switchLag = slowTabSwitch; }
      // On the phone the broken page stayed broken after tapping In progress.
      else if (key === 'In progress' && s.screen !== 'broken') s.screen = 'progress';
      else if (key === 'Access' && s.screen === 'history') s.screen = 'detail';
      return '';
    }
    if (command.startsWith('input swipe ')) { s.swipes++; return ''; }
    if (command === 'input keyevent KEYCODE_BACK') { s.screen = s.screen === 'detail' ? 'broken' : 'launcher'; return ''; }
    return '';
  };
  return {s, rootCommand};
}
const context = () => ({fromDay: '2026-09-28', deadlineAt: Date.now() + 120000});
const run = (d, ctx = context()) => collectClickAndBoatApp(ctx, {rootCommand: d.rootCommand, sleep: async () => {}});

test('reads both tabs and the reschedule detail from the app, keeping renters out of the snapshot', async () => {
  const d = device(), snap = await run(d);
  assert.equal(snap.source, 'clickandboat'); assert.equal(snap.complete, true); assert.equal(snap.pagination.listed_count, 5);
  const byId = Object.fromEntries(snap.orders.map(o => [o.booking_id, o]));
  assert.deepEqual(Object.keys(byId).sort(), ['1000002', '1250578', '1300001']);
  assert.equal(byId['1000002'].status, 'accepted'); assert.equal(byId['1000002'].payment_basis, APP_PAYMENT_BASIS);
  assert.equal(byId['1000002'].url, 'https://www.clickandboat.com/uk/booking/1000002/detail'); assert.equal(byId['1000002'].amount, '€12,705.00');
  assert.equal(byId['1250578'].status, 'pending'); assert.equal(byId['1250578'].payment_basis, undefined);
  assert.equal(byId['1300001'].status, 'cancelled');
  assert.deepEqual(snap.manual_order_observations.map(o => [o.booking_id, o.platform_status, o.start, o.end]), [['1000000', 'ACCEPTED', '2027-03-06', '2027-03-13']]);
  assert.ok(!JSON.stringify(snap).includes('Fixture Renter') && !JSON.stringify(snap).includes('fixture@example.invalid'));
  // Both passes start from a fresh app and BACK is never pressed.
  assert.equal(d.s.coldStarts, 2); assert.ok(!d.s.commands.includes('input keyevent KEYCODE_BACK'));
  // Foreground goes back to Chrome and the screen back to sleep.
  assert.ok(d.s.commands.includes('am start -n com.android.chrome/com.google.android.apps.chrome.Main'));
  assert.equal(d.s.commands.at(-1), 'input keyevent 223'); assert.equal(d.s.power, 'Dozing');
  requirePaymentEvidence('clickandboat', snap);
});

test('a broken page left by an earlier run is never read, because every pass restarts the app', async () => {
  y = 0;
  const d = device({leftoverBroken: true});
  assert.throws(() => appBookingRows(appNodes(xml([...header(), n('Accepted '), n('i'), n('N°1'), n('x'), n(BOATS.ad5), n('from 7 to 13 November 2026 (14:00 / 10:00)'),
    n('N°2'), n('y'), n(BOATS.ad2), n('from 7 to 13 November 2026 (14:00 / 10:00)')]))), error => error.code === 'schema_changed');
  const snap = await run(d);
  assert.equal(d.s.coldStarts, 2); assert.equal(snap.pagination.listed_count, 5);
});

test('a slow switch to History is waited out and never read as History', async () => {
  const d = device({slowTabSwitch: 3}), snap = await run(d);
  assert.deepEqual(snap.orders.map(o => o.booking_id).sort(), ['1000002', '1250578', '1300001']);
  assert.equal(snap.pagination.listed_count, 5);
});

test('a list that never leaves the other tab is reported, not published', async () => {
  await assert.rejects(run(device({slowTabSwitch: 50})), error => error.code === 'incomplete_pages');
});

test('a verification page inside the app stops with challenge_required and still restores the screen', async () => {
  const d = device({challenge: true});
  await assert.rejects(run(d), error => error.code === 'challenge_required');
  assert.equal(d.s.power, 'Dozing');
});

test('a password-protected lock screen is never unlocked', async () => {
  const d = device({secure: true});
  await assert.rejects(run(d), error => error.code === 'fetch_failed');
  assert.ok(!d.s.commands.includes('wm dismiss-keyguard')); assert.ok(!d.s.commands.some(c => c.includes(PKG + '/')));
});

test('orders changing between the two passes are not published', async () => {
  await assert.rejects(run(device({changeSecondHistory: true})), error => error.code === 'incomplete_pages');
});

test('a half-rendered list is read again until two reads agree, never taken as data', async () => {
  const d = device({halfRenderedReads: 2}), snap = await run(d);
  assert.ok(d.s.progressReads >= 4); assert.ok(snap.orders.some(o => o.booking_id === '1000002' && o.start === '2026-11-07'));
});

test('the reschedule entry is scrolled into view before it is opened', async () => {
  const d = device({manualVisibleAfterSwipes: 3}), snap = await run(d);
  assert.ok(d.s.swipes >= 3); assert.equal(snap.manual_order_observations[0].platform_status, 'ACCEPTED');
});

test('row parsing takes status, boat, dates and amount, and rejects a row without a unique date', () => {
  y = 0;
  const rows = appBookingRows(appNodes(xml([...header(), ...row('1000002', 'Accepted', BOATS.ad5, 'from 7 to 13 November 2026 (14:00 / 10:00)', '€12,705')])));
  assert.deepEqual(rows, [{booking_id: '1000002', status: 'Accepted', boat_text: BOATS.ad5, date_text: 'from 7 to 13 November 2026 (14:00 / 10:00)', amount: '€12,705'}]);
  // Observed on the phone: one booking number exposed twice back to back.
  y = 0;
  const repeated = appBookingRows(appNodes(xml([...header(), n('Accepted '), n('i'), n('N°1256673'), n('N°1256673'), n('Fixture Renter'), n(BOATS.ad5),
    n('from 22 to 25 December 2026 (14:00 / 10:00)'), n('€6,384')])));
  assert.deepEqual(repeated.map(r => [r.booking_id, r.date_text]), [['1256673', 'from 22 to 25 December 2026 (14:00 / 10:00)']]);
  y = 0;
  assert.throws(() => appBookingRows(appNodes(xml([n('Accepted'), n('N°1'), n('x'), n(BOATS.ad5)]))), error => error.code === 'schema_changed');
  assert.equal(appScreen(appNodes(xml([n('Verify you are human')]))).challenge, true);
});

test('only an app order labelled Accepted gets the app basis; the website evidence path is unchanged', () => {
  const base = {source: 'clickandboat', booking_id: '1', url: 'https://www.clickandboat.com/uk/booking/1/detail'};
  assert.throws(() => requirePaymentEvidence('clickandboat', {orders: [{...base, status: 'accepted', platform_status: 'Accepted'}]}));
  assert.throws(() => requirePaymentEvidence('clickandboat', {orders: [{...base, status: 'accepted', platform_status: 'Pending', payment_basis: APP_PAYMENT_BASIS}]}));
  requirePaymentEvidence('clickandboat', {orders: [{...base, status: 'accepted', platform_status: 'Accepted', payment_basis: APP_PAYMENT_BASIS}]});
  requirePaymentEvidence('clickandboat', {orders: [{...base, status: 'accepted', customer_payment_verified: true, customer_paid_amount: 10}]});
});

test('the planner protects an app-accepted Click&Boat order on the other platforms', () => {
  const now = Date.parse('2026-09-29T06:00:00Z'), stamp = new Date(now).toISOString();
  const status = {platforms: Object.fromEntries(['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys'].map(s => [s, {mode: 'dynamic', last_error: null, last_success_at: stamp}]))};
  const order = {booking_id: '1000002', boataround_slug: 'grandcat-55-tidewyn-discovery-5', start: '2026-11-07', end: '2026-11-13', status: 'accepted',
    platform_status: 'Accepted', payment_basis: APP_PAYMENT_BASIS, verified_at: stamp};
  const plan = buildPlan({boataround: [], clickandboat: [order], samboat: [], mmk: [], nausys: []}, status, {now});
  assert.deepEqual(plan.excluded, []);
  assert.deepEqual(plan.targets.find(t => t.boat === order.boataround_slug && t.target === 'boataround').segments.map(s => s.causes), [['clickandboat:1000002']]);
  const unlabelled = buildPlan({boataround: [], clickandboat: [{...order, platform_status: 'Pending'}], samboat: [], mmk: [], nausys: []}, status, {now});
  assert.equal(unlabelled.excluded[0].reason, 'payment_unverified');
});
