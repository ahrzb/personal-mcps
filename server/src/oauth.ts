// oauth.ts — the hub as an inbound OAuth authorization server (§19), as ONE module that
// HIDES a single fact from the rest of the worker: that better-auth's oauthProvider() is
// what actually mints and signs the tokens. Every caller here asks for a PRINCIPAL or a
// METADATA DOCUMENT and gets exactly that — never a token payload, never a better-auth
// handle, never a JWKS. The door leg (identity.resolveCredential) hands this module a
// JWT-shaped bearer and the addressed namespace and receives a `agent` Principal
// or `null`; the consent page hands it a chosen agent and receives a written binding; the
// connections surfaces hand it an owner id and receive rows with no secret in them. That the
// authorization server underneath is better-auth is not knowledge any of them carry.
//
// OWNS, and is the only site that touches:
//   · the two §19.2 discovery documents — RFC 8414 AS metadata (forwarded from the
//     provider's own issuer-metadata middleware, which a `basePath` of /api/auth otherwise
//     keeps off the root) and the per-namespace RFC 9728 protected-resource document (built
//     here, five fields interpolated from a path parameter, never a lookup);
//   · the `oauth_binding` table (§19.4) — every read and every write. One binding is one
//     OAuth client bound to one agent in one namespace; the door reads it per call
//     (which is what makes revocation immediate, §19.6), consent upserts it, revoke tombstones
//     it and deletes the provider's consent row so a refresh cannot resurrect it;
//   · the door's verification primitive — `verifyJwsAccessToken` against the hub's own JWKS,
//     with the aud/scope/issuer acceptance test §19.6 step 3 pins. Local verification, no D1
//     or adapter read on the verify side (§19.1); the JWKS is fetched once per isolate and
//     cached by the primitive's own function-source cache.
//
// The audience is namespace-wide (§19.6): a token's `aud` is the aggregated
// `https://<origin>/<user>/mcp`, the SAME string on the scoped `/<user>/mcp/<slug>` shape —
// grants filter per slug downstream, exactly as they do for a `pmcp_agt_` key, so an
// OAuth-resolved principal is indistinguishable from that agent's key (§16). Audit rows are
// deliberately NOT written here: the row a mutation earns is its CALLER's (web.ts writes
// `oauth.consented`/`oauth.rebound`/`oauth.revoked`, admin.ts writes
// `admin.connection_revoke`), because one binding write fronts two audit vocabularies and
// this module owns the row, not the ledger.

import { env } from "cloudflare:workers";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { authRoutes } from "./identity";
import { TOKEN_LAST_USED_STAMP_MS } from "./limits";
import type { Principal } from "./principal";

/** The control plane, resolved ambiently like identity and admin do — no binding parameter
 *  threads through §19's callers. `D1Like` is workers-env.d.ts's shared shape. */
function db(): D1Like {
  return env.DB as D1Like;
}

/**
 * §19.3's ONE spelling of a namespace's OAuth resource identifier —
 * `https://<origin>/<user>/mcp`, scheme+host from PUBLIC_ORIGIN, the username path included.
 * This is the same string admin.provisionUser writes into `oauthResource`, the PRM below
 * names as `resource`, and the door checks as `aud`: the row, the document and the audience
 * are one value with one spelling, so a client that discovers the PRM asks for exactly the
 * audience the door will accept. Derived from the username alone — never the slug — because
 * the audience is namespace-wide (§19.6): one token works on the aggregated shape and on
 * every `/<user>/mcp/<slug>` under it.
 */
function resourceIdentifier(username: string): string {
  return `${env.PUBLIC_ORIGIN}/${username}/mcp`;
}

// ─────────────────────────────── §19.2 discovery documents ───────────────────────────────

/** The AS-metadata document path (§19.2), at the origin ROOT — where a client that read
 *  `authorization_servers: [<origin>]` probes. Exported so the composition root mounts it
 *  without respelling it. */
