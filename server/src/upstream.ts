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
import { HubError } from "./errors";
import type { BackendCtx, JsonRpcRequest, JsonRpcResponse, ServiceBackend, Tool } from "./gateway";
import { formatPrincipal } from "./principal";
import type { Service } from "./registry";
import { CALL_TIMEOUT_MS } from "./limits";

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
 * ponytail: D5 owns this module. What is here is the TRANSPORT alone, which is all the
 * order-table's proxied allow-twins need: no credential envelope is read (so an upstream
 * that demands one answers 401 → `upstream_status`), no proactive refresh, no
 * needs_reconnect flip, and a hand-written POST rather than the SDK `Client` §7 pins
 * (`@modelcontextprotocol/client` is not a dependency yet). Each of those is an addition
 * here, not a rewrite of the pipeline above it.
 */
async function dial(
  service: Service,
  msg: JsonRpcRequest,
  identity?: BackendCtx,
): Promise<JsonRpcResponse> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT upstream_url, forward_identity FROM service WHERE id = ?`)
    .bind(service.id)
    .first<{ upstream_url: string | null; forward_identity: number }>();
  if (!row?.upstream_url) throw failure("unreachable");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
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
  throw new Error("unimplemented");
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
  throw new Error("unimplemented");
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
  const mode = await authModeOf(service);
  // Each mode has exactly one credential path (§8), and this is the headers mode's: a
  // tunneled service has no upstream at all, an oauth one has Connect.
  if (mode !== "headers") {
    throw new HubError(INVALID_PARAMS, "this service does not store upstream headers");
  }
  await (env.DB as D1Like)
    .prepare(`UPDATE service SET upstream_auth_json = ? WHERE id = ?`)
    .bind(await seal({ kind: "headers", headers }), service.id)
    .run();
}

/** The declared auth mode of a PROXIED service; null for a tunneled one (it has no upstream). */
async function authModeOf(service: Service): Promise<"headers" | "oauth" | null> {
  if (service.kind !== "proxy") return null;
  const row = await (env.DB as D1Like)
    .prepare(`SELECT upstream_auth_mode FROM service WHERE id = ?`)
    .bind(service.id)
    .first<{ upstream_auth_mode: "headers" | "oauth" | null }>();
  return row?.upstream_auth_mode ?? null;
}

/**
 * JSON-RPC's own "invalid params" — not one of §7's four refusal codes, which describe a
 * consumer's call, and this refuses an OWNER's configuration request instead.
 */
const INVALID_PARAMS = -32602;

/** The envelope's leading version byte, so ciphertext written under today's key is
 *  self-describing before any key is applied (§5: the key rotates without a migration). */
const ENVELOPE_VERSION = 1;

/**
 * Seal one credential bundle into `upstream_auth_json` (§5): `base64(version ‖ iv ‖
 * AES-GCM ciphertext)` under the single UPSTREAM_CREDS_KEY secret. The bundle's shape is
 * this module's alone — nothing outside reads the column.
 *
 * ponytail: the opening half is written with the dispatch that needs it (D5's proactive
 * refresh and the `needs_reconnect` read inside the bundle — `connectionStatus`'s own
 * note). Until then the envelope is written and never read back, which is exactly what
 * §8's "write-only, like token_issue" asks of the headers path anyway.
 */
async function seal(bundle: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
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
  // deps: D1 `service` · crypto.subtle (AES-GCM envelope)
  // ponytail: presence of the envelope column only — enough for the not_connected/connected
  // split registry.test.ts observes across an auth-mode flip. `needs_reconnect` lives INSIDE
  // the envelope, so telling it apart needs the AES-GCM open path this module's own dispatch
  // (D5) lands with the rest of the file; extend here when it does.
  const row = await (env.DB as D1Like)
    .prepare(`SELECT upstream_auth_json FROM service WHERE id = ?`)
    .bind(service.id)
    .first<{ upstream_auth_json: string | null }>();
  return row?.upstream_auth_json ? "connected" : "not_connected";
}

/**
 * Cron sweep: deletes expired `upstream_oauth_state` rows and returns how many were
 * removed. Hygiene, not correctness — the callback already treats a past-TTL row as
 * dead — so the sweep can run at any cadence (the daily cron) without a security window.
 */
export async function cleanupStaleState(): Promise<number> {
  // deps: D1 `upstream_oauth_state`
  throw new Error("unimplemented");
}

/**
 * Serves the hub's CIMD (client ID metadata document): the OAuth client identity
 * `beginConnect` presents to upstream authorization servers — the client_id is this
 * document's own URL under the canonical public origin, which the composition root
 * passes in. Static, secret-free JSON; safe to serve unauthenticated.
 */
export function clientMetadata(origin: URL): Response {
  // deps: none
  throw new Error("unimplemented");
}
