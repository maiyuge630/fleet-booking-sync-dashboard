import {FLEET, dateRange, BOATAROUND_PAYMENT_STATES} from '../parsers.mjs';

export const TARGETS = ['boataround','clickandboat','samboat'];
// Order sources. MMK joined on 2026-10-04 and NauSYS on 2026-10-09 (user
// decisions); MMK's calendar targets are planned separately in mmk-plan.mjs.
export const SOURCES = [...TARGETS,'mmk','nausys'];
const ACTIVE = new Set(['accepted','paid','deposit_paid']);
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
// How long after a complete collection its orders count as fresh. 10 minutes
// until 2026-09-29; the user widened it to 20 when Click&Boat calendar work
// moved to the slower official app and a run no longer fitted in 10.
export const SOURCE_FRESH_MS = 20 * 60000;
const sourceFresh=(state,now)=>state?.mode==='dynamic'&&!state.last_error&&Number.isFinite(stamp(state.last_success_at))&&stamp(state.last_success_at)<=now+60000&&now-stamp(state.last_success_at)<=SOURCE_FRESH_MS;
// MMK and NauSYS end an Option either by cancelling it or by letting it expire.
const cancelledLabel=(value,source)=>typeof value==='string'&&['CANCELLED','CANCELED',...(['mmk','nausys'].includes(source)?['OPTION EXPIRED']:[])].includes(value.trim().replace(/\s+/g,' ').toUpperCase());
export const RULE_VERSION = 2;
// Orders retain their original checkout date; protection includes that whole
// date and uses the following UTC midnight as its exclusive endpoint.
const protectionEnd=end=>new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString().slice(0,10);
// A failed Click&Boat read only relabels the authorized reschedule as
// source_sync_failed; nothing was observed. Keep protecting it as a stale
// Click&Boat order when its last observation fully matched the authorization,
// so one failed source cannot stop the whole boat. Any other review reason,
// or a last observation that disagreed, still excludes it.
function staleButVerifiedReschedule(m,record){
  if(m.verification_status!=='needs_review'||m.review_reason!=='source_sync_failed'||m.cancelled_at||!Number.isFinite(stamp(m.last_verified_at)))return false;
  const label=typeof m.platform_status==='string'?m.platform_status.trim().replace(/\s+/g,' ').toUpperCase():'';
  const dates=m.platform_start===record.start&&m.platform_end===record.end||m.platform_start===m.original_start&&m.platform_end===m.original_end;
  return label==='ACCEPTED'&&m.platform_boat===record.boataround_slug&&dates;
}

