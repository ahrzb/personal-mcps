// seed.ts — the namespace fixture: every suite's "given" clause, built against the REAL
// D1 control plane through the production seams and nothing else.
//
// WHAT THIS PINS, by existing at all: that a namespace is constructible from the outside.
// Strategy §6 makes this harness a design check rather than a convenience — if seeding a
// namespace is awkward, a production seam is wrong. The rule that keeps that true is
// absolute: THIS MODULE NEVER WRITES A ROW ITSELF. No INSERT, no better-auth table poke,
// no D1 statement of its own. Every state below is reached through Registry, identity, or
// admin, exactly as a request would reach it; a state that cannot be reached that way is
// recorded in FINDINGS instead of being conjured behind the seam's back. (Strategy §9:
// D1, sibling modules, and the DO are never faked — a seed that hand-writes rows is
// faking a sibling module in the setup phase, which is the same lie one step earlier.)
//
// PROJECTS: `worker` — real D1, per-file storage isolation, so a seed is scoped to its
// file and vanishes with it; and `tunnel` — serial, `--no-isolate`, where storage is
// SHARED across files, so every tunnel-project seed must own unique slugs (uniqueSlug)
// and must be torn down by the fixture that created it (SeededNamespace.teardown). Never
// `unit`: nothing here is pure and nothing here is fast.
//
// NOT THIS MODULE'S BUSINESS: migrations (applyD1Migrations runs once in each workerd
// project's setup file, strategy §2 — idempotent, so re-runs are safe), the DO's cached
// catalog (fake-service.ts warms it by registering), and upstream credentials (only
// upstream.setHeaders / the connect flow may write an envelope, which is the point of
// upstream-credentials.test.ts).
//
// deps: registry.Registry · identity.issueToken/revokeToken/deleteTokensFor · admin.provisionUser/deleteUser · cloudflare:test env.DB (the real D1 binding)

import type {
  GrantEntry,
  RoleDeclaration,
  ServiceAccount,
  ServiceDetail,
  ServiceKind,
} from "../../src/registry";
import type { TokenKind } from "../../src/identity";

/** The request-scoped Cloudflare D1 binding, handed in from `cloudflare:test` env.DB. */
type D1Database = unknown;

/**
 * FINDINGS — what building this harness against the skeletons reported back. Each is a
 * question for the owner, not a workaround taken here; the seam stays unbent.
 *
 * 1. A tunneled service's declared roles are reachable ONLY through
 *    `Registry.upsertDeclaredRoles`, which also stamps last-connected — so "a tunneled
 *    service that declares roles and has never connected" is not a seedable state. Any
 *    fixture wanting declared tunnel roles must register a real fake service first
 *    (fake-service.ts), which puts those fixtures in the `tunnel` project even when the
 *    assertion has nothing to do with sockets. ServiceSpec.roles below therefore means
 *    "proxy roles" and is rejected on tunnel kind, matching createService.
 *
 * 2. RESOLVED 2026-08-25. `identity.issueToken` could not mint an ALREADY-EXPIRED token —
 *    `expiresIn` counts seconds forward and identity read no clock but the global one —
 *    while `auth-matrix.test.ts` needs expired-beside-live to satisfy §9 rule 2 (every
 *    refusal carries its allow-twin). Of the three candidates (a negative `expiresIn`, an
 *    injected clock, dropping the row) the middle one was pinned: `resolvePrincipal`,
 *    `resolveServiceToken` and `issueToken` each take an optional `now?: () => number`,
 *    the same seam `ApprovalsConfig.now` already is, omitted by every production caller.
 *    The MECHANISM is therefore: ISSUE at a fake t0 with a short `expiresIn`, then RESOLVE
 *    past that expiry — under the real clock, or under a `now()` moved forward. Nothing
 *    sleeps, no test-only mint-a-dead-token affordance exists, and the harness still never
 *    reaches past the seam: `expired` is minted through the production path like every
 *    other state here. TokenSpec.expired below is that mechanism's whole surface.
 *
 * 3. `admin.provisionUser` returns a plaintext password and writes an audit row
 *    (principal `bootstrap`). Every seeded namespace therefore starts with audit rows and
 *    one live human credential — `hygiene.test.ts`'s sentinel sweep must expect the
 *    bootstrap row to exist and must prove the password appears in no column.
 *
 * 4. There is no seam for granting anything on the builtin `pmcp` service, because it has
 *    no row id (registry's PMCP_SLUG comment). The harness cannot even express the
 *    illegal state — the reservation is structural, exactly as §8 claims.
 */

