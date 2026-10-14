import test from 'node:test';
import assert from 'node:assert/strict';
import {FleetPhoneAgent,PHONE_AGENT_KEY,PHONE_INTERVAL_MS} from './phone-agent.mjs';
import {PhoneAgent,INTERVAL} from './phone-server/core.mjs';

const ORIGIN='https://schedule-fixture.invalid';
const TOKEN='S'.repeat(43);
const START=Date.parse('2026-09-10T07:00:00Z');

async function fixture() {
  let clock=START;
  const values=new Map();
  const storage={
    async get(key){return structuredClone(values.get(key));},
    async put(key,value){values.set(key,structuredClone(value));},
    async transaction(work){return work(this);},
    async deleteAlarm(){},
  };
  const worker=new FleetPhoneAgent({storage,now:()=>clock,ingest:async()=>({results:[]}),registryStatus:async()=>({latest_platform_success_at:null})});
  const request=(path,body,user=false)=>new Request(ORIGIN+path,{
    method:body===undefined?'GET':'POST',
    headers:{...(user?{Origin:ORIGIN,'Sec-Fetch-Site':'same-origin'}:{Authorization:'Bearer '+TOKEN}),...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const user=async(path,body)=>{
    const response=await worker.user(request('/api/agent/'+path,body,true));
    assert.ok(response.ok,'operator '+path+' HTTP '+response.status);
    return response.json();
  };
  const machine=async(path,body)=>{
    const response=await worker.machine(request('/api/agent/'+path,body));
    assert.ok(response.ok,'phone '+path+' HTTP '+response.status);
    return response.json();
  };
  const pair=async()=>{
    const code=await user('pairing-code',{});
    await machine('pair',{pairing_code:code.pairing_code,name:'Offline schedule fixture'});
  };
  await pair();
  return {worker,storage,user,machine,pair,now:()=>clock,advance:ms=>{clock+=ms;}};
}

test('pause and re-enable preserve the real phone schedule and do not advertise an early run',async()=>{
  const h=await fixture();
  assert.equal(PHONE_INTERVAL_MS,INTERVAL);
  const due=new Date(h.now()+INTERVAL).toISOString();
  await h.user('config',{enabled:true});
  await h.machine('heartbeat',{state:'idle',next_run_at:due});
  await h.user('config',{enabled:false});
  h.advance(60000);
  await h.user('config',{enabled:true});
  assert.equal((await h.worker.publicStatus()).next_run_at,due);

  // Exercise the actual phone tick against the actual worker poll. The run
  // body is an offline stub: no browser, platform, filesystem or network.
  let runs=0;
  const phone=new PhoneAgent({
    config:{paired:true},now:h.now,
    remote:{poll:()=>h.machine('poll'),heartbeat:body=>h.machine('heartbeat',body)},
  });
  phone.state.next_run_at=due;
  Object.assign(phone,{
    flush:async()=>{},saveState:async()=>{},
    run:async()=>{runs++;phone.state.next_run_at=new Date(h.now()+INTERVAL).toISOString();await phone.remote.heartbeat({state:'idle',next_run_at:phone.state.next_run_at});return {ok:true};},
  });
  await phone.tick();
  assert.equal(runs,0);
  assert.equal((await h.worker.publicStatus()).next_run_at,phone.state.next_run_at);
  h.advance(INTERVAL-60000);
  await phone.tick();
  assert.equal(runs,1);
  assert.equal((await h.worker.publicStatus()).next_run_at,new Date(h.now()+INTERVAL).toISOString());
  assert.equal((await h.worker.publicStatus()).order_sync.latest_platform_success_at,null);
});

test('a paused manual completion retains its new due time privately and restores it on enable',async()=>{
  const h=await fixture();
  const run=await h.user('run',{});
  assert.equal((await h.machine('poll')).requested_run_id,run.requested_run_id);
  h.advance(180000);
  const due=new Date(h.now()+INTERVAL).toISOString();
  const ack=await h.machine('heartbeat',{requested_run_id:run.requested_run_id,completed:true,state:'idle',next_run_at:due});
  assert.equal(ack.next_run_at,null);
  assert.equal((await h.machine('poll')).next_run_at,null);
  assert.equal((await h.worker.publicStatus()).next_run_at,null);
  assert.equal((await h.worker.dataStatus({})).next_attempt_at,null);
  assert.equal((await h.storage.get(PHONE_AGENT_KEY)).next_run_at,due);
  assert.equal((await h.worker.publicStatus()).manual_run.state,'awaiting_upload');
  await h.user('config',{enabled:true});
  assert.equal((await h.worker.publicStatus()).next_run_at,due);
  assert.equal((await h.machine('poll')).next_run_at,due);
});

test('enable without an observed phone schedule never fabricates a timestamp',async()=>{
  const h=await fixture();
  await h.user('config',{enabled:true});
  const state=await h.worker.publicStatus();
  assert.equal(state.enabled,true);
  assert.equal(state.next_run_at,null);
  assert.equal((await h.machine('poll')).next_run_at,null);
  assert.equal(state.order_sync.latest_platform_success_at,null);
});

test('queue receipt carries the original server creation time when clicks coalesce and a later task gets its own time',async()=>{
  const h=await fixture();
  const first=await h.user('run',{});
  assert.equal(first.requested_at,new Date(h.now()).toISOString());
  h.advance(10000);
  const repeat=await h.user('run',{});
  assert.deepEqual(repeat,first);
  await h.machine('heartbeat',{requested_run_id:first.requested_run_id,completed:true,state:'idle'});
  const later=await h.user('run',{});
  assert.notEqual(later.requested_run_id,first.requested_run_id);
  assert.equal(later.requested_at,new Date(h.now()).toISOString());
  assert.equal((await h.worker.publicStatus()).manual_run.requested_at,later.requested_at);
  assert.equal((await h.worker.publicStatus()).manual_run.state,'queued');
  assert.deepEqual((await h.worker.publicStatus()).manual_run.results,{});
});

test('duplicate old ACK cannot replace a paused schedule and new pairing removes the previous schedule',async()=>{
  const h=await fixture();
  const run=await h.user('run',{});
  await h.machine('heartbeat',{requested_run_id:run.requested_run_id,completed:true,state:'idle',next_run_at:new Date(h.now()+INTERVAL).toISOString()});
  h.advance(60000);
  const latest=new Date(h.now()+INTERVAL).toISOString();
  await h.machine('heartbeat',{state:'idle',next_run_at:latest});
  await h.machine('heartbeat',{requested_run_id:run.requested_run_id,completed:true,state:'idle',next_run_at:new Date(START-120000).toISOString()});
  await h.user('config',{enabled:true});
  assert.equal((await h.worker.publicStatus()).next_run_at,latest);
  await h.pair();
  await h.user('config',{enabled:true});
  assert.equal((await h.worker.publicStatus()).next_run_at,null);
});
