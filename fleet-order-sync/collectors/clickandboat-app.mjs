// Click&Boat bookings read from the owner's official Android app
// (com.clickandboat.androidphone), 2026-09-29.
//
// Why: Click&Boat's website now answers the phone's automated browser with a
// Cloudflare check that a person cannot pass either. The official app shows
// the same owner bookings page without that check. The user decided to read it
// here and to count an order shown as Accepted in the app (no separate customer
// payment proof is visible in the app).
//
// Boundaries: this only reads what the app displays, through Android's own
// screen hierarchy (uiautomator) and ordinary taps, like a person. It never
// modifies the app, intercepts or decrypts its traffic, reads its storage or
// tokens, or disguises anything. If the app itself shows a verification or
// login page, it stops and reports that. Renter names and contact details on
// the screen are never kept. Each pass restarts the app (like closing it from
// the recent apps list and opening it again).
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FLEET, parseClickAndBoatListRow, parseClickAndBoatDetail} from '../parsers.mjs';
import {mmkKeyguardState} from '../phone-server/mmk-login.mjs';

const exec = promisify(execFile);
export const CLICKANDBOAT_APP = 'com.clickandboat.androidphone';
const APP_ACTIVITY = CLICKANDBOAT_APP + '/.MainActivity';
const CHROME_MAIN = 'com.android.chrome/com.google.android.apps.chrome.Main';
// This user-authorized reschedule is observed from its detail page every run.
const MANUAL_OBSERVATION_ID = '1000000';
export const APP_PAYMENT_BASIS = 'platform_accepted';
const PAYMENT_BASIS_SOURCE = 'Click&Boat 官方 App 订单列表状态 Accepted（用户 2026-09-29 确认以此为准，App 不显示客户付款）';
const STATUS = /^(Accepted|Completed|Cancell?ed|Canceled|Refused|Declined|Pending|Awaiting|Awaiting-weather|Pending \(due to weather conditions\))$/i;
const CHALLENGE = /just a moment|verify you are human|checking your browser|security verification|are you a robot|captcha/i;
const LOGIN = /^(log in|login|sign in|sign up|connexion|se connecter)$/i;

