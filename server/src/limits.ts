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

/**
 * §13 — the owner listing's own deadline: one `/apps/<slug>` catalog read, bounded so a
 * silent upstream renders the unread marker instead of holding the answer open. Distinct
 * from CALL_TIMEOUT_MS, which is one FETCH's budget and would let a dead endpoint hold a
 * page-driven read for 30 s, and from AGGREGATED_LIST_DEADLINE_MS, which bounds one
 * upstream inside a fan-out rather than a single named app's listing.
 */
export const OWNER_CATALOG_DEADLINE_MS = 5_000;

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
 * §5/§8 — the default life of a `pmcp_agt_` token: 90 days. App tokens have no
 * default expiry at all (the telegram-bot model, §18 decision 12), which is why only
 * one of the two kinds has a constant here — the other's default is the absence of one.
 */
export const AGENT_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;

/**
 * §22.1 — the fixed, non-sliding default life of a `pmcp_adm_` admin token: 365 days.
 * Non-sliding like AGENT_TOKEN_TTL_MS, not unlike it: both deadlines are set once at
 * issuance and only `last_used_at` moves afterwards. The credential this is deliberately
 * unlike is a better-auth session, whose `expiresAt` IS pushed forward on use — an admin
 * token is not a session, and its rotation is issue-then-revoke by a human, never a
 * refresh. A default, not a maximum: an explicit `expires_in` or `"never"` overrides it.
 */
export const ADMIN_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000;

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
 * §15/§13 — the most body-less audit rows §13's explorer loads for one window, and what the
 * window read echoes as its `ceiling` so the page's "showing the newest N of M" notice
 * carries no second literal of this number. A READ bound, never a bound on the table:
 * retention above stays the only limit on what the ledger holds, and the JSONL export stays
 * unbounded — which is why the page points at the export on reaching this rather than
 * loading more.
 */
export const AUDIT_EXPLORER_ROWS = 5_000;

/**
 * §15/§13 — one window request's worth of those rows: the page fetches page 0, then the
 * rest up to AUDIT_EXPLORER_ROWS in parallel. Its own knob rather than the ceiling divided
 * by a fixed count, because the two answer different questions — how much one response may
 * cost, and how much one window may be.
 */
export const AUDIT_EXPLORER_PAGE = 1_000;

/**
 * §13 — the most filter VALUES one JSONL export link may carry across all of its repeated
 * keys, a `target` pair counting two because it binds two. The reason is D1's, not a
 * policy: a prepared statement binds at most 100 parameters, and the export's own statement
 * already spends some on the namespace, the window pair, `text`'s eight columns, the seek
 * key and the chunk limit — so this leaves that fixed cost a wide margin under the hundred.
 * The page's facet rail can tick more values than this (a namespace may hold more tools than
 * that), which is why the export ROUTE refuses at the boundary with a sentence: the
 * alternative is a D1 error partway through a download.
 */
export const AUDIT_EXPORT_MAX_VALUES = 64;

/**
 * §15/§13 — how many characters of the STORED args JSON a body-less read returns in place
 * of the arguments column (`audit.AuditSlimRow.argsHead`). Characters, not bytes: it is a
 * `substr` in SQL over text the hub itself serialized, and the value is a one-line preview
 * for a reader, never a body. The rows either side of it are AUDIT_BODY_CAP_BYTES, which
 * bounds what may be STORED — this bounds only what a listing ships.
 */
export const AUDIT_ARGS_HEAD_CHARS = 160;

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
 * §21.2 — at most this many DO subscriber sockets one stream opens, apps
 * taken in deterministic slug order. The platform documents six simultaneous
 * open connections per invocation; the gate's live measurement can only LOWER
 * this, never raise it.
 */
export const LISTEN_FANOUT_MAX = 6;

// ── the hub execution plane (§23) ─────────────────────────────────────────────────────
//
// One UPPER_SNAKE constant per §23.11 cap — the names runtime callsites read — then the
// grouped record the wire fixture and the tool-schema bounds consume. Durations are
// milliseconds; byte caps are UTF-8 bytes.

