# Test-suite slowness report — personal-mcps (2026-09-02)

Machine: Windows 11, 12 logical CPUs, 31 GB. vitest 4.1.11 + @cloudflare/vitest-plugin 1.0.0. Nothing in the repo was modified; all runs used `npx pnpm exec vitest run …` with a custom timing reporter living in the scratch dir (`profile/timing-reporter.mjs`), which records per-file `setupDuration` / `collectDuration` / `result.duration` and vitest's per-URL module-fetch metadata.

## 0. The shape of a full run (run D: 385 s wall, 45 files, 1432 tests, all green)

vitest reports `Duration 385.26s (transform 123.28s, setup 524.44s, import 17.94s, tests 527.68s)` — those four are SUMS across files, not wall. The wall decomposes as:

| window | what is happening | evidence |
|---|---|---|
| 0 – 6 s | vitest boot: config (readD1Migrations, VAPID keygen), Vite server, wrangler config parse | run A `real 19.3 s` vs reporter wall 14.4 s; cpu-prof: `wrangler __init` 0.4 s |
| 6 – 45 s | first wave: 11 workerd processes spawned, each loads the whole worker (1,678 modules) through the host; **no worker test runs before t = 45 s** | every first-wave file: `setup` 38–39 s, `start` 45.5 s |
| 45 – 240 s | worker project tests. Bounded by ONE file: `upstream-proxy.test.ts`, 194 s of tests. Everything else is done by t ≈ 118 s | rows below; run G (same project without that file) = 117 s wall |
| 240 – 385 s | `tunnel` project, serial, one workerd: 13.3 s setup + 131 s tests | protocol.test.ts `setup` 13261, `start` 254160; smoke.test.ts ends 385265 |

unit / cli / clients: all finished by t = 9 s, invisible in wall time.

Per-project sums (run D): worker setup 511 s · tests 383 s (17 files, 800 tests) — tunnel setup 13 s · tests 131 s (10 files, 227 tests) — clients 12.7 s — cli 1 s — unit 0.15 s.

## 1. Causes, ranked by wall-clock they cost

### #1 — `server/test/worker/upstream-proxy.test.ts` waits out the REAL 30 s / 10 s deadlines — ≈123 s of wall (32 %)

Evidence
- Run D: this file's tests take 194.4 s; the worker phase ends when it ends (t = 240 s). Run G, identical command minus this file: **117 s** wall instead of 240 s.
- 10 of its 48 tests cost 193 s: 40.2 s, 30.5 s, 30.3 s, 20.3 s, 10.5 s, 10.3 s, 10.2 s ×4 (top of the slow-test list, `profile/runD.json` → `slow`).
- Mechanism: `src/limits.ts:13 CALL_TIMEOUT_MS = 30_000`, `:21 AGGREGATED_LIST_DEADLINE_MS = 10_000`; enforced by `src/upstream.ts:207/446/1033 AbortSignal.timeout(CALL_TIMEOUT_MS)` and `src/gateway.ts:863-872 withDeadline()` (a `setTimeout` race). The fake upstream's `hang` mode (`harness/fake-upstream.ts:85`) never settles, so each hang row pays the full constant. The file says so itself (`upstream-proxy.test.ts:51-59`) and sets `CASE_BUDGET_MS = 80 s` (line 717).
- Only 3 rows are declared `act: "hang"` (lines 450, 462, 1277). The other 7 slow tests are NOT about hanging: the "§10 aggregated list over N proxied apps" block seeds a shared world that contains a `HANGING` app (line 1174), so every aggregated listing in that block pays 10 s (and the "second list dials again" test lists twice: 20.3 s).

