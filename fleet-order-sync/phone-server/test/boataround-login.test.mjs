import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedBoataroundLogin,recoverBoataroundSavedLogin,collectBoataroundWithSavedLogin,BOATAROUND_SAVED_ACCOUNT} from '../boataround-login.mjs';
import {BoataroundAdapter} from '../../reverse-sync/boataround-adapter.mjs';
const owner='owner@example.invalid',other='renter@example.invalid',hash=v=>createHash('sha256').update(v).digest('hex');
const node=(rid,attrs)=>`<node package="com.android.chrome" resource-id="${rid?'com.android.chrome:id/'+rid:''}" ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}/>`;
// Layout read from the phone on 2026-10-04: an owner row for
// partner.boataround.com and a second row saved for www.boataround.com.
function sheet({subtitle='您将登录 partner.boataround.com',first=owner,second=other,secondOrigin='www.boataround.com',pkg}={}){
 let xml='<hierarchy rotation="0">'+node('bottom_sheet',{clickable:'false',bounds:'[0,1279][1080,2392]'})+
  node('touch_to_fill_sheet_title',{text:'要使用已保存的密码吗？',bounds:'[177,1495][903,1651]'})+node('touch_to_fill_sheet_subtitle',{text:subtitle,bounds:'[217,1651][863,1715]'})+
  node('',{clickable:'true',enabled:'true','content-desc':'row 1',bounds:'[48,1760][1032,1981]'})+node('username',{text:first,bounds:'[264,1802][797,1875]'})+
  node('',{clickable:'true',enabled:'true','content-desc':'row 2',bounds:'[48,1987][1032,2272]'})+(secondOrigin?node('credential_origin',{text:secondOrigin,bounds:'[264,2029][684,2093]'}):'')+node('username',{text:second,bounds:'[264,2093][664,2166]'})+
  node('touch_to_fill_sheet_manage_passwords',{text:'管理密码',clickable:'true',bounds:'[48,2359][1032,2392]'})+'</hierarchy>';
 if(pkg)xml=xml.replaceAll('package="com.android.chrome"',`package="${pkg}"`);
 return xml;
}
const single=(name=owner)=>'<hierarchy>'+node('touch_to_fill_sheet_title',{text:'要使用已保存的密码吗？',bounds:'[0,0][10,10]'})+node('touch_to_fill_sheet_subtitle',{text:'partner.boataround.com',bounds:'[0,10][10,20]'})+
 node('username',{text:name,bounds:'[264,1802][797,1875]'})+node('touch_to_fill_button_title',{text:'登录',clickable:'true',enabled:'true',bounds:'[72,2134][1008,2278]'})+'</hierarchy>';

test('the owner row for partner.boataround.com is chosen, never the other site or a lookalike',()=>{
 assert.deepEqual(savedBoataroundLogin(sheet(),hash(owner)),{x:540,y:1870});
 assert.deepEqual(savedBoataroundLogin(sheet({subtitle:'partner.boataround.com'}),hash(owner)),{x:540,y:1870});
 for(const subtitle of ['您将登录 boataround.com','您将登录 partner.boataround.com.evil.test','www.boataround.com','http://partner.boataround.com'])assert.equal(savedBoataroundLogin(sheet({subtitle}),hash(owner)),null);
 // The owner account saved only for www.boataround.com is another site's entry.
 assert.equal(savedBoataroundLogin(sheet({first:other,second:owner}),hash(owner)),null);
 // Two owner rows without an origin line are ambiguous.
 assert.equal(savedBoataroundLogin(sheet({second:owner,secondOrigin:''}),hash(owner)),null);
 assert.equal(savedBoataroundLogin(sheet({pkg:'other.app'}),hash(owner)),null);
 assert.equal(savedBoataroundLogin(sheet().replace('</hierarchy>',''),hash(owner)),null);
 assert.equal(savedBoataroundLogin(sheet(),hash(other)),null);
 assert.deepEqual(savedBoataroundLogin(single(),hash(owner)),{x:540,y:2206});
 assert.equal(savedBoataroundLogin(single(other),hash(owner)),null);
 assert.match(BOATAROUND_SAVED_ACCOUNT,/^[0-9a-f]{64}$/);
});

