// upstream.ts — the proxied-service backend and the sole custodian of upstream credentials.
//
// OWNS the whole "hub as MCP client" side of proxied services: per-request dialing of the
// upstream endpoint (a fresh @modelcontextprotocol/client `Client` over Streamable HTTP
// each time — never pooled, and proxied catalogs are never cached, a v1 pin); every
// upstream credential — `service.upstream_auth_json` is always an AES-GCM envelope under
// the single UPSTREAM_CREDS_KEY wrangler secret, led by a one-byte version header so the
// key can rotate without a migration; the headers-vs-oauth exclusivity rule (each auth
// mode has exactly one credential path; a mode flip wipes stored credentials); the entire
// interactive connect flow — RFC 9728 protected-resource discovery, CIMD client identity
// with DCR fallback, PKCE, single-use session-bound state rows in D1
// `upstream_oauth_state` (10-minute TTL, consumed by compare-and-set delete) as the CSRF
// and mix-up defense, RFC 9207 `iss` verification; lazy proactive token refresh at call
// time and the needs_reconnect flip; and X-Pmcp-* identity-header emission, gated on
// `forward_identity` (default off — consumer headers are never copied upstream).
//
// HIDES the envelope format and key handling, where needs_reconnect is recorded, the
// OAuth client identity the hub presents upstream, and the exception-aggregation rule:
// every upstream failure class (non-2xx, non-JSON-RPC body, TLS/transport error, timeout,
// needs_reconnect) collapses into one -32000 whose real class survives only in the audit
// row's detail — upstream status lines, headers (WWW-Authenticate included), and bodies
// are never echoed to a consumer. Registry owns the `service` rows' lifecycle; this
// module alone reads and interprets their proxy-auth columns (upstream_url,
// upstream_auth_mode, forward_identity, upstream_auth_json).

import { env } from "cloudflare:workers";
import { record } from "./audit";
// The refusal vocabulary comes from the leaf that owns it, NOT from the consumer pipeline:
// `class UpstreamError extends HubError` is evaluated at module init, and an edge back
// into gateway would put HubError in its temporal dead zone on the first import.
import { HubError, unavailable } from "./errors";
import type { BackendCtx, JsonRpcRequest, JsonRpcResponse, ServiceBackend, Tool } from "./gateway";
import { requireOwnerSession } from "./identity";
import { formatPrincipal } from "./principal";
import type { Service } from "./registry";
import { CALL_TIMEOUT_MS, OAUTH_STATE_TTL_MS } from "./limits";

/**
 * Upstream credential state of a proxied service, as shown by `service_list` /
 * `service_get` and the `/services` page. Total over both auth modes:
 * `not_connected` — no credential envelope is stored (fresh service, after
 * `disconnect`, or after an auth-mode flip); `connected` — a bundle is stored and the
 * last refresh (oauth) succeeded; `needs_reconnect` — oauth mode only: a token refresh
 * failed, every call fails -32000 until the owner runs Connect again. Headers-mode
 * services report `connected` iff headers are stored and can never be `needs_reconnect`.
 */
export type UpstreamConnectionStatus = "not_connected" | "connected" | "needs_reconnect";

/**
 * The initiating browser session for a connect flow — the stable identifier of the
 * owner's cookie session, as resolved by identity. `beginConnect` binds the state row to
 * it, and only a callback arriving on the very same session can consume that row; a
 * bearer-sourced (CLI) session never qualifies. Opaque here: this module compares ids,
 * never inspects them.
 */
export type ConnectSession = { readonly id: string };

/**
 * The real reason an upstream interaction failed — audit vocabulary, never consumer
 * vocabulary. `upstream_status`: the upstream answered non-2xx (status in
 * `UpstreamError.upstreamStatus`); `bad_body`: 2xx but not a JSON-RPC message;
 * `unreachable`: DNS/TLS/transport failure before any response; `timeout`: the fetch hit
 * its deadline (§15's 30 s budget); `needs_reconnect`: the stored oauth bundle is dead —
 * no dial was attempted.
 */
export type UpstreamFailureClass =
  | "upstream_status"
  | "bad_body"
  | "unreachable"
  | "timeout"
  | "needs_reconnect";

/**
 * The one shape any upstream failure leaves this module in. `code` is always -32000 and
 * `message` the generic "service unavailable"; `data` is never set, so nothing
 * upstream-derived can reach a consumer through the gateway's JSON-RPC mapping.
 * `failureClass` (plus `upstreamStatus` for non-2xx answers) exists solely for the
 * gateway to copy into the tools/call audit row's `detail` — it is never serialized into
 * the error response. Thrown by `listTools` and `call`; the aggregated tools/list treats
 * it as "this slug contributes zero tools", the scoped endpoint surfaces it.
 */
export class UpstreamError extends HubError {
  declare readonly failureClass: UpstreamFailureClass;
  declare readonly upstreamStatus?: number;
}

/**
 * The proxied `ServiceBackend` — the pipeline's dispatch target for `kind: "proxy"`.
 * Stateless per request: no connection, no catalog cache; every method loads the
 * service's stored credentials and dials the upstream fresh.
 */
