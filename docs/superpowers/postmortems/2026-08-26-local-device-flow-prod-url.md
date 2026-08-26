# Local device flow advertises the production verification URL

- **Found:** 2026-08-26, by the user, running `pnpm pmcp login --profile local`
- **Symptom:** the CLI printed `open https://personal-mcps.ahrzb.workers.dev/device?user_code=…` although the profile targets `http://localhost:8787`
- **Impact:** local login flow unusable (the device code was minted by the local hub; entering it at the prod `/device` page could never approve it); local only, no production impact; cost a full misdiagnosis cycle
- **Class:** environment-drift, silent-default, process-lapse

## Root cause

The CLI was correct end to end: it resolved the `local` profile, POSTed to
`http://localhost:8787/api/auth/device/code`, and printed the
`verification_uri_complete` the hub returned (RFC 8628: the server names its
own verification URI). The *local hub process* was a long-lived `wrangler dev`
started before `.dev.vars` took effect, so its `PUBLIC_ORIGIN` binding still
held the production default from `wrangler.jsonc` `vars` — and the device
endpoint mints verification URLs from `PUBLIC_ORIGIN`. The wrong value crossed
the wire disguised as a legitimate server answer.

Contributing: the prior session's diagnosis "stale dev server on 8787, needs
restart" was never written into any ledger and evaporated at the session
boundary.

## Why the tests missed it

Not a code bug — the code did exactly what the spec says. Every test pins
`PUBLIC_ORIGIN` per environment, so no test can disagree with itself; and no
test of any kind can observe a stale OS process on the developer's machine.
The nearest guard that *could* exist: nothing asserts that a running hub's
advertised URLs share an origin with the endpoint that served them.

## Fix

Dev server restarted (2026-08-26, same hour); re-probe confirmed
`verification_uri` = `http://localhost:8787/device`. No code change.

## Candidate countermeasures (recorded, not enacted)

- Remove the production `PUBLIC_ORIGIN` default from `wrangler.jsonc` `vars`
  so a dev server that fails to load `.dev.vars` dies loudly at startup
  (workers-env validation already throws on missing vars) instead of quietly
  impersonating production. *(Offered to the user; decision open.)*
- Smoke self-consistency step: request a device code and assert the
  `verification_uri` origin equals the origin smoke is talking to — catches
  this exact drift on local runs and guards prod config forever.
- Ledger rule: environment invalidations (restart X, rotate Y) get plan-ledger
  entries like code debts, because they do not survive session boundaries.

## Misdiagnoses along the way

First theory: a leftover `$env:PMCP_URL` in the user's PowerShell session
overriding the profile (plausible — flat env legitimately outranks profiles by
design). Disproven by reproducing the symptom in a clean shell with the
variable provably unset, then cutting the CLI out entirely: a raw `curl` to
the local hub returned the prod URL, pinning the fault on the server process.
