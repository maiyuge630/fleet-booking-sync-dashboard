// NauSYS saved-password login recovery (2026-10-09), in the phone's normal
// Android Chrome. Same boundaries as boataround-login.mjs: the program only
// taps Chrome's own "use saved password" sheet and, if Chrome did not submit,
// the website's Login button once. Passwords, cookies and tokens stay in
// Chrome and are never read, copied or typed by this program.
//
// Observed 2026-10-09: tapping the user field opens Chrome's sheet "您将登录
// app.nausys.com" with two rows, demo-user@AGENCY and colleague@AGENCY. The program uses
// demo-user@AGENCY only (user decision: colleague@AGENCY stays with colleagues). After the
// tap Chrome filled and submitted the form by itself.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {ensureScreenAwake} from '../collectors/clickandboat-app.mjs';
import {NAUSYS_ORIGIN, NAUSYS_LOGIN_PATH} from '../reverse-sync/nausys-client.mjs';
const exec=promisify(execFile);
// Hash of the saved username demo-user@AGENCY.
export const NAUSYS_SAVED_ACCOUNT='4cae04d9ef974ff940d174e723aa9b3bf411844e73a0760c37e6727e1f9ed848';
const accountHash=value=>createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
const auth=()=>Object.assign(Error('nausys_auth_required'),{code:'auth_required'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const HIERARCHY=/^(?:<\?xml[^>]*\?>\s*)?<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>$/;

function sheetNodes(xml){
 if(!HIERARCHY.test(String(xml).trim()))return null;
 return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>{
  const a=Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));
  const box=a.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number)??null;
  // Never keep the text of a password node.
  return {...a,text:a.password==='true'?'':a.text,rid:a['resource-id']||'',box:box&&box.every(n=>Number.isSafeInteger(n)&&n<=10000)&&box[2]>box[0]&&box[3]>box[1]?box:null};
 });
}
const inside=(inner,outer)=>inner&&outer&&inner[0]>=outer[0]&&inner[1]>=outer[1]&&inner[2]<=outer[2]&&inner[3]<=outer[3];
const centre=box=>({x:Math.floor((box[0]+box[2])/2),y:Math.floor((box[1]+box[3])/2)});
/** Where to tap in Chrome's saved-password sheet, or null. Fails closed on a
 * different domain, app or account, on a row for another site, or on more
 * than one matching row. */
export function savedNausysLogin(xml,expected=NAUSYS_SAVED_ACCOUNT){
 const nodes=sheetNodes(xml);if(!nodes)return null;
 const id=name=>nodes.filter(n=>n.rid==='com.android.chrome:id/'+name);
 const titles=id('touch_to_fill_sheet_title'),subtitles=id('touch_to_fill_sheet_subtitle'),users=id('username'),origins=id('credential_origin');
 if(titles.length!==1||subtitles.length!==1||!/^(?:您将登录 |https:\/\/)?app\.nausys\.com\/?$/.test(subtitles[0].text||''))return null;
 if([...titles,...subtitles,...users,...origins].some(n=>n.package!=='com.android.chrome'))return null;
 const rows=users.map(user=>{
  const row=nodes.filter(n=>n.package==='com.android.chrome'&&n.clickable==='true'&&n.enabled!=='false'&&n.box&&inside(user.box,n.box)&&n.rid!=='com.android.chrome:id/touch_to_fill_button_title')
   .sort((a,b)=>(a.box[2]-a.box[0])*(a.box[3]-a.box[1])-(b.box[2]-b.box[0])*(b.box[3]-b.box[1]))[0]??null;
  return {user,row,foreign:!!row&&origins.some(o=>inside(o.box,row.box))};
 });
 const mine=rows.filter(r=>accountHash(r.user.text||'')===expected&&!r.foreign);
 if(mine.length!==1)return null;
 if(mine[0].row)return centre(mine[0].row.box);
 const buttons=id('touch_to_fill_button_title').filter(n=>n.clickable==='true'&&n.enabled!=='false'&&n.box&&['登录','Sign in','填充','Fill in','Fill'].includes(n.text));
 if(users.length!==1||origins.length||buttons.length!==1||buttons[0].package!=='com.android.chrome')return null;
 return centre(buttons[0].box);
}
/** Runs in the page: only whether the password is filled, never its value.
 * The visible "Sign in" button counts; an older small submit input is the fallback. */
export function nausysLoginForm(){
 if(location.origin!=='https://app.nausys.com'||location.pathname!=='/NauSYS-app/login.xhtml')return {login:false};
 const user=document.getElementById('loginForm:loginInput'),password=document.querySelector('input[type=password]');
 const button=['loginForm:loginButton','loginForm:loginBtn'].map(id=>document.getElementById(id)).find(b=>b&&b.getClientRects().length);
 if(!user||!password||!button||password.form!==user.form)return {login:false};
 return {login:true,username:user.value,filled:!!password.value,submit:true,busy:button.disabled===true};
}
export function submitNausysLogin(){
 const button=['loginForm:loginButton','loginForm:loginBtn'].map(id=>document.getElementById(id)).find(b=>b&&b.getClientRects().length);
 if(location.origin!=='https://app.nausys.com'||!button||button.disabled)return false;
 button.click();return true;
}
/** Runs in the page. NauSYS signs out after about half an hour without use
 * (seen 2026-10-09); tick its own "Remember me" before Chrome submits. */
