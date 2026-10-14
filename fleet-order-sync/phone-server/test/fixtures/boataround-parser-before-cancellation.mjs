/** Pure parsers for fields observed in the authorized platform UI and native exports.
 * No network, browser/session access, filesystem operations, or credential handling.
 */

export class OrderParseError extends Error {
  constructor(code, message) { super(message); this.name='OrderParseError'; this.code=code; }
}
const fail=(code,message)=>{throw new OrderParseError(code,message);};
const compact=value=>String(value??'').replace(/[\u00a0\u202f]/g,' ').replace(/[ \t]+/g,' ').trim();
const upper=value=>compact(value).toUpperCase();
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
export const BOATAROUND_ACCOUNT_ID='000000000000000000000000';
export const FLEET=Object.freeze([
  {name:'Wavecat 34 Open | Tidewyn Dream',slug:'wavecat-34-open-tidewyn-dream',clickandboat_id:'100001',samboat_id:'200001'},
  {name:'Reef Cat 37 | Tidewyn Discovery',slug:'reef-cat-37-tidewyn-discovery',clickandboat_id:'100002',samboat_id:'200002'},
  {name:'Harbor Cruiser 34 | Tidewyn Cruise',slug:'harbor-cruiser-34-tidewyn-cruise',clickandboat_id:'100003',samboat_id:null},
  {name:'Seacat Open 40 | Tidewyn Discovery 2',slug:'seacat-open-40-tidewyn-discovery-2',clickandboat_id:'100004',samboat_id:'200003'},
  {name:'Bluecat 42 | Tidewyn Discovery 3',slug:'bluecat-42-tidewyn-discovery-3',clickandboat_id:'100005',samboat_id:null},
  {name:'Coastline Sea Journey 42 | Tidewyn Cruise 2',slug:'coastline-sea-journey-42-tidewyn-cruise-2',clickandboat_id:'100006',samboat_id:null},
  {name:'Grandcat 55 | Tidewyn Discovery 5',slug:'grandcat-55-tidewyn-discovery-5',clickandboat_id:'100007',samboat_id:null}
]);

export function isoDate(value){
 const day=compact(value),match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
 if(!match)fail('DATE_FORMAT','Expected an explicit YYYY-MM-DD date');
 const date=new Date(day+'T12:00:00Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)fail('DATE_VALUE','Invalid calendar date');
 return day;
}
const MONTHS={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
export function englishDate(value){
 const text=compact(value),match=/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
 if(!match||!own(MONTHS,match[2].toLowerCase()))fail('DATE_FORMAT','Expected day, English month, and explicit year');
 return isoDate(match[3]+'-'+String(MONTHS[match[2].toLowerCase()]).padStart(2,'0')+'-'+match[1].padStart(2,'0'));
}
export function dateRange(start,end){const range={start:isoDate(start),end:isoDate(end)};if(range.end<=range.start)fail('DATE_ORDER','Checkout must be after check-in');return range;}
export function englishDateRange(value){
 const text=compact(value),match=/^(\d{1,2} [A-Za-z]+ \d{4})\s*[-–—→]\s*(\d{1,2} [A-Za-z]+ \d{4})$/.exec(text);
 if(!match)fail('DATE_RANGE_FORMAT','Expected two complete English dates');
 return dateRange(englishDate(match[1]),englishDate(match[2]));
}
export function verifiedTimestamp(value){const text=String(value??'');if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)||!Number.isFinite(Date.parse(text)))fail('VERIFIED_AT','Verification time must be an ISO timestamp with explicit timezone');return new Date(text).toISOString();}

/** Observed English-locale currency notation only; ambiguous locale formats fail. */
export function money(value,{currency=null,allowZero=true}={}){
 let text=compact(value),found=null;
 for(const [symbol,code] of [['€','EUR'],['$','USD']])if(text.includes(symbol)){if(found||text.split(symbol).length!==2)fail('MONEY_CURRENCY','Ambiguous currency');found=code;text=text.replace(symbol,'').trim();}
 if(found&&currency&&found!==currency)fail('MONEY_CURRENCY','Currency differs from expected currency');
 const code=found||currency;if(!['EUR','USD'].includes(code))fail('MONEY_CURRENCY','Explicit supported currency is required');
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))fail('MONEY_FORMAT','Unsupported or ambiguous amount format');
 const [whole,fraction='']=text.replaceAll(',','').split('.'),minor=Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));
 if(!Number.isSafeInteger(minor)||minor<0||(!allowZero&&minor===0))fail('MONEY_VALUE','Invalid amount');
 const amount=(minor/100).toFixed(2),display=(code==='EUR'?'€':'$')+Number(amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 return {currency:code,minor_units:minor,amount,display};
}

