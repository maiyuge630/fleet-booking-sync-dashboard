import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareChromeBackground} from './native-chrome-bridge.mjs';
test('root background preparation touches only real Chrome process ids and never wakes display',async()=>{
 const calls=[];const result=await prepareChromeBackground({execute:(exe,args,opts,done)=>{calls.push(args[1]);assert.equal(exe,'su');assert.equal(opts.shell,false);done(null,args[1].startsWith('ps ')?'PID NAME\n123 com.android.chrome\n124 com.android.chrome:sandboxed_process0\n125 com.android.chrome_zygote\n126 other.app\n127;bad com.android.chrome':args[1].startsWith('cat /proc/')?'Uid: 10354 10354 10354 10354':'');}});
 assert.ok(calls.includes('cmd activity unfreeze --sticky 123'));assert.ok(calls.includes('cmd activity unfreeze --sticky 124'));assert.equal(calls.filter(c=>c.includes('echo 0 > /sys/fs/cgroup/apps/uid_10354/cgroup.freeze')).length,1);assert.ok(!calls.some(c=>c.includes('125')||c.includes('126')||c.includes('keyevent')));assert.equal(result.unfrozen,2);
});
test('missing root is an optional optimization, not fatal and never attempts wake',async()=>{
 const r=await prepareChromeBackground({execute:(_e,_a,_o,done)=>done(Error('denied'))});assert.deepEqual(r,{rootAvailable:false,unfrozen:0});
});
test('aborted background preparation performs no commands',async()=>{
 const c=new AbortController();c.abort();let calls=0;await assert.rejects(prepareChromeBackground({signal:c.signal,execute:()=>calls++}));assert.equal(calls,0);
});
