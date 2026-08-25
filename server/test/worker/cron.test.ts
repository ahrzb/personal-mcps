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

// deps: harness/seed · harness/fake-upstream · src/index (default.scheduled, Env) · src/approvals · src/audit · src/upstream · src/limits · cloudflare:test createScheduledController · applyD1Migrations

import { describe, it } from "vitest";
import type { AuditEntry } from "../../src/audit";

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
  /** How many rows the seed plants on each side of `window` — both sides always non-zero. */
  fixtures: { pastWindow: number; insideWindow: number };
  /** Audit events the leg itself writes per affected row, beyond the run's single cron.swept row. */
  auditEvents: string[];
  /** The public seam the runner reads the effect back through. */
  observedVia: "approvals.list" | "audit.query" | "upstream.handleCallback rejects";
};

/**
 * The leg table. Rows are OWNER-AUTHORED in a separate commit before implementation
 * (strategy §9 rule 1) — agents write the type and the runner, never the rows.
 */
export const CRON_LEG_ROWS: readonly CronLegRow[] = [];

/**
 * The one reader of the `cron.swept` row's shape. The per-leg outcome layout inside
 * `detail` is incidental (§7) — so exactly one function knows it, and a layout change is a
 * one-line edit rather than a sweep through the suite. Answers whether the run reports
 * this leg as having succeeded, and how many rows it says it touched; `null` means the row
 * does not mention the leg at all, which is itself a failure worth naming distinctly from
 * "reported failed".
 */
export function legOutcome(entry: AuditEntry, leg: CronLeg): { ok: boolean; count: number } | null {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The table runner: plants `row.fixtures` on both sides of `row.window` against the
 * injected clock, fires one scheduled run, then asserts through `row.observedVia` that
 * every past-window fixture was acted on and every inside-window fixture survived, that
 * the leg's own audit events were written once per affected row, and that `legOutcome`
 * reports the leg with the matching count. Each row runs a second time with its leg forced
 * to reject, asserting the OTHER legs' effects still landed and the swept row records the
 * failure — leg isolation is a property of every leg, so it belongs in the runner rather
 * than in a column no row could sensibly set to false.
 */
export async function runCronLegRow(row: CronLegRow): Promise<void> {
  // deps: harness/seed · src/index (default.scheduled) · cloudflare:test createScheduledController · legOutcome
  throw new Error("unimplemented");
}

describe("§15 · the cron leg table", () => {
  it.todo("1. §15 · <row.spec> · <row.title> — one case per CRON_LEG_ROWS row via runCronLegRow");
  it.todo("2. §15 · every leg of the composition root's named list appears in at least one row — driven over the leg list itself, so a fourth leg cannot be added without a row");
});

describe("§15 · one run, all three effects", () => {
  it.todo("3. §15 · a single scheduled run flips past-expiry pending approvals, prunes past-retention audit and approval rows, and drops stale upstream-OAuth state — all from one invocation");
  it.todo("4. §7 · each flip writes exactly one approval.expired row · a second run over the same rows writes none (the exactly-once law, one case, two runs)");
  it.todo("5. §7 · the expiry sweep precedes the prune — a pending row past BOTH windows is audited expired before it is deleted, never silently dropped");
  it.todo("6. §15 · a run over an empty namespace still completes and still writes its cron.swept row (the allow-twin of every \"N rows were touched\" case)");
});

describe("§15 · the run is observable", () => {
  it.todo("7. §15 · every run writes exactly one cron.swept audit row, and it names every leg");
  it.todo("8. §15 · a leg that throws never starves its siblings: the other two effects are observable and the swept row reports that leg failed (legOutcome ok:false)");
  it.todo("9. §15 · scheduled() resolves even when every leg rejects — the cron never throws into the platform, because a thrown cron is an invisible cron");
  it.todo("10. §15 · the cron.swept row is itself queryable through audit_query — /audit is the cron's only monitoring, so an unqueryable row is no monitoring at all");
});

describe("§15 · the windows are configuration, not literals", () => {
  it.todo("11. §15 · retention comes from AUDIT_RETENTION_DAYS when the var is set and from limits.RETENTION_DAYS when it is not — parsed once at the composition root, so both runs differ only in what survives");
  it.todo("12. §15 · request paths never prune: a tools/call made with past-retention rows present deletes nothing · the scheduled run that follows deletes them (the twin — proving the first assertion is about restraint, not about absent rows)");
});

describe("§15 · the schedule itself", () => {
  it.todo("13. §15 · the wrangler cron expression equals the expected daily constant — HONESTLY LABELLED: this asserts configuration only. Nothing in-process can prove the platform fires it; production answers that through the cron.swept rows (§10)");
});
