# Inbound connect — the hub as authorization server

An external MCP client (claude.ai, an agent) connects to the hub with OAuth and
walks away holding exactly one agent's power. Rules: §19 (all of it —
"§19 pins the flow"), §13 (`/oauth/consent`, `/settings/clients`).

## Wireframe map

| Journey moment | Artboard |
|---|---|
| Consent screen, known client, one agent picked | `OauthConsent` |
| Consent screen, self-registered client | `OauthConsentStates · SELF-REGISTERED CLIENT` (concept, unadopted) |
| Consent screen, zero agents | `OauthConsentStates · NO AGENTS` (concept, unadopted) |
| Deny redirects, no page | `OauthConsentStates · DENIED` (concept, unadopted) |
| Connections list with Revoke | `SettingsPanes · Connected clients` |

`OauthConsent` draws the live §19.5 page (adopted 2026-09-02, decision 30); the three
`OauthConsentStates` variants above are still exploration in `design/concepts/` (see its
README) — the owner has not reviewed them, so §19.5's SELF-REGISTERED CLIENT, NO AGENTS
and DENIED copy is pinned in the spec, not yet contract in a shipped board.

## The journey

1. The client hits `authorize`. With no session it is redirected to `/login`
   with an opaque **signed query** the login page carries through byte-for-byte;
   the post-login target is a constant built in code — the login page never
   reads a destination from the request (§19.5 step 1, the anti-phishing pin).
2. With a session and no covering consent, the browser lands on
   `/oauth/consent?<signed query>`. The page echoes the query back
   **byte-for-byte** — it cannot invent, drop, or edit a parameter (§19.5
   step 2).
3. The consent screen always shows (§19.5 step 3):
   - the client's **name**, rendered as untrusted text — never markup, never a
     link — with an explicit **"registered itself — identity unverified"**
     marker for DCR clients;
   - the **origin of the `redirect_uri`** — the one attacker-controlled string
     a human can actually check;
   - the requested scopes and the **namespace** the token will be bound to;
   - the **agent picker**: a select over `agent_list`, defaulted to
     nothing, beside the sentence that the client will be able to do exactly
     what that agent can.
4. **Empty state, pinned** (§19.5): zero agents is the first-run
   path. The picker renders an empty state naming `/apps` as where to
   create one, submit is **disabled**, Deny still works. No inline create, no
   implicit default agent.
5. The POST goes through the full mutation gate (session → form → CSRF → body,
   same as `/apps`). The handler **verifies before it writes**: provider
   consent endpoint first, and only on success does it upsert the binding,
   write `oauth.consented`/`oauth.rebound`, and redirect to the provider's
   `redirect_uri`. A refusal writes nothing. Deny returns `access_denied`
   (§19.5 step 4).
6. `/settings/clients` lists the resulting connections with **Revoke** (§19) — the third
   pane of Settings → Access; `/oauth/connections` answers a `301` to it.

## Still to draw

Mobile variants of `OauthConsent`; the owner review that would move
`OauthConsentStates`' three panels (self-registered marker, zero-agents empty state,
the Deny redirect) out of `design/concepts/` and into contract. The consent screen is
the whole security boundary of §19 — its copy deserves the same care `Device` got.
