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

import { describe, it, expect } from "vitest";
import {
  REDACTED,
  applyRedaction,
  validateSchemaIndirection,
  writeOnlyPaths,
} from "../../src/registry";
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
  /**
   * Required when, and only when, `paths` is empty — the same field PatternMatchRow,
   * FilterScenario and IndirectionRow all carry, so §9 rule 2's honesty case is checked
   * STRUCTURALLY here too rather than by a runner hard-coding which rows it means.
   * Carries the marked shape this row is read against: for a `writeOnly: false` or
   * malformed row that is literally the same shape with the marker set, and for the two
   * totality rows — an absent schema, a non-object schema — where no "same shape" can
   * exist, it is the minimal marked schema the walk must still find, so the invariant is
   * total over the table instead of exempting the rows it cannot phrase.
   * The runner asserts the twin yields at least one path; a no-path row without one is a
   * malformed oracle, not a code regression.
   */
  allowTwin?: unknown;
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
export const writeOnlyWalkRows: readonly WriteOnlyWalkRow[] = [
  // §7: "any property marked with standard JSON Schema `writeOnly: true` (at any depth) in a
  // tool's input or output schema is sensitive". The unmarked sibling is what keeps the row from
  // being satisfied by a walk that yields every property name.
  {
    slot: "inputSchema",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        username: { type: "string" },
      },
    },
    paths: ["password"],
    note: "a top-level property marked writeOnly yields its name; its unmarked sibling yields nothing",
  },
  // §9 rule 2: the same shape with the marker off — `writeOnly: false` is not a marker, and
  // neither is its absence. Read against the row above, which differs in exactly that.
  {
    slot: "inputSchema",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: false },
        username: { type: "string" },
      },
    },
    paths: [],
    allowTwin: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        username: { type: "string" },
      },
    },
    note: 'writeOnly: false and an absent marker are both "not sensitive"',
  },
  // §7: the dot-path grammar — "returns their dot-paths relative to the walked schema's root
  // (…e.g. `credentials.token`) — the same path grammar applyRedaction consumes and config
  // `redact` / `redact_results` entries are written in".
  {
    slot: "inputSchema",
    schema: {
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            token: { type: "string", writeOnly: true },
            id: { type: "string" },
          },
        },
      },
    },
    paths: ["credentials.token"],
    note: "a nested object yields the dotted path — credentials.token, at any depth",
  },
  // §7: the grammar has one form only — a dot path. An array collapses into it, because the mask
  // applies to "every element" (applyRedaction), so no index segment could mean anything.
  {
    slot: "inputSchema",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              apiKey: { type: "string", writeOnly: true },
              name: { type: "string" },
            },
          },
        },
      },
    },
    paths: ["items.apiKey"],
    note: "an array of objects yields the element path with no index segment — the grammar has no [] form",
  },
  // §7: "at any depth" — three marks at three depths, one unmarked sibling, returned as a set.
  {
    slot: "inputSchema",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        credentials: {
          type: "object",
          properties: {
            token: { type: "string", writeOnly: true },
            oauth: {
              type: "object",
              properties: {
                refresh_token: { type: "string", writeOnly: true },
                scope: { type: "string" },
              },
            },
          },
        },
        note: { type: "string" },
      },
    },
    paths: ["password", "credentials.token", "credentials.oauth.refresh_token"],
    note: "several markers in one schema yield every path, as a set, without duplicates",
  },
  // §7 (decided 2026-08-25): the walk is direction-blind. This row's schema is the
  // `credentials.token` row above, verbatim, taken from the OUTPUT slot — same shape, same paths.
  {
    slot: "outputSchema",
    schema: {
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            token: { type: "string", writeOnly: true },
            id: { type: "string" },
          },
        },
      },
    },
    paths: ["credentials.token"],
    note: "an outputSchema shape yields exactly what its inputSchema twin yields — the walk reads no direction",
  },
  // §8: "The issued key is a `writeOnly`-marked field in this tool's *output* schema, so §15's
  // uniform body rule masks it wherever bodies are recorded — no pmcp-specific logging rule
  // exists or is needed."
  {
    slot: "outputSchema",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", writeOnly: true },
        tokenId: { type: "string" },
        expiresAt: { type: ["integer", "null"] },
      },
    },
    paths: ["key"],
    note: "§15 · the token_issue shape · a writeOnly OUTPUT field is found like any other (the uniform rule, no pmcp special case)",
  },
  // §7: "A malformed or absent schema still yields [], never an error" (registry.writeOnlyPaths).
  // The twin is the first row — this is that schema with `properties` broken.
  {
    slot: "inputSchema",
    schema: { type: "object", properties: ["password", "username"] },
    paths: [],
    allowTwin: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        username: { type: "string" },
      },
    },
    note: "a malformed schema yields [] and never throws (twin: the same schema repaired yields its paths)",
  },
  // The two totality rows. Neither has a "same shape with the marker set" — an absent schema and
  // a string have no shape to mark — so their twin is the minimal marked schema: the walk that
  // answers [] here must still find a path there, which is the whole content of §9 rule 2.
  {
    slot: "inputSchema",
    schema: undefined,
    paths: [],
    allowTwin: {
      type: "object",
      properties: { password: { type: "string", writeOnly: true } },
    },
    note: "an absent schema yields []",
  },
  {
    slot: "inputSchema",
    schema: "not-a-schema",
    paths: [],
    allowTwin: {
      type: "object",
      properties: { password: { type: "string", writeOnly: true } },
    },
    note: "a non-object schema yields []",
  },
];

