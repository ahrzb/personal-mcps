# Design canvas

Wireframes for the web surface (§13), as Claude Design artboards. This folder is
the **draft of record**: the `.dc.html` files seed the published canvas
(`personal-mcps-ui.html` + `canvas.json` hold the page and layout), visual edits
happen in the published artifact, and a canvas Save publishes a new artifact
version — it does **not** write back here, so after an editing session the folder
needs a sync-back before it is authoritative again.

Nothing here is normative. The rules live in `docs/specs` (§7, §10, §13, §19);
these files render them, and the flow docs below only walk through them.

Every `.dc.html` loads `<script src="./support.js">`. That file is not, and never has
been, part of this folder: the published canvas supplies it at render time, so a local
open of a board 404s on it harmlessly — don't add the file, and don't remove the tag.

## Flows

Reading order for anyone building or testing the UI — each doc maps a journey
onto artboards and cites the section that owns each rule:

1. [Sign-in & device approval](flows/01-login.md)
2. [Tool-call approval](flows/02-approval.md)
3. [Add a tunneled app](flows/03-app-add-tunneled.md)
4. [Add a proxied app & upstream OAuth](flows/04-app-add-oauth.md)
5. [Inbound connect (hub as authorization server)](flows/05-inbound-connect.md)

`/audit` and `/settings` are pages, not journeys — their behavior is pinned
directly in §13 and rendered by the artboards below.

## Artboards

