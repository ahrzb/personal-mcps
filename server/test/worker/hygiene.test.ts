// hygiene.test.ts — log hygiene as a property of the DATABASE, not of any one call site.
// Everything §15 promises about persisted bodies is checked where it is falsifiable: in D1
// after the hub has been driven hard. This suite pins (a) the §15 audit BODY table —
// per-service `log_bodies` defaulting by kind and flipping both ways, args and result
// structuredContent stored only post-redaction under §7's per-direction unions,
// unstructured result blocks stored as typed `blob` stubs, an over-cap body replaced whole
// by one `oversize` stub, and `token_issue`'s key masked by the uniform rule with no
// pmcp-specific case (§8, decision 22); (b) that bodies exist in exactly two places —
// approval `args_json` and the two audit body columns — and nowhere else; (c) that served
// outputSchemas carry no `writeOnly` (the hub's internal marker never reaches the wire,
// §7) while input schemas keep theirs; (d) that hashing follows redaction, proven by
// recomputation rather than by trusting a code path; and (e) a whole-database sentinel
// sweep for token material.
//
// Project: `worker` — real D1, every sibling module real, no sockets. Every body path a
// socket-free test can reach is reachable here: proxied services (fake upstream over
// miniflare.outboundService) and the builtin `pmcp` service, whose logBodies is fixed ON
// (gateway.virtualPmcpService). The tunneled live-socket body path is pinned once, in
// tunnel/pipeline-tunnel.test.ts and tunnel/approval-e2e.test.ts, and is deliberately not
// re-pinned here; what this file owns of the tunneled side is the ROW contract — the
// `log_bodies` default written at create, and the flip.
//
// Isolation, load-bearing: the sentinel sweep reads every table of the whole database, so
// it is only meaningful because storage isolation is per test FILE — the sweep sees
// exactly what this file wrote and nothing any sibling file did. It therefore runs last,
// and every case above it is deliberately a contributor to it. A sweep that finds nothing
// because nothing was written is a green test proving nothing: the sweep asserts its own
// reach with a control value that MUST be found (see sweepForSentinels).
//
// Also pinned by omission: no assertion here reads an audit `detail` layout, a column
// name, or a byte literal — §7 puts all three on the incidental side. Sizes are expressed
// against the cap in force, never as numbers (see AuditBodyRow.bodySize).

// deps: harness/seed · harness/fake-upstream · src/index (exports.default.fetch) · src/audit · src/registry (writeOnlyPaths, applyRedaction, redactPathsFor, REDACTED) · src/approvals (canonicalJson) · src/admin (ops.token_issue) · src/limits · applyD1Migrations · miniflare.outboundService

import { describe, it } from "vitest";
import type { AuditConfig, BodyStub } from "../../src/audit";
import type { ServiceKind } from "../../src/registry";

/**
 * How one audit body column must look after a call — the four shapes §15 allows, and no
 * fifth. `masked` names the paths that must read `registry.REDACTED` — the name, never the
 * glyphs, so a change of sentinel is one edit in registry.ts; `stubbed` names the
 * stubs an unstructured result must collapse into, minus their `bytes` (a row can pin
 * that a stub is a `blob image/png`, but never how many bytes a fixture serialized to —
 * the runner computes that from what it fed in, so the oracle stays transcribable).
 */
export type BodyColumnShape =
  | { shape: "absent" }
  | { shape: "masked"; redactedPaths: string[] }
  | { shape: "stubbed"; stubs: Omit<BodyStub, "bytes">[] }
  | { shape: "oversize" };

/**
 * One row of the §15 audit body table — the columns ARE the spec's variables: the kind
 * whose default is in play, the configured `log_bodies`, both halves of §7's redaction
 * union in both directions, the body fed in, the cap it runs against, and the persisted
 * shape of each column.
 *
 * Two columns exist to keep the table honest rather than to describe behavior:
 * `visible` is the allow-twin of every masking row (§9 rule 2 — a body table satisfied by
 * storing `registry.REDACTED` everywhere is a table that pins nothing), and `sentinels`
 * feeds the file-wide sweep. (`sentinels` is the OTHER sense of the word: values this
 * suite plants and then hunts for, unrelated to the mask.)
 */