export const upstreamBackend: ServiceBackend = {
  /**
   * Lists the upstream's tools live — every list is a fresh upstream round-trip with the
   * stored credentials (refreshed first when stale). Returns the raw upstream catalog;
   * role filtering and slug prefixing are the gateway's. Any failure, needs_reconnect
   * included, throws `UpstreamError` — the caller decides whether that means "omit this
   * slug" (aggregated) or "-32000" (scoped).
   */
  async listTools(service, ctx) {
    // deps: D1 `service` · crypto.subtle (AES-GCM envelope) · @modelcontextprotocol/client Client (Streamable HTTP) · audit.record (refresh failure)
    const relayed = await dial(service, {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list",
      params: {},
    });
    const tools = (relayed.result as { tools?: unknown } | undefined)?.tools;
    return Array.isArray(tools) ? (tools as Tool[]) : [];
  },

  /**
   * Forwards one tools/call to the upstream endpoint and relays a well-formed JSON-RPC
   * response verbatim — results, errors, and MRTR `input_required` legs alike. A stale
   * oauth access token is refreshed before dialing; a failed refresh flips the service to
   * needs_reconnect, writes `upstream.oauth_refresh_failed`, and throws. Emits
   * `X-Pmcp-Principal` / `X-Pmcp-Roles` (from ctx) only when the service opted into
   * `forward_identity`; mirrors the consumer's declared clientCapabilities onto the
   * per-request client. Aborted at the 30 s budget. Anything short of a well-formed
   * JSON-RPC response throws `UpstreamError`.
   */
  async call(service, msg, ctx) {
    // deps: D1 `service` · crypto.subtle (AES-GCM envelope) · @modelcontextprotocol/client Client (Streamable HTTP) · audit.record (refresh failure)
    return dial(service, msg, ctx);
  },

  /**
   * Always resolves to `{ args: [], results: [] }`: proxied schemas are never cached
   * in v1 (spec pin), so there is no `writeOnly` map to derive in either direction —
   * config-declared `redact` / `redact_results` paths are the only proxied redaction
   * source, unioned in by the gateway (which is also why proxied `log_bodies`
   * defaults OFF, §15). Never returns null: without a
   * catalog no tool is "unknown", so no proxied call is refused on that ground.
   */
  async sensitivePaths(service, tool) {
    // deps: none
    return { args: [], results: [] };
  },
};

/**
 * One JSON-RPC round trip to the service's upstream endpoint, with every failure class
 * collapsed into the one -32000 the consumer ever sees. `identity` present ⇔ this is a
 * forwarded `tools/call`: the `X-Pmcp-*` headers ride only then, and only when the
 * service opted into `forward_identity` (§7 — default off, and consumer headers are
 * never copied upstream).
 *
 * ponytail: still a hand-written POST rather than the SDK `Client` §7 pins
 * (`@modelcontextprotocol/client` is not a dependency yet); the consumer's declared
 * capabilities ride the forwarded `_meta` the gateway already built, which is the same
 * information the per-request `Client` configuration would have carried. Swapping the SDK
 * in is an edit to this function alone.
 */
