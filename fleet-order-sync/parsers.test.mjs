import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import * as parsers from './parsers.mjs';
import {buildPlan} from './reverse-sync/planner.mjs';
import {releaseAllowed} from './reverse-sync/release.mjs';

const read=name=>readFileSync(new URL('./evidence/'+name,import.meta.url),'utf8');
const stamp='2026-09-08T04:45:00.000Z';
const baURL='https://partner.boataround.com/en/000000000000000000000000/orders/b386b5a4271f3a72a26a93d0';
const baBody=read('ba-280707-body.txt'),sbBody=read('sb-1502428-body.txt');
const sbInput={bodyText:sbBody,url:'https://www.samboat.com/private/reservation/1502428',boataround_slug:'seacat-open-40-tidewyn-discovery-2',current_status:'deposit_paid',verifiedAt:stamp};

test('SamBoat Answer, Pre-approved and documented Discussion quotes are never payment or cancellation proof',()=>{
 const verifiedAt='2026-09-20T00:40:00.000Z',now=Date.parse(verifiedAt);
 for(const platformStatus of ['Answer','Pre-approved','Discussion']){
 const record=parsers.parseSamBoatListCard({url:'https://www.samboat.com/private/reservation/1655830?tab=ongoing&page=1',
  text:'1655830\n27 Feb - 06 Mar 2027 in the morning\nWavecat 34 open\nPhuket (City)\n$10,379.31\n'+platformStatus},{verifiedAt});
 assert.equal(record.status,'pending');assert.equal(record.platform_status,platformStatus);assert.equal(record.amount,'$10,379.31');
 assert.equal(record.boataround_slug,'wavecat-34-open-tidewyn-dream');
 assert.deepEqual([record.start,record.end],['2027-02-27','2027-03-06']);
 assert.equal(record.customer_payment_verified,undefined);assert.equal(parsers.samBoatStatus('Paid'),'paid');
 for(const label of ['Answer paid','Answer later','Answered','Preapproved','Pre-approved paid','Pre-approved cancelled','Approved','Discussion paid','Discussion cancelled','In discussion'])
  assert.throws(()=>parsers.samBoatStatus(label),{code:'BOOKING_STATUS'});
 const status={platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:verifiedAt,last_error:null}]))};
 const plan=buildPlan({boataround:[],clickandboat:[],samboat:[record],mmk:[],nausys:[]},status,{now});
 assert.deepEqual(plan.causes,[]);assert.ok(plan.targets.every(t=>t.segments.length===0));
 const target=plan.targets.find(t=>t.boat===record.boataround_slug&&t.target==='clickandboat');
 assert.deepEqual(target.release_proof.orders,[]);
 assert.equal(releaseAllowed({start:record.start,end:'2027-03-07',causes:['samboat:1655830'],
  created:{id:'old-owned',start:record.start,end:'2027-03-07'}},target,now),false);
 }
});

test('observed pre-approved card is awaiting renter payment; later Paid still requires a fresh confirmed detail',()=>{
 const observation=readFileSync(new URL('./samboat-incident-20260920b/list-inspect.jsonl',import.meta.url),'utf8').trim().split(/\r?\n/)
  .map(line=>JSON.parse(line)).find(row=>row.tab==='ongoing');
 const request=observation.panels.find(panel=>panel.id==='ongoing').cards.find(card=>card.id==='1655830');
 assert.equal(request.priceError,null);assert.equal(request.lines.at(-1),'Pre-approved');
 const detail=JSON.parse(readFileSync(new URL('./samboat-incident-20260920b/preapproved-detail.json',import.meta.url),'utf8'));
 assert.equal(detail.http,200);assert.equal(detail.status.paidConfirmation,false);
 assert.deepEqual(detail.status.afterProgress.slice(0,2),['Request pre-approved.',"Waiting for the renter's payment."]);
 const record=parsers.parseSamBoatListCard({url:'https://www.samboat.com/private/reservation/1655830',text:request.lines.join('\n')},{verifiedAt:stamp});
 assert.equal(record.status,'pending');assert.equal(record.amount,'$10,379.31');
 const paidConfirmation='Fixture renter has paid the rent.\nThe reservation is confirmed.';
 const preapprovedBody=sbBody.replace('\nDeposit paid\n','\nRequest pre-approved.\nWaiting for the renter\'s payment.\nFixture renter has 6 days to pay.\n');
 // Even a later Paid list must not certify an old awaiting-payment detail.
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:preapprovedBody,current_status:'paid'}),{code:'BOOKING_STATUS'});
 const paidBody=sbBody.replace('\nDeposit paid\n','\n'+paidConfirmation+'\n');
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:paidBody,current_status:'Pre-approved'}),{code:'STATUS_MISMATCH'});
 assert.equal(parsers.parseSamBoatDetail({...sbInput,bodyText:paidBody,current_status:'Paid'}).status,'paid');
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:paidBody.replace('To be paid online','Missing payment amount'),current_status:'Paid'}));
});

