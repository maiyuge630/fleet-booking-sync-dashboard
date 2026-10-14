import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {BoataroundAdapter,boataroundReadWindow} from './boataround-adapter.mjs';
import {FLEET,BOATAROUND_ACCOUNT_ID} from '../parsers.mjs';
const endpoint=`https://partner-api.boataround.com/v1/charters/${BOATAROUND_ACCOUNT_ID}/availabilities`;
const ids=['0000000000000000000000b1','0000000000000000000000b2','0000000000000000000000b3','0000000000000000000000b4','0000000000000000000000b5','0000000000000000000000b6','0000000000000000000000b7'];
const add=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const target={boat:FLEET[3].slug,listing_id:FLEET[3].slug};
const day={id:ids[3]+':2027-01-01',start:'2027-01-01',end:'2027-01-02',type:3};
function fixture(items=[]){
 const f={items:structuredClone(items),writes:[],query:'from=2026-09-20&to=2028-03-20&limit=-1',readStatus:200,readMime:'application/json',writeStatus:200,readCalls:0};
 const context=vm.createContext({AbortSignal,fetch:async(url,options)=>{
   assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'test-authorized-session');
   if(!options.method){
     f.readCalls++;if(f.beforeRead)f.beforeRead();
     const data={count:7,data:ids.map((boat_id,i)=>({boat_id,type:1,items:i===3?f.items:[]}))};
     if(f.changeData)f.changeData(data);
     return new Response(JSON.stringify(data),{status:f.readStatus,headers:{'Content-Type':f.readMime}});
   }
   assert.equal(url,endpoint);const body=JSON.parse(options.body);f.writes.push({method:options.method,body});
   assert.equal(body.boatId,ids[3]);assert.equal(body.from,body.to);
   if(f.timeout)throw Error('simulated_timeout');
   if(f.writeStatus===200&&!f.ignoreWrite){
     if(options.method==='POST')f.items.push({from:body.from,to:body.to,type:3});
     else if(options.method==='DELETE')f.items=f.items.flatMap(item=>body.from<item.from||body.from>item.to?[item]:[
       ...(item.from<body.from?[{...item,to:add(body.from,-1)}]:[]),...(body.from<item.to?[{...item,from:add(body.from,1)}]:[])]);
     if(f.afterMutation)f.afterMutation();
   }
   return new Response('{}',{status:f.writeStatus});
 }});
 const page={url:()=>`https://partner.boataround.com/en/${BOATAROUND_ACCOUNT_ID}/availability`,on:(_event,fn)=>{f.requestListener=fn;},goto:async()=>{f.requestListener({url:()=>endpoint+'?'+f.query,method:()=>'GET',headers:()=>({authorization:'test-authorized-session'})});},waitForFunction:async()=>{},evaluate:async(fn,arg)=>{
   context.arg=arg;return structuredClone(await vm.runInContext('('+fn.toString()+')(arg)',context));
 }};
 f.adapter=new BoataroundAdapter({openPage:async()=>page,closePage:async()=>{}});return f;
}

