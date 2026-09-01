## 3. The suites

### `unit` — pure seams, tables + laws

| File | Pins |
|---|---|
| `server/test/unit/pattern.test.ts` | `matchesPattern`/`validateRoles`: the §7 regressions (`foo\|bar` ✓`foo`/`bar` ✗`foox`; literal `get.news` ✗`getXnews`; `get_*` ≡ `get_.*`), never-throws, the cap table |
| `server/test/unit/filter.test.ts` | `buildToolFilter`: `all` → everything untouched declaration; granted-but-undeclared in `roleNames` but matches nothing; empty grants = the scoped-404 signal; allow-beats-approval as a law |
| `server/test/unit/canonical.test.ts` | `canonicalJson` laws: key order irrelevant at depth, arrays ordered, idempotent, `undefined`≡`{}` (enables "absent args binds as {}"), throws on cycles/BigInt |
| `server/test/unit/redact.test.ts` | the path grammar + writeOnly walk as a pure table — direction-blind: input and output schemas through the same walk (§7, decided 2026-08-25) |
| `cli/test/plan.test.ts` | the diff planner, classic fail-first TDD: defaults, `role:approval` split, delete-by-absence, warn-vs-error per kind, `pmcp` rejection, kind-change error, destructive flags, step order — plus the empty-plan law (state derived from desired ⇒ empty plan) |
| `clients/js/test/api.test.ts` | `caller()`/`sensitive()`/`secret()` pure halves (marking works on input and output schemas; values untouched); backoff schedule table *(nudge N2)* |

### `worker` — real D1, no sockets

