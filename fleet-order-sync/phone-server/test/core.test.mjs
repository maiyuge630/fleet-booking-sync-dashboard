import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PhoneAgent,WorkerClient,loadConfiguration,beijingDay,requirePaymentEvidence,parseNativeCdpPort,INTERVAL} from '../core.mjs';

const NOW=Date.parse('2026-09-09T12:00:00Z');
const MANUAL_ID='5b83d419-9fa6-4b10-940a-aa21c1d1346b';
function snapshot(source='boataround',stamp=NOW) {return {source,run_id:source+'-'+stamp,checked_at:new Date(stamp).toISOString(),complete:true,orders:[],pagination:{complete:true}};}
async function fixture(t,options={}) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-phone-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const config=await loadConfiguration(home);config.paired=true;
  const received=[];
  const remote={upload:async payload=>{received.push(payload);return {results:payload.snapshots.map(s=>({source:s.source,accepted:true,outcome:s.outcome==='failure'?'failure':'success'}))};},heartbeat:async()=>({ok:true}),poll:async()=>({ok:true,enabled:false,requested_run_id:null})};
  const page={setViewport:async()=>{},close:async()=>{}};
  const browser={connected:true,newPage:async()=>({...page}),close:async()=>{},process:()=>({kill:()=>{}})};
  const collectors=Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(source=>[source,async()=>snapshot(source)]));
  const agent=await new PhoneAgent({home,config,remote,collectors,verifyAuth:{},platformUrls:{},browserFactory:async()=>browser,now:()=>NOW,...options}).init();
  return {agent,home,config,remote,received,collectors};
}
const queue=async home=>(await fs.readdir(path.join(home,'outbox'))).filter(file=>file.endsWith('.json'));

test('an official-app source starts no browser, keeps its read-only retry and has no login page',async t=>{
 let launches=0;const x=await fixture(t,{pagelessSources:['clickandboat'],browserFactory:async()=>{launches++;return {connected:true,newPage:async()=>({setViewport:async()=>{},close:async()=>{}}),close:async()=>{},process:()=>({kill:()=>{}})};}});
 const cb=[];x.agent.collectors.clickandboat=async({page})=>{cb.push(page);if(cb.length===1)throw Object.assign(Error('read reset'),{code:'fetch_failed'});return snapshot('clickandboat');};
 await x.agent.run();
 assert.deepEqual(cb,[null,null]);assert.equal(launches,1,'only the other sources opened the dedicated browser');
 const h=x.agent.state.sources.clickandboat.collection_history.at(-1);
 assert.equal(h.attempts,2);assert.equal(h.outcome,'success');assert.equal(h.screen_mode,'official_app');
 await assert.rejects(x.agent.openLogin('clickandboat'),error=>error.code==='unknown_source');
 assert.equal(x.agent.loginSource,null);
});

test('dedicated Click&Boat retries a transient read once on a fresh page and uploads only the complete result',async t=>{
 const x=await fixture(t);const pages=[];
 x.agent.collectors.clickandboat=async({page})=>{pages.push(page);if(pages.length===1)throw Object.assign(Error('read reset'),{code:'fetch_failed'});return snapshot('clickandboat');};
 await x.agent.run();assert.equal(pages.length,2);assert.notEqual(pages[0],pages[1]);
 const uploads=x.received.flatMap(p=>p.snapshots).filter(s=>s.source==='clickandboat');
 assert.equal(uploads.length,1);assert.equal(uploads[0].complete,true);
 const h=x.agent.state.sources.clickandboat.collection_history.at(-1);
 assert.equal(h.attempts,2);assert.equal(h.outcome,'success');assert.equal(h.screen_mode,'dedicated_browser');
});

test('dedicated Click&Boat never retries auth/schema/incomplete evidence and bounds transient attempts to two',async t=>{
 for(const code of ['auth_required','schema_changed','incomplete_pages','challenge_required','fetch_failed']){
  const x=await fixture(t);let calls=0;
  x.agent.collectors.clickandboat=async({reportDiagnostic})=>{calls++;reportDiagnostic({stage:'list_navigation',reason:'progress'});throw Object.assign(Error(code),{code});};
  await x.agent.run();assert.equal(calls,code==='fetch_failed'?2:1);
  const uploads=x.received.flatMap(p=>p.snapshots).filter(s=>s.source==='clickandboat');
  assert.equal(uploads.length,1);assert.equal(uploads[0].outcome,'failure');assert.equal(uploads[0].error_code,code);
  // The access check keeps its own name in the phone's local diagnostics too.
  assert.equal(x.agent.state.sources.clickandboat.last_diagnostic.reason,code);
 }
});

test('dedicated Click&Boat retry cannot escape the original source deadline or shutdown',async t=>{
 for(const mode of ['deadline','shutdown']){
  let now=NOW,calls=0;const x=await fixture(t,{now:()=>now});
  x.agent.collectors.clickandboat=async()=>{calls++;if(mode==='shutdown')await x.agent.close();else now+=x.agent.platformTimeout;throw Object.assign(Error('read reset'),{code:'fetch_failed'});};
  await x.agent.run();assert.equal(calls,1);
  if(mode==='shutdown')assert.equal(x.received.flatMap(p=>p.snapshots).filter(s=>s.source==='clickandboat').length,0);
 }
});

test('Beijing day crosses UTC midnight correctly',()=>assert.equal(beijingDay(Date.parse('2026-09-09T17:00:00Z')),'2026-09-10'));
test('background lease covers collection and reverse work and is released on completion or failure',async t=>{
 for(const fail of [false,true]){
  let active=false,stops=0;
  const x=await fixture(t,{nativeBackgroundLease:async()=>{active=true;return async()=>{active=false;stops++;};},reverseSync:async()=>{assert.equal(active,true);if(fail)throw Error('test failure');}});
  await x.agent.run();assert.equal(active,false);assert.equal(stops,1);assert.equal(x.agent.busy,false);
 }
});
test('every collector includes checkout-today in its exclusive lower scope',async t=>{
 const seen=[];const collectors=Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(source=>[source,async context=>{seen.push([source,context.fromDay]);return snapshot(source);} ]));
 const {agent}=await fixture(t,{collectors});await agent.run();
 assert.deepEqual(seen,[['boataround','2026-09-08'],['clickandboat','2026-09-08'],['samboat','2026-09-08'],['mmk','2026-09-08'],['nausys','2026-09-08']]);
});
test('reverse hook runs after uploads inside the collection lock',async t=>{
 let calls=0;const x=await fixture(t,{reverseSync:async agent=>{calls++;assert.equal(agent.busy,true);assert.equal((await agent.status()).pending_uploads,0);return {state:'checked'};}});
 await x.agent.run();assert.equal(calls,1);assert.equal(x.received.length,5);assert.equal(x.agent.state.reverse_sync.state,'checked');assert.equal(x.agent.busy,false);
});

test('a failed final upload defers reverse and resumes under the lock after its idempotent receipt',async t=>{
 let now=NOW,reverseCalls=0,collectionCalls=0,offline=true;
 const x=await fixture(t,{now:()=>now,reverseSync:async agent=>{reverseCalls++;assert.equal(agent.busy,true);assert.equal((await agent.status()).pending_uploads,0);return {state:'checked'};}});
 for(const source of ['boataround','clickandboat','samboat','mmk','nausys'])x.agent.collectors[source]=async()=>{collectionCalls++;return snapshot(source,now);};
 const upload=x.remote.upload;
 x.remote.upload=async body=>{if(offline&&body.snapshots[0].source==='samboat')throw Error('reset');return upload(body);};
 x.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
 await x.agent.run();assert.equal(reverseCalls,0);assert.equal(x.agent.state.reverse_pending_upload,true);
 assert.equal(x.agent.state.reverse_sync.state,'awaiting_upload');assert.equal((await queue(x.home)).length,1);
 const schedule=x.agent.state.next_run_at;
 offline=false;now+=60001;await x.agent.tick();
 assert.equal(reverseCalls,1);assert.equal(collectionCalls,5);assert.equal(x.agent.state.reverse_pending_upload,false);
 assert.equal(x.agent.state.reverse_sync.state,'checked');assert.equal(x.agent.state.next_run_at,schedule);assert.equal((await queue(x.home)).length,0);
 await x.agent.tick();assert.equal(reverseCalls,1);
});

test('deferred reverse survives restart; stale evidence triggers full collection before any platform work',async t=>{
 for(const age of [60001,360001]){
  let now=NOW,calls=0,reverseCalls=0,offline=true;
  const x=await fixture(t,{now:()=>now,reverseSync:async()=>{reverseCalls++;return {state:'checked'};}});
  const upload=x.remote.upload;x.remote.upload=async body=>{if(offline&&body.snapshots[0].source==='samboat')throw Error('reset');return upload(body);};
  await x.agent.run();assert.equal(reverseCalls,0);await x.agent.close();
  offline=false;now+=age;x.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
  const browser={connected:true,newPage:async()=>({setViewport:async()=>{},close:async()=>{}}),close:async()=>{}};
  const collectors=Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(source=>[source,async()=>{calls++;return snapshot(source,now);} ]));
  const next=await new PhoneAgent({home:x.home,config:x.config,remote:x.remote,collectors,browserFactory:async()=>browser,now:()=>now,reverseSync:async()=>{reverseCalls++;return {state:'checked'};}}).init();
  await next.tick();assert.equal(reverseCalls,1);assert.equal(calls,age>300000?5:0);assert.equal(next.state.reverse_pending_upload,false);
 }
});

