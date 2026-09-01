/**
 * tunnel/hibernation.test.ts — what survives the hibernation boundary and what does
 * not, observed through `evictDurableObject(stub, { webSockets: "hibernate" })`, which
 * genuinely tears down in-memory instance state while leaving the sockets hibernating
 * rather than closed (strategy §2).
 *
 * WHAT THIS SUITE PINS. §6 splits the DO's state into three tiers, and each tier's
 * survival is a design claim this file makes falsifiable: identity rides
 * serializeAttachment and MUST survive; the cached catalog lives in DO SQLite and MUST
 * survive; the in-flight correlation map lives in memory and MUST NOT — §6 calls that
 * "hibernation-safe" because an unresolved inbound request blocks hibernation, so the
 * map can only vanish while already empty. That last sentence was an unvalidated
 * assumption when the spec was written; this file converts it into a validated one by
 * observing the map empty after the boundary. **No test here asserts the map survives**
 * — upstream's own fixtures prove it does not, and a suite that pinned survival would
 * be pinning a bug. The registration deadline is the fourth tier: a storage alarm,
 * chosen over a timer precisely so it outlives hibernation, so it must still fire. §21
 * adds the FIFTH tier and a second socket class: a subscriber socket's attachment (its
 * stored principal and its subscription set, §21.4/§5), and the doorbell floor's state —
 * per-family last-rang stamps and the pending-ring flag, in DO STORAGE rather than
 * instance memory precisely so a burst that straddles a wake still delivers its trailing
 * ring. Class selection is durable for the same reason: the ring path enumerates sockets
 * by TAG, which the runtime keeps, and never from a list the eviction would take.
 *
 * ALSO PINNED: attachment versioning (§10's code contract). A wake that reads an
 * unknown or absent `v` treats the socket as unintelligible and closes 4004, turning
 * deploy version-skew from silent corruption into a routine reconnect. That branch is
 * only reachable at a hibernation boundary, so it lives here.
 *
 * WHAT IS OUT OF REACH IN-PROCESS (§10, stated so nobody mistakes its absence for an
 * oversight): the abrupt-crash-mid-call branch. evictDurableObject drains in-flight
 * requests before evicting, so a pending entry can never be observed being lost with a
 * consumer still waiting. The nearest honest statement — the map is empty afterwards —
 * is case 6 below; the real thing belongs to §10's manual hibernation/keepalive soak.
 *
 * Durable vs incidental (§7): which TIER a piece of state lives in is durable and
 * pinned; how the DO spells its SQLite tables, and how many round-trips a wake costs,
 * are incidental and unasserted. Every observation is behavioral — made through
 * forward/listTools/status/the socket — except the pending map, which has no behavior
 * to expose and is read through runInDurableObject with that exception named.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): the eviction
 * helper, live sockets and a DO alarm, none of which per-file isolation covers.
 *
 * Isolation and ordering, load-bearing: this file has no subject at all unless
 * smoke.test.ts's A2 is green — if an attachment does not survive eviction,
 * ConnectionAttachment needs a durable-storage fallback and these cases get rewritten
 * around it. protocol.test.ts owns the handshake, so cases here start from an already
 * registered socket except where the deadline is the subject. Under --no-isolate every
 * case mints its own service id: a stale hibernated socket answering the wrong case is
 * the flake this whole directory is arranged to avoid.
 */

