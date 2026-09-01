## 2. Concepts

- **User** — a human, owner of a namespace. Every user is the admin *of their own
  namespace* (apps, agents, grants); there is no cross-namespace access.
  Created by a repo script; password + optional TOTP second factor and/or passkey.
  Usernames are `[a-z0-9-]`, minus a reserved list, since they become top-level URL
  segments: every top-level route segment the Worker serves is reserved — currently
  `login`, `device`, `settings`, `audit`, `approvals`, `apps`, `oauth`, `api`,
  `connect`, `internal`, the three shell assets `manifest.webmanifest`, `sw.js`,
  `styles.css` *(amended 2026-08-26: the stylesheet became a served segment)*,
  `.well-known` *(amended 2026-08-26: OAuth discovery documents, §19 — the dot already
  puts it outside the username charset, like the shell assets, and it is reserved anyway
  so the walk stays total)*, plus
  `mcp`. Adding a top-level route extends this set; the
  implementation must derive the reserved list from the route table (or enforce the
  equivalence with a test that walks the router), so the two can never drift.
- **App** — a registered MCP app. Identified by `(owner, slug)` — slugs are
  `[a-z0-9-]` (no underscore; §7 relies on this), unique per owner. Two kinds:
  - *tunneled* (the "bot"): dials in over WebSocket, at most one live connection,
    declares its roles at connect time. Lifecycle: provisioned → online ↔ offline, plus
    reversible **archived** and terminal deletion (§6, "App lifecycle").
  - *proxied*: an upstream MCP endpoint URL the hub forwards to. No connection, no
    online/offline; roles are defined in config ("virtual roles"), not by the upstream.
    Lifecycle is just provisioned / archived / deleted.
- **Role** — named subset of an app's tools *(amended 2026-08-26: **and** of its
  prompts and resources — §20 gives a role one pattern list per primitive family; a bare
  pattern list, the shape below, still means tools and nothing else)*. Declared in code at
  registration for
  tunneled apps (`{"reader": ["get_news", "search_.*"]}`), in the YAML / admin tools
  for proxied ones. Patterns are **anchored regexes** over tool names (a pattern made
  only of tool-name characters `[A-Za-z0-9._-]` is matched as a literal tool name — §7
  pins the rule; anything else compiles as a regex, and `*` is accepted as an alias for
  `.*`). Every app additionally
  has the built-in wildcard role **`all`** matching all tools, present and future, with
  no declaration needed — for both kinds. (`all` is a reserved role name — never
  declarable, only grantable; it was renamed from `*`, which read like a regex.) Trust boundary, stated plainly: roles confine
  the *agent*, not the app — a tunneled app self-declares its roles,
  so granting any role on it trusts that app fully (a compromised bot can widen its
  own roles; the hub logs such drift, §6, but the blast radius is accepted as
  one-app-wide).
- **Agent** — an identity for an AI agent or system (`claude`, `cron`). Holds
  **grants**.
- **Grant** — (agent, app, role, mode). An agent may call exactly
  the tools matched by the union of its granted roles per app. `mode` is `allow`
  (default) or `approval`: an approval-mode call does not execute until the owner
  approves that specific request (§7, "Approval flow") — so per tool an agent can't
  call it, can call it, or can call it with per-request approval. A tool matched by
  both an allow-mode and an approval-mode role is allowed outright (allow wins; approval
  is the weaker form of allow). Owners are never approval-gated.
- **Token** — bearer credential. Three kinds:
  - *user token*: better-auth session token obtained by the CLI via device flow → admin access.
  - *agent token*: long-lived API key bound to an agent → limited by grants.
  - *app token*: long-lived API key bound to a **tunneled** app → only valid for
    opening the reverse WebSocket as that app. Proxied apps have no tokens.

