/**
 * approvals.ts — the approval gate: a single-use, args-bound pass the owner grants
 * for one specific tool call, spent by an identical retry.
 *
 * OWNS the whole lifecycle of the `approval` table and everything that touches it:
 * the canonical-JSON argument binding (`canonicalJson` is the system's one
 * definition of "identical retry"), redaction of sensitive fields before anything
 * is hashed or stored, pending-row dedup, the atomic claim, MRTR settlement, lazy
 * expiry, and Web Push notification of the owner (the web surface only collects
 * subscriptions — sending lives here).
 *
 * HIDES:
 * - args_hash derivation: SHA-256 over the canonical sorted-keys JSON of
 *   `params.arguments`, computed POST-redaction — no digest of a secret is ever
 *   persisted. Callers never see or compute hashes.
 * - The concurrent-first-call race: a D1 partial unique index on
 *   (service_account_id, service_id, tool, args_hash) WHERE status = 'pending'
 *   (declared in this module's migration; §5's table plus this constraint) means
 *   the CONSTRAINT, not application code, kills the race — a losing insert
 *   re-reads and returns the winner's row.
 * - The claim CAS: UPDATE … WHERE status = 'approved', with the changed-row count
 *   as the sole authority on who dispatches — N concurrent identical calls
 *   resolve to exactly one execution.
 * - MRTR result-shape knowledge: settle() inspects the raw JSON-RPC response for
 *   `resultType: "input_required"`, so no other module learns MRTR's wire shape.
 * - Expiry as a read-time interpretation: `expires_at < now` reads as `expired`
 *   on every path regardless of stored status; only `pending` rows are ever
 *   rewritten (flipped to `expired`, audited exactly once). No hourly job.
 *
 * The three-phase interface (check → claim → settle) exists to make the spec's
 * pinned ordering expressible: the gateway verifies service AVAILABILITY between
 * check and claim, so an approved retry that hits an offline service gets -32000
 * without consuming the approval — the owner never re-approves because a bot was
 * mid-reconnect.
 */

import type { Principal } from "./identity";
import type { Service } from "./registry";
import type { JsonRpcResponse } from "./gateway";
import type { AuditEntry } from "./audit";

/** Cloudflare D1 binding (`D1Database` from `@cloudflare/workers-types`) — opaque here. */
type D1Database = unknown;

/**
 * Proof of a successful claim(). Only claim() mints one; settle() takes it — and
 * not a bare id string — so the type system enforces that nothing settles a pass
 * it never claimed.
 */
export type ApprovalClaim = { readonly id: string };

/**
 * check()'s verdict. "ok": an approved, unexpired pass exists — verify
 * availability, then claim(). "required": no usable pass — the gateway folds
 * id/URL/expiry into the -32003 error `data` (and into the message text, so an
 * agent that only surfaces error strings still hands its user a link).
 * `expiresAt` is ISO-8601.
 */
export type CheckResult =
  | { outcome: "ok"; approvalId: string }
  | { outcome: "required"; approvalId: string; approvalUrl: string; expiresAt: string };

/**
 * Stored status vocabulary (§5). What a reader sees can differ from the column:
 * past-expiry rows are reported `expired` whatever is stored — expiry is an
 * interpretation applied at read time, not primarily a write.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

/**
 * One approval as shown to the owner (`approval_list`, `/approvals`): slugs
 * instead of row ids, arguments post-redaction (the only form ever stored),
 * ISO-8601 timestamps. `decidedAt` is null while pending.
 */
export type ApprovalRow = {
  id: string;
  accountSlug: string;
  serviceSlug: string;
  tool: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
};

/** `approval_list`'s filter surface: `status` narrows, `limit` caps (default 100, matching audit_query). */
export type ApprovalListFilters = { status?: ApprovalStatus; limit?: number };

/**
 * A browser push subscription exactly as `PushSubscription.toJSON()` hands it
 * out — stored verbatim in `push_subscription` (§5); this module is its only
 * reader.
 */
