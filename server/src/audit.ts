// audit.ts — the durable audit record and the hub's log-hygiene chokepoint. Workers Logs
// keep days; this table keeps 90 (§15) — it is the record of record. This module owns and
// hides: the audit event vocabulary; the hygiene rules (tool arguments, results, and
// token material never enter the table; client-supplied metadata is display-only and
// truncated here, at the chokepoint, not at call sites; `tools/list` is never recorded —
// agent polling noise); the retention window; and the chunk-by-chunk streaming behind the
// JSONL export. The D1 `audit` table (§5) is private to this module: every write goes
// through record(), every read through query().

/** Cloudflare D1 binding (@cloudflare/workers-types `D1Database`) — the control-plane
 *  database, request-scoped, handed in by the composition root. */
type D1Database = unknown;

/**
 * One audit event, as callers describe it — the hub stamps the timestamp and row id at
 * write time, so neither appears here.
 *
 * - `ownerId` — the namespace the event happened in (every event has exactly one).
 * - `principal` — who acted: `user:<name>` | `sa:<slug>` | `svc:<slug>` | `bootstrap`.
 * - `event` — the vocabulary is owned here; the families (§5, §15): `tools/call`,
 *   `admin.<tool>`, `connect.register` / `connect.replaced` / `connect.roles_widened`,
 *   `auth.login` / `auth.device_approved`, `approval.requested` / `.approved` /
 *   `.rejected` / `.expired`, `upstream.oauth_*` / `upstream.auth_mode_changed` /
 *   `upstream.disconnected`, and the bootstrap events of §12. New events extend this
 *   list here, not ad hoc at call sites. `tools/list` is deliberately absent.
 * - `service` / `tool` — slugs and unprefixed tool names, when applicable.
 * - `outcome` — `ok` | `-32000` | `-32001` | `-32002` | `-32003` | `error`.
 * - `durationMs` — hub-measured wall time, consumer request to response; set on every
 *   `tools/call` row (denials are just fast), absent for non-call events.
 * - `client` — the consumer's self-declared clientInfo plus allowlisted session id
 *   (§7): untrusted display data, never parsed, never an authorization input.
 * - `detail` — a small JSON summary; NEVER tool arguments, results, or token material
 *   (approval rows are the only persisted arguments anywhere in the hub, §7).
 */
export type AuditEntry = {
  ownerId: string;
  principal: string;
  event: string;
  service?: string;
  tool?: string;
  outcome: string;
  durationMs?: number;
  client?: { name?: string; version?: string; sessionId?: string };
  detail?: Record<string, unknown>;
};

/** A persisted entry as read back: the entry plus its row id and the hub-stamped
 *  timestamp (Unix epoch ms). The one shape all three read surfaces see — `audit_query`
 *  rows, the /audit page, and each JSONL export line. */
export type AuditRow = AuditEntry & { id: number; ts: number };

/**
 * Filters for query() and exportJsonl(), mirroring `audit_query` (§8). All string
 * filters are exact matches; `session` matches the client-declared session id.
 * `since`/`until` bound the entry timestamp, inclusive, Unix epoch ms. `limit` defaults
 * to 100, `offset` to 0; both are ignored by exportJsonl (an export is always the
 * complete match).
 */
export type AuditQuery = {
  principal?: string;
  service?: string;
  event?: string;
  tool?: string;
  session?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
};

/**
 * Append one entry to the ledger. Callers MUST await this: a failed write rejects, and
 * the request being recorded fails with it — ledger integrity is chosen over
 * availability (a call the ledger cannot attest to must not succeed silently). Hygiene
 * is enforced at this chokepoint: each `client` field is truncated to 128 chars before
 * storage; `detail` is the caller's obligation to keep to a summary — this module never
 * accepts a path for arguments, results, or token material. Never called for
 * `tools/list` (§15 keeps it out of audit by vocabulary, not by filtering).
 */
export async function record(db: D1Database, entry: AuditEntry): Promise<void> {
  // deps: D1 `audit`
  throw new Error("unimplemented");
}

/**
 * The single read path over the ledger — `audit_query`, the /audit page, and the JSONL
 * export all sit on it. Returns one page of matching rows, newest first, plus `total`:
 * the count of ALL rows matching the filters regardless of limit/offset (backs the web
 * UI's page numbers and "N events match" line — a COUNT over the 90-day table is
 * cheap, §8). Read-only; no matches is `{ rows: [], total: 0 }`, never an error.
 */
export async function query(
  db: D1Database,
  filters: AuditQuery,
): Promise<{ rows: AuditRow[]; total: number }> {
  // deps: D1 `audit`
  throw new Error("unimplemented");
}

/**
 * Stream every row matching the filters as JSONL — one AuditRow JSON object per line,
 * newest first, UTF-8. Backs /audit's Export action and `pmcp audit --export jsonl`;
 * per §8's parity list it is a serialization of query(), not a new capability. The full
 * result set is never held in memory: rows are re-fetched in limit-sized chunks and
 * written as each chunk arrives (§13) — the chunk size is this module's private
 * business, invisible in the output.
 */
export function exportJsonl(
  db: D1Database,
  filters: Omit<AuditQuery, "limit" | "offset">,
): ReadableStream<Uint8Array> {
  // deps: query · ReadableStream · TextEncoder
  throw new Error("unimplemented");
}

/**
 * Delete rows older than the 90-day retention window (§15); returns how many were
 * removed. Called by the daily cron alone — request paths never prune, and the window
 * is this module's constant, not a caller knob.
 */
export async function prune(db: D1Database): Promise<number> {
  // deps: D1 `audit`
  throw new Error("unimplemented");
}