/** §23.2 — smallest accepted `timeout_ms`, in milliseconds (the inclusive lower bound). */
export const HUB_MIN_TIMEOUT_MS = 1_000;

/** §23.11 — outer wall clock when neither a settings row nor `timeout_ms` selects one, in milliseconds. */
export const HUB_DEFAULT_TIMEOUT_MS = 30_000;

/** §23.11 — the maximum a new settings row starts with, before the owner raises it, in milliseconds. */
export const HUB_INITIAL_MAX_TIMEOUT_MS = 30_000;

/** §23.11 — compiled ceiling for any owner setting or `timeout_ms`, in milliseconds. */
export const HUB_HARD_MAX_TIMEOUT_MS = 300_000;


/** §23.11 — per-inner-operation cap when the remaining outer budget is larger, in milliseconds. */
export const HUB_INNER_OPERATION_TIMEOUT_MS = 10_000;

/** §23.11 — maximum QuickJS heap allocated by one execution, in bytes. */
export const HUB_QUICKJS_MEMORY_MAX_BYTES = 16_777_216;

/** §23.4/§23.11 — tail budget reserved for the mandatory final credential reauthorization. */
export const HUB_FINAL_REAUTH_RESERVE_MS = 500;

/** §23.11 — maximum QuickJS interpreter stack allocated by one execution, in bytes. */
export const HUB_QUICKJS_STACK_MAX_BYTES = 65_536;

/** §23.9/§23.11 — maximum QuickJS interrupt callbacks across compilation and execution.
 * Cloudflare freezes wall clocks during CPU work, so this deterministic budget is the
 * backstop for non-yielding guest bytecode. */
export const HUB_QUICKJS_INTERRUPT_MAX = 10_000;

/** §23.11 — maximum TypeScript diagnostics returned for one rejected program. */
export const HUB_DIAGNOSTIC_MAX = 20;

/** §23.11 — maximum UTF-8 bytes returned for one diagnostic or exception message. */
export const HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES = 2_048;

/** §23.11 — maximum UTF-8 bytes returned for one guest exception stack. */
export const HUB_RUNTIME_STACK_MAX_BYTES = 8_192;

/** §23.5 — per-FAMILY deadline while the hub's catalog collector reads one service's tools,
 *  resources or resource templates: a slow family is omitted from the caller's snapshot with
 *  a bounded diagnostic rather than delaying the whole request past any useful bound. */
export const HUB_CATALOG_FAMILY_DEADLINE_MS = 3_000;

/** §23.11 — largest submitted source, in UTF-8 bytes; a larger source is refused with -32602. */
export const HUB_SOURCE_MAX_BYTES = 65_536;

/** §23.11 — largest search query before trimming, in UTF-8 bytes (the wire `maxLength` counts UTF-16 code units). */
export const HUB_QUERY_MAX_BYTES = 256;

/** §23.11 — largest caller-visible catalog, in entries; overflow refuses `execute` before runtime creation and truncates `search_types`. */
export const HUB_CATALOG_MAX_ENTRIES = 256;

/** §23.11 — largest raw schema/catalog payload retained for one snapshot, in bytes. */
export const HUB_CATALOG_MAX_BYTES = 2_097_152;

/** §23.11 — largest single canonical subject — service, tool, or raw URI identity — in UTF-8 bytes. */
export const HUB_SUBJECT_MAX_BYTES = 8_192;

/** §23.11 — largest indexed description, in UTF-8 bytes. */
export const HUB_DESCRIPTION_MAX_BYTES = 4_096;

/** §23.11 — largest single input/output schema, in UTF-8 bytes. */
export const HUB_SCHEMA_MAX_BYTES = 65_536;

/** §23.11 — deepest schema nesting the renderer walks; deeper schemas render `unknown` with a diagnostic. */
export const HUB_SCHEMA_MAX_DEPTH = 64;

/** §23.11 — largest node count a rendered schema may have. */
export const HUB_SCHEMA_MAX_NODES = 10_000;

/** §23.11 — largest generated declaration text, in bytes; overflow renders a diagnostic banner and an `unknown` root. */
export const HUB_DECLARATION_MAX_BYTES = 1_048_576;

