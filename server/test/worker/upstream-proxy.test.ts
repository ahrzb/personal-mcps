// upstream-proxy.test.ts — the proxied path: one code out, the failure class in.
//
// What this suite pins: §7's upstream failure table — every failure class (non-2xx, a 2xx
// body that is not JSON-RPC, transport/TLS failure, timeout, and a stored bundle already
// flagged needs_reconnect) collapses into ONE -32000 whose `data` is unset, with the real
// class surviving only in the audit row's `detail`; the BOUNDARY of that mapping, which is
// well-formedness and not success — a well-formed JSON-RPC error object from the upstream
// is relayed verbatim, code and all, never collapsed; the log-hygiene extension that goes
// with it (the upstream's status line, its headers — `WWW-Authenticate` included — and
// its body are never echoed to a consumer, nor recorded in the audit row that refuses the
// call); the aggregated fan-out contract, where a
// failing AND a hanging upstream each contribute zero tools while the aggregate still
// succeeds and names them in `_meta["pmcp/unavailable"]`, and the scoped list is where
// that omission surfaces as -32000; refresh-before-forward, observed as an ORDER rather
// than as a fact; `X-Pmcp-*` identity headers appearing only under `forward_identity`;
// and — because workerd enforces no production limits locally (strategy §10) — explicit
// subrequest counts, so the never-pooled, never-cached, never-retried dialing discipline
// is asserted rather than assumed.
//
// Why a table: the five failure classes differ only in what the fake upstream does and in
// one audit cell. Written as five tests they drift; written as rows, "add a class" is a
// row and "the consumer sees more than -32000" is a runner-level law that no row can
// forget to assert.
//
// Project: `worker` — real D1, no sockets. Outbound fetch is a plain
// `miniflare.outboundService` function (fetchMock is gone), which is what makes an
// unreachable upstream, a hanging one, and an adversarial authorization server all
// in-process and deterministic. The fake upstream does REAL protocol work (real JSON-RPC
// over Streamable HTTP) and the fake AS is deliberately adversarial (no RFC 9728
// document, CIMD rejected so DCR is forced, no `expires_in`, single-use rotated refresh
// tokens); what neither may fake is the hub's own client, the envelope crypto, or D1
// (§9). Per-file storage isolation is automatic and the dial COUNTERS are per test — a
// count is only meaningful against a known-zero start.
//
// Not pinned here: the OAuth connect flow and the callback rejection matrix
// (upstream-credentials.test.ts, which also owns the envelope and PKCE/token-endpoint
// pinning), the check order in front of dispatch (order.table.test.ts), and the audit
// body columns' contents (hygiene.test.ts) — this file pins that `detail` carries the
// class and that no body reaches the consumer, not the body table itself.
//
// deps: harness/seed (owner + one account; two proxied services, one headers-mode and one
//   oauth-mode, plus a third healthy one for the fan-out) · harness/fake-upstream
//   (miniflare.outboundService router: per-slug behavior, adversarial fake AS, dial
//   counters) · ../../src/index (default.fetch) · ../../src/upstream · ../../src/gateway ·
//   ../../src/limits (CALL_TIMEOUT_MS, AGGREGATED_LIST_DEADLINE_MS) ·
//   applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A NOTE ON THE DEADLINES, because the obvious shortcut does not work here. Shrinking
// limits.ts with `vi.mock` looks like the strategy's "shrink the constant, never wait it
// out", and it is a lie in this pool: the mock reaches THIS file's import of limits (it
// reads the shrunk value) and does NOT reach upstream.ts or gateway.ts inside workerd, so
// the hub goes on enforcing the real 30 s while the suite believes it enforces 2.5 s —
// every hang case then fails as a runner timeout that looks like a hub bug. Measured, not
// assumed: with the mock in place a `hang` row outlived a 13.2 s budget derived from the
// shrunk values. So the constants here are the REAL ones, the hang rows genuinely cost
// what they assert, and CASE_BUDGET_MS below is derived from the same names.
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import type { BackendCtx, JsonRpcResponse, Tool } from "../../src/gateway";
import { requireOwnerSession } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { AGGREGATED_LIST_DEADLINE_MS, CALL_TIMEOUT_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { ServiceDetail } from "../../src/registry";
import {
  beginConnect,
  connectionStatus,
  setHeaders,
  upstreamBackend,
  UpstreamError,
} from "../../src/upstream";
import type { UpstreamConnectionStatus, UpstreamFailureClass } from "../../src/upstream";
import {
  asUrlFor,
  fakeAccessToken,
  readObservations,
  upstreamUrlFor,
} from "../harness/fake-upstream";
import type {
  AsScenario,
  FailureClassSource,
  UpstreamMode,
  UpstreamObservation,
  UpstreamScenario,
} from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * What the fake upstream does when dialed — the row's only input, and deliberately
 * expressed as BEHAVIOR rather than as an expected class, so the mapping from behavior to
 * class is the thing under test and not a restatement of it.
 *
 * `hang` is parameterized by which constant it must outlive, never by a literal: the two
 * deadlines are two knobs (strategy §11 — a slow upstream may take the full call budget
 * when dialed directly but must not hold an aggregated listing hostage), and a row that
 * hard-coded milliseconds would make "30 s → 45 s" a test edit.
 *
 * `jsonrpc-error` is the boundary of the whole mapping and not a failure at all: §7 scopes
 * "verbatim" to a WELL-FORMED JSON-RPC response, which includes a well-formed `error`
 * object, and upstream.ts's own contract spells it out ("results, errors, and MRTR
 * `input_required` legs alike"). Without it the four `body` rows only pin "unparseable →
 * -32000", and an implementation that collapsed every upstream `error` into -32000 —
 * turning an upstream's "unknown tool" into "service unavailable" for every consumer —
 * satisfies every other row in the table.
 */
export type UpstreamBehavior =
  | { act: "status"; status: number; wwwAuthenticate?: boolean }
  | { act: "body"; body: "html" | "empty" | "json-not-jsonrpc" | "truncated" }
  | { act: "jsonrpc-error" }
  | { act: "unreachable" }
  | { act: "hang"; past: "CALL_TIMEOUT_MS" | "AGGREGATED_LIST_DEADLINE_MS" }
  | { act: "redirect"; to: "foreign-origin" }
  | { act: "ok" };

/**
 * The stored credential state the row starts from — the input that decides whether the
 * dial happens at all. `needs_reconnect` is the one state where NO dial may occur, which
 * is why the row's expected dial count and its class are checked together.
 */
export type UpstreamCredentialState =
  | { auth: "none" }
  | { auth: "headers" }
  | { auth: "oauth"; token: "fresh" | "stale" | "refresh-fails" | "needs-reconnect" };

/**
 * The pinned answer. `code` is -32000 for every failure and `null` for the allow-twin;
 * `dataUnset` is asserted on every row (it is the property that stops upstream detail
 * leaking through the gateway's mapping); `failureClass` is the audit `detail` cell —
 * upstream's own exported vocabulary, so the audit row and the module cannot drift —
 * and is `null` exactly when the consumer's answer carries no hub-generated failure.
 *
 * `swallowed` exists because the aggregated surface has TWO answers to state and one
 * column cannot hold both: the consumer's (a successful listing minus a slug — `code` and
 * `failureClass` null) and the operator's (the class the fan-out caught and turned into
 * `_meta["pmcp/unavailable"]`). Both matter, and only the second distinguishes "that
 * upstream is down" from a hub defect inside the fan-out, which gateway deliberately logs
 * as a different thing. Present exactly on `list-aggregated` rows.
 *
 * `dials` is the explicit subrequest budget: how many requests the resource server must
 * see, and `tokenDials` how many the authorization server must. workerd enforces no cap
 * locally, so an unasserted budget is an unnoticed retry storm in production (§10).
 * `dials: "unobservable"` is a row saying its resource count cannot be MEASURED — the fake
 * never sees the request — and the runner then asserts no count for it rather than
 * manufacturing one from the class it already checked. The cell is the row's own statement,
 * so a budget that is real and a budget that is a restatement are never the same column.
 */
export type UpstreamExpectation = {
  code: -32000 | null;
  dataUnset: boolean;
  failureClass: UpstreamFailureClass | null;
  swallowed?: UpstreamFailureClass;
  dials: number | "unobservable";
  tokenDials: number;
};

/** One row of the upstream failure table. */
export type UpstreamFailureRow = {
  /** e.g. "§7 · upstream 401 → -32000, class upstream_status, WWW-Authenticate never echoed". */
  title: string;
  behavior: UpstreamBehavior;
  credentials: UpstreamCredentialState;
  /**
   * Which surface drives the dial — the three differ in how they treat the same failure.
   * `call-twice` is the fourth because one column cannot express a SEQUENCE: two identical
   * calls on one service, both of which must succeed, with `dials`/`tokenDials` stating
   * the TOTALS across both. It exists for exactly one question (whether a refreshed bundle
   * was re-sealed into `upstream_auth_json` or only held in memory) that no single-call
   * row can ask.
   */
  operation: "call" | "call-twice" | "list-scoped" | "list-aggregated";
  expect: UpstreamExpectation;
  /** §9 rule 2 — the title of the allow row this refusal sits beside. */
  twin: string;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1) — agents write the fake upstream and the runner, never the oracle.
 */
export const UPSTREAM_FAILURE_ROWS: readonly UpstreamFailureRow[] = [
  // The fixture these rows are written against, named once: one proxied service per row,
  // pointed at a fake-upstream scenario carrying the row's `behavior`, seeded in the row's
  // `credentials` state, plus — for the `list-aggregated` rows — two healthy proxied
  // siblings so the aggregate has something to succeed WITH. The dial counters are read
  // back over the wire per row (readObservations), which is why every row states a budget
  // rather than a bound: a count is only meaningful against a known-zero start.
  //
  // Four conventions, so no row repeats them:
  // · `dataUnset` is `true` on every row, success rows included. It is not a per-row
  //   judgment — it is the property that stops upstream detail reaching a consumer through
  //   the gateway's mapping, and a column that could be `false` somewhere would invite a
  //   row that quietly lets one leak.
  // · `failureClass` is the class that reached the CONSUMER's answer, and it is null
  //   exactly when `code` is null. On `call` / `call-twice` rows the runner reads it back
  //   from the tools/call audit row's `detail`; on `list-scoped` there is no audit row to
  //   read (§15 keeps tools/list out of the ledger entirely), so the column states the
  //   class the module threw and the runner asserts the absence of a row instead.
  //   `list-aggregated` is the surface where the two part company — the module throws and
  //   the consumer still gets a successful listing — so those rows carry `failureClass:
  //   null` (nothing reached the consumer) plus `swallowed`, the class the fan-out caught.
  //   Without the second cell an aggregated row pins nothing about the class at all, and a
  //   fan-out that swallowed a TypeError from its own filtering would be indistinguishable
  //   from one that swallowed the upstream's 503 — the exact distinction gateway.ts logs
  //   two different ways so an operator is never sent to a healthy upstream.
  // · `{ auth: "none" }` carries no row on purpose. A proxied service with no stored
  //   envelope reads `not_connected`, and §7's availability-first clause refuses such a
  //   tools/call with -32000 BEFORE this module is reached — zero dials, and a refusal
  //   whose detail carries no upstream class at all. That row exists, and it is
  //   order.table.test.ts's; putting a copy here would pin the gateway's gate under the
  //   name of an upstream failure class.
  // · The `hang` rows name the constant they must outlive, never a number: the two
  //   deadlines are two knobs (§11), and which one bites is decided by the operation, not
  //   by the fixture.

  // ── the allow-twins, first: every refusal below is one of these with one thing bent ────
  // §7: "the call is forwarded … and the response relayed back verbatim." The anchor —
  // headers mode, a healthy upstream, one dial out and nothing else.
  {
    title:
      "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
    behavior: { act: "ok" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // §7: "the hub attaches `Authorization: Bearer` upstream and refreshes proactively."
  // PROACTIVELY, not unconditionally — a live bundle costs the authorization server
  // nothing, and `tokenDials: 0` is the only column that can say so.
  {
    title:
      "§7 · oauth mode with a FRESH access token → relayed verbatim with ZERO token dials: refresh is proactive, not unconditional",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "fresh" },
    operation: "call",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 1, tokenDials: 0 },
    twin: "§7 · oauth mode with a FRESH access token → relayed verbatim with ZERO token dials: refresh is proactive, not unconditional",
  },
  // The counts state the ORDER's precondition; the order itself (token endpoint observed
  // before the resource) is the standalone case in "credentials at call time" — a table
  // cell cannot express "first". What it CAN express is that both happened on one call.
  {
    title:
      "§7 · oauth mode with a STALE access token → one token dial AND one resource dial: the refresh happens before the forward, never instead of it",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "stale" },
    operation: "call",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 1, tokenDials: 1 },
    twin: "§7 · oauth mode with a STALE access token → one token dial AND one resource dial: the refresh happens before the forward, never instead of it",
  },
  // The allow-twin the list refusals need: without it, "the scoped list fails -32000" is
  // satisfied by a scoped list that always fails.
  {
    title:
      "§7 · a healthy upstream's SCOPED tools/list succeeds on one dial — the allow-twin of every list row below",
    behavior: { act: "ok" },
    credentials: { auth: "headers" },
    operation: "list-scoped",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 1, tokenDials: 0 },
    twin: "§7 · a healthy upstream's SCOPED tools/list succeeds on one dial — the allow-twin of every list row below",
  },

  // ── upstream_status: the upstream answered, and what it answered is never repeated ─────
  // §7: "The upstream's status line, headers (including `WWW-Authenticate`), and body are
  // never echoed to the consumer." 401 is the row where that costs something: an upstream
  // whose challenge names its own authorization server would hand a consumer a map of the
  // hub's credentials if the header rode back out.
  {
    title:
      "§7 · upstream 401 → -32000, class upstream_status, and the WWW-Authenticate it challenged with is echoed nowhere",
    behavior: { act: "status", status: 401, wwwAuthenticate: true },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "upstream_status", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // The same 401 in OAUTH mode, which is a different question and the one this table would
  // otherwise leave open: every other non-2xx row is headers-mode, so nothing says what a
  // resource server's own refusal does to a live token bundle. Two wrong readings are both
  // natural and both expensive. "A 401 means the token died, refresh and retry" spends an
  // extra token dial plus a second resource dial on every 401 an upstream ever sends —
  // exactly the retry storm the two counter columns exist to bound, and invisible locally
  // because workerd enforces no subrequest cap. "A 401 means needs_reconnect" is worse: §7
  // binds that flip strictly to a FAILED REFRESH, and flipping on a resource answer bricks
  // the service until the owner clicks Reconnect — a permission error at the upstream
  // turned into a dead credential at the hub.
  {
    title:
      "§7 · oauth mode, a FRESH token, and the resource server answers 401 → -32000, class upstream_status, ONE resource dial and ZERO token dials — a resource refusal is not a dead credential, and the service is still `connected` afterwards",
    behavior: { act: "status", status: 401, wwwAuthenticate: true },
    credentials: { auth: "oauth", token: "fresh" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "upstream_status", dials: 1, tokenDials: 0 },
    twin: "§7 · oauth mode with a FRESH access token → relayed verbatim with ZERO token dials: refresh is proactive, not unconditional",
  },
  // The three-surface triple, part 1 of 3: one behavior, three operations, three answers.
  // §7's audit sentence — "the audit row's `detail` records the failure class (e.g.
  // `upstream_status: 401` vs `unreachable`) so the owner can tell expired static headers
  // from a down upstream" — is why the class survives at all.
  {
    title:
      "§7 · upstream 503 on a call → -32000, class upstream_status carrying the status, ONE dial — a failed dial is never retried",
    behavior: { act: "status", status: 503 },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "upstream_status", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // Part 2 of 3. §7: "The scoped endpoint is where that failure surfaces: scoped
  // `tools/list` against an unreachable or needs-reconnect proxied upstream fails -32000."
  {
    title:
      "§7 · the SCOPED tools/list against that same 503 upstream → -32000: this is where the aggregate's silent omission surfaces",
    behavior: { act: "status", status: 503 },
    credentials: { auth: "headers" },
    operation: "list-scoped",
    expect: { code: -32000, dataUnset: true, failureClass: "upstream_status", dials: 1, tokenDials: 0 },
    twin: "§7 · a healthy upstream's SCOPED tools/list succeeds on one dial — the allow-twin of every list row below",
  },
  // Part 3 of 3. §7: "A proxied upstream that errors, times out, or is in needs-reconnect
  // contributes zero tools and the aggregated list still succeeds." The consumer gets a
  // successful listing, so `code` and `failureClass` are both null; `swallowed` is what
  // the fan-out caught on its way to omitting the slug. The omission itself
  // (`_meta["pmcp/unavailable"]`) is the fan-out block's case, not a cell of this row.
  {
    title:
      "§7 · the AGGREGATED list over that same 503 upstream still SUCCEEDS — the failing slug contributes zero tools and no code reaches the consumer",
    behavior: { act: "status", status: 503 },
    credentials: { auth: "headers" },
    operation: "list-aggregated",
    expect: {
      code: null,
      dataUnset: true,
      failureClass: null,
      swallowed: "upstream_status",
      dials: 1,
      tokenDials: 0,
    },
    twin: "§7 · the AGGREGATED list over that same 503 upstream still SUCCEEDS — the failing slug contributes zero tools and no code reaches the consumer",
  },
  // Strategy §10's code contract, made observable: `redirect: "manual"` means a 3xx is an
  // ANSWER — a non-2xx one — rather than an instruction. The row pins the class; that the
  // foreign origin was never dialed is the §10 block's case.
  {
    title:
      "§7/§10 · a 3xx to a foreign origin is answered, never followed → -32000, class upstream_status (`redirect: \"manual\"` keeps the credential from walking off)",
    behavior: { act: "redirect", to: "foreign-origin" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "upstream_status", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },

  // ── bad_body: 2xx is not enough ───────────────────────────────────────────────────────
  // §7: "any HTTP-level failure — non-2xx status, a body that is not a JSON-RPC message,
  // TLS or transport error — maps to -32000". Four rows because a body fails to be a
  // JSON-RPC message in two structurally different ways — it does not parse, or it parses
  // into something else — and an implementation that only guards one of them is a
  // relay of whatever the upstream felt like sending.
  {
    title:
      "§7 · 200 carrying an HTML error page → -32000, class bad_body — a 2xx that is not a JSON-RPC message is a failure, not a result",
    behavior: { act: "body", body: "html" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "bad_body", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  {
    title: "§7 · 200 with an empty body → -32000, class bad_body",
    behavior: { act: "body", body: "empty" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "bad_body", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  {
    title:
      "§7 · 200 with valid JSON that carries no JSON-RPC envelope → -32000, class bad_body: parseable is not well-formed",
    behavior: { act: "body", body: "json-not-jsonrpc" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "bad_body", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  {
    title:
      "§7 · 200 with a truncated JSON body → -32000, class bad_body — a half-arrived result is never relayed as if it were whole",
    behavior: { act: "body", body: "truncated" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "bad_body", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // The boundary the four rows above are drawn against, and the reason they are about
  // FORM rather than about success: §7 scopes "verbatim" to a well-formed JSON-RPC
  // response, not to a successful one, and upstream.ts's own contract says the same
  // ("results, errors, and MRTR `input_required` legs alike"). Without this row the
  // cluster reads equally well as "every upstream `error` is -32000", which would turn an
  // upstream's own "unknown tool" or "invalid params" into "service unavailable" for every
  // consumer and hide it behind a class the owner reads as an outage. `failureClass` is
  // null because nothing failed at the hub: the upstream's error object — its code, its
  // message — is what the consumer receives, unchanged and unclassified. The fixture's
  // error carries no `data` of its own, which is what keeps the table's `dataUnset: true`
  // convention reading as "the hub added nothing" on this row too.
  {
    title:
      "§7 · a WELL-FORMED JSON-RPC error object from the upstream is relayed verbatim, code and all — never collapsed into -32000, and no failure class is recorded: the -32000 boundary is well-formedness, not success",
    behavior: { act: "jsonrpc-error" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },

  // ── unreachable and timeout: nothing came back ────────────────────────────────────────
  // What separates this from needs_reconnect two rows down is whether the hub TRIED, and on
  // this row that is not a count anyone can take: the scenario's endpoint carries a scheme
  // workerd refuses before outbound routing (fake-upstream's header records why nothing else
  // can make a fetch REJECT), so the fake never sees the request and its log stays empty. The
  // row says `unobservable` rather than borrowing a number, and its evidence is the class:
  // `unreachable` is produced by dial()'s transport catch and by nothing else, so reaching it
  // IS the fetch having been issued. The zero-dial rows below carry a real 0 against a fake
  // that would have logged an arrival, which is the count this one cannot have.
  {
    title:
      "§7 · a transport failure before any response → -32000, class unreachable — the dial WAS attempted, which is what tells it apart from needs_reconnect",
    behavior: { act: "unreachable" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: {
      code: -32000,
      dataUnset: true,
      failureClass: "unreachable",
      dials: "unobservable",
      tokenDials: 0,
    },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // §15: "Proxied: the upstream fetch is aborted at the same deadline." One dial, aborted —
  // never a second attempt while the first is still hanging.
  {
    title:
      "§7/§15 · no answer inside limits.CALL_TIMEOUT_MS → -32000, class timeout, on ONE dial aborted at the budget",
    behavior: { act: "hang", past: "CALL_TIMEOUT_MS" },
    credentials: { auth: "headers" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "timeout", dials: 1, tokenDials: 0 },
    twin: "§7 · headers-mode call against a healthy upstream → the result is relayed verbatim on ONE resource dial and no token dial (the anchor allow-twin of the whole table)",
  },
  // The OTHER knob (§7: "a 10 s per-upstream deadline … inside §15's 30 s request budget").
  // The row asserts the aggregate still succeeds; that it did so without waiting out
  // CALL_TIMEOUT_MS is the fan-out block's case, because a duration is not a table cell.
  {
    title:
      "§7 · a hang past limits.AGGREGATED_LIST_DEADLINE_MS costs the aggregate that deadline and nothing more — the listing still succeeds, the hung slug contributes zero tools",
    behavior: { act: "hang", past: "AGGREGATED_LIST_DEADLINE_MS" },
    credentials: { auth: "headers" },
    operation: "list-aggregated",
    expect: {
      code: null,
      dataUnset: true,
      failureClass: null,
      swallowed: "timeout",
      dials: 1,
      tokenDials: 0,
    },
    twin: "§7 · a hang past limits.AGGREGATED_LIST_DEADLINE_MS costs the aggregate that deadline and nothing more — the listing still succeeds, the hung slug contributes zero tools",
  },

  // ── needs_reconnect: the one class produced without dialing ───────────────────────────
  // §7: "A failed refresh flips the service to needs reconnect — calls fail -32000 and
  // /services shows a Reconnect button." Zero dials is the whole assertion: a dead bundle
  // spent on a round trip is a hub that hammers an upstream with credentials it knows are
  // dead, once per agent retry.
  {
    title:
      "§7 · a service already flagged needs_reconnect → -32000 with ZERO dials, class needs_reconnect: a dead bundle is never spent on a round trip",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "needs-reconnect" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "needs_reconnect", dials: 0, tokenDials: 0 },
    twin: "§7 · oauth mode with a FRESH access token → relayed verbatim with ZERO token dials: refresh is proactive, not unconditional",
  },
  // The call on which the flip HAPPENS, one row apart from the call after it. The upstream
  // is healthy — `behavior: ok` — so the zero resource dials cannot be blamed on anything
  // but the refusal to forward a credential the AS just rejected.
  {
    title:
      "§7 · a refresh the AS rejects → -32000, class needs_reconnect, with ONE token dial and ZERO resource dials: the flip happens on this call and the resource is never reached",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "refresh-fails" },
    operation: "call",
    expect: { code: -32000, dataUnset: true, failureClass: "needs_reconnect", dials: 0, tokenDials: 1 },
    twin: "§7 · oauth mode with a FRESH access token → relayed verbatim with ZERO token dials: refresh is proactive, not unconditional",
  },
  // §7 names needs-reconnect on BOTH list surfaces ("contributes zero tools and the
  // aggregated list still succeeds" · "scoped tools/list against an unreachable or
  // needs-reconnect proxied upstream fails -32000"), and neither had a row. That gap is
  // not covered anywhere else: order.table.test.ts's seeder hard-throws on any
  // needs_reconnect row, so this file is the only place the state can be pinned at all.
  //
  // It matters because needs_reconnect is the one class produced WITHOUT dialing, so it
  // reaches each surface by a different code path than every class thrown out of a dial:
  // a check that lives in `call` and not in `listTools` passes all the call rows while the
  // scoped list dials a credential the hub knows is dead — and `tools/list` is polled by
  // every agent on every session, so that is one rejected credential spent per poll, not
  // once. On the aggregate the same miss is quieter still: if the check escapes as
  // anything but a HubError, gateway logs it as a hub defect against itself rather than as
  // somebody's upstream being down.
  {
    title:
      "§7 · the SCOPED tools/list against a service already flagged needs_reconnect → -32000, class needs_reconnect, with ZERO dials — the list surface consults the stored bundle exactly as the call surface does",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "needs-reconnect" },
    operation: "list-scoped",
    expect: { code: -32000, dataUnset: true, failureClass: "needs_reconnect", dials: 0, tokenDials: 0 },
    twin: "§7 · a healthy upstream's SCOPED tools/list succeeds on one dial — the allow-twin of every list row below",
  },
  {
    title:
      "§7 · the AGGREGATED list over that same needs_reconnect service still SUCCEEDS on ZERO dials — a credential-dead slug contributes zero tools, and the fan-out swallows needs_reconnect rather than a hub defect",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "needs-reconnect" },
    operation: "list-aggregated",
    expect: {
      code: null,
      dataUnset: true,
      failureClass: null,
      swallowed: "needs_reconnect",
      dials: 0,
      tokenDials: 0,
    },
    twin: "§7 · the AGGREGATED list over that same needs_reconnect service still SUCCEEDS on ZERO dials — a credential-dead slug contributes zero tools, and the fan-out swallows needs_reconnect rather than a hub defect",
  },

  // ── the refreshed bundle has to LAND ──────────────────────────────────────────────────
  // The only row that makes the fake AS's adversarial rotation quirk load-bearing (§9:
  // "single-use rotated refresh tokens"). Row 3 refreshes once and observes one call, which
  // an implementation that refreshes in MEMORY and forwards without ever writing the new
  // bundle back satisfies perfectly — and then, in production, the AS has already burned
  // the rotated refresh token, the second call's refresh fails, and the service flips to
  // needs_reconnect after exactly one successful call. Two calls is the shortest sequence
  // that can tell those apart: the totals say the second call went straight to the
  // resource, which is only possible if the first call's refresh was sealed back into
  // `upstream_auth_json` (§7: "The token bundle lands in the encrypted upstream_auth_json").
  {
    title:
      "§7 · TWO calls across ONE refresh: the stale bundle is refreshed once, re-sealed, and the second call dials the resource directly — 2 resource dials and exactly 1 token dial in total, because the AS's rotated refresh token is single-use and a bundle kept only in memory is already spent",
    behavior: { act: "ok" },
    credentials: { auth: "oauth", token: "stale" },
    operation: "call-twice",
    expect: { code: null, dataUnset: true, failureClass: null, dials: 2, tokenDials: 1 },
    twin: "§7 · oauth mode with a STALE access token → one token dial AND one resource dial: the refresh happens before the forward, never instead of it",
  },
];

/**
 * The one assertion path for the failure table: configure the fake upstream for the row's
 * behavior and credential state, drive the operation through `exports.default.fetch`, and
 * check the code, the unset `data`, the audit row's class cell, and both dial counters.
 *
 * Three laws live in the runner rather than in any row — asserting them per row invites a
 * row that forgets to, and every leak they guard against is invisible by construction
 * (strategy §5). The runner also enforces §9 rule 2 over `twin`.
 *
 * 1. THE SENTINEL LAW, on both sides of the hub. A sentinel string is planted in the
 *    upstream's status text, its `WWW-Authenticate` header, and any body the hub refuses
 *    to relay, and must then appear in NO consumer-visible byte of the response — message,
 *    `data`, or `_meta` alike — AND in no column of the audit row the same call writes.
 *    The audit half is not a footnote: `detail` is a free-form JSON column, an
 *    implementation that recorded the challenge "for debuggability" satisfies every row in
 *    this table, and a 401's `WWW-Authenticate` routinely names the authorization server
 *    and can carry token material — which `audit_query` then serves and the JSONL export
 *    ships (§5: `detail` is a small summary and NEVER token material). Only the failure
 *    class and the bare status number may survive into `detail`. The one row outside this
 *    law is `jsonrpc-error`, where §7 requires the upstream's own message to be relayed:
 *    the law is about upstream detail surviving the hub's failure MAPPING, not about a
 *    well-formed message the hub was told to pass through.
 * 2. THE OAUTH BEARER RIDES. Every oauth scenario's fake upstream REQUIRES the bearer from
 *    the stored bundle (`UpstreamScenario.requireBearer`) — a dial without it, or with a
 *    stale one after a refresh, answers 401 and the row goes red. Otherwise every oauth
 *    row's upstream answers `ok` whatever arrives, and an implementation that opens the
 *    envelope, refreshes proactively, and then dials ANONYMOUSLY passes rows 2, 3 and the
 *    whole refresh block; in production it is indistinguishable from an expired credential
 *    (401 → upstream_status). The headers mode has this as a case of its own; the oauth
 *    mode has no equivalent seam, so it lives here.
 * 3. THE FLIP HAS ONE TRIGGER. §7 binds needs_reconnect to a FAILED REFRESH and to nothing
 *    else, so after every row whose credential state is not `refresh-fails` the service's
 *    `connectionStatus` reads exactly what it read before the row ran — a resource
 *    server's 401 or 503 leaves a live bundle live. The flip is a state change the owner
 *    has to undo by hand, so an over-eager one is a service bricked by somebody else's
 *    permission error.
 */
export function runUpstreamFailureTable(rows: readonly UpstreamFailureRow[]): void {
  // deps: harness/seed · harness/fake-upstream (behavior router + dial counters) ·
  //   ../../src/index (default.fetch) · ../../src/audit (query) · env.DB
  const titles = new Set(rows.map((row) => row.title));
  for (const row of rows) {
    it(row.title, async () => {
      // §9 rule 2, enforced over the whole table rather than per row: a refusal whose
      // named twin is not here is a refusal nobody proved was reachable.
      expect(titles.has(row.twin), `${row.title}: names a twin that is not in this table`).toBe(true);

      const world = await buildWorld(row);
      const before = await snapshot(world);
      const answers = await drive(world, row);
      const after = await snapshot(world);

      // The pipeline answers 200 whether or not it refused — refusals are payloads.
      for (const answer of answers) {
        expect(answer.status, `${row.title}: the pipeline answers 200`).toBe(200);
      }
      const last = answers[answers.length - 1];

      if (row.expect.code === null) {
        // Two shapes of "the hub added no failure of its own": a result, or — on the
        // boundary row — the UPSTREAM's own well-formed error, relayed unchanged.
        if (row.behavior.act === "jsonrpc-error") {
          expect(last.body.error, `${row.title}: the upstream's error object is relayed`).toEqual(
            UPSTREAM_ERROR,
          );
        } else {
          expect(
            last.body.error,
            `${row.title}: expected success, got ${JSON.stringify(last.body.error)}`,
          ).toBeUndefined();
          expect(last.body.result, `${row.title}: a successful answer carries a result`).toBeDefined();
        }
      } else {
        expect(
          last.body.error?.code,
          `${row.title}: wrong answer ${JSON.stringify(last.body.error ?? last.body.result)}`,
        ).toBe(row.expect.code);
      }

      // Every row, success included: the gateway's mapping never attaches anything
      // upstream-derived, and `data` is where it would ride.
      expect(row.expect.dataUnset, "the table's convention: dataUnset is true on every row").toBe(true);
      expect(last.body.error?.data, `${row.title}: -32000 must carry no data`).toBeUndefined();

      // The class, from the surface that carries it. A `call` row reads the audit row's
      // `detail`; a `list-*` row has no audit row at all (§15 keeps tools/list out of the
      // ledger), so the module is asked directly instead.
      const written = after.auditCalls.slice(before.auditCalls.length);
      const dialed = row.operation === "call" || row.operation === "call-twice";
      const observedClass = dialed
        ? classOf(written[written.length - 1])
        : await classFromModule(world);
      if (dialed) {
        expect(written.length, `${row.title}: one tools/call row per call`).toBe(answers.length);
        expect(observedClass, `${row.title}: the audit detail's class`).toBe(row.expect.failureClass);
      } else {
        expect(written.length, `${row.title}: §15 keeps tools/list out of the ledger`).toBe(0);
        expect(observedClass, `${row.title}: the class the module produces`).toBe(
          row.expect.failureClass ?? row.expect.swallowed ?? null,
        );
      }

      // §10's explicit budgets: workerd enforces no subrequest cap locally, so an
      // unasserted count is an unnoticed retry storm in production. A row whose resource
      // count cannot be measured says so in its own cell (`dials: "unobservable"`), and
      // nothing here knows the name of the behavior that made it so — the class assertion
      // above is that row's whole evidence.
      const tokenDials = after.tokenDials - before.tokenDials;
      const budget =
        row.expect.dials === "unobservable"
          ? { tokenDials }
          : { dials: after.dials - before.dials, tokenDials };
      expect(budget, row.title).toEqual(
        row.expect.dials === "unobservable"
          ? { tokenDials: row.expect.tokenDials }
          : { dials: row.expect.dials, tokenDials: row.expect.tokenDials },
      );

      // LAW 1 — the sentinel, on both sides of the hub. Exempt on the one row where §7
      // requires the upstream's own message to be relayed: the law is about upstream detail
      // surviving the hub's failure MAPPING, not about a message it was told to pass on.
      if (row.behavior.act !== "jsonrpc-error") {
        for (const answer of answers) {
          expect(
            answer.text.includes(world.sentinel),
            `${row.title}: the upstream's status text, challenge or body reached the consumer`,
          ).toBe(false);
        }
        for (const entry of written) {
          expect(
            JSON.stringify(entry).includes(world.sentinel),
            `${row.title}: the upstream's status text, challenge or body reached the ledger`,
          ).toBe(false);
        }
      }

      // LAW 3 — the flip has ONE trigger. A resource server's own 401 or 503 leaves a live
      // bundle live; only a failed refresh may change what the owner sees.
      expect(after.status, `${row.title}: connectionStatus changed without a failed refresh`).toBe(
        row.credentials.auth === "oauth" && row.credentials.token === "refresh-fails"
          ? "needs_reconnect"
          : before.status,
      );
    }, CASE_BUDGET_MS);
  }
}

/**
 * How long ONE row may take. A `hang` row costs whichever deadline it is about, and both
 * are larger than vitest's default budget — so the budget is derived from the constants
 * this file already reads BY NAME rather than written as a number: shrink them and this
 * shrinks with them. Generous rather than tight, because what a row asserts is the
 * deadline the HUB enforces, never the one the runner does.
 */
export const CASE_BUDGET_MS = (CALL_TIMEOUT_MS + AGGREGATED_LIST_DEADLINE_MS) * 2;

// ── one row → one seeded world → one drive ────────────────────────────────────────────

/** One row's seeded world: exactly what the assertions read — the namespace, the scenario
 *  ids its counters come from, the sentinel planted in everything the upstream says, and the
 *  credential its requests carry. */
type World = {
  ns: SeededNamespace;
  service: ServiceDetail;
  /** The fake-upstream scenario the row's service points at — its log IS `dials`. */
  upstreamId: string;
  /** The fake AS, on oauth rows — the `/token` arrivals in its log ARE `tokenDials`. */
  asId?: string;
  sentinel: string;
  credential: string;
};

/** The four counters plus the credential state, read the same way before and after. */
async function snapshot(world: World) {
  return {
    dials: (await readObservations(world.upstreamId)).length,
    tokenDials:
      world.asId === undefined ? 0 : (await readObservations(world.asId)).filter(isTokenDial).length,
    auditCalls: (await query(env.DB, world.ns.owner.userId, { event: "tools/call", limit: 200 })).rows,
    status: await connectionStatus(world.service),
  };
}

/** A token-endpoint arrival, told from the AS's metadata, authorize and register legs the
 *  one way UpstreamObservation says a leg is told: by `path`. */
function isTokenDial(observation: UpstreamObservation): boolean {
  return observation.path.endsWith("/token");
}

/** The failure class an audit row recorded, or null when it recorded none. */
function classOf(entry: AuditRow | undefined): UpstreamFailureClass | null {
  const failureClass = entry?.detail?.failureClass;
  return typeof failureClass === "string" ? (failureClass as UpstreamFailureClass) : null;
}

/**
 * The class for a surface that writes no audit row, asked of the module itself.
 *
 * A `list-aggregated` row's `swallowed` cannot be read off the fan-out: gateway races
 * every listing against AGGREGATED_LIST_DEADLINE_MS and, on the hung row, its own deadline
 * wins and it catches a plain -32000 rather than the dial's `timeout`. What the column
 * names is upstream's exported vocabulary, so upstream is what answers it — and doing it
 * AFTER the row's counters are taken keeps this probe out of the budget the row states.
 */
async function classFromModule(world: World): Promise<UpstreamFailureClass | null> {
  try {
    await upstreamBackend.listTools(world.service, LIST_CTX);
    return null;
  } catch (err) {
    if (err instanceof UpstreamError) return err.failureClass;
    throw err;
  }
}

/** Every check has already run by the time a backend is called, so the context a direct
 *  probe hands in is the owner's: a principal, the wildcard role, no client metadata. */
const LIST_CTX: BackendCtx = {
  principal: { kind: "user", userId: "probe", username: "probe" },
  roles: ["all"],
};

/** One drive of the row's operation — two answers on `call-twice`, one everywhere else. */
async function drive(
  world: World,
  row: UpstreamFailureRow,
): Promise<{ status: number; body: JsonRpcResponse; text: string }[]> {
  const times = row.operation === "call-twice" ? 2 : 1;
  const answers = [];
  for (let n = 0; n < times; n++) {
    answers.push(await request(world.credential, requestFor(world, row)));
  }
  return answers;
}

/** The JSON-RPC message and URL one operation sends. */
function requestFor(world: World, row: UpstreamFailureRow): { url: string; message: unknown } {
  const base = `${ORIGIN}/${world.ns.owner.username}/mcp`;
  const envelope = { jsonrpc: "2.0", id: 1 };
  if (row.operation === "list-aggregated") {
    return { url: base, message: { ...envelope, method: "tools/list" } };
  }
  const url = `${base}/${world.service.slug}`;
  if (row.operation === "list-scoped") return { url, message: { ...envelope, method: "tools/list" } };
  return { url, message: { ...envelope, method: "tools/call", params: { name: TOOL, arguments: ARGS } } };
}

/** One request through the composition root, read down to what every assertion needs. Takes
 *  the CREDENTIAL rather than a world, because that is the only thing it uses — the fan-out
 *  has no service and no sentinel to lend it. */
async function request(
  credential: string,
  spec: { url: string; message: unknown },
): Promise<{ status: number; body: JsonRpcResponse; text: string }> {
  const response = await worker.fetch(
    new Request(spec.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(spec.message),
    }),
    env as unknown as Env,
  );
  // The TEXT, not just the parsed body: the sentinel law is about bytes reaching a
  // consumer, and a leak into a message string is exactly the shape it is guarding.
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as JsonRpcResponse, text };
}

/**
 * The fixture the table's preamble names, built per row: one proxied service on a
 * fake-upstream scenario carrying the row's behavior, seeded into the row's credential
 * state through the production seams alone (setHeaders, or a whole connect flow), plus —
 * on the aggregated rows — two healthy proxied siblings so the aggregate has something to
 * succeed WITH.
 */
async function buildWorld(row: UpstreamFailureRow): Promise<World> {
  const sentinel = `FAKE0000-sentinel-${uniqueSlug("x")}`;
  const foreignId = uniqueSlug("foreign");
  const as = asScenarioFor(row);
  const upstream: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: modeFor(row.behavior, sentinel, foreignId),
    tools: UPSTREAM_TOOLS,
    ...(row.behavior.act === "jsonrpc-error" ? { error: UPSTREAM_ERROR } : {}),
    // LAW 2 — the credential RIDES. Both modes' upstreams refuse anything but the exact
    // value the stored bundle should have reached, so a hub that opens the envelope and
    // then dials anonymously is answered 401 instead of quietly passing.
    ...(as === undefined
      ? { requireBearer: HEADERS_CREDENTIAL.Authorization }
      : { as, requireBearer: `Bearer ${fakeAccessToken(as.id, expectedGeneration(row))}` }),
  };
  const siblings =
    row.operation === "list-aggregated"
      ? [healthy(uniqueSlug("sib")), healthy(uniqueSlug("sib"))]
      : [];

  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SLUG,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: as === undefined ? "headers" : "oauth",
        // §15's "whatever log_bodies says": bodies are ON, so a refusal row that recorded
        // one is caught rather than excused by the proxied default.
        logBodies: true,
      },
      ...siblings.map((scenario, n) => ({
        slug: `${SIBLING}${n}`,
        kind: "proxy" as const,
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers" as const,
      })),
    ],
    accounts: [
      {
        slug: AGENT,
        grants: Object.fromEntries(
          [SLUG, ...siblings.map((_, n) => `${SIBLING}${n}`)].map((slug) => [
            slug,
            [{ role: "all", mode: "allow" as const }],
          ]),
        ),
        tokens: [{ as: TOKEN }],
      },
    ],
  });

  const registry = new Registry(env.DB);
  const service = await registry.getService(ns.owner.userId, SLUG);
  if (service === null) throw new Error(`${row.title}: the seeded service vanished`);
  for (const scenario of siblings) {
    const sibling = await registry.getService(
      ns.owner.userId,
      `${SIBLING}${siblings.indexOf(scenario)}`,
    );
    if (sibling !== null) await setHeaders(sibling, HEADERS_CREDENTIAL);
  }

  const world: World = {
    ns,
    service,
    upstreamId: upstream.id,
    ...(as === undefined ? {} : { asId: as.id }),
    sentinel,
    credential: ns.tokens[TOKEN].token,
  };
  await seedCredentials(world, row, as);
  return world;
}

/**
 * The row's credential state, reached ONLY through production seams: headers mode through
 * `setHeaders`, every oauth state through a real begin→callback flow against the fake AS.
 * `needs-reconnect` is the one that takes two steps — a service is flagged by a failed
 * refresh and by nothing else (§7), so the fixture spends one whole call provoking it,
 * before the row's own counters are taken.
 */
async function seedCredentials(
  world: World,
  row: UpstreamFailureRow,
  as: AsScenario | undefined,
): Promise<void> {
  if (as === undefined) {
    await setHeaders(world.service, HEADERS_CREDENTIAL);
    return;
  }
  await connectUpstream(world.ns, world.service);
  if (row.credentials.auth === "oauth" && row.credentials.token === "needs-reconnect") {
    await request(world.credential, requestFor(world, { ...row, operation: "call" }));
    if ((await connectionStatus(world.service)) !== "needs_reconnect") {
      throw new Error(`${row.title}: seeding failed to flip the service to needs_reconnect`);
    }
  }
}

/**
 * A whole §7 connect flow, driven exactly as the owner's browser would drive it:
 * `beginConnect` mints the authorization URL, the fake AS answers the 302 the browser
 * would have followed, and the callback comes back through the composition root on the
 * very cookie session the flow was bound to. Nothing here writes an envelope by hand —
 * that is the point (seed.ts's header), and it is what makes every oauth row below an
 * assertion about a credential the production code actually stored.
 */
export async function connectUpstream(ns: SeededNamespace, service: ServiceDetail): Promise<void> {
  const session = await seedOwnerSession(ns.owner);
  const owner = await requireOwnerSession(
    new Request(`${ORIGIN}/services`, { headers: { Cookie: session.cookie } }),
  );
  const authorize = await beginConnect(service, { id: owner.sessionId });
  const redirected = await fetch(authorize.toString(), { redirect: "manual" });
  const location = redirected.headers.get("Location");
  if (location === null) {
    throw new Error(`connectUpstream: the fake AS answered no redirect (${redirected.status})`);
  }
  const callback = await worker.fetch(
    new Request(location, { headers: { Cookie: session.cookie } }),
    env as unknown as Env,
  );
  if (callback.status !== 302) {
    throw new Error(`connectUpstream: the callback refused (${callback.status})`);
  }
}

/** The AS persona a row's credential state needs, or undefined for a headers-mode row. */
function asScenarioFor(row: UpstreamFailureRow): AsScenario | undefined {
  if (row.credentials.auth !== "oauth") return undefined;
  const id = uniqueSlug("as");
  switch (row.credentials.token) {
    case "fresh":
      return { id };
    case "stale":
      // The rotation quirk is what makes the two-call row load-bearing: a bundle refreshed
      // in memory and never re-sealed is spent, and the second call's refresh is refused.
      return {
        id,
        quirks: row.operation === "call-twice" ? ["stale_first_token", "rotate_refresh"] : ["stale_first_token"],
      };
    case "refresh-fails":
    case "needs-reconnect":
      return { id, quirks: ["stale_first_token", "refresh_fails"] };
  }
}

/** Which issuance the fake upstream must see by the time the row's dial happens: connect
 *  mints generation 1, and a stale bundle has been refreshed to generation 2 before the
 *  forward. The rows that never dial can name either; they never get there. */
function expectedGeneration(row: UpstreamFailureRow): number {
  return row.credentials.auth === "oauth" && row.credentials.token === "stale" ? 2 : 1;
}

/** The row's behavior as an upstream mode, with the sentinel planted in every byte the
 *  upstream is allowed to utter — status text, challenge, and unrelayable body alike. */
function modeFor(behavior: UpstreamBehavior, sentinel: string, foreignId: string): UpstreamMode {
  switch (behavior.act) {
    case "status":
      return {
        kind: "status",
        status: behavior.status,
        body: `upstream refused: ${sentinel}`,
        ...(behavior.wwwAuthenticate === true
          ? { wwwAuthenticate: `Bearer realm="${sentinel}", error="invalid_token"` }
          : {}),
      };
    case "body":
      return { kind: "bad_body", body: BAD_BODIES[behavior.body](sentinel) };
    case "unreachable":
      return { kind: "unreachable" };
    case "hang":
      return { kind: "hang" };
    case "redirect":
      // A different ORIGIN, and one the harness observes: "never followed" is only an
      // assertion if the place it would have gone can say whether anyone arrived.
      return { kind: "redirect", location: `${asUrlFor({ id: foreignId })}/stolen?s=${sentinel}` };
    case "jsonrpc-error":
    case "ok":
      return { kind: "ok" };
  }
}

/** The four structurally different ways a 2xx body fails to be a JSON-RPC message. */
const BAD_BODIES: Record<Extract<UpstreamBehavior, { act: "body" }>["body"], (s: string) => string> = {
  html: (s) => `<!doctype html><html><body><h1>502 ${s}</h1></body></html>`,
  // The one body with nowhere to plant a sentinel — an empty body says nothing by
  // definition, which is exactly what makes it a distinct way of not being a message.
  empty: () => "",
  "json-not-jsonrpc": (s) => JSON.stringify({ ok: false, note: s }),
  truncated: (s) => `{"jsonrpc":"2.0","id":1,"result":{"note":"${s}"`,
};

/** A healthy proxied sibling for the fan-out rows — something for the aggregate to
 *  succeed with, so "the listing still succeeds" is not vacuously true. */
function healthy(id: string): UpstreamScenario {
  return { id, mode: { kind: "ok" }, tools: UPSTREAM_TOOLS, requireBearer: HEADERS_CREDENTIAL.Authorization };
}

// ── the fixture's vocabulary ──────────────────────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

const SLUG = "notion";
const SIBLING = "sib";
const AGENT = "agent";
const TOKEN = "agent-token";
const TOOL = "search";
const ARGS = { q: "anything" };

/** The stored headers-mode credential. Spelled as `Authorization` because that is what a
 *  static-token upstream actually wants, and because it is the value `requireBearer`
 *  checks — a stored header that never rode would answer 401 and fail its row. */
const HEADERS_CREDENTIAL = { Authorization: "Bearer FAKE0000-upstream-static-token" };

/** What the fake upstream serves; the fan-out rows assert these come back slug-prefixed. */
const UPSTREAM_TOOLS: Tool[] = [
  { name: TOOL, inputSchema: { type: "object" } },
  { name: `${TOOL}_pages`, inputSchema: { type: "object" } },
];

/** The upstream's own well-formed JSON-RPC error — the boundary row's whole fixture. It
 *  carries no `data`, which is what keeps the table's dataUnset convention readable here. */
const UPSTREAM_ERROR = { code: -32602, message: "unknown tool: FAKE0000-not-a-tool" };

// ── the two smaller worlds the blocks below share ─────────────────────────────────────

/**
 * One headers-mode proxied service on `upstream`, connected through `setHeaders` — the
 * cheapest world in the file, and the one every case that is about the DIAL rather than
 * about credentials uses.
 */
async function buildHeadersWorld(
  upstream: UpstreamScenario,
  options: { forwardIdentity?: boolean } = {},
): Promise<World> {
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SLUG,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "headers",
        forwardIdentity: options.forwardIdentity,
        logBodies: true,
      },
    ],
    accounts: [
      { slug: AGENT, grants: { [SLUG]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: TOKEN }] },
    ],
  });
  const service = await new Registry(env.DB).getService(ns.owner.userId, SLUG);
  if (service === null) throw new Error("buildHeadersWorld: the seeded service vanished");
  await setHeaders(service, HEADERS_CREDENTIAL);
  return {
    ns,
    service,
    upstreamId: upstream.id,
    sentinel: `FAKE0000-unused-${upstream.id}`,
    credential: ns.tokens[TOKEN].token,
  };
}

