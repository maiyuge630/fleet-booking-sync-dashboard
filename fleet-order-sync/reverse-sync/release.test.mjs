import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseOwned} from './release.mjs';
import {ClickAndBoatAdapter} from './clickandboat-adapter.mjs';
import {SamBoatAdapter} from './samboat-adapter.mjs';
const now=()=>Date.parse('2026-09-13T08:00:00Z');
function setup(){
 const owned={id:'42',start:'2027-01-01',end:'2027-01-08',type:'Unavailable'};
 const manual={id:'manual',start:'2027-02-01',end:'2027-02-08',type:'Unavailable'};
 let rows=[owned,manual],writes=0;
 const a={state:'confirmed',target:'clickandboat:1',created:owned,start:owned.start,end:owned.end,causes:['boataround:2']};
 const ledger={attempts:[a]},target={target:'clickandboat',boat:'boat',listing_id:'1',fresh:true,segments:[],release_proof:{ready:true,checked_at:new Date(now()).toISOString(),orders:[{key:'boataround:2',state:'cancelled'}]}};
 const adapter={read:async()=>({complete:true,identity_verified:true,blocks:structuredClone(rows)}),remove:async()=>{assert.equal(a.state,'releasing');writes++;rows=rows.filter(r=>r.id!==owned.id);}};
 const options={ledger,key:a.target,target,adapter,plan:async()=>({generated_at:new Date(now()).toISOString(),targets:[target]}),save:async()=>{},now,blocks:rows};
 return {a,target,adapter,options,owned,manual,setRows:r=>rows=r,writes:()=>writes,run:()=>releaseOwned(options)};
}
test('explicit cancellation releases only exact owned record after durable intent and readback',async()=>{const x=setup();await x.run();assert.equal(x.writes(),1);assert.equal(x.a.state,'released');await x.run();assert.equal(x.writes(),1);});
for(const kind of ['missing','stale','failed','unknown-owner','changed-id','changed-dates','still-booked','partial'])test('release fails closed: '+kind,async()=>{
 const x=setup();
 if(kind==='missing')x.target.release_proof.orders=[];
 if(kind==='stale')x.target.release_proof.checked_at='2026-09-12T08:00:00Z';
 if(kind==='failed')x.target.release_proof.ready=false;
 if(kind==='unknown-owner')x.a.created=null;
 if(kind==='changed-id')x.setRows([{...x.owned,id:'another'},x.manual]);
 if(kind==='changed-dates')x.setRows([{...x.owned,end:'2027-01-09'},x.manual]);
 if(kind==='still-booked')x.target.segments=[{start:x.a.start,end:x.a.end}];
 if(kind==='partial')x.target.segments=[{start:x.a.start,end:'2027-01-03'}];
 await x.run();assert.equal(x.writes(),0);
});
test('verified reschedule to nonoverlapping dates allows old protection release only after new protection exists',async()=>{
 const x=setup();x.target.release_proof.orders=[{key:'boataround:2',state:'active',start:'2027-02-01',end:'2027-02-08'}];x.target.segments=[{start:'2027-02-01',end:'2027-02-08'}];await x.run();assert.equal(x.writes(),1);
});
test('plan changes immediately before release prevent deletion',async()=>{const x=setup();x.options.plan=async()=>({generated_at:new Date(now()).toISOString(),targets:[{...x.target,segments:[{start:'2027-01-01',end:'2027-01-08'}]}]});await assert.rejects(x.run(),/source_changed_or_stale/);assert.equal(x.writes(),0);});
test('lost delete response is not retried; later absence reconciles exact other records',async()=>{
 const x=setup();x.adapter.remove=async()=>{x.setRows([x.manual]);throw Error('lost');};await assert.rejects(x.run(),/lost/);assert.equal(x.a.state,'releasing');x.options.blocks=[x.manual];await x.run();assert.equal(x.a.state,'released');
});
test('unacknowledged delete still present remains uncertain without another write',async()=>{const x=setup();x.adapter.remove=async()=>{throw Error('lost');};await assert.rejects(x.run(),/lost/);await x.run();assert.equal(x.a.state,'releasing');});
test('unexpected collateral change fails readback',async()=>{const x=setup();x.adapter.remove=async()=>x.setRows([]);await assert.rejects(x.run(),/readback/);assert.equal(x.a.state,'releasing');});