const LOGIN='https://partner.boataround.com/en/login',ORDERS='https://partner.boataround.com/en/000000000000000000000000/orders';
function fixture({xml=sheet(),autoSubmit=true,fillOnTap=true,lock=false,secure=false,url=LOGIN,leaveOnSubmit=true,asleep=true}={}){
 const f={calls:[],url,awake:!asleep,sheetOpen:false,filled:false,submits:0};
 f.page={url:()=>f.url,waitForFunction:async()=>{},bringToFront:async()=>{f.calls.push('front');},
  click:async selector=>{f.calls.push('click '+selector);if(selector==='#email')f.sheetOpen=true;},
  evaluate:async fn=>{
   assert.equal(f.sheetOpen,false,'page JavaScript is not used while the native sheet is open');
   if(f.throwOnce){f.throwOnce=false;throw Error('Execution context was destroyed');}
   if(fn.name==='boataroundLoginForm')return f.url===LOGIN?{login:true,username:f.filled?owner:'',filled:f.filled,submit:true,busy:false}:{login:false};
   if(fn.name==='submitBoataroundLogin'){f.submits++;f.calls.push('submit');if(leaveOnSubmit)f.url=ORDERS;return true;}
   throw Error('unexpected evaluate '+fn.name);
  }};
 f.rootCommand=async command=>{
  f.calls.push(command);
  if(command==='dumpsys power')return f.awake?'mWakefulness=Awake':'mWakefulness=Asleep';
  if(command==='input keyevent 224')f.awake=true;
  if(command==='input keyevent 223')f.awake=false;
  if(command==='dumpsys window policy')return `  KeyguardServiceDelegate\n    showing=${lock}\n    secure=${secure}\n`;
  if(command.startsWith('cat '))return f.sheetOpen?xml:'<hierarchy rotation="0"></hierarchy>';
  if(command.startsWith('input tap ')){f.sheetOpen=false;if(fillOnTap)f.filled=true;if(autoSubmit)f.url=ORDERS;}
  return '';
 };
 return f;
}
const run=(f,options={})=>recoverBoataroundSavedLogin(f.page,{rootCommand:f.rootCommand,sleep:async()=>{},expectedAccount:hash(owner),...options});

