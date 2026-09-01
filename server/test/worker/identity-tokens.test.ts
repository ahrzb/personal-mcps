// identity-tokens.test.ts — the machine-credential half of identity (§5, §6): minting,
// listing, revoking, deleting, and the one-answer-for-every-failure rule on
// `resolveAppToken`.
//
// Two properties carry the file. First, plaintext-once: `issueToken` hands the secret
// back exactly once and no surface ever hands it back again — a regression here is
// invisible until a listing leaks a live credential. Second, the CREDENTIAL verdict is
// TOTAL and uniform: every way a `pmcp_app_` bearer can be short of fully valid — absent,
// foreign prefix, unknown, wrong kind column, revoked, expired — answers `null` and
// nothing else, so the 401 the upgrade handler builds on it cannot tell an attacker which
// check failed. That is exactly the shape §9 rule 2 warns about: a function that returned
// null unconditionally would pass a refusals-only table, so the valid-credential row sits
// in the same table as its `defect: "none"` twin.
//
// Boundaries: `resolvePrincipal`'s consumer 401/404 matrix belongs to auth-matrix.test.ts
// (that is where the anti-enumeration rows and their allow-twins live), and severing a
// live socket when a token is revoked is admin's cascade, observed in
// tunnel/lifecycle.test.ts. The REFERENT's state at upgrade time — app row gone,
// `kind: proxy`, archived — is not this function's verdict either: identity's contract
// header hands those to the upgrade handler ("row gone or kind proxy → 401, archived →
// 403") and `resolveAppToken`'s deps line reads only the `token` table, so it cannot
// observe them at all. They are the other half of tunnel/lifecycle.test.ts's upgrade
// matrix, where `UpgradeAppState` already names `row_deleted` and `proxy_kind` beside
// this table's credential states. This file stops at the token row and the verdict.
//
// Project: `worker` — real D1, no socket, per-file storage isolation, parallel. Order
// free.
//
// deps: test/harness/seed (namespace, app, agent, token rows) · server/src/identity
// (issueToken, listTokens, revokeToken, deleteTokensFor, resolveAppToken) ·
// server/src/limits (window constants — never literals) · env.DB (real D1)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deleteTokensFor,
  issueToken,
  listTokens,
  resolveAppToken,
  revokeToken,
} from "../../src/identity";
import type { TokenInfo, TokenKind } from "../../src/identity";
import { AGENT_TOKEN_TTL_MS } from "../../src/limits";
import { seedNamespace, seedOwnerSession } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * The single defect introduced into an otherwise-valid `pmcp_app_` upgrade request.
 *
 * One defect per row, and `none` is a real member: the allow-twin rides in the same
 * table rather than in a neighbouring describe, so a table that lost its accepting row
 * fails coverage rather than passing quietly. `wrong_kind_column` is the one that looks
 * redundant and is not — §6 pins that kind is read from the column, never inferred from
 * the prefix, so a `pmcp_app_`-prefixed secret stored as `agent` must still
 * refuse.
 *
 * Every member is a defect of the CREDENTIAL, because that is all this function reads
 * (its deps: D1 `token` · crypto.subtle). §6's two row-level 401 causes — the app row
 * gone, and the app row of `kind: proxy` — are deliberately absent: identity's header
 * assigns both to the upgrade handler, which fetches the app anyway, and
 * tunnel/lifecycle.test.ts's `UpgradeAppState` carries them as `row_deleted` and
 * `proxy_kind`. A member added here for either would demand a verdict this function
 * structurally cannot compute.
 */
export type AppTokenDefect =
  | "none"
  | "no_authorization_header"
  | "agent_prefix"
  | "session_token"
  | "query_string_token"
  | "unknown_secret"
  | "wrong_kind_column"
  | "revoked"
  | "expired";

