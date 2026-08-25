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
 * holds a live socket and a real ServiceConnection instance (strategy §2).
 *
 * Isolation and ordering, load-bearing: smoke.test.ts green first; protocol.test.ts
 * owns registration, so a socket here is either "registered" or "accepted" and the
 * handshake itself is never re-pinned. With --no-isolate each case seeds its own owner,
 * slug, service id and tokens — two tokens where the row exercises `onlyIfTokenId` —
 * and asserts only on rows it created.
 */

// deps: harness/seed · harness/fake-service · cloudflare:test (env.SERVICE_CONNECTION, runInDurableObject) · src/tunnel (handleConnect, sever, wipe, status, tunnelBackend, CLOSE_REVOKED, CLOSE_ARCHIVED, SeverCode) · src/identity (issueToken, revokeToken, resolveServiceToken) · src/admin (ops.service_delete, ops.service_archive, ops.token_revoke) · src/registry (Registry)

import { describe, it } from "vitest";
import type { SeverCode } from "../../src/tunnel";

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
  | "live_service_token"
  | "revoked_service_token"
  | "expired_service_token"
  | "unknown_token"
  | "no_authorization_header"
  | "service_account_token"
  | "session_token";

/** The state of the token's referent at upgrade time — the other half of the matrix. */
export type UpgradeServiceState = "live_tunnel" | "archived" | "row_deleted" | "proxy_kind";

/**
 * One row of the upgrade matrix (§6). `status` is the pinned client contract: 401
 * fatal, 403 archived-keep-retrying, 101 accepted. `accepted` is the invariant that
 * makes a refusal real — a refused upgrade must leave the DO holding no socket, or a
 * 403 would still have handed an archived service a live connection.
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
  service: UpgradeServiceState;
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
export const upgradeRows: readonly UpgradeOutcomeRow[] = [];

/** What the owner did, of the four actions that can close a live socket (§6, §8, §15). */
export type SeverTrigger = "token_revoke" | "service_delete" | "service_archive" | "user_delete";

/**
 * One row of the sever matrix.
 *
 * `openedWith` / `targets` are the two tokens a service may hold at once (§6's
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
  targets: "token_a" | "token_b" | "whole_service";
  close: LifecycleCloseCode | "none";
  d1AtClose: "rows_gone" | "archived_flag_set" | "unchanged";
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
export const severRows: readonly SeverRow[] = [];

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
  // deps: harness/seed · harness/fake-service · src/tunnel.handleConnect · cloudflare:test runInDurableObject
  throw new Error("unimplemented");
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
  // deps: harness/seed · harness/fake-service · src/admin.ops · src/tunnel.status · src/registry.Registry
  throw new Error("unimplemented");
}

describe("§6 the upgrade matrix", () => {
  it.todo("1. §6 · upgrade table — one case per row of `upgradeRows`, driven by runUpgradeCase(row, upgradeRows)");
  it.todo("1b. §9 rule 2 · every 401/403 row's `twin` resolves to a 101 row present in this table, differing by one column — without it, a handleConnect that accepts nothing passes the whole matrix");
  it.todo("2. §6 · 403 means exactly archived: over the whole table, the archived rows are the only 403s — a totality check on the oracle itself, so a new refusal can't quietly borrow the archived code");
  it.todo("3. §6 · an accepted upgrade leaves the DO holding exactly one socket, and every refusal leaves it holding none");
  it.todo("4. §6 · an unarchive heals with no bot involvement: the same credential refused 403 is accepted 101 once the flag clears (the allow-twin of the 403 rows)");
});

describe("§6/§8 severing a live connection", () => {
  it.todo("5. §6 · sever table — one case per row of `severRows`, driven by runSeverCase(row, severRows)");
  it.todo("5b. §9 rule 2 · every closing row's `twin` resolves to a `close: \"none\"` row present in this table — the survivor that a sever() closing everything it can reach cannot produce");
  it.todo("6. §8 · token_revoke closes only the socket that token opened; a socket opened with the service's other live token stays up and still forwards");
  it.todo("7. §6 · sever against an offline service is a no-op and never throws");
  it.todo("8. §6 · in-flight consumers are failed fast when the socket goes: a call awaiting a response gets -32000 at the close, not at limits.CALL_TIMEOUT_MS");
});

describe("§15 ordering, observed live", () => {
  it.todo("9. §15 · at the moment the client observes 4001, D1 already has no service row — the cascade is D1-first, so a racing re-register finds nothing");
  it.todo("10. §6 · at the moment the client observes 4002, the archived flag is already set — a reconnect racing the close can only be refused 403");
  it.todo("11. §6 · a re-register arriving after the row is gone closes 4003 instead of resurrecting the service (twin of case 9's ordering)");
  it.todo("12. §6 · a re-register arriving after an archive is refused at the upgrade, never at registration (twin of case 10)");
});

describe("§6 catalog and wipe", () => {
  it.todo("13. §6 · the cached catalog survives an ordinary disconnect: tools/list still serves it while the service is offline — deploy-induced flapping never churns an agent's tool list");
  it.todo("14. §6 · archival keeps the catalog: unarchive restores a service that lists exactly what it listed before (the allow-twin of case 15)");
  it.todo("15. §6 · wipe() returns the DO to never-connected: listTools is empty afterwards");
  it.todo("16. §6 · wipe() is idempotent, and safe against a DO that was never woken");
  it.todo("17. §6 · wipe() leaves a live socket alone — severing first is admin's ordering, not the DO's business");
  it.todo("18. §6 · status() reads offline for an accepted-but-unregistered socket and online only after hub/register — the twin pair the approval gate's availability-first refusal depends on");
});
