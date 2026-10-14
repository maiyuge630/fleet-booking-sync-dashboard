import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';

const HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
function send(response,status,value,type='application/json; charset=utf-8',extra={}) {
  response.writeHead(status,{...HEADERS,'Content-Type':type,...extra});
  response.end(type.startsWith('application/json')?JSON.stringify(value):value);
}
export function authorized(request,config) {
  const provided=request.headers.authorization;
  const expected='Basic '+Buffer.from(config.admin_user+':'+config.admin_password).toString('base64');
  if(typeof provided !== 'string')return false;
  const a=Buffer.from(provided),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function sameLocalOrigin(request) {
  const host=request.headers.host || '';
  if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host))return false;
  return !request.headers.origin || request.headers.origin==='http://'+host;
}
export class Tickets {
  constructor(now=Date.now){this.entries=new Map();this.now=now;}
  issue(origin){for(const [key,value] of this.entries)if(value.expires<this.now())this.entries.delete(key);if(this.entries.size>=10)throw Error('ticket_limit');
    const ticket=randomBytes(32).toString('base64url');this.entries.set(ticket,{origin,expires:this.now()+30000});return ticket;}
  consume(ticket,origin){const entry=this.entries.get(ticket);this.entries.delete(ticket);return !!entry&&entry.expires>=this.now()&&entry.origin===origin;}
}
export async function readBody(request) {
  if((request.headers['content-type']||'').split(';')[0] !== 'application/json')throw Object.assign(Error('json_required'),{status:415});
  const chunks=[];let bytes=0;
  for await(const chunk of request){bytes+=chunk.length;if(bytes>8192)throw Object.assign(Error('body_too_large'),{status:413});chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error('invalid_json'),{status:400});}
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('invalid_json'),{status:400});
  return body;
}