export type AuditBodyRow = {
  /** Spec sentence transcribed, printed in the test name so a failure names what to re-read (§8). */
  spec: string;
  /** Case title in the doc's convention, appended after `spec`. */
  title: string;
  /** The kind of service seeded — decides which `log_bodies` default is under test. */
  kind: ServiceKind;
  /** `log_bodies` as configured at create: "default" exercises the by-kind default, a boolean the flip. */
  logBodies: "default" | boolean;
  /** Schema-declared secrets (§7): `writeOnly` paths in the tool's input / output schema. */
  writeOnly: { args: string[]; results: string[] };
  /** Config-declared secrets (§7): the service's `redact` / `redact_results` entries for this tool. */
  configRedact: { args: string[]; results: string[] };
  /** `params.arguments` as the consumer sends them — before any masking. */
  args: Record<string, unknown>;
  /** The result's `structuredContent` as the service returns it — before any masking. */
  structuredContent: Record<string, unknown>;
  /** Unstructured result blocks returned beside it; each must persist as a `blob` stub, never bytes. */
  blocks: { type: "text" | "image" | "resource"; contentType?: string }[];
  /** Which cap the recorder runs under — "shrunk" makes the over-cap branch reachable without megabyte fixtures. */
  cap: "default" | "shrunk";
  /** Body size relative to the cap IN FORCE — never a byte literal (§7: caps are asserted through the constant). */
  bodySize: "under" | "over";
  /** The persisted shape of each body column. */
  expect: { args: BodyColumnShape; results: BodyColumnShape };
  /** Values that must survive verbatim in the recorded body — the allow-twin of the row's masking. */
  visible: string[];
  /** Values that must appear in no column of any table afterwards. */
  sentinels: string[];
};

/**
 * The §15 body table. Rows are OWNER-AUTHORED in a separate commit before implementation
 * (strategy §9 rule 1) — agents write the type and the runner, never the rows.
 */
export const AUDIT_BODY_ROWS: readonly AuditBodyRow[] = [];

/**
 * The audit config a row runs under. The shrunk cap lives here, once, expressed as a
 * fraction of limits.AUDIT_BODY_CAP_BYTES so no size literal exists anywhere in the
 * suite; the same fraction is what the project's test worker sets AUDIT_BODY_CAP_BYTES
 * to, so direct-record rows and end-to-end rows are capped identically.
 */
export function auditConfigFor(cap: AuditBodyRow["cap"]): AuditConfig {
  // deps: src/limits (AUDIT_BODY_CAP_BYTES, RETENTION_DAYS)
  throw new Error("unimplemented");
}

/**
 * The table runner: seeds the row's service and grant, drives one `tools/call` through the
 * real endpoint against a fake upstream that returns the row's result, then reads the
 * persisted audit row back through audit.query and asserts each column against
 * `row.expect` — plus the two honesty checks every row carries (`visible` present,
 * `sentinels` absent). Rows whose `bodySize` is "over" have their body grown from the cap
 * in force, so "over-cap" survives a change to the cap.
 */
export async function runAuditBodyRow(row: AuditBodyRow): Promise<void> {
  // deps: harness/seed · harness/fake-upstream · src/index (exports.default.fetch) · src/audit (query) · auditConfigFor
  throw new Error("unimplemented");
}

/** Where a sentinel was found — the failure names the column, not just the fact. */
export type SentinelHit = { table: string; column: string; rowId: string; sentinel: string };

/**
 * The whole-database sweep: every column of every table (better-auth's included), scanned
 * for each sentinel plus the `pmcp_sa_` / `pmcp_svc_` token grammar. Returns every hit, so
 * a failure reads as "audit.detail row 12 holds the service token" rather than "false is
 * not true". Non-vacuous by construction: the sweep also searches for a control value the
 * exercise above DID persist visibly, and reports the sweep itself as broken when that
 * control is missing — a scan that cannot find what is there proves nothing about what is
 * not.
 */
export async function sweepForSentinels(
  sentinels: string[],
  control: string,
): Promise<SentinelHit[]> {
  // deps: D1 (sqlite_master walk) · applyD1Migrations
  throw new Error("unimplemented");
}

