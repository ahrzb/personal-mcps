/**
 * tunnel/data-model.test.ts — §20 at the DO: the registration-time `server/discover`, the
 * three catalogs §20.5 adds beside the tool list, the two `list_changed` frames the DO now
 * ROUTES instead of dropping, and the per-family shape a role declaration gained on the
 * §6 wire.
 *
 * WHAT THIS SUITE PINS (durable by §7's rule — each of these survives a rewrite of
 * tunnel.ts): that a registration asks `server/discover` ONCE, before any list warm, and
 * then warms exactly the families the answer declared; that a discover which fails —
 * `-32601` from a library that predates the method, or a correlation timeout — falls back
 * to warming tools only, so nothing already in the field goes dark and no existing catalog
 * is emptied; that the declared capability set is durable DO state like the catalogs
 * themselves; §20.5's cache discipline extended to `catalog:prompts`,
 * `catalog:resources` and `catalog:resourceTemplates` (a failed warm leaves the previous
 * cache standing, a SUCCESSFUL registration that undeclares a family clears it, absent
 * means never-warmed and re-warms while a stored `[]` is an answer); the per-family
 * invalidation notifications; and §6's role drift comparison done PER FAMILY, which is
 * what keeps "an app widening itself is visible" true across three keyspaces.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN. Pattern GRAMMAR per family and role normalization
 * SEMANTICS are registry's, pinned once in unit/pattern.test.ts and unit/filter.test.ts —
 * here a declaration is only ever "stored as this" or "drifted / did not drift". What a
 * consumer then SEES of any of it — scoped `prompts/list`, the `-32601` on aggregated
 * `resources/*`, the capabilities the two `initialize` shapes advertise — is the worker
 * project's (order.table.test.ts), because none of it is a socket question. The §6
 * handshake itself (the deadline, the close codes, replacement) stays protocol.test.ts's.
 *
 * ORACLE NOTE, so a later reader does not mistake it for coupling: the three catalog keys
 * are read HERE by name, from DO storage. `catalog:prompts` / `catalog:resources` /
 * `catalog:resourceTemplates` are spelled in §20.5 itself, and the rows that need them are
 * rows about the CACHE — "a failure never empties one", "absent re-warms, stored `[]` does
 * not". A row about what is SERVED goes through the backend seam instead, and the split is
 * the titles' own.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): live WebSockets and
 * the real AppConnection DO, which per-file storage isolation cannot cover (strategy
 * §2). Nothing sleeps except the one row that is ABOUT elapsed time (§6's "worst-case two
 * correlation timeouts wide"), which measures against a shrunk limits.CALL_TIMEOUT_MS
 * rather than waiting the real budget out — the same seam pipeline-tunnel.test.ts uses.
 *
 * Isolation and ordering, load-bearing: smoke.test.ts and protocol.test.ts green first —
 * this file assumes the handshake works and only asks what §20 added to it. Every case
 * seeds its own owner, slug and app id, and asserts on rows and keys it created.
 */

