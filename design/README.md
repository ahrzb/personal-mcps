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
| Settings (TOTP, passkeys, sessions) | `Settings` | `MobileSettings` | `SettingsStates` |
| Cross-cutting | — | — | `Dialogs` (destructive confirms), `EmptyStates` |

Each flow doc carries a **wireframe map** table pinning journey moments to
artboard variants by their on-canvas labels (e.g. `AuthStates · DEVICE —
EXPIRED CODE`, `AppNewStates · TOKEN REVEAL`).

## Admin exploration (page 2 of the canvas — UNREVIEWED drafts, 2026-09-01)

Desktop-only exploration boards for the admin-surface extension. §13 is
amended only after these settle; until then nothing here is contract:

| Board | Explores |
|---|---|
| `AppDetail` + `AppDetailStates` | `/apps/<slug>`: overview, canonical role shapes, app token, read-only access panel; proxied/reconnect/reveal/archived states |
| `Agents`, `AgentDetail` | `/agents` list + detail: per-app grant cards, agent tokens |
| `GrantEditorStates` | the (agent × app) editor — Save replaces the pair's whole set; undeclared-role warn (tunneled) vs error (proxied); the `all` role |
| `AuditDetailStates` | in-page expanded audit row, lazily fetched: metadata chips, redacted bodies, typed stubs, bodies-off, non-call events |
| `SettingsTokens` | placement variant B — the namespace-wide tokens list as a section under `/settings` (variant A is the sections on the two detail boards); no Issue button — issuing stays on detail pages |
| `OauthConsent` + `OauthConsentStates`, `OauthConnections` | the §19.5 consent screen (self-registered marker, zero-agents empty state) and the connections list |
| `AppNewProxiedStates` | the proxied add-app branch: headers vs oauth, mid-connect, endpoint error |
| `ReauthGate` | the recent-authentication challenge guarding `/settings` |

Known follow-ups: mobile variants for all of the above; §19.5's empty-state
copy points at `/apps` for creating an agent — the new IA puts that at
`/agents`, an amendment to make when the exploration lands.
