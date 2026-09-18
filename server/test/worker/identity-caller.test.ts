// identity-caller.test.ts — the shared identity contract: `resolveCaller`'s credential
// half and `reauthorize`'s verdicts, across all four credential families.
//
// WHAT THIS FILE PINS.
//   1. Every family — local agent token, better-auth session, OAuth access token, admin
//      token — resolves to an `AuthenticatedCaller` whose `credential.reference` holds row
//      ids and expiry facts only, and whose `sandboxKey` is stable for one exact bearer,
//      different for a second credential of the same caller, and never equal to what an
//      at-rest hash stores (the domain separation, stated as the equality it refuses).
//   2. `reauthorize` answers the SAME `principalKey` the door admitted while the credential
//      is live, and `null` — never another principal — the moment it is revoked, expired,
//      deleted, or rebound to a different agent/user. Each refusal sits beside its allow
//      twin, before the revocation and one instant short of expiry.
//   3. The session family's raw representation: the reference carries better-auth's own
//      ISO-8601 `DATE` text, proven against the row a REAL sign-in wrote — the pin a
//      better-auth/adapter upgrade must trip if the stored format ever changes.
//   4. The initial-resolution shape: 401 for an unresolved credential, and the anonymous
//      404 for a resolved one addressing a namespace that is not its owner's — absent and
//      foreign namespaces answering identically.
//
// Boundaries: the full 401/404 anti-enumeration TABLE belongs to auth-matrix.test.ts, and
// `resolveAppToken`'s credential verdicts to identity-tokens.test.ts; this file states the
// caller/reauthorize contract at its own seam rather than copying either table. The
// rebinding writes below are the one state no product path can reach (no seam repoints a
// session user or a token referent), which is why they speak raw D1 — the same reason
// identity-tokens.test.ts's `forceKindColumn` does.
//
// Project: `worker` — real D1 and the real better-auth mount (driven through the
// composition root, exactly as a browser reaches it), per-file storage isolation,
// parallel. Order free.
//
// deps: src/identity (resolveCaller, reauthorize, revokeToken, issueAdminToken,
//       revokeAdminToken, AUTH_BASE_PATH) · src/oauth (upsertBinding, revokeConnection) ·
//       src/principal (principalKey, TOKEN_PREFIX) · src/index (the composition root:
//       sign-out and the provider's own OAuth endpoints) · harness/seed · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import {
  AUTH_BASE_PATH,
  issueAdminToken,
  resolveCaller,
  reauthorize,
  revokeAdminToken,
  revokeToken,
} from "../../src/identity";
import type { AuthenticatedCaller, CredentialReference } from "../../src/identity";
import { revokeConnection, upsertBinding } from "../../src/oauth";
import { principalKey, TOKEN_PREFIX } from "../../src/principal";
import { seedNamespace, seedOwnerSession } from "../harness/seed";

/** The worker's bindings as the composition root declares them: `cloudflare:test`'s `env`
 *  is untyped, and this named conversion is the one place the wrangler config's binding
 *  list is asserted on. */
const bindings = env as unknown as Env;

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = bindings.PUBLIC_ORIGIN;

/** The slug every agent fixture here binds credentials to; each namespace is its own
 *  owner's, so one constant cannot collide across cases. */
const AGENT_SLUG = "bot";

/** A TTL a fixture picks for itself — an override's value, never a spec-pinned window. */
const AN_HOUR_SECONDS = 3600;

/** A bearer that was never minted: the right prefix and shape, matching no hash in any
 *  namespace — and obviously fake, so it can never be mistaken for a real credential. */
const UNMINTED_AGENT_SECRET = `${TOKEN_PREFIX.agent}FAKE0000000000000000000000000000000000`;

/** A username no `user` row carries, for the absent-namespace 404. */
const ABSENT_USERNAME = "nobody-FAKE0000-absent";

