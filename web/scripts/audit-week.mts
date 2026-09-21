// audit-week.mts — DEV-ONLY. Turns the clickable prototype's fixture week into the preview
// gallery's seed data.
//
//   node --experimental-strip-types scripts/audit-week.mts      # from web/
//
// Run when `design/concepts/AuditDemo.data.js` changes, and never by hand: the gallery and the
// design boards must show the SAME week, or a screenshot compared against a board is comparing
// two different ledgers. The prototype's data file is the one copy of that week.
//
// It writes `src/preview/fixtures/audit-week.ts`, which is a GENERATED file:
//
//   - `WEEK` is the week as the window read answers it — SLIM rows (no bodies), newest first,
//     with `argsHead` and `hasResult` in their place, exactly as `audit_query { bodies: false }`
//     projects them in SQL. Newest first because that is the wire order, and the page's merge
//     and "Load more" both depend on it.
//   - `RECORDS` is a handful of FULL rows, keyed by id, for the record drawer's own one-row
//     read. Chosen by RULE rather than by hand (see `pickRecords`) so the set survives a
//     regenerated week: whichever row now carries a stub is the one the stub seed shows.
//
// Not a build step. The output is committed, because the input is a design artefact that
// changes a few times per redesign and the gallery must not depend on a script having been run.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The prototype's row shape: `AuditEventRow` with an ISO timestamp, bodies and all. */
type DemoRow = {
  ts: string;
  id: number;
  principal: string;
  event: string;
  app?: string;
  tool?: string;
  outcome: string;
  durationMs?: number;
  client?: { name?: string; version?: string; sessionId?: string };
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  noBodies?: "off" | "refused" | "unrecorded";
};

const SOURCE = fileURLToPath(new URL("../../design/concepts/AuditDemo.data.js", import.meta.url));
const TARGET = fileURLToPath(new URL("../src/preview/fixtures/audit-week.ts", import.meta.url));

/** `AUDIT_ARGS_HEAD_CHARS` (§1). A COPY of the server's constant, which is what the projection
 *  applies — the generated rows have to be the length the real read would return. */
const ARGS_HEAD_CHARS = 160;

const source = await readFile(SOURCE, "utf8");
// The data file assigns onto `window`, so it is evaluated against a stand-in rather than parsed:
// it is a design artefact written for a browser, and rewriting it as JSON would be a second copy
// of the week.
const globals: { NOW?: string; RETENTION_DAYS?: number; EVENTS?: DemoRow[] } = {};
new Function("window", source)(globals);
const events = globals.EVENTS ?? [];
if (events.length === 0) throw new Error(`${SOURCE} defined no window.EVENTS`);

/** Newest first, the wire order, with (ts, id) as the tiebreaker the page's merge relies on. */
const ordered = [...events].sort(
  (left, right) => Date.parse(right.ts) - Date.parse(left.ts) || right.id - left.id,
);

const slim = ordered.map((row) => {
  const { ts, args, result, ...rest } = row;
  return {
    ...rest,
    ts: Date.parse(ts),
    ...(args === undefined ? {} : { argsHead: JSON.stringify(args).slice(0, ARGS_HEAD_CHARS) }),
    hasResult: result !== undefined,
  };
});

const full = pickRecords(ordered).map((row) => {
  const { ts, ...rest } = row;
  return { ...rest, ts: Date.parse(ts) };
});

await writeFile(TARGET, render(globals.NOW ?? "", globals.RETENTION_DAYS ?? 7, slim, full), "utf8");
console.log(`audit-week: ${slim.length} slim rows, ${full.length} full records → ${TARGET}`);

/**
 * Which rows the record seeds need, by rule.
 *
 * One per shape the drawer has to draw, and picked from the week rather than written down here:
 * a regenerated week moves every id, and a hand-written list would then seed records for rows
 * that no longer exist.
 */
function pickRecords(rows: DemoRow[]): DemoRow[] {
  const picked = new Map<number, DemoRow>();
  const take = (row: DemoRow | undefined): void => {
    if (row !== undefined) picked.set(row.id, row);
  };
  /* A plain call with bodies (its redacted leaf is what the `‹redacted›` chip is drawn from),
     then BOTH stub shapes — they render differently and no row in the week carries both: a
     `blob` sits as one element of `content`, an `oversize` replaces a whole section. */
  take(rows.find((row) => row.args !== undefined && row.result !== undefined && !hasStub(row)));
  take(rows.find((row) => stubKind(row, "blob")));
  take(rows.find((row) => stubKind(row, "oversize")));
  for (const reason of ["off", "refused", "unrecorded"] as const) {
    take(rows.find((row) => row.noBodies === reason));
  }
  // A `-32000` carrying a `failureClass` — the one outcome whose sentence gains a cause, and
  // therefore the one the record's outcome row has to be seen drawing.
  take(rows.find((row) => row.outcome === "-32000" && typeof row.detail?.failureClass === "string"));
  // Every row of the first COMPLETE chain — the drawer's sibling timeline is drawn from the
  // loaded window, but the record it opens on is read by id, so each member needs its own row.
  const chains = new Map<string, DemoRow[]>();
  for (const row of rows) {
    const id = row.detail?.approvalId;
    if (typeof id !== "string") continue;
    chains.set(id, [...(chains.get(id) ?? []), row]);
  }
  const chain = [...chains.values()].find((group) => group.length >= 4);
  for (const row of chain ?? []) take(row);
  return [...picked.values()].sort((left, right) => left.id - right.id);
}

/** Whether a row's recorded bodies hold a §15 stub anywhere. */
function hasStub(row: DemoRow): boolean {
  return JSON.stringify([row.args, row.result]).includes('"stub"');
}

/** Whether they hold one of the two KINDS. `blob` and `oversize` are different renderings and
 *  different facts, so the record seeds want one of each. */
function stubKind(row: DemoRow, kind: "blob" | "oversize"): boolean {
  return JSON.stringify([row.args, row.result]).includes(`"stub":"${kind}"`);
}

function render(now: string, retentionDays: number, slimRows: unknown[], fullRows: { id: number }[]): string {
  return `// GENERATED by web/scripts/audit-week.mts from design/concepts/AuditDemo.data.js.
// Do not edit: regenerate instead, so the preview gallery and the design boards keep showing the
// same week. ${slimRows.length} slim rows, ${fullRows.length} full records.
import type { AuditEventRow, AuditWindowRow } from "@/lib/types";

/** The instant the week ends on — the prototype's own \`window.NOW\`, which is also
 *  \`preview/clock.ts\`'s \`FROZEN_NOW\`. The two must agree or every relative label differs
 *  between the gallery and the boards. */
export const WEEK_NOW = Date.parse(${JSON.stringify(now)});

/** §15's retention, as the prototype's week was generated against it. */
export const WEEK_RETENTION_DAYS = ${retentionDays};

/** The window read's answer: slim rows, newest first. */
export const WEEK: AuditWindowRow[] = ${JSON.stringify(slimRows, null, 0).replace(/^\[/, "[\n  ").replace(/},\{/g, "},\n  {").replace(/\]$/, ",\n]")};

/** The one-row read's answers, by id — the rows the record seeds open. */
export const RECORDS: Record<number, AuditEventRow> = {
${fullRows.map((row) => `  ${row.id}: ${JSON.stringify(row)},`).join("\n")}
};
`;
}
