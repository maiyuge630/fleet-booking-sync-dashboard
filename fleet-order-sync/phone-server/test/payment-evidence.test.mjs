import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {applyClickAndBoatPaymentEvidence as apply} from '../../payment-evidence.mjs';
import {requirePaymentEvidence} from '../core.mjs';

// Synthetic fixtures only: these are not claimed to be platform responses.
const order = Object.freeze({
  source:'clickandboat', booking_id:'1244141', status:'accepted', platform_status:'Accepted',
  url:'https://www.clickandboat.com/uk/booking/1244141/detail',
  boataround_slug:'grandcat-55-tidewyn-discovery-5', start:'2027-01-09', end:'2027-01-16',
  amount:'€18,468', amount_basis:'船东净收入', verified_at:'2026-09-10T00:00:00.000Z',
});
const fixture = (paid=75.25, balance=124.75, total=200) => ({
  status:200,
  url:'https://www.clickandboat.com/api/v6/booking/prices/1244141?_locale=en-GB',
  body:{tenantAlreadyPaidAmount:paid, tenantBalancePaymentAmount:balance, tenantTotalOnlineAmount:total},
});
const mustFail = response => assert.throws(() => apply(order, response), {code:'schema_changed'});

test('verified positive customer payment satisfies current core gate and preserves owner income', () => {
  const response = fixture();
  const original = structuredClone(response);
  const result = apply(order, response);
  assert.notEqual(result, order);
  assert.equal(result.status, 'accepted');
  assert.equal(result.platform_status, 'Accepted');
  assert.equal(result.customer_payment_verified, true);
  assert.equal(result.customer_paid_amount, 75.25);
  assert.equal(result.customer_balance_amount, 124.75);
  assert.equal(result.customer_total_online_amount, 200);
  assert.equal(result.amount, order.amount);
  assert.equal(result.amount_basis, order.amount_basis);
  assert.deepEqual(response, original);
  assert.equal('customer_payment_verified' in order, false);
  assert.doesNotThrow(() => requirePaymentEvidence('clickandboat', {orders:[result]}));
});

test('fully paid and partial payment are both active without inventing a paid platform state', () => {
  for (const response of [fixture(200,0,200), fixture(1,199,200)]) {
    const result = apply(order, response);
    assert.equal(result.status, 'accepted');
    assert.equal(result.customer_payment_verified, true);
  }
});

test('zero customer payment turns Accepted into non-active pending, without altering platform label', () => {
  const result = apply({...order, customer_payment_verified:true, customer_paid_amount:900}, fixture(0));
  assert.equal(result.status, 'pending');
  assert.equal(result.platform_status, 'Accepted');
  assert.equal(result.customer_payment_verified, false);
  assert.equal(result.customer_paid_amount, 0);
});

test('cancellation and other known inactive states win without touching any response field', () => {
  const inaccessible = new Proxy({}, {get(){throw new Error('must not read response');}});
  for (const status of ['cancelled','refused','expired','completed','pending']) {
    const result = apply({...order, status, customer_payment_verified:true, customer_paid_amount:900}, inaccessible);
    assert.equal(result.status, status);
    assert.equal('customer_payment_verified' in result, false);
    assert.equal('customer_paid_amount' in result, false);
  }
  assert.equal(apply({...order,status:'cancelled'}).status, 'cancelled');
  assert.equal(apply({...order,status:'cancelled'},fixture(900)).status, 'cancelled');
});

test('request failure cannot become zero or reuse old payment evidence', () => {
  for (const response of [undefined,null,{},fixture()]) {
    if (response?.status === 200) response.status = 503;
    mustFail(response);
  }
  for (const status of [0,204,301,304,400,401,403,404,429,500,'200']) {
    mustFail({...fixture(),status});
  }
  assert.throws(() => apply({...order,customer_payment_verified:true,customer_paid_amount:900},undefined), {code:'schema_changed'});
});

test('only same-origin exact booking endpoint and optional single en-GB locale are accepted', () => {
  assert.equal(apply(order,{...fixture(),url:fixture().url.split('?')[0]}).status,'accepted');
  for (const url of [
    'https://www.clickandboat.com/api/v6/booking/prices/999?_locale=en-GB',
    'https://www.clickandboat.com.evil.example/api/v6/booking/prices/1244141',
    'http://www.clickandboat.com/api/v6/booking/prices/1244141',
    'https://user:customer3@example.invalid/api/v6/booking/prices/1244141',
    fixture().url+'&_locale=en-GB', fixture().url+'&token=synthetic', fixture().url+'#fragment',
    fixture().url.replace('en-GB','fr-FR'), 'not a URL',
  ]) mustFail({...fixture(),url});
});

test('three fields must be own top-level finite nonnegative numbers, with no coercion', () => {
  for (const field of Object.keys(fixture().body)) {
    for (const value of [undefined,null,'75.25','',false,NaN,Infinity,-Infinity,-1,{},[]]) {
      mustFail({...fixture(),body:{...fixture().body,[field]:value}});
    }
    const missing = fixture(); delete missing.body[field]; mustFail(missing);
  }
  for (const body of [null,[],200,'{"tenantAlreadyPaidAmount":75}',{data:fixture().body},Object.create(fixture().body)]) {
    mustFail({...fixture(),body});
  }
  const getter = {...fixture().body};
  Object.defineProperty(getter,'tenantAlreadyPaidAmount',{get(){throw new Error('must not execute getter');}});
  mustFail({...fixture(),body:getter});
});

test('no amount identity, FX, cents conversion, or rounding is presumed', () => {
  const result = apply(order,fixture(0.001,99.9,23.456));
  assert.equal(result.customer_paid_amount,0.001);
  assert.equal(result.customer_balance_amount,99.9);
  assert.equal(result.customer_total_online_amount,23.456);
  assert.equal(result.status,'accepted');
});

test('unknown state or inconsistent order identity fails instead of defaulting to Accepted', () => {
  for (const change of [
    {status:'Unknown'}, {status:'Accepted'}, {status:'paid'}, {status:undefined},
    {source:'boataround'}, {booking_id:1244141}, {booking_id:'999'}, {url:undefined},
  ]) assert.throws(() => apply({...order,...change},fixture()), {code:'schema_changed'});
});

test('real phone response for booking 1000002 confirms top-level numeric schema and separate owner income', async () => {
  const evidence = JSON.parse(await fs.readFile(new URL('../../api-inspection/clickandboat-prices-phone-1000002-20260910.json', import.meta.url), 'utf8'));
  assert.equal(evidence.observed_at, '2026-09-10T00:21:16Z');
  assert.equal(evidence.response.content_type, 'application/json');
  assert.deepEqual(Object.keys(evidence.response.body).sort(), [
    'tenantAlreadyPaidAmount','tenantBalancePaymentAmount','tenantTotalOnlineAmount',
  ].sort());
  const result = apply(evidence.matching_html_order, evidence.response);
  assert.equal(result.booking_id, '1000002');
  assert.equal(result.status, 'accepted');
  assert.equal(result.customer_payment_verified, true);
  assert.equal(result.customer_paid_amount, 3676);
  assert.equal(result.customer_balance_amount, 2540);
  assert.equal(result.customer_total_online_amount, 6216);
  assert.equal(result.amount, '€12,705.00');
  assert.equal(result.amount_basis, '船东净收入');
  assert.equal(result.start, '2026-11-07');
  assert.equal(result.end, '2026-11-13');
  assert.equal(evidence.schema_verification.raw_prices_currency_verified, false);
  assert.doesNotThrow(() => requirePaymentEvidence('clickandboat', {orders:[result]}));
});
