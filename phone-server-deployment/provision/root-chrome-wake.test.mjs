import test from 'node:test';
import assert from 'node:assert/strict';
import {tryRootChromeWake} from './native-chrome-bridge.mjs';
const policy=(showing=false,secure=false,interactive='INTERACTIVE_STATE_AWAKE')=>`KeyguardServiceDelegate\n  showing=${showing}\n  secure=${secure}\n  interactiveState=${interactive}\n`;
const localTargets=[{type:'page',id:'172'},{type:'service_worker',id:'02E736934D5DEDBF158B1A65E95E80AE'}];
function fixture({root=true,serial='YOUR_DEVICE_SERIAL',states=[policy()],nativeId='local-chrome',tcpId='local-chrome',failCommand=null,signal,onCommand=()=>{},fetchFailure=false,bare=false,targets=localTargets,tcpTargets=targets,afterTargets=targets,onTcp=()=>{}}={}){
 const commands=[],requests=[];let stateIndex=0,clock=0,targetReads=0;
 const execute=(file,args,options,callback)=>{
  assert.equal(file,'su');assert.equal(args[0],'-c');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  assert.ok(options.timeout>0&&options.timeout<=10000);assert.equal(options.maxBuffer,65536);
  const command=args[1];commands.push(command);onCommand(command);
  if(command===failCommand)return callback(Error('denied'));
  if(command==='id -u')return callback(null,root?'0':'10345');
  if(command==='getprop ro.serialno')return callback(null,serial);
  if(command==='dumpsys window policy')return callback(null,states[Math.min(stateIndex++,states.length-1)]);
  if(command==='input keyevent KEYCODE_WAKEUP'||command==='wm dismiss-keyguard')return callback(null,'');
  if(command==='am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome')return callback(null,'Status: ok');
  const prefix="/data/data/com.termux/files/usr/bin/curl --noproxy '*' --abstract-unix-socket chrome_devtools_remote --max-time 5 --silent --show-error";
  if(command===prefix+' http://localhost/json/list'){
   return callback(null,JSON.stringify(++targetReads===1?targets:afterTargets));
  }
  assert.equal(command,prefix+' http://localhost/json/version');
  return callback(null,JSON.stringify({webSocketDebuggerUrl:`ws://localhost/devtools/browser${bare?'':'/'+nativeId}`}));
 };
 const fetchImpl=async(url,options)=>{
  requests.push(url);assert.ok(['http://127.0.0.1:9222/json/version','http://127.0.0.1:9222/json/list'].includes(url));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);
  if(fetchFailure)throw Error('offline');
  if(url.endsWith('/json/list')){
   onTcp();return new Response(JSON.stringify(tcpTargets),{headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:9222/devtools/browser${bare?'':'/'+tcpId}`}),{headers:{'content-type':'application/json'}});
 };
 return {commands,requests,run:()=>tryRootChromeWake({execute,fetchImpl,signal,restoreRelay:async()=>false,now:()=>clock,sleep:async()=>{clock+=5001;}})};
}
test('Root wake reuses only a matching local Chrome endpoint without any ADB or port mutation',async()=>{
 const f=fixture();assert.equal(await f.run(),true);assert.equal(f.requests.length,2);
 assert.ok(f.commands.includes('input keyevent KEYCODE_WAKEUP'));
 assert.ok(f.commands.every(command=>!/(?:adb|forward|tcpip|settings |locksettings|screen_brightness|keyevent (?:26|223))/.test(command)));
});
test('unavailable Root falls back without changing screen or connecting CDP',async()=>{
 for(const options of [{root:false},{failCommand:'id -u'}]){const f=fixture(options);assert.equal(await f.run(),false);assert.deepEqual(f.commands,['id -u']);assert.equal(f.requests.length,0);}
});
test('wrong local phone identity is terminal before wake',async()=>{
 const f=fixture({serial:'another-phone'});await assert.rejects(f.run(),{code:'DEVICE_MISMATCH'});assert.deepEqual(f.commands,['id -u','getprop ro.serialno']);
});
test('secure or unparseable keyguard is terminal and never permits fallback wake',async()=>{
 for(const [state,code] of [[policy(true,true),'SCREEN_LOCKED'],['unknown','SCREEN_STATE_UNAVAILABLE']]){
  const f=fixture({states:[state]});await assert.rejects(f.run(),{code});assert.ok(!f.commands.some(c=>c.startsWith('input ')||c.startsWith('wm ')||c.startsWith('am ')));assert.equal(f.requests.length,0);
 }
});
test('normal swipe unlock must be read back as unlocked and awake',async()=>{
 const f=fixture({states:[policy(true,false,'INTERACTIVE_STATE_SLEEP'),policy(true),policy()]});assert.equal(await f.run(),true);assert.ok(f.commands.includes('wm dismiss-keyguard'));
 const stuck=fixture({states:[policy(true)]});await assert.rejects(stuck.run(),{code:'SCREEN_LOCKED'});assert.equal(stuck.requests.length,0);
});
test('secure lock appearing after wake is terminal before dismiss or launch',async()=>{
 const f=fixture({states:[policy(),policy(true,true)]});await assert.rejects(f.run(),{code:'SCREEN_LOCKED'});assert.ok(!f.commands.includes('wm dismiss-keyguard'));assert.equal(f.requests.length,0);
});
test('already cancelled root wake executes nothing',async()=>{
 const c=new AbortController();c.abort();const f=fixture({signal:c.signal});await assert.rejects(f.run(),{code:'ABORTED'});assert.equal(f.commands.length,0);
});
test('cancellation at a command boundary cannot launch another root operation',async()=>{
 const c=new AbortController(),f=fixture({signal:c.signal,onCommand:command=>{if(command==='input keyevent KEYCODE_WAKEUP')c.abort();}});
 await assert.rejects(f.run(),{code:'ABORTED'});assert.equal(f.commands.at(-1),'input keyevent KEYCODE_WAKEUP');assert.equal(f.requests.length,0);
});
test('existing loopback endpoint for another Chrome instance is never accepted or replaced',async()=>{
 const f=fixture({tcpId:'some-other-chrome'});await assert.rejects(f.run(),{code:'FORWARD_CONFLICT'});assert.ok(!f.commands.some(c=>c.includes('forward')));
});
test('local Chrome identity unreadable or local CDP offline can use original ADB fallback',async()=>{
 const unreadable=fixture({nativeId:'not/an/id'});assert.equal(await unreadable.run(),false);assert.equal(unreadable.requests.length,0);
 const offline=fixture({fetchFailure:true});assert.equal(await offline.run(),false);assert.ok(offline.requests.length>0);
});
test('bare Android browser reuses only a full unchanged Root-TCP-Root set with strong existing identity',async()=>{
 const f=fixture({bare:true});assert.equal(await f.run(),true);
 assert.ok(f.requests.includes('http://127.0.0.1:9222/json/list'));
 assert.equal(f.commands.filter(c=>c.endsWith('/json/list')).length,2);
 assert.ok([...f.commands,...f.requests].every(value=>!value.includes('/new')&&!value.includes('/close')&&!value.includes('PUT')));
});
test('empty, plain numeric and malformed local identity sets cannot authorize Root reuse',async()=>{
 for(const targets of [[],[{id:'172',type:'page'}],[{id:'12345678901234567890123456789012',type:'page'}],[...localTargets,localTargets[0]],[{id:'unsafe/id',type:'page'}],{data:localTargets}]){
  const f=fixture({bare:true,targets});assert.equal(await f.run(),false);assert.ok(!f.requests.some(url=>url.endsWith('/json/list')));
 }
});
test('unchanged UUID identity and reordered target rows are accepted without page mutation',async()=>{
 const targets=[{id:'f64787f8-91c3-4ad5-9066-5a4f580e8dbe',type:'service_worker'},{id:'1',type:'page'}];
 const f=fixture({bare:true,targets,tcpTargets:[...targets].reverse(),afterTargets:[...targets].reverse()});assert.equal(await f.run(),true);
});
test('same numeric page IDs cannot mask a different browser worker identity',async()=>{
 const f=fixture({bare:true,tcpTargets:[localTargets[0],{type:'service_worker',id:'ADD08806C442C4ABD044D7016086B52B22'}]});await assert.rejects(f.run(),{code:'FORWARD_CONFLICT'});
});
test('entire target identity must agree, not merely one shared worker',async()=>{
 for(const tcpTargets of [[localTargets[1]],[{id:'173',type:'page'},localTargets[1]],[{...localTargets[0],type:'worker'},localTargets[1]]]){
  const f=fixture({bare:true,tcpTargets});await assert.rejects(f.run(),{code:'FORWARD_CONFLICT'});
 }
});
test('changing local target set between reads fails safely even if the first TCP set matched',async()=>{
 for(const afterTargets of [[],[localTargets[1]],[...localTargets,{id:'2',type:'page'}],[localTargets[0],{id:'ABC08806C442C4ABD044D7016086B52B22',type:'service_worker'}]]){
  const f=fixture({bare:true,afterTargets});assert.equal(await f.run(),false);
 }
});
test('cancellation during identity comparison starts no further Root command',async()=>{
 const controller=new AbortController(),f=fixture({bare:true,signal:controller.signal,onTcp:()=>controller.abort()});
 await assert.rejects(f.run(),{code:'ABORTED'});
 assert.equal(f.commands.filter(c=>c.endsWith('/json/list')).length,1);
});
