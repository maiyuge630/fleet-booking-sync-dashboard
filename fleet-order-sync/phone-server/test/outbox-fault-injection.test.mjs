// Fault injection only: private temporary directories, fake clock/collectors and
// in-memory remote receipts. No real platform, worker, phone, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PhoneAgent,WorkerClient,loadConfiguration,writeJSON,SOURCES,INTERVAL} from '../core.mjs';

const NOW=Date.parse('2026-09-10T08:00:00Z');
const MANUAL='00000000-0000-4000-8000-000000000011';
const snapshot=(source,at=NOW,status='paid')=>({source,run_id:source+'-'+at,checked_at:new Date(at).toISOString(),complete:true,
  orders:[{booking_id:'990001',status:['clickandboat','mmk','nausys'].includes(source)&&status==='paid'?'accepted':status,
    ...(source==='clickandboat'?{customer_payment_verified:true,customer_paid_amount:10}:{}),
    ...(source==='mmk'&&status==='paid'?{payment_basis:'mmk_client_assigned',platform_status:'Reservation'}:{}),
    ...(source==='nausys'&&status==='paid'?{payment_basis:'nausys_agency',platform_status:'Reservation'}:{})}],pagination:{complete:true}});
const error=code=>Object.assign(Error(code),{code});
async function harness(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-outbox-fault-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const config=await loadConfiguration(home);config.paired=true;let clock=NOW;
  const requests=[],committed=new Map(),heartbeats=[],collections=[];
  const remote={poll:async()=>({ok:true,enabled:false,requested_run_id:null}),heartbeat:async body=>{heartbeats.push(body);return {ok:true};},
    upload:async payload=>{
      requests.push(structuredClone(payload));const current=payload.snapshots[0],prior=committed.get(current.source);
      if(prior?.run_id===current.run_id)return {results:[{source:current.source,accepted:true,idempotent:true}]};
      if(prior&&Date.parse(prior.checked_at)>=Date.parse(current.checked_at))return {results:[{source:current.source,accepted:false,ignored:'older_snapshot'}]};
      committed.set(current.source,structuredClone(current));
      return {results:[{source:current.source,accepted:true,outcome:current.outcome==='failure'?'failure':'success'}]};
    }};
  const browser={connected:true,newPage:async()=>({setViewport:async()=>{},close:async()=>{}}),close:async()=>{},process:()=>({kill(){}})};
  const collectors=Object.fromEntries(SOURCES.map(source=>[source,async()=>{collections.push(source);return snapshot(source,clock);} ]));
  const create=()=>new PhoneAgent({home,config,remote,collectors,browserFactory:async()=>browser,now:()=>clock}).init();
  return {home,config,remote,committed,requests,heartbeats,collections,create,agent:await create(),advance:ms=>{clock+=ms;}};
}
const entries=async home=>(await fs.readdir(path.join(home,'outbox'))).filter(name=>name.endsWith('.json'));
async function corrupt(t,h,body){
  const name=randomUUID()+'.json',file=path.join(h.home,'outbox',name);
  await fs.writeFile(file,body,{mode:0o600});return {name,file,body};
}

test('one truncated outbox JSON cannot prevent other platforms from uploading valid persisted snapshots',async t=>{
  const h=await harness(t),damaged=await corrupt(t,h,'{"version":1,"payload":');
  await h.agent.enqueue(snapshot('clickandboat'));await h.agent.enqueue(snapshot('samboat'));
  await h.agent.flush();
  assert.deepEqual([...h.committed.keys()].sort(),['clickandboat','samboat']);
  assert.ok(!h.requests.some(payload=>!payload.snapshots));
  const files=await fs.readdir(path.join(h.home,'outbox-quarantine'));
  assert.equal(files.length,1);assert.equal(await fs.readFile(path.join(h.home,'outbox-quarantine',files[0]),'utf8'),damaged.body);
  if(process.platform!=='win32'){
    assert.equal((await fs.stat(path.join(h.home,'outbox-quarantine'))).mode&0o777,0o700);
    assert.equal((await fs.stat(path.join(h.home,'outbox-quarantine',files[0]))).mode&0o777,0o600);
  }
});

