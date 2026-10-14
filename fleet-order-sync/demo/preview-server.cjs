'use strict';
// Local look-and-feel preview for the notebook theme. Synthetic orders only:
// no real login, cookies, cloud service or platform calls.
//   node fleet-order-sync/demo/preview-server.cjs [port]
// Pick a state with ?scenario=normal|syncing|attention|offline|loading|error
// (it sticks until the next ?scenario=).
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const port=Number(process.argv[2]||8891),entry=path.join(__dirname,'../integrated-source.mjs');
let bundle=null,mtime=0,scenario='normal',runUntil=0;
const scenarios=['normal','syncing','attention','offline','loading','error'];
const RUN_ID='7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e';
function load(){
 const modified=fs.statSync(entry).mtimeMs;if(bundle&&modified===mtime)return bundle;
 const context=vm.createContext({DurableObject:class{},TextEncoder,TextDecoder,Request,Response,Headers,URL,URLSearchParams,structuredClone,crypto:webcrypto,AbortSignal,console,fetch(){throw Error('Real network is disabled in preview');}});
 vm.runInContext(fs.readFileSync(entry,'utf8').replace(/^import\s+[^;]+;\s*/gm,'').replace(/^export\s*\{[\s\S]*?\};\s*$/m,''),context,{timeout:5000});
 bundle=context;mtime=modified;return context;
}
const day=offset=>{const d=new Date(Date.now()+8*3600000);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
const iso=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const SOURCES=['boataround','clickandboat','samboat','mmk','nausys'];
const BOATS=[
 ['Tidewyn Dream (Wavecat 34)','wavecat-34-open-tidewyn-dream',100001,200001,'ADD'],
 ['Tidewyn Discovery (Reef Cat 37)','reef-cat-37-tidewyn-discovery',100002,200002,'AD1'],
 ['Tidewyn Cruise (Harbor 34)','harbor-cruiser-34-tidewyn-cruise',100003,null,'AC1'],
 ['Tidewyn Discovery 2 (Seacat 40)','seacat-open-40-tidewyn-discovery-2',100004,200003,'AD2'],
 ['Tidewyn Discovery 3 (Bluecat 42)','bluecat-42-tidewyn-discovery-3',100005,null,null],
 ['Tidewyn Cruise 2 (Coastline 42DS)','coastline-sea-journey-42-tidewyn-cruise-2',100006,null,'AC2'],
 ['Tidewyn Discovery 5 (Grandcat 55)','grandcat-55-tidewyn-discovery-5',100007,null,'AD5'],
 ['Lightcat 400 S2 | Tidewyn Discovery 6','lightcat-400-s2-tidewyn-discovery-6',null,null,'AD6']];
let serial=880000;
function order(source,start,end,status,amount,extra={}){
 const id=String(++serial),url=source==='samboat'?'https://www.samboat.com/private/reservation/'+id:source==='clickandboat'?'https://www.clickandboat.com/uk/booking/'+id+'/detail':source==='nausys'?'https://app.nausys.com/NauSYS-app/app/yachtReservations.xhtml':source==='mmk'?'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp?reservationId='+id:'https://partner.boataround.com/en/000000000000000000000000/orders/'+id.padStart(24,'a');
 const basis={boataround:'船东净价',clickandboat:'船东净收入',samboat:'租客在线支付金额',mmk:'船东净收入',nausys:'船东净收入'}[source];
 return {source,booking_id:id,start,end,status,amount,amount_basis:basis,url,detail_id:source==='boataround'?id.padStart(24,'a'):id,link_issue:null,platform_status:source==='mmk'||source==='nausys'?'Reservation':source==='boataround'?'CONFIRMED':undefined,verified_at:iso(30),...extra};
}
function fixtureData(){
 serial=880000;const s=scenario;
 const boats=BOATS.map(([name,slug,cb,sb])=>({name,boataround_slug:slug,clickandboat_id:cb,samboat_id:sb,sources:{},bookings:[],blocks:[]}));
 const [dream,ad1,ac1,ad2,ad3,,ad5,lightcat]=boats;
 dream.bookings=[order('boataround',day(3),day(8),'paid','€2,000.00'),order('samboat',day(19),day(19),'paid','$200.00')];
 ad1.bookings=[order('clickandboat',day(-2),day(5),'accepted','€3,000.00'),order('mmk',day(12),day(19),'accepted','€4,000.00'),order('nausys',day(26),day(33),'accepted','€3,500.00',{platform_status:'Option'})];
 ac1.bookings=[order('boataround',day(9),day(14),'deposit_paid','€1,000.00',{platform_status:'NEW'})];
 ad2.bookings=[order('boataround',day(6),day(13),'paid','€3,200.00'),order('samboat',day(12),day(16),'deposit_paid','$1,400.00'),order('clickandboat',day(22),day(29),'accepted','€2,800.00')];
 ad5.bookings=[order('nausys',day(15),day(22),'accepted','€7,000.00',{platform_status:'Option'}),order('boataround',day(30),day(37),'paid','€6,500.00')];
 lightcat.bookings=[];
 if(s!=='attention')ad2.bookings.splice(1,1);
 const platforms=Object.fromEntries(SOURCES.map((source,i)=>[source,{mode:'dynamic',last_success_at:s==='offline'?iso(420):iso(40+i*2),last_checked_at:iso(40+i*2),last_error:s==='attention'&&source==='samboat'?'auth_required':null,record_count:4}]));
 const voltage={last_success_at:iso(300),checked_at:iso(300),next_run_at:iso(-900),devices:BOATS.filter(b=>b[4]).map(([, slug,,,code],i)=>({boat:slug,code,volts:code==='AD1'&&s==='attention'?11.4:12.6+i*0.11,online:true,power:'normal',low_voltage:code==='AD1'&&s==='attention',source_time:'2026-10-13 08:58:00',motion_state:'stationary',stationary_time:(3+i)+'.2天'}))};
 return {schema_version:2,generated_at:iso(40),mapping_updated_at:iso(40),booking_mapping_complete:true,booking_warnings:[],warnings:[],warning:'',boats,order_sync:{agent:{paired:true},automatic_enabled:true,next_attempt_at:iso(-140),platforms,voltage}};
}
function phoneStatus(){
 const running=scenario==='syncing'||Date.now()<runUntil,data=fixtureData();
 const run=running?{id:RUN_ID,state:'running',requested_at:iso(1),completed_at:null,results:{boataround:{outcome:'success',checked_at:iso(0)}}}:{id:RUN_ID,state:'completed',requested_at:iso(45),completed_at:iso(38),results:Object.fromEntries(SOURCES.map(source=>[source,{outcome:scenario==='attention'&&source==='samboat'?'failure':'success',checked_at:iso(39)}]))};
 return {ok:true,mode:'phone',paired:true,online:scenario!=='offline',enabled:true,state:running?'running':'idle',paired_at:iso(9000),requested_run_id:running?RUN_ID:null,manual_run:run,next_run_at:iso(-140),order_sync:{platforms:data.order_sync.platforms}};
}
function holds(){
 const ad3={id:'41eb35db-3142-4ef5-af47-d38106f4fc0d',boat:'bluecat-42-tidewyn-discovery-3',start:'2026-09-23',end:'2027-01-23',active:true,created_at:iso(28000),updated_at:iso(28000),revision:7};
 return {ok:true,version:1,revision:7,holds:[ad3],window_start:day(-30),window_end:day(460)};
}
function reversePlan(){
 const targets=[];
 for(const [, slug,cb,sb] of BOATS)for(const target of SOURCES){
  const lightcat=slug.startsWith('lightcat'),mapped=lightcat?target==='nausys':target==='samboat'?!!sb:target==='clickandboat'?!!cb:target==='mmk'?/discovery(-2|-5)?$|discovery$/.test(slug)&&!slug.includes('discovery-3'):target==='nausys'?/discovery(-2|-5)?$/.test(slug):true;
  const t={boat:slug,target,source_count:mapped?2:0,fresh:true,status:mapped?'ready':'mapping_unknown',segments:[],execution:mapped?{state:'protected',checked_at:iso(30),retained_ranges:[]}:null};
  if(scenario==='attention'&&slug.endsWith('discovery-5')&&target==='clickandboat')t.execution={state:'protected',checked_at:iso(30),retained_ranges:[{start:day(40),end:day(43)}]};
  targets.push(t);
 }
 return {ok:true,mode:'guarded_release',targets,excluded:[]};
}
function send(res,status,body,type='application/json; charset=utf-8',csp){
 const headers={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(csp)headers['Content-Security-Policy']=csp.replace(/;?\s*upgrade-insecure-requests/g,'');
 res.writeHead(status,headers);res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
}
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:'+port),context=load();
  if(scenarios.includes(url.searchParams.get('scenario'))){scenario=url.searchParams.get('scenario');runUntil=0;}
  if(req.method==='GET'&&url.pathname==='/')return send(res,200,context.HTML,'text/html; charset=utf-8',context.PAGE_CSP.dashboard);
  if(req.method==='POST'&&url.pathname==='/api/agent/run'){req.resume();runUntil=Date.now()+12000;return send(res,202,{ok:true,status:'queued',requested_run_id:RUN_ID,requested_at:new Date().toISOString()});}
  if(req.method!=='GET')return send(res,405,{error:'preview_read_only'});
  if(url.pathname==='/api/data'){
   if(scenario==='loading')await new Promise(r=>setTimeout(r,15000));
   if(scenario==='error')return send(res,503,{error:'service_unavailable'});
   return send(res,200,fixtureData());
  }
  if(url.pathname==='/api/agent/status')return send(res,200,phoneStatus());
  if(url.pathname==='/api/reverse-sync/preview')return send(res,200,reversePlan());
  if(url.pathname==='/api/reverse-sync/fleet-holds')return send(res,200,holds());
  if(url.pathname==='/api/reverse-sync/boataround-holds')return send(res,200,{ok:true,version:1,enabled:true,revision:3,holds:[],window_start:day(-30),window_end:day(460)});
  if(url.pathname==='/api/manual-orders')return send(res,200,{ok:true,version:1,revision:1,orders:[],fleet_control:{...holds(),manual_order_ids:[]}});
  if(url.pathname==='/favicon.ico')return send(res,204,'','image/x-icon');
  return send(res,404,{error:'preview_route_only'});
 }catch(error){console.error(error);send(res,500,{error:'preview_failed'});}
}).listen(port,'127.0.0.1',()=>console.log('Notebook theme preview http://localhost:'+port+' (synthetic data, no real services)'));
