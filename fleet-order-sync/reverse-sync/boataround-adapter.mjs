import {FLEET,isoDate,BOATAROUND_ACCOUNT_ID} from '../parsers.mjs';
import {beforeRequest} from './not-submitted.mjs';
const IDS=['0000000000000000000000b1','0000000000000000000000b2','0000000000000000000000b3','0000000000000000000000b4','0000000000000000000000b5','0000000000000000000000b6','0000000000000000000000b7'];
const shift=(d,n)=>new Date(Date.parse(isoDate(d)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const endpoint=`https://partner-api.boataround.com/v1/charters/${BOATAROUND_ACCOUNT_ID}/availabilities`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function boataroundReadWindow(value) {
  const url=new URL(value);
  if(url.origin+url.pathname!==endpoint||url.hash||url.username||url.password||
     [...url.searchParams.keys()].some(k=>!['from','to','limit'].includes(k))||
     ['from','to','limit'].some(k=>url.searchParams.getAll(k).length!==1)||url.searchParams.get('limit')!=='-1')throw Error('calendar_scope_unverified');
  const start=isoDate(url.searchParams.get('from')),last=isoDate(url.searchParams.get('to'));
  if(last<start)throw Error('calendar_scope_unverified');
  return {start,end:shift(last,1)};
}
export function normalizeBoataround(record) {
  if(record.type!==1||!Array.isArray(record.items))throw Error('target_not_manually_editable');
  const days=new Map();
  for(const item of record.items) {
    isoDate(item.from);isoDate(item.to);
    if(![3,5].includes(item.type)||item.to<item.from||Date.parse(item.to)-Date.parse(item.from)>730*86400000)throw Error('calendar_schema_changed');
    for(let day=item.from;day<=item.to;day=shift(day,1)) {
      if(days.has(day))throw Error('overlapping_calendar_records');
      days.set(day,{id:`${record.boat_id}:${day}`,start:day,end:shift(day,1),type:item.type});
    }
  }
  return [...days.values()].sort((a,b)=>a.start.localeCompare(b.start));
}
export class BoataroundAdapter {
  maxGapDays=1;
  constructor({openPage,closePage,recoverLogin=null}){Object.assign(this,{openPage,closePage,recoverLogin});}
  /** Opens the account calendar. An expired session shows the sign-in route
   * instead; then the saved-password recovery may run once (2026-10-04). */
  async openCalendar() {
    for(let attempt=0;;attempt++) {
      await this.page.goto(`https://partner.boataround.com/en/${BOATAROUND_ACCOUNT_ID}/availability`,{waitUntil:'networkidle2',timeout:45000});
      await this.page.waitForFunction(()=>location.pathname==='/en/login'&&!!document.querySelector('input[type="password"]')||
        document.body.innerText.includes('Tidewyn Marine')&&document.body.innerText.includes('Tidewyn Discovery 2'),{polling:250,timeout:20000});
      if(new URL(this.page.url()).pathname!=='/en/login')return;
      if(attempt||!this.recoverLogin)throw Error('auth_required');
      try{await this.recoverLogin(this.page);}catch{throw Error('auth_required');}
    }
  }
  assertDay(target,range) {
    if(target.boat!==this.target||target.listing_id!==target.boat||
      this.boatId!==IDS[FLEET.findIndex(b=>b.slug===target.boat)]||shift(range.start,1)!==range.end)throw Error('invalid_daily_target');
    if(!this.window||range.start<this.window.start||range.end>this.window.end)throw Error('calendar_scope_unverified');
  }
  async read(target) {
    const index=FLEET.findIndex(b=>b.slug===target.boat&&b.slug===target.listing_id);
    if(index<0)throw Error('mapping_unknown');
    if(!this.page) {
      this.page=await this.openPage('boataround');
      this.page.on('request',request=>{if(request.url().startsWith(endpoint+'?')&&request.method()==='GET'){this.authorization=request.headers().authorization;this.readUrl=request.url();}});
      await this.openCalendar();
    }
    if(!this.authorization||!this.readUrl)throw Error('calendar_auth_unavailable');
    const window=boataroundReadWindow(this.readUrl);
    const data=await this.page.evaluate(async({url,authorization})=>{const r=await fetch(url,{headers:{Authorization:authorization},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});if(r.status!==200||!r.headers.get('content-type')?.includes('application/json'))throw Error('calendar_read_failed');return r.json();},{url:this.readUrl,authorization:this.authorization});
    if(data.count!==7||data.data?.length!==7||!IDS.every(id=>data.data.filter(r=>r.boat_id===id).length===1))throw Error('incomplete_calendar');
    this.boatId=IDS[index];this.target=target.boat;this.window=window;
    this.before=normalizeBoataround(data.data.find(r=>r.boat_id===this.boatId));
    return {identity_verified:true,complete:true,coverage:window,blocks:this.before};
  }
  async prepare(target,gap){
    if(target.boat!==this.target||shift(gap.start,1)!==gap.end)throw Error('invalid_daily_target');
    const before=this.before,latest=await this.read(target);
    if(JSON.stringify(before)!==JSON.stringify(latest.blocks))throw Error('target_changed_during_preparation');
    this.assertDay(target,gap);
    if(latest.blocks.some(b=>b.start<gap.end&&b.end>gap.start))throw Error('target_changed_during_preparation');
  }
  async submit(target,gap,_evidence,{guard}={}) {
    await guard?.({beforeFirstWrite:true});
    await beforeRequest(async()=>{
      this.assertDay(target,gap);
      const before=this.before,latest=await this.read(target);
      this.assertDay(target,gap);
      if(!same(before,latest.blocks)||latest.blocks.some(b=>b.start<gap.end&&b.end>gap.start))throw Error('target_changed_during_preparation');
    });
    await guard?.({beforeFirstWrite:true});
    await this.page.evaluate(async({url,authorization,boatId,day})=>{
      const r=await fetch(url,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({boatId,from:day,to:day}),redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw Error('calendar_write_failed');
    },{url:endpoint,authorization:this.authorization,boatId:this.boatId,day:gap.start});
    // This remains a synthetic daily key. Only the executor's separately
    // persisted, user-authorized managed-generation receipt can allow release.
    return {id:`${this.boatId}:${gap.start}`,start:gap.start,end:gap.end,type:3};
  }
  async remove(target,created,{guard}={}) {
    const latest=await beforeRequest(async()=>{
      this.assertDay(target,created);
      if(created.type!==3||created.id!==`${this.boatId}:${created.start}`)throw Error('boataround_owned_day_changed');
      const before=this.before,latest=await this.read(target);
      this.assertDay(target,created);
      if(!same(before,latest.blocks)||!latest.blocks.some(b=>same(b,created)))throw Error('boataround_owned_day_changed');
      return latest;
    });
    await guard?.();
    await this.page.evaluate(async({url,authorization,boatId,day})=>{
      const r=await fetch(url,{method:'DELETE',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({boatId,from:day,to:day}),redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw Error('calendar_release_failed');
    },{url:endpoint,authorization:this.authorization,boatId:this.boatId,day:created.start});
    const after=await this.read(target);
    this.assertDay(target,created);
    const expected=latest.blocks.filter(b=>b.id!==created.id);
    if(!same(expected,after.blocks))throw Error('release_readback_failed');
  }
  async close(){const page=this.page;this.page=null;this.authorization=null;this.readUrl=null;this.window=null;if(page)await this.closePage(page);}
}
