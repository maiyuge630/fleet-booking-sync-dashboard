import test from 'node:test';
import assert from 'node:assert/strict';
import {ReverseExecutor} from './executor.mjs';
import {releaseOwned} from './release.mjs';
import {MmkAdapter,mmkBlock} from './mmk-adapter.mjs';
import {BoataroundAdapter} from './boataround-adapter.mjs';
import {ClickAndBoatAdapter} from './clickandboat-adapter.mjs';
import {SamBoatAdapter} from './samboat-adapter.mjs';
import {digest} from './mmk-client.mjs';
import {uncovered,segments} from './planner.mjs';
const NOW=Date.parse('2026-09-15T02:00:00Z'),stamp=new Date(NOW).toISOString();
const clone=value=>structuredClone(value);
const gap={start:'2027-01-01',end:'2027-01-09'};

function closeFixture(){
  let saved=null,writes=0,rows=[];
  const target={target:'clickandboat',boat:'boat',listing_id:'1',fresh:true,segments:[{...gap,causes:['samboat:1']}]};
  const adapter={read:async()=>({complete:true,identity_verified:true,blocks:clone(rows)}),prepare:async()=>{},
    submit:async(_target,interval)=>{writes++;const b={id:'created',...interval};rows.push(b);return b;}};
  const options={now:()=>NOW,load:async()=>clone(saved),save:async value=>{saved=clone(value);},
    plan:async()=>({generated_at:stamp,targets:[clone(target)]}),adapters:{clickandboat:adapter}};
  return {target,adapter,options,state:()=>saved,writes:()=>writes,run:()=>new ReverseExecutor(options).run()};
}
function releaseFixture(){
  const owned={id:'owned',...gap,type:'Unavailable'},manual={id:'manual-ac2',start:'2027-02-01',end:'2027-02-09',type:'Unavailable'};
  let rows=[owned,manual],writes=0;
  const a={id:'intent',state:'confirmed',target:'clickandboat:1',created:owned,...gap,causes:['samboat:1']};
  const target={target:'clickandboat',boat:'boat',listing_id:'1',fresh:true,segments:[],
    release_proof:{ready:true,checked_at:stamp,orders:[{key:'samboat:1',state:'cancelled'}]}};
  const adapter={read:async()=>({complete:true,identity_verified:true,blocks:clone(rows)}),
    remove:async()=>{writes++;rows=rows.filter(b=>b.id!=='owned');}};
  const options={ledger:{attempts:[a]},key:a.target,target:clone(target),adapter,plan:async()=>({generated_at:stamp,targets:[clone(target)]}),
    save:async()=>{},now:()=>NOW,blocks:clone(rows)};
  return {a,target,adapter,options,manual,rows:()=>rows,writes:()=>writes,run:()=>releaseOwned(options)};
}

for(const change of ['new-plan','source-failed'])test('close revalidates source after durable intent: '+change,async()=>{
  const x=closeFixture(),save=x.options.save;
  x.options.save=async ledger=>{await save(ledger);if(ledger.attempts.some(a=>a.state==='submitting')){
    if(change==='new-plan')x.target.segments=[];else x.target.fresh=false;
  }};
  await x.run();assert.equal(x.writes(),0);
  assert.equal(x.state().attempts[0].state,'not_submitted');
  assert.equal(x.state().targets['clickandboat:1'].error,'source_changed_or_stale');
});

for(const change of ['new-order','source-failed','proof-withdrawn'])test('opening revalidates after durable intent and stays retryable: '+change,async()=>{
  const x=releaseFixture();
  x.options.save=async()=>{if(x.a.state==='releasing'){
    if(change==='new-order')x.target.segments=[{...gap,causes:['boataround:2']}];
    else if(change==='source-failed')x.target.fresh=false;
    else x.target.release_proof.orders=[];
  }};
  await assert.rejects(x.run(),/source_changed_or_stale/);
  assert.equal(x.writes(),0);assert.equal(x.a.state,'confirmed');
  assert.ok(x.rows().some(b=>b.id===x.manual.id));
});

test('MMK rechecks the opening guard after asynchronously reading its owned reservation',async()=>{
  const model={id:'owned',yacht:{id:'1000000000000000001'},statusId:'1',checkInDate:gap.start+' 00:00:00',
    checkOutDate:gap.end+' 00:00:00',bookingOrigin:'TidewynSync:fixture',internalRemarks:'TidewynSync:fixture',
    freeEntry:true,finalPrice:0,paidAmount:0,payments:[]};
  const adapter=new MmkAdapter({});let writes=0,read=false,guards=0;
  adapter.client={get:async()=>{read=true;return model;},save:async value=>{writes++;return value;}};
  await assert.rejects(adapter.remove({listing_id:model.yacht.id},mmkBlock(model),{guard:async()=>{
    guards++;assert.equal(read,true);throw Error('source_changed_or_stale');
  }}),/source_changed_or_stale/);
  assert.equal(guards,1);assert.equal(writes,0);
});

for(const Class of [BoataroundAdapter,ClickAndBoatAdapter,SamBoatAdapter,MmkAdapter])test(Class.name+' refuses its first write when the final guard fails',async()=>{
  const adapter=new Class({});let requests=0,guards=0;
  adapter.page={evaluate:async()=>{requests++;throw Error('should_not_send');},waitForResponse:()=>{requests++;throw Error('should_not_wait');}};
  adapter.client={create:async()=>{requests++;throw Error('should_not_create');}};
  await assert.rejects(adapter.submit({listing_id:'1'},gap,async()=>{},{id:'intent',causes:['samboat:1'],guard:async options=>{
    guards++;assert.equal(options.beforeFirstWrite,true);throw Error('source_changed_or_stale');
  }}),/source_changed_or_stale/);
  assert.equal(guards,1);assert.equal(requests,0);
});