async function dial(
  service: Service,
  msg: JsonRpcRequest,
  identity?: BackendCtx,
): Promise<JsonRpcResponse> {
  const row = await proxyRowOf(service.id);
  if (!row?.upstream_url) throw failure("unreachable");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    // Resolved BEFORE the request is built, so a dead bundle costs zero round trips and a
    // stale one is refreshed before the forward rather than instead of it (§7).
    ...(await credentialHeaders(service, row)),
  };
  if (identity !== undefined && row.forward_identity !== 0) {
    headers["X-Pmcp-Principal"] = formatPrincipal(identity.principal);
    headers["X-Pmcp-Roles"] = identity.roles.join(",");
  }

  let response: Response;
  try {
    response = await fetch(row.upstream_url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      // Strategy §10: a redirect is answered, never followed — the credential must not
      // walk off to another origin.
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw failure((err as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "unreachable");
  }
  // The status line, the headers (WWW-Authenticate included) and the body are never
  // echoed to a consumer; the class survives only for the audit row's detail (§7).
  if (!response.ok) throw failure("upstream_status", response.status);
  const body = (await response.json().catch(() => null)) as JsonRpcResponse | null;
  if (typeof body !== "object" || body === null || body.jsonrpc !== "2.0") throw failure("bad_body");
  return body;
}

/** The one shape every upstream failure leaves this module in — see UpstreamError. */
function failure(failureClass: UpstreamFailureClass, upstreamStatus?: number): UpstreamError {
  // `declare readonly` fields carry no constructor, so the class is stamped after
  // construction — the assignment site is here and nowhere else.
  return Object.assign(new UpstreamError(-32000, "service unavailable"), {
    failureClass,
    upstreamStatus,
  });
}

/** The four proxy-auth columns this module alone reads — the whole of what a dial needs. */
type ProxyRow = {
  upstream_url: string | null;
  forward_identity: number;
  upstream_auth_mode: "headers" | "oauth" | null;
  upstream_auth_json: string | null;
};

/**
 * The ONE read of a service's proxy-auth columns — exactly the set ProxyRow names, so the
 * type and the statement cannot describe different rows and a column added there is one
 * edit here. Null for a service id that is gone; a TUNNELED service answers a row of nulls,
 * which every caller reads as "no upstream" through the field it already checks.
 */
async function proxyRowOf(serviceId: string): Promise<ProxyRow | null> {
  // deps: D1 `service`
  return (env.DB as D1Like)
    .prepare(
      `SELECT upstream_url, forward_identity, upstream_auth_mode, upstream_auth_json
         FROM service WHERE id = ?`,
    )
    .bind(serviceId)
    .first<ProxyRow>();
}

/**
 * What the stored bytes MEAN for this service's auth mode — computed once, from a ProxyRow,
 * for every reader there is. `connectionStatus` renders it, `availability` turns it into a
 * refusal, `credentialHeaders` spends it; the mode/kind exclusivity rule (§8: an envelope
 * whose kind does not match the mode is no credential at all) therefore exists in one
 * function instead of being enforced on the status path and quietly skipped on the dial
 * path. The cross-product that pins connectionStatus over mode × envelope is total over
 * the dial for the same reason.
 *
 * The two unusable arms are not the same refusal. `needs_reconnect` is a credential the hub
 * HAS and cannot use — the owner's one repair is Connect again — and covers the four ways
 * an oauth bundle is dead: absent under an oauth mode is not one of them (see below),
 * unopenable is (a foreign version byte, or ciphertext from before an UPSTREAM_CREDS_KEY
 * rotation), as are the wrong kind and the flag a failed refresh set. `not_connected` is the
 * absence of a credential: a fresh service, what Disconnect left, or an envelope this mode
 * cannot use at all.
 */
type Credential = Bundle | { unusable: Exclude<UpstreamConnectionStatus, "connected"> };

async function credentialOf(row: ProxyRow): Promise<Credential> {
  // deps: crypto.subtle (AES-GCM envelope)
  const bundle = await open(row.upstream_auth_json);
  if (row.upstream_auth_mode === "oauth") {
    // An empty column is "Connect has not run yet", not a dead credential — the distinction
    // /services renders as Connect rather than Reconnect. Everything past here is about what
    // the stored BYTES turn out to be, and bytes that will not open are a credential this
    // hub cannot use however they got that way.
    if (!row.upstream_auth_json) return { unusable: "not_connected" };
    if (bundle === null) return { unusable: "needs_reconnect" };
    if (bundle.kind !== "oauth") return { unusable: "not_connected" };
    return bundle.needsReconnect ? { unusable: "needs_reconnect" } : bundle;
  }
  // Headers mode is `connected` iff HEADERS are stored (§7), so an oauth bundle here — or
  // bytes that yield nothing — is no credential at all, and can never be `needs_reconnect`:
  // the state does not exist in this mode.
  return bundle?.kind === "headers" ? bundle : { unusable: "not_connected" };
}

/**
 * The credential half of one dial: the headers a service's stored envelope contributes,
 * with §7's proactive refresh folded in. Headers mode contributes the stored set;
 * oauth mode contributes `Authorization: Bearer`, refreshing first when the stored access
 * token has expired (or declared no lifetime at all — an AS that omits `expires_in` is
 * refreshed eagerly rather than trusted forever). A bundle the hub cannot use is
 * `needs_reconnect` and NEVER a dial: the resource is not reached, which is the one class
 * produced without a round trip.
 *
 * ponytail: refresh fires when the token has actually expired, with no early-refresh skew
 * — a skew would be a fifth window and limits.ts has no name for one. Add
 * `OAUTH_REFRESH_SKEW_MS` there if clock drift against a real AS ever costs a 401.
 */
async function credentialHeaders(service: Service, row: ProxyRow): Promise<Record<string, string>> {
  const credential = await credentialOf(row);
  if ("unusable" in credential) {
    // A credential the hub knows is dead is never spent on a round trip (§7) — that is what
    // makes needs_reconnect the one class produced with zero dials. `not_connected` is the
    // other verdict and NOT this module's refusal: the gateway's availability gate already
    // refused the CALL path with it, and the list path has nothing to attach, so it dials
    // anonymously — an upstream that demands a credential answers 401, which is
    // `upstream_status` and not a hub state.
    if (credential.unusable === "needs_reconnect") throw failure("needs_reconnect");
    return {};
  }
  if (credential.kind === "headers") return credential.headers;
  const live = await spendable(service, credential, row.upstream_auth_json);
  return { Authorization: `Bearer ${live.accessToken}` };
}

/** The opened oauth bundle a dial may actually spend: itself while its access token lives,
 *  and otherwise whatever the refresh leaves behind. */
async function spendable(
  service: Service,
  bundle: OAuthBundle,
  sealed: string | null,
): Promise<OAuthBundle> {
  if (bundle.expiresAt !== undefined && bundle.expiresAt > Date.now()) return bundle;
  return refresh(service, bundle, sealed);
}

/**
 * One refresh-token exchange, and the `needs_reconnect` flip when — and only when — the AS
 * itself says no. The refreshed bundle is re-sealed into `upstream_auth_json` BEFORE it is
 * spent (§7: "the token bundle lands in the encrypted upstream_auth_json") — an AS that
 * rotates its refresh token single-use has already burned the old one, so a bundle kept
 * only in memory is a service that works exactly once.
 *
 * ponytail: nothing SERIALIZES refresh, so two concurrent calls on one stale service both
 * exchange, and against a single-use rotating AS the loser's token is already burned. What
 * that costs is bounded here rather than left to chance — the flip is a compare-and-set and
 * the loser spends the winner's bundle — so the residual is one refused call, not a dead
 * credential. A per-service lock (the tunnel DO, or D1 `BEGIN IMMEDIATE`) is the upgrade if
 * that one call ever matters.
 */
async function refresh(
  service: Service,
  bundle: OAuthBundle,
  sealed: string | null,
): Promise<OAuthBundle> {
  const refreshed =
    bundle.refreshToken === undefined
      ? // No refresh token at all: nothing can ever renew this bundle, which is the AS's
        // answer given in advance rather than a failure to reach it.
        "rejected"
      : await redeem(bundle.tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: bundle.refreshToken,
          client_id: bundle.clientId,
        });
  if (typeof refreshed !== "string") {
    const next: OAuthBundle = { ...bundle, ...refreshed };
    await store(service.id, next);
    return next;
  }
  // The far side never answered — an outage at the token endpoint, a TLS failure, the 30 s
  // budget. That is an ordinary per-call failure and NOT evidence the grant is dead: only
  // the AS's own rejection may cost an owner a Reconnect, because the flip is the one state
  // the hub cannot undo by itself.
  if (refreshed !== "rejected") throw failure(refreshed);
  // The flip is a stored state the owner has to undo by hand, so it is bound to THIS
  // trigger and to nothing else — a resource server's own 401 leaves a live bundle live.
  // Compare-and-set on the ciphertext this refresh opened: a concurrent call may have
  // refreshed the same bundle while this exchange was in flight, and a rotating AS rejects
  // the loser for presenting a token the winner already burned. A flip that did not land
  // therefore means the credential is alive, and this call spends the winner's bundle.
  if (!(await store(service.id, { ...bundle, needsReconnect: true }, sealed))) {
    const winner = await storedBundle(service.id);
    if (winner !== null) return winner;
  }
  await record(env.DB, {
    ownerId: service.ownerId,
    principal: await ownerPrincipal(service.ownerId),
    event: "upstream.oauth_refresh_failed",
    service: service.slug,
    outcome: "error",
  });
  throw failure("needs_reconnect");
}