test('documented SamBoat Finished is completed, never cancellation or new payment evidence',()=>{
 // https://www.samboat.com/help/what-are-the-meaning-of-the-requests-status-200?country=us
 // Exact documented terminal wording; no inferred aliases or cancellation fallback.
 const verifiedAt='2026-09-20T06:00:00.000Z',now=Date.parse(verifiedAt);
 const record=parsers.parseSamBoatListCard({url:'https://www.samboat.com/private/reservation/1655830',
  text:'1655830\n27 Feb - 06 Mar 2027 in the morning\nWavecat 34 open\nFinished\nWrite a comment'},{verifiedAt});
 assert.equal(record.status,'completed');assert.equal(record.platform_status,'Finished');assert.equal(record.amount,undefined);
 const sources={platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(source=>[source,{mode:'dynamic',last_success_at:verifiedAt,last_error:null}]))};
 const plan=buildPlan({boataround:[],clickandboat:[],samboat:[record],mmk:[],nausys:[]},sources,{now});assert.deepEqual(plan.causes,[]);
 const target=plan.targets.find(target=>target.boat===record.boataround_slug&&target.target==='clickandboat');
 assert.deepEqual(target.release_proof.orders,[]);
 assert.equal(releaseAllowed({start:record.start,end:'2027-03-07',causes:['samboat:1655830'],
  created:{id:'owned',start:record.start,end:'2027-03-07'}},target,now),false);
 for(const label of ['Finished paid','Finished cancelled','Cancellation Request','Partially refunded','Refunded'])
  assert.throws(()=>parsers.samBoatStatus(label),{code:'BOOKING_STATUS'});
});

test('official SamBoat deposit labels keep exact list/detail agreement and mandatory positive current money',()=>{
 // Synthetic label substitutions into a saved detail layout, not new phone observations.
 // https://www.samboat.com/help/understanding-the-different-statuses-and-stages-of-a-reservation-268?country=us
 for(const label of ['Deposit paid only','Validated/Deposit paid']){
  const text='1502428\n01 - 08 Jan 2027 in the morning\nSeacat 40 Open\n$22,443.72\n'+label;
  const card=parsers.parseSamBoatListCard({url:sbInput.url,text},{verifiedAt:stamp});
  assert.equal(card.status,'deposit_paid');assert.equal(card.platform_status,label);assert.equal(card.amount,'$22,443.72');
  const bodyText=sbBody.replace('\nDeposit paid\n','\n'+label+'\n');
  const input={...sbInput,bodyText,current_status:label};
  const detail=parsers.parseSamBoatDetail(input);
  assert.equal(detail.status,'deposit_paid');assert.equal(detail.platform_status,label);assert.equal(detail.amount,card.amount);
  for(const current_status of ['Pending','Pre-approved','Paid','Completed'])
   assert.throws(()=>parsers.parseSamBoatDetail({...input,current_status}),{code:'STATUS_MISMATCH'});
  for(const broken of [bodyText.replace('To be paid online','Unverified amount'),bodyText.replace('To be paid online\n$22,443.72','To be paid online\n$0.00')])
   assert.throws(()=>parsers.parseSamBoatDetail({...input,bodyText:broken}));
  assert.throws(()=>parsers.parseSamBoatListCard({url:sbInput.url,text:text.replace('$22,443.72\n','')},{verifiedAt:stamp}),{code:'MONEY_MISSING'});
  assert.throws(()=>parsers.parseSamBoatListCard({url:sbInput.url,text:text.replace('$22,443.72','$0.00')},{verifiedAt:stamp}),{code:'MONEY_VALUE'});
  const cancelled=parsers.parseSamBoatDetail({...input,bodyText:bodyText.replace('\n'+label+'\n','\nCancelled\n')});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.amount,undefined);
 }
 for(const label of ['Deposit paid only pending','Deposit paid only refunded','Validated/Deposit paid requested','Deposit paid only cancelled','Validated /Deposit paid','Refunded','Cancellation request'])
  assert.throws(()=>parsers.samBoatStatus(label),{code:'BOOKING_STATUS'});
});

