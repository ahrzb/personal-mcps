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
// recomputation rather than by trusting a code path; (e) a whole-database sentinel
// sweep for token material; and (f) the one §15 hygiene sink that is not the database —
// the exception trace. §15's sentence covers "logs, error responses, and exception
// traces", and `audit.beforeSend` is the sink that carries the third; it is
// pinned here as a pure exported function over a table of events, so the rule is
// falsifiable with the Sentry SDK absent (it is deliberately not a dependency) and the DSN
// unset. The file stays the hygiene file: everything else it owns is a property of D1, and
// this is the one place a planted secret can leave the worker instead of landing in it.
//
// Project: `worker` — real D1, every sibling module real, and one socket: case 14a's, and
// only case 14a's. Every other body path here is reachable without one: proxied services
// (fake upstream over miniflare.outboundService) and the builtin `pmcp` service, whose
// logBodies is fixed ON (gateway.virtualPmcpService). The tunneled live-socket body path is
// pinned once, in tunnel/pipeline-tunnel.test.ts and tunnel/approval-e2e.test.ts, and is
// deliberately not re-pinned here; what this file owns of the tunneled side is the ROW
// contract — the `log_bodies` default written at create, and the flip — plus the one law
// whose only producer is a warmed catalog (case 14a: a schema-unsound tool has no
// redaction map, and §7 puts the availability check ahead of that map, so the service has
// to be genuinely online). That socket is dialled and closed inside the case, and it uses
// no tunnel-project harness: `tunnel` runs serial and un-isolated precisely because live
// sockets outlive per-file isolation, and nothing here may depend on that.
//
// Isolation, load-bearing: the sentinel sweep reads every table of the whole database, so
// it is only meaningful because storage isolation is per test FILE — the sweep sees
// exactly what this file wrote and nothing any sibling file did. It runs last, over the
// rows the cases above left. WHAT it hunts is declared rather than accumulated: every
// planted secret is one field of `PLANTED`, read by the case that plants it and by the
// sweep, so no run can shrink the sweep's scope by not reaching a case. A sweep that finds
// nothing because nothing was written is a green test proving nothing: the sweep asserts its
// own reach with a control value that MUST be found (see sweepForSentinels).
//
// Also pinned by omission: no assertion here reads an audit `detail` layout, a column
// name, or a byte literal — §7 puts all three on the incidental side. Sizes are expressed
// against the cap in force, never as numbers (see AuditBodyRow.bodySize).

// deps: harness/seed · harness/fake-upstream · src/index (exports.default.fetch) · src/audit (query, beforeSend) · src/registry (writeOnlyPaths, applyRedaction, redactPathsFor, REDACTED) · src/principal (tokenPattern) · src/approvals (canonicalJson) · src/admin (ops.token_issue) · src/limits · applyD1Migrations · miniflare.outboundService

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/approvals";
import { beforeSend, query, REDACTED_QUERY } from "../../src/audit";
import type { AuditConfig, AuditRow, BodyStub } from "../../src/audit";
import type { Prompt, Resource, ResourceTemplate, Tool } from "../../src/gateway";
import worker from "../../src/index";
import { tokenPattern } from "../../src/principal";
import type { Env } from "../../src/index";
import { AUDIT_BODY_CAP_BYTES, AUDIT_URI_CAP_BYTES, RETENTION_DAYS } from "../../src/limits";
import { applyRedaction, PMCP_SLUG, REDACTED, Registry } from "../../src/registry";
import type { GrantEntry, RoleDeclaration, ServiceKind } from "../../src/registry";
import { setHeaders } from "../../src/upstream";
import { registerOverride, upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, seedService, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

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
  /**
   * Schema-declared secrets (§7): `writeOnly` paths in the tool's input / output schema.
   * A fixture INPUT rather than an expectation — the runner plants these marks on the fake
   * upstream's tool schemas — and what the table asserts is what they CONTRIBUTE, which
   * for a proxied service is nothing (§7: no cached schema, so config paths are the whole
   * union). Positive schema-derived masking belongs to the two kinds that have a schema
   * the hub trusts: the `pmcp` builtin (case 15 below) and the tunneled path
   * (tunnel/pipeline-tunnel.test.ts, tunnel/approval-e2e.test.ts), per this file's header.
   */
  writeOnly: { args: string[]; results: string[] };
  /** Config-declared secrets (§7): the service's `redact` / `redact_results` entries for this tool. */
  configRedact: { args: string[]; results: string[] };
  /** `params.arguments` as the consumer sends them — before any masking. */
  args: Record<string, unknown>;
  /** The result's `structuredContent` as the service returns it — before any masking. */
  structuredContent: Record<string, unknown>;
  /** Unstructured result blocks returned beside it; each must persist as a `blob` stub, never bytes. */
  blocks: { type: "text" | "image" | "resource"; contentType?: string }[];
  /**
   * How the call ends — the SECOND half of §15's conjunction ("bodies when `log_bodies` is
   * on AND the call was actually dispatched"), which the expect columns alone cannot
   * state. Without it every `absent/absent` row is equally satisfied by a call that never
   * dispatched: the tunneled rows mean it (never-connected → -32000, documented below),
   * and the proxied-default row emphatically does not — its whole claim is that a call
   * which DID dispatch and succeed recorded nothing. `outcome: "ok"` is what witnesses the
   * dispatch, so the three `absent` rows and the five `masked` ones differ by the flag
   * rather than by whether anything ran.
   */
  outcome: "ok" | "-32000";
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
export const AUDIT_BODY_ROWS: readonly AuditBodyRow[] = [
  // The fixture, named once: one seeded service per row (the row's `kind` and
  // `log_bodies`), one allow-mode grant, one tool, and — for proxied rows — a fake upstream
  // returning the row's `structuredContent` and `blocks`. Every planted secret is spelled
  // `FAKE0000-…` so a value that ever does surface in a log, a body, or a failure message
  // is unmistakably a fixture and not a credential.
  //
  // Four conventions, so no row repeats them:
  // · Every value in `sentinels` is already IN the row's own `args` / `structuredContent`.
  //   The sweep's reach is the file's, not the row's: the row's duty is to plant something
  //   that must vanish, and the last describe block's duty is to prove nothing found it.
  // · `visible` is not decoration. A body table satisfied by writing REDACTED into every
  //   field is a table that pins nothing (§9 rule 2), so every masking row names at least
  //   one sibling value that must survive verbatim.
  // · Result-column paths are spelled relative to `structuredContent`, the root the
  //   results union is walked against (§7) — "session.key", never
  //   "result.structuredContent.session.key".
  // · The two TUNNELED rows carry `absent` on both columns and no visible values. That is
  //   not a gap in the table: this project has no sockets, so a tunneled service is
  //   never-connected, its call is refused -32000 at availability, and §15's "refusal rows
  //   never carry bodies" is the strongest true thing a tunneled row can say here. They
  //   exist so the row set spans {tunnel, proxy} × {default, flipped} — and what they pin
  //   is worth pinning: log_bodies decides whether there ARE bodies, dispatch decides
  //   whether there is a call to have them. The dispatched tunneled body path is
  //   tunnel/pipeline-tunnel.test.ts's and tunnel/approval-e2e.test.ts's.

  // ── the by-kind default, both cells ───────────────────────────────────────────────────
  // The row that makes "proxied off" a decision rather than an accident: the service
  // declares no `log_bodies`, the call dispatches and succeeds, and NOTHING is recorded —
  // not the argument, not the result. Both planted values are sentinels, so this row is
  // also the sweep's cheapest contributor: an implementation that recorded bodies by
  // default fails here AND in the sweep, naming the column.
  {
    spec:
      "The flag's default is by kind: tunneled on (our libraries declare secrets in both schema directions, §7/§11), proxied off (no trustworthy schema; the owner opts in per service and covers it with `redact` / `redact_results` paths, §9).",
    title:
      "a proxied service created without log_bodies records NEITHER body — the by-kind default is OFF, so an unmasked upstream result can never land in D1 by accident",
    kind: "proxy",
    logBodies: "default",
    writeOnly: { args: [], results: [] },
    configRedact: { args: [], results: [] },
    args: { query: "weather in berlin", apiKey: "FAKE0000-proxy-default-off-arg" },
    structuredContent: { summary: "cloudy", token: "FAKE0000-proxy-default-off-result" },
    blocks: [],
    // The row's load-bearing cell: this call DISPATCHED and succeeded. Both bodies are
    // absent because the flag is off, not because nothing ran — the distinction the
    // tunneled rows below make the other way.
    outcome: "ok",
    cap: "default",
    bodySize: "under",
    expect: { args: { shape: "absent" }, results: { shape: "absent" } },
    visible: [],
    sentinels: ["FAKE0000-proxy-default-off-arg", "FAKE0000-proxy-default-off-result"],
  },
  // The tunneled default, asked the only way a socket-free project can ask it. §15:
  // "Refusal rows (-32000/-32001/-32002/-32003) never carry bodies."
  {
    spec:
      "Refusal rows (`-32000`/`-32001`/`-32002`/`-32003`) never carry bodies — several refusals happen before any redaction map exists (a catalog-miss has no schema, §7), so recording them would persist unmasked arguments.",
    title:
      "a tunneled service defaults log_bodies ON — and a call it cannot dispatch (never connected → -32000) still records NEITHER body: the flag decides whether there are bodies, the dispatch decides whether there is a call",
    kind: "tunnel",
    logBodies: "default",
    writeOnly: { args: [], results: [] },
    configRedact: { args: [], results: [] },
    args: { note: "FAKE0000-tunnel-default-on-arg" },
    structuredContent: {},
    blocks: [],
    // The other conjunct: never-connected, so the call is refused at availability and
    // there is no dispatch to have bodies for (§15: refusal rows never carry them).
    outcome: "-32000",
    cap: "default",
    bodySize: "under",
    expect: { args: { shape: "absent" }, results: { shape: "absent" } },
    visible: [],
    sentinels: ["FAKE0000-tunnel-default-on-arg"],
  },
  // The flipped tunneled cell: the same refusal with the flag explicitly off. Its value is
  // structural — it is the fourth corner of {tunnel, proxy} × {default, flipped}, so a
  // future change to either default cannot go untested — and it states one thing the row
  // above cannot: the flip is honoured at create for tunneled services too.
  {
    spec:
      "The flag's default is by kind: tunneled on (our libraries declare secrets in both schema directions, §7/§11), proxied off (no trustworthy schema; the owner opts in per service and covers it with `redact` / `redact_results` paths, §9).",
    title:
      "a tunneled service created with log_bodies explicitly OFF stores the flip and records neither body — the by-kind default is a default, never a fixture",
    kind: "tunnel",
    logBodies: false,
    writeOnly: { args: [], results: [] },
    configRedact: { args: [], results: [] },
    args: { note: "FAKE0000-tunnel-flipped-off-arg" },
    structuredContent: {},
    blocks: [],
    outcome: "-32000",
    cap: "default",
    bodySize: "under",
    expect: { args: { shape: "absent" }, results: { shape: "absent" } },
    visible: [],
    sentinels: ["FAKE0000-tunnel-flipped-off-arg"],
  },

  // ── the proxied opt-in, and what masking means in both directions ─────────────────────
  // §7's config half, both directions in one row, with a sibling value beside each mask so
  // the row cannot be satisfied by masking everything. `credentials.token` is the nested
  // path the spec itself spells; `credentials.user` beside it is the reason the walk has
  // to navigate rather than blanket a subtree.
  {
    spec:
      "Config-declared (both kinds): the owner lists redaction paths per tool — `redact: { \"<tool-or-pattern>\": [\"password\", \"credentials.token\"] }` for arguments, and `redact_results:` (identical shape, applied to the result's `structuredContent`) — in the YAML / `service_update`.",
    title:
      "proxied log_bodies ON · every configured `redact` / `redact_results` path is masked in the recorded bodies and every sibling path survives verbatim",
    kind: "proxy",
    logBodies: true,
    writeOnly: { args: [], results: [] },
    configRedact: { args: ["password", "credentials.token"], results: ["session.key"] },
    args: {
      query: "quarterly report",
      password: "FAKE0000-arg-password",
      credentials: { token: "FAKE0000-arg-nested-token", user: "visible-arg-user" },
    },
    structuredContent: {
      title: "visible-result-title",
      session: { key: "FAKE0000-result-session-key", id: "visible-result-session-id" },
    },
    blocks: [],
    outcome: "ok",
    cap: "default",
    bodySize: "under",
    expect: {
      args: { shape: "masked", redactedPaths: ["password", "credentials.token"] },
      results: { shape: "masked", redactedPaths: ["session.key"] },
    },
    visible: [
      "quarterly report",
      "visible-arg-user",
      "visible-result-title",
      "visible-result-session-id",
    ],
    sentinels: ["FAKE0000-arg-password", "FAKE0000-arg-nested-token", "FAKE0000-result-session-key"],
  },
  // The v1 pin, stated where it is observable rather than left as prose. §7: proxied
  // schemas are forwarded live and never cached, so `writeOnly` marks on a PROXIED tool's
  // own schemas contribute nothing to either union — the owner's config paths are the whole
  // map. The row is deliberately uncomfortable: `issuedKey` is marked writeOnly by the
  // upstream and is recorded ANYWAY, which is exactly why §15 defaults proxied bodies off
  // and why the owner who opts in must cover the tool with `redact_results`. It is
  // therefore not a sentinel — a value the system is specified to store cannot be one.
  //
  // The two directions are deliberately UNCONFOUNDED, which is the whole reason the cells
  // read as they do: the upstream's writeOnly paths (`apiKey`, `issuedKey`) and the
  // owner's config path (`password`) are disjoint, so each recorded value has exactly one
  // explanation. `apiKey` is marked by the upstream and covered by nothing, and lands in
  // the body verbatim; `password` is covered by config and is masked. Overlapping them —
  // one path named by both halves — would let an implementation that DID derive a proxied
  // schema map pass the args cell, and the claim would rest on the results cell alone.
  //
  // If a proxied schema cache is ever added (§7 says it may be), this row goes red and
  // changes in the same commit as the spec line — a `spec:` commit, which is the whole
  // point of pinning it.
  {
    spec:
      "This is the only path for proxied services in v1: their `tools/list` is forwarded live and never cached, so there is no schema to derive from (honoring upstream `writeOnly` becomes possible if a proxied schema cache is ever added).",
    title:
      "a proxied tool's own `writeOnly` marks contribute NOTHING — with no cached schema the config paths are the whole union, which is precisely why proxied bodies default off",
    kind: "proxy",
    logBodies: true,
    writeOnly: { args: ["apiKey"], results: ["issuedKey"] },
    configRedact: { args: ["password"], results: [] },
    args: {
      apiKey: "upstream-marked-writeonly-arg-but-recorded",
      password: "FAKE0000-covered-by-config-redact",
      note: "visible-writeonly-row-note",
    },
    structuredContent: { issuedKey: "upstream-marked-writeonly-but-recorded", ok: "visible-writeonly-row-ok" },
    blocks: [],
    outcome: "ok",
    cap: "default",
    bodySize: "under",
    expect: {
      // Masked at the CONFIG path and only there: `apiKey` carries the upstream's
      // writeOnly mark and no config path, so it is recorded — the args-side statement of
      // the same sentence the results column makes.
      args: { shape: "masked", redactedPaths: ["password"] },
      // Masked under an EMPTY union: the column is post-redaction, and post-redaction of
      // nothing is the whole body. Not "absent" — the body was recorded — and not a
      // missing assertion either.
      results: { shape: "masked", redactedPaths: [] },
    },
    visible: [
      "visible-writeonly-row-note",
      "upstream-marked-writeonly-arg-but-recorded",
      "upstream-marked-writeonly-but-recorded",
      "visible-writeonly-row-ok",
    ],
    sentinels: ["FAKE0000-covered-by-config-redact"],
  },
  // §15's stub rule, with the masked structuredContent sitting beside the stubs so the row
  // also says "never all or nothing". The `content` half is pinned by `stubs`; the
  // structured half by `visible` / `sentinels`, because a column carries one shape and the
  // stubs are the shape under test here.
  //
  // `contentType` mirrors what the block declares: `image/png` in, `image/png` out; a text
  // block declares none, so its stub carries none. What must never appear either way is a
  // byte of the block itself.
  {
    spec:
      "Unstructured result content (text/image/resource blocks) is never stored — each block becomes a typed size stub (`{stub: \"blob\", contentType, bytes}`), so \"the image generator returned a 4 MB png\" is visible without the bytes.",
    title:
      "unstructured result blocks persist as typed blob stubs — type and size, never bytes · the structuredContent beside them still persists masked",
    kind: "proxy",
    logBodies: true,
    writeOnly: { args: [], results: [] },
    configRedact: { args: [], results: ["caption.secret"] },
    args: { prompt: "a red bicycle" },
    structuredContent: {
      caption: { text: "visible-block-caption", secret: "FAKE0000-block-row-caption-secret" },
    },
    blocks: [
      { type: "image", contentType: "image/png" },
      { type: "text" },
      { type: "resource", contentType: "application/pdf" },
    ],
    outcome: "ok",
    cap: "default",
    bodySize: "under",
    expect: {
      args: { shape: "masked", redactedPaths: [] },
      results: {
        shape: "stubbed",
        stubs: [
          { stub: "blob", contentType: "image/png" },
          { stub: "blob" },
          { stub: "blob", contentType: "application/pdf" },
        ],
      },
    },
    visible: ["a red bicycle", "visible-block-caption"],
    sentinels: ["FAKE0000-block-row-caption-secret"],
  },

  // ── the cap, both sides of it ─────────────────────────────────────────────────────────
  // §15's cap rule. The two rows below are the same row with `bodySize` flipped, which is
  // what makes the first one a CAP assertion rather than a masking one: an implementation
  // that dropped every args body would pass the over-cap row and fail its twin.
  //
  // The results column stays under the cap in both, on purpose: each body is capped
  // independently, so an oversize args column must not take the result column with it.
  {
    spec:
      "Each body is capped at `AUDIT_BODY_CAP_BYTES` (default 16 KiB, env-overridable): an over-cap body is replaced whole by an `oversize` stub — never truncated into corrupt JSON.",
    title:
      "an args body grown past the cap in force is replaced WHOLE by one oversize stub — the masked value inside it goes with the rest · the under-cap result column is untouched",
    kind: "proxy",
    logBodies: true,
    writeOnly: { args: [], results: [] },
    configRedact: { args: ["password"], results: [] },
    args: { password: "FAKE0000-oversize-row-password", filler: "grown from the cap in force" },
    structuredContent: { ok: "visible-oversize-row-result" },
    blocks: [],
    outcome: "ok",
    cap: "shrunk",
    bodySize: "over",
    expect: {
      args: { shape: "oversize" },
      results: { shape: "masked", redactedPaths: [] },
    },
    // Nothing from the args body survives an oversize replacement — the only value this row
    // can require to be present is the one in the column that stayed under the cap.
    visible: ["visible-oversize-row-result"],
    sentinels: ["FAKE0000-oversize-row-password"],
  },
  {
    spec:
      "Each body is capped at `AUDIT_BODY_CAP_BYTES` (default 16 KiB, env-overridable): an over-cap body is replaced whole by an `oversize` stub — never truncated into corrupt JSON.",
    title:
      "the same body shape UNDER the cap in force persists intact and masked — the twin that makes the oversize row a cap assertion rather than a disappearing act",
    kind: "proxy",
    logBodies: true,
    writeOnly: { args: [], results: [] },
    configRedact: { args: ["password"], results: [] },
    args: { password: "FAKE0000-undersize-row-password", filler: "visible-undersize-row-filler" },
    structuredContent: { ok: "visible-undersize-row-result" },
    blocks: [],
    outcome: "ok",
    cap: "shrunk",
    bodySize: "under",
    expect: {
      args: { shape: "masked", redactedPaths: ["password"] },
      results: { shape: "masked", redactedPaths: [] },
    },
    visible: ["visible-undersize-row-filler", "visible-undersize-row-result"],
    sentinels: ["FAKE0000-undersize-row-password"],
  },
];

/**
 * The audit config a row runs under. The shrunk cap lives here, once, expressed as a
 * fraction of limits.AUDIT_BODY_CAP_BYTES so no size literal exists anywhere in the
 * suite; the same fraction is what the project's test worker sets AUDIT_BODY_CAP_BYTES
 * to, so direct-record rows and end-to-end rows are capped identically.
 */
export function auditConfigFor(cap: AuditBodyRow["cap"]): AuditConfig {
  // deps: src/limits (AUDIT_BODY_CAP_BYTES, RETENTION_DAYS)
  return {
    retentionDays: RETENTION_DAYS,
    bodyCapBytes:
      cap === "default" ? AUDIT_BODY_CAP_BYTES : AUDIT_BODY_CAP_BYTES / CAP_SHRINK_FACTOR,
  };
}

/**
 * How much smaller the shrunk cap is. A FRACTION of limits.AUDIT_BODY_CAP_BYTES rather than
 * a size, so a change to the cap moves both sides of every over/under pair together and no
 * byte literal exists anywhere in this suite.
 */
const CAP_SHRINK_FACTOR = 16;

/**
 * Run `body` with the audit cap set to `config`'s, and put the binding back afterwards.
 *
 * The worker under test resolves §15's knobs off the ambient `cloudflare:workers` env at the
 * moment a row is written (audit.ts says so, and says why it is not memoized), and in this
 * pool that object IS `cloudflare:test`'s `env` — so this is the harness "overriding per
 * request" that audit.config's comment describes, not a second parse of the var. Doing it
 * here rather than in vitest.config.mts is deliberate: a project-wide shrunk cap would
 * silently re-shape bodies for every other worker suite.
 */
async function withCap<T>(config: AuditConfig, body: () => Promise<T>): Promise<T> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const previous = bindings.AUDIT_BODY_CAP_BYTES;
  bindings.AUDIT_BODY_CAP_BYTES = String(config.bodyCapBytes);
  try {
    return await body();
  } finally {
    bindings.AUDIT_BODY_CAP_BYTES = previous;
  }
}

