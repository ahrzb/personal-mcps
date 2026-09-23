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
| `server/test/unit/errors.test.ts` | `notPermitted`'s vocabulary as a pure table *(2026-09-21, decision 37)*: `auditDetail` is `{ reason }` for all nine classes, the three fields a consumer receives (`code`, `message`, `data`) are identical across every one of them, the cause is in nothing a consumer could serialize, and the factory's argument is **required**, so no call site can omit a reason |
| `server/test/unit/audit-derive.test.ts` | `web/src/features/audit/derive.ts` — §13's explorer as a pure table: outcome classes with their labels and sentences verbatim, the nine `-32001` reason sentences with the no-reason and unknown-token fallbacks, the cause in words on a refusal's preview line (short words on a `-32001`; a humanized `failureClass` on a `-32000`, `upstream_status` with a numeric `upstreamStatus` reading "upstream status 502" and printing no second pair) and Refusals grouped by cause (the `Cause: <failureClass>.` suffix on a `-32000` that carries one; an unknown outcome labelled by its raw value, no sentence) and what the record's outcome row prints for a given outcome (no word twice: `ok` the chip alone, `error` the chip over its sentence, a refusal chip · label · code), titles, incl. the chain-row exception (`<app>/<tool>` for `tools/call` / `prompts/get` / `resources/read` alone, the event name otherwise, so an `approval.*` row never reads as a call; a chain row titled by its call while the record it opens keeps the head row's title), facet counts excluding their own group, the chain merge with its **(ts, id)** order, a chain's `when` being its newest event's `ts` (and the merged list's `when` never increasing over the fixture week), ×N runs keyed on seven fields incl. `argsHead` and the recorded cause (`failureClass` on a `-32000`, `reason` on a `-32001`) and that a chain never joins one, the waterfall fold threshold, the three insight rules (the first-seen one absent on a partial load, the changes one's "show me" carrying every distinct change event), the export href (class → raw codes, the tool pair as `target=`, repeated keys, `q` → `text`), the JSON tree's open paths and match finding (first two levels, plus every ancestor of a match), lanes' worst-outcome and not-loaded cells; plus the three no-bodies sentences and the stub size spellings inherited from `web-pages.test.ts`. The one `unit` file over `web/` source, which is what "no React, no `@/` runtime imports" in that module buys *(2026-09-21, decision 36)* |

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
| `fresh-auth.test.ts` | *(2026-09-23, decision 39)* recent authentication at better-auth's own mount: a table of the guarded endpoints — the password, the second factor, passkeys, sessions — which IS the decision's endpoint list; per row a stale cookie session posting straight at `/api/auth/*` is `403 SESSION_NOT_FRESH` with no side effect, beside a fresh twin that succeeds; and each deliberately unguarded flow (sign-in and its second-factor verify, sign-out, the device-flow legs, the OAuth provider's legs) completing with a stale session present, as before. *(2026-09-23, decision 40, its own `describe`:)* `/update-user` refused `404 Not Found` from a fresh session and a stale one alike — a new `username`, `name` alone, `image` alone — with the username unchanged afterwards (sign-in, `/api/whoami` and `/<username>/mcp` all still answer under it), and `immutableUsername` pinned in-process past the mount (`USERNAME_IS_IMMUTABLE`, beside the session's own username passing) |
| `order.table.test.ts` | shared dispatch order; aggregate hub-only refusal/allow twins; no first-underscore dispatch *(2026-09-21, decision 37: plus four rows pinning a refusal's recorded `detail.reason` through a real door, and the consumer-identity row — the refusals `notPermitted` builds are deep-equal to one another with the cause nowhere in any of them, `not_decidable` pinned to its own message as the one exception §7 names)* |
| `upstream-proxy.test.ts` | scoped forwarding/failures and proxied alias additions preserving incumbent TypeScript paths |
| `admin-pipeline.test.ts` | scoped pmcp plus credential-mirrored pmcp authority inside hub programs |
| `hygiene.test.ts` | persisted-secret sweep plus metadata-only hub outer audit and source/output/nonce absence; case **14a** additionally pins `detail.reason` `unsound_schema` on a schema-unsound tool's refusal — the one case that needs a warmed catalog and a socket *(2026-09-21, decision 37)* |
| `cron.test.ts` | scheduled effects unchanged |
| `web-pages.test.ts` | CSRF and schema parity plus execution settings/alias forms *(2026-09-21, decision 36: minus its two `/audit` `describe`s, which went with the server-rendered page; the explorer's own rows are the new `audit_query` options, the two `/api/hub` audit reads, the export's repeated keys and the SPA shell on `/audit`)* *(2026-09-23, decision 38, family by family: every page is a shell, so no row reads server-rendered markup any more. A row that pinned a check is ported onto the JSON route or kept form route that replaced its handler — the reads `/api/hub/approvals/<id>`, `/api/hub/settings`, `/api/hub/device`, `/api/hub/oauth/consent`, the `/api/hub/settings/*` writes and their recent-authentication prefix, `/api/hub/device/decide`, `/api/hub/approvals/push`, and `/login`'s `#pmcp-login` island; a row that pinned only drawing moves to a `unit` row over the page's `web/src/…/derive.ts` or to a gallery state. The per-row map is `docs/superpowers/plans/2026-09-23-everything-spa-routes.md`.)* |
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

*(2026-09-23, decision 38.)* Three hand-run, browser-driven walks under `web/scripts/` sit
beside the suites and never inside them: `visual-compare.mts` (`pnpm visual:compare`) diffs
every gallery state against its `design/baseline/` PNG at 1280 and 390, and — pass 2's
component gate — in a **crop-compare mode** diffs the non-route `primitives` page's new column
against its old column at budget 0; `drawer-check.mts` (`pnpm check:drawer`) proves the phone
drawer's **behaviour** on the gallery — open, Escape, a tap beside it, its close button, focus
handed back, the scroll lock released — and no longer compares pixels; and
`audit-search-check.mts` (`pnpm check:audit-search`) proves a search never unmounts the
explorer's input. `server-baselines.mts`, which shot the server-rendered baselines, is deleted
with the preview it shot from; the PNGs it made are committed.

