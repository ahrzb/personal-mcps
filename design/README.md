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
| Audit | `Audit` | `MobileAudit` | — |
| Settings — panes behind a left rail | `Settings` (password), `SettingsPanes` (two-factor, passkeys, sessions) | `MobileSettings` | `SettingsStates` |
| Cross-cutting | — | — | `Dialogs` (destructive confirms), `EmptyStates` |

Each flow doc carries a **wireframe map** table pinning journey moments to
artboard variants by their on-canvas labels (e.g. `AuthStates · DEVICE —
EXPIRED CODE`, `AppNewStates · TOKEN REVEAL`).

## Admin exploration (page 2 of the canvas — UNREVIEWED drafts, 2026-09-01)

Desktop-only exploration boards for the admin-surface extension. §13 is
amended only after these settle; until then nothing here is contract:

| Board | Explores |
|---|---|
| `AppDetail` + `AppDetailPanes` + `AppDetailStates` | `/apps/<slug>` behind the same left rail as Settings — **App** (Tools, Roles, Overview) and **Access** (Agents, Token), with the danger zone last — a neutral rail
item, since red on a nav entry reads as the destructive button itself.
The App group carries one entry per §20 family, dimmed with `—` when the app
advertises none (mcp-tools is tools-only). Tool rows expand to the real
input schema, plus what only the hub knows: the aggregated call name, which
agents reach it through which role, approval and redaction posture `AppDetail` is the shell landing on Tools (the real `mcp-tools` five); `AppDetailPanes` holds the rest at pane width; proxied/reconnect/reveal/archived states are unchanged |
| `Agents`, `AgentDetail` | `/agents` list + detail: per-app grant cards, agent tokens |
| `GrantEditorStates` | the (agent × app) editor — Save replaces the pair's whole set; undeclared-role warn (tunneled) vs error (proxied); the `all` role |
| `AuditDetailStates` | in-page expanded audit row, lazily fetched: metadata chips, redacted bodies, typed stubs, bodies-off, non-call events |
| `SettingsTokens` | placement variant B — the namespace-wide tokens list as a pane under `/settings` (variant A is the sections on the two detail boards); no Issue button — issuing stays on detail pages |
| `OauthConsent` + `OauthConsentStates` | the §19.5 consent screen (self-registered marker, zero-agents empty state) — a step inside the authorize redirect, never navigated to, so it stays chromeless and gets no nav slot |
| `OauthConnections` | the connections list, re-shelled as the **Connected clients** pane of `/settings` (see below) |
| `AppNewProxiedStates` | the proxied add-app branch: headers vs oauth, mid-connect, endpoint error |
| `ReauthGate` | the recent-authentication challenge guarding `/settings` |

Known follow-ups: mobile variants for all of the above; §19.5's empty-state
copy points at `/apps` for creating an agent — the new IA puts that at
`/agents`, an amendment to make when the exploration lands.

## Settings, split into panes (2026-09-02, UNREVIEWED)

`/settings` grew past one scroll, so it is now a left rail of panes —
**Sign-in** (Password, Two-factor, Passkeys) and **Access** (Sessions,
Tokens) — with one pane per route (`/settings/passkeys`, …) and the rail
carrying at-a-glance counts. Mobile has no room for a rail, so the same
sections become a horizontally scrolling pill row.

The **Password** pane is new functionality, not a re-render: §4 currently
states there is no self-serve password change and the users script (§12) is
the only password path. Shipping the pane means amending §4 and §13 first.
Two things the draft deliberately keeps from §12: changing the password
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
its Revoke. The URL can stay under `/oauth/` — the fix is the rail entry, not
a new path — but a `/settings/clients` route with a redirect is equally fine;
either way §13 gains a slot it currently lacks.