/**
 * The table runner: seeds the row's service and grant, drives one `tools/call` through the
 * real endpoint against a fake upstream that returns the row's result, then reads the
 * persisted audit row back through audit.query and asserts each column against
 * `row.expect` — plus the row's `outcome` against the audit row's own outcome column, and
 * the two honesty checks every row carries (`visible` present, `sentinels` absent).
 * Asserting the outcome is what keeps an `absent/absent` row from being satisfied by a
 * call that never dispatched: §15's body rule is a conjunction, and the outcome cell is
 * the only place a row says which of the two conjuncts it is exercising. Rows whose
 * `bodySize` is "over" have their body grown from the cap in force, so "over-cap" survives
 * a change to the cap.
 */
export async function runAuditBodyRow(row: AuditBodyRow): Promise<void> {
  // deps: harness/seed · harness/fake-upstream · src/index (exports.default.fetch) · src/audit (query) · auditConfigFor
  const config = auditConfigFor(row.cap);
  const blocks = row.blocks.map(mcpBlock);
  const world = await seedBodyWorld(row, blocks);
  const args = argsFor(row, config);

  const answer = await withCap(config, () =>
    callTool(world.ns, world.credential, SERVICE, TOOL, args),
  );
  const recorded = await lastCallRow(world.ns.owner.userId);

  // The conjunction's second half: which of §15's two conjuncts this row exercises is only
  // readable off the outcome, so it is asserted before either column is looked at.
  expect(recorded.outcome, `${row.title}: wrong outcome ${JSON.stringify(answer.body)}`).toBe(
    row.outcome,
  );

  const union = { args: row.configRedact.args, results: row.configRedact.results };
  assertColumn(row, "args", recorded.args, applyRedaction(args, union.args), config);
  assertColumn(
    row,
    "results",
    recorded.result,
    applyRedaction(row.structuredContent, union.results),
    config,
    blocks,
  );

  // The two honesty checks every row carries. Both read the WHOLE recorded row, so a value
  // that escaped into `detail` or a client field is caught with the same assertion.
  const stored = JSON.stringify(recorded);
  for (const value of row.visible) {
    expect(stored.includes(value), `${row.title}: "${value}" was masked and must not be`).toBe(true);
  }
  for (const sentinel of row.sentinels) {
    expect(stored.includes(sentinel), `${row.title}: "${sentinel}" reached the ledger`).toBe(false);
  }
}

/** One recorded body column, against the shape the row expects of it. `masked` is compared
 *  against the WHOLE post-redaction body, which is what makes "every sibling path verbatim"
 *  and "an empty union stores the whole body" the same assertion. */
function assertColumn(
  row: AuditBodyRow,
  direction: "args" | "results",
  recorded: Record<string, unknown> | undefined,
  masked: Record<string, unknown>,
  config: AuditConfig,
  blocks: unknown[] = [],
): void {
  const shape = row.expect[direction];
  const where = `${row.title}: the ${direction} column`;
  if (shape.shape === "absent") {
    expect(recorded, `${where} must carry nothing`).toBeUndefined();
    return;
  }
  expect(recorded, `${where} recorded nothing`).toBeDefined();
  if (shape.shape === "oversize") {
    expect(recorded, `${where} must be one oversize stub, whole`).toEqual({
      stub: "oversize",
      bytes: byteLength(JSON.stringify(masked)),
    });
    return;
  }
  const body = direction === "args" ? recorded : (recorded?.structuredContent as typeof recorded);
  if (shape.shape === "masked") {
    // Named paths first: `toEqual` against a post-redaction copy is vacuous for a path that
    // is not in the body at all, and a mis-spelled oracle path must fail loudly.
    for (const path of shape.redactedPaths) {
      expect(valueAt(masked, path), `${where}: "${path}" is not a path of this body`).toBe(REDACTED);
    }
    expect(body, `${where} is not post-redaction`).toEqual(masked);
    return;
  }
  expect(recorded?.content, `${where} must stub every unstructured block`).toEqual(
    shape.stubs.map((stub, at) => ({ ...stub, bytes: byteLength(JSON.stringify(blocks[at])) })),
  );
}

// ── the fixture every body row is driven against ──────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

const SERVICE = "notion";
const ACCOUNT = "agent";
const TOKEN = "key";
const TOOL = "search";

/** The stored headers-mode credential — a proxied service with no envelope reads
 *  not-connected and is refused before dispatch, which no `outcome: "ok"` row could survive. */
const UPSTREAM_HEADERS = { Authorization: "Bearer FAKE0000-upstream-static-token" };

/** The bytes of an unstructured block. Obviously fake, and hunted by the file-wide sweep:
 *  §15 says a block's bytes are never stored, and this is the value that would prove it wrong. */
const BLOCK_BYTES = "FAKE0000-unstructured-block-bytes";

/**
 * Every secret the numbered cases plant, DECLARED — one object read by the case that plants
 * it and by the sweep that hunts it, so the two share a single spelling and the sweep is
 * complete no matter which cases ran. The table rows contribute their own `sentinels`; this
 * is for the ones a case invents.
 *
 * Data rather than residue on purpose: assembled by a `push` at the end of each case, "what
 * this file plants" would have no declared home — it would be reconstructed by execution
 * order, and a `-t`, a `.only` or a reordering would quietly shrink the sweep without
 * removing one assertion. Case 16's minted `pmcp_sa_` key is deliberately absent: the sweep
 * hunts the token grammar structurally (TOKEN_MATERIAL), so a runtime-minted credential
 * needs no registration to be caught.
 */
