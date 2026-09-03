# Step 5 — `/settings` truth pass: G3, G4, G30, G9, G16, G31

> Roadmap step 5 (`2026-09-02-roadmap-after-d15.md` § Step 5) holds the goal, the shape
> (small dispatch) and the Definition of Done; none of that is restated. This settles what
> the roadmap named, and nothing else. Precedents: the in-place 200 (`d15-panes.md`
> constraint 5 and its ledger entry 35 — a secret never rides a URL), the standard gate
> (`2026-08-25-implementation-orchestration.md` § "Dispatch anatomy and the standard
> gate"), the rows-first rule (`docs/specs/testing/09-agent-written-tests.md:3-7`), the
> settings fixture notes (`2026-09-02-orphan-states.md:61-70`).
>
> **Evidence re-derived against HEAD (c166772) + the uncommitted step-4 tree, 2026-09-03.**
> Every coordinate below was read off the file, not inherited: the roadmap and the orphan
> report carry pre-step-4 numbers for `model.ts` and `web-pages.test.ts` (e.g. roadmap
> `model.ts:2290 source: "web"` → `:2352`; `web-pages.test.ts:6229-6250 plantPasskey` →
> `:6432`; roadmap "`NOTICE_KEYS` at `model.ts:614-622`" → `:653`), and none of those
> numbers are carried forward here. Whoever implements navigates by these, so re-check any
> in a file step 4 is still editing (`login.tsx`, `model.ts`, `web.ts`, `smoke.ts`) before
> opening it, and prefer the symbol name over the line where the two disagree.
>
> `web.ts:838-859` (`credential`), `:867-871` (`redirectWith`), `:905-913` (`refusalOf`),
> `:556-574` (the Issue-token in-place 200), `:1032-1051` (`noticeUrl`), `:1053-1067`
> (`noticeOf`), `:1282-1293` (`render`), `:1105-1117` (`context`), `:728-741` (`mutation`),
> `:751-754` (`sessionOf` → `requireOwnerSession`), `:790` (`signInTranslation`);
> `model.ts:63` (the identity import), `:427-429` (G31's dangling comment), `:430`
> (`totpVerify`), `:580` (`TwoFactorSummary`), `:588-595` (`TotpEnrollment`), `:598-604`
> (`PasskeyRow`), `:612-620` (`SessionRow`), `:653-661` (`NOTICE_KEYS`), `:733-737` (the
> `SettingsProps` invariant), `:2196-2237` (`settingsProps`), `:2226-2227` (`enrollment:
> null` / `revealedBackupCodes: null`), `:2279-2286` (`passkeyRow`, name at `:2282`),
> `:2322` (the Remove-dialog title's source), `:2347-2357` (`sessionRow`, `client` and its
> "Untrusted display data" note at `:2350-2351`); `settings.tsx:407-467` (`TwoFactorCard`,
> the enrolment arm `:413-453`, its form `:427`, hidden `csrf` `:428`, `digit${i}` `:437`),
> `:541-565` (`BackupCodesCard`, Copy codes `:556-559`), `:592` (`pk.name` rendered),
> `:941` (the Remove dialog title), `:1029-1034` (the two cards as siblings),
> `:198-260` (`ADD_PASSKEY_SCRIPT`, the verify body that sends no `name` at `:232-247`);
> `login.tsx:146-166` (the OTP form: `data-otp-form` on the `<form>` `:146`, hidden
> `[data-otp-value]` `:148`, the `[data-otp]` box row `:149-162`), `:219-243`
> (`OTP_SCRIPT`), `:365` (where it renders); `layout.tsx:209-227` (`TokenReveal`, its
> handler `:223`); `identity.ts:104-140` (`buildAuth`, `twoFactor()` `:123`, `passkey()`
> `:130`), `:1064-1093` (`callAuthResponse` — a NEW request carrying only the cookie, which
> is why `settingsProps` is safe to call under a POST; its self-stated `origin` `:1086`);
> `migrations/0001_auth.sql:3-9` + `:108`, `0002_hub.sql:26-33` + `:38`,
> `0006_service_capabilities.sql:23`, `0007_rename_app_agent.sql:6-8` + `:9-11`;
> `web-pages.test.ts:1170-1205` (case 27), `:1918` (the /settings prefix-gate row),
> `:1943-2070` (case 26), `:2031-2041` (`PASSWORD_GUARDED` / `UNGUARDED`), `:2890` (the
> passkey name row), `:3248-3308` (§9 rule 4a's totality row), `:5981-5985`
> (`BETTER_AUTH_ACTIONS`), `:5994-5996` (`SETTINGS_CREDENTIAL_TARGETS`), `:6432-6453`
> (`plantPasskey`), and the helpers `:376` (`call`), `:457` (`sessionCookieOf`), `:558`
> (`ageSession`), `:576` (`enrollTwoFactor`); `migrations.test.ts:1014-1022` (`insertRow`),
> `:1562-1641` (the forward case); `test-inventory.json:1443`; `fixtures.ts:200-264`
> (passkeys `:200-213`, sessions `:215-243`, `QR_PLACEHOLDER` `:245-253`, `BACKUP_CODES`
> `:255-264`) + `:493-533`; `cli/src/main.ts:499-503`; `scripts/smoke.ts:407`;
> `vitest.config.mts:73` + `:84-92`. In `node_modules`:
> `better-auth/package.json` (`"@better-auth/utils": "0.4.2"`),
> `better-auth/dist/plugins/two-factor/index.mjs:125` + `:166-174` (enable),
> `.../totp/index.mjs:11` (`createOTP` from `@better-auth/utils/otp`), `:30`
> (`get-totp-uri`'s required password), `:172-223` (verify, the cookie rotation at
> `:209-213`), `.../backup-codes/index.mjs:14-16` + `:300-303`,
> `@better-auth/utils@0.4.2/dist/otp.mjs:59-94` (`base32.encode(secret, {padding:false})`
> in the URI, `createOTP(...).totp()`), `dist/db/with-hooks.mjs:6-19`,
> `dist/db/internal-adapter.mjs:248-311`, `dist/api/dispatch.mjs:199`,
> `dist/api/index.mjs:157-160`, `dist/api/middlewares/origin-check.mjs:43` + `:107`,
> `@better-auth/passkey/dist/index.mjs:359`, `:392-401`, `:533-563`, `:712-715`,
> `:729-732`, `:739-753`, `:764`, `:767-773`, `:804`.

## Settled

**How better-auth's body rides from `credential()` to ONE render.** In place, the shape
`web.ts:556-574` already uses: `credential()` gains ONE optional trailing parameter, and
**four** call sites do not pass it (`totpDisable`, `passkeyDelete`, `sessionRevoke`,
`revokeOtherSessions` — six exist today, `changePassword` is spelled outside the wrapper).

```ts
  /** What this target answers with instead of the flash, when better-auth's own answer IS
   *  the point: it cannot ride a URL (§15) and `NOTICE_KEYS` cannot carry it
   *  (model.ts:653-661). Returning null falls back to the flash — which is how a refusal
   *  with nothing to redraw AND a success that must not render both answer.
   *  The body is read exactly ONCE, on whichever arm this is, because a Response answers
   *  once: `refusalOf` moves ABOVE the redirect so the notice and this share that read.
   *  CONSTRAINT this function does not enforce: a target whose SUCCESS re-issues the
   *  session cookie must not reveal on that arm — the props below would be read with the
   *  cookie better-auth just deleted, and the CSRF token minted off a dead session id
   *  (`context`, web.ts:1105). /two-factor/verify-totp is exactly that target, which is
   *  why its success keeps the 303. */
  reveal?: (
    req: Request,
    session: OwnerSession,
    form: FormData,
    outcome:
      | { ok: true; answer: Record<string, unknown> }
      | { ok: false; code: string; message: string },
  ) => Promise<unknown | null>,
```

`credential` stops discarding its session (`_session` → `session`), and the redirect is
**not** left verbatim — it is a one-token edit, because the refusal's body is now read into
`outcome` and re-reading it would degrade every credential refusal to `refusalOf`'s
"The change was refused." fallback (`web.ts:905-913`; case 26 asserts only `failed=`, so
nothing would catch it):

```ts
    const succeeded = answered !== null && answered.ok;
    // Read once, on whichever arm. The success half is parsed only when someone will read
    // it, so the four call sites without a reveal behave exactly as they do today.
    const outcome = succeeded
      ? { ok: true as const, answer: (await answered!.json().catch(() => ({}))) as Record<string, unknown> }
      : { ok: false as const, ...(await refusalOf(answered)) };
    const node = reveal ? await reveal(c.req.raw, session, form, outcome) : null;
    if (node) return render(node);
    return redirectWith(
      noticeUrl(pane, op, outcome.ok ? { value: null } : { reason: outcome.message }),
      succeeded ? answered : null,
    );
```

(`answered.json()` consumes the body; `redirectWith` reads only `Set-Cookie` headers, so
forwarding still works.) Rejected: a server-side stash keyed by session token (a migration,
a read on every settings render, and ten plaintext codes plus a TOTP secret at rest in the
one table §4 gives identity sole custody of); a second wrapper beside `credential` (two
translation wrappers is what the DoD forbids); a `Response`-returning reveal (three call
sites, none needs a status or a header of its own — and the node form keeps `render` the one
builder, so step 4's CSP header lands on these answers too).

**Which arm each of the three reveals draws on** — the whole matrix, because "returns null"
is what keeps three owner-reviewed green rows green:

| target | success arm | refusal arm |
|---|---|---|
| `/two-factor/enable` | the setup card **and** the codes, 200 | `null` → 303 `failed=two_factor_enable`. Its form carries no `totpuri` and better-auth's refusal carries no enrolment, so there is nothing to redraw — which is exactly the leg case 26's twin walks (`web-pages.test.ts:2031-2036`, `:2050`, `:2058`) |
| `/settings/two-factor/verify-totp` (new) | `null` → 303 `done=two_factor_enable`; the cookie rotates, so it must not render | the SAME enrolment redrawn from the posted hidden fields, 200 — or `null` when `enrollmentOf` refuses them |
| `/two-factor/generate-backup-codes` | the fresh set, 200 | `null` → 303 `failed=backup_codes_generate` (case 26's `PASSWORD_GUARDED` leg) |

**One helper for the three reveal bodies**, beside the routes in `web.ts`:
`settingsTwoFactorPage(req, session, overlay: Pick<SettingsProps, "enrollment" |
"revealedBackupCodes">)` = `SettingsPage({ ...(await settingsProps(await context(req,
session), req, "two-factor")), ...overlay })` — the same `{ ...props, reveal }` spread as
`web.ts:573`. Safe under a POST because `callAuthResponse` builds a fresh request out of the
cookie alone (`identity.ts:1078-1090`) and `context` reads only `new URL(req.url)`'s query,
which a POST target has none of. `settingsProps` is unchanged: `enrollment: null` /
`revealedBackupCodes: null` (`model.ts:2226-2227`) stay the loader's answer, because a GET
has neither, and the overlay is what a POST adds. That keeps the invariant `SettingsProps`
already documents (`model.ts:733-737`) true by construction — and it is why the reveal
renders **no notice**: there is no flash on a POST URL to read.

**Where a wrong verify code lands, and where `enrollment.error` is written.** A new
credential target of its own: `paths.auth.totpVerifySettings =
"/settings/two-factor/verify-totp"`, mounted as `credential(paths.settingsTwoFactor,
"/two-factor/verify-totp", "two_factor_enable", (form) => ({ code: field(form, "code") ??
"" }), reveal)`. It inherits `mutation`'s CSRF check and `recent: true` for free — which
makes the card's existing hidden `csrf` input (`settings.tsx:428`) real for the first time
— and joins `SETTINGS_CREDENTIAL_TARGETS` (`web-pages.test.ts:5994-5996`) without a test
edit, because that list is derived by prefix; its final segment `verify-totp` is already in
`BETTER_AUTH_ACTIONS` (`:5981-5985`, derived from `paths.auth`). Today's card posts to
`paths.auth.totpVerify` (`settings.tsx:427`), which is `/login`'s translation: no CSRF
check, and a refusal lands on `/login?step=totp&error=…`, a query `settingsProps` never
reads. Rejected: teaching `signInTranslation` (`web.ts:790`) about `/settings` — a second
translation wrapper for the same family; and a bespoke route outside `credential()` — D15
ledger entry 9's PSD concern.

The op key is `two_factor_enable`, not a new word: under this design the enable target
never writes a `done=` flash (it renders), so the key's success arm is free, and the
sentence the owner reads at the end of the journey — "Two factor enable done."
(`web.ts:1053-1058`) — is what actually happened. `noticeOf`'s vocabulary does not grow.

**What the refusal redraws, and where the enrolment comes from.** The refusal cannot
re-derive the QR: `/two-factor/get-totp-uri` requires a password the card does not carry
(`totp/index.mjs:30` — `twoFactor()` passes no `allowPasswordless`), and calling
`/two-factor/enable` again ROTATES the secret (`index.mjs:125-145`), invalidating the QR
the owner has just scanned. So the verify form carries the enrolment forward in two hidden
inputs — `totpuri` (better-auth's own `otpauth://` string) and `codes` (the ten plaintext
backup codes, newline-joined) — and the refusal arm rebuilds the card from the POSTED
values. This exposes nothing new: both are already rendered on that very page, and neither
touches a URL, which is what §15 and D15 constraint 5 actually forbid. **Both echoed values
are validated before they are rendered again** — they are hand-postable form fields, so
each gets its rule beside `TotpEnrollment` (`model.ts:588-595`) in `pages/model.ts`:

- `enrollmentOf(totpuri, error)` returns `null` unless `new URL(value)` parses with
  `protocol === "otpauth:"`, `host === "totp"` and a non-empty `secret` parameter. It is
  the ONE producer of all three fields (the QR, the grouped secret in fours from that same
  `secret` parameter — better-auth writes it as `base32.encode(secret, { padding: false })`
  (`utils/dist/otp.mjs:69-71`), unpadded base32, exactly what an authenticator wants typed
  in — and `error`).
- `revealedCodesOf(codes)` splits on newline, drops empties, and returns `null` unless the
  result is exactly ten entries matching better-auth's own shape,
  `/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/` (`backup-codes/index.mjs:14-16`). Without it a
  hand-posted `codes` field draws arbitrary text under "Store these somewhere safe".

When `enrollmentOf` returns `null` the reveal returns `null` too and the flash redirect
answers: with no enrolment to redraw there is nothing to render, and that is also why case
26's walk (`web-pages.test.ts:1943-2070`, which posts no `totpuri`) stays green with a 303
and needs no third regime beside `PASSWORD_GUARDED` / `UNGUARDED` (`:2031-2041`) — the new
target falls to that walk's own "regime unknown" arm, which accepts `done=` or `failed=`.

**When the backup codes appear: on enable's own 200, and carried through the verify.**
`/two-factor/enable` returns BOTH halves in one response — `{ method: "totp", totpURI,
backupCodes }` (`two-factor/index.mjs:170-174`) — and `settings.tsx:1029-1034` already
draws `TwoFactorCard` and `BackupCodesCard` as siblings in one pane. So enable's reveal
renders the setup card AND the codes; the verify form carries the codes in its hidden
`codes` field so a mistyped first code does not cost the owner the set they were told is
shown once; the verify's SUCCESS keeps the 303 (it re-issues the cookie —
`totp/index.mjs:209-213` creates a new session, sets it and deletes the old — which is the
constraint the `reveal` doc comment names), landing on the enabled arm with no codes. The
next GET renders none: `settingsProps` has no producer for them and never will. §13's
"revealed exactly once after enabling or regenerating" is satisfied literally — enabling IS
when better-auth hands them over — so no §13 ordering amendment is needed. Rejected: a
second call after verify (`generate-backup-codes` needs a password the card has not got).
`skipVerificationOnEnable` stays off, so enable does not flip `twoFactorEnabled`
(`totp/index.mjs:206-223` does) and the enable render draws the not-enrolled arm with the
enrolment overlay — the invariant at `model.ts:733-737`, unchanged.

**Regenerate** is the same seam with the smaller overlay: `reveal` returns
`settingsTwoFactorPage(req, session, { enrollment: null, revealedBackupCodes: codes })` on
success, `null` on refusal. `generate-backup-codes` sets no cookie
(`backup-codes/index.mjs:300-303`), so the in-place answer is safe there by the same rule.

**The QR.** Nothing in the tree encodes one — no direct or transitive dependency
(`package.json:24-38`; `node_modules` has no `qr*`), and `fixtures.ts:245-253` is a
hand-drawn grey placeholder for a producer that does not exist. §13:97 pins "QR plus the
grouped secret for manual entry", and the point of the QR is a phone camera, so this needs
a pure-JS encoder: one new runtime dependency, zero-dependency, no Node built-ins (it runs
on workerd), emitting SVG or a boolean matrix — `uqr` or `qrcode-generator` are the two
candidates, the implementer picks after `pnpm add` and pins an exact version. It is used in
exactly one place, `enrollmentOf`, as `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
so `TotpEnrollment.qrDataUri` and every fixture shape stay as they are and no
`dangerouslySetInnerHTML` site is added. **This is the one line item that changes
`package.json`'s runtime half and it is listed under "Open for the owner" with its
fallback.** No row asserts the QR's CONTENT: it is geometry, and nothing in the tree can
read a secret back out of black squares — the rows assert the two places the secret is
readable and treat the QR as a presence claim (row 1).

**The authenticator entry.** `twoFactor({ issuer: "personal-mcps" })` at `identity.ts:123`
— one word, beside the identical decision already argued one line below it for
`passkey({ rpName: "personal-mcps" })` (`identity.ts:130`). Today the URI falls back to
`ctx.context.appName` (`two-factor/index.mjs:169`), and `betterAuth()` sets no `appName`,
so the default is the literal "Better Auth" (`context/create-context.mjs:130`): the owner's
authenticator would list someone else's product name. The account half stays `user.email`
— the synthesized `<username>@users.local` placeholder (`admin.ts:1404`, `:1444`) — which
§13 pins nothing about. Rejected: `betterAuth({ appName })`, which moves every other
default that reads `appName` for no gain.

**The session `source` seam.** Two option keys inside the one `betterAuth()` construction
(`identity.ts:105-117`), which is what §4's custody rule asks:

```ts
    // §13's Sessions pane has to tell a CLI session from a browser one, and better-auth
    // stores nothing that does. Written by better-auth alone: `input: false` keeps it off
    // every request body, and the one write that is not the default is the hook below.
    session: { additionalFields: { source: { type: "string", defaultValue: "web", input: false } } },
    // The device flow mints its session inside /device/token's own handler
    // (device-authorization/routes.mjs:455) and better-auth runs that handler inside an
    // endpoint context whose `path` IS the route (api/dispatch.mjs:199), which
    // createSession resolves for the before-hook (db/with-hooks.mjs:6-19). So the one
    // endpoint that mints a CLI session names itself, and nothing is inferred from a
    // header the caller controls. A null context is not an error: createSession is also
    // reached from paths that have none, and there the defaultValue answers.
    databaseHooks: {
      session: {
        create: {
          before: async (_session, context) =>
            context?.path === "/device/token" ? { data: { source: "cli" } } : undefined,
        },
      },
    },
```

`type: "string"` and not the literal enum `["web", "cli"]`: `DBFieldType` admits the enum,
but that it survives the D1/kysely read path untouched is unexercised, and the union is
enforced where the page's type is anyway — `sessionRow` normalises (`row.source === "cli" ?
"cli" : "web"`), which it must regardless because rows that predate the migration read
NULL. The roadmap's premise that the device plugin mints "with no request context — the
after-hook seam" is wrong in this version and the correction is load-bearing:
`createSession` routes through `createWithHooks`, which resolves a context via
`getCurrentAuthContext()` and hands it to the BEFORE hook (`db/internal-adapter.mjs:310`),
so there is no post-hoc UPDATE and no window in which the row reads "web".
`getSessionDefaultFields(options)` is spread into every create
(`internal-adapter.mjs:261`, `:277`), so no other mint site is touched. The
AsyncLocalStorage this rides on needs `nodejs_compat`, which `wrangler.jsonc:13` already
sets.

**The migration.** `server/migrations/0008_session_source.sql`, one line —
`ALTER TABLE "session" ADD COLUMN "source" TEXT;` — with no SQL DEFAULT, per 0002's own
written rule (`0002_hub.sql:26-33`: a DEFAULT is a second answer to "what does an absent
value mean") and 0002's/0006's precedent for exactly this shape (`0002_hub.sql:38`,
`0006_service_capabilities.sql:23`). Not in 0001: that file is declared
regenerable-wholesale (`0001_auth.sql:3-9`) and migrations are history
(`0007_rename_app_agent.sql:9-11`). Its header must record the one thing
`passkey.last_used_at`'s does not have to: because `source` is declared through
`session.additionalFields`, `@better-auth/cli generate` WOULD emit it into a regenerated
0001, and at that regeneration 0008 is the file to delete or a fresh install fails on
"duplicate column name". No backfill: every pre-migration row reads NULL → "web", which is
true of all of them (none was minted by `/device/token` with the column present), and the
owner's own live CLI session reads "web" until the next `pmcp login` — one line in the
ledger, not a script. No `schemaConstraintRows` entry is owed: that derivation filters to
`SCHEMA_TABLES` (`migrations.test.ts:1362-1420`), which `session` is not in, and its SQL
reader parses no `ADD COLUMN`.

**The literal "pmcp CLI".** A `source` column alone does not produce §13:107's string:
`client` is built from `userAgent` (`model.ts:2350-2351`) and the CLI sends no
`User-Agent` (`cli/src/main.ts:499-503`), so a real CLI row would read "… · device flow"
after whatever undici puts there, or "Unknown client · device flow". `sessionRow` therefore
renders the CLI half itself — `client: row.source === "cli" ? "pmcp CLI" :
clientOf(row.userAgent)` — and `sessionLabel` (`format.ts:65-67`)
appends the suffix as it already does, with no renderer change and no second definition.
This is not an owner question: §13 pins the rendered string, and this is the only way to
render it byte-for-byte without trusting a header the hub does not control (which the
field's own comment at `model.ts:2350` already calls untrusted display data — a browser
sending `User-Agent: pmcp CLI` would otherwise mint the CLI's own label). Rejected:
teaching `cli/src` to send the header (outside this step's files, spoofable, and
version-dependent).

> Amended 2026-09-03 (orchestrator, landed ahead of this step): the web half is no longer
> the raw `userAgent` slice. The owner's live Sessions pane read "Unknown client" on every
> browser row because `callAuthResponse` (`identity.ts`) forwarded only the cookie, so
> better-auth stored `""`; it now forwards `User-Agent` too, and `sessionRow` reads
> `clientOf(row.userAgent)` — "Chrome on Windows" / "Safari on iPhone" picked from two fixed
> mark lists, the raw 80-char slice for a string neither list places, "Unknown client" for
> an empty one. The implementer keeps `clientOf` as the web arm of the ternary above and
> changes nothing in it; the `source` column still decides the CLI arm.

**Passkey names.** The rule is the plugin's own documented example verbatim
(`@better-auth/passkey/dist/index.mjs:764`), placed in the model's row builder and not the
page: `BetterAuthPasskey` (`model.ts:2274`) widens to `{ id; name?; createdAt?; aaguid?:
string | null }` and `:2282` becomes `name: pk.name || getAuthenticatorName(pk.aaguid) ||
"Passkey"`. `aaguid` is already on the wire and in the schema — the plugin writes it on
every registration (`index.mjs:359`, `:392-401`), declares it (`:712-715`), returns adapter
rows unprojected from `/passkey/list-user-passkeys` (`:533-563`), and `0001_auth.sql:108`
has the column — so there is no migration and the only thing dropping it is the hub's own
narrow type. `PasskeyRow.name` stays a resolved string, so the fixtures' shape,
`settings.tsx:592` and the Remove dialog's title (`model.ts:2322` → `settings.tsx:941`) are
all untouched and the rule is spelled once for both readers. Import path: `identity.ts`
re-exports (`export { getAuthenticatorName } from "@better-auth/passkey";` — it is a
package-root export, `index.d.mts:2`) and `model.ts` imports it from `"../identity"` beside
`passkeyLastUsed` (`model.ts:63`), which is the custodian rule `settingsProps`' own comment
states at `model.ts:2187`. The first term is kept rather than trimmed: it is the branch a
hand-inserted row hits, which is what every existing planted-name row in the suite
exercises. The ceiling is a `ponytail:` note on `passkeyRow` — the table has 14 entries
(`index.mjs:739-753`) and Apple devices zero the AAGUID under the default `attestation:
"none"` flow (`index.mjs:729-732`), so "Passkey" stays the steady state for most rows.
§13:102-103 ("name as the authenticator reported it") needs no amendment: an AAGUID is
reported by the authenticator.

**The dangling comment (G31).** `model.ts:427-429` points at "settingsProps's note on
`enrollment`", which does not exist (`:2187-2195` talks about `passkeyLastUsed` and
`TwoFactorSummary`). It is not deleted but made true: `totpVerify`'s comment names
`/login`'s challenge card alone, and the new `totpVerifySettings` key carries the enrolment
card's sentence.

**Two shared bits of markup, one definition each.** (a) The six digit boxes are named
`digit0..digit5` with no hidden `code` and no stitching script (`settings.tsx:437`), so G30
is worse than an inert Copy button — a correct code posts `code=""` and can never verify.
`login.tsx:148-162` has the working markup and `:219-243` the static script (no
interpolated data), so both move into ONE exported component in `pages/layout.tsx`
(`OtpBoxes`, beside `TokenReveal`, which is already the home for a shared component that
carries its own inline script) and both cards render it; `login.tsx` gains an import from
`./layout` it does not have today. **`OtpBoxes` owns the hidden `[data-otp-value]` input,
the `[data-otp]` box row and the one script, and takes one prop, `invalid: boolean`, that
sets `aria-invalid` on the boxes — today each card sets it from its own source
(`login.tsx:158` reads `step.error`, `settings.tsx:439` reads `enrollment.error`), and
row 3 asserts the attribute on the settings card, so the component must carry it (added
2026-09-03 after the rows verifier's note); `data-otp-form` stays on each card's own
`<form>`** — one attribute in two places, by necessity, because the two forms differ in
action (`paths.auth.totpVerify` vs `paths.auth.totpVerifySettings`) and hidden fields
(`callbackURL` vs `csrf` + `totpuri` + `codes`), and the script keys off the form first
(`login.tsx:220-223`). (b) Copy codes (`settings.tsx:556-559`) is a bare button: it gains
`id="copy-codes"`, each chip gains `data-code`, and one inline script joins their
`textContent` with newlines and calls `navigator.clipboard.writeText` —
`layout.tsx:223`'s handler, one shape over. Net inline-script sites go from eight to
nine, so step 4's deferred `script-src` nonce line (step-4 plan § "The CSP shape") is
re-counted when this lands.

**Three §13 sentences**, in one `spec:` commit landed BEFORE the rows commit, because the
rows assert the amended text. (i) `13-web-surface.md:99`'s "enabled → the codes-remaining
line" has had no field since step 2 deleted G10's fabricated line (`624e06f`;
`model.ts:580` is now `{ enabled: false } | { enabled: true }`) — the clause is struck, and
the enabled arm reads **Regenerate backup codes** / **Disable two-factor**. (ii) The
enrolment sentence (`:97-98`) names the verify target and says that a refused code redraws
the same enrolment in place. (iii) Nothing else: the Passkeys and Sessions bullets
(`:102-110`) are already true of what this step ships.

**What goes red, and what does not.**

- **Case 27** (`web-pages.test.ts:1170-1205`) asserts `303` and `done=` for the two targets
  that now answer 200; its TITLE still describes what it checks ("is ACCEPTED by
  better-auth instead of refused for a field no browser could send" — a 200 carrying the
  reveal proves that better than a redirect did), so it is a BODY edit — two `toBe(303)` →
  `toBe(200)` plus one assertion each that the reveal rendered — and no inventory key moves.
- **Case 26** (`:1943-2070`) needs no edit: its walk covers the new target through the
  prefix-derived list, and every arm it asserts is answered by the matrix above — which is
  the whole reason enable's and regenerate's reveals return `null` on refusal.
- **§9 rule 4a's totality row** (`:3248-3308`) needs ONE body edit, and its title does not
  move. Its harvest is GET-only (`const bare = await page(pane, …)` plus the `?confirm=`
  renders), so the verify form the reveal draws would be a /settings control no walk sees —
  a hole, not a named exclusion. The edit: after the `PANES` loop, POST enable with the
  owner's password and POST generate-backup-codes, and run the same checks (1) and (3) over
  `formsOn` of each 200. Both pass as written — `verify-totp` is already in
  `BETTER_AUTH_ACTIONS`, and `BackupCodesCard` renders a `<button type="button">` and an
  `<a>`, no form. Naming the reveal in prose instead would move the title and owe a SECOND
  retire-and-replace pair; harvesting it costs two `formPost`s.
- **`migrations.test.ts`'s forward case** (`:1562-1641`) is retargeted at N=0008, and this
  is more than a retarget: at N=0008 the case applies 0001..0007 before inserting, and 0007
  has already renamed `service`→`app` and `service_account`→`agent`
  (`0007_rename_app_agent.sql:6-8`), so today's literal-name inserts
  (`migrations.test.ts:1587`, `:1600`, via `insertRow` at `:1014-1022`) would hit tables
  that no longer exist. The edit, spelled: (a) re-spell the inserted rows in 0007's OUTPUT
  vocabulary — `insertRow("app", …)`, `insertRow("agent", …)`, token `kind` `"app"` /
  `"agent"`; (b) rewrite the comment at `:1568-1572`, which says "N IS the 2026-09-01
  rename" and stops being true — N is now an additive ALTER; (c) replace the
  kind-translation assertion at `:1632-1640`, which becomes vacuous once the rows are
  inserted already translated, with the case's new live-data claim: a hand-spelled
  `session` row inserted under N−1 reads back with `source` NULL after N; (d) keep one
  app/agent/token row as "rows 0008 must not drop" (`:1630-1631` unchanged). The advance
  warning the case wrote itself is at `:1628-1629`. Its title is generic ("1..N−1 applied,
  rows inserted, N applied") and does not move.
- The ONE retirement is the passkey name row, enumerated below.

## Rows

One new describe in `server/test/worker/web-pages.test.ts` —
`§13/§15 · /settings/two-factor — the enrolment journey, in place` — plus one row in the
existing `§13 · the Two-factor, Passkeys and Sessions panes` describe (the replacement) and
one in the passkey-ceremony neighbourhood. Landed as `it.todo` in their own `test:` commit
before any implementation (§9 rule 1); the titles are the owner's to review. Each refusal
beside its twin.

1. `§13/§15 · POST /settings/two-factor/enable with the owner's own password answers 200 rendering the setup card in place — the secret better-auth minted reaches the page as the grouped line and again as the verify form's hidden totpuri, both equal to the "secret" parameter of that same answer's otpauth URI, beside a QR served as a data:image/svg+xml URI and the ten backup codes from the same answer — while the answer carries no Location and the pane's own next GET draws the not-enrolled arm with the secret, the codes and the QR nowhere in it (the twin)`
2. `§13/§15 · nothing on the enrolment journey puts the secret or a backup code on a URL: the enable answer and the verify refusal both carry the secret and all ten codes in their bodies, and neither sets a Location, and no href or form action either render draws carries a "secret", an otpauth: or any code from the set`
3. `§13 · a wrong code posted to /settings/two-factor/verify-totp answers 200 redrawing the SAME enrolment — byte-identical secret, the boxes aria-invalid, better-auth's own "Invalid code" on the card, the ten codes still shown — and twoFactorEnabled is still 0 · the code generated from that same secret answers 303 and re-issues the session cookie, and the pane read with THAT cookie renders the enabled arm with the codes gone (the twin)`
4. `§13 · the six boxes are stitched into the one field better-auth reads: the settings enrolment card and /login's TOTP challenge both carry data-otp-form and both render the shared component's hidden [data-otp-value] input, its six [data-otp] boxes and the same handler text, and the settings card posts a "code" field · neither card posts a digit0 field, which is what a code typed into today's pane sends (the twin)`
5. `§13 · Regenerate backup codes answers 200 revealing a fresh set in place — ten codes, none of them from the set the enrolment showed — while the pane's next GET reveals none and a wrong password redirects with failed= instead (the twin)`
6. `§13 · the reveal carries a Copy-codes control that names every code it drew: each code sits in its own [data-code] element and one handler reads all ten · the not-enrolled arm and the enabled arm render no Copy-codes control and no code element (the twin)`
7. `§13 · a session minted by the device flow lists as "pmcp CLI · device flow" in the Sessions pane beside the browser session that rendered the page, which reads its own client with no device-flow suffix (the twin) — and the rail's Sessions marker counts both`
8. `§13 · /settings/passkeys names a row the way the authenticator reported it: a passkey stored with a known AAGUID and no name lists as "Windows Hello", one with the all-zero AAGUID that privacy-preserving platforms report lists as "Passkey", the marker reads 2 and each row links its own Remove dialog · with none, the pane renders "No passkeys yet. Add one to sign in without a password." and the marker reads 0 (the twin)`
9. `§4 · a day-old cookie is refused at BOTH passkey register endpoints with better-auth's SESSION_NOT_FRESH code — the GET options and the POST verify, the POST carrying an Origin so the refusal is the freshness gate and not the origin check, and a body that satisfies the endpoint's schema so it is not the validator either · from a session signed in moments ago the same two calls get past that gate, the GET answering 200 with a challenge and the POST failing the ceremony itself (the twin)`

Reading row 6's twin: "the not-enrolled arm and the enabled arm" are the two arms as plain
GETs of the pane — the regenerate reveal draws the enabled arm WITH the fresh set and its
Copy control at 200, and that render is row 5's, not a counter-example to row 6.

Placement, decided by the orchestrator 2026-09-03 before the rows landed: rows 1-6 in the
new describe (they are the enrolment journey); rows 7 and 8 inside the existing panes
describe (row 8 at the retired row's position, row 7 after it — a Sessions row does not
belong under a describe titled "the enrolment journey", so the arithmetic above is
seven-in-one no longer); row 9 last in the describe that holds the passkey register rows.

Row 8 is a **retire-and-replace**. Retired key (`test-inventory.json:1443`,
`server/test/worker/web-pages.test.ts:2890`), verbatim:

```
§13 · the Two-factor, Passkeys and Sessions panes §13 · /settings/passkeys lists one row per passkey under the name the authenticator reported, and the rail's Passkeys marker is the number of rows the pane listed · with none, the pane renders "No passkeys yet. Add one to sign in without a password." and the marker reads 0 (the twin)
```

It is green on data the ceremony never produces: `plantPasskey` (`:6432-6453`) requires a
`name` and its INSERT column list (`:6439`) carries no `aaguid`, while the ceremony sends no
name (`settings.tsx:232-247`) and always writes an aaguid. The helper is widened —
`fields: { name?: string | null; aaguid?: string; createdAt?; credentialId? }`, `"aaguid"`
added to the column list, `fields.name ?? null` bound — and **all sixteen of today's call
sites pass a name and stay green under it** (`name?: string | null` is backward-compatible),
which is legitimate: a stored name is what the first term of the rule is for, and the
helper's doc comment says so. AAGUIDs for row 8:
`08987058-cadc-4b81-b6e1-30de50dcbe96` → "Windows Hello" and
`00000000-0000-0000-0000-000000000000` → undefined (`index.mjs:743`, `:767-773`).

Row 3's trap, the same class as row 9's two: the successful verify DELETES the session it
ran under and mints a new one (`totp/index.mjs:209-213`), and `redirectWith`
(`web.ts:867-871`) forwards those `Set-Cookie` headers onto the 303 — so the cookie the
test signed in with is dead the moment the POST returns, and a follow-up GET with it hits
`settingsGate` and bounces to `/login`, reading as "the enabled arm did not render". The
twin parses the new cookie off the 303 with `sessionCookieOf` (`web-pages.test.ts:457`) and
renders the pane with THAT — asserted in its own clause, because the rotation is the one
behaviour that distinguishes this target from every other credential target.

Row 9's two traps, both of which would make a status-only assertion green for the wrong
reason: better-auth mounts `originCheckMiddleware` as a router-level `/**` middleware
(`api/index.mjs:157-160`), so a cookie-bearing POST with no Origin throws
`MISSING_OR_NULL_ORIGIN` — also a 403 (`origin-check.mjs:107`; GETs are skipped at `:43`);
and better-call validates the body schema before running `use` middlewares, so a malformed
body 400s before `freshSessionMiddleware` ever runs. Assert the parsed `code`, not the
status. Do not route it through `callAuthResponse`, which sets `origin` itself
(`identity.ts:1086`) and would hide the first trap — use `call()` (`:376`) with
`ageSession` (`:558`), as the /settings prefix-gate row already does at `:1918`.

Rows 3 and 5 need a real TOTP: the page renders the secret, so the test reads it back out
of the rendered `otpauth://` and generates the code the way an authenticator app does.
**Settled by the orchestrator 2026-09-03, overriding the draft's devDependency:** the code
comes from `server/test/harness/totp.ts` — unpadded base32 decode, HMAC-SHA1 through
`crypto.subtle` (WebCrypto, never faked — it is the real primitive), RFC 6238 dynamic
truncation, 6 digits over a 30 s step at `Date.now()` — about thirty lines and no
dependency. The test plays the authenticator, exactly as `formPost` plays the browser; the
hub's verifier is better-auth's own, so a divergence in parameters (better-auth's
`createOTP` defaults are the same 6 / 30 / SHA-1) goes RED in row 3 rather than green by
construction. Rejected: declaring `@better-auth/utils` as a devDependency at better-auth's
pinned `0.4.2` — a transitive package promoted for one call, a lockfile change, a
`vitest.config.mts` allowlist entry, and a lockstep-bump rule to keep for good.

Smoke: **no new leg** — two assertions inside the existing `§13 · the /settings panes render
behind the prefix gate` step (`scripts/smoke.ts:407`): `GET /settings/two-factor` is 200 and
its body carries the not-enrolled arm's Enable control. The leg count is unchanged by this
step — whatever step 4 leaves it at is the gate's number; step 5 adds zero.

## Ownership

Disjoint by file; the order is the dependency order, and the two pairs marked concurrent
are declared concurrent.

| Group | Owns | Depends on | Model |
|---|---|---|---|
| **A · identity + migration** | `server/src/identity.ts` (`twoFactor({ issuer })`, `session.additionalFields`, `databaseHooks.session.create.before`, the `getAuthenticatorName` re-export), `server/migrations/0008_session_source.sql` | — | Opus 5 |
| **F · spec + deps** (concurrent with A) | `docs/specs/web-and-oauth/13-web-surface.md` (the three sentences, in the pre-rows `spec:` commit), `package.json` (the QR encoder `uqr`, exact version), `pnpm-lock.yaml` (what it produces), `vitest.config.mts` (`uqr` joins the optimizer's `include` at `:84-92` and the header's "seven DIRECT deps" at `:73` becomes eight — a speed knob, not correctness), `scripts/smoke.ts` (two assertions) | — | Opus 5 |
| **B · the seam** | `server/src/pages/model.ts` (`paths.auth.totpVerifySettings` + G31's comment, `enrollmentOf`, `revealedCodesOf`, `passkeyRow`, `sessionRow`, `BetterAuthPasskey`, `BetterAuthSession`), `server/src/web.ts` (`credential`'s parameter and hoisted `refusalOf`, the three reveal call sites, `settingsTwoFactorPage`, the new route) | A, F | Opus 5 |
| **C · pages** | `server/src/pages/layout.tsx` (`OtpBoxes`), `server/src/pages/login.tsx` (renders it), `server/src/pages/settings.tsx` (the enrolment card's form target and hidden fields, `OtpBoxes`, Copy codes), `server/src/pages/styles.css` if the copy control needs it | B | Sonnet 5 |
| **D · fixtures + preview** (concurrent with C) | `server/dev/fixtures.ts` — a real QR for `totpEnrolling` / `totpEnrollError`, ten codes in better-auth's `xxxxx-xxxxx` shape for `BACKUP_CODES` (`backup-codes/index.mjs:14-16`; the fixture's eight `xxxx-xxxx` at `:255-264` are fabricated on both halves, and the roadmap's "the eight codes" inherits that error), **`backupCodesRevealed`'s notice deleted** — `...shell("settings", 0)` with none, because an in-place 200 has no flash to read (the same reason the token-reveal fixtures carry none), which supersedes orphan note 65's "replace it with what `noticeOf` can build"; same rule for `totpEnrolling` / `totpEnrollError`, which must gain none; the passkey rows renamed to names `getAuthenticatorName` can return plus the "Passkey" row orphan note 70 asks for, `longNames`' unproducible long passkey name retired, `error`'s two invented halves corrected against the six accurate Password fixtures (orphan note 67) | B | Sonnet 5 |
| **E · tests** | `server/test/worker/web-pages.test.ts` (the nine rows' bodies, `plantPasskey`, case 27's two statuses, the totality row's two reveal harvests), `server/test/harness/totp.ts` (new — the authenticator's side of RFC 6238, see § Rows), `server/test/worker/migrations.test.ts` (the forward case at N=0008), `test-inventory.json` | C, D | Opus 5 |

`server/dev/fixtures.ts` is preview data, not oracle data — §9 rule 1's "never fixtures"
is about rows, law statements and `contracts/*.json`; D15's group A owned this same file
and this step follows that precedent.

## Shape

1. **`spec:` commit** (main loop) — F's three §13 sentences. Before the rows, because the
   rows assert the amended text. Owner questions 1 and 2 were decided by the orchestrator
   on 2026-09-03 (below, flagged to the owner as assumptions), so this commit can land.
2. **Rows workflow** (Opus 5: one author, one adversarial verifier for assertability and
   spec fidelity, as step 4's ran) — the nine `it.todo`s, the retired key enumerated in the
   commit message beside its replacement, `node scripts/test-inventory.mjs` → **`test:`
   commit**, titles shown to the owner with the proposal.
3. **Implementation workflow** — groups in the table's order, A ∥ F, then B, then C ∥ D,
   then E; a verbatim check that every §13 string this step pins appears byte-for-byte in
   the rendered page; the PSD review stage (Opus 5) reading the diff against
   `.claude/skills/psd/SKILL.md` with the pinned verdict schema — one finding is expected
   and pre-answered: `credential`'s new parameter is a widening, not a Pass-Through, and
   the reveal's `null` return is the family's one rule for "answer with the flash instead";
   fix loop until `web-pages.test.ts`, `migrations.test.ts` and `routes.test.ts` are green.
4. **Standard gate** (`2026-08-25-implementation-orchestration.md` § "Dispatch anatomy and
   the standard gate", items 1-7) with the ownership audit run against this table's globs,
   the inventory diff showing exactly nine `todo → passed` and the one enumerated
   retirement, and the preview walk over group D's fixtures in the Browser pane (D15
   constraint 13).
5. **Deploy + `pnpm smoke`** — the same leg count step 4 left behind, with the two added
   assertions inside the existing §13 step.
6. **Ledger row** in the orchestration plan's dispatch ledger, plus the one line the
   migration owes: every session that predates 0008 reads "web", including the owner's own
   live CLI session, until the next `pmcp login`.

## Open for the owner

> **Decided 2026-09-03 by the orchestrator, under the owner's "run the workflow for the
> missing features now" — flagged, reversible, not silently assumed.** (1) The QR encoder:
> YES — `uqr` (zero-dependency, ESM, emits SVG, no Node built-ins), pinned exact, used only
> in `enrollmentOf`; if the owner says no, the fallback below is a §13 amendment and a
> one-commit revert — and since the rows landed first (`5e6ef5d`), it also retitles rows 1
> and 2 in their own `test:` commit: row 1 names the `data:image/svg+xml` QR, and row 2's
> "no href … carries an otpauth:" forbids exactly the link the fallback draws. (2) `enrollment.error`: better-auth's own "Invalid code" verbatim, the
> fixture corrected; the clock hint is one `refusalOf` mapping away if wanted. (3) The
> abandoned enrolment: recorded as truthful, nothing changes; 3b observes it. The draft's
> `@better-auth/utils` devDependency is replaced by a harness helper (§ Rows).

1. **The QR encoder is a new runtime dependency** — the one item this plan cannot settle
   alone, since it changes `package.json`'s dependencies. Recommended: yes, a zero-dep
   pure-JS encoder used in one function. If the answer is no, the fallback is honest and
   cheap but it is a §13 amendment, not a silent substitution: `TotpEnrollment.qrDataUri`
   is deleted, the card renders the `otpauth://` URI as a link beside the grouped secret,
   and §13:97's "QR plus the grouped secret for manual entry" is rewritten to say so. Do
   NOT ship the fallback under the name `qrDataUri`. Either way `fixtures.ts:245-253`'s
   placeholder stops standing in for a producer that does not exist. **Answered before step
   1 of the Shape**, because the QR is one of the three §13 sentences and is named in two
   of the nine row titles.
2. **`enrollment.error`'s sentence.** This plan ships better-auth's own "Invalid code"
   verbatim (`totp/index.mjs:202` → `error-code.mjs`), the way the six accurate Password
   fixtures carry better-auth's messages (orphan note 67). `fixtures.ts:517`'s "That code
   didn't match. Check your device's clock and try again." is fabricated copy with no
   producer and is replaced by the real sentence. If the owner wants the clock hint, it is
   a §13 sentence plus a mapping in `refusalOf` (`web.ts:905`), and it lands in the same
   `spec:` commit — say so before step 1 of the Shape, or the fixture is corrected the
   other way.
3. **The abandoned enrolment.** Enable writes better-auth's row before any code is typed,
   so an owner who navigates away and comes back sees the not-enrolled arm again, and a
   second Enable rotates the secret. That is truthful (the factor is not enabled) and
   nothing in §13 says otherwise; named here so the answer is deliberate rather than
   discovered in 3b's browser leg.
4. **Three refuter findings answered rather than applied verbatim** — the claim was right,
   the number was not, so the plan says something different from what was proposed:
   - *The smoke leg count.* Both refuters gave a number and they disagree (27 vs 29/30).
     Measured here: `grep -n 'step(' scripts/smoke.ts` minus the definition returns 29 at
     HEAD and 30 in the working tree (three of them are the cleanup steps), while the last
     ledger row reads "SMOKE PASS 27/27 live" — three counts, none reconcilable from the
     file alone. The plan therefore states no total: step 5 adds no leg, and the gate is
     the delta. The roadmap's own step-5 DoD names no number either.
   - *`plantPasskey`'s blast radius.* The refuter said "fifteen other call sites"; the file
     has **sixteen** calls plus the definition (`:1858`, `:1859`, `:1902`, `:1951`,
     `:2082`, `:2141`, `:2142`, `:2902`, `:2903`, `:2927`, `:2928`, `:2946`, `:2947`,
     `:2967`, `:3002`, `:3259`), every one passing a name. The plan says sixteen.
   - *`OtpBoxes` and `data-otp-form`.* Row 4's title was not simply narrowed to drop the
     attribute: the attribute is asserted on BOTH forms (it is what the shared script keys
     off, `login.tsx:220`) while the component owns only the hidden input, the box row and
     the script. Dropping it from the title would have stopped the row from catching a
     settings card that renders the boxes without the hook that reads them — the exact G30
     failure.
