/**
 * tunnel/stream.test.ts — the held listen stream, end to end: a real `subscriptions/listen`
 * request through the running worker, a real `text/event-stream` held open by the
 * invocation, real subscriber sockets into real app DOs, and a real app changing
 * its catalog on the other side of them.
 *
 * WHAT THIS SUITE PINS that no other file can. push.test.ts and subscriptions.test.ts stop
 * at the DO: they prove what the DO rings and routes, at every socket it holds. This file
 * is the only place the OTHER two halves are observable — the Worker's shape filter (an
 * aggregated stream must never forward the resources bell the DO also rang at it) and the
 * re-authorization tick (a held stream is one request, and §15's "revocation is immediate"
 * is a per-request property, so the stream re-reads the world every keepalive and narrows,
 * or closes, on what it finds). Silence is the assertion in half these rows, which is why
 * each of them carries its allow-twin in the same case: a stream that forwarded nothing at
 * all would satisfy every negative here on its own.
 *
 * WHAT IT ASSUMES OF THE DOOR, spelled because this file was authored before the door was:
 * `subscriptions/listen` is an ordinary JSON-RPC method on both §7 endpoint shapes, whose
 * answer is `200 text/event-stream` carrying an `Mcp-Session-Id` the hub minted; the body
 * carries JSON-RPC notifications as SSE `data:` frames and an SSE COMMENT per
 * `LISTEN_KEEPALIVE_MS`; and a `resources/subscribe` names the stream it should feed with
 * the `Mcp-Session-Id` REQUEST header, which is the only place a session id is ever read
 * from a consumer (§21.1: it is correlation, never authentication — the bearer decides
 * everything, and the id selects only among that principal's own streams).
 *
 * THE TIMING LEVER: the keepalive is a bare `setTimeout(…, deadlines(env).listenKeepaliveMs)`
 * re-read on every tick, so setting PMCP_LISTEN_KEEPALIVE_MS for a row (harness/deadlines,
 * the map below) reaches the very next tick — an interval, a `scheduler.wait` or an alarm
 * would strand every tick-dependent row at real time. Each deadline is set BY NAME and
 * nothing global is patched, so shortening the keepalive cannot silently shorten an
 * unrelated deadline (the `CALL_TIMEOUT_MS` row would then prove nothing), and each setting
 * is removed at the end of the row that made it — to ABSENT, which is what production has,
 * so two overlapping rows cannot leave one behind for the next file. The CALL budget is
 * short for the one row that watches it and for no other: it is the budget the DO arms
 * around every hub-originated request, the catalog re-list included, and shortening it
 * file-wide silences the very doorbells the other twelve rows wait for (see
 * SHORT_DEADLINES_AND_CALL).
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): held responses,
 * live sockets, DOs and D1 all at once. Every case mints its own namespace.
 *
 * Isolation and ordering: push.test.ts and subscriptions.test.ts green first — this file
 * assumes the DO rings and routes correctly and asserts only what the Worker does with it.
 */

