// audit.ts — the record of record and the hub's log-hygiene chokepoint (§15). This
// module owns and hides: the audit event vocabulary; the hygiene rules (bodies enter
// only through the two capped columns, already masked, with over-cap bodies swapped
// whole for stubs at this chokepoint; token material never enters any column;
// client-supplied metadata is display-only and truncated here, not at call sites;
// `tools/list` is never recorded — agent polling noise); the retention window
// (deliberately short, default 7 days — retention is the primary bound on what
// audit_query can expose, §15); the chunk-by-chunk streaming behind the JSONL
// export; and the one §15 sink that is not this database — `beforeSend`, the exception
// scrubber, which lives here rather than at the composition root so that "how the hub
// strips secrets out of a JSON tree" has a single address. The D1 `audit` table (§5) is
// private to this module: every write goes through record(), every read through query().

import { env } from "cloudflare:workers";
import { AUDIT_ARGS_HEAD_CHARS, AUDIT_BODY_CAP_BYTES, RETENTION_DAYS } from "./limits";
import { tokenPattern } from "./principal";
import { REDACTED } from "./registry";

/** Cloudflare D1 binding (@cloudflare/workers-types `D1Database`) — the control-plane
 *  database, request-scoped, handed in by the composition root. Narrowed to
 *  workers-env.d.ts's `D1Like` at the one place a statement is actually prepared. */
type D1Database = unknown;

/**
 * The two knobs of §15 (env override or the limits.ts default — RETENTION_DAYS /
 * AUDIT_BODY_CAP_BYTES), resolved by this module and by nobody else.
 */
export type AuditConfig = {
  retentionDays: number;
  bodyCapBytes: number;
};

/**
 * The ONE place the §15 env overrides are parsed: string vars in, resolved
 * AuditConfig out, with limits.RETENTION_DAYS / limits.AUDIT_BODY_CAP_BYTES as
 * the defaults for absent or unparsable values. Exported for the callers that hold vars
 * this module's ambient env cannot see (the cron's own reporting); `config()` below is
 * what everything else uses, so no sibling re-implements the parse, keeps a memo of its
 * own, or reads the raw strings.
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
 * §15's two knobs as every sink reads them: off the ambient env, at the moment they are
 * needed. Deliberately NOT memoized — the parse is two `Number` calls, and a
 * process-global memo would make an env override unreachable after the first audit write
 * of the process, which is exactly the state the harness overrides per request to escape.
 * The only reason this is a function rather than four private copies of the same `let` is
 * that "who decides the retention window" must have one answer.
 */
