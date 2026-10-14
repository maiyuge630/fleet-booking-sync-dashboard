import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {PLATFORM_URLS,verifyAuth} from './collectors.mjs';

const fixtures={
  boataround:'<div>Tidewyn Marine</div><a href="/en/000000000000000000000000/orders">Orders</a>',
  clickandboat:'<h1>Demo Owner</h1><div>All your bookings</div><button>History</button>',
  samboat:'<div role="tablist"><a href="#confirmed">Confirmed</a></div><a href="/private/reservations/new-messages/mark-as-read?to_user_id=700000">Read</a>'
};

async function withBrowser(t,run){
  const executablePath=[process.env.FLEET_CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&existsSync(p));
  if(!executablePath){t.skip('Local Chromium required');return;}
  const puppeteer=createRequire(new URL('./phone-server/package.json',import.meta.url))('puppeteer-core');
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,args:['--disable-background-networking','--no-first-run']});
  try{await run(browser);}finally{await browser.close();}
}

async function fixturePage(browser,url,html=''){
  const page=await browser.newPage();
  // Every request is served locally; these tests never contact a platform.
  await page.setRequestInterception(true);
  page.on('request',request=>request.respond({status:200,contentType:'text/html',body:html}));
  await page.evaluateOnNewDocument(()=>{window.requestAnimationFrame=()=>1;});
  await page.goto(url);
  await page.mainFrame().isolatedRealm().evaluate(()=>{window.requestAnimationFrame=()=>1;});
  return page;
}

test('All three login checks recognize delayed authenticated content with animation frames suspended',{timeout:25000},async t=>{
  await withBrowser(t,async browser=>{
    const results=await Promise.all(Object.entries(fixtures).map(async([source,html])=>{
      const page=await fixturePage(browser,PLATFORM_URLS[source]);
      try{
        await page.evaluate(markup=>{setTimeout(()=>{document.body.innerHTML=markup;},150);},html);
        return [source,await verifyAuth[source](page)];
      }finally{await page.close();}
    }));
    assert.deepEqual(Object.fromEntries(results),{boataround:true,clickandboat:true,samboat:true});
  });
});

test('Background login checks still reject a login page, wrong account, wrong origin and closed page',{timeout:20000},async t=>{
  await withBrowser(t,async browser=>{
    for(const [source,html] of Object.entries(fixtures)){
      const wrongAccount=html.replace('Tidewyn Marine','Another Operator').replace('Demo Owner','Other Owner').replace('700000','1');
      for(const [url,body] of [[PLATFORM_URLS[source],'<form>Sign in</form>'],[PLATFORM_URLS[source],wrongAccount],['https://example.invalid/',html]]){
        const page=await fixturePage(browser,url,body);
        try{
          // Only shorten the negative-test deadline; use the real browser,
          // production predicate and its polling mode without alteration.
          const boundedPage={waitForFunction:(predicate,options)=>page.waitForFunction(predicate,{...options,timeout:300})};
          assert.equal(await verifyAuth[source](boundedPage),false,source+' must reject '+url);
        }finally{await page.close();}
      }
    }
    const closed=await browser.newPage();
    await closed.close();
    assert.equal(await verifyAuth.samboat(closed),false);
  });
});
