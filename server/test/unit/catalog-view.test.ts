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

import { describe, it } from "vitest";

describe(`§13 · catalog-view — the Arguments table and reachability are the door's answers`, () => {
  it.todo(`§13 · argumentRows reads a tool's inputSchema top-level properties, required and default and nothing deeper — a nested object yields one row carrying its outer type · a schema with no properties, and a value that is not a schema at all, each yield an empty table rather than a throw (the twin)`);
  it.todo(`§13/§20.3 · reachability IS the door's answer, per agent — for every subject and family, the set it returns and each entry's mode equal registry.buildToolFilter(grants, roles).check(subject, family), and the roles it names are those registry.matchesPattern matched · a subject no granted pattern matches returns [] (the twin)`);
  it.todo(`§13/§8 · reachability takes agent_list's own grant spelling — <role> is allow and <role>:approval is approval, in either order — and hands the door those entries: the mode it reports for an agent holding both on one subject is the door's own check, not a page-side rule · an unparseable or unknown role reaches nothing (the twin)`);
});
