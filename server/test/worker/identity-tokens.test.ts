// identity-tokens.test.ts — the machine-credential half of identity (§5, §6): minting,
// listing, revoking, deleting, and the one-answer-for-every-failure rule on
// `resolveServiceToken`.
//
// Two properties carry the file. First, plaintext-once: `issueToken` hands the secret
// back exactly once and no surface ever hands it back again — a regression here is
// invisible until a listing leaks a live credential. Second, the CREDENTIAL verdict is
// TOTAL and uniform: every way a `pmcp_svc_` bearer can be short of fully valid — absent,
// foreign prefix, unknown, wrong kind column, revoked, expired — answers `null` and
// nothing else, so the 401 the upgrade handler builds on it cannot tell an attacker which
// check failed. That is exactly the shape §9 rule 2 warns about: a function that returned
// null unconditionally would pass a refusals-only table, so the valid-credential row sits
// in the same table as its `defect: "none"` twin.
//
// Boundaries: `resolvePrincipal`'s consumer 401/404 matrix belongs to auth-matrix.test.ts
// (that is where the anti-enumeration rows and their allow-twins live), and severing a
// live socket when a token is revoked is admin's cascade, observed in
// tunnel/lifecycle.test.ts. The REFERENT's state at upgrade time — service row gone,
// `kind: proxy`, archived — is not this function's verdict either: identity's contract
// header hands those to the upgrade handler ("row gone or kind proxy → 401, archived →
// 403") and `resolveServiceToken`'s deps line reads only the `token` table, so it cannot
// observe them at all. They are the other half of tunnel/lifecycle.test.ts's upgrade
// matrix, where `UpgradeServiceState` already names `row_deleted` and `proxy_kind` beside
// this table's credential states. This file stops at the token row and the verdict.
//
// Project: `worker` — real D1, no socket, per-file storage isolation, parallel. Order
// free.
//
// deps: test/harness/seed (namespace, service, account, token rows) · server/src/identity
// (issueToken, listTokens, revokeToken, deleteTokensFor, resolveServiceToken) ·
// server/src/limits (window constants — never literals) · env.DB (real D1)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deleteTokensFor,
  issueToken,
  listTokens,
  resolveServiceToken,
  revokeToken,
} from "../../src/identity";
import type { TokenInfo, TokenKind } from "../../src/identity";
import { SERVICE_ACCOUNT_TOKEN_TTL_MS } from "../../src/limits";
import { seedNamespace } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * The single defect introduced into an otherwise-valid `pmcp_svc_` upgrade request.
 *
 * One defect per row, and `none` is a real member: the allow-twin rides in the same
 * table rather than in a neighbouring describe, so a table that lost its accepting row
 * fails coverage rather than passing quietly. `wrong_kind_column` is the one that looks
 * redundant and is not — §6 pins that kind is read from the column, never inferred from
 * the prefix, so a `pmcp_svc_`-prefixed secret stored as `service_account` must still
 * refuse.
 *
 * Every member is a defect of the CREDENTIAL, because that is all this function reads
 * (its deps: D1 `token` · crypto.subtle). §6's two row-level 401 causes — the service row
 * gone, and the service row of `kind: proxy` — are deliberately absent: identity's header
 * assigns both to the upgrade handler, which fetches the service anyway, and
 * tunnel/lifecycle.test.ts's `UpgradeServiceState` carries them as `row_deleted` and
 * `proxy_kind`. A member added here for either would demand a verdict this function
 * structurally cannot compute.
 */
export type ServiceTokenDefect =
  | "none"
  | "no_authorization_header"
  | "service_account_prefix"
  | "session_token"
  | "query_string_token"
  | "unknown_secret"
  | "wrong_kind_column"
  | "revoked"
  | "expired";

/**
 * One row of the resolve matrix. `storedKind` is the kind COLUMN of the token row whose
 * plaintext the row PRESENTS — `service` everywhere except the two rows about a
 * service-account credential: `service_account_prefix`, where a genuine `pmcp_sa_` row is
 * presented (column and prefix agree, and it is valid on its own surface), and
 * `wrong_kind_column`, where a `pmcp_svc_`-prefixed secret sits on a `service_account`
 * row so the two disagree on purpose. `expect` has exactly two members because the
 * function has exactly two answers: a bound service id, or null. Nothing about which
 * check failed is observable, and nothing in the row type invites asserting it.
 */