// deps: harness/seed · harness/fake-service (connectFakeService, openSubscriber) · harness/tunnel-do (connectionStub, backendCtx) · cloudflare:test (evictDurableObject, runInDurableObject, runDurableObjectAlarm) · src/tunnel (tunnelBackend, status, sever, subscribe, ServiceConnection) · src/capabilities (BELL_TOOLS, RESOURCES_UPDATED) · src/errors (CODES) · src/limits (REGISTRATION_DEADLINE_MS, CALL_TIMEOUT_MS)

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CODES } from "../../src/errors";
import type { Tool } from "../../src/gateway";
import { tokenPattern } from "../../src/principal";
import { Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { BELL_TOOLS, RESOURCES_UPDATED } from "../../src/capabilities";
import {
  CLOSE_PROTOCOL,
  CLOSE_REVOKED,
  sever,
  status,
  subscribe,
  tunnelBackend,
  wipe,
} from "../../src/tunnel";
import type { ServiceConnection } from "../../src/tunnel";
import { connectFakeService, openSubscriber, tick, waitFor } from "../harness/fake-service";
import type { FakeService, FakeServiceOptions, FakeSubscriber } from "../harness/fake-service";
import { seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { backendCtx, connectionStub, stillOpen } from "../harness/tunnel-do";

/**
 * What a forward answers on the far side of the boundary, in the vocabulary the SEAM
 * really exposes: the backend either relays the service's response or throws the one
 * -32000 every dispatch failure collapses into. The offline/timeout distinction is not a
 * column here because this file cannot observe it — it survives in the audit row's
 * detail, and reading it off the fake service's counter instead would make the row pass
 * on the helper's guess rather than on the DO's answer.
 */
export type PostEvictionForward = "ok" | typeof CODES.unavailable;

/**
 * The four tiers of DO state, named as §6 divides them, plus the alarm — and
 * `credential_material`, the one member that is not a tier but a bound on what the
 * surviving tiers may CONTAIN (§3: the DO "never validates tokens itself — it trusts the
 * Worker", so it has no reason to hold credential material at all).
 */
export type EvictedState =
  | "socket_liveness"
  | "attachment_identity"
  | "registered_flag"
  | "catalog_sqlite"
  | "credential_material"
  | "pending_map"
  | "registration_alarm";

/**
 * One row of the survival table.
 *
 * `survives` is the design claim; `observedBy` is how it is made falsifiable from
 * OUTSIDE the object wherever that is possible — a round-trip through the hibernated
 * socket, a forward result, a catalog read, a status read, or the close the alarm
 * produces. `instance_probe` is the documented exception, and the two rows that use it are
 * the two claims with no behavior to expose: an empty pending map, and the ABSENCE of
 * credential material at rest. A row using it must have `survives: false` — a probe that
 * asserted survival would be pinning an implementation detail rather than a contract.
 */
export type EvictionSurvivalRow = {
  /** Test title, in the doc's convention: "§6 · <what this row pins>". */
  name: string;
  state: EvictedState;
  survives: boolean;
  observedBy:
    | "socket_round_trip"
    | "forward_result"
    | "list_tools"
    | "status"
    | "alarm_close"
    | "instance_probe";
  /** For `forward_result` rows: what forward() answers after the boundary. */
  forward?: PostEvictionForward;
};

/**
 * The survival table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. The must-not-survive
 * rows sit beside the must-survive ones by construction: they are the same eviction,
 * read through different state (§9 rule 2).
 */
export const evictionSurvivalRows: readonly EvictionSurvivalRow[] = [
  // One row per member of `EvictedState`, and that totality is the point: §6 divides the
  // DO's state into tiers and claims a survival answer for each, so a tier with no row
  // would be a claim nobody checked. Every row is the SAME boundary —
  // `evictDurableObject(stub, { webSockets: "hibernate" })` on a registered socket — read
  // through different state, which is how the must-not-survive row sits beside the
  // must-survive ones without a second scenario (§9 rule 2).

  // §6's premise, and the protocol-level twin of smoke.test.ts's A2: the socket hibernated
  // rather than closed, so it still carries frames.
  {
    name: "§6 · the socket itself survives: a hibernated socket still round-trips a frame after eviction",
    state: "socket_liveness",
    survives: true,
    observedBy: "socket_round_trip",
  },
  // §6 puts serviceId, ownerId, slug and tokenId in the attachment precisely so a wake can
  // resolve them without an instance field. Observed through a forward, because identity is
  // what stamps `hub/principal` / `hub/roles` onto the frame the service receives — an
  // attachment that came back empty would answer offline, not "ok".
  {
    name: "§6 · identity rides serializeAttachment: a forward after eviction resolves and answers ok",
    state: "attachment_identity",
    survives: true,
    observedBy: "forward_result",
    forward: "ok",
  },
  // The one attachment field with its own observable: `registered` decides status(), which
  // the approval gate consults FIRST (§7). If it were an instance field, every hibernation
  // would silently turn an online service into an availability-first -32000.
  {
    name: "§6 · the registered flag survives: status() still reads online after eviction, so availability-first refusals stay correct across a hibernation",
    state: "registered_flag",
    survives: true,
    observedBy: "status",
  },
  // §6/§7: the catalog lives in DO SQLite "so it survives disconnects and deploys". Read
  // through listTools, never through storage, so the row pins the tier and not the schema.
  {
    name: "§6 · the cached catalog survives in DO SQLite: tools/list still serves it after eviction",
    state: "catalog_sqlite",
    survives: true,
    observedBy: "list_tools",
  },
  // The bound on the two rows above: identity survives the boundary, and this is what
  // identity may CONTAIN. ConnectionAttachment carries `tokenId` — an id, never the secret —
  // and §3 gives the DO no reason to hold credential material at all ("it never validates
  // tokens itself for consumer traffic — it trusts the Worker"), while §15 keeps
  // `Authorization` values and anything matching `pmcp_(sa|svc)_…` out of every persisted
  // surface. Nothing else in the repository can observe this: worker/hygiene.test.ts sweeps
  // persisted D1 rows and never reads DO storage or an attachment, and the worker project
  // cannot reach a DO holding a live socket. Without this row, an implementation that
  // stashed the raw bearer in the attachment or in DO SQLite — the convenient shortcut for
  // re-validating on wake — passes every other row here, every row of lifecycle's sever
  // table, and every case in protocol.test.ts, leaving a credential at rest in the one store
  // nothing audits.
  {
    name: "§3/§15 · no credential material survives the boundary: after eviction the attachment and DO storage carry the token ID and nothing matching a pmcp_ secret or an Authorization value",
    state: "credential_material",
    survives: false,
    observedBy: "instance_probe",
  },
  // §6's hibernation-safety assumption, converted from claimed to validated: "an unresolved
  // incoming request blocks hibernation, so the map can only be lost when it is already
  // empty". The DOCUMENTED exception to observing from outside — an empty map has no
  // behavior to expose — and the one row this file allows to probe the instance, which is
  // why it must be a `survives: false` row. Nothing here asserts the map survives; upstream
  // proves it does not, and a suite pinning survival would be pinning a bug.
  {
    name: "§6 · the in-flight correlation map does NOT survive: it reads empty after eviction, which is the assumption §6 rests on",
    state: "pending_map",
    survives: false,
    observedBy: "instance_probe",
  },
  // §6 chose a storage alarm over a timer for exactly this: an unregistered socket has no
  // pending request to keep the DO awake, so the deadline has to outlive hibernation. The
  // close it produces is the observation — the only row here that starts from an
  // accepted-but-unregistered socket rather than a registered one.
  {
    name: "§6 · the registration deadline alarm survives: an unregistered socket evicted and then woken by the alarm is closed 4004",
    state: "registration_alarm",
    survives: true,
    observedBy: "alarm_close",
  },
];

/**
 * Runs one survival row: brings a registered socket up, evicts the DO with sockets
 * hibernating, and makes exactly the observation the row names. The eviction is the
 * only boundary in the test — nothing is closed, nothing sleeps, and the socket is the
 * same one throughout, so a failure means the tier claim is wrong rather than the
 * setup.
 */
export async function runEvictionSurvivalCase(row: EvictionSurvivalRow): Promise<void> {
  // deps: harness/fake-service · cloudflare:test evictDurableObject · src/tunnel.tunnelBackend · src/tunnel.status
  // A probe may only ever assert that something did NOT survive: a probe claiming survival
  // would be pinning an implementation detail rather than a contract (the type's rule,
  // stated here as the runner's first act).
  if (row.observedBy === "instance_probe") expect(row.survives).toBe(false);

  const fixture = await seedFixture();
  // Every row but the alarm's starts from the same registered socket — one boundary, read
  // through different state.
  const registered = row.state !== "registration_alarm";
  const service = await connect(fixture, registered ? {} : { skipRegister: true });
  if (registered) {
    expect(await service.registered).toEqual({ ok: true });
    expect(await waitFor(() => service.lists.length > 0), "the catalog never warmed").toBe(true);
  }

  await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });

  switch (row.observedBy) {
    case "socket_round_trip": {
      // A frame each way through the hibernated socket: the notification in, the re-list out.
      const listed = service.lists.length;
      await service.notifyToolsListChanged([CACHED_TOOL]);
      expect(await waitFor(() => service.lists.length > listed)).toBe(row.survives);
      return;
    }
    case "forward_result":
      expect(await forwardOnce(fixture)).toBe(row.forward);
      return;
    case "status":
      expect(await status(fixture.serviceId)).toBe(row.survives ? "online" : "offline");
      return;
    case "list_tools":
      expect((await tunnelBackend.listTools(await serviceRow(fixture), backendCtx())).length > 0).toBe(
        row.survives,
      );
      return;
    case "alarm_close":
      expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(row.survives);
      expect((await service.closed).code).toBe(CLOSE_PROTOCOL);
      return;
    case "instance_probe":
      if (row.state === "pending_map") {
        expect(await pendingSize(fixture.serviceId)).toBe(0);
        return;
      }
      await expectNoCredentialMaterial(fixture);
      return;
  }
}

