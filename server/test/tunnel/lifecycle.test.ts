/**
 * tunnel/lifecycle.test.ts — the owner-driven half of §6: who may open a socket, what
 * closes one, and what D1 already shows at the instant the client sees the close frame.
 *
 * WHAT THIS SUITE PINS. The upgrade response matrix as a table — 401 for every
 * credential failure (fatal to the client), 403 for exactly one thing, archival (retry
 * at max backoff, so unarchiving heals untouched), 101 otherwise; the sever vocabulary
 * as a table — CLOSE_REVOKED for token revocation and deletion, CLOSE_ARCHIVED for
 * archival, `onlyIfTokenId` making a revoke close only the socket that token opened
 * (§8); the §15 ORDERING pins observed live rather than reasoned about — at the moment
 * a client sees 4001 the D1 rows are already gone, and at the moment it sees 4002 the
 * archived flag is already set, so a racing reconnect can only be refused; that the
 * cached catalog survives an ordinary disconnect while wipe() erases it; and wipe()'s
 * idempotence, including against a DO that was never woken.
 *
 * WHY THE ORDERING PINS LIVE HERE and not in admin's suite: only a real socket can
 * observe "already gone at the moment of the close frame". Read from D1 afterwards,
 * every ordering looks correct. This file is the one place the sequence is falsifiable,
 * which is exactly the §9 spot-mutation target (swap the cascade order and case 9 must
 * go red naming its row).
 *
 * Durable vs incidental (§7): the codes, their meanings, and the 401/403 split are
 * durable and pinned hard. The close *reason* strings, the number of D1 statements the
 * cascade uses, and the order of the two audit rows an archive writes are incidental
 * and unasserted. The close-code → required-client-behavior mapping is a contract
 * fixture (strategy §4) that the client reconnect tables transcribe; this file pins
 * only what the hub emits.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): every case
 * holds a live socket and a real AppConnection instance (strategy §2).
 *
 * Isolation and ordering, load-bearing: smoke.test.ts green first; protocol.test.ts
 * owns registration, so a socket here is either "registered" or "accepted" and the
 * handshake itself is never re-pinned. With --no-isolate each case seeds its own owner,
 * slug, app id and tokens — two tokens where the row exercises `onlyIfTokenId` —
 * and asserts only on rows it created.
 */

