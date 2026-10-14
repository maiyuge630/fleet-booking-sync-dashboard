import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedSamBoatLoginButton,recoverSamBoatSavedLogin,collectSamBoatWithSavedLogin} from '../samboat-login.mjs';
const user='owner@example.invalid',hash=createHash('sha256').update(user).digest('hex');
const xml=(domain='www.samboat.com',name=user)=>`<hierarchy><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_sheet_title" text="Saved password"/><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_sheet_subtitle" text="${domain}"/><node package="com.android.chrome" resource-id="com.android.chrome:id/username" text="${name}"/><node package="com.android.chrome" resource-id="com.android.chrome:id/touch_to_fill_button_title" text="登录" clickable="true" enabled="true" bounds="[10,20][110,80]"/></hierarchy>`;
test('native recovery pins exact domain and single saved account, without password extraction',()=>{
 for(const domain of ['www.samboat.com','您将登录 www.samboat.com','https://www.samboat.com/'])assert.deepEqual(savedSamBoatLoginButton(xml(domain),hash),{x:60,y:50});
 for(const domain of ['samboat.com','www.samboat.com.evil.test','evilwww.samboat.com','http://www.samboat.com'])assert.equal(savedSamBoatLoginButton(xml(domain),hash),null);
 assert.equal(savedSamBoatLoginButton(xml(undefined,'another@example.invalid'),hash),null);
 assert.equal(savedSamBoatLoginButton(xml()+xml(),hash),null);
 assert.equal(savedSamBoatLoginButton(xml().replace('</hierarchy>',''),hash),null);
 assert.equal(savedSamBoatLoginButton(xml().replace('enabled="true"','enabled="false"'),hash),null);
 assert.equal(savedSamBoatLoginButton(xml().replace('[10,20][110,80]','[10,20][10,20]'),hash),null);
 assert.equal(savedSamBoatLoginButton(xml().replaceAll('package="com.android.chrome"','package="other.app"'),hash),null);
});
function fixture({sheet=xml(),filled=false,lock=false,secure=false}={}){
 const calls=[];let native=sheet.includes('touch_to_fill_sheet_title');
 const page={url:()=> 'https://www.samboat.com/',waitForFunction:async()=>{},bringToFront:async()=>calls.push('front'),click:async selector=>{calls.push(selector);},evaluate:async()=>{assert.equal(native,false,'native sheet must be consumed before DOM');return {login:true,username:user,filled};}};
 const rootCommand=async command=>{calls.push(command);if(command==='dumpsys power')return 'mWakefulness=Asleep';if(command==='dumpsys window policy')return `  KeyguardServiceDelegate\n    showing=${lock}\n    secure=${secure}\n`;if(command.startsWith('cat '))return sheet;if(command.startsWith('input tap ')){native=false;filled=true;}return '';};
 return {page,calls,rootCommand};
}
test('existing native sheet is verified and tapped once before page JavaScript',async()=>{
 const f=fixture();await recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash});
 assert.equal(f.calls.filter(c=>c==='input tap 60 50').length,1);assert.equal(f.calls.filter(c=>c==='#signin-submit').length,1);assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('autofilled form can submit without waking the screen',async()=>{
 const f=fixture({sheet:'<hierarchy></hierarchy>',filled:true});await recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash});
 assert.ok(f.calls.includes('#signin-submit'));assert.ok(!f.calls.includes('input keyevent 224'));
});
test('different native account is not tapped, selected or submitted',async()=>{
 const f=fixture({sheet:xml(undefined,'different@example.invalid')});await assert.rejects(recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});
 assert.ok(!f.calls.some(c=>c.startsWith('input tap')||c==='#signin-submit'));assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('secure lock fails closed and restores initial power',async()=>{
 const f=fixture({sheet:'<hierarchy></hierarchy>',lock:true,secure:true});await assert.rejects(recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});
 assert.ok(!f.calls.includes('wm dismiss-keyguard'));assert.ok(!f.calls.includes('front'));assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('failed accessibility reads retry only twice and never tap stale XML',async()=>{
 const f=fixture();let dumps=0;await assert.rejects(recoverSamBoatSavedLogin(f.page,{rootCommand:async c=>{if(c.startsWith('uiautomator dump')){dumps++;throw Error('transient');}return f.rootCommand(c);},sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});
 assert.equal(dumps,2);assert.ok(!f.calls.some(c=>c.startsWith('cat ')||c.startsWith('input tap')));
});
test('cancelled recovery never submits and deadline is checked before root access',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(recoverSamBoatSavedLogin(f.page,{signal:controller.signal,rootCommand:f.rootCommand,expectedAccount:hash}),{code:'auth_required'});
 assert.ok(f.calls.every(c=>c.startsWith('rm -f ')));
 const g=fixture();await assert.rejects(recoverSamBoatSavedLogin(g.page,{now:()=>100,deadlineAt:99,rootCommand:g.rootCommand,expectedAccount:hash}),{code:'auth_required'});assert.ok(g.calls.every(c=>c.startsWith('rm -f ')));
});
test('cancellation immediately after native tap cannot submit the form',async()=>{
 const f=fixture(),controller=new AbortController();await assert.rejects(recoverSamBoatSavedLogin(f.page,{signal:controller.signal,rootCommand:async c=>{const r=await f.rootCommand(c);if(c.startsWith('input tap'))controller.abort();return r;},sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});assert.ok(!f.calls.includes('#signin-submit'));
});
test('successful first collection never requests saved credentials',async()=>{
 const snapshot={complete:true};assert.equal(await collectSamBoatWithSavedLogin({}, {collect:async()=>snapshot,recover:async()=>assert.fail()}),snapshot);
});
test('one auth recovery starts a complete new collection and returns its verified snapshot',async()=>{
 let collects=0,recovers=0;const context={page:{},deadlineAt:100000,reportDiagnostic:()=>{}};
 const snapshot={complete:true};assert.equal(await collectSamBoatWithSavedLogin(context,{now:()=>0,collect:async c=>{assert.equal(c,context);if(++collects===1)throw Object.assign(Error(),{code:'auth_required'});return snapshot;},recover:async()=>{recovers++;}}),snapshot);assert.equal(collects,2);assert.equal(recovers,1);
});
test('schema, payment, pagination and network faults never trigger password submission',async()=>{
 for(const code of ['schema_changed','incomplete_pages','fetch_failed'])await assert.rejects(collectSamBoatWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{throw Object.assign(Error(),{code});},recover:async()=>assert.fail()}),{code});
});
test('failed recovery or repeated login expiry preserves failure and cannot loop',async()=>{
 let n=0;await assert.rejects(collectSamBoatWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{n++;throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>{throw Error('no_saved_account');}}),{code:'auth_required'});assert.equal(n,1);
 let r=0;n=0;await assert.rejects(collectSamBoatWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{n++;throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>{r++;}}),{code:'auth_required'});assert.equal(n,2);assert.equal(r,1);
});
test('too little deadline or already cancelled collection cannot recover login',async()=>{
 const controller=new AbortController();controller.abort();for(const context of [{deadlineAt:100},{deadlineAt:100000,signal:controller.signal}])await assert.rejects(collectSamBoatWithSavedLogin(context,{now:()=>0,collect:async()=>{throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>assert.fail()}),{code:'auth_required'});
});
test('diagnostic storage failure cannot prevent verified authentication recovery',async()=>{
 let n=0;const snapshot={complete:true};assert.equal(await collectSamBoatWithSavedLogin({deadlineAt:100000,reportDiagnostic:()=>{throw Error('diagnostic_failed');}},{now:()=>0,collect:async()=>{if(++n===1)throw Object.assign(Error(),{code:'auth_required'});return snapshot;},recover:async()=>{}}),snapshot);
});
test('an already submitting login is awaited without a duplicate submit',async()=>{
 const f=fixture({sheet:'<hierarchy></hierarchy>',filled:true});let waits=0;f.page.evaluate=async()=>({login:true,username:user,filled:true,busy:true});f.page.waitForFunction=async()=>{waits++;};
 await recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash});assert.ok(waits>=1);assert.ok(!f.calls.includes('#signin-submit'));
});
test('failed native autofill is not mistaken for a recovered session',async()=>{
 const f=fixture();f.page.evaluate=async()=>({login:true,username:'',filled:false});await assert.rejects(recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});assert.ok(!f.calls.includes('#signin-submit'));
});
test('a login form that never closes fails without repeated submissions',async()=>{
 const f=fixture({sheet:'<hierarchy></hierarchy>',filled:true});let n=0;f.page.waitForFunction=async()=>{if(++n>1)throw Error('timeout');};
 await assert.rejects(recoverSamBoatSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash}),{code:'auth_required'});assert.equal(f.calls.filter(c=>c==='#signin-submit').length,1);
});
