/**
 * tunnel/approval-e2e.test.ts — §16's approval bullet, run over a real tunnel: the
 * consumer POSTs through the real worker entry, the gate runs against real D1, and the
 * call either does or does not arrive at a fake service on a live WebSocket. That fake
 * service's INVOCATION COUNTER is the oracle this whole file turns on — "exactly once"
 * is a claim about executions, and only the executing end can count them. Every row
 * that says a call was refused also says the counter did not move.
 *
 * WHAT THIS SUITE PINS. The loop of §7 end to end (gated call → -32003 with a link →
 * decision → identical retry executes once → the next identical call opens a fresh
 * pending); pending dedup returning a stable approvalId with no second row, audit row,
 * or push; the CAS claim under DETERMINISTIC interleavings — N concurrent identical
 * calls resolve to exactly one execution, and the initial SELECT never authorizes
 * dispatch; availability-first in BOTH directions (a known-unavailable service is
 * refused -32000 before any row is read, created or consumed, and an unavailability
 * discovered between check and claim leaves the pass `approved`); MRTR legs riding one
 * approval; the redaction union over a real cached catalog; and catalog-miss refused
 * -32001 (decided 2026-08-25 — indistinguishable from ungranted, so a probing agent
 * cannot map its own grant patterns).
 *
 * WHY THE INTERLEAVINGS ARE A TABLE, AND WHY THEY ARE DETERMINISTIC. workerd is
 * cooperative: firing fifty identical calls and hoping they collide tests the scheduler,
 * not the CAS. Each row instead names a SCHEDULE — the exact order in which legs are
 * released past check, past claim, into dispatch, and answered — so the row that would
 * pass under a SELECT-then-dispatch implementation and the row that would not are both
 * expressible, and a failure names the interleaving rather than "flaky". This is the one
 * test that constrains implementation SHAPE (strategy §6), which is also why its rows
 * are owner-authored before any implementation exists.
 *
 * WHAT IT DOES NOT PIN. The approval row mechanics against D1 in isolation — dedup via
 * the partial unique index, lazy-expiry auditing exactly once, push crypto decrypted
 * in-test — are worker/approvals.test.ts's, socket-free and cheaper there. The
 * redaction path GRAMMAR is unit/redact.test.ts's. Here every claim is one a tunnel can
 * make and a D1-only suite cannot: an execution actually happened, or it did not.
 *
 * Durable vs incidental (§7): exactly-once, availability-first in both directions,
 * post-redaction hashing, and the -32001 catalog-miss code are durable and pinned hard.
 * Incidental and unasserted: the error prose (the case asserts the code plus the
 * PRESENCE of approvalId/approvalUrl/expiresAt), the approval id format, and the
 * one-hour window — expiry is driven through the injected ApprovalsConfig.now() and
 * limits.APPROVAL_WINDOW_MS, never by sleeping.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): a live socket,
 * a real ServiceConnection, and interleavings that must not race a sibling worker
 * (strategy §2). The consumer side is driven through `exports.default.fetch` from
 * `cloudflare:workers`.
 *
 * Isolation and ordering, load-bearing: smoke, protocol, lifecycle and pipeline-tunnel
 * green first — this file assumes the handshake, the close codes, and the forwarding
 * path all hold, and adds only the gate. D1 migrations come from the project setup file
 * (applyD1Migrations, idempotent); under --no-isolate the database is shared, so every
 * case seeds its own owner, service, account and approval rows and never asserts on
 * table-wide counts. Time is injected, never slept; ordering is released by the fake
 * service's gates, never awaited.
 */

// deps: harness/seed · harness/fake-service (invocation counter, release gates) · cloudflare:workers (exports.default.fetch) · cloudflare:test (env.SERVICE_CONNECTION) · src/approvals (Approvals.check/claim/settle/decide, ApprovalsConfig.now, canonicalJson, ApprovalStatus) · src/gateway (JsonRpcResponse) · src/tunnel (status, tunnelBackend) · src/registry (Registry.redactPathsFor, writeOnlyPaths, applyRedaction) · src/audit (query) · src/limits (APPROVAL_WINDOW_MS)

