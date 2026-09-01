// listen.test.ts — §21.1's door: what a `subscriptions/listen` request gets back, and who
// is allowed to ask.
//
// WHAT THIS SUITE PINS that no other file can. tunnel/stream.test.ts holds real subscriber
// sockets and asserts what a stream DELIVERS; this file asserts the envelope and the
// admission — the status and content type on both endpoint shapes, the session id the hub
// mints (and never echoes), the keepalive's FORM, and that the method sits behind exactly
// the door every other `/:user/mcp*` message sits behind. The two halves are deliberately
// split: a stream is a held response, and the one property a held response makes easy to
// get wrong is that its refusals are decided BEFORE the first byte, by the same step 1 as a
// POST.
//
// Project: `worker` — real D1, no sockets. That is a fixture choice with teeth: every
// app here is PROXIED or unresolvable, and §21.2 has the hub dial neither, so a stream
// in this file opens without a single WebSocket. A row that needed one would belong to the
// tunnel project by construction, which is exactly where the delivery rows live.
//
// Every case cancels its stream. A held response with nobody reading it is a pending
// keepalive timer in the runtime, and the worker project runs files in parallel.
//
// deps: harness/seed (seedNamespace, seedOwnerSession, uniqueSlug) · harness/fake-upstream
//   (upstreamUrlFor) · ../../src/index (default.fetch) · ../../src/limits
//   (LISTEN_KEEPALIVE_MS) · applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { LISTEN_KEEPALIVE_MS } from "../../src/limits";
import { upstreamUrlFor } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

const APP = "notion";
const AGENT = "agent";
const ROLE = "reader";
const TOKEN = "key";

/** The consumer's own JSON-RPC id on the request that opens a stream. */
const CONSUMER_ID = 7;

/** A session id a CONSUMER made up. Obviously fake, and shaped like a real one so a hub
 *  that echoed it would look correct rather than corrupt. */
const CLIENT_SESSION_ID = "FAKE0000-0000-4000-8000-000000000000";

/** What the shim shrinks LISTEN_KEEPALIVE_MS to for the one row that counts ticks — a
 *  test-run duration, not a spec number, which is why it is not a limits.ts constant. */
const SHRUNK_KEEPALIVE_MS = 25;

/**
 * One held stream, read the only way a never-ending body can be: pumped in the background,
 * projected into what has arrived so far. Nothing here awaits the body whole.
 */
class Held {
  readonly status: number;
  readonly contentType: string | null;
  readonly sessionId: string | null;
  private readonly blocks: string[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private buffer = "";

  constructor(response: Response) {
    this.status = response.status;
    this.contentType = response.headers.get("Content-Type");
    this.sessionId = response.headers.get("Mcp-Session-Id");
    this.reader = response.body === null ? null : response.body.getReader();
    void this.pump();
  }

  /** The SSE COMMENT blocks — lines beginning with `:`, which carry no event at all. */
  get comments(): string[] {
    return this.blocks.filter((block) => block.startsWith(":"));
  }

  /** Every `data:` payload, parsed — a keepalive read as JSON-RPC is the failure §21.1's
   *  "the form is pinned" sentence exists to prevent, so both are read separately. */
  get notifications(): unknown[] {
    return this.blocks
      .flatMap((block) => block.split("\n"))
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length).trim()) as unknown);
  }

  /**
   * Wait until the stream has delivered `count` blocks, or the budget runs out — REAL time,
   * deliberately: workerd is the runtime under test, vitest's fake timers do not reach
   * inside it, and what is being waited on is the hub's own keepalive, whose constant the
   * shim below already shrank to milliseconds. Nothing here waits out a spec number. The
   * `new Promise` executor is the lib's fault, not a preference: `Promise.withResolvers` is
   * ES2024 and this repo compiles against ES2022.
   */
  async blocksAtLeast(count: number, budgetMs: number): Promise<number> {
    const deadline = Date.now() + budgetMs;
    while (this.blocks.length < count && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    return this.blocks.length;
  }

  async cancel(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    if (this.reader === null) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        this.buffer += decoder.decode(value, { stream: true });
        const parts = this.buffer.split("\n\n");
        this.buffer = parts.pop() ?? "";
        for (const part of parts) if (part.trim() !== "") this.blocks.push(part.trim());
      }
    } catch {
      // A cancelled body is an ended stream, which is all any row here needs of it.
    }
  }
}

const held: Held[] = [];
const seeded: SeededNamespace[] = [];