/** The oauth bundle stored for a service right now, if it is one this hub may spend — the
 *  re-read behind refresh's compare-and-set, and the only place a verdict is re-taken. */
async function storedBundle(serviceId: string): Promise<OAuthBundle | null> {
  const row = await proxyRowOf(serviceId);
  if (row === null) return null;
  const credential = await credentialOf(row);
  return "unusable" in credential || credential.kind !== "oauth" ? null : credential;
}

/**
 * One token-endpoint exchange, reduced to the three fields a bundle keeps — or WHICH WAY it
 * failed, because the caller's two answers to that are a refused call and a credential the
 * owner has to repair by hand. A 4xx naming an OAuth error is the AS refusing the grant
 * (`rejected`); anything else — a transport failure, the deadline, a 5xx, a body that is no
 * token response — is the far side failing to answer, which says nothing about the grant.
 * No AS status line, header or body ever travels further than here.
 */
async function redeem(
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<Pick<OAuthBundle, "accessToken" | "refreshToken" | "expiresAt"> | RedeemFailure> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    return (err as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "unreachable";
  }
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  // RFC 6749's own refusal shape, and nothing looser: a 5xx, or a 4xx with no `error` in it,
  // is a server that could not answer rather than one that said no.
  if (!response.ok) {
    return response.status < 500 && typeof body?.error === "string" ? "rejected" : "unreachable";
  }
  if (typeof body?.access_token !== "string") return "unreachable";
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    // Absent `expires_in` is NOT "forever": leaving expiresAt unset makes the next call
    // refresh eagerly, which is the only safe reading of an AS that declares no lifetime.
    ...(typeof body.expires_in === "number"
      ? { expiresAt: Date.now() + body.expires_in * 1000 }
      : {}),
  };
}

/**
 * How a token exchange failed, in the vocabulary the module already has for it. `rejected`
 * is the AS's own no and the ONLY thing that may flip a service to needs_reconnect; the
 * other two are UpstreamFailureClass members and are thrown as the per-call failure they
 * are, so a ten-second blip at a token endpoint costs one refused call rather than an
 * owner-visible dead credential.
 */
type RedeemFailure = "rejected" | Extract<UpstreamFailureClass, "unreachable" | "timeout">;

/**
 * Seal one bundle into the service's credential column — the single write path. `expected`
 * makes it a compare-and-set against the ciphertext the caller opened; omitted, the write is
 * unconditional (the last refresh to land is a live bundle either way). Answers whether this
 * caller's write is the one that landed.
 */
async function store(serviceId: string, bundle: Bundle, expected?: string | null): Promise<boolean> {
  const sealed = await seal(bundle);
  const statement =
    expected === undefined
      ? (env.DB as D1Like)
          .prepare(`UPDATE service SET upstream_auth_json = ? WHERE id = ?`)
          .bind(sealed, serviceId)
      : (env.DB as D1Like)
          .prepare(
            `UPDATE service SET upstream_auth_json = ?
              WHERE id = ? AND upstream_auth_json IS ?`,
          )
          .bind(sealed, serviceId, expected);
  const { meta } = await statement.run();
  return meta.changes === 1;
}

