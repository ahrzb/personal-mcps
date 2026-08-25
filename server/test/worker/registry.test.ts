// registry.test.ts — the domain model against real D1: what a `Registry` method does to
// a row, and what the next read sees. It pins the rules that only exist once a database
// is underneath — slug uniqueness per owner, the reserved `pmcp` slug, archived as a row
// flag rather than a lookup filter, the request-time re-read that makes a widened role
// take effect on the next call, the auth-flip that clears the credential envelope in the
// SAME write, textual drift on re-declaration, grant validation differing by kind, and
// §15's `log_bodies` resolving to a concrete column at create time (tunnel on, proxy
// off) rather than to a "default" the readers would each have to interpret.
//
// It deliberately does NOT pin the pure seams this module also exports: matchesPattern,
// buildToolFilter, writeOnlyPaths and applyRedaction are `deps: none` functions and live
// in unit/pattern.test.ts, unit/filter.test.ts and unit/redact.test.ts, where a table
// costs microseconds. What lands here is only what needs the row.
//
// Project: `worker` — real D1, every sibling real, no socket and no DO, so it runs
// parallel under per-file storage isolation. Cases are order-independent; the drift and
// re-read cases each seed their own service rather than leaning on a neighbour's.
//
// deps: test/harness/seed (namespace, services, accounts) · server/src/registry
// (Registry, PMCP_SLUG) · server/src/upstream (connectionStatus — the observable read of
// the envelope column registry only ever clears) · env.DB (real D1)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PMCP_SLUG, Registry } from "../../src/registry";
import type {
  AccessMode,
  GrantEntry,
  RoleDeclaration,
  ServiceDetail,
  ServiceKind,
} from "../../src/registry";
import { connectionStatus } from "../../src/upstream";
import { seedNamespace } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * One slug rule, stated as the slug it refuses beside the nearest slug it accepts.
 *
 * Pairing is structural (§9 rule 2): a `createService` that threw on everything would
 * satisfy a refusals-only table. Keeping `accepted` one edit away from `rejected` is
 * also what makes the row evidence about `rule` — "pmcp" refused beside "pmcp-tools"
 * accepted says the reservation bites; refused beside an unrelated slug says nothing.
 */
export type SlugRuleRow = {
  title: string;
  /** both surfaces enforce the same charset; only services carry the reservation */
  target: "service" | "account";
  rule: "charset" | "reserved" | "duplicate";
  rejected: string;
  accepted: string;
};

/**
 * One `setGrants` call against one service's declaration, and what it is allowed to
 * store.
 *
 * The three outcomes are the whole rule and the reason kind matters: a proxied service's
 * declaration is complete by construction (config defines it), so an undeclared role is
 * an owner error; a tunneled declaration arrives at registration, so the config file may
 * legitimately be ahead of the first connection and an undeclared role warns and stores.
 * `probe` closes the loop — it asserts the grant landed as an observable verdict through
 * resolveAccess, not merely that setGrants returned without complaint.
 */