test('one parseable but invalid outbox envelope cannot block an unrelated valid source',async t=>{
  const h=await harness(t);await corrupt(t,h,JSON.stringify({version:1,payload:{snapshots:[]}}));
  await h.agent.enqueue(snapshot('samboat'));await h.agent.flush();
  assert.equal(h.committed.get('samboat').complete,true);
});

test('quarantine health survives repeated init and later network success without exposing record contents',async t=>{
  const h=await harness(t);await corrupt(t,h,'{"private_financial_value":"synthetic-sensitive-marker",');
  await h.agent.flush();let agent=h.agent;
  for(let index=0;index<3;index++){
    agent=await h.create();const status=await agent.status();
    assert.equal(status.quarantined_uploads,1);assert.equal(status.local_error,'outbox_corrupt');
    assert.equal(status.pending_uploads,0);assert.ok(!JSON.stringify(status).includes('synthetic-sensitive-marker'));
  }
  await agent.enqueue(snapshot('samboat'));await agent.flush();
  const status=await agent.status();assert.equal(status.remote_error,null);assert.equal(status.local_error,'outbox_corrupt');
});

test('failure to move a corrupt file preserves the original bytes and never silently discards it',async t=>{
  const h=await harness(t),damaged=await corrupt(t,h,'{"payload":');
  const original=fs.rename;t.mock.method(fs,'rename',async(from,to)=>{if(from===damaged.file)throw error('EACCES');return original(from,to);});
  await assert.rejects(h.agent.flush(),{code:'EACCES'});
  assert.equal(await fs.readFile(damaged.file,'utf8'),damaged.body);
  assert.equal((await fs.readdir(path.join(h.home,'outbox-quarantine'))).length,0);
});

test('invalid retry metadata is repaired without losing a valid cancellation or retrying every flush',async t=>{
  const h=await harness(t);await h.agent.enqueue(snapshot('boataround',NOW,'cancelled'),MANUAL);
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),entry=JSON.parse(await fs.readFile(file,'utf8'));
  entry.attempts='broken';entry.next_attempt_at='broken';await fs.writeFile(file,JSON.stringify(entry));
  let calls=0;h.remote.upload=async()=>{calls++;throw error('offline');};
  await h.agent.flush();await h.agent.flush();
  assert.equal(calls,1,'Repaired retry metadata must retain a finite backoff');
  const repaired=JSON.parse(await fs.readFile(file,'utf8'));
  assert.deepEqual(repaired.payload,entry.payload);assert.equal(repaired.attempts,1);
  assert.equal(repaired.next_attempt_at,NOW+60000);
  assert.equal((await h.agent.status()).quarantined_uploads,0);
});

test('a far-future retry timestamp is bounded without discarding the original snapshot',async t=>{
  const h=await harness(t);await h.agent.enqueue(snapshot('boataround',NOW-1000));
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),entry=JSON.parse(await fs.readFile(file,'utf8'));
  entry.next_attempt_at=Number.MAX_SAFE_INTEGER;await fs.writeFile(file,JSON.stringify(entry));
  await h.agent.enqueue(snapshot('boataround',NOW));await h.agent.flush();
  const repaired=JSON.parse(await fs.readFile(file,'utf8'));
  assert.deepEqual(repaired.payload,entry.payload);assert.equal(repaired.next_attempt_at,NOW+6*60*60*1000);
  assert.equal((await h.agent.status()).pending_uploads,2);assert.equal(h.requests.length,0);
  h.advance(6*60*60*1000);await h.agent.flush();
  assert.equal(h.committed.get('boataround')?.checked_at,new Date(NOW).toISOString());
  assert.equal(h.requests.length,2);assert.equal((await h.agent.status()).quarantined_uploads,0);
});

test('one-second clock rollback after ten ordinary failures cannot quarantine a valid cancellation',async t=>{
  const h=await harness(t),online=h.remote.upload;
  await h.agent.enqueue(snapshot('samboat',NOW,'cancelled'),MANUAL);
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name);
  const originalPayload=JSON.parse(await fs.readFile(file,'utf8')).payload;
  let failures=0;h.remote.upload=async()=>{failures++;throw error('offline');};
  for(let attempt=0;attempt<10;attempt++){
    await h.agent.flush();if(attempt<9)h.advance(6*60*60*1000);
  }
  const waiting=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(waiting.attempts,10);assert.equal(failures,10);
  h.advance(-1000);await h.agent.flush();
  const afterRollback=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(afterRollback.next_attempt_at,waiting.next_attempt_at-1000);
  assert.equal(afterRollback.attempts,10);assert.deepEqual(afterRollback.payload,originalPayload);
  assert.equal((await h.agent.status()).pending_uploads,1);assert.equal((await h.agent.status()).quarantined_uploads,0);
  const restored=await h.create();h.advance(6*60*60*1000);h.remote.upload=online;await restored.flush();
  assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0],originalPayload);
  assert.equal(h.committed.get('samboat').orders[0].status,'cancelled');
});

