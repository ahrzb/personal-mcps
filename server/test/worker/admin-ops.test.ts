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
// deps: harness/seed (namespace fixture: owner, one tunneled + one proxied app, one
//   agent, one token per kind) · ../../src/admin (ops, adminBackend) ·
//   ../../src/registry · ../../src/identity · ../../src/audit · ../../src/errors (CODES —
//   the refusal code the violations list rides on) · ../../src/approvals (the
//   gate the one `fixture:approval.pending` sample is opened through — the seed harness
//   has no approval seam, by design) · applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminBackend, ops } from "../../src/admin";
import { RESERVED_APP_SLUGS } from "../../src/app-routes";
import { Approvals } from "../../src/approvals";
import { query, record } from "../../src/audit";
import type { AuditEntry, AuditRow } from "../../src/audit";
import { CODES } from "../../src/errors";
import type { BackendCtx, Tool } from "../../src/gateway";
import { issueAdminToken, resolveCaller } from "../../src/identity";
import { upsertBinding } from "../../src/oauth";
import { tokenPattern } from "../../src/principal";
import { HUB_SLUG, PMCP_SLUG, Registry, SLUG_CHARSET, writeOnlyPaths } from "../../src/registry";
import type { App, ToolFilter } from "../../src/registry";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
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
 * with its slug field replaced by `pmcp` — which for a `"app"` slug must be the one
 * uniform reserved-slug refusal, and for an `"agent"` slug must be anything but it
 * (see `slugArg`). No row lists a refusal without its twin, because the twin is
 * generated from the same cell.
 */
