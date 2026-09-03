# A stuck production instance hung every cookie-signing request for minutes

- **Found:** 2026-09-03, by the owner, opening the hub on a phone after a two-factor sign-in
- **Symptom:** "On my phone it takes forever to load, it happened after I tried to login
  using 2 step code" → "It basically does not load" → "I click sign in with passkey and it
  gets stuck. Interactions seem to have an issue" → "Finally it worked, but weird" → "I click
  on agents, nothing happens" → "It works now, but sooo weird"
- **Impact:** production, roughly 21:05–21:29 UTC (the smoke at 21:04 was green; the
  redeploy at 21:28 cured it). For the affected instance(s): the root page with a session
  cookie, the password sign-in and the passkey options endpoint hung until the client gave
  up — the tail logged them as `canceled` after 180–215 s. Everything that never signed or
  verified a cookie answered normally throughout: `/login`, `/sw.js`, static assets, a bogus
  password (422 before hashing), a bogus bearer (the hub's own D1 lookup), the passkey
  verify with an empty body (400 before work). The owner saw it as "the site does not load",
  then intermittently as different instances served different requests.
- **Class:** environment-drift / process-lapse (the manual passkey leg was never run on
  production)

## Root cause
Not the code: the deployed commit answered the hanging endpoint locally in 240 ms, and
redeploying the identical commit (`3bda040b`) cured production at once — the redeploy
replaced the running Workers instances. The hang was state inside a running instance.
The affected family — `auth().api.getSession` with a real cookie, `/sign-in/username` for a
real user (which mints and signs a session cookie), `/passkey/generate-authenticate-options`
(which signs the challenge cookie) — is exactly better-auth's cookie signing / verifying
path; the hub's own WebCrypto (`SHA-256` token hashing) and D1 reads worked in the same
instance. The most likely mechanism is a promise on that path that never settled in the
instance (a WebCrypto key import or a lazily-initialised piece of the memoised better-auth
instance), after which every caller awaited it forever. The exact promise could not be
identified from outside once the instance was gone; nothing was logged because a request
that never finishes emits no log line.

## Why the tests missed it
Nothing in the suite can see a wedged production instance: vitest runs against miniflare
(see the memory "Vitest can't catch Workers resource limits"). The smoke ran at 21:04 and
was green, and it drives the password sign-in — but the hang began after it. The
passkey path had no smoke leg at all: the passkey sign-in was the roadmap's one manual leg
(G21), owed and never run on production, so the one endpoint that hung deterministically
for 20+ minutes had no automated observer. Diagnosis was slowed by two false leads that
the evidence supported for a while: the tail showed only `/sw.js` fetches from the phone
(hung requests do not appear until cancelled, and cancellation came minutes later), which
read as "the phone never asks", and the pages carried no `Cache-Control`, which made a
stale-copy theory plausible.

## Fix
- Immediate: `pnpm ship` of the same commit — deploy `3bda040b`, smoke 32/32, passkey
  options 200 in ~100 ms ×3 (21:28 UTC).
- Durable: the smoke gains a leg that calls `/api/auth/passkey/generate-authenticate-options`
  with a 10 s bound and requires a challenge, so the next stuck instance on that path fails
  the next deploy's smoke instead of waiting for a phone; every rendered page now answers
  `Cache-Control: no-store` (not the cause; the rule signed-in pages should have had, and it
  removes the stale-copy false lead for good). Commit: pending.

## Countermeasure candidates
- A scheduled external probe of the two cookie-signing endpoints (sign-in with a bogus user
  is not enough — it exits before signing; the passkey options leg is the cheap
  representative), alerting on a bound rather than on status.
- A request-level timeout around `auth().handler` in the identity door so a wedged path
  answers 503 in seconds rather than hanging until the client gives up — a 503 would have
  appeared in the tail immediately and named the endpoint.
- Run the manual passkey leg (G21) on production after the next auth-related deploy, and
  record it in the ledger; it is still owed.
- When a live report says "hangs", read the tail for `canceled` outcomes with large
  `wallTime` first: that is what a server-side hang looks like from outside.