test('retry-metadata repair IO failure preserves the original record and does not mislabel it corrupt',async t=>{
  const h=await harness(t);await h.agent.enqueue(snapshot('boataround',NOW,'cancelled'),MANUAL);
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),entry=JSON.parse(await fs.readFile(file,'utf8'));
  entry.attempts=null;entry.next_attempt_at=-1;const originalText=JSON.stringify(entry);await fs.writeFile(file,originalText);
  const originalRename=fs.rename;t.mock.method(fs,'rename',async(from,to)=>{if(to===file)throw error('ENOSPC');return originalRename(from,to);});
  await assert.rejects(h.agent.flush(),{code:'ENOSPC'});
  assert.equal(await fs.readFile(file,'utf8'),originalText);assert.equal(h.requests.length,0);
  assert.equal((await h.agent.status()).quarantined_uploads,0);
  assert.deepEqual(await fs.readdir(path.join(h.home,'outbox')),[name]);
});

test('a damaged old queue item cannot interrupt all later platforms of a new manual collection',async t=>{
  const h=await harness(t);await corrupt(t,h,'{"version":');
  const result=await h.agent.run({requestedRunId:MANUAL});
  assert.equal(result.ok,true);assert.deepEqual(h.collections,SOURCES);
  assert.ok(h.heartbeats.some(body=>body.completed&&body.requested_run_id===MANUAL));
  assert.equal(h.agent.busy,false);
});

test('atomic JSON rename failure preserves the previous file and cleans only its own temporary file',async t=>{
  const h=await harness(t),file=path.join(h.home,'atomic.json');await writeJSON(file,{version:'before'});
  const unrelated=path.join(h.home,'do-not-touch.tmp');await fs.writeFile(unrelated,'retain');
  const original=fs.rename;t.mock.method(fs,'rename',async(from,to)=>{if(to===file)throw error('ENOSPC');return original(from,to);});
  await assert.rejects(writeJSON(file,{version:'after'}),{code:'ENOSPC'});
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:'before'});
  assert.equal(await fs.readFile(unrelated,'utf8'),'retain');
  assert.deepEqual((await fs.readdir(h.home)).filter(name=>name.startsWith('atomic.json.')&&name.endsWith('.tmp')),[]);
});

test('temporary IO permission failure is not mistaken for corrupt JSON or silently discarded',async t=>{
  const h=await harness(t);await h.agent.enqueue(snapshot('boataround'));
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),original=fs.readFile;
  t.mock.method(fs,'readFile',async(target,...args)=>{if(target===file)throw error('EACCES');return original(target,...args);});
  await assert.rejects(h.agent.flush(),{code:'EACCES'});
  assert.deepEqual(await entries(h.home),[name]);assert.equal(h.requests.length,0);
});

test('server commit followed by a lost response retries the same snapshot after repeated process init',async t=>{
  const h=await harness(t),commit=h.remote.upload,payload=snapshot('boataround');
  await h.agent.enqueue(payload,MANUAL);let lost=true;
  h.remote.upload=async body=>{const receipt=await commit(body);if(lost){lost=false;throw error('ECONNRESET');}return receipt;};
  await h.agent.flush();assert.equal(h.committed.get('boataround').run_id,payload.run_id);
  assert.equal((await entries(h.home)).length,1);assert.equal(h.agent.state.sources.boataround.last_success_at,null);
  let restored;for(let index=0;index<3;index++)restored=await h.create();
  await restored.flush();assert.equal(h.requests.length,1,'Persisted backoff must survive init');
  h.advance(INTERVAL);await restored.flush();
  assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0],h.requests[1]);
  assert.equal(h.requests[1].requested_run_id,MANUAL);assert.equal((await entries(h.home)).length,0);
  assert.equal(restored.state.sources.boataround.last_success_at,payload.checked_at);
});

