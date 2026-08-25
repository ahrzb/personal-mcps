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

import { formatPrincipal } from "./principal";
import type { Principal } from "./principal";
import { applyRedaction } from "./registry";
import type { Service } from "./registry";
import { CODES, HubError } from "./errors";
import type { JsonRpcResponse } from "./gateway";
import type { AuditEntry } from "./audit";
import { APPROVAL_WINDOW_MS } from "./limits";

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
   * Retention in days, resolved once by the composition root (AUDIT_RETENTION_DAYS
   * env var or limits.RETENTION_DAYS): approval rows age out on audit's schedule
   * (§15), and sweepExpired prunes past this.
   */
  retentionDays: number;
  /**
   * The clock, epoch ms. Injected because expiry is a read-time interpretation
   * and workerd tests cannot fake global timers — every expiry and window
   * judgment in this module reads it, never Date.now().
   */
  now(): number;
  /**
   * The Web Push TRANSPORT, and nothing else: one encrypted POST to one
   * subscription, answering the push service's status. Everything ABOUT a push
   * — which subscriptions receive it, what the payload may name (§15: never
   * arguments), and that a 404/410 prunes the row — stays inside notifyOwner;
   * this seam hides only the VAPID ES256 + RFC 8291 crypto, which is a
   * library's job and not this module's (the header's webpush-webcrypto).
   * Absent = no transport wired, so nothing is sent — a push is best-effort by
   * contract, and an unwired hub must not fail the request that created the row.
   */
  push?(subscription: PushSubscriptionJson, payload: string): Promise<{ status: number }>;
};

/**
 * The approval gate, constructed per request by the composition root (D1
 * bindings are request-scoped). The gateway drives check/claim/settle; the admin
 * ops table and web handlers drive decide/list/subscribePush; the daily cron
 * drives sweepExpired.
 */
export class Approvals {
  private readonly db: D1Like;