/** §23.11 — largest admitted inner operations per execution; the next one is refused, never queued past the deadline. */
export const HUB_INNER_OPERATIONS_MAX = 32;

/** §23.11 — largest inner operations in flight at once; a fifth is refused immediately. */
export const HUB_INNER_CONCURRENCY_MAX = 4;

/** §23.11 — largest serialized host-call arguments, in bytes. */
export const HUB_HOST_ARGUMENTS_MAX_BYTES = 262_144;

/** §23.11 — largest serialized host-call response, in bytes. */
export const HUB_HOST_RESPONSE_MAX_BYTES = 1_048_576;

/** §23.11 — largest stdout returned, in bytes; excess sets `stdoutTruncated`. */
export const HUB_STDOUT_MAX_BYTES = 65_536;

/** §23.11 — largest stderr returned, in bytes; excess sets `stderrTruncated`. */
export const HUB_STDERR_MAX_BYTES = 65_536;

/** §23.11 — largest serialized program return value accepted, in bytes. */
export const HUB_RESULT_MAX_BYTES = 262_144;

/** §23.11 — `search_types` `limit` when the caller omits it. */
export const HUB_SEARCH_LIMIT_DEFAULT = 10;

/** §23.11 — largest `search_types` `limit` accepted. */
export const HUB_SEARCH_LIMIT_MAX = 50;

/** §23.11 — largest serialized `search_types` response, in bytes; excess truncates to the canonical prefix. */
export const HUB_SEARCH_RESPONSE_MAX_BYTES = 262_144;


/**
 * §23.11 — the grouped shape of the hub caps. Its field values are the UPPER_SNAKE
 * constants directly above; HUB_CONTRACT_LIMITS assembles them for the wire fixture and
 * the tool-schema bounds, which must not repeat a literal.
 */
export type HubContractLimits = {
  /** Smallest accepted `timeout_ms`, in milliseconds — §23.2's inclusive lower bound. */
  readonly minTimeoutMs: number;
  /** Outer wall clock when neither a settings row nor `timeout_ms` selects one, in milliseconds. */
  readonly defaultTimeoutMs: number;
  /** The maximum a new settings row starts with, before the owner raises it, in milliseconds. */
  readonly initialMaxTimeoutMs: number;
  /** Compiled ceiling for any owner setting or `timeout_ms`, in milliseconds. */
  readonly hardMaxTimeoutMs: number;
  /** Per-inner-operation cap when the remaining outer budget is larger, in milliseconds. */
  readonly innerOperationTimeoutMs: number;
  /** Maximum QuickJS heap allocated by one execution, in bytes. */
  readonly quickjsMemoryMaxBytes: number;
  /** Maximum QuickJS interpreter stack allocated by one execution, in bytes. */
  readonly quickjsStackMaxBytes: number;
  /** Maximum QuickJS interrupt callbacks across compilation and execution. */
  readonly quickjsInterruptMax: number;
  /** Maximum TypeScript diagnostics returned for one rejected program. */
  readonly diagnosticMax: number;
  /** Maximum UTF-8 bytes returned for one diagnostic or exception message. */
  readonly diagnosticMessageMaxBytes: number;
  /** Maximum UTF-8 bytes returned for one guest exception stack. */
  readonly runtimeStackMaxBytes: number;
  /** Largest submitted source, in UTF-8 bytes; a larger source is refused with -32602. */
  readonly sourceMaxBytes: number;
  /** Largest search query before trimming, in UTF-8 bytes; the schema's `maxLength` is
   *  this value in UTF-16 code units. */
  readonly queryMaxBytes: number;
  /** Largest caller-visible catalog, in entries; overflow refuses `execute` before runtime
   *  creation and truncates `search_types`. */
  readonly catalogMaxEntries: number;
  /** Largest raw schema/catalog payload retained for one snapshot, in bytes. */
  readonly catalogMaxBytes: number;
  /** Largest single canonical subject — service, tool, or raw URI identity — in UTF-8 bytes. */
  readonly subjectMaxBytes: number;
  /** Largest indexed description, in UTF-8 bytes. */
  readonly descriptionMaxBytes: number;
  /** Largest single input/output schema, in UTF-8 bytes. */
  readonly schemaMaxBytes: number;
  /** Deepest schema nesting the renderer walks; deeper schemas render `unknown` with a
   *  diagnostic rather than narrowing incorrectly. */
  readonly schemaMaxDepth: number;
  /** Largest node count a rendered schema may have. */
  readonly schemaMaxNodes: number;
  /** Largest generated declaration text, in bytes; overflow renders a diagnostic banner
   *  and an `unknown` root instead of a partially callable API. */
  readonly declarationMaxBytes: number;
  /** Largest admitted inner operations per execution; the next one is refused immediately
   *  with the typed limit error, never queued past the deadline. */
  readonly innerOperationsMax: number;
  /** Largest inner operations in flight at once; a fifth is refused immediately. */
  readonly innerConcurrencyMax: number;
  /** Largest serialized host-call arguments, in bytes. */
  readonly hostArgumentsMaxBytes: number;
  /** Largest serialized host-call response, in bytes. */
  readonly hostResponseMaxBytes: number;
  /** Largest stdout returned, in bytes; excess sets `stdoutTruncated`. */
  readonly stdoutMaxBytes: number;
  /** Largest stderr returned, in bytes; excess sets `stderrTruncated`. */
  readonly stderrMaxBytes: number;
  /** Largest serialized program return value accepted, in bytes. */
  readonly resultMaxBytes: number;
  /** `search_types` `limit` when the caller omits it. */
  readonly searchLimitDefault: number;
  /** Largest `search_types` `limit` accepted. */
  readonly searchLimitMax: number;
  /** Largest serialized `search_types` response, in bytes; excess truncates to the
   *  canonical prefix. */
  readonly searchResponseMaxBytes: number;
};