/**
 * One row of the resolve matrix. `storedKind` is the kind COLUMN of the token row whose
 * plaintext the row PRESENTS — `app` everywhere except the two rows about a
 * agent credential: `agent_prefix`, where a genuine `pmcp_agt_` row is
 * presented (column and prefix agree, and it is valid on its own surface), and
 * `wrong_kind_column`, where a `pmcp_app_`-prefixed secret sits on a `agent`
 * row so the two disagree on purpose. `expect` has exactly two members because the
 * function has exactly two answers: a bound app id, or null. Nothing about which
 * check failed is observable, and nothing in the row type invites asserting it.
 */
export type AppTokenRow = {
  title: string;
  storedKind: TokenKind;
  defect: AppTokenDefect;
  expect: "app_id" | "null";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const appTokenRows: readonly AppTokenRow[] = [
  // One row per AppTokenDefect, in the union's own order — the table-wide law reads it
  // as the coverage oracle, so a defect added to the union without a row fails here. Every
  // row seeds the SAME valid state (a live `pmcp_app_` token on a live tunneled app) and
  // introduces exactly the one defect it names; `storedKind` is the kind COLUMN of the row
  // whose plaintext is PRESENTED, which is `app` everywhere except the two
  // agent rows (see AppTokenRow above).
  //
  // A refusal row whose fixture is merely a string matching no hash would be evidence about
  // hash lookup and nothing else — indistinguishable from `unknown_secret`, and green under
  // any implementation. The rows presenting a foreign credential therefore present a REAL
  // one: `agent_prefix` a live unrevoked unexpired `pmcp_agt_` row bound to a live
  // agent, `session_token` a real better-auth session token for the seeded owner.

  // §6: "The Worker verifies the app token — checking the token row's `kind` column
  // explicitly, not just the prefix — resolves the app (and its owner)". The allow-twin
  // for the nine refusals below, and the only row in the table that answers anything else.
  {
    title: "§6 · a live pmcp_app_ token resolves to its bound app id — the allow-twin every refusal in this table is measured against",
    storedKind: "app",
    defect: "none",
    expect: "app_id",
  },
  // §6: "401 — no/invalid/expired/revoked token …". No credential at all is the baseline
  // refusal; it must be the same answer as every credential-shaped one below.
  {
    title: "§6 · no Authorization header at all resolves null",
    storedKind: "app",
    defect: "no_authorization_header",
    expect: "null",
  },
  // §6: "wrong token kind (`pmcp_agt_`, session)" — a refusal clause of its own, distinct
  // from "no/invalid … token". An agent credential is a real credential somewhere
  // else — /connect is not that somewhere — so `storedKind` is `agent` here: the
  // presented secret is that live row's own plaintext, and the refusal is evidence about
  // the prefix and the kind column rather than about a hash that matches nothing.
  {
    title: "§6 · a pmcp_agt_ bearer resolves null — an agent credential means nothing on /connect",
    storedKind: "agent",
    defect: "agent_prefix",
    expect: "null",
  },
  // §7 step 1 / identity's resolution order, from the other side: a `pmcp_app_` surface
  // never falls through to a session lookup either. A human's session token is not a way in.
  {
    title: "§6 · a better-auth session token in the bearer resolves null — /connect never falls through to session lookup",
    storedKind: "app",
    defect: "session_token",
    expect: "null",
  },
  // §7 step 1: "tokens in query strings are rejected" — the rule is the transport, not the
  // secret: the row's own valid token, moved out of the header, stops being a credential.
  {
    title: "§6/§7 · the valid secret in a query string resolves null — the credential is the Authorization header or nothing",
    storedKind: "app",
    defect: "query_string_token",
    expect: "null",
  },
  // §6: "no/invalid … token". A well-formed pmcp_app_ secret matching no hash — the
  // brute-force case, answering exactly what a revoked one does.
  {
    title: "§6 · an unknown pmcp_app_ secret resolves null",
    storedKind: "app",
    defect: "unknown_secret",
    expect: "null",
  },
  // §6: "checking the token row's `kind` column explicitly, not just the prefix". This is
  // the row that looks redundant and is not — a prefix-only implementation passes every
  // other row in this table and fails only this one.
  {
    title: "§6 · kind is read from the column, never inferred from the prefix: a pmcp_app_ secret stored as kind 'agent' resolves null",
    storedKind: "agent",
    defect: "wrong_kind_column",
    expect: "null",
  },
  // §6/§15: "Token revocation: consumer tokens are checked on every request, so revocation
  // is immediate" — at the upgrade, the revoked row is worth exactly as much as no row.
  {
    title: "§6 · a revoked token resolves null",
    storedKind: "app",
    defect: "revoked",
    expect: "null",
  },
  // §6: "Expiry is checked at upgrade only — an established socket outlives its token's
  // `expires_at` until the next reconnect". This row is that check, at that moment.
  {
    title: "§6 · an expired token resolves null — expiry is judged at the upgrade",
    storedKind: "app",
    defect: "expired",
    expect: "null",
  },
  // NOT HERE, deliberately: the two referent-state refusals §6 states in the same 401
  // clause — "a token whose app row is gone or is `kind: proxy`". Both are row-level
  // verdicts identity's header assigns to the upgrade handler, and this function reads only
  // the `token` table, so seeding either state leaves it holding a fully valid credential
  // (app row deleted through registry → it answers {appId}, and the handler answers
  // 401) or no token row at all (deleted through §8's app_delete, which deletes the
  // token rows too → the `unknown_secret` path, proving nothing new). They are rows of
  // tunnel/lifecycle.test.ts's upgrade matrix, whose `UpgradeAppState` names them
  // `row_deleted` and `proxy_kind`.
];

/**
 * Every namespace below is its own owner's, so the two slugs can be constants: a
 * tunneled app to bind `pmcp_app_` credentials to, and an agent to bind the
 * `pmcp_agt_` ones the foreign-credential rows present.
 */
const APP_SLUG = "news";
const AGENT_SLUG = "agent";

/** The /connect upgrade — the one surface a `pmcp_app_` credential means anything on. */
const CONNECT_URL = "https://hub.example/connect";

/**
 * A well-formed `pmcp_app_` secret that was never minted: right prefix, right shape,
 * matching no hash in any namespace — and obviously fake, so it can never be mistaken
 * for a real credential in a log or a diff.
 */
const UNMINTED_APP_SECRET = "pmcp_app_FAKE0000000000000000000000000000000000";

/** A TTL a fixture picks for itself — an override's value, never a spec-pinned window. */
const AN_HOUR_SECONDS = 3600;

/** The raw D1 reach the two cases below name their reason for: never a shortcut for state. */
type RawD1 = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
  };
};

