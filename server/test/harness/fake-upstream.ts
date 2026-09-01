// fake-upstream.ts — the far side of every proxied app: an in-test MCP upstream and,
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
// itself, and the two modes that tell it are NOT symmetric — `hang` is a promise that
// never settles, but `unreachable` cannot be a throw:
//
//   AN outboundService FUNCTION CANNOT MAKE A FETCH REJECT. Everything it does resolves.
//   Probed, six shapes, 2026-08-25: throwing inside it resolves 500 with the message in the
//   body; a port of 0, 1 or 25 routes to it normally; an unroutable host and an empty host
//   reach it as ordinary requests (the router's own 502); only an UNSUPPORTED SCHEME is
//   refused by workerd BEFORE outbound routing, rejecting with `TypeError: Fetch API cannot
//   load: …`. So `unreachable` is expressed in the URL (`upstreamUrlFor`) rather than in the
//   handler: the scenario's endpoint carries a scheme the runtime will not dial, which is
//   the one shape that exercises the hub's transport-failure catch for real.
//
// The consequence a fixture must know: an `unreachable` scenario is NEVER OBSERVED — the
// request does not exist, so its observation log stays empty and a dial count for it is
// read hub-side. Do not "simplify" this back to a throw; the throw is the shape that
// produces `upstream_status` instead, silently turning the transport row into a status row.
//
// PROJECT: `worker` — parallel, per-file storage isolation, no sockets. Wired in as
// `miniflare.outboundService` (strategy §2: `fetchMock` is gone and a plain function is
// the supported replacement), which forces the design decision below.
//
// THE ISOLATION CONSTRAINT, stated plainly because it shaped the whole API: an
// `outboundService` function is configured ONCE for the pool, outside any test's scope,
// and does not share memory with the test that provoked the request. So this harness
// carries NO per-test registration step and NO shared mutable state. A scenario is named
// in the URL the seeded app points at (`upstreamUrlFor`), and everything a test wants
// to know afterwards is read back over the wire (`readObservations`) rather than out of a
// variable. That is not a workaround; it is what makes two files running in parallel
// against the same router impossible to confuse.
//
// STATE OF THIS FILE (2026-08-25, D5): COMPLETE for the connect flow — the resource half,
// the observation log, RFC 9728 / RFC 8414 discovery on both hosts, and the adversarial
// authorization server (authorize, token, refresh, DCR) with its real S256 check.
//
// deps: crypto.subtle (real SHA-256 for S256) · fetch Request/Response · gateway.Tool/Prompt/Resource/ResourceTemplate (shape only) · upstream.UpstreamFailureClass (vocabulary only) — no hub module at runtime, no MCP SDK

import type { Prompt, Resource, ResourceTemplate, Tool } from "../../src/gateway";
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
 * - `ok` — serve `tools` and answer calls; the allow-twin every failure row needs. A
 *   scenario's `error` field rides this mode: a well-formed JSON-RPC error is a RESPONSE,
 *   not a way of failing, which is exactly the boundary the `bad_body` rows are drawn
 *   against.
 * - `status` — answer non-2xx → `upstream_status` (the audit detail records the number).
 * - `bad_body` — answer 200 with something that is not a JSON-RPC message → `bad_body`.
 * - `unreachable` — the fetch is refused before any response → `unreachable`. Carried in
 *   the scenario's URL SCHEME rather than answered by the router (see the file header):
 *   nothing an outboundService function does can make a fetch reject, so this mode's
 *   endpoint is one workerd will not dial. Its observation log therefore stays empty.
 * - `hang` — never settle; the hub's own deadline ends it → `timeout`. Which deadline
 *   bites depends on the caller: limits.AGGREGATED_LIST_DEADLINE_MS in a fan-out,
 *   limits.CALL_TIMEOUT_MS on a scoped call — two knobs, and this mode is how they are
 *   told apart.
 * - `redirect` — answer 3xx to another origin: the code contract from strategy §10
 *   (`redirect: "manual"` on upstream dials) means the bearer must not walk off with it,
 *   and this is the only way to observe that in-process.
 * - `sink` — not an MCP upstream at all: a POST endpoint that swallows whatever arrives
 *   and answers `status`, counting the arrival in the observation log. The Web Push
 *   endpoints the approval rows need are its one customer today. It is a MODE rather
 *   than a fallback inside `ok` because this union is the complete inventory of what an
 *   upstream can do here, and a fixture that gets push-service behavior by accident —
 *   because its body happened not to parse — is a fake that can be talked out of
 *   answering, which this file's header forbids.
 */
