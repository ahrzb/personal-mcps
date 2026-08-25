# Testing strategy

How personal-mcps gets tested: what exists, at what level, written when, by whom,
and how the suite stays cheap to keep true while the spec evolves.

## 1. The frame

Tests are the spec stated precisely. The prose spec (2026-08-24 design doc) is the
starting point — expected to be wrong or ambiguous in places, and it evolves.
Three consequences drive everything below:

- **Writing a test is design work.** Making a pinned behavior executable is where
  contradictions surface; amending the spec is a normal *output* of test authoring,
  not a failure of it. (Authoring this strategy — and pinning the decisions it
  produced — found three spec inconsistencies and a handful of skeleton
  problems — §11.)
- **A one-line spec change must not ripple through forty tests.** Change
  amplification in a test suite is the same disease as in code. The cure is
  structural: the spec's matrices live as *data tables*, the assertion logic lives
  once in a thin runner. A spec change edits rows; a code regression touches none —
  which is also how you tell the two apart when a test fails.
- **Much implementation will be agent-written.** Tests are the oracle agents build
  against, so oracle strength and authorship separation matter (§9). A supporting
  concern, not the headline.

The risk profile sizes the suite. The expensive bugs are not in computation — they
are in **ordering, refusal, state, and concurrency**: the pipeline check order, the
401/404 anti-enumeration matrix, approval exactly-once under concurrent retries,
`hub/*` _meta stripping, redaction-before-hashing, the tunnel close-code protocol.
Four green unit tests compose into a wrong order; only the pipeline exhibits the
pipeline's bugs. So the center of gravity is **in-process integration inside
workerd** (real D1, real Durable Object, fake service on a real WebSocket) — not
per-function unit tests, and not deployed e2e, which can't express concurrency
interleavings or exhaustive refusal matrices at all.

**Size: ~26 test files (most of them tables) + 3 harness modules, across four
vitest projects plus pytest. Dependencies beyond the runners: `@cloudflare/
vitest-plugin` and `fast-check`. No coverage tooling, no lint gate, no browser
framework.**

## 2. Projects and verified tooling facts

The Workers test tooling was verified against current docs and the published
package (2026-08). Facts the layout depends on:

- The pool is now **`@cloudflare/vitest-plugin@1.0.0`** (same code as the final
  `vitest-pool-workers@0.22.0`; vitest 4.1; `defineWorkersConfig` is gone — it's a
  Vite plugin, `cloudflareTest()`). Pin exact versions; 1.0.0 is days old.
- `SELF` is deprecated: pipeline tests drive **`exports.default.fetch(...)`** from
  `cloudflare:workers`. Cron runs via `createScheduledController` + `worker.scheduled`.
- Storage isolation is **per test file** and automatic; only WebSockets + DOs are
  incompatible with it, so exactly one project runs serial.
- D1: migrations are read Node-side (`readD1Migrations`, exported from the MAIN
  entry — the JSDoc pointing at `/config` is stale) and applied in a setup file
  (`applyD1Migrations`) — idempotent, so re-runs are safe.
- Outbound fetch: `fetchMock` is **gone**; the supported replacement is a plain
  `miniflare.outboundService` function — our fake-upstream router.
- DO access: `runInDurableObject` (unit access), `runDurableObjectAlarm` (fires a
  pending alarm immediately — the 10 s registration deadline needs no sleeping),
  and — the finding that changes the plan — **`evictDurableObject(stub,
  {webSockets: "hibernate"})`**: genuinely tears down in-memory state while
  hibernating (not closing) the sockets. Upstream's own fixtures prove in-memory
  fields are discarded and hibernated sockets still round-trip. **Hibernation is
  therefore testable in-process**, with one caveat: eviction drains in-flight
  requests first, so the *abrupt-crash-mid-call* branch stays out of reach (§10).
