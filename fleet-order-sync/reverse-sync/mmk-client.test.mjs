import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {reservationModel,MmkClient,bookingFingerprint,mmkEntryState} from './mmk-client.mjs';
function verifiedPage(read,{serviceId='0000',isCharter=true,onOpen=()=>{}}={}){
 return {goto:async()=>onOpen(),waitForFunction:async()=>{},evaluate:async(fn,arg)=>
  fn===mmkEntryState?'ready':fn.toString().includes('ReservationsAPI.getData')?{serviceId,isCharter}:read(fn,arg)};
}
test('saved login recovery is bounded and never bypasses post-login account verification',async()=>{
 for(const scenario of ['success','still_logged_out','wrong_account']){
  let recovered=0;const page={goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?(!recovered||scenario==='still_logged_out'?'auth_required':'ready'):{serviceId:scenario==='wrong_account'?'other':'0000',isCharter:true}};
  const client=new MmkClient(page,null,async()=>{recovered++;});
  if(scenario==='success')await client.open();else await assert.rejects(client.open(),scenario==='wrong_account'?/mmk_account_mismatch/:/mmk_auth_required/);
  assert.equal(recovered,1);
 }
});
test('ownership ignores generated UI metadata but detects dates, notes, customer and payment edits',()=>{
 const m={id:'1',yacht:{id:'boat'},statusId:'1',checkInDate:'2027-01-01 00:00:00',finalPrice:0,paidAmount:0};
 assert.equal(bookingFingerprint(m),bookingFingerprint({...m,availableExtras:[{id:'dynamic'}],mainActions:['different']}));
 for(const change of [{checkInDate:'2027-01-02 00:00:00'},{remarks:'human edit'},{clientId:'person'},{paidAmount:1},{statusId:'5'}])assert.notEqual(bookingFingerprint(m),bookingFingerprint({...m,...change}));
});
test('Reservation uses literal local dates, boards 14:00 and returns 10:00, does not record a payment',()=>{
 const initial={id:'1',payments:[],paidAmount:0,invoiceItems:[{price:200}],statusId:'2'};
 const model=reservationModel(initial,{start:'2027-01-01',end:'2027-01-09',marker:'fleet:test'});
 assert.equal(model.checkInDate,'2027-01-01 14:00:00');assert.equal(model.checkOutDate,'2027-01-09 10:00:00');assert.equal(model.statusId,'1');
 assert.equal(model.paidAmount,0);assert.deepEqual(model.payments,[]);assert.deepEqual(model.invoiceItems,[]);
 assert.equal(initial.invoiceItems.length,1);
});
test('MMK rejects incomplete read and repeated pages',async()=>{
 const client=new MmkClient({evaluate:async()=>({data:[],itemsLeft:1,timedOut:true})});
 await assert.rejects(client.list(),/incomplete/);
 client.page.evaluate=async()=>({data:[{id:'1'}],itemsLeft:1,timedOut:false});
 await assert.rejects(client.list(),/duplicate/);
});
test('save returns the persisted second read, including platform default extras',async()=>{
 const client=new MmkClient({evaluate:async()=>({success:true})});let reads=0;
 client.get=async id=>({id,statusId:'1',invoiceItems:++reads===1?[]:[{name:'default extra'}]});
 const result=await client.save({id:'owned'});
 assert.equal(reads,2);assert.equal(result.invoiceItems.length,1);
});
test('batched read is bounded and fails on a mismatched record',async()=>{
 const sizes=[],client=new MmkClient({evaluate:async(fn,ids)=>{sizes.push(ids.length);return ids.map(id=>({success:true,value:{id}}));}});
 assert.equal((await client.getMany(['1','2','3','4','5'])).length,5);assert.deepEqual(sizes,[4,1]);
 client.page.evaluate=async()=>[{success:true,value:{id:'wrong'}}];
 await assert.rejects(client.getMany(['1']),/read_failed/);
});
test('read timeout may wake and retry; uncertain create is never repeated',async()=>{
 let calls=0,wakes=0;
 const fresh=verifiedPage(async()=>{calls++;return {success:true,value:{id:'1'}};});
 const client=new MmkClient({evaluate:async()=>{calls++;throw Error('timeout');}},async()=>{wakes++;return fresh;});
 assert.equal((await client.get('1')).id,'1');assert.equal(wakes,1);assert.equal(calls,2);
 calls=0;client.page.evaluate=async()=>{calls++;throw Error('write_timeout');};
 await assert.rejects(client.create('boat','2027-01-01'),/write_timeout/);
 assert.equal(calls,1);assert.equal(wakes,1);
});

test('MMK rejects impossible calendar dates before creating a reservation model',()=>{
 for(const [start,end] of [['2027-02-30','2027-03-05'],['2027-01-01','2027-13-01'],['2027-01-09','2027-01-09']])
  assert.throws(()=>reservationModel({},{start,end,marker:'test'}));
});