export function rememberNausysLogin(){
 const box=document.querySelector('input[type=checkbox][id^="loginForm:"]');
 const holder=box?.closest('.ui-chkbox');
 if(!box||!holder||!/^Remember me$/i.test((holder.parentElement?.innerText||'').trim()))return false;
 if(!box.checked)(holder.querySelector('.ui-chkbox-box')||box).click();
 return box.checked;
}
export async function recoverNausysSavedLogin(page,{signal,deadlineAt=Date.now()+75000,now=Date.now,rootCommand,sleep=pause,expectedAccount=NAUSYS_SAVED_ACCOUNT}={}){
 const active=()=>{if(signal?.aborted||now()>=deadlineAt)throw auth();};
 const trusted=()=>{active();const u=new URL(page.url());if(u.origin!==NAUSYS_ORIGIN||u.username||u.password)throw auth();};
 const root=rootCommand||(async command=>{active();return(await exec('su',['-c',command],{timeout:Math.max(1,Math.min(12000,deadlineAt-now())),maxBuffer:1024*1024,signal})).stdout;});
 const file='/data/local/tmp/fleet-nausys-saved-login-'+process.pid+'.xml';
 const bounded=ms=>Math.max(1,Math.min(ms,deadlineAt-now()));
 let wasAsleep=false,powerKnown=false;
 const readSheet=async()=>{
  for(let attempt=0;attempt<2;attempt++){
   try{active();await root('rm -f '+file);active();await root('uiautomator dump '+file);active();const xml=String(await root('cat '+file)).trim();active();await root('rm -f '+file);if(!HIERARCHY.test(xml))throw auth();return xml;}
   catch{active();if(attempt)throw auth();await sleep(400);}
  }
 };
 const useSheet=async xml=>{
  const point=savedNausysLogin(xml,expectedAccount);
  if(!point){if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();return false;}
  trusted();await root(`input tap ${point.x} ${point.y}`);await sleep(1500);active();return true;
 };
 const onLogin=()=>{trusted();return new URL(page.url()).pathname===NAUSYS_LOGIN_PATH;};
 const readForm=async()=>{try{return await page.evaluate(nausysLoginForm);}catch{active();return null;}};
 const expectedFilled=form=>form?.login===true&&form.filled&&form.submit&&accountHash(form.username||'')===expectedAccount;
 // Leaving the login page is the signal; the caller then checks the signed-in
 // user on the reservation list before reading anything.
 const complete=async()=>{
  let submitted=false;
  for(let step=0;step<40;step++){
   if(!onLogin())return true;
   const form=await readForm();
   if(!onLogin())return true;
   if(!submitted&&expectedFilled(form)&&!form.busy){
    submitted=true;
    let clicked;try{clicked=await page.evaluate(submitNausysLogin);}catch{active();clicked=true;}
    if(!clicked)return false;
   }
   await sleep(500);active();
  }
  return false;
 };
 try{
  trusted();
  const power=await root('dumpsys power');active();powerKnown=/mWakefulness=(?:Asleep|Dozing|Awake|Dreaming)/.test(power);if(!powerKnown)throw auth();wasAsleep=/mWakefulness=(?:Asleep|Dozing)/.test(power);
  if(await useSheet(await readSheet())){if(!await complete())throw auth();return;}
  trusted();await page.waitForFunction(()=>!!document.getElementById('loginForm:loginInput')&&!!document.querySelector('input[type=password]'),{polling:250,timeout:bounded(8000)});
  const form=await readForm();
  if(form?.login&&(expectedFilled(form)||form.busy)){if(!await complete())throw auth();return;}
  active();await ensureScreenAwake(async command=>{active();return root(command);},sleep);
  active();await root('am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome');trusted();await page.bringToFront();
  // Optional: a missing or changed checkbox only means a shorter session.
  trusted();try{await page.evaluate(rememberNausysLogin);}catch{active();}
  for(const field of ['[id="loginForm:loginInput"]','input[type=password]']){
   let xml=await readSheet();
   if(!savedNausysLogin(xml,expectedAccount)){
    if(xml.includes('com.android.chrome:id/touch_to_fill_sheet_title'))throw auth();
    trusted();await page.click(field);await sleep(1200);xml=await readSheet();
   }
   if(await useSheet(xml)){if(!await complete())throw auth();return;}
  }
  throw auth();
 }catch{throw auth();}
 finally{
  const cleanup=rootCommand||(async command=>(await exec('su',['-c',command],{timeout:4000,maxBuffer:4096})).stdout);
  await cleanup('rm -f '+file).catch(()=>{});
  if(powerKnown&&wasAsleep)await cleanup('input keyevent 223').catch(()=>{});
 }
}
