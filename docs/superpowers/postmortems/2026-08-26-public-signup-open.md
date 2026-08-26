# Public self-service sign-up was open on the production hub

- **Found:** 2026-08-26, by the D10 seam sweep (identity↔custody lens), not the user — recorded here because it was a live production security escape and it is the strongest instance yet of the recurring real-actor test gap
- **Symptom:** `POST https://personal-mcps.ahrzb.workers.dev/api/auth/sign-up/email` with a bare JSON body (no cookie, no `Origin`, no secret) created a fully working user + namespace
- **Impact:** anyone on the internet could self-provision an account with login, /services, /account, `service_create`, and `token_issue` — no `BOOTSTRAP_SECRET`, no `bootstrap.user_created` audit row. Live from the moment the web/auth surface shipped until the fix. **Blocker.**
- **Class:** boundary-actor, silent-default, spec-gap

## Root cause

`identity.auth()` set `emailAndPassword: { enabled: true }` with no
`disableSignUp`, and `index.ts` mounts better-auth's whole surface
unauthenticated at `/api/auth`. better-auth serves `/sign-up/email` whenever
`enabled && !disableSignUp`, so the endpoint was live on a public mount. A
cookie-less POST also skips better-auth's own `Origin`/CSRF check
(`validateOrigin` returns early when no cookie is present), so a bare `curl`
reached it. The created row carried a valid `username`, which `ownerIdFor`
resolves — a real namespace. This bypassed §12 ("POST /internal/users is the
only user-management surface") and §2 ("created by a repo script"). The
password provider is needed for sign-*in*; only sign-*up* had to be closed.

## Why the tests missed it

Not one of the 904 cases ever POSTed `/sign-up/*`. The auth-matrix walks
resolution, whoami, /account scope, and the bootstrap route — but sign-up was
outside every walk, so an endpoint that should not exist as a public writer
was invisible. Same shape as the 415 and the libuv crash: the *surface* was
never driven by its real actor (here, an anonymous HTTP client).

## Fix

`emailAndPassword: { enabled: true, disableSignUp: true }` in
`server/src/identity.ts`, commit recorded at the D10 gate; deployed
`dc835e60`. Verified live: the pre-fix request now returns
`EMAIL_PASSWORD_SIGN_UP_DISABLED` / HTTP 400. Regression test
(auth-matrix, §12 describe) submits the sign-up cookie-less with a valid body
and asserts refusal + that the namespace does not exist afterward.

## Candidate countermeasures (recorded, not enacted)

- **Real-actor rule** (the through-line of every postmortem here): each
  mounted surface — including third-party mounts like `/api/auth` — gets at
  least one case that drives it exactly as its real actor does. For a public
  mount that means an *anonymous* request to every sub-route it exposes,
  asserting the ones that must not be public are refused. A totality walk over
  better-auth's served endpoints (enumerate what the plugin list mounts, and
  spend each as public/gated) would have caught this at authoring time.
- The §4-custody lens findings from the same sweep (recent-auth not enforced
  on POSTs; device-flow bearer reaching the credential family) are tracked in
  the D11 remediation plan.

## Misdiagnoses along the way

None — the sweep's adversarial verifier reproduced the exploit path in one
pass; the live probe confirmed it before any fix.
