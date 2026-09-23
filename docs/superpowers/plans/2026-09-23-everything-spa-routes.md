# Everything is the SPA, pass 1 — the route inventory and the design that replaces it (2026-09-23)

The working inventory behind the brief's step 2 (`2026-09-23-everything-spa.md` §4), for the
orchestrator, `spa-server` and `spa-web`. The binding text is in the specs — §18 decision 38 and
the 2026-09-23 amendments to §4, §13, §16, §17, §19 and strategy §3. Where this file and a spec
disagree, the spec wins and this file is stale. Line numbers are as of `5b109ff`.

Read §0 first: every family below uses its three conventions, and they are stated once.

---

## 0 · What every family shares

### 0.1 The shell, per URL

Every migrated GET answers `web.ts`'s `shell()` document (`web.ts:1497`), rendered through
`render()` (`web.ts:1456`). Each keeps exactly the gate and the document-level status its
page has today, run before any HTML exists — the pattern `/apps/<slug>`'s `appExists` set.

| URL | Gate (unchanged) | Document-level check, before HTML (unchanged) | Tab title (today's) |
|---|---|---|---|
| `/login` (every query) | **none** | none | loginProps' step: `Sign in` / `Two-factor code` / `Use a backup code` (`login.tsx:39`) |
| `/device` (every query) | `requireOwnerSession` | none | `Approve device` |
| `/settings` + the six pane URLs | web.ts's prefix middleware, `{ recent: true }` (`web.ts:252-257`) | none; `/settings/password` stays the app's 404 (no route claims it) | `Settings · personal-mcps` |
| `/approvals` | `requireOwnerSession` | none | `Approvals` |
| `/approvals/:id` | `requireOwnerSession` | the id is in this owner's `approval_list` (`approvalDetailProps !== null`) else `noSuchPage()` — foreign and unknown ids one 404 | `Approve request · personal-mcps` |
| `/oauth/consent` | `requireOwnerSession` (302 to `/login?next=/oauth/consent?<signed>`) | the provider's `/oauth2/public-client-prelogin` accepts `{client_id, oauth_query}` (consentProps' own first half, `model.ts:2138-2150`) else `400 Bad Request` text/plain | `Connect <client_name>` (`An application` when none) |

