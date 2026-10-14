// Close-only calendar sync (user decision 2026-09-29): a failed source must not
// stop other platforms from adding protection, and must never allow opening.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from './planner.mjs';
import {mmkPlan} from './mmk-plan.mjs';
import {currentTarget} from './release.mjs';
import {ReverseExecutor} from './executor.mjs';
import {ReverseSync} from './store.mjs';
import {FLEET} from '../parsers.mjs';

const now=Date.parse('2026-09-29T02:00:00Z'),iso=v=>new Date(v).toISOString();
const SOURCES=['boataround','clickandboat','samboat','mmk','nausys'],boat=FLEET[1].slug;
const status=(overrides={})=>({platforms:Object.fromEntries(SOURCES.map(s=>[s,{mode:'dynamic',last_error:null,last_success_at:iso(now),...overrides[s]}]))});
const cbFailing={clickandboat:{last_error:'challenge_required',last_success_at:iso(now-6*3600000)}};
const ba=(id,start,end,verified=now)=>({booking_id:id,boataround_slug:boat,start,end,status:'paid',platform_status:'CONFIRMED',customer_payment:'PAID',verified_at:iso(verified)});
const cb=(id,start,end,verified=now)=>({booking_id:id,boataround_slug:boat,start,end,status:'accepted',customer_payment_verified:true,customer_paid_amount:500,verified_at:iso(verified)});
const mapping=()=>({boataround:[ba('1','2026-12-01','2026-12-05')],clickandboat:[cb('2','2027-01-10','2027-01-12',now-6*3600000)],samboat:[],mmk:[],nausys:[]});

test('a fully fresh plan is unchanged: fresh, not close-only, nothing stale',()=>{
  for(const t of buildPlan({boataround:[ba('1','2026-12-01','2026-12-05')],clickandboat:[],samboat:[],mmk:[],nausys:[]},status(),{now}).targets){
    assert.equal(t.fresh,true);assert.equal(t.close_ready,false);assert.deepEqual(t.stale_sources,[]);
  }
});

test('a source failing after a complete snapshot allows close-only with its last orders, never release',()=>{
  const plan=buildPlan(mapping(),status(cbFailing),{now});
  const t=plan.targets.find(x=>x.target==='samboat'&&x.boat===boat);
  assert.equal(t.fresh,false);assert.equal(t.close_ready,true);assert.deepEqual(t.stale_sources,['clickandboat']);
  assert.equal(t.release_proof.ready,false);
  assert.deepEqual(t.segments.map(s=>[s.start,s.end,s.causes]),[['2026-12-01','2026-12-06',['boataround:1']],['2027-01-10','2027-01-13',['clickandboat:2']]]);
});

test('close-only is refused with no fresh source, no complete baseline, or unverified records',()=>{
  const base={boataround:[ba('1','2026-12-01','2026-12-05')],clickandboat:[],samboat:[],mmk:[],nausys:[]};
  const allFailing=status(Object.fromEntries(SOURCES.map(s=>[s,{last_error:'fetch_failed',last_success_at:iso(now-3600000)}])));
  const neverSucceeded=status({clickandboat:{last_error:'challenge_required',last_success_at:null}});
  for(const s of [allFailing,neverSucceeded])for(const t of buildPlan(base,s,{now}).targets){assert.equal(t.fresh,false);assert.equal(t.close_ready,false);}
  const unpaid={...base,boataround:[{...ba('1','2026-12-01','2026-12-05'),customer_payment:'UNPAID'}]};
  for(const t of buildPlan(unpaid,status(cbFailing),{now}).targets.filter(t=>t.boat===boat))assert.equal(t.close_ready,false);
  // A fresh source whose record evidence is itself old cannot be trusted either.
  const oldEvidence={...base,boataround:[ba('1','2026-12-01','2026-12-05',now-3600000)]};
  for(const t of buildPlan(oldEvidence,status(cbFailing),{now}).targets.filter(t=>t.boat===boat))assert.equal(t.close_ready,false);
});