test('deferred reverse waits for uploads and honors disabled sync, failed poll, login, and shutdown',async t=>{
 for(const mode of ['pending','disabled','poll_failed','login','closed','reverse_disabled']){
  let now=NOW,calls=0,offline=true;
  const x=await fixture(t,{now:()=>now,reverseSync:async()=>{calls++;}});
  const upload=x.remote.upload;x.remote.upload=async body=>{if(offline&&body.snapshots[0].source==='samboat')throw Error('reset');return upload(body);};
  await x.agent.run();assert.equal(calls,0);now+=60001;offline=mode==='pending';
  x.remote.poll=async()=>{if(mode==='poll_failed')throw Error('reset');return {ok:true,enabled:mode!=='disabled',requested_run_id:null};};
  if(mode==='login'){x.agent.loginSource='clickandboat';x.agent.loginPage={isClosed:()=>false};}
  if(mode==='closed')await x.agent.close();
  if(mode==='reverse_disabled')x.agent.reverseSync=null;
  await x.agent.tick();assert.equal(calls,0);assert.equal(x.agent.state.reverse_pending_upload,true);
 }
});

test('an unrequested reverse-only run cannot skip collection',async t=>{
 const x=await fixture(t);assert.deepEqual(await x.agent.run({resumeReverse:true}),{ok:false,reason:'no_deferred_reverse'});
 assert.equal(x.received.length,0);
});
test('reverse failure never discards uploaded orders or prevents next schedule',async t=>{
 const x=await fixture(t,{reverseSync:async()=>{throw Error('target_offline');}});await x.agent.run();
 assert.equal(x.received.length,5);assert.equal(x.agent.state.reverse_sync.state,'failed');assert.equal(x.agent.state.next_run_at,new Date(NOW+INTERVAL).toISOString());assert.equal(x.agent.busy,false);
});
test('private configuration remains stable across restart and uses independent credentials',async t=>{
  const {home,config}=await fixture(t);const again=await loadConfiguration(home);
  assert.equal(again.device_token,config.device_token);assert.notEqual(again.device_token,again.admin_password);
  assert.match(again.device_token,/^[A-Za-z0-9_-]{43}$/);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(home,'config.json'))).mode&0o777,0o600);
});
test('outbox survives transient 207 rejection and restart without changing run id or verification time',async t=>{
  const {agent,home,config}=await fixture(t);const original=snapshot();await agent.enqueue(original);
  agent.remote.upload=async()=>({results:[{source:'boataround',accepted:false,status:503,error:'storage unavailable'}]});
  await agent.flush();assert.equal((await queue(home)).length,1);assert.equal(agent.state.sources.boataround.last_success_at,null);
  let uploaded;const next=await new PhoneAgent({home,config,now:()=>NOW+INTERVAL,remote:{upload:async body=>{uploaded=body;return {results:[{source:'boataround',accepted:true,idempotent:true}]};}}}).init();
  await next.flush();assert.deepEqual(uploaded.snapshots[0],original);assert.equal((await queue(home)).length,0);
  assert.equal(next.state.sources.boataround.last_success_at,original.checked_at);
});
test('missing or malformed per-source receipt never confirms an upload',async t=>{
  const {agent,home}=await fixture(t);await agent.enqueue(snapshot());agent.remote.upload=async()=>({results:[{source:'samboat',accepted:true,outcome:'success'}]});
  await agent.flush();assert.equal((await queue(home)).length,1);assert.equal(agent.state.sources.boataround.last_success_at,null);
});
test('partial 207 receipts retain transient source and confirm only accepted source',async t=>{
  const {agent,home}=await fixture(t);await agent.enqueue(snapshot('boataround'));await agent.enqueue(snapshot('samboat'));
  agent.remote.upload=async body=>({results:body.snapshots.map(s=>s.source==='boataround'?{source:s.source,accepted:true,outcome:'success'}:{source:s.source,accepted:false,status:409})});
  await agent.flush();assert.equal((await queue(home)).length,1);assert.equal(agent.state.sources.boataround.last_success_at,new Date(NOW).toISOString());assert.equal(agent.state.sources.samboat.last_success_at,null);
});
test('failure receipt retains prior success time; older snapshot terminates without success',async t=>{
  const {agent,home}=await fixture(t);const prior=new Date(NOW-INTERVAL).toISOString();agent.state.sources.boataround.last_success_at=prior;
  await agent.enqueue({source:'boataround',run_id:'failed',checked_at:new Date(NOW).toISOString(),outcome:'failure',error_code:'auth_required'});await agent.flush();
  assert.equal(agent.state.sources.boataround.last_success_at,prior);assert.equal(agent.state.sources.boataround.state,'needs_login');
  await agent.enqueue(snapshot());agent.remote.upload=async()=>({results:[{source:'boataround',accepted:false,ignored:'older_snapshot'}]});await agent.flush();
  assert.equal((await queue(home)).length,0);assert.equal(agent.state.sources.boataround.last_success_at,prior);
});
test('chronological upload prevents later failure from overtaking earlier success',async t=>{
  const {agent,received}=await fixture(t);await agent.enqueue({source:'boataround',run_id:'failure-new',checked_at:new Date(NOW+1000).toISOString(),outcome:'failure',error_code:'fetch_failed'});await agent.enqueue(snapshot('boataround',NOW));
  await agent.flush();assert.equal(received[0].snapshots[0].complete,true);assert.equal(received[1].snapshots[0].outcome,'failure');
  assert.equal(agent.state.sources.boataround.last_success_at,new Date(NOW).toISOString());
});
test('an earlier backoff blocks subsequent snapshots for the same source',async t=>{
  const {agent,received}=await fixture(t);await agent.enqueue(snapshot('boataround',NOW-1000));agent.remote.upload=async()=>{throw Error('offline');};await agent.flush();
  await agent.enqueue(snapshot('boataround',NOW));let attempts=0;agent.remote.upload=async()=>{attempts++;throw Error('offline');};await agent.flush();assert.equal(attempts,0);
});

test('twelve older snapshots in one source backoff do not starve other due sources',async t=>{
  const {agent,home,remote}=await fixture(t),upload=remote.upload;
  await agent.enqueue(snapshot('boataround',NOW-20000));
  remote.upload=async()=>{throw Error('offline');};await agent.flush();
  for(let index=1;index<12;index++)await agent.enqueue(snapshot('boataround',NOW-20000+index));
  await agent.enqueue(snapshot('clickandboat',NOW-1000));await agent.enqueue(snapshot('samboat',NOW));
  const attempts=[];remote.upload=async payload=>{attempts.push(payload.snapshots[0].source);return upload(payload);};
  await agent.flush();
  assert.deepEqual(attempts,['clickandboat','samboat']);
  assert.equal((await queue(home)).length,12);
  assert.equal(agent.state.sources.boataround.last_success_at,null);
});

test('a flush still makes at most twelve actual upload attempts in verification-time order',async t=>{
  const {agent,home,received}=await fixture(t);
  for(let index=13;index>=0;index--)await agent.enqueue(snapshot('samboat',NOW+index));
  await agent.flush();
  assert.equal(received.length,12);assert.equal((await queue(home)).length,2);
  assert.deepEqual(received.map(payload=>Date.parse(payload.snapshots[0].checked_at)),Array.from({length:12},(_,index)=>NOW+index));
});

test('a fresh manual request begins collecting before older outbox uploads',async t=>{
  const {agent,remote,collectors}=await fixture(t),events=[],upload=remote.upload;
  await agent.enqueue(snapshot('boataround',NOW-1000));
  remote.poll=async()=>{events.push('poll');return {ok:true,enabled:false,requested_run_id:MANUAL_ID};};
  remote.upload=async payload=>{events.push('upload');return upload(payload);};
  const collect=collectors.boataround;
  collectors.boataround=async context=>{events.push('collect');return collect(context);};
  await agent.tick();
  assert.deepEqual(events.slice(0,2),['poll','collect']);
  assert.equal(agent.state.last_requested_run_id,MANUAL_ID);
});

test('a failed command poll still allows already collected results to upload and retains the poll error',async t=>{
  const {agent,home}=await fixture(t);await agent.enqueue(snapshot());
  agent.remote.poll=async()=>{throw Error('poll unavailable');};
  await agent.tick();
  assert.equal((await queue(home)).length,0);
  assert.equal(agent.state.sources.boataround.last_success_at,new Date(NOW).toISOString());
  assert.equal(agent.state.remote_error,'poll_failed');assert.equal(agent.polling,false);
});

test('frequent overlapping ticks claim one manual run and only ACK the completed duplicate',async t=>{
  const {agent,remote,collectors}=await fixture(t);let releasePoll,releaseCollect,pollEntered,collectEntered,polls=0,collections=0;
  const pollGate=new Promise(resolve=>{releasePoll=resolve;}),collectGate=new Promise(resolve=>{releaseCollect=resolve;});
  const pollStarted=new Promise(resolve=>{pollEntered=resolve;}),collectStarted=new Promise(resolve=>{collectEntered=resolve;});
  remote.poll=async()=>{polls++;pollEntered();await pollGate;return {ok:true,enabled:false,requested_run_id:MANUAL_ID};};
  collectors.boataround=async()=>{collections++;collectEntered();await collectGate;return snapshot();};
  const heartbeats=[];remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  const first=agent.tick();await pollStarted;
  await Promise.all(Array.from({length:20},()=>agent.tick()));
  assert.equal(polls,1);releasePoll();
  await collectStarted;
  await Promise.all(Array.from({length:20},()=>agent.tick()));
  assert.equal(polls,1);assert.equal(collections,1);
  assert.deepEqual(await agent.run(),{ok:false,reason:'busy'});
  releaseCollect();await first;await agent.tick();
  assert.equal(polls,2);assert.equal(collections,1);
  assert.equal(heartbeats.at(-1).requested_run_id,MANUAL_ID);assert.equal(heartbeats.at(-1).completed,true);
  assert.equal(agent.busy,false);assert.equal(agent.polling,false);
});

