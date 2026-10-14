// NauSYS (app.nausys.com), the fifth platform (user decision 2026-10-09,
// AGENTS.md 6.4). Read in the phone's normal Chrome, signed in as demo-user@AGENCY
// (colleague@AGENCY stays with colleagues). The reservation list is a PrimeFaces page:
// its own Search form is driven with plain values and the table rows are read.
// Nothing here creates, edits or cancels a reservation.

export const NAUSYS_ORIGIN = 'https://app.nausys.com';
export const NAUSYS_LIST_URL = NAUSYS_ORIGIN + '/NauSYS-app/app/yachtReservations.xhtml';
export const NAUSYS_LOGIN_PATH = '/NauSYS-app/login.xhtml';
// Shown at the top of every page for the signed-in user (read 2026-10-09), and
// as the creator of the reservations this account makes.
export const NAUSYS_USER = 'DEMO, USER';
export const NAUSYS_CREATOR = 'USER DEMO';
export {NAUSYS_FLEET} from './nausys-plan.mjs';

/** Runs in the page: 'login', 'ready' (list with its search form), or null. */
export function nausysEntryState() {
  if (location.origin !== 'https://app.nausys.com') return null;
  if (location.pathname === '/NauSYS-app/login.xhtml' && document.getElementById('loginForm:loginInput')) return 'login';
  if (location.pathname === '/NauSYS-app/app/yachtReservations.xhtml' && window.PrimeFaces?.widgets?.resTable &&
      document.getElementById('searchCriteriaForm')) return 'ready';
  return null;
}
/** Runs in the page: whether the expected user is the one signed in. */
export function nausysSignedInAs(user) {
  return [...document.querySelectorAll('body *')].some(node => !node.children.length && node.textContent.trim() === user);
}

/** Runs in the page. Sets the list's own search criteria (all types, all
 * booking types, any creation or start date, ending on endFrom or later),
 * checks that no other filter is set, and presses Search. */
