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
 * cannot map its own grant patterns); and the healing arc, where a service with a COLD
 * catalog and no socket refuses -32000 — availability outranking that same catalog check —
 * and the identical call opens a pending once it re-registers.
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

// deps: harness/seed · harness/fake-service (invocation counter, release gates) · harness/tunnel-do (untilStatus, untilCataloged) · cloudflare:workers (exports.default.fetch) · cloudflare:test (env) · src/approvals (Approvals.check/claim/settle/decide, ApprovalsConfig.now, canonicalJson, ApprovalStatus) · src/gateway (JsonRpcResponse) · src/registry (Registry.redactPathsFor, writeOnlyPaths, applyRedaction) · src/audit (query) · src/limits (APPROVAL_WINDOW_MS)

import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Approvals, canonicalJson } from "../../src/approvals";
import type { ApprovalRow, ApprovalStatus } from "../../src/approvals";
import { config as auditConfig, query, record } from "../../src/audit";
import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import { APPROVAL_WINDOW_MS } from "../../src/limits";
import { REDACTED, Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { connectFakeService, waitFor } from "../harness/fake-service";
import type { FakeService } from "../harness/fake-service";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededService } from "../harness/seed";
import { untilCataloged, untilStatus } from "../harness/tunnel-do";

/** The concurrent legs one interleaving row may schedule — identical calls, distinguishable only by name. */
export type CasLeg = "A" | "B" | "C";