**Headers.** Every server page today carries exactly three, all from `render()`:
`Content-Type: text/html; charset=utf-8`, `Content-Security-Policy: frame-ancestors 'self';
base-uri 'self'; object-src 'none'`, `Cache-Control: no-store`. `frame-ancestors 'self'` is the
hub's **only** anti-framing header (no `X-Frame-Options` anywhere in `server/src`; index.ts adds
no page headers). The shell already goes through `render()`, so it carries all three at every URL
above by construction; the requirement is that it stays that way, and row `2214` ("one renderer
emits every HTML page…") extends its carriers from `/login`, `/apps`, `/apps/new` to all six
URLs. Refusals keep their own answers: the gate's 302 (Location only), `noSuchPage()`'s 404 and
consent's 400 (`Content-Type: text/plain`, no CSP, no no-store) — unchanged.

**Head differences, accepted.** The shell's head is `spa.tsx`'s: manifest + icons + `/app.css`,
`theme-color #ffffff`. Today `/login` and `/oauth/consent` say `#fafafa`, and `/login`,
`/device` and `/oauth/consent` link no manifest. Neither shows in a screenshot (theme-color tints
a phone's browser chrome). If the owner wants them back: a `themeColor` prop on `SpaShell`.

### 0.2 The two islands

- `#pmcp-bootstrap`, on every **session-gated** shell: `{ csrf, username, origin,
  vapidPublicKey }`. `vapidPublicKey` is **new** — configuration like `origin`, needed by the
  approvals page's push control, and reported by no API. (`web/src/lib/bootstrap.ts` validates the
  field set, so the client reads the fourth field.)
- `#pmcp-login`, on `/login` **only**, and `/login` carries **no** `#pmcp-bootstrap` (no session:
  no csrf, no username). Its content is the unchanged `loginProps()` minus `now`:

  ```ts
  /** GET /login's island — `loginProps(now, query, rawSearch)` (model.ts:2018) minus `now`. */
  type LoginIsland = {
    step:
      | { kind: "credentials"; username: string; error: string | null }
      | { kind: "totp"; error: string | null }
      | { kind: "backup-code"; error: string | null };
    /** §19.5's constant `/api/auth/oauth2/authorize?<signed bytes>`, or `hubRelative(?next)`,
     *  or null (= /apps). The ONE landing both the hidden `callbackURL` and the passkey
     *  ceremony's post-verify navigation read. */
    redirectTo: string | null;
  };
  ```

- **Escaping, required of every island** (new): serialized with `<` → `<`, U+2028 →
  ` `, U+2029 → ` ` — `login.tsx:79`'s `jsLiteral` rule, which moves into `spa.tsx`
  when `login.tsx` goes. Today `spa.tsx:74-77` is safe only because every bootstrap value is hex,
  charset-bound or configuration; the login island carries `?next=`, `?error=` and `?username=`
  text any link can set to `</script><img …>`, and `redirectTo` passes `hubRelative` while
  containing `<`.

### 0.3 The JSON conventions

- **Reads** are `reader` routes (`api.ts:695`): cookie session, 401 `{ reason: "Sign in again." }`,
  `no-store`. **Writes** are `writer` routes (`api.ts:715`): session → origin → `X-Pmcp-Csrf` →
  JSON-object body.
- **`/api/hub/settings/*` is one prefix rule**: every read and write under it resolves the session
  with `{ recent: true }` (a stale or bearer-sourced session is the same 401), written once as a
  prefix middleware the way `web.ts`'s `settingsGate` is — so a route added there cannot be added
  ungated, and the ordinary gate never becomes a §4 freshness bypass.
- **Redirect as data.** A JSON write that replaces a form POST whose answer was a 303 answers

  ```ts
  /** 200 — `next` is byte-for-byte the Location today's 303 named (built by the same
   *  `noticeUrl` / `paths` code, never from input); `reload` is true exactly when this answer
   *  forwards better-auth's Set-Cookie, i.e. the session — and with it the CSRF token the
   *  document holds — was replaced. */
  type Redirected = { next: string; reload: boolean };
  ```

  The client does `location.assign(next)` when `reload`, and may route client-side otherwise.
  This keeps the flash protocol (`NOTICE_KEYS`), the pane a notice lands on and the
  Set-Cookie forwarding on the server, and turns most rows into a mechanical port (`Location` →
  `body.next`).
- **Refusals** keep `api.ts`'s shape: `{ reason: string; violations?: Violation[] }` at 400/403/
  404/422.

### 0.4 Form POSTs that are KEPT, and why

Four families of form target stay real `<form method="post">` submissions, rendered by the SPA:
every one ends in a **navigation** a `fetch` cannot perform — the `/apps/connect` precedent
(`web.ts:551-555`, §13).

| Route | Why it stays a form | Outside callers |
|---|---|---|
| `POST /login/sign-in/username`, `/login/two-factor/verify-totp`, `/login/two-factor/verify-backup-code` (`web.ts:178-196`) | the 303 lands on `callbackURL` — including §19.5's `/api/auth/oauth2/authorize?<signed>`, whose chain ends at a third-party redirect_uri — and forwards better-auth's Set-Cookie; the hub, not the client, judges the landing (`landingOf` → `hubRelative`, `web.ts:1020`) | `scripts/smoke.ts:803` (form-encoded) |
| `POST /login/sign-out` (`web.ts:204`) | 303 to `/login` with the cleared cookie; better-auth's `/sign-out` answers JSON, not a redirect | none — and **the SPA does not post here today** (§ contradictions, 1) |
| `POST /oauth/consent` (`web.ts:613`) | 303 to the client's third-party `redirect_uri`; §19.5's `mutation` gate and verify-before-write stay byte-for-byte | `scripts/smoke.ts:849`, `:946` (form-encoded) |
| `POST /apps/connect` | unchanged (not this project) | — |

The SPA renders them with the field names the handlers read (`csrf` from `#pmcp-bootstrap`,
`oauth_query` from the consent read, `callbackURL` from `#pmcp-login`, `decision`, `agent`,
`username`, `password`, `code`).

---

## 1 · Approvals and approval detail (family 1)

### Today

| Method, path | file:line | Checks | Reads | Writes / answers | Other callers |
|---|---|---|---|---|---|
| GET `/approvals` | web.ts:510 | owner session (302 `/login?next=`) | `approvalsProps` (model.ts:1480): `approval_list {status:"pending"}`, then `approval_list {limit: historyLimit+pending+1}`, `?limit=` via `positive()` (default 20), `env.VAPID_PUBLIC_KEY`, the flash (`noticeOf`) | 200 HTML | SPA Shell nav (plain link, `Shell.tsx:72`), layout.tsx nav, service worker's `notificationclick` fallback, approval-detail's foot link, every decision's 303 |
| POST `/approvals/push` | web.ts:518 | `mutation`: session, form, CSRF field | form field `subscription` (JSON, shape-checked by `subscriptionOf`, web.ts:1424) | `approvals.subscribePush`; 204, or 400 `Bad Request` | approvals.tsx's inline script (fetch + FormData) only |
| POST `/approvals/:op` | web.ts:531 | `mutation`; then `dispatch` runs **any** op in `admin.ops` by name (not an allowlist) | query + form fields as the op's input | the op; 303 `/approvals?done=<op>` or `?failed=<op>&reason=` — from **both** pages | approvals.tsx and approval-detail.tsx forms (`paths.approvalDecide`) |
| GET `/approvals/:id` | web.ts:535 | owner session | `approvalDetailProps` (model.ts:1508): `approval_list {limit:1000}`, find by id, `decided()` narrowing | 200 HTML, or 404 `No such page` (foreign ≡ unknown) | `-32003`'s `data.approvalUrl` (approvals.ts:617), Web Push payload `url` → `notificationclick`, history rows |

### Replacement

| Method, path | Replaces | Checks kept | Shapes |
|---|---|---|---|
| GET `/approvals` → shell | GET `/approvals` | owner session, 302 | `#pmcp-bootstrap` incl. `vapidPublicKey` |
| GET `/approvals/:id` → shell | GET `/approvals/:id` | owner session; the same lookup as the document 404 | — |
| GET `/api/hub/approvals?status=pending` **(exists, api.ts:460)** | the pending half | `reader` | `{ approvals: ApprovalRow[] }` |
| GET `/api/hub/approvals?limit=N` **(exists)** | the history half; the client computes `historyLimit = positive(?limit) ?? 20` and asks `historyLimit + pending.length + 1`, exactly model.ts:1481-1496 | `reader` | `{ approvals: ApprovalRow[] }` |
| GET `/api/hub/approvals/:id` **(new)** | `approvalDetailProps` | `reader`; the same `approval_list {limit:1000}` lookup and `decided()` narrowing; foreign ≡ unknown ≡ 404 | `{ approval: DetailApproval }` / 404 `{ reason: "No such approval." }` |
| POST `/api/hub/ops/approval_decide` **(exists, allowlisted, api.ts:211)** | POST `/approvals/:op` | `writer`; allowlist; `parseInput` | body `{ id, decision: "approve" \| "reject" }` → 200 `{ value }` / 422 `{ reason }` (a lost race is the op's one message). The client lands on `/approvals?done=approval_decide` or `?failed=approval_decide&reason=…` — from both pages, as the 303 did — and `web/src/lib/notice.ts` already keys the warning tone on `approval_decide` |
| POST `/api/hub/approvals/push` **(new)** | POST `/approvals/push` | `writer`; `subscriptionOf`'s shape check | body `{ subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }` → 204 / 400 `{ reason }` |

**Deleted when this family ships:** POST `/approvals/push`, POST `/approvals/:op` (nothing
outside the web surface posts either). Deleting `/approvals/:op` also retires a generic
dispatcher that admitted **every** op by name behind CSRF — its replacement is the nine-name
allowlist.

### Test rows (`web-pages.test.ts` unless named)

| Row (line · short title) | Fate |
|---|---|
| 1395 · 8. `/approvals/<id>` foreign refuses · own renders | **stays** at the shell (404 vs 200) **and ported** to `GET /api/hub/approvals/:id` (404 byte-identical for foreign and unknown; 200 for own) |
| 1718 · G52 lost race lands with the warning | **ported**: `approval_decide` through `/api/hub/ops` twice — 200 then 422 with the op's one message; the warning copy is the client's (web unit row over `notice.ts`) |
| 1755 · 16. every /approvals form names an ops key | **retired** — row 18 (the allowlist, 1779) is the JSON surface's answer and already admits `approval_decide` |
| 1764 · 17. form field set = `schemaKeysOf` | **retired** — row 18b (1830) pins the server half; the body the client builds is web-side |
| 1846 · 19. every page mutation reaches an ops handler | **ported**: walks the moved families' ops-backed JSON writes (`approval_decide`, and in family 2 `token_revoke`, `connection_revoke`, `hub_settings_update`) under substituted handlers, namespace shape unchanged |
| 915 · 4. every mutating form carries a CSRF field | its walk (`sessionPages()`, 5761) shrinks with each family and is **retired** with the last; see family 2 for its READ half |
| — (none today) | **new**: POST `/api/hub/approvals/push` — malformed subscription 400 and no `push_subscription` row; no `X-Pmcp-Csrf` 403; the twin stores exactly one row (no route-level row exists today — `approvals.test.ts` covers `subscribePush` only) |
| — | **new**: the two shells — 302 with no cookie carrying `next=`, 200 `no-store` with the bootstrap (incl. `vapidPublicKey`) — join the shell rows at 1016/1038 |

Smoke: no step touches these routes.

---

## 2 · Settings (family 2)

### Today

| Method, path | file:line | Checks | Reads | Writes / answers |
|---|---|---|---|---|
| prefix `/settings`, `/settings/*` | web.ts:252-257 | `requireOwnerSession(req, {recent:true})` — stale or bearer-sourced → 302 `/login?next=` | — | — |
| GET the seven pane URLs | web.ts:263-268 | the prefix gate | `settingsProps` (model.ts:1761): better-auth `/get-session`, `/list-sessions`, `/passkey/list-user-passkeys`; `passkeyLastUsed`; `token_list`, `connection_list`, `hub_settings_get`; query-derived `tokenKind`, `confirm`, `passwordError`, flash | 200 HTML |
| POST `/settings/two-factor/enable` | web.ts:277 | `credential` = `mutation` + recent | form `password` | better-auth `/two-factor/enable`; **200 HTML in place** with the enrolment (secret, QR, ten codes) or 303 flash |
| POST `/settings/two-factor/verify-totp` | web.ts:308 | same | form `code`, hidden `totpuri`, hidden `codes` (re-validated: `enrollmentOf`, `postedCodes`) | `/two-factor/verify-totp`; success 303 + **Set-Cookie** (better-auth replaces the session); refusal 200 HTML redrawing the posted enrolment |
| POST `/settings/two-factor/disable` | web.ts:337 | same | `password` | `/two-factor/disable`; 303 flash |
| POST `/settings/two-factor/generate-backup-codes` | web.ts:344 | same | `password` | 200 HTML reveal or 303 flash |
| POST `/settings/passkey/delete-passkey` | web.ts:364 | same | `id` | `/passkey/delete-passkey`; 303 flash |
| POST `/settings/revoke-session` | web.ts:375 | same | `id` → token via `/list-sessions` (the token never leaves the handler) | `/revoke-session`; 303 flash |
| POST `/settings/revoke-other-sessions` | web.ts:385 | same | — | `/revoke-other-sessions`; 303 flash |
| POST `/settings/change-password` | web.ts:398 | `mutation` + recent; **new ≠ confirm checked before the call**; `N` counted before; code → field map | `currentPassword`, `newPassword`, `confirmPassword`, `revokeOtherSessions` (presence) | `/change-password`; 303 flash with `field`/`signedOut`, + Set-Cookie on success |
| POST `/settings/tokens/:op` | web.ts:452 | `mutation` via the prefix (recent); `dispatch` admits **any** op | query + form | op; 303 `/settings/tokens?done=` |
| POST `/settings/clients/:op` | web.ts:453 | same | same | op; 303 `/settings/clients?done=` |
| POST `/settings/execution/hub_settings_update` | web.ts:459 | `mutation` + prefix | `default_timeout_ms`, `max_timeout_ms` through `executionField` (clean integers → numbers, else the owner's text) | op; 303 flash, or **400 HTML** redrawing the pane with `executionErrors` |
| (passkey add) better-auth `/api/auth/passkey/generate-register-options` + `/verify-registration` | settings.tsx inline script | better-auth's own `freshSessionMiddleware` (passkey plugin `index.mjs:88`) | — | stays as is |
| GET `/oauth/connections` | web.ts:647 | none | — | 301 `/settings/clients` — **stays** |

Other callers: the SPA's Credentials pane links `/settings/clients`; the SPA Shell nav links
`/settings`; the smoke GETs `/settings`, `/settings/clients`, `/settings/two-factor`,
`/settings/password`, `/oauth/connections` and POSTs `/settings/change-password` bearer-only
(`smoke.ts:536-579`). No CLI, provider or external client posts any `/settings` target.

### Replacement

All under the `/api/hub/settings/*` recent-auth prefix rule (§0.3). The mapping is mechanical:
**a form target at `/settings/X` becomes `POST /api/hub/settings/X`, JSON in**. The shells are
the seven pane URLs (gate: the unchanged prefix middleware).

```ts
/** GET /api/hub/settings — settingsProps' server half, one read for the rail and every pane
 *  (§13's "never a second query"). Query-derived state (pane, ?kind, ?confirm, the flash,
 *  ?field) is the client's, read from its own URL. */
type SettingsRead = {
  twoFactor: { enabled: false } | { enabled: true };
  passkeys: PasskeyRow[];      // passkeyRow(): AAGUID-named, §5's lastUsedAt
  sessions: SessionRow[];      // sessionRow(): no token, ever; `current` marks this session,
                               // whose createdAt is the "Confirmed your identity N minutes ago" clock
  tokens: TokenRow[];          // tokenRows(): unrevoked, `expired` judged at read time
  connections: ConnectionRow[];
  execution: { defaultTimeoutMs: number; maxTimeoutMs: number };
  /** Configuration the panes print, so the page holds no second literal (§4/§23). */
  limits: { passwordMinLength: number; minTimeoutMs: number; maxTimeoutMs: number };
};
```

| Method, path | Body | Answers | Checks kept |
|---|---|---|---|
| GET `/api/hub/settings` | — | 200 `SettingsRead` | recent prefix; better-auth reads through `callAuth` (cookie); `token` stripped as today |
| POST `/api/hub/settings/two-factor/enable` | `{ password }` | 200 `{ enrollment: TotpEnrollment; backupCodes: string[] }` when better-auth's answer yields both (`enrollmentOf`, `revealedCodesOf`), else 200 `Redirected` (done/failed flash on `/settings/two-factor`) | recent, origin, CSRF; secret/codes in the body only, never a URL (§15) |
| POST `/api/hub/settings/two-factor/verify-totp` | `{ code }` | 200 `Redirected` with `reload: true` (Set-Cookie forwarded) / 422 `{ reason }` (better-auth's words; the client redraws the enrolment it already holds) | same; `totpuri`/`codes` are no longer posted, so `enrollmentOf(posted)` and `postedCodes` have nothing left to re-validate |
| POST `/api/hub/settings/two-factor/disable` | `{ password }` | 200 `Redirected` | same |
| POST `/api/hub/settings/two-factor/generate-backup-codes` | `{ password }` | 200 `{ backupCodes: string[] }` or 200 `Redirected` | same |
| POST `/api/hub/settings/passkey/delete-passkey` | `{ id }` | 200 `Redirected` (`/settings/passkeys?…`) | same |
| POST `/api/hub/settings/revoke-session` | `{ id }` | 200 `Redirected` (`/settings/sessions?…`) | same; id → token server-side |
| POST `/api/hub/settings/revoke-other-sessions` | `{}` | 200 `Redirected` | same |
| POST `/api/hub/settings/change-password` | `{ currentPassword, newPassword, confirmPassword, revokeOtherSessions: boolean }` | 200 `Redirected` — `next` is today's `noticeUrl` incl. `field` / `signedOut`; `reload: true` on success (Set-Cookie) | same; the confirm pre-check before any call; `N` counted before; `PASSWORD_REFUSAL_FIELD` |
| POST `/api/hub/settings/tokens/token_revoke` | `{ id }` (the op's own keys) | 200 `Redirected` (`/settings/tokens?done=token_revoke`) | recent (the pane keeps §13's "a page's gate is every pane's gate", though `token_revoke` is also on the ordinary allowlist) |
| POST `/api/hub/settings/clients/connection_revoke` | `{ id }` | 200 `Redirected` (`/settings/clients?…`) | recent; stays off the ordinary allowlist |
| POST `/api/hub/settings/execution/hub_settings_update` | `{ default_timeout_ms: string; max_timeout_ms: string }` — the owner's text | 200 `Redirected` / 422 `{ reason, violations }` (the client keeps the text, places each sentence with the existing `derive.ts` `shownSentence`) | recent; `executionField` stays server-side |

The two `:op` dispatchers become two fixed routes naming one op each — no generic dispatch
survives under `/settings`.

**Deleted when this family ships:** all eleven POST targets above — the eight credential
routes, the two `:op` dispatchers and the Execution save (`web.ts:277-482`) — with
`credential`, `settingsTwoFactorPage`, `postedCodes`, and the settings props builder's
view-only fields. Nothing outside the web surface posts them (the smoke's
bearer-only POST is ported, below).

**View rules that move to the client**, each a pure function the web agent pins with a unit
row in the `audit-derive.test.ts` manner (`server/test/unit/`, over `web/src/…/derive.ts`):
`settingsConfirm` (a `?confirm=` naming no row on its owning pane draws no dialog —
model.ts:1894), `tokenKindOf`, `passwordErrorOf`, the rail markers as list lengths,
`noticeOf`'s `change_password` arm (`passwordDone`, web.ts:1219 — `web/src/lib/notice.ts` lacks
it today), `timeoutLabel`, `executionErrors`.

### Test rows

| Row (line · short title) | Fate |
|---|---|
| 2756 · seven panes at own URL; `/settings/password` 404 | **stays** (shell statuses) |
| 2770 · same rail on every pane | web-side (gallery + DOM) |
| 2801 · rail counts = rows listed | **ported** to the read (four lists, four lengths); the marker drawing is web-side |
| 2851 · Two-factor marker is a status | **ported** to the read (`twoFactor.enabled` both ways); drawing web-side |
| 2872 · prefix gate on all seven panes (stale, bearer; fresh twin) | **stays** at the shells **+** the same three sessions at `GET /api/hub/settings` (401, 401, 200) |
| 2897 · every POST under `/settings/` refuses a day-old cookie with its own CSRF token | **ported** to every `/api/hub/settings/*` write (401, nothing reached; fresh twin accepted) |
| 3026 · a mutation lands on its pane with its notice | **ported**: `body.next` names the pane + flash; rendering web-side |
| 3091 · confirm dialog rides its owning pane | web-side (pure `settingsConfirm`) |
| 3129 · the seven pane strings | **stays** |
| 3152 · no page links `/oauth/consent` | web-side (a walk over the bundle's links / gallery DOM) |
| 3169 · mobile pill row | web-side |
| 3193 · bearer, no cookie, at a `/settings` POST | **ported**: 401 at `/api/hub/settings/*`, neither better-auth nor the op reached |
| 3271 · consent renders no rail | web-side |
| 3288 · Password pane controls + footer | web-side; the read's `limits.passwordMinLength` server-side |
| 3324 · length hint from one minimum; one short refused | **ported** (`next` carries `failed=change_password&field=newPassword`; no cookie; old password still signs in) |
| 3377, 3428, 3479 · wrong current / mismatch / unmapped code | **ported** (field in `next`; mismatch never calls better-auth) |
| 3526 · "Confirmed your identity N minutes ago" | **ported** to the read (`sessions[current].createdAt`); sentence web-side |
| 3544 · Update password with others signed out, end to end | **ported** (Set-Cookie on the JSON answer, `reload: true`, `signedOut=2` in `next`) |
| 3602, 3644 · tokens survive; unticked flag | **ported** |
| 3684 · no CSRF field → 403 | **ported** to no `X-Pmcp-Csrf` → 403 (+ twin) |
| 3719 · no credential → bounced | **ported** → 401 JSON (+ twin) |
| 3746 · better-auth's mount enforces no freshness; the hub gate is the only one | **flipped by decision 39** (leg A: the mount refuses 403 `SESSION_NOT_FRESH`, password untouched) and **ported** (leg B at `/api/hub/settings/change-password`, stale → 401) |
| 3797 · day-old cookie posts no credential target | **ported** |
| 3857, 3894, 3918, 3938, 4053, 4086 · passkey/session rows | **ported** to the read's rows; 4086's sign-in leg stays (the `/login` form is kept) |
| 3959, 4153, 4184, 4231 · Remove / Revoke / Revoke all others / CLI row, end to end | **ported** (the confirm-link leg web-side) |
| 3996, 4035 · the passkey ceremonies are scripts naming better-auth's endpoints | web-side; 4035's "username form posts form-encoded to the translation" **stays** as a kept-route row |
| 4129 · current session unrevocable | read (`current: true`) + web-side |
| 4269 · two-factor pane's one URL | shell **stays**; forms web-side |
| 4293 · every control the panes render is claimed | **ported** as a route-set row: the settings writes are exactly the eleven above, the two ops-backed ones front `token_revoke` / `connection_revoke`; the control walk web-side |
| 4384 · day-old cookie refused at the passkey register endpoints | **stays** (better-auth direct) |
| 4516 · enable answers the setup card in place | **ported** (200 `{ enrollment, backupCodes }`) |
| 4554 · nothing on the journey puts a secret on a URL | **ported** (no answer's `next` and no Location carries the secret or a code) |
| 4598 · wrong code redraws the SAME enrolment | **ported** (422 `{ reason }` = better-auth's "Invalid code"); the redraw is web-side |
| 4654, 4739 · the six boxes; Copy codes | web-side |
| 4693 · Regenerate reveals a fresh set; wrong password → failed | **ported** |
| 4773 · after a TOTP sign-in the session opens /apps | **stays** |
| 4866, 4992 · token rows / expired → Remove | **ported** to the read (+ the revoke route) |
| 4889, 4904, 4934, 5032, 5053 · links, filter, marker, copy, columns | web-side |
| 4953 · Revoke walks end to end | **ported** (`/api/hub/settings/tokens/token_revoke`) |
| 5096 · `/oauth/connections` 301 | **stays** |
| 5109 · nothing routes the old connections POST | **stays**, extended: `/settings/clients/connection_revoke` is gone too |
| 5161, 5197, 5214, 5378 · client rows, unverified marker, footer, markers | read + web-side |
| 5221 · connection Revoke end to end | **ported** |
| 5262 · either ops-backed pane without CSRF → 403 | **ported** (`X-Pmcp-Csrf`) |
| 5313 · re-consent revives the row | **stays** (consent form kept) + the read |
| 5350 · Tokens/Clients bodies = `schemaKeysOf` | **ported**: each route's body is the op's own keys, and an extra key is 422 |
| 5466 · Execution renders the pair and bounds | read (`execution`, `limits`) + web-side |
| 5481 · valid save | **ported** (`next` = `/settings/execution?done=hub_settings_update`, one audit row) |
| 5507 · invalid pair → 400 redraw with sentences under fields | **ported**: 422 `{ reason, violations }` naming each field; placement and owner's text web-side |
| 1999 · 27. enable/regenerate accept the password control | **ported** (the JSON bodies are accepted by better-auth: 200 reveal) |
| 1970 · 24. every credential form posts a route served as a form | **replaced** (see contradictions, 1): the forms the **bundle** renders post only the §0.4 kept routes, each answering a form post without 415/404 |
| 915 · 4. CSRF walk | its READ half **ported**: `POST /api/hub/settings/tokens/token_revoke` without `X-Pmcp-Csrf` → 403, op never reached |
| 1374 · 6. bearer-sourced session refused on /settings | **stays** (shell) + JSON twin |
| auth-matrix `/settings` rows (586-623, 1355) | **stay** (they GET `/settings`) |
| admin-ops 1812 · the ops still answer the CLI | **stays** |

**Smoke** (`smoke.ts:536-579`, owned by `spa-server`): the rail-`href` and "Enable two-factor"
scrapes go (the shell has no markup); keep the four statuses, add `GET /api/hub/settings` 200
with `twoFactor.enabled === false` on the fresh namespace, and port the bearer-only POST to
`/api/hub/settings/change-password` expecting **401**.

---

## 3 · Device (family 3)

### Today

| Method, path | file:line | Checks | Reads | Writes / answers | Other callers |
|---|---|---|---|---|---|
| GET `/device` | web.ts:215 | owner session (ordinary, **not** recent) | `deviceProps`/`deviceStep` (model.ts:2069/2084): `?decided=` → decided card; no `?user_code` → enter-code with `?error=` as text; else better-auth `GET /device?user_code=` through `callAuth` (cookie) — **which claims a pending unclaimed code for this user** (device-authorization `routes.mjs:529-549`) and returns `client_id` only to the claimant; null → enter-code "That code is not valid. Check it and try again." | 200 HTML | the CLI prints `verification_uri_complete` or `${origin}/device` (cli/src/main.ts:418) |
| POST `/device/decide` | web.ts:224 | `mutation`: session, form, CSRF | `decision === "approve"`, `user_code` | better-auth `/device/approve` or `/device/deny` (claimant = approver, pending, unexpired — better-auth's checks); `auth.device_approved` audit row written **at the mount** (identity.ts:1406-1429); 303 `/device?decided=approved\|denied` or `/device?error=That code could not be decided.` | device.tsx only |

### Replacement

```ts
/** The confirm card's facts — `DeviceRequest` (model.ts:538), every field but userCode
 *  attacker-influenced or a stated ceiling. */
type DeviceRead = {
  request: {
    userCode: string;       // echoed as asked
    ip: "unknown";          // KNOWN CEILING: better-auth records no requesting IP
    client: string;         // client_id, or "unknown" when this owner is not the claimant
    requestedAt: string;    // ISO — the read's own instant, as today
    expiresAt: string;      // requestedAt + DEVICE_CODE_TTL_MS — the window's bound, as today
  };
};
```

| Method, path | Replaces | Checks kept | Shapes |
|---|---|---|---|
| GET `/device` → shell | GET `/device` | owner session, 302 `/login?next=/device?user_code=…` | `#pmcp-bootstrap` (`username` names who the device signs in as) |
| GET `/api/hub/device?user_code=<code>` **(new)** | `deviceStep`'s verify arm | `reader` (ordinary session, as today); the **same** `callAuth(req, "/device?user_code=…")` with the cookie, so the claim binds the code to this owner exactly as the render did; answers nothing the confirm card does not show | 200 `DeviceRead` / 404 `{ reason: "That code is not valid. Check it and try again." }` / 400 when `user_code` is absent |
| POST `/api/hub/device/decide` **(new)** | POST `/device/decide` | `writer` (session, origin, **CSRF** — §13 pins it; better-auth's own gate is origin-only); `callAuth` → `/device/approve` or `/device/deny` with the cookie; the audit row still lands at the mount | body `{ userCode: string; decision: "approve" \| "deny" }` (anything else 400) → 200 `Redirected` (`/device?decided=approved\|denied`, or `/device?error=That%20code%20could%20not%20be%20decided.`; `reload: false`) |

`?decided=`, `?error=` and a missing `?user_code` stay **client-read URL state** (display only),
exactly as `deviceStep` reads them. The client calls the read only when `user_code` is present
and non-empty, and never on `decided`.

**Binding, reviewed.** The read is bound to the user code the way the render was: one
better-auth verify call, carrying this owner's cookie, which claims a pending unclaimed code for
this owner and reveals `client_id` only to the claimant; the decision is better-auth's
`/device/approve|deny`, which refuses a non-claimant, a decided code and an expired one. The
read is a GET that claims — as rendering `/device?user_code=` always was: a top-level
cross-site navigation to either URL carries the Lax session cookie and claims, as today, while
a cross-site `fetch` carries no cookie and claims nothing; and a claim grants nothing without
the owner's CSRF-checked Approve. It answers the confirm card's five facts and nothing else
(no `scope`, no `status`, no device code). `DeviceRequest` stays attacker-influenced display
data: the client renders every field as text.

**Deleted when this family ships:** POST `/device/decide` (device.tsx is its only poster).

### Test rows

| Row | Fate |
|---|---|
| 2293 · 28. Approve form-encoded decides; the CLI's redemption answers whoami as the owner | **ported**: read (claims) → `POST /api/hub/device/decide` approve → `next` `/device?decided=approved` → redemption |
| 2322 · 29. Deny → `access_denied` | **ported** |
| 2366 · 31. one `auth.device_approved` row via `/device`'s own form | **ported** (the row is written at the mount either way) |
| auth-matrix 1515 · a bearer is refused at `/device` and `/device/approve` | **stays** |
| — | **new**: read without a session 401; an invalid or expired code 404 with the sentence; the read's key set is exactly `request`'s five (nothing beyond the card); decide without `X-Pmcp-Csrf` 403 and the code stays pending (+ twin); the shell's 302 carries `user_code` in `next=` |

Smoke: the device step drives better-auth directly (`smoke.ts:180-210`) — unaffected.

---

## 4 · Consent (family 4) — the security boundary (§19.5, decision 24)

### Today

| Method, path | file:line | Checks | Reads | Writes / answers | Other callers |
|---|---|---|---|---|---|
| GET `/oauth/consent` | web.ts:598 | owner session (302 `/login?next=/oauth/consent?<signed>`) | `consentProps` (model.ts:2138): `oauthQuery` = the request's raw search, once; empty or no `client_id` → null; provider `/oauth2/public-client-prelogin {client_id, oauth_query}` **re-verifies the signature** → null; `agent_list`; `isDcrClient` (D1 `oauthClient.userId`); `originOf(redirect_uri)`; scopes; `namespaceOfResource(resource)` | 200 HTML / **400** `Bad Request` text | the provider's `consentPage` redirect (identity.ts:201); `/login` after an expired session |
| POST `/oauth/consent` | web.ts:613 | `mutation`: session → form → CSRF → body | `oauth_query`, `decision`, `agent` | provider `/oauth2/consent {accept, oauth_query}` **first** (signature enforced there); on its success and `accept`: `bindConsentedAgent` (agent slug scoped to this owner, `upsertBinding`, `oauth.consented`/`oauth.rebound`); 303 to the provider's `url`/`redirect_uri`; 400 on any refusal, writing nothing | consent.tsx; the smoke (form-encoded, `smoke.ts:849`, `:946`) |

### Replacement

```ts
/** GET /api/hub/oauth/consent?<signed> — ConsentProps (model.ts:1015) minus `now` and
 *  `csrfToken`: every field is shown on the screen or echoed by its form, nothing else. */
type ConsentRead = {
  /** The signed query exactly as THIS request carried it — the value the form posts back. */
  oauthQuery: string;
  clientName: string | null;          // untrusted; rendered as text, never markup or a link
  clientSelfRegistered: boolean;      // §19.3's "registered itself — identity unverified"
  redirectOrigin: string;             // the ORIGIN of redirect_uri, never the whole URI
  scopes: string[];
  namespace: string;                  // from `resource`
  agents: { slug: string; name: string }[];   // agent_list, unchanged
};
```

| Method, path | Replaces | Checks kept | Shapes |
|---|---|---|---|
| GET `/oauth/consent` → shell | GET `/oauth/consent` | owner session (302 carrying the whole signed query as `next=`); the prelogin signature check **before the document**, 400 text/plain on refusal as today | `#pmcp-bootstrap` |
| GET `/api/hub/oauth/consent?<signed>` **(new)** | `consentProps` | `reader` (owner session); **`consentProps` unchanged** over this request's own raw search — the client appends `location.search` verbatim and never parses, rebuilds or re-encodes it; the provider re-verifies the signature on every read | 200 `ConsentRead` / 400 `{ reason: "The authorization request could not be verified." }` |
| POST `/oauth/consent` **(kept, unchanged)** | — | `mutation`; provider `/oauth2/consent` before any write; agent scoped to the owner; `upsertBinding`'s own ownership check | the SPA renders `<form method="post" action="/oauth/consent">` with `csrf` = bootstrap, `oauth_query` = `ConsentRead.oauthQuery` (the bytes the provider just verified), `agent` `<select>` (defaulted to nothing, Allow disabled with no agents), `decision` = `deny` / `accept` |

**Binding, reviewed.** The read and the screen are bound to the signed request the same way the
render was: one request's raw query, the provider's signature check on it, and the posted
`oauth_query` is the value the read returned — not something the client assembled. The POST's
binding is untouched (the provider re-verifies `oauth_query` at `/oauth2/consent` before any
write). The read requires the owner's session and answers only `ConsentRead` — which is a
function of a query the caller already holds plus this owner's own `agent_list` — so it discloses
nothing the screen did not. `clientName` crosses as a JSON string (no HTML context); the shell's
`<title>` embeds it as JSX text (escaped), and the client renders it as a text node.

### Test rows

| Row | Fate |
|---|---|
| 2464 · GET without a session bounces carrying the signed query | **stays** |
| 2479 · the post-login target is the hub's own `/oauth2/authorize` | **ported**: `#pmcp-login`'s `redirectTo` instead of the HTML `callbackURL` |
| 2496, 2507, 2515 · name/scopes/namespace/picker; redirect origin; DCR marker | **ported** to `ConsentRead` fields; text rendering web-side |
| 2525 · a client name containing markup is text | **ported**: the read carries the raw string; the shell HTML (its `<title>`) never contains it raw; the text-node rendering web-side |
| 2536 · zero agents: empty state, Allow disabled | **ported** (`agents: []`); the empty state and the disabled control web-side |
| 2556 · the form echoes `oauth_query` byte-for-byte | **ported**: `ConsentRead.oauthQuery` === the consent URL's raw query |
| 2566, 2589, 2607, 2627, 2660, 2672 · the POST rows | **stay** — only the `csrf` they scrape moves from the page's hidden field to `#pmcp-bootstrap` |
| 2694 · Revoke | family 2 |
| — | **new**: an edited or expired query → 400 at the document **and** at the read, nothing written; the read without a session 401; the read's key set is exactly `ConsentRead`'s |

**Smoke** (`smoke.ts:836-841`, `:942-945`): `csrf` from `#pmcp-bootstrap`, `oauth_query` from
`GET /api/hub/oauth/consent?<same query>`; the POSTs are unchanged.

---

## 5 · Login (family 5, last)

### Today

| Method, path | file:line | Checks | Reads | Writes / answers | Other callers |
|---|---|---|---|---|---|
| GET `/login` | web.ts:161 | **none** | `loginProps` (model.ts:2018): `loginStep` (`?step` or `?method`, `?error`, `?username`), `redirectTo` = `oauthRedirectTarget` (a `sig` + `client_id` on /login's own query → `/api/auth/oauth2/authorize` + the **raw** search) ?? `hubRelative(?next)` | 200 HTML; the passkey script's `LANDING` and each card's hidden `callbackURL` both = `redirectTo ?? /apps` | identity's `loginRedirect` (identity.ts:1008), the provider's `loginPage` (identity.ts:200), `/` with no session, sign-out's 303, the SPA's 401 handler (`http.ts:68`), the failure redirects below |
| POST `/login/sign-in/username`, `/login/two-factor/verify-totp`, `/login/two-factor/verify-backup-code` | web.ts:178-196 | `crossOrigin` (if-present-must-match) → 403 | form; `landingOf` = `hubRelative(callbackURL) ?? /apps` | better-auth via `callAuthResponse`; `auth.login` written **at the mount**; failure 303 `loginUrl({step, error: WRONG_*, username, next})`; success 303 landing or `/login?step=totp&next=`; Set-Cookie forwarded | login.tsx; smoke `:803` |
| POST `/login/sign-out` | web.ts:204 | `crossOrigin` | — | `/sign-out`; 303 `/login` + cleared cookie | layout.tsx only |
| passkey ceremony | login.tsx:215 | better-auth's own | — | `/api/auth/passkey/generate-authenticate-options`, `/verify-authentication`; then `location.assign(LANDING)` | — |

### Replacement

| Method, path | Replaces | Checks kept |
|---|---|---|
| GET `/login` → shell, **no gate**, no `#pmcp-bootstrap`, `#pmcp-login` = `LoginIsland` (escaped, §0.2), title from the step | GET `/login` | `loginProps` unchanged — the relative-only rule and §19.5's constant landing are computed on the server, once, and both consumers (the hidden `callbackURL`, the passkey landing) read the island |
| the three sign-in POSTs — **kept** (§0.4) | — | `crossOrigin`, `landingOf`/`hubRelative`, the two uniform sentences, Set-Cookie forwarding, the 303s |
| POST `/login/sign-out` — **kept**; the SPA Shell's Sign out posts **here** | — | `crossOrigin` |
| the passkey ceremony — unchanged endpoints; the landing is `LoginIsland.redirectTo ?? "/apps"` | — | better-auth's own |

**Reviewed.** The shell at `/login` holds nothing of a session: no `#pmcp-bootstrap`, so no
CSRF token or username reaches an unauthenticated document, and the island is a pure function
of the query the caller sent (plus §19.5's constant). The relative-only rule runs twice on the
server exactly as today — `loginProps` building the island, `landingOf` judging the posted
`callbackURL` — and never in the client; the passkey path, the one landing no server route
re-judges, navigates to the island's value. The island's untrusted strings (`error`,
`username`, `redirectTo`) are escaped per §0.2. The sign-in POSTs keep their origin rule and
SameSite defence unchanged, since they are the same routes.

What the client must honour: `/login` makes **no** `/api/hub` call (its 401 handler would send
`/login` to `/login?next=/login…`), draws no Shell (no pending-badge query), and every link on
it — "Use a backup code instead", "Back to sign in" — is a **document** navigation, so the
island is recomputed for the new query exactly as a GET recomputed the page. The shell is the
whole SPA bundle (the owner's accepted cost, decision 38).

**Deleted when this family ships:** nothing — all four POSTs are kept. `login.tsx` goes.

### Test rows

| Row | Fate |
|---|---|
| 1913, 1933, 1954 · 21–23. the three forms, form-encoded; a wrong password; the challenge forms | **stay** (routes kept); 22's "re-renders `/login` with its field error" reads `#pmcp-login`'s `step.error`, and "the password appears in neither" extends to the island |
| 2087 · a hostile hub-relative `?next=` is escaped in both embeds | **ported**: the shell HTML carries no raw `<` from the payload (and no raw U+2028) — the island escapes — and the posted arm stays |
| 2119, 2253 · absolute / scheme-relative / backslash / tab-CR-LF `?next=` → `/apps` in both consumers | **ported**: island `redirectTo === null` (the client's `?? "/apps"`) and the POST's `landingOf` |
| 2147, 2178 · a switch link carries the landing (and §19.5's authorize landing byte for byte) | **ported**: the switch hrefs are the client's (`loginUrl` port or the island), the round trip is island → link → island; the byte-for-byte leg asserts the second island's `redirectTo` equals the first's |
| 2214 · the three headers | **stays**, carriers extended (§0.1) |
| 2339 · 30. one `auth.login` row | **stays** |
| 866 · `/` with no session → `/login` | **stays** |
| 4035 · the passkey button names better-auth's endpoints in a script | web-side; the form-target half stays |
| 4773 · after a TOTP sign-in | **stays** |
| oauth-provider.test.ts rows (88-157) | **stay** (they assert `Location` contains `/login`) |

**Smoke** (`smoke.ts:642-661`, `:787-794`): read `callbackURL` as `#pmcp-login`'s
`redirectTo`, and assert the injected `?next=` payload's bytes appear nowhere raw in the shell.

---

## 6 · Files that go (brief §1.7), and when

Read literally, brief §1.7 retires the preview's **role** page by page (the gallery takes over
each page's states as it moves) and the **files** when the last page leaves. That is the
reading here: each family's handler stops rendering its template, but the templates stay
until family 5, because the states preview renders them and is the only way to re-shoot a
baseline that turns out bad mid-project.

| File | Goes with |
|---|---|
| `server/src/pages/{approvals,approval-detail,settings,device,consent}.tsx` | unreferenced by `web.ts` as each family ships; **deleted** with family 5 |
| `server/src/pages/login.tsx` (its `jsLiteral` moves to `spa.tsx` in family 1, the first island change), `layout.tsx` (also exports `OtpBoxes`, which `login.tsx` imports), `server/dev/preview.ts`, `server/dev/fixtures.ts`, `wrangler.preview.jsonc` | family 5 |
| `pages/model.ts`'s six props types, `PagePropsByName`, the view-only builders | family 5 (the preview types against them); the loaders' server halves (`consentProps`, `deviceStep`'s verify, `approvalDetailProps`' lookup, `settingsProps`' reads, `loginProps`) **stay** as the reads' implementations |
| `server/src/pages/styles.css` | **stays** until pass 2 |

If the orchestrator prefers dead templates gone per family instead, the preview's
`PAGES`/`fixtures` entries for that page go in the same change — a one-line call, and the
baselines are already on disk either way.

---

## 7 · Where the brief or the specs contradict the code

1. **The SPA's Sign out posts better-auth's mount directly, which the server says cannot work.**
   `web/src/chrome/Shell.tsx:141-148` renders `<form method="post" action="/api/auth/sign-out">`
   with no controls (`web/src/lib/paths.ts:83-85`: "answers with Set-Cookie and a redirect").
   `web.ts:198-211` and `model.ts:402-409` say a control-less form post to better-auth was
   answered **415** (verified live 2026-08-26), which is why `/login/sign-out` exists — and
   better-auth's `/sign-out` answers JSON, never a redirect. So on `/apps`, `/agents` and
   `/audit` today, Sign out most likely lands on a 415 or a JSON body. No row covers it: row 24
   walks server HTML only. Unverified live; the fix is `paths.signOut = "/login/sign-out"` in
   the client, and the replacement for row 24 (family 2) is exactly the walk that would have
   caught it. This is `spa-web`'s, and it lands in family 1 (the approvals page is the first
   migrated page to draw the Shell's form).
2. **"The audit rows the auth wrappers write" (brief §1.3).** The wrappers write none. §15's
   two auth events (`auth.login`, `auth.device_approved`) are written by `identity.authRoutes`
   **at the better-auth mount** (`identity.ts:1406-1429`), which every hub wrapper
   (`callAuthResponse` → `authRoutes().fetch`) and every direct browser call both pass
   through. They survive any rewiring of who calls better-auth; nothing needs porting.
3. *(The mount half is superseded 2026-09-23 by decision 39: better-auth's own credential endpoints now refuse a stale session at the mount — `server/test/worker/fresh-auth.test.ts`. The `/api/hub/settings/*` prefix stands.)* **"`/api/hub/*` … already carry the cookie session, the same-origin check and
   `X-Pmcp-Csrf`" (brief §4).** True for writes; no `/api/hub` route asks for **recent**
   authentication (`api.ts:198-200`), so nothing existing can serve `/settings`, and
   better-auth's own endpoints cannot either: `/two-factor/*`, `/passkey/delete-passkey`,
   `/revoke-session`, `/revoke-other-sessions` and `/change-password` enforce no freshness
   (`sessionMiddleware` / `sensitiveSessionMiddleware`; only `/list-sessions` and the passkey
   *register* endpoints use `freshSessionMiddleware`). Hence the `/api/hub/settings/*` prefix.
4. **Brief §1.6 — form endpoints go "unless something outside the web surface calls it".** The
   kept routes (§0.4) are kept for a different reason — their answer is a navigation — though
   the smoke does post two of them. Recorded so the rule is not read as "delete them".
5. **Memory: "States preview is a kept reference — `server/dev/preview.ts` + `fixtures.ts` stay
   for good".** The owner's 2026-09-23 brief retires both; the React gallery inherits the role
   (§16 amended). The memory is stale once family 5 ships.
6. `web/src/router.tsx:21-22`, `web/src/lib/format.ts:6`, `Shell.tsx:72-78`,
   `derive.ts:1391` and `spa.tsx:24-26` state that these pages are server-rendered — comments
   that become false family by family (the web agent's).

## 8 · Checks with no complete home

1. *(Superseded 2026-09-23 by decision 39: the owner ruled the mount guards it too — `server/test/worker/fresh-auth.test.ts`.)* ~~**Recent authentication on credential management is enforced only at the hub's own routes.**~~
   A day-old cookie can post JSON straight at `/api/auth/change-password` (and the other
   endpoints in §7.3) with an `Origin` header and succeed — row 3746 pins that as a known fact.
   The design keeps the browser's path gated (`/api/hub/settings/*`); it does not close the
   direct one. A closing fix lives at the mount (`authRoutes`), is a §4 decision, and is out of
   this project's scope.
2. **The consent POST calls the provider before it resolves the agent.** A POST whose `agent`
   names nothing in the namespace (hand-posted, or an agent deleted between the read and the
   click) is refused 400 **after** `/oauth2/consent` has accepted — so the provider holds a
   consent row with no `oauth_binding`, the next authorize skips the screen, and the minted
   token is refused at the door until the provider's consent is cleared. Resolving the agent
   before the provider call closes it; it changes a §19.5 ordering, so it is the owner's call
   and not part of pass 1 (the POST is kept byte-for-byte).
3. **`/device`'s confirm card offers Approve for codes this owner cannot decide.** better-auth's
   verify answers 200 for a code another user already claimed, or one already decided;
   `deviceStep` checks neither `status` nor claimancy, so the card renders (client "unknown")
   and Approve fails with "That code could not be decided." Kept exactly (the read answers what
   the card showed); flagged for a later §13 sentence.
4. **`?error=` on `/device` and `/login` renders any text a link supplies** (as today). Display
   only, text nodes, not a new surface; recorded so a reviewer does not rediscover it.
5. **No route-level row covers `POST /approvals/push`** today; the new JSON route gets its first
   (family 1).