/**
 * The walk runner: one case per row, comparing as sets, titled with the row's §7
 * reference and `note` so a failure names the sentence to re-read (§8). It also asserts
 * the table's own precondition first — every row's schema passes
 * validateSchemaIndirection — because "callers guarantee the schema passed" is a
 * contract this table would otherwise silently violate while still going green.
 */
export function runWriteOnlyWalkTable(rows: readonly WriteOnlyWalkRow[]): void {
  // deps: vitest describe/it/expect · registry.writeOnlyPaths · registry.validateSchemaIndirection
  it('§9 rule 2 · the table itself · every "no path" row sits beside the same shape with the marker set', () => {
    for (const row of rows) {
      if (row.paths.length > 0) continue;
      expect(row.allowTwin, `row "${row.note}" yields no path and must name an allowTwin`).toBeDefined();
      expect(writeOnlyPaths(row.allowTwin).length).toBeGreaterThan(0);
    }
  });

  // The two totality rows share one case (see the locked title): neither is an object, so
  // neither has a "same shape with the marker set" — the split is structural, not positional.
  const shaped = rows.filter((row) => isObject(row.schema));
  for (const row of shaped) {
    it(caseTitle(row.note), () => {
      const found = writeOnlyPaths(row.schema);
      expect(found.length, `duplicate paths in ${JSON.stringify(found)}`).toBe(new Set(found).size);
      expect(new Set(found)).toEqual(new Set(row.paths));
    });
  }

  it("§7 · an absent schema and a non-object schema both yield []", () => {
    const total = rows.filter((row) => !isObject(row.schema));
    expect(total.length).toBeGreaterThan(0);
    for (const row of total) expect(writeOnlyPaths(row.schema)).toEqual([]);
  });

  it("§9 rule 1 · the table itself · every walk row's schema passes validateSchemaIndirection — the walk's contract is stated over walkable schemas only, so an unwalkable one is the table below's row", () => {
    for (const row of rows) {
      expect(validateSchemaIndirection(row.schema), `row "${row.note}"`).toEqual([]);
    }
  });
}

