import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {MmkClient} from './mmk-client.mjs';

function clientWithFetch(fetch){
 let calls=0;
 const client=new MmkClient({evaluate:async(fn,arg)=>runInNewContext('('+fn.toString()+')(arg)',{arg,URLSearchParams,fetch:async(...args)=>{calls++;return fetch(...args);}})},async()=>{throw Error('write_must_not_reconnect');});
 return {client,calls:()=>calls};
}
test('MMK create uses its observed authenticated form request and returns the exact receipt once',async()=>{
 const {client,calls}=clientWithFetch(async(url,options)=>{
  assert.equal(url,'/wbm2/page.html');assert.equal(options.method,'POST');
  assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)),{view:'Reservations',responseType:'JSON',action:'createReservation',yachtId:'1000000000000000002',startDate:'2026-12-05'});
  return {ok:true,json:async()=>({success:true,value:{id:'new-id'}})};
 });
 assert.equal(await client.create('1000000000000000002','2026-12-05'),'new-id');assert.equal(calls(),1);
});
test('network failure, HTTP rejection, and non-JSON create responses stay uncertain without repeated writes',async()=>{
 for(const [response,error] of [
  [()=>{throw Error('connection lost');},/mmk_create_network_uncertain/],
  [()=>({ok:false,status:401}),/mmk_create_http_401_uncertain/],
  [()=>({ok:false,status:503}),/mmk_create_http_503_uncertain/],
  [()=>({ok:true,json:async()=>{throw Error('HTML instead of receipt');}}),/mmk_create_response_uncertain/]
 ]){
  const {client,calls}=clientWithFetch(response);
  await assert.rejects(client.create('boat','2026-12-05'),error);assert.equal(calls(),1);
 }
});
test('empty or malformed create acknowledgement never becomes an adopted booking',async()=>{
 for(const receipt of [null,undefined,{}, {success:false},{success:true,value:{}},{success:true,value:{id:1}}]){
  const {client,calls}=clientWithFetch(()=>({ok:true,json:async()=>receipt}));
  await assert.rejects(client.create('boat','2026-12-05'),/mmk_create_uncertain/);assert.equal(calls(),1);
 }
});
test('shutdown prevents the first create request',async()=>{
 let requests=0;const client=new MmkClient({evaluate:async()=>{requests++;}},null,null,()=>true);
 await assert.rejects(client.create('boat','2026-12-05'),/phone_shutdown/);assert.equal(requests,0);
});
test('malformed MMK read or save results produce meaningful failure instead of property-access errors',async()=>{
 for(const value of [undefined,null]){
  const client=new MmkClient({evaluate:async()=>value});
  await assert.rejects(client.list(),/mmk_list_incomplete/);
  await assert.rejects(client.get('id'),/mmk_record_read_failed/);
  await assert.rejects(client.getMany(['id']),/mmk_record_read_failed/);
  await assert.rejects(client.save({id:'id'}),/mmk_save_failed/);
 }
});
