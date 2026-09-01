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
 * appId, ownerId, slug, tokenId and `registered` in the attachment, and every wake
 * (alarm, forward, sever, status) reads them from there rather than from a field.
 * **If A2 is false, AppConnection needs a durable-storage fallback for its
 * attachment before another line is written in this directory**: protocol,
 * lifecycle, pipeline-tunnel and approval-e2e all assume identity-through-hibernation,
 * and hibernation.test.ts has no subject at all without it.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`). WebSockets and
 * Durable Objects are the two things per-file storage isolation cannot cover (strategy
 * §2), so this project trades isolation for them. That trade is load-bearing here:
 * nothing resets between cases, so DO identity is the only isolation available and
 * every case mints its OWN app id — a shared id would let one case's hibernated
 * socket answer another's, and the resulting flake would look like a hibernation bug.
 *
 * Time: never slept. The 10 s registration deadline is reached by firing the pending
 * alarm with `runDurableObjectAlarm`; the last case below pins that the helper really
 * does fire it immediately, because four other files depend on that being free.
 *
 * Ordering: this file runs before every other file in this directory, and a failure
 * here is a stop-the-line result rather than a red test to work around.
 */

// deps: cloudflare:test (env.APP_CONNECTION, runInDurableObject, evictDurableObject, runDurableObjectAlarm) · src/tunnel (AppConnection) · src/limits (REGISTRATION_DEADLINE_MS)

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REGISTRATION_DEADLINE_MS } from "../../src/limits";
import type { AppConnection } from "../../src/tunnel";

/**
 * The tunnel project's shadow of the `cloudflare:test` helpers this directory drives a
 * Durable Object with — server/test/env.d.ts declares the base set (env,
 * applyD1Migrations, the scheduled controller) and this augments it, in the file whose
 * subject IS the platform. Stubs are `unknown` here rather than the plugin's
 * `DurableObjectStub<O>`: this repo declares no `@cloudflare/workers-types`, so
 * {@link AppConnectionStub} below is the one place a stub gets a name.
 *
 * `abortAllDurableObjects` is declared here and driven elsewhere (pipeline-tunnel's
 * DO-failure case): unlike eviction it does NOT drain in-flight requests, which is the
 * only in-process way to a real DO RPC failure under a waiting consumer — §6's "forcibly
 * restarted" branch. It is a platform helper like the other three, so it is shadowed
 * beside them rather than in the file that happens to call it.
 */
declare module "cloudflare:test" {
  export function runInDurableObject<O, R>(
    stub: unknown,
    callback: (instance: O, state: DurableObjectStateLike) => R | Promise<R>,
  ): Promise<R>;
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  export function evictDurableObject(
    stub: unknown,
    options?: { webSockets?: "close" | "hibernate" },
  ): Promise<void>;
  export function abortAllDurableObjects(): Promise<void>;
}

/**
 * The DO handle every case here drives — `DurableObjectStub<AppConnection>` at
 * implementation, which is what cloudflare:test's `runInDurableObject`,
 * `evictDurableObject` and `runDurableObjectAlarm` each take. The stub's methods ARE the
 * class's, called over RPC, so the class itself is the honest name for it: this repo has
 * no `DurableObjectStub` type to import, and workers-env.d.ts's
 * `DurableObjectNamespaceLike<Stub>` hands back exactly what `get` was parameterized with.
 */
export type AppConnectionStub = AppConnection;

/** A stub for an app id nothing else in this run uses — the only isolation a project
 *  that shares storage across files has (see the header). */
function freshStub(): AppConnectionStub {
  const namespace = env.APP_CONNECTION as DurableObjectNamespaceLike<AppConnectionStub>;
  return namespace.get(namespace.idFromName(`smoke-${crypto.randomUUID()}`));
}

/**
 * A socket accepted into the hibernation API, held by the DO — the platform pair every A2
 * case is built from.
 *
 * OBSERVED, not chosen: a WebSocketPair minted in the test's own context cannot be handed
 * to `acceptWebSocket` ("Cannot perform I/O on behalf of a different Durable Object"), and
 * `runInDurableObject`'s return value is devalue-serialized, so a socket cannot come back
 * out of a callback either. A DO-owned socket exists only if the DO mints it in `fetch`
 * and returns it in the 101 — which is why this helper goes through AppConnection.fetch
 * rather than around it.
 *
 * The four identity headers are the WORKER's side of an internal seam (the DO trusts them,
 * §3), and this probe would rather not know them — but the DO refuses a request that does
 * not carry all four rather than inventing an identity out of empty strings, so a probe
 * that wants a socket has to present one. Obviously fake values, spelled here: nothing in
 * this file reads them back, and a rename in tunnel.ts surfaces as this helper's own 426.
 */
async function acceptSocket(stub: AppConnectionStub): Promise<WebSocket> {
  const response = await stub.fetch(
    new Request("https://connection.invalid/", {
      headers: {
        Upgrade: "websocket",
        "x-pmcp-app-id": "smoke-app",
        "x-pmcp-owner-id": "smoke-owner",
        "x-pmcp-slug": "smoke",
        "x-pmcp-token-id": "smoke-token",
      },
    }),
  );
  const client = response.webSocket;
  if (response.status !== 101 || client === null) {
    throw new Error(`acceptSocket: the DO refused the upgrade (${response.status})`);
  }
  client.accept();
  return client;
}

/** The client end's inbox as a pull queue, so a frame that arrives before the read is
 *  waited for is not lost. */
function inbox(ws: WebSocket): () => Promise<string> {
  const queued: string[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener("message", (event) => {
    queued.push(String((event as MessageEvent).data));
    wake?.();
  });
  return async () => {
    while (queued.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return queued.shift() as string;
  };
}

/** The attachment the DO put on a socket, read from inside its own context. */
function attachmentOf(stub: AppConnectionStub): Promise<unknown> {
  return runInDurableObject(stub, (_instance: AppConnection, state) =>
    state.getWebSockets()[0].deserializeAttachment(),
  );
}

describe("A1 — a SQLite-backed Durable Object under workerd", () => {
  it("1. platform A1 · a fresh AppConnection stub answers an RPC method call", async () => {
    expect(await freshStub().status()).toBe("offline");
  });

  it("2. platform A1 · a row written to DO SQLite reads back on a second, separate call into the same instance", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance: AppConnection, state) => {
      state.storage.sql.exec(`CREATE TABLE probe (k TEXT PRIMARY KEY, v TEXT)`);
      state.storage.sql.exec(`INSERT INTO probe VALUES ('a', 'written')`);
    });
    const rows = await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.sql.exec<{ v: string }>(`SELECT v FROM probe WHERE k = 'a'`).toArray(),
    );
    expect(rows).toEqual([{ v: "written" }]);
  });

  it("3. platform A1 · DO SQLite is per-instance: a stub for a second app id sees none of the first's rows (the isolation this whole directory leans on)", async () => {
    const first = freshStub();
    await runInDurableObject(first, (_instance: AppConnection, state) => {
      state.storage.sql.exec(`CREATE TABLE probe (k TEXT PRIMARY KEY)`);
      state.storage.sql.exec(`INSERT INTO probe VALUES ('a')`);
    });
    const tables = await runInDurableObject(freshStub(), (_instance: AppConnection, state) =>
      state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = 'probe'`)
        .toArray(),
    );
    expect(tables).toEqual([]);
  });
});