/** The one object test both tables read `unknown` schemas and bodies through. */
function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * A row's case title: its `note` under §7, unless the note already names its own section
 * (the `token_issue` row is §15's). Titles are the locked inventory, so this is the only
 * place a row's prose becomes one.
 */
function caseTitle(note: string): string {
  return note.startsWith("§") ? note : `§7 · ${note}`;
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
export const indirectionRows: readonly IndirectionRow[] = [
  // §7's anchor: a schema with no indirection at all resolves trivially, so the refuse-line says
  // nothing about it. (`construct` has no "none" arm — this is the degenerate resolvable case;
  // see the report note filed with these rows.)
  {
    construct: "local-ref",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        username: { type: "string" },
      },
    },
    walkable: true,
    paths: ["password"],
    note: "a walkable schema — no indirection at all — yields no violations (the anchor every refusal is read against)",
  },
  // §7: "'At any depth' includes indirection, because SDK schema generators emit `$defs`+`$ref`
  // by default: the hub's walk resolves same-document `#/…` refs by JSON Pointer." The path is
  // the PROPERTY's, not the $defs location's — `$defs` is not part of any body.
  {
    construct: "local-ref",
    schema: {
      type: "object",
      properties: { credentials: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: {
          type: "object",
          properties: {
            token: { type: "string", writeOnly: true },
            id: { type: "string" },
          },
        },
      },
    },
    walkable: true,
    paths: ["credentials.token"],
    note: "a writeOnly inside $defs, reached only by a property's `#/$defs/…` ref, yields that property's path",
  },
  // §7: "resolves same-document `#/…` refs BY JSON POINTER" — which means RFC 6901 escaping:
  // `~1` is `/` and `~0` is `~`, so a naive split-on-`/` lookup goes red here.
  // `c` is the ORDER witness, and the only one: RFC 6901 unescapes `~1` BEFORE `~0`, so `a~01b`
  // is the key `a~1b` — while the reverse order yields `a/b` and resolves to nothing. Against
  // `x~1y` and `p~0q` alone the two orders agree, so a wrong-order resolver passes; only a token
  // carrying `~01` separates them.
  {
    construct: "local-ref",
    schema: {
      type: "object",
      properties: {
        a: { $ref: "#/$defs/x~1y" },
        b: { $ref: "#/$defs/p~0q" },
        c: { $ref: "#/$defs/a~01b" },
      },
      $defs: {
        "x/y": { type: "object", properties: { secret: { type: "string", writeOnly: true } } },
        "p~q": { type: "object", properties: { key: { type: "string", writeOnly: true } } },
        "a~1b": { type: "object", properties: { code: { type: "string", writeOnly: true } } },
      },
    },
    walkable: true,
    paths: ["a.secret", "b.key", "c.code"],
    note: "a JSON Pointer with escapes (~0, ~1) resolves to the same subschema a plain key would",
  },
  // §7: resolution is transitive — a ref whose target is itself a ref still reaches the marks.
  {
    construct: "local-ref",
    schema: {
      type: "object",
      properties: { outer: { $ref: "#/$defs/A" } },
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    walkable: true,
    paths: ["outer.token"],
    note: "a ref chain (a property → $defs/A → $defs/B) resolves through to B's marks",
  },
  // §7: "unions marks across `allOf`/`anyOf`/`oneOf` branches (secret in any branch masks —
  // over-masking is safe)". One branch marks, one does not: the union yields the path, the
  // intersection would not.
  {
    construct: "composition",
    schema: {
      type: "object",
      properties: {
        cred: {
          anyOf: [
            { type: "object", properties: { token: { type: "string", writeOnly: true } } },
            { type: "object", properties: { token: { type: "string" } } },
          ],
        },
      },
    },
    walkable: true,
    paths: ["cred.token"],
    note: "a mark in ONE anyOf branch masks the property — over-masking is safe, so the union is taken, not the intersection",
  },
  // The twin: the same composition with no branch marking anything yields nothing, so the row
  // above cannot be satisfied by a walk that yields every composed property (§9 rule 2).
  {
    construct: "composition",
    schema: {
      type: "object",
      properties: {
        cred: {
          anyOf: [
            { type: "object", properties: { token: { type: "string" } } },
            { type: "object", properties: { token: { type: "string" } } },
          ],
        },
      },
    },
    walkable: true,
    paths: [],
    note: "twin: no branch marks it and no path is yielded",
  },
  // §7 names the three keywords in one breath — so they are one rule, and these two rows are the
  // anyOf row above with only the keyword changed.
  {
    construct: "composition",
    schema: {
      type: "object",
      properties: {
        cred: {
          allOf: [
            { type: "object", properties: { token: { type: "string", writeOnly: true } } },
            { type: "object", properties: { id: { type: "string" } } },
          ],
        },
      },
    },
    walkable: true,
    paths: ["cred.token"],
    note: "allOf unions identically to anyOf — composition is one rule, not three",
  },
  {
    construct: "composition",
    schema: {
      type: "object",
      properties: {
        cred: {
          oneOf: [
            { type: "object", properties: { token: { type: "string", writeOnly: true } } },
            { type: "object", properties: { id: { type: "string" } } },
          ],
        },
      },
    },
    walkable: true,
    paths: ["cred.token"],
    note: "oneOf unions identically to anyOf — composition is one rule, not three",
  },
  // §7: "and cuts secret-free cycles". `Node` refers to itself and carries no mark, so the walk
  // stops there and still reports the mark outside the cycle. Terminating, not throwing.
  {
    construct: "cut-cycle",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        tree: { $ref: "#/$defs/Node" },
      },
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
    },
    walkable: true,
    paths: ["password"],
    note: "a secret-free cycle is CUT and yields the paths outside it, terminating rather than throwing",
  },
  // The twin: the same shape with the back-edge removed. Identical paths — which is what "cut"
  // means, as opposed to "skipped the subtree" or "gave up".
  {
    construct: "cut-cycle",
    schema: {
      type: "object",
      properties: {
        password: { type: "string", writeOnly: true },
        tree: { $ref: "#/$defs/Node" },
      },
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { type: "string" },
          },
        },
      },
    },
    walkable: true,
    paths: ["password"],
    note: "twin: the same shape with the cycle broken yields exactly the same paths",
  },
  // §7 + §8: the token_issue RESULT shape behind a ref — same construct, same resolution, from
  // the direction the hub only ever masks (it never serves `writeOnly` on an outputSchema).
  {
    construct: "local-ref",
    schema: {
      type: "object",
      properties: { issued: { $ref: "#/$defs/Issued" } },
      $defs: {
        Issued: {
          type: "object",
          properties: {
            key: { type: "string", writeOnly: true },
            tokenId: { type: "string" },
          },
        },
      },
    },
    walkable: true,
    paths: ["issued.key"],
    note: "a ref reaching an outputSchema shape resolves exactly as its inputSchema twin does — indirection is direction-blind too",
  },
  // §7: "What the walk cannot soundly resolve is refused LOUDLY, never skipped — an unresolved
  // ref could conceal a mark: external or non-local refs…". Two spellings, because a check that
  // only rejects absolute URLs still lets the relative one through.
  {
    construct: "external-ref",
    schema: {
      type: "object",
      properties: { cred: { $ref: "https://example.com/schemas/creds.json#/$defs/Creds" } },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    note: "an external ref is refused, naming the construct (twin: the same shape via `#/$defs/…` is accepted)",
  },
  {
    construct: "external-ref",
    schema: {
      type: "object",
      properties: { cred: { $ref: "creds.json#/$defs/Creds" } },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    note: "a non-`#/` ref is refused too — the refuse-line is not a hostname check",
  },
  // §7: `$id` resolution is refused — a re-based document changes what a same-looking `#/…` ref
  // resolves to, so the walk would be guessing. The twin is this schema with `$id` deleted.
  {
    construct: "id",
    schema: {
      $id: "https://example.com/schemas/root.json",
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    note: "`$id` is refused — re-basing changes what a ref resolves to (twin: the same schema without it is accepted)",
  },
  // §7: `$anchor` resolution is refused; the same subschema addressed by JSON Pointer is not.
  {
    construct: "anchor",
    schema: {
      type: "object",
      properties: { cred: { $ref: "#creds" } },
      $defs: {
        Creds: {
          $anchor: "creds",
          type: "object",
          properties: { token: { type: "string", writeOnly: true } },
        },
      },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    note: "`$anchor` is refused (twin: the same target addressed by JSON Pointer is accepted)",
  },
  // §7: `$dynamicRef` is refused — its target depends on the dynamic scope, which a static walk
  // cannot reconstruct. The twin is the static `$ref` to the same subschema.
  {
    construct: "dynamic-ref",
    schema: {
      type: "object",
      properties: { cred: { $dynamicRef: "#creds" } },
      $defs: {
        Creds: {
          $dynamicAnchor: "creds",
          type: "object",
          properties: { token: { type: "string", writeOnly: true } },
        },
      },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { cred: { $ref: "#/$defs/Creds" } },
      $defs: {
        Creds: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
      },
    },
    note: "`$dynamicRef` is refused (twin: the static `$ref` to the same subschema is accepted)",
  },
  // §7: "a recursive cycle carrying a secret (its path set is infinite — no finite path list can
  // express the mask)". The twin is the cut-cycle row's schema: the same self-reference with no
  // mark inside it, which IS accepted — so the refusal is about the secret, not about recursion.
  {
    construct: "recursive-secret",
    schema: {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            secret: { type: "string", writeOnly: true },
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
    },
    walkable: false,
    allowTwin: {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
    },
    note: "a recursive cycle CARRYING a writeOnly is refused — its path set is infinite (twin: the same cycle with no mark inside it is accepted and cut)",
  },
];

/**
 * The refuse-line runner: one case per row, asserting the verdict and — on walkable rows
 * — that the walk actually resolves what the validator promised, which is what keeps the
 * two functions one contract instead of two opinions. Plus the table's honesty invariant,
 * enforced before anything runs: a refusing row with no `allowTwin` fails as a malformed
 * oracle, not as a code regression.
 */
export function runIndirectionTable(rows: readonly IndirectionRow[]): void {
  // deps: vitest describe/it/expect · registry.validateSchemaIndirection · registry.writeOnlyPaths
  const refused = rows.filter((row) => !row.walkable);
  const accepted = rows.filter((row) => row.walkable);

  it("§9 rule 2 · the table itself · every refusing row names an allowTwin using the same construct legally", () => {
    for (const row of refused) {
      expect(row.allowTwin, `refusing row "${row.note}" must name an allowTwin`).toBeDefined();
      // "Legally" is exactly acceptance — the recursive-secret twin is a mark-free cycle,
      // so the twin's job is to be walkable, not to carry a path of its own.
      expect(validateSchemaIndirection(row.allowTwin), `allowTwin of "${row.note}"`).toEqual([]);
      expect(REFUSAL_TITLES[row.construct], `construct "${row.construct}" has no case`).toBeDefined();
    }
  });

  it("§7 · a walkable schema — no indirection at all — yields no violations (the anchor every refusal is read against)", () => {
    expect(accepted.length).toBeGreaterThan(0);
    for (const row of accepted) {
      expect(validateSchemaIndirection(row.schema), `row "${row.note}"`).toEqual([]);
    }
  });

  for (const [construct, title] of Object.entries(REFUSAL_TITLES)) {
    const group = refused.filter((row) => row.construct === construct);
    it(title, () => {
      expect(group.length, `no refusing row for construct "${construct}"`).toBeGreaterThan(0);
      for (const row of group) {
        // Presence, never wording: violations must NAME the construct, but which words
        // they use is incidental (§7) — the `construct` column carries the identification.
        expect(validateSchemaIndirection(row.schema).length, `row "${row.note}"`).toBeGreaterThan(0);
      }
    });
  }

  it("§7 · every accepted row is then walkable: writeOnlyPaths returns the row's paths and never throws — what the validator admits, the walk resolves, so the two can never drift into separate opinions", () => {
    for (const row of accepted) {
      expect(new Set(writeOnlyPaths(row.schema)), `row "${row.note}"`).toEqual(new Set(row.paths ?? []));
    }
  });

  it("§7 · law · pure · the schema handed in is not mutated, and repeated calls agree", () => {
    for (const row of rows) {
      const before = JSON.stringify(row.schema);
      const violations = validateSchemaIndirection(row.schema);
      expect(validateSchemaIndirection(row.schema)).toEqual(violations);
      if (row.walkable) {
        const found = writeOnlyPaths(row.schema);
        expect(writeOnlyPaths(row.schema)).toEqual(found);
      }
      expect(JSON.stringify(row.schema), `row "${row.note}" was mutated`).toBe(before);
    }
  });
}

/**
 * The locked case title for each refusing arm, keyed by the `construct` column — which is
 * exactly what that column exists for. Two spellings of `external-ref` share one case, so
 * the map is per-construct rather than per-row.
 */
const REFUSAL_TITLES: Partial<Record<IndirectionConstruct, string>> = {
  "external-ref":
    "§7 · an external or non-`#/` ref is refused, naming the construct (twin: the same shape via `#/$defs/…` is accepted)",
  id: "§7 · `$id` is refused — re-basing changes what a ref resolves to (twin: the same schema without it is accepted)",
  anchor: "§7 · `$anchor` is refused (twin: the same target addressed by JSON Pointer is accepted)",
  "dynamic-ref": "§7 · `$dynamicRef` is refused (twin: the static `$ref` to the same subschema is accepted)",
  "recursive-secret":
    "§7 · a recursive cycle CARRYING a writeOnly is refused — its path set is infinite, so no finite dot-path list can express the mask (twin: the same cycle with no mark inside it is accepted and cut)",
};

/** A row of the indirection table by its §7 `note` — cases name the sentence, never an index. */
function indirectionRow(note: string): IndirectionRow {
  const row = indirectionRows.find((candidate) => candidate.note === note);
  if (!row) throw new Error(`no indirection row noted "${note}"`);
  return row;
}

/** Accepted-and-resolved, in one assertion: no violations, and exactly the row's paths. */
function expectResolves(...notes: readonly string[]): void {
  for (const note of notes) {
    const row = indirectionRow(note);
    expect(validateSchemaIndirection(row.schema), `row "${note}"`).toEqual([]);
    expect(new Set(writeOnlyPaths(row.schema)), `row "${note}"`).toEqual(new Set(row.paths ?? []));
  }
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
export const redactionRows: readonly RedactionRow[] = [
  // §7: "a copy of `args` with the value at every matching dot-path replaced by REDACTED"
  // (registry.applyRedaction) — every sibling is carried through untouched.
  {
    body: { password: "hunter2", username: "amir" },
    paths: ["password"],
    masked: { password: REDACTED, username: "amir" },
    note: "a top-level path is masked and its siblings are untouched",
  },
  {
    body: { credentials: { token: "t0k3n", id: "abc" }, name: "prod" },
    paths: ["credentials.token"],
    masked: { credentials: { token: REDACTED, id: "abc" }, name: "prod" },
    note: "a nested path is masked, its parent object otherwise intact",
  },
  // §7: "A path meeting an array applies to every element" — which is why the grammar needs no
  // index segment (the walk's array row above).
  {
    body: {
      items: [
        { apiKey: "a1", name: "n1" },
        { apiKey: "a2", name: "n2" },
      ],
    },
    paths: ["items.apiKey"],
    masked: {
      items: [
        { apiKey: REDACTED, name: "n1" },
        { apiKey: REDACTED, name: "n2" },
      ],
    },
    note: "a path meeting an array masks every element",
  },
  // §7: "Redacted fields are REPLACED with the sentinel" — the value at the path goes, whatever
  // it was. A masker that recursed into the object and masked its leaves would leave the object's
  // key set (and so its shape) visible in the audit row.
  // The two paths OVERLAP on purpose, and this is the routine union rather than an edge case: a
  // schema `writeOnly` on credentials.token plus a config `redact: {"<tool>": ["credentials"]}`
  // is exactly ["credentials.token", "credentials"] by the time applyRedaction sees it (§7 —
  // "declared per direction, from two sources, unioned"). Applied in list order, a masker that
  // descends into an already-masked path throws, and one that re-creates the parent leaves
  // `{token: REDACTED, id: "abc"}` — the shape this row says must not survive. The answer is the
  // same whatever order the union arrives in.
  {
    body: { credentials: { token: "t0k3n", id: "abc" } },
    paths: ["credentials.token", "credentials"],
    masked: { credentials: REDACTED },
    note: "a path naming an object masks the whole subtree, never just its leaves",
  },
  // §7: "a path absent from `args` is ignored" (registry.applyRedaction). The union it is handed
  // is a schema ∪ config merge, so paths for absent optional fields are the normal case — and
  // inventing the key would put a REDACTED field into a body that never had one. Twin: the first
  // row, where this same path is present and masked.
  // `credentials.token` is the second half of the same sentence and the half that bites: an
  // absent INTERMEDIATE segment is where `obj[a][b] = R` throws on undefined and where an
  // auto-vivifying masker invents `{credentials: {token: REDACTED}}` — a key the body never had.
  // Since the union carries a schema path for every optional nested secret, this is the normal
  // case for any schema with one, not an edge.
  {
    body: { username: "amir" },
    paths: ["password", "credentials.token"],
    masked: { username: "amir" },
    note: "a path absent from the body is ignored — no key is invented (twin: the same path present is masked)",
  },
  // §7: the input is never mutated, so "nothing to mask" is still a copy, not the same object.
  {
    body: { a: 1, b: { c: 2 } },
    paths: [],
    masked: { a: 1, b: { c: 2 } },
    note: "an empty path list returns an unchanged, deep-equal copy",
  },
  // §7: masking is replacement, not redaction-in-place of a string — a number, a boolean, or an
  // object at a sensitive path leaves as the sentinel, so no value ever survives its own type.
  // The masked value is FALSY on purpose: `0` (like `""`, `false`, `null`) slips past the two
  // commonest masker guards, `if (!obj[k]) return` and a truthiness test standing in for the
  // presence test, which would leave the secret's emptiness — or a literal null — readable in the
  // approval row and the audit body columns. The untouched sibling is falsy for the same reason.
  {
    body: { pin: 0, config: { enabled: false } },
    paths: ["pin"],
    masked: { pin: REDACTED, config: { enabled: false } },
    note: "a masked non-string value becomes registry.REDACTED — the type changes, the field never survives",
  },
];

/**
 * The masking runner: one case per row plus the two invariants that must hold for
 * every row rather than for chosen ones — the input body is never mutated, and masking
 * a masked body changes nothing further. Masked leaves are compared against
 * `registry.REDACTED`, read here rather than re-spelled anywhere (header FINDINGS 1):
 * §7's incidental rule, applied to a string.
 */
export function runRedactionTable(rows: readonly RedactionRow[]): void {
  // deps: vitest describe/it/expect · registry.applyRedaction · registry.REDACTED
  for (const row of rows) {
    it(caseTitle(row.note), () => {
      expect(applyRedaction(row.body, row.paths)).toEqual(row.masked);
    });
  }
}

/**
 * A body carrying a distinct plaintext at every path the walk found — the round-trip
 * law's "a body shaped by that schema", built from the grammar rather than hand-written,
 * so a new walk row needs no new fixture.
 */
function bodyForPaths(paths: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".");
    let node = body;
    for (const segment of segments.slice(0, -1)) {
      if (!isObject(node[segment])) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = `plaintext:${path}`;
  }
  return body;
}

/** The value a dot-path names, or undefined — the read half of the same grammar. */
function valueAtPath(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, segment) => {
    return isObject(node) ? (node as Record<string, unknown>)[segment] : undefined;
  }, body);
}

describe("§7 · writeOnlyPaths — the walk, direction-blind (table)", () => {
  runWriteOnlyWalkTable(writeOnlyWalkRows);
});

describe("§7 · writeOnlyPaths — indirection the walk RESOLVES (table)", () => {
  it("§7 · a writeOnly inside $defs, reached only by a property's `#/$defs/…` ref, yields that property's path — the shape a plain-SDK bot emits by default, and the reason inlining stays optional sugar", () => {
    expectResolves(
      "a writeOnly inside $defs, reached only by a property's `#/$defs/…` ref, yields that property's path",
    );
  });

  it("§7 · a JSON Pointer with escapes (~0, ~1) resolves to the same subschema a plain key would", () => {
    expectResolves("a JSON Pointer with escapes (~0, ~1) resolves to the same subschema a plain key would");
  });

  it("§7 · a ref chain (a property → $defs/A → $defs/B) resolves through to B's marks", () => {
    expectResolves("a ref chain (a property → $defs/A → $defs/B) resolves through to B's marks");
  });

  it("§7 · a mark in ONE anyOf branch masks the property — over-masking is safe, so the union is taken, not the intersection (twin: no branch marks it and no path is yielded)", () => {
    expectResolves(
      "a mark in ONE anyOf branch masks the property — over-masking is safe, so the union is taken, not the intersection",
      "twin: no branch marks it and no path is yielded",
    );
  });

  it("§7 · allOf and oneOf union identically to anyOf — composition is one rule, not three", () => {
    expectResolves(
      "allOf unions identically to anyOf — composition is one rule, not three",
      "oneOf unions identically to anyOf — composition is one rule, not three",
    );
  });

  it("§7 · a secret-free cycle is CUT and yields the paths outside it, terminating rather than throwing (twin: the same shape with the cycle broken yields exactly the same paths)", () => {
    expectResolves(
      "a secret-free cycle is CUT and yields the paths outside it, terminating rather than throwing",
      "twin: the same shape with the cycle broken yields exactly the same paths",
    );
  });

  it("§7 · a ref reaching an outputSchema shape resolves exactly as its inputSchema twin does — indirection is direction-blind too", () => {
    expectResolves(
      "a ref reaching an outputSchema shape resolves exactly as its inputSchema twin does — indirection is direction-blind too",
    );
  });
});

describe("§7 · validateSchemaIndirection — the refuse-line (table)", () => {
  runIndirectionTable(indirectionRows);
});

describe("§7 · applyRedaction — masking, direction-blind (table)", () => {
  runRedactionTable(redactionRows);
});

describe("§7 · the two halves agree — laws", () => {
  it("§7 · law · round-trip · every path writeOnlyPaths finds is masked when applied to a body shaped by that schema", () => {
    const schemas = [
      ...writeOnlyWalkRows.map((row) => row.schema),
      ...indirectionRows.filter((row) => row.walkable).map((row) => row.schema),
    ];
    let masked = 0;
    for (const schema of schemas) {
      const paths = writeOnlyPaths(schema);
      const body = applyRedaction(bodyForPaths(paths), paths);
      for (const path of paths) {
        expect(valueAtPath(body, path), `path "${path}"`).toBe(REDACTED);
        masked += 1;
      }
    }
    expect(masked).toBeGreaterThan(0);
  });

  it("§7 · law · pure · the input body is never mutated, and the result is a new object even when nothing matched", () => {
    for (const row of redactionRows) {
      const before = structuredClone(row.body);
      const result = applyRedaction(row.body, row.paths);
      expect(row.body, `row "${row.note}" mutated its input`).toEqual(before);
      expect(result).not.toBe(row.body);
    }
  });

  it("§7 · law · idempotent · masking a masked body changes nothing further", () => {
    for (const row of redactionRows) {
      const once = applyRedaction(row.body, row.paths);
      expect(applyRedaction(once, row.paths), `row "${row.note}"`).toEqual(once);
    }
  });

  it("§7 · law · direction-blind · the same (body, paths) masks identically whether it came from params.arguments or structuredContent", () => {
    for (const row of redactionRows) {
      const asArguments = applyRedaction(structuredClone(row.body), row.paths);
      const asStructuredContent = applyRedaction(structuredClone(row.body), row.paths);
      expect(asStructuredContent, `row "${row.note}"`).toEqual(asArguments);
      expect(asArguments).toEqual(row.masked);
    }
  });
});
