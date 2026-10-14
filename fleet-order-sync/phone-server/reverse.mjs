import path from 'node:path';
import {readJSON,writeJSON} from './core.mjs';
import {ReverseExecutor} from '../reverse-sync/executor.mjs';
import {normalizeRows} from '../reverse-sync/clickandboat-adapter.mjs';
import {ClickAndBoatAppAdapter,migrateWebLedger} from '../reverse-sync/clickandboat-app-adapter.mjs';
import {SamBoatAdapter} from '../reverse-sync/samboat-adapter.mjs';
import {BoataroundAdapter} from '../reverse-sync/boataround-adapter.mjs';
import {MmkAdapter} from '../reverse-sync/mmk-adapter.mjs';
import {NausysAdapter} from '../reverse-sync/nausys-adapter.mjs';
import {recoverMmkSavedLoginWithRetry} from './mmk-login.mjs';
import {recoverNausysSavedLogin} from './nausys-login.mjs';
import {recoverBoataroundSavedLogin} from './boataround-login.mjs';
import {recoverClickAndBoatAppLogin} from '../collectors/clickandboat-app-login.mjs';
import {readReversePlan} from './reverse-plan-read.mjs';
import {compactLedger} from '../reverse-sync/ledger-compact.mjs';

/** The dashboard accepts a target's receipt up to 10 minutes after its check.
 * Runs with Click&Boat app writes take longer, so each finished target is
 * reported at once and a later call sends only what was not reported yet. */
export function reverseReporter({plan,request,now}){
  const reported=new Map();
  return async ledger=>{
    const latestPlan=await plan();
    const targets=latestPlan.targets.map(t=>{const r=ledger.targets[t.target+':'+(t.listing_id||'missing:'+t.boat)];return {key:t.key,...r};})
      .filter(r=>r.checked_at&&now()-Date.parse(r.checked_at)<=600000&&reported.get(r.key)!==r.checked_at);
    if(!targets.length)return;
    await request('reverse-report',{mode:'guarded_release',targets});
    for(const t of targets)reported.set(t.key,t.checked_at);
  };
}

/** Called inside the existing collection lock; never launches a second profile. */
export async function reverseSync(agent,{closeOnly=false}={}) {
  if(agent.closed)throw Error('phone_shutdown');
  let mmkLoginAttempted=false,boataroundLoginAttempted=false,nausysLoginAttempted=false;
  const plan=()=>readReversePlan(agent.remote,{isCancelled:()=>agent.closed,signal:agent.activeRunController?.signal});
  const file=path.join(agent.home,'reverse-ledger.json');
  const load=async()=>{
    const existing=await readJSON(file,null);if(existing){
      const proof=await readJSON(path.join(agent.home,'mmk-proof-ledger.json'),null);
      for(const a of proof?.attempts||[])if(a.state==='confirmed'&&a.created?.id&&!existing.attempts.some(x=>x.id===a.id||x.target===a.target&&x.created?.id===a.created.id))existing.attempts.push(a);
      // Drop detail no rule reads any more; the next save persists it (2026-10-10).
      return migrateWebLedger(compactLedger(existing,agent.now()));
    }
    const proof=await readJSON(path.join(agent.home,'reverse-runtime/cb-ad2-20261212-18-proof.json'),null);
    const ledger={version:1,attempts:[],targets:{}};
    if(proof?.stage==='confirmed'&&proof.listing_id==='100004'&&proof.start==='2026-12-12'&&proof.end==='2026-12-19'&&proof.created?.id==='70000000'){
      ledger.attempts.push({id:'import-proof-70000000',target:'clickandboat:100004',start:proof.start,end:proof.end,causes:['boataround:300000'],before:normalizeRows(proof.before),created:normalizeRows([proof.created])[0],state:'pending_readback'});
    }
    return migrateWebLedger(ledger);
  };
  const access={
    openPage:async source=>{const browser=await agent.ensureBrowser(source);return agent.createManagedPage(source,browser);},
    closePage:page=>agent.closeManagedPage(page)
  };
  const openMmkPage=async(forceWake=false)=>{
    if(agent.closed)throw Error('phone_shutdown');
    let browser;
    try{browser=await agent.ensureBrowser('mmk',undefined,forceWake);}
    catch(error){if(forceWake||agent.closed)throw error;browser=await agent.ensureBrowser('mmk',undefined,true);}
    if(agent.closed)throw Error('phone_shutdown');
    const page=await agent.createManagedPage('mmk',browser);
    if(agent.closed){await agent.closeManagedPage(page);throw Error('phone_shutdown');}
    return page;
  };
  const report=reverseReporter({plan,request:(route,body)=>agent.remote.request(route,body),now:agent.now});
  // Click&Boat runs through its official app (the website blocks the automated
  // browser). An app calendar read takes about 35-55 s and a write 3-4 minutes,
  // so the run budget covers seven reads and some writes besides the others.
  const executor=new ReverseExecutor({load,save:v=>writeJSON(file,v),budgetMs:900000,forceCloseOnly:closeOnly,afterTarget:ledger=>agent.closed?undefined:report(ledger),
    plan,adapters:{clickandboat:new ClickAndBoatAppAdapter({now:agent.now,isCancelled:()=>agent.closed,recoverLogin:recoverClickAndBoatAppLogin,
      // The last unreadable calendar list, node kinds only (2026-10-10).
      onListFailure:shape=>writeJSON(path.join(agent.home,'cb-calendar-diag.json'),{at:new Date(agent.now()).toISOString(),...shape})}),samboat:new SamBoatAdapter(access),boataround:new BoataroundAdapter({...access,
      // One saved-password attempt per run, only in the phone's normal Chrome.
      recoverLogin:async page=>{
        if(boataroundLoginAttempted||!agent.usesNativeBrowser('boataround')||!agent.prepareNativeBrowser)throw Error('auth_required');
        boataroundLoginAttempted=true;
        await recoverBoataroundSavedLogin(page,{signal:agent.activeRunController?.signal});
      }}),mmk:new MmkAdapter({
      openPage:()=>openMmkPage(),closePage:access.closePage,
      onReadFailure:()=>openMmkPage(true),isCancelled:()=>agent.closed,
      recoverLogin:async page=>{
        if(mmkLoginAttempted||!agent.usesNativeBrowser('mmk'))throw Error('mmk_auth_required');
        mmkLoginAttempted=true;
        await recoverMmkSavedLoginWithRetry(page,{isCancelled:()=>agent.closed});
      }
    }),
    // NauSYS (since 2026-10-09): the phone's normal Chrome, signed in as
    // demo-user@AGENCY; one saved-password attempt per run.
    nausys:new NausysAdapter({
      openPage:async()=>{
        if(agent.closed)throw Error('phone_shutdown');
        const browser=await agent.ensureBrowser('nausys');
        return agent.createManagedPage('nausys',browser);
      },closePage:access.closePage,isCancelled:()=>agent.closed,now:agent.now,
      recoverLogin:async page=>{
        if(nausysLoginAttempted||!agent.usesNativeBrowser('nausys'))throw Error('nausys_auth_required');
        nausysLoginAttempted=true;
        await recoverNausysSavedLogin(page,{signal:agent.activeRunController?.signal});
      }})},now:agent.now,isCancelled:()=>agent.closed});
  const ledger=await executor.run();
  if(agent.closed)throw Error('phone_shutdown');
  await report(ledger);
  return {checked_at:new Date(agent.now()).toISOString(),mode:closeOnly?'close_only':'guarded_release',targets:ledger.targets};
}
