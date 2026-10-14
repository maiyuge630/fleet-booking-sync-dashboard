'use strict';
// 手账风看板（2026-10-13）：the theme layer keeps the page's data and checks,
// and the mascot only repeats states the dashboard already has.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const chain=[
 require('./phone-agent-patch.cjs').patchPhoneAgent,require('./booking-conflicts-patch.cjs').patchBookingConflicts,
 require('./manual-reschedule-patch.cjs').patchManualReschedule,require('./voltage-patch.cjs').patchVoltage,
 require('./reverse-sync/frontend-patch.cjs').patchReverse,require('./checkout-day-patch.cjs').patchCheckoutDay,
 require('./manual-unavailability-patch.cjs').patchManualUnavailability,require('./order-query-freshness-patch.cjs').patchOrderQueryFreshness,
 require('./manual-orders-patch.cjs').patchManualOrders,require('./boataround-payment-workflow-patch.cjs').patchBoataroundPaymentWorkflow,
 require('./mmk-orders-patch.cjs').patchMmkOrders,require('./revenue-patch.cjs').patchRevenue];
const {patchNotebookTheme,minifyCSS}=require('./notebook-theme-patch.cjs'),{patchCopyStyle}=require('./copy-style-patch.cjs');
const beforeTheme=chain.reduce((source,patch)=>patch(source),fs.readFileSync(path.join(__dirname,'phone-agent-build/baseline-integrated-source.mjs'),'utf8'));
const final=patchCopyStyle(patchNotebookTheme(beforeTheme)),html=extractHTML(final),plain=extractHTML(patchCopyStyle(beforeTheme));
const readScript=value=>value.match(/<script>([\s\S]*?)<\/script>/)[1],readStyle=value=>value.match(/<style>([\s\S]*?)<\/style>/)[1];
const policy=name=>final.match(new RegExp('"'+name+'":\\s*"([^"\\n]+)"'))[1];
const body=value=>value.slice(value.indexOf('<body>'),value.indexOf('<script>'));

test('the theme is applied once, keeps exact CSP hashes after the copy stage and only the dashboard allows data: images',()=>{
 for(const value of [readScript(html),readStyle(html)])assert.ok(policy('dashboard').includes("'sha256-"+createHash('sha256').update(value).digest('base64')+"'"));
 assert.match(policy('dashboard'),/img-src 'self' data:;/);
 assert.match(policy('login'),/img-src 'self';/);
 assert.throws(()=>patchNotebookTheme(patchNotebookTheme(beforeTheme)),/already applied/);
 assert.ok(final.includes('style-src-attr \'none\''),'inline style attributes stay blocked');
});

test('the sync button moves beside the mascot; the fleet size and platform list are no longer fixed text',()=>{
 const page=body(html);
 assert.equal((page.match(/id="refreshBtn"/g)||[]).length,1);
 assert.match(page,/<div class="mascot-station" id="mascot-station"[^>]*>[\s\S]*<button id="refreshBtn" class="secondary" type="button">立即同步<\/button><\/div><\/div><form class="logout-form"/);
 assert.doesNotMatch(page.slice(page.indexOf('<form class="query-form"'),page.indexOf('</form>',page.indexOf('<form class="query-form"'))),/refreshBtn/);
 assert.ok(!page.includes('7艘船'));
 assert.ok(page.includes('<p id="fleet-size">可查看未来15个月</p>'));
 assert.ok(page.includes('Boataround · Click&amp;Boat · SamBoat · MMK · NauSYS'));
 // Nothing else in the page body changes.
 const strip=value=>body(value).replace(/<div class="mascot-station"[\s\S]*?<\/div><\/div>(?=<form class="logout-form")/,'').replace('<button id="refreshBtn" class="secondary" type="button">立即同步</button>','').replace(/<p>7艘船 · 可查看未来15个月<\/p>|<p id="fleet-size">可查看未来15个月<\/p>/,'').replace(' · MMK · NauSYS','');
 assert.equal(strip(html),strip(plain));
});