  constructor(private readonly config: ApprovalsConfig) {
    // deps: none
    this.db = config.db as D1Like;
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
   * inserted (arguments post-redaction, like every body the hub persists, §15),
   * expiring 1 h from creation (one window covering the
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
    if (principal.kind !== "service_account") {
      // Owners are never approval-gated (§7), so the filter never routes them here; a
      // caller that does has lost the principal, which is a bug rather than a refusal.
      throw new Error("approvals.check: only a service-account principal is approval-gated");
    }
    const masked = applyRedaction(args ?? {}, redactPaths);
    const argsHash = await sha256Hex(canonicalJson(masked));
    const now = this.config.now();

    // One read covers both step-1 (approved) and step-2 (pending) lookups — same four-column
    // key, and the two answers differ only in which live row came back.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM approval
         WHERE service_account_id = ? AND service_id = ? AND tool = ? AND args_hash = ?
           AND status IN ('pending', 'approved')`,
      )
      .bind(principal.accountId, service.id, tool, argsHash)
      .all<ApprovalDbRow>();

    // Lazy expiry, applied BEFORE the decision and before any insert: the flip is what makes
    // the owner's ledger read "expired, then re-requested" rather than the reverse (§7).
    for (const row of results) {
      if (row.expires_at < now && row.status === "pending") await this.flipExpired(row, service.slug);
    }
    const live = results.filter((row) => row.expires_at >= now);
    const approved = live.find((row) => row.status === "approved");
    if (approved) return { outcome: "ok", approvalId: approved.id };
    const pending = live.find((row) => row.status === "pending");
    if (pending) return required(pending, this.config.publicOrigin);

    const fresh: ApprovalDbRow = {
      id: crypto.randomUUID(),
      owner_id: service.ownerId,
      service_account_id: principal.accountId,
      service_id: service.id,
      tool,
      args_hash: argsHash,
      args_json: JSON.stringify(masked),
      status: "pending",
      created_at: now,
      decided_at: null,
      expires_at: now + APPROVAL_WINDOW_MS,
    };
    try {
      await this.db
        .prepare(
          `INSERT INTO approval (id, owner_id, service_account_id, service_id, tool,
             args_hash, args_json, status, created_at, decided_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          fresh.id,
          fresh.owner_id,
          fresh.service_account_id,
          fresh.service_id,
          fresh.tool,
          fresh.args_hash,
          fresh.args_json,
          fresh.status,
          fresh.created_at,
          fresh.decided_at,
          fresh.expires_at,
        )
        .run();
    } catch (err) {
      // The partial unique index — not this code — killed the race (§7 step 2). The loser
      // re-reads and returns the WINNER's row: same id, no second audit row, no second push.
      const winner = await this.db
        .prepare(
          `SELECT * FROM approval
           WHERE service_account_id = ? AND service_id = ? AND tool = ? AND args_hash = ?
             AND status = 'pending' AND expires_at >= ?`,
        )
        .bind(principal.accountId, service.id, tool, argsHash, now)
        .first<ApprovalDbRow>();
      if (!winner) throw err;
      return required(winner, this.config.publicOrigin);
    }

    await this.config.audit.record({
      ownerId: fresh.owner_id,
      principal: formatPrincipal(principal),
      event: "approval.requested",
      service: service.slug,
      tool,
      outcome: "ok",
      detail: { approvalId: fresh.id },
    });
    await this.notifyOwner(fresh.owner_id, fresh.id, service.slug, tool);
    return required(fresh, this.config.publicOrigin);
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
    const now = this.config.now();
    // §7 step 1's CAS verbatim, plus the lazy-expiry clause every path carries: a row that
    // died between check and claim is not claimable, and the changed-row count is the sole
    // authority on who dispatches.
    const { meta } = await this.db
      .prepare(
        `UPDATE approval SET status = 'used', decided_at = ?
         WHERE id = ? AND status = 'approved' AND expires_at >= ?`,
      )
      .bind(now, approvalId, now)
      .run();
    return meta.changes === 1 ? { id: approvalId } : "lost";
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
    const result = rawResult.result;
    const inputRequired =
      rawResult.error === undefined &&
      typeof result === "object" &&
      result !== null &&
      (result as Record<string, unknown>).resultType === "input_required";
    if (!inputRequired) return; // complete result or service error: the pass stays spent.
    // Same CAS discipline as the claim (§7): only the row THIS claim consumed is restored.
    await this.db
      .prepare(`UPDATE approval SET status = 'approved' WHERE id = ? AND status = 'used'`)
      .bind(claim.id)
      .run();
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
    // deps: D1 `approval` · audit.record · errors.HubError
    const now = this.config.now();
    const row = await this.db
      .prepare(
        `SELECT a.*, s.slug AS service_slug, u."username" AS owner_username FROM approval a
         JOIN service s ON s.id = a.service_id
         JOIN "user" u ON u."id" = a.owner_id
         WHERE a.id = ? AND a.owner_id = ?`,
      )
      .bind(id, ownerId)
      .first<ApprovalDbRow & { service_slug: string; owner_username: string }>();
    // Lazy expiry is applied here too, before the refusal: a past-expiry pending row is
    // flipped (audited once) and only then refused, so `approval_decide` leaves the ledger
    // in the same state a read of the same row would have (§7).
    if (row && row.status === "pending" && row.expires_at < now) {
      await this.flipExpired(row, row.service_slug);
    }
    if (!row || row.status !== "pending" || row.expires_at < now) {
      // ONE message for all four refusals — unknown id, another namespace's row, an
      // already-decided row, a dead one. A distinguishing message would let a caller probe
      // for ids outside its namespace, the same reason -32001 is indistinguishable (§7),
      // which is also why the code is READ from the pinned table rather than re-spelled.
      throw new HubError(CODES.notPermitted, "no decidable approval request");
    }

    const status = decision === "approve" ? "approved" : "rejected";
    await this.db
      .prepare(`UPDATE approval SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(status, now, id)
      .run();
    await this.config.audit.record({
      ownerId,
      // The decider is the namespace owner by construction: only their session reaches here.
      principal: formatPrincipal({
        kind: "user",
        userId: ownerId,
        username: row.owner_username,
      }),
      event: `approval.${status}`,
      service: row.service_slug,
      tool: row.tool,
      outcome: "ok",
      detail: { approvalId: id },
    });
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
    const now = this.config.now();
    // ponytail: the whole namespace is read, then interpreted and filtered in JS, because a
    // `status` filter is a filter on the INTERPRETED status — a past-expiry `approved` row
    // must not answer a `status: "approved"` query, which SQL over the column cannot say.
    // Retention (§15, days) bounds the table; push the filter into SQL only if it stops being
    // small.
    const { results } = await this.db
      .prepare(
        `SELECT a.*, s.slug AS service_slug, sa.slug AS account_slug FROM approval a
         JOIN service s ON s.id = a.service_id
         JOIN service_account sa ON sa.id = a.service_account_id
         WHERE a.owner_id = ? ORDER BY a.created_at DESC`,
      )
      .bind(ownerId)
      .all<ApprovalDbRow & { service_slug: string; account_slug: string }>();

    const rows: ApprovalRow[] = [];
    for (const row of results) {
      if (row.expires_at < now && row.status === "pending") await this.flipExpired(row, row.service_slug);
      rows.push({
        id: row.id,
        accountSlug: row.account_slug,
        serviceSlug: row.service_slug,
        tool: row.tool,
        args: JSON.parse(row.args_json) as Record<string, unknown>,
        status: readStatus(row, now),
        createdAt: new Date(row.created_at).toISOString(),
        decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      });
    }
    const matching = filters?.status ? rows.filter((row) => row.status === filters.status) : rows;
    return matching.slice(0, filters?.limit ?? DEFAULT_LIST_LIMIT);
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
    // The endpoint's UNIQUE constraint is what makes re-subscribing one browser a replace
    // rather than a second notification — the upsert rides it instead of reading first.
    await this.db
      .prepare(
        `INSERT INTO push_subscription (id, user_id, endpoint, keys_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        subscription.endpoint,
        JSON.stringify(subscription.keys),
        this.config.now(),
      )
      .run();
  }

  /**
   * Daily-cron housekeeping: flips every remaining past-expiry `pending` row to
   * `expired` (writing each `approval.expired` audit row exactly once — lazy
   * expiry means most were already flipped at read time), then prunes rows
   * past config.retentionDays — approval rows hold persisted arguments, so
   * they age out on audit's schedule (§15). Returns counts for the cron's
   * ops log.
   */
  async sweepExpired(): Promise<{ expired: number; pruned: number }> {
    // deps: D1 `approval` · audit.record
    const now = this.config.now();
    const { results } = await this.db
      .prepare(
        `SELECT a.*, s.slug AS service_slug FROM approval a
         JOIN service s ON s.id = a.service_id
         WHERE a.status = 'pending' AND a.expires_at < ?`,
      )
      .bind(now)
      .all<ApprovalDbRow & { service_slug: string }>();
    let expired = 0;
    for (const row of results) {
      if (await this.flipExpired(row, row.service_slug)) expired += 1;
    }
    // Flip first, prune second (§7): a row that is both past-expiry and past-retention still
    // leaves its `approval.expired` behind before the row itself goes.
    const { meta } = await this.db
      .prepare(`DELETE FROM approval WHERE created_at < ?`)
      .bind(now - this.config.retentionDays * DAY_MS)
      .run();
    return { expired, pruned: meta.changes };
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
    // deps: D1 `push_subscription` · config.push (VAPID ES256 + RFC 8291) · fetch
    const send = this.config.push;
    if (!send) return;
    try {
      // Service, tool and id — never arguments, redacted or otherwise (§15: the payload rests
      // on a third-party push service).
      const payload = JSON.stringify({
        approvalId,
        service: serviceSlug,
        tool,
        url: approvalUrl(this.config.publicOrigin, approvalId),
      });
      const { results } = await this.db
        .prepare(`SELECT id, endpoint, keys_json FROM push_subscription WHERE user_id = ?`)
        .bind(ownerId)
        .all<{ id: string; endpoint: string; keys_json: string }>();
      for (const sub of results) {
        try {
          const { status } = await send(
            { endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) as PushSubscriptionJson["keys"] },
            payload,
          );
          // Gone for good — and ONLY these two: a 500 or a rejected fetch is a flaky push
          // service, and unsubscribing the owner over one would be the worse failure.
          if (status === 404 || status === 410) {
            await this.db.prepare(`DELETE FROM push_subscription WHERE id = ?`).bind(sub.id).run();
          }
        } catch {
          // Best-effort per subscription: one dead endpoint must not skip the others.
        }
      }
    } catch {
      // Never throws: a push failure must not fail the request that created the row (§7).
    }
  }