| File | Pins |
|---|---|
| `migrations.test.ts` | the schema itself: CHECK constraints bite, UNIQUEs, FK cascades really cascade, **the partial unique pending index exists and kills the double-insert race**, re-application is a no-op |
| `registry.test.ts` | Registry against real D1: slug rules, archived-is-a-pipeline-stage, request-time re-read of declarations, auth-flip wipes the envelope in the same write, drift semantics (textual, subset-is-not-drift), grant validation both kinds |
| `identity-tokens.test.ts` | plaintext-once, one-null-for-every-failure on `resolveAppToken`, revoke vs delete, defaults by kind |
| `approvals.test.ts` | the deepest file: dedup via the constraint, post-redaction hashing proven observably (two calls differing only in a redacted field match), check-never-consumes, claim first-wins/lost, settle restores on `input_required` only, lazy expiry audited exactly once, push crypto **decrypted in-test** (VAPID JWT verified, RFC 8291 body decrypted, payload = app+tool+id and nothing else), notifyOwner never throws, 404/410 prunes |
| `upstream-credentials.test.ts` | envelope actually encrypted + version byte; `connectionStatus` totality; the callback rejection matrix (missing/replayed/expired/other-session state, `iss` mismatch) each storing **nothing**; PKCE + token-endpoint pinning enforced by a fake AS that does REAL S256 checks |
| `admin-ops.test.ts` | the ops table: uniform `pmcp` rejection driven over `Object.keys(ops)` so a new op can't forget it; cascade atomicity (both rows gone or neither); audit discipline as a table (every mutating op exactly one `admin.<tool>` row, reads none); **parity direction A** — every op renders as a pmcp tool from its one zod schema |
| `auth-matrix.test.ts` | §7 step 1 + whoami as one ~25-row table, every refusal beside its allow-twin: the 401/404 matrix, `pmcp_app_` never-session, cookies never on `/mcp`, Origin rules, bearer-sourced session rejected on `/settings`, bootstrap route 404-when-unset |
| `order.table.test.ts` | the check order as the table it is (~16 rows): ungranted+archived → `-32001` not `-32002`; unknown prefix → `-32001`; first-`_` split; `server/discover`; `-32601` |
| `upstream-proxy.test.ts` | the failure table (everything → `-32000`, `data` unset, body never echoed, class only in audit detail); aggregated fan-out with a failing + a hanging upstream; refresh-before-forward observed in order; `X-Pmcp-*` only with `forward_identity`; **subrequest counts asserted explicitly** (workerd enforces no cap locally) |
| `admin-pipeline.test.ts` | pmcp through the real endpoint: agents see no `pmcp_*` tools (structural), owner never approval-gated, `builtin: true` row |
| `hygiene.test.ts` | sentinel-string sweep: no persisted row contains token material or an unmasked sentinel secret; bodies exist only in approval `args_json` and the audit body columns, always post-redaction (§15 — the body table: `log_bodies` defaults by kind and flips both ways, results only as masked structuredContent, unstructured blocks → blob stubs, over-cap → oversize stub against a shrunk `AUDIT_BODY_CAP_BYTES`, `token_issue`'s recorded result masked by the uniform rule); served outputSchemas carry no `writeOnly`; recomputed post-redaction hash equality + raw-hash inequality |
| `cron.test.ts` | one scheduled run produces all three effects; the wrangler cron string equals the expected constant (honestly labelled — nothing local proves an expression fires daily) |
| `web-pages.test.ts` | thin by design: CSRF rejection with the ops handler provably not run; `/approvals/<id>` owner-only; export line count = `total`; **parity direction B** — form fields = the same zod schema's keys |
| `routes.test.ts` | the §2 router-walk equivalence, both sides derived; reserved-username refusal |
| `contracts.test.ts` | **the L4 producer** (§4) |

### `tunnel` — serial: the DO, live sockets, hibernation

| File | Pins |
|---|---|
| `smoke.test.ts` | **written first, kept forever**: (1) SQLite-backed DO works on Windows; (2) `serializeAttachment` survives `evictDurableObject` — *unverified upstream, and the whole connection identity rides on it*. If (2) fails, AppConnection needs a durable-storage fallback before anything else here is written |
| `protocol.test.ts` | §6 wire: registration deadline via `runDurableObjectAlarm` → 4004 (no sleeping); pre-register traffic rejected; register → catalog warmed (fake app observes the `tools/list`); newest-wins at acceptance with `hub/replaced` + 4000; vanished row → 4003; drift audit row; no application heartbeat |
| `lifecycle.test.ts` | sever codes; `onlyIfTokenId`; wipe idempotent; **the §15 ordering pins observed live**: at the moment 4001 is seen, D1 already has no rows; archived flag lands before 4002; catalog survives disconnect; upgrade matrix (403 means exactly archived) |
| `hibernation.test.ts` | the honest hibernation pins via `evictDurableObject`: socket round-trips after eviction; catalog still served; identity survives via attachment; the alarm still fires; **the pending map is EMPTY after eviction** — converting §6's unvalidated assumption into a validated one. (No test asserts the map survives; upstream proves it doesn't.) |
| `pipeline-tunnel.test.ts` | §16's core integration test: both endpoint shapes, role filtering, `_meta` hygiene observed at the app (strip-then-set, mirrored capabilities, ids never cross), deadline → `-32000`, the audit chokepoint (row exists with `duration_ms` when the response resolves) |
| `approval-e2e.test.ts` | §16's approval bullet over a real tunnel with the fake app's **invocation counter as the exactly-once oracle**; CAS under table-driven deterministic interleavings (never fire-50-and-hope — workerd is cooperative); availability-between-check-and-claim both directions; MRTR legs; the redaction union; catalog-miss refused with `-32001` (decided 2026-08-25) |

### Clients and scripts

JS and Python each get: a transport file against an in-process fake hub (real
upgrade rejection with 401 vs 403 — the split the fatal-vs-retry policy turns on),
a reconnect-policy table transcribed from the shared close-code fixture (the
deliberate cross-language duplication, one oracle), an api file, and a contract
consumer. Python: `anyio_mode="auto"`, asyncio backend, a ~10-line recorded-sleep
fixture instead of a fake clock (anyio has no injectable clock on asyncio).
`scripts/test/bootstrap-contract.test.ts` pins the status→message mapping — the
one place a bare fetch stub is legitimate.

