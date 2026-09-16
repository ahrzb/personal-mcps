// catalog-view.test.ts — the pure computations behind /apps/<slug>: the Arguments table read
// off a tool's inputSchema, and reachability as the door's own answer (§13, §20.3).
//
// PINS that the page never re-implements the door: the mode an entry carries is
// registry.buildToolFilter(...).check(subject, family), the roles it names are the ones
// registry.matchesPattern matched, and agent_list's own grant spelling ("<role>" /
// "<role>:approval") is parsed here because admin's parser is private and the unit
// project cannot import admin. Node-clean: server/src/catalog-view.ts imports registry only.
//
// D15 (2026-09-02) — rows landed as it.todo from docs/superpowers/plans/2026-09-02-d15-panes.md;
// each row's mechanics are on its `asserts:` line there.

// deps: none (no harness — pure seams) · src/catalog-view · registry.buildToolFilter (the door itself, never faked) · no platform APIs

import { describe, it, expect } from "vitest";
import { argumentRows, reachability } from "../../src/catalog-view";
import { buildToolFilter } from "../../src/registry";
import type { GrantEntry, RoleDeclaration, RoleFamily } from "../../src/registry";

/**
 * §20.3's own edges as one table, so every law below is asserted over the same subjects:
 * a literal, a name the literal must NOT prefix-match, a pattern hit, a prompt name, a
 * resource URI under a glob, a URI outside it, and a raw uriTemplate read as an ordinary
 * subject.
 */
const SUBJECTS: readonly { subject: string; family: RoleFamily }[] = [
  { subject: "paper_fetch", family: "tools" },
  { subject: "paper_fetchX", family: "tools" },
  { subject: "jobfeed_crawl", family: "tools" },
  { subject: "digest_daily", family: "prompts" },
  { subject: "news://feed/latest", family: "resources" },
  { subject: "news://sources", family: "resources" },
  { subject: "news://feed/{id}", family: "resources" },
];