/**
 * One released step of a schedule. The leg-scoped steps name the four points of a gated
 * call — past approvals.check, past the atomic claim, frame arrives at the service,
 * service answers — and are exactly where a SELECT-then-dispatch implementation differs
 * from a CAS one. The two unscoped steps are the world changing underneath: the owner
 * deciding out of band, and the service going away or coming back (the
 * availability-between-check-and-claim rows).
 *
 * WHAT THE RUNNER CAN ACTUALLY DO WITH EACH, stated here because the four read as equals
 * and are not (the runner's own note repeats the first half at the call site):
 * · `checked` is the leg's ENTRY, not a release: the pipeline exposes no seam inside
 *   approvals.check, so a leg is fired at its first step's index and this step's POSITION
 *   is its whole effect. Two consecutive `checked` steps therefore enter in one tick,
 *   which is what "both check the same pass before either claims" means on a cooperative
 *   runtime — and which of the two then WINS the claim is the runtime's answer, not the
 *   row's: the legs are identical calls and the winner is decided by the scheduling of
 *   six D1/DO round trips. Their outcomes are compared as a multiset for that reason
 *   (entryCohorts); a row must not encode an ordering whose only expression is which
 *   letter it wrote first.
 * · `claimed` is a BARRIER, not a per-leg release: the runner waits until the named leg
 *   has settled or a frame has reached the service, which is as close to "past the claim"
 *   as an observer outside approvals can get. On a multi-leg row a later `claimed` can
 *   already hold when it is reached — so reordering two `claimed` steps of one row does
 *   not necessarily change what runs. Making it real needs a release seam on Approvals,
 *   the way FakeService gives hang/release; until then a row must not encode an ordering
 *   whose only expression is the order of its `claimed` steps.
 * · `dispatched` and `answered` are real: both are observed at the fake service, which is
 *   the executing end and the only honest witness this table has.
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
export const casInterleavings: readonly CasInterleavingRow[] = [
  // The fixture these rows are written against, named once: one connected tunneled service
  // `notes` serving `search`, one service account holding `reader` in APPROVAL mode, and
  // one set of arguments used by every leg of every row — legs are identical calls by
  // construction, since anything else would not contend for the same approval.
  //
  // Three conventions, so no row repeats them:
  // · A leg-scoped step RELEASES that leg to the named point; whether it gets PAST it is
  //   the outcome under test — a `claimed` step on a losing leg is precisely the claim that
  //   changes no rows. A leg is parked before its first step, so an unscoped step placed
  //   ahead of a leg's first step is the world that leg finds when it arrives.
  // · `finalStatus` names the row the schedule ACTS ON — the pass a row `startsWith`, or
  //   the pending its first leg opens — read after the schedule drains. A losing leg's
  //   fresh pending is asserted through its `-32003` outcome, never through this column;
  //   otherwise one column would have to describe two rows.
  // · `-32001` is in `CasOutcome` and in no row here. A catalog miss is refused before any
  //   release point and leaves no approval row at all, so it has neither a schedule to
  //   express nor a `finalStatus` to name — case 22 owns it. Same for the MRTR
  //   restore: this table has no column for the service's ANSWER kind, so
  //   `input_required`-restores-the-row lives in cases 16-19, where the fake service's
  //   behavior is set directly.

  // ── the anchor: one leg, one pass, one execution ─────────────────────────────────────
  // §7 step 1's happy path, and the allow-twin the availability rows below are measured
  // against: without it, a hub that dispatches nothing scores a perfect exactly-once.
  {
    name: "§7 step 1 · one leg on one approved pass: check, claim, dispatch, answer — the pass is consumed and the service is invoked exactly once",
    legs: ["A"],
    startsWith: "approved_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { leg: "A", at: "claimed" },
      { leg: "A", at: "dispatched" },
      { leg: "A", at: "answered" },
    ],
    invocations: 1,
    outcomes: { A: "executed" },
    finalStatus: "used",
    twin: "§7 step 1 · one leg on one approved pass: check, claim, dispatch, answer — the pass is consumed and the service is invoked exactly once",
  },

  // ── the CAS itself: both legs SELECT approved, only one claim changes a row ───────────
  // §7 step 1: "A claim that changes no rows means a concurrent identical call already
  // consumed the approval: treat it as no approval and fall through to step 2 (fresh
  // `pending`, `-32003`). The initial SELECT alone never authorizes dispatch." Both legs are
  // released past `checked` BEFORE either claims, which is the interleaving a
  // SELECT-then-dispatch implementation dispatches twice on.
  {
    name: "§7 step 1 · two identical legs both check the same approved pass before either claims: one execution, and the loser falls through to a fresh -32003",
    legs: ["A", "B"],
    startsWith: "approved_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { leg: "B", at: "checked" },
      { leg: "A", at: "claimed" },
      { leg: "B", at: "claimed" },
      { leg: "A", at: "dispatched" },
      { leg: "A", at: "answered" },
    ],
    invocations: 1,
    outcomes: { A: "executed", B: -32003 },
    finalStatus: "used",
    twin: "§7 step 1 · two identical legs both check the same approved pass before either claims: one execution, and the loser falls through to a fresh -32003",
  },
  // §7 step 1 says N, not two: "N concurrent identical calls must resolve to exactly one
  // execution". The third leg is what separates a real compare-and-set from a one-shot
  // boolean that happens to make the two-leg row green.
  {
    name: "§7 step 1 · three identical legs on one approved pass: still exactly one execution, and two losers with fresh -32003s",
    legs: ["A", "B", "C"],
    startsWith: "approved_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { leg: "B", at: "checked" },
      { leg: "C", at: "checked" },
      { leg: "A", at: "claimed" },
      { leg: "B", at: "claimed" },
      { leg: "C", at: "claimed" },
      { leg: "A", at: "dispatched" },
      { leg: "A", at: "answered" },
    ],
    invocations: 1,
    outcomes: { A: "executed", B: -32003, C: -32003 },
    finalStatus: "used",
    twin: "§7 step 1 · three identical legs on one approved pass: still exactly one execution, and two losers with fresh -32003s",
  },

  // ── the owner deciding while legs are in flight ──────────────────────────────────────
  // §7 steps 2-4 as one interleaving: the first leg opens the pending and is refused, the
  // owner decides out of band, and the retry — an identical call, matching on the same
  // post-redaction args_hash — executes once on the row the first leg created.
  {
    name: "§7 step 4 · an owner approving between two legs: the leg arriving after the decision executes once on the pass the first leg opened",
    legs: ["A", "B"],
    startsWith: "no_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { at: "approve" },
      { leg: "B", at: "checked" },
      { leg: "B", at: "claimed" },
      { leg: "B", at: "dispatched" },
      { leg: "B", at: "answered" },
    ],
    invocations: 1,
    outcomes: { A: -32003, B: "executed" },
    finalStatus: "used",
    twin: "§7 step 4 · an owner approving between two legs: the leg arriving after the decision executes once on the pass the first leg opened",
  },
  // §7 step 4: "rejected or expired → `-32003` again with a fresh pending record and link."
  // The decided row is NOT reused and NOT overwritten — a rejection that a retry could flip
  // back to pending would erase the owner's answer. One column away from the row above.
  {
    name: "§7 step 4 · an owner rejecting between two legs: the second leg is refused -32003 with a fresh pending, and the rejected row stays rejected",
    legs: ["A", "B"],
    startsWith: "no_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { at: "reject" },
      { leg: "B", at: "checked" },
    ],
    invocations: 0,
    outcomes: { A: -32003, B: -32003 },
    finalStatus: "rejected",
    twin: "§7 step 4 · an owner approving between two legs: the leg arriving after the decision executes once on the pass the first leg opened",
  },

  // ── availability, on both sides of the claim ─────────────────────────────────────────
  // §7's availability-first rule: a service the hub already knows cannot execute "fails
  // `-32000` before any approval row is read, created, or consumed … an existing approved
  // pass survives untouched". The offline step precedes the leg's first step, so this is
  // the world the leg ARRIVES into, not one it races.
  {
    name: "§7 · a leg arriving at an already-offline service is refused -32000 and the approved pass is left untouched — the owner never re-approves for a reconnect",
    legs: ["A"],
    startsWith: "approved_pass",
    schedule: [{ at: "service_offline" }, { leg: "A", at: "checked" }],
    invocations: 0,
    outcomes: { A: -32000 },
    finalStatus: "approved",
    twin: "§7 step 1 · one leg on one approved pass: check, claim, dispatch, answer — the pass is consumed and the service is invoked exactly once",
  },
  // The other half of that sentence, and the row that makes the one above consequential:
  // "an existing approved pass survives untouched; the agent's retry once the service
  // returns is what opens the pending" — for a pass that already exists, the retry SPENDS
  // it. Without this interleaving "survives untouched" is only ever observed on a row
  // nobody subsequently spends, and both availability rows must borrow the anchor as a
  // cross-row twin instead of carrying an executing leg of their own. It is also the only
  // row that releases `service_online`, and the interleaving case 13 names.
  {
    name: "§7 · the pass that survived an offline refusal is spent by the retry once the service returns: -32000, then the identical leg executes exactly once on that same untouched row",
    legs: ["A", "B"],
    startsWith: "approved_pass",
    schedule: [
      { at: "service_offline" },
      { leg: "A", at: "checked" },
      { at: "service_online" },
      { leg: "B", at: "checked" },
      { leg: "B", at: "claimed" },
      { leg: "B", at: "dispatched" },
      { leg: "B", at: "answered" },
    ],
    invocations: 1,
    outcomes: { A: -32000, B: "executed" },
    finalStatus: "used",
    twin: "§7 · the pass that survived an offline refusal is spent by the retry once the service returns: -32000, then the identical leg executes exactly once on that same untouched row",
  },
  // §7 step 1: "Found → the call proceeds through the availability check; on unavailability
  // the row is left `approved`". The interleaving is the point — availability is re-read
  // between the SELECT and the claim, so a hub that checked availability only before the
  // lookup would consume the pass here and hand the owner a re-approval for nothing.
  {
    name: "§7 step 1 · a service that goes away between check and claim: -32000 with the pass unconsumed, so availability is re-read after the lookup and not only before it",
    legs: ["A"],
    startsWith: "approved_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { at: "service_offline" },
      { leg: "A", at: "claimed" },
    ],
    invocations: 0,
    outcomes: { A: -32000 },
    finalStatus: "approved",
    twin: "§7 step 1 · one leg on one approved pass: check, claim, dispatch, answer — the pass is consumed and the service is invoked exactly once",
  },
  // §7 step 1's deliberate asymmetry with the two rows above: "If dispatch fails *after* a
  // successful claim … the approval stays consumed: the call may already have reached the
  // service (every `tools/call` is at-most-once, §15), so reverting the row would risk a
  // second execution". The counter reads 1 while the consumer reads -32000 — which is
  // exactly the state "may have executed" describes, and the only row here where those two
  // numbers disagree.
  {
    name: "§7 step 1 · a socket dropping after the claim and after the frame arrived: the consumer gets -32000, the service counted the call, and the pass stays used",
    legs: ["A"],
    startsWith: "approved_pass",
    schedule: [
      { leg: "A", at: "checked" },
      { leg: "A", at: "claimed" },
      { leg: "A", at: "dispatched" },
      { at: "service_offline" },
    ],
    invocations: 1,
    outcomes: { A: -32000 },
    finalStatus: "used",
    twin: "§7 step 1 · one leg on one approved pass: check, claim, dispatch, answer — the pass is consumed and the service is invoked exactly once",
  },
];

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
  // §9 rule 2, BEFORE the schedule: a row that refuses every leg must name a row that
  // executes, so an unpaired refusal fails fast rather than green against a hub that
  // dispatches nothing.
  assertTwin(row, rows);

  const fixture = await seedFixture();
  // Parked at dispatch by default: it is what makes "dispatched" and "answered" two
  // separate release points, and it is the only way a losing leg can be observed while the
  // winner is still in flight.
  fixture.fake.setBehavior(TOOL, { mode: "hang" });
  const tracked =
    row.startsWith === "approved_pass" ? await seedApprovedPass(fixture) : undefined;

  const legs = new Map<CasLeg, { promise: Promise<Answer>; answer?: Answer }>();
  const start = startPoints(row.schedule);
  let dispatches = 0;

  /** Started, and not yet settled — a leg parked at dispatch never resolves on its own. */
  const settled = (leg: CasLeg): boolean => legs.get(leg)?.answer !== undefined;
  /** Past the claim: the leg either answered (its claim changed no rows, or it was refused
   *  before the claim) or its frame reached the service (its claim won). */
  const pastClaim = async (leg: CasLeg): Promise<void> => {
    expect(
      await waitFor(() => settled(leg) || servedCalls(fixture) > dispatches),
      `"${row.name}": leg ${leg} never got past its claim`,
    ).toBe(true);
  };

  for (const [at, step] of row.schedule.entries()) {
    switch (step.at) {
      case "checked":
        // The release point IS the leg's entry (see startPoints): consecutive `checked`
        // steps therefore enter in one tick, which is what "both check the same pass before
        // either claims" means on a cooperative runtime.
        break;
      case "claimed":
        await pastClaim(step.leg);
        break;
      case "dispatched":
        dispatches += 1;
        expect(
          await waitFor(() => servedCalls(fixture) >= dispatches),
          `"${row.name}": leg ${step.leg}'s frame never reached the service`,
        ).toBe(true);
        break;
      case "answered":
        fixture.fake.release(TOOL, ANSWER);
        await legs.get(step.leg)?.promise;
        break;
      case "approve":
      case "reject":
        for (const leg of legs.keys()) await pastClaim(leg);
        await decide(fixture, step.at === "approve" ? "approve" : "reject");
        break;
      case "service_offline":
        await goOffline(fixture);
        break;
      case "service_online":
        await goOnline(fixture);
        break;
    }
    for (const leg of row.legs) {
      if (start.get(leg) !== at) continue;
      const entry = { promise: enterLeg(fixture), answer: undefined as Answer | undefined };
      void entry.promise.then((answer) => {
        entry.answer = answer;
      });
      legs.set(leg, entry);
    }
  }

  // Every leg has an outcome, including one whose schedule left it parked: a socket that
  // went away fails its waiter, so the drain is what resolves it.
  const answers = new Map<CasLeg, Answer>();
  for (const [leg, entry] of legs) answers.set(leg, await entry.promise);

  // Per leg where a step ordered the legs; as a MULTISET inside a cohort the runner cannot
  // order (entryCohorts) — "one of these executed and the rest were refused" is the claim
  // §7 step 1 makes, and naming the winner is a claim about workerd's scheduler.
  for (const cohort of entryCohorts(row, start)) {
    const seen = cohort.map((leg) => outcomeOf(answers.get(leg))).sort();
    const expected = cohort.map((leg) => row.outcomes[leg] as CasOutcome).sort();
    expect(seen, `"${row.name}": leg${cohort.length > 1 ? "s" : ""} ${cohort.join("+")}`).toEqual(
      expected,
    );
  }
  // The exactly-once oracle, counted by the executing end and by nothing else.
  expect(servedCalls(fixture), `"${row.name}": invocations`).toBe(row.invocations);
  const trackedId = tracked ?? approvalIdOf(answers.get(row.legs[0]));
  expect((await approvalRow(fixture, trackedId)).status, `"${row.name}": final status`).toBe(
    row.finalStatus,
  );
}