/** The raw D1 reach the rebinding writes below name their reason for: a state no seam can
 *  express, never a shortcut for state a product path could have written. The cast is the
 *  same narrow-shape boundary identity-tokens.test.ts draws. */
type RawD1 = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

/** The binding itself, in that narrow shape. */
const rawDb = env.DB as RawD1;

/** One row the case cannot get from any read seam (a stored hash, a raw representation). */
async function rawFirst<T>(sql: string, ...params: unknown[]): Promise<T> {
  const row = await rawDb.prepare(sql).bind(...params).first<T>();
  if (row === null) throw new Error(`rawFirst: no row for ${sql}`);
  return row;
}

/** One raw write — the rebinding states, each documented where it is used. */
async function rawRun(sql: string, ...params: unknown[]): Promise<void> {
  await rawDb.prepare(sql).bind(...params).run();
}

/** The consumer request a caller presents its credential on: `/<user>/mcp`, bearer or not. */
function callerRequest(username: string, bearer: string | null): Request {
  return new Request(`${ORIGIN}/${username}/mcp`, {
    headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
  });
}

/** The HTTP status a door refusal threw, or null when the call resolved. A non-Response
 *  throw is re-raised: identity's refusals are bare Responses, and anything else is a
 *  defect this helper must not launder into a number. */
async function statusOf(run: Promise<unknown>): Promise<number | null> {
  try {
    await run;
    return null;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    return thrown.status;
  }
}

/** The reference of one KIND — a throw naming what actually resolved, so a family's case
 *  cannot pass on another family's reference (a cast alone would let it). */
function referenceOf<K extends CredentialReference["kind"]>(
  caller: AuthenticatedCaller,
  kind: K,
): Extract<CredentialReference, { kind: K }> {
  const reference = caller.credential.reference;
  if (reference.kind !== kind) {
    throw new Error(`expected a ${kind} reference, resolved as ${reference.kind}`);
  }
  return reference as Extract<CredentialReference, { kind: K }>;
}

/** The secret half of a plaintext token: what must never appear in a caller's own answer. */
function secretOf(token: string): string {
  return token.slice(token.indexOf("_", "pmcp_".length) + 1);
}

/** One JSON-RPC request at the worker, with an optional bearer. */
function mcpCall(url: string, token: string | null, method: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    }),
    bindings,
  );
}

// ─────────────────────────────── §19.6: the OAuth fixture ───────────────────────────────
//
// A valid OAuth access token is one only the authorization server can produce, so the
// fixture drives the REAL provider flow (register → authorize → consent → token) through
// the composition root, exactly as claude.ai does, and binds the client through the same
// `oauth.upsertBinding` seam the consent page's POST writes through (§19.5). The flow's
// constants are the ones auth-matrix.test.ts drives the same endpoints with.

/** The provider's own OAuth endpoints, mounted under the auth base path (§19.2). */
const OAUTH2 = `${ORIGIN}${AUTH_BASE_PATH}/oauth2`;
/** claude.ai's real redirect URI shape (§19.6): https, non-loopback, so the provider's
 *  "web" application-type policy accepts it. */
const OAUTH_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
/** RFC 7636 Appendix B's PKCE pair — a real verifier and its S256 challenge, not a secret. */
const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function call(request: Request): Promise<Response> {
  return worker.fetch(request, bindings);
}