test('platform release adapters reject native reservations before network access',async()=>{
 for(const [Class,type,id] of [[ClickAndBoatAdapter,'Booked','1'],[SamBoatAdapter,'reservation','reservation:1']]){
  const adapter=new Class({});adapter.listing='12';adapter.before=[{id,type,start:'2027-01-01',end:'2027-01-08'}];
  await assert.rejects(adapter.remove({listing_id:'12'},adapter.before[0]),/identity/);
 }
});

for(const reason of ['active-without-dates','active-invalid-date','contradictory-proof','boolean-string','mismatched-receipt-range','reused-historical-id'])test('release rejects ambiguous authority: '+reason,async()=>{
 const x=setup();
 if(reason==='active-without-dates')x.target.release_proof.orders=[{key:'boataround:2',state:'active'}];
 if(reason==='active-invalid-date')x.target.release_proof.orders=[{key:'boataround:2',state:'active',start:'2027-02-30',end:'2027-03-02'}];
 if(reason==='contradictory-proof')x.target.release_proof.orders.push({key:'boataround:2',state:'active',start:x.a.start,end:x.a.end});
 if(reason==='boolean-string')x.target.release_proof.ready='true';
 if(reason==='mismatched-receipt-range')x.a.start='2027-01-02';
 if(reason==='reused-historical-id')x.options.ledger.attempts.push({...x.a,state:'released'});
 await x.run();assert.equal(x.writes(),0);assert.equal(x.a.state,'confirmed');
});
for(const reason of ['changed-listing','stale-plan-clock','duplicate-target'])test('last release plan must identify exactly one current listing: '+reason,async()=>{
 const x=setup();x.options.plan=async()=>({generated_at:new Date(now()-(reason==='stale-plan-clock'?61000:0)).toISOString(),targets:reason==='duplicate-target'?[x.target,x.target]:[{...x.target,...(reason==='changed-listing'?{listing_id:'2'}:{})}]});
 await assert.rejects(x.run(),/source_changed_or_stale|plan_clock_invalid/);assert.equal(x.writes(),0);assert.equal(x.a.state,'confirmed');
});
test('duplicate calendar IDs refuse deletion even if one matching row looks owned',async()=>{
 const x=setup();x.setRows([x.owned,{...x.owned,end:'2027-01-10'},x.manual]);
 await assert.rejects(x.run(),/release_calendar_unverified/);assert.equal(x.writes(),0);
});
test('source clock rollback cannot extend a caller-supplied release budget',async()=>{
 const x=setup();x.options.budgetExpired=()=>true;
 await x.run();assert.equal(x.writes(),0);assert.equal(x.a.state,'confirmed');
});
test('failure to persist release intent prevents the destructive request',async()=>{
 const x=setup();x.options.save=async()=>{throw Error('disk_full');};
 await assert.rejects(x.run(),/disk_full/);assert.equal(x.writes(),0);
});
for(const phase of ['already-closed','plan-read','intent-saved'])test('shutdown before delete remains safe and retryable: '+phase,async()=>{
 const x=setup();let cancelled=phase==='already-closed';x.options.isCancelled=()=>cancelled;
 if(phase==='plan-read'){const plan=x.options.plan;x.options.plan=async()=>{const result=await plan();cancelled=true;return result;};}
 if(phase==='intent-saved')x.options.save=async()=>{if(x.a.state==='releasing')cancelled=true;};
 await assert.rejects(x.run(),/executor_cancelled/);assert.equal(x.writes(),0);assert.equal(x.a.state,'confirmed');
});