export function boataroundStatus(bookingStatus,customerPayment){
 const state=upper(bookingStatus);
 if(['CANCELLED','CANCELED'].includes(state))return 'cancelled';
 if(state==='COMPLETED')return 'completed';
 if(state!=='CONFIRMED')fail('BOOKING_STATUS','Unrecognized Boataround booking status');
 const payment=upper(customerPayment);
 if(payment==='PARTIALLY PAID')return 'deposit_paid';
 if(payment==='PAID')return 'paid';
 if(payment==='NOT PAID')return 'pending';
 fail('PAYMENT_STATUS','Confirmed Boataround order needs an explicit customer payment status');
}
export function boataroundIdentity({bookingId,url,detailId=null,accountId=BOATAROUND_ACCOUNT_ID}){
 const booking_id=compact(bookingId).replace(/^#/,'');
 if(!/^\d+$/.test(booking_id)||!/^[a-f0-9]{24}$/.test(accountId))fail('ORDER_ID','Invalid booking or account identifier');
 const prefix='https://partner.boataround.com/en/'+accountId+'/orders/',text=String(url??'');
 if(!text.startsWith(prefix))fail('ORDER_URL','Boataround detail URL has an unexpected host, account, or path');
 const detail_id=text.slice(prefix.length);
 if(!/^[a-f0-9]{24}$/.test(detail_id)||(detailId!==null&&detailId!==detail_id))fail('ORDER_URL','Boataround detail ID is invalid or mismatched');
 return {booking_id,detail_id,url:text};
}
export function boataroundBoat(name){const normalized=upper(name),matches=FLEET.filter(boat=>upper(boat.name)===normalized);if(matches.length!==1)fail('BOAT_MATCH','Boataround boat name does not uniquely match the verified fleet');return matches[0].slug;}

/** Consume saved verification fields, or fields extracted using visible DOM labels. */
export function normalizeBoataroundRecord(record,{verifiedAt,accountId=BOATAROUND_ACCOUNT_ID}={}){
 const identity=boataroundIdentity({bookingId:record.id??record.booking_id,url:record.url,detailId:record.detail_id??null,accountId});
 const range=dateRange(record.start,record.end),status=boataroundStatus(record.booking_status??record.platform_status,record.customer_payment),active=['paid','deposit_paid'].includes(status);
 const output={source:'boataround',...identity,boataround_slug:boataroundBoat(record.boat_name),...range,status,platform_status:upper(record.booking_status??record.platform_status),verified_at:verifiedTimestamp(verifiedAt??record.verified_at),verification_source:'已登录 Boataround 订单详情可见字段；Customer payment 判断客户付款；Agency price 为船东净价'};
 if(record.customer_payment)output.customer_payment=upper(record.customer_payment);
 if(record.agency_payment)output.agency_payment=upper(record.agency_payment);
 if(record.agency_price!=null){output.amount=money(record.agency_price,{currency:'EUR',allowZero:!active}).display;output.amount_basis='船东净价';}else if(active)fail('MONEY_MISSING','Paid Boataround order is missing Agency price');
 if(record.client_price!=null)output.client_amount=money(record.client_price,{currency:'EUR'}).display;
 return output;
}

function labelValues(bodyText,label){
 const lines=String(bodyText??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean),escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp('^'+escaped+'(?:\\s*[:\\t]\\s*(.*))?$','i'),values=[];
 for(let index=0;index<lines.length;index++){const match=pattern.exec(lines[index]);if(match)values.push(compact(match[1]||lines[index+1]||''));}
 return [...new Set(values.filter(Boolean))];
}
function requiredLabel(bodyText,label){const values=labelValues(bodyText,label);if(values.length!==1)fail(values.length?'AMBIGUOUS_LABEL':'MISSING_LABEL','Expected one unambiguous '+label+' field');return values[0];}
function optionalLabel(bodyText,label){const values=labelValues(bodyText,label);if(values.length>1)fail('AMBIGUOUS_LABEL','Conflicting '+label+' fields');return values[0]??null;}

/** Actual BA bodyText uses a #ID - boat heading and newline/tab-separated labels. */
export function parseBoataroundDetail({bodyText,url,verifiedAt,accountId=BOATAROUND_ACCOUNT_ID}){
 const text=String(bodyText??''),headings=[...text.matchAll(/^#(\d+)\s+-\s+([^\r\n]+)$/gm)];
 if(headings.length!==1)fail('DETAIL_HEADING','Expected one visible Boataround order heading');
 const heading=headings[0],boatName=requiredLabel(text,'Boat');
 if(upper(heading[2])!==upper(boatName))fail('BOAT_MATCH','Order heading and Boat field differ');
 const dates=englishDateRange(requiredLabel(text,'Date'));
 return normalizeBoataroundRecord({id:heading[1],url,boat_name:boatName,...dates,booking_status:requiredLabel(text,'Booking status'),customer_payment:requiredLabel(text,'Customer payment'),agency_payment:optionalLabel(text,'Agency payment'),agency_price:requiredLabel(text,'Agency price'),client_price:requiredLabel(text,'Client price')},{verifiedAt,accountId});
}

/** List extraction contract: visible cell text only. Cell 2 (customer) is ignored.
 * Observed columns: status, #ID + boat, customer, dates, boat_price.
 * Prefer explicit start/end extracted from observed time elements when provided.
 */
export function parseBoataroundListRow(row,{verifiedAt,accountId=BOATAROUND_ACCOUNT_ID}={}){
 const cells=Array.isArray(row.cells)?row.cells:null,text=cell=>typeof cell==='string'?cell:String(cell?.text??'');
 if(cells&&cells.length<5)fail('LIST_COLUMNS','Boataround order row has too few observed columns');
 const platform_status=upper(row.status??(cells&&text(cells[0]))),booking=String(row.booking??(cells&&text(cells[1]))??''),lines=booking.split(/\r?\n/).map(compact).filter(Boolean),match=/^#(\d+)$/.exec(lines[0]??'');
 if(!['CONFIRMED','CANCELLED','CANCELED','COMPLETED'].includes(platform_status))fail('BOOKING_STATUS','Unknown list row status');
 if(!match||!lines[1])fail('LIST_BOOKING','Expected visible #order number and boat name on the first two lines');
 const identity=boataroundIdentity({bookingId:match[1],url:row.href??row.url,accountId});
 let range;
 if(Array.isArray(row.times)){
  if(row.times.length!==2)fail('DATE_RANGE_FORMAT','Expected exactly two observed time elements');
  const days=row.times.map(time=>{const value=String(time.datetime??'');if(!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))fail('DATE_FORMAT','Invalid time datetime attribute');const day=isoDate(value.slice(0,10));if(time.text&&englishDate(time.text)!==day)fail('DATE_MISMATCH','Visible date differs from time datetime');return day;});range=dateRange(...days);
  if(row.start&&row.end){const explicit=dateRange(row.start,row.end);if(explicit.start!==range.start||explicit.end!==range.end)fail('DATE_MISMATCH','Conflicting extracted dates');}
 }else range=row.start&&row.end?dateRange(row.start,row.end):englishDateRange(row.dates??text(cells?.[3]));
 const output={source:'boataround',...identity,boataround_slug:boataroundBoat(lines[1]),...range,platform_status,requires_detail:platform_status==='CONFIRMED',verified_at:verifiedTimestamp(verifiedAt),verification_source:'已登录 Boataround 订单列表可见行'};
 if(platform_status!=='CONFIRMED')output.status=boataroundStatus(platform_status,null);
 const price=row.boat_price??row.price??(cells&&text(cells[4]));if(price)output.list_price=money(price,{currency:'EUR'}).display;
 return output;
}

export function clickAndBoatStatus(value){
 const states={ACCEPTED:'accepted',COMPLETED:'completed',CANCELED:'cancelled',CANCELLED:'cancelled',REFUSED:'refused',DECLINED:'refused',PENDING:'pending',AWAITING:'pending','AWAITING-WEATHER':'pending','PENDING (DUE TO WEATHER CONDITIONS)':'pending'};
 const state=upper(value);if(!own(states,state))fail('BOOKING_STATUS','Unknown Click&Boat current state');return states[state];
}
export function clickAndBoatDateRange(value){
 const text=compact(value),match=/^from (\d{1,2})(?: ([A-Za-z]+))?(?: (\d{4}))? to (\d{1,2}) ([A-Za-z]+) (\d{4})(?: \(\d{2}:\d{2} \/ \d{2}:\d{2}\))?$/i.exec(text);
 if(!match)fail('DATE_RANGE_FORMAT','Unrecognized Click&Boat date range');
 return dateRange(englishDate(match[1]+' '+(match[2]||match[5])+' '+(match[3]||match[6])),englishDate(match[4]+' '+match[5]+' '+match[6]));
}
export function clickAndBoatIdentity({bookingId,url}){
 const booking_id=compact(bookingId).replace(/^N[°º]\s*/,'').replace(/^#/,'');
 if(!/^\d+$/.test(booking_id)||url!=='https://www.clickandboat.com/uk/booking/'+booking_id+'/detail')fail('ORDER_URL','Click&Boat order ID and canonical detail URL must agree');
 return {booking_id,url};
}
export function boatFromDisplayName(text,{source,listingId=null}={}){
 const name=upper(text);let matches=FLEET.filter(boat=>name.endsWith(upper(boat.name.split('|')[1])));
 if(listingId!=null){const id=String(listingId),field=source==='clickandboat'?'clickandboat_id':source==='samboat'?'samboat_id':null;if(!field)fail('BOAT_MATCH','Unsupported listing identifier source');const byId=FLEET.filter(boat=>boat[field]===id);if(byId.length!==1||(matches.length&&matches[0].slug!==byId[0].slug))fail('BOAT_MATCH','Listing identifier and boat name disagree');matches=byId;}
 if(matches.length!==1)fail('BOAT_MATCH','Boat display name does not uniquely match the verified fleet');return matches[0];
}
/** Function is self-contained so a supported browser can evaluate it against visible DOM. */
export function extractClickAndBoatDOMRows(doc=globalThis.document){
 return Array.from(doc.querySelectorAll('.booking-row')).filter(row=>row.getClientRects().length>0).map(row=>{
  const status=row.querySelector('.cell-status .status[data-state]'),visible=status?Array.from(status.children).filter(child=>child.hasAttribute('data-state')&&!child.classList.contains('hide')&&child.getClientRects().length>0):[];
  return {id:row.querySelector('.cell-id .id')?.innerText??null,state:status?.getAttribute('data-state')??null,visibleStates:visible.map(child=>({state:child.getAttribute('data-state'),text:child.innerText.trim()})),boat_text:row.querySelector('.cell-details a')?.innerText??null,date_text:row.querySelector('.cell-details .date')?.innerText??null,price:row.querySelector('.cell-price .total')?.innerText??null,href:row.querySelector('.cell-action a.bht-booking-details')?.href??null};
 });
}
export function parseClickAndBoatListRow(row,{verifiedAt}={}){
 const currentState=row.state??row.status,identity=clickAndBoatIdentity({bookingId:row.id??row.booking_id,url:row.href??row.url}),range=clickAndBoatDateRange(row.date_text),verified_at=verifiedTimestamp(verifiedAt);
 let status=clickAndBoatStatus(currentState),platform_status=compact(currentState),completedFromAccepted=false;
 if(Array.isArray(row.visibleStates)){
  if(row.visibleStates.length!==1)fail('AMBIGUOUS_STATUS','Expected exactly one visible Click&Boat status child');
  const visible=row.visibleStates[0],visibleText=typeof visible==='string'?visible:visible.text,visibleStatus=clickAndBoatStatus(visibleText);
  if(visibleStatus!==status){
   const beijingDay=new Date(Date.parse(verified_at)+8*60*60*1000).toISOString().slice(0,10);
   // Observed History rows retain Accepted in the parent after their checkout.
   if(status==='accepted'&&visibleStatus==='completed'&&range.end<=beijingDay){status='completed';platform_status='Completed';completedFromAccepted=true;}
   else fail('STATUS_MISMATCH','Visible Click&Boat status and data-state disagree');
  }
 }
 const fleet=boatFromDisplayName(row.boat_text,{source:'clickandboat',listingId:row.clickandboat_id??null});
 const output={source:'clickandboat',...identity,boataround_slug:fleet.slug,...range,status,platform_status,verified_at,verification_source:'已登录 Click&Boat 可见订单行；status[data-state] 与当前可见状态；列表 total 为已核验船东净收入'};
 if(completedFromAccepted)output.platform_parent_status=compact(currentState);
 const amount=row.price??row.amount;if(amount!=null&&compact(amount)){output.amount=money(amount,{currency:'EUR',allowZero:status!=='accepted'}).display;output.amount_basis='船东净收入';}else if(status==='accepted')fail('MONEY_MISSING','Accepted Click&Boat order is missing its net amount');
 return output;
}

function checkedSlug(slug){if(!FLEET.some(boat=>boat.slug===slug))fail('BOAT_MATCH','Supplied boat is not in the verified fleet');return slug;}
const dmySlashDate=value=>{const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(compact(value));if(!match)fail('DATE_FORMAT','Expected Click&Boat detail date in DD/MM/YYYY format');return isoDate(match[3]+'-'+match[2]+'-'+match[1]);};
export function parseClickAndBoatDetail({bodyText,url,boataround_slug,verifiedAt}){
 const lines=String(bodyText??'').split(/\r?\n/).map(compact).filter(Boolean),headingIndices=lines.map((line,index)=>/^Booking N[°º]\d+$/i.test(line)?index:-1).filter(index=>index>=0);
 if(headingIndices.length!==1)fail('DETAIL_HEADING','Expected one current Click&Boat booking heading');
 const headingIndex=headingIndices[0],identity=clickAndBoatIdentity({bookingId:lines[headingIndex].match(/\d+$/)[0],url}),platform_status=lines[headingIndex+1],status=clickAndBoatStatus(platform_status);
 const range=dateRange(dmySlashDate(requiredLabel(bodyText,'CHECK-IN')),dmySlashDate(requiredLabel(bodyText,'CHECK-OUT'))),amount=money(requiredLabel(bodyText,'Net amount (boat owner)'),{currency:'EUR',allowZero:status!=='accepted'});
 return {source:'clickandboat',...identity,boataround_slug:checkedSlug(boataround_slug),...range,status,platform_status,amount:amount.display,amount_basis:'船东净收入',verified_at:verifiedTimestamp(verifiedAt),verification_source:'已登录 Click&Boat 当前订单标题后的状态、CHECK-IN/CHECK-OUT 与 Net amount (boat owner)'};
}

export function samBoatStatus(value){
 const states={'VALIDATED / DEPOSIT PAID':'deposit_paid','DEPOSIT PAID':'deposit_paid',DEPOSIT_PAID:'deposit_paid',COMPLETED:'completed','RENTAL IS COMPLETE':'completed',CANCELLED:'cancelled',CANCELED:'cancelled',REFUSED:'refused',SENT:'pending',PENDING:'pending','CANCELLATION REQUEST':'pending','PENDING MODIFICATION':'pending','PRE-PAID':'pending'};
 const state=upper(value);if(!own(states,state))fail('BOOKING_STATUS','Unrecognized SamBoat current status');return states[state];
}
export function samBoatDateRange(value){
 const text=compact(value).replace(/ in the (?:morning|evening|afternoon)/gi,'').trim(),match=/^(\d{1,2})(?: ([A-Za-z]+))?(?: (\d{4}))?\s*[-–—]\s*(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
 if(!match)fail('DATE_RANGE_FORMAT','Unrecognized SamBoat visible date range');
 return dateRange(englishDate(match[1]+' '+(match[2]||match[5])+' '+(match[3]||match[6])),englishDate(match[4]+' '+match[5]+' '+match[6]));
}
export function samBoatIdentity(url){
 let parsed;try{parsed=new URL(url);}catch{fail('ORDER_URL','Invalid SamBoat detail URL');}
 const match=/^\/private\/reservation\/(\d+)$/.exec(parsed.pathname);
 if(parsed.protocol!=='https:'||parsed.hostname!=='www.samboat.com'||parsed.port||parsed.username||parsed.password||parsed.hash||!match)fail('ORDER_URL','Unexpected SamBoat detail origin or path');
 for(const [key,value] of parsed.searchParams){if(!['tab','page'].includes(key)||(key==='page'&&!/^[1-9]\d*$/.test(value))||(key==='tab'&&!/^[a-z-]+$/.test(value)))fail('ORDER_URL','Unexpected SamBoat detail navigation parameter');}
 return {booking_id:match[1],url:'https://www.samboat.com/private/reservation/'+match[1]};
}
const SAMBOAT_MODELS={
 'SEACAT 40 OPEN':'seacat-open-40-tidewyn-discovery-2',
 'REEFYARD REEF CAT 37':'reef-cat-37-tidewyn-discovery',
 'WAVECAT 34 OPEN':'wavecat-34-open-tidewyn-dream'
};
function samBoatModel(text){const name=upper(text);if(!own(SAMBOAT_MODELS,name))fail('BOAT_MATCH','Unrecognized SamBoat model in this three-boat account');return SAMBOAT_MODELS[name];}
export function parseSamBoatListCard({url,text},{verifiedAt}={}){
 const identity=samBoatIdentity(url),lines=String(text??'').split(/\r?\n/).map(compact).filter(Boolean);
 if(lines.at(-1)==='Write a comment')lines.pop();
 const platform_status=lines.at(-1),status=samBoatStatus(platform_status);
 if(!lines.includes(identity.booking_id))fail('ORDER_ID','SamBoat card ID differs from its detail URL');
 const dateCandidates=[];for(let index=0;index<lines.length;index++){if(!/^\d{1,2}(?: | -)/.test(lines[index]))continue;try{dateCandidates.push({index,...samBoatDateRange(lines[index])});}catch(error){if(!(error instanceof OrderParseError))throw error;}}
 if(dateCandidates.length!==1)fail('DATE_RANGE_FORMAT','Expected one SamBoat card date range');
 const range=dateCandidates[0],slug=samBoatModel(lines[range.index+1]),priceLines=lines.filter(line=>/^[€$]\s*[\d,.]+$/.test(line));
 if(priceLines.length>1||(!priceLines.length&&status==='deposit_paid'))fail('MONEY_MISSING','Expected one unambiguous online amount on SamBoat card');
 const output={source:'samboat',...identity,boataround_slug:slug,start:range.start,end:range.end,status,platform_status,verified_at:verifiedTimestamp(verifiedAt),verification_source:'已登录 SamBoat 当前可见标签页订单卡片；末尾明确状态与日期'};
 if(priceLines.length){output.amount=money(priceLines[0],{allowZero:status!=='deposit_paid'}).display;output.amount_basis='租客在线支付金额';}
 return output;
}
/** The progress navigation contains all steps, including Completed. Its following
 * standalone current badge is read only in the pre-chat detail portion.
 */
export function parseSamBoatDetail({bodyText,url,boataround_slug,current_status,verifiedAt}){
 const identity=samBoatIdentity(url),allLines=String(bodyText??'').split(/\r?\n/).map(compact).filter(Boolean);
 const chatIndex=allLines.findIndex(line=>/^(?:To contact\b|Conversation with\b|(?:Request |Booking )?History$)/i.test(line)),preChat=allLines.slice(0,chatIndex<0?allLines.length:chatIndex);
 const headings=preChat.map((line,index)=>/^Request n[°º]\d+$/i.test(line)?index:-1).filter(index=>index>=0);
 if(headings.length!==1||!new RegExp('^Request n[°º]'+identity.booking_id+'$','i').test(preChat[headings[0]]))fail('DETAIL_HEADING','Expected one SamBoat detail heading matching its URL');
 const headingIndex=headings[0],lines=preChat.slice(headingIndex);
 const progress=['Request','Pre-approve','Paid','In progress','Completed'];let progressIndex=-1;
 for(let i=0;i<=lines.length-progress.length;i++)if(progress.every((text,j)=>lines[i+j]===text)){if(progressIndex>=0)fail('AMBIGUOUS_STATUS','Multiple current progress headers');progressIndex=i;}
 if(progressIndex<0)fail('DETAIL_STATUS','Expected observed SamBoat progress navigation before the current status badge');
 const badge=lines[progressIndex+progress.length],status=samBoatStatus(badge);
 if(current_status!=null&&samBoatStatus(current_status)!==status)fail('STATUS_MISMATCH','SamBoat list status and current detail badge differ');
 let header=lines.slice(1,progressIndex);
 if(!header.length){
  // Observed native-phone layout moves the booking card before the request heading.
  // Its navigation and Help boundaries keep FAQ, customer and chat text out of facts.
  const prefix=preChat.slice(0,headingIndex),nav=prefix.map((line,index)=>line==='My favorites'?index:-1).filter(index=>index>=0);
  if(nav.length!==1||prefix.at(-1)!=='Back to the list of requests')fail('DETAIL_LAYOUT','Expected observed SamBoat phone navigation before its heading');
  const start=nav[0]+1,end=prefix.findIndex((line,index)=>index>=start&&line==='Help');
  if(end<=start)fail('DETAIL_LAYOUT','Expected the SamBoat phone booking card before Help');
  header=prefix.slice(start,end);
 }else{
  const helpIndex=header.indexOf('Help');if(helpIndex>=0)header=header.slice(0,helpIndex);
  if(preChat.slice(0,headingIndex).some(line=>own(SAMBOAT_MODELS,upper(line))))fail('DETAIL_LAYOUT','Multiple SamBoat booking cards before the current status');
 }
 const slug=checkedSlug(boataround_slug),modelSlug=samBoatModel(header[0]);
 if(modelSlug!==slug||header.filter(line=>own(SAMBOAT_MODELS,upper(line))).length!==1)fail('BOAT_MATCH','SamBoat list boat and unique detail model must agree');
 const dateCandidates=[];for(const line of header){if(!/^\d{1,2}(?: | -)/.test(line))continue;try{dateCandidates.push(samBoatDateRange(line));}catch(error){if(!(error instanceof OrderParseError))throw error;}}
 if(dateCandidates.length!==1)fail('DATE_RANGE_FORMAT','Expected one current SamBoat detail date range');
 const amount=money(requiredLabel(header.join('\n'),'To be paid online'),{allowZero:status!=='deposit_paid'});
 return {source:'samboat',...identity,boataround_slug:slug,...dateCandidates[0],status,platform_status:badge,amount:amount.display,amount_basis:'租客在线支付金额',verified_at:verifiedTimestamp(verifiedAt),verification_source:'已登录 SamBoat 聊天前订单区；进度导航后的当前状态标记、真实日期与 To be paid online'};
}

/** RFC 4180-style records for the actual Click&Boat native revenue export. */
export function csvRecords(text){
 const rows=[],row=[];let cell='',quoted=false;const input=String(text??'').replace(/^\uFEFF/,'');
 for(let i=0;i<input.length;i++){const char=input[i];if(quoted){if(char==='"'&&input[i+1]==='"'){cell+='"';i++;}else if(char==='"')quoted=false;else cell+=char;}else if(char==='"'){if(cell)fail('CSV_FORMAT','Unexpected quote inside CSV field');quoted=true;}else if(char===','){row.push(cell);cell='';}else if(char==='\n'||char==='\r'){if(char==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value!==''))rows.push([...row]);row.length=0;cell='';}else cell+=char;}
 if(quoted)fail('CSV_FORMAT','Unclosed CSV quoted field');if(cell||row.length){row.push(cell);rows.push([...row]);}return rows;
}
const dmyDate=value=>{const match=/^(\d{2})-(\d{2})-(\d{4})$/.exec(compact(value));if(!match)fail('CSV_DATE','Expected export date in DD-MM-YYYY format');return isoDate(match[3]+'-'+match[2]+'-'+match[1]);};
/** Revenue export has no booking status: returns enrichment, never active orders. */
export function parseClickAndBoatRevenueCSV(text){
 const rows=csvRecords(text),headers=rows.shift();
 const required=['No. charter','Listing title','Charter start date','Charter end date','Gross amount (€)','Net amount (€)'];
 if(!headers||required.some(name=>headers.filter(header=>header===name).length!==1))fail('CSV_HEADERS','Click&Boat revenue export headers do not match observed columns');
 const records=rows.map(cells=>{if(cells.length!==headers.length)fail('CSV_COLUMNS','CSV row has a different column count');const row=Object.fromEntries(headers.map((header,i)=>[header,cells[i]])),booking_id=compact(row['No. charter']),boatMatch=/^#(\d+)\s+-\s+/.exec(row['Listing title']);
  if(!/^\d+$/.test(booking_id)||!boatMatch)fail('CSV_ID','Invalid order or listing identifier in export');const fleet=FLEET.find(boat=>boat.clickandboat_id===boatMatch[1]);if(!fleet)fail('BOAT_MATCH','CSV listing is not in the verified fleet');
  return {source:'clickandboat',booking_id,clickandboat_id:boatMatch[1],boataround_slug:fleet.slug,...dateRange(dmyDate(row['Charter start date']),dmyDate(row['Charter end date'])),amount:money(row['Net amount (€)'],{currency:'EUR'}).display,amount_basis:'船东净收入',client_amount:money(row['Gross amount (€)'],{currency:'EUR'}).display,requires_status_verification:true};
 });
 if(new Set(records.map(record=>record.booking_id)).size!==records.length)fail('DUPLICATE_ORDER','Duplicate booking identifiers in revenue export');return records;
}