/**
 * §23.11 — the compiled hub caps as one record, assembled field-for-field from the
 * constants above. `contracts/hub.json` pins exactly this object (via
 * hub-contract.ts's fixture) and the hub tool schemas read their bounds from it; runtime
 * callsites read the individual constants. `initialMaxTimeoutMs` and `hardMaxTimeoutMs`
 * differ on purpose — the former is the settings default an owner may raise, the latter is
 * never exceeded.
 */
export const HUB_CONTRACT_LIMITS: HubContractLimits = {
  minTimeoutMs: HUB_MIN_TIMEOUT_MS,
  defaultTimeoutMs: HUB_DEFAULT_TIMEOUT_MS,
  initialMaxTimeoutMs: HUB_INITIAL_MAX_TIMEOUT_MS,
  hardMaxTimeoutMs: HUB_HARD_MAX_TIMEOUT_MS,
  innerOperationTimeoutMs: HUB_INNER_OPERATION_TIMEOUT_MS,
  quickjsMemoryMaxBytes: HUB_QUICKJS_MEMORY_MAX_BYTES,
  quickjsStackMaxBytes: HUB_QUICKJS_STACK_MAX_BYTES,
  quickjsInterruptMax: HUB_QUICKJS_INTERRUPT_MAX,
  diagnosticMax: HUB_DIAGNOSTIC_MAX,
  diagnosticMessageMaxBytes: HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES,
  runtimeStackMaxBytes: HUB_RUNTIME_STACK_MAX_BYTES,
  sourceMaxBytes: HUB_SOURCE_MAX_BYTES,
  queryMaxBytes: HUB_QUERY_MAX_BYTES,
  catalogMaxEntries: HUB_CATALOG_MAX_ENTRIES,
  catalogMaxBytes: HUB_CATALOG_MAX_BYTES,
  subjectMaxBytes: HUB_SUBJECT_MAX_BYTES,
  descriptionMaxBytes: HUB_DESCRIPTION_MAX_BYTES,
  schemaMaxBytes: HUB_SCHEMA_MAX_BYTES,
  schemaMaxDepth: HUB_SCHEMA_MAX_DEPTH,
  schemaMaxNodes: HUB_SCHEMA_MAX_NODES,
  declarationMaxBytes: HUB_DECLARATION_MAX_BYTES,
  innerOperationsMax: HUB_INNER_OPERATIONS_MAX,
  innerConcurrencyMax: HUB_INNER_CONCURRENCY_MAX,
  hostArgumentsMaxBytes: HUB_HOST_ARGUMENTS_MAX_BYTES,
  hostResponseMaxBytes: HUB_HOST_RESPONSE_MAX_BYTES,
  stdoutMaxBytes: HUB_STDOUT_MAX_BYTES,
  stderrMaxBytes: HUB_STDERR_MAX_BYTES,
  resultMaxBytes: HUB_RESULT_MAX_BYTES,
  searchLimitDefault: HUB_SEARCH_LIMIT_DEFAULT,
  searchLimitMax: HUB_SEARCH_LIMIT_MAX,
  searchResponseMaxBytes: HUB_SEARCH_RESPONSE_MAX_BYTES,
};

