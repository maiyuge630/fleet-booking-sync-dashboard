import {segments} from './planner.mjs';
import {mmkNights} from './mmk-plan.mjs';

// NauSYS yacht IDs from the business knowledge base (log 338), checked against
// NauSYS's own pages on 2026-10-09 (calendar rows y-<id>-000000 and the
// reservation list's names). The Lightcat is the dashboard's eighth boat since
// 2026-10-09 (user decision); NauSYS lists it for internal use only.
export const NAUSYS_FLEET = Object.freeze([
  {yacht_id: '70000001', model: 'R-Cat 37', name: 'Tidewyn Discovery', boat: 'reef-cat-37-tidewyn-discovery'},
  {yacht_id: '70000002', model: 'Seacat 40 Open - 4 + 1 cab.', name: 'Tidewyn Discovery 2', boat: 'seacat-open-40-tidewyn-discovery-2'},
  {yacht_id: '70000003', model: 'Grandcat 55', name: 'Tidewyn Discovery 5', boat: 'grandcat-55-tidewyn-discovery-5'},
  {yacht_id: '70000004', model: 'Lightcat 400 S2', name: 'Tidewyn Discovery 6', boat: 'lightcat-400-s2-tidewyn-discovery-6'}
]);

/** NauSYS calendar targets (user decision 2026-10-09, AGENTS.md 6.4, 7.7).
 * Like MMK: the nights other platforms' orders occupy (boarding 16:00 by
 * NauSYS's default, return 10:00). A NauSYS order itself is already on
 * NauSYS's calendar, so it is never written there again. */
export function nausysPlan(plan) {
  if(plan?.rule_version!==2||!Array.isArray(plan.targets))throw Error('nausys_source_plan_invalid');
  const targets=NAUSYS_FLEET.map(({yacht_id,boat,name})=>{
    const sources=plan.targets.filter(t=>t.boat===boat&&['boataround','clickandboat','samboat'].includes(t.target));
    const reference=sources.find(t=>t.target==='boataround');
    const proof=reference?.release_proof;
    const causes=(Array.isArray(plan.causes)?plan.causes.filter(c=>c.boat===boat):
      (proof?.orders||[]).filter(o=>o.state==='active').map(o=>({...o,boat,fresh:proof.ready===true})))
      .filter(c=>!String(c.key).startsWith('nausys:')).map(mmkNights);
    const complete=['boataround','clickandboat','samboat'].every(s=>sources.filter(t=>t.target===s).length===1);
    const fresh=complete&&(Array.isArray(plan.causes)||Array.isArray(proof?.orders))&&sources.every(t=>t.fresh===true)&&causes.every(c=>c.fresh===true);
    const staleSources=[...new Set(sources.flatMap(t=>Array.isArray(t.stale_sources)?t.stale_sources:[]))].sort();
    const closeReady=!fresh&&complete&&Array.isArray(plan.causes)&&sources.every(t=>t.fresh===true||t.close_ready===true)&&
      causes.every(c=>c.fresh===true||staleSources.includes(c.source));
    return {boat,listing_id:yacht_id,name,key:boat+':nausys',target:'nausys',
      fresh,close_ready:closeReady,stale_sources:fresh?[]:staleSources,
      source_healthy:sources.every(t=>t.source_healthy!==false),source_count:causes.length,
      mapping_state:'verified',status:causes.length?'preview':'no_external_orders',
      segments:segments(causes),
      release_proof:proof&&{...proof,orders:Array.isArray(proof.orders)?proof.orders.map(o=>o?.state==='active'?mmkNights(o):o):proof.orders}};
  });
  return {rule_version:2,generated_at:plan.generated_at,targets};
}
