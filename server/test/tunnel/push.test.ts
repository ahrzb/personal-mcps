/**
 * tunnel/push.test.ts — §21's two new facts about the service DO: it holds a SECOND CLASS
 * of socket, and it rings a doorbell at the write.
 *
 * WHAT THIS SUITE PINS. First, the class invariant (§21.2). Every reader inside the DO
 * selects the service socket by TAG, never by position — and this file is where that stops
 * being a claim: each case here accepts a subscriber socket FIRST, so an implementation
 * that still reads `getWebSockets()[0]` answers "offline" for an online service, forwards a
 * consumer's call into a consumer's own stream, and evicts a stream with `hub/replaced`.
 * The eviction, sever, delete, archive and deadline rows are all the same claim asked of a
 * different path, because §6 has five of them.
 *
 * Second, the doorbell (§21.3). The bell rings when the HUB'S STORED CATALOG changes, not
 * when the service says something changed: absent and `[]` compare equal, a re-warm that
 * draws the same list rings nothing however loudly `list_changed` arrived, a failed warm
 * rings nothing because it wrote nothing, and the undeclare that emptied a served family
 * rings because it did write. The floor is a leading edge: the first change in a quiet
 * window is immediate, a burst inside `LISTEN_BELL_MIN_INTERVAL_MS` collapses to one
 * trailing frame, and the final state always rings.
 *
 * SUITE DISCIPLINE, and it is load-bearing twice over:
 *
 * - Every "rings nothing" row concludes only after the coalescing alarm has been FIRED
 *   (`runDurableObjectAlarm`). "Never rang" and "was suppressed and is still pending" are
 *   otherwise the same observation, and an implementation that coalesced everything
 *   forever would pass a suite that skipped the drain.
 * - Subscriber sockets are opened through the DO's own fetch door (`stub.fetch(upgrade)`,
 *   peer accepted test-side), exactly as the Worker opens them — never fabricated inside
 *   `runInDurableObject`, because such a socket silently vanishes at `evictDurableObject`
 *   and would make hibernation.test.ts's new rows vacuous.
 * - Fixtures register with EMPTY catalogs wherever the subject is a later change: a first
 *   registration warming a non-empty catalog is itself a change and rings, which would put
 *   every subsequent provocation inside the floor's window and make the rows read the
 *   coalescer instead of the thing they are about. The rows that ARE about the first
 *   registration say so.
 *
 * Durable vs incidental (§7): the frames, their count, and which sockets they reach are
 * durable and pinned. The DO's storage keys for the floor, the order two subscriber
 * sockets are written in, and how many event-loop turns a ring takes are incidental and
 * unasserted — every wait here is `waitFor`, never a duration.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): live sockets, a DO
 * alarm, and a real D1 ledger, none of which per-file isolation covers. Under
 * `--no-isolate` every case mints its own namespace and service, so a stale socket from
 * another case can never answer here.
 *
 * Isolation and ordering: protocol.test.ts owns the handshake and lifecycle.test.ts owns
 * the sever table; both green first. This file starts from a registered socket except
 * where the deadline or the first registration is the subject.
 */