// deps: harness/seed · harness/fake-app (connectFakeApp, tick, waitFor) · harness/tunnel-do (connectionStub, untilBellRings, untilCataloged) · cloudflare:workers (exports.default.fetch) · cloudflare:test (env, runInDurableObject, runDurableObjectAlarm) · src/identity (revokeToken) · src/registry (Registry, seedGrants) · src/limits (LISTEN_FANOUT_MAX, CALL_TIMEOUT_MS) · src/capabilities (BELL_*, RESOURCES_UPDATED) · harness/deadlines (withDeadlines)

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  BELL_PROMPTS,
  BELL_RESOURCES,
  BELL_TOOLS,
  RESOURCES_UPDATED,
} from "../../src/capabilities";
import type { JsonRpcRequest, Tool } from "../../src/gateway";
import { revokeToken } from "../../src/identity";
import { CALL_TIMEOUT_MS, LISTEN_FANOUT_MAX } from "../../src/limits";
import { Registry } from "../../src/registry";
import { connectFakeApp, tick, waitFor } from "../harness/fake-app";
import type { CatalogEntry, FakeApp } from "../harness/fake-app";
import { seedGrants, seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { withDeadlines } from "../harness/deadlines";
import { connectionStub, untilBellRings } from "../harness/tunnel-do";

// ── the held stream, as a consumer holds it ───────────────────────────────────────────

/**
 * One held `text/event-stream`, pumped in the background so a case can read what has
 * arrived SO FAR without ever awaiting a body that is never going to end. Everything a row
 * asserts is a projection of `frames`: the notifications, the keepalive comments, and
 * whether the hub ended it.
 */
class HeldStream {
  readonly status: number;
  readonly contentType: string | null;
  readonly sessionId: string | null;
  /** Every SSE block as it arrived, split on the blank line SSE separates events with. */
  private readonly blocks: string[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private ended = false;

  constructor(response: Response) {
    this.status = response.status;
    this.contentType = response.headers.get("Content-Type");
    this.sessionId = response.headers.get("Mcp-Session-Id");
    const body = response.body;
    if (body === null) throw new Error("the listen answer carried no body");
    this.reader = body.getReader();
    void this.pump();
  }

  /** The JSON-RPC notifications the stream delivered, in order — SSE `data:` payloads. */
  get notifications(): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    for (const block of this.blocks) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          frames.push(JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>);
        } catch {
          // A data line that is not JSON is a contract failure the row reading `blocks` names.
        }
      }
    }
    return frames;
  }

  /** The keepalive comments — SSE lines beginning with `:`, which carry no event at all. */
  get comments(): string[] {
    return this.blocks.filter((block) => block.startsWith(":"));
  }

  /** Every line the hub wrote, for the rows that assert what is ABSENT (`id:`, `event:`). */
  get lines(): string[] {
    return this.blocks.flatMap((block) => block.split("\n"));
  }

  count(method: string): number {
    return this.notifications.filter((frame) => frame.method === method).length;
  }

  /** True once the hub ended the response — the observation behind every "closes the
   *  stream" row, and the one a narrowing row must find FALSE. */
  get closed(): boolean {
    return this.ended;
  }

  async cancel(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.reader.cancel().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const parts = this.buffer.split("\n\n");
        this.buffer = parts.pop() ?? "";
        for (const part of parts) if (part.trim() !== "") this.blocks.push(part.trim());
      }
    } catch {
      // A cancelled or broken body is an ended stream, which is what `closed` reports.
    }
    this.ended = true;
  }
}

/** What the two deadlines are set TO — test-run durations, not spec numbers, which is
 *  why neither is a limits.ts constant. Wide enough that one tick and two are never
 *  confusable by scheduling noise. */
const SHRUNK_KEEPALIVE_MS = 25;
const SHRUNK_CALL_MS = 40;

/**
 * The keepalive, short for EVERY row — this file's one timing lever, and the only deadline
 * all thirteen rows depend on. Set BY NAME (harness/deadlines → limits.Deadlines), so no
 * other deadline in the worker moves and a row that thinks it observed the keepalive cannot
 * have observed something merely longer.
 */
const SHORT_DEADLINES = { listenKeepaliveMs: SHRUNK_KEEPALIVE_MS } as const;

/**
 * The keepalive AND the call budget — for the ONE row that observes the call budget, and
 * for no other.
 *
 * CALL_TIMEOUT_MS is not a consumer-only dial: `AppConnection.request` arms it around EVERY
 * hub-originated request on the app socket, which includes the catalog re-list a family's
 * list_changed frame provokes. Setting it short file-wide therefore gives the fake app
 * SHRUNK_CALL_MS to answer a `tools/list` — and when a loaded machine makes that round trip
 * slower than that, `warmCatalog` takes its timeout leg, writes no catalog, and by design
 * rings NO BELL (§20.5: a failure is not an undeclare). The row then waits out a doorbell
 * that was never going to exist and fails as a vitest timeout naming no assertion. Measured
 * twice: 2026-09-17 on the old globalThis lever, and again when this file was ported to the
 * env bindings with both deadlines still file-wide (1 of 5 runs green, alone, unloaded).
 *
 * So the budget is short where it is the SUBJECT and nowhere else — the same scoping
 * data-model.test.ts and pipeline-tunnel.test.ts already use for this deadline.
 */
const SHORT_DEADLINES_AND_CALL = {
  listenKeepaliveMs: SHRUNK_KEEPALIVE_MS,
  callTimeoutMs: SHRUNK_CALL_MS,
} as const;

// ── the fixture ───────────────────────────────────────────────────────────────────────

type Fixture = {
  ns: SeededNamespace;
  apps: FakeApp[];
};

const seeded: SeededNamespace[] = [];
const opened: FakeApp[] = [];
const held: HeldStream[] = [];