// ── the configurable deadlines ────────────────────────────────────────────────────────
//
// These are the durations a test must be able to SHORTEN: each is a wait a row would
// otherwise sit through, and none can be reached by a clock injection — two are bare
// `setTimeout`s inside workerd, three are `AbortSignal.timeout`, one is Date.now arithmetic
// plus a storage alarm. The lever this replaced patched `globalThis.setTimeout` and
// `AbortSignal.timeout` inside the worker, keyed by the exact millisecond value: global
// mutable state with a restore, and two overlapping restores leaked a patched timer across
// files (the 2026-09-17 §21 stream flake).
//
// So the deadline is read from the env instead. Production sets none of these bindings and
// gets the constants above; a test sets one for the row that watches it, and there is
// nothing to restore to "whatever was there" — ABSENCE is the default. Read AT EACH USE,
// never captured at construct, so a per-row setting applies to the very next timer armed
// and cannot outlive the row that set it.

/** The env binding each configurable deadline reads, and the constant it falls back to. */
const DEADLINES = {
  callTimeoutMs: ["PMCP_CALL_TIMEOUT_MS", CALL_TIMEOUT_MS],
  aggregatedListDeadlineMs: ["PMCP_AGGREGATED_LIST_DEADLINE_MS", AGGREGATED_LIST_DEADLINE_MS],
  registrationDeadlineMs: ["PMCP_REGISTRATION_DEADLINE_MS", REGISTRATION_DEADLINE_MS],
  listenKeepaliveMs: ["PMCP_LISTEN_KEEPALIVE_MS", LISTEN_KEEPALIVE_MS],
  listenBellMinIntervalMs: ["PMCP_LISTEN_BELL_MIN_INTERVAL_MS", LISTEN_BELL_MIN_INTERVAL_MS],
  hubCatalogDeadlineMs: ["PMCP_HUB_CATALOG_DEADLINE_MS", HUB_CATALOG_FAMILY_DEADLINE_MS],
} as const satisfies Record<string, readonly [string, number]>;

/** The configurable deadlines, in milliseconds. */
export type Deadlines = { [K in keyof typeof DEADLINES]: number };

/** The binding name behind each one — the harness that sets them reads the names from here. */
export const DEADLINE_ENV = Object.fromEntries(
  Object.entries(DEADLINES).map(([key, [name]]) => [key, name]),
) as { readonly [K in keyof typeof DEADLINES]: string };

/** The optional string bindings `deadlines` reads — Env's own fields, structurally. */
export type DeadlineBindings = { [K in (typeof DEADLINES)[keyof typeof DEADLINES][0]]?: string };

/**
 * The deadlines this env asks for: an override where the binding parses to a positive
 * integer count of milliseconds, the production constant everywhere else. Anything that is
 * not one — absent, empty, zero, negative, fractional, "soon" — is ignored rather than
 * obeyed, because a mistyped binding must not silently disarm a deadline.
 */
export function deadlines(env: DeadlineBindings): Deadlines {
  const read = env as Record<string, string | undefined>;
  const out = {} as Record<string, number>;
  for (const [key, [name, fallback]] of Object.entries(DEADLINES)) {
    const ms = Number(read[name]);
    out[key] = Number.isInteger(ms) && ms > 0 ? ms : fallback;
  }
  return out as Deadlines;
}