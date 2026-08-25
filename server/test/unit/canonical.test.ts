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

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson } from "../../src/approvals";

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
export const canonicalClasses: readonly CanonicalClass[] = [
  // §7 step 4 / approvals.canonicalJson: "object keys sorted at every depth". The shuffle is at
  // BOTH levels, so an implementation that sorts only the root goes red here.
  {
    name: "key-order-at-depth",
    members: [
      { a: 1, b: { c: 2, d: 3 } },
      { b: { d: 3, c: 2 }, a: 1 },
    ],
    note: "object key order is irrelevant at every depth",
  },
  // §7 step 4: this class is what lets approvals.check "bind an absent `params.arguments` as
  // `{}` however a client spells it" — a retry that omits the key matches one that sends `{}`.
  {
    name: "absent-arguments-binds-as-empty-object",
    members: [undefined, {}],
    note: "`undefined` and `{}` canonicalize alike — an absent params.arguments binds as {}",
  },
  // §7 step 4: "undefined-valued properties omitted" — including when the omission changes the
  // key order the sorter sees.
  {
    name: "undefined-valued-properties-omitted",
    members: [{ a: 1 }, { a: 1, b: undefined }, { b: undefined, a: 1 }],
    note: "undefined-valued properties are omitted",
  },
  // §7 step 4: `null` is a value JSON represents, so a null-valued property is KEPT — only
  // undefined-valued ones are omitted. This class exists as the PAIR of the one above: their
  // representatives differ only in `b`'s presence-as-null, so a canonicalizer that dropped nulls
  // alongside undefineds collapses them and the cross-class distinctness case goes red. Without
  // it, a retry that adds `"b": null` spends a pass the owner granted for a call without it.
  {
    name: "null-valued-property-kept",
    members: [
      { a: 1, b: null },
      { b: null, a: 1 },
    ],
    note: "a null-valued property is kept — null is a value, not an omission",
  },
  // §7 step 4: "arrays kept in order". These two classes exist as a PAIR: their representatives
  // differ only in element order, so an implementation that sorted arrays collapses them and the
  // cross-class distinctness case goes red without a row having to say "arrays are not sorted".
  // The second member of each is a key-order shuffle — a different spelling of the same value.
  {
    name: "array-order-ascending",
    members: [
      { a: 1, items: [1, 2] },
      { items: [1, 2], a: 1 },
    ],
    note: "array order is significant — [1,2] is its own class",
  },
  {
    name: "array-order-descending",
    members: [
      { a: 1, items: [2, 1] },
      { items: [2, 1], a: 1 },
    ],
    note: "array order is significant — [2,1] is a different class from [1,2]",
  },
  // §7 step 4: "scalars as JSON.stringify renders them". The same pair trick for the other named
  // over-normalization: a canonicalizer that coerced numbers to strings collapses these two.
  {
    name: "scalar-number-one",
    members: [
      { u: 0, v: 1 },
      { v: 1, u: 0 },
    ],
    note: "the number 1 renders as JSON.stringify renders it — its own class",
  },
  {
    name: "scalar-string-one",
    members: [
      { u: 0, v: "1" },
      { v: "1", u: 0 },
    ],
    note: 'the string "1" is a different class from the number 1 — no coercion',
  },
];

/**
 * The class runner: within each class every member must canonicalize to the
 * representative's string; across classes every pair of representatives must differ.
 * Titled with the class name and its §7 reference so a failure names the sentence to
 * re-read (§8).
 */
export function runCanonicalClassTable(rows: readonly CanonicalClass[]): void {
  // deps: vitest describe/it/expect · approvals.canonicalJson
  it("§7 step 4 · within a class · every member canonicalizes to the representative's string", () => {
    for (const row of rows) {
      const expected = canonicalJson(row.members[0]);
      for (const member of row.members) {
        expect(canonicalJson(member)).toBe(expected);
      }
    }
  });

  it("§7 step 4 · across classes · no two representatives share a string (catches over-normalization)", () => {
    const representatives = rows.map((row) => canonicalJson(row.members[0]));
    for (let i = 0; i < representatives.length; i++) {
      for (let j = i + 1; j < representatives.length; j++) {
        expect(representatives[i]).not.toBe(representatives[j]);
      }
    }
  });

  it("§7 step 4 · the classes must cover · key order at depth · undefined ≡ {} · undefined-valued properties omitted", () => {
    const names = new Set(rows.map((row) => row.name));
    expect(names.has("key-order-at-depth")).toBe(true);
    expect(names.has("absent-arguments-binds-as-empty-object")).toBe(true);
    expect(names.has("undefined-valued-properties-omitted")).toBe(true);
  });
}

