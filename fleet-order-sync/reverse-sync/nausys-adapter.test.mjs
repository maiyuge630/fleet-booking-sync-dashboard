// NauSYS calendar writer (user decision 2026-10-09). The fake NauSYS below
// follows what was read from the real pages on 2026-10-09: the reservation
// list, the calendar's two queries, the reservation dialog with an allocated
// number, the client chooser, Save, Make booking and Cancel reservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {nausysPlan, NAUSYS_FLEET} from './nausys-plan.mjs';
import {NausysAdapter, nausysBlock, nausysClient, NAUSYS_CLIENTS, calendarView, pressDaily, setCalendarDate, pressCalendarSearch, queryCalendarPeriod,
  openOption, openReservation, dialogState, pressDialogButton, pressClientFetch, quietSave, pressAction, confirmYes, searchClient, pickClient} from './nausys-adapter.mjs';
import {nausysEntryState, nausysSignedInAs, startNausysSearch, nausysSearchDone, nausysRows, nausysScrollTable} from './nausys-client.mjs';

const NOW = Date.parse('2026-10-09T22:00:00Z'), stamp = new Date(NOW).toISOString();
const LIGHTCAT = NAUSYS_FLEET[3], AD5 = NAUSYS_FLEET[2];
const dmy = iso => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
const row = (id, change = {}) => ({id, shown_id: id, type: 'RESERVATION', expiry: null, created: '01.10.2026 05:53', creator: 'DEMO COLLEAGUE',
  model: LIGHTCAT.model, name: LIGHTCAT.name, from: '01.12.2026', to: '08.12.2026', ...change});

