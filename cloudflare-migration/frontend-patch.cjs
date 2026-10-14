'use strict';

const vm = require('node:vm');
const crypto = require('node:crypto');

function extractHTML(source) {
  const start = source.indexOf('var HTML = ');
  const end = source.indexOf('var LOGIN_HTML = ', start);
  if (start < 0 || end < 0) throw new Error('Expected original Cloudflare HTML declaration');
  return vm.runInNewContext(source.slice(start, end) + '\nHTML;');
}

const computation = String.raw`function shiftDay(day,offset){const date=new Date(day+'T12:00:00');date.setDate(date.getDate()+offset);return fmt(date);}
function validDate(day){return /^\d{4}-\d{2}-\d{2}$/.test(day||'')&&fmt(new Date(day+'T12:00:00'))===day;}
function confirmed(booking){return ['accepted','deposit_paid'].includes(booking.status)&&validDate(booking.start)&&validDate(booking.end)&&booking.start<booking.end;}
function activeBookings(boat){return (boat.bookings||[]).filter(confirmed);}
function knownOrders(boat){return (boat.bookings||[]).filter(b=>['accepted','deposit_paid','completed'].includes(b.status)&&validDate(b.start)&&validDate(b.end)&&b.start<b.end);}
function orderURL(booking){
 try{const u=new URL(booking.url),pattern=booking.source==='clickandboat'?/^\/uk\/booking\/(\d+)\/detail$/:booking.source==='samboat'?/^\/private\/reservation\/(\d+)$/:null,match=pattern&&u.pathname.match(pattern),host=booking.source==='clickandboat'?'www.clickandboat.com':'www.samboat.com';
  return u.protocol==='https:'&&u.hostname===host&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&match&&match[1]===String(booking.booking_id)?u.href:null;
 }catch{return null;}
}
function sourceURL(boat,source){if(source==='clickandboat'&&Number.isInteger(boat.clickandboat_id)&&boat.clickandboat_id>0)return 'https://www.clickandboat.com/uk/account/listing/edit/'+boat.clickandboat_id+':7';if(source==='samboat'&&Number.isInteger(boat.samboat_id)&&boat.samboat_id>0)return 'https://www.samboat.com/private/announcement/'+boat.samboat_id+'/calendar';return null;}
function orderStatus(b){return b.status==='completed'?'已结束':b.end<fmt(new Date())?'历史已确认':b.status==='deposit_paid'?'已付定金':'已接受';}
function linkedRange(b){const text='<span>'+esc(b.start)+'</span><span>至 '+esc(b.end)+'（退房）</span>',url=orderURL(b);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="打开 '+esc(srcLabel(b.source))+' 订单 '+esc(b.booking_id)+'；需登录平台">'+text+'</a>':text+'<span class="record-type">'+esc(b.link_issue||'详情链接待核实')+'</span>';}
function typeLabel(type){return type==='confirmed'?'订单':type==='not_selectable'?'间隔':'锁日';}
function needsCheck(boat){
 const issues=['boataround','clickandboat','samboat'].filter(src=>{const info=(boat.sources||{})[src];return !info||info.ok!==true||info.stale;}).map(src=>srcLabel(src)+' 数据需核验');
 if(DATA?.booking_mapping_complete===false)issues.push('订单映射不完整');
 if(DATA?.warning)issues.push(DATA.warning);
 return [...new Set(issues)];
}
function knownBlocks(boat){
 const blocks=Object.entries(boat.sources||{}).flatMap(([src,info])=>(info.blocks||[]).filter(b=>validDate(b.start)&&validDate(b.end)&&b.start<=b.end).map(block=>({...block,src,booking:null})));
 for(const booking of activeBookings(boat))blocks.push({start:booking.start,end:shiftDay(booking.end,-1),type:'confirmed',src:booking.source,booking});
 return blocks;
}
function mergedOccupancy(boat){
 const merged=[];for(const block of knownBlocks(boat).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))){const last=merged[merged.length-1];if(last&&block.start<=shiftDay(last.end,1)){if(block.end>last.end)last.end=block.end;}else merged.push({start:block.start,end:block.end});}return merged;
}
function dayStatus(boat,month=months[monthIndex]){
 const map=new Map(),first=fmt(month),last=fmt(new Date(month.getFullYear(),month.getMonth()+1,0));
 for(const block of knownBlocks(boat)){
  const start=block.start>first?block.start:first,end=block.end<last?block.end:last;if(start>end)continue;
  const priority=block.booking?3:block.type==='not_selectable'?1:2,cls=block.booking?'b':block.type==='not_selectable'?'g':'u';
  for(let day=start;day<=end;day=shiftDay(day,1)){if(!map.has(day)||map.get(day).priority<priority)map.set(day,{cls,label:typeLabel(block.type),priority,booking:block.booking});}
 }
 return map;
}
window.checkAvail=function(){
 if(!DATA)return;
 const d1=document.getElementById('d1').value,d2=document.getElementById('d2').value,el=document.getElementById('result');el.hidden=false;
 if(!validDate(d1)||!validDate(d2)||d2<=d1){el.innerHTML='<div class="query-warning">请选择有效的起止日期，退房日需晚于入住日。</div>';return;}
 hasQuery=true;const end=shiftDay(d2,-1),nights=Math.round((Date.parse(d2)-Date.parse(d1))/86400000);
 let freeCount=0,busyCount=0,pendingCount=0;
 const cards=DATA.boats.map(boat=>{
  const uncertain=needsCheck(boat),overlaps=mergedOccupancy(boat).filter(b=>b.start<=end&&b.end>=d1);
  let kind,label,body;
  if(overlaps.length){busyCount++;kind='busy';label='有冲突';
   const orders=activeBookings(boat).filter(b=>b.start<d2&&b.end>d1).sort((a,b)=>a.start.localeCompare(b.start));
   body='<p class="conflict">与 '+overlaps.length+' 段合并占用冲突</p>'+orders.map(b=>'<div class="occLine">'+esc(srcLabel(b.source))+' #'+esc(b.booking_id)+' · '+esc(orderStatus(b))+'<strong>'+linkedRange(b)+'</strong>'+esc(b.amount||'金额待补充')+' · '+esc(b.amount_basis||'金额口径待核实')+'</div>').join('')+overlaps.map(b=>'<div class="occLine">合并占用<strong>'+esc(b.start)+' → '+esc(b.end)+'</strong><span class="freeFrom">该连续占用段结束后：'+esc(dayAfter(b.end))+' 起未被此段占用，后续完整航程仍需重新查询。</span></div>').join('');
  }else if(uncertain.length){pendingCount++;kind='pending';label='待确认';body='<p>未见已知冲突，'+esc(uncertain.join('；'))+'，不能确认全程空闲。</p>';}
  else{freeCount++;kind='free';label='未见冲突';body='<p>'+nights+'晚内按已采集船期未见占用冲突。</p>';}
  if(overlaps.length&&uncertain.length)body+='<p class="pending">'+esc(uncertain.join('；'))+'；空出时间需核验。</p>';
  return '<article class="result-card"><div class="result-name"><strong>'+esc(boat.name)+'</strong><span class="badge '+kind+'">'+label+'</span></div>'+body+'</article>';
 });
 el.innerHTML='<p class="result-heading">'+esc(d1)+' → '+esc(d2)+' · '+freeCount+'/'+DATA.boats.length+' 艘已采集来源未见冲突 · '+busyCount+'艘冲突 · '+pendingCount+'艘待确认</p><div class="result-grid">'+cards.join('')+'</div>';
};
function calendar(boat,month){
 const map=dayStatus(boat,month),lead=(month.getDay()+6)%7,dim=new Date(month.getFullYear(),month.getMonth()+1,0).getDate(),today=fmt(new Date());
 let html='<table class="cal"><caption class="sr-only">'+esc(boat.name)+' '+month.getFullYear()+'年'+(month.getMonth()+1)+'月</caption><thead><tr>'+WD.map(d=>'<th scope="col">'+d+'</th>').join('')+'</tr></thead><tbody><tr>';
 for(let i=0;i<lead;i++)html+='<td></td>';
 for(let day=1;day<=dim;day++){const date=fmt(new Date(month.getFullYear(),month.getMonth(),day)),status=map.get(date),label=status?.label||'未见占用',booking=status?.booking,url=booking&&orderURL(booking),title=booking?srcLabel(booking.source)+' #'+booking.booking_id+' '+booking.start+' → '+booking.end:date+' '+label;
  html+='<td class="'+(status?.cls||'d')+(date===today?' today':'')+'" aria-label="'+esc(date+' '+label+(date===today?' 今天':''))+'" title="'+esc(title)+'"><span>'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" aria-label="'+esc(title)+'">'+day+'</a>':day)+'</span>'+(status?'<span class="day-status">'+({'订单':'订','锁日':'锁','间隔':'隔'}[label])+'</span>':'')+'</td>';if((lead+day)%7===0&&day<dim)html+='</tr><tr>';}
 for(let i=0;i<(7-(lead+dim)%7)%7;i++)html+='<td></td>';
 return html+'</tr></tbody></table>';
}
function renderBoats(){
 const prev=document.getElementById('prevMonth'),next=document.getElementById('nextMonth');prev.disabled=monthIndex===0;next.disabled=monthIndex===14;document.getElementById('monthSelect').value=String(monthIndex);
 if(!DATA)return;
 document.getElementById('boats').innerHTML=DATA.boats.map((boat,index)=>{
  const match=boat.name.match(/^(.*?)\s*\((.*?)\)$/),name=match?match[1]:boat.name,model=match?match[2]:'';
  const tags=['boataround','clickandboat','samboat'].map(src=>{const info=(boat.sources||{})[src],url=sourceURL(boat,src),label=esc(srcLabel(src)),state=!info?'未采集':!info.ok?'未获取':info.stale?'待核验':'已更新';return '<span class="source-tag'+(!info||!info.ok||info.stale?' stale':'')+'">'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="打开平台船期日历；需登录平台">'+label+'</a>':label)+' · '+state+'</span>';}).join('');
  const notes=['boataround','clickandboat','samboat'].flatMap(src=>{const info=(boat.sources||{})[src];return !info||!info.ok||info.stale||info.note?['<p>'+esc(srcLabel(src))+'：'+esc(!info?'未配置采集，需核验该平台船期':info.error||info.note||'使用上次成功数据，待刷新核验')+'</p>']:[];}).join('');
  const today=fmt(new Date()),rows=knownOrders(boat).sort((a,b)=>Number(!(confirmed(a)&&a.end>=today))-Number(!(confirmed(b)&&b.end>=today))||a.start.localeCompare(b.start)||String(a.booking_id).localeCompare(String(b.booking_id))),currentCount=rows.filter(b=>confirmed(b)&&b.end>=today).length;
  const records=rows.length?'<table class="records-table"><thead><tr><th scope="col">平台 / 订单 / 金额</th><th scope="col">入住至退房</th></tr></thead><tbody>'+rows.map(b=>'<tr data-booking-id="'+esc(b.booking_id)+'"><td><span class="record-platform">'+esc(srcLabel(b.source))+' #'+esc(b.booking_id)+'</span><span class="record-type">'+esc(orderStatus(b))+'</span><span class="record-platform">'+esc(b.amount||'金额待补充')+'</span><span class="record-type">'+esc(b.amount_basis||'金额口径待核实')+'</span>'+(b.status==='completed'&&b.end>=today?'<span class="record-platform">平台标记已结束，日期仍在未来，需核验</span>':'')+'</td><td class="record-date">'+linkedRange(b)+'</td></tr>').join('')+'</tbody></table>':'<p class="records-empty">暂无已核验订单。其他占用仅显示在日历，新增订单需更新订单映射。</p>';
  return '<article class="boatSection"><div class="boat-head"><span class="boat-number" aria-hidden="true">'+String(index+1).padStart(2,'0')+'</span><div><h3>'+esc(name)+'</h3>'+(model?'<p class="boat-model">'+esc(model)+'</p>':'')+'</div></div><div class="source-tags">'+tags+'</div>'+calendar(boat,months[monthIndex])+(notes?'<details class="source-notes"><summary>数据状态需核验</summary>'+notes+'</details>':'')+'<details class="records"><summary>已核验订单 · '+currentCount+'笔当前／未来，'+(rows.length-currentCount)+'笔历史／已结束</summary>'+records+'</details></article>';
 }).join('');
}
function render(){const meta=document.getElementById('meta'),today=fmt(new Date()),all=DATA.boats.flatMap(b=>knownOrders(b)),activeCount=all.filter(b=>confirmed(b)&&b.end>=today).length;meta.textContent='数据时间：'+String(DATA.generated_at||'未记录').replace('T',' ').replace('Z',' UTC')+' · '+activeCount+' 笔当前／未来未结束订单'+(DATA.mapping_updated_at?' · 订单核验：'+String(DATA.mapping_updated_at).replace('T',' '):'')+' · 刷新仅更新船期，新增、改期和取消订单需更新映射'+(DATA.warning?' · '+DATA.warning:'');renderBoats();}
`;