export type GrantValidationRow = {
  title: string;
  serviceKind: ServiceKind;
  declared: RoleDeclaration;
  entries: readonly GrantEntry[];
  /** stored: no warnings · warned: stored WITH warnings · rejected: throws, stores nothing */
  outcome: "stored" | "warned" | "rejected";
  /** unused on `rejected` rows, where nothing was stored to probe */
  probe?: { tool: string; verdict: AccessMode };
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const slugRuleRows: readonly SlugRuleRow[] = [
  // Every `accepted` slug below is distinct from every other, so the twins can share one
  // seeded namespace without the duplicate rule biting a charset row by accident.

  // §2: "slugs are `[a-z0-9-]` (no underscore; §7 relies on this)". This row is the one
  // charset case with a consequence elsewhere: §7 splits an aggregated tool name at the
  // FIRST `_`, so an underscore in a slug makes `<slug>_<tool>` ambiguous.
  {
    title: "§2 · service slug charset refuses the underscore in `news_feed` — §7's first-`_` split depends on it · twin `news-feed` creates",
    target: "service",
    rule: "charset",
    rejected: "news_feed",
    accepted: "news-feed",
  },
  // §2: the charset is lowercase — slugs become URL path segments under /<user>/mcp/<slug>.
  {
    title: "§2 · service slug charset refuses the uppercase `News` · twin `news` creates",
    target: "service",
    rule: "charset",
    rejected: "News",
    accepted: "news",
  },
  // §2: `.` is a tool-name character (§7's literal grammar), not a slug character — the two
  // charsets are deliberately different.
  {
    title: "§2 · service slug charset refuses the dot in `news.feed` · twin `newsfeed` creates",
    target: "service",
    rule: "charset",
    rejected: "news.feed",
    accepted: "newsfeed",
  },
  // §2: `[a-z0-9-]` names at least one character — an empty slug would make
  // /<user>/mcp/<slug> the aggregated endpoint's own path.
  {
    title: "§2 · service slug charset refuses the empty slug · twin `n` creates",
    target: "service",
    rule: "charset",
    rejected: "",
    accepted: "n",
  },
  // §2: service accounts are named by the same grammar — one row on the other surface is
  // what keeps the charset from being a service-only rule.
  {
    title: "§2 · account slug charset refuses the underscore in `cron_bot` · twin `cron-bot` creates",
    target: "account",
    rule: "charset",
    rejected: "cron_bot",
    accepted: "cron-bot",
  },
  // §8: "The `pmcp` slug is reserved and virtual: no `service` row exists for it." The twin
  // is one edit away on purpose — the reservation is the exact string, not a prefix.
  {
    title: "§8 · service slug `pmcp` is reserved — the builtin is virtual and no row may shadow it · twin `pmcp-tools` creates",
    target: "service",
    rule: "reserved",
    rejected: "pmcp",
    accepted: "pmcp-tools",
  },
  // §5: "UNIQUE (owner_id, slug)" seen from the create surface — the second create of a
  // slug this owner already holds is refused before the constraint has to say so.
  {
    title: "§5 · a second service on the same slug is refused for one owner · twin `twice-created-2` creates",
    target: "service",
    rule: "duplicate",
    rejected: "twice-created",
    accepted: "twice-created-2",
  },
  {
    title: "§5 · a second account on the same slug is refused for one owner · twin `dup-account-2` creates",
    target: "account",
    rule: "duplicate",
    rejected: "dup-account",
    accepted: "dup-account-2",
  },
];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const grantValidationRows: readonly GrantValidationRow[] = [
  // §9/§8 (`grant_set`): "undeclared roles warn for tunneled services, hard-error for
  // proxied ones; a role literally named `all` is never declarable, only grantable". The
  // anchor: a declared role on a proxied service, stored clean and observable as a verdict.
  {
    title: "§9 · a declared role on a proxied service stores with no warnings · resolveAccess answers allow on a matched tool",
    serviceKind: "proxy",
    declared: { reader: ["get_news"] },
    entries: [{ role: "reader", mode: "allow" }],
    outcome: "stored",
    probe: { tool: "get_news", verdict: "allow" },
  },
  // §9: a proxied declaration is complete by construction — config defines it — so an
  // undeclared role is an owner error, not a timing problem. Nothing is stored.
  {
    title: "§9 · an undeclared role on a PROXIED service is a hard error — its declaration is complete by construction, so nothing stores",
    serviceKind: "proxy",
    declared: { reader: ["get_news"] },
    entries: [{ role: "writer", mode: "allow" }],
    outcome: "rejected",
  },
  // §9/§6: a tunneled declaration arrives at registration, so the config file may
  // legitimately be ahead of the first connection. §7 step 2 pins what the stored grant then
  // resolves to: "A granted role no longer present in roles_json resolves to the empty
  // pattern set — it still counts as a grant".
  {
    title: "§9 · an undeclared role on a TUNNELED service warns and stores — the file may be ahead of the first connection · the grant resolves to no tools until the service declares",
    serviceKind: "tunnel",
    declared: {},
    entries: [{ role: "reader", mode: "allow" }],
    outcome: "warned",
    probe: { tool: "get_news", verdict: "deny" },
  },
  // §9: a warning is not a refusal — the whole set lands, so a declared role granted beside
  // an undeclared one keeps its own tools. This is the row a "warn ⇒ skip the write"
  // implementation fails.
  {
    title: "§9 · the warned set still stores whole — a declared role granted beside an undeclared one keeps its tools",
    serviceKind: "tunnel",
    declared: { reader: ["get_news"] },
    entries: [
      { role: "reader", mode: "allow" },
      { role: "writer", mode: "allow" },
    ],
    outcome: "warned",
    probe: { tool: "get_news", verdict: "allow" },
  },
  // §2: "`mode` is `allow` (default) or `approval`: an approval-mode call does not execute
  // until the owner approves that specific request" — stored as the weaker form of allow,
  // and read back as its own verdict rather than as a denial.
  {
    title: "§2 · an approval-mode grant stores as approval · resolveAccess answers approval on a pattern-matched tool",
    serviceKind: "tunnel",
    declared: { reader: ["get_news", "search_.*"] },
    entries: [{ role: "reader", mode: "approval" }],
    outcome: "stored",
    probe: { tool: "search_news", verdict: "approval" },
  },
  // §2: "`all` is a reserved role name — never declarable, only grantable", matching all
  // tools "present and future, with no declaration needed". An empty declaration is the
  // sharpest witness: the built-in contributes `.*` without ever appearing in roles_json.
  {
    title: "§2 · the built-in `all` is grantable without ever being declared — it resolves every tool against an empty declaration",
    serviceKind: "tunnel",
    declared: {},
    entries: [{ role: "all", mode: "allow" }],
    outcome: "stored",
    probe: { tool: "any_tool_at_all", verdict: "allow" },
  },
  // §9 states the exemption and the proxied hard error in ONE sentence — "`all` is exempt,
  // and for proxied services undeclared roles are a hard error" — and the proxied side is
  // where the exemption has teeth. `if (kind === "proxy" && !declared[role]) throw` passes
  // every other row in this table and refuses this one outright, which is the difference
  // between an owner losing a grant and an owner losing the whole set. One edit from the
  // hard-error row above, and the twin it is measured against.
  {
    title: "§9/§2 · the built-in `all` is grantable on a PROXIED service too — the exemption survives the undeclared-role hard error its neighbour states",
    serviceKind: "proxy",
    declared: { reader: ["get_news"] },
    entries: [{ role: "all", mode: "allow" }],
    outcome: "stored",
    probe: { tool: "any_tool_at_all", verdict: "allow" },
  },
  // §5: PRIMARY KEY (service_account_id, service_id, role) — one row per role, so a set
  // naming the same role in two modes has no storable form. Refused whole (setGrants
  // replaces the full set atomically), never silently collapsed to one of the two.
  {
    title: "§5 · the same role in both modes is refused — one grant row per (account, service, role), so a mode collision stores nothing",
    serviceKind: "proxy",
    declared: { reader: ["get_news"] },
    entries: [
      { role: "reader", mode: "allow" },
      { role: "reader", mode: "approval" },
    ],
    outcome: "rejected",
  },
  // §2: "A tool matched by both an allow-mode and an approval-mode role is allowed outright
  // (allow wins; approval is the weaker form of allow)" — pinned here through the stored
  // rows and a real resolve, not only as buildToolFilter's pure law.
  {
    title: "§2 · allow beats approval when two granted roles match the same tool — the stored pair resolves allow",
    serviceKind: "proxy",
    declared: { reader: ["get_news"], auditor: ["get_.*"] },
    entries: [
      { role: "reader", mode: "approval" },
      { role: "auditor", mode: "allow" },
    ],
    outcome: "stored",
    probe: { tool: "get_news", verdict: "allow" },
  },
  // §8 (`grant_set` "replaces the full grant set") plus registry's own sentence: "an empty
  // entries list revokes everything on that pair". The empty set is a legal grant set, not a
  // validation error — and it is how the CLI's diff planner expresses a removed grant.
  {
    title: "§8 · an empty entry list is a legal grant set — it stores nothing and the account resolves deny",
    serviceKind: "proxy",
    declared: { reader: ["get_news"] },
    entries: [],
    outcome: "stored",
    probe: { tool: "get_news", verdict: "deny" },
  },
];

/** The sliver of the D1 binding the two envelope cases reach for directly (see below). */
type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
  };
};