afterEach(async () => {
  for (const stream of held.splice(0)) await stream.cancel();
  for (const app of opened.splice(0)) await app.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

const ORIGIN = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;

/** The consumer's own JSON-RPC id, which §6 forbids from ever crossing an app socket. */
const CONSUMER_ID = 4242;

const TOOL: Tool = { name: "search", inputSchema: { type: "object" } };
const PROMPT: CatalogEntry = { name: "greet" };
const URI = "file:///notes.md";
const RESOURCE: CatalogEntry = { uri: URI, name: "notes" };

/** One JSON-RPC message through the real worker entry — scoped when `slug` is a string,
 *  aggregated when it is null. The body is JSON-RPC on every answer the PIPELINE gives, and
 *  §7's one anonymous 404 — which the reopen leg below asserts — is `text/plain`, so a body
 *  that does not parse is reported as empty rather than thrown: `status` is what that row
 *  reads. */
async function rpc(
  ns: SeededNamespace,
  credential: string,
  slug: string | null,
  message: JsonRpcRequest,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = `${ORIGIN}/${ns.owner.username}/mcp`;
  const response = await workerExports.default.fetch(
    new Request(slug === null ? base : `${base}/${slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
        ...headers,
      },
      body: JSON.stringify(message),
    }),
  );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A refusal the DOOR wrote (404/401 are text/plain, §7): the status is the assertion.
  }
  return { status: response.status, body };
}

/** Open one held stream on either shape. The response is NEVER awaited whole. */
async function listen(
  ns: SeededNamespace,
  credential: string,
  slug: string | null,
): Promise<HeldStream> {
  const base = `${ORIGIN}/${ns.owner.username}/mcp`;
  const response = await workerExports.default.fetch(
    new Request(slug === null ? base : `${base}/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: CONSUMER_ID, method: "subscriptions/listen" }),
    }),
  );
  const stream = new HeldStream(response);
  held.push(stream);
  return stream;
}

/** One registered tunneled app with a warm catalog, dialled against a seeded token. */
async function connect(
  token: string,
  options: { tools?: Tool[]; prompts?: CatalogEntry[]; resources?: CatalogEntry[] } = {},
): Promise<FakeApp> {
  const app = await connectFakeApp({
    origin: ORIGIN,
    token,
    roles: { reader: ["*"] },
    tools: options.tools ?? [],
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.resources === undefined ? {} : { resources: options.resources }),
  });
  opened.push(app);
  expect(await app.registered).toEqual({ ok: true });
  expect(await waitFor(() => app.lists.length > 0), "the catalog never warmed").toBe(true);
  await settle();
  return app;
}

/**
 * Enough turns of the loop for a keepalive tick at the SHRUNK cadence to have run `count`
 * times. A real duration, deliberately: workerd is the runtime under test, vitest's fake
 * timers do not reach inside it, and what is being waited on is the hub's own tick — whose
 * constant the row already set to milliseconds through the hub's binding, so nothing here
 * waits out a spec
 * number.
 */
async function ticks(count: number): Promise<void> {
  const deadline = Date.now() + SHRUNK_KEEPALIVE_MS * (count + 1);
  while (Date.now() < deadline) await tick();
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await tick();
}

/** Wait for a condition whose budget is a real-world duration rather than a scheduling
 *  question — the shrunk tick cadence, or (once) a seeded token's own expiry, which is a
 *  wall-clock fact on a D1 row and not a hub deadline that could be shrunk. */
async function waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

/** How many subscriber sockets one app's DO is holding — how "this stream subscribed
 *  that app" is observed from outside the Worker. */
async function subscriberSockets(appId: string): Promise<number> {
  return runInDurableObject(connectionStub(appId), (_instance, state) =>
    state
      .getWebSockets()
      .filter((ws) => state.getTags(ws).some((tag) => tag.startsWith("sub:"))).length,
  );
}

/**
 * …polled to what a row expects, since a socket the tick drops goes on its own turn.
 *
 * Budgeted in TURNS rather than in milliseconds, and the unit is the point: a turn is one
 * event-loop tick plus one round trip into the DO, so a turn count buys the same number of
 * OBSERVATIONS however loaded the machine is, while `SHRUNK_KEEPALIVE_MS * 6` of wall clock
 * buys fewer and fewer of them. Under load that wall-clock budget expired before a socket
 * the tick had already dropped could be seen gone (the reopen row reading 1 where it wanted
 * 0). Same budget as `waitFor`, and paid in full only when the answer is "it never reached
 * that count", which is a failure either way.
 */
async function untilSockets(appId: string, expected: number): Promise<number> {
  let held = await subscriberSockets(appId);
  for (let turn = 0; turn < SOCKET_TURNS && held !== expected; turn++) {
    await tick();
    held = await subscriberSockets(appId);
  }
  return held;
}

/** Turns of the loop above — one DO round trip each, the same budget `waitFor` uses. */
const SOCKET_TURNS = 250;

// ── the rows ──────────────────────────────────────────────────────────────────────────