  /**
   * The lazy-expiry WRITE, and the only one — a conditional UPDATE so the
   * `approval.expired` audit row is written exactly once however many readers race
   * (§7). Answers whether THIS caller was the one that flipped it. Only `pending`
   * rows are ever rewritten: a past-expiry `approved` row reads as expired and stays
   * as it is.
   */
  private async flipExpired(row: ApprovalDbRow, serviceSlug: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare(`UPDATE approval SET status = 'expired' WHERE id = ? AND status = 'pending'`)
      .bind(row.id)
      .run();
    if (meta.changes !== 1) return false;
    await this.config.audit.record({
      ownerId: row.owner_id,
      principal: "hub",
      event: "approval.expired",
      service: serviceSlug,
      tool: row.tool,
      outcome: "ok",
      detail: { approvalId: row.id },
    });
    return true;
  }
}

/** The `approval` row as stored (§5) — private to this module, like the table. */
type ApprovalDbRow = {
  id: string;
  owner_id: string;
  service_account_id: string;
  service_id: string;
  tool: string;
  args_hash: string;
  args_json: string;
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
};

/** `approval_list`'s cap when the caller names none — audit_query's default, by contract. */
const DEFAULT_LIST_LIMIT = 100;

/** Retention is pinned in DAYS (limits.RETENTION_DAYS); every other duration here is ms. */
const DAY_MS = 24 * 60 * 60_000;