/**
 * One oauth-mode proxied service, connected through a whole real §7 flow against `as`.
 * `generation` is the issuance the upstream must see by the time the dial happens — 1 for
 * a bundle that is live as connect left it, 2 for one the call has to refresh first.
 */
async function buildOAuthWorld(
  upstreamId: string,
  as: AsScenario,
  generation: number,
): Promise<World> {
  const upstream: UpstreamScenario = {
    id: upstreamId,
    mode: { kind: "ok" },
    tools: UPSTREAM_TOOLS,
    as,
    requireBearer: `Bearer ${fakeAccessToken(as.id, generation)}`,
  };
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SLUG,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "oauth",
        logBodies: true,
      },
    ],
    accounts: [
      { slug: AGENT, grants: { [SLUG]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: TOKEN }] },
    ],
  });
  const service = await new Registry(env.DB).getService(ns.owner.userId, SLUG);
  if (service === null) throw new Error("buildOAuthWorld: the seeded service vanished");
  await connectUpstream(ns, service);
  return {
    ns,
    service,
    upstreamId,
    asId: as.id,
    sentinel: `FAKE0000-unused-${upstreamId}`,
    credential: ns.tokens[TOKEN].token,
  };
}

/** One scoped `tools/call` through the composition root, with optional consumer `_meta`. */
async function callThrough(
  world: World,
  meta?: Record<string, unknown>,
  tool: string = TOOL,
): Promise<{ status: number; body: JsonRpcResponse; text: string }> {
  return request(world.credential, {
    url: `${ORIGIN}/${world.ns.owner.username}/mcp/${world.service.slug}`,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: ARGS, ...(meta === undefined ? {} : { _meta: meta }) },
    },
  });
}