test('SamBoat prepaid answer request remains pending and supports its observed single charter date',()=>{
 const result=parsers.parseSamBoatListCard({url:'https://www.samboat.com/private/reservation/1654079?tab=ongoing&page=1',
  text:'New Message\n1654079\n26 Sep 2026\nSeacat 40 Open\nPhuket (City)\n$1,947.45\nPre-paid: answer'},{verifiedAt:stamp});
 assert.equal(result.booking_id,'1654079');assert.equal(result.status,'pending');
 assert.equal(result.start,'2026-09-26');assert.equal(result.end,'2026-09-26');
 assert.equal(result.platform_status,'Pre-paid: answer');assert.equal(result.amount,'$1,947.45');
 for(const status of ['PRE-PAID','Pre-paid: answer'])assert.equal(parsers.samBoatStatus(status),'pending');
 for(const status of ['Pre-paid: accepted','Pre-paid: answer later','Pending acceptance paid'])assert.throws(()=>parsers.samBoatStatus(status),{code:'BOOKING_STATUS'});
});

test('SamBoat single-day paid detail preserves same-day dates and still needs current paid proof',()=>{
 const result=parsers.parseSamBoatDetail({...sbInput,bodyText:sbBody.replace('01 - 08 Jan 2027 in the morning','26 Sep 2026')});
 assert.equal(result.start,'2026-09-26');assert.equal(result.end,'2026-09-26');assert.equal(result.status,'deposit_paid');
 for(const text of ['26 - 26 Sep 2026','26 Sep 2026 in the morning'])assert.deepEqual(parsers.samBoatDateRange(text),{start:'2026-09-26',end:'2026-09-26'});
 for(const text of ['27 - 26 Sep 2026','31 Feb 2026'])assert.throws(()=>parsers.samBoatDateRange(text));
 // The SamBoat display convention must not relax other platforms' ranges.
 assert.throws(()=>parsers.dateRange('2026-09-26','2026-09-26'));
});

test('SamBoat Paid is distinct from pending pre-paid and requires nonzero money in card and detail',()=>{
 assert.equal(parsers.samBoatStatus('Paid'),'paid');assert.equal(parsers.samBoatStatus('Pre-paid: answer'),'pending');
 const confirmation='Fixture renter has paid the rent.\nThe reservation is confirmed.';
 const bodyText=sbBody.replace('\nDeposit paid\n','\n'+confirmation+'\n'),input={...sbInput,bodyText,current_status:'paid'};
 const result=parsers.parseSamBoatDetail(input);assert.equal(result.status,'paid');assert.equal(result.amount,'$22,443.72');
 for(const body of [bodyText.replace('To be paid online\n$22,443.72 ','To be paid online\n$0.00 '),bodyText.replace('To be paid online','Amount not present')])
   assert.throws(()=>parsers.parseSamBoatDetail({...input,bodyText:body}));
 const text='1654079\n26 Sep 2026\nSeacat 40 Open\n$1,947.45\nPaid',url='https://www.samboat.com/private/reservation/1654079';
 assert.equal(parsers.parseSamBoatListCard({url,text},{verifiedAt:stamp}).status,'paid');
 assert.throws(()=>parsers.parseSamBoatListCard({url,text:text.replace('$1,947.45\n','')},{verifiedAt:stamp}),{code:'MONEY_MISSING'});
 assert.throws(()=>parsers.parseSamBoatListCard({url,text:text.replace('$1,947.45','$0.00')},{verifiedAt:stamp}),{code:'MONEY_VALUE'});
 const cancelled=parsers.parseSamBoatDetail({...input,bodyText:bodyText.replace(confirmation,'Cancelled')});
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.amount,undefined);
});

test('observed fully-paid confirmation supports a single-day order without copying customer identity',()=>{
 const observed=JSON.parse(readFileSync(new URL('./samboat-reliability-v14/new-paid-detail-layout.json',import.meta.url),'utf8'));
 assert.equal(observed.heading_found,true);
 assert.deepEqual(observed.status_region.slice(1,6),['Request','Pre-approve','Paid','In progress','Completed']);
 assert.match(observed.status_region[6],/^.+ has paid the rent\.$/);
 assert.equal(observed.status_region[7],'The reservation is confirmed.');
 const bodyText=sbBody.replace('Request n°1502428','Request n°1654079')
   .replace('01 - 08 Jan 2027 in the morning','26 Sep 2026')
   .replace('\nDeposit paid\n','\nAnonymous has paid the rent.\nThe reservation is confirmed.\n')
   .replace('To be paid online\n$22,443.72','To be paid online\n$1,947.45');
 const result=parsers.parseSamBoatDetail({...sbInput,bodyText,url:'https://www.samboat.com/private/reservation/1654079',current_status:'paid'});
 assert.equal(result.status,'paid');assert.equal(result.platform_status,'Paid');assert.equal(result.amount,'$1,947.45');
 assert.equal(result.start,'2026-09-26');assert.equal(result.end,'2026-09-26');assert.ok(!JSON.stringify(result).includes('Anonymous'));
});