const PLANTED = {
  case8Password: "FAKE0000-case8-password",
  case8Nested: "FAKE0000-case8-nested",
  case9SessionKey: "FAKE0000-case9-session-key",
  case10Secret: "FAKE0000-case10-secret",
  case13InputResponse: "FAKE0000-case13-input-response",
  case13RequestState: "FAKE0000-case13-request-state",
  case14aUnmappedArg: "FAKE0000-case14a-unmapped-arg",
  case14aResultSecret: "FAKE0000-case14a-result-secret",
  case20Password: "FAKE0000-case20-password",
  case21Password: "FAKE0000-case21-password",
  case22First: "FAKE0000-case22-first",
  case22Second: "FAKE0000-case22-second",
  // §20.4's read families. Each is planted by exactly one case below and hunted by the
  // sweep like every other secret this suite invents — which is what makes "never reaches
  // any log, event, or stored body" a claim about the whole database rather than about
  // the one column its own case happened to look at.
  readAccessToken: "FAKE0000-read-access-token",
  readPromptPassword: "FAKE0000-read-prompt-password",
  readPromptMessage: "FAKE0000-read-prompt-message",
  readOversizePassword: "FAKE0000-read-oversize-password",
  readResourceBlob: "FAKE0000-read-resource-blob",
  readResourceSecret: "FAKE0000-read-resource-secret",
  readTunnelArgument: "FAKE0000-read-tunnel-argument",
} as const;

type BodyWorld = { ns: SeededNamespace; credential: string };

async function seedBodyWorld(row: AuditBodyRow, blocks: unknown[]): Promise<BodyWorld> {
  const upstream: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: [toolMarking(row.writeOnly)],
    result: {
      structuredContent: row.structuredContent,
      ...(blocks.length === 0 ? {} : { content: blocks }),
    },
  };
  const world = await seedProxyWorld({
    kind: row.kind,
    upstream,
    ...(row.logBodies === "default" ? {} : { logBodies: row.logBodies }),
    ...(row.configRedact.args.length === 0 ? {} : { redact: { [TOOL]: row.configRedact.args } }),
    ...(row.configRedact.results.length === 0
      ? {}
      : { redactResults: { [TOOL]: row.configRedact.results } }),
  });
  return world;
}

/**
 * A namespace with one service of the given kind and one account holding an allow-mode
 * wildcard grant on it — the least a `tools/call` needs. Proxied services are given their
 * stored credential here, through `setHeaders` and nothing else.
 */
async function seedProxyWorld(spec: {
  kind: ServiceKind;
  upstream: UpstreamScenario;
  logBodies?: boolean;
  redact?: Record<string, string[]>;
  redactResults?: Record<string, string[]>;
  mode?: "allow" | "approval";
}): Promise<BodyWorld> {
  const proxied = spec.kind === "proxy";
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SERVICE,
        kind: spec.kind,
        ...(proxied
          ? { upstreamUrl: upstreamUrlFor(spec.upstream), upstreamAuthMode: "headers" as const }
          : {}),
        ...(spec.logBodies === undefined ? {} : { logBodies: spec.logBodies }),
        ...(spec.redact === undefined ? {} : { redact: spec.redact }),
        ...(spec.redactResults === undefined ? {} : { redactResults: spec.redactResults }),
      },
    ],
    accounts: [
      {
        slug: ACCOUNT,
        grants: { [SERVICE]: [{ role: "all", mode: spec.mode ?? "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  if (proxied) {
    const service = await new Registry(env.DB).getService(ns.owner.userId, SERVICE);
    if (service === null) throw new Error("seedProxyWorld: the seeded service vanished");
    await setHeaders(service, UPSTREAM_HEADERS);
  }
  return { ns, credential: ns.tokens[TOKEN].token };
}

/** A tool whose schemas carry the row's `writeOnly` marks — a fixture INPUT: what the table
 *  asserts is what they CONTRIBUTE, which for a proxied service is nothing (§7). */
function toolMarking(marks: AuditBodyRow["writeOnly"]): Tool {
  return {
    name: TOOL,
    inputSchema: schemaMarking(marks.args),
    outputSchema: schemaMarking(marks.results),
  };
}

function schemaMarking(paths: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      paths.map((path) => [path, { type: "string", writeOnly: true }]),
    ),
  };
}

/** A real MCP content block for the row's declaration. The declared media type rides where
 *  the protocol puts it — `mimeType` on an image, `resource.mimeType` on a resource, nowhere
 *  at all on text — and the bytes are the sentinel that must never be stored. */
function mcpBlock(block: AuditBodyRow["blocks"][number]): unknown {
  if (block.type === "text") return { type: "text", text: BLOCK_BYTES };
  if (block.type === "image") {
    return { type: "image", mimeType: block.contentType, data: BLOCK_BYTES };
  }
  return {
    type: "resource",
    resource: { uri: "file:///fixture", mimeType: block.contentType, blob: BLOCK_BYTES },
  };
}

/** The row's arguments, grown FROM THE CAP IN FORCE when the row is an over-cap one — so
 *  "over-cap" survives a change to limits.AUDIT_BODY_CAP_BYTES with no edit here. */
function argsFor(row: AuditBodyRow, config: AuditConfig): Record<string, unknown> {
  if (row.bodySize === "under") return row.args;
  return { ...row.args, filler: "x".repeat(config.bodyCapBytes * 2) };
}

// ── driving the real endpoint, and reading the ledger back ────────────────────────────

type Answer = { status: number; body: { result?: Record<string, unknown>; error?: { code: number } } };

/** One `tools/call` through the composition root, exactly as a consumer makes it. */
async function callTool(
  ns: SeededNamespace,
  credential: string,
  slug: string,
  tool: string,
  args: Record<string, unknown>,
  extraParams: Record<string, unknown> = {},
): Promise<Answer> {
  return rpc(ns, credential, slug, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args, ...extraParams },
  });
}