/** `env.DB` is typed `unknown` (test/env.d.ts); every call site names the sliver it uses. */
function db(): D1Like {
  return env.DB as D1Like;
}

/** A fake upstream endpoint — proxied drafts need one, and nothing here ever dials it. */
const UPSTREAM_URL = "https://upstream.invalid/mcp";

/**
 * An obviously-fake stand-in for the AES-GCM credential envelope. Planted by raw SQL
 * because only `upstream.setHeaders` / the connect flow may write a real one (seed.ts's
 * header) — and what these cases assert is that registry NULLs the column, not what the
 * envelope contains.
 */
const FAKE_ENVELOPE = "FAKE-UPSTREAM-ENVELOPE-0000-NOT-A-CREDENTIAL";

/** The one shape a service-account principal takes here; `as const` keeps it a Principal. */
function accountPrincipal(ns: SeededNamespace, slug: string) {
  return {
    kind: "service_account" as const,
    accountId: ns.accounts[slug].id,
    ownerId: ns.owner.userId,
    slug,
  };
}

/** The owner of a seeded namespace, as the gateway resolves them. */
function ownerPrincipal(ns: SeededNamespace) {
  return { kind: "user" as const, userId: ns.owner.userId, username: ns.owner.username };
}

/** Re-read a seeded service as the full row every method here takes or returns. */
async function detail(registry: Registry, ns: SeededNamespace, slug: string): Promise<ServiceDetail> {
  const row = await registry.getService(ns.owner.userId, slug);
  if (!row) throw new Error(`fixture: service "${slug}" is missing`);
  return row;
}

