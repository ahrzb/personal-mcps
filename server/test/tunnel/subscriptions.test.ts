/**
 * tunnel/subscriptions.test.ts — §21.4's per-URI half: `resources/subscribe`, the
 * subscription set that lives on the subscriber socket's attachment, and the
 * `notifications/resources/updated` the DO routes by exact URI match.
 *
 * WHAT THIS SUITE PINS. The selection rule, in both halves: the SESSION ID selects the
 * socket and the STORED PRINCIPAL authorizes the mutation, so a subscribe carrying somebody
 * else's session id changes nothing and hears nothing — the sentence §21.1's "a guessed or
 * replayed session id steals nothing" rests on. The caps, at the boundary they are enforced
 * on: `LISTEN_SUBSCRIPTIONS_MAX` URIs of at most `SUBSCRIBE_URI_MAX_BYTES` each, refused
 * before anything is stored or forwarded, with the attachment left exactly as it was. And
 * the routing rule: an `updated` reaches only the sockets whose set CONTAINS its uri, by
 * exact string match — the hub normalizes nothing, so a trailing slash is a different
 * resource — and it invalidates no catalog, unlike its three `list_changed` siblings.
 *
 * WHERE THE DOOR IS, and why this file spells part of it. §21.4's order is: the DO decides
 * (which socket, whose principal, which caps), and the Worker decides what a refusal is
 * CALLED on the consumer wire (-32602) and whether the frame is forwarded. The Worker's
 * spelling of that rule — the method table, the URI filter, the audit rows — is
 * worker/order.table.test.ts's and worker/hygiene.test.ts's subject. THIS file's subject is
 * the seam underneath, so it drives the DO's verdict and then forwards exactly as §21.4
 * says the door does (see `subscribeAtTheDoor`). Nothing here re-derives the DO's answer:
 * every refusal, every mutation and every relay is the hub's, observed from outside.
 *
 * SUITE DISCIPLINE: subscriber sockets are opened through the DO's own fetch door
 * (`stub.fetch(upgrade)`, peer accepted test-side) exactly as the Worker opens them —
 * never fabricated inside `runInDurableObject`, which produces a socket that vanishes at
 * the first eviction. The subscription set is read back through `runInDurableObject`, and
 * that is the one place this file looks inside: an attachment has no behavior of its own
 * beyond the routing every other row already observes from the wire.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): live sockets and a
 * DO. Every case mints its own namespace and service, so nothing here can be answered by
 * another case's socket.
 */

// deps: harness/seed · harness/fake-service (connectFakeService, openSubscriber, tick, waitFor) · harness/tunnel-do (backendCtx, connectionStub) · cloudflare:test (env, runInDurableObject) · src/tunnel (tunnelBackend, subscribe, unsubscribe) · src/capabilities (RESOURCES_UPDATED, uriByteLength) · src/limits (LISTEN_SUBSCRIPTIONS_MAX, SUBSCRIBE_URI_MAX_BYTES) · src/registry (Registry)

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCES_UPDATED, uriByteLength } from "../../src/capabilities";
import type { Tool } from "../../src/gateway";
import { LISTEN_SUBSCRIPTIONS_MAX, SUBSCRIBE_URI_MAX_BYTES } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { subscribe, tunnelBackend, unsubscribe } from "../../src/tunnel";
import type { ServiceConnection, SubscribeOutcome } from "../../src/tunnel";
import { connectFakeService, openSubscriber, tick, waitFor } from "../harness/fake-service";
import type {
  CatalogEntry,
  FakeService,
  FakeServiceOptions,
  FakeSubscriber,
} from "../harness/fake-service";
import { seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { backendCtx, connectionStub } from "../harness/tunnel-do";

// ── the fixture and the plumbing every case here shares ───────────────────────────────

type Fixture = {
  origin: string;
  ownerId: string;
  slug: string;
  serviceId: string;
  token: string;
};

const seeded: SeededNamespace[] = [];
const opened: FakeService[] = [];
const streams: FakeSubscriber[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
  for (const service of opened.splice(0)) await service.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

async function seedFixture(): Promise<Fixture> {
  const slug = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("subs"),
    services: [{ slug, kind: "tunnel", tokens: [{ as: "token" }] }],
  });
  seeded.push(namespace);
  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    slug,
    serviceId: namespace.services[slug].id,
    token: namespace.tokens.token.token,
  };
}