/** Only consume the server's validated registry, never client-submitted orders. */
export function registryCauses(mapping, status, now = Date.now()) {
  const causes = [], excluded = [], seen = new Set();
  for (const source of SOURCES) {
    if (!Array.isArray(mapping?.[source])) throw new Error('reverse_registry_unavailable');
    for (const record of mapping[source]) {
      const key = source + ':' + record.booking_id;
      if (seen.has(key)) throw new Error('reverse_duplicate_identity');
      seen.add(key);
      if(['cancelled','canceled'].includes(record.status)&&record.platform_status&&!cancelledLabel(record.platform_status,source)){
        excluded.push({key,boat:record.boataround_slug,reason:'cancellation_conflict'});continue;
      }
      if (!ACTIVE.has(record.status)) continue;
      const boat = record.boataround_slug;
      let reason = null;
      if (!/^\d+$/.test(String(record.booking_id)) || !FLEET.some(item => item.slug === boat)) reason = 'mapping_unknown';
      try {
        // A genuine SamBoat day trip has equal source dates. Validate its one
        // occupied day without changing the stored checkout or relaxing the
        // half-open interval rules used by writes and release proofs.
        dateRange(record.start, source === 'samboat' && record.start === record.end
          ? protectionEnd(record.end) : record.end);
        // Past accepted history is irrelevant to future protection. Legacy
        // historical records may predate the payment gate and must not raise
        // a misleading "current order unverified" warning.
        if (record.end < new Date(now + 8*3600000).toISOString().slice(0,10)) continue;
      } catch { reason = 'invalid_dates'; }
      if (record.manual_adjustment) {
        const m = record.manual_adjustment;
        if (m.kind !== 'reschedule' || m.verification_status !== 'verified' && !staleButVerifiedReschedule(m,record) || m.cancelled_at ||
            m.payment_evidence?.kind !== 'owner_settlement' || !Number.isFinite(m.payment_evidence.amount) || m.payment_evidence.amount <= 0) reason = 'payment_or_adjustment_unverified';
      } else if (source === 'clickandboat') {
        const paid=record.customer_payment_verified === true && Number.isFinite(record.customer_paid_amount) && record.customer_paid_amount > 0;
        const appAccepted=record.payment_basis === 'platform_accepted' && record.platform_status?.trim().toUpperCase() === 'ACCEPTED';
        if (record.status !== 'accepted' || !(paid || appAccepted)) reason = 'payment_unverified';
      } else if (source === 'boataround') {
        const platformState=record.platform_status?.trim().toUpperCase();
        const payment=record.customer_payment?.trim().toUpperCase();
        const required=record.status==='paid'?'PAID':record.status==='deposit_paid'?'PARTIALLY PAID':null;
        // Legacy CONFIRMED records were already validated by the previous
        // registry. Newly supported workflow states require retained evidence.
        if (!required || !BOATAROUND_PAYMENT_STATES.includes(platformState) ||
            (payment!==required && !(platformState==='CONFIRMED'&&record.customer_payment===undefined))) reason='payment_unverified';
      } else if (source === 'mmk') {
        // User decision 2026-10-04: a Reservation or Option with a customer
        // counts, without payment. Anything else fails closed.
        const label=record.platform_status?.trim().toUpperCase();
        if (record.status !== 'accepted' || record.payment_basis !== 'mmk_client_assigned' || !['RESERVATION','OPTION'].includes(label)) reason = 'payment_unverified';
      } else if (source === 'nausys') {
        // User decision 2026-10-09: an agency's Reservation or Option counts
        // without payment. Anything else fails closed.
        const label=record.platform_status?.trim().toUpperCase();
        if (record.status !== 'accepted' || record.payment_basis !== 'nausys_agency' || !['RESERVATION','OPTION'].includes(label)) reason = 'payment_unverified';
      } else {
        const label=record.platform_status?.trim().toUpperCase();
        if (!(record.status==='paid' && label==='PAID' || record.status==='deposit_paid' &&
          ['DEPOSIT PAID','VALIDATED / DEPOSIT PAID','DEPOSIT_PAID','DEPOSIT PAID ONLY','VALIDATED/DEPOSIT PAID'].includes(label))) reason = 'payment_unverified';
      }
      if (reason) { excluded.push({key,boat,reason}); continue; }
      const state = status?.platforms?.[source];
      const recordTime=stamp(record.verified_at),sourceTime=stamp(state?.last_success_at);
      const checked = Math.min(recordTime, sourceTime);
      causes.push({key,source,boat,start:record.start,end:protectionEnd(record.end),
        ...(record.manual_adjustment?{manual_reschedule:true}:{}),
        ...(source==='boataround'&&record.platform_status?.trim().toUpperCase()!=='CONFIRMED'?{verify_whole_source_stay:true}:{}),
        verified_at: Number.isFinite(checked) ? new Date(checked).toISOString() : null,
        fresh: state?.mode === 'dynamic' && !state.last_error && Number.isFinite(checked) &&
          recordTime <= now + 60000 && sourceTime <= now + 60000 && now - checked <= SOURCE_FRESH_MS});
    }
  }
  return {causes:causes.sort((a,b)=>a.key.localeCompare(b.key)),excluded};
}

/** Sweep endpoints, preserving the exact cause set for every half-open segment. */
export function segments(causes) {
  const endpoints = [...new Set(causes.flatMap(c=>[c.start,c.end]))].sort();
  const result = [];
  for (let i=0;i<endpoints.length-1;i++) {
    const start=endpoints[i],end=endpoints[i+1];
    const keys=causes.filter(c=>c.start<=start && c.end>=end).map(c=>c.key).sort();
    if (keys.length) result.push({start,end,causes:keys});
  }
  return result;
}

