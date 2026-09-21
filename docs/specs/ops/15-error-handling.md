## 15. Error handling and operational behavior

- Direct scoped forwarded requests retain the 30 s hard timeout and at-most-once
  behavior. §23 hub execution has a separately admitted synchronous wall clock:
  owner default/max initially 30 s, optional per-call duration, compiled ceiling 300 s,
  and a mandatory remote process timeout. A request abort triggers process termination
  and possible container replacement; an operation that may have launched is never
  replayed. §21 listen streams remain the held-open exception.
- Duplicate app connection: newest wins, oldest gets `hub/replaced` + close 4000.
- Unavailable app (tunnel offline, proxied upstream unreachable, or proxied
  upstream HTTP/protocol failure — §7): `-32000` immediately, no queueing; archived
  apps return `-32002` instead (§6). (Queue-and-retry is a later feature if it
  ever hurts.)
- Consumer credential revocation is checked on every request; §21 streams reauthorize on
  each keepalive and §23 executions before every inner operation and final publication.
  Revocation therefore withholds future bridge work/result without requiring a reverse
  Sandbox index. Revoked app tokens still sever their app socket with `4001`.
- User deletion (`/internal/users`) performs the same teardown as `app_delete` for
  every tunneled app in the namespace — close `4001`, wipe DO cached state — before
  the row cascade. (DOs are addressed by `app.id`, so even a missed teardown can
  never be rebound by recreating the username.)
- Rate limiting: one Cloudflare WAF rate-limiting rule (available on all plans) covers
  `/login`, `/device`, `/api/auth/*`, and `/internal/users` — brute-force protection
  for passwords, TOTP challenges, and device codes lives there. better-auth's built-in
  limiter is in-memory (per-isolate — a no-op on Workers) and is not relied on.
- Log hygiene: every hub credential prefix is scrubbed; authorization headers,
  submitted program source, schemas/declarations, bridge bodies, outputs, stdout/stderr,
  nonces, and Sandbox identifiers never enter product logs, errors, or audit. Existing
  `writeOnly` and configured redaction applies uniformly to inner app/pmcp calls.
