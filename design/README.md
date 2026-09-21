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

Every desktop board is drawn at one of the three page shapes of
[layout-and-density.md](layout-and-density.md) §2, and its artboard is that shape plus its
gutters:

| Shape | Content | Artboard | Boards |
|---|---|---|---|
| **document** | 760 px (auth card 400) | 1080, or 480 for a card board | `Approvals`, `ApprovalDetail`, `AppNew`, `Login`, `TwoFactor`, `Device`, the states boards |
| **table** | 1280 px, centred | 1380 | `Apps`, `Agents` |
| **workspace** | full width inside 24 px gutters — 1332 — the *panes* capped (rail 200, listing 520, details the rest) | 1380 | `Settings`, `AppDetail`, `AgentDetail`, `Audit` |

`SettingsPanes`, `AppDetailPanes` and `AgentDetailPanes` are gallery boards, not pages:
they draw one pane each at the width that pane has inside the frame, so their artboards
(1012, 1380, 1380) follow the pane, not the shape.

| Screen | Desktop | Mobile | States / extras |
|---|---|---|---|
| Design system (tokens, anatomy; the layout & density ladder, reasoned in [layout-and-density.md](layout-and-density.md)) | `Main` | — | — |
| Sign-in, 2FA, backup code, device | `Login`, `TwoFactor`, `Device` | `MobileLogin`, `MobileTwoFactor`, `MobileDevice` | `AuthStates` |
| Approvals list + detail | `Approvals`, `ApprovalDetail` | `MobileApprovals`, `MobileApprovalDetail` | `ApprovalStates` |
| Apps + add-app | `Apps`, `AppNew` | `MobileApps`, `MobileAppNew` | `AppNewStates`, `AppNewProxiedStates` |
| Audit (`/audit`) — the explorer: Summary · Sessions · Events over one filtered set | `Audit` (Summary, whole window), `AuditViews` (Events brushed and filtered; Sessions on a waterfall) | `MobileAudit` (Summary, Events, Sessions, the Filters level, the record level) | `AuditDetailStates` (the record, and the page's seven states) |
| Settings — panes behind a left rail | `Settings` (password, the workspace shell: rail 200 in the framed box), `SettingsPanes` (the other five panes, at pane width — the shell and rail live on `Settings`) | `MobileSettings` | `SettingsStates` |
| App detail (`/apps/<slug>`) — three panes behind a rail | `AppDetail` (Catalog: rail · listing · details), `AppDetailPanes` (Roles, Recording, Agents, Token, Overview, Danger zone) | `MobileAppDetail` (the three panes as three levels), `MobileAppDetailStates` (sidebar, Roles editor, Recording, the grant editor, Token) | `AppDetailStates` |
| Agents + agent page (`/agents`, `/agents/<slug>`) — three panes behind a rail | `Agents` (the list), `AgentDetail` (an app's grants: rail · listing · details), `AgentDetailPanes` (Credentials, Activity, Grant another app, Danger zone) | `MobileAgents` (the list as cards, the row the link), `MobileAgentDetail` (the three panes as three levels with back buttons), `MobileAgentDetailStates` (sidebar, draft, grant step, credentials, paged activity, a request) | `AgentDetailStates` |
| Cross-cutting | — | — | `Dialogs` (destructive confirms), `EmptyStates` |

Settings' six panes, one contract board and width each:

| Pane | Board | Width |
|---|---|---|
| Password | `Settings` | the workspace shell — 1380 artboard, 1332 inside its gutters, rail 200 + pane |
| Two-factor | `SettingsPanes` | pane (1012 px artboard) |
| Passkeys | `SettingsPanes` | pane (1012 px artboard) |
| Sessions | `SettingsPanes` | pane (1012 px artboard) |
| Tokens | `SettingsPanes` | pane (1012 px artboard) |
| Connected clients | `SettingsPanes` | pane (1012 px artboard) |

`SettingsTokens` and `OauthConnections` — the two full-shell boards page 2 held for the
Tokens and Connected-clients panes — were **deleted 2026-09-03**, resolving decision
30's duplication note: `SettingsPanes`'s own caption already claims every pane except
Password, and its Tokens and Connected-clients sections were byte-for-byte identical to
theirs (same fixture rows, same footer copy) — a second full-width rendering for only two
of the five non-Password panes was an asymmetry with no content behind it.

Three of those boards (`AppDetail*`, `AuditDetailStates`, `AppNewProxiedStates`) were
drawn as exploration and sit on canvas page 2, re-laid out 2026-09-03; §13 adopted
`AppDetail*` on 2026-09-02 (decision 30) and the other two on 2026-09-03, so all three
are contract wherever they sit. The three `AppDetail*` boards were **redrawn on
2026-09-17** — the eight-pane drawing became the three-pane capture below — and page 2
gained the two phone boards beside them (`MobileAppDetail`, `MobileAppDetailStates`), so
`/apps/<slug>` no longer lacks a mobile artboard. The same day the app page's crumb folded
into the title line ("Apps › <name>") and every `Apps` row became the link, as the agents
list's rows are.

`/apps/new` and `/approvals/<id>` are chromeless by design — no nav, so no pending badge
and no Sign out (`app-new.tsx`, `approval-detail.tsx`); `AppNew`/`MobileAppNew` and
`ApprovalDetail` draw them that way on purpose.

Each flow doc carries a **wireframe map** table pinning journey moments to
artboard variants by their on-canvas labels (e.g. `AuthStates · DEVICE —
EXPIRED CODE`, `AppNewStates · TOKEN REVEAL`).

**Applied 2026-09-16: the layout & density ladder.** Every board was brought to
[layout-and-density.md](layout-and-density.md) §2. `Apps`, `Agents` and `Audit` went from a
1140 wrap in a 1240 artboard to the table shape — 1280 in 1380, nav gutters 32 → 24.
`Settings` and `AppDetail` became workspaces: their rail and pane now sit in the same
1px-bordered, radius-12 box the agent page uses, the rail 200 wide on the sunken ground,
the pane beside it, in a 1380 artboard with a 1332 wrap. `AgentDetail` and
`AgentDetailPanes` kept their frame and took the same widths (wrap 1176 → 1332, rail
180 → 200). `Login` and `TwoFactor` moved to the 400 auth card in a 480 artboard, matching
`Device` / `ApprovalDetail` / `AppNew`. `Approvals` stays a 760 document. Everywhere: one
badge at 20 / 11 (was 22 / 12), buttons 28 and 30 → 32 and minis / segments 22 → 24
(segment width 44), table header rows at 12 px vertical padding with `Audit`'s rows dense
at 6, the narrow nav row clipped like the scroller it is, and nothing below 11 px — the
10 px family labels, rail eyebrows and count pills and the 9 px info glyph all moved up.
`canvas.json` carries the new sizes and page 1 was re-laid out around them. Two things the
ladder did not settle, both left as drawn: the framed rail's 28 px entries (pinned by the
2026-09-16 density commit as the board's dense column, not the 40 px default row) and the
28 px monospace cells that display a backup code or a token prefix — they are values on
show, not controls, so no control height applies.

## Concepts (moved to `design/concepts/`, 2026-09-02)

The unreviewed exploration boards — `ReauthGate` and `OauthConsentStates` — live in
`design/concepts/` with their own
`canvas.json` and README. Nothing there is contract; a board returns here when the owner
reviews it and §13 is amended. `Agents`, `AgentDetail` and `GrantEditorStates` returned
on 2026-09-03 (roadmap step 9: §13 gained `/agents`, `/agents/<slug>` and the grant
editor with the boards' strings pinned; the top nav's fifth slot rides the narrow nav's
existing scroller). `AuditDetailStates` returned the same day (roadmap step 10: §13 pinned
the three no-bodies sentences, the KB/MB stub sizes and the `event-<id>` anchor) — minus
its LOADING panel: the audit detail was rendered in the page (hidden) and toggled in place
by a click, never fetched (§13, 2026-09-03). *That board was replaced on 2026-09-21 by the
explorer's record drawer, which does fetch its bodies by id, and moved to page 1 with the
rest of the audit cluster; the section below carries the new drawing.* `AppNewProxiedStates` returned with roadmap step 11 (§13 pinned the connecting
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
a crumb but folds it into the title line — `Agents › claude`, the ancestor small and the
page itself big — so the agent is named once; the rail names the app and the listing the
row, which is where the deeper path already lives), and on both the `agent` type label is gone (the crumb, the nav and
the menu already say it; the app page keeps its kind label because tunneled / proxied
carries information). `MobileAgents` (2026-09-17) draws `/agents` on the phone the way
`MobileApps` draws `/apps` — one card, one section per agent, the section the link with a
chevron, Delete above the stretched anchor, and the desktop's six columns folded into four
stacked lines because a phone has no room for a header row to name them. `Dialogs` keeps
the delete-agent confirm. §13 still describes the narrow layout as the pill row with
stacked panes and is to be amended with the implementation.

## The app page, redrawn as three panes (2026-09-17)

The owner asked for the app page to follow the agent page, and chose the direction from
`design/concepts/AppThreePaneDemo.html` (the clickable prototype, drawn 2026-09-16 and
refined with the owner through that day; it stays there as the reference the boards were
captured from, as `AgentThreePaneDemo.html` does). `AppDetail`, `AppDetailPanes` and
`AppDetailStates` replace the 2026-09-02 eight-pane boards; `MobileAppDetail` and
`MobileAppDetailStates` are new, captured from `design/concepts/AppMobileDemo.html` — the
same demo transformed to 390 px.

What the boards pin (the dispatch brief
`docs/superpowers/plans/2026-09-17-app-three-pane.md` is what the code follows; where the
demo and the brief differed, the brief won):

- `/apps/<slug>` is the workspace shape: a **rail**, a **listing** and a **details** pane
  in one framed box. Seven panes — **App**: Catalog (the landing), Roles, Recording,
  Overview; **Access**: Agents, Token; then the tail entry Danger zone. Each rail marker is
  that pane's own count; Recording's is the Two-factor status dot, lit when body logging is
  on. Overview, Danger zone and a **proxied** Token render the listing alone, wide.
- The header is the agent page's: the crumb folded into the title line (`Apps › News MCP`,
  the ancestor small and the page big), then the slug, kind and status badges, the
  description as the subtitle, and **one tiles line** of totals ending in `last seen` for a
  tunneled app — so the old separate "Last seen" note is gone. The kind badge stays:
  tunneled / proxied carries information the nav does not.
- **Catalog** folds Tools, Prompts and Resources into one listing with family groups and
  `none advertised` headers; the row is the `?sel=` link and carries one badge per agent
  that reaches it (`claude`, or `claude · ask` in amber) or the dim `no agent`. Its details
  read the schema's *leaves* as dotted paths (`auth.api_key`), not top-level fields, and
  end in the four lines the audit row and the agent page show for the same endpoint.
- **Roles** is a data-model extension, not a re-render: an app's declaration and the
  owner's definitions are two sources merged at read time, the app's winning by name. A row
  carries its source badge — `built-in` / `app` / `app · replaced yours` / `yours` — and a
  shadowed role stays read-only while saying so; nothing the owner defined is lost, and it
  returns if the app stops declaring the name. **New role** adds one by ticking items or
  adding a pattern from the filter. Which op field the save writes follows the kind
  (`owner_roles` tunneled, `roles` proxied) and the page never mixes them — a proxied app
  declares none, so every role there is the owner's.
- **Recording** is the approved `AppRecordingDemo` in this grammar: one row per *path*
  across every tool's schema, a tick masking it on every editable tool as one literal
  (tool, path) entry — never a pattern, nothing typed. `writeOnly` fields are locked (the
  app declared them); a path masked on some tools but not all renders expanded with a mixed
  glyph and no path-level field, so no save can silently clear a partial state. A proxied
  app with logging on and nothing masked gets the warning that its schema is not cached at
  call time. The details pane says what ends up masked and what a recorded call keeps; the
  raw `app_update` JSON an earlier draft showed is gone — it read as the opposite of a mask
  in a pane about recording.
- **Agents** edits existing grants with **the agent page's grant editor, verbatim** — the
  same rows, the same `none · ask · allow` control, the same field names, one shared
  component rendered by both pages. Granting a *new* agent is not started here (it
  complicated the flow); a note points at the agent's own page.
- Three forms, three ops, one each: `app_update { owner_roles | roles }`,
  `app_update { log_bodies, redact, redact_results }`, `grant_set` — the same composer the
  agent page's route uses. Each pane's foot carries Discard and Save — on Roles they sit
  in the **editor's** foot, beside Delete role and its hint, because the listing foot
  carries **New role** alone (owner's ruling, 2026-09-17); a new role gets that foot too,
  without the Delete a saved one carries.
- The unsaved language is the agent page's — the amber dashed **unsaved** badge on every
  changed row whatever the change, a counted "N unsaved changes" in the foot, a blue dot on
  the rail entry and the row that hold a draft, and one save-or-discard banner guarding a
  switch. Both the banner and the dots are **script-only**: the shipped pages are
  server-rendered with scripting off and drop them, exactly as the agent page did.

The phone rendering (`MobileAppDetail`, from `design/concepts/AppMobileDemo.html`): the
three panes become **three levels** — 1 the header and the rail as a list, 2 a pane's
listing, 3 a row's details — each headed by a back button naming the level above
(`‹ Apps`, `‹ News MCP`, `‹ Catalog`) and the current thing as the title, so a listing
header never repeats what the level header shows; a wide pane has no level 3. The top bar
is the brand and the same **hamburger** sidebar. `AppDetailStates` and
`MobileAppDetailStates` carry what is not a pane: the new-role editor, the shadowed
`publisher` row and its details, a proxied app's Roles and its Recording warning, a filter
that matches nothing, the revoke confirm, the once-only token reveal, and the remove-agent
confirm in the Agents foot.

## The audit page, redrawn as an explorer (2026-09-21)

The owner asked for `/audit` to stop being a plain table and chose the direction from
`design/concepts/AuditDemo.html` ("this concept is insanely good", 2026-09-21); it stays
there as the clickable reference the boards were captured from, as
`AgentThreePaneDemo.html` and `AppThreePaneDemo.html` do. `Audit` is redrawn, `AuditViews`
is new, and `AuditDetailStates` and `MobileAudit` replace the expanded-row and phone-table
boards. The capture script is
[`docs/superpowers/plans/tools/capture-audit.mjs`](../docs/superpowers/plans/tools/capture-audit.mjs).

What the boards pin (the dispatch brief
`docs/superpowers/plans/2026-09-21-audit-explorer.md` is what the code follows; where the
demo and the brief differed, the brief won). **§13 is being amended in the same dispatch —
until it is, the boards are ahead of the spec and nothing here is contract yet:**

- **One page, three readings of one filtered set.** `view=summary|sessions|events`, and
  the window, the facets and the search are one state in the URL (`since`/`until`,
  repeated `principal` / `app` / `event` / `tool` / `outcome` / `session`, `q`, `expand`,
  `open`) — so every state a board draws is a link. `/audit` becomes the SPA's third route
  family; `server/src/pages/audit.tsx` goes.
- **The workspace shape**, not the table shape: full width inside 24 px gutters, the facet
  rail 200 px as its own card, 12 px between cards. `Audit` moves rows in the shape table
  above. Rows are dense (32 px, 6 / 16), controls 32 / 24, badges and chips 20 / 11, and
  the demo's 10 px axis labels and rail eyebrows came up to 11.
- **A lane strip is the window control**: one lane per principal (at most six, busiest
  first, the rest folded into "N others"), one cell per hour, each cell the *worst*
  outcome in that hour under the current facets and search. Drag selects; **1h · 24h · 7d**
  sit beside the title with the last labelled from `retentionDays`, and **Whole window**
  clears — the label never names a week, because retention is a deploy-time knob. ←/→ move
  the brush by an hour on the focused strip, Shift+←/→ resize it.
- **Colour never carries an outcome alone.** Five classes — `ok`, `approval` (−32003),
  `archived` (−32002), `denied` (−32001, −32000), `error` — and the class *name* is printed
  beside every swatch, chip and legend entry, the raw codes after it where they differ.
- **Facets count exhaustively** (Hearst): a value's count is taken under every other filter
  but its own group's, so a group never collapses to one row as you click. Top 5 (6 for
  tool and event) with **Show all N** in place; `session` is never listed — it is set from
  a record.
- **Events merges what belongs together.** Rows sharing a `detail.approvalId` are one
  chain row with its sentence ("asked for approval → you approved 18:00 → ran ok 1.2 s");
  consecutive un-chained rows with the same (event, app, tool, principal, outcome,
  `detail.failureClass`) collapse to ×N runs. **Sessions** folds runs of more than two
  `ok` calls inside its waterfall. Both page behind **Load more** (120 / 40).
- **The record is a request inspector** — a 620 px drawer over a scrim: search within the
  record, the field table with every id a button that filters by it, the bodies as JSON
  trees with stubs and `‹redacted›` drawn as what they are, §13's three no-bodies
  sentences verbatim, and a chain record's siblings as a timeline.
- **The data is the ledger's own.** `AuditDemo.data.js` was rewritten against the
  `record(` call sites in `server/src`: `detail.approvalId` on the four `approval.*` rows
  (outcome `ok`) and on both call rows brief §1 adds, **no** `reason` on any refusal,
  `detail.failureClass` on a −32000, and every other `detail` checked against its writer.
  A board that draws an invented field is a board that teaches the wrong page.

The phone rendering (`MobileAudit`) is **responsive rules in the same demo file**, not a
second demo: one column, the view segment full width at 44 px, lane names above their
cells and **no drag** — the presets and tapping a day on the axis set the window — the rail
as a **Filters · N** full-screen level headed `‹ Audit` with a sticky **Show N events**,
two-line event cards, two-line session headers with labels above their bars, and the record
as a full-screen level rather than a drawer. 768–1023 keeps the desktop layout with the
rail above the main pane as a wrapping row of groups. Because the rules are a media query
rather than a file, the capture re-scopes them to one 390 px phone for the board — every
rule in the demo's narrow block starts with `body ` so that swap is one token.

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