// deps: harness/seed · harness/fake-app · harness/tunnel-do (connectionStub, liveSockets, stillOpen, untilStatus, backendCtx) · src/tunnel (handleConnect, sever, wipe, status, tunnelBackend, CLOSE_REVOKED, CLOSE_ARCHIVED, SeverCode) · src/identity (issueToken, revokeToken, resolveAppToken) · src/admin (ops.app_delete, ops.app_archive, ops.token_revoke) · src/registry (Registry)

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { deleteUser, ops } from "../../src/admin";
import type { Tool } from "../../src/gateway";
import { tokenFor } from "../../src/identity";
import { CALL_TIMEOUT_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { CLOSE_ARCHIVED, CLOSE_REVOKED, status, tunnelBackend, wipe } from "../../src/tunnel";
import type { SeverCode } from "../../src/tunnel";
import { attemptUpgrade, connectFakeApp, UpgradeRefused, waitFor } from "../harness/fake-app";
import type { FakeApp, FakeAppOptions } from "../harness/fake-app";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { backendCtx, connectionStub, liveSockets, stillOpen, untilStatus } from "../harness/tunnel-do";

/**
 * Every close code this file can observe: tunnel.ts's {@link SeverCode} pair, which is
 * the only pair a caller outside the DO may ask for, plus 4003 for the one race an
 * owner action can provoke — a re-register landing after the row is gone. Importing
 * SeverCode rather than respelling 4001/4002 keeps the table from drifting away from
 * the constants it describes.
 */
export type LifecycleCloseCode = SeverCode | 4003;

/** The credential a client presents at the /connect upgrade (§6's 401 list, enumerated). */
export type UpgradeCredential =
  | "live_app_token"
  | "revoked_app_token"
  | "expired_app_token"
  | "unknown_token"
  | "no_authorization_header"
  | "agent_token"
  | "session_token";

/** The state of the token's referent at upgrade time — the other half of the matrix. */
export type UpgradeAppState = "live_tunnel" | "archived" | "row_deleted" | "proxy_kind";

/**
 * One row of the upgrade matrix (§6). `status` is the pinned client contract: 401
 * fatal, 403 archived-keep-retrying, 101 accepted. `accepted` is the invariant that
 * makes a refusal real — a refused upgrade must leave the DO holding no socket, or a
 * 403 would still have handed an archived app a live connection.
 *
 * `twin` is the `name` of the 101 row in this same table that this row differs from by
 * ONE column — the credential state, or the referent's state, and nothing else. 101
 * rows name themselves. It is a required column rather than an instruction in the
 * comment above `upgradeRows` because a deny-only matrix is exactly satisfied by a
 * handleConnect that refuses every upgrade (§9 rule 2), and this table is the largest
 * refusal surface in the tunnel project. One column of difference is the whole
 * evidential value: "revoked is refused" means nothing until the same token, live, is
 * shown reaching 101.
 */
export type UpgradeOutcomeRow = {
  /** Test title, in the doc's convention: "§6 · <what this row pins>". */
  name: string;
  credential: UpgradeCredential;
  app: UpgradeAppState;
  status: 101 | 401 | 403;
  accepted: boolean;
  twin: string;
};

/**
 * The upgrade matrix. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. Every 401/403 row
 * belongs beside the 101 row it differs from by one column (§9 rule 2): a deny-only
 * matrix is satisfied by refusing everything. The `twin` column carries that pairing
 * as data and runUpgradeCase resolves it, so an unpaired refusal fails the suite
 * instead of passing review.
 */
export const upgradeRows: readonly UpgradeOutcomeRow[] = [
  // The fixture these rows are written against, named once: one namespace holding a
  // tunneled app with two live `pmcp_app_` tokens (rotation, §6), a revoked and an
  // expired token on the same app, a proxied app, an agent with a
  // `pmcp_agt_` key, and the owner's session token. Every row dials /connect with ONE
  // credential against ONE referent state, and asserts nothing about which check refused —
  // §6 makes 401 a single verdict on purpose.
  //
  // One convention: every refusal row differs from the 101 anchor by exactly one column,
  // which is what the `twin` column carries. That is why there is a single 101 row and not
  // one per refusal — the anchor is the same connection each refusal is a mutation of.

  // ── the anchor: the credential and the referent that reach 101 ───────────────────────
  {
    name: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
    credential: "live_app_token",
    app: "live_tunnel",
    status: 101,
    accepted: true,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },

  // ── 401: every credential failure, one verdict (§6's fatal list) ─────────────────────
  // §6: "**401** — no/invalid/expired/revoked token, wrong token kind (`pmcp_agt_`, session),
  // or a token whose app row is gone or is `kind: proxy`. Client treats this as fatal."
  // The rows below enumerate that sentence, one clause each, and nothing distinguishes them
  // on the wire — a client that could tell revoked from unknown could enumerate tokens.
  {
    name: "§6 · a revoked app token is refused 401 — fatal, and revocation is immediate at the upgrade",
    credential: "revoked_app_token",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  // §6 lifecycle 1: "Expiry is checked at upgrade only — an established socket outlives its
  // token's `expires_at` until the next reconnect." This row is the half that IS checked.
  {
    name: "§6 · an expired app token is refused 401 — expiry is checked at the upgrade, which is where this row lives",
    credential: "expired_app_token",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  {
    name: "§6 · a token string matching no row is refused 401, indistinguishably from a revoked one",
    credential: "unknown_token",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  // Trimmed deliberately to the verdict this row's INPUT can produce: it sends no
  // Authorization header and no other carrier either, so it cannot observe whether
  // /connect would have accepted a `?token=` parameter or a cookie. That carrier rule
  // ("Never consults cookies or query-string tokens", handleConnect's header) is pinned
  // where the header is actually read — worker/identity-tokens.test.ts's
  // `query_string_token` row, which moves the row's OWN valid secret out of the header and
  // still resolves null.
  {
    name: "§6 · no Authorization header at all is refused 401 — a missing credential is the same verdict as a bad one",
    credential: "no_authorization_header",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  // §6's "wrong token kind (`pmcp_agt_`, session)" clause, one row each. Stated precisely,
  // because the obvious claim would be false: a prefix-sniffing handleConnect refuses both
  // of these correctly, so neither row can fail one. The input that DISCRIMINATES §6's
  // "checking the token row's `kind` column explicitly, not just the prefix" is a
  // `pmcp_app_`-prefixed secret whose token row's `kind` column reads `agent`,
  // and it is pinned at the seam that reads the column — worker/identity-tokens.test.ts's
  // `wrong_kind_column` row, whose verdict this matrix inherits (that file's header divides
  // the labor: it owns the credential verdict, this table owns the referent's state).
  {
    name: "§6 · a live agent key is refused 401 — wrong token kind, whatever it can do on /<user>/mcp",
    credential: "agent_token",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  {
    name: "§6 · a live owner session token is refused 401 — a session is never an app credential",
    credential: "session_token",
    app: "live_tunnel",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  // The two referent clauses of the same 401 sentence: the credential is live and correct,
  // and what it points at is not connectable. Same code, so a bot cannot learn from the
  // upgrade whether its app was deleted or converted.
  {
    name: "§6 · a live token whose app row is gone is refused 401 — the deleted-app verdict is fatal, not a retry",
    credential: "live_app_token",
    app: "row_deleted",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
  {
    name: "§6 · a live token whose app is kind proxy is refused 401 — proxied apps have no connection of their own",
    credential: "live_app_token",
    app: "proxy_kind",
    status: 401,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },

  // ── 403: exactly one thing ───────────────────────────────────────────────────────────
  // §6: "**403** — means exactly one thing: the app is archived. Client keeps retrying
  // at max backoff so unarchiving heals automatically." The single 403 row is what case 2's
  // totality check measures the rest of the table against: if a second refusal ever borrows
  // this code, the archived row stops being the only one carrying it.
  {
    name: "§6 · an archived app refuses the upgrade 403 — the one meaning that code has, and the one refusal a client keeps retrying past",
    credential: "live_app_token",
    app: "archived",
    status: 403,
    accepted: false,
    twin: "§6 · a live app token against a live tunneled app upgrades: 101, and the DO holds the socket",
  },
];

/** What the owner did, of the four actions that can close a live socket (§6, §8, §15). */
export type SeverTrigger = "token_revoke" | "app_delete" | "app_archive" | "user_delete";

/**
 * One row of the sever matrix.
 *
 * `openedWith` / `targets` are the two tokens an app may hold at once (§6's
 * rotation model, issue-new → deploy → revoke-old): the socket was opened with one,
 * and the trigger names one — equal or not, which is the whole content of §8's
 * `onlyIfTokenId` rule. `close` is what the client observes, or "none" for the rows
 * where the socket must survive (a revoke of the *other* token) or where there was no
 * socket to close. `d1AtClose` is the §15 ordering pin, expressed as data: what D1
 * must ALREADY show at the instant the close frame arrives.
 *
 * `twin` inverts the usual direction, because on this table the destructive outcome is
 * the one under test: it is the `name` of a row in this same table whose `close` is
 * "none" and which differs from this one only in `targets` or `connection` — the
 * socket that must SURVIVE the same owner action. Surviving rows name themselves.
 * Required rather than conventional for the §9 rule 2 reason in its sharpest form
 * here: `sever()` closing every socket it can reach satisfies every closing row in
 * this table perfectly, and `onlyIfTokenId` is precisely the rule that forbids it. The
 * survivor row is the only thing that can fail such an implementation.
 */
export type SeverRow = {
  /** Test title, in the doc's convention: "§6 · <what this row pins>". */
  name: string;
  trigger: SeverTrigger;
  connection: "registered" | "accepted_unregistered" | "offline";
  openedWith: "token_a" | "token_b";
  targets: "token_a" | "token_b" | "whole_app";
  close: LifecycleCloseCode | "none";
  /**
   * What D1 must ALREADY show at the instant the close frame arrives. Revocation is a
   * FLAG, never a delete: §5's `token` table carries `revoked_at`, identity.revokeToken
   * is an `UPDATE … SET "revoked_at" = COALESCE(…)` that must still FIND the row (and
   * leaves it in `token_list` with its `last_used_at` history, §8), and
   * resolveAppToken refuses on `revoked_at != null`. So the revoke trigger's ordering
   * pin is `revoked_flag_set`; `rows_gone` belongs to the delete cascades
   * (identity.deleteTokensFor plus the app row), the only paths that remove rows.
   */
  d1AtClose: "rows_gone" | "revoked_flag_set" | "archived_flag_set" | "unchanged";
  /** Whether the DO's cached catalog is still served afterwards (archive keeps it, delete wipes it). */
  catalogSurvives: boolean;
  twin: string;
};

/**
 * The sever matrix. Rows are OWNER-AUTHORED in a separate commit before implementation
 * (strategy §9 rule 1) — agents never fill them. Each severing row sits beside the row
 * that differs only in `targets` or `connection` and must NOT close (§9 rule 2) — the
 * `twin` column names it and runSeverCase resolves it, so the pairing is checked
 * rather than intended.
 */
export const severRows: readonly SeverRow[] = [
  // The fixture these rows are written against, named once: one tunneled app holding
  // TWO live tokens (§6's rotation model — issue-new, deploy, revoke-old), a socket opened
  // with `token_a`, and a cached catalog warmed by that socket's registration. Every
  // trigger is fired through the admin op that owns the cascade, never through
  // tunnel.sever, because the ordering under test is admin's.
  //
  // Three conventions, so no row repeats them:
  // · `d1AtClose` states what D1 ALREADY shows at the instant the close frame arrives, in
  //   terms of the rows the trigger removes or flags. On a `close: "none"` row there is no
  //   such instant, so the column carries the neutral "unchanged" and asserts nothing —
  //   a revoke of the other token does set that token's `revoked_at`, it just closes nothing.
  // · `openedWith` is `token_a` on every row: the socket is always the one `token_a`
  //   opened, and `targets` is the only lever, which is exactly §8's onlyIfTokenId rule
  //   with one variable instead of two.
  // · 4003 is in this file's `LifecycleCloseCode` and in no row here: an owner action
  //   severs, it never re-registers, so the race that produces 4003 is provoked by a
  //   RECONNECT and lives in cases 11-12. The unused union member is that split, recorded.

  // ── token_revoke: the pair onlyIfTokenId exists for ──────────────────────────────────
  // §15: "A revoked *app* token (or a deleted app) additionally severs the live
  // reverse connection — the Worker tells the DO to close the socket with code `4001`;
  // a racing re-register fails because the app row / token is gone" — for the revoke
  // trigger that is the token reading REVOKED, not missing: the row survives with
  // `revoked_at` set (§5) so `token_list` keeps showing the leaked token's `last_used_at`.
  // The ordering is the pin: the flag is already set at the instant of the 4001 frame, so a
  // reconnect racing the close meets 401 at the upgrade. The catalog is untouched: only
  // deletion wipes (§6 lifecycle 4).
  {
    name: "§6/§8 · revoking the token the socket was opened with closes it 4001, with that token's revoked_at already set — the racing reconnect meets a dead credential, and the row stays for the listing",
    trigger: "token_revoke",
    connection: "registered",
    openedWith: "token_a",
    targets: "token_a",
    close: 4001,
    d1AtClose: "revoked_flag_set",
    catalogSurvives: true,
    twin: "§8 · revoking the app's OTHER live token leaves the socket up — the survivor a sever() that closes everything cannot produce",
  },
  // §8's rule as its own row, and the only row in this table that a `sever()` closing every
  // socket it can reach fails. Rotation depends on it: issue-new, deploy, revoke-old must
  // not kill the connection the NEW token is already holding.
  {
    name: "§8 · revoking the app's OTHER live token leaves the socket up — the survivor a sever() that closes everything cannot produce",
    trigger: "token_revoke",
    connection: "registered",
    openedWith: "token_a",
    targets: "token_b",
    close: "none",
    d1AtClose: "unchanged",
    catalogSurvives: true,
    twin: "§8 · revoking the app's OTHER live token leaves the socket up — the survivor a sever() that closes everything cannot produce",
  },

  // ── app_delete: 4001, D1-first, and the wipe ─────────────────────────────────────
  // §6 lifecycle 4 plus §15's ordering: at the moment the client sees 4001 the rows are
  // already gone, so a racing re-register finds nothing to register against.
  {
    name: "§15 · app_delete closes 4001 with the app's D1 rows already gone at that instant — the cascade is D1-first",
    trigger: "app_delete",
    connection: "registered",
    openedWith: "token_a",
    targets: "whole_app",
    close: 4001,
    d1AtClose: "rows_gone",
    catalogSurvives: false,
    twin: "§6 · app_delete against an offline app closes nothing and still wipes — a sever with no socket is a no-op, never an error",
  },
  // The survivor for the delete family: with `targets` pinned to whole_app, `connection`
  // is the only column left to vary, and an offline app is the row that proves the
  // teardown does not depend on there being a socket to close.
  {
    name: "§6 · app_delete against an offline app closes nothing and still wipes — a sever with no socket is a no-op, never an error",
    trigger: "app_delete",
    connection: "offline",
    openedWith: "token_a",
    targets: "whole_app",
    close: "none",
    d1AtClose: "unchanged",
    catalogSurvives: false,
    twin: "§6 · app_delete against an offline app closes nothing and still wipes — a sever with no socket is a no-op, never an error",
  },
  // §6: an accepted-but-not-yet-registered socket is still a live socket. It reads OFFLINE
  // (lifecycle 2) and must still be severed — otherwise a bot could hold a slot through a
  // deletion by simply never registering.
  // Fixture exception, and the only one in this table: this row's catalog is warmed by a
  // PRIOR registered socket that this accepted-but-unregistered one replaced (§6's
  // newest-wins at acceptance). Without that prior connection the catalog would be empty
  // before the trigger and empty after, and `catalogSurvives: false` would read the same
  // whether wipe() ran or not — a vacuous column on the one row whose socket never
  // registers.
  {
    name: "§6 · an accepted-but-unregistered socket is severed exactly like a registered one — eviction is about the socket, not the handshake",
    trigger: "app_delete",
    connection: "accepted_unregistered",
    openedWith: "token_a",
    targets: "whole_app",
    close: 4001,
    d1AtClose: "rows_gone",
    catalogSurvives: false,
    twin: "§6 · app_delete against an offline app closes nothing and still wipes — a sever with no socket is a no-op, never an error",
  },

  // ── app_archive: 4002, flag first, catalog kept ──────────────────────────────────
  // §6 lifecycle 3: archived retains "Roles, grants, tokens, and the cached catalog" — and
  // the flag must land BEFORE the close, or a client reconnecting on the close frame could
  // be accepted 101 into an app the owner just parked.
  {
    name: "§6 · app_archive closes 4002 with the archived flag already set — a reconnect racing the close can only be refused 403",
    trigger: "app_archive",
    connection: "registered",
    openedWith: "token_a",
    targets: "whole_app",
    close: 4002,
    d1AtClose: "archived_flag_set",
    catalogSurvives: true,
    twin: "§6 · app_archive against an offline app closes nothing and keeps the catalog — unarchive restores an app that still lists",
  },
  {
    name: "§6 · app_archive against an offline app closes nothing and keeps the catalog — unarchive restores an app that still lists",
    trigger: "app_archive",
    connection: "offline",
    openedWith: "token_a",
    targets: "whole_app",
    close: "none",
    d1AtClose: "unchanged",
    catalogSurvives: true,
    twin: "§6 · app_archive against an offline app closes nothing and keeps the catalog — unarchive restores an app that still lists",
  },

  // ── user_delete: the same teardown, one level up ─────────────────────────────────────
  // §15: "User deletion (`/internal/users`) performs the same teardown as `app_delete`
  // for every tunneled app in the namespace — close `4001`, wipe DO cached state —
  // before the row cascade." A separate row because it is a separate cascade, and a hub
  // that severed per-app but not per-user would pass every row above.
  {
    name: "§15 · user_delete tears the namespace's tunneled app down exactly as app_delete does: 4001, rows already gone, catalog wiped",
    trigger: "user_delete",
    connection: "registered",
    openedWith: "token_a",
    targets: "whole_app",
    close: 4001,
    d1AtClose: "rows_gone",
    catalogSurvives: false,
    twin: "§15 · user_delete of a namespace whose app is offline closes nothing and still wipes the DO — the teardown never depends on a live socket",
  },
  {
    name: "§15 · user_delete of a namespace whose app is offline closes nothing and still wipes the DO — the teardown never depends on a live socket",
    trigger: "user_delete",
    connection: "offline",
    openedWith: "token_a",
    targets: "whole_app",
    close: "none",
    d1AtClose: "unchanged",
    catalogSurvives: false,
    twin: "§15 · user_delete of a namespace whose app is offline closes nothing and still wipes the DO — the teardown never depends on a live socket",
  },
];

/**
 * Runs one upgrade row: seeds the credential and referent the row names, dials
 * /connect, and observes the response status plus whether the DO ended up holding a
 * socket. Never inspects which check failed — that indistinguishability is the point.
 *
 * `rows` is the whole table because `row.twin` is resolved against it: every 401/403
 * row must name a row of `rows` whose status is 101, or the case fails before it
 * dials. Resolution is a lookup — the twin has its own case and is never dialed twice.
 */
export async function runUpgradeCase(
  row: UpgradeOutcomeRow,
  rows: readonly UpgradeOutcomeRow[],
): Promise<void> {
  // deps: harness/seed · harness/fake-app · src/tunnel.handleConnect · cloudflare:test runInDurableObject
  const twin = rows.find((candidate) => candidate.name === row.twin);
  expect(twin, `"${row.name}" names a twin that is not a row of this table`).toBeDefined();
  expect((twin as UpgradeOutcomeRow).status, `"${row.name}"'s twin must be the 101 row`).toBe(101);

  const fixture = await seedUpgradeFixture(row);
  const { status: observed } = await dial(fixture, credentialFor(row, fixture));
  expect(observed, `"${row.name}" expected HTTP ${row.status} at the upgrade`).toBe(row.status);
  // The invariant that makes a refusal real: a refused upgrade leaves the DO holding
  // nothing, so a 403 can never have handed an archived app a live connection.
  expect(await liveSockets(fixture.probeAppId)).toBe(row.accepted ? 1 : 0);
}

/**
 * The whole upgrade matrix's fixture, seeded per row: one namespace holding a tunneled
 * app with two live tokens plus a revoked and an expired one, a proxied app
 * carrying a `pmcp_app_` token of its own, an agent with a `pmcp_agt_` key, and —
 * only for the row that needs it, because the password hash is deliberately slow — the
 * owner's session.
 */
async function seedUpgradeFixture(row: UpgradeOutcomeRow): Promise<UpgradeFixture> {
  const slug = uniqueSlug("bot");
  const proxied = uniqueSlug("proxied");
  const agent = uniqueSlug("agent");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("life"),
    apps: [
      {
        slug,
        kind: "tunnel",
        tokens: [{ as: "live" }, { as: "revoked", revoked: true }, { as: "expired", expired: true }],
      },
      {
        slug: proxied,
        kind: "proxy",
        upstreamUrl: "https://upstream.invalid/mcp",
        // A `pmcp_app_` token bound to a PROXIED app: identity mints it (the kind check
        // that refuses this is the admin op's, §8), which is the only way the "proxied
        // apps have no connection of their own" row gets a live credential to present.
        tokens: [{ as: "proxy" }],
      },
    ],
    agents: [{ slug: agent, tokens: [{ as: "sa" }] }],
  });
  seeded.push(namespace);

  const registry = new Registry(env.DB);
  const app = namespace.apps[slug];
  if (row.app === "archived") await registry.archiveApp(app.id);
  // Deleted through registry rather than the admin op: the op would also sever and wipe,
  // and this row is about what the UPGRADE does with a token whose referent is gone.
  if (row.app === "row_deleted") await registry.deleteApp(app.id);

  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    username: namespace.owner.username,
    slug,
    appId: app.id,
    // The DO the row's credential POINTS AT — the proxied app's own for the proxy row,
    // so "no socket was accepted" is asked of the right object.
    probeAppId: row.app === "proxy_kind" ? namespace.apps[proxied].id : app.id,
    tokens: namespace.tokens,
    session: row.credential === "session_token" ? await seedOwnerSession(namespace.owner) : undefined,
  };
}

type UpgradeFixture = {
  origin: string;
  ownerId: string;
  username: string;
  slug: string;
  appId: string;
  probeAppId: string;
  tokens: SeededNamespace["tokens"];
  session: { token: string } | undefined;
};

/** The one credential a row presents — `undefined` is the row that presents none. */
function credentialFor(row: UpgradeOutcomeRow, fixture: UpgradeFixture): string | undefined {
  switch (row.credential) {
    case "live_app_token":
      return row.app === "proxy_kind" ? fixture.tokens.proxy.token : fixture.tokens.live.token;
    case "revoked_app_token":
      return fixture.tokens.revoked.token;
    case "expired_app_token":
      return fixture.tokens.expired.token;
    case "agent_token":
      return fixture.tokens.sa.token;
    case "session_token":
      return fixture.session?.token;
    case "unknown_token":
      // Obviously fake, and shaped like the real thing so the prefix check passes and the
      // row is refused by the lookup rather than by the grammar.
      return "pmcp_app_FAKE0000000000000000000000000000000000";
    case "no_authorization_header":
      return undefined;
  }
}

/**
 * One upgrade attempt, whatever its outcome: the HTTP status, plus the socket when there
 * is one. A 101 has to be dialled as a real connection — `attemptUpgrade` gives the socket
 * straight back, which would make "the DO holds it" unobservable a moment later.
 */
async function dial(
  fixture: UpgradeFixture,
  token: string | undefined,
): Promise<{ status: number; app?: FakeApp }> {
  if (token === undefined) return attemptUpgrade({ origin: fixture.origin });
  try {
    const app = await connectFakeApp({ origin: fixture.origin, token, skipRegister: true });
    opened.push(app);
    return { status: 101, app };
  } catch (err) {
    if (err instanceof UpgradeRefused) return { status: err.status };
    throw err;
  }
}

/**
 * Runs one sever row: brings the connection to the row's state, fires the trigger
 * through the admin op that owns the cascade (never tunnel.sever directly — the
 * ordering under test is admin's), and reads D1 from inside the close handler so
 * `d1AtClose` is observed at the instant of the frame, not after it.
 *
 * `rows` carries the same twin obligation as runUpgradeCase's: every row whose `close`
 * is a code must name a row of `rows` whose `close` is "none", differing only in
 * `targets` or `connection`. Resolved as a lookup, so a sever row still costs one
 * scenario.
 */
export async function runSeverCase(row: SeverRow, rows: readonly SeverRow[]): Promise<void> {
  // deps: harness/seed · harness/fake-app · src/admin.ops · src/tunnel.status · src/registry.Registry
  const twin = rows.find((candidate) => candidate.name === row.twin);
  expect(twin, `"${row.name}" names a twin that is not a row of this table`).toBeDefined();
  expect((twin as SeverRow).close, `"${row.name}"'s twin must be a socket that SURVIVES`).toBe("none");

  const fixture = await seedSeverFixture();
  const app = await bringConnectionTo(fixture, row.connection);

  // The §15 ordering pin: D1 is read the moment the close frame lands, not after the
  // trigger returns — read afterwards, every ordering looks correct.
  const atClose = app?.closed.then(() => snapshotD1(fixture, row));
  await fireTrigger(fixture, row);

  if (row.close === "none") {
    if (app !== undefined) expect(await stillOpen(app)).toBe(true);
  } else {
    expect((await (app as FakeApp).closed).code).toBe(row.close);
    expect(await atClose).toEqual(expectedD1(row));
  }
  // The cached catalog is read from the DO, never through an app row: two of these
  // rows have just deleted theirs.
  const catalog = await connectionStub(fixture.appId).listTools();
  expect(catalog.length > 0).toBe(row.catalogSurvives);
}

/** The sever matrix's fixture: one tunneled app holding two live tokens. */
async function seedSeverFixture(): Promise<SeverFixture> {
  const slug = uniqueSlug("bot");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("sever"),
    apps: [{ slug, kind: "tunnel", tokens: [{ as: "token_a" }, { as: "token_b" }] }],
  });
  seeded.push(namespace);
  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    username: namespace.owner.username,
    slug,
    appId: namespace.apps[slug].id,
    tokens: namespace.tokens,
  };
}

type SeverFixture = {
  origin: string;
  ownerId: string;
  username: string;
  slug: string;
  appId: string;
  tokens: SeededNamespace["tokens"];
};

/**
 * The connection state a row starts from, always opened with `token_a` and always with a
 * warmed catalog — including the `accepted_unregistered` row, whose catalog comes from the
 * registered socket it REPLACED (the table's one fixture exception, and the reason the
 * `catalogSurvives` column is not vacuous on it).
 */
async function bringConnectionTo(
  fixture: SeverFixture,
  connection: SeverRow["connection"],
): Promise<FakeApp | undefined> {
  const registered = await open(fixture, {});
  expect(await registered.registered).toEqual({ ok: true });
  expect(await waitFor(() => registered.lists.length > 0), "the catalog never warmed").toBe(true);
  if (connection === "registered") return registered;
  if (connection === "offline") {
    await registered.close();
    await untilStatus(fixture.appId, "offline");
    return undefined;
  }
  return open(fixture, { skipRegister: true });
}

/** One socket for the fixture's app, opened with `token_a` unless told otherwise. */
async function open(
  fixture: SeverFixture,
  options: Partial<FakeAppOptions>,
): Promise<FakeApp> {
  const app = await connectFakeApp({
    origin: fixture.origin,
    token: fixture.tokens.token_a.token,
    tools: [CACHED_TOOL],
    ...options,
  });
  opened.push(app);
  return app;
}

/** The owner action under test, fired through the op that OWNS its cascade — never
 *  through tunnel.sever, because the ordering being pinned is admin's. */
async function fireTrigger(fixture: SeverFixture, row: SeverRow): Promise<void> {
  switch (row.trigger) {
    case "token_revoke":
      await ops.token_revoke.handler(fixture.ownerId, { id: fixture.tokens[row.targets].id });
      return;
    case "app_delete":
      await ops.app_delete.handler(fixture.ownerId, { slug: fixture.slug });
      return;
    case "app_archive":
      await ops.app_archive.handler(fixture.ownerId, { slug: fixture.slug });
      return;
    case "user_delete":
      await deleteUser(fixture.username);
      return;
  }
}

/** What D1 shows about this row's targets, in the vocabulary the `d1AtClose` column uses. */
async function snapshotD1(fixture: SeverFixture, row: SeverRow): Promise<Record<string, unknown>> {
  const app = await new Registry(env.DB).getApp(fixture.ownerId, fixture.slug);
  const targeted =
    row.targets === "whole_app" ? null : await tokenFor(fixture.ownerId, fixture.tokens[row.targets].id);
  return {
    appRow: app === null ? "gone" : "present",
    archived: app?.archived ?? false,
    tokenRevoked: targeted?.revokedAt != null,
  };
}

/** The same vocabulary, as the row asserts it. */
function expectedD1(row: SeverRow): Record<string, unknown> {
  return {
    appRow: row.d1AtClose === "rows_gone" ? "gone" : "present",
    archived: row.d1AtClose === "archived_flag_set",
    tokenRevoked: row.d1AtClose === "revoked_flag_set",
  };
}

// ── shared plumbing ───────────────────────────────────────────────────────────────────

const seeded: SeededNamespace[] = [];
const opened: FakeApp[] = [];

afterEach(async () => {
  // Sockets AND storage outlive a file in this project, so both are given back here.
  for (const app of opened.splice(0)) await app.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/** The one tool every fixture's catalog holds — enough to tell an empty cache from a warm
 *  one, which is all any row here asks of it. */
const CACHED_TOOL: Tool = {
  name: "search",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** The fixture's app row, as the gateway would hand it to a backend. */
async function appRow(fixture: SeverFixture): Promise<App> {
  const row = await new Registry(env.DB).getApp(fixture.ownerId, fixture.slug);
  if (row === null) throw new Error("the fixture's app vanished");
  return row;
}

describe("§6 the upgrade matrix", () => {
  for (const row of upgradeRows) {
    it(row.name, () => runUpgradeCase(row, upgradeRows));
  }

  it("1b. §9 rule 2 · every 401/403 row's `twin` resolves to a 101 row present in this table, differing by one column — without it, a handleConnect that accepts nothing passes the whole matrix", () => {
    const anchors = upgradeRows.filter((row) => row.status === 101);
    expect(anchors.length, "the matrix needs at least one row that reaches 101").toBeGreaterThan(0);
    for (const row of upgradeRows) {
      const twin = upgradeRows.find((candidate) => candidate.name === row.twin);
      expect(twin, `"${row.name}" names a twin outside this table`).toBeDefined();
      expect((twin as UpgradeOutcomeRow).status, `"${row.name}"'s twin must be a 101 row`).toBe(101);
      if (row.status === 101) continue;
      // One column of difference is the whole evidential value: "revoked is refused" says
      // nothing until the same token, live, is shown reaching 101.
      const differences =
        (row.credential === (twin as UpgradeOutcomeRow).credential ? 0 : 1) +
        (row.app === (twin as UpgradeOutcomeRow).app ? 0 : 1);
      expect(differences, `"${row.name}" differs from its twin in more than one column`).toBe(1);
    }
  });

  it("2. §6 · 403 means exactly archived: over the whole table, the archived rows are the only 403s — a totality check on the oracle itself, so a new refusal can't quietly borrow the archived code", () => {
    for (const row of upgradeRows) {
      expect(row.status === 403, `"${row.name}"`).toBe(row.app === "archived");
    }
    expect(upgradeRows.some((row) => row.status === 403)).toBe(true);
  });

  it("3. §6 · an accepted upgrade leaves the DO holding exactly one socket, and every refusal leaves it holding none", async () => {
    // The table's `accepted` column, asserted as the property it encodes rather than row by
    // row: acceptance follows the status, on every row, in both directions.
    for (const row of upgradeRows) {
      expect(row.accepted, `"${row.name}"`).toBe(row.status === 101);
    }
    const fixture = await seedUpgradeFixture(upgradeRows[0]);
    expect(await liveSockets(fixture.appId)).toBe(0);
    await dial(fixture, fixture.tokens.live.token);
    expect(await liveSockets(fixture.appId)).toBe(1);
  });

  it("4. §6 · an unarchive heals with no bot involvement: the same credential refused 403 is accepted 101 once the flag clears (the allow-twin of the 403 rows)", async () => {
    const archivedRow = upgradeRows.find((row) => row.status === 403) as UpgradeOutcomeRow;
    const fixture = await seedUpgradeFixture(archivedRow);
    const token = credentialFor(archivedRow, fixture);
    expect((await dial(fixture, token)).status).toBe(403);
    await new Registry(env.DB).unarchiveApp(fixture.appId);
    expect((await dial(fixture, token)).status).toBe(101);
  });
});

describe("§6/§8 severing a live connection", () => {
  for (const row of severRows) {
    it(row.name, () => runSeverCase(row, severRows));
  }

  it("5b. §9 rule 2 · every closing row's `twin` resolves to a `close: \"none\"` row present in this table — the survivor that a sever() closing everything it can reach cannot produce", () => {
    expect(severRows.some((row) => row.close !== "none")).toBe(true);
    for (const row of severRows) {
      const twin = severRows.find((candidate) => candidate.name === row.twin);
      expect(twin, `"${row.name}" names a twin outside this table`).toBeDefined();
      expect((twin as SeverRow).close, `"${row.name}"'s twin must survive`).toBe("none");
      if (row.close === "none") continue;
      // The survivor differs only in what the trigger targets or in what was connected —
      // same trigger, same opening token, so the difference is the rule itself.
      expect((twin as SeverRow).trigger).toBe(row.trigger);
      expect((twin as SeverRow).openedWith).toBe(row.openedWith);
    }
  });

  it("6. §8 · token_revoke closes only the socket that token opened; a socket opened with the app's other live token stays up and still forwards", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, { token: fixture.tokens.token_b.token });
    expect(await app.registered).toEqual({ ok: true });
    await ops.token_revoke.handler(fixture.ownerId, { id: fixture.tokens.token_a.id });
    expect(await stillOpen(app)).toBe(true);
    expect(await status(fixture.appId)).toBe("online");
    // Still FORWARDS, not merely still open: a socket the hub would refuse to use is not a
    // surviving connection.
    const answer = await tunnelBackend.call(
      await appRow(fixture),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } },
      backendCtx(),
    );
    expect(answer.error).toBeUndefined();
    expect(app.callCount("search")).toBe(1);
  });

  it("7. §6 · sever against an offline app is a no-op and never throws", async () => {
    const fixture = await seedSeverFixture();
    // Never connected at all: the DO has not even been woken.
    await expect(ops.token_revoke.handler(fixture.ownerId, { id: fixture.tokens.token_a.id })).resolves.toBeDefined();
    await expect(ops.app_archive.handler(fixture.ownerId, { slug: fixture.slug })).resolves.toBeDefined();
    expect(await status(fixture.appId)).toBe("offline");
  });

  it("8. §6 · in-flight consumers are failed fast when the socket goes: a call awaiting a response gets -32000 at the close, not at limits.CALL_TIMEOUT_MS", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, { behavior: { mode: "hang" } });
    expect(await app.registered).toEqual({ ok: true });
    const row = await appRow(fixture);
    const call = tunnelBackend.call(
      row,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } },
      backendCtx(),
    );
    expect(await waitFor(() => app.callCount("search") === 1)).toBe(true);
    const startedAt = Date.now();
    await app.close();
    await expect(call).rejects.toMatchObject({ code: -32000 });
    expect(Date.now() - startedAt).toBeLessThan(CALL_TIMEOUT_MS);
  });
});

