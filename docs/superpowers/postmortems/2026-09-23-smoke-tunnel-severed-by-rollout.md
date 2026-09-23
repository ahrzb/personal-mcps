# The post-deploy smoke failed hub_execute because the rollout severed its tunnel

- **Found:** 2026-09-23, by the owner, running `pnpm ship` for a web-CSS-only change (version `25dcf4a5`)
- **Symptom:** `§23 · hub search_types and execute cross the deployed QuickJS boundary` failed with `hub_execute kind runtime_error`. An immediate re-run against the same deployment passed all 37 steps.
- **Impact:** One failed ship gate. No product breakage. Any agent calling `smoke-app` in the same ~1 s got `-32000 app unavailable`, which is safe to retry because nothing was dispatched. Every offline-tunnel refusal the availability probe ever wrote has a NULL `detail`, so the ledger could not say why it happened.
- **Class:** boundary-actor, silent-default

## Root cause
The deploy finished at 06:45:57.9Z. From the D1 ledger:

| t after deploy | row | event |
|---|---|---|
| +14.3 s | 13623 | `connect.register smoke-app` (the smoke's tunnel) |
| ~+15–16 s | — | the tunnel drops |
| +16.2 s | 13628 | `smoke-app echo` `-32000`, `detail` NULL, 293 ms (the inner call from `hub_execute`) |
| +17.2 s | 13629 | `connect.register smoke-app` again (the client library reconnected) |

The chain: the program compiled and ran in QuickJS, and `mcp.smokeApp.echo` dispatched. The gateway's availability probe then found the tunnel not `online` and refused with a class-free `unavailable()`. The guest promise rejected with `HubOperationError`, and nothing caught it. §23.11 turns an uncaught guest exception into `runtime_error` (`program_error:HubOperationError`, non-transient).

The drop was most likely the rollout reaching the app's Durable Object. The platform restarts every DO on a new version and closes its WebSockets (`clients/js` says so itself: "hub deploys sever every socket"). The smoke creates its app about 12 s after the deploy, and its DO can come up on the old version. **This link is inferred, not observed.** Workers Logs were out of reach: wrangler's OAuth token has no observability scope, and the built-in browser was not signed in to the dashboard. The supporting evidence: in 14 smoke runs over three days, this is the only one with a second `connect.register`, and its timing matches the client's reconnect delay (0–1 s jitter).

## Why the tests missed it
- The flake is not a code bug. It is a race between the platform rollout and a walk that starts seconds after `wrangler deploy`, and only the live smoke runs in that window.
- The missing class is a test that does not check what its title says. `pipeline-tunnel` 14a's title says the second call "records `offline`", but the body checked only the wire message. The probe runs before the DO's `forward`, so the forward's own `offline` class is almost never reached.

## Fix
- `2c071aa`: 14a now checks `failureClass: "offline"` on that row (red before the fix).
- `e21243b`: `probeAvailability` refuses an offline tunnel with `unavailable("offline")`. The wire message is still the bare "app unavailable", because `offline` is in the dispatched-nothing set.
- `41f370b`: when the smoke's `hub_execute` does not complete, it prints the whole result, including cause and message.
- Deployed as `684ccac0`. Smoke 37/37.

## Candidate countermeasures (recorded, not enacted)
- When a smoke step fails, check `audit_query` for a second `connect.register` of `smoke-app` and add "tunnel severed mid-walk (deploy rollout?), re-run" to the failure line. Alternatively, wait out the rollout before registering the tunnel. There is no rollout-complete signal, so this would be a timed wait.
- The other `§23` diagnostic checks in `scripts/smoke.ts` (the `type_error`/`runtime_error` kinds) still print only the kind on failure.
- A review question for any test title that names a ledger value: does the body assert it?

## Misdiagnoses along the way
- **"The first QuickJS execution on a fresh isolate fails"** (WebAssembly instantiation or TypeScript lib parsing exceeding a CPU budget, or a lazily initialised singleton racing). The ledger ruled this out. The inner `echo` row exists, so the program compiled, ran and dispatched. The first `hub_execute` on an isolate does cost 470–720 ms against about 200 ms warm, in every run, but that is well inside the budget and never failed.
