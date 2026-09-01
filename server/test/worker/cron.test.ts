// cron.test.ts — the daily janitor (§15, §7): one scheduled run, three legs, one
// `cron.swept` audit row. This suite pins that a single invocation produces ALL of the
// legs' effects, that a leg which throws never starves its siblings (the legs run as a
// named list under Promise.allSettled — structural, not by promise), that every run is
// observable through the /audit page because it writes exactly one `cron.swept` row, and
// that request paths never do any of this work themselves.
//
// Honesty, stated up front and repeated in the case that needs it: NOTHING here proves the
// cron fires daily. workerd has no scheduler; `scheduled()` is invoked directly. The one
// case touching the schedule asserts that the wrangler cron expression equals the expected
// constant — a configuration check, deliberately labelled as such. That a trigger actually
// fires is answered in production by the `cron.swept` rows themselves (§10's "passively,
// forever"), never by this file.
//
// Project: `worker` — real D1, every sibling real, no sockets: `createScheduledController`
// + `worker.scheduled` from the entry module. Time is INJECTED, never faked: rows are
// planted at ages expressed against the window each leg enforces (limits.ts names, the
// injected ApprovalsConfig.now clock), so "7 d → 14 d" is a one-line edit in limits.ts
// with zero churn here. No case reads a literal age, and no case asserts an audit `detail`
// layout — §7 puts both on the incidental side, which is why legOutcome exists.
//
// Ordering: every case seeds and runs within itself. The exactly-once law (a second run
// writes no second approval.expired row) is one case running twice, never two cases
// relying on each other's residue.

// deps: harness/seed · harness/fake-upstream · src/index (default.scheduled, sweep, Env) · src/approvals · src/audit (HUB_NAMESPACE, query, record) · src/upstream · src/limits · cloudflare:test createScheduledController · applyD1Migrations

