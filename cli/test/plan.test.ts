/**
 * cli/test/plan.test.ts — the YAML config language stated precisely: what a file
 * MEANS (parseDesired's defaults and grammar, §9/§15) and what a file COSTS
 * (planChanges' create/update/delete/archive steps, their order, their
 * destructive flags, and the severity of a bad file, §8/§9).
 *
 * Project: `unit` — plain Node, parallel, no fixtures. Both functions' deps
 * lines read `none`, which is that project's entire admission rule (strategy
 * §2). (Strategy §3 files this suite under `unit` while §2's project table files
 * "the CLI planner" under `scripts` + clients; both are the same Node-parallel
 * semantics, so the eventual config picks one — nothing here depends on which.)
 * No isolation or ordering constraints exist: the planner is pure, so cases are
 * order-independent and share nothing.
 *
 * This is the one suite strategy §6 calls classic fail-first TDD — the planner
 * is pure, independent of every other vertical slice, and writing the assertion
 * first is cheap. It is therefore deliberately NOT table-shaped: the cases below
 * are individually interesting, not rows of one matrix. The churn protection
 * lives in the last block instead, in the law.
 *
 * Durable vs incidental (§7): durable are which steps a difference produces, in
 * what order, with which `destructive` flag, and which severity a bad file gets.
 * Incidental — never asserted as text — are warning and error PROSE (assert the
 * severity and the offending slug), step `summary` wording (assert that one
 * exists), and any ordering among steps of the same phase.
 *
 * Refusal cases carry their allow-twin in the same block (strategy §9 rule 2):
 * every hard error below sits beside the near-identical file that plans cleanly.
 */

// deps: none (no harness — desired/current are plain literals) · cli/src/plan.ts (parseDesired, planChanges)

import { describe, it } from "vitest";
import type { CurrentState, DesiredConfig } from "../src/plan";

describe("parseDesired · defaults and grammar (§9, §15)", () => {
  it.todo("§9 · every default applied — absent kind → tunnel, absent name → slug, description \"\", archived false, redact/redact_results {} — so two files that mean the same thing normalize equal");
  it.todo("§15 · log_bodies defaults by kind (tunnel true, proxy false), and an explicit value overrides the kind default in both directions");
  it.todo("§9 · proxy defaults: auth \"headers\", forward_identity false");
  it.todo("§9 · `reader:approval` splits into approval mode; bare `reader` is allow — role names carry no colon, so the split is unambiguous");
  it.todo("§9 · an unrecognized key (`rols:`) and a wrong-typed field (redact values not string arrays) each throw naming the offending path — a typo never silently plans a role wipe; twin: the correctly spelled file parses");
  it.todo("§9 · semantic problems (reserved slug, undeclared role, dual-mode grant) do NOT throw here — they are planChanges' errors, so diff reports every problem in one pass");
});

describe("planChanges · the steps a difference produces (§8, §9)", () => {
  it.todo("§9 · file-only service and file-only account → service_create / account_create carrying the normalized fields");
  it.todo("§9 · server-only service and server-only account → service_delete /account_delete, both flagged destructive (grants cascade, tokens deleted)");
  it.todo("§8 · the builtin `pmcp` row is excluded from the delete computation");
  it.todo("§9 · a (account, service) pair absent from `grants:` plans grant_set with an empty role list — absence is desired state, not silence");
  it.todo("§9/§15 · a change in redact, redact_results, or log_bodies alone plans a service_update — either kind");
  it.todo("§9 · proxy-only fields (endpoint, auth, forward_identity, roles) are diffed like any other field");
  it.todo("§8 · an `auth` mode flip plans a service_update flagged destructive — it wipes the stored upstream credentials; twin: any other update is not");
  it.todo("§6/§9 · an `archived` difference plans service_archive / service_unarchive, never an update carrying an archived field");
});

describe("planChanges · severities, every refusal beside its allow-twin (§9)", () => {
  it.todo("§9 · a grant naming a role a TUNNELED service has not declared warns and still plans the grant_set (the file may be ahead of the first connection); twin: a declared role plans with no warning");
  it.todo("§9 · the same undeclared role on a PROXIED service is a hard error — its roles live in this very file; twin: a role the file declares is accepted");
  it.todo("§9 · the built-in `all` is never \"undeclared\": granted on either kind it neither warns nor errors");
  it.todo("§9 · one role granted in both modes for one (account, service) is a hard error; twin: the same role in a single mode is accepted");
  it.todo("§8/§9 · the reserved `pmcp` slug is a hard error as a `services:` key and inside a `grants:` block alike — the reservation is uniform");
  it.todo("§8 · a kind change on an existing slug is a hard error: kind is immutable and the planner never invents a delete-and-recreate the file did not ask for");
});

describe("planChanges · order and laws (§9)", () => {
  it.todo("§9 · one fixture exercising all four phases pins the order deletes → creates → updates and archive transitions → grant_set, and a grant_set naming a service created in the same plan sorts after that create");
  it.todo("§9 · planChanges is total: every semantic problem lands in `errors`, no input throws, and a plan carrying hard errors still returns best-effort steps so diff can show everything at once");
  it.todo("§9 · the empty-plan law — desired derived from an arbitrary current state plans nothing: no steps, no warnings, no errors. This is the file's churn insurance: it holds across every future field, so adding one to the config language costs one case above, not a rewrite here");
});

/**
 * The empty-plan law's other half: project a server state back into the file
 * that would have produced it. Writing this is itself a design check (strategy
 * §6) — if a CurrentService cannot be projected onto a DesiredService without
 * inventing or discarding a field, then desired and current have drifted and the
 * law is unstateable, which is the finding, not a test bug. Runtime facts the
 * planner must never see (online/offline, OAuth connection state, last seen) are
 * absent from CurrentService by construction, so they cannot leak in here; the
 * `builtin` pmcp row is dropped, since no file may name it (§8).
 */
export function desiredFromCurrent(current: CurrentState): DesiredConfig {
  // deps: none
  throw new Error("unimplemented");
}
