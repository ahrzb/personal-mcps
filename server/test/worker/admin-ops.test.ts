// admin-ops.test.ts — the ops table pinned AS a table (§8, §15).
//
// What this suite pins: the reservation of the `pmcp` slug as a property of the ops
// TABLE rather than of any op — swept over `Object.keys(ops)`, never over a hand-kept
// list, so an op added tomorrow cannot forget the reservation (§8: "one error, every op,
// never per-tool"); the audit discipline of each op (§8: every mutating op writes exactly
// one `admin.<tool>` row, reads write none, and the side events some ops write beside
// their own); the D1-side atomicity of the deleting cascades (§15: both rows gone or
// neither); parity direction A (§8's parity invariant) — every op renders as a `pmcp`
// tool from its ONE schema, total in both directions, so the MCP front and the web form
// can never drift apart; and, past the table, the one op whose ANSWER turns on values the
// table cannot express — `audit_query`'s `principal` / `since` / `until`, each proven to
// narrow, because a sample that passes no filter cannot tell a clause that is applied
// from one that is silently dropped.
//
// Project: `worker` — real D1, every sibling module real, no sockets. The ops are D1
// writes, so they belong where D1 is real. The half of each deleting cascade that closes
// a live socket (4001 before the DO wipe) and the §15 ordering pin ("at the moment 4001
// is seen, D1 already has no rows") need a frame on the wire and are pinned by
// tunnel/lifecycle.test.ts instead; this file pins only the D1 half — that the batch is
// one batch. Per-file storage isolation is automatic and load-bearing here: every cascade
// case begins from the seeded fixture alone, so "row gone" is unambiguous.
//
// Deliberately NOT pinned here: the gateway pipeline these ops ride
// (admin-pipeline.test.ts), the 401/404 matrix in front of them (auth-matrix.test.ts),
// per-op input validation owned by the modules underneath (registry.test.ts for slug and
// grant rules, upstream-credentials.test.ts for the headers-vs-oauth exclusivity), and
// the global sentinel sweep proving no column ever holds token material
// (hygiene.test.ts). This file pins that a ledger row exists and says what it should —
// not the hygiene law over every column.
//
// deps: harness/seed (namespace fixture: owner, one tunneled + one proxied service, one
//   service account, one token per kind) · ../../src/admin (ops, adminBackend) ·
//   ../../src/registry · ../../src/identity · ../../src/audit · ../../src/approvals (the
//   gate the one `fixture:approval.pending` sample is opened through — the seed harness
//   has no approval seam, by design) · applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminBackend, ops } from "../../src/admin";
import { Approvals } from "../../src/approvals";
import { query, record } from "../../src/audit";
import type { AuditEntry, AuditRow } from "../../src/audit";
import type { BackendCtx, Tool } from "../../src/gateway";
import { PMCP_SLUG, writeOnlyPaths } from "../../src/registry";
import type { Service } from "../../src/registry";
import { seedNamespace } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * An ops-table key. `keyof typeof ops` is `string` today because `ops` is typed
 * `Record<string, AdminOp>` — the alias is documentation, not a constraint. The real
 * guard against a forgotten op is the runner's totality assertion (rows ≡
 * `Object.keys(ops)`), which no type could give us.
 */
export type OpName = keyof typeof ops;

/**
 * One row of the ops classification table — the columns exist so the sweeps below can
 * drive themselves over the REAL `ops` object instead of over a list someone has to
 * remember to extend.
 *
 * `sample` is what makes the refusal and its allow-twin one row rather than two (§9
 * rule 2): the sweep calls the op once with `sample` unchanged (must succeed) and once
 * with its slug field replaced by `pmcp` — which for a `"service"` slug must be the one
 * uniform reserved-slug refusal, and for an `"account"` slug must be anything but it
 * (see `slugArg`). No row lists a refusal without its twin, because the twin is
 * generated from the same cell.
 */
export type AdminOpRow = {
  /** The ops key. The table is total over `Object.keys(ops)` — see runAdminOpTable. */
  op: OpName;
  /**
   * Which reserved-slug sweep applies: `"service"` ops take a service slug and must
   * refuse `pmcp` with the one uniform error; `"account"` ops take an account slug (no
   * reservation, but the column says so explicitly rather than by omission); `"none"`
   * ops take neither.
   *
   * What the `"account"` sweep asserts, stated because it is NOT "must succeed": §8
   * reserves `pmcp` for service slugs and says nothing about account slugs, so the
   * property is that the op's answer is never the RESERVED-SLUG refusal — a create
   * succeeds, and a delete of an account nobody has created fails as not-found, which is
   * a different error for a different reason. Demanding success would make the sweep
   * unsatisfiable for the deleting ops, which is the opposite of what the column means.
   */
  slugArg: "service" | "account" | "none";
  /** Decides the audit expectation: exactly one `admin.<op>` row, or none at all (§8). */
  writes: "mutating" | "read";
  /**
   * Audit events this op writes BESIDE its own `admin.<op>` row — the writes that belong
   * to a module underneath (e.g. `upstream.auth_mode_changed` on an auth flip,
   * `upstream.disconnected`, approvals' own lifecycle row). Empty for most ops.
   */
  sideEvents: readonly AuditEntry["event"][];
  /**
   * The row families this op removes in its ONE atomic D1 batch (§15). Empty for
   * non-deleting ops; the sweep asserts all-or-nothing over exactly these tables.
   */
  cascade: readonly ("service" | "service_account" | "grant_" | "token")[];
  /** Parity direction A: whether the op declares an outputSchema (§8 — token_issue alone). */
  declaresOutputSchema: boolean;
  /**
   * The smallest input that SUCCEEDS against the seeded fixture. Both twins come from
   * this one cell (see the type comment). Typed loosely on purpose: at implementation
   * each op's zod schema is the input's only source of truth, and a test-side mirror of
   * that shape would be a second definition of it.
   */
  sample: Record<string, unknown>;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1) — agents write the runner, never the oracle. Empty here is the correct
 * committed state, and `runAdminOpTable`'s totality assertion means an empty table
 * cannot masquerade as a passing sweep.
 */