test('local state-commit failure after remote success keeps the upload retryable with its original identity',async t=>{
  const h=await harness(t),payload=snapshot('boataround');await h.agent.enqueue(payload,MANUAL);
  const original=fs.rename;let failOnce=true;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===path.join(h.home,'state.json')&&failOnce){failOnce=false;throw error('ENOSPC');}
    return original(from,to);
  });
  await h.agent.flush();assert.equal((await entries(h.home)).length,1);
  assert.equal(h.committed.get('boataround').run_id,payload.run_id);
  assert.deepEqual((await fs.readdir(h.home)).filter(name=>name.startsWith('state.json.')&&name.endsWith('.tmp')),[]);
  h.advance(INTERVAL);const restored=await h.create();await restored.flush();
  assert.equal((await entries(h.home)).length,0);assert.deepEqual(h.requests[0],h.requests[1]);
  assert.equal(restored.state.sources.boataround.last_success_at,payload.checked_at);
});

test('twelve hours offline retains every source and drains in order through cancellation after restart',async t=>{
  const h=await harness(t),online=h.remote.upload;h.remote.upload=async()=>{throw error('offline');};
  for(let round=0;round<5;round++){
    for(const source of SOURCES)await h.agent.enqueue(snapshot(source,NOW+round*INTERVAL,round===4?'cancelled':'paid'));
    await h.agent.flush();if(round<4)h.advance(INTERVAL);
  }
  assert.equal((await entries(h.home)).length,25);
  const restored=await h.create();h.remote.upload=online;h.advance(6*60*60*1000);
  await restored.flush();assert.equal(h.requests.length,12);await restored.flush();assert.equal(h.requests.length,24);await restored.flush();
  assert.equal((await entries(h.home)).length,0);
  for(const source of SOURCES){
    assert.equal(h.committed.get(source).orders[0].status,'cancelled');
    const times=h.requests.filter(payload=>payload.snapshots[0].source===source).map(payload=>Date.parse(payload.snapshots[0].checked_at));
    assert.deepEqual(times,[...times].sort((a,b)=>a-b));
  }
});

test('expired device authorization keeps all snapshots and never marks successful upload',async t=>{
  const h=await harness(t);for(const source of SOURCES)await h.agent.enqueue(snapshot(source));
  let calls=0;h.remote.upload=async()=>{calls++;throw error('device_auth_required');};
  await h.agent.flush();assert.equal(calls,1);assert.equal((await entries(h.home)).length,5);
  assert.equal(h.agent.state.remote_error,'device_auth_required');
  assert.ok(SOURCES.every(source=>h.agent.state.sources[source].last_success_at===null));
  const restored=await h.create();assert.equal(restored.state.remote_error,'device_auth_required');
});

for(const status of [400,413,415,422])test('whole-request HTTP '+status+' preserves the rejected payload and allows newer same-source data through',async t=>{
  const h=await harness(t),upload=h.remote.upload;
  await h.agent.enqueue(snapshot('boataround',NOW-1000),MANUAL);
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),original=await fs.readFile(file,'utf8');
  await h.agent.enqueue(snapshot('boataround',NOW));
  let calls=0;
  h.remote.upload=async payload=>{calls++;if(Date.parse(payload.snapshots[0].checked_at)<NOW)throw Object.assign(error('worker_unavailable'),{status});return upload(payload);};
  await h.agent.flush();
  assert.equal(calls,2);assert.equal((await entries(h.home)).length,0);
  assert.equal(await fs.readFile(path.join(h.home,'rejected',name),'utf8'),original);
  assert.equal(h.committed.get('boataround').checked_at,new Date(NOW).toISOString());
  const restored=await h.create();await restored.flush();assert.equal(calls,2);
  assert.equal(restored.state.sources.boataround.last_success_at,new Date(NOW).toISOString());
});