/** A registered socket serving the resources family, its warm landed — the state every
 *  case here starts from, since subscribe is a resources-family method. */
async function warmed(
  fixture: Fixture,
  options: Partial<FakeServiceOptions> = {},
): Promise<FakeService> {
  const service = await connectFakeService({
    origin: fixture.origin,
    token: fixture.token,
    tools: [],
    resources: [RESOURCE],
    ...options,
  });
  opened.push(service);
  expect(await service.registered).toEqual({ ok: true });
  // tools + resources + resource templates: three lists, the resources declaration warming
  // two keys (§20.5).
  expect(await waitFor(() => listCount(service) >= 3), "the registration never warmed").toBe(true);
  await settle();
  return service;
}

/** Every hub-originated list this socket has received — the four §20.5 methods share the
 *  `/list` tail, and nothing else the hub sends does. */
function listCount(service: FakeService): number {
  return service.frames.filter(
    (frame) => typeof frame.method === "string" && frame.method.endsWith("/list"),
  ).length;
}

/** Every `resources/subscribe` / `resources/unsubscribe` frame the service received — what
 *  "still forwarded" and "no frame at the service" are both read off. */
function forwarded(service: FakeService, method: string): Record<string, unknown>[] {
  return service.frames.filter((frame) => frame.method === method);
}

async function subscriber(
  fixture: Fixture,
  options: { principal?: string; sessionId?: string } = {},
): Promise<FakeSubscriber> {
  const stream = await openSubscriber(connectionStub(fixture.serviceId), {
    principal: options.principal ?? PRINCIPAL,
    sessionId: options.sessionId,
  });
  streams.push(stream);
  return stream;
}

/**
 * §21.4's door, in the order the spec states it: the DO decides first — which socket, whose
 * principal, which caps — and only a verdict that is not a refusal is forwarded. A refusal
 * is `-32602` on the consumer wire and forwards NOTHING, which is why this helper returns
 * the code rather than throwing: the rows read both halves.
 *
 * The Worker's own spelling of this rule (the method table, the resource-pattern filter
 * that runs before any of it, the audit row) belongs to the worker project's suites. What
 * is asserted here is only what the DO decided and what actually reached the service.
 */
async function subscribeAtTheDoor(
  fixture: Fixture,
  options: { sessionId: string; uri: string; principal?: string; meta?: Record<string, unknown> },
): Promise<{ outcome: SubscribeOutcome; refusal: number | null }> {
  const principal = options.principal ?? PRINCIPAL;
  const outcome = await subscribe(fixture.serviceId, options.sessionId, principal, options.uri);
  if (outcome === "refused") return { outcome, refusal: REFUSAL_CODE };
  await forward(fixture, "resources/subscribe", options.uri, options.meta);
  return { outcome, refusal: null };
}

/** The mirror. Nothing about a removal can exceed a cap, so it has no refusal branch — it
 *  matches, removes, and forwards (§21.4). */
async function unsubscribeAtTheDoor(
  fixture: Fixture,
  options: { sessionId: string; uri: string; principal?: string },
): Promise<void> {
  await unsubscribe(fixture.serviceId, options.sessionId, options.principal ?? PRINCIPAL, options.uri);
  await forward(fixture, "resources/unsubscribe", options.uri);
}

/** One forwarded frame through the ordinary backend seam — the same path every other
 *  consumer-driven method takes, which is what makes §7's `_meta` hygiene observable here. */