// deps: harness/seed · harness/fake-service (connectFakeService, openSubscriber, tick, waitFor) · harness/tunnel-do (backendCtx, connectionStub, stillOpen, untilStatus) · cloudflare:test (env, runDurableObjectAlarm, runInDurableObject) · src/tunnel (tunnelBackend, sever, status, wipe, close codes) · src/capabilities (BELL_*, subscriberTag) · src/audit (query) · src/limits (LISTEN_BELL_MIN_INTERVAL_MS) · src/registry (Registry)

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { query } from "../../src/audit";
import { BELL_PROMPTS, BELL_RESOURCES, BELL_TOOLS, subscriberTag } from "../../src/capabilities";
import type { Tool } from "../../src/gateway";
import { LISTEN_BELL_MIN_INTERVAL_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import {
  CLOSE_ARCHIVED,
  CLOSE_PROTOCOL,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  sever,
  status,
  tunnelBackend,
  wipe,
} from "../../src/tunnel";
import type { ServiceConnection } from "../../src/tunnel";
import { connectFakeService, openSubscriber, tick, waitFor } from "../harness/fake-service";
import type {
  CatalogEntry,
  FakeService,
  FakeServiceOptions,
  FakeSubscriber,
} from "../harness/fake-service";
import { seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { backendCtx, connectionStub, stillOpen, untilStatus } from "../harness/tunnel-do";

// ── the fixture and the plumbing every case here shares ───────────────────────────────

type Fixture = {
  origin: string;
  ownerId: string;
  slug: string;
  serviceId: string;
  token: string;
  tokenId: string;
  otherTokenId: string;
};

const seeded: SeededNamespace[] = [];
const opened: FakeService[] = [];
const streams: FakeSubscriber[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
  for (const service of opened.splice(0)) await service.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/** One namespace with one tunneled service and two live tokens — the second exists only so
 *  `onlyIfTokenId`'s survivor half has a token to NOT match. */
async function seedFixture(): Promise<Fixture> {
  const slug = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("push"),
    services: [{ slug, kind: "tunnel", tokens: [{ as: "token_a" }, { as: "token_b" }] }],
  });
  seeded.push(namespace);
  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    slug,
    serviceId: namespace.services[slug].id,
    token: namespace.tokens.token_a.token,
    tokenId: namespace.tokens.token_a.id,
    otherTokenId: namespace.tokens.token_b.id,
  };
}

/** Two tunneled services in ONE namespace — the cross-service burst §21.7 records as
 *  uncoalesced needs two DOs, and nothing else here does. */
async function seedPair(): Promise<[Fixture, Fixture]> {
  const first = uniqueSlug("bot");
  const second = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("push"),
    services: [
      { slug: first, kind: "tunnel", tokens: [{ as: "first" }] },
      { slug: second, kind: "tunnel", tokens: [{ as: "second" }] },
    ],
  });
  seeded.push(namespace);
  const origin = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;
  const of = (slug: string, as: string): Fixture => ({
    origin,
    ownerId: namespace.owner.userId,
    slug,
    serviceId: namespace.services[slug].id,
    token: namespace.tokens[as].token,
    tokenId: namespace.tokens[as].id,
    otherTokenId: namespace.tokens[as].id,
  });
  return [of(first, "first"), of(second, "second")];
}

/** A socket on the wire, registered unless the options say otherwise. */
async function connect(
  fixture: Fixture,
  options: Partial<FakeServiceOptions> = {},
): Promise<FakeService> {
  const service = await connectFakeService({
    origin: fixture.origin,
    token: fixture.token,
    tools: [],
    ...options,
  });
  opened.push(service);
  return service;
}

/**
 * A registered socket whose registration warm has fully LANDED — every declared family's
 * list answered and written. Cases open their subscriber sockets after this, so a
 * registration's own bells (which no consumer was there to hear) can never be counted as
 * the provocation's.
 */
async function warmed(
  fixture: Fixture,
  options: Partial<FakeServiceOptions> = {},
): Promise<FakeService> {
  const service = await connect(fixture, options);
  expect(await service.registered).toEqual({ ok: true });
  const warms = expectedWarms({ tools: [], ...options });
  expect(await waitFor(() => listCount(service) >= warms), "the registration never warmed").toBe(
    true,
  );
  // The lists have been ANSWERED; the DO still has to write them and decide their bells.
  await settle();
  return service;
}

/**
 * How many hub-originated lists one registration draws — the declared families, with the
 * `resources` declaration counting twice because it speaks for the templates key too
 * (§20.5). Spelled here rather than imported: this is the suite's expectation of what a
 * registration does, and importing the hub's own table would make it agree by construction.
 */
function expectedWarms(options: Partial<FakeServiceOptions>): number {
  const declared =
    options.capabilities ??
    [
      "tools",
      ...(options.prompts === undefined ? [] : ["prompts"]),
      ...(options.resources === undefined && options.resourceTemplates === undefined
        ? []
        : ["resources"]),
    ];
  let warms = 0;
  if (declared.includes("tools")) warms += 1;
  if (declared.includes("prompts")) warms += 1;
  if (declared.includes("resources")) warms += 2;
  return warms;
}