/** One JSON-RPC message to a scoped endpoint, or — with `slug` absent — the aggregated one. */
async function rpc(
  ns: SeededNamespace,
  credential: string,
  slug: string | null,
  message: unknown,
): Promise<Answer> {
  const base = `${ORIGIN}/${ns.owner.username}/mcp`;
  const response = await worker.fetch(
    new Request(slug === null ? base : `${base}/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(message),
    }),
    env as unknown as Env,
  );
  return { status: response.status, body: (await response.json()) as Answer["body"] };
}

/** The newest `tools/call` row in a namespace, through the one read path §8 exposes. */
async function lastCallRow(ownerId: string): Promise<AuditRow> {
  const { rows } = await query(env.DB, ownerId, { event: "tools/call", limit: 1 });
  if (rows.length === 0) throw new Error("the call wrote no audit row");
  return rows[0];
}

async function countRows(ownerId: string, event: string): Promise<number> {
  return (await query(env.DB, ownerId, { event, limit: 1 })).total;
}

/** The raw D1 binding — for the two columns no read seam exposes (`approval.args_hash`, and
 *  the sweep's walk over every table there is). */
function d1(): D1Like {
  return env.DB as D1Like;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The value at a dot-path, in applyRedaction's own grammar. */
function valueAt(body: Record<string, unknown>, path: string): unknown {
  let node: unknown = body;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** SHA-256, hex — recomputed in-test so case 20 checks the stored hash against the rule and
 *  not against a second call into the code that produced it. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One event handed to §15's exception sink, and what must be left of it. The other three
 * hygiene sinks §15 names (logs, error responses, stored bodies) are pinned by the tables
 * and the sweep above; this is the fourth, and it is the only one that leaves the worker.
 *
 * `event` is deliberately the three carriers an SDK event actually has room for a secret
 * in — the request headers it attaches automatically, the message, and an exception's
 * value string. Bodies are not among them: §15 puts every persisted body in the two audit
 * columns and nowhere else, so an event never carries one and no row asks about it.
 *
 * `survives` is not decoration (§9 rule 2, the sharpest instance of it in this file): a
 * `beforeSend` that returned `null`, or blanked every string, satisfies `scrubbed`
 * perfectly and destroys the only production signal the hub has. Each row therefore names
 * something in the SAME field that must come through untouched.
 */
export type SentryScrubRow = {
  /** Spec sentence transcribed, printed in the test name (§8). */
  spec: string;
  /** Case title in the doc's convention, appended after `spec`. */
  title: string;
  /** The event as the SDK would hand it over, in the three places a secret can ride. */
  event: { headers?: Record<string, string>; message?: string; exceptionValue?: string };
  /** Substrings that must appear nowhere in the scrubbed event, at any depth. */
  scrubbed: string[];
  /** Substrings that must survive verbatim — the allow-twin of the row's own scrub. */
  survives: string[];
};

/**
 * The §15 exception-sink table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents write the type and the runner, never the
 * rows.
 *
 * Why this table exists at all, stated once: §15's hygiene sentence covers "logs, error
 * responses, and exception traces", and audit.ts — the hub's log-hygiene chokepoint — owns
 * `beforeSend`, the sink that carries the third. It is the one §15 sink with no
 * falsifiable case anywhere in the repo — an event carrying an `Authorization` header or a
 * `pmcp_sa_`/`pmcp_svc_` token would leave the worker with every suite green. The function
 * is pinned PURE and exported (`src/audit`'s `beforeSend`), so the Sentry SDK stays what
 * it is here: not a dependency. Every planted credential is spelled `FAKE0000-…` in the
 * house style, and these rows also feed the file-wide sweep's grammar check.
 */
export const SENTRY_SCRUB_ROWS: readonly SentryScrubRow[] = [
  {
    spec:
      "Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are redacted from logs, error responses, and exception traces.",
    title:
      "an event carrying the consumer's `Authorization` header leaves without it · the sibling request headers it needs for triage ride along untouched",
    event: {
      headers: {
        Authorization: "Bearer pmcp_sa_FAKE0000000000000000",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/1.2.3",
      },
    },
    scrubbed: ["pmcp_sa_FAKE0000000000000000", "Bearer pmcp_sa_FAKE0000000000000000"],
    survives: ["application/json", "claude-code/1.2.3"],
  },
  // The header is the easy half; the grammar is the half that matters, because a token
  // reaches an event through prose far more often than through a header — an error message
  // that echoes what it was given, a stack frame's argument.
  {
    spec:
      "Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are redacted from logs, error responses, and exception traces.",
    title:
      "a `pmcp_sa_` token embedded in the event MESSAGE is scrubbed by the grammar, not by the field it sat in · the surrounding prose survives, so the message still says what went wrong",
    event: { message: "token verification failed for pmcp_sa_FAKE0000000000000000 on /ahrzb/mcp" },
    scrubbed: ["pmcp_sa_FAKE0000000000000000"],
    survives: ["token verification failed", "/ahrzb/mcp"],
  },
  {
    spec:
      "Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are redacted from logs, error responses, and exception traces.",
    title:
      "a `pmcp_svc_` token inside an exception's value is scrubbed too — both halves of the `pmcp_(sa|svc)_` grammar, and the exception's own type and location survive",
    event: {
      exceptionValue: "connect rejected: service token pmcp_svc_FAKE0000000000000000 is revoked",
    },
    scrubbed: ["pmcp_svc_FAKE0000000000000000"],
    survives: ["connect rejected", "is revoked"],
  },
  // The allow-twin of the three above, and the reason none of them can be passed by a
  // scrubber that simply drops the event: an ordinary crash report has to arrive whole, or
  // the hub has bought its hygiene by going blind.
  {
    spec:
      "Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are redacted from logs, error responses, and exception traces.",
    title:
      "an event with no secret in it passes through UNCHANGED, event and headers alike — the twin that stops \"scrub\" from quietly meaning \"drop\", which would trade every production signal for a rule nothing else can check",
    event: {
      headers: { "Content-Type": "application/json", "User-Agent": "claude-code/1.2.3" },
      message: "D1_ERROR: no such column: upstream_auth_json",
      exceptionValue: "TypeError: cannot read properties of undefined (reading 'slug')",
    },
    scrubbed: [],
    survives: [
      "application/json",
      "claude-code/1.2.3",
      "D1_ERROR: no such column: upstream_auth_json",
      "TypeError: cannot read properties of undefined (reading 'slug')",
    ],
  },
];

/**
 * Registers one case per Sentry row: hand the row's event to the exported `beforeSend`,
 * then assert every `scrubbed` value is absent from the returned event at ANY depth
 * (serialize and search — a rule that only cleaned the fields it knew about is exactly the
 * regression this pins) and every `survives` value is present. Table-wide law: `beforeSend`
 * NEVER returns null or undefined for these rows — dropping the event is not an
 * implementation of scrubbing it.
 */
export function runSentryScrubTable(rows: readonly SentryScrubRow[]): void {
  // deps: src/audit (beforeSend — pure, exported; no Sentry SDK is imported anywhere)
  for (const row of rows) {
    it(`§15 · ${row.spec} · ${row.title}`, () => {
      const event = sentryEvent(row.event);
      const scrubbed = beforeSend(event);

      // The table-wide law, first: dropping an event satisfies every scrub rule and buys the
      // hygiene by going blind, which is the trade §15 is not making.
      expect(scrubbed, `${row.title}: beforeSend dropped the event`).not.toBeNull();
      expect(scrubbed, `${row.title}: beforeSend dropped the event`).not.toBeUndefined();

      // Serialized and searched at ANY depth: a scrubber that only cleaned the fields it
      // knew about is exactly the regression this pins.
      const left = JSON.stringify(scrubbed);
      for (const secret of row.scrubbed) {
        expect(left.includes(secret), `${row.title}: "${secret}" left the worker`).toBe(false);
      }
      for (const kept of row.survives) {
        expect(left.includes(kept), `${row.title}: "${kept}" was scrubbed away too`).toBe(true);
      }
    });
  }
}

/**
 * The row's three carriers, in the shape an SDK event actually has them: request headers it
 * attaches automatically, the message, and an exception's value string. Nested exactly as
 * the SDK nests them, so "at any depth" is a real depth and not a flat object.
 */
function sentryEvent(event: SentryScrubRow["event"]): Record<string, unknown> {
  return {
    ...(event.headers === undefined ? {} : { request: { url: `${ORIGIN}/ahrzb/mcp`, headers: event.headers } }),
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.exceptionValue === undefined
      ? {}
      : { exception: { values: [{ type: "Error", value: event.exceptionValue }] } }),
  };
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
  const tables = (
    await d1().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()
  ).results.filter(({ name }) => !PLATFORM_TABLE.test(name));
  const hits: SentinelHit[] = [];
  let reached = false;
  for (const { name } of tables) {
    const rows = (await d1().prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>())
      .results;
    rows.forEach((row, index) => {
      const rowId = String(row.id ?? index);
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        if (value.includes(control)) reached = true;
        for (const sentinel of sentinels) {
          if (value.includes(sentinel)) hits.push({ table: name, column, rowId, sentinel });
        }
        const material = TOKEN_MATERIAL.exec(value);
        if (material !== null) hits.push({ table: name, column, rowId, sentinel: material[0] });
      }
    });
  }
  // Non-vacuous by construction: a scan that cannot find what IS there proves nothing about
  // what is not, so a missing control is reported as a hit against the sweep itself.
  if (!reached) {
    hits.push({
      table: "(the sweep)",
      column: "(control)",
      rowId: "-",
      sentinel: `never found its control value "${control}" — the sweep reaches nothing`,
    });
  }
  return hits;
}

/**
 * Token MATERIAL, as opposed to the §5 display prefix. The length floor is what separates
 * them: `token.prefix` is deliberately stored and is only `PREFIX_DISPLAY_LENGTH` characters
 * (`pmcp_sa_` plus four), while a real credential's body is a base64url-encoded 256 bits. A
 * bare `pmcp_(sa|svc)_` search would report the column §5 designed, and a sweep that cries
 * wolf on its own schema is a sweep somebody switches off. The PREFIXES are not transcribed
 * here — they come from the leaf identity mints them out of, so a rotated or extended prefix
 * is hunted by this sweep the same day, rather than leaving it silently matching nothing.
 */
const TOKEN_MATERIAL = tokenPattern(16);

/**
 * D1's own bookkeeping, which the platform refuses to read at all (`SELECT` on `_cf_METADATA`
 * fails SQLITE_AUTH) and which no hub module writes a byte of. Excluded by NAME rather than
 * by catching the refusal, so a future table the hub does own can never be skipped because a
 * query against it happened to fail.
 */
const PLATFORM_TABLE = /^(?:_cf_|sqlite_)/;

/** Every case here seeds a namespace, drives a real request and reads D1 back; the budget is
 *  generous so a hang fails rather than flakes. */
const CASE_BUDGET_MS = 60_000;

describe("§15 · the audit body table", () => {
  for (const row of AUDIT_BODY_ROWS) {
    it(`1. §15 · ${row.spec} · ${row.title}`, () => runAuditBodyRow(row), CASE_BUDGET_MS);
  }

  it("2. §15 · the table covers both kinds in both log_bodies states (structural: the row set spans {tunnel, proxy} × {default, flipped}, so a new default can't go untested)", () => {
    for (const kind of ["tunnel", "proxy"] as const) {
      const rows = AUDIT_BODY_ROWS.filter((row) => row.kind === kind);
      expect(
        rows.some((row) => row.logBodies === "default"),
        `${kind} has no row exercising its by-kind default`,
      ).toBe(true);
      expect(
        rows.some((row) => typeof row.logBodies === "boolean"),
        `${kind} has no row exercising the flip`,
      ).toBe(true);
    }
  });
});

describe("§15 · log_bodies defaults by kind and flips both ways", () => {
  it("3. §15 · tunneled create with log_bodies absent stores it ON", async () => {
    const ns = await seedNamespace(env.DB, {});
    const service = await seedService(env.DB, ns.owner.userId, { slug: SERVICE, kind: "tunnel" });
    expect(service.logBodies).toBe(true);
  }, CASE_BUDGET_MS);

  it("4. §15 · proxied create with log_bodies absent stores it OFF", async () => {
    const ns = await seedNamespace(env.DB, {});
    const service = await seedService(env.DB, ns.owner.userId, {
      slug: SERVICE,
      kind: "proxy",
      upstreamUrl: upstreamUrlFor(healthyUpstream()),
    });
    expect(service.logBodies).toBe(false);
  }, CASE_BUDGET_MS);

  it("5. §15 · log_bodies flipped OFF on a tunneled service · its tools/call records no bodies", async () => {
    const world = await seedProxyWorld({
      kind: "tunnel",
      upstream: healthyUpstream(),
      logBodies: false,
    });
    const service = await new Registry(env.DB).getService(world.ns.owner.userId, SERVICE);
    expect(service?.logBodies, "the flip is honoured at create for tunneled services too").toBe(false);

    await callTool(world.ns, world.credential, SERVICE, TOOL, { note: "FAKE0000-flip-off-arg" });

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.args).toBeUndefined();
    expect(recorded.result).toBeUndefined();
  }, CASE_BUDGET_MS);

  it("6. §15 · log_bodies flipped ON for a proxied service · its tools/call records both bodies (the allow-twin of 5 — the flip is proven in both directions, not just off)", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-flip-on-result" }),
      logBodies: true,
    });

    await callTool(world.ns, world.credential, SERVICE, TOOL, { q: "visible-flip-on-arg" });

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.args, "the args column").toEqual({ q: "visible-flip-on-arg" });
    expect(recorded.result?.structuredContent, "the result column").toEqual({
      ok: "visible-flip-on-result",
    });
  }, CASE_BUDGET_MS);

  it("7. §15 · the builtin pmcp service records bodies with no row to configure (logBodies fixed ON)", async () => {
    const world = await seedPmcpWorld();

    await callTool(world.ns, world.credential, PMCP_SLUG, "token_list", {});

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.service, "the builtin has no D1 row and still records under its slug").toBe(
      PMCP_SLUG,
    );
    expect(recorded.args, "arguments, even an empty set").toEqual({});
    expect(recorded.result?.structuredContent, "and the result").toBeDefined();
  }, CASE_BUDGET_MS);
});

describe("§15 · what may reach the two body columns", () => {
  it("8. §7 · args recorded post-redaction: every union path masked, every sibling path verbatim", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-args-row-result" }),
      logBodies: true,
      redact: { [TOOL]: ["password", "credentials.token"] },
    });

    await callTool(world.ns, world.credential, SERVICE, TOOL, {
      q: "visible-args-row-query",
      password: PLANTED.case8Password,
      credentials: { token: PLANTED.case8Nested, user: "visible-args-row-user" },
    });

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.args).toEqual({
      q: "visible-args-row-query",
      password: REDACTED,
      credentials: { token: REDACTED, user: "visible-args-row-user" },
    });
  }, CASE_BUDGET_MS);

  it("9. §7 · result structuredContent recorded post-redaction under the results union (schema writeOnly ∪ config redact_results) · a non-marked field beside it verbatim", async () => {
    // The CONFIG half, on a proxied service — the only results source a proxied tool has (§7).
    const proxied = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({
        session: { key: PLANTED.case9SessionKey, id: "visible-case9-session-id" },
      }),
      logBodies: true,
      redactResults: { [TOOL]: ["session.key"] },
    });
    await callTool(proxied.ns, proxied.credential, SERVICE, TOOL, { q: "anything" });
    expect((await lastCallRow(proxied.ns.owner.userId)).result?.structuredContent).toEqual({
      session: { key: REDACTED, id: "visible-case9-session-id" },
    });

    // The SCHEMA half, on the one kind whose schemas the hub trusts here: the builtin, whose
    // token_issue marks its key `writeOnly` and nothing else.
    const builtin = await seedPmcpWorld();
    await issueKey(builtin);
    const structured = (await lastCallRow(builtin.ns.owner.userId)).result
      ?.structuredContent as Record<string, unknown>;
    expect(structured.token, "the writeOnly-marked field").toBe(REDACTED);
    expect(structured.kind, "a non-marked field beside it").toBe("service_account");
  }, CASE_BUDGET_MS);

  it('10. §15 · unstructured result blocks persist as blob stubs · the structuredContent beside them persists masked (never "all or nothing")', async () => {
    const blocks = [
      { type: "image", mimeType: "image/png", data: BLOCK_BYTES },
      { type: "text", text: BLOCK_BYTES },
    ];
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: {
        id: uniqueSlug("up"),
        mode: { kind: "ok" },
        tools: [toolMarking({ args: [], results: [] })],
        result: {
          structuredContent: { caption: "visible-case10-caption", secret: PLANTED.case10Secret },
          content: blocks,
        },
      },
      logBodies: true,
      redactResults: { [TOOL]: ["secret"] },
    });

    await callTool(world.ns, world.credential, SERVICE, TOOL, { q: "anything" });

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.result?.content, "type and size, never bytes").toEqual([
      { stub: "blob", contentType: "image/png", bytes: byteLength(JSON.stringify(blocks[0])) },
      { stub: "blob", bytes: byteLength(JSON.stringify(blocks[1])) },
    ]);
    expect(recorded.result?.structuredContent, "and the structured half beside them").toEqual({
      caption: "visible-case10-caption",
      secret: REDACTED,
    });
  }, CASE_BUDGET_MS);

  it("11. §15 · a body over the cap in force is replaced WHOLE by one oversize stub · an under-cap body of the same shape persists intact", async () => {
    const shrunk = auditConfigFor("shrunk");
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-case11-result" }),
      logBodies: true,
    });

    const over = { q: "x".repeat(shrunk.bodyCapBytes * 2) };
    await withCap(shrunk, () => callTool(world.ns, world.credential, SERVICE, TOOL, over));
    const oversize = await lastCallRow(world.ns.owner.userId);

    const under = { q: "visible-case11-arg" };
    await withCap(shrunk, () => callTool(world.ns, world.credential, SERVICE, TOOL, under));
    const intact = await lastCallRow(world.ns.owner.userId);

    expect(oversize.args, "the over-cap body, replaced whole").toEqual({
      stub: "oversize",
      bytes: byteLength(JSON.stringify(over)),
    });
    expect(
      oversize.result?.structuredContent,
      "each body is capped independently — the under-cap result column is untouched",
    ).toEqual({ ok: "visible-case11-result" });
    expect(intact.args, "the same shape under the cap").toEqual(under);
  }, CASE_BUDGET_MS);

  it("12. §15 · an over-cap column still parses as JSON — replaced, never truncated", async () => {
    const shrunk = auditConfigFor("shrunk");
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-case12-result" }),
      logBodies: true,
    });

    await withCap(shrunk, () =>
      callTool(world.ns, world.credential, SERVICE, TOOL, {
        q: "y".repeat(shrunk.bodyCapBytes * 2),
      }),
    );

    // The RAW column, not the parsed row: the read path would have thrown on truncated JSON
    // before an assertion could name it, and "still parses" is a claim about the bytes.
    const stored = await d1()
      .prepare(`SELECT args_json FROM audit WHERE owner_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(world.ns.owner.userId)
      .first<{ args_json: string }>();
    expect(() => JSON.parse(stored?.args_json ?? "")).not.toThrow();
    expect(JSON.parse(stored?.args_json ?? "").stub).toBe("oversize");
  }, CASE_BUDGET_MS);

  it("13. §7 · MRTR inputResponses/requestState never enter args_json while the same leg's params.arguments do", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-case13-result" }),
      logBodies: true,
    });

    await callTool(
      world.ns,
      world.credential,
      SERVICE,
      TOOL,
      { q: "visible-case13-arg" },
      {
        inputResponses: { secret: PLANTED.case13InputResponse },
        requestState: PLANTED.case13RequestState,
      },
    );

    const recorded = await lastCallRow(world.ns.owner.userId);
    expect(recorded.args, "params.arguments, and only those").toEqual({ q: "visible-case13-arg" });
  }, CASE_BUDGET_MS);

  it("14. §15 · tools/list writes no audit row at all · the tools/call beside it writes exactly one", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: "visible-case14-result" }),
      logBodies: true,
    });
    const before = await countRows(world.ns.owner.userId, "tools/call");

    await rpc(world.ns, world.credential, SERVICE, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(
      await countRows(world.ns.owner.userId, "tools/call"),
      "tools/list is out of the vocabulary, not merely filtered",
    ).toBe(before);

    await callTool(world.ns, world.credential, SERVICE, TOOL, { q: "anything" });
    expect(await countRows(world.ns.owner.userId, "tools/call"), "and a call writes one").toBe(
      before + 1,
    );
  }, CASE_BUDGET_MS);

  it('14a. §7 · a call on a SCHEMA-UNSOUND tool — one whose schema tripped §7\'s indirection refuse-line at catalog warm, so it has no derivable redaction map and sensitivePaths answers null — records no body in either column · the same call on the same tool with a walkable schema records both, masked (the allow-twin, and the reason "no redaction map" can never quietly degrade into "record it raw"). Which schemas are refused is unit/redact.test.ts\'s; that the warm stays loud and registration survives is tunnel/protocol.test.ts\'s; this row owns only what reaches D1.', async () => {
    // The D6 debt this row recorded is PAID: the producer is now the real one the title
    // names — a tool cached schema-unsound at catalog warm, answered null by
    // tunnel.sensitivePaths — rather than adminBackend's unknown-name null that stood in
    // for it while tunnel.ts was a skeleton. That costs this file its one socket (see the
    // header): §7's availability check precedes the redaction map, so an OFFLINE tunneled
    // service is refused -32000 and never reaches the law this row owns. Everything else
    // here is unchanged, the assertions included.
    //
    // A tunneled service is the right vehicle for a second reason: its log_bodies defaults
    // ON (§15), so "no body" has exactly one explanation — the null map — and none of the
    // flag.
    const world = await seedUnsoundTunnelWorld();
    try {
      const refused = await callTool(world.ns, world.credential, SERVICE, UNSOUND_TOOL, {
        note: PLANTED.case14aUnmappedArg,
      });
      expect(refused.body.error?.code, "a null map refuses as not-permitted (§7)").toBe(-32001);
      const unmapped = await lastCallRow(world.ns.owner.userId);
      expect(unmapped.args, "no derivable map, no body").toBeUndefined();
      expect(unmapped.result, "in either column").toBeUndefined();

      // The allow-twin, on a walkable schema: both columns land, masked at the marked path.
      await callTool(world.ns, world.credential, SERVICE, TOOL, { q: "visible-case14a-arg" });
      const mapped = await lastCallRow(world.ns.owner.userId);
      expect(mapped.args, "the twin records arguments").toBeDefined();
      expect(
        (mapped.result?.structuredContent as Record<string, unknown>).token,
        "…and a masked result",
      ).toBe(REDACTED);
    } finally {
      await world.close();
    }
  }, CASE_BUDGET_MS);
});