/**
 * Registers one case per slug row: the rejected slug is refused on `target`'s create
 * surface, and the accepted twin creates. The refusal's shape is not asserted — which
 * exception a bad slug raises is incidental (§7); that it never becomes a row is not.
 */
export function runSlugRuleTable(rows: readonly SlugRuleRow[]): void {
  // deps: test/harness/seed · server/src/registry (Registry)
  for (const row of rows) {
    it(row.title, async () => {
      const ns = await seedNamespace(env.DB, {});
      const registry = new Registry(env.DB);
      const ownerId = ns.owner.userId;
      const create = (slug: string) =>
        row.target === "service"
          ? registry.createService({ ownerId, slug, name: "fixture", kind: "tunnel" })
          : registry.createAccount({ ownerId, slug, name: "fixture" });
      const read = (slug: string) =>
        row.target === "service" ? registry.getService(ownerId, slug) : registry.getAccount(ownerId, slug);

      // The duplicate rule needs the slug to already be held; the other two must not be.
      if (row.rule === "duplicate") await create(row.rejected);
      await expect(create(row.rejected)).rejects.toThrow();
      if (row.rule !== "duplicate") expect(await read(row.rejected)).toBeNull();

      // The twin, one edit away: the rule bit, and not the create surface.
      const twin = await create(row.accepted);
      expect(twin.slug).toBe(row.accepted);
      expect((await read(row.accepted))?.id).toBe(twin.id);
    });
  }
}

/**
 * Registers one case per grant row: setGrants stores, stores-with-warnings, or throws
 * without storing, and where a `probe` is given, resolveAccess answers its verdict.
 */
export function runGrantValidationTable(rows: readonly GrantValidationRow[]): void {
  // deps: test/harness/seed · server/src/registry (Registry)
  for (const row of rows) {
    it(row.title, async () => {
      const proxied = row.serviceKind === "proxy";
      const ns = await seedNamespace(env.DB, {
        services: [
          proxied
            ? { slug: "svc", kind: "proxy", upstreamUrl: UPSTREAM_URL, roles: row.declared }
            : { slug: "svc", kind: "tunnel" },
        ],
        accounts: [{ slug: "bot" }],
      });
      const registry = new Registry(env.DB);
      const service = ns.services.svc;
      // A tunneled declaration exists only after a registration — the same seam the DO uses.
      if (!proxied && Object.keys(row.declared).length > 0) {
        await registry.upsertDeclaredRoles(service.id, row.declared);
      }
      const accountId = ns.accounts.bot.id;

      const call = registry.setGrants(accountId, service.id, [...row.entries]);
      if (row.outcome === "rejected") {
        await expect(call).rejects.toThrow();
        expect(await registry.grantsFor(accountId)).toEqual([]);
      } else {
        const warnings = await call;
        expect(warnings.length > 0).toBe(row.outcome === "warned");
      }

      if (row.probe) {
        const filter = await registry.resolveAccess(
          accountPrincipal(ns, "bot"),
          await detail(registry, ns, "svc"),
        );
        expect(filter.check(row.probe.tool)).toBe(row.probe.verdict);
      }
    });
  }
}

