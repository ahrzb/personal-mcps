// canonical.test.ts — argument identity: what "the identical retry" means (§7 step 4).
//
// PINS canonicalJson's laws. The function is small and the stakes are not: its output
// is the preimage of `args_hash`, so it alone decides whether an agent's retry spends
// the pass the owner granted or opens a second approval. Pinned here: object key order
// is irrelevant at every depth; array order is significant; the transform is idempotent
// (re-canonicalizing parsed output changes nothing); `undefined` and `{}` canonicalize
// alike, which is what lets approvals.check bind an absent `params.arguments` as `{}`
// however a client spells it; undefined-valued properties are omitted; scalars render
// as JSON.stringify renders them, with no insignificant whitespace; and values JSON
// cannot represent — cycles, BigInt — throw rather than serialize to something a hash
// would silently accept.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. deps line `none`: no D1, no DO,
// no crypto (hashing is approvals' business), nothing to isolate, no ordering between
// cases.
//
// SCOPE: arguments always arrive as parsed JSON off the wire, so Date/Map/class
// instances are out of scope by construction — the table samples only what a JSON-RPC
// `params.arguments` can actually hold, plus the two throw cases.
//
// NOT HERE: that the hash is taken POST-redaction (worker/approvals.test.ts proves it
// observably — two calls differing only in a redacted field dedup to one row), that an
// identical retry spends exactly one pass (tunnel/approval-e2e.test.ts, with the fake
// service's invocation counter as the oracle), and MRTR's exclusion of
// `inputResponses`/`requestState` from the binding (worker/approvals.test.ts). This
// file pins the string, not the use of the string.

// deps: none (no harness — pure seam) · approvals.canonicalJson · fast-check (the property driver at implementation) · no platform APIs

import { describe, it } from "vitest";

/**
 * An equivalence class: values that MUST all canonicalize to the same string. Three of
 * §7's four equality laws are literally classes — key order, `undefined` ≡ `{}`,
 * omitted undefined-valued properties — so expressing them as one table is both
 * shorter and STRONGER than a case each: the runner additionally asserts that
 * representatives of different classes differ, which is what catches over-
 * normalization (an implementation that sorted arrays, or coerced numbers to strings,
 * collapses two classes and goes red without anyone having written a row against it).
 */
export type CanonicalClass = {
  /** Stable class key, used in the test title. */
  name: string;
  /** Values that must share one canonical string; at least two, the first is the representative. */
  members: unknown[];
  /** The §7 sentence this class pins, e.g. "absent args binds as {}". */
  note: string;
};

/**
 * OWNER-AUTHORED in a separate commit before implementation (strategy §9 rule 1) —
 * agents never fill them. Cross-class distinctness makes this table an oracle for
 * "differs" as well as "agrees", so a padded class list is a weakened oracle, not a
 * richer one.
 */
export const canonicalClasses: readonly CanonicalClass[] = [];

/**
 * The class runner: within each class every member must canonicalize to the
 * representative's string; across classes every pair of representatives must differ.
 * Titled with the class name and its §7 reference so a failure names the sentence to
 * re-read (§8).
 */
export function runCanonicalClassTable(rows: readonly CanonicalClass[]): void {
  // deps: vitest describe/it/expect · approvals.canonicalJson
  throw new Error("unimplemented");
}

describe("§7 step 4 · canonicalJson — equivalence classes (table)", () => {
  it.todo("§7 step 4 · within a class · every member canonicalizes to the representative's string");
  it.todo("§7 step 4 · across classes · no two representatives share a string (catches over-normalization)");
  it.todo("§7 step 4 · the classes must cover · key order at depth · undefined ≡ {} · undefined-valued properties omitted");
});

describe("§7 step 4 · canonicalJson — laws", () => {
  it.todo("§7 step 4 · law · key order is irrelevant at every depth · a shuffled-keys copy canonicalizes identically");
  it.todo("§7 step 4 · law · array order is significant · [1,2] and [2,1] never canonicalize alike");
  it.todo("§7 step 4 · law · idempotent · canonicalJson(JSON.parse(canonicalJson(v))) === canonicalJson(v)");
  it.todo("§7 step 4 · law · keys sort by code unit, not by locale — the same string in workerd and in Node");
  it.todo("§7 step 4 · law · scalars render as JSON.stringify renders them · escapes, negative zero, exponents");
  it.todo("§7 step 4 · law · no insignificant whitespace · no space appears outside a string literal");
  it.todo("§7 step 4 · law · retry identity IS string equality · two argument objects match iff their canonical strings match");
});

describe("§7 step 4 · canonicalJson — what it refuses", () => {
  it.todo("§7 step 4 · a cycle throws (allow-twin: the same object graph with the back-edge removed canonicalizes)");
  it.todo("§7 step 4 · a BigInt throws (allow-twin: the same value as a number, and as a string, canonicalize)");
  it.todo("§7 step 4 · a repeated non-cyclic reference is not mistaken for a cycle — it appears twice, expanded");
});