export type UpstreamMode =
  | { kind: "ok" }
  | {
      kind: "status";
      status: number;
      body?: string;
      /** The exact `WWW-Authenticate` value to challenge with — §7's log-hygiene rule is
       *  about THIS header above all others (a 401's challenge names the authorization
       *  server and can carry token material), so the sentinel law needs to plant one. */
      wwwAuthenticate?: string;
    }
  | { kind: "bad_body"; body: string }
  | { kind: "unreachable" }
  | { kind: "hang" }
  | { kind: "redirect"; location: string }
  | { kind: "sink"; status: number };

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
  /** §20.2 — served from `prompts/list`. */
  prompts?: Prompt[];
  /** §20.2 — answered to `prompts/get`; the family's analogue of `result`. */
  promptResult?: unknown;
  /** §20.2 — served from `resources/list`. */
  resources?: Resource[];
  /** §20.2 — served from `resources/templates/list`. */
  resourceTemplates?: ResourceTemplate[];
  /** §20.2 — answered to `resources/read`. */
  readResult?: unknown;
  /** §20.2 — answered to `completion/complete`. */
  completionResult?: unknown;
  /**
   * Answered to `tools/call` INSTEAD of `result` — a well-formed JSON-RPC `error` object.
   * A separate field rather than a mode because it is not a failure of this upstream at
   * all: §7 scopes "relayed verbatim" to a well-formed RESPONSE, errors included, so this
   * is the boundary the four `bad_body` modes are drawn against.
   */
  error?: unknown;
  /** Reject with 401 unless this exact `Authorization` value arrives — the header-mode credential pin. */
  requireBearer?: string;
  /** Delay before answering, in ms — for deadline rows that must be slow without being infinite. */
  delayMs?: number;
  /**
   * The authorization server this resource is protected by. Travels IN the scenario — and
   * therefore in the URL — because the router shares no memory with the test: RFC 9728
   * discovery on this resource has to answer with a concrete AS, and this is the only
   * channel that can carry which one. Absent means an unprotected resource that serves no
   * protected-resource metadata at all.
   */
  as?: AsScenario;
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
 *   that stores the bundle non-atomically loses the agent on the second refresh.
 * - `refresh_fails` — reject every refresh with OAuth's own `invalid_grant`: the ONLY
 *   producer of `needs_reconnect`, and the row where `-32000` must arrive with no dial
 *   attempted.
 * - `refresh_unreachable` — the twin of `refresh_fails`, and the difference that must not be
 *   lost: the token endpoint does not REFUSE the grant, it fails to answer (a 503, the shape
 *   a ten-second AS outage takes). Both cost the call, and only the first may cost the owner
 *   a Reconnect — a hub that reads every non-token answer as "this credential is dead" bricks
 *   a live app on a blip, and no persona but this one can tell the two apart.
 * - `advertise_iss` — advertise RFC 9207 and return `iss`, so the hub's `iss` check has
 *   something to check; its twin `wrong_iss` returns a different issuer and must be
 *   rejected with nothing stored.
 * - `wrong_iss` — see above; the refusal twin of `advertise_iss`.
 * - `omit_iss` — advertise RFC 9207 and then send NO `iss` at all. The third member of
 *   the `iss` family and the cheapest attack of the three: an attacker's AS does not have
 *   to forge an issuer, it simply does not echo the parameter, and the natural spelling of
 *   the check (`iss && iss !== recorded`) waves that through. Named separately from
 *   `advertise_iss` because "advertises and omits" is a different SERVER, not a different
 *   response to the same one.
 * - `stale_first_token` — hand back an access token that has already expired
 *   (`expires_in: 0`) for the authorization-code grant, and a normally-lived one on every
 *   refresh. This is how a "stale bundle" exists at all without a test sleeping: the
 *   token is dead the moment it is stored, so the very next call must refresh BEFORE it
 *   forwards. Asymmetric on purpose — a refresh that returned another dead token could
 *   not tell "refreshed once and re-sealed" from "refreshes on every call".
 */
export type AsQuirk =
  | "no_prm"
  | "reject_cimd"
  | "no_expires_in"
  | "rotate_refresh"
  | "refresh_fails"
  | "refresh_unreachable"
  | "advertise_iss"
  | "wrong_iss"
  | "omit_iss"
  | "stale_first_token";

/** One authorization-server persona, addressed by URL exactly like an upstream scenario. */
export type AsScenario = {
  id: string;
  quirks?: AsQuirk[];
};

/**
 * The access token this persona mints at generation `n` — connect issues generation 1 and
 * every refresh advances it by one. Exported because that is what makes the runner's
 * "THE OAUTH BEARER RIDES" law expressible: an oauth fixture sets `requireBearer` to the
 * token the flow is supposed to have reached by the time the dial happens, so a hub that
 * opens the envelope, refreshes, and then dials anonymously — or with the pre-refresh
 * token — is answered 401 instead of quietly passing.
 */
