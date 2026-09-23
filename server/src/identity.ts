// identity.ts — who is calling, and custody of every credential.
//
// This module owns both ways a request proves itself: better-auth sessions for humans
// (the instantiation, the plugin list — username, twoFactor, passkey (its own package,
// see auth()), deviceAuthorization, bearer, jwt, oauthProvider —
// and every table better-auth manages are hidden here;
// no other module touches better-auth — a page that needs an answer from it asks through
// `callAuth`, or through `callAuthResponse` when the answer is in the headers rather than the
// body, which is that rule as a function rather than as a promise) and our hashed-token
// table for machines.
// Hidden with them: the whole token scheme — minting and matching principal.TOKEN_PREFIX
// (the wire spelling is a leaf so §15's scrubbers can hunt it without importing this), 256-bit
// secrets stored as unsalted SHA-256 (deliberate for high-entropy random secrets; do
// not "fix" into bcrypt), the prefix-dispatch resolution order in which a
// pmcp_-prefixed token never falls through to session lookup, expiry-vs-revocation
// semantics, and the coarse last_used_at stamp — plus the 401-vs-404 anti-enumeration
// matrix for consumer requests, the session-scope guards that keep CLI-sourced
// sessions away from credential management and day-old sessions away from changing a
// credential (decision 39), and the BOOTSTRAP_SECRET behavior of
// /internal/users. Authorization is deliberately absent: what a resolved principal
// may do belongs to registry (grants, roles) and the gateway pipeline.
//
// The door hands back more than a principal. `resolveCaller` answers an AuthenticatedCaller
// whose `credential.reference` contains only the non-secret facts required to reauthorize,
// and `reauthorize` is the ONLY way that reference turns back into authority — the check
// every operation an admitted execution later dispatches must pass again. Both live here
// because one module owning a credential's whole life is the point: an execution plane may
// hold references, never bearers.
//
// Failure convention: identity fails at the HTTP layer, before any JSON-RPC exists —
// its guards throw bare Response objects (401 with WWW-Authenticate, anonymous 404,
// login redirects) that the composition root returns verbatim. HubError never
// originates here; mapping errors into JSON-RPC is the gateway's monopoly.

import { env } from "cloudflare:workers";
import { BASE_ERROR_CODES, betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { jwt } from "better-auth/plugins/jwt";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username as usernamePlugin } from "better-auth/plugins/username";
import { dash } from "@better-auth/infra";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { Hono } from "hono";
import { deleteUser, provisionUser } from "./admin";
import { record } from "./audit";
import { PROTECTED_RESOURCE_PATH, reauthorizeOAuthBinding, resolveOAuthPrincipal } from "./oauth";
import { ADMIN_TOKEN_PREFIX, formatPrincipal, TOKEN_PREFIX } from "./principal";
import type { Principal } from "./principal";
import {
  DEVICE_CODE_TTL_MS,
  AGENT_TOKEN_TTL_MS,
  ADMIN_TOKEN_TTL_MS,
  TOKEN_LAST_USED_STAMP_MS,
} from "./limits";

/** The control plane: identity takes no binding parameter, so it resolves it ambiently.
 *  `D1Like` is workers-env.d.ts's — the binding's shape is declared once, for everyone. */
function db(): D1Like {
  return env.DB as D1Like;
}

/**
 * §2's first rule about what a username may be: `[a-z0-9-]`. It lives beside the module
 * that VALIDATES usernames — better-auth's `usernameValidator` below is the enforcement
 * point — and the door (index.mcpEntry) and admin.provisionUser read this one definition
 * rather than each spelling the class again. §2's other rule, the reserved-segment
 * collision, cannot live here: it derives from the composition root's route table, so it
 * arrives as an argument (bootstrapRoute).
 */
export const USERNAME_CHARSET = /^[a-z0-9-]+$/;

/**
 * §4/§13's password floor, against better-auth's own default of 8. ONE constant for the
 * whole hub: it is what `emailAndPassword.minPasswordLength` is set to below, so it is what
 * refuses a short password, and the Password pane renders its hint from this same export —
 * a second literal anywhere is the drift §4 forbids. `maxPasswordLength` stays better-auth's
 * default; nothing here has a reason to lower a ceiling.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * The ONE better-auth configuration (§4). Read-only session resolution and bootstrap
 * password work share the memoised instance returned by `auth()`; requests entering
 * better-auth's public handler get a fresh instance in `authRoutes()`.
 *
 * That split is deliberate. D12's jwt()+oauthProvider() made construction expensive
 * enough that rebuilding on ordinary page and MCP requests caused Cloudflare Error 1102,
 * while production twice observed a handler instance remain wedged after a two-factor
 * sign-in and then hang every cookie-signing/verifying request until redeploy. A
 * request-scoped handler contains such state to the request that created it; the hot
 * read-only path still pays construction once per isolate.
 *
 * The plugin list is the spec's, passkey included: `@better-auth/passkey` is a separate
 * package 1.7 does not bundle, pinned in lockstep with core. §5's `last_used_at` stamp on
 * a verified assertion is `stampPasskeyUse`, called from the mount's own handler below.
 *
 * `database: env.DB` IS the whole D1 wiring: `@better-auth/kysely-adapter` ships its own
 * D1 dialect and selects it by duck-typing the binding, so no dialect is constructed here
 * and no `kysely-d1` package is needed. The cast exists only because better-auth's
 * `database` option names `D1Database` from `@cloudflare/workers-types`, which this repo
 * deliberately does not install (every binding is `unknown`, index.ts's Env).
 *
 * Two consequences worth knowing before touching anything better-auth writes: values land
 * as SQLite text/integers (dates as ISO-8601 TEXT, booleans as 0/1), and D1 has no
 * interactive transactions, so nothing here may be wrapped in one.
 */
let cachedAuth: ReturnType<typeof buildAuth> | undefined;
function auth() {
  // Built ONCE per isolate for the hot read-only callers below. D12's
  // jwt()+oauthProvider() made each betterAuth() construction ~5.6x heavier
  // (~0.85ms→~4.8ms CPU plus proportional allocation); rebuilding it on most request
  // paths pressured isolates into Cloudflare Error 1102 ("exceeded resource limits").
  // `env` is a per-isolate-stable binding proxy, so capturing it here is correct.
  return (cachedAuth ??= buildAuth());
}

/** The shared betterAuth builder. Keeping its exact return type here lets `cachedAuth`
 * avoid the unassignable generic produced by `database: env.DB as never`. */
function buildAuth() {
  return betterAuth({
    database: env.DB as never,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_ORIGIN,
    // A Worker never phones home: the bundled telemetry is opt-in, and this says so.
    telemetry: { enabled: false },
    // Sign-IN by password, never sign-UP: §12 makes BOOTSTRAP_SECRET-gated
    // POST /internal/users the only way a user is created (§2: "by a repo
    // script"). Without disableSignUp, better-auth's /sign-up/email is live on
    // the same public /api/auth mount and self-provisions a full namespace to
    // any unauthenticated caller — the whole gate, bypassed.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: PASSWORD_MIN_LENGTH },
    // §13's Sessions pane has to tell a CLI session from a browser one, and better-auth
    // stores nothing that does. Written by better-auth alone: `input: false` keeps it off
    // every request body, and the one write that is not the default is the hook below.
    session: { additionalFields: { source: { type: "string", defaultValue: "web", input: false } } },
    // The device flow mints its session inside /device/token's own handler
    // (device-authorization/routes.mjs:455) and better-auth runs that handler inside an
    // endpoint context whose `path` IS the route (api/dispatch.mjs:199), which
    // createSession resolves for the before-hook (db/with-hooks.mjs:6-19). So the one
    // endpoint that mints a CLI session names itself, and nothing is inferred from a
    // header the caller controls. A null context is not an error: createSession is also
    // reached from paths that have none, and there the defaultValue answers.
    databaseHooks: {
      session: {
        create: {
          before: async (_session, context) =>
            context?.path === "/device/token" ? { data: { source: "cli" } } : undefined,
        },
      },
    },
    plugins: [
      // §2's charset, handed to the plugin that would otherwise apply its own (which
      // rejects the hyphen every generated username may carry). One rule for what a
      // username is, spelled where §2 says it: admin.provisionUser writes it, this
      // accepts it. `immutableUsername` because the name, once written, is the namespace
      // (§2) — the mount already refuses `/update-user` outright (REFUSED); this keeps the
      // plugin's own update hook refusing a rename should anything reach it another way.
      usernamePlugin({
        usernameValidator: (name) => USERNAME_CHARSET.test(name),
        immutableUsername: true,
      }),
      // §13's authenticator entry, named by the same decision argued one line below for
      // `passkey({ rpName })`. Without it the `otpauth://` URI falls back to
      // `ctx.context.appName` (two-factor/index.mjs:169), and `betterAuth()` sets no
      // appName — so the owner's authenticator app would list better-auth's default,
      // "Better Auth" (context/create-context.mjs:130), as the account's issuer. Not
      // `betterAuth({ appName })`: that moves every other default reading appName for no gain.
      twoFactor({ issuer: "personal-mcps" }),
      // §4's optional WebAuthn, from its own package pinned in lockstep with core
      // (`@better-auth/passkey@1.7.1`). `origin` is pinned because the plugin's default is
      // the request's own Origin header, and the ceremony verifies the browser's signed
      // origin against exactly this value — it should be the hub's, not the caller's. rpID
      // stays the plugin's default, baseURL's hostname; rpName is what the authenticator
      // prompt shows the owner, and better-auth's default there is better-auth's own name.
      passkey({ rpName: "personal-mcps", origin: env.PUBLIC_ORIGIN }),
      // §13: ~10 minutes, down from better-auth's 30-minute default.
      deviceAuthorization({ expiresIn: `${DEVICE_CODE_TTL_MS / 1000}s` }),
      bearer(),
      // §19.1: jwt() mints the hub-signed access tokens the door verifies against
      // /api/auth/jwks, and oauthProvider() throws `jwt_config` without it. issuer is
      // PUBLIC_ORIGIN so a client reading authorization_servers: [PUBLIC_ORIGIN] probes
      // exactly /.well-known/oauth-authorization-server and the document's own issuer is
      // byte-identical (§19.2). keyPairConfig stays the default EdDSA/Ed25519 — the D12
      // probe confirmed it signs on workerd, so no move to ES256 (§19.3).
      jwt({ jwt: { issuer: env.PUBLIC_ORIGIN } }),
      // §19: the hub as an inbound authorization server. Every option here is pinned by
      // §19.3; nothing else is set, so the provider's own defaults carry the rest — and
      // those defaults ARE §19's requirements: the AS metadata advertises
      // response_types_supported ["code"], response_modes_supported ["query"],
      // code_challenge_methods_supported ["S256"] and
      // authorization_response_iss_parameter_supported true with no option to flip.
      //   · scopes: one functional scope + offline_access (refresh tokens, so a connector
      //     survives access-token expiry); NO openid — a connection is not a login, so no
      //     id_tokens and no /.well-known/openid-configuration to serve.
      //   · DCR on and unauthenticated: the only mechanism both Claude surfaces take with
      //     nothing typed by the owner. A registered client authorizes NOTHING without the
      //     owner signing in and consenting (server-assigned client_id + exact redirect
      //     matching, both §19.3 probe observations, are what make that true).
      //   · loginPage/consentPage: the hub owns every pixel (§19.5); the provider ships none.
      //   · enforcePerClientResources false: the door enforces `aud` once, where the
      //     traffic is, rather than a second weaker copy linked at registration (§19.3).
      oauthProvider({
        scopes: ["mcp", "offline_access"],
        loginPage: "/login",
        consentPage: "/oauth/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // §19.5 step 3: the consent page reads the client's display name through
        // /oauth2/public-client-prelogin, whose own gate is the provider-signed
        // oauth_query. Without this the endpoint 400s before the signature check.
        allowPublicClientPrelogin: true,
        enforcePerClientResources: false,
      }),
      // Dash (better-auth's hosted dashboard) rides ONLY where its key is deployed:
      // the plugin phones home, so dev and tests — where the secret is absent —
      // construct exactly the plugin list above and nothing more.
      ...(env.BETTER_AUTH_API_KEY ? [dash({ apiKey: env.BETTER_AUTH_API_KEY })] : []),
    ],
  });
}

