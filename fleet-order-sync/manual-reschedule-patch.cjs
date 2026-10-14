'use strict';

const {createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');

// This projection only presents the single reschedule explicitly authorized by
// the owner. It does not create a payment claim or alter source observations.
const normalization=String.raw`
function normalizeManualReschedule(source,record) {
  const value=record.manual_adjustment;
  if(value===undefined||value===null)return null;
  if(source!=='clickandboat'||String(record.booking_id)!=='1000000'||record.start!=='2027-03-06'||record.end!=='2027-03-13'||!value||typeof value!=='object'||Array.isArray(value)||value.kind!=='reschedule'||value.original_start!=='2026-03-14'||value.original_end!=='2026-03-21')throw new Error('人工改期记录不符合已授权订单');
  const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
  const statuses=['awaiting_observation','verified','needs_review','cancelled'],reasons=['observation_missing','source_sync_failed','platform_dates_changed','platform_boat_changed','platform_status_changed'];
  if(!iso(value.recorded_at)||!statuses.includes(value.verification_status)||value.verification_status==='cancelled'||value.review_reason!==null&&!reasons.includes(value.review_reason))throw new Error('人工改期核验状态无效');
  for(const field of ['last_verified_at','cancelled_at'])if(value[field]!==null&&!iso(value[field]))throw new Error('人工改期核验时间无效');
  if(value.cancelled_at!==null)throw new Error('已取消的人工改期不能计入有效订单');
  for(const field of ['platform_start','platform_end'])if(value[field]!==null&&!validDay(value[field]))throw new Error('人工改期平台日期无效');
  if(value.platform_status!==null&&(typeof value.platform_status!=='string'||!value.platform_status||value.platform_status.length>100))throw new Error('人工改期平台状态无效');
  if(value.platform_boat!==null&&(typeof value.platform_boat!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.platform_boat)||value.platform_boat.length>150))throw new Error('人工改期平台船只无效');
  const payment=value.payment_evidence,url='https://www.clickandboat.com/uk/booking/1000000/detail';
  if(!payment||typeof payment!=='object'||Array.isArray(payment)||payment.kind!=='owner_settlement'||payment.amount!==4200||payment.currency!=='EUR'||payment.paid_on!=='2026-03-16'||payment.detail_url!==url||record.url!==url)throw new Error('人工改期原订单结算依据无效');
  return {kind:'reschedule',original_start:value.original_start,original_end:value.original_end,recorded_at:value.recorded_at,verification_status:value.verification_status,review_reason:value.review_reason,platform_status:value.platform_status,platform_start:value.platform_start,platform_end:value.platform_end,platform_boat:value.platform_boat,last_verified_at:value.last_verified_at,cancelled_at:value.cancelled_at,payment_evidence:{kind:'owner_settlement',amount:4200,currency:'EUR',paid_on:'2026-03-16',detail_url:url}};
}
`;

const presentation=String.raw`
function manualRescheduleNote(booking){
 const adjustment=booking.manual_adjustment;if(!adjustment)return '';
 const reasons={observation_missing:'尚未取得本轮平台记录',source_sync_failed:'平台同步暂未成功',platform_dates_changed:'平台日期已有变化',platform_boat_changed:'平台船只已有变化',platform_status_changed:'平台状态已有变化'};
 const pending=adjustment.verification_status==='awaiting_observation'||adjustment.verification_status==='needs_review';
 const reason=reasons[adjustment.review_reason]||'尚待核对平台记录';
 const observed=adjustment.platform_start&&adjustment.platform_end?'；平台当前日期：'+adjustment.platform_start+' → '+adjustment.platform_end:'';
 return '<aside class="manual-reschedule-note" aria-label="人工改期说明"><strong class="manual-reschedule-badge">人工改期</strong><p>原航程：'+esc(adjustment.original_start)+' → '+esc(adjustment.original_end)+'</p><p>原订单船东款已结算 · '+esc(adjustment.payment_evidence.paid_on)+'；本次改期沿用该笔结算款。</p>'+(pending?'<p class="manual-reschedule-review"><strong>待核对</strong>：'+esc(reason+observed)+'。当前保留人工改期日期，请核对原平台订单。</p>':'')+'</aside>';
}
function manualRescheduleAmountBasis(booking){return booking.manual_adjustment?'原订单已结算 · 船东净收入':booking.amount_basis||'金额口径待核实';}
`;

const styles=String.raw`
.manual-reschedule-note{margin:12px 0 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--text);font-size:.75rem;line-height:1.65;overflow-wrap:anywhere;min-width:0}
.manual-reschedule-note p{margin:6px 0 0;color:inherit}.manual-reschedule-badge{display:inline-block;font-size:.75rem;font-weight:750;color:inherit}
.manual-reschedule-note .manual-reschedule-review{border-left:3px solid var(--conflict-border);padding:8px 10px;background:var(--conflict-panel);color:var(--conflict-text);border-radius:4px}
.boat-booking-conflict .manual-reschedule-note{background:var(--conflict-soft);color:var(--conflict-text);border-color:var(--conflict-divider)}
`;

function patchManualReschedule(source){
 const html=extractHTML(source),originalScript=html.match(/<script>([\s\S]*?)<\/script>/)?.[1],originalStyle=html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
 if(!originalScript?.includes('function bookingConflictNotice(')||!originalStyle||source.includes('function normalizeManualReschedule('))throw Error('Expected conflict-enabled dashboard without manual reschedule presentation');
 let script=originalScript;
 function replaceScript(from,to){if(script.split(from).length!==2)throw Error('Manual reschedule script anchor changed: '+from.slice(0,100));script=script.replace(from,()=>to);}
 replaceScript('function renderBoats(){',presentation+'\nfunction renderBoats(){');
 replaceScript("esc(b.end)+'</strong></span></div><div class=\"boat-booking-bottom\">", "esc(b.end)+'</strong></span></div>'+manualRescheduleNote(b)+'<div class=\"boat-booking-bottom\">");
 replaceScript("esc(b.amount_basis||'金额口径待核实')+'</small></div>'+action", "esc(manualRescheduleAmountBasis(b))+'</small></div>'+action");
 const style=originalStyle+styles,nextHTML=html.replace(originalScript,()=>script).replace(originalStyle,()=>style);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);
 let result=source.slice(0,start)+'var HTML = '+JSON.stringify(nextHTML)+';\n'+source.slice(end);
 function replaceSource(from,to){if(result.split(from).length!==2)throw Error('Manual reschedule source anchor changed: '+from.slice(0,100));result=result.replace(from,()=>to);}
 replaceSource('function normalizeBooking(source, record) {',normalization+'\nfunction normalizeBooking(source, record) {');
 const normalizerStart=result.indexOf('function normalizeBooking(source, record) {'),normalizerEnd=result.indexOf('\n}',normalizerStart)+2;
 const oldNormalizer=result.slice(normalizerStart,normalizerEnd),returnAnchor='  return booking;';
 if(oldNormalizer.split(returnAnchor).length!==2)throw Error('Manual reschedule normalizer return anchor changed');
 result=result.slice(0,normalizerStart)+oldNormalizer.replace(returnAnchor,'  const manual = normalizeManualReschedule(source, record);\n  if (manual) booking.manual_adjustment = manual;\n'+returnAnchor)+result.slice(normalizerEnd);
 replaceSource('        const booking = normalizeBooking(record.source, record);','        const booking = normalizeBooking(record.source, record);\n        if (booking.manual_adjustment && boat.boataround_slug !== \'seacat-open-40-tidewyn-discovery-2\') throw new Error(\'人工改期船只与原订单不符\');');
 replaceSource('        const slug = matches[0].boataround_slug;','        const slug = matches[0].boataround_slug;\n        if (booking.manual_adjustment && slug !== \'seacat-open-40-tidewyn-discovery-2\') throw new Error(\'人工改期船只与原订单不符\');');
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Manual reschedule dashboard CSP anchor changed');
 result=result.replace(csp,(_match,prefix,middle,suffix)=>prefix+createHash('sha256').update(script).digest('base64')+middle+createHash('sha256').update(style).digest('base64')+suffix);
 if(extractHTML(result)!==nextHTML)throw Error('Manual reschedule dashboard serialization changed');
 return result;
}

module.exports={patchManualReschedule};
