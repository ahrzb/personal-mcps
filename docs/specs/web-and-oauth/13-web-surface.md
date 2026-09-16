## 13. Web surface

*Amended 2026-09-02 — decision 30: `/settings` split into panes behind a left rail and
gained a **Password** pane (reversing, for the *change* half only, §4's "no self-serve
password change"); `/apps/<slug>` added as the app detail page behind the same rail;
`/oauth/connections` re-homed as the **Connected clients** pane of Settings. Everything
marked 2026-09-02 below is **spec ahead of code** — implemented as its own workflow, after
§21 (D14); a reader must not mistake it for shipped behavior.*

Deliberately tiny — server-rendered pages (Hono JSX) only where a browser is required:

- `/login` — username + password, TOTP challenge, passkey button. Sign-in landing: a
  `?next=` deep link is honoured only when it is hub-relative; anything else — absolute,
  scheme-relative, or the `/\` spelling a browser folds into `//` — lands on `/apps`.
- `/device` — device-approval page (user enters the code the CLI printed). Since we
  hand-build it anyway: it shows the requesting IP and user-agent and states plainly
  that approval grants **full admin CLI control of the namespace** (RFC 8628 §5.4 /
  cross-device-flow BCP: the user-code channel is unauthenticated, so the page is the
  phishing defense); the approval POST carries a CSRF token; device-code lifetime is
  set to ~10 minutes (down from better-auth's 30-minute default).
- `/settings` *(rewritten 2026-09-02)* — sign-in and access for the owner, as six panes
  behind a left rail (the pane rules are pinned once, under **Panes behind a rail**
  below). Requires a cookie-authenticated session with recent authentication —
  bearer-sourced sessions are rejected on these routes (§4) — and the gate is a **prefix
  rule**: every route under `/settings`, every pane and every POST, is behind it, the two
  ops-backed panes included (stricter than `/oauth/connections` had; accepted so the page
  has one gate rather than two).

  | Group | Pane | Route | Rail marker |
  |---|---|---|---|
  | Sign-in | Password | `/settings` (landing) | none |
  | Sign-in | Two-factor | `/settings/two-factor` | status dot — lit iff TOTP is enabled |
  | Sign-in | Passkeys | `/settings/passkeys` | count |
  | Access | Sessions | `/settings/sessions` | count |
  | Access | Tokens | `/settings/tokens` | count |
  | Access | Connected clients | `/settings/clients` | count |

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
    same hub translation route every credential form uses, gated like every other
    credential POST — session, **recent authentication**, CSRF. That gate is load-bearing,
    not belt-and-braces: in 1.7.1 `/change-password` sits behind
    `sensitiveSessionMiddleware`, which proves an authoritative session and nothing about
    its age (`freshSessionMiddleware` is the one that reads `freshAge`, and this endpoint
    does not use it), so the hub's own recent-auth check is the only freshness check the
    change has. Pinned:
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
      "others" (`pmcp login` again), and the translation route **must** forward
      better-auth's `Set-Cookie` to the browser exactly as it does for sign-in — dropping
      it signs the owner out. `N` is counted by the hub from `/list-sessions` immediately
      before the call (all sessions minus the current one); better-auth returns no count.
    - The pane shows when the session was last confirmed ("Confirmed your identity N
      minutes ago." — the session's `createdAt`, the same value the gate reads), so the
      owner can see why a stale one is bounced.
  - **Two-factor** — unchanged in substance: not enrolled → **Enable two-factor**
    (password-confirmed; the answer renders the setup card in place at 200 — the secret
    and the codes never ride a URL); TOTP setup (QR plus the grouped secret for manual
    entry, a 6-digit verify posted to the pane's own `/settings/two-factor/verify-totp`
    — a refused code redraws the same enrolment in place with the error under the boxes,
    a verified one lands on the enabled arm); the backup codes revealed exactly once after
    enabling or regenerating; enabled → **Regenerate backup codes**, **Disable
    two-factor** (confirm dialog). The rail dot is the one marker that is a status, not a
    count.
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
- `/audit` — read-only, cookie-session-gated view over the audit table (§5): a plain
  server-rendered table, newest first, with the same filters as `audit_query`
  (agent, app, event, tool, time range) and offset/limit paging backed by
  `audit_query`'s `total` (desktop shows numbered pages, mobile a "Load more" that
  accumulates offsets — one contract, two presentations). The four tiles and the chart
  are computed over the newest 1,000 matching rows while the Events count is exact; past
  that ceiling the per-row tiles and the chart say "over the newest 1,000", and the three
  filter selects likewise list only what the newest 1,000 rows of the namespace mention
  *(2026-09-03, step 13: G22)*. An **Export JSONL** action
  streams every row matching the current filters, one JSON object per line: the
  handler re-runs the same query in `limit`-sized chunks and writes each chunk to a
  streaming response as it is fetched, never holding the full result set in memory —
  a serialization of `audit_query`, not a new capability. The expanded row detail
  shows the caller's client metadata when present (client name/version and session id,
  §5/§7) and the recorded call bodies when present (§15) — post-redaction args and
  result structuredContent, with stubs rendered as typed size placeholders (e.g.
  `‹blob image/png · 4.2 MB›`, `‹oversize · 20 KB›` — KB under a megabyte, MB with one
  decimal above; never the bytes); the session id renders as a link to this same audit view filtered to that
  session (`?session=…`, backed by `audit_query`'s `session` filter). A call row with no
  bodies says why, in one sentence, so no panel is ever blank: "Call bodies aren't
  recorded for this app (body logging is off)." when the app's `log_bodies` is off now
  (§15's default for proxied apps); "Refused before the call was made, so there are no
  bodies to show." for a refusal outcome; "No bodies were recorded for this call."
  otherwise (recorded before logging was switched on, or the app is gone) — and such a
  row is expandable for that sentence alone. The summary row carries `id="event-<id>"`
  and an opening chevron's link ends in `#event-<id>`, so the scripting-off reload lands
  on the row it opened *(2026-09-03, step 10: G24, G49, O27)*. A row with something
  to show draws a chevron that is a link to this same view with `?expand=<id>` — the
  current filters ride along, and the open row's chevron links back without it; a row
  with nothing recorded draws none *(2026-09-03, G1)*. Every such row's detail is
  rendered into the page, hidden until opened: a small inline script opens it in place
  with no request and no reload, closing the row that was open, and keeps `?expand=<id>`
  in the address so a refresh or a shared link reproduces the state; with scripting off
  the chevron's link reaches the same state one reload later *(2026-09-03)*. No
  mutations, so no CSRF surface.
- `/approvals` — cookie-session-gated: pending requests up top (agent, app, tool,
  redacted arguments, requested time, approve/reject buttons — CSRF token on the POST),
  decision history below. A decision on a request that is no longer pending (decided
  from another tab, or expired between the render and the click) lands back with the
  warning "That request is no longer pending." — a lost race, not a failure, so never
  the red "failed" notice *(2026-09-03, G52)*. `/approvals/<id>` is the detail page the
  `-32003` error links to; only the namespace owner can open it.
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
  actions stay.)*
- `/apps/<slug>` *(added 2026-09-02)* — the app detail page, behind the same rail as
  `/settings`. §13 named no such page before this date: the page list stopped at `/apps`.
  Header: name, slug, kind badge (`tunnel` | `proxy`), status (tunneled: online /
  offline / archived, with last seen; proxied: the endpoint, the `auth` mode, forward
  identity, and for `auth: oauth` the connection state with Connect / Reconnect /
  Disconnect — the same controls `/apps` has). Eight panes in two groups plus the danger
  zone last:

  | Group | Pane | Route | Rail marker |
  |---|---|---|---|
  | App | Tools | `/apps/<slug>` (landing) | count |
  | App | Prompts | `/apps/<slug>/prompts` | count, or dimmed `—` |
  | App | Resources | `/apps/<slug>/resources` | count of resources + templates, or dimmed `—` |
  | App | Roles | `/apps/<slug>/roles` | count, or `none` |
  | App | Overview | `/apps/<slug>/overview` | none |
  | Access | Agents | `/apps/<slug>/access` | count of agents holding ≥ 1 grant on the app |
  | Access | Token | `/apps/<slug>/token` | count of live app tokens; dimmed `—` for proxied |
  | — | Danger zone | `/apps/<slug>/danger` | none — a neutral rail item |

  Tools lands so the app's real tool list is the first thing seen — the question an owner
  opens an app page to answer. The danger zone is a neutral rail entry, not a red one:
  red on a nav item reads as the destructive button itself.

  - **Dimming.** An App-group entry for a §20 family renders dimmed with `—` in place of
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
    for this app omit prompts (§20.2) — add it with `app_update` or the YAML." (each with
    its family's name substituted). The Token entry dims for proxied apps for §2's reason:
    nothing dials in, so there is nothing to hold a token. Only `—` means "advertises
    none": when a proxied app's live listing fails (below), the App-group markers are
    **blank** — an unread count is not an empty set. Roles stays: it counts the owner's
    own configuration, not the listing *(2026-09-03)*.
  - **Tools** — the app's catalog as the owner sees it: the scoped endpoint's
    `tools/list` unfiltered (§7 step 2: owner → all tools) — for a tunneled app the DO's
    cached catalog (header line: "Advertised by the app on its last connect. Re-listed on
    every reconnect"), for a proxied app the live fetch under §7's 10 s deadline, with an
    unreachable or needs-reconnect upstream rendering that state in place of the list
    ("Token refresh failed — calls return errors until you reconnect." + Reconnect for an
    `auth: oauth` app; for `auth: headers`, which has no token and no Reconnect,
    "Couldn't reach `<endpoint>` — the live listing failed, so nothing is shown; calls
    return errors until it answers again." naming the configured endpoint, *2026-09-03*)
    rather than an empty one. The page fronts the MCP method exactly as `pmcp tools` /
    `pmcp describe app/<slug>/<tool>` do (§10, §20.6) — not an admin op, so §8's parity
    list is untouched. A row is name, first line of description, `N args` / `1 arg` /
    `no args` *(2026-09-03: singular at one, as the board draws it)*;
    expanded in place it shows the full description, an **Arguments** table (name, type,
    `required` or `optional · defaults to <value>`, from the tool's `inputSchema` —
    top-level properties, `required`, `default`; nested schemas print their outer type
    and are not recursed into, a ceiling: the row is a glance, and `pmcp describe` prints
    the schema whole), and then **what only the hub knows**, in this order:
    1. "Called by agents as `<slug>_<tool>`" — §7's aggregated name.
    2. "Reachable by `<agent>`, `<agent>` · via `<role>`" — every agent whose granted
       roles on this app match the name, computed with the **door's own matcher** (§7's
       anchored regex with the literal fast path, over `agent_list`'s inline grants and
       `app_get`'s roles) — never a second implementation: a page matcher that disagreed
       with the door would be a page that lies about access. Zero agents renders
       "Reachable by no agent yet".
    3. Approval posture: "No approval required" when every reaching agent reaches it in
       allow mode; otherwise "Approval required for `<agent>`, …" — allow wins over
       approval per agent (§2), and owners are never gated.
    4. Redaction: "No redacted fields", or the redacted argument paths (`writeOnly` plus
       the config `redact` entries that match, §7) and result paths (`redact_results`). A
       schema-unsound tool (§7, §18 decision 16) says so here: "schema-unsound —
       approval-gated calls refuse, bodies are not recorded".

    Footer, verbatim: "Schemas come from the app's last `tools/list` — the hub stores
    them, it does not author them." The page edits nothing here.
  - **Prompts** — the same shape without a schema table: name, description, the declared
    `arguments` (name, description, required), then the hub block with `<slug>_<prompt>`,
    reachability over the role's *prompt* patterns, the fixed line "Never
    approval-gated" (§18 decision 27), and the `redact` entries matching the name (§20.3).
  - **Resources** — two tabs, **Resources** and **Templates**, each with its count; rows
    are `URI` (templates: the raw `uriTemplate`) / `Name` / `Type` (`mimeType`); the hub
    block gives reachability over the role's *resource* patterns, matched against the URI
    or the raw template, and the redaction line is absent (URIs are not bodies; §20.4
    pins what the audit row keeps). The pane carries the two §20 rules a reader would
    otherwise learn from a `-32601`, verbatim: "Resources are served on the scoped
    endpoint only — `https://<hub>/<user>/mcp/<slug>`" with the hub's own origin and the
    owner's username in place of the placeholders, so the endpoint is copyable
    *(2026-09-03: the literal `<hub>` was a board artefact)* — ". The aggregated endpoint answers
    `-32601`, because a URI cannot carry a slug prefix and stay the URI the app knows."
    and "Grants match resources by URI, never by name — a role's resource patterns are
    URI patterns, and templates are matched against their raw `uriTemplate`."
    `completion/complete` gets no pane, for the reason it gets no CLI command (§20.1).
  - **Roles** — the declared roles in §20.3's canonical read shape, read-only. Tunneled:
    "Declared by the app at connect time." with the trust-boundary line "Roles are
    self-declared by the tunneled app — granting a role trusts the app's declaration."
    (§2); proxied: "Roles are defined in config (virtual) for proxied apps." (edited
    through `app_update` / the YAML, §8/§9). Empty: "No roles declared" + "Grants fall
    back to the built-in `all` role — every tool, present and future."
  - **Overview** — `app_get`'s row as a definition list: slug, created, kind; for proxied
    apps the endpoint, `auth` mode and forward identity; body logging (`On — tunneled
    default` / `Off — proxied default` / the explicit setting, §15); redacted arguments
    and redacted results (the config paths, or `none`).
  - **Agents** — the agents holding at least one grant on this app: `Agent` (slug, and
    its description) / `Granted roles` (one `role · mode` chip per grant; the built-in
    `all` is marked `built-in`), from `agent_list`'s inline grants (§8) filtered to this
    app. The **Edit grants** control targets ~~the (agent × app) grant editor
    (`/agents/<agent>/grants/<slug>`, specced 2026-09-03 — until step 9's code lands the
    control is absent, the pane is read-only, and grants are edited with `grant_set`,
    `pmcp grant set`, §10)~~ *(2026-09-16, decision 31: the agent page's app pane,
    `/agents/<agent>/apps/<slug>`; the old URL answers a `301` to it)*. Agent slugs link
    to `/agents/<slug>` once that page lands;
    text until then. Footer, true of `grant_set` regardless of where it is edited
    *(2026-09-16)*: "Grants are
    edited per agent × app pair — saving replaces that pair's whole set."
  - **Token** — tunneled apps only (proxied: the dimmed entry's pane says "Proxied apps
    hold no tokens — the hub dials the upstream; nothing dials in (§2)."). Every live app
    token (prefix, issued, last used) with **Revoke** (confirm dialog — "Revoking closes
    the app's live connection.", §8's `4001`), and **Issue new token** (`token_issue`
    `{ kind: "app" }`), which renders the once-only reveal in place — the same reveal the
    add-app flow shows — with "The previous token keeps working until you revoke it.":
    more than one live app token is legal (§5 has no per-referent uniqueness), and
    rotation is issue-then-revoke, in that order. Agent tokens are not issued here; they
    belong to the agent.
  - **Danger zone** — **Archive** ("It refuses connections and leaves the list — tokens,
    grants and history are kept.") and **Delete** ("Revokes its tokens, closes the live
    connection and removes every grant. This cannot be undone."), each behind a confirm
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
  (Apps · Agents · Audit · Approvals · Settings); the narrow nav is already a horizontal
  scroller with its scrollbar hidden, so the fifth slot needs no overflow menu — the
  follow-up recorded below is closed. Title "Agents", subtitle "Identities that call your
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
  holds a listing and a details pane side by side. Breadcrumb "Agents / <slug>" (plus
  "/ <app>" on an app pane); header: the slug, an `agent` badge, the name when it differs
  from the slug, the description, `Created`. An unknown, foreign or reserved slug is the
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
    `aria-current="page"`; archived apps are `rail-link--dim`. Mobile: `PanePills`, the
    shell's pill row.
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
    "—"), an Arguments table, and the "What only the
    hub knows" card ("Called as <app>_<tool> on the aggregated endpoint", "Reachable by",
    "Redaction") — the app page's card, computed by the door's own matcher and never a
    second one. A prompt or a resource: the same without arguments. A pattern → a
    `pattern` badge, "An entry that is not one item: anchored, * aliases .*.", Standing,
    and "Matches today · N" with the names.
    **Script is optional.** A small inline script (the audit expanded row's precedent) may
    mark rows whose radio differs from its initial value with the `unsaved` badge and
    count them in the foot, and the rail's blue draft dot is script-only; with scripting
    off **Save still replaces the set and the page is complete**, and nothing in a test
    depends on the script *(2026-09-16)*.
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
    last 7 days, the retention window", and the link "full trail" →
    `/audit?principal=agent:<slug>`; summary "N calls · ok · denied · awaiting approval".
    `Awaiting approval · N` ("each expires an hour after it was asked"): rows with the
    app, the tool, the args (post-redaction, one line) and the age, plus **Reject** /
    **Approve** buttons — forms posting `approval_decide` to
    `/agents/<slug>/approval_decide` and landing back on this pane; a decided row is
    dimmed with its status badge. `Recent calls · N` from `audit_query`
    (`principal=agent:<slug>`, limit 50): app, tool, when, ms, and the outcome badge (`ok`
    / `approval required` / `not permitted` / the failure). Details: an approval → the
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
    `/agents/<slug>/grant`. The app page's Agents pane row action ("Edit grants") links to
    `/agents/<agent>/apps/<app>`.
- ~~`/agents/<slug>/grants/<app>` *(added 2026-09-03)* — the (agent × app) grant editor,
  its own page rather than a dialog so it is linkable and needs no script.~~
  *(2026-09-16, decision 31: **deleted**. The editor is the app pane of `/agents/<slug>`
  above; `grant-editor.tsx` goes with it and `PagePropsByName` loses `grant-editor`, the
  old URL answering the `301` pinned above. What the page pinned and the pane keeps: one
  row per role the app declares (`app_get`'s canonical roles, §20.3) with the built-in
  `all` last, the undeclared-role rule in both kinds — tunneled warns and Save is allowed
  ("<app> hasn't declared <role>. Tunneled apps declare roles when they connect — this
  grant stays dormant until then.", §9: the file may be ahead of first connect), proxied
  is an error and `grant_set` refuses the save ("<app> is proxied — its roles are fixed in
  config, so an undeclared role is an error."), the refusal redrawing the page that
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

**Panes behind a rail** *(added 2026-09-02)*. One shell component serves all three paned
pages — `/settings`, `/apps/<slug>` and `/agents/<slug>` *(2026-09-16: three, not two;
the agent page joined on decision 31)* — and its rules are pinned once. A pane is one
region or two: `/agents/<slug>`'s app pane holds a **listing and a details pane side by
side**, still one route and one rail entry *(2026-09-16)*:

- **A pane is a route.** Each pane has exactly one URL, `/<page>/<pane>`; the page root
  renders the first rail entry (the *landing* pane — `/settings` → Password,
  `/apps/<slug>` → Tools, `/agents/<slug>` → the first granted app in slug order, or the
  grant step when the agent holds none *(2026-09-16)*) and no alias for it exists
  (`/settings/password` and
  `/apps/<slug>/tools` are 404s: one URL per pane). A URL per pane is what lets a link, a
  bookmark, a fixture, and a post-mutation redirect all name one; the rail is navigation,
  never tabs.
- **The rail** groups entries under headings (`Sign-in` / `Access`; `App` / `Access`;
  `Apps` / `Agent` *(2026-09-16)*,
  then the ungrouped Danger zone) and every entry carries its at-a-glance marker — a
  count, the Two-factor status dot, `none`, the amber dot of a pending ask
  *(2026-09-16)*, or the dimmed `—` of a family the app does
  not advertise — read from the same calls that render the panes, never a second query
  that could disagree with them. Every count is the number of rows its pane lists. The
  active entry is `aria-current="page"`; dimmed entries stay links.
- **Mobile** has no room for a rail: below the shell's existing breakpoint the same panes
  become a horizontally scrolling **pill row** under the page title — label only, no
  markers, active pill highlighted and `aria-current="page"` like the rail's active entry
  *(pinned 2026-09-03)*, same routes. This is a shell rule, so it applies to
  `/apps/<slug>` and `/agents/<slug>` although only `MobileSettings` was drawn (follow-up)
  *(2026-09-16: the agent page's mobile board is the same recorded follow-up)*.
- **Mutations belong to a pane**: a POST target keeps the existing final-segment
  convention (its last segment names the op or the better-auth endpoint it fronts), and
  the redirect-back with its notice lands on the pane that rendered the form, not the
  page root. The app page's header is not a pane: its Connect / Reconnect / Disconnect
  land on the app's own Overview pane (`/apps/<slug>/overview`, the pane that reports
  the connection) with the notice there, and a finished Connect (the upstream callback)
  lands the same way; `/apps`'s own row controls still
  land on `/apps` *(2026-09-03, owner question 37(b))*. Confirm-dialog state
  (`?confirm=…`) rides the owning pane's URL for the same reason.
- **A page's gate is every pane's gate**: `/settings/*` is recent-auth and no-bearer
  (§4); `/apps/<slug>/*` and `/agents/<slug>/*` are the ordinary owner session
  *(2026-09-16)*.
- ~~Known follow-up, recorded not solved: the mobile top nav holds four items (Apps,
  Audit, Approvals, Settings) and has no `Agents` entry — 390 px cannot hold five, so the
  deferred agents pages will need a scroller or an overflow menu before they get a slot.~~
  *Closed 2026-09-03:* the top nav holds five (Apps · Agents · Audit · Approvals ·
  Settings); the narrow nav is a horizontal scroller with its scrollbar hidden, which is
  the mechanism — no overflow menu.

**PWA**: the web surface ships a web-app manifest and a minimal service worker, so
the dashboard installs to phone and desktop home screens. Pages stay server-rendered —
the service worker exists for installability and push, not offline rendering (the
no-SPA pin holds, §1). **Approval push**: `/approvals` offers a per-browser "Enable
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
three surfaces; the Tools, Prompts and Resources panes front MCP listings on the scoped
endpoint exactly as `pmcp tools` / `prompts` / `resources` do (§20.6), which is why §8's
parity list does not change. `/settings`'s **Sign-in group and Sessions pane** are the
deliberate exception: credential management (password change, TOTP, passkeys, active
sessions) rides better-auth's endpoints and is intentionally web-only — §4's
session-scope guards reject bearer-sourced sessions there precisely so no CLI token or
`pmcp` tool can ever reach it. The two Access panes that front tools sit behind the same
`/settings` gate because the gate is a prefix rule, not because the tools they front are
hidden from the CLI — they are not.