describe("§8/§15 · the uniform rule needs no pmcp special case", () => {
  it("15. §15 · token_issue's recorded result masks the key by the writeOnly rule · the row id and display prefix in the same result are recorded verbatim", async () => {
    const world = await seedPmcpWorld();

    const issued = await issueKey(world);

    const structured = (await lastCallRow(world.ns.owner.userId)).result
      ?.structuredContent as Record<string, unknown>;
    expect(structured.token, "the key, masked by the uniform rule").toBe(REDACTED);
    expect(structured.id, "the row id, verbatim").toBe(issued.id);
    expect(structured.prefix, "the display prefix, verbatim").toBe(issued.prefix);
  }, CASE_BUDGET_MS);

  it("16. §7 · the CALLER receives the plaintext key unredacted while the recorded body is masked (masking exists for persistence, never for the response)", async () => {
    const world = await seedPmcpWorld();

    const issued = await issueKey(world);

    expect(issued.token.startsWith("pmcp_sa_"), "the caller got a usable credential").toBe(true);
    expect(issued.token, "…unredacted").not.toBe(REDACTED);
    const structured = (await lastCallRow(world.ns.owner.userId)).result
      ?.structuredContent as Record<string, unknown>;
    expect(structured.token, "…and the ledger got none of it").toBe(REDACTED);
    // The strongest form of the claim needs no registration here: the file-wide sweep hunts
    // the token grammar structurally (TOKEN_MATERIAL), so this minted plaintext is already
    // in its scope whether or not this case ran.
  }, CASE_BUDGET_MS);
});

describe("§7 · served outputSchemas carry no writeOnly", () => {
  it("17. §7 · scoped tools/list strips writeOnly from every outputSchema · leaves inputSchema writeOnly intact (the input keyword is standard usage)", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: {
        id: uniqueSlug("up"),
        mode: { kind: "ok" },
        tools: [toolMarking({ args: ["apiKey"], results: ["issuedKey"] })],
      },
      logBodies: true,
    });

    const listed = await servedTool(world, SERVICE, TOOL);

    expect(JSON.stringify(listed.outputSchema), "the hub's internal marker reached the wire")
      .not.toContain("writeOnly");
    expect(JSON.stringify(listed.inputSchema), "…and standard input usage was stripped too")
      .toContain("writeOnly");
  }, CASE_BUDGET_MS);

  it("18. §7 · aggregated tools/list strips it identically — one strip, both shapes", async () => {
    const world = await seedProxyWorld({
      kind: "proxy",
      upstream: {
        id: uniqueSlug("up"),
        mode: { kind: "ok" },
        tools: [toolMarking({ args: ["apiKey"], results: ["issuedKey"] })],
      },
      logBodies: true,
    });

    const listed = await servedTool(world, null, `${SERVICE}_${TOOL}`);

    expect(JSON.stringify(listed.outputSchema)).not.toContain("writeOnly");
    expect(JSON.stringify(listed.inputSchema)).toContain("writeOnly");
  }, CASE_BUDGET_MS);

  it("19. §7 · stripping the served copy does not disarm redaction: the same tool's result is still masked at the marked path", async () => {
    const world = await seedPmcpWorld();

    const listed = await servedTool(world, PMCP_SLUG, "token_issue");
    expect(JSON.stringify(listed.outputSchema), "served without the marker").not.toContain(
      "writeOnly",
    );

    await issueKey(world);
    const structured = (await lastCallRow(world.ns.owner.userId)).result
      ?.structuredContent as Record<string, unknown>;
    expect(structured.token, "and still masked where it counts").toBe(REDACTED);
  }, CASE_BUDGET_MS);
});

describe("§7 · redaction precedes hashing", () => {
  it("20. §7 · the stored args_hash equals SHA-256(canonicalJson(applyRedaction(args, union))), recomputed in-test from the raw arguments", async () => {
    const world = await seedApprovalGatedWorld();
    const args = { q: "visible-case20-arg", password: PLANTED.case20Password };

    await callTool(world.ns, world.credential, SERVICE, TOOL, args);

    const [row] = await approvalRows(world.ns.owner.userId);
    expect(row.args_hash).toBe(
      await sha256Hex(canonicalJson(applyRedaction(args, ["password"]))),
    );
  }, CASE_BUDGET_MS);

  it("21. §7 · the stored args_hash does NOT equal the hash of the raw arguments — the proof that the order is redact-then-hash and not the reverse", async () => {
    const world = await seedApprovalGatedWorld();
    const args = { q: "visible-case21-arg", password: PLANTED.case21Password };

    await callTool(world.ns, world.credential, SERVICE, TOOL, args);

    const [row] = await approvalRows(world.ns.owner.userId);
    expect(row.args_hash).not.toBe(await sha256Hex(canonicalJson(args)));
  }, CASE_BUDGET_MS);

  it("22. §7 · two calls differing only in a redacted field share one approval row · two differing in a visible field never do", async () => {
    const world = await seedApprovalGatedWorld();

    await callTool(world.ns, world.credential, SERVICE, TOOL, {
      q: "same-visible",
      password: PLANTED.case22First,
    });
    await callTool(world.ns, world.credential, SERVICE, TOOL, {
      q: "same-visible",
      password: PLANTED.case22Second,
    });
    expect(
      (await approvalRows(world.ns.owner.userId)).length,
      "a redacted field cannot distinguish two calls — it is not in the binding",
    ).toBe(1);

    await callTool(world.ns, world.credential, SERVICE, TOOL, {
      q: "other-visible",
      password: PLANTED.case22First,
    });
    expect(
      (await approvalRows(world.ns.owner.userId)).length,
      "…and a visible one always does",
    ).toBe(2);
  }, CASE_BUDGET_MS);
});

describe("§15 · the exception sink (Sentry beforeSend, pinned without the SDK)", () => {
  runSentryScrubTable(SENTRY_SCRUB_ROWS);

  it("§15 · beforeSend is a PURE exported function and no Sentry SDK is imported: the hygiene rule is testable with the DSN unset and the dependency absent", () => {
    // The DSN is unset in this project, and nothing above needed it: the rule is a property
    // of a function, not of an integration, which is what makes it falsifiable at all.
    expect((env as unknown as Env).SENTRY_DSN, "this project runs with Sentry disabled")
      .toBeUndefined();

    const event = {
      request: { headers: { Authorization: "Bearer pmcp_sa_FAKE0000000000000000" } },
      message: "kept",
    };
    const snapshot = JSON.stringify(event);
    const once = beforeSend(event);
    const twice = beforeSend(event);

    expect(JSON.stringify(event), "beforeSend mutated the event it was handed").toBe(snapshot);
    expect(once, "…and is not deterministic").toEqual(twice);
    expect(once, "a returned event, never a dropped one").not.toBeNull();
  });
});

// ── the fixtures the numbered cases share ─────────────────────────────────────────────

/** A fake upstream that serves the one tool and answers with `structuredContent`. */
function healthyUpstream(structuredContent: Record<string, unknown> = {}): UpstreamScenario {
  return {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: [toolMarking({ args: [], results: [] })],
    result: { structuredContent },
  };
}

/**
 * Case 14a's world, and the only place this file holds a socket. A tunneled service, ONLINE
 * over a real `/connect` upgrade, whose cached catalog holds one tool §7's indirection
 * refuse-line rejects and one it can walk — the producer the case's title names, which no
 * socket-free surface can stand in for (the case says why). The account holds the built-in
 * `all` so the FILTER admits both tools and the refusal under test is the redaction map's.
 *
 * The catalog is warm when the pipeline serves both tools: an observable, polled, never a
 * sleep. `close` is the caller's obligation — a leaked socket outlives this file.
 */