describe("§5 · slugs and identity", () => {
  runSlugRuleTable(slugRuleRows);

  it("§5 · createService mints an opaque id: deleting a slug and recreating it yields a different id, so no recreated service can be rebound to a stale DO", async () => {
    const ns = await seedNamespace(env.DB, {});
    const registry = new Registry(env.DB);
    const draft = { ownerId: ns.owner.userId, slug: "reborn", name: "reborn", kind: "tunnel" as const };

    const first = await registry.createService(draft);
    await registry.deleteService(first.id);
    expect(await registry.getService(ns.owner.userId, "reborn")).toBeNull();

    const second = await registry.createService(draft);
    expect(second.slug).toBe(first.slug);
    expect(second.id).not.toBe(first.id);
    // Not derived from the pair either — the id is opaque, so the DO key cannot be guessed.
    expect(second.id).not.toContain("reborn");
    expect(second.id).not.toContain(ns.owner.userId);
  });

  it("§5/§8 · the reserved slug is virtual in both directions — createService refuses `pmcp` and getService answers null for it · twin: any other slug creates and reads back", async () => {
    const ns = await seedNamespace(env.DB, {});
    const registry = new Registry(env.DB);
    const ownerId = ns.owner.userId;

    await expect(
      registry.createService({ ownerId, slug: PMCP_SLUG, name: "builtin", kind: "tunnel" }),
    ).rejects.toThrow();
    expect(await registry.getService(ownerId, PMCP_SLUG)).toBeNull();

    const twin = await registry.createService({
      ownerId,
      slug: `${PMCP_SLUG}-tools`,
      name: "twin",
      kind: "tunnel",
    });
    expect((await registry.getService(ownerId, `${PMCP_SLUG}-tools`))?.id).toBe(twin.id);
  });
});