test('a denied adapter first-write guard stays retryable, while a later draft guard keeps its receipt',async()=>{
  for(const draftCreated of [false,true]){
    const x=closeFixture(),submit=x.adapter.submit;x.adapter.submit=async(_t,_g,evidence,context)=>{
      if(draftCreated)await evidence({draft_id:'known-draft'});
      // Even an incorrect first-write hint cannot discard an already persisted
      // draft receipt and permit duplicate creation after restart.
      x.target.fresh=false;await context.guard({beforeFirstWrite:true});
      throw Error('unreachable');
    };
    await x.run();assert.equal(x.writes(),0);
    assert.equal(x.state().attempts[0].state,draftCreated?'submitting':'not_submitted');
    assert.equal(x.state().attempts[0].response?.draft_id,draftCreated?'known-draft':undefined);
    x.target.fresh=true;x.adapter.submit=submit;await x.run();
    assert.equal(x.writes(),draftCreated?0:1);
    assert.equal(x.state().attempts.length,draftCreated?1:2);
  }
});

test('AC2 and AD3 manual protection survives coverage and later order cancellation without ownership acquisition',async()=>{
  for(const boat of ['coastline-sea-journey-42-tidewyn-cruise-2','bluecat-42-tidewyn-discovery-3']){
    const x=closeFixture();x.target.boat=boat;
    const manual={id:'manual-'+boat,...gap,type:'Unavailable'};let removals=0;
    x.adapter.read=async()=>({complete:true,identity_verified:true,blocks:[clone(manual)]});
    x.adapter.remove=async()=>{removals++;throw Error('manual_must_not_be_removed');};
    await x.run();assert.equal(x.writes(),0);assert.equal(x.state().attempts.length,0);
    x.target.segments=[];x.target.release_proof={ready:true,checked_at:stamp,orders:[{key:'samboat:1',state:'cancelled'}]};
    await x.run();assert.equal(removals,0);assert.equal(x.state().attempts.length,0);
    assert.equal(x.state().targets['clickandboat:1'].state,'protected');
  }
});

for(const mutation of [{paidAmount:10},{payments:[{id:'new-payment'}]},{invoiceId:'new-invoice'}])test('MMK never finalizes or cancels a draft that already acquired financial activity: '+JSON.stringify(mutation),async()=>{
  for(const available of [true,false]){
    const original={id:'new-draft',yacht:{id:'1'},statusId:'2',paidAmount:0,payments:[],...mutation};
    const adapter=new MmkAdapter({});let writes=0;
    adapter.client={create:async()=>original.id,get:async()=>clone(original),available:async()=>available,
      save:async model=>{writes++;return model;}};
    await assert.rejects(adapter.submit({listing_id:'1'},gap,async()=>{},{id:'intent',causes:['samboat:1'],guard:async()=>{}}));
    assert.equal(writes,0,'existing money/invoice must be checked before saving or cancellation');
  }
});

test('MMK recovery also refuses an old acknowledged Option with financial activity',async()=>{
  const original={id:'old-draft',yacht:{id:'1'},statusId:'2',paidAmount:10,payments:[]};
  const a={target:'mmk:1',state:'submitting',...gap,response:{draft_id:original.id,initial_fingerprint:digest(original),marker:'TidewynSync:intent'}};
  const adapter=new MmkAdapter({});adapter.connect=async()=>{};let writes=0;
  adapter.client={get:async()=>clone(original),available:async()=>true,save:async model=>{writes++;return model;}};
  await assert.rejects(adapter.recover({listing_id:'1',segments:[gap]},{attempts:[a]},async()=>{},async()=>{}));
  assert.equal(writes,0);
});

test('network failure after DELETE remains uncertain and is never automatically sent again',async()=>{
  const x=releaseFixture();let requests=0;
  x.adapter.remove=async()=>{requests++;throw Error('response_lost');};
  await assert.rejects(x.run(),/response_lost/);assert.equal(x.a.state,'releasing');
  await x.run();assert.equal(requests,1);assert.equal(x.a.state,'releasing');
  assert.deepEqual(x.rows().map(b=>b.id),['owned','manual-ac2']);
});

test('calendar set subtraction and cause segmentation preserve exact half-open dates for generated overlapping intervals',()=>{
  const date=n=>'2027-01-'+String(n+1).padStart(2,'0');
  const days=range=>Array.from({length:Number(range.end.slice(-2))-Number(range.start.slice(-2))},(_,i)=>Number(range.start.slice(-2))+i);
  let state=71523;const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  for(let trial=0;trial<250;trial++){
    const make=()=>{const start=random(9),end=start+1+random(10-start);return {start:date(start),end:date(end)};};
    const required=make(),blocks=Array.from({length:random(6)},make);
    const covered=new Set(blocks.flatMap(days)),expected=days(required).filter(day=>!covered.has(day));
    const actual=uncovered(required,blocks).flatMap(days);
    assert.deepEqual(actual,expected);assert.equal(new Set(actual).size,actual.length);
    const causes=blocks.map((r,i)=>({...r,key:'order:'+i}));
    const segmented=new Map();
    for(const s of segments(causes))for(const day of days(s)){
      assert.equal(segmented.has(day),false,'segments may not duplicate an occupied day');segmented.set(day,s.causes);
      assert.deepEqual(s.causes,causes.filter(c=>days(c).includes(day)).map(c=>c.key).sort());
    }
    for(let day=1;day<=10;day++)assert.deepEqual(segmented.get(day)||[],causes.filter(c=>days(c).includes(day)).map(c=>c.key).sort());
  }
});
