import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,initialOptionEvidence,matchesInitialOption} from './mmk-client.mjs';
import {MmkAdapter} from './mmk-adapter.mjs';

// Shape and the three transitions are from the controlled, unpaid Option in
// fleet-manual-locks-20260920/mmk-minute-diff.json. No real records are written.
const target={listing_id:'1000000000000000002',segments:[{start:'2027-08-24',end:'2027-08-26'}]};
const gap={start:'2027-08-24',end:'2027-08-26'};
const original=()=>({id:'our-new-option',yacht:{id:target.listing_id},statusId:'2',clientId:'-1',guestId:null,
 paidAmount:0,payments:[],invoiceId:'',freeEntry:false,basePrice:3600,priceWithoutTax:3028.0374,finalPrice:3240,
 checkInDate:'2027-08-24 14:00:00',checkOutDate:'2027-08-31 10:00:00',
 confirmationDate:'2026-09-20 11:47:21',crewNumber:{total:null,adults:1},
 deadlines:[{date:'2026-09-23 11:47:21',amount:3240},{date:'2026-09-24 12:30:00',amount:0}],
 invoiceItems:[{id:'quoted-line',price:3600}],currency:'EUR',remarks:'',internalRemarks:'',bookingOrigin:'',unknownField:{preserved:true}});
const transitioned=(mask=7)=>{const m=original();if(mask&1)m.confirmationDate='2026-09-20';if(mask&2)m.crewNumber.total='1';if(mask&4)m.deadlines[0].date='2026-09-23 00:00:00';return m;};
function setup({first=original(),current=transitioned(),available=true}={}){
 const adapter=new MmkAdapter({});adapter.connect=async()=>{};
 const events=[],evidence=[];let reads=0;
 adapter.client={create:async()=>{events.push('create');return first.id;},get:async()=>structuredClone(reads++?current:first),
  available:async()=>{events.push('available');return available;},save:async model=>{events.push('save:'+model.statusId);return structuredClone(model);}};
 const run=(guard=async()=>{})=>adapter.submit(target,gap,async e=>evidence.push(e),{id:'our-intent',causes:['manual-hold:test'],guard});
 return {adapter,events,evidence,run};
}

test('new Option evidence enumerates only eight observed one-way default combinations, without mutating its input',()=>{
 const m=original(),before=structuredClone(m),proof=initialOptionEvidence(m);
 assert.deepEqual(m,before);assert.equal(proof.initial_fingerprint_version,2);assert.equal(proof.initial_fingerprint,digest(m));
 assert.equal(proof.initial_fingerprint_variants.length,8);
 for(let mask=0;mask<8;mask++)assert.equal(matchesInitialOption(transitioned(mask),proof),true,'combination '+mask);
 const already=initialOptionEvidence(transitioned());assert.deepEqual(already.initial_fingerprint_variants,[digest(transitioned())]);
 assert.equal(matchesInitialOption(original(),already),false,'already-materialized defaults cannot revert');
});

test('all other original Option data, including invoice-line IDs, remains protected by the full digest',()=>{
 const proof=initialOptionEvidence(original());
 const edits=[m=>m.clientId='customer',m=>m.guestId='guest',m=>m.paidAmount=1,m=>m.payments.push({amount:0}),m=>m.invoiceId='invoice',
  m=>m.basePrice++,m=>m.priceWithoutTax++,m=>m.finalPrice++,m=>m.invoiceItems[0].price++,m=>m.invoiceItems[0].id='another-line',
  m=>m.currency='USD',m=>m.checkInDate='2027-08-25 14:00:00',m=>m.checkOutDate='2027-09-01 10:00:00',m=>m.yacht.id='other',
  m=>m.id='another-record',m=>m.statusId='1',m=>m.crewNumber.total=1,m=>m.crewNumber.total='2',m=>m.crewNumber.adults=2,
  m=>m.confirmationDate='2026-09-21',m=>m.confirmationDate='2026-09-20 00:00:00',m=>m.deadlines[0].date='2026-09-24 00:00:00',
  m=>m.deadlines[0].amount++,m=>m.deadlines[1].date='2026-09-24 00:00:00',m=>m.remarks='human note',m=>m.internalRemarks='changed',
  m=>m.bookingOrigin='human',m=>m.freeEntry=true,m=>m.unknownField.preserved=false];
 for(const edit of edits){const m=transitioned();edit(m);assert.equal(matchesInitialOption(m,proof),false,edit.toString());}
});