test('an authorized reschedule relabelled only by a failed Click&Boat read stays protected as a stale order',()=>{
  const old=now-6*3600000;
  const reschedule=(adjust={})=>({booking_id:'1000000',boataround_slug:boat,start:'2027-03-06',end:'2027-03-13',status:'accepted',verified_at:iso(old),
    manual_adjustment:{kind:'reschedule',original_start:'2027-03-01',original_end:'2027-03-08',recorded_at:iso(old-86400000),
      verification_status:'needs_review',review_reason:'source_sync_failed',last_verified_at:iso(old),platform_status:'Accepted',
      platform_start:'2027-03-06',platform_end:'2027-03-13',platform_boat:boat,cancelled_at:null,
      payment_evidence:{kind:'owner_settlement',amount:4200},...adjust}});
  const plan=m=>buildPlan({boataround:[ba('1','2026-12-01','2026-12-05')],clickandboat:[m],samboat:[],mmk:[],nausys:[]},status(cbFailing),{now});
  const kept=plan(reschedule());
  assert.deepEqual(kept.excluded,[]);
  for(const t of kept.targets.filter(t=>t.boat===boat)){
    assert.equal(t.close_ready,true);assert.ok(t.segments.some(s=>s.causes.includes('clickandboat:1000000')));
  }
  // The original dates also match the authorization; a later platform change does not.
  assert.deepEqual(plan(reschedule({platform_start:'2027-03-01',platform_end:'2027-03-08'})).excluded,[]);
  for(const adjust of [{review_reason:'observation_missing'},{review_reason:'platform_dates_changed'},{platform_start:'2027-03-07'},
    {platform_status:'Pending'},{platform_boat:FLEET[2].slug},{last_verified_at:null},{verification_status:'awaiting_observation',review_reason:null}]){
    const p=plan(reschedule(adjust));
    assert.deepEqual(p.excluded.map(e=>e.reason),['payment_or_adjustment_unverified'],JSON.stringify(adjust));
    for(const t of p.targets.filter(t=>t.boat===boat))assert.equal(t.close_ready,false);
  }
});

test('MMK inherits close-only from its three source targets, never from legacy proof-only input',()=>{
  const base=buildPlan(mapping(),status(cbFailing),{now});
  const mmk=mmkPlan(base).targets.find(t=>t.boat===boat);
  assert.equal(mmk.fresh,false);assert.equal(mmk.close_ready,true);assert.deepEqual(mmk.stale_sources,['clickandboat']);
  const legacy=mmkPlan({rule_version:2,generated_at:base.generated_at,targets:base.targets}).targets.find(t=>t.boat===boat);
  assert.equal(legacy.close_ready,false);
  const fresh=mmkPlan(buildPlan({boataround:[ba('1','2026-12-01','2026-12-05')],clickandboat:[],samboat:[],mmk:[],nausys:[]},status(),{now})).targets.find(t=>t.boat===boat);
  assert.equal(fresh.fresh,true);assert.equal(fresh.close_ready,false);assert.deepEqual(fresh.stale_sources,[]);
});

test('only an explicit close-only check accepts a close_ready plan',()=>{
  const plan={generated_at:iso(now),targets:[{target:'samboat',boat,listing_id:'200002',fresh:false,close_ready:true,segments:[]}]};
  const target=structuredClone(plan.targets[0]);
  assert.throws(()=>currentTarget(plan,target,now),/source_changed_or_stale/);
  assert.equal(currentTarget(plan,target,now,{closeOnly:true}).listing_id,'200002');
  plan.targets[0].close_ready=false;
  assert.throws(()=>currentTarget(plan,target,now,{closeOnly:true}),/source_changed_or_stale/);
});

function executor({blocks=[],ledger=null,segments=[{start:'2026-12-12',end:'2026-12-19',causes:['boataround:1']}],closeReady=true}={}){
  let state=ledger,writes=0,removes=0,recoverOptions=null;
  const target={target:'samboat',boat,listing_id:'200002',fresh:false,close_ready:closeReady,stale_sources:['clickandboat'],segments};
  const adapter={async read(){return {complete:true,identity_verified:true,blocks:structuredClone(blocks)};},async prepare(){},
    async submit(t,gap){writes++;const created={...gap,id:'w'+writes};blocks.push(created);return created;},
    async remove(){removes++;},async recover(t,l,guard,save,options){recoverOptions=options;},async close(){}};
  const options={now:()=>now,load:async()=>structuredClone(state),save:async v=>{state=structuredClone(v);},
    plan:async()=>({generated_at:iso(now),targets:[structuredClone(target)]}),adapters:{samboat:adapter}};
  return {target,adapter,run:()=>new ReverseExecutor(options).run(),state:()=>state,writes:()=>writes,removes:()=>removes,recoverOptions:()=>recoverOptions};
}