export const ADMIN_OP_ROWS: readonly AdminOpRow[] = [
  // One row per key of `ops`, in the ops table's own order — the runner's totality check
  // (rows ≡ Object.keys(ops)) reads this as the coverage oracle, so an op added tomorrow
  // fails the sweep here instead of quietly skipping the reservation (§8: "one error, every
  // op, never per-tool").
  //
  // The fixture every `sample` is written against, named once: services `news` (tunneled,
  // holding a `pmcp_svc_` token), `notion` (proxied, `auth: headers`) and `linear`
  // (proxied, `auth: oauth`); one account `claude` holding a `pmcp_sa_` token and grants on
  // `news`. Two proxied services is not padding — it is what these samples PROVE the
  // fixture needs: §8 gives each auth mode exactly one credential path, so
  // `service_set_upstream_auth` succeeds only on a `headers` service and
  // `service_disconnect` only on an `oauth` one, and no single proxied row can be both.
  //
  // Two `sample` values are row IDs rather than slugs, which no static cell can hold: they
  // are written as `fixture:<handle>` and the runner resolves them against the seeded
  // namespace before calling the op (`fixture:token.sa` is the account's minted token id,
  // `fixture:approval.pending` a pending approval opened through the gate — the seed
  // harness has no approval seam, by design). Nothing else in the table is indirect.
  //
  // `cascade` lists `grant_` on BOTH deleting ops, though the locked case titles name it
  // only on `account_delete`: grant rows ride the FK from either parent (§5), so the batch
  // removes them either way and the sweep should say so. Asserting all-or-nothing over a
  // family the op does not touch would be the error; this is the opposite.

  // §8: "`service_list` … includes it flagged `builtin: true`" — the one read that must
  // answer for a service with no row. Reads write no `admin.*` row (§15 records mutations).
  {
    op: "service_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8: "`{ slug }` → one service, same row shape as service_list. The reserved `pmcp` slug
  // is rejected like everywhere else (the builtin surfaces only through service_list —
  // uniformity is worth more than the corner case)."
  {
    op: "service_get",
    slugArg: "service",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §8: create takes `kind` (immutable thereafter) plus the per-kind fields; the slug is
  // `[a-z0-9-]`, unique per owner, "never `pmcp`". The smallest succeeding input is the
  // slug and the kind — name, description, redact and log_bodies all default (§15: by kind).
  {
    op: "service_create",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "scratch", kind: "tunnel" },
  },
  // §8: "Changing `auth` in either direction is accepted but destructive: any stored
  // `upstream_auth_json` is wiped (audit row `upstream.auth_mode_changed`)". The sample
  // performs the flip on purpose — the side event is a property of the op only when the op
  // actually changes the mode, so a sample that updated a description would state nothing.
  {
    op: "service_update",
    slugArg: "service",
    writes: "mutating",
    sideEvents: ["upstream.auth_mode_changed"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "notion", auth: "oauth" },
  },
  // §15/§8: "ONE atomic D1 batch removes the service row (grants cascade by FK) and its
  // token rows FIRST; only then is the tunnel DO told to sever". This file owns the D1 half
  // (both gone or neither); the 4001-before-the-wipe ordering is tunnel/lifecycle.test.ts's.
  {
    op: "service_delete",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: ["service", "grant_", "token"],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §8: "proxied only: stores the headers (e.g. a bearer token) the hub sends upstream …
  // rejected on `auth: oauth` services". The header VALUE is deliberately, visibly fake: no
  // credential-shaped string belongs in a row that gets printed in test output.
  {
    op: "service_set_upstream_auth",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "notion", headers: { "X-Api-Key": "FAKE0000-not-a-real-upstream-key" } },
  },
  // §8: "`auth: oauth` proxied services only: wipes the stored token bundle (audit row
  // `upstream.disconnected`)". The fixture's `linear` is oauth-mode and NOT connected — a
  // connected one is unreachable from the seed harness, which may only reach an envelope
  // through `upstream.setHeaders` or the real connect flow (upstream-credentials.test.ts's).
  // The sample therefore also asserts the postcondition reading: disconnecting an
  // already-disconnected service succeeds, the way unarchiving an unarchived one does —
  // and, like `service_unarchive` two rows down, still writes its ledger rows, because in
  // this table an op that RAN records that it ran. upstream.disconnect's "Idempotent:
  // disconnecting an already-empty service is a no-op" is about the wipe (there is nothing
  // to wipe), not about the ledger: the same header's first sentence writes
  // `upstream.disconnected` unconditionally. If the owner means the lifecycle row to
  // follow the wipe rather than the call, that is a `spec:` change and it takes the locked
  // todo "service_disconnect writes `upstream.disconnected` beside its own row" with it.
  {
    op: "service_disconnect",
    slugArg: "service",
    writes: "mutating",
    sideEvents: ["upstream.disconnected"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "linear" },
  },
  // §6/§8: reversible parking — the flag lands in D1, then any live socket is severed
  // (4002, tunnel/lifecycle.test.ts's half). Roles, grants, tokens and catalog are retained.
  {
    op: "service_archive",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §6: "`service_unarchive` restores everything." Registry pins unarchiving an unarchived
  // row as a no-op, so the fixture needs no pre-archived service for this sample to succeed
  // — the postcondition is "not archived", and it is already met.
  {
    op: "service_unarchive",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §8: "`account_list` returns each account's grants inline … there is no separate
  // grant-read tool" — one service_list plus one account_list is the CLI planner's whole
  // desired-state read.
  {
    op: "account_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8: "`{ slug, name?, description? }` — create a service account." `slugArg: "account"`
  // says the reservation does NOT apply here: §8 reserves `pmcp` for SERVICE slugs, and an
  // account slug lives in its own per-owner namespace. Stated by a column rather than by
  // omission, so the sweep asserts the non-reservation instead of merely skipping it.
  {
    op: "account_create",
    slugArg: "account",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "scratch-agent" },
  },
  // §8/§15: "ONE atomic D1 batch removes the account row (grants cascade by FK) and the
  // account's token rows, so a racing request can never authenticate against a
  // half-deleted account." No sockets are involved — the batch is the whole cascade.
  {
    op: "account_delete",
    slugArg: "account",
    writes: "mutating",
    sideEvents: [],
    cascade: ["service_account", "grant_", "token"],
    declaresOutputSchema: false,
    sample: { slug: "claude" },
  },
  // §8: "replaces the full grant set for (account, service)" — and "`pmcp` is rejected —
  // service accounts can never hold admin grants". `slugArg: "service"` points the
  // reservation sweep at the `service` field, which is where the reserved slug could do
  // damage; the `account` field beside it is an ordinary account slug. The granted role is
  // the built-in `all` (§18 decision 10: grantable, never declarable), so the sample
  // succeeds against a tunneled service whose roles arrive only at first registration.
  {
    op: "grant_set",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { account: "claude", service: "news", roles: ["all"] },
  },
  // §8: "`{ status?, limit? }` → approval requests, newest first (pending and history
  // alike)". Read-only, so no `admin.*` row — the lazy `approval.expired` a past-expiry row
  // may trigger on this read is approvals' write, not this op's, and needs a past-expiry
  // row to exist at all, which the sample does not create.
  {
    op: "approval_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8: "The lifecycle audit row (`approval.approved`/`.rejected`) is approvals' write; this
  // handler adds its own `admin.approval_decide`." Two writers, one call — which is exactly
  // what the sideEvents column exists to state.
  {
    op: "approval_decide",
    slugArg: "none",
    writes: "mutating",
    sideEvents: ["approval.approved"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { id: "fixture:approval.pending", decision: "approve" },
  },
  // §8: "The issued key is a `writeOnly`-marked field in this tool's *output* schema, so
  // §15's uniform body rule masks it wherever bodies are recorded — no pmcp-specific logging
  // rule exists or is needed." The one op in the table with an outputSchema, and the sample
  // uses `kind: "service"` so its `slug` really is a SERVICE slug — a `service_account`
  // sample would point the reservation sweep at an account slug and prove nothing (§8 lists
  // token_issue among the ops that reject `pmcp`). This op's slug is the only one in the
  // table whose MEANING depends on a sibling field, and `slugArg` is one value per row: the
  // sample resolves that by pinning the kind, and the question it therefore never asks —
  // `token_issue({ kind: "service_account", slug: "pmcp" })` — is one §8 does not answer
  // either (it reserves `pmcp` for service slugs and is silent on account slugs). A row
  // here would be inventing the answer, not transcribing it.
  {
    op: "token_issue",
    slugArg: "service",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: true,
    sample: { kind: "service", slug: "news" },
  },
  // §8: "listings include `last_used_at` … Never plaintext, never the hash."
  {
    op: "token_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8/§15: "revoking a `service` token also closes that service's live socket (code
  // `4001`) if the connection was opened with it" — the socket half is
  // tunnel/lifecycle.test.ts's; here the op takes a row id and writes its one audit row.
  // The sample revokes the ACCOUNT's key, which has no socket to sever in this project.
  {
    op: "token_revoke",
    slugArg: "none",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { id: "fixture:token.sa" },
  },
  // §8: "→ `{ rows, total }`, newest first … Read-only; like everything else, `pmcp audit`
  // is sugar over this tool." Defaults cover limit/offset, so the empty input succeeds.
  {
    op: "audit_query",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
];

/**
 * The one place assertion logic lives for the ops table: a spec change edits rows, a code
 * regression touches none (§1). Per row it runs the reserved-slug pair (refusal + its
 * generated allow-twin), the audit expectation (exactly one `admin.<op>` row for mutating
 * ops with the declared side events beside it, none for reads), the cascade's
 * all-or-nothing check over `cascade`, and parity direction A for that op.
 *
 * Its own invariant, and the reason a hand-listed table would be worthless here: the row
 * set must equal `Object.keys(ops)` exactly. An op added without a row fails loudly, an
 * op deleted leaves a row pointing at nothing — either way the sweep names the drift
 * instead of silently shrinking.
 */
export function runAdminOpTable(rows: readonly AdminOpRow[]): void {
  // deps: ../../src/admin (ops, adminBackend) · harness/seed · ../../src/audit (query) · env.DB
  describe("§8 — the reserved `pmcp` slug is a property of the table", () => {
    it("§8 · every slug-taking op refuses `pmcp` with the one uniform error, swept over Object.keys(ops)", async () => {
      const refusals: Refusal[] = [];
      for (const row of rows.filter((r) => r.slugArg === "service")) {
        refusals.push(await refusalOf(row, `${row.op}: the reserved slug must be refused`));
      }
      expect(refusals.length, "no service-slug op in the table — the sweep would assert nothing").toBeGreaterThan(0);
      // ONE error, not one per op (§8): what makes the reservation a property of the TABLE
      // is that the refusals are indistinguishable from each other, which no single row can
      // assert about itself.
      for (const refusal of refusals) {
        expect(refusal, `${refusal.op} refuses differently from ${refusals[0].op}`).toMatchObject({
          code: refusals[0].code,
          message: refusals[0].message,
        });
      }
      expect(refusals[0].message).toContain(PMCP_SLUG);
    });

    it("§8 · the same op accepts the fixture's real slug — the allow-twin the sweep generates per row", async () => {
      for (const row of rows) {
        // Each twin gets its own namespace: `service_delete` and `service_archive` name the
        // same fixture slug, so a shared one would make the second row assert the first's
        // aftermath instead of the fixture.
        const ns = await seedFixture();
        await expect(
          callOp(row, ns),
          `${row.op}: the sample must succeed against the seeded fixture`,
        ).resolves.toBeDefined();
      }
    });

    it("§8 · the row set equals Object.keys(ops) — a new op fails the sweep instead of skipping it", () => {
      expect(rows.map((r) => r.op).slice().sort()).toEqual(Object.keys(ops).sort());
      expect(rows.length, "one row per op, no duplicates").toBe(new Set(rows.map((r) => r.op)).size);
    });

    it("§8 · service_get('pmcp') refuses like every other slug-taking op — the builtin surfaces only through service_list", async () => {
      const ns = await seedFixture();
      const listed = await ops.service_list.handler(ns.owner.userId, {});
      expect(
        servicesOf(listed).map((s) => s.slug),
        "service_list is the one read the builtin surfaces through",
      ).toContain(PMCP_SLUG);
      const refusal = await refusalOf(rowFor(rows, "service_get"), "service_get('pmcp')");
      expect(refusal.message).toContain(PMCP_SLUG);
    });

    it("§8 · grant_set refuses `pmcp` as its service — accounts can never hold admin grants", async () => {
      const row = rowFor(rows, "grant_set");
      expect(slugFieldOf(row.sample), "grant_set names its service in the `service` field").toBe("service");
      const refusal = await refusalOf(row, "grant_set on the reserved slug");
      expect(refusal.message).toContain(PMCP_SLUG);
    });
  });

  describe("§8 — audit discipline, one row per mutating op", () => {
    it("§8 · every mutating op writes exactly one `admin.<op>` row, in the namespace it changed", async () => {
      for (const row of rows.filter((r) => r.writes === "mutating")) {
        const ns = await seedFixture();
        await callOp(row, ns);
        const written = await adminRows(ns.owner.userId);
        expect(
          written.map((r) => r.event),
          `${row.op}: exactly one admin row`,
        ).toEqual([`admin.${row.op}`]);
        expect(written[0].ownerId, `${row.op}: recorded in the namespace it changed`).toBe(ns.owner.userId);
      }
    });

    it("§8 · every read op writes no `admin.*` row (approval_list's lazy `approval.expired` is approvals' write)", async () => {
      for (const row of rows.filter((r) => r.writes === "read")) {
        const ns = await seedFixture();
        await callOp(row, ns);
        expect(await adminRows(ns.owner.userId), `${row.op}: a read summarises no change`).toEqual([]);
      }
    });

    it("§8 · an op refused for the reserved slug writes no `admin.<op>` row — no summary of a change that did not happen", async () => {
      for (const row of rows.filter((r) => r.slugArg === "service" && r.writes === "mutating")) {
        const ns = await seedFixture();
        await expect(callOp(row, ns, PMCP_SLUG)).rejects.toBeDefined();
        expect(await adminRows(ns.owner.userId), `${row.op}: refused, so nothing to summarise`).toEqual([]);
      }
    });

    it("§8 · service_update flipping `auth` writes `upstream.auth_mode_changed` beside its own row", async () => {
      await expectSideEvents(rows, "service_update");
    });

    it("§8 · service_disconnect writes `upstream.disconnected` beside its own row", async () => {
      await expectSideEvents(rows, "service_disconnect");
    });

    it("§8 · approval_decide's own row sits beside approvals' `approval.approved` — two writers, one call", async () => {
      await expectSideEvents(rows, "approval_decide");
    });

    it("§8 · token_issue's row names kind and referent, never the plaintext key", async () => {
      const row = rowFor(rows, "token_issue");
      const ns = await seedFixture();
      const issued = (await callOp(row, ns)) as { token: string };
      const [written] = await adminRows(ns.owner.userId);
      expect(written.detail, "the row names the kind and the referent").toMatchObject({
        kind: row.sample.kind,
        slug: row.sample.slug,
      });
      expect(issued.token, "the caller still holds the plaintext").toMatch(/^pmcp_svc_/);
      expect(JSON.stringify(written), "and the ledger never does").not.toContain(issued.token);
    });
  });

  describe("§15 — deleting cascades are one atomic D1 batch", () => {
    it("§15 · service_delete removes the service row and its token rows together — both gone or neither", async () => {
      await expectCascade(rows, "service_delete");
    });

    it("§15 · the namespace's other services, tokens, and grants are untouched by it (the allow-twin)", async () => {
      const row = rowFor(rows, "service_delete");
      const ns = await seedFixture();
      const bystanders = {
        notion: ns.services[NOTION].id,
        linear: ns.services[LINEAR].id,
        account: ns.accounts[CLAUDE].id,
      };
      const before = await bystanderCounts(bystanders);
      // Named explicitly, because "untouched" only means something if there was something to
      // touch: the account keeps its key and its grant on a service the cascade never names.
      expect(before.accountTokens).toBeGreaterThan(0);
      expect(before.accountGrants).toBeGreaterThan(0);
      await callOp(row, ns);
      expect(await bystanderCounts(bystanders), "the cascade is scoped to its own subject").toEqual(before);
    });

    it("§15 · account_delete removes the account row, its grants (FK cascade), and its token rows together", async () => {
      await expectCascade(rows, "account_delete");
    });

    it("§15 · a service_delete refused at validation leaves every row in place — no partial batch", async () => {
      const row = rowFor(rows, "service_delete");
      const ns = await seedFixture();
      const subject = ns.services[NEWS].id;
      const before = await cascadeCounts(row, subject);
      await expect(callOp(row, ns, PMCP_SLUG)).rejects.toBeDefined();
      expect(await cascadeCounts(row, subject), "a refused delete deletes nothing").toEqual(before);
    });

    it("§15 · service_delete on a proxied service stops after the batch: no DO, no tokens", async () => {
      const row = rowFor(rows, "service_delete");
      const ns = await seedFixture();
      const proxied = ns.services[NOTION].id;
      expect(
        await countRows(`SELECT COUNT(*) AS n FROM token WHERE ref_id = ?`, proxied),
        "a proxied service can hold no service token, so there is none to cascade",
      ).toBe(0);
      await ops.service_delete.handler(ns.owner.userId, { slug: NOTION });
      expect(await countRows(`SELECT COUNT(*) AS n FROM service WHERE id = ?`, proxied)).toBe(0);
      expect(await countRows(`SELECT COUNT(*) AS n FROM grant_ WHERE service_id = ?`, proxied)).toBe(0);
      // The DO half as the ledger sees it: a proxied service has no connection to evict, so
      // the op's own row carries no tunnel verdict at all — its tunneled twin's does.
      const [proxiedRow] = await adminRows(ns.owner.userId);
      expect(proxiedRow.detail, "a proxied delete addresses no DO").not.toHaveProperty("tunnel");
      const twin = await seedFixture();
      await callOp(row, twin);
      const [tunneledRow] = await adminRows(twin.owner.userId);
      expect(tunneledRow.detail, "a tunneled delete does").toHaveProperty("tunnel");
    });
  });

  describe("§8 — parity direction A: one schema, three fronts", () => {
    it("§8 · every ops key renders as a `pmcp` Tool whose inputSchema is that op's own schema", async () => {
      const tools = await listAdminTools();
      for (const row of rows) {
        const tool = tools.find((t) => t.name === row.op);
        expect(tool, `${row.op} renders no tool`).toBeDefined();
        const schema = (tool as Tool).inputSchema as {
          type?: unknown;
          properties?: Record<string, unknown>;
          additionalProperties?: unknown;
        };
        expect(schema.type, `${row.op}: an op's inputSchema is an object schema`).toBe("object");
        expect(schema.additionalProperties, `${row.op}: an unknown field is refused, not ignored`).toBe(false);
        // The link between "the tool's schema" and "the op's own schema", asserted without a
        // second copy of the renderer living here: every field the ORACLE's sample sends is
        // a field the rendered schema declares.
        for (const field of Object.keys(row.sample)) {
          expect(
            Object.keys(schema.properties ?? {}),
            `${row.op}: sample field "${field}" is undeclared`,
          ).toContain(field);
        }
      }
    });

    it("§8 · every tool adminBackend lists names an ops key — totality in the other direction", async () => {
      const tools = await listAdminTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ops).sort());
    });

    it("§8 · token_issue alone declares an outputSchema, and its key field carries `writeOnly`", async () => {
      const tools = await listAdminTools();
      expect(tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name)).toEqual(
        rows.filter((r) => r.declaresOutputSchema).map((r) => r.op),
      );
      // registry.writeOnlyPaths is the ONE definition of the mark's path grammar (§7);
      // recomputing it here would be a second one.
      expect(writeOnlyPaths(tools.find((t) => t.name === "token_issue")?.outputSchema)).toEqual([TOKEN_FIELD]);
    });

    it("§8 · adminBackend.sensitivePaths answers `{ args: [], results: [...] }` for known ops and null for an unknown name", async () => {
      const service = pmcpService(OWNERLESS);
      for (const row of rows) {
        const paths = await adminBackend.sensitivePaths(service, row.op);
        expect(paths?.args, `${row.op}: no admin tool takes a sensitive argument`).toEqual([]);
        expect(paths?.results, `${row.op}: the only sensitive result is token_issue's key`).toEqual(
          row.declaresOutputSchema ? [TOKEN_FIELD] : [],
        );
      }
      expect(await adminBackend.sensitivePaths(service, "no_such_op")).toBeNull();
    });
  });
}

// ── the fixture every sweep above runs against ────────────────────────────────────────

/** The fixture's slugs, named once — the table's preamble says what each one is for. */
const NEWS = "news";
const NOTION = "notion";
const LINEAR = "linear";
const CLAUDE = "claude";

/** The two token handles; `fixture:token.sa` resolves to the second one's row id. */
const SVC_TOKEN = "token.svc";
const SA_TOKEN = "token.sa";

/** token_issue's one `writeOnly`-marked output field — the plaintext key (§8). */
const TOKEN_FIELD = "token";

/**
 * The endpoint the two proxied fixtures carry. No op in this table dials it (the credential
 * ops write D1 and nothing else), and it points at the fake upstream's reserved host so an
 * op that DID dial fails loudly instead of reaching the internet.
 */
const UPSTREAM_URL = "https://upstream.pmcp-test.invalid/admin-ops/never-dialed";

/**
 * A namespace shaped exactly as the table's preamble names it. Built fresh per row: the
 * `worker` project isolates storage per FILE, not per case, so two rows sharing a fixture
 * would let `service_delete` decide what `service_archive` finds.
 */
async function seedFixture(): Promise<SeededNamespace> {
  return seedNamespace(env.DB, {
    services: [
      { slug: NEWS, kind: "tunnel", tokens: [{ as: SVC_TOKEN }] },
      { slug: NOTION, kind: "proxy", upstreamUrl: UPSTREAM_URL, upstreamAuthMode: "headers" },
      { slug: LINEAR, kind: "proxy", upstreamUrl: UPSTREAM_URL, upstreamAuthMode: "oauth" },
    ],
    accounts: [
      {
        slug: CLAUDE,
        // The built-in `all` in both places, so the fixture accumulates no "role not
        // declared" warnings on its way to existing (§18 decision 10: grantable, never
        // declarable) — and so the delete sweep has a grant on a BYSTANDER service too.
        grants: {
          [NEWS]: [{ role: "all", mode: "allow" }],
          [NOTION]: [{ role: "all", mode: "allow" }],
        },
        tokens: [{ as: SA_TOKEN }],
      },
    ],
  });
}

/**
 * Run one row's op against a seeded namespace. `slugOverride` is how the reserved-slug twin
 * is generated from the same cell the allow-twin uses — nothing in this table is spelled
 * twice.
 */
async function callOp(row: AdminOpRow, ns: SeededNamespace, slugOverride?: string): Promise<unknown> {
  const input = await resolveSample(row.sample, ns);
  if (slugOverride !== undefined) input[slugFieldOf(row.sample)] = slugOverride;
  return ops[row.op].handler(ns.owner.userId, input);
}

/**
 * The field a reserved-slug twin replaces. `grant_set` is the one op whose service slug is
 * not called `slug` — §8 points the reservation at the service, not the account beside it.
 */
function slugFieldOf(sample: Record<string, unknown>): string {
  return "service" in sample ? "service" : "slug";
}

/**
 * The two `fixture:<handle>` samples resolved against the seeded namespace — row ids no
 * static cell can hold (the table's preamble names both).
 */
async function resolveSample(
  sample: Record<string, unknown>,
  ns: SeededNamespace,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = { ...sample };
  for (const [field, value] of Object.entries(resolved)) {
    if (value === "fixture:token.sa") resolved[field] = ns.tokens[SA_TOKEN].id;
    if (value === "fixture:approval.pending") resolved[field] = await openPendingApproval(ns);
  }
  return resolved;
}

/**
 * A pending approval, opened the only way one can be: through the gate. The seeding gate
 * writes no audit row and sends no push, so the `approval.approved` this table looks for
 * afterwards is unambiguously the OP's side event rather than the fixture's noise.
 */
async function openPendingApproval(ns: SeededNamespace): Promise<string> {
  const gate = new Approvals({
    db: env.DB,
    publicOrigin: "https://admin-ops.pmcp-test.invalid",
    audit: { record: async () => {} },
    retentionDays: 7,
    now: Date.now,
  });
  const opened = await gate.check(
    { kind: "service_account", accountId: ns.accounts[CLAUDE].id, ownerId: ns.owner.userId, slug: CLAUDE },
    serviceValue(ns, NEWS),
    "get_news",
    {},
    [],
  );
  if (opened.outcome !== "required") {
    throw new Error(`seeding expected a fresh pending row, got "${opened.outcome}"`);
  }
  return opened.approvalId;
}

/** One seeded service as the cross-module `Service` value approvals takes. */
function serviceValue(ns: SeededNamespace, slug: string): Service {
  const seeded = ns.services[slug];
  return {
    id: seeded.id,
    ownerId: ns.owner.userId,
    slug: seeded.slug,
    kind: seeded.kind,
    archived: false,
    logBodies: true,
  };
}

// ── what the sweeps read back ─────────────────────────────────────────────────────────

/** The `admin.*` rows one namespace accumulated, oldest first. */
async function adminRows(ownerId: string) {
  const { rows } = await query(env.DB, ownerId, { limit: 200 });
  return rows.filter((row) => row.event.startsWith("admin.")).reverse();
}

/** Every event one namespace accumulated — the side-event sweep's haystack. */
async function eventsOf(ownerId: string): Promise<AuditEntry["event"][]> {
  const { rows } = await query(env.DB, ownerId, { limit: 200 });
  return rows.map((row) => row.event);
}

/** The refusal one row's reserved-slug twin produced, reduced to what must be uniform. */
type Refusal = { op: string; code: unknown; message: string };

async function refusalOf(row: AdminOpRow, what: string): Promise<Refusal> {
  const ns = await seedFixture();
  try {
    await callOp(row, ns, PMCP_SLUG);
  } catch (thrown) {
    const error = thrown as { code?: unknown; message?: string };
    return { op: row.op, code: error.code, message: String(error.message) };
  }
  throw new Error(`${what}: the op accepted the reserved slug`);
}

/** The row named, or a failure naming the locked title that has gone stale. */
function rowFor(rows: readonly AdminOpRow[], op: string): AdminOpRow {
  const row = rows.find((r) => r.op === op);
  if (row === undefined) throw new Error(`no row for "${op}" — a locked case names an op the table dropped`);
  return row;
}

/** `service_list`'s rows, whatever the handler wraps them in. */
function servicesOf(listed: unknown): { slug: string }[] {
  return (listed as { services: { slug: string }[] }).services;
}

/** Run one row's sample and assert its declared side events landed beside its own row. */
async function expectSideEvents(rows: readonly AdminOpRow[], op: string): Promise<void> {
  const row = rowFor(rows, op);
  expect(row.sideEvents.length, `${op}: the locked case names a side event the row does not`).toBeGreaterThan(0);
  const ns = await seedFixture();
  await callOp(row, ns);
  const events = await eventsOf(ns.owner.userId);
  expect(events, `${op}: its own row`).toContain(`admin.${op}`);
  for (const side of row.sideEvents) {
    expect(events, `${op}: the side event a module underneath owes`).toContain(side);
  }
}

/** The row families one deleting op removes, counted before and after its own call. */
async function expectCascade(rows: readonly AdminOpRow[], op: string): Promise<void> {
  const row = rowFor(rows, op);
  const ns = await seedFixture();
  const subject = subjectOf(row, ns);
  const before = await cascadeCounts(row, subject);
  for (const [family, count] of Object.entries(before)) {
    expect(count, `${op}: nothing to cascade in "${family}" — the assertion would be vacuous`).toBeGreaterThan(0);
  }
  await callOp(row, ns);
  // All families in ONE comparison: "both gone or neither" is a property of the set.
  expect(await cascadeCounts(row, subject), `${op}: every family the batch removes is gone together`).toEqual(
    Object.fromEntries(Object.keys(before).map((family) => [family, 0])),
  );
}

/** The id a deleting row's cascade is keyed on — its own sample's subject. */
function subjectOf(row: AdminOpRow, ns: SeededNamespace): string {
  const slug = String(row.sample.slug);
  return row.cascade.includes("service_account") ? ns.accounts[slug].id : ns.services[slug].id;
}

/** One count per family the row declares, keyed the way that family references its parent. */
async function cascadeCounts(row: AdminOpRow, subject: string): Promise<Record<string, number>> {
  const parent = row.cascade.includes("service_account") ? "service_account_id" : "service_id";
  const counts: Record<string, number> = {};
  for (const family of row.cascade) {
    const sql =
      family === "grant_"
        ? `SELECT COUNT(*) AS n FROM grant_ WHERE ${parent} = ?`
        : family === "token"
          ? `SELECT COUNT(*) AS n FROM token WHERE ref_id = ?`
          : `SELECT COUNT(*) AS n FROM ${family} WHERE id = ?`;
    counts[family] = await countRows(sql, subject);
  }
  return counts;
}

/**
 * What a cascade must NOT reach: the namespace's OTHER services, the grants held on one of
 * them, and the account's own credential. Grants are counted on the bystander service
 * rather than on the account, because the account's grant on the deleted service is
 * supposed to go — it rides the FK from the parent the op really did remove (§5).
 */
async function bystanderCounts(ids: { notion: string; linear: string; account: string }) {
  return {
    notion: await countRows(`SELECT COUNT(*) AS n FROM service WHERE id = ?`, ids.notion),
    linear: await countRows(`SELECT COUNT(*) AS n FROM service WHERE id = ?`, ids.linear),
    account: await countRows(`SELECT COUNT(*) AS n FROM service_account WHERE id = ?`, ids.account),
    accountGrants: await countRows(
      `SELECT COUNT(*) AS n FROM grant_ WHERE service_account_id = ? AND service_id = ?`,
      ids.account,
      ids.notion,
    ),
    accountTokens: await countRows(`SELECT COUNT(*) AS n FROM token WHERE ref_id = ?`, ids.account),
  };
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await (env.DB as D1Like).prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── parity direction A's two reads ────────────────────────────────────────────────────

/** An owner id no fixture uses: the parity sweeps read the ops table, never a namespace. */
const OWNERLESS = "parity-reads-no-namespace";

/** The virtual `pmcp` Service the gateway hands the backend — only `ownerId` is consulted. */
function pmcpService(ownerId: string): Service {
  return { id: PMCP_SLUG, ownerId, slug: PMCP_SLUG, kind: "tunnel", archived: false, logBodies: true };
}

async function listAdminTools(): Promise<Tool[]> {
  const ctx: BackendCtx = {
    principal: { kind: "user", userId: OWNERLESS, username: "parity" },
    roles: ["all"],
  };
  return adminBackend.listTools(pmcpService(OWNERLESS), ctx);
}

runAdminOpTable(ADMIN_OP_ROWS);

// ── §8 · audit_query's filters, each proven to narrow ─────────────────────────────────
//
// The ops table above calls `audit_query` with `{}` — enough to prove the op is a read
// that writes no `admin.*` row, and blind to every filter it declares. §8 gives the tool
// nine parameters and audit.whereClause turns each into one AND-ed clause; a clause
// dropped, or bound to the wrong column, is invisible to a sample that never passes one:
// the op still answers `{ rows, total }` and the row set is merely WIDER than it should
// be. Widening is the failure mode that matters — `pmcp audit --account claude` and the
// /audit page's principal link both promise "this actor alone", and a filter that
// silently ignored its value would show one namespace's whole ledger under another
// agent's name.
//
// Here through the same seam the ops-table row uses (`ops.audit_query.handler`), against
// rows written by audit.record — the module's only writer, the one every production path
// goes through. `principal` gets its own describe because it selects; `since`/`until` get
// theirs because they bound, and a bound is only observable against a ledger that spans
// more than one instant (each case asserts that precondition rather than assuming it).
//
// Not here: `service`/`event`/`tool`/`session`, which the /audit filter walk already
// passes values for (web-pages.test.ts), and `limit`/`offset`, whose defaults §8 pins and
// whose paging the same page's cases drive.

/** The op's answer, in the shape §8 pins — `{ rows, total }`, newest first. */
type AuditPage = { rows: AuditRow[]; total: number };

/** One read through the ops seam, exactly as an MCP `tools/call` on `pmcp` reaches it. */
async function auditQuery(ns: SeededNamespace, filters: Record<string, unknown>): Promise<AuditPage> {
  return (await ops.audit_query.handler(ns.owner.userId, filters)) as AuditPage;
}

/**
 * The two agent principals this block writes under. Spelled as §8's `sa:<slug>` form, the
 * same string `pmcp audit --account claude` resolves to, so a case that passed a bare slug
 * would be testing a spelling no caller uses.
 */
const AGENT = `sa:${CLAUDE}`;
const OTHER_AGENT = "sa:scratch-agent";

/**
 * The third principal in this namespace, and the one nothing here wrote: `admin
 * .provisionUser` records the namespace's creation under it (seed harness FINDINGS 3), so
 * every seeded ledger starts with a row the filter cases can be read against. Spelled as
 * the literal admin.ts writes and audit.AuditEntry documents — the vocabulary is durable
 * (§7), the module holding it exports no name for it, and inventing one here would be a
 * second spelling rather than a reference.
 */
const BOOTSTRAP = "bootstrap";

/**
 * Three `tools/call` rows — two under one agent, one under another — through audit.record,
 * awaited one at a time. The awaits are load-bearing twice over: they are how a real
 * request path writes (record() is awaited, §15 — a call the ledger cannot attest to must
 * not succeed), and each one is a D1 round trip, which is what lets the hub-stamped `ts`
 * of the three rows differ at all. The seeded namespace's own `bootstrap` row is left
 * where it is: it is a third principal nobody here wrote, so the principal cases have a
 * row they cannot have accidentally shaped.
 */
async function seedLedger(ns: SeededNamespace): Promise<void> {
  for (const principal of [AGENT, AGENT, OTHER_AGENT]) {
    await record(env.DB, {
      ownerId: ns.owner.userId,
      principal,
      event: "tools/call",
      service: NEWS,
      tool: "get_news",
      outcome: "ok",
    });
  }
}

describe("§8 — audit_query's `principal` selects one actor's rows", () => {
  it("§8 · `principal` returns that actor's rows and only those — the unfiltered read is strictly wider, so the filter selects rather than merely shrinks", async () => {
    const ns = await seedFixture();
    await seedLedger(ns);
    const all = await auditQuery(ns, {});

    const mine = await auditQuery(ns, { principal: AGENT });
    expect(mine.rows.map((row) => row.principal), "every row is the named actor's").toEqual([AGENT, AGENT]);
    expect(mine.total, "and `total` counts the FILTERED match set, not the table").toBe(2);
    expect(mine.total).toBeLessThan(all.total);

    // The allow-twin (§9 rule 2): the rows the first filter excluded are still reachable
    // under their own principal, so "narrowed" is not "lost".
    const other = await auditQuery(ns, { principal: OTHER_AGENT });
    expect(other.rows.map((row) => row.principal)).toEqual([OTHER_AGENT]);
    const bootstrap = await auditQuery(ns, { principal: BOOTSTRAP });
    expect(bootstrap.total, "the row the seed's own provisioning wrote").toBeGreaterThan(0);
    // Totality over the namespace: three principals, and between them every row. A clause
    // bound to the wrong column would leave this sum short or over.
    expect(mine.total + other.total + bootstrap.total).toBe(all.total);
  });

  it("§8 · a principal nobody acted under answers `{ rows: [], total: 0 }` — no matches is an empty page, never an error", async () => {
    const ns = await seedFixture();
    await seedLedger(ns);
    expect(await auditQuery(ns, { principal: "sa:FAKE0000-never-acted" })).toEqual({ rows: [], total: 0 });
  });
});

describe("§8 — audit_query's `since` and `until` bound the ledger", () => {
  it("§8 · `since` is an INCLUSIVE lower bound: the oldest row's own stamp still returns everything, the newest row's stamp drops what came before it, and one ms past the newest returns nothing", async () => {
    const ns = await seedFixture();
    await seedLedger(ns);
    const all = await auditQuery(ns, {});
    const { oldest, newest } = span(all);

    expect(
      (await auditQuery(ns, { since: oldest })).total,
      "inclusive: the boundary row is inside its own bound",
    ).toBe(all.total);

    const late = await auditQuery(ns, { since: newest });
    expect(late.total, "and the bound actually narrows").toBeLessThan(all.total);
    expect(late.rows.every((row) => row.ts >= newest), "every returned row is at or after the bound").toBe(true);

    expect((await auditQuery(ns, { since: newest + 1 })).total, "past the last row: nothing matches").toBe(0);
  });

  it("§8 · `until` is an INCLUSIVE upper bound, symmetrically: the newest row's stamp returns everything, the oldest row's stamp drops what came after it, and one ms before the oldest returns nothing", async () => {
    const ns = await seedFixture();
    await seedLedger(ns);
    const all = await auditQuery(ns, {});
    const { oldest, newest } = span(all);

    expect((await auditQuery(ns, { until: newest })).total, "inclusive at the top end too").toBe(all.total);

    const early = await auditQuery(ns, { until: oldest });
    expect(early.total).toBeLessThan(all.total);
    expect(early.rows.every((row) => row.ts <= oldest), "every returned row is at or before the bound").toBe(true);

    expect((await auditQuery(ns, { until: oldest - 1 })).total, "before the first row: nothing matches").toBe(0);
  });

  it("§8 · the two bounds AND together into one window — an inverted window (`since` after `until`) matches nothing rather than falling back to either bound alone", async () => {
    const ns = await seedFixture();
    await seedLedger(ns);
    const all = await auditQuery(ns, {});
    const { oldest, newest } = span(all);

    expect((await auditQuery(ns, { since: oldest, until: newest })).total, "the whole span").toBe(all.total);
    // Two clauses, both applied: either one alone would return rows here.
    expect((await auditQuery(ns, { since: newest, until: oldest })).total).toBe(0);
  });
});

/**
 * The ledger's first and last stamps, with the precondition every bounding case rests on
 * asserted here once: a ledger written inside a single millisecond has no interior for a
 * bound to cut at, and a case that assumed otherwise would go green without narrowing
 * anything. workerd advances the clock at I/O, and seedLedger's awaits are that I/O — if
 * this ever stops holding, it fails HERE, naming the assumption rather than the filter.
 */
function span(page: AuditPage): { oldest: number; newest: number } {
  const stamps = page.rows.map((row) => row.ts);
  const oldest = Math.min(...stamps);
  const newest = Math.max(...stamps);
  expect(newest, "the seeded ledger spans a single instant — a bound would narrow nothing").toBeGreaterThan(oldest);
  return { oldest, newest };
}