describe("§15 ordering, observed live", () => {
  it("9. §15 · at the moment the client observes 4001, D1 already has no app row — the cascade is D1-first, so a racing re-register finds nothing", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await app.registered).toEqual({ ok: true });
    const atClose = app.closed.then(() =>
      new Registry(env.DB).getApp(fixture.ownerId, fixture.slug),
    );
    await ops.app_delete.handler(fixture.ownerId, { slug: fixture.slug });
    expect((await app.closed).code).toBe(CLOSE_REVOKED);
    expect(await atClose, "the row was still there when the client saw 4001").toBeNull();
  });

  it("10. §6 · at the moment the client observes 4002, the archived flag is already set — a reconnect racing the close can only be refused 403", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await app.registered).toEqual({ ok: true });
    const atClose = app.closed.then(() =>
      new Registry(env.DB).getApp(fixture.ownerId, fixture.slug),
    );
    await ops.app_archive.handler(fixture.ownerId, { slug: fixture.slug });
    expect((await app.closed).code).toBe(CLOSE_ARCHIVED);
    expect((await atClose)?.archived).toBe(true);
  });

  it("11. §6 · a re-register arriving after the row is gone closes 4003 instead of resurrecting the app (twin of case 9's ordering)", async () => {
    const fixture = await seedSeverFixture();
    // The racing reconnect: accepted while the row existed, registering after it is gone.
    const racing = await open(fixture, { skipRegister: true });
    // The cascade's D1 HALF alone, which is the half this race is against — the full op
    // would also sever this socket (the sever table pins that), and a socket closed 4001
    // could never deliver the registration the row is about.
    await new Registry(env.DB).deleteApp(fixture.appId);
    await racing.sendRegister();
    expect((await racing.closed).code).toBe(4003);
    expect(await new Registry(env.DB).getApp(fixture.ownerId, fixture.slug)).toBeNull();
  });

  it("12. §6 · a re-register arriving after an archive is refused at the upgrade, never at registration (twin of case 10)", async () => {
    const fixture = await seedSeverFixture();
    const first = await open(fixture, {});
    expect(await first.registered).toEqual({ ok: true });
    await ops.app_archive.handler(fixture.ownerId, { slug: fixture.slug });
    expect((await first.closed).code).toBe(CLOSE_ARCHIVED);
    await expect(
      connectFakeApp({ origin: fixture.origin, token: fixture.tokens.token_a.token }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("§6 catalog and wipe", () => {
  it("13. §6 · the cached catalog survives an ordinary disconnect: tools/list still serves it while the app is offline — deploy-induced flapping never churns an agent's tool list", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    await app.close();
    await untilStatus(fixture.appId, "offline");
    expect(await tunnelBackend.listTools(await appRow(fixture), backendCtx())).toEqual([CACHED_TOOL]);
  });

  it("14. §6 · archival keeps the catalog: unarchive restores an app that lists exactly what it listed before (the allow-twin of case 15)", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    const before = await tunnelBackend.listTools(await appRow(fixture), backendCtx());
    await ops.app_archive.handler(fixture.ownerId, { slug: fixture.slug });
    expect((await app.closed).code).toBe(CLOSE_ARCHIVED);
    await new Registry(env.DB).unarchiveApp(fixture.appId);
    expect(await tunnelBackend.listTools(await appRow(fixture), backendCtx())).toEqual(before);
  });

  it("15. §6 · wipe() returns the DO to never-connected: listTools is empty afterwards", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    expect(await connectionStub(fixture.appId).listTools()).toEqual([CACHED_TOOL]);
    await wipe(fixture.appId);
    expect(await connectionStub(fixture.appId).listTools()).toEqual([]);
  });

  it("16. §6 · wipe() is idempotent, and safe against a DO that was never woken", async () => {
    const fixture = await seedSeverFixture();
    await wipe(fixture.appId);
    await wipe(fixture.appId);
    expect(await connectionStub(fixture.appId).listTools()).toEqual([]);
  });

  it("17. §6 · wipe() leaves a live socket alone — severing first is admin's ordering, not the DO's business", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, {});
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    await wipe(fixture.appId);
    expect(await stillOpen(app)).toBe(true);
    expect(await status(fixture.appId)).toBe("online");
  });

  it("18. §6 · status() reads offline for an accepted-but-unregistered socket and online only after hub/register — the twin pair the approval gate's availability-first refusal depends on", async () => {
    const fixture = await seedSeverFixture();
    const app = await open(fixture, { skipRegister: true });
    expect(await status(fixture.appId)).toBe("offline");
    await app.sendRegister();
    expect(await app.registered).toEqual({ ok: true });
    expect(await status(fixture.appId)).toBe("online");
  });
});