/**
 * Starts the interactive OAuth connect flow for an `auth: oauth` proxied service and
 * returns the authorization URL to redirect the owner's browser to. Discovers the
 * upstream's authorization server (RFC 9728 protected-resource metadata), establishes
 * the hub's client identity (CIMD document, DCR fallback where the AS demands it), and
 * records a single-use state row bound to {owner, service, expected issuer + token
 * endpoint, PKCE verifier} and to `session` — expiring 10 minutes out. Nothing is stored
 * on the service row yet. Rejects (`HubError`) a service that is headers-mode or not
 * proxied: Connect is the oauth mode's one credential path.
 */
export async function beginConnect(service: Service, session: ConnectSession): Promise<URL> {
  // deps: fetch (RFC 9728 + AS metadata discovery, DCR) · crypto (state nonce, PKCE verifier) · D1 `upstream_oauth_state` · D1 `service`
  const row = service.kind !== "proxy" ? null : await proxyRowOf(service.id);
  // Each mode has exactly one credential path (§8), and this is the oauth mode's: a
  // tunneled service has no upstream at all, a headers one has setHeaders.
  if (row?.upstream_auth_mode !== "oauth" || !row.upstream_url) {
    throw new HubError(INVALID_PARAMS, "this service does not connect through OAuth");
  }
  const server = await discover(row.upstream_url);
  const origin = new URL(env.PUBLIC_ORIGIN);
  // CIMD first — a client identity that is just a URL costs the AS no registration and the
  // hub no stored secret. DCR is the fallback for the servers that still want one.
  const clientId = server.cimd
    ? clientIdFor(origin)
    : await registerClient(server.registrationEndpoint, origin);

  const verifier = randomToken();
  const state = randomToken();
  const redirectUri = `${origin.origin}${OAUTH_CALLBACK_PATH}`;
  const now = Date.now();
  await (env.DB as D1Like)
    .prepare(
      `INSERT INTO upstream_oauth_state
         (state, owner_id, service_id, session_id, issuer, token_endpoint, client_id,
          code_verifier, redirect_uri, issuer_advertised, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      state,
      service.ownerId,
      service.id,
      session.id,
      server.issuer,
      server.tokenEndpoint,
      clientId,
      verifier,
      redirectUri,
      server.issuerAdvertised ? 1 : 0,
      now,
      now + OAUTH_STATE_TTL_MS,
    )
    .run();

  const authorize = new URL(server.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await s256(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: the token this flow mints is for THIS upstream and no other.
  authorize.searchParams.set("resource", row.upstream_url);
  return authorize;
}

/**
 * What discovery has to produce before a flow can start. `issuer` is what RFC 9207's
 * `iss` is later compared against, and `tokenEndpoint` is the mix-up defense's anchor —
 * both are recorded on the state row so the callback trusts nothing the AS says later.
 */
type AuthorizationServer = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** The AS accepts a URL client_id (a CIMD document), so no registration is needed. */
  cimd: boolean;
  /** The AS advertises RFC 9207, which is what makes the callback's `iss` check BIND. */
  issuerAdvertised: boolean;
};

/**
 * §7's "discovers the upstream's authorization server via its RFC 9728 protected-resource
 * metadata", plus the fallback the majority of deployed upstreams still need: no PRM
 * document means the resource speaks for itself, so its own URL is tried as the issuer.
 * A resource with neither answers a clean refusal rather than a crash.
 */
async function discover(upstreamUrl: string): Promise<AuthorizationServer> {
  const prm = await fetchJson(wellKnown("oauth-protected-resource", upstreamUrl));
  const advertised = (prm?.authorization_servers as unknown[] | undefined)?.find(
    (entry) => typeof entry === "string",
  ) as string | undefined;
  const issuer = advertised ?? upstreamUrl.replace(/\/+$/, "");
  const meta = await fetchJson(wellKnown("oauth-authorization-server", issuer));
  const authorizationEndpoint = str(meta?.authorization_endpoint);
  const tokenEndpoint = str(meta?.token_endpoint);
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new HubError(INVALID_PARAMS, "this upstream advertises no usable authorization server");
  }
  return {
    issuer: str(meta?.issuer) ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(meta?.registration_endpoint),
    cimd: meta?.client_id_metadata_document_supported === true,
    issuerAdvertised: meta?.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * Where a well-known document lives, for BOTH documents: the path-insertion form RFC 9728
 * and RFC 8414 share — the well-known segment at the ROOT of the host, the resource's (or
 * issuer's) own path after it. One host can therefore serve metadata for many resources, and
 * a tenant-scoped issuer (`https://as.example.com/tenant-7`, the common enterprise shape) is
 * asked at `/.well-known/oauth-authorization-server/tenant-7` rather than at the
 * concatenation, which such a server 404s. Both legs go through here so the rule has one
 * author instead of a comment on one line and a different spelling on the next.
 *
 * ponytail: no OIDC-style `${issuer}/.well-known/openid-configuration` second attempt — one
 * request per document, and an AS that only answers the concatenated form is a second
 * fetchJson call here when one turns up.
 */
function wellKnown(
  document: "oauth-protected-resource" | "oauth-authorization-server",
  url: string,
): string {
  const { origin, pathname } = new URL(url);
  // A pathless resource inserts NOTHING — a trailing slash is a different URL to a server
  // that routes on the exact path.
  return `${origin}/.well-known/${document}${pathname === "/" ? "" : pathname.replace(/\/+$/, "")}`;
}

/** Dynamic Client Registration — the fallback identity, for an AS that will not take a
 *  URL client_id. The document registered is the same one `clientMetadata` serves. */
async function registerClient(endpoint: string | undefined, origin: URL): Promise<string> {
  const registered =
    endpoint === undefined
      ? null
      : await fetchJson(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(clientDocument(origin)),
        });
  const clientId = str(registered?.client_id);
  if (clientId === undefined) {
    throw new HubError(INVALID_PARAMS, "this authorization server issued the hub no client identity");
  }
  return clientId;
}

/**
 * The `/oauth/upstream/callback` endpoint, shared across all upstream authorization
 * servers. Requires a valid owner cookie session; resolves `state` to a live, unconsumed
 * row bound to that same session and consumes it by compare-and-set delete — a missing,
 * mismatched, expired, replayed, or other-session `state` rejects the callback with
 * nothing stored. Verifies RFC 9207 `iss` when the AS advertises it, then redeems the
 * code with the bound PKCE verifier only at the token endpoint recorded at initiation
 * (the mix-up defense), seals the token bundle into the credential envelope, and writes
 * `upstream.oauth_connected`. Returns the page/redirect for the owner's browser; error
 * responses never echo AS details.
 */
export async function handleCallback(req: Request): Promise<Response> {
  // deps: identity.requireOwnerSession (OwnerSession.sessionId) · D1 `upstream_oauth_state` · fetch (token endpoint) · crypto.subtle (AES-GCM envelope) · D1 `service` · audit.record
  // §13: no session, no callback — decided before `state` is even looked up. A
  // bearer-sourced (CLI) session never resolves here, which is identity's own guard.
  const session = await requireOwnerSession(req);
  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  if (state === null) return connectRefused();
  const row = await (env.DB as D1Like)
    .prepare(
      `SELECT st.*, s.slug AS slug FROM upstream_oauth_state st
         JOIN service s ON s.id = st.service_id
        WHERE st.state = ?`,
    )
    .bind(state)
    .first<StateRow>();
  // Unknown, other-session, other-owner and past-TTL all refuse identically and leave the
  // row alone: expiry bites at READ time, and the daily sweep is only hygiene.
  if (
    row === null ||
    row.session_id !== session.sessionId ||
    row.owner_id !== session.user.userId ||
    row.expires_at <= Date.now()
  ) {
    return connectRefused();
  }
  // RFC 9207, and only when the AS advertises it — a hub that demanded `iss`
  // unconditionally would refuse every AS that has not adopted the RFC. When it DOES
  // bind, absence fails it exactly like a mismatch: an attacker's AS simply omits the
  // parameter, so `iss && iss !== recorded` would wave the cheaper attack through.
  if (row.issuer_advertised !== 0 && params.get("iss") !== row.issuer) return connectRefused();
  const code = params.get("code");
  if (code === null) return connectRefused();

  // Single-use, enforced by the consuming delete rather than by a flag anyone could
  // forget to read: of two concurrent callbacks on one row, exactly one changes a row.
  const consumed = await (env.DB as D1Like)
    .prepare(`DELETE FROM upstream_oauth_state WHERE state = ?`)
    .bind(state)
    .run();
  if (consumed.meta.changes !== 1) return connectRefused();

  // Redeemed ONLY at the endpoint recorded at initiation, with the verifier bound to this
  // row — the mix-up defense, which is why neither value is read off the response.
  const tokens = await redeem(row.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
    client_id: row.client_id,
    code_verifier: row.code_verifier,
  });
  // Every way a redemption fails refuses this callback identically (see connectRefused):
  // the AS's no and the AS's silence are one answer to an owner's browser.
  if (typeof tokens === "string") return connectRefused();
  await store(row.service_id, {
    kind: "oauth",
    ...tokens,
    tokenEndpoint: row.token_endpoint,
    clientId: row.client_id,
  });
  await record(env.DB, {
    ownerId: row.owner_id,
    principal: formatPrincipal(session.user),
    event: "upstream.oauth_connected",
    service: row.slug,
    outcome: "ok",
  });
  return Response.redirect(`${new URL(env.PUBLIC_ORIGIN).origin}/services`, 302);
}