/**
 * The fan-out world: two proxied upstreams that cannot answer (one refusing, one hung),
 * two healthy proxied ones so the aggregate has something to succeed WITH, and a tunneled
 * service that has never connected — the one participant whose catalog comes from DO cache
 * and therefore cannot miss either deadline. One account granted on all five, so a single
 * aggregated request exercises every branch of the fan-out at once.
 */
async function buildFanOut(): Promise<FanOut> {
  const scenarios: Record<string, UpstreamScenario> = {
    [FAILING]: { id: uniqueSlug("fail"), mode: { kind: "status", status: 503 } },
    [HANGING]: { id: uniqueSlug("hang"), mode: { kind: "hang" } },
    [ALPHA]: healthy(uniqueSlug("alpha")),
    [BETA]: healthy(uniqueSlug("beta")),
  };
  const ns = await seedNamespace(env.DB, {
    services: [
      ...Object.entries(scenarios).map(([slug, scenario]) => ({
        slug,
        kind: "proxy" as const,
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers" as const,
      })),
      { slug: TUNNELED, kind: "tunnel" as const },
    ],
    accounts: [
      {
        slug: AGENT,
        grants: Object.fromEntries(
          [...Object.keys(scenarios), TUNNELED].map((slug) => [
            slug,
            [{ role: "all", mode: "allow" as const }],
          ]),
        ),
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  const registry = new Registry(env.DB);
  // Only the healthy pair is given a credential: the other two never get past their mode,
  // and connecting them would let the fan-out's omission be blamed on a missing bundle.
  for (const slug of [ALPHA, BETA]) {
    const service = await registry.getService(ns.owner.userId, slug);
    if (service !== null) await setHeaders(service, HEADERS_CREDENTIAL);
  }
  const credential = ns.tokens[TOKEN].token;
  const base = `${ORIGIN}/${ns.owner.username}/mcp`;
  return {
    ns,
    scenarios,
    list: (slug?: string) =>
      request(credential, {
        url: slug === undefined ? base : `${base}/${slug}`,
        message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      }),
    healthyDials: async () =>
      (await readObservations(scenarios[ALPHA].id)).length +
      (await readObservations(scenarios[BETA].id)).length,
  };
}

type FanOut = {
  ns: SeededNamespace;
  scenarios: Record<string, UpstreamScenario>;
  list(slug?: string): Promise<{ status: number; body: JsonRpcResponse; text: string }>;
  healthyDials(): Promise<number>;
};

const FAILING = "failing";
const HANGING = "hanging";
const ALPHA = "alpha";
const BETA = "beta";
const TUNNELED = "tunneled";

/** The slugs an aggregated answer reported unavailable — compared as a SET, since a
 *  parallel fan-out decides the order. */
function omittedBy(body: JsonRpcResponse): string[] {
  const meta = (body.result as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const omitted = meta?.["pmcp/unavailable"];
  return Array.isArray(omitted) ? [...(omitted as string[])].sort() : [];
}

/** The tool names an answer served, sorted. */
function toolNames(body: JsonRpcResponse): string[] {
  const tools = (body.result as { tools?: Tool[] } | undefined)?.tools ?? [];
  return tools.map((tool) => tool.name).sort();
}

/** The reserved `_meta` key §7 has the hub mirror onto every forwarded call. */
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

describe("§7 — the failure table: one code out, the class in", () => {
  runUpstreamFailureTable(UPSTREAM_FAILURE_ROWS);
});

// Every case here fans out over a HANGING upstream, so each costs at least
// AGGREGATED_LIST_DEADLINE_MS — well past vitest's default budget. Stated once for the
// block, derived from the constants rather than written as a number.
describe("§7 — aggregated fan-out vs the scoped surface", { timeout: CASE_BUDGET_MS }, () => {
  it("§7 · one failing plus one hanging upstream: the aggregate still succeeds", async () => {
    const fanOut = await buildFanOut();
    const { body } = await fanOut.list();
    expect(body.error, "the aggregate itself always succeeds (§7)").toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it("§7 · both slugs are named in `_meta[\"pmcp/unavailable\"]`, and the healthy services' tools are all present, slug-prefixed", async () => {
    const fanOut = await buildFanOut();
    const { body } = await fanOut.list();
    expect(omittedBy(body)).toEqual([FAILING, HANGING].sort());
    // One service's failure may not cost the consumer the other nine: both healthy
    // catalogs arrive whole, and prefixed, while two slugs are quietly omitted.
    expect(toolNames(body)).toEqual(
      UPSTREAM_TOOLS.flatMap((tool) => [`${ALPHA}_${tool.name}`, `${BETA}_${tool.name}`]).sort(),
    );
  });

  it("§7 · the scoped list against the same failing service → -32000 — where the aggregate's silent omission surfaces", async () => {
    const fanOut = await buildFanOut();
    expect(omittedBy((await fanOut.list()).body)).toContain(FAILING);
    const scoped = await fanOut.list(FAILING);
    expect(scoped.body.error?.code).toBe(-32000);
    expect(scoped.body.error?.data, "nothing upstream-derived rides the refusal").toBeUndefined();
  });

  it("§7 · the fan-out honors AGGREGATED_LIST_DEADLINE_MS, not CALL_TIMEOUT_MS — a hang cannot hold the listing past it", async () => {
    const fanOut = await buildFanOut();
    const started = Date.now();
    const { body } = await fanOut.list();
    const elapsed = Date.now() - started;
    expect(omittedBy(body)).toContain(HANGING);
    // Both bounds, because either alone is met by a wrong implementation: an aggregate that
    // gave up instantly would beat the ceiling, and one that waited out the call budget
    // would still finish eventually. The two knobs are what this case exists for (§11).
    expect(elapsed, "the hung upstream cost at least its own deadline").toBeGreaterThanOrEqual(
      AGGREGATED_LIST_DEADLINE_MS,
    );
    expect(elapsed, "and never the call budget").toBeLessThan(CALL_TIMEOUT_MS);
  });

  it("§7 · a tunneled service in the same fan-out answers from DO cache and is unaffected by either deadline", async () => {
    const fanOut = await buildFanOut();
    const { body } = await fanOut.list();
    // A tunneled service that has never connected lists no tools (§7) — but from CACHE, so
    // it is not "unavailable": an empty catalog is an ANSWER, and the two states are the
    // difference between a Reconnect button and a service nobody has registered yet.
    expect(omittedBy(body)).not.toContain(TUNNELED);
    expect(toolNames(body).filter((name) => name.startsWith(`${TUNNELED}_`))).toEqual([]);
  });

  it("§15 · none of these paths writes an audit row — `tools/list` is out of the vocabulary", async () => {
    const fanOut = await buildFanOut();
    const before = await query(env.DB, fanOut.ns.owner.userId, { limit: 200 });
    await fanOut.list();
    await fanOut.list(FAILING);
    await fanOut.list(ALPHA);
    const after = await query(env.DB, fanOut.ns.owner.userId, { limit: 200 });
    // Three listings, one of them a refusal: agent polling noise never reaches the ledger.
    expect(after.total).toBe(before.total);
  });
});

describe("§7 — credentials at call time", () => {
  it("§7 · a stale oauth bundle is refreshed BEFORE the forward: the token endpoint is dialed first, the resource second", async () => {
    // ONE observation log for both endpoints — the AS and the resource are given the SAME
    // scenario id, which is the only way arrival ORDER across two hosts is a fact rather
    // than an inference from two independently-numbered logs.
    const shared = uniqueSlug("order");
    const world = await buildOAuthWorld(shared, { id: shared, quirks: ["stale_first_token"] }, 2);
    const before = (await readObservations(shared)).length;
    const { body } = await callThrough(world);
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();

    const arrivals = (await readObservations(shared)).slice(before);
    const tokenAt = arrivals.findIndex(isTokenDial);
    const resourceAt = arrivals.findIndex((arrival) => arrival.rpcMethod === "tools/call");
    expect(tokenAt, "the refresh happened").toBeGreaterThanOrEqual(0);
    expect(resourceAt, "and so did the forward").toBeGreaterThanOrEqual(0);
    expect(tokenAt, "refreshed BEFORE the forward, never instead of it").toBeLessThan(resourceAt);
  });

  it("§7 · a failed refresh flips needs_reconnect, writes `upstream.oauth_refresh_failed`, and never dials the resource", async () => {
    const upstreamId = uniqueSlug("dead");
    const as: AsScenario = { id: uniqueSlug("as"), quirks: ["stale_first_token", "refresh_fails"] };
    const world = await buildOAuthWorld(upstreamId, as, 1);
    expect(await connectionStatus(world.service), "connected until a refresh proves otherwise").toBe(
      "connected",
    );
    // A DELTA, because connect already touched this host: RFC 9728 discovery is a request
    // the resource server genuinely saw, and it is logged like any other arrival. What this
    // case is about is what the CALL costs, which is the count around the call.
    const before = (await readObservations(upstreamId)).length;

    const { body } = await callThrough(world);
    expect(body.error?.code).toBe(-32000);
    expect(await connectionStatus(world.service)).toBe("needs_reconnect");
    // Stated as the arrivals themselves rather than as a count, so a row that goes red
    // says WHAT reached the resource instead of only how much did.
    expect(
      (await readObservations(upstreamId))
        .slice(before)
        .map((arrival) => `${arrival.method} ${arrival.path} ${arrival.rpcMethod ?? "-"}`),
      "the resource is never reached",
    ).toEqual([]);

    const written = await query(env.DB, world.ns.owner.userId, {
      event: "upstream.oauth_refresh_failed",
    });
    expect(written.total, "the ledger records the credential's death").toBe(1);
    expect(written.rows[0].service).toBe(SLUG);
  });

  it("§7 · the TWIN of the flip: a token endpoint that fails to ANSWER costs the call and nothing else — the service is still `connected` and no refresh-failure row is written", async () => {
    // The same stale bundle, the same refused call, one thing different: this AS does not
    // reject the grant, it fails to answer it (a 503 — what a ten-second outage looks like).
    // §7 binds needs_reconnect to a FAILED REFRESH, and a blip is not one: flipping here
    // would brick a live credential until a human clicks Reconnect, and the ledger and the
    // UI would show it as indistinguishable from a revoked grant.
    const as: AsScenario = { id: uniqueSlug("as"), quirks: ["stale_first_token", "refresh_unreachable"] };
    const world = await buildOAuthWorld(uniqueSlug("blip"), as, 2);

    const { body } = await callThrough(world);
    expect(body.error?.code, "the call is refused like any other upstream failure").toBe(-32000);
    expect(body.error?.data, "and carries nothing of the AS").toBeUndefined();
    expect(
      await connectionStatus(world.service),
      "an unreachable token endpoint is not a dead credential",
    ).toBe("connected");
    const written = await query(env.DB, world.ns.owner.userId, {
      event: "upstream.oauth_refresh_failed",
    });
    expect(written.total, "the credential did not die, so the ledger does not say it did").toBe(0);
  }, CASE_BUDGET_MS);

  it("§7 · two CONCURRENT calls across one stale bundle leave the service connected — a rotating AS burns the loser's refresh token, and the flip is a compare-and-set rather than a brick", async () => {
    // The failure the two-call row cannot see, because it is sequential: both calls open the
    // same bundle, both exchange, and the second presents a token the first already burned.
    // Whatever the interleaving, the credential must survive — at most one refused call.
    const as: AsScenario = {
      id: uniqueSlug("as"),
      quirks: ["stale_first_token", "rotate_refresh"],
    };
    const world = await buildOAuthWorld(uniqueSlug("race"), as, 2);

    const answers = await Promise.all([callThrough(world), callThrough(world)]);

    expect(
      await connectionStatus(world.service),
      "a lost race is never a credential the owner has to repair by hand",
    ).toBe("connected");
    expect(
      answers.some(({ body }) => body.error === undefined),
      "and at least one of the two calls went through",
    ).toBe(true);
  }, CASE_BUDGET_MS);

  it("§7 · a fresh bundle triggers no refresh at all — zero token dials (the twin)", async () => {
    const as: AsScenario = { id: uniqueSlug("as") };
    const world = await buildOAuthWorld(uniqueSlug("live"), as, 1);
    const before = (await readObservations(as.id)).filter(isTokenDial).length;
    const { body } = await callThrough(world);
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    const after = (await readObservations(as.id)).filter(isTokenDial).length;
    expect(after - before, "refresh is proactive, not unconditional").toBe(0);
  });

  it("§7 · headers-mode: the stored headers ride the dial and appear in no response and no audit row", async () => {
    const upstream = healthy(uniqueSlug("hdr"));
    const world = await buildHeadersWorld(upstream);
    const { body, text } = await callThrough(world);
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();

    const [dial] = await readObservations(upstream.id);
    expect(dial.authorization, "the sealed header is what reached the upstream").toBe(
      HEADERS_CREDENTIAL.Authorization,
    );
    // Written once and read back never (§8's write-only rule) — and above all, never echoed
    // to the consumer or into the ledger, which is where a static credential would leak.
    expect(text.includes(HEADERS_CREDENTIAL.Authorization)).toBe(false);
    const written = await query(env.DB, world.ns.owner.userId, { limit: 200 });
    expect(JSON.stringify(written.rows).includes(HEADERS_CREDENTIAL.Authorization)).toBe(false);
  });
});

describe("§7 — caller identity forwarding, off by default", () => {
  it("§7 · `forward_identity` absent (default false) → no `X-Pmcp-*` header on the upstream request", async () => {
    const upstream = healthy(uniqueSlug("noid"));
    const world = await buildHeadersWorld(upstream);
    await callThrough(world);
    const [dial] = await readObservations(upstream.id);
    // Third-party upstreams (Notion, Linear) have no use for internal identifiers, so with
    // the flag off nothing is sent — not an empty header, none at all.
    expect(dial.pmcpHeaders).toEqual({});
  });

  it("§7 · `forward_identity: true` → `X-Pmcp-Principal` and `X-Pmcp-Roles`, the wildcard forwarded literally as `all`", async () => {
    const upstream = healthy(uniqueSlug("id"));
    const world = await buildHeadersWorld(upstream, { forwardIdentity: true });
    await callThrough(world);
    const [dial] = await readObservations(upstream.id);
    expect(dial.pmcpHeaders).toEqual({
      "x-pmcp-principal": `sa:${AGENT}`,
      // Literal, never expanded into the declared role names (§7) — an upstream branching
      // on it must see the same word the grant carries.
      "x-pmcp-roles": "all",
    });
  });

  it("§7 · consumer headers (Authorization, Cookie) are never copied upstream under either setting", async () => {
    for (const forwardIdentity of [false, true]) {
      const upstream = healthy(uniqueSlug("hygiene"));
      const world = await buildHeadersWorld(upstream, { forwardIdentity });
      await worker.fetch(
        new Request(`${ORIGIN}/${world.ns.owner.username}/mcp/${SLUG}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${world.credential}`,
            Cookie: "session=FAKE0000-consumer-cookie",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: TOOL, arguments: ARGS },
          }),
        }),
        env as unknown as Env,
      );
      const [dial] = await readObservations(upstream.id);
      // The hub terminates auth entirely (§7): what rides upstream is the SERVICE's stored
      // credential, never the caller's — MCP's audience-binding rules forbid pass-through —
      // and the caller's cookie is not copied at all.
      expect(dial.authorization, `forwardIdentity: ${forwardIdentity}`).toBe(
        HEADERS_CREDENTIAL.Authorization,
      );
      expect(dial.authorization?.includes(world.credential)).toBe(false);
      expect(dial.cookie, `forwardIdentity: ${forwardIdentity}`).toBeUndefined();
    }
  });

  it("§7 · the consumer's declared clientCapabilities are mirrored onto the per-request client, `{}` when none were declared", async () => {
    const declared = { elicitation: {}, sampling: {} };
    const declaring = healthy(uniqueSlug("caps"));
    await callThrough(await buildHeadersWorld(declaring), { [CLIENT_CAPABILITIES]: declared });
    const [withCapabilities] = await readObservations(declaring.id);
    expect(withCapabilities.meta?.[CLIENT_CAPABILITIES]).toEqual(declared);

    // Legacy consumers declare none and are forwarded `{}`, so services correctly refrain
    // from elicitation and sampling for them rather than guessing.
    const legacy = healthy(uniqueSlug("legacy"));
    await callThrough(await buildHeadersWorld(legacy));
    const [withNone] = await readObservations(legacy.id);
    expect(withNone.meta?.[CLIENT_CAPABILITIES]).toEqual({});
  });
});

describe("§10 — subrequest budgets asserted explicitly (workerd enforces none locally)", { timeout: CASE_BUDGET_MS }, () => {
  it("§10 · one tools/call is exactly one resource dial — never pooled, never retried", async () => {
    const upstream = healthy(uniqueSlug("budget"));
    const world = await buildHeadersWorld(upstream);
    await callThrough(world);
    expect((await readObservations(upstream.id)).length).toBe(1);
  });

  it("§10 · an aggregated list over N proxied services is N dials, and a second list dials again (no proxied catalog cache in v1)", async () => {
    const fanOut = await buildFanOut();
    // Counted on the two HEALTHY slugs: what a failing or hung upstream costs is the
    // failure table's business, and this case is about the fan, not the failures.
    const before = await fanOut.healthyDials();
    await fanOut.list();
    const afterFirst = await fanOut.healthyDials();
    expect(afterFirst - before, "one dial per proxied service in the fan").toBe(2);
    await fanOut.list();
    expect(
      (await fanOut.healthyDials()) - afterFirst,
      "and again next time — proxied catalogs are never cached in v1 (§7)",
    ).toBe(2);
  });

  it("§10 · an upstream redirect is not followed — `redirect: \"manual\"` keeps a bearer from walking off to another origin", async () => {
    const foreignId = uniqueSlug("foreign");
    const world = await buildHeadersWorld({
      id: uniqueSlug("moved"),
      mode: { kind: "redirect", location: `${asUrlFor({ id: foreignId })}/stolen` },
    });
    const { body } = await callThrough(world);
    expect(body.error?.code, "a 3xx is an ANSWER, not an instruction").toBe(-32000);
    expect(
      (await readObservations(foreignId)).length,
      "and the stored credential never walked off to the other origin",
    ).toBe(0);
  });
});

describe("§7 — proxied redaction has no schema half", () => {
  it("§7 · upstreamBackend.sensitivePaths resolves `{ args: [], results: [] }` and never null", async () => {
    const world = await buildHeadersWorld(healthy(uniqueSlug("paths")));
    // Both a tool the upstream lists and one it has never heard of: with no cached catalog
    // there is no "unknown", so neither direction has a writeOnly map to derive.
    for (const tool of [TOOL, "a-tool-this-upstream-never-heard-of"]) {
      expect(await upstreamBackend.sensitivePaths(world.service, tool), tool).toEqual({
        args: [],
        results: [],
      });
    }
  });

  it("§7 · so no proxied call is ever refused for a catalog miss — the tunneled twin (-32001) is approval-e2e's", async () => {
    const upstream = healthy(uniqueSlug("miss"));
    const world = await buildHeadersWorld(upstream);
    const { body } = await callThrough(world, undefined, "not-in-the-catalog");
    expect(body.error?.code, "no map means no refusal here — the upstream decides").not.toBe(-32001);
    expect((await readObservations(upstream.id)).length, "it was forwarded, not refused").toBe(1);
  });
});