describe("§21.1 the stream a caller gets", () => {
  it("§21.1 · a granted caller's stream receives a doorbell when its app's catalog changes · an ungranted caller's aggregated stream, driven by the same provocation, receives nothing — same status, same content-type, same keepalive cadence, session ids differing by construction (the twin that makes silence evidence)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [
          { slug: "granted", grants: { [slug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "granted" }] },
          { slug: "ungranted", tokens: [{ as: "ungranted" }] },
        ],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token);

      const granted = await listen(ns, ns.tokens.granted.token, null);
      const ungranted = await listen(ns, ns.tokens.ungranted.token, null);

      expect(granted.status).toBe(200);
      expect(ungranted.status).toBe(200);
      expect(granted.contentType).toContain("text/event-stream");
      expect(ungranted.contentType).toContain("text/event-stream");
      expect(granted.sessionId).not.toBe(ungranted.sessionId);

      await app.notifyToolsListChanged([TOOL]);
      expect(await waitFor(() => granted.count(BELL_TOOLS) > 0)).toBe(true);

      await ticks(2);
      // The silence is evidence because the same provocation, the same cadence and the
      // same shape produced a doorbell on the stream beside it.
      expect(ungranted.notifications).toEqual([]);
      expect(ungranted.comments.length).toBeGreaterThan(0);
      expect(granted.comments.length).toBeGreaterThan(0);
    });
  });

  it("§21.1 · a reopened stream starts fresh — a bell rung while no stream was open is not replayed (Last-Event-ID honored nowhere), and the fresh change after reopen arrives as a data frame carrying no id: or event: lines", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [{ slug: "reader", grants: { [slug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token);

      const first = await listen(ns, ns.tokens.reader.token, slug);
      await first.cancel();
      await settle();

      // Rung into the void: nobody is listening, and nothing buffers it.
      await app.notifyToolsListChanged([TOOL]);
      await settle();

      const second = await listen(ns, ns.tokens.reader.token, slug);
      await ticks(2);
      expect(second.notifications).toEqual([]);

      await app.notifyToolsListChanged([TOOL, { name: "other", inputSchema: { type: "object" } }]);
      // The second provocation in this case lands milliseconds after the first, so §21.3's
      // floor decides whether this bell arrives as a leading ring or as the trailing one
      // its alarm owes. Either satisfies "the fresh change after reopen arrives"; what the
      // case must never assert is how fast the suite happens to be.
      expect(
        await untilBellRings(ns.apps[slug].id, BELL_TOOLS, () => second.count(BELL_TOOLS) > 0),
      ).toBe(true);
      // A bare data frame: no resumption vocabulary anywhere on the wire.
      expect(second.lines.some((line) => line.startsWith("id:"))).toBe(false);
      expect(second.lines.some((line) => line.startsWith("event:"))).toBe(false);
    });
  });
});

