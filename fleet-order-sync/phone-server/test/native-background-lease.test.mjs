import test from 'node:test';
import assert from 'node:assert/strict';
import {startNativeBackgroundLease} from '../server.mjs';
test('background root work never overlaps and stopping aborts it without touching screen keys',async()=>{
 let calls=0,signal,entered;const ready=new Promise(r=>entered=r),commands=[];
 const stop=await startNativeBackgroundLease({intervalMs:2,execute:(file,args,opts,cb)=>{commands.push([file,...args]);cb(null,'');},prepare:({signal:s})=>{calls++;signal=s;entered();return new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 await ready;await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);await stop();assert.equal(signal.aborted,true);await stop();await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(commands),/keyevent|stay_on|screen_brightness|keyguard/);
});
test('root denial is best effort and the timer can still be stopped',async()=>{
 let calls=0,ready;const entered=new Promise(r=>ready=r);
 const stop=await startNativeBackgroundLease({intervalMs:2,execute:(_f,_a,_o,cb)=>cb(Error('denied')),prepare:async()=>{calls++;ready();throw Error('denied');}});
 await entered;await stop();const count=calls;await new Promise(r=>setTimeout(r,10));assert.equal(calls,count);
});
