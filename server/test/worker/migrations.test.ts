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

import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApprovalStatus } from "../../src/approvals";
import { APPROVAL_WINDOW_MS, OAUTH_STATE_TTL_MS } from "../../src/limits";
import type { ServiceKind } from "../../src/registry";

/**
 * The two behavior-bearing CHECK vocabularies of §5, named from the modules that own
 * them: `service.kind` is ServiceKind, `approval.status` is ApprovalStatus. Stating the
 * correspondence here is the drift guard — a union widened in src while the CHECK stays
 * put (or the reverse) is exactly the failure this file exists to catch, and a
 * constraint row naming a value outside these unions is testing the column, as intended.
 */
export type CheckedVocabulary = { kind: ServiceKind; status: ApprovalStatus };

/**
 * The tables §5 defines as ours; better-auth's own tables are not this file's subject.
 * `upstream_oauth_state` is 0004's — declared for §7's upstream-OAuth connect flow rather
 * than listed in §5's own table list, but it is a control-plane table of ours like every
 * other name here, so it is pinned like every other name here. 0004's file header carries
 * a `ponytail:` note calling it unpinned and naming exactly the four places to add it
 * (SchemaTable, SCHEMA_TABLES, baseRow, ctxFilter); that note is answered as of the rows
 * below and is stale where it still stands.
 */
export type SchemaTable =
  | "service"
  | "service_account"
  | "grant_"
  | "approval"
  | "token"
  | "audit"
  | "push_subscription"
  | "upstream_oauth_state";

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
 * rule 1) — agents never fill them. The runners below are agent work.
 */