/** One connect-flow state row, joined to the slug its audit row needs. */
type StateRow = {
  state: string;
  owner_id: string;
  service_id: string;
  session_id: string;
  issuer: string;
  token_endpoint: string;
  client_id: string;
  code_verifier: string;
  redirect_uri: string;
  issuer_advertised: number;
  created_at: number;
  expires_at: number;
  slug: string;
};

/**
 * The ONE refusal every defective callback gets. Deliberately one sentence with no
 * parameters: an AS's status line, headers and body never reach the owner's browser
 * (§7's hygiene rule, extended to this surface), and a refusal that named which check
 * failed would tell an attacker whether their `state` guess existed.
 */
function connectRefused(): Response {
  return new Response("Could not complete the upstream connection. Start Connect again.", {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Wipes the stored credential envelope (either auth mode), leaving the service
 * not-connected until Connect (`oauth`) or `setHeaders` (`headers`) runs again; writes
 * the `upstream.disconnected` audit row. Roles, grants, and every other configuration
 * field are untouched. Idempotent: disconnecting an already-empty service is a no-op.
 * An auth-mode flip never routes through here — clearing the envelope on a flip is
 * registry.updateService's row invariant, and its audit row is the admin op's.
 */
export async function disconnect(service: Service): Promise<void> {
  // deps: D1 `service` · audit.record
  await (env.DB as D1Like)
    .prepare(`UPDATE service SET upstream_auth_json = NULL WHERE id = ?`)
    .bind(service.id)
    .run();
  // Unconditional, unlike the wipe above: the row records that Disconnect RAN, which is
  // what an owner reading the ledger asked about. "Idempotent" is about the envelope.
  await record(env.DB, {
    ownerId: service.ownerId,
    principal: await ownerPrincipal(service.ownerId),
    event: "upstream.disconnected",
    service: service.slug,
    outcome: "ok",
  });
}

/**
 * Stores static upstream headers for an `auth: headers` proxied service — sealed into
 * the credential envelope, replacing any previous set wholesale. Write-only, like
 * `token_issue`: no read path exists, and headers never appear in YAML or read tools.
 * Rejects (`HubError`) oauth-mode or non-proxied services — each mode has exactly one
 * credential path.
 */
export async function setHeaders(service: Service, headers: Record<string, string>): Promise<void> {
  // deps: crypto.subtle (AES-GCM envelope) · D1 `service` · errors.HubError
  // Each mode has exactly one credential path (§8), and this is the headers mode's: a
  // tunneled service has no upstream at all (and no auth mode), an oauth one has Connect.
  const row = service.kind !== "proxy" ? null : await proxyRowOf(service.id);
  if (row?.upstream_auth_mode !== "headers") {
    throw new HubError(INVALID_PARAMS, "this service does not store upstream headers");
  }
  await store(service.id, { kind: "headers", headers });
}

/**
 * What an envelope holds, per auth mode — this module's alone, since nothing outside reads
 * `upstream_auth_json`. The `kind` tag is what makes a mode/credential mismatch legible on
 * the way OUT of the envelope: registry's row invariant keeps the two aligned on the way
 * in, and `connectionStatus` still asks, because an envelope whose kind does not match the
 * service's mode is no credential at all.
 */
type HeadersBundle = { kind: "headers"; headers: Record<string, string> };

/**
 * The oauth half. `expiresAt` absent means the AS declared no lifetime (`no_expires_in`),
 * which is read as "refresh before every use", never as "valid forever".
 * `needsReconnect` is set by the one thing §7 binds it to — a failed refresh — and is why
 * the flag lives INSIDE the ciphertext rather than in a column: a D1 export of a dead
 * service says no more about it than an export of a live one.
 */
type OAuthBundle = {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Where the code was redeemed at initiation — the mix-up defense, carried forward so
   *  every later refresh goes to the same endpoint the state row bound. */
  tokenEndpoint: string;
  clientId: string;
  needsReconnect?: true;
};

type Bundle = HeadersBundle | OAuthBundle;

/**
 * The opening half of `seal` (§5): base64 → version byte → AES-GCM under UPSTREAM_CREDS_KEY.
 *
 * NEVER THROWS, and that is the contract, not a convenience. This runs on the hot path —
 * gateway.probeAvailability calls `connectionStatus` per proxied `tools/call` — and the
 * version byte exists precisely so ciphertext written under a previous UPSTREAM_CREDS_KEY
 * survives a rotation as data rather than as an exception. Anything that will not open
 * under today's key is `null`: not a credential, not a crash.
 */
async function open(sealed: string | null): Promise<Bundle | null> {
  if (!sealed) return null;
  try {
    const framed = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    if (framed[0] !== ENVELOPE_VERSION) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: framed.subarray(1, 1 + IV_BYTES) },
      await envelopeKey(),
      framed.subarray(1 + IV_BYTES),
    );
    const bundle = JSON.parse(new TextDecoder().decode(plain)) as Bundle | null;
    return bundle?.kind === "headers" || bundle?.kind === "oauth" ? bundle : null;
  } catch {
    return null;
  }
}

/**
 * JSON-RPC's own "invalid params" — not one of §7's four refusal codes, which describe a
 * consumer's call, and this refuses an OWNER's configuration request instead.
 */
const INVALID_PARAMS = -32602;

/** The envelope's leading version byte, so ciphertext written under today's key is
 *  self-describing before any key is applied (§5: the key rotates without a migration). */
const ENVELOPE_VERSION = 1;

/** The AES-GCM nonce width version 1 frames — named once so `seal` and `open` cannot
 *  disagree about where the ciphertext starts. */
const IV_BYTES = 12;

/**
 * Seal one credential bundle into `upstream_auth_json` (§5): `base64(version ‖ iv ‖
 * AES-GCM ciphertext)` under the single UPSTREAM_CREDS_KEY secret. The bundle's shape is
 * this module's alone — nothing outside reads the column.
 */
async function seal(bundle: Bundle): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await envelopeKey(),
      new TextEncoder().encode(JSON.stringify(bundle)),
    ),
  );
  const framed = new Uint8Array(1 + iv.length + ciphertext.length);
  framed[0] = ENVELOPE_VERSION;
  framed.set(iv, 1);
  framed.set(ciphertext, 1 + iv.length);
  return btoa(String.fromCharCode(...framed));
}