test('variant eligibility never broadens paid, assigned-customer or malformed Option contexts',()=>{
 for(const edit of [m=>m.clientId='customer',m=>delete m.clientId,m=>m.guestId='guest',m=>m.statusId='1',m=>m.paidAmount='0',
  m=>m.payments=null,m=>m.payments.push({amount:0}),m=>m.invoiceId='invoice']){
  const m=original();edit(m);assert.throws(()=>initialOptionEvidence(m),/partial_write_requires_review/);
 }
 const m=original();m.confirmationDate='2026-02-30 11:47:21';m.deadlines[0].date='2026-09-23 12:47:21';m.crewNumber.total='2';
 assert.deepEqual(initialOptionEvidence(m).initial_fingerprint_variants,[digest(m)]);
});

test('legacy and malformed receipt evidence stay strict, without silently upgrading',()=>{
 const legacy={initial_fingerprint:digest(original())};assert.equal(matchesInitialOption(original(),legacy),true);assert.equal(matchesInitialOption(transitioned(),legacy),false);
 const proof=initialOptionEvidence(original());
 for(const change of [{initial_fingerprint_version:3},{initial_fingerprint_version:null},{initial_fingerprint_variants:[]},
  {initial_fingerprint_variants:[digest(transitioned())]},{initial_fingerprint_variants:Array(9).fill(proof.initial_fingerprint)},
  {initial_fingerprint_variants:[proof.initial_fingerprint,'garbage']}])assert.equal(matchesInitialOption(transitioned(),{...proof,...change}),false);
});

test('submit accepts each observed default combination and records v2 evidence before the availability check',async()=>{
 for(let mask=0;mask<8;mask++){
  const x=setup({current:transitioned(mask)});const available=x.adapter.client.available;
  x.adapter.client.available=async()=>{assert.equal(x.evidence.at(-1).initial_fingerprint_version,2);return available();};
  const result=await x.run();assert.equal(result.start,gap.start);assert.equal(result.end,gap.end);
  assert.deepEqual(x.events,['create','available','save:1']);
  // Since 2026-10-13 the draft's opening day is noted first ({draft_start}).
  assert.equal(x.evidence.find(e=>e.initial_fingerprint_variants).initial_fingerprint_variants.length,8);
 }
});

test('new assigned customer, financial edits, and unrelated post-create changes never save or cancel an Option',async()=>{
 for(const available of [false,true]){
  const first=original();first.clientId='actual-customer';const assigned=setup({first,available});
  await assert.rejects(assigned.run(),/partial_write_requires_review/);assert.deepEqual(assigned.events,['create']);
  for(const change of [{paidAmount:1},{clientId:'actual-customer'},{remarks:'human edit'},{checkOutDate:'2027-09-01 10:00:00'}]){
   const x=setup({current:{...transitioned(),...change},available});await assert.rejects(x.run());
   assert.equal(x.events.some(e=>e.startsWith('save:')),false);
  }
 }
});

test('unavailable Option cancellation uses the same bounded evidence and final write guard',async()=>{
 const x=setup({available:false});await assert.rejects(x.run(),/dates_not_available/);
 assert.deepEqual(x.events,['create','available','save:5']);assert.equal(x.evidence.at(-1).cancelled,true);assert.equal(x.evidence.at(-1).initial_fingerprint_version,2);
 const y=setup({available:false});let guards=0;await assert.rejects(y.run(async()=>{if(++guards===2)throw Error('source_changed_or_stale');}),/source_changed_or_stale/);
 assert.equal(y.events.some(e=>e.startsWith('save:')),false);
});

test('persisted v2 Option recovers across restart with only the original bounded hashes, never creating again',async()=>{
 const x=setup({first:transitioned(1),current:transitioned()});
 const a={target:'mmk:'+target.listing_id,state:'submitting',...gap,response:{draft_id:original().id,marker:'TidewynSync:our-intent',...initialOptionEvidence(original())}};
 await x.adapter.recover(target,{attempts:[a]},async()=>{},async()=>{});
 assert.equal(a.state,'pending_readback');assert.deepEqual(x.events,['available','save:1']);
 const y=setup({first:transitioned(),current:{...transitioned(),finalPrice:4000}});const b=structuredClone(a);b.state='submitting';delete b.created;
 await assert.rejects(y.adapter.recover(target,{attempts:[b]},async()=>{},async()=>{}),/partial_write_requires_review/);
 assert.equal(y.events.some(e=>e.startsWith('save:')),false);
});

test('a legacy restart rejects the observed default transition instead of acquiring new v2 ownership',async()=>{
 const x=setup({first:transitioned()});const response={draft_id:original().id,marker:'TidewynSync:old-intent',initial_fingerprint:digest(original())};
 const a={target:'mmk:'+target.listing_id,state:'submitting',...gap,response};
 await assert.rejects(x.adapter.recover(target,{attempts:[a]},async()=>{},async()=>{}),/partial_write_requires_review/);
 assert.equal(a.response,response);assert.equal(a.response.initial_fingerprint_version,undefined);assert.deepEqual(x.events,[]);
});