/** The namespace every resolve row starts from: one live tunneled app, one agent. */
async function seedResolveNamespace(
  app: { revoked?: boolean; expired?: boolean } = {},
): Promise<SeededNamespace> {
  return seedNamespace(env.DB, {
    apps: [{ slug: APP_SLUG, kind: "tunnel", tokens: [{ as: "app", ...app }] }],
    agents: [{ slug: AGENT_SLUG, tokens: [{ as: "sa" }] }],
  });
}

/** The upgrade request as a client sends it: the credential rides the header, or nowhere. */
function bearerRequest(token: string): Request {
  return new Request(CONNECT_URL, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * The one state no seam can express, and the reason the row exists: `issueToken` derives
 * the prefix FROM the kind, so a `pmcp_app_` secret sitting on a `agent` row is
 * unreachable through it by construction. The row is minted by the production path like
 * every other; only the kind COLUMN is corrupted afterwards, so the fixture presents a
 * real secret whose prefix and column disagree — exactly what §6 says must not be trusted.
 */
async function forceKindColumn(tokenId: string, kind: TokenKind): Promise<void> {
  await (env.DB as RawD1)
    .prepare(`UPDATE token SET "kind" = ? WHERE "id" = ?`)
    .bind(kind, tokenId)
    .run();
}

/**
 * A REAL session bearer for the seeded owner — the owner signs in through the mounted
 * better-auth route and the token that comes back is what the row presents. The GAP this
 * function used to carry (no better-auth dependency, so a session-SHAPED string stood in)
 * closed with D4: presenting a genuine human credential is what makes the refusal evidence
 * about the resolution ORDER rather than about a hash that matches nothing.
 */
async function sessionBearer(ns: SeededNamespace): Promise<string> {
  return (await seedOwnerSession(ns.owner)).token;
}

/**
 * The one defect the row names, introduced into the seeded namespace's otherwise-valid
 * upgrade request. Every branch presents a REAL credential or none at all — the two
 * foreign-credential rows present live rows of their own kind rather than a string that
 * merely fails a hash lookup (which is `unknown_secret`'s job and nobody else's).
 */
async function requestFor(row: AppTokenRow, ns: SeededNamespace): Promise<Request> {
  switch (row.defect) {
    case "none":
    case "revoked":
    case "expired":
      return bearerRequest(ns.tokens.app.token);
    case "no_authorization_header":
      return new Request(CONNECT_URL);
    case "agent_prefix":
      // A real, live, unrevoked credential of the kind row.storedKind names — valid on its
      // own surface, worth nothing here.
      return bearerRequest(ns.tokens.sa.token);
    case "session_token":
      return bearerRequest(await sessionBearer(ns));
    case "query_string_token":
      // The row's OWN valid secret, moved out of the header: the transport is the rule.
      return new Request(`${CONNECT_URL}?token=${encodeURIComponent(ns.tokens.app.token)}`);
    case "unknown_secret":
      return bearerRequest(UNMINTED_APP_SECRET);
    case "wrong_kind_column":
      await forceKindColumn(ns.tokens.app.id, row.storedKind);
      return bearerRequest(ns.tokens.app.token);
  }
}

/** The request one row describes, plus the app id its allow-twin must resolve to. */
async function buildRow(row: AppTokenRow): Promise<{ request: Request; appId: string }> {
  const ns = await seedResolveNamespace({
    revoked: row.defect === "revoked",
    expired: row.defect === "expired",
  });
  return { request: await requestFor(row, ns), appId: ns.apps[APP_SLUG].id };
}

/**
 * Registers one case per row: the request built from the row resolves to the bound
 * app id, or to null. Two table-wide laws ride along, because they are properties of
 * the SET of rows rather than of any one row: every defect of the union appears exactly
 * once (a defect added to the union without a row fails here), and every `null` answer is
 * indistinguishable from every other — same value, no thrown error carrying a reason.
 */
export function runAppTokenTable(rows: readonly AppTokenRow[]): void {
  // deps: test/harness/seed · server/src/identity (resolveAppToken)
  for (const row of rows) {
    it(row.title, async () => {
      const { request, appId } = await buildRow(row);
      const resolved = await resolveAppToken(request);
      if (row.expect === "app_id") {
        // The bound app id, and the token ROW's id beside it — the upgrade needs the
        // latter for §8's onlyIfTokenId and reads it here rather than re-hashing the
        // plaintext itself. The row's oracle is still "resolves", not the id's value: a
        // row cannot know the id seed minted.
        expect(resolved).toMatchObject({ appId });
        expect(typeof resolved?.tokenId, "the verdict carried no token id").toBe("string");
      } else expect(resolved).toBeNull();
    });
  }
}

/**
 * The union's members at RUNTIME — the coverage oracle the table-wide law reads. Typed
 * as a total Record of the union, so a defect added to `AppTokenDefect` without a key
 * here fails to compile, and a key here without a row fails the law below.
 */
const ALL_DEFECTS: Record<AppTokenDefect, true> = {
  none: true,
  no_authorization_header: true,
  agent_prefix: true,
  session_token: true,
  query_string_token: true,
  unknown_secret: true,
  wrong_kind_column: true,
  revoked: true,
  expired: true,
};

/** One listed row by id — a listing missing it is the failure, not an undefined later. */
function tokenRow(rows: TokenInfo[], id: string): TokenInfo {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`listTokens returned no row for token ${id}`);
  return row;
}

/** The secret half of a plaintext token: what must never appear in any stored column. */
function secretOf(token: string): string {
  return token.slice(token.indexOf("_", "pmcp_".length) + 1);
}

describe("§6 · resolveAppToken: one null for every failure", () => {
  runAppTokenTable(appTokenRows);

  it("§6 · the union is exhausted: every AppTokenDefect has a row, and every refusing row answers the identical value", async () => {
    expect([...appTokenRows].map((row) => row.defect).sort()).toEqual(
      Object.keys(ALL_DEFECTS).sort(),
    );

    const refusals = appTokenRows.filter((row) => row.expect === "null");
    const answers: unknown[] = [];
    for (const row of refusals) {
      const { request } = await buildRow(row);
      // Any throw here fails the case: a reason carried out as an exception would be a
      // distinguishing answer just as surely as a different value.
      answers.push(await resolveAppToken(request));
    }
    expect(answers).toHaveLength(refusals.length);
    expect(new Set(answers)).toEqual(new Set([null]));
  });
});

describe("§5 · minting and plaintext-once", () => {
  it("§5 · issueToken returns the plaintext once; listTokens shows the prefix and no surface returns the secret again", async () => {
    const ns = await seedResolveNamespace();
    const minted = ns.tokens.app;
    const listed = tokenRow(await listTokens(ns.owner.userId), minted.id);

    expect(minted.token.startsWith("pmcp_app_")).toBe(true);
    // The listing carries a stub of the credential, never the credential.
    expect(minted.token.startsWith(listed.prefix)).toBe(true);
    expect(listed.prefix.length).toBeLessThan(minted.token.length);
    expect(JSON.stringify(listed)).not.toContain(secretOf(minted.token));

    // ...and neither does the row it came from: what is at rest is a hash.
    const stored = await (env.DB as RawD1)
      .prepare(`SELECT * FROM token WHERE "id" = ?`)
      .bind(minted.id)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(secretOf(minted.token));
  });

  it("§5 · the issued token authenticates on its own credential surface · twin to the row above: sealed, not lost", async () => {
    const ns = await seedResolveNamespace();
    expect(await resolveAppToken(bearerRequest(ns.tokens.app.token))).toEqual({
      appId: ns.apps[APP_SLUG].id,
      // The token ROW's id rides the verdict so the upgrade never re-reads the plaintext
      // (§8's onlyIfTokenId needs it) — an id, never the secret.
      tokenId: ns.tokens.app.id,
    });
  });

  it("§5 · expiry defaults by kind — an agent token carries an expiry, an app token carries none (the bot on a home server must not silently die). The window's value is incidental (§7); its presence is not", async () => {
    const ns = await seedResolveNamespace();
    const rows = await listTokens(ns.owner.userId);
    const agent = tokenRow(rows, ns.tokens.sa.id);
    const app = tokenRow(rows, ns.tokens.app.id);

    // Read by NAME (limits.AGENT_TOKEN_TTL_MS), so "90 d → 60 d" is a one-line
    // edit there and no churn here.
    expect(agent.expiresAt).toBe(agent.createdAt + AGENT_TOKEN_TTL_MS);
    expect(app.expiresAt).toBeNull();
  });

  it("§5 · an explicit expiresIn and an explicit 'never' each override the per-kind default, in both directions", async () => {
    const ns = await seedNamespace(env.DB, {
      // The app token gets an expiry it would not have had...
      apps: [
        { slug: APP_SLUG, kind: "tunnel", tokens: [{ as: "app", expiresIn: AN_HOUR_SECONDS }] },
      ],
      // ...and the agent token loses the one it would have had.
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "sa", expiresIn: "never" }] }],
    });
    const rows = await listTokens(ns.owner.userId);
    const app = tokenRow(rows, ns.tokens.app.id);

    expect(app.expiresAt).toBe(app.createdAt + AN_HOUR_SECONDS * 1000);
    expect(tokenRow(rows, ns.tokens.sa.id).expiresAt).toBeNull();
  });
});