async function forward(
  fixture: Fixture,
  method: string,
  uri: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await tunnelBackend.call(
    await serviceRow(fixture),
    {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method,
      params: { uri, ...(meta === undefined ? {} : { _meta: meta }) },
    },
    backendCtx(),
  );
}

/**
 * The subscription sets the DO holds for one session id, with the principal each is stored
 * under — the one place this file looks inside a socket, because an attachment has no
 * behavior of its own beyond the routing every other row observes from the wire.
 */
async function setsFor(
  fixture: Fixture,
  sessionId: string,
): Promise<{ principal: string; uris: string[] }[]> {
  return runInDurableObject(
    connectionStub(fixture.serviceId),
    (_instance: ServiceConnection, state) =>
      state.getWebSockets(`sub:${sessionId}`).map((ws) => {
        const raw = ws.deserializeAttachment();
        if (raw === null || typeof raw !== "object") return { principal: "", uris: [] };
        const principal = "principal" in raw ? String(raw.principal) : "";
        const stored = "uris" in raw ? raw.uris : [];
        return { principal, uris: Array.isArray(stored) ? stored.map(String) : [] };
      }),
  );
}

/** The one socket's set — every row but the two-principals one holds exactly one. */
async function setFor(fixture: Fixture, sessionId: string): Promise<string[]> {
  const sets = await setsFor(fixture, sessionId);
  expect(sets).toHaveLength(1);
  return sets[0].uris;
}

/** A few turns of the loop — long enough for a DO write and the frame it produced. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await tick();
}

/** Fire the coalescing alarm and let what it wrote arrive — every claim that a frame rang
 *  NOBODY ends here, since a suppressed ring and an absent one are otherwise the same. */
async function drain(fixture: Fixture): Promise<void> {
  await runDurableObjectAlarm(connectionStub(fixture.serviceId));
  await settle();
}

async function serviceRow(fixture: Fixture): Promise<Service> {
  const row = await new Registry(env.DB).getService(fixture.ownerId, fixture.slug);
  if (row === null) throw new Error("the fixture's service vanished");
  return row;
}

/** A URI of exactly `bytes` UTF-8 bytes, or one byte past the cap — the boundary is
 *  measured with the hub's own ruler, since "one byte over" is the whole claim. */
function uriOfBytes(bytes: number, seed = "a"): string {
  const prefix = "file:///";
  const uri = prefix + seed.repeat(bytes - prefix.length);
  expect(uriByteLength(uri)).toBe(bytes);
  return uri;
}

/** What §21.4 says a cap refusal is called on the consumer wire — spelled, because the
 *  point of the row is that the number reaches a consumer at all (it is the sixth code). */
const REFUSAL_CODE = -32602;

const PRINCIPAL = "acct:reader";
const OTHER_PRINCIPAL = "acct:intruder";

const URI = "file:///notes.md";
const OTHER_URI = "file:///other.md";

const RESOURCE: CatalogEntry = { uri: URI, name: "notes" };

const TOOL: Tool = { name: "search", inputSchema: { type: "object" } };

/** The consumer's own JSON-RPC id, which §6 forbids from ever crossing the socket. */
const CONSUMER_ID = 4242;

// ── §21.4 the mutation ────────────────────────────────────────────────────────────────