export function buildPlan(mapping,status,{now=Date.now(),mappings={}}={}) {
  const {causes,excluded}=registryCauses(mapping,status,now);
  // Close-only (user decision, 2026-09-29): when a source fails after an earlier
  // complete snapshot, its last complete orders stay protected and the fresh
  // sources may still add closures. Opening any date keeps requiring every
  // source to be fresh (see release_proof.ready and releaseAllowed).
  const staleSources=SOURCES.filter(s=>!sourceFresh(status?.platforms?.[s],now));
  const everyBaseline=SOURCES.every(s=>{const state=status?.platforms?.[s],t=stamp(state?.last_success_at);return state?.mode==='dynamic'&&Number.isFinite(t)&&t<=now+60000;});
  const targets=FLEET.flatMap(boat=>TARGETS.map(target=>{
    const key=boat.slug+':'+target, configured=mappings[key];
    const listingId=target==='boataround'?(boat.boataround===false?null:boat.slug):boat[target+'_id'];
    // Other platforms need the whole stay. On the booking's own platform,
    // verify the checkout day as well: native bookings can free it for turnover.
    // Paid requests still being processed may not yet have a native booking
    // block. Read back their entire stay on the source platform as well.
    const applicable=causes.filter(c=>c.boat===boat.slug).map(c=>c.source!==target||c.manual_reschedule||c.verify_whole_source_stay?c:{...c,start:new Date(Date.parse(c.end+'T00:00:00Z')-86400000).toISOString().slice(0,10)});
    const boatExcluded=excluded.some(e=>!e.boat||e.boat===boat.slug);
    const fresh=staleSources.length===0&&applicable.every(c=>c.fresh)&&!boatExcluded;
    const closeReady=!fresh&&everyBaseline&&staleSources.length<SOURCES.length&&!boatExcluded&&
      applicable.every(c=>c.fresh||staleSources.includes(c.source));
    return {key,boat:boat.slug,target,listing_id:listingId,
      release_proof:{checked_at:new Date(now).toISOString(),
        ready:SOURCES.every(s=>sourceFresh(status?.platforms?.[s],now))&&!excluded.some(e=>!e.boat||e.boat===boat.slug),
        orders:SOURCES.flatMap(s=>(mapping[s]||[]).filter(r=>r.boataround_slug===boat.slug).flatMap(r=>{
          const key=s+':'+r.booking_id,active=causes.find(c=>c.key===key);
          if(active?.fresh)return [{key,state:'active',start:active.start,end:active.end}];
          const ts=stamp(r.verified_at);
          const cancelled=r.manual_adjustment
            ?r.manual_adjustment.kind==='reschedule'&&r.manual_adjustment.verification_status==='cancelled'&&Number.isFinite(stamp(r.manual_adjustment.cancelled_at))&&cancelledLabel(r.manual_adjustment.platform_status)
            :cancelledLabel(r.platform_status,s);
          if(['cancelled','canceled'].includes(r.status)&&cancelled&&sourceFresh(status?.platforms?.[s],now)&&Number.isFinite(ts)&&ts<=now+60000&&now-ts<=SOURCE_FRESH_MS)return [{key,state:'cancelled'}];
          return [];
        }))},
      mapping_state:configured?.state==='verified'&&configured.listing_id===listingId?'verified':'unverified',
      segments:segments(applicable),source_count:applicable.length,
      fresh,close_ready:closeReady,stale_sources:fresh?[]:[...staleSources],
      source_healthy:SOURCES.every(s=>status?.platforms?.[s]?.mode==='dynamic'&&!status.platforms[s].last_error)&&!excluded.some(e=>!e.boat||e.boat===boat.slug),
      status:!listingId?'mapping_unknown':applicable.length?'preview':'no_external_orders'};
  }));
  // Evidence times and freshness deliberately do not change semantic revision.
  const semantic={rule_version:RULE_VERSION,targets:targets.map(({key,listing_id,mapping_state,segments})=>({key,listing_id,mapping_state,segments}))};
  return {rule_version:RULE_VERSION,generated_at:new Date(now).toISOString(),targets,excluded,causes,semantic};
}

/** Subtract any observed protection, without acquiring ownership of it. */
export function uncovered(required, existing) {
  let pieces=[{start:required.start,end:required.end}];
  for (const block of existing) {
    dateRange(block.start,block.end);
    pieces=pieces.flatMap(p=>block.end<=p.start||block.start>=p.end?[p]:[
      ...(p.start<block.start?[{start:p.start,end:block.start}]:[]),
      ...(p.end>block.end?[{start:block.end,end:p.end}]:[])]);
  }
  return pieces;
}