function nausys({rows = [], free = true, saveWorks = true, bookWorks = true, closeOnSave = false, nextId = '952831027', clients = Object.values(NAUSYS_CLIENTS), viewClient = 'BOATAROUND '} = {}) {
  const s = {rows: structuredClone(rows), dialog: null, crm: null, calls: [], pending: null};
  const yachtOf = id => NAUSYS_FLEET.find(y => y.yacht_id === id);
  const dialogFrame = {url: () => 'https://app.nausys.com/NauSYS-app/app/yachtReservationDialog.xhtml',
    waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      const d = s.dialog;
      if (fn === dialogState) return {ready: true, id: d.id, status: d.status, from: dmy(d.start), to: dmy(d.end), yacht: d.yacht.model + ' - ' + d.yacht.name + ' - 2017',
        params: d.reservationId === '-1' ? [d.yacht.yacht_id, dmy(d.start) + ' 16:00', dmy(d.end) + ' 10:00', 'true'] : [], reservationId: d.reservationId,
        client: d.client, notify: {...d.notify}, errors: [], buttons: d.reservationId === '-1' || d.edit ? ['Save', 'Cancel', 'Actions'] : ['Back', 'Edit', 'Actions']};
      if (fn === pressClientFetch) { s.crm = {}; s.calls.push('client chooser'); return true; }
      if (fn === quietSave) { if (!d.notify.present) return false; d.notify.quiet = true; s.calls.push('quiet'); return true; }
      if (fn === pressDialogButton) {
        const visible = d.reservationId === '-1' || d.edit ? ['Save', 'Cancel'] : ['Back', 'Edit'];
        if (!visible.includes(arg)) return false;
        s.calls.push('press ' + arg);
        if (arg === 'Save') {
          if (!saveWorks) return true;
          if (d.reservationId === '-1') s.rows.push(row(d.id, {type: 'OPTION', expiry: '17.10.2026 23:59', creator: 'USER DEMO', model: d.yacht.model, name: d.yacht.name, from: dmy(d.start), to: dmy(d.end)}));
          d.reservationId = d.id; d.edit = false; d.notify = {present: false, quiet: false};
          if (closeOnSave) s.dialog = null; // seen on NauSYS 2026-10-10
          return true;
        }
        if (arg === 'Cancel' || arg === 'Back') { s.dialog = null; return true; }
        if (arg === 'Edit') { d.edit = true; return true; }
        return false;
      }
      if (fn === pressAction) { s.pending = arg; s.calls.push('action ' + arg.split(':').pop()); return true; }
      if (fn === confirmYes) {
        const r = s.rows.find(x => x.id === d.id);
        if (s.pending?.endsWith('makeBookingBtn') && bookWorks) { r.type = 'RESERVATION'; r.expiry = null; d.status = 'RESERVATION'; }
        if (s.pending?.endsWith('stornoBtn')) { r.type = 'CANCELED (R)'; d.status = 'CANCELED (R)'; }
        s.calls.push('yes'); s.pending = null; return true;
      }
      throw Error('unexpected dialog call ' + fn.name);
    }};
  const crmFrame = {url: () => 'https://app.nausys.com/NauSYS-app/app/crm.xhtml?fetch=true', waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      if (fn === searchClient) { s.crm.search = arg; return true; }
      if (fn === pickClient) {
        const match = clients.filter(c => c.name === arg.name && c.id === arg.id && s.crm.search === arg.name);
        if (match.length !== 1) return {ready: true, count: match.length};
        s.dialog.client = arg.name.toUpperCase(); s.dialog.notify = {present: true, quiet: false}; s.crm = null; s.calls.push('client ' + arg.id);
        return {ready: true, count: 1, id: arg.id};
      }
      throw Error('unexpected crm call ' + fn.name);
    }};
  const page = {
    goto: async url => { s.calls.push('goto ' + url.split('/').pop()); }, waitForFunction: async () => {}, url: () => 'https://app.nausys.com/NauSYS-app/app/yachtReservations.xhtml',
    frames: () => [...(s.dialog ? [dialogFrame] : []), ...(s.crm ? [crmFrame] : [])],
    evaluate: async (fn, arg) => {
      if (fn === nausysEntryState) return 'ready';
      if (fn === nausysSignedInAs) return true;
      if (fn === startNausysSearch) return {ok: true};
      if (fn === nausysSearchDone) return true;
      if (fn === nausysRows) return {rows: structuredClone(s.rows), limit: s.rows.length, empty: false};
      if (fn === nausysScrollTable) return true;
      if (fn === calendarView) return {zoom: 1, from: '2026-10-01', to: '2028-12-31', idle: true};
      if ([pressDaily, setCalendarDate, pressCalendarSearch].includes(fn)) return true;
      if (fn === queryCalendarPeriod) {
        s.calls.push('query ' + arg.start + '/' + arg.end);
        return free ? {checkIn: arg.start + ' 16:00', checkOut: arg.end + ' 10:00', status: 'FREE',
          call: "createOption('" + arg.yachtId + "', '" + dmy(arg.start) + " 16:00', '" + dmy(arg.end) + " 10:00');"} : {checkIn: arg.start + ' 16:00', checkOut: null};
      }
      if (fn === openOption) {
        const [yachtId, from, to] = arg, iso = v => v.slice(6, 10) + '-' + v.slice(3, 5) + '-' + v.slice(0, 2);
        s.dialog = {id: nextId, status: 'OPTION', reservationId: '-1', yacht: yachtOf(yachtId), start: iso(from), end: iso(to), client: '', notify: {present: false, quiet: false}};
        s.calls.push('open option'); return true;
      }
      if (fn === openReservation) {
        const r = s.rows.find(x => x.id === arg), yacht = NAUSYS_FLEET.find(y => y.name === r.name);
        const iso = v => v.slice(6, 10) + '-' + v.slice(3, 5) + '-' + v.slice(0, 2);
        s.dialog = {id: r.id, status: r.type, reservationId: r.id, yacht, start: iso(r.from), end: iso(r.to), client: viewClient, notify: {present: false, quiet: false}};
        s.calls.push('open ' + arg); return true;
      }
      throw Error('unexpected page call ' + fn.name);
    }};
  return {s, page};
}
const adapterFor = world => new NausysAdapter({openPage: async () => world.page, closePage: async () => {}, now: () => NOW, sleep: async () => {}});
const target = (yacht = LIGHTCAT, segments = []) => ({target: 'nausys', boat: yacht.boat, listing_id: yacht.yacht_id, segments});
const gap = {start: '2027-08-21', end: '2027-08-24'};

