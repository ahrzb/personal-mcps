/**
 * tunnel/smoke.test.ts — the first file written in this directory, and kept forever
 * (strategy §3, §6). Before any other tunnel suite is worth writing, two PLATFORM
 * assumptions the whole subsystem rests on must be observed true in this exact
 * toolchain. This file pins the platform, not the spec: it names no §-numbered
 * behavior and carries no owner-authored rows, and it is deliberately allowed to
 * assert mechanism — here the mechanism IS the subject.
 *
 * A1 — a SQLite-backed Durable Object (`new_sqlite_classes`) actually runs under
 * workerd on this machine (Windows). Every other file in server/test/tunnel/ is a DO
 * test; if A1 is false there is no `tunnel` project at all, and the answer is
 * environmental (toolchain, versions, wrangler config), never a design change.
 *
 * A2 — `serializeAttachment` survives `evictDurableObject(stub, { webSockets:
 * "hibernate" })`: the eviction genuinely discards in-memory instance state while the
 * socket keeps round-tripping, AND the attachment reads back intact on the far side.
 * UNVERIFIED UPSTREAM, and the hub's entire connection identity rides on it — §6 puts
 * serviceId, ownerId, slug, tokenId and `registered` in the attachment, and every wake
 * (alarm, forward, sever, status) reads them from there rather than from a field.
 * **If A2 is false, ServiceConnection needs a durable-storage fallback for its
 * attachment before another line is written in this directory**: protocol,
 * lifecycle, pipeline-tunnel and approval-e2e all assume identity-through-hibernation,
 * and hibernation.test.ts has no subject at all without it.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`). WebSockets and
 * Durable Objects are the two things per-file storage isolation cannot cover (strategy
 * §2), so this project trades isolation for them. That trade is load-bearing here:
 * nothing resets between cases, so DO identity is the only isolation available and
 * every case mints its OWN service id — a shared id would let one case's hibernated
 * socket answer another's, and the resulting flake would look like a hibernation bug.
 *
 * Time: never slept. The 10 s registration deadline is reached by firing the pending
 * alarm with `runDurableObjectAlarm`; the last case below pins that the helper really
 * does fire it immediately, because four other files depend on that being free.
 *
 * Ordering: this file runs before every other file in this directory, and a failure
 * here is a stop-the-line result rather than a red test to work around.
 */

// deps: cloudflare:test (env.SERVICE_CONNECTION, runInDurableObject, evictDurableObject, runDurableObjectAlarm) · src/tunnel (ServiceConnection) · src/limits (REGISTRATION_DEADLINE_MS)

import { describe, it } from "vitest";
import type { ServiceConnection } from "../../src/tunnel";

/**
 * The DO handle every case here drives — `DurableObjectStub<ServiceConnection>` at
 * implementation, which is what cloudflare:test's `runInDurableObject`,
 * `evictDurableObject` and `runDurableObjectAlarm` each take. Typed `unknown` for the
 * same reason the src skeletons type their bindings `unknown`:
 * `@cloudflare/vitest-plugin` is installed (runner stage), but the real stub type still
 * lands here in exactly one place, when the tunnel phase wires it. The class behind the
 * stub is {@link ServiceConnection}.
 */
export type ServiceConnectionStub = unknown;

describe("A1 — a SQLite-backed Durable Object under workerd", () => {
  it.todo("1. platform A1 · a fresh ServiceConnection stub answers an RPC method call");
  it.todo("2. platform A1 · a row written to DO SQLite reads back on a second, separate call into the same instance");
  it.todo("3. platform A1 · DO SQLite is per-instance: a stub for a second service id sees none of the first's rows (the isolation this whole directory leans on)");
});

describe("A2 — evictDurableObject with hibernating sockets", () => {
  it.todo("4. platform A2 · a socket accepted with ctx.acceptWebSocket still round-trips a text frame after evictDurableObject({ webSockets: \"hibernate\" }) — hibernated, not closed");
  it.todo("5. platform A2 · eviction really discards in-memory state: an instance field set before the boundary is gone after it (the negative twin of case 4, and the premise under §6's in-memory pending map)");
  it.todo("6. platform A2 · THE GATE — a value written with serializeAttachment before eviction deserializes intact after it, so ConnectionAttachment can carry identity through hibernation (§6)");
  it.todo("7. platform A2 · DO SQLite survives eviction untouched — the cached catalog's durability premise, stated beside its in-memory twin in case 5");
  it.todo("8. platform A2 · a storage alarm set before eviction is still pending after it");
});

describe("project sanity — the serial tunnel project", () => {
  it.todo("9. platform · runDurableObjectAlarm fires a pending alarm immediately, so limits.REGISTRATION_DEADLINE_MS is a constant this suite reads, never a duration it waits out");
  it.todo("10. platform · two DO ids created inside one file stay independent under --no-isolate: state written through one stub is invisible through the other");
});
