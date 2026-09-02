# Step 4 — `/login` landing: G15 (reflected XSS + open redirect) and G7 (the switch links drop the landing)

> Roadmap step 4 (`2026-09-02-roadmap-after-d15.md` § Step 4) holds the goal, the shape
> (inline fix, own `fix:` commit and deploy, rows first as `it.todo`) and the Definition of
> Done; none of that is restated. This settles what the roadmap named as this step's to
> settle. Evidence read 2026-09-02: `login.tsx:51-58` (`switchMethod`, `landingUrl`),
> `:109` / `:235-241` (the `LANDING` embed via `JSON.stringify`), `model.ts:2310-2335`
> (`loginProps`, `oauthRedirectTarget`), `web.ts:797` / `:877-880` (`landingOf`),
> `:883-891` (`loginUrl`), `:1283-1287` (`render`), `identity.ts:658` (the one producer of
> `?next=`, `encodeURIComponent(pathname + search)`).

## Settled

**Where the guard lives.** `pages/model.ts` exports one rule, `hubRelative(target)`: a
string that starts with `/` and whose second character is neither `/` nor `\` is returned
as is; anything else — absolute, scheme-relative, the backslash spelling browsers fold
into `//`, empty, null — is `null`. (`/\evil.example` is the case `landingOf`'s
`startsWith("//")` misses: the WHATWG parser treats `\` as `/` for special schemes.)
`loginProps` applies it: `redirectTo: oauthRedirectTarget(query, rawSearch) ??
hubRelative(query.get("next"))` — the OAuth arm keeps precedence and is not passed
through (it is relative by construction and its query is the signed bytes). `web.ts`'s
`landingOf(form)` becomes `hubRelative(field(form, "callbackURL")) ?? paths.apps` and its
doc comment points at the one rule. `model.ts` imports nothing from `web.ts`; `web.ts`
already imports `loginProps` and `paths` from `model.ts`, so the direction holds.

**The escape set.** `login.tsx` gains `jsLiteral(value)` = `JSON.stringify(value)` with
`<` → `\u003c`, U+2028 → `\u2028`, U+2029 → `\u2029`. `<` alone closes the `</script>`
and `<!--` doors; `/` buys nothing once `<` is gone and is not escaped. Every embed inside
`passkeySignInScript` (`OPTIONS`, `VERIFY`, `LANDING`) goes through it — the two constants
too, so the rule is "a script literal is `jsLiteral`", not "this one variable". The
implementer greps `JSON.stringify(` across `pages/*.tsx` script builders (`OTP_SCRIPT`,
`ADD_PASSKEY_SCRIPT`, `PUSH_SCRIPT`, `layout.tsx`'s three, `apps.tsx`'s one): if a second
file embeds any value, `jsLiteral` moves to `pages/format.ts` and both import it; if every
other embed is a compile-time constant, it stays in `login.tsx` and the report says so.
The hidden `callbackURL` input needs nothing: Hono JSX attribute-escapes `<` to `&lt;`.

**G7.** `loginUrl` moves from `web.ts:883` to `pages/model.ts` beside `paths`, exported,
unchanged; `web.ts` imports it. `switchMethod(method, redirectTo)` returns
`loginUrl({ method, next: redirectTo })`, and both cards pass their `redirectTo`. The
round trip is lossless: `URLSearchParams.set` percent-encodes the landing, `query.get`
decodes it byte for byte, so the signed `/oauth2/authorize?…` landing survives a switch —
its `sig` / `client_id` sit inside the encoded `next` value, not on `/login`'s own query,
so `oauthRedirectTarget` stays `null` and the `next` arm carries it. The stale comment at
`login.tsx:44-50` ("no §13 path for switching…") is rewritten to say what the link carries.

**The CSP shape — the nonce form is deferred, and why.** Eight inline `<script>` sites
(`login.tsx` ×2, `settings.tsx`, `approvals.tsx`, `apps.tsx`, `layout.tsx` ×3) would each
need a per-response nonce threaded through props that carry none today (`LoginProps` has
no context at all), and 43 inline `style=` attributes (`audit.tsx` 17, `settings.tsx` 17,
`device.tsx` 4, …) would force `'unsafe-inline'` on `style-src` regardless. What lands
here is the part that touches no inline code: `render` (`web.ts:1283`) sets
`Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none'` on
every HTML response — clickjacking, `<base>` injection and plugin embedding closed on the
whole surface in one line. `'self'`, not `'none'`, for `frame-ancestors` because the
states preview frames pages. The nonce `script-src` is recorded as a step-13 line with the
two counts above, so it is a decision, not a gap.

**The OAuth arm's `rawSearch`.** Bounded by the same escape (`LANDING` is built from it),
and by construction never absolute; no guard on it — `19-inbound-oauth.md:258`'s rule
that the page reads no destination out of that query still holds and the existing row
`web-pages.test.ts:1330` keeps pinning it.

**One §13 sentence** rides the `fix:` commit, beside the Sign-in landing row of the
landing table (`13-web-surface.md:29`): a `?next=` deep link is honoured only when it is
hub-relative; anything else lands on `/apps`. The spec is non-sacred; the rows say the
same thing precisely.

## Rows

One new describe in `web-pages.test.ts`, `§4/§13/§15/§19.5 · /login's landing — one
relative-only rule for both consumers`, landed as `it.todo` in a `test:` commit before any
fix (2026-09-03, verified by a spec-fidelity + assertability lens; the titles below are as
landed — the owner's to review). Two corrections the verifier made to the drafts: row 2 names
the backslash spelling on the POSTED arm too (an absolute `callbackURL` already lands on
`/apps` today, so only `/\evil.example` gates `landingOf`'s half of the fix), and the
surface's 404 sits on row 5's TWIN side — every 404 is `noSuchPage()`, `text/plain`, built
without `render`. Each refusal beside its twin:

1. `§15 · a hub-relative ?next=/apps%3C/script%3E%3Cimg src=x onerror=…%3E%E2%80%A8 reaches both embeds and is escaped in both — the inline script's LANDING carries no raw "<" and no raw U+2028 line separator, and the hidden callbackURL carries &lt;, so "</script><img" appears nowhere in the document — while ?next=/settings/tokens reaches the same two verbatim (the twin)`
2. `§4 · ?next=https://evil.example, ?next=//evil.example, ?next=/%5Cevil.example (the backslash spelling a browser folds into //) and an empty ?next= each land on /apps in BOTH consumers — the script's LANDING and the hidden callbackURL — and a sign-in POST carrying an absolute callbackURL, or that same backslash spelling which today's two-branch test lets through, redirects to /apps too (the posted twin, one rule)`
3. `§13 · a TOTP challenge reached as /login?step=totp&next=/settings/tokens links "Use a backup code instead" to /login?method=backup-code&next=%2Fsettings%2Ftokens, and the backup-code card it opens carries callbackURL=/settings/tokens — with no next= the switch links carry none and the card lands on /apps (the twin)`
4. `§19.5 · a switch made from the signed-authorize arm keeps the /oauth2/authorize landing byte for byte, pinned at both ends: the TOTP card's backup-code link carries inside next= the very landing that card itself posts as callbackURL, and the card the link opens renders that same string as its own callbackURL, sig and client_id intact`
5. `§13 · one renderer emits every HTML page, so every one carries Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" — checked on the three shapes: /login anonymous, /apps shelled under the owner's cookie, /apps/new chromeless — while the hub's non-HTML answers, /styles.css and the surface's 404, carry none (the twin)`

Smoke, one leg in `scripts/smoke.ts` beside the §13 prefix-gate leg: `GET /login?next=/apps%3C/script%3E%3Cimg…` body contains no `</script><`, and `?next=https://evil.example` renders `callbackURL` = `/apps`.

## Ownership

| Owns | Files |
|---|---|
| rows | `server/test/worker/web-pages.test.ts` (the new describe only), `test-inventory.json` |
| fix | `server/src/pages/model.ts` (`hubRelative`, `loginUrl`, `loginProps`), `server/src/pages/login.tsx`, `server/src/web.ts` (`landingOf`, the `loginUrl` import, `render`), `docs/specs/web-and-oauth/13-web-surface.md` (one sentence), `scripts/smoke.ts` (one leg) |

Nothing else. No fixture changes: `/login`'s fixtures (`fixtures.ts:86-135`) carry
`redirectTo` values that are already relative.

## Shape

Two workflows, the orchestrator between them: (1) a rows agent lands the five `it.todo`
rows and regenerates the inventory → `test:` commit; (2) an implementer flips them,
runs `tsc` and the web-pages file, adds the smoke leg and the §13 sentence → a verifier
runs the inline gate (full suite; inventory diff exactly the five `todo → passed`; file
confinement; the `JSON.stringify` grep; `landingOf` reads `hubRelative`; one `loginUrl`)
→ at most two fix rounds → `fix:` commit, deploy, `pnpm smoke` (29 + 1), ledger line.
All agents Opus.
