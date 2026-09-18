## 10. What in-process testing structurally cannot catch

workerd enforces no production limits locally, never hibernates spontaneously, runs one
code version, and does not execute the real Sandbox container. Code contracts and
in-process assertions cover deterministic routing, D1, authorization, limits, and
adapter behavior. They cannot prove the Deno permission boundary, container egress,
remote process termination, instance capacity, package/image compatibility, or
six-minute idle policy.

What remains runs out-of-process, sized to a personal project:

**Automated, every deploy (~30 s, inside `pnpm deploy` so it can't be skipped):**
migration gate (`wrangler d1 migrations list --remote` clean; secret names ⊇
`secrets.required.txt`) → deploy → post-deploy smoke (`/api/health` presence-only
booleans for every binding and secret; `/api/whoami` shape). This converts the
worst silent failure — a missing secret surfacing months later — into a red deploy.

**Automated, on demand / pre-release (local and staging):** `scripts/e2e.ts` keeps the
real tunnel/approval/deploy checks. The §23 staging run additionally builds/deploys the
container and exercises hub-only aggregate/scoped hub, direct scoped preservation,
typed resource→tool composition, permission denials, revocation/final-publication
withholding, limits/disconnect kill, collision stability, audit hygiene, and provider/SDK
round trips.

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
- *Hub Sandbox staging matrix* (§23): exact-token isolation/warm reuse/OAuth rotation;
  public-net/env/files/run/FFI/import/binding/forgery negatives; a 150 s run; admitted
  deadline unchanged by settings update; six-minute idle sleep; remote timeout and abort
  leave no process; package/control-image parity; replacement yields a classified,
  non-replayed result. Re-run on any Sandbox SDK, control-image, Deno, Wrangler,
  compatibility-flag, container-size, timeout, or bridge change.

Implementation observation (2026-09-18): WSL2 (`columbia`) with Docker Engine 29.6.2
built the real container from the pinned Sandbox `0.13.0-next.751.1` control image and
Deno `2.9.6`, both through a full Wrangler dry-run and `wrangler dev`. Against that live
local container, `/mcp/hub` listed only `execute`/`search_types`; valid TypeScript returned
its value; a type error ran no program; public network, environment, filesystem and
subprocess attempts returned runtime errors; recursive execute and remote imports failed
type checking. Multiple programs on one session reused one HubSandbox container, while two
distinct session tokens produced two distinct HubSandbox container ids.

The paid deployment then passed the 35-step production smoke, including aggregate and
scoped hub execution. Two authorization-code grants for one OAuth binding produced
different JWTs; both completed programs under distinct live HubSandbox instance ids, and
revoking the binding rejected the rotated token. A 150 s program completed across the
former two-minute boundary after its owner's settings were lowered three seconds into the
run, proving the admitted 180 s deadline remained immutable. Aborting another request after
1.5 s released the token slot within eight seconds and its follow-up completed.
After the last call, every recorded instance reached `inactive` across the configured
six-minute window; none remained running. Both paid verification windows ended by deleting
the Container application, and the longer window also had a detached 30-minute deletion
backstop. Even assuming all ten `basic` instances ran at their provisioned maximum for
both complete windows, the upper bound stayed below 5 GiB-hours of memory, 20 GB-hours of
disk, and 75 vCPU-minutes—respectively below the plan's included 25 GiB-hours, 200
GB-hours, and 375 vCPU-minutes.

Saturating the ten-instance deployment with eleven exact tokens confirmed that the
deployment never exceeded its configured `max_instances: 10` guardrail. Cloudflare queued
or disrupted starts instead of returning the SDK's `ContainerUnavailableError`, so callers
observed a mixture of completions, `check_time`, `wall_clock`, and pre-operation
`sandbox_error` results; the latter correctly reported `containerReplaced: true`. This is
accepted platform behavior: the deployment maximum is the capacity contract, while the
wire result remains the stage-specific outcome the coordinator can prove rather than an
invented capacity classification. The coordinator classifies a budget consumed after a
successful check but before user evaluation as transient `cold_start`; that narrower bug
is regression-tested. The SDK/control-image/Deno/Wrangler/compatibility/config triggers
above remain mandatory.

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
= >50 apps; browser-side PWA mechanics: trigger = the web surface outgrowing
§13 or a second contributor; RFC 9207 as likely-dead-branch; constant-time
compare as reviewed-not-tested).