describe("§8 · revoke versus delete", () => {
  it("§8 · a revoked token is refused immediately on the next resolve · twin: the same token resolved before the revoke", async () => {
    const ns = await seedResolveNamespace();
    const upgrade = () => resolveAppToken(bearerRequest(ns.tokens.app.token));

    expect(await upgrade()).toEqual({
      appId: ns.apps[APP_SLUG].id,
      tokenId: ns.tokens.app.id,
    });
    expect(await revokeToken(ns.owner.userId, ns.tokens.app.id)).toBe(true);
    expect(await upgrade()).toBeNull();
  });

  it("§8 · revokeToken is idempotent — revoking a revoked token succeeds and changes nothing", async () => {
    const ns = await seedResolveNamespace();
    expect(await revokeToken(ns.owner.userId, ns.tokens.app.id)).toBe(true);
    const once = tokenRow(await listTokens(ns.owner.userId), ns.tokens.app.id);

    expect(await revokeToken(ns.owner.userId, ns.tokens.app.id)).toBe(true);
    // Same row, same instant: the second revoke did not re-stamp the first one's time.
    expect(tokenRow(await listTokens(ns.owner.userId), ns.tokens.app.id)).toEqual(once);
  });

  it("§8 · revokeToken answers false identically for an unknown id and for another namespace's token — one uniform not-found, so the op layer cannot leak existence", async () => {
    const mine = await seedResolveNamespace();
    const theirs = await seedResolveNamespace();

    const unknown = await revokeToken(mine.owner.userId, crypto.randomUUID());
    const foreign = await revokeToken(mine.owner.userId, theirs.tokens.app.id);
    expect(unknown).toBe(false);
    expect(foreign).toBe(unknown);
    // The refusal is real, not cosmetic: the other namespace's credential is untouched.
    expect(tokenRow(await listTokens(theirs.owner.userId), theirs.tokens.app.id).revokedAt).toBeNull();
  });

  it("§6 · a revoked token still appears in listTokens with revokedAt stamped — rotation state is what the listing is for · twin: the live token lists too", async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: APP_SLUG,
          kind: "tunnel",
          tokens: [{ as: "live" }, { as: "dead", revoked: true }],
        },
      ],
    });
    const rows = await listTokens(ns.owner.userId);

    expect(rows.map((row) => row.id).sort()).toEqual([ns.tokens.live.id, ns.tokens.dead.id].sort());
    expect(tokenRow(rows, ns.tokens.dead.id).revokedAt).toBeTypeOf("number");
    expect(tokenRow(rows, ns.tokens.live.id).revokedAt).toBeNull();
  });

  it("§8 · deleteTokensFor removes the rows from the listing entirely — deletion, not revocation, is what the app_delete cascade does", async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [
        { slug: APP_SLUG, kind: "tunnel", tokens: [{ as: "app" }, { as: "spare" }] },
      ],
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "sa" }] }],
    });

    await deleteTokensFor(ns.apps[APP_SLUG].id);

    // Both of the app's rows are gone — not listed as revoked — and the agent's
    // credential, bound to another id, is untouched.
    expect((await listTokens(ns.owner.userId)).map((row) => row.id)).toEqual([ns.tokens.sa.id]);
    expect(await resolveAppToken(bearerRequest(ns.tokens.app.token))).toBeNull();
  });

  it("§5 · deleteTokensFor is keyed by opaque id: recreating a deleted app's slug resurrects no credential", async () => {
    const before = await seedResolveNamespace();
    await deleteTokensFor(before.apps[APP_SLUG].id);

    // The app ROW's deletion is registry's primitive, not a seed seam, so the
    // recreation is seeded as a second namespace: same slug, a fresh opaque id — which is
    // the whole binding a token has.
    const after = await seedNamespace(env.DB, {
      apps: [{ slug: APP_SLUG, kind: "tunnel" }],
    });

    expect(after.apps[APP_SLUG].id).not.toBe(before.apps[APP_SLUG].id);
    expect(await listTokens(after.owner.userId)).toEqual([]);
    expect(await resolveAppToken(bearerRequest(before.tokens.app.token))).toBeNull();
  });

  it("§8 · deleteTokensFor over zero matching rows succeeds", async () => {
    const ns = await seedResolveNamespace();
    const before = await listTokens(ns.owner.userId);

    await expect(deleteTokensFor(crypto.randomUUID())).resolves.toBeUndefined();

    // Compared id-sorted, not listing-ordered: two mints inside one millisecond leave the
    // tie order to SQLite, and that is not what this case is about.
    const byId = (rows: TokenInfo[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(await listTokens(ns.owner.userId))).toEqual(byId(before));
  });
});