describe("§21.2 the re-authorization tick", () => {
  it("§21.2 · the re-auth tick: a bearer revoked mid-stream closes it within one shrunk LISTEN_KEEPALIVE_MS, an expired one identically — and a deleted agent closes on the principal re-read leg, constructed with its token still resolvable · a live bearer's stream survives the same ticks (the twin)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const grants = { [slug]: [{ role: "all", mode: "allow" as const }] };
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [
          { slug: "revoked", grants, tokens: [{ as: "revoked" }] },
          // A life measured in seconds: the row waits on the token's own expiry, which is a
          // wall-clock fact the hub reads off the row — not a hub deadline to be shrunk.
          { slug: "expiring", grants, tokens: [{ as: "expiring", expiresIn: 1 }] },
          { slug: "doomed", grants, tokens: [{ as: "doomed" }] },
          { slug: "live", grants, tokens: [{ as: "live" }] },
        ],
      });
      seeded.push(ns);
      await connect(ns.tokens.app.token);

      const revoked = await listen(ns, ns.tokens.revoked.token, slug);
      const expiring = await listen(ns, ns.tokens.expiring.token, slug);
      const doomed = await listen(ns, ns.tokens.doomed.token, slug);
      const live = await listen(ns, ns.tokens.live.token, slug);

      await revokeToken(ns.owner.userId, ns.tokens.revoked.id);
      expect(await waitUntil(() => revoked.closed, SHRUNK_KEEPALIVE_MS * 4)).toBe(true);

      expect(await waitUntil(() => expiring.closed, 3_000)).toBe(true);

      // The agent row goes; its token still resolves, so only the principal re-read can
      // notice — which is the leg this constructs.
      await new Registry(env.DB).deleteAgent(ns.agents.doomed.id);
      expect(await waitUntil(() => doomed.closed, SHRUNK_KEEPALIVE_MS * 4)).toBe(true);

      // The twin: same ticks, same everything, a credential nobody touched.
      expect(live.closed).toBe(false);
      expect(live.comments.length).toBeGreaterThan(0);
    });
  });

  it("§21.2 · an app archived mid-stream closes its scoped stream on the next tick · the same archive narrows an aggregated stream — that app's subscriber socket is gone on the next tick and its bells stop, while the stream and its other apps' bells continue (the twin)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const doomedSlug = uniqueSlug("a-doomed");
      const otherSlug = uniqueSlug("b-other");
      const grants = {
        [doomedSlug]: [{ role: "all", mode: "allow" as const }],
        [otherSlug]: [{ role: "all", mode: "allow" as const }],
      };
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [
          { slug: doomedSlug, kind: "tunnel", tokens: [{ as: "doomedApp" }] },
          { slug: otherSlug, kind: "tunnel", tokens: [{ as: "otherApp" }] },
        ],
        agents: [{ slug: "reader", grants, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const doomedApp = await connect(ns.tokens.doomedApp.token);
      const otherApp = await connect(ns.tokens.otherApp.token);

      const scoped = await listen(ns, ns.tokens.reader.token, doomedSlug);
      const aggregated = await listen(ns, ns.tokens.reader.token, null);

      await new Registry(env.DB).archiveApp(ns.apps[doomedSlug].id);

      expect(await waitUntil(() => scoped.closed, SHRUNK_KEEPALIVE_MS * 4)).toBe(true);
      expect(aggregated.closed).toBe(false);
      // The aggregated stream narrows instead: the archived app's socket is dropped.
      expect(await untilSockets(ns.apps[doomedSlug].id, 0)).toBe(0);

      // The archived app's bells stop…
      await doomedApp.notifyToolsListChanged([TOOL]);
      await ticks(2);
      expect(aggregated.count(BELL_TOOLS)).toBe(0);
      // …while the stream and its other apps carry on.
      await otherApp.notifyToolsListChanged([TOOL]);
      expect(await waitFor(() => aggregated.count(BELL_TOOLS) > 0)).toBe(true);
      expect(aggregated.closed).toBe(false);
    });
  });

  it("§21.2 · a grant revoked mid-stream: aggregated narrows (socket dropped, subscriptions dead, other apps' bells continue) · scoped, the caller's last grant on the app, closes the stream — a fresh open would now 404 (the twin)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const lostSlug = uniqueSlug("a-lost");
      const keptSlug = uniqueSlug("b-kept");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [
          { slug: lostSlug, kind: "tunnel", tokens: [{ as: "lostApp" }] },
          { slug: keptSlug, kind: "tunnel", tokens: [{ as: "keptApp" }] },
        ],
        agents: [
          {
            slug: "reader",
            grants: {
              [lostSlug]: [{ role: "all", mode: "allow" }],
              [keptSlug]: [{ role: "all", mode: "allow" }],
            },
            tokens: [{ as: "reader" }],
          },
        ],
      });
      seeded.push(ns);
      const lostApp = await connect(ns.tokens.lostApp.token);
      const keptApp = await connect(ns.tokens.keptApp.token);

      const aggregated = await listen(ns, ns.tokens.reader.token, null);
      const scoped = await listen(ns, ns.tokens.reader.token, lostSlug);

      // The caller's LAST grant on that app, taken away.
      await seedGrants(env.DB, ns.agents.reader.id, ns.apps[lostSlug].id, []);

      expect(await waitUntil(() => scoped.closed, SHRUNK_KEEPALIVE_MS * 4)).toBe(true);
      expect(
        await waitUntil(() => aggregated.closed, SHRUNK_KEEPALIVE_MS * 4),
        "the aggregated stream narrows rather than closing",
      ).toBe(false);
      expect(await untilSockets(ns.apps[lostSlug].id, 0)).toBe(0);

      await lostApp.notifyToolsListChanged([TOOL]);
      await ticks(2);
      expect(aggregated.count(BELL_TOOLS)).toBe(0);
      await keptApp.notifyToolsListChanged([TOOL]);
      expect(await waitFor(() => aggregated.count(BELL_TOOLS) > 0)).toBe(true);

      // …and a fresh scoped open is now the 404 §7 gives any ungranted caller.
      const reopened = await rpc(ns, ns.tokens.reader.token, lostSlug, {
        jsonrpc: "2.0",
        id: CONSUMER_ID,
        method: "subscriptions/listen",
      });
      expect(reopened.status).toBe(404);
    });
  });

  it("§21.2/§21.3 · a grant added mid-stream is subscribed on the next tick and the Worker rings exactly the family bells its shape serves that the app's stored set contains — a tools-only app rings the tools bell alone · a further tick with no change rings nothing (the twin)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const heldSlug = uniqueSlug("a-held");
      const addedSlug = uniqueSlug("b-added");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [
          { slug: heldSlug, kind: "tunnel", tokens: [{ as: "heldApp" }] },
          { slug: addedSlug, kind: "tunnel", tokens: [{ as: "addedApp" }] },
        ],
        agents: [
          { slug: "reader", grants: { [heldSlug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "reader" }] },
        ],
      });
      seeded.push(ns);
      await connect(ns.tokens.heldApp.token);
      // Tools only: the added app declares no prompts, so no prompts bell may ring.
      await connect(ns.tokens.addedApp.token, { tools: [TOOL] });

      const aggregated = await listen(ns, ns.tokens.reader.token, null);
      await ticks(1);
      expect(aggregated.notifications).toEqual([]);

      await seedGrants(env.DB, ns.agents.reader.id, ns.apps[addedSlug].id, [
        { role: "all", mode: "allow" },
      ]);

      expect(await waitUntil(() => aggregated.count(BELL_TOOLS) > 0, SHRUNK_KEEPALIVE_MS * 4)).toBe(
        true,
      );
      expect(await untilSockets(ns.apps[addedSlug].id, 1)).toBe(1);
      expect(aggregated.count(BELL_TOOLS)).toBe(1);
      expect(aggregated.count(BELL_PROMPTS)).toBe(0);

      // The twin: further ticks with nothing changing ring nothing at all — and "rang
      // nothing" is told from "was suppressed" only after the coalescing alarm has run
      // (constraint 10), so BOTH DOs drain theirs before this concludes.
      await ticks(3);
      await runDurableObjectAlarm(connectionStub(ns.apps[heldSlug].id));
      await runDurableObjectAlarm(connectionStub(ns.apps[addedSlug].id));
      await ticks(1);
      expect(aggregated.count(BELL_TOOLS)).toBe(1);
      expect(aggregated.closed).toBe(false);
    });
  });

  it("§21.2 · a subscriber-socket close the Worker did not initiate — closed DO-side through runInDurableObject — ends the WHOLE stream rather than leaving it deaf to one app (deploy and restart stay out-of-process, strategy §10)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const firstSlug = uniqueSlug("a-first");
      const secondSlug = uniqueSlug("b-second");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [
          { slug: firstSlug, kind: "tunnel", tokens: [{ as: "firstApp" }] },
          { slug: secondSlug, kind: "tunnel", tokens: [{ as: "secondApp" }] },
        ],
        agents: [
          {
            slug: "reader",
            grants: {
              [firstSlug]: [{ role: "all", mode: "allow" }],
              [secondSlug]: [{ role: "all", mode: "allow" }],
            },
            tokens: [{ as: "reader" }],
          },
        ],
      });
      seeded.push(ns);
      await connect(ns.tokens.firstApp.token);
      await connect(ns.tokens.secondApp.token);

      const aggregated = await listen(ns, ns.tokens.reader.token, null);
      expect(await untilSockets(ns.apps[firstSlug].id, 1)).toBe(1);

      // Not the Worker's doing: the DO drops one of the stream's sockets under it.
      await runInDurableObject(connectionStub(ns.apps[firstSlug].id), (_instance, state) => {
        for (const ws of state.getWebSockets()) {
          if (state.getTags(ws).some((tag) => tag.startsWith("sub:"))) ws.close(1011, "restart");
        }
      });

      // Fail loud, not deaf: the WHOLE stream ends, and the client's reopen rebuilds it.
      expect(await waitUntil(() => aggregated.closed, SHRUNK_KEEPALIVE_MS * 8)).toBe(true);
    });
  });
});