for(const status of [401,403,429,500,503])test('whole-request HTTP '+status+' remains retryable and does not discard earlier order evidence',async t=>{
  const h=await harness(t),upload=h.remote.upload;
  await h.agent.enqueue(snapshot('samboat',NOW-1000,'cancelled'),MANUAL);
  await h.agent.enqueue(snapshot('samboat',NOW));
  let calls=0;h.remote.upload=async()=>{calls++;throw Object.assign(error(status===401||status===403?'device_auth_required':'worker_unavailable'),{status});};
  await h.agent.flush();assert.equal(calls,1);assert.equal((await entries(h.home)).length,2);
  assert.equal(h.agent.state.sources.samboat.last_success_at,null);
  h.advance(INTERVAL);const restored=await h.create();h.remote.upload=upload;await restored.flush();
  assert.equal((await entries(h.home)).length,0);assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].snapshots[0].orders[0].status,'cancelled');
  assert.equal(h.requests[0].requested_run_id,MANUAL);
});

test('a permanent HTTP rejection cannot discard its snapshot when private archival fails',async t=>{
  const h=await harness(t);await h.agent.enqueue(snapshot('boataround'));
  const [name]=await entries(h.home),file=path.join(h.home,'outbox',name),originalPayload=JSON.parse(await fs.readFile(file,'utf8')).payload;
  h.remote.upload=async()=>{throw Object.assign(error('worker_unavailable'),{status:413});};
  const originalRename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{if(from===file)throw error('ENOSPC');return originalRename(from,to);});
  await h.agent.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).payload,originalPayload);
  assert.equal((await entries(h.home)).length,1);
  assert.equal(h.agent.state.sources.boataround.last_success_at,null);
  assert.equal((await fs.readdir(path.join(h.home,'rejected'))).length,0);
});

test('disk-full enqueue never emits a manual completion ACK or loses the previous successful time',async t=>{
  const h=await harness(t),prior=new Date(NOW-INTERVAL).toISOString();
  h.agent.state.sources.boataround.last_success_at=prior;await h.agent.saveState();
  const original=fs.writeFile;t.mock.method(fs,'writeFile',async(file,...args)=>{
    if(String(file).startsWith(path.join(h.home,'outbox')+path.sep))throw error('ENOSPC');
    return original(file,...args);
  });
  await assert.rejects(h.agent.run({requestedRunId:MANUAL}),{code:'ENOSPC'});
  assert.equal(h.agent.busy,false);assert.equal(h.agent.state.last_requested_run_id,null);
  assert.equal(h.agent.state.sources.boataround.last_success_at,prior);
  assert.ok(!h.heartbeats.some(body=>body.completed));assert.equal(h.requests.length,0);
});

test('failure receipt whose response was lost remains failure on its idempotent retry',async t=>{
  const h=await harness(t),commit=h.remote.upload;
  const failure={source:'samboat',run_id:'lost-failure',checked_at:new Date(NOW).toISOString(),outcome:'failure',error_code:'auth_required'};
  await h.agent.enqueue(failure,MANUAL);let lost=true;
  h.remote.upload=async body=>{const receipt=await commit(body);if(lost){lost=false;throw error('ECONNRESET');}return receipt;};
  await h.agent.flush();h.advance(INTERVAL);const restored=await h.create();await restored.flush();
  assert.equal(restored.state.sources.samboat.state,'needs_login');assert.equal(restored.state.sources.samboat.last_success_at,null);
});

test('WorkerClient rejects expired authorization, invalid JSON and non-success HTTP without trusting a response body',async()=>{
  for(const status of [401,403]){
    let read=false;const client=new WorkerClient({device_token:'synthetic-test'},async()=>({status,text:async()=>{read=true;return '{}';}}));
    await assert.rejects(client.poll(),{code:'device_auth_required'});assert.equal(read,false);
  }
  for(const [status,body,code] of [[500,'{"ok":true}','worker_unavailable'],[200,'{','worker_response_invalid'],[200,'x'.repeat(1024*1024+1),'worker_response_invalid']]){
    const client=new WorkerClient({device_token:'synthetic-test'},async()=>new Response(body,{status}));
    await assert.rejects(client.poll(),{code});
  }
});

test('WorkerClient cancels an oversized streaming response before allocating the unbounded body',async()=>{
  let reads=0,cancelled=false;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(256*1024));},cancel(){cancelled=true;}},{highWaterMark:0});
  const client=new WorkerClient({device_token:'synthetic-test'},async()=>new Response(body,{status:200}));
  await assert.rejects(client.poll(),{code:'worker_response_invalid'});
  assert.equal(reads,5);assert.equal(cancelled,true);assert.equal(body.locked,false);
});