describe("§7 step 2 · resolution at request time", () => {
  it("§7 step 2 · a role widened by upsertDeclaredRoles takes effect on the very next resolveAccess — the declaration is re-read, never cached across calls", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "widen", kind: "tunnel" }],
      accounts: [{ slug: "bot", grants: { widen: [{ role: "reader", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    const service = ns.services.widen;
    await registry.upsertDeclaredRoles(service.id, { reader: ["get_news"] });

    // The SAME service value is handed to both resolves: anything that changes between them
    // came from D1, not from the argument.
    const stale = await detail(registry, ns, "widen");
    const before = await registry.resolveAccess(accountPrincipal(ns, "bot"), stale);
    expect(before.check("search_news")).toBe("deny");

    await registry.upsertDeclaredRoles(service.id, { reader: ["get_news", "search_.*"] });
    const after = await registry.resolveAccess(accountPrincipal(ns, "bot"), stale);
    expect(after.check("search_news")).toBe("allow");
  });

  it("§7 step 2 · a granted role absent from the declaration stays in roleNames and matches nothing (empty listing, not an absent grant)", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "ghosted", kind: "tunnel" }],
      accounts: [{ slug: "bot", grants: { ghosted: [{ role: "ghost", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    await registry.upsertDeclaredRoles(ns.services.ghosted.id, { reader: ["get_news"] });

    const filter = await registry.resolveAccess(
      accountPrincipal(ns, "bot"),
      await detail(registry, ns, "ghosted"),
    );
    expect(filter.roleNames).toEqual(["ghost"]);
    expect(filter.check("get_news")).toBe("deny");
    expect(filter.filterList([{ name: "get_news" }])).toEqual([]);
  });

  it("§7 step 2 · a zero-grant account resolves to empty roleNames — the gateway's scoped-404 signal, distinct from the row above · twin: one grant makes it non-empty", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "svc", kind: "proxy", upstreamUrl: UPSTREAM_URL, roles: { reader: ["get_news"] } }],
      accounts: [{ slug: "stranger" }, { slug: "bot", grants: { svc: [{ role: "reader", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    const svc = await detail(registry, ns, "svc");

    const stranger = await registry.resolveAccess(accountPrincipal(ns, "stranger"), svc);
    expect(stranger.roleNames).toEqual([]);

    const granted = await registry.resolveAccess(accountPrincipal(ns, "bot"), svc);
    expect(granted.roleNames).toEqual(["reader"]);
  });

  it("§7 · an owner resolves to roleNames ['all'] on every service in the namespace", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "one", kind: "tunnel" },
        { slug: "two", kind: "proxy", upstreamUrl: UPSTREAM_URL },
      ],
    });
    const registry = new Registry(env.DB);

    for (const slug of ["one", "two"]) {
      const filter = await registry.resolveAccess(ownerPrincipal(ns), await detail(registry, ns, slug));
      expect(filter.roleNames).toEqual(["all"]);
      expect(filter.check("anything_at_all")).toBe("allow");
    }
  });
});

describe("§6 · archived is a pipeline stage, not a filter", () => {
  it("§6 · getService returns an archived row — the -32002 answer needs the row that a filtering lookup would have hidden", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "parked", kind: "tunnel", archived: true }],
    });
    const registry = new Registry(env.DB);

    const row = await registry.getService(ns.owner.userId, "parked");
    expect(row?.slug).toBe("parked");
    expect(row?.archived).toBe(true);
  });

  it("§6 · listServicesFor keeps archived rows for the owner, and an account still sees only services it holds a grant on", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "parked", kind: "tunnel", archived: true },
        { slug: "live", kind: "tunnel" },
      ],
      accounts: [{ slug: "bot", grants: { parked: [{ role: "all", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);

    const owned = await registry.listServicesFor(ownerPrincipal(ns));
    expect(owned.map((s) => s.slug).sort()).toEqual(["live", "parked"]);
    expect(owned.find((s) => s.slug === "parked")?.archived).toBe(true);

    const seen = await registry.listServicesFor(accountPrincipal(ns, "bot"));
    expect(seen.map((s) => s.slug)).toEqual(["parked"]);
  });

  it("§6 · archive and unarchive are idempotent and preserve roles, grants and redaction config across the round trip", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: "svc",
          kind: "proxy",
          upstreamUrl: UPSTREAM_URL,
          roles: { reader: ["get_news"] },
          redact: { get_news: ["credentials.token"] },
          redactResults: { get_news: ["session"] },
        },
      ],
      accounts: [{ slug: "bot", grants: { svc: [{ role: "reader", mode: "approval" }] } }],
    });
    const registry = new Registry(env.DB);
    const id = ns.services.svc.id;
    const before = await detail(registry, ns, "svc");
    const grantsBefore = await registry.grantsFor(ns.accounts.bot.id);

    await registry.archiveService(id);
    await registry.archiveService(id); // idempotent
    expect((await detail(registry, ns, "svc")).archived).toBe(true);

    await registry.unarchiveService(id);
    await registry.unarchiveService(id); // idempotent
    expect(await detail(registry, ns, "svc")).toEqual(before);
    expect(await registry.grantsFor(ns.accounts.bot.id)).toEqual(grantsBefore);
  });
});