/** Every hub-originated list this socket has received — the four §20.5 methods share the
 *  `/list` tail, and nothing else the hub sends does. */
function listCount(service: FakeService): number {
  return service.frames.filter(
    (frame) => typeof frame.method === "string" && frame.method.endsWith("/list"),
  ).length;
}

/**
 * One catalog change that has LANDED: the notification sent, the hub's re-list answered,
 * and the write behind it done. A burst is a sequence of these and never a sequence of
 * un-awaited notifications — the fake service installs its new catalog before it sends the
 * frame, so N frames in flight are ONE change (the hub's first re-list draws the last
 * catalog and the rest are no-ops), which is the difference between measuring the floor
 * and measuring the harness.
 */
async function changeTools(service: FakeService, tools: Tool[]): Promise<void> {
  const listed = listCount(service);
  await service.notifyToolsListChanged(tools);
  expect(await waitFor(() => listCount(service) > listed), "the re-list never arrived").toBe(true);
  await settle();
}

/** The same, for the prompt catalog. */
async function changePrompts(service: FakeService, prompts: CatalogEntry[]): Promise<void> {
  const listed = listCount(service);
  await service.notifyPromptsListChanged(prompts);
  expect(await waitFor(() => listCount(service) > listed), "the re-list never arrived").toBe(true);
  await settle();
}

/** …and for the resource catalogs, which one frame re-lists BOTH of (§20.5). */
async function changeResources(service: FakeService, resources: CatalogEntry[]): Promise<void> {
  const listed = listCount(service);
  await service.notifyResourcesListChanged(resources);
  expect(await waitFor(() => listCount(service) >= listed + 2), "the re-list never arrived").toBe(
    true,
  );
  await settle();
}

/** One subscriber socket, through the DO's own door. */
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
 * Fire the coalescing alarm and let what it wrote arrive. Every "rings nothing" row ends
 * here, and so does every counting row: a suppressed ring and an absent one are the same
 * observation until the alarm has run.
 */
async function drain(fixture: Fixture): Promise<void> {
  await runDurableObjectAlarm(connectionStub(fixture.serviceId));
  await settle();
}

/** A few turns of the loop — long enough for a DO write and the frame it produced. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await tick();
}

/** Still open once everything in flight has been delivered — the observation behind every
 *  "the hub did NOT close this stream" claim. */
async function streamsOpen(...subscribers: FakeSubscriber[]): Promise<boolean> {
  await settle();
  return subscribers.every((stream) => stream.open);
}

/** The DO's sockets, counted by CLASS — what §6's at-most-one invariant is about, now that
 *  the DO holds two kinds. */
async function socketCounts(fixture: Fixture): Promise<{ service: number; subscribers: number }> {
  return runInDurableObject(
    connectionStub(fixture.serviceId),
    (_instance: ServiceConnection, state) => {
      const tags = state.getWebSockets().map((ws) => state.getTags(ws));
      const subscribers = tags.filter((each) => each.some((tag) => tag.startsWith("sub:"))).length;
      return { service: tags.length - subscribers, subscribers };
    },
  );
}

/** Poll until the counts settle at what a case expects, then answer them either way — a
 *  close is delivered on its own turn, so counting immediately after one is a race. */
async function untilSocketCounts(
  fixture: Fixture,
  expected: { service: number; subscribers: number },
): Promise<{ service: number; subscribers: number }> {
  let counts = await socketCounts(fixture);
  for (let turn = 0; turn < 50 && JSON.stringify(counts) !== JSON.stringify(expected); turn++) {
    await tick();
    counts = await socketCounts(fixture);
  }
  return counts;
}

/** The DO's scheduled alarm, or null — read for the twin that says a subscriber accept arms
 *  none and re-arms none. */
async function scheduledAlarm(fixture: Fixture): Promise<number | null> {
  return runInDurableObject(connectionStub(fixture.serviceId), (_i: ServiceConnection, state) =>
    state.storage.getAlarm(),
  );
}

/** How many rows this namespace's ledger holds, whatever they are — §21.6's negative is
 *  about the whole ledger, not about one event name. */
