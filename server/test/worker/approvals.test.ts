// approvals.test.ts — the approval gate as a machine (§7): what `check` decides without
// consuming anything, what `claim` consumes exactly once, and what `settle` is allowed to
// restore. The deepest file in the `worker` project, because approvals is where four
// separate hard properties meet one table.
//
// What it pins, and why each is here rather than inferred:
//  · The three-phase split itself. check → (the gateway's availability probe) → claim
//    exists so an approved retry that meets an offline service costs the owner nothing.
//    The only way to state that is to observe check leaving the row untouched — a
//    SELECT-then-dispatch implementation passes every single-caller test and fails this
//    one, which is why the CAS and dedup cases are OWNER-AUTHORED before implementation
//    (strategy §6): they constrain implementation shape, not just behavior.
//  · Dedup by CONSTRAINT, not by code. Two concurrent identical first calls must yield
//    one row, one id, one `approval.requested`, one push — enforced by the partial unique
//    index (migrations.test.ts pins the index itself; this file pins the behavior riding
//    on it).
//  · Post-redaction hashing, proven observably rather than by inspecting a digest: two
//    calls differing ONLY in a redacted argument bind to the same row, and one differing
//    in a visible argument does not. That pair is the whole §7 trade-off stated as
//    behavior, and it is the mutation "hash before redaction" fails on.
//  · Push crypto DECRYPTED in-test. A fake push endpoint that merely counts requests
//    would bless an unencrypted or misdirected payload, so the fake verifies the VAPID
//    ES256 JWT against the configured public key and decrypts the RFC 8291 body — real
//    WebCrypto on both sides, never faked (§9) — to assert the payload names service,
//    tool and approval id and carries no arguments at all, redacted or otherwise.
//
// Boundaries: the availability-first refusal (a known-offline service failing -32000
// before any row is read or created) is the GATEWAY's, pinned in order.table.test.ts and
// tunnel/approval-e2e.test.ts — this module never probes availability, and no case here
// should pretend it does. The exactly-once oracle over a real tunnel (the fake service's
// invocation counter) is tunnel/approval-e2e.test.ts's; what lives here is the row-level
// CAS beneath it.
//
// Project: `worker` — real D1, real WebCrypto, no socket. Time is INJECTED through
// ApprovalsConfig.now(): vitest fake timers do not reach workerd, and every expiry
// judgment in this module reads that clock, so expiry cases advance the injected clock
// and reference limits.APPROVAL_WINDOW_MS / RETENTION_DAYS by name, never a literal (§7).
// Parallel, per-file isolation, order free.
//
// IMPLEMENTATION NOTE (2026-08-25), on the one bullet above that could not be built as
// authored: the Web Push CRYPTO has no implementation to test. `webpush-webcrypto` is not a
// dependency and this dispatch may add none, and the module header forbids hand-rolling
// VAPID ES256 + RFC 8291 — so the transport is an injected seam (`ApprovalsConfig.push`:
// one encrypted POST, one status back) and the fake here is that seam, not an
// outboundService endpoint. What this file therefore still pins, and does: which
// subscriptions a push reaches, that the PAYLOAD names service, tool and approval id and
// carries no arguments, that a 404/410 prunes and nothing else does, and that a failing
// push never fails the request. What it CANNOT yet pin, and leaves as the one `it.todo`
// below: that the bytes on the wire are a verifiable VAPID JWT over an encrypted body.
// That case becomes real when the transport lands, without moving anything else here.
//
// deps: test/harness/seed (namespace, TWO services and TWO accounts — the second of each
// is what the `stored_under_other_*` rows move a stored row onto, and nothing else in this
// file needs them) · server/src/approvals (Approvals) · server/src/registry (REDACTED,
// Registry — the redaction paths under test) · server/src/audit (record: the REAL recorder
// behind ApprovalsConfig.audit) · server/src/limits (APPROVAL_WINDOW_MS, RETENTION_DAYS) ·
// env.DB (real D1) · crypto.subtle (inside the module, hashing the binding)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Approvals } from "../../src/approvals";
import type {
  ApprovalClaim,
  ApprovalStatus,
  CheckResult,
  PushSubscriptionJson,
} from "../../src/approvals";
import { record } from "../../src/audit";
import type { JsonRpcResponse } from "../../src/gateway";
import type { Principal } from "../../src/identity";
import { APPROVAL_WINDOW_MS, RETENTION_DAYS } from "../../src/limits";
import { REDACTED, Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { seedNamespace } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * One `check()` call against one stored row state — the phase-1 decision table.
 *
 * The columns are the decision's real outputs, and they come apart on purpose: an
 * implementation can answer "required" correctly while inserting a duplicate row
 * (`inserts`), or reuse the row but mint a fresh id (`idSource`), or dedup the row but
 * re-notify the owner every retry (`pushes`) — three different bugs a single
 * outcome column would hide. `audits` is a list rather than a count because the ORDER of
 * a lazy `approval.expired` before a fresh `approval.requested` is the observable
 * difference between "expired then re-requested" and "re-requested then expired" in the
 * owner's ledger.
 *
 * `binding` names how the call relates to the stored row's DEDUP KEY — all four of
 * §7's columns, (account, service, tool, `args_hash`), not the arguments alone. Three
 * members vary the args in the vocabulary §7 distinguishes (identical, differing in a
 * visible argument, differing only in a redacted one — the last proving that hashing
 * happens after masking); the other two leave the args identical and move the row to a
 * SECOND seeded account or a second service, which is the only way to state that the
 * lookup is keyed by all four columns. Without them a `check()` whose SELECT omits
 * `service_account_id` hands account B the pass its owner granted to account A and
 * answers every other row of this table correctly.
 */
export type ApprovalCheckRow = {
  title: string;
  /**
   * The row check() finds, as STORED — which is not what a reader sees: `expired` is the
   * stored status, while `pending_past_expiry` and `approved_past_expiry` are rows whose
   * column still says otherwise and whose expiry only exists as an interpretation (§7).
   * Keeping both spellings in one column is the point: the two must read the same and
   * only one of them writes.
   */
  stored: "none" | ApprovalStatus | "pending_past_expiry" | "approved_past_expiry";
  binding:
    | "same"
    | "differs_in_visible_arg"
    | "differs_in_redacted_arg"
    /** identical args and tool, but the stored row belongs to a SECOND seeded account */
    | "stored_under_other_account"
    /** identical args and tool, but the stored row belongs to a second service */
    | "stored_under_other_service";
  outcome: CheckResult["outcome"];
  /** does check() insert a NEW pending row, or ride the stored one (§7 step 2)? */
  inserts: boolean;
  /** which row's id the caller is handed — the stable-id rule across retries */
  idSource: "stored_row" | "fresh_row";
  audits: readonly ("approval.requested" | "approval.expired")[];
  /** best-effort pushes attempted: one per NEW pending row, never on a dedup hit */
  pushes: 0 | 1;
};

/**
 * One `settle()` call against the raw response the gateway is about to relay.
 *
 * Deliberately tiny, because settle's power is deliberately tiny: consumption already
 * happened at claim, so the only question a row can ask is whether this response
 * RESTORES the pass. The MRTR wire shape is knowledge this module holds alone, which is
 * why `raw` names response shapes rather than spelling them — the fixture spelling is
 * contracts.test.ts's business.
 */
export type ApprovalSettleRow = {
  title: string;
  raw: "result_complete" | "result_input_required" | "error_response";
  after: Extract<ApprovalStatus, "used" | "approved">;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them. This table in particular is design work: it is where
 * the spec's approval prose becomes a decision matrix, and where its gaps surface.
 */
export const approvalCheckRows: readonly ApprovalCheckRow[] = [
  // How to read this table. Every row seeds ONE stored state, calls check() once, and reads
  // all five outputs. `binding` says how the call relates to the stored row's four-column
  // dedup key: the three arg-varying members keep the (account, service, tool) triple fixed
  // — so the redaction rows are rows of this table rather than a separate suite, §7's
  // trade-off ("redacted fields are excluded from the args binding, so a retry differing
  // only in a sensitive field still matches") being a statement about which ROW a call
  // lands on, which is exactly what check() answers — while the two `stored_under_other_*`
  // members hold the args identical and move the stored row off the caller's account or
  // service, which is where the lookup's key is stated rather than assumed.
  //
  // The stored vocabulary in one sentence: `expired` is a row whose COLUMN says expired,
  // while `pending_past_expiry` / `approved_past_expiry` are rows whose column still says
  // otherwise and whose expiry exists only as a read-time interpretation (§7: "treats
  // `expires_at < now` as expired regardless of stored status"). Both spellings must READ
  // the same and only one of them writes — the pair below is the whole point of keeping
  // them in one column. Reaching either is ApprovalsConfig.now()'s job: seed at t0, check
  // past t0 + limits.APPROVAL_WINDOW_MS, never a literal and never a sleep.
  //
  // `pushes` tracks `inserts` on every row here, and is a column anyway: an implementation
  // that dedups the row but re-notifies the owner on every retry is a real bug (§7: "no new
  // row is inserted and no new `approval.requested` audit row is written"), and a table
  // that derived pushes from inserts could not state that it must not happen.

  // §7 step 2: "Only when no such row exists does it record a fresh `pending` approval …
  // and reply with JSON-RPC error `-32003`", plus §7's push clause ("creating a `pending`
  // approval row sends a Web Push to every `push_subscription` row"). The baseline every
  // dedup row below is measured against.
  {
    title: "§7 step 2 · no row at all: one fresh pending row, one approval.requested, one push",
    stored: "none",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7 step 2: "if an unexpired `pending` row already exists for the same (account,
  // service, tool, `args_hash`), no new row is inserted and no new `approval.requested`
  // audit row is written — the reply is `-32003` carrying that row's existing
  // `approvalId`/`expiresAt`, so retries see a stable id and link." Four separate claims,
  // four columns, one row — and the title strategy §8 prints as its example.
  {
    title: "§7 step 2 · pending dedup returns same approvalId",
    stored: "pending",
    binding: "same",
    outcome: "required",
    inserts: false,
    idSource: "stored_row",
    audits: [],
    pushes: 0,
  },
  // §7 step 1: "The Worker looks for an `approval` row … with `status: approved` and
  // unexpired. Found → the call proceeds through the availability check". `inserts: false`
  // with no audit row is the observable half of "check never consumes": phase 1 answers
  // from the row and touches nothing, so the gateway can still refuse -32000 for free.
  {
    title: "§7 step 1 · an approved unexpired pass answers ok, writing nothing",
    stored: "approved",
    binding: "same",
    outcome: "ok",
    inserts: false,
    idSource: "stored_row",
    audits: [],
    pushes: 0,
  },
  // §7 step 4: "rejected or expired → `-32003` again with a fresh pending record and link."
  // A decided row is spent: it neither answers `ok` nor blocks the new pending insert (the
  // partial unique index covers `status = 'pending'` alone, migrations.test.ts's pin).
  {
    title: "§7 step 4 · a rejected row is spent: a fresh pending row, its own approval.requested and push",
    stored: "rejected",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7 step 4, the other half of the same sentence — a row whose COLUMN already reads
  // `expired` (the cron swept it, or a previous read flipped it). No second
  // `approval.expired`: the flip already happened and is audited exactly once, ever.
  {
    title: "§7 step 4 · a row already stored `expired` re-requests without a second approval.expired",
    stored: "expired",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7: "Approvals are single-use, args-bound, and expire 1 h after creation." A `used` row
  // is the pass a previous identical call already consumed — the retry after a successful
  // dispatch must re-ask, which is what makes exactly-once the caller's experience too.
  {
    title: "§7 · a used pass is no pass: the next identical call opens a fresh pending row",
    stored: "used",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7: "every path that reads or decides approvals … treats `expires_at < now` as expired
  // regardless of stored status, and at that moment flips any such `pending` row to
  // `expired`, writing the `approval.expired` audit row exactly once." The ORDER of the two
  // audit rows is the observable difference between "expired, then re-requested" and
  // "re-requested, then expired" in the owner's ledger — and the dedup implementation that
  // rides the stale pending row instead of flipping it fails on `inserts` and `idSource`.
  {
    title: "§7 · a past-expiry pending row is flipped first, then re-requested — approval.expired before approval.requested",
    stored: "pending_past_expiry",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.expired", "approval.requested"],
    pushes: 1,
  },
  // The twin of the row above, and the reason both spellings share one column: a past-expiry
  // APPROVED row reads as expired (so it never answers `ok`) but is never rewritten — §7
  // flips "any such `pending` row", nothing else. Same read, no write, no audit row: the
  // sharpest available statement that expiry is an interpretation rather than a write.
  {
    title: "§7 · a past-expiry approved row reads as expired but is never flipped — no approval.expired for a row that was not pending",
    stored: "approved_past_expiry",
    binding: "same",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7: "`args_hash` is computed over the **post-redaction** canonical JSON … redacted
  // fields are excluded from the args binding, so a retry differing only in a sensitive
  // field still matches — the owner is approving the visible arguments." Observed as a
  // dedup hit, never by inspecting a digest. This is the row the "hash before redaction"
  // mutation (strategy §9 rule 3) fails on: under it the masked values differ, so the retry
  // misses the stored row and inserts a second pending — `inserts` and `idSource` go red.
  {
    title: "§7 · a retry differing only in a redacted argument dedups onto the stored pending row — the hash is taken after masking",
    stored: "pending",
    binding: "differs_in_redacted_arg",
    outcome: "required",
    inserts: false,
    idSource: "stored_row",
    audits: [],
    pushes: 0,
  },
  // The twin that keeps the row above from being satisfied by "always dedup": a VISIBLE
  // argument is part of the binding, so the same pending row is not this call's row.
  {
    title: "§7 · a retry differing in a visible argument is a different binding: its own pending row, id, audit row and push",
    stored: "pending",
    binding: "differs_in_visible_arg",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // The same trade-off stated where it actually costs something, and stated deliberately:
  // an approved pass is SPENDABLE by a call whose secret differs, because the owner
  // approved the visible arguments (§7). If this row ever looks wrong, the spec sentence is
  // what changed — not the implementation (strategy §8's `spec:` commit).
  {
    title: "§7 · an approved pass answers ok for a retry differing only in a redacted argument — the owner approved the visible arguments",
    stored: "approved",
    binding: "differs_in_redacted_arg",
    outcome: "ok",
    inserts: false,
    idSource: "stored_row",
    audits: [],
    pushes: 0,
  },
  // Its twin: a visible difference is a different call, and an approved pass covers exactly
  // one binding. The pass survives untouched — this row's `inserts` says a pending row was
  // opened for the NEW binding, not that the old pass was disturbed.
  {
    title: "§7 · an approved pass does not cover a retry differing in a visible argument — that call opens its own pending row",
    stored: "approved",
    binding: "differs_in_visible_arg",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // §7 step 2's key is four columns — "(account, service, tool, `args_hash`)" — and the
  // three rows below are the two columns the args-varying rows above hold constant. Without
  // them a lookup that matches on (tool, args_hash) alone answers every other row of this
  // table correctly while letting account B ride the pass the owner granted to account A;
  // the partial unique index cannot catch it either, because a SELECT missing a key column
  // finds the wrong row before any insert is attempted. `tool` is the third column and is
  // covered by the index property at migrations.test.ts; these are the other two.
  //
  // The pending case first: another account's PENDING row is not this account's row to
  // dedup onto, so the call inserts its own — the mutation this kills is the "find any
  // matching pending row" shortcut the dedup rows above train an implementation toward.
  {
    title: "§7 step 2 · a pending row belonging to ANOTHER account is not this call's row: its own pending row, id, audit row and push",
    stored: "pending",
    binding: "stored_under_other_account",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // The one that is a privilege escalation rather than a duplicate row: another account's
  // APPROVED pass must never answer `ok` here. §7 step 1's lookup is the same four columns,
  // and an account that could spend a pass the owner granted to a different account has
  // walked straight past the grant model.
  {
    title: "§7 step 1 · an approved pass belonging to ANOTHER account never answers ok — the lookup is keyed by the account, not by tool and args",
    stored: "approved",
    binding: "stored_under_other_account",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
  // The service column, same shape: one approval authorizes one tool on ONE service. Two
  // services declaring the same tool name is ordinary (`search` is everywhere), which is
  // exactly why a lookup that drops `service_id` looks right until it is not.
  {
    title: "§7 · an approved pass on a DIFFERENT service never answers ok for the same tool name — one approval binds one service",
    stored: "approved",
    binding: "stored_under_other_service",
    outcome: "required",
    inserts: true,
    idSource: "fresh_row",
    audits: ["approval.requested"],
    pushes: 1,
  },
];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const approvalSettleRows: readonly ApprovalSettleRow[] = [
  // Three rows because settle has three inputs and exactly one of them restores. §7:
  // "a leg whose relayed result is MRTR `input_required` … flips it back to `approved` with
  // the same CAS discipline, so the exchange can continue on the original approval", against
  // §18 decision 15: an approval is "consumed on `resultType: "complete"` (or service
  // error), not at first dispatch". `raw` names response SHAPES; their fixture spelling is
  // contracts.test.ts's, so a wire-format change edits one fixture, not this table.

  // §7/§18 decision 15: the ordinary end of an exchange — the pass stays spent.
  {
    title: "§7 · a complete result leaves the pass used — the ordinary end of an exchange",
    raw: "result_complete",
    after: "used",
  },
  // §7: the ONE exception. One approval covers a whole MRTR exchange, so the follow-up leg
  // (same `params.arguments`, plus `inputResponses`/`requestState`) rides the original
  // approval — bounded by the same `expires_at`, never re-opened.
  {
    title: "§7 · an input_required leg restores the pass to approved — one approval covers the whole MRTR exchange",
    raw: "result_input_required",
    after: "approved",
  },
  // §18 decision 15: "(or service error)". A service error ends the exchange like a complete
  // result; only `input_required` restores, so an upstream that fails mid-elicitation costs
  // the caller a fresh -32003 rather than silently reopening the pass.
  {
    title: "§7 · an error response leaves the pass used — only input_required restores",
    raw: "error_response",
    after: "used",
  },
];

/**
 * A real instant, not 0: `sweepExpired` prunes past `retentionDays` counted BACK from the
 * clock, so a t0 near the epoch would make every fixture row older than retention the
 * moment a case advances the clock at all.
 */
const T0 = Date.UTC(2026, 7, 25, 9, 0, 0);

/** The origin this module builds `/approvals/<id>` on — the composition root's in production. */
const PUBLIC_ORIGIN = "https://hub.example.invalid";

/** Retention is pinned in DAYS (limits.RETENTION_DAYS); this is the arithmetic, not a limit. */
const DAY_MS = 24 * 60 * 60_000;

const TOOL = "get_news";

/**
 * One visible argument and one masked one, which is what makes the three arg-varying
 * bindings expressible: `secret` is the path the caller (the gateway, in production)
 * resolved as sensitive, so a call differing only there must land on the same row.
 * Obviously-fake values, like every credential-shaped string in this suite.
 */
const REDACT_PATHS = ["secret"];
const BASE_ARGS = { query: "weather", secret: "FAKE0000-secret-a" };
const VISIBLE_VARIANT = { query: "traffic", secret: "FAKE0000-secret-a" };
const REDACTED_VARIANT = { query: "weather", secret: "FAKE0000-secret-b" };

/** Never real keys: the transport seam is faked, so nothing here signs anything. */
const FAKE_VAPID = {
  publicKey: "FAKE0000-vapid-public",
  privateKey: "FAKE0000-vapid-private",
  subject: "mailto:owner@example.invalid",
};

/** The three raw responses settle judges, by the shapes ApprovalSettleRow names. */
const RAW_RESPONSES: Record<ApprovalSettleRow["raw"], JsonRpcResponse> = {
  result_complete: { jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [] } },
  result_input_required: {
    jsonrpc: "2.0",
    id: 1,
    result: {
      resultType: "input_required",
      inputRequest: { message: "which city?" },
      requestState: "FAKE0000-request-state",
    },
  },
  error_response: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "service unavailable" } },
};

/** One push the fake transport was handed — endpoint and the payload bytes, verbatim. */
type SentPush = { endpoint: string; payload: string };

/**
 * The per-case world: a seeded namespace, an Approvals wired to it, the INJECTED clock as
 * a writable field (`fx.now += APPROVAL_WINDOW_MS + 1` is how every expiry case reaches
 * past-expiry — no sleep, no fake timer, neither of which reaches workerd), the pushes the
 * fake transport received, and the status that transport answers per endpoint.
 */
type Fixture = {
  ns: SeededNamespace;
  approvals: Approvals;
  ownerId: string;
  now: number;
  sent: SentPush[];
  pushAnswers: Map<string, number | "reject">;
  service(slug: string): Service;
  principal(slug: string): Principal;
};

async function fixture(): Promise<Fixture> {
  const ns = await seedNamespace(env.DB, {
    services: [
      { slug: "news", kind: "tunnel" },
      { slug: "docs", kind: "tunnel" },
    ],
    accounts: [{ slug: "bot" }, { slug: "other" }],
  });
  const registry = new Registry(env.DB);
  const services: Record<string, Service> = {};
  for (const slug of ["news", "docs"]) {
    const detail = await registry.getService(ns.owner.userId, slug);
    if (!detail) throw new Error(`fixture: service "${slug}" is missing`);
    services[slug] = detail;
  }

  const clock = { now: T0 };
  const sent: SentPush[] = [];
  const pushAnswers = new Map<string, number | "reject">();
  const approvals = new Approvals({
    db: env.DB,
    publicOrigin: PUBLIC_ORIGIN,
    // The REAL recorder against the real table (§9: siblings are never faked) — the audit
    // assertions below read the rows it wrote, not a spy's array.
    audit: { record: (entry) => record(env.DB, entry) },
    vapid: FAKE_VAPID,
    retentionDays: RETENTION_DAYS,
    now: () => clock.now,
    push: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload });
      const answer = pushAnswers.get(subscription.endpoint) ?? 201;
      if (answer === "reject") throw new Error("fake push service: connection reset");
      return { status: answer };
    },
  });

  return {
    ns,
    approvals,
    ownerId: ns.owner.userId,
    get now() {
      return clock.now;
    },
    set now(value: number) {
      clock.now = value;
    },
    sent,
    pushAnswers,
    service: (slug) => services[slug],
    principal: (slug) => ({
      kind: "service_account",
      accountId: ns.accounts[slug].id,
      ownerId: ns.owner.userId,
      slug,
    }),
  };
}

/** The call under test, defaulted to the (bot, news, get_news) binding every row varies FROM. */
function check(
  fx: Fixture,
  args: Record<string, unknown> | undefined,
  where?: { account?: string; service?: string; paths?: string[] },
): Promise<CheckResult> {
  return fx.approvals.check(
    fx.principal(where?.account ?? "bot"),
    fx.service(where?.service ?? "news"),
    TOOL,
    args,
    where?.paths ?? REDACT_PATHS,
  );
}

// The three readers below go to D1 DIRECTLY, and only these three do. Two of the module's
// own read paths cannot answer what these cases ask: `list()` reports the INTERPRETED
// status, while half this table is about what the COLUMN says underneath it (a
// past-expiry approved row reads `expired` and must still be stored `approved`), and
// `audit.query` is not implemented yet. Reads only — every row in this file is still
// written through a production seam.
type D1Stmt = {
  bind(...values: unknown[]): D1Stmt;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
};
function db(): { prepare(sql: string): D1Stmt } {
  return env.DB as { prepare(sql: string): D1Stmt };
}

/** Every approval row in a namespace, oldest first — the delta is what `inserts` reads. */
async function approvalIds(ownerId: string): Promise<string[]> {
  const { results } = await db()
    .prepare(`SELECT id FROM approval WHERE owner_id = ? ORDER BY created_at, id`)
    .bind(ownerId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The namespace's approval lifecycle events IN ORDER — id order, since the injected clock
 *  is not audit's (record() stamps its own ts) and several cases write two rows at once. */
async function approvalEvents(ownerId: string): Promise<string[]> {
  const { results } = await db()
    .prepare(`SELECT event FROM audit WHERE owner_id = ? AND event LIKE 'approval.%' ORDER BY id`)
    .bind(ownerId)
    .all<{ event: string }>();
  return results.map((row) => row.event);
}

/** The STORED status — what the column says, before any read-time interpretation. */
async function storedStatus(id: string): Promise<string | null> {
  const row = await db()
    .prepare(`SELECT status FROM approval WHERE id = ?`)
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

/** The stored (post-redaction) arguments, as persisted. */
async function storedArgs(id: string): Promise<Record<string, unknown> | null> {
  const row = await db()
    .prepare(`SELECT args_json FROM approval WHERE id = ?`)
    .bind(id)
    .first<{ args_json: string }>();
  return row ? (JSON.parse(row.args_json) as Record<string, unknown>) : null;
}

async function pushEndpoints(userId: string): Promise<string[]> {
  const { results } = await db()
    .prepare(`SELECT endpoint FROM push_subscription WHERE user_id = ? ORDER BY endpoint`)
    .bind(userId)
    .all<{ endpoint: string }>();
  return results.map((row) => row.endpoint);
}

/**
 * Reach one `stored` state through the production seams alone — check opens it, decide
 * settles it, claim consumes it, the injected clock kills it. The distinction the column
 * carries is which of the last two happened: `expired` is swept (the COLUMN says expired),
 * while `*_past_expiry` only moves the clock and leaves the column alone.
 */
async function seedStored(
  fx: Fixture,
  stored: ApprovalCheckRow["stored"],
  where: { account: string; service: string },
): Promise<string | null> {
  if (stored === "none") return null;
  const opened = await check(fx, BASE_ARGS, where);
  if (opened.outcome !== "required") throw new Error("fixture: a first call must answer required");
  const id = opened.approvalId;
  switch (stored) {
    case "pending":
      break;
    case "approved":
    case "rejected":
      await fx.approvals.decide(fx.ownerId, id, stored === "approved" ? "approve" : "reject");
      break;
    case "used": {
      await fx.approvals.decide(fx.ownerId, id, "approve");
      const claim = await fx.approvals.claim(id);
      if (claim === "lost") throw new Error("fixture: an approved pass must claim");
      break;
    }
    case "expired":
      fx.now += APPROVAL_WINDOW_MS + 1;
      // The cron's sweep, not a read: it flips the column without opening anything new, so
      // the case that follows meets a row already stored `expired`.
      await fx.approvals.sweepExpired();
      break;
    case "pending_past_expiry":
      fx.now += APPROVAL_WINDOW_MS + 1;
      break;
    case "approved_past_expiry":
      await fx.approvals.decide(fx.ownerId, id, "approve");
      fx.now += APPROVAL_WINDOW_MS + 1;
      break;
  }
  return id;
}

/** check → decide → check → claim: the whole §7 walk, ending in a pass settle can move. */
async function claimedPass(fx: Fixture, args: Record<string, unknown> = BASE_ARGS): Promise<ApprovalClaim> {
  const opened = await check(fx, args);
  if (opened.outcome !== "required") throw new Error("fixture: a first call must answer required");
  await fx.approvals.decide(fx.ownerId, opened.approvalId, "approve");
  const pass = await check(fx, args);
  if (pass.outcome !== "ok") throw new Error("fixture: an approved pass must answer ok");
  const claim = await fx.approvals.claim(pass.approvalId);
  if (claim === "lost") throw new Error("fixture: an approved unexpired pass must claim");
  return claim;
}

/**
 * Registers one case per check row: seed the stored state, call check with the row's
 * binding, assert the outcome, the row count delta, the id's provenance, the audit
 * sequence and the push count. One law rides along and belongs to the whole table rather
 * than any row: check NEVER consumes — after every "required" answer the stored row is
 * unchanged except for a deliberate lazy-expiry flip, and after every "ok" answer the
 * approved row is still claimable.
 */
export function runApprovalCheckTable(rows: readonly ApprovalCheckRow[]): void {
  // deps: test/harness/seed · the fake push transport seam · server/src/approvals
  //       (Approvals) · injected now()
  for (const row of rows) {
    it(row.title, async () => {
      const fx = await fixture();
      // One subscribed browser, so `pushes` is a number this case can count at all — a push
      // is per subscription, and an owner with none is a different row's business.
      await fx.approvals.subscribePush(fx.ownerId, subscription("table"));
      // The two `stored_under_other_*` members move the STORED row; the call below is
      // always the same (bot, news) one, which is what states the key's other two columns.
      const where = {
        account: row.binding === "stored_under_other_account" ? "other" : "bot",
        service: row.binding === "stored_under_other_service" ? "docs" : "news",
      };
      const storedId = await seedStored(fx, row.stored, where);
      const storedBefore = storedId === null ? null : await storedStatus(storedId);

      const args =
        row.binding === "differs_in_visible_arg"
          ? VISIBLE_VARIANT
          : row.binding === "differs_in_redacted_arg"
            ? REDACTED_VARIANT
            : BASE_ARGS;

      const idsBefore = await approvalIds(fx.ownerId);
      const eventsBefore = await approvalEvents(fx.ownerId);
      const pushesBefore = fx.sent.length;

      const result = await check(fx, args);

      expect(result.outcome).toBe(row.outcome);
      const idsAfter = await approvalIds(fx.ownerId);
      expect(idsAfter.length - idsBefore.length).toBe(row.inserts ? 1 : 0);
      if (row.idSource === "stored_row") expect(result.approvalId).toBe(storedId);
      else expect(idsBefore).not.toContain(result.approvalId);
      expect((await approvalEvents(fx.ownerId)).slice(eventsBefore.length)).toEqual([...row.audits]);
      expect(fx.sent.length - pushesBefore).toBe(row.pushes);

      if (result.outcome === "required") {
        // The -32003 payload the gateway folds into `data` and into the message text.
        expect(result.approvalUrl).toBe(`${PUBLIC_ORIGIN}/approvals/${result.approvalId}`);
        expect(Date.parse(result.expiresAt)).toBeGreaterThan(fx.now);
        // Table law, refusal half: nothing was consumed. The ONE permitted write is the
        // lazy-expiry flip, and the row's own `audits` column says whether it happened.
        if (storedId !== null) {
          const flipped = row.audits.includes("approval.expired");
          expect(await storedStatus(storedId)).toBe(flipped ? "expired" : storedBefore);
        }
      } else {
        // Table law, ok half: check left the pass claimable — this is the offline-retry
        // guarantee stated from the row's side.
        expect(await fx.approvals.claim(result.approvalId)).toEqual({ id: result.approvalId });
      }
    });
  }
}

/**
 * Registers one case per settle row: claim a pass, settle it against the row's response
 * shape, assert the resulting status. Table law: settle only ever restores or leaves
 * consumed — no row moves a pass the caller never claimed, which the ApprovalClaim type
 * enforces statically and this asserts dynamically for the D1 write.
 */
export function runApprovalSettleTable(rows: readonly ApprovalSettleRow[]): void {
  // deps: test/harness/seed · server/src/approvals (Approvals)
  for (const row of rows) {
    it(row.title, async () => {
      const fx = await fixture();
      const claim = await claimedPass(fx);
      // The law, dynamically: a pass this claim never covered is not settle's to move. The
      // neighbour is a live PENDING row on a different binding — if settle wrote by id
      // alone rather than by the used→approved CAS, this is the row that would jump.
      const neighbour = await check(fx, VISIBLE_VARIANT);
      if (neighbour.outcome !== "required") throw new Error("fixture: a new binding must answer required");

      await fx.approvals.settle(claim, RAW_RESPONSES[row.raw]);

      expect(await storedStatus(claim.id)).toBe(row.after);
      await fx.approvals.settle({ id: neighbour.approvalId }, RAW_RESPONSES[row.raw]);
      expect(await storedStatus(neighbour.approvalId)).toBe("pending");
    });
  }
}

describe("§7 step 1–2 · check decides without consuming", () => {
  runApprovalCheckTable(approvalCheckRows);

  it("§7 step 1 · check leaves an approved row claimable — the pass survives a check that never reached claim (the offline-retry case, from this module's side)", async () => {
    const fx = await fixture();
    const opened = await check(fx, BASE_ARGS);
    if (opened.outcome !== "required") throw new Error("fixture: a first call must answer required");
    await fx.approvals.decide(fx.ownerId, opened.approvalId, "approve");

    // The gateway's availability probe refused -32000 here, so claim was never reached.
    const eventsBefore = await approvalEvents(fx.ownerId);
    const first = await check(fx, BASE_ARGS);
    expect(first).toEqual({ outcome: "ok", approvalId: opened.approvalId });
    expect(await storedStatus(opened.approvalId)).toBe("approved");

    // The retry once the service is back: same pass, same id, nothing spent in between.
    const second = await check(fx, BASE_ARGS);
    expect(second).toEqual({ outcome: "ok", approvalId: opened.approvalId });
    expect(await approvalEvents(fx.ownerId)).toEqual(eventsBefore);
    expect(await approvalIds(fx.ownerId)).toEqual([opened.approvalId]);
    expect(await fx.approvals.claim(opened.approvalId)).toEqual({ id: opened.approvalId });
  });
});

describe("§7 step 1 · the claim CAS", () => { // [OWNER-AUTHORED before implementation, §6]
  it("§7 step 1 · two claims on one approved row: exactly one ApprovalClaim, the other 'lost' — the changed-row count is the sole authority", async () => {
    const fx = await fixture();
    const opened = await check(fx, BASE_ARGS);
    if (opened.outcome !== "required") throw new Error("fixture: a first call must answer required");
    await fx.approvals.decide(fx.ownerId, opened.approvalId, "approve");
    const id = opened.approvalId;

    const outcomes = await Promise.all([fx.approvals.claim(id), fx.approvals.claim(id)]);

    expect(outcomes.filter((outcome) => outcome !== "lost")).toEqual([{ id }]);
    expect(outcomes.filter((outcome) => outcome === "lost")).toHaveLength(1);
    expect(await storedStatus(id)).toBe("used");
    // A third, serially: the row is spent however the first two interleaved.
    expect(await fx.approvals.claim(id)).toBe("lost");
  });

  it("§7 step 1 · a row that expired between check and claim answers 'lost', never a stale dispatch", async () => {
    const fx = await fixture();
    const opened = await check(fx, BASE_ARGS);
    if (opened.outcome !== "required") throw new Error("fixture: a first call must answer required");
    await fx.approvals.decide(fx.ownerId, opened.approvalId, "approve");
    const pass = await check(fx, BASE_ARGS);
    expect(pass.outcome).toBe("ok");

    fx.now += APPROVAL_WINDOW_MS + 1;

    expect(await fx.approvals.claim(opened.approvalId)).toBe("lost");
    // Read-time interpretation, not a write: the column is untouched by claim, and the
    // reader still calls it expired (§7 flips `pending` rows only).
    expect(await storedStatus(opened.approvalId)).toBe("approved");
    const [listed] = await fx.approvals.list(fx.ownerId);
    expect(listed.status).toBe("expired");
  });

  it("§7 step 2 · two concurrent identical first calls: one pending row, one approvalId, one approval.requested, one push — the constraint kills the race", async () => {
    const fx = await fixture();
    await fx.approvals.subscribePush(fx.ownerId, subscription("only"));

    const [first, second] = await Promise.all([check(fx, BASE_ARGS), check(fx, BASE_ARGS)]);

    expect(first.outcome).toBe("required");
    expect(second.approvalId).toBe(first.approvalId);
    expect(await approvalIds(fx.ownerId)).toEqual([first.approvalId]);
    expect(await approvalEvents(fx.ownerId)).toEqual(["approval.requested"]);
    expect(fx.sent).toHaveLength(1);
  });
});

describe("§7 · settle restores, never consumes", () => {
  runApprovalSettleTable(approvalSettleRows);

  it("§7 · dispatch that produced no response at all skips settle and leaves the pass consumed — at-most-once outranks sparing the owner a re-approval", async () => {
    const fx = await fixture();
    const claim = await claimedPass(fx);

    // The timeout/socket-drop branch: there is no response to settle against, so the
    // gateway calls nothing at all. The pass must stay spent — the call may have run.
    expect(await storedStatus(claim.id)).toBe("used");

    // And the caller's retry re-asks rather than riding the spent pass.
    const retry = await check(fx, BASE_ARGS);
    expect(retry.outcome).toBe("required");
    expect(retry.approvalId).not.toBe(claim.id);
  });
});

describe("§7 · what the pass is bound to", () => {
  it("§7 · post-redaction hashing, observed: two calls differing only in a redacted argument match the same row, and the stored arguments show the mask", async () => {
    const fx = await fixture();
    const first = await check(fx, BASE_ARGS);
    const retry = await check(fx, REDACTED_VARIANT);

    expect(retry.approvalId).toBe(first.approvalId);
    expect(await approvalIds(fx.ownerId)).toHaveLength(1);
    // The mask is not incidental: it is WHY the two calls match. The stored row holds the
    // sentinel, never either secret, and the visible argument survives for the owner to read.
    const args = await storedArgs(first.approvalId);
    expect(args).toEqual({ query: "weather", secret: REDACTED });
    expect(JSON.stringify(args)).not.toContain("FAKE0000-secret");
  });

  it("§7 · a call differing in a visible argument binds to a different row · twin to the case above", async () => {
    const fx = await fixture();
    const first = await check(fx, BASE_ARGS);
    const other = await check(fx, VISIBLE_VARIANT);

    expect(other.approvalId).not.toBe(first.approvalId);
    expect(await approvalIds(fx.ownerId)).toHaveLength(2);
    expect(await approvalEvents(fx.ownerId)).toEqual(["approval.requested", "approval.requested"]);
  });

  it("§7 · absent arguments and {} bind identically — canonicalJson's undefined ≡ {}", async () => {
    const fx = await fixture();
    const absent = await check(fx, undefined, { paths: [] });
    const empty = await check(fx, {}, { paths: [] });

    expect(empty.approvalId).toBe(absent.approvalId);
    expect(await approvalIds(fx.ownerId)).toHaveLength(1);
    expect(await storedArgs(absent.approvalId)).toEqual({});
  });

  it("§7 · MRTR inputResponses/requestState enter neither the binding nor the stored arguments · twin: the same call's params.arguments do", async () => {
    const fx = await fixture();
    // The gateway hands check `params.arguments` alone; these are the siblings it leaves
    // behind, spelled here so the case reads as the MRTR exchange it describes.
    const leg1 = { name: TOOL, arguments: BASE_ARGS };
    const leg2 = {
      name: TOOL,
      arguments: BASE_ARGS,
      inputResponses: { city: "FAKE0000-elicited-value" },
      requestState: "FAKE0000-request-state",
    };

    const first = await check(fx, leg1.arguments);
    const followUp = await check(fx, leg2.arguments);

    expect(followUp.approvalId).toBe(first.approvalId);
    const stored = JSON.stringify(await storedArgs(first.approvalId));
    expect(stored).not.toContain("inputResponses");
    expect(stored).not.toContain("requestState");
    expect(stored).not.toContain("FAKE0000-elicited-value");
    // The twin, one edit away: `params.arguments` IS the binding, so changing it moves the row.
    const different = await check(fx, { ...BASE_ARGS, query: "tides" });
    expect(different.approvalId).not.toBe(first.approvalId);
  });
});

describe("§7 · decide, list, and lazy expiry", () => {
  it("§7 · decide flips a pending row and writes its audit row; approving starts nothing — the agent's identical retry is what executes", async () => {
    const fx = await fixture();
    const approved = await check(fx, BASE_ARGS);
    const rejected = await check(fx, VISIBLE_VARIANT);

    await fx.approvals.decide(fx.ownerId, approved.approvalId, "approve");
    await fx.approvals.decide(fx.ownerId, rejected.approvalId, "reject");

    expect(await storedStatus(approved.approvalId)).toBe("approved");
    expect(await storedStatus(rejected.approvalId)).toBe("rejected");
    expect(await approvalEvents(fx.ownerId)).toEqual([
      "approval.requested",
      "approval.requested",
      "approval.approved",
      "approval.rejected",
    ]);
    const [decided] = await fx.approvals.list(fx.ownerId, { status: "approved" });
    expect(decided.decidedAt).not.toBeNull();

    // Approving started nothing: the pass is still whole, and the RETRY is what spends it.
    expect(await fx.approvals.claim(approved.approvalId)).toEqual({ id: approved.approvalId });
  });

  it("§7 · decide refuses an unknown id, another namespace's row, an already-decided row and a past-expiry row identically · twin: the owner's live pending row decides", async () => {
    const fx = await fixture();
    const stranger = await fixture();

    const decided = await check(fx, BASE_ARGS);
    await fx.approvals.decide(fx.ownerId, decided.approvalId, "approve");
    const foreign = await check(stranger, BASE_ARGS);
    const dying = await check(fx, VISIBLE_VARIANT);
    fx.now += APPROVAL_WINDOW_MS + 1;
    const live = await check(fx, { query: "tides", secret: "FAKE0000-secret-a" });

    const refusals: string[] = [];
    for (const id of [crypto.randomUUID(), foreign.approvalId, decided.approvalId, dying.approvalId]) {
      // The message is the whole assertion: four different reasons, one answer, so nothing
      // here tells a caller whether an id exists in a namespace that is not theirs. (Which
      // ERROR TYPE carries it to the wire is admin-pipeline.test.ts's, not this file's.)
      let message = "";
      try {
        await fx.approvals.decide(fx.ownerId, id, "approve");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(id);
      refusals.push(message);
    }
    expect(new Set(refusals).size).toBe(1);

    // Nothing moved that the refusals were not entitled to move: the foreign row is
    // untouched in its own namespace, the decided one keeps its decision, and only the
    // past-expiry pending row was rewritten — by the lazy-expiry rule every read applies.
    expect(await storedStatus(foreign.approvalId)).toBe("pending");
    expect(await storedStatus(decided.approvalId)).toBe("approved");
    expect(await storedStatus(dying.approvalId)).toBe("expired");

    // The twin, one edit away: the owner's own live pending row decides.
    await fx.approvals.decide(fx.ownerId, live.approvalId, "approve");
    expect(await storedStatus(live.approvalId)).toBe("approved");
  });

  it("§7 · a past-expiry pending row reads as expired on every path and is flipped once — a second read writes no second approval.expired", async () => {
    const fx = await fixture();
    const opened = await check(fx, BASE_ARGS);
    fx.now += APPROVAL_WINDOW_MS + 1;

    // Path 1, the list read: reports expired AND performs the one flip.
    const [listed] = await fx.approvals.list(fx.ownerId);
    expect(listed.status).toBe("expired");
    expect(await storedStatus(opened.approvalId)).toBe("expired");
    // Path 2, a second list read. Path 3, the gate — which re-requests, so it opens its own
    // row. Path 4, the cron sweep. Path 5, decide, which refuses.
    expect((await fx.approvals.list(fx.ownerId))[0].status).toBe("expired");
    const reRequest = await check(fx, BASE_ARGS);
    expect(reRequest.approvalId).not.toBe(opened.approvalId);
    await fx.approvals.sweepExpired();
    await expect(fx.approvals.decide(fx.ownerId, opened.approvalId, "approve")).rejects.toThrow();

    // Exactly one `approval.expired` across all five, and it landed BEFORE the re-request.
    expect(await approvalEvents(fx.ownerId)).toEqual([
      "approval.requested",
      "approval.expired",
      "approval.requested",
    ]);
  });

  it("§7 · list reports post-redaction arguments and applies the same lazy expiry as the gate, newest first", async () => {
    const fx = await fixture();
    const older = await check(fx, BASE_ARGS);
    fx.now += APPROVAL_WINDOW_MS + 1; // the older row is now past expiry
    const newer = await check(fx, VISIBLE_VARIANT, { account: "other" });

    const rows = await fx.approvals.list(fx.ownerId);

    expect(rows.map((row) => row.id)).toEqual([newer.approvalId, older.approvalId]);
    expect(rows.map((row) => row.status)).toEqual(["pending", "expired"]);
    // Slugs, not row ids — and the arguments post-redaction, the only form ever stored.
    expect(rows[0]).toMatchObject({ accountSlug: "other", serviceSlug: "news", tool: TOOL });
    expect(rows[1]).toMatchObject({ accountSlug: "bot", serviceSlug: "news" });
    expect(rows.map((row) => row.args)).toEqual([
      { query: "traffic", secret: REDACTED },
      { query: "weather", secret: REDACTED },
    ]);
    expect(JSON.stringify(rows)).not.toContain("FAKE0000-secret");
    // The same lazy expiry as the gate: reading flipped the dead row, once.
    expect(await storedStatus(older.approvalId)).toBe("expired");
    expect(await approvalEvents(fx.ownerId)).toEqual([
      "approval.requested",
      "approval.requested",
      "approval.expired",
    ]);
    // The filter narrows on the INTERPRETED status, which is the only one a reader sees.
    expect(await fx.approvals.list(fx.ownerId, { status: "pending" })).toHaveLength(1);
    expect(await fx.approvals.list(fx.ownerId, { limit: 1 })).toHaveLength(1);
  });

  it("§7/§15 · sweepExpired flips only what lazy expiry has not, then prunes past config.retentionDays — read from the injected config, never a literal", async () => {
    const fx = await fixture();
    // The sweep is hub-wide by design — one daily cron for every namespace — so its counts
    // are the DATABASE's, and this file's cases share one. Drain it first, from far enough
    // ahead that every earlier case's rows (some of which moved their own clock forward) are
    // past retention, and every count below is this case's own.
    fx.now = T0 + 2 * RETENTION_DAYS * DAY_MS;
    await fx.approvals.sweepExpired();
    const start = fx.now;

    const alreadyFlipped = await check(fx, BASE_ARGS);
    fx.now += APPROVAL_WINDOW_MS + 1;
    await fx.approvals.list(fx.ownerId); // a read got there first
    const untouched = await check(fx, VISIBLE_VARIANT);
    fx.now += APPROVAL_WINDOW_MS + 1;

    expect(await fx.approvals.sweepExpired()).toEqual({ expired: 1, pruned: 0 });
    expect(await storedStatus(untouched.approvalId)).toBe("expired");
    // One `approval.expired` per row, ever — whoever got there first.
    expect(await approvalEvents(fx.ownerId)).toEqual([
      "approval.requested",
      "approval.expired",
      "approval.requested",
      "approval.expired",
    ]);

    // Retention is the injected config's, read by NAME: at the window's edge nothing is old
    // enough yet, and one window past it both rows go.
    fx.now = start + RETENTION_DAYS * DAY_MS;
    expect(await fx.approvals.sweepExpired()).toEqual({ expired: 0, pruned: 0 });
    fx.now += APPROVAL_WINDOW_MS + 2;
    expect(await fx.approvals.sweepExpired()).toEqual({ expired: 0, pruned: 2 });
    expect(await approvalIds(fx.ownerId)).toEqual([]);
    expect(await storedStatus(alreadyFlipped.approvalId)).toBeNull();
  });
});

describe("§13/§15 · notifying the owner", () => {
  // PARKED, not skipped: there is no VAPID/RFC 8291 implementation to decrypt yet (see the
  // header note). The payload half of what it asserts — service, tool, id, and no arguments
  // — is pinned by the case below it, at the transport seam.
  it.todo("§13 · the push payload decrypts in-test: the VAPID ES256 JWT verifies against the configured key and subject, and the RFC 8291 body decrypts to service, tool and approval id — and carries no arguments, redacted or otherwise");

  it("§13 · a 404/410 from the push service prunes that subscription row; any other failure leaves it (a flaky push service must not unsubscribe the owner)", async () => {
    const fx = await fixture();
    for (const name of ["gone-404", "gone-410", "flaky-500", "broken"]) {
      await fx.approvals.subscribePush(fx.ownerId, subscription(name));
    }
    fx.pushAnswers.set(endpoint("gone-404"), 404);
    fx.pushAnswers.set(endpoint("gone-410"), 410);
    fx.pushAnswers.set(endpoint("flaky-500"), 500);
    fx.pushAnswers.set(endpoint("broken"), "reject");

    const opened = await check(fx, BASE_ARGS);

    // Every subscription was attempted — one dead endpoint never skips the rest.
    expect(fx.sent.map((push) => push.endpoint).sort()).toEqual(
      ["broken", "flaky-500", "gone-404", "gone-410"].map(endpoint),
    );
    // Only the two "this endpoint is gone" answers unsubscribe the owner.
    expect(await pushEndpoints(fx.ownerId)).toEqual([endpoint("broken"), endpoint("flaky-500")].sort());
    // §15: the payload names the service, the tool and the id — and no argument, masked or
    // otherwise, because it rests on a third-party push service.
    const payload = JSON.parse(fx.sent[0].payload) as Record<string, unknown>;
    expect(payload).toEqual({
      approvalId: opened.approvalId,
      service: "news",
      tool: TOOL,
      url: `${PUBLIC_ORIGIN}/approvals/${opened.approvalId}`,
    });
    expect(fx.sent[0].payload).not.toContain("weather");
    expect(fx.sent[0].payload).not.toContain(REDACTED);
  });

  it("§15 · notifyOwner never throws: a push endpoint that rejects, hangs or 500s still leaves the pending row created and the -32003-shaped result returned", async () => {
    const fx = await fixture();
    await fx.approvals.subscribePush(fx.ownerId, subscription("broken"));
    await fx.approvals.subscribePush(fx.ownerId, subscription("flaky-500"));
    fx.pushAnswers.set(endpoint("broken"), "reject");
    fx.pushAnswers.set(endpoint("flaky-500"), 500);

    const result = await check(fx, BASE_ARGS);

    // HONESTLY LABELLED: "rejects" and "500s" are exercised; a HANG is not. This seam is
    // awaited, so a push service that never answers would hold the request — bounding that
    // is the composition root's (a waitUntil or a transport-side deadline), and there is no
    // in-process oracle for it here.
    expect(result.outcome).toBe("required");
    if (result.outcome !== "required") return;
    expect(result.approvalUrl).toBe(`${PUBLIC_ORIGIN}/approvals/${result.approvalId}`);
    expect(Date.parse(result.expiresAt)).toBe(fx.now + APPROVAL_WINDOW_MS);
    expect(await storedStatus(result.approvalId)).toBe("pending");
    expect(await approvalEvents(fx.ownerId)).toEqual(["approval.requested"]);
    // A failure is not a prune: both browsers are still subscribed.
    expect(await pushEndpoints(fx.ownerId)).toHaveLength(2);
  });

  it("§13 · subscribePush upserts on endpoint — the same browser re-subscribing replaces its row, never duplicates it", async () => {
    const fx = await fixture();
    await fx.approvals.subscribePush(fx.ownerId, subscription("phone"));
    await fx.approvals.subscribePush(fx.ownerId, {
      endpoint: endpoint("phone"),
      keys: { p256dh: "FAKE0000-p256dh-rotated", auth: "FAKE0000-auth-rotated" },
    });
    await fx.approvals.subscribePush(fx.ownerId, subscription("laptop"));

    expect(await pushEndpoints(fx.ownerId)).toEqual([endpoint("laptop"), endpoint("phone")].sort());
    // Replaced, not merely deduped: the re-subscribe's keys are the ones a push now uses.
    await check(fx, BASE_ARGS);
    expect(fx.sent.filter((push) => push.endpoint === endpoint("phone"))).toHaveLength(1);
    const keys = await db()
      .prepare(`SELECT keys_json FROM push_subscription WHERE endpoint = ?`)
      .bind(endpoint("phone"))
      .first<{ keys_json: string }>();
    expect(JSON.parse(keys?.keys_json ?? "{}")).toEqual({
      p256dh: "FAKE0000-p256dh-rotated",
      auth: "FAKE0000-auth-rotated",
    });
  });
});

/** A browser's subscription, as `PushSubscription.toJSON()` hands it out — obviously fake. */
function subscription(name: string): PushSubscriptionJson {
  return {
    endpoint: endpoint(name),
    keys: { p256dh: `FAKE0000-p256dh-${name}`, auth: `FAKE0000-auth-${name}` },
  };
}

function endpoint(name: string): string {
  return `https://push.example.invalid/${name}`;
}