- Vitest fake timers do not reach workerd simulators or DO alarms — so **time is
  injected** (`ApprovalsConfig.now()`) or **constant-shrunk** (a constants module
  owning the 10 s / 30 s / 1 h / 7 d / 10 min values plus the audit body cap;
  tests reference constants,
  never literals — "30 s → 45 s" is then a one-line change with zero test churn).

The projects:

| Project | Where | Mode | What belongs |
|---|---|---|---|
| `unit` | plain Node | parallel, ms | pure seams only — functions whose deps line is `none` |
| `worker` | workerd | parallel, per-file isolation | modules against **real D1** with every sibling real; socket-free pipeline tables via `exports.default.fetch` |
| `tunnel` | workerd | **serial** (`--max-workers=1 --no-isolate`) | everything touching `ServiceConnection`, a WebSocket frame, a DO alarm, or the hibernation boundary |
| `scripts` + clients | Node / pytest | parallel | CLI planner, contract consumers, client transports against in-process fake hubs |

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
| `identity-tokens.test.ts` | plaintext-once, one-null-for-every-failure on `resolveServiceToken`, revoke vs delete, defaults by kind |
| `approvals.test.ts` | the deepest file: dedup via the constraint, post-redaction hashing proven observably (two calls differing only in a redacted field match), check-never-consumes, claim first-wins/lost, settle restores on `input_required` only, lazy expiry audited exactly once, push crypto **decrypted in-test** (VAPID JWT verified, RFC 8291 body decrypted, payload = service+tool+id and nothing else), notifyOwner never throws, 404/410 prunes |
| `upstream-credentials.test.ts` | envelope actually encrypted + version byte; `connectionStatus` totality; the callback rejection matrix (missing/replayed/expired/other-session state, `iss` mismatch) each storing **nothing**; PKCE + token-endpoint pinning enforced by a fake AS that does REAL S256 checks |
| `admin-ops.test.ts` | the ops table: uniform `pmcp` rejection driven over `Object.keys(ops)` so a new op can't forget it; cascade atomicity (both rows gone or neither); audit discipline as a table (every mutating op exactly one `admin.<tool>` row, reads none); **parity direction A** — every op renders as a pmcp tool from its one zod schema |
| `auth-matrix.test.ts` | §7 step 1 + whoami as one ~25-row table, every refusal beside its allow-twin: the 401/404 matrix, `pmcp_svc_` never-session, cookies never on `/mcp`, Origin rules, bearer-sourced session rejected on `/account`, bootstrap route 404-when-unset |
| `order.table.test.ts` | the check order as the table it is (~16 rows): ungranted+archived → `-32001` not `-32002`; unknown prefix → `-32001`; first-`_` split; `server/discover`; `-32601` |
| `upstream-proxy.test.ts` | the failure table (everything → `-32000`, `data` unset, body never echoed, class only in audit detail); aggregated fan-out with a failing + a hanging upstream; refresh-before-forward observed in order; `X-Pmcp-*` only with `forward_identity`; **subrequest counts asserted explicitly** (workerd enforces no cap locally) |
| `admin-pipeline.test.ts` | pmcp through the real endpoint: accounts see no `pmcp_*` tools (structural), owner never approval-gated, `builtin: true` row |
| `hygiene.test.ts` | sentinel-string sweep: no persisted row contains token material or an unmasked sentinel secret; bodies exist only in approval `args_json` and the audit body columns, always post-redaction (§15 — the body table: `log_bodies` defaults by kind and flips both ways, results only as masked structuredContent, unstructured blocks → blob stubs, over-cap → oversize stub against a shrunk `AUDIT_BODY_CAP_BYTES`, `token_issue`'s recorded result masked by the uniform rule); served outputSchemas carry no `writeOnly`; recomputed post-redaction hash equality + raw-hash inequality |
| `cron.test.ts` | one scheduled run produces all three effects; the wrangler cron string equals the expected constant (honestly labelled — nothing local proves an expression fires daily) |
| `web-pages.test.ts` | thin by design: CSRF rejection with the ops handler provably not run; `/approvals/<id>` owner-only; export line count = `total`; **parity direction B** — form fields = the same zod schema's keys |
| `routes.test.ts` | the §2 router-walk equivalence, both sides derived; reserved-username refusal |
| `contracts.test.ts` | **the L4 producer** (§4) |

### `tunnel` — serial: the DO, live sockets, hibernation

| File | Pins |
|---|---|
| `smoke.test.ts` | **written first, kept forever**: (1) SQLite-backed DO works on Windows; (2) `serializeAttachment` survives `evictDurableObject` — *unverified upstream, and the whole connection identity rides on it*. If (2) fails, ServiceConnection needs a durable-storage fallback before anything else here is written |
| `protocol.test.ts` | §6 wire: registration deadline via `runDurableObjectAlarm` → 4004 (no sleeping); pre-register traffic rejected; register → catalog warmed (fake service observes the `tools/list`); newest-wins at acceptance with `hub/replaced` + 4000; vanished row → 4003; drift audit row; no application heartbeat |
| `lifecycle.test.ts` | sever codes; `onlyIfTokenId`; wipe idempotent; **the §15 ordering pins observed live**: at the moment 4001 is seen, D1 already has no rows; archived flag lands before 4002; catalog survives disconnect; upgrade matrix (403 means exactly archived) |
| `hibernation.test.ts` | the honest hibernation pins via `evictDurableObject`: socket round-trips after eviction; catalog still served; identity survives via attachment; the alarm still fires; **the pending map is EMPTY after eviction** — converting §6's unvalidated assumption into a validated one. (No test asserts the map survives; upstream proves it doesn't.) |
| `pipeline-tunnel.test.ts` | §16's core integration test: both endpoint shapes, role filtering, `_meta` hygiene observed at the service (strip-then-set, mirrored capabilities, ids never cross), deadline → `-32000`, the audit chokepoint (row exists with `duration_ms` when the response resolves) |
| `approval-e2e.test.ts` | §16's approval bullet over a real tunnel with the fake service's **invocation counter as the exactly-once oracle**; CAS under table-driven deterministic interleavings (never fire-50-and-hope — workerd is cooperative); availability-between-check-and-claim both directions; MRTR legs; the redaction union; catalog-miss refused with `-32001` (decided 2026-08-25) |

