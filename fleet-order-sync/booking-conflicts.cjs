'use strict';

// Input is the registry's normalized order record, not public availability.
// Keep this function self-contained: the UI also uses its toString() source.
function bookingIdentity(booking) {
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) return null;
  const source = typeof booking.source === 'string' ? booking.source.trim() : '';
  const value = booking.booking_id;
  if (!source || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(source) ||
      !(typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return null;
  const id = String(value).trim();
  return id ? source + ':' + id : null;
}

// Each invocation receives ONE boat's normalized bookings. Intervals are
// Checkout is occupied through the whole day. A same-day check-in conflicts.
// Helpers stay inside the function for independent browser serialization.
function findBookingConflicts(bookings, today) {
  const empty = {pairs: [], bookingKeys: []};
  const identity = booking => {
    if (!booking || typeof booking !== 'object' || Array.isArray(booking)) return null;
    const source = typeof booking.source === 'string' ? booking.source.trim() : '';
    const value = booking.booking_id;
    if (!source || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(source) ||
        !(typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return null;
    const id = String(value).trim();
    return id ? source + ':' + id : null;
  };
  const day = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  };
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const boundary = day(today);
  if (!Array.isArray(bookings) || boundary === null) return empty;

  const cancelled = new Set(), candidates = [];
  for (const booking of bookings) {
    const key = identity(booking);
    if (!key) continue;
    // Preserve a final cancellation even if a caller includes a stale paid
    // duplicate. Normally the upstream registry already removes that copy.
    if (booking.status === 'cancelled' || booking.status === 'canceled') cancelled.add(key);
    if (!['accepted', 'deposit_paid', 'paid'].includes(booking.status)) continue;
    const start = day(booking.start), end = day(booking.end);
    if (start === null || end === null || end < start ||
        end === start && booking.source !== 'samboat' || end < boundary) continue;
    candidates.push({key, start, end:end+86400000, booking});
  }
  // Stable byte ordering avoids host locale differences. The registry normally
  // supplies one record per identity; equivalent repeated copies count once.
  candidates.sort((a, b) => compare(a.key, b.key) || a.start - b.start || a.end - b.end ||
    compare(a.booking.status, b.booking.status) || compare(String(a.booking.url || ''), String(b.booking.url || '')));
  const unique = new Map();
  for (const item of candidates) if (!cancelled.has(item.key) && !unique.has(item.key)) unique.set(item.key, item);
  const orders = [...unique.values()], pairs = [], affected = new Set();
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const a = orders[i], b = orders[j];
      const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
      if (start >= end || end <= boundary) continue;
      pairs.push({key: JSON.stringify([a.key, b.key]), start: new Date(start).toISOString().slice(0, 10),
        end: new Date(end).toISOString().slice(0, 10), nights: (end - start) / 86400000,
        bookings: [a.booking, b.booking]});
      affected.add(a.key); affected.add(b.key);
    }
  }
  pairs.sort((a, b) => compare(a.start, b.start) || compare(a.end, b.end) || compare(a.key, b.key));
  return {pairs, bookingKeys: [...affected].sort(compare)};
}

const BOOKING_CONFLICTS_SCRIPT = bookingIdentity.toString() + '\n' + findBookingConflicts.toString() + '\n';
module.exports = {findBookingConflicts, bookingIdentity, BOOKING_CONFLICTS_SCRIPT};