import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// The wrangler config as TEXT, so case 13 reads the schedule the platform is actually
// configured with rather than a transcription of it. `?raw` is Vite's; TypeScript has no
// declaration for the query, and adding an ambient one for a single string is more
// machinery than the string is worth.
// @ts-ignore — Vite `?raw` import, see above.
import wranglerSource from "../../../wrangler.jsonc?raw";
import { Approvals } from "../../src/approvals";
import { HUB_NAMESPACE, query, record, resolveAuditConfig } from "../../src/audit";
import type { AuditEntry, AuditQuery, AuditRow } from "../../src/audit";
import { requireOwnerSession } from "../../src/identity";
import worker, { CRON_LEG_NAMES, cronLegs, sweep as hubSweep } from "../../src/index";
import type { CronLeg as WiredLeg, Env } from "../../src/index";
import {
  APPROVAL_WINDOW_MS,
  OAUTH_STATE_TTL_MS,
  RETENTION_DAYS,
} from "../../src/limits";
import { Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { beginConnect, handleCallback, setHeaders } from "../../src/upstream";
import { upstreamUrlFor } from "../harness/fake-upstream";
import type { AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededSession } from "../harness/seed";

/** The legs, named exactly as the composition root's named list names them (§15). */
export type CronLeg = "approvals.sweepExpired" | "audit.prune" | "upstream.cleanupStaleState";

/**
 * The window a leg takes its decision against, by its limits.ts export name — so the table
 * says WHICH constant governs a row without ever transcribing its value.
 */
export type WindowName = "RETENTION_DAYS" | "APPROVAL_WINDOW_MS" | "OAUTH_STATE_TTL_MS";

/**
 * One row of the cron leg table. The unit is a leg EFFECT, not a leg: `approvals.
 * sweepExpired` does two separable things (flip past-expiry pending rows to expired, then
 * prune past retention) and each gets its own row, because each answers to its own window.
 *
 * `fixtures` is what makes every row carry its own allow-twin (§9 rule 2): a leg is only
 * pinned when rows on BOTH sides of the window are planted — a janitor that deletes
 * everything satisfies a past-side-only oracle perfectly.
 *
 * `observedVia` names the public seam the effect is read back through. Deliberately never
 * a table read: §7 puts SQL and columns on the incidental side, so the assertion survives
 * a schema rewrite.
 */
export type CronLegRow = {
  /** Spec sentence transcribed, printed in the test name (§8). */
  spec: string;
  /** Case title in the doc's convention, appended after `spec`. */
  title: string;
  leg: CronLeg;
  effect: "expire" | "prune" | "drop-stale";
  window: WindowName;
  /**
   * How the seed plants: `namespaces` separate owners, each holding `pastWindow` rows past
   * the window and `insideWindow` rows inside it. Neither side is ever zero, and neither is
   * `namespaces`: the leg's reported count is hub-wide, so it must be
   * `namespaces × pastWindow` — a number a single-namespace fixture cannot produce.
   */
  fixtures: { namespaces: number; pastWindow: number; insideWindow: number };
  /** Audit events the leg itself writes per affected row, beyond the run's single cron.swept row. */
  auditEvents: string[];
  /** The public seam the runner reads the effect back through. */
  observedVia: "approvals.list" | "audit.query" | "upstream.handleCallback rejects";
};

/**
 * The leg table. Rows are OWNER-AUTHORED in a separate commit before implementation
 * (strategy §9 rule 1) — agents write the type and the runner, never the rows.
 */
export const CRON_LEG_ROWS: readonly CronLegRow[] = [
  // Four rows over three legs, because the unit is an EFFECT: approvals.sweepExpired
  // answers to two different windows (a pending row expires an hour out; any approval row
  // is pruned a week out) and a table that gave it one row would let either half rot
  // unnoticed behind the other's count.
  //
  // Three conventions, so no row repeats them:
  // · `fixtures` is 2/2 everywhere. Two on each side, never one: a single past-window row
  //   makes "acted on N rows" indistinguishable from "acted on the first row it found",
  //   and a single inside-window row makes the survivor look like an off-by-one rather
  //   than a rule. The counts are what `legOutcome` is compared against, so they are the
  //   row's real assertion, not decoration.
  // · Every row spans TWO namespaces, and the count it asserts is the hub-wide 4. All
  //   three legs are namespace-blind by signature — `approvals.sweepExpired()` takes no
  //   owner and prunes `WHERE created_at < ?`, `audit.prune(db, config)` the same,
  //   `upstream.cleanupStaleState()` likewise — which is what §15's "a daily cron trigger
  //   prunes audit and approval rows past the retention window" describes: one trigger,
  //   no namespace parameter anywhere in it. A single-namespace fixture is exactly what
  //   makes hub-wide and per-namespace INDISTINGUISHABLE, so an implementation that
  //   scoped a leg to the first owner it found — or that iterated owners and stopped
  //   early — would pass every row while leaving every other namespace's recorded call
  //   bodies readable through `audit_query` forever (§10 names that as the failure the
  //   prune leg exists to prevent). Two namespaces cost one seeding line and are the only
  //   thing that can catch it.
  // · Every audit row a scheduled run writes — each leg's own events and the run's single
  //   `cron.swept` row alike — carries the principal `hub`: the machine principal
  //   approvals.ts already writes for lazy expiry, and the fifth member §5's enumerated
  //   `principal` comment ('user:<name>' | 'agent:<slug>' | 'app:<slug>' | 'bootstrap') gains
  //   for it. Unpinned, a cron row can land under `""`, `system`, or — worst — the owner's
  //   own `user:<name>`, which forges owner attribution for a machine action in the very
  //   ledger the owner reads to audit themselves.

  // §7's own sentence about the cron, which is also the sentence that makes the leg a
  // janitor rather than the enforcement: lazy expiry has already flipped everything anyone
  // READ, so what remains here is what nobody looked at.
  {
    spec:
      "The daily cron (§15) additionally sweeps remaining past-expiry `pending` rows to `expired` (same audit row) before pruning; there is no hourly job.",
    title:
      "a pending approval past limits.APPROVAL_WINDOW_MS that nothing ever read is flipped to expired by the run itself · one inside the window is left pending",
    leg: "approvals.sweepExpired",
    effect: "expire",
    window: "APPROVAL_WINDOW_MS",
    fixtures: { namespaces: 2, pastWindow: 2, insideWindow: 2 },
    // §7: "Every transition writes an audit row" — and exactly once, which is why the
    // exactly-once law is its own two-run case rather than a column here.
    auditEvents: ["approval.expired"],
    observedVia: "approvals.list",
  },
  // §15: "Every persisted body (approval `args_json`, the audit body columns) is
  // post-redaction and pruned by the same daily cron as audit." The approval half of the
  // retention guard — approval rows hold stored arguments, so they age out on audit's
  // schedule and not on the approval window's.
  //
  // The fixtures on the past side are DECIDED rows (approved/rejected), not pending ones:
  // past-retention is also past-expiry, so pending fixtures here would be flipped by the
  // row above before this row's leg ever saw them, and the two effects' counts would
  // confound. Deciding them isolates the prune.
  {
    spec:
      "Every persisted body (approval `args_json`, the audit body columns) is post-redaction and pruned by the same daily cron as audit.",
    title:
      "approval rows past limits.RETENTION_DAYS are deleted, arguments and all · rows inside the window survive with their bodies intact",
    leg: "approvals.sweepExpired",
    effect: "prune",
    window: "RETENTION_DAYS",
    fixtures: { namespaces: 2, pastWindow: 2, insideWindow: 2 },
    // A prune writes nothing per row: the deletion IS the record, and a per-row audit
    // event would re-persist what retention exists to remove.
    auditEvents: [],
    observedVia: "approvals.list",
  },
  // §15's retention sentence proper. Strategy §10 states the stakes plainly: "since bodies
  // landed in audit under the 7-day retention, the prune leg is a GUARD: a dead cron
  // leaves recorded call bodies readable via audit_query indefinitely."
  {
    spec:
      "Retention: a daily cron trigger prunes audit and approval rows past the retention window — default 7 days, `AUDIT_RETENTION_DAYS` env var overrides.",
    title:
      "audit rows past the retention window in force are deleted — the prune is the GUARD on body exposure, not housekeeping · rows inside it stay queryable",
    leg: "audit.prune",
    effect: "prune",
    window: "RETENTION_DAYS",
    fixtures: { namespaces: 2, pastWindow: 2, insideWindow: 2 },
    auditEvents: [],
    observedVia: "audit.query",
  },
  // §7's connect flow. The honest framing, repeated in the case that owns it: a past-TTL
  // state row was ALREADY dead to the callback before this leg ran (the callback treats
  // expiry as its own business), so what the sweep buys is a table that does not grow
  // forever — hygiene, not the CSRF defense.
  //
  // Which is exactly why this row's `observedVia` cannot carry it alone: the callback
  // answers identically whether the row was deleted or merely expired-in-place, so it
  // witnesses the TTL, never the deletion. `legOutcome`'s count cannot stand in for it
  // either — a count is the implementation's own self-report, and a `cleanupStaleState`
  // that ran `SELECT COUNT(*) … WHERE expires_at < ?` and deleted nothing would satisfy
  // this row, both its twins, and the leg-isolation re-run while the table grows forever.
  // The runner's idempotence law is this row's real witness (see runCronLegRow): a second
  // clean run reports 0, which only a leg that actually removed the rows can produce.
  {
    spec:
      "Connect initiation mints a one-time unguessable `state`, stored server-side bound to {owner, app, expected AS issuer + token endpoint, PKCE verifier} and to the initiating cookie session, expiring in ~10 minutes.",
    title:
      "upstream-OAuth state rows past limits.OAUTH_STATE_TTL_MS are dropped by the run · a row still inside its TTL survives and still redeems (hygiene, never the defense)",
    leg: "upstream.cleanupStaleState",
    effect: "drop-stale",
    window: "OAUTH_STATE_TTL_MS",
    fixtures: { namespaces: 2, pastWindow: 2, insideWindow: 2 },
    auditEvents: [],
    observedVia: "upstream.handleCallback rejects",
  },
];

/**
 * The one reader of the `cron.swept` row's shape. The per-leg outcome layout inside
 * `detail` is incidental (§7) — so exactly one function knows it, and a layout change is a
 * one-line edit rather than a sweep through the suite. Answers whether the run reports
 * this leg as having succeeded, and how many rows it says it touched; `null` means the row
 * does not mention the leg at all, which is itself a failure worth naming distinctly from
 * "reported failed".
 *
 * Takes the ENTRY, deliberately, and not a namespace to query it from: which owner a
 * hub-wide `cron.swept` row is attributed to is an open spec question (`audit.owner_id` is
 * NOT NULL and every read is owner-scoped by parameter, so a two-namespace hub forces
 * either "one row, invisible to the second owner's /audit" or "one row per owner" — cases
 * 7 and 10 below name both halves and no spec line decides between them). No row of this
 * table may depend on that answer, so the runner hands this function the swept entry it
 * found rather than the one a namespace-scoped query returned.
 */
export function legOutcome(entry: AuditEntry, leg: CronLeg): { ok: boolean; count: number } | null {
  // deps: none
  const legs = entry.detail?.legs as Record<string, { ok: boolean; count: number }> | undefined;
  return legs?.[leg] ?? null;
}

/**
 * The table runner: plants `row.fixtures` on both sides of `row.window` in EACH of its
 * namespaces against the injected clock, fires one scheduled run, then asserts through
 * `row.observedVia` that every past-window fixture in every namespace was acted on and
 * every inside-window fixture survived, that the leg's own audit events were written once
 * per affected row, and that `legOutcome` reports the leg with the matching hub-wide count.
 *
 * Three laws every row runs under, because each is a property of every leg and none is a
 * column a row could sensibly set to false:
 *
 *  · LEG ISOLATION. Each row runs a second time with its leg forced to reject, asserting
 *    the OTHER legs' effects still landed and the swept row records the failure.
 *  · IDEMPOTENCE AS THE DELETION WITNESS. Each row also runs a second CLEAN run over the
 *    same fixtures, which must report the leg's count as 0. Every leg's count is otherwise
 *    the implementation's own self-report — the number a leg that counted its rows and
 *    deleted none would report just as happily — and for the stale-state leg the count is
 *    the ONLY witness there is, since the callback is by construction blind to the
 *    difference between a row deleted and a row merely past its TTL (upstream.ts's own
 *    contract sentence). A second run that still reports work to do is a leg that did
 *    none. It needs no SQL read, so §7's "the table is incidental" holds.
 *  · THE MACHINE PRINCIPAL. Every audit row the run writes — the legs' own events and the
 *    single `cron.swept` row alike — carries principal `hub` (see the row-set conventions).
 */
export async function runCronLegRow(row: CronLegRow): Promise<void> {
  // deps: harness/seed · src/index (default.scheduled) · cloudflare:test createScheduledController · legOutcome
  const expectedPast = row.fixtures.namespaces * row.fixtures.pastWindow;
  const expectedInside = row.fixtures.namespaces * row.fixtures.insideWindow;
  const fixture = await plant(row);
  // A leg the row does NOT own, planted beside it: when this row's leg is forced to reject
  // below, the canary is what says the siblings still ran — an `ok: true` in the swept row
  // is a self-report, and a canary that vanished is an effect.
  const canary = await plantCanary(row.leg);

  // LAW 1 — LEG ISOLATION, taken first, on the row's own fixtures: with this leg rejecting,
  // a SIBLING's effect must still have landed. Read through the canary and not through
  // `fixture.observe`, which is deliberately not consulted here — two of the four seams are
  // themselves stateful (approvals.list applies lazy expiry, a callback consumes its state
  // row), so observing at this point would perform the very effect it was asking about.
  await sweep(rejecting(row.leg));
  const isolated = await sweptRow();
  expect(legOutcome(isolated, row.leg), `${row.title}: the swept row must name the failed leg`)
    .toEqual({ ok: false, count: 0 });
  for (const sibling of CRON_LEG_NAMES.filter((name) => name !== row.leg)) {
    expect(legOutcome(isolated, sibling)?.ok, `${row.title}: ${sibling} was starved`).toBe(true);
  }
  expect(await canary.landed(), `${row.title}: a sibling leg's effect never landed`).toBe(true);

  // The real run — over fixtures the failed run above left exactly as planted.
  await sweep();
  const swept = await sweptRow();
  const legEvents = await fixture.legEvents();
  const seen = await fixture.observe();
  expect(seen.actedOn, `${row.title}: past-window fixtures left unswept`).toBe(expectedPast);
  expect(seen.survived, `${row.title}: inside-window fixtures were swept anyway`).toBe(expectedInside);
  expect(legEvents, `${row.title}: one audit event per affected row`).toBe(
    expectedPast * row.auditEvents.length,
  );
  expect(legOutcome(swept, row.leg), `${row.title}: the swept row's count is hub-wide`).toEqual({
    ok: true,
    count: expectedPast,
  });

  // LAW 2 — IDEMPOTENCE AS THE DELETION WITNESS. A second clean run over the same fixtures
  // has nothing left to do; a leg that counted rows without removing them says otherwise.
  await sweep();
  expect(
    legOutcome(await sweptRow(), row.leg)?.count,
    `${row.title}: a second run still found work — the leg counts but does not sweep`,
  ).toBe(0);
}

// ── the run, and the row it leaves ────────────────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** How far past a window a "past" fixture is planted. Expressed against the window itself
 *  everywhere it is used, so no case carries an age. */
const PAST_MARGIN_MS = 60_000;

/** Retention is configured in DAYS; every timestamp in the system is epoch ms. A unit
 *  conversion, not a window — the window itself is always a limits.ts name. */
const DAY_MS = 24 * 60 * 60_000;

/** Long enough for a row that seeds two namespaces, drives eight OAuth flows and runs the
 *  sweep three times; short enough that a hang is a failure rather than a wait. */
const CASE_BUDGET_MS = 120_000;

/**
 * One sweep, entered where the case needs it. With no legs to bend it goes through the
 * PLATFORM entrypoint, called with exactly the arguments workerd calls it with — so the
 * handler is exercised by most of this file rather than by a case of its own. With legs it
 * calls the fan-out directly, which is where the seam lives: `scheduled` is a one-line
 * adapter over `sweep`, so it has no seam to bend and no fabricated ExecutionContext is
 * needed to reach past one.
 */
async function sweep(legs?: readonly WiredLeg[], overrides: Partial<Env> = {}): Promise<void> {
  const bindings = { ...(env as unknown as Env), ...overrides };
  if (legs === undefined) {
    await worker.scheduled(
      createScheduledController({ scheduledTime: new Date(), cron: EXPECTED_CRON }),
      bindings,
    );
    return;
  }
  await hubSweep(bindings, legs);
}

/** The real list with one leg replaced by a rejecting one — everything else stays real, so
 *  "never starves its siblings" is asserted against the siblings themselves. */
function rejecting(leg: CronLeg): readonly WiredLeg[] {
  const bindings = env as unknown as Env;
  // Built from the composition root's own list under the composition root's own resolved
  // config, so the siblings a case watches are the production legs and not lookalikes.
  return cronLegs(bindings, resolveAuditConfig(bindings)).map((wired) =>
    wired.leg === leg
      ? { leg: wired.leg, run: () => Promise.reject(new Error("forced leg failure")) }
      : wired,
  );
}

/** The newest `cron.swept` row, read back through the public seam the /audit page uses. */
async function sweptRow(): Promise<AuditRow> {
  const { rows } = await query(env.DB, HUB_NAMESPACE, { event: "cron.swept", limit: 1 });
  if (rows.length === 0) throw new Error("the scheduled run wrote no cron.swept row");
  return rows[0];
}

/**
 * How many `cron.swept` rows exist right now. Storage isolation is per FILE, so every count
 * in this suite is read as a DELTA around the run it is about — an absolute would be a
 * statement about how many cases ran before this one.
 */
async function sweptCount(since?: number): Promise<number> {
  return (await query(env.DB, HUB_NAMESPACE, { event: "cron.swept", since, limit: 1 })).total;
}

// ── planting, one driver per leg EFFECT ───────────────────────────────────────────────

/**
 * What a planted row set answers afterwards. `observe` reads the effect back through the
 * row's `observedVia` seam; `legEvents` counts the leg's own audit events across every
 * namespace planted, because the count the table states is hub-wide.
 */
type Fixture = {
  observe(): Promise<{ actedOn: number; survived: number }>;
  legEvents(): Promise<number>;
};

function plant(row: CronLegRow): Promise<Fixture> {
  const { namespaces, pastWindow, insideWindow } = row.fixtures;
  if (row.leg === "approvals.sweepExpired" && row.effect === "expire") {
    return plantPendingApprovals(namespaces, pastWindow, insideWindow);
  }
  if (row.leg === "approvals.sweepExpired") {
    return plantDecidedApprovals(namespaces, pastWindow, insideWindow);
  }
  if (row.leg === "audit.prune") return plantAuditRows(namespaces, pastWindow, insideWindow);
  return plantStateRows(namespaces, pastWindow, insideWindow);
}

/** The APPROVAL_WINDOW_MS effect: pending rows nobody ever read. */
async function plantPendingApprovals(
  namespaces: number,
  past: number,
  inside: number,
): Promise<Fixture> {
  const plots: { ownerId: string; past: string[]; inside: string[] }[] = [];
  for (let n = 0; n < namespaces; n++) {
    const world = await seedApprovalWorld();
    const pastIds = await request(world, () => Date.now() - APPROVAL_WINDOW_MS - PAST_MARGIN_MS, past);
    const insideIds = await request(world, Date.now, inside);
    plots.push({ ownerId: world.ns.owner.userId, past: pastIds, inside: insideIds });
  }
  return {
    // Read AFTER legEvents by every caller: `approvals.list` applies lazy expiry itself, so
    // it can never witness who flipped a row — the audit events can, and the idempotence
    // law finishes the job.
    async observe() {
      let actedOn = 0;
      let survived = 0;
      for (const plot of plots) {
        const rows = new Map(
          (await approvalsAt(Date.now).list(plot.ownerId)).map((row) => [row.id, row.status]),
        );
        actedOn += plot.past.filter((id) => rows.get(id) === "expired").length;
        survived += plot.inside.filter((id) => rows.get(id) === "pending").length;
      }
      return { actedOn, survived };
    },
    legEvents: () => countEvents(plots, { event: "approval.expired" }),
  };
}

/** The RETENTION_DAYS effect on approvals: DECIDED rows, so the flip above cannot confound
 *  the prune's count (a past-retention row is also past-expiry). */
async function plantDecidedApprovals(
  namespaces: number,
  past: number,
  inside: number,
): Promise<Fixture> {
  const plots: { ownerId: string; past: string[]; inside: string[] }[] = [];
  for (let n = 0; n < namespaces; n++) {
    const world = await seedApprovalWorld();
    const backdated = () => Date.now() - RETENTION_DAYS * DAY_MS - PAST_MARGIN_MS;
    const pastIds = await request(world, backdated, past);
    // Decided at the same instant they were created, so the row is live when the owner acts
    // on it — the production path to a decided row, with only the clock moved.
    for (const id of pastIds) await approvalsAt(backdated).decide(world.ns.owner.userId, id, "approve");
    const insideIds = await request(world, Date.now, inside);
    for (const id of insideIds) await approvalsAt(Date.now).decide(world.ns.owner.userId, id, "approve");
    plots.push({ ownerId: world.ns.owner.userId, past: pastIds, inside: insideIds });
  }
  return {
    async observe() {
      let actedOn = 0;
      let survived = 0;
      for (const plot of plots) {
        const rows = new Map(
          (await approvalsAt(Date.now).list(plot.ownerId)).map((row) => [row.id, row]),
        );
        actedOn += plot.past.filter((id) => !rows.has(id)).length;
        // "with their bodies intact": a surviving row still carries the arguments it was
        // created with, or the prune has quietly become a redaction.
        survived += plot.inside.filter(
          (id) => rows.get(id)?.args.query === APPROVAL_ARGS.query,
        ).length;
      }
      return { actedOn, survived };
    },
    legEvents: async () => 0,
  };
}

/** The RETENTION_DAYS effect on the ledger itself. Rows are WRITTEN by audit.record and then
 *  aged in place — the same shape seedToken's expired mint uses: production path, moved clock. */
async function plantAuditRows(namespaces: number, past: number, inside: number): Promise<Fixture> {
  const plots: { ownerId: string; past: string[]; inside: string[] }[] = [];
  for (let n = 0; n < namespaces; n++) {
    const ns = await seedNamespace(env.DB, {});
    const plot = { ownerId: ns.owner.userId, past: [] as string[], inside: [] as string[] };
    for (let k = 0; k < past; k++) plot.past.push(await recordMarked(plot.ownerId, "past"));
    for (let k = 0; k < inside; k++) plot.inside.push(await recordMarked(plot.ownerId, "inside"));
    for (const tool of plot.past) await ageAuditRow(tool);
    plots.push(plot);
  }
  return {
    async observe() {
      let actedOn = 0;
      let survived = 0;
      for (const plot of plots) {
        for (const tool of plot.past) if ((await countRows(plot.ownerId, { tool })) === 0) actedOn++;
        for (const tool of plot.inside) if ((await countRows(plot.ownerId, { tool })) === 1) survived++;
      }
      return { actedOn, survived };
    },
    legEvents: async () => 0,
  };
}

/** The OAUTH_STATE_TTL_MS effect: real connect flows, half of them aged past their TTL. */
async function plantStateRows(namespaces: number, past: number, inside: number): Promise<Fixture> {
  const plots: { past: Started[]; inside: Started[] }[] = [];
  for (let n = 0; n < namespaces; n++) {
    const world = await seedOAuthWorld();
    const plot = { past: [] as Started[], inside: [] as Started[] };
    for (let k = 0; k < past; k++) plot.past.push(await beginState(world));
    for (let k = 0; k < inside; k++) plot.inside.push(await beginState(world));
    for (const started of plot.past) await ageStateRow(started.state);
    plots.push(plot);
  }
  return {
    // The honest observation, as this row's own comment states: the callback is blind to the
    // difference between a row deleted and a row merely past its TTL, so what it witnesses
    // is the TTL. The deletion's witness is the runner's idempotence law.
    async observe() {
      let actedOn = 0;
      let survived = 0;
      for (const plot of plots) {
        for (const started of plot.past) if ((await redeem(started)).status === 400) actedOn++;
        for (const started of plot.inside) if ((await redeem(started)).status === 302) survived++;
      }
      return { actedOn, survived };
    },
    legEvents: async () => 0,
  };
}

// ── the canary: a leg this row does not own, so isolation is an EFFECT and not a report ──

/** Something a sibling leg must still do while `failing` is forced to reject. */
async function plantCanary(failing: CronLeg): Promise<{ landed(): Promise<boolean> }> {
  if (failing !== "audit.prune") {
    const ns = await seedNamespace(env.DB, {});
    const tool = await recordMarked(ns.owner.userId, "canary");
    await ageAuditRow(tool);
    return { landed: async () => (await countRows(ns.owner.userId, { tool })) === 0 };
  }
  // audit.prune is the failing leg, so the canary has to belong to another one: a pending
  // approval nobody read, whose flip leaves an `approval.expired` row that this run's broken
  // prune cannot have removed.
  const world = await seedApprovalWorld();
  await request(world, () => Date.now() - APPROVAL_WINDOW_MS - PAST_MARGIN_MS, 1);
  return {
    landed: async () =>
      (await countRows(world.ns.owner.userId, { event: "approval.expired" })) === 1,
  };
}

// ── the seams the drivers plant through ───────────────────────────────────────────────

/** An Approvals wired exactly as the composition root wires it, on the injected clock that
 *  is this suite's only way to plant a row at an age (§16's constants discipline). */
function approvalsAt(now: () => number, retentionDays = RETENTION_DAYS): Approvals {
  return new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    retentionDays,
    now,
    // No transport: a sweep fixture must not depend on a push service answering.
  });
}

