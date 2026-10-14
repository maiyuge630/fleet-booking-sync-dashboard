import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {acquireServerGate,acquireServerLock as acquireRealServerLock} from '../server.mjs';
const acquireServerLock=(lock,options)=>acquireRealServerLock(lock,{readProcessStart:async()=>null,...options});

const BOOT='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-start-recovery-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));return {home,lock:path.join(home,'server.pid')};}
const release=gate=>new Promise(resolve=>gate.close(resolve));

test('a killed startup process releases the gate without deleting any files',async t=>{
  const {home,lock}=await fixture(t);
  const entry=new URL('../server.mjs',import.meta.url).href;
  const script=`import {acquireServerGate} from ${JSON.stringify(entry)};await acquireServerGate(process.argv[1]);process.send('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,lock],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let exited=false;child.once('exit',()=>{exited=true;});
  t.after(async()=>{if(!exited){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup fixture timed out')),8000);child.once('message',value=>{clearTimeout(timer);value==='ready'?resolve():reject(Error('unexpected child response'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup fixture exited early'));});});
  await assert.rejects(acquireServerLock(lock,{pid:23456,bootId:BOOT}),/recovery is already in progress/);
  const killed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await killed;
  const record=await acquireServerLock(lock,{pid:23456,bootId:BOOT});
  assert.equal(record.pid,23456);
  assert.deepEqual(await fs.readdir(home),['server.pid']);
  assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),record);
});

test('100 competing startup rounds preserve exactly one live owner and leave no gate artifacts',async t=>{
  const {home,lock}=await fixture(t);
  for(let round=0;round<100;round++){
    await fs.writeFile(lock,JSON.stringify({version:1,pid:100,boot_id:BOOT}));
    const results=await Promise.allSettled([200,300,400].map(pid=>acquireServerLock(lock,{pid,bootId:BOOT,processAlive:owner=>owner!==100})));
    const winners=results.filter(r=>r.status==='fulfilled');
    assert.equal(winners.length,1,'round '+round);
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),winners[0].value);
    assert.deepEqual(await fs.readdir(home),['server.pid']);
  }
});

test('a released gate can be reacquired and distinct installations do not share a gate',async t=>{
  const {home,lock}=await fixture(t),other=path.join(home,'other.pid');
  const gate=await acquireServerGate(lock),second=await acquireServerGate(other);
  try{await assert.rejects(acquireServerGate(lock),/recovery is already in progress/);}finally{await release(second);await release(gate);}
  await release(await acquireServerGate(lock));
  assert.deepEqual(await fs.readdir(home),[]);
});