test('NauSYS targets: the four yachts, nights only, NauSYS orders never written back, MMK orders included', () => {
  const boat = AD5.boat, base = ['boataround', 'clickandboat', 'samboat'].map(t => ({boat, target: t, fresh: true, release_proof: {ready: true, checked_at: stamp,
    orders: [{key: 'boataround:1', state: 'active', start: '2027-01-04', end: '2027-01-10'}, {key: 'nausys:9', state: 'active', start: '2027-02-27', end: '2027-03-07'}]}}));
  const plan = nausysPlan({rule_version: 2, generated_at: stamp, targets: base, causes: [
    {key: 'boataround:1', boat, start: '2027-01-04', end: '2027-01-10', fresh: true},
    {key: 'mmk:2', source: 'mmk', boat, start: '2027-01-10', end: '2027-01-15', fresh: true},
    {key: 'nausys:9', source: 'nausys', boat, start: '2027-02-27', end: '2027-03-07', fresh: true}]});
  assert.deepEqual(plan.targets.map(t => [t.boat, t.listing_id, t.key]), NAUSYS_FLEET.map(y => [y.boat, y.yacht_id, y.boat + ':nausys']));
  const t = plan.targets.find(x => x.boat === boat);
  assert.deepEqual(t.segments, [{start: '2027-01-04', end: '2027-01-09', causes: ['boataround:1']}, {start: '2027-01-10', end: '2027-01-14', causes: ['mmk:2']}]);
  assert.equal(t.fresh, true);
  assert.deepEqual(t.release_proof.orders[0], {key: 'boataround:1', state: 'active', start: '2027-01-04', end: '2027-01-09'});
  assert.equal(plan.targets.find(x => x.boat === LIGHTCAT.boat).fresh, false, 'no platform targets for the boat in this input');
});

test('blocks: Options until a day after their valid-till time and Reservations; never Information, cancelled or another yacht', () => {
  assert.deepEqual(nausysBlock(row('1'), LIGHTCAT, NOW), {id: '1', start: '2026-12-01', end: '2026-12-08', type: 'RESERVATION', boat: LIGHTCAT.yacht_id, own: false});
  assert.equal(nausysBlock(row('2', {creator: 'USER DEMO'}), LIGHTCAT, NOW).own, true);
  assert.equal(nausysBlock(row('3', {type: 'OPTION', expiry: '12.10.2026 23:59'}), LIGHTCAT, NOW).type, 'OPTION');
  assert.equal(nausysBlock(row('4', {type: 'OPTION', expiry: '07.10.2026 23:59'}), LIGHTCAT, NOW), null);
  for (const type of ['INFORMATION', 'CANCELED (R)', 'CANCELED (O)']) assert.equal(nausysBlock(row('5', {type}), LIGHTCAT, NOW), null, type);
  assert.equal(nausysBlock(row('6'), AD5, NOW), null);
});

test('the client is the first source by key: Boataround, Click&Boat, SamBoat, MMK, or Direct for dashboard dates', () => {
  assert.deepEqual(nausysClient(['samboat:2', 'boataround:1']), {name: 'Boataround', id: '8000001'});
  assert.deepEqual(nausysClient(['mmk:1']), {name: 'MMK', id: '8000005'});
  assert.deepEqual(nausysClient(['manual-hold:x']), {name: 'Direct', id: '8000004'});
  assert.throws(() => nausysClient(['nausys:1']), /nausys_client_unknown/);
});

