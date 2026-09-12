// tunnel-do.ts — the plumbing every suite in `test/tunnel/` needs and none of them owns:
// the DO addressing rule, the two ways of waiting for the hub to settle, the socket
// still-open probe, the doorbell wait that survives §21.3's floor, and the caller context
// a backend receives. Each of these is ONE decision — how an app id becomes a stub, how
// long a wait may run before it is a failed assertion rather than a slow test, which half
// of the bell floor a case is allowed to depend on — and each was spelled in three or four
// files before it lived here.
//
// Separate from fake-app.ts on purpose: this half imports `cloudflare:test`, which is
// the pool's own seam, while the fake app is a plain WebSocket client that must stay
// free of it (its header explains why it imports nothing of the hub's either).
//
// What does NOT belong here: fixture seeding. What a suite seeds — which apps, which
// tokens, which grants — is the part that genuinely differs per file, and a shared seeder
// would make every suite's premise unreadable from the suite.
//
// deps: cloudflare:test (env.APP_CONNECTION, runInDurableObject, runDurableObjectAlarm) ·
// vitest expect · harness/fake-app (tick, waitFor, FakeApp) · src/tunnel (status,
// tunnelBackend, AppConnection, BELL_PENDING_PREFIX) · src/registry (Registry, App)

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { BackendCtx, Tool } from "../../src/gateway";
import { Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { BELL_PENDING_PREFIX, status, tunnelBackend } from "../../src/tunnel";
import type { AppConnection } from "../../src/tunnel";
import { tick } from "./fake-app";
import type { FakeApp } from "./fake-app";

/**
 * The DO behind an app id, addressed exactly as the hub addresses it — by the opaque
 * `app.id`, never by user or slug (§6: deleting a user and recreating the username can
 * never rebind to a stale DO). The one place that rule is spelled test-side.
 */
export function connectionStub(appId: string): AppConnection {
  const namespace = env.APP_CONNECTION as DurableObjectNamespaceLike<AppConnection>;
  return namespace.get(namespace.idFromName(appId));
}

/** How many sockets the DO is holding — the count §6's at-most-one invariant is about,
 *  and what a refused upgrade must leave at zero. */
export function liveSockets(appId: string): Promise<number> {
  return runInDurableObject(
    connectionStub(appId),
    (_instance: AppConnection, state) => state.getWebSockets().length,
  );
}

/**
 * Wait for one of §21.3's doorbells to reach a stream, WHICHEVER half of the floor
 * delivers it — and answer whether it did.
 *
 * The floor is why this exists rather than a bare `waitFor` on the frame: the first ring in
 * a quiet window goes out immediately, but a change inside LISTEN_BELL_MIN_INTERVAL_MS of
 * it is suppressed into a pending trailing ring that ONLY the coalescing alarm delivers.
 * Which half a case gets is decided by how many real milliseconds the suite happened to
 * spend between two provocations — the floor is wall-clock arithmetic plus a storage alarm,
 * so `shrinkTimers` (which patches setTimeout) cannot reach it and no amount of ticking
 * makes a one-second window pass. A case that waited only for the frame therefore asserted
 * the suite's own speed: two of them passed for months and went red when D16 made setup
 * fast enough to land both changes inside the same window.
 *
 * So: poll the frame, and each turn ALSO ask the DO whether it recorded this bell as
 * pending — when it has, fire the one alarm that flushes it. Nothing is shrunk and nothing
 * is slept; both paths are asserted through the same call, and §21.3's "the final state
 * always rings" is what fails when it stops being true.
 *
 * The alarm is pulled only against an observed pending ring, never blind: `alarm()`
 * multiplexes §6's registration deadline into the same slot, and a firing with nothing
 * pending spends that deadline (closing a socket still inside its handshake window).
 */
export async function untilBellRings(
  appId: string,
  bell: string,
  arrived: () => boolean,
): Promise<boolean> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    if (arrived()) return true;
    const stub = connectionStub(appId);
    const pending = await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.get<boolean>(BELL_PENDING_PREFIX + bell),
    );
    if (pending === true) await runDurableObjectAlarm(stub);
    await tick();
  }
  return arrived();
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
export async function stillOpen(app: FakeApp): Promise<boolean> {
  let ended = false;
  void app.closed.then(() => {
    ended = true;
  });
  for (let turn = 0; turn < SETTLE_TURNS && !ended; turn++) await tick();
  return !ended;
}

/**
 * Wait until the hub reports `appId` at `expected`. Status is a READ, so it is polled
 * rather than slept on, and a status that never arrives fails as an assertion naming both
 * sides instead of as a test timeout with nothing to read.
 */
export async function untilStatus(appId: string, expected: "online" | "offline"): Promise<void> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    if ((await status(appId)) === expected) return;
    await tick();
  }
  expect(await status(appId), `the app never read ${expected}`).toBe(expected);
}

/**
 * Wait until the DO holds a non-empty cached catalog for `app`, and answer it — the
 * state a fixture's first assertion assumes whenever it dialled a socket to get there.
 * Generous, like waitFor's own default, because it is paid in full only when the answer is
 * "the catalog never warmed", which is a failure.
 */
export async function untilCataloged(app: App): Promise<Tool[]> {
  for (let turn = 0; turn < POLL_TURNS; turn++) {
    const tools = await tunnelBackend.listTools(app, backendCtx());
    if (tools.length > 0) return tools;
    await tick();
  }
  throw new Error(`the catalog for "${app.slug}" never warmed`);
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

/** One app row as the gateway would hand it to a backend. Throws rather than answering
 *  null: a fixture whose own app vanished is a broken fixture, not a case outcome. */
export async function appRowOf(ownerId: string, slug: string): Promise<App> {
  const row = await new Registry(env.DB).getApp(ownerId, slug);
  if (row === null) throw new Error(`the fixture's app "${slug}" vanished`);
  return row;
}