describe("§21.4 the id selects, the principal authorizes", () => {
  it("§21.4 · resources/subscribe adds the URI to the socket whose tag matches the session AND whose stored principal equals the subscriber's · the same session id presented by a different principal mutates nothing, and that socket never receives the updated (the twin — the id selects, the principal authorizes)", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    expect(await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI })).toEqual({
      outcome: "stored",
      refusal: null,
    });
    expect(await setsFor(fixture, stream.sessionId)).toEqual([
      { principal: PRINCIPAL, uris: [URI] },
    ]);

    // The twin: the same session id, another bearer. The socket is found and refused.
    const intruder = await subscribeAtTheDoor(fixture, {
      sessionId: stream.sessionId,
      uri: OTHER_URI,
      principal: OTHER_PRINCIPAL,
    });
    expect(intruder.outcome).toBe("no_stream");
    expect(await setFor(fixture, stream.sessionId)).toEqual([URI]);

    await service.notifyResourcesUpdated(OTHER_URI);
    await settle();
    expect(stream.count(RESOURCES_UPDATED)).toBe(0);
    // …while the URI this principal really did subscribe still reaches it.
    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });

  it("§21.4 · a subscribe whose session-and-principal pair matches no live subscriber socket is still forwarded and stores nothing — a legal MCP request whose notifications are simply undeliverable", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const orphan = crypto.randomUUID();

    const answer = await subscribeAtTheDoor(fixture, { sessionId: orphan, uri: URI });

    expect(answer).toEqual({ outcome: "no_stream", refusal: null });
    expect(await setsFor(fixture, orphan)).toEqual([]);
    // Forwarded all the same: the service is entitled to know, and the notifications it
    // sends back are simply undeliverable.
    expect(forwarded(service, "resources/subscribe")).toHaveLength(1);
  });

  it("§21.4/§7 · the forwarded subscribe carries hub/principal, hub/roles and the mirrored clientCapabilities under the same strip-then-set — a consumer-forged hub/roles is stripped while progressToken survives", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, {
      sessionId: stream.sessionId,
      uri: URI,
      meta: {
        "hub/roles": ["forged-admin"],
        "hub/principal": "user:somebody-else",
        progressToken: "pt-1",
        "io.modelcontextprotocol/clientCapabilities": { roots: { listChanged: true } },
      },
    });

    expect(forwarded(service, "resources/subscribe")[0]).toMatchObject({
      params: {
        uri: URI,
        _meta: {
          // The hub's own answer to both questions, whatever the consumer claimed.
          "hub/principal": "user:fixture-owner",
          "hub/roles": ["all"],
          // The consumer's own key rides through untouched…
          progressToken: "pt-1",
          // …as does what it mirrored, beside the revision every hub-originated frame carries.
          "io.modelcontextprotocol/clientCapabilities": { roots: { listChanged: true } },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    });
  });
});

// ── §21.4 the caps ────────────────────────────────────────────────────────────────────

