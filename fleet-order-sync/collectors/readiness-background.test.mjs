import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {waitForBoataroundCondition} from './boataround.mjs';
import {waitForClickAndBoatCondition} from './clickandboat.mjs';

test('Boataround and Click&Boat readiness progress without animation frames and preserve abort/deadline failures', {timeout:20000}, async t => {
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&existsSync(p));
  if(!executablePath){t.skip('Local Chromium required');return;}
  const puppeteer=createRequire(new URL('../phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try {
    const page=await browser.newPage();
    await page.evaluateOnNewDocument(()=>{window.requestAnimationFrame=()=>1;});
    await page.goto('data:text/html,<div id="result">loading</div>');
    await page.mainFrame().isolatedRealm().evaluate(()=>{window.requestAnimationFrame=()=>1;});
    await page.evaluate(()=>{setTimeout(()=>{document.querySelector('#result').textContent='ready';},100);});
    await assert.rejects(page.waitForFunction(()=>document.querySelector('#result').textContent==='ready',{timeout:700}),e=>e.name==='TimeoutError');
    for (const wait of [waitForBoataroundCondition,waitForClickAndBoatCondition]) {
      await page.evaluate(()=>{document.querySelector('#result').textContent='loading';setTimeout(()=>{document.querySelector('#result').textContent='ready';},100);});
      await wait(page,()=>document.querySelector('#result').textContent==='ready',{deadlineAt:Date.now()+2000});
      assert.equal(await page.$eval('#result',node=>node.textContent),'ready');
      await assert.rejects(wait(page,()=>document.querySelector('#missing'),{deadlineAt:Date.now()+150}),e=>e.code==='timeout'||e.name==='TimeoutError');
      const controller=new AbortController();
      const pending=wait(page,()=>false,{deadlineAt:Date.now()+5000,signal:controller.signal});
      setTimeout(()=>controller.abort(),50);
      await assert.rejects(pending,e=>e.code==='timeout'||e.name==='AbortError');
    }
  } finally { await browser.close(); }
});
