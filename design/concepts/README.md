# Concepts — unreviewed exploration boards

Boards that explore a page or state the spec has not adopted (or, for `AuditDetailStates`,
a model — lazy fetching — the spec explicitly did not adopt). Nothing here is contract: no
§13 sentence, no fixture and no test points at them. They moved out of `design/` on
2026-09-02 so the canvas beside the code draws only what the code renders (the states
preview is the kept reference — D15 constraint 13). A board leaves this folder the day the
owner reviews it and §13 is amended (roadmap steps 8, 9 and 10 in
`docs/superpowers/plans/2026-09-02-roadmap-after-d15.md`).

`canvas.json` here keeps their layout; seed them separately if they are reopened in the
design tool. `OauthConsent` itself stayed in `design/` — it draws the live §19.5 page; only
its states board is here, and of that only the DENIED confirmation panel is a concept (the
hub answers a deny with a redirect, never a page).

| Board | Explores |
|---|---|
| `Agents`, `AgentDetail` | `/agents` list + detail: per-app grant cards, agent tokens |
| `GrantEditorStates` | the (agent × app) editor — Save replaces the pair's whole set; undeclared-role warn (tunneled) vs error (proxied); the `all` role |
| `AuditDetailStates` | in-page expanded audit row, lazily fetched: metadata chips, redacted bodies, typed stubs, bodies-off, non-call events |
| `OauthConsent` + `OauthConsentStates` | the §19.5 consent screen (self-registered marker, zero-agents empty state) — a step inside the authorize redirect, never navigated to, so it stays chromeless and gets no nav slot |
| `AppNewProxiedStates` | the proxied add-app branch: headers vs oauth, mid-connect, endpoint error |
| `ReauthGate` | the recent-authentication challenge guarding `/settings` |

Known follow-ups: mobile variants for all of the above; §19.5's empty-state
copy points at `/apps` for creating an agent — the new IA puts that at
`/agents`, an amendment to make when the exploration lands.