/**
 * The resolved caller identity that every downstream decision keys on — PRODUCED by
 * resolveCaller here, plus §19's one delegated producer: oauth.ts's binding leg, which
 * resolveCredential routes every JWT-shaped bearer through and which yields only
 * `agent` principals (never a user). The type and its canonical string live in
 * principal.ts, a leaf, so a module that only has to name a caller does not inherit
 * better-auth and `cloudflare:workers`; both are re-exported here because this is still
 * where a principal enters the pipeline.
 */
export type { Principal };
export { formatPrincipal };

/**
 * The two machine-credential kinds in the token table. `agent` keys
 * (`pmcp_agt_`) authenticate consumers within grants; `app` keys (`pmcp_app_`)
 * authenticate a tunneled app's reverse connection and nothing else. Kind is
 * checked as a column, never inferred from the prefix alone.
 */
export type TokenKind = "agent" | "app";

/**
 * One row of a token listing — display data only, no secret material beyond the
 * ~12-char `prefix`. `refSlug` names the app/settings the token is bound to (the
 * binding itself is the opaque `refId`). Timestamps are epoch milliseconds;
 * `expiresAt: null` means never expires, `lastUsedAt` is coarse (advanced at most
 * hourly — a rotation signal, not a request log), `revokedAt: null` means live.
 */
