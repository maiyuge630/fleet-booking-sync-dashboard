// Independent candidate only. No files are modified by importing this module.
// Local vendor front-end evidence:
// ../api-inspection/public-js/boataround/index.72d1c0b8.readable.js:822
//   NEW -> New, IN PROCESS -> In process, UNPAID -> Not paid,
//   PARTIALLY PAID -> Partially paid, PAID -> Paid, REFUNDED -> Refunded.
// ../api-inspection/public-js/boataround/1158.fe25945c.readable.js:168-170
//   Booking status and Customer payment are separate visible fields.
// ../api-inspection/public-js/boataround/4547.a384ab81.readable.js:249-252
//   list response.count initializes pagination and response.data is rendered.

export function patchBoataroundParser(source) {
  if(typeof source!=='string')throw Error('invalid_parser_source');
  const replace=(before,after)=>{
    if(source.split(before).length!==2)throw Error('parser_proposal_anchor_changed');
    source=source.replace(before,after);
  };
  replace(" if(state==='COMPLETED')return 'completed';\n if(state!=='CONFIRMED')", " if(state==='COMPLETED')return 'completed';\n if(['NEW','IN PROCESS'].includes(state))return 'pending';\n if(state!=='CONFIRMED')");
  replace(" if(payment==='NOT PAID')return 'pending';", " // REFUNDED stays explicitly non-active; retain its original customer_payment.\n // UNPAID is the raw API value, while the English DOM label is NOT PAID.\n if(['NOT PAID','UNPAID','REFUNDED'].includes(payment))return 'pending';");
  replace(" if(!['CONFIRMED','CANCELLED','CANCELED','COMPLETED'].includes(platform_status))", " if(!['NEW','IN PROCESS','CONFIRMED','CANCELLED','CANCELED','COMPLETED'].includes(platform_status))");
  replace(' if(Array.isArray(row.times)){', ' if(Array.isArray(row.times)&&row.times.length>0){');
  // Cancellation/refund discovered in a formerly confirmed detail must not
  // fail only because that inactive page omits payment or price sections.
  replace(" const dates=englishDateRange(requiredLabel(text,'Date'));\n return normalizeBoataroundRecord(",
    " const dates=englishDateRange(requiredLabel(text,'Date'));\n const bookingStatus=requiredLabel(text,'Booking status');\n const customerPayment=upper(bookingStatus)==='CONFIRMED'?requiredLabel(text,'Customer payment'):optionalLabel(text,'Customer payment');\n const normalizedStatus=boataroundStatus(bookingStatus,customerPayment);\n if(!['paid','deposit_paid'].includes(normalizedStatus))return normalizeBoataroundRecord({id:heading[1],url,boat_name:boatName,...dates,booking_status:bookingStatus,customer_payment:customerPayment},{verifiedAt,accountId});\n return normalizeBoataroundRecord(");
  return source;
}

// Proposed completeness gate for real observed list-response metadata. This
// does NOT fetch an API or prove payment/state correctness. The caller must
// supply actual count/data identities from each response; never infer them
// from the number of visible pagination buttons or a saved historical total.
export function verifyBoataroundPaginationEvidence({pages,final_count}) {
  const fail=()=>{throw Object.assign(Error('incomplete_pages'),{code:'incomplete_pages'});};
  if(!Array.isArray(pages)||!pages.length)fail();
  const count=pages[0]?.count;
  if(!Number.isSafeInteger(count)||count<0||count>1000||final_count!==count)fail();
  const totalPages=Math.max(1,Math.ceil(count/20));
  if(pages.length!==totalPages)fail();
  const identities=new Set();let sort=null;
  for(let index=0;index<pages.length;index++){
    const page=pages[index];let url;
    try{url=new URL(page.request_url);}catch{fail();}
    if(url.origin!=='https://partner-api.boataround.com'||url.username||url.password||url.hash||
      url.pathname!=='/v1/charters/000000000000000000000000/orders')fail();
    if([...url.searchParams.keys()].some(key=>!['lang','offset','limit','sort'].includes(key)))fail();
    for(const key of ['lang','offset','limit'])if(url.searchParams.getAll(key).length!==1)fail();
    if(url.searchParams.getAll('sort').length>1||url.searchParams.get('lang')!=='en_GB'||
      url.searchParams.get('offset')!==String(index*20)||url.searchParams.get('limit')!=='20')fail();
    if(index===0)sort=url.searchParams.get('sort');else if(sort!==url.searchParams.get('sort'))fail();
    if(page.count!==count||!Array.isArray(page.ids)||page.ids.length!==Math.max(0,Math.min(20,count-index*20)))fail();
    for(const id of page.ids){if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)||identities.has(id))fail();identities.add(id);}
  }
  if(identities.size!==count)fail();
  return {complete:true,total_pages:totalPages,pages_read:Array.from({length:totalPages},(_,i)=>i+1),listed_count:count};
}
