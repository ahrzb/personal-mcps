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
`scripts/e2e.ts` against the dev worker: the example app over real wss/TLS
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
= >50 apps; browser-side PWA mechanics: trigger = the web surface outgrowing
§13 or a second contributor; RFC 9207 as likely-dead-branch; constant-time
compare as reviewed-not-tested).

