// fake-upstream.ts — the far side of every proxied service: an in-test MCP upstream and,
// beside it, a deliberately ADVERSARIAL OAuth authorization server that performs REAL
// S256 PKCE verification.
//
// WHAT THIS PINS: that the hub's proxied path is exercised against something that can
// actually say no. Strategy §9 asks the fake AS to be adversarial rather than
// spec-shaped — no RFC 9728 document, CIMD rejected so DCR is forced, no `expires_in`,
// single-use rotated refresh tokens — because those four are the production-only OAuth
// failures, and a spec-shaped fake converts none of them into an in-process test. The
// PKCE check is real crypto (S256 = base64url(SHA-256(verifier))): a hub that forwards
// the wrong verifier, or none, must fail here for the same reason it would fail at Linear.
//
// WHAT IT MUST NOT FAKE (strategy §9): WebCrypto, the hub's MCP client, or the JSON-RPC
// wire. It answers real JSON-RPC over real HTTP. Its one licensed lie is the network
// itself — `unreachable` is a rejected fetch and `hang` is a promise that never settles,
// because workerd has no way to unplug a cable.
//
// PROJECT: `worker` — parallel, per-file storage isolation, no sockets. Wired in as
// `miniflare.outboundService` (strategy §2: `fetchMock` is gone and a plain function is
// the supported replacement), which forces the design decision below.
//
// THE ISOLATION CONSTRAINT, stated plainly because it shaped the whole API: an
// `outboundService` function is configured ONCE for the pool, outside any test's scope,
// and does not share memory with the test that provoked the request. So this harness
// carries NO per-test registration step and NO shared mutable state. A scenario is named
// in the URL the seeded service points at (`upstreamUrlFor`), and everything a test wants
// to know afterwards is read back over the wire (`readObservations`) rather than out of a
// variable. That is not a workaround; it is what makes two files running in parallel
// against the same router impossible to confuse.
//
// deps: crypto.subtle (real SHA-256 for S256) · fetch Request/Response · gateway.Tool (shape only) · upstream.UpstreamFailureClass (vocabulary only) — no hub module at runtime, no MCP SDK

import type { Tool } from "../../src/gateway";
import type { UpstreamFailureClass } from "../../src/upstream";

/**
 * The reserved hostname every proxied fixture points at. A single host keeps the
 * outboundService router total: anything else reaching it is a real escape attempt by the
 * code under test, and the router answers those with a distinctive failure rather than
 * silently proxying (a test that accidentally dials the internet is a test that will pass
 * in CI and fail on a plane).
 */
export const UPSTREAM_HOST = "upstream.pmcp-test.invalid";

/** The adversarial authorization server's host — deliberately a different origin from the
 *  resource, so the mix-up defense (§7: redeem only at the recorded token endpoint) has
 *  two endpoints to be confused between. */
export const AS_HOST = "as.pmcp-test.invalid";

/**
 * What the upstream does with a request. Four of upstream.ts's five
 * `UpstreamFailureClass` values are producible here; `needs_reconnect` deliberately is
 * NOT — it is hub state, reached by an AS whose refresh fails (`AsQuirk` "refresh_fails")
 * and never by anything the resource server says. Keeping that asymmetry visible in the
 * type is the point: a fixture cannot short-circuit the flip that produces it.
 *
 * - `ok` — serve `tools` and answer calls; the allow-twin every failure row needs.
 * - `status` — answer non-2xx → `upstream_status` (the audit detail records the number).
 * - `bad_body` — answer 200 with something that is not a JSON-RPC message → `bad_body`.
 * - `unreachable` — reject the fetch before any response → `unreachable`.
 * - `hang` — never settle; the hub's own deadline ends it → `timeout`. Which deadline
 *   bites depends on the caller: limits.AGGREGATED_LIST_DEADLINE_MS in a fan-out,
 *   limits.CALL_TIMEOUT_MS on a scoped call — two knobs, and this mode is how they are
 *   told apart.
 * - `redirect` — answer 3xx to another origin: the code contract from strategy §10
 *   (`redirect: "manual"` on upstream dials) means the bearer must not walk off with it,
 *   and this is the only way to observe that in-process.
 */
export type UpstreamMode =
  | { kind: "ok" }
  | { kind: "status"; status: number; body?: string }
  | { kind: "bad_body"; body: string }
  | { kind: "unreachable" }
  | { kind: "hang" }
  | { kind: "redirect"; location: string };

/**
 * A named upstream, addressed by URL. `id` becomes a path segment, so two parallel files
 * can hold different scenarios without either knowing the other exists. `requireBearer`
 * is what makes a credential test mean anything — an upstream that accepts anything
 * cannot prove the hub sent the right thing.
 */
export type UpstreamScenario = {
  id: string;
  mode: UpstreamMode;
  /** Served from `tools/list`; schemas ride along, though §7 pins that proxied schemas are never cached. */
  tools?: Tool[];
  /** Answered to `tools/call`; a `resultType: "input_required"` value drives the proxied MRTR leg. */
  result?: unknown;
  /** Reject with 401 unless this exact `Authorization` value arrives — the header-mode credential pin. */
  requireBearer?: string;
  /** Delay before answering, in ms — for deadline rows that must be slow without being infinite. */
  delayMs?: number;
};