### Clients and scripts

JS and Python each get: a transport file against an in-process fake hub (real
upgrade rejection with 401 vs 403 — the split the fatal-vs-retry policy turns on),
a reconnect-policy table transcribed from the shared close-code fixture (the
deliberate cross-language duplication, one oracle), an api file, and a contract
consumer. Python: `anyio_mode="auto"`, asyncio backend, a ~10-line recorded-sleep
fixture instead of a fake clock (anyio has no injectable clock on asyncio).
`scripts/test/bootstrap-contract.test.ts` pins the status→message mapping — the
one place a bare fetch stub is legitimate.

## 4. Cross-language contracts: `contracts/*.json`

The spec deliberately COPIES wire shapes across boundaries with no shared package.
The pin mechanism: checked-in JSON fixtures — whoami, the error codes + `-32003`
data, tunnel frames, **close codes → required client behavior**, bootstrap
request/response, admin op names + schemas, the `service_list`/`account_list` rows
the diff planner reads, and the audit body-stub wire shape (`blob`/`oversize` —
spec §15 defers its exact spelling to these fixtures).
`server/test/worker/contracts.test.ts` is the **only
writer**, asserting the server's real emissions deep-equal each fixture;
CLI/clients/scripts consume them read-only. Plain JSON means neither side can
import a type from it, so the copied shapes stay copied while both answer to one
oracle. `pnpm contracts:update` regenerates; a commit touching a fixture plus an
implementation file is the tell that someone made a test pass. Parity directions
C and D live here too: every planner-emitted step maps to an ops key with the
schema's required fields present, and every non-auth CLI subcommand maps to an
ops key, total in both directions.