describe("§5/§9 · create and update invariants", () => {
  runGrantValidationTable(grantValidationRows);

  it("§5 · kind/field mismatch: a proxy draft without upstreamUrl and a tunnel draft carrying a declaration are both refused · twins: the well-formed draft of each kind creates", async () => {
    const ns = await seedNamespace(env.DB, {});
    const registry = new Registry(env.DB);
    const ownerId = ns.owner.userId;

    await expect(
      registry.createService({ ownerId, slug: "no-endpoint", name: "no endpoint", kind: "proxy" }),
    ).rejects.toThrow();
    await expect(
      registry.createService({
        ownerId,
        slug: "early-roles",
        name: "early roles",
        kind: "tunnel",
        roles: { reader: ["get_news"] },
      }),
    ).rejects.toThrow();
    expect(await registry.getService(ownerId, "no-endpoint")).toBeNull();
    expect(await registry.getService(ownerId, "early-roles")).toBeNull();

    const proxied = await registry.createService({
      ownerId,
      slug: "well-formed-proxy",
      name: "well formed",
      kind: "proxy",
      upstreamUrl: UPSTREAM_URL,
      roles: { reader: ["get_news"] },
    });
    expect(proxied.declaredRoles).toEqual({ reader: ["get_news"] });

    const tunneled = await registry.createService({
      ownerId,
      slug: "well-formed-tunnel",
      name: "well formed",
      kind: "tunnel",
    });
    expect(tunneled.declaredRoles).toEqual({});
  });

  it("§7 · flipping upstreamAuthMode clears the credential envelope in the same write — connectionStatus reads not_connected immediately after, so no read can observe a mode and an envelope kind disagreeing", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "svc", kind: "proxy", upstreamUrl: UPSTREAM_URL, upstreamAuthMode: "headers" },
      ],
    });
    const registry = new Registry(env.DB);
    const id = ns.services.svc.id;
    const plant = () =>
      db().prepare("UPDATE service SET upstream_auth_json = ? WHERE id = ?").bind(FAKE_ENVELOPE, id).run();

    await plant();
    expect(await connectionStatus(await detail(registry, ns, "svc"))).toBe("connected");

    const flipped = await registry.updateService(id, { upstreamAuthMode: "oauth" });
    expect(flipped.upstreamAuthMode).toBe("oauth");
    expect(await connectionStatus(await detail(registry, ns, "svc"))).toBe("not_connected");

    // The twin: a patch that does not touch the mode is not a credential wipe — an idempotent
    // `apply` must not disconnect the service it is re-applying.
    await plant();
    await registry.updateService(id, { name: "renamed" });
    expect(await connectionStatus(await detail(registry, ns, "svc"))).toBe("connected");
  });

  it("§15 · log_bodies resolves at create from the kind when the draft omits it — tunnel on, proxy off — and an explicit value overrides either way", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "tunnel-default", kind: "tunnel" },
        { slug: "proxy-default", kind: "proxy", upstreamUrl: UPSTREAM_URL },
        { slug: "tunnel-off", kind: "tunnel", logBodies: false },
        { slug: "proxy-on", kind: "proxy", upstreamUrl: UPSTREAM_URL, logBodies: true },
      ],
    });
    const registry = new Registry(env.DB);
    const resolved: Record<string, boolean> = {};
    for (const slug of ["tunnel-default", "proxy-default", "tunnel-off", "proxy-on"]) {
      resolved[slug] = (await detail(registry, ns, slug)).logBodies;
    }
    expect(resolved).toEqual({
      "tunnel-default": true,
      "proxy-default": false,
      "tunnel-off": false,
      "proxy-on": true,
    });
  });

  it("§15 · updateService flips log_bodies in both directions on either kind, changing nothing else about the row", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "tun", kind: "tunnel" },
        { slug: "prox", kind: "proxy", upstreamUrl: UPSTREAM_URL },
      ],
    });
    const registry = new Registry(env.DB);

    for (const slug of ["tun", "prox"]) {
      const before = await detail(registry, ns, slug);
      const off = await registry.updateService(before.id, { logBodies: !before.logBodies });
      expect(off).toEqual({ ...before, logBodies: !before.logBodies });

      const back = await registry.updateService(before.id, { logBodies: before.logBodies });
      expect(back).toEqual(before);
    }
  });
});

describe("§7 · config-declared redaction paths", () => {
  it("§7 · redactPathsFor keeps the directions apart: `redact` answers 'args' only and `redact_results` answers 'results' only, on the same tool", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: "svc",
          kind: "tunnel",
          redact: { get_news: ["credentials.token"] },
          redactResults: { get_news: ["session.cookie"] },
        },
      ],
    });
    const registry = new Registry(env.DB);
    const svc = await detail(registry, ns, "svc");

    expect(await registry.redactPathsFor(svc, "get_news", "args")).toEqual(["credentials.token"]);
    expect(await registry.redactPathsFor(svc, "get_news", "results")).toEqual(["session.cookie"]);
  });

  it("§7 · redactPathsFor unions every matching key (literal and pattern alike) and answers [] — never an error — for a tool nothing matches", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: "svc",
          kind: "tunnel",
          redact: { get_news: ["token"], "get_.*": ["nested.key"], "search_*": ["query"] },
        },
      ],
    });
    const registry = new Registry(env.DB);
    const svc = await detail(registry, ns, "svc");

    expect((await registry.redactPathsFor(svc, "get_news", "args")).sort()).toEqual([
      "nested.key",
      "token",
    ]);
    expect(await registry.redactPathsFor(svc, "search_all", "args")).toEqual(["query"]);
    expect(await registry.redactPathsFor(svc, "unmatched_tool", "args")).toEqual([]);
    expect(await registry.redactPathsFor(svc, "get_news", "results")).toEqual([]);
  });
});

