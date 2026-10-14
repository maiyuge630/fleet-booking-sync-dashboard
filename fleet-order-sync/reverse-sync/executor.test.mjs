import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
const now=Date.parse('2026-09-13T06:30:00Z');
function setup({blocks=[],fail=null,ledger=null,fresh=true}={}) {
  let state=ledger,calls=0,reads=0;
  const target={target:'clickandboat',listing_id:'100004',fresh,segments:[{start:'2026-12-12',end:'2026-12-19',causes:['boataround:300000']}]};
  const adapter={async read(){reads++;return {complete:true,identity_verified:true,blocks:structuredClone(blocks)};},async prepare(){if(fail==='prepare')throw Error('date_disabled');},async submit(t,gap){calls++;if(fail==='submit')throw Error('response_lost');const created={...gap,id:String(123+calls)};blocks.push(created);return created;},async close(){}};
  const options={now:()=>now,load:async()=>structuredClone(state),save:async v=>{state=structuredClone(v);},plan:async()=>({generated_at:new Date(now).toISOString(),targets:[structuredClone(target)]}),adapters:{clickandboat:adapter}};
  return {options,adapter,target,run:()=>new ReverseExecutor(options).run(),state:()=>state,calls:()=>calls,reads:()=>reads};
}
test('create, reload, persist ownership; second reconciliation does not duplicate',async()=>{
  const x=setup();await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[0].state,'confirmed');assert.ok(x.reads()>=2);await x.run();assert.equal(x.calls(),1);
});
test('manual coverage is preserved without acquiring ownership',async()=>{
  const x=setup({blocks:[{id:'manual',start:'2026-12-01',end:'2027-01-01'}]});await x.run();assert.equal(x.calls(),0);assert.equal(x.state().attempts.length,0);
});
test('partial existing protection creates only uncovered dates',async()=>{
  const x=setup({blocks:[{id:'manual',start:'2026-12-15',end:'2026-12-17'}]});await x.run();assert.equal(x.calls(),2);assert.deepEqual(x.state().attempts.map(a=>[a.start,a.end]),[['2026-12-12','2026-12-15'],['2026-12-17','2026-12-19']]);
});
test('response loss persists uncertainty and refuses a duplicate after restart',async()=>{
  const x=setup({fail:'submit'});await x.run();assert.equal(x.state().attempts[0].state,'submitting');await x.run();assert.equal(x.calls(),1);assert.equal(x.state().targets['clickandboat:100004'].blocked[0].error,'previous_write_uncertain');
});
test('later observed protection resolves coverage without acquiring deletion ownership',async()=>{
 const blocks=[],x=setup({blocks,fail:'submit'});await x.run();blocks.push({id:'external',start:'2026-12-12',end:'2026-12-19'});
 await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[0].state,'observed_protected');assert.equal(x.state().attempts[0].created,undefined);
});
test('an uncertain interval cannot prevent protecting another nonoverlapping interval',async()=>{
 const blocks=[],x=setup({blocks,fail:'submit'});await x.run();
 x.target.segments.push({start:'2027-02-01',end:'2027-02-03',causes:['boataround:42']});let newWrites=0;
 x.adapter.submit=async(t,gap)=>{newWrites++;const row={id:'other',...gap};blocks.push(row);return row;};
 await x.run();assert.equal(newWrites,1);assert.equal(x.state().attempts[0].state,'submitting');assert.equal(x.state().attempts[1].state,'confirmed');
});
test('stale evidence and disabled controls prevent submission',async()=>{
  for(const options of [{fresh:false},{fail:'prepare'}]){const x=setup(options);await x.run();assert.equal(x.calls(),0);assert.equal(x.state().attempts.length,0);}
});
test('one disabled interval does not strand other safe intervals for that boat',async()=>{
 const x=setup();x.target.segments.push({start:'2027-02-01',end:'2027-02-03',causes:['boataround:42']});
 x.adapter.prepare=async(t,gap)=>{if(gap.start==='2026-12-12')throw Error('date_disabled');};
 await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[0].start,'2027-02-01');assert.equal(x.state().targets['clickandboat:100004'].state,'needs_review');
});
test('source change between preparation and submission prevents write',async()=>{
  const x=setup();x.adapter.prepare=async()=>{x.target.segments=[];};await x.run();assert.equal(x.calls(),0);
});
test('missing source never deletes a confirmed owned block',async()=>{
  const x=setup();await x.run();x.target.segments=[];await x.run();assert.equal(x.state().targets['clickandboat:100004'].state,'removal_requires_verification');assert.equal(x.calls(),1);
});
test('partial cancellation is flagged even when another order still covers part of the block',async()=>{
 const x=setup();await x.run();x.target.segments[0].end='2026-12-15';await x.run();
 assert.equal(x.state().targets['clickandboat:100004'].state,'removal_requires_verification');assert.equal(x.calls(),1);
});
test('incomplete or wrong-account calendars prevent writes',async()=>{
  for(const invalid of [{complete:false,identity_verified:true},{complete:true,identity_verified:false}]){const x=setup();x.adapter.read=async()=>({...invalid,blocks:[]});await x.run();assert.equal(x.calls(),0);}
});
test('changed manual record fails post-write verification',async()=>{
  const manual={id:'manual',start:'2026-12-01',end:'2026-12-02'},x=setup({blocks:[manual]});const read=x.adapter.read;let n=0;x.adapter.read=async()=>{const result=await read();if(++n>1)result.blocks=result.blocks.filter(b=>b.id!=='manual');return result;};await x.run();assert.equal(x.state().attempts[0].state,'pending_readback');assert.equal(x.state().targets['clickandboat:100004'].error,'write_readback_failed');
});

