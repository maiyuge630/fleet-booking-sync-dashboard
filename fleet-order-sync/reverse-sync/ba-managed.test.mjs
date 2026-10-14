import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {currentTarget,releaseAllowed} from './release.mjs';
import {boataroundControl,isBoataroundManaged} from './ba-managed.mjs';

const now=Date.parse('2026-09-20T09:00:00Z'),stamp=new Date(now).toISOString();
const day={start:'2027-01-01',end:'2027-01-02'},id='0000000000000000000000b4:'+day.start;
const row={...day,id,type:3},key='boataround:ad2';
const coverage={start:'2026-09-20',end:'2028-03-21'};
function fixture(){
 let state={version:1,attempts:[],targets:{}},rows=[],creates=0,deletes=0;
 const target={target:'boataround',boat:'ad2',listing_id:'ad2',fresh:true,segments:[{...day,causes:['samboat:A']}],
  boataround_control:{version:1,enabled:true,revision:0,holds:[]},release_proof:{ready:true,checked_at:stamp,orders:[{key:'samboat:A',state:'active',...day}]}};
 const adapter={maxGapDays:1,read:async()=>({complete:true,identity_verified:true,coverage,blocks:structuredClone(rows)}),prepare:async()=>{},
  submit:async(_t,gap,_evidence,{guard})=>{await guard({beforeFirstWrite:true});creates++;const created={...gap,id:'0000000000000000000000b4:'+gap.start,type:3};rows.push(created);return created;},
  remove:async(_t,owned,{guard})=>{await guard();deletes++;rows=rows.filter(r=>r.id!==owned.id);},close:async()=>{}};
 const options={now:()=>now,load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);},
  plan:async()=>({generated_at:stamp,targets:[structuredClone(target)]}),adapters:{boataround:adapter}};
 const cancel=()=>{target.segments=[];target.release_proof.orders=[{key:'samboat:A',state:'cancelled'}];};
 return {target,adapter,options,cancel,run:()=>new ReverseExecutor(options).run(),state:()=>state,rows:()=>rows,
  setState:value=>{state=structuredClone(value);},setRows:value=>{rows=structuredClone(value);},counts:()=>({creates,deletes})};
}

test('new daily management is acknowledged only after write and full readback, then explicit cancellation opens once',async()=>{
 const f=fixture();await f.run();const a=f.state().attempts[0];assert.equal(isBoataroundManaged(a),true);
 assert.equal(a.boataround_managed.generation,a.id);assert.equal(f.state().targets[key].boataround_control_revision,0);
 f.cancel();await f.run();assert.deepEqual(f.counts(),{creates:1,deletes:1});assert.equal(f.state().attempts[0].state,'released');
 await f.run();assert.deepEqual(f.counts(),{creates:1,deletes:1});
});

test('existing manual coverage and legacy receipts never acquire managed release authority',async()=>{
 for(const legacy of [false,true]){
  const f=fixture();f.setRows([row]);
  if(legacy)f.setState({version:1,targets:{},attempts:[{id:'old',target:key,state:'confirmed',...day,created:row,before:[],causes:['samboat:A']}]});
  await f.run();f.cancel();await f.run();assert.deepEqual(f.counts(),{creates:0,deletes:0});assert.deepEqual(f.rows(),[row]);
  assert.ok(f.state().attempts.every(a=>!a.boataround_managed));
 }
});

test('complete receipt permits restart confirmation; lost response only proves coverage and never ownership',async()=>{
 for(const completeReceipt of [false,true]){
  const f=fixture();
  if(completeReceipt){const read=f.adapter.read;let reads=0;f.adapter.read=async()=>{if(++reads===2)throw Error('readback_lost');return read();};}
  else{const submit=f.adapter.submit;f.adapter.submit=async(...args)=>{await submit(...args);throw Error('response_lost');};}
  await f.run();assert.ok(!f.state().attempts[0].boataround_managed);
  f.adapter.read=async()=>({complete:true,identity_verified:true,coverage,blocks:structuredClone(f.rows())});await f.run();
  assert.equal(isBoataroundManaged(f.state().attempts[0]),completeReceipt);
  f.cancel();await f.run();assert.equal(f.counts().deletes,completeReceipt?1:0);
 }
});

test('second generation can reuse a synthetic day only after a released new managed generation',async()=>{
 const f=fixture();await f.run();f.cancel();await f.run();
 f.target.segments=[{...day,causes:['clickandboat:B']}];f.target.release_proof.orders.push({key:'clickandboat:B',state:'active',...day});
 await f.run();assert.equal(f.counts().creates,2);assert.ok(f.state().attempts.every(isBoataroundManaged));
 assert.notEqual(f.state().attempts[0].boataround_managed.generation,f.state().attempts[1].boataround_managed.generation);
 f.target.segments=[];f.target.release_proof.orders=[{key:'samboat:A',state:'cancelled'},{key:'clickandboat:B',state:'cancelled'}];
 await f.run();assert.equal(f.counts().deletes,2);assert.ok(f.state().attempts.every(a=>a.state==='released'));
});