/**
 * Everything this DO holds at rest, as one string: the socket's attachment plus every
 * durable value. The sweep behind the credential-material row — nothing else in the
 * repository can look here (hygiene.test.ts sweeps D1 and never a DO).
 */
async function expectNoCredentialMaterial(fixture: Fixture): Promise<void> {
  const atRest = await runInDurableObject(
    connectionStub(fixture.serviceId),
    async (_instance: ServiceConnection, state) => ({
      attachment: state.getWebSockets()[0].deserializeAttachment(),
      storage: [...(await state.storage.list()).entries()],
    }),
  );
  const serialized = JSON.stringify(atRest);
  // The control: the sweep is looking at the right bytes, because the token's ID is there.
  expect(serialized).toContain(fixture.tokenId);
  // And the secret is not — nor anything else shaped like one (§15's grammar, imported
  // rather than respelled), nor an Authorization value.
  expect(serialized).not.toContain(fixture.token);
  expect(serialized).not.toMatch(tokenPattern(16));
  expect(serialized.toLowerCase()).not.toContain("authorization");
  expect(serialized.toLowerCase()).not.toContain("bearer");
}

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

/** One namespace, one tunneled service, two live tokens — the second exists only so
 *  `onlyIfTokenId` has a token to NOT match after the boundary. */