test('existing coverage cannot be reported protected when source evidence is stale',async()=>{
 const x=setup({fresh:false,blocks:[{id:'manual',start:'2026-12-12',end:'2026-12-19'}]});
 await x.run();assert.equal(x.calls(),0);assert.equal(x.state().targets['clickandboat:100004'].error,'source_changed_or_stale');
});
test('source changes during a read-only reconciliation invalidate its result',async()=>{
 const x=setup({blocks:[{id:'manual',start:'2026-12-12',end:'2026-12-19'}]}),read=x.adapter.read;
 x.adapter.read=async()=>{const result=await read();x.target.segments.push({start:'2027-02-01',end:'2027-02-08',causes:['samboat:3']});return result;};
 await x.run();assert.equal(x.calls(),0);assert.equal(x.state().targets['clickandboat:100004'].error,'source_changed_or_stale');
});
test('source failure after successful write preserves receipt but never reports current protection',async()=>{
 const x=setup(),read=x.adapter.read;let reads=0;
 x.adapter.read=async()=>{const result=await read();if(++reads===2)x.target.fresh=false;return result;};
 await x.run();assert.equal(x.state().attempts[0].state,'confirmed');assert.equal(x.state().targets['clickandboat:100004'].error,'source_changed_or_stale');
});
test('stale generated plan after preparation prevents the actual submission',async()=>{
 const x=setup(),plan=x.options.plan;let prepared=false;x.adapter.prepare=async()=>{prepared=true;};
 x.options.plan=async()=>{const result=await plan();if(prepared)result.generated_at=new Date(now-61000).toISOString();return result;};
 await x.run();assert.equal(x.calls(),0);assert.equal(x.state().attempts.length,0);assert.equal(x.state().targets['clickandboat:100004'].error,'plan_clock_invalid');
});
test('listing replacement after preparation prevents writing to a previously selected boat',async()=>{
 const x=setup();x.adapter.prepare=async()=>{x.target.listing_id='other';};
 await x.run();assert.equal(x.calls(),0);assert.equal(x.state().targets['clickandboat:100004'].error,'source_changed_or_stale');
});
test('pending delete remains visible as uncertain if a new order now requires the entire same interval',async()=>{
 const owned={id:'owned',start:'2026-12-12',end:'2026-12-19'},x=setup({blocks:[owned],ledger:{version:1,targets:{},attempts:[{target:'clickandboat:100004',state:'releasing',...owned,id:'prior',created:owned,release_before:[],causes:['boataround:old']} ]}});
 await x.run();assert.equal(x.calls(),0);const result=x.state().targets['clickandboat:100004'];assert.equal(result.state,'needs_review');assert.ok(result.blocked.some(b=>b.error==='previous_release_uncertain'));
});
for(const invalid of [
 [{id:'same',start:'2026-12-12',end:'2026-12-19'},{id:'same',start:'2027-01-01',end:'2027-01-08'}],
 [{id:'bad',start:'2026-12-12',end:'2026-02-30'}]
])test('duplicate IDs and malformed calendar dates are rejected before any action: '+JSON.stringify(invalid),async()=>{
 const x=setup({blocks:invalid});await x.run();assert.equal(x.calls(),0);assert.equal(x.state().targets['clickandboat:100004'].error,'target_unverified');
});
test('truthy strings cannot substitute for verified complete post-write observation',async()=>{
 const x=setup(),read=x.adapter.read;let calls=0;x.adapter.read=async()=>{const result=await read();if(++calls>1)result.complete='true';return result;};
 await x.run();assert.equal(x.state().attempts[0].state,'pending_readback');assert.equal(x.state().targets['clickandboat:100004'].error,'write_readback_failed');
});
test('a reused historical platform ID cannot acquire fresh deletion ownership',async()=>{
 const x=setup({ledger:{version:1,targets:{},attempts:[{id:'old-attempt',target:'clickandboat:100004',state:'released',created:{id:'124',start:'2026-11-01',end:'2026-11-03'}}]}});
 await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[1].created,undefined);assert.equal(x.state().targets['clickandboat:100004'].error,'write_receipt_mismatch');
});
test('clock rollback cannot extend the monotonic budget or allow a late submission',async()=>{
 const x=setup();let monotonic=0;x.options.monotonic=()=>monotonic;
 x.adapter.prepare=async()=>{monotonic=240001;};await x.run();
 assert.equal(x.calls(),0);assert.equal(x.state().targets['clickandboat:100004'].error,'execution_budget_exhausted');
});
test('cleanup failure records the first boat outcome and does not starve the next target',async()=>{
 const x=setup(),second={...x.target,target:'samboat',listing_id:'2',segments:[]};
 x.options.plan=async()=>({generated_at:new Date(now).toISOString(),targets:[structuredClone(x.target),second]});
 let checked=false;x.options.adapters.samboat={read:async()=>{checked=true;return {complete:true,identity_verified:true,blocks:[]};}};
 x.adapter.close=async()=>{throw Error('tab_detached');};
 await x.run();assert.equal(checked,true);assert.equal(x.state().attempts[0].state,'confirmed');assert.equal(x.state().targets['clickandboat:100004'].cleanup_error,'tab_detached');assert.equal(x.state().targets['samboat:2'].state,'protected');
});
test('unavailable adapters and deferred targets persist reportable timestamps and plan',async()=>{
 for(const reason of ['adapter_unavailable','deferred']){
  const x=setup();if(reason==='adapter_unavailable')x.options.adapters={};
  else {let n=0;x.options.monotonic=()=>n++?240001:0;}
  await x.run();const result=x.state().targets['clickandboat:100004'];assert.equal(result.state,reason);assert.equal(result.checked_at,new Date(now).toISOString());assert.deepEqual(result.segments,x.target.segments);
 }
});
for(const phase of ['already-closed','preparation','intent-saved'])test('shutdown prevents a new platform close request: '+phase,async()=>{
 const x=setup();let cancelled=phase==='already-closed';x.options.isCancelled=()=>cancelled;
 if(phase==='preparation')x.adapter.prepare=async()=>{cancelled=true;};
 if(phase==='intent-saved'){const save=x.options.save;x.options.save=async ledger=>{await save(ledger);if(ledger.attempts.some(a=>a.state==='submitting'))cancelled=true;};}
 await x.run();assert.equal(x.calls(),0);
 if(phase==='intent-saved')assert.equal(x.state().attempts[0].state,'not_submitted');
});
test('cancelled before network submission remains retryable after restart without inventing an uncertain write',async()=>{
 const x=setup();let cancelled=false;const save=x.options.save;x.options.isCancelled=()=>cancelled;
 x.options.save=async ledger=>{await save(ledger);if(ledger.attempts.some(a=>a.state==='submitting'))cancelled=true;};
 await x.run();assert.equal(x.calls(),0);assert.equal(x.state().attempts[0].state,'not_submitted');
 x.options.save=save;cancelled=false;await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[1].state,'confirmed');
});
test('shutdown after submission still persists readback before stopping further writes',async()=>{
 const x=setup(),submit=x.adapter.submit;let cancelled=false;x.options.isCancelled=()=>cancelled;
 x.adapter.submit=async(...args)=>{const result=await submit(...args);cancelled=true;return result;};
 await x.run();assert.equal(x.calls(),1);assert.equal(x.state().attempts[0].state,'confirmed');assert.equal(x.state().targets['clickandboat:100004'].error,'executor_cancelled');
});
test('reporting a deferred timestamp cannot starve unvisited boats on the next cycle',async()=>{
 const x=setup();x.target.segments=[];const second={...x.target,target:'samboat',listing_id:'2'};
 let monotonic=0;const order=[];x.options.monotonic=()=>monotonic;
 x.options.plan=async()=>({generated_at:new Date(now).toISOString(),targets:[x.target,second]});
 for(const source of ['clickandboat','samboat'])x.options.adapters[source]={read:async()=>{order.push(source);monotonic=240001;return {complete:true,identity_verified:true,blocks:[]};}};
 await x.run();assert.equal(x.state().targets['samboat:2'].state,'deferred');assert.equal(x.state().targets['samboat:2'].checked_at,new Date(now).toISOString());
 monotonic=0;order.length=0;await x.run();assert.equal(order[0],'samboat');assert.equal(x.state().targets['samboat:2'].state,'protected');
});