export type TokenInfo = {
  id: string;
  kind: TokenKind;
  refId: string;
  refSlug: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

/**
 * The non-secret, serializable facts a caller's later reauthorization is decided from —
 * one member per credential family, each naming only the immutable row ids and expiry
 * facts its family's liveness check re-reads. A reference is what a consumer of
 * `resolveCaller` may hold across an execution's lifetime (the Sandbox coordinator does),
 * so it deliberately carries no bearer, no hash and no signature: authority is re-derived
 * by `reauthorize`, never carried. Units are each source's own — this union records what
 * the row actually stores rather than converting between the three clocks.
 */
export type CredentialReference =
  /**
   * A local `pmcp_agt_` token: the `token` row it hashed to, and the agent row that row's
   * `ref_id` named. Both are re-read (the reference has no FK, so a token can outlive the
   * agent it resolved).
   */
  | { kind: "agentToken"; tokenId: string; agentId: string }
  /**
   * A better-auth bearer session: the `session` row, its `userId` column, and the raw
   * `expiresAt` cell as better-auth's Kysely/D1 adapter stores it — ISO-8601 `DATE` text,
   * decoded with `Date.parse` (a different representation from every epoch-ms integer in
   * this repo, and treated accordingly).
   */
  | { kind: "session"; sessionId: string; userId: string; expiresAt: string }
  /**
   * An OAuth access token: the `oauth_binding` row the door resolved, the agent that row
   * bound, the owner whose namespace the token addressed, and the verified JWT `exp` claim
   * in epoch SECONDS (JWT's own unit — the one expiry the binding row does not carry).
   */
  | { kind: "oauth"; bindingId: string; agentId: string; ownerId: string; expiresAt: number }
  /**
   * An admin token: the `admin_token` row, its owner, and that row's `expires_at` in epoch
   * milliseconds — `null` meaning the token never expires, exactly as §22.1's issuance
   * writes it.
   */
  | { kind: "adminToken"; tokenId: string; ownerId: string; expiresAt: number | null };

/**
 * The resolved caller a consumer request admitted, plus the non-secret credential facts
 * each execution operation rechecks. Runtime isolation is per invocation, so no digest or
 * other stable runtime identity is derived from the bearer.
 */
export type AuthenticatedCaller = {
  principal: Principal;
  credential: {
    reference: CredentialReference;
  };
};

/**
 * Authenticates a consumer request on `/<user>/mcp*` and proves the caller may act
 * in the URL's namespace — the whole §7-step-1 matrix in one call. Bearer-only:
 * session cookies are never consulted (that single rule removes the browser-CSRF
 * surface) and query-string tokens are rejected. Resolution dispatches on prefix:
 * `pmcp_agt_` → token lookup (explicit kind column check; unrevoked, unexpired, live
 * agent row) → agent; `pmcp_app_` → always 401, never a session
 * fallthrough (an app credential means nothing here); `pmcp_adm_` → its own table → admin;
 * a JWT-shaped bearer → the OAuth leg alone, terminally; anything else → better-auth
 * session → user. Failures throw a Response: 401 + `WWW-Authenticate: Bearer` when
 * no valid principal resolves — identical whether or not `<user>` exists — and 404
 * when a *resolved* principal names another user's namespace or a nonexistent one,
 * indistinguishable from route-not-found; neither anonymous probes nor authenticated
 * outsiders can enumerate usernames. Success coarsely stamps the token's
 * last_used_at. Transport hygiene (Content-Type, Origin-if-present) is the gateway's
 * job, not this function's.
 *
 * The answer's `credential` is produced here and nowhere else: the bearer is read once,
 * resolved to a non-secret reference, and never retained, returned or logged.
 * `now` is the injected clock (epoch ms) every expiry judgment and last_used_at
 * stamp reads — same rationale as ApprovalsConfig.now: workerd tests cannot fake
 * global timers, and the expired-token refusal must be seedable beside its live
 * twin. Production callers omit it.
 */
export async function resolveCaller(req: Request, now?: () => number): Promise<AuthenticatedCaller> {
  // deps: better-auth · oauth.resolveOAuthPrincipal · D1 `token` · D1 `agent` · D1 `user` · crypto.subtle
  // Credential FIRST, namespace second — that order IS the anti-enumeration rule: an
  // unauthenticated probe never reaches a lookup that could answer differently for a
  // username that exists, so its 401 is the same 401 either way. The namespace is read once,
  // here: the OAuth leg checks the token's `aud` against it (§19.6), and the 401 challenge
  // names its per-namespace resource_metadata (§19.2) — both from the path, never a lookup.
  const namespace = namespaceOf(req);
  const presented = bearerToken(req);
  if (presented === null) throw unauthorized(namespace);
  const resolved = await resolveCredential(presented, now ?? Date.now, namespace);
  if (resolved === null) throw unauthorized(namespace);
  const owner = await ownerIdFor(namespace);
  // One `throw` for "the namespace is someone else's" and "the namespace is nobody's":
  // a resolved caller learns only that there is nothing here for them.
  if (owner === null || owner !== namespaceIdOf(resolved.principal)) throw anonymousNotFound();
  return {
    principal: resolved.principal,
    credential: { reference: resolved.reference },
  };
}

/**
 * Re-authorizes a credential resolved earlier against live state, from its non-secret
 * `CredentialReference` alone — the check every operation an admitted execution later
 * dispatches passes again, and the reason a revocation, expiry, deletion or rebinding bites
 * mid-execution even though the credential itself is long gone from memory.
 *
 * Answers the CURRENT principal the credential names, or `null` for every refusal; callers
 * compare `principalKey` against the key they admitted, so a reference that was rebound to
 * another agent or user answers null rather than that other principal. Read-only by design:
 * nothing here stamps `last_used_at`, refreshes a session or touches better-auth's
 * `updateAge`, so a liveness check can never silently renew what it checks — and absence,
 * expiry, revocation and a missing joined referent are one answer, exactly like the door's.
 *
 * `now` is the injected clock (epoch ms) every expiry judgment reads, the same seam
 * `resolveCaller` carries; production callers omit it.
 */
export async function reauthorize(reference: CredentialReference, now?: () => number): Promise<Principal | null> {
  // deps: D1 `token` · D1 `agent` · D1 `admin_token` · D1 `user` · D1 `session` · oauth.reauthorizeOAuthBinding
  const at = now ?? Date.now;
  switch (reference.kind) {
    case "agentToken":
      return reauthorizeAgentToken(reference, at);
    case "session":
      return reauthorizeSession(reference, at);
    case "oauth":
      return reauthorizeOAuthBinding(reference, at);
    case "adminToken":
      return reauthorizeAdminToken(reference, at);
  }
}

/**
 * The `pmcp_agt_` family's reauthorization: the `token` row must still exist, still be kind
 * `agent`, still be unrevoked and unexpired, and still name the agent the reference
 * captured — that last comparison is what refuses a token row repointed at another agent
 * (no production path rewrites `ref_id`, but a reference that followed one would otherwise
 * hand out another principal's key). The agent row must still exist; its fresh slug is what
 * the answer carries, exactly as the original resolve read it.
 */
async function reauthorizeAgentToken(
  reference: Extract<CredentialReference, { kind: "agentToken" }>,
  now: () => number,
): Promise<Principal | null> {
  const row = await db()
    .prepare(`SELECT "id", "kind", "ref_id", "expires_at", "revoked_at" FROM token WHERE "id" = ?`)
    .bind(reference.tokenId)
    .first<Omit<TokenRow, "last_used_at">>();
  if (row === null || row.kind !== "agent" || row.revoked_at != null) return null;
  if (row.ref_id !== reference.agentId) return null;
  if (row.expires_at != null && row.expires_at <= now()) return null;
  const agent = await db()
    .prepare(`SELECT "id", "owner_id", "slug" FROM agent WHERE "id" = ?`)
    .bind(reference.agentId)
    .first<{ id: string; owner_id: string; slug: string }>();
  if (agent === null) return null;
  return { kind: "agent", agentId: agent.id, ownerId: agent.owner_id, slug: agent.slug };
}

/**
 * The session family's reauthorization: the `session` row must still exist, still belong to
 * the captured `userId` (a row repointed at another user is a rebinding, refused), and its
 * `expiresAt` — ISO-8601 `DATE` text, decoded by `sessionExpiryInstant` — must still name
 * an instant in the future. The joined `user` row is read fresh: absence is account
 * deletion, which this repo's cascades usually make unreachable, and a username-less row
 * names nobody. The ROW's expiry is the authority, not the reference's copy of it:
 * better-auth legitimately pushes `expiresAt` forward on activity, and this read must not
 * (and does not) trigger that refresh itself.
 */
async function reauthorizeSession(
  reference: Extract<CredentialReference, { kind: "session" }>,
  now: () => number,
): Promise<Principal | null> {
  const row = await db()
    .prepare(
      `SELECT s."userId" AS user_id, s."expiresAt" AS expires_at, u."username" AS username
         FROM "session" s JOIN "user" u ON u."id" = s."userId"
        WHERE s."id" = ?`,
    )
    .bind(reference.sessionId)
    .first<{ user_id: string; expires_at: string | null; username: string | null }>();
  if (row === null || row.user_id !== reference.userId) return null;
  const expiresAt = sessionExpiryInstant(row.expires_at);
  if (expiresAt === null || expiresAt <= now()) return null;
  if (row.username === null || row.username === "") return null;
  return { kind: "user", userId: row.user_id, username: row.username };
}

/**
 * The `pmcp_adm_` family's reauthorization: the `admin_token` row must still exist,
 * unrevoked, under the same owner, with the same `expires_at` it had at admission, and its
 * owning `user` row must still exist. No production path rewrites an admin token's owner or
 * expiry, so inequality is a rewritten row — a rebinding — and failing closed is the only
 * safe reading of one.
 */
async function reauthorizeAdminToken(
  reference: Extract<CredentialReference, { kind: "adminToken" }>,
  now: () => number,
): Promise<Principal | null> {
  const row = await db()
    .prepare(`SELECT "id", "owner_id", "expires_at", "revoked_at" FROM admin_token WHERE "id" = ?`)
    .bind(reference.tokenId)
    .first<Omit<AdminTokenRow, "last_used_at">>();
  if (row === null || row.revoked_at != null || row.owner_id !== reference.ownerId) return null;
  if (row.expires_at !== reference.expiresAt) return null;
  if (row.expires_at != null && row.expires_at <= now()) return null;
  const user = await db()
    .prepare(`SELECT "id", "username" FROM "user" WHERE "id" = ?`)
    .bind(row.owner_id)
    .first<{ id: string; username: string }>();
  if (user === null) return null;
  return { kind: "admin", userId: user.id, username: user.username };
}

/** What every credential leg answers: the principal, and the reference that re-authorizes
 *  it. One shape for all four legs, so the door and `/api/whoami` cannot drift. */
type ResolvedCredential = { principal: Principal; reference: CredentialReference };

/**
 * §7 step 1's resolution proper, with no namespace judgment: the prefix dispatch, and
 * nothing else. Shared by resolveCaller — which adds the namespace judgment and the
 * credential half — and by `/api/whoami`, whose URL carries no namespace to add (§8:
 * "Resolution mirrors §7 step 1"). Answers null for every way a request fails to name
 * somebody, so no caller can accidentally tell two failures apart.
 *
 * `namespace` is the addressed username on `/<user>/mcp*` and `null` on the namespaceless
 * `/api/whoami` — the OAuth leg (§19.6) needs it to bind a token's audience, so where there
 * is no namespace a JWT-shaped bearer names nobody and is refused without either leg running.
 */
async function resolveCredential(
  presented: string,
  now: () => number,
  namespace: string | null,
): Promise<ResolvedCredential | null> {
  // An app credential means nothing on a consumer surface, and — the mutation this
  // guards against — a `pmcp_`-prefixed token whose lookup MISSES must not fall through
  // to the session lookup below either. Both prefixes answer here, whatever the row says.
  if (presented.startsWith(TOKEN_PREFIX.app)) return null;
  if (presented.startsWith(TOKEN_PREFIX.agent)) {
    return agentFor(presented, now);
  }
  // §22.1: the admin-token family's own table, checked by its own prefix — never a third
  // `token.kind`. Like the two legs above, a `pmcp_adm_` bearer whose lookup MISSES
  // answers null here rather than falling through to a session lookup.
  if (presented.startsWith(ADMIN_TOKEN_PREFIX)) {
    return adminFor(presented, now);
  }
  // §19.6: a JWT-shaped bearer is a credential regime of its own — answered by the OAuth
  // leg ALONE, and that leg is TERMINAL. Whatever it fails on (bad signature, wrong issuer
  // or audience, expired, missing `mcp` scope, no binding, revoked, deleted agent), the
  // answer is `null` and control NEVER reaches the session lookup below — a fall-through
  // would promote a refused token to the OWNER, the exact §18-decision-23 inversion §19.6
  // step 3 forbids. Fail closed by STRUCTURE: every OAuth outcome returns from this branch.
  if (isJwtShaped(presented)) {
    if (namespace === null) return null;
    const leg = await resolveOAuthPrincipal(presented, namespace, now);
    return leg === null
      ? null
      : {
          principal: leg.principal,
          reference: {
            kind: "oauth",
            bindingId: leg.bindingId,
            agentId: leg.principal.agentId,
            ownerId: leg.principal.ownerId,
            expiresAt: leg.expiresAt,
          },
        };
  }
  return sessionUserFor(presented);
}

/**
 * §19.6's predicate, pinned at the byte level: a bearer is JWT-shaped when it is EXACTLY
 * three non-empty `.`-separated segments, each drawn from the base64url alphabet. It routes
 * between two credential regimes — the OAuth leg above and the session lookup below — so
 * nothing looser will do ("contains a dot", "decodes to JSON"); a fuzzy version of it is a
 * way to route a credential into the wrong regime. A `pmcp_`-prefixed token never reaches
 * here (the prefixes answer first), and a better-auth session token is one segment, so the
 * two live credentials this predicate must not misroute both fall on the correct side of it.
 */
function isJwtShaped(bearer: string): boolean {
  const segments = bearer.split(".");
  return segments.length === 3 && segments.every((segment) => JWT_SEGMENT.test(segment));
}

/** One base64url segment: non-empty (`+`), and nothing outside `[A-Za-z0-9_-]`. */
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The `pmcp_agt_` leg: the token row must be of kind `agent` BY COLUMN,
 * unrevoked and unexpired, and its `ref_id` must still resolve to a live agent row
 * (§5 gives that reference no FK, so a deleted agent leaves the token dangling —
 * a live credential for nobody, which is nobody). The reference captures the row and the
 * agent it named; both are what `reauthorizeAgentToken` re-checks later.
 */
async function agentFor(presented: string, now: () => number): Promise<ResolvedCredential | null> {
  const row = await db()
    .prepare(
      `SELECT "id", "kind", "ref_id", "expires_at", "last_used_at", "revoked_at"
         FROM token WHERE "hash" = ?`,
    )
    .bind(await sha256Hex(presented))
    .first<TokenRow>();
  if (row === null || row.kind !== "agent" || row.revoked_at != null) return null;
  const at = now();
  if (row.expires_at != null && row.expires_at <= at) return null;
  const agent = await db()
    .prepare(`SELECT "id", "owner_id", "slug" FROM agent WHERE id = ?`)
    .bind(row.ref_id)
    .first<{ id: string; owner_id: string; slug: string }>();
  if (agent === null) return null;
  await stampLastUsed(row, at);
  return {
    principal: { kind: "agent", agentId: agent.id, ownerId: agent.owner_id, slug: agent.slug },
    reference: { kind: "agentToken", tokenId: row.id, agentId: agent.id },
  };
}

/**
 * The `pmcp_adm_` leg (§22.1): its own table, its own hash lookup — never `token`'s,
 * never gated by a `kind` column, because there is no polymorphic referent to check.
 * Unrevoked and unexpired, and the owning `user` row must still exist (§22.1's
 * `ON DELETE CASCADE` means it normally will not linger dangling the way an agent's
 * FK-less `ref_id` can, but a row read mid-delete is still handled the same way every
 * other dangling-referent lookup here is: null, not a crash). Resolves to the SAME
 * shape a session yields — `formatPrincipal`/`principalKey` are deliberately blind to
 * which of the two produced it — tagged `admin` so authorization (index.visibleOnScoped,
 * registry.resolveAccess, admin.adminOpsFor) can still tell them apart where it matters.
 * The reference captures the row, its owner and its expiry, which is everything
 * `reauthorizeAdminToken` re-checks.
 */
async function adminFor(presented: string, now: () => number): Promise<ResolvedCredential | null> {
  const row = await db()
    .prepare(
      `SELECT "id", "owner_id", "expires_at", "last_used_at", "revoked_at"
         FROM admin_token WHERE "hash" = ?`,
    )
    .bind(await sha256Hex(presented))
    .first<AdminTokenRow>();
  if (row === null || row.revoked_at != null) return null;
  const at = now();
  if (row.expires_at != null && row.expires_at <= at) return null;
  const user = await db()
    .prepare(`SELECT "id", "username" FROM "user" WHERE id = ?`)
    .bind(row.owner_id)
    .first<{ id: string; username: string }>();
  if (user === null) return null;
  await stampAdminTokenLastUsed(row, at);
  return {
    principal: { kind: "admin", userId: user.id, username: user.username },
    reference: {
      kind: "adminToken",
      tokenId: row.id,
      ownerId: row.owner_id,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * The fall-through leg: better-auth's own session lookup, riding §4's `bearer()` plugin.
 * The Authorization header is rebuilt into a bare Headers rather than passed through,
 * because better-auth would happily read a Cookie from the original — and on `/<user>/mcp*`
 * a cookie is never a credential (§7 step 1, the whole browser-CSRF surface).
 *
 * The session row's `expiresAt` is captured as the ISO-8601 text the Kysely/D1 adapter
 * stores (`Date.toISOString()` on write, `new Date(...)` on read — so the round trip is
 * the row's own bytes), NOT as an epoch-ms integer: `reauthorizeSession` decodes exactly
 * that text, and a representation that silently became a number would fail its parse
 * closed rather than compare the wrong clock. The row may be refreshed by better-auth on
 * activity after this point; the reference records admission's value, and reauthorization
 * reads the row.
 */
async function sessionUserFor(presented: string): Promise<ResolvedCredential | null> {
  const session = await auth().api.getSession({
    headers: new Headers({ authorization: `Bearer ${presented}` }),
  });
  const user = session?.user as { id: string; username?: string | null } | undefined;
  const row = session?.session as
    | { id?: string; userId?: string; expiresAt?: Date | string }
    | undefined;
  if (!user?.username || !row?.id || !row.userId) return null;
  const expiresAt =
    row.expiresAt instanceof Date
      ? row.expiresAt.toISOString()
      : typeof row.expiresAt === "string"
        ? row.expiresAt
        : null;
  if (expiresAt === null) return null;
  return {
    principal: { kind: "user", userId: user.id, username: user.username },
    reference: { kind: "session", sessionId: row.id, userId: row.userId, expiresAt },
  };
}

/**
 * The absolute instant a better-auth `session.expiresAt` cell names, from the ISO-8601
 * `DATE` text the adapter stores. `null` for an absent cell or text `Date.parse` cannot
 * read — a representation the adapter never writes, and every caller treats a refusal as
 * revocation rather than guessing an instant.
 */
function sessionExpiryInstant(raw: string | null): number | null {
  if (raw === null) return null;
  const instant = Date.parse(raw);
  return Number.isFinite(instant) ? instant : null;
}

/** The namespace a consumer request addresses: the first path segment of `/<user>/mcp*`. */
function namespaceOf(req: Request): string {
  return decodeURIComponent(new URL(req.url).pathname.split("/")[1] ?? "");
}

/** The namespace a resolved principal lives in — its owner's user id, every kind. */
function namespaceIdOf(p: Principal): string {
  return p.kind === "agent" ? p.ownerId : p.userId;
}

/** The user id behind a username, or null when no such user exists. */
async function ownerIdFor(name: string): Promise<string | null> {
  if (name === "") return null;
  const row = await db()
    .prepare(`SELECT "id" FROM "user" WHERE "username" = ?`)
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The 401 every unresolved consumer request gets, with the `WWW-Authenticate` challenge §7
 * step 1 attaches to the surface (and §18 decision 13 kept as the OAuth-discovery upgrade
 * path, now realized by §19). One builder, so the row on an existing username and the row on
 * an absent one are the same bytes — which is the property, not the status.
 *
 * `namespace` is the addressed username on `/<user>/mcp*`, and absent on the surfaces that
 * are not MCP resources (`/api/whoami`, §8; the composition root's transport-hygiene
 * refusals). See `challengeFor` for what each spells.
 */
export function unauthorized(namespace?: string): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": challengeFor(namespace),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * The `WWW-Authenticate` value, per surface (§19.2/§19.8). With a namespace it is the §19.2
 * discovery challenge: `error="invalid_token"`, the per-namespace `resource_metadata` (the
 * PRM a client fetches to find the authorization server), and the one functional `scope`.
 * The namespace comes from the request PATH and is looked up NOWHERE — so the challenge is
 * the same bytes whether that namespace exists or not (§19.8's anti-enumeration property),
 * and the only thing that varies between two challenges is the username the caller itself
 * named in the URL. That segment is already known to be `[a-z0-9-]` — the composition root
 * refused anything else with the anonymous 404 before the door ran — so no unvalidated text
 * reaches this header (§19.2's ordering property, the reason this is not a header-injection
 * surface). Without a namespace the answer is the bare `Bearer`: `/api/whoami` is not an MCP
 * resource and has no metadata to name (§8).
 */
function challengeFor(namespace?: string): string {
  if (namespace === undefined || namespace === "") return "Bearer";
  const resourceMetadata = `${env.PUBLIC_ORIGIN}${PROTECTED_RESOURCE_PATH.replace(":user", namespace)}`;
  return `Bearer error="invalid_token", resource_metadata="${resourceMetadata}", scope="mcp"`;
}

/**
 * The hub's ONE 404: served for a foreign or absent namespace, for an app a caller
 * holds no grants on, for the bootstrap route while its secret is unset — and by the
 * composition root for any unrouted path. Sharing the builder is what makes
 * "indistinguishable from route-not-found" true byte for byte rather than by intent.
 */
export function anonymousNotFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Validates the `pmcp_app_` bearer on the /connect WebSocket upgrade — the only
 * surface where an app token means anything. Returns the token's bound app id
 * (the DO addressing key) and the token ROW's id — §8's `onlyIfTokenId` rule needs the
 * latter, and answering it here is what keeps the plaintext, and the hashing scheme that
 * finds the row, from having a second custody site outside this module (§15). Null for
 * anything less than a fully valid credential:
 * missing/foreign prefix, unknown token, wrong kind, revoked, or expired —
 * one answer, so the upgrade's 401 leaks nothing about which check failed. Expiry is
 * judged here, at upgrade time only: an established socket outlives its token's
 * expires_at until the next reconnect (revocation is the immediate path, and
 * severing a live socket on revoke is the admin op's cascade, never this
 * function's). Row-level verdicts stay with the upgrade handler, which fetches the
 * app anyway: row gone or kind proxy → 401, archived → 403. Success coarsely
 * stamps last_used_at. `now` is the injected clock (see resolveCaller);
 * production callers omit it.
 */
export async function resolveAppToken(
  req: Request,
  now: () => number = Date.now,
): Promise<{ appId: string; tokenId: string } | null> {
  // deps: D1 `token` · crypto.subtle
  // One `return null` vocabulary and no thrown error: nothing below distinguishes which
  // check failed, so the upgrade's 401 cannot either. The query-string case needs no
  // clause of its own — the header is the only place a credential is read from.
  const presented = bearerToken(req);
  if (presented === null || !presented.startsWith(TOKEN_PREFIX.app)) return null;
  const row = await db()
    .prepare(
      `SELECT "id", "kind", "ref_id", "expires_at", "last_used_at", "revoked_at"
         FROM token WHERE "hash" = ?`,
    )
    .bind(await sha256Hex(presented))
    .first<TokenRow>();
  if (row === null) return null;
  // kind from the COLUMN, never the prefix (§6): the two can disagree.
  if (row.kind !== "app") return null;
  if (row.revoked_at != null) return null;
  const at = now();
  if (row.expires_at != null && row.expires_at <= at) return null;
  await stampLastUsed(row, at);
  return { appId: row.ref_id, tokenId: row.id };
}

/** The `token` columns every resolve reads — snake_case, as the table spells them. */
type TokenRow = {
  id: string;
  kind: TokenKind;
  ref_id: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

/** The `admin_token` columns every resolve reads — snake_case, as the table spells them.
 *  No `kind`, no `ref_id`: the table's whole point is that it needs neither (§22.1). */
type AdminTokenRow = {
  id: string;
  owner_id: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

/**
 * How much of the token the listing shows: §5's "first ~12 chars" — enough to tell two
 * live credentials apart in `token_list`, far short of guessing either. An
 * approximation in the spec, so it is a local detail rather than a limits.ts constant.
 */
const PREFIX_DISPLAY_LENGTH = 12;

/** `Authorization: Bearer <token>`, or null. The only transport a credential arrives on. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}


/**
 * Unsalted SHA-256, lowercase hex — deliberate for 256-bit random secrets (§4: do not
 * "fix" this into bcrypt); the plaintext never returns.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A length-independent comparison for the §12 master key: every byte of both strings is
 * read whichever way the answer goes, so a wrong secret's refusal time says nothing about
 * how much of it was right.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Length itself is not secret (and cannot be hidden by any comparison), but the loop
  // below must still run over a fixed span, so it walks the longer of the two.
  let diff = left.length ^ right.length;
  const span = Math.max(left.length, right.length);
  for (let i = 0; i < span; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** 256 CSPRNG bits, base64url — the whole entropy of a credential (§4). */
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The coarse last-used stamp (§5): advanced at most once per
 * limits.TOKEN_LAST_USED_STAMP_MS, so a busy credential costs one write an hour rather
 * than one per request. Only a SUCCESSFUL resolve reaches here.
 */
async function stampLastUsed(row: Pick<TokenRow, "id" | "last_used_at">, at: number): Promise<void> {
  if (row.last_used_at != null && at - row.last_used_at < TOKEN_LAST_USED_STAMP_MS) return;
  await db().prepare(`UPDATE token SET "last_used_at" = ? WHERE "id" = ?`).bind(at, row.id).run();
}

/** The same coarse stamp as stampLastUsed, over `admin_token` rather than `token` — its
 *  own table, so its own write (§22.1). */
async function stampAdminTokenLastUsed(row: Pick<AdminTokenRow, "id" | "last_used_at">, at: number): Promise<void> {
  if (row.last_used_at != null && at - row.last_used_at < TOKEN_LAST_USED_STAMP_MS) return;
  await db().prepare(`UPDATE admin_token SET "last_used_at" = ? WHERE "id" = ?`).bind(at, row.id).run();
}

/**
 * §5's `passkey.last_used_at` — the hub's ONE extension to better-auth's tables
 * (migration 0002), stamped after an assertion verifies. Keyed by the CREDENTIAL id the
 * assertion itself names rather than by the user: an owner with two passkeys is entitled
 * to see which of them signed them in. Unstamped by design when the id matches no row —
 * an assertion that verified names a row that exists, and a stamp is not worth a throw.
 *
 * `now` is injected because the value written is the whole observable: a caller that
 * cannot say when cannot check what was written.
 */
export async function stampPasskeyUse(
  credentialId: string,
  now: () => number = Date.now,
): Promise<void> {
  // deps: D1 `passkey`
  await db()
    .prepare(`UPDATE "passkey" SET "last_used_at" = ? WHERE "credentialID" = ?`)
    .bind(now(), credentialId)
    .run();
}

/**
 * The same column, read for one owner's passkeys and keyed by the row id the plugin's
 * listing shows. It is read HERE rather than off that listing because the column is ours
 * and the plugin's schema does not declare it — better-auth's `mergeSchema` renames
 * declared fields and cannot add one, so its adapter returns the columns it knows and no
 * others. Absent means never used; the page renders that as its own words.
 */
export async function passkeyLastUsed(userId: string): Promise<Record<string, number>> {
  // deps: D1 `passkey`
  const { results } = await db()
    .prepare(
      `SELECT "id", "last_used_at" FROM "passkey"
        WHERE "userId" = ? AND "last_used_at" IS NOT NULL`,
    )
    .bind(userId)
    .all<{ id: string; last_used_at: number }>();
  return Object.fromEntries(results.map((row) => [row.id, row.last_used_at]));
}

/**
 * The plugin's own AAGUID → authenticator-name table ("iCloud Keychain", "Google Password
 * Manager", …), re-exported because §4 gives this module sole custody of better-auth and
 * its packages: the model's `passkeyRow` names an unnamed credential with it and imports it
 * from HERE, beside `passkeyLastUsed`, rather than reaching into `@better-auth/passkey`.
 * A pure lookup — no state, no I/O — so re-exporting the plugin's function is the whole of it.
 */
export { getAuthenticatorName } from "@better-auth/passkey";

/**
 * The ownership test both listTokens and revokeToken key on: `token.ref_id` has no
 * foreign key (§5), so a token belongs to a namespace only through the app or
 * agent row its kind names. A token whose referent is gone belongs to nobody
 * and appears nowhere — which is also why deleteTokensFor exists.
 *
 * ONE placeholder, deliberately: the fragment's internals are not caller knowledge, so
 * neither call site counts `?`s in a string declared far away, and adding a third
 * referent kind — the obvious future edit — is an edit HERE alone rather than a silent
 * re-pairing of somebody else's positional binds.
 */
const OWNED_BY = `? IN (
    SELECT s.owner_id FROM app s
     WHERE token."kind" = 'app' AND s.id = token."ref_id"
    UNION ALL
    SELECT a.owner_id FROM agent a
     WHERE token."kind" = 'agent' AND a.id = token."ref_id")`;

/**
 * A resolved cookie session: the signed-in owner plus the session's stable
 * identifier. `sessionId` is what session-BOUND flows key on — the upstream
 * OAuth state rows bind to it so only the initiating browser session can
 * complete a connect (§7). It is an opaque identifier, never the cookie value.
 */
export type OwnerSession = {
  user: Extract<Principal, { kind: "user" }>;
  sessionId: string;
};

/**
 * The session gate's DECISION, without its consequence: resolves the cookie session to
 * the signed-in owner, or `null` where `requireOwnerSession` would have redirected. It
 * exists because the JSON API under /api answers an absent session with a 401 body while
 * a page answers it with a 302 to /login — one rule, two carriers, so the rule is written
 * once here and each caller supplies its own refusal.
 *
 * Two guards ride along: a session minted by the device flow (bearer-sourced) never
 * qualifies, even replayed as a cookie — a stolen CLI token must not reach credential
 * management and become persistent takeover — and with `recent: true` (the /settings
 * routes) the session must also carry recent authentication. Never reads Authorization
 * headers.
 */
export async function resolveOwnerSession(
  req: Request,
  opts?: { recent?: boolean },
): Promise<OwnerSession | null> {
  // deps: better-auth
  // Cookie ONLY, rebuilt into a bare Headers: an Authorization header on a web route is
  // not a credential here, and this is where "bearer-sourced sessions are rejected"
  // becomes structural rather than a check. It holds for the device flow because the
  // hub never hands a browser cookie out for one — /device/token answers with a bearer
  // token and no Set-Cookie — and better-auth's session cookie is SIGNED, so a stolen
  // CLI token replayed as a raw cookie value resolves to nobody.
  const cookie = req.headers.get("Cookie");
  const session = cookie === null
    ? null
    : await auth().api.getSession({ headers: new Headers({ cookie }) });
  const user = session?.user as { id: string; username?: string | null } | undefined;
  if (!session || !user?.username) return null;
  if (opts?.recent && !(await isRecentAuth(session.session.createdAt))) return null;
  return {
    user: { kind: "user", userId: user.id, username: user.username },
    sessionId: session.session.id,
  };
}

/**
 * The gate on every cookie-session PAGE surface (/apps, /approvals, /audit, /settings,
 * the upstream-OAuth callback): `resolveOwnerSession`'s answer, with a thrown Response
 * that sends the browser through /login in place of a null. Callers rely on the
 * rejection, not a return value, so the throw is the contract and not an error path.
 */
export async function requireOwnerSession(
  req: Request,
  opts?: { recent?: boolean },
): Promise<OwnerSession> {
  // deps: resolveOwnerSession
  const session = await resolveOwnerSession(req, opts);
  if (session === null) throw loginRedirect(req);
  return session;
}

/**
 * "Recent authentication" is better-auth's own session freshness — `createdAt` inside the
 * configured `freshAge`, the same window it guards its own sensitive endpoints with.
 * Deliberately not a second window of ours: two answers to "is this session fresh enough"
 * is one more than the system can keep consistent. The hub's `recent: true` gate and the
 * mount's FRESH_REQUIRED guard (decision 39) both ask here.
 */
async function isRecentAuth(createdAt: Date | string): Promise<boolean> {
  const freshAgeSeconds = (await auth().$context).sessionConfig.freshAge;
  if (freshAgeSeconds === 0) return true; // freshness disabled, better-auth's own escape
  return Date.now() - new Date(createdAt).getTime() < freshAgeSeconds * 1000;
}

/**
 * The web surfaces' refusal (§13): a browser is sent to sign in, carrying where it was
 * going so the page it wanted survives the round trip. Never a 401 — a human with an
 * expired session is not an API client with a bad token.
 */
function loginRedirect(req: Request): Response {
  const { pathname, search } = new URL(req.url);
  return new Response(null, {
    status: 302,
    headers: { Location: `/login?next=${encodeURIComponent(pathname + search)}` },
  });
}

/**
 * Mints a credential and returns its plaintext exactly once — never recoverable
 * afterwards, through any surface.
 * `expiresIn` is seconds; `"never"` disables expiry. Defaults differ by kind and are
 * the point: agent tokens 90 days (they get pasted into agent configs),
 * app tokens no expiry (bots on home servers must not silently die; revoke on
 * compromise). Trusts `refId`: resolving slugs, refusing the reserved `pmcp` slug,
 * and rejecting app tokens on proxied apps are the admin op's validations.
 * The returned `id` is the handle for revokeToken and the row listTokens shows.
 * `now` is the injected clock stamping created_at/expires_at (see
 * resolveCaller) — issuing at a fake t0 and resolving past t0+expiry is how the
 * expired-refusal row gets its live allow-twin without sleeping or a test-only
 * "mint dead token" affordance. Production callers omit it.
 */
export async function issueToken(
  input: {
    kind: TokenKind;
    refId: string;
    expiresIn?: number | "never";
  },
  now: () => number = Date.now,
): Promise<{ id: string; token: string }> {
  // deps: D1 `token` · crypto.getRandomValues · crypto.subtle
  const createdAt = now();
  const id = crypto.randomUUID();
  const token = TOKEN_PREFIX[input.kind] + randomSecret();
  await db()
    .prepare(
      `INSERT INTO token ("id", "kind", "ref_id", "hash", "prefix", "expires_at", "created_at")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.kind,
      input.refId,
      await sha256Hex(token),
      token.slice(0, PREFIX_DISPLAY_LENGTH),
      expiryFor(input.kind, input.expiresIn, createdAt),
      createdAt,
    )
    .run();
  // The one and only time the plaintext exists outside the caller's hand.
  return { id, token };
}

/**
 * §5/§18 decision 12: an absent `expiresIn` means the kind's default — 90 days for the
 * keys pasted into agent configs, none at all for the bot on a home server. `"never"`
 * and an explicit count each override it, in both directions.
 */
function expiryFor(
  kind: TokenKind,
  expiresIn: number | "never" | undefined,
  createdAt: number,
): number | null {
  if (expiresIn === "never") return null;
  if (expiresIn !== undefined) return createdAt + expiresIn * 1000;
  return kind === "agent" ? createdAt + AGENT_TOKEN_TTL_MS : null;
}

/**
 * Every token in the namespace, newest first — live, expired, and revoked rows
 * alike, because rotation state is what the listing is for (prefix plus coarse
 * lastUsedAt shows which token a bot is actually on). Ownership is resolved through
 * each token's referenced app/settings row; tokens whose referent is gone are
 * already deleted (deleteTokensFor) and never appear.
 */
export async function listTokens(ownerId: string): Promise<TokenInfo[]> {
  // deps: D1 `token` · D1 `app` · D1 `agent`
  const { results } = await db()
    .prepare(`${TOKEN_READ} ORDER BY token."created_at" DESC`)
    .bind(ownerId)
    .all<TokenListRow>();
  return results.map(toTokenInfo);
}

/**
 * ONE token in `ownerId`'s namespace, by the id `token_list` reports — or null when the
 * id names none, or one outside the namespace (the two are one answer, as everywhere
 * here). Exists because every caller that wants one row wants exactly what the listing
 * shows for it: the display prefix and the resolved expiry are decisions made once, in
 * the shape below, and a caller scanning listTokens to find a single row is paying for
 * the whole namespace to re-derive them.
 */
export async function tokenFor(ownerId: string, id: string): Promise<TokenInfo | null> {
  // deps: D1 `token` · D1 `app` · D1 `agent`
  const row = await db()
    .prepare(`${TOKEN_READ} AND token."id" = ?`)
    .bind(ownerId, id)
    .first<TokenListRow>();
  return row === null ? null : toTokenInfo(row);
}

/**
 * How many token rows are bound to this app or agent id — what the deleting
 * cascades report about what they removed. Keyed by REFERENT, exactly like
 * deleteTokensFor, so "how many will go" and "which go" cannot answer differently.
 */
export async function countTokensFor(refId: string): Promise<number> {
  // deps: D1 `token`
  const row = await db()
    .prepare(`SELECT COUNT(*) AS n FROM token WHERE "ref_id" = ?`)
    .bind(refId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The read behind every token surface: the joins exist for the SLUG, and ownership is
 * OWNED_BY's one rule — which is also what keeps a token whose referent is gone out of
 * every answer. Callers append their own ordering or their own `AND`, in that order of
 * binds (ownerId first).
 */
const TOKEN_READ = `SELECT token."id", token."kind", token."ref_id", token."prefix", token."created_at",
              token."expires_at", token."last_used_at", token."revoked_at",
              COALESCE(app.slug, agent.slug) AS ref_slug
         FROM token
         LEFT JOIN app ON token."kind" = 'app' AND app.id = token."ref_id"
         LEFT JOIN agent ON token."kind" = 'agent' AND agent.id = token."ref_id"
        WHERE ${OWNED_BY}`;

type TokenListRow = TokenRow & { prefix: string; created_at: number; ref_slug: string };

function toTokenInfo(row: TokenListRow): TokenInfo {
  return {
    id: row.id,
    kind: row.kind,
    refId: row.ref_id,
    refSlug: row.ref_slug,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

/**
 * Revokes one token: immediately dead on every consumer surface — the next request
 * carrying it gets 401. Returns false when `id` names no token inside `ownerId`'s
 * namespace (nonexistent and foreign are one answer, so the op layer shows a uniform
 * not-found). Idempotent: revoking a revoked token returns true and changes nothing.
 * Never touches live sockets — closing a tunneled app's connection when its
 * token is revoked (close 4001) is the admin op's cascade.
 */
export async function revokeToken(ownerId: string, id: string): Promise<boolean> {
  // deps: D1 `token` · D1 `app` · D1 `agent`
  // COALESCE keeps the FIRST revocation's instant, so a re-revoke changes nothing while
  // still matching the row — which is exactly the idempotent `true`. A row outside the
  // namespace matches nothing, indistinguishably from one that does not exist.
  const { meta } = await db()
    .prepare(`UPDATE token SET "revoked_at" = COALESCE("revoked_at", ?)
               WHERE "id" = ? AND ${OWNED_BY}`)
    .bind(Date.now(), id, ownerId)
    .run();
  return meta.changes > 0;
}

// ── §22.1: the admin_token family — its own table, no referent, no `kind` column ───────

/**
 * One row of an admin-token listing (§22.1) — no `kind`, no referent: the row itself IS
 * the credential, scoped to its owner alone. Never plaintext, never the hash — the same
 * discipline TokenInfo holds for the shared table.
 */
export type AdminTokenInfo = {
  id: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

/**
 * Mints an admin token (§22.1): `pmcp_adm_`-prefixed, SHA-256 at rest, plaintext returned
 * exactly once, never recoverable afterwards. `expiresIn` is seconds or `"never"`; an
 * absent one takes the FIXED 365-day default (ADMIN_TOKEN_TTL_MS) — never sliding, because
 * an admin token is not a session. Trusts the caller: that the calling principal is a
 * session (never another admin token — no self-minting) is admin.adminOpsFor's check, not
 * this function's, for the same reason issueToken trusts referentOf's resolution.
 */
export async function issueAdminToken(
  ownerId: string,
  expiresIn: number | "never" | undefined,
  now: () => number = Date.now,
): Promise<{ id: string; token: string; prefix: string; createdAt: number; expiresAt: number | null }> {
  // deps: D1 `admin_token` · crypto.getRandomValues · crypto.subtle
  const createdAt = now();
  const id = crypto.randomUUID();
  const token = ADMIN_TOKEN_PREFIX + randomSecret();
  const prefix = token.slice(0, PREFIX_DISPLAY_LENGTH);
  const expiresAt = expiresIn === "never" ? null : expiresIn !== undefined ? createdAt + expiresIn * 1000 : createdAt + ADMIN_TOKEN_TTL_MS;
  await db()
    .prepare(
      `INSERT INTO admin_token ("id", "owner_id", "hash", "prefix", "expires_at", "created_at")
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ownerId, await sha256Hex(token), prefix, expiresAt, createdAt)
    .run();
  // The one and only time the plaintext exists outside the caller's hand.
  return { id, token, prefix, createdAt, expiresAt };
}

/** Every admin token in the namespace, newest first — live, expired, and revoked rows
 *  alike, exactly as listTokens shows the shared table's rotation state. */
export async function listAdminTokens(ownerId: string): Promise<AdminTokenInfo[]> {
  // deps: D1 `admin_token`
  const { results } = await db()
    .prepare(
      `SELECT "id", "prefix", "created_at", "expires_at", "last_used_at", "revoked_at"
         FROM admin_token WHERE "owner_id" = ? ORDER BY "created_at" DESC`,
    )
    .bind(ownerId)
    .all<AdminTokenRow & { prefix: string; created_at: number }>();
  return results.map((row) => ({
    id: row.id,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
  }));
}

/**
 * Revokes one admin token: immediately dead on every consumer surface — the next request
 * carrying it gets 401. Returns false when `id` names no admin token inside `ownerId`'s
 * namespace. Idempotent: revoking a revoked token returns true and changes nothing. Never
 * touches a socket — an admin token opens none (§22.1).
 */
export async function revokeAdminToken(ownerId: string, id: string): Promise<boolean> {
  // deps: D1 `admin_token`
  const { meta } = await db()
    .prepare(`UPDATE admin_token SET "revoked_at" = COALESCE("revoked_at", ?)
               WHERE "id" = ? AND "owner_id" = ?`)
    .bind(Date.now(), id, ownerId)
    .run();
  return meta.changes > 0;
}

/**
 * Hard-deletes every token row bound to this app or agent id — the
 * app_delete/agent_delete/user-delete cascade helper (token.ref_id has no
 * foreign key; this is its other half). Deletion, not revocation: the rows leave the
 * listings entirely. Keyed by opaque id, so recreating a slug can never resurrect
 * old credentials. Idempotent; zero matching rows is a success.
 */
export async function deleteTokensFor(refId: string): Promise<void> {
  // deps: D1 `token`
  await deleteTokensForStatement(refId).run();
}

/**
 * The same delete as a STATEMENT rather than a write, so admin's deleting cascades can put
 * it and the row delete into ONE `db().batch` — §15's "one atomic D1 batch", and the only
 * way to have it, D1 having no interactive transaction. Nothing else differs.
 */
export function deleteTokensForStatement(refId: string): D1Stmt {
  // deps: D1 `token`
  return db().prepare(`DELETE FROM token WHERE "ref_id" = ?`).bind(refId);
}

/**
 * The mountable better-auth surface — login and TOTP challenge endpoints, passkey
 * ceremonies, RFC 8628 device flow (codes shortened to ~10 minutes), session
 * management, and the bearer plugin the CLI rides — returned as one route group (a
 * Hono sub-app at implementation; typed unknown so no framework type leaks).
 *
 * Each public-handler request gets its own better-auth instance. This is the containment
 * boundary for the production stuck-instance failure described above; session reads made
 * elsewhere keep using the memoised `auth()` instance. Logins — password and passkey
 * alike — and device approvals write audit rows, and a verified assertion also stamps
 * §5's `last_used_at`. Mounted by the composition root under the reserved auth paths; the
 * credential family here is deliberately never exposed as pmcp tools, and a request
 * carrying an `Authorization` header reaches only the endpoints it has business at
 * (BEARER_ADMITTED below — §4's session-scope guard, standing at the mount rather than
 * only at the hub's wrappers). A cookie session older than better-auth's `freshAge` is
 * refused every change to a credential (FRESH_REQUIRED — decision 39), with better-auth's
 * own 403 and before better-auth runs, so a refused change changes nothing. The endpoints
 * in REFUSED answer every caller as a disabled better-auth endpoint does.
 */
export function authRoutes(): unknown {
  // deps: better-auth · audit.record · D1 `passkey`
  const app = new Hono();
  // One catch-all: which endpoints exist under here is better-auth's plugin list to
  // decide, not a route table of ours to keep in sync with it.
  app.all("/*", async (c) => {
    // First, and for every caller: an endpoint the hub does not offer at all — see REFUSED.
    if (REFUSED.has(mountSubPath(c.req.url))) return notAvailable();
    // §4's session-scope guard, enforced HERE because this is the seam it is a property
    // of — see BEARER_ADMITTED.
    if (c.req.raw.headers.get("Authorization") !== null && !admitsBearer(c.req.url)) {
      return credentialFamilyForbidden();
    }
    // §4's recent authentication, at the same seam and for the same reason — a direct
    // call reaches better-auth through no hub wrapper. See FRESH_REQUIRED.
    const unfresh = await freshnessRefusal(c.req.raw);
    if (unfresh !== null) return unfresh;
    // §5's last_used_at stamp, for the credential the ASSERTION named. That id is in the
    // request body better-auth is about to consume, so it is read off a clone before the
    // handler runs and written only once the handler says the assertion verified.
    const asserted = await assertedCredentialId(c.req.raw);
    const response = await buildAuth().handler(c.req.raw);
    await recordAuthEvent(c.req.raw, response);
    if (asserted !== null && response.ok) await stampPasskeyUse(asserted);
    return response;
  });
  return app;
}

/**
 * The credential id a passkey ASSERTION names, or null when this request is not one. The
 * plugin looks the row up by exactly this field (`credentialID` = `response.id`), so the
 * stamp and the verification are keyed on one value rather than on two spellings of it.
 */
async function assertedCredentialId(req: Request): Promise<string | null> {
  if (req.method !== "POST") return null;
  if (!new URL(req.url).pathname.endsWith("/passkey/verify-authentication")) return null;
  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as { response?: { id?: unknown } } | null;
  return typeof body?.response?.id === "string" ? body.response.id : null;
}

/**
 * The whole of what an `Authorization` header may reach under this mount — the ONE list,
 * read by the one guard above. Everything else here is §4's credential family by
 * construction, and answers the 403 below.
 *
 * Why a guard at the mount and not at `requireOwnerSession`: that function reads Cookie only
 * and is therefore already right, but it only runs on routes the hub wraps (`/settings`,
 * `/login`). better-auth's own endpoints are live on this public mount too, and §4's
 * `bearer()` plugin rewrites any `Authorization` header into a session before better-auth's
 * middleware — so a request straight at the mount routes through no wrapper, and the
 * cookie-only rule never gets a say. §4's harm sentence is exactly that path: "a stolen CLI
 * token cannot enroll new credentials and become persistent account takeover".
 *
 * Why an ALLOWLIST, when the family is what §4 names: a list of family members is a copy of
 * better-auth's route table, and one we would owe a re-read of its changelog at every
 * upgrade — wrong FAIL-OPEN in the meantime, since an endpoint we have not heard of is one
 * a bearer walks straight through. It was already wrong: core `/link-social`,
 * `/unlink-account` and `/list-accounts` are served on this mount under today's config and
 * were in no family list, which is §4's harm sentence verbatim. Two names that fail closed
 * owe a growing dependency nothing.
 *
 * Why exactly these three. `/sign-out` is `pmcp logout` (cli/src/main.ts), which posts it
 * over its bearer and destroys only itself. `/device/code` and `/device/token` are the RFC
 * 8628 exchange's ANONYMOUS legs — the CLI polls them with no `Authorization` at all, so the
 * guard never fires on them regardless; they are named here only so a caller that does attach
 * a bearer is not refused, and admitting them escalates nothing (a code issued to nobody, and
 * a redemption that returns `authorization_pending` until an approval a bearer cannot give).
 * Everything else under this mount is what a session may then DO to the credentials behind it,
 * and a bearer never gets that — reads included (`/list-sessions` rows carry session tokens,
 * which web.ts reads `{ id, token }` off, so a bearer that reached it would walk away with the
 * browser session this guard protects).
 *
 * Why the APPROVAL legs are NOT here. `/device` (the claim of a user code) and
 * `/device/approve` / `/device/deny` are the browser's half: a signed-in owner approving a
 * new device is how a SECOND session comes to exist. Admitting a bearer there is §4's harm
 * sentence exactly — a stolen CLI token drives `code → claim → approve → token` and mints a
 * fresh owner session that survives revocation of the stolen one, persistent takeover through
 * the very door this guard is. So they stay cookie-only: §13's `/device` page and every
 * in-hub caller reach them through `callAuthResponse`, which carries Cookie and never
 * `Authorization`; the CLI never claims or approves (the human does, in the browser).
 *
 * Admission is by SUB-PATH and covers the subtree — `/device/code` matches `/device/code`
 * and any `/device/code/*` a future better-auth adds — but NOT the bare `/device` claim,
 * which shares no admitted sub-path with either token leg.
 */
const BEARER_ADMITTED = ["sign-out", "device/code", "device/token"] as const;

/** Whether a request URL under this mount is one an `Authorization` header may reach. */
function admitsBearer(url: string): boolean {
  const sub = mountSubPath(url);
  return BEARER_ADMITTED.some((name) => sub === `/${name}` || sub.startsWith(`/${name}/`));
}

/** A URL's path below this mount (`/api/auth/change-password` → `/change-password`): the
 *  spelling better-auth routes by, and the one both guards' lists are written in. */
function mountSubPath(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith(AUTH_BASE_PATH) ? path.slice(AUTH_BASE_PATH.length) : path;
}

/**
 * Decision 39's list: every endpoint under this mount that changes the owner's password,
 * second factor, passkeys or sessions and that better-auth serves to ANY valid session. Its
 * own `freshSessionMiddleware` guards only `/list-sessions` and passkey registration, and
 * those stay its. fresh-auth.test.ts's table is the list the decision defers to — change both.
 *
 * Exact sub-paths, because better-auth's router matches them exactly: a trailing slash, a
 * doubled slash or an escaped character is a 404 there, never a route this list misses.
 *
 * Why a DENYLIST, when BEARER_ADMITTED argues for an allowlist: that guard's cost for an
 * endpoint it has not heard of is a refused bearer, which no CLI flow needs. This one's
 * would be a refused day-old browser at sign-out, the device approval and OAuth consent —
 * flows decision 39 keeps open on purpose. So a credential endpoint a better-auth upgrade
 * adds is a gap until it is named here; re-read the plugins' endpoints at every upgrade.
 *
 * `/two-factor/verify-totp`, `-backup-code` and `-otp` each serve a sign-in challenge (no
 * session yet, only the two-factor cookie) and a signed-in change (enrolment, or spending a
 * code). The guard judges only a request that resolves a session — the same test
 * better-auth's `verifyTwoFactor` picks its arm by — so the challenge never meets it.
 *
 * ponytail: a path list at the mount, compared to better-auth's refusal by a test. The
 * upgrade is a better-auth `hooks.before` matching `ctx.path` and throwing
 * `APIError.from("FORBIDDEN", BASE_ERROR_CODES.SESSION_NOT_FRESH)`: the library's own
 * routing and its own refusal, by construction instead of by comparison.
 */
const FRESH_REQUIRED: ReadonlySet<string> = new Set([
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/**
 * Endpoints better-auth serves under this mount that the hub does not offer to anyone —
 * any field, any session or none. `/update-user` because the username it can rewrite is the
 * namespace: the first segment of every MCP URL (`/<username>/…/mcp`, and so every issued
 * token's audience), the `user:<username>` principal in every audit row, and a name §2's
 * reserved-segment rule was checked against only when admin.provisionUser wrote it. Its other
 * fields (name, image) have no caller either — nothing in server, web or cli posts it.
 */
const REFUSED: ReadonlySet<string> = new Set(["/update-user"]);

/**
 * The answer better-auth gives an endpoint its config has switched off — `/delete-user` with
 * `user.deleteUser` unset throws `APIError.fromStatus("NOT_FOUND")`
 * (better-auth/dist/api/routes/update-user.mjs), which better-call renders as a 404 with an
 * empty body under `Content-Type: application/json`. Mirrored so a refused endpoint reads as
 * absent, not as a policy a caller could argue with.
 */
function notAvailable(): Response {
  return new Response(null, { status: 404, headers: { "Content-Type": "application/json" } });
}

/**
 * The mount's freshness guard: `null` lets the request on to better-auth; otherwise the
 * refusal it answers instead. Refuses only a FRESH_REQUIRED endpoint whose cookie resolves a
 * session older than `freshAge`. No session is not stale — an anonymous call, or a sign-in
 * challenge carrying only its two-factor cookie, is better-auth's to answer. The cookie is
 * the only carrier read: a bearer on any of these paths was already refused above.
 */
async function freshnessRefusal(req: Request): Promise<Response | null> {
  // deps: better-auth · isRecentAuth
  const endpoint = mountSubPath(req.url);
  const cookie = req.headers.get("Cookie");
  if (!FRESH_REQUIRED.has(endpoint) || cookie === null) return null;
  // Refresh off: a refused request must not extend the life of the session it refused.
  const session = await auth().api.getSession({
    headers: new Headers({ cookie }),
    query: { disableRefresh: true },
  });
  if (session === null || (await isRecentAuth(session.session.createdAt))) return null;
  // A decision, so one line — the user id and the endpoint, never the cookie.
  console.warn(
    `pmcp/fresh-auth: refused ${endpoint} for user ${session.user.id}: session older than freshAge (not transient — a fresh sign-in clears it)`,
  );
  return sessionNotFresh();
}

/**
 * The freshness refusal in better-auth's own shape: `freshSessionMiddleware` throws
 * `APIError.from("FORBIDDEN", BASE_ERROR_CODES.SESSION_NOT_FRESH)`
 * (better-auth/dist/api/routes/session.mjs), which better-call renders as a 403 carrying
 * `{ message, code }` as JSON. The same status and body here, so a client that handles the
 * library's refusal at passkey registration handles this one.
 */
function sessionNotFresh(): Response {
  const { message, code } = BASE_ERROR_CODES.SESSION_NOT_FRESH;
  return Response.json({ message, code }, { status: 403 });
}

/**
 * The family's refusal: 403, no body but the word, and no `WWW-Authenticate` — the caller
 * presented a credential that this surface will not accept from this carrier at all, so
 * there is no better token to challenge for (§7 gives that header to the consumer surfaces
 * alone). Nothing about the request is echoed: §15's hygiene rule covers error responses,
 * and the one thing this request certainly carries is a session token.
 */
function credentialFamilyForbidden(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * §15's "logins, device approvals" audit rows, keyed by the better-auth endpoint that
 * produced them. Suffix-matched because the group is mounted under a prefix the
 * composition root chooses, which is not this module's business to know.
 */
const AUDITED_AUTH_ENDPOINTS: Record<string, string> = {
  "/sign-in/username": "auth.login",
  "/sign-in/email": "auth.login",
  // A passkey assertion that verifies IS a sign-in; its response names the user the same way.
  "/passkey/verify-authentication": "auth.login",
  "/device/approve": "auth.device_approved",
};

/** Records one audited auth event, if this request was one and it succeeded. */
async function recordAuthEvent(req: Request, response: Response): Promise<void> {
  const path = new URL(req.url).pathname;
  const event = Object.entries(AUDITED_AUTH_ENDPOINTS).find(([suffix]) =>
    path.endsWith(suffix),
  )?.[1];
  if (event === undefined || !response.ok) return;
  const actor = await authEventActor(req, response);
  if (actor === null) return; // nothing to attribute it to is nothing to record
  await record(db(), {
    ownerId: actor.userId,
    principal: formatPrincipal(actor),
    event,
    outcome: "ok",
  });
}

/**
 * Who an audited auth event is about: the sign-in responses name the user they just
 * authenticated, and a device approval is attributable to the browser session that
 * approved it. Never throws — an audit row is not worth failing a login over, and
 * better-auth's bodies are its own shape to change.
 */
async function authEventActor(
  req: Request,
  response: Response,
): Promise<Extract<Principal, { kind: "user" }> | null> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { user?: { id?: string; username?: string } } | null;
  if (body?.user?.id && body.user.username) {
    return { kind: "user", userId: body.user.id, username: body.user.username };
  }
  const cookie = req.headers.get("Cookie");
  if (cookie === null) return null;
  const session = await auth()
    .api.getSession({ headers: new Headers({ cookie }) })
    .catch(() => null);
  const user = session?.user as { id: string; username?: string | null } | undefined;
  return user?.username ? { kind: "user", userId: user.id, username: user.username } : null;
}

/**
 * Where the composition root mounts `authRoutes()`: better-auth's own default basePath,
 * which `auth()` above leaves at the default. Spelled here because the mount and the URL
 * better-auth expects to route are ONE decision — pages/model's `paths.auth.base` reads
 * this rather than respelling it, and `callAuth` below builds on it.
 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * One call into the mounted better-auth surface from inside the worker, carrying the
 * caller's cookie and nothing else — the same door the browser uses. §4 gives better-auth
 * exactly one custodian, and this is how a non-custodian asks it something: the pages that
 * need an answer (/settings's credential state, /device's verify and its approve/deny POST)
 * come through here rather than each hand-rolling the mount path, the sub-app cast and the
 * failure policy. A `body` makes it a POST.
 *
 * Null means the call did not succeed — no cookie to carry, a request that could not be
 * made, or a refused status. These are page states, not a place to surface an upstream
 * status line. An ok answer whose body is not JSON reads as `{}`: the status is the
 * outcome, and the callers that only need "did it work" read nothing from the body.
 */
export async function callAuth<T>(
  req: Request,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  // deps: callAuthResponse
  // The cookie is this function's whole premise — its callers ask better-auth about the
  // CALLER, and a question with nobody in it has no answer worth a round trip.
  if (req.headers.get("Cookie") === null) return null;
  const response = await callAuthResponse(req, endpoint, body);
  if (response === null || !response.ok) return null;
  return (await response.json().catch(() => ({}))) as T;
}

/**
 * The same call, answered with better-auth's RESPONSE rather than its body — because some
 * of what better-auth answers with is not in the body at all. A sign-in's whole outcome is
 * its `Set-Cookie` headers, and the pages that translate a browser's form post into this
 * JSON call (web.ts's credential routes) have to hand those headers on to the browser or
 * they have signed nobody in. Everything else is `callAuth`'s: this is the raw door, and
 * reading it is the caller's job.
 *
 * Unlike `callAuth` a cookie is OPTIONAL here, which is the other half of why this exists:
 * a sign-in is precisely the request that arrives without one. Null means the call could
 * not be made at all; a refusal comes back as a Response with its status.
 */
export async function callAuthResponse(
  req: Request,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<Response | null> {
  // deps: authRoutes · better-auth · cloudflare:workers env (PUBLIC_ORIGIN)
  const cookie = req.headers.get("Cookie");
  const userAgent = req.headers.get("User-Agent");
  const app = authRoutes() as { fetch(request: Request): Promise<Response> };
  // Deliberately NOT a pass-through of the caller's headers — the cookie and the
  // User-Agent are the only things better-auth sees from the browser here — plus ONE
  // header this call states about itself. The User-Agent crosses because better-auth
  // stamps it on the session a sign-in mints, and that stamp is what /settings › Sessions
  // labels the row with ("Chrome on Windows"); it is display data and nothing gates on it
  // (pages/model reads a label out of it and never trusts it further). Without it every
  // browser session reads "Unknown client". better-auth refuses a cookie-bearing write
  // that carries no `Origin` (MISSING_OR_NULL_ORIGIN, its CSRF rule for browsers), and that is every call made
  // through here on a signed-in page: /settings's credential writes, /device's approve and
  // deny. The origin is the hub's own because the caller IS the hub — this request was
  // built three lines up, on PUBLIC_ORIGIN, out of a form the route already vouched for
  // (web.ts gates each one with either the CSRF token or its own origin rule). Forwarding
  // the browser's header instead would hand better-auth a value nothing here has checked.
  return app
    .fetch(
      new Request(`${env.PUBLIC_ORIGIN}${AUTH_BASE_PATH}${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: env.PUBLIC_ORIGIN,
          ...(cookie === null ? {} : { cookie }),
          ...(userAgent === null ? {} : { "user-agent": userAgent }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    .catch(() => null);
}

/**
 * GET /api/whoami — the one non-MCP data route the CLI depends on; the response
 * shape `{ principal, namespace }` is the pinned CLI↔server contract (§8). Accepts
 * both consumer credential kinds: a `pmcp_agt_` key resolves to `agent:<slug>` with the
 * owner's username as namespace; a session token to `user:<name>`; `pmcp_app_` is
 * always 401; no valid principal → 401 + `WWW-Authenticate: Bearer`. Exists outside
 * MCP because endpoint URLs embed the very username whoami discovers, and because it
 * must resolve agent keys, which better-auth cannot.
 */
export function whoamiRoute(): unknown {
  // deps: better-auth · D1 `token` · D1 `agent` · D1 `user` · crypto.subtle
  const app = new Hono();
  app.get("/whoami", async (c) => {
    // resolveCredential, not resolveCaller: there is no `<user>` in this URL to prove
    // anything about — which is the whole reason whoami exists (§8). `namespace: null` is
    // that absence made explicit: a JWT-shaped bearer has no audience to bind here, so it is
    // refused without running the OAuth leg, and the 401 carries the bare `Bearer` challenge.
    const presented = bearerToken(c.req.raw);
    const resolved = presented === null ? null : await resolveCredential(presented, Date.now, null);
    if (resolved === null) return unauthorized();
    return c.json({
      principal: formatPrincipal(resolved.principal),
      namespace: await namespaceNameOf(resolved.principal),
    });
  });
  return app;
}

/** The username whose namespace a principal acts in — its own, or its owner's. */
async function namespaceNameOf(p: Principal): Promise<string> {
  if (p.kind !== "agent") return p.username;
  const row = await db()
    .prepare(`SELECT "username" FROM "user" WHERE "id" = ?`)
    .bind(p.ownerId)
    .first<{ username: string }>();
  // An agent row cannot outlive its owner (§5's cascade), so this is unreachable
  // rather than a case: answering "" would be inventing a namespace.
  if (row === null) throw new Error(`agent ${p.slug} has no owner row`);
  return row.username;
}

/**
 * POST /internal/users — create / list / delete / reset-password for the users
 * script, guarded by the BOOTSTRAP_SECRET wrangler secret. While the secret is
 * unset, the route does not exist: 404 for everything, indistinguishable from any
 * unknown path, so the owner keeps it disabled between uses. The secret compare is
 * constant-time, and every invocation — accepted or refused — writes an audit row
 * (principal `bootstrap`, event `bootstrap.<op>`), written HERE and only here so a leg
 * added tomorrow is audited without its author remembering to. reset-password leaves
 * TOTP/passkey enrollment intact, so the secret alone never defeats a second factor. User
 * deletion hands the namespace teardown (token/row cascade, socket severing, DO wipes) to
 * the admin-owned cascade before better-auth's user rows go.
 *
 * Both of §12's inputs ARRIVE as arguments and neither is named here: the BOOTSTRAP_SECRET
 * binding, and `reserved` — the top-level segments a username may not claim (§2), derived
 * from the composition root's route table.
 */
export function bootstrapRoute(secret: string, reserved: ReadonlySet<string>): unknown {
  // deps: better-auth · admin.provisionUser · admin.deleteUser · audit.record · D1 `user` · crypto.subtle
  const app = new Hono();
  // Path-agnostic: the composition root decides WHERE §12's route lives and hands this
  // group only the requests that belong to it — the same reason the secret arrives as an
  // argument rather than being read from a binding here.
  app.post("/*", async (c) => {
    const presented = bearerToken(c.req.raw);
    if (presented === null || !constantTimeEqual(presented, secret)) {
      await recordBootstrap(BOOTSTRAP_OWNERLESS, "unknown", "refused");
      // No WWW-Authenticate: this route answers no principal and advertises no Bearer
      // scheme — the 401 says "wrong secret" where the 404 says "route disabled", and
      // that split is the whole signal scripts/users.ts reads (§12).
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const body = (await c.req.json().catch(() => null)) as BootstrapRequest | null;
    if (body?.op === undefined) {
      await recordBootstrap(BOOTSTRAP_OWNERLESS, "unknown", "error");
      return new Response("Bad Request", { status: 400 });
    }
    const named = "username" in body ? { username: body.username } : undefined;
    try {
      const leg = await runBootstrapOp(body, reserved);
      await recordBootstrap(leg.ownerId, body.op, "ok", named);
      return c.json(leg.answer);
    } catch (err) {
      if (!(err instanceof BootstrapRefusal)) throw err;
      await recordBootstrap(BOOTSTRAP_OWNERLESS, body.op, "error", {
        ...named,
        reason: err.message,
      });
      // A conflict the operator resolves by retyping — never a 500, and never the 404
      // that means "the route is disabled".
      return new Response(err.message, { status: 409 });
    }
  });
  return app;
}

/**
 * §12's four legs, each answering the body the script prints and the namespace its row is
 * filed under — `bootstrap` when there is none (a listing spans everyone). Auditing is
 * deliberately NOT here: the route above writes exactly one row per invocation, which is
 * what makes §12's "every invocation" one line at one site rather than four promises.
 */
async function runBootstrapOp(
  body: BootstrapRequest,
  reserved: ReadonlySet<string>,
): Promise<BootstrapLeg> {
  switch (body.op) {
    case "create":
      return createUser(body.username, reserved);
    case "list":
      return listUsers();
    case "delete":
      return removeUser(body.username);
    case "reset-password":
      return resetPassword(body.username);
  }
}

/** One leg's answer: the JSON the script reads, and whose namespace to file the row in. */
type BootstrapLeg = { ownerId: string; answer: Record<string, unknown> };

/** The request body of POST /internal/users — scripts/users.ts holds the copied twin. */
type BootstrapRequest =
  | { op: "create"; username: string }
  | { op: "list" }
  | { op: "delete"; username: string }
  | { op: "reset-password"; username: string };

/**
 * The `owner_id` a bootstrap invocation with no namespace to name is filed under: a
 * refused secret, a malformed body, a listing that spans everyone. The column is NOT
 * NULL and has no FK (§5), so a sentinel is a row rather than a lie about a user; it
 * appears on no owner's /audit page, which is correct — an all-namespaces master key's
 * misuse is not one namespace's news.
 */
const BOOTSTRAP_OWNERLESS = "bootstrap";

/** §12: every invocation is logged, accepted or refused, as principal `bootstrap`. The
 *  `op` is always the REQUEST's op name, so `event = 'bootstrap.create'` selects every
 *  create rather than only the failed ones. */
async function recordBootstrap(
  ownerId: string,
  op: string,
  outcome: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await record(db(), {
    ownerId,
    principal: BOOTSTRAP_OWNERLESS,
    event: `bootstrap.${op}`,
    outcome,
    detail,
  });
}

/**
 * §12's create: the namespace through admin's one provisioning seam, then the human
 * credential — the password exists in this function's scope and in the response, and
 * nowhere else, ever. provisionUser's `bootstrap.user_created` is a domain event about a
 * NAMESPACE, beside this invocation's own row rather than standing in for it.
 */
async function createUser(name: string, reserved: ReadonlySet<string>): Promise<BootstrapLeg> {
  if (reserved.has(name)) {
    // §2: a username can never claim a served top-level segment. The set arrives from the
    // composition root, which owns the route table it derives from.
    throw new BootstrapRefusal(`"${name}" is a reserved route segment`);
  }
  if (await ownerIdFor(name)) throw new BootstrapRefusal(`"${name}" already exists`);
  const { userId } = await provisionUser(name);
  const password = randomSecret();
  await setPassword(userId, password);
  return { ownerId: userId, answer: { op: "create", username: name, password } };
}

/** §12's list: usernames only — the script prints nothing else. */
async function listUsers(): Promise<BootstrapLeg> {
  const { results } = await db()
    .prepare(`SELECT "username" FROM "user" WHERE "username" IS NOT NULL ORDER BY "username"`)
    .all<{ username: string }>();
  return {
    ownerId: BOOTSTRAP_OWNERLESS,
    answer: { op: "list", usernames: results.map((row) => row.username) },
  };
}

/** §12's delete: admin's full teardown, and absence as the postcondition either way. */
async function removeUser(name: string): Promise<BootstrapLeg> {
  const userId = await ownerIdFor(name);
  await deleteUser(name);
  return { ownerId: userId ?? BOOTSTRAP_OWNERLESS, answer: { op: "delete", username: name } };
}

/**
 * §12's reset-password: a new credential and nothing else — TOTP and passkey enrollment
 * are untouched, so the master key alone never defeats a second factor.
 */
async function resetPassword(name: string): Promise<BootstrapLeg> {
  const userId = await ownerIdFor(name);
  if (userId === null) throw new BootstrapRefusal(`no such user: "${name}"`);
  const password = randomSecret();
  await setPassword(userId, password);
  return { ownerId: userId, answer: { op: "reset-password", username: name, password } };
}

/** A bootstrap op the operator can fix by retyping — surfaced as 409, never a 500. */
class BootstrapRefusal extends Error {}

/**
 * The ONE place the hub itself writes a password: exactly two callers, both inside the
 * bootstrap route (§12), never reachable from any MCP surface. The self-serve change §4
 * took on 2026-09-02 (decision 30, §13's Password pane) is better-auth's own
 * `POST /change-password` on the mount — it verifies the current password and writes the
 * new hash itself, so it never passes through here. Creates the credential account on first use and
 * replaces the hash afterwards; `provisionUser` writes the `user` row alone, so a
 * freshly provisioned namespace passes through the create leg here exactly once.
 *
 * `issuer` is better-auth 1.7's account-identity scope, spelled as its own
 * `createLocalAccountIssuer("credential")` does — that helper lives in a transitive
 * package this repo does not depend on directly.
 */
export async function setPassword(userId: string, password: string): Promise<void> {
  const ctx = await auth().$context;
  const hash = await ctx.password.hash(password);
  const existing = await ctx.internalAdapter.findCredentialAccount(userId);
  if (existing) {
    await ctx.internalAdapter.updatePassword(userId, hash);
    return;
  }
  await ctx.internalAdapter.createAccount({
    userId,
    providerId: "credential",
    accountId: userId,
    issuer: "local:credential",
    password: hash,
  } as never);
}
