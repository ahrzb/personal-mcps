## 2. Concepts

- **User** — a human, owner of a namespace. Every user is the admin *of their own
  namespace* (services, service accounts, grants); there is no cross-namespace access.
  Created by a repo script; password + optional TOTP second factor and/or passkey.
  Usernames are `[a-z0-9-]`, minus a reserved list, since they become top-level URL
  segments: every top-level route segment the Worker serves is reserved — currently
  `login`, `device`, `account`, `audit`, `approvals`, `services`, `oauth`, `api`,
  `connect`, `internal`, the three shell assets `manifest.webmanifest`, `sw.js`,
  `styles.css` *(amended 2026-08-26: the stylesheet became a served segment)*,
  `.well-known` *(amended 2026-08-26: OAuth discovery documents, §19 — the dot already
  puts it outside the username charset, like the shell assets, and it is reserved anyway
  so the walk stays total)*, plus
  `mcp`. Adding a top-level route extends this set; the
  implementation must derive the reserved list from the route table (or enforce the
  equivalence with a test that walks the router), so the two can never drift.
- **Service** — a registered MCP service. Identified by `(owner, slug)` — slugs are
  `[a-z0-9-]` (no underscore; §7 relies on this), unique per owner. Two kinds:
  - *tunneled* (the "bot"): dials in over WebSocket, at most one live connection,
    declares its roles at connect time. Lifecycle: provisioned → online ↔ offline, plus
    reversible **archived** and terminal deletion (§6, "Service lifecycle").
  - *proxied*: an upstream MCP endpoint URL the hub forwards to. No connection, no
    online/offline; roles are defined in config ("virtual roles"), not by the upstream.
    Lifecycle is just provisioned / archived / deleted.
- **Role** — named subset of a service's tools *(amended 2026-08-26: **and** of its
  prompts and resources — §20 gives a role one pattern list per primitive family; a bare
  pattern list, the shape below, still means tools and nothing else)*. Declared in code at
  registration for
  tunneled services (`{"reader": ["get_news", "search_.*"]}`), in the YAML / admin tools
  for proxied ones. Patterns are **anchored regexes** over tool names (a pattern made
  only of tool-name characters `[A-Za-z0-9._-]` is matched as a literal tool name — §7
  pins the rule; anything else compiles as a regex, and `*` is accepted as an alias for
  `.*`). Every service additionally
  has the built-in wildcard role **`all`** matching all tools, present and future, with
  no declaration needed — for both kinds. (`all` is a reserved role name — never
  declarable, only grantable; it was renamed from `*`, which read like a regex.) Trust boundary, stated plainly: roles confine
  the *service account*, not the service — a tunneled service self-declares its roles,
  so granting any role on it trusts that service fully (a compromised bot can widen its
  own roles; the hub logs such drift, §6, but the blast radius is accepted as
  one-service-wide).
- **Service account** — an identity for an AI agent or system (`claude`, `cron`). Holds
  **grants**.
- **Grant** — (service account, service, role, mode). A service account may call exactly
  the tools matched by the union of its granted roles per service. `mode` is `allow`
  (default) or `approval`: an approval-mode call does not execute until the owner
  approves that specific request (§7, "Approval flow") — so per tool an account can't
  call it, can call it, or can call it with per-request approval. A tool matched by
  both an allow-mode and an approval-mode role is allowed outright (allow wins; approval
  is the weaker form of allow). Owners are never approval-gated.
- **Token** — bearer credential. Three kinds:
  - *user token*: better-auth session token obtained by the CLI via device flow → admin access.
  - *service-account token*: long-lived API key bound to a service account → limited by grants.
  - *service token*: long-lived API key bound to a **tunneled** service → only valid for
    opening the reverse WebSocket as that service. Proxied services have no tokens.