describe("§21.2/§21.4 what each shape forwards", () => {
  it("§21.2/§21.3 · an aggregated stream forwards tools and prompts bells and NEVER the resources bell the DO also rang at it · a scoped stream forwards all three plus updated (the twin)", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [{ slug: "reader", grants: { [slug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token, { prompts: [], resources: [] });

      const aggregated = await listen(ns, ns.tokens.reader.token, null);
      const scoped = await listen(ns, ns.tokens.reader.token, slug);
      // The precondition its siblings wait for, not a fixed number of ticks: both
      // subscriber sockets must be held by the DO before a bell can reach either — under
      // load `settle()`'s five ticks were not always enough (3 of 8 runs, 2026-09-03).
      expect(await untilSockets(ns.apps[slug].id, 2)).toBe(2);

      await app.notifyResourcesListChanged([RESOURCE]);
      expect(await waitFor(() => scoped.count(BELL_RESOURCES) > 0)).toBe(true);
      // The DO rang BOTH sockets; the aggregated shape simply does not serve this family.
      expect(aggregated.count(BELL_RESOURCES)).toBe(0);

      await app.notifyPromptsListChanged([PROMPT]);
      expect(await waitFor(() => aggregated.count(BELL_PROMPTS) > 0)).toBe(true);
      expect(await waitFor(() => scoped.count(BELL_PROMPTS) > 0)).toBe(true);

      // …and the per-URI frame, which only the scoped shape carries at all.
      const subscribed = await rpc(
        ns,
        ns.tokens.reader.token,
        slug,
        { jsonrpc: "2.0", id: CONSUMER_ID, method: "resources/subscribe", params: { uri: URI } },
        { "Mcp-Session-Id": scoped.sessionId ?? "" },
      );
      expect(subscribed.status).toBe(200);
      await app.notifyResourcesUpdated(URI);
      expect(await waitFor(() => scoped.count(RESOURCES_UPDATED) > 0)).toBe(true);
      expect(aggregated.count(RESOURCES_UPDATED)).toBe(0);
    });
  });

  it("§21.4 · principal equality end to end: B's subscribe carrying A's live session id leaves A's stream silent for that URI, and B's own scoped stream receives the updated B subscribed — the sentence §21.1's \"steals nothing\" rests on", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const grants = { [slug]: [{ role: "all", mode: "allow" as const }] };
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [
          { slug: "alice", grants, tokens: [{ as: "alice" }] },
          { slug: "bob", grants, tokens: [{ as: "bob" }] },
        ],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token, { resources: [RESOURCE] });

      const alice = await listen(ns, ns.tokens.alice.token, slug);
      const bob = await listen(ns, ns.tokens.bob.token, slug);
      await settle();

      // B aims A's session id at its own bearer: the id selects, the principal authorizes.
      const stolen = await rpc(
        ns,
        ns.tokens.bob.token,
        slug,
        { jsonrpc: "2.0", id: CONSUMER_ID, method: "resources/subscribe", params: { uri: URI } },
        { "Mcp-Session-Id": alice.sessionId ?? "" },
      );
      expect(stolen.status).toBe(200);

      await app.notifyResourcesUpdated(URI);
      await ticks(2);
      expect(alice.count(RESOURCES_UPDATED)).toBe(0);

      // B's own stream, subscribed honestly, does receive it.
      await rpc(
        ns,
        ns.tokens.bob.token,
        slug,
        { jsonrpc: "2.0", id: CONSUMER_ID, method: "resources/subscribe", params: { uri: URI } },
        { "Mcp-Session-Id": bob.sessionId ?? "" },
      );
      await app.notifyResourcesUpdated(URI);
      expect(await waitFor(() => bob.count(RESOURCES_UPDATED) > 0)).toBe(true);
      expect(alice.count(RESOURCES_UPDATED)).toBe(0);
    });
  });

  it("§21.1/§21.4 · subscriptions die with the stream — subscribe on stream A, close A, reopen: the app's next updated for that URI reaches nobody, and the new stream's minted session id inherits nothing", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slug = uniqueSlug("notes");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [{ slug: "reader", grants: { [slug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token, { resources: [RESOURCE] });

      const first = await listen(ns, ns.tokens.reader.token, slug);
      await rpc(
        ns,
        ns.tokens.reader.token,
        slug,
        { jsonrpc: "2.0", id: CONSUMER_ID, method: "resources/subscribe", params: { uri: URI } },
        { "Mcp-Session-Id": first.sessionId ?? "" },
      );
      await app.notifyResourcesUpdated(URI);
      expect(await waitFor(() => first.count(RESOURCES_UPDATED) > 0)).toBe(true);

      await first.cancel();
      await settle();
      expect(await untilSockets(ns.apps[slug].id, 0)).toBe(0);

      const second = await listen(ns, ns.tokens.reader.token, slug);
      expect(second.sessionId).not.toBe(first.sessionId);
      await app.notifyResourcesUpdated(URI);
      await ticks(2);
      // The new stream inherited nothing: no subscription, so no frame.
      expect(second.count(RESOURCES_UPDATED)).toBe(0);
    });
  });
});