import { describe, it } from "vitest";
import type { ApprovalStatus } from "../../src/approvals";

/** The concurrent legs one interleaving row may schedule — identical calls, distinguishable only by name. */
export type CasLeg = "A" | "B" | "C";

/**
 * One released step of a schedule. The leg-scoped steps are the four points the gate
 * makes observable — past approvals.check, past the atomic claim, frame arrives at the
 * service, service answers — and are exactly where a SELECT-then-dispatch
 * implementation differs from a CAS one. The two unscoped steps are the world changing
 * underneath: the owner deciding out of band, and the service going away or coming back
 * (the availability-between-check-and-claim rows).
 */
export type CasStep =
  | { leg: CasLeg; at: "checked" }
  | { leg: CasLeg; at: "claimed" }
  | { leg: CasLeg; at: "dispatched" }
  | { leg: CasLeg; at: "answered" }
  | { at: "approve" }
  | { at: "reject" }
  | { at: "service_offline" }
  | { at: "service_online" };

/** What a single leg's consumer sees — an execution, or one of §7's three refusal codes. */
export type CasOutcome = "executed" | -32000 | -32001 | -32003;

/**
 * One row of the CAS interleaving table.
 *
 * `schedule` is the whole point: a total order over the release points above, so the
 * row is a reproducible scenario rather than a race. `invocations` is the fake
 * service's counter afterwards — the exactly-once oracle. `outcomes` is per leg, so a
 * row states both who executed and what the losers were told. `finalStatus` is the
 * approval row as any reader would see it afterwards, in {@link ApprovalStatus}'s own
 * vocabulary — the column that separates "consumed" from "restored" (MRTR) and from
 * "never touched" (an unavailable service).
 *
 * `twin` is §9 rule 2 made structural on the most reward-hackable table in the
 * repository: an implementation that dispatches NOTHING scores a perfect exactly-once
 * on every losing leg, and only an execution can fail it. A row that already contains
 * one — `invocations` above zero, some leg `"executed"` — is its own twin and names
 * itself; that is the common case, and it is why this column is cheap. A row where
 * every leg is refused (the availability-first rows, whose whole point is that nothing
 * ran) must name another row in this table that executes under the same starting
 * conditions with one input changed — the service online rather than offline, the tool
 * in the catalog rather than absent. The runner resolves the name as a LOOKUP and
 * never re-runs the twin's schedule: an interleaving is expensive, and rows stay
 * independent of each other's order.
 */
export type CasInterleavingRow = {
  /** Test title, in the doc's convention: "§7 step 1 · <what this interleaving pins>". */
  name: string;
  legs: readonly CasLeg[];
  /** Whether an approved, unexpired pass exists before the schedule starts. */
  startsWith: "approved_pass" | "no_pass";
  schedule: readonly CasStep[];
  invocations: number;
  outcomes: Readonly<Partial<Record<CasLeg, CasOutcome>>>;
  finalStatus: ApprovalStatus;
  twin: string;
};

/**
 * The CAS interleaving table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1, and §6 names this specific test's author) —
 * agents never fill them. Each row that refuses a leg must sit beside a row where the
 * same leg executes (§9 rule 2): a table of nothing-but-losers is satisfied by an
 * implementation that dispatches nothing at all. The `twin` column carries that
 * requirement as data and runCasInterleaving enforces it, so it is a checked property
 * of the table rather than an instruction the next author may not read.
 */
export const casInterleavings: readonly CasInterleavingRow[] = [];

/**
 * Runs one interleaving: seeds the pass the row starts from, enters every leg as a
 * real consumer request, and releases the schedule step by step through the gates the
 * fake service and the gate seam expose. Reads the counter and the row afterwards.
 * Nothing here awaits a timeout or sleeps — a step that never comes is a failed test,
 * not a slow one.
 *
 * `rows` is the whole table so `row.twin` can be resolved: a row with no executing leg
 * must name a row of `rows` that has one, and a row naming itself must actually have
 * one. The check runs BEFORE the schedule does, so an unpaired refusal row fails fast
 * rather than passing green against a hub that dispatches nothing.
 */
