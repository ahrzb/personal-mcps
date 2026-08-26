// tunnel-do.ts — the plumbing every suite in `test/tunnel/` needs and none of them owns:
// the DO addressing rule, the two ways of waiting for the hub to settle, the socket
// still-open probe, and the caller context a backend receives. Each of these is ONE
// decision — how a service id becomes a stub, how long a wait may run before it is a
// failed assertion rather than a slow test — and each was spelled in three or four files
// before it lived here.
//
// Separate from fake-service.ts on purpose: this half imports `cloudflare:test`, which is
// the pool's own seam, while the fake service is a plain WebSocket client that must stay
// free of it (its header explains why it imports nothing of the hub's either).
//
// What does NOT belong here: fixture seeding. What a suite seeds — which services, which
// tokens, which grants — is the part that genuinely differs per file, and a shared seeder
// would make every suite's premise unreadable from the suite.
//
// deps: cloudflare:test (env.SERVICE_CONNECTION) · vitest expect · harness/fake-service
// (tick, waitFor, FakeService) · src/tunnel (status, tunnelBackend, ServiceConnection) ·
// src/registry (Registry, Service)

import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { BackendCtx, Tool } from "../../src/gateway";
import { Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { status, tunnelBackend } from "../../src/tunnel";
import type { ServiceConnection } from "../../src/tunnel";
import { tick } from "./fake-service";
import type { FakeService } from "./fake-service";

/**
 * The DO behind a service id, addressed exactly as the hub addresses it — by the opaque
 * `service.id`, never by user or slug (§6: deleting a user and recreating the username can
 * never rebind to a stale DO). The one place that rule is spelled test-side.
 */
export function connectionStub(serviceId: string): ServiceConnection {
  const namespace = env.SERVICE_CONNECTION as DurableObjectNamespaceLike<ServiceConnection>;
  return namespace.get(namespace.idFromName(serviceId));
}

/** How many sockets the DO is holding — the count §6's at-most-one invariant is about,
 *  and what a refused upgrade must leave at zero. */
export function liveSockets(serviceId: string): Promise<number> {
  return runInDurableObject(
    connectionStub(serviceId),
    (_instance: ServiceConnection, state) => state.getWebSockets().length,
  );
}

/**
 * How many turns of the loop a hub round trip is given before "it never happened" is the
 * answer. ONE budget for every still-open and status probe in this directory: the 15-vs-25
 * split these helpers used to carry per file was a flake budget nobody chose, and the two
 * questions cost the same round trips either way.
 */
const SETTLE_TURNS = 25;

/** True when the socket is still open once everything in flight has been delivered — the
 *  observation behind every "the hub did NOT close this" claim. */
export async function stillOpen(service: FakeService): Promise<boolean> {
  let ended = false;
  void service.closed.then(() => {
    ended = true;
  });
  for (let turn = 0; turn < SETTLE_TURNS && !ended; turn++) await tick();
  return !ended;
}

/**
 * Wait until the hub reports `serviceId` at `expected`. Status is a READ, so it is polled
 * rather than slept on, and a status that never arrives fails as an assertion naming both
 * sides instead of as a test timeout with nothing to read.
 */
export async function untilStatus(serviceId: string, expected: "online" | "offline"): Promise<void> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    if ((await status(serviceId)) === expected) return;
    await tick();
  }
  expect(await status(serviceId), `the service never read ${expected}`).toBe(expected);
}

/**
 * Wait until the DO holds a non-empty cached catalog for `service`, and answer it — the
 * state a fixture's first assertion assumes whenever it dialled a socket to get there.
 * Generous, like waitFor's own default, because it is paid in full only when the answer is
 * "the catalog never warmed", which is a failure.
 */
export async function untilCataloged(service: Service): Promise<Tool[]> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    const tools = await tunnelBackend.listTools(service, backendCtx());
    if (tools.length > 0) return tools;
    await tick();
  }
  throw new Error(`the catalog for "${service.slug}" never warmed`);
}

/** The budget for the two D1/DO-backed polls above — one round trip per turn, so it is far
 *  longer in wall time than SETTLE_TURNS of bare event-loop turns. */
const POLL_TURNS = 250;

/**
 * The caller context a backend receives. Every authorization decision has already run by
 * the time a backend is called, so an owner-shaped ctx is all a direct backend call needs —
 * the pipeline's own checks are the worker project's and pipeline-tunnel's.
 */
export function backendCtx(): BackendCtx {
  return {
    principal: { kind: "user", userId: "fixture-owner", username: "fixture-owner" },
    roles: ["all"],
  };
}

/** One service row as the gateway would hand it to a backend. Throws rather than answering
 *  null: a fixture whose own service vanished is a broken fixture, not a case outcome. */
export async function serviceRowOf(ownerId: string, slug: string): Promise<Service> {
  const row = await new Registry(env.DB).getService(ownerId, slug);
  if (row === null) throw new Error(`the fixture's service "${slug}" vanished`);
  return row;
}