describe("§21.4 the subscription set is bounded", () => {
  it("§21.4 · the LISTEN_SUBSCRIPTIONS_MAX+1-th subscribe is refused -32602 with the attachment unchanged and no frame at the service · the at-cap subscribe succeeds (the twin)", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    const atCap: string[] = [];
    for (let index = 0; index < LISTEN_SUBSCRIPTIONS_MAX; index++) {
      const uri = `file:///doc-${index}.md`;
      atCap.push(uri);
      // The twin lives inside the loop's last turn: the MAX-th subscribe is accepted.
      expect(await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri })).toEqual({
        outcome: "stored",
        refusal: null,
      });
    }
    expect(await setFor(fixture, stream.sessionId)).toEqual(atCap);
    expect(forwarded(service, "resources/subscribe")).toHaveLength(LISTEN_SUBSCRIPTIONS_MAX);

    const overCap = await subscribeAtTheDoor(fixture, {
      sessionId: stream.sessionId,
      uri: "file:///one-too-many.md",
    });

    expect(overCap).toEqual({ outcome: "refused", refusal: REFUSAL_CODE });
    expect(await setFor(fixture, stream.sessionId)).toEqual(atCap);
    // Refused BEFORE anything is stored or forwarded: the service never heard of it.
    expect(forwarded(service, "resources/subscribe")).toHaveLength(LISTEN_SUBSCRIPTIONS_MAX);
  });

  it("§21.4 · an over-SUBSCRIBE_URI_MAX_BYTES URI is refused -32602 by the same rule", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    const overLong = uriOfBytes(SUBSCRIBE_URI_MAX_BYTES + 1);
    const refused = await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: overLong });

    expect(refused).toEqual({ outcome: "refused", refusal: REFUSAL_CODE });
    expect(await setFor(fixture, stream.sessionId)).toEqual([]);
    expect(forwarded(service, "resources/subscribe")).toHaveLength(0);

    // The allow-twin, one byte down: the boundary is the cap itself, not an approximation.
    const atCap = uriOfBytes(SUBSCRIBE_URI_MAX_BYTES);
    expect(await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: atCap })).toEqual({
      outcome: "stored",
      refusal: null,
    });
  });

  it("§21.4/§5 · a socket filled to both caps serializeAttachments without throwing and deserializes to the full set — the caps' product fits the 16 KB the platform enforces", async () => {
    const fixture = await seedFixture();
    await warmed(fixture);
    const stream = await subscriber(fixture);

    const full: string[] = [];
    for (let index = 0; index < LISTEN_SUBSCRIPTIONS_MAX; index++) {
      // Every URI at the byte cap: the worst case the two constants can produce together.
      const uri = uriOfBytes(SUBSCRIBE_URI_MAX_BYTES, String.fromCharCode(97 + index));
      full.push(uri);
      expect(
        (await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri })).outcome,
      ).toBe("stored");
    }

    // Written by the DO through serializeAttachment and read back through the platform's
    // own deserialization — the whole set, not a truncation.
    expect(await setFor(fixture, stream.sessionId)).toEqual(full);
    expect(full.reduce((bytes, uri) => bytes + uriByteLength(uri), 0)).toBeLessThan(16 * 1024);
  });

  it("§21.4 · the subscription set is a SET — re-subscribing an existing URI neither counts toward the cap nor doubles the updated frames", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    expect(await setFor(fixture, stream.sessionId)).toEqual([URI]);

    // The duplicates cost nothing: the cap's remaining room is untouched by them.
    for (let index = 1; index < LISTEN_SUBSCRIPTIONS_MAX; index++) {
      expect(
        (await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: `file:///d-${index}` }))
          .outcome,
      ).toBe("stored");
    }
    expect(await setFor(fixture, stream.sessionId)).toHaveLength(LISTEN_SUBSCRIPTIONS_MAX);

    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
    await settle();
    expect(stream.count(RESOURCES_UPDATED)).toBe(1);
  });

  it("§21.4 · resources/unsubscribe removes the URI and forwards · an updated for it afterwards rings nobody (the twin) · unsubscribing a URI never in the set is a forwarded no-op that disturbs nothing", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: OTHER_URI });

    await unsubscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    expect(await setFor(fixture, stream.sessionId)).toEqual([OTHER_URI]);
    expect(forwarded(service, "resources/unsubscribe")).toHaveLength(1);

    await service.notifyResourcesUpdated(URI);
    await settle();
    expect(stream.count(RESOURCES_UPDATED)).toBe(0);

    // A URI that was never in the set: forwarded like any other, and it disturbs nothing.
    await unsubscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: "file:///never.md" });
    expect(await setFor(fixture, stream.sessionId)).toEqual([OTHER_URI]);
    expect(forwarded(service, "resources/unsubscribe")).toHaveLength(2);
    await service.notifyResourcesUpdated(OTHER_URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });
});

// ── §21.4 the routing ─────────────────────────────────────────────────────────────────