function patchFrontend(source) {
  const html = extractHTML(source);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Expected single dashboard script');
  const original = match[1];
  let script = original.slice(0, original.indexOf('function typeLabel(')) + computation + original.slice(original.indexOf('async function loadData('));
  script = script.replace("DATA=data;document.getElementById('queryBtn')", "if(data.schema_version!==2||!Array.isArray(data.boats))throw new Error('请更新服务端订单逻辑后重试');\n  DATA=data;document.getElementById('queryBtn')");
  script = script.replace("}catch(error){meta.textContent=", "}catch(error){if(DATA&&force){for(const boat of DATA.boats)for(const info of Object.values(boat.sources||{}))info.stale=true;renderBoats();if(hasQuery)window.checkAvail();}meta.textContent=");
  const encoded = script.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const htmlStart = source.indexOf('var HTML = '), loginStart = source.indexOf('var LOGIN_HTML = ', htmlStart);
  const section = source.slice(htmlStart, loginStart);
  const start = section.indexOf('<script>') + '<script>'.length;
  const end = section.indexOf('<\\/script>', start);
  if (start < '<script>'.length || end < 0) throw new Error('Cannot locate encoded dashboard script');
  const patchedSection = section.slice(0, start) + encoded + section.slice(end);
  let result = source.slice(0, htmlStart) + patchedSection + source.slice(loginStart);
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  const cspPattern = /("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+(';)/;
  if (!cspPattern.test(result)) throw new Error('Cannot locate dashboard CSP script hash');
  result = result.replace(cspPattern, (_match, prefix, suffix) => prefix + hash + suffix);
  const newHTML = extractHTML(result);
  if (newHTML.replace(script, '') !== html.replace(original, '')) throw new Error('Dashboard markup outside script changed');
  return result;
}

module.exports = { patchFrontend, extractHTML };

if (require.main === module) {
  const fs = require('node:fs');
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node frontend-patch.cjs input.js output.js');
  fs.writeFileSync(output, patchFrontend(fs.readFileSync(input, 'utf8')));
}