/** Register a public client through anonymous DCR (§19.3) and return its assigned id. */
async function registerOAuthClient(): Promise<string> {
  const response = await call(
    new Request(`${OAUTH2}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "pmcp identity-caller test",
        redirect_uris: [OAUTH_REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  const registered: unknown = await response.json();
  if (registered === null || typeof registered !== "object" || !("client_id" in registered)) {
    throw new Error(`registerOAuthClient: ${response.status} answered no client_id`);
  }
  const clientId = registered.client_id;
  if (typeof clientId !== "string") throw new Error("registerOAuthClient: client_id is not a string");
  return clientId;
}

/** The provider answers its redirects as `{ redirect, url }` (accept: application/json) —
 *  `redirect_uri` is the OpenAPI spelling; read whichever it gives. */
function redirectUrlOf(body: unknown): string {
  if (body !== null && typeof body === "object") {
    if ("url" in body && typeof body.url === "string") return body.url;
    if ("redirect_uri" in body && typeof body.redirect_uri === "string") return body.redirect_uri;
  }
  return "";
}

/**
 * The whole authorization-code + PKCE flow, driven through the provider's own endpoints
 * with the owner's cookie and NO Authorization header (§19.7). `resource` is the
 * namespace's aggregated identifier, which is the only audience the door accepts.
 */
async function driveOAuth(cookie: string, resource: string): Promise<{ token: string; clientId: string }> {
  const clientId = await registerOAuthClient();
  const authorize = await call(
    new Request(
      `${OAUTH2}/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: OAUTH_REDIRECT_URI,
        response_type: "code",
        scope: "mcp",
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        resource,
      })}`,
      { headers: { cookie, accept: "application/json" } },
    ),
  );
  const oauthQuery = redirectUrlOf(await authorize.json()).split("?")[1] ?? "";
  const consent = await call(
    new Request(`${OAUTH2}/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: ORIGIN,
        accept: "application/json",
      },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    }),
  );
  const code = new URL(redirectUrlOf(await consent.json())).searchParams.get("code");
  if (code === null) throw new Error("driveOAuth: consent issued no code");
  // The provider's token endpoint accepts application/x-www-form-urlencoded ONLY.
  const token = await call(
    new Request(`${OAUTH2}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        client_id: clientId,
        code_verifier: PKCE_VERIFIER,
        resource,
      }).toString(),
    }),
  );
  const granted: unknown = await token.json();
  if (granted === null || typeof granted !== "object" || !("access_token" in granted)) {
    throw new Error(`driveOAuth: token exchange ${token.status} answered no access_token`);
  }
  const accessToken = granted.access_token;
  if (typeof accessToken !== "string") throw new Error("driveOAuth: access_token is not a string");
  return { token: accessToken, clientId };
}

// ────────────────────────────── the four credential families ────────────────────────────

describe("§7 step 1 · resolveCaller's credential half, per family", () => {
  it("§7 · the agent-token family: the principal resolves, the reference holds the two row ids and nothing else, and no bearer, secret or stored hash appears anywhere in the answer", async () => {
    const ns = await seedNamespace(env.DB, {
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "key", expiresIn: AN_HOUR_SECONDS }] }],
    });
    const bearer = ns.tokens.key.token;
    const caller = await resolveCaller(callerRequest(ns.owner.username, bearer));

    expect(caller.principal).toEqual({
      kind: "agent",
      agentId: ns.agents[AGENT_SLUG].id,
      ownerId: ns.owner.userId,
      slug: AGENT_SLUG,
    });
    expect(caller.credential.reference).toEqual({
      kind: "agentToken",
      tokenId: ns.tokens.key.id,
      agentId: ns.agents[AGENT_SLUG].id,
    });

    // Nothing the answer serializes is the credential or what the database stores about
    // it — the two values a leak would have to be.
    const serialized = JSON.stringify(caller);
    const stored = await rawFirst<{ hash: string }>(`SELECT "hash" FROM token WHERE "id" = ?`, ns.tokens.key.id);
    for (const secret of [bearer, secretOf(bearer), stored.hash]) {
      expect(serialized).not.toContain(secret);
    }

    // A second presentation of the SAME bearer reuses its Sandbox identity; two tokens
    // never do (the next case states the contrast).
    const again = await resolveCaller(callerRequest(ns.owner.username, bearer));
    expect(again.credential.sandboxKey).toBe(caller.credential.sandboxKey);
    expect(caller.credential.sandboxKey).toMatch(/^[0-9a-f]{64}$/);
    // The authorization key is the immutable row id, not the display slug — which is what
    // makes "the same principal key" a statement reauthorization can hold over time.
    expect(principalKey(caller.principal)).toBe(`agent:${ns.agents[AGENT_SLUG].id}`);
  });

  it("§7 · the Sandbox identity is per exact bearer and domain-separated from the at-rest hash: two live tokens for one agent get different keys, and each differs from what `token.hash`/`admin_token.hash` store", async () => {
    const ns = await seedNamespace(env.DB, {
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "one" }, { as: "two" }] }],
    });
    const one = await resolveCaller(callerRequest(ns.owner.username, ns.tokens.one.token));
    const two = await resolveCaller(callerRequest(ns.owner.username, ns.tokens.two.token));

    // One caller, two credentials: the execution plane must be keyed by the credential,
    // never by the principal it resolves.
    expect(one.principal).toEqual(two.principal);
    expect(one.credential.sandboxKey).not.toBe(two.credential.sandboxKey);

    // The domain separation: the same bytes, hashed for two purposes, must not answer the
    // same value — otherwise a database read would name a live sandbox.
    const tokenHash = await rawFirst<{ hash: string }>(`SELECT "hash" FROM token WHERE "id" = ?`, ns.tokens.one.id);
    expect(one.credential.sandboxKey).not.toBe(tokenHash.hash);

    const admin = await issueAdminToken(ns.owner.userId, AN_HOUR_SECONDS);
    const adminCaller = await resolveCaller(callerRequest(ns.owner.username, admin.token));
    const adminHash = await rawFirst<{ hash: string }>(
      `SELECT "hash" FROM admin_token WHERE "id" = ?`,
      admin.id,
    );
    expect(adminCaller.credential.sandboxKey).not.toBe(adminHash.hash);
    expect(adminCaller.credential.sandboxKey).not.toBe(one.credential.sandboxKey);
  });

  it("§7/§19.6 · the session family: a real sign-in resolves to a reference carrying the session row's id, userId and raw ISO-8601 expiresAt — the representation better-auth's Kysely/D1 adapter stored — and reauthorize answers the same principal key", async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const caller = await resolveCaller(callerRequest(ns.owner.username, session.token));

    expect(caller.principal).toEqual({ kind: "user", userId: ns.owner.userId, username: ns.owner.username });
    const reference = referenceOf(caller, "session");

    // The RAW row is the oracle: the reference's expiry must be that cell's own text, in
    // the adapter's canonical ISO-8601 form, naming an instant still in the future.
    const row = await rawFirst<{ id: string; userId: string; expiresAt: string }>(
      `SELECT "id", "userId", "expiresAt" FROM "session" WHERE "id" = ?`,
      reference.sessionId,
    );
    expect(row.userId).toBe(ns.owner.userId);
    expect(row.userId).toBe(reference.userId);
    expect(row.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(row.expiresAt).toISOString()).toBe(row.expiresAt);
    expect(Date.parse(reference.expiresAt)).toBe(Date.parse(row.expiresAt));
    expect(Date.parse(reference.expiresAt)).toBeGreaterThan(Date.now());

    // The bearer never rides the answer, only the row ids do — and the authorization key
    // is the immutable user id, which is what reauthorization compares.
    expect(JSON.stringify(caller)).not.toContain(session.token);
    expect(principalKey(caller.principal)).toBe(`user:${ns.owner.userId}`);

    const live = await reauthorize(reference);
    if (live === null) throw new Error("reauthorize refused a live session");
    expect(principalKey(live)).toBe(principalKey(caller.principal));
  });

  it("§22.1 · the admin-token family resolves to its owner's principal and a reference carrying the row id, owner and issued expiry — and it is the owner's `user:` key, exactly as a session is", async () => {
    const ns = await seedNamespace(env.DB, {});
    const issued = await issueAdminToken(ns.owner.userId, AN_HOUR_SECONDS);
    const caller = await resolveCaller(callerRequest(ns.owner.username, issued.token));

    expect(caller.principal).toEqual({ kind: "admin", userId: ns.owner.userId, username: ns.owner.username });
    expect(caller.credential.reference).toEqual({
      kind: "adminToken",
      tokenId: issued.id,
      ownerId: ns.owner.userId,
      expiresAt: issued.expiresAt,
    });
    // Identity is deliberately indistinguishable from the owner's session downstream.
    expect(principalKey(caller.principal)).toBe(`user:${ns.owner.userId}`);

    const live = await reauthorize(referenceOf(caller, "adminToken"));
    if (live === null) throw new Error("reauthorize refused a live admin token");
    expect(principalKey(live)).toBe(principalKey(caller.principal));
  });

  it("§19.6 · the OAuth family: a token minted through the provider flow resolves to the bound agent and captures the binding row plus the verified `exp`, and its first reauthorization answers the same key", async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT_SLUG }] });
    const session = await seedOwnerSession(ns.owner);
    const client = await driveOAuth(session.cookie, `${ORIGIN}/${ns.owner.username}/mcp`);
    const binding = await upsertBinding({
      ownerId: ns.owner.userId,
      clientId: client.clientId,
      agentId: ns.agents[AGENT_SLUG].id,
    });
    if (binding === null) throw new Error("upsertBinding refused the seeded agent");

    const caller = await resolveCaller(callerRequest(ns.owner.username, client.token));
    expect(caller.principal).toEqual({
      kind: "agent",
      agentId: ns.agents[AGENT_SLUG].id,
      ownerId: ns.owner.userId,
      slug: AGENT_SLUG,
    });
    const reference = referenceOf(caller, "oauth");
    expect(reference.bindingId).toBe(binding.id);
    expect(reference.agentId).toBe(ns.agents[AGENT_SLUG].id);
    expect(reference.ownerId).toBe(ns.owner.userId);
    // The verified claim, in JWT's own unit: still comfortably in the future.
    expect(reference.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const live = await reauthorize(reference);
    if (live === null) throw new Error("reauthorize refused a live OAuth binding");
    expect(principalKey(live)).toBe(principalKey(caller.principal));
  });
});

// ────────────────────────────── reauthorize's refusal states ────────────────────────────

describe("§7 step 1 re-run · reauthorize's verdicts", () => {
  it("§7 · reauthorize is total: a reference naming no row of its kind answers null for every family, never a throw and never a wrong principal", async () => {
    const ns = await seedNamespace(env.DB, {});
    const missing = `missing-${crypto.randomUUID()}`;
    const references: CredentialReference[] = [
      { kind: "agentToken", tokenId: missing, agentId: missing },
      {
        kind: "session",
        sessionId: missing,
        userId: ns.owner.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        kind: "oauth",
        bindingId: missing,
        agentId: missing,
        ownerId: ns.owner.userId,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      { kind: "adminToken", tokenId: missing, ownerId: ns.owner.userId, expiresAt: null },
    ];

    for (const reference of references) {
      expect(await reauthorize(reference), `${reference.kind} answered for a missing row`).toBeNull();
    }
  });

  it("§7 · the agent-token family refuses on revoke and on expiry, one instant short of the boundary being the allow twin", async () => {
    const ns = await seedNamespace(env.DB, {
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "key", expiresIn: AN_HOUR_SECONDS }] }],
    });
    const caller = await resolveCaller(callerRequest(ns.owner.username, ns.tokens.key.token));
    const reference = referenceOf(caller, "agentToken");
    const row = await rawFirst<{ expires_at: number }>(`SELECT "expires_at" FROM token WHERE "id" = ?`, ns.tokens.key.id);

    // Expiry is judged at the row's own instant: one ms earlier still answers, exactly at
    // it refuses.
    const before = await reauthorize(reference, () => row.expires_at - 1);
    if (before === null) throw new Error("reauthorize refused an unexpired token");
    expect(principalKey(before)).toBe(principalKey(caller.principal));
    expect(await reauthorize(reference, () => row.expires_at)).toBeNull();

    // Revocation through the product seam, and the refusal is immediate.
    expect(await revokeToken(ns.owner.userId, ns.tokens.key.id)).toBe(true);
    expect(await reauthorize(reference)).toBeNull();
  });

  it("§7 · the agent-token family refuses a row repointed at another agent instead of authorizing that agent", async () => {
    const ns = await seedNamespace(env.DB, {
      agents: [
        { slug: AGENT_SLUG, tokens: [{ as: "key" }] },
        { slug: "second" },
      ],
    });
    const caller = await resolveCaller(callerRequest(ns.owner.username, ns.tokens.key.token));
    const reference = referenceOf(caller, "agentToken");
    // Unreachable through the product — no seam rewrites `token.ref_id` — so the state is
    // written raw, and the point is the verdict: null, never the second agent's principal.
    await rawRun(`UPDATE token SET "ref_id" = ? WHERE "id" = ?`, ns.agents.second.id, ns.tokens.key.id);

    expect(await reauthorize(reference)).toBeNull();
  });

  it("§7 · the session family refuses a deleted session and a row repointed at another user, rather than answering that user's principal", async () => {
    const ns = await seedNamespace(env.DB, {});
    const other = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const caller = await resolveCaller(callerRequest(ns.owner.username, session.token));
    const reference = referenceOf(caller, "session");

    // Rebinding (raw for the same reason as above): the row now names another user, and
    // the captured userId no longer matches it.
    await rawRun(`UPDATE "session" SET "userId" = ? WHERE "id" = ?`, other.owner.userId, reference.sessionId);
    expect(await reauthorize(reference)).toBeNull();

    // Deletion, through the product seam the CLI uses: `pmcp logout` posts /sign-out and
    // the row is gone afterwards.
    const second = await seedOwnerSession(ns.owner);
    const secondCaller = await resolveCaller(callerRequest(ns.owner.username, second.token));
    const secondReference = referenceOf(secondCaller, "session");
    const signedOut = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${second.token}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(signedOut.ok).toBe(true);
    expect(await reauthorize(secondReference)).toBeNull();
  });

  it("§7 · the session family's expiry boundary: an instant one ms before the row's `expiresAt` answers, the instant itself refuses", async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const caller = await resolveCaller(callerRequest(ns.owner.username, session.token));
    const reference = referenceOf(caller, "session");
    const expiry = Date.parse(reference.expiresAt);

    const before = await reauthorize(reference, () => expiry - 1);
    if (before === null) throw new Error("reauthorize refused an unexpired session");
    expect(principalKey(before)).toBe(principalKey(caller.principal));
    expect(await reauthorize(reference, () => expiry)).toBeNull();
  });

  it("§22.1 · the admin-token family refuses on revoke and on expiry, and an issuance without one never expires at all", async () => {
    const ns = await seedNamespace(env.DB, {});
    const issued = await issueAdminToken(ns.owner.userId, AN_HOUR_SECONDS);
    const caller = await resolveCaller(callerRequest(ns.owner.username, issued.token));
    const reference = referenceOf(caller, "adminToken");
    const expiry = issued.expiresAt;
    if (expiry === null) throw new Error("an hourly admin token came back without an expiry");

    const before = await reauthorize(reference, () => expiry - 1);
    if (before === null) throw new Error("reauthorize refused an unexpired admin token");
    expect(principalKey(before)).toBe(principalKey(caller.principal));
    expect(await reauthorize(reference, () => expiry)).toBeNull();

    expect(await revokeAdminToken(ns.owner.userId, issued.id)).toBe(true);
    expect(await reauthorize(reference)).toBeNull();

    // `never` is a real state, not an absent one: its reference carries null and its row
    // outlives every clock this file can inject a day out.
    const eternal = await issueAdminToken(ns.owner.userId, "never");
    const eternalCaller = await resolveCaller(callerRequest(ns.owner.username, eternal.token));
    const eternalReference = referenceOf(eternalCaller, "adminToken");
    expect(eternalReference.expiresAt).toBeNull();
    const dayOut = await reauthorize(eternalReference, () => Date.now() + 24 * 60 * 60 * 1000);
    if (dayOut === null) throw new Error("reauthorize refused a never-expiring admin token");
    expect(principalKey(dayOut)).toBe(principalKey(eternalCaller.principal));
  });

  it("§19.6 · the OAuth family refuses once the connection is revoked and once the verified `exp` has passed, each beside its allow twin", async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT_SLUG }] });
    const session = await seedOwnerSession(ns.owner);
    const client = await driveOAuth(session.cookie, `${ORIGIN}/${ns.owner.username}/mcp`);
    const binding = await upsertBinding({
      ownerId: ns.owner.userId,
      clientId: client.clientId,
      agentId: ns.agents[AGENT_SLUG].id,
    });
    if (binding === null) throw new Error("upsertBinding refused the seeded agent");
    const caller = await resolveCaller(callerRequest(ns.owner.username, client.token));
    const reference = referenceOf(caller, "oauth");

    // The `exp` boundary, judged in the claim's own seconds: the instant before answers,
    // the instant itself refuses.
    const before = await reauthorize(reference, () => reference.expiresAt * 1000 - 1);
    if (before === null) throw new Error("reauthorize refused an unexpired access token");
    expect(principalKey(before)).toBe(principalKey(caller.principal));
    expect(await reauthorize(reference, () => reference.expiresAt * 1000)).toBeNull();

    // Revocation through the connections seam — the token itself is untouched and still
    // verifies; the live-row read is what refuses it.
    expect(await revokeConnection(ns.owner.userId, binding.id)).not.toBeNull();
    expect(await reauthorize(reference)).toBeNull();
  });
});

// ────────────────────────── the initial-resolution 401/404 shape ─────────────────────────

describe("§7 step 1 · initial resolution keeps its refusals", () => {
  it("§7 · an unresolved credential is the 401 and a resolved one addressing someone else's or no one's namespace is the anonymous 404 — the two namespaces indistinguishable", async () => {
    const mine = await seedNamespace(env.DB, {
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "key" }] }],
    });
    const theirs = await seedNamespace(env.DB, {});

    // No bearer and an unmintable bearer: one status, because the door resolves before it
    // judges a namespace.
    expect(await statusOf(resolveCaller(callerRequest(mine.owner.username, null)))).toBe(401);
    expect(await statusOf(resolveCaller(callerRequest(mine.owner.username, UNMINTED_AGENT_SECRET)))).toBe(401);

    // A resolved caller learns nothing more than "nothing here": a foreign namespace and
    // an absent one answer the identical 404, and their own namespace answers.
    expect(await statusOf(resolveCaller(callerRequest(theirs.owner.username, mine.tokens.key.token)))).toBe(404);
    expect(await statusOf(resolveCaller(callerRequest(ABSENT_USERNAME, mine.tokens.key.token)))).toBe(404);
    expect(await statusOf(resolveCaller(callerRequest(mine.owner.username, mine.tokens.key.token)))).toBeNull();
  });

  it("§7 · the resolved caller is the same principal the gateway serves: the credential is admitted on the real MCP endpoint, and the same bearer on another namespace answers the anonymous 404", async () => {
    const mine = await seedNamespace(env.DB, {
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "key" }] }],
    });
    const theirs = await seedNamespace(env.DB, {});

    // The endpoint's answer is the observable: a tools/list on the agent's own namespace
    // is served (no transport refusal), while the same bearer on another namespace is the
    // anonymous 404 rather than someone else's catalog.
    const served = await mcpCall(`${ORIGIN}/${mine.owner.username}/mcp`, mine.tokens.key.token, "tools/list");
    expect(served.status).toBe(200);
    const foreign = await mcpCall(`${ORIGIN}/${theirs.owner.username}/mcp`, mine.tokens.key.token, "tools/list");
    expect(foreign.status).toBe(404);
  });
});
