# Design canvas

Wireframes for the web surface (§13), as Claude Design artboards. This folder is
the **draft of record**: the `.dc.html` files seed the published canvas
(`personal-mcps-ui.html` + `canvas.json` hold the page and layout), visual edits
happen in the published artifact, and a canvas Save publishes a new artifact
version — it does **not** write back here, so after an editing session the folder
needs a sync-back before it is authoritative again.

Nothing here is normative. The rules live in `docs/specs` (§7, §10, §13, §19);
these files render them, and the flow docs below only walk through them.

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
| Apps + add-app | `Apps`, `AppNew` | `MobileApps`, `MobileAppNew` | `AppNewStates` |
| Audit | `Audit` | `MobileAudit` | `AuditDetailStates` |
| Settings — panes behind a left rail | `Settings` (password + the rail), `SettingsPanes` (every other pane at pane width), `SettingsTokens` and `OauthConnections` (tokens and connected clients full width) | `MobileSettings` | `SettingsStates` |
| App detail (`/apps/<slug>`) — panes behind the same rail | `AppDetail` (tools), `AppDetailPanes` (the other seven) | — (follow-up) | `AppDetailStates` |
| Cross-cutting | — | — | `Dialogs` (destructive confirms), `EmptyStates` |

Four of those boards (`AppDetail*`, `SettingsTokens`, `OauthConnections`,
`AuditDetailStates`) were drawn as exploration and still sit on canvas page 2;
§13 adopted the first three on 2026-09-02 (decision 30) and the audit detail states on
2026-09-03, so they are contract wherever they sit, until the canvas is re-laid out. `/apps/<slug>` has no mobile
artboard: the pill row is a shell rule and covers it (§13, *Panes behind a
rail*), but drawing `MobileAppDetail` stays a recorded follow-up.

Each flow doc carries a **wireframe map** table pinning journey moments to
artboard variants by their on-canvas labels (e.g. `AuthStates · DEVICE —
EXPIRED CODE`, `AppNewStates · TOKEN REVEAL`).

## Concepts (moved to `design/concepts/`, 2026-09-02)

The unreviewed exploration boards — `AppNewProxiedStates`, `ReauthGate`,
`OauthConsentStates` — live in `design/concepts/` with their own
`canvas.json` and README. Nothing there is contract; a board returns here when the owner
reviews it and §13 is amended. `Agents`, `AgentDetail` and `GrantEditorStates` returned
on 2026-09-03 (roadmap step 9: §13 gained `/agents`, `/agents/<slug>` and the grant
editor with the boards' strings pinned; the top nav's fifth slot rides the narrow nav's
existing scroller). `AuditDetailStates` returned the same day (roadmap step 10: §13 pinned
the three no-bodies sentences, the KB/MB stub sizes and the `event-<id>` anchor) — minus
its LOADING panel, since the spec kept the synchronous render and never adopted the lazy
fetch. Mobile variants for the four are still to draw. Canvas page 2 now holds
the boards §13 adopted on 2026-09-02 (`AppDetail*`, `SettingsTokens`,
`OauthConnections`), `OauthConsent`, which draws the live §19.5 page, and
`AuditDetailStates`.

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

Also open: the mobile top nav still lists four items and has no `Agents`
entry — 390 px cannot hold five, so it needs a scroller or an overflow menu.

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
