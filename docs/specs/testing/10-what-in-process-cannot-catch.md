## 10. What in-process testing structurally cannot catch

workerd executes the same pinned QuickJS WebAssembly artifact as production, so in-process
tests cover the interpreter, fresh-runtime lifecycle, host-promise bridge, dynamic-compiler
removal, interrupt handling, routing, D1, authorization, and result contracts. It does not
reproduce production Worker CPU accounting, isolate scheduling and cold starts, deployment
packaging, or platform concurrency.

What remains runs out-of-process, sized to a personal project:

**Automated, every deploy (inside `pnpm ship` so it cannot be skipped):**
build the web asset, apply remote migrations, deploy the Worker, then run the production
smoke. The smoke checks binding/secret presence, the identity surface, aggregate and scoped
hub execution, an MCP tool call through an asynchronous guest promise, two live OAuth
credentials for one binding, and immediate refusal after binding revocation.

**Automated, on demand / pre-release (local and staging):** `scripts/e2e.ts` keeps the
real tunnel/approval/deploy checks. The §23 staging run additionally exercises hub-only
aggregate/scoped routing, direct scoped preservation, resource-to-tool composition,
permission denials, revocation/final-publication withholding, CPU/heap/stack/output limits,
disconnect disposal, collision stability, audit hygiene, and provider/SDK round trips.

**Manual, once at implementation, answers written back into the spec as validated facts
(each with a re-run trigger):**
- *Hibernation/keepalive soak*: bot idle 15+ min, then one call — retires three
  assumptions in one observation (idle DOs actually hibernate, `serializeAttachment`
  survives real hibernation, the edge does not kill idle sockets at ~100 s).
- *Deploy across a hibernated socket*: does the spec's "deploys terminate all
  WebSockets" actually hold? Either answer gets written down.
- *Real Claude Code as consumer*: the Electron `Origin` header vs our 403; GET/SSE
  probes against a POST-only endpoint; tool-name charset acceptance; the
  approve-on-phone loop. The only test of the actual product with the actual consumer.
- *Push per real browser* (Chrome, Android, iOS-installed-PWA — the likeliest to
  just not work); *real OAuth connect per provider* (findings fed back into the
  adversarial fake AS); *bootstrap + WAF verification* (30 rapid logins → 429; a
  plain curl gets JSON, not a bot-challenge page).
- *QuickJS production matrix* (§23): repeated and concurrent fresh runtimes; public
  network/environment/filesystem/timer/module/dynamic-compilation negatives; a 300 s
  interrupt-bound run; admitted deadline unchanged by a settings update; disconnect
  disposal; memory and stack ceilings; and deployment bundle compatibility. Re-run on any
  QuickJS package, Wasm artifact, Wrangler, compatibility-flag, timeout, memory, stack, or
  host-bridge change.

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