/** A namespace with one proxied app and one agent — the least a pending
 *  approval row needs to exist at all. */
type ApprovalWorld = { ns: SeededNamespace; app: App; principal: Principal };

/** The agent principal an approval is bound to (approvals refuses an owner). */
type Principal = Parameters<Approvals["check"]>[0];

const APPROVAL_TOOL = "search";
const APPROVAL_ARGS = { query: "quarterly report" };

async function seedApprovalWorld(): Promise<ApprovalWorld> {
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "notion",
        kind: "proxy",
        upstreamUrl: upstreamUrlFor({ id: uniqueSlug("up"), mode: { kind: "ok" } }),
      },
    ],
    agents: [{ slug: "agent" }],
  });
  const app = await new Registry(env.DB).getApp(ns.owner.userId, "notion");
  if (app === null) throw new Error("seedApprovalWorld: the seeded app vanished");
  return {
    ns,
    app,
    principal: {
      kind: "agent",
      agentId: ns.agents.agent.id,
      ownerId: ns.owner.userId,
      slug: "agent",
    },
  };
}

/** `count` distinct pending rows through the production gate, at the given instant. Distinct
 *  arguments are what make them distinct rows: the binding is (agent, app, tool, hash). */
async function request(world: ApprovalWorld, now: () => number, count: number): Promise<string[]> {
  const gate = approvalsAt(now);
  const ids: string[] = [];
  for (let k = 0; k < count; k++) {
    const verdict = await gate.check(
      world.principal,
      world.app,
      APPROVAL_TOOL,
      { ...APPROVAL_ARGS, page: `${uniqueSlug("p")}` },
      [],
    );
    ids.push(verdict.approvalId);
  }
  return ids;
}

