import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRows,ClickAndBoatAdapter,validateCreateResult} from './clickandboat-adapter.mjs';
import {ReverseExecutor} from './executor.mjs';
test('inclusive manual end maps to checkout-exclusive protection',()=>{
  assert.deepEqual(normalizeRows([{id:'1',from:'2026-12-12 00:00:00',to:'2026-12-18 23:59:00',type:'Unavailable'}]).map(r=>[r.start,r.end]),[['2026-12-12','2026-12-19']]);
});
test('native partial days never masquerade as whole days',()=>{
  assert.deepEqual(normalizeRows([{id:'1',from:'2026-12-12 14:00:00',to:'2026-12-19 10:00:00',type:'Booked'}]).map(r=>[r.start,r.end]),[['2026-12-13','2026-12-19']]);
});
test('unknown calendar schema and duplicate identities fail closed',()=>{
  const row={id:'1',from:'2026-12-12 00:00:00',to:'2026-12-18 23:59:00',type:'Unavailable'};
  assert.throws(()=>normalizeRows([row,row]));assert.throws(()=>normalizeRows([{...row,type:'new'}]));assert.throws(()=>normalizeRows([{...row,from:'2026-02-30 00:00:00'}]));
});
function pickerFixture({changed=false,badMonth=false}={}){
 const a=new ClickAndBoatAdapter({});let reads=0,apiChecks=0;
 a.listing='100007';a.before=[];a.page={reload:async()=>({status:()=>200,url:()=> 'https://www.clickandboat.com/uk/account/listing/edit/100007:7',headers:()=>({'content-type':'text/html'})}),waitForSelector:async()=>{},click:async()=>{},
  $$eval:async()=>{reads++;return changed&&reads>1?[{id:'99',from:'2027-05-08 00:00:00',to:'2027-05-08 23:59:00',type:'Unavailable'}]:[];},
  $eval:async()=>badMonth?'unknown calendar':'May 2027',$$:async()=>[{evaluate:async()=>'8',click:async()=>{}}],
  waitForFunction:async(_fn,_opts,...args)=>{if(args.length){const e=Error('Waiting failed: 5000ms exceeded');e.name='TimeoutError';throw e;}apiChecks++;}
 };
 return {a,counts:()=>({reads,apiChecks})};
}
test('datepicker timeout uses explicit owner API only after unchanged calendar readback',async()=>{
 const {a,counts}=pickerFixture();await a.prepare({listing_id:'100007'},{start:'2027-05-08',end:'2027-05-09'});
 assert.equal(a.direct,true);assert.deepEqual(counts(),{reads:2,apiChecks:1});
});
test('calendar changed during datepicker timeout blocks owner API fallback',async()=>{
 const {a,counts}=pickerFixture({changed:true});await assert.rejects(a.prepare({listing_id:'100007'},{start:'2027-05-08',end:'2027-05-09'}),/target_changed_during_preparation/);
 assert.equal(a.direct,false);assert.equal(counts().apiChecks,0);
});
test('unknown calendar month remains a hard error rather than an API fallback',async()=>{
 const {a,counts}=pickerFixture({badMonth:true});await assert.rejects(a.prepare({listing_id:'100007'},{start:'2027-05-08',end:'2027-05-09'}),/calendar_month_unknown/);
 assert.equal(a.direct,false);assert.equal(counts().apiChecks,0);
});

// The official client appends Resultat to its list. The row values below match
// the 2026-09-20 real created calendar row; the full response HTML is a fixture.
const createGap={start:'2027-08-24',end:'2027-08-26'};
const createRow={id:'73842943',from:'2027-08-24 00:00:00',to:'2027-08-25 23:59:00',type:'Unavailable'};
const createHtml='<li class="availability" data-availa-id="73842943" data-availa-from-date="2027-08-24 00:00:00" data-availa-to-date="2027-08-25 23:59:00" data-availa-type="Unavailable"><span>Unavailable</span></li>';

test('Resultat permits absent or explicit zero error code only with a verified exact creation row',()=>{
 for(const code of [undefined,0,'0']){
  const data={Resultat:createHtml,...(code===undefined?{}:{ErreurCode:code})};
  assert.deepEqual(validateCreateResult(data,createRow,createGap),{...createRow,...createGap});
 }
});

test('Resultat cannot turn a business rejection, malformed row or merely successful code into ownership',()=>{
 for(const data of [{ErreurCode:0},{ErreurCode:'0'},null,[],{Resultat:''},{Resultat:' '.repeat(3)},{Resultat:[]},{Resultat:'x'.repeat(200001)},
  ...[1,'42',null,false,''].map(ErreurCode=>({ErreurCode,Resultat:createHtml}))])assert.throws(()=>validateCreateResult(data,createRow,createGap),/platform_rejected_or_unverified/);
 for(const row of [null,{},...[
  {id:'bad'}, {type:'Booked'}, {from:'2027-08-24 14:00:00'}, {to:'2027-08-25 23:59:59'},
  {to:'2027-08-26 23:59:00'}, {from:'2027-08-23 00:00:00'}, {to:'2027-08-25 23:60:00'}
 ].map(p=>({...createRow,...p}))])assert.throws(()=>validateCreateResult({Resultat:createHtml},row,createGap),/platform_rejected_or_unverified/);
});

