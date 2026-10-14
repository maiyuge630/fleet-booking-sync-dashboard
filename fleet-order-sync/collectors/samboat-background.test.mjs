import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {waitForSamBoatCondition,activateSamBoatTab} from './samboat.mjs';

test('SamBoat readiness completes when animation frames stop, but still rejects missing data and cancellation', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&existsSync(p));
  if(!executablePath){t.skip('Local Chromium required');return;}
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();
    // Remove animation delivery in both page and isolated realms, reproducing
    // the renderer condition independently of the collector implementation.
    await page.evaluateOnNewDocument(()=>{window.requestAnimationFrame=()=>1;});
    await page.goto('data:text/html,<div id="result">loading</div>');
    const realm=page.mainFrame().isolatedRealm();
    await realm.evaluate(()=>{window.requestAnimationFrame=()=>1;});
    // Synchronize the first false predicate evaluation before changing the
    // document. A wall-clock timer could finish before Puppeteer starts its
    // predicate under parallel load, letting even a stopped RAF pass at once.
    const stalled=assert.rejects(page.waitForFunction(()=>{
      const result=document.querySelector('#result');result.dataset.rafStarted='true';
      return result.textContent==='ready';
    },{timeout:2000}),e=>e.name==='TimeoutError');
    // Attach immediately even if the independent observer below fails first.
    void stalled.catch(()=>{});
    const started=await page.waitForFunction(()=>document.querySelector('#result').dataset.rafStarted==='true',{polling:250,timeout:2000});
    await started.dispose();
    await page.$eval('#result',result=>{result.textContent='ready';});
    await stalled;
    assert.equal(await page.$eval('#result',e=>e.textContent),'ready');
    await page.$eval('#result',result=>{result.textContent='loading';});
    const progressing=waitForSamBoatCondition(page,()=>{
      const result=document.querySelector('#result');result.dataset.intervalStarted='true';
      return result.textContent==='ready';
    },{deadlineAt:Date.now()+3000});
    void progressing.catch(()=>{});
    const intervalStarted=await page.waitForFunction(()=>document.querySelector('#result').dataset.intervalStarted==='true',{polling:250,timeout:2000});
    await intervalStarted.dispose();
    await page.$eval('#result',result=>{result.textContent='ready';});
    await progressing;
    await assert.rejects(waitForSamBoatCondition(page,()=>document.querySelector('#missing'),{deadlineAt:Date.now()+150}),e=>e.code==='timeout'||e.name==='TimeoutError');
    const controller=new AbortController();
    const pending=waitForSamBoatCondition(page,()=>false,{deadlineAt:Date.now()+5000,signal:controller.signal});
    controller.abort();
    await assert.rejects(pending,e=>e.code==='timeout'||e.name==='AbortError');
  }finally{await browser.close();}
});

test('SamBoat existing tab activates without animation frames and waits for delayed selection', {timeout:20000}, async t=>{
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&existsSync(p));
  if(!executablePath){t.skip('Local Chromium required');return;}
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();
    await page.evaluateOnNewDocument(()=>{window.requestAnimationFrame=()=>1;});
    await page.goto('data:text/html,'+encodeURIComponent('<div role="tablist"><a role="tab" href="#confirmed">Confirmed</a><a role="tab" href="#ongoing">Requests</a></div><div role="tabpanel" id="archived" class="active">old</div><div role="tabpanel" id="confirmed">loading</div>'));
    await page.mainFrame().isolatedRealm().evaluate(()=>{window.requestAnimationFrame=()=>1;});
    await page.evaluate(()=>{
      document.querySelector('[href="#confirmed"]').addEventListener('click',event=>{
        event.preventDefault();
        setTimeout(()=>{
          document.querySelector('[role="tabpanel"].active').classList.remove('active');
          const panel=document.querySelector('#confirmed');panel.classList.add('active');panel.textContent='ready';
        },150);
      });
    });
    await activateSamBoatTab(page,'confirmed',{deadlineAt:Date.now()+2000});
    assert.deepEqual(await page.$eval('[role="tabpanel"].active',element=>[element.id,element.textContent]),['confirmed','ready']);
    // Merely finding/clicking a tab is not sufficient: its missing panel must fail.
    await assert.rejects(activateSamBoatTab(page,'ongoing',{deadlineAt:Date.now()+180}),e=>e.code==='timeout'||e.name==='TimeoutError');
    await assert.rejects(activateSamBoatTab(page,'archived',{deadlineAt:Date.now()+1000}),e=>e.code==='schema_changed');
    const controller=new AbortController();
    const pending=activateSamBoatTab(page,'ongoing',{deadlineAt:Date.now()+2000,signal:controller.signal});
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(pending,e=>e.code==='timeout'||e.name==='AbortError');
  }finally{await browser.close();}
});