export async function runCasInterleaving(
  row: CasInterleavingRow,
  rows: readonly CasInterleavingRow[],
): Promise<void> {
  // deps: harness/seed · harness/fake-service · cloudflare:workers exports.default.fetch · src/approvals.Approvals
  throw new Error("unimplemented");
}

describe("§7 the approval loop over a real tunnel", () => {
  it.todo("1. §7 step 2 · a gated call answers -32003 carrying approvalId, approvalUrl and expiresAt, and the service's invocation counter stays at zero");
  it.todo("2. §7 step 2 · a retry while still pending returns the SAME approvalId, with no second row, no second approval.requested audit row, and no second push");
  it.todo("3. §7 step 4 · after approve, the identical retry executes exactly once — counter 1 (the allow-twin every refusal in this file is measured against)");
  it.todo("4. §7 step 4 · a second identical call after consumption opens a fresh pending and the counter stays at 1");
  it.todo("5. §7 · arguments differing in a visible field do not match the pass: fresh -32003, counter unchanged");
  it.todo("6. §7 step 4 · a rejected request answers -32003 with a fresh pending row, and the rejected row stays rejected");
  it.todo("7. §7 · a pass past expires_at reads as expired everywhere and emits approval.expired exactly once — driven through the injected clock against limits.APPROVAL_WINDOW_MS, never slept");
  it.todo("8. §7 · owners are never approval-gated: the same tool called by the owner executes with no approval row created at all");
});

describe("§7 the CAS claim under deterministic interleavings", () => {
  it.todo("9. §7 step 1 · interleaving table — one case per row of `casInterleavings`, driven by runCasInterleaving(row, casInterleavings)");
  it.todo("9b. §9 rule 2 · every row either executes a leg itself or its `twin` resolves to a row of this table that does — the invariant a hub dispatching nothing at all cannot satisfy, and the only thing standing between this table and a perfect exactly-once score for doing nothing");
  it.todo("10. §7 step 1 · the initial check never authorizes dispatch: the leg whose claim changes no rows falls through to a fresh -32003, and the counter still reads 1 (the row that goes red against a SELECT-then-dispatch implementation)");
  it.todo("11. §7 step 1 · a claim lost to a concurrent identical call leaves that caller with a NEW pending row rather than a second execution");
});

describe("§7 availability-first, both directions", () => {
  it.todo("12. §7 · a known-offline tunnel is refused -32000 BEFORE the gate reads anything: no pending row, no audit approval.requested, no push — twin: the same call against an online service opens the pending");
  it.todo("13. §7 · an approved pass survives a -32000 for an offline service untouched: the row still reads `approved` and the later retry executes once");
  it.todo("14. §7 · unavailability discovered BETWEEN check and claim yields -32000 with the pass unconsumed — twin: availability holding through the same window consumes it and executes");
  it.todo("15. §7 · a dispatch failure AFTER a successful claim leaves the pass consumed (a call may already have reached the service, §15) and the retry gets a fresh -32003");
});

describe("§7 MRTR — one approval, many legs", () => {
  it.todo("16. §7 · an approved call whose relayed result is input_required restores the row to `approved`, and the consumer receives that result verbatim");
  it.todo("17. §7 · the follow-up leg carrying inputResponses/requestState rides the original approval and reaches the service (the counter advances per leg, no new -32003)");
  it.todo("18. §7 · a complete result consumes the pass: the next identical call opens a fresh pending");
  it.todo("19. §7 · inputResponses/requestState never enter the binding or the stored args_json — the follow-up leg matches on params.arguments alone");
});

describe("§7 the redaction union and the catalog", () => {
  it.todo("20. §7 · the stored args_json masks the UNION over the live catalog: schema `writeOnly` paths from the DO's cached inputSchema plus config `redact` paths, while the service still receives the real values");
  it.todo("21. §7 · args_hash is post-redaction: two calls differing only in a redacted field share one approval row — twin: differing in a visible field, they do not (case 5)");
  it.todo("22. §7 · a tool absent from the cached catalog is refused -32001 — the same code as ungranted and unknown, with no pending row created; twin: the catalogued tool opens one (case 1)");
  it.todo("23. §7 · a never-connected service refuses the same way and heals: after the service registers, the identical call opens a pending instead of -32001");
});
