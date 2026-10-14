// The phone rewrites its whole calendar-sync ledger (with fsync) on every
// save. On 2026-10-10 it held 247 attempts in 2.77 MB, mostly copies of the
// whole calendar taken at each write, and it only grew. Detail that no rule
// reads any more is dropped when the ledger is loaded:
//  1. attempts whose dates ended more than 30 days ago (Beijing): no release,
//     confirmation or reuse rule looks at a past attempt;
//  2. a settled attempt keeps only the copied records overlapping its own
//     dates: ownership checks read just that part (ba-managed.mjs), also on
//     released Boataround days that may be closed again later
//     (permitsBoataroundReuse needs the copy to exist);
//  3. a finished attempt (released, record_missing, not_submitted,
//     reviewed_no_record) drops its release-time copy and proof.
// Attempts still being confirmed or released keep everything: their recovery
// compares neighbouring records too (executor.mjs, release.mjs).
const FINISHED = ['released', 'record_missing', 'not_submitted', 'reviewed_no_record'];
const SETTLED = ['confirmed', 'observed_protected', ...FINISHED];
export const LEDGER_KEEP_PAST_DAYS = 30;

export function compactLedger(ledger, now) {
  if (!ledger || !Array.isArray(ledger.attempts)) return ledger;
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - LEDGER_KEEP_PAST_DAYS * 86400000).toISOString().slice(0, 10);
  const overlaps = (a, b) => typeof b?.start === 'string' && typeof b?.end === 'string' && a.start < b.end && a.end > b.start;
  ledger.attempts = ledger.attempts.filter(a => !(typeof a?.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.end) && a.end < cutoff));
  for (const a of ledger.attempts) {
    if (!SETTLED.includes(a.state)) continue;
    if (Array.isArray(a.before)) a.before = a.before.filter(b => overlaps(a, b));
    if (FINISHED.includes(a.state)) { delete a.release_before; delete a.release_proof; }
  }
  return ledger;
}
