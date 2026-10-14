import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PhoneAgent,loadConfiguration} from '../core.mjs';

const NOW=Date.parse('2026-09-20T07:00:00Z');
async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-state-audit20-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const config=await loadConfiguration(home);config.paired=true;
 const uploads=[];
 const remote={poll:async()=>({ok:true,enabled:false,requested_run_id:null}),upload:async p=>{uploads.push(p);return {results:p.snapshots.map(s=>({source:s.source,accepted:true,outcome:'success'}))};}};
 const create=()=>new PhoneAgent({home,config,remote,now:()=>NOW}).init();
 const agent=await create();
 const snapshot={source:'samboat',run_id:'synthetic-recovery',checked_at:new Date(NOW).toISOString(),complete:true,orders:[],pagination:{complete:true}};
 await agent.enqueue(snapshot);
 return {home,config,uploads,create,snapshot};
}

for(const body of ['{"version":1,"sources":', 'null', '[]', '{"version":1}', '{"version":1,"sources":{"samboat":null}}']){
 test('damaged operational state preserves queued evidence and recovers conservative status: '+body,async t=>{
  const h=await fixture(t);await fs.writeFile(path.join(h.home,'state.json'),body);
  const queued=await fs.readdir(path.join(h.home,'outbox'));
  const before=await fs.readFile(path.join(h.home,'outbox',queued[0]),'utf8');
  const agent=await h.create();
  assert.equal(agent.state.enabled,false);assert.equal(agent.state.last_requested_run_id,null);
  for(const source of ['boataround','clickandboat','samboat'])assert.equal(agent.state.sources[source].state,'needs_login');
  const backup='state-recovery-'+createHash('sha256').update(body).digest('hex')+'.json';
  assert.equal(await fs.readFile(path.join(h.home,backup),'utf8'),body);
  assert.equal(await fs.readFile(path.join(h.home,'outbox',queued[0]),'utf8'),before);
  await agent.tick();assert.equal(h.uploads.length,1);assert.deepEqual(h.uploads[0].snapshots,[h.snapshot]);
  assert.equal(agent.state.sources.samboat.state,'synced');
  assert.equal(agent.state.sources.boataround.last_success_at,null);
 });
}

test('future state schema and state read IO errors stay visible without replacement',async t=>{
 const h=await fixture(t),file=path.join(h.home,'state.json'),body='{"version":2,"sources":{}}';
 await fs.writeFile(file,body);await assert.rejects(h.create(),{code:'invalid_state'});
 assert.equal(await fs.readFile(file,'utf8'),body);
 const original=fs.readFile;t.mock.method(fs,'readFile',async(name,...rest)=>{if(name===file)throw Object.assign(Error('synthetic'),{code:'EACCES'});return original(name,...rest);});
 await assert.rejects(h.create(),{code:'EACCES'});
});

test('recovery backup failure cannot replace original state or claim recovery',async t=>{
 const h=await fixture(t),file=path.join(h.home,'state.json'),body='{"version":1';await fs.writeFile(file,body);
 const original=fs.writeFile;t.mock.method(fs,'writeFile',async(name,...rest)=>{if(String(name).includes('state-recovery-'))throw Object.assign(Error('synthetic disk full'),{code:'ENOSPC'});return original(name,...rest);});
 await assert.rejects(h.create(),{code:'ENOSPC'});assert.equal(await fs.readFile(file,'utf8'),body);assert.equal(h.uploads.length,0);
});

test('partial disk-full backup write does not poison later recovery or lose queued orders',async t=>{
 const h=await fixture(t),file=path.join(h.home,'state.json'),body='{"version":1,"sources":';await fs.writeFile(file,body);
 const original=fs.writeFile;let injected=false;
 const mock=t.mock.method(fs,'writeFile',async(name,data,...rest)=>{
  if(!injected&&String(name).includes('state-recovery-')){
   injected=true;await original(name,String(data).slice(0,8),...rest);
   throw Object.assign(Error('synthetic partial disk full'),{code:'ENOSPC'});
  }
  return original(name,data,...rest);
 });
 await assert.rejects(h.create(),{code:'ENOSPC'});mock.mock.restore();
 assert.equal(await fs.readFile(file,'utf8'),body);
 assert.deepEqual((await fs.readdir(h.home)).filter(name=>name.startsWith('state-recovery-')),[]);
 const recovered=await h.create();await recovered.tick();
 assert.equal(h.uploads.length,1);assert.deepEqual(h.uploads[0].snapshots,[h.snapshot]);
});

test('a complete recovery backup is reused after the replacement state write fails',async t=>{
 const h=await fixture(t),file=path.join(h.home,'state.json'),body='{"version":1,"sources":';await fs.writeFile(file,body);
 const rename=fs.rename;let injected=false;
 const mock=t.mock.method(fs,'rename',async(from,to)=>{
  if(to===file&&!injected){injected=true;throw Object.assign(Error('synthetic state write failed'),{code:'EIO'});}
  return rename(from,to);
 });
 await assert.rejects(h.create(),{code:'EIO'});mock.mock.restore();
 assert.equal(await fs.readFile(file,'utf8'),body);
 const recovered=await h.create();assert.ok(recovered.state.state_recovery);
 assert.equal((await fs.readdir(h.home)).filter(name=>name.startsWith('state-recovery-')).length,1);
 await recovered.tick();assert.equal(h.uploads.length,1);
});

test('truncated multibyte state is preserved byte for byte before conservative recovery',async t=>{
 const h=await fixture(t),file=path.join(h.home,'state.json');
 const raw=Buffer.from('{"version":1,"note":"中文').subarray(0,-1);
 await fs.writeFile(file,raw);const recovered=await h.create();
 const backup=path.join(h.home,'state-recovery-'+createHash('sha256').update(raw).digest('hex')+'.json');
 assert.deepEqual(await fs.readFile(backup),raw);
 assert.equal(recovered.state.sources.samboat.last_success_at,null);
 await recovered.tick();assert.equal(h.uploads.length,1);
});
