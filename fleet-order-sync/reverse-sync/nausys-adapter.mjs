// NauSYS calendar writer (user decision 2026-10-09, AGENTS.md 6.4): the program
// enters other platforms' orders into NauSYS the way colleagues did by hand.
// An Option is made from the booking calendar, the client is the source
// platform's CRM contact, "Don't send notification after save" is ticked, no
// payment is entered, and the Option is turned into a booking. Copies that
// colleagues entered count as coverage and are never touched; the program only
// cancels reservations its own ledger created.
//
// Observed on NauSYS 2026-10-09 (Lightcat, 21-24.08.2027, never saved):
// - The calendar asks the server for the possible check-out dates of a check-in
//   day (action fetchCheckOutDates), then for the popup of a chosen period
//   (action fetchBookingDiv). A FREE popup offers createOption(yacht, from, to)
//   with NauSYS's own formatted times (check-in 16:00, check-out 10:00).
// - createOption opens yachtReservationDialog.xhtml with a number already
//   allocated (shown in its header) but saves nothing until Save.
// - The client chooser (crm.xhtml) lists CRM contacts; picking one makes the
//   "Don't send notification after save" switch appear.
// - Actions holds "Make booking" for an Option and "Cancel reservation" for a
//   booking, each behind an "Are You sure?" confirmation.
import {NausysClient, NAUSYS_FLEET, NAUSYS_CREATOR, NAUSYS_ORIGIN, nausysEntryState} from './nausys-client.mjs';
import {nausysDay} from '../collectors/nausys.mjs';
import {beforeRequest} from './not-submitted.mjs';

export const NAUSYS_CALENDAR_URL = NAUSYS_ORIGIN + '/NauSYS-app/app/bookinglist.xhtml';
// CRM contacts colleagues created for the order sources (read 2026-10-09).
// There are two contacts named "Direct"; 8000004 is the one created on 09-30
// together with Click&Boat and SamBoat, so a contact is matched by ID and name.
export const NAUSYS_CLIENTS = Object.freeze({
  boataround: {name: 'Boataround', id: '8000001'}, clickandboat: {name: 'Click&Boat', id: '8000002'},
  samboat: {name: 'SamBoat', id: '8000003'}, mmk: {name: 'MMK', id: '8000005'}, 'manual-hold': {name: 'Direct', id: '8000004'}});