export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** The per-namespace PRM path (§19.2). `:user` is a Hono path parameter; the document is
 *  derived from it, never from a lookup. Exported for the same reason. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/:user/mcp";

/**
 * GET `/.well-known/oauth-authorization-server` — RFC 8414 AS metadata (§19.2). The document
 * is the provider's own: better-auth serves it from an issuer-metadata middleware keyed on
 * the issuer path, which — because the issuer is the origin ROOT (`jwt`'s issuer =
 * PUBLIC_ORIGIN) — is exactly `/.well-known/oauth-authorization-server`. But the provider is
 * mounted under `/api/auth`, so the composition root never routes a root well-known request
 * into it; this forwarder does, by handing better-auth a request whose pathname IS that root
 * path. The document's `issuer` then comes back byte-identical to PUBLIC_ORIGIN (§19.2), and
 * its endpoints keep pointing at `${baseURL}/oauth2/*` — an issuer and its endpoints need not
 * share a path. The one thing added on the way out is CORS: the document is public metadata a
 * browser-side client may fetch cross-origin, so it carries `Access-Control-Allow-Origin: *`.
 */
export async function authServerMetadata(): Promise<Response> {
  // deps: identity.authRoutes (the mounted better-auth surface) · better-auth issuer-metadata middleware
  const served = await forwardToProvider(AUTH_SERVER_METADATA_PATH);
  const headers = new Headers(served.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(served.body, { status: served.status, headers });
}

/**
 * GET `/.well-known/oauth-protected-resource/<user>/mcp` — RFC 9728 protected-resource
 * metadata for that namespace (§19.2). Built here, not by the provider: the hub is
 * multi-tenant (one resource identifier per namespace), so the presets that serve a single
 * fixed resource do not fit. Derived from the path parameter with NO lookup — a username that
 * does not exist gets a well-formed document, the same anti-enumeration reason §7 step 1 gives
 * the 401 the same bytes either way. `authorization_servers` names exactly one entry, the
 * origin root, because a client reads entry [0] and never falls back to a later one. Public
 * metadata, so `Access-Control-Allow-Origin: *`.
 */
export function protectedResourceMetadata(user: string): Response {
  const body = {
    resource: resourceIdentifier(user),
    authorization_servers: [env.PUBLIC_ORIGIN],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Hands better-auth a request whose pathname is `path` and returns its Response. Used for the
 * two things this module needs FROM the provider but must serve at a location the provider's
 * own `basePath` puts out of reach: the root AS-metadata document (via the issuer-metadata
 * middleware) and the public JWKS (`/api/auth/jwks`, which the middleware leaves on the mount).
 * `authRoutes()` is identity's — better-auth's one custodian — so this module reaches the
 * authorization server the same way every non-custodian does, through a request, never a
 * shared instance.
 */
function forwardToProvider(path: string): Promise<Response> {
  const app = authRoutes() as { fetch(request: Request): Promise<Response> };
  return app.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`));
}

// ─────────────────────────────── §19.6 the door: token → principal ───────────────────────

/**
 * §19.6, the whole OAuth leg of the door, as ONE answer: a JWT-shaped bearer and the
 * addressed namespace in, a `agent` Principal or `null` out — the identical shape a
 * `pmcp_agt_` key produces, so nothing downstream branches on how the credential arrived (§16).
 * `null` for EVERY way the token fails to name a live binding: bad signature, wrong issuer,
 * wrong or missing audience, expired, missing `mcp` scope, no `client_id`, an unknown or
 * deleted namespace, or no live `oauth_binding` row. The caller (identity.resolveCredential)
 * turns every `null` into the one 401 challenge and NEVER falls through to a session lookup —
 * that terminality is the leg's, this function only refuses to resolve anyone it should not.
 *
 * The acceptance test is the claims, not the signer (§19.6 step 3): `verifyJwsAccessToken`
 * proves signature, issuer, `exp` and — crucially — `aud` = this namespace's aggregated
 * resource, so a correctly-signed JWT minted from a cookie session at `/api/auth/token` (no
 * matching `aud`, no `mcp` scope) is refused here, "hub-signed" never being sufficient. The
 * binding row is read per call, which is what makes revocation immediate rather than
 * `exp`-bound, and is the SAME one-per-request D1 cost a `pmcp_agt_` key already pays — the
 * verify side adds none (§19.1).
 *
 * `now` is the injected clock the coarse `last_used_at` stamp reads, the same seam
 * identity.resolvePrincipal carries; production callers omit it.
 */
export async function resolveOAuthPrincipal(
  token: string,
  username: string,
  now: () => number = Date.now,
): Promise<Principal | null> {
  // deps: better-auth verifyJwsAccessToken · identity.authRoutes (JWKS) · D1 `user` · D1 `oauth_binding` · D1 `agent`
  const payload = await verifyAccessToken(token, resourceIdentifier(username));
  if (payload === null) return null;
  if (!hasMcpScope(payload)) return null;
  const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
  if (clientId === null) return null;
  const ownerId = await ownerIdFor(username);
  if (ownerId === null) return null;
  return bindingPrincipal(ownerId, clientId, now);
}

/** An access-token JWT payload with the two claims the door reads by name; every other
 *  claim `verifyJwsAccessToken` returns is present but not this leg's business. */
type AccessTokenPayload = { client_id?: unknown; scope?: unknown; scp?: unknown };

/**
 * Local JWS verification against the hub's own JWKS (§19.1's `verifyJwsAccessToken` with a
 * FUNCTION source): signature, `iss` = the hub issuer, `exp`, and `aud` = the aggregated
 * resource, all checked by jose with zero D1 or adapter read. A function source verifies
 * against a locally-held key set; the primitive's own module-level cache, keyed by
 * JWKS_CACHE_KEY, holds it after the first fetch so the hot path fetches nothing. Any throw —
 * malformed, bad signature, wrong claim — is a refusal, so this returns `null` rather than
 * surfacing which check failed (the door's 401 leaks nothing).
 */
async function verifyAccessToken(token: string, resource: string): Promise<AccessTokenPayload | null> {
  try {
    return (await verifyJwsAccessToken(token, {
      jwksFetch: fetchHubJwks,
      jwksCacheKey: JWKS_CACHE_KEY,
      verifyOptions: { issuer: env.PUBLIC_ORIGIN, audience: resource },
    })) as AccessTokenPayload;
  } catch {
    return null;
  }
}

/**
 * The stable object the verify primitive files the fetched JWKS under. It MUST be an object
 * (the primitive's cache is a WeakMap) and it must be one reference for the isolate's life, so
 * a busy door fetches the key set once — on the first verify — and every call after reads the
 * in-process cache, adding no D1 or adapter read on the hot path (§19.1). A module-level const
 * is exactly that: the WeakMap holds it weakly, this binding holds it strongly.
 */
const JWKS_CACHE_KEY: object = {};

/** jose's JWKS source shape, taken from the verify primitive's own parameter type so no `jose`
 *  specifier is imported (it is a transitive dependency, not a direct one). */
type JwksSource = Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"];

/**
 * The hub's public JWKS, from the provider's own `/api/auth/jwks` — public keys, so served
 * unauthenticated and safe to fetch this way. Called by the verify primitive on a cache miss
 * only (see JWKS_CACHE_KEY). Returns the parsed `{ keys: [...] }` a local key set is built
 * from; the cast is to the primitive's own function-source type, which `res.json()`'s
 * `unknown` cannot name on its own.
 */
const fetchHubJwks = (async (): Promise<unknown> => {
  const res = await forwardToProvider("/api/auth/jwks");
  return res.json();
}) as Extract<JwksSource, (...args: never[]) => unknown>;

/** Whether the token carries the one functional scope §19.3 defines. Accepts either the
 *  space-delimited `scope` string OAuth issues or an `scp` array, so the check does not
 *  depend on which the provider spells. */
function hasMcpScope(payload: AccessTokenPayload): boolean {
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(" ")
      : Array.isArray(payload.scp)
        ? (payload.scp as unknown[])
        : [];
  return scopes.includes("mcp");
}

/**
 * §19.6 step 4: the verified `client_id` plus the addressed owner resolve `oauth_binding`. A
 * live row (not revoked, its agent still present — the JOIN drops a cascade-deleted one)
 * yields the `agent` Principal and coarsely stamps `last_used_at`; anything else is
 * `null`, the same refusal a missing token gets, and also the actionable answer — the owner
 * re-consents.
 */
async function bindingPrincipal(
  ownerId: string,
  clientId: string,
  now: () => number,
): Promise<Principal | null> {
  const row = await db()
    .prepare(
      `SELECT b."id", b."agent_id", b."last_used_at", a."slug"
         FROM oauth_binding b
         JOIN agent a ON a."id" = b."agent_id"
        WHERE b."owner_id" = ? AND b."client_id" = ? AND b."revoked_at" IS NULL`,
    )
    .bind(ownerId, clientId)
    .first<{ id: string; agent_id: string; last_used_at: number | null; slug: string }>();
  if (row === null) return null;
  await stampBinding(row.id, row.last_used_at, now());
  return { kind: "agent", agentId: row.agent_id, ownerId, slug: row.slug };
}

/** The coarse `last_used_at` stamp (§19.6/§5): advanced at most once per
 *  TOKEN_LAST_USED_STAMP_MS, the same window `token.last_used_at` uses, so a busy connection
 *  costs one write an hour rather than one per call. Only a successful resolve reaches here. */
async function stampBinding(id: string, lastUsedAt: number | null, at: number): Promise<void> {
  if (lastUsedAt != null && at - lastUsedAt < TOKEN_LAST_USED_STAMP_MS) return;
  await db().prepare(`UPDATE oauth_binding SET "last_used_at" = ? WHERE "id" = ?`).bind(at, id).run();
}

/** The user id behind a username, or null when no such user exists (§19.8: an unknown
 *  namespace is a resolution failure — `null` here, the same 401 as no token — never a 404). */
async function ownerIdFor(username: string): Promise<string | null> {
  if (username === "") return null;
  const row = await db()
    .prepare(`SELECT "id" FROM "user" WHERE "username" = ?`)
    .bind(username)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ─────────────────────────────── §19.5 consent: writing the binding ───────────────────────

/** What an upsert did: a first consent INSERTs (`consented`), a re-consent UPDATEs the same
 *  row (`rebound`) — never a second row (§19.5). The caller picks its audit event from this. */
export type BindingUpsert = { id: string; action: "consented" | "rebound" };

/**
 * §19.5 step 4: bind the chosen agent to this client, on the owner's consent. A
 * first consent INSERTs; a re-consent — same `(owner, client)` — UPDATEs that one row to the
 * new agent and clears any prior revocation, so `oauth.rebound` replaces the old grant
 * rather than accumulating rows (the `UNIQUE (owner_id, client_id)` invariant, §19.4).
 * Returns `null` when the named agent is NOT in this owner's namespace — the structural
 * refusal behind §19.5's "a consent POST naming an agent in another namespace is
 * refused", enforced here so no page can forget it. `now` stamps `created_at` on the INSERT.
 */
export async function upsertBinding(
  input: { ownerId: string; clientId: string; agentId: string },
  now: () => number = Date.now,
): Promise<BindingUpsert | null> {
  // deps: D1 `agent` · D1 `oauth_binding`
  const owned = await db()
    .prepare(`SELECT 1 AS ok FROM agent WHERE "id" = ? AND "owner_id" = ?`)
    .bind(input.agentId, input.ownerId)
    .first<{ ok: number }>();
  if (owned === null) return null;
  const existing = await db()
    .prepare(`SELECT "id" FROM oauth_binding WHERE "owner_id" = ? AND "client_id" = ?`)
    .bind(input.ownerId, input.clientId)
    .first<{ id: string }>();
  if (existing !== null) {
    await db()
      .prepare(`UPDATE oauth_binding SET "agent_id" = ?, "revoked_at" = NULL WHERE "id" = ?`)
      .bind(input.agentId, existing.id)
      .run();
    return { id: existing.id, action: "rebound" };
  }
  const id = crypto.randomUUID();
  await db()
    .prepare(
      `INSERT INTO oauth_binding ("id", "owner_id", "client_id", "agent_id", "created_at")
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.ownerId, input.clientId, input.agentId, now())
    .run();
  return { id, action: "consented" };
}

// ─────────────────────────────── §19.6/§13 connections: read and revoke ───────────────────

/** One live connection as the /oauth/connections page and `connection_list` show it — the
 *  client it binds, the agent it is bound to, and its timestamps. Never a token, a client
 *  secret, or a JWT (§8): a connection is a binding, and a binding holds no credential. */
export type Connection = {
  id: string;
  clientId: string;
  clientName: string | null;
  agentSlug: string;
  createdAt: number;
  lastUsedAt: number | null;
};

/**
 * Every live binding in the namespace, newest first (§13/§8). Revoked bindings are omitted —
 * a revocation tombstones the row for immediacy at the door, and there is nothing left to act
 * on here. The client's display name is the provider's, `null` when it registered without one
 * (a DCR client may); the caller shows the id in that case. No secret is selected, by
 * construction: the columns are the binding's, and the binding has none.
 */
export async function listConnections(ownerId: string): Promise<Connection[]> {
  // deps: D1 `oauth_binding` · D1 `agent` · D1 `oauthClient`
  const { results } = await db()
    .prepare(
      `SELECT b."id", b."client_id", b."created_at", b."last_used_at",
              a."slug" AS agent_slug, c."name" AS client_name
         FROM oauth_binding b
         JOIN agent a ON a."id" = b."agent_id"
    LEFT JOIN "oauthClient" c ON c."clientId" = b."client_id"
        WHERE b."owner_id" = ? AND b."revoked_at" IS NULL
        ORDER BY b."created_at" DESC`,
    )
    .bind(ownerId)
    .all<{
      id: string;
      client_id: string;
      created_at: number;
      last_used_at: number | null;
      agent_slug: string;
      client_name: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    agentSlug: row.agent_slug,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  }));
}