export type AdminOpRow = {
  /** The ops key. The table is total over `Object.keys(ops)` — see runAdminOpTable. */
  op: OpName;
  /**
   * Which reserved-slug sweep applies: `"app"` ops take an app slug and must
   * refuse `pmcp` with the one uniform error; `"agent"` ops take an agent slug (no
   * reservation, but the column says so explicitly rather than by omission); `"none"`
   * ops take neither.
   *
   * What the `"agent"` sweep asserts, stated because it is NOT "must succeed": §8
   * reserves `pmcp` for app slugs and says nothing about agent slugs, so the
   * property is that the op's answer is never the RESERVED-SLUG refusal — a create
   * succeeds, and a delete of an agent nobody has created fails as not-found, which is
   * a different error for a different reason. Demanding success would make the sweep
   * unsatisfiable for the deleting ops, which is the opposite of what the column means.
   */
  slugArg: "app" | "agent" | "none";
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
  cascade: readonly ("app" | "agent" | "grant_" | "token")[];
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
  // The fixture every `sample` is written against, named once: apps `news` (tunneled,
  // holding a `pmcp_app_` token), `notion` (proxied, `auth: headers`) and `linear`
  // (proxied, `auth: oauth`); one agent `claude` holding a `pmcp_agt_` token and grants on
  // `news`. Two proxied apps is not padding — it is what these samples PROVE the
  // fixture needs: §8 gives each auth mode exactly one credential path, so
  // `app_set_upstream_auth` succeeds only on a `headers` app and
  // `app_disconnect` only on an `oauth` one, and no single proxied row can be both.
  //
  // Two `sample` values are row IDs rather than slugs, which no static cell can hold: they
  // are written as `fixture:<handle>` and the runner resolves them against the seeded
  // namespace before calling the op (`fixture:token.sa` is the agent's minted token id,
  // `fixture:approval.pending` a pending approval opened through the gate — the seed
  // harness has no approval seam, by design). Nothing else in the table is indirect.
  //
  // `cascade` lists `grant_` on BOTH deleting ops, though the locked case titles name it
  // only on `agent_delete`: grant rows ride the FK from either parent (§5), so the batch
  // removes them either way and the sweep should say so. Asserting all-or-nothing over a
  // family the op does not touch would be the error; this is the opposite.

  // §8: "`app_list` … includes it flagged `builtin: true`" — the one read that must
  // answer for an app with no row. Reads write no `admin.*` row (§15 records mutations).
  {
    op: "app_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8: "`{ slug }` → one app, same row shape as app_list. The reserved `pmcp` slug
  // is rejected like everywhere else (the builtin surfaces only through app_list —
  // uniformity is worth more than the corner case)."
  {
    op: "app_get",
    slugArg: "app",
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
    op: "app_create",
    slugArg: "app",
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
    op: "app_update",
    slugArg: "app",
    writes: "mutating",
    sideEvents: ["upstream.auth_mode_changed"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "notion", auth: "oauth" },
  },
  // §15/§8: "ONE atomic D1 batch removes the app row (grants cascade by FK) and its
  // token rows FIRST; only then is the tunnel DO told to sever". This file owns the D1 half
  // (both gone or neither); the 4001-before-the-wipe ordering is tunnel/lifecycle.test.ts's.
  {
    op: "app_delete",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: ["app", "grant_", "token"],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §8: "proxied only: stores the headers (e.g. a bearer token) the hub sends upstream …
  // rejected on `auth: oauth` apps". The header VALUE is deliberately, visibly fake: no
  // credential-shaped string belongs in a row that gets printed in test output.
  {
    op: "app_set_upstream_auth",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "notion", headers: { "X-Api-Key": "FAKE0000-not-a-real-upstream-key" } },
  },
  // §8: "`auth: oauth` proxied apps only: wipes the stored token bundle (audit row
  // `upstream.disconnected`)". The fixture's `linear` is oauth-mode and NOT connected — a
  // connected one is unreachable from the seed harness, which may only reach an envelope
  // through `upstream.setHeaders` or the real connect flow (upstream-credentials.test.ts's).
  // The sample therefore also asserts the postcondition reading: disconnecting an
  // already-disconnected app succeeds, the way unarchiving an unarchived one does —
  // and, like `app_unarchive` two rows down, still writes its ledger rows, because in
  // this table an op that RAN records that it ran. upstream.disconnect's "Idempotent:
  // disconnecting an already-empty app is a no-op" is about the wipe (there is nothing
  // to wipe), not about the ledger: the same header's first sentence writes
  // `upstream.disconnected` unconditionally. If the owner means the lifecycle row to
  // follow the wipe rather than the call, that is a `spec:` change and it takes the locked
  // todo "app_disconnect writes `upstream.disconnected` beside its own row" with it.
  {
    op: "app_disconnect",
    slugArg: "app",
    writes: "mutating",
    sideEvents: ["upstream.disconnected"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "linear" },
  },
  // §6/§8: reversible parking — the flag lands in D1, then any live socket is severed
  // (4002, tunnel/lifecycle.test.ts's half). Roles, grants, tokens and catalog are retained.
  {
    op: "app_archive",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §6: "`app_unarchive` restores everything." Registry pins unarchiving an unarchived
  // row as a no-op, so the fixture needs no pre-archived app for this sample to succeed
  // — the postcondition is "not archived", and it is already met.
  {
    op: "app_unarchive",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "news" },
  },
  // §8: "`agent_list` returns each agent's grants inline … there is no separate
  // grant-read tool".
  {
    op: "agent_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §8: "`{ slug, name?, description? }` — create an agent." `slugArg: "agent"`
  // says the reservation does NOT apply here: §8 reserves `pmcp` for APP slugs, and an
  // agent slug lives in its own per-owner namespace. Stated by a column rather than by
  // omission, so the sweep asserts the non-reservation instead of merely skipping it.
  {
    op: "agent_create",
    slugArg: "agent",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "scratch-agent" },
  },
  // §22.4: patches an agent's display fields; `slug` is immutable. `slugArg: "agent"`
  // for the same reason as agent_create — §8 reserves `pmcp` for APP slugs only. The
  // smallest succeeding sample changes `name` alone, `description` staying untouched.
  {
    op: "agent_update",
    slugArg: "agent",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { slug: "claude", name: "Claude Renamed" },
  },
  // §8/§15: "ONE atomic D1 batch removes the agent row (grants cascade by FK) and the
  // agent's token rows, so a racing request can never authenticate against a
  // half-deleted agent." No sockets are involved — the batch is the whole cascade.
  {
    op: "agent_delete",
    slugArg: "agent",
    writes: "mutating",
    sideEvents: [],
    cascade: ["agent", "grant_", "token"],
    declaresOutputSchema: false,
    sample: { slug: "claude" },
  },
  // §8: "replaces the full grant set for (agent, app)" — and "`pmcp` is rejected —
  // agents can never hold admin grants". `slugArg: "app"` points the
  // reservation sweep at the `app` field, which is where the reserved slug could do
  // damage; the `agent` field beside it is an ordinary agent slug. The granted role is
  // the built-in `all` (§18 decision 10: grantable, never declarable), so the sample
  // succeeds against a tunneled app whose roles arrive only at first registration.
  {
    op: "grant_set",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { agent: "claude", app: "news", roles: ["all"] },
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
  // uses `kind: "app"` so its `slug` really is an APP slug — an `agent`
  // sample would point the reservation sweep at an agent slug and prove nothing (§8 lists
  // token_issue among the ops that reject `pmcp`). This op's slug is the only one in the
  // table whose MEANING depends on a sibling field, and `slugArg` is one value per row: the
  // sample resolves that by pinning the kind, and the question it therefore never asks —
  // `token_issue({ kind: "agent", slug: "pmcp" })` — is one §8 does not answer
  // either (it reserves `pmcp` for app slugs and is silent on agent slugs). A row
  // here would be inventing the answer, not transcribing it.
  {
    op: "token_issue",
    slugArg: "app",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: true,
    sample: { kind: "app", slug: "news" },
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
  // §8/§15: "revoking a `app` token also closes that app's live socket (code
  // `4001`) if the connection was opened with it" — the socket half is
  // tunnel/lifecycle.test.ts's; here the op takes a row id and writes its one audit row.
  // The sample revokes the AGENT's key, which has no socket to sever in this project.
  {
    op: "token_revoke",
    slugArg: "none",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { id: "fixture:token.sa" },
  },
  // §22.1: a `pmcp_adm_` credential, present ONLY in this result, once — the SECOND
  // (and last) op whose output declares a `writeOnly` field, beside token_issue's. No
  // slug at all (`slugArg: "none"`): an admin token binds to its owner alone.
  {
    op: "admin_token_issue",
    slugArg: "none",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: true,
    sample: {},
  },
  // §22.1: "list this namespace's admin tokens … never plaintext" — the same
  // rotation-state shape token_list shows the shared table's rows.
  {
    op: "admin_token_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §22.1: "revoke one admin token, immediate on every surface." The sample is a row id
  // no static cell can hold — `fixture:admin_token.mine` mints one through
  // identity.issueAdminToken (resolveSample, below), exactly like `fixture:token.sa`
  // resolves token_revoke's.
  {
    op: "admin_token_revoke",
    slugArg: "none",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { id: "fixture:admin_token.mine" },
  },
  // §19/§8: "the OAuth clients connected to this namespace … never a token, a client
  // secret, or a JWT." A read like `app_list`/`agent_list` — empty input succeeds.
  {
    op: "connection_list",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §19.6/§8: "`connection_revoke` takes `{ id }` … writes an `admin.connection_revoke`
  // audit row." The sample is a row id no static cell can hold — `fixture:binding.oauth`
  // opens one through `oauth.upsertBinding`, the same seam the consent page writes through
  // (resolveSample, below), exactly like `fixture:token.sa` resolves token_revoke's.
  {
    op: "connection_revoke",
    slugArg: "none",
    writes: "mutating",
    sideEvents: ["oauth.revoked"],
    cascade: [],
    declaresOutputSchema: false,
    sample: { id: "fixture:binding.oauth" },
  },
  // §23.3: "`hub_settings_get` — `{}` → `{ settings: { defaultTimeoutMs, maxTimeoutMs } }`,
  // reading the absent-row default pair". A read, so no `admin.*` row; no slug at all, so
  // the reservation sweep does not apply (the virtual slugs are reserved for APP slugs).
  {
    op: "hub_settings_get",
    slugArg: "none",
    writes: "read",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: {},
  },
  // §23.3: "requires both `{ default_timeout_ms, max_timeout_ms }`, validates
  // `1_000 <= default <= max <= 300_000`, atomically upserts, and returns the same settings
  // shape". The sample is the pair a provider destroy restores, so both columns are
  // exercised as one write — which is what makes the upsert one atomic pair, not two
  // half-updates a reader could observe apart.
  {
    op: "hub_settings_update",
    slugArg: "none",
    writes: "mutating",
    sideEvents: [],
    cascade: [],
    declaresOutputSchema: false,
    sample: { default_timeout_ms: 1_000, max_timeout_ms: 30_000 },
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
      for (const row of rows.filter((r) => r.slugArg === "app")) {
        refusals.push(await refusalOf(row, `${row.op}: the reserved slug must be refused`));
      }
      expect(refusals.length, "no app-slug op in the table — the sweep would assert nothing").toBeGreaterThan(0);
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

    // One namespace per operation keeps destructive twins independent; the exhaustive
    // sweep intentionally exceeds Vitest's five-second default under full-suite load.
    it("§8 · the same op accepts the fixture's real slug — the allow-twin the sweep generates per row", async () => {
      for (const row of rows) {
        // Each twin gets its own namespace: `app_delete` and `app_archive` name the
        // same fixture slug, so a shared one would make the second row assert the first's
        // aftermath instead of the fixture.
        const ns = await seedFixture();
        await expect(
          callOp(row, ns),
          `${row.op}: the sample must succeed against the seeded fixture`,
        ).resolves.toBeDefined();
      }
    }, 15_000);

    it("§8 · the row set equals Object.keys(ops) — a new op fails the sweep instead of skipping it", () => {
      expect(rows.map((r) => r.op).slice().sort()).toEqual(Object.keys(ops).sort());
      expect(rows.length, "one row per op, no duplicates").toBe(new Set(rows.map((r) => r.op)).size);
    });

    it("§8 · app_get('pmcp') refuses like every other slug-taking op — the builtin surfaces only through app_list", async () => {
      const ns = await seedFixture();
      const listed = await ops.app_list.handler(ns.owner.userId, {});
      expect(
        appsOf(listed).map((s) => s.slug),
        "app_list is the one read the builtin surfaces through",
      ).toContain(PMCP_SLUG);
      const refusal = await refusalOf(rowFor(rows, "app_get"), "app_get('pmcp')");
      expect(refusal.message).toContain(PMCP_SLUG);
    });

    it("§8 · grant_set refuses `pmcp` as its app — agents can never hold admin grants", async () => {
      const row = rowFor(rows, "grant_set");
      expect(slugFieldOf(row.sample), "grant_set names its app in the `app` field").toBe("app");
      const refusal = await refusalOf(row, "grant_set on the reserved slug");
      expect(refusal.message).toContain(PMCP_SLUG);
    });
  });

  describe("§8 — audit discipline, one row per mutating op", () => {
    it("§8 · every mutating op writes exactly one `admin.<op>` row", async () => {
      for (const row of rows.filter((r) => r.writes === "mutating")) {
        const ns = await seedFixture();
        await callOp(row, ns);
        const written = await adminRows(ns.owner.userId);
        expect(
          written.map((r) => r.event),
          `${row.op}: exactly one admin row`,
        ).toEqual([`admin.${row.op}`]);
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
      for (const row of rows.filter((r) => r.slugArg === "app" && r.writes === "mutating")) {
        const ns = await seedFixture();
        await expect(callOp(row, ns, PMCP_SLUG)).rejects.toBeDefined();
        expect(await adminRows(ns.owner.userId), `${row.op}: refused, so nothing to summarise`).toEqual([]);
      }
    });

    it("§8 · app_update flipping `auth` writes `upstream.auth_mode_changed` beside its own row", async () => {
      await expectSideEvents(rows, "app_update");
    });

    it("§8 · app_disconnect writes `upstream.disconnected` beside its own row", async () => {
      await expectSideEvents(rows, "app_disconnect");
    });

    it("§8 · approval_decide's own row sits beside approvals' `approval.approved` — two writers, one call", async () => {
      await expectSideEvents(rows, "approval_decide");
    });

    it("§19.6 · connection_revoke's own row sits beside `oauth.revoked` — two events, one call", async () => {
      await expectSideEvents(rows, "connection_revoke");
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
      expect(issued.token, "the caller still holds the plaintext").toMatch(/^pmcp_app_/);
      expect(JSON.stringify(written), "and the ledger never does").not.toContain(issued.token);
    });
  });

  describe("§15 — deleting cascades are one atomic D1 batch", () => {
    it("§15 · app_delete removes the app row and its token rows together — both gone or neither", async () => {
      await expectCascade(rows, "app_delete");
    });

    it("§15 · the namespace's other apps, tokens, and grants are untouched by it (the allow-twin)", async () => {
      const row = rowFor(rows, "app_delete");
      const ns = await seedFixture();
      const bystanders = {
        notion: ns.apps[NOTION].id,
        linear: ns.apps[LINEAR].id,
        agent: ns.agents[CLAUDE].id,
      };
      const before = await bystanderCounts(bystanders);
      // Named explicitly, because "untouched" only means something if there was something to
      // touch: the agent keeps its key and its grant on an app the cascade never names.
      expect(before.agentTokens).toBeGreaterThan(0);
      expect(before.agentGrants).toBeGreaterThan(0);
      await callOp(row, ns);
      expect(await bystanderCounts(bystanders), "the cascade is scoped to its own subject").toEqual(before);
    });

    it("§15 · agent_delete removes the agent row, its grants (FK cascade), and its token rows together", async () => {
      await expectCascade(rows, "agent_delete");
    });

    it("§15 · a app_delete refused at validation leaves every row in place — no partial batch", async () => {
      const row = rowFor(rows, "app_delete");
      const ns = await seedFixture();
      const subject = ns.apps[NEWS].id;
      const before = await cascadeCounts(row, subject);
      await expect(callOp(row, ns, PMCP_SLUG)).rejects.toBeDefined();
      expect(await cascadeCounts(row, subject), "a refused delete deletes nothing").toEqual(before);
    });

    it("§15 · app_delete on a proxied app stops after the batch: no DO, no tokens", async () => {
      const row = rowFor(rows, "app_delete");
      const ns = await seedFixture();
      const proxied = ns.apps[NOTION].id;
      expect(
        await countRows(`SELECT COUNT(*) AS n FROM token WHERE ref_id = ?`, proxied),
        "a proxied app can hold no app token, so there is none to cascade",
      ).toBe(0);
      await ops.app_delete.handler(ns.owner.userId, { slug: NOTION });
      expect(await countRows(`SELECT COUNT(*) AS n FROM app WHERE id = ?`, proxied)).toBe(0);
      expect(await countRows(`SELECT COUNT(*) AS n FROM grant_ WHERE app_id = ?`, proxied)).toBe(0);
      // The DO half as the ledger sees it: a proxied app has no connection to evict, so
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

    it("§8/§22.1 · exactly two ops declare an outputSchema — token_issue and admin_token_issue — and each one's key field carries `writeOnly`", async () => {
      const tools = await listAdminTools();
      expect(tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name)).toEqual(
        rows.filter((r) => r.declaresOutputSchema).map((r) => r.op),
      );
      // registry.writeOnlyPaths is the ONE definition of the mark's path grammar (§7);
      // recomputing it here would be a second one.
      for (const row of rows.filter((r) => r.declaresOutputSchema)) {
        expect(writeOnlyPaths(tools.find((t) => t.name === row.op)?.outputSchema)).toEqual([TOKEN_FIELD]);
      }
    });

    it("§8 · adminBackend.sensitivePaths answers `{ args: [], results: [...] }` for known ops and null for an unknown name", async () => {
      const app = pmcpApp(OWNERLESS);
      for (const row of rows) {
        const paths = await adminBackend.sensitivePaths(app, row.op);
        expect(paths?.args, `${row.op}: no admin tool takes a sensitive argument`).toEqual([]);
        expect(paths?.results, `${row.op}: the only sensitive result is token_issue's key`).toEqual(
          row.declaresOutputSchema ? [TOKEN_FIELD] : [],
        );
      }
      expect(await adminBackend.sensitivePaths(app, "no_such_op")).toBeNull();
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
const APP_TOKEN = "token.app";
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
 * would let `app_delete` decide what `app_archive` finds.
 */
async function seedFixture(): Promise<SeededNamespace> {
  return seedNamespace(env.DB, {
    apps: [
      { slug: NEWS, kind: "tunnel", tokens: [{ as: APP_TOKEN }] },
      { slug: NOTION, kind: "proxy", upstreamUrl: UPSTREAM_URL, upstreamAuthMode: "headers" },
      { slug: LINEAR, kind: "proxy", upstreamUrl: UPSTREAM_URL, upstreamAuthMode: "oauth" },
    ],
    agents: [
      {
        slug: CLAUDE,
        // The built-in `all` in both places, so the fixture accumulates no "role not
        // declared" warnings on its way to existing (§18 decision 10: grantable, never
        // declarable) — and so the delete sweep has a grant on a BYSTANDER app too.
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
 * The field a reserved-slug twin replaces. `grant_set` is the one op whose app slug is
 * not called `slug` — §8 points the reservation at the app, not the agent beside it.
 */
function slugFieldOf(sample: Record<string, unknown>): string {
  return "app" in sample ? "app" : "slug";
}

/**
 * The three `fixture:<handle>` samples resolved against the seeded namespace — row ids no
 * static cell can hold (the table's preamble names the first two; `binding.oauth` is
 * `connection_revoke`'s own, opened the same way `approval.pending` is: through the write
 * seam that actually produces one, rather than an INSERT this file invents).
 */
async function resolveSample(
  sample: Record<string, unknown>,
  ns: SeededNamespace,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = { ...sample };
  for (const [field, value] of Object.entries(resolved)) {
    if (value === "fixture:token.sa") resolved[field] = ns.tokens[SA_TOKEN].id;
    if (value === "fixture:approval.pending") resolved[field] = await openPendingApproval(ns);
    if (value === "fixture:binding.oauth") resolved[field] = await openOauthBinding(ns);
    if (value === "fixture:admin_token.mine") resolved[field] = (await issueAdminToken(ns.owner.userId, undefined)).id;
  }
  return resolved;
}

/**
 * A live `oauth_binding` row, opened through `oauth.upsertBinding` — the same seam
 * `/oauth/consent`'s POST writes through (§19.5) — bound to the fixture's own `claude`
 * agent. `connection_revoke`'s sample calls this once per row it is asked to resolve
 * (§9 rule 2's allow-twin and the reserved-slug sweep alike each seed their own fixture),
 * so every call opens its own binding rather than sharing one across namespaces.
 */
async function openOauthBinding(ns: SeededNamespace, clientId?: string): Promise<string> {
  const bound = await upsertBinding({
    ownerId: ns.owner.userId,
    // A synthesized id by default — the rows that read the `oauthClient` LEFT JOIN's own
    // columns (a client's name, its registered redirect URI, whether it self-registered)
    // pass a REAL registered client id instead, since a synthesized one has no client row
    // and the join hands those back empty.
    clientId: clientId ?? `fixture-oauth-client-${ns.owner.userId}`,
    agentId: ns.agents[CLAUDE].id,
  });
  if (bound === null) throw new Error("openOauthBinding: the fixture agent is not in its own namespace");
  return bound.id;
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
    { kind: "agent", agentId: ns.agents[CLAUDE].id, ownerId: ns.owner.userId, slug: CLAUDE },
    appValue(ns, NEWS),
    "get_news",
    {},
    [],
  );
  if (opened.outcome !== "required") {
    throw new Error(`seeding expected a fresh pending row, got "${opened.outcome}"`);
  }
  return opened.approvalId;
}

/** One seeded app as the cross-module `App` value approvals takes. */
function appValue(ns: SeededNamespace, slug: string): App {
  const seeded = ns.apps[slug];
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

/** `app_list`'s rows, whatever the handler wraps them in. */
function appsOf(listed: unknown): { slug: string }[] {
  return (listed as { apps: { slug: string }[] }).apps;
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
  return row.cascade.includes("agent") ? ns.agents[slug].id : ns.apps[slug].id;
}

/** One count per family the row declares, keyed the way that family references its parent. */
async function cascadeCounts(row: AdminOpRow, subject: string): Promise<Record<string, number>> {
  const parent = row.cascade.includes("agent") ? "agent_id" : "app_id";
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
 * What a cascade must NOT reach: the namespace's OTHER apps, the grants held on one of
 * them, and the agent's own credential. Grants are counted on the bystander app
 * rather than on the agent, because the agent's grant on the deleted app is
 * supposed to go — it rides the FK from the parent the op really did remove (§5).
 */
async function bystanderCounts(ids: { notion: string; linear: string; agent: string }) {
  return {
    notion: await countRows(`SELECT COUNT(*) AS n FROM app WHERE id = ?`, ids.notion),
    linear: await countRows(`SELECT COUNT(*) AS n FROM app WHERE id = ?`, ids.linear),
    agent: await countRows(`SELECT COUNT(*) AS n FROM agent WHERE id = ?`, ids.agent),
    agentGrants: await countRows(
      `SELECT COUNT(*) AS n FROM grant_ WHERE agent_id = ? AND app_id = ?`,
      ids.agent,
      ids.notion,
    ),
    agentTokens: await countRows(`SELECT COUNT(*) AS n FROM token WHERE ref_id = ?`, ids.agent),
  };
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await (env.DB as D1Like).prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── parity direction A's two reads ────────────────────────────────────────────────────

/** An owner id no fixture uses: the parity sweeps read the ops table, never a namespace. */
const OWNERLESS = "parity-reads-no-namespace";

/** The virtual `pmcp` App the gateway hands the backend — only `ownerId` is consulted. */
function pmcpApp(ownerId: string): App {
  return { id: PMCP_SLUG, ownerId, slug: PMCP_SLUG, kind: "tunnel", archived: false, logBodies: true };
}

async function listAdminTools(): Promise<Tool[]> {
  const ctx: BackendCtx = {
    principal: { kind: "user", userId: OWNERLESS, username: "parity" },
    roles: ["all"],
  };
  return adminBackend.listTools(pmcpApp(OWNERLESS), ctx);
}

runAdminOpTable(ADMIN_OP_ROWS);

// ── §19/§8 · connection_list / connection_revoke, beyond the generic table ───────────────

describe("§19/§8 · connections (fronting oauth.ts)", () => {
  it("§8 · connection_list returns the namespace's bindings and never a token, a client secret, or a JWT", async () => {
    const ns = await seedFixture();
    const bindingId = await openOauthBinding(ns);
    const listed = (await ops.connection_list.handler(ns.owner.userId, {})) as {
      connections: { id: string; clientId: string; clientName: string | null; agentSlug: string }[];
    };
    const row = listed.connections.find((connection) => connection.id === bindingId);
    expect(row, "the opened binding is not in its own namespace's listing").toBeDefined();
    expect(row?.agentSlug).toBe(CLAUDE);
    // Never a credential: no pmcp_(agt|app)_ token, no JWT-shaped three-segment string, and
    // no field named "secret" anywhere in the answer (§8: "a connection is a binding, and
    // a binding holds no credential").
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toMatch(tokenPattern(16));
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(serialized.toLowerCase()).not.toContain("secret");
  });

  it("§8 · connection_revoke revokes by id · an id from another namespace is refused (the twin)", async () => {
    const ns = await seedFixture();
    const other = await seedFixture();
    const bindingId = await openOauthBinding(ns);
    await expect(
      ops.connection_revoke.handler(other.owner.userId, { id: bindingId }),
      "a foreign namespace's id must be refused",
    ).rejects.toBeDefined();
    // The twin: the identical id, called by the namespace that actually owns it.
    await expect(
      ops.connection_revoke.handler(ns.owner.userId, { id: bindingId }),
      "the owning namespace's own id must succeed",
    ).resolves.toBeDefined();
  });

  it("§8 · connection_revoke writes an admin.connection_revoke audit row", async () => {
    const ns = await seedFixture();
    const bindingId = await openOauthBinding(ns);
    await ops.connection_revoke.handler(ns.owner.userId, { id: bindingId });
    const written = await adminRows(ns.owner.userId);
    expect(written.map((row) => row.event)).toContain("admin.connection_revoke");
    expect(JSON.stringify(written)).not.toMatch(tokenPattern(16));
  });
});

// ── §22.1/§22.4 · agent_update's partial patch, and the admin_token family's real
// state transitions, beyond the generic table's plumbing checks ──────────────────────
//
// The table above (`agent_update`, `admin_token_issue`, `admin_token_list`,
// `admin_token_revoke` rows) proves each op is wired into the ops table and the audit
// ledger; it does not prove any of the three claims below, because its one sample per
// row and `resolves.toBeDefined()` oracle cannot see them. Here against the same
// `ops.<name>.handler` seam the table uses.

// ── §8 · grant_set's widened entry, at the op seam ────────────────────────────────────
//
// The table's `grant_set` row proves the op is wired and audited with a sample whose only
// entry is the built-in `all`. What it cannot see is the ENTRY GRAMMAR: that an inline item
// survives the proxied undeclared-role hard error and `agent_list` relays it back in the
// spelling `grant_set` takes (§8),
// and that the mode is read off the SUFFIX — which only a resource URI's own colons can
// witness. NOTION is the fixture's proxied app and declares no role at all, so every entry
// below would be a hard error if it were read as a role name.

describe("§8 · grant_set takes an inline item entry, and agent_list relays it", () => {
  /** The grants `agent_list` reports for the fixture's agent, per app slug (§8's inline map). */
  async function grantsOf(ownerId: string): Promise<Record<string, string[]>> {
    const listed = (await ops.agent_list.handler(ownerId, {})) as {
      agents: { slug: string; grants: Record<string, string[]> }[];
    };
    return listed.agents.find((agent) => agent.slug === CLAUDE)!.grants;
  }

  it("§8 · an inline item entry is accepted on a PROXIED app that declares nothing — it carries its own pattern, so it is never undeclared · agent_list relays the string verbatim, suffix and all", async () => {
    const ns = await seedFixture();
    const roles = ["tool/get_news:approval", "prompt/digest_daily", "resource/news://feed/*"];

    const answer = (await ops.grant_set.handler(ns.owner.userId, {
      agent: CLAUDE,
      app: NOTION,
      roles,
    })) as { warnings: string[] };
    expect(answer.warnings, "an item declares itself, so there is nothing to warn about").toEqual([]);

    // Read back through the op the CLI diffs against: the same strings, suffix and all.
    // `grantsFor` orders by the stored entry, so the round trip is a set, not a sequence.
    expect((await grantsOf(ns.owner.userId))[NOTION]).toEqual([...roles].sort());
  });

  it("§8 · `resource/a://b:approval` is approval mode on the item `a://b` — the mode is the SUFFIX, so a URI's own colons stay inside the pattern · twin: the same entry bare is allow", async () => {
    const ns = await seedFixture();

    await ops.grant_set.handler(ns.owner.userId, { agent: CLAUDE, app: NOTION, roles: ["resource/a://b:approval"] });
    // Splitting at the FIRST colon would have stored the role `resource/a` — the round trip
    // through agent_list is what makes the difference between the two readings visible.
    expect((await grantsOf(ns.owner.userId))[NOTION]).toEqual(["resource/a://b:approval"]);

    await ops.grant_set.handler(ns.owner.userId, { agent: CLAUDE, app: NOTION, roles: ["resource/a://b"] });
    expect((await grantsOf(ns.owner.userId))[NOTION]).toEqual(["resource/a://b"]);
  });
});

describe("§22.4 · agent_update is a true partial patch", () => {
  it("§22.4 · updating `name` alone leaves `description` byte-identical, and the converse", async () => {
    const ns = await seedNamespace(env.DB, {
      agents: [{ slug: CLAUDE, name: "Claude", description: "the original note" }],
    });

    const named = (await ops.agent_update.handler(ns.owner.userId, {
      slug: CLAUDE,
      name: "Claude Renamed",
    })) as { agent: { name: string; description: string | undefined } };
    expect(named.agent.name).toBe("Claude Renamed");
    expect(named.agent.description, "an omitted field is left alone, not blanked").toBe("the original note");

    // The converse direction: `description` moves, the name this same call just set holds.
    const described = (await ops.agent_update.handler(ns.owner.userId, {
      slug: CLAUDE,
      description: "a new note",
    })) as { agent: { name: string; description: string | undefined } };
    expect(described.agent.description).toBe("a new note");
    expect(described.agent.name, "the other field's own omission is likewise left alone").toBe("Claude Renamed");
  });
});

describe("§22.1 · admin tokens (fronting identity.ts's admin_token family)", () => {
  /**
   * The request a `pmcp_adm_` bearer arrives on — the same `/<user>/mcp` shape
   * resolveCaller's own consumer surface uses (auth-matrix.test.ts). The reserved
   * invalid host keeps this file's requests as inert as UPSTREAM_URL's.
   */
  function adminBearerRequest(username: string, token: string): Request {
    return new Request(`https://admin-ops.pmcp-test.invalid/${username}/mcp`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("§22.1 · admin_token_revoke ends authentication on the next resolve, not just its own answer: issue, resolve, revoke, fail to resolve", async () => {
    const ns = await seedNamespace(env.DB, {});
    const issued = await issueAdminToken(ns.owner.userId, undefined);

    expect((await resolveCaller(adminBearerRequest(ns.owner.username, issued.token))).principal).toEqual({
      kind: "admin",
      userId: ns.owner.userId,
      username: ns.owner.username,
    });

    await ops.admin_token_revoke.handler(ns.owner.userId, { id: issued.id });

    await expect(
      resolveCaller(adminBearerRequest(ns.owner.username, issued.token)),
      "the revoked token must stop authenticating, not merely echo its id back",
    ).rejects.toMatchObject({ status: 401 });
  });

  it("§22.1 · admin_token_list returns what was issued, by id and prefix, and never a `token` key or the plaintext value issue returned", async () => {
    const ns = await seedNamespace(env.DB, {});
    const first = (await ops.admin_token_issue.handler(ns.owner.userId, {})) as {
      id: string;
      token: string;
      prefix: string;
    };
    const second = (await ops.admin_token_issue.handler(ns.owner.userId, {})) as {
      id: string;
      token: string;
      prefix: string;
    };

    const listed = (await ops.admin_token_list.handler(ns.owner.userId, {})) as {
      tokens: Record<string, unknown>[];
    };

    const byId = new Map(listed.tokens.map((row) => [row.id as string, row]));
    expect(byId.get(first.id)?.prefix, "the first issued token is listed with its own prefix").toBe(first.prefix);
    expect(byId.get(second.id)?.prefix, "the second issued token is listed with its own prefix").toBe(
      second.prefix,
    );

    // The assertion that matters: no row carries a `token` key, a `hash` key, or either
    // plaintext value issue returned — this fails the moment anyone widens the SELECT.
    for (const row of listed.tokens) {
      expect(row).not.toHaveProperty("token");
      expect(row).not.toHaveProperty("hash");
    }
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(first.token);
    expect(serialized).not.toContain(second.token);
  });
});

// ── §8 · audit_query's filters, each proven to narrow ─────────────────────────────────
//
// The ops table above calls `audit_query` with `{}` — enough to prove the op is a read
// that writes no `admin.*` row, and blind to every filter it declares. §8 gives the tool
// nine parameters and audit.whereClause turns each into one AND-ed clause; a clause
// dropped, or bound to the wrong column, is invisible to a sample that never passes one:
// the op still answers `{ rows, total }` and the row set is merely WIDER than it should
// be. Widening is the failure mode that matters — `pmcp audit --agent claude` and the
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
// Not here: `app`/`event`/`tool`/`session`, which the /audit filter walk already
// passes values for (web-pages.test.ts), and `limit`/`offset`, whose defaults §8 pins and
// whose paging the same page's cases drive.

/** The op's answer, in the shape §8 pins — `{ rows, total }`, newest first. */
type AuditPage = { rows: AuditRow[]; total: number };

/** One read through the ops seam, exactly as an MCP `tools/call` on `pmcp` reaches it. */
async function auditQuery(ns: SeededNamespace, filters: Record<string, unknown>): Promise<AuditPage> {
  return (await ops.audit_query.handler(ns.owner.userId, filters)) as AuditPage;
}

/**
 * The two agent principals this block writes under. Spelled as §8's `agent:<slug>` form, the
 * same string `pmcp audit --agent claude` resolves to, so a case that passed a bare slug
 * would be testing a spelling no caller uses.
 */
const AGENT = `agent:${CLAUDE}`;
const OTHER_AGENT = "agent:scratch-agent";

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
      app: NEWS,
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
    expect(await auditQuery(ns, { principal: "agent:FAKE0000-never-acted" })).toEqual({ rows: [], total: 0 });
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

// D15 (2026-09-02) — rows landed as it.todo from docs/superpowers/plans/2026-09-02-d15-panes.md;
// each row's mechanics are on its `asserts:` line there.

/** What one refused call left behind, reduced to what must be uniform across a sweep.
 *  Local because `refusalOf` above takes an `AdminOpRow` and always substitutes `pmcp`.
 *  Takes the caller's namespace rather than seeding its own: the sweep counts audit rows
 *  for ONE owner, and `audit.query` is owner-scoped, so a per-call namespace would make
 *  "nothing summarised" true by construction. Every call here is a refusal, so sharing
 *  one namespace across the sweep leaves nothing behind to collide. */
async function refusalOfSlug(
  ns: SeededNamespace,
  slug: string,
): Promise<{ name: string; code: unknown; message: string }> {
  try {
    await ops.app_create.handler(ns.owner.userId, { slug, kind: "tunnel" });
  } catch (thrown) {
    const error = thrown as { code?: unknown; message?: string };
    return { name: (error as Error).constructor.name, code: error.code, message: String(error.message) };
  }
  throw new Error(`app_create accepted the reserved slug "${slug}"`);
}

/**
 * Register one OAuth client through the provider's OWN endpoint (§19.3), the only way a
 * real `oauthClient` row exists — never planted by hand. With a session cookie the provider
 * stamps the registering user on the row (a pre-registered client); without one it is
 * anonymous DCR. The composition root is imported DYNAMICALLY, the dodge
 * `seed.seedOwnerSession` uses, so this file's top-level deps do not grow.
 */
async function registerClient(fields: Record<string, unknown>, cookie?: string): Promise<string> {
  const { default: worker } = await import("../../src/index");
  const origin = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
      body: JSON.stringify({
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...fields,
      }),
    }),
    env as never,
  );
  if (response.status !== 201) {
    throw new Error(`registerClient: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { client_id: string }).client_id;
}

/** `connection_list`'s answer, in the shape §8's amended row carries. */
type ListedConnection = {
  id: string;
  clientId: string;
  clientName: string | null;
  agentSlug: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  redirectOrigin: string;
  selfRegistered: boolean;
};

async function connectionsOf(ownerId: string): Promise<ListedConnection[]> {
  const listed = (await ops.connection_list.handler(ownerId, {})) as { connections: ListedConnection[] };
  return listed.connections;
}

describe(`§8/§13 · the ops behind the Access panes, and the reserved app slugs`, () => {
  it(`§8 · app_create refuses every RESERVED_APP_SLUGS member the way it refuses pmcp — the same refusal class and code, one sentence across the reserved set modulo the slug, each naming the slug it refused — and writes no admin.app_create row for any of them · a non-reserved slug of the same charset creates (the twin)`, async () => {
    // An empty export would make every sweep below pass by asserting nothing, and `pmcp` is
    // the OTHER reservation — the ops table's own sweep covers it across every slug-taking op.
    expect(RESERVED_APP_SLUGS.size).toBeGreaterThan(0);
    expect(RESERVED_APP_SLUGS.has(PMCP_SLUG)).toBe(false);

    const ns = await seedFixture();
    const before = (await query(env.DB, ns.owner.userId, { event: "admin.app_create" })).total;
    const builtin = await refusalOfSlug(ns, PMCP_SLUG);
    const refusals = new Map<string, { name: string; code: unknown; message: string }>();
    for (const slug of RESERVED_APP_SLUGS) refusals.set(slug, await refusalOfSlug(ns, slug));

    // What "the same way" means: the same error CLASS and `code`, each message naming the
    // slug it refused, and — distinguishable from an op that simply cannot find things —
    // never the sentence an unknown slug earns.
    const missing = await ops.app_get
      .handler(ns.owner.userId, { slug: uniqueSlug("ghost") })
      .then(() => null)
      .catch((thrown: Error) => thrown.message);
    for (const [slug, refusal] of refusals) {
      expect(refusal.name, slug).toBe(builtin.name);
      expect(refusal.code, slug).toBe(builtin.code);
      expect(refusal.message, slug).toContain(slug);
      expect(refusal.message, slug).not.toEqual(missing);
    }
    // ONE SENTENCE across the reserved set, modulo the slug — a per-segment bespoke message
    // fails here. `pmcp`'s own sentence is deliberately NOT in this set: §8's reason for
    // these is "because `/apps/<slug>` is a page", which is not the builtin's reason.
    const shapes = new Set([...refusals].map(([slug, refusal]) => refusal.message.split(slug).join("<slug>")));
    expect(shapes.size, [...shapes].join(" | ")).toBe(1);
    // NOTHING SUMMARISED: a refused create is not a create (§8).
    expect((await query(env.DB, ns.owner.userId, { event: "admin.app_create" })).total).toBe(before);

    // THE TWIN, from the same charset: reservation is by name, not by shape.
    const allowed = uniqueSlug("app");
    expect(SLUG_CHARSET.test(allowed)).toBe(true);
    await expect(ops.app_create.handler(ns.owner.userId, { slug: allowed, kind: "tunnel" })).resolves.toBeDefined();
    await expect(ops.app_get.handler(ns.owner.userId, { slug: allowed })).resolves.toBeDefined();
  });

  it(`§8 · connection_list's rows carry the two identity strings §19.5's consent screen shows — the origin of the client's registered redirect URI, and whether it self-registered · a client registered under the owner's session reports selfRegistered false (the twin) — and still no token, client secret or JWT`, async () => {
    const ns = await seedFixture();
    const { cookie } = await seedOwnerSession(ns.owner);
    // Each host has at most TWO dot-separated labels: three would satisfy this file's own
    // three-segment JWT-shape sweep below and turn a hygiene guard into a false red.
    const dcrUri = "https://c1.example/callback";
    const ownUri = "https://c2.example/callback";
    const dcrClient = await registerClient({ client_name: "Self-registered", redirect_uris: [dcrUri] });
    const ownClient = await registerClient({ client_name: "Pre-registered", redirect_uris: [ownUri] }, cookie);
    const dcrBinding = await openOauthBinding(ns, dcrClient);
    const ownBinding = await openOauthBinding(ns, ownClient);

    const rows = await connectionsOf(ns.owner.userId);
    const dcr = rows.find((row) => row.id === dcrBinding);
    const own = rows.find((row) => row.id === ownBinding);
    expect(dcr, "the DCR client's binding is missing from its own namespace's listing").toBeDefined();
    expect(own, "the pre-registered client's binding is missing").toBeDefined();
    // §19.3's one-bit test, now on the op: nobody was signed in to vouch for the DCR client.
    expect(dcr?.selfRegistered).toBe(true);
    expect(own?.selfRegistered).toBe(false);
    // The ORIGIN of the client's own registered redirect URI — a strict prefix of it, so
    // only the inequality carries the claim that the full URI is not what is shown.
    expect(dcr?.redirectOrigin).toBe(new URL(dcrUri).origin);
    expect(own?.redirectOrigin).toBe(new URL(ownUri).origin);
    expect(dcr?.redirectOrigin).not.toBe(dcrUri);
    expect(own?.redirectOrigin).not.toBe(ownUri);
    // The amendment ADDS; it does not replace.
    for (const row of [dcr, own]) {
      for (const field of ["id", "clientId", "clientName", "agentSlug", "createdAt", "lastUsedAt"] as const) {
        expect(row, field).toHaveProperty(field);
      }
    }
    expect(dcr?.clientName).toBe("Self-registered");
    // Still no credential anywhere in the answer (§8).
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(tokenPattern(16));
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(serialized.toLowerCase()).not.toContain("secret");
  });

  it(`§8/§13 · connection_list reports a revoked binding with its revokedAt set instead of dropping it · the live binding beside it reports null (the twin) — the Connected clients pane has no second read path, so a row the op omits is a row §13's listing cannot keep`, async () => {
    const ns = await seedFixture();
    const revokedId = await openOauthBinding(ns, `fixture-revoked-${ns.owner.userId}`);
    const liveId = await openOauthBinding(ns, `fixture-live-${ns.owner.userId}`);
    await ops.connection_revoke.handler(ns.owner.userId, { id: revokedId });

    const rows = await connectionsOf(ns.owner.userId);
    // "Still listed" as a listing that never filtered, not one that grew back: exactly the
    // two this namespace opened.
    expect(rows.map((row) => row.id).sort()).toEqual([revokedId, liveId].sort());
    const revoked = rows.find((row) => row.id === revokedId);
    const live = rows.find((row) => row.id === liveId);
    expect(typeof revoked?.revokedAt).toBe("number");
    // The twin, and the reason an op that stamped everything cannot satisfy this.
    expect(live?.revokedAt).toBeNull();
  });

  it(`§8/§13 · token_list, token_revoke, connection_list and connection_revoke still answer a CLI credential on the pmcp surface after their panes move behind /settings — the gate is a prefix rule, not the tools being hidden from the CLI (the counter-twin of the /settings gate rows)`, async () => {
    const ns = await seedFixture();
    const bindingId = await openOauthBinding(ns);
    const ownerId = ns.owner.userId;

    // The failure this row forecloses first: the four ops still EXIST but stop being listed
    // to the CLI once their panes move behind /settings. Handler calls alone are blind to it.
    expect((await listAdminTools()).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["token_list", "token_revoke", "connection_list", "connection_revoke"]),
    );
    // Each op called the way the `pmcp` surface calls it — the owner principal a CLI
    // device-flow session resolves to, through the same handler path every other row uses.
    const listed = (await ops.token_list.handler(ownerId, {})) as { tokens: { id: string }[] };
    expect(listed.tokens.map((token) => token.id)).toContain(ns.tokens[APP_TOKEN].id);
    expect((await connectionsOf(ownerId)).map((row) => row.id)).toContain(bindingId);
    // …and the two mutating ones really mutate, so "answers" is not "answers with nothing".
    await expect(ops.token_revoke.handler(ownerId, { id: ns.tokens[APP_TOKEN].id })).resolves.toBeDefined();
    await expect(ops.connection_revoke.handler(ownerId, { id: bindingId })).resolves.toBeDefined();
    const after = (await ops.token_list.handler(ownerId, {})) as { tokens: { id: string; revokedAt: number | null }[] };
    expect(after.tokens.find((token) => token.id === ns.tokens[APP_TOKEN].id)?.revokedAt).toEqual(expect.any(Number));
    expect((await connectionsOf(ownerId)).find((row) => row.id === bindingId)?.revokedAt).toEqual(expect.any(Number));
  });
});

/**
 * One refused call as an in-process caller sees it — the code, the message, the
 * `violations` list the error object carries (§8) and whatever `data` it would put on the
 * wire (§7: nothing, for a -32602). Throws when the call succeeded, so a row can never go
 * green because nothing was refused at all. Deliberately not `refusalOfSlug`: that one
 * always calls `app_create` with a tunneled draft and reads no list.
 */
async function wireRefusalOf(work: () => Promise<unknown>): Promise<{
  code: unknown;
  message: string;
  violations: { field: string; reason: string }[] | undefined;
  data: unknown;
}> {
  try {
    await work();
  } catch (thrown) {
    const error = thrown as { code?: unknown; message?: string; violations?: unknown; data?: unknown };
    return {
      code: error.code,
      message: String(error.message),
      violations: error.violations as { field: string; reason: string }[] | undefined,
      data: error.data,
    };
  }
  throw new Error("the op accepted what this row expects it to refuse");
}

describe("§8 · a refused app_create or app_update reports every violation at once", () => {
  it("the -32602 refusal carries each violation as { field, reason } in the op's own field names on the error object — slug and endpoint together for a reserved-route slug with a plain-http endpoint — its message joins the same sentences with \"; \", and the wire gets no data (§7: -32003's alone) · one violation is a one-entry list and the same message (the twin); nothing is created or updated on a refusal (retitled 2026-09-03: the list left `data` for §7's wire rule)", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const before = ((await ops.app_list.handler(ownerId, {})) as { apps: { slug: string }[] }).apps.map(
      (app) => app.slug,
    );

    // TWO AT ONCE, and neither is the other's consequence: `new` is a page the router
    // already mounts, and the endpoint is plain http to a remote host. A first-violation
    // refusal reports one of these and leaves the owner to discover the second.
    const reserved = [...RESERVED_APP_SLUGS][0];
    const both = await wireRefusalOf(() =>
      ops.app_create.handler(ownerId, {
        slug: reserved,
        kind: "proxy",
        endpoint: "http://mcp.example.com/mcp",
      }),
    );
    expect(both.code).toBe(CODES.invalidParams);
    expect(both.violations).toEqual([
      { field: "slug", reason: `the slug "${reserved}" is reserved: /apps/${reserved} is a page` },
      { field: "endpoint", reason: `"endpoint" must be an https:// URL (http:// only for localhost)` },
    ]);
    // The message is the same sentences and nothing else — `pmcp` prints it, so it may not
    // become prose the list does not contain (§8).
    expect(both.message).toBe((both.violations ?? []).map((violation) => violation.reason).join("; "));
    // And the list never reaches the wire: `data` is -32003's alone (§7), so the mapping
    // that serializes code, message and data has nothing extra to send here.
    expect(both.data, "a -32602 carries no data on the wire").toBeUndefined();

    // THE TWIN: one violation is a one-entry list carrying that same one sentence, so a
    // single refusal reads exactly as it did before the list existed.
    const one = await wireRefusalOf(() =>
      ops.app_create.handler(ownerId, {
        slug: uniqueSlug("app"),
        kind: "proxy",
        endpoint: "mcp.example.com",
      }),
    );
    expect(one.code).toBe(CODES.invalidParams);
    expect(one.violations).toEqual([
      { field: "endpoint", reason: `"endpoint" must be an https:// URL (http:// only for localhost)` },
    ]);
    expect(one.message).toBe(`"endpoint" must be an https:// URL (http:// only for localhost)`);

    // app_update refuses through the same list, and the app it refused is untouched.
    const updated = await wireRefusalOf(() =>
      ops.app_update.handler(ownerId, { slug: NOTION, endpoint: "http://mcp.example.com/mcp" }),
    );
    expect(updated.code).toBe(CODES.invalidParams);
    expect(updated.violations).toEqual([
      { field: "endpoint", reason: `"endpoint" must be an https:// URL (http:// only for localhost)` },
    ]);
    const stored = (await ops.app_get.handler(ownerId, { slug: NOTION })) as { app: { endpoint: string } };
    expect(stored.app.endpoint).toBe(UPSTREAM_URL);

    // NOTHING CREATED: a refused create is not a create (§8), whichever half refused it.
    const after = ((await ops.app_list.handler(ownerId, {})) as { apps: { slug: string }[] }).apps.map(
      (app) => app.slug,
    );
    expect(after).toEqual(before);
  });
});

// D16 (2026-09-17) — rows landed as it.todo from
// docs/superpowers/plans/2026-09-17-app-three-pane.md §1 (owner-defined roles).

describe("§8/§20.3 · owner_roles — the owner's own roles on a tunneled app", () => {
  it("§8 · `app_create` and `app_update` take `owner_roles` on a TUNNELED app, validated exactly like `roles`, and `app_get` / `app_list` report it back as `ownerRoles` on the tunnel row in §20.3's canonical read shape · twin: the proxied and builtin rows carry no `ownerRoles` key at all, and the tunnel row's `roles` (the app's own declaration) is untouched by the write", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;

    const created = uniqueSlug("owned");
    await ops.app_create.handler(ownerId, {
      slug: created,
      kind: "tunnel",
      owner_roles: { mine: ["get_.*"] },
    });
    expect(await ownerRolesOf(ownerId, created)).toEqual({ mine: ["get_.*"] });

    // …and on update, in the per-family spelling — read back CANONICAL (§20.3), so a
    // tools-only role comes home as the bare list whichever way it was written.
    await ops.app_update.handler(ownerId, {
      slug: NEWS,
      owner_roles: { mine: { tools: ["get_.*"] }, spanning: { prompts: ["draft_.*"] } },
    });
    expect(await ownerRolesOf(ownerId, NEWS)).toEqual({
      mine: ["get_.*"],
      spanning: { prompts: ["draft_.*"] },
    });
    // The APP's own declaration is a different column and this write did not touch it.
    expect(((await ops.app_get.handler(ownerId, { slug: NEWS })) as { app: { roles: unknown } }).app.roles).toEqual({});

    // THE TWIN: the key is the TUNNEL variant's. A proxied row and the builtin carry none.
    const listed = ((await ops.app_list.handler(ownerId, {})) as { apps: Record<string, unknown>[] }).apps;
    const row = (slug: string) => listed.find((app) => app.slug === slug) ?? {};
    expect(Object.keys(row(NEWS))).toContain("ownerRoles");
    expect(Object.keys(row(NOTION))).not.toContain("ownerRoles");
    expect(Object.keys(row(PMCP_SLUG))).not.toContain("ownerRoles");
  });

  it("§8 · `owner_roles` on a PROXIED app is refused by both `app_create` and `app_update` with the one violation `owner_roles is for tunneled apps — a proxied app's roles are \"roles\"`, at -32602, and nothing is created or updated · twin: the same declaration sent as `roles` on that same proxied app is accepted, which is what makes the refusal about the FIELD and not about the declaration", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const violation = {
      field: "owner_roles",
      reason: `owner_roles is for tunneled apps — a proxied app's roles are "roles"`,
    };
    const before = ((await ops.app_list.handler(ownerId, {})) as { apps: { slug: string }[] }).apps.map(
      (app) => app.slug,
    );

    const refusedSlug = uniqueSlug("proxied");
    const created = await wireRefusalOf(() =>
      ops.app_create.handler(ownerId, {
        slug: refusedSlug,
        kind: "proxy",
        endpoint: UPSTREAM_URL,
        owner_roles: { mine: ["search"] },
      }),
    );
    expect(created.code).toBe(CODES.invalidParams);
    expect(created.violations).toEqual([violation]);
    expect(created.message).toBe(violation.reason);

    const updated = await wireRefusalOf(() =>
      ops.app_update.handler(ownerId, { slug: NOTION, owner_roles: { mine: ["search"] } }),
    );
    expect(updated.code).toBe(CODES.invalidParams);
    expect(updated.violations).toEqual([violation]);

    // Nothing created, nothing updated — a refused write is not a write (§8).
    const after = ((await ops.app_list.handler(ownerId, {})) as { apps: { slug: string }[] }).apps.map(
      (app) => app.slug,
    );
    expect(after).toEqual(before);
    expect(((await ops.app_get.handler(ownerId, { slug: NOTION })) as { app: { roles: unknown } }).app.roles).toEqual({});

    // THE TWIN: the very same declaration under `roles` is the proxied app's OWN way of
    // saying it, and it is accepted — so the refusal is about the field, not the value.
    await ops.app_update.handler(ownerId, { slug: NOTION, roles: { mine: ["search"] } });
    expect(((await ops.app_get.handler(ownerId, { slug: NOTION })) as { app: { roles: unknown } }).app.roles).toEqual({
      mine: ["search"],
    });
  });

  it("§8/§20.3 · `owner_roles` gets `roles`' own `validateRoles` — the reserved name `all`, a role name outside `[a-z0-9_-]`, an uncompilable pattern and an unknown family key are each a violation naming `owner_roles` as its field, reported with every other violation of the same call · twin: a legal per-family declaration at the caps stores and reads back", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const refusals = [
      { all: ["search"] },
      { ["Reader"]: ["search"] },
      { mine: ["get_(.*"] },
      { mine: { tolls: ["x"] } },
    ];
    for (const owner_roles of refusals) {
      const refused = await wireRefusalOf(() => ops.app_update.handler(ownerId, { slug: NEWS, owner_roles }));
      const label = JSON.stringify(owner_roles);
      expect(refused.code, label).toBe(CODES.invalidParams);
      // The field is the one the owner typed — `roles` would send them to the wrong block.
      expect((refused.violations ?? []).map((violation) => violation.field), label).toEqual(["owner_roles"]);
      expect(await ownerRolesOf(ownerId, NEWS), label).toEqual({});
    }

    // THE TWIN: the same validator's accept side, in the per-family spelling and at the
    // pattern cap — so a validator that refused everything cannot pass this row.
    await ops.app_update.handler(ownerId, {
      slug: NEWS,
      owner_roles: { spanning: { tools: ["a".repeat(128)], prompts: ["draft_.*"], resources: ["news://.*"] } },
    });
    expect(await ownerRolesOf(ownerId, NEWS)).toEqual({
      spanning: { tools: ["a".repeat(128)], prompts: ["draft_.*"], resources: ["news://.*"] },
    });
  });

  it("§20.3 · an owner role IS declared for the undeclared check: `grant_set` naming a role only `owner_roles` defines on a tunneled app returns NO warning, and `resolveAccess` for that agent allows the tools the owner's patterns name · twin: a name in neither map still warns and still matches nothing", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    await ops.app_update.handler(ownerId, { slug: NEWS, owner_roles: { mine: ["get_.*"] } });

    const granted = (await ops.grant_set.handler(ownerId, {
      agent: CLAUDE,
      app: NEWS,
      roles: ["mine"],
    })) as { warnings: string[] };
    expect(granted.warnings).toEqual([]);

    // The door's own answer, against real D1: the owner's patterns bite.
    const door = await doorFor(ns, NEWS);
    expect(door.check("get_news", "tools")).toBe("allow");
    expect(door.check("set_config", "tools")).toBe("deny");

    // THE TWIN: a name in NEITHER map is still undeclared — the tunneled warning survives,
    // so "an owner role is declared" has not become "every name is declared".
    const stranger = (await ops.grant_set.handler(ownerId, {
      agent: CLAUDE,
      app: NEWS,
      roles: ["nobodys"],
    })) as { warnings: string[] };
    expect(stranger.warnings.length).toBe(1);
    expect(stranger.warnings[0]).toContain("nobodys");
    expect((await doorFor(ns, NEWS)).check("get_news", "tools")).toBe("deny");
  });

  it("§20.3 · the app's declaration wins at the door: with the same role name in both maps, `resolveAccess` answers the APP's patterns — the owner's shadowed definition allows nothing — and a reconnect's `upsertDeclaredRoles` rewrites `roles_json` alone, so the owner's map survives it byte for byte · twin: an owner role the app does not declare keeps resolving across that same reconnect", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const registry = new Registry(env.DB);
    await ops.app_update.handler(ownerId, {
      slug: NEWS,
      owner_roles: { reader: ["owner_tool"], mine: ["get_.*"] },
    });
    await ops.grant_set.handler(ownerId, { agent: CLAUDE, app: NEWS, roles: ["reader", "mine"] });

    // Before the connect: the owner's `reader` is the only one there is.
    expect((await doorFor(ns, NEWS)).check("owner_tool", "tools")).toBe("allow");

    // The app connects and declares the same NAME — the registration path, untouched by
    // this dispatch: it replaces roles_json and nothing else.
    await registry.upsertDeclaredRoles(ns.apps[NEWS].id, { reader: ["app_tool"] });

    const after = await doorFor(ns, NEWS);
    expect(after.check("app_tool", "tools")).toBe("allow");
    // The shadowed definition is gone at the door — replaced, never unioned.
    expect(after.check("owner_tool", "tools")).toBe("deny");
    // …but it is still STORED: the owner's map is the owner's, and a reconnect is not a
    // write to it. Re-reading it is how the Roles pane draws `app · replaced yours`.
    expect(await ownerRolesOf(ownerId, NEWS)).toEqual({ reader: ["owner_tool"], mine: ["get_.*"] });
    // THE TWIN: the owner role the app did NOT declare still resolves after the reconnect.
    expect(after.check("get_news", "tools")).toBe("allow");
  });
});

/** §20.3's owner map as the read ops report it — one spelling for every row above. */
async function ownerRolesOf(ownerId: string, slug: string): Promise<unknown> {
  const { app } = (await ops.app_get.handler(ownerId, { slug })) as { app: { ownerRoles?: unknown } };
  return app.ownerRoles;
}

/** The door the seeded agent gets on one app, asked the way the gateway asks it — real
 *  grants, real columns, the merge inside `resolveAccess` and never re-spelled here. */
async function doorFor(ns: SeededNamespace, slug: string): Promise<ToolFilter> {
  const registry = new Registry(env.DB);
  const app = ns.apps[slug];
  return registry.resolveAccess(
    { kind: "agent", agentId: ns.agents[CLAUDE].id, ownerId: ns.owner.userId, slug: CLAUDE },
    (await registry.appById(app.id))!,
  );
}

describe("§23.3/§23.6 · execution settings and hub-local names through the ops", () => {
  it("§23.3 · hub_settings_get answers the pinned default pair, hub_settings_update stores and returns that same shape, and ONE admin row names the pair — never a per-column write", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;

    expect(await ops.hub_settings_get.handler(ownerId, {})).toEqual({
      settings: { defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000 },
    });

    const updated = await ops.hub_settings_update.handler(ownerId, {
      default_timeout_ms: 5_000,
      max_timeout_ms: 60_000,
    });
    expect(updated).toEqual({ settings: { defaultTimeoutMs: 5_000, maxTimeoutMs: 60_000 } });
    // The read answers what the write returned: one upserted pair, not two half-updates.
    expect(await ops.hub_settings_get.handler(ownerId, {})).toEqual(updated);

    const rows = await adminRows(ownerId);
    expect(rows.map((row) => row.event)).toEqual(["admin.hub_settings_update"]);
    // The pair is the change this row summarises — and it is configuration, never a secret.
    expect(rows[0].detail).toEqual({ defaultTimeoutMs: 5_000, maxTimeoutMs: 60_000 });
  });

  it("§23.3 · a pair below the floor, above the ceiling, or inverted is refused as -32602 naming the field and stores nothing · twin: the inclusive boundary pair 1_000/300_000 stores", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;

    // The floor and ceiling are the ADVERTISED bounds (render and coerce share one
    // declaration); the ordering is registry's cross-field rule. Each refusal names the
    // op's own field.
    const floor = await wireRefusalOf(() =>
      ops.hub_settings_update.handler(ownerId, { default_timeout_ms: 999, max_timeout_ms: 30_000 }),
    );
    expect(floor.code).toBe(CODES.invalidParams);
    expect(floor.violations?.map((violation) => violation.field)).toEqual(["default_timeout_ms"]);

    const ceiling = await wireRefusalOf(() =>
      ops.hub_settings_update.handler(ownerId, { default_timeout_ms: 30_000, max_timeout_ms: 300_001 }),
    );
    expect(ceiling.violations?.map((violation) => violation.field)).toEqual(["max_timeout_ms"]);

    const inverted = await wireRefusalOf(() =>
      ops.hub_settings_update.handler(ownerId, { default_timeout_ms: 31_000, max_timeout_ms: 30_000 }),
    );
    expect(inverted.violations?.map((violation) => violation.field)).toEqual(["default_timeout_ms"]);

    // Nothing was stored, and a refused write summarises nothing (§8).
    expect(await ops.hub_settings_get.handler(ownerId, {})).toEqual({
      settings: { defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000 },
    });
    expect(await adminRows(ownerId)).toEqual([]);

    // THE TWIN, at the boundary: the range is inclusive on both ends.
    await expect(
      ops.hub_settings_update.handler(ownerId, { default_timeout_ms: 1_000, max_timeout_ms: 300_000 }),
    ).resolves.toEqual({ settings: { defaultTimeoutMs: 1_000, maxTimeoutMs: 300_000 } });
  });

  it("§8/§23.1 · every slug-taking op refuses `hub` exactly as it refuses `pmcp` — same class and code, one sentence naming the slug it refused — and a refused mutation summarises nothing · twin: a slug one edit away creates and reads back", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const before = (await query(env.DB, ownerId, {})).total;

    const refusals: { op: string; code: unknown; message: string }[] = [];
    for (const row of ADMIN_OP_ROWS.filter((candidate) => candidate.slugArg === "app")) {
      const input = await resolveSample(row.sample, ns);
      input[slugFieldOf(row.sample)] = HUB_SLUG;
      const refusal = await wireRefusalOf(() => ops[row.op].handler(ownerId, input));
      refusals.push({ op: row.op, code: refusal.code, message: refusal.message });
    }
    expect(refusals.length, "no app-slug op in the table — the sweep would assert nothing").toBeGreaterThan(0);
    for (const refusal of refusals) {
      expect(refusal.code, refusal.op).toBe(CODES.invalidParams);
      expect(refusal.message, refusal.op).toContain(HUB_SLUG);
    }
    // ONE sentence modulo the slug: the reservation is a property of the table, not of any
    // op — `app_create` collects it and every other op throws it, and both spell the same
    // words (§8).
    const shapes = new Set(refusals.map((refusal) => refusal.message.split(HUB_SLUG).join("<slug>")));
    expect(shapes.size, [...shapes].join(" | ")).toBe(1);
    // NOTHING SUMMARISED and nothing stored: `hub` is virtual in both directions.
    expect((await query(env.DB, ownerId, {})).total).toBe(before);
    await expect(ops.app_get.handler(ownerId, { slug: HUB_SLUG })).rejects.toBeDefined();

    // THE TWIN, one edit away: reservation is by exact name, not by shape.
    const allowed = `${HUB_SLUG}-tools`;
    await expect(ops.app_create.handler(ownerId, { slug: allowed, kind: "tunnel" })).resolves.toBeDefined();
    await expect(ops.app_get.handler(ownerId, { slug: allowed })).resolves.toBeDefined();
  });

  it("§23.6 · `typescript_aliases` rides app_create and app_update into the row, and app_get reports owner configuration, committed reservations and diagnostics as three separate facts — a colliding alias is refused whole at -32602 in the op's field · twin: a free alias stores", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;
    const owned = { service: "typedFeed", tools: { get_news: "news" } };

    const created = (await ops.app_create.handler(ownerId, {
      slug: "typed",
      kind: "tunnel",
      typescript_aliases: owned,
    })) as { app: { typescriptAliases: unknown; typescriptReservations: unknown[]; typescriptDiagnostics: unknown[] } };
    expect(created.app.typescriptAliases).toEqual(owned);

    const read = (await ops.app_get.handler(ownerId, { slug: "typed" })) as {
      app: { typescriptAliases: unknown; typescriptReservations: unknown[]; typescriptDiagnostics: unknown[] };
    };
    expect(read.app.typescriptAliases).toEqual(owned);
    expect(read.app.typescriptReservations).toEqual([
      { appId: expect.any(String), family: "service", canonicalName: "typed", typescriptName: "typedFeed", source: "owner", active: true },
      { appId: expect.any(String), family: "tool", canonicalName: "get_news", typescriptName: "news", source: "owner", active: true },
    ]);
    // The architecture is non-leaking BY CONSTRUCTION here: the two reservations are this
    // app's own members, so no contender is named in its diagnostics.
    expect(read.app.typescriptDiagnostics).toEqual([]);

    // A second app, created free, then colliding: the update is refused WHOLE — -32602,
    // field `typescript_aliases`, no row change — because the owner can see the namespace.
    await ops.app_create.handler(ownerId, { slug: "other", kind: "tunnel" });
    const collided = await wireRefusalOf(() =>
      ops.app_update.handler(ownerId, { slug: "other", typescript_aliases: { service: "typedFeed" } }),
    );
    expect(collided.code).toBe(CODES.invalidParams);
    expect(collided.violations?.map((violation) => violation.field)).toEqual(["typescript_aliases"]);
    expect(collided.message).toContain("typedFeed");
    const unchanged = (await ops.app_get.handler(ownerId, { slug: "other" })) as {
      app: { typescriptAliases: unknown };
    };
    expect(unchanged.app.typescriptAliases).toEqual({});

    // The colliding CREATE refuses identically, and stores nothing at all — no app row.
    const refusedCreate = await wireRefusalOf(() =>
      ops.app_create.handler(ownerId, { slug: "third", kind: "tunnel", typescript_aliases: { service: "typedFeed" } }),
    );
    expect(refusedCreate.violations?.map((violation) => violation.field)).toEqual(["typescript_aliases"]);
    await expect(ops.app_get.handler(ownerId, { slug: "third" })).rejects.toBeDefined();

    // A syntax mistake takes the same field and code, before anything is written.
    const malformed = await wireRefusalOf(() =>
      ops.app_update.handler(ownerId, { slug: "other", typescript_aliases: { service: "not an identifier" } }),
    );
    expect(malformed.violations?.map((violation) => violation.field)).toEqual(["typescript_aliases"]);

    // THE TWIN: a free alias stores on the neighbour, and the first app's mapping is
    // untouched by a write that was never about it.
    await expect(
      ops.app_update.handler(ownerId, { slug: "other", typescript_aliases: { service: "otherFeed" } }),
    ).resolves.toBeDefined();
    const after = (await ops.app_get.handler(ownerId, { slug: "typed" })) as { app: { typescriptReservations: unknown[] } };
    expect(after.app.typescriptReservations).toEqual(read.app.typescriptReservations);
  });

  it("§23.6 · app_delete tombstones the app's names in its one batch: a recreated slug gets a new app id and cannot claim the deleted member's owner alias, while its own generated candidate is allocated fresh", async () => {
    const ns = await seedFixture();
    const ownerId = ns.owner.userId;

    await ops.app_create.handler(ownerId, {
      slug: "reborn",
      kind: "tunnel",
      typescript_aliases: { service: "rebornAlias" },
    });
    await ops.app_delete.handler(ownerId, { slug: "reborn" });

    const recreated = (await ops.app_create.handler(ownerId, { slug: "reborn", kind: "tunnel" })) as {
      app: { typescriptReservations: unknown[] };
    };
    // Nothing is inherited: the newcomer's generated candidate is a name the deleted member
    // never held, and the old path stays a tombstone it cannot revive.
    expect(recreated.app.typescriptReservations).toEqual([
      { appId: expect.any(String), family: "service", canonicalName: "reborn", typescriptName: "reborn", source: "generated", active: true },
    ]);

    const refused = await wireRefusalOf(() =>
      ops.app_update.handler(ownerId, { slug: "reborn", typescript_aliases: { service: "rebornAlias" } }),
    );
    expect(refused.code).toBe(CODES.invalidParams);
    expect(refused.message).toContain("rebornAlias");
  });
});