async function auditTotal(fixture: Fixture): Promise<number> {
  return (await query(env.DB, fixture.ownerId, {})).total;
}

async function serviceRow(fixture: Fixture): Promise<Service> {
  const row = await new Registry(env.DB).getService(fixture.ownerId, fixture.slug);
  if (row === null) throw new Error("the fixture's service vanished");
  return row;
}

/** The principal a stream carries — an opaque string to the DO, which never resolves it. */
const PRINCIPAL = "acct:reader";

/** The consumer's own JSON-RPC id, which §6 forbids from ever crossing the socket. */
const CONSUMER_ID = 4242;

const TOOL: Tool = {
  name: "search",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

function toolNamed(name: string): Tool {
  return { name, inputSchema: { type: "object" } };
}

const PROMPT: CatalogEntry = { name: "greet", description: "says hello" };
const RESOURCE: CatalogEntry = { uri: "file:///notes.md", name: "notes" };
const TEMPLATE: CatalogEntry = { uriTemplate: "file:///{path}", name: "any file" };

// ── §21.2 the subscriber class ────────────────────────────────────────────────────────

describe("§21.2 subscriber sockets are a class of their own", () => {
  it('§21.2 · a subscriber socket is accepted through the DO\'s fetch door tagged "sub:<session-id>" — the one structural pin; everything else it carries is observed through routing below', async () => {
    const fixture = await seedFixture();
    const stream = await subscriber(fixture);

    const tags = await runInDurableObject(
      connectionStub(fixture.serviceId),
      (_instance: ServiceConnection, state) => state.getWebSockets().map((ws) => state.getTags(ws)),
    );
    // Spelled, not derived: the prefix IS the class separator, so a rename must fail here.
    expect(tags).toEqual([[`sub:${stream.sessionId}`]]);
    // …and it is what the hub's own builder makes of that session id.
    expect(tags).toEqual([[subscriberTag(stream.sessionId)]]);
  });

  it("§21.2 · the socket reader selects by CLASS, never by position — with a subscriber socket accepted FIRST and the service socket second: status reads online, a tools/call reaches the service, and with only subscriber sockets held status reads offline", async () => {
    const fixture = await seedFixture();
    const stream = await subscriber(fixture);
    const service = await warmed(fixture, { tools: [TOOL] });

    expect(await status(fixture.serviceId)).toBe("online");
    await tunnelBackend.call(
      await serviceRow(fixture),
      { jsonrpc: "2.0", id: CONSUMER_ID, method: "tools/call", params: { name: TOOL.name } },
      backendCtx(),
    );
    // The call reached the SERVICE, not the stream that was sitting in front of it: the
    // only thing this stream ever heard is the doorbell that first registration rang.
    expect(service.callCount(TOOL.name)).toBe(1);
    expect(stream.frames.map((frame) => frame.method)).toEqual([
      "notifications/tools/list_changed",
    ]);

    await service.close();
    await untilStatus(fixture.serviceId, "offline");
    // A DO holding nothing but streams is offline: a subscriber socket is not a connection.
    expect(await status(fixture.serviceId)).toBe("offline");
    expect(await streamsOpen(stream)).toBe(true);
  });

  it("§21.2/§6 · the DO holds at most one SERVICE socket beside its subscriber sockets — §6's at-most-one-connection invariant counts service sockets only", async () => {
    const fixture = await seedFixture();
    await subscriber(fixture);
    await subscriber(fixture);
    const first = await warmed(fixture);
    const second = await warmed(fixture);

    expect((await first.closed).code).toBe(CLOSE_REPLACED);
    expect(await untilSocketCounts(fixture, { service: 1, subscribers: 2 })).toEqual({
      service: 1,
      subscribers: 2,
    });
    expect(await stillOpen(second)).toBe(true);
  });

  it("§21.2/§6 · a newer service connection evicts the old SERVICE socket with hub/replaced and close 4000, leaving every subscriber socket open", async () => {
    const fixture = await seedFixture();
    const stream = await subscriber(fixture);
    const first = await warmed(fixture);

    await warmed(fixture);

    await first.replaced;
    expect((await first.closed).code).toBe(CLOSE_REPLACED);
    expect(await streamsOpen(stream)).toBe(true);
    expect(stream.frames).toEqual([]);
  });

  it("§21.2/§15 · a targeted token revoke severs the SERVICE socket with 4001 even with a subscriber socket sitting first in the untagged enumeration · a rotation revoke naming another token id leaves service and subscriber sockets alike open (the twin)", async () => {
    const fixture = await seedFixture();
    const stream = await subscriber(fixture);
    const service = await warmed(fixture);

    // The twin first: §8's rotation rule, which a sever() that closed everything it could
    // reach would fail — and which reading the wrong socket would also fail, silently.
    await sever(fixture.serviceId, CLOSE_REVOKED, fixture.otherTokenId);
    expect(await stillOpen(service)).toBe(true);
    expect(await streamsOpen(stream)).toBe(true);

    await sever(fixture.serviceId, CLOSE_REVOKED, fixture.tokenId);
    expect((await service.closed).code).toBe(CLOSE_REVOKED);
    expect(await streamsOpen(stream)).toBe(true);
  });

  it("§21.2/§6 · service delete closes every subscriber socket alongside the service socket and the wiped state · archive severs the service socket alone (4002) and leaves every subscriber socket open — the archived case reaches streams through the re-auth tick (the twin)", async () => {
    const deleted = await seedFixture();
    const doomed = await subscriber(deleted);
    const going = await warmed(deleted, { tools: [TOOL] });

    // admin's delete cascade, in its own order: sever the credentialed socket, then wipe.
    await sever(deleted.serviceId, CLOSE_REVOKED);
    await wipe(deleted.serviceId);
    expect((await going.closed).code).toBe(CLOSE_REVOKED);
    expect((await doomed.closed).code).toBe(CLOSE_REVOKED);
    expect(await connectionStub(deleted.serviceId).listTools()).toEqual([]);

    const archived = await seedFixture();
    const surviving = await subscriber(archived);
    // Empty catalogs: this leg's claim is that the archive rings NOTHING at the stream, so
    // the registration must not ring either (a non-empty first warm is a change, §21.3).
    const parked = await warmed(archived);

    await sever(archived.serviceId, CLOSE_ARCHIVED);
    expect((await parked.closed).code).toBe(CLOSE_ARCHIVED);
    expect(await streamsOpen(surviving)).toBe(true);
    // The archive is not the stream's business: §21.2's re-auth tick is what ends it.
    expect(surviving.frames).toEqual([]);
  });

  it("§21.2/§6 · the registration-deadline alarm closes the unregistered SERVICE socket with 4004 and leaves every subscriber socket open · accepting a subscriber socket neither arms nor re-arms that deadline (the twin)", async () => {
    const fixture = await seedFixture();
    const stream = await subscriber(fixture);
    const late = await connect(fixture, { skipRegister: true });

    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    expect((await late.closed).code).toBe(CLOSE_PROTOCOL);
    expect(await streamsOpen(stream)).toBe(true);

    // The twin, on a DO no service has ever reached: a subscriber accept arms nothing.
    const quiet = await seedFixture();
    const alone = await subscriber(quiet);
    expect(await scheduledAlarm(quiet)).toBe(null);
    expect(await runDurableObjectAlarm(connectionStub(quiet.serviceId))).toBe(false);
    expect(await streamsOpen(alone)).toBe(true);

    // …and re-arms nothing: the deadline a registration left standing is untouched by one.
    await warmed(quiet);
    const armed = await scheduledAlarm(quiet);
    expect(armed).not.toBe(null);
    await subscriber(quiet);
    expect(await scheduledAlarm(quiet)).toBe(armed);
  });
});

// ── §21.3 what rings ──────────────────────────────────────────────────────────────────

describe("§21.3 the bell rings at the write", () => {
  it("§21.3 · a re-warm whose catalog changed rings that family's bell on every subscriber socket the DO holds · a re-warm producing an equal catalog rings nothing however loudly the service sent list_changed — coalescer drained before concluding (the twin)", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const first = await subscriber(fixture);
    const second = await subscriber(fixture);

    await service.notifyToolsListChanged([TOOL]);
    expect(
      await waitFor(() => first.count(BELL_TOOLS) > 0 && second.count(BELL_TOOLS) > 0),
    ).toBe(true);
    await drain(fixture);
    expect(first.count(BELL_TOOLS)).toBe(1);
    expect(second.count(BELL_TOOLS)).toBe(1);

    const quiet = await seedFixture();
    const noisy = await warmed(quiet, { tools: [TOOL] });
    const deaf = await subscriber(quiet);

    // Twice, with the same catalog both times: the service is as loud as it can be.
    await noisy.notifyToolsListChanged([TOOL]);
    await noisy.notifyToolsListChanged([TOOL]);
    expect(await waitFor(() => listCount(noisy) >= 3)).toBe(true);
    await drain(quiet);
    expect(deaf.frames).toEqual([]);
  });

  it("§21.3/§21.5 · a first registration warming a NON-EMPTY catalog rings — absent and non-empty differ, which is what makes the never-connected capability honest · the same first registration warming [] rings nothing, drained (the twin — absent ≡ [])", async () => {
    const fixture = await seedFixture();
    // The stream opens BEFORE the service has ever connected — the never-connected case.
    const stream = await subscriber(fixture);
    await warmed(fixture, { tools: [TOOL] });

    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    await drain(fixture);
    expect(stream.count(BELL_TOOLS)).toBe(1);

    const quiet = await seedFixture();
    const deaf = await subscriber(quiet);
    await warmed(quiet, { tools: [] });
    await drain(quiet);
    expect(deaf.frames).toEqual([]);
  });

  it("§21.3/§20.5 · a successful registration that undeclares a NON-EMPTY family clears it and rings its bell · undeclaring an already-empty family rings nothing, drained (the twin)", async () => {
    const fixture = await seedFixture();
    const served = await warmed(fixture, { prompts: [PROMPT] });
    const stream = await subscriber(fixture);

    await served.close();
    await untilStatus(fixture.serviceId, "offline");
    // The same service, now declaring tools alone: §20.5's clear IS a catalog change.
    await warmed(fixture, { capabilities: ["tools"] });
    await drain(fixture);
    expect(stream.count(BELL_PROMPTS)).toBe(1);
    expect(stream.count(BELL_TOOLS)).toBe(0);
    expect(await connectionStub(fixture.serviceId).listCatalog("prompts")).toEqual([]);

    const quiet = await seedFixture();
    const empty = await warmed(quiet, { prompts: [] });
    const deaf = await subscriber(quiet);
    await empty.close();
    await untilStatus(quiet.serviceId, "offline");
    await warmed(quiet, { capabilities: ["tools"] });
    await drain(quiet);
    expect(deaf.frames).toEqual([]);
  });

  it("§21.3/§20.5 · a warm that fails or times out rings nothing, drained — a failure is not an undeclare", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture, { tools: [TOOL] });
    const stream = await subscriber(fixture);

    // The catalog the service WOULD serve is empty now — so a warm that landed would clear
    // a non-empty family and ring. Neither of these lands.
    service.setListBehavior({ mode: "error", error: { code: -32603, message: "not now" } }, "tools");
    await service.notifyToolsListChanged([]);
    expect(await waitFor(() => listCount(service) >= 2)).toBe(true);
    service.setListBehavior({ mode: "hang" }, "tools");
    await service.notifyToolsListChanged([]);
    expect(await waitFor(() => listCount(service) >= 3)).toBe(true);

    await drain(fixture);
    expect(stream.frames).toEqual([]);
    // …and the cache still holds what neither failure was allowed to empty.
    expect(await connectionStub(fixture.serviceId).listTools()).toEqual([TOOL]);
  });

  it("§21.3/§6 · a warm that changes both resource catalogs rings notifications/resources/list_changed ONCE · one that changes only the templates list still rings it (the twin — MCP defines no templates frame)", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture, { resources: [], resourceTemplates: [] });
    const stream = await subscriber(fixture);

    service.setCatalog("resourceTemplates", [TEMPLATE]);
    await service.notifyResourcesListChanged([RESOURCE]);
    expect(await waitFor(() => stream.count(BELL_RESOURCES) > 0)).toBe(true);
    await drain(fixture);
    expect(stream.count(BELL_RESOURCES)).toBe(1);
    expect(stream.frames).toHaveLength(1);

    const twin = await seedFixture();
    const other = await warmed(twin, { resources: [], resourceTemplates: [] });
    const ear = await subscriber(twin);

    other.setCatalog("resourceTemplates", [TEMPLATE]);
    // Only the templates key moves; the resource list answers exactly what it answered.
    await other.notifyResourcesListChanged();
    expect(await waitFor(() => ear.count(BELL_RESOURCES) > 0)).toBe(true);
    await drain(twin);
    expect(ear.count(BELL_RESOURCES)).toBe(1);
    expect(ear.frames).toHaveLength(1);
  });

  it("§21.3 · the frame on a subscriber socket is the bare method-only notification — no catalog, no entry names, no service id", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    await service.notifyToolsListChanged([TOOL]);
    expect(await waitFor(() => stream.frames.length > 0)).toBe(true);

    expect(stream.frames[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    const wire = JSON.stringify(stream.frames[0]);
    expect(wire).not.toContain(TOOL.name);
    expect(wire).not.toContain(fixture.slug);
    expect(wire).not.toContain(fixture.serviceId);
  });

  it("§21.3/§21.2 · the DO rings every subscriber socket it holds, resources bell included — the shape filter is the Worker's, and the DO knows no shapes", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture, { resources: [] });
    const listeners = [
      await subscriber(fixture),
      await subscriber(fixture),
      await subscriber(fixture),
    ];

    await service.notifyResourcesListChanged([RESOURCE]);
    expect(await waitFor(() => listeners.every((each) => each.count(BELL_RESOURCES) > 0))).toBe(
      true,
    );
    await drain(fixture);
    for (const listener of listeners) expect(listener.count(BELL_RESOURCES)).toBe(1);
  });

  it("§21.6 · a ring writes no audit row — doorbells are listing-class", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);
    const before = await auditTotal(fixture);

    await service.notifyToolsListChanged([TOOL]);
    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    await drain(fixture);

    expect(await auditTotal(fixture)).toBe(before);
  });
});

