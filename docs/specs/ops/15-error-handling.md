## 15. Error handling and operational behavior

- Every forwarded request, both kinds: 30 s hard timeout → JSON-RPC error to the caller.
  Tunneled: the DO's pending map is rejected on socket close. Proxied: the upstream
  fetch is aborted at the same deadline.
- Hub deploys terminate all WebSockets: services reconnect (backoff), consumers retry.
  Treat every `tools/call` as at-most-once.
- Duplicate service connection: newest wins, oldest gets `hub/replaced` + close 4000.
- Unavailable service (tunnel offline, proxied upstream unreachable, or proxied
  upstream HTTP/protocol failure — §7): `-32000` immediately, no queueing; archived
  services return `-32002` instead (§6). (Queue-and-retry is a later feature if it
  ever hurts.)
- Token revocation: consumer tokens are checked on every request, so revocation is
  immediate there. A revoked *service* token (or a deleted service) additionally severs
  the live reverse connection — the Worker tells the DO to close the socket with code
  `4001` (§8); a racing re-register fails because the service row / token is gone.
- User deletion (`/internal/users`) performs the same teardown as `service_delete` for
  every tunneled service in the namespace — close `4001`, wipe DO cached state — before
  the row cascade. (DOs are addressed by `service.id`, so even a missed teardown can
  never be rebound by recreating the username.)
- Rate limiting: one Cloudflare WAF rate-limiting rule (available on all plans) covers
  `/login`, `/device`, `/api/auth/*`, and `/internal/users` — brute-force protection
  for passwords, TOTP challenges, and device codes lives there. better-auth's built-in
  limiter is in-memory (per-isolate — a no-op on Workers) and is not relied on.
- Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are
  redacted from logs, error responses, and exception traces; `writeOnly`/config-declared
  sensitive fields are masked before any storage or display (§7). The rule is uniform
  across services — the `pmcp` builtin needs no special case, because its one secret
  (`token_issue`'s key) is a `writeOnly`-marked output field masked like any other
  (§8). Every persisted body (approval `args_json`, the audit body columns) is
  post-redaction and pruned by the same daily cron as audit.
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
  `pmcp_(sa|svc)_` shape — §20.4 pins the exact rule — and §19's connection lifecycle,
  `oauth.consented` /
  `oauth.rebound` / `oauth.revoked` / `oauth.client_registered`.)* Not recorded:
  `tools/list` (agent polling noise) — *(and, by the same rule, every §20 LIST method
  plus `completion/complete`, which is a listing of argument suggestions)* — and token
  material never, in any column.
- Audit bodies: a `tools/call` row carries the call's bodies when the service's
  `log_bodies` flag is on AND the call was actually dispatched. Refusal rows
  (`-32000`/`-32001`/`-32002`/`-32003`) never carry bodies — several refusals happen
  before any redaction map exists (a catalog-miss has no schema, §7), so recording
  them would persist unmasked arguments. The flag's default is by kind: tunneled
  **on** (our libraries
  declare secrets in both schema directions, §7/§11), proxied **off** (no trustworthy
  schema; the owner opts in per service and covers it with `redact` /
  `redact_results` paths, §9); the virtual `pmcp` builtin has no service row and is
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