test('a write: FREE check, Option form, client by ID, no notification, Save after the evidence, then Make booking', async () => {
  const w = nausys(), adapter = adapterFor(w), events = [];
  const read = await adapter.read(target());
  assert.deepEqual(read.blocks, []);
  const created = await adapter.submit(target(), gap, async evidence => { events.push(['evidence', evidence, w.s.rows.length]); },
    {id: 'a1', causes: ['boataround:7'], guard: async options => { events.push(['guard', options?.beforeFirstWrite === true]); }});
  assert.deepEqual(created, {id: '952831027', start: gap.start, end: gap.end, type: 'RESERVATION', boat: LIGHTCAT.yacht_id, own: true});
  assert.deepEqual(events.map(e => e[0] === 'guard' ? 'guard' + (e[1] ? ' first' : '') : 'evidence ' + e[1].draft_id + ' ' + e[1].client + ' rows=' + e[2]),
    ['guard first', 'guard', 'evidence 952831027 8000001 rows=0', 'guard']);
  assert.deepEqual(w.s.calls.filter(c => !c.startsWith('goto')), ['query 2027-08-21/2027-08-24', 'open option', 'client chooser', 'client 8000001', 'quiet',
    'press Save', 'action makeBookingBtn', 'yes', 'press Back']);
  assert.deepEqual((await adapter.read(target())).blocks, [created]);
});

test('when the form closes after Save, the stored Option is opened by its number and booked (seen 2026-10-10)', async () => {
  const w = nausys({closeOnSave: true}), adapter = adapterFor(w);
  const created = await adapter.submit(target(), gap, async () => {}, {id: 'a1', causes: ['manual-hold:x']});
  assert.equal(created.id, '952831027');
  assert.deepEqual(w.s.rows.map(r => [r.id, r.type]), [['952831027', 'RESERVATION']]);
  assert.deepEqual(w.s.calls.filter(c => /press|open|action|yes|client 8/.test(c)), ['open option', 'client 8000004', 'press Save', 'open 952831027', 'action makeBookingBtn', 'yes', 'press Back']);
});

test('anything before Save sends nothing: dates not free, a missing client or a failed guard', async () => {
  const busy = nausys({free: false});
  await assert.rejects(adapterFor(busy).submit(target(), gap, async () => assert.fail('no evidence'), {id: 'a', causes: ['boataround:1']}),
    e => e.message === 'nausys_dates_not_available' && e.notSubmitted === true);
  const noClient = nausys({clients: [{name: 'Boataround', id: 'other'}]});
  await assert.rejects(adapterFor(noClient).submit(target(), gap, async () => assert.fail('no evidence'), {id: 'a', causes: ['boataround:1']}),
    e => e.message === 'nausys_client_not_found' && e.notSubmitted === true);
  assert.equal(noClient.s.dialog, null, 'the unsaved form is cancelled');
  const stale = nausys(); let calls = 0;
  await assert.rejects(adapterFor(stale).submit(target(), gap, async () => assert.fail('no evidence'), {id: 'a', causes: ['boataround:1'],
    guard: async () => { if (++calls === 2) throw Error('source_changed_or_stale'); }}), e => e.notSubmitted === true);
  assert.equal(stale.s.rows.length, 0); assert.ok(!stale.s.calls.includes('press Save'));
});

