// upstream-credentials.test.ts — custody of upstream credentials (§7, §5): the envelope
// at rest, the totality of `connectionStatus`, and the connect flow's refusal matrix.
//
// The file exists because every failure it pins is silent. An envelope that stopped being
// encrypted still works; a callback that accepts a replayed `state` still connects; a
// `connectionStatus` that answers `connected` for a service whose refresh died still
// renders a page. Nothing goes red in production — the owner just has a D1 export with
// upstream tokens in it, or an attacker's authorization code redeemed into the owner's
// service row.
//
// Three things carry it:
//  · The status function is TOTAL over auth mode × stored-envelope state, which is why
//    the table is a cross-product with a coverage law rather than a handful of cases:
//    `needs_reconnect` is unreachable in headers mode, and the way to pin an unreachable
//    combination is to enumerate the space, not to test the reachable corners.
//  · Every callback refusal stores NOTHING — asserted against the whole service row, not
//    the envelope column alone. A refusal that still stamped a status or an audit row
//    would be a partial write on the CSRF path.
//  · The fake authorization server is ADVERSARIAL, not spec-shaped (strategy §9): it
//    serves no RFC 9728 document, refuses CIMD so DCR is forced, omits `expires_in`, and
//    performs a REAL S256 verifier check. Those are four production-only OAuth failures
//    made in-process, and a spec-shaped fake would pin none of them.
//
// Boundaries: refresh-before-forward, the needs_reconnect call path and the
// everything-becomes--32000 failure table are upstream-proxy.test.ts's; the flip that
// clears the envelope when the auth MODE changes is registry's row invariant, pinned in
// registry.test.ts and only observed here through connectionStatus.
//
// Project: `worker` — real D1, real WebCrypto, real fetch through miniflare's
// outboundService (fetchMock is gone; the fake AS and fake upstream are routes on that
// one router). No socket, no DO: parallel, per-file isolation, order free. The state
// row's TTL is read from limits.OAUTH_STATE_TTL_MS, never as a literal (§7).
//
// deps: test/harness/seed (namespace, proxied services) · test/harness/fake-upstream
// (outboundService router: the adversarial fake AS + token endpoint) · server/src/upstream
// (beginConnect, handleCallback, disconnect, setHeaders, connectionStatus,
// cleanupStaleState, clientMetadata) · server/src/limits (OAUTH_STATE_TTL_MS) · env.DB
// (real D1) · crypto.subtle (the AS's real S256 check)

import { describe, it } from "vitest";
import type { ServiceDetail } from "../../src/registry";
import type { UpstreamConnectionStatus } from "../../src/upstream";

/**
 * One cell of the status cross-product: an auth mode, an envelope state, and the answer.
 *
 * `envelope` names STORED state rather than upstream reality on purpose — connectionStatus
 * never dials, so a `connected` answer means "the last refresh left a live bundle here",
 * and a genuinely-down upstream that still holds good credentials is correctly
 * `connected` until a call proves otherwise. A row asserting otherwise would be asking
 * this function to do I/O it must not do.
 */
export type ConnectionStatusRow = {
  title: string;
  authMode: NonNullable<ServiceDetail["upstreamAuthMode"]>;
  envelope: "none" | "headers" | "oauth_live" | "oauth_refresh_failed";
  expect: UpstreamConnectionStatus;
};

/**
 * The single defect introduced into an otherwise-complete callback — the anti-CSRF and
 * mix-up matrix of §7. `none` is a member, so the allow-twin sits in the same table
 * (§9 rule 2): a handler that rejected every callback would satisfy a refusals-only list
 * and break nothing a test could see.
 *
 * `bearer_sourced_session` is not a duplicate of `no_owner_session`: a CLI device-flow
 * session replayed as a cookie is a VALID session that must still be refused here, which
 * is the whole reason identity distinguishes them.
 */
export type CallbackDefect =
  | "none"
  | "state_missing"
  | "state_unknown"
  | "state_replayed"
  | "state_expired"
  | "state_other_session"
  | "no_owner_session"
  | "bearer_sourced_session"
  | "iss_mismatch"
  | "verifier_mismatch";

