// Click&Boat calendar kept through the owner's official Android app
// (com.clickandboat.androidphone), 2026-09-29.
//
// Why: Click&Boat's website answers the phone's automated browser with a
// Cloudflare check that a person cannot pass either. The app shows the very
// same owner calendar page (listing edit, tab 7) without it. The user decided
// to move all Click&Boat work, reading and calendar writes, to the app.
//
// The page is read through Android's screen hierarchy (uiautomator) and used
// with ordinary taps, like a person: the app is never modified, its traffic is
// never intercepted and its storage or tokens are never read. A verification
// or login page stops the work.
//
// Differences from the website adapter (clickandboat-adapter.mjs):
// - Record IDs are not visible in the app. A record's ID here is its exact
//   content (type, from, to). Identical records are refused as ambiguous.
// - The list never shows a start time. Rows the owner may edit are whole-day
//   owner blocks (the form takes dates only) and start at 00:00. Rows without
//   edit/delete are platform bookings (14:00 check-in on the website) and, as
//   with the website data, protect from the next day.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FLEET, isoDate} from '../parsers.mjs';
import {appNodes, appScreen, CLICKANDBOAT_APP, ensureScreenAwake} from '../collectors/clickandboat-app.mjs';
import {beforeRequest} from './not-submitted.mjs';

const exec = promisify(execFile);
const APP_ACTIVITY = CLICKANDBOAT_APP + '/.MainActivity';
const CHROME_MAIN = 'com.android.chrome/com.google.android.apps.chrome.Main';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Reason labels of the owner form and the website's record types.
const TYPES = {'Unavailable': 'Unavailable', 'Breakdown / Damage': 'Breakdown', 'Wintering / End of season': 'Wintering'};
const PAGE_TEXT = 'Select the dates when your boat is unavailable.';
const LIST_TITLE = 'Your future periods of unavailability';
const CALENDAR_BUTTON = /^Boat calendar(?: to update)?: #(\d+)$/;
const ICON = /^[-]$/;
// Icon-font glyphs of a record's edit and delete controls (observed 2026-09-29).
const EDIT_ICON = '', DELETE_ICON = '';
const SCREEN_BOTTOM = 2330;
// Errors after which a read alone is tried once more from a fresh app. The app
// was not in front in several reads on 2026-10-12/13; a read changes nothing.
const LIST_RETRY = /^(calendar_(schema_changed|read_unstable)|app_not_in_foreground)$/;