/**
 * The AES-GCM key behind every envelope, derived from the wrangler secret so any secret
 * string is a valid key. Throws rather than falling back when the secret is unset: a hub
 * that quietly stored upstream credentials in the clear is the one failure this whole
 * envelope exists to prevent.
 */
async function envelopeKey(): Promise<CryptoKey> {
  const secret = env.UPSTREAM_CREDS_KEY;
  if (!secret) throw new Error("UPSTREAM_CREDS_KEY is unset — upstream credentials cannot be sealed");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Who a credential change is recorded as. Every path into this module is owner-initiated
 * (§8: Connect is a browser interaction, Disconnect and setHeaders are admin ops), and the
 * seams take a `Service` rather than a principal — so the one name the ledger needs is
 * looked up from the namespace the service already carries.
 */
async function ownerPrincipal(ownerId: string): Promise<string> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "username" FROM "user" WHERE "id" = ?`)
    .bind(ownerId)
    .first<{ username: string }>();
  return formatPrincipal({ kind: "user", userId: ownerId, username: row?.username ?? ownerId });
}

/**
 * Reports the service's upstream credential state (see `UpstreamConnectionStatus` for
 * the exact meaning per auth mode). Read-only and side-effect free — it never dials the
 * upstream or attempts a refresh; it reports what the last call-time refresh left
 * behind. Backs `service_list` / `service_get` and the `/services`
 * Connect/Reconnect/Disconnect buttons.
 */
export async function connectionStatus(service: Service): Promise<UpstreamConnectionStatus> {
  // deps: proxyRowOf · credentialOf
  const row = await proxyRowOf(service.id);
  if (row === null) return "not_connected";
  // Rendered, not decided: what the stored bytes mean for this mode is credentialOf's, and
  // the dial path reads the same verdict — which is what makes this answer a fact about the
  // service rather than about this function (see Credential).
  const credential = await credentialOf(row);
  return "unusable" in credential ? credential.unusable : "connected";
}

/**
 * §7's availability-first verdict for a PROXIED service, as the refusal itself rather than
 * as a boolean: null when the stored credential may be spent, and otherwise the error the
 * gateway throws in its place — with no dial attempted either way (this is stored
 * knowledge, so a `connected` upstream that is genuinely down still surfaces at dispatch).
 *
 * The two refusals are deliberately different objects. `needs_reconnect` is one of §7's
 * five upstream failure classes and carries it, so the tools/call audit row's `detail`
 * tells an owner "the credential died" rather than just "-32000". `not_connected` is not
 * an upstream failure at all — the service was never connected — so it refuses with the
 * gateway's own class-free -32000, which is what keeps a never-configured service from
 * being reported as a broken credential.
 */
export async function availability(service: Service): Promise<HubError | null> {
  // deps: connectionStatus
  const status = await connectionStatus(service);
  if (status === "connected") return null;
  return status === "needs_reconnect" ? failure("needs_reconnect") : unavailable();
}

/**
 * Cron sweep: deletes expired `upstream_oauth_state` rows and returns how many were
 * removed. Hygiene, not correctness — the callback already treats a past-TTL row as
 * dead — so the sweep can run at any cadence (the daily cron) without a security window.
 */
export async function cleanupStaleState(): Promise<number> {
  // deps: D1 `upstream_oauth_state`
  const swept = await (env.DB as D1Like)
    .prepare(`DELETE FROM upstream_oauth_state WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();
  return swept.meta.changes;
}