/**
 * One callback row. `stores` is binary because the rule is binary — either the flow
 * completed and sealed a bundle, or the service row is byte-identical to before. The
 * response the browser gets is deliberately absent from the row type: error prose and
 * redirect targets are incidental (§7), and "never echoes AS details" is a hygiene law
 * asserted once by the runner rather than transcribed per row.
 */
export type OAuthCallbackRow = {
  title: string;
  defect: CallbackDefect;
  stores: "credential_envelope" | "nothing";
  audit: "upstream.oauth_connected" | "none";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const connectionStatusRows: readonly ConnectionStatusRow[] = [];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const oauthCallbackRows: readonly OAuthCallbackRow[] = [];

/**
 * Registers one case per status row: seed the mode and envelope state, assert the answer,
 * and assert the call made no outbound request (the read is side-effect free by
 * contract). Table law: the rows exhaust auth mode × envelope state — totality is the
 * property here, so a combination without a row fails the table rather than going
 * unasked.
 */
export function runConnectionStatusTable(rows: readonly ConnectionStatusRow[]): void {
  // deps: test/harness/seed · server/src/upstream (connectionStatus)
  throw new Error("unimplemented");
}

/**
 * Registers one case per callback row: run a real begin→callback flow against the fake AS
 * with the row's defect injected, then assert what was stored and what was audited. Two
 * table-wide laws: every `nothing` row leaves the ENTIRE service row unchanged, not just
 * the envelope column, and no response body or redirect ever carries an AS-derived
 * status, header or body (§7's hygiene rule extended to this surface).
 */
export function runOAuthCallbackTable(rows: readonly OAuthCallbackRow[]): void {
  // deps: test/harness/seed · test/harness/fake-upstream (fake AS) ·
  //       server/src/upstream (beginConnect, handleCallback)
  throw new Error("unimplemented");
}

describe("§7 · connectionStatus is total", () => {
  it.todo("one case per connectionStatusRow — title as authored");
  it.todo("§7 · the cross-product is exhausted and the read dials nothing");
});

describe("§5 · the envelope at rest", () => {
  it.todo("§5 · a sentinel header stored through setHeaders appears nowhere in the service row — the column holds ciphertext");
  it.todo("§5 · twin to the case above: the fake upstream observes that exact header on the next dial — sealed, not lost");
  it.todo("§5 · the envelope leads with a version byte, so ciphertext written under today's key is self-describing before any key is applied");
});

describe("§7 · one credential path per mode", () => {
  it.todo("§7 · setHeaders refuses an oauth-mode service and beginConnect refuses a headers-mode or tunneled one · twins: each mode's own path stores");
  it.todo("§7 · disconnect wipes the envelope, writes upstream.disconnected, leaves roles, grants and config untouched, and is idempotent");
});

describe("§7 · the connect flow against an adversarial AS", () => {
  it.todo("§7 · beginConnect records one single-use state row bound to owner, service, issuer, token endpoint, verifier and session — and stores nothing on the service");
  it.todo("§7 · the AS's real S256 check bites: a redemption carrying a verifier that does not match the recorded challenge is refused and stores nothing · twin: the bound verifier redeems");
  it.todo("§7 · mix-up defense: the code is redeemed only at the token endpoint recorded at initiation, even when the AS advertises a different one afterwards");
  it.todo("§7/§9 · the adversarial branches are the real ones: no RFC 9728 document, CIMD refused so DCR runs, no expires_in in the token response — connect still completes and the service reads `connected`");
});

describe("§7 · the callback refusal matrix", () => {
  it.todo("one case per oauthCallbackRow — title as authored");
  it.todo("§7 · state is single-use by compare-and-set delete: of two concurrent callbacks on one state row, one connects and one is refused");
});

describe("§7 · hygiene around the flow", () => {
  it.todo("§7 · cleanupStaleState deletes past-TTL rows and only those — and a past-TTL row was already dead to the callback before the sweep ran (hygiene, not correctness)");
  it.todo("§7 · clientMetadata serves a static secret-free document whose client_id is its own URL under the injected origin");
});
