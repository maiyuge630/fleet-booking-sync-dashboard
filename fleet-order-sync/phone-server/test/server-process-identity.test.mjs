import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as server from '../server.mjs';

const BOOT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t,record){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-process-identity-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const lock=path.join(directory,'server.pid');
  if(record!==undefined)await fs.writeFile(lock,JSON.stringify(record));
  return lock;
}

test('same boot reused PID cannot indefinitely prevent the phone server from restarting',async t=>{
  const lock=await fixture(t,{version:1,pid:100,boot_id:BOOT,process_start:'1000'});
  const reads=[];
  const result=await server.acquireServerLock(lock,{pid:200,bootId:BOOT,processAlive:()=>true,
    readProcessStart:async pid=>{reads.push(pid);return pid===100?'9000':'10000';}});
  assert.deepEqual(result,{version:1,pid:200,boot_id:BOOT,process_start:'10000'});
  assert.deepEqual(reads,[200,100]);
  assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),result);
});

test('a verified live process with the same kernel identity cannot be displaced',async t=>{
  const previous={version:1,pid:100,boot_id:BOOT,process_start:'90071992547409931'},lock=await fixture(t,previous);
  await assert.rejects(server.acquireServerLock(lock,{pid:200,bootId:BOOT,processStart:'90071992547409932',
    processAlive:()=>true,readProcessStart:async pid=>{assert.equal(pid,100);return previous.process_start;}}),/already running/);
  assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),previous);
});

test('legacy locks and unavailable process identity retain the existing conservative live-PID rule',async t=>{
  for(const processStart of [null,'123']){
    const previous={version:1,pid:100,boot_id:BOOT},lock=await fixture(t,previous);
    await assert.rejects(server.acquireServerLock(lock,{pid:200,bootId:BOOT,processStart,processAlive:()=>true,
      readProcessStart:()=>{throw Error('legacy owner must not be guessed');}}),/already running/);
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),previous);
  }
  const previous={version:1,pid:100,boot_id:BOOT,process_start:'100'},lock=await fixture(t,previous);
  for(const processAlive of [()=>true,()=>undefined]){
    await assert.rejects(server.acquireServerLock(lock,{pid:200,bootId:BOOT,processStart:'200',processAlive,readProcessStart:async()=>null}),/already running/);
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),previous);
  }
});

test('unreadable process evidence cannot delete or replace a server lock',async t=>{
  const previous={version:1,pid:100,boot_id:BOOT,process_start:'100'},lock=await fixture(t,previous);
  for(const failPid of [100,200]){
    await assert.rejects(server.acquireServerLock(lock,{pid:200,bootId:BOOT,processAlive:()=>true,
      readProcessStart:async pid=>{if(pid===failPid)throw Error('Cannot verify process start identity');return '200';}}),/Cannot verify/);
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),previous);
  }
});

test('a verified reboot or dead PID can recover without reading the previous process identity',async t=>{
  for(const reboot of [false,true]){
    const lock=await fixture(t,{version:1,pid:100,boot_id:BOOT,process_start:'100'});
    const result=await server.acquireServerLock(lock,{pid:200,bootId:reboot?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':BOOT,
      processStart:'200',processAlive:()=>{if(reboot)throw Error('old boot must skip probing');return false;},
      readProcessStart:()=>{throw Error('old PID must not be read');}});
    assert.equal(result.pid,200);assert.equal(result.process_start,'200');
  }
});

test('malformed persisted process identities fail closed rather than authorizing reclamation',async t=>{
  for(const value of ['',100,'-1','1.5','01','1e3','9'.repeat(32),{},true]){
    const previous={version:1,pid:100,boot_id:BOOT,process_start:value},lock=await fixture(t,previous);
    await assert.rejects(server.acquireServerLock(lock,{pid:200,bootId:BOOT,processStart:'200',processAlive:()=>false}),/lock is invalid/);
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),previous);
  }
});

test('concurrent reclamation of a reused PID still preserves exactly one new owner',async t=>{
  const lock=await fixture(t,{version:1,pid:100,boot_id:BOOT,process_start:'1'});
  const results=await Promise.allSettled([200,300,400].map(pid=>server.acquireServerLock(lock,{pid,bootId:BOOT,
    processAlive:()=>true,readProcessStart:async observed=>String(observed*100)})));
  const winners=results.filter(result=>result.status==='fulfilled');
  assert.equal(winners.length,1);assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),winners[0].value);
});

function statLine({pid=100,comm='node',start='123456789',state='S'}={}){
  return pid+' ('+comm+') '+[state,...Array(18).fill('0'),start,...Array(30).fill('0')].join(' ')+'\n';
}
test('Linux and Android procstat identity uses field22 despite spaces and parentheses in executable names',async()=>{
  for(const platform of ['android','linux'])for(const comm of ['node','node worker','odd ) name (worker)']){
    assert.equal(await server.readProcessStartTicks(100,{platform,readFile:async(filename,encoding)=>{
      assert.equal(filename,'/proc/100/stat');assert.equal(encoding,'utf8');return statLine({comm,start:'90071992547409931'});
    }}),'90071992547409931');
  }
  let reads=0;
  assert.equal(await server.readProcessStartTicks(100,{platform:'win32',readFile:async()=>{reads++;}}),null);assert.equal(reads,0);
});

test('unavailable or malformed procstat never becomes a guessed process identity',async()=>{
  for(const text of [statLine({pid:101}),statLine({start:'-1'}),statLine({start:'1.2'}),statLine({start:'01'}),statLine({state:'?' }),'100 (node) S 1 2','not stat','x'.repeat(4097)]){
    await assert.rejects(server.readProcessStartTicks(100,{platform:'android',readFile:async()=>text}),/Invalid process start identity/);
  }
  for(const code of ['ENOENT','EACCES','EIO'])await assert.rejects(server.readProcessStartTicks(100,{platform:'android',readFile:async()=>{throw Object.assign(Error('private diagnostic'),{code});}}),{message:'Cannot verify process start identity'});
  for(const pid of [0,-1,'100',1.5,Infinity])await assert.rejects(server.readProcessStartTicks(pid,{platform:'android'}),/Invalid process identity/);
});