/** The one place the `/approvals/<id>` path is built on the root-owned origin. */
function approvalUrl(publicOrigin: string, id: string): string {
  return `${publicOrigin}/approvals/${id}`;
}

/**
 * Expiry as an interpretation: past `expires_at` reads `expired` whatever the column says —
 * for the two statuses that could still authorize something. A `used` or `rejected` row is
 * already settled and keeps its own word: §7's "regardless of stored status" exists to stop
 * a stale `pending`/`approved` reading as live, and reporting every settled row older than
 * the 1 h window as `expired` would erase the whole history `approval_list` is there to show.
 */
function readStatus(row: ApprovalDbRow, now: number): ApprovalStatus {
  return row.expires_at < now && (row.status === "pending" || row.status === "approved")
    ? "expired"
    : row.status;
}

/** The -32003 payload the gateway folds into `data` and the message text alike. */
function required(row: ApprovalDbRow, publicOrigin: string): CheckResult {
  return {
    outcome: "required",
    approvalId: row.id,
    approvalUrl: approvalUrl(publicOrigin, row.id),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** SHA-256 of a UTF-8 string as lowercase hex — the stored `args_hash` form. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return stringifyCanonical(value === undefined ? {} : value, []);
}

/**
 * Recursive worker behind canonicalJson. `ancestors` is the recursion PATH (not
 * a whole-graph visited set) — a fresh array per level, so a value reachable
 * twice through two different siblings is expanded twice, and only a value
 * that is its own ancestor (a real cycle) throws. Built manually rather than
 * "rebuild a sorted plain object, then JSON.stringify it once": a plain object
 * silently reorders integer-index-like keys ("2" before "10") ahead of
 * insertion order, which would fight the code-unit sort this function exists
 * to guarantee.
 */
function stringifyCanonical(value: unknown, ancestors: readonly unknown[]): string {
  if (typeof value === "bigint") {
    throw new TypeError("canonicalJson: BigInt has no JSON representation");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (ancestors.includes(value)) {
    throw new TypeError("canonicalJson: cyclic structure");
  }
  const path = [...ancestors, value];
  if (Array.isArray(value)) {
    const items = value.map((item) => stringifyCanonical(item === undefined ? null : item, path));
    return `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(obj[key], path)}`);
  return `{${entries.join(",")}}`;
}