test('released legacy or unresolved historical synthetic identities cannot be upgraded on date reuse',async()=>{
 for(const state of ['released','confirmed','releasing']){
  const f=fixture();f.setState({version:1,targets:{},attempts:[{id:'legacy',target:key,state,...day,created:row,before:[],release_before:[],causes:['samboat:A']}]});
  await f.run();assert.equal(f.state().targets[key].error,'write_receipt_mismatch');
  assert.ok(f.state().attempts.every(a=>!a.boataround_managed));assert.equal(f.counts().deletes,0);
 }
});

test('later overlapping order is remembered even on a no-write run and disappearance cannot release the day',async()=>{
 const f=fixture();await f.run();
 f.target.segments=[{...day,causes:['samboat:A','clickandboat:B']}];
 f.target.release_proof.orders.push({key:'clickandboat:B',state:'active',...day});await f.run();
 assert.deepEqual(f.state().attempts[0].boataround_managed.causes,['clickandboat:B','samboat:A']);assert.equal(f.counts().creates,1);
 f.cancel();await f.run();assert.equal(f.counts().deletes,0);
 f.target.release_proof.orders.push({key:'clickandboat:B',state:'cancelled'});await f.run();assert.equal(f.counts().deletes,1);
});

test('native active proof outside write segments is also remembered',async()=>{
 const f=fixture();await f.run();f.target.release_proof.orders.push({key:'boataround:B',state:'active',...day});await f.run();
 assert.ok(f.state().attempts[0].boataround_managed.causes.includes('boataround:B'));
 f.cancel();await f.run();assert.equal(f.counts().deletes,0);
});

test('ordinary manual hold blocks opening until its own explicit cancellation proof arrives',async()=>{
 const f=fixture();await f.run();f.cancel();
 const hold={id:'owner-1',...day,active:true};f.target.boataround_control={version:1,enabled:true,revision:1,holds:[hold]};
 f.target.segments=[{...day,causes:['manual-hold:owner-1']}];f.target.release_proof.orders.push({key:'manual-hold:owner-1',state:'active',...day});
 await f.run();assert.equal(f.counts().deletes,0);assert.equal(f.state().targets[key].boataround_control_revision,1);
 f.target.boataround_control.revision=2;hold.active=false;f.target.segments=[];f.target.release_proof.orders=f.target.release_proof.orders.filter(o=>o.key!=='manual-hold:owner-1');
 await f.run();assert.equal(f.counts().deletes,0);
 f.target.release_proof.orders.push({key:'manual-hold:owner-1',state:'cancelled'});await f.run();assert.equal(f.counts().deletes,1);
});

test('locked release-only AC2 hold never creates a four-year write range and still vetoes opening',async()=>{
 const f=fixture();await f.run();f.cancel();
 f.target.boataround_control.holds=[{id:'system-ac2-unavailable-through-2030',start:'2026-09-19',end:'2031-01-01',active:true,locked:true,release_only:true}];
 f.target.boataround_control.revision=1;await f.run();assert.deepEqual(f.counts(),{creates:1,deletes:0});
});

test('control changes during persistence or immediately before DELETE prevent mutation and acknowledgement',async()=>{
 for(const phase of ['close-intent','release-intent','last-release-guard']){
  const f=fixture();if(phase!=='close-intent'){await f.run();f.cancel();}
  if(phase==='last-release-guard')f.adapter.remove=async(_t,_r,{guard})=>{f.target.boataround_control.revision++;await guard();throw Error('must_not_submit');};
  else{const save=f.options.save;f.options.save=async ledger=>{await save(ledger);if(ledger.attempts.some(a=>a.state===(phase==='close-intent'?'submitting':'releasing')))f.target.boataround_control.revision++;};}
  await f.run();assert.equal(f.counts().creates,phase==='close-intent'?0:1);assert.equal(f.counts().deletes,0);
  assert.equal(f.state().targets[key].boataround_control_revision,undefined);assert.match(f.state().targets[key].error,/source_changed_or_stale/);
 }
});

test('hold arrival after DELETE is in flight remains unacknowledged and the next run restores protection',async()=>{
 const f=fixture();await f.run();f.cancel();const remove=f.adapter.remove;
 f.adapter.remove=async(...args)=>{await remove(...args);f.target.boataround_control.revision=1;
  f.target.boataround_control.holds=[{id:'late',...day,active:true}];f.target.segments=[{...day,causes:['manual-hold:late']}];
  f.target.release_proof.orders.push({key:'manual-hold:late',state:'active',...day});};
 await f.run();assert.equal(f.state().targets[key].boataround_control_revision,undefined);assert.equal(f.rows().length,0);
 await f.run();assert.equal(f.counts().creates,2);assert.equal(f.rows().length,1);assert.equal(f.state().targets[key].boataround_control_revision,1);
});