test('expired session from a sleeping phone: one tap on the owner row, Chrome submits, sleep restored',async()=>{
 const f=fixture();await run(f);
 assert.deepEqual(f.calls.filter(c=>c.startsWith('input tap')),['input tap 540 1870']);
 assert.equal(f.submits,0);assert.ok(f.calls.includes('front'));assert.ok(f.calls.includes('click #email'));
 assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('a form Chrome filled but did not send is submitted exactly once',async()=>{
 const f=fixture({autoSubmit:false});await run(f);assert.equal(f.submits,1);assert.equal(f.url,ORDERS);
});
test('a sign-in that never leaves the login route fails after a single submit',async()=>{
 const f=fixture({autoSubmit:false,leaveOnSubmit:false});await assert.rejects(run(f),{code:'auth_required'});assert.equal(f.submits,1);
 assert.equal(f.calls.at(-1),'input keyevent 223');
});
test('a page navigating during the check is not mistaken for failure',async()=>{
 const f=fixture({autoSubmit:false});const tap=f.rootCommand;f.rootCommand=async c=>{const r=await tap(c);if(c.startsWith('input tap'))f.throwOnce=true;return r;};
 await run(f);assert.equal(f.submits,1);
});
test('only another account is saved: nothing is tapped or submitted',async()=>{
 const f=fixture({xml:sheet({first:other,second:'x@example.invalid'})});await assert.rejects(run(f),{code:'auth_required'});
 assert.ok(!f.calls.some(c=>c.startsWith('input tap')));assert.equal(f.submits,0);
});
test('a lock screen with a password is never unlocked',async()=>{
 const f=fixture({lock:true,secure:true});await assert.rejects(run(f),{code:'auth_required'});
 assert.ok(!f.calls.includes('wm dismiss-keyguard'));assert.ok(!f.calls.some(c=>c.startsWith('input tap')||c.startsWith('am start')));
});
test('a page outside partner.boataround.com is refused before any screen access',async()=>{
 const f=fixture({url:'https://evil.example/en/login'});await assert.rejects(run(f),{code:'auth_required'});
 assert.ok(f.calls.every(c=>c.startsWith('rm -f ')));
});
test('cancellation right after the tap cannot submit',async()=>{
 const controller=new AbortController(),f=fixture({autoSubmit:false});const tap=f.rootCommand;
 f.rootCommand=async c=>{const r=await tap(c);if(c.startsWith('input tap'))controller.abort();return r;};
 await assert.rejects(run(f,{signal:controller.signal}),{code:'auth_required'});assert.equal(f.submits,0);
});
test('an awake phone is left awake',async()=>{
 const f=fixture({asleep:false});await run(f);assert.ok(!f.calls.includes('input keyevent 223'));
});

test('collection: success needs no saved password; one recovery restarts a full collection',async()=>{
 const snapshot={complete:true};assert.equal(await collectBoataroundWithSavedLogin({}, {collect:async()=>snapshot,recover:async()=>assert.fail()}),snapshot);
 let collects=0,recovers=0;const context={page:{},deadlineAt:100000,reportDiagnostic:()=>{}};
 assert.equal(await collectBoataroundWithSavedLogin(context,{now:()=>0,collect:async c=>{assert.equal(c,context);if(++collects===1)throw Object.assign(Error(),{code:'auth_required'});return snapshot;},recover:async()=>{recovers++;}}),snapshot);
 assert.equal(collects,2);assert.equal(recovers,1);
});
test('collection: other faults, failed recovery, repeated expiry and short deadline never loop',async()=>{
 for(const code of ['schema_changed','incomplete_pages','fetch_failed','challenge_required','timeout'])
  await assert.rejects(collectBoataroundWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{throw Object.assign(Error(),{code});},recover:async()=>assert.fail()}),{code});
 let n=0;await assert.rejects(collectBoataroundWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{n++;throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>{throw Error('no_saved_account');}}),{code:'auth_required'});assert.equal(n,1);
 let r=0;n=0;await assert.rejects(collectBoataroundWithSavedLogin({deadlineAt:100000},{now:()=>0,collect:async()=>{n++;throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>{r++;}}),{code:'auth_required'});assert.equal(n,2);assert.equal(r,1);
 await assert.rejects(collectBoataroundWithSavedLogin({deadlineAt:100},{now:()=>0,collect:async()=>{throw Object.assign(Error(),{code:'auth_required'});},recover:async()=>assert.fail()}),{code:'auth_required'});
});

function adapterPage(routes){
 const page={visits:0,url:()=>page.current,on:()=>{},waitForFunction:async()=>{},goto:async()=>{page.current=routes[Math.min(page.visits++,routes.length-1)];}};
 return page;
}
test('calendar: an expired session is recovered once, then the calendar is opened again',async()=>{
 const page=adapterPage([LOGIN,'https://partner.boataround.com/en/000000000000000000000000/availability']);let recovered=0;
 const adapter=new BoataroundAdapter({openPage:async()=>page,closePage:async()=>{},recoverLogin:async p=>{assert.equal(p,page);recovered++;}});
 adapter.page=page;await adapter.openCalendar();assert.equal(recovered,1);assert.equal(page.visits,2);
});
test('calendar: no recovery, failed recovery or a second expiry ends as auth_required',async()=>{
 for(const recoverLogin of [null,async()=>{throw Object.assign(Error('x'),{code:'auth_required'});},async()=>{}]){
  const page=adapterPage([LOGIN]);const adapter=new BoataroundAdapter({openPage:async()=>page,closePage:async()=>{},recoverLogin});adapter.page=page;
  await assert.rejects(adapter.openCalendar(),{message:'auth_required'});assert.ok(page.visits<=2);
 }
});
