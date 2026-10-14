// Pure admission control. Persist each returned ledger atomically in the existing
// FleetDashboard Durable Object BEFORE launching a cloud browser. No browser or
// credentials are accessed by this module.
export const FREE_BROWSER_POLICY = Object.freeze({
  windowMs: 24 * 60 * 60 * 1000,
  maxUsageMs: 8 * 60 * 1000,
  intervalMs: 6 * 60 * 60 * 1000,
  minLaunchGapMs: 20 * 1000,
  syncWorkMs: 90 * 1000,
  loginWorkMs: 120 * 1000,
  shortLoginWorkMs: 45 * 1000,
  closeGraceMs: 5 * 1000,
  idleFallbackMs: 60 * 1000,
});

const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const kinds = new Set(['scheduled', 'manual', 'login']);

export function emptyBudgetLedger() {
  return { version: 1, records: [], lastLaunchAt: null, lastScheduledAttemptAt: null, blocked: null };
}

function checkedLedger(input) {
  if (input == null) return emptyBudgetLedger();
  if (input.version !== 1 || !Array.isArray(input.records)) throw new Error('Invalid browser budget ledger');
  for (const key of ['lastLaunchAt', 'lastScheduledAttemptAt']) {
    if (input[key] !== null && !timestamp(input[key])) throw new Error('Invalid browser budget timestamp');
  }
  const ids = new Set();
  for (const record of input.records) {
    if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || !kinds.has(record.kind)
      || !['reserved', 'closed', 'uncertain', 'not-launched'].includes(record.status)
      || !['startedAt', 'workDeadlineAt', 'safeCloseAt', 'chargedUntilAt', 'chargedMs', 'reservedMs'].every(key => timestamp(record[key]))
      || record.reservedMs <= 0 || record.workDeadlineAt < record.startedAt
      || record.safeCloseAt < record.workDeadlineAt || record.chargedUntilAt < record.startedAt) {
      throw new Error('Invalid browser budget record');
    }
    ids.add(record.id);
  }
  return structuredClone(input);
}

export function budgetSnapshot(input, now) {
  if (!timestamp(now)) throw new Error('Invalid current time');
  const ledger = checkedLedger(input);
  const liveRecords = ledger.records.filter(record => record.chargedUntilAt + FREE_BROWSER_POLICY.windowMs > now);
  const chargedMs = liveRecords.reduce((sum, record) => sum + record.chargedMs, 0);
  const active = liveRecords.find(record => ['reserved', 'uncertain'].includes(record.status) && now < record.safeCloseAt);
  const remainingMs = Math.max(0, FREE_BROWSER_POLICY.maxUsageMs - chargedMs);
  const loginReservationMs = FREE_BROWSER_POLICY.loginWorkMs + FREE_BROWSER_POLICY.closeGraceMs + FREE_BROWSER_POLICY.idleFallbackMs;
  let nextLoginAt = null;
  if (!ledger.blocked && remainingMs < loginReservationMs) {
    let projectedCharge = chargedMs;
    const expirations = liveRecords.map(record => ({ at: record.chargedUntilAt + FREE_BROWSER_POLICY.windowMs, charge: record.chargedMs }))
      .sort((a, b) => a.at - b.at);
    for (const event of expirations) {
      projectedCharge -= event.charge;
      if (FREE_BROWSER_POLICY.maxUsageMs - projectedCharge >= loginReservationMs) {
        nextLoginAt = event.at;
        break;
      }
    }
  }
  return { chargedMs, remainingMs, nextLoginAt, activeRunId: active?.id ?? null, blocked: ledger.blocked ?? null };
}

export function nextScheduledAttemptAt(input, now) {
  if (!timestamp(now)) throw new Error('Invalid current time');
  const ledger = checkedLedger(input);
  return ledger.lastScheduledAttemptAt === null ? now : Math.max(now, ledger.lastScheduledAttemptAt + FREE_BROWSER_POLICY.intervalMs);
}

export function recordScheduledAttempt(input, now) {
  if (!timestamp(now)) throw new Error('Invalid current time');
  const ledger = checkedLedger(input);
  if (ledger.lastScheduledAttemptAt === null || now >= ledger.lastScheduledAttemptAt + FREE_BROWSER_POLICY.intervalMs) {
    ledger.lastScheduledAttemptAt = now;
  }
  return ledger;
}