async function seedFixture(): Promise<Fixture> {
  const slug = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("hib"),
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

async function connect(
  fixture: Fixture,
  options: Partial<FakeServiceOptions> = {},
): Promise<FakeService> {
  const service = await connectFakeService({
    origin: fixture.origin,
    token: fixture.token,
    tools: [CACHED_TOOL],
    ...options,
  });
  opened.push(service);
  return service;
}

/** A registered socket with a warm catalog, then the boundary — the setup of nearly every
 *  case below, so no case spells it twice. */
async function evicted(fixture: Fixture): Promise<FakeService> {
  const service = await connect(fixture);
  expect(await service.registered).toEqual({ ok: true });
  expect(await waitFor(() => service.lists.length > 0), "the catalog never warmed").toBe(true);
  await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });
  return service;
}

/**
 * One subscriber socket, opened through the DO's own fetch door exactly as the Worker
 * opens it (§21.2) — and that is load-bearing HERE above everywhere else: a socket
 * fabricated inside runInDurableObject silently vanishes at evictDurableObject, which
 * would make every row below pass by observing nothing.
 */
async function openStream(
  fixture: Fixture,
  options: { principal?: string } = {},
): Promise<FakeSubscriber> {
  const stream = await openSubscriber(connectionStub(fixture.serviceId), {
    principal: options.principal ?? STREAM_PRINCIPAL,
  });
  streams.push(stream);
  return stream;
}