const fail = (code, message) => { throw Object.assign(new Error(message || code), {code}); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonicalUrl = id => `https://www.clickandboat.com/uk/booking/${id}/detail`;
const decode = value => String(value ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tidy = value => decode(value).replace(/\s+/g, ' ').trim();

/** Brings the screen to Awake with no lock screen, before every screen read.
 * Reproduced 2026-10-04: from the dozing lock screen, a wake plus
 * `wm dismiss-keyguard` often succeeded only briefly; after the app started,
 * ColorOS showed its lock screen again and dozed, and the next read saw only
 * system UI (about half of such reads ended in app_not_in_foreground).
 * MENU dismisses the swipe lock screen and keeps the phone awake. A lock
 * screen with a password is never unlocked: that fails as device_locked.
 * `settle` > 0 also requires the state to hold after that many ms. */
export async function ensureScreenAwake(root, sleep, {settle = 0} = {}) {
  // The code is also the message: the calendar ledger records error messages.
  const stop = code => { throw Object.assign(new Error(code), {code}); };
  // A failed root command or an unreadable lock-screen state gets one honest
  // code (it used to surface as "login expired" or raw command text).
  const read = async () => {
    try { return {awake: /mWakefulness=Awake\b/.test(await root('dumpsys power')), lock: mmkKeyguardState(await root('dumpsys window policy'))}; }
    catch (error) { if (['timeout', 'executor_cancelled'].includes(error?.code) || error?.message === 'executor_cancelled') throw error; stop('screen_state_unavailable'); }
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    let state = await read();
    if (state.lock.showing && state.lock.secure) stop('device_locked');
    if (state.awake && !state.lock.showing) {
      if (!settle) return;
      await sleep(settle); state = await read();
      if (state.awake && !state.lock.showing) return;
      continue;
    }
    if (!state.awake) { await root('input keyevent 224'); await sleep(300); state = await read(); }
    if (state.lock.showing && state.lock.secure) stop('device_locked');
    if (state.lock.showing) {
      await root('wm dismiss-keyguard'); await sleep(300);
      // MENU only while the lock screen is still up: once it is gone, MENU
      // would reach the app in front (Chrome, launcher or Click&Boat).
      state = await read();
      if (state.lock.showing && state.lock.secure) stop('device_locked');
      if (state.lock.showing) { await root('input keyevent 82'); await sleep(600); }
    }
  }
  stop('screen_not_awake');
}

/** Parse a uiautomator dump into ordered nodes with decoded text. */
export function appNodes(xml) {
  const text = String(xml ?? '').trim();
  if (!/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/.test(text)) fail('fetch_failed', 'Click&Boat App 屏幕结构读取失败');
  return [...text.matchAll(/<node\b[^>]*>/g)].map(match => {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    const box = (attrs.bounds || '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number) || [0, 0, 0, 0];
    // The app's WebView exposes a filled password field's text; never keep it.
    const secret = attrs.password === 'true';
    return {text: secret ? '' : tidy(attrs.text), desc: secret ? '' : tidy(attrs['content-desc']), pkg: attrs.package || '',
      rid: (attrs['resource-id'] || '').split('/').pop(), clickable: attrs.clickable === 'true', box, visible: box[2] > box[0] && box[3] > box[1]};
  });
}
const texts = nodes => nodes.filter(n => n.text).map(n => n.text);
export function appScreen(nodes) {
  const all = nodes.flatMap(n => [n.text, n.desc]).filter(Boolean);
  return {
    bookings: all.includes('All your bookings') && nodes.some(n => n.clickable && n.text === 'In progress') && nodes.some(n => n.clickable && n.text === 'History'),
    challenge: all.some(value => CHALLENGE.test(value)),
    login: nodes.some(n => n.visible && n.clickable && (LOGIN.test(n.text) || LOGIN.test(n.desc))) && !all.includes('Log out'),
    pagination: nodes.some(n => /(?:^|[?&])page=\d/.test(n.desc) && /booking/i.test(n.desc)),
  };
}

/** Booking rows of the tab currently shown. Customer names are skipped. */
export function appBookingRows(nodes) {
  // The app's WebView can expose one text twice in a row (a nested element
  // repeating its parent, observed for a booking number on 2026-09-29).
  const list = texts(nodes).filter((value, index, all) => index === 0 || value !== all[index - 1]), rows = [];
  const starts = list.map((value, index) => /^N[°º]\d+$/.test(value) ? index : -1).filter(index => index >= 0);
  starts.forEach((start, k) => {
    const booking_id = list[start].replace(/^N[°º]/, '');
    // The status and its info icon precede the number in document order.
    const status = list.slice(Math.max(0, start - 3), start).reverse().find(value => STATUS.test(value));
    if (!status) fail('schema_changed', 'Click&Boat App 订单行缺少状态');
    const end = k + 1 < starts.length ? starts[k + 1] : list.length;
    const segment = list.slice(start + 1, end);
    const dates = segment.map((value, index) => /^from \d/i.test(value) ? index : -1).filter(index => index >= 0);
    if (dates.length !== 1 || dates[0] < 1) fail('schema_changed', 'Click&Boat App 订单行日期无法唯一识别');
    const amounts = segment.slice(dates[0] + 1).filter(value => /^€\s?[\d.,]+$/.test(value));
    if (amounts.length > 1) fail('schema_changed', 'Click&Boat App 订单行金额无法唯一识别');
    rows.push({booking_id, status, boat_text: segment[dates[0] - 1], date_text: segment[dates[0]], amount: amounts[0] ?? null});
  });
  if (new Set(rows.map(row => row.booking_id)).size !== rows.length) fail('incomplete_pages', 'Click&Boat App 订单号重复');
  return rows;
}
const manifest = rows => JSON.stringify(rows.map(r => [r.booking_id, r.status, r.boat_text, r.date_text, r.amount]).sort());
const parseRow = (row, verifiedAt) => {
  const record = parseClickAndBoatListRow({booking_id: row.booking_id, url: canonicalUrl(row.booking_id), status: row.status,
    visibleStates: [row.status], boat_text: row.boat_text, date_text: row.date_text, amount: row.amount}, {verifiedAt});
  return {...record, verification_source: 'Click&Boat 官方 App 订单列表可见行（状态、船只、日期、船东净收入）'};
};

export async function collectClickAndBoatApp(context, {rootCommand, sleep = pause, now = Date.now} = {}) {
  const check = () => { if (context.signal?.aborted || !Number.isFinite(context.deadlineAt) || now() >= context.deadlineAt) fail('timeout', '同步超时，保留上次完整订单'); };
  const diagnostic = (stage, reason = 'progress') => { try { context.reportDiagnostic?.({stage, reason}); } catch {} };
  const root = rootCommand || (async command => { check();
    return (await exec('su', ['-c', command], {timeout: Math.max(1, Math.min(15000, context.deadlineAt - now())), maxBuffer: 8 * 1024 * 1024, signal: context.signal})).stdout; });
  const file = '/data/local/tmp/fleet-cb-app-' + process.pid + '.xml';
  const awake = async options => {
    try { await ensureScreenAwake(root, sleep, options); }
    catch (error) {
      if (error.code === 'timeout') throw error;
      fail('fetch_failed', error.code === 'device_locked' ? '手机锁屏有密码，无法打开 Click&Boat App' : '手机屏幕无法保持亮屏解锁');
    }
  };
  // The phone can fall back to its dozing lock screen at any moment (see
  // ensureScreenAwake), so every read first makes sure the app can be seen.
  const dump = async () => {
    await awake();
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      try { await root('rm -f ' + file); await root('uiautomator dump ' + file); return appNodes(await root('cat ' + file)); }
      catch (error) { if (error.code === 'timeout' || attempt === 2) throw error.code ? error : Object.assign(error, {code: 'fetch_failed'}); await sleep(700); }
    }
  };
  const tap = async node => { check(); const [x1, y1, x2, y2] = node.box; await root(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`); await sleep(2500); };
  const guard = nodes => { const screen = appScreen(nodes);
    if (screen.challenge) fail('challenge_required', 'Click&Boat App 显示人工访问验证，保留上次完整订单');
    if (screen.login) fail('auth_required', 'Click&Boat App 未登录，保留上次完整订单');
    if (!nodes.some(n => n.pkg === CLICKANDBOAT_APP)) fail('fetch_failed', 'Click&Boat App 不在前台');
    return screen; };
  // Each pass starts from a fresh app. On 2026-09-29 the bookings page shown
  // again after BACK from a booking detail exposed rows without their status
  // text, and the app kept showing that page when opened later, so a restored
  // page is never read.
  const launch = async () => { await root('am start -S -W -n ' + APP_ACTIVITY); await sleep(2000); };
  const openBookings = async () => {
    // After a start the page is blank or half drawn for several seconds: wait
    // for a known control. BACK is not used, it would close the app here.
    let taps = 0;
    for (let step = 0; step < 20 && taps < 6; step++) {
      const nodes = await dump(), screen = guard(nodes);
      if (screen.bookings) return nodes;
      const visible = nodes.filter(n => n.visible);
      const next = visible.find(n => n.clickable && n.desc === 'Bookings') || visible.find(n => n.clickable && n.desc === 'account menu') ||
        (visible.some(n => n.text === 'Boat Hire') ? visible.find(n => n.clickable && n.desc === 'close') : null);
      if (next) { taps++; await tap(next); } else await sleep(1500);
    }
    fail('schema_changed', 'Click&Boat App 未能打开订单页');
  };
  const readTab = async (name, nodes, otherIds = new Set()) => {
    const tab = nodes.filter(n => n.visible && n.clickable && n.text === name);
    if (tab.length !== 1) fail('schema_changed', 'Click&Boat App 订单标签无法定位');
    await tap(tab[0]);
    // The app's page renders progressively. Accept a tab only when two
    // consecutive reads parse completely and agree; a half-rendered row is
    // treated as "not loaded yet", never as data. Rows of the tab read before
    // mean the switch has not happened yet.
    let previous = null;
    for (let wait = 0; wait < 8; wait++) {
      const after = await dump(), screen = guard(after);
      if (!screen.bookings) { await sleep(1500); continue; }
      if (screen.pagination) fail('incomplete_pages', 'Click&Boat App 订单出现分页，尚未支持');
      let rows = null;
      try { rows = appBookingRows(after); } catch (error) { if (!['schema_changed', 'incomplete_pages'].includes(error.code)) throw error; }
      if (rows?.length && !rows.some(r => otherIds.has(r.booking_id))) {
        const current = manifest(rows); if (current === previous) return {rows, nodes: after}; previous = current;
      } else previous = null;
      await sleep(1500);
    }
    // An empty or never-stable tab cannot be told apart from one still loading.
    fail('incomplete_pages', 'Click&Boat App 订单列表未能稳定读取');
  };
  const readBoth = async start => {
    const progress = await readTab('In progress', start);
    const history = await readTab('History', progress.nodes, new Set(progress.rows.map(r => r.booking_id)));
    return {rows: [...progress.rows, ...history.rows], history};
  };
  const readManualDetail = async (history, rows) => {
    const row = rows.find(r => r.booking_id === MANUAL_OBSERVATION_ID);
    if (!row) fail('incomplete_pages', 'Click&Boat 人工改期订单未出现在完整列表，保留上次订单并等待核查');
    let nodes = history.nodes;
    for (let swipe = 0; swipe < 16; swipe++) {
      const at = nodes.findIndex(n => n.text === 'N°' + MANUAL_OBSERVATION_ID || n.text === 'Nº' + MANUAL_OBSERVATION_ID);
      const access = at < 0 ? null : nodes.slice(at).find(n => n.clickable && n.desc === 'Access');
      if (access?.visible && access.box[1] >= 350 && access.box[3] <= 2200) { diagnostic('detail_navigation'); await tap(access); break; }
      check(); await root('input swipe 540 1800 540 800 500'); await sleep(1200); nodes = await dump(); guard(nodes);
      if (swipe === 15) fail('schema_changed', 'Click&Boat App 人工改期订单详情入口无法定位');
    }
    diagnostic('detail_ready');
    for (let wait = 0; wait < 5; wait++) {
      const detail = await dump(); guard(detail);
      if (texts(detail).includes('Booking N°' + MANUAL_OBSERVATION_ID)) {
        diagnostic('detail_parse');
        return parseClickAndBoatDetail({bodyText: texts(detail).join('\n'), url: canonicalUrl(MANUAL_OBSERVATION_ID),
          boataround_slug: parseRow(row, new Date(now()).toISOString()).boataround_slug, verifiedAt: new Date(now()).toISOString()});
      }
      await sleep(1500);
    }
    fail('schema_changed', 'Click&Boat App 人工改期订单详情未打开');
  };

  let wasAsleep = false, powerKnown = false, chromeWasTop = false;
  check();
  try {
    diagnostic('list_navigation');
    const power = await root('dumpsys power');
    powerKnown = /mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power); if (!powerKnown) fail('fetch_failed', '手机屏幕状态无法读取');
    wasAsleep = /mWakefulness=(?:Asleep|Dozing)/.test(power);
    chromeWasTop = /topResumedActivity=[^\n]*com\.android\.chrome\//.test(await root('dumpsys activity activities'));
    // A credential-protected lock screen is never unlocked by this program.
    await awake({settle: 800});
    await launch();
    const first = await readBoth(await openBookings());
    diagnostic('list_ready');
    const manual = await readManualDetail(first.history, first.rows);
    diagnostic('final_recheck');
    await launch();
    const second = await readBoth(await openBookings());
    if (manifest(first.rows) !== manifest(second.rows)) fail('incomplete_pages', 'Click&Boat App 订单在核验期间变化，保留上次订单');
    const stamp = new Date(now()).toISOString();
    const records = second.rows.map(row => parseRow(row, stamp));
    const orders = records.filter(record => record.end >= context.fromDay).map(record => record.status === 'accepted'
      ? {...record, payment_basis: APP_PAYMENT_BASIS, payment_basis_source: PAYMENT_BASIS_SOURCE} : record);
    check();
    return {source: 'clickandboat', run_id: crypto.randomUUID(), checked_at: stamp, complete: true,
      scope: {kind: 'current_future', from_day: context.fromDay, fleet_slugs: FLEET.map(boat => boat.slug)},
      expected_count: orders.length, orders,
      manual_order_observations: [{booking_id: manual.booking_id, boataround_slug: manual.boataround_slug,
        platform_status: manual.platform_status, start: manual.start, end: manual.end, checked_at: manual.verified_at, detail_url: manual.url}],
      pagination: {complete: true, total_pages: 1, pages_read: [1], listed_count: records.length}};
  } catch (error) {
    if (error?.name === 'OrderParseError') error.code = 'schema_changed';
    throw error;
  } finally {
    // Bounded restore, even after cancellation: give the foreground back to
    // Chrome (the native collectors expect it) and restore the screen state.
    const cleanup = rootCommand || (async command => (await exec('su', ['-c', command], {timeout: 4000, maxBuffer: 65536})).stdout);
    await cleanup('rm -f ' + file).catch(() => {});
    await cleanup(chromeWasTop ? 'am start -n ' + CHROME_MAIN : 'input keyevent KEYCODE_HOME').catch(() => {});
    if (powerKnown && wasAsleep) await cleanup('input keyevent 223').catch(() => {});
  }
}