const PAGE=(nativeSamBoat,nativeBoataround=false)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机订单服务器</title><link rel="stylesheet" href="/style.css"><main><p class="brand">TIDEWYN CHARTERS</p><h1>手机订单服务器</h1><p>这台手机负责采集，原订单看板继续在 Cloudflare 上提供。</p><section><h2>连接原订单看板</h2><p>在原看板的同步设置生成一次性配对码，再粘贴到这里。</p><form id="pair"><label>一次性配对码 <input id="code" autocomplete="off" required></label><button>配对</button></form></section><section><h2>平台登录</h2><p>${nativeBoataround?'Boataround：选择平台后，在这台手机的 Chrome 中完成登录。'+(nativeSamBoat?'SamBoat：选择平台后，在这台手机的 Chrome 中完成登录。':'SamBoat：先选择平台，再打开手机桌面完成登录。')+'Click&amp;Boat 使用手机上的官方 App，登录在 App 里完成。':nativeSamBoat?'Boataround：先选择平台，再打开手机桌面完成登录。SamBoat：选择平台后，在这台手机的 Chrome 中完成登录。Click&amp;Boat 使用手机上的官方 App，登录在 App 里完成。':'先选择平台，再打开手机桌面，在里面的浏览器完成登录。Click&amp;Boat 使用手机上的官方 App，登录在 App 里完成。'}登录状态只保存在手机上。</p><div class="actions"><button data-source="boataround">登录 Boataround</button><button data-source="samboat">登录 SamBoat</button><a class="button" href="/desktop" target="_blank" rel="noopener">打开手机桌面</a><button id="finish">我已完成登录</button></div><p>手机桌面没有一分钟限制。完成验证码需要你本人操作。</p></section><section><h2>订单同步</h2><p>自动任务按三小时间隔运行；平台未登录或核验失败时，云端保留上次成功订单。</p><button id="run">立即同步</button><p id="message" role="status"></p><pre id="status">读取状态…</pre></section></main><script src="/manage.js"></script></html>`;
const MANAGE=`const el=id=>document.getElementById(id);const labels={boataround:'Boataround',clickandboat:'Click&Boat',samboat:'SamBoat',mmk:'MMK',nausys:'NauSYS'};
const errors={busy:'已有任务正在运行',login_in_progress:'请先完成当前平台登录',auth_required:'尚未检测到登录成功，请在对应平台的登录页面完成登录',no_login_page:'请先选择一个平台',device_auth_required:'设备配对已失效，请重新配对',invalid_pairing_code:'配对码格式不正确',pairing_failed:'配对失败，请重新生成配对码',operation_failed:'操作未完成，请检查手机运行状态'};
async function call(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const d=await r.json();if(!r.ok||d.ok===false)throw Error(errors[d.error||d.reason]||'操作未完成，请查看状态');return d;}
async function action(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();el('message').textContent='操作已接受。';}catch(e){el('message').textContent=e.message;}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);await refresh();}}
document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>action(()=>call('/api/login',{source:b.dataset.source})));
el('finish').onclick=()=>action(()=>call('/api/finish-login'));el('run').onclick=()=>action(()=>call('/api/run'));
el('pair').onsubmit=e=>{e.preventDefault();action(async()=>{await call('/api/pair',{pairing_code:el('code').value});el('code').value='';});};
const time=t=>t?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(t))+' 北京时间':'尚无';
const states={needs_login:'需要登录',ready:'已登录，待同步',collecting:'核验中',awaiting_upload:'待上传',synced:'同步成功',failed:'核验失败，保留原订单',rejected:'快照未接收',interrupted:'上次任务中断'};
async function refresh(){try{const r=await fetch('/api/status');if(!r.ok)return;const s=await r.json();el('status').textContent=['云端配对：'+(s.paired?'已配对':'未配对'),'任务：'+(s.busy?'正在运行':s.login_source?'正在登录 '+labels[s.login_source]:'空闲'),'自动同步：'+(s.enabled?'已启用':'已暂停'),'下次计划：'+time(s.next_run_at),'最后云端联络：'+time(s.last_contact_at),'等待上传：'+s.pending_uploads,'隔离待上传记录：'+(Number.isSafeInteger(s.quarantined_uploads)&&s.quarantined_uploads>=0?s.quarantined_uploads:'状态未知'),s.local_error==='outbox_corrupt'||Number.isSafeInteger(s.quarantined_uploads)&&s.quarantined_uploads>0?'本地待上传记录损坏，已保留并隔离，其他平台继续同步，请检查。':'',...Object.entries(s.sources).map(([k,v])=>labels[k]+'：'+(states[v.state]||v.state)+'；最近成功 '+time(v.last_success_at)+(v.last_error?'；'+v.last_error:'')),s.remote_error?'云端连接：'+s.remote_error:''].filter(Boolean).join('\\n');}catch{el('message').textContent='手机服务连接中断，请检查连接。';}}refresh();setInterval(refresh,5000);`;
const DESKTOP=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机桌面</title><link rel="stylesheet" href="/style.css"><header><a href="/">返回管理</a><span id="desktop-status">正在连接手机桌面…</span></header><section id="mobile-keyboard" aria-label="桌面文字输入"><div class="mobile-keyboard-actions"><button type="button" id="keyboard-open" disabled>输入文字 / 键盘</button><button type="button" id="keyboard-tab" disabled>下一个输入框 Tab</button><button type="button" id="keyboard-backspace" disabled>退格</button><button type="button" id="keyboard-enter" disabled>回车</button></div><div id="keyboard-panel" hidden><p>先点桌面里要填写的输入框，再在这里输入并发送。不会自动点击登录。</p><label for="keyboard-input">输入内容（默认隐藏）</label><input id="keyboard-input" type="password" inputmode="text" maxlength="256" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" disabled><div class="mobile-keyboard-actions"><label><input id="keyboard-show" type="checkbox" disabled> 显示内容</label><button type="button" id="keyboard-send" disabled>发送到当前输入框</button><button type="button" id="keyboard-close" disabled>关闭键盘</button></div></div><span id="keyboard-message" role="status" aria-live="polite"></span></section><div id="screen"></div><script type="module" src="/desktop.js"></script></html>`;
const DESKTOP_JS=`import RFB from '/novnc/core/rfb.js';import UnicodeKeysym from '/novnc/core/input/keysymdef.js';import KeyTable from '/novnc/core/input/keysym.js';const status=document.getElementById('desktop-status');try{const response=await fetch('/api/vnc-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error();const {ticket,vnc_password}=await response.json();const url=new URL('/vnc-websocket',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);const rfb=new RFB(document.getElementById('screen'),url.href,{credentials:{password:vnc_password}});rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;(function installMobileKeyboard(rfb, prepareText, UnicodeKeysym, KeyTable) {
  document.body.classList.add('fleet-desktop-page');
  const get=id=>document.getElementById(id);
  const field=get('keyboard-input'),panel=get('keyboard-panel'),show=get('keyboard-show'),message=get('keyboard-message');
  const controls=['keyboard-open','keyboard-tab','keyboard-backspace','keyboard-enter','keyboard-send','keyboard-close','keyboard-input','keyboard-show'].map(get);
  let connected=false,sending=false,composing=false;
  const update=()=>{for(const control of controls)control.disabled=!connected||sending;get('keyboard-send').disabled=!connected||sending||composing;};
  const clear=()=>{field.value='';field.type='password';show.checked=false;};
  rfb.addEventListener('connect',()=>{connected=true;message.textContent='';update();});
  rfb.addEventListener('disconnect',()=>{connected=false;clear();field.blur();panel.hidden=true;message.textContent='连接已断开，未发送内容已清空。';update();});
  get('keyboard-open').addEventListener('click',()=>{
    if(!connected||sending)return;
    panel.hidden=false;
    // This synchronous focus follows a genuine tap on a real local input and
    // can summon Android's keyboard; focusing the RFB canvas cannot do that.
    field.focus({preventScroll:true});
  });
  get('keyboard-close').addEventListener('click',()=>{clear();field.blur();panel.hidden=true;message.textContent='';});
  show.addEventListener('change',()=>{field.type=show.checked?'text':'password';field.focus({preventScroll:true});});
  field.addEventListener('compositionstart',()=>{composing=true;update();});
  field.addEventListener('compositionend',()=>{composing=false;update();});
  // Do not treat the phone keyboard's Enter/Done as a remote login submit.
  field.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter')event.preventDefault();});
  field.addEventListener('keyup',event=>event.stopPropagation());
  get('keyboard-send').addEventListener('click',async()=>{
    if(!connected||sending||composing)return;
    let keys;
    try{keys=prepareText(field.value,codepoint=>UnicodeKeysym.lookup(codepoint));}
    catch{message.textContent='请输入 1–256 个字符；换行等控制字符请使用单独按钮。';return;}
    sending=true;update();message.textContent='正在发送…';
    try{
      for(const keysym of keys){
        if(!connected)throw Error('disconnected');
        rfb.sendKey(keysym,null);
        await new Promise(resolve=>setTimeout(resolve,8));
      }
      clear();message.textContent='已提交到桌面当前输入框，请查看桌面确认。';
    }catch{clear();message.textContent='连接已中断，请检查桌面中已输入的内容后再重试。';}
    finally{keys=null;sending=false;update();}
  });
  for(const [id,keysym,code] of [
    ['keyboard-tab',KeyTable.XK_Tab,'Tab'],
    ['keyboard-backspace',KeyTable.XK_BackSpace,'Backspace'],
    ['keyboard-enter',KeyTable.XK_Return,'Enter']
  ])get(id).addEventListener('click',()=>{
    if(!connected||sending||composing)return;
    rfb.sendKey(keysym,code);
  });
  window.addEventListener('pagehide',clear);
  update();
})(rfb,(function prepareMobileText(text, lookup) {
  if(typeof text!=='string')throw Error('invalid_text');
  const characters=Array.from(text);
  if(!characters.length)throw Error('empty_text');
  if(characters.length>256)throw Error('too_long');
  const result=[];
  for(const character of characters){
    const codepoint=character.codePointAt(0);
    // Tab, Return and Backspace have separate deliberate controls. Do not let
    // pasted control characters submit a form or change the selected field.
    if(codepoint<32||codepoint===127||(codepoint>=0xd800&&codepoint<=0xdfff))throw Error('unsupported_character');
    result.push(lookup(codepoint));
  }
  return result;
}),UnicodeKeysym,KeyTable);rfb.addEventListener('credentialsrequired',()=>rfb.sendCredentials({password:vnc_password}));rfb.addEventListener('connect',()=>status.textContent='已连接 · 在此浏览器中登录平台');rfb.addEventListener('disconnect',()=>status.textContent='桌面已断开；刷新本页重新连接');}catch{status.textContent='桌面连接失败，请确认手机桌面服务正在运行，然后刷新本页。';}`;
const CSS=`body.fleet-desktop-page{height:100dvh;display:flex;flex-direction:column;overflow:hidden}.fleet-desktop-page header{flex:none;gap:12px;flex-wrap:wrap}.fleet-desktop-page #screen{flex:1;min-height:0;height:auto}.fleet-desktop-page #mobile-keyboard{flex:none;background:#fff;margin:0;padding:8px 12px;border:0;border-top:1px solid #bdcdd6;border-radius:0;font-size:14px}.mobile-keyboard-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.mobile-keyboard-actions button{min-height:44px;padding:8px 12px;font-size:14px}.mobile-keyboard-actions label{display:flex;align-items:center;gap:6px}#keyboard-panel p{margin:6px 0}#keyboard-input{display:block;width:100%;min-height:44px;margin:4px 0 8px;font-size:16px}#keyboard-message{display:block;color:#526773;min-height:1em}#keyboard-panel[hidden]{display:none}body{margin:0;background:#eff5f6;color:#213943;font:16px/1.6 system-ui}main{max-width:960px;margin:auto;padding:24px}h1{margin:0 0 16px}h2{font-size:20px}section{background:white;border:1px solid #bdcdd6;border-radius:16px;padding:22px;margin:20px 0}.brand{color:#176674;letter-spacing:2px;font-weight:700}.actions{display:flex;gap:10px;flex-wrap:wrap}button,.button{display:inline-block;background:#176674;color:white;border:0;border-radius:8px;padding:12px 16px;cursor:pointer;font:inherit;text-decoration:none}input{padding:10px;font:inherit;border:1px solid #829aa6;border-radius:8px;max-width:100%;box-sizing:border-box}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 system-ui}header{padding:8px 16px;display:flex;gap:24px;background:white}#screen{width:100vw;height:calc(100vh - 44px);background:#222}a{color:#176674}`;

