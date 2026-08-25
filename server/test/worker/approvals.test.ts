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
// deps: test/harness/seed (namespace, service, account, catalog) · test/harness/
// fake-upstream (outboundService router: the fake push endpoint) · server/src/approvals
// (Approvals, canonicalJson) · server/src/registry (applyRedaction paths under test) ·
// server/src/limits (APPROVAL_WINDOW_MS, RETENTION_DAYS) · env.DB (real D1) ·
// crypto.subtle (VAPID verification + RFC 8291 decryption in the fake endpoint)

import { describe, it } from "vitest";
import type { ApprovalStatus, CheckResult } from "../../src/approvals";

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
 * `binding` names how the retry's arguments relate to the stored row's, in the vocabulary
 * §7 actually distinguishes: identical, differing in a visible argument, differing only
 * in a redacted one — the last being the row that proves hashing happens after masking.
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
  binding: "same" | "differs_in_visible_arg" | "differs_in_redacted_arg";
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
export const approvalCheckRows: readonly ApprovalCheckRow[] = [];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const approvalSettleRows: readonly ApprovalSettleRow[] = [];

/**
 * Registers one case per check row: seed the stored state, call check with the row's
 * binding, assert the outcome, the row count delta, the id's provenance, the audit
 * sequence and the push count. One law rides along and belongs to the whole table rather
 * than any row: check NEVER consumes — after every "required" answer the stored row is
 * unchanged except for a deliberate lazy-expiry flip, and after every "ok" answer the
 * approved row is still claimable.
 */
export function runApprovalCheckTable(rows: readonly ApprovalCheckRow[]): void {
  // deps: test/harness/seed · test/harness/fake-upstream (push endpoint) ·
  //       server/src/approvals (Approvals) · injected now()
  throw new Error("unimplemented");
}

/**
 * Registers one case per settle row: claim a pass, settle it against the row's response
 * shape, assert the resulting status. Table law: settle only ever restores or leaves
 * consumed — no row moves a pass the caller never claimed, which the ApprovalClaim type
 * enforces statically and this asserts dynamically for the D1 write.
 */
export function runApprovalSettleTable(rows: readonly ApprovalSettleRow[]): void {
  // deps: test/harness/seed · server/src/approvals (Approvals)
  throw new Error("unimplemented");
}

describe("§7 step 1–2 · check decides without consuming", () => {
  it.todo("one case per approvalCheckRow — title as authored, e.g. \"§7 step 2 · pending dedup returns same approvalId\"");
  it.todo("§7 step 1 · check leaves an approved row claimable — the pass survives a check that never reached claim (the offline-retry case, from this module's side)");
});

describe("§7 step 1 · the claim CAS", () => { // [OWNER-AUTHORED before implementation, §6]
  it.todo("§7 step 1 · two claims on one approved row: exactly one ApprovalClaim, the other 'lost' — the changed-row count is the sole authority");
  it.todo("§7 step 1 · a row that expired between check and claim answers 'lost', never a stale dispatch");
  it.todo("§7 step 2 · two concurrent identical first calls: one pending row, one approvalId, one approval.requested, one push — the constraint kills the race");
});

describe("§7 · settle restores, never consumes", () => {
  it.todo("one case per approvalSettleRow — title as authored");
  it.todo("§7 · dispatch that produced no response at all skips settle and leaves the pass consumed — at-most-once outranks sparing the owner a re-approval");
});

describe("§7 · what the pass is bound to", () => {
  it.todo("§7 · post-redaction hashing, observed: two calls differing only in a redacted argument match the same row, and the stored arguments show the mask");
  it.todo("§7 · a call differing in a visible argument binds to a different row · twin to the case above");
  it.todo("§7 · absent arguments and {} bind identically — canonicalJson's undefined ≡ {}");
  it.todo("§7 · MRTR inputResponses/requestState enter neither the binding nor the stored arguments · twin: the same call's params.arguments do");
});

describe("§7 · decide, list, and lazy expiry", () => {
  it.todo("§7 · decide flips a pending row and writes its audit row; approving starts nothing — the agent's identical retry is what executes");
  it.todo("§7 · decide refuses an unknown id, another namespace's row, an already-decided row and a past-expiry row identically · twin: the owner's live pending row decides");
  it.todo("§7 · a past-expiry pending row reads as expired on every path and is flipped once — a second read writes no second approval.expired");
  it.todo("§7 · list reports post-redaction arguments and applies the same lazy expiry as the gate, newest first");
  it.todo("§7/§15 · sweepExpired flips only what lazy expiry has not, then prunes past config.retentionDays — read from the injected config, never a literal");
});

describe("§13/§15 · notifying the owner", () => {
  it.todo("§13 · the push payload decrypts in-test: the VAPID ES256 JWT verifies against the configured key and subject, and the RFC 8291 body decrypts to service, tool and approval id — and carries no arguments, redacted or otherwise");
  it.todo("§13 · a 404/410 from the push service prunes that subscription row; any other failure leaves it (a flaky push service must not unsubscribe the owner)");
  it.todo("§15 · notifyOwner never throws: a push endpoint that rejects, hangs or 500s still leaves the pending row created and the -32003-shaped result returned");
  it.todo("§13 · subscribePush upserts on endpoint — the same browser re-subscribing replaces its row, never duplicates it");
});
