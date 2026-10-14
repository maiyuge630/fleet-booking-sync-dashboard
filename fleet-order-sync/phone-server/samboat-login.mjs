import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mmkKeyguardState} from './mmk-login.mjs';
import {collectSamBoat} from '../collectors/samboat.mjs';
const exec=promisify(execFile);
// Hash of the single saved username verified on this owner's Android Chrome.
// Passwords and session tokens remain in Chrome and are never read or copied.
export const SAMBOAT_SAVED_ACCOUNT='1111111111111111111111111111111111111111111111111111111111111111';
const accountHash=value=>createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
const auth=()=>Object.assign(Error('SamBoat saved login requires attention'),{code:'auth_required'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function savedSamBoatLoginButton(xml,expected=SAMBOAT_SAVED_ACCOUNT){
 if(!/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/.test(String(xml).trim()))return null;
 const nodes=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
 const domains=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/touch_to_fill_sheet_subtitle');
 const users=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/username');
 const buttons=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/touch_to_fill_button_title'&&n.clickable==='true'&&n.enabled!=='false'&&['登录','Sign in'].includes(n.text));
 if(domains.length!==1||! /^(?:您将登录 |https:\/\/)?www\.samboat\.com\/?$/.test(domains[0].text)||users.length!==1||accountHash(users[0].text||'')!==expected||buttons.length!==1)return null;
 if([...domains,...users,...buttons].some(n=>n.package!=='com.android.chrome'))return null;
 const bounds=buttons[0].bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
 if(!bounds||bounds.some(n=>!Number.isSafeInteger(n)||n>10000)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])return null;
 return {x:Math.floor((bounds[0]+bounds[2])/2),y:Math.floor((bounds[1]+bounds[3])/2)};
}
export function samBoatLoginForm(){
 if(location.origin!=='https://www.samboat.com')return {login:false};
 const form=document.querySelector('#sign-in-form'),email=form?.querySelector('#signin-email[type=email]'),password=form?.querySelector('#signin-password[type=password]');
 if(!form||new URL(form.action,location.href).href!=='https://www.samboat.com/login/signin'||!email||!password||!form.getBoundingClientRect().height)return {login:false};
 return {login:true,username:email.value,filled:!!password.value,busy:form.querySelector('#signin-submit')?.disabled===true};
}
export async function recoverSamBoatSavedLogin(page,{signal,deadlineAt=Date.now()+75000,now=Date.now,rootCommand,sleep=pause,expectedAccount=SAMBOAT_SAVED_ACCOUNT}={}){
 const active=()=>{if(signal?.aborted||now()>=deadlineAt)throw auth();};
 const trusted=()=>{active();const u=new URL(page.url());if(u.origin!=='https://www.samboat.com'||u.username||u.password)throw auth();};
 const root=rootCommand|| (async command=>{active();return(await exec('su',['-c',command],{timeout:Math.max(1,Math.min(12000,deadlineAt-now())),maxBuffer:1024*1024,signal})).stdout;});
 const file='/data/local/tmp/fleet-samboat-saved-login-'+process.pid+'.xml';
 let wasAsleep=false,powerKnown=false;
 const readSheet=async()=>{
  for(let attempt=0;attempt<2;attempt++){
   try{active();await root('rm -f '+file);active();await root('uiautomator dump '+file);active();const xml=String(await root('cat '+file)).trim();active();if(!/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/.test(xml))throw auth();return xml;}
   catch{active();if(attempt)throw auth();await sleep(400);}
  }
 };
 const useSheet=async xml=>{
  const button=savedSamBoatLoginButton(xml,expectedAccount);
  if(!button){if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();return false;}
  trusted();await root(`input tap ${button.x} ${button.y}`);await sleep(1700);active();return true;
 };
 const waitLoginClosed=async()=>{
  trusted();await page.waitForFunction(()=>!document.querySelector('#sign-in-form')?.getBoundingClientRect().height,{polling:250,timeout:Math.max(1,Math.min(15000,deadlineAt-now()))});active();
 };
 const submitFilled=async({afterNative=false}={})=>{
  if(afterNative){
   // Native fill/sign-in is asynchronous. Do not navigate away while Chrome
   // is still populating the form or while the website is submitting it.
   trusted();await page.waitForFunction(()=>{const f=document.querySelector('#sign-in-form');return !f?.getBoundingClientRect().height||!!f.querySelector('#signin-email')?.value&&!!f.querySelector('#signin-password')?.value;},{polling:250,timeout:Math.max(1,Math.min(10000,deadlineAt-now()))});active();
  }
  trusted();const form=await page.evaluate(samBoatLoginForm);active();
  if(!form.login)return true; // Caller re-reads the entire authenticated list.
  if(form.filled&&accountHash(form.username||'')===expectedAccount){trusted();if(!form.busy)await page.click('#signin-submit');await waitLoginClosed();return true;}
  return false;
 };
 try{
  trusted();
  const power=await root('dumpsys power');active();powerKnown=/mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power);if(!powerKnown)throw auth();wasAsleep=/mWakefulness=(?:Asleep|Dozing)/.test(power);
  // An already open native sheet suspends page JS. Inspect it before any DOM
  // evaluation and validate the exact domain/account before its single tap.
  if(await useSheet(await readSheet())){if(!await submitFilled({afterNative:true}))throw auth();return;}
  trusted();await page.waitForFunction(()=>!!document.querySelector('#sign-in-form #signin-password'),{polling:250,timeout:Math.max(1,Math.min(8000,deadlineAt-now()))});
  if(await submitFilled())return;
  active();await root('input keyevent 224');active();let lock=mmkKeyguardState(await root('dumpsys window policy'));active();
  if(lock.showing&&lock.secure)throw auth();
  if(lock.showing){await root('wm dismiss-keyguard');for(let i=0;i<10;i++){active();lock=mmkKeyguardState(await root('dumpsys window policy'));if(!lock.showing)break;if(lock.secure)throw auth();await sleep(150);}if(lock.showing)throw auth();}
  active();await root('am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome');trusted();await page.bringToFront();
  let xml=await readSheet();
  if(!savedSamBoatLoginButton(xml,expectedAccount)){
   if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();
   trusted();await page.click('#signin-password');await sleep(1200);xml=await readSheet();
  }
  if(!await useSheet(xml))throw auth();
  if(!await submitFilled({afterNative:true}))throw auth();
 }catch{throw auth();}
 finally{
  // Cleanup remains bounded after cancellation and restores the initial power
  // state. It cannot submit a form or unlock a secure device.
  const cleanup=rootCommand||(async command=>(await exec('su',['-c',command],{timeout:4000,maxBuffer:4096})).stdout);
  await cleanup('rm -f '+file).catch(()=>{});
  if(powerKnown&&wasAsleep)await cleanup('input keyevent 223').catch(()=>{});
 }
}
export async function collectSamBoatWithSavedLogin(context,{collect=collectSamBoat,recover=recoverSamBoatSavedLogin,now=Date.now}={}){
 const report=async reason=>{try{await context.reportDiagnostic?.({stage:'login_recovery',reason});}catch{}};
 try{return await collect(context);}
 catch(error){
  if(error?.code!=='auth_required'||context.signal?.aborted||context.deadlineAt-now()<15000)throw error;
  await report('progress');
  try{await recover(context.page,{signal:context.signal,deadlineAt:Math.min(context.deadlineAt,now()+75000),now});}
  catch{await report('auth_required');throw auth();}
  if(context.signal?.aborted||now()>=context.deadlineAt)throw auth();
  // No snapshot reuse: owner 700000, all tabs/pages/details, payment evidence
  // and final list reconciliation are checked from the beginning again.
  return collect(context);
 }
}