describe("A2 — evictDurableObject with hibernating sockets", () => {
  it("4. platform A2 · a socket accepted with ctx.acceptWebSocket still round-trips a text frame after evictDurableObject({ webSockets: \"hibernate\" }) — hibernated, not closed", async () => {
    const stub = freshStub();
    const client = await acceptSocket(stub);
    const next = inbox(client);
    await evictDurableObject(stub, { webSockets: "hibernate" });

    // hub → client: the woken instance still holds the socket and can write to it.
    await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.getWebSockets()[0].send("hub-ping"),
    );
    expect(await next()).toBe("hub-ping");

    // client → hub: a frame from the far side reaches the woken instance, which answers it.
    client.send(JSON.stringify({ jsonrpc: "2.0", id: "smoke-1", method: "tools/list" }));
    expect(JSON.parse(await next())).toMatchObject({ id: "smoke-1", error: expect.anything() });
  });

  it("5. platform A2 · eviction really discards in-memory state: an instance field set before the boundary is gone after it (the negative twin of case 4, and the premise under §6's in-memory pending map)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (instance: AppConnection) => {
      (instance as unknown as Record<string, unknown>).smokeProbe = "before";
    });
    await evictDurableObject(stub, { webSockets: "hibernate" });
    const after = await runInDurableObject(
      stub,
      (instance: AppConnection) => (instance as unknown as Record<string, unknown>).smokeProbe,
    );
    expect(after).toBeUndefined();
  });

  it("6. platform A2 · THE GATE — a value written with serializeAttachment before eviction deserializes intact after it, so ConnectionAttachment can carry identity through hibernation (§6)", async () => {
    const stub = freshStub();
    await acceptSocket(stub);
    // Read on both sides of the boundary and compared, so the case pins the ROUND TRIP
    // rather than any particular shape — what the DO puts in the attachment is §6's
    // business, and protocol/lifecycle observe the fields through behavior.
    const before = await attachmentOf(stub);
    expect(before).not.toBeUndefined();
    await evictDurableObject(stub, { webSockets: "hibernate" });
    expect(await attachmentOf(stub)).toEqual(before);
  });

  it("7. platform A2 · DO SQLite survives eviction untouched — the cached catalog's durability premise, stated beside its in-memory twin in case 5", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.put("smoke-catalog", [{ name: "search" }]),
    );
    await evictDurableObject(stub, { webSockets: "hibernate" });
    const read = await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.get("smoke-catalog"),
    );
    expect(read).toEqual([{ name: "search" }]);
  });

  it("8. platform A2 · a storage alarm set before eviction is still pending after it", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.setAlarm(Date.now() + REGISTRATION_DEADLINE_MS),
    );
    await evictDurableObject(stub, { webSockets: "hibernate" });
    const pending = await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.getAlarm(),
    );
    expect(pending).not.toBeNull();
    // Fired here rather than left hanging: the project is serial, so an alarm outliving its
    // case would wake a DO in the middle of the next file's.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe("project sanity — the serial tunnel project", () => {
  it("9. platform · runDurableObjectAlarm fires a pending alarm immediately, so limits.REGISTRATION_DEADLINE_MS is a constant this suite reads, never a duration it waits out", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance: AppConnection, state) =>
      state.storage.setAlarm(Date.now() + REGISTRATION_DEADLINE_MS),
    );
    const startedAt = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(REGISTRATION_DEADLINE_MS);
    // And it is consumed: a fired alarm is no longer pending, which is what makes "fire the
    // deadline" a single observable event in every suite that leans on this.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("10. platform · two DO ids created inside one file stay independent under --no-isolate: state written through one stub is invisible through the other", async () => {
    const first = freshStub();
    const second = freshStub();
    await runInDurableObject(first, (_instance: AppConnection, state) =>
      state.storage.put("smoke-key", "first"),
    );
    const read = await runInDurableObject(second, (_instance: AppConnection, state) =>
      state.storage.get("smoke-key"),
    );
    expect(read).toBeUndefined();
  });
});
