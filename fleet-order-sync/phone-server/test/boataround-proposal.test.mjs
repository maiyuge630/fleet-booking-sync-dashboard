import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchBoataroundParser,verifyBoataroundPaginationEvidence} from '../boataround-parser-proposal.mjs';

// Historical proposal: apply its original anchors to the archived parser it
// targeted, rather than applying an old patch to today's production parser.
const original=await fs.readFile(new URL('./fixtures/boataround-parser-before-cancellation.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'19166c9c7f437a26691bd2c9741f9d5e5571ee59ec54bc7b6a76aa8762a82422');
const candidate=patchBoataroundParser(original);
const parsers=await import('data:text/javascript;base64,'+Buffer.from(candidate).toString('base64'));
const url='https://partner.boataround.com/en/000000000000000000000000/orders/000000000000000000000001';
const stamp='2026-09-10T00:08:58.438Z';
const row={status:'CONFIRMED',booking:'#1\nWavecat 34 Open | Tidewyn Dream',url,dates:'17 Oct 2026 - 24 Oct 2026',times:[]};
const detail=status=>'#1 - Wavecat 34 Open | Tidewyn Dream\nBoat\nWavecat 34 Open | Tidewyn Dream\nDate\n17 Oct 2026 - 24 Oct 2026\nBooking status\n'+status;

test('only confirmed plus explicit paid/deposit remains active; all known inactive labels stay inactive',()=>{
  assert.equal(parsers.boataroundStatus('Confirmed','Paid'),'paid');
  assert.equal(parsers.boataroundStatus('Confirmed','Partially paid'),'deposit_paid');
  for(const payment of ['Not paid','UNPAID','Refunded'])assert.equal(parsers.boataroundStatus('Confirmed',payment),'pending');
  for(const status of ['New','In process'])assert.equal(parsers.boataroundStatus(status,'PAID'),'pending');
  assert.equal(parsers.boataroundStatus('Cancelled','PAID'),'cancelled');
  assert.equal(parsers.boataroundStatus('Completed','PAID'),'completed');
  assert.throws(()=>parsers.boataroundStatus('Confirmed','Unknown'),{code:'PAYMENT_STATUS'});
  assert.throws(()=>parsers.boataroundStatus('Unknown','Paid'),{code:'BOOKING_STATUS'});
});
test('explicit visible dates are used when no time elements exist, while partial or contradictory elements fail',()=>{
  const parsed=parsers.parseBoataroundListRow(row,{verifiedAt:stamp});assert.equal(parsed.start,'2026-10-17');assert.equal(parsed.status,undefined);assert.equal(parsed.requires_detail,true);
  assert.throws(()=>parsers.parseBoataroundListRow({...row,times:[{datetime:'2026-10-17T00:00:00Z',text:'17 Oct 2026'}]},{verifiedAt:stamp}),{code:'DATE_RANGE_FORMAT'});
  assert.throws(()=>parsers.parseBoataroundListRow({...row,times:[{datetime:'2026-10-17T00:00:00Z',text:'18 Oct 2026'},{datetime:'2026-10-24T00:00:00Z',text:'24 Oct 2026'}]},{verifiedAt:stamp}),{code:'DATE_MISMATCH'});
});
test('new and in-process list rows are included as non-active rather than aborting the entire platform',()=>{
  for(const status of ['NEW','IN PROCESS'])assert.equal(parsers.parseBoataroundListRow({...row,status},{verifiedAt:stamp}).status,'pending');
});
test('cancelled details do not require absent price/payment sections; confirmed paid details still require money',()=>{
  assert.equal(parsers.parseBoataroundDetail({bodyText:detail('Cancelled'),url,verifiedAt:stamp}).status,'cancelled');
  const refunded=parsers.parseBoataroundDetail({bodyText:detail('Confirmed')+'\nCustomer payment\nRefunded',url,verifiedAt:stamp});
  assert.equal(refunded.status,'pending');assert.equal(refunded.customer_payment,'REFUNDED');
  assert.throws(()=>parsers.parseBoataroundDetail({bodyText:detail('Confirmed')+'\nCustomer payment\nPaid',url,verifiedAt:stamp}),{code:'MISSING_LABEL'});
  assert.throws(()=>parsers.parseBoataroundDetail({bodyText:detail('Confirmed'),url,verifiedAt:stamp}),{code:'MISSING_LABEL'});
});
test('historical verified paid detail and full 11-row saved page still pass unchanged',async()=>{
  const bodyText=await fs.readFile(new URL('../../evidence/ba-280707-body.txt',import.meta.url),'utf8');
  const record=parsers.parseBoataroundDetail({bodyText,url:'https://partner.boataround.com/en/000000000000000000000000/orders/b386b5a4271f3a72a26a93d0',verifiedAt:stamp});
  assert.equal(record.status,'deposit_paid');assert.equal(record.amount,'€14,086.50');assert.equal(record.start,'2026-10-17');
  const rows=JSON.parse(await fs.readFile(new URL('../../evidence/ba-list-page3.json',import.meta.url),'utf8')).rows;
  assert.equal(rows.map(row=>parsers.parseBoataroundListRow(row,{verifiedAt:stamp})).length,11);
});
function evidence(count=51){return {final_count:count,pages:Array.from({length:Math.max(1,Math.ceil(count/20))},(_,page)=>({
  request_url:'https://partner-api.boataround.com/v1/charters/000000000000000000000000/orders?lang=en_GB&offset='+page*20+'&limit=20',count,
  ids:Array.from({length:Math.max(0,Math.min(20,count-page*20))},(_,index)=>(page*20+index+1).toString(16).padStart(24,'0'))
}))};}
test('actual count plus 20/20/11 distinct response identities proves declared 3-page coverage',()=>{
  assert.deepEqual(verifyBoataroundPaginationEvidence(evidence()),{complete:true,total_pages:3,pages_read:[1,2,3],listed_count:51});
});
test('first page alone, hidden status filters, repeated ids, changing counts, and mismatched offsets are refused',()=>{
  for(const change of [
    e=>{e.pages=e.pages.slice(0,1);},e=>{e.pages[0].request_url+='&bookingStatuses=CONFIRMED';},
    e=>{e.pages[1].ids[0]=e.pages[0].ids[0];},e=>{e.pages[1].count=52;},
    e=>{e.final_count=52;},e=>{e.pages[1].request_url=e.pages[0].request_url;}
  ]){const input=evidence();change(input);assert.throws(()=>verifyBoataroundPaginationEvidence(input),{code:'incomplete_pages'});}
});
test('real explicit empty response may pass; missing count does not become empty',()=>{
  assert.equal(verifyBoataroundPaginationEvidence(evidence(0)).listed_count,0);
  const unknown=evidence(0);delete unknown.pages[0].count;assert.throws(()=>verifyBoataroundPaginationEvidence(unknown),{code:'incomplete_pages'});
});
test('proposal does not modify unrelated parsers and refuses a second application',()=>{
  const boundary='export function clickAndBoatStatus';assert.equal(candidate.slice(candidate.indexOf(boundary)),original.slice(original.indexOf(boundary)));
  assert.throws(()=>patchBoataroundParser(candidate));
});
