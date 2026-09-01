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
// catalog (fake-app.ts warms it by registering), and upstream credentials (only
// upstream.setHeaders / the connect flow may write an envelope, which is the point of
// upstream-credentials.test.ts).
//
// deps: registry.Registry · identity.issueToken/revokeToken/deleteTokensFor/setPassword · admin.provisionUser/deleteUser · cloudflare:test env.DB (the real D1 binding)

import { deleteUser, provisionUser } from "../../src/admin";
import { issueToken, revokeToken, setPassword } from "../../src/identity";
import { Registry } from "../../src/registry";
import type {
  GrantEntry,
  RoleDeclaration,
  Agent,
  AppDetail,
  AppKind,
} from "../../src/registry";
import type { TokenKind } from "../../src/identity";

/** The request-scoped Cloudflare D1 binding, handed in from `cloudflare:test` env.DB. */
type D1Database = unknown;

/**
 * FINDINGS — what building this harness against the skeletons reported back. Each is a
 * question for the owner, not a workaround taken here; the seam stays unbent.
 *
 * 1. A tunneled app's declared roles are reachable ONLY through
 *    `Registry.upsertDeclaredRoles`, which also stamps last-connected — so "a tunneled
 *    app that declares roles and has never connected" is not a seedable state. Any
 *    fixture wanting declared tunnel roles must register a real fake app first
 *    (fake-app.ts), which puts those fixtures in the `tunnel` project even when the
 *    assertion has nothing to do with sockets. AppSpec.roles below therefore means
 *    "proxy roles" and is rejected on tunnel kind, matching createApp.
 *
 * 2. RESOLVED 2026-08-25. `identity.issueToken` could not mint an ALREADY-EXPIRED token —
 *    `expiresIn` counts seconds forward and identity read no clock but the global one —
 *    while `auth-matrix.test.ts` needs expired-beside-live to satisfy §9 rule 2 (every
 *    refusal carries its allow-twin). Of the three candidates (a negative `expiresIn`, an
 *    injected clock, dropping the row) the middle one was pinned: `resolvePrincipal`,
 *    `resolveAppToken` and `issueToken` each take an optional `now?: () => number`,
 *    the same seam `ApprovalsConfig.now` already is, omitted by every production caller.
 *    The MECHANISM is therefore: ISSUE at a fake t0 with a short `expiresIn`, then RESOLVE
 *    past that expiry — under the real clock, or under a `now()` moved forward. Nothing
 *    sleeps, no test-only mint-a-dead-token affordance exists, and the harness still never
 *    reaches past the seam: `expired` is minted through the production path like every
 *    other state here. TokenSpec.expired below is that mechanism's whole surface.
 *
 * 3. `admin.provisionUser` writes an audit row (principal `bootstrap`), so every seeded
 *    namespace starts with audit rows — `hygiene.test.ts`'s sentinel sweep must expect the
 *    bootstrap row to exist. It does NOT hand back a human credential: the seam writes the
 *    `user` row alone and returns `{ userId }`.
 *
 *    RESOLVED 2026-08-25 (D4): better-auth is a dependency now, and the password half of
 *    §12's create — the credential account behind the `user` row — is `identity.setPassword`,
 *    the one place in the system a password is written. `seedOwnerCredential` below fronts
 *    it, so a fixture that needs a real session asks for one explicitly and everything
 *    else keeps paying nothing for it (the hash is deliberately slow). `SeededOwner` still
 *    carries no password: the credential is a separate act, not a property of every owner.
 *
 * 4. There is no seam for granting anything on the builtin `pmcp` app, because it has
 *    no row id (registry's PMCP_SLUG comment). The harness cannot even express the
 *    illegal state — the reservation is structural, exactly as §8 claims.
 *
 * 5. `seedOwner` and `resetNamespace` take NO `db`, while seedApp/seedAgent/
 *    seedGrants do: identity and admin resolve D1 ambiently through `cloudflare:workers`,
 *    registry takes it explicitly. The asymmetric signature is the honest one — a uniform
 *    `db` on the two builders that discard it would say the owner row and every token land
 *    in the handle the fixture holds, and they do not.
 *
 * 6. `migrations.test.ts` needs something this module deliberately does NOT export: a
 *    valid COLUMN row per table, overridable field by field, for constraints that must be
 *    exercised as raw writes (a `app.kind` of "websocket" cannot be reached through
 *    createApp, which is the point of the constraint). That builder writes no row
 *    either — it returns values the suite binds itself — but its shape is the schema's,
 *    not the domain's, so it belongs beside the table it describes rather than here, where
 *    every export is phrased in registry/identity/admin vocabulary.
 */