/** What a revoke touched — enough for the caller's audit row, no more. */
export type ConnectionRevoked = { id: string; clientId: string };

/**
 * Revoke one connection by id, scoped to `ownerId`'s namespace (§19.6/§8). Sets `revoked_at`
 * — immediately dead at the door, the next call carrying a token for it gets the 401 challenge
 * — and DELETES the provider's `oauthConsent` row for that client, so the client's next attempt
 * walks the consent screen again rather than refreshing silently. Returns `null` when the id
 * names no binding in this namespace (nonexistent and foreign are one answer, so the op layer
 * shows a uniform not-found — the twin §8 pins). Idempotent: revoking a revoked connection
 * keeps the first instant (COALESCE) and still clears any consent, returning success.
 */
export async function revokeConnection(
  ownerId: string,
  id: string,
  now: () => number = Date.now,
): Promise<ConnectionRevoked | null> {
  // deps: D1 `oauth_binding` · D1 `oauthConsent`
  const row = await db()
    .prepare(`SELECT "client_id" FROM oauth_binding WHERE "id" = ? AND "owner_id" = ?`)
    .bind(id, ownerId)
    .first<{ client_id: string }>();
  if (row === null) return null;
  await db()
    .prepare(`UPDATE oauth_binding SET "revoked_at" = COALESCE("revoked_at", ?) WHERE "id" = ?`)
    .bind(now(), id)
    .run();
  // §19.6: a refresh must not resurrect a revoked connection, so the provider's consent goes
  // too — the client re-consents in the owner's browser or gets nothing.
  await db()
    .prepare(`DELETE FROM "oauthConsent" WHERE "clientId" = ? AND "userId" = ?`)
    .bind(row.client_id, ownerId)
    .run();
  return { id, clientId: row.client_id };
}