describe("§21.2 the fan-out", () => {
  it("§21.2 · LISTEN_FANOUT_MAX bounds the subscribed set in deterministic slug order — the same apps chosen across two concurrent streams over one namespace and across a close-and-reopen, the excess silent with no time qualifier", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const slugs = Array.from({ length: LISTEN_FANOUT_MAX + 2 }, (_, index) =>
        uniqueSlug(`s${String(index).padStart(2, "0")}`),
      ).sort();
      const grants = Object.fromEntries(
        slugs.map((slug) => [slug, [{ role: "all", mode: "allow" as const }]]),
      );
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: slugs.map((slug, index) => ({
          slug,
          kind: "tunnel" as const,
          tokens: [{ as: `app${index}` }],
        })),
        agents: [{ slug: "reader", grants, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const apps: FakeApp[] = [];
      for (let index = 0; index < slugs.length; index++) {
        apps.push(await connect(ns.tokens[`app${index}`].token));
      }

      const first = await listen(ns, ns.tokens.reader.token, null);
      const second = await listen(ns, ns.tokens.reader.token, null);
      await settle();

      const chosen = async (): Promise<string[]> => {
        const held: string[] = [];
        for (const slug of slugs) {
          if ((await subscriberSockets(ns.apps[slug].id)) > 0) held.push(slug);
        }
        return held;
      };

      // Deterministic slug order, and the SAME choice for both streams: two sockets each on
      // the first LISTEN_FANOUT_MAX apps, none at all on the excess.
      expect(await chosen()).toEqual(slugs.slice(0, LISTEN_FANOUT_MAX));
      expect(await untilSockets(ns.apps[slugs[0]].id, 2)).toBe(2);

      // The excess is silent with no time qualifier: it never rings, not "not yet".
      const excess = apps[slugs.length - 1];
      await excess.notifyToolsListChanged([TOOL]);
      await ticks(3);
      expect(first.notifications).toEqual([]);
      expect(second.notifications).toEqual([]);

      // …and the same set is chosen after a close and reopen.
      await first.cancel();
      await settle();
      const reopened = await listen(ns, ns.tokens.reader.token, null);
      await settle();
      expect(await chosen()).toEqual(slugs.slice(0, LISTEN_FANOUT_MAX));
      expect(reopened.closed).toBe(false);
    });
  });

  it("§21.2 · a mixed grant set discriminates: the tunneled app rings, the proxied app and the pmcp builtin never ring and no upstream is dialed", async () => {
    await withDeadlines(env, SHORT_DEADLINES, async () => {
      const tunneled = uniqueSlug("a-tunnel");
      const proxied = uniqueSlug("b-proxy");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [
          { slug: tunneled, kind: "tunnel", tokens: [{ as: "app" }] },
          {
            slug: proxied,
            kind: "proxy",
            upstreamUrl: "https://upstream.invalid/mcp",
            roles: { reader: ["*"] },
          },
        ],
        agents: [
          {
            slug: "reader",
            grants: {
              [tunneled]: [{ role: "all", mode: "allow" }],
              [proxied]: [{ role: "reader", mode: "allow" }],
            },
            tokens: [{ as: "reader" }],
          },
        ],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token);

      const aggregated = await listen(ns, ns.tokens.reader.token, null);
      await ticks(2);
      // No DO, no channel, nothing dialled: a proxied app is not subscribed at all, and
      // the invocation that would have dialled an unroutable upstream never ran.
      expect(await subscriberSockets(ns.apps[proxied].id)).toBe(0);
      expect(aggregated.notifications).toEqual([]);
      expect(aggregated.closed).toBe(false);

      // The tunneled one in the same grant set still rings.
      await app.notifyToolsListChanged([TOOL]);
      expect(await waitFor(() => aggregated.count(BELL_TOOLS) > 0)).toBe(true);

      // …and the builtin, which every owner-scoped caller can address, rings nothing ever.
      const builtin = await listen(ns, ns.tokens.reader.token, "pmcp");
      await ticks(3);
      expect(builtin.notifications).toEqual([]);
    });
  });

  it("§15/§21.1 · with CALL_TIMEOUT_MS set short through the hub's own binding, a forwarded call against a hanging tunneled app fails at the shrunk deadline while the stream on the same hub is still delivering keepalives past it — the 30 s budget governs forwarded requests, never the held response", async () => {
    await withDeadlines(env, SHORT_DEADLINES_AND_CALL, async () => {
      const slug = uniqueSlug("notes");
      const ns = await seedNamespace(env.DB, {
        username: uniqueSlug("stream"),
        apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
        agents: [{ slug: "reader", grants: { [slug]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "reader" }] }],
      });
      seeded.push(ns);
      const app = await connect(ns.tokens.app.token, { tools: [TOOL] });
      app.setBehavior(TOOL.name, { mode: "hang" });

      const stream = await listen(ns, ns.tokens.reader.token, slug);
      const before = stream.comments.length;

      const startedAt = Date.now();
      const refused = await rpc(ns, ns.tokens.reader.token, slug, {
        jsonrpc: "2.0",
        id: CONSUMER_ID,
        method: "tools/call",
        params: { name: TOOL.name, arguments: {} },
      });
      const elapsed = Date.now() - startedAt;

      expect(refused.body).toMatchObject({ error: { code: -32000 } });
      expect(elapsed, "the deadline was waited out rather than shrunk").toBeLessThan(
        CALL_TIMEOUT_MS,
      );

      // The held response outlives the call budget: it is not a forwarded request.
      await ticks(3);
      expect(stream.closed).toBe(false);
      expect(stream.comments.length).toBeGreaterThan(before);
    });
  });
});