test('mascot images are the two small WebP stickers, inlined once each; the theme adds styles only after the old ones',()=>{
 const script=readScript(html),uris=script.match(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g);
 assert.equal(uris.length,2);
 for(const [uri,file] of uris.map((u,i)=>[u,['ui-assets/mascot-idle.webp','ui-assets/mascot-busy.webp'][i]]))assert.equal(Buffer.from(uri.split(',')[1],'base64').compare(fs.readFileSync(path.join(__dirname,file))),0);
 for(const file of ['ui-assets/mascot-idle.webp','ui-assets/mascot-busy.webp']){const b=fs.readFileSync(path.join(__dirname,file));assert.equal(b.toString('latin1',8,12),'WEBP');assert.ok(b.length<24000);}
 const style=readStyle(html),old=readStyle(plain);
 assert.ok(style.startsWith(old));
 assert.ok(!/url\(/.test(style.slice(old.length)),'the theme CSS loads no images or fonts');
 assert.equal(minifyCSS('a { b : c ; }\n/* x */ d{e:f}'),'a{b : c}d{e:f}');
});

// Beijing 2026-09-10 20:00.
class TestDate extends Date{constructor(...args){super(...(args.length?args:['2026-09-10T12:00:00Z']));}static now(){return Date.parse('2026-09-10T12:00:00Z');}}
function page(){
 const nodes=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',dataset:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){},matchMedia:()=>({matches:false})},Date:TestDate,URL,console,setTimeout(){},clearTimeout(){},AbortController,Intl});
 vm.runInContext(readScript(html).replace(/\binitialize\(\);\s*$/,''),context);
 return {context,node:id=>document.getElementById(id),run:code=>vm.runInContext(code,context)};
}
const SOURCES=['boataround','clickandboat','samboat','mmk','nausys'];
const RUN='7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e';
function data({errors={},volts={}}={}){
 const at='2026-09-10T11:20:00.000Z';
 return {schema_version:2,boats:[
  {name:'Tidewyn Discovery 2 (Seacat 40)',boataround_slug:'seacat-open-40-tidewyn-discovery-2',sources:{},bookings:[]},
  {name:'Tidewyn Discovery 5 (Grandcat 55)',boataround_slug:'grandcat-55-tidewyn-discovery-5',sources:{},bookings:[]}],
  order_sync:{agent:{paired:true},automatic_enabled:true,next_attempt_at:'2026-09-10T14:20:00.000Z',
   platforms:Object.fromEntries(SOURCES.map(s=>[s,{mode:'dynamic',last_success_at:at,last_error:errors[s]||null}])),
   voltage:{last_success_at:at,devices:[{boat:'grandcat-55-tidewyn-discovery-5',code:'AD5',volts:11.3,online:true,power:'normal',low_voltage:volts.low===true}]}}};
}
const phone=(extra={})=>({ok:true,mode:'phone',paired:true,online:true,state:'idle',requested_run_id:null,manual_run:null,...extra});
function view(p,{value=data(),status=phone(),failed=false}={}){
 p.context.fixture=value;p.context.status=status;
 p.run('DATA=fixture;PHONE_SYNC_STATUS=status;MASCOT_READ_FAILED='+failed+';renderMascot();');
 return {...p.run('mascotView()'),tone:p.node('mascot-station').dataset.tone,pose:p.node('mascot-station').dataset.pose,title:p.node('mascot-title').textContent,list:p.node('mascot-items').innerHTML};
}

test('orders read normally: the idle sticker says when orders were updated, never that everything is fine',()=>{
 const p=page(),v=view(p);
 assert.equal(v.pose,'idle');assert.equal(v.tone,'calm');assert.equal(v.title,'订单已更新');
 assert.equal(v.detail,'9月10日 19:20 · 下次自动同步 22:20');
 assert.ok(p.node('mascot-image').src.startsWith('data:image/webp;base64,'));
 assert.doesNotMatch(v.title+v.detail,/全部正常|一切正常/);
});

test('the busy pose appears only while the phone run is in progress; a queued run waits idle',()=>{
 const p=page();
 const running=view(p,{status:phone({state:'running',requested_run_id:RUN,manual_run:{id:RUN,state:'running',requested_at:'2026-09-10T11:59:00.000Z',results:{boataround:{outcome:'success',checked_at:'2026-09-10T11:59:30.000Z'}}}})});
 assert.equal(running.pose,'busy');assert.equal(running.title,'正在同步…');assert.equal(running.detail,'已收到 1/5 个平台');
 assert.equal(p.node('mascot-image').dataset.pose,'busy');
 const queued=view(p,{status:phone({requested_run_id:RUN})});
 assert.equal(queued.pose,'idle');assert.equal(queued.title,'同步已排队');
 const scheduled=view(p,{status:phone({state:'running'})});
 assert.equal(scheduled.pose,'busy');assert.equal(scheduled.detail,'手机正在读取各平台订单');
 const done=view(p,{status:phone({manual_run:{id:RUN,state:'completed',requested_at:'2026-09-10T11:00:00.000Z',completed_at:'2026-09-10T11:10:00.000Z',results:Object.fromEntries(SOURCES.map(s=>[s,{outcome:'success',checked_at:'2026-09-10T11:05:00.000Z'}]))}})});
 assert.equal(done.pose,'idle');assert.equal(done.title,'订单已更新');
});

test('problems the dashboard already flags become linked items in a red bubble',()=>{
 const p=page(),value=data({errors:{samboat:'auth_required',mmk:'fetch_failed'},volts:{low:true}});
 value.boats[0].bookings=[
  {source:'boataround',booking_id:'1',start:'2026-09-20',end:'2026-09-27',status:'paid'},
  {source:'samboat',booking_id:'2',start:'2026-09-25',end:'2026-09-29',status:'paid'}];
 p.context.plan={targets:[{boat:'grandcat-55-tidewyn-discovery-5',target:'clickandboat',execution:{retained_ranges:[{start:'2026-10-01',end:'2026-10-03'}]}}]};p.run('REVERSE_PLAN=plan;');
 const v=view(p,{value,status:phone({online:false})});
 assert.equal(v.tone,'alert');assert.equal(v.pose,'idle');assert.equal(v.title,'需要你看 · 6 项');
 assert.deepEqual(Array.from(v.items,i=>i.text),['手机未连接','SamBoat 登录已过期','MMK 订单读取失败','订单日期重叠 1 组','AD5 恢复可预订待核验','AD5 电压过低']);
 assert.deepEqual(Array.from(v.items,i=>i.href),['/sync','#dataIssues','#dataIssues','#booking-conflicts-overview','#release-review-grandcat-55-tidewyn-discovery-5','#voltage-grandcat-55-tidewyn-discovery-5']);
 assert.equal(p.node('mascot-items').hidden,false);
 assert.match(v.list,/<li><a href="#dataIssues">SamBoat 登录已过期<\/a><\/li>/);
});

test('a handover day is not an overlap item; a failed read and a missing first read say so',()=>{
 const p=page(),value=data();
 value.boats[0].bookings=[
  {source:'boataround',booking_id:'1',start:'2026-09-20',end:'2026-09-27',status:'paid'},
  {source:'samboat',booking_id:'2',start:'2026-09-27',end:'2026-09-30',status:'paid'}];
 assert.equal(view(p,{value}).title,'订单已更新');
 const failed=view(p,{failed:true});
 assert.equal(failed.tone,'alert');assert.equal(failed.items[0].text,'最近一次读取失败，下面是上次保存的订单');
 p.run('DATA=null;MASCOT_READ_FAILED=true;ORDER_SYNC_LOADING=false;renderMascot();');
 assert.equal(p.node('mascot-title').textContent,'暂时读不到订单');
 p.run('MASCOT_READ_FAILED=false;renderMascot();');
 assert.equal(p.node('mascot-title').textContent,'正在读取订单…');
});

test('background status reads keep the button label; a manual submit says it is submitting',()=>{
 const p=page();view(p);
 p.run('ORDER_SYNC_LOADING=true;updateSyncButton();');
 assert.equal(p.node('refreshBtn').textContent,'立即同步');assert.equal(p.node('refreshBtn').disabled,true);
 p.run('NOTEBOOK_SUBMITTING=true;updateSyncButton();');
 assert.equal(p.node('refreshBtn').textContent,'正在提交…');
 p.run('NOTEBOOK_SUBMITTING=false;ORDER_SYNC_LOADING=false;updateSyncButton();');
 assert.equal(p.node('refreshBtn').textContent,'立即同步');assert.equal(p.node('refreshBtn').disabled,false);
});

test('a read that fails keeps the old orders and is reported; a call skipped because a read is running is not',async()=>{
 const p=page();view(p);
 p.run("dashboardRequest=async()=>{throw Error('网络连接失败，请刷新状态。已保存订单保留。');};");
 await p.run('ORDER_SYNC_LOADING=true;loadData(false)');
 assert.equal(p.run('MASCOT_READ_FAILED'),false,'skipped call');
 await p.run('ORDER_SYNC_LOADING=false;loadData(false)');
 assert.equal(p.run('MASCOT_READ_FAILED'),true);
 assert.equal(p.node('mascot-title').textContent,'需要你看 · 1 项');
 assert.equal(p.node('refreshBtn').textContent,'立即同步');
});