test('automatic sync runs at the three-hour boundary and not before it',async t=>{
  let clock=NOW, collections=0;
  const {agent}=await fixture(t,{now:()=>clock});
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
  agent.collectors.boataround=async()=>{collections++;return snapshot('boataround',clock);};
  await agent.run();
  const next=NOW+3*60*60*1000;
  assert.equal(Date.parse(agent.state.next_run_at),next);
  clock=next-1;await agent.tick();assert.equal(collections,1);
  clock=next;await agent.tick();assert.equal(collections,2);
  assert.equal(Date.parse(agent.state.next_run_at),next+3*60*60*1000);
});

test('clock rollback repairs and persists a far-future schedule without an immediate or repeated collection',async t=>{
  let clock=NOW,collections=0;
  const {agent,home,config}=await fixture(t,{now:()=>clock});
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
  agent.collectors.boataround=async()=>{collections++;return snapshot('boataround',clock);};
  await agent.run();
  clock-=24*60*60*1000;
  const expected=clock+INTERVAL;
  await agent.tick();await agent.tick();
  assert.equal(collections,1);assert.equal(Date.parse(agent.state.next_run_at),expected);
  const restarted=await new PhoneAgent({home,config,now:()=>clock}).init();
  assert.equal(Date.parse(restarted.state.next_run_at),expected);
  clock=expected-1;await agent.tick();assert.equal(collections,1);
  clock=expected;await agent.tick();assert.equal(collections,2);
  assert.equal(Date.parse(agent.state.next_run_at),expected+INTERVAL);
});

test('an invalid persisted schedule recovers once and still accepts an immediate manual request',async t=>{
  const {agent}=await fixture(t);let collections=0,pending=null;
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:pending});
  agent.collectors.boataround=async()=>{collections++;return snapshot();};
  agent.state.next_run_at='invalid-date';
  await agent.tick();await agent.tick();
  assert.equal(collections,0);assert.equal(Date.parse(agent.state.next_run_at),NOW+INTERVAL);
  pending=MANUAL_ID;await agent.tick();
  assert.equal(collections,1);assert.equal(agent.state.last_requested_run_id,MANUAL_ID);
  assert.equal(Date.parse(agent.state.next_run_at),NOW+INTERVAL);
});

test('a small backwards clock correction preserves the existing automatic deadline',async t=>{
  let clock=NOW;
  const {agent}=await fixture(t,{now:()=>clock});
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
  await agent.run();const original=agent.state.next_run_at;
  clock-=1000;await agent.tick();
  assert.equal(agent.state.next_run_at,original);
});

test('a long manual run schedules three hours from collection completion and persists it',async t=>{
  let clock=NOW;const heartbeats=[];
  const {agent,home,config}=await fixture(t,{now:()=>clock});
  agent.state.next_run_at=new Date(NOW+6*60*60*1000).toISOString();
  agent.remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  for(const source of ['boataround','clickandboat','samboat'])agent.collectors[source]=async()=>{
    clock+=7*60*1000;return snapshot(source,clock);
  };
  await agent.run({requestedRunId:MANUAL_ID});
  const expected=NOW+21*60*1000+3*60*60*1000;
  assert.equal(Date.parse(agent.state.last_run_at),NOW);
  assert.equal(Date.parse(agent.state.next_run_at),expected);
  assert.equal(Date.parse(heartbeats.at(-1).next_run_at),expected);
  assert.equal(heartbeats.at(-1).completed,true);
  const restarted=await new PhoneAgent({home,config,now:()=>clock}).init();
  assert.equal(Date.parse(restarted.state.next_run_at),expected);
});

test('shorter collection cadence preserves the independent six-hour outbox retry ceiling',async t=>{
  let clock=NOW;
  const {agent,home}=await fixture(t,{now:()=>clock});
  await agent.enqueue(snapshot());agent.remote.upload=async()=>{throw Error('offline');};
  let lastDelay;
  for(let attempt=0;attempt<11;attempt++){
    await agent.flush();
    const [name]=await queue(home),entry=JSON.parse(await fs.readFile(path.join(home,'outbox',name),'utf8'));
    lastDelay=entry.next_attempt_at-clock;
    assert.ok(lastDelay<=6*60*60*1000);
    clock=entry.next_attempt_at;
  }
  assert.equal(lastDelay,6*60*60*1000);
  assert.equal((await queue(home)).length,1);
  assert.equal(agent.state.sources.boataround.last_success_at,null);
});
test('permanent rejected snapshot is preserved privately for diagnosis',async t=>{
  const {agent,home}=await fixture(t);await agent.enqueue(snapshot());agent.remote.upload=async()=>({results:[{source:'boataround',accepted:false,status:422}]});await agent.flush();
  assert.equal((await queue(home)).length,0);assert.equal((await fs.readdir(path.join(home,'rejected'))).length,1);assert.equal(agent.state.sources.boataround.last_success_at,null);
});
test('overlapping runs do not create a second collector; completed manual request is acknowledged once',async t=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});let calls=0;
  const {agent}=await fixture(t);agent.collectors.boataround=async()=>{calls++;await blocked;return snapshot();};
  const first=agent.run({requestedRunId:MANUAL_ID});await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(await agent.run(),{ok:false,reason:'busy'});release();await first;assert.equal(calls,1);assert.equal(agent.state.last_requested_run_id,MANUAL_ID);assert.equal(agent.busy,false);
});

test('manual success and failure uploads carry their request ID while automatic uploads do not',async t=>{
  const {agent,received}=await fixture(t),heartbeats=[];
  agent.remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  await agent.run();
  assert.equal(received.length,5);
  assert.ok(received.every(payload=>!Object.hasOwn(payload,'requested_run_id')));
  assert.ok(heartbeats.every(body=>!Object.hasOwn(body,'requested_run_id')));
  agent.collectors.samboat=async()=>{throw Object.assign(Error('login expired'),{code:'auth_required'});};
  await agent.run({requestedRunId:MANUAL_ID});
  const manual=received.slice(5);
  assert.equal(manual.length,5);
  assert.ok(manual.every(payload=>payload.requested_run_id===MANUAL_ID));
  assert.equal(manual.filter(payload=>payload.snapshots[0].complete===true).length,4);
  assert.equal(manual.find(payload=>payload.snapshots[0].source==='samboat').snapshots[0].outcome,'failure');
  assert.ok(heartbeats.some(body=>body.state==='running'&&body.requested_run_id===MANUAL_ID&&!body.completed));
  assert.equal(heartbeats.at(-1).requested_run_id,MANUAL_ID);
  assert.equal(heartbeats.at(-1).completed,true);
});

test('manual request association survives offline outbox restart and leaves legacy payloads unchanged',async t=>{
  const {agent,home,config}=await fixture(t);
  agent.remote.upload=async()=>{throw Error('offline');};
  agent.collectors.samboat=async()=>{throw Object.assign(Error('login expired'),{code:'auth_required'});};
  await agent.run({requestedRunId:MANUAL_ID});
  await agent.enqueue(snapshot('boataround',NOW-1000));
  const stored=await Promise.all((await queue(home)).map(async name=>JSON.parse(await fs.readFile(path.join(home,'outbox',name),'utf8')).payload));
  assert.equal(stored.length,6);
  assert.equal(stored.filter(payload=>payload.requested_run_id===MANUAL_ID).length,5);
  assert.equal(stored.filter(payload=>!Object.hasOwn(payload,'requested_run_id')).length,1);
  const uploaded=[];
  const restarted=await new PhoneAgent({home,config,now:()=>NOW+INTERVAL,remote:{upload:async payload=>{
    uploaded.push(payload);return {results:payload.snapshots.map(record=>({source:record.source,accepted:true,outcome:record.outcome==='failure'?'failure':'success'}))};
  }}}).init();
  await restarted.flush();
  const byRun=payloads=>payloads.slice().sort((a,b)=>a.snapshots[0].run_id.localeCompare(b.snapshots[0].run_id));
  assert.deepEqual(byRun(uploaded),byRun(stored));
  assert.equal((await queue(home)).length,0);
});

test('invalid manual request identities cannot create outbox entries or start a run',async t=>{
  const {agent,home,received}=await fixture(t);
  for(const requestedRunId of ['', 'request-1', '5b83d419-9fa6-1b10-940a-aa21c1d1346b', 3]){
    await assert.rejects(agent.run({requestedRunId}),{code:'invalid_requested_run_id'});
    await assert.rejects(agent.enqueue(snapshot(),requestedRunId),{code:'invalid_requested_run_id'});
  }
  assert.equal(agent.busy,false);assert.equal(received.length,0);assert.equal((await queue(home)).length,0);
});