export function fakeAccessToken(asScenarioId: string, generation = 1): string {
  // deps: none
  return `FAKE0000-access-${asScenarioId}-${generation}`;
}

/** The refresh token beside it. The generation is IN the token, which is what lets the
 *  token endpoint stay stateless about everything except the rotation quirk. */
export function fakeRefreshToken(asScenarioId: string, generation = 1): string {
  // deps: none
  return `FAKE0000-refresh-${asScenarioId}-${generation}`;
}

/**
 * What the fake saw, read back over the wire. This is the harness's answer to "prove the
 * refresh happened BEFORE the forward" (§16) without shared memory: an ordered list of
 * what arrived, in arrival order, per scenario id.
 *
 * `pkce` records the verifier check as the AS actually performed it — `presented` is what
 * the hub sent (the verifier itself), `expected` is the challenge this AS bound at
 * `/authorize`, and `ok` is the real S256 comparison of the two. A test asserts on `ok`,
 * never recomputing the hash itself; recomputing it in the test would just be a second
 * implementation of the thing under test.
 *
 * WHICH LEG an arrival is — a token exchange, an authorize, a registration, a well-known
 * document, an MCP dial — is told by `path` and by nothing else. That is the whole rule, and
 * it is stated here so no fixture has to invent a second one: the router shares no memory
 * with the test, so a body it did not keep cannot answer the question, and a duplicate field
 * carrying the same fact is a field that can disagree with the path.
 */