export type PushSubscriptionJson = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Wiring, supplied once by the composition root: the control-plane D1 binding;
 * the canonical public origin (the root owns the origin, this module owns the
 * `/approvals/<id>` path built on it); the audit recorder, which is AWAITED — a
 * failed audit write fails the request; and the VAPID keypair from Worker
 * secrets (`subject` is the `mailto:`/URL claim pushed services require).
 */
export type ApprovalsConfig = {
  db: D1Database;
  /** Scheme + host only, no trailing slash — e.g. "https://mcp.example.com". */
  publicOrigin: string;
  audit: { record(entry: AuditEntry): Promise<void> };
  vapid: { publicKey: string; privateKey: string; subject: string };
  /**
   * The clock, epoch ms. Injected because expiry is a read-time interpretation
   * and workerd tests cannot fake global timers — every expiry and window
   * judgment in this module reads it, never Date.now().
   */
  now(): number;
};

/**
 * The approval gate, constructed per request by the composition root (D1
 * bindings are request-scoped). The gateway drives check/claim/settle; the admin
 * ops table and web handlers drive decide/list/subscribePush; the daily cron
 * drives sweepExpired.
 */
export class Approvals {
  constructor(private readonly config: ApprovalsConfig) {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Phase 1 — decide whether this call may proceed, without consuming anything.
   *
   * Looks for an unexpired `approved` row matching (account, service, tool,
   * args_hash), where args_hash binds the post-redaction canonical JSON of
   * `args` — `params.arguments` only; MRTR `inputResponses`/`requestState`
   * never enter the binding, and absent `args` binds as `{}` so an
   * argument-less retry matches however the client spells it. Found →
   * `{ outcome: "ok" }`: the caller must verify service availability and then
   * claim() — check() alone never authorizes dispatch, and it leaves the row
   * untouched so an unavailable service costs the owner nothing.
   *
   * Otherwise → `{ outcome: "required", … }`. An existing unexpired `pending`
   * row for the same binding is returned as-is — stable id across retries, no
   * new row, audit entry, or push. Only when none exists is a fresh pending row
   * inserted (redacted arguments and all — the only place the hub ever persists
   * tool arguments), expiring 1 h from creation (one window covering the
   * pending wait and the post-approval retry), with an `approval.requested`
   * audit row and a best-effort push to the owner.
   *
   * The caller refuses known-unavailable services with -32000 BEFORE invoking
   * check (§7) — this module never probes availability itself, and a pending row
   * is never created for a service the hub already knows cannot execute.
   *
   * `principal` must be a service-account principal — owners are never
   * approval-gated, so the filter never routes them here. `redactPaths` are
   * dot-separated paths into `args` (the caller resolves the writeOnly/config
   * union); masking is registry.applyRedaction — the one definition — applied
   * before anything is hashed or stored.
   */
  async check(
    principal: Principal,
    service: Service,
    tool: string,
    args: Record<string, unknown> | undefined,
    redactPaths: string[],
  ): Promise<CheckResult> {
    // deps: canonicalJson · registry.applyRedaction · notifyOwner · crypto.subtle · D1 `approval` · audit.record
    throw new Error("unimplemented");
  }

  /**
   * Phase 2 — atomically consume the approved pass a check() "ok" named.
   *
   * Atomic: exactly one of N concurrent identical calls wins, however they
   * interleave. Returns the claim on success; "lost" when
   * the row is no longer claimable (a concurrent call consumed it, or it expired
   * since check) — treat "lost" as no approval and re-enter check() for the
   * fresh -32003. Dispatch only after a successful claim, never after "lost".
   */
  async claim(approvalId: string): Promise<ApprovalClaim | "lost"> {
    // deps: D1 `approval`
    throw new Error("unimplemented");
  }

  /**
   * Phase 3 — settle a claimed pass against the raw JSON-RPC response the
   * gateway is about to relay.
   *
   * Consumption already happened at claim(); settle's only power is
   * restoration: a result indicating an input-required MRTR leg flips the row
   * back to `approved` so follow-up legs ride the
   * original approval until a complete result or service error. Any other
   * result, and any error response, leaves the pass consumed. It takes the RAW
   * response precisely so MRTR's wire shape is known nowhere else. If dispatch
   * produced no response at all (timeout, socket drop), skip settle — the pass
   * stays consumed, because the call may already have reached the service
   * (every tools/call is at-most-once, §15).
   */
  async settle(claim: ApprovalClaim, rawResult: JsonRpcResponse): Promise<void> {
    // deps: D1 `approval`
    throw new Error("unimplemented");
  }

  /**
   * The owner's decision on a pending request — the one implementation behind
   * `approval_decide`, `/approvals`, and `pmcp approve|reject`.
   *
   * Flips the row to `approved`/`rejected`, stamps `decided_at`, writes the
   * `approval.approved`/`approval.rejected` audit row. Only an unexpired
   * `pending` row in `ownerId`'s namespace qualifies: an unknown id, another
   * namespace's row, an already-decided row, or a past-expiry one (flipped to
   * `expired` here, lazily) throws HubError. Approving starts nothing — the
   * agent's identical retry is what executes.
   */
  async decide(ownerId: string, id: string, decision: "approve" | "reject"): Promise<void> {
    // deps: D1 `approval` · audit.record · gateway.HubError
    throw new Error("unimplemented");
  }

  /**
   * Approval requests in `ownerId`'s namespace, newest first — pending and
   * history alike; backs `approval_list` and `/approvals`. Reading applies lazy
   * expiry: past-expiry rows are reported `expired` regardless of stored
   * status, and any such `pending` row is flipped (with its `approval.expired`
   * audit row, exactly once) as a side effect. Row arguments are
   * post-redaction — nothing else was ever stored.
   */
  async list(ownerId: string, filters?: ApprovalListFilters): Promise<ApprovalRow[]> {
    // deps: D1 `approval` · D1 `service` · D1 `service_account` · audit.record
    throw new Error("unimplemented");
  }

  /**
   * Register a browser's push subscription for `userId`'s approval
   * notifications (the `/approvals` "Enable notifications" control). Upserts on
   * endpoint — re-subscribing the same browser replaces, never duplicates.
   * Sending, payload shape, and pruning of dead endpoints all live inside this
   * module; subscribers only ever call this.
   */
  async subscribePush(userId: string, subscription: PushSubscriptionJson): Promise<void> {
    // deps: D1 `push_subscription` · crypto.randomUUID
    throw new Error("unimplemented");
  }

  /**
   * Daily-cron housekeeping: flips every remaining past-expiry `pending` row to
   * `expired` (writing each `approval.expired` audit row exactly once — lazy
   * expiry means most were already flipped at read time), then prunes rows
   * older than 90 days (approval rows are the hub's only persisted arguments,
   * so they age out on audit's schedule, §15). Returns counts for the cron's
   * ops log.
   */
  async sweepExpired(): Promise<{ expired: number; pruned: number }> {
    // deps: D1 `approval` · audit.record
    throw new Error("unimplemented");
  }

  /**
   * Best-effort Web Push to every subscription of the namespace owner: names
   * the service and tool plus the approval id — NEVER arguments (payloads rest
   * on third-party push services; §15's hygiene rule). VAPID ES256 + RFC 8291
   * payload encryption via a small Workers-compatible webpush library (e.g.
   * webpush-webcrypto — do not hand-roll the crypto); tapping the notification
   * opens `/approvals/<id>`. A 404/410 from a push service prunes that
   * subscription row. Never throws — a push failure must not fail the request
   * that created the row.
   */
  private async notifyOwner(
    ownerId: string,
    approvalId: string,
    serviceSlug: string,
    tool: string,
  ): Promise<void> {
    // deps: D1 `push_subscription` · webpush-webcrypto (VAPID ES256 + RFC 8291) · fetch
    throw new Error("unimplemented");
  }
}

/**
 * The system's one definition of argument identity — exported so "retry with
 * identical arguments" means exactly one thing everywhere (hub, CLI, tests):
 * two argument objects retry-match iff their canonicalJson strings are equal.
 * Deterministic JSON: object keys sorted at every depth, arrays kept in order,
 * no insignificant whitespace, scalars as JSON.stringify renders them,
 * undefined-valued properties omitted. Throws on values JSON cannot represent
 * (cycles, BigInt).
 */
export function canonicalJson(value: unknown): string {
  // deps: none
  throw new Error("unimplemented");
}