/** A registered socket serving an EMPTY tool catalog, its warm landed — the start of the
 *  §21 rows, whose subject is a change made AFTER the wake: a non-empty first registration
 *  is itself a change and would put the provocation inside the floor's window (§21.3). */
async function quietlyRegistered(fixture: Fixture): Promise<FakeService> {
  const service = await connect(fixture, { tools: [] });
  expect(await service.registered).toEqual({ ok: true });
  expect(await waitFor(() => service.lists.length > 0), "the catalog never warmed").toBe(true);
  await settle();
  return service;
}

/** One catalog change that has LANDED — the notification sent, the re-list answered, the
 *  write done. A burst is a sequence of these: the fake service installs its catalog before
 *  it sends the frame, so un-awaited notifications collapse into one change. */
async function landedChange(service: FakeService, tools: Tool[]): Promise<void> {
  const listed = service.lists.length;
  await service.notifyToolsListChanged(tools);
  expect(await waitFor(() => service.lists.length > listed), "the re-list never arrived").toBe(true);
  await settle();
}

/** A few turns of the loop — long enough for a DO write and the frame it produced. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await tick();
}

/** The principal a held stream carries — opaque to the DO, which never resolves it. */
const STREAM_PRINCIPAL = "acct:reader";
const OTHER_PRINCIPAL = "acct:intruder";
const SUBSCRIBED_URI = "file:///notes.md";

/** The in-memory correlation map's size — the documented exception to observing from
 *  outside, used only where the claim is that it is EMPTY. */
function pendingSize(serviceId: string): Promise<number> {
  return runInDurableObject(
    connectionStub(serviceId),
    (instance: ServiceConnection) =>
      (instance as unknown as { pending: Map<string, unknown> }).pending.size,
  );
}

/**
 * One forwarded call through the ordinary backend seam, answered in exactly what that
 * seam exposes: "ok" for a relayed response, or the refusal code it threw. Nothing is
 * inferred — a helper that reconstructed offline-vs-timeout from the fake service's
 * counter would be answering with its own guess in the DO's vocabulary.
 */
async function forwardOnce(fixture: Fixture): Promise<PostEvictionForward> {
  try {
    await tunnelBackend.call(
      await serviceRow(fixture),
      { jsonrpc: "2.0", id: CONSUMER_ID, method: "tools/call", params: { name: CACHED_TOOL.name } },
      backendCtx(),
    );
    return "ok";
  } catch (err) {
    return (err as { code: number }).code as typeof CODES.unavailable;
  }
}

/** The consumer's own JSON-RPC id, which §6 forbids from ever crossing the socket. */
const CONSUMER_ID = 4242;

async function serviceRow(fixture: Fixture): Promise<Service> {
  const row = await new Registry(env.DB).getService(fixture.ownerId, fixture.slug);
  if (row === null) throw new Error("the fixture's service vanished");
  return row;
}