/**
 * The legs of a row grouped by what the runner can actually order. `checked` is the only
 * step that does not await (see CasStep), so legs whose entries are separated by nothing
 * but `checked` steps are fired in ONE tick: identical calls racing the same CAS, where
 * which one wins is the runtime's scheduling of six D1 and DO round trips and not
 * anything §7 says. Their outcomes are therefore compared as a multiset. Legs separated
 * by any other step were really ordered — a barrier, a decision, a socket going away —
 * and keep their per-leg assignment, which is what stops the owner-decides-between-two-
 * legs rows from going green on a hub that dispatched before the decision.
 */
function entryCohorts(row: CasInterleavingRow, start: Map<CasLeg, number>): CasLeg[][] {
  const ordered = [...row.legs].sort((a, b) => (start.get(a) ?? 0) - (start.get(b) ?? 0));
  const cohorts: CasLeg[][] = [];
  let previous = -1;
  for (const leg of ordered) {
    const at = start.get(leg) ?? 0;
    const sameTick =
      previous >= 0 && row.schedule.slice(previous + 1, at + 1).every((step) => step.at === "checked");
    if (sameTick) cohorts[cohorts.length - 1].push(leg);
    else cohorts.push([leg]);
    previous = at;
  }
  return cohorts;
}

/** §9 rule 2 as a checked property of the table: `twin` resolves HERE, as a lookup, and
 *  must name a row that actually executes a leg. */
function assertTwin(row: CasInterleavingRow, rows: readonly CasInterleavingRow[]): void {
  const twin = rows.find((candidate) => candidate.name === row.twin);
  expect(twin, `"${row.name}" names a twin that is not a row of this table`).toBeDefined();
  expect(
    executes(twin as CasInterleavingRow),
    `"${row.name}"'s twin must be a row where a leg EXECUTES`,
  ).toBe(true);
}

/** The property a twin must have: something actually ran. */
function executes(row: CasInterleavingRow): boolean {
  return row.invocations > 0 && Object.values(row.outcomes).includes("executed");
}

/** A leg-scoped step, narrowed. */
function isLegStep(step: CasStep): step is Extract<CasStep, { leg: CasLeg }> {
  return "leg" in step;
}

/**
 * Where each leg's request is actually FIRED. A leg enters at its first release point —
 * unless the schedule changes the WORLD between two of its points, which no seam in the
 * pipeline can pause a request for (see the runner's note): the world change is applied
 * first and the leg then arrives into it, which is the state the row's columns describe.
 */