const EXPIRY_MARGIN_MS = 24 * 3600000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw Error(message); };
const dmy = value => { const m = typeof value === 'string' && value.match(/^(\d{2})\.(\d{2})\.(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : null; };
const dmyTime = value => { const m = typeof value === 'string' && value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/); return m ? Date.parse(m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':00Z') : null; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/** The source platform whose CRM contact a protection is filed under. */
export function nausysClient(causes) {
  const sources = [...causes].sort().map(key => String(key).split(':')[0]);
  const client = NAUSYS_CLIENTS[sources[0]];
  if (!client) fail('nausys_client_unknown');
  return client;
}

/** One reservation-list row → a calendar block on this yacht, or null. Only an
 * Option or a Reservation occupies the calendar; an Information or a cancelled
 * record does not. The valid-till time has no time zone, so an Option counts
 * as closing its dates only until a day before it (review 2026-10-10): NauSYS
 * may free the yacht at valid-till, and the program must not keep reporting
 * dates as closed by it after that. */
export function nausysBlock(row, yacht, now) {
  if (row.name !== yacht.name || row.model !== yacht.model) return null;
  const type = String(row.type || '').trim().toUpperCase();
  if (type !== 'OPTION' && type !== 'RESERVATION') return null;
  if (type === 'OPTION') { const expiry = dmyTime(row.expiry); if (expiry === null || now > expiry - EXPIRY_MARGIN_MS) return null; }
  const start = dmy(row.from), end = dmy(row.to);
  if (!start || !end || end <= start || !/^\d+$/.test(row.id || '')) fail('nausys_list_incomplete');
  return {id: row.id, start, end, type, boat: yacht.yacht_id, own: row.creator === NAUSYS_CREATOR};
}

// ---- functions run in the calendar page ----
export function calendarView() {
  const w = window.PrimeFaces?.widgets?.dailyBookingListWidget, wrap = window.jQuery?.('#bookingListWrapper');
  return w && wrap ? {zoom: w.cfg.zoomLevel, from: wrap.data('from') || null, to: wrap.data('to') || null, idle: PrimeFaces.ajax.Queue.isEmpty()} : null;
}
export function pressDaily() {
  const b = [...document.querySelectorAll('.bookingListMenubar button, .bookingListMenubar a, .bookingListMenubar .ui-button')].filter(e => e.textContent.trim() === 'Daily');
  if (b.length !== 1) return false; b[0].click(); return true;
}
export function setCalendarDate([index, iso]) {
  const inputs = [...document.querySelectorAll('#searchCriteriaForm input[id$="_input"]')].filter(i => /^\d{2}\.\d{2}\.\d{4}$/.test(i.value));
  const widget = inputs.length === 2 && Object.values(PrimeFaces.widgets).find(w => w.jq && w.jq[0]?.contains?.(inputs[index]) && typeof w.setDate === 'function');
  if (!widget) return false;
  widget.setDate(new Date(iso + 'T12:00:00')); inputs[index].dispatchEvent(new Event('change', {bubbles: true}));
  return true;
}
export function pressCalendarSearch() {
  const b = [...document.querySelectorAll('#searchCriteriaForm button')].filter(e => e.innerText.trim() === 'Search');
  if (b.length !== 1) return false;
  document.getElementById('bookingListWrapper')?.setAttribute('data-fleet-stale', '1'); b[0].click(); return true;
}
/** The calendar's own two queries for a period: the check-in it allows from
 * that day, whether the check-out day is offered, and the period's popup. */
export async function queryCalendarPeriod({yachtId, start, end}) {
  const w = PF('dailyBookingListWidget');
  const ask = params => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('nausys_calendar_timeout')), 20000);
    PrimeFaces.ajax.Request.handle({source: w.id, process: w.id, update: w.id, formId: w.cfg.formId, global: false, params,
      onsuccess: (xml, status, xhr) => { PrimeFaces.ajax.Response.handle(xml, status, xhr, {widget: w, handle: content => { clearTimeout(timer); resolve(content); }}); return true; },
      onerror: () => { clearTimeout(timer); reject(Error('nausys_calendar_unavailable')); }});
  });
  const raw = await ask([{name: 'action', value: 'fetchCheckOutDates'}, {name: 'yachtId', value: yachtId}, {name: 'periodFrom', value: start + ' 00:00'}]);
  if (!raw) return {checkIn: null};
  const data = JSON.parse(raw), out = (data.checkOutDates || []).filter(d => String(d).slice(0, 10) === end);
  if (!data.checkIn || out.length !== 1) return {checkIn: data.checkIn || null, checkOut: null};
  const html = await ask([{name: 'action', value: 'fetchBookingDiv'}, {name: 'yachtId', value: yachtId},
    {name: 'periodFrom', value: new Date(data.checkIn).toNausysFormat3()}, {name: 'periodTo', value: new Date(out[0]).toNausysFormat3()},
    {name: 'locationId', value: undefined}, {name: 'reservationType', value: 'free'}]);
  const box = document.createElement('div'); box.innerHTML = html || '';
  const links = [...box.querySelectorAll('a.dailyRes-btn-option')];
  return {checkIn: data.checkIn, checkOut: out[0], status: box.querySelector('.dailyRes-status')?.textContent.trim() || null,
    call: links.length === 1 ? links[0].getAttribute('onclick') : null};
}
export function openOption([yachtId, from, to]) { createOption(yachtId, from, to); return true; }
export function openReservation(id) { fetchReservation(id); return true; }