const fail = message => { throw Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shift = (day, days) => new Date(Date.parse(isoDate(day) + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const display = day => day.split('-').reverse().join('/');
function listDay(text) {
  const match = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text), month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  if (month < 0) fail('calendar_schema_changed');
  try { return isoDate(`${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`); }
  catch { fail('calendar_schema_changed'); }
}

/** One record in the shape the executor compares (key order matters). */
export function appBlock({type, fromDay, fromTime, toDay, toTime}) {
  const from = fromTime ? `${fromDay} ${fromTime}:00` : fromDay, to = `${toDay} ${toTime}:00`;
  return {id: `cbapp:${type}:${from}/${to}`, from, to, type,
    start: fromTime === '00:00' ? fromDay : shift(fromDay, 1), end: toTime >= '23:59' ? shift(toDay, 1) : toDay};
}
/** A record read by the website adapter, as the app would show it. */
export function appBlockFromWeb(row) {
  const editable = row.type !== 'Booked';
  return appBlock({type: row.type, fromDay: row.from.slice(0, 10), fromTime: editable ? '00:00' : null,
    toDay: row.to.slice(0, 10), toTime: row.to.slice(11, 16)});
}

/** Ledger records the website adapter wrote, keyed as the app shows them.
 * The platform ID stays on the attempt for history; ownership continues only
 * where a fresh app read shows exactly the same content. */
export function migrateWebLedger(ledger) {
  const web = row => row && /^\d+$/.test(row.id) ? appBlockFromWeb(row) : row;
  for (const a of ledger.attempts) {
    if (!String(a.target).startsWith('clickandboat:')) continue;
    if (a.created && /^\d+$/.test(a.created.id)) { a.web_created_id = a.created.id; a.created = web(a.created); }
    for (const field of ['before', 'release_before']) if (Array.isArray(a[field])) a[field] = a[field].map(web);
  }
  return ledger;
}

/** Records of the calendar list, each with its row's edit/delete controls. */
export function appCalendarRows(nodes) {
  const at = nodes.findIndex(n => n.text === LIST_TITLE);
  if (at < 0) fail('calendar_schema_changed');
  const rows = [];
  let row = null, end = nodes.length;
  const finish = () => {
    if (!row) return;
    if (!row.toDay || !row.label || ![0, 2].includes(row.icons.length)) fail('calendar_schema_changed');
    rows.push(row); row = null;
  };
  for (let i = at + 1; i < nodes.length; i++) {
    const n = nodes[i], text = n.text;
    let match;
    if ((match = /^From (\d{1,2} [A-Za-z]+ \d{4})(?:, (\d{2}:\d{2}))?$/.exec(text))) {
      finish(); row = {fromDay: listDay(match[1]), fromTime: match[2] || null, toDay: null, toTime: null, label: null, icons: []};
    } else if (row && !row.toDay && (match = /^To (\d{1,2} [A-Za-z]+ \d{4}), (\d{2}:\d{2})$/.exec(text))) {
      row.toDay = listDay(match[1]); row.toTime = match[2];
    } else if (row?.toDay && !row.label && text) row.label = text;
    else if (row?.label && n.clickable) row.icons.push(n);
    else if (row?.label && ICON.test(text)) continue;
    else if (/^[A-Z][a-z]+ \d{4}$/.test(text)) finish();
    else if (text || n.desc) { finish(); end = i; break; }
  }
  finish();
  // Whatever ends the list must not hide a further record.
  if (nodes.slice(end).some(n => /^From \d/.test(n.text))) fail('calendar_schema_changed');
  const result = rows.map(r => {
    const editable = r.icons.length === 2, type = editable ? TYPES[r.label] : 'Booked';
    if (!type) fail('calendar_schema_changed');
    return {block: appBlock({type, fromDay: r.fromDay, fromTime: r.fromTime ?? (editable ? '00:00' : null), toDay: r.toDay, toTime: r.toTime}),
      editable, icons: r.icons};
  }).filter(r => r.block.start < r.block.end);
  if (new Set(result.map(r => r.block.id)).size !== result.length) fail('calendar_duplicate_records');
  return result;
}

/** A list that could not be read, as node kinds only: no words or dates are
 * kept (a booked row's label may be a guest's name). */
export function listShape(nodes) {
  const at = nodes.findIndex(n => n.text === LIST_TITLE);
  const kind = n => /^From \d.*, \d{2}:\d{2}$/.test(n.text) ? 'from-time' : /^From \d/.test(n.text) ? 'from' : /^To \d/.test(n.text) ? 'to'
    : TYPES[n.text] ? 'type' : /^[A-Z][a-z]+ \d{4}$/.test(n.text) ? 'month' : ICON.test(n.text) ? 'icon'
    : n.text ? 'text' + n.text.length : n.desc ? (n.clickable ? 'button' : 'desc') + n.desc.length : n.clickable ? 'click' : 'empty';
  return {title_at: at, node_count: nodes.length, after_title: at < 0 ? [] : nodes.slice(at + 1, at + 151).map(kind)};
}

export class ClickAndBoatAppAdapter {
  // The app's own edit form showed a record ending 17 Dec 23:59 as "to
  // 16/12/2026" (2026-10-10), so records are never edited. Up to a week of
  // still-needed days of a record of ours may be replaced: deleted and closed
  // again at once, one Add of 3-4 minutes. One day until 2026-10-13 (AD5 needed
  // two and was fixed by hand); the user asked for fewer manual fixes.
  replaceDays = 7;
  constructor({rootCommand, sleep = pause, now = Date.now, isCancelled = () => false, recoverLogin = null, onListFailure = null} = {}) {
    this.root = rootCommand || (async command => (await exec('su', ['-c', command], {timeout: 20000, maxBuffer: 8 * 1024 * 1024})).stdout);
    Object.assign(this, {sleep, now, isCancelled, recoverLogin, onListFailure});
    this.file = '/data/local/tmp/fleet-cb-calendar-' + process.pid + '.xml';
  }
  check() { if (this.isCancelled()) fail('executor_cancelled'); }
  async dump() {
    // The phone can fall back to its dozing lock screen between or during
    // targets (reproduced 2026-10-04); make the app visible before each read.
    // Every following step still checks what the screen shows before a tap.
    if (this.session) { this.check(); await ensureScreenAwake(this.root, this.sleep); }
    for (let attempt = 0; ; attempt++) {
      this.check();
      try { await this.root('rm -f ' + this.file); await this.root('uiautomator dump ' + this.file); return appNodes(await this.root('cat ' + this.file)); }
      catch (error) { if (attempt === 2) fail('calendar_read_failed'); await this.sleep(700); }
    }
  }
  guard(nodes) {
    const screen = appScreen(nodes);
    if (screen.challenge) fail('platform_challenge');
    if (screen.login) fail('auth_required');
    if (!nodes.some(n => n.pkg === CLICKANDBOAT_APP)) fail('app_not_in_foreground');
    return nodes;
  }
  async tap(node, wait = 2500) {
    this.check();
    const [x1, y1, x2, y2] = node.box;
    await this.root(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`); await this.sleep(wait);
  }
  async swipe() { this.check(); await this.root('input swipe 540 1800 540 900 400'); await this.sleep(1200); }
  async wake() {
    if (this.session) return;
    this.check();
    const power = await this.root('dumpsys power');
    if (!/mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power)) fail('device_state_unknown');
    // Recorded before waking so close() restores the screen whatever follows.
    this.session = {wasAsleep: /mWakefulness=(?:Asleep|Dozing)/.test(power),
      chromeWasTop: /topResumedActivity=[^\n]*com\.android\.chrome\//.test(await this.root('dumpsys activity activities'))};
    // A credential-protected lock screen is never unlocked by this program.
    await ensureScreenAwake(this.root, this.sleep, {settle: 800});
  }
  /** Fresh app start → account menu → Calendar → this listing's calendar. */
  async openCalendar(listingId) {
    // A restored app page was seen exposing incomplete rows (2026-09-29), so
    // every calendar read starts from a fresh app.
    await this.root('am start -S -W -n ' + APP_ACTIVITY); await this.sleep(2000);
    let taps = 0, opened = false, page = 1, leftPage = null, pageWaits = 0, away = 0;
    for (let step = 0; step < 45; step++) {
      let nodes;
      try { nodes = this.guard(await this.dump()); }
      catch (error) {
        // A slow start, or the lock screen coming back, can hide the app for a
        // moment: wait, bring it to the front once more, then give up and note
        // which app was in front (package name only) for diagnosis.
        if (error?.message !== 'app_not_in_foreground') throw error;
        if (++away > 4) { await this.noteForeground(listingId); throw error; }
        if (away === 3) await this.root('am start -W -n ' + APP_ACTIVITY);
        await this.sleep(1500); continue;
      }
      const visible = nodes.filter(n => n.visible);
      if (opened && nodes.some(n => n.text === PAGE_TEXT) && nodes.some(n => n.rid === 'btn-add-unavaila')) { this.opened = listingId; return nodes; }
      const buttons = nodes.filter(n => CALENDAR_BUTTON.test(n.desc));
      const ids = buttons.map(n => CALENDAR_BUTTON.exec(n.desc)[1]).join(',');
      // After a page link: a page past the last boat shows no boat at all.
      if (!opened && leftPage !== null && (buttons.length === 0 || ids === leftPage)) {
        if (++pageWaits > 6) fail('target_identity_unverified');
        await this.sleep(1000); continue;
      }
      if (opened || buttons.length === 0) {
        const control = !opened && (visible.find(n => n.clickable && /^Calendar(?: \d+)?$/.test(n.desc)) || visible.find(n => n.clickable && n.desc === 'account menu'));
        if (control && taps < 8) { taps++; await this.tap(control); } else await this.sleep(1500);
        continue;
      }
      pageWaits = 0;
      // The listings page shows each boat's number with its calendar button.
      const mine = buttons.filter(n => n.desc.endsWith(': #' + listingId));
      if (mine.length > 1) fail('target_identity_unverified');
      if (mine.length === 1) {
        if (!nodes.some(n => n.text.startsWith('#' + listingId + ' · '))) fail('target_identity_unverified');
        if (mine[0].visible && mine[0].box[1] >= 300 && mine[0].box[3] <= 2200) { await this.tap(mine[0], 3000); opened = true; }
        else await this.swipe();
        continue;
      }
      // Not on this page: follow the link to the next one.
      const link = nodes.find(n => n.clickable && n.desc === `listings?page=${page + 1}`);
      if (!link || page >= 5) fail('target_identity_unverified');
      if (link.visible && link.box[3] <= 2200) { await this.tap(link, 3000); page++; leftPage = ids; pageWaits = 0; } else await this.swipe();
    }
    fail('calendar_navigation_failed');
  }
  /** Which app was in front when Click&Boat was not: package names only. */
  async noteForeground(listingId) {
    if (!this.onListFailure) return;
    try {
      const focus = await this.root('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
      const packages = [...new Set([...String(focus).matchAll(/\b([a-z][\w]*(?:\.[\w]+)+)\//g)].map(m => m[1]))].slice(0, 4);
      await this.onListFailure({error: 'app_not_in_foreground', listing: listingId ?? null, foreground: packages});
    } catch {}
  }
  /** Closes an open date picker by tapping the form's "Reason" label. */
  async closePicker() {
    for (let i = 0; i < 3; i++) {
      const nodes = this.guard(await this.dump());
      if (!nodes.some(n => n.visible && /^[a-z]+ \d{4}$/.test(n.text))) return nodes;
      const label = nodes.filter(n => n.visible && n.text === 'Reason');
      if (label.length !== 1) fail('calendar_form_changed');
      await this.tap(label[0], 800);
    }
    fail('datepicker_not_closed');
  }
  /** The complete list, accepted only when two consecutive reads agree. */
  async readList() {
    let previous = null, lastError = 'calendar_read_unstable', unread = null;
    for (let i = 0; i < 8; i++) {
      const nodes = this.guard(await this.dump());
      let rows = null;
      try { rows = appCalendarRows(nodes); } catch (error) { if (!/^calendar_/.test(error.message)) throw error; lastError = error.message; unread = nodes; }
      if (rows) { const key = JSON.stringify(rows.map(r => r.block)); if (key === previous) return {rows, nodes}; previous = key; }
      else previous = null;
      await this.sleep(1500);
    }
    // Kept for diagnosis; a failing note never changes the result.
    if (unread && this.onListFailure) try { await this.onListFailure({error: lastError, listing: this.opened ?? null, ...listShape(unread)}); } catch {}
    fail(lastError);
  }
  /** The app's date picker refuses the day before a record that starts at
   * 00:00, as "from" and as "to" (2026-10-04, AD5: 3 January before an
   * Unavailable record from 4 January; 27 December to 2 January was accepted).
   * The website allowed such neighbours. A gap ending there is written up to
   * the day before, and that one day is reported for review, not retried. */
  writableGap(gap, blocks) {
    const next = blocks.some(b => b.start === gap.end && typeof b.from === 'string' && b.from.endsWith(' 00:00:00'));
    if (!next) return {write: [gap], rest: []};
    const last = shift(gap.end, -1);
    return {write: last > gap.start ? [{start: gap.start, end: last}] : [], rest: [{start: last, end: gap.end, error: 'cb_app_day_before_record'}]};
  }
  async read(target) {
    if (!FLEET.some(b => b.slug === target.boat && b.clickandboat_id === target.listing_id)) fail('mapping_unknown');
    await this.wake();
    let rows;
    for (let attempt = 0; !rows; attempt++) {
      try { await this.openListing(target.listing_id); ({rows} = await this.readList()); }
      catch (error) {
        // A list in an unexpected shape is read once more from a fresh app:
        // AD2's failed so in 2 of 3 runs on 2026-10-10 and read normally four
        // times in a row right after. Only the read is repeated.
        if (attempt || !LIST_RETRY.test(error?.message)) throw error;
      }
    }
    Object.assign(this, {listing: target.listing_id, rows, before: rows.map(r => r.block), formDirty: false, prepared: null});
    return {identity_verified: true, complete: true, blocks: this.before};
  }
  async openListing(listingId) {
    try { await this.openCalendar(listingId); }
    catch (error) {
      // A signed-out app: one saved-password recovery per run (2026-10-04),
      // then the calendar is opened again from a fresh app.
      if (error?.message !== 'auth_required' || !this.recoverLogin) throw error;
      const recover = this.recoverLogin; this.recoverLogin = null;
      try { await recover({root: this.root, sleep: this.sleep, check: () => this.check()}); }
      catch (failure) { if (failure?.message === 'executor_cancelled') throw failure; fail(failure?.code === 'challenge_required' ? 'platform_challenge' : 'auth_required'); }
      await this.openCalendar(listingId);
    }
  }
  async selectDate(rid, day) {
    const [year, month, date] = day.split('-').map(Number), goal = year * 12 + month - 1;
    const field = this.guard(await this.dump()).filter(n => n.rid === rid && n.visible);
    if (field.length !== 1) fail('calendar_form_changed');
    await this.tap(field[0], 1200);
    for (let step = 0; step < 30; step++) {
      const nodes = this.guard(await this.dump());
      // The picker title is lower case ("september 2026"); list headings are not.
      const title = nodes.filter(n => n.visible && /^[a-z]+ \d{4}$/.test(n.text) && MONTHS.includes(n.text.split(' ')[0]));
      if (title.length !== 1) { if (step >= 3) fail('datepicker_unavailable'); await this.sleep(800); continue; }
      const [name, y] = title[0].text.split(' '), current = Number(y) * 12 + MONTHS.indexOf(name);
      if (current === goal) {
        const days = nodes.filter(n => n.visible && n.clickable && n.desc === String(date));
        if (days.length !== 1) fail('date_disabled_or_ambiguous');
        await this.tap(days[0], 1200);
        const value = this.guard(await this.dump()).filter(n => n.rid === rid);
        if (value.length !== 1 || value[0].text !== display(day)) fail('form_date_mismatch');
        return;
      }
      const arrow = nodes.find(n => n.visible && n.clickable && n.desc === (current < goal ? 'Next' : 'Previous'));
      if (!arrow) fail('calendar_navigation_limit');
      await this.tap(arrow, 700);
    }
    fail('calendar_navigation_limit');
  }
  async selectReason() {
    const select = (await this.closePicker()).filter(n => n.rid === 'availa-type' && n.visible);
    if (select.length !== 1) fail('calendar_form_changed');
    const [x1, y1, , y2] = select[0].box;
    if (y2 + 150 > SCREEN_BOTTOM) fail('calendar_form_changed');
    await this.tap(select[0], 900);
    // The open list is drawn under the field, but Android exposes only the
    // field's combined text, in display order. Its first entry must be
    // "Unavailable" (observed 2026-09-29); the choice is verified afterwards.
    const open = this.guard(await this.dump()).filter(n => n.rid === 'availa-type');
    // (The text starts with the field's arrow icon.)
    if (open.length !== 1 || !/^[^A-Za-z]*Select… Unavailable Breakdown\b/.test(open[0].text)) fail('calendar_form_changed');
    this.check(); await this.root(`input tap ${x1 + 150} ${y2 + 70}`); await this.sleep(900);
    const shown = this.guard(await this.dump()).filter(n => n.visible && n.text === 'Unavailable' && n.box[1] >= y1 && n.box[3] <= y2);
    if (shown.length !== 1) fail('form_reason_mismatch');
  }
  /** Current form, checked field by field; returns the page read. */
  async verifyForm(gap) {
    const nodes = await this.closePicker();
    const value = rid => nodes.filter(n => n.rid === rid).map(n => n.text);
    const select = nodes.filter(n => n.rid === 'availa-type');
    if (!same(value('date-from'), [display(gap.start)]) || !same(value('date-to'), [display(shift(gap.end, -1))]) || select.length !== 1 ||
      nodes.filter(n => n.visible && n.text === 'Unavailable' && n.box[1] >= select[0].box[1] && n.box[3] <= select[0].box[3]).length !== 1)
      fail('form_value_mismatch');
    return nodes;
  }
  async prepare(target, gap) {
    if (this.listing !== target.listing_id) fail('wrong_listing');
    const expected = JSON.stringify(this.before);
    // A failed earlier preparation may have left values in the form.
    if (this.formDirty) await this.openCalendar(target.listing_id);
    this.formDirty = true; this.prepared = null;
    const {rows} = await this.readList();
    if (JSON.stringify(rows.map(r => r.block)) !== expected) fail('target_changed_during_preparation');
    // The picker may refuse a first day too (AD1 2026-12-18 after the
    // 12-11..12-17 record, 2026-10-10); nothing is written then.
    try { await this.selectDate('date-from', gap.start); }
    catch (error) { if (error?.message === 'form_date_mismatch') fail('cb_app_date_not_selectable'); throw error; }
    // The app greys out some last days without saying so to the screen reader
    // (2026-10-10, AD1: from 11 Dec a period could end on 12-17 but not 12-18
    // to 12-30); a tap on one does nothing. Step back to the last day it
    // accepts, prepare that part and report the rest instead of closing nothing.
    // Each step takes 15-20 s. The greyed days are the minimum-stay buffer
    // before the next record (at most 6 days for a one-week minimum), so more
    // than 8 steps means something else is wrong: nothing is written then.
    let last = shift(gap.end, -1), reason, steps = 0;
    for (;;) {
      try { await this.selectDate('date-to', last); break; }
      catch (error) {
        if (error?.message !== 'form_date_mismatch') throw error;
        // Not even the first day (AD1 12-18 on its own, 2026-10-10): nothing is written.
        if (last <= gap.start || ++steps > 8) fail('cb_app_end_not_selectable');
        // The refused tap leaves the picker open; start the next try closed.
        await this.closePicker();
        last = shift(last, -1); reason = 'cb_app_end_not_selectable';
      }
    }
    const end = shift(last, 1);
    await this.selectReason();
    await this.verifyForm({...gap, end});
    this.prepared = {listing: target.listing_id, start: gap.start, end};
    return end < gap.end ? {end, reason} : undefined;
  }
  /** The list from a fresh app start; read once more when it cannot be parsed
   * (as read()). Used for the receipt after Add: an unreadable list there used
   * to leave the new record unowned for good. */
  async freshList(listingId) {
    for (let attempt = 0; ; attempt++) {
      try { await this.openCalendar(listingId); return (await this.readList()).rows; }
      catch (error) { if (attempt || !LIST_RETRY.test(error?.message)) throw error; }
    }
  }
  async submit(target, gap, saveEvidence = async () => {}, {guard} = {}) {
    const prepared = this.prepared;
    if (!prepared || prepared.listing !== target.listing_id || prepared.start !== gap.start || prepared.end !== gap.end) fail('wrong_listing');
    const expected = appBlock({type: 'Unavailable', fromDay: gap.start, fromTime: '00:00', toDay: shift(gap.end, -1), toTime: '23:59'});
    await guard?.({beforeFirstWrite: true});
    this.prepared = null;
    // Everything up to the Add tap only reads and checks the form.
    const add = await beforeRequest(async () => {
      const found = (await this.verifyForm(gap)).filter(n => n.rid === 'btn-add-unavaila' && n.visible);
      if (found.length !== 1) fail('calendar_form_changed');
      return found[0];
    });
    await this.tap(add, 3000);
    const tappedAt = new Date(this.now()).toISOString(), before = this.before;
    await saveEvidence({app_add_tapped_at: tappedAt, listing_id: target.listing_id, start: gap.start, end: gap.end});
    // The page's own update after Add is not a reliable receipt (in the live
    // test on 2026-09-29 the saved record did not show up in the open page).
    // The receipt is a fresh read: exactly this one new record, all others kept.
    const blocks = (await this.freshList(target.listing_id)).map(r => r.block);
    const added = blocks.filter(b => !before.some(a => same(a, b)));
    if (!added.length && before.every(a => blocks.some(b => same(a, b)))) fail('platform_submission_not_observed');
    if (added.length !== 1 || !same(added[0], expected) || !before.every(a => blocks.some(b => same(a, b)))) fail('created_record_mismatch');
    await saveEvidence({app_add_tapped_at: tappedAt, listing_id: target.listing_id, start: gap.start, end: gap.end, observed: added[0]});
    return added[0];
  }
  /** Deletes one record this program wrote. The app deletes at the first tap
   * on the row's trash icon, without a confirmation (observed 2026-09-29), so
   * the row is identified by its full content and its two icons first. */
  async remove(target, owned, {guard} = {}) {
    await beforeRequest(async () => {
      if (this.listing !== target.listing_id || owned?.type !== 'Unavailable' || !String(owned.id).startsWith('cbapp:')) fail('release_identity_mismatch');
    });
    await guard?.();
    const expected = JSON.stringify(this.before);
    // Finding and checking the row only reads and scrolls; the trash tap is the
    // single mutation.
    const trash = await beforeRequest(async () => {
      for (let i = 0; i < 25; i++) {
        const rows = appCalendarRows(this.guard(await this.dump()));
        if (JSON.stringify(rows.map(r => r.block)) !== expected) fail('release_calendar_changed');
        const row = rows.filter(r => same(r.block, owned));
        if (row.length !== 1 || !row[0].editable) fail('release_identity_mismatch');
        const [pencil, trash] = row[0].icons;
        if (pencil.desc !== EDIT_ICON || trash.desc !== DELETE_ICON) fail('calendar_schema_changed');
        if (trash.visible && trash.box[1] >= 300 && trash.box[3] <= 2200) {
          if (!pencil.visible || trash.box[0] <= pencil.box[2]) fail('calendar_schema_changed');
          return trash;
        }
        await this.swipe();
      }
      fail('release_row_not_reachable');
    });
    this.formDirty = true;
    await this.tap(trash, 3000);
  }
  async close() {
    const session = this.session;
    Object.assign(this, {session: null, listing: null, opened: null, rows: null, before: null, prepared: null, formDirty: false});
    if (!session) return;
    const cleanup = command => this.root(command).catch(() => {});
    await cleanup('rm -f ' + this.file);
    await cleanup(session.chromeWasTop ? 'am start -n ' + CHROME_MAIN : 'input keyevent KEYCODE_HOME');
    if (session.wasAsleep) await cleanup('input keyevent 223');
  }
}
