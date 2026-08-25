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
 * chosen over a timer precisely so it outlives hibernation, so it must still fire.
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

// deps: harness/seed · harness/fake-service · cloudflare:test (env.SERVICE_CONNECTION, evictDurableObject, runInDurableObject, runDurableObjectAlarm) · src/tunnel (tunnelBackend, status, sever, ServiceConnection, ForwardResult) · src/limits (REGISTRATION_DEADLINE_MS, CALL_TIMEOUT_MS)

import { describe, it } from "vitest";
import type { ForwardResult } from "../../src/tunnel";

/**
 * What forward() must answer on the far side of the boundary, in ForwardResult's own
 * vocabulary — spelled from the seam's type so the column can never drift from the
 * three outcomes the DO can actually produce.
 */
export type PostEvictionForward = "ok" | Extract<ForwardResult, { ok: false }>["reason"];

/** The four tiers of DO state, named as §6 divides them, plus the alarm. */
export type EvictedState =
  | "socket_liveness"
  | "attachment_identity"
  | "registered_flag"
  | "catalog_sqlite"
  | "pending_map"
  | "registration_alarm";

/**
 * One row of the survival table.
 *
 * `survives` is the design claim; `observedBy` is how it is made falsifiable from
 * OUTSIDE the object wherever that is possible — a round-trip through the hibernated
 * socket, a forward result, a catalog read, a status read, or the close the alarm
 * produces. `instance_probe` is the single documented exception (the pending map has no
 * behavior to expose), and a row using it must have `survives: false` — a probe that
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
export const evictionSurvivalRows: readonly EvictionSurvivalRow[] = [];

/**
 * Runs one survival row: brings a registered socket up, evicts the DO with sockets
 * hibernating, and makes exactly the observation the row names. The eviction is the
 * only boundary in the test — nothing is closed, nothing sleeps, and the socket is the
 * same one throughout, so a failure means the tier claim is wrong rather than the
 * setup.
 */
export async function runEvictionSurvivalCase(row: EvictionSurvivalRow): Promise<void> {
  // deps: harness/fake-service · cloudflare:test evictDurableObject · src/tunnel.tunnelBackend · src/tunnel.status
  throw new Error("unimplemented");
}

describe("§6 across an evictDurableObject boundary", () => {
  it.todo("1. §6 · survival table — one case per row of `evictionSurvivalRows`, driven by runEvictionSurvivalCase");
  it.todo("2. §6 · a registered socket still round-trips a tools/call after eviction — this file's premise, and the protocol-level twin of smoke.test.ts's A2");
  it.todo("3. §6 · identity survives: the frame forwarded after eviction still carries the hub's own hub/principal and hub/roles, resolved from the attachment");
  it.todo("4. §6 · status() reads online after eviction — `registered` rides the attachment, not an instance field, so availability-first refusals stay correct across a hibernation");
  it.todo("5. §6 · the cached catalog is served after eviction, and after eviction *while offline* too (DO SQLite, not memory)");
  it.todo("6. §6 · the pending map is EMPTY after eviction — §6's hibernation-safety assumption, validated rather than assumed; nothing here asserts it survives");
  it.todo("7. §6 · a forward issued after eviction correlates on a fresh wire id and resolves normally: the empty map costs the next caller nothing (the allow-twin of case 6)");
});

describe("§6 the deadline alarm across hibernation", () => {
  it.todo("8. §6 · an accepted-but-unregistered socket evicted, then runDurableObjectAlarm → close 4004: the deadline is a storage alarm precisely so it outlives hibernation");
  it.todo("9. §6 · a registered socket evicted, then the same alarm → a no-op, socket still open and still online (the allow-twin of case 8)");
});

describe("§6/§10 attachment versioning", () => {
  it.todo("10. §6 · a wake reading an attachment with an unknown or absent `v` closes 4004, so deploy version-skew heals as a routine reconnect");
  it.todo("11. §6 · a wake reading the current `v: 1` attachment proceeds normally — the allow-twin of case 10, and what keeps case 10 from being satisfied by closing every woken socket");
});

describe("§6 owner actions across the boundary", () => {
  it.todo("12. §6 · sever() after eviction closes with the right code and still honors onlyIfTokenId — the opening token id rides the attachment");
  it.todo("13. §6 · wipe() after eviction still returns the DO to never-connected (the catalog it erases is the one case 5 proved survived)");
});
