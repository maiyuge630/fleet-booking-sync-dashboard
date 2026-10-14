// Boataround saved-password login recovery (2026-10-04), in the phone's normal
// Android Chrome. Same boundaries as samboat-login.mjs and mmk-login.mjs: the
// program only taps Chrome's own "use saved password" sheet and the website's
// SIGN IN button. Passwords, cookies and tokens stay in Chrome and are never
// read, copied or typed by this program.
//
// Observed 2026-10-04 (incognito tab, Chinese Chrome 153): tapping the e-mail
// field opens Chrome's sheet "要使用已保存的密码吗？ / 您将登录
// partner.boataround.com" with two rows: the owner account saved for
// partner.boataround.com, and a different account saved for www.boataround.com
// (shown with a credential_origin line). Only the first may be used.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {ensureScreenAwake} from '../collectors/clickandboat-app.mjs';
import {collectBoataround} from '../collectors/boataround.mjs';
const exec=promisify(execFile);
// Hash of the owner account's saved username (the partner.boataround.com row).
export const BOATAROUND_SAVED_ACCOUNT='3333333333333333333333333333333333333333333333333333333333333333';
const ORIGIN='https://partner.boataround.com';
const accountHash=value=>createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
const auth=()=>Object.assign(Error('Boataround saved login requires attention'),{code:'auth_required'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const HIERARCHY=/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/;

function sheetNodes(xml){
 if(!HIERARCHY.test(String(xml).trim()))return null;
 return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>{
  const a=Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));
  const box=a.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number)??null;
  return {...a,rid:a['resource-id']||'',box:box&&box.every(n=>Number.isSafeInteger(n)&&n<=10000)&&box[2]>box[0]&&box[3]>box[1]?box:null};
 });
}
const inside=(inner,outer)=>inner&&outer&&inner[0]>=outer[0]&&inner[1]>=outer[1]&&inner[2]<=outer[2]&&inner[3]<=outer[3];
const centre=box=>({x:Math.floor((box[0]+box[2])/2),y:Math.floor((box[1]+box[3])/2)});
/** Where to tap in Chrome's saved-password sheet, or null. Fails closed on a
 * different domain, account or app, on a row for another site, or on more
 * than one matching row. */
export function savedBoataroundLogin(xml,expected=BOATAROUND_SAVED_ACCOUNT){
 const nodes=sheetNodes(xml);if(!nodes)return null;
 const id=name=>nodes.filter(n=>n.rid==='com.android.chrome:id/'+name);
 const titles=id('touch_to_fill_sheet_title'),subtitles=id('touch_to_fill_sheet_subtitle'),users=id('username'),origins=id('credential_origin');
 if(titles.length!==1||subtitles.length!==1||!/^(?:您将登录 |https:\/\/)?partner\.boataround\.com\/?$/.test(subtitles[0].text||''))return null;
 if([...titles,...subtitles,...users,...origins].some(n=>n.package!=='com.android.chrome'))return null;
 // A row is the smallest clickable Chrome node around a username. A row that
 // carries its own origin line belongs to another site (www.boataround.com).
 const rows=users.map(user=>{
  const row=nodes.filter(n=>n.package==='com.android.chrome'&&n.clickable==='true'&&n.enabled!=='false'&&n.box&&inside(user.box,n.box)&&n.rid!=='com.android.chrome:id/touch_to_fill_button_title')
   .sort((a,b)=>(a.box[2]-a.box[0])*(a.box[3]-a.box[1])-(b.box[2]-b.box[0])*(b.box[3]-b.box[1]))[0]??null;
  return {user,row,foreign:!!row&&origins.some(o=>inside(o.box,row.box))};
 });
 const mine=rows.filter(r=>accountHash(r.user.text||'')===expected&&!r.foreign);
 if(mine.length!==1)return null;
 if(mine[0].row)return centre(mine[0].row.box);
 // Single-account layout: one row and Chrome's own sign-in button.
 const buttons=id('touch_to_fill_button_title').filter(n=>n.clickable==='true'&&n.enabled!=='false'&&n.box&&['登录','Sign in','填充','Fill in','Fill'].includes(n.text));
 if(users.length!==1||origins.length||buttons.length!==1||buttons[0].package!=='com.android.chrome')return null;
 return centre(buttons[0].box);
}
/** Runs in the page. */
export function boataroundLoginForm(){
 if(location.origin!=='https://partner.boataround.com'||location.pathname!=='/en/login')return {login:false};
 const email=document.querySelector('input#email[type=email]'),password=document.querySelector('input#password[type=password]'),form=email?.form;
 if(!email||!password||!form||password.form!==form||!form.getBoundingClientRect().height)return {login:false};
 const submits=[...form.querySelectorAll('button[type=submit]')].filter(b=>b.getClientRects().length&&b.innerText.trim().toUpperCase()==='SIGN IN');
 return {login:true,username:email.value,filled:!!password.value,submit:submits.length===1,busy:submits[0]?.disabled===true};
}
/** Runs in the page: clicks the form's only SIGN IN button (a DOM click, so it
 * also works while Android has paused page animation frames). */
