## 2. Concepts

- **User** — a human, owner of a namespace. Every user is the admin *of their own
  namespace* (apps, agents, grants); there is no cross-namespace access.
  Created by a repo script; password + optional TOTP second factor and/or passkey.
  Usernames are `[a-z0-9-]`, minus a reserved list, since they become top-level URL
  segments: every top-level route segment the Worker serves is reserved — currently
  `login`, `device`, `settings`, `audit`, `approvals`, `apps`, `agents` *(amended
  2026-09-03: reserved ahead of its pages, decision 30 reversed — `/agents` answers its
  own not-built-yet text until they land)*, `oauth`, `api`,
  `connect`, `internal`, the five shell assets `manifest.webmanifest`, `sw.js`,
  `styles.css` *(amended 2026-08-26: the stylesheet became a served segment)*,
  `icon-192.png`, `icon-512.png` *(amended 2026-09-03: the two PWA icons the manifest
  declares and the shell head links, §13)*,
  `.well-known` *(amended 2026-08-26: OAuth discovery documents, §19 — the dot already
  puts it outside the username charset, like the shell assets, and it is reserved anyway
  so the walk stays total)*, plus
  `mcp`. Adding a top-level route extends this set; the
  implementation must derive the reserved list from the route table (or enforce the
  equivalence with a test that walks the router), so the two can never drift.
  *(2026-09-23, decision 40:)* **A username is fixed once chosen.** `pnpm users create`
  (§12) chooses it and nothing renames it, because three things are keyed on the string
  itself: it is the first path segment of every MCP URL an agent or a connector is
  configured with (`/<username>/mcp`, `/<username>/mcp/<slug>`) and of every §19 token's
  audience; it is the `user:<username>` principal the audit trail records; and the
  reserved-segment rule above judges it only when it is created. A rename would break every
  configured URL and every issued token, split the ledger's history across two principals,
  and could claim a segment the rule withholds. A different name is a different user.
- **App** — a registered MCP app. Identified by immutable `id` and current `(owner,
  slug)` — slugs are `[a-z0-9-]`, with `hub` and `pmcp` reserved virtual slugs and
  `_` still excluded for canonical compatibility. Two kinds:
  - *tunneled* (the "bot"): dials in over WebSocket, at most one live connection,
    declares its roles and optional SDK TypeScript alias hints at connect time. Lifecycle:
    provisioned → online ↔ offline, plus reversible **archived** and terminal deletion
    (§6, "App lifecycle").
  - *proxied*: an upstream MCP endpoint URL the hub forwards to. No connection, no
    online/offline; roles and optional owner TypeScript aliases are defined through the
    admin/configuration surfaces, never by requiring the upstream to adopt a hub SDK.
    Lifecycle is provisioned / archived / deleted.
  The aggregate endpoint does not publish apps. §23 builds an immutable caller-visible
  program catalog from scoped app identities and pins the immutable app id so deleting
  and recreating a slug cannot redirect an admitted program.
- **Role** — named subset of an app's tools *(amended 2026-08-26: **and** of its
  prompts and resources — §20 gives a role one pattern list per primitive family; a bare
  pattern list, the shape below, still means tools and nothing else)*. Declared in code
  at registration for tunneled apps (`{"reader": ["get_news", "search_.*"]}`), and
  through the admin wire, UI, or provider for proxied ones. Patterns are **anchored
  regexes** over tool names (a pattern made
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
  **grants**. Slugs are `[a-z0-9-]`, unique per owner, and `new` is reserved from them
  *(2026-09-03: `/agents/new` is the create form, §13 — the same derivation that keeps
  `new` and `connect` out of app slugs)*.
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

- **Hub program** — one async TypeScript function body checked against the caller-visible
  declaration, then emitted and run in a fresh QuickJS/Wasm runtime inside the Worker
  (§23). Its `mcp` global is an immutable explicit map over the invoking credential's
  current authority. It is non-transactional: completed operations may have effects if a
  later operation fails, and nothing resumes or replays the program automatically.