test('paid wording cannot replace current confirmation, independent list status, or strict pre-chat position',()=>{
 const confirmation='Anonymous has paid the rent.\nThe reservation is confirmed.';
 const paid=sbBody.replace('\nDeposit paid\n','\n'+confirmation+'\n');
 for(const current of ['Anonymous has paid the rent.','The reservation is confirmed.','Paid','',
   'Anonymous has paid the rent.\nThe reservation is not confirmed.',
   'Anonymous has paid the rent.\nUnrelated line\nThe reservation is confirmed.']){
  const bodyText=sbBody.replace('\nDeposit paid\n','\n'+current+'\n');
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText,current_status:'paid'}));
 }
 for(const current_status of [undefined,'pending','deposit_paid','completed'])
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:paid,current_status}),{code:'STATUS_MISMATCH'});
 const chatOnly=sbBody.replace('\nDeposit paid\n','\nPending\n')+'\nConversation with renter\n'+confirmation;
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:chatOnly,current_status:'paid'}),{code:'STATUS_MISMATCH'});
 const unchanged=parsers.parseSamBoatDetail({...sbInput,bodyText:sbBody+'\nConversation with renter\n'+confirmation});
 assert.equal(unchanged.status,'deposit_paid');
});

test('Boataround paid NEW and IN PROCESS orders are occupied; workflow alone proves no payment',()=>{
 for(const status of ['NEW','IN PROCESS']){
  assert.equal(parsers.boataroundStatus(status,'PAID'),'paid');
  assert.equal(parsers.boataroundStatus(status,'PARTIALLY PAID'),'deposit_paid');
  for(const payment of ['NOT PAID','REFUNDED'])assert.equal(parsers.boataroundStatus(status,payment),'pending');
  for(const payment of [null,undefined,'UNKNOWN'])assert.throws(()=>parsers.boataroundStatus(status,payment),{code:'PAYMENT_STATUS'});
  const detail=parsers.parseBoataroundDetail({bodyText:baBody.replace('Booking status\nCONFIRMED','Booking status\n'+status),url:baURL,verifiedAt:stamp});
  assert.equal(detail.status,'deposit_paid');assert.equal(detail.customer_payment,'PARTIALLY PAID');assert.equal(detail.platform_status,status);
 }
 assert.equal(parsers.boataroundStatus('CONFIRMED','REFUNDED'),'pending');
 assert.equal(parsers.boataroundStatus('CANCELLED','PAID'),'cancelled');
 assert.throws(()=>parsers.boataroundStatus('SOMETHING ELSE','PAID'),{code:'BOOKING_STATUS'});
 const refunded=parsers.parseBoataroundDetail({bodyText:baBody.replace('Customer payment\nPARTIALLY PAID','Customer payment\nREFUNDED'),url:baURL,verifiedAt:stamp});
 assert.equal(refunded.status,'pending');assert.equal(refunded.customer_payment,'REFUNDED');
});

test('Boataround cancellation needs correct identity and dates, but never a payment or price section',()=>{
 const bodyText=baBody.replace('Booking status\nCONFIRMED','Booking status\nCANCELLED')
  .replace(/(?:Customer payment|Agency payment|Agency price|Client price)\n[^\n]+\n/g,'');
 const result=parsers.parseBoataroundDetail({bodyText,url:baURL,verifiedAt:stamp});
 assert.equal(result.status,'cancelled');assert.equal(result.amount,undefined);
 assert.throws(()=>parsers.parseBoataroundDetail({bodyText:bodyText.replace(/(\nBoat\n)[^\n]+/,'$1Wrong boat'),url:baURL,verifiedAt:stamp}),{code:'BOAT_MATCH'});
 const missingPaid=baBody.replace(/Customer payment\n[^\n]+\n/,'');
 assert.throws(()=>parsers.parseBoataroundDetail({bodyText:missingPaid,url:baURL,verifiedAt:stamp}),{code:'MISSING_LABEL'});
});

test('Click&Boat final cancellation is valid without money; a paid-looking amount cannot revive it',()=>{
 const bodyText=read('cb-1250578-body.txt').replace(/(Booking N[°º]1250578\n)Accepted/i,'$1Cancelled').replace(/Net amount \(boat owner\)\n[^\n]+\n/,'');
 const result=parsers.parseClickAndBoatDetail({bodyText,url:'https://www.clickandboat.com/uk/booking/1250578/detail',boataround_slug:'seacat-open-40-tidewyn-discovery-2',verifiedAt:stamp});
 assert.equal(result.status,'cancelled');assert.equal(result.amount,undefined);
 assert.throws(()=>parsers.parseClickAndBoatDetail({bodyText:bodyText.replace('1250578','999999'),url:result.url,boataround_slug:result.boataround_slug,verifiedAt:stamp}),{code:'ORDER_URL'});
});