export function submitBoataroundLogin(){
 const form=document.querySelector('input#email[type=email]')?.form;
 const submits=[...(form?.querySelectorAll('button[type=submit]')||[])].filter(b=>b.getClientRects().length&&b.innerText.trim().toUpperCase()==='SIGN IN');
 if(location.origin!=='https://partner.boataround.com'||submits.length!==1||submits[0].disabled)return false;
 submits[0].click();return true;
}
export async function recoverBoataroundSavedLogin(page,{signal,deadlineAt=Date.now()+75000,now=Date.now,rootCommand,sleep=pause,expectedAccount=BOATAROUND_SAVED_ACCOUNT}={}){
 const active=()=>{if(signal?.aborted||now()>=deadlineAt)throw auth();};
 const trusted=()=>{active();const u=new URL(page.url());if(u.origin!==ORIGIN||u.username||u.password)throw auth();};
 const root=rootCommand||(async command=>{active();return(await exec('su',['-c',command],{timeout:Math.max(1,Math.min(12000,deadlineAt-now())),maxBuffer:1024*1024,signal})).stdout;});
 const file='/data/local/tmp/fleet-boataround-saved-login-'+process.pid+'.xml';
 const bounded=ms=>Math.max(1,Math.min(ms,deadlineAt-now()));
 let wasAsleep=false,powerKnown=false;
 const readSheet=async()=>{
  for(let attempt=0;attempt<2;attempt++){
   try{active();await root('rm -f '+file);active();await root('uiautomator dump '+file);active();const xml=String(await root('cat '+file)).trim();active();if(!HIERARCHY.test(xml))throw auth();return xml;}
   catch{active();if(attempt)throw auth();await sleep(400);}
  }
 };
 const useSheet=async xml=>{
  const point=savedBoataroundLogin(xml,expectedAccount);
  if(!point){if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();return false;}
  trusted();await root(`input tap ${point.x} ${point.y}`);await sleep(1500);active();return true;
 };
 // The SPA's own route is the signal: signed in once it leaves /en/login. The
 // caller then reads the whole account again (account id path and "Tidewyn Charters
 // Marine"), so leaving the route alone never counts as a verified login.
 const signInRoute=()=>{trusted();return new URL(page.url()).pathname==='/en/login';};
 const readForm=async()=>{try{return await page.evaluate(boataroundLoginForm);}catch{active();return null;}};
 const expectedFilled=form=>form?.login===true&&form.filled&&form.submit&&accountHash(form.username||'')===expectedAccount;
 // Observed 2026-10-04: after the sheet tap Chrome fills and submits by itself
 // and the page navigates, which destroys the page context mid-evaluation. So
 // an evaluation error means "navigating", never success or failure. A form
 // Chrome filled with the owner account is submitted at most once.
 const complete=async()=>{
  let submitted=false;
  for(let step=0;step<40;step++){
   if(!signInRoute())return true;
   const form=await readForm();
   if(!signInRoute())return true;
   if(!submitted&&expectedFilled(form)&&!form.busy){
    submitted=true;
    let clicked;try{clicked=await page.evaluate(submitBoataroundLogin);}catch{active();clicked=true;}
    if(!clicked)return false;
   }
   await sleep(500);active();
  }
  return false;
 };
 try{
  trusted();
  const power=await root('dumpsys power');active();powerKnown=/mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power);if(!powerKnown)throw auth();wasAsleep=/mWakefulness=(?:Asleep|Dozing)/.test(power);
  // An open native sheet suspends page JavaScript: inspect it first.
  if(await useSheet(await readSheet())){if(!await complete())throw auth();return;}
  trusted();await page.waitForFunction(()=>!!document.querySelector('input#email[type=email]')&&!!document.querySelector('input#password[type=password]'),{polling:250,timeout:bounded(8000)});
  const form=await readForm();
  if(form?.login&&(expectedFilled(form)||form.busy)){if(!await complete())throw auth();return;}
  // A lock screen with a password is never unlocked (device_locked).
  active();await ensureScreenAwake(async command=>{active();return root(command);},sleep);
  active();await root('am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome');trusted();await page.bringToFront();
  for(const field of ['#email','#password']){
   let xml=await readSheet();
   if(!savedBoataroundLogin(xml,expectedAccount)){
    if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();
    trusted();await page.click(field);await sleep(1200);xml=await readSheet();
   }
   if(await useSheet(xml)){if(!await complete())throw auth();return;}
  }
  throw auth();
 }catch{throw auth();}
 finally{
  // Cleanup is bounded even after cancellation and restores the initial
  // power state. It cannot submit a form or unlock a secure device.
  const cleanup=rootCommand||(async command=>(await exec('su',['-c',command],{timeout:4000,maxBuffer:4096})).stdout);
  await cleanup('rm -f '+file).catch(()=>{});
  if(powerKnown&&wasAsleep)await cleanup('input keyevent 223').catch(()=>{});
 }
}
export async function collectBoataroundWithSavedLogin(context,{collect=collectBoataround,recover=recoverBoataroundSavedLogin,now=Date.now}={}){
 const report=async reason=>{try{await context.reportDiagnostic?.({stage:'login_recovery',reason});}catch{}};
 try{return await collect(context);}
 catch(error){
  if(error?.code!=='auth_required'||context.signal?.aborted||context.deadlineAt-now()<15000)throw error;
  await report('progress');
  try{await recover(context.page,{signal:context.signal,deadlineAt:Math.min(context.deadlineAt,now()+75000),now});}
  catch{await report('auth_required');throw auth();}
  if(context.signal?.aborted||now()>=context.deadlineAt)throw auth();
  // No reuse of the first attempt: every list page, payment detail and the
  // final list comparison are read again from the beginning.
  return collect(context);
 }
}