test('after Save an unclear result stays uncertain; recover settles it from the list without a second Save', async () => {
  const lost = nausys({saveWorks: false}), adapter = adapterFor(lost);
  let evidence;
  await assert.rejects(adapter.submit(target(), gap, async e => { evidence = e; }, {id: 'a', causes: ['boataround:1']}), e => e.message === 'nausys_write_uncertain' && !e.notSubmitted);
  const ledger = {version: 1, targets: {}, attempts: [{id: 'a', target: 'nausys:' + LIGHTCAT.yacht_id, start: gap.start, end: gap.end, causes: ['boataround:1'], state: 'submitting', response: evidence}]};
  await adapter.recover(target(), ledger, async () => {}, async () => {});
  assert.deepEqual([ledger.attempts[0].state, ledger.attempts[0].reason], ['not_submitted', 'nausys_draft_not_saved']);
  // Saved as an Option but Make booking did not finish: recover books it.
  const half = nausys({bookWorks: false}), second = adapterFor(half);
  let draft;
  await assert.rejects(second.submit(target(), gap, async e => { draft = e; }, {id: 'b', causes: ['boataround:1']}), /nausys_booking_not_confirmed/);
  assert.equal(half.s.rows[0].type, 'OPTION');
  const ledger2 = {version: 1, targets: {}, attempts: [{id: 'b', target: 'nausys:' + LIGHTCAT.yacht_id, start: gap.start, end: gap.end, causes: ['boataround:1'], state: 'submitting', response: draft}]};
  const fixed = nausys({rows: half.s.rows});
  await adapterFor(fixed).recover(target(), ledger2, async () => {}, async () => {});
  assert.equal(fixed.s.rows[0].type, 'RESERVATION');
  assert.deepEqual([ledger2.attempts[0].state, ledger2.attempts[0].created.id], ['pending_readback', '952831027']);
  assert.ok(!fixed.s.calls.includes('press Save'));
  // A record under that number made by someone else, or with other dates, is
  // never adopted: it is left for a person, and only its own dates stay
  // uncertain; the yacht's other work goes on (review 2026-10-10).
  const pending = () => ({version: 1, targets: {}, attempts: [{id: 'c', target: 'nausys:' + LIGHTCAT.yacht_id, start: gap.start, end: gap.end, causes: ['boataround:1'], state: 'submitting', response: {draft_id: '952831027'}}]});
  for (const change of [{creator: 'DEMO COLLEAGUE'}, {to: '25.08.2027'}]) {
    const other = nausys({rows: [row('952831027', {from: '21.08.2027', to: '24.08.2027', creator: 'USER DEMO', ...change})]});
    const l = pending();
    await adapterFor(other).recover(target(), l, async () => {}, async () => {});
    assert.deepEqual([l.attempts[0].state, l.attempts[0].created, l.attempts[0].review_reason], ['submitting', undefined, 'nausys_partial_write_requires_review'], JSON.stringify(change));
    assert.ok(!other.s.calls.some(c => /press|action|yes/.test(c)), JSON.stringify(change));
  }
  // Our own draft that was cancelled, or an Option a full day past its valid-till,
  // closes nothing any more: the dates are written again.
  for (const change of [{type: 'CANCELED (R)'}, {type: 'OPTION', expiry: '08.10.2026 12:00'}]) {
    const gone = nausys({rows: [row('952831027', {from: '21.08.2027', to: '24.08.2027', creator: 'USER DEMO', ...change})]});
    const l = pending();
    await adapterFor(gone).recover(target(), l, async () => {}, async () => {});
    assert.deepEqual([l.attempts[0].state, l.attempts[0].reason], ['not_submitted', 'nausys_draft_cancelled_or_expired'], JSON.stringify(change));
    assert.ok(!gone.s.calls.some(c => /press|action|yes/.test(c)));
  }
});

test('an agency Option stops counting as closing its dates a day before its valid-till (review 2026-10-10)', () => {
  const option = expiry => nausysBlock(row('1', {type: 'OPTION', expiry, creator: 'Agency'}), LIGHTCAT, NOW);
  assert.ok(option('11.10.2026 23:59'), 'two days left');
  assert.equal(option('10.10.2026 21:00'), null, 'less than a day left');
  assert.equal(option('09.10.2026 12:00'), null, 'already past');
  assert.ok(nausysBlock(row('2'), LIGHTCAT, NOW), 'a Reservation always counts');
});