export type UpstreamObservation = {
  seq: number;
  method: string;
  /** The leg, as above: `/token`, `/authorize`, `/register`, `/.well-known/…`, or the
   *  scenario's own `/mcp` endpoint. */
  path: string;
  /** Present iff an `Authorization` header arrived; the VALUE, so header-mode credentials are pinned exactly. */
  authorization?: string;
  /**
   * Present iff a `Cookie` header arrived — which it never may. §7's "the hub's own
   * upstream request never copies consumer headers" is a claim about ABSENCE, and absence
   * is only assertable where the header would have landed.
   */
  cookie?: string;
  /** The `X-Pmcp-*` identity headers, captured whether or not they were expected (§7: absent by default). */
  pmcpHeaders: Record<string, string>;
  /** The JSON-RPC method of the body, when the body was one — `tools/list`, `tools/call`. */
  rpcMethod?: string;
  /**
   * The forwarded request's `_meta`, when the body carried one. §7 has the hub mirror the
   * consumer's declared `io.modelcontextprotocol/clientCapabilities` onto what the upstream
   * sees, and `{}` for a consumer that declared none — a claim about a value that reaches
   * nobody else, so the upstream is the only place it can be read.
   */
  meta?: Record<string, unknown>;
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
  const url = new URL(request.url);
  if (url.hostname === UPSTREAM_HOST) {
    // The control path: read back what a scenario observed. Over the wire on purpose —
    // the router does not share memory with the test that provoked the request.
    if (url.pathname.startsWith(`${OBSERVATION_PATH}/`)) {
      return json(observations.get(url.pathname.slice(OBSERVATION_PATH.length + 1)) ?? []);
    }
    if (url.pathname.startsWith(`${OVERRIDE_PATH}/`)) {
      return registerOverrideRequest(url, request);
    }
    const decoded = decodeSegment<UpstreamScenario>(url, SCENARIO_PATH);
    if (decoded === null) return unknownScenario(url);
    // §20.2's per-family payloads can be large enough to blow a real request line if they
    // rode the URL like the rest of a scenario (HTTP 431) — registerOverride's one
    // customer. Absent for every scenario that never registered one, so nothing about the
    // pre-§20 URL-encoding path changes for a fixture that does not need this.
    const scenario = { ...decoded, ...overrides.get(decoded.id) };
    // The two discovery documents a PROTECTED RESOURCE serves, ahead of the MCP endpoint
    // because they are not MCP: RFC 9728's protected-resource metadata, and — for the
    // `no_prm` persona, whose whole point is that the first document is missing — the RFC
    // 8414 document the hub falls back to asking the resource's own URL for.
    // Observed like any other arrival: a discovery request IS something the resource
    // server saw, and "the hub tried RFC 9728 before falling back" is only readable off
    // this log. Discovery happens while a fixture is being SEEDED, so the per-row dial
    // budgets — which are deltas taken around the row's own request — are unaffected.
    if (url.pathname.startsWith(PRM_WELL_KNOWN)) {
      observe(scenario.id, request, undefined);
      return protectedResourceMetadata(scenario);
    }
    if (url.pathname.startsWith(AS_WELL_KNOWN)) {
      observe(scenario.id, request, undefined);
      return scenario.as === undefined
        ? new Response("no authorization server", { status: 404 })
        : json(asMetadata(scenario.as));
    }
    if (url.pathname.includes(WELL_KNOWN_ROOT)) return wrongWellKnownForm(url);
    return handleUpstream(request, scenario);
  }
  if (url.hostname === AS_HOST) {
    const scenario = decodeSegment<AsScenario>(url, AS_PATH);
    if (scenario === null) return unknownScenario(url);
    if (url.pathname.includes(WELL_KNOWN_ROOT) && !url.pathname.startsWith(AS_WELL_KNOWN)) {
      return wrongWellKnownForm(url);
    }
    return handleAuthorizationServer(request, scenario);
  }
  // Loud, not silent: a dial to anywhere else is the code under test escaping.
  return new Response(`fake-upstream: unrouted outbound request to ${url.host}${url.pathname}`, {
    status: 502,
  });
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
  const body = (await request.text().catch(() => "")) || "";
  const message = parseJson(body) as
    | { method?: unknown; id?: unknown; params?: { _meta?: unknown } }
    | null;
  const meta = message?.params?._meta;
  observe(
    scenario.id,
    request,
    typeof message?.method === "string" ? message.method : undefined,
    undefined,
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined,
  );

  const mode = scenario.mode;
  // The licensed lie, before anything else can answer: a promise that never settles is the
  // only way to unplug a cable inside workerd.
  if (mode.kind === "hang") return new Promise<Response>(() => {});
  // Arriving here at all means the URL grammar changed: an `unreachable` scenario's
  // endpoint carries a scheme workerd refuses, so this router never sees one. Said loudly,
  // because the failure it guards is silent — a thrown handler resolves 500, which the hub
  // correctly classes `upstream_status`, quietly turning the transport row into a status row.
  if (mode.kind === "unreachable") {
    return new Response(
      `fake-upstream: "${scenario.id}" is mode "unreachable" and must never be dialed — ` +
        `upstreamUrlFor gives it an unroutable scheme (see this file's header)`,
      { status: 500 },
    );
  }
  if (scenario.delayMs !== undefined) await new Promise((r) => setTimeout(r, scenario.delayMs));

  if (mode.kind === "status") {
    return new Response(mode.body ?? "upstream said no", {
      status: mode.status,
      ...(mode.wwwAuthenticate === undefined
        ? {}
        : { headers: { "WWW-Authenticate": mode.wwwAuthenticate } }),
    });
  }
  if (mode.kind === "bad_body") return new Response(mode.body, { status: 200 });
  if (mode.kind === "redirect") {
    return new Response(null, { status: 302, headers: { Location: mode.location } });
  }
  // A sink reads nothing and answers its status — the arrival is already logged above,
  // which is the whole point of the mode.
  if (mode.kind === "sink") return new Response(null, { status: mode.status });
  if (scenario.requireBearer !== undefined && request.headers.get("Authorization") !== scenario.requireBearer) {
    return new Response("unauthorized", { status: 401 });
  }
  // An `ok` upstream serves MCP and nothing else: a body it cannot read as a JSON-RPC
  // message is a bug in the code under test, and it fails loudly here rather than being
  // quietly answered as something that never sent one.
  if (typeof message?.method !== "string") {
    return new Response(
      `fake-upstream: "${scenario.id}" is an MCP upstream and this body is not a JSON-RPC ` +
        `message — a plain POST endpoint is mode "sink"`,
      { status: 400 },
    );
  }

  const id = (message.id ?? null) as string | number | null;
  if (message.method === "tools/list") {
    return json({ jsonrpc: "2.0", id, result: { tools: scenario.tools ?? [], resultType: "complete" } });
  }
  // §20.2's three listing methods — each answers ITS OWN key, never `tools`', so a fixture
  // that only ever set `tools` cannot accidentally satisfy a prompts/resources assertion.
  if (message.method === "prompts/list") {
    return json({ jsonrpc: "2.0", id, result: { prompts: scenario.prompts ?? [], resultType: "complete" } });
  }
  if (message.method === "resources/list") {
    return json({ jsonrpc: "2.0", id, result: { resources: scenario.resources ?? [], resultType: "complete" } });
  }
  if (message.method === "resources/templates/list") {
    return json({
      jsonrpc: "2.0",
      id,
      result: { resourceTemplates: scenario.resourceTemplates ?? [], resultType: "complete" },
    });
  }
  // §20.2's two reads and its one relay method — each answers its OWN result field, same
  // `error`-first rule as `tools/call` below (a well-formed JSON-RPC error is a RESPONSE,
  // not a failure of this upstream, §7).
  if (message.method === "prompts/get") {
    if (scenario.error !== undefined) return json({ jsonrpc: "2.0", id, error: scenario.error });
    return json({ jsonrpc: "2.0", id, result: scenario.promptResult ?? { messages: [] } });
  }
  if (message.method === "resources/read") {
    if (scenario.error !== undefined) return json({ jsonrpc: "2.0", id, error: scenario.error });
    return json({ jsonrpc: "2.0", id, result: scenario.readResult ?? { contents: [] } });
  }
  if (message.method === "completion/complete") {
    if (scenario.error !== undefined) return json({ jsonrpc: "2.0", id, error: scenario.error });
    return json({
      jsonrpc: "2.0",
      id,
      result: scenario.completionResult ?? { completion: { values: [] } },
    });
  }
  // A well-formed JSON-RPC error is a RESPONSE, not a failure of this upstream — §7 has
  // the hub relay it verbatim, which is the boundary the bad_body modes are drawn against.
  if (scenario.error !== undefined) return json({ jsonrpc: "2.0", id, error: scenario.error });
  return json({
    jsonrpc: "2.0",
    id,
    result: scenario.result ?? { resultType: "complete", content: [{ type: "text", text: "ok" }] },
  });
}

