import test from 'node:test';
import assert from 'node:assert/strict';
import {ClickAndBoatAdapter,normalizeRows} from './clickandboat-adapter.mjs';
import {MmkAdapter} from './mmk-adapter.mjs';
import {mmkEntryState} from './mmk-client.mjs';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {parseSamBoatListCard,parseSamBoatDetail} from '../parsers.mjs';
import {buildPlan} from './planner.mjs';
import {releaseAllowed} from './release.mjs';

const gap={start:'2027-01-01',end:'2027-01-03'};
const createApi='https://www.clickandboat.com/libs/Api/API.php?rquest=ProduitDisponibilite';
const responseRow={id:'900',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'};
const resultHtml='<li class="availability" data-availa-id="900" data-availa-from-date="2027-01-01 00:00:00" data-availa-to-date="2027-01-02 23:59:00" data-availa-type="Unavailable"></li>';
function createResponse(errorCode,patch={}){
  const data={ProduitId:'100004',DateDebut:gap.start+' 00:00:00',DateFin:gap.end+' 00:00:00',ProduitDisponibiliteTypeId:'Unavailable',...patch.body};
  return {url:()=>patch.url??createApi,request:()=>({url:()=>patch.requestUrl??createApi,method:()=>patch.method??'POST',postData:()=>patch.rawBody??JSON.stringify(data)}),
    status:()=>200,ok:()=>true,headers:()=>({'content-type':patch.mime??'application/json; charset=utf-8'}),json:async()=>Object.hasOwn(patch,'json')?patch.json:
      [0,'0'].includes(errorCode)?{ErreurCode:errorCode,Resultat:resultHtml}:{ErreurCode:errorCode,ErreurMessage:'rejected'}};
}
async function observedResponse(predicate,response){if(!predicate(response))throw Error('timeout');return response;}

test('Click&Boat ignores foreign create-shaped responses before inferring any ownership',async()=>{
  const adapter=new ClickAndBoatAdapter({}),target={listing_id:'100004'};let reads=0;
  const response={url:()=> 'https://unrelated.example/?rquest=ProduitDisponibilite',
    request:()=>({method:()=> 'POST',postData:()=>JSON.stringify({ProduitId:'100004',__verb:'DELETE'})}),
    status:()=>200,ok:()=>true,json:async()=>({ErreurCode:0})};
  Object.assign(adapter,{listing:target.listing_id,before:[],direct:true,page:{
    waitForResponse:async predicate=>{if(predicate(response))return response;throw Error('timeout');},evaluate:async()=>{},
    reload:async()=>({status:()=>200,url:()=> 'https://www.clickandboat.com/uk/account/listing/edit/100004:7',headers:()=>({'content-type':'text/html'})}),
    waitForSelector:async()=>{},$$eval:async()=>{reads++;return [{id:'900',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'}];}
  }});
  await assert.rejects(adapter.submit(target,gap,async()=>{},{guard:async()=>{}}),/platform_submission_not_observed/);
  assert.equal(reads,0);
});

for(const errorCode of [42,'42',undefined,null,false,''])test('Click&Boat application rejection or unknown outcome cannot acquire manual ownership: '+String(errorCode),async()=>{
  const target={listing_id:'100004'},adapter=new ClickAndBoatAdapter({});let reads=0,evidence;
  Object.assign(adapter,{listing:target.listing_id,before:[],direct:true,page:{
    waitForResponse:async predicate=>observedResponse(predicate,createResponse(errorCode)),
    evaluate:async()=>{},reload:async()=>({status:()=>200,url:()=> 'https://www.clickandboat.com/uk/account/listing/edit/100004:7',headers:()=>({'content-type':'text/html'})}),
    waitForSelector:async()=>{},$$eval:async()=>{reads++;return [{id:'900',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'}];}
  }});
  await assert.rejects(adapter.submit(target,gap,async value=>{evidence=value;},{guard:async()=>{}}),/platform_rejected/);
  assert.equal(evidence.error_code,errorCode??null);assert.equal(reads,0,'a rejected request cannot take ownership from a later matching row');
});

for(const errorCode of [undefined,0,'0'])test('Click&Boat Resultat creation identity requires a new exact matching interval: '+typeof errorCode,async()=>{
  const target={listing_id:'100004'},adapter=new ClickAndBoatAdapter({});
  Object.assign(adapter,{listing:target.listing_id,before:[],direct:true,page:{
    waitForResponse:async predicate=>observedResponse(predicate,createResponse(errorCode,{json:{Resultat:resultHtml,...(errorCode===undefined?{}:{ErreurCode:errorCode})}})),evaluate:async(_fn,arg)=>typeof arg==='string'?responseRow:undefined,
    reload:async()=>({status:()=>200,url:()=> 'https://www.clickandboat.com/uk/account/listing/edit/100004:7',headers:()=>({'content-type':'text/html'})}),
    waitForSelector:async()=>{},$$eval:async()=>[{id:'900',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'}]
  }});
  assert.equal((await adapter.submit(target,gap,async()=>{},{guard:async()=>{}})).id,'900');
  adapter.page.$$eval=async()=>[{id:'901',from:'2027-01-01 00:00:00',to:'2027-01-03 23:59:00',type:'Unavailable'}];
  await assert.rejects(adapter.submit(target,gap,async()=>{},{guard:async()=>{}}),/created_record_mismatch/);
});

test('Click&Boat receipt predicate binds response and request URLs, create verb, boat, dates and block type',async()=>{
  const invalid=[
    {url:'https://unrelated.example/?rquest=ProduitDisponibilite'},
    {requestUrl:'https://unrelated.example/?rquest=ProduitDisponibilite'},
    {url:createApi+'&extra=1'},{url:createApi.replace('API.php','other.php')},
    {url:createApi.replace('https:','http:')},{url:createApi.replace('www.clickandboat.com','www.clickandboat.com.evil.example')},
    {method:'PUT'},{method:'DELETE'},{body:{__verb:'DELETE'}},{body:{__verb:'GET'}},{body:{__verb:null}},
    {body:{Id:'900'}},{body:{ProduitId:'other'}},{body:{ProduitDisponibiliteTypeId:'Booked'}},
    {body:{DateDebut:'2027-01-02 00:00:00'}},{body:{DateFin:'2027-01-02 00:00:00'}},
    {body:{DateDebut:'2027-01-01 14:00:00'}},{body:{DateFin:'2027-01-03'}},{rawBody:'[]'},{rawBody:'malformed'}
  ];
  for(const patch of invalid){
    const adapter=new ClickAndBoatAdapter({});let reads=0;
    Object.assign(adapter,{listing:'100004',before:[],direct:true,page:{
      waitForResponse:async predicate=>observedResponse(predicate,createResponse(0,patch)),evaluate:async()=>{},reload:async()=>{reads++;}
    }});
    await assert.rejects(adapter.submit({listing_id:'100004'},gap,async()=>{},{guard:async()=>{}}),/platform_submission_not_observed/,JSON.stringify(patch));
    assert.equal(reads,0);
  }
});

test('Click&Boat success requires a JSON object response and cannot accept HTML or an array',async()=>{
  for(const patch of [{mime:'text/html'},{mime:'text/plain'},{json:[]},{json:null},{json:'success'},{json:0}]){
    const adapter=new ClickAndBoatAdapter({});let reads=0;
    Object.assign(adapter,{listing:'100004',before:[],direct:true,page:{
      waitForResponse:async predicate=>observedResponse(predicate,createResponse(0,patch)),evaluate:async()=>{},reload:async()=>{reads++;}
    }});
    await assert.rejects(adapter.submit({listing_id:'100004'},gap,async()=>{},{guard:async()=>{}}),/platform_rejected_or_unverified/);assert.equal(reads,0);
  }
});

test('Click&Boat foreign API configuration prevents direct create and owned DELETE',async()=>{
  const fixed='https://www.clickandboat.com',owned={id:'899',type:'Unavailable'};
  for(const origin of [fixed,'https://unrelated.example'])for(const apiBase of [fixed+'/libs/Api/API.php',fixed+'/bad']){
    const adapter=new ClickAndBoatAdapter({});let creates=0,deletes=0;
    const context={location:{origin},CAB:{API_URL:apiBase,API_V3_URL:apiBase===fixed+'/bad'?fixed+'/bad':fixed+'/api/v3',
      Account:{Ad:{createAvailability(){creates++;}}},Any:{parseDate:s=>s}},
      document:{querySelector:()=>null},jQuery:{ajax:()=>{deletes++;return{done:fn=>{fn();return{fail(){}};}};}}};context.window=context;
    Object.assign(adapter,{listing:'100004',before:[owned],direct:true,page:{
      waitForResponse:async predicate=>observedResponse(predicate,createResponse(0)),
      evaluate:async(fn,arg)=>typeof arg==='string'&&arg.startsWith('<li')?responseRow:runInNewContext('('+fn.toString()+')(arg)',{...context,arg}),
      reload:async()=>{throw Error('readback_boundary');}
    }});
    const valid=origin===fixed&&apiBase===fixed+'/libs/Api/API.php';
    await assert.rejects(adapter.submit({listing_id:'100004'},gap,async()=>{},{guard:async()=>{}}),valid?/readback_boundary/:/owner_api_scope_changed/);
    if(valid)await adapter.remove({listing_id:'100004'},owned,{guard:async()=>{}});
    else await assert.rejects(adapter.remove({listing_id:'100004'},owned,{guard:async()=>{}}),/release_api_unavailable/);
    assert.equal(creates,valid?1:0);assert.equal(deletes,valid?1:0);
  }
});

test('MMK unchanged unsubmitted Option may still be cancelled after a passing final guard',async()=>{
  const original={id:'new-draft',yacht:{id:'1'},statusId:'2',clientId:'-1',guestId:null,paidAmount:0,payments:[]};
  const adapter=new MmkAdapter({});let guards=0,writes=0;const evidence=[];
  adapter.client={create:async()=>original.id,get:async()=>structuredClone(original),available:async()=>false,save:async model=>{writes++;assert.equal(model.statusId,'5');return model;}};
  await assert.rejects(adapter.submit({listing_id:'1'},gap,async value=>evidence.push(value),{
    id:'intent',causes:['samboat:1'],guard:async()=>{guards++;}
  }),/mmk_dates_not_available/);
  assert.equal(writes,1);assert.equal(guards,2);assert.equal(evidence.at(-1).cancelled,true);
});

test('MMK rejected draft cancellation rechecks the guard after availability and its final asynchronous read',async()=>{
  const original={id:'new-draft',yacht:{id:'1'},statusId:'2',clientId:'-1',guestId:null,paidAmount:0,payments:[]};
  const adapter=new MmkAdapter({});let changed=false,guards=0,writes=0;const evidence=[];
  adapter.client={create:async()=>original.id,get:async()=>structuredClone(original),available:async()=>{changed=true;return false;},save:async model=>{writes++;return model;}};
  await assert.rejects(adapter.submit({listing_id:'1'},gap,async value=>evidence.push(value),{
    id:'intent',causes:['samboat:1'],guard:async()=>{guards++;if(changed)throw Error('executor_cancelled');}
  }),/executor_cancelled/);
  assert.equal(writes,0);assert.equal(guards,2);assert.equal(evidence.at(-1).draft_id,original.id);
  assert.equal(evidence.some(item=>item.cancelled===true),false);
});

test('Click&Boat cannot infer whole-day coverage from invalid source clock values',()=>{
  const valid={id:'900',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'};
  for(const field of ['from','to'])for(const time of ['24:00:00','99:00:00','23:60:00','23:59:60'])
    assert.throws(()=>normalizeRows([{...valid,[field]:valid[field].slice(0,11)+time}]),/calendar_schema_changed/);
});

test('MMK API-shaped globals on another origin never certify the authenticated editor',()=>{
  const state=runInNewContext('('+mmkEntryState.toString()+')()',{
    location:new URL('https://other.example/wbm2/app/my_bookings/editor.jsp'),
    document:{querySelector:()=>null},ReservationsAPI:{getData(){return {serviceId:'0000',isCharter:true};}}
  });
  assert.equal(state,null);
});

test('documented SamBoat deposit aliases require matching paid detail before reverse protection and never prove cancellation',()=>{
  // Official help article 268 semantics, synthetic variants of an existing
  // observed layout. These two labels have not been seen on the live account.
  const stamp='2026-09-20T12:00:00.000Z',now=Date.parse(stamp),slug='seacat-open-40-tidewyn-discovery-2';
  const status={platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(source=>[source,{mode:'dynamic',last_success_at:stamp,last_error:null}]))};
  const original=readFileSync(new URL('../evidence/sb-1502428-body.txt',import.meta.url),'utf8');
  for(const label of ['Deposit paid only','Validated/Deposit paid']){
    const list=parseSamBoatListCard({url:'https://www.samboat.com/private/reservation/1502428',text:'1502428\n01 - 08 Jan 2027 in the morning\nSeacat 40 Open\n$22,443.72\n'+label},{verifiedAt:stamp});
    const input={url:list.url,boataround_slug:slug,current_status:list.status,verifiedAt:stamp,bodyText:original.replace('\nDeposit paid\n','\n'+label+'\n')};
    const record=parseSamBoatDetail(input);assert.equal(record.status,'deposit_paid');assert.equal(record.amount,list.amount);
    const plan=buildPlan({boataround:[],clickandboat:[],samboat:[record],mmk:[],nausys:[]},status,{now});assert.equal(plan.causes.length,1);assert.deepEqual(plan.excluded,[]);
    const target=plan.targets.find(target=>target.boat===slug&&target.target==='clickandboat');
    assert.deepEqual(target.segments,[{start:'2027-01-01',end:'2027-01-09',causes:['samboat:1502428']}]);
    assert.equal(releaseAllowed({start:'2027-01-01',end:'2027-01-09',causes:['samboat:1502428'],created:{id:'owned',start:'2027-01-01',end:'2027-01-09'}},target,now),false);
    assert.throws(()=>parseSamBoatDetail({...input,current_status:'pending'}),{code:'STATUS_MISMATCH'});
    assert.throws(()=>parseSamBoatDetail({...input,bodyText:input.bodyText.replace('To be paid online','Missing payment amount')}));
    for(const mismatch of [{status:'paid'},{platform_status:label+' pending'},{platform_status:'Cancellation request'}]){
      const rejected=buildPlan({boataround:[],clickandboat:[],samboat:[{...record,...mismatch}],mmk:[],nausys:[]},status,{now});
      assert.equal(rejected.causes.length,0);assert.equal(rejected.excluded[0].reason,'payment_unverified');
    }
    for(const inactive of ['pending','completed','refused']){
      const ignored=buildPlan({boataround:[],clickandboat:[],samboat:[{...record,status:inactive}],mmk:[],nausys:[]},status,{now});
      assert.equal(ignored.causes.length,0);assert.ok(ignored.targets.every(target=>target.release_proof.orders.length===0));
    }
    const conflicted=buildPlan({boataround:[],clickandboat:[],samboat:[{...record,status:'cancelled'}],mmk:[],nausys:[]},status,{now});
    assert.equal(conflicted.excluded[0].reason,'cancellation_conflict');assert.ok(conflicted.targets.filter(target=>target.boat===slug).every(target=>target.release_proof.ready===false));
  }
});
