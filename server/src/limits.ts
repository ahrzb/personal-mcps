// limits.ts — the system's spec-pinned timing constants, in one place.
//
// Tests assert THAT a deadline or window is enforced (against the injected clock
// or a shrunk constant) and reference these names, never the literals — so a
// spec change like "30 s → 45 s" is a one-line edit here with zero test churn,
// and no two modules can disagree about a number. Milliseconds throughout,
// matching every other INTEGER timestamp in the system.

/** §6 — a fresh tunnel connection must complete hub/register within this, or close 4004. */
export const REGISTRATION_DEADLINE_MS = 10_000;

/** §6/§15 — one tools/call's end-to-end budget: tunneled correlation and upstream dial alike. */
export const CALL_TIMEOUT_MS = 30_000;

/**
 * §7 — per-upstream deadline inside an aggregated tools/list fan-out.
 * Deliberately its own knob, not CALL_TIMEOUT_MS: a single slow upstream may
 * take the full 30 s when called directly, but must not hold the whole
 * aggregated listing hostage for more than this.
 */
export const AGGREGATED_LIST_DEADLINE_MS = 10_000;

/** §7 — an approval's whole life: the pending wait and the post-approval retry window. */
export const APPROVAL_WINDOW_MS = 60 * 60_000;

/** §7 — an upstream OAuth connect-flow state row's TTL. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** §15 — audit and approval rows are pruned past this age. */
export const RETENTION_DAYS = 90;