test('SamBoat pending cancellation/modification cannot release a previously paid booking as if finally cancelled',()=>{
 for(const value of ['Cancellation request','Pending modification'])assert.throws(()=>parsers.samBoatStatus(value),{code:'BOOKING_STATUS'});
});

test('real Boataround detail gives customer deposit and Agency price, independent of payout schedule',()=>{
 const record=parsers.parseBoataroundDetail({bodyText:baBody,url:baURL,verifiedAt:stamp});
 assert.equal(record.booking_id,'280707');assert.equal(record.status,'deposit_paid');assert.equal(record.amount,'€14,086.50');assert.equal(record.client_amount,'€15,585.00');assert.equal(record.start,'2026-10-17');assert.equal(record.end,'2026-10-24');
 const changed=baBody.replace('Agency payment\nPARTIALLY PAID','Agency payment\nNOT PAID');
 assert.equal(parsers.parseBoataroundDetail({bodyText:changed,url:baURL,verifiedAt:stamp}).status,'deposit_paid');
});
test('confirmed but customer unpaid never becomes active even if agency has been paid',()=>{
 const changed=baBody.replace('Customer payment\nPARTIALLY PAID','Customer payment\nNOT PAID').replace('Agency payment\nPARTIALLY PAID','Agency payment\nPAID');
 assert.equal(parsers.parseBoataroundDetail({bodyText:changed,url:baURL,verifiedAt:stamp}).status,'pending');
 assert.throws(()=>parsers.boataroundStatus('CONFIRMED','UNKNOWN'),{code:'PAYMENT_STATUS'});
});
test('actual BA page 3 parses all 11 rows using time attributes, ignoring marina and crew metadata',()=>{
 const rows=JSON.parse(read('ba-list-page3.json')).rows,parsed=rows.map(row=>parsers.parseBoataroundListRow(row,{verifiedAt:stamp}));
 assert.equal(parsed.length,11);assert.equal(parsed.find(row=>row.booking_id==='253823').requires_detail,true);assert.equal(parsed.find(row=>row.booking_id==='253823').status,undefined);
 assert.equal(parsed.find(row=>row.booking_id==='254671').status,'cancelled');
 assert.equal(parsed.find(row=>row.booking_id==='252744').end,'2026-02-06');
 assert.ok(parsed.every(row=>!('customer' in row)&&!('booking' in row)));
 assert.throws(()=>parsers.parseBoataroundListRow({...rows[0],times:[{datetime:'2025-10-25T00:00:00Z',text:'24 Oct 2025'},rows[0].times[1]]},{verifiedAt:stamp}),{code:'DATE_MISMATCH'});
});
test('Boataround exact account and independent detail ID cannot be substituted with numeric order ID',()=>{
 assert.throws(()=>parsers.boataroundIdentity({bookingId:'280707',url:baURL.replace(/[^/]+$/,'280707')}),{code:'ORDER_URL'});
 assert.throws(()=>parsers.boataroundIdentity({bookingId:'280707',url:baURL+'?x=1'}),{code:'ORDER_URL'});
 assert.throws(()=>parsers.boataroundIdentity({bookingId:'280707',url:baURL,detailId:'ffffffffffffffffffffffff'}),{code:'ORDER_URL'});
});
test('CB same-month and observed cross-month dates preserve real checkout',()=>{
 assert.deepEqual(parsers.clickAndBoatDateRange('from 7 to 13 November 2026 (14:00 / 10:00)'),{start:'2026-11-07',end:'2026-11-13'});
 assert.deepEqual(parsers.clickAndBoatDateRange('from 28 February to 3 March 2026 (14:00 / 10:00)'),{start:'2026-02-28',end:'2026-03-03'});
 // 2026-10-04: a range shown without its start year crosses into the end year
 // (it used to fail every later collection); an explicit year is kept as shown.
 assert.deepEqual(parsers.clickAndBoatDateRange('from 28 December to 3 January 2027 (14:00 / 10:00)'),{start:'2026-12-28',end:'2027-01-03'});
 assert.deepEqual(parsers.clickAndBoatDateRange('from 28 December 2026 to 3 January 2027'),{start:'2026-12-28',end:'2027-01-03'});
 // A day rental occupies its day, protected like one night.
 assert.deepEqual(parsers.clickAndBoatDateRange('from 7 to 7 November 2026 (09:00 / 17:00)'),{start:'2026-11-07',end:'2026-11-08'});
 assert.deepEqual(parsers.samBoatDateRange('28 Dec - 03 Jan 2027'),{start:'2026-12-28',end:'2027-01-03'});
});
test('a Click&Boat order shown as Completed before its checkout fails the read instead of vanishing',()=>{
 const row={url:'https://www.clickandboat.com/uk/booking/1000002/detail',booking_id:'1000002',status:'Completed',visibleStates:['Completed'],boat_text:'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5',date_text:'from 7 to 13 November 2099 (14:00 / 10:00)',amount:'€12,705'};
 assert.throws(()=>parsers.parseClickAndBoatListRow(row,{verifiedAt:stamp}),{code:'STATUS_MISMATCH'});
 assert.equal(parsers.parseClickAndBoatListRow({...row,date_text:'from 7 to 13 November 2025 (14:00 / 10:00)'},{verifiedAt:stamp}).status,'completed');
});
test('CB collector aliases and visible states produce a net-income order and reject hidden-state concatenation',()=>{
 const row={url:'https://www.clickandboat.com/uk/booking/1000002/detail',booking_id:'1000002',status:'Accepted',visibleStates:['Accepted'],boat_text:'Catamaran Grandcat Grandcat 55 16.76mTidewyn Discovery 5',date_text:'from 7 to 13 November 2026 (14:00 / 10:00)',amount:'€12,705'};
 const record=parsers.parseClickAndBoatListRow(row,{verifiedAt:stamp});assert.equal(record.status,'accepted');assert.equal(record.boataround_slug,'grandcat-55-tidewyn-discovery-5');assert.equal(record.amount,'€12,705.00');
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,visibleStates:['Pending','Accepted','Refused']},{verifiedAt:stamp}),{code:'AMBIGUOUS_STATUS'});
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,status:'Pending Accepted Ref'},{verifiedAt:stamp}),{code:'BOOKING_STATUS'});
 assert.equal(parsers.parseClickAndBoatListRow({...row,visibleStates:['Cancelled']},{verifiedAt:stamp}).status,'cancelled');
});