Cheapest fix
- The file rejected `vi.mock("../../src/limits")` because a mock does not reach src inside workerd. But test and src share one isolate, and the repo already has the working pattern: `worker/listen.test.ts:191-206` and `tunnel/stream.test.ts:150-160` wrap `globalThis.setTimeout` and map ONE exact `ms` value (`ms === LISTEN_KEEPALIVE_MS ? SHRUNK : ms`). Do the same here for both knobs: wrap `globalThis.setTimeout` (covers `gateway.withDeadline`) and `AbortSignal.timeout` (covers `upstream.ts`) with `ms === CALL_TIMEOUT_MS → ~300 ms`, `ms === AGGREGATED_LIST_DEADLINE_MS → ~150 ms`, restored in `afterAll`. ~15 lines, one file.
- Expected gain: the file drops from 194 s to roughly 5–10 s; full-suite wall 385 s → ≈260 s.
- Risk: the file's assertions on elapsed time (`line 1346-1349`: `elapsed ≥ AGGREGATED_LIST_DEADLINE_MS` and `< CALL_TIMEOUT_MS`) must compare against the shrunk values; keep the ratio (shrunk list deadline < shrunk call budget) so the "two knobs" claim stays pinned. The plugin itself monkeypatches `setTimeout` (`vitest-plugin/dist/worker/index.mjs:757-775`); wrapping on top of it is exactly what listen.test.ts already does, so this is proven in this pool. `CASE_BUDGET_MS` shrinks with the constants only if it is derived from the shrunk values — check it after the change. Nothing here fakes D1/DO/better-auth (strategy §9): the hub still enforces its own deadline, just a shorter one — the strategy's own "shrink the constant, never wait it out" rule (§2).

### #2 — the serial `tunnel` phase: 145 s (38 %), of which 33 s is one negative wait — ≈31 s recoverable cheaply

Evidence
- Phase = 13.3 s setup (one workerd, `isolate:false`, `maxWorkers:1`, `vitest.config.mts` tunnel project) + 131 s tests, strictly serial after the worker phase (`sequence.groupOrder: 1`).
- `tunnel/protocol.test.ts`: 42.7 s for 35 tests; eight of them cost 4.06–4.11 s each — the refusal rows ("first frame not JSON-RPC → 4004", "silent past deadline → 4004", "deleted between upgrade and register → 4003", …).
- Mechanism: `protocol.test.ts:401 expect(await waitFor(() => app.lists.length > 0)).toBe(row.catalogWarmed)` — for a refused registration `catalogWarmed` is false, so `waitFor` (`harness/fake-app.ts:876`, default 250 turns of `tick()` = `setTimeout(1)`) runs its whole budget: 250 × 16.3 ms = 4.07 s. The same file already uses a short budget for other negatives (`:634` and `:768` pass `15`, `:940` passes `30`).
- Timer granularity is the multiplier: a 1 ms `setTimeout` costs ~15–16 ms on this machine (Node measured 15.0 ms/tick over 100 ticks; 4.07 s / 250 turns = 16.3 ms inside workerd). Every `tick()`-based poll in `harness/tunnel-do.ts` (`stillOpen` 25 turns ≈ 0.4 s per "still open" claim, 12 call sites; `untilStatus` / `untilCataloged` up to 250 turns) pays it.

Cheapest fix
- `protocol.test.ts:401`: `waitFor(() => app.lists.length > 0, row.catalogWarmed ? 250 : 15)` — one line, same precedent as lines 634/768. Same pattern at `tunnel/hibernation.test.ts:255` (`.toBe(row.survives)`), though no 4 s tests showed up there in run D.
- Expected gain: ≈31 s of wall (8 %).
- Risk: a 15-turn negative is a weaker "never" than 250 turns; the socket is already closed at that point (`line 399` awaited `app.closed`), so the catalog warm that could still arrive is one already-in-flight `tools/list` — 15 turns (~0.25 s) covers a D1 round trip comfortably on this machine, and lines 634/768 already rely on it.
- Not cheap, listed for completeness: the remaining ~100 s is 200+ real DO/WebSocket round trips at ~0.45 s per test with 15 ms polling ticks — `tick()`'s `setTimeout(1)` (`fake-app.ts:865`, whose header says 1 ms rather than 0 is load-bearing) coalesces to the OS timer on Windows either way; on Linux CI this phase is probably materially shorter. Unmeasured.

### #3 — every worker-project file re-loads the whole worker (1,678 modules) through the host — ≈45 s before the first worker test, ≈25–30 s recoverable