function resultFixture({json={Resultat:createHtml},parsed=createRow,after=[createRow],before=[],reloadError=null}={}){
 const adapter=new ClickAndBoatAdapter({}),events=[],api='https://www.clickandboat.com/libs/Api/API.php?rquest=ProduitDisponibilite',target={boat:'seacat-open-40-tidewyn-discovery-2',listing_id:'100004'};
 const response={url:()=>api,request:()=>({url:()=>api,method:()=> 'POST',postData:()=>JSON.stringify({ProduitId:'100004',DateDebut:createGap.start+' 00:00:00',DateFin:createGap.end+' 00:00:00',ProduitDisponibiliteTypeId:'Unavailable'})}),
  status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'}),json:async()=>json};
 Object.assign(adapter,{listing:'100004',direct:true,before:normalizeRows(before),page:{
  waitForResponse:async predicate=>{assert.equal(predicate(response),true);return response;},
  evaluate:async(_fn,arg)=>{events.push(typeof arg==='string'?'parse-inert-result':'submit');return typeof arg==='string'?parsed:undefined;},
  reload:async()=>{events.push('reload');if(reloadError)throw Error(reloadError);return {status:()=>200,url:()=> 'https://www.clickandboat.com/uk/account/listing/edit/100004:7',headers:()=>({'content-type':'text/html'})};},
  waitForSelector:async()=>{},$$eval:async()=>after
 }});
 return {adapter,target,events,save:async e=>{events.push(structuredClone(e));}};
}

test('submit persists positively identified response row before fresh readback and requires the same new ID',async()=>{
 const f=resultFixture(),created=await f.adapter.submit(f.target,createGap,f.save,{guard:async()=>{}});
 assert.deepEqual(created,{...createRow,...createGap});
 const evidence=f.events.find(e=>e.response_created);assert.deepEqual(evidence.response_created,created);
 assert.ok(f.events.indexOf(evidence)<f.events.indexOf('reload'));
 for(const after of [[{...createRow,id:'73842944'}],[createRow,{...createRow,id:'73842944'}],[]]){
  const g=resultFixture({after});await assert.rejects(g.adapter.submit(g.target,createGap,g.save,{guard:async()=>{}}),/created_record_mismatch/);
 }
});

test('creation cannot claim an existing ID or hide changes in earlier calendar rows',async()=>{
 const f=resultFixture({before:[createRow]});await assert.rejects(f.adapter.submit(f.target,createGap,f.save,{guard:async()=>{}}),/created_record_mismatch/);assert.ok(!f.events.includes('reload'));
 const old={...createRow,id:'12',from:'2027-09-01 00:00:00',to:'2027-09-01 23:59:00'};
 for(const after of [[createRow],[createRow,{...old,type:'Breakdown'}]]){
  const g=resultFixture({before:[old],after});await assert.rejects(g.adapter.submit(g.target,createGap,g.save,{guard:async()=>{}}),/created_record_mismatch/);
 }
});

test('unknown or missing Resultat is rejected before parsing; a failed reload retains evidence without granting created ownership',async()=>{
 for(const json of [{ErreurCode:0},{Resultat:createHtml,ErreurCode:42}]){
  const f=resultFixture({json});await assert.rejects(f.adapter.submit(f.target,createGap,f.save,{guard:async()=>{}}),/platform_rejected_or_unverified/);
  assert.ok(!f.events.includes('parse-inert-result'));assert.ok(!f.events.includes('reload'));
 }
 const f=resultFixture({reloadError:'network_lost'});await assert.rejects(f.adapter.submit(f.target,createGap,f.save,{guard:async()=>{}}),/network_lost/);
 assert.ok(f.events.some(e=>e.response_created?.id===createRow.id));
});

test('an old null-code uncertain attempt never acquires deletion authority just because its dates now exist',async()=>{
 const now=Date.parse('2026-09-20T09:00:00Z'),created={...createRow,...createGap},cause='manual-hold:840f7769-80db-423b-83c6-e9892fd71fe4';
 let state={version:1,targets:{},attempts:[{id:'old-uncertain',target:'clickandboat:100004',...createGap,causes:[cause],before:[],state:'submitting',response:{http_status:200,error_code:null,message:null}}]},removes=0;
 const target={target:'clickandboat',boat:'ad2',listing_id:'100004',fresh:true,segments:[],release_proof:{ready:true,checked_at:new Date(now).toISOString(),orders:[{key:cause,state:'cancelled'}]}};
 await new ReverseExecutor({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s)},now:()=>now,
  plan:async()=>({generated_at:new Date(now).toISOString(),targets:[target]}),adapters:{clickandboat:{read:async()=>({complete:true,identity_verified:true,blocks:[created]}),remove:async()=>{removes++},close:async()=>{}}}}).run();
 assert.equal(removes,0);assert.equal(state.attempts[0].created,undefined);assert.equal(state.attempts[0].state,'observed_protected');
});