test('completion ACK after an outage longer than three hours omits its expired schedule and unblocks subsequent sync',async t=>{
  let clock=NOW,pending=MANUAL_ID,collections=0;
  const {agent}=await fixture(t,{now:()=>clock});
  agent.collectors.boataround=async()=>{collections++;return snapshot('boataround',clock);};
  agent.remote.heartbeat=async body=>{if(body.completed)throw Error('network offline');return {ok:true};};
  await agent.run({requestedRunId:MANUAL_ID});
  const originalNext=agent.state.next_run_at;
  assert.equal(agent.state.last_requested_run_id,MANUAL_ID);
  assert.equal(collections,1);
  clock+=3*60*60*1000+2*60*1000;
  const retried=[];
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:pending});
  agent.remote.heartbeat=async body=>{
    if(body.next_run_at!==undefined&&Date.parse(body.next_run_at)<clock-60000)throw Error('invalid_next_run_at');
    retried.push(body);
    if(body.completed&&body.requested_run_id===pending)pending=null;
    return {ok:true};
  };
  await agent.tick();
  assert.equal(pending,null);
  assert.equal(retried[0].requested_run_id,MANUAL_ID);assert.equal(retried[0].completed,true);
  assert.equal(Object.hasOwn(retried[0],'next_run_at'),false);
  assert.equal(agent.state.next_run_at,originalNext); // ACK does not silently reschedule.
  assert.equal(agent.state.remote_error,null);assert.equal(collections,1);
  await agent.tick();
  assert.equal(collections,2);
  assert.equal(Date.parse(agent.state.next_run_at),clock+3*60*60*1000);
});
test('CB Accepted without explicit verified positive customer payment is failed closed',async t=>{
  assert.throws(()=>requirePaymentEvidence('clickandboat',{orders:[{status:'accepted',amount:'€100'}]}),{code:'schema_changed'});
  const {agent,received}=await fixture(t);agent.collectors.clickandboat=async()=>({...snapshot('clickandboat'),orders:[{status:'accepted'}]});await agent.run();
  const event=received.find(p=>p.snapshots[0].source==='clickandboat').snapshots[0];assert.equal(event.outcome,'failure');assert.equal(event.error_code,'schema_changed');assert.equal(agent.state.sources.clickandboat.last_success_at,null);
});
test('a collector ignoring cancellation is bounded and never converted to empty successful orders',async t=>{
  const {agent,received}=await fixture(t,{platformTimeout:20});agent.collectors.boataround=()=>new Promise(()=>{});
  await agent.run();assert.equal(agent.busy,false);assert.equal(received.find(p=>p.snapshots[0].source==='boataround').snapshots[0].outcome,'failure');
});
test('shutdown interrupts an uncooperative collector and its late result cannot upload or reverse sync',{timeout:5000},async t=>{
  let entered,release,signalSeen,reversals=0;
  const collecting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const {agent,home,config,received}=await fixture(t,{reverseSync:async()=>{reversals++;}});
  const heartbeats=[];agent.remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  agent.collectors.boataround=async({signal})=>{signalSeen=signal;entered();await gate;return snapshot();};
  const running=agent.run({requestedRunId:MANUAL_ID});await collecting;
  await agent.close();assert.deepEqual(await running,{ok:false,reason:'closed'});
  assert.equal(signalSeen.aborted,true);assert.equal(agent.busy,false);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.length,0);assert.equal((await queue(home)).length,0);assert.equal(reversals,0);
  assert.equal(agent.state.last_requested_run_id,null);assert.equal(agent.state.next_run_at,null);
  assert.ok(heartbeats.every(body=>!body.completed));
  const restarted=await new PhoneAgent({home,config}).init();
  assert.equal(restarted.state.sources.boataround.state,'interrupted');
  assert.equal(restarted.state.sources.boataround.last_success_at,null);
});

test('a viewport command resolving after shutdown cannot start its collector',{timeout:5000},async t=>{
  let entered,release,collections=0;
  const viewport=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const browser={connected:true,close:async()=>{},newPage:async()=>({close:async()=>{},setViewport:async()=>{entered();await gate;}})};
  const {agent,received}=await fixture(t,{browserFactory:async()=>browser});
  agent.collectors.boataround=async()=>{collections++;return snapshot();};
  const running=agent.run();await viewport;await agent.close();
  assert.deepEqual(await running,{ok:false,reason:'closed'});
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(collections,0);assert.equal(received.length,0);
});

test('a closed agent cannot collect, poll or send pending uploads',async t=>{
  const {agent,home,received}=await fixture(t);let polls=0;
  agent.remote.poll=async()=>{polls++;return {ok:true,enabled:true,requested_run_id:MANUAL_ID};};
  await agent.enqueue(snapshot());await agent.close();
  assert.deepEqual(await agent.run(),{ok:false,reason:'closed'});
  await agent.tick();await agent.flush();
  assert.equal(polls,0);assert.equal(received.length,0);assert.equal((await queue(home)).length,1);
});

test('a command poll resolving after shutdown cannot acknowledge or start its manual command',async t=>{
  const {agent,received}=await fixture(t);let entered,release;
  const polling=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  agent.remote.poll=async()=>{entered();await gate;return {ok:true,enabled:true,requested_run_id:MANUAL_ID};};
  const heartbeats=[];agent.remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  const tick=agent.tick();await polling;await agent.close();release();await tick;
  assert.equal(received.length,0);assert.equal(heartbeats.length,0);assert.equal(agent.polling,false);
  assert.equal(agent.state.enabled,false);assert.equal(agent.state.last_requested_run_id,null);
});

test('shutdown during upload keeps the valid receipt but never advances to another platform',async t=>{
  let entered,release,reversals=0;
  const uploading=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const {agent,home,received}=await fixture(t,{reverseSync:async()=>{reversals++;}}),upload=agent.remote.upload;
  agent.remote.upload=async payload=>{entered();await gate;return upload(payload);};
  const heartbeats=[];agent.remote.heartbeat=async body=>{heartbeats.push(body);return {ok:true};};
  const running=agent.run({requestedRunId:MANUAL_ID});await uploading;await agent.close();release();
  assert.deepEqual(await running,{ok:false,reason:'closed'});
  assert.equal(received.length,1);assert.equal((await queue(home)).length,0);
  assert.equal(agent.state.sources.boataround.state,'synced');assert.equal(reversals,0);
  assert.equal(agent.state.sources.clickandboat.last_attempt_at,null);
  assert.ok(heartbeats.every(body=>!body.completed));assert.equal(agent.state.last_requested_run_id,null);
});

test('worker client uses independent bearer token, GET poll, fixed HTTPS origin, and rejects redirects',async()=>{
  let seen;const client=new WorkerClient({device_token:'local-secret'},async(url,options)=>{seen={url,options};return new Response('{"ok":true,"enabled":false}',{status:200});});await client.poll();
  assert.equal(seen.options.method,'GET');assert.equal(seen.options.redirect,'error');assert.equal(seen.options.headers.Authorization,'Bearer local-secret');assert.equal(seen.url,'https://your-worker.example.workers.dev/api/agent/poll');
});

function trackedBrowser(name) {
  const events={created:[],closed:0,disconnected:0,killed:0};
  const browser={connected:true,newPage:async()=>{
    const page={name,viewports:0,viewportValues:[],closed:0,setViewport:async value=>{page.viewports++;page.viewportValues.push(value);},
      close:async()=>{page.closed++;},goto:async()=>{},bringToFront:async()=>{}};
    events.created.push(page);return page;
  },close:async()=>{events.closed++;browser.connected=false;},
  disconnect:async()=>{events.disconnected++;browser.connected=false;},
  process:()=>({kill:()=>{events.killed++;browser.connected=false;}})};
  return {browser,events};
}
test('native CDP configuration accepts only a decimal unprivileged port, never a URL or address',()=>{
  assert.equal(parseNativeCdpPort(undefined),null);
  assert.equal(parseNativeCdpPort('8879'),8879);
  for(const value of ['', '80','65536','08879','8879.0',' 8879','127.0.0.1:8879','http://192.168.1.2:8879','8879/path',8879]) {
    assert.throws(()=>parseNativeCdpPort(value),{code:'invalid_native_cdp_port'});
  }
});
test('Boataround and SamBoat share native Chrome; only the new BA tab uses a desktop viewport',async t=>{
  const owned=trackedBrowser('owned'),native=trackedBrowser('native');let launches=0,connections=0;
  const {agent,collectors}=await fixture(t,{browserFactory:async()=>{launches++;return owned.browser;},nativeBrowserFactory:async()=>{connections++;return native.browser;}});
  const seen={};for(const source of ['boataround','clickandboat','samboat','mmk','nausys'])collectors[source]=async({page})=>{seen[source]=page.name;return snapshot(source);};
  await agent.run();
  assert.deepEqual(seen,{boataround:'native',clickandboat:'owned',samboat:'native',mmk:'native',nausys:'native'});
  assert.equal(launches,1);assert.equal(connections,1);
  assert.equal(owned.events.created.length,1);assert.equal(native.events.created.length,4);
  assert.deepEqual(native.events.created[0].viewportValues,[{width:1440,height:900}]);
  assert.equal(native.events.created[1].viewports,0);assert.equal(native.events.created[2].viewports,0);assert.equal(native.events.created[3].viewports,0);assert.ok(owned.events.created.every(page=>page.viewports===1));
  assert.ok([...owned.events.created,...native.events.created].every(page=>page.closed===1));
  await agent.close();
  assert.equal(native.events.closed,0);assert.equal(native.events.killed,0);assert.equal(native.events.disconnected,1);assert.equal(owned.events.closed,1);
});

test('without a native factory all ordinary sources retain their existing desktop collection',async t=>{
 const owned=trackedBrowser('owned'),seen={};const {agent,collectors}=await fixture(t,{browserFactory:async()=>owned.browser});
 for(const source of ['boataround','clickandboat','samboat','mmk','nausys'])collectors[source]=async({page})=>{seen[source]=page.name;return snapshot(source);};
 await agent.run();assert.deepEqual(seen,{boataround:'owned',clickandboat:'owned',samboat:'owned',mmk:'owned',nausys:'owned'});
 assert.ok(owned.events.created.every(page=>page.viewports===1));await agent.close();
});