// ---- functions run in the reservation dialog ----
export function dialogState() {
  const tx = s => (s || '').replace(/\s+/g, ' ').trim();
  // e.g. "900000002 OPTION 21.08.2027 24.08.2027 Lightcat 400 S2 - Tidewyn Discovery 6 - 2017. Phuket, ..."
  const head = tx(document.querySelector('.documentDialogWrapper')?.innerText).match(/(\d{6,}) (OPTION|RESERVATION|CANCELED(?: \([A-Z]\))?|CANCELLED|INFORMATION) (\d{2}\.\d{2}\.\d{4}) (\d{2}\.\d{2}\.\d{4}) (.+? - \d{4})\./);
  const box = document.getElementById('yachtReservationDialogForm:sendConfirmationAfterSave:compositeId_input');
  const client = document.getElementById('yachtReservationDialogForm:tabView:clientFetch')?.closest('.ui-g.ui-g-12')?.parentElement;
  return {ready: !!window.PrimeFaces && PrimeFaces.ajax.Queue.isEmpty(),
    id: head?.[1] || null, status: head?.[2] || null, from: head?.[3] || null, to: head?.[4] || null, yacht: head?.[5] || null,
    params: new URL(location.href).searchParams.getAll('yachtReservationParams'), reservationId: new URL(location.href).searchParams.get('YachtReservationId'),
    // Shown as e.g. "DIRECT fetch Clear" plus an invisible icon character.
    client: client ? tx(client.innerText).split(/\s*\bfetch\b/)[0].trim() : null,
    notify: box ? {present: true, quiet: box.checked} : {present: false, quiet: false},
    errors: [...document.querySelectorAll('.ui-messages-error, .ui-message-error, .ui-growl-message-error')].map(e => tx(e.innerText)).filter(Boolean).slice(0, 3),
    buttons: [...document.querySelectorAll('.ui-toolbar button')].map(b => tx(b.innerText)).filter(Boolean)};
}
export function pressDialogButton(text) {
  const b = [...document.querySelectorAll('.ui-toolbar button')].filter(e => e.innerText.trim() === text && e.getClientRects().length);
  if (b.length !== 1) return false; b[0].click(); return true;
}
export function pressClientFetch() {
  const b = document.getElementById('yachtReservationDialogForm:tabView:clientFetch')?.querySelector('button');
  if (!b) return false; b.click(); return true;
}
export function quietSave() {
  const box = document.getElementById('yachtReservationDialogForm:sendConfirmationAfterSave:compositeId_input');
  if (!box) return false;
  if (!box.checked) (box.closest('.ui-chkbox')?.querySelector('.ui-chkbox-box') || box).click();
  return box.checked;
}
export function pressAction(id) {
  const a = document.getElementById(id);
  if (!a) return false; a.click(); return true;
}
export function confirmYes() {
  const yes = [...document.querySelectorAll('.ui-confirm-dialog, .ui-confirmdialog')].filter(d => d.getClientRects().length && getComputedStyle(d).display !== 'none')
    .flatMap(d => [...d.querySelectorAll('button')].filter(b => /\bui-confirmdialog-yes\b/.test(b.className) || b.innerText.trim() === 'Yes'));
  if (yes.length !== 1) return false; yes[0].click(); return true;
}

// ---- functions run in the client chooser (crm.xhtml) ----
export function searchClient(name) {
  const input = document.getElementById('searchCriteriaForm:searchName:compositeId'), button = document.getElementById('searchCriteriaForm:searchBtn');
  if (!input || !button) return false;
  input.value = name; button.click(); return true;
}
/** Rows whose name is exactly this client; picks it when there is one. Call
 * only after the search request has finished (the queue is empty). */
export function pickClient({name, id}) {
  const table = document.querySelector('[id="searchResultsForm:contactsTable"]');
  if (!table || !PrimeFaces.ajax.Queue.isEmpty()) return {ready: false};
  const rows = [...table.querySelectorAll('[id="searchResultsForm:contactsTable_data"] > tr[data-rk]')].filter(tr => tr.getAttribute('data-rk') === id && tr.children[2]?.textContent.replace(/\s+/g, ' ').trim() === name);
  if (rows.length !== 1) return {ready: true, count: rows.length};
  rows[0].querySelector('button')?.click();
  return {ready: true, count: 1, id: rows[0].getAttribute('data-rk')};
}

