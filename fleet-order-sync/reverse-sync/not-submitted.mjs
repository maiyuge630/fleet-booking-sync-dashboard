// Errors an adapter raises before its first platform request of a write or a
// release (2026-10-04 review). Without this mark the executor had to treat the
// intent as uncertain forever: a write stayed "submitting" and its dates were
// never closed; a release stayed "releasing" and its target needed review for
// good. Only code that has provably not sent anything may be wrapped.
export async function beforeRequest(step) {
  try { return await step(); }
  catch (error) { throw Object.assign(error instanceof Error ? error : Error(String(error)), {notSubmitted: true}); }
}