| Screen | Desktop | Mobile | States / extras |
|---|---|---|---|
| Design system (tokens, anatomy) | `Main` | — | — |
| Sign-in, 2FA, backup code, device | `Login`, `TwoFactor`, `Device` | `MobileLogin`, `MobileTwoFactor`, `MobileDevice` | `AuthStates` |
| Approvals list + detail | `Approvals`, `ApprovalDetail` | `MobileApprovals`, `MobileApprovalDetail` | `ApprovalStates` |
| Apps + add-app | `Apps`, `AppNew` | `MobileApps`, `MobileAppNew` | `AppNewStates`, `AppNewProxiedStates` |
| Audit | `Audit` | `MobileAudit` | `AuditDetailStates` |
| Settings — panes behind a left rail | `Settings` (password, full shell + rail), `SettingsPanes` (the other five panes, at pane width — the shell and rail live on `Settings`) | `MobileSettings` | `SettingsStates` |
| App detail (`/apps/<slug>`) — panes behind the same rail | `AppDetail` (tools), `AppDetailPanes` (the other seven) | — (follow-up) | `AppDetailStates` |
| Agents + agent page (`/agents`, `/agents/<slug>`) — three panes behind a rail | `Agents` (the list), `AgentDetail` (an app's grants: rail · listing · details), `AgentDetailPanes` (Credentials, Activity, Grant another app, Danger zone) | `MobileAgentDetail` (the three panes as three levels with back buttons), `MobileAgentDetailStates` (sidebar, draft, grant step, credentials, paged activity, a request) — the list has none yet | `AgentDetailStates` |
| Cross-cutting | — | — | `Dialogs` (destructive confirms), `EmptyStates` |

Settings' six panes, one contract board and width each:

| Pane | Board | Width |
|---|---|---|
| Password | `Settings` | full shell (1240 px) |
| Two-factor | `SettingsPanes` | pane (1012 px) |
| Passkeys | `SettingsPanes` | pane (1012 px) |
| Sessions | `SettingsPanes` | pane (1012 px) |
| Tokens | `SettingsPanes` | pane (1012 px) |
| Connected clients | `SettingsPanes` | pane (1012 px) |

`SettingsTokens` and `OauthConnections` — the two full-shell boards page 2 held for the
Tokens and Connected-clients panes — were **deleted 2026-09-03**, resolving decision
30's duplication note: `SettingsPanes`'s own caption already claims every pane except
Password, and its Tokens and Connected-clients sections were byte-for-byte identical to
theirs (same fixture rows, same footer copy) — a second full-width rendering for only two
of the five non-Password panes was an asymmetry with no content behind it.

Three of those boards (`AppDetail*`, `AuditDetailStates`, `AppNewProxiedStates`) were
drawn as exploration and sit on canvas page 2, re-laid out 2026-09-03; §13 adopted
`AppDetail*` on 2026-09-02 (decision 30) and the other two on 2026-09-03, so all three
are contract wherever they sit. `/apps/<slug>` has no mobile
artboard: the pill row is a shell rule and covers it (§13, *Panes behind a
rail*), but drawing `MobileAppDetail` stays a recorded follow-up.

`/apps/new` and `/approvals/<id>` are chromeless by design — no nav, so no pending badge
and no Sign out (`app-new.tsx`, `approval-detail.tsx`); `AppNew`/`MobileAppNew` and
`ApprovalDetail` draw them that way on purpose.

Each flow doc carries a **wireframe map** table pinning journey moments to
artboard variants by their on-canvas labels (e.g. `AuthStates · DEVICE —
EXPIRED CODE`, `AppNewStates · TOKEN REVEAL`).

## Concepts (moved to `design/concepts/`, 2026-09-02)

The unreviewed exploration boards — `ReauthGate` and `OauthConsentStates` — live in
`design/concepts/` with their own
`canvas.json` and README. Nothing there is contract; a board returns here when the owner
reviews it and §13 is amended. `Agents`, `AgentDetail` and `GrantEditorStates` returned
on 2026-09-03 (roadmap step 9: §13 gained `/agents`, `/agents/<slug>` and the grant
editor with the boards' strings pinned; the top nav's fifth slot rides the narrow nav's
existing scroller). `AuditDetailStates` returned the same day (roadmap step 10: §13 pinned
the three no-bodies sentences, the KB/MB stub sizes and the `event-<id>` anchor) — minus
its LOADING panel: the audit detail is rendered in the page (hidden) and toggled in place
by a click, never fetched (§13, 2026-09-03). `AppNewProxiedStates` returned with roadmap step 11 (§13 pinned the connecting
page, the endpoint URL rule and the field-scoped refusals) — its CONNECTING panel redrawn
as a link and a "Not now" rather than a progress bar, since decision 30 settled that a
create may not depend on a tab a page cannot open. Mobile variants for the five are still
to draw. Canvas page 2 (renamed "App detail, adopted states & consent", re-laid out
2026-09-03) now holds the boards §13 adopted on 2026-09-02 (`AppDetail*`), `OauthConsent`,
which draws the live §19.5 page, `AuditDetailStates` and `AppNewProxiedStates`.
`SettingsTokens` and `OauthConnections` — the exploration-era full-shell duplicates of
`SettingsPanes`'s Tokens and Connected-clients sections — were deleted the same day rather
than re-laid out; see the pane table above.

## Agents, redrawn as three panes (2026-09-16)

The owner chose the agent page's direction from the exploration in `design/concepts/`
(`AgentThreePaneDemo.html`, the clickable prototype, stays there as the reference the
boards were rendered from). `Agents`, `AgentDetail` and the new `AgentDetailPanes` /
`AgentDetailStates` replace the 2026-09-03 boards; `GrantEditorStates` is **deleted**:
the (agent × app) editor is no longer its own page but the listing pane of
`/agents/<slug>`, so a separate editor board would draw a page the design no longer has.

What the boards pin, and what §13 still has to be amended to say (the boards are ahead of
the spec until then — nothing here is contract yet):

- `/agents` is a plain list, one row per agent with one line of totals (apps, reach per
  family, how much asks first, how much is dormant); the whole row is the link to the agent
  page (a stretched anchor, no script) with a hover and a trailing chevron; the only row
  control is Delete. Granting lives on the agent page.
- `/agents/<slug>` is a paned page after all — the earlier "an agent has three holdings
  and no listing to browse" reasoning fell once the page lists what every granted app
  advertises. A **rail** of the agent's apps (amber dot: an ask entry; dash: dormant; blue
  dot: unsaved draft) plus **+ Grant another app…** and the agent's own panes —
  Credentials, Activity, Danger zone; a **listing** of the selected app's roles, tools,
  prompts, resources and pattern entries; a **details** pane for the selected row.
- One control on every row, **none · ask · allow** in that order: solid when set on that
  row, hollow when a role implies it (the role named), the states below a role's disabled.
  Highest wins, allow over ask; there is no deny (§7).
- The grant set gains **inline entries** beside role names — `tool/<pattern>`,
  `prompt/<pattern>`, `resource/<uri-pattern>` — so a single item can be granted or
  asked on its own row, and a pattern typed into the filter can be added as an entry. Role
  names never contain `/`, so the two kinds never collide. `grant_set` and the provider's
  `pmcp_grant` (§22) take the same list; §8 and §22 need the sentence.
