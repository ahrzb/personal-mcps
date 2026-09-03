# Sessions pane names every browser session "Unknown client"

- **Found:** 2026-09-03, by the owner, reading `/settings/sessions` on production (five
  rows, every one "Unknown client", the current one included)
- **Symptom:** "it identifies the web client as unknown" — with a screenshot of the pane
- **Impact:** the Client column carried no information for any browser session since the
  first deploy; the owner could not tell which session was which device, so a Revoke was a
  guess. Production, every session ever minted through `/login`.
- **Class:** boundary-actor / silent-default

## Root cause
`/login`'s form is translated into better-auth's JSON call by `identity.callAuthResponse`,
which builds a fresh Request carrying only the cookie and the hub's own `Origin` — by
design, so nothing unchecked from the browser reaches better-auth. better-auth stamps the
session's `userAgent` from the request it receives (`headers.get("user-agent") || ""`), so
every session minted through the form stored `""`. `sessionRow` then rendered
`userAgent?.slice(0, 80) || "Unknown client"` — the empty string's fallback. Live rows
confirmed it: `userAgent` was `""` on all four browser sessions and `"node"` on the one
CLI session (undici's default, the only request that was not rebuilt).

## Why the tests missed it
The closest row, "§13 · /settings/sessions lists every session under Client / Created /
Last active", asserts the column headings and the row ids, never a client name — and its
sessions come from `seedOwnerSession`, which posts to better-auth's own
`/api/auth/sign-in/username` directly, bypassing the form translation that drops the
header. No test ever signed in through `/login`'s form with a User-Agent and read the pane.
The states preview showed "Chrome on Windows" from a fixture, so the design walk looked
right.

## Fix
`callAuthResponse` forwards `User-Agent` alongside the cookie (display data, gated on by
nothing); `sessionRow` reads `clientOf(userAgent)` — "Chrome on Windows" / "Safari on
iPhone" picked from two fixed mark lists, the raw 80-char slice when neither list places
the string, "Unknown client" when it is empty. One row walks the seam end to end: three
form sign-ins under three User-Agents, one pane. Commits: `de74845` (row), `308fd34`
(fix); deploy `eed75627`, smoke 30/30. Rows minted before the fix keep their empty
User-Agent and read "Unknown client" until they are signed in again — no backfill, there
is nothing to backfill from.

## Candidate countermeasures (recorded, not enacted)
- A seeding helper that signs in the way a browser does (through `paths.auth.signIn`,
  form-encoded, with a User-Agent) beside `seedOwnerSession` — so pane rows read what the
  form minted, not what better-auth's raw endpoint minted.
- Every "rebuild the request" site (`callAuthResponse` is the one today) lists which
  browser headers it drops and why; a stored-and-displayed field with no test naming its
  producer is the pattern to grep for.
- The owner sitting (3b) walks `/settings/sessions` on production and reads each row's
  text, not just the count.

## Misdiagnoses along the way
none — the first grep for "Unknown client" found the fallback, the second found the
header rebuild, and the live D1 read confirmed the empty strings before any edit.