test('native BA login and reverse-sync page access receive the same desktop viewport centrally',async t=>{
 const native=trackedBrowser('native'),owned=trackedBrowser('owned');
 const {agent}=await fixture(t,{browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>native.browser,
  platformUrls:{boataround:'https://example.invalid/'},verifyAuth:{boataround:async()=>true}});
 await agent.openLogin('boataround');assert.equal(agent.loginPage.name,'native');
 assert.deepEqual(agent.loginPage.viewportValues,[{width:1440,height:900}]);
 await agent.finishLogin();
 // This is the same ensureBrowser/createManagedPage entry used by reverse.mjs.
 const reversePage=await agent.createManagedPage('boataround',await agent.ensureBrowser('boataround'));
 assert.deepEqual(reversePage.viewportValues,[{width:1440,height:900}]);
 const mmkPage=await agent.createManagedPage('mmk',await agent.ensureBrowser('mmk'));
 assert.equal(mmkPage.viewports,0);assert.equal(owned.events.created.length,0);
 await agent.close();assert.ok(native.events.created.every(page=>page.closed===1));assert.equal(native.events.closed,0);
});

test('native BA viewport failure closes its exact new page and leaves no hidden login lock',async t=>{
 const native=trackedBrowser('native'),create=native.browser.newPage;
 native.browser.newPage=async()=>{const page=await create();page.setViewport=async()=>{throw Error('viewport unavailable');};return page;};
 const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{boataround:'https://example.invalid/'}});
 await assert.rejects(agent.openLogin('boataround'),/viewport unavailable/);
 assert.equal(native.events.created[0].closed,1);assert.equal(agent.managedPages.size,0);assert.equal(agent.pageCreations,0);
 assert.equal(agent.loginSource,null);assert.equal(agent.loginPage,null);assert.equal(agent.busy,false);
 await agent.close();assert.equal(native.events.closed,0);
});

test('shutdown during native BA viewport setup closes only that new tab and rejects its late result',async t=>{
 const native=trackedBrowser('native'),create=native.browser.newPage;let entered,release;
 const setting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 native.browser.newPage=async()=>{const page=await create();page.setViewport=async()=>{entered();await gate;};return page;};
 const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser});
 const browser=await agent.ensureBrowser('boataround'),creating=agent.createManagedPage('boataround',browser);
 await setting;await agent.close();release();await assert.rejects(creating,{code:'fetch_failed'});
 assert.equal(native.events.created[0].closed,1);assert.equal(agent.managedPages.size,0);assert.equal(agent.pageCreations,0);
 assert.equal(native.events.closed,0);assert.equal(native.events.disconnected,1);
});

test('native BA background budget includes cold bridge time and remains within the original platform deadline',async t=>{
 let clock=NOW;const native=trackedBrowser('native'),limits={};
 const {agent,collectors}=await fixture(t,{now:()=>clock,nativeBrowserFactory:async()=>native.browser,
  prepareNativeBrowser:async({source})=>{if(source==='boataround')clock+=90000;}});
 for(const source of ['boataround','clickandboat','samboat'])collectors[source]=async context=>{
  limits[source]={deadline:context.deadlineAt,remaining:context.deadlineAt-clock};return snapshot(source,clock);
 };
 await agent.run();assert.deepEqual(limits.boataround,{deadline:NOW+240000,remaining:150000});
 assert.equal(limits.samboat.remaining,240000);assert.equal(limits.clickandboat.remaining,480000);await agent.close();
 const limited=await fixture(t,{platformTimeout:10000,nativeBrowserFactory:async()=>trackedBrowser('limited').browser});
 let remaining;limited.agent.collectors.boataround=async context=>{remaining=context.deadlineAt-NOW;return snapshot('boataround');};
 await limited.agent.run();assert.equal(remaining,10000);await limited.agent.close();
});