test('availability requires an explicit boolean and can wake-retry only the read',async()=>{
 let calls=0,wakes=0;
 const fresh=verifiedPage(async()=>{calls++;return {success:true,value:false};});
 const client=new MmkClient({evaluate:async()=>{calls++;throw Error('timeout');}},async()=>{wakes++;return fresh;});
 assert.equal(await client.available({id:'own',yachtId:'boat',start:'2027-01-01',end:'2027-01-02'}),false);
 assert.equal(calls,2);assert.equal(wakes,1);
 client.page.evaluate=async()=>({success:true,value:'true'});
 await assert.rejects(client.available({id:'own',yachtId:'boat',start:'2027-01-01',end:'2027-01-02'}),/availability_unverified/);
});

test('disconnected MMK Page is never reused and recovery verifies the replacement account first',async()=>{
 let oldReads=0,newReads=0,opens=0;
 const old={evaluate:async()=>{oldReads++;throw Error('old CDP disconnected');}};
 const fresh=verifiedPage(async()=>{assert.equal(opens,1);newReads++;return {success:true,value:{id:'1'}};},{onOpen:()=>{opens++;}});
 const client=new MmkClient(old,async()=>fresh);
 assert.equal((await client.get('1')).id,'1');assert.equal(client.page,fresh);
 assert.equal(oldReads,1);assert.equal(newReads,1);assert.equal(opens,1);
});

test('wrong replacement account prevents all retried data access',async()=>{
 let newReads=0;
 const client=new MmkClient({evaluate:async()=>{throw Error('timeout');}},async()=>verifiedPage(async()=>{newReads++;},{serviceId:'other'}));
 await assert.rejects(client.get('1'),/mmk_account_mismatch/);assert.equal(newReads,0);
});

test('MMK replacement read failure is not retried recursively',async()=>{
 let wakes=0,reads=0;
 const client=new MmkClient({evaluate:async()=>{throw Error('timeout');}},async()=>{wakes++;return verifiedPage(async()=>{reads++;throw Error('second timeout');});});
 await assert.rejects(client.get('1'),/second timeout/);assert.equal(wakes,1);assert.equal(reads,1);
});

test('shutdown during a failed read prevents browser recovery',async()=>{
 let closed=false,wakes=0;
 const client=new MmkClient({evaluate:async()=>{closed=true;throw Error('disconnected');}},async()=>{wakes++;},null,()=>closed);
 await assert.rejects(client.get('1'),/phone_shutdown/);assert.equal(wakes,0);
});

test('invalid or stale recovery Page fails closed',async()=>{
 const old={evaluate:async()=>{throw Error('timeout');}};
 for(const replacement of [undefined,old]){
  const client=new MmkClient(old,async()=>replacement);
  await assert.rejects(client.get('1'),/mmk_read_recovery_failed/);
 }
});

function entryState({url='https://portal.booking-manager.com/wbm2/app/login_register/login_to_continue.jsp',password=true,api}={}){
 return runInNewContext('('+mmkEntryState.toString()+')()',{
  location:new URL(url),document:{querySelector:selector=>password&&selector==='input[name="login_password"][type="password"]'?{}:null},
  ...(api!==undefined?{ReservationsAPI:api}:{})
 });
}

test('only the observed MMK login route with its named password field is auth-required',()=>{
 assert.equal(entryState(),'auth_required');
 assert.equal(entryState({password:false}),null);
 assert.equal(entryState({url:'https://other.example/wbm2/app/login_register/login_to_continue.jsp'}),null);
 assert.equal(entryState({url:'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp'}),null);
 assert.equal(entryState({url:'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp',password:false,api:{getData(){}}}),'ready');
 assert.equal(entryState({password:false,api:{}}),null);
});

test('expired MMK login fails promptly without account reads, wake or write retries',async()=>{
 let reads=0,wakes=0,navigations=0;const state=entryState();
 const client=new MmkClient({
  goto:async()=>{navigations++;},
  waitForFunction:async(fn,options)=>{assert.equal(fn,mmkEntryState);assert.equal(options.polling,250);assert.equal(options.timeout,20000);assert.equal(state,'auth_required');},
  evaluate:async fn=>{reads++;assert.equal(fn,mmkEntryState);return state;}
 },async()=>{wakes++;});
 await assert.rejects(client.open(),/mmk_auth_required/);
 assert.equal(reads,1);assert.equal(navigations,1);assert.equal(wakes,0);
});

test('MMK ready editor still requires the exact owner account and charter permission',async()=>{
 for(const [account,ok] of [[{serviceId:'0000',isCharter:true},true],[{serviceId:'other',isCharter:true},false],[{serviceId:'0000',isCharter:false},false]]){
  const client=new MmkClient({goto:async()=>{},waitForFunction:async()=>{},evaluate:async fn=>fn===mmkEntryState?'ready':account});
  if(ok)await client.open();else await assert.rejects(client.open(),/mmk_account_mismatch/);
 }
});

test('slow or failed editor without login evidence remains a loading failure and is not retried',async()=>{
 let reads=0,navigations=0,wakes=0;
 const client=new MmkClient({goto:async()=>{navigations++;},waitForFunction:async()=>{throw Error('loading_timeout');},evaluate:async()=>{reads++;}},async()=>{wakes++;});
 await assert.rejects(client.open(),/loading_timeout/);
 assert.equal(reads,0);assert.equal(navigations,1);assert.equal(wakes,0);
});