test('verified Click&Boat Tidewyn Cruiser name maps only to its known #100003 boat',()=>{
 // Name/listing identity verified in the owner's platform screenshot and
 // reverse-sync/AUDIT-20260913-v7.md. This is an alias regression, not a new booking.
 const row={url:'https://www.clickandboat.com/uk/booking/990001/detail',booking_id:'990001',status:'Accepted',visibleStates:['Accepted'],
  boat_text:'Sailboat Harbor Harbor 34 Cruiser Tidewyn Cruiser',date_text:'from 7 to 13 November 2026 (14:00 / 10:00)',amount:'€100'};
 for(const extra of [{},{clickandboat_id:'100003'}]){
  const record=parsers.parseClickAndBoatListRow({...row,...extra},{verifiedAt:stamp});
  assert.equal(record.boataround_slug,'harbor-cruiser-34-tidewyn-cruise');
  assert.equal(record.status,'accepted');
 }
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,clickandboat_id:'100004'},{verifiedAt:stamp}),{code:'BOAT_MATCH'});
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,boat_text:'Tidewyn Cruiser 2'},{verifiedAt:stamp}),{code:'BOAT_MATCH'});
 assert.throws(()=>parsers.boatFromDisplayName('Tidewyn Cruiser',{source:'samboat'}),{code:'BOAT_MATCH'});
});
test('CB real detail uses status immediately after heading and precise net amount',()=>{
 const record=parsers.parseClickAndBoatDetail({bodyText:read('cb-1250578-body.txt'),url:'https://www.clickandboat.com/uk/booking/1250578/detail',boataround_slug:'seacat-open-40-tidewyn-discovery-2',verifiedAt:stamp});
 assert.equal(record.status,'accepted');assert.equal(record.amount,'€11,310.00');assert.equal(record.start,'2026-11-07');assert.equal(record.end,'2026-11-13');
});

test('CB real phone History rows render past Accepted orders as Completed with parent-state audit',()=>{
 const evidence=JSON.parse(read('cb-phone-history-completed-20260910.json'));
 const records=evidence.rows.map(row=>parsers.parseClickAndBoatListRow(row,{verifiedAt:evidence.observedAt}));
 assert.deepEqual(records.map(record=>({id:record.booking_id,status:record.status,platform:record.platform_status,parent:record.platform_parent_status,end:record.end,amount:record.amount})),[
  {id:'1274920',status:'completed',platform:'Completed',parent:'Accepted',end:'2026-05-30',amount:'€2,280.00'},
  {id:'1232398',status:'completed',platform:'Completed',parent:'Accepted',end:'2026-04-24',amount:'€7,236.00'}
 ]);
 const objectChild={...evidence.rows[0],state:'Accepted',visibleStates:[{state:'Completed',text:'Completed'}]};
 assert.equal(parsers.parseClickAndBoatListRow(objectChild,{verifiedAt:evidence.observedAt}).status,'completed');
});

