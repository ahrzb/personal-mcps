## 3. The suites

### `unit` — pure seams, tables + laws

| File | Pins |
|---|---|
| `server/test/unit/pattern.test.ts` | `matchesPattern`/`validateRoles`: the §7 regressions (`foo\|bar` ✓`foo`/`bar` ✗`foox`; literal `get.news` ✗`getXnews`; `get_*` ≡ `get_.*`), never-throws, the cap table |
| `server/test/unit/filter.test.ts` | `buildToolFilter`: `all` → everything untouched declaration; granted-but-undeclared in `roleNames` but matches nothing; empty grants = the scoped-404 signal; allow-beats-approval as a law |
| `server/test/unit/canonical.test.ts` | `canonicalJson` laws: key order irrelevant at depth, arrays ordered, idempotent, `undefined`≡`{}` (enables "absent args binds as {}"), throws on cycles/BigInt |
| `server/test/unit/redact.test.ts` | the path grammar + writeOnly walk as a pure table — direction-blind: input and output schemas through the same walk (§7, decided 2026-08-25) |
| `clients/js/test/api.test.ts` | `caller()`/`sensitive()`/`secret()` pure halves (marking works on input and output schemas; values untouched); backoff schedule table *(nudge N2)* |
| `server/test/unit/hub-types.test.ts` | stable name generation/reservations, schema allowlist and hostile/cyclic rendering, declaration context separation, search ranking/caps, canonical identity |
| `server/test/unit/audit-derive.test.ts` | `web/src/features/audit/derive.ts` — §13's explorer as a pure table: outcome classes, titles, incl. the chain-row exception (`<app>/<tool>` for `tools/call` / `prompts/get` / `resources/read` alone, the event name otherwise, so an `approval.*` row never reads as a call; a chain row titled by its call while the record it opens keeps the head row's title), facet counts excluding their own group, the chain merge with its **(ts, id)** order and that a chain never joins a ×N run, the waterfall fold threshold, the three insight rules, the export href (class → raw codes, `<app>/<tool>` split, repeated keys), lanes' worst-outcome and not-loaded cells; plus the three no-bodies sentences and the stub size spellings inherited from `web-pages.test.ts`. The one `unit` file over `web/` source, which is what "no React, no `@/` runtime imports" in that module buys *(2026-09-21, decision 36)* |

### `worker` — real D1, no sockets

| File | Pins |
|---|---|
| `migrations.test.ts` | D1 CHECK/UNIQUE/FK behavior, including execution settings and sticky reservation/tombstone indexes |
| `registry.test.ts` | app/grant behavior plus atomic owner aliases, settings, reservation discovery and deletion tombstones |
| `identity-tokens.test.ts` | initial credential resolution, exact-token digest, non-secret references and family reauthorization |
| `approvals.test.ts` | approval/redaction/exactly-once semantics retained through shared dispatch |
| `upstream-credentials.test.ts` | encrypted upstream and OAuth state behavior |
| `admin-ops.test.ts` | ops table, reserved hub/pmcp slugs, settings and alias schema/audit parity |
| `auth-matrix.test.ts` | 401/404 matrix plus aggregate/scoped-hub admin and zero-grant-agent rows |
| `order.table.test.ts` | shared dispatch order; aggregate hub-only refusal/allow twins; no first-underscore dispatch |
| `upstream-proxy.test.ts` | scoped forwarding/failures and proxied alias additions preserving incumbent TypeScript paths |
| `admin-pipeline.test.ts` | scoped pmcp plus credential-mirrored pmcp authority inside hub programs |
| `hygiene.test.ts` | persisted-secret sweep plus metadata-only hub outer audit and source/output/nonce absence |
| `cron.test.ts` | scheduled effects unchanged |
| `web-pages.test.ts` | CSRF and schema parity plus execution settings/alias forms *(2026-09-21, decision 36: minus its two `/audit` `describe`s, which went with the server-rendered page; the explorer's own rows are the new `audit_query` options, the two `/api/hub` audit reads, the export's repeated keys and the SPA shell on `/audit`)* |
| `routes.test.ts` | reserved route equivalence including virtual hub |
| `contracts.test.ts` | sole producer for hub/initialize/errors/admin/tunnel fixtures |

### `tunnel` — serial: the DO, live sockets, hibernation

| File | Pins |
|---|---|
| `smoke.test.ts` | **written first, kept forever**: (1) SQLite-backed DO works on Windows; (2) `serializeAttachment` survives `evictDurableObject` — *unverified upstream, and the whole connection identity rides on it*. If (2) fails, AppConnection needs a durable-storage fallback before anything else here is written |
| `protocol.test.ts` | §6 wire: registration deadline via `runDurableObjectAlarm` → 4004 (no sleeping); pre-register traffic rejected; register → catalog warmed (fake app observes the `tools/list`); newest-wins at acceptance with `hub/replaced` + 4000; vanished row → 4003; drift audit row; no application heartbeat |
| `lifecycle.test.ts` | sever codes; `onlyIfTokenId`; wipe idempotent; **the §15 ordering pins observed live**: at the moment 4001 is seen, D1 already has no rows; archived flag lands before 4002; catalog survives disconnect; upgrade matrix (403 means exactly archived) |
| `hibernation.test.ts` | the honest hibernation pins via `evictDurableObject`: socket round-trips after eviction; catalog still served; identity survives via attachment; the alarm still fires; **the pending map is EMPTY after eviction** — converting §6's unvalidated assumption into a validated one. (No test asserts the map survives; upstream proves it doesn't.) |
| `pipeline-tunnel.test.ts` | §16's core integration test: both endpoint shapes, role filtering, `_meta` hygiene observed at the app (strip-then-set, mirrored capabilities, ids never cross), deadline → `-32000`, the audit chokepoint (row exists with `duration_ms` when the response resolves) |
| `approval-e2e.test.ts` | §16's approval bullet over a real tunnel with the fake app's **invocation counter as the exactly-once oracle**; CAS under table-driven deterministic interleavings (never fire-50-and-hope — workerd is cooperative); availability-between-check-and-claim both directions; MRTR legs; the redaction union; catalog-miss refused with `-32001` (decided 2026-08-25) |
| `hub-quickjs.test.ts` | real workerd/Wasm proof of fresh runtimes, async host promises, canonical target closure, frozen schemas, dynamic-compiler removal, deadline interruption and sanitized failures |

### Clients and scripts

JS, Python, and Go retain their transports and add parity for optional registration
aliases without changing canonical MCP names. CLI tests cover hub execution/search,
bounded integer settings flags, and app alias configuration. Provider acceptance in the
sibling repository proves settings and alias plan/apply/import/refresh/destroy behavior.