export function startNausysSearch(endFrom) {
  const pair = prefix => [...document.querySelectorAll('input[id^="searchCriteriaForm:' + prefix + ':"][id$="_input"]')];
  const widgets = window.PrimeFaces?.widgets || {};
  const made = pair('searchMadeFromTo'), begin = pair('searchReservationBeginFrom'), end = pair('searchReservationEndFrom');
  const type = widgets.widget_searchCriteriaForm_searchType, booking = widgets.widget_searchCriteriaForm_bookingType;
  const buttons = [...document.querySelectorAll('#searchCriteriaForm button')].filter(b => b.innerText.trim() === 'Search');
  if (made.length !== 2 || begin.length !== 2 || end.length !== 2 || !type || !booking || buttons.length !== 1) return {ok: false, reason: 'form'};
  // Filters this program never sets must be empty; it does not try to clear
  // autocomplete widgets it does not understand.
  const chosen = [...document.querySelectorAll('#searchCriteriaForm select[multiple]')].some(s => [...s.options].some(o => o.selected));
  const radio = name => document.querySelector('input[type=radio][name="searchCriteriaForm:' + name + '"]:checked')?.value ?? '';
  const text = ['searchCriteriaForm:searchID:compositeId', 'searchCriteriaForm:yachtAutocomplete_input', 'searchCriteriaForm:agencyAutocomplete_input',
    'searchCriteriaForm:clientAutocomplete_input'].some(id => (document.getElementById(id)?.value || '').trim());
  if (chosen || text || radio('directClientOnly') || radio('approvedReservations') || radio('balanceType')) return {ok: false, reason: 'filters'};
  type.selectValue('0'); booking.selectValue('0');
  for (const input of [...made, ...begin, end[1]]) input.value = '';
  end[0].value = endFrom;
  document.getElementById('searchResultsForm:yachtReservationsTable')?.setAttribute('data-fleet-stale', '1');
  buttons[0].click();
  return {ok: true};
}
/** Runs in the page: the search has finished and replaced the old table. */
export function nausysSearchDone() {
  const table = document.getElementById('searchResultsForm:yachtReservationsTable');
  return !!table && !table.hasAttribute('data-fleet-stale') && window.PrimeFaces?.ajax?.Queue?.isEmpty?.() !== false;
}
/** Runs in the page: rows loaded so far, and how many the search found. */
export function nausysRows() {
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const stamp = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/;
  const rows = [...document.querySelectorAll('[id="searchResultsForm:yachtReservationsTable_data"] > tr[data-ri]')].map(tr => {
    const cells = [...tr.children];
    const details = cells[2]?.querySelector('.createdDetails');
    const type = details?.querySelector('.resType');
    const spans = details ? [...details.querySelectorAll(':scope > span')] : [];
    const at = type ? spans.indexOf(type) : -1;
    const before = spans.slice(0, Math.max(0, at)).map(text).filter(t => stamp.test(t));
    const after = spans.slice(at + 1).map(text).filter(t => stamp.test(t));
    const nodes = details ? [...details.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()) : [];
    const yacht = cells[3] ? [...cells[3].querySelectorAll('span[style*="display:block"]')].map(text) : [];
    const period = cells[5] ? [...cells[5].querySelectorAll('span')].map(text).filter(Boolean) : [];
    return {id: tr.getAttribute('data-rk'), shown_id: text(cells[1]), type: text(type), expiry: before[0] || null, created: after[0] || null,
      creator: nodes.length ? text(nodes[nodes.length - 1]) : null, model: yacht[0] || null, name: yacht[1] || null,
      from: period[0] || null, to: period[1] || null};
  });
  const limit = window.PrimeFaces?.widgets?.resTable?.cfg?.scrollLimit;
  return {rows, limit: Number.isInteger(limit) ? limit : null, empty: !!document.querySelector('[id="searchResultsForm:yachtReservationsTable"] .ui-datatable-empty-message')};
}
/** Runs in the page: scroll the live-scroll table to load its next rows. */
export function nausysScrollTable() {
  const body = document.querySelector('[id="searchResultsForm:yachtReservationsTable"] .ui-datatable-scrollable-body');
  if (!body) return false;
  body.scrollTop = body.scrollHeight;
  body.dispatchEvent(new Event('scroll'));
  return true;
}

/** Runs in the list page: opens one reservation's dialog with the page's own
 * deep-link function (read 2026-10-10). Only opens; nothing is pressed. */
export function openListDialog(id) {
  if (typeof window.openDialogForDeepLink !== 'function') return false;
  window.openDialogForDeepLink(id); return true;
}
/** Runs in the reservation dialog: its header and the price block. Amounts
 * are read as shown ("3.772,00 €"); a missing or unparsable one is null.
 * Read 2026-10-10 on agency Options: Client price − Commission = Agency price. */
export function nausysDialogPrice() {
  const tx = s => (s || '').replace(/\s+/g, ' ').trim();
  const all = tx(document.body.innerText);
  const head = tx(document.querySelector('.documentDialogWrapper')?.innerText).match(/(\d{6,}) (OPTION|RESERVATION|CANCELED(?: \([A-Z]\))?|CANCELLED|INFORMATION) (\d{2}\.\d{2}\.\d{4}) (\d{2}\.\d{2}\.\d{4})/);
  const pick = label => {
    const m = all.match(new RegExp(label + ':\\s*(?:\\d+(?:[.,]\\d+)?\\s*%\\s*)?(\\d{1,3}(?:\\.\\d{3})*,\\d{2})\\s*(€|\\$)'));
    return m ? {value: Number(m[1].replace(/\./g, '').replace(',', '.')), symbol: m[2]} : null;
  };
  return {ready: !!window.PrimeFaces && PrimeFaces.ajax.Queue.isEmpty(), id: head?.[1] || null, status: head?.[2] || null, from: head?.[3] || null, to: head?.[4] || null,
    client: pick('Client price'), commission: pick('Commission'), agency: pick('Agency price')};
}
/** Runs in the reservation dialog: leaves it without saving. */
export function leaveNausysDialog() {
  const b = [...document.querySelectorAll('.ui-toolbar button')].filter(e => ['Back', 'Cancel', 'Close'].includes(e.innerText.trim()) && e.getClientRects().length);
  if (!b.length) return false;
  (b.find(e => e.innerText.trim() === 'Back') || b.find(e => e.innerText.trim() === 'Cancel') || b[0]).click(); return true;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw Error(message); };