test('CB Accepted to visible Completed requires checkout by the verified Beijing calendar day',()=>{
 const row={...JSON.parse(read('cb-phone-history-completed-20260910.json')).rows[0],date_text:'from 7 to 10 September 2026 (14:00 / 10:00)'};
 assert.throws(()=>parsers.parseClickAndBoatListRow(row,{verifiedAt:'2026-09-09T15:59:59.999Z'}),{code:'STATUS_MISMATCH'});
 for(const verifiedAt of ['2026-09-09T16:00:00.000Z','2026-09-10T00:00:00+08:00']){
  assert.equal(parsers.parseClickAndBoatListRow(row,{verifiedAt}).status,'completed');
 }
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,date_text:'from 7 to 13 November 2026 (14:00 / 10:00)'},{verifiedAt:stamp}),{code:'STATUS_MISMATCH'});
 assert.throws(()=>parsers.parseClickAndBoatListRow(row),{code:'VERIFIED_AT'});
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,date_text:''},{verifiedAt:stamp}),{code:'DATE_RANGE_FORMAT'});
});

test('CB historical completion exception does not broaden other state mismatches or money rules',()=>{
 const evidence=JSON.parse(read('cb-phone-history-completed-20260910.json')),row=evidence.rows[0],options={verifiedAt:evidence.observedAt};
 for(const [status,visible] of [['Pending','Completed'],['Cancelled','Completed'],['Completed','Accepted']]){
  assert.throws(()=>parsers.parseClickAndBoatListRow({...row,status,visibleStates:[visible]},options),{code:'STATUS_MISMATCH'});
 }
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,visibleStates:['Accepted','Completed']},options),{code:'AMBIGUOUS_STATUS'});
 const cancelled=parsers.parseClickAndBoatListRow({...row,status:'Cancelled',visibleStates:['Cancelled'],amount:'€0'},options);
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.platform_status,'Cancelled');assert.equal(cancelled.amount,undefined);assert.equal('platform_parent_status' in cancelled,false);
 assert.equal(parsers.parseClickAndBoatListRow({...row,amount:'€0'},options).amount,'€0.00');
 assert.throws(()=>parsers.parseClickAndBoatListRow({...row,visibleStates:['Accepted'],amount:'€0'},options),{code:'MONEY_VALUE'});
});
test('SB real visible panel distinguishes two deposits from one completed order',()=>{
 const records=JSON.parse(read('sb-visible-confirmed.json')).cards.map(card=>parsers.parseSamBoatListCard(card,{verifiedAt:stamp}));
 assert.equal(records.length,3);assert.equal(records.filter(row=>row.status==='deposit_paid').length,2);assert.equal(records.find(row=>row.booking_id==='1000001').status,'completed');
 assert.equal(records.find(row=>row.booking_id==='1502428').url,'https://www.samboat.com/private/reservation/1502428');
});
test('all saved SB card date variations parse; hidden panels must be filtered by collector',()=>{
 const cards=JSON.parse(read('sb-list-confirmed.json')).cards;assert.equal(cards.length,26);
 for(const card of cards)assert.ok(parsers.parseSamBoatListCard(card,{verifiedAt:stamp}).booking_id);
 assert.deepEqual(parsers.samBoatDateRange('06 Mar In the evening - 13 Mar 2026 in the morning'),{start:'2026-03-06',end:'2026-03-13'});
 assert.deepEqual(parsers.samBoatDateRange('22 Mar In the evening - 25 Mar 2026'),{start:'2026-03-22',end:'2026-03-25'});
});
test('SB real detail does not mistake Completed navigation step or chat history for current status',()=>{
 const record=parsers.parseSamBoatDetail(sbInput);assert.equal(record.status,'deposit_paid');assert.equal(record.amount,'$22,443.72');assert.equal(record.start,'2027-01-01');assert.equal(record.end,'2027-01-08');
 const appended=parsers.parseSamBoatDetail({...sbInput,bodyText:sbBody+'\nCancelled\nCompleted\nTo be paid online\n$1.00'});assert.equal(appended.status,'deposit_paid');assert.equal(appended.amount,'$22,443.72');
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,current_status:'completed'}),{code:'STATUS_MISMATCH'});
});

const sbPhoneBody=read('sb-phone-1502428-sanitized-20260910.txt');
test('SB observed native-phone booking card before its request heading produces current facts',()=>{
 const record=parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody});
 assert.equal(record.booking_id,'1502428');assert.equal(record.boataround_slug,'seacat-open-40-tidewyn-discovery-2');
 assert.equal(record.start,'2027-01-01');assert.equal(record.end,'2027-01-08');assert.equal(record.amount,'$22,501.68');
 assert.equal(record.amount_basis,'租客在线支付金额');assert.equal(record.status,'deposit_paid');assert.equal(record.platform_status,'Deposit paid');
 assert.equal(record.url,'https://www.samboat.com/private/reservation/1502428');
});

