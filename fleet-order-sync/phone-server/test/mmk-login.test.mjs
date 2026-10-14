import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {savedMmkLoginButton,recoverMmkSavedLogin,recoverMmkSavedLoginWithRetry,mmkKeyguardState,mmkAutofillReady,mmkLoginFinished} from '../mmk-login.mjs';
const policy=(showing=false,secure=false)=>`  KeyguardServiceDelegate\n    showing=${showing}\n    secure=${secure}\n`;
const empty='<hierarchy rotation="0"></hierarchy>';
const xml=(domain='portal.booking-manager.com',user='DemoUser',label='登录')=>`<hierarchy rotation="0"><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_sheet_title" text="要使用已保存的密码吗？"/><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_sheet_subtitle" text="${domain}"/><node package="com.android.chrome" resource-id="com.android.chrome:id/username" text="${user}"/><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_button_title" text="${label}" clickable="true" enabled="true" bounds="[10,20][110,80]"/></hierarchy>`;
function fixture({filled=false,initialSheet=false,prompt=xml(),trigger='login_email',nativeSubmits=false,asleep=true,lock=policy(),rejectLogin=false,alreadyLoggedIn=false}={}){
 const calls=[];let sheet=initialSheet,url=alreadyLoggedIn?'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp':'https://portal.booking-manager.com/wbm2/app/login_register/',pendingFill=false,expectedUser=filled;
 const page={url:()=>url,bringToFront:async()=>{calls.push('front');},
  evaluate:async fn=>{assert.equal(sheet,false,'native password sheet suspends DOM execution');assert.equal(pendingFill,false,'wait for Fill to finish before examining fields');if(fn===mmkLoginFinished)return !url.includes('/login_register/');return {login:url.includes('/login_register/'),expectedUser,filled};},
  waitForFunction:async()=>{calls.push('wait');if(pendingFill){pendingFill=false;filled=true;expectedUser=true;}if(rejectLogin&&calls.includes('input[type="submit"]'))throw Error('login_navigation_timeout');},
  click:async selector=>{calls.push(selector);if(selector===`input[name="${trigger}"]`)sheet=true;if(selector==='input[type="submit"]'&&!rejectLogin)url='https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp';}};
 const rootCommand=async command=>{calls.push(command);if(command==='dumpsys power')return asleep?'mWakefulness=Asleep':'mWakefulness=Awake';if(command==='dumpsys window policy')return lock;if(command==='wm dismiss-keyguard')lock=policy(false,false);if(command.startsWith('cat '))return sheet?prompt:empty;if(command.startsWith('input tap ')){sheet=false;if(nativeSubmits)url='https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp';else pendingFill=true;}return '';};
 return {page,calls,rootCommand,run:opts=>recoverMmkSavedLogin(page,{rootCommand,sleep:async()=>{},...opts})};
}
test('only one exact MMK domain, Chrome package and expected account allow a native Fill/Login action',()=>{
 for(const label of ['登录','Sign in','填充','Fill in','Fill'])assert.deepEqual(savedMmkLoginButton(xml(undefined,undefined,label)),{x:60,y:50});
 assert.deepEqual(savedMmkLoginButton(xml('您将登录 portal.booking-manager.com')),{x:60,y:50});
 for(const d of ['portal.booking-manager.com.evil.test','other.com','evilportal.booking-manager.com'])assert.equal(savedMmkLoginButton(xml(d)),null);
 for(const bad of [xml(undefined,'other'),xml().replaceAll('package="com.android.chrome"','package="other.app"'),xml().replace('enabled="true"','enabled="false"'),xml().replace('[10,20][110,80]','[110,80][10,20]'),xml().replace('[10,20][110,80]','[10,20][99999999,80]'),xml().replace('</hierarchy>',''),xml()+xml(),xml().replace('</hierarchy>','<node package="com.android.chrome" resource-id="com.android.chrome:id/username" text="DemoUser"/></hierarchy>')])assert.equal(savedMmkLoginButton(bad),null);
});
test('already filled expected account submits once without waking the display',async()=>{
 const f=fixture({filled:true});await f.run();assert.equal(f.calls.filter(c=>c==='input[type="submit"]').length,1);assert.ok(!f.calls.includes('input keyevent 224'));assert.ok(!f.calls.some(c=>c.startsWith('input tap')));
});
test('an already open native prompt is read before any suspended DOM and needs no repeat focus',async()=>{
 const f=fixture({initialSheet:true});await f.run();assert.equal(f.calls.filter(c=>c==='input tap 60 50').length,1);assert.equal(f.calls.filter(c=>c==='input[type="submit"]').length,1);assert.ok(!f.calls.includes('input[name="login_email"]'));assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('real username-triggered AutoFill waits for both fields then clicks webpage Login once',async()=>{
 const f=fixture({prompt:xml('您将登录 portal.booking-manager.com','DemoUser','Fill in')});await f.run();
 assert.ok(f.calls.includes('input[name="login_email"]'));assert.ok(!f.calls.includes('input[name="login_password"]'));
 const tap=f.calls.indexOf('input tap 60 50'),submit=f.calls.indexOf('input[type="submit"]');assert.ok(f.calls.slice(tap+1,submit).includes('wait'));
 assert.equal(f.calls.filter(c=>c==='input tap 60 50').length,1);assert.equal(f.calls.filter(c=>c==='input[type="submit"]').length,1);
});
test('password-field fallback remains available when username has no prompt',async()=>{
 const f=fixture({trigger:'login_password'});await f.run();assert.ok(f.calls.indexOf('input[name="login_email"]')<f.calls.indexOf('input[name="login_password"]'));assert.equal(f.calls.filter(c=>c.startsWith('input tap')).length,1);
});
test('native Sign in may submit itself; do not submit again',async()=>{
 const f=fixture({initialSheet:true,nativeSubmits:true,asleep:false});await f.run();assert.ok(!f.calls.includes('input[type="submit"]'));assert.ok(!f.calls.includes('input keyevent 223'));
});
test('wrong account or domain prompt is never tapped or probed through suspended DOM',async()=>{
 for(const prompt of [xml(undefined,'other'),xml('portal.booking-manager.com.evil.example')]){
  const f=fixture({initialSheet:true,prompt});await assert.rejects(f.run(),/mmk_auth_required/);assert.ok(!f.calls.some(c=>c.startsWith('input tap')));assert.ok(!f.calls.includes('input[name="login_email"]'));assert.equal(f.calls.at(-1),'input keyevent 223');
 }
});
test('secure or unknown keyguard blocks native login; normal swipe lock is dismissed',async()=>{
 assert.deepEqual(mmkKeyguardState(policy(true,false)),{showing:true,secure:false});
 for(const lock of [policy(true,true),'unrecognized']){const f=fixture({lock});await assert.rejects(f.run(),/mmk_auth_required/);assert.ok(!f.calls.includes('wm dismiss-keyguard'));assert.ok(!f.calls.some(c=>c.startsWith('input tap')));}
 const f=fixture({lock:policy(true,false)});await f.run();assert.ok(f.calls.includes('wm dismiss-keyguard'));
 const nativeLocked=fixture({initialSheet:true,lock:policy(true,true)});await assert.rejects(nativeLocked.run(),/mmk_auth_required/);assert.ok(!nativeLocked.calls.some(c=>c.startsWith('input tap')));
});
test('cancellation before work or after Fill prevents Login and cleans up',async()=>{
 const early=fixture();await assert.rejects(early.run({isCancelled:()=>true}),/phone_shutdown/);assert.deepEqual(early.calls,[]);
 const f=fixture({initialSheet:true});let closed=false;
 await assert.rejects(f.run({isCancelled:()=>closed,rootCommand:async command=>{const result=await f.rootCommand(command);if(command.startsWith('input tap'))closed=true;return result;}}),/phone_shutdown/);
 assert.ok(!f.calls.includes('input[type="submit"]'));assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('shutdown during lock inspection never dismisses or foregrounds Chrome',async()=>{
 const f=fixture();let closed=false;
 await assert.rejects(f.run({isCancelled:()=>closed,rootCommand:async command=>{if(command==='dumpsys window policy'){closed=true;return policy(true,false);}return f.rootCommand(command);}}),/phone_shutdown/);
 assert.ok(!f.calls.includes('wm dismiss-keyguard'));assert.ok(!f.calls.some(c=>c.startsWith('am start')));
});
test('transient native UI read failures retry only the fresh read before one Login',async()=>{
 for(const fault of [Error('idle failed'),Object.assign(Error('timed out'),{code:'ETIMEDOUT'})]){
  const f=fixture({initialSheet:true});let dumps=0,cats=0;
  await f.run({rootCommand:async command=>{if(command.startsWith('uiautomator dump ')&&++dumps===1)throw fault;if(command.startsWith('cat '))cats++;return f.rootCommand(command);}});
  assert.equal(dumps,2);assert.equal(cats,1);assert.equal(f.calls.filter(c=>c.startsWith('input tap')).length,1);
 }
});
test('persistent/incomplete native snapshots never use stale coordinates',async()=>{
 for(const incomplete of [false,true]){
  const f=fixture({initialSheet:true});let reads=0;
  await assert.rejects(f.run({rootCommand:async command=>{if(command.startsWith('uiautomator dump ')){reads++;if(!incomplete)throw Error('unavailable');}if(command.startsWith('cat '))return xml().replace('</hierarchy>','');return f.rootCommand(command);}}),/mmk_native_ui_unavailable/);
  assert.equal(reads,2);assert.ok(!f.calls.some(c=>c.startsWith('input tap')));assert.equal(f.calls.at(-1),'input keyevent 223');
 }
});
test('bad account after a retried snapshot is still rejected',async()=>{
 const f=fixture({initialSheet:true,prompt:xml(undefined,'other')});let dumps=0;
 await assert.rejects(f.run({rootCommand:async command=>{if(command.startsWith('uiautomator dump ')&&++dumps===1)throw Error('busy');return f.rootCommand(command);}}),/mmk_auth_required/);assert.equal(dumps,2);assert.ok(!f.calls.some(c=>c.startsWith('input tap')));
});
test('failed Login navigation is not retried and an absent saved prompt remains a clear failure',async()=>{
 const f=fixture({filled:true,rejectLogin:true});await assert.rejects(f.run(),/login_navigation_timeout/);assert.equal(f.calls.filter(c=>c==='input[type="submit"]').length,1);
 const absent=fixture({trigger:'none'});await assert.rejects(absent.run(),e=>e.message==='mmk_auth_required'&&e.retryWithoutLoginAction===true);assert.ok(!absent.calls.includes('input[type="submit"]'));assert.ok(!absent.calls.some(c=>c.startsWith('input tap')));
});
test('already completed asynchronous login is left to the caller for owner verification',async()=>{
 const f=fixture({alreadyLoggedIn:true});await f.run();
 assert.ok(!f.calls.includes('input[type="submit"]'));
 assert.ok(!f.calls.some(c=>c.startsWith('input tap')));
 const raced=fixture({alreadyLoggedIn:true});
 raced.page.evaluate=async fn=>{if(fn===mmkLoginFinished)throw Error('Execution context was destroyed');return {login:false};};
 await raced.run();
 assert.ok(!raced.calls.includes('input[type="submit"]'));
 assert.ok(!raced.calls.some(c=>c.startsWith('input tap')));
});
test('one bounded retry is allowed only when no saved account or Login was clicked',async()=>{
 const calls=[];let now=1000;
 const recover=async(_page,options)=>{calls.push(options.deadlineAt);if(calls.length===1)throw Object.assign(Error('mmk_auth_required'),{retryWithoutLoginAction:true});};
 await recoverMmkSavedLoginWithRetry({}, {recover,now:()=>now,sleep:async ms=>{assert.equal(ms,750);now+=ms;}});
 assert.deepEqual(calls,[76000,76000]);
 let nativeCalls=0;
 await recoverMmkSavedLoginWithRetry({}, {recover:async()=>{if(++nativeCalls===1)throw Error('mmk_native_ui_unavailable');},now:()=>1000,sleep:async()=>{}});
 assert.equal(nativeCalls,2);
 for(const failure of [Error('mmk_auth_required'),Error('phone_shutdown'),Error('login_navigation_timeout'),Error('wrong_account')]){
  let attempts=0;
  await assert.rejects(recoverMmkSavedLoginWithRetry({}, {recover:async()=>{attempts++;throw failure;},now:()=>1000,sleep:async()=>{}}),e=>e===failure);
  assert.equal(attempts,1);
 }
 let attempts=0;
 await assert.rejects(recoverMmkSavedLoginWithRetry({}, {recover:async()=>{attempts++;throw Object.assign(Error('mmk_auth_required'),{retryWithoutLoginAction:true});},now:()=>1000,sleep:async()=>{}}),/mmk_auth_required/);
 assert.equal(attempts,2);
});
test('real saved-account and web Login actions are never replayed after their outcome is uncertain',async()=>{
 const web=fixture({filled:true,rejectLogin:true});
 await assert.rejects(recoverMmkSavedLoginWithRetry(web.page,{rootCommand:web.rootCommand,sleep:async()=>{}}),/login_navigation_timeout/);
 assert.equal(web.calls.filter(c=>c==='input[type="submit"]').length,1);
 assert.equal(web.calls.filter(c=>c.startsWith('input tap')).length,0);
 const native=fixture({initialSheet:true});
 native.page.waitForFunction=async()=>{throw Error('autofill_timeout');};
 await assert.rejects(recoverMmkSavedLoginWithRetry(native.page,{rootCommand:native.rootCommand,sleep:async()=>{}}),/autofill_timeout/);
 assert.equal(native.calls.filter(c=>c.startsWith('input tap')).length,1);
 assert.equal(native.calls.filter(c=>c==='input[type="submit"]').length,0);
});
test('retry preserves the original deadline and stops when under thirty seconds remain',async()=>{
 let attempts=0,now=1000;
 await assert.rejects(recoverMmkSavedLoginWithRetry({}, {recover:async()=>{attempts++;now=47001;throw Error('mmk_native_ui_unavailable');},now:()=>now,sleep:async()=>{}}),/mmk_native_ui_unavailable/);
 assert.equal(attempts,1);
 let cancelled=false;
 await assert.rejects(recoverMmkSavedLoginWithRetry({}, {recover:async()=>{throw Error('mmk_native_ui_unavailable');},isCancelled:()=>cancelled,now:()=>1000,sleep:async()=>{cancelled=true;}}),/phone_shutdown/);
});
test('untrusted page and expired overall deadline cannot send any password action',async()=>{
 const f=fixture();f.page.url=()=> 'https://evil.example/wbm2/app/login_register/';await assert.rejects(f.run(),/mmk_auth_required/);assert.ok(!f.calls.some(c=>c.startsWith('input tap')));
 const expired=fixture();await assert.rejects(expired.run({now:()=>100,deadlineAt:100}),/mmk_auth_required/);assert.deepEqual(expired.calls,[]);
});
test('after-native navigation context race returns to the caller for fresh account verification',async()=>{
 const f=fixture({initialSheet:true,nativeSubmits:true});f.page.evaluate=async()=>{throw Error('execution context destroyed');};await f.run();assert.ok(!f.calls.includes('input[type="submit"]'));
});
test('MMK authenticated home at unchanged login URL is complete, an empty/loading login page is not',()=>{
 const run=(fn,{home=false,password=null,username=null,origin='https://portal.booking-manager.com',pathname='/wbm2/app/login_register/'}={})=>vm.runInNewContext('('+fn.toString()+')()', {location:{origin,pathname},document:{querySelector:s=>s.includes('login_password')?password:s.includes('login_email')?username:s==='#bm-homepage-card-link-my-bookings'&&home?{}:null}});
 for(const fn of [mmkAutofillReady,mmkLoginFinished]){assert.equal(run(fn,{home:true}),true);assert.equal(run(fn),false);assert.equal(run(fn,{home:true,origin:'https://evil.example'}),false);}
 assert.equal(run(mmkAutofillReady,{password:{value:'opaque'},username:{value:'DemoUser'}}),true);
 assert.equal(run(mmkLoginFinished,{password:{value:'opaque'},username:{value:'DemoUser'}}),false);
 assert.equal(run(mmkAutofillReady,{password:{value:''},username:{value:'DemoUser'}}),false);
});
test('cancellation after reading filled fields or during native dump prevents Login and read retry',async()=>{
 const f=fixture({filled:true});let closed=false;f.page.evaluate=async()=>{closed=true;return {login:true,expectedUser:true,filled:true};};
 await assert.rejects(f.run({isCancelled:()=>closed}),/phone_shutdown/);assert.ok(!f.calls.includes('input[type="submit"]'));
 const g=fixture();let stopped=false,reads=0;
 await assert.rejects(g.run({isCancelled:()=>stopped,rootCommand:async command=>{if(command.startsWith('uiautomator dump')){stopped=true;reads++;throw Error('failed');}return g.rootCommand(command);}}),/phone_shutdown/);assert.equal(reads,1);assert.ok(!g.calls.some(c=>c.startsWith('input tap')));
});
test('a filled unexpected account must not be submitted',async()=>{
 const f=fixture({initialSheet:true});f.page.evaluate=async()=>({login:true,expectedUser:false,filled:true});
 await assert.rejects(f.run(),/mmk_auth_required/);assert.ok(!f.calls.includes('input[type="submit"]'));
});
