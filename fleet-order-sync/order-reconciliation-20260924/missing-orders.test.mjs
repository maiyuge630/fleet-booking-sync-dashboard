import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseBoataroundDetail} from '../parsers.mjs';
const evidence=JSON.parse(fs.readFileSync(new URL('./independent-audit.json',import.meta.url)));
// Redacted visible-field excerpts from the two independently opened orders.
const excerpts=[`#319580 - Bluecat 42 | Tidewyn Discovery 3
Booking status
NEW
Customer payment
PARTIALLY PAID
Agency payment
NOT PAID
Boat
Bluecat 42 | Tidewyn Discovery 3
Date
24 Jan 2027 - 30 Jan 2027
Client price
5,382 €
Payments
Amount payable to Tidewyn Marine\t4,575.46 €
Client price\t5,382 €
Agency price\t4,575.46 €`,
`#317743 - Coastline Sea Journey 42 | Tidewyn Cruise 2
Booking status
IN PROCESS
Customer payment
PARTIALLY PAID
Agency payment
PARTIALLY PAID
Boat
Coastline Sea Journey 42 | Tidewyn Cruise 2
Date
24 Nov 2026 - 30 Nov 2026
Client price
7,971 €
Payments
Amount payable to Tidewyn Marine\t1,581.01 €
23 Sep 2026\tPAID\t677.58 €
Client price\t7,971 €
Agency price\t6,775.77 €`];
test('actual missed Boataround orders preserve customer payment and total net price, not owner balance',()=>{
 evidence.missing_before.forEach((e,i)=>{
  const r=parseBoataroundDetail({bodyText:excerpts[i],url:e.url,verifiedAt:'2026-09-24T05:00:00Z'});
  assert.equal(r.booking_id,e.id);assert.equal(r.start,e.start);assert.equal(r.end,e.end);
  assert.equal(r.status,'deposit_paid');assert.equal(r.platform_status,e.platform_status);
  assert.equal(r.customer_payment,'PARTIALLY PAID');assert.equal(r.agency_payment,e.agency_payment);
  assert.equal(r.amount,i===0?'€4,575.46':'€6,775.77');
 });
});