describe("§15 · the audit body table", () => {
  it.todo("1. §15 · <row.spec> · <row.title> — one case per AUDIT_BODY_ROWS row via runAuditBodyRow");
  it.todo("2. §15 · the table covers both kinds in both log_bodies states (structural: the row set spans {tunnel, proxy} × {default, flipped}, so a new default can't go untested)");
});

describe("§15 · log_bodies defaults by kind and flips both ways", () => {
  it.todo("3. §15 · tunneled create with log_bodies absent stores it ON");
  it.todo("4. §15 · proxied create with log_bodies absent stores it OFF");
  it.todo("5. §15 · log_bodies flipped OFF on a tunneled service · its tools/call records no bodies");
  it.todo("6. §15 · log_bodies flipped ON for a proxied service · its tools/call records both bodies (the allow-twin of 5 — the flip is proven in both directions, not just off)");
  it.todo("7. §15 · the builtin pmcp service records bodies with no row to configure (logBodies fixed ON)");
});

describe("§15 · what may reach the two body columns", () => {
  it.todo("8. §7 · args recorded post-redaction: every union path masked, every sibling path verbatim");
  it.todo("9. §7 · result structuredContent recorded post-redaction under the results union (schema writeOnly ∪ config redact_results) · a non-marked field beside it verbatim");
  it.todo("10. §15 · unstructured result blocks persist as blob stubs · the structuredContent beside them persists masked (never \"all or nothing\")");
  it.todo("11. §15 · a body over the cap in force is replaced WHOLE by one oversize stub · an under-cap body of the same shape persists intact");
  it.todo("12. §15 · an over-cap column still parses as JSON — replaced, never truncated");
  it.todo("13. §7 · MRTR inputResponses/requestState never enter args_json while the same leg's params.arguments do");
  it.todo("14. §15 · tools/list writes no audit row at all · the tools/call beside it writes exactly one");
  it.todo("14a. §7 · a call on a SCHEMA-UNSOUND tool — one whose schema tripped §7's indirection refuse-line at catalog warm, so it has no derivable redaction map and sensitivePaths answers null — records no body in either column · the same call on the same tool with a walkable schema records both, masked (the allow-twin, and the reason \"no redaction map\" can never quietly degrade into \"record it raw\"). Which schemas are refused is unit/redact.test.ts's; that the warm stays loud and registration survives is tunnel/protocol.test.ts's; this row owns only what reaches D1.");
});

describe("§8/§15 · the uniform rule needs no pmcp special case", () => {
  it.todo("15. §15 · token_issue's recorded result masks the key by the writeOnly rule · the row id and display prefix in the same result are recorded verbatim");
  it.todo("16. §7 · the CALLER receives the plaintext key unredacted while the recorded body is masked (masking exists for persistence, never for the response)");
});

describe("§7 · served outputSchemas carry no writeOnly", () => {
  it.todo("17. §7 · scoped tools/list strips writeOnly from every outputSchema · leaves inputSchema writeOnly intact (the input keyword is standard usage)");
  it.todo("18. §7 · aggregated tools/list strips it identically — one strip, both shapes");
  it.todo("19. §7 · stripping the served copy does not disarm redaction: the same tool's result is still masked at the marked path");
});

describe("§7 · redaction precedes hashing", () => {
  it.todo("20. §7 · the stored args_hash equals SHA-256(canonicalJson(applyRedaction(args, union))), recomputed in-test from the raw arguments");
  it.todo("21. §7 · the stored args_hash does NOT equal the hash of the raw arguments — the proof that the order is redact-then-hash and not the reverse");
  it.todo("22. §7 · two calls differing only in a redacted field share one approval row · two differing in a visible field never do");
});

describe("§15 · the sweep", () => {
  it.todo("23. §15 · after the full exercise no column of any table holds token material or a sentinel secret (sweepForSentinels, with its control value found — an unreachable sweep fails)");
  it.todo("24. §15 · bodies live only in approval.args_json and the audit body columns · the visible argument IS found in exactly those columns and in no other (the twin that makes 23 non-vacuous)");
});