test('native BA transient background failure allows one wake retry and publishes only its final collection',async t=>{
 const native=trackedBrowser('native'),modes=[];let calls=0;
 const {agent,received}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,prepareNativeBrowser:async c=>modes.push([c.source,c.forceWake])});
 agent.collectors.boataround=async()=>{if(++calls===1)throw Error('renderer suspended');return snapshot('boataround');};
 await agent.run();assert.deepEqual(modes,[['boataround',false],['boataround',true],['samboat',false],['mmk',false],['nausys',false]]);
 assert.equal(calls,2);assert.equal(agent.state.sources.boataround.screen_mode,'wake_fallback');
 const uploaded=received.flatMap(packet=>packet.snapshots).filter(s=>s.source==='boataround');assert.equal(uploaded.length,1);assert.equal(uploaded[0].complete,true);
 assert.ok(native.events.created.filter(page=>page.viewports).every(page=>page.viewports===1&&page.closed===1));await agent.close();
});
test('native login uses the native page without a desktop viewport and still blocks collection',async t=>{
  const native=trackedBrowser('native'),owned=trackedBrowser('owned');
  const {agent}=await fixture(t,{browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'},verifyAuth:{samboat:async()=>true}});
  assert.deepEqual(await agent.openLogin('samboat'),{ok:true,source:'samboat'});
  assert.equal(native.events.created[0].viewports,0);assert.equal(owned.events.created.length,0);
  assert.deepEqual(await agent.run(),{ok:false,reason:'login_in_progress'});
  assert.deepEqual(await agent.finishLogin(),{ok:true,source:'samboat'});
  await agent.close();assert.equal(native.events.created[0].closed,1);assert.equal(native.events.closed,0);assert.equal(native.events.disconnected,1);
});

test('an unfinished login is released after 30 minutes so it cannot stop every platform indefinitely',async t=>{
  const native=trackedBrowser('native'),owned=trackedBrowser('owned');let clock=NOW;
  const {agent}=await fixture(t,{now:()=>clock,browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'},verifyAuth:{samboat:async()=>false}});
  await agent.openLogin('samboat');
  clock+=29*60000;assert.deepEqual(await agent.run(),{ok:false,reason:'login_in_progress'});assert.equal((await agent.status()).login_source,'samboat');
  clock+=2*60000;assert.equal((await agent.status()).login_source,null);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(native.events.created[0].closed,1);
  assert.notDeepEqual(await agent.run(),{ok:false,reason:'login_in_progress'});
  await agent.close();
});

test('failed login navigation or tab activation releases its page and allows the next automatic collection',async t=>{
  for(const stage of ['goto','bringToFront']){
    const native=trackedBrowser('native'),owned=trackedBrowser('owned');
    const newPage=native.browser.newPage;
    native.browser.newPage=async()=>{
      const page=await newPage();page[stage]=async()=>{throw Error('navigation disconnected');};return page;
    };
    const {agent,received}=await fixture(t,{browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
    await assert.rejects(agent.openLogin('samboat'),/navigation disconnected/);
    assert.equal(agent.busy,false);assert.equal(agent.loginSource,null);assert.equal(agent.loginPage,null);
    assert.equal(native.events.created[0].closed,1);assert.equal(agent.managedPages.size,0);
    agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
    await agent.tick();
    assert.equal(received.length,5);assert.ok(received.every(payload=>payload.snapshots[0].complete));
    await agent.close();assert.equal(native.events.closed,0);
  }
});

test('a failed replacement tab cannot retain the already closed login session',async t=>{
  const native=trackedBrowser('native');
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
  await agent.openLogin('samboat');
  native.browser.newPage=async()=>{throw Error('browser disconnected');};
  await assert.rejects(agent.openLogin('samboat'),/browser disconnected/);
  assert.equal(native.events.created[0].closed,1);
  assert.equal(agent.loginSource,null);assert.equal(agent.loginPage,null);assert.equal(agent.busy,false);
  await agent.close();
});

test('an unavailable replacement browser preserves an existing intentional login and its collection lock',async t=>{
  const native=trackedBrowser('native'),owned=trackedBrowser('owned');
  const {agent}=await fixture(t,{browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>native.browser,
    prepareNativeBrowser:async()=>{throw Error('native bridge unavailable');},platformUrls:{clickandboat:'https://example.invalid/'}});
  await agent.openLogin('clickandboat');const activePage=agent.loginPage;
  await assert.rejects(agent.openLogin('samboat'),/native bridge unavailable/);
  assert.equal(agent.loginSource,'clickandboat');assert.equal(agent.loginPage,activePage);assert.equal(activePage.closed,0);
  assert.deepEqual(await agent.run(),{ok:false,reason:'login_in_progress'});
  await agent.close();
});

test('closing an opened login tab allows a manual run without closing any other native tab',async t=>{
  const native=trackedBrowser('native');
  const {agent,received}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
  await agent.openLogin('samboat');const login=agent.loginPage;login.isClosed=()=>true;
  assert.deepEqual(await agent.run({requestedRunId:MANUAL_ID}),{ok:true});
  assert.equal(received.length,5);assert.equal(agent.loginSource,null);assert.equal(agent.loginPage,null);
  assert.equal(login.closed,0);assert.equal(native.events.closed,0);
  await agent.close();assert.equal(login.closed,0);
});

test('a disconnected login browser releases the lock and reconnects for an automatic run',async t=>{
  const initial=trackedBrowser('initial'),replacement=trackedBrowser('replacement');let connections=0;
  const {agent,received}=await fixture(t,{nativeBrowserFactory:async()=>++connections===1?initial.browser:replacement.browser,
    platformUrls:{samboat:'https://example.invalid/'}});
  await agent.openLogin('samboat');const login=agent.loginPage;login.isClosed=()=>false;
  initial.browser.connected=false;
  agent.remote.poll=async()=>({ok:true,enabled:true,requested_run_id:null});
  await agent.tick();
  assert.equal(received.length,5);assert.equal(connections,2);assert.equal(agent.loginSource,null);
  assert.equal(login.closed,0);assert.equal(initial.events.closed,0);
  await agent.close();
});

test('status clears a known closed login tab but preserves an open or unverified login session',async t=>{
  const native=trackedBrowser('native');
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
  await agent.openLogin('samboat');const login=agent.loginPage;
  login.isClosed=()=>false;
  assert.equal((await agent.status()).login_source,'samboat');
  assert.deepEqual(await agent.run(),{ok:false,reason:'login_in_progress'});
  login.isClosed=()=>{throw Error('unverified');};
  assert.equal((await agent.status()).login_source,'samboat');
  delete login.isClosed;assert.equal((await agent.status()).login_source,'samboat');
  login.isClosed=()=>true;
  assert.equal((await agent.status()).login_source,null);assert.equal(login.closed,0);
  await agent.close();
});
test('native collector timeout closes only its own page, disconnects, and preserves owned Chromium',async t=>{
  // MMK collects after SamBoat on native Chrome, so it must open a new
  // connection instead of reusing the one dropped by the SamBoat timeout.
  const owned=trackedBrowser('owned'),native=trackedBrowser('native'),reconnected=trackedBrowser('reconnected');let connections=0;
  const {agent,received}=await fixture(t,{platformTimeout:30,browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>++connections===1?native.browser:reconnected.browser});
  const prior=new Date(NOW-INTERVAL).toISOString();agent.state.sources.samboat.last_success_at=prior;
  agent.collectors.samboat=()=>new Promise(()=>{});
  await agent.run();
  assert.equal(native.events.created[0].closed,1);assert.equal(native.events.disconnected,1);assert.equal(native.events.closed,0);assert.equal(native.events.killed,0);
  assert.equal(owned.events.killed,0);assert.equal(owned.events.closed,0);assert.equal(agent.browser,owned.browser);
  assert.equal(connections,2);assert.equal(agent.nativeBrowser,reconnected.browser);assert.notEqual(agent.nativeBrowser,native.browser);
  assert.equal(reconnected.events.disconnected,0);assert.ok(reconnected.events.created.every(page=>page.closed===1));
  assert.equal(agent.state.sources.samboat.last_success_at,prior);
  assert.equal(received.find(item=>item.snapshots[0].source==='samboat').snapshots[0].outcome,'failure');
  await agent.close();
});
test('late native connection after deadline is disconnected without running a collector or replacing owned browser',async t=>{
  const owned=trackedBrowser('owned'),native=trackedBrowser('native');let resolveConnect,started;
  const connecting=new Promise(resolve=>{started=resolve;});
  const {agent}=await fixture(t,{platformTimeout:30,browserFactory:async()=>owned.browser,nativeBrowserFactory:()=>{started();return new Promise(resolve=>{resolveConnect=resolve;});}});
  let collections=0;agent.collectors.samboat=async()=>{collections++;return snapshot('samboat');};
  const run=agent.run();await connecting;await run;
  resolveConnect(native.browser);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(collections,0);assert.equal(native.events.created.length,0);assert.equal(native.events.disconnected,1);assert.equal(native.events.closed,0);
  assert.equal(owned.events.killed,0);assert.equal(agent.nativeBrowser,null);assert.equal(agent.browser,owned.browser);await agent.close();
});
test('unavailable native endpoint fails Boataround and SamBoat closed without trying another browser profile',async t=>{
  const owned=trackedBrowser('owned');
  const {agent,received}=await fixture(t,{browserFactory:async()=>owned.browser,nativeBrowserFactory:async()=>{throw Error('connection failed');}});
  let calls=0;agent.collectors.samboat=async()=>{calls++;return snapshot('samboat');};
  await agent.run();assert.equal(calls,0);assert.equal(owned.events.created.length,1);
  for(const source of ['boataround','samboat','mmk','nausys'])assert.equal(received.find(item=>item.snapshots[0].source===source).snapshots[0].outcome,'failure');await agent.close();
});
test('shutdown closes only agent-created native pages and disconnects even if a page close fails',async t=>{
  const native=trackedBrowser('native');
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
  await agent.openLogin('samboat');native.events.created[0].close=async()=>{throw Error('page gone');};
  await agent.close();assert.equal(native.events.closed,0);assert.equal(native.events.disconnected,1);
  await assert.rejects(agent.ensureBrowser('samboat'),{code:'fetch_failed'});
});
test('native login page resolving after shutdown is closed without navigation',async t=>{
  const native=trackedBrowser('native');let resolvePage,signalCreating;
  const creating=new Promise(resolve=>{signalCreating=resolve;});
  const latePage={closed:0,visited:0,close:async()=>{latePage.closed++;},goto:async()=>{latePage.visited++;}};
  native.browser.newPage=()=>{signalCreating();return new Promise(resolve=>{resolvePage=resolve;});};
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,platformUrls:{samboat:'https://example.invalid/'}});
  const opening=agent.openLogin('samboat');await creating;await agent.close();resolvePage(latePage);
  await assert.rejects(opening,{code:'fetch_failed'});
  assert.equal(latePage.closed,1);assert.equal(latePage.visited,0);assert.equal(native.events.closed,0);assert.equal(native.events.disconnected,1);
});
test('native preparation runs before connecting and again before cached reuse, but never for owned sources',async t=>{
  const native=trackedBrowser('native'),owned=trackedBrowser('owned'),events=[],controller=new AbortController();
  const {agent}=await fixture(t,{browserFactory:async()=>owned.browser,
    nativeBrowserFactory:async()=>{events.push('connect');return native.browser;},
    prepareNativeBrowser:async context=>{assert.equal(context.source,'samboat');assert.equal(context.signal,controller.signal);events.push('prepare');}});
  assert.equal(await agent.ensureBrowser('samboat',controller.signal),native.browser);
  assert.equal(await agent.ensureBrowser('clickandboat'),owned.browser);
  assert.equal(await agent.ensureBrowser('samboat',controller.signal),native.browser);
  assert.deepEqual(events,['prepare','connect','prepare']);await agent.close();
});
test('already aborted or closed native access never invokes preparation or connection',async t=>{
  let preparations=0,connections=0;const controller=new AbortController();controller.abort();
  const {agent}=await fixture(t,{prepareNativeBrowser:async()=>{preparations++;},nativeBrowserFactory:async()=>{connections++;}});
  await assert.rejects(agent.ensureBrowser('samboat',controller.signal),{code:'fetch_failed'});
  await agent.close();await assert.rejects(agent.ensureBrowser('samboat'),{code:'fetch_failed'});
  assert.equal(preparations,0);assert.equal(connections,0);
});
test('abort during native preparation prevents a late connection',async t=>{
  let resolvePreparation,connections=0;const controller=new AbortController();
  const {agent}=await fixture(t,{prepareNativeBrowser:()=>new Promise(resolve=>{resolvePreparation=resolve;}),nativeBrowserFactory:async()=>{connections++;}});
  const preparing=agent.ensureBrowser('samboat',controller.signal);controller.abort();resolvePreparation();
  await assert.rejects(preparing,{code:'fetch_failed'});assert.equal(connections,0);assert.equal(agent.nativeBrowser,null);await agent.close();
});
test('platform deadline during native preparation records failure and a late hook cannot start a connection or page',async t=>{
  const native=trackedBrowser('native'),owned=trackedBrowser('owned');let release,started,connections=0;
  const preparing=new Promise(resolve=>{started=resolve;});
  // The fixture persists state on a real Windows filesystem. A 30 ms deadline
  // could expire an unrelated healthy source under full-suite load.
  const {agent,received}=await fixture(t,{platformTimeout:1000,browserFactory:async()=>owned.browser,
    nativeBrowserFactory:async()=>{connections++;return native.browser;},
    prepareNativeBrowser:()=>{started();return new Promise(resolve=>{release=resolve;});}});
  const prior=new Date(NOW-INTERVAL).toISOString();agent.state.sources.samboat.last_success_at=prior;
  const running=agent.run();await preparing;await running;release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(agent.busy,false);assert.equal(connections,0);assert.equal(native.events.created.length,0);assert.equal(owned.events.killed,0);
  assert.equal(agent.state.sources.samboat.last_success_at,prior);
  assert.equal(received.find(item=>item.snapshots[0].source==='samboat').snapshots[0].outcome,'failure');await agent.close();
});
test('shutdown during login preparation prevents late native connection and page creation',async t=>{
  let release,connections=0;
  const {agent}=await fixture(t,{prepareNativeBrowser:()=>new Promise(resolve=>{release=resolve;}),nativeBrowserFactory:async()=>{connections++;}});
  const opening=agent.openLogin('samboat');await agent.close();release();
  await assert.rejects(opening,{code:'fetch_failed'});assert.equal(connections,0);assert.equal(agent.managedPages.size,0);assert.equal(agent.busy,false);
});
test('failed preparation does not return a cached native connection',async t=>{
  const native=trackedBrowser('native');let fail=false,connections=0;
  const {agent}=await fixture(t,{prepareNativeBrowser:async()=>{if(fail)throw Object.assign(Error('prepare_failed'),{code:'fetch_failed'});},nativeBrowserFactory:async()=>{connections++;return native.browser;}});
  await agent.ensureBrowser('samboat');fail=true;
  await assert.rejects(agent.ensureBrowser('samboat'),{code:'fetch_failed'});
  assert.equal(connections,1);assert.equal(native.events.created.length,0);assert.equal(native.events.closed,0);await agent.close();
});

test('native collection succeeds without a wake when background Chrome works',async t=>{
 const native=trackedBrowser('native'),modes=[];const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,prepareNativeBrowser:async c=>modes.push(c.forceWake)});
 await agent.run();assert.deepEqual(modes,[false,false,false,false]);
 for(const source of ['boataround','samboat','mmk','nausys']){assert.equal(agent.state.sources[source].screen_mode,'background');assert.equal(agent.state.sources[source].state,'synced');}await agent.close();
});
test('one transient native failure permits exactly one wake fallback and one accepted snapshot',async t=>{
 const native=trackedBrowser('native'),modes=[];const {agent,received}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,prepareNativeBrowser:async c=>modes.push(c.forceWake)});let calls=0;
 agent.collectors.samboat=async()=>{if(++calls===1)throw Error('renderer suspended');return snapshot('samboat');};
 await agent.run();assert.deepEqual(modes,[false,false,true,false,false]);assert.equal(calls,2);assert.equal(agent.state.sources.samboat.screen_mode,'wake_fallback');assert.equal(received.flatMap(p=>p.snapshots).filter(s=>s.source==='samboat').length,1);await agent.close();
});
test('authentication and schema failures never turn on the screen',async t=>{
 for(const source of ['boataround','samboat','mmk','nausys'])for(const code of ['auth_required','schema_changed','incomplete_pages']){const native=trackedBrowser('native'),modes=[];const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser,prepareNativeBrowser:async c=>modes.push(c.forceWake)});
 agent.collectors[source]=async()=>{throw Object.assign(Error(code),{code});};await agent.run();assert.deepEqual(modes,[false,false,false,false]);await agent.close();}
});

