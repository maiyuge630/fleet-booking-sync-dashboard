/**
 * Independent proposal: consumes a parsed current order and an observed prices
 * response. No browser, network, filesystem, or credential access.
 *
 * Official frontend evidence: api-inspection/public-js/3264.*.pretty.js,
 * getPrices() and requestBookingDetails() map the three TOP-LEVEL fields below.
 * A successful phone response confirms the numeric schema for booking 1000002:
 * api-inspection/clickandboat-prices-phone-1000002-20260910.json.
 * This observed sample does not establish a stable public API contract.
 * Amounts remain in API units: no currency inference, FX, rounding, or /100.
 */

const PRICE_FIELDS = Object.freeze([
  'tenantAlreadyPaidAmount',
  'tenantBalancePaymentAmount',
  'tenantTotalOnlineAmount',
]);
const INACTIVE_STATES = new Set(['cancelled', 'refused', 'expired', 'completed', 'pending']);
const evidenceKeys = [
  'customer_payment_verified',
  'customer_paid_amount',
  'customer_balance_amount',
  'customer_total_online_amount',
  'customer_payment_verification_source',
];
const fail = reason => {
  const error = new Error('Click&Boat customer payment evidence: ' + reason);
  error.name = 'ClickAndBoatPaymentError';
  error.code = 'schema_changed';
  throw error;
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} record Current, identity-checked parser output. Accepted is
 *   kept as its platform status; positive payment does not prove full payment.
 * @param {{url:string,status:number,body:object}|undefined} response Observed
 *   exact-booking JSON response, not a catchError/fallback object.
 * @returns {object} A new record; no argument is mutated.
 * @throws On unknown active state or unavailable/invalid payment evidence.
 *   Caller must fail this platform snapshot and retain its last success.
 */
export function applyClickAndBoatPaymentEvidence(record, response) {
  if (!isObject(record) || record.source !== 'clickandboat' ||
      typeof record.booking_id !== 'string' || !/^\d+$/.test(record.booking_id) ||
      record.url !== `https://www.clickandboat.com/uk/booking/${record.booking_id}/detail`) {
    fail('invalid order identity');
  }
  const result = {...record};
  // A newly observed cancellation must never carry stale positive evidence.
  for (const key of evidenceKeys) delete result[key];
  // Current cancellation/inactive state wins even if the prices request failed.
  if (INACTIVE_STATES.has(record.status)) return result;
  if (record.status !== 'accepted') fail('unsupported current order state');

  if (!isObject(response) || response.status !== 200 || typeof response.url !== 'string') {
    fail('missing successful prices response');
  }
  let endpoint;
  try { endpoint = new URL(response.url); } catch { fail('invalid prices response URL'); }
  if (endpoint.origin !== 'https://www.clickandboat.com' || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.pathname !== `/api/v6/booking/prices/${record.booking_id}` ||
      [...endpoint.searchParams].some(([key, value]) => key !== '_locale' || value !== 'en-GB') ||
      endpoint.searchParams.getAll('_locale').length > 1) {
    fail('prices response does not match the current order endpoint');
  }
  const prices = response.body;
  if (!isObject(prices)) fail('prices response is not a JSON object');
  for (const field of PRICE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(prices, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value) || descriptor.value < 0) {
      fail('invalid ' + field);
    }
  }
  const paid = prices.tenantAlreadyPaidAmount;
  return {
    ...result,
    status: paid > 0 ? 'accepted' : 'pending',
    customer_payment_verified: paid > 0,
    customer_paid_amount: paid,
    customer_balance_amount: prices.tenantBalancePaymentAmount,
    customer_total_online_amount: prices.tenantTotalOnlineAmount,
    customer_payment_verification_source: 'Click&Boat booking prices API: tenantAlreadyPaidAmount',
  };
}