// deps: harness/seed · harness/fake-app (connectFakeApp, LIST_METHOD, tick, waitFor) · harness/tunnel-do (backendCtx, connectionStub, untilCataloged, untilStatus) · cloudflare:test (env, runInDurableObject) · src/tunnel (tunnelBackend, capabilities) · src/audit (query) · src/errors (CODES) · src/registry (Registry) · src/limits (CALL_TIMEOUT_MS)

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import { CODES } from "../../src/errors";
import type { Tool } from "../../src/gateway";
import { CALL_TIMEOUT_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { capabilities, tunnelBackend } from "../../src/tunnel";
import type { AppConnection } from "../../src/tunnel";
import { LIST_METHOD, connectFakeApp, tick, waitFor } from "../harness/fake-app";
import type { CatalogEntry, FakeApp, FakeAppOptions } from "../harness/fake-app";
import { seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededApp } from "../harness/seed";
import { backendCtx, connectionStub, untilCataloged, untilStatus } from "../harness/tunnel-do";

/**
 * The hub-originated control question §6 puts in front of every catalog warm. Spelled
 * here, like every other wire string this directory asserts on, so the fixture describes
 * the socket rather than agreeing with tunnel.ts by construction.
 */
const DISCOVER = "server/discover";

/**
 * §20.5's three further durable keys, by the names the section gives them. Not constants of
 * the system in limits.ts's sense (that file holds spec-pinned NUMBERS); these are storage
 * names the spec spells, which is why a row may read them at all.
 */
const PROMPTS_KEY = "catalog:prompts";
const RESOURCES_KEY = "catalog:resources";
const TEMPLATES_KEY = "catalog:resourceTemplates";

/** A tool whose schemas §7's walk can resolve — every case here wants a catalog that warms
 *  cleanly, since schema soundness is protocol.test.ts's subject and not this file's. */
const TOOL: Tool = {
  name: "get_news",
  description: "walkable",
  inputSchema: { type: "object", properties: { topic: { type: "string" } } },
};

/** A second tool, for the rows that need a tool catalog to CHANGE. */
const OTHER_TOOL: Tool = {
  name: "search_news",
  description: "walkable",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** Prompt catalog entries — matched by `name` (§20.2), which is the only field any row
 *  here reads; the rest is what a real app would send. */
const PROMPT: CatalogEntry = { name: "digest_daily", description: "the daily digest" };
const PROMPT_2: CatalogEntry = { name: "digest_weekly", description: "the weekly digest" };

/** Resource catalog entries — matched by `uri`, never by `name` (§20.2). */
const RESOURCE: CatalogEntry = { uri: "news://feed/tech", name: "tech feed", mimeType: "application/json" };
const RESOURCE_2: CatalogEntry = { uri: "news://feed/world", name: "world feed" };

/** One resource template, kept in its own catalog because §20.5 gives it its own key. */
const TEMPLATE: CatalogEntry = { uriTemplate: "news://feed/{id}", name: "feed by id" };

// ── the fixture every case in this file is built from ─────────────────────────────────

/** One namespace holding one tunneled app with one live `pmcp_app_` token — the whole
 *  premise of a §20.5 row is one DO and what it cached. */
type Fixture = {
  origin: string;
  ownerId: string;
  app: SeededApp;
  token: string;
};

const seeded: SeededNamespace[] = [];
const opened: FakeApp[] = [];

afterEach(async () => {
  // Shared storage AND shared sockets across files in this project: a leak here is a leak
  // into the next file.
  for (const app of opened.splice(0)) await app.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

async function seedFixture(): Promise<Fixture> {
  const slug = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("data"),
    apps: [{ slug, kind: "tunnel", tokens: [{ as: "live" }] }],
  });
  seeded.push(namespace);
  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    app: namespace.apps[slug],
    token: namespace.tokens.live.token,
  };
}

/** Dial one socket for the fixture's app, registered unless the options say otherwise. */
async function connect(
  fixture: Fixture,
  options: Partial<FakeAppOptions> = {},
): Promise<FakeApp> {
  const app = await connectFakeApp({
    origin: fixture.origin,
    token: fixture.token,
    tools: [TOOL],
    ...options,
  });
  opened.push(app);
  return app;
}

/** The app row as the gateway would hand it to a backend. */
async function appRow(fixture: Fixture): Promise<App> {
  const row = await new Registry(env.DB).getApp(fixture.ownerId, fixture.app.slug);
  if (row === null) throw new Error("the fixture's app vanished");
  return row;
}

/** The declaration as the hub READS it — the canonical shape §20.3 pins for every
 *  owner-facing surface, which is a different question from what the column holds. */
async function declaredRoles(fixture: Fixture): Promise<unknown> {
  const row = await new Registry(env.DB).getApp(fixture.ownerId, fixture.app.slug);
  if (row === null) throw new Error("the fixture's app vanished");
  return row.declaredRoles;
}

/**
 * The `roles_json` COLUMN, parsed — the storage claim §20.3 makes ("app.roles_json
 * holds the normalized per-family object"), which the canonical read deliberately does not
 * expose. Read raw for that reason: a row about normalization cannot go through the reader
 * that re-renders it.
 */
async function storedRoles(appId: string): Promise<unknown> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT roles_json FROM app WHERE id = ?`)
    .bind(appId)
    .first<{ roles_json: string }>();
  if (row === null) throw new Error("the fixture's app vanished");
  return JSON.parse(row.roles_json);
}

/**
 * Give the fixture's app one live grant on `reader` — drift is only audited for a role
 * somebody holds (§6), so every widening row needs a grantee to exist at all.
 */
async function grantReader(fixture: Fixture): Promise<void> {
  const registry = new Registry(env.DB);
  const agent = await registry.createAgent({
    ownerId: fixture.ownerId,
    slug: uniqueSlug("agent"),
    name: "agent",
  });
  await registry.setGrants(agent.id, fixture.app.id, [{ role: "reader", mode: "allow" }]);
}

/**
 * The connection's audit rows, read once the registration that writes them has finished.
 * The tools warm is the synchronization point rather than a sleep: it is the LAST step of a
 * successful register, so a socket that has been asked for its tools has already had every
 * row of that registration written.
 */
async function auditedAfterRegister(
  fixture: Fixture,
  app: FakeApp,
  event: string,
): Promise<AuditRow[]> {
  expect(await waitFor(() => app.lists.length > 0), "the registration never completed").toBe(true);
  return (await query(env.DB, fixture.ownerId, { event })).rows;
}

/** The hub-originated REQUESTS this socket received, in arrival order — notifications (the
 *  hub's schema warnings) carry no id and are not questions the warm sequence is about. */
function asked(app: FakeApp): string[] {
  return app.frames
    .filter((frame) => typeof frame.method === "string" && frame.id !== undefined)
    .map((frame) => String(frame.method));
}

/** How many times the hub asked `method` on this socket. */
function count(app: FakeApp, method: string): number {
  return asked(app).filter((seen) => seen === method).length;
}

/** One durable value of the app's DO, by key — §20.5's catalog keys, read where they
 *  live. `undefined` is the never-warmed answer, and telling it from `[]` is a row. */
function stored(appId: string, key: string): Promise<unknown> {
  return runInDurableObject(
    connectionStub(appId),
    (_instance: AppConnection, state) => state.storage.get<unknown>(key),
  );
}

/**
 * Wait until a durable key holds `expected` — the state a fixture's next assertion assumes
 * whenever it dialled a socket to get there. Polled rather than slept on, and a value that
 * never arrives fails naming both sides instead of timing the test out.
 */
async function untilStored(appId: string, key: string, expected: unknown): Promise<void> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    if (JSON.stringify(await stored(appId, key)) === JSON.stringify(expected)) return;
    await tick();
  }
  expect(await stored(appId, key), `${key} never reached the expected value`).toEqual(expected);
}

/** The budget for the DO-backed poll above — one round trip per turn, so far longer in wall
 *  time than the same count of bare event-loop turns. */
const POLL_TURNS = 250;

/**
 * Let everything already in flight land, so an ABSENCE is read after the hub has had its
 * chance to be wrong rather than before. The only way this directory waits (strategy §3:
 * workerd is cooperative, so "has it happened yet" is a scheduling question, not a clock).
 */
async function quiesce(turns = 25): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await tick();
}

/**
 * Runs `body` with every long timer the DO arms shrunk to a few milliseconds — §6's
 * correlation budget observed against the CONSTANT rather than waited out.
 *
 * Leans on the seam tunnel.ts's module header PUBLISHES: the correlation deadline is armed
 * once per hub-originated request, as a single ambient `setTimeout` at exactly
 * limits.CALL_TIMEOUT_MS. A Durable Object shares this isolate's globals, so that is the
 * timer patched here, and the predicate reads the constant. Restored unconditionally: a
 * leaked patch is a leak into the next file.
 */
async function withShrunkCallTimeout<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  const patched = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    (real as (...args: unknown[]) => unknown)(
      handler,
      ms !== undefined && ms >= CALL_TIMEOUT_MS ? SHRUNK_DEADLINE_MS : ms,
      ...rest,
    )) as typeof globalThis.setTimeout;
  globalThis.setTimeout = patched;
  try {
    return await body();
  } finally {
    globalThis.setTimeout = real;
  }
}

/** What limits.CALL_TIMEOUT_MS is shrunk TO for the width row — a test-run duration, not a
 *  spec number, which is why it is not a limits.ts constant. Wide enough that one budget
 *  and two budgets are never confusable by scheduling noise. */
const SHRUNK_DEADLINE_MS = 120;

/** Turn budget for a wait that may legitimately span two shrunk budgets. */
const WIDTH_TURNS = 1200;

/** Collect console.warn while `body` runs — §6 puts the catalog-warm failure there, and it
 *  is the only observation of a warm that drew nothing. */
async function withWarnings<T>(body: (warnings: string[]) => Promise<T>): Promise<T> {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return await body(warnings);
  } finally {
    warn.mockRestore();
  }
}

describe("§6/§20.5 the capability warm", () => {
  it("§6/§20.5 · hub/register issues one server/discover before any list warm, and warms only the families the app declared", async () => {
    const fixture = await seedFixture();
    // Tools and prompts, and deliberately NOT resources: a warm the app never asked for
    // is exactly what "warms only the families the app declared" forbids.
    const app = await connect(fixture, { tools: [TOOL], prompts: [PROMPT] });
    expect(await app.registered).toEqual({ ok: true });
    expect(await waitFor(() => count(app, LIST_METHOD.prompts) > 0)).toBe(true);
    // Given time to be wrong before the two absences are read.
    await quiesce();

    const methods = asked(app);
    // ONE discover, and it is the first thing the connection was ever asked — §6's
    // "the first MCP message from the hub is server/discover", whose answer decides the rest.
    expect(methods.filter((seen) => seen === DISCOVER)).toEqual([DISCOVER]);
    expect(methods[0]).toBe(DISCOVER);
    // Exactly the declared families warmed, in whatever order they were dispatched.
    expect(methods.slice(1).sort()).toEqual([LIST_METHOD.prompts, LIST_METHOD.tools].sort());
    expect(count(app, LIST_METHOD.resources)).toBe(0);
    expect(count(app, LIST_METHOD.resourceTemplates)).toBe(0);
  });

  it("§6/§20.5 · an app declaring tools only logs no catalog-warm failure for prompts or resources", async () => {
    await withWarnings(async (warnings) => {
      const fixture = await seedFixture();
      // The app every deployment in the field is: a tool list and nothing else.
      const app = await connect(fixture, { tools: [TOOL] });
      expect(await app.registered).toEqual({ ok: true });
      expect(await waitFor(() => app.lists.length > 0), "the tools warm never went out").toBe(true);
      // Not vacuous: the one warm that WAS declared landed.
      expect(await untilCataloged(await appRow(fixture))).toEqual([TOOL]);

      // Given time to be wrong — a blind warm fails one whole correlation budget later, so
      // the absence is waited on rather than read the moment the tool list arrived.
      await waitFor(() => warnings.some((line) => /prompts|resources/i.test(line)), 60);
      // The requests were never SENT, which is the claim the log is downstream of: this
      // app ANSWERS all four families (the harness seeds three empty catalogs, as any
      // transparent library would), so a hub that warmed blind would take three clean empty
      // answers and log nothing at all — and the warnings line alone would be an assertion
      // about the fixture's generosity rather than about the hub.
      expect(count(app, LIST_METHOD.prompts)).toBe(0);
      expect(count(app, LIST_METHOD.resources)).toBe(0);
      expect(count(app, LIST_METHOD.resourceTemplates)).toBe(0);
      expect(warnings.filter((line) => /prompts|resources/i.test(line))).toEqual([]);
    });
  });

  it("§6/§20.5 · an app whose library answers server/discover with -32601 still gets its tools warmed and its tool list served — the compatibility fallback, so no app in the field goes dark · a discover TIMEOUT behaves identically (the twin)", async () => {
    // Leg 1: a library that predates the method. It SERVES prompts — the catalog is right
    // there — and the hub must still warm tools only, because nothing told it otherwise.
    const legacy = await seedFixture();
    const old = await connect(legacy, {
      tools: [TOOL],
      prompts: [PROMPT],
      discoverBehavior: {
        mode: "error",
        error: { code: CODES.methodNotFound, message: "Method not found" },
      },
    });
    expect(await old.registered).toEqual({ ok: true });
    // The fallback warm, observed on the SOCKET before any catalog is read — because
    // reading one is itself a demand, and an absent catalog under a live socket re-lists on
    // demand (§6 lifecycle 2). A hub that gave up entirely after the refusal would heal
    // through that very read, and the catalog assertion below could not tell the two apart.
    expect(await waitFor(() => old.lists.length > 0), "the fallback warm never went out").toBe(true);
    expect(await untilCataloged(await appRow(legacy))).toEqual([TOOL]);
    await quiesce();
    // The premise, asserted rather than assumed: this row is about a discover that was
    // ASKED and refused, not about a hub that never asks — the two are indistinguishable
    // from the tool catalog alone, and only one of them is §6's fallback.
    expect(count(old, DISCOVER)).toBe(1);
    // Tools, and nothing else. The FAMILY set is the claim, never a frame count: the
    // demand-driven re-list owns how many times a family may be asked.
    const warmed = asked(old).filter((method) => method !== DISCOVER);
    expect(warmed[0]).toBe(LIST_METHOD.tools);
    expect(warmed.filter((method) => method !== LIST_METHOD.tools)).toEqual([]);

    // The twin: the same library, silent rather than explicit. §6 gives both inputs one
    // meaning — "capabilities unknown" — so the observable must not differ at all.
    await withShrunkCallTimeout(async () => {
      const silent = await seedFixture();
      const mute = await connect(silent, {
        tools: [TOOL],
        prompts: [PROMPT],
        discoverBehavior: { mode: "hang" },
      });
      expect(await mute.registered).toEqual({ ok: true });
      // Budgeted for the shrunk discover deadline this leg has to sit through first.
      expect(
        await waitFor(() => mute.lists.length > 0, WIDTH_TURNS),
        "the fallback warm never went out",
      ).toBe(true);
      expect(await untilCataloged(await appRow(silent))).toEqual([TOOL]);
      await quiesce();
      expect(count(mute, DISCOVER)).toBe(1);
      const warmed = asked(mute).filter((method) => method !== DISCOVER);
      expect(warmed[0]).toBe(LIST_METHOD.tools);
      expect(warmed.filter((method) => method !== LIST_METHOD.tools)).toEqual([]);
    });
  });

  it("§6/§20.5 · a failed or timed-out server/discover leaves every existing catalog in place — a failure never empties one", async () => {
    for (const discoverBehavior of [
      { mode: "error", error: { code: CODES.methodNotFound, message: "Method not found" } },
      { mode: "hang" },
    ] as const) {
      const fixture = await seedFixture();
      // A full house first, so there is something for a failure to be able to empty.
      const first = await connect(fixture, {
        tools: [TOOL],
        prompts: [PROMPT],
        resources: [RESOURCE],
        resourceTemplates: [TEMPLATE],
      });
      expect(await first.registered).toEqual({ ok: true });
      await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT]);
      await untilStored(fixture.app.id, RESOURCES_KEY, [RESOURCE]);
      await untilStored(fixture.app.id, TEMPLATES_KEY, [TEMPLATE]);
      await first.close();

      // The reconnect would answer EMPTY catalogs if it were asked, so a hub that warmed
      // blind — or that read a failed discover as an undeclare — leaves [] behind and this
      // row catches it. Which of the two it did is not the question: neither is allowed.
      await withShrunkCallTimeout(async () => {
        const second = await connect(fixture, {
          tools: [TOOL],
          prompts: [],
          resources: [],
          resourceTemplates: [],
          discoverBehavior,
        });
        expect(await second.registered).toEqual({ ok: true });
        expect(await waitFor(() => second.lists.length > 0), "the fallback warm never ran").toBe(true);
        await quiesce();
      });

      expect(await stored(fixture.app.id, PROMPTS_KEY)).toEqual([PROMPT]);
      expect(await stored(fixture.app.id, RESOURCES_KEY)).toEqual([RESOURCE]);
      expect(await stored(fixture.app.id, TEMPLATES_KEY)).toEqual([TEMPLATE]);
      // "Touches no other key" (§20.5) reaches the capability set too, and it is the one
      // whose loss no catalog would show: reset to tools by a single reconnect blip, §20.2's
      // scoped handshake stops advertising prompts and resources for an app still serving
      // them — the field going dark by another door.
      expect([...(await capabilities(fixture.app.id))].sort()).toEqual([
        "prompts",
        "resources",
        "tools",
      ]);
    }
  });

  it("§20.5 · the declared capability set is cached beside the catalogs and survives a disconnect", async () => {
    const fixture = await seedFixture();
    // `completions` is the family that makes this row falsifiable: §20.2 puts it in the
    // capability vocabulary, and it has no catalog, no key and no list method at all — so
    // the DECLARED set is the only place it can have come from. A hub that derived the set
    // from the warms that succeeded, or from the catalog keys it happens to hold, agrees
    // with a tools+prompts fixture on every value and loses this one.
    const app = await connect(fixture, {
      tools: [TOOL],
      prompts: [PROMPT],
      capabilities: ["tools", "prompts", "completions"],
    });
    expect(await app.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT]);
    expect([...(await capabilities(fixture.app.id))].sort()).toEqual([
      "completions",
      "prompts",
      "tools",
    ]);

    // The bot dies. Nothing re-registers, and §6's scoped handshake must still be able to
    // say what this app serves — which is the whole reason the set is durable.
    await app.close();
    await untilStatus(fixture.app.id, "offline");

    expect([...(await capabilities(fixture.app.id))].sort()).toEqual([
      "completions",
      "prompts",
      "tools",
    ]);
    // "Beside the catalogs": the same disconnect that left the set standing left them too.
    expect(await stored(fixture.app.id, PROMPTS_KEY)).toEqual([PROMPT]);
  });

  it("§6/§20.5 · registration is worst-case TWO correlation timeouts wide — the discover leg, then the warms, which run concurrently with each other", async () => {
    await withWarnings(async (warnings) => {
      await withShrunkCallTimeout(async () => {
        // The worst case: an app that answers nothing at all. The discover leg burns one
        // budget, the tools-only fallback warm burns the second, and there is no third —
        // the two legs are sequential BY CONSTRUCTION (§6: the answer decides the warms).
        const worst = await seedFixture();
        const mute = await connect(worst, {
          skipRegister: true,
          tools: [TOOL],
          discoverBehavior: { mode: "hang" },
          listBehavior: { mode: "hang" },
        });
        const startedWorst = Date.now();
        await mute.sendRegister();
        expect(await mute.registered).toEqual({ ok: true });
        // The warm goes out only once the discover budget has expired — the sequencing half.
        expect(await waitFor(() => mute.lists.length > 0, WIDTH_TURNS)).toBe(true);
        expect(Date.now() - startedWorst).toBeGreaterThanOrEqual(SHRUNK_DEADLINE_MS);
        // And the whole tail ends one budget after that: §6's catalog-warm failure is the
        // last thing a registration can log, so its arrival is the registration's width.
        expect(
          await waitFor(() => warnings.some((line) => line.includes(worst.app.slug)), WIDTH_TURNS),
          "the failed warm never logged",
        ).toBe(true);
        const width = Date.now() - startedWorst;
        expect(width).toBeGreaterThanOrEqual(SHRUNK_DEADLINE_MS * 1.4);
        expect(width, "three budgets wide means a leg that should be concurrent is not").toBeLessThan(
          SHRUNK_DEADLINE_MS * 3,
        );

        // The other half: with the discover answered, EVERY declared warm is on the wire
        // before the first of them could possibly have timed out. Serialized warms would
        // put the second one a whole budget behind the first.
        const wide = await seedFixture();
        const app = await connect(wide, {
          skipRegister: true,
          tools: [TOOL],
          prompts: [PROMPT],
          resources: [RESOURCE],
          resourceTemplates: [TEMPLATE],
          listBehavior: { mode: "hang" },
        });
        const startedWide = Date.now();
        await app.sendRegister();
        expect(await app.registered).toEqual({ ok: true });
        expect(
          await waitFor(
            () =>
              count(app, LIST_METHOD.tools) > 0 &&
              count(app, LIST_METHOD.prompts) > 0 &&
              count(app, LIST_METHOD.resources) > 0 &&
              count(app, LIST_METHOD.resourceTemplates) > 0,
            WIDTH_TURNS,
          ),
          "not every declared family was warmed",
        ).toBe(true);
        expect(
          Date.now() - startedWide,
          "the warms did not run concurrently with each other",
        ).toBeLessThan(SHRUNK_DEADLINE_MS);
      });
    });
  });
});

describe("§20.5 the three further catalogs", () => {
  it("§20.5 · notifications/prompts/list_changed invalidates the prompts catalog and re-lists · notifications/tools/list_changed still invalidates only tools (the twin)", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { tools: [TOOL], prompts: [PROMPT] });
    expect(await app.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT]);
    const warmed = {
      tools: count(app, LIST_METHOD.tools),
      prompts: count(app, LIST_METHOD.prompts),
    };

    // §6, amended: this frame used to be one the DO dropped. Now it invalidates its own key.
    await app.notifyPromptsListChanged([PROMPT, PROMPT_2]);
    expect(
      await waitFor(() => count(app, LIST_METHOD.prompts) > warmed.prompts),
      "the prompts notification drew no re-list",
    ).toBe(true);
    await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT, PROMPT_2]);
    // ITS OWN key: a prompts notification is not a reason to re-ask for tools.
    expect(count(app, LIST_METHOD.tools)).toBe(warmed.tools);

    // The twin, unchanged from §6: the tools notification still moves tools and nothing else.
    const before = {
      tools: count(app, LIST_METHOD.tools),
      prompts: count(app, LIST_METHOD.prompts),
    };
    await app.notifyToolsListChanged([TOOL, OTHER_TOOL]);
    expect(
      await waitFor(() => count(app, LIST_METHOD.tools) > before.tools),
      "the tools notification drew no re-list",
    ).toBe(true);
    expect(await untilCataloged(await appRow(fixture))).toEqual([TOOL, OTHER_TOOL]);
    await quiesce();
    expect(count(app, LIST_METHOD.prompts)).toBe(before.prompts);
  });

  it("§20.5 · notifications/resources/list_changed invalidates the resources catalog", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, {
      tools: [TOOL],
      resources: [RESOURCE],
      resourceTemplates: [TEMPLATE],
    });
    expect(await app.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, RESOURCES_KEY, [RESOURCE]);
    const warmed = count(app, LIST_METHOD.resources);

    await app.notifyResourcesListChanged([RESOURCE, RESOURCE_2]);
    expect(
      await waitFor(() => count(app, LIST_METHOD.resources) > warmed),
      "the resources notification drew no re-list",
    ).toBe(true);
    await untilStored(fixture.app.id, RESOURCES_KEY, [RESOURCE, RESOURCE_2]);
  });

  it("§20.5 · a prompts warm that FAILS leaves the previous prompts cache in place · a successful re-registration that no longer declares prompts CLEARS it (the twin — a failure is not an undeclare)", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { tools: [TOOL], prompts: [PROMPT] });
    expect(await first.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT]);
    await first.close();

    // A FAILURE: prompts is still declared, and the warm draws nothing the hub can read as
    // a prompt list. The app even holds a different catalog now — which the hub must
    // not have, because it was never told.
    const failing = await connect(fixture, {
      tools: [TOOL],
      prompts: [PROMPT_2],
      listBehaviors: { prompts: { mode: "error", error: { code: CODES.internal, message: "not ready" } } },
    });
    expect(await failing.registered).toEqual({ ok: true });
    expect(await waitFor(() => count(failing, LIST_METHOD.prompts) > 0), "the warm never went out").toBe(true);
    await quiesce();
    expect(await stored(fixture.app.id, PROMPTS_KEY)).toEqual([PROMPT]);
    // The declaration is what the set is made of, never the warms that landed: this discover
    // ANSWERED prompts and only the list failed, so the family is still declared (§20.2, "a
    // capability the hub has never been told about is not declared" — it was told).
    expect([...(await capabilities(fixture.app.id))].sort()).toEqual(["prompts", "tools"]);
    await failing.close();

    // The twin: a SUCCESSFUL registration whose discover answer omits prompts. §20.5 inverts
    // the conservatism here and only here — an omission in an answer is the app saying
    // it no longer serves the family, not a transient failure to say anything.
    const narrowed = await connect(fixture, { tools: [TOOL], capabilities: ["tools"] });
    expect(await narrowed.registered).toEqual({ ok: true });
    expect(await waitFor(() => narrowed.lists.length > 0), "the registration never warmed").toBe(true);
    // Cleared to the genuinely-empty answer, not back to never-warmed: an absent key would
    // re-warm a family this app just stopped declaring.
    await untilStored(fixture.app.id, PROMPTS_KEY, []);
    // The set REPLACES, it never accumulates — the half of the undeclare the handshake
    // reads. A hub that unioned each registration's families into a stored set passes every
    // catalog assertion above and goes on advertising prompts forever for an app that has
    // stopped serving them, which is the same client-misleading state the clear exists to end.
    expect([...(await capabilities(fixture.app.id))]).toEqual(["tools"]);
  });

  it("§20.5 · after an undeclare-clear, prompts/list on that app answers empty rather than serving the stale catalog", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { tools: [TOOL], prompts: [PROMPT] });
    expect(await first.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, PROMPTS_KEY, [PROMPT]);
    const row = await appRow(fixture);
    // Not vacuous: while the family is declared, that very catalog IS what is served.
    expect(await tunnelBackend.listPrompts(row, backendCtx())).toEqual([PROMPT]);
    await first.close();

    const narrowed = await connect(fixture, { tools: [TOOL], capabilities: ["tools"] });
    expect(await narrowed.registered).toEqual({ ok: true });
    await untilStored(fixture.app.id, PROMPTS_KEY, []);

    // Without this, every prompts/get against the app is a -32000 against a list the
    // hub is still publishing (§20.5's own reason for the clear).
    expect(await tunnelBackend.listPrompts(row, backendCtx())).toEqual([]);
  });

  it("§20.5 · an absent prompts catalog key under a live socket triggers a rewarm; a stored [] does not", async () => {
    // ABSENT: the family is declared and the first warm drew nothing, so the key was never
    // written at all — the state an app that registered before it could list sits in.
    const absent = await seedFixture();
    const wedged = await connect(absent, {
      tools: [TOOL],
      prompts: [PROMPT],
      listBehaviors: { prompts: { mode: "error", error: { code: CODES.internal, message: "not ready" } } },
    });
    expect(await wedged.registered).toEqual({ ok: true });
    expect(await waitFor(() => count(wedged, LIST_METHOD.prompts) > 0), "the warm never went out").toBe(true);
    await quiesce();
    expect(await stored(absent.app.id, PROMPTS_KEY)).toBeUndefined();

    // The app can list now. Nothing reconnects: the only thing that may heal the catalog
    // is the hub re-listing on demand.
    wedged.setListBehavior({ mode: "answer" }, "prompts");
    const askedBefore = count(wedged, LIST_METHOD.prompts);
    const wedgedRow = await appRow(absent);
    expect(
      await tunnelBackend.listPrompts(wedgedRow, backendCtx()),
      "a re-warm may not block the read",
    ).toEqual([]);
    expect(
      await waitFor(() => count(wedged, LIST_METHOD.prompts) > askedBefore),
      "the demand never re-listed",
    ).toBe(true);
    await untilStored(absent.app.id, PROMPTS_KEY, [PROMPT]);

    // STORED []: an app with a genuinely empty prompt set. Present is an answer, and an
    // answer is never re-asked — otherwise every read of an empty catalog is a socket round
    // trip, forever.
    const empty = await seedFixture();
    const app = await connect(empty, { tools: [TOOL], prompts: [] });
    expect(await app.registered).toEqual({ ok: true });
    await untilStored(empty.app.id, PROMPTS_KEY, []);
    const warmed = count(app, LIST_METHOD.prompts);
    expect(await tunnelBackend.listPrompts(await appRow(empty), backendCtx())).toEqual([]);
    expect(await waitFor(() => count(app, LIST_METHOD.prompts) > warmed, 30)).toBe(false);
  });
});

describe("§6/§20.3 the per-family declaration on the wire", () => {
  it("§6 · a per-family roles declaration round-trips through hub/register and lands normalized in roles_json", async () => {
    const fixture = await seedFixture();
    // BOTH spellings in one declaration — §6 says mixing them is legal, and the bare list is
    // the only input on which "normalized" is visible at all: a per-family role is already in
    // normal form, so a hub that wrote the frame's `roles` value straight into the column
    // would satisfy an all-object declaration by doing nothing.
    const declared = {
      curator: { tools: ["publish"], prompts: ["digest_.*"], resources: ["news://feed/*"] },
      reader: ["get_news"],
    };
    const app = await connect(fixture, { roles: declared });
    expect(await app.registered).toEqual({ ok: true });
    // §20.3's storage claim, whole: the COLUMN holds the per-family object for every role,
    // whichever way that role was spelled on the wire.
    expect(await storedRoles(fixture.app.id)).toEqual({
      curator: declared.curator,
      reader: { tools: ["get_news"] },
    });
  });

  it("§6 · a bare-list declaration still registers and is read as tools-only", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { roles: { reader: ["get_news"] } });
    expect(await app.registered).toEqual({ ok: true });
    // §20.3's canonical read: a tools-only role renders as the bare list it registered as,
    // so every app in the field keeps its exact current meaning and diffs nothing.
    expect(await declaredRoles(fixture)).toEqual({ reader: ["get_news"] });
  });

  it("§6/§20.3 · a role re-registered with a family it did not have fires connect.roles_widened — an unchanged tools set is not enough to call the role unchanged · a re-registration identical after normalization fires nothing (the twin)", async () => {
    const widening = await seedFixture();
    const before = await connect(widening, { roles: { reader: ["get_news"] } });
    expect(await before.registered).toEqual({ ok: true });
    // Granted AFTER the first registration: drift is only audited for a role somebody holds,
    // so an earlier grant would make that first registration a widening too.
    await grantReader(widening);
    await before.close();
    const wider = await connect(widening, {
      roles: { reader: { tools: ["get_news"], prompts: ["digest_.*"] } },
    });
    expect(await wider.registered).toEqual({ ok: true });

    const rows = await auditedAfterRegister(widening, wider, "connect.roles_widened");
    expect(rows, "a family-blind comparison sees an unchanged tools set and writes nothing").toHaveLength(1);
    expect(JSON.stringify(rows[0].detail)).toContain("prompts");
    expect(JSON.stringify(rows[0].detail)).toContain("digest_.*");

    // The twin: the SAME role in the other spelling. Normalization happens before the
    // comparison (§6), so an app that merely restated itself must draw no row at all.
    const same = await seedFixture();
    const bare = await connect(same, { roles: { reader: ["get_news"] } });
    expect(await bare.registered).toEqual({ ok: true });
    await grantReader(same);
    await bare.close();
    const spelled = await connect(same, { roles: { reader: { tools: ["get_news"] } } });
    expect(await spelled.registered).toEqual({ ok: true });
    expect(await auditedAfterRegister(same, spelled, "connect.roles_widened")).toEqual([]);
  });

  it('§6/§20.3 · "reader": ["get_news"] re-registered as {"tools": ["get_news"], "resources": ["file:///*"]} under a live grant writes connect.roles_widened naming the resources family', async () => {
    const fixture = await seedFixture();
    const before = await connect(fixture, { roles: { reader: ["get_news"] } });
    expect(await before.registered).toEqual({ ok: true });
    await grantReader(fixture);
    await before.close();

    // §6's own example: the tools set is a subset of itself, and the app has just handed
    // every granted agent the whole resource keyspace.
    const wider = await connect(fixture, {
      roles: { reader: { tools: ["get_news"], resources: ["file:///*"] } },
    });
    expect(await wider.registered).toEqual({ ok: true });

    const rows = await auditedAfterRegister(fixture, wider, "connect.roles_widened");
    expect(rows).toHaveLength(1);
    const detail = JSON.stringify(rows[0].detail);
    expect(detail).toContain("reader");
    expect(detail, "the row must name the family, not only the pattern").toContain("resources");
    expect(detail).toContain("file:///*");
  });
});