## 5. What was considered and rejected

- **Regression-only floor**: dies to the cost asymmetry — auth/redaction/approval
  bugs are silent; a suite encoding only noticed bugs can't cover failures
  invisible by construction.
- **Characterization-after**: anchors on the implementation's interpretation — a
  wrong 401-where-404-belongs gets frozen as "expected". Backwards for a
  refusal-heavy system.
- **Classic per-function unit TDD everywhere**: green units, broken pipeline; and
  the home of one-spec-line-changes-forty-tests.
- **Full ceremony** (deployed e2e in CI, Playwright, Stryker, model-based state
  machines): the solo-owner project-killer. A fast-check model of the approval
  machine is a second implementation of the same rules under the same churn, for
  a state space ~14 explicit rows already exhaust. Three server-rendered forms do
  not justify a browser dependency. Coverage tooling: V8 coverage is unsupported
  here anyway, and a percentage target breeds tests that assert nothing.

## 6. Authored when, by whom

| Artifact | When | Author |
|---|---|---|
| Table rows + law statements | **before implementation**, from the spec alone | owner — or an agent whose only input is the spec section, never the implementation |
| `tunnel/smoke.test.ts` | **first file in that directory** — two platform assumptions gate three other files' shape | agent, run immediately |
| Harness (seed / fake-upstream / fake-service) | before implementation — building it against the skeletons is itself a design check: if seeding a namespace is awkward, a production seam is wrong | agent |
| Runners (~20 lines each) | with the harness | agent |
| The CAS/concurrency test | **before implementation** — the one test that constrains implementation *shape* (rules out SELECT-then-dispatch) | owner |
| Implementation | after; the tables are the acceptance criteria | agents |
| Law/property tests | after first green is fine — hardening, not design | either |

Vertical slices so the outer loop is never red for weeks: (1) identity + registry
+ gateway + `service_list` + fake tunnel → auth and order tables green; (2)
approvals + CAS; (3) upstream/OAuth; (4) the CLI planner (pure, independent, any
time); (5) client libraries.

Where fail-first genuinely pays: the CAS test, and anywhere the spec is ambiguous
— writing the assertion is the moment ambiguity must resolve. Watching red
against skeletons that all `throw "unimplemented"` is ceremony: red is guaranteed
and proves nothing.

## 7. Durable contract vs incidental detail

**Rule: if the spec sentence would survive a full rewrite of the module, pin it
hard. If the assertion names a number, a prose string, or a database column, it
is incidental — put it behind a named constant or don't assert it.**

Durable: refusal codes and their **order**; 401-vs-404 indistinguishability; what
is persisted and what is *never* persisted; approval exactly-once; close-code →
client-behavior; `<slug>_<tool>` splitting; `hub/*` strip-then-set; the pattern
language; `all` reserved-but-grantable; the whoami shape.

Incidental: every timeout literal (assert *that* a deadline is enforced, via the
constant and the injected clock); error prose (assert code + presence of
`approvalUrl`); audit `detail` layout; SQL/columns; list ordering; page/chunk
sizes; all HTML; `last_used_at` cadence.

## 8. When a test fails: code wrong, or spec changed?

Three commit types, declared in the message:

- `fix:` — the code was wrong. Row unchanged, spec unchanged.
- `spec:` — the spec changed or was ambiguous. **The row and the spec line change
  in the same commit — never the row alone.**
- `test:` — the row mis-transcribed the spec. Spec unchanged.

Because the oracle is data, discrimination is nearly automatic: a spec change
touches rows; a code regression touches none. Every row prints its spec section
in the test name (`§7 step 2 · pending dedup returns same approvalId`), so a
failure names the sentence to re-read.

## 9. Keeping agent-written tests honest