test('WorkerClient releases rejected HTTP response streams and accepts split UTF-8 JSON',async()=>{
  for(const status of [401,403,429,500]){
    let reads=0,cancelled=false;
    const body=new ReadableStream({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
    const client=new WorkerClient({device_token:'synthetic-test'},async()=>new Response(body,{status}));
    await assert.rejects(client.poll(),{status});
    assert.equal(reads,0);assert.equal(cancelled,true);
  }
  const bytes=Buffer.from(JSON.stringify({ok:true,message:'船队同步'}));let offset=0;
  const body=new ReadableStream({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.subarray(offset,++offset));}},{highWaterMark:0});
  const client=new WorkerClient({device_token:'synthetic-test'},async()=>new Response(body,{status:200}));
  assert.deepEqual(await client.poll(),{ok:true,message:'船队同步'});assert.equal(body.locked,false);
});

async function deferAllUploads(home){
  for(const name of await entries(home)){
    const file=path.join(home,'outbox',name),entry=JSON.parse(await fs.readFile(file,'utf8'));
    entry.attempts=10;entry.next_attempt_at=NOW+6*60*60*1000;await writeJSON(file,entry);
  }
}

test('fresh manual collection retries old queued evidence before new orders after connectivity recovers',async t=>{
  const h=await harness(t),original=snapshot('boataround',NOW-1000,'cancelled');
  await h.agent.enqueue(original);await deferAllUploads(h.home);
  await h.agent.run({requestedRunId:MANUAL});
  const uploaded=h.requests.filter(payload=>payload.snapshots[0].source==='boataround');
  assert.equal(uploaded.length,2);
  assert.deepEqual(uploaded[0].snapshots[0],original);
  assert.equal(uploaded[1].snapshots[0].checked_at,new Date(NOW).toISOString());
  assert.equal(uploaded[1].requested_run_id,MANUAL);
  assert.equal((await entries(h.home)).length,0);
  assert.equal(h.agent.state.sources.boataround.state,'synced');
});

test('fresh-source retry is bounded to one failure for each newly collected source and cannot create a polling retry storm',async t=>{
  const h=await harness(t);
  for(const source of SOURCES)await h.agent.enqueue(snapshot(source,NOW-1000));
  await deferAllUploads(h.home);
  const calls=[],collecting=[];
  for(const source of SOURCES)h.agent.collectors[source]=async()=>{collecting.push(source);return snapshot(source,NOW);};
  h.remote.upload=async payload=>{calls.push({source:payload.snapshots[0].source,collected:[...collecting]});throw error('offline');};
  await h.agent.run({requestedRunId:MANUAL});
  assert.deepEqual(calls,[
    {source:'boataround',collected:['boataround']},
    {source:'clickandboat',collected:['boataround','clickandboat']},
    {source:'samboat',collected:['boataround','clickandboat','samboat']},
    {source:'mmk',collected:['boataround','clickandboat','samboat','mmk']},
    {source:'nausys',collected:SOURCES}
  ]);
  assert.equal((await entries(h.home)).length,10);
  await h.agent.tick();await h.agent.tick();await h.agent.flush();
  assert.equal(calls.length,5);
  assert.ok(SOURCES.every(source=>h.agent.state.sources[source].last_success_at===null));
});

test('an explicit fresh-source flush still enforces twelve actual attempts and leaves unrelated backoff untouched',async t=>{
  const h=await harness(t);
  await h.agent.enqueue(snapshot('samboat',NOW-20000));
  for(let index=0;index<14;index++)await h.agent.enqueue(snapshot('boataround',NOW-14000+index));
  await deferAllUploads(h.home);
  await h.agent.flush({retrySource:'boataround'});
  assert.equal(h.requests.length,12);
  assert.ok(h.requests.every(payload=>payload.snapshots[0].source==='boataround'));
  assert.deepEqual(h.requests.map(payload=>Date.parse(payload.snapshots[0].checked_at)),Array.from({length:12},(_,index)=>NOW-14000+index));
  assert.equal((await entries(h.home)).length,3);
  assert.equal(h.agent.state.sources.samboat.last_success_at,null);
});