Evidence
- Plugin 1.0.0 + vitest 4 pool: `isolate: true` ⇒ a NEW Miniflare/workerd per test file (`vitest/dist/chunks/cli-api…js:3463-3560 Pool.schedule` → `CloudflarePoolWorker.start()` → `new Miniflare` at `vitest-plugin/dist/pool/index.mjs:61054`; `stop()` disposes it). There is no `singleWorker` / `isolatedStorage` option any more (grep of the pool bundle: none). Isolation is the process.
- The setup file `server/test/setup/d1.ts` imports `cloudflare:test`; the plugin's `load()` hook appends `import "<main>"` to that module (`pool/index.mjs:60700-60706`), so **setup = loading `server/src/index.ts` and its entire graph** — hono, better-auth + 4 plugins, kysely, @sentry/cloudflare — before `applyD1Migrations`. That is why `setup` (13 s/file alone, 38 s contended) dwarfs `import` (14 ms).
- Module count per workerd: 1,542 URLs (single file) / 1,678 (all 17 files); run D: **26,348 fetches**, 111.7 s of host fetch time. By package (fetches per file): kysely 254, @sentry/core 232, better-auth 184, libphonenumber-js 112, @better-auth/core 97, zod 79, @simplewebauthn/server 68, jose 56, @sentry/cloudflare 55, @opentelemetry/api 44, @peculiar/asn1-x509 43, app code 36.
- Cold vs warm (run C, two files serial): file 1 setup 13.2 s (Vite transforms), file 2 setup 5.4 s (transform cache hit — so ≈5.4 s per file is pure round-trip + workerd evaluation + migrations, and ≈8 s is host transform the first time).
- Host CPU profile of a single-file run (run B, `--cpu-prof`, 16.9 s sampled): idle 7.6 s (waiting on workerd), `@cloudflare/vitest-plugin` 1.9 s — almost all `flatten`/`stringify_*` i.e. devalue-serialising module code (+ inline sourcemaps) onto the WebSocket, vite 1.6 s + rolldown 0.9 s transforms, node ESM loader 1.7 s, GC 0.4 s. Under the 11-wide first wave the host thread is the bottleneck: setup inflates from 13 s to 38–39 s per file.

Cheapest fix (measured)
- Enable vitest's dependency pre-bundler for the worker project, direct deps only, with `node:`/`cloudflare:` external — see `profile/vitest.optimizer.config.mts`:
  ```ts
  test.deps.optimizer.ssr = {
    enabled: true,
    include: ["better-auth", "@better-auth/oauth-provider", "@better-auth/passkey", "@better-auth/infra",
              "@sentry/cloudflare", "hono", "webpush-webcrypto"],
    rolldownOptions: { external: [/^node:/, /^cloudflare:/] },
  }
  ```
  Run E2 (1 file): 1,542 → **417 URLs**, cold setup 13.2 → **6.8 s**, run wall 14.4 → 8.0 s. Run E3 (auth-matrix + identity-tokens + routes, 121 tests incl. better-auth sign-ins/device flows): all pass; setup 9.4 s each with 3-way contention (baseline first-wave 38 s, second-wave 13–15 s).
- Expected gain on the full suite (estimate, not measured end-to-end): first wave 39 s → ~20 s, second wave 14 s → ~7 s, tunnel setup 13 s → ~7 s ⇒ ≈25–30 s of wall, plus proportionally less host contention during the first minute of tests.
- Risk: (a) the first attempt with transitive packages (`kysely`, `zod`, `jose`, …) fails on pnpm's strict layout ("Failed to resolve dependency") and on `@sentry/cloudflare`'s `node:async_hooks` — keep to direct deps + externals as above. (b) A pre-bundled dep is one rolldown bundle instead of the package's own files; resolution conditions (`workerd`, `worker`, `module`, `browser`) still apply, but a package that relies on per-file side-effects or `import.meta.url` could differ — the 121-test canary saw none. (c) The bundle lives in `node_modules/.vite`; CI with a cold cache pays the optimizer build (~2–3 s) once per run. (d) It changes only how tests LOAD deps, not what runs — no fake anywhere.
- Not a fix: `isolate: false` for the worker project (per-file storage isolation is what the strategy §2 relies on and every seed assumes).

### #4 — `web-pages.test.ts` is the floor of the worker phase once #1 is fixed: 73 s of tests (146 cases)