describe("§7 · listing and use", () => {
  it("§7 · listTokens spans live, expired and revoked rows in one namespace, and never shows a token whose referent row is gone", async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: APP_SLUG,
          kind: "tunnel",
          tokens: [{ as: "live" }, { as: "expired", expired: true }, { as: "revoked", revoked: true }],
        },
      ],
      agents: [{ slug: AGENT_SLUG, tokens: [{ as: "agent" }] }],
    });
    // issueToken TRUSTS refId (its contract header) — so a credential bound to nothing is
    // mintable, and belongs to no namespace's listing.
    const orphan = await issueToken({ kind: "app", refId: `gone-${crypto.randomUUID()}` });

    const rows = await listTokens(ns.owner.userId);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [ns.tokens.live.id, ns.tokens.expired.id, ns.tokens.revoked.id, ns.tokens.agent.id].sort(),
    );
    expect(rows.some((row) => row.id === orphan.id)).toBe(false);

    // Each state is readable in its row — that is what the listing is for.
    const live = tokenRow(rows, ns.tokens.live.id);
    expect([live.revokedAt, live.lastUsedAt]).toEqual([null, null]);
    expect(live.refSlug).toBe(APP_SLUG);
    expect(tokenRow(rows, ns.tokens.expired.id).expiresAt).toBeLessThan(Date.now());
    expect(tokenRow(rows, ns.tokens.revoked.id).revokedAt).toBeTypeOf("number");
    expect(tokenRow(rows, ns.tokens.agent.id).refSlug).toBe(AGENT_SLUG);

    // Newest first (non-strict: two mints can share a millisecond).
    const created = rows.map((row) => row.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it("§7 · a successful resolve stamps last_used_at and a refused one stamps nothing — the stamping cadence itself is incidental (§7) and is not asserted", async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: APP_SLUG,
          kind: "tunnel",
          tokens: [{ as: "live" }, { as: "dead", revoked: true }],
        },
      ],
    });
    const before = await listTokens(ns.owner.userId);
    expect(tokenRow(before, ns.tokens.live.id).lastUsedAt).toBeNull();
    expect(tokenRow(before, ns.tokens.dead.id).lastUsedAt).toBeNull();

    expect(await resolveAppToken(bearerRequest(ns.tokens.live.token))).not.toBeNull();
    expect(await resolveAppToken(bearerRequest(ns.tokens.dead.token))).toBeNull();

    const after = await listTokens(ns.owner.userId);
    // A number, not a value: how coarse the stamp is belongs to limits, not to this case.
    expect(tokenRow(after, ns.tokens.live.id).lastUsedAt).toBeTypeOf("number");
    expect(tokenRow(after, ns.tokens.dead.id).lastUsedAt).toBeNull();
  });
});