test('failed page closure retains ownership and a later close can recover without touching other tabs',async t=>{
  const native=trackedBrowser('native');const {agent}=await fixture(t,{nativeBrowserFactory:async()=>native.browser});
  const page=await agent.createManagedPage('samboat',native.browser);let calls=0;
  page.isClosed=()=>false;page.close=async()=>{if(++calls===1)throw Error('suspended protocol');};
  assert.equal(await agent.closeManagedPage(page),false);
  assert.equal(agent.managedPages.has(page),true);assert.equal(agent.pendingPageClosures.has(page),true);
  assert.equal(await agent.closeManagedPage(page),true);assert.equal(calls,2);
  assert.equal(agent.managedPages.size,0);assert.equal(agent.pendingPageClosures.size,0);
  assert.equal(native.events.closed,0);await agent.close();
});

test('a native reconnect closes only the recorded orphan target and never unrelated same-site tabs',async t=>{
  const first=trackedBrowser('first'),next=trackedBrowser('next');let connections=0;
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>++connections===1?first.browser:next.browser});
  const browser=await agent.ensureBrowser('samboat'),ownedId='A'.repeat(32),otherId='B'.repeat(32);
  const page=await agent.createManagedPage('samboat',browser);
  agent.pageOwnership.get(page).targetId=ownedId;
  page.isClosed=()=>false;page.close=async()=>{throw Error('old connection disconnected');};
  assert.equal(await agent.closeManagedPage(page),false);first.browser.connected=false;
  let oursClosed=0,otherClosed=0;
  next.browser.targets=()=>[
    {_targetId:otherId,page:async()=>({close:async()=>{otherClosed++;}})},
    {_targetId:ownedId,page:async()=>({close:async()=>{oursClosed++;}})}
  ];
  await agent.ensureBrowser('samboat');
  assert.equal(oursClosed,1);assert.equal(otherClosed,0);assert.equal(agent.managedPages.size,0);
  assert.equal(first.events.closed,0);assert.equal(next.events.closed,0);await agent.close();
});

test('wake fallback replaces a falsely connected native socket and closes only its recorded orphan',async t=>{
  const first=trackedBrowser('stale'),fresh=trackedBrowser('fresh'),ownedId='1'.repeat(32),userId='2'.repeat(32);
  const events=[];let connections=0,ours=0,user=0,samboatCalls=0;
  const create=first.browser.newPage;
  first.browser.newPage=async()=>{
    const page=await create();
    if(first.events.created.length===2){page.target=()=>({_targetId:ownedId});page.close=async()=>{throw Error('stale protocol');};}
    return page;
  };
  fresh.browser.targets=()=>[
    {_targetId:userId,page:async()=>({close:async()=>{user++;}})},
    {_targetId:ownedId,page:async()=>({close:async()=>{ours++;}})}
  ];
  const {agent,received}=await fixture(t,{
    nativeBrowserFactory:async()=>{events.push('connect');return ++connections===1?first.browser:fresh.browser;},
    prepareNativeBrowser:async({source,forceWake})=>{events.push(source+':'+forceWake);if(forceWake){assert.equal(first.events.disconnected,1);assert.equal(agent.nativeBrowser,null);}}
  });
  agent.collectors.samboat=async({page,reportDiagnostic})=>{
    samboatCalls++;
    if(samboatCalls===1){assert.equal(first.browser.connected,true);reportDiagnostic({stage:'list_ready',reason:'progress'});throw Error('secret protocol details');}
    assert.equal(page.name,'fresh');return snapshot('samboat');
  };
  await agent.run();
  assert.equal(connections,2);assert.equal(samboatCalls,2);assert.equal(ours,1);assert.equal(user,0);
  assert.equal(first.events.closed,0);assert.equal(first.events.killed,0);assert.equal(fresh.events.closed,0);
  assert.equal(agent.managedPages.size,0);
  assert.deepEqual(events,['boataround:false','connect','samboat:false','samboat:true','connect','mmk:false','nausys:false']);
  const summary=agent.state.sources.samboat.collection_history.at(-1);
  assert.equal(summary.outcome,'success');assert.equal(summary.attempts,2);assert.equal(summary.screen_mode,'wake_fallback');
  assert.equal(summary.attempt_errors.length,1);assert.equal(summary.attempt_errors[0].last_diagnostic.stage,'list_ready');
  assert.equal(summary.attempt_errors[0].error_code,'fetch_failed');
  assert.equal(received.flatMap(packet=>packet.snapshots).filter(s=>s.source==='samboat').length,1);
  await agent.close();
});

test('aborted or failed wake preparation leaves stale native cache disconnected and never closes Chrome',async t=>{
  const native=trackedBrowser('native');let connections=0;
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>{connections++;return native.browser;},
    prepareNativeBrowser:async({forceWake})=>{if(forceWake)throw Error('bridge failed');}});
  await agent.ensureBrowser('samboat');
  await assert.rejects(agent.ensureBrowser('samboat',undefined,true),/bridge failed/);
  assert.equal(agent.nativeBrowser,null);assert.equal(connections,1);assert.equal(native.events.disconnected,1);
  const abort=new AbortController();abort.abort();
  await assert.rejects(agent.ensureBrowser('samboat',abort.signal,true),{code:'fetch_failed'});
  assert.equal(connections,1);assert.equal(native.events.closed,0);await agent.close();
});

test('local collection diagnostics retain only bounded vocabulary and never enter uploaded snapshots',async t=>{
  const {agent,home,received}=await fixture(t);
  agent.collectors.samboat=async({reportDiagnostic})=>{
    for(let n=0;n<40;n++)reportDiagnostic({stage:n%2?'list_ready':'raw_document',reason:'progress',url:'https://secret.invalid/',token:'private'});
    reportDiagnostic({stage:'secret-stage',reason:'progress'});
    reportDiagnostic({stage:'list_ready',reason:'secret-token'});
    reportDiagnostic({stage:'native_prepare',reason:'progress'}); // Collector cannot forge a runtime stage.
    reportDiagnostic({stage:'detail_parse',reason:'http_status',message:'private-password'});
    throw Object.assign(Error('private-password'),{code:'schema_changed'});
  };
  await agent.run();
  const state=agent.state.sources.samboat;
  assert.equal(state.diagnostic_trace.length,24);assert.equal(state.last_diagnostic.stage,'detail_parse');
  assert.equal(state.last_diagnostic.reason,'http_status');assert.equal(state.collection_history.length,1);
  const history=state.collection_history[0];
  assert.equal(history.outcome,'failure');assert.equal(history.error_code,'schema_changed');assert.equal(history.attempts,1);
  assert.equal(history.attempt_errors.length,1);assert.equal(history.last_diagnostic.reason,'http_status');
  const persisted=await fs.readFile(path.join(home,'state.json'),'utf8');
  for(const secret of ['secret.invalid','private-password','secret-token','secret-stage','"token"'])assert.equal(persisted.includes(secret),false);
  for(const packet of received)for(const result of packet.snapshots){assert.equal('last_diagnostic' in result,false);assert.equal('diagnostic_trace' in result,false);assert.equal('collection_history' in result,false);}
  assert.equal(JSON.parse(persisted).sources.samboat.collection_history.length,1);
});

test('collection history keeps the latest thirty results and starts a fresh trace for each run',async t=>{
  const {agent}=await fixture(t);await agent.run();
  const old=agent.state.sources.samboat.collection_history[0];
  agent.state.sources.samboat.collection_history=Array.from({length:29},(_,index)=>({...old,started_at:new Date(NOW-index-1).toISOString()}));
  let run=0;
  agent.collectors.samboat=async({reportDiagnostic})=>{run++;reportDiagnostic({stage:run===1?'detail_parse':'final_recheck',reason:'progress'});return snapshot('samboat');};
  await agent.run();await agent.run();
  const state=agent.state.sources.samboat;
  assert.equal(state.collection_history.length,30);assert.equal(state.diagnostic_trace.some(d=>d.stage==='detail_parse'),false);
  assert.equal(state.diagnostic_trace.some(d=>d.stage==='final_recheck'),true);
  assert.equal(state.collection_history.at(-1).outcome,'success');assert.equal(state.last_diagnostic.reason,'complete');
});