describe(`§13 · catalog-view — the Arguments table and reachability are the door's answers`, () => {
  it(`§13 · argumentRows reads a tool's inputSchema top-level properties, required and default and nothing deeper — a nested object yields one row carrying its outer type · a schema with no properties, and a value that is not a schema at all, each yield an empty table rather than a throw (the twin)`, () => {
    const rows = argumentRows({
      type: "object",
      properties: {
        doi: { type: "string" },
        force_refresh: { type: "boolean", default: false },
        options: { type: "object", properties: { depth: { type: "number" } } },
      },
      required: ["doi"],
    });
    // The schema's own declaration order, one row per top-level property.
    expect(rows.map((row) => row.name)).toEqual(["doi", "force_refresh", "options"]);
    expect(rows[0]).toEqual({ name: "doi", type: "string", required: true, hasDefault: false });
    // The default's VALUE, so the page renders `false` and not `"false"`.
    expect(rows[1]).toEqual({
      name: "force_refresh",
      type: "boolean",
      required: false,
      hasDefault: true,
      default: false,
    });
    expect(rows[1].default).toBe(false);
    // §13's ceiling: a nested schema prints its OUTER type and is not recursed into.
    expect(rows[2]).toEqual({ name: "options", type: "object", required: false, hasDefault: false });
    expect(rows.some((row) => row.name === "depth")).toBe(false);
    // An absent `required` and an empty one both mark every row optional.
    for (const schema of [
      { type: "object", properties: { doi: { type: "string" } }, required: [] },
      { type: "object", properties: { doi: { type: "string" } } },
    ]) {
      expect(argumentRows(schema).map((row) => row.required)).toEqual([false]);
    }
    // THE TWIN: a tool with no arguments has an empty table, never a thrown one — which is
    // what the `no args` render rests on.
    for (const notASchema of [{ type: "object" }, {}, undefined, null, "nope", []]) {
      expect(argumentRows(notASchema), JSON.stringify(notASchema) ?? "undefined").toEqual([]);
    }
  });

  it(`§13/§20.3 · reachability IS the door's answer, per agent — for every subject and family, the set it returns and each entry's mode equal registry.buildToolFilter(grants, roles).check(subject, family), and the roles it names are those registry.matchesPattern matched · a subject no granted pattern matches returns [] (the twin)`, () => {
    const declared: RoleDeclaration = {
      reader: { tools: ["paper_fetch"], prompts: ["digest_.*"], resources: ["news://feed/*"] },
      crawler: ["jobfeed_.*"],
    };
    // `a` holds the built-in `all`, a role the declaration never mentions (§18 decision 10).
    const held: Record<string, GrantEntry[]> = {
      r: [{ role: "reader", mode: "allow" }],
      c: [{ role: "crawler", mode: "approval" }],
      a: [{ role: "all", mode: "allow" }],
    };
    const grants = { r: ["reader"], c: ["crawler:approval"], a: ["all"] };

    // THE LAW, over §20.3's own edges: the page's answer per (agent, subject, family) IS the
    // door's. Asserting against `check` rather than against transcribed booleans is the
    // point — a page-side re-derivation of `*`-aliasing, anchoring, the literal fast path,
    // `all`'s span or allow-precedence cannot pass this.
    let compared = 0;
    for (const { subject, family } of SUBJECTS) {
      const reached = reachability(subject, family, declared, grants);
      for (const [agent, entries] of Object.entries(held)) {
        const verdict = buildToolFilter(entries, declared).check(subject, family);
        const entry = reached.find((row) => row.agent === agent);
        expect(entry !== undefined, `${agent} on ${subject} (${family})`).toBe(verdict !== "deny");
        if (entry !== undefined) {
          expect(entry.mode, `${agent} on ${subject} (${family})`).toBe(verdict);
          // The roles named are the granted ones that matched — `all` names itself, never
          // expanded into the declaration's role names.
          for (const role of entry.roles) {
            expect(entries.map((held) => held.role)).toContain(role);
            expect(buildToolFilter([{ role, mode: "allow" }], declared).check(subject, family)).toBe("allow");
          }
          expect(entry.roles.length).toBeGreaterThan(0);
        }
        compared += 1;
      }
    }
    expect(compared).toBe(SUBJECTS.length * Object.keys(held).length);
    expect(reachability("paper_fetch", "tools", declared, grants).find((row) => row.agent === "r")?.roles).toEqual([
      "reader",
    ]);
    // THE TWIN, from the same call shape: a subject no granted pattern matches reaches
    // nobody — the value the page renders "Reachable by no agent yet" for. `a` is dropped
    // from the grants here, because the built-in `all` reaches everything by construction.
    const { a: _all, ...withoutAll } = grants;
    expect(reachability("secret_push", "tools", declared, withoutAll)).toEqual([]);
    expect(reachability("paper_fetch", "tools", declared, withoutAll).map((row) => row.agent)).toEqual(["r"]);
  });

  it(`§13/§8 · reachability takes agent_list's own grant spelling — <role> is allow and <role>:approval is approval, in either order — and hands the door those entries: the mode it reports for an agent holding both on one subject is the door's own check, not a page-side rule · an unparseable or unknown role reaches nothing (the twin)`, () => {
    const declared: RoleDeclaration = {
      crawler: ["jobfeed_.*"],
      both: { tools: ["jobfeed_crawl"] },
      reader: { tools: ["paper_fetch"] },
    };
    const grants = {
      a: ["crawler:approval"],
      b: ["crawler:approval", "both"],
      c: ["reader"],
      d: ["nosuchrole"],
    };
    // The parse this module owns, spelled as the door's entries — the assertion below is
    // against `check` over exactly these, so a downgrade of `:approval` to allow shows up.
    const parsed: Record<string, GrantEntry[]> = {
      a: [{ role: "crawler", mode: "approval" }],
      b: [
        { role: "crawler", mode: "approval" },
        { role: "both", mode: "allow" },
      ],
      c: [{ role: "reader", mode: "allow" }],
      d: [{ role: "nosuchrole", mode: "allow" }],
    };

    const reached = reachability("jobfeed_crawl", "tools", declared, grants);
    expect(reached.map((row) => row.agent).sort()).toEqual(["a", "b"]);
    for (const row of reached) {
      expect(row.mode, row.agent).toBe(buildToolFilter(parsed[row.agent], declared).check("jobfeed_crawl", "tools"));
    }
    // `b` holds both, so both matched role names are named — and allow-beats-approval is the
    // door's answer here, not a page-side rule.
    expect([...(reached.find((row) => row.agent === "b")?.roles ?? [])].sort()).toEqual(["both", "crawler"]);
    // Order-independent, as the door's own law is: the same two strings the other way round
    // reach the same agent in the same mode naming the same roles. Compared as SETS — which
    // roles matched is the claim; the order they are listed in is the render's, and §13
    // pins none.
    const named = (spelled: string[]): unknown =>
      reachability("jobfeed_crawl", "tools", declared, { b: spelled }).map((row) => ({
        ...row,
        roles: [...row.roles].sort(),
      }));
    expect(named(["both", "crawler:approval"])).toEqual(named(grants.b));
    // THE TWIN that keeps "absent" meaningful: `c` is absent here and present for the
    // subject its own role names, from the same call shape.
    expect(reachability("paper_fetch", "tools", declared, grants).map((row) => row.agent)).toEqual(["c"]);
    // A role the declaration does not mention, and a suffix that is not `:approval`: legal
    // inputs both, reaching nothing in any family rather than throwing.
    for (const family of ["tools", "prompts", "resources"] as const) {
      for (const { subject } of SUBJECTS) {
        expect(reachability(subject, family, declared, { d: grants.d })).toEqual([]);
        expect(reachability(subject, family, declared, { d: ["crawler:bogus"] })).toEqual([]);
      }
    }
  });
});

// D16 (2026-09-17) — rows landed as it.todo from
// docs/superpowers/plans/2026-09-17-app-three-pane.md §1 (catalog schema leaves).

describe("§13 · catalog-view — schemaLeaves, the whole schema as dotted paths", () => {
  it.todo(
    "§13 · schemaLeaves walks a schema into dotted leaf paths: a nested object is RECURSED into and contributes `credentials.token` rather than a row named `credentials`, an array contributes one leaf typed `<type>[]` and is never recursed into, and `required` is read from EACH level's own list — a required object holding an optional child yields one required leaf and one optional one · twin: `argumentRows` over the same schema still reads the top level alone, which is why both exports stay",
  );

  it.todo(
    "§13 · every leaf carries `writeOnly` as declared and the schema's own default VALUE — `false`, not `\"false\"` — with `hasDefault` telling a declared `default: undefined` from no default at all, exactly as `argumentRows` does · twin: a value that is not a schema, a schema with no `properties`, and an absent schema each yield an empty list rather than a throw inside a page render",
  );
});