- Audit trail: the D1 `audit` table (§5) is the record of record — structured,
  per-namespace, queryable (`audit_query` / `pmcp audit`); Workers Logs lines are ops
  debugging only. Recorded: every
  `tools/call` (allowed and denied, with hub-measured `duration_ms` for latency
  visibility in `/audit`, and the caller's self-declared client name/version/session
  id when sent, §7 — display data only), approval lifecycle transitions
  (`approval.requested/approved/rejected/expired`), every mutating `pmcp` admin tool,
  logins, device approvals, connect/register/replaced/roles_widened events, and bootstrap
  invocations. *(Amended 2026-08-26: plus every `prompts/get` and `resources/read` —
  §20's reads are audited like a call, with the prompt name or the resource URI in the
  `tool` column, the URI **query-redacted and length-capped** before it is stored,
  because a URI's query component is a routine carrier of somebody else's bearer token
  and the scrubbing grammar in this same bullet only knows the hub's own
  `pmcp_(agt|app)_` shape — §20.4 pins the exact rule — and §19's connection lifecycle,
  `oauth.consented` /
  `oauth.rebound` / `oauth.revoked` / `oauth.client_registered`.)* Listing/search/local
  snapshot operations, listen streams, doorbells, and updated relays are not recorded.
  Hub outer tool/read audit is metadata-only; inner calls/reads retain exactly one
  canonical existing row. Token material never appears in any column.
  *(Amended 2026-09-21, decision 36: two call rows gain `detail.approvalId` — the
  `tools/call` row refused with `-32003`, and the `tools/call` row **dispatched under a
  claimed approval** (§7 step 1's CAS claim), each carrying the id of the `approval` row
  (§5) it opened or consumed, **merged** with whatever detail the outcome already owes: a
  `-32000` after a claim carries both `failureClass` and `approvalId`. Until now only the
  four `approval.*` rows carried the id and nothing tied a call to the approval it waited
  on, which is the one thing §13's explorer needs to draw "asked → you approved → ran" as a
  single row. Three things this is **not**. It is not a hygiene exception: an approval id is
  not token material — four rows of this same table already record it and `/approvals/<id>`
  is owner-gated (§13) — so the bullet above stands unqualified. It is not a wire change:
  §7's `-32003` already hands the caller `{ approvalId, approvalUrl, expiresAt }` in its
  `data`, and a dispatch under a claimed approval stays byte-identical to one that never
  needed an approval, so §7's indistinguishability rules are untouched — the field is a
  ledger fact and only that. And it is not the beginning of a refusal *reason*: **no
  `reason` is recorded for `-32001`**, whose three sources (not permitted, unknown, no sound
  redaction map — §7) stay as indistinguishable in the ledger as they are on the wire, so
  the trail can never be read as the oracle the refusal deliberately withholds. Whether
  `outcome` should split into a mechanism and a reason is left open, deliberately.)*
- Audit bodies: a `tools/call` row carries the call's bodies when the app's
  `log_bodies` flag is on AND the call was actually dispatched. Refusal rows
  (`-32000`/`-32001`/`-32002`/`-32003`) never carry bodies — several refusals happen
  before any redaction map exists (a catalog-miss has no schema, §7), so recording
  them would persist unmasked arguments. The flag's default is by kind: tunneled
  **on** (our libraries
  declare secrets in both schema directions, §7/§11), proxied **off** (no trustworthy
  schema; the owner opts in per app and covers it with `redact` /
  `redact_results` paths, §7/§8); the virtual `pmcp` builtin has no app row and is
  fixed **on** (its schemas are the hub's own, §8 — which is how `token_issue`'s key
  is "masked wherever bodies are recorded" rather than special-cased). What is
  stored: `params.arguments` post-redaction, and
  the result's `structuredContent` post-redaction. Unstructured result content
  (text/image/resource blocks) is never stored — each block becomes a typed size stub
  (`{stub: "blob", contentType, bytes}`), so "the image generator returned a 4 MB png"
  is visible without the bytes. Each body is capped at `AUDIT_BODY_CAP_BYTES`
  (default 16 KiB, env-overridable): an over-cap body is replaced whole by an
  `oversize` stub — never truncated into corrupt JSON. Exact stub spelling is pinned
  by the contract fixtures at implementation. MRTR `inputResponses`/`requestState`
  never enter the body columns (§7). *(Amended 2026-08-26: §20's read rows carry
  bodies under the same `log_bodies` gate and the same envelope — which is why prompt
  messages and resource contents need no new rule: they are content blocks, and
  content blocks are stubbed, never stored. A resource's own URI is not a body; it
  is the row's `tool` column, and it is the one caller-supplied string this bullet's
  rules did not already cover — §20.4 caps it and strips its query component before it is
  stored, on top of this section's token-grammar hygiene. Prompt **arguments** are the
  other exception §20 records: a prompt has no JSON Schema and therefore no `writeOnly`
  channel, so the tunneled default that this bullet justifies by "our libraries declare
  secrets in both schema directions" does not reach them — §20.3 puts prompt-argument
  bodies on the proxied posture instead.)*
- Retention: a daily cron trigger prunes audit and approval rows past the retention
  window — default **7 days**, `AUDIT_RETENTION_DAYS` env var overrides. Deliberately
  short: whatever the audit table holds, `audit_query` can read (§8), so retention is
  the primary bound on body exposure; the JSONL export (§13) is the archive path for
  anyone wanting longer. The trade, stated once: seven days is also the forensics
  window — a quietly abused token must be noticed within it. The coarse
  `last_used_at` on tokens (§5) carries the rotation/staleness question past the
  window.
  *(Amended 2026-09-21, decision 36: three **read-side** constants join the two knobs in
  `limits.ts` — `AUDIT_EXPLORER_ROWS` **5,000**, the most body-less rows §13's explorer
  loads for one window; `AUDIT_EXPLORER_PAGE` **1,000**, one request's worth of them; and
  `AUDIT_ARGS_HEAD_CHARS` **160**, the length of the `argsHead` preview a body-less read
  returns in place of the arguments column. All three bound a **read**, never the table:
  retention stays the only bound on what the ledger holds and on body exposure, and the
  JSONL export stays unbounded in **rows** — which is why the explorer, on reaching the
  ceiling, points at the export rather than loading more. A fourth,
  `AUDIT_EXPORT_MAX_VALUES` (**64**), bounds the export's **filter values** rather than its
  rows: the route sums the repeated values across every key, a `target` pair counting **two**
  because it binds two columns, and answers a `400` before any read when that sum exceeds the
  constant (§13's sentence). The number is D1's and not a policy — a prepared statement binds
  at most 100 parameters, and the export's statement already spends some on the namespace, the
  window pair, `text`'s eight columns, its seek key and its chunk limit — and it is the one
  place a reader is told to narrow rather than handed a stream that dies mid-file.)*

- Hub structured failures (§23) always name a bounded cause and say whether it is
  transient and whether an operation may have run. Only proven pre-launch container
  unavailability is retried once. Logs record refusal/replacement decisions, never
  execution progress.