/**
 * Serves the hub's CIMD (client ID metadata document): the OAuth client identity
 * `beginConnect` presents to upstream authorization servers — the client_id is this
 * document's own URL under the canonical public origin, which the composition root
 * passes in. Static, secret-free JSON; safe to serve unauthenticated.
 */
export function clientMetadata(origin: URL): Response {
  // deps: none
  return new Response(JSON.stringify(clientDocument(origin)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The two paths this module owns on the public origin, exported so the composition root
 * mounts exactly the URLs `beginConnect` puts on the wire — a redirect_uri that does not
 * resolve is a flow that fails at the AS, in the owner's browser, with nothing to read.
 */
export const OAUTH_CALLBACK_PATH = "/oauth/upstream/callback";
export const CLIENT_METADATA_PATH = "/oauth/client-metadata";

/** The hub's CIMD, as a value — served by `clientMetadata` and POSTed by DCR, so the
 *  identity the hub registers and the one it publishes cannot drift. Secret-free. */
function clientDocument(origin: URL): Record<string, unknown> {
  return {
    client_id: clientIdFor(origin),
    client_name: "Personal MCP Hub",
    client_uri: origin.origin,
    redirect_uris: [`${origin.origin}${OAUTH_CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client: the hub holds no client secret for any upstream, which is what makes
    // PKCE the whole of the redemption binding.
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}

/** A CIMD's client_id IS the document's own URL — that is the whole mechanism. */
function clientIdFor(origin: URL): string {
  return `${origin.origin}${CLIENT_METADATA_PATH}`;
}

/** One JSON document off the network, or null for anything that is not one. Never throws:
 *  discovery legs are optional by design and an absent document is an answer. */
async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...init,
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** A metadata field the hub is willing to act on — a string, or nothing. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 256 bits of randomness as base64url — the shape both the `state` nonce and the PKCE
 *  verifier need (RFC 7636's 43–128 unreserved characters). */
function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
async function s256(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
