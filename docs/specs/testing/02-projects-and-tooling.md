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
- **How a constant is shrunk: through the hub's own env, never a global.** Existing
  direct/push deadlines and §23 check/inner/cleanup waits that tests must shorten are
  read through `limits.deadlines(env)` as positive integer milliseconds. Production
  ships named constants. The harness deletes overrides on teardown. Fake timers and
  `vi.mock` do not reach workerd/DO code and are not substitutes.

The projects:

| Project | Where | Mode | What belongs |
|---|---|---|---|
| `unit` | plain Node | parallel, ms | pure seams, including hub mapping/schema/declaration/search |
| `worker` | workerd | parallel, per-file isolation | real D1, socket-free pipelines, real Sandbox module/config with containers disabled |
| `tunnel` | workerd | serial | AppConnection sockets, alarms, hibernation and listen |
| `scripts` + clients | Node / pytest / Go | parallel | CLI, contract consumers, transport aliases and fake hubs |

The Sandbox package is prebundled in both workerd projects with
`enableContainers: false`; container behavior itself belongs to strategy §10.