export function config(): AuditConfig {
  // deps: cloudflare:workers env · resolveAuditConfig
  return resolveAuditConfig(env);
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
 * §20.4 — the literal that replaces a resource URI's query component before it enters
 * `audit.tool`: the query is DROPPED, not pattern-scrubbed (a URI's query string is a
 * routine carrier of somebody else's bearer token, and §15's scrubbing grammar only knows
 * the hub's own `pmcp_(agt|app)_` shape). Pinned as a name, not a call-site literal, so the
 * gateway (which builds the `tool` value) and every test that reads it agree on the exact
 * spelling.
 */
export const REDACTED_QUERY = "?…";

/**
 * One audit event, as callers describe it — the hub stamps the timestamp and row id at
 * write time, so neither appears here.
 *
 * - `ownerId` — the namespace the event happened in (every event has exactly one).
 * - `principal` — who acted: `user:<name>` | `agent:<slug>` | `app:<slug>` | `bootstrap` |
 *   `hub` (principal.HUB_PRINCIPAL — one spelling, one query). The fifth is the MACHINE
 *   principal: an event no caller asked for — lazy
 *   approval expiry, and every row a scheduled run writes (`cron.swept` included). It is
 *   its own member rather than an owner's `user:<name>` because attributing a machine
 *   action to the human reading the ledger forges the one column the ledger is read for.
 * - `event` — the vocabulary is owned here; the families (§5, §15): `tools/call`,
 *   `admin.<tool>`, `connect.register` / `connect.replaced` / `connect.roles_widened`,
 *   `auth.login` / `auth.device_approved`, `approval.requested` / `.approved` /
 *   `.rejected` / `.expired`, `upstream.oauth_*` / `upstream.auth_mode_changed` /
 *   `upstream.disconnected`, `cron.swept` (§15's one cron heartbeat, written by
 *   every scheduled run), and the bootstrap events of §12. New events extend this
 *   list here, not ad hoc at call sites. `tools/list` is deliberately absent.
 * - `app` / `tool` — slugs and unprefixed tool names, when applicable.
 * - `outcome` — `ok` | `-32000` | `-32001` | `-32002` | `-32003` | `error`.
 * - `durationMs` — hub-measured wall time, consumer request to response; set on every
 *   `tools/call` row (denials are just fast), absent for non-call events.
 * - `client` — the consumer's self-declared clientInfo plus allowlisted session id
 *   (§7): untrusted display data, never parsed, never an authorization input.
 * - `args` / `result` — the call bodies, set only on `tools/call` rows of apps
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
  app?: string;
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
 *  rows, the /audit record read, and each JSONL export line. */
export type AuditRow = AuditEntry & { id: number; ts: number };

/**
 * An audit row without its bodies — what a caller that lists thousands reads (§13's
 * explorer). `argsHead` is the first AUDIT_ARGS_HEAD_CHARS characters of the STORED args
 * JSON (already masked, possibly an oversize stub's own JSON), for a one-line preview;
 * absent when the row recorded no args. `hasResult` says a result column exists without
 * shipping it.
 */
export type AuditSlimRow = Omit<AuditRow, "args" | "result"> & { argsHead?: string; hasResult: boolean };

/**
 * The `owner_id` a hub-wide machine action is recorded under. A SEPARATE decision from the
 * `hub` principal above, in a different column: `owner_id` is a column of opaque user ids
 * and this is a reservation in it, while `principal` is a vocabulary member. They are spelled
 * alike because the actor is the same one, and they are two constants because a rename of
 * either must not silently follow the other. `audit.owner_id` is NOT NULL and every read is
 * owner-scoped by parameter (§8), so the single `cron.swept` row of a run that belongs to no
 * namespace needs one of its own. The trade is stated where it bites: an owner's own /audit
 * does not show the sweep — the sweep is the operator's monitoring, not the owner's history.
 */
export const HUB_NAMESPACE = "hub";

/**
 * Filters for query() and exportJsonl(), mirroring `audit_query` (§8). The
 * namespace is deliberately NOT a filter: every read is scoped by the separate
 * `ownerId` parameter, which callers hold only post-authentication — a filter
 * field could be forgotten; a parameter cannot. Every filter AND-s with the others.
 * `since`/`until` bound the entry timestamp, inclusive, Unix epoch ms. `limit` defaults
 * to 100, `offset` to 0; both are ignored by exportJsonl (an export is always the
 * complete match).
 */
export type AuditQuery = {
  /**
   * The six exact filters, each taking ONE value or a LIST of them — a list matches any of
   * its values, an empty list is no filter at all. The list form is this module's own and
   * has exactly one caller, §13's JSONL export with a whole selection in it: `audit_query`
   * keeps all six single-valued (§8), so nothing on the tool surface can express a list.
   * `session` matches the client-declared session id; `outcome` matches the RAW recorded
   * value (`ok`, `-32001`, …), never one of §13's five display classes, which fold two
   * codes and are the page's own grouping.
   */
  principal?: string | string[];
  app?: string | string[];
  event?: string | string[];
  tool?: string | string[];
  session?: string | string[];
  outcome?: string | string[];
  /**
   * (app, tool) PAIRS, matching any of them — `(app = ? AND tool = ?) OR …`, AND-ed with
   * every other filter; an empty list is no filter. The list form's sibling, and module-level
   * for the same reason (§8): only §13's export needs it, and it is expressible to
   * `audit_query` one pair per call as `app` plus `tool`.
   *
   * It exists because a tool is named BY ITS APP on that page, and the same tool name lives
   * under several apps. Handing the two sides in as separate lists would ask for the CROSS
   * PRODUCT — two selected pairs would export four — and an export that silently returns
   * rows the reader never selected is the one failure a ledger may not have.
   */
  targets?: { app: string; tool: string }[];
  /** One row by its id — the record drawer's read (§13). Owner-scoped like every other, so
   *  an id in another namespace is absent exactly as an id that never existed is. */
  id?: number;
  /**
   * A case-insensitive substring over `principal`, `event`, `app`, `tool`,
   * `client_session_id`, `detail`, `args_json` and `result_json`, OR-ed across the eight.
   * Blank or whitespace-only is NO filter, so an empty search box is not a filter matching
   * nothing. Unindexed by decision (§8): a seven-day table (§15) is a cheap scan, and an
   * index over eight columns would tax every write of the hub for one reader's search box.
   */
  text?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  /**
   * `false` selects every column EXCEPT the two body ones, answering AuditSlimRow instead
   * (see query()'s overloads). Default true. The projection happens in SQL: a reader that
   * lists thousands of rows must never parse a body of up to AUDIT_BODY_CAP_BYTES in order
   * to throw it away, which is a Worker memory ceiling in-process tests cannot see (§16).
   */
  bodies?: boolean;
};

/**
 * Append one entry to the ledger. Callers MUST await this: a failed write rejects, and
 * the request being recorded fails with it — ledger integrity is chosen over
 * availability (a call the ledger cannot attest to must not succeed silently). Hygiene
 * is enforced at this chokepoint: each `client` field is truncated to 128 chars before
 * storage, and each body (`args`, `result` — arriving pre-masked, see AuditEntry)
 * whose serialization exceeds the §15 body cap is replaced WHOLE by one
 * `oversize` BodyStub — never truncated into corrupt JSON. `detail` is the caller's
 * obligation to keep to a summary; token material is never accepted anywhere. Never
 * called for `tools/list` (§15 keeps it out of audit by vocabulary, not by
 * filtering). The cap is read from config() here, so no call site carries a knob it has
 * no business knowing about.
 */
export async function record(db: D1Database, entry: AuditEntry): Promise<void> {
  // deps: D1 `audit` · config
  const { bodyCapBytes } = config();
  const client = entry.client ?? {};
  await (db as D1Like)
    .prepare(
      `INSERT INTO audit (ts, owner_id, principal, event, app, tool, outcome,
         duration_ms, client_name, client_version, client_session_id,
         args_json, result_json, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      entry.ownerId,
      entry.principal,
      entry.event,
      entry.app ?? null,
      entry.tool ?? null,
      entry.outcome,
      entry.durationMs ?? null,
      displayField(client.name),
      displayField(client.version),
      displayField(client.sessionId),
      cappedBody(entry.args, bodyCapBytes),
      cappedBody(entry.result, bodyCapBytes),
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
 * The single read path over the ledger — `audit_query`, §13's two explorer reads and the
 * JSONL export all sit on it. Returns one page of matching rows, newest first, plus
 * `total`: the count of ALL rows matching the filters regardless of limit/offset (backs
 * "N events match" and the explorer's ceiling notice — a COUNT over the retention-pruned
 * table is cheap, §8). Rows carry the body fields when recorded — post-redaction and
 * stub-substituted, the only form ever stored — unless `bodies: false`, which answers
 * AuditSlimRow: the same rows with the two body columns never selected. Read-only; no
 * matches is `{ rows: [], total: 0 }`, never an error.
 *
 * Overloaded on `bodies` so neither kind of caller casts: a body-less read is a different
 * ROW TYPE, not the same type with two fields that happen to be missing.
 */
export function query(
  db: D1Database,
  ownerId: string,
  filters: AuditQuery & { bodies: false },
): Promise<{ rows: AuditSlimRow[]; total: number }>;
export function query(
  db: D1Database,
  ownerId: string,
  filters: AuditQuery,
): Promise<{ rows: AuditRow[]; total: number }>;
export async function query(
  db: D1Database,
  ownerId: string,
  filters: AuditQuery,
): Promise<{ rows: AuditRow[] | AuditSlimRow[]; total: number }> {
  // deps: D1 `audit`
  const where = whereClause(ownerId, filters);
  const binding = db as D1Like;
  const slim = filters.bodies === false;
  const page = await binding
    .prepare(
      `SELECT ${slim ? SLIM_COLUMNS : "*"} FROM audit WHERE ${where.sql}
        ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    )
    // The head length leads the bindings because it is in the SELECT list, which precedes
    // the WHERE clause — the one place in this module where a parameter is not a filter.
    .bind(
      ...(slim ? [AUDIT_ARGS_HEAD_CHARS] : []),
      ...where.values,
      filters.limit ?? DEFAULT_LIMIT,
      filters.offset ?? 0,
    )
    .all<AuditDbRow & AuditSlimDbRow>();
  // The COUNT ignores limit/offset by design (§8): it backs "N events match", which is a
  // fact about the filters, not about the page being looked at.
  const counted = await binding
    .prepare(`SELECT COUNT(*) AS n FROM audit WHERE ${where.sql}`)
    .bind(...where.values)
    .first<{ n: number }>();
  return {
    rows: slim ? page.results.map(toSlimRow) : page.results.map(toRow),
    total: counted?.n ?? 0,
  };
}

/**
 * Every column but the two bodies, plus what stands in for them. `args_head` is a `substr`
 * and `has_result` a comparison, both evaluated by SQLite: the point of a body-less read is
 * that a body of up to AUDIT_BODY_CAP_BYTES never crosses into the Worker's heap at all, so
 * a projection that selected `args_json` and dropped it in JavaScript would be this read
 * with its one reason removed (§16 — no in-process test can see that ceiling).
 */
const SLIM_COLUMNS = `id, ts, owner_id, principal, event, app, tool, outcome, duration_ms,
         client_name, client_version, client_session_id, detail,
         substr(args_json, 1, ?) AS args_head,
         (result_json IS NOT NULL) AS has_result`;

/** `limit`'s default, pinned by §8 beside audit_query's own — one number, one owner. */
const DEFAULT_LIMIT = 100;

/**
 * The filter clause both statements share, so the page and the count can never disagree
 * about what "matching" means. The namespace leads it as a PARAMETER rather than a filter
 * field (see AuditQuery): every read is scoped whether or not the caller filtered.
 */
function whereClause(ownerId: string, filters: AuditQuery): { sql: string; values: unknown[] } {
  const clauses = [`owner_id = ?`];
  const values: unknown[] = [ownerId];
  for (const [field, column] of EXACT_COLUMNS) {
    const wanted = filters[field];
    if (wanted === undefined) continue;
    // One value and a one-value list are the same clause: `IN (?)` is `= ?`, so the two
    // spellings cannot answer differently. An EMPTY list is no filter — it is the absence
    // of a selection, not a selection nothing satisfies (§8).
    const list = Array.isArray(wanted) ? wanted : [wanted];
    if (list.length === 0) continue;
    clauses.push(`${column} IN (${list.map(() => "?").join(", ")})`);
    values.push(...list);
  }
  // The pairs, as pairs: one AND per target, OR-ed. Never two IN lists, which would be the
  // cross product (see AuditQuery.targets). An empty list is the absent filter, like above.
  if (filters.targets !== undefined && filters.targets.length > 0) {
    clauses.push(`(${filters.targets.map(() => `(app = ? AND tool = ?)`).join(" OR ")})`);
    for (const target of filters.targets) values.push(target.app, target.tool);
  }
  if (filters.id !== undefined) {
    clauses.push(`id = ?`);
    values.push(filters.id);
  }
  const needle = likeNeedle(filters.text);
  if (needle !== null) {
    clauses.push(`(${TEXT_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '${LIKE_ESCAPE}'`).join(" OR ")})`);
    values.push(...TEXT_COLUMNS.map(() => needle));
  }
  if (filters.since !== undefined) {
    clauses.push(`ts >= ?`);
    values.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`ts <= ?`);
    values.push(filters.until);
  }
  return { sql: clauses.join(" AND "), values };
}

/** The six exact filters and the column each names — the one place a filter name and a
 *  column name meet, so a rename cannot bind a value to the wrong column. */
const EXACT_COLUMNS: readonly [keyof AuditQuery, string][] = [
  ["principal", "principal"],
  ["app", "app"],
  ["event", "event"],
  ["tool", "tool"],
  ["session", "client_session_id"],
  ["outcome", "outcome"],
];

/** The columns `text` searches, OR-ed (§8). The two body columns are in it on purpose: a
 *  reader hunting a value they remember passing does not know which half of the call held
 *  it. A NULL column simply never matches, which OR already handles. */
const TEXT_COLUMNS = [
  "principal",
  "event",
  "app",
  "tool",
  "client_session_id",
  "detail",
  "args_json",
  "result_json",
] as const;

/** The `ESCAPE` character the `text` clauses declare. A backslash rather than SQLite's
 *  absent default: without an explicit one there is no way to spell a literal `%`, and a
 *  search for `%` would match every row in the namespace. */
const LIKE_ESCAPE = "\\";

/**
 * One `text` filter as a LIKE pattern, or null for "no filter" — blank and whitespace-only
 * alike (§8: an empty search box is not a filter matching nothing). The needle's own `%`,
 * `_` and backslash are escaped, the backslash FIRST so the escapes this adds are not
 * escaped again, which is what makes a search for `%` a search for a literal percent sign.
 */
function likeNeedle(text: string | undefined): string | null {
  if (text === undefined || text.trim() === "") return null;
  const escaped = text.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
  return `%${escaped}%`;
}

/** The `audit` row as §5 declares it — the column format this module alone reads. */
type AuditDbRow = {
  id: number;
  ts: number;
  owner_id: string;
  principal: string;
  event: string;
  app: string | null;
  tool: string | null;
  outcome: string;
  duration_ms: number | null;
  client_name: string | null;
  client_version: string | null;
  client_session_id: string | null;
  args_json: string | null;
  result_json: string | null;
  detail: string | null;
};

/** The body-less projection SLIM_COLUMNS selects: the same columns minus the two bodies,
 *  plus SQLite's answers for them — a `substr` that is NULL when the column is, and a
 *  comparison D1 reports as 0 or 1 because SQLite has no boolean of its own. */
type AuditSlimDbRow = Omit<AuditDbRow, "args_json" | "result_json"> & {
  args_head: string | null;
  has_result: number;
};

/**
 * One stored row as every reader sees it. Absent columns are OMITTED rather than set to
 * null: an AuditEntry's optional fields mean "this event has none", and a reader that has
 * to tell `undefined` from `null` is reading two vocabularies for one absence.
 */
function toRow(row: AuditDbRow): AuditRow {
  return {
    ...common(row),
    ...(row.args_json === null ? {} : { args: JSON.parse(row.args_json) as Record<string, unknown> }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as Record<string, unknown> }),
  };
}

/** The same row from the body-less projection: `argsHead` absent exactly where the column
 *  was null, and `hasResult` as the boolean the caller reads rather than SQLite's 0/1. */
function toSlimRow(row: AuditSlimDbRow): AuditSlimRow {
  return {
    ...common(row),
    ...(row.args_head === null ? {} : { argsHead: row.args_head }),
    hasResult: row.has_result === 1,
  };
}

/** Everything both shapes carry — the whole row but its bodies, so the two readings above
 *  cannot drift in the twelve columns that have nothing to do with the bodies. */
function common(row: Omit<AuditDbRow, "args_json" | "result_json">): Omit<AuditRow, "args" | "result"> {
  const client = {
    ...(row.client_name === null ? {} : { name: row.client_name }),
    ...(row.client_version === null ? {} : { version: row.client_version }),
    ...(row.client_session_id === null ? {} : { sessionId: row.client_session_id }),
  };
  return {
    id: row.id,
    ts: row.ts,
    ownerId: row.owner_id,
    principal: row.principal,
    event: row.event,
    ...(row.app === null ? {} : { app: row.app }),
    ...(row.tool === null ? {} : { tool: row.tool }),
    outcome: row.outcome,
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(Object.keys(client).length === 0 ? {} : { client }),
    ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) as Record<string, unknown> }),
  };
}

/**
 * Stream every row matching the filters as JSONL — one AuditRow JSON object per line,
 * newest first, UTF-8. Backs /audit's Export action and `pmcp audit --export jsonl`;
 * per §8's parity list it is a serialization of the same match set query() pages, not a
 * new capability — same filters, same order, `limit`/`offset` ignored. The full
 * result set is never held in memory: rows are re-fetched in limit-sized chunks and
 * written as each chunk arrives (§13) — the chunk size is this module's private
 * business, invisible in the output.
 */
export function exportJsonl(
  db: D1Database,
  ownerId: string,
  // `bodies` is out as well as the paging pair: an export is the archive path (§15), so it
  // ships whole rows — a body-less export would be a serialization of a different read.
  filters: Omit<AuditQuery, "limit" | "offset" | "bodies">,
): ReadableStream<Uint8Array> {
  // deps: D1 `audit` · ReadableStream · TextEncoder
  const encoder = new TextEncoder();
  // The match set is CLOSED when the stream is constructed. An export is reader-paced, so it
  // can be open for a long time over a table every request path appends to; without this the
  // rows written meanwhile are, by definition, part of the match — which contradicts
  // AuditQuery's "an export is always the complete match" and shifts every later chunk.
  const window = { ...filters, until: filters.until ?? Date.now() };
  let after: { ts: number; id: number } | null = null;
  return new ReadableStream<Uint8Array>({
    // One chunk per `pull`, so the export moves at the reader's pace and a slow client
    // never makes the worker hold the whole result set.
    async pull(controller) {
      const rows = await chunkAfter(db, ownerId, window, after);
      for (const row of rows) controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
      const last = rows[rows.length - 1];
      if (last !== undefined) after = { ts: last.ts, id: last.id };
      // A short chunk is the end of the match set — the same signal a paged reader uses.
      if (rows.length < EXPORT_CHUNK_ROWS) controller.close();
    },
  });
}

/**
 * One export chunk, sought by the last key emitted rather than by OFFSET — no offset scan,
 * and no COUNT: query()'s `total` is a page number the web UI needs and a streaming reader
 * never looks at, so the export gets the rows-only statement it actually wants. The order
 * is query()'s, so a chunk boundary means the same thing on both readers.
 */
async function chunkAfter(
  db: D1Database,
  ownerId: string,
  filters: AuditQuery,
  after: { ts: number; id: number } | null,
): Promise<AuditRow[]> {
  const where = whereClause(ownerId, filters);
  const seek = after === null ? "" : ` AND (ts < ? OR (ts = ? AND id < ?))`;
  const page = await (db as D1Like)
    .prepare(`SELECT * FROM audit WHERE ${where.sql}${seek} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(
      ...where.values,
      ...(after === null ? [] : [after.ts, after.ts, after.id]),
      EXPORT_CHUNK_ROWS,
    )
    .all<AuditDbRow>();
  return page.results.map(toRow);
}

/** How many rows one export chunk re-fetches. Private on purpose: the chunking is invisible
 *  in the output, so this is a memory knob and not part of anybody's contract. */
const EXPORT_CHUNK_ROWS = 200;

/**
 * Delete rows older than config.retentionDays (§15; default limits.RETENTION_DAYS,
 * resolved once at the composition root — deliberately short, see the module
 * header); returns how many were removed. Called by the daily cron alone — request
 * paths never prune, and the window is never a per-request parameter.
 */
export async function prune(db: D1Database, config: AuditConfig): Promise<number> {
  // deps: D1 `audit`
  // Namespace-blind by signature (§15): one daily trigger for the whole hub, so a second
  // namespace's recorded bodies can never outlive the window because nobody swept it.
  const { meta } = await (db as D1Like)
    .prepare(`DELETE FROM audit WHERE ts < ?`)
    .bind(Date.now() - config.retentionDays * DAY_MS)
    .run();
  return meta.changes;
}

/** Retention is configured in DAYS and every timestamp in the system is epoch ms. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * §15's exception sink, as a pure function: the `beforeSend` hook the Sentry integration is
 * configured with once the SDK is wired at the composition root. It lives HERE, beside the
 * other §15 rules, so "how the hub strips secrets out of a JSON tree" has one address.
 * Two rules, applied at EVERY depth of whatever the SDK hands over, because a scrubber that
 * only cleans the fields it knows about is one SDK release away from leaking: an
 * `Authorization` value never leaves, and the credential grammar — principal.tokenPattern,
 * derived from the prefixes identity mints, never transcribed — never leaves wherever it is
 * spelled: a header, a message, a stack frame's argument.
 *
 * NEVER returns null, and never throws. Dropping the event would satisfy every scrub rule
 * and destroy the only production signal the hub has, which is the trade §15 is not making.
 * What it WALKS is plain arrays and plain-object trees; anything else — a Date, an Error, a
 * class instance, a node already being visited (a cycle) — is passed through as it is rather
 * than rebuilt, so an event that carries no secret comes back identical, prototypes included.
 */
export function beforeSend<Event>(event: Event): Event {
  // deps: registry.REDACTED · principal.tokenPattern
  return scrub(event) as Event;
}

/** `pmcp_agt_…` / `pmcp_app_…` wherever it appears in prose. Built from the leaf that owns the
 *  wire spelling, so a new prefix is hunted here without an edit. */
const TOKEN_GRAMMAR = tokenPattern(1, "g");

/**
 * Depth-first, allocating only where something actually changed: the SDK's event is the
 * caller's, so a hook that mutated it would scrub the very object the rest of the pipeline
 * still reads — and a hook that REBUILT every node would flatten a `Date` in `extra` into
 * `{}` on the way past. `seen` holds the nodes on the current path, so a cyclic reference —
 * ordinary in SDK payloads — is left as it is instead of recursing to a stack overflow.
 */
function scrub(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return value.replace(TOKEN_GRAMMAR, REDACTED);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const scrubbed = value.map((entry) => scrub(entry, seen));
      return scrubbed.some((entry, at) => entry !== value[at]) ? scrubbed : value;
    }
    let changed = false;
    const entries = Object.entries(value).map(([key, entry]) => {
      const scrubbed = key.toLowerCase() === "authorization" ? REDACTED : scrub(entry, seen);
      changed ||= scrubbed !== entry;
      return [key, scrubbed] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  } finally {
    // Off the path once its subtree is done: a DAG (the same object referenced twice, no
    // cycle) must be scrubbed both times, and only an ANCESTOR means a cycle.
    seen.delete(value);
  }
}