test('close-only adds missing protection and reports a partial receipt naming the stale source',async()=>{
  const x=executor();await x.run();
  assert.equal(x.writes(),1);assert.equal(x.state().attempts[0].state,'confirmed');
  const r=x.state().targets['samboat:200002'];
  assert.equal(r.state,'protected_partial');assert.deepEqual(r.stale_sources,['clickandboat']);
  assert.deepEqual(r.retained,[]);assert.equal(r.retained_ranges,undefined);
  assert.deepEqual(x.recoverOptions(),{closeOnly:true});
});

test('close-only never releases an owned protection that is no longer needed',async()=>{
  const owned={id:'x1',start:'2027-02-01',end:'2027-02-03'};
  const ledger={version:1,targets:{},attempts:[{id:'a1',target:'samboat:200002',start:owned.start,end:owned.end,causes:['clickandboat:9'],before:[],state:'confirmed',created:owned}]};
  const x=executor({blocks:[owned],ledger,segments:[]});await x.run();
  assert.equal(x.removes(),0);assert.equal(x.writes(),0);
  assert.equal(x.state().attempts[0].state,'confirmed');assert.equal(x.state().targets['samboat:200002'].state,'protected_partial');
});

test('without close_ready nothing is read or written, as before',async()=>{
  const x=executor({closeReady:false});await x.run();
  assert.equal(x.writes(),0);const r=x.state().targets['samboat:200002'];
  assert.equal(r.state,'needs_review');assert.equal(r.error,'source_changed_or_stale');
});

test('losing close_ready between preparation and submission prevents the write',async()=>{
  const x=executor();x.adapter.prepare=async()=>{x.target.close_ready=false;};await x.run();
  assert.equal(x.writes(),0);assert.equal(x.state().targets['samboat:200002'].state,'needs_review');
});

class Storage{data=new Map();async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async transaction(fn){return fn(this);}}
function engine(){
  let platforms=status(cbFailing);const storage=new Storage(),map=mapping();
  const sync=new ReverseSync({storage,registry:async()=>map,registryStatus:async()=>platforms,now:()=>now});
  return {sync,setStatus:s=>{platforms=s;}};
}
const receipt=(t,fields={})=>({mode:'guarded_release',targets:[{key:t.key,state:'protected_partial',checked_at:iso(now),segments:t.segments,blocked:[],retained:[],
  fleet_hold_revision:t.fleet_hold_control.revision,...(t.target==='boataround'?{boataround_control_revision:t.boataround_control.revision}:{}),...fields}]});

test('the dashboard keeps a partial receipt only while close-only still applies',async()=>{
  const f=engine(),t=(await f.sync.machinePlan()).targets.find(x=>x.target==='samboat'&&x.boat===boat);
  assert.equal(t.close_ready,true);
  await f.sync.report(receipt(t,{stale_sources:['samboat']}));
  let e=(await f.sync.preview()).targets.find(x=>x.key===t.key).execution;
  // The stale source list comes from the server plan, not the phone's claim.
  assert.equal(e.state,'protected_partial');assert.deepEqual(e.stale_sources,['clickandboat']);assert.equal(e.stale,false);
  f.setStatus(status(Object.fromEntries(SOURCES.map(s=>[s,{last_error:'fetch_failed',last_success_at:iso(now-3600000)}]))));
  e=(await f.sync.preview()).targets.find(x=>x.key===t.key).execution;
  assert.equal(e.state,'stale');assert.equal(e.error,'source_changed_or_stale');
});

test('a full "protected" receipt is still refused while a source is failing, and partial receipts cannot carry openings',async()=>{
  const f=engine(),t=(await f.sync.machinePlan()).targets.find(x=>x.target==='samboat'&&x.boat===boat);
  await f.sync.report(receipt(t,{state:'protected'}));
  const e=(await f.sync.preview()).targets.find(x=>x.key===t.key).execution;
  assert.notEqual(e.state,'protected');
  await assert.rejects(f.sync.report(receipt(t,{retained_ranges:[]})),/contradictory_reverse_report/);
  await assert.rejects(f.sync.report(receipt(t,{blocked:[{start:'2026-12-01',end:'2026-12-02'}]})),/contradictory_reverse_report/);
});
