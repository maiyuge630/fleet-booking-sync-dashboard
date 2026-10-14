import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {WebSocketServer} from 'ws';
import {PhoneAgent} from '../core.mjs';
import {authorized,sameLocalOrigin,Tickets,createManagementServer} from '../http.mjs';
const config={admin_user:'admin',admin_password:'test-password-not-real',vnc_password:'Demo5678'};
const auth='Basic '+Buffer.from('admin:test-password-not-real').toString('base64');
test('Basic credentials and local origin are both required',()=>{
  assert.equal(authorized({headers:{}},config),false);assert.equal(authorized({headers:{authorization:auth}},config),true);
  assert.equal(sameLocalOrigin({headers:{host:'127.0.0.1:8878',origin:'http://127.0.0.1:8878'}}),true);
  assert.equal(sameLocalOrigin({headers:{host:'127.0.0.1:8878',origin:'https://hostile.example'}}),false);
  assert.equal(sameLocalOrigin({headers:{host:'hostile.example'}}),false);
});
test('VNC tickets expire, bind to exact origin, and are single use',()=>{
  let now=1000;const tickets=new Tickets(()=>now);const first=tickets.issue('http://127.0.0.1:8878');
  assert.equal(tickets.consume(first,'http://127.0.0.1:8878'),true);assert.equal(tickets.consume(first,'http://127.0.0.1:8878'),false);
  const second=tickets.issue('http://localhost:8878');assert.equal(tickets.consume(second,'http://127.0.0.1:8878'),false);
  const third=tickets.issue('http://127.0.0.1:8878');now+=30001;assert.equal(tickets.consume(third,'http://127.0.0.1:8878'),false);
});
test('management endpoints enforce auth, origin, and static file boundaries',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-http-test-'));await fs.mkdir(path.join(temp,'core'));await fs.writeFile(path.join(temp,'core','rfb.js'),'export default class RFB {}');
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const agent={status:async()=>({paired:false}),pair:async()=>({ok:true})};
  const server=createManagementServer({agent,config,novncRoot:temp,WebSocketServer});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/health')).status,200);assert.equal((await fetch(url+'/api/status')).status,401);
  assert.equal((await fetch(url+'/api/status',{headers:{Authorization:auth}})).status,200);
  assert.equal((await fetch(url+'/api/vnc-ticket',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json',Origin:'https://hostile.example'},body:'{}'})).status,403);
  const ticket=await fetch(url+'/api/vnc-ticket',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json',Origin:url},body:'{}'});const desktopCredentials=await ticket.json();assert.match(desktopCredentials.ticket,/^[A-Za-z0-9_-]{43}$/);assert.equal(desktopCredentials.vnc_password,config.vnc_password);
  assert.equal((await fetch(url+'/novnc/core/rfb.js',{headers:{Authorization:auth}})).status,200);
  assert.equal((await fetch(url+'/novnc/%2e%2e%2fconfig.json',{headers:{Authorization:auth}})).status,404);
  const text=await (await fetch(url+'/',{headers:{Authorization:auth}})).text();assert.equal(text.includes(config.admin_password),false);assert.equal(text.includes(config.vnc_password),false);
  assert.match(text,/先选择平台，再打开手机桌面，在里面的浏览器完成登录/);
  agent.usesNativeBrowser=source=>source==='samboat';
  const nativeText=await (await fetch(url+'/',{headers:{Authorization:auth}})).text();
  assert.match(nativeText,/Boataround：先选择平台，再打开手机桌面完成登录/);
  assert.match(nativeText,/SamBoat：选择平台后，在这台手机的 Chrome 中完成登录/);
  agent.usesNativeBrowser=source=>['boataround','samboat','mmk'].includes(source);
  const bothNative=await (await fetch(url+'/',{headers:{Authorization:auth}})).text();
  assert.match(bothNative,/Boataround：选择平台后，在这台手机的 Chrome 中完成登录/);
  assert.match(bothNative,/SamBoat：选择平台后，在这台手机的 Chrome 中完成登录/);
  // Click&Boat is read through its official app: no login button or desktop login.
  for(const page of [text,nativeText,bothNative]){
    assert.match(page,/Click&amp;Boat 使用手机上的官方 App，登录在 App 里完成/);
    assert.doesNotMatch(page,/data-source="clickandboat"|Click&amp;Boat：先选择平台/);
  }
  agent.usesNativeBrowser=()=>false;
  assert.equal(await (await fetch(url+'/',{headers:{Authorization:auth}})).text(),text);
  const script=await (await fetch(url+'/manage.js',{headers:{Authorization:auth}})).text();
  assert.match(script,/请在对应平台的登录页面完成登录/);
  // Exercise the served script, not only a matching phrase in its source.
  const nodes=new Map();
  const getNode=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:''});return nodes.get(id);};
  let state={paired:true,busy:false,enabled:true,sources:{},pending_uploads:0,quarantined_uploads:2,
    local_error:'outbox_corrupt',remote_error:null,private_record:'sensitive-financial-marker'};
  const ui={document:{getElementById:getNode,querySelectorAll:()=>[]},fetch:async()=>({ok:true,json:async()=>state}),setInterval(){},Intl};
  runInNewContext(script,ui);await ui.refresh();
  assert.match(getNode('status').textContent,/隔离待上传记录：2/);
  assert.match(getNode('status').textContent,/本地待上传记录损坏，已保留并隔离，其他平台继续同步，请检查/);
  assert.doesNotMatch(getNode('status').textContent,/sensitive-financial-marker|已修复/);
  state={...state,quarantined_uploads:0,local_error:null};await ui.refresh();
  assert.match(getNode('status').textContent,/隔离待上传记录：0/);
  assert.doesNotMatch(getNode('status').textContent,/本地待上传记录损坏/);
  state={...state,quarantined_uploads:'<img src=x>',local_error:null};await ui.refresh();
  assert.match(getNode('status').textContent,/隔离待上传记录：状态未知/);
  assert.doesNotMatch(getNode('status').textContent,/<img/);
});

test('the first local sync click releases a closed or disconnected login without a preceding status poll',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-http-login-lifecycle-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  let tabClosed=false,runs=0,closeCommands=0;
  const page={isClosed:()=>tabClosed,close:async()=>{closeCommands++;},goto:async()=>{},bringToFront:async()=>{}};
  const browser={connected:true,newPage:async()=>page,disconnect:async()=>{}};
  const agent=await new PhoneAgent({home:temp,config,nativeBrowserFactory:async()=>browser,
    platformUrls:{samboat:'https://example.invalid/'}}).init();
  agent.run=async()=>{runs++;return {ok:true};};
  const server=createManagementServer({agent,config,novncRoot:temp,WebSocketServer});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  t.after(()=>agent.close());
  const endpoint='http://127.0.0.1:'+server.address().port+'/api/run';
  const click=()=>fetch(endpoint,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:'{}'});
  await agent.openLogin('samboat');
  const blocked=await click();assert.equal(blocked.status,409);assert.equal((await blocked.json()).reason,'login_in_progress');assert.equal(runs,0);
  tabClosed=true;
  assert.equal((await click()).status,202);assert.equal(runs,1);assert.equal(closeCommands,0);
  assert.equal(agent.loginSource,null);
  tabClosed=false;await agent.openLogin('samboat');browser.connected=false;
  assert.equal((await click()).status,202);assert.equal(runs,2);assert.equal(closeCommands,0);
  assert.equal(agent.loginSource,null);
});