export class NausysClient {
  constructor(page, {recoverLogin = null, isCancelled = () => false, sleep = pause} = {}) {
    Object.assign(this, {page, recoverLogin, isCancelled, sleep});
  }
  active() { if (this.isCancelled()) fail('phone_shutdown'); }
  async entry() {
    this.active();
    await this.page.goto(NAUSYS_LIST_URL, {waitUntil: 'domcontentloaded', timeout: 60000});
    this.active();
    await this.page.waitForFunction(nausysEntryState, {polling: 250, timeout: 30000});
    return this.page.evaluate(nausysEntryState);
  }
  async open() {
    let state = await this.entry();
    if (state === 'login' && this.recoverLogin) {
      await this.recoverLogin(this.page);
      state = await this.entry();
    }
    if (state === 'login') fail('nausys_auth_required');
    if (state !== 'ready') fail('nausys_list_unavailable');
    this.active();
    if (!await this.page.evaluate(nausysSignedInAs, NAUSYS_USER)) fail('nausys_account_mismatch');
  }
  /** Every row of one search, all live-scroll pages loaded. */
  async search(endFrom) {
    this.active();
    const started = await this.page.evaluate(startNausysSearch, endFrom);
    if (!started?.ok) fail(started?.reason === 'filters' ? 'nausys_filters_set' : 'nausys_search_form_changed');
    await this.page.waitForFunction(nausysSearchDone, {polling: 250, timeout: 45000});
    let read = await this.page.evaluate(nausysRows);
    // The table loads 50 rows per scroll. Stop after three scrolls that add none.
    for (let step = 0, idle = 0; step < 40 && idle < 3 && read.limit !== null && read.rows.length < read.limit; step++) {
      this.active();
      if (!await this.page.evaluate(nausysScrollTable)) break;
      await this.sleep(700);
      await this.page.waitForFunction(() => window.PrimeFaces?.ajax?.Queue?.isEmpty?.() !== false, {polling: 250, timeout: 30000});
      const before = read.rows.length;
      read = await this.page.evaluate(nausysRows);
      idle = read.rows.length > before ? 0 : idle + 1;
    }
    if (read.limit === null || read.rows.length !== read.limit || read.empty && read.rows.length) fail('nausys_list_incomplete');
    const ids = new Set();
    for (const row of read.rows) {
      if (!/^\d+$/.test(row.id || '') || row.shown_id !== row.id || ids.has(row.id)) fail('nausys_list_incomplete');
      ids.add(row.id);
    }
    return read.rows;
  }
  /** One reservation's dialog, opened from the list page, read and left
   * without saving (about 4 s each, 2026-10-10). Read-only. */
  async dialogPrice(id) {
    this.active();
    const dialogFrame = () => this.page.frames().find(frame => /yachtReservationDialog\.xhtml/.test(frame.url())) || null;
    if (dialogFrame()) fail('nausys_dialog_already_open');
    if (!await this.page.evaluate(openListDialog, id)) fail('nausys_dialog_unavailable');
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) { await this.sleep(500); frame = dialogFrame(); }
    if (!frame) fail('nausys_dialog_unavailable');
    try {
      await frame.waitForFunction(() => window.PrimeFaces && PrimeFaces.ajax.Queue.isEmpty() && document.querySelector('.ui-toolbar'), {polling: 250, timeout: 30000});
      await this.sleep(1000);
      return await frame.evaluate(nausysDialogPrice);
    } finally {
      await frame.evaluate(leaveNausysDialog).catch(() => false);
      for (let i = 0; i < 30 && dialogFrame(); i++) await this.sleep(500);
      if (dialogFrame()) fail('nausys_dialog_not_closed');
    }
  }
}