function startPoints(schedule: readonly CasStep[]): Map<CasLeg, number> {
  const points = new Map<CasLeg, number>();
  for (const [at, step] of schedule.entries()) {
    if (!isLegStep(step)) continue;
    if (!points.has(step.leg)) points.set(step.leg, at);
  }
  for (const [leg, first] of points) {
    const last = schedule.reduce((seen, step, at) => (isLegStep(step) && step.leg === leg ? at : seen), first);
    const straddling = schedule.reduce(
      (seen, step, at) => (!isLegStep(step) && at > first && at < last ? at : seen),
      -1,
    );
    if (straddling >= 0) points.set(leg, straddling);
  }
  return points;
}

/** What one leg's consumer saw. */
function outcomeOf(answer: Answer | undefined): CasOutcome {
  if (answer === undefined) throw new Error("a leg of the schedule never ran");
  return answer.body.error === undefined ? "executed" : (answer.body.error.code as CasOutcome);
}

// ── the fixture every case in this file is built from ─────────────────────────────────

const ORIGIN = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;

/** The fixture the interleaving table names once: one connected tunneled `notes` serving
 *  `search`, one account holding `reader` in APPROVAL mode. */
const SERVICE_SLUG = "notes";
const ACCOUNT = "agent";
const TOOL = "search";

/** Declared by `reader`, absent from the catalog: the ONE way to reach §7's catalog-miss
 *  refusal without the filter answering first (case 22 — case 23 reaches the same
 *  missing-schema world with the socket GONE, where availability answers -32000 before the
 *  catalog is consulted at all). */
const PHANTOM_TOOL = "vanished";

/** The arguments every leg of every row sends — legs are identical calls by construction. */
const ARGS = { q: "one and the same" };

const CONSUMER_ID = 77;

/** Planted values: one masked by the tool's schema, one by the service's `redact` config —
 *  §7's union has two halves and case 20 reads both off one call. */
const ARG_SECRET = "FAKE0000-schema-marked-arg";
const CONFIG_SECRET = "planted-email@example.invalid";
const RESULT_SECRET = "FAKE0000-relayed-result";

/** The catalogued tool: `writeOnly` on `token` is the schema half of the redaction union,
 *  and `profile.email` is what the service's config `redact` covers. */
const SEARCH_TOOL: Tool = {
  name: TOOL,
  description: "the approval-gated tool every case calls",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string" },
      token: { type: "string", writeOnly: true },
      profile: { type: "object", properties: { email: { type: "string" } } },
    },
  },
  outputSchema: {
    type: "object",
    properties: { hits: { type: "integer" }, secret: { type: "string", writeOnly: true } },
  },
};

/** What the service answers a complete call with. */
const ANSWER = {
  structuredContent: { hits: 1, secret: RESULT_SECRET },
  content: [{ type: "text", text: "one hit" }],
};

/** An MRTR leg: the ONE result that restores a claimed approval (§7). */
const INPUT_REQUIRED = {
  resultType: "input_required",
  requestState: "rs-hub",
  inputRequest: { fields: [{ name: "otp" }] },
};

type Fixture = {
  ns: SeededNamespace;
  service: SeededService;
  /** Every socket this fixture has held — the invocation count spans them, because a
   *  reconnect is a NEW socket with a fresh counter (§6: one instance is one socket). */
  sockets: FakeService[];
  fake: FakeService;
};

const seeded: SeededNamespace[] = [];
const opened: FakeService[] = [];