/** The namespace owner, as provisioned. `password` exists only here and only once (§12). */
export type SeededOwner = {
  userId: string;
  username: string;
  password: string;
};

/** A seeded service, reduced to what fixtures address it by: the opaque DO key and the slug. */
export type SeededService = {
  id: string;
  slug: string;
  kind: ServiceKind;
};

/** A seeded service account — `id` is what grants and approvals key on. */
export type SeededAccount = {
  id: string;
  slug: string;
};

/**
 * A minted credential with its plaintext, which no production read path can ever return
 * again. `refSlug` records what it is bound to so a fixture can say "the news service's
 * token" without threading ids.
 */
export type SeededToken = {
  id: string;
  kind: TokenKind;
  refSlug: string;
  /** The full `pmcp_sa_…` / `pmcp_svc_…` string — present only in this object. */
  token: string;
};

/**
 * How a fixture asks for a credential. `never` and a seconds count pass straight to
 * identity.issueToken; `revoked` mints and then revokes through revokeToken, and `expired`
 * mints against a backdated clock — each the only honest way to reach the row it names.
 */
export type TokenSpec = {
  /** Fixture-local handle: the key this token appears under in SeededNamespace.tokens. */
  as: string;
  expiresIn?: number | "never";
  revoked?: boolean;
  /**
   * Mint a token whose expiry has ALREADY passed (FINDINGS 2): issueToken is called with
   * an injected `now()` at a fake t0 far enough back that `expiresIn` has elapsed by the
   * time anything resolves it. The row is written by the production path exactly as a live
   * one is — the only difference is which instant identity was told it was — so a fixture
   * gets expired-beside-live without sleeping and without a mint-dead-token affordance.
   * Rejected together with `expiresIn: "never"`, which has no expiry to have passed.
   */
  expired?: boolean;
};

/**
 * One service in a namespace spec, in the vocabulary of registry.ServiceDraft plus the
 * two states that are separate primitives there (archived) or a separate module
 * (tokens). Kind-shape rules are NOT re-checked here — createService rejects a proxied
 * draft without an endpoint and a tunneled draft carrying roles, and a fixture that
 * writes an impossible spec deserves that error rather than a friendlier one from the
 * harness.
 */
export type ServiceSpec = {
  slug: string;
  kind: ServiceKind;
  name?: string;
  description?: string;
  /** proxy kind only — tunnel roles arrive at registration (FINDINGS 1). */
  roles?: RoleDeclaration;
  redact?: Record<string, string[]>;
  redactResults?: Record<string, string[]>;
  /** absent leaves createService's by-kind default in place (§15) — the point of several rows. */
  logBodies?: boolean;
  upstreamUrl?: string;
  upstreamAuthMode?: "headers" | "oauth";
  forwardIdentity?: boolean;
  /** Applied after creation via archiveService — archived is a stage, not a create field. */
  archived?: boolean;
  /** `pmcp_svc_` credentials for this service; rejected by token_issue on proxy kind. */
  tokens?: TokenSpec[];
};

/**
 * One service account plus the grants it holds, keyed by service slug — the same shape
 * account_list returns inline, so a fixture's "given" reads like the assertion's "when".
 */
export type AccountSpec = {
  slug: string;
  name?: string;
  description?: string;
  grants?: Record<string, GrantEntry[]>;
  /** `pmcp_sa_` credentials for this account. */
  tokens?: TokenSpec[];
};

/**
 * A whole namespace as one value. `username` is optional so worker-project fixtures can
 * take a generated one; tunnel-project fixtures should pass a uniqueSlug-derived name,
 * since that project shares storage across files.
 */
export type NamespaceSpec = {
  username?: string;
  services?: ServiceSpec[];
  accounts?: AccountSpec[];
};

/**
 * The seeded namespace handle. Services and accounts are keyed by slug and tokens by
 * their spec's `as`, so assertions never carry ids around. `teardown` is REQUIRED in the
 * `tunnel` project (shared storage) and merely tidy in `worker` (per-file isolation
 * already discards everything).
 */