export const schemaConstraintRows: readonly SchemaConstraintRow[] = [
  // How to read every row below. `rejected` and `accepted` are column overrides on the seed
  // harness's valid row for `table`, so a row names only the columns its constraint is about.
  // Three conventions carry the table:
  //  · a `unique` row's `rejected` overrides are written TWICE — they name the duplicate
  //    tuple, and only the SECOND write must fail; its twin differs in one column and stores
  //    beside the first. That reading needs the valid row to carry a FRESH primary key per
  //    call, or the id would be the duplicate that bites instead of the named constraint —
  //    which is the mis-transcribed-row failure this file's header warns about;
  //  · an empty `accepted` means "the valid row's own value" — the only honest twin for a
  //    column whose valid value is a seeded parent's id, since any literal put there would
  //    trip the foreign key instead of the constraint under test;
  //  · every fixture id, hash and prefix is spelled FAKE on purpose (§15 log hygiene: no
  //    realistic-looking credential material in this repo, tests included).

  // ——— service (§5) ———
  // "kind TEXT NOT NULL DEFAULT 'tunnel' CHECK (kind IN ('tunnel', 'proxy'))" — the CHECK
  // and registry's ServiceKind are the same vocabulary (CheckedVocabulary above), so a
  // value outside it is the drift this row exists to catch.
  {
    title: "§5 · service.kind CHECK refuses 'websocket' · twin stores 'proxy'",
    table: "service",
    kind: "check",
    column: "kind",
    rejected: { kind: "websocket" },
    accepted: { kind: "proxy" },
  },
  // "upstream_auth_mode TEXT CHECK (upstream_auth_mode IN ('headers', 'oauth'))" — the
  // declared mode is configuration (§7); the column is nullable, so the CHECK's whole job
  // is refusing a third spelling.
  {
    title: "§5 · service.upstream_auth_mode CHECK refuses 'basic' · twin stores 'oauth'",
    table: "service",
    kind: "check",
    column: "upstream_auth_mode",
    rejected: { upstream_auth_mode: "basic" },
    accepted: { upstream_auth_mode: "oauth" },
  },
  {
    title: "§5 · service.owner_id NOT NULL refuses null · twin stores under the seeded owner",
    table: "service",
    kind: "not_null",
    column: "owner_id",
    rejected: { owner_id: null },
    accepted: {},
  },
  {
    title: "§5 · service.slug NOT NULL refuses null · twin stores 'slug-twin'",
    table: "service",
    kind: "not_null",
    column: "slug",
    rejected: { slug: null },
    accepted: { slug: "slug-twin" },
  },
  {
    title: "§5 · service.name NOT NULL refuses null · twin stores a name",
    table: "service",
    kind: "not_null",
    column: "name",
    rejected: { name: null },
    accepted: { name: "Name Twin" },
  },
  {
    title: "§5 · service.kind NOT NULL refuses null · twin stores 'tunnel'",
    table: "service",
    kind: "not_null",
    column: "kind",
    rejected: { kind: null },
    accepted: { kind: "tunnel" },
  },
  {
    title: "§5 · service.forward_identity NOT NULL refuses null · twin stores 0",
    table: "service",
    kind: "not_null",
    column: "forward_identity",
    rejected: { forward_identity: null },
    accepted: { forward_identity: 0 },
  },
  {
    title: "§5 · service.roles_json NOT NULL refuses null · twin stores '{}'",
    table: "service",
    kind: "not_null",
    column: "roles_json",
    rejected: { roles_json: null },
    accepted: { roles_json: "{}" },
  },
  {
    title: "§5 · service.redact_json NOT NULL refuses null · twin stores '{}'",
    table: "service",
    kind: "not_null",
    column: "redact_json",
    rejected: { redact_json: null },
    accepted: { redact_json: "{}" },
  },
  {
    title: "§5 · service.redact_results_json NOT NULL refuses null · twin stores '{}'",
    table: "service",
    kind: "not_null",
    column: "redact_results_json",
    rejected: { redact_results_json: null },
    accepted: { redact_results_json: "{}" },
  },
  // "log_bodies INTEGER NOT NULL": §15's by-kind default is resolved at create, so the
  // stored column is always concrete. What this row proves is only that an explicit null is
  // refused — in SQLite a column DEFAULT applies when the column is OMITTED, so
  // `NOT NULL DEFAULT 1` (the tempting migration, since every other NOT NULL column here
  // carries one) passes this row unchanged while silently giving proxied services
  // bodies-on. Isolating THAT would need a write omitting the column, which the
  // rejected/accepted override shape cannot express; the by-kind resolution is pinned where
  // it actually lives, on createService (registry.test.ts, §15).
  {
    title: "§5/§15 · service.log_bodies NOT NULL refuses an explicit null · twin stores 1",
    table: "service",
    kind: "not_null",
    column: "log_bodies",
    rejected: { log_bodies: null },
    accepted: { log_bodies: 1 },
  },
  {
    title: "§5 · service.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "service",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  // "UNIQUE (owner_id, slug)" — §2's "(owner, slug) identifies a service", enforced.
  {
    title: "§5 · service UNIQUE (owner_id, slug) refuses a second 'twice-over' for one owner · twin stores 'twice-over-2'",
    table: "service",
    kind: "unique",
    column: "(owner_id, slug)",
    rejected: { slug: "twice-over" },
    accepted: { slug: "twice-over-2" },
  },
  {
    title: "§5 · service.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "service",
    kind: "unique",
    column: "id",
    rejected: { id: "svc_FAKE0000_dup" },
    accepted: { id: "svc_FAKE0000_other" },
  },
  // "owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE" — better-auth owns the
  // `user` table (§5), and this is one of the four columns that reference it.
  {
    title: "§5 · service.owner_id FK refuses an absent user · twin stores under the seeded owner",
    table: "service",
    kind: "foreign_key",
    column: "owner_id",
    rejected: { owner_id: "usr_FAKE0000_absent" },
    accepted: {},
  },

  // ——— service_account (§5) ———
  {
    title: "§5 · service_account.owner_id NOT NULL refuses null · twin stores under the seeded owner",
    table: "service_account",
    kind: "not_null",
    column: "owner_id",
    rejected: { owner_id: null },
    accepted: {},
  },
  {
    title: "§5 · service_account.slug NOT NULL refuses null · twin stores 'account-twin'",
    table: "service_account",
    kind: "not_null",
    column: "slug",
    rejected: { slug: null },
    accepted: { slug: "account-twin" },
  },
  {
    title: "§5 · service_account.name NOT NULL refuses null · twin stores a name",
    table: "service_account",
    kind: "not_null",
    column: "name",
    rejected: { name: null },
    accepted: { name: "Account Twin" },
  },
  {
    title: "§5 · service_account.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "service_account",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  {
    title: "§5 · service_account UNIQUE (owner_id, slug) refuses a second 'twice-over' for one owner · twin stores 'twice-over-2'",
    table: "service_account",
    kind: "unique",
    column: "(owner_id, slug)",
    rejected: { slug: "twice-over" },
    accepted: { slug: "twice-over-2" },
  },
  {
    title: "§5 · service_account.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "service_account",
    kind: "unique",
    column: "id",
    rejected: { id: "sa_FAKE0000_dup" },
    accepted: { id: "sa_FAKE0000_other" },
  },
  {
    title: "§5 · service_account.owner_id FK refuses an absent user · twin stores under the seeded owner",
    table: "service_account",
    kind: "foreign_key",
    column: "owner_id",
    rejected: { owner_id: "usr_FAKE0000_absent" },
    accepted: {},
  },

  // ——— grant_ (§5) ———
  // "mode TEXT NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'approval'))" — registry's
  // AccessMode has a third member, `deny`, which is a RESOLVER answer and never a stored
  // grant. The column is where that distinction is made structural.
  {
    title: "§5 · grant_.mode CHECK refuses 'deny' — deny is a resolver answer, never a stored grant · twin stores 'approval'",
    table: "grant_",
    kind: "check",
    column: "mode",
    rejected: { mode: "deny" },
    accepted: { mode: "approval" },
  },
  {
    title: "§5 · grant_.service_account_id NOT NULL refuses null · twin stores the seeded account",
    table: "grant_",
    kind: "not_null",
    column: "service_account_id",
    rejected: { service_account_id: null },
    accepted: {},
  },
  {
    title: "§5 · grant_.service_id NOT NULL refuses null · twin stores the seeded service",
    table: "grant_",
    kind: "not_null",
    column: "service_id",
    rejected: { service_id: null },
    accepted: {},
  },
  {
    title: "§5 · grant_.role NOT NULL refuses null · twin stores 'reader'",
    table: "grant_",
    kind: "not_null",
    column: "role",
    rejected: { role: null },
    accepted: { role: "reader" },
  },
  {
    title: "§5 · grant_.mode NOT NULL refuses null · twin stores 'allow'",
    table: "grant_",
    kind: "not_null",
    column: "mode",
    rejected: { mode: null },
    accepted: { mode: "allow" },
  },
  {
    title: "§5 · grant_ PRIMARY KEY (service_account_id, service_id, role) refuses the same role twice · twin stores a second role",
    table: "grant_",
    kind: "unique",
    column: "(service_account_id, service_id, role)",
    rejected: { role: "twice-over" },
    accepted: { role: "twice-over-2" },
  },
  {
    title: "§5 · grant_.service_account_id FK refuses an absent account · twin stores the seeded account",
    table: "grant_",
    kind: "foreign_key",
    column: "service_account_id",
    rejected: { service_account_id: "sa_FAKE0000_absent" },
    accepted: {},
  },
  {
    title: "§5 · grant_.service_id FK refuses an absent service · twin stores the seeded service",
    table: "grant_",
    kind: "foreign_key",
    column: "service_id",
    rejected: { service_id: "svc_FAKE0000_absent" },
    accepted: {},
  },

  // ——— approval (§5, §7) ———
  // "status … CHECK (status IN ('pending','approved','rejected','expired','used'))" — the
  // same five-member vocabulary as approvals.ApprovalStatus (CheckedVocabulary above).
  {
    title: "§5 · approval.status CHECK refuses 'cancelled' · twin stores 'used'",
    table: "approval",
    kind: "check",
    column: "status",
    rejected: { status: "cancelled" },
    accepted: { status: "used" },
  },
  {
    title: "§5 · approval.owner_id NOT NULL refuses null · twin stores under the seeded owner",
    table: "approval",
    kind: "not_null",
    column: "owner_id",
    rejected: { owner_id: null },
    accepted: {},
  },
  {
    title: "§5 · approval.service_account_id NOT NULL refuses null · twin stores the seeded account",
    table: "approval",
    kind: "not_null",
    column: "service_account_id",
    rejected: { service_account_id: null },
    accepted: {},
  },
  {
    title: "§5 · approval.service_id NOT NULL refuses null · twin stores the seeded service",
    table: "approval",
    kind: "not_null",
    column: "service_id",
    rejected: { service_id: null },
    accepted: {},
  },
  {
    title: "§5 · approval.tool NOT NULL refuses null · twin stores 'get_news'",
    table: "approval",
    kind: "not_null",
    column: "tool",
    rejected: { tool: null },
    accepted: { tool: "get_news" },
  },
  {
    title: "§5 · approval.args_hash NOT NULL refuses null · twin stores a hash",
    table: "approval",
    kind: "not_null",
    column: "args_hash",
    rejected: { args_hash: null },
    accepted: { args_hash: "sha256_FAKE0000_args" },
  },
  {
    title: "§5 · approval.args_json NOT NULL refuses null — the shown arguments are never absent · twin stores '{}'",
    table: "approval",
    kind: "not_null",
    column: "args_json",
    rejected: { args_json: null },
    accepted: { args_json: "{}" },
  },
  {
    title: "§5 · approval.status NOT NULL refuses null · twin stores 'pending'",
    table: "approval",
    kind: "not_null",
    column: "status",
    rejected: { status: null },
    accepted: { status: "pending" },
  },
  {
    title: "§5 · approval.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "approval",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  // "expires_at INTEGER NOT NULL — 1 h from creation; covers both the pending wait and the
  // post-approval retry window": every read interprets expiry (§7), so the column can never
  // be absent for a reader to guess at. The twin is the created_at anchor plus the window
  // BY NAME, never a re-spelled literal — the fixture is what the next agent reads as the
  // shape of a real approval row, and an hour written at second scale reads as a 3.6 s one.
  {
    title: "§5/§7 · approval.expires_at NOT NULL refuses null — lazy expiry has nothing to interpret without it · twin stores a timestamp",
    table: "approval",
    kind: "not_null",
    column: "expires_at",
    rejected: { expires_at: null },
    accepted: { expires_at: 1_700_000_000_000 + APPROVAL_WINDOW_MS },
  },
  {
    title: "§5 · approval.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "approval",
    kind: "unique",
    column: "id",
    rejected: { id: "apr_FAKE0000_dup" },
    accepted: { id: "apr_FAKE0000_other" },
  },
  {
    title: "§5 · approval.owner_id FK refuses an absent user · twin stores under the seeded owner",
    table: "approval",
    kind: "foreign_key",
    column: "owner_id",
    rejected: { owner_id: "usr_FAKE0000_absent" },
    accepted: {},
  },
  {
    title: "§5 · approval.service_account_id FK refuses an absent account · twin stores the seeded account",
    table: "approval",
    kind: "foreign_key",
    column: "service_account_id",
    rejected: { service_account_id: "sa_FAKE0000_absent" },
    accepted: {},
  },
  {
    title: "§5 · approval.service_id FK refuses an absent service · twin stores the seeded service",
    table: "approval",
    kind: "foreign_key",
    column: "service_id",
    rejected: { service_id: "svc_FAKE0000_absent" },
    accepted: {},
  },
  // §7 step 2's partial unique index on (service_account_id, service_id, tool, args_hash)
  // WHERE status = 'pending' (declared with approvals' migration; §5's table plus this
  // constraint). Here it is pinned as a constraint like any other — that it is PARTIAL, and
  // that the losing insert re-reads the winner, are the §7-step-2 cases below.
  {
    title: "§7 step 2 · approval UNIQUE (service_account_id, service_id, tool, args_hash) WHERE status='pending' refuses the second pending row for one binding · twin stores a different args_hash",
    table: "approval",
    kind: "unique",
    column: "(service_account_id, service_id, tool, args_hash) WHERE status = 'pending'",
    rejected: { status: "pending", args_hash: "sha256_FAKE0000_binding" },
    accepted: { status: "pending", args_hash: "sha256_FAKE0000_binding-2" },
  },
  // The same constraint from the other side: `tool` is a KEY column of the binding, not
  // payload. An index over (service_account_id, service_id, args_hash) WHERE status =
  // 'pending' passes the row above and every §7-step-2 case below, and is not academic —
  // two no-argument approval-gated tools on one service hash to the identical canonical
  // `{}` (unit/canonical.test.ts pins `undefined ≡ {}`), so the second pending row would be
  // refused and the gate would re-read the OTHER tool's row: approving tool A silently
  // authorizes tool B. The twin holds args_hash fixed and differs only in `tool`.
  {
    title: "§7 step 2 · the same pending binding under a DIFFERENT tool opens its own row — `tool` is a key column of the index, so one approval can never answer for another tool",
    table: "approval",
    kind: "unique",
    column: "(service_account_id, service_id, tool, args_hash) WHERE status = 'pending'",
    rejected: { status: "pending", tool: "gate_tool", args_hash: "sha256_FAKE0000_tool-key" },
    accepted: { status: "pending", tool: "gate_tool-2", args_hash: "sha256_FAKE0000_tool-key" },
  },

  // ——— token (§5, §6) ———
  // "kind TEXT NOT NULL CHECK (kind IN ('service_account', 'service'))" — the column §6
  // insists is read explicitly rather than inferred from the pmcp_sa_/pmcp_svc_ prefix.
  {
    title: "§5 · token.kind CHECK refuses 'user' — session tokens are better-auth's, never rows here · twin stores 'service_account'",
    table: "token",
    kind: "check",
    column: "kind",
    rejected: { kind: "user" },
    accepted: { kind: "service_account" },
  },
  {
    title: "§5 · token.kind NOT NULL refuses null · twin stores 'service'",
    table: "token",
    kind: "not_null",
    column: "kind",
    rejected: { kind: null },
    accepted: { kind: "service" },
  },
  // "(`ref_id` can't be a foreign key to two tables …)" — so the twin here doubles as the
  // evidence that the column is deliberately unconstrained: a dangling ref_id STORES, and
  // removing it is admin's cascade (§8), where it is audited.
  {
    title: "§5 · token.ref_id NOT NULL refuses null · twin stores an id no row carries — ref_id points at two tables and so carries no FK",
    table: "token",
    kind: "not_null",
    column: "ref_id",
    rejected: { ref_id: null },
    accepted: { ref_id: "svc_FAKE0000_dangling" },
  },
  {
    title: "§5 · token.hash NOT NULL refuses null · twin stores a hash",
    table: "token",
    kind: "not_null",
    column: "hash",
    rejected: { hash: null },
    accepted: { hash: "sha256_FAKE0000_live" },
  },
  {
    title: "§5 · token.prefix NOT NULL refuses null — the listing has nothing to show without it · twin stores a prefix",
    table: "token",
    kind: "not_null",
    column: "prefix",
    rejected: { prefix: null },
    accepted: { prefix: "pmcp_svc_FAKE" },
  },
  {
    title: "§5 · token.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "token",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  // "hash TEXT NOT NULL UNIQUE" — the lookup key every credential resolve goes through.
  {
    title: "§5 · token.hash UNIQUE refuses a second row with the same hash · twin stores a different hash",
    table: "token",
    kind: "unique",
    column: "hash",
    rejected: { hash: "sha256_FAKE0000_dup" },
    accepted: { hash: "sha256_FAKE0000_dup-2" },
  },
  {
    title: "§5 · token.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "token",
    kind: "unique",
    column: "id",
    rejected: { id: "tok_FAKE0000_dup" },
    accepted: { id: "tok_FAKE0000_other" },
  },

  // ——— audit (§5, §15) ———
  {
    title: "§5 · audit.ts NOT NULL refuses null · twin stores a timestamp",
    table: "audit",
    kind: "not_null",
    column: "ts",
    rejected: { ts: null },
    accepted: { ts: 1_700_000_000_000 },
  },
  // "owner_id TEXT NOT NULL -- namespace the event happened in" carries no REFERENCES: the
  // record of record outlives the namespace it describes, and retention (§15), not a
  // cascade, is what removes it. The twin is a namespace id no `user` row carries.
  {
    title: "§5/§15 · audit.owner_id NOT NULL refuses null · twin stores a namespace id no user row carries — audit carries no FK, so the record outlives the namespace",
    table: "audit",
    kind: "not_null",
    column: "owner_id",
    rejected: { owner_id: null },
    accepted: { owner_id: "usr_FAKE0000_gone" },
  },
  {
    title: "§5 · audit.principal NOT NULL refuses null · twin stores 'bootstrap'",
    table: "audit",
    kind: "not_null",
    column: "principal",
    rejected: { principal: null },
    accepted: { principal: "bootstrap" },
  },
  {
    title: "§5 · audit.event NOT NULL refuses null · twin stores 'tools/call'",
    table: "audit",
    kind: "not_null",
    column: "event",
    rejected: { event: null },
    accepted: { event: "tools/call" },
  },
  // outcome is NOT NULL with NO CHECK by design — the vocabulary in §5's comment grows with
  // every new JSON-RPC code, and a CHECK there would make a new refusal code a migration.
  {
    title: "§5 · audit.outcome NOT NULL refuses null · twin stores '-32001'",
    table: "audit",
    kind: "not_null",
    column: "outcome",
    rejected: { outcome: null },
    accepted: { outcome: "-32001" },
  },
  {
    title: "§5 · audit.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "audit",
    kind: "unique",
    column: "id",
    rejected: { id: 424_242 },
    accepted: { id: 424_243 },
  },

  // ——— push_subscription (§5, §13) ———
  {
    title: "§5 · push_subscription.user_id NOT NULL refuses null · twin stores under the seeded owner",
    table: "push_subscription",
    kind: "not_null",
    column: "user_id",
    rejected: { user_id: null },
    accepted: {},
  },
  {
    title: "§5 · push_subscription.endpoint NOT NULL refuses null · twin stores an endpoint",
    table: "push_subscription",
    kind: "not_null",
    column: "endpoint",
    rejected: { endpoint: null },
    accepted: { endpoint: "https://push.example.invalid/FAKE0000" },
  },
  {
    title: "§5 · push_subscription.keys_json NOT NULL refuses null · twin stores the browser's key pair",
    table: "push_subscription",
    kind: "not_null",
    column: "keys_json",
    rejected: { keys_json: null },
    accepted: { keys_json: '{"p256dh":"FAKE0000","auth":"FAKE0000"}' },
  },
  {
    title: "§5 · push_subscription.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "push_subscription",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  // "endpoint TEXT NOT NULL UNIQUE" — what makes re-subscribing one browser an upsert
  // rather than a duplicate notification (approvals.subscribePush).
  {
    title: "§5 · push_subscription.endpoint UNIQUE refuses a second row for one endpoint · twin stores a different endpoint",
    table: "push_subscription",
    kind: "unique",
    column: "endpoint",
    rejected: { endpoint: "https://push.example.invalid/twice-over" },
    accepted: { endpoint: "https://push.example.invalid/twice-over-2" },
  },
  {
    title: "§5 · push_subscription.id PRIMARY KEY refuses a duplicate id · twin stores a distinct id",
    table: "push_subscription",
    kind: "unique",
    column: "id",
    rejected: { id: "psh_FAKE0000_dup" },
    accepted: { id: "psh_FAKE0000_other" },
  },
  {
    title: "§5 · push_subscription.user_id FK refuses an absent user · twin stores under the seeded owner",
    table: "push_subscription",
    kind: "foreign_key",
    column: "user_id",
    rejected: { user_id: "usr_FAKE0000_absent" },
    accepted: {},
  },

  // ——— upstream_oauth_state (§5, §7) ———
  // 0004's table: the connect flow's one-time `state` record, "bound to {owner, service,
  // expected AS issuer + token endpoint, PKCE verifier} and to the initiating cookie
  // session". Every column is one clause of that sentence, and every clause is NOT NULL —
  // an absent one would leave the callback resolving a binding it cannot check. Two
  // absences are the design and so have no row: no CHECK anywhere (there is no closed
  // vocabulary here — `issuer` and `token_endpoint` are whatever the discovered AS said),
  // and `session_id` carries no FK (better-auth owns `session`, and a signed-out session
  // must not silently delete a live state row — the callback refuses it instead).
  //
  // `state` is a bare TEXT PRIMARY KEY, so it gets a duplicate row and NOT a null one:
  // SQLite's long-standing rowid-table quirk admits NULL into a non-INTEGER PRIMARY KEY,
  // and a row asserting otherwise would be pinning the fixture rather than the schema. The
  // uniqueness IS the security property — a `state` that could repeat is a nonce that is
  // not one — which is why the row that does exist is the duplicate.
  //
  // Every fixture value below is spelled FAKE / .invalid, `code_verifier` most of all: it
  // is stored in plaintext by design (0004's header), and §15's rule is that it must never
  // appear in a log line — which includes this file's own test output.
  {
    title: "§5/§7 · upstream_oauth_state.state PRIMARY KEY refuses a second row for one nonce — a `state` that can repeat is not a nonce · twin stores a distinct state",
    table: "upstream_oauth_state",
    kind: "unique",
    column: "state",
    rejected: { state: "oas_FAKE0000_dup" },
    accepted: { state: "oas_FAKE0000_other" },
  },
  {
    title: "§5 · upstream_oauth_state.owner_id NOT NULL refuses null · twin stores under the seeded owner",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "owner_id",
    rejected: { owner_id: null },
    accepted: {},
  },
  {
    title: "§5 · upstream_oauth_state.owner_id FK refuses an absent user · twin stores under the seeded owner",
    table: "upstream_oauth_state",
    kind: "foreign_key",
    column: "owner_id",
    rejected: { owner_id: "usr_FAKE0000_absent" },
    accepted: {},
  },
  {
    title: "§5 · upstream_oauth_state.service_id NOT NULL refuses null · twin stores the seeded service",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "service_id",
    rejected: { service_id: null },
    accepted: {},
  },
  {
    title: "§5 · upstream_oauth_state.service_id FK refuses an absent service · twin stores the seeded service",
    table: "upstream_oauth_state",
    kind: "foreign_key",
    column: "service_id",
    rejected: { service_id: "svc_FAKE0000_absent" },
    accepted: {},
  },
  // "identity.OwnerSession.sessionId — only the browser session that began the flow may
  // complete it (§7)". No FK by design, so the twin doubles as the evidence that a session
  // id no `session` row carries still STORES: the binding is checked at the callback.
  {
    title: "§5/§7 · upstream_oauth_state.session_id NOT NULL refuses null · twin stores a session id no row carries — no FK, so the binding is the callback's check",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "session_id",
    rejected: { session_id: null },
    accepted: { session_id: "ses_FAKE0000_gone" },
  },
  // "RFC 9207's `iss` is compared against THIS, never against the callback's own claim."
  {
    title: "§5/§7 · upstream_oauth_state.issuer NOT NULL refuses null — the `iss` check has nothing to compare against without it · twin stores an issuer",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "issuer",
    rejected: { issuer: null },
    accepted: { issuer: "https://as.pmcp-test.invalid" },
  },
  // "the mix-up defense: the code is redeemed here alone" — one shared callback URL across
  // every authorization server, so an absent endpoint would mean redeeming wherever the
  // callback's own response pointed.
  {
    title: "§5/§7 · upstream_oauth_state.token_endpoint NOT NULL refuses null — the mix-up defense is this column · twin stores an endpoint",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "token_endpoint",
    rejected: { token_endpoint: null },
    accepted: { token_endpoint: "https://as.pmcp-test.invalid/token" },
  },
  {
    title: "§5 · upstream_oauth_state.client_id NOT NULL refuses null · twin stores the CIMD url",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "client_id",
    rejected: { client_id: null },
    accepted: { client_id: "https://hub.pmcp-test.invalid/oauth/client.json" },
  },
  {
    title: "§5/§7 · upstream_oauth_state.code_verifier NOT NULL refuses null — PKCE with no verifier is no PKCE · twin stores an obviously fake verifier",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "code_verifier",
    rejected: { code_verifier: null },
    accepted: { code_verifier: "FAKE0000-not-a-real-pkce-verifier" },
  },
  {
    title: "§5 · upstream_oauth_state.redirect_uri NOT NULL refuses null — it is replayed at redemption · twin stores the callback url",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "redirect_uri",
    rejected: { redirect_uri: null },
    accepted: { redirect_uri: "https://hub.pmcp-test.invalid/oauth/upstream/callback" },
  },
  // 0/1: whether the AS metadata declared authorization_response_iss_parameter_supported.
  // §7's `iss` check is CONDITIONAL on it, so the twin stores the 0 that turns it off —
  // the value a NOT NULL exists to keep from being guessed at from a null.
  {
    title: "§5/§7 · upstream_oauth_state.issuer_advertised NOT NULL refuses null — the `iss` check is conditional on it, so an absent condition would be re-derived from the response · twin stores 0",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "issuer_advertised",
    rejected: { issuer_advertised: null },
    accepted: { issuer_advertised: 0 },
  },
  {
    title: "§5 · upstream_oauth_state.created_at NOT NULL refuses null · twin stores a timestamp",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "created_at",
    rejected: { created_at: null },
    accepted: { created_at: 1_700_000_000_000 },
  },
  // "created_at + limits.OAUTH_STATE_TTL_MS", and enforced at READ time by handleCallback —
  // never by this schema and never by the sweep. The twin is the anchor plus the TTL BY
  // NAME, for approval.expires_at's reason: a ten-minute window written at second scale
  // reads as a 600 ms one to the next agent.
  {
    title: "§5/§7 · upstream_oauth_state.expires_at NOT NULL refuses null — the callback's read-time expiry check has nothing to interpret without it · twin stores a timestamp",
    table: "upstream_oauth_state",
    kind: "not_null",
    column: "expires_at",
    rejected: { expires_at: null },
    accepted: { expires_at: 1_700_000_000_000 + OAUTH_STATE_TTL_MS },
  },
];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const cascadeRows: readonly CascadeRow[] = [
  // §5: four columns REFERENCE user(id) ON DELETE CASCADE — service.owner_id,
  // service_account.owner_id, approval.owner_id, push_subscription.user_id — and grant_
  // rides along behind its two parents. What is NOT reached is the point: token.ref_id
  // carries no FK (§5's parenthetical) and audit.owner_id carries none either (§15: the
  // record of record is pruned by retention, never by a cascade), so a delete that emptied
  // those tables would be a schema someone quietly changed.
  {
    title: "§5 · deleting the user cascades service, service_account, grant_, approval, push_subscription and upstream_oauth_state · token and audit rows survive",
    parent: "user",
    cascades: ["service", "service_account", "grant_", "approval", "push_subscription", "upstream_oauth_state"],
    survives: ["token", "audit"],
  },
  // §5/§8: service_delete's D1 half is exactly these two child tables. Deleting the
  // service's token rows is admin's cascade (deleteTokensFor), which is where it gets
  // audited — an FK added to token later would move that removal out of audited code, and
  // this row is what notices.
  // 0004's two FKs both cascade, so a deleted service takes its half-finished connect flows
  // with it: a `state` row outliving its service would resolve a callback against a binding
  // whose service no longer exists.
  {
    title: "§5/§8 · deleting a service cascades its grant_, approval and upstream_oauth_state rows · its token rows survive — ref_id has no FK, so deletion stays admin's cascade",
    parent: "service",
    cascades: ["grant_", "approval", "upstream_oauth_state"],
    survives: ["token", "audit", "service_account", "push_subscription"],
  },
  // The other side of the same FK pair: upstream_oauth_state references `user` and
  // `service` and NOT `service_account`, so an account delete leaves an owner's in-flight
  // connect flow alone.
  {
    title: "§5/§8 · deleting a service_account cascades its grant_ and approval rows · its token and upstream_oauth_state rows survive, and the service it was granted on is untouched",
    parent: "service_account",
    cascades: ["grant_", "approval"],
    survives: ["token", "audit", "service", "push_subscription", "upstream_oauth_state"],
  },
];

// ————————————————————————————————————————————————————————————————————————
// Raw D1 access. seed.ts (FINDINGS 6) deliberately does not export a valid-column-row
// builder — a raw write bypassing every production seam belongs beside the table it
// describes, which is HERE, not in the domain-vocabulary harness. Nothing below goes
// through Registry/identity/admin: this file looks at the database directly, and every
// other worker suite is still free to assume those modules are the only writers in
// production.

/** The slice of the real D1 API this file drives directly. */
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
};
type D1DatabaseLike = { prepare(query: string): D1PreparedStatement };

function db(): D1DatabaseLike {
  return env.DB as D1DatabaseLike;
}

/** `"user"` is better-auth's quoted identifier; every table of ours is bare snake_case. */
function tableIdent(table: string): string {
  return table === "user" ? '"user"' : table;
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${tableIdent(table)} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  await db()
    .prepare(sql)
    .bind(...columns.map((c) => row[c]))
    .run();
}

/** The one namespace every constraint/cascade case seeds fresh — never shared across
 * `it()`s, so a test poking `user`/`service` rows can never bleed into a sibling case
 * regardless of how fine-grained the pool's isolation turns out to be. */
type FixtureCtx = { ownerId: string; serviceId: string; accountId: string };

async function seedFixture(): Promise<FixtureCtx> {
  const ownerId = `usr_FAKE0000_${crypto.randomUUID()}`;
  const serviceId = `svc_FAKE0000_${crypto.randomUUID()}`;
  const accountId = `sa_FAKE0000_${crypto.randomUUID()}`;
  const now = Date.now();
  // better-auth's own table (0001) — camelCase columns, no password row (§12's provisioning
  // seam is a sibling module's, unimplemented as of this file; only the FK target matters here).
  await insertRow("user", {
    id: ownerId,
    name: "Fixture Owner",
    email: `${ownerId}@fixture.invalid`,
    emailVerified: 0,
    createdAt: now,
    updatedAt: now,
  });
  await insertRow("service", {
    id: serviceId,
    owner_id: ownerId,
    slug: `svc-${crypto.randomUUID()}`,
    name: "Fixture Service",
    kind: "tunnel",
    forward_identity: 0,
    roles_json: "{}",
    redact_json: "{}",
    redact_results_json: "{}",
    log_bodies: 1,
    created_at: now,
  });
  await insertRow("service_account", {
    id: accountId,
    owner_id: ownerId,
    slug: `sa-${crypto.randomUUID()}`,
    name: "Fixture Account",
    created_at: now,
  });
  return { ownerId, serviceId, accountId };
}

/**
 * The valid column set for one table, in the vocabulary the CHECKed columns share with
 * ServiceKind/ApprovalStatus. A fresh id (and, where uniqueness might otherwise be the
 * thing that bites, a fresh secondary column) is minted on EVERY call — the exact
 * discipline the oracle rows' header calls for, so a `unique` row's rejected pair never
 * collides on the wrong column.
 */
function baseRow(table: SchemaTable, ctx: FixtureCtx): Record<string, unknown> {
  const now = 1_700_000_000_000;
  switch (table) {
    case "service":
      return {
        id: `svc_FAKE0000_${crypto.randomUUID()}`,
        owner_id: ctx.ownerId,
        slug: `svc-${crypto.randomUUID()}`,
        name: "Service",
        kind: "tunnel" satisfies ServiceKind,
        forward_identity: 0,
        roles_json: "{}",
        redact_json: "{}",
        redact_results_json: "{}",
        log_bodies: 1,
        created_at: now,
      };
    case "service_account":
      return {
        id: `sa_FAKE0000_${crypto.randomUUID()}`,
        owner_id: ctx.ownerId,
        slug: `sa-${crypto.randomUUID()}`,
        name: "Account",
        created_at: now,
      };
    case "grant_":
      return {
        service_account_id: ctx.accountId,
        service_id: ctx.serviceId,
        role: `role-${crypto.randomUUID()}`,
        mode: "allow",
      };
    case "approval":
      return {
        id: `apr_FAKE0000_${crypto.randomUUID()}`,
        owner_id: ctx.ownerId,
        service_account_id: ctx.accountId,
        service_id: ctx.serviceId,
        tool: "get_news",
        args_hash: `sha256_FAKE0000_${crypto.randomUUID()}`,
        args_json: "{}",
        status: "pending" satisfies ApprovalStatus,
        created_at: now,
        expires_at: now + APPROVAL_WINDOW_MS,
      };
    case "token":
      return {
        id: `tok_FAKE0000_${crypto.randomUUID()}`,
        kind: "service",
        ref_id: ctx.serviceId,
        hash: `sha256_FAKE0000_${crypto.randomUUID()}`,
        prefix: "pmcp_svc_FAKE",
        created_at: now,
      };
    case "audit":
      return {
        ts: now,
        owner_id: ctx.ownerId,
        principal: "bootstrap",
        event: "tools/call",
        outcome: "ok",
      };
    case "push_subscription":
      return {
        id: `psh_FAKE0000_${crypto.randomUUID()}`,
        user_id: ctx.ownerId,
        endpoint: `https://push.example.invalid/${crypto.randomUUID()}`,
        keys_json: '{"p256dh":"FAKE0000","auth":"FAKE0000"}',
        created_at: now,
      };
    case "upstream_oauth_state":
      return {
        // Fresh per call, like every other primary key here: the `unique` row's duplicate
        // must be the column the row NAMES, never the id that happened to collide.
        state: `oas_FAKE0000_${crypto.randomUUID()}`,
        owner_id: ctx.ownerId,
        service_id: ctx.serviceId,
        session_id: `ses_FAKE0000_${crypto.randomUUID()}`,
        issuer: "https://as.pmcp-test.invalid",
        token_endpoint: "https://as.pmcp-test.invalid/token",
        client_id: "https://hub.pmcp-test.invalid/oauth/client.json",
        // Plaintext by design (0004's header) and therefore spelled FAKE with force: this
        // value is printed by any failing case in this file.
        code_verifier: "FAKE0000-not-a-real-pkce-verifier",
        redirect_uri: "https://hub.pmcp-test.invalid/oauth/upstream/callback",
        issuer_advertised: 1,
        created_at: now,
        expires_at: now + OAUTH_STATE_TTL_MS,
      };
  }
}

/** `baseRow` with the row's own column overrides layered on — exactly the fixture shape
 * every `SchemaConstraintRow.rejected` / `.accepted` is written against. */
function buildRow(
  table: SchemaTable,
  ctx: FixtureCtx,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...baseRow(table, ctx), ...overrides };
}

/** How one table's rows are scoped back to the fixture that seeded them, for the cascade
 * table's before/after row counts. */
function ctxFilter(table: SchemaTable, ctx: FixtureCtx): { sql: string; params: unknown[] } {
  switch (table) {
    case "service":
      return { sql: "id = ?", params: [ctx.serviceId] };
    case "service_account":
      return { sql: "id = ?", params: [ctx.accountId] };
    case "grant_":
    case "approval":
      return { sql: "service_account_id = ? AND service_id = ?", params: [ctx.accountId, ctx.serviceId] };
    // Both of its parents at once: a cascade case must see the row go whichever FK carried
    // it away, and scoping by one parent alone would read the other's delete as "survived".
    case "upstream_oauth_state":
      return { sql: "owner_id = ? AND service_id = ?", params: [ctx.ownerId, ctx.serviceId] };
    case "push_subscription":
      return { sql: "user_id = ?", params: [ctx.ownerId] };
    case "token":
      return { sql: "ref_id = ? OR ref_id = ?", params: [ctx.serviceId, ctx.accountId] };
    case "audit":
      return { sql: "owner_id = ?", params: [ctx.ownerId] };
  }
}

async function countFor(table: SchemaTable, ctx: FixtureCtx): Promise<number> {
  const { sql, params } = ctxFilter(table, ctx);
  const row = await db()
    .prepare(`SELECT COUNT(*) AS c FROM ${tableIdent(table)} WHERE ${sql}`)
    .bind(...params)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Every cascade-adjacent table the fixture doesn't already carry a row in — one row
 * apiece, so a cascade/`survives` row can be checked "empty" vs. "still holds its own". */
async function seedCascadeChildren(ctx: FixtureCtx): Promise<void> {
  await insertRow("grant_", buildRow("grant_", ctx, {}));
  await insertRow("approval", buildRow("approval", ctx, {}));
  await insertRow("push_subscription", buildRow("push_subscription", ctx, {}));
  await insertRow("upstream_oauth_state", buildRow("upstream_oauth_state", ctx, {}));
  await insertRow("token", buildRow("token", ctx, { kind: "service", ref_id: ctx.serviceId }));
  await insertRow("token", buildRow("token", ctx, { kind: "service_account", ref_id: ctx.accountId }));
  await insertRow("audit", buildRow("audit", ctx, {}));
}

async function deleteParent(parent: CascadeRow["parent"], ctx: FixtureCtx): Promise<void> {
  const id = parent === "user" ? ctx.ownerId : parent === "service" ? ctx.serviceId : ctx.accountId;
  await db().prepare(`DELETE FROM ${tableIdent(parent)} WHERE id = ?`).bind(id).run();
}

/**
 * Registers one case per constraint row: the rejected write must fail at the database,
 * and its twin must store. A row whose rejection fails for the wrong reason (a NOT NULL
 * firing where a CHECK was meant) is a mis-transcribed row, not a schema bug — the
 * failure names the row, and §8's `test:` commit is the fix.
 */
export function runSchemaConstraintTable(rows: readonly SchemaConstraintRow[]): void {
  // deps: seedFixture · buildRow · insertRow (this file's own raw-write seam, §above)
  for (const row of rows) {
    it(row.title, async () => {
      const ctx = await seedFixture();
      if (row.kind === "unique") {
        // The rejected tuple is written TWICE — only the second write is the refusal.
        await insertRow(row.table, buildRow(row.table, ctx, row.rejected));
        await expect(insertRow(row.table, buildRow(row.table, ctx, row.rejected))).rejects.toThrow();
      } else {
        await expect(insertRow(row.table, buildRow(row.table, ctx, row.rejected))).rejects.toThrow();
      }
      // The allow-twin (§9 rule 2): differs in exactly the offending column, must store.
      await insertRow(row.table, buildRow(row.table, ctx, row.accepted));
    });
  }
}

/**
 * Registers one case per cascade row: after the parent delete, every `cascades` table is
 * empty of the seeded namespace's rows and every `survives` table still holds its own.
 */
export function runCascadeTable(rows: readonly CascadeRow[]): void {
  // deps: seedFixture · seedCascadeChildren · countFor · deleteParent
  for (const row of rows) {
    it(row.title, async () => {
      const ctx = await seedFixture();
      await seedCascadeChildren(ctx);
      for (const table of [...row.cascades, ...row.survives]) {
        expect(await countFor(table, ctx)).toBeGreaterThan(0);
      }
      await deleteParent(row.parent, ctx);
      for (const table of row.cascades) {
        expect(await countFor(table, ctx)).toBe(0);
      }
      for (const table of row.survives) {
        expect(await countFor(table, ctx)).toBeGreaterThan(0);
      }
    });
  }
}

// ————————————————————————————————————————————————————————————————————————
// Exhaustiveness: derive every CHECK/UNIQUE/NOT NULL/FK the APPLIED schema declares
// straight from the migration SQL (env.TEST_MIGRATIONS — the same queries d1.ts's
// applyD1Migrations runs), so a constraint added to the SQL without a row here fails
// this case instead of going unpinned. Deliberately not a parsed-once general SQL
// parser: it knows exactly the shapes 0002/0003 use (inline CHECK/UNIQUE/REFERENCES,
// table-level UNIQUE/PRIMARY KEY tuples, one partial CREATE UNIQUE INDEX) and nothing
// more — a schema shape outside that vocabulary is not this repo's, so a regex tuned
// wider than that would be speculative.

type ConstraintIdentity = { table: SchemaTable; kind: SchemaConstraintRow["kind"]; column: string };

const SCHEMA_TABLES = new Set<string>([
  "service",
  "service_account",
  "grant_",
  "approval",
  "token",
  "audit",
  "push_subscription",
  "upstream_oauth_state",
]);

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comma-split a CREATE TABLE body at paren depth 0 only, so `CHECK (a IN (b, c))` and
 * `UNIQUE (a, b)` stay one definition instead of being cut at their own inner commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseTableDef(table: SchemaTable, def: string): ConstraintIdentity[] {
  const uniqueTuple = /^UNIQUE\s*\(([^)]*)\)/i.exec(def);
  if (uniqueTuple) return [{ table, kind: "unique", column: `(${uniqueTuple[1].trim()})` }];
  const pkTuple = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(def);
  if (pkTuple) return [{ table, kind: "unique", column: `(${pkTuple[1].trim()})` }];

  const name = def.split(/\s+/)[0];
  if (!name) return [];
  const out: ConstraintIdentity[] = [];
  if (/\bNOT\s+NULL\b/i.test(def)) out.push({ table, kind: "not_null", column: name });
  if (/\bCHECK\s*\(/i.test(def)) out.push({ table, kind: "check", column: name });
  if (/\bREFERENCES\b/i.test(def)) out.push({ table, kind: "foreign_key", column: name });
  if (/\bPRIMARY\s+KEY\b/i.test(def)) out.push({ table, kind: "unique", column: name });
  if (/\bUNIQUE\b/i.test(def)) out.push({ table, kind: "unique", column: name });
  return out;
}

function deriveSchemaConstraints(migrations: readonly { queries: readonly string[] }[]): ConstraintIdentity[] {
  const identities: ConstraintIdentity[] = [];
  for (const migration of migrations) {
    for (const rawQuery of migration.queries) {
      const query = stripSqlComments(rawQuery);
      const createTable = /CREATE\s+TABLE\s+"?(\w+)"?\s*\(/i.exec(query);
      if (createTable) {
        const table = createTable[1];
        if (!SCHEMA_TABLES.has(table)) continue;
        const body = query.slice(query.indexOf("(") + 1, query.lastIndexOf(")"));
        for (const def of splitTopLevel(body)) identities.push(...parseTableDef(table as SchemaTable, def));
        continue;
      }
      const createIndex = /CREATE\s+(UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(\w+)\s*\(([^)]*)\)(?:\s+WHERE\s+([\s\S]*?))?\s*;?\s*$/i.exec(
        query.trim(),
      );
      if (createIndex && createIndex[1] && SCHEMA_TABLES.has(createIndex[2])) {
        const cols = createIndex[3].trim();
        const where = createIndex[4]?.trim();
        const column = where ? `(${cols}) WHERE ${where}` : `(${cols})`;
        identities.push({ table: createIndex[2] as SchemaTable, kind: "unique", column });
      }
    }
  }
  return identities;
}

describe("§5 · constraints bite", () => {
  runSchemaConstraintTable(schemaConstraintRows);

  it(
    "\"§5 · the table is exhaustive: every CHECK, UNIQUE and NOT NULL in the applied schema appears in schemaConstraintRows\" — coverage derived from the migration SQL, so a constraint added without a row fails here instead of going unpinned",
    () => {
      const known = new Set(schemaConstraintRows.map((r) => `${r.table}::${r.kind}::${r.column}`));
      const missing = deriveSchemaConstraints(env.TEST_MIGRATIONS)
        .map((c) => `${c.table}::${c.kind}::${c.column}`)
        .filter((key) => !known.has(key));
      expect(missing).toEqual([]);
    },
  );
});

describe("§5 · cascades", () => {
  runCascadeTable(cascadeRows);

  it(
    "\"§5 · foreign keys are enforced, not decorative: a child row naming an absent parent is refused\" (the pragma-off failure mode looks identical in the DDL)",
    async () => {
      const ctx = await seedFixture();
      await expect(
        insertRow("push_subscription", buildRow("push_subscription", ctx, { user_id: "usr_FAKE0000_absent" })),
      ).rejects.toThrow();
    },
  );

  it(
    "§5 · token rows survive every parent delete — ref_id has no FK, so deletion stays admin's cascade where it is audited",
    async () => {
      for (const parent of ["user", "service", "service_account"] as const) {
        const ctx = await seedFixture();
        await insertRow("token", buildRow("token", ctx, { kind: "service", ref_id: ctx.serviceId }));
        await insertRow("token", buildRow("token", ctx, { kind: "service_account", ref_id: ctx.accountId }));
        await deleteParent(parent, ctx);
        expect(await countFor("token", ctx)).toBe(2);
      }
    },
  );
});

describe("§7 step 2 · the pending partial unique index", () => {
  it(
    "§7 step 2 · two identical pending bindings: the second insert is refused by the constraint, so the losing first call re-reads the winner's row",
    async () => {
      const ctx = await seedFixture();
      const tool = "gate_tool";
      const argsHash = "sha256_FAKE0000_race";
      const winnerId = `apr_FAKE0000_${crypto.randomUUID()}`;
      await insertRow("approval", buildRow("approval", ctx, { id: winnerId, tool, args_hash: argsHash, status: "pending" }));
      await expect(
        insertRow("approval", buildRow("approval", ctx, { tool, args_hash: argsHash, status: "pending" })),
      ).rejects.toThrow();
      const winner = await db()
        .prepare(
          "SELECT id FROM approval WHERE service_account_id = ? AND service_id = ? AND tool = ? AND args_hash = ? AND status = 'pending'",
        )
        .bind(ctx.accountId, ctx.serviceId, tool, argsHash)
        .all<{ id: string }>();
      expect(winner.results).toEqual([{ id: winnerId }]);
    },
  );

  it(
    "§7 step 2 · the index is partial: the same binding inserts freely once the first row leaves `pending` — total over the ApprovalStatus vocabulary",
    async () => {
      const nonPending: ApprovalStatus[] = ["approved", "rejected", "expired", "used"];
      for (const status of nonPending) {
        const ctx = await seedFixture();
        const tool = "gate_tool";
        const argsHash = `sha256_FAKE0000_${status}`;
        await insertRow("approval", buildRow("approval", ctx, { tool, args_hash: argsHash, status }));
        await insertRow("approval", buildRow("approval", ctx, { tool, args_hash: argsHash, status: "pending" }));
      }
    },
  );

  it(
    "§7 step 2 · same (account, service, tool) with a different args_hash opens a second pending row — the binding, not the tool, is what dedups",
    async () => {
      const ctx = await seedFixture();
      const tool = "gate_tool";
      await insertRow("approval", buildRow("approval", ctx, { tool, args_hash: "sha256_FAKE0000_a", status: "pending" }));
      await insertRow("approval", buildRow("approval", ctx, { tool, args_hash: "sha256_FAKE0000_b", status: "pending" }));
      const count = await db()
        .prepare(
          "SELECT COUNT(*) AS c FROM approval WHERE service_account_id = ? AND service_id = ? AND tool = ? AND status = 'pending'",
        )
        .bind(ctx.accountId, ctx.serviceId, tool)
        .first<{ c: number }>();
      expect(count?.c).toBe(2);
    },
  );
});

describe("§10 · applying the set", () => {
  /** Wipes every table (ours and better-auth's, plus the plugin's own `d1_migrations`
   * bookkeeping) so the next applyD1Migrations call replays from true scratch — the
   * "second binding vs. scratch database vs. setup opt-out" question the header leaves
   * open, answered as: neither. Safe only under per-TEST storage isolation (the
   * plugin's own README: "implements isolated per-test storage"), which is also the
   * only thing that lets this describe block share a file with every other case here. */
  async function dropEverything(): Promise<void> {
    const tables = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>();
    // `_cf_%` is D1's own internal bookkeeping — not authorized to drop it, and not this
    // repo's schema anyway. Reverse CREATION order so a child (later-created, FK-bearing)
    // table drops before the parent it references: SQLite's DROP TABLE re-validates FK
    // metadata and errors "no such table" when the referenced parent is already gone.
    const names = tables.results.map((t) => t.name).filter((name) => !name.startsWith("_cf_"));
    for (const name of names.reverse()) {
      await db().prepare(`DROP TABLE IF EXISTS "${name}"`).run();
    }
  }

  it("§10 · every migration applies to an empty database in order (the fresh-install path)", async () => {
    await dropEverything();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    // Every migration landed, in order: 0001's `user`, 0002's `service`, 0003's `approval`,
    // 0004's `upstream_oauth_state` — the last one named explicitly, because it is the only
    // table whose absence the OTHER inserts here would not notice.
    const ctx = await seedFixture();
    await insertRow("approval", buildRow("approval", ctx, {}));
    await insertRow("upstream_oauth_state", buildRow("upstream_oauth_state", ctx, {}));
  });

  it("§10 · re-application is a no-op: a second run applies nothing and leaves the schema identical", async () => {
    const before = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const after = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    expect(after.results).toEqual(before.results);
  });

  it(
    "§10 · forward migration over live data: 1..N−1 applied, rows inserted, N applied — N does not fail on existing rows and the inserted rows survive it",
    async () => {
      await dropEverything();
      const migrations = env.TEST_MIGRATIONS;
      await applyD1Migrations(env.DB, migrations.slice(0, migrations.length - 1)); // 1..N-1: auth + hub + approval
      const ctx = await seedFixture(); // rows written under N-1
      await applyD1Migrations(env.DB, migrations); // N: upstream_oauth_state, on top of live data
      expect(await countFor("service", ctx)).toBe(1);
      expect(await countFor("service_account", ctx)).toBe(1);
      // N's own table — 0004's today, and named rather than derived, so a migration 0005
      // makes this line visibly stale instead of silently testing N−1 (which is what the
      // `approval` insert it replaces had quietly become).
      await insertRow("upstream_oauth_state", buildRow("upstream_oauth_state", ctx, {}));
    },
  );
});
