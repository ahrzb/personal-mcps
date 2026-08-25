// audit.ts — the record of record and the hub's log-hygiene chokepoint (§15). This
// module owns and hides: the audit event vocabulary; the hygiene rules (bodies enter
// only through the two capped columns, already masked, with over-cap bodies swapped
// whole for stubs at this chokepoint; token material never enters any column;
// client-supplied metadata is display-only and truncated here, not at call sites;
// `tools/list` is never recorded — agent polling noise); the retention window
// (deliberately short, default 7 days — retention is the primary bound on what
// audit_query can expose, §15); and the chunk-by-chunk streaming behind the JSONL
// export. The D1 `audit` table (§5) is private to this module: every write goes
// through record(), every read through query().

import { AUDIT_BODY_CAP_BYTES, RETENTION_DAYS } from "./limits";

/** Cloudflare D1 binding (@cloudflare/workers-types `D1Database`) — the control-plane
 *  database, request-scoped, handed in by the composition root. Narrowed to
 *  workers-env.d.ts's `D1Like` at the one place a statement is actually prepared. */
type D1Database = unknown;

/**
 * The two knobs of §15, resolved once by the composition root (env override or the
 * limits.ts default — RETENTION_DAYS / AUDIT_BODY_CAP_BYTES) and passed in; never
 * re-read from env here, and never a per-request decision.
 */
export type AuditConfig = {
  retentionDays: number;
  bodyCapBytes: number;
};

/**
 * The ONE place the §15 env overrides are parsed: string vars in, resolved
 * AuditConfig out, with limits.RETENTION_DAYS / limits.AUDIT_BODY_CAP_BYTES as
 * the defaults for absent or unparsable values. Both entry points call it —
 * the worker's composition root (fetch/scheduled) and the tunnel DO, which
 * reaches env through `cloudflare:workers` — so no sibling ever re-implements
 * the parse or reads the raw strings.
 */
export function resolveAuditConfig(vars: {
  AUDIT_RETENTION_DAYS?: string;
  AUDIT_BODY_CAP_BYTES?: string;
}): AuditConfig {
  // deps: limits.RETENTION_DAYS · limits.AUDIT_BODY_CAP_BYTES
  return {
    retentionDays: positiveInt(vars.AUDIT_RETENTION_DAYS) ?? RETENTION_DAYS,
    bodyCapBytes: positiveInt(vars.AUDIT_BODY_CAP_BYTES) ?? AUDIT_BODY_CAP_BYTES,
  };
}

/**
 * An override is honoured only when it is a whole positive count; anything else — absent,
 * blank, "7 days", 0, negative — is the limits.ts default. Never a throw: a typo'd var
 * must not take the worker down, and never 0 either, which would read as "retain nothing"
 * / "store no body at all" and silently disable the very thing the knob configures.
 */
function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A stored stand-in for body content the hub refuses to persist (§15): each
 * unstructured result block (text/image/resource) becomes a `blob` stub — type and
 * size visible, bytes never — and a whole body over the cap becomes one `oversize`
 * stub in its column. The exact wire spelling is pinned by the contract fixtures at
 * implementation; renderers (the /audit detail, `pmcp audit`) show stubs as typed
 * size placeholders, e.g. `‹blob image/png · 4.2 MB›`.
 */
export type BodyStub = {
  stub: "blob" | "oversize";
  contentType?: string;
  bytes: number;
};

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
 *   `upstream.disconnected`, `cron.swept` (§15's one cron heartbeat, written by
 *   every scheduled run), and the bootstrap events of §12. New events extend this
 *   list here, not ad hoc at call sites. `tools/list` is deliberately absent.
 * - `service` / `tool` — slugs and unprefixed tool names, when applicable.
 * - `outcome` — `ok` | `-32000` | `-32001` | `-32002` | `-32003` | `error`.
 * - `durationMs` — hub-measured wall time, consumer request to response; set on every
 *   `tools/call` row (denials are just fast), absent for non-call events.
 * - `client` — the consumer's self-declared clientInfo plus allowlisted session id
 *   (§7): untrusted display data, never parsed, never an authorization input.
 * - `args` / `result` — the call bodies, set only on `tools/call` rows of services
 *   whose `log_bodies` is on AND whose call was actually dispatched — refusal rows
 *   never carry bodies; several refusals predate any redaction map (§15). Both
 *   arrive ALREADY masked (the gateway applies §7's per-direction redaction
 *   unions). `result`'s envelope is pinned (§5/§15): it mirrors the MCP result's
 *   two carriers — `structuredContent` post-redaction plus `content` as one `blob`
 *   BodyStub per unstructured block; a result with only content blocks stores
 *   `{content: [...]}`. This module's own hygiene duty is the size cap: see
 *   record().
 * - `detail` — a small JSON summary; NEVER token material, and never a body — bodies
 *   travel only in the two dedicated fields above.
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
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  detail?: Record<string, unknown>;
};

