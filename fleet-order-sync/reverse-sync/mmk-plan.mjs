import {segments} from './planner.mjs';

// Verified in the owner's desktop and Android sessions on 2026-09-13.
export const MMK_FLEET = Object.freeze([
  {boat:'reef-cat-37-tidewyn-discovery',listing_id:'1000000000000000001',name:'Tidewyn Discovery'},
  {boat:'seacat-open-40-tidewyn-discovery-2',listing_id:'1000000000000000002',name:'Tidewyn Discovery 2'},
  {boat:'grandcat-55-tidewyn-discovery-5',listing_id:'1000000000000000003',name:'Tidewyn Discovery 5'},
]);

const shift=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
// User decision 2026-10-09 (AGENTS.md 7.7): MMK closes the nights an order
// occupies (boarding 14:00, return 10:00), not the checkout day the day-based
// platforms close, so a turnover day stays bookable. Registry orders end at
// checkout+1; drop that day. A day trip keeps its one night. Dashboard
// unavailable dates (manual-hold:, added later by applyFleetHolds) are nights already.
export const mmkNights=range=>{
  // Malformed dates pass through unchanged; the planner and executor reject them.
  if(![range?.start,range?.end].every(d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))))return range;
  const end=shift(range.end,-1);
  return {...range,end:end>range.start?end:shift(range.start,1)};
};

/** Reuse the validated registry, converted to nights. */
export function mmkPlan(plan) {
  if(plan?.rule_version!==2||!Array.isArray(plan.targets))throw Error('mmk_source_plan_invalid');
  const targets=MMK_FLEET.map(mapping=>{
    const sources=plan.targets.filter(t=>t.boat===mapping.boat&&['boataround','clickandboat','samboat'].includes(t.target));
    const reference=sources.find(t=>t.target==='boataround');
    const proof=reference?.release_proof;
    // An MMK order (source since 2026-10-04) is itself the booking on MMK's
    // calendar; it only closes the other platforms. Writing a block over it
    // would overlap that native reservation and stop this yacht's MMK sync.
    const causes=(Array.isArray(plan.causes)?plan.causes.filter(c=>c.boat===mapping.boat):
      (proof?.orders||[]).filter(o=>o.state==='active').map(o=>({...o,boat:mapping.boat,fresh:proof.ready===true})))
      .filter(c=>!String(c.key).startsWith('mmk:')).map(mmkNights);
    const complete=['boataround','clickandboat','samboat'].every(s=>sources.filter(t=>t.target===s).length===1);
    const fresh=complete&&(Array.isArray(plan.causes)||Array.isArray(proof?.orders))&&sources.every(t=>t.fresh===true)&&causes.every(c=>c.fresh===true);
    const staleSources=[...new Set(sources.flatMap(t=>Array.isArray(t.stale_sources)?t.stale_sources:[]))].sort();
    // Close-only needs the server's full cause list; legacy proof-only input never qualifies.
    const closeReady=!fresh&&complete&&Array.isArray(plan.causes)&&sources.every(t=>t.fresh===true||t.close_ready===true)&&
      causes.every(c=>c.fresh===true||staleSources.includes(c.source));
    return {...mapping,key:mapping.boat+':mmk',target:'mmk',
      fresh,close_ready:closeReady,stale_sources:fresh?[]:staleSources,
      source_healthy:sources.every(t=>t.source_healthy!==false),source_count:causes.length,
      mapping_state:'verified',status:causes.length?'preview':'no_external_orders',
      segments:segments(causes),
      // Release checks compare these orders with MMK records, so they are nights too.
      release_proof:proof&&{...proof,orders:Array.isArray(proof.orders)?proof.orders.map(o=>o?.state==='active'?mmkNights(o):o):proof.orders}};
  });
  return {rule_version:2,generated_at:plan.generated_at,targets};
}
