// A fake phone reproduces the Click&Boat app calendar observed on 2026-09-29:
// home → account menu → Calendar → two listing pages → the listing calendar
// with its date pickers, Reason field, Add button and future records list.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ClickAndBoatAppAdapter, appBlock, appBlockFromWeb, appCalendarRows, migrateWebLedger} from './clickandboat-app-adapter.mjs';
import {appNodes} from '../collectors/clickandboat-app.mjs';
import {ReverseExecutor} from './executor.mjs';
import {permitsContentIdReuse} from './release.mjs';

const PKG = 'com.clickandboat.androidphone';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OFF = '[72,2344][1008,2344]';
const b = (x1, y1, x2, y2) => `[${x1},${y1}][${x2},${y2}]`;
const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const n = (text, {desc = '', click = false, rid = '', box = '[72,600][1008,660]'} = {}) => ({text, desc, click, rid, box});
const xml = nodes => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  nodes.map(x => `<node index="0" text="${esc(x.text)}" resource-id="${esc(x.rid)}" package="${PKG}" content-desc="${esc(x.desc)}" clickable="${x.click}" bounds="${x.box}" />`).join('') + '</hierarchy>';
const inside = (box, x, y) => { const [x1, y1, x2, y2] = box.match(/\d+/g).map(Number); return y2 > y1 && x >= x1 && x <= x2 && y >= y1 && y <= y2; };
const words = day => { const [y, m, d] = day.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const slash = day => day.split('-').reverse().join('/');
const PAGES = [['100003', '100007', '100005', '100006', '100001'], ['100004', '100002']];
const target = listing => ({target: 'clickandboat', boat: {'100004': 'seacat-open-40-tidewyn-discovery-2', '100007': 'grandcat-55-tidewyn-discovery-5'}[listing] || 'x', listing_id: listing});
// Calendar rows as the platform stores them; booked rows cannot be edited.
const ROWS = () => ({
  '100004': [{from: '2026-11-07', to: '2026-11-13', toTime: '10:00', label: 'Unavailable', editable: false},
    {from: '2026-11-13', to: '2026-11-13', toTime: '23:59', label: 'Unavailable', editable: true},
    {from: '2026-12-05', to: '2026-12-11', toTime: '23:59', label: 'Unavailable', editable: true}],
  '100007': [{from: '2026-10-17', to: '2026-10-23', toTime: '23:59', label: 'Breakdown / Damage', editable: true}]});

// As observed: a record's trash icon deletes at once (no confirmation) and
// the page reloads at its top; list rows come into view by scrolling.
const EDIT = '', DELETE = '';
// away[k]: after app start k, that many screen reads show another app in front
// (stuckAway: bringing the app forward again does not help).
// missAt/missFrom: on those app starts the list leaves out the row from that day.
function phone({rows = ROWS(), add = 'append', secure = false, challenge = false, icons = [EDIT, DELETE], greyEnd = [], greyFrom = [], oddLaunches = 0, oddAt = [],
  away = [], stuckAway = false, missAt = [], missFrom = null} = {}) {
  const s = {screen: 'home', power: 'Dozing', lock: true, loading: 0, page: 1, scrolled: false, listing: null, commands: [], file: '', adds: 0, launches: 0, odd: false,
    deletes: 0, edits: 0, calScroll: 0, form: {from: '', to: '', reason: ''}, picker: null, pickerMonth: null, dropdown: false, touched: false, rows, away: 0};
  const sorted = () => [...(s.rows[s.listing] || [])].filter(r => !(missAt.includes(s.launches - 1) && r.from === missFrom)).sort((a, c) => a.from.localeCompare(c.from));
  // After k scrolls the rows (k-1)*3 .. (k-1)*3+2 are on screen.
  const rowY = i => { const j = i - (s.calScroll - 1) * 3; return s.calScroll > 0 && j >= 0 && j < 3 ? 600 + j * 400 : null; };
  const calendar = () => {
    const nodes = [n('Modify your ad!', {box: b(3, 315, 1077, 498)}), n('september 2026', {box: OFF}),
      n('Select the dates when your boat is unavailable.', {box: b(30, 972, 1050, 1173)}), n('From', {box: b(30, 1215, 1050, 1278)}),
      n(s.form.from, {rid: 'date-from', click: true, box: b(30, 1287, 1050, 1440)}), n('to', {box: b(30, 1497, 1050, 1560)}),
      n(s.form.to, {rid: 'date-to', click: true, box: b(30, 1569, 1050, 1722)}), n('Reason', {box: b(30, 1779, 1050, 1839)}),
      n(s.dropdown ? ' Select… Unavailable Breakdown / Damage Wintering / End of season' : s.touched && !s.form.reason ? ' Select…' : '', {rid: 'availa-type', box: b(30, 1848, 1050, 2001)}),
      n(s.form.reason || 'Select…', {box: b(81, 1896, 330, 1953)}), n('Add', {rid: 'btn-add-unavaila', click: true, box: b(30, 2058, 267, 2205)})];
    if (s.picker) {
      const [y, m] = s.pickerMonth, first = y * 12 + m === 2026 * 12 + 8;
      nodes.push(first ? n('Previous', {box: b(39, 393, 120, 477)}) : n('', {desc: 'Previous', click: true, box: b(39, 393, 120, 477)}),
        n('', {desc: 'Next', click: true, box: b(912, 393, 993, 477)}), n(`${MONTHS[m].toLowerCase()} ${y}`, {box: b(135, 399, 897, 483)}));
      const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      for (let d = 1; d <= days; d++) {
        const col = (d - 1) % 7, row = Math.floor((d - 1) / 7), box = b(33 + col * 138, 645 + row * 126, 171 + col * 138, 771 + row * 126);
        nodes.push(first && d < 28 ? n(String(d), {box}) : n('', {desc: String(d), click: true, box}));
      }
    }
    nodes.push(n('Your future periods of unavailability', {box: OFF}));
    // The first oddLaunches app starts show the list in a shape not seen before.
    if (s.odd) nodes.push(n('Something new', {box: OFF}));
    let month = null;
    sorted().forEach((r, i) => {
      const heading = MONTHS[Number(r.from.slice(5, 7)) - 1] + ' ' + r.from.slice(0, 4), y = rowY(i);
      if (heading !== month) { nodes.push(n(heading, {box: OFF})); month = heading; }
      nodes.push(n('From ' + words(r.from), {box: OFF}), n(`To ${words(r.to)}, ${r.toTime}`, {box: OFF}), n(r.label, {box: OFF}));
      // Off screen, Android keeps a node's x and clips its height to zero.
      if (r.editable) nodes.push(n('', {desc: icons[0], click: true, box: y === null ? b(906, 2344, 963, 2344) : b(906, y, 963, y + 48)}), n(icons[0], {box: OFF}),
        n('', {desc: icons[1], click: true, box: y === null ? b(975, 2344, 1032, 2344) : b(975, y, 1032, y + 48)}), n(icons[1], {box: OFF}));
    });
    return [...nodes, n('ABOUT US', {box: OFF})];
  };
  const listings = () => {
    const ids = PAGES[s.page - 1] || [], nodes = [n('Listings', {box: b(72, 408, 1008, 516)})];
    ids.forEach((id, i) => {
      const y = s.scrolled ? (i >= 3 ? 567 + (i - 3) * 639 : null) : (i < 3 ? 843 + i * 639 : null);
      nodes.push(n('', {desc: `Boat calendar${i % 2 ? ' to update' : ''}: #${id}`, click: true, box: y === null ? '[972,120][1032,120]' : b(972, y, 1032, y + 60)}),
        n(`#${id} · Model ${id}`, {box: y === null ? OFF : b(72, y + 72, 696, y + 120)}));
    });
    const links = s.scrolled || ids.length < 4;
    nodes.push(n('', {desc: `listings?page=${s.page - 1}`, click: true, box: links ? b(288, 1902, 396, 2010) : OFF}),
      n('', {desc: `listings?page=${s.page + 1}`, click: true, box: links ? b(684, 1902, 792, 2010) : OFF}));
    return nodes;
  };
  const screens = {
    loading: () => [n('')],
    home: () => [n('', {desc: 'account menu', click: true, box: b(894, 159, 1008, 273)}), n('The best solution for your boat hire'), ...(challenge ? [n('Just a moment...')] : [])],
    menu: () => [n('', {desc: 'close', click: true, box: b(75, 171, 147, 243)}), n('', {desc: 'Calendar 3', click: true, box: b(3, 747, 1077, 891)}), n('Calendar'),
      n('', {desc: 'Log out', click: true, box: b(3, 1518, 1077, 1662)})],
    listings, calendar};
  const clickables = () => screens[s.screen]().filter(x => x.click);
  const tap = (x, y) => {
    if (s.screen !== 'calendar') {
      const hit = clickables().find(c => inside(c.box, x, y)), key = hit?.desc;
      if (key === 'account menu') s.screen = 'menu';
      else if (/^Calendar/.test(key || '')) { s.screen = 'listings'; s.page = 1; s.scrolled = false; }
      else if (/^Boat calendar/.test(key || '')) { s.screen = 'calendar'; s.listing = key.split('#')[1]; }
      // As observed, the last page still links a following (empty) page.
      else if (/^listings\?page=/.test(key || '')) { const p = Number(key.split('=')[1]); if (p >= 1) { s.page = p; s.scrolled = false; } }
      return;
    }
    if (s.calScroll > 0) {
      sorted().forEach((r, i) => {
        const ry = rowY(i);
        if (ry === null || !r.editable) return;
        if (inside(b(975, ry, 1032, ry + 48), x, y)) { s.rows[s.listing] = s.rows[s.listing].filter(other => other !== r); s.deletes++; s.calScroll = 0; }
        else if (inside(b(906, ry, 963, ry + 48), x, y)) s.edits++;
      });
      return;
    }
    if (s.dropdown) { s.dropdown = false; if (y >= 2001 && y < 2141) s.form.reason = 'Unavailable'; else if (y >= 2141 && y < 2281) s.form.reason = 'Breakdown / Damage'; return; }
    if (s.picker) {
      const hit = screens.calendar().find(c => c.click && inside(c.box, x, y) && (c.desc === 'Next' || c.desc === 'Previous' || /^\d+$/.test(c.desc)));
      if (hit?.desc === 'Next' || hit?.desc === 'Previous') { const t = s.pickerMonth[0] * 12 + s.pickerMonth[1] + (hit.desc === 'Next' ? 1 : -1); s.pickerMonth = [Math.floor(t / 12), t % 12]; return; }
      if (hit) {
        const day = `${s.pickerMonth[0]}-${String(s.pickerMonth[1] + 1).padStart(2, '0')}-${hit.desc.padStart(2, '0')}`;
        // As observed 2026-10-10: some end days are greyed out; a tap does nothing.
        if (s.picker === 'to' && greyEnd.includes(day) || s.picker === 'from' && greyFrom.includes(day)) return;
        s.form[s.picker] = slash(day);
        // As observed: choosing the start date opens the end date picker.
        if (s.picker === 'from') s.picker = 'to'; else { s.picker = null; s.touched = true; }
        return;
      }
      if (inside(b(30, 1779, 1050, 1839), x, y)) { s.picker = null; s.touched = true; }
      return;
    }
    if (inside(b(30, 1287, 1050, 1440), x, y)) { s.picker = 'from'; s.pickerMonth = [2026, 8]; }
    else if (inside(b(30, 1569, 1050, 1722), x, y)) { s.picker = 'to'; if (!s.pickerMonth) s.pickerMonth = [2026, 8]; }
    else if (inside(b(30, 1848, 1050, 2001), x, y)) s.dropdown = true;
    else if (inside(b(30, 2058, 267, 2205), x, y) && s.form.from && s.form.to && s.form.reason) {
      s.adds++;
      const iso = v => v.split('/').reverse().join('-');
      if (add === 'append' || add === 'wrong') {
        const to = add === 'wrong' ? new Date(Date.parse(iso(s.form.to) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : iso(s.form.to);
        s.rows[s.listing].push({from: iso(s.form.from), to, toTime: '23:59', label: s.form.reason, editable: true});
      }
    }
  };
  const rootCommand = async command => {
    s.commands.push(command);
    if (command === 'dumpsys power') return `mWakefulness=${s.power}`;
    if (command === 'dumpsys activity activities') return 'topResumedActivity=ActivityRecord{1 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t1}';
    if (command === 'input keyevent 224') { s.power = 'Awake'; return ''; }
    if (command === 'input keyevent 223') { s.power = 'Dozing'; return ''; }
    if (command === 'dumpsys window policy') return `  KeyguardServiceDelegate\n    showing=${s.lock}\n    secure=${secure}\n`;
    if (command === 'wm dismiss-keyguard') { if (!secure) s.lock = false; return ''; }
    if (command === `am start -S -W -n ${PKG}/.MainActivity`) {
      Object.assign(s, {screen: 'loading', loading: 2, form: {from: '', to: '', reason: ''}, picker: null, pickerMonth: null, dropdown: false, touched: false, scrolled: false, calScroll: 0,
        odd: s.launches < oddLaunches || oddAt.includes(s.launches), away: away[s.launches] || 0}); s.launches++;
      return 'Status: ok';
    }
    if (command === `am start -W -n ${PKG}/.MainActivity`) { if (!stuckAway) s.away = 0; return 'Status: ok'; }
    if (command.startsWith('dumpsys window | grep')) return '  mCurrentFocus=Window{4f1 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity}\n  mFocusedApp=ActivityRecord{9a u0 com.android.chrome/.Main t7}';
    if (command.startsWith('uiautomator dump ') && s.away > 0) {
      s.away--; s.file = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node index="0" text="" resource-id="" package="com.android.chrome" content-desc="" clickable="false" bounds="[0,0][1080,2400]" /></hierarchy>';
      return '';
    }
    if (command.startsWith('uiautomator dump ')) { if (s.screen === 'loading' && --s.loading < 0) s.screen = 'home'; s.file = xml(screens[s.screen]()); return ''; }
    if (command.startsWith('cat ')) return s.file;
    if (command.startsWith('input tap ')) { const [x, y] = command.slice(10).split(' ').map(Number); tap(x, y); return ''; }
    if (command.startsWith('input swipe ')) { if (s.screen === 'listings') s.scrolled = true; if (s.screen === 'calendar') s.calScroll++; return ''; }
    return '';
  };
  return {s, rootCommand};
}
const adapterFor = (d, now = Date.now) => new ClickAndBoatAppAdapter({rootCommand: d.rootCommand, sleep: async () => {}, now});
const block = (from, to, toTime, type = 'Unavailable', fromTime = '00:00') => appBlock({type, fromDay: from, fromTime, toDay: to, toTime});

test('reads a listing on the second page with booked and owner rows, then restores the phone', async () => {
  const d = phone(), a = adapterFor(d);
  const observed = await a.read(target('100004'));
  assert.deepEqual(observed, {identity_verified: true, complete: true, blocks: [
    {id: 'cbapp:Booked:2026-11-07/2026-11-13 10:00:00', from: '2026-11-07', to: '2026-11-13 10:00:00', type: 'Booked', start: '2026-11-08', end: '2026-11-13'},
    block('2026-11-13', '2026-11-13', '23:59'), block('2026-12-05', '2026-12-11', '23:59')]});
  await a.close();
  assert.equal(d.s.power, 'Dozing'); assert.ok(d.s.commands.includes('am start -n com.android.chrome/com.google.android.apps.chrome.Main'));
  assert.ok(!d.s.commands.includes('input keyevent KEYCODE_BACK'));
  // Owner reasons map to the website's record types.
  assert.equal((await a.read(target('100007'))).blocks[0].type, 'Breakdown'); await a.close();
});

test('a website ledger record becomes exactly the record the app shows', () => {
  const web = {id: '73456982', from: '2026-11-13 00:00:00', to: '2026-11-13 23:59:00', type: 'Unavailable', start: '2026-11-13', end: '2026-11-14'};
  assert.deepEqual(appBlockFromWeb(web), block('2026-11-13', '2026-11-13', '23:59'));
  const booked = {id: '64495538', from: '2026-11-07 14:00:00', to: '2026-11-13 10:00:00', type: 'Booked', start: '2026-11-08', end: '2026-11-13'};
  assert.equal(appBlockFromWeb(booked).start, booked.start); assert.equal(appBlockFromWeb(booked).end, booked.end);
  const ledger = migrateWebLedger({version: 1, targets: {}, attempts: [
    {id: 'a', target: 'clickandboat:100004', state: 'confirmed', start: web.start, end: web.end, created: {...web}, before: [booked]},
    {id: 'b', target: 'samboat:200002', state: 'confirmed', created: {id: '77', from: 'x', to: 'y', type: 'z'}}]});
  assert.deepEqual(ledger.attempts[0].created, block('2026-11-13', '2026-11-13', '23:59'));
  assert.equal(ledger.attempts[0].web_created_id, '73456982'); assert.equal(ledger.attempts[0].before[0].type, 'Booked');
  assert.equal(ledger.attempts[1].created.id, '77');
  assert.deepEqual(migrateWebLedger(structuredClone(ledger)), ledger);
});

const NOW = Date.parse('2026-09-29T07:00:00Z');
function executor(d, ledger = null, plan = {}) {
  let state = ledger;
  const planTarget = {...target('100004'), key: 'k', fresh: true, segments: [{start: '2027-08-24', end: '2027-08-25', causes: ['boataround:1']}], ...plan};
  const options = {now: () => NOW, load: async () => structuredClone(state), save: async v => { state = structuredClone(v); },
    plan: async () => ({generated_at: new Date(NOW).toISOString(), targets: [structuredClone(planTarget)]}), adapters: {clickandboat: adapterFor(d, () => NOW)}};
  return {run: () => new ReverseExecutor(options).run(), state: () => state};
}

test('the executor closes a missing night through the app form and confirms it from a fresh app start', async () => {
  const d = phone(), x = executor(d);
  await x.run();
  const [attempt] = x.state().attempts, created = block('2027-08-24', '2027-08-24', '23:59');
  assert.equal(attempt.state, 'confirmed'); assert.deepEqual(attempt.created, created);
  assert.equal(attempt.response.observed.id, created.id); assert.match(attempt.response.app_add_tapped_at, /^2026-09-29T07:00/);
  assert.equal(x.state().targets['clickandboat:100004'].state, 'protected');
  assert.equal(d.s.adds, 1); assert.equal(d.s.power, 'Dozing');
  // Read, receipt read after Add, executor read back: each from a fresh app
  // start; BACK is never used.
  assert.equal(d.s.commands.filter(c => c.startsWith('am start -S')).length, 3);
  assert.ok(!d.s.commands.includes('input keyevent KEYCODE_BACK'));
});

// Observed 2026-10-04 on AD5: the app's picker refuses the day before a record
// starting at 00:00 (3 January before an Unavailable record from 4 January).
test('a gap ending where a 00:00 record starts is written up to the day before; that day is reported, not retried', async () => {
  const d = phone(), x = executor(d, null, {segments: [{start: '2026-11-28', end: '2026-12-05', causes: ['mmk:8902601308337030369']}]});
  await x.run();
  const [attempt] = x.state().attempts;
  assert.equal(attempt.state, 'confirmed'); assert.deepEqual(attempt.created, block('2026-11-28', '2026-12-03', '23:59'));
  assert.deepEqual([attempt.start, attempt.end], ['2026-11-28', '2026-12-04']);
  const t = x.state().targets['clickandboat:100004'];
  assert.equal(t.state, 'needs_review'); assert.deepEqual(t.blocked, [{start: '2026-12-04', end: '2026-12-05', error: 'cb_app_day_before_record'}]);
  assert.equal(d.s.adds, 1);
  // Only that neighbour matters: a booking row (14:00 check-in) or a record
  // further away leaves the gap whole; a one-day gap there writes nothing.
  const a = adapterFor(phone()), owner = block('2026-12-05', '2026-12-11', '23:59');
  const booked = {id: 'cbapp:Booked:2026-12-05/2026-12-11 10:00:00', from: '2026-12-05', to: '2026-12-11 10:00:00', type: 'Booked', start: '2026-12-06', end: '2026-12-11'};
  assert.deepEqual(a.writableGap({start: '2026-11-28', end: '2026-12-06'}, [booked]), {write: [{start: '2026-11-28', end: '2026-12-06'}], rest: []});
  assert.deepEqual(a.writableGap({start: '2026-11-28', end: '2026-12-04'}, [owner]), {write: [{start: '2026-11-28', end: '2026-12-04'}], rest: []});
  assert.deepEqual(a.writableGap({start: '2026-12-04', end: '2026-12-05'}, [owner]), {write: [], rest: [{start: '2026-12-04', end: '2026-12-05', error: 'cb_app_day_before_record'}]});
});

const OWNED = () => block('2026-12-05', '2026-12-11', '23:59');
const ownedLedger = () => ({version: 1, targets: {}, attempts: [{id: 'a', target: 'clickandboat:100004', start: '2026-12-05', end: '2026-12-12',
  causes: ['boataround:9'], before: [], state: 'confirmed', created: OWNED()}]});
const cancelled = {segments: [], release_proof: {ready: true, checked_at: new Date(NOW).toISOString(), orders: [{key: 'boataround:9', state: 'cancelled'}]}};

test('a cancelled order opens only the record this program wrote: one tap on its trash icon, then a fresh read', async () => {
  const d = phone(), x = executor(d, ownedLedger(), cancelled);
  await x.run();
  assert.equal(x.state().attempts[0].state, 'released'); assert.equal(x.state().targets['clickandboat:100004'].state, 'protected');
  assert.equal(d.s.deletes, 1); assert.equal(d.s.edits, 0);
  assert.deepEqual(d.s.rows['100004'].map(r => r.from), ['2026-11-07', '2026-11-13']);
});

test('a record of ours deleted by hand and re-created identically by hand is never deleted (user instruction)', async () => {
  const d = phone();
  d.s.rows['100004'] = d.s.rows['100004'].filter(r => r.from !== '2026-12-05');
  const x = executor(d, ownedLedger(), cancelled);
  await x.run();
  // Missing from a complete read: ownership is given up at once.
  assert.equal(x.state().attempts[0].state, 'record_missing'); assert.ok(x.state().attempts[0].missing_at);
  // A colleague adds exactly the same dates again; the order stays cancelled.
  d.s.rows['100004'].push({from: '2026-12-05', to: '2026-12-11', toTime: '23:59', label: 'Unavailable', editable: true});
  await x.run();
  assert.equal(d.s.deletes, 0); assert.equal(x.state().attempts[0].state, 'record_missing');
  assert.equal(x.state().targets['clickandboat:100004'].state, 'protected');
  assert.ok(d.s.rows['100004'].some(r => r.from === '2026-12-05'));
  // A later write of the same dates may own its own new record again.
  assert.equal(permitsContentIdReuse(OWNED().id, x.state().attempts), true);
});

test('a record whose last night is today is not given up when the app no longer lists it', async () => {
  const d = phone(), today = new Date(NOW + 8 * 3600000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const ending = block(today, today, '23:59');
  const ledger = {version: 1, targets: {}, attempts: [{id: 'b', target: 'clickandboat:100004', start: today, end: tomorrow, causes: ['boataround:9'], before: [], state: 'confirmed', created: ending}]};
  const x = executor(d, ledger);
  await x.run();
  assert.equal(x.state().attempts[0].state, 'confirmed');
});

test('changed delete controls, a changed list or an ambiguous row stop before any tap', async () => {
  const swapped = phone({icons: [DELETE, EDIT]}), x = executor(swapped, ownedLedger(), cancelled);
  await x.run();
  // Nothing was tapped, so the record stays ours and closed (2026-10-04: it no
  // longer sits in "releasing" forever).
  assert.equal(swapped.s.deletes + swapped.s.edits, 0); assert.equal(x.state().attempts[0].state, 'confirmed');
  assert.equal(x.state().targets['clickandboat:100004'].error, 'calendar_schema_changed');
  // While the controls stay unexpected, later runs still never tap.
  await x.run();
  assert.equal(swapped.s.deletes + swapped.s.edits, 0); assert.equal(x.state().attempts[0].state, 'confirmed');
  const a = adapterFor(phone());
  await a.read(target('100004'));
  await assert.rejects(a.remove(target('100004'), block('2026-12-06', '2026-12-11', '23:59')), /release_identity_mismatch/);
  await assert.rejects(a.remove(target('100007'), OWNED()), /release_identity_mismatch/);
  a.before = [...a.before, block('2030-01-01', '2030-01-01', '23:59')];
  await assert.rejects(a.remove(target('100004'), OWNED()), /release_calendar_changed/);
  await a.close();
});

test('an Add with no visible result stays uncertain and is never pressed again', async () => {
  const d = phone({add: 'nothing'}), x = executor(d);
  await x.run();
  assert.equal(x.state().attempts[0].state, 'submitting'); assert.ok(x.state().attempts[0].response.app_add_tapped_at);
  assert.equal(x.state().targets['clickandboat:100004'].error, 'platform_submission_not_observed');
  await x.run();
  assert.equal(d.s.adds, 1); assert.equal(x.state().targets['clickandboat:100004'].blocked[0].error, 'previous_write_uncertain');
});

test('a different record appearing after Add is refused as a receipt', async () => {
  const d = phone({add: 'wrong'}), x = executor(d);
  await x.run();
  assert.equal(x.state().targets['clickandboat:100004'].error, 'created_record_mismatch'); assert.equal(x.state().attempts[0].created, undefined);
});

test('a migrated website record keeps its ownership against the app read', async () => {
  const web = {id: '73456982', from: '2026-11-13 00:00:00', to: '2026-11-13 23:59:00', type: 'Unavailable', start: '2026-11-13', end: '2026-11-14'};
  const ledger = migrateWebLedger({version: 1, targets: {}, attempts: [{id: 'a', target: 'clickandboat:100004', state: 'submitting', start: web.start, end: web.end,
    causes: ['boataround:9'], before: [], created: web}]});
  const d = phone(), x = executor(d, ledger);
  await x.run();
  // The recorded receipt is found in the fresh read, so it is confirmed rather than rewritten.
  assert.equal(x.state().attempts[0].state, 'confirmed');
});

test('an app record ID may be written again only after its earlier record was deleted', () => {
  const id = block('2027-08-24', '2027-08-24', '23:59').id;
  assert.equal(permitsContentIdReuse(id, [{state: 'released'}]), true);
  assert.equal(permitsContentIdReuse(id, [{state: 'released'}, {state: 'confirmed'}]), false);
  assert.equal(permitsContentIdReuse('73456982', [{state: 'released'}]), false);
});

test('duplicates, unknown owner reasons and a list ending early are refused', () => {
  const list = rows => appNodes(xml([n('Your future periods of unavailability'), ...rows.flat(), n('ABOUT US')]));
  const row = (from, to, label = 'Unavailable') => [n('From ' + words(from)), n(`To ${words(to)}, 23:59`), n(label), n('', {desc: '', click: true}), n(''), n('', {desc: '', click: true}), n('')];
  assert.equal(appCalendarRows(list([row('2027-01-01', '2027-01-02')])).length, 1);
  assert.throws(() => appCalendarRows(list([row('2027-01-01', '2027-01-02'), row('2027-01-01', '2027-01-02')])), /calendar_duplicate_records/);
  assert.throws(() => appCalendarRows(list([row('2027-01-01', '2027-01-02', 'Charter')])), /calendar_schema_changed/);
  assert.throws(() => appCalendarRows(list([row('2027-01-01', '2027-01-02'), [n('Something new')], row('2027-02-01', '2027-02-02')])), /calendar_schema_changed/);
  assert.throws(() => appCalendarRows(appNodes(xml([n('Select the dates when your boat is unavailable.')]))), /calendar_schema_changed/);
});

test('a listing missing from every page, a locked phone or a verification page stop without writing', async () => {
  const missing = phone(), a = adapterFor(missing);
  await assert.rejects(a.read({target: 'clickandboat', boat: 'seacat-open-40-tidewyn-discovery-2', listing_id: '999999'}), /mapping_unknown/);
  // A mapped listing the account no longer shows is never guessed.
  const hidden = phone(), h = adapterFor(hidden);
  PAGES[1].pop();
  try { await assert.rejects(h.read({target: 'clickandboat', boat: 'reef-cat-37-tidewyn-discovery', listing_id: '100002'}), /target_identity_unverified/); }
  finally { PAGES[1].push('100002'); await h.close(); }
  const locked = phone({secure: true}), b2 = adapterFor(locked);
  await assert.rejects(b2.read(target('100004')), /device_locked/); await b2.close();
  assert.ok(!locked.s.commands.some(c => c.includes(PKG + '/'))); assert.equal(locked.s.power, 'Dozing');
  const checked = phone({challenge: true}), c2 = adapterFor(checked);
  await assert.rejects(c2.read(target('100004')), /platform_challenge/); await c2.close();
});

// Reproduced on the phone 2026-10-04: from the dozing lock screen the app was
// started, then ColorOS showed its lock screen again and dozed; the next read
// saw only system UI and stopped with app_not_in_foreground (about half the runs).
function relapsing(options) {
  const d = phone(options), base = d.rootCommand, systemUi = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' +
    '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" clickable="false" bounds="[0,0][1080,2400]" /></hierarchy>';
  d.relapses = 0;
  d.rootCommand = async command => {
    if (command === 'input keyevent 82') { d.s.commands.push(command); if (!options?.secure) d.s.lock = false; return ''; }
    if (command.startsWith('uiautomator dump ') && (d.s.power !== 'Awake' || d.s.lock)) { d.s.commands.push(command); d.s.file = systemUi; return ''; }
    const out = await base(command);
    if (command.startsWith('am start -S -W') && d.relapses < 1) { d.relapses++; d.s.power = 'Dozing'; d.s.lock = true; }
    return out;
  };
  return d;
}

test('a phone that falls back to its lock screen after the app starts is woken again before the next read', async () => {
  const d = relapsing(), a = adapterFor(d);
  const observed = await a.read(target('100004'));
  assert.equal(d.relapses, 1); assert.equal(observed.blocks.length, 3);
  // Woken and unlocked twice: once at the start, once after the relapse; never read behind the lock screen.
  assert.equal(d.s.commands.filter(c => c === 'input keyevent 224').length, 2);
  // MENU is pressed only while the lock screen is still up after dismissal.
  assert.ok(d.s.commands.includes('wm dismiss-keyguard')); assert.ok(!d.s.commands.includes('input keyevent 82'));
  await a.close(); assert.equal(d.s.power, 'Dozing');
  // A lock screen with a password is never unlocked, before or after a relapse.
  const locked = relapsing({secure: true}), b = adapterFor(locked);
  await assert.rejects(b.read(target('100004')), /device_locked/); await b.close();
  assert.ok(!locked.s.commands.includes('input keyevent 82')); assert.ok(!locked.s.commands.includes('wm dismiss-keyguard'));
});

test('an unreadable list is read once more from a fresh app; only node kinds are noted (2026-10-10, AD2)', async () => {
  const notes = [], d = phone({oddLaunches: 1});
  const a = new ClickAndBoatAppAdapter({rootCommand: d.rootCommand, sleep: async () => {}, onListFailure: note => notes.push(note)});
  assert.equal((await a.read(target('100004'))).blocks.length, 3);
  assert.equal(d.s.launches, 2); assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].error, notes[0].listing], ['calendar_schema_changed', '100004']);
  assert.deepEqual(notes[0].after_title.slice(0, 5), ['text13', 'month', 'from', 'to', 'type']);
  // No words or dates of the list are kept.
  assert.doesNotMatch(JSON.stringify(notes), /Something|November|2026|Unavailable/);
  await a.close();
  // Still unreadable after the fresh start: reported, the form never touched.
  const twice = phone({oddLaunches: 2}), x = executor(twice);
  await x.run();
  assert.equal(x.state().targets['clickandboat:100004'].error, 'calendar_schema_changed');
  assert.equal(twice.s.launches, 2); assert.equal(twice.s.adds + twice.s.deletes + twice.s.edits, 0);
  assert.ok(!twice.s.commands.some(c => c === 'input tap 540 1363'));
  // A note that cannot be written changes nothing.
  const broken = new ClickAndBoatAppAdapter({rootCommand: phone({oddLaunches: 1}).rootCommand, sleep: async () => {}, onListFailure: async () => { throw Error('disk full'); }});
  assert.equal((await broken.read(target('100004'))).blocks.length, 3); await broken.close();
});

test('the receipt read after Add is tried once more from a fresh app, so the new record stays ours (2026-10-10)', async () => {
  // Launch 0 reads the calendar; launch 1 is the receipt read after Add.
  const d = phone({oddAt: [1]}), x = executor(d);
  await x.run();
  const [attempt] = x.state().attempts;
  assert.equal(d.s.adds, 1);
  assert.deepEqual([attempt.state, attempt.created?.id], ['confirmed', block('2027-08-24', '2027-08-24', '23:59').id]);
  assert.equal(x.state().targets['clickandboat:100004'].state, 'protected');
});

test('an end day the app greys out: the leading part is closed and the rest reported (2026-10-10, AD1)', async () => {
  const d = phone({greyEnd: ['2027-08-27', '2027-08-26']}), x = executor(d, null, {segments: [{start: '2027-08-24', end: '2027-08-28', causes: ['nausys:1']}]});
  await x.run();
  const [attempt] = x.state().attempts;
  assert.deepEqual([attempt.state, attempt.start, attempt.end], ['confirmed', '2027-08-24', '2027-08-26']);
  assert.deepEqual(attempt.created, block('2027-08-24', '2027-08-25', '23:59'));
  const result = x.state().targets['clickandboat:100004'];
  assert.equal(result.state, 'needs_review');
  assert.deepEqual(result.blocked, [{start: '2027-08-26', end: '2027-08-28', error: 'cb_app_end_not_selectable'}]);
  assert.equal(d.s.adds, 1);
  // When not even the first day can end a period, nothing is written.
  const none = phone({greyEnd: ['2027-08-24']}), y = executor(none);
  await y.run();
  assert.equal(none.s.adds, 0);
  assert.deepEqual(y.state().targets['clickandboat:100004'].blocked, [{start: '2027-08-24', end: '2027-08-25', error: 'cb_app_end_not_selectable'}]);
  // A first day the picker refuses as a start (AD1 2026-12-18): nothing is written either.
  const first = phone({greyFrom: ['2027-08-24']}), z = executor(first);
  await z.run();
  assert.equal(first.s.adds, 0);
  assert.deepEqual(z.state().targets['clickandboat:100004'].blocked, [{start: '2027-08-24', end: '2027-08-25', error: 'cb_app_date_not_selectable'}]);
});
// Found 2026-10-13: the app left one row out of a read that looked complete
// (AD1 "2-07 to 2-11" was still on the website), and the program gave the record up.
test('a record of ours missing from one read is read again from a fresh app before it is given up (2026-10-13, AD1)', async () => {
  const needed = {segments: [{start: '2026-12-05', end: '2026-12-12', causes: ['boataround:9']}]};
  const d = phone({missAt: [0], missFrom: '2026-12-05'}), x = executor(d, ownedLedger(), needed);
  await x.run();
  assert.equal(x.state().attempts[0].state, 'confirmed');
  assert.equal(x.state().targets['clickandboat:100004'].state, 'protected');
  assert.equal(d.s.launches, 2); assert.equal(d.s.adds + d.s.deletes + d.s.edits, 0);
  // Missing from both reads: given up as before (user instruction 2026-09-29).
  const gone = phone({missAt: [0, 1], missFrom: '2026-12-05'}), y = executor(gone, ownedLedger(), {segments: []});
  await y.run();
  assert.equal(y.state().attempts[0].state, 'record_missing'); assert.equal(gone.s.deletes, 0);
  // Nothing missing: one read only.
  const plain = phone(), z = executor(plain, ownedLedger(), needed);
  await z.run(); assert.equal(plain.s.launches, 1);
});

// Several reads on 2026-10-12/13 ended in app_not_in_foreground.
test('the app briefly not in front is waited for; a read that still fails is tried once from a fresh app (2026-10-13)', async () => {
  const brief = phone({away: [2]}), a = adapterFor(brief);
  assert.equal((await a.read(target('100004'))).blocks.length, 3); assert.equal(brief.s.launches, 1); await a.close();
  // Still away after a few reads: brought to the front once more.
  const slow = phone({away: [4]}), b = adapterFor(slow);
  assert.equal((await b.read(target('100004'))).blocks.length, 3); assert.equal(slow.s.launches, 1);
  assert.ok(slow.s.commands.includes(`am start -W -n ${PKG}/.MainActivity`)); await b.close();
  // Stuck behind another app: the read starts the app afresh once; only package names are noted.
  const notes = [], stuck = phone({away: [9], stuckAway: true});
  const c = new ClickAndBoatAppAdapter({rootCommand: stuck.rootCommand, sleep: async () => {}, onListFailure: note => notes.push(note)});
  assert.equal((await c.read(target('100004'))).blocks.length, 3); assert.equal(stuck.s.launches, 2);
  assert.deepEqual(notes, [{error: 'app_not_in_foreground', listing: '100004', foreground: ['com.android.chrome']}]); await c.close();
  const never = phone({away: [9, 9], stuckAway: true}), e = adapterFor(never);
  await assert.rejects(e.read(target('100004')), /app_not_in_foreground/); assert.equal(never.s.launches, 2); await e.close();
  // The receipt read after Add finds the app away: read once more from a fresh
  // app, so the new record is still recognised as ours and Add is not pressed again.
  const writing = phone({away: [0, 9], stuckAway: true}), w = executor(writing);
  await w.run();
  assert.equal(writing.s.adds, 1); assert.equal(w.state().attempts[0].state, 'confirmed');
  assert.equal(w.state().targets['clickandboat:100004'].state, 'protected');
});