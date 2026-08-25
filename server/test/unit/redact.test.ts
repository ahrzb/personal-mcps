// redact.test.ts — the redaction path grammar, in both directions, as pure tables.
//
// PINS §7's "Sensitive-field redaction" seam: writeOnlyPaths finds sensitive paths,
// applyRedaction masks them, and the two must agree on one grammar. The pair is the
// system's ONE definition (registry, N1 applied 2026-08-25) — tunnel walks the cached
// input AND output schemas with the former; approvals and the gateway's audit-body
// path mask with the latter — so a disagreement here (walk emits `creds.token`, masker
// expects something else) is silent everywhere and catastrophic once: the body reaches
// D1 unmasked. Direction-blindness is the 2026-08-25 decision this file exists to pin:
// an output schema walks exactly like an input one, and the same masker runs over
// `params.arguments` and over result `structuredContent`. §15's uniform rule rides on
// it — the pmcp builtin has no body special case because `token_issue`'s key is just a
// `writeOnly`-marked OUTPUT field, masked like any other secret.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. Both functions' deps line is
// `none`: no D1, no DO catalog, no binding, nothing to isolate, no ordering between
// rows. Everything downstream of these two — where the schemas come from, what the
// masked body is then used for — is another project's file.
//
// NOT HERE: the CONFIG half of the union, `redact` / `redact_results` resolved per tool
// through the pattern language (worker/registry.test.ts · redactPathsFor); the union
// itself and its per-direction application (worker/hygiene.test.ts, the §15 body
// table); stripping `writeOnly` from every served outputSchema, the co-opt that must
// never reach the wire (worker/hygiene.test.ts); unstructured result blocks becoming
// blob stubs and the AUDIT_BODY_CAP_BYTES oversize stub (audit.record, same file); that
// hashing happens POST-redaction (worker/approvals.test.ts, proven observably); and
// MRTR `inputResponses`/`requestState` never entering any persisted body
// (worker/approvals.test.ts); and what a REFUSED schema then COSTS a tool — the per-tool
// violations echoed to the service at catalog warm while registration still succeeds
// (tunnel/protocol.test.ts), and the cached schema-unsound consequence — no recorded
// bodies (worker/hygiene.test.ts), sensitivePaths null and -32001 on a gated call (the
// pipeline's own tables: worker/order.table.test.ts, tunnel/approval-e2e.test.ts). This file
// pins the grammar and the refuse-line alone — what they answer, never what answers to them.
//
// The third seam this file owns is the refuse-line beside the walk: registry
// .validateSchemaIndirection. §7 (paragraph added 2026-08-25) makes the walk resolve
// same-document `#/…` refs, union marks across allOf/anyOf/oneOf, and cut secret-free
// cycles — and makes everything it CANNOT soundly resolve loud rather than skipped. The
// two are one contract read from both ends: what the validator refuses, the walk is never
// asked to guess at; what it accepts, the walk must resolve. A validator that refused
// everything would be as wrong as one that refused nothing, so its table is refusals
// beside walkable allow-twins (§9 rule 2), pinned here where both functions are pure.
//
// FINDINGS, surfaced by writing this file and both RESOLVED 2026-08-25 (strategy §1 —
// amending the spec is a normal OUTPUT of test authoring):
//
// 1. The mask sentinel `‹redacted›` was a prose string with no named export, and §7's
//    durable-vs-incidental rule forbids a row naming one — so runRedactionTable took it
//    as a `sentinel` parameter. registry exports REDACTED now, beside applyRedaction;
//    the parameter is gone, rows still spell only STRUCTURE, and every renderer (approval
//    detail, /audit, `pmcp audit`) references the name rather than re-spelling the glyphs.
// 2. Whether the walk descends through `$ref` / `$defs` / composition was an OPEN
//    question this file could only record. §7 answers it (see above), so the open line is
//    gone and the indirection cases below are ordinary rows — landed with the spec
//    sentence, in the same commit (§8, `spec:`), exactly as the open line demanded.

// deps: none (no harness — pure seams) · registry.writeOnlyPaths · registry.validateSchemaIndirection · registry.applyRedaction · registry.REDACTED · no platform APIs

import { describe, it } from "vitest";
import type { Tool } from "../../src/gateway";

/**
 * One row of the walk table: a schema fragment and the paths it must yield.
 *
 * `slot` is provenance, not a parameter — writeOnlyPaths takes a schema and nothing
 * else, so direction-blindness is STRUCTURAL at this seam rather than assertable. The
 * column exists so the table can be seen to sample both catalog slots (§7, decided
 * 2026-08-25): an all-`inputSchema` table would pin the decision by accident and let a
 * future output-only regression through the unit project entirely.
 *
 * `schema` is typed `unknown`, matching writeOnlyPaths' own parameter, because the
 * table deliberately includes malformed and absent schemas — totality is part of the
 * contract ("a malformed or absent schema yields [], never an error").
 */
export type WriteOnlyWalkRow = {
  /** Which catalog slot this shape was taken from — `Tool["inputSchema"]` or `Tool["outputSchema"]`. */
  slot: keyof Pick<Tool, "inputSchema" | "outputSchema">;
  /** The fragment handed to the walk, exactly as a cached catalog entry carries it. */
  schema: unknown;
  /** Expected dot-paths relative to the walked schema's root, as a SET — order is not part of the contract. */
  paths: string[];
  /** The §7 sentence this row pins, e.g. "an array's items collapse into the dot path". */
  note: string;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them. Three obligations on the author, all structural:
 * the table must carry `outputSchema` rows (see `slot`), every "not a path" row —
 * `writeOnly: false`, absent marker, malformed schema — must sit beside a row where
 * the same shape with the marker set DOES yield a path (§9 rule 2), and every schema
 * here must be one `validateSchemaIndirection` ACCEPTS: the walk's contract is stated
 * over walkable schemas only, so an unwalkable one belongs in the table below, not this
 * one. The runner enforces that last obligation rather than trusting it.
 */
export const writeOnlyWalkRows: readonly WriteOnlyWalkRow[] = [];

/**
 * The walk runner: one case per row, comparing as sets, titled with the row's §7
 * reference and `note` so a failure names the sentence to re-read (§8). It also asserts
 * the table's own precondition first — every row's schema passes
 * validateSchemaIndirection — because "callers guarantee the schema passed" is a
 * contract this table would otherwise silently violate while still going green.
 */
export function runWriteOnlyWalkTable(rows: readonly WriteOnlyWalkRow[]): void {
  // deps: vitest describe/it/expect · registry.writeOnlyPaths · registry.validateSchemaIndirection
  throw new Error("unimplemented");
}

/**
 * The indirection construct a row exercises — one name per arm of §7's refuse-line, so a
 * missing arm is visible by reading the column rather than by re-deriving the paragraph.
 * `local-ref`, `composition` and `cut-cycle` are the RESOLVABLE arms (the walk descends);
 * the rest are what the validator refuses.
 */
export type IndirectionConstruct =
  | "local-ref"
  | "composition"
  | "cut-cycle"
  | "external-ref"
  | "id"
  | "anchor"
  | "dynamic-ref"
  | "recursive-secret";

/**
 * One row of the refuse-line table: a schema and whether §7 lets the hub walk it.
 *
 * Pairing is the whole design. A validator satisfied by `return ["nope"]` passes any
 * table made only of refusals, so a refusing row carries `allowTwin` — a schema using the
 * SAME construct in the form §7 permits (a `#/$defs/…` ref beside the external one, a
 * secret-free cycle beside the recursive-secret one). Accepting rows name themselves.
 *
 * `walkable` is the verdict, spelled as a boolean rather than as violation prose:
 * violations must NAME the construct, but which words they use is incidental (§7), so
 * rows assert presence-or-absence and the `construct` column carries the identification.
 */
export type IndirectionRow = {
  construct: IndirectionConstruct;
  /** The schema as a catalog entry would carry it — `unknown`, matching the validator's parameter. */
  schema: unknown;
  /** true ⇒ no violations, and the walk below may be asked for its paths; false ⇒ at least one. */
  walkable: boolean;
  /**
   * Required on refusing rows: the schema reaching the same shape through the SAME
   * construct in its permitted form. Walkable rows repeat their own schema's identity.
   */
  allowTwin?: unknown;
  /**
   * On walkable rows, the paths the walk must then yield — the second half of "accepted
   * means resolvable". Absent on refusing rows: a refused schema is never walked.
   */
  paths?: string[];
  /** The §7 sentence this row pins, e.g. "an unresolved external ref could conceal a mark". */
  note: string;
};

/**
 * OWNER-AUTHORED, separate commit, before implementation (strategy §9 rule 1). The oracle
 * is §7's indirection paragraph and nothing else — rows are written from the sentence,
 * never from what the validator happens to do.
 */
export const indirectionRows: readonly IndirectionRow[] = [];

/**
 * The refuse-line runner: one case per row, asserting the verdict and — on walkable rows
 * — that the walk actually resolves what the validator promised, which is what keeps the
 * two functions one contract instead of two opinions. Plus the table's honesty invariant,
 * enforced before anything runs: a refusing row with no `allowTwin` fails as a malformed
 * oracle, not as a code regression.
 */
export function runIndirectionTable(rows: readonly IndirectionRow[]): void {
  // deps: vitest describe/it/expect · registry.validateSchemaIndirection · registry.writeOnlyPaths
  throw new Error("unimplemented");
}

/**
 * One row of the masking table: a body, the resolved path union, and the expected
 * copy. `body` is deliberately not called "args" — the same masker runs over
 * `params.arguments` and over a result's `structuredContent`, and a table that named
 * only one of them would re-pin the direction it is supposed to make irrelevant.
 */
export type RedactionRow = {
  /** `params.arguments` or result `structuredContent` — the masker cannot tell, and must not. */
  body: Record<string, unknown>;
  /** The paths the gateway resolved for this direction (schema ∪ config union, already merged). */
  paths: string[];
  /**
   * The expected copy. Masked leaves hold `registry.REDACTED` — rows spell the
   * STRUCTURE and reference the name, never the glyphs (FINDINGS 1 in the header), so a
   * change of sentinel is a one-line edit in registry.ts with zero row churn.
   */
  masked: Record<string, unknown>;
  note: string;
};

/** OWNER-AUTHORED, separate commit, before implementation (strategy §9 rule 1). */
export const redactionRows: readonly RedactionRow[] = [];

/**
 * The masking runner: one case per row plus the two invariants that must hold for
 * every row rather than for chosen ones — the input body is never mutated, and masking
 * a masked body changes nothing further. Masked leaves are compared against
 * `registry.REDACTED`, read here rather than re-spelled anywhere (header FINDINGS 1):
 * §7's incidental rule, applied to a string.
 */
export function runRedactionTable(rows: readonly RedactionRow[]): void {
  // deps: vitest describe/it/expect · registry.applyRedaction · registry.REDACTED
  throw new Error("unimplemented");
}

describe("§7 · writeOnlyPaths — the walk, direction-blind (table)", () => {
  it.todo("§9 rule 2 · the table itself · every \"no path\" row sits beside the same shape with the marker set");
  it.todo("§7 · a top-level property marked writeOnly yields its name; its unmarked sibling yields nothing");
  it.todo("§7 · writeOnly: false and an absent marker are both \"not sensitive\"");
  it.todo("§7 · a nested object yields the dotted path — credentials.token, at any depth");
  it.todo("§7 · an array of objects yields the element path with no index segment — the grammar has no [] form");
  it.todo("§7 · several markers in one schema yield every path, as a set, without duplicates");
  it.todo("§7 · an outputSchema shape yields exactly what its inputSchema twin yields — the walk reads no direction");
  it.todo("§15 · the token_issue shape · a writeOnly OUTPUT field is found like any other (the uniform rule, no pmcp special case)");
  it.todo("§7 · a malformed schema yields [] and never throws (twin: the same schema repaired yields its paths)");
  it.todo("§7 · an absent schema and a non-object schema both yield []");
  it.todo("§9 rule 1 · the table itself · every walk row's schema passes validateSchemaIndirection — the walk's contract is stated over walkable schemas only, so an unwalkable one is the table below's row");
});

describe("§7 · writeOnlyPaths — indirection the walk RESOLVES (table)", () => {
  it.todo("§7 · a writeOnly inside $defs, reached only by a property's `#/$defs/…` ref, yields that property's path — the shape a plain-SDK bot emits by default, and the reason inlining stays optional sugar");
  it.todo("§7 · a JSON Pointer with escapes (~0, ~1) resolves to the same subschema a plain key would");
  it.todo("§7 · a ref chain (a property → $defs/A → $defs/B) resolves through to B's marks");
  it.todo("§7 · a mark in ONE anyOf branch masks the property — over-masking is safe, so the union is taken, not the intersection (twin: no branch marks it and no path is yielded)");
  it.todo("§7 · allOf and oneOf union identically to anyOf — composition is one rule, not three");
  it.todo("§7 · a secret-free cycle is CUT and yields the paths outside it, terminating rather than throwing (twin: the same shape with the cycle broken yields exactly the same paths)");
  it.todo("§7 · a ref reaching an outputSchema shape resolves exactly as its inputSchema twin does — indirection is direction-blind too");
});

describe("§7 · validateSchemaIndirection — the refuse-line (table)", () => {
  it.todo("§9 rule 2 · the table itself · every refusing row names an allowTwin using the same construct legally");
  it.todo("§7 · a walkable schema — no indirection at all — yields no violations (the anchor every refusal is read against)");
  it.todo("§7 · an external or non-`#/` ref is refused, naming the construct (twin: the same shape via `#/$defs/…` is accepted)");
  it.todo("§7 · `$id` is refused — re-basing changes what a ref resolves to (twin: the same schema without it is accepted)");
  it.todo("§7 · `$anchor` is refused (twin: the same target addressed by JSON Pointer is accepted)");
  it.todo("§7 · `$dynamicRef` is refused (twin: the static `$ref` to the same subschema is accepted)");
  it.todo("§7 · a recursive cycle CARRYING a writeOnly is refused — its path set is infinite, so no finite dot-path list can express the mask (twin: the same cycle with no mark inside it is accepted and cut)");
  it.todo("§7 · every accepted row is then walkable: writeOnlyPaths returns the row's paths and never throws — what the validator admits, the walk resolves, so the two can never drift into separate opinions");
  it.todo("§7 · law · pure · the schema handed in is not mutated, and repeated calls agree");
});

describe("§7 · applyRedaction — masking, direction-blind (table)", () => {
  it.todo("§7 · a top-level path is masked and its siblings are untouched");
  it.todo("§7 · a nested path is masked, its parent object otherwise intact");
  it.todo("§7 · a path meeting an array masks every element");
  it.todo("§7 · a path naming an object masks the whole subtree, never just its leaves");
  it.todo("§7 · a path absent from the body is ignored — no key is invented (twin: the same path present is masked)");
  it.todo("§7 · an empty path list returns an unchanged, deep-equal copy");
  it.todo("§7 · a masked non-string value becomes registry.REDACTED — the type changes, the field never survives");
});

describe("§7 · the two halves agree — laws", () => {
  it.todo("§7 · law · round-trip · every path writeOnlyPaths finds is masked when applied to a body shaped by that schema");
  it.todo("§7 · law · pure · the input body is never mutated, and the result is a new object even when nothing matched");
  it.todo("§7 · law · idempotent · masking a masked body changes nothing further");
  it.todo("§7 · law · direction-blind · the same (body, paths) masks identically whether it came from params.arguments or structuredContent");
});
