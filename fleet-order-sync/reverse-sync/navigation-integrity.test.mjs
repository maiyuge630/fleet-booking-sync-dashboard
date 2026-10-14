import test from 'node:test';
import assert from 'node:assert/strict';
import {FLEET} from '../parsers.mjs';
import {SamBoatAdapter} from './samboat-adapter.mjs';
import {ClickAndBoatAdapter} from './clickandboat-adapter.mjs';

const boat=FLEET[3],gap={start:'2027-01-01',end:'2027-01-03'};
const response=(url,fault={})=>({status:()=>fault.status??200,url:()=>fault.url??url,
 headers:()=>({'content-type':fault.mime??'text/html; charset=utf-8'}),text:async()=>'<structurally intact old calendar>'});
function samBoatFixture(){
 const target={boat:boat.slug,listing_id:boat.samboat_id},url=`https://www.samboat.com/private/announcement/${boat.samboat_id}/calendar`;
 const f={target,url,fault:{},cache:[],domReads:0,writes:0,written:false};
 const rows=()=>f.written?[{id:999,start:'2027-01-01 00:00:00',end:'2027-01-02 00:00:00',halfday:0,unavailability_type:'unavailability',type:null}]:[];
 const page={setCacheEnabled:async v=>f.cache.push(v),goto:async()=>response(url,f.fault),waitForSelector:async()=>{},
  waitForFunction:async()=>{},evaluate:async(_fn,arg)=>{
   if(typeof arg==='string'){
    f.domReads++;return {boat:{id:boat.samboat_id,user_id:700000,name:boat.name.split(' | ')[1]},ids:[boat.samboat_id],rows:rows(),
     url:`https://www.samboat.com/private/announcement/${boat.samboat_id}/unavailability`};
   }
   f.writes++;f.written=true;if(f.afterWriteFault)f.fault=f.afterWriteFault;
   return {have_reservations:false,rows:[{id:999}]};
  }};
 f.adapter=new SamBoatAdapter({openPage:async()=>page,closePage:async()=>{}});return f;
}
function clickAndBoatFixture(){
 const target={boat:boat.slug,listing_id:boat.clickandboat_id},url=`https://www.clickandboat.com/uk/account/listing/edit/${boat.clickandboat_id}:7`;
 const f={target,url,fault:{},accountFault:{},cache:[],domReads:0,writes:0,written:false};
 const row={id:'999',from:'2027-01-01 00:00:00',to:'2027-01-02 23:59:00',type:'Unavailable'};
 const page={setCacheEnabled:async v=>f.cache.push(v),
  goto:async requested=>response(requested,requested.endsWith('/bookings')?f.accountFault:f.fault),
  reload:async()=>response(url,f.fault),waitForFunction:async()=>{},waitForSelector:async()=>{},
  $$eval:async()=>{f.domReads++;return f.written?[row]:[];},
  waitForResponse:async predicate=>{
   const api='https://www.clickandboat.com/libs/Api/API.php?rquest=ProduitDisponibilite';
   const result={status:()=>200,ok:()=>true,url:()=>api,headers:()=>({'content-type':'application/json'}),json:async()=>({Resultat:'<li class="availability"></li>'}),
    request:()=>({url:()=>api,method:()=> 'POST',postData:()=>JSON.stringify({ProduitId:target.listing_id,DateDebut:gap.start+' 00:00:00',DateFin:gap.end+' 00:00:00',ProduitDisponibiliteTypeId:'Unavailable'})})};
   assert.equal(predicate(result),true);return result;
  },
  evaluate:async(_fn,arg)=>{if(typeof arg==='string')return row;f.writes++;f.written=true;if(f.afterWriteFault)f.fault=f.afterWriteFault;}};
 f.adapter=new ClickAndBoatAdapter({openPage:async()=>page,closePage:async()=>{}});return f;
}

for(const [name,fixture] of [['SamBoat',samBoatFixture],['Click&Boat',clickAndBoatFixture]]){
 test(`${name} rejects stale calendar content on failed HTTP navigation before reading any rows`,async()=>{
  for(const status of [401,403,500,204,304]){
   const f=fixture();f.fault={status};
   await assert.rejects(f.adapter.read(f.target),status===401?/auth_required/:/calendar_read_failed/);
   assert.equal(f.domReads,0);assert.equal(f.writes,0);assert.deepEqual(f.cache,[false]);
  }
 });
 test(`${name} rejects wrong boat, external redirects, unexpected query and non-HTML response`,async()=>{
  for(const fault of [{url:'https://other.invalid/calendar'},{url:fixture().url.replace(/\d+/, '123456')},
   {url:fixture().url+'?filtered=true'},{mime:'application/json'}]){
   const f=fixture();f.fault=fault;
   await assert.rejects(f.adapter.read(f.target),/target_identity_unverified|calendar_read_failed/);
   assert.equal(f.domReads,0);assert.equal(f.writes,0);
  }
 });
 test(`${name} accepts normal fresh navigation and verifies the one created interval after writing`,async()=>{
  const f=fixture();assert.deepEqual((await f.adapter.read(f.target)).blocks,[]);
  if(name==='Click&Boat')f.adapter.direct=true;
  const created=await f.adapter.submit(f.target,gap,async()=>{},{guard:async()=>{}});
  assert.equal(created.start,gap.start);assert.equal(created.end,gap.end);assert.equal(f.writes,1);
  assert.deepEqual((await f.adapter.read(f.target)).blocks,[created]);assert.deepEqual(f.cache,[false]);
 });
 test(`${name} failed post-write navigation remains uncertain and never retries the write`,async()=>{
  for(const status of [401,403,500]){
   const f=fixture();await f.adapter.read(f.target);f.afterWriteFault={status};
   if(name==='Click&Boat')f.adapter.direct=true;
   const before=f.domReads;
   await assert.rejects(f.adapter.submit(f.target,gap,async()=>{},{guard:async()=>{}}),status===401?/auth_required/:/calendar_read_failed/);
   assert.equal(f.writes,1);assert.equal(f.domReads,before);
  }
 });
}
test('SamBoat observed login redirect remains authentication-required rather than an empty calendar',async()=>{
 const f=samBoatFixture();f.fault={url:'https://www.samboat.com/login?return=/private/reservations'};
 await assert.rejects(f.adapter.read(f.target),/auth_required/);assert.equal(f.domReads,0);
});
test('Click&Boat rejects failed profile navigation before visiting or trusting the calendar',async()=>{
 for(const status of [401,403,500]){
  const f=clickAndBoatFixture();f.accountFault={status};
  await assert.rejects(f.adapter.read(f.target),status===401?/auth_required/:/calendar_read_failed/);
  assert.equal(f.domReads,0);assert.equal(f.writes,0);
 }
});
test('Click&Boat preparation rejects an error reload before touching the date controls',async()=>{
 const f=clickAndBoatFixture();await f.adapter.read(f.target);const before=f.domReads;f.fault={status:500};
 await assert.rejects(f.adapter.prepare(f.target,gap),/calendar_read_failed/);
 assert.equal(f.domReads,before);assert.equal(f.writes,0);
});