/**
 * RFC 9728 protected-resource metadata for one resource — or a 404 when its AS is quirked
 * `no_prm`, which is the whole of that persona: the document simply is not there, and the
 * hub's discovery must reach the authorization server anyway (it falls back to asking the
 * resource's own URL for RFC 8414 metadata, which the router serves above).
 */
function protectedResourceMetadata(scenario: UpstreamScenario): Response {
  if (scenario.as === undefined || scenario.as.quirks?.includes("no_prm")) {
    return new Response("no protected-resource metadata", { status: 404 });
  }
  return json({
    resource: upstreamUrlFor(scenario),
    authorization_servers: [asUrlFor(scenario.as)],
  });
}

/**
 * RFC 8414 authorization-server metadata, bent by the persona's quirks. Two fields decide
 * two whole branches of the hub: `client_id_metadata_document_supported` decides CIMD vs.
 * DCR, and `authorization_response_iss_parameter_supported` is what makes §7's `iss` check
 * BIND at all — a persona that does not advertise it is the conditional's other side.
 */
function asMetadata(scenario: AsScenario): Record<string, unknown> {
  const base = asUrlFor(scenario);
  const quirks = scenario.quirks ?? [];
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    code_challenge_methods_supported: ["S256"],
    // `reject_cimd` refuses the hub's URL client identity by simply not offering it, which
    // is how a real AS says no: the hub reads the absence and registers dynamically.
    ...(quirks.includes("reject_cimd") ? {} : { client_id_metadata_document_supported: true }),
    ...(advertisesIss(quirks) ? { authorization_response_iss_parameter_supported: true } : {}),
  };
}

/** RFC 9207 is advertised by every persona that has an `iss` story to tell — including
 *  the two that fail the check, since a check that does not bind cannot be failed. */
function advertisesIss(quirks: readonly AsQuirk[]): boolean {
  return (
    quirks.includes("advertise_iss") || quirks.includes("wrong_iss") || quirks.includes("omit_iss")
  );
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
  const url = new URL(request.url);
  const quirks = scenario.quirks ?? [];
  // Metadata is the one GET that is not part of a flow, so it is answered before the
  // arrival is even interesting — but it is still observed, because "how many times did
  // the hub dial the AS" is a budget the failure table states per row.
  if (url.pathname.startsWith(AS_WELL_KNOWN)) {
    observe(scenario.id, request, undefined);
    return json(asMetadata(scenario));
  }
  if (url.pathname.endsWith("/authorize")) return authorize(request, scenario, quirks);
  if (url.pathname.endsWith("/register")) {
    observe(scenario.id, request, undefined);
    // DCR, reached only because `reject_cimd` withheld the CIMD affordance. The id is
    // obviously fake and derived from the scenario, so a fixture can assert on it.
    return json({
      client_id: `FAKE0000-dcr-client-${scenario.id}`,
      client_id_issued_at: 0,
      token_endpoint_auth_method: "none",
    });
  }
  if (url.pathname.endsWith("/token")) return token(request, scenario, quirks);
  observe(scenario.id, request, undefined);
  return new Response(`fake-upstream: the AS serves no "${url.pathname}"`, { status: 404 });
}

/**
 * The authorization endpoint, standing in for the owner's browser: it answers the 302 the
 * browser would have followed, straight back to the hub's `redirect_uri`.
 *
 * The PKCE challenge is carried INSIDE the authorization code rather than in a table
 * beside it — the same reason every other piece of scenario state rides a URL: this router
 * is configured once for the pool and shares no memory with the test. A code is therefore
 * self-describing, and the token endpoint's S256 check below is real crypto against a
 * value it did not have to remember.
 */