async function seedUnsoundTunnelWorld(): Promise<BodyWorld & { close(): Promise<void> }> {
  const ns = await seedNamespace(env.DB, {
    services: [{ slug: SERVICE, kind: "tunnel", tokens: [{ as: "svc" }] }],
    accounts: [
      {
        slug: ACCOUNT,
        grants: { [SERVICE]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  const credential = ns.tokens[TOKEN].token;
  const close = await dialTunneledService(ns.tokens.svc.token);
  for (let turn = 0; turn < 250; turn++) {
    const listed = await rpc(ns, credential, SERVICE, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (((listed.body.result?.tools ?? []) as Tool[]).length === CASE_14A_CATALOG.length) {
      return { ns, credential, close };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await close();
  throw new Error("case 14a's catalog never warmed");
}

/**
 * One real service on the other end of §6's wire: it dials `/connect` through the running
 * worker, completes `hub/register`, serves the catalog and answers calls. Deliberately
 * hand-rolled rather than borrowed from `harness/fake-service`, whose header pins it to the
 * `tunnel` project — one case's socket must not import that project's assumptions.
 */
async function dialTunneledService(token: string): Promise<() => Promise<void>> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/connect`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    env as unknown as Env,
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(`/connect refused the upgrade: ${response.status}`);
  }
  socket.accept();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as { id?: unknown; method?: unknown };
    // Guarded: a warm the hub sends after this case's teardown would otherwise throw
    // "Can't call WebSocket send() after close()" as an uncaught exception in the runtime,
    // failing whichever unrelated case happens to be running when it lands.
    const reply = (result: unknown): void => {
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
      } catch {
        // the case that opened this socket has already closed it
      }
    };
    if (frame.method === "tools/list") {
      reply({ tools: CASE_14A_CATALOG });
    } else if (frame.method === "tools/call") {
      // The marked field the twin's row must store masked — planted, and hunted by the
      // file-wide sweep like every other secret this suite invents.
      reply({ structuredContent: { token: PLANTED.case14aResultSecret } });
    }
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "register",
      method: "hub/register",
      params: { clientVersion: "hygiene/0", protocolVersion: "2026-07-28", roles: {} },
    }),
  );
  return async () => {
    try {
      socket.close(1000, "case teardown");
    } catch {
      // already gone
    }
  };
}

/** The tool whose schema trips §7's indirection refuse-line — an external `$ref` the walk
 *  cannot resolve, so a `writeOnly` mark could be hiding behind it. WHICH constructs are
 *  refused is unit/redact.test.ts's; here it only has to be one of them. */
const UNSOUND_TOOL = "publish";

/** Case 14a's catalog: the unsound tool, and its walkable twin whose result carries one
 *  `writeOnly`-marked field. */
const CASE_14A_CATALOG: Tool[] = [
  {
    name: UNSOUND_TOOL,
    inputSchema: {
      type: "object",
      properties: { payload: { $ref: "https://example.invalid/schema.json#/payload" } },
    },
  },
  {
    name: TOOL,
    inputSchema: schemaMarking([]),
    outputSchema: schemaMarking(["token"]),
  },
];

/** A namespace whose owner can call the builtin — `pmcp` is owner-only (§8), so the
 *  credential is a real signed-in session's bearer token. */
async function seedPmcpWorld(): Promise<BodyWorld> {
  const ns = await seedNamespace(env.DB, { accounts: [{ slug: ACCOUNT }] });
  const { token } = await seedOwnerSession(ns.owner);
  return { ns, credential: token };
}

/** One `token_issue` through the builtin, answering what the CALLER was handed. */
async function issueKey(
  world: BodyWorld,
): Promise<{ id: string; token: string; prefix: string }> {
  const answer = await callTool(world.ns, world.credential, PMCP_SLUG, "token_issue", {
    kind: "service_account",
    slug: ACCOUNT,
  });
  const issued = answer.body.result?.structuredContent as
    | { id: string; token: string; prefix: string }
    | undefined;
  if (issued === undefined) {
    throw new Error(`token_issue failed: ${JSON.stringify(answer.body)}`);
  }
  return issued;
}

/** The tool as the hub SERVES it — scoped when `slug` is a string, aggregated when null. */
async function servedTool(world: BodyWorld, slug: string | null, name: string): Promise<Tool> {
  const answer = await rpc(world.ns, world.credential, slug, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const tools = (answer.body.result?.tools ?? []) as Tool[];
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`the listing served no "${name}": ${JSON.stringify(answer.body)}`);
  }
  return found;
}

/** A world whose one grant is approval-mode, so a call opens an approval row instead of
 *  dispatching — the only place `args_json` and `args_hash` exist. */
function seedApprovalGatedWorld(): Promise<BodyWorld> {
  return seedProxyWorld({
    kind: "proxy",
    upstream: healthyUpstream({ ok: "unreached" }),
    logBodies: true,
    redact: { [TOOL]: ["password"] },
    mode: "approval",
  });
}

/** The approval rows of one namespace, with the one column no read seam exposes. */
async function approvalRows(ownerId: string): Promise<{ id: string; args_hash: string }[]> {
  return (
    await d1()
      .prepare(`SELECT id, args_hash FROM approval WHERE owner_id = ?`)
      .bind(ownerId)
      .all<{ id: string; args_hash: string }>()
  ).results;
}

// ══ §20.4 — the read families in the ledger ═══════════════════════════════════════════
//
// §20 adds two AUDITED methods (`prompts/get`, `resources/read`) and four unaudited ones,
// and it is the only section that TIGHTENS a §15 rule rather than inheriting one: a
// resource URI is the row's `tool` column, it is caller-supplied and unbounded, and its
// query component is a routine carrier of somebody else's bearer token — which §15's
// scrubbing grammar, knowing only the hub's own `pmcp_(sa|svc)_` shape, would wave
// straight into a column any admin-token agent can read back for the whole retention
// window.
//
// Everything else the families need was already here: bodies ride the same `log_bodies`
// gate and the same envelope, and prompt messages and resource contents are content
// blocks, which §15 already stubs. The one genuine exception is prompt ARGUMENTS — a
// prompt has no JSON Schema and therefore no `writeOnly` channel, so §20.3 puts them on
// the PROXIED posture whatever the service's kind, and the tunneled row below is what
// makes that a rule rather than a coincidence of which fixture was cheapest.
//
// These cases sit outside AUDIT_BODY_ROWS deliberately: that table's columns are a
// `tools/call`'s two body columns, and half of what §20.4 pins lives in the `tool` column
// instead — one string, four different rules about it.

/**
 * The fake upstream's §20 seam, named here because the harness does not carry it yet —
 * the same declaration order.table.test.ts makes, narrowed to the families this file
 * plants secrets in. It lands as one change to `UpstreamScenario` and the deletion of
 * these lines; until then the cases below fail on their assertions.
 */
type ServingScenario = UpstreamScenario & {
  prompts?: Prompt[];
  /** Answered to `prompts/get` — the family's analogue of `result`. */
  promptResult?: unknown;
  resources?: Resource[];
  /** Served from `resources/templates/list`. */
  resourceTemplates?: ResourceTemplate[];
  /** Answered to `resources/read`. */
  readResult?: unknown;
  /** Answered to `completion/complete`. */
  completionResult?: unknown;
};

/** The prompt every read case asks for, and the resource URI beside it. */
const READ_PROMPT = "digest_daily";
const READ_URI = "news://feed/tech";

/**
 * The template and the completion answer the same service serves. They exist for exactly
 * one case — the four unaudited methods — and they exist because "no row" is only a
 * statement about the METHOD when the method had something to answer with: an upstream
 * serving no templates and no completions makes "wrote no row" and "was never
 * implemented" the same green.
 */
const READ_TEMPLATE = "news://feed/{id}";
const READ_COMPLETION_RESULT = { completion: { values: ["tech", "world"], hasMore: false } };

/** The tunneled fixture's second prompt: the one its service's `redact` map has an entry
 *  for. READ_PROMPT beside it has none, and the pair is what makes §20.3's rule
 *  ("log_bodies on AND a matching entry", kind-blind) tellable from "tunnels record
 *  nothing" and from a log_bodies default that moved. */
const REDACTED_PROMPT = "digest_redacted";

/**
 * A resource URI with a query component, and the same URI without one. Spelled as an
 * http(s) URI on purpose: `?access_token=` / `?sig=` / `?key=` is how the URIs that
 * actually carry credentials are shaped, and the rule exists for exactly those.
 */
const QUERYLESS_URI = "https://files.pmcp-test.invalid/notes/report.txt";
const QUERIED_URI = `${QUERYLESS_URI}?access_token=${PLANTED.readAccessToken}&harmless=keep`;

/** A `pmcp_sa_`-SHAPED string in a URI's path, where the query rule cannot reach it — so
 *  §15's own grammar is the only thing left that can keep it out of the column. */
const TOKEN_SHAPED_SEGMENT = "pmcp_sa_FAKE0000000000000000";

/** What a matched `prompts/get` answers by default. */
const READ_PROMPT_RESULT = {
  description: "the daily digest",
  messages: [{ role: "user", content: { type: "text", text: "summarize the feed" } }],
};

/** What a matched `resources/read` answers by default. */
const READ_RESOURCE_RESULT = {
  contents: [{ uri: READ_URI, mimeType: "text/plain", text: "tech headlines" }],
};

/** How one read world differs from the default — every field one override. */
type ReadWorldSpec = {
  /** `redact` entries, keyed by prompt name exactly as §20.3 keeps the map family-blind. */
  redact?: Record<string, string[]>;
  promptResult?: unknown;
  readResult?: unknown;
  /** The proxied service's virtual roles (default: none — the account holds `all`). */
  roles?: RoleDeclaration;
  grant?: GrantEntry[];
};

/**
 * A proxied service serving both read families with `log_bodies` ON, and one account on
 * it. Proxied and not tunneled for every case but one: §20.3 puts prompt arguments on the
 * proxied posture REGARDLESS of kind, so the proxied side is where the rule is cheapest
 * to state and the tunneled side (below) is where it is worth proving.
 */
async function seedReadWorld(spec: ReadWorldSpec = {}): Promise<BodyWorld> {
  const id = uniqueSlug("up");
  // The URL-encoded half stays MINIMAL — an id and a mode are all `upstreamUrlFor` needs
  // to route and to pick the unreachable scheme. Every per-family answer rides
  // registerOverride instead: §20.4's own "4 MB blob" case is exactly the payload a
  // URL-encoded scenario cannot carry without tripping a real HTTP 431 (fake-upstream.ts's
  // header), and every OTHER case in this file is small enough that the split costs it
  // nothing.
  await registerOverride(id, {
    tools: [toolMarking({ args: [], results: [] })],
    prompts: [{ name: READ_PROMPT, description: "the daily digest" }],
    promptResult: spec.promptResult ?? READ_PROMPT_RESULT,
    resources: [{ uri: READ_URI, name: "tech feed" }],
    resourceTemplates: [{ uriTemplate: READ_TEMPLATE, name: "one feed item" }],
    readResult: spec.readResult ?? READ_RESOURCE_RESULT,
    completionResult: READ_COMPLETION_RESULT,
  } satisfies Partial<ServingScenario>);
  const upstream: ServingScenario = { id, mode: { kind: "ok" } };
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SERVICE,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "headers",
        logBodies: true,
        ...(spec.roles === undefined ? {} : { roles: spec.roles }),
        ...(spec.redact === undefined ? {} : { redact: spec.redact }),
      },
    ],
    accounts: [
      {
        slug: ACCOUNT,
        grants: { [SERVICE]: spec.grant ?? [{ role: "all", mode: "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  const service = await new Registry(env.DB).getService(ns.owner.userId, SERVICE);
  if (service === null) throw new Error("seedReadWorld: the seeded service vanished");
  await setHeaders(service, UPSTREAM_HEADERS);
  return { ns, credential: ns.tokens[TOKEN].token };
}

/** One scoped `prompts/get`, exactly as a consumer makes it. */
async function getPromptThrough(
  world: BodyWorld,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Answer> {
  return rpc(world.ns, world.credential, SERVICE, {
    jsonrpc: "2.0",
    id: 1,
    method: "prompts/get",
    params: { name, arguments: args },
  });
}

/** One scoped `resources/read`. */
async function readThrough(world: BodyWorld, uri: string): Promise<Answer> {
  return rpc(world.ns, world.credential, SERVICE, {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  });
}

/** The newest row of one EVENT in a namespace, through the one read path §8 exposes. */
async function lastRow(ownerId: string, event: string): Promise<AuditRow> {
  const { rows } = await query(env.DB, ownerId, { event, limit: 1 });
  if (rows.length === 0) throw new Error(`no "${event}" audit row was written`);
  return rows[0];
}

/**
 * Every size stub inside a stored body, at any depth.
 *
 * Depth-first rather than keyed, because §15 pins the stub SHAPE and §20.4 pins that
 * prompt messages and resource contents become stubs — neither pins which key of the
 * stored envelope holds them for a family whose result carries `messages` or `contents`
 * rather than `content`. Asserting on the stubs themselves states everything the spec
 * says and freezes nothing it leaves open.
 */
function stubsIn(body: unknown): BodyStub[] {
  const found: BodyStub[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.stub === "string") {
      found.push(record as unknown as BodyStub);
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(body);
  return found;
}

describe("§20.4 · what a read writes into the tool column", () => {
  it("§20.4 · prompts/get writes an audit row whose event is \"prompts/get\" and whose tool column is the prompt name", async () => {
    const world = await seedReadWorld();

    const answer = await getPromptThrough(world, READ_PROMPT, { topic: "visible-read-topic" });
    expect(answer.body.error, JSON.stringify(answer.body.error)).toBeUndefined();

    const recorded = await lastRow(world.ns.owner.userId, "prompts/get");
    expect(recorded.event, "the method IS the event (§15's vocabulary, extended)").toBe("prompts/get");
    expect(recorded.tool, "the prompt name, where a call puts its tool name").toBe(READ_PROMPT);
    expect(recorded.service).toBe(SERVICE);
    expect(recorded.outcome).toBe("ok");
    expect(typeof recorded.durationMs, "audited like a call, timing included").toBe("number");
  }, CASE_BUDGET_MS);

  it("§20.4 · resources/read writes an audit row whose tool column is the resource URI with its query component replaced by \"?…\" · the scheme, host and path survive intact (the twin)", async () => {
    const world = await seedReadWorld();

    // The one place the SPELLING is pinned, the way web-pages.test.ts pins `‹redacted›`
    // once and reads the name everywhere else: §20.4 names the literal `?…`, and without
    // this line a hub that wrote `?`, `?<redacted>`, or dropped the component with no
    // marker at all is green in every assertion that reads the constant.
    expect(REDACTED_QUERY, "§20.4 pins the replacement's spelling").toBe("?…");

    await readThrough(world, QUERIED_URI);
    const queried = await lastRow(world.ns.owner.userId, "resources/read");
    expect(queried.event).toBe("resources/read");
    expect(queried.tool?.startsWith(QUERYLESS_URI), "what an owner reads the row for survives")
      .toBe(true);
    expect(queried.tool).toBe(`${QUERYLESS_URI}${REDACTED_QUERY}`);

    // The twin: the rule is about the QUERY, so a URI that has none is stored as it is —
    // a stripper that mangled every URI would satisfy the half above and destroy the column.
    await readThrough(world, QUERYLESS_URI);
    expect((await lastRow(world.ns.owner.userId, "resources/read")).tool).toBe(QUERYLESS_URI);
  }, CASE_BUDGET_MS);

  it("§20.4 · a resource URI carrying ?access_token=… never reaches audit.tool with the value — the query is dropped before the row is written, not scrubbed by pattern", async () => {
    const world = await seedReadWorld();

    await readThrough(world, QUERIED_URI);

    const recorded = await lastRow(world.ns.owner.userId, "resources/read");
    expect(recorded.tool, "the credential").not.toContain(PLANTED.readAccessToken);
    // The half that says DROPPED rather than scrubbed: the innocuous parameter beside it
    // goes too. A pattern-based scrubber keeps `harmless=keep` and therefore keeps every
    // credential parameter nobody thought to name.
    expect(recorded.tool, "the whole component, not the parts a pattern recognized")
      .not.toContain("harmless");
    expect(JSON.stringify(recorded), "and it reached no other column either")
      .not.toContain(PLANTED.readAccessToken);
  }, CASE_BUDGET_MS);

  it("§20.4 · a resource URI longer than 1 KiB is capped in audit.tool, like every other caller-supplied string the hub persists", async () => {
    // Grown FROM the cap in force, never written as a length: a change to
    // limits.AUDIT_URI_CAP_BYTES moves the fixture and the assertion together. ASCII
    // throughout, so "1 KiB" and "1024 characters" are the same statement here.
    const world = await seedReadWorld();
    const long = `${QUERYLESS_URI}/${"a".repeat(AUDIT_URI_CAP_BYTES)}`;

    await readThrough(world, long);

    const recorded = await lastRow(world.ns.owner.userId, "resources/read");
    expect(byteLength(recorded.tool ?? ""), "the column is bounded").toBeLessThanOrEqual(
      AUDIT_URI_CAP_BYTES,
    );
    expect(recorded.tool, "capped, never replaced — the readable head survives").toBe(
      long.slice(0, AUDIT_URI_CAP_BYTES),
    );
  }, CASE_BUDGET_MS);

  it("§20.4 · prompts/list, resources/list, resources/templates/list and completion/complete write no audit row — including a completion/complete that was refused -32001", async () => {
    // The four listing-class methods, on a caller who can see everything. Each one's
    // answer is read before the count is: an unimplemented `resources/templates/list`
    // writes no audit row either, and so does a scoped `prompts/list` that threw — so
    // without these assertions "no row" is satisfied by the absence of the very feature
    // this case is about.
    const world = await seedReadWorld();
    const before = (await query(env.DB, world.ns.owner.userId, { limit: 200 })).total;
    const listings: [string, (result: Record<string, unknown>) => unknown][] = [
      ["prompts/list", (result) => result.prompts],
      ["resources/list", (result) => result.resources],
      ["resources/templates/list", (result) => result.resourceTemplates],
    ];
    for (const [method, served] of listings) {
      const listed = await rpc(world.ns, world.credential, SERVICE, { jsonrpc: "2.0", id: 1, method });
      expect(listed.body.error, method).toBeUndefined();
      expect(served(listed.body.result ?? {}) as unknown[], `${method} answered nothing`)
        .toHaveLength(1);
    }
    const completed = await rpc(world.ns, world.credential, SERVICE, {
      jsonrpc: "2.0",
      id: 1,
      method: "completion/complete",
      params: { ref: { type: "ref/prompt", name: READ_PROMPT }, argument: { name: "topic", value: "te" } },
    });
    expect(completed.body.error, "completion/complete").toBeUndefined();
    expect((completed.body.result as { completion?: unknown }).completion).toEqual(
      READ_COMPLETION_RESULT.completion,
    );
    expect(
      (await query(env.DB, world.ns.owner.userId, { limit: 200 })).total,
      "listings are agent polling noise, in every family",
    ).toBe(before);

    // …and the refusal, which is the half a "record what was denied" instinct would add:
    // §20.2 decides the posture rather than inheriting it — a row per keystroke is noise,
    // and the refusal is what makes the method safe in the first place.
    const limited = await seedReadWorld({
      roles: { reader: [TOOL] },
      grant: [{ role: "reader", mode: "allow" }],
    });
    const beforeRefusal = (await query(env.DB, limited.ns.owner.userId, { limit: 200 })).total;
    const refused = await rpc(limited.ns, limited.credential, SERVICE, {
      jsonrpc: "2.0",
      id: 1,
      method: "completion/complete",
      params: { ref: { type: "ref/prompt", name: READ_PROMPT }, argument: { name: "topic", value: "te" } },
    });
    expect(refused.body.error?.code).toBe(-32001);
    expect(
      (await query(env.DB, limited.ns.owner.userId, { limit: 200 })).total,
      "a refused completion is still a listing",
    ).toBe(beforeRefusal);
  }, CASE_BUDGET_MS);

  it("§20.4 · a resource URI carrying a pmcp_sa_-shaped substring is scrubbed by §15's grammar before it is logged", async () => {
    // In the PATH, where the query rule cannot reach it: §15's "token material never, in
    // any column" is the only thing standing between this string and a column
    // `audit_query` serves and the JSONL export ships.
    const world = await seedReadWorld();
    const uri = `${QUERYLESS_URI}/${TOKEN_SHAPED_SEGMENT}`;

    await readThrough(world, uri);

    const recorded = await lastRow(world.ns.owner.userId, "resources/read");
    expect(recorded.tool).not.toContain(TOKEN_SHAPED_SEGMENT);
    expect(recorded.tool, "masked by the same sentinel every other secret gets").toContain(REDACTED);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN_SHAPED_SEGMENT);
  }, CASE_BUDGET_MS);
});

describe("§20.4 · what a read writes into the two body columns", () => {
  it("§20.4 · a prompt argument matched by the service's redact map is masked in the stored body · the caller's live reply still carries it (the twin)", async () => {
    // §20.3 keeps the redaction map family-blind: the same `redact:` entry that covers a
    // tool covers a prompt of that name. The owner having written it is the declaration
    // that stands in for the schema a prompt does not have.
    const world = await seedReadWorld({
      redact: { [READ_PROMPT]: ["password"] },
      // The service's own answer carries the same secret, so "the live reply still carries
      // it" is a fact about the wire rather than an echo the fixture arranged.
      promptResult: {
        description: "the daily digest",
        messages: [
          { role: "user", content: { type: "text", text: PLANTED.readPromptPassword } },
        ],
      },
    });

    const answer = await getPromptThrough(world, READ_PROMPT, {
      topic: "visible-redact-row-topic",
      password: PLANTED.readPromptPassword,
    });

    const recorded = await lastRow(world.ns.owner.userId, "prompts/get");
    expect(recorded.args).toEqual({ topic: "visible-redact-row-topic", password: REDACTED });
    expect(
      JSON.stringify(answer.body).includes(PLANTED.readPromptPassword),
      "masking exists for persistence, never for the wire (§7)",
    ).toBe(true);
  }, CASE_BUDGET_MS);

  it("§20.4 · a prompts/get on a service with no redact entry for that prompt records NO arguments body, even on a tunneled service with log_bodies on — prompts carry no writeOnly channel, so they take the proxied posture (§20.3) · the row itself, its outcome and the prompt name are still written (the twin)", async () => {
    // A TUNNELED service, online over a real socket, whose log_bodies defaults ON — the
    // only fixture in which "no arguments body" has exactly one explanation. On a proxied
    // service the flag alone would explain it, and the rule §20.3 is stating would be
    // indistinguishable from §15's existing default.
    const world = await seedPromptTunnelWorld();
    try {
      const answer = await getPromptThrough(world, READ_PROMPT, {
        note: PLANTED.readTunnelArgument,
      });
      expect(answer.body.error, JSON.stringify(answer.body.error)).toBeUndefined();

      const recorded = await lastRow(world.ns.owner.userId, "prompts/get");
      expect(recorded.args, "no redact entry, no arguments — whatever log_bodies says")
        .toBeUndefined();
      // The twin: not recording the arguments is not the same as not recording the read.
      expect(recorded.tool).toBe(READ_PROMPT);
      expect(recorded.outcome).toBe("ok");
      expect(recorded.principal).toBe(`sa:${ACCOUNT}`);

      // …and the leg that turns "even on a tunneled service with log_bodies on" from a
      // comment into an assertion: the SAME socket, the same service, one prompt the
      // service's redact map does name. Without it, a hub that recorded no prompt
      // arguments on a tunneled service at all passes above — and §20.3 pins the rule
      // kind-blind — as would a tunnel `log_bodies` default that quietly flipped OFF.
      const named = await getPromptThrough(world, REDACTED_PROMPT, {
        note: PLANTED.readTunnelArgument,
      });
      expect(named.body.error, JSON.stringify(named.body.error)).toBeUndefined();
      expect(
        (await lastRow(world.ns.owner.userId, "prompts/get")).args,
        "log_bodies IS on: an entry-carrying prompt records its arguments, masked",
      ).toEqual({ note: REDACTED });
    } finally {
      await world.close();
    }
  }, CASE_BUDGET_MS);

  it("§20.4 · a prompts/get result's message content blocks are stored as typed size stubs, never as text", async () => {
    // An image block, so "typed" is a fact the stub carries rather than an absence: the
    // declared media type rides where the protocol puts it, and the bytes ride nowhere.
    const content = { type: "image", mimeType: "image/png", data: PLANTED.readPromptMessage };
    const world = await seedReadWorld({
      redact: { [READ_PROMPT]: ["password"] },
      promptResult: { description: "the daily digest", messages: [{ role: "user", content }] },
    });

    await getPromptThrough(world, READ_PROMPT, { topic: "visible-stub-row-topic" });

    const recorded = await lastRow(world.ns.owner.userId, "prompts/get");
    expect(stubsIn(recorded.result), "one typed size stub per message content block").toEqual([
      { stub: "blob", contentType: "image/png", bytes: byteLength(JSON.stringify(content)) },
    ]);
    expect(JSON.stringify(recorded), "never as text").not.toContain(PLANTED.readPromptMessage);
  }, CASE_BUDGET_MS);

  it("§20.4 · a resources/read result's contents are stored as stubs — a 4 MB blob records its size and type, never its bytes", async () => {
    // Sized from limits.AUDIT_BODY_CAP_BYTES rather than literally 4 MB: what the rule
    // needs is a block far past the body cap, so the row also states the ORDER — blocks
    // are stubbed BEFORE the cap is applied, or a large one would come back as a single
    // `oversize` stub and its type and size would be lost with it.
    const blob = `${PLANTED.readResourceBlob}${"F".repeat(AUDIT_BODY_CAP_BYTES * 4)}`;
    const contents = [{ uri: READ_URI, mimeType: "image/png", blob }];
    const world = await seedReadWorld({ readResult: { contents } });

    await readThrough(world, READ_URI);

    const recorded = await lastRow(world.ns.owner.userId, "resources/read");
    expect(stubsIn(recorded.result), "its size and its type").toEqual([
      { stub: "blob", contentType: "image/png", bytes: byteLength(JSON.stringify(contents[0])) },
    ]);
    expect(JSON.stringify(recorded), "never its bytes").not.toContain(PLANTED.readResourceBlob);
  }, CASE_BUDGET_MS);

  it("§20.4 · an over-cap prompts/get body is replaced whole by an oversize stub", async () => {
    // The redact entry is load-bearing: without one there is no arguments body to be over
    // the cap at all (the row above), and this case would pass by recording nothing.
    const shrunk = auditConfigFor("shrunk");
    const world = await seedReadWorld({ redact: { [READ_PROMPT]: ["password"] } });
    const args = {
      password: PLANTED.readOversizePassword,
      filler: "x".repeat(shrunk.bodyCapBytes * 2),
    };

    await withCap(shrunk, () => getPromptThrough(world, READ_PROMPT, args));

    const recorded = await lastRow(world.ns.owner.userId, "prompts/get");
    expect(recorded.args, "replaced whole — never truncated into corrupt JSON").toEqual({
      stub: "oversize",
      bytes: byteLength(JSON.stringify(applyRedaction(args, ["password"]))),
    });
  }, CASE_BUDGET_MS);

  it("§20.4 · a planted fake secret in a resource's contents never reaches any log, event, or stored body", async () => {
    const world = await seedReadWorld({
      readResult: {
        contents: [{ uri: READ_URI, mimeType: "text/plain", text: PLANTED.readResourceSecret }],
      },
    });

    const answer = await readThrough(world, READ_URI);
    expect(
      JSON.stringify(answer.body).includes(PLANTED.readResourceSecret),
      "the caller still receives what they read",
    ).toBe(true);

    const rows = await query(env.DB, world.ns.owner.userId, { limit: 200 });
    expect(JSON.stringify(rows.rows), "and the ledger receives none of it").not.toContain(
      PLANTED.readResourceSecret,
    );
    // The whole-database half is the sweep's: this value is one field of PLANTED, so case
    // 23 hunts it in every column of every table whether or not this case ran.
  }, CASE_BUDGET_MS);
});

/**
 * The tunneled prompt world, and the second socket this file holds (case 14a's is the
 * other). A service ONLINE over a real `/connect` upgrade, answering `prompts/get` over
 * the wire — the only fixture in which §20.3's "prompt arguments take the proxied posture
 * REGARDLESS of the service's kind" can be told apart from §15's proxied default.
 *
 * `close` is the caller's obligation: a leaked socket outlives this file.
 */
async function seedPromptTunnelWorld(): Promise<BodyWorld & { close(): Promise<void> }> {
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: SERVICE,
        kind: "tunnel",
        // An entry for ONE of the two prompts this socket serves, and `log_bodies` left at
        // the tunneled default (§15: ON). That pair is the whole fixture: the entry-less
        // prompt records no arguments and the entry-carrying one records them masked, so
        // the flag's state is observed rather than assumed.
        redact: { [REDACTED_PROMPT]: ["note"] },
        tokens: [{ as: "svc" }],
      },
    ],
    accounts: [
      {
        slug: ACCOUNT,
        // The built-in `all` spans every family (§20.3) and needs no declaration — which
        // is what lets this fixture register with no roles at all and still be granted a
        // prompt the service never declared a pattern for.
        grants: { [SERVICE]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  const credential = ns.tokens[TOKEN].token;
  const close = await dialPromptTunnel(ns.tokens.svc.token);
  // Warm is observable, never slept for: the pipeline serving the catalog IS registration
  // having completed.
  for (let turn = 0; turn < 250; turn++) {
    const listed = await rpc(ns, credential, SERVICE, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (((listed.body.result?.tools ?? []) as Tool[]).length === 1) {
      return { ns, credential, close };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await close();
  throw new Error("the tunneled prompt service never registered");
}

/**
 * One real service on the other end of §6's wire, serving one tool and one prompt.
 * Hand-rolled for the reason case 14a's is: `harness/fake-service` is pinned to the
 * `tunnel` project, and one case's socket must not import that project's assumptions.
 *
 * It answers §6's registration-time `server/discover` with **-32601** deliberately. That
 * is §20.5's compatibility fallback — the leg that keeps every service already in the
 * field alive — so this fixture exercises the path a deployed service actually takes, and
 * this file states nothing about the discover answer's shape, which is tunnel/**'s.
 */
async function dialPromptTunnel(token: string): Promise<() => Promise<void>> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/connect`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    env as unknown as Env,
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(`/connect refused the upgrade: ${response.status}`);
  }
  socket.accept();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as {
      id?: unknown;
      method?: unknown;
    };
    const answer = (body: Record<string, unknown>) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
    if (frame.method === "server/discover") {
      answer({ error: { code: -32601, message: "method not found" } });
    } else if (frame.method === "tools/list") {
      answer({ result: { tools: [toolMarking({ args: [], results: [] })] } });
    } else if (frame.method === "prompts/list") {
      answer({
        result: {
          prompts: [
            { name: READ_PROMPT, description: "the daily digest" },
            { name: REDACTED_PROMPT, description: "the digest the redact map names" },
          ],
        },
      });
    } else if (frame.method === "prompts/get") {
      answer({ result: READ_PROMPT_RESULT });
    }
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "register",
      method: "hub/register",
      params: { clientVersion: "hygiene/0", protocolVersion: "2026-07-28", roles: {} },
    }),
  );
  return async () => {
    try {
      socket.close(1000, "case teardown");
    } catch {
      // already gone
    }
  };
}

// ══ §21.6 — the two subscription rows, and everything push does NOT record ════════════
//
// §21.6 splits push into two postures. `resources/subscribe` and `resources/unsubscribe`
// write rows LIKE A READ — rare, deliberate, and they name a URI, which is exactly the
// sensitivity `resources/read` records — so they inherit §20.4's URI hygiene whole: the
// query component dropped to `REDACTED_QUERY`, the column capped at AUDIT_URI_CAP_BYTES,
// §15's token grammar scrubbed, and no bodies (there are none to carry). Streams,
// doorbells and `updated` relays write NOTHING: listing-class, §15's polling-noise rule.
//
// Both methods are TUNNELED-only (§21.4), so this section holds the file's third socket —
// hand-rolled for the reason the other two are, and closed inside each case. `log_bodies`
// is left at the tunneled default (ON), which is what makes "no bodies" a decision about
// these methods rather than a flag that happened to be off.

/** The URI the subscribe cases name, and the catalog entry behind it. */
const SUBSCRIBED_URI = READ_URI;

/** One §21.6 world: a tunneled service ONLINE over a real `/connect` upgrade, one account
 *  holding the built-in wildcard on it (so every URI passes the filter, §20.3), plus the two
 *  provocations §21.6's negative row needs — a catalog change, and one `updated`. */
type PushWorld = BodyWorld & {
  close(): Promise<void>;
  /** Change the stored resource catalog and tell the hub: one doorbell. */
  ring(): Promise<void>;
  /** Emit one `notifications/resources/updated` for `uri`. */
  update(uri: string): Promise<void>;
};

async function seedPushTunnelWorld(): Promise<PushWorld> {
  const ns = await seedNamespace(env.DB, {
    services: [{ slug: SERVICE, kind: "tunnel", tokens: [{ as: "svc" }] }],
    accounts: [
      {
        // The built-in `all` spans every family and needs no declaration (§20.3), which is
        // what lets this fixture register with no roles and still pass a URI filter.
        slug: ACCOUNT,
        grants: { [SERVICE]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: TOKEN }],
      },
    ],
  });
  const credential = ns.tokens[TOKEN].token;
  const service = await dialPushTunnel(ns.tokens.svc.token);
  // Registration is observable, never slept for: the pipeline serving the catalog IS
  // registration having completed.
  for (let turn = 0; turn < 250; turn++) {
    const listed = await rpc(ns, credential, SERVICE, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (((listed.body.result?.tools ?? []) as Tool[]).length === 1) {
      return { ns, credential, ...service };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await service.close();
  throw new Error("the tunneled push service never registered");
}

/**
 * One real service on §6's wire that answers `resources/subscribe` and its mirror natively
 * (§21.4: "the author's SDK answers it natively, so neither client library changes"), and
 * can be told to change its resource catalog or emit one `updated`. Its registration-time
 * `server/discover` answers -32601 — §20.5's compatibility fallback — so this file states
 * nothing about that answer's shape, which is tunnel/**'s.
 */
async function dialPushTunnel(token: string): Promise<Pick<PushWorld, "close" | "ring" | "update">> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/connect`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    env as unknown as Env,
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(`/connect refused the upgrade: ${response.status}`);
  }
  socket.accept();
  // The catalog the hub re-lists on a `list_changed`; `ring` grows it, which is what makes
  // the re-warm a CHANGE and therefore a bell (§21.3 — a re-list that changes nothing rings).
  let resources: { uri: string; name: string }[] = [];
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    const frame = JSON.parse(data) as { id?: unknown; method?: unknown };
    // A warm whose answer arrives after the case closed this socket is a teardown race, not
    // a fixture failure: the send is guarded so it cannot surface as an uncaught exception.
    const answer = (body: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
      } catch {
        // already closed
      }
    };
    if (frame.method === "server/discover") {
      answer({ error: { code: -32601, message: "method not found" } });
    } else if (frame.method === "tools/list") {
      answer({ result: { tools: [toolMarking({ args: [], results: [] })] } });
    } else if (frame.method === "prompts/list") {
      answer({ result: { prompts: [] } });
    } else if (frame.method === "resources/list") {
      answer({ result: { resources } });
    } else if (frame.method === "resources/templates/list") {
      answer({ result: { resourceTemplates: [] } });
    } else if (frame.method === "resources/subscribe" || frame.method === "resources/unsubscribe") {
      answer({ result: { resultType: "complete" } });
    }
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "register",
      method: "hub/register",
      params: { clientVersion: "hygiene-push/0", protocolVersion: "2026-07-28", roles: {} },
    }),
  );
  return {
    close: async () => {
      try {
        socket.close(1000, "case teardown");
      } catch {
        // already gone
      }
    },
    ring: async () => {
      resources = [...resources, { uri: `${SUBSCRIBED_URI}/${resources.length}`, name: "entry" }];
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" }));
    },
    update: async (uri: string) => {
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } }),
      );
    },
  };
}

/** One `resources/subscribe`/`unsubscribe` through the real endpoint. `session` is §21.4's
 *  one consumer-supplied header; absent, the DO matches no stream, stores nothing, and
 *  forwards anyway — which is a legal MCP request and an audited one. */
async function subscribeThrough(
  world: BodyWorld,
  method: "resources/subscribe" | "resources/unsubscribe",
  uri: string,
  session?: string,
): Promise<Answer> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/${world.ns.owner.username}/mcp/${SERVICE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${world.credential}`,
        ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { uri } }),
    }),
    env as unknown as Env,
  );
  return { status: response.status, body: (await response.json()) as Answer["body"] };
}