Evidence
- Run G: it starts at 43.9 s and ends at 117 s — the last worker file to finish; next is order.table (ends 63 s).
- 77 `seedOwnerSession(` + 61 `seedNamespace(` call sites in the file (7 `beforeAll` blocks, 0 `beforeEach`; most sessions are minted inside cases). `seedOwnerSession` (`harness/seed.ts:302-320`) = `setPassword` (one scrypt hash) + a real `/api/auth/sign-in` (one scrypt verify) + D1 writes. better-auth's password hash is scrypt N=16384, r=16, p=1 (`@better-auth/utils/dist/password.mjs`), pure-JS `@noble/hashes` on the workerd path (`password.node.mjs` is chosen only under the `node` condition, which the plugin removes): **92 ms per hash** measured in Node (`profile/scrypt-bench.mjs`). ⇒ ≥154 hashes ≈ 14 s CPU in this file alone, more under contention; ~0.5 s per test average.

Cheapest fix
- Mint fewer sessions: share one owner session per `describe` for cases that only READ pages (the "every pane renders…" sweeps), keep per-case sessions only where the case mutates the session or credential. No harness or src change.
- Expected gain: unknown until counted per describe; the file cannot get below its ~30 real form-POST cases. Probably 20–30 s off this file, i.e. the worker phase floor 117 s → ~90 s.
- Risk: shared sessions couple cases (a case that signs out or rotates a password breaks its neighbours) — restrict sharing to read-only sweeps. Lowering scrypt cost via a test-only `emailAndPassword.password` override would be a prod-code branch on env and is arguably faking better-auth — not recommended.

### #5 — smaller, listed so nobody hunts them

- Host contention inflates test time modestly: `oauth-provider` 241 ms alone vs 303 ms in run D; `routes` 1.16 s alone vs 1.36–1.62 s. Reducing `maxWorkers` would not shorten wall (it serialises the same work).
- vitest boot ≈ 5–6 s (config load runs `readD1Migrations` + `generateVapidPair` at top level; the plugin imports wrangler for config parsing, 0.4 s in the profile). Not worth touching.
- `contracts.test.ts` collect = 2.05 s (its own 3,032-line file being transformed; others 0.6–0.8 s). Cosmetic.
- `@sentry/cloudflare`+`@sentry/core` (287 modules) and `libphonenumber-js` (112, pulled in by `better-auth/plugins` barrel via `@better-auth/oauth-provider/dist/authorize-*.mjs`) are 24 % of the per-file graph. Made moot by #3; without #3, `import { Hono }`-style direct plugin imports do not help because the barrel import is inside the dependency.

## 2. Per-file table (run D, top 15 by setup+collect+tests) and the split

| file | project | setup ms | collect ms | tests ms | tests start at | n |
|---|---|---:|---:|---:|---:|---:|
| worker/upstream-proxy.test.ts | worker | 38,966 | 748 | **194,448** | 45.5 s | 48 |
| worker/web-pages.test.ts | worker | 39,023 | 785 | 72,761 | 45.6 s | 146 |
| worker/order.table.test.ts | worker | 38,951 | 756 | 18,567 | 45.5 s | 66 |
| tunnel/protocol.test.ts | tunnel | 13,261 | 74 | 42,703 | 254.2 s | 35 |
| worker/admin-ops.test.ts | worker | 38,984 | 752 | 15,356 | 45.5 s | 34 |
| worker/hygiene.test.ts | worker | 38,986 | 747 | 14,990 | 45.5 s | 51 |
| worker/upstream-credentials.test.ts | worker | 38,856 | 745 | 12,476 | 45.5 s | 35 |
| worker/contracts.test.ts | worker | 38,929 | 2,052 | 10,548 | 46.8 s | 73 |
| worker/approvals.test.ts | worker | 38,834 | 753 | 8,439 | 45.5 s | 36 |
| worker/admin-pipeline.test.ts | worker | 38,858 | 740 | 7,785 | 45.5 s | 19 |
| worker/auth-matrix.test.ts | worker | 38,133 | 736 | 7,283 | 45.5 s | 74 |
| worker/migrations.test.ts | worker | 34,174 | 702 | 6,266 | 45.5 s | 108 |
| worker/cron.test.ts | worker | 15,640 | 130 | 4,666 | 68.7 s | 16 |
| worker/registry.test.ts | worker | 15,432 | 129 | 3,085 | 69.9 s | 38 |
| worker/identity-tokens.test.ts | worker | 15,197 | 40 | 2,734 | 70.4 s | 23 |

