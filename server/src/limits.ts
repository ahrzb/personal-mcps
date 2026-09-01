// limits.ts — the system's spec-pinned constants (timings and sizes), in one place.
//
// Tests assert THAT a deadline, window, or cap is enforced (against the injected
// clock or a shrunk constant) and reference these names, never the literals — so a
// spec change like "30 s → 45 s" is a one-line edit here with zero test churn,
// and no two modules can disagree about a number. Durations are milliseconds
// throughout, matching every other INTEGER timestamp in the system.

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

/**
 * §15 — audit and approval rows are pruned past this age. Deliberately short:
 * whatever the audit table holds, audit_query can read, so retention is the
 * primary bound on body exposure (the JSONL export is the archive path). The
 * DEFAULT only — the AUDIT_RETENTION_DAYS env var overrides, parsed once by the
 * composition root.
 */
export const RETENTION_DAYS = 7;

/**
 * §5/§8 — the default life of a `pmcp_sa_` token: 90 days. Service tokens have no
 * default expiry at all (the telegram-bot model, §18 decision 12), which is why only
 * one of the two kinds has a constant here — the other's default is the absence of one.
 */
export const SERVICE_ACCOUNT_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;

/**
 * §5 — how coarse `token.last_used_at` is: a successful resolve advances it at most
 * once per this window, so the column is a rotation/staleness signal (§15) rather than
 * a write on every request.
 */
export const TOKEN_LAST_USED_STAMP_MS = 60 * 60_000;

/**
 * §13 — the RFC 8628 device code's life, cut from better-auth's 30-minute default: the
 * user-code channel is unauthenticated, so the window a phished code stays redeemable in
 * is the thing being shortened.
 */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;

/** §6 — a role pattern string may be at most this long. */
export const ROLE_PATTERN_MAX_LENGTH = 128;

/** §6 — a role may declare at most this many patterns. */
export const ROLE_PATTERNS_MAX = 64;

/** §6 — a role name may be at most this long (charset is [a-z0-9_-], registry's rule). */
export const ROLE_NAME_MAX_LENGTH = 64;

/**
 * §15 — the per-body size cap on the audit `args_json` / `result_json` columns:
 * an over-cap body is replaced whole by an `oversize` stub, never truncated into
 * corrupt JSON. The DEFAULT only — the AUDIT_BODY_CAP_BYTES env var overrides,
 * parsed once by the composition root.
 */
export const AUDIT_BODY_CAP_BYTES = 16 * 1024;

/**
 * §20.4 — a resource URI's `tool` column, after its query component is dropped and
 * replaced with `audit.REDACTED_QUERY`, is capped at this many UTF-8 bytes — like every
 * other caller-supplied string the hub persists, and unlike AUDIT_BODY_CAP_BYTES: this is
 * the `tool` column, not a body. No env override exists for it (§15's env knobs are the
 * body cap and retention alone).
 */
export const AUDIT_URI_CAP_BYTES = 1024;

/**
 * §21.1 — an idle listen stream's keepalive cadence: one SSE comment per this
 * interval, and the stream's re-authorization tick (§21.2) — the revocation
 * window equals the keepalive window.
 */
export const LISTEN_KEEPALIVE_MS = 15_000;

/** §21.3 — the doorbell floor: a change inside this window after a family's leading ring is suppressed and coalesced into one trailing ring at the window's end. */
export const LISTEN_BELL_MIN_INTERVAL_MS = 1_000;

/**
 * §21.4 — at most this many subscribed URIs per subscriber socket, each bounded
 * by SUBSCRIBE_URI_MAX_BYTES: the caps' product keeps the attachment far inside
 * serializeAttachment's 16 KB (§5).
 */
export const LISTEN_SUBSCRIPTIONS_MAX = 6;

/** §21.4 — a subscribed URI may be at most this many UTF-8 BYTES (the AUDIT_URI_CAP_BYTES discipline, §20.4). */
export const SUBSCRIBE_URI_MAX_BYTES = 2048;

/**
 * §21.2 — at most this many DO subscriber sockets one stream opens, services
 * taken in deterministic slug order. The platform documents six simultaneous
 * open connections per invocation; the gate's live measurement can only LOWER
 * this, never raise it.
 */
export const LISTEN_FANOUT_MAX = 6;