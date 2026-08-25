// migrations.test.ts — the schema is the subject. This file pins §5's D1 tables as
// ENFORCED rules rather than documentation: the CHECK constraints refuse what the
// vocabulary excludes, the UNIQUEs refuse the duplicate, the foreign keys actually
// cascade (SQLite enforces FKs only when told to — a decorative FK looks identical in
// the DDL and fails only in production), the partial unique index §7 step 2 leans on
// exists and kills the double-insert race, and the migration set applies forward over
// live data as well as onto an empty database.
//
// It pins NO module: every other worker file assumes these constraints hold and tests
// behavior on top of them. A constraint that silently stopped biting would make several
// sibling suites pass for the wrong reason, so this file is the one that looks at the
// database directly.
//
// Project: `worker` — the only project with a real D1 binding, and this file touches no
// socket, so it runs parallel under the pool's automatic per-file storage isolation.
// That isolation is load-bearing here and nowhere else: the cascade cases delete `user`
// and `service` rows out from under the seeded namespace, which would wreck any file
// sharing the database. Case order inside the file is free.
//
// One isolation caveat is a real design question for implementation, not a mechanic to
// settle in a comment: the §10 forward-migration case needs a database that is NOT
// already at head, while the pool's setup file applies every migration before any test
// runs. Whether that is a second binding, a scratch database, or a setup opt-out is
// decided when the harness lands — the contract is only that the case observes
// migration N applied to a database holding rows written under N−1.
//
// deps: test/harness/seed (valid-row builders per table) · server/migrations/*.sql (the
// subject) · readD1Migrations + applyD1Migrations (Node-side, from the pool's setup
// file) · env.DB (real D1)

import { describe, it } from "vitest";
import type { ApprovalStatus } from "../../src/approvals";
import type { ServiceKind } from "../../src/registry";

/**
 * The two behavior-bearing CHECK vocabularies of §5, named from the modules that own
 * them: `service.kind` is ServiceKind, `approval.status` is ApprovalStatus. Stating the
 * correspondence here is the drift guard — a union widened in src while the CHECK stays
 * put (or the reverse) is exactly the failure this file exists to catch, and a
 * constraint row naming a value outside these unions is testing the column, as intended.
 */
export type CheckedVocabulary = { kind: ServiceKind; status: ApprovalStatus };

/** The tables §5 defines as ours; better-auth's own tables are not this file's subject. */
export type SchemaTable =
  | "service"
  | "service_account"
  | "grant_"
  | "approval"
  | "token"
  | "audit"
  | "push_subscription";

/**
 * One constraint, stated as the write it refuses beside the write it accepts.
 *
 * The allow-twin (§9 rule 2) is structural rather than a discipline: a schema that
 * refused everything would satisfy a rejected-only table, so `accepted` is not optional.
 * Both fields are column overrides layered onto the seed harness's valid row for
 * `table`, so a row names only the columns the constraint is about — and the twin
 * differs from the rejection in exactly the offending column, which is what makes the
 * pair evidence about that constraint rather than about the row builder.
 */
export type SchemaConstraintRow = {
  title: string;
  table: SchemaTable;
  /** which rule bites — `foreign_key` rows also prove FK enforcement is switched on */
  kind: "check" | "unique" | "not_null" | "foreign_key";
  column?: string;
  rejected: Record<string, unknown>;
  accepted: Record<string, unknown>;
};

/**
 * One parent-row deletion and its full blast radius: which child tables must be empty
 * afterwards, and which must NOT be.
 *
 * `survives` is the load-bearing half. `token.ref_id` carries no foreign key by design
 * (§5), so token rows outliving a `service` delete is correct — their removal is admin's
 * cascade, not D1's, and a test that only checked "everything is gone" would quietly
 * bless an FK someone added to token later, moving that removal out of the code that
 * audits it.
 */
export type CascadeRow = {
  title: string;
  parent: "user" | "service" | "service_account";
  cascades: readonly SchemaTable[];
  survives: readonly SchemaTable[];
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them. Both tables stay empty here; the runners below are
 * agent work.
 */
export const schemaConstraintRows: readonly SchemaConstraintRow[] = [];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const cascadeRows: readonly CascadeRow[] = [];

/**
 * Registers one case per constraint row: the rejected write must fail at the database,
 * and its twin must store. A row whose rejection fails for the wrong reason (a NOT NULL
 * firing where a CHECK was meant) is a mis-transcribed row, not a schema bug — the
 * failure names the row, and §8's `test:` commit is the fix.
 */
export function runSchemaConstraintTable(rows: readonly SchemaConstraintRow[]): void {
  // deps: test/harness/seed · env.DB
  throw new Error("unimplemented");
}

/**
 * Registers one case per cascade row: after the parent delete, every `cascades` table is
 * empty of the seeded namespace's rows and every `survives` table still holds its own.
 */
export function runCascadeTable(rows: readonly CascadeRow[]): void {
  // deps: test/harness/seed · env.DB
  throw new Error("unimplemented");
}

describe("§5 · constraints bite", () => {
  it.todo("one case per schemaConstraintRow — title as authored, e.g. \"§5 · <table>.<column> CHECK refuses <value> · twin stores\"");
  it.todo("\"§5 · the table is exhaustive: every CHECK, UNIQUE and NOT NULL in the applied schema appears in schemaConstraintRows\" — coverage derived from the migration SQL, so a constraint added without a row fails here instead of going unpinned");
});

describe("§5 · cascades", () => {
  it.todo("one case per cascadeRow — title as authored");
  it.todo("\"§5 · foreign keys are enforced, not decorative: a child row naming an absent parent is refused\" (the pragma-off failure mode looks identical in the DDL)");
  it.todo("§5 · token rows survive every parent delete — ref_id has no FK, so deletion stays admin's cascade where it is audited");
});

describe("§7 step 2 · the pending partial unique index", () => {
  it.todo("§7 step 2 · two identical pending bindings: the second insert is refused by the constraint, so the losing first call re-reads the winner's row");
  it.todo("§7 step 2 · the index is partial: the same binding inserts freely once the first row leaves `pending` — total over the ApprovalStatus vocabulary");
  it.todo("§7 step 2 · same (account, service, tool) with a different args_hash opens a second pending row — the binding, not the tool, is what dedups");
});

describe("§10 · applying the set", () => {
  it.todo("§10 · every migration applies to an empty database in order (the fresh-install path)");
  it.todo("§10 · re-application is a no-op: a second run applies nothing and leaves the schema identical");
  it.todo("§10 · forward migration over live data: 1..N−1 applied, rows inserted, N applied — N does not fail on existing rows and the inserted rows survive it");
});