export type ServiceTokenRow = {
  title: string;
  storedKind: TokenKind;
  defect: ServiceTokenDefect;
  expect: "service_id" | "null";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const serviceTokenRows: readonly ServiceTokenRow[] = [
  // One row per ServiceTokenDefect, in the union's own order — the table-wide law reads it
  // as the coverage oracle, so a defect added to the union without a row fails here. Every
  // row seeds the SAME valid state (a live `pmcp_svc_` token on a live tunneled service) and
  // introduces exactly the one defect it names; `storedKind` is the kind COLUMN of the row
  // whose plaintext is PRESENTED, which is `service` everywhere except the two
  // service-account rows (see ServiceTokenRow above).
  //
  // A refusal row whose fixture is merely a string matching no hash would be evidence about
  // hash lookup and nothing else — indistinguishable from `unknown_secret`, and green under
  // any implementation. The rows presenting a foreign credential therefore present a REAL
  // one: `service_account_prefix` a live unrevoked unexpired `pmcp_sa_` row bound to a live
  // account, `session_token` a real better-auth session token for the seeded owner.

  // §6: "The Worker verifies the service token — checking the token row's `kind` column
  // explicitly, not just the prefix — resolves the service (and its owner)". The allow-twin
  // for the nine refusals below, and the only row in the table that answers anything else.
  {
    title: "§6 · a live pmcp_svc_ token resolves to its bound service id — the allow-twin every refusal in this table is measured against",
    storedKind: "service",
    defect: "none",
    expect: "service_id",
  },
  // §6: "401 — no/invalid/expired/revoked token …". No credential at all is the baseline
  // refusal; it must be the same answer as every credential-shaped one below.
  {
    title: "§6 · no Authorization header at all resolves null",
    storedKind: "service",
    defect: "no_authorization_header",
    expect: "null",
  },
  // §6: "wrong token kind (`pmcp_sa_`, session)" — a refusal clause of its own, distinct
  // from "no/invalid … token". A service-account credential is a real credential somewhere
  // else — /connect is not that somewhere — so `storedKind` is `service_account` here: the
  // presented secret is that live row's own plaintext, and the refusal is evidence about
  // the prefix and the kind column rather than about a hash that matches nothing.
  {
    title: "§6 · a pmcp_sa_ bearer resolves null — a service-account credential means nothing on /connect",
    storedKind: "service_account",
    defect: "service_account_prefix",
    expect: "null",
  },
  // §7 step 1 / identity's resolution order, from the other side: a `pmcp_svc_` surface
  // never falls through to a session lookup either. A human's session token is not a way in.
  {
    title: "§6 · a better-auth session token in the bearer resolves null — /connect never falls through to session lookup",
    storedKind: "service",
    defect: "session_token",
    expect: "null",
  },
  // §7 step 1: "tokens in query strings are rejected" — the rule is the transport, not the
  // secret: the row's own valid token, moved out of the header, stops being a credential.
  {
    title: "§6/§7 · the valid secret in a query string resolves null — the credential is the Authorization header or nothing",
    storedKind: "service",
    defect: "query_string_token",
    expect: "null",
  },
  // §6: "no/invalid … token". A well-formed pmcp_svc_ secret matching no hash — the
  // brute-force case, answering exactly what a revoked one does.
  {
    title: "§6 · an unknown pmcp_svc_ secret resolves null",
    storedKind: "service",
    defect: "unknown_secret",
    expect: "null",
  },
  // §6: "checking the token row's `kind` column explicitly, not just the prefix". This is
  // the row that looks redundant and is not — a prefix-only implementation passes every
  // other row in this table and fails only this one.
  {
    title: "§6 · kind is read from the column, never inferred from the prefix: a pmcp_svc_ secret stored as kind 'service_account' resolves null",
    storedKind: "service_account",
    defect: "wrong_kind_column",
    expect: "null",
  },
  // §6/§15: "Token revocation: consumer tokens are checked on every request, so revocation
  // is immediate" — at the upgrade, the revoked row is worth exactly as much as no row.
  {
    title: "§6 · a revoked token resolves null",
    storedKind: "service",
    defect: "revoked",
    expect: "null",
  },
  // §6: "Expiry is checked at upgrade only — an established socket outlives its token's
  // `expires_at` until the next reconnect". This row is that check, at that moment.
  {
    title: "§6 · an expired token resolves null — expiry is judged at the upgrade",
    storedKind: "service",
    defect: "expired",
    expect: "null",
  },
  // NOT HERE, deliberately: the two referent-state refusals §6 states in the same 401
  // clause — "a token whose service row is gone or is `kind: proxy`". Both are row-level
  // verdicts identity's header assigns to the upgrade handler, and this function reads only
  // the `token` table, so seeding either state leaves it holding a fully valid credential
  // (service row deleted through registry → it answers {serviceId}, and the handler answers
  // 401) or no token row at all (deleted through §8's service_delete, which deletes the
  // token rows too → the `unknown_secret` path, proving nothing new). They are rows of
  // tunnel/lifecycle.test.ts's upgrade matrix, whose `UpgradeServiceState` names them
  // `row_deleted` and `proxy_kind`.
];

/**
 * Every namespace below is its own owner's, so the two slugs can be constants: a
 * tunneled service to bind `pmcp_svc_` credentials to, and an account to bind the
 * `pmcp_sa_` ones the foreign-credential rows present.
 */
const SERVICE_SLUG = "news";
const ACCOUNT_SLUG = "agent";

/** The /connect upgrade — the one surface a `pmcp_svc_` credential means anything on. */
const CONNECT_URL = "https://hub.example/connect";

/**
 * A well-formed `pmcp_svc_` secret that was never minted: right prefix, right shape,
 * matching no hash in any namespace — and obviously fake, so it can never be mistaken
 * for a real credential in a log or a diff.
 */
const UNMINTED_SERVICE_SECRET = "pmcp_svc_FAKE0000000000000000000000000000000000";

/** A TTL a fixture picks for itself — an override's value, never a spec-pinned window. */
const AN_HOUR_SECONDS = 3600;

/** The raw D1 reach the two cases below name their reason for: never a shortcut for state. */
type RawD1 = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
  };
};