1. **The oracle is owner-authored and commit-separated.** Rows, law statements,
   and `contracts/*.json` land in their own commits before implementation. Agents
   write runners, harnesses, and implementations — never rows, never fixtures. A
   pre-commit/CI check fails any commit touching both oracle files and
   implementation files.
2. **Every refusal row carries its allow-twin.** A deny-only oracle is satisfied
   by `throw` everywhere — the reward-hacking attractor in a security-heavy
   codebase. 401-for-revoked sits beside 200-for-live.
3. **Spot mutation, not coverage, once green.** ~6 hand-picked wrong
   implementations must go red naming the right row: swap two check-order stages;
   SELECT-then-dispatch; hash before redaction; naive `'^'+p+'$'`; drop the
   `hub/*` strip; 401 where 404 belongs. Thirty minutes, no tooling. Corollary:
   an agent never resolves a red test by editing it — only `fix:`, `spec:`, or
   `test:`.

Never faked, anywhere: a sibling module, D1, the `ServiceConnection` DO,
WebCrypto, or the MCP SDK on either side. The fakes that do exist (fake upstream,
fake AS, fake push endpoint, fake tunneled service, fake hubs for the clients) do
*real* protocol work — real JSON-RPC, real S256 PKCE checks, real decryptable
push crypto — and each documents what it must NOT fake. The fake AS should be
**adversarial**, not spec-shaped: no RFC 9728 document, CIMD rejected so DCR is
forced, no `expires_in`, single-use rotated refresh tokens — ~20 lines that
convert four production-only OAuth failures into in-process ones.

## 10. What in-process testing structurally cannot catch

workerd enforces no production limits locally, never hibernates spontaneously,
runs one code version, and sits behind no edge. The full gap analysis produced
seventeen uncovered failure modes; most became **code contracts** (map any DO-stub
throw to `-32000`; version the socket attachment and treat unknown versions as
4004-reconnect; `redirect: 'manual'` on upstream dials so a redirect can't walk
off with a bearer token; validate aggregated tool names against the consumer
charset `^[a-zA-Z0-9_-]{1,128}$` — the spec's own `get.news` example violates it;
one bounded retry on the audit write; jitter the first reconnect delay) or
**in-process assertions** (explicit subrequest budgets; a forward-migration test
that applies 1..N−1, inserts rows, then applies N).

What remains runs out-of-process, sized to a personal project:

**Automated, every deploy (~30 s, inside `pnpm deploy` so it can't be skipped):**
migration gate (`wrangler d1 migrations list --remote` clean; secret names ⊇
`secrets.required.txt`) → deploy → post-deploy smoke (`/api/health` presence-only
booleans for every binding and secret; `/api/whoami` shape). This converts the
worst silent failure — a missing secret surfacing months later — into a red deploy.

**Automated, on demand / pre-release (~2 min, local — no CF credentials in CI):**
`scripts/e2e.ts` against the dev worker: the example service over real wss/TLS
through the real edge, both endpoint shapes via the real MCP client, the approval
loop end to end, and a deploy fired while a slow call is in flight (must yield a
clean `-32000`, never a hang or 502, bot back online in ~5 s).

**Manual, once at implementation, answers written back into the spec as validated
facts (each with a re-run trigger):**
- *Hibernation/keepalive soak*: bot idle 15+ min, then one call — retires three
  assumptions in one observation (idle DOs actually hibernate, `serializeAttachment`
  survives real hibernation, the edge doesn't kill idle sockets at ~100 s).
- *Deploy across a hibernated socket*: does the spec's "deploys terminate all
  WebSockets" actually hold? Either answer gets written down.
- *Real Claude Code as consumer*: the Electron `Origin` header vs our 403; GET/SSE
  probes against a POST-only endpoint; tool-name charset acceptance; the
  approve-on-phone loop. The only test of the actual product with the actual consumer.
- *Push per real browser* (Chrome, Android, iOS-installed-PWA — the likeliest to
  just not work); *real OAuth connect per provider* (findings fed back into the
  adversarial fake AS); *bootstrap + WAF verification* (30 rapid logins → 429; a
  plain curl gets JSON, not a bot-challenge page).

**Passively, forever:** `scheduled()` writes one `cron.swept` audit row per run —
"did the cron fire" becomes a question the `/audit` page answers. Approval expiry
stays lazy, so that leg is a janitor — but since bodies landed in audit under the
7-day retention (§11), the prune leg is a GUARD: a dead cron leaves recorded call
bodies readable via `audit_query` indefinitely, which is precisely the failure
the `cron.swept` heartbeat exists to surface early.

**Per-commit CI (~2 min, zero credentials):** `tsc --noEmit` + vitest (worker/unit
parallel; tunnel serial) + pytest + `wrangler deploy --dry-run` — the dry-run
earns its five seconds by catching the whole config-drift family, including the
`nodejs_compat` flag the test pool silently swallows but deploy rejects.

Accepted risks are recorded with explicit revisit triggers (D1-under-real-
concurrency: trigger = an approval consumed twice; deploy-storm behavior: trigger
= >50 services; browser-side PWA mechanics: trigger = the web surface outgrowing
§13 or a second contributor; RFC 9207 as likely-dead-branch; constant-time
compare as reviewed-not-tested).

## 11. Decisions and findings from authoring this strategy

Resolved:
- **Catalog-miss refusal → `-32001`** (decided 2026-08-25): an unknown tool inside
  an approval-mode pattern must be indistinguishable from an ungranted one; spec
  §7 and both skeleton comments updated.
- The router-walk test §2 mandates is now a named suite (`routes.test.ts`).

Resolved 2026-08-25 — **availability-first**: the approval gate consults known
availability before touching any approval row — a service the hub already knows
cannot execute (tunnel offline; proxied `not_connected`/`needs_reconnect`) fails
`-32000` with no pending row, no push, and no pass consumed. Spec §7 + gateway/
approvals skeleton comments updated; the order-table and approval-e2e rows encode
(no pass × known-offline) → `-32000`.

Resolved 2026-08-25 — **N1 applied**: registry exports the pure pair
`writeOnlyPaths(schema)` / `applyRedaction(args, paths)`; tunnel, approvals, and
the gateway's audit-body path (the principal consumer since the body decision)
consume them, so the path grammar has one definition and `unit/redact.test.ts`
is unconditional. **N2 applied**: `backoffDelay(attempt, rng)` (JS) and
`backoff_delay(attempt, rng)` (Python) exported pure, first delay jittered from
zero (the deploy-storm mitigation, now table-testable).

Resolved 2026-08-25 — **constants module applied**: `server/src/limits.ts` owns
the six timing constants; the fan-out deadline and the call budget are TWO knobs
(a slow upstream may take 30 s when called directly but must not hold the
aggregated listing hostage past 10 s). `ApprovalsConfig.now()` re-added with it.
**Attachment versioning applied**: `ConnectionAttachment {v: 1, …}` in tunnel.ts;
a wake reading an unknown or absent version closes 4004 → routine reconnect.

Resolved 2026-08-25 — **`UPSTREAM_CREDS_KEY`** wins the secret-name drift
(`index.ts` updated). **Cron legs under `allSettled`** as a stubbable named
list, per-leg outcome folded into the `cron.swept` row (skeleton updated).
**Fixture governance**: regenerating `contracts/*.json` is owner-run and always
its own commit; CI rejects commits touching `contracts/**` together with
implementation files (§9 rule 1). **`pageRoutes`-as-data**: considered and
rejected — exporting routes solely for a test violates the suite's own
no-test-only-exports rule; Direction B plus review is the guard. **E1
acknowledged**: the constant-time BOOTSTRAP_SECRET compare stays
reviewed-not-tested (timing is not behaviorally observable in-process).

Resolved 2026-08-25 — **audit bodies, uniform rule** (spec §5/§7/§15, decision
22): the pmcp-body special case is GONE — `token_issue`'s key is a
`writeOnly`-marked output field masked like any other secret. Sensitivity is
declared in both directions: the client libraries' `Secret` field type /
`secret()` wrapper emits `writeOnly` in input and output schemas (the hub strips
it from served outputSchemas — internal marker only), and config gains
`redact_results` beside `redact`. Audit `tools/call` rows carry bodies per the
per-service `log_bodies` flag (tunneled default on, proxied default off — no
trustworthy proxied schema, so the owner opts in with config paths): args and
result structuredContent post-redaction; unstructured blocks and over-cap bodies
become typed size stubs (`AUDIT_BODY_CAP_BYTES`, default 16 KiB). Retention
drops to **7 days** default; both knobs are env vars parsed once at the
composition root (`AUDIT_RETENTION_DAYS`, `AUDIT_BODY_CAP_BYTES`), with
limits.ts holding the defaults. `hygiene.test.ts` owns the body table;
`unit/redact.test.ts` walks both directions. (Also fixed while pinning: §5's
`service` table had never materialized the config `redact` column — it now has
`redact_json`, `redact_results_json`, and `log_bodies`.)

Resolved 2026-08-25 — **the skeleton-authoring escalations**, decided as a batch:
- **Injected clock in identity** (`resolvePrincipal` / `resolveServiceToken` /
  `issueToken` take optional `now()`): the expired-token refusal is seeded by
  issuing at a fake t0 and resolving past expiry — no sleeping, no test-only
  mint-dead-token affordance; same rationale as `ApprovalsConfig.now()`.
- **Tunnel wire vocabulary exported** (`CLOSE_REPLACED`/`CLOSE_ROW_GONE`/
  `CLOSE_PROTOCOL`/`HUB_METHODS` beside the existing SeverCode pair): the
  published cross-language contract, not hidden mechanics — the contracts
  producer emits fixtures from it, and `tunnel/protocol.test.ts` asserts observed
  wire values equal the exports, locking behavior to the table. No sibling
  imports them.
- **The writeOnly walk resolves local refs** (spec §7): same-document `#/…` JSON
  Pointer resolution, mark union across `allOf`/`anyOf`/`oneOf`, secret-free
  cycles cut. The refuse-line — external refs, `$id`/`$anchor`/`$dynamicRef`,
  recursive-secret cycles — is enforced by the new pure
  `registry.validateSchemaIndirection` at catalog warm: loud per-tool violations,
  registration still succeeds, the tool is cached schema-unsound → `sensitivePaths`
  null → `-32001` on gated calls and no recorded bodies. Forced client-side
  inlining was considered and rejected (plain-SDK bots emit `$defs` by default;
  refusing them breaks the just-connect promise). `unit/redact.test.ts`'s open
  `$ref` ambiguity is thereby closed.
- **Named constants** for the role caps (`ROLE_PATTERN_MAX_LENGTH` /
  `ROLE_PATTERNS_MAX` / `ROLE_NAME_MAX_LENGTH` in limits.ts) and the mask
  sentinel (`registry.REDACTED`) — the table runners lose their caps/sentinel
  parameters and reference the names.
- **Close-code behavior vocabulary**: three behaviors (`stop_fatal` /
  `stop_quiet` / `reconnect`) plus a `schedule` attribute (`exponential` /
  `max_only`) — matching the row shape both client suites already carry; the
  contracts README and both client docstrings align to this one vocabulary.

Open: none.

First tasks at implementation, no decision needed: verify better-auth 1.7 on D1
inside workerd before `auth-matrix.test.ts` is written (Kysely D1 dialect —
sources conflict), and run `tunnel/smoke.test.ts` before anything else in
`server/test/tunnel/`.