export function reserveBrowserRun(input, { id, kind = 'scheduled', now, shortLogin = false }) {
  if (!timestamp(now) || typeof id !== 'string' || !id || !kinds.has(kind)) throw new Error('Invalid browser run request');
  const ledger = checkedLedger(input);
  const policy = FREE_BROWSER_POLICY;
  const deny = (reason, retryAt = null) => ({ allowed: false, reason, retryAt, ledger });
  if (ledger.records.some(record => record.id === id)) return deny('duplicate_run');
  if (ledger.blocked) return deny('budget_suspended');
  if (kind === 'scheduled' && ledger.lastScheduledAttemptAt !== null && now < ledger.lastScheduledAttemptAt + policy.intervalMs) {
    return deny('schedule_not_due', ledger.lastScheduledAttemptAt + policy.intervalMs);
  }
  // A due but skipped scheduled attempt still waits six hours. There is no
  // immediate retry loop when a platform is down or the daily allowance is gone.
  if (kind === 'scheduled') ledger.lastScheduledAttemptAt = now;
  const snapshot = budgetSnapshot(ledger, now);
  if (snapshot.activeRunId) {
    return deny('session_in_progress', ledger.records.find(record => record.id === snapshot.activeRunId).safeCloseAt);
  }
  if (ledger.lastLaunchAt !== null && now < ledger.lastLaunchAt + policy.minLaunchGapMs) {
    return deny('launch_rate_limit', ledger.lastLaunchAt + policy.minLaunchGapMs);
  }
  const workMs = kind === 'login'
    ? (shortLogin === true ? policy.shortLoginWorkMs : policy.loginWorkMs)
    : policy.syncWorkMs;
  const reservedMs = workMs + policy.closeGraceMs + policy.idleFallbackMs;
  if (snapshot.remainingMs < reservedMs) {
    return deny('daily_budget', kind === 'scheduled' ? now + policy.intervalMs : null);
  }
  // Expire whole runs only 24h after their latest possible billable end, rather
  // than resetting at midnight. This is conservative across quota-day boundaries.
  ledger.records = ledger.records.filter(record => record.chargedUntilAt + policy.windowMs > now);
  const record = {
    id, kind, status: 'reserved', startedAt: now,
    workDeadlineAt: now + workMs,
    safeCloseAt: now + reservedMs,
    chargedUntilAt: now + reservedMs,
    reservedMs, chargedMs: reservedMs,
  };
  ledger.records.push(record);
  ledger.lastLaunchAt = now;
  return { allowed: true, ledger, reservation: structuredClone(record), nextAttemptAt: kind === 'scheduled' ? now + policy.intervalMs : null };
}

export function settleBrowserRun(input, { id, now, closed = false, definitelyNotLaunched = false, confirmedAbsent = false, providerClosedAt = null }) {
  if (!timestamp(now)) throw new Error('Invalid current time');
  const ledger = checkedLedger(input);
  const record = ledger.records.find(item => item.id === id);
  if (!record) throw new Error('Unknown browser run');
  if (['closed', 'not-launched'].includes(record.status)) return ledger;
  if (now < record.startedAt || [closed, definitelyNotLaunched, confirmedAbsent].filter(Boolean).length > 1) throw new Error('Invalid browser run settlement');
  if (providerClosedAt !== null && (!confirmedAbsent || !timestamp(providerClosedAt)
    || providerClosedAt < record.startedAt || providerClosedAt > now)) throw new Error('Invalid provider close evidence');
  if (definitelyNotLaunched) {
    // Use only before calling launch, never after an ambiguous launch response.
    record.status = 'not-launched';
    record.chargedMs = 0;
    record.chargedUntilAt = now;
    record.safeCloseAt = now;
    record.workDeadlineAt = now;
  } else if (closed) {
    record.status = 'closed';
    // Include startup time and round conservatively after explicit browser.close.
    record.chargedMs = Math.ceil((now - record.startedAt) / 1000) * 1000 + FREE_BROWSER_POLICY.closeGraceMs;
    record.chargedUntilAt = now + FREE_BROWSER_POLICY.closeGraceMs;
    if (record.chargedMs > record.reservedMs) ledger.blocked = 'runtime_exceeded_reservation';
  } else if (confirmedAbsent) {
    // The provider lists no such session, but its exact close time is unknown.
    // Retain the entire reservation; no additional idle tail is possible now.
    record.status = 'uncertain';
    record.chargedMs = Math.max(record.chargedMs, now - record.startedAt);
    record.chargedUntilAt = Math.max(record.chargedUntilAt, now);
    record.safeCloseAt = now;
    // A failed early operation may disappear before its planned work deadline.
    // End that work window too, preserving ledger invariants and the full charge.
    record.workDeadlineAt = Math.min(record.workDeadlineAt, now);
    if (providerClosedAt !== null) {
      // Only the controller's exact-session closed history proof may replace an
      // uncertain reservation. Include launch latency and a 5s billing margin.
      record.status = 'closed';
      record.chargedMs = Math.ceil((providerClosedAt - record.startedAt) / 1000) * 1000 + FREE_BROWSER_POLICY.closeGraceMs;
      record.chargedUntilAt = now + FREE_BROWSER_POLICY.closeGraceMs;
    }
    if (record.chargedMs > record.reservedMs) ledger.blocked = 'runtime_exceeded_reservation';
  } else {
    record.status = 'uncertain';
    // Do not credit failed close, worker restart, or an ambiguous launch error.
    // If commands ran past the work deadline, allow another entire idle timeout.
    record.chargedUntilAt = Math.max(record.safeCloseAt, now + FREE_BROWSER_POLICY.idleFallbackMs);
    record.safeCloseAt = record.chargedUntilAt;
    record.chargedMs = Math.max(record.reservedMs, record.chargedUntilAt - record.startedAt);
    if (record.chargedMs > record.reservedMs) ledger.blocked = 'runtime_exceeded_reservation';
  }
  return ledger;
}

export function nextCoordinatorAlarm({ now, nextSyncAt, activeDeadlineAt = null }) {
  if (!timestamp(now) || !timestamp(nextSyncAt) || (activeDeadlineAt !== null && !timestamp(activeDeadlineAt))) throw new Error('Invalid coordinator alarm');
  return Math.max(now + 1000, Math.min(nextSyncAt, activeDeadlineAt ?? Infinity));
}