test('lost DELETE response reconciles absence before a new-generation close; still-present DELETE is never retried',async()=>{
 for(const applied of [true,false]){
  const f=fixture();await f.run();f.cancel();const remove=f.adapter.remove;
  f.adapter.remove=async(...args)=>{if(applied)await remove(...args);throw Error('delete_response_lost');};
  await f.run();assert.equal(f.state().attempts[0].state,'releasing');
  if(applied){f.target.segments=[{...day,causes:['samboat:B']}];f.target.release_proof.orders.push({key:'samboat:B',state:'active',...day});}
  await f.run();assert.equal(f.counts().deletes,applied?1:0);assert.equal(f.counts().creates,applied?2:1);
  assert.equal(f.state().attempts[0].state,applied?'released':'releasing');
  if(!applied)assert.equal(f.state().targets[key].boataround_control_revision,undefined);
 }
});

test('failed source, disabled policy and malformed controls never authorize opening',async()=>{
 for(const fault of ['stale','not-ready','disabled','missing','malformed']){
  const f=fixture();await f.run();f.cancel();
  if(fault==='stale')f.target.fresh=false;
  if(fault==='not-ready')f.target.release_proof.ready=false;
  if(fault==='disabled')f.target.boataround_control.enabled=false;
  if(fault==='missing')delete f.target.boataround_control;
  if(fault==='malformed')f.target.boataround_control.revision='1';
  await f.run();assert.equal(f.counts().deletes,0);assert.equal(f.state().targets[key].boataround_control_revision,undefined);
 }
});

test('control parser rejects duplicate holds and invalid boundaries; control equality includes all hold rules',()=>{
 const f=fixture();for(const holds of [[{id:'x',...day,active:'true'}],[{id:'x',...day,active:true,locked:'true'}],
  [{id:'x',...day,active:true},{id:'x',...day,active:false}],[{id:'x',start:day.end,end:day.start,active:true}]])
  assert.throws(()=>boataroundControl({...f.target,boataround_control:{...f.target.boataround_control,holds}}),/boataround_control_unverified/);
 const changed=structuredClone(f.target);changed.boataround_control.holds=[{id:'x',...day,active:true,release_only:true}];
 assert.throws(()=>currentTarget({generated_at:stamp,targets:[changed]},f.target,now),/source_changed_or_stale/);
 assert.equal(releaseAllowed({state:'confirmed',...day,created:row,causes:['samboat:A']},f.target,now),false);
});

test('coverage outside the day cannot confirm a new managed write or an uncertain DELETE',async()=>{
 const outside={start:'2027-02-01',end:'2028-01-01'};
 const f=fixture(),read=f.adapter.read;let reads=0;
 f.adapter.read=async()=>({...await read(),coverage:++reads===1?coverage:outside});
 await f.run();assert.equal(f.state().attempts[0].state,'pending_readback');assert.ok(!f.state().attempts[0].boataround_managed);
 await f.run();assert.equal(f.state().attempts[0].state,'pending_readback');assert.ok(!f.state().attempts[0].boataround_managed);
 f.adapter.read=read;await f.run();assert.ok(isBoataroundManaged(f.state().attempts[0]));
 f.cancel();const remove=f.adapter.remove;f.adapter.remove=async(...args)=>{await remove(...args);throw Error('lost');};
 await f.run();assert.equal(f.state().attempts[0].state,'releasing');
 f.adapter.read=async()=>({...await read(),coverage:outside});await f.run();
 assert.equal(f.state().attempts[0].state,'releasing');assert.equal(f.state().targets[key].boataround_control_revision,undefined);
 f.adapter.read=read;await f.run();assert.equal(f.state().attempts[0].state,'released');
});

test('failure to persist new management or release intent prevents the corresponding platform request',async()=>{
 for(const opening of [false,true]){
  const f=fixture();if(opening){await f.run();f.cancel();}
  const save=f.options.save;f.options.save=async ledger=>{
   if(ledger.attempts.some(a=>a.state===(opening?'releasing':'submitting')))throw Error('disk_full');return save(ledger);
  };
  await assert.rejects(f.run(),/disk_full/);assert.equal(f.counts().creates,opening?1:0);assert.equal(f.counts().deletes,0);
 }
});

test('rescheduling to the touching next day protects the replacement before releasing the old day',async()=>{
 const f=fixture();await f.run();const events=[],submit=f.adapter.submit,remove=f.adapter.remove;
 f.adapter.submit=async(...args)=>{const result=await submit(...args);events.push('close:'+result.start);return result;};
 f.adapter.remove=async(...args)=>{events.push('open:'+args[1].start);return remove(...args);};
 const next={start:day.end,end:'2027-01-03'};f.target.segments=[{...next,causes:['samboat:A']}];
 f.target.release_proof.orders=[{key:'samboat:A',state:'active',...next}];await f.run();
 assert.deepEqual(events,['close:2027-01-02','open:2027-01-01']);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].start,next.start);
});
