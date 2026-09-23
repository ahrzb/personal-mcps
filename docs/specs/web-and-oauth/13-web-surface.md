## 13. Web surface

*Amended 2026-09-02 — decision 30: `/settings` split into panes behind a left rail and
gained a **Password** pane (reversing, for the *change* half only, §4's "no self-serve
password change"); `/apps/<slug>` added as the app detail page behind the same rail;
`/oauth/connections` re-homed as the **Connected clients** pane of Settings. Everything
marked 2026-09-02 below is **spec ahead of code** — implemented as its own workflow, after
§21 (D14); a reader must not mistake it for shipped behavior.*

*Amended 2026-09-23 — decision 38: every page below is the SPA. `/login`, `/device`,
`/settings/*`, `/approvals`, `/approvals/<id>` and `/oauth/consent` move into the client in a
first pass that holds their look constant (gated by screenshots), then onto shadcn in a
second. Each page's section gains the routes that replace its handler; the route inventory
behind them is `docs/superpowers/plans/2026-09-23-everything-spa-routes.md`. Spec ahead of
code until each page family ships, in the order approvals → settings → device → consent →
login.*

Deliberately tiny — ~~server-rendered pages (Hono JSX)~~ browser pages *(2026-09-23, decision
38: all of them the SPA, one rendering)* only where a browser is required:

- `/login` — username + password, TOTP challenge, passkey button. Sign-in landing: a
  `?next=` deep link is honoured only when it is hub-relative; anything else — absolute,
  scheme-relative, or the `/\` spelling a browser folds into `//` — lands on `/apps`.
  *(2026-09-23, decision 38:)* `GET /login` answers the SPA shell with **no session gate**
  and **no** `#pmcp-bootstrap` — nothing of a session exists yet to put in one. What it
  carries instead is a `<script type="application/json" id="pmcp-login">` holding the page's
  whole server-computed state, `{ step, redirectTo }`: the card to draw (with the error and
  the echoed username a refused attempt left on the query) and the landing, computed by the
  one relative-only rule (and §19.5 step 1's constant OAuth landing) **on the server**. Both
  of the landing's consumers — the cards' hidden `callbackURL` and the passkey ceremony's
  post-verify navigation — read that one value, so the rule is never spelled in the client.
  The three sign-in forms and Sign out **stay real form posts** to the hub's translation
  routes (`/login/sign-in/username`, `/login/two-factor/verify-totp`,
  `/login/two-factor/verify-backup-code`, `/login/sign-out`), which the client renders: each
  answers a 303 that carries better-auth's `Set-Cookie`, the landing it judges again with the
  same rule, and §19.5's authorize chain ending at a third-party redirect — a navigation no
  `fetch` can perform. The shell's **Sign out**, on every page, posts `/login/sign-out` —
  never better-auth's own `/api/auth/sign-out`, which refuses a control-less form post and
  answers JSON rather than a redirect. Every link on the page is a document navigation, so
  the island is recomputed for each query, and the page calls no `/api/hub` route.
- `/device` — device-approval page (user enters the code the CLI printed). Since we
  hand-build it anyway: it shows the requesting IP and user-agent and states plainly
  that approval grants **full admin CLI control of the namespace** (RFC 8628 §5.4 /
  cross-device-flow BCP: the user-code channel is unauthenticated, so the page is the
  phishing defense); the approval POST carries a CSRF token; device-code lifetime is
  set to ~10 minutes (down from better-auth's 30-minute default).
  *(2026-09-23, decision 38:)* the shell behind the ordinary owner session. The code's
  details come from `GET /api/hub/device?user_code=<code>`, which makes the **same**
  better-auth verify call the page made, with the owner's cookie — so the first signed-in
  viewer still claims a pending code exactly as rendering the page did — and answers
  `{ request: { userCode, ip, client, requestedAt, expiresAt } }`, the confirm card's five
  facts and nothing else, or a `404` carrying "That code is not valid. Check it and try
  again.". The verdict is `POST /api/hub/device/decide` `{ userCode, decision: "approve" |
  "deny" }` through the write gate (session, origin, `X-Pmcp-Csrf`) into better-auth's own
  approve/deny, answering `{ next, reload: false }` — `/device?decided=approved|denied`, or
  `/device?error=…`, the URL the form's 303 named (the answer shape is under *The SPA's
  server surface* below). `?decided=`, `?error=` and an absent
  `user_code` stay URL state the client reads.
- `/settings` — sign-in and access for the owner, now seven panes behind the existing
  framed-workspace rail. Every route/POST under the prefix requires a recent
  cookie-authenticated owner session; bearer sessions are rejected.
  *(2026-09-23, decision 38:)* the seven pane URLs answer the shell behind that same prefix
  gate, and **`/api/hub/settings/*` is the same rule on the JSON side** — one prefix
  middleware resolving every read and write under it with recent authentication, so neither
  surface can grow an ungated route. The panes read `GET /api/hub/settings` — ONE read for the
  rail and every pane, as the shell rule below demands: `{ twoFactor, passkeys, sessions,
  tokens, connections, execution, limits }`, where `limits` carries the password minimum and
  the timeout bounds so the page prints configured numbers rather than second literals, and
  `sessions` never carries a session token. Every form target `/settings/X` becomes
  `POST /api/hub/settings/X`, JSON in: the eight credential routes, `tokens/token_revoke`,
  `clients/connection_revoke` and `execution/hub_settings_update` — the two ops-backed panes
  name their one op each, and no generic dispatcher survives under `/settings`. A write whose
  form answered a 303 answers `{ next, reload }`: `next` is the URL the 303 named, flash
  included, still built on the server and still landing on the pane that drew the control;
  `reload` says better-auth replaced the session (and with it the CSRF token the document
  holds), so the client loads `next` as a document. Query-derived state — the pane, `?kind=`,
  `?confirm=`, the flash, `?field=` — is the client's, read from its own URL.

  | Group | Pane | Route | Rail marker |
  |---|---|---|---|
  | Sign-in | Password | `/settings` (landing) | none |
  | Sign-in | Two-factor | `/settings/two-factor` | status dot |
  | Sign-in | Passkeys | `/settings/passkeys` | count |
  | Access | Sessions | `/settings/sessions` | count |
  | Access | Tokens | `/settings/tokens` | count |
  | Access | Connected clients | `/settings/clients` | count |
  | Runtime | Execution | `/settings/execution` | default/max seconds |

  The rail order is the sign-in order — password, second factor, passkey — then the
  holdings that let something *in*; Password lands because `/settings` should never open
  on something the rail does not list first. Mobile pills shorten only the last label, to
  `Clients`.

  - **Password** — new functionality, not a re-render (§4 amended): *current password*,
    *new password*, *confirm new password*, a **Sign out my other sessions** checkbox
    (default **on** — a password is most often changed on suspicion, and the safe default
    ends every session the old one may have opened), and **Update password**. It rides
    core better-auth's `POST /change-password` (`{ currentPassword, newPassword,
    revokeOtherSessions }`, verified against `better-auth@1.7.1` — no plugin) through the
    same hub ~~translation route every credential form uses~~ route every credential write
    uses *(2026-09-23, decision 38: `POST /api/hub/settings/change-password`, JSON in)*, gated
    like every other credential POST — session, **recent authentication**, CSRF. That gate is load-bearing,
    not belt-and-braces: in 1.7.1 `/change-password` sits behind
    `sensitiveSessionMiddleware`, which proves an authoritative session and nothing about
    its age (`freshSessionMiddleware` is the one that reads `freshAge`, and this endpoint
    does not use it), so the hub's own recent-auth check is ~~the only freshness check the
    change has~~ the check the change depends on *(2026-09-23, decision 39: no longer the only
    one — better-auth's mount now refuses a stale session at `/change-password` as well, with
    the same window)*. Pinned:
    - **Change is not reset.** This pane needs the current password. A *forgotten*
      password is recovered only by `pnpm users reset-password <username>` (§12), and the
      pane says so in its own footer, verbatim: "No email is on file, so there is no reset
      link: a forgotten password is recovered on the server with `pnpm users
      reset-password <username>` (§12). Changing it here needs the current one." The
      reason is structural, not an omission: the `username()` plugin synthesizes a
      placeholder email (§4, decision 5) that is delivered to nowhere, so no reset link
      can be sent and no self-serve reset can exist without first putting a real address
      on file — a different decision, not taken.
    - **Length**: `minPasswordLength` is **12** (§4; better-auth's default is 8, its
      `maxPasswordLength` default of 128 stands), and the field hint "At least 12
      characters." renders from that one constant — never a second literal. Better-auth
      enforces it (`PASSWORD_TOO_SHORT`); the hub does not pre-check, so the two can never
      disagree.
    - **Refusals, mapped to fields**: `INVALID_PASSWORD` → "That password is not right."
      on the current-password field; `PASSWORD_TOO_SHORT` → the length hint, on the new
      password; new ≠ confirm → "The two entries do not match." on the confirmation — the
      one check the hub makes itself, before calling, because better-auth has no confirm
      field. Anything else is the ordinary refusal notice. On any refusal nothing changes
      and no session is touched.
    - **Success copy**: "Password updated." — plus, when the box was ticked, "N other
      session(s) were signed out — this one stays.", and always "App and agent tokens keep
      working: they do not derive from the password." (true by construction: `pmcp_app_` /
      `pmcp_agt_` keys are random secrets in the hub's own table, §4/§5; nothing hashes the
      password into them).
    - **What `revokeOtherSessions` really does**, pinned because the checkbox's label is
      gentler than the mechanism: better-auth deletes **every** session of the user — the
      current browser session and every CLI device-flow session included — then mints a
      fresh session and sets its cookie on the response. "This one stays" is therefore
      true from the owner's chair and false at the row level: the session id changes, the
      cookie is replaced in the same response, the Sessions pane afterwards shows one
      session created just now, and the recent-authentication window restarts. Two
      consequences follow and the copy hides neither: every CLI session is among the
      "others" (`pmcp login` again), and the ~~translation~~ hub route **must** forward
      better-auth's `Set-Cookie` to the browser exactly as it does for sign-in — dropping
      it signs the owner out *(2026-09-23: on its JSON answer, which then says `reload`, since
      the CSRF token the document holds died with the old session)*. `N` is counted by the hub from `/list-sessions` immediately
      before the call (all sessions minus the current one); better-auth returns no count.
    - The pane shows when the session was last confirmed ("Confirmed your identity N
      minutes ago." — the session's `createdAt`, the same value the gate reads), so the
      owner can see why a stale one is bounced.
  - **Two-factor** — unchanged in substance: not enrolled → **Enable two-factor**
    (password-confirmed; the answer renders the setup card in place at 200 — the secret
    and the codes never ride a URL); TOTP setup (QR plus the grouped secret for manual
    entry, a 6-digit verify posted to the pane's own `/settings/two-factor/verify-totp`
    — a refused code redraws the same enrolment in place with the error under the boxes,
    a verified one lands on the enabled arm) *(2026-09-23, decision 38: Enable answers
    `{ enrollment, backupCodes }` in its JSON body — the QR still drawn on the server, the
    secret and codes still in a body and never a URL; the verify posts `{ code }` alone and a
    refusal answers `422` with better-auth's words, the client redrawing the enrolment it
    already holds, so the secret and the codes are no longer posted back in hidden fields for
    the server to re-validate; a verified code answers `{ next, reload: true }`)*; the backup codes revealed exactly once after
    enabling or regenerating; enabled → **Regenerate backup codes**, **Disable
    two-factor** (confirm dialog). ~~The rail dot is the one marker that is a status, not a
    count.~~ *(2026-09-17, decision 32: the second is the app page's Recording dot, which
    borrows this one's markup — lit for body logging on, with the same `sr-only` word
    beside it.)*
  - **Passkeys** — unchanged in substance: one row per passkey (name as the authenticator
    reported it, added, last used), **Remove** (confirm dialog), **Add passkey** (a
    WebAuthn ceremony on better-auth's own mount — the one credential POST that is not a
    form). Empty state: "No passkeys yet. Add one to sign in without a password."
  - **Sessions** — every web and CLI session (`Client` / `Created` / `Last active`; a
    browser row reads "Chrome on Windows"-style, picked from the User-Agent the sign-in
    carried and never trusted further, "Unknown client" when it carried none; CLI
    rows read "pmcp CLI · device flow"; the rendering session is badged *current* and is
    never revocable from its own row), **Revoke** per row (confirm dialog), and **Revoke
    all others** (confirm dialog), which rides better-auth's `/revoke-other-sessions`.
    That endpoint deletes every *other* unexpired session and leaves the current one
    untouched — the opposite contract from the Password pane's flag, which replaces the
    current session; recorded so nobody "unifies" them.
  - **Tokens** — every key issued in the namespace, `token_list` unchanged (§8): `Token`
    (the display prefix) / `Kind` / `Bound to` / `Created` / `Expires` / `Last used`,
    under an **All · Agents · Apps** filter (`?kind=agent|app`). Live rows get
    **Revoke**, expired rows **Remove** — both `token_revoke`; revoked rows are not listed
    (nothing left to act on). Bound-to app slugs link to `/apps/<slug>`; agent slugs are
    links to `/agents/<slug>` once that page lands (specced 2026-09-03; text until
    then). **No Issue control**: until the agents
    page exists the intro reads "Issue new keys from an app page, or with `pmcp token
    issue` for an agent." *(amended 2026-09-03: the earlier "from an app or agent page"
    named a page with no route)*; once it lands, "Issue new keys from an app or agent
    page." — issuing stays where the thing being issued for lives
    (`/apps/<slug>/token`; for agents, `pmcp token issue` until the deferred agents page
    exists). Footer, verbatim: "Revoking an app token closes that app's live connection.
    Keys are shown only once, at issue time."
  - **Connected clients** — §19.6's connections list, re-homed here from
    `/oauth/connections` (`connection_list` / `connection_revoke` are still its only read
    and write — "unchanged" means the tool names and the parity, not the row shape: §8's
    2026-09-02 amendment adds `redirectOrigin` and `selfRegistered` and keeps revoked
    rows, with `revokedAt`, so the pane's `revoked` status has no second read path):
    `Client` (name — or id when it registered without one — with the origin of its
    registered redirect URI beneath, and the "unverified" marker beside a self-registered
    client: the same two identity strings §19.5's consent screen shows, for the same
    reason) / `Acts as` (the bound agent's slug, linking to `/agents/<slug>` once that page
    lands — specced 2026-09-03, text until then) /
    `Created` / `Last used` / `Status` (`active` | `revoked`). **Revoke** on active rows
    (confirm dialog); a revoked row stays listed with no control, because re-consent
    revives the same row (§19.4's `UNIQUE (owner_id, client_id)`) and the list therefore
    never holds more than one row per client. Footer, verbatim: "A client registers
    itself the first time you approve it on the consent screen — that screen is a step
    inside the sign-in redirect, never a page you navigate to. Revoking stops its tokens
    working; the agent it acted as, and that agent's grants, are untouched."
    **Why here**: Sessions, Tokens and Connected clients are one family — everything
    holding a live way in, each with a Revoke — distinguished by *who* holds it: Sessions
    is the owner signing in (principal `user:<name>`, full owner authority), Tokens is the
    owner's own apps and agents, Connected clients is outside software acting **as an
    agent** (principal `agent:<slug>`, confined to that agent's grants through
    `oauth_binding.agent_id`, §19). **Route**: the pane is `/settings/clients`, and
    `/oauth/connections` answers a `301` to it (GET; the POST moves with the pane under
    the final-segment convention, and no page ever posted to the old one). Keeping the
    list at `/oauth/connections` and merely shelling it into the rail was an acceptable
    alternative — the fix is the nav slot, not the path — and lost on three counts: every
    other pane is `/settings/<pane>`, so the rail's active state and §4's gate are one
    prefix rule with no exception to carry; the `oauth` segment is the authorization
    *server's* (consent and the provider's endpoints), and a list of what the owner holds
    belongs with the other holdings; and the redirect costs one route. When the deferred
    `/agents/<slug>` page lands it carries a **read-only** Connected clients row — the
    clients bound to that agent, each linking to this pane — and never a second Revoke:
    revoking lives with the other credentials.
  - **Execution** *(added 2026-09-18, §23)* — two integer millisecond fields,
    default and maximum, with `1,000 <= default <= max <= 300,000`, one Save action,
    CSRF, and the existing `hub_settings_get`/`hub_settings_update` operation path.
    Invalid pairs redraw ~~at 400~~ with field-linked messages; success reads back the
    committed pair. *(2026-09-23, decision 38: the refusal is a `422` carrying the op's
    field-scoped violations, and the client redraws — the owner's own text kept, each sentence
    under the control it names. The two controls still post the owner's text, and the server
    still turns a clean integer into a number and leaves anything else for the op to refuse
    in its own words.)* Copy states that settings are owner-wide, new executions snapshot
    them at admission, and updating them never extends an active run.
- `/audit` — read-only, cookie-session-gated view over the audit table (§5): ~~a plain
  server-rendered table, newest first, with the same filters as `audit_query`
  (agent, app, event, tool, time range) and offset/limit paging backed by
  `audit_query`'s `total` (desktop shows numbered pages, mobile a "Load more" that
  accumulates offsets — one contract, two presentations). The four tiles and the chart
  are computed over the newest 1,000 matching rows while the Events count is exact; past
  that ceiling the per-row tiles and the chart say "over the newest 1,000", and the three
  filter selects likewise list only what the newest 1,000 rows of the namespace mention
  *(2026-09-03, step 13: G22)*.~~ **the explorer below**

  *(2026-09-21, decision 36 — `design/concepts/AuditDemo.html`, adopted whole: the table
  is an **explorer**, and the page is the SPA's **third route family** rather than a
  server-rendered page. What the struck sentences promised is gone with the page that
  served them: numbered pages and accumulated `offset`s — the window is loaded once and
  read client-side, and `?limit=` / `?offset=` are ignored; the four tiles and the chart
  over the newest 1,000 — Summary's own tiles are computed over the loaded window and the
  lane strip replaces the chart; and the three filter selects read from that same scan —
  the facet rail reads the loaded rows and carries live counts instead. `?expand=` is no
  longer an in-page `<details>` opened by a small inline script but the id of the record
  the drawer shows, whose bodies are fetched for that one row. What survives verbatim
  below, because it is about what the ledger holds rather than how a page draws it: the
  typed size placeholders, the three no-bodies sentences, the JSONL export, and "no
  mutations, so no CSRF surface".)*

  **Shape** *(2026-09-21)*: the ladder's **workspace** (*Where the numbers live* below) —
  the facet rail at the ladder's rail width as its own card, the main pane the rest; the
  numbers are `design/layout-and-density.md`'s, where `Audit` moves from the table row to
  the workspace row of the shape table. The shell's Audit nav entry becomes a router link,
  like Apps and Agents.

  **Three views over one filtered set** — **Summary**, **Sessions** and **Events** are
  three readings of the *same* rows under the same window, facets and search, chosen by
  `view=` and nothing else: switching a view never refetches and never changes what
  matches.

  **One state, in the URL.** `view=summary|sessions|events` (absent ≡ `summary`), `since`
  and `until` (epoch ms — the brush), repeated `principal` / `app` / `event` / `tool` /
  `outcome` / `session`, `q` (the search text, sent to the server as `text`),
  `expand=<id>` (the open record) and `open=<sessionId>` (the open session in Sessions).
  Every key is a string or repeated strings, the SPA router's contract. A `tool` value is
  spelled `<app>/<tool>` on the page — the facet names a tool by its app — and travels
  **whole** to the export as repeated `target=` *(2026-09-21, from review: never split into
  `app=` + `tool=` lists, for the reason the Export paragraph gives)*; a legacy `?tool=<name>`
  with no `/` still filters the page, by tool name alone. An `outcome` value is one of the
  five classes below, which the export link expands to its raw codes.

  **Outcome classes**, five over the six recorded `outcome` values (§5): `ok` ← `ok`;
  `approval` ← `-32003`; `archived` ← `-32002`; `denied` ← `-32001` and `-32000`; `error`
  ← `error`. Each has one colour, and the **class name is always printed beside the
  colour** — on a chip, in the legend, in a record's head — so no state is ever carried by
  colour alone. A class is the page's grouping and nothing below it: `audit_query`'s own
  `outcome` filter takes the **raw** recorded value (§8), and the record's field table shows
  that raw code beside the class.

  **A code never stands alone** *(owner, 2026-09-21: "I literally won't know what -32001 is,
  it's not like 404")*. Every recorded outcome has a **label** — the hub's own §7 words for it
  — and, for the four refusals and `error`, one **sentence**. Both are pinned copy, and both
  live once, beside the class derivation:

  | Outcome | Label | Sentence (the record, under the outcome row) |
  |---|---|---|
  | `ok` | ok | — |
  | `-32003` | approval required | This tool needs your approval for this agent. The call was held, not run — it waits on, or was settled in, Approvals. |
  | `-32002` | app archived | The app is archived, so the hub dispatches nothing to it. |
  | `-32001` | not permitted | The hub refused this call: the agent holds no grant that reaches this tool, or it named an app or tool the hub doesn't know. The hub answers every such case the same way, so the ledger cannot say which. |
  | `-32000` | app unavailable | The app could not be reached or did not answer in time. |
  | `error` | error | The call was dispatched and the app answered with an error. |

  A `-32000` carrying a `detail.failureClass` appends "Cause: <failureClass>." to its
  sentence. An outcome the table does not know is labelled by its **raw value** and gets no
  sentence — a vocabulary the page has not met is reported, never guessed at. ~~The `-32001`
  sentence names the two sources an owner can act on and then closes on *every such case*
  deliberately: §7 has a **third** — a tool for which no sound redaction map can be derived
  refuses with the same code — and listing it would hand a probing reader the map of the
  refusal that §7 withholds by construction, while a sentence claiming there are two would be
  false.~~

  **A `-32001` says which cause fired** *(2026-09-21, decision 37, owner: "can the codes come
  with some actual description")*. The struck paragraph was written while the ledger recorded
  no cause; it now records one, `detail.reason` (§15's nine closed classes), and the row's
  sentence becomes `The hub refused this call. <reason sentence> The caller was told only
  "not permitted" — every cause gets the same answer.` — a **full stop** after *call*, not a
  colon, because each reason sentence below starts with a capital and is a sentence of its
  own. The nine sentences and the **short
  words** the list rows use are pinned copy:

  | `reason` | Short words | Sentence |
  |---|---|---|
  | `no_app` | no such app | The name leads to no app this caller can see — a typo, a deleted app, or a prefix that matches nothing. |
  | `app_changed` | app changed mid-program | The name now points at a different app than when the program that made this call started. |
  | `no_grant` | no grant reaches it | The app exists, but no grant this caller holds reaches this tool. |
  | `not_in_catalog` | not in the app's catalog | The app's catalog has nothing by this name — a wrong name, or an app that has not re-registered since it gained it. |
  | `unsound_schema` | schema can't be masked | The tool's schema cannot be masked safely, so the hub will not run it; the violation was reported to the app when it registered. |
  | `credential_lapsed` | credential lapsed mid-program | The credential was revoked, expired or rebound while the program that made this call was still running. |
  | `op_withheld` | op withheld from this credential | This kind of credential may not run this admin op. |
  | `not_decidable` | nothing to decide | There is no pending approval request here for this credential to decide. |
  | `wrong_endpoint` | wrong endpoint for this credential | This credential is not admitted at this endpoint. |

  Two fallbacks, both saying what is true rather than guessing. A row carrying **no**
  `detail.reason` — everything recorded before this shipped — keeps the table's original
  `-32001` sentence with its closing clause replaced, so that it ends "…rows recorded before
  2026-09-21 do not say which." rather than claiming the ledger never can. A `reason`
  the page does not know prints as its **raw token**, `Recorded cause: <token>.` Through all
  of it the label stays **not permitted** and the class stays **denied**: a cause is a fact
  about the refusal, not a sixth outcome. And the page gains **no facet, no filter and no URL
  key** for it — `text` already searches `detail` server-side (§8), so typing `no_grant` finds
  those rows, and a Cause group in the rail waits for the owner to start filtering by one.

  **Where each shows.** The **record**'s outcome row reads chip · label · dim raw code
  (`denied` · not permitted · `-32001`) with the sentence on the line beneath it, as a note,
  and **a word is never printed twice**: the label shows only when it differs from the chip's
  class name, and the raw code only when it differs from the label — so `ok` is the chip
  alone, `error` the chip alone over its sentence, and a refusal all three. The row is
  **top-aligned**: its key lines up with the chip line and the sentence hangs beneath in the
  value column. That row is the **one place the raw code is printed**, because it is the value
  `pmcp audit --outcome` and the export take (§8). The strip's **legend** drops the codes for
  words — `ok`, `approval required`, `app archived`, `denied — not permitted or unavailable`,
  `error` — keeping the class names alone at narrow. A **waterfall** line's right-hand text is
  the label, with the `failureClass` after it when the row carries one (`app unavailable ·
  timeout`), never `class · code`. Row chips and the facet rail keep the short class names.

  **Titles** *(2026-09-21, from the boards)*: an event row, a waterfall line, a record's head
  and a chain timeline's line are titled `<app>/<tool>` **only for the three call events** —
  `tools/call`, `prompts/get`, `resources/read` (§15/§20.4's audited reads). Every other
  event is titled by its **event name**, with `<app>/<tool>` as dim secondary text when the
  row carries them. The reason is that §5 lets an `approval.*` row name an app and a tool,
  and such a row must never read as a call: in a session's waterfall the refused call and
  its `approval.requested` would otherwise be two identical lines. **One exception**: an
  Events **chain row** is the story of a call, so it is titled by that call's `<app>/<tool>`
  whichever row heads it — while the record it opens is still the head row's and is titled by
  the rule above, so a chain row `home/set_scene · 2 events` opens a record headed
  `approval.requested home/set_scene`.

  **Loading.** One read per `(since, until, q)` fetches the **whole retention window** of
  **slim** rows (no bodies; `argsHead` and `hasResult` instead — §8's `audit_query
  { bodies: false }`), a page at a time up to the ceiling, and the facets, the brush, the
  views, the merging and the sessions are all computed over those loaded rows: a facet
  click, a view switch and a brush drag never fetch. `since`/`until` in the URL are the
  **brush**, applied client-side; `q` is debounced and is the one control that refetches.
  **A search never unmounts the page** *(2026-09-21, postmortem
  `docs/superpowers/postmortems/2026-09-21-audit-search-unmounts-the-page.md`)*: while the
  read for a new text is in flight the previous rows stay on screen, the explorer and its
  input stay mounted with focus and caret intact, the box owns its text locally and shows
  "Searching…" until the answer lands, and **only the first load draws the skeleton**; a
  search that fails keeps the previous rows and says so inline, with **Try again**. The reason
  is structural, not a nicety: the text is part of the read's key, so every settled keystroke
  makes that read pending, and a page that renders "pending" as a different subtree throws
  away the very box being typed into.
  Past the ceiling the page says so rather than lying by omission — the notice, pinned as a
  **template** and not as a literal: "Showing the newest <ceiling> of <total> events — narrow
  the search, or export JSONL for all of them.", which at today's constant renders as
  "Showing the newest 5,000 of N events — narrow the search, or export JSONL for all of
  them." **Both numbers are formatted at render**, the first from the window read's echoed
  `ceiling` and the second from its `total`, so the sentence carries no second literal of the
  constant below — the rule the Password pane's "At least 12 characters." already follows.
  Every lane cell older than the oldest loaded row draws as **not loaded**, never as empty.
  Three constants carry the numbers (`limits.ts`): `AUDIT_EXPLORER_ROWS` (**5,000** — the
  most slim rows one window loads, and what the window read echoes as its `ceiling`),
  `AUDIT_EXPLORER_PAGE` (**1,000** — one request's worth) and `AUDIT_ARGS_HEAD_CHARS`
  (**160** — `argsHead`'s length).

  **Header**: "Audit log", the subtitle "N events · <from> → <to> UTC · kept for N days"
  (the last from the retention window, §15), **Export JSONL** (a plain link carrying the
  current selection) and the view segment.

  **Lane strip**: one lane per principal present in the loaded rows — at most six, busiest
  first, the rest folded into a last lane "N others" — and one cell per hour of the
  retention window, each cell the **worst** outcome class in that hour under the current
  facets and search. The brush does not dim the strip; it is drawn on it. Dragging selects
  a window of at least an hour, the presets **1h · 24h · 7d** sit beside the title (the
  last labelled from the retention window) and **Whole window** clears the brush — the demo's
  label read "Whole week", and retention is a knob (§15), so this control may no more name a
  week than the preset beside it may. A legend names the five classes **in words, never in
  codes** — the legend strings of *A code never stands alone* above, with the class names
  alone at narrow *(2026-09-21)*. The strip
  is focusable, ←/→ move the brush by an hour and Shift+←/→ resize it.

  **Facet rail**: the groups `outcome`, `principal`, `app`, `tool`, `event`, each value a
  toggle carrying its count **under every other filter but its own group's** (so a group's
  own values never zero each other out as they are ticked) and a proportional bar, the top
  few with **Show all N** expanding the group in place. Several values in one group **OR**;
  groups **AND**. `session` is never listed — it is set from a record. Active filters
  repeat as removable chips above the main pane, beside the search box ("Search events and
  bodies…", `/` focuses it) and **Clear**.

  **Summary**: three tiles (events · tool calls; refused or waiting on you; median call ·
  p95); **Worth a look**, three hand-written rules each with a **show me** that applies the
  filters it names — the worst (principal, target) pair of refusals when it exceeds five,
  tools first seen in the last two days of the loaded window, and changes to the setup
  (`admin.*`, `upstream.*`); top-N bars for Agents, Apps and Tools; Refusals; Changes you
  made *(2026-09-21, from review: the newest five, newest first)*; and the foot "All N events
  →". Two rules on the rules themselves *(2026-09-21, from review)*: the **first-seen rule is
  suppressed on a partial load** — when `total > ceiling`, or when a search text is active,
  the loaded rows are not the whole retention window, so "called for the first time" is not
  something the page knows; on a day and a half of loaded rows every tool would look new, and
  an insight that is wrong is worse than an insight that is absent. And the **changes rule's
  show me applies every distinct change event** it counted, as one OR-ed group, so "10
  changes to your setup" opens a list of ten and not one event name's worth. ~~The ledger
  records no *reason* for a refusal (§15),
  so the first rule's sentence ends at the outcome class: "**agent:cron was refused 214
  times** calling `news/get_news` — denied."~~ *(2026-09-21, decision 37: the ledger records
  one now. **Refusals** groups by (principal, app/tool, **cause**) — two causes on one pair
  are two lines, since "refused 214 times" reads as one problem and is often two — and each
  line ends in the reason's short words. The "worth a look" refusal insight names the cause
  when its group has one, so the sentence reads "**agent:cron was refused 214 times** calling
  `news/get_news` — no grant reaches it."; a group with no recorded cause, or a mix of them,
  ends at the outcome class exactly as the struck sentence did.)*

  **Sessions**: one row per `client.sessionId` (§5's `client_session_id`), rows without one
  grouped under "<principal> · no session", newest first, forty at a time behind **Load
  more**. Opening one draws the salience waterfall: a run of more than two `ok`
  `tools/call` rows folds to "N ok calls — apps", and everything else keeps its own line
  and opens its record. A line's right-hand text is the outcome's **label**, plus ~~its
  `failureClass` when it carries one~~ **its recorded cause when it has one, in the same words
  the Events list uses** — the reason's short words on a `-32001`, the humanized
  `failureClass` on a `-32000`, and "upstream status 502" for a numeric `upstreamStatus`
  *(2026-09-21, decision 37, and the `upstream_status` clause with it)* — never a class and a
  code
  *(2026-09-21 — *A code never stands alone* above)*.

  **Events**: merged rows, newest first, a hundred and twenty at a time behind **Load
  more**. Rows sharing a `detail.approvalId` (§15) are **one chain row**, headed by the
  `approval.requested` row or else the earliest, its members ordered by **(ts, id)**
  *(2026-09-21: the pair, not `ts` alone — the hub writes `approval.requested` inside the
  approval check (§7 step 2) and the gateway records the refused `tools/call` row only after
  the refusal is thrown, so the request always has the lower id at the same or an earlier
  millisecond, and a chain would otherwise be free to open on the refusal)*; carrying the
  chain sentence ("asked for approval → you approved 18:00 → ran ok 1.2 s" — **the refused
  call is the ask**, never a step of its own, so a chain of a refusal, a decision and a
  dispatch reads as three clauses and not four) and the state of its last event.
  **WHEN is the time the row sorts by** *(2026-09-21, orchestrator review of the boards
  against the built page — a consequence of the newest-first ordering, not an owner ruling)*:
  a chain row sits where its **newest** event sits and shows that event's time, in the
  desktop's When column and on the phone card alike, while the **head** still titles the row
  and is the record the row opens. Printing the head's time — `approval.requested`, a chain's
  oldest event — made a newest-first list read shuffled, "07:47" standing above "08:07". A ×N
  run row already shows its newest member's time, and this makes the two kinds of merged row
  agree.
  Consecutive un-chained rows with the same (event, app, tool, principal, outcome,
  ~~`detail.failureClass`~~ **the recorded cause** *(2026-09-21, decision 37: one field,
  whichever the outcome names — `detail.failureClass` on a `-32000`, `detail.reason` on a
  `-32001` — because two refusals with different causes are two different facts and must not
  collapse into one run)*, **`argsHead`** *(2026-09-21, same postmortem: a seventh field,
  because a run is the **same call repeated** — without the arguments preview in the
  signature, five calls with five different queries collapsed under the newest one's preview
  and the row claimed one thing had happened five times)*) collapse to **×N runs**, and a
  chain never joins a run. **A run row is a disclosure** *(2026-09-21)*: the ×N badge is a
  button, the line "N identical events · <first> → <last>" sits beneath the title, and
  expanded the row lists its members newest first — time, duration, outcome chip — each
  opening its **own** record and its own bodies, fifty at a time behind **Show more**, with
  **Hide** to collapse; the run's title still opens the newest member. Which runs are open is
  reading position, not URL state, so it is the one thing on this page the URL does not carry.
  The known ceiling, stated rather than hidden: `argsHead` is only the first
  `AUDIT_ARGS_HEAD_CHARS` characters of the stored arguments, so two calls differing only past
  that still collapse into one run — and opening it shows the difference on the members' own
  records. The third
  line previews `argsHead` clipped (an oversize stub's head renders as its placeholder),
  else the first three `detail` pairs — **except where the row has a recorded cause, which it
  prints in words**: the reason's short words on a `-32001`, and on a `-32000` its
  `failureClass` **humanized**, underscores to spaces ("needs reconnect", never
  `failureClass=needs_reconnect`), because one list must not mix words with raw pairs
  *(2026-09-21, decision 37; every other `detail` pair is unchanged)*. **One `failureClass`
  carries a number** *(2026-09-21, from the web agent's review of its own phone shot, which
  read "upstream status upstreamStatus=502")*: when the class is `upstream_status` and
  `detail.upstreamStatus` is a number, the cause words are "upstream status 502" and the
  `upstreamStatus=` pair is **not printed again** on the same line — the words already say it,
  and the record's Detail tree still shows both fields for anyone who wants them. A
  non-numeric `upstreamStatus` falls back to the plain humanized words **plus** its pair,
  because a value the page cannot read is reported rather than folded into prose. The foot:
  "N rows from M events — related events merged, repeats collapsed."

  **The record** (`?expand=<id>`) — a right-hand drawer over a scrim at wide, a full-screen
  level on the phone, and a real dialog primitive (focus trap, Escape) rather than a
  hand-rolled one. Head: the outcome swatch, the title, the time, Close. Body: **Search
  this record…**, which highlights matches in the trees and **opens every ancestor of a
  match**, so a match is never hidden behind a collapsed node, and says "No matches in this
  record." when there are none *(2026-09-21, from review)*; the **Record** field table (when,
  principal, event, app, tool, outcome — the one row that prints a **raw** code, as chip ·
  label · dim code with its sentence beneath *(2026-09-21 — *A code never stands alone*
  above)* — duration, client, session, id)
  in which **every id is a button that filters by it and closes the drawer** — the session
  id among them, which is what the `?session=…` link struck below became; then **Arguments** /
  **Result** / **Detail** as collapsible JSON trees with their first ~~level~~ **two levels**
  open *(2026-09-21, from review: a `‹redacted›` leaf or a blob stub inside `content` has to be
  visible the moment the record opens — showing what was sent is the record's whole purpose —
  and a body is capped (§15), so the second level costs nothing to draw)*; the three no-bodies
  sentences below; a chain record's sibling events as a short timeline whose lines open
  their own records; and **Show this session** / **Copy as JSON**. The field table draws
  from the slim row already loaded and the bodies arrive from the page's own one-row read
  when the drawer opens, the body sections showing a skeleton until they do; a record id
  outside the loaded window still opens, the one-row read not needing the window.
  ~~The expanded row detail~~ **That record** *(2026-09-21: the same facts about the ledger,
  in a drawer instead of an expanded row — the sentences below are kept verbatim)*
  shows the caller's client metadata when present (client name/version and session id,
  §5/§7) and the recorded call bodies when present (§15) — post-redaction args and
  result structuredContent, with stubs rendered as typed size placeholders (e.g.
  `‹blob image/png · 4.2 MB›`, `‹oversize · 20 KB›` — KB under a megabyte, MB with one
  decimal above; never the bytes), and `‹redacted›` as a stub chip of its own
  *(2026-09-21)*; ~~the session id renders as a link to this same audit view filtered to that
  session (`?session=…`, backed by `audit_query`'s `session` filter)~~ **the session id is
  one of the field table's id buttons, and filtering by it is still `?session=…`, still
  backed by `audit_query`'s `session` filter** *(2026-09-21)*. A call row with no
  bodies says why, in one sentence, so no panel is ever blank: "Call bodies aren't
  recorded for this app (body logging is off)." when the app's `log_bodies` is off now
  (§15's default for proxied apps); "Refused before the call was made, so there are no
  bodies to show." for a refusal outcome; "No bodies were recorded for this call."
  otherwise (recorded before logging was switched on, or the app is gone) — and such a
  row ~~is expandable~~ **opens its record** *(2026-09-21: every row opens one, so no row
  has to earn a control)* for that sentence alone. ~~The summary row carries `id="event-<id>"`
  and an opening chevron's link ends in `#event-<id>`, so the scripting-off reload lands
  on the row it opened *(2026-09-03, step 10: G24, G49, O27)*. A row with something
  to show draws a chevron that is a link to this same view with `?expand=<id>` — the
  current filters ride along, and the open row's chevron links back without it; a row
  with nothing recorded draws none *(2026-09-03, G1)*. Every such row's detail is
  rendered into the page, hidden until opened: a small inline script opens it in place
  with no request and no reload, closing the row that was open, and keeps `?expand=<id>`
  in the address so a refresh or a shared link reproduces the state; with scripting off
  the chevron's link reaches the same state one reload later *(2026-09-03)*.~~
  *(2026-09-21: all three go with the server-rendered page — there is no summary row to
  carry an `id`, no chevron, and no pre-rendered hidden detail. `?expand=<id>` survives as
  the URL of the open record and the rest of the selection rides beside it, so a refresh
  or a shared link still reproduces the state.)* No
  mutations, so no CSRF surface.

  **Page states** *(2026-09-21)*, each one a preview-gallery fixture (§16): the loading
  skeleton; load failed — the shell's error card with **Try again**; an empty ledger,
  "Nothing recorded yet — calls, approvals and config changes will appear here."; filters
  matching nothing, "Nothing matches — widen the window or drop a filter." with **Clear**;
  over the ceiling (the notice above); the record loading; and a record that is not there,
  "That record is gone — audit rows are kept for N days."

  **The phone** *(2026-09-21)* — below the shell's breakpoint, under the narrow shell
  (brand + hamburger): one column. The view segment runs full width at the narrow tap
  height. The strip keeps its lanes with each name **above** its cells and has **no drag**
  on touch — the presets and tapping a day on the axis set the window. The rail becomes a
  **Filters · N** button opening a full-screen level headed `‹ Audit`, the same groups at
  the narrow tap height under a sticky **Show N events**. Event rows become ~~two-line~~
  cards (time · principal · outcome chip, then the mono title, the chain line, ×N, then —
  ~~**only when the row has one** — the arguments preview as **one clipped line**, never
  wrapping~~ **only when it is the row's own evidence — the arguments preview or the recorded
  cause, the two things the ×N signature splits on — as one clipped line, never wrapping, and
  dropped otherwise**) *(2026-09-21, from the boards, drawing the expanded run on the phone:
  the card is no longer fixed at two lines, because the ×N signature splits on `argsHead` and
  on the cause (**Events** above), so five `search_news` calls with five queries are five
  cards and two refusals with two causes are two cards — without that line they would read as
  the same card repeated. Restated the same day, from the boards review: the test is
  **evidence for why this row is its own row**, not "has an arguments preview", so a refusal
  with a cause and no arguments keeps its line and a row with neither drops to two. A
  consequence of the run rule, not a product decision of its own)*; a session
  header wraps to two lines and its waterfall puts each label above its bar; and the record
  is a full-screen level headed `‹ Audit` rather than a drawer. Between that breakpoint and
  the side-by-side one the desktop layout stands, with the rail above the main pane as a
  wrapping row of groups.

  **Export.** An **Export JSONL** action
  streams every row matching the current filters, one JSON object per line: the
  handler re-runs the same query in `limit`-sized chunks and writes each chunk to a
  streaming response as it is fetched, never holding the full result set in memory —
  a serialization of `audit_query`, not a new capability. *(2026-09-21: still a Worker
  route, still at `/audit/export.jsonl` — a bookmark must not break — and still that
  serialization: the page links it and it is never a second read. It
  now accepts `since`, `until`, `text` and **repeated** `principal` / `app` / `event` /
  `tool` / `session` / `outcome` keys, handed to the one read as lists. The repeated
  `outcome=` holds **raw** outcome strings (`-32001`, `ok`, …), never a display class: an
  outcome class is the page's own grouping and `denied` folds two codes, so the page's export
  link is what expands a class to its codes.)*

  *(2026-09-21, from review — four rules the export carries because it is a ledger's archive
  path and not a view. **A tool pair travels whole**, as repeated
  `target=<app>/<tool>` behind a module-level pair filter, because splitting the page's pairs
  into `app=` + `tool=` lists would export their **cross product** — `news/get_news` and
  `notion/search` selected on the page would also export `news/search` — and an export that
  silently widens what a ledger hands over is not acceptable at any convenience. `target` is
  split at the **first** `/`: an app slug never contains one, while a `tool` column holding a
  resource URI does (§20.4), which is exactly why the bare `tool=` key cannot carry pairs.
  Bare `tool=` therefore stays an **exact match**, for the links that already exist. **A
  malformed `target` is a `400`**, never ignored, for the same reason: ignoring a filter
  widens an export. **Too many values is a `400`** — "Too many filter values for one export —
  narrow the selection." — answered past `AUDIT_EXPORT_MAX_VALUES` (**64**) and **before any
  read**: the route sums the repeated values across every key, a `target` pair counting
  **two** because it binds two columns, and refuses when that sum exceeds the constant. The
  bound is D1's rather than a policy — a prepared statement binds at most 100 parameters, and
  the export's own statement already spends some on the namespace, the window pair, `text`'s
  eight columns, its seek key and its chunk limit — and it is the **route** that refuses,
  because the facet rail may legitimately tick more values than this (a namespace can hold
  more tools than that) and a refusal the reader can act on beats a D1 error partway through
  a download. And **the window is selected, not
  defaulted**: `range` and a `since`/`until` pair narrow the export exactly as they always
  did, and a link naming **no** window exports everything the ledger still holds — the
  server-rendered page's last-24-h default is gone with the page, because the export is the
  archive path (§15) and an archive that quietly stops at yesterday is the same failure as one
  that quietly widens. `limit`, `offset` and `expand` stay ignored.)*

  **Deep links that must keep working** *(2026-09-21)*, the agent page, the app page and
  old bookmarks emitting them: `/audit?principal=agent:<slug>`, `/audit?app=<slug>`,
  `/audit?session=<id>`, `/audit?expand=<id>#event-<id>` — the query opens that record, and
  the fragment names no element any more, so it is inert rather than broken — and `?since=`
  / `?until=` in epoch ms. `?range=1h|24h|7d` stays a readable spelling of a window ending
  now, `30d` reads as the whole window, and `?limit=` / `?offset=` are ignored.
- `/approvals` — cookie-session-gated: pending requests up top (agent, app, tool,
  redacted arguments, requested time, approve/reject buttons — CSRF token on the POST),
  decision history below. A decision on a request that is no longer pending (decided
  from another tab, or expired between the render and the click) lands back with the
  warning "That request is no longer pending." — a lost race, not a failure, so never
  the red "failed" notice *(2026-09-03, G52)*. `/approvals/<id>` is the detail page the
  `-32003` error links to; only the namespace owner can open it.
  *(2026-09-23, decision 38:)* both are the SPA shell behind the ordinary owner session, and
  `/approvals/<id>` keeps its document-level `404` — an id outside this owner's listing is
  refused before any HTML, byte-identical to one that never existed. The list reads the two
  `GET /api/hub/approvals` resources the nav badge already reads (`?status=pending`, and
  `?limit=` for the history, asked one past the page's limit plus the pending count so
  "Older →" knows whether to render); the detail reads `GET /api/hub/approvals/<id>`, the same
  owner-scoped lookup, `404` for foreign and unknown alike. Approve and Reject are
  `approval_decide` through the op allowlist, from both pages, and land on `/approvals` with
  the notice as the form's 303 did — the lost race still the warning, keyed on the op. The
  per-browser push opt-in posts the browser's `PushSubscription` to
  `POST /api/hub/approvals/push` through the write gate; the VAPID public key it subscribes
  with rides the shell's bootstrap beside the origin, configuration no API reports.
- `/apps` — cookie-session-gated app management: active apps (kind, status —
  online/offline for tunneled, connection state for OAuth-proxied — roles, last seen)
  with archive/delete actions; an archived section with unarchive/delete; an add-app
  flow (pick tunneled or proxied — the two kinds, §2; for proxied, after the endpoint
  the form asks for the authentication type, `headers` or `oauth` (§7); tunneled
  creation shows the app token once; choosing `oauth` answers the **connecting page** —
  a 200 render, never a redirect: "Connecting to <name>…", "Finish signing in at <name>
  — this link expires in about 10 minutes." (§7's state TTL, the state minted for this
  session at render), a primary "Continue to <name>" linking the provider's authorize
  URL and "Not now" linking the app's Overview pane; when discovery fails the create
  still succeeded and lands on that pane with the connect notice *(2026-09-03, step 11:
  G46)*); and
  Connect/Reconnect/Disconnect for `auth: oauth` apps. CSRF tokens on every
  mutation. A refused create redraws the form at 400 with every violation under the
  control it names — the field is read off the refusal's own `violations` (§8), never a
  substring of its message — as the op's sentence, capitalised with one period, and
  `aria-invalid` on that input; a violation naming no control of the form (roles,
  redaction paths) is the whole-form message; two violations render two errors at once
  *(G43, G45)*. The endpoint of a proxied app must be an `https://` URL — `http://` only
  for `localhost`, `127.0.0.1` and `[::1]` — checked by `app_create` / `app_update` at
  the owner's trust boundary (§8), so a scheme-less host or a plain-http remote is
  refused before anything is stored or dialed *(G44)*. A blank Name is not sent, so the
  op defaults it to the slug (§8) and the form has no Name error. Future work for the
  add-app form: probe the entered URL (the §7
  RFC 9728 discovery) to suggest the auth type and surface provider-specific options,
  and accept manually pre-registered client credentials for OAuth providers without
  dynamic client registration. `/oauth/upstream/callback` belongs to this cookie-session-gated surface:
  it requires the owner's session and a live single-use `state` bound to it, per §7 —
  the callback is a mutation (it writes `upstream_auth_json`) and is guarded like one.
  *(Amended 2026-09-02: every app row links to its detail page below; the list's own
  actions stay.)* *(2026-09-16: every row **is** the link, as the agents list's — the
  name an anchor `class="row-link"` stretched over the `class="app-row"` row by a
  `::after`, no script, with a hover, a pointer and a trailing chevron; the row's own
  Connect / Archive / Unarchive / Delete sit above the stretched anchor, so they still
  act.)*
  Add-app forms optionally accept hub-local TypeScript aliases. Proxied owners configure
  them here because no upstream SDK is required; a reachable catalog is preflighted, but
  canonical upstream names are never changed. Alias syntax/collision refusals redraw the
  form without a partial write.
- `/apps/<slug>` *(added 2026-09-02)* — the app detail page, behind the same rail as
  `/settings` *(2026-09-16: and in the same **framed workspace box** as `/settings` and
  `/agents/<slug>` — a rail beside a card no longer)*. §13 named no such page before this
  date: the page list stopped at `/apps`.
  Header: one title line reading "Apps › <name>" — "Apps" a small muted link to
  `/apps`, "›" a muted separator, the name the title — then the slug, kind badge
  (`tunnel` | `proxy`) and status badge on that same line *(2026-09-17: the "Apps /
  <slug>" crumb line above the header is gone — the crumb folds into the title as the
  agent page's does, and the slug is said once, by its badge)*; status (tunneled: online /
  offline / archived, with last seen; proxied: the endpoint, the `auth` mode, forward
  identity, and for `auth: oauth` the connection state with Connect / Reconnect /
  Disconnect — the same controls `/apps` has). ~~Eight panes in two groups plus the danger
  zone last:~~

  *(2026-09-17, decision 32 — `design/concepts/AppThreePaneDemo.html`, adopted whole: the
  page is **rail · listing · details**, the agent page's shape in the same framed workspace
  box, and the eight panes are **seven**. Tools, Prompts and Resources fold into one
  **Catalog**; **Recording** is new; Roles becomes editable, and Agents holds the agent
  page's own grant editor. The table below replaces the one that listed the eight, which
  read: Tools `/apps/<slug>` (landing, count) · Prompts `/apps/<slug>/prompts` (count, or
  dimmed `—`) · Resources `/apps/<slug>/resources` (count of resources + templates, or
  dimmed `—`) · Roles · Overview · Agents · Token · Danger zone.)*

  | Group | Pane | URL | Rail marker | Query |
  |---|---|---|---|---|
  | App | Catalog | `/apps/<slug>/catalog`, and `/apps/<slug>` (the landing) renders it *(2026-09-17)* | tools + prompts + resources count; blank when a family could not be read; dimmed `—` when the app never connected | `sel=tool:<name>` / `prompt:<name>` / `resource:<uri>`; `q=` |
  | App | Roles | `/apps/<slug>/roles` | effective role count, or `none` | `sel=role:<name>`; `new=1` (the new-role editor); `q=` (the editor's filter) |
  | App | Recording | `/apps/<slug>/recording` | a status dot: `rail-dot--on` when body logging is on, `rail-dot--off` otherwise (the Two-factor dot's markup, `sr-only` text `on` / `off`) | `q=`; `which=args:<path>` / `results:<path>` (expands one path's per-tool rows, repeatable) |
  | App | Overview | `/apps/<slug>/overview` | none | — |
  | Access | Agents | `/apps/<slug>/access` | agents holding ≥ 1 grant | `sel=agent:<slug>` |
  | Access | Token | `/apps/<slug>/token` | live token count; dimmed `—` for proxied | `sel=token:<id>` |
  | — | Danger zone | `/apps/<slug>/danger` | none | — |

  `APP_PANES` (`app-routes.ts`) is therefore `["roles", "recording", "overview", "access",
  "token", "danger"]` *(2026-09-17, from the build: **plus `catalog`** — the Catalog pane
  has a URL of its own, below)*. ~~Tools lands so the app's real tool list is the first thing seen —
  the question an owner opens an app page to answer.~~ *(2026-09-17: **Catalog** lands, and
  for the same reason — what the app exposes is the question an owner opens the page to
  answer; the three families are one listing rather than three panes because three rail
  entries answered that one question three times.)* The danger zone is a neutral rail
  entry, not a red one: red on a nav item reads as the destructive button itself.

  **The Catalog pane has a URL of its own** *(2026-09-17, from the build)*:
  `/apps/<slug>/catalog` **is the pane**, and `/apps/<slug>` is the **landing**, which
  renders the same Catalog at wide and is level 1 on the phone (header + rail-as-list). The
  two are not an alias for one screen but two levels of one page — without the pane URL
  there is nothing for a phone's level 2 to be, and nothing for a level-3 back link to
  return to; the recorded exception to the no-alias rule is below. So: the rail's Catalog
  entry links `/apps/<slug>/catalog` and is `aria-current="page"` on **both** URLs;
  `/apps/<slug>/catalog?sel=…` is level 3, whose back link is the pane URL; and
  ~~`/apps/<slug>/catalog` and~~ `/apps/<slug>/tools` alone is a `404` — the old pane's
  name buys nothing and is not an alias for anything. **The old family URLs**: `GET
  /apps/<slug>/prompts` and `GET /apps/<slug>/resources` answer a `301` to
  ~~`/apps/<slug>`~~ `/apps/<slug>/catalog` — the Catalog holds them, and the query is
  dropped rather than translated (nothing in the old panes' URLs names a row the new one
  could select). An unknown pane segment is `noSuchPage`.

  **Header** *(2026-09-17)*: the title row is the `Apps ›` crumb, the name, then the slug /
  kind / status badges (`badge--title`), then the description as the subtitle. One **tiles**
  line under it — `T tools · P prompts · R resources · A agents · body logging on|off` and,
  on a tunneled app, ` · last seen <relative>` — which is why the page carries no separate
  "Last seen" note. The proxied header card (endpoint / auth / forward identity, with
  Connect / Disconnect) stays above the pane on every pane except Overview, as today. The
  rail's headings are `App` / `Access`, then the tail group Danger zone; the active entry is
  `aria-current="page"`.

  **Counts pluralise** *(2026-09-17)*: every count in this page's strings is written for its
  own number and the verb agrees with it — `1 agent holds a grant` / `2 agents hold a
  grant`, `1 path` / `4 paths`, `1 tool` / `3 tools` — never the `N agent(s)` shorthand,
  which §13 uses nowhere a user can read.

  **Wide panes** *(2026-09-17)*: Overview, Danger zone, and Token on a **proxied** app
  render the listing alone (`listing--wide`, as the agent page's grant step) — each holds
  nothing to select, and a wide pane therefore has no level 3. Every other pane is listing +
  details.

  - ~~**The two levels**~~ **The three levels** — the narrow rendering *(2026-09-17, owner:
    the app page takes the agent page's levels; ~~no `MobileAppDetail` board — the phone
    rendering is `MobileAgentDetail`'s with one region per pane~~ — **two levels** below,
    the landing and the pane)* *(2026-09-17, later the same day, decision 32: **three**,
    and `MobileAppDetail` / `MobileAppDetailStates` are drawn after all. A pane with a
    details region has a third thing to show, so the ladder is the agent page's whole one
    rather than its first two rungs; the boards follow from `design/concepts/AppMobileDemo.html`.)*
    At **wide** (≥ 1024) unchanged, the rail beside the panes. Below **1024** one level is
    visible at a time, chosen from the URL by the server and applied by CSS:

    | URL | level | what shows |
    |---|---|---|
    | `/apps/<slug>` (the landing) | 1 | the header (title line "Apps › <name>", the badges, the tiles) and the **rail as a list** — every entry a full-width row with its marker and a trailing chevron |
    | a pane without `sel`, `/apps/<slug>/catalog` among them | 2 | the **listing** alone, its own card title hidden (the level header names it) |
    | the same with `sel=` | 3 | the **details** alone |

    The page root carries `data-level="1|2|3"`, and a **wide pane has no level 3**. **The
    level header**, on every render and shown only below the breakpoint, is the agent
    page's table exactly: at 1 `‹ Apps` → `/apps`, titled with the name; at 2 `‹ <name>` →
    `/apps/<slug>`, titled with the pane's own rail label; at 3 `‹ <pane label>` → the pane
    URL without `sel` (keeping `q`, `new`, `which`), titled with the selected row's name.
    The pill row (`PanePills`) is **not rendered** on this page — the rail-as-list is its
    replacement, exactly as on the agent page; `/settings` alone keeps the pill row.
    Nothing new is linked: tapping a rail entry is its existing link, tapping a row its
    existing `?sel=` link.

  - **Dimming.** ~~An App-group entry for a §20 family renders dimmed with `—` in place of
    its count when the app advertises none of that family — for tunneled apps the
    capability set learned at registration (§20.5: tools is a family like any other, so
    an app that declared no tools dims Tools too, and one that has never connected dims
    all three — the hub has no catalog to count — each pane saying so: "This app has
    never connected, so the hub has no catalog to list yet. Start it with its token and
    the catalog appears after its first connect." *(2026-09-03: "lists none" read two
    ways; pinned as dimming)*), for proxied apps the owner-declared `capabilities` list (§20.2; absent ≡
    `[tools]`). A dimmed entry is still a link: its pane renders the empty state that
    says why, pinned — tunneled: "This app declared no prompts capability on its last
    connect, so the hub advertises none and serves an empty list." + "Declare prompts with
    your MCP SDK and they appear here after the next reconnect — the client library
    passes the declaration through untouched."; proxied: "The `capabilities` configured
    for this app omit prompts (§20.2) — add it with `app_update`, the web UI, or
    OpenTofu." (each with its family's name substituted).~~ *(2026-09-17, decision 32:
    rail entry left to dim — the three families are groups inside one Catalog listing, and
    an unadvertised family is said **in its group**, beside its heading, in the strings the
    Catalog pane pins below. What survives of this rule is the **rail marker**: Catalog
    carries one combined count, **blank** when a family could not be read, and the dimmed
    `—` only when the app has never connected, because that is the one case where there is
    no catalog at all rather than an empty one. The rule that produced the dimming is
    unchanged and now feeds the groups: for a tunneled app the capability set learned at
    registration (§20.5 — tools is a family like any other), for a proxied app the
    owner-declared `capabilities` list (§20.2; absent ≡ `[tools]`).)* The Token entry dims
    for proxied apps for §2's reason: nothing dials in, so there is nothing to hold a
    token. Only `—` means "advertises none": when a proxied app's live listing fails
    (below), the marker is **blank** — an unread count is not an empty set. Roles stays: it
    counts the owner's own configuration, not the listing *(2026-09-03)*.
  - ~~**Tools**~~ **Catalog** *(2026-09-17, decision 32: one pane for the three families —
    the Tools, Prompts and Resources panes below are folded into it, each family a group of
    this listing. Everything the three pinned that is about the **source** of a listing, the
    door's matcher, or an app's Markdown survives; what is superseded is the per-pane
    presentation — the expand-in-place row, the Resources pane's two tabs, and the strings
    each pane footed with.)* — the app's catalog as the owner sees it: the scoped endpoint's
    listing per advertised family, unfiltered (§7 step 2: owner → all of it; `ownerCatalog`
    is the one read, and the `unconnected` / `undeclared` / `unread` family states are the
    ones the agent page's app pane already renders) — for a tunneled app the DO's
    cached catalog (header line: "Advertised by the app on its last connect. Re-listed on
    every reconnect"), for a proxied app the live fetch under §7's 10 s deadline, with an
    unreachable or needs-reconnect upstream rendering that state in place of the list
    ("Token refresh failed — calls return errors until you reconnect." + Reconnect for an
    `auth: oauth` app; for `auth: headers`, which has no token and no Reconnect,
    "Couldn't reach `<endpoint>` — the live listing failed, so nothing is shown; calls
    return errors until it answers again." naming the configured endpoint, *2026-09-03*)
    rather than an empty one. The page fronts the MCP method exactly as `pmcp tools` /
    `pmcp describe app/<slug>/<tool>` do (§10, §20.6) — not an admin op, so §8's parity
    list is untouched. ~~A row is name, first line of description, `N args` / `1 arg` /
    `no args` *(2026-09-03: singular at one, as the board draws it)*;
    expanded in place it shows the full description, an **Arguments** table (name, type,
    `required` or `optional · defaults to <value>`, from the tool's `inputSchema` —
    top-level properties, `required`, `default`; nested schemas print their outer type
    and are not recursed into, a ceiling: the row is a glance, and `pmcp describe` prints
    the schema whole), and then **what only the hub knows**, in this order:~~
    1. ~~"Called by agents as `<slug>_<tool>`" — §7's aggregated name.~~
    2. ~~"Reachable by `<agent>`, `<agent>` · via `<role>`" — every agent whose granted
       roles on this app match the name, computed with the~~ **door's own matcher** (§7's
       anchored regex with the literal fast path, over `agent_list`'s inline grants and
       `app_get`'s roles) — never a second implementation: a page matcher that disagreed
       with the door would be a page that lies about access. ~~Zero agents renders
       "Reachable by no agent yet".~~
    3. ~~Approval posture: "No approval required" when every reaching agent reaches it in
       allow mode; otherwise "Approval required for `<agent>`, …" —~~ allow wins over
       approval per agent (§2), and owners are never gated.
    4. ~~Redaction: "No redacted fields", or~~ the redacted argument paths (`writeOnly` plus
       the config `redact` entries that match, §7) and result paths (`redact_results`). A
       schema-unsound tool (§7, §18 decision 16) says so here: "schema-unsound —
       approval-gated calls refuse, bodies are not recorded".


    The Catalog details show **Scoped MCP identity** (canonical service/tool and
    `/<user>/mcp/<slug>`) and **TypeScript identity** as separate facts. The owner sees
    the complete reservation map, source (`owner`/`sdk`/`generated`), tombstones, and
    bounded collision diagnostics; callers/search results see only grant-visible
    identities and non-leaking diagnostics. Alias edits post one `app_update`
    `typescript_aliases` object and never rename the upstream.

    *(2026-09-17, decision 32: the row is no longer an expander and the four facts above
    are no longer its tail — the row is a **link** and the facts are the details pane's
    cards, below. The matcher rule, the approval rule and the redaction sources are
    unchanged; only where they render and the words they render in are.)*

    **The listing** (`.lh` header): title **Catalog**; subtitle, tunneled `advertised by
    the app on its last connect · re-listed on every reconnect` / proxied `fetched live
    from the upstream`; the summary line `T tools · P prompts · R resources · reachable by
    N agents`; then the filter, a GET form on `q` with the placeholder
    `filter tools, prompts, resources…`. Groups `Tools · N`, `Prompts · N`, `Resources · N`
    — resources and templates in **one** group, a template listed by its raw
    `uriTemplate`. A group whose family the app does not advertise reads `none advertised`
    beside its heading and holds one note row: tunneled `This app declared no <family>
    capability on its last connect.`, proxied `The capabilities configured for this app
    omit <family>.` An app that has **never connected** renders one note,
    `This app has never connected, so the hub has no catalog to list yet.`, in place of all
    three groups. An **unread** listing keeps the two states pinned above —
    `Couldn't reach <endpoint> — the live listing failed, so nothing is shown; calls return
    errors until it answers again.` and `Token refresh failed — calls return errors until
    you reconnect.` with Reconnect. **A row** is the name (mono) with its description
    beneath (Markdown, inline, one line); at the right, one badge per agent that reaches it
    — `<agent>` for allow, `<agent> · ask` (`badge--warning`) for approval — or the dim text
    `no agent`. **The row is the `?sel=` link**, the agent page's row grammar. `q` filters
    by name or description substring; a group nothing matches reads `no match` under its
    heading.

    **The details pane.** Nothing selected: the title **Catalog**, `Select a tool, prompt
    or resource for its details.`, and the card `Where this comes from` — `Schemas` →
    tunneled `the app's last tools/list — the hub stores them, it does not author them` /
    proxied `the upstream's live listing, under a 10 s deadline`; `Reach` → `computed with
    the gate's own matcher over each agent's grant`. Selected: the header is the name, a
    family badge (`tool` / `prompt` / `resource`) and the full description (Markdown,
    `.md`); then the cards —
    **Arguments** (tools and prompts), whose rows come from whichever of the two a family
    has *(2026-09-17, decision 32: pinned, because a prompt has no JSON Schema to take
    leaves from — §20.3)*. A **tool**: one row per schema leaf — the path (mono), its type,
    and a `writeOnly · masked` warning badge where the schema declares it. A **prompt**: one
    row per **declared argument** — the name in place of the path, the argument's own
    description in place of a type (`—` when it declares none), `required` / `optional` from
    the declaration, and **no `writeOnly` badge**, there being no schema to carry one. Either
    way, `none` when nothing is declared;
    **Result · outputSchema** (a tool that declares one), the same rows;
    **Resource** (resources): `URI`, `Type` (the mime type), `Served on` → `the scoped
    endpoint only — <origin>/<user>/mcp/<slug>` with the hub's own origin and the owner's
    username substituted, so the endpoint is copyable, and `Matched` → `by URI, never by
    name`;
    **What only the hub knows**: `Scoped MCP identity` → canonical service/tool and the
    copyable scoped endpoint; `TypeScript identity` → the resolved §23 path, reservation
    source, and any owner-visible collision diagnostic (absent for prompts/resources,
    which programs do not call as aliased methods); `Reachable by` → one line per agent
    and matching entries; `Approval` → tool agents asked/none required, prompt never
    asked, resource absent; `Redaction` → argument/result paths or none.
    The foot note, verbatim: `The same block the audit row and the agent page show for this
    <family>. Editing reach happens on Agents, masking on Recording.` — both links.

    Every description an app publishes — on a tool, a prompt, a resource or a template — is
    **Markdown** (CommonMark/GFM) and renders as such wherever the hub shows it: whole in ~~an
    expanded row and in~~ *(2026-09-17: the app page's rows no longer expand —)* a details
    pane, either page's, inline-only on a one-line listing row
    or summary line, and stripped to text in an attribute such as the grant step's endpoint
    `title` — always through the one renderer in `server/src/pages/markdown.ts`, whose
    whitelist is the trust boundary, the text being the app's and therefore untrusted: no
    raw HTML from the source (it is escaped), links only `http:`/`https:`/`mailto:` and
    carrying `rel="noopener noreferrer" target="_blank"`, no images (a link to the image URL
    with its alt text), headings demoted to `<strong>` so app text cannot out-rank the
    page's own, and no `id`, `class` or `style` attribute *(2026-09-16)*.

    ~~Footer, verbatim: "Schemas come from the app's last `tools/list` — the hub stores
    them, it does not author them."~~ *(2026-09-17: that sentence is the `Where this comes
    from` card's `Schemas` line above — said once, in the pane that answers "where does
    this come from".)* The page edits nothing here.
  - ~~**Prompts** — the same shape without a schema table: name, description, the declared
    `arguments` (name, description, required), then the hub block with `<slug>_<prompt>`,
    reachability over the role's *prompt* patterns, the fixed line "Never
    approval-gated" (§18 decision 27), and the `redact` entries matching the name (§20.3).~~
    *(2026-09-18, §23: the Prompts group keeps canonical scoped identity,
    reachability, fixed `never asked for prompts`, and matching redaction entries. The
    former aggregate prefixed name is removed rather than displayed as an alias.)*
  - ~~**Resources** — two tabs, **Resources** and **Templates**, each with its count; rows
    are `URI` (templates: the raw `uriTemplate`) / `Name` / `Type` (`mimeType`)~~
    *(2026-09-17, decision 32: the Resources group of Catalog — **one** group, not two tabs,
    a template listed by its raw `uriTemplate`; `GET /apps/<slug>/resources` is a `301` to
    the landing)*; the hub
    block gives reachability over the role's *resource* patterns, matched against the URI
    or the raw template, and the redaction line is absent (URIs are not bodies; §20.4
    pins what the audit row keeps). The pane carries the two §20 rules a reader would
    otherwise learn from a refusal: "Resources are served directly on the scoped
    endpoint — `https://<hub>/<user>/mcp/<slug>`" with actual origin/owner substituted;
    "Hub programs address the same raw URI under the selected TypeScript service; the URI
    is never prefixed or rewritten."; and "Grants match resources by URI, never by name —
    templates by raw `uriTemplate`."
    *(2026-09-17: both rules are now the selected resource's **Resource** card — `Served
    on` and `Matched`, the strings above — so the reader meets them on the resource itself
    rather than on a pane header.)*
    `completion/complete` gets no pane, for the reason it gets no CLI command (§20.1).
  - **Roles** — ~~the declared roles in §20.3's canonical read shape, read-only. Tunneled:
    "Declared by the app at connect time." with the trust-boundary line "Roles are
    self-declared by the tunneled app — granting a role trusts the app's declaration."
    (§2); proxied: "Roles are defined in config (virtual) for proxied apps." Empty:
    "No roles declared" + "Grants fall back to the built-in `all` role — every tool,
    present and future."~~
    *(2026-09-17, decision 32: **the pane is editable.** A tunneled app's owner may define
    roles of their own beside the app's declaration — §20.3's "two sources, one rule", stored
    in `owner_roles_json` (§5) and written by `app_update { owner_roles }` (§8) — and a
    proxied app's `roles` were always the owner's and are now edited here too. Read-only is
    what the app declares, and only that. §2's trust boundary is unchanged and is now said
    on the role rather than on the pane: `Read-only: the app owns it and may widen it on its
    next connect.`)*

    **The listing.** Header: **Roles**, subtitle `named sets of what this app exposes`; the
    summary `D declared by the app · Y yours · plus the built-in all`, with, on a tunneled
    app, ` · the app's declaration wins when it declares a name you defined` and, on a
    proxied one, ` · a proxied app declares none, so every role is yours`. No filter on the
    listing. One row per **effective** role, then `all` last: the name (mono), a small
    source badge — `built-in` / `app` / `app · replaced yours` (title `the app declares this
    name — its declaration replaced yours`) / `yours` (`badge--success`) — beneath it
    `tools a, b · prompts c` (for `all`, `every tool, prompt and resource, present and
    future`) then ` · matches N`, N being the catalog items any of its patterns match; at
    the right, one badge per agent holding it (`<agent>` / `<agent> · ask`) or the dim
    `held by no agent`. The row is the `?sel=role:<name>` link. The foot carries **New
    role** on the left, a link to `?new=1`.
    **Which map "yours" means follows the kind, and the page never mixes them**: on a
    proxied app it is `roles` (config) and there is no `app` source at all; on a tunneled
    app it is `owner_roles`, and `app` is the declaration.

    **The details pane.** Nothing selected: **Roles**, `Select a role to see what it can
    do, or add one of your own.`, and the card `Two sources, one rule` — `The app's` →
    tunneled `declared at connect; read-only here — the app owns them` / proxied `none: a
    proxied app declares no roles`; `Yours` → `defined here by ticking items or adding
    patterns; usable in grants like any role`; `Collision` → `if the app later declares a
    name you defined, its declaration replaces yours — the row says so`.
    A selected role, or `new=1`: the header is the name (mono; for `new=1` an
    `<input name="role">` with the placeholder `role name` and `pattern="[a-z0-9_-]+"`),
    the source badge (`built-in` / `declared by the app` / `yours`) and the holders' badges;
    then the explanation, one of — `all`: `Every tool, prompt and resource, present and
    future. Never declarable, only grantable.`; the app's: `Declared by <name> at connect.
    Read-only: the app owns it and may widen it on its next connect.`, or, where it shadows
    one of the owner's, `<name> declares this name, so its declaration replaced the one you
    had defined. Read-only: the app owns it.`; yours on a tunneled app: `Defined by you. If
    <name> later declares a role named <role>, the app's declaration replaces this one.`;
    yours on a proxied app: `Defined by you. A proxied app declares no roles, so this is the
    only kind it has.` An **editable** role also gets the filter (GET, `q`, placeholder
    `filter, or type a pattern…`, carrying `sel`).
    Groups `Tools · K of N`, `Prompts · K of N`, `Resources · K of N` — K the count in the
    role, a family the app has none of omitted. A row is the name, the description, and
    ` · via <pattern>` when a non-literal pattern is what matches it; at the right, when
    **editable**, a checkbox `<input type="checkbox" name="i.<family>/<name>" value="1">`,
    checked when the literal is in the role, or a **locked** check (`.cb.lock`, title
    `matched by <patterns>`) when a pattern matches it; when **read-only**, a locked check
    (title `in this role`) or an empty box (`not in this role`). Then `Patterns · N`
    (`anchored · * aliases .*`), one row per non-literal pattern — the pattern, its family,
    `matches N today, and any added later` — carrying a remove submit button
    (`name="drop" value="<family>/<pattern>"`) when editable and a locked check otherwise;
    and, when editable and `q` is itself non-literal, the offer row: `<q>` · tools ·
    `would match N today, and any added later` with **Add as pattern**
    (`name="add" value="<q>"`; the family is `resources` when `q` contains `://`, else
    `tools`). The foot of an editable, saved role: **Delete role**
    (`name="delete" value="1"`, a danger button) with the hint `grants naming it keep the
    name and match nothing until it exists again` — and **no dialog**, because the op is
    reversible by re-adding the role, which is the test §13 applies everywhere else; at the
    right, **Discard** (a link to the pane URL) and **Save**.

    **The form** — one `<form method="post" action="/apps/<slug>/role_set">` around the
    editor, with the CSRF field, hidden `was=<name>` (the role being edited, empty for a
    new one), `role` (the name: hidden for a saved role, the input for a new one), a hidden
    `keep=<family>/<pattern>` per existing pattern row so a pattern the form still lists
    survives the save, the `i.` checkboxes, and the `add` / `drop` / `delete` buttons. The
    route composes the stored owner map (`ownerRoles` for a tunnel, `roles` for a proxy),
    minus `was`, plus `role` → { per family: the checked literals + the `keep` patterns −
    `drop` + `add` }, empty families omitted — or minus `was` alone on `delete` — and posts
    **one** `app_update { slug, owner_roles | roles }`, whichever the kind names. A refusal
    (a bad name, `all`, a pattern that does not compile, or a collision with the app's own
    declaration: `<name> is declared by the app — its declaration would replace yours`)
    **redraws the pane at 400** with the reason in a danger alert and the submitted choices
    preserved. Success is a `303` to `/apps/<slug>/roles?sel=role:<name>` — to
    `/apps/<slug>/roles` after a delete — with the notice.
  - **Recording** *(2026-09-17, decision 32; the approved `AppRecordingDemo` in the
    three-pane grammar)* — the three `app_update` fields this page had no control for:
    `log_bodies` as a switch and `redact` / `redact_results` as ticks on the paths the app's
    own schemas declare (§7, §15).

    **The listing.** Header: **Recording**, subtitle `what the audit trail keeps, and what
    it masks`; at the right edge the switch **Record call bodies** — a real
    `<input type="checkbox" name="log" value="1">` styled as the switch (`.sw`, its label
    text visible); the summary line `body logging on|off · <kind> default | set explicitly ·
    M masked paths by config`, plus ` · W declared writeOnly by the app` when any are;
    then the filter (GET, `q`, placeholder `filter paths…`). A **proxied** app with logging
    on and nothing masked carries the warning above the sections: `A proxied app's schema is
    not cached at call time, so nothing is masked automatically. Tick what is secret before
    you save, or it is stored in the clear for 7 days.`
    Two sections — `Arguments · N paths` (`from each tool's inputSchema`) and `Results ·
    N paths` (`from outputSchema, where declared`) — each path appearing **once**, indexed
    over every tool's schema leaves and sorted by how many tools take it, then by name. A
    path row is the path (mono), its type, `T tools` and then ` · declared writeOnly[ on
    K]` or ` · masked on its tool | all T | K of T`, and a **which** link
    (`?which=<dir>:<path>`, reading `hide` when already open) whenever more than one tool
    takes the path or any tool declares it `writeOnly`; at the right the control is a
    checkbox `name="p.<dir>.<path>" value="1"`, checked when every editable tool masks it,
    and `disabled` + locked when no tool is editable (all of them declare it `writeOnly`).
    **A path masked on some but not all of its tools renders expanded** — its per-tool rows
    shown, the path checkbox replaced by the locked-mixed glyph and no `p.` field at all —
    so no save can silently clear a partial state. That is a data-loss guard, not a layout
    choice. An expanded path (open by `which=`, or by being mixed) shows one sub-row per
    tool: the tool's name, then `declared by the app — always masked` with a locked check
    for a `writeOnly` leaf, else a checkbox `name="m.<dir>.<tool>.<path>" value="1"`. Under
    Results, when the tools declare no output schema and `q` is empty, the note
    `<tools or "N tools"> declare no output schema — a result path there can only come from
    a recorded call (mask from evidence).` An empty section reads `no path matches` or
    `no schema declares any field`. The foot: on the left `Recorded calls to <slug> →`
    linking `/audit?app=<slug>`; on the right **Discard** (a link) and **Save**.

    **The details pane** — **Masked before recording**: `These fields are replaced with
    ‹redacted› before a call is written to the trail. Everything else in the body is kept
    as sent.`, or, with logging off, `Body logging is off, so no bodies reach the trail; the
    masks below apply once it is turned on.` Then a card per direction, `Arguments · N
    masked` / `Results · N masked`, listing each masked path with `on <tools>` (`N tools`
    past three) and `declared writeOnly by <tools>`, or
    `nothing masked — arguments|results are recorded whole`. Then the card `What a recorded
    call keeps`: `Arguments` → `params.arguments, post-redaction`; `Results` →
    `structuredContent post-redaction; text, image and resource blocks become size stubs,
    never bytes`; `Cap` → `16 KiB per body — an over-cap body is one oversize stub`;
    `Kept for` → `7 days, then pruned with the rest of the audit table · Export JSONL to
    keep longer` (linking the audit export); `Never` → `refused calls, token material,
    writeOnly and config-masked fields`. And the note: `A tick writes one literal (tool,
    path) entry per tool; nothing here is a pattern and nothing is typed. Masking applies to
    the approval record too.`

    **The form** — `<form method="post" action="/apps/<slug>/recording_set">` around the
    listing, with the CSRF field, `log`, the `p.` and `m.` checkboxes, and a hidden
    `keep.<dir>=<tool>:<path>` for **every stored entry the rows do not represent** (a tool
    or a path no schema declares — an entry added from evidence, or a pattern key), so a
    save never drops what the rows cannot see. The route composes `redact` /
    `redact_results` as: each `p.` path → every editable tool that takes it; each `m.` →
    that one tool; plus the `keep` entries — and posts **one**
    `app_update { slug, log_bodies, redact, redact_results }`. Success is a `303` back to
    the pane with the notice; a refusal redraws it at 400 with the reason.
  - **Overview** (wide) — `app_get`'s row as a definition list: `Slug`, `Kind`, `Created`;
    for proxied
    apps the endpoint, `auth` mode and forward identity; for tunneled apps `Last seen`;
    body logging (`On — tunneled
    default` / `Off — proxied default` / the explicit setting, §15); ~~redacted arguments
    and redacted results (the config paths, or `none`)~~ *(2026-09-17, decision 32: the
    redaction lines are the **Recording** pane's, where they are editable — a read-only copy
    of an editable thing is a second place to read it and a first place to be wrong)*; and
    the description.
  - **Agents** — the agents holding at least one grant on this app: ~~`Agent` (slug, and
    its description) / `Granted roles` (one `role · mode` chip per grant; the built-in
    `all` is marked `built-in`), from `agent_list`'s inline grants (§8) filtered to this
    app. The **Edit grants** control targets~~ ~~the (agent × app) grant editor
    (`/agents/<agent>/grants/<slug>`, specced 2026-09-03 — until step 9's code lands the
    control is absent, the pane is read-only, and grants are edited with `grant_set`,
    `pmcp grant set`, §10)~~ *(2026-09-16, decision 31: the agent page's app pane,
    `/agents/<agent>/apps/<slug>`; the old URL answers a `301` to it)*
    *(2026-09-17, decision 32: the pane **is** that editor — the same rows rendered by the
    same component, not a link to it. "Edit grants" as a row control is gone.)* ~~Agent
    slugs link to `/agents/<slug>` once that page lands; text until then.~~ Footer, true of
    `grant_set` regardless of where it is edited
    *(2026-09-16)*: "Grants are
    edited per agent × app pair — saving replaces that pair's whole set."

    **The listing** *(2026-09-17)*. Header: **Agents**, subtitle `who can call this app,
    and how`; the summary `N agents hold a grant · open one to edit its grant on <slug>`
    (`1 agent holds a grant · …` at one).
    One row per agent holding ≥ 1 grant: the agent's slug (mono) and its description; then
    `allowed` with one mono badge per allow entry (or `—`), `ask first` with one warning
    badge per approval entry (or `—`), and the line `reaches R of T tools · K ask first[ · P
    of PT prompts][ · Q of QT resources] · C calls · 7 d` — C from
    `audit_query { principal: agent:<slug>, app, since 7 d }`, counting the `tools/call`
    rows. No right-hand control: the row is the link. After the rows, the note
    `Granting a new agent starts from the agent's own page — Agents → the agent → Grant
    another app.`, linking `/agents`. Starting a **new** grant here was considered and
    dropped (owner, 2026-09-16: it complicated the flow); this pane edits and removes the
    grants that exist.

    **The details pane.** Nothing selected: **Agents**, `Select an agent to edit what it may
    call on <slug>.`, and the card `Per tool` — the first six tools, each with the agents
    reaching it (`<agent>[ (ask)]`, comma-joined, or `no agent`), then `… N more in the
    Catalog`. A selected agent: the header is the slug (mono), an `agent` badge, the
    description and an **open agent page** link to `/agents/<agent>/apps/<slug>`, then
    `<agent>'s grant on <slug>. Solid: set on the row · hollow: implied by a role · a row
    cannot lower what a role grants.` Beneath it, **the agent page's grant editor,
    verbatim**: the reach summary line, the groups `Roles`, `Tools · N`, `Prompts · N`,
    `Resources · N`, `Patterns · N`, the same rows, the same `none` · `ask` · `allow` radio
    controls and the same field names (`e.<entry>`, `drop`, `carry`) — one component
    (`server/src/pages/grant-rows.tsx`), rendered by both pages, with the listing groups
    built by the same model builder. Two editors for one `grant_set` is exactly the second
    implementation §13 refuses for the door's matcher, for the same reason. There is **no
    pattern offer** here, the details pane carrying no filter. The foot: **Remove <agent>**
    on the left, opening `?confirm=remove-agent&agent=<slug>` on this pane — the dialog
    `Remove <agent> from <slug>?` / `<agent> loses every entry on <slug>. History stays; a
    waiting request expires.`, whose form posts `clear=1` — then **Discard** (a link) and
    **Save**.

    **The form** — `<form method="post" action="/apps/<slug>/grant_set">` with a hidden
    `agent=<slug>`, composing the same `grant_set` the agent page's route composes, through
    **one** shared composer. Success is a `303` to `/apps/<slug>/access?sel=agent:<agent>`
    with the notice; a refusal redraws the pane at 400 with the reason above the editor and
    the submitted choices preserved.
  - **Token** — tunneled apps only (proxied: the pane is **wide** and says ~~"Proxied apps
    hold no tokens — the hub dials the upstream; nothing dials in (§2)."~~ *(2026-09-17:
    `Proxied apps hold no tokens — the hub dials the upstream; nothing dials in.`)*). Every
    live app
    token (prefix, issued, last used) with **Revoke** (confirm dialog — "Revoking closes
    the app's live connection.", §8's `4001`), and **Issue new token** (`token_issue`
    `{ kind: "app" }`), which renders the once-only reveal in place — the same reveal the
    add-app flow shows — with "The previous token keeps working until you revoke it.":
    more than one live app token is legal (§5 has no per-referent uniqueness), and
    rotation is issue-then-revoke, in that order. Agent tokens are not issued here; they
    belong to the agent.

    **In the pane grammar** *(2026-09-17)*. Listing header: **Token**, subtitle `what the
    app presents to dial in`, an **Issue new token** button at the right edge (the existing
    `token_issue` route, 200 in place, the reveal drawn in the **details** of the new token,
    which is the selected one); the summary `L live · app tokens have no expiry — rotate by
    issuing, then revoking the old one. Revoking the key a live socket used closes it.` A
    row: the prefix (mono), `holds the live socket` (a success badge) when it does, `new`
    when just issued, then `issued <relative> · used <relative> | never used`; at the right
    **Revoke** → `?confirm=revoke-token&id=` (the existing dialog, its body `Revoking closes
    the app's live connection.` when the key holds the socket and `The app can no longer
    connect with it.` otherwise). Empty: `No live token — the app cannot connect until one
    is issued.` Details: the prefix, an `app token` badge, `Only valid for opening the
    reverse WebSocket as <slug>.`; the reveal card (`Shown once — copy it now`, the key,
    `The previous token keeps working until you revoke it.`) when the token was just issued;
    then `Issued`, `Expires` → `never — revoke on compromise`, `Last used`, and `Connection`
    → `holds the live socket now` / `none`.
  - **Danger zone** (wide) — **Archive** ("It refuses connections and leaves the list — tokens,
    grants and history are kept.") and **Delete** (~~"Revokes its tokens, closes the live
    connection and removes every grant. This cannot be undone."~~ *(2026-09-17: the two
    cards are titled **Archive <slug>** / **Unarchive** and **Delete <slug>**, and the
    delete body counts what goes: `Revokes its N tokens, closes the live connection and
    removes every grant (A agents). This cannot be undone.`)*), each behind a confirm
    dialog, fronting the same `app_archive` / `app_delete` the list page fronts. An
    **archived** app's page stays reachable (it is in `/apps`'s archived section) under
    an archived banner — "Archived apps refuse connections; everything is kept — tokens,
    grants and audit history." — with **Unarchive** and the retained catalog, tokens and
    grants shown as they are; a deleted app's page is a 404.
  - **Refusals.** `/apps/pmcp` is a 404 — the builtin is reserved and virtual, no row
    exists and `app_get` refuses the slug (§8). An unknown slug is a 404, and so is
    another namespace's slug by construction: pages read only the session owner's
    namespace. **Reserved slugs**: a slug can never claim a static segment the router
    mounts directly under `/apps/` — today `new` (the add-app form) and `connect` (the
    upstream-OAuth redirect's POST) — the sub-path analogue of §2's reserved-username
    rule, derived from the route table the same way, and refused by `app_create` (hence
    by `apply`) like `pmcp` is (§8). The op-named targets (`app_create`, …) carry `_` and
    fall outside the slug charset already, as `.well-known` falls outside the username
    charset.
- `/agents` *(added 2026-09-03, roadmap step 9 — the page family decision 30 deferred;
  the `Agents`, `AgentDetail` and `GrantEditorStates` boards adopted as contract; redrawn
  2026-09-16, decision 31 — `Agents` and `AgentDetail` re-adopted, `AgentDetailPanes` and
  `AgentDetailStates` added, `GrantEditorStates` deleted)* —
  cookie-session-gated. The **fifth top-nav entry**, `Agents`, second after `Apps`
  (Apps · Agents · Audit · Approvals · Settings); the narrow shell carries all five in its
  sidebar, so the fifth slot needs no overflow menu — the follow-up recorded below is
  closed *(2026-09-16: was "the narrow nav is already a horizontal scroller with its
  scrollbar hidden"; the scroller is gone — see **The narrow shell** below)*. Title
  "Agents", subtitle "Identities that call your
  apps — each holds grants and keys." *(2026-09-16: was "grants and tokens" — a key is
  not always a token; an OAuth client signs in as the agent too)*. A **plain list**, one
  row per agent from `agent_list` plus `token_list` filtered to `kind = agent` (§8; no
  second read path), and **no catalog is read** — every number on the page is counted over
  the stored grant sets *(2026-09-16)*. Columns: `Agent` — the slug, the description as
  its second line when set, the anchor **stretched over the whole row**
  (`class="row-link"` on the anchor, `class="agent-row"` on the row, a trailing chevron; a
  `::after`, no script), so a click anywhere on the row opens `/agents/<slug>`
  *(2026-09-16: replaces the slug-only link)* / **Access**, one line — "N apps ·
  A allowed · K ask first · D dormant", or "no grants" when the agent holds none; dormant
  counts grants on archived apps and undeclared roles *(2026-09-16: replaces the
  per-app `<app>: role, role` Grants column — per-app detail lives on the agent page)* /
  `Tokens` (`N active · used <relative>`, or `N active · never used`, or `none`; expired
  keys are not counted) / `Created`. Row control: **Delete** alone *(2026-09-16: **View**
  is gone — the row is the link; Delete sits above the stretched anchor, so it still
  deletes)* (confirm dialog — title "Delete agent “<slug>”?", body "Deleting an agent
  deletes its tokens and removes its grants everywhere.", the dialog riding
  `?confirm=delete-agent&slug=` on this page's URL) → `agent_delete`, landing here with
  the notice. Granting is not a control here: it lives on the agent page, behind the
  rail's "+ Grant another app…" *(2026-09-16)*. Page control: **New agent** →
  `/agents/new`, a form page like `/apps/new` (slug, name, description — `agent_create`'s
  own three fields; a refused slug re-renders the form with the refusal, a created one
  lands on `/agents/<slug>`). `new` is therefore reserved from agent slugs the way `new`
  and `connect` are from app slugs (§2's derivation rule). Empty state: "No agents yet.
  Create one to give an AI agent its own grants and keys." with the same control. Footer:
  "Deleting an agent deletes its tokens and removes its grants everywhere."
- `/agents/<slug>` *(added 2026-09-03; redrawn 2026-09-16, decision 31)* — the agent page:
  ~~one scroll of three cards and a danger zone, NOT a paned page — an agent has three
  holdings and no listing to browse, so a rail would carry nothing~~ *(2026-09-16: it IS a
  paned page. That reasoning fell the moment the page lists what every granted app
  advertises: the agent's apps ARE the listing, one rail entry each, and the (agent × app)
  editor becomes a pane rather than a page of its own)* — **rail · listing · details**,
  the third page on the shell below (*Panes behind a rail*), and the first whose pane
  holds a listing and a details pane side by side. Header: one title line reading
  "Agents › <slug>" — "Agents" a small muted link to `/agents`, "›" a muted separator, the
  slug the title — then the name when it differs from the slug, the description, `Created`
  *(2026-09-16, owner: the crumb folds into the title so the agent is named once; there is no
  "/ <app>" or "/ <pane>" suffix and no `agent` badge — the rail names the pane and the
  listing the row, and under "Agents ›" the badge said nothing the page did not; the app page
  keeps its kind badge because tunneled / proxied carries information)*. An unknown, foreign or reserved slug is the
  hub's 404 (`noSuchPage`, as `/apps/<slug>`).
  - **The panes**, one route each *(2026-09-16)*:

    | Pane | URL | Query |
    |---|---|---|
    | an app's grants (listing + details) | `/agents/<slug>/apps/<app>` | `sel=<kind>:<name>` selects a row for the details pane (`kind` ∈ `role`, `tool`, `prompt`, `resource`, `pattern`); `q=` the filter text |
    | Grant another app (wide: the listing alone) | `/agents/<slug>/grant` | `q=` search; `show=<app>` opens that card's endpoint list |
    | Credentials | `/agents/<slug>/credentials` | `sel=token:<id>` / `sel=client:<id>` |
    | Activity | `/agents/<slug>/activity` | `sel=approval:<id>` / `sel=call:<id>` |
    | Danger zone | `/agents/<slug>/danger` | — |

    `/agents/<slug>` itself renders **the first app in slug order the agent holds a grant
    on**, in place; an agent holding no grants lands on the grant step, in place. There is
    no alias URL for the landing pane (the pane rule below). `/agents/<slug>/apps/<app>`
    for an active app the agent holds nothing on renders the **new-grant state** — an
    empty set, the header's dashed "new grant · nothing saved yet" badge, and the rail
    showing the app; an unknown, builtin, foreign or (ungranted) archived app is
    `noSuchPage()`, and so is an unknown pane segment.
  - **The rail** is the shell's `PaneRail` *(2026-09-16)*, in groups: `Apps · N` — one
    entry per granted app in slug order, its marker `rail-dot--warn` (amber) when the set
    holds an approval entry and a `—` dash when the app is archived (dormant)
    *(2026-09-16: **archived and nothing else** — the rail is drawn on every pane and must
    read the same on all of them, so no catalog-dependent condition may feed it; "every
    entry matches nothing today" is knowable only for the app the open pane read)*, then a
    `+ Grant another app…` entry carrying the count of grantable
    apps; `Agent` — Credentials with its `live · clients` counts, Activity with the
    pending-approval count; then the tail group Danger zone. The active entry is
    `aria-current="page"`; archived apps are `rail-link--dim`. ~~Mobile: `PanePills`, the
    shell's pill row.~~ *(2026-09-16, owner: **not** on this page — below the breakpoint
    the rail is level 1, drawn as a full-width list, and `PanePills` is removed from the
    agent page entirely; **The three levels** below. `/settings` and `/apps/<slug>` keep
    the pill row.)*
  - **Header tiles** *(2026-09-16)*: "N apps · A allow · K ask first · D dormant",
    counted over the grant sets — **no catalog read**. Neither `/agents` nor this header
    fetches a catalog; only the open app pane does.
  - **An app's grants** (`/agents/<slug>/apps/<app>`) — the listing and details pane that
    replaces the grant-editor page *(2026-09-16)*. Reads: `agent_list` (the saved set),
    `app_list` (kind, status, declared roles), and the catalog of the one open app per
    advertised family, exactly as `/apps/<slug>`'s panes read theirs — including the
    `unconnected` / `undeclared` / `unread` family states, each rendered as one note line
    in its family's group ("<app> has not connected yet — nothing to list until it does.",
    the family "is not advertised", it "could not be read just now").
    Listing header: the app's name, slug, kind badge, status badge; the **reach line**
    "<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources",
    computed over the saved set; then the filter as its own row — a GET form (`q`) with
    the placeholder "filter, or type a pattern…".
    **Groups**, in order, each a heading with its count: `Roles · N` ("declared by the app
    at connect" / "defined in config"), then any held **undeclared** role rows, `Tools ·
    N` ("R reached · U not"), `Prompts · N`, `Resources · N` ("matched by URI"),
    `Patterns · N` ("entries that are not one item" — the inline entries whose pattern is
    not a literal), then the **pattern offer** when `q` is non-empty and is not a literal
    name: heading "As a pattern", one row `tool/<q>` (or `resource/<q>` when `q` carries
    `://`) reading "would match N today, and any added later" / "matches nothing today",
    with two submit buttons **Ask** / **Allow**. With `q` set, rows are filtered by name
    or description substring, pattern rows stay, and nothing matching renders "Nothing
    matches “<q>”."
    **Rows.** A role row: the name (`all` last, with a `built-in` badge), beneath it its
    patterns per §20.3 family and "matches N"; right, the control. An item row: name,
    description; right, "via <roles>" / "also via <roles>" when a role matches it, then
    the control. A pattern row: the entry, "matches N today" / "matches nothing today",
    the control. An undeclared role row: the name, an `undeclared` badge, "granted, but
    the app has not declared it — dormant"; right, an `in Allowed` / `in Ask first` badge
    with a `×` remove button.
    **The control** is one radio group per row — three `<input type="radio">` in a `.seg`,
    in this order and with these labels: `none` · `ask` · `allow`; field name `e.<entry>`
    (the entry string: a role name, or `tool/<name>` / `prompt/<name>` / `resource/<uri>`,
    §8), values `none` / `approval` / `allow`. An item row's checked value is the
    **direct** entry's mode (`none` when there is none); where a role implies a higher
    mode that button is drawn hollow (`.impl`, plus `.warn` for ask) and the buttons
    *below* the implied mode are `disabled` with `title="<roles> grants <ask|allow> —
    change the role to lower it"`. A direct entry at ask under a role that allows carries
    the "ask entry · no effect" badge (title "allow wins over ask") and a `×` remove
    button. **Highest wins, allow over ask; there is no deny** — nothing granted is simply
    `none` (§7).
    **The form.** One `<form method="post">` per app pane,
    `action="/agents/<slug>/apps/<app>/grant_set"`, carrying the CSRF field; its foot
    holds **Remove from <agent>** (left), the count text, **Discard** (a link back to the
    pane) and **Save** (right). Save composes the entry list: every `e.<entry>` at `allow`
    → `<entry>`, at `approval` → `<entry>:approval`, at `none` → nothing; plus the pattern
    offer's `add` field (`add=<entry>`, the pressed button's value in
    `mode=allow|approval`); minus every `drop=<entry>` (the `×` buttons are submit buttons
    named `drop`). One `grant_set` for the pair, replacing its whole set. A refusal (a
    proxied undeclared role, an entry whose pattern does not compile — §8) **redraws the
    pane at 400** with the reason in a danger alert above the listing and the submitted
    choices preserved, never a redirect; success is a `303` back to the pane with the
    notice. Like the editor before it, this form's fields are not the op's keys verbatim —
    `roles` is a list `stringList` will only take as an array, so the route composes it
    (D15 constraint 35) *(2026-09-16)*.
    **Remove from <agent>** opens `?confirm=remove-app` on the pane (title "Remove <app>
    from <agent>?", body "<agent> loses every entry on <app>. History stays; a waiting
    request expires."), whose form posts `clear=1` to the same action → `grant_set` with
    `roles: []` → `303` to `/agents/<slug>` with the notice.
    **The details pane** (from `sel`): nothing selected → the app's name and kind, "Select
    a role, tool, prompt or resource on the left for its details.", a Catalog card ("Tools
    T · R reached by <agent>" …) and the "Grant set for <agent>" card ("Allowed: …", "Ask
    first: …"). A role → a `role` badge, "Declared by <app> at connect." (a tunneled app; "Declared by
    <app> in config." for a proxied one) / "Built in:
    every family, present and future.", a For-agent card (Standing `in Allowed` / `in Ask
    first` / `not granted`), a Patterns card, a "Matches today" card, and the note "A role
    widens when the app widens it. To keep a single item regardless, add it directly from
    its row." A tool → its description, Standing ("allowed · via <roles>" / "allowed ·
    direct" / "ask · …" / "not reachable"), the approval sentence ("Not asked — allow wins
    over any ask entry, so adding one here would not gate it while <roles> allows it." /
    "Asked — each call waits for you." / "Not asked." for a direct allow no role backs /
    "—"), an Arguments table, and the "What only the hub knows" card (canonical scoped
    identity, resolved TypeScript identity where applicable, Reachable by, Redaction) —
    the app page's card, computed by the door's own matcher and never a second one. A
    prompt or resource omits the TypeScript call path. A pattern →

    `pattern` badge, "An entry that is not one item: anchored, * aliases .*.", Standing,
    and "Matches today · N" with the names.
    **Script is optional.** A small inline script (the audit expanded row's precedent) may
    mark rows whose radio differs from its initial value with the `unsaved` badge and
    count them in the foot, and the rail's blue draft dot is script-only; with scripting
    off **Save still replaces the set and the page is complete**, and nothing in a test
    depends on the script *(2026-09-16)* *(2026-09-21: the precedent cited is gone — the
    audit page is the SPA's explorer and has no hidden-detail row to open. This page is a
    SPA route itself since 2026-09-18; the clause is kept as the record of what the
    server-rendered pane promised)*.
  - **Grant another app** (`/agents/<slug>/grant`) *(2026-09-16)* — the listing alone, at
    the wide width. Header "Grant another app" · "apps <agent> holds nothing on"; a GET
    search form (`q`, placeholder "search apps and endpoints…"); the sentence "What each
    app does; open it to see every endpoint and which roles grant it. Grant opens the app
    with nothing granted yet."; group `Apps · N` ("active, not archived · nothing is
    written until you save"); one card per active non-builtin app the agent holds nothing
    on — name, slug, kind badge, status badge, description, then one line that depends
    on whether the card is open: closed, "roles <names> · show endpoints" (the link,
    `?show=<app>`); open, "T tools · P prompts · R resources · roles <names> · hide"
    *(2026-09-16, verification: a closed card cannot count what it has not read, and the
    landing pane of a fresh agent must not fan out to every grantable app's catalog)* —
    the open card revealing the endpoint list (`.eps`, each row: the family label, the name, an info
    marker whose `title` is the description, and the role badges that grant it, or "only
    via all or by name"), and a **Grant** link (`btn btn--primary`) to
    `/agents/<slug>/apps/<app>`. `q` filters cards by app name, slug or description or by
    any endpoint name, and opens matching cards' lists. Empty: "<agent> already holds a
    grant on every active app. Archived apps are not listed; unarchive one to grant it."
    Only an open card reads its app's catalog — the counts on its line are that read.
  - **Credentials** (`/agents/<slug>/credentials`) *(2026-09-16: the 2026-09-03 Tokens and
    Connected clients cards, now one pane)* — `Tokens · N` (unrevoked, `token_list` kind
    `agent`), with a group-heading control "expires in" (`<select name="expires_in">`:
    `30d` → `2592000`, `90d · default` → `7776000`, `1y` → `31536000`, `never` → `never`)
    beside an **Issue token** button, one form posting to the existing
    `/agents/<slug>/token_issue` — which answers 200 in place with the once-only reveal
    (`TokenReveal`) above the list and a `new` badge on the row, exactly as the app page's
    Issue does (§4/§15: a plaintext key never rides a URL); the pane URL is what
    re-renders. Rows: the prefix, an `expired` badge when expired, "created … · expires …
    (N d) · used …"; right, **Revoke** (`?confirm=revoke-token&id=`) or, on an expired
    row, **Remove** (`?confirm=remove-token&id=`, title "Remove expired token <prefix>?",
    body "It expired <date>; removing it keeps its history.") — **both post the same
    `token_revoke`**; only the label differs, because an expired key is nothing but a row
    to clear *(2026-09-16: 2026-09-03's "one verb for live and expired alike" becomes one
    op under two verbs)*. `Connected clients · N` from `connection_list` for this agent,
    read-only, each row linking to `/settings/clients`, with the note "One OAuth client
    signs in as this agent, so its calls carry these grants. Revoking lives with the other
    credentials in Settings → Connected clients." (§19.6: one place revokes.) Details: a
    token → the prefix, a `token` badge, created / expires / last used / "Carries: every
    grant in the Apps list — a key is the agent, not a subset of it", and Recent use (the
    last three audit rows for `principal=agent:<slug>` whose token prefix matches where
    the trail records it, else the agent's last three); a client → name, an `OAuth client`
    badge, redirect origin, consented, last used, registered ("by you, at consent" /
    "registered itself — identity unverified"); nothing selected → the Summary card.
  - **Activity** (`/agents/<slug>/activity`) *(2026-09-16)* — header "Activity" · "the
    last 7 days, the retention window", and at the right of the header row an outlined
    button-styled link **Open in Audit** (with an arrow-up-right glyph) →
    `/audit?principal=agent:<slug>` *(2026-09-16: was a bare "full trail" link)*; summary "N calls · ok · denied · awaiting approval".
    `Awaiting approval · N` ("each expires an hour after it was asked"): rows with the
    app, the tool, the args (post-redaction, one line) and the age, plus **Reject** /
    **Approve** buttons — forms posting `approval_decide` to
    `/agents/<slug>/approval_decide` and landing back on this pane; a decided row is
    dimmed with its status badge. `Recent calls · N` from `audit_query`
    (`principal=agent:<slug>`): app, tool, when, ms, and the outcome badge (`ok`
    / `approval required` / `not permitted` / the failure). **The trail is paged**
    *(2026-09-16, owner: "things might actually scale")*: twenty rows a page, `?calls=<n>`
    (a positive multiple of twenty, twenty by default) showing the newest n, read with
    limit n + 1 so the pane knows whether older rows exist; beneath the list, while they
    do, a row with a plain link **Load 20 more** to the same pane with `calls=<n+20>`
    (`sel` kept) and "more older calls in the last 7 days · everything before that is in
    Audit" (Audit linking `/audit?principal=agent:<slug>`), and once the week is
    exhausted "That is the whole week — older calls are in Audit."; the summary line above
    the groups counts what is shown, "last N calls · ok · denied · K awaiting approval".
    Links only, so scripting off pages the same way one reload at a time. Details: an approval → the
    tool, a status badge, "<agent> wants to call this on <app> · asked … · expires in …",
    an Arguments (post-redaction) card, "Why it waits" ("<role> is in Ask first on <app>"
    — the entry that matched, with mode approval), and the same two buttons; a call → the
    audit row's own sentences, the bodies when recorded and otherwise "Refused before the
    call was made, so there are no bodies to show." or the other two no-bodies sentences
    pinned above, plus "The same row the audit page shows … Open in the audit trail."
    linking `/audit?expand=<id>#event-<id>`.
  - **Danger zone** (`/agents/<slug>/danger`) *(2026-09-16)* — the `Delete agent` card
    ("Deleting an agent deletes its tokens, revokes its clients and removes its grants
    everywhere. This cannot be undone.") with **Delete <agent>** → the existing
    `?confirm=delete-agent` dialog → landing on `/agents` with the notice; details, "What
    deletion removes": Grants (N apps), Tokens, Clients ("— the binding cascades"),
    History ("kept — audit rows name the principal, not the row").
  - **The three levels** — the narrow rendering *(2026-09-16, owner-approved:
    `MobileAgentDetail`, `MobileAgentDetailStates`, from `design/concepts/AgentMobileDemo.html`;
    decision 31)*. At **wide** (≥ 1024) unchanged, three panes side by side. Below
    **1024** — the ladder's split-pane breakpoint, **not** the phone shell's 768: rail 200
    + listing 520 + details 360 need 1080 px, so 768–1023 gets the levels too, and this is
    the one page whose levels and whose shell change at different widths *(2026-09-16: the
    levels were pinned "below the shell's breakpoint" when there was only one)* — **one
    level is visible at a time**, chosen from the URL **by the server** and applied by CSS,
    so scripting off works and nothing is decided twice:

    | URL | level | what shows |
    |---|---|---|
    | `/agents/<slug>` (the landing) | 1 | the header (title line "Agents › <slug>", description, tiles) and the **rail as a list** — every entry a full-width row with its marker and a trailing chevron |
    | `/agents/<slug>/apps/<app>`, `/grant`, `/credentials`, `/activity`, `/danger` without `sel` | 2 | the **listing** alone (header + groups + foot) |
    | the same with `sel=` | 3 | the **details** alone |

    The page root carries `data-level="1|2|3"`; the narrow stylesheet shows one of `.rail`,
    `.listing`, `.details` by that attribute and the wide one ignores it. On wide screens
    the landing still renders the first app pane (unchanged) — the attribute only matters
    below the breakpoint, where the landing's listing is hidden and the rail is the screen.

    **The level header** is rendered on every pane and shown only below the breakpoint,
    above the content: a **back link** on the left naming the level above, the current
    thing centred.

    | level | back link | title |
    |---|---|---|
    | 1 | `‹ Agents` → `/agents` | the slug |
    | 2 | `‹ <slug>` → `/agents/<slug>` | the app's name, or `Grant another app` / `Credentials` / `Activity` / `Danger zone` |
    | 3 | `‹ <app name or pane name>` → the pane URL without `sel` (keeping `q`, `show`, `calls`) | the selected row's name |

    Below the breakpoint the wide title line and the rail's `aria-label`ed nav are hidden
    (the level header replaces them), and the pill row (`PanePills`) is **removed** from
    this page — the rail-as-list is its replacement; other paned pages keep theirs.
    **The listing header never repeats what the level header shows**: below the breakpoint
    the app pane's name is hidden (slug, kind and status badges, the reach line and the
    filter stay), and the Credentials / Activity / Grant another app / Danger zone titles
    are hidden (their subtitles stay). Activity's **Open in Audit** button drops under the
    subtitle, on its own line. **The foot** (Remove from <agent> · Discard · Save) stays
    one row, Save at the right edge; the change count is script-only and absent. **Rows
    and controls** are the desktop's, unchanged — the `none` · `ask` · `allow` radios at
    the right edge — with the "via <roles>" text above the control (`display:block`) and
    the details pane's key/value pairs stacked, key above value. **Grant another app**:
    cards one column, the **Grant** button full width beneath the description. Activity's
    paging is unchanged (links). **Nothing new is linked**: tapping a row is its existing
    `?sel=` link (level 3), tapping a rail entry its existing link (level 2) — only what
    shows changes.
  - Mutations follow the pane rule through the generic `/agents/:slug/:op` dispatcher,
    with an op → pane table *(2026-09-16)*:

    | Op | Lands on |
    |---|---|
    | `token_issue` | `/agents/<slug>/credentials` — 200 in place, the reveal |
    | `token_revoke` | `/agents/<slug>/credentials` |
    | `approval_decide` | `/agents/<slug>/activity` |
    | `agent_delete` | `/agents` |

    `grant_set` has its own route, `/agents/<slug>/apps/<app>/grant_set` (above), because
    it names the pair and not the agent alone. `/agents/<op>` still lands on `/agents`.
  - **The old URLs** *(2026-09-16)*: `GET /agents/<slug>/grants/<app>` answers a `301` to
    `/agents/<slug>/apps/<app>`, and `GET /agents/<slug>/grants` a `301` to
    `/agents/<slug>/grant`. ~~The app page's Agents pane row action ("Edit grants") links to
    `/agents/<agent>/apps/<app>`.~~ *(2026-09-17, decision 32: that pane holds this editor
    itself and has no row action; the link survives as the **open agent page** control in
    its details pane.)*
- ~~`/agents/<slug>/grants/<app>` *(added 2026-09-03)* — the (agent × app) grant editor,
  its own page rather than a dialog so it is linkable and needs no script.~~
  *(2026-09-16, decision 31: **deleted**. The editor is the app pane of `/agents/<slug>`
  above; `grant-editor.tsx` goes with it and `PagePropsByName` loses `grant-editor`, the
  old URL answering the `301` pinned above. What the page pinned and the pane keeps: one
  row per role the app declares (`app_get`'s canonical roles, §20.3) with the built-in
  `all` last, the undeclared-role rule in both kinds — tunneled warns and Save is allowed
  ("<app> hasn't declared <role>. Tunneled apps declare roles when they connect — this
  grant stays dormant until then.", §8), proxied is an error and `grant_set` refuses the
  save ("<app> is proxied — its roles are owner-defined, so an undeclared role is an
  error."), the refusal redrawing the page that
  submitted it — and the composed `roles` list, still not the op's keys verbatim. What it
  loses: its own URL, its "Saving replaces every grant <agent> holds on <app> — unchecked
  roles are removed." footer, which the pane's foot and Discard / Save now say; its
  `none` / `allow` / `approval` choice, whose labels and order are now `none` · `ask` ·
  `allow`; and its Cancel link, which is Discard.)*
- `/oauth/consent` *(added 2026-08-26, §19 — the inbound direction, under the same
  already-reserved `oauth` segment; re-scoped 2026-09-02)*: the consent screen an
  external MCP client's authorization request lands on (what the client is, what it asks
  for, which namespace, and the **agent picker** that decides how much power it gets). It
  is **chromeless and has no nav slot, by design**: a step inside the authorize redirect
  (§19.5), reached only by being sent there, never a page anyone navigates to — a
  `/settings` link to it would be a link to an error, and this sentence exists so nobody
  "fixes" the missing slot later. Cookie-session-gated owner page with a CSRF token on
  its POST, exactly like `/apps` — the consent POST is a mutation (it writes the binding
  **and** authorizes a client) and is gated like the strictest one. §19 pins the flow.
  The list of connections it produces, with Revoke, is the Connected clients pane of
  `/settings` above; `/oauth/connections` redirects there.
  *(2026-09-23, decision 38:)* the SPA shell, behind the owner session and — before any HTML —
  the provider's own signature check on the query, so an edited or expired request is still
  the plain `400` it was. The screen reads `GET /api/hub/oauth/consent?<the same query>`: the
  client appends its URL's query **verbatim**, never parsing or rebuilding it, and the server
  runs the unchanged read over that one request's raw query — the provider re-verifying the
  signature — answering exactly what the screen shows or echoes (`oauthQuery`, the client's
  name, the self-registered marker, the redirect origin, the scopes, the namespace, the agent
  list) and nothing more. The consent POST **stays a form post** the client renders — its
  answer is a 303 to the client's third-party `redirect_uri`, which no `fetch` can follow into
  the address bar — carrying the bootstrap's CSRF token and, as `oauth_query`, the value the
  read returned: the bytes the provider just verified, not a string the client assembled.
  Its gate and its verify-before-write order are untouched *(2026-09-23, as shipped: the one
  change is a read ahead of the provider call — on Allow the chosen agent is resolved first,
  §19.5 step 4 — and the picker's `required` binds Allow alone: Deny submits without
  validation, since refusing needs no agent and the server resolves one only on accept)*.

**Panes behind a rail** *(added 2026-09-02)*. One shell component serves all three paned
pages — `/settings`, `/apps/<slug>` and `/agents/<slug>` *(2026-09-16: three, not two;
the agent page joined on decision 31)* — and one **shape**: all three are the **framed
workspace box**, the rail and its pane inside one bordered frame running the page's full
width, the frame's own borders dividing them *(2026-09-16: `/settings` and `/apps/<slug>`
were a rail beside a free-standing card, at a page width of their own; they join the shape
the agent page uses, so the three paned pages read as one family)* — and its rules are
pinned once. A pane is one
region or two: `/agents/<slug>`'s app pane holds a **listing and a details pane side by
side**, still one route and one rail entry *(2026-09-16)* *(2026-09-17, decision 32: and so
does every pane of `/apps/<slug>` but the three wide ones — Overview, Danger zone, and Token
on a proxied app — which are the listing alone, `listing--wide`, because they hold nothing
to select)*:

**Where the numbers live** *(2026-09-16: §13 pinned five page widths, two rail widths and a
single 900 px breakpoint of its own; the owner found the pages inconsistent and the ladder
below replaces all of them)*. Every width, height and breakpoint is pinned once in
`design/layout-and-density.md` — derived there from the published systems, with the tokens
in `server/src/pages/styles.css` `:root` *(2026-09-23, decision 38's pass-2 amendment:
`web/src/legacy.css` from pass 2's first phase, then `app.css`'s `@theme` from its second)*
and the **Layout & density** panel on
`design/Main.dc.html` as its two homes. §13 decides the *shape*; that file decides the
*numbers*, and §13 does not repeat them. The ladder in one line: three page shapes —
**document** 760 (the auth card 400), **table** 1280, **workspace** full width with the
*panes* capped and not the page; one **rail 200**; the **framed workspace box** shared by
`/settings`, `/apps/<slug>` and `/agents/<slug>`; two breakpoints, **768** (the phone
shell) and **1024** (panes side by side); rows **32 / 40 / 44**; controls
**36 / 32 / 24 / 44**; one **badge 20**; no type under 11 px; prose capped at **72ch**;
gutters **16 → 24** at wide. Every "the shell's breakpoint" below means 768, and every
"side by side" means 1024. Any other number in §13 is an HTTP status, a lifetime or an op's
value — never a layout one. *(2026-09-23, decision 38's pass-2 amendment: today's look departs
from the ladder in seven places — the framed rail's entries, the smallest badge, the nav badge,
the code chip, the OTP boxes, the level header, the narrow titles — and pass 2 keeps the look,
naming each as a theme value. Moving them onto the ladder is its own later change.)*

- **A pane is a route.** Each pane has exactly one URL, `/<page>/<pane>`; the page root
  renders the first rail entry (the *landing* pane — `/settings` → Password,
  `/apps/<slug>` → ~~Tools~~ **Catalog** *(2026-09-17, decision 32)*, `/agents/<slug>` → the
  first granted app in slug order, or the
  grant step when the agent holds none *(2026-09-16)*) and no alias for it exists
  (`/settings/password` and
  `/apps/<slug>/tools` are 404s: one URL per pane).
  **One recorded exception** *(2026-09-17, from the build)*: `/apps/<slug>/catalog` **is**
  the Catalog pane's URL and `/apps/<slug>` is the landing that renders it. That is not the
  second name for one screen the rule forbids — below the breakpoint they are two different
  screens, level 1 (header + rail-as-list) and level 2 (the listing), and a level-3 back
  link needs a pane URL to return to. The agent page set the precedent: its landing already
  renders a pane that has its own URL (`/agents/<slug>/apps/<app>`), and only *that* pane's
  URL is linkable, bookmarkable and redirect-to-able. So the rule reads: a pane has exactly
  one URL, and a page root may **render** one — never answer at a second name of its own. A URL per pane is what lets a link, a
  bookmark, a fixture, and a post-mutation redirect all name one; the rail is navigation,
  never tabs.
- **The rail** groups entries under headings (`Sign-in` / `Access`; `App` / `Access`;
  `Apps` / `Agent` *(2026-09-16)*,
  then the ungrouped Danger zone) and every entry carries its at-a-glance marker — a
  count, the Two-factor status dot, `none`, the amber dot of a pending ask
  *(2026-09-16)*, the Recording dot of body logging *(2026-09-17)*, or the dimmed `—` of a
  pane with nothing to count — a proxied app's Token, an app that has never connected
  *(2026-09-17: ~~a family the app does not advertise~~ — the app page no longer has a pane
  per family)* — read from the same calls that render the panes, never a
  second query
  that could disagree with them. Every count is the number of rows its pane lists. The
  active entry is `aria-current="page"`; dimmed entries stay links.
- **Mobile** has no room for a rail: below the shell's breakpoint *(2026-09-16: **768**,
  the phone shell; the two-pane split waits for **1024** — the rail + listing + details
  need 1080 px, so 768–1023 keeps the rail and stacks the rest)* the same panes
  become a horizontally scrolling **pill row** under the page title — label only, no
  markers, active pill highlighted and `aria-current="page"` like the rail's active entry
  *(pinned 2026-09-03)*, same routes. This is a shell rule, so it applies to
  `/apps/<slug>` and `/agents/<slug>` although only `MobileSettings` was drawn (follow-up)
  *(2026-09-16: the agent page's mobile board is the same recorded follow-up)*
  *(2026-09-16, owner-approved — the board is drawn and the rule now has one exception:
  the pill row stays for `/settings` and `/apps/<slug>`, and **`/agents/<slug>` is the
  three levels instead** — rail-as-list, listing, details, one screen each behind a level
  header. `PanePills` is not rendered on the agent page at all. **The three levels**,
  under `/agents/<slug>` above.)* *(2026-09-17: `/apps/<slug>` takes
  the levels too — ~~**The two levels**~~ **The three levels** under `/apps/<slug>`, three
  once its panes gained a details region (decision 32) — so the pill row is
  `/settings`'s alone.)*
- **Mutations belong to a pane**: a POST target keeps the existing final-segment
  convention (its last segment names the op or the better-auth endpoint it fronts), and
  the redirect-back with its notice lands on the pane that rendered the form, not the
  page root. The app page's header is not a pane: its Connect / Reconnect / Disconnect
  land on the app's own Overview pane (`/apps/<slug>/overview`, the pane that reports
  the connection) with the notice there, and a finished Connect (the upstream callback)
  lands the same way; `/apps`'s own row controls still
  land on `/apps` *(2026-09-03, owner question 37(b))*. Confirm-dialog state
  (`?confirm=…`) rides the owning pane's URL for the same reason. *(2026-09-23, decision
  38: `/settings`' writes are JSON under `/api/hub/settings/`, each keeping its form target's
  final segment; the redirect-back becomes the `next` its answer names — the same URL, built
  by the same code, landing on the same pane.)*
- **A page's gate is every pane's gate**: `/settings/*` is recent-auth and no-bearer
  (§4); `/apps/<slug>/*` and `/agents/<slug>/*` are the ordinary owner session
  *(2026-09-16)*. *(2026-09-23: and `/api/hub/settings/*` is `/settings/*`'s rule, as one
  prefix, on every read and write the panes make.)*
- ~~Known follow-up, recorded not solved: the mobile top nav holds four items (Apps,
  Audit, Approvals, Settings) and has no `Agents` entry — 390 px cannot hold five, so the
  deferred agents pages will need a scroller or an overflow menu before they get a slot.~~
  *Closed 2026-09-03:* the top nav holds five (Apps · Agents · Audit · Approvals ·
  Settings); ~~the narrow nav is a horizontal scroller with its scrollbar hidden, which is
  the mechanism — no overflow menu.~~ *(2026-09-16: still five and still no overflow menu,
  but the mechanism is now the sidebar below, not the scroller — no phone width holds five
  nav entries comfortably, it only scrolled. The width the follow-up named is not a number
  §13 pins: the phone shell is everything below the 768 breakpoint, per the ladder above.)*

**The narrow shell** *(2026-09-16, owner-approved: `MobileAgentDetailStates`' "Sidebar"
board; decision 31)*. Below the shell's breakpoint — **768**, the ladder's phone shell
*(2026-09-16: was 900 px, a number nothing published uses and the only breakpoint §13 had;
the ladder replaces it with 768 and 1024, and every tappable control at narrow is 44)* —
the top bar is the brand mark
and name on the left and a **hamburger** on the right; the hamburger opens a **sidebar**
that slides in from the right — the hamburger's own side — over a scrim. At its top the
brand and a close control at the corner the hamburger occupied; then the five nav entries
(Apps, Agents, Audit, **Approvals** with its pending count as a pill, Settings), the
current one `aria-current="page"`; at the foot the username and the **Sign out** form.
Tapping the scrim or the close control closes it. This replaces the horizontally scrolling
five-entry nav on narrow screens; **the wide shell is unchanged**. Every page inherits it —
it is the shell, not a page rule.

*(2026-09-23, decision 38: there are no server-rendered pages left, so the paragraph below
describes a mechanism that retires with `layout.tsx`. The Base UI Dialog of its 2026-09-18
amendment is the only drawer; the `:target` rules stay in `styles.css`, unused, until pass 2
deletes the sheet. Done at pass 1's close, 2026-09-23: `layout.tsx` is deleted, and
`web/scripts/drawer-check.mts` checks only the drawer's **behaviour** on the SPA gallery —
it opens where the sheet puts it, Escape, a tap beside it and its close button each close it
and return focus to the hamburger, and the scroll lock is released — its pixel comparison
against the server preview gone with the preview.)*

~~**No script — on the server-rendered pages.**~~ The sidebar is `:target`-driven: the
hamburger is `<a href="#menu" class="menu-open" aria-label="Menu">`, the sidebar `<nav
id="menu" class="menu">`, the close control `<a href="#" aria-label="Close menu">`, the
scrim `<a href="#" class="scrim" aria-hidden="true">`; CSS shows the menu and the scrim on
`#menu:target`. A wide viewport never shows the hamburger, the menu or the scrim
(`display: none` above the breakpoint). The wide nav markup stays in the document and is
hidden below the breakpoint, so `aria-current` is asserted once, on either. `layout.tsx`
owns the markup, `styles.css` the rules. *(Amended 2026-09-18: on the SPA routes the same
five entries and the same `styles.css` classes are driven by a Base UI Dialog instead — it
traps focus and closes on Escape, which a bare `:target` cannot. The rules are untouched and
shared; only the mechanism differs, and it differs only where a script is already running.)*

~~**Two renderings, one design language**~~ **One rendering** *(2026-09-18; one since
2026-09-23, decision 38)*. `/apps/*`, `/agents/*` **and
`/audit`** *(2026-09-21, decision 36)* are a React SPA; `/login`,
`/device`, `/settings/*`, `/approvals*` ~~, `/audit`~~ and `/oauth/consent`
~~stay server-rendered~~ *(2026-09-23: are too — every browser page is the client, and no
page is rendered from Hono JSX any more)*. ~~Both read~~ The client reads `/styles.css` — it is the
~~shared~~ sheet and the source of
truth for every token and every page-chrome class — and ~~the SPA~~ adds `/app.css` after it,
carrying only what Tailwind's utility engine and the Base UI primitives need in order to
coexist with it. Tailwind's preflight is deliberately not imported, because it would strip
the list markers `.md ul` / `.md ol` depend on. *(2026-09-23: that holds through pass 1,
whose gate is that nothing looks different — `visual:compare` against the server-rendered
baselines in `design/baseline/`, a right difference named in `web/visual-accepted.json`
with its reason, never a loosened threshold. Pass 2 moves the hand-written primitives onto
the shadcn components in `web/src/components/ui/`, themed to these tokens ~~and the density
ladder~~, against the same baselines, and ends with the preflight on and `styles.css`
deleted.)*

*(Amended 2026-09-23 — pass 1 has shipped, and decision 38's pass-2 amendment rules how pass 2
runs.)* ~~The client reads `/styles.css`~~ From pass 2's first phase the sheet is no longer a
second document: `styles.css` becomes `web/src/legacy.css`, imported by `app.css` under
`@layer theme, base, legacy, utilities`, so every utility outranks every legacy rule by
construction — the coexistence counter-rules `app.css` carried against an unlayered sheet are
deleted, and none is ever written again. The shell links `/app.css` alone, and `/styles.css`
is no longer served (the 404 of any unclaimed path). The gate stays `visual:compare` against
`design/baseline/`, with two changes. The pairs pass 1 accepted are re-shot from the SPA at
pass 1's closing commit and `web/visual-accepted.json` starts pass 2 **empty**, so every
entry it gains is a pass-2 difference with its reason. And a **primitives** page joins the
gallery — not a route; each legacy class drawn beside the component replacing it, in every
variant, size and state — compared new column against old column at **budget 0**: that is
where a component's fidelity is gated, since a full-page pair's budget absorbs a radius or a
placeholder colour. A generated component is a template, edited until it matches there, and
no page uses it before it does. Where today's look and the density ladder disagree, the look
wins in pass 2 (*Where the numbers live*, above). Pass 2 ends with Tailwind's preflight
imported, `legacy.css` deleted once nothing in `web/src` matches a rule in it, and the `.md`
prose rules and the few base rules that must stay global moved into `app.css`.

*(Amended 2026-09-23 — pass 2 has shipped.)* It ended as planned, with three facts the plan did
not have. Preflight's form-control rule (`font: inherit`, colour, radius, background, disabled
opacity) is undone with `revert-layer` in `app.css`'s base layer, because every component was
matched against the browser's own control values; adopting it is a look change, left to the
follow-up that also takes the known gaps (missing focus rings and the rest). With `legacy.css`
gone the primitives page has no legacy column: each state's component crop is compared against
its baseline (`design/baseline/primitives__*`, cut from pass 2's last two-column render) at
budget 0. And `web/visual-accepted.json` closes pass 2 with six entries, each a named
improvement: the four `agent-new` pairs (typeless fields that no rule reached become `Input`)
and the two `catalogMarkdown` pairs (a markdown `hr` that drew nothing becomes a 1px rule).

*(Amended 2026-09-23 — after pass 2.)* The migration is over, so the screenshot gate stops
measuring against the server: every page baseline is re-shot from the SPA gallery at `54b3f80`
(pass 2 plus the shared alias editor), and `web/visual-accepted.json` restarts empty. The gate is
a regression check from here: a change meant to look different re-shoots the baselines it moves
and names each in its commit, instead of adding an accepted entry. The server's PNGs stay in git
history.

*(Amended 2026-09-23 — preflight's control rule adopted.)* The owner took Tailwind's reset whole:
the `revert-layer` block is gone, so a control inherits its font, line height, weight and colour,
and a primitive that has a disabled look states it (`disabled:opacity-50`). The baselines it
moved are re-shot and named in that commit.

**The SPA's server surface** is `/api/hub`, under the already-reserved `api` segment: ~~ten~~
**twelve** *(2026-09-21, decision 36: the two the explorer adds — below)*
cookie-authenticated JSON reads and, for writes, one allowlisting op dispatcher plus six
typed routes whose input is a delta the editor composes rather than an op's own keys. Every
read answers 401 with a JSON body when the session is absent; every write passes session,
origin and an `X-Pmcp-Csrf` header in that order. A custom header cannot be set cross-origin
without a preflight the hub never answers, so the header is itself a barrier and not a
re-spelling of the form field. The op dispatcher admits exactly nine names, all of which
take scalar arguments; `/settings`' own ops stay unreachable through it, so the ordinary
gate can never become a bypass of §4's recent-authentication prefix.

*(2026-09-23, decision 38 — what the five newly moved pages add, each described under its
page above:)* ~~twelve~~ **sixteen** reads — `GET /api/hub/approvals/<id>`,
`GET /api/hub/settings`, `GET /api/hub/device` and `GET /api/hub/oauth/consent` — and, for
writes, `POST /api/hub/approvals/push`, `POST /api/hub/device/decide`, and the eleven
`/settings` writes under `/api/hub/settings/`. That prefix is one rule, not eleven: every
read and write under it resolves the session **with recent authentication**, answering the
same 401 to a stale session as to none — the JSON twin of the `/settings/*` page gate, so
`/settings`' ops reach the browser only through it, and `token_revoke` from the Tokens pane
keeps the pane's stricter gate although the ordinary allowlist also admits it. And one
answer shape joins the surface: a write that replaces a form POST whose answer was a `303`
answers `200 { next, reload }` — `next` the very URL the 303 named, flash included, built by
the same server code and never from input; `reload` true exactly when the answer forwards
better-auth's `Set-Cookie`, because the session and with it the document's CSRF token was
replaced, so the client loads `next` as a document rather than routing to it. The flash
protocol therefore stays the server's to write, and the client stays its reader. Four form
posts survive beside the surface, each because its answer is a navigation a `fetch` cannot
perform: `/login`'s three sign-in routes with `/login/sign-out` (§4's translation routes), the
consent POST (§19.5), and `/apps/connect`.

**The explorer's two reads** *(2026-09-21, decision 36)*, alongside the unchanged
`GET /api/hub/audit` the agent page's Activity pane pages (bodies included): a **window**
read answering one page (`AUDIT_EXPLORER_PAGE`) of slim rows, newest first, for a
`since`/`until`/`text` window with an `offset` — it carries the row total, the window it
resolved and echoed (absent or invalid bounds mean the whole retention window ending now,
so the client never computes "now" twice), the retention days and the
`AUDIT_EXPLORER_ROWS` ceiling, and answers an empty page for an `offset` past that ceiling;
and a **record** read answering one full row by id, bodies and `noBodies` included, whose
`404` covers a row that is not in the caller's namespace exactly as it covers one that
never existed (unknown and foreign indistinguishable, §8). Both are `reader` routes like
the other ten — cookie session, 401 JSON when absent, `no-store` — and both are
`audit_query` underneath, the window one with `bodies: false` and the record one with `id`.
A slim row is the ordinary row minus the two body columns and minus the namespace id, plus
`argsHead` and `hasResult` and the same `noBodies` the server-rendered page computed: a
slim row "has bodies" when it carries an `argsHead` or a result.

**The SPA's document** is a shell the Worker still renders and still gates: the session gate
first, then the existence checks — so an unauthenticated deep link is the same 302 to
`/login?next=…` and an unknown, foreign or builtin slug is the same document 404 — and only
then the head, `<div id="root">`, a `<script type="application/json" id="pmcp-bootstrap">`
carrying `{csrf, username}`, and `<script type="module" src="/app.js">`. A JSON island
rather than an executable one, so no page-generated JavaScript runs and the existing CSP
needs no `script-src` relaxation. `Cache-Control: no-store`, like every other
session-derived response.

*(2026-09-23, decision 38:)* the shell now answers every browser page, and each URL keeps
the gate and the document-level answer its server-rendered page had, run before any HTML:
`/settings/*` the recent-authentication gate; `/approvals/<id>` the `404` for an id outside
the owner's listing; `/oauth/consent` the provider's signature check, a refused query still
the plain-text `400`; `/device` and `/approvals` the ordinary session; and `/login` **no gate
at all**. The bootstrap is `{csrf, username, origin, vapidPublicKey}` — the VAPID public
key joining the origin as configuration the approvals page needs and no API reports — and
`/login`, which has no session, carries none; its one island is `#pmcp-login` (`/login`
above). Every island is serialized with `<`, U+2028 and U+2029 escaped (`\u003c`, `\u2028`,
`\u2029`): the bootstrap's values happened to be safe because each is hex, charset-bound or
configuration, but `/login`'s carries text a link sets, and a `</script>` in it must not end
the element. **The headers are the pages' own, by construction**: the shell is emitted by
the one HTML renderer every page used — `Content-Type: text/html; charset=utf-8`,
`Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none'` (the
hub's only anti-framing header) and `Cache-Control: no-store` — at all six URLs, `/login`
included. The shell's head is the one head for every page, so `/login` and `/oauth/consent`
now say `theme-color #ffffff` where they said `#fafafa`, and the three chromeless pages link
the manifest ~~they did not~~ and the icons they did not — invisible in a screenshot, accepted
*(2026-09-23: shipped so, `/login` last)*.

**PWA**: the web surface ships a web-app manifest and a minimal service worker, so
the dashboard installs to phone and desktop home screens. The service worker exists for
installability and push, not offline rendering — it has no fetch handler at all and does not
intercept navigation. *(On the SPA routes its registration moved from the shell's body into
the client entry, which is the only place it could go once the layout that carried it was
deleted. 2026-09-23, decision 38: that is every route now, `/login` included, which never
registered it before.)*

**Approval push**: `/approvals` offers a per-browser "Enable
notifications" control; subscriptions land in `push_subscription` (§5), and every new
approval request sends a Web Push (VAPID keys in Worker secrets, ES256 via WebCrypto,
RFC 8291 payload encryption) naming the app and tool — never arguments — which
opens `/approvals/<id>` on tap. A `404`/`410` from the push service prunes the
subscription. Best-effort delivery; the dashboard is the source of truth (§7).
*(Amended 2026-09-12, closing G23:* the wire is pinned to the pair Apple's push service
accepts and no earlier dialect — RFC 8291 `aes128gcm` bodies under an RFC 8292
`vapid t=<jwt>, k=<key>` header, with a positive `TTL` and `Urgency: high`. The
VAPID pair is the whole of the signing: Apple requires no developer-program
certificate and no Safari website push package, but iOS delivers only to a web app the
owner has added to the Home Screen, which is what the manifest above makes possible.
`server/src/push.ts` is the one place any of it is spelled.*)

The dashboard pages `/apps`, `/apps/<slug>`, `/approvals`, `/audit` — and, *(amended
2026-09-02)*, the Tokens and Connected clients panes of `/settings` — and the CLI are all
fronts over the same server-side handlers as the `pmcp` tools (`token_list` /
`token_revoke`, `connection_list` / `connection_revoke` among them) — one implementation,
three surfaces *(2026-09-21, decision 36: `/audit` becoming the SPA's explorer changes
nothing here. Its three reads are `audit_query` with new options, and its export is still
that op's serialization. Four of the options are **on the op** — `id`, `text`, `bodies` and
`outcome`, the last a sixth single-valued exact filter — so `pmcp audit` reaches each of
them; what the page has and the CLI does not is the **list form** of the six exact filters,
which reaches nothing but the export and therefore sits inside §8's existing export
exception rather than widening the parity list)*; the ~~Tools, Prompts
and Resources panes~~ **Catalog pane** *(2026-09-17,
decision 32)* fronts MCP listings on the scoped
endpoint exactly as `pmcp tools` / `prompts` / `resources` do (§20.6), which is why §8's
parity list does not change — and the three forms decision 32 adds (`role_set`,
`recording_set`, `grant_set`) front `app_update` and `grant_set`, ops the CLI has already. `/settings`'s **Sign-in group and Sessions pane** are the
deliberate exception: credential management (password change, TOTP, passkeys, active
sessions) rides better-auth's endpoints and is intentionally web-only — §4's
session-scope guards reject bearer-sourced sessions there precisely so no CLI token or
`pmcp` tool can ever reach it. The two Access panes that front tools sit behind the same
`/settings` gate because the gate is a prefix rule, not because the tools they front are
hidden from the CLI — they are not.