/**
 * Test-only helper for the key-order law: rebuilds `v` with every object's own
 * keys reinserted in reverse order, recursively — a different key-insertion
 * order at every depth, array element order untouched. Not canonicalJson's
 * concern; canonicalJson must produce the identical string regardless.
 */
function shuffleKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffleKeysDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).reverse()) {
      out[key] = shuffleKeysDeep((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  return v;
}

describe("§7 step 4 · canonicalJson — equivalence classes (table)", () => {
  runCanonicalClassTable(canonicalClasses);
});

describe("§7 step 4 · canonicalJson — laws", () => {
  it("§7 step 4 · law · key order is irrelevant at every depth · a shuffled-keys copy canonicalizes identically", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        expect(canonicalJson(shuffleKeysDeep(value))).toBe(canonicalJson(value));
      }),
    );
  });

  it("§7 step 4 · law · array order is significant · [1,2] and [2,1] never canonicalize alike", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("§7 step 4 · law · idempotent · canonicalJson(JSON.parse(canonicalJson(v))) === canonicalJson(v)", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
    );
  });

  it("§7 step 4 · law · keys sort by code unit, not by locale — the same string in workerd and in Node", () => {
    // "ä" (U+00E4 = 228) sorts AFTER "z" (0x7A = 122) by UTF-16 code unit — the sort this
    // law requires. A `localeCompare`-based sort (the bug it forbids) puts the accented
    // "a" variant before "z" in common locales; the second assertion is that disagreement,
    // made concrete, so a regression to locale-aware sorting is what this test catches.
    expect(canonicalJson({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
    expect("ä".localeCompare("z")).toBeLessThan(0);
  });

  it("§7 step 4 · law · scalars render as JSON.stringify renders them · escapes, negative zero, exponents", () => {
    const scalars: unknown[] = ['a"b\\c\nd\te', -0, 1e21, 0.0000001, Number.MAX_SAFE_INTEGER];
    for (const value of scalars) {
      expect(canonicalJson({ v: value })).toBe(`{"v":${JSON.stringify(value)}}`);
    }
  });

  it("§7 step 4 · law · no insignificant whitespace · no space appears outside a string literal", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const withoutStringLiterals = canonicalJson(value).replace(/"(?:[^"\\]|\\.)*"/g, "");
        expect(withoutStringLiterals).not.toMatch(/\s/);
      }),
    );
  });

  it("§7 step 4 · law · retry identity IS string equality · two argument objects match iff their canonical strings match", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        // A retry never hands back the SAME object — it's a fresh parse off the wire.
        // JSON.parse(JSON.stringify(v)) manufactures exactly that: same value, no shared
        // reference. Retry identity is defined as their canonical strings matching.
        const retry = JSON.parse(JSON.stringify(value)) as unknown;
        expect(canonicalJson(retry)).toBe(canonicalJson(value));
      }),
    );
  });
});

describe("§7 step 4 · canonicalJson — what it refuses", () => {
  it("§7 step 4 · a cycle throws (allow-twin: the same object graph with the back-edge removed canonicalizes)", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();

    const backEdgeRemoved = { a: 1, self: {} };
    expect(() => canonicalJson(backEdgeRemoved)).not.toThrow();
  });

  it("§7 step 4 · a BigInt throws (allow-twin: the same value as a number, and as a string, canonicalize)", () => {
    expect(() => canonicalJson({ n: 5n })).toThrow();
    expect(() => canonicalJson({ n: 5 })).not.toThrow();
    expect(() => canonicalJson({ n: "5" })).not.toThrow();
  });

  it("§7 step 4 · a repeated non-cyclic reference is not mistaken for a cycle — it appears twice, expanded", () => {
    const shared = { x: 1 };
    const value = { a: shared, b: shared };
    expect(() => canonicalJson(value)).not.toThrow();
    expect(canonicalJson(value)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
