import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const root=async command=>(await exec('su',['-c',command],{timeout:15000,maxBuffer:1024*1024})).stdout;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function mmkKeyguardState(text){
 const block=String(text).match(/^([ ]*)KeyguardServiceDelegate\r?\n((?:\1 +[^\n]*\n?)*)/m);
 if(!block)throw Error('mmk_auth_required');
 const field=name=>{const values=block[2].split('\n').filter(l=>l.startsWith(block[1]+'  '+name+'='));if(values.length!==1)throw Error('mmk_auth_required');return values[0].trim().split('=')[1];};
 const showing=field('showing'),secure=field('secure');
 if(!['true','false'].includes(showing)||!['true','false'].includes(secure))throw Error('mmk_auth_required');
 return {showing:showing==='true',secure:secure==='true'};
}
export function savedMmkLoginButton(xml){
 if(!/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/.test(String(xml).trim()))return null;
 const nodes=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
 const subtitles=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/touch_to_fill_sheet_subtitle');
 const users=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/username');
 const buttons=nodes.filter(n=>n['resource-id']==='com.android.chrome:id/touch_to_fill_button_title'&&n.clickable==='true'&&n.enabled!=='false'&&['登录','Sign in','填充','Fill in','Fill'].includes(n.text));
 // Fail closed on lookalike domains, different accounts or ambiguous prompts.
 if(subtitles.length!==1||! /^(?:您将登录 |(?:https:\/\/))?portal\.booking-manager\.com\/?$/.test(subtitles[0].text)||users.length!==1||users[0].text!=='DemoUser'||buttons.length!==1)return null;
 if([...subtitles,...users,...buttons].some(n=>n.package!=='com.android.chrome'))return null;
 const bounds=buttons[0].bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
 if(!bounds||bounds.some(n=>!Number.isSafeInteger(n)||n>10000)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])return null;
 return {x:Math.floor((bounds[0]+bounds[2])/2),y:Math.floor((bounds[1]+bounds[3])/2)};
}
export function mmkLoginForm(){
 if(location.origin!=='https://portal.booking-manager.com'||!location.pathname.startsWith('/wbm2/app/login_register/'))return {login:false};
 const password=document.querySelector('input[name="login_password"][type="password"]'),username=document.querySelector('input[name="login_email"]');
 return {login:!!password,expectedUser:username?.value==='DemoUser',filled:!!password?.value};
}
// MMK may render its authenticated home at the unchanged login_register URL.
// This is only a navigation/fill progress signal. MmkClient still verifies the
// real serviceId/isCharter account before reading or writing any booking.
export function mmkAutofillReady(){
 if(location.origin!=='https://portal.booking-manager.com')return false;
 const password=document.querySelector('input[name="login_password"][type="password"]');
 if(password)return !!password.value&&!!document.querySelector('input[name="login_email"]')?.value;
 return !location.pathname.startsWith('/wbm2/app/login_register/')||!!document.querySelector('#bm-homepage-card-link-my-bookings');
}
export function mmkLoginFinished(){
 return location.origin==='https://portal.booking-manager.com'&&!document.querySelector('input[name="login_password"][type="password"]')&&
  (!location.pathname.startsWith('/wbm2/app/login_register/')||!!document.querySelector('#bm-homepage-card-link-my-bookings'));
}
export async function recoverMmkSavedLogin(page,{isCancelled=()=>false,rootCommand=root,sleep=pause,now=Date.now,deadlineAt=now()+75000}={}){
 const active=()=>{if(isCancelled())throw Error('phone_shutdown');if(now()>=deadlineAt)throw Error('mmk_auth_required');};
 const trusted=()=>{active();const u=new URL(page.url());if(u.origin!=='https://portal.booking-manager.com'||u.username||u.password)throw Error('mmk_auth_required');};
 let wasAsleep=false,powerKnown=false;
 const file='/data/local/tmp/fleet-mmk-saved-login-'+process.pid+'.xml';
 active();
 try{
  trusted();const power=await rootCommand('dumpsys power');active();powerKnown=/mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power);if(!powerKnown)throw Error('mmk_auth_required');wasAsleep=/mWakefulness=(?:Asleep|Dozing)/.test(power);
  const readSheet=async()=>{
   for(let attempt=0;attempt<2;attempt++){
    try{
     active();await rootCommand('rm -f '+file);active();await rootCommand('uiautomator dump '+file);
     active();const xml=String(await rootCommand('cat '+file)).trim();active();
     if(!/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/.test(xml))throw Error('incomplete_native_hierarchy');
     return xml;
    }catch{active();if(attempt===1)throw Error('mmk_native_ui_unavailable');await sleep(500);}
   }
  };
  const useSheet=async xml=>{
   const button=savedMmkLoginButton(xml);
   if(!button){if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw Error('mmk_auth_required');return false;}
   active();if(mmkKeyguardState(await rootCommand('dumpsys window policy')).showing)throw Error('mmk_auth_required');
   trusted();await rootCommand(`input tap ${button.x} ${button.y}`);await sleep(500);active();return true;
  };
  const submitFilled=async(afterNative=false)=>{
   if(afterNative){
    // The Fill action is asynchronous and does not necessarily submit Login.
    // Wait for both fields (or completed navigation) before deciding what to do.
    trusted();await page.waitForFunction(mmkAutofillReady,{polling:250,timeout:Math.max(1,Math.min(10000,deadlineAt-now()))});
   }
   trusted();let state;try{state=await page.evaluate(mmkLoginForm);}catch(error){active();if(afterNative)return true;throw error;}active();
   if(!state.login){
    // The saved-password action may finish navigation between two UI reads.
    // MmkClient will still verify the actual owner account before any write.
    try{if(await page.evaluate(mmkLoginFinished))return true;}
    catch{active();trusted();return true;}
    if(afterNative)return true;
    throw Error('mmk_auth_required');
   }
   if(state.expectedUser&&state.filled){
    trusted();await page.click('input[type="submit"]');
    await page.waitForFunction(mmkLoginFinished,{polling:250,timeout:Math.max(1,Math.min(15000,deadlineAt-now()))});active();return true;
   }
   return false;
  };
  // A native sheet can already be open on arrival and suspend page JS.
  // Inspect it before any DOM evaluation, just as in the SamBoat flow.
  if(await useSheet(await readSheet())){if(!await submitFilled(true))throw Error('mmk_auth_required');return;}
  if(await submitFilled())return;
  active();await rootCommand('input keyevent 224');
  let lock=mmkKeyguardState(await rootCommand('dumpsys window policy'));
  if(lock.showing&&lock.secure)throw Error('mmk_auth_required');
  if(lock.showing){
   active();
   await rootCommand('wm dismiss-keyguard');
   for(let n=0;n<10;n++){
    active();lock=mmkKeyguardState(await rootCommand('dumpsys window policy'));
    if(!lock.showing)break;if(lock.secure)throw Error('mmk_auth_required');await sleep(150);
   }
   if(lock.showing)throw Error('mmk_auth_required');
  }
  active();await rootCommand('am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome');
  trusted();await page.bringToFront();
  if(await useSheet(await readSheet())){if(!await submitFilled(true))throw Error('mmk_auth_required');return;}
  for(const field of ['login_email','login_password']){
   trusted();await page.click(`input[name="${field}"]`);await sleep(1200);
   if(await useSheet(await readSheet())){if(!await submitFilled(true))throw Error('mmk_auth_required');return;}
   if(await submitFilled())return;
  }
  // No saved account was selected and no web Login was submitted. Only this
  // narrowly identified no-action failure is eligible for one bounded retry.
  throw Object.assign(Error('mmk_auth_required'),{retryWithoutLoginAction:true});
 }finally{
  await rootCommand('rm -f '+file).catch(()=>{});
  if(powerKnown&&wasAsleep)await rootCommand('input keyevent 223').catch(()=>{});
 }
}

export async function recoverMmkSavedLoginWithRetry(page,{
 recover=recoverMmkSavedLogin,isCancelled=()=>false,now=Date.now,
 deadlineAt=now()+75000,sleep=pause,...options
}={}){
 const run=()=>recover(page,{...options,isCancelled,now,deadlineAt,sleep});
 try{return await run();}
 catch(error){
  // A native hierarchy read error or exhausted prompts are the only cases
  // known to happen before selecting a saved account or submitting Login.
  if(isCancelled())throw Error('phone_shutdown');
  if(error?.message!=='mmk_native_ui_unavailable'&&error?.retryWithoutLoginAction!==true)throw error;
  if(deadlineAt-now()<30000)throw error;
  await sleep(750);
  if(isCancelled())throw Error('phone_shutdown');
  if(deadlineAt-now()<30000)throw error;
  return run();
 }
}