/** One held listen stream, reduced to what §21.6's negative row needs of it: the minted
 *  session id, whether a given notification arrived, and a way to end it. */
type OpenStream = {
  sessionId: string;
  received(method: string): Promise<boolean>;
  cancel(): Promise<void>;
};

async function openStream(world: BodyWorld): Promise<OpenStream> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/${world.ns.owner.username}/mcp/${SERVICE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${world.credential}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen" }),
    }),
    env as unknown as Env,
  );
  const sessionId = response.headers.get("Mcp-Session-Id");
  const body = response.body;
  if (sessionId === null || body === null) {
    throw new Error(`the listen answer carried no stream: ${response.status}`);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled body is an ended stream, which is all this row needs of it.
    }
  };
  void pump();
  return {
    sessionId,
    // REAL time, deliberately: workerd is the runtime under test, vitest's fake timers do
    // not reach inside it, and what is waited on is a frame crossing two real sockets — the
    // loop exits on the frame itself, never on a duration.
    received: async (method: string) => {
      const deadline = Date.now() + 2_000;
      while (!text.includes(method) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return text.includes(method);
    },
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe("§21.6 · what push writes, and what it does not", () => {
  it("§21.6 · resources/subscribe writes a row like a read — event carries the method, the URI in the tool column with its query dropped to audit.REDACTED_QUERY and capped at AUDIT_URI_CAP_BYTES, no bodies · resources/unsubscribe writes its own the same way (the twin)", async () => {
    const world = await seedPushTunnelWorld();
    try {
      // The QUERY, first: a resource URI's query string is a routine carrier of somebody
      // else's bearer token, and §21.6 inherits §20.4's rule rather than restating it.
      const subscribed = await subscribeThrough(world, "resources/subscribe", QUERIED_URI);
      expect(subscribed.body.error, JSON.stringify(subscribed.body.error)).toBeUndefined();

      const sub = await lastRow(world.ns.owner.userId, "resources/subscribe");
      expect(sub.event, "the method IS the event (§15's vocabulary, extended again)").toBe(
        "resources/subscribe",
      );
      expect(sub.tool, "the URI, where a read puts its own").toBe(
        `${QUERYLESS_URI}${REDACTED_QUERY}`,
      );
      expect(sub.tool).not.toContain(PLANTED.readAccessToken);
      expect(sub.service).toBe(SERVICE);
      expect(sub.outcome).toBe("ok");
      // No bodies, with log_bodies at the tunneled default ON: there are none to carry, so a
      // hub that recorded an empty pair would be recording a shape §21.6 does not have.
      expect(sub.args, "a subscribe has no argument channel").toBeUndefined();
      expect(sub.result, "…and its answer is an empty MCP result").toBeUndefined();

      // The cap, grown FROM the constant in force so a change to it moves both sides.
      const long = `${QUERYLESS_URI}/${"a".repeat(AUDIT_URI_CAP_BYTES)}`;
      await subscribeThrough(world, "resources/subscribe", long);
      const capped = await lastRow(world.ns.owner.userId, "resources/subscribe");
      expect(byteLength(capped.tool ?? ""), "the column is bounded").toBeLessThanOrEqual(
        AUDIT_URI_CAP_BYTES,
      );
      expect(capped.tool, "capped, never replaced").toBe(long.slice(0, AUDIT_URI_CAP_BYTES));

      // The twin: the mirror method writes its OWN row, under every one of the same rules —
      // a hub that audited only the subscribe would leave the removal unrecorded.
      const unsubscribed = await subscribeThrough(world, "resources/unsubscribe", QUERIED_URI);
      expect(unsubscribed.body.error, JSON.stringify(unsubscribed.body.error)).toBeUndefined();
      const unsub = await lastRow(world.ns.owner.userId, "resources/unsubscribe");
      expect(unsub.event).toBe("resources/unsubscribe");
      expect(unsub.tool).toBe(`${QUERYLESS_URI}${REDACTED_QUERY}`);
      expect(unsub.service).toBe(SERVICE);
      expect(unsub.outcome).toBe("ok");
      expect(unsub.args).toBeUndefined();
      expect(unsub.result).toBeUndefined();
    } finally {
      await world.close();
    }
  }, CASE_BUDGET_MS);

  it("§21.6 · an open stream, its doorbells, and an updated relay write NO rows · the subscribe sent alongside them writes exactly one (the twin that makes the negative non-vacuous)", async () => {
    const world = await seedPushTunnelWorld();
    const stream = await openStream(world);
    try {
      const before = (await query(env.DB, world.ns.owner.userId, { limit: 200 })).total;

      // The one audited act, aimed at the stream above by its minted session id (§21.4).
      const subscribed = await subscribeThrough(
        world,
        "resources/subscribe",
        SUBSCRIBED_URI,
        stream.sessionId,
      );
      expect(subscribed.body.error, JSON.stringify(subscribed.body.error)).toBeUndefined();

      // …and the three unaudited ones, each OBSERVED rather than assumed: a doorbell that
      // never rang and a relay that never arrived would satisfy "no rows" for free.
      await world.ring();
      expect(
        await stream.received("notifications/resources/list_changed"),
        "the doorbell never rang, so the negative below would be vacuous",
      ).toBe(true);
      await world.update(SUBSCRIBED_URI);
      expect(
        await stream.received("notifications/resources/updated"),
        "the relay never arrived, same reason",
      ).toBe(true);

      const after = (await query(env.DB, world.ns.owner.userId, { limit: 200 })).total;
      expect(
        after - before,
        "a stream, its doorbells and its relays are listing-class (§21.6)",
      ).toBe(1);
      expect((await lastRow(world.ns.owner.userId, "resources/subscribe")).tool).toBe(
        SUBSCRIBED_URI,
      );
    } finally {
      await stream.cancel();
      await world.close();
    }
  }, CASE_BUDGET_MS);
});

// ══ the sweep, LAST ═══════════════════════════════════════════════════════════════════
//
// This describe must stay the last one in the file, and that is now load-bearing rather
// than tidy. Vitest runs a file's cases in declaration order and the `worker` project
// isolates D1 per FILE, which is the only reason the sweep can see what the cases above
// wrote at all — so a describe declared after it plants its secrets into a database the
// sweep has already read. Seven of PLANTED's fields (`read*`) belong to §20.4's cases
// below the old position; with the sweep left where it was, every one of them was swept
// for before it existed.
describe("§15 · the sweep", () => {
  it("23. §15 · after the full exercise no column of any table holds token material or a sentinel secret (sweepForSentinels, with its control value found — an unreachable sweep fails)", async () => {
    const sentinels = [
      ...AUDIT_BODY_ROWS.flatMap((row) => row.sentinels),
      ...SENTRY_SCRUB_ROWS.flatMap((row) => row.scrubbed),
      ...Object.values(PLANTED),
      BLOCK_BYTES,
    ];

    // The control is a value the exercise above DID persist visibly (table row 4's query),
    // so a sweep that finds nothing because it reaches nothing fails instead of passing.
    const hits = await sweepForSentinels(sentinels, "quarterly report");

    expect(hits, `the ledger holds: ${JSON.stringify(hits)}`).toEqual([]);
  }, CASE_BUDGET_MS);

  it("24. §15 · bodies live only in approval.args_json and the audit body columns · the visible argument IS found in exactly those columns and in no other (the twin that makes 23 non-vacuous)", async () => {
    const marker = "visible-case24-marker";

    // One dispatched call, whose argument lands in the audit body column…
    const recorded = await seedProxyWorld({
      kind: "proxy",
      upstream: healthyUpstream({ ok: marker }),
      logBodies: true,
    });
    await callTool(recorded.ns, recorded.credential, SERVICE, TOOL, { q: marker });

    // …and one gated call, whose argument lands in the approval row instead.
    const gated = await seedApprovalGatedWorld();
    await callTool(gated.ns, gated.credential, SERVICE, TOOL, { q: marker, password: "x" });

    const hits = await sweepForSentinels([marker], marker);
    const columns = new Set(hits.map((hit) => `${hit.table}.${hit.column}`));
    expect(columns, "a body reached a column §15 does not name").toEqual(
      new Set(["audit.args_json", "audit.result_json", "approval.args_json"]),
    );
  }, CASE_BUDGET_MS);
});