describe("§21.4 notifications/resources/updated is routed, never broadcast", () => {
  it("§21.4/§6 · notifications/resources/updated reaches ONLY the subscriber sockets whose set contains the frame's URI by exact string match — a sibling socket subscribed to a different URI gets nothing (the twin)", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const mine = await subscriber(fixture);
    const sibling = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, { sessionId: mine.sessionId, uri: URI });
    await subscribeAtTheDoor(fixture, { sessionId: sibling.sessionId, uri: OTHER_URI });

    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => mine.count(RESOURCES_UPDATED) > 0)).toBe(true);
    await settle();
    expect(mine.count(RESOURCES_UPDATED)).toBe(1);
    expect(sibling.count(RESOURCES_UPDATED)).toBe(0);

    // …and the other way round, so neither socket is merely the lucky first one.
    await service.notifyResourcesUpdated(OTHER_URI);
    expect(await waitFor(() => sibling.count(RESOURCES_UPDATED) > 0)).toBe(true);
    await settle();
    expect(mine.count(RESOURCES_UPDATED)).toBe(1);
  });

  it("§21.4 · a rogue updated for a URI nobody subscribed is inert, and exact match means exact — trailing slash, case, or an added query component match nothing, because the hub normalizes no URI here", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });

    for (const rogue of [
      "file:///nobody-asked.md",
      `${URI}/`,
      URI.toUpperCase(),
      `${URI}?version=2`,
    ]) {
      await service.notifyResourcesUpdated(rogue);
    }
    await settle();
    await drain(fixture);
    expect(stream.frames).toEqual([]);

    // The control: the exact string still routes, so the silence above is about matching.
    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });

  it("§21.4 · a matching updated is written to the socket exactly as the service sent it — uri intact", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.frames.length > 0)).toBe(true);

    expect(stream.frames[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: URI },
    });
  });

  it("§21.4/§20.5 · updated is routing-only — it invalidates no catalog and triggers no re-warm, unlike its three list_changed siblings", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);
    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    const listed = listCount(service);

    // The service changes what it WOULD serve, then sends only the per-URI frame.
    service.setCatalog("resources", []);
    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
    await settle();
    await drain(fixture);

    // No re-list was drawn…
    expect(listCount(service)).toBe(listed);
    // …the cache still serves what the last warm stored…
    expect(await connectionStub(fixture.serviceId).listCatalog("resources")).toEqual([RESOURCE]);
    // …and no bell rang, because nothing the hub stores changed.
    expect(stream.count("notifications/resources/list_changed")).toBe(0);

    // The sibling frame, for contrast: THAT one re-lists and rings.
    await service.notifyResourcesListChanged([]);
    expect(await waitFor(() => listCount(service) > listed)).toBe(true);
    expect(
      await waitFor(() => stream.count("notifications/resources/list_changed") > 0),
    ).toBe(true);
  });

  it("§21.4/§6 · every other service-originated frame is still dropped, and a frame sent BY a subscriber socket is never read as service traffic — it can neither warm a catalog nor ring a bell", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);
    await subscribeAtTheDoor(fixture, { sessionId: stream.sessionId, uri: URI });
    const listed = listCount(service);

    // From the SERVICE: a notification outside the read-set, and a request the hub never
    // answers on this socket.
    await service.sendRaw({ jsonrpc: "2.0", method: "notifications/progress", params: { n: 1 } });
    await service.sendRaw({ jsonrpc: "2.0", id: "svc-1", method: "sampling/createMessage" });

    // From the SUBSCRIBER: the two frames that would be loudest if the DO read them.
    await stream.sendRaw({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await stream.sendRaw({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: URI },
    });
    await settle();
    await drain(fixture);

    expect(listCount(service)).toBe(listed);
    expect(stream.frames).toEqual([]);
    // Still healthy afterwards: the DO dropped those frames rather than the connection.
    await service.notifyResourcesUpdated(URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });

  it("§21.4/§6 · a subscriber socket's close does not drain the service socket's pending map — an in-flight tools/call survives a consumer's stream ending", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture, { tools: [TOOL], behavior: { mode: "hang" } });
    const stream = await subscriber(fixture);

    const call = tunnelBackend.call(
      await serviceRow(fixture),
      { jsonrpc: "2.0", id: CONSUMER_ID, method: "tools/call", params: { name: TOOL.name } },
      backendCtx(),
    );
    expect(await waitFor(() => service.callCount(TOOL.name) === 1)).toBe(true);

    // The consumer's stream ends mid-call — a close on a socket the pending map never
    // belonged to.
    await stream.close();
    await settle();

    service.release(TOOL.name, { ok: true });
    await expect(call).resolves.toMatchObject({ result: { ok: true } });
  });
});