const CACHED_TOOL: Tool = {
  name: "search",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

describe("§6 across an evictDurableObject boundary", () => {
  for (const row of evictionSurvivalRows) {
    it(row.name, () => runEvictionSurvivalCase(row));
  }

  it("2. §6 · a registered socket still round-trips a tools/call after eviction — this file's premise, and the protocol-level twin of smoke.test.ts's A2", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    expect(await forwardOnce(fixture)).toBe("ok");
    expect(service.callCount(CACHED_TOOL.name)).toBe(1);
  });

  it("3. §6 · identity survives: the frame forwarded after eviction still carries the hub's own hub/principal and hub/roles, resolved from the attachment", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    expect(await forwardOnce(fixture)).toBe("ok");
    expect(service.invocations[0].meta).toMatchObject({
      "hub/principal": "user:fixture-owner",
      "hub/roles": ["all"],
    });
  });

  it("4. §6 · status() reads online after eviction — `registered` rides the attachment, not an instance field, so availability-first refusals stay correct across a hibernation", async () => {
    const fixture = await seedFixture();
    await evicted(fixture);
    expect(await status(fixture.serviceId)).toBe("online");
  });

  it("5. §6 · the cached catalog is served after eviction, and after eviction *while offline* too (DO SQLite, not memory)", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    const row = await serviceRow(fixture);
    expect(await tunnelBackend.listTools(row, backendCtx())).toEqual([CACHED_TOOL]);
    await service.close();
    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });
    expect(await status(fixture.serviceId)).toBe("offline");
    expect(await tunnelBackend.listTools(row, backendCtx())).toEqual([CACHED_TOOL]);
  });

  it("6. §6 · the pending map is EMPTY after eviction — §6's hibernation-safety assumption, validated rather than assumed; nothing here asserts it survives", async () => {
    const fixture = await seedFixture();
    await evicted(fixture);
    expect(await pendingSize(fixture.serviceId)).toBe(0);
  });

  it("7. §6 · a forward issued after eviction correlates on a fresh wire id and resolves normally: the empty map costs the next caller nothing (the allow-twin of case 6)", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    expect(await forwardOnce(fixture)).toBe("ok");
    const wireId = service.invocations[0].wireId;
    expect(wireId).not.toBe(String(CONSUMER_ID));
    expect(wireId.length).toBeGreaterThan(8);
    // And the entry is gone again once it resolved: a settled call leaves nothing behind.
    expect(await pendingSize(fixture.serviceId)).toBe(0);
  });
});

describe("§6 the deadline alarm across hibernation", () => {
  it("8. §6 · an accepted-but-unregistered socket evicted, then runDurableObjectAlarm → close 4004: the deadline is a storage alarm precisely so it outlives hibernation", async () => {
    const fixture = await seedFixture();
    const service = await connect(fixture, { skipRegister: true });
    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });
    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    expect((await service.closed).code).toBe(CLOSE_PROTOCOL);
  });

  it("9. §6 · a registered socket evicted, then the same alarm → a no-op, socket still open and still online (the allow-twin of case 8)", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    expect(await stillOpen(service)).toBe(true);
    expect(await status(fixture.serviceId)).toBe("online");
  });
});

describe("§6/§10 attachment versioning", () => {
  it("10. §6 · a wake reading an attachment with an unknown or absent `v` closes 4004, so deploy version-skew heals as a routine reconnect", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    // A socket left behind by code that wrote a shape this build cannot read.
    await runInDurableObject(connectionStub(fixture.serviceId), (_i: ServiceConnection, state) =>
      state.getWebSockets()[0].serializeAttachment({ v: 99, serviceId: fixture.serviceId }),
    );
    await service.notifyToolsListChanged([CACHED_TOOL]);
    expect((await service.closed).code).toBe(CLOSE_PROTOCOL);
    expect(await status(fixture.serviceId)).toBe("offline");
  });

  it("11. §6 · a wake reading the current `v: 1` attachment proceeds normally — the allow-twin of case 10, and what keeps case 10 from being satisfied by closing every woken socket", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    const listed = service.lists.length;
    await service.notifyToolsListChanged([CACHED_TOOL]);
    expect(await waitFor(() => service.lists.length > listed)).toBe(true);
    expect(await status(fixture.serviceId)).toBe("online");
  });
});