export type SeededNamespace = {
  owner: SeededOwner;
  services: Record<string, SeededService>;
  accounts: Record<string, SeededAccount>;
  tokens: Record<string, SeededToken>;
  teardown(): Promise<void>;
};

/**
 * A slug/username unique within one test run — the `tunnel` project's answer to shared
 * storage. Deterministic within a file and collision-free across files; keep it inside
 * the `[a-z0-9-]` charset both slugs and usernames are pinned to (§2), which is exactly
 * why fixtures must not hand-roll their own suffixes.
 */
export function uniqueSlug(prefix: string): string {
  // deps: crypto.randomUUID
  throw new Error("unimplemented");
}

/**
 * Provision a namespace owner through the ONE user-creation seam (§12's
 * `admin.provisionUser`, the same code POST /internal/users runs) and return the
 * once-only password with it. Deliberately not a better-auth call of its own: if a test
 * can create a user some other way, so can a bug.
 */
export async function seedOwner(db: D1Database, username?: string): Promise<SeededOwner> {
  // deps: admin.provisionUser · uniqueSlug
  throw new Error("unimplemented");
}

/**
 * Create one service through `Registry.createService`, then apply the states that are
 * separate primitives: archived via archiveService, proxied declarations via the draft
 * itself. Returns the row as registry reports it, so a fixture asserting on defaults
 * (logBodies by kind, forwardIdentity false) reads the real resolved value rather than
 * the spec's absence.
 */
export async function seedService(
  db: D1Database,
  ownerId: string,
  spec: ServiceSpec,
): Promise<ServiceDetail> {
  // deps: registry.Registry.createService · registry.Registry.archiveService
  throw new Error("unimplemented");
}

/** Create one service account through `Registry.createAccount`. Born credential-less. */
export async function seedAccount(
  db: D1Database,
  ownerId: string,
  spec: AccountSpec,
): Promise<ServiceAccount> {
  // deps: registry.Registry.createAccount
  throw new Error("unimplemented");
}

/**
 * Replace the full grant set for one (account, service) pair through
 * `Registry.setGrants`, returning its warnings verbatim. Warnings are RETURNED, never
 * swallowed: a fixture that silently accumulates "role not declared" warnings is a
 * fixture drifting away from the state it claims to establish.
 */
export async function seedGrants(
  db: D1Database,
  accountId: string,
  serviceId: string,
  entries: GrantEntry[],
): Promise<string[]> {
  // deps: registry.Registry.setGrants
  throw new Error("unimplemented");
}

/**
 * Mint one credential through `identity.issueToken` and, when the spec says so, revoke it
 * through `identity.revokeToken` — the only path to a revoked row that a revoked row can
 * actually be reached by. An `expired` spec mints through the same issueToken with a
 * backdated `now()` (FINDINGS 2), so an expired row is as production-shaped as a live one.
 * The plaintext is returned once and held only in the fixture's SeededNamespace; nothing
 * here stores or logs it.
 */
export async function seedToken(
  db: D1Database,
  ownerId: string,
  kind: TokenKind,
  refId: string,
  refSlug: string,
  spec: TokenSpec,
): Promise<SeededToken> {
  // deps: identity.issueToken (with its optional now()) · identity.revokeToken
  throw new Error("unimplemented");
}

/**
 * The one call most fixtures make: a whole namespace — owner, services, accounts, grants,
 * credentials — from a single declarative spec, in the order the domain requires
 * (owner → services and accounts → grants → tokens), returning every plaintext and a
 * teardown. Composition only: it adds no state the primitives above cannot each reach.
 */
export async function seedNamespace(
  db: D1Database,
  spec: NamespaceSpec,
): Promise<SeededNamespace> {
  // deps: seedOwner · seedService · seedAccount · seedGrants · seedToken
  throw new Error("unimplemented");
}

/**
 * Remove a seeded namespace through `admin.deleteUser` — the same teardown §15 pins for
 * real user deletion (per-service cascade, sever, DO wipe, then the row cascade), so the
 * `tunnel` project's shared storage is left genuinely clean rather than
 * approximately-clean. Idempotent, like the op it fronts: tearing down twice is not an
 * error, and neither is tearing down a namespace a failing test never finished building.
 */
export async function resetNamespace(db: D1Database, username: string): Promise<void> {
  // deps: admin.deleteUser
  throw new Error("unimplemented");
}