/** One audit row with a unique `tool`, so the row can be found again without reading its id
 *  out of a column no reader is supposed to know about. */
async function recordMarked(ownerId: string, kind: string): Promise<string> {
  const tool = uniqueSlug(kind);
  await record(env.DB, {
    ownerId,
    principal: "agent:agent",
    event: "tools/call",
    app: "notion",
    tool,
    outcome: "ok",
  });
  return tool;
}

/** Age one planted audit row past the retention window IN FORCE — the window by NAME, and
 *  applied to the row rather than to a clock, so the leg still has to find it. */
async function ageAuditRow(tool: string, retentionDays = RETENTION_DAYS): Promise<void> {
  await d1()
    .prepare(`UPDATE audit SET ts = ? WHERE tool = ?`)
    .bind(Date.now() - retentionDays * DAY_MS - PAST_MARGIN_MS, tool)
    .run();
}

/** Age one live state row past limits.OAUTH_STATE_TTL_MS, leaving it in the table. */
async function ageStateRow(state: string): Promise<void> {
  const past = Date.now() - OAUTH_STATE_TTL_MS - PAST_MARGIN_MS;
  await d1()
    .prepare(`UPDATE upstream_oauth_state SET created_at = ?, expires_at = ? WHERE state = ?`)
    .bind(past - OAUTH_STATE_TTL_MS, past, state)
    .run();
}

