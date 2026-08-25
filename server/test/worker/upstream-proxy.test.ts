// upstream-proxy.test.ts — the proxied path: one code out, the failure class in.
//
// What this suite pins: §7's upstream failure table — every failure class (non-2xx, a 2xx
// body that is not JSON-RPC, transport/TLS failure, timeout, and a stored bundle already
// flagged needs_reconnect) collapses into ONE -32000 whose `data` is unset, with the real
// class surviving only in the audit row's `detail`; the log-hygiene extension that goes
// with it (the upstream's status line, its headers — `WWW-Authenticate` included — and
// its body are never echoed to a consumer); the aggregated fan-out contract, where a
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

import { describe, it } from "vitest";
import type { UpstreamFailureClass } from "../../src/upstream";

/**
 * What the fake upstream does when dialed — the row's only input, and deliberately
 * expressed as BEHAVIOR rather than as an expected class, so the mapping from behavior to
 * class is the thing under test and not a restatement of it.
 *
 * `hang` is parameterized by which constant it must outlive, never by a literal: the two
 * deadlines are two knobs (strategy §11 — a slow upstream may take the full call budget
 * when dialed directly but must not hold an aggregated listing hostage), and a row that
 * hard-coded milliseconds would make "30 s → 45 s" a test edit.
 */
export type UpstreamBehavior =
  | { act: "status"; status: number; wwwAuthenticate?: boolean }
  | { act: "body"; body: "html" | "empty" | "json-not-jsonrpc" | "truncated" }
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
 * and is `null` exactly when the row succeeds.
 *
 * `dials` is the explicit subrequest budget: how many requests the resource server must
 * see, and `tokenDials` how many the authorization server must. workerd enforces no cap
 * locally, so an unasserted budget is an unnoticed retry storm in production (§10).
 */
export type UpstreamExpectation = {
  code: -32000 | null;
  dataUnset: boolean;
  failureClass: UpstreamFailureClass | null;
  dials: number;
  tokenDials: number;
};

/** One row of the upstream failure table. */
export type UpstreamFailureRow = {
  /** e.g. "§7 · upstream 401 → -32000, class upstream_status, WWW-Authenticate never echoed". */
  title: string;
  behavior: UpstreamBehavior;
  credentials: UpstreamCredentialState;
  /** Which surface drives the dial — the three differ in how they treat the same failure. */
  operation: "call" | "list-scoped" | "list-aggregated";
  expect: UpstreamExpectation;
  /** §9 rule 2 — the title of the allow row this refusal sits beside. */
  twin: string;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1) — agents write the fake upstream and the runner, never the oracle.
 */
export const UPSTREAM_FAILURE_ROWS: readonly UpstreamFailureRow[] = [];

/**
 * The one assertion path for the failure table: configure the fake upstream for the row's
 * behavior and credential state, drive the operation through `exports.default.fetch`, and
 * check the code, the unset `data`, the audit row's class cell, and both dial counters.
 *
 * The law that lives in the runner rather than in any row: a sentinel string planted in
 * the upstream's status text, its `WWW-Authenticate` header, and its body must appear in
 * NO consumer-visible byte of the response — message, `data`, or `_meta` alike. Asserting
 * that per row invites a row that forgets to, and the leak this guards against is
 * invisible by construction (strategy §5). The runner also enforces §9 rule 2 over
 * `twin`.
 */
export function runUpstreamFailureTable(rows: readonly UpstreamFailureRow[]): void {
  // deps: harness/seed · harness/fake-upstream (behavior router + dial counters) ·
  //   ../../src/index (default.fetch) · ../../src/audit (query) · env.DB
  throw new Error("unimplemented");
}

describe("§7 — the failure table: one code out, the class in", () => {
  it.todo("§7 · a non-2xx answer → -32000, `detail` records upstream_status with the status");
  it.todo("§7 · a 2xx body that is not a JSON-RPC message → -32000, class bad_body");
  it.todo("§7 · a transport/TLS failure before any response → -32000, class unreachable");
  it.todo("§7 · no answer inside CALL_TIMEOUT_MS → -32000, class timeout");
  it.todo("§7 · a service already flagged needs_reconnect → -32000 with zero dials, class needs_reconnect");
  it.todo("§7 · a well-formed upstream result is relayed verbatim — the allow-twin every failure row names");
  it.todo("§7 · `data` is unset on every failure row; nothing upstream-derived survives the gateway mapping");
  it.todo("§15 · a sentinel planted in the upstream's status text, WWW-Authenticate, and body reaches no consumer-visible byte");
});

describe("§7 — aggregated fan-out vs the scoped surface", () => {
  it.todo("§7 · one failing plus one hanging upstream: the aggregate still succeeds");
  it.todo("§7 · both slugs are named in `_meta[\"pmcp/unavailable\"]`, and the healthy services' tools are all present, slug-prefixed");
  it.todo("§7 · the scoped list against the same failing service → -32000 — where the aggregate's silent omission surfaces");
  it.todo("§7 · the fan-out honors AGGREGATED_LIST_DEADLINE_MS, not CALL_TIMEOUT_MS — a hang cannot hold the listing past it");
  it.todo("§7 · a tunneled service in the same fan-out answers from DO cache and is unaffected by either deadline");
  it.todo("§15 · none of these paths writes an audit row — `tools/list` is out of the vocabulary");
});

describe("§7 — credentials at call time", () => {
  it.todo("§7 · a stale oauth bundle is refreshed BEFORE the forward: the token endpoint is dialed first, the resource second");
  it.todo("§7 · a failed refresh flips needs_reconnect, writes `upstream.oauth_refresh_failed`, and never dials the resource");
  it.todo("§7 · a fresh bundle triggers no refresh at all — zero token dials (the twin)");
  it.todo("§7 · headers-mode: the stored headers ride the dial and appear in no response and no audit row");
});

describe("§7 — caller identity forwarding, off by default", () => {
  it.todo("§7 · `forward_identity` absent (default false) → no `X-Pmcp-*` header on the upstream request");
  it.todo("§7 · `forward_identity: true` → `X-Pmcp-Principal` and `X-Pmcp-Roles`, the wildcard forwarded literally as `all`");
  it.todo("§7 · consumer headers (Authorization, Cookie) are never copied upstream under either setting");
  it.todo("§7 · the consumer's declared clientCapabilities are mirrored onto the per-request client, `{}` when none were declared");
});

describe("§10 — subrequest budgets asserted explicitly (workerd enforces none locally)", () => {
  it.todo("§10 · one tools/call is exactly one resource dial — never pooled, never retried");
  it.todo("§10 · an aggregated list over N proxied services is N dials, and a second list dials again (no proxied catalog cache in v1)");
  it.todo("§10 · an upstream redirect is not followed — `redirect: \"manual\"` keeps a bearer from walking off to another origin");
});

describe("§7 — proxied redaction has no schema half", () => {
  it.todo("§7 · upstreamBackend.sensitivePaths resolves `{ args: [], results: [] }` and never null");
  it.todo("§7 · so no proxied call is ever refused for a catalog miss — the tunneled twin (-32001) is approval-e2e's");
});