test('release cancels only an unchanged own Reservation, after the final guard', async () => {
  const own = row('952831027', {creator: 'USER DEMO', from: '21.08.2027', to: '24.08.2027'});
  const w = nausys({rows: [own, row('952517775', {from: '01.09.2027', to: '08.09.2027'})]}), adapter = adapterFor(w);
  const owned = (await adapter.read(target())).blocks.find(b => b.id === '952831027');
  const order = [];
  await adapter.remove(target(), owned, {guard: async () => order.push('guard')});
  assert.deepEqual(w.s.rows.map(r => [r.id, r.type]), [['952831027', 'CANCELED (R)'], ['952517775', 'RESERVATION']]);
  assert.deepEqual(w.s.calls.filter(c => /open|action|yes/.test(c)), ['open 952831027', 'action stornoBtn', 'yes']);
  assert.deepEqual(order, ['guard']);
  // A colleague who put a real guest on our reservation keeps it (review 2026-10-10).
  const guest = nausys({rows: [own], viewClient: 'JOHN SMITH '});
  await assert.rejects(adapterFor(guest).remove(target(), owned, {guard: async () => {}}), e => e.message === 'nausys_owned_record_changed' && e.notSubmitted === true);
  assert.ok(!guest.s.calls.some(c => c.startsWith('action')));
  for (const name of ['MMK⁣', 'Click&Boat ', 'DIRECT']) {
    const ok = nausys({rows: [own], viewClient: name.toUpperCase()});
    await adapterFor(ok).remove(target(), owned, {guard: async () => {}});
    assert.ok(ok.s.calls.includes('action stornoBtn'), name);
  }
  for (const change of [{to: '25.08.2027'}, {creator: 'DEMO COLLEAGUE'}]) {
    const changed = nausys({rows: [{...own, ...change}]});
    await assert.rejects(adapterFor(changed).remove(target(), owned, {guard: async () => {}}), e => e.message === 'nausys_owned_record_changed' && e.notSubmitted === true);
    assert.ok(!changed.s.calls.some(c => c.startsWith('action')));
  }
});

test('with the executor: a needed stay is written once, colleagues\' copies cover dates and are never cancelled', async () => {
  const copy = row('952517754', {from: '01.12.2026', to: '08.12.2026'});
  const w = nausys({rows: [copy]});
  const segments = [{start: '2026-12-01', end: '2026-12-08', causes: ['boataround:1']}, {start: '2027-08-21', end: '2027-08-24', causes: ['clickandboat:2']}];
  const t = {...target(LIGHTCAT, segments), fresh: true, release_proof: {ready: true, checked_at: stamp, orders: [{key: 'boataround:1', state: 'active', start: '2026-12-01', end: '2026-12-08'}, {key: 'clickandboat:2', state: 'active', ...gap}]}};
  let state = {version: 1, attempts: [], targets: {}};
  const run = () => new ReverseExecutor({now: () => NOW, load: async () => structuredClone(state), save: async v => { state = structuredClone(v); },
    plan: async () => ({generated_at: stamp, targets: [structuredClone(t)]}), adapters: {nausys: adapterFor(w)}}).run();
  await run();
  assert.equal(state.targets['nausys:' + LIGHTCAT.yacht_id].state, 'protected');
  assert.deepEqual(w.s.rows.map(r => [r.id, r.type, r.creator]), [['952517754', 'RESERVATION', 'DEMO COLLEAGUE'], ['952831027', 'RESERVATION', 'USER DEMO']]);
  assert.deepEqual(state.attempts.map(a => [a.state, a.start, a.end, a.created.id]), [['confirmed', '2027-08-21', '2027-08-24', '952831027']]);
  await run();
  assert.equal(w.s.calls.filter(c => c === 'press Save').length, 1, 'a second run writes nothing');
  // The order is cancelled: only the program's record is cancelled.
  t.segments = [segments[0]]; t.release_proof.orders[1] = {key: 'clickandboat:2', state: 'cancelled'};
  await run();
  assert.deepEqual(w.s.rows.map(r => [r.id, r.type]), [['952517754', 'RESERVATION'], ['952831027', 'CANCELED (R)']]);
  assert.equal(state.attempts[0].state, 'released'); assert.equal(state.targets['nausys:' + LIGHTCAT.yacht_id].state, 'protected');
  // Cancelling the other order too never touches the colleague's copy.
  t.segments = []; t.release_proof.orders[0] = {key: 'boataround:1', state: 'cancelled'};
  await run();
  assert.equal(w.s.rows[0].type, 'RESERVATION');
});