describe("§6 owner actions across the boundary", () => {
  it("12. §6 · sever() after eviction closes with the right code and still honors onlyIfTokenId — the opening token id rides the attachment", async () => {
    const fixture = await seedFixture();
    const service = await evicted(fixture);
    // The other token: no match, no close — the survivor half of §8's rule, after a wake.
    await sever(fixture.serviceId, CLOSE_REVOKED, fixture.otherTokenId);
    expect(await stillOpen(service)).toBe(true);
    // The opening token: closed, with the code the caller asked for.
    await sever(fixture.serviceId, CLOSE_REVOKED, fixture.tokenId);
    expect((await service.closed).code).toBe(CLOSE_REVOKED);
  });

  it("13. §6 · wipe() after eviction still returns the DO to never-connected (the catalog it erases is the one case 5 proved survived)", async () => {
    const fixture = await seedFixture();
    await evicted(fixture);
    expect(await connectionStub(fixture.serviceId).listTools()).toEqual([CACHED_TOOL]);
    await wipe(fixture.serviceId);
    expect(await connectionStub(fixture.serviceId).listTools()).toEqual([]);
  });
});

describe("§21 the subscriber socket across the boundary", () => {
  it('§21.4/§5 · the subscription set survives evictDurableObject({webSockets:"hibernate"}) — an updated for a subscribed URI still routes after the wake', async () => {
    const fixture = await seedFixture();
    const service = await quietlyRegistered(fixture);
    const stream = await openStream(fixture);
    expect(await subscribe(fixture.serviceId, stream.sessionId, STREAM_PRINCIPAL, SUBSCRIBED_URI)).toBe(
      "stored",
    );

    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });

    await service.notifyResourcesUpdated(SUBSCRIBED_URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });

  it("§21.4 · the stored principal survives the same eviction — a post-wake subscribe from another principal still mutates nothing", async () => {
    const fixture = await seedFixture();
    const service = await quietlyRegistered(fixture);
    const stream = await openStream(fixture);

    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });

    // The id selects and the principal authorizes — and the principal is on the socket, so
    // an instance that lost it would either refuse everything or accept anybody.
    expect(
      await subscribe(fixture.serviceId, stream.sessionId, OTHER_PRINCIPAL, SUBSCRIBED_URI),
    ).toBe("no_stream");
    await service.notifyResourcesUpdated(SUBSCRIBED_URI);
    await settle();
    expect(stream.count(RESOURCES_UPDATED)).toBe(0);

    // …and the socket's own principal still owns it after the wake (the allow-twin).
    expect(
      await subscribe(fixture.serviceId, stream.sessionId, STREAM_PRINCIPAL, SUBSCRIBED_URI),
    ).toBe("stored");
    await service.notifyResourcesUpdated(SUBSCRIBED_URI);
    expect(await waitFor(() => stream.count(RESOURCES_UPDATED) > 0)).toBe(true);
  });

  it("§21.2 · class selection survives the wake — status still reads by the service socket alone, and a post-wake bell still reaches the subscriber socket (the ring path enumerates by tag, not memory)", async () => {
    const fixture = await seedFixture();
    // The subscriber socket is accepted FIRST, so an instance that woke reading position
    // instead of class answers every question below with the wrong socket.
    const stream = await openStream(fixture);
    const service = await quietlyRegistered(fixture);

    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });

    expect(await status(fixture.serviceId)).toBe("online");
    await landedChange(service, [CACHED_TOOL]);
    expect(await waitFor(() => stream.count(BELL_TOOLS) > 0)).toBe(true);
    expect(stream.open).toBe(true);
  });

  it("§21.3 · a pending coalesced ring survives eviction — evict with the ring pending, runDurableObjectAlarm, the frame lands (floor state is durable, constraint 5)", async () => {
    const fixture = await seedFixture();
    const service = await quietlyRegistered(fixture);
    const stream = await openStream(fixture);

    // Two changes inside one interval: the first rings, the second is suppressed and owed.
    await landedChange(service, [CACHED_TOOL]);
    await landedChange(service, [{ name: "other", inputSchema: { type: "object" } }]);
    expect(await waitFor(() => stream.count(BELL_TOOLS) === 1)).toBe(true);

    await evictDurableObject(connectionStub(fixture.serviceId), { webSockets: "hibernate" });

    expect(await runDurableObjectAlarm(connectionStub(fixture.serviceId))).toBe(true);
    expect(await waitFor(() => stream.count(BELL_TOOLS) === 2)).toBe(true);
  });
});