test('collector diagnostics arriving after timeout or during another run cannot contaminate the current result',async t=>{
  const {agent}=await fixture(t,{platformTimeout:1000});let late;
  agent.collectors.samboat=async({reportDiagnostic})=>{
    late=reportDiagnostic;reportDiagnostic({stage:'list_ready',reason:'progress'});return new Promise(()=>{});
  };
  await agent.run();
  const failed=structuredClone(agent.state.sources.samboat);
  assert.equal(failed.collection_history[0].outcome,'failure');assert.equal(failed.last_diagnostic.reason,'timeout');
  late({stage:'detail_parse',reason:'http_status'});assert.deepEqual(agent.state.sources.samboat,failed);
  agent.collectors.samboat=async({reportDiagnostic})=>{
    reportDiagnostic({stage:'final_recheck',reason:'progress'});late({stage:'detail_parse',reason:'schema_changed'});return snapshot('samboat');
  };
  await agent.run();
  assert.equal(agent.state.sources.samboat.diagnostic_trace.some(d=>d.stage==='detail_parse'),false);
  assert.equal(agent.state.sources.samboat.collection_history.at(-1).outcome,'success');
});

test('shutdown rejects late diagnostic callbacks without recording a completed source result',async t=>{
  const {agent}=await fixture(t);let entered,late;
  const started=new Promise(resolve=>{entered=resolve;});
  agent.collectors.boataround=async({reportDiagnostic})=>{late=reportDiagnostic;reportDiagnostic({stage:'list_ready',reason:'progress'});entered();return new Promise(()=>{});};
  const running=agent.run();await started;await agent.close();assert.deepEqual(await running,{ok:false,reason:'closed'});
  const before=structuredClone(agent.state.sources.boataround);
  late({stage:'detail_parse',reason:'http_status'});assert.deepEqual(agent.state.sources.boataround,before);
  assert.equal(agent.state.sources.boataround.collection_history,undefined);
});

test('a disk-full run drains blocked diagnostic state writes before rejecting',async t=>{
  const {agent,home}=await fixture(t);let entered,release,enqueued,writes=0,settled=false;
  const blocked=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const enqueueSeen=new Promise(resolve=>{enqueued=resolve;});
  const original=fs.writeFile;
  t.mock.method(fs,'writeFile',async(file,...args)=>{
    if(String(file).startsWith(path.join(home,'state.json')+'.')){
      writes++;
      if(JSON.parse(args[0]).sources.boataround.last_diagnostic?.stage==='detail_parse'){entered();await gate;}
    }
    return original(file,...args);
  });
  agent.collectors.boataround=async({reportDiagnostic})=>{
    reportDiagnostic({stage:'detail_parse',reason:'progress'});await blocked;return snapshot();
  };
  agent.enqueue=async()=>{enqueued();throw Object.assign(Error('disk full'),{code:'ENOSPC'});};
  const running=agent.run();running.then(()=>{settled=true;},()=>{settled=true;});
  await enqueueSeen;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);assert.equal(agent.pendingDiagnosticWrites.size,1);
  release();await assert.rejects(running,{code:'ENOSPC'});
  assert.equal(agent.pendingDiagnosticWrites.size,0);assert.equal(agent.busy,false);
  const finishedWrites=writes;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,finishedWrites);
  assert.equal((await fs.readdir(home)).some(file=>file.endsWith('.tmp')),false);
});

test('close waits for an in-flight diagnostic atomic write and starts none after returning',async t=>{
  const {agent,home}=await fixture(t);let entered,release,writes=0,closed=false;
  const blocked=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const original=fs.writeFile;
  t.mock.method(fs,'writeFile',async(file,...args)=>{
    if(String(file).startsWith(path.join(home,'state.json')+'.')){
      writes++;
      if(JSON.parse(args[0]).sources.boataround.last_diagnostic?.stage==='detail_parse'){entered();await gate;}
    }
    return original(file,...args);
  });
  agent.collectors.boataround=async({reportDiagnostic})=>{
    reportDiagnostic({stage:'detail_parse',reason:'progress'});return new Promise(()=>{});
  };
  const running=agent.run();await blocked;
  const closing=agent.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false);assert.equal(agent.pendingDiagnosticWrites.size,1);
  release();await closing;assert.deepEqual(await running,{ok:false,reason:'closed'});
  assert.equal(agent.pendingDiagnosticWrites.size,0);
  const finishedWrites=writes;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,finishedWrites);
  assert.equal((await fs.readdir(home)).some(file=>file.endsWith('.tmp')),false);
});

test('native reconnect replaces a hung old close, coalesces on the new connection, and ignores old cleanup',async t=>{
  const first=trackedBrowser('first'),next=trackedBrowser('next');let connections=0;
  const {agent}=await fixture(t,{nativeBrowserFactory:async()=>++connections===1?first.browser:next.browser});
  const browser=await agent.ensureBrowser('samboat'),page=await agent.createManagedPage('samboat',browser);
  agent.pageOwnership.get(page).targetId='E'.repeat(32);page.isClosed=()=>false;
  let rejectOld,resolveNew,newCalls=0,oldCalls=0,otherCalls=0;
  page.close=()=>{oldCalls++;return new Promise((resolve,reject)=>{rejectOld=reject;});};
  // Keep the test alive while the production shutdown-safe unref timer runs.
  const keepAlive=setInterval(()=>{},5000);t.after(()=>clearInterval(keepAlive));
  assert.equal(await agent.closeManagedPage(page),false);assert.equal(agent.managedPages.has(page),true);
  const oldRecord=agent.closingPages.get(page);first.browser.connected=false;
  next.browser.targets=()=>[
    {_targetId:'F'.repeat(32),page:async()=>({close:async()=>{otherCalls++;}})},
    {_targetId:'E'.repeat(32),page:async()=>({close:()=>{newCalls++;return new Promise(resolve=>{resolveNew=resolve;});}})}
  ];
  const reconnecting=agent.ensureBrowser('samboat');
  while(!resolveNew)await new Promise(resolve=>setImmediate(resolve));
  const newRecord=agent.closingPages.get(page);assert.notEqual(newRecord,oldRecord);
  assert.equal(newRecord.browser,next.browser);assert.equal(oldCalls,1);assert.equal(newCalls,1);
  // A second caller on this same recovered connection must reuse its command.
  const merged=agent.closeManagedPage(page,{browser:next.browser});
  rejectOld(Error('late old disconnect'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(agent.closingPages.get(page),newRecord);assert.equal(agent.managedPages.has(page),true);
  assert.equal(newCalls,1);resolveNew();
  assert.equal(await merged,true);assert.equal(await reconnecting,next.browser);
  assert.equal(agent.managedPages.size,0);assert.equal(agent.closingPages.size,0);assert.equal(otherCalls,0);
  await agent.close();
});

test('reconnect forgets a positively absent owned target, but unknown ownership blocks new native pages',async t=>{
  for(const known of [true,false]){
    const first=trackedBrowser('first'),next=trackedBrowser('next');let connections=0;
    const {agent}=await fixture(t,{nativeBrowserFactory:async()=>++connections===1?first.browser:next.browser});
    const browser=await agent.ensureBrowser('samboat'),page=await agent.createManagedPage('samboat',browser);
    agent.pageOwnership.get(page).targetId=known?'C'.repeat(32):null;
    page.isClosed=()=>false;page.close=async()=>{throw Error('disconnected');};
    await agent.closeManagedPage(page);first.browser.connected=false;
    let unrelated=0;next.browser.targets=()=>[{_targetId:'D'.repeat(32),page:async()=>({close:async()=>{unrelated++;}})}];
    if(known){await agent.ensureBrowser('samboat');assert.equal(agent.managedPages.size,0);}
    else{await assert.rejects(agent.ensureBrowser('samboat'),{code:'fetch_failed'});assert.equal(agent.managedPages.has(page),true);}
    assert.equal(unrelated,0);assert.equal(next.events.created.length,0);await agent.close();
  }
});

test('pending close is bounded, coalesced, and retained until its late success',async t=>{
  const {agent}=await fixture(t);let release,calls=0;
  const page={isClosed:()=>false,close:()=>{calls++;return new Promise(resolve=>{release=resolve;});}};
  agent.managedPages.add(page);
  // The production close timer is unref'ed so shutdown is never held open by it.
  const keepAlive=setInterval(()=>{},5000);t.after(()=>clearInterval(keepAlive));
  const started=performance.now();
  assert.equal(await agent.closeManagedPage(page),false);
  assert.ok(performance.now()-started<4000);assert.equal(agent.managedPages.has(page),true);
  const second=agent.closeManagedPage(page);assert.equal(calls,1);release();
  assert.equal(await second,true);assert.equal(agent.managedPages.size,0);assert.equal(agent.closingPages.size,0);
  await agent.close();
});

test('in-flight page creations reserve the bounded ownership capacity and failed creation releases its slot',async t=>{
  const {agent}=await fixture(t);let created=0;
  const releases=[];const browser={newPage:()=>{created++;return new Promise(resolve=>releases.push(resolve));}};
  const pending=Array.from({length:8},()=>agent.createManagedPage('samboat',browser));
  await assert.rejects(agent.createManagedPage('samboat',browser),{code:'fetch_failed'});assert.equal(created,8);
  for(const release of releases)release({close:async()=>{}});await Promise.all(pending);
  assert.equal(agent.pageCreations,0);assert.equal(agent.managedPages.size,8);
  await assert.rejects(agent.createManagedPage('samboat',browser),{code:'fetch_failed'});
  await agent.close();assert.equal(agent.managedPages.size,0);
  const second=await fixture(t);await assert.rejects(second.agent.createManagedPage('samboat',{newPage:async()=>{throw Error('creation failed');}}),/creation failed/);
  assert.equal(second.agent.pageCreations,0);assert.equal(second.agent.managedPages.size,0);await second.agent.close();
});