afterEach(async () => {
  for (const service of opened.splice(0)) await service.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/** The fixture every case is built from: the seeded world with a live socket serving the
 *  catalog. */
async function seedFixture(): Promise<Fixture> {
  const fixture = await seedUnconnected();
  await goOnline(fixture);
  return fixture;
}

/** The seeded world with NO socket yet. Split out for the one case that dials its own
 *  (case 23, whose registration serves an empty catalog); every other case wants
 *  {@link seedFixture}. */
async function seedUnconnected(): Promise<Fixture> {
  const ns = await seedNamespace(env.DB, {
    username: uniqueSlug("appr"),
    services: [
      {
        slug: SERVICE_SLUG,
        kind: "tunnel",
        // The config half of §7's redaction union (case 20).
        redact: { [TOOL]: ["profile.email"] },
        tokens: [{ as: "svc" }],
      },
    ],
    accounts: [
      {
        slug: ACCOUNT,
        grants: { [SERVICE_SLUG]: [{ role: "reader", mode: "approval" }] },
        tokens: [{ as: ACCOUNT }],
      },
    ],
  });
  seeded.push(ns);
  return {
    ns,
    service: ns.services[SERVICE_SLUG],
    sockets: [],
    fake: undefined as unknown as FakeService,
  };
}

/** Dial (or re-dial) the service's socket and wait until its catalog is cached. */
async function goOnline(fixture: Fixture): Promise<void> {
  await dial(fixture, [SEARCH_TOOL]);
  await untilStatus(fixture.service.id, "online");
  const cached = await untilCataloged(await serviceRow(fixture));
  expect(cached.map((tool) => tool.name), "the fixture's catalog never reached the DO").toContain(TOOL);
}

/** One registration declaring `reader` and serving `tools`, recorded on the fixture so the
 *  invocation count spans it and `afterEach` closes it. Waiting is the caller's. */
async function dial(fixture: Fixture, tools: Tool[]): Promise<FakeService> {
  const service = await connectFakeService({
    origin: ORIGIN,
    token: fixture.ns.tokens.svc.token,
    // `vanished` is declared and never served: the grant matches it, the catalog does not.
    roles: { reader: [TOOL, PHANTOM_TOOL] },
    tools,
    behavior: { mode: "answer", result: ANSWER },
  });
  opened.push(service);
  fixture.sockets.push(service);
  fixture.fake = service;
  return service;
}

/** Close the current socket and wait until the hub reports the service offline. */
async function goOffline(fixture: Fixture): Promise<void> {
  await fixture.fake.close();
  await untilStatus(fixture.service.id, "offline");
}

async function serviceRow(fixture: Fixture, slug: string = SERVICE_SLUG): Promise<Service> {
  const row = await new Registry(env.DB).getService(fixture.ns.owner.userId, slug);
  if (row === null) throw new Error(`the fixture's service "${slug}" vanished`);
  return row;
}

/** `tools/call` frames received across every socket this fixture has held — the
 *  exactly-once oracle, counted by the executing end. */
function servedCalls(fixture: Fixture, tool: string = TOOL): number {
  return fixture.sockets.reduce((total, socket) => total + socket.callCount(tool), 0);
}

type Answer = { status: number; body: JsonRpcResponse };

/** One JSON-RPC message through the real worker entry, on the scoped endpoint. */
async function rpc(
  fixture: Fixture,
  credential: string,
  slug: string,
  message: JsonRpcRequest,
): Promise<Answer> {
  const response = await workerExports.default.fetch(
    new Request(`${ORIGIN}/${fixture.ns.owner.username}/mcp/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(message),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as JsonRpcResponse };
}

/** One gated `tools/call` as the account makes it — the shape every leg sends. */
function callMessage(
  args: Record<string, unknown> = ARGS,
  extraParams: Record<string, unknown> = {},
  tool: string = TOOL,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: CONSUMER_ID,
    method: "tools/call",
    params: { name: tool, arguments: args, ...extraParams },
  };
}

/** The account's call. */
function accountCall(
  fixture: Fixture,
  args?: Record<string, unknown>,
  extraParams?: Record<string, unknown>,
  tool?: string,
): Promise<Answer> {
  return rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(args, extraParams, tool));
}

/** One leg of an interleaving: the identical call, fired and not awaited. */
function enterLeg(fixture: Fixture): Promise<Answer> {
  return accountCall(fixture);
}

/** The -32003 payload's approval id. */
function approvalIdOf(answer: Answer | undefined): string {
  const data = answer?.body.error?.data as { approvalId?: string } | undefined;
  if (data?.approvalId === undefined) throw new Error("the answer carried no approvalId");
  return data.approvalId;
}

/**
 * The gate as this suite reads and drives it — the same class the composition root wires,
 * with the clock injected (expiry is a read-time interpretation, never a sleep) and no push
 * transport, since an unwired hub sends none and a fixture must not dial a push service.
 */
function approvals(now: () => number = Date.now): Approvals {
  return new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    retentionDays: auditConfig().retentionDays,
    now,
  });
}

/** Every approval row in the fixture's namespace, newest first. */
function approvalRows(fixture: Fixture, now?: () => number): Promise<ApprovalRow[]> {
  return approvals(now).list(fixture.ns.owner.userId);
}

async function approvalRow(fixture: Fixture, id: string): Promise<ApprovalRow> {
  const found = (await approvalRows(fixture)).find((row) => row.id === id);
  if (found === undefined) throw new Error(`approval "${id}" is not in this namespace`);
  return found;
}

/** The owner deciding the one pending row, out of band — the interleaving table's
 *  `approve` / `reject` steps. */
async function decide(fixture: Fixture, decision: "approve" | "reject"): Promise<string> {
  const pending = (await approvalRows(fixture)).find((row) => row.status === "pending");
  if (pending === undefined) throw new Error("no pending approval to decide");
  await approvals().decide(fixture.ns.owner.userId, pending.id, decision);
  return pending.id;
}

/**
 * The owner deciding through the REAL admin op — one `tools/call` on the builtin `pmcp`
 * service under the owner's own session, which is the path the web page and the CLI both
 * take. Used where a case's claim is about the loop end to end rather than about the row.
 */
async function decideViaAdminOp(
  fixture: Fixture,
  id: string,
  decision: "approve" | "reject",
): Promise<Answer> {
  const session = await seedOwnerSession(fixture.ns.owner);
  return rpc(fixture, session.token, "pmcp", {
    jsonrpc: "2.0",
    id: CONSUMER_ID,
    method: "tools/call",
    params: { name: "approval_decide", arguments: { id, decision } },
  });
}

/**
 * An approved, unexpired pass for the fixture's tool and arguments — reached the only way
 * one can be: a gated call opens the pending row, and the owner decides it. Returns the
 * row's id, which is what `finalStatus` is read from.
 */
async function seedApprovedPass(fixture: Fixture): Promise<string> {
  const opened = await accountCall(fixture);
  expect(opened.body.error?.code, "the pass-opening call was not gated").toBe(-32003);
  const id = approvalIdOf(opened);
  await approvals().decide(fixture.ns.owner.userId, id, "approve");
  return id;
}

/** How many audit rows the namespace holds for one event — optionally on one service, which
 *  is how a call on the tunneled service is told from the owner's own admin call. */
async function auditRows(fixture: Fixture, event: string, service?: string): Promise<number> {
  return (await query(env.DB, fixture.ns.owner.userId, { event, service })).total;
}

/**
 * What one case may take. Generous because a case seeds a namespace, dials a socket and
 * sometimes re-dials one — never because anything here waits on a clock: every wait in
 * this file is a `waitFor` over an observable, and a step that never comes fails as an
 * assertion rather than as a timeout.
 */
const CASE_BUDGET_MS = 30_000;

/** The stored (post-redaction) arguments of one approval row, straight off D1 — the column
 *  no read seam exposes as text, which is what case 19 and 20 are about. */
async function storedArgs(id: string): Promise<Record<string, unknown>> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT args_json FROM approval WHERE id = ?`)
    .bind(id)
    .first<{ args_json: string }>();
  if (row === null) throw new Error(`approval "${id}" has no row`);
  return JSON.parse(row.args_json) as Record<string, unknown>;
}

/** The stored binding digest — the other column no read seam exposes (case 21). */
async function storedHash(id: string): Promise<string> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT args_hash FROM approval WHERE id = ?`)
    .bind(id)
    .first<{ args_hash: string }>();
  if (row === null) throw new Error(`approval "${id}" has no row`);
  return row.args_hash;
}

/** SHA-256 as hex — recomputed in-test, so case 21 checks the stored hash against the RULE
 *  rather than against a second call into the code that wrote it. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("§7 the approval loop over a real tunnel", () => {
  it("1. §7 step 2 · a gated call answers -32003 carrying approvalId, approvalUrl and expiresAt, and the service's invocation counter stays at zero", async () => {
    const fixture = await seedFixture();

    const gated = await accountCall(fixture);

    expect(gated.body.error?.code).toBe(-32003);
    // The PRESENCE of the three keys is durable; the id format and the prose are not (§7).
    const data = gated.body.error?.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["approvalId", "approvalUrl", "expiresAt"]);
    expect(String(data.approvalUrl)).toContain(String(data.approvalId));
    expect(servedCalls(fixture), "a gated call never reaches the service").toBe(0);
  });

  it("2. §7 step 2 · a retry while still pending returns the SAME approvalId, with no second row, no second approval.requested audit row, and no second push", async () => {
    const fixture = await seedFixture();

    const first = await accountCall(fixture);
    const retry = await accountCall(fixture);

    expect(approvalIdOf(retry)).toBe(approvalIdOf(first));
    expect(await approvalRows(fixture)).toHaveLength(1);
    // The push rides the same branch as this row — nothing is sent for a dedup'd retry
    // because nothing is inserted (§7 step 2), so the audit count is the observable.
    expect(await auditRows(fixture, "approval.requested")).toBe(1);
    expect(servedCalls(fixture)).toBe(0);
  });

  it("3. §7 step 4 · after approve, the identical retry executes exactly once — counter 1 (the allow-twin every refusal in this file is measured against)", async () => {
    const fixture = await seedFixture();

    const gated = await accountCall(fixture);
    const decided = await decideViaAdminOp(fixture, approvalIdOf(gated), "approve");
    const retry = await accountCall(fixture);

    expect(decided.body.error, "the owner's own decision was refused").toBeUndefined();
    expect(retry.body.result).toBeDefined();
    expect(servedCalls(fixture)).toBe(1);
    expect((await approvalRow(fixture, approvalIdOf(gated))).status).toBe("used");
    // The ledger carries the whole loop: the refusal, the request, the decision, the run.
    expect(await auditRows(fixture, "approval.requested")).toBe(1);
    expect(await auditRows(fixture, "approval.approved")).toBe(1);
    // Two rows on the service — the refusal and the run — beside the owner's own decision,
    // which is a `tools/call` on the builtin like every other admin op (§8).
    expect(await auditRows(fixture, "tools/call", SERVICE_SLUG)).toBe(2);
    expect(await auditRows(fixture, "admin.approval_decide")).toBe(1);
  });

  it("4. §7 step 4 · a second identical call after consumption opens a fresh pending and the counter stays at 1", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    expect((await accountCall(fixture)).body.result, "the pass was not spent").toBeDefined();

    const again = await accountCall(fixture);

    expect(again.body.error?.code).toBe(-32003);
    expect(approvalIdOf(again)).not.toBe(pass);
    expect((await approvalRow(fixture, approvalIdOf(again))).status).toBe("pending");
    expect(servedCalls(fixture)).toBe(1);
  });

  it("5. §7 · arguments differing in a visible field do not match the pass: fresh -32003, counter unchanged", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);

    const different = await accountCall(fixture, { ...ARGS, q: "a visibly different question" });

    expect(different.body.error?.code).toBe(-32003);
    expect(approvalIdOf(different)).not.toBe(pass);
    expect((await approvalRow(fixture, pass)).status, "the untouched pass").toBe("approved");
    expect(servedCalls(fixture)).toBe(0);
  });

  it("6. §7 step 4 · a rejected request answers -32003 with a fresh pending row, and the rejected row stays rejected", async () => {
    const fixture = await seedFixture();
    const rejected = approvalIdOf(await accountCall(fixture));
    await approvals().decide(fixture.ns.owner.userId, rejected, "reject");

    const retry = await accountCall(fixture);

    expect(retry.body.error?.code).toBe(-32003);
    expect(approvalIdOf(retry)).not.toBe(rejected);
    // A retry that could flip a decision back to pending would erase the owner's answer.
    expect((await approvalRow(fixture, rejected)).status).toBe("rejected");
    expect((await approvalRow(fixture, approvalIdOf(retry))).status).toBe("pending");
    expect(servedCalls(fixture)).toBe(0);
  });

  it("7. §7 · a pass past expires_at reads as expired everywhere and emits approval.expired exactly once — driven through the injected clock against limits.APPROVAL_WINDOW_MS, never slept", async () => {
    const fixture = await seedFixture();
    const pending = approvalIdOf(await accountCall(fixture));
    // One window plus a moment, read off the constant — never a literal and never a sleep.
    const past = () => Date.now() + APPROVAL_WINDOW_MS + 1_000;

    const first = (await approvalRows(fixture, past)).find((row) => row.id === pending);
    const second = (await approvalRows(fixture, past)).find((row) => row.id === pending);

    expect(first?.status).toBe("expired");
    expect(second?.status, "expiry is an interpretation, not a one-shot").toBe("expired");
    expect(await auditRows(fixture, "approval.expired"), "audited exactly once").toBe(1);
    // "Everywhere": the decide path reads it the same way and refuses.
    await expect(
      approvals(past).decide(fixture.ns.owner.userId, pending, "approve"),
    ).rejects.toMatchObject({ code: -32001 });
  });

  it("8. §7 · owners are never approval-gated: the same tool called by the owner executes with no approval row created at all", async () => {
    const fixture = await seedFixture();
    const session = await seedOwnerSession(fixture.ns.owner);

    const answer = await rpc(fixture, session.token, SERVICE_SLUG, callMessage());

    expect(answer.body.result).toBeDefined();
    expect(servedCalls(fixture)).toBe(1);
    expect(await approvalRows(fixture), "an owner's call opens no row").toEqual([]);
  });
});

describe("§7 the CAS claim under deterministic interleavings", () => {
  for (const row of casInterleavings) {
    it(`9. ${row.name}`, () => runCasInterleaving(row, casInterleavings), CASE_BUDGET_MS);
  }

  it("9b. §9 rule 2 · every row either executes a leg itself or its `twin` resolves to a row of this table that does — the invariant a hub dispatching nothing at all cannot satisfy, and the only thing standing between this table and a perfect exactly-once score for doing nothing", () => {
    for (const row of casInterleavings) assertTwin(row, casInterleavings);
    // Vacuous unless the table actually holds rows where nothing runs.
    expect(casInterleavings.some((row) => !executes(row))).toBe(true);
  });

  it("10. §7 step 1 · the initial check never authorizes dispatch: the leg whose claim changes no rows falls through to a fresh -32003, and the counter still reads 1 (the row that goes red against a SELECT-then-dispatch implementation)", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "hang" });

    // Both legs enter in ONE tick, so neither can have seen the other's claim before
    // making its own — the interleaving a SELECT-then-dispatch hub dispatches twice on.
    const first = enterLeg(fixture);
    const second = enterLeg(fixture);
    expect(await waitFor(() => servedCalls(fixture) > 0)).toBe(true);
    fixture.fake.release(TOOL, ANSWER);
    const answers = [await first, await second];

    expect(answers.filter((answer) => answer.body.result !== undefined)).toHaveLength(1);
    const loser = answers.find((answer) => answer.body.error !== undefined);
    expect(loser?.body.error?.code).toBe(-32003);
    expect(approvalIdOf(loser), "the loser was handed a FRESH row").not.toBe(pass);
    expect(servedCalls(fixture), "exactly one execution").toBe(1);
  }, CASE_BUDGET_MS);

  it("11. §7 step 1 · a claim lost to a concurrent identical call leaves that caller with a NEW pending row rather than a second execution", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "hang" });

    const first = enterLeg(fixture);
    const second = enterLeg(fixture);
    expect(await waitFor(() => servedCalls(fixture) > 0)).toBe(true);
    fixture.fake.release(TOOL, ANSWER);
    const answers = [await first, await second];

    const loser = answers.find((answer) => answer.body.error !== undefined);
    const opened = await approvalRow(fixture, approvalIdOf(loser));
    expect(opened.status).toBe("pending");
    expect(opened.id).not.toBe(pass);
    expect((await approvalRow(fixture, pass)).status).toBe("used");
    expect(servedCalls(fixture)).toBe(1);
  }, CASE_BUDGET_MS);
});

describe("§7 availability-first, both directions", () => {
  it("12. §7 · a known-offline tunnel is refused -32000 BEFORE the gate reads anything: no pending row, no audit approval.requested, no push — twin: the same call against an online service opens the pending", async () => {
    const fixture = await seedFixture();
    await goOffline(fixture);

    const refused = await accountCall(fixture);

    expect(refused.body.error?.code).toBe(-32000);
    expect(await approvalRows(fixture), "no row was read, created or consumed").toEqual([]);
    // The push rides the insert branch: no row, no audit entry, nothing sent (§7).
    expect(await auditRows(fixture, "approval.requested")).toBe(0);

    // The twin, one state different: the same call against the returned service opens it.
    await goOnline(fixture);
    const gated = await accountCall(fixture);
    expect(gated.body.error?.code).toBe(-32003);
    expect(await approvalRows(fixture)).toHaveLength(1);
    expect(servedCalls(fixture)).toBe(0);
  }, CASE_BUDGET_MS);

  it("13. §7 · an approved pass survives a -32000 for an offline service untouched: the row still reads `approved` and the later retry executes once", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    await goOffline(fixture);

    const refused = await accountCall(fixture);
    expect(refused.body.error?.code).toBe(-32000);
    expect((await approvalRow(fixture, pass)).status, "the owner re-approves for a reconnect").toBe(
      "approved",
    );

    await goOnline(fixture);
    const retry = await accountCall(fixture);
    expect(retry.body.result).toBeDefined();
    expect((await approvalRow(fixture, pass)).status).toBe("used");
    expect(servedCalls(fixture)).toBe(1);
  }, CASE_BUDGET_MS);

  it("14. §7 · unavailability discovered BETWEEN check and claim yields -32000 with the pass unconsumed — twin: availability holding through the same window consumes it and executes", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);

    // The unavailable window: the leg arrives into it and is refused before the claim.
    await goOffline(fixture);
    const refused = await accountCall(fixture);
    expect(refused.body.error?.code).toBe(-32000);
    expect((await approvalRow(fixture, pass)).status).toBe("approved");

    // The twin: availability holding through the same window consumes the pass.
    await goOnline(fixture);
    const executed = await accountCall(fixture);
    expect(executed.body.result).toBeDefined();
    expect((await approvalRow(fixture, pass)).status).toBe("used");
  }, CASE_BUDGET_MS);

  it("15. §7 · a dispatch failure AFTER a successful claim leaves the pass consumed (a call may already have reached the service, §15) and the retry gets a fresh -32003", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "hang" });

    const inFlight = accountCall(fixture);
    expect(await waitFor(() => servedCalls(fixture) > 0)).toBe(true);
    // The socket dies with the frame already delivered: the call MAY have executed.
    await goOffline(fixture);
    expect((await inFlight).body.error?.code).toBe(-32000);
    expect((await approvalRow(fixture, pass)).status, "reverting would risk a second run").toBe("used");

    await goOnline(fixture);
    const retry = await accountCall(fixture);
    expect(retry.body.error?.code).toBe(-32003);
    expect(approvalIdOf(retry)).not.toBe(pass);
  }, CASE_BUDGET_MS);
});

describe("§7 MRTR — one approval, many legs", () => {
  it("16. §7 · an approved call whose relayed result is input_required restores the row to `approved`, and the consumer receives that result verbatim", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "input_required", result: INPUT_REQUIRED });

    const leg = await accountCall(fixture);

    expect(leg.body.result, "the MRTR leg is relayed verbatim").toEqual(INPUT_REQUIRED);
    expect((await approvalRow(fixture, pass)).status).toBe("approved");
    expect(servedCalls(fixture)).toBe(1);
  }, CASE_BUDGET_MS);

  it("17. §7 · the follow-up leg carrying inputResponses/requestState rides the original approval and reaches the service (the counter advances per leg, no new -32003)", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "input_required", result: INPUT_REQUIRED });
    await accountCall(fixture);

    fixture.fake.setBehavior(TOOL, { mode: "answer", result: ANSWER });
    const followUp = await accountCall(fixture, ARGS, {
      inputResponses: [{ name: "otp", value: "FAKE0000" }],
      requestState: "rs-hub",
    });

    expect(followUp.body.error, "the follow-up leg was gated again").toBeUndefined();
    expect(servedCalls(fixture), "the counter advances per leg").toBe(2);
    expect(await approvalRows(fixture), "one approval, many legs").toHaveLength(1);
    expect((await approvalRow(fixture, pass)).status).toBe("used");
  }, CASE_BUDGET_MS);

  it("18. §7 · a complete result consumes the pass: the next identical call opens a fresh pending", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);

    await accountCall(fixture);
    const next = await accountCall(fixture);

    expect(next.body.error?.code).toBe(-32003);
    expect(approvalIdOf(next)).not.toBe(pass);
    expect((await approvalRow(fixture, pass)).status).toBe("used");
  }, CASE_BUDGET_MS);

  it("19. §7 · inputResponses/requestState never enter the binding or the stored args_json — the follow-up leg matches on params.arguments alone", async () => {
    const fixture = await seedFixture();
    const pass = await seedApprovedPass(fixture);
    fixture.fake.setBehavior(TOOL, { mode: "input_required", result: INPUT_REQUIRED });
    await accountCall(fixture);

    const followUp = await accountCall(fixture, ARGS, {
      inputResponses: [{ name: "otp", value: "FAKE0000" }],
      requestState: "rs-hub",
    });

    // It matched the ORIGINAL row, which is only possible if the binding is
    // params.arguments alone (§7's MRTR clause).
    expect(followUp.body.error).toBeUndefined();
    expect(await approvalRows(fixture)).toHaveLength(1);
    const stored = await storedArgs(pass);
    expect(Object.keys(stored).sort()).toEqual(Object.keys(ARGS).sort());
    expect(JSON.stringify(stored)).not.toContain("requestState");
  }, CASE_BUDGET_MS);
});

describe("§7 the redaction union and the catalog", () => {
  it("20. §7 · the stored args_json masks the UNION over the live catalog: schema `writeOnly` paths from the DO's cached inputSchema plus config `redact` paths, while the service still receives the real values", async () => {
    const fixture = await seedFixture();
    const secretive = { ...ARGS, token: ARG_SECRET, profile: { email: CONFIG_SECRET } };

    const gated = await accountCall(fixture, secretive);
    const id = approvalIdOf(gated);
    await approvals().decide(fixture.ns.owner.userId, id, "approve");
    await accountCall(fixture, secretive);

    const stored = await storedArgs(id);
    // The schema half — `token` is writeOnly in the DO's cached inputSchema.
    expect(stored.token).toBe(REDACTED);
    // …and the config half — `profile.email` is the service's own `redact` entry.
    expect((stored.profile as Record<string, unknown>).email).toBe(REDACTED);
    expect(stored.q, "a visible field is stored as it was sent").toBe(ARGS.q);
    // The SERVICE is handed the real values: masking exists for persistence (§15).
    const delivered = fixture.fake.invocations[0].args as Record<string, unknown>;
    expect(delivered.token).toBe(ARG_SECRET);
    expect((delivered.profile as Record<string, unknown>).email).toBe(CONFIG_SECRET);
  }, CASE_BUDGET_MS);

  it("21. §7 · args_hash is post-redaction: two calls differing only in a redacted field share one approval row — twin: differing in a visible field, they do not (case 5)", async () => {
    const fixture = await seedFixture();

    const first = await accountCall(fixture, { ...ARGS, token: ARG_SECRET });
    const second = await accountCall(fixture, { ...ARGS, token: "FAKE0000-a-different-secret" });

    expect(approvalIdOf(second), "two secrets, one masked binding").toBe(approvalIdOf(first));
    expect(await approvalRows(fixture)).toHaveLength(1);
    // Not by inference: the stored hash is the digest of the canonical POST-redaction JSON,
    // recomputed here rather than read back from the code that wrote it.
    const id = approvalIdOf(first);
    expect(await storedHash(id)).toBe(await sha256Hex(canonicalJson(await storedArgs(id))));
  }, CASE_BUDGET_MS);

  it("22. §7 · a tool absent from the cached catalog is refused -32001 — the same code as ungranted and unknown, with no pending row created; twin: the catalogued tool opens one (case 1)", async () => {
    const fixture = await seedFixture();

    // Declared by the role (so the filter admits it) and absent from the catalog: the one
    // way to reach the no-redaction-map refusal at all.
    const missing = await accountCall(fixture, ARGS, {}, PHANTOM_TOOL);

    expect(missing.body.error?.code).toBe(-32001);
    expect(await approvalRows(fixture), "no schema, no row").toEqual([]);
    expect(servedCalls(fixture, PHANTOM_TOOL)).toBe(0);

    // The twin, one column different: the catalogued tool opens a pending.
    expect((await accountCall(fixture)).body.error?.code).toBe(-32003);
    expect(await approvalRows(fixture)).toHaveLength(1);
  }, CASE_BUDGET_MS);

  // Why the fixture registers for real and takes the CATALOG cold rather than skipping the
  // socket: a service that has never held one has an empty `roles_json` (declared roles are
  // written only by registration), so the granted `reader` resolves to the empty pattern set
  // and §7 step 3's filter answers -32001 first — the ordering would be unobservable, and
  // that world is order.table's "granted-undeclared role → -32001" already.
  //
  // Why the answer is -32000: §7 orders known availability ahead of the step-2 catalog rule
  // ("The gate consults known availability first … before any approval row is read, created,
  // or consumed"), so a cold catalog plus a gone socket must answer -32000 and never case
  // 22's catalog-miss -32001. Case 12's warm-catalog road cannot show it: with a warm catalog
  // either ordering yields -32000.
  //
  // One case and not two, because the healing half closes the arc: the same refusal that
  // created no row is followed by the IDENTICAL call opening one.
  it("23. §7 · availability outranks the catalog: a service that registered `reader` but served an EMPTY catalog and then went offline is refused -32000 — never case 22's -32001 — with no approval row created · then it reconnects serving the catalog and the IDENTICAL call opens a pending -32003 carrying an approvalId — exactly one row, and the service still executed nothing", async () => {
    // The cold road: a REAL registration writes `roles_json` (so the filter admits the
    // call), the catalog it serves is empty, and only then does the socket go away.
    const fixture = await seedUnconnected();
    await dial(fixture, []);
    await untilStatus(fixture.service.id, "online");
    const session = await seedOwnerSession(fixture.ns.owner);
    const listed = await rpc(fixture, session.token, SERVICE_SLUG, {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method: "tools/list",
      params: {},
    });
    // The precondition the case rests on, read through the hub itself and off the OWNER's
    // unfiltered view: with a warm catalog both orderings answer -32000 and the claim below
    // would be vacuous — that world is case 12.
    expect((listed.body.result as { tools: Tool[] }).tools, "the catalog was not cold").toEqual([]);
    await goOffline(fixture);

    const refused = await accountCall(fixture);

    expect(refused.body.error?.code, "the catalog check answered ahead of availability").toBe(-32000);
    expect(await approvalRows(fixture), "no row was read, created or consumed").toEqual([]);

    // The healing half: the service returns with its catalog and the IDENTICAL call — same
    // account, same arguments, only the world between them changed — opens the pending the
    // refusal never created.
    await goOnline(fixture);
    const gated = await accountCall(fixture);

    expect(gated.body.error?.code).toBe(-32003);
    expect((await approvalRow(fixture, approvalIdOf(gated))).status).toBe("pending");
    expect(await approvalRows(fixture), "exactly one row").toHaveLength(1);
    expect(servedCalls(fixture), "the service still executed nothing").toBe(0);
  }, CASE_BUDGET_MS);
});