/**
 * The ways the authorization server misbehaves, each converting one production-only
 * failure into an in-process one (§9). Applied per flow, named in the URL like scenarios.
 *
 * - `no_prm` — serve no RFC 9728 protected-resource metadata: discovery must fall back
 *   or fail cleanly, never crash.
 * - `reject_cimd` — refuse the hub's CIMD client identity, forcing Dynamic Client
 *   Registration. The DCR path is otherwise never exercised.
 * - `no_expires_in` — omit `expires_in` from the token response: the hub must still know
 *   when to refresh, or must refresh eagerly, rather than treating absence as forever.
 * - `rotate_refresh` — issue a new refresh token each time and reject the old one: a hub
 *   that stores the bundle non-atomically loses the account on the second refresh.
 * - `refresh_fails` — reject every refresh: the ONLY producer of `needs_reconnect`, and
 *   the row where `-32000` must arrive with no dial attempted.
 * - `advertise_iss` — advertise RFC 9207 and return `iss`, so the hub's `iss` check has
 *   something to check; its twin `wrong_iss` returns a different issuer and must be
 *   rejected with nothing stored.
 * - `wrong_iss` — see above; the refusal twin of `advertise_iss`.
 */
export type AsQuirk =
  | "no_prm"
  | "reject_cimd"
  | "no_expires_in"
  | "rotate_refresh"
  | "refresh_fails"
  | "advertise_iss"
  | "wrong_iss";

/** One authorization-server persona, addressed by URL exactly like an upstream scenario. */
export type AsScenario = {
  id: string;
  quirks?: AsQuirk[];
};

/**
 * What the fake saw, read back over the wire. This is the harness's answer to "prove the
 * refresh happened BEFORE the forward" (§16) without shared memory: an ordered list of
 * what arrived, in arrival order, per scenario id.
 *
 * `pkce` records the verifier check as the AS actually performed it — `presented` is what
 * the hub sent, `expected` is the recomputed S256 of the stored verifier, `ok` is their
 * comparison. A test asserts on `ok`, never recomputing the hash itself; recomputing it
 * in the test would just be a second implementation of the thing under test.
 */
export type UpstreamObservation = {
  seq: number;
  method: string;
  path: string;
  /** Present iff an `Authorization` header arrived; the VALUE, so header-mode credentials are pinned exactly. */
  authorization?: string;
  /** The `X-Pmcp-*` identity headers, captured whether or not they were expected (§7: absent by default). */
  pmcpHeaders: Record<string, string>;
  /** The JSON-RPC method of the body, when the body was one — `tools/list`, `tools/call`. */
  rpcMethod?: string;
  pkce?: { presented: string; expected: string; ok: boolean };
};

/**
 * The single function `miniflare.outboundService` points at — the whole harness, from the
 * pool's point of view. Total: every request to UPSTREAM_HOST or AS_HOST is dispatched to
 * the scenario its path names, and everything else answers with a distinctive failure so
 * an unintended outbound dial is loud rather than silent. Never throws for an unknown
 * scenario — an unknown id is a 404 with a body naming it, because a fixture that
 * mistypes a scenario should read that sentence, not a stack.
 */
export async function outboundRouter(request: Request): Promise<Response> {
  // deps: handleUpstream · handleAuthorizationServer · new Response
  throw new Error("unimplemented");
}

/**
 * The resource half: RFC 9728 metadata (unless the paired AS is quirked `no_prm`),
 * `tools/list`, and `tools/call`, each shaped by the scenario's `UpstreamMode`. Records
 * an observation for every request BEFORE branching on mode, so a hung or unreachable
 * request is still visible in `readObservations` — "the hub dialed and got nothing" and
 * "the hub never dialed" are different failures and the audit detail distinguishes them.
 */
async function handleUpstream(request: Request, scenario: UpstreamScenario): Promise<Response> {
  // deps: crypto.randomUUID (per-request ids) · new Response
  throw new Error("unimplemented");
}

/**
 * The adversarial AS half: authorization endpoint, token endpoint, refresh, and metadata,
 * each bent by the scenario's quirks. The PKCE verification is real and unconditional —
 * quirks never disable it, because a fake that can be talked out of checking is a fake
 * that will be talked out of checking by the bug under test.
 */
async function handleAuthorizationServer(
  request: Request,
  scenario: AsScenario,
): Promise<Response> {
  // deps: crypto.subtle.digest("SHA-256") · base64url encode · new Response
  throw new Error("unimplemented");
}

/**
 * The endpoint URL a seeded proxied service should carry so it lands on `scenario`. Built
 * here rather than assembled in fixtures so the URL grammar the router parses has exactly
 * one author.
 */
export function upstreamUrlFor(scenario: UpstreamScenario): string {
  // deps: none
  throw new Error("unimplemented");
}

/** The AS base URL for `scenario` — what the upstream's metadata points discovery at. */
export function asUrlFor(scenario: AsScenario): string {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Read back what a scenario observed, in arrival order — the ordering oracle for
 * "refreshed before forwarding" and the presence oracle for `X-Pmcp-*`. Goes over the
 * wire (a control path on the fake's own origin) precisely because the router does not
 * share memory with the test: a value returned from a fetch is a fact, whereas a value
 * read from a module-level array would be a fact about the wrong process.
 */
export async function readObservations(scenarioId: string): Promise<UpstreamObservation[]> {
  // deps: fetch (control path on UPSTREAM_HOST)
  throw new Error("unimplemented");
}

/**
 * The mapping this harness claims to cover, as a type rather than a comment: every
 * `UpstreamFailureClass` the production vocabulary names, and the mode or quirk that
 * produces it. Exhaustive by construction — adding a class to upstream.ts without a way
 * to provoke it stops compiling here, which is the whole reason this lives in the type
 * system instead of a README.
 */
export type FailureClassSource = Record<
  UpstreamFailureClass,
  { via: "mode"; mode: UpstreamMode["kind"] } | { via: "quirk"; quirk: AsQuirk }
>;