- One draft per app: changed rows carry the amber dashed **unsaved** badge, the rail entry
  the blue dot, the foot counts changes with Discard / Save (one `grant_set` per pair);
  switching with a draft shows the save-or-discard banner. **Remove from <agent>** at the
  foot is `grant_set` with the empty set.
- Credentials: Issue with an expiry select, the once-only reveal in place, Revoke on live
  tokens and **Remove** on expired ones (the same `token_revoke`, relabelled — an expired
  key is only a row to clear). The OAuth client is read-only, as before.
- Activity: waiting requests with Approve / Reject on the row, then the last seven days of
  the agent's calls with the audit row's bodies post-redaction.
- Grant another app: the listing alone, wide — one card per active app the agent holds
  nothing on, its endpoints and the roles that grant each behind **show all N**, a search
  over apps and endpoints, and **Grant** opening the app with an empty draft.

The phone rendering (owner-approved 2026-09-16, `MobileAgentDetail`, from
`design/concepts/AgentMobileDemo.html`): the three panes become **three levels of
navigation**, one screen each — the rail as a list, then the listing, then the details —
every level headed by a back button naming the level above (`‹ Agents`, `‹ claude`,
`‹ News MCP`) and the current thing as the title, so a listing header never repeats what
the level header shows; the top bar is the brand and a **hamburger** whose sidebar slides
in from its own side with the five nav entries, the Approvals count and Sign out; Save
stays at the bottom right; the Activity trail is **paged** twenty calls at a time behind
a *Load more* row (a plain link on the real page). Two decisions rode along: the phone drops the
breadcrumb for its level headers (a full path costs width a phone lacks; the desktop keeps
the crumb `Agents › claude › news › get_news`, slugs as the page's badges with the current
one dark, since it is cheap to scan and to click), and on both the `agent` type label is gone (the crumb, the nav and
the menu already say it; the app page keeps its kind label because tunneled / proxied
carries information). `/agents` has no mobile board yet; `Dialogs` keeps the delete-agent
confirm. §13 still describes the narrow layout as the pill row with stacked panes and is
to be amended with the implementation.

## Settings, split into panes (2026-09-02)

`/settings` grew past one scroll, so it is now a left rail of panes —
**Sign-in** (Password, Two-factor, Passkeys) and **Access** (Sessions,
Tokens, Connected clients) — with one pane per route (`/settings/passkeys`,
…) and the rail carrying at-a-glance counts. Mobile has no room for a rail,
so the same sections become a horizontally scrolling pill row.

The **Password** pane is new functionality, not a re-render: §4 stated there
was no self-serve password change and that the users script (§12) was the
only password path. §4 and §13 are amended for it (decision 30). Two things
the draft deliberately keeps from §12: changing the password
requires the current one (plus the §4 recent-auth gate, `ReauthGate`), and
recovery for a *forgotten* password stays `pnpm users reset-password` —
there is no email on file, so there can be no reset link. `SettingsStates`
carries the three password states (wrong current, rejected new, updated).

*Closed 2026-09-03:* the mobile top nav holds five (Apps · Agents · Audit ·
Approvals · Settings) — the narrow nav is already a horizontal scroller with
its scrollbar hidden, which is the mechanism (§13; `layout.tsx`'s `NAV`), so
no overflow menu was needed.

### Connected clients found a home (2026-09-02)

`/oauth/connections` was **unreachable**: a grep of `server/src` finds the
route registration and its POST dispatcher and nothing else — no page links
to it, so it could only be opened by typing the URL. `model.ts` calls it "a
settings page reached from a link"; that link was never built, and §13 names
no nav slot for it.

It is now the third pane of **Settings → Access**, after Sessions and Tokens:
the three are one family — everything holding a way in, each with a Revoke.
Sessions is the owner, Tokens is their own apps and agents, Connected clients
is outside software acting on their behalf. `AgentDetail` gains a read-only
row for the clients bound to that agent (§19 binds each to one, via
`oauth_binding.agent_id`), linking back to the pane rather than duplicating
its Revoke. §13 settled the URL: the pane is `/settings/clients`, and
`/oauth/connections` answers a `301` to it (the POST moves with the pane), so
every pane is `/settings/<pane>` and the rail's active state and §4's gate
stay one prefix rule with no exception to carry.