test('multi-step adapter receives a fresh-source guard after persisting a draft receipt',async()=>{
 const x=setup();let finalized=false;
 x.adapter.submit=async(t,gap,evidence,context)=>{
  await evidence({draft_id:'known-draft'});x.target.fresh=false;
  await context.guard();finalized=true;return {...gap,id:'known-draft'};
 };
 await x.run();assert.equal(finalized,false);assert.equal(x.state().attempts[0].response.draft_id,'known-draft');
 assert.equal(x.state().targets['clickandboat:100004'].error,'source_changed_or_stale');
});

test('recovery guard returns freshly read release proof, not the initial plan snapshot',async()=>{
 const x=setup();let verified=false;
 x.target.release_proof={version:1,ready:true,orders:[{key:'boataround:old',state:'active'}]};
 x.adapter.recover=async(target,ledger,guard)=>{
  assert.equal(target.release_proof.orders[0].state,'active');
  x.target.release_proof={version:1,ready:true,orders:[{key:'boataround:old',state:'cancelled'}]};
  const latest=await guard();
  assert.equal(latest.release_proof.orders[0].state,'cancelled');verified=true;
 };
 await x.run();assert.equal(verified,true);
});

for(const reason of ['stale','shutdown'])test('recovery guard prevents a mutation after '+reason,async()=>{
 const x=setup();let changed=false,cancelled=false;x.options.isCancelled=()=>cancelled;
 x.adapter.recover=async(target,ledger,guard)=>{
  if(reason==='stale')x.target.fresh=false;else cancelled=true;
  await guard();changed=true;
 };
 await x.run();assert.equal(changed,false);assert.equal(x.calls(),0);
 assert.equal(x.state().targets['clickandboat:100004'].error,reason==='stale'?'source_changed_or_stale':'executor_cancelled');
});