describe("§6 · declaration drift", () => {
  it("§6 · drift is reported only for roles holding a live grant — widening a role nobody was granted is silent", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "svc", kind: "tunnel" }],
      accounts: [{ slug: "bot", grants: { svc: [{ role: "reader", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    const id = ns.services.svc.id;
    await registry.upsertDeclaredRoles(id, { reader: ["get_news"], writer: ["put_news"] });

    const ungranted = await registry.upsertDeclaredRoles(id, {
      reader: ["get_news"],
      writer: ["put_news", "put_everything"],
    });
    expect(ungranted.widened).toEqual([]);

    const granted = await registry.upsertDeclaredRoles(id, {
      reader: ["get_news", "get_everything"],
      writer: ["put_news", "put_everything"],
    });
    expect(granted.widened).toEqual([{ role: "reader", patterns: ["get_everything"] }]);
  });

  it("§6 · a subset re-declaration is not drift, and an added pattern string is, even when the regex language is unchanged (comparison is textual by design)", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [{ slug: "svc", kind: "tunnel" }],
      accounts: [{ slug: "bot", grants: { svc: [{ role: "reader", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    const id = ns.services.svc.id;
    await registry.upsertDeclaredRoles(id, { reader: ["get_news", "search_.*"] });

    const narrowed = await registry.upsertDeclaredRoles(id, { reader: ["get_news"] });
    expect(narrowed.widened).toEqual([]);

    // `(get_news)` is the same regular language as `get_news` — a different STRING is drift.
    const reworded = await registry.upsertDeclaredRoles(id, { reader: ["(get_news)"] });
    expect(reworded.widened).toEqual([{ role: "reader", patterns: ["(get_news)"] }]);
  });

  it("§6 · upsertDeclaredRoles refuses a proxied service, refuses an invalid declaration without partially writing, and throws on a row that vanished (the caller's close-4003 signal) · twin: a valid declaration on a live tunneled row stores and reports no drift", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        { slug: "prox", kind: "proxy", upstreamUrl: UPSTREAM_URL },
        { slug: "tun", kind: "tunnel" },
        { slug: "doomed", kind: "tunnel" },
      ],
    });
    const registry = new Registry(env.DB);

    await expect(
      registry.upsertDeclaredRoles(ns.services.prox.id, { reader: ["get_news"] }),
    ).rejects.toThrow();

    // The twin, first, so the invalid declaration has something to fail to overwrite.
    const stored = await registry.upsertDeclaredRoles(ns.services.tun.id, { reader: ["get_news"] });
    expect(stored.widened).toEqual([]);
    expect((await detail(registry, ns, "tun")).declaredRoles).toEqual({ reader: ["get_news"] });

    await expect(
      registry.upsertDeclaredRoles(ns.services.tun.id, { reader: ["get_all"], all: ["*"] }),
    ).rejects.toThrow();
    expect((await detail(registry, ns, "tun")).declaredRoles).toEqual({ reader: ["get_news"] });

    await registry.deleteService(ns.services.doomed.id);
    await expect(
      registry.upsertDeclaredRoles(ns.services.doomed.id, { reader: ["get_news"] }),
    ).rejects.toThrow();
  });

  it("§6 · a successful registration stamps last_connected_at — the one moment a tunnel comes online", async () => {
    const ns = await seedNamespace(env.DB, { services: [{ slug: "svc", kind: "tunnel" }] });
    const registry = new Registry(env.DB);
    expect((await detail(registry, ns, "svc")).lastConnectedAt).toBeNull();

    const registeredAt = Date.now();
    await registry.upsertDeclaredRoles(ns.services.svc.id, { reader: ["get_news"] });

    const stamped = (await detail(registry, ns, "svc")).lastConnectedAt;
    expect(typeof stamped).toBe("number");
    expect(stamped).toBeGreaterThanOrEqual(registeredAt);
  });
});
