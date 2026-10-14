import {FLEET,isoDate} from '../parsers.mjs';
const shift=(d,n)=>new Date(Date.parse(isoDate(d)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function verifiedCalendarResponse(response,expectedUrl){
  if(!response)throw Error('calendar_read_failed');
  let url;try{url=new URL(response.url());}catch{throw Error('calendar_read_failed');}
  if(url.origin!=='https://www.samboat.com'||url.username||url.password)throw Error('target_identity_unverified');
  if(response.status()===401||/^\/(?:[a-z]{2}\/)?login\/?$/.test(url.pathname))throw Error('auth_required');
  if(response.status()!==200||!/^text\/html(?:\s*;|$)/i.test(response.headers()['content-type']||''))throw Error('calendar_read_failed');
  if(url.href!==expectedUrl)throw Error('target_identity_unverified');
}
export function normalizeSamBoat(rows) {
  if(!Array.isArray(rows))throw Error('calendar_schema_changed');
  const seen=new Set();
  return rows.filter(r=>r.unavailability_type!=='anticipation').map(r=>{
    if(!/^\d+$/.test(String(r.id))||r.halfday!==0||r.period_half_day_slot_id||r.half_day_slot_id||
      !['unavailability','reservation'].includes(r.unavailability_type)||!r.start.endsWith(' 00:00:00')||!r.end.endsWith(' 00:00:00'))throw Error('calendar_schema_changed');
    const start=isoDate(r.start.slice(0,10)),end=shift(r.end.slice(0,10),1);
    if(end<=start)throw Error('calendar_schema_changed');
    const id=r.unavailability_type+':'+r.id;if(seen.has(id))throw Error('duplicate_calendar_identity');seen.add(id);
    return {id,start,end,type:r.unavailability_type,...(r.type!=null?{platform_type:r.type}:{}),...(r.reason_type!=null?{reason_type:r.reason_type}:{}),...(r.api_boat?{api_boat:true}:{})};
  });
}
export class SamBoatAdapter {
  // SamBoat can only create and delete records (no date edit, read 2026-10-10).
  // A record of ours that still closes up to a week of needed days may be
  // replaced: deleted and those days closed again at once (release.mjs,
  // executor.mjs). One day until 2026-10-13; the user asked for fewer manual fixes.
  replaceDays=7;
  constructor({openPage,closePage}){Object.assign(this,{openPage,closePage});}
  async read(target) {
    const boat=FLEET.find(b=>b.slug===target.boat&&b.samboat_id===target.listing_id);
    if(!boat)throw Error('mapping_unknown');
    if(!this.page){this.page=await this.openPage('samboat');await this.page.setCacheEnabled(false);}
    const calendarUrl=`https://www.samboat.com/private/announcement/${target.listing_id}/calendar`;
    const response=await this.page.goto(calendarUrl,{waitUntil:'domcontentloaded',timeout:45000});
    verifiedCalendarResponse(response,calendarUrl);
    await this.page.waitForSelector('#bookerpicker',{timeout:20000});
    const info=await this.page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html'),e=d.querySelector('[post-unavailability-url]');if(!e)return null;return {boat:JSON.parse(e.getAttribute(':initial-announcement')),ids:JSON.parse(e.getAttribute(':announcements-ids')),rows:JSON.parse(e.getAttribute(':initial-unavailabilities')),url:e.getAttribute('post-unavailability-url')};},await response.text());
    const url=`https://www.samboat.com/private/announcement/${target.listing_id}/unavailability`;
    if(!info||String(info.boat.id)!==target.listing_id||info.boat.user_id!==700000||info.boat.name!==boat.name.split(' | ')[1]||info.ids.length!==1||String(info.ids[0])!==target.listing_id||info.url!==url)throw Error('target_identity_unverified');
    this.url=url;this.listing=target.listing_id;
    this.before=normalizeSamBoat(info.rows);
    return {identity_verified:true,complete:true,blocks:this.before};
  }
  async prepare(target,gap) {
    if(this.listing!==target.listing_id)throw Error('wrong_listing');
    isoDate(gap.start);isoDate(gap.end);
    const before=this.before,latest=await this.read(target);
    if(before.length!==latest.blocks.length||before.some(b=>!latest.blocks.some(c=>JSON.stringify(b)===JSON.stringify(c))))throw Error('target_changed_during_preparation');
    await this.page.waitForFunction(()=>typeof window.axios==='function',{polling:250,timeout:15000});
  }
  async submit(target,gap,_evidence,{guard}={}) {
    await guard?.({beforeFirstWrite:true});
    const previous=this.before;
    // Use the site's configured HTTP client, including its CSRF/session handling.
    // Never enable overwrite_bookings or call its refusal-confirmation method.
    const result=await this.page.evaluate(async({url,start,end})=>{
      const client=await window.axios();const response=await client.post(url,{start:start+' 00:00:00',end:end+' 00:00:00',type:null,overwrite_bookings:false},{timeout:20000});
      return {have_reservations:!!response.data.have_reservations,rows:response.data.unavailabilities};
    },{url:this.url,start:gap.start,end:shift(gap.end,-1)});
    if(result.have_reservations)throw Error('native_reservation_confirmation_required');
    if(!Array.isArray(result.rows)||result.rows.some(r=>!/^\d+$/.test(String(r.id))))throw Error('created_record_mismatch');
    const ids=result.rows.map(r=>'unavailability:'+r.id);
    if(ids.some(id=>previous.some(r=>r.id===id)))throw Error('created_identity_not_new');
    // The mutation response omits some presentation fields. Canonicalize only
    // after reloading, and tie the new record to IDs actually returned by POST.
    const observed=await this.read(target),created=observed.blocks.filter(r=>ids.includes(r.id));
    if(created.length!==1||created[0].start!==gap.start||created[0].end!==gap.end||created[0].type!=='unavailability')throw Error('created_record_mismatch');
    return created[0];
  }
  async remove(target,owned,{guard}={}) {
    if(this.listing!==target.listing_id||owned.type!=='unavailability'||owned.platform_type!=null||owned.reason_type!=null||owned.api_boat||!/^unavailability:\d+$/.test(owned.id)||!this.before.some(b=>JSON.stringify(b)===JSON.stringify(owned)))
      throw Object.assign(Error('release_identity_mismatch'),{notSubmitted:true});
    await guard?.();
    await this.page.evaluate(async({listing,id})=>{
      const client=await window.axios();
      await client.delete('https://www.samboat.com/private/announcement/'+listing+'/unavailability/'+id+'/delete',{timeout:20000});
    },{listing:target.listing_id,id:owned.id.split(':')[1]});
  }
  async close(){const page=this.page;this.page=null;this.listing=null;if(page)await this.closePage(page);}
}