export class NausysAdapter {
  constructor({openPage, closePage, recoverLogin = null, isCancelled = () => false, now = Date.now, sleep = pause}) {
    Object.assign(this, {openPage, closePage, recoverLogin, isCancelled, now, sleep});
  }
  active() { if (this.isCancelled()) fail('phone_shutdown'); }
  yacht(target) {
    const yacht = NAUSYS_FLEET.find(item => item.yacht_id === target.listing_id && item.boat === target.boat);
    if (!yacht) fail('mapping_unknown');
    return yacht;
  }
  async connect() {
    this.active();
    if (!this.page) {
      this.page = await this.openPage();
      this.client = new NausysClient(this.page, {recoverLogin: this.recoverLogin, isCancelled: this.isCancelled, sleep: this.sleep});
      try { await this.client.open(); } catch (error) { await this.close(); throw error; }
    }
  }
  async read(target) {
    const yacht = this.yacht(target);
    await this.connect();
    // Writes leave the page on the calendar; reads use the reservation list.
    if (new URL(this.page.url()).pathname !== '/NauSYS-app/app/yachtReservations.xhtml') await this.client.open();
    const from = new Date(this.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    const rows = await this.client.search(nausysDay(from));
    const blocks = rows.map(row => nausysBlock(row, yacht, this.now())).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    this.target = target; this.before = blocks;
    return {identity_verified: true, complete: true, blocks};
  }
  async prepare(target, gap) {
    if (target.listing_id !== this.target?.listing_id) fail('wrong_listing');
    const previous = JSON.stringify(this.before), current = await this.read(target);
    if (JSON.stringify(current.blocks) !== previous || current.blocks.some(b => b.start < gap.end && b.end > gap.start)) fail('nausys_calendar_changed');
  }
  /** The calendar page, in the Daily view, showing the whole period. */
  async calendar(start, end) {
    this.active();
    const page = this.page;
    await page.goto(NAUSYS_CALENDAR_URL, {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForFunction(() => window.location.pathname === '/NauSYS-app/login.xhtml' || (window.PrimeFaces?.widgets?.dailyBookingListWidget && PrimeFaces.ajax.Queue.isEmpty()), {polling: 250, timeout: 45000});
    if (await page.evaluate(nausysEntryState) === 'login') fail('nausys_auth_required');
    let view = await page.evaluate(calendarView);
    if (!view) fail('nausys_calendar_unavailable');
    if (view.zoom !== 1) {
      if (!await page.evaluate(pressDaily)) fail('nausys_calendar_unavailable');
      await page.waitForFunction(() => PrimeFaces.ajax.Queue.isEmpty() && PF('dailyBookingListWidget')?.cfg?.zoomLevel === 1, {polling: 250, timeout: 45000});
      await this.sleep(1000);
    }
    view = await page.evaluate(calendarView);
    if (!(view.from <= start && view.to >= end)) {
      // Start first, then end: setting the start resets a too-early end.
      for (const [index, day] of [[0, shift(start, -7)], [1, shift(end, 14)]]) {
        if (!await page.evaluate(setCalendarDate, [index, day])) fail('nausys_calendar_unavailable');
        await page.waitForFunction(() => PrimeFaces.ajax.Queue.isEmpty(), {polling: 250, timeout: 30000}); await this.sleep(600);
      }
      if (!await page.evaluate(pressCalendarSearch)) fail('nausys_calendar_unavailable');
      await page.waitForFunction(() => !document.getElementById('bookingListWrapper')?.hasAttribute('data-fleet-stale') && PrimeFaces.ajax.Queue.isEmpty(), {polling: 250, timeout: 45000});
      await this.sleep(1000);
      view = await page.evaluate(calendarView);
    }
    if (view?.zoom !== 1 || !(view.from <= start && view.to >= end)) fail('nausys_calendar_unavailable');
  }
  frame(pattern) { return this.page.frames().find(frame => pattern.test(frame.url())) || null; }
  async dialog() {
    await this.page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => /yachtReservationDialog/.test(f.src)), {polling: 250, timeout: 45000});
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) { await this.sleep(500); frame = this.frame(/yachtReservationDialog\.xhtml/); }
    if (!frame) fail('nausys_dialog_unavailable');
    await frame.waitForFunction(() => window.PrimeFaces && PrimeFaces.ajax.Queue.isEmpty() && document.querySelector('.ui-toolbar'), {polling: 250, timeout: 45000});
    await this.sleep(800);
    return frame;
  }
  async settle(frame) { await frame.waitForFunction(() => PrimeFaces.ajax.Queue.isEmpty(), {polling: 250, timeout: 45000}); await this.sleep(1000); return frame.evaluate(dialogState); }
  async closeDialog(frame) {
    for (const text of ['Cancel', 'Back']) if (await frame.evaluate(pressDialogButton, text).catch(() => false)) { await this.sleep(1500); return; }
  }
  async submit(target, gap, evidence, attempt) {
    let frame = null, id = null, yacht, client;
    // Everything up to Save only reads or opens forms: a failure sends nothing.
    await beforeRequest(async () => {
      if (!attempt?.id) fail('nausys_write_intent_required');
      yacht = this.yacht(target); client = nausysClient(attempt.causes || []);
      await attempt.guard?.({beforeFirstWrite: true});
      await this.connect();
      await this.calendar(gap.start, gap.end);
      const answer = await this.page.evaluate(queryCalendarPeriod, {yachtId: yacht.yacht_id, start: gap.start, end: gap.end});
      const call = answer.call?.match(/^createOption\('(\d+)', '(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2})', '(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2})'\);$/);
      if (answer.status !== 'FREE' || !call || call[1] !== yacht.yacht_id || dmy(call[2]) !== gap.start || dmy(call[4]) !== gap.end) fail('nausys_dates_not_available');
      this.active();
      await this.page.evaluate(openOption, [call[1], call[2] + ' ' + call[3], call[4] + ' ' + call[5]]);
      frame = await this.dialog();
      let state = await frame.evaluate(dialogState);
      id = state.id;
      if (!/^\d+$/.test(id || '') || state.status !== 'OPTION' || state.reservationId !== '-1' || state.params[0] !== yacht.yacht_id ||
          dmy(state.from) !== gap.start || dmy(state.to) !== gap.end || !state.yacht?.includes(' - ' + yacht.name + ' - ')) fail('nausys_form_mismatch');
      if (!await frame.evaluate(pressClientFetch)) fail('nausys_form_mismatch');
      let crm = null;
      for (let i = 0; i < 60 && !crm; i++) { await this.sleep(500); crm = this.frame(/crm\.xhtml/); }
      if (!crm) fail('nausys_client_not_found');
      await crm.waitForFunction(() => window.PrimeFaces && PrimeFaces.ajax.Queue.isEmpty() && document.getElementById('searchCriteriaForm:searchBtn'), {polling: 250, timeout: 45000});
      if (!await crm.evaluate(searchClient, client.name)) fail('nausys_client_not_found');
      await this.sleep(1500);
      await crm.waitForFunction(() => PrimeFaces.ajax.Queue.isEmpty(), {polling: 250, timeout: 45000});
      await this.sleep(800);
      let picked = {ready: false};
      for (let i = 0; i < 60 && !picked.ready; i++) { await this.sleep(500); picked = await crm.evaluate(pickClient, client).catch(() => ({ready: false})); }
      if (picked.count !== 1) fail('nausys_client_not_found');
      // The form refreshes a second or two after the chooser closes.
      for (let i = 0; i < 40; i++) {
        await this.sleep(500);
        state = await frame.evaluate(dialogState).catch(() => null);
        if (state?.ready && state.client && state.notify.present) break;
      }
      if (state?.client?.toUpperCase() !== client.name.toUpperCase() || !state.notify.present) fail('nausys_form_mismatch');
      if (!await frame.evaluate(quietSave)) fail('nausys_form_mismatch');
      state = await frame.evaluate(dialogState);
      if (!state.notify.quiet || state.id !== id || state.errors.length) fail('nausys_form_mismatch');
      await attempt.guard?.();
      await evidence({draft_id: id, client: client.id});
    }).catch(async error => { if (frame) await this.closeDialog(frame).catch(() => {}); throw error; });
    // Save: from here a failure may have created the Option. It stays
    // uncertain and is reconciled by recover() from the list, never redone.
    this.active();
    if (!await frame.evaluate(pressDialogButton, 'Save')) fail('nausys_write_uncertain');
    frame = await this.stored(frame, id, gap);
    await this.makeBooking(frame, id, gap, attempt.guard);
    await this.closeDialog(frame).catch(() => {});
    return {id, start: gap.start, end: gap.end, type: 'RESERVATION', boat: yacht.yacht_id, own: true};
  }
  /** After Save: the form either shows the stored Option (Edit instead of
   * Save) or closes (seen 2026-10-10); then the Option is opened by its number. */
  async stored(frame, id, gap) {
    let state = null;
    for (let i = 0; i < 40; i++) {
      await this.sleep(500);
      if (frame.isDetached?.() || !this.page.frames().includes(frame)) { state = null; break; }
      state = await frame.evaluate(dialogState).catch(() => null);
      if (state?.errors?.length) fail('nausys_write_uncertain');
      if (state?.ready && state.id === id && state.status === 'OPTION' && !state.buttons.includes('Save') && state.buttons.includes('Edit')) return frame;
    }
    if (state) fail('nausys_write_uncertain');
    await this.page.evaluate(openReservation, id);
    const reopened = await this.dialog();
    state = await reopened.evaluate(dialogState);
    if (state.id !== id || state.status !== 'OPTION' || dmy(state.from) !== gap.start || dmy(state.to) !== gap.end) {
      await this.closeDialog(reopened).catch(() => {}); fail('nausys_write_uncertain');
    }
    return reopened;
  }
  async makeBooking(frame, id, gap, guard) {
    let state = await frame.evaluate(dialogState);
    if (state.notify.present && !state.notify.quiet && !await frame.evaluate(quietSave)) fail('nausys_booking_not_confirmed');
    await guard?.();
    if (!await frame.evaluate(pressAction, 'yachtReservationDialogForm:makeBookingBtn')) fail('nausys_booking_not_confirmed');
    await this.sleep(800);
    if (!await frame.evaluate(confirmYes)) fail('nausys_booking_not_confirmed');
    state = await this.settle(frame);
    if (state.errors.length || state.id !== id || state.status !== 'RESERVATION' || dmy(state.from) !== gap.start || dmy(state.to) !== gap.end) fail('nausys_booking_not_confirmed');
  }
  /** Before the normal read: settle earlier uncertain writes from the list. */
  async recover(target, ledger, guard, save) {
    const key = 'nausys:' + target.listing_id;
    const open = ledger.attempts.filter(a => a.target === key && !['confirmed', 'releasing', 'released', 'observed_protected', 'reviewed_no_record', 'not_submitted'].includes(a.state) && a.response?.draft_id);
    if (!open.length) return;
    const {blocks} = await this.read(target);
    const yacht = this.yacht(target);
    const rows = await this.client.search(nausysDay(new Date(this.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10)));
    // One record that needs a person is left as it is (its own dates are then
    // reported as uncertain by the executor); it no longer stops the whole
    // yacht (review 2026-10-10).
    const review = async (a, reason) => { a.review_reason = reason; a.review_at = new Date(this.now()).toISOString(); await save(ledger); };
    for (const a of open) {
      const id = a.response.draft_id, row = rows.find(r => r.id === id);
      if (!row) {
        // The complete list has no record under the number the form showed:
        // Save never stored it. The dates are written again next time.
        if (a.end <= new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10)) continue;
        a.state = 'not_submitted'; a.reason = 'nausys_draft_not_saved'; await save(ledger); continue;
      }
      if (row.creator !== NAUSYS_CREATOR || row.name !== yacht.name || row.model !== yacht.model) { await review(a, 'nausys_partial_write_requires_review'); continue; }
      const type = String(row.type || '').trim().toUpperCase(), expiry = dmyTime(row.expiry);
      // Our own draft, since cancelled or expired, closes nothing any more:
      // the dates are written again (the calendar's FREE check still applies).
      if (/^CANCEL/.test(type) || type === 'OPTION' && expiry !== null && this.now() > expiry + EXPIRY_MARGIN_MS) {
        a.state = 'not_submitted'; a.reason = 'nausys_draft_cancelled_or_expired'; await save(ledger); continue;
      }
      const block = blocks.find(b => b.id === id);
      if (!block || block.start !== a.start || block.end !== a.end) { await review(a, 'nausys_partial_write_requires_review'); continue; }
      if (block.type === 'OPTION') {
        await guard();
        await this.calendar(a.start, a.end);
        await this.page.evaluate(openReservation, id);
        const frame = await this.dialog();
        const state = await frame.evaluate(dialogState);
        if (state.id !== id || state.status !== 'OPTION') { await this.closeDialog(frame).catch(() => {}); await review(a, 'nausys_partial_write_requires_review'); continue; }
        await this.makeBooking(frame, id, a, guard);
        await this.closeDialog(frame).catch(() => {});
      }
      a.created = {id, start: a.start, end: a.end, type: 'RESERVATION', boat: yacht.yacht_id, own: true};
      a.state = 'pending_readback'; await save(ledger);
    }
  }
  async remove(target, owned, {guard} = {}) {
    const yacht = this.yacht(target);
    let frame = null;
    await beforeRequest(async () => {
      const current = (await this.read(target)).blocks.find(b => b.id === owned.id);
      if (!current || !same(current, owned) || !owned.own || owned.type !== 'RESERVATION') fail('nausys_owned_record_changed');
      await this.calendar(owned.start, owned.end);
      await this.page.evaluate(openReservation, owned.id);
      frame = await this.dialog();
      const state = await frame.evaluate(dialogState);
      if (state.id !== owned.id || state.status !== 'RESERVATION' || dmy(state.from) !== owned.start || dmy(state.to) !== owned.end ||
          !state.yacht?.includes(' - ' + yacht.name + ' - ')) fail('nausys_owned_record_changed');
      // The client must still be one of the platform contacts the program
      // files under; a colleague who put a real guest on it keeps it (review
      // 2026-10-10). The view shows the name with a trailing icon character.
      const shown = String(state.client || '').toUpperCase().replace(/[^A-Z0-9&]+$/, '').replace(/^[^A-Z0-9&]+/, '');
      if (!Object.values(NAUSYS_CLIENTS).some(c => c.name.toUpperCase() === shown)) fail('nausys_owned_record_changed');
      await guard?.();
    }).catch(async error => { if (frame) await this.closeDialog(frame).catch(() => {}); throw error; });
    this.active();
    if (!await frame.evaluate(pressAction, 'yachtReservationDialogForm:stornoBtn')) fail('nausys_cancel_uncertain');
    await this.sleep(800);
    if (!await frame.evaluate(confirmYes)) fail('nausys_cancel_uncertain');
    const state = await this.settle(frame).catch(() => null);
    await this.closeDialog(frame).catch(() => {});
    if (state && state.status && !/^CANCEL/.test(state.status)) fail('nausys_cancel_readback_failed');
  }
  async close() {
    const page = this.page; this.page = null; this.client = null;
    if (page) await this.closePage(page);
  }
}