async function authorize(
  request: Request,
  scenario: AsScenario,
  quirks: readonly AsQuirk[],
): Promise<Response> {
  observe(scenario.id, request, undefined);
  const params = new URL(request.url).searchParams;
  const redirectUri = params.get("redirect_uri");
  if (redirectUri === null) {
    return new Response("fake-upstream: /authorize without a redirect_uri", { status: 400 });
  }
  const target = new URL(redirectUri);
  target.searchParams.set("code", encodeSegment({ id: params.get("code_challenge") ?? "" }));
  const state = params.get("state");
  if (state !== null) target.searchParams.set("state", state);
  // RFC 9207. `omit_iss` is the persona that advertises support and then sends nothing —
  // the cheap attack, and the one a `iss && iss !== recorded` check waves through.
  if (advertisesIss(quirks) && !quirks.includes("omit_iss")) {
    target.searchParams.set(
      "iss",
      quirks.includes("wrong_iss") ? `https://${AS_HOST}${AS_PATH}/FAKE0000-other-issuer` : asUrlFor(scenario),
    );
  }
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

/**
 * The token endpoint: both grants, the REAL S256 verification, and the three quirks that
 * bend what a token response says. Nothing here is stateful except the one thing that has
 * to be — `rotate_refresh`'s record of which refresh tokens have already been spent.
 */
async function token(
  request: Request,
  scenario: AsScenario,
  quirks: readonly AsQuirk[],
): Promise<Response> {
  const form = new URLSearchParams(await request.text().catch(() => ""));
  const grant = form.get("grant_type");

  if (grant === "refresh_token") {
    observe(scenario.id, request, undefined);
    const presented = form.get("refresh_token") ?? "";
    // The ONLY producer of needs_reconnect (this type's own note): the hub must flip the
    // app and never reach the resource.
    if (quirks.includes("refresh_fails")) return tokenError();
    // The twin: no refusal, no answer. A 503 carries no OAuth `error`, so a hub reading the
    // difference leaves the credential alone and only loses the call.
    if (quirks.includes("refresh_unreachable")) {
      return new Response("the authorization server is having a moment", { status: 503 });
    }
    if (quirks.includes("rotate_refresh")) {
      // Single-use, and the whole reason the two-call row is load-bearing: a hub that
      // refreshed in memory without re-sealing spends this token twice and loses the
      // agent on the second call.
      const spent = `${scenario.id}:${presented}`;
      if (spentRefreshTokens.has(spent)) return tokenError();
      spentRefreshTokens.add(spent);
    }
    const generation = refreshGeneration(presented) + 1;
    return json({
      access_token: fakeAccessToken(scenario.id, generation),
      refresh_token: quirks.includes("rotate_refresh") ? fakeRefreshToken(scenario.id, generation) : presented,
      token_type: "Bearer",
      // A refreshed token is normally-lived even under `stale_first_token`: that quirk is
      // about the FIRST token, and a refresh that also returned a dead one could not tell
      // "refreshed once and re-sealed" from "refreshes on every call".
      ...(quirks.includes("no_expires_in") ? {} : { expires_in: TOKEN_LIFETIME_SECONDS }),
    });
  }

  // The authorization-code grant, and the real crypto: S256 = base64url(SHA-256(verifier)),
  // recomputed here and compared with the challenge the code carries. A hub that forwards
  // the wrong verifier, or none, fails here for the same reason it would fail at Linear.
  const carried = decodeCode(form.get("code"));
  const presented = await s256(form.get("code_verifier") ?? "");
  const ok = carried !== null && presented === carried;
  observe(scenario.id, request, undefined, { presented, expected: carried ?? "", ok });
  if (!ok) return tokenError();
  return json({
    access_token: fakeAccessToken(scenario.id),
    refresh_token: fakeRefreshToken(scenario.id),
    token_type: "Bearer",
    // `no_expires_in` omits the field; `stale_first_token` declares a token that is dead on
    // arrival, so the very next call must refresh before it forwards.
    ...(quirks.includes("no_expires_in")
      ? {}
      : { expires_in: quirks.includes("stale_first_token") ? 0 : TOKEN_LIFETIME_SECONDS }),
  });
}

/** The AS's one refusal shape — OAuth's own, and deliberately identical for a bad
 *  verifier, a spent rotated refresh token and a `refresh_fails` persona alike. */
function tokenError(): Response {
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** Which issuance a presented refresh token came from, so the next one can succeed it.
 *  Unreadable tokens count as generation 0, which simply starts the sequence over. */
function refreshGeneration(refreshToken: string): number {
  const generation = Number(refreshToken.split("-").pop());
  return Number.isInteger(generation) && generation > 0 ? generation : 0;
}

/** The challenge an authorization code carries, or null when it carries none. */
function decodeCode(code: string | null): string | null {
  if (code === null) return null;
  const decoded = parseJson(base64UrlDecode(code)) as { id?: unknown } | null;
  return typeof decoded?.id === "string" && decoded.id !== "" ? decoded.id : null;
}

/** S256, as RFC 7636 defines it — real WebCrypto, never a stub (§9). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** How long a normally-lived fixture token lives. Not a limits.ts constant: no § pins what
 *  an UPSTREAM's token lifetime is — it is the AS's business, and this is a fake AS. */
const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Refresh tokens `rotate_refresh` personas have already spent, keyed by scenario id so two
 * files in parallel cannot collide. The one piece of mutable state this harness keeps
 * beyond the observation log, and for the same reason: single-use is a property ACROSS
 * requests, and there is nowhere else in a shared-nothing router to put it.
 */
const spentRefreshTokens = new Set<string>();

/**
 * The endpoint URL a seeded proxied app should carry so it lands on `scenario`. Built
 * here rather than assembled in fixtures so the URL grammar the router parses has exactly
 * one author.
 */
export function upstreamUrlFor(scenario: UpstreamScenario): string {
  // deps: none
  // The whole scenario travels IN the URL: the router shares no memory with the test, so
  // a path segment is the only channel a fixture has (see the header's isolation note).
  //
  // And for one mode the SCHEME is the behavior. `unreachable` has to make the hub's fetch
  // reject, and nothing an outboundService function does can — everything it returns or
  // throws resolves (the header records the six shapes probed). A scheme workerd will not
  // dial is refused before outbound routing, which is the real thing: the hub's own
  // transport-failure catch runs, unmodified and unaware it is in a test.
  const scheme = scenario.mode.kind === "unreachable" ? UNROUTABLE_SCHEME : "https";
  return `${scheme}://${UPSTREAM_HOST}${SCENARIO_PATH}/${encodeSegment(scenario)}/mcp`;
}

/** A scheme the Fetch API refuses outright (`TypeError: Fetch API cannot load: …`). Its
 *  only job is to be un-dialable; nothing here speaks FTP. */
const UNROUTABLE_SCHEME = "ftp";

/** The AS base URL for `scenario` — what the upstream's metadata points discovery at. */
export function asUrlFor(scenario: AsScenario): string {
  // deps: none
  return `https://${AS_HOST}${AS_PATH}/${encodeSegment(scenario)}`;
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
  const response = await fetch(`https://${UPSTREAM_HOST}${OBSERVATION_PATH}/${scenarioId}`);
  return (await response.json()) as UpstreamObservation[];
}

/**
 * Registers scenario fields OUT of the URL, over the wire on this fake's own control path
 * — `readObservations`'s write-side twin, and for the identical reason: the router shares
 * no memory with the test. It exists for exactly the payload the URL-encoding scheme
 * cannot carry — §20.2's per-family answers can be large enough that base64-encoding them
 * INTO a request line trips a real HTTP 431 (a request-line-too-large error every proxy
 * and runtime enforces, workerd's `fetch` included), which is a fact about HTTP the
 * scenario's SIZE decides, not about anything the code under test does wrong. A caller
 * that expects a large answer keeps its URL-encoded scenario minimal (an id and a mode
 * suffice to route) and registers the bulky fields here before its first request; a
 * scenario that never calls this reads exactly as it always has, fields riding the URL.
 * Merged OVER the URL-encoded scenario at request time, so a registered field wins.
 */
export async function registerOverride(scenarioId: string, fields: Partial<UpstreamScenario>): Promise<void> {
  // deps: fetch (control path on UPSTREAM_HOST)
  await fetch(`https://${UPSTREAM_HOST}${OVERRIDE_PATH}/${scenarioId}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

/** The override request itself: stores the posted fields, keyed by scenario id, and
 *  answers 204 — nothing about it is observed, since it carries no fact about the code
 *  under test (unlike an MCP dial or a discovery request). */
async function registerOverrideRequest(url: URL, request: Request): Promise<Response> {
  const id = url.pathname.slice(OVERRIDE_PATH.length + 1);
  const body = (await request.text().catch(() => "")) || "{}";
  overrides.set(id, (parseJson(body) as Partial<UpstreamScenario> | null) ?? {});
  return new Response(null, { status: 204 });
}

/** Scenario field overrides registered via `registerOverride`, keyed by scenario id — the
 *  same module-level, per-file-isolated store `observations` already is, for the write side. */
const overrides = new Map<string, Partial<UpstreamScenario>>();

/**
 * The mapping this harness claims to cover, as a type rather than a comment: every
 * `UpstreamFailureClass` the production vocabulary names, and the mode or quirk that
 * produces it. Exhaustive by construction — adding a class to upstream.ts without a way
 * to provoke it stops compiling here, which is the whole reason this lives in the type
 * system instead of a README.
 */
export type FailureClassSource = Record<
  UpstreamFailureClass,
  | { via: "mode"; mode: UpstreamMode["kind"] }
  // The third arm exists because one class is NOT produced by anything the router does:
  // `unreachable` needs the hub's fetch to reject, and an outboundService function has no
  // way to make one (the file header records the probe). It is produced by the scenario's
  // URL instead, so the map says so rather than claiming a mode that never runs.
  | { via: "url"; mode: Extract<UpstreamMode, { kind: "unreachable" }>["kind"] }
  | { via: "quirk"; quirk: AsQuirk }
>;

// ── the URL grammar and the observation log ───────────────────────────────────────────

/** The four path prefixes the router dispatches on. */
const SCENARIO_PATH = "/s";
const AS_PATH = "/as";
const OBSERVATION_PATH = "/_obs";
const OVERRIDE_PATH = "/_override";

/**
 * The two discovery documents, at the EXACT path each RFC puts them: the well-known segment
 * at the root of the host, the resource's (or issuer's) own path after it — so
 * `/.well-known/…/s/<scenario>/mcp` still names the scenario, one segment further along than
 * an ordinary dial does. Matched as a PREFIX, and any other spelling is a 404: the
 * concatenated `${issuer}/.well-known/…` form is what a tenant-scoped authorization server
 * refuses in production, and a fake that answered it would let the hub's URL grammar go
 * untested while every case stayed green (this file's header: a fake that can be talked out
 * of saying no will be, by the bug under test).
 */
const PRM_WELL_KNOWN = "/.well-known/oauth-protected-resource";
const AS_WELL_KNOWN = "/.well-known/oauth-authorization-server";
const WELL_KNOWN_ROOT = "/.well-known/";

/** The refusal a non-RFC discovery URL gets — naming the form that would have worked, because
 *  the failure it guards is a hub that spells a URL only this fake was willing to answer. */
function wrongWellKnownForm(url: URL): Response {
  return new Response(
    `fake-upstream: "${url.pathname}" is not where a well-known document lives — both RFCs ` +
      `put the segment at the ROOT and the resource's own path after it ` +
      `(/.well-known/oauth-authorization-server<path>), and a real server 404s the rest`,
    { status: 404 },
  );
}

/**
 * What every scenario id has observed, in arrival order. Module-level because the router
 * IS a module — this is the store `readObservations` reads over the wire, and the reason
 * that read is a fetch rather than a variable access.
 */
const observations = new Map<string, UpstreamObservation[]>();

/** One arrival, recorded before any mode can decide to answer badly (or not at all). */
function observe(
  scenarioId: string,
  request: Request,
  rpcMethod: string | undefined,
  pkce?: UpstreamObservation["pkce"],
  meta?: Record<string, unknown>,
): void {
  const log = observations.get(scenarioId) ?? [];
  const pmcpHeaders: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-pmcp-")) pmcpHeaders[name.toLowerCase()] = value;
  });
  const authorization = request.headers.get("Authorization");
  const cookie = request.headers.get("Cookie");
  log.push({
    seq: log.length,
    method: request.method,
    path: new URL(request.url).pathname,
    ...(authorization === null ? {} : { authorization }),
    ...(cookie === null ? {} : { cookie }),
    pmcpHeaders,
    ...(rpcMethod === undefined ? {} : { rpcMethod }),
    ...(pkce === undefined ? {} : { pkce }),
    ...(meta === undefined ? {} : { meta }),
  });
  observations.set(scenarioId, log);
}

/**
 * The scenario carried by the segment after `prefix`, or null when it is not one. Located
 * ANYWHERE in the path, not just at its head: a well-known discovery URL carries the
 * resource's own path after the well-known segment, so `/s/<scenario>` and
 * `/.well-known/…/s/<scenario>` have to decode to the same fixture.
 */
function decodeSegment<T extends { id: string }>(url: URL, prefix: string): T | null {
  const at = url.pathname.indexOf(`${prefix}/`);
  if (at < 0) return null;
  const segment = url.pathname.slice(at + prefix.length + 1).split("/")[0];
  const decoded = parseJson(base64UrlDecode(segment)) as T | null;
  return decoded !== null && typeof decoded.id === "string" ? decoded : null;
}

function encodeSegment(scenario: unknown): string {
  return btoa(JSON.stringify(scenario)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(segment: string): string {
  try {
    return atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A fixture that mistypes a scenario should read this sentence, not a stack. */
function unknownScenario(url: URL): Response {
  return new Response(`fake-upstream: no scenario encoded in "${url.pathname}"`, { status: 404 });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