// ── §21.3 the floor ───────────────────────────────────────────────────────────────────

describe("§21.3 the leading-edge floor", () => {
  it("§21.3 · the first change in a quiet window rings before any alarm runs, and in fewer than LISTEN_BELL_MIN_INTERVAL_MS on the suite's lever — the leading edge is immediate", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    const startedAt = Date.now();
    await service.notifyToolsListChanged([TOOL]);
    // No alarm is fired anywhere in this case: the frame arrives because the edge leads.
    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(LISTEN_BELL_MIN_INTERVAL_MS);
    expect(stream.count(BELL_TOOLS)).toBe(1);
  });

  it("§21.3 · N changes inside one interval deliver the leading frame now and ONE trailing frame when the DO's alarm fires — at most two frames, and the final state always rings", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    // Each change must LAND before the next is announced: the fake service installs its
    // new catalog before it sends the frame, so four un-awaited notifications are one
    // change — the hub's first re-list would draw the last catalog and the rest would be
    // no-ops. A burst is N writes, not N frames.
    const startedAt = Date.now();
    await changeTools(service, [toolNamed("one")]);
    await changeTools(service, [toolNamed("two")]);
    await changeTools(service, [toolNamed("three")]);
    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    expect(
      Date.now() - startedAt,
      "the burst outran the floor's window, so this is no longer one interval",
    ).toBeLessThan(LISTEN_BELL_MIN_INTERVAL_MS);
    // Before the alarm: the leading frame and nothing else, however many changes landed.
    expect(stream.count(BELL_TOOLS)).toBe(1);

    await drain(fixture);
    expect(stream.count(BELL_TOOLS)).toBe(2);
    // And the trailing frame is about the FINAL state, which is what the hub now serves.
    expect(await connectionStub(fixture.serviceId).listTools()).toEqual([toolNamed("three")]);
  });

  it("§21.3 · the floor is per family — a tools burst inside one interval never suppresses that interval's prompts or resources bell", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture, { prompts: [], resources: [] });
    const stream = await subscriber(fixture);

    const startedAt = Date.now();
    await changeTools(service, [toolNamed("one")]);
    await changeTools(service, [toolNamed("two")]);
    await changePrompts(service, [PROMPT]);
    await changeResources(service, [RESOURCE]);
    expect(
      Date.now() - startedAt,
      "the burst outran the floor's window, so this is no longer one interval",
    ).toBeLessThan(LISTEN_BELL_MIN_INTERVAL_MS);

    expect(
      await waitFor(() => stream.count(BELL_PROMPTS) > 0 && stream.count(BELL_RESOURCES) > 0),
    ).toBe(true);
    // Each family's first ring is its OWN leading edge, delivered while tools is suppressed.
    expect(stream.count(BELL_TOOLS)).toBe(1);
    expect(stream.count(BELL_PROMPTS)).toBe(1);
    expect(stream.count(BELL_RESOURCES)).toBe(1);

    await drain(fixture);
    expect(stream.count(BELL_TOOLS)).toBe(2);
    expect(stream.count(BELL_PROMPTS)).toBe(1);
    expect(stream.count(BELL_RESOURCES)).toBe(1);
  });

  it("§21.3/§21.7 · the floor is per service DO — two granted services changing the same family inside one interval deliver two frames, the cross-service burst §21.7 records as uncoalesced", async () => {
    const [first, second] = await seedPair();
    const alpha = await warmed(first);
    const beta = await warmed(second);
    // One stream, two DOs: the Worker opens a socket per service under one session id.
    const sessionId = crypto.randomUUID();
    const onAlpha = await subscriber(first, { sessionId });
    const onBeta = await subscriber(second, { sessionId });

    await alpha.notifyToolsListChanged([TOOL]);
    await beta.notifyToolsListChanged([TOOL]);
    expect(
      await waitFor(() => onAlpha.count(BELL_TOOLS) > 0 && onBeta.count(BELL_TOOLS) > 0),
    ).toBe(true);
    await drain(first);
    await drain(second);

    expect(onAlpha.count(BELL_TOOLS)).toBe(1);
    expect(onBeta.count(BELL_TOOLS)).toBe(1);
  });

  it("§21.3/§6 · the two alarm purposes are multiplexed, never clobbered — a service (re)connect while a ring is pending does not cancel the ring, and an armed registration deadline still closes an unregistered socket while a ring is pending", async () => {
    const fixture = await seedFixture();
    const service = await warmed(fixture);
    const stream = await subscriber(fixture);

    const startedAt = Date.now();
    await changeTools(service, [toolNamed("one")]);
    await changeTools(service, [toolNamed("two")]);
    expect(
      Date.now() - startedAt,
      "the burst outran the floor's window, so this is no longer one interval",
    ).toBeLessThan(LISTEN_BELL_MIN_INTERVAL_MS);
    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    await settle();
    expect(stream.count(BELL_TOOLS)).toBe(1);

    // A newcomer arrives mid-burst: it evicts the service socket and arms the deadline.
    const newcomer = await connect(fixture, { skipRegister: true });
    expect((await service.closed).code).toBe(CLOSE_REPLACED);

    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    await settle();
    // Neither purpose ate the other. The trailing ring landed on the firing the COALESCER
    // armed…
    expect(stream.count(BELL_TOOLS)).toBe(2);
    // …and that firing did not spend the deadline: §6 pins the handshake window at ten
    // seconds, and a ring falling due one second in must not close a socket nine seconds
    // early. The purpose is stored, so it survived the borrowed slot and re-armed itself.
    expect(await stillOpen(newcomer), "the deadline was spent on the ring's alarm").toBe(true);
    // …and it still closes the unregistered socket, on its own firing.
    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    expect((await newcomer.closed).code).toBe(CLOSE_PROTOCOL);
    expect(stream.count(BELL_TOOLS), "the deadline leg rang nothing of its own").toBe(2);
    expect(await streamsOpen(stream)).toBe(true);
  });
});