export function createManagementServer({agent,config,novncRoot,WebSocketServer,now=Date.now}) {
  const tickets=new Tickets(now);
  let clients=0;
  const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false});
  const server=http.createServer(async(request,response)=>{
    try {
      if(!sameLocalOrigin(request))return send(response,403,{error:'origin_rejected'});
      const url=new URL(request.url,'http://'+request.headers.host);
      if(url.pathname==='/health'&&request.method==='GET')return send(response,200,{ok:true,service:'tidewyn-phone-server'});
      if(!authorized(request,config))return send(response,401,{error:'authentication_required'},undefined,{'WWW-Authenticate':'Basic realm="Phone server", charset="UTF-8"'});
      if(request.method==='GET') {
        if(url.pathname==='/')return send(response,200,PAGE(agent.usesNativeBrowser?.('samboat')===true,agent.usesNativeBrowser?.('boataround')===true),'text/html; charset=utf-8');
        if(url.pathname==='/manage.js')return send(response,200,MANAGE,'text/javascript; charset=utf-8');
        if(url.pathname==='/desktop')return send(response,200,DESKTOP,'text/html; charset=utf-8');
        if(url.pathname==='/desktop.js')return send(response,200,DESKTOP_JS,'text/javascript; charset=utf-8');
        if(url.pathname==='/style.css')return send(response,200,CSS,'text/css; charset=utf-8');
        if(url.pathname==='/api/status')return send(response,200,await agent.status());
        if(url.pathname.startsWith('/novnc/')) {
          let relative;try{relative=decodeURIComponent(url.pathname.slice(7));}catch{return send(response,400,{error:'invalid_path'});}
          if(relative.includes('\\')||relative.includes('\0'))return send(response,400,{error:'invalid_path'});
          const base=await fs.realpath(novncRoot),candidate=path.resolve(base,relative);
          if(!candidate.startsWith(base+path.sep)||!['.js','.css','.png','.svg'].includes(path.extname(candidate)))return send(response,404,{error:'not_found'});
          let resolved;try{resolved=await fs.realpath(candidate);}catch{return send(response,404,{error:'not_found'});}
          if(!resolved.startsWith(base+path.sep))return send(response,404,{error:'not_found'});
          const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
          return send(response,200,await fs.readFile(resolved),types[path.extname(resolved)]);
        }
      }
      if(request.method!=='POST')return send(response,404,{error:'not_found'});
      const body=await readBody(request);
      if(url.pathname==='/api/vnc-ticket')return send(response,200,{ticket:tickets.issue('http://'+request.headers.host),vnc_password:config.vnc_password});
      if(url.pathname==='/api/pair')return send(response,200,await agent.pair(body.pairing_code));
      if(url.pathname==='/api/login')return send(response,200,await agent.openLogin(body.source));
      if(url.pathname==='/api/finish-login')return send(response,200,await agent.finishLogin());
      if(url.pathname==='/api/run') {
        if(agent.closed)return send(response,503,{ok:false,reason:'closed'});
        agent.refreshLoginSession();
        if(agent.busy||agent.polling||agent.loginSource)return send(response,409,{ok:false,reason:agent.loginSource?'login_in_progress':'busy'});
        void agent.run().catch(()=>{});return send(response,202,{ok:true,status:'started'});
      }
      return send(response,404,{error:'not_found'});
    } catch(error) {
      const codes=new Set(['busy','unknown_source','auth_required','no_login_page','invalid_pairing_code','pairing_failed','device_auth_required']);
      const code=codes.has(error.code)?error.code:'operation_failed';
      if(!response.headersSent)send(response,error.status||(code==='busy'?409:400),{ok:false,error:code});else response.end();
    }
  });
  server.on('upgrade',(request,socket,head)=>{
    try {
      const url=new URL(request.url,'http://'+request.headers.host);
      if(!sameLocalOrigin(request)||!request.headers.origin||!authorized(request,config)||url.pathname!=='/vnc-websocket'||clients>=2||!tickets.consume(url.searchParams.get('ticket'),request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
      }
      wss.handleUpgrade(request,socket,head,ws=>{
        clients++;
        const upstream=net.connect({host:'127.0.0.1',port:5901});
        let closed=false;
        const finish=()=>{if(closed)return;closed=true;clients--;upstream.destroy();ws.close();};
        upstream.on('data',data=>{if(ws.readyState===1)ws.send(data,{binary:true});});
        upstream.on('error',finish);upstream.on('close',finish);
        ws.on('message',data=>{if(upstream.writable)upstream.write(data);});
        ws.on('error',finish);ws.on('close',finish);
      });
    }catch{socket.destroy();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