/** The namespace owner, as provisioned — id and name only, no sign-in (FINDINGS 3). */
export type SeededOwner = {
  userId: string;
  username: string;
};

/** A seeded app, reduced to what fixtures address it by: the opaque DO key and the slug. */
export type SeededApp = {
  id: string;
  slug: string;
  kind: AppKind;
};

/** A seeded agent — `id` is what grants and approvals key on. */
export type SeededAgent = {
  id: string;
  slug: string;
};

/**
 * A minted credential with its plaintext, which no production read path can ever return
 * again. `refSlug` records what it is bound to so a fixture can say "the news app's
 * token" without threading ids.
 */
export type SeededToken = {
  id: string;
  kind: TokenKind;
  refSlug: string;
  /** The full `pmcp_agt_…` / `pmcp_app_…` string — present only in this object. */
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
 * One app in a namespace spec, in the vocabulary of registry.AppDraft plus the
 * two states that are separate primitives there (archived) or a separate module
 * (tokens). Kind-shape rules are NOT re-checked here — createApp rejects a proxied
 * draft without an endpoint and a tunneled draft carrying roles, and a fixture that
 * writes an impossible spec deserves that error rather than a friendlier one from the
 * harness.
 */
export type AppSpec = {
  slug: string;
  kind: AppKind;
  name?: string;
  description?: string;
  /** proxy kind only — tunnel roles arrive at registration (FINDINGS 1). */
  roles?: RoleDeclaration;
  redact?: Record<string, string[]>;
  redactResults?: Record<string, string[]>;
  /** absent leaves createApp's by-kind default in place (§15) — the point of several rows. */
  logBodies?: boolean;
  upstreamUrl?: string;
  upstreamAuthMode?: "headers" | "oauth";
  forwardIdentity?: boolean;
  /** Applied after creation via archiveApp — archived is a stage, not a create field. */
  archived?: boolean;
  /** `pmcp_app_` credentials for this app; rejected by token_issue on proxy kind. */
  tokens?: TokenSpec[];
};

/**
 * One agent plus the grants it holds, keyed by app slug — the same shape
 * agent_list returns inline, so a fixture's "given" reads like the assertion's "when".
 */
export type AgentSpec = {
  slug: string;
  name?: string;
  description?: string;
  grants?: Record<string, GrantEntry[]>;
  /** `pmcp_agt_` credentials for this agent. */
  tokens?: TokenSpec[];
};

/**
 * A whole namespace as one value. `username` is optional so worker-project fixtures can
 * take a generated one; tunnel-project fixtures should pass a uniqueSlug-derived name,
 * since that project shares storage across files.
 */
export type NamespaceSpec = {
  username?: string;
  apps?: AppSpec[];
  agents?: AgentSpec[];
};

/**
 * The seeded namespace handle. Apps and agents are keyed by slug and tokens by
 * their spec's `as`, so assertions never carry ids around. `teardown` is REQUIRED in the
 * `tunnel` project (shared storage) and merely tidy in `worker` (per-file isolation
 * already discards everything).
 */
export type SeededNamespace = {
  owner: SeededOwner;
  apps: Record<string, SeededApp>;
  agents: Record<string, SeededAgent>;
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
  return `${prefix}-${RUN_ID}-${++slugCounter}`;
}

/**
 * A random tag per module instance plus a monotonic counter — the PAIR is what holds in
 * the `tunnel` project either way its shared runtime falls: distinct module instances
 * differ in RUN_ID, and one instance shared across files (`isolate: false`) keeps
 * counting. Hex and hyphens only, so the result stays inside the [a-z0-9-] charset slugs
 * and usernames are both pinned to (§2).
 */
const RUN_ID = crypto.randomUUID().slice(0, 8);
let slugCounter = 0;

/**
 * The fixture-local TTL for a TokenSpec.expired mint, and the extra margin its backdated
 * t0 carries. Not a limits.ts constant: nothing in the spec pins how long a dead fixture
 * token was alive for — the only property that matters is `t0 + ttl` sitting safely in the
 * past by the time anything resolves it.
 */
const EXPIRED_TOKEN_TTL_SECONDS = 60;
const EXPIRED_TOKEN_BACKDATE_MS = 60_000;

/**
 * Provision a namespace owner through the ONE user-creation seam (§12's
 * `admin.provisionUser`, the same code POST /internal/users runs). Deliberately not a
 * better-auth call of its own: if a test can create a user some other way, so can a bug.
 * Takes no `db` because the seam it fronts takes none (FINDINGS 5).
 */
export async function seedOwner(username?: string): Promise<SeededOwner> {
  // deps: admin.provisionUser · uniqueSlug
  const name = username ?? uniqueSlug("owner");
  const { userId } = await provisionUser(name);
  return { userId, username: name };
}

/**
 * The password every seeded owner that asks for one gets. A constant, and obviously fake:
 * it authenticates exactly one throwaway namespace inside one isolated test database, and
 * anything that looks like a real credential in a fixture is a credential someone will
 * one day paste somewhere real.
 */
export const SEEDED_OWNER_PASSWORD = "FAKE0000-seeded-owner-password";

/**
 * Make a seeded owner signable-in — the session-capable half of `seedOwner`, opt-in
 * because better-auth's password hash is (correctly) slow and most fixtures never need a
 * human. Goes through `identity.setPassword`, the same seam §12's `create` uses, so the
 * credential a fixture signs in with is the one the bootstrap script would have made.
 * Returns the password so the call site reads without a second import.
 */
export async function seedOwnerCredential(userId: string): Promise<string> {
  // deps: identity.setPassword
  await setPassword(userId, SEEDED_OWNER_PASSWORD);
  return SEEDED_OWNER_PASSWORD;
}

/** A signed-in owner as a client holds the session: the bearer token, and the browser
 *  cookie (`name=value`, signature included) the same sign-in set. */
export type SeededSession = { token: string; cookie: string };

/**
 * Sign a seeded owner in — the only way a session exists is for someone to sign in, so
 * this drives the real route through `exports.default.fetch` rather than reaching for
 * better-auth, which is identity's alone to touch. Gives the owner a credential first, so
 * one call is the whole "this fixture has a human" story.
 *
 * The composition root is imported DYNAMICALLY: every worker and tunnel suite imports this
 * harness, and only the two that mint a session should have to load the whole worker (and
 * fail when something unrelated to them cannot).
 */
export async function seedOwnerSession(owner: SeededOwner): Promise<SeededSession> {
  // deps: seedOwnerCredential · ../../src/index (default.fetch)
  const { default: worker } = await import("../../src/index");
  const { env } = await import("cloudflare:test");
  const bindings = env as unknown as { PUBLIC_ORIGIN: string };
  await seedOwnerCredential(owner.userId);
  const response = await worker.fetch(
    new Request(`${bindings.PUBLIC_ORIGIN}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: bindings.PUBLIC_ORIGIN },
      body: JSON.stringify({ username: owner.username, password: SEEDED_OWNER_PASSWORD }),
    }),
    env as never,
  );
  if (response.status !== 200) {
    throw new Error(`seedOwnerSession: sign-in failed ${response.status} ${await response.text()}`);
  }
  const { token } = (await response.json()) as { token: string };
  // The session cookie is the one carrying this token plus its signature; better-auth
  // names it (`__Secure-` prefixed under an https origin), so the name is read, not spelled.
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .find((pair) => pair.includes(`=${token}.`));
  if (cookie === undefined) throw new Error("seedOwnerSession: sign-in set no session cookie");
  return { token, cookie };
}

/**
 * Create one app through `Registry.createApp`, then apply the states that are
 * separate primitives: archived via archiveApp, proxied declarations via the draft
 * itself. Returns the row as registry reports it, so a fixture asserting on defaults
 * (logBodies by kind, forwardIdentity false) reads the real resolved value rather than
 * the spec's absence.
 */
export async function seedApp(
  db: D1Database,
  ownerId: string,
  spec: AppSpec,
): Promise<AppDetail> {
  // deps: registry.Registry.createApp · registry.Registry.archiveApp
  const registry = new Registry(db);
  const created = await registry.createApp({
    ownerId,
    slug: spec.slug,
    name: spec.name ?? spec.slug,
    description: spec.description,
    kind: spec.kind,
    upstreamUrl: spec.upstreamUrl,
    upstreamAuthMode: spec.upstreamAuthMode,
    forwardIdentity: spec.forwardIdentity,
    roles: spec.roles,
    redact: spec.redact,
    redactResults: spec.redactResults,
    logBodies: spec.logBodies,
  });
  if (!spec.archived) return created;
  // Archived is a stage, not a create field: re-read so the caller sees the row as registry
  // reports it AFTER the flag lands, rather than createApp's pre-archive answer.
  await registry.archiveApp(created.id);
  const archived = await registry.getApp(ownerId, spec.slug);
  if (!archived) throw new Error(`seedApp: "${spec.slug}" vanished between create and archive`);
  return archived;
}

/** Create one agent through `Registry.createAgent`. Born credential-less. */
export async function seedAgent(
  db: D1Database,
  ownerId: string,
  spec: AgentSpec,
): Promise<Agent> {
  // deps: registry.Registry.createAgent
  return new Registry(db).createAgent({
    ownerId,
    slug: spec.slug,
    name: spec.name ?? spec.slug,
    description: spec.description,
  });
}

/**
 * Replace the full grant set for one (agent, app) pair through
 * `Registry.setGrants`, returning its warnings verbatim. Warnings are RETURNED, never
 * swallowed: a fixture that silently accumulates "role not declared" warnings is a
 * fixture drifting away from the state it claims to establish.
 */
export async function seedGrants(
  db: D1Database,
  agentId: string,
  appId: string,
  entries: GrantEntry[],
): Promise<string[]> {
  // deps: registry.Registry.setGrants
  return new Registry(db).setGrants(agentId, appId, entries);
}

/**
 * Mint one credential through `identity.issueToken` and, when the spec says so, revoke it
 * through `identity.revokeToken` — the only path to a revoked row that a revoked row can
 * actually be reached by. An `expired` spec mints through the same issueToken with a
 * backdated `now()` (FINDINGS 2), so an expired row is as production-shaped as a live one.
 * The plaintext is returned once and held only in the fixture's SeededNamespace; nothing
 * here stores or logs it. Takes no `db`, like the identity seam it fronts (FINDINGS 5).
 */
export async function seedToken(
  ownerId: string,
  kind: TokenKind,
  refId: string,
  refSlug: string,
  spec: TokenSpec,
): Promise<SeededToken> {
  // deps: identity.issueToken (with its optional now()) · identity.revokeToken
  let issued: { id: string; token: string };
  if (spec.expired) {
    if (spec.expiresIn === "never") {
      throw new Error(`seedToken: "${spec.as}" cannot be both expired and never-expiring`);
    }
    // FINDINGS 2: mint at a t0 whose expiry has already elapsed under the real clock, so a
    // dead row is written by the same production path as a live one.
    const ttlSeconds = spec.expiresIn ?? EXPIRED_TOKEN_TTL_SECONDS;
    const mintedAt = Date.now() - ttlSeconds * 1000 - EXPIRED_TOKEN_BACKDATE_MS;
    issued = await issueToken({ kind, refId, expiresIn: ttlSeconds }, () => mintedAt);
  } else {
    issued = await issueToken({ kind, refId, expiresIn: spec.expiresIn });
  }
  if (spec.revoked) await revokeToken(ownerId, issued.id);
  return { id: issued.id, kind, refSlug, token: issued.token };
}

/**
 * The one call most fixtures make: a whole namespace — owner, apps, agents, grants,
 * credentials — from a single declarative spec, in the order the domain requires
 * (owner → apps and agents → grants → tokens), returning every plaintext and a
 * teardown. Composition only: it adds no state the primitives above cannot each reach.
 */
export async function seedNamespace(
  db: D1Database,
  spec: NamespaceSpec,
): Promise<SeededNamespace> {
  // deps: seedOwner · seedApp · seedAgent · seedGrants · seedToken
  const owner = await seedOwner(spec.username);
  const apps: Record<string, SeededApp> = {};
  const agents: Record<string, SeededAgent> = {};
  const tokens: Record<string, SeededToken> = {};

  for (const app of spec.apps ?? []) {
    const { id, slug, kind } = await seedApp(db, owner.userId, app);
    apps[slug] = { id, slug, kind };
  }
  for (const agent of spec.agents ?? []) {
    const { id, slug } = await seedAgent(db, owner.userId, agent);
    agents[slug] = { id, slug };
  }

  for (const agent of spec.agents ?? []) {
    for (const [slug, entries] of Object.entries(agent.grants ?? {})) {
      const app = apps[slug];
      if (!app) {
        throw new Error(`seedNamespace: agent "${agent.slug}" grants on unseeded app "${slug}"`);
      }
      const warnings = await seedGrants(db, agents[agent.slug].id, app.id, entries);
      // Surfaced, never swallowed: warnings are legitimate here (a tunneled app's roles
      // are undeclared until it first connects — FINDINGS 1), so they print rather than
      // throw, and a fixture drifting from the state it claims is visible in the run log.
      if (warnings.length > 0) {
        console.warn(`seedNamespace: grants ${agent.slug} → ${slug}: ${warnings.join("; ")}`);
      }
    }
  }

  async function mint(kind: TokenKind, refId: string, refSlug: string, specs: TokenSpec[] = []) {
    for (const spec of specs) {
      if (tokens[spec.as]) throw new Error(`seedNamespace: duplicate token handle "${spec.as}"`);
      tokens[spec.as] = await seedToken(owner.userId, kind, refId, refSlug, spec);
    }
  }
  for (const app of spec.apps ?? []) {
    await mint("app", apps[app.slug].id, app.slug, app.tokens);
  }
  for (const agent of spec.agents ?? []) {
    await mint("agent", agents[agent.slug].id, agent.slug, agent.tokens);
  }

  return {
    owner,
    apps,
    agents,
    tokens,
    teardown: () => resetNamespace(owner.username),
  };
}

/**
 * Remove a seeded namespace through `admin.deleteUser` — the same teardown §15 pins for
 * real user deletion (per-app cascade, sever, DO wipe, then the row cascade), so the
 * `tunnel` project's shared storage is left genuinely clean rather than
 * approximately-clean. Idempotent, like the op it fronts: tearing down twice is not an
 * error, and neither is tearing down a namespace a failing test never finished building.
 * Takes no `db`, like the op it fronts (FINDINGS 5).
 */
export async function resetNamespace(username: string): Promise<void> {
  // deps: admin.deleteUser
  await deleteUser(username);
}