Tunnel files other than protocol: setup 2–4 ms each (shared workerd), tests: approval-e2e 13.8 s, pipeline-tunnel 13.5 s, stream 13.3 s, push 11.7 s, data-model 10.4 s, lifecycle 9.6 s, hibernation 8.1 s, subscriptions 6.5 s, smoke 1.0 s.

Full-suite split (sums): transform 123.3 s · setup 524.4 s · import (collect) 17.9 s · tests 527.7 s; worker module fetches 26,348 (1,678 URLs), tunnel 1,563 (1,554 URLs). Wall 385.3 s.

Uncontended reference points: 1 worker file alone: 14.4 s wall = 13.2 s setup + 0.24 s tests (run A/B); 2 files serial: 13.2 s cold + 5.4 s warm setup (run C); scrypt 92 ms/hash.

## 3. Surprises

1. The slowest file is slow on purpose: 10 tests wait out real 30 s / 10 s deadlines (`upstream-proxy.test.ts`), and 7 of those 10 are not hang tests — they share a world that happens to contain a hanging app (line 1174).
2. `protocol.test.ts` spends 4 s per refused-registration row proving a catalog did NOT warm (line 401) — 33 s of the serial phase for eight negative observations.
3. A 1 ms `setTimeout` costs 15–16 ms here (Windows timer coalescing); every polling helper in `harness/tunnel-do.ts` / `fake-app.ts` is priced in that unit. CI on Linux will not see the same numbers.
4. The D1 setup file is what pulls the whole worker into every file: `import "cloudflare:test"` is rewritten by the plugin to also `import "<main>"`. "setup 13 s / import 14 ms" is that, not migrations.
5. Plugin 1.0.0 spawns one workerd process per worker-project file (17 spawns + 1 for tunnel); the old `isolatedStorage`/`singleWorker` knobs no longer exist, so isolation cost is a process + a full graph load, not a storage stack push.
6. Host-side serialisation is a real cost: ~2.3 s per file of devalue `stringify` of module source over the WebSocket (cpu profile), i.e. ~40 s of host CPU across a full run just moving code.
7. `node_modules/.vite/vitest/…/results.json` still lists 28 deleted probe files (`zz-*.test.ts`, `_scratch_*.test.ts`, `spike.test.ts`) under server/test — someone has been dropping scratch tests into the tree; none exist now. Harmless, but it means that cache is not a reliable record of the real suite.
8. No test reaches the network (outboundService is total by construction, `vitest.config.mts` comment) and no test sleeps for a literal duration; the only real-time waits are the two above. `hygiene.test.ts:2486` and `listen.test.ts:97` poll with `Date.now()` deadlines but exit early on success.

## 4. Not measured, and why

- Inside-workerd split of the ~5.4 s warm setup (module evaluation vs. `applyD1Migrations` of 7 files / 37 KB vs. D1/DO init): no profiler reaches workerd from here, and a probe test file in the repo was out of scope.
- Full-suite wall with the pre-bundling config (#3): only 1- and 3-file runs were done (8 s and 16 s); the 25–30 s figure is extrapolated from per-file setup deltas.
- Per-file exact counts of sign-ins / device flows: the inventory subagent did not return before this report; the #4 numbers come from grep counts of call sites (`seedOwnerSession` ×77, `seedNamespace` ×61 in web-pages) rather than executed calls.
- Linux/CI numbers: timer granularity and process spawn cost differ; #2's polling cost is likely smaller there, #3's serialisation cost the same.
- Overlap disclosure: run D started with only the two idle `wrangler dev` servers alive (4 workerd, 0 vitest); the audit workflow's short single-file runs were live at the start of run G (3 workerd) and runs E2/E3 (2 workerd), so G's 117 s and E2/E3's numbers carry a small unknown contention — they are lower bounds on the gain, not upper bounds.

Raw data: `profile/runA.json … runG.json`, `runD.log`, `runG.log`, `prof/*.cpuprofile` (+ `cpuprofile-summary.mjs`), `scrypt-bench.mjs`, `vitest.optimizer.config.mts`, all under the scratch dir.