/** A persisted entry as read back: the entry plus its row id and the hub-stamped
 *  timestamp (Unix epoch ms). The one shape all three read surfaces see — `audit_query`
 *  rows, the /audit page, and each JSONL export line. */
export type AuditRow = AuditEntry & { id: number; ts: number };

/**
 * Filters for query() and exportJsonl(), mirroring `audit_query` (§8). The
 * namespace is deliberately NOT a filter: every read is scoped by the separate
 * `ownerId` parameter, which callers hold only post-authentication — a filter
 * field could be forgotten; a parameter cannot. All string
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
 * storage, and each body (`args`, `result` — arriving pre-masked, see AuditEntry)
 * whose serialization exceeds config.bodyCapBytes is replaced WHOLE by one
 * `oversize` BodyStub — never truncated into corrupt JSON. `detail` is the caller's
 * obligation to keep to a summary; token material is never accepted anywhere. Never
 * called for `tools/list` (§15 keeps it out of audit by vocabulary, not by
 * filtering).
 */
export async function record(db: D1Database, entry: AuditEntry, config: AuditConfig): Promise<void> {
  // deps: D1 `audit`
  const client = entry.client ?? {};
  await (db as D1Like)
    .prepare(
      `INSERT INTO audit (ts, owner_id, principal, event, service, tool, outcome,
         duration_ms, client_name, client_version, client_session_id,
         args_json, result_json, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      entry.ownerId,
      entry.principal,
      entry.event,
      entry.service ?? null,
      entry.tool ?? null,
      entry.outcome,
      entry.durationMs ?? null,
      displayField(client.name),
      displayField(client.version),
      displayField(client.sessionId),
      cappedBody(entry.args, config.bodyCapBytes),
      cappedBody(entry.result, config.bodyCapBytes),
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    )
    .run();
}

/**
 * How much of a client-declared string is kept. Untrusted display data (§7), so the bound
 * exists to stop a consumer writing a novel into every row — not to preserve meaning at
 * the edge. A local constant rather than a limits.ts one for the same reason identity's
 * PREFIX_DISPLAY_LENGTH is: no spec § pins the number, it pins that there IS one.
 */
const CLIENT_FIELD_MAX_LENGTH = 128;

/** Truncated HERE, at the chokepoint, so no call site has to remember to (§15). */
function displayField(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, CLIENT_FIELD_MAX_LENGTH);
}

/**
 * A body arrives already masked (see AuditEntry); this module's own duty is the size cap.
 * An over-cap body is replaced WHOLE by one `oversize` stub — truncating the JSON instead
 * would store a string no reader can parse, which is worse than storing none of it.
 */
function cappedBody(body: Record<string, unknown> | undefined, capBytes: number): string | null {
  if (body === undefined) return null;
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes <= capBytes) return json;
  return JSON.stringify({ stub: "oversize", bytes } satisfies BodyStub);
}

/**
 * The single read path over the ledger — `audit_query`, the /audit page, and the JSONL
 * export all sit on it. Returns one page of matching rows, newest first, plus `total`:
 * the count of ALL rows matching the filters regardless of limit/offset (backs the web
 * UI's page numbers and "N events match" line — a COUNT over the retention-pruned
 * table is cheap, §8). Rows carry the body fields when recorded — post-redaction and
 * stub-substituted, the only form ever stored. Read-only; no matches is
 * `{ rows: [], total: 0 }`, never an error.
 */
export async function query(
  db: D1Database,
  ownerId: string,
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
  ownerId: string,
  filters: Omit<AuditQuery, "limit" | "offset">,
): ReadableStream<Uint8Array> {
  // deps: query · ReadableStream · TextEncoder
  throw new Error("unimplemented");
}

/**
 * Delete rows older than config.retentionDays (§15; default limits.RETENTION_DAYS,
 * resolved once at the composition root — deliberately short, see the module
 * header); returns how many were removed. Called by the daily cron alone — request
 * paths never prune, and the window is never a per-request parameter.
 */
export async function prune(db: D1Database, config: AuditConfig): Promise<number> {
  // deps: D1 `audit`
  throw new Error("unimplemented");
}