/** A namespace whose one app connects through OAuth, plus the owner session every
 *  connect flow is bound to. */
type OAuthWorld = { ns: SeededNamespace; app: App; session: SeededSession; sessionId: string };

async function seedOAuthWorld(): Promise<OAuthWorld> {
  const as: AsScenario = { id: uniqueSlug("as") };
  const upstream: UpstreamScenario = { id: uniqueSlug("up"), mode: { kind: "ok" }, as };
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "notion",
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "oauth",
      },
    ],
  });
  const app = await new Registry(env.DB).getApp(ns.owner.userId, "notion");
  if (app === null) throw new Error("seedOAuthWorld: the seeded app vanished");
  const session = await seedOwnerSession(ns.owner);
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}/apps`, { headers: { Cookie: session.cookie } }),
  );
  return { ns, app, session, sessionId };
}

/** A connect flow carried to the AS's own redirect and left there — one state row, and the
 *  callback URL the owner's browser would have been sent to. */
type Started = { state: string; callbackUrl: string; cookie: string };

async function beginState(world: OAuthWorld): Promise<Started> {
  const authorize = await beginConnect(world.app, { id: world.sessionId });
  const redirect = await fetch(authorize.toString(), { redirect: "manual" });
  const callbackUrl = redirect.headers.get("Location");
  if (callbackUrl === null) throw new Error("beginState: the fake AS answered no redirect");
  return {
    state: authorize.searchParams.get("state") ?? "",
    callbackUrl,
    cookie: world.session.cookie,
  };
}

/** The owner's browser arriving back at the callback — 302 redeemed, 400 refused. */
function redeem(started: Started): Promise<Response> {
  return handleCallback(new Request(started.callbackUrl, { headers: { Cookie: started.cookie } }));
}

// ── reading the ledger back ───────────────────────────────────────────────────────────

/** The raw binding, for the two writes no seam has: aging a planted row in place. */
function d1(): D1Like {
  return env.DB as D1Like;
}

async function countRows(ownerId: string, filters: AuditQuery): Promise<number> {
  return (await query(env.DB, ownerId, { ...filters, limit: 1 })).total;
}

/** A count over every namespace a row planted — the leg's reach is hub-wide, so a per-owner
 *  read would be satisfied by a leg that stopped at the first owner it found. */
async function countEvents(
  plots: { ownerId: string }[],
  filters: AuditQuery,
): Promise<number> {
  let total = 0;
  for (const plot of plots) total += await countRows(plot.ownerId, filters);
  return total;
}

/**
 * The daily expression this suite expects wrangler to be configured with. An ORACLE, not a
 * derived value: it is transcribed here so case 13 compares two independent statements of
 * the schedule rather than one statement with itself.
 */
const EXPECTED_CRON = "0 4 * * *";

describe("§15 · the cron leg table", () => {
  for (const row of CRON_LEG_ROWS) {
    it(`1. §15 · ${row.spec} · ${row.title}`, () => runCronLegRow(row), CASE_BUDGET_MS);
  }

  it("2. §15 · every leg of the composition root's named list appears in at least one row — driven over the leg list itself, so a fourth leg cannot be added without a row", () => {
    for (const leg of CRON_LEG_NAMES) {
      expect(
        CRON_LEG_ROWS.some((row) => row.leg === leg),
        `${leg} is a leg of the sweep with no row of its own`,
      ).toBe(true);
    }
    // And nothing else: a row naming a leg the root does not run would pin a fiction.
    for (const row of CRON_LEG_ROWS) {
      expect(CRON_LEG_NAMES as readonly string[]).toContain(row.leg);
    }
  });
});

describe("§15 · one run, all three effects", () => {
  it("3. §15 · a single scheduled run flips past-expiry pending approvals, prunes past-retention audit and approval rows, and drops stale upstream-OAuth state — all from one invocation", async () => {
    const pending = await plantPendingApprovals(1, 1, 0);
    const decided = await plantDecidedApprovals(1, 1, 0);
    const ledger = await plantAuditRows(1, 1, 0);
    const state = await plantStateRows(1, 1, 0);

    const before = await sweptCount();
    await sweep();

    expect((await pending.observe()).actedOn, "the pending flip").toBe(1);
    expect((await decided.observe()).actedOn, "the approval prune").toBe(1);
    expect((await ledger.observe()).actedOn, "the audit prune").toBe(1);
    expect((await state.observe()).actedOn, "the stale-state drop").toBe(1);
    expect((await sweptCount()) - before, "one invocation, one heartbeat").toBe(1);
  }, CASE_BUDGET_MS);

  it("4. §7 · each flip writes exactly one approval.expired row · a second run over the same rows writes none (the exactly-once law, one case, two runs)", async () => {
    const world = await seedApprovalWorld();
    await request(world, () => Date.now() - APPROVAL_WINDOW_MS - PAST_MARGIN_MS, 2);

    await sweep();
    const afterFirst = await countRows(world.ns.owner.userId, { event: "approval.expired" });
    await sweep();
    const afterSecond = await countRows(world.ns.owner.userId, { event: "approval.expired" });

    expect(afterFirst, "one approval.expired per flipped row").toBe(2);
    expect(afterSecond, "a second run re-audits nothing").toBe(2);
  }, CASE_BUDGET_MS);

  it("5. §7 · the expiry sweep precedes the prune — a pending row past BOTH windows is audited expired before it is deleted, never silently dropped", async () => {
    const world = await seedApprovalWorld();
    // Past retention is necessarily past expiry too — the row this ordering exists for.
    const [id] = await request(world, () => Date.now() - RETENTION_DAYS * DAY_MS - PAST_MARGIN_MS, 1);

    await sweep();

    const remaining = await approvalsAt(Date.now).list(world.ns.owner.userId);
    expect(remaining.find((row) => row.id === id), "the row was pruned").toBeUndefined();
    expect(
      await countRows(world.ns.owner.userId, { event: "approval.expired" }),
      "…and its expiry was audited before it went",
    ).toBe(1);
  }, CASE_BUDGET_MS);

  it('6. §15 · a run over an empty namespace still completes and still writes its cron.swept row (the allow-twin of every "N rows were touched" case)', async () => {
    await seedNamespace(env.DB, {});

    const before = await sweptCount();
    await sweep();

    const swept = await sweptRow();
    expect((await sweptCount()) - before, "a run with nothing to do is still a run").toBe(1);
    for (const leg of CRON_LEG_NAMES) {
      expect(legOutcome(swept, leg), `${leg} over an empty hub`).toEqual({ ok: true, count: 0 });
    }
  }, CASE_BUDGET_MS);
});

describe("§15 · the run is observable", () => {
  it("7. §15 · every run writes exactly one cron.swept audit row, and it names every leg", async () => {
    const before = await sweptCount();
    await sweep();
    expect((await sweptCount()) - before).toBe(1);
    await sweep();
    expect((await sweptCount()) - before, "one row per run, and exactly one").toBe(2);

    const swept = await sweptRow();
    expect(swept.principal, "a machine action is never attributed to a human").toBe("hub");
    for (const leg of CRON_LEG_NAMES) {
      expect(legOutcome(swept, leg), `${leg} is missing from the swept row`).not.toBeNull();
    }
  }, CASE_BUDGET_MS);

  it("8. §15 · a leg that throws never starves its siblings: the other two effects are observable and the swept row reports that leg failed (legOutcome ok:false)", async () => {
    const pending = await plantPendingApprovals(1, 1, 0);
    const state = await plantStateRows(1, 1, 0);

    await sweep(rejecting("audit.prune"));

    const swept = await sweptRow();
    expect(legOutcome(swept, "audit.prune")?.ok, "the failed leg").toBe(false);
    expect((await pending.observe()).actedOn, "a sibling's effect still landed").toBe(1);
    expect((await state.observe()).actedOn, "and the other sibling's too").toBe(1);
    expect(swept.outcome, "a run with a failed leg is not an `ok` run").not.toBe("ok");
  }, CASE_BUDGET_MS);

  it("9. §15 · scheduled() resolves even when every leg rejects — the cron never throws into the platform, because a thrown cron is an invisible cron", async () => {
    const doomed = CRON_LEG_NAMES.map((leg) => ({
      leg,
      run: () => Promise.reject(new Error("forced leg failure")),
    }));

    await expect(sweep(doomed)).resolves.toBeUndefined();

    const swept = await sweptRow();
    for (const leg of CRON_LEG_NAMES) {
      expect(legOutcome(swept, leg), `${leg} after a total failure`).toEqual({ ok: false, count: 0 });
    }
  }, CASE_BUDGET_MS);

  it("10. §15 · the cron.swept row is itself queryable through audit_query — /audit is the cron's only monitoring, so an unqueryable row is no monitoring at all", async () => {
    // Through the same read path `audit_query` and the /audit page sit on, with the same
    // filters an operator would type — not a table read.
    const filters = { event: "cron.swept", principal: "hub" };
    const before = (await query(env.DB, HUB_NAMESPACE, filters)).total;
    await sweep();
    const filtered = await query(env.DB, HUB_NAMESPACE, filters);

    expect(filtered.total - before, "the heartbeat is unfindable by event").toBe(1);
    expect(filtered.rows[0].detail, "…and carries its per-leg outcomes").toBeDefined();
  }, CASE_BUDGET_MS);
});

describe("§15 · the windows are configuration, not literals", () => {
  it("11. §15 · retention comes from AUDIT_RETENTION_DAYS when the var is set and from limits.RETENTION_DAYS when it is not — parsed once at the composition root, so both runs differ only in what survives", async () => {
    const ns = await seedNamespace(env.DB, {});
    // Older than one day, younger than limits.RETENTION_DAYS: the only age at which the two
    // windows disagree, expressed against the constant rather than as a number of days.
    const between = await recordMarked(ns.owner.userId, "between");
    await ageAuditRow(between, 1);

    await sweep();
    const underDefault = await countRows(ns.owner.userId, { tool: between });
    await sweep(undefined, { AUDIT_RETENTION_DAYS: "1" });
    const underOverride = await countRows(ns.owner.userId, { tool: between });

    expect(underDefault, "limits.RETENTION_DAYS still covers this row").toBe(1);
    expect(underOverride, "the env override is what shortens the window").toBe(0);
  }, CASE_BUDGET_MS);

  it("12. §15 · request paths never prune: a tools/call made with past-retention rows present deletes nothing · the scheduled run that follows deletes them (the twin — proving the first assertion is about restraint, not about absent rows)", async () => {
    const world = await seedCallWorld();
    const stale = await recordMarked(world.ns.owner.userId, "stale");
    await ageAuditRow(stale);

    const answer = await callOnce(world);
    expect(answer.status, "the request path itself worked").toBe(200);
    expect(
      await countRows(world.ns.owner.userId, { tool: stale }),
      "a request path pruned the ledger",
    ).toBe(1);

    await sweep();
    expect(
      await countRows(world.ns.owner.userId, { tool: stale }),
      "…and the cron is what does",
    ).toBe(0);
  }, CASE_BUDGET_MS);
});

describe("§15 · the schedule itself", () => {
  it("13. §15 · the wrangler cron expression equals the expected daily constant — HONESTLY LABELLED: this asserts configuration only. Nothing in-process can prove the platform fires it; production answers that through the cron.swept rows (§10)", () => {
    // The `triggers.crons` array, read out of the deployment config as text. A regex rather
    // than a JSONC parse: the file carries comments, and the only thing this case is about
    // is one array of strings.
    const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(String(wranglerSource));
    expect(crons, "wrangler.jsonc declares no cron trigger at all").not.toBeNull();
    expect(JSON.parse(`[${crons?.[1] ?? ""}]`)).toEqual([EXPECTED_CRON]);
  });
});

// ── the one fixture that drives a real request path (case 12) ─────────────────────────

type CallWorld = { ns: SeededNamespace; credential: string };

async function seedCallWorld(): Promise<CallWorld> {
  const upstream: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: [{ name: APPROVAL_TOOL, inputSchema: { type: "object" } }],
  };
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "notion",
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "headers",
      },
    ],
    agents: [{ slug: "agent", grants: { notion: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "key" }] }],
  });
  const app = await new Registry(env.DB).getApp(ns.owner.userId, "notion");
  if (app === null) throw new Error("seedCallWorld: the seeded app vanished");
  // A proxied app with no envelope reads not-connected and is refused before dispatch,
  // so the credential is what makes this a REQUEST PATH that actually ran.
  await setHeaders(app, { Authorization: "Bearer FAKE0000-upstream-static-token" });
  return { ns, credential: ns.tokens.key.token };
}

function callOnce(world: CallWorld): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/${world.ns.owner.username}/mcp/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.credential}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: APPROVAL_TOOL, arguments: APPROVAL_ARGS },
      }),
    }),
    env as unknown as Env,
  );
}
