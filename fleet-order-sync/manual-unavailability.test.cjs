const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const source=fs.readFileSync(__dirname+'/integrated-source.mjs','utf8'),html=extractHTML(source),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function page(){
 const nodes=new Map(),document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,value:'',addEventListener(){}});return nodes.get(id);},querySelectorAll(){return [];},addEventListener(){}};
 const ctx=vm.createContext({document,window:{addEventListener(){}},URL,Date,setTimeout(){},clearTimeout(){},AbortController,console});
 vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),ctx);
 ctx.fixture={name:'Tidewyn Cruise 2',boataround_slug:'coastline-sea-journey-42-tidewyn-cruise-2',bookings:[],sources:{}};
 vm.runInContext('DATA={boats:[fixture]};',ctx);return {ctx,document};
}
test('AC2 every day unavailable including leap day and final day, not before/after bounds',()=>{
 const {ctx}=page();for(let y=2026;y<=2031;y++)for(let m=0;m<12;m++){
  const days=ctx.dayStatus(ctx.fixture,new Date(y,m,1));
  for(let d=1;d<=new Date(y,m+1,0).getDate();d++){
   const date=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
   assert.equal(days.has(date),date>='2026-09-19'&&date<='2030-12-31',date);
  }
 }
 assert.equal(ctx.activeBookings(ctx.fixture).length,0);
 assert.equal(ctx.dayStatus({...ctx.fixture,boataround_slug:'other'},new Date(2027,0,1)).size,0);
});
test('query and calendar distinguish manual stop from paid orders and survive snapshot replacement',()=>{
 const {ctx,document}=page();
 for(let n=0;n<3;n++){
  vm.runInContext('DATA={boats:[JSON.parse(JSON.stringify(fixture))]};',ctx);
  document.getElementById('d1').value='2030-12-30';document.getElementById('d2').value='2030-12-31';ctx.window.checkAvail();
  assert.match(document.getElementById('result').innerHTML,/手动停用/);assert.match(document.getElementById('result').innerHTML,/0\/1 艘可预订/);
 }
 const cal=ctx.calendar(ctx.fixture,new Date(2027,0,1));assert.match(cal,/day-status">停/);assert.doesNotMatch(cal,/day-status">订/);
 document.getElementById('d1').value='2031-01-01';document.getElementById('d2').value='2031-01-02';ctx.window.checkAvail();assert.match(document.getElementById('result').innerHTML,/1\/1 艘可预订/);
 assert.ok(source.includes(createHash('sha256').update(script).digest('base64')));
});