test('Boataround read window requires the exact account, complete query and valid inclusive dates',()=>{
 assert.deepEqual(boataroundReadWindow(endpoint+'?from=2026-12-31&to=2027-01-01&limit=-1'),{start:'2026-12-31',end:'2027-01-02'});
 for(const suffix of ['from=2026-12-31&to=2027-01-01','from=2026-12-31&to=2027-01-01&limit=1','from=2026-12-31&to=2027-01-01&limit=-1&boatId=1','from=2026-12-31&to=2027-01-01&limit=-1&from=2020-01-01','from=2027-02-30&to=2027-03-01&limit=-1','from=2027-03-01&to=2027-02-01&limit=-1'])assert.throws(()=>boataroundReadWindow(endpoint+'?'+suffix));
 assert.throws(()=>boataroundReadWindow(endpoint.replace(BOATAROUND_ACCOUNT_ID,'other')+'?from=2026-12-31&to=2027-01-01&limit=-1'));
});
test('Boataround single-day reopening preserves both adjacent manual days in a merged block',async()=>{
 const f=fixture([{from:'2026-12-31',to:'2027-01-02',type:3}]);await f.adapter.read(target);let guarded=0;
 await f.adapter.remove(target,day,{guard:async()=>guarded++});
 assert.equal(guarded,1);assert.deepEqual(f.writes,[{method:'DELETE',body:{boatId:ids[3],from:'2027-01-01',to:'2027-01-01'}}]);
 assert.deepEqual(f.adapter.before.map(b=>b.start),['2026-12-31','2027-01-02']);
});
test('Boataround managed close uses a single date and can reopen only after fresh matching readback',async()=>{
 const f=fixture();await f.adapter.read(target);await f.adapter.prepare(target,day);
 const created=await f.adapter.submit(target,day,null,{guard:async()=>{}});assert.deepEqual(created,day);
 await f.adapter.read(target);await f.adapter.remove(target,created,{guard:async()=>{}});
 assert.deepEqual(f.writes.map(w=>w.method),['POST','DELETE']);assert.deepEqual(f.items,[]);
});
test('Boataround rejects native reservations, wrong identity, multi-day and outside-window openings',async()=>{
 for(const altered of [{...day,type:5},{...day,id:'other'},{...day,end:'2027-01-03'}, {...day,start:'2028-04-01',end:'2028-04-02',id:ids[3]+':2028-04-01'}]){
   const f=fixture([{from:day.start,to:day.start,type:3}]);await f.adapter.read(target);await assert.rejects(f.adapter.remove(target,altered));assert.equal(f.writes.length,0);
 }
 const f=fixture([{from:day.start,to:day.start,type:5}]);await f.adapter.read(target);await assert.rejects(f.adapter.remove(target,day),/owned_day_changed/);assert.equal(f.writes.length,0);
});
test('Boataround refresh detects changed target and final source/manual-hold guard blocks the mutation',async()=>{
 const f=fixture([{from:day.start,to:day.start,type:3}]);await f.adapter.read(target);f.items.push({from:'2027-01-03',to:'2027-01-03',type:3});
 await assert.rejects(f.adapter.remove(target,day),/owned_day_changed/);assert.equal(f.writes.length,0);
 const g=fixture([{from:day.start,to:day.start,type:3}]);await g.adapter.read(target);
 await assert.rejects(g.adapter.remove(target,day,{guard:async()=>{throw Error('manual_hold_changed');}}),/manual_hold_changed/);assert.equal(g.writes.length,0);
});
test('Boataround failed or misleading DELETE never retries and never claims confirmed open',async()=>{
 for(const fault of [{timeout:true},{writeStatus:500},{ignoreWrite:true},{afterMutation(){this.items.push({from:'2027-01-05',to:'2027-01-05',type:3});}}]){
   const f=fixture([{from:day.start,to:day.start,type:3}]);Object.assign(f,fault);await f.adapter.read(target);
   await assert.rejects(f.adapter.remove(target,day));assert.equal(f.writes.length,1);
 }
});
test('Boataround will not close gaps outside the observed coverage or overwrite a new reservation',async()=>{
 const f=fixture();await f.adapter.read(target);await assert.rejects(f.adapter.prepare(target,{start:'2028-04-01',end:'2028-04-02'}),/scope_unverified/);assert.equal(f.writes.length,0);
 await f.adapter.prepare(target,day);f.items=[{from:day.start,to:day.start,type:5}];await assert.rejects(f.adapter.submit(target,day),/target_changed/);assert.equal(f.writes.length,0);
});
test('Boataround read refuses incomplete fleet, unexpected content and failed HTTP instead of treating them as free days',async()=>{
 for(const fault of [{readStatus:403},{readStatus:500},{readMime:'text/html'},{changeData(d){d.count=6;}},{changeData(d){d.data.pop();}},{changeData(d){d.data[3].type=2;}}]){
   const f=fixture();Object.assign(f,fault);await assert.rejects(f.adapter.read(target));assert.equal(f.writes.length,0);
 }
});