/** The namespace every resolve row starts from: one live tunneled service, one account. */
async function seedResolveNamespace(
  svc: { revoked?: boolean; expired?: boolean } = {},
): Promise<SeededNamespace> {
  return seedNamespace(env.DB, {
    services: [{ slug: SERVICE_SLUG, kind: "tunnel", tokens: [{ as: "svc", ...svc }] }],
    accounts: [{ slug: ACCOUNT_SLUG, tokens: [{ as: "sa" }] }],
  });
}

/** The upgrade request as a client sends it: the credential rides the header, or nowhere. */
function bearerRequest(token: string): Request {
  return new Request(CONNECT_URL, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * The one state no seam can express, and the reason the row exists: `issueToken` derives
 * the prefix FROM the kind, so a `pmcp_svc_` secret sitting on a `service_account` row is
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
 * A session bearer for the seeded owner.
 *
 * GAP, and deliberately visible: seed.ts FINDINGS 3 records that better-auth is not a
 * dependency of this repo yet, so a provisioned owner has no credential row and cannot be
 * signed in — a REAL session token, which the authored row asks for, is not mintable here.
 * What this presents is session-SHAPED: a bearer carrying no `pmcp_` prefix, which is the
 * evidence the row is about (a `pmcp_svc_` surface must not fall through to a session
 * lookup). Upgrade it to a real sign-in in this one function when D4 wires better-auth.
 */
function sessionShapedBearer(): string {
  return `FAKE0000.${crypto.randomUUID()}`;
}

/**
 * The one defect the row names, introduced into the seeded namespace's otherwise-valid
 * upgrade request. Every branch presents a REAL credential or none at all — the two
 * foreign-credential rows present live rows of their own kind rather than a string that
 * merely fails a hash lookup (which is `unknown_secret`'s job and nobody else's).
 */
async function requestFor(row: ServiceTokenRow, ns: SeededNamespace): Promise<Request> {
  switch (row.defect) {
    case "none":
    case "revoked":
    case "expired":
      return bearerRequest(ns.tokens.svc.token);
    case "no_authorization_header":
      return new Request(CONNECT_URL);
    case "service_account_prefix":
      // A real, live, unrevoked credential of the kind row.storedKind names — valid on its
      // own surface, worth nothing here.
      return bearerRequest(ns.tokens.sa.token);
    case "session_token":
      return bearerRequest(sessionShapedBearer());
    case "query_string_token":
      // The row's OWN valid secret, moved out of the header: the transport is the rule.
      return new Request(`${CONNECT_URL}?token=${encodeURIComponent(ns.tokens.svc.token)}`);
    case "unknown_secret":
      return bearerRequest(UNMINTED_SERVICE_SECRET);
    case "wrong_kind_column":
      await forceKindColumn(ns.tokens.svc.id, row.storedKind);
      return bearerRequest(ns.tokens.svc.token);
  }
}

/** The request one row describes, plus the service id its allow-twin must resolve to. */
async function buildRow(row: ServiceTokenRow): Promise<{ request: Request; serviceId: string }> {
  const ns = await seedResolveNamespace({
    revoked: row.defect === "revoked",
    expired: row.defect === "expired",
  });
  return { request: await requestFor(row, ns), serviceId: ns.services[SERVICE_SLUG].id };
}

/**
 * Registers one case per row: the request built from the row resolves to the bound
 * service id, or to null. Two table-wide laws ride along, because they are properties of
 * the SET of rows rather than of any one row: every defect of the union appears exactly
 * once (a defect added to the union without a row fails here), and every `null` answer is
 * indistinguishable from every other — same value, no thrown error carrying a reason.
 */
export function runServiceTokenTable(rows: readonly ServiceTokenRow[]): void {
  // deps: test/harness/seed · server/src/identity (resolveServiceToken)
  for (const row of rows) {
    it(row.title, async () => {
      const { request, serviceId } = await buildRow(row);
      const resolved = await resolveServiceToken(request);
      if (row.expect === "service_id") expect(resolved).toEqual({ serviceId });
      else expect(resolved).toBeNull();
    });
  }
}

/**
 * The union's members at RUNTIME — the coverage oracle the table-wide law reads. Typed
 * as a total Record of the union, so a defect added to `ServiceTokenDefect` without a key
 * here fails to compile, and a key here without a row fails the law below.
 */
const ALL_DEFECTS: Record<ServiceTokenDefect, true> = {
  none: true,
  no_authorization_header: true,
  service_account_prefix: true,
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

describe("§6 · resolveServiceToken: one null for every failure", () => {
  runServiceTokenTable(serviceTokenRows);

  it("§6 · the union is exhausted: every ServiceTokenDefect has a row, and every refusing row answers the identical value", async () => {
    expect([...serviceTokenRows].map((row) => row.defect).sort()).toEqual(
      Object.keys(ALL_DEFECTS).sort(),
    );

    const refusals = serviceTokenRows.filter((row) => row.expect === "null");
    const answers: unknown[] = [];
    for (const row of refusals) {
      const { request } = await buildRow(row);
      // Any throw here fails the case: a reason carried out as an exception would be a
      // distinguishing answer just as surely as a different value.
      answers.push(await resolveServiceToken(request));
    }
    expect(answers).toHaveLength(refusals.length);
    expect(new Set(answers)).toEqual(new Set([null]));
  });
});

describe("§5 · minting and plaintext-once", () => {
  it("§5 · issueToken returns the plaintext once; listTokens shows the prefix and no surface returns the secret again", async () => {
    const ns = await seedResolveNamespace();
    const minted = ns.tokens.svc;
    const listed = tokenRow(await listTokens(ns.owner.userId), minted.id);

    expect(minted.token.startsWith("pmcp_svc_")).toBe(true);
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
    expect(await resolveServiceToken(bearerRequest(ns.tokens.svc.token))).toEqual({
      serviceId: ns.services[SERVICE_SLUG].id,
    });
  });

  it("§5 · expiry defaults by kind — a service_account token carries an expiry, a service token carries none (the bot on a home server must not silently die). The window's value is incidental (§7); its presence is not", async () => {
    const ns = await seedResolveNamespace();
    const rows = await listTokens(ns.owner.userId);
    const account = tokenRow(rows, ns.tokens.sa.id);
    const service = tokenRow(rows, ns.tokens.svc.id);

    // Read by NAME (limits.SERVICE_ACCOUNT_TOKEN_TTL_MS), so "90 d → 60 d" is a one-line
    // edit there and no churn here.
    expect(account.expiresAt).toBe(account.createdAt + SERVICE_ACCOUNT_TOKEN_TTL_MS);
    expect(service.expiresAt).toBeNull();
  });

  it("§5 · an explicit expiresIn and an explicit 'never' each override the per-kind default, in both directions", async () => {
    const ns = await seedNamespace(env.DB, {
      // The service token gets an expiry it would not have had...
      services: [
        { slug: SERVICE_SLUG, kind: "tunnel", tokens: [{ as: "svc", expiresIn: AN_HOUR_SECONDS }] },
      ],
      // ...and the service-account token loses the one it would have had.
      accounts: [{ slug: ACCOUNT_SLUG, tokens: [{ as: "sa", expiresIn: "never" }] }],
    });
    const rows = await listTokens(ns.owner.userId);
    const service = tokenRow(rows, ns.tokens.svc.id);

    expect(service.expiresAt).toBe(service.createdAt + AN_HOUR_SECONDS * 1000);
    expect(tokenRow(rows, ns.tokens.sa.id).expiresAt).toBeNull();
  });
});

describe("§8 · revoke versus delete", () => {
  it("§8 · a revoked token is refused immediately on the next resolve · twin: the same token resolved before the revoke", async () => {
    const ns = await seedResolveNamespace();
    const upgrade = () => resolveServiceToken(bearerRequest(ns.tokens.svc.token));

    expect(await upgrade()).toEqual({ serviceId: ns.services[SERVICE_SLUG].id });
    expect(await revokeToken(ns.owner.userId, ns.tokens.svc.id)).toBe(true);
    expect(await upgrade()).toBeNull();
  });

  it("§8 · revokeToken is idempotent — revoking a revoked token succeeds and changes nothing", async () => {
    const ns = await seedResolveNamespace();
    expect(await revokeToken(ns.owner.userId, ns.tokens.svc.id)).toBe(true);
    const once = tokenRow(await listTokens(ns.owner.userId), ns.tokens.svc.id);

    expect(await revokeToken(ns.owner.userId, ns.tokens.svc.id)).toBe(true);
    // Same row, same instant: the second revoke did not re-stamp the first one's time.
    expect(tokenRow(await listTokens(ns.owner.userId), ns.tokens.svc.id)).toEqual(once);
  });

  it("§8 · revokeToken answers false identically for an unknown id and for another namespace's token — one uniform not-found, so the op layer cannot leak existence", async () => {
    const mine = await seedResolveNamespace();
    const theirs = await seedResolveNamespace();

    const unknown = await revokeToken(mine.owner.userId, crypto.randomUUID());
    const foreign = await revokeToken(mine.owner.userId, theirs.tokens.svc.id);
    expect(unknown).toBe(false);
    expect(foreign).toBe(unknown);
    // The refusal is real, not cosmetic: the other namespace's credential is untouched.
    expect(tokenRow(await listTokens(theirs.owner.userId), theirs.tokens.svc.id).revokedAt).toBeNull();
  });

  it("§6 · a revoked token still appears in listTokens with revokedAt stamped — rotation state is what the listing is for · twin: the live token lists too", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: SERVICE_SLUG,
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

  it("§8 · deleteTokensFor removes the rows from the listing entirely — deletion, not revocation, is what the service_delete cascade does", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: SERVICE_SLUG, kind: "tunnel", tokens: [{ as: "svc" }, { as: "spare" }] },
      ],
      accounts: [{ slug: ACCOUNT_SLUG, tokens: [{ as: "sa" }] }],
    });

    await deleteTokensFor(ns.services[SERVICE_SLUG].id);

    // Both of the service's rows are gone — not listed as revoked — and the account's
    // credential, bound to another id, is untouched.
    expect((await listTokens(ns.owner.userId)).map((row) => row.id)).toEqual([ns.tokens.sa.id]);
    expect(await resolveServiceToken(bearerRequest(ns.tokens.svc.token))).toBeNull();
  });

  it("§5 · deleteTokensFor is keyed by opaque id: recreating a deleted service's slug resurrects no credential", async () => {
    const before = await seedResolveNamespace();
    await deleteTokensFor(before.services[SERVICE_SLUG].id);

    // The service ROW's deletion is registry's primitive, not a seed seam, so the
    // recreation is seeded as a second namespace: same slug, a fresh opaque id — which is
    // the whole binding a token has.
    const after = await seedNamespace(env.DB, {
      services: [{ slug: SERVICE_SLUG, kind: "tunnel" }],
    });

    expect(after.services[SERVICE_SLUG].id).not.toBe(before.services[SERVICE_SLUG].id);
    expect(await listTokens(after.owner.userId)).toEqual([]);
    expect(await resolveServiceToken(bearerRequest(before.tokens.svc.token))).toBeNull();
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
      services: [
        {
          slug: SERVICE_SLUG,
          kind: "tunnel",
          tokens: [{ as: "live" }, { as: "expired", expired: true }, { as: "revoked", revoked: true }],
        },
      ],
      accounts: [{ slug: ACCOUNT_SLUG, tokens: [{ as: "account" }] }],
    });
    // issueToken TRUSTS refId (its contract header) — so a credential bound to nothing is
    // mintable, and belongs to no namespace's listing.
    const orphan = await issueToken({ kind: "service", refId: `gone-${crypto.randomUUID()}` });

    const rows = await listTokens(ns.owner.userId);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [ns.tokens.live.id, ns.tokens.expired.id, ns.tokens.revoked.id, ns.tokens.account.id].sort(),
    );
    expect(rows.some((row) => row.id === orphan.id)).toBe(false);

    // Each state is readable in its row — that is what the listing is for.
    const live = tokenRow(rows, ns.tokens.live.id);
    expect([live.revokedAt, live.lastUsedAt]).toEqual([null, null]);
    expect(live.refSlug).toBe(SERVICE_SLUG);
    expect(tokenRow(rows, ns.tokens.expired.id).expiresAt).toBeLessThan(Date.now());
    expect(tokenRow(rows, ns.tokens.revoked.id).revokedAt).toBeTypeOf("number");
    expect(tokenRow(rows, ns.tokens.account.id).refSlug).toBe(ACCOUNT_SLUG);

    // Newest first (non-strict: two mints can share a millisecond).
    const created = rows.map((row) => row.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it("§7 · a successful resolve stamps last_used_at and a refused one stamps nothing — the stamping cadence itself is incidental (§7) and is not asserted", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: SERVICE_SLUG,
          kind: "tunnel",
          tokens: [{ as: "live" }, { as: "dead", revoked: true }],
        },
      ],
    });
    const before = await listTokens(ns.owner.userId);
    expect(tokenRow(before, ns.tokens.live.id).lastUsedAt).toBeNull();
    expect(tokenRow(before, ns.tokens.dead.id).lastUsedAt).toBeNull();

    expect(await resolveServiceToken(bearerRequest(ns.tokens.live.token))).not.toBeNull();
    expect(await resolveServiceToken(bearerRequest(ns.tokens.dead.token))).toBeNull();

    const after = await listTokens(ns.owner.userId);
    // A number, not a value: how coarse the stamp is belongs to limits, not to this case.
    expect(tokenRow(after, ns.tokens.live.id).lastUsedAt).toBeTypeOf("number");
    expect(tokenRow(after, ns.tokens.dead.id).lastUsedAt).toBeNull();
  });
});