afterEach(async () => {
  for (const stream of held.splice(0)) await stream.cancel();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/**
 * A namespace holding one PROXIED app — never dialed by a stream (§21.2), so this whole
 * file needs no socket — plus one agent. `grants` and `roles` are the two knobs
 * the admission rows turn.
 */
async function seedWorld(
  spec: { roles?: Record<string, string[]>; granted?: boolean } = {},
): Promise<SeededNamespace> {
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: APP,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor({ id: uniqueSlug("up"), mode: { kind: "ok" }, tools: [] }),
        roles: spec.roles ?? { [ROLE]: ["*"] },
      },
    ],
    agents: [
      {
        slug: AGENT,
        grants: spec.granted === false ? {} : { [APP]: [{ role: ROLE, mode: "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  seeded.push(ns);
  return ns;
}

/** One `subscriptions/listen`, exactly as a consumer sends it: an ordinary JSON-RPC POST on
 *  either endpoint shape. `slug` null is the aggregated one. */
async function listen(
  ns: SeededNamespace,
  credential: string | null,
  slug: string | null,
  extra: Record<string, string> = {},
): Promise<Held> {
  const base = `${ORIGIN}/${ns.owner.username}/mcp`;
  const response = await worker.fetch(
    new Request(slug === null ? base : `${base}/${slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: CONSUMER_ID, method: "subscriptions/listen" }),
    }),
    env as unknown as Env,
  );
  const stream = new Held(response);
  held.push(stream);
  return stream;
}

/**
 * Run `body` with LISTEN_KEEPALIVE_MS shrunk to a test-run duration. The mapping is EXACT —
 * `ms === LISTEN_KEEPALIVE_MS` — so no other timer in the worker moves, and a row that
 * thinks it watched the keepalive cannot have watched something else that was merely longer.
 */
async function withShrunkKeepalive<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    (real as (...args: unknown[]) => unknown)(
      handler,
      ms === LISTEN_KEEPALIVE_MS ? SHRUNK_KEEPALIVE_MS : ms,
      ...rest,
    )) as typeof globalThis.setTimeout;
  try {
    return await body();
  } finally {
    globalThis.setTimeout = real;
  }
}

/** UUID as the hub mints it (crypto.randomUUID): version 4, variant 8/9/a/b. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every case opens a real endpoint against real D1; the budget is generous so a hang fails
 *  rather than flakes. */
const CASE_BUDGET_MS = 30_000;

describe("§21.1 · the listen envelope", () => {
  it("§21.1 · subscriptions/listen answers 200 text/event-stream on BOTH endpoint shapes — one chunk read off the body, then cancelled, never awaited whole", async () => {
    const ns = await seedWorld();

    for (const slug of [null, APP]) {
      const stream = await listen(ns, ns.tokens[TOKEN].token, slug);
      const shape = slug === null ? "aggregated" : "scoped";
      expect(stream.status, shape).toBe(200);
      expect(stream.contentType, shape).toContain("text/event-stream");
      // A held response that writes nothing until its first interval would leave a client
      // unable to tell an open stream from a hung one, so the open writes a byte.
      expect(
        await stream.blocksAtLeast(1, CASE_BUDGET_MS),
        `${shape}: nothing arrived`,
      ).toBeGreaterThan(0);
      await stream.cancel();
    }
  }, CASE_BUDGET_MS);

  it("§21.1 · the response carries an Mcp-Session-Id the hub minted, UUID-shaped — a client-supplied one is never echoed, and two opens with the same bearer never collide", async () => {
    const ns = await seedWorld();
    const credential = ns.tokens[TOKEN].token;

    const first = await listen(ns, credential, null);
    // The same bearer, and a session id the CONSUMER chose: neither may decide the answer.
    const second = await listen(ns, credential, null, { "Mcp-Session-Id": CLIENT_SESSION_ID });

    expect(first.sessionId).toMatch(UUID);
    expect(second.sessionId).toMatch(UUID);
    expect(second.sessionId, "a client-supplied id was echoed back").not.toBe(CLIENT_SESSION_ID);
    // Uniqueness is the hub's own property, which is what lets a subscribe select among one
    // principal's streams (§21.4) rather than merely among distinct bearers.
    expect(first.sessionId).not.toBe(second.sessionId);
  }, CASE_BUDGET_MS);

  it("§21.1 · while nothing changes the stream carries one SSE COMMENT per shrunk LISTEN_KEEPALIVE_MS and no data frame — a client parsing keepalives as JSON-RPC breaks on the first idle stream, so the form is pinned", async () => {
    await withShrunkKeepalive(async () => {
      const ns = await seedWorld();
      const stream = await listen(ns, ns.tokens[TOKEN].token, null);

      // Three blocks: the open's own, and at least two ticks after it.
      expect(await stream.blocksAtLeast(3, CASE_BUDGET_MS)).toBeGreaterThanOrEqual(3);
      // Comments, not events: every block is a `:` line, and NOTHING on this idle stream
      // parses as a JSON-RPC message.
      expect(stream.comments.length).toBeGreaterThanOrEqual(3);
      expect(stream.notifications).toEqual([]);
    });
  }, CASE_BUDGET_MS);
});

describe("§21.1/§7 · who may open one", () => {
  it("§21.1/§7 · the listen route is behind the same door — no bearer is 401 with the standard WWW-Authenticate challenge, another user's namespace is 404, a cookie session is never consulted, and a client-supplied Mcp-Session-Id authenticates nothing", async () => {
    const ns = await seedWorld();
    const stranger = await seedWorld();
    const session = await seedOwnerSession(ns.owner);

    const anonymous = await listen(ns, null, null);
    expect(anonymous.status).toBe(401);

    // The challenge is the door's, byte-identical to every other /mcp* 401 (§7, §19.2).
    const challenged = await worker.fetch(
      new Request(`${ORIGIN}/${ns.owner.username}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: CONSUMER_ID, method: "subscriptions/listen" }),
      }),
      env as unknown as Env,
    );
    expect(challenged.headers.get("WWW-Authenticate")).toContain("Bearer");

    // A resolved caller on somebody else's namespace: 404, never a stream and never a 401
    // that would invite it to authenticate differently.
    const foreign = await listen(stranger, ns.tokens[TOKEN].token, null);
    expect(foreign.status).toBe(404);

    // The browser credential the admin surface runs on is not a credential here.
    const cookied = await listen(ns, null, null, { Cookie: session.cookie });
    expect(cookied.status, "a cookie session opened a stream").toBe(401);

    // …and the one header §21.1 does read is correlation, never authentication.
    const guessed = await listen(ns, null, null, { "Mcp-Session-Id": CLIENT_SESSION_ID });
    expect(guessed.status).toBe(401);
  }, CASE_BUDGET_MS);

  it("§21.1/§7 · an agent with no grant on the addressed app gets 404 from a scoped listen — never a stream, never -32002, the anti-enumeration matrix untouched · the admitted caller whose patterns match nothing gets the silent stream (the twin)", async () => {
    const ungranted = await seedWorld({ granted: false });

    const refused = await listen(ungranted, ungranted.tokens[TOKEN].token, APP);
    expect(refused.status).toBe(404);
    expect(refused.contentType, "a stream was opened for a caller the door refuses").not.toContain(
      "text/event-stream",
    );
    // Indistinguishable from a slug that does not exist at all, which is the whole rule.
    const unresolvable = await listen(
      ungranted,
      ungranted.tokens[TOKEN].token,
      uniqueSlug("nothing"),
    );
    expect(unresolvable.status).toBe(404);

    // The twin: a caller the door ADMITS whose role matches nothing gets a stream that
    // simply never rings — listing-class, exactly as an empty tools/list is.
    const matchless = await seedWorld({ roles: { [ROLE]: ["matches-nothing"] } });
    const silent = await listen(matchless, matchless.tokens[TOKEN].token, APP);
    expect(silent.status).toBe(200);
    expect(silent.contentType).toContain("text/event-stream");
    expect(await silent.blocksAtLeast(1, CASE_BUDGET_MS)).toBeGreaterThan(0);
    expect(silent.notifications).toEqual([]);
  }, CASE_BUDGET_MS);

  it("§21.1 · an owner's aggregated stream with zero granted tunneled apps opens and keepalives — a stream over nothing is a legal answer", async () => {
    await withShrunkKeepalive(async () => {
      // One proxied app and nothing else: §21.2 dials neither a proxied app nor the
      // builtin, so this namespace holds nothing for a stream to subscribe at all.
      const ns = await seedWorld();
      const owner = await seedOwnerSession(ns.owner);

      const stream = await listen(ns, owner.token, null);

      expect(stream.status).toBe(200);
      expect(stream.contentType).toContain("text/event-stream");
      // Not merely opened: it keeps itself alive, which is what makes an empty stream a
      // usable answer rather than a connection an intermediary will reap.
      expect(await stream.blocksAtLeast(2, CASE_BUDGET_MS)).toBeGreaterThanOrEqual(2);
      expect(stream.notifications).toEqual([]);
    });
  }, CASE_BUDGET_MS);
});