test('SB phone heading, navigation and progress remain mandatory and unambiguous',()=>{
 for(const bodyText of [sbPhoneBody.replace('Request n°1502428','Request n°1502429'),sbPhoneBody.replace('Request n°1502428','Request n°1502428\nRequest n°1502428')]){
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText}),{code:'DETAIL_HEADING'});
 }
 for(const bodyText of [sbPhoneBody.replace('My favorites\n',''),sbPhoneBody.replace('Back to the list of requests\n',''),sbPhoneBody.replace('\nHelp\n','\nSupport\n')]){
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText}),{code:'DETAIL_LAYOUT'});
 }
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('Pre-approve','Approve')}),{code:'DETAIL_STATUS'});
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody,current_status:'completed'}),{code:'STATUS_MISMATCH'});
 const cancelled=parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('\nDeposit paid\n','\nCancelled\n'),current_status:'cancelled'});
 assert.equal(cancelled.status,'cancelled');
});

test('SB phone boat and exactly one current date must agree; duplicate cards do not pass',()=>{
 for(const bodyText of [sbPhoneBody.replace('Seacat 40 Open','Wavecat 34 Open'),sbPhoneBody.replace('Seacat 40 Open','Unknown Model'),sbPhoneBody.replace('Seacat 40 Open','Seacat 40 Open\nSeacat 40 Open')]){
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText}),{code:'BOAT_MATCH'});
 }
 for(const extraDate of ['01 - 08 Jan 2027 in the morning','12 - 19 Feb 2027']){
  assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('10 Passengers',extraDate+'\n10 Passengers')}),{code:'DATE_RANGE_FORMAT'});
 }
 const card=sbPhoneBody.slice(sbPhoneBody.indexOf('Seacat 40 Open'),sbPhoneBody.indexOf('\nHelp'));
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('Request n°1502428\n','Request n°1502428\n'+card+'\n')}),{code:'DETAIL_LAYOUT'});
});

test('SB phone FAQ and chat cannot replace or override current dates, amounts or status',()=>{
 const noise='Seacat 40 Open\n12 - 19 Feb 2027\nTo be paid online\n$1.00\nCancelled';
 const bodyText=sbPhoneBody.replace('[FAQ omitted]',noise).replace('[contact and conversation omitted]',noise+'\nRequest n°999999\nRequest\nPre-approve\nPaid\nIn progress\nCompleted\nCancelled');
 const record=parsers.parseSamBoatDetail({...sbInput,bodyText});
 assert.equal(record.start,'2027-01-01');assert.equal(record.amount,'$22,501.68');assert.equal(record.status,'deposit_paid');
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:bodyText.replace('01 - 08 Jan 2027 in the morning\n','')}),{code:'DATE_RANGE_FORMAT'});
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:bodyText.replace('To be paid online\n$22,501.68\n','')}),{code:'MISSING_LABEL'});
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('To be paid online\n$22,501.68','To be paid online\n$0.00')}),{code:'MONEY_VALUE'});
 assert.throws(()=>parsers.parseSamBoatDetail({...sbInput,bodyText:sbPhoneBody.replace('Details of the price','To be paid online\n$1.00\nDetails of the price')}),{code:'AMBIGUOUS_LABEL'});
});
test('SB unknown card status and arbitrary URL parameters fail without guessing',()=>{
 const card=JSON.parse(read('sb-visible-confirmed.json')).cards[1];
 assert.throws(()=>parsers.parseSamBoatListCard({...card,text:card.text.replace('Validated / Deposit Paid','Some unknown state')},{verifiedAt:stamp}),{code:'BOOKING_STATUS'});
 assert.throws(()=>parsers.samBoatIdentity(card.url+'&return=https://evil.test'),{code:'ORDER_URL'});
});
test('native CB revenue CSV is enrichment only, even when amounts and dates are complete',()=>{
 const text='"No. charter","Listing title","Charter start date","Charter end date","Duration (days)","Gross amount (€)","Net amount (€)","Bank transfer",Location\n1000002,"#100007 - Grandcat 55",07-11-2026,13-11-2026,7,15000,12705,,Thailand\n';
 const [row]=parsers.parseClickAndBoatRevenueCSV(text);assert.equal(row.start,'2026-11-07');assert.equal(row.amount,'€12,705.00');assert.equal(row.requires_status_verification,true);assert.ok(!('status' in row));
});
test('money and dates fail on malformed or ambiguous evidence',()=>{
 assert.throws(()=>parsers.money('12.961,62 €'),{code:'MONEY_FORMAT'});assert.throws(()=>parsers.money('€12,961.62 $'),{code:'MONEY_CURRENCY'});
 assert.throws(()=>parsers.isoDate('2026-02-30'),{code:'DATE_VALUE'});assert.throws(()=>parsers.verifiedTimestamp('2026-09-08T12:00:00'),{code:'VERIFIED_AT'});
});
