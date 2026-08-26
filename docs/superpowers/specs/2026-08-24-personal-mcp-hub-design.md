# personal-mcps — Design Spec

Date: 2026-08-24
Status: draft, for review

## 1. Overview

A personal MCP hub. Services come in two kinds: **tunneled** — small programs (written
like telegram bots) that dial **out** to the hub with a persistent WebSocket and expose
an MCP server through it — and **proxied** — existing remote MCP endpoints (e.g.
Notion's) that the hub forwards to directly. The hub proxies inbound MCP clients
(Claude, other agents, the CLI) to those services, enforcing per-service-account role
grants. Each user owns their own namespace — services, service accounts, grants, YAML
file — managed via a CLI and served under `/<user>/mcp…` URLs.

Components:

| Component | What it is |
|---|---|
| **server** | Cloudflare Worker + Durable Objects. Terminates auth, owns the registry, proxies MCP traffic. |
| **clients** (py + js) | Libraries a service author uses: write a normal MCP server, hand it to the lib, it maintains the reverse connection. |
| **cli** (`pmcp`) | Login via device flow, invoke MCP tools, diff/apply the YAML config. |
| **admin MCP** | The hub's own management (services, accounts, grants, tokens) exposed as a built-in MCP service named `pmcp` — its tools are ordinary tools (`pmcp_service_list` on the aggregated endpoint). |
| **web pages** | Server-rendered pages (Hono JSX, §13): `/login`, `/device`, `/account`, plus `/services`, `/approvals`, `/audit` — fronts over the same handlers as the `pmcp` tools, no web-only capability (except `/account`, and `/audit`'s streaming JSONL export — a serialization of `audit_query`, §13). |

Non-goals (v1): cross-namespace sharing between users, MCP push streams
(`subscriptions/listen` and every server→consumer notification with it, §20), any web UI
beyond the server-rendered pages of §13 (no SPA — the pages do ship as an installable PWA
with Web Push for approvals, §13). *(Amended 2026-08-26: two former non-goals became
sections of their own — MCP-native OAuth for third-party clients is **§19**, and
prompts/resources proxying is **§20**. The push-stream non-goal is the one that stayed,
and §20 records why.)*

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

## 3. Architecture

```
 ┌──────────┐  MCP Streamable HTTP                         ┌─────────────────────────────┐
 │ MCP      │  POST /<user>/mcp          (aggregated)      │  Worker                     │
 │ clients  │  POST /<user>/mcp/<service> (scoped)         │  - better-auth (D1)         │
 │          │ ───────────────────────────────────────────▶ │  - authz: grants → allowed  │
 └──────────┘   Bearer: user token | service-account key   │    tool patterns            │
 ┌──────────┐  POST /<user>/mcp/pmcp (admin MCP)           │  - pmcp service (built-in)  │
 │ pmcp CLI │ ───────────────────────────────────────────▶ │                             │
 └──────────┘                                              └──────────────┬──────────────┘
                                                            fetch(allowed, jsonrpc)
                                                           ┌──────────────▼──────────────┐
 ┌──────────┐    wss://host/connect                        │  ServiceConnection DO       │
 │ tunneled │ ────────────────────────────────────────────▶│  (one per <user>/<service>, │
 │ service  │    Bearer: service token                     │   SQLite-backed, hibernating│
 └──────────┘    JSON-RPC frames, hub acts as MCP client   │   WebSocket)                │
                                                           └─────────────────────────────┘
 ┌──────────┐    Streamable HTTP (hub as MCP client,       ┌─────────────────────────────┐
 │ upstream │ ◀────────────────────────────────────────────│  Worker (proxied kind:      │
 │ MCP      │    stored upstream auth header)              │  forwards directly, no DO)  │
 └──────────┘                                              └─────────────────────────────┘
```

- The Worker is the single trust boundary: it authenticates every consumer request,
  resolves grants from D1, and forwards the request plus the resolved *allowed-tools
  filter* to the service's Durable Object (tunneled) or straight to the upstream
  endpoint as an MCP client (proxied — no DO involved).
- The DO owns the live WebSocket (hibernatable), a cached tool list, and pending
  request correlation. It never validates tokens itself for consumer traffic — it trusts
  the Worker.
- Services always dial **in**; the DO never opens outbound sockets (outbound sockets
  block hibernation and wreck the cost model).

## 4. Tech stack (verified against current docs, 2026-08)

- **Runtime**: Cloudflare Workers, Hono for routing. D1 for the control plane,
  SQLite-backed Durable Objects (`new_sqlite_classes`) for per-service connection state.
- **MCP**: target spec revision **2026-07-28** (stateless, POST-only, no sessions).
  Serve with `createMcpHandler` from `@modelcontextprotocol/server` v2 with a per-request
  factory building a **low-level `Server`** (`setRequestHandler('tools/list' | 'tools/call', …)`)
  — the SDK-endorsed gateway pattern. Its `legacy: 'stateless'` lane serves 2025-era
  clients for free. Do **not** use Cloudflare's `McpAgent` (deprecated, frozen on SDK v1).
  For proxied services the Worker dials upstream with `Client` from
  `@modelcontextprotocol/client` (Streamable HTTP transport; it handles legacy-upstream
  handshakes itself).
- **Auth**: better-auth **≥ 1.7** with D1 as `database` (instantiated per request — D1
  bindings are request-scoped). Plugins:
  - `username()` — login is username + password; email is a synthesized placeholder
    (`<username>@users.local`), never used.
  - `twoFactor()` — optional TOTP + backup codes.
  - `@better-auth/passkey` — optional WebAuthn.
  - `deviceAuthorization()` — RFC 8628 device flow issuing **session tokens** for the CLI
    (the CLI's own path stays the device flow, §18 decision 1 — it is not a client of
    §19's authorization server).
  - `bearer()` — lets the CLI present its session token as `Authorization: Bearer`.
  - `oauthProvider()` from **`@better-auth/oauth-provider`** plus `jwt()` — the inbound
    authorization server (§19), added 2026-08-26. In 1.7.x the provider lives outside
    core: `oidcProvider`/`mcp` are gone from `better-auth` itself, so the package is a
    new dependency pinned in lockstep with core (`@better-auth/oauth-provider@1.7.1`
    against `better-auth@1.7.1`), and `jwt()` is mandatory for it (the plugin throws
    `jwt_config` without one). Both plugins put endpoints on the **public** `/api/auth`
    mount as a side effect, and this bullet is where a reader looks for "what new
    endpoints exist", so they are named here as well as in §19.2's table: the provider
    brings `/api/auth/oauth2/*`, and `jwt()` brings **both** `/api/auth/jwks` **and**
    `/api/auth/token` — the last of which converts any live session into a hub-signed
    JWT. §19.7 pins what keeps that endpoint out of reach and §19.6 pins why the door
    would refuse its output anyway. §19 pins the options; the verify side is a real open
    question rather than the free lunch this bullet first claimed (§19.1).
- **Service-account and service tokens**: our own `token` table (§5), not a better-auth
  plugin. 256-bit random secrets with `pmcp_sa_` / `pmcp_svc_` prefixes, SHA-256 hashed at
  rest, plaintext shown once. Unsalted SHA-256 is deliberate and correct for 256-bit
  random secrets (GitHub PATs and Vault tokens do the same): preimage attacks are
  infeasible, salting adds nothing, and slow KDFs are for low-entropy human secrets —
  do not "fix" this into bcrypt. (`@better-auth/api-key` was considered and rejected:
  its keys can only reference users/organizations, not our service rows, and its
  session-minting behavior is an escalation footgun. A small hashed-token table is
  simpler and safer; better-auth handles humans only.)
- **Session-scope guards**: credential-management endpoints (`/account` — TOTP and
  passkey enrollment/removal, session revocation; there is no self-serve password
  change, the users script (§12) is the only password path) require a
  cookie-authenticated web session with recent
  authentication — bearer-sourced (CLI) sessions are rejected there, so a stolen CLI
  token cannot enroll new credentials and become persistent account takeover. Session
  lifetime config is shared between web and CLI sessions (better-auth default 7 d
  sliding) — a conscious coupling; don't tune it up for CLI convenience without
  accepting the browser exposure.
- **Schema migrations**: generated SQL checked in as `wrangler d1 migrations` files
  (better-auth CLI generate + our own tables); applied with `wrangler d1 migrations apply`.
  The better-auth CLI cannot run against the production config — D1 bindings exist only
  inside the Workers runtime, so `@better-auth/cli generate` fails with "Failed to
  initialize database adapter". Generation therefore uses a small CLI-only auth config
  with the identical plugin list (username, twoFactor, passkey, deviceAuthorization,
  bearer) pointed at a local SQLite Kysely dialect (e.g. better-sqlite3); better-auth
  targets the same SQLite dialect either way, so the emitted SQL is checked in
  unchanged as the wrangler migration. No runtime migration endpoint.
- **Clients**: Python — `mcp` package v2 (`MCPServer`, low-level `Server.run(read, write)`
  over a custom transport: an async context manager bridging an outbound WebSocket to the
  anyio stream pair). JS — `@modelcontextprotocol/server` v2 with a small custom
  `Transport` implementation over `ws`. Both SDKs dropped built-in WebSocket transports in
  v2, so this bridge is ours; it is small and the spec explicitly sanctions custom
  transports.
- **Monorepo**: pnpm workspaces (`server`, `cli`, `clients/js`) + `uv` project
  (`clients/py`).

## 5. Data model

better-auth owns: `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`,
`deviceCode` — plus, from 2026-08-26, the seven `oauth*` tables and `jwks` that §19's
authorization server brings (their DDL and the hub's own `oauth_binding` are pinned
there, not repeated here). One extension of ours on `passkey`: a `last_used_at` column the hub
stamps after each successful passkey sign-in (better-auth's schema only tracks
`createdAt`) — cheap (one UPDATE per human passkey login) and it backs the "last used"
line on `/account`'s passkey rows.

Ours, in D1:

```sql
CREATE TABLE service (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                  -- [a-z0-9-], referenced in YAML and /<user>/mcp/<slug>
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'tunnel' CHECK (kind IN ('tunnel', 'proxy')),
                                       -- kind is immutable after create (service_update rejects
                                       -- changes; recreate to convert)
  upstream_url TEXT,                   -- proxy kind only
  upstream_auth_mode TEXT CHECK (upstream_auth_mode IN ('headers', 'oauth')),
                                       -- proxy kind only; the declared `auth` mode (§7, §9),
                                       -- default 'headers'. Deliberately separate from
                                       -- upstream_auth_json: the mode is configuration and
                                       -- survives Disconnect; the envelope is credentials and
                                       -- exists only while connected/configured.
  forward_identity INTEGER NOT NULL DEFAULT 0,
                                       -- proxy kind only; send X-Pmcp-* identity headers
                                       -- upstream (§7, "Caller identity forwarding")
  upstream_auth_json TEXT,             -- proxy kind only; AES-GCM envelope-encrypted (WebCrypto,
                                       -- key in a wrangler secret) so D1 exports/dumps don't leak
                                       -- upstream credentials. Inside: {kind: 'headers', headers}
                                       -- (set imperatively, §8) or {kind: 'oauth', tokens,
                                       -- as_metadata, client} (populated by the connect flow, §7).
                                       -- Never via YAML either way. Envelope kind always matches
                                       -- upstream_auth_mode.
  roles_json TEXT NOT NULL DEFAULT '{}',  -- {"reader": ["get_news","search_.*"], ...}
                                          -- tunnel: written at registration; proxy: via config
  redact_json TEXT NOT NULL DEFAULT '{}', -- config-declared sensitive ARGUMENT paths per
                                          -- tool-or-pattern (§7) — either kind
  redact_results_json TEXT NOT NULL DEFAULT '{}',
                                          -- same shape, applied to result structuredContent (§7)
  log_bodies INTEGER NOT NULL,            -- audit body logging for this service (§15); set at
                                          -- create: an absent input defaults by kind —
                                          -- tunnel 1, proxy 0
  created_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  archived_at INTEGER,                 -- non-NULL = archived (§6, "Service lifecycle")
  UNIQUE (owner_id, slug)
);

CREATE TABLE service_account (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE TABLE grant_ (                   -- "grant" is an SQL keyword
  service_account_id TEXT NOT NULL REFERENCES service_account(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- exact role name, or the built-in 'all' (§9)
  mode TEXT NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'approval')),
  PRIMARY KEY (service_account_id, service_id, role)
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  service_account_id TEXT NOT NULL REFERENCES service_account(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,               -- SHA-256 of the canonical (sorted-keys) JSON of
                                         -- params.arguments ONLY, computed POST-redaction (§7 —
                                         -- no digest of a secret); MRTR inputResponses/requestState
                                         -- are outside the binding and never persisted (§7)
  args_json TEXT NOT NULL,               -- the arguments SHOWN to the owner — stored
                                         -- post-redaction (§7), like every persisted
                                         -- body in the hub (§15)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'used')),
                                         -- past expires_at is treated as expired on every read;
                                         -- rows are flipped lazily (§7)
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL            -- 1 h from creation; covers both the pending
                                         -- wait and the post-approval retry window
);
CREATE INDEX approval_owner_status ON approval(owner_id, status, created_at);

CREATE TABLE token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service_account', 'service')),
  ref_id TEXT NOT NULL,                  -- service_account.id or service.id per kind
  hash TEXT NOT NULL UNIQUE,             -- SHA-256 of the full token string
  prefix TEXT NOT NULL,                  -- first ~12 chars, for display in listings
  expires_at INTEGER,                    -- pmcp_sa_ tokens default to 90 d (overridable, incl.
                                         -- 'never'); pmcp_svc_ default to no expiry (telegram-bot
                                         -- model: revoke on compromise)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                  -- coarse (updated at most hourly), shown in token_list —
                                         -- makes leaked-token use and rotation state observable
  revoked_at INTEGER
);
```

(`ref_id` can't be a foreign key to two tables; `service_delete` / `account_delete`
delete matching token rows as a server-side side effect (§8), and verification
additionally rejects tokens whose referenced row no longer exists (§6 for service
tokens, §7 for service-account tokens).)

```sql
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  owner_id TEXT NOT NULL,              -- namespace the event happened in
  principal TEXT NOT NULL,             -- 'user:<name>' | 'sa:<slug>' | 'svc:<slug>' | 'bootstrap'
  event TEXT NOT NULL,                 -- 'tools/call' | 'admin.<tool>' | 'connect.register' |
                                       -- 'connect.replaced' | 'connect.roles_widened' |
                                       -- 'auth.login' | 'auth.device_approved' | …
  service TEXT,                        -- slug, when applicable
  tool TEXT,
  outcome TEXT NOT NULL,               -- 'ok' | '-32000' | '-32001' | '-32002' | '-32003' | 'error'
  duration_ms INTEGER,                 -- hub-measured wall time from consumer request to
                                       -- response; set on every tools/call row (denials are
                                       -- just fast), NULL for non-call events
  client_name TEXT,                    -- consumer clientInfo.name (e.g. 'claude-code'), when sent (§7)
  client_version TEXT,
  client_session_id TEXT,              -- client-declared session id (e.g. Claude Code's), when sent
  args_json TEXT,                      -- tools/call rows, when the service's log_bodies is on
                                       -- (§15): params.arguments POST-redaction (§7's union),
                                       -- size-capped — an over-cap body is a stub, never
                                       -- truncated JSON
  result_json TEXT,                    -- same gate; envelope pinned (§15): mirrors the
                                       -- MCP result's two carriers — structuredContent
                                       -- post-redaction, content as one typed size stub
                                       -- ({stub, contentType?, bytes}) per block, never
                                       -- bytes; a result with only content blocks
                                       -- stores {content: [...]}
  detail TEXT                          -- small JSON summary; NEVER token material — bodies
                                       -- live only in the two capped columns above
);
CREATE INDEX audit_owner_ts ON audit(owner_id, ts);

CREATE TABLE push_subscription (       -- Web Push targets for approval notifications (§13)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,             -- p256dh + auth as handed out by the browser
  created_at INTEGER NOT NULL
);

CREATE TABLE upstream_oauth_state (    -- §7 upstream-OAuth connect flow's one-time state
                                       -- record (added 2026-08-25, migration 0004 — this
                                       -- table was implied by §7's prose but missing from
                                       -- this DDL as first written). upstream.ts owns the
                                       -- lifecycle: beginConnect writes, handleCallback
                                       -- consumes by compare-and-set DELETE, the daily
                                       -- cron sweeps stragglers past TTL.
  state TEXT PRIMARY KEY,              -- the unguessable nonce; also the `state` parameter
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,            -- only the browser session that began the flow may
                                       -- complete it; no FK (better-auth owns `session`)
  issuer TEXT NOT NULL,                -- RFC 9207 `iss` compares against THIS, never the
                                       -- callback's own claim
  token_endpoint TEXT NOT NULL,        -- mix-up defense: code redeemed here alone
  client_id TEXT NOT NULL,             -- CIMD URL, or the id DCR handed back
  code_verifier TEXT NOT NULL,         -- PKCE S256 verifier; plaintext DELIBERATELY — it
                                       -- lives ~10 min, authorizes nothing alone, and a
                                       -- reader of this table already sees the code and
                                       -- sealed bundle beside it; §15 still bans it from
                                       -- logs/audit/errors
  redirect_uri TEXT NOT NULL,
  issuer_advertised INTEGER NOT NULL,  -- 0/1: AS metadata declared iss support; §7's check
                                       -- is conditional on it, recorded at initiation
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL          -- created_at + ~10 min; enforced at read, swept daily
);
CREATE INDEX upstream_oauth_state_expires ON upstream_oauth_state(expires_at);
```

The DO keeps per-service volatile/cached state in its own SQLite: cached `tools/list`
result, connection metadata. Identity/auth facts for the socket ride in
`serializeAttachment` (≤16 KB).

## 6. Reverse connection protocol (tunneled service ↔ hub)

This section is tunnel-kind only; proxied services have no connection of their own.

Transport: WebSocket to `wss://<host>/connect`, `Authorization: Bearer pmcp_svc_…`.
The Worker verifies the service token — checking the token row's `kind` column
explicitly, not just the prefix — resolves the service (and its owner), and hands the
socket to `ServiceConnection` DO `getByName(service.id)` (the opaque id, not
`user/slug`, so deleting a user and recreating the same username can never rebind to a
stale DO), which calls `ctx.acceptWebSocket(ws, [service.id])`.

Upgrade response matrix — the status codes carry meaning for the client library:
- **401** — no/invalid/expired/revoked token, wrong token kind (`pmcp_sa_`, session), or
  a token whose service row is gone or is `kind: proxy`. Client treats this as fatal:
  stop and surface a credentials error (no retry loop on a dead credential).
- **403** — means exactly one thing: the service is archived. Client keeps retrying at
  max backoff so unarchiving heals automatically.
- Close `4001` after establishment (token revoked / service deleted) is treated like
  401: stop and surface. Close `4003` exists only for the row-deleted-between-upgrade-
  and-register race.

Framing: **one JSON-RPC 2.0 message per WebSocket text message** (WS already provides
message framing; each side generates UUID-string ids for the requests it initiates).
Two message namespaces:

1. **Control** — JSON-RPC methods prefixed `hub/`, handled by the client library, never
   reaching the user's MCP server:
   - `hub/register` (client → hub, first message):
     `{ "clientVersion": "...", "protocolVersion": "2026-07-28", "roles": { "<role>": ["<regex>", …] } }`
     *(amended 2026-08-26, §20: a role's value is **either** that bare pattern list —
     which means tools, forever, so every service written against this spec keeps
     registering unchanged — **or** the per-family object
     `{ "tools": [...], "prompts": [...], "resources": [...] }`, each key optional and
     defaulting to the empty list. Mixing the two spellings across roles in one
     declaration is fine; the two forms are the same declaration after normalization.)*
     The service identity comes **exclusively** from the authenticated token — the
     payload carries no service field, so a token for one slug can never touch another
     service's registration. The hub validates the declaration before accepting it:
     role names must match `[a-z0-9_-]{1,64}` (`all` is rejected — it's the resolver's
     built-in, §2), every pattern must compile as a regex, and pattern length (≤128 chars)
     and per-role pattern count (≤64) are capped — *(amended 2026-08-26: the count cap
     applies **per family list**, so the same two `limits.ts` constants bound a role's
     tool, prompt, and resource patterns each; an unknown family key is a violation like
     any other)* — violations get a JSON-RPC error reply
     and the socket is closed. The hub verifies the service row still exists (close
     `4003` if not), upserts `roles_json` in D1 and checks for **role drift**: both
     declarations are **normalized first** (§20.3 — a bare list becomes
     `{tools: [...]}`), and then, for each role name **and each family**, the old and new
     pattern lists are compared as sets of exact pattern strings, with a role *or a
     family* absent from either side treated as the empty set. Any role that holds ≥1
     live grant and any of whose family sets is not a subset of its old counterpart —
     a pattern added or textually changed, or a family that appears where there was none
     — writes a `connect.roles_widened` audit row listing the affected roles, the
     families, and their added/changed patterns. *(Amended 2026-08-26, §20: the
     per-family dimension is the load-bearing half of this rule now. A service that
     re-registers `"reader": ["get_news"]` as `"reader": {"tools": ["get_news"],
     "resources": ["file:///*"]}` has an unchanged **tools** set and has just handed every
     granted account the whole resource keyspace; a family-blind comparison sees a subset
     and writes nothing. Since §2's trust-boundary paragraph makes this row the only
     visibility into a service widening itself, comparing per family is what keeps that
     sentence true across three keyspaces. A family that *disappears* narrows the role and
     writes no row, exactly as removing a tool pattern does today — the row keeps meaning
     what its name says.)* The comparison is
     textual only; the hub never attempts regex-language containment (rewriting
     `get_news` to `get_.*` is logged because the string changed, not because the hub
     reasons about the language). Self-declared roles mean a compromised bot can widen
     its own roles; the blast radius stays inside that service, but the drift must be
     visible, not silent. The hub then replies `{ "ok": true }` and immediately issues
     `tools/list` to warm its cache — *(amended 2026-08-26, §20: preceded by one
     hub-originated `server/discover`, whose declared capabilities are cached beside the
     catalogs and decide which further lists are warmed. Warming blind would make every
     tools-only service log a spurious catalog-warm failure for three families it never
     claimed. **The client library answers `server/discover`, not the author's SDK**
     (§11): it is a hub↔library control question, no MCP SDK implements it, and every
     service already in the field runs a library that has never heard of it. The
     **fallback is therefore the load-bearing half of this rule** — a `-32601`, any other
     error, or a correlation timeout means "capabilities unknown", and the hub then warms
     **tools only**, exactly as it does today. A service whose library predates this
     change keeps the tool list it has always had; nothing in the field goes dark, and
     nothing about the discover answer can empty a catalog by failing. The two legs are
     sequential by construction — the answer decides which warms run — so the
     registration tail is worst-case **two** correlation timeouts wide: the discover leg,
     then the warms, which run concurrently with each other.)* A `roles` value of `{}`
     means "no roles declared" —
     the service is then reachable only by admin tokens or accounts granted the
     built-in `all` role.
   - `hub/replaced` (hub → client, notification): a newer connection for the same slug
     arrived; the old socket is closed with code `4000` after this. Eviction happens at
     **acceptance** of the new socket (`ctx.acceptWebSocket`), before its `hub/register`
     is seen — the DO never holds two sockets, preserving §2's at-most-one-connection
     invariant. Accepted consequence: if the new socket's registration then fails
     validation or never arrives, the old healthy connection is already gone and the
     service stays offline until the bot reconnects (a service-token holder can already
     deny service by connecting, so this adds no attacker capability). Client must NOT
     reconnect automatically in this case (two copies of a bot fighting for the slot is
     an operator error worth surfacing). The hub logs every replacement — with a stolen
     service token, eviction-and-impersonation looks exactly like this, so it's a
     security signal, not just noise.
2. **MCP** — everything else. The hub acts as the MCP *client*; the service is the MCP
   *server*. v1 forwarded `tools/list` and `tools/call`; *(amended 2026-08-26, §20:
   plus `server/discover`, `prompts/list`, `prompts/get`, `resources/list`,
   `resources/templates/list`, `resources/read` and `completion/complete` — the frame
   shape is unchanged, so the wire and both client libraries carry them with no new
   framing)*. The client library also sends
   `notifications/tools/list_changed` when the user's server changes its tool set; the DO
   invalidates its cache and re-lists — *(amended 2026-08-26: and the same for
   `notifications/prompts/list_changed` and `notifications/resources/list_changed`, each
   invalidating its own catalog key. These are the only service-originated frames the DO
   reads; every other one is still dropped. They stop at the hub — §20 forwards no
   notification to a consumer.)*

Handshake, pinned: the wire is stateless 2026-07-28-style — **`initialize` never crosses
the wire**. Hub-originated requests are self-contained, carrying all required `_meta`
protocol fields: `io.modelcontextprotocol/protocolVersion`, and
`io.modelcontextprotocol/clientCapabilities` **mirrored from the consumer's request** —
the hub asserts the calling client's capabilities, not its own (a legacy-lane consumer
that sent none gets `{}`, which per MRTR rules means the service must not emit
elicitation/sampling inputRequests for that caller). The client library performs
whatever session bootstrap its local SDK needs (synthesizing an initialize exchange
internally if the SDK requires one). After `hub/register` → `{ok: true}`, the first MCP
message from the hub is `server/discover` *(amended 2026-08-26, §20 — it was `tools/list`
before the capability warm existed)*, whose answer decides which catalog warms follow;
`tools/list` is one of them, and when the discover leg errors or times out it is the only
one.

Registration deadline, pinned: a socket that has not delivered a valid `hub/register`
within **10 s** of acceptance is closed with code `4004` (protocol error); the client
library treats this like any disconnect (reconnect with backoff). Any message other
than `hub/register` received before registration completes is a protocol error:
JSON-RPC error reply, then close `4004`. The hub never forwards consumer traffic to an
unregistered socket — until `hub/register` succeeds the service is offline and
`tools/call` fails `-32000`.

Liveness: the client library relies on WebSocket **protocol ping frames** (every ~25 s) —
the Cloudflare runtime auto-pongs these without waking the DO, keeping NATs open at zero
cost. No application-level heartbeat.

Reconnect: exponential backoff with jitter (1 s → 60 s cap), forever — deploys of the hub
terminate all sockets, so this is routine, not exceptional. In-flight requests at
disconnect time fail fast on the consumer side.

Request correlation in the DO: in-memory `Map<id, resolver>` with a hard **30 s timeout**
per request. This is hibernation-safe: an unresolved incoming request blocks hibernation,
so the map can only be lost when it is already empty or the DO is forcibly restarted (in
which case the caller gets an error anyway and retries).

### Service lifecycle

1. **Provisioned** — the owner creates the row (`service_create` / `apply`) and mints a
   service token (`token_issue`), which is handed to the bot. The token is the service's
   sole credential: it authenticates registration (the role declaration) and every
   (re)connection. Multiple tokens per service may be live at once, so rotation is
   issue-new → deploy → revoke-old (`last_used_at` in `token_list` shows which token
   the bot is actually on). Expiry is checked at upgrade only — an established socket
   outlives its token's `expires_at` until the next reconnect; that asymmetry is
   deliberate (revocation is the immediate path). A provisioned-but-never-connected
   service has no roles and lists no tools.
2. **Online / offline** — runtime status: **online** means the DO holds a live,
   **registered** socket (surfaced in `service_list` / `pmcp ls`); a socket accepted
   but not yet past `hub/register` is not online — the 10 s registration deadline
   bounds that window. Offline still serves the cached `tools/list`; only `tools/call`
   requires the connection.
3. **Archived** — a reversible parking state set by the owner (`service_archive`, or
   `archived: true` in YAML). While archived: connection attempts are rejected at the
   WebSocket upgrade (HTTP 403), an existing connection is severed (close `4002`), the
   service disappears from aggregated `tools/list`, and scoped calls fail with JSON-RPC
   `-32002` ("service archived"). Roles, grants, tokens, and the cached catalog are all
   retained — `service_unarchive` restores everything. The client library treats
   403/4002 as "keep retrying at max backoff", so unarchiving heals within a minute
   without touching the bot.
4. **Deleted** — terminal (`service_delete` / removal from YAML): grants cascade, tokens
   are deleted, the live socket is closed (`4001`), the DO's cached state is wiped.

Proxied services skip the connection-related states: their lifecycle is provisioned
(with `endpoint` + config-defined roles, no token) ↔ archived → deleted, with the same
archived semantics on the consumer side (`-32002`, hidden from aggregation).

## 7. Consumer-facing proxy

Two shapes, one pipeline — both stateless 2026-07-28 MCP endpoints (via
`createMcpHandler`, user and service resolved from the URL):

- `POST /<user>/mcp` — **aggregated**: every tool the caller may use across `<user>`'s
  services, tool names prefixed `<slug>_<tool>`. Slugs contain no `_`, so the first `_`
  splits the name unambiguously. The built-in `pmcp` service participates like any
  other — owners see `pmcp_service_list` etc.; service accounts can't hold `pmcp`
  grants (§8), so admin tools never reach them.
- `POST /<user>/mcp/<slug>` — **scoped** to one service, unprefixed tool names. This is
  also how `pmcp` is reached (`/<user>/mcp/pmcp`).

Per request:

1. Authenticate. **`Authorization: Bearer` only** — session cookies are never consulted
   on `/<user>/mcp*` (this single rule removes the whole browser-CSRF surface for the
   admin MCP), tokens in query strings are rejected, `Content-Type: application/json`
   is required, and an `Origin` header, when present, must match the hub's own origin
   (else **403**); requests without an `Origin` pass — every legitimate consumer (CLI,
   agents, server-side MCP clients) is a non-browser client that sends none, so the
   check is pure defense-in-depth against browser-originated requests, with the same
   if-present-must-match semantics as the SDK's `originValidation` middleware (which
   `createMcpHandler` does not apply automatically — wire it in explicitly).
   Resolution: `pmcp_sa_` prefix → SHA-256 lookup
   in `token` with an explicit `kind = 'service_account'` check (unrevoked, unexpired,
   `ref_id` resolves to a live service account) → service account; `pmcp_svc_` /
   `pmcp_sa_`-prefixed tokens **never** fall through to session lookup; anything else →
   *(amended 2026-08-26, §19: a **JWT-shaped** bearer — exactly three `.`-separated
   base64url segments, the predicate pinned byte-for-byte in §19.6 step 3 because it is
   what selects between two credential regimes — is answered by the OAuth leg **alone**:
   signature, issuer, audience, token type, `mcp` scope and binding row, which together
   answer **service account**, so nothing past this step knows the difference. The leg is
   **terminal and fails closed**: every failure in it is a 401, and none of them falls
   through to the session lookup — the same hard rule the `pmcp_` prefixes already carry
   one clause earlier, for a sharper reason. better-auth can resolve some of its own
   signed tokens to a *session*, and a session resolves to the **owner**; a fall-through
   would turn "this token's binding was revoked" into "this token is the owner", the
   exact inversion §18 decision 23 forbids. The leg runs **only on `/<user>/mcp*`**,
   where the addressed namespace supplies the canonical URL its audience check needs;
   §8's `/api/whoami` mirrors the rest of this step but refuses a JWT-shaped bearer
   outright, because it has no `<user>` to supply one. Then)* better-auth session lookup
   → user. Failure
   matrix: any request that doesn't resolve
   to a valid principal → **401** with a `WWW-Authenticate: Bearer` header, regardless
   of whether `<user>` exists (so unauthenticated probes can't enumerate usernames)
   — *(amended 2026-08-26, §19: on `/<user>/mcp` that header additionally carries
   `error="invalid_token"` and the `resource_metadata` URL, interpolated from the
   request **path** and never from a lookup, so the challenge on a live namespace and
   on a nonexistent one stay the same bytes)*. A
   *resolved* principal on another user's namespace (or a nonexistent user) → **404**
   (namespaces don't leak existence).
2. Resolve the allowed-tool filter (per service):
   - owner → all tools (sees everything in their namespace);
   - service account → the union of anchored-regex patterns of its granted roles,
     resolved against the service's `roles_json` **at request time**; the built-in
     `all` role contributes `.*` without ever appearing in `roles_json`. A granted role no
     longer present in `roles_json` resolves to the empty pattern set — it still counts
     as a grant (the account gets an empty `tools/list` and `-32001`, not a 404). On the
     scoped endpoint a service account gets **404** both for a nonexistent slug and for
     a service it holds no grants on — indistinguishable, so zero-grant accounts can't
     enumerate the namespace. The aggregated endpoint spans the services with at least
     one grant.

   Pattern semantics, pinned: compile as `^(?:<pattern>)$` with no flags (naive
   `'^'+p+'$'` breaks on top-level `|` — `^foo|bar$` matches `foox` via its `^foo`
   branch; §16 has the regression test). A pattern consisting only of tool-name
   characters (`^[A-Za-z0-9._-]+$` — `*` and `|` fall outside this set, so
   `search_.*` and `a|b` still compile as regexes) is compared as a literal string,
   never compiled — so an exact-looking role entry `get.news` matches only the tool
   `get.news`, not `getXnews`.
3. Dispatch:
   - `initialize` → answered by the Worker (amended 2026-08-26, shift-left D7: the
     MCP handshake every standards-compliant client opens with — protocolVersion,
     capabilities, serverInfo — answered statelessly on both endpoint shapes; the
     follow-up `notifications/initialized` is a notification and is absorbed like
     every notification, 202 with no body. Before this amendment `initialize` fell
     to `-32601` and no real MCP client could connect).
   - `server/discover` → answered by the Worker (hub capabilities).
   - `tools/list` → tunneled: served from the DO's **cached** list (kept in DO SQLite,
     so it survives disconnects — deploy-induced reconnect flapping doesn't churn agent
     tool lists; a service that has never connected lists no tools). Proxied: forwarded
     live to the upstream endpoint with the stored auth headers. Both filtered by the
     allowed patterns; aggregated adds the slug prefix and fans out over the relevant
     services **in parallel**, skipping archived ones, with a **10 s per-upstream
     deadline** (inside §15's 30 s request budget — tunneled services answer from cache
     and are unaffected). A proxied upstream that errors, times out, or is in
     needs-reconnect (§7, "Upstream OAuth") contributes zero tools and the aggregated
     list still succeeds; the omitted slugs are reported in the result's `_meta`
     (`pmcp/unavailable: ["<slug>", …]`) and logged as an ops event (not an audit row —
     §15 keeps `tools/list` out of audit). The scoped endpoint is where that failure
     surfaces: scoped `tools/list` against an unreachable or needs-reconnect proxied
     upstream fails `-32000`, and an archived service fails with `-32002` like every
     other request to it. `ttlMs`/`cacheScope` hints set so clients can cache.
     *(Amended 2026-08-26: `prompts/list` obeys every sentence of this bullet — same
     cache, same live fetch, same filter, same `<slug>_` prefix, same fan-out, same
     `_meta` — and §20 adds `resources/list`, `resources/templates/list`,
     `resources/read`, `prompts/get` and `completion/complete` with the scoping rules
     it pins there.)*
   - `tools/call` → (aggregated: split off the slug prefix first; a prefix matching no
     service → `-32001`, indistinguishable from not-permitted) checks run in a fixed
     order, identical on both endpoint shapes: **filter first** (`-32001` "tool not
     permitted" — so an ungranted account can't even learn a service is archived), then
     **archived** (`-32002`), then the **approval gate** (`-32003`, below), then
     **availability** (tunnel-not-connected or upstream-unreachable → `-32000` "service
     unavailable"). Passing all four, the call is forwarded — through the DO to the live
     connection (tunneled) or to the upstream endpoint (proxied) — with the caller
     identity attached (below), and the response relayed back verbatim. For proxied
     services, "verbatim" applies only to a well-formed JSON-RPC response from the
     upstream; any HTTP-level failure — non-2xx status, a body that is not a JSON-RPC
     message, TLS or transport error — maps to `-32000` with a generic "service
     unavailable" message. The upstream's status line, headers (including
     `WWW-Authenticate`), and body are never echoed to the consumer (extending §15's
     log-hygiene rule); the audit row's `detail` records the failure class (e.g.
     `upstream_status: 401` vs `unreachable`) so the owner can tell expired static
     headers from a down upstream.
   - anything else → `-32601`. *(Amended 2026-08-26: §20's seven methods join this
     table; everything outside it — `subscriptions/listen`, `logging/*`, any
     server-initiated request — is still `-32601`, and §20 records why for each.)*

### Approval flow

When the caller's only path to a tool is through approval-mode grants (§2), the call
does not execute on its own. The gate consults **known availability first**: a service
the hub already knows cannot execute — tunneled with no live registered connection,
proxied flagged `not_connected` or `needs_reconnect` — fails `-32000` before any
approval row is read, created, or consumed. The owner is never asked to approve a call
that cannot run (no pending row, no push), and an existing approved pass survives
untouched; the agent's retry once the service returns is what opens the pending. This
is stored knowledge only — no dial is attempted, so a `connected` proxied upstream
that is genuinely unreachable still surfaces at dispatch. Past that refusal:

1. The Worker looks for an `approval` row matching (account, service, tool,
   `args_hash`) with `status: approved` and unexpired. Found → the call proceeds
   through the availability check; on unavailability the row is left `approved` — an
   approved retry that hits an offline service gets `-32000` **without consuming the
   approval**, so the owner never has to re-approve because a bot was mid-reconnect.
   If availability passes, the Worker **claims the row atomically** before dispatching
   — a compare-and-set (`UPDATE approval SET status = 'used', decided_at = ? WHERE id
   = ? AND status = 'approved'`, checking the statement's changed-row count) — and
   dispatches only if the claim changed a row. A claim that changes no rows means a
   concurrent identical call already consumed the approval: treat it as no approval
   and fall through to step 2 (fresh `pending`, `-32003`). The initial SELECT alone
   never authorizes dispatch — N concurrent identical calls must resolve to exactly
   one execution. If dispatch fails *after* a successful claim (30 s timeout, socket
   dropped mid-call), the approval stays consumed: the call may already have reached
   the service (every `tools/call` is at-most-once, §15), so reverting the row would
   risk a second execution — the caller's retry gets a fresh `-32003` and the owner
   re-approves. One exception restores the row: a leg whose relayed result is MRTR
   `input_required` (below) flips it back to `approved` with the same CAS discipline,
   so the exchange can continue on the original approval.
2. Otherwise, if an unexpired `pending` row already exists for the same (account,
   service, tool, `args_hash`), no new row is inserted and no new `approval.requested`
   audit row is written — the reply is `-32003` carrying that row's existing
   `approvalId`/`expiresAt`, so retries see a stable id and link. Only when no such
   row exists does it record a fresh `pending` approval — arguments stored
   **post-redaction** (below); for tunneled services a pending row is only created for
   a tool present in the cached catalog (no schema → no redaction map → refuse with
   `-32001` instead, the same code as not-permitted/unknown, so a probing agent cannot
   use the refusal to map its own grant patterns; such a call could not execute
   anyway, and the catalog heals at the service's next registration) — and reply with JSON-RPC
   error **`-32003`** ("approval required"), whose `data` carries
   `{ approvalId, approvalUrl, expiresAt }`. The message text includes the URL too, so
   an agent that only surfaces error strings still hands the user something
   actionable. `approval.tool` stores the **unprefixed** tool name (aggregated calls
   split off the slug prefix before the gate, above), so retries through either
   endpoint shape match the same row.
3. The owner opens the link (or `pmcp approvals`), sees the request detail — account,
   service, tool, redacted arguments, requested time — and approves or rejects.
4. The agent retries the **identical** call (same canonical-JSON arguments — the hash
   must match). Approved → executes (once); still pending → `-32003` with the same
   `approvalId` (no new row, per step 2); rejected or expired → `-32003` again with a
   fresh pending record and link.

`args_hash` is computed over the **post-redaction** canonical JSON: no digest of a
sensitive value is ever persisted (a hash of a low-entropy password is offline-
crackable). The accepted trade-off, stated plainly: redacted fields are excluded from
the args binding, so a retry differing only in a sensitive field still matches — the
owner is approving the visible arguments.

MRTR (2026-07-28 Multi Round-Trip Requests): the args binding is `params.arguments`
only — `inputResponses` and `requestState` on a retry are excluded from `args_hash`,
excluded from the stored `args_json`, and never persisted or displayed anywhere
(elicited values are exactly the secrets `writeOnly` exists for; they pass through
the hub verbatim and never enter any persisted body — approval rows and the audit
body columns alike, §15). One approval covers the whole MRTR exchange: a
forwarded leg that returns `resultType: "input_required"` restores the claimed row to
`approved` (step 1), so follow-up legs (same `params.arguments`, plus
`inputResponses`/`requestState`) pass on the original approval until a `complete`
result or service error consumes it, with `expires_at` (1 h) bounding the exchange.

Approvals are single-use, args-bound, and expire 1 h after creation. Every transition
writes an audit row (`approval.requested` / `approval.approved` / `approval.rejected` /
`approval.expired`). Expiry is enforced **lazily**: every path that reads or decides
approvals — the step-1 and step-2 lookups, `approval_list`, `/approvals`,
`approval_decide` — treats `expires_at < now` as expired regardless of stored status,
and at that moment flips any such `pending` row to `expired`, writing the
`approval.expired` audit row exactly once. The daily cron (§15) additionally sweeps
remaining past-expiry `pending` rows to `expired` (same audit row) before pruning;
there is no hourly job. v1 never blocks the original request while waiting —
blocking-until-decided is explicitly future work. The owner is push-notified instead:
creating a `pending` approval row sends a Web Push to every `push_subscription` row
(§5, §13) naming the service and tool plus the approval id — never arguments (push
payloads rest on third-party push services; §15's hygiene applies). Tapping the
notification opens `/approvals/<id>`. Push is best-effort; the dashboard stays the
source of truth.
`tools/list` shows approval-gated tools like any other (the agent must see them to
call them).

### Caller identity forwarding

Services can do their own fine-grained authorization on top of the hub's role gate —
useful when one tool serves several roles. Every forwarded `tools/call` carries the
caller's identity and resolved roles (proxied: only when enabled, below):

- **Tunneled**: `_meta` fields on the forwarded request —
  `hub/principal` (`"sa:claude"` or `"user:ahrzb"`) and `hub/roles` (the caller's
  granted role names on this service, exactly as granted — the built-in wildcard is
  forwarded literally as `"all"`, never expanded into declared role names; owners get
  `["all"]`). The client libraries surface these on the tool context (e.g.
  `ctx.principal`, `ctx.roles`, `ctx.has_role("editor")`); `has_role(x)` returns true
  when the list contains `x` or `"all"`, so owner and `all`-granted calls behave
  identically, and `all` can never collide with a real role name (§6 rejects it in
  declarations).
- **Proxied**: only when the service sets `forward_identity: true` (default **false**):
  real HTTP headers on the upstream request — `X-Pmcp-Principal` and `X-Pmcp-Roles`
  (comma-separated, same values — including a literal `all`) — so an upstream you also
  control can branch on them. Third-party upstreams (Notion, Linear) have no need for
  internal identifiers, so with the flag off no `X-Pmcp-*` headers are sent.

The `hub/` prefix in `_meta` is **reserved**: before forwarding, the hub deletes every
consumer-supplied `_meta` key beginning with `hub/` and then sets its own values —
overwrite, never merge — so any `hub/*` field a service sees was written by the hub,
never the caller. (Other consumer `_meta` keys, e.g. `progressToken`, pass through
untouched. The proxied analogue holds by construction: `X-Pmcp-*` headers are set on
the hub's own upstream request, which never copies consumer headers.)

**Client metadata capture**: AI consumers identify themselves — `clientInfo`
(name/version) plus vendor `_meta` keys such as a client session id (Claude Code sends
one). The hub copies `clientInfo.name`, `clientInfo.version`, and a recognized
session-id key onto each `tools/call` audit row (`client_name` / `client_version` /
`client_session_id`, §5), each truncated to 128 chars and treated strictly as untrusted
display data — never parsed, never part of any authorization decision. The recognized
session-id keys are a small allowlist maintained in code (Claude Code's first);
unrecognized vendor `_meta` still passes through to services untouched, as above.

Alongside identity, the hub forwards the consumer's declared
`io.modelcontextprotocol/clientCapabilities` unchanged: copied into the forwarded
request's `_meta` (tunneled, §6) and into the per-request `Client` configuration so
the upstream sees the consumer's capabilities, not the hub's (proxied). An
`input_required` result flows back to the consumer through the existing relay-verbatim
path, and the consumer's retry (with `inputResponses` + `requestState`) is an ordinary
`tools/call` re-entering the same pipeline — the hub itself never answers an
inputRequest. Legacy consumers that declare no capabilities are forwarded `{}`, so
services correctly refrain from elicitation/sampling for them.

Identity is informational for the service's own logic; the hub's grant check has
already run and services must not treat these fields as secrets. Services *may* trust
`hub/*` values for their own fine-grained checks precisely because the hub strips
inbound copies — a consumer cannot inject them.

### Upstream OAuth (proxied services)

A proxied service's upstream auth is one of two kinds, declared as `auth: headers`
(default) or `auth: oauth` on the service:

- **headers** — static headers stored via `service_set_upstream_auth` (as before).
- **oauth** — for upstreams that require sign-in (Linear, etc.). The owner clicks
  **Connect** on the `/services` page (or follows the URL `pmcp connect <slug>`
  prints): the hub discovers the upstream's authorization server via its RFC 9728
  protected-resource metadata, obtains a client identity (CIMD document hosted by the
  hub, falling back to Dynamic Client Registration where the AS still wants it), and
  runs the authorization-code + PKCE flow in the owner's browser with callback
  `/oauth/upstream/callback`. Connect initiation mints a one-time unguessable `state`,
  stored server-side bound to {owner, service, expected AS issuer + token endpoint,
  PKCE verifier} and to the initiating cookie session, expiring in ~10 minutes. PKCE
  is not the CSRF defense here — RFC 9700 permits that only when the client has
  ensured the AS enforces PKCE, which a dynamically discovered upstream can't
  guarantee. The callback requires a valid owner cookie session (§13), resolves
  `state` to a live, unconsumed record belonging to that same session — consuming it
  single-use; missing, mismatched, expired, or replayed `state` rejects the callback
  with nothing stored — and, when the AS advertises RFC 9207 support, verifies the
  response's `iss` equals the recorded issuer. Because the one callback URL is shared
  across authorization servers, the `state` record is also the mix-up defense: the
  code is only ever redeemed, with the bound verifier, at the token endpoint recorded
  at initiation. The token bundle lands in the encrypted
  `upstream_auth_json`; the hub attaches `Authorization: Bearer` upstream and
  refreshes proactively. A failed refresh flips the service to **needs reconnect** —
  calls fail `-32000` and `/services` shows a Reconnect button — and Disconnect wipes
  the bundle. Connect/disconnect/refresh-failure all write audit rows
  (`upstream.oauth_*`). The YAML declares only the `auth` mode; tokens never appear in
  it, and the mode is diffed like any other field.

### Sensitive-field redaction

Some tool arguments and results (passwords, tokens) must never be persisted — not
even in the approval record or the audit body columns (§15). Sensitivity is declared
per direction, from two sources, unioned:

- **Schema-declared** (tunneled): any property marked with standard JSON Schema
  **`writeOnly: true`** (at any depth) in a tool's input **or output** schema is
  sensitive. The hub derives both maps from the catalog cached in the service's DO
  at `tools/list` time; the client libraries make declaring it natural (§11): a
  `Secret` field type in pydantic-/zod-style tool definitions emits `writeOnly`
  wherever it appears — input and output models alike — plus path-based sugar for
  hand-written schemas. On an *output* schema the keyword is the hub's internal
  marker only (its standard meaning, "sent but never returned", doesn't fit an
  output field): the hub strips `writeOnly` from every outputSchema it serves to
  consumers, so the co-opt never reaches the wire. Input schemas are served as
  declared — `writeOnly` on an input is standard usage.

  "At any depth" includes indirection, because SDK schema generators emit
  `$defs`+`$ref` by default: the hub's walk resolves same-document `#/…` refs by
  JSON Pointer, unions marks across `allOf`/`anyOf`/`oneOf` branches (secret in any
  branch masks — over-masking is safe), and cuts secret-free cycles. What the walk
  cannot soundly resolve is refused LOUDLY, never skipped — an unresolved ref could
  conceal a mark: external or non-local refs, `$id`/`$anchor`/`$dynamicRef`
  resolution, and a recursive cycle carrying a secret (its path set is infinite —
  no finite path list can express the mask). Violations are reported per tool at
  catalog warm — echoed to the service and logged; registration still succeeds —
  and such a tool is cached **schema-unsound**: it has no derivable redaction map,
  so approval-gated calls refuse `-32001` (the catalog-miss rule below) and its
  bodies are never recorded (§15). Inlining `$defs` client-side remains optional
  sugar, not a requirement.
- **Config-declared** (both kinds): the owner lists redaction paths per tool —
  `redact: { "<tool-or-pattern>": ["password", "credentials.token"] }` for
  arguments, and `redact_results:` (identical shape, applied to the result's
  `structuredContent`) — in the YAML / `service_update`. This is the **only** path
  for proxied services in v1: their `tools/list` is forwarded live and never cached,
  so there is no schema to derive from (honoring upstream `writeOnly` becomes
  possible if a proxied schema cache is ever added).

Redacted fields are replaced with `"‹redacted›"` before anything is stored or shown:
the approval `args_json` (§5), the audit body columns (`args_json` / `result_json`,
§15), any error message that echoes arguments, and any debug surface. "Stored or
shown" means the hub's OWN surfaces — approval detail, audit views, error echoes;
the caller's live JSON-RPC reply is never redacted (a `token_issue` caller must
receive the key, once — masking exists for persistence and display, not for the
wire). This extends
§15's log-hygiene rule. Only *structured* data is ever redactable — which is why
unstructured result content is never persisted at all, only stubbed (§15).

The hub terminates auth entirely; client tokens are never forwarded to services
(MCP audience-binding rules forbid pass-through anyway).

## 8. Admin MCP (the built-in `pmcp` service)

Built into the Worker at `POST /<user>/mcp/pmcp` — same proxy pipeline, but tools are
implemented locally instead of forwarded to a DO, and every tool operates on the
namespace of the `<user>` in the URL (which step 1 already proved is the caller's own).
Tools (names final, shapes reviewed at implementation time):

- `service_list` / `service_get` — includes kind, declared roles *(amended 2026-08-26,
  §20.3: returned in the **canonical read shape** — a bare pattern list iff the role is
  tools-only, the per-family object otherwise, whichever spelling registered it. Pinned
  because `pmcp diff`'s stability depends on this response, not on how a service happened
  to declare itself)*, redact paths
  (`redact` and `redact_results`), `log_bodies`, archived status, and for proxied
  services the endpoint, the `auth` mode, and
  `forward_identity`; connection status and last seen apply to tunneled services only
  (proxied rows report `kind: proxy` in their place). diff/apply depend on kind,
  endpoint, auth, forward_identity, roles, redact, redact_results, log_bodies, and
  archived all being readable here.
- `service_create` / `service_update` / `service_delete` — create takes `kind`,
  `redact` / `redact_results` (sensitive-field paths, §7 — either kind),
  `log_bodies` (audit body logging, §15 — either kind; absent defaults by kind,
  tunneled on / proxied off) and, for proxied services,
  `endpoint`, `roles` (the virtual role definitions), `auth` (`headers` | `oauth`,
  §7), and `forward_identity` (identity headers, §7; default false); update takes the
  same minus `kind`, which is **immutable** (recreate to convert — conversion would
  orphan service tokens and DO state). Changing `auth` in either direction is accepted
  but destructive: any stored `upstream_auth_json` is wiped (audit row
  `upstream.auth_mode_changed`), leaving the service not-connected until the owner
  runs Connect (`auth: oauth`) or `service_set_upstream_auth` (`auth: headers`);
  `pmcp diff` flags a mode flip as destructive in the plan. `service_set_upstream_auth`
  is rejected on `auth: oauth` services, and the Connect flow (§7) is rejected on
  `auth: headers` ones — each mode has exactly one credential path. `service_list` /
  `service_get` additionally report the OAuth connection status for `auth: oauth`
  services (not connected / connected / needs reconnect). Proxied role definitions get the same validation
  as `hub/register` (§6): name charset, `all` rejected, patterns must compile, caps. Delete
  also deletes the service's `token` rows, tells its DO to close any live socket (code
  `4001`) and drop cached state (DO side effects apply to tunneled services only —
  proxied services have no DO and no tokens).
- `service_set_upstream_auth` — proxied only: stores the headers (e.g. a bearer token)
  the hub sends upstream. Imperative and write-only, like `token_issue` — secrets never
  appear in YAML or in read tools.
- `service_disconnect` — `auth: oauth` proxied services only: wipes the stored token
  bundle (audit row `upstream.disconnected`), leaving the service not-connected until
  Connect runs again (§7). The web Disconnect button fronts this tool. Connect/Reconnect
  have no tool equivalent — the consent redirect is inherently a browser interaction
  (`pmcp connect` prints the URL).
- `service_archive` / `service_unarchive` — archive severs any live socket (close
  `4002`) and hides the service from consumers; everything is retained for unarchive
  (§6, "Service lifecycle").
- `account_list` / `account_create` / `account_delete` — delete also deletes the
  account's `token` rows. `account_list` returns each account's grants inline
  (per service: role names and modes), so reading the full desired-state picture
  is one `service_list` plus one `account_list` — the CLI diff planner depends on
  this; there is no separate grant-read tool.
- `grant_set` — replaces the full grant set for (account, service); each entry is a
  role name plus optional mode (`reader` or `reader:approval`, the same syntax as §9).
  Applies the same role validation as the YAML layer (§9): undeclared roles warn for
  tunneled services, hard-error for proxied ones; a role literally named `all` is never
  declarable, only grantable (it's the built-in).
- `approval_list` — `{ status?, limit? }` → approval requests, newest first (pending
  and history alike).
- `approval_decide` — `{ id, decision: "approve" | "reject" }`. The web approval page
  (§13) and `pmcp approve/reject` are both fronts for this.
- `token_issue` — `{ kind: "service_account" | "service", slug, expires_in? }` → plaintext
  key (shown once). `kind: "service"` is rejected for proxied services (nothing connects).
  Service-account tokens default to 90 d expiry (pass `expires_in` to override,
  including `never`) — these are the tokens pasted into agent configs; service tokens
  default to no expiry (revoke-on-compromise, the telegram-bot model). The issued
  key is a `writeOnly`-marked field in this tool's *output* schema, so §15's uniform
  body rule masks it wherever bodies are recorded — no pmcp-specific logging rule
  exists or is needed.
- `token_list` / `token_revoke` — listings include `last_used_at`; revoking a `service`
  token also closes that service's live socket (code `4001`) if the connection was
  opened with it.
- `connection_list` / `connection_revoke` *(added 2026-08-26, §19)* — the OAuth clients
  connected to this namespace: client name and id, the service account each is bound to,
  created/last-used, revoked state. `connection_revoke` takes `{ id }` and is what the
  `/oauth/connections` Revoke button fronts (§13). These exist because §19's connections
  are grants-shaped, not credential-shaped: the parity invariant below applies to them
  in full, and the consent SCREEN — not the binding it writes — is the browser-only part.

- `audit_query` — `{ principal?, service?, event?, tool?, session?, since?, until?,
  limit? (default 100), offset? (default 0) }` → `{ rows, total }`, newest first
  (`session` matches `client_session_id`, §5); `total`
  counts every row matching the filters (a COUNT over the retention-pruned table is
  cheap, and it backs the web UI's page numbers and "N events match" line). Rows carry
  the recorded body columns when present (§15) — post-redaction and stub-substituted,
  like everything persisted. Read-only;
  like everything else, `pmcp audit` is sugar over this tool.

Every tool that takes a service slug rejects `pmcp` with the same error (`grant_set`,
`service_*`, `token_issue` alike) — the reservation is uniform, not per-tool. Every
mutating `pmcp` tool writes an `admin.<tool>` audit row with a summary of the change
(never secrets — `token_issue` logs that a token was issued and for whom, not the key).

The `pmcp` slug is **reserved and virtual**: no `service` row exists for it.
`service_list` includes it flagged `builtin: true`. Access is admin (user) tokens only in v1 —
service accounts can't hold `pmcp` grants. Turning `pmcp` into a grantable service later
is a config change, not a design change.

**Parity invariant, pinned**: anything the web UI or CLI can do has an equivalent
`pmcp` tool — UI and CLI are presentation layers, so an AI agent holding an admin
token can do everything the owner can. Exceptions, also pinned: the auth/credential
family (login, device approval, TOTP/passkey enrollment, sessions, passwords — §12's
users script and §13's `/account`; deliberately never exposed to models), the
upstream-OAuth consent redirect (browser-only; its Disconnect counterpart *is* a
tool) — *(amended 2026-08-26: and §19's **inbound** consent screen, the same exception
for the same reason: `/oauth/consent` and every `/api/auth/oauth2/*` endpoint under it
are a browser interaction that mints authority, so they get no tool, while
`connection_list`/`connection_revoke` cover everything the connections page can do)* —
and `/audit`'s JSONL export (a streaming serialization of `audit_query` — same
rows, different framing).

The CLI performs every admin operation by calling these tools — the CLI has no private
admin API. (`diff`/`apply` are CLI-side compositions of `*_list` reads and `*_create` /
`*_delete` / `*_archive` / `*_unarchive` / `grant_set` writes.) The only non-MCP
traffic the CLI ever sends is the auth-session family: `login` and `logout` ride
better-auth's endpoints unchanged, while `whoami` is a hub-owned route,
`GET /api/whoami` (`whoami` can't be MCP even in principle: endpoint URLs embed the
username, which is exactly what `whoami` discovers — and it must also resolve
`pmcp_sa_` keys, which better-auth cannot, §4). Resolution mirrors §7 step 1: a
`pmcp_sa_`-prefixed bearer → SHA-256 lookup in `token` with an explicit
`kind = 'service_account'` check (unrevoked, unexpired, `ref_id` resolves to a live
service account) → `{ "principal": "sa:<slug>", "namespace": "<owner username>" }`; a
`pmcp_svc_`-prefixed bearer → **401**, never a session lookup; *(amended 2026-08-26,
§19: a **JWT-shaped** bearer (§19.6 step 3's predicate) → **401** as well — never a
session lookup, and never the OAuth leg either. §19's leg runs **only** on
`/<user>/mcp*`, because its audience check needs the addressed namespace's canonical URL
and this route has no `<user>` in it to supply one; off that path a JWT-shaped bearer is
not a credential. Pinned in both directions so the two resolvers cannot drift into a
version where `whoami` answers `sa:<slug>` for a token the door itself would refuse — the
"mirrors §7 step 1" sentence above is a claim two implementations must keep true, not a
description of one of them;)* anything else →
better-auth session lookup → `{ "principal": "user:<name>", "namespace": "<name>" }`;
no valid principal → **401** with `WWW-Authenticate: Bearer` (the bare challenge —
`/api/whoami` is not an MCP resource and names no `resource_metadata`, §19.2). This
response shape is pinned — it is the CLI↔server contract §10 depends on.

## 9. YAML config, diff, apply

One file per user, default `mcps.yaml`, authoritative for the logged-in user's
namespace: services, service accounts, and grants. Users and tokens are deliberately
imperative (secrets and humans don't belong in a declarative file).

```yaml
services:
  news:                     # kind: tunnel is the default; roles come from registration
    name: News MCP
    description: RSS digester on the home server
  notion:
    kind: proxy
    endpoint: https://mcp.notion.com/mcp
    log_bodies: true        # opt-in: proxied bodies are not audited by default (§15);
                            #   tunneled services default to true — either flips
    roles:                  # virtual roles — defined here because the upstream can't
      editor: ["create_page", "update_.*"]   # anchored regexes over tool names
      reader: ["search", "fetch_.*"]
    redact:                 # sensitive argument paths per tool (§7) — config-declared
      create_page: ["credentials.token"]     #   because upstream schemas rarely mark writeOnly
    redact_results:         # identical shape, applied to result structuredContent (§7)
      create_page: ["page.share_token"]
    # upstream auth is imperative (service_set_upstream_auth) — never in this file
  linear:
    kind: proxy
    endpoint: https://mcp.linear.app/mcp
    auth: oauth             # connected interactively from /services (§7); tokens never here
    capabilities: [tools, resources]  # §20.2: what a proxied service's scoped handshake
                            #   advertises (subset of tools/prompts/resources/completions);
                            #   absent means tools only — advertisement, never access
    roles:
      reader: ["list_.*", "get_.*"]        # bare list = tools, unchanged (§20)
      docs:                                # per-family form (§20, added 2026-08-26)
        prompts: ["summarize_.*"]
        resources: ["linear://docs/*"]     # anchored, `*` still aliases `.*`
  home:
    name: Home automation
    archived: true          # parked: connections refused, hidden from consumers,
                            # roles/grants/tokens retained (§6, "Service lifecycle")

service_accounts:
  claude:
    name: Claude
    grants:
      news: [reader]        # exact role names; warned (not rejected) if the service
                            # hasn't declared them yet
      notion: [editor]
      home: ["control:approval"]  # ':approval' suffix = approval mode (§2) — role names
                            # have no colon, so the suffix is unambiguous; bare = allow
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
```

- `pmcp diff -f mcps.yaml` — reads server state via `pmcp` tools, prints a create/update/
  delete plan (including archive/unarchive transitions from the `archived` field).
  Full desired state: deletes include services/accounts present on the
  server but absent from the file, **and** grants for any (account, service) pair not
  listed under that account's `grants:` block. `redact`, `redact_results`, and
  `log_bodies` (either kind) and, for proxied
  services, `endpoint`, `auth`, `forward_identity`, and `roles` are part of the
  desired state and diffed like any other field (an `auth` flip is shown as
  destructive — it wipes stored upstream credentials, §8). Listing the same role name in both modes (`[reader,
  "reader:approval"]`) is rejected as a config error — in the YAML and in `grant_set`
  alike. Grants
  referencing roles a *tunneled* service hasn't declared are applied but flagged with a
  warning (tunneled roles arrive at connect time, so the file can legitimately be ahead
  of the first connection); `all` is exempt, and for proxied services undeclared roles are
  a hard error (their roles live in this same file). The reserved `pmcp` slug is
  excluded from the delete computation and rejected anywhere it appears in the file —
  as a `services:` key or inside a `grants:` block.
- `pmcp apply -f mcps.yaml` — shows the same diff, asks for confirmation (`--yes` to
  skip), applies. Deleting a service or account cascades its grants and deletes its
  tokens (server-side side effect of the `*_delete` tools, §8).

## 10. CLI (`pmcp`)

TypeScript, ships in the monorepo, run via `npx pmcp` or installed globally.

```
pmcp login [--url https://mcp.example.com]   # RFC 8628 device flow; prints code + URL
pmcp logout | whoami
pmcp ls                                       # services + status (online/offline for tunneled,
                                              #   proxy for proxied) + roles
pmcp tools <service>                          # tools/list as seen with current token
pmcp call <service> <tool> [--json '{…}' | key=value …]   # or the aggregated name:
pmcp call <service>_<tool> [...]                          # unambiguous, slugs have no '_'
pmcp prompts <service>                        # prompts/list          (§20, added 2026-08-26)
pmcp prompt <service> <name> [key=value …]    # prompts/get
pmcp resources <service> [--templates]        # resources/list | resources/templates/list
pmcp read <service> <uri>                     # resources/read — scoped endpoint only (§20)
pmcp connections | connection revoke <id>     # connection_list / connection_revoke (§19)
pmcp diff  -f mcps.yaml
pmcp apply -f mcps.yaml [--yes]
pmcp token issue (--account <slug> | --service <slug>) [--expires 90d]
pmcp token list | revoke <id>
pmcp audit [--account <slug>] [--service <slug>] [--session <id>] [--since 7d]
pmcp audit --export jsonl > events.jsonl      # streams the same rows as the web export
pmcp approvals [--pending | --history]
pmcp approve <id> | reject <id>
pmcp connect <service>                        # prints the /services OAuth connect URL (§7)
pmcp service create <slug> (--tunneled | --proxied <endpoint> [--auth headers|oauth])
                                              # tunneled create prints the service token once
pmcp service archive|unarchive|delete|disconnect <slug>
pmcp service set-auth <slug> --header 'Authorization: Bearer …'   # service_set_upstream_auth
```

All service and account references resolve within the logged-in user's namespace (the
CLI learns the username from `whoami` and builds `/<user>/mcp/…` URLs itself).

*(Amended 2026-08-26: the four §20 commands are gateway sugar of exactly the kind
`tools`/`call` already are — they front an MCP method, not an admin op, so they are
outside §8's parity list rather than an exception to it. `connections` is the opposite:
it fronts §19's two admin ops and is inside it. There is no `completion` command —
nothing observably consumes `completion/complete`, and §20 serves it for conformance,
not for a human.)*

Every subcommand except the auth family is presentation sugar: `ls`, `tools`, `token`,
`service`, `diff`, and `apply` are compositions of the same `pmcp_*` and MCP tool
calls that `pmcp call` (or any agent) can make directly — nicer output, zero extra
capability. The converse holds too: every UI capability is reachable from the CLI
(§8's parity invariant) — only the UX differs. YAML `diff`/`apply` is the CLI-native
way to manage services and grants declaratively; the imperative `pmcp service` family
covers the one-off actions the UI does with buttons.

Config: `~/.config/pmcp/config.toml` *(amended 2026-08-26; was config.json — an
existing flat `config.json` is read once as profile `default` and superseded by the
next write)*, holding named **profiles** — a profile is one hub identity: `url`,
`token`, and optionally `bootstrap_secret` (operator-written by hand, never by the
CLI; §12's script reads it):

```toml
profile = "default"        # active when nothing else selects one

[profiles.default]
url = "https://hub.example"
token = "…"                # written by `pmcp login`, cleared by `pmcp logout`

[profiles.local]
url = "http://localhost:8787"
token = "…"
bootstrap_secret = "…"     # dev-only; hand-written, survives login/logout
```

Profile selection precedence: `--profile <name>` flag > `PMCP_PROFILE` env var > the
file's top-level `profile` key > the name `default` (neutral on purpose — the CLI's
users are not only developers with environments). `login --profile <name>` writes
`url`+`token` into that profile alone; the top-level default is set only when the
write creates the file, and is otherwise never touched implicitly. `logout` clears
the active profile's token only. Environment variables stay flat and profile-free:
`PMCP_TOKEN` and `PMCP_URL` override whatever the active profile resolved — session
or service-account tokens only (`pmcp_svc_` tokens
are rejected by every consumer surface). With a service-account key, `tools`/`call`
work within grants; `ls` and every other admin-backed command fail (`ls` is sugar over
`pmcp_service_list`, and service accounts can never hold `pmcp` grants, §8). The hub's
`GET /api/whoami` route (§8) accepts both token kinds and returns
`{ principal, namespace }` — that's how the CLI builds `/<user>/mcp/…` URLs when it
holds only a service-account key. `PMCP_URL`
overrides the URL and is always the **https origin** — everywhere, including the client
libraries, which derive `wss://<origin>/connect` from it.

## 11. Client libraries

The service author writes a plain MCP server with the official SDK; our library owns the
connection. Roles are part of the service's code because the service is what knows its
tools' semantics.

Python (`pmcp-client` on PyPI):

```python
from mcp.server import MCPServer
from pmcp_client import serve

mcp = MCPServer("news")

@mcp.tool()
def get_news(topic: str) -> str: ...

serve(  # blocks; connects, registers, reconnects forever
    mcp,
    url="https://mcp.example.com",   # or PMCP_URL; wss://<origin>/connect is derived
    token=...,                        # or PMCP_SERVICE_TOKEN
    roles={"reader": ["get_news", "search_.*"]},
    # per-family form, §20 (added 2026-08-26) — a bare list still means tools:
    # roles={"reader": {"tools": ["get_news"], "prompts": ["digest_.*"],
    #                   "resources": ["news://feed/*"]}},
)
```

JS (`@personal-mcps/client` on npm): identical shape — `serve(server, { url, token, roles })`,
with the same two spellings (`Roles = Record<string, string[] | { tools?: string[];
prompts?: string[]; resources?: string[] }>`). Both libraries pass the declaration through
verbatim: normalization and validation are the hub's (§6), so neither library gains a
rule that could disagree with it.

Library responsibilities: dial + authenticate, `hub/register`, **answer the hub's
`server/discover`** *(added 2026-08-26, §20/§6: the library, not the author's SDK, owns
this answer — it is a hub↔library control question, no MCP SDK implements the method, and
the library is what knows which families the author actually registered. It is the one
MCP-namespace method the library handles itself instead of bridging through. A library
that does **not** implement it is not broken: the resulting `-32601` is the hub's
"capabilities unknown" signal and the hub falls back to warming tools only, §6 — which is
what keeps every service already in the field working unchanged)*, bridge WS frames to the
SDK's server session (custom transport), send `notifications/tools/list_changed` on tool
mutations *(and, from 2026-08-26, whichever of the prompts/resources list_changed
notifications the author's SDK emits — the bridge is transparent, so this is a
pass-through, not a feature the library implements)*, protocol pings, reconnect with backoff (403 at upgrade / close `4002` =
archived → keep retrying at max backoff, §6), stop on `hub/replaced`. Plus two
in-handler affordances (§7): the caller identity — `ctx.principal`, `ctx.roles`,
`ctx.has_role("editor")`, read from the forwarded `_meta` — and sensitive-field
marking, in two spellings: a `Secret` field type for pydantic-/zod-style tool
definitions (`api_key: Secret[str]` — the emitted JSON Schema carries
`writeOnly: true` at that path, in input and output models alike; schema-only,
values still serialize normally on the wire — the HUB does the masking, §7), and
path-based sugar for hand-written schemas (`sensitive(schema, ["password"])`,
input or output schema alike).

## 12. User management script

`scripts/users.ts` (run with `pnpm users …`), talking to `POST /internal/users` on the
Worker, guarded by a `BOOTSTRAP_SECRET` wrangler secret (constant-time compare). When
the secret is **unset, the route does not exist** (404 for everything) — so the owner
can keep it disabled between uses and re-enable with `wrangler secret put`. Every
invocation is logged. This secret is an all-namespaces master key (it can reset any
password): rotate it after each use, on any suspicion. `reset-password` deliberately
leaves TOTP/passkey enrollment intact, so a leaked secret alone doesn't defeat the
second factor. No email involved anywhere.

```
pnpm users create <username>     # generates a random password, prints it once
pnpm users list
pnpm users delete <username>
pnpm users reset-password <username>
```

The script itself reads only `PMCP_URL` and `BOOTSTRAP_SECRET` from the environment
(the master key never rides argv). Its `pnpm users` entry resolves a §10 profile
first — `--profile <name>` (consumed before the subcommand) or `PMCP_PROFILE`, then
the config file's default — filling those two variables from the profile's `url` and
`bootstrap_secret` wherever the environment hasn't already set them; an explicit
environment variable always wins *(amended 2026-08-26)*.

This seeds the first user and is the only user management surface for now. 2FA/passkey
enrollment happens through better-auth's endpoints after first login (minimal pages, §13).

## 13. Web surface

Deliberately tiny — server-rendered pages (Hono JSX) only where a browser is required:

- `/login` — username + password, TOTP challenge, passkey button.
- `/device` — device-approval page (user enters the code the CLI printed). Since we
  hand-build it anyway: it shows the requesting IP and user-agent and states plainly
  that approval grants **full admin CLI control of the namespace** (RFC 8628 §5.4 /
  cross-device-flow BCP: the user-code channel is unauthenticated, so the page is the
  phishing defense); the approval POST carries a CSRF token; device-code lifetime is
  set to ~10 minutes (down from better-auth's 30-minute default).
- `/account` — enroll/remove TOTP and passkeys, active sessions. Requires a
  cookie-authenticated session with recent authentication — bearer-sourced sessions are
  rejected on these routes (§4).
- `/audit` — read-only, cookie-session-gated view over the audit table (§5): a plain
  server-rendered table, newest first, with the same filters as `audit_query`
  (account, service, event, tool, time range) and offset/limit paging backed by
  `audit_query`'s `total` (desktop shows numbered pages, mobile a "Load more" that
  accumulates offsets — one contract, two presentations). An **Export JSONL** action
  streams every row matching the current filters, one JSON object per line: the
  handler re-runs the same query in `limit`-sized chunks and writes each chunk to a
  streaming response as it is fetched, never holding the full result set in memory —
  a serialization of `audit_query`, not a new capability. The expanded row detail
  shows the caller's client metadata when present (client name/version and session id,
  §5/§7) and the recorded call bodies when present (§15) — post-redaction args and
  result structuredContent, with stubs rendered as typed size placeholders (e.g.
  `‹blob image/png · 4.2 MB›`, never the bytes); the session id renders as a link to this same audit view filtered to that
  session (`?session=…`, backed by `audit_query`'s `session` filter). No mutations, so
  no CSRF surface.
- `/approvals` — cookie-session-gated: pending requests up top (account, service, tool,
  redacted arguments, requested time, approve/reject buttons — CSRF token on the POST),
  decision history below. `/approvals/<id>` is the detail page the `-32003` error links
  to; only the namespace owner can open it.
- `/services` — cookie-session-gated service management: active services (kind, status —
  online/offline for tunneled, connection state for OAuth-proxied — roles, last seen)
  with archive/delete actions; an archived section with unarchive/delete; an add-service
  flow (pick tunneled or proxied — the two kinds, §2; for proxied, after the endpoint
  the form asks for the authentication type, `headers` or `oauth` (§7); tunneled
  creation shows the service token once; choosing `oauth` continues into the provider's
  consent screen, §7); and
  Connect/Reconnect/Disconnect for `auth: oauth` services. CSRF tokens on every
  mutation. Future work for the add-service form: probe the entered URL (the §7
  RFC 9728 discovery) to suggest the auth type and surface provider-specific options,
  and accept manually pre-registered client credentials for OAuth providers without
  dynamic client registration. `/oauth/upstream/callback` belongs to this cookie-session-gated surface:
  it requires the owner's session and a live single-use `state` bound to it, per §7 —
  the callback is a mutation (it writes `upstream_auth_json`) and is guarded like one.
- `/oauth/consent` and `/oauth/connections` *(added 2026-08-26, §19 — the inbound
  direction, under the same already-reserved `oauth` segment)*: the consent screen an
  external MCP client's authorization request lands on (what the client is, what it
  asks for, which namespace, and the **service-account picker** that decides how much
  power it gets), and the list of connections it produces, with Revoke. Both are
  cookie-session-gated owner pages with a CSRF token on every POST, exactly like
  `/services` — the consent POST is a mutation (it writes the binding **and** authorizes
  a client) and is gated like the strictest one. §19 pins the flow.

**PWA**: the web surface ships a web-app manifest and a minimal service worker, so
the dashboard installs to phone and desktop home screens. Pages stay server-rendered —
the service worker exists for installability and push, not offline rendering (the
no-SPA pin holds, §1). **Approval push**: `/approvals` offers a per-browser "Enable
notifications" control; subscriptions land in `push_subscription` (§5), and every new
approval request sends a Web Push (VAPID keys in Worker secrets, ES256 via WebCrypto,
RFC 8291 payload encryption) naming the service and tool — never arguments — which
opens `/approvals/<id>` on tap. A `404`/`410` from the push service prunes the
subscription. Best-effort delivery; the dashboard is the source of truth (§7).

The dashboard pages `/services`, `/approvals`, and `/audit` and the CLI are both
fronts over the same server-side handlers as the `pmcp` tools — one implementation,
three surfaces. `/account` is the deliberate exception: credential management (TOTP,
passkeys, active sessions) rides better-auth's endpoints and is intentionally
web-only — §4's session-scope guards reject bearer-sourced sessions there precisely so
no CLI token or `pmcp` tool can ever reach it.

## 14. Alternatives considered

- **Tunnels per service (cloudflared/ngrok) + plain remote MCP servers** — no unified
  auth, roles, or registry; N tunnels to babysit. Rejected: the registry and grant model
  is the point of the project.
- **Cloudflare `McpAgent`** — deprecated, frozen on MCP SDK v1. Rejected.
- **Full OAuth provider now** (`@better-auth/oauth-provider` — this entry as first
  written paired it with `@better-auth/mcp`, which is wrong and is corrected in the
  parenthetical below: they are one plugin, not two) —
  ~6 extra tables, jwt plugin, consent pages; only needed when third-party MCP clients
  should OAuth in directly with RFC 9728 discovery. Deferred; the design slots it in
  later without rework (the device-flow plugin and login pages are the groundwork).
  *(Taken 2026-08-26 — §19. The estimate held: seven provider tables plus `jwks`, the
  jwt plugin, and one consent page. The prediction that missed is which package:
  `@better-auth/mcp` is not a companion to `@better-auth/oauth-provider`, it IS that
  plugin with MCP presets and cannot be combined with it, and §19 takes the
  provider alone because the hub is multi-tenant and mcp() serves exactly one
  resource identifier.)*
- **D1 for per-service state** — network hop on every DO wake for no benefit; DO SQLite
  is colocated and priced identically. D1 kept only for the shared control plane.
- **OAuth to upstream servers** — originally deferred, now in scope as `auth: oauth`
  proxied services (§7): the interactive connect flow was the missing piece for real
  upstreams like Linear, and the hub already had the encrypted credential store and
  browser surface it needs. Static headers remain the default for upstreams that take
  a token.

## 15. Error handling and operational behavior

- Every forwarded request, both kinds: 30 s hard timeout → JSON-RPC error to the caller.
  Tunneled: the DO's pending map is rejected on socket close. Proxied: the upstream
  fetch is aborted at the same deadline.
- Hub deploys terminate all WebSockets: services reconnect (backoff), consumers retry.
  Treat every `tools/call` as at-most-once.
- Duplicate service connection: newest wins, oldest gets `hub/replaced` + close 4000.
- Unavailable service (tunnel offline, proxied upstream unreachable, or proxied
  upstream HTTP/protocol failure — §7): `-32000` immediately, no queueing; archived
  services return `-32002` instead (§6). (Queue-and-retry is a later feature if it
  ever hurts.)
- Token revocation: consumer tokens are checked on every request, so revocation is
  immediate there. A revoked *service* token (or a deleted service) additionally severs
  the live reverse connection — the Worker tells the DO to close the socket with code
  `4001` (§8); a racing re-register fails because the service row / token is gone.
- User deletion (`/internal/users`) performs the same teardown as `service_delete` for
  every tunneled service in the namespace — close `4001`, wipe DO cached state — before
  the row cascade. (DOs are addressed by `service.id`, so even a missed teardown can
  never be rebound by recreating the username.)
- Rate limiting: one Cloudflare WAF rate-limiting rule (available on all plans) covers
  `/login`, `/device`, `/api/auth/*`, and `/internal/users` — brute-force protection
  for passwords, TOTP challenges, and device codes lives there. better-auth's built-in
  limiter is in-memory (per-isolate — a no-op on Workers) and is not relied on.
- Log hygiene: `Authorization` headers and anything matching `pmcp_(sa|svc)_…` are
  redacted from logs, error responses, and exception traces; `writeOnly`/config-declared
  sensitive fields are masked before any storage or display (§7). The rule is uniform
  across services — the `pmcp` builtin needs no special case, because its one secret
  (`token_issue`'s key) is a `writeOnly`-marked output field masked like any other
  (§8). Every persisted body (approval `args_json`, the audit body columns) is
  post-redaction and pruned by the same daily cron as audit.
- Audit trail: the D1 `audit` table (§5) is the record of record — structured,
  per-namespace, queryable (`audit_query` / `pmcp audit`); Workers Logs lines are ops
  debugging only. Recorded: every
  `tools/call` (allowed and denied, with hub-measured `duration_ms` for latency
  visibility in `/audit`, and the caller's self-declared client name/version/session
  id when sent, §7 — display data only), approval lifecycle transitions
  (`approval.requested/approved/rejected/expired`), every mutating `pmcp` admin tool,
  logins, device approvals, connect/register/replaced/roles_widened events, and bootstrap
  invocations. *(Amended 2026-08-26: plus every `prompts/get` and `resources/read` —
  §20's reads are audited like a call, with the prompt name or the resource URI in the
  `tool` column, the URI **query-redacted and length-capped** before it is stored,
  because a URI's query component is a routine carrier of somebody else's bearer token
  and the scrubbing grammar in this same bullet only knows the hub's own
  `pmcp_(sa|svc)_` shape — §20.4 pins the exact rule — and §19's connection lifecycle,
  `oauth.consented` /
  `oauth.rebound` / `oauth.revoked` / `oauth.client_registered`.)* Not recorded:
  `tools/list` (agent polling noise) — *(and, by the same rule, every §20 LIST method
  plus `completion/complete`, which is a listing of argument suggestions)* — and token
  material never, in any column.
- Audit bodies: a `tools/call` row carries the call's bodies when the service's
  `log_bodies` flag is on AND the call was actually dispatched. Refusal rows
  (`-32000`/`-32001`/`-32002`/`-32003`) never carry bodies — several refusals happen
  before any redaction map exists (a catalog-miss has no schema, §7), so recording
  them would persist unmasked arguments. The flag's default is by kind: tunneled
  **on** (our libraries
  declare secrets in both schema directions, §7/§11), proxied **off** (no trustworthy
  schema; the owner opts in per service and covers it with `redact` /
  `redact_results` paths, §9); the virtual `pmcp` builtin has no service row and is
  fixed **on** (its schemas are the hub's own, §8 — which is how `token_issue`'s key
  is "masked wherever bodies are recorded" rather than special-cased). What is
  stored: `params.arguments` post-redaction, and
  the result's `structuredContent` post-redaction. Unstructured result content
  (text/image/resource blocks) is never stored — each block becomes a typed size stub
  (`{stub: "blob", contentType, bytes}`), so "the image generator returned a 4 MB png"
  is visible without the bytes. Each body is capped at `AUDIT_BODY_CAP_BYTES`
  (default 16 KiB, env-overridable): an over-cap body is replaced whole by an
  `oversize` stub — never truncated into corrupt JSON. Exact stub spelling is pinned
  by the contract fixtures at implementation. MRTR `inputResponses`/`requestState`
  never enter the body columns (§7). *(Amended 2026-08-26: §20's read rows carry
  bodies under the same `log_bodies` gate and the same envelope — which is why prompt
  messages and resource contents need no new rule: they are content blocks, and
  content blocks are stubbed, never stored. A resource's own URI is not a body; it
  is the row's `tool` column, and it is the one caller-supplied string this bullet's
  rules did not already cover — §20.4 caps it and strips its query component before it is
  stored, on top of this section's token-grammar hygiene. Prompt **arguments** are the
  other exception §20 records: a prompt has no JSON Schema and therefore no `writeOnly`
  channel, so the tunneled default that this bullet justifies by "our libraries declare
  secrets in both schema directions" does not reach them — §20.3 puts prompt-argument
  bodies on the proxied posture instead.)*
- Retention: a daily cron trigger prunes audit and approval rows past the retention
  window — default **7 days**, `AUDIT_RETENTION_DAYS` env var overrides. Deliberately
  short: whatever the audit table holds, `audit_query` can read (§8), so retention is
  the primary bound on body exposure; the JSONL export (§13) is the archive path for
  anyone wanting longer. The trade, stated once: seven days is also the forensics
  window — a quietly abused token must be noticed within it. The coarse
  `last_used_at` on tokens (§5) carries the rotation/staleness question past the
  window.

## 16. Testing

- **server**: vitest + `@cloudflare/vitest-pool-workers`. Core integration test: fake
  service connects over WS to the DO, consumer POSTs `tools/list`/`tools/call` through
  both the aggregated and scoped endpoints, asserts role filtering, prefix routing,
  namespace isolation (cross-user 404), offline/archived errors, timeout behavior,
  connection replacement; a proxied service backed by an in-test fake upstream asserts
  forwarding, virtual-role filtering, and upstream-failure mapping (unreachable, HTTP
  401/500, non-JSON-RPC body — all `-32000`, upstream body never echoed) — including
  aggregated `tools/list` with one failing or hanging upstream: the aggregate succeeds
  without that service's tools (slug listed in `_meta.pmcp/unavailable`) while the
  scoped list fails `-32000`.
- **clients/py**: pytest; the WS↔anyio bridge tested against an in-process websocket
  server; reconnect/backoff logic unit-tested with a fake clock.
- **clients/js**: vitest; same shape.
- **cli**: unit tests for YAML diff (pure function: desired + current → plan).
- **pattern matching**: regression tests pinned by §7 — `foo|bar` must NOT match
  `foox` (naive `^foo|bar$` parses as `(^foo)|(bar$)` and matches it via the `^foo`
  branch; correct `^(?:foo|bar)$` rejects it) but must match `foo` and `bar` exactly;
  literal-grammar patterns (`^[A-Za-z0-9._-]+$`) compare literally — pattern
  `get.news` must NOT match tool `getXnews` — while patterns outside the grammar
  still compile (`search_.*` matches `search_news`).
- **approval flow**: call → `-32003` with link → approve → identical retry executes
  once → second identical call opens a fresh pending; N concurrent identical calls
  against one approval dispatch exactly once (the CAS claim; losers get `-32003`);
  retry while still pending returns the same approvalId without a new row; a
  past-expiry pending row reads as expired everywhere and emits `approval.expired`
  exactly once; changed args don't match; reject and expiry paths; an MRTR exchange
  rides one approval — an approved call returning `input_required` restores it, the
  follow-up leg carrying `inputResponses`/`requestState` executes and a `complete`
  result marks it `used`, and `inputResponses` never appear in the stored `args_json`;
  `writeOnly` and config-declared fields masked in the stored `args_json`; audit
  bodies recorded per `log_bodies` (tunneled default on, proxied default off, either
  flips): args and result structuredContent masked in both directions — input-schema
  and output-schema `writeOnly` plus `redact`/`redact_results` paths — unstructured
  blocks stored as stubs, an over-cap body as an `oversize` stub, `writeOnly`
  stripped from served outputSchemas, and `token_issue`'s key masked in its recorded
  result by the uniform rule; identity
  `_meta` present on tunneled calls with the consumer's `clientCapabilities` mirrored
  onto the forwarded request (both kinds, `{}` when absent); a consumer-supplied
  `_meta` key under `hub/` (e.g. a forged `hub/roles`) is stripped before forwarding
  while non-reserved keys like `progressToken` survive; `X-Pmcp-*` headers present
  only with `forward_identity: true` and absent by default.
- **upstream oauth**: fake AS in-test — expired access token triggers refresh before
  forwarding; failed refresh surfaces needs-reconnect and calls fail `-32000`; a
  callback carrying a valid code but a missing, consumed, expired, or other-session
  `state` is rejected and writes nothing.
- **inbound oauth** (§19): the discovery documents are served at the exact probed paths
  and the AS document's `issuer` is byte-identical to the URL it was fetched from; the
  401 challenge on `/<user>/mcp` names the per-user `resource_metadata` and is the same
  bytes for a live and an absent namespace; a JWT for another namespace's audience, an
  unsigned/expired one, and one whose binding is revoked or gone are each refused with
  that same challenge; a valid one resolves to `sa:<slug>` and is thereafter
  indistinguishable from a `pmcp_sa_` key (same grants, same refusals, same audit
  principal, still no `pmcp` grants — including on the scoped shape, which the
  namespace-wide audience of §19.6 keeps reachable); a JWT minted from a live session at
  `/api/auth/token` is refused at the door, because hub-signed is never the acceptance
  test; no OAuth-leg failure of any kind resolves as the owner (the leg is terminal); a
  registration whose `redirect_uri` is not an exact registered string is refused before
  any consent screen renders, and one carrying its own `client_id` gets a different,
  server-assigned one; the consent screen names the client, the redirect origin and the
  unverified-identity marker, and renders its empty state with no service accounts; the
  consent POST without a CSRF token is refused;
  D11's allowlist admits an `Authorization` header under `/api/auth` only at `/sign-out`
  and `/device/*`, so `/api/auth/token` refuses one while the whole OAuth round-trip
  completes without ever sending one. `scripts/smoke.ts` runs that round-trip against the
  deployed worker with no browser (§19).
- **the router walk** (§2's reserved-list equivalence): the walk decides "is this segment
  served?" by probing a path under it and comparing the answer with an unrouted path. For
  every segment so far that probe is `/<seg>`; for `.well-known` it must be the entry's
  own **document path** (`/.well-known/oauth-authorization-server`), because that mount
  serves two exact documents and answers the ordinary anonymous 404 for everything else,
  `/.well-known` itself included (§19.2). The probe path is per-entry **data** in the
  walk's table, not a special case in its logic — every future mount that serves only
  exact paths needs the same thing, and the alternative (a distinguishable segment-404 so
  the walk can tell) would spend the one-404 doctrine to buy a test convenience.
- **data model beyond tools** (§20): per-family door cases on both endpoint shapes
  (aggregated prompts prefixed and split, resources scoped-only, `-32601` where a family
  is not served); a bare role list still means tools and grants nothing in another
  family; a resource pattern matches by the family's literal rule, and matches the
  resource's **`uri`** — a resource whose *name* matches a granted pattern while its URI
  matches none is neither listed nor readable; `completion/complete` refuses a `ref` no
  pattern matches; a role that gains a family under live grants writes
  `connect.roles_widened`; a service that stops declaring a family has that catalog
  cleared while a merely *failed* warm still leaves the previous one; a public
  `cacheScope` from a service is downgraded to private; read rows land in audit with the
  prompt name / query-redacted resource URI and their contents stubbed.
- One `scripts/e2e.md` runbook (manual): deploy to a dev worker, run the example service,
  `pmcp call` round-trip.

## 17. Repo layout

```
personal-mcps/
  server/            # CF Worker: auth, proxy, pmcp admin MCP, ServiceConnection DO, migrations/
  cli/               # pmcp
  clients/
    js/              # @personal-mcps/client
    py/              # pmcp-client (uv project)
  examples/
    news-py/         # smallest possible service, used in docs and e2e
  scripts/           # users.ts
  docs/superpowers/specs/
  mcps.yaml          # the owner's actual config (gitignored? — no: it contains no secrets, keep it)
  pnpm-workspace.yaml
```

## 18. Decisions made by default — review these

1. **CLI auth = device flow → session token**, not a full OAuth 2.1 provider (§14). The
   full provider is the documented upgrade path when external MCP clients need to log in
   on their own. *(Amended 2026-08-26: that upgrade landed as §19, and the CLI did **not**
   move onto it — the device flow issues an owner session, §19 issues service-account
   authority, and those are different powers. The CLI stays where it is.)*
2. **Namespaces are silos.** Each user fully controls their own namespace and can't see
   any other; there is no sharing, no global admin, no cross-namespace grants. Sharing a
   service between users would be a real design extension — out of scope until wanted.
3. **Tunneled services' roles live in service code**, declared at registration — the
   YAML only references them; central YAML definitions for tunneled roles were rejected
   because only the service knows its tools. Proxied services are the exception: their
   virtual roles are defined in config, because the upstream can't declare any.
4. ~~**v1 proxies tools only** — no resources, prompts, or push notification streams.~~
   **Revised 2026-08-26 (§20): the hub proxies the MCP data model.** Prompts,
   resources, resource templates and completions are served; MRTR (elicitation,
   sampling, roots) extends to `prompts/get` and `resources/read`. Only the
   *push* half of the original sentence survives: `subscriptions/listen` and every
   server→consumer notification stay out, because the consumer surface is POST/JSON
   with no stream and the DO↔worker seam is request/response — §20 records the reason
   per feature, and the corollary rule that no capability may be declared that the
   transport cannot honor (a declared `listChanged` would make a v2 client open a
   listen stream, get `-32601`, and spend its reopen budget).
5. **Usernames, not emails**, with synthesized placeholder emails internally.
6. **`apply` deletes by default** (after showing the diff and confirming) — the YAML is
   desired state, not additive patches.
7. Naming: repo `personal-mcps`, CLI/binary `pmcp`, packages `@personal-mcps/*` /
   `pmcp-client`.
8. **Service/service-account tokens are our own hashed-token table**, not the
   `@better-auth/api-key` plugin — the plugin can only bind keys to users/organizations
   and can mint sessions from keys, which would bypass the grants model (§4).
9. **Role patterns are anchored regexes** (a bare tool name matches itself; `*` is an
   alias for `.*`), for both tunneled-declared and proxied virtual roles — one pattern
   language everywhere, and regex was wanted for virtual roles anyway.
   **Revised 2026-08-26 (§20): the same language, now over three keyspaces.** A role
   holds a pattern list per family (tools, prompts, resources); a bare list is the tools
   list, so every existing declaration, YAML file and `serve({roles})` call keeps its
   exact meaning. The one addition the regex language needed is a second literal fast
   path: the tool/prompt rule (`^[A-Za-z0-9._-]+$` → compared as a string) cannot cover
   URIs, whose `:` and `/` would drop every resource pattern into regex compilation
   where `.` matches anything. Resource patterns are therefore compared literally when
   they contain no regex metacharacter (`* + ? ( ) [ ] { } | ^ $ \`) — which leaves
   `.` literal in both families, the property the §7 regression test already pins for
   `get.news`.
10. **The wildcard role is named `all`, built-in on every service** (both kinds),
    matching all tools present and future; it never appears in `roles_json`, is
    rejected in declarations (it fits the role-name charset, so the rejection is
    explicit), and is resolved at request time. Renamed from `*`, which read like a
    regex; `*` remains only as a pattern alias for `.*` (item 9).
11. **Proxied upstream auth is static headers (default) or interactive OAuth**
    (`auth: oauth`, §7) — connected from `/services`, tokens encrypted at rest (§5),
    never in YAML (which declares only the mode; the mode is stored in its own
    `upstream_auth_mode` column, distinct from the credential envelope, and flipping
    it wipes stored credentials, §8).
12. **Token expiry defaults differ by kind**: 90 d for service-account tokens (they get
    pasted into agent configs), none for service tokens (telegram-bot model, bots on
    home servers shouldn't silently die) — both overridable at issue time.
13. ~~**No MCP-native OAuth discovery in v1**~~ **Revised 2026-08-26 (§19): the hub is
    an authorization server.** The upgrade path this item promised is the one that was
    taken — the 401 gained `resource_metadata`, the hub serves RFC 9728 and RFC 8414
    documents, and claude.ai connects with no manual header. Manually configured bearer
    headers keep working unchanged and stay the supported route for Claude Code (which
    prefers a configured `Authorization` header over OAuth anyway, and fails rather than
    falling back if one is set).
14. **Roles are not a boundary against the service itself** (§2): grants confine
    accounts; the service is trusted. Drift logging, not pinning, is the v1 answer.
15. **Approvals never block the original request** in v1 — the agent gets `-32003` +
    a link immediately, and an approval is a single-use, args-hash-bound pass consumed
    by an identical retry. Blocking-until-decided is declared future work (§7); the
    owner is Web Push-notified through the PWA instead (§13). The retry-with-identical-args contract is the simplification to
    revisit if agents handle it poorly. An approval spans a full MRTR exchange —
    consumed on `resultType: "complete"` (or service error), not at first dispatch —
    and the args binding is `params.arguments` only, excluding
    `inputResponses`/`requestState` (§7).
16. **Sensitive fields are declared as JSON Schema `writeOnly`** (standard keyword, no
    invented syntax) for tunneled services — in **both directions**: the client
    libraries' `Secret` field type emits it in input and output schemas alike, and the
    hub strips it from outputSchemas served to consumers (internal marker only, §7) —
    plus config-declared `redact` / `redact_results` paths on
    either kind — config is the *only* proxied path in v1, since proxied schemas are
    never cached (§7). The walk resolves same-document `$ref`s and unions
    composition branches; indirection it cannot soundly resolve (external refs,
    `$id`/`$dynamicRef`, recursive-secret cycles) makes the tool loudly
    schema-unsound — no map, `-32001` on gated calls, no recorded bodies — never a
    silent skip (§7). The approval `args_hash` binds post-redaction arguments only.
17. **Caller identity rides `_meta` (tunneled) / `X-Pmcp-*` headers (proxied)** —
    informational for the hub — never a boundary the hub itself relies on — but
    trustworthy for service-side fine-grained checks because the hub strips
    consumer-supplied `hub/*` `_meta` keys before injecting its own (§7). Proxied
    identity headers are opt-in per service (`forward_identity`, default off) — never
    sent to upstreams the owner hasn't marked.
18. **Forwarded requests assert the consumer's `clientCapabilities`**, mirrored per
    request — the hub never advertises input capabilities of its own; MRTR round-trips
    pass through as ordinary `tools/call` retries (§7).
19. **Parity invariant**: everything the web UI and CLI can do has an equivalent
    `pmcp` tool, so AI agents with an admin token have full capability. The pinned
    exceptions — the auth/credential family, the OAuth consent redirect, and the
    JSONL export serialization — are §8's list; the auth family is deliberately never
    exposed to models.
20. **Client metadata is captured on audit rows** (`clientInfo` name/version plus an
    allowlisted vendor session-id `_meta` key, e.g. Claude Code's) — truncated,
    untrusted, display-and-filter only (`audit_query.session`), never authorization
    input (§5, §7).
21. **The web surface is a PWA** (manifest + minimal service worker; pages stay
    server-rendered, no SPA) and approval requests are Web Push-notified through it
    (§13). Blocking-until-decided remains future work.
22. **Audit rows carry call bodies, post-redaction, under short retention** (§15):
    per-service `log_bodies` (tunneled default on, proxied default off — proxied
    schemas can't be trusted, so the owner opts in and covers secrets with config
    paths); results only as masked `structuredContent`; unstructured content and
    over-cap bodies become typed size stubs (cap `AUDIT_BODY_CAP_BYTES`, default
    16 KiB); retention default **7 days** (`AUDIT_RETENTION_DAYS` overrides) — short
    retention is the accepted mitigation for `audit_query` exposing whatever the
    table holds, and the JSONL export is the archive path. Storing the stubbed blobs
    themselves (e.g. R2, referenced from the stub) is the natural future upgrade.
23. **An OAuth-connected client gets service-account power, never owner power** (§19).
    The connection binds to one service account chosen by the owner at consent, and is
    confined by that account's grants exactly like a `pmcp_sa_` key — so it can never
    hold `pmcp` grants and never reaches an admin tool. §2's access model gains a new
    way to *present* a credential and no new kind of authority.
24. **Consent is an explicit screen, and the binding is the revocation handle** (§19).
    No silent auto-approve, no per-client trust flag: the owner sees what the client
    asks for, picks the service account, and can revoke from `/oauth/connections` or
    `connection_revoke`. Revocation is immediate because the door reads the binding row
    on every call — the same one-read-per-request cost a `pmcp_sa_` key already pays,
    which is what lets access tokens keep an ordinary lifetime instead of being cut
    short to bound a JWT the fast path never re-checks.
25. **The auth/credential family is never widened by the authorization server** (§19).
    *(Revised 2026-08-26 with D11's PSD follow-up: the gate became a fail-closed
    **allowlist** — an `Authorization` header is admitted under `/api/auth` only at
    `/sign-out` and `/device/*`, everything else on the mount refuses one. That is
    strictly stronger than the "names the credential paths explicitly" deny-list this
    item first described, and it is what makes adopting a plugin bundle safe rather than
    an audit exercise: `jwt()` mounts `/api/auth/token`, a session→hub-signed-JWT
    converter nobody would have thought to deny-list, and the allowlist refuses it
    without being told. §19's own endpoints need no entry either, because every client the
    hub supports is a public client that sends no `Authorization` at all — §19.7 has both
    arguments.)* None of these endpoints gains an MCP tool (§8's exception list), and the
    door never treats "signed by the hub" as sufficient authority (§19.6 step 3).
26. **Resources do not aggregate** (§20). Tools and prompts are addressed by name and
    take the existing `<slug>_` prefix; resources are addressed by URI, and no prefix
    can ride a URI without rewriting it — in listings, in templates, in read results,
    and inside every `resource_link` or embedded resource block a *tool* result may
    carry. Rewriting there would end "the response is relayed verbatim". So the
    aggregated endpoint serves tools and prompts, the scoped endpoint
    `/<user>/mcp/<slug>` serves everything, and a resource-heavy service is mounted
    scoped — a shape the hub already supports first-class.
27. **Reads are audited, never approval-gated** (§20). Approvals stay a `tools/call`
    concern: `prompts/get` and `resources/read` write audit rows like a call, under the
    same `log_bodies` gate and redaction rules, but never open a pending approval. The
    reason is mechanical as well as conceptual — `approval`'s pending-binding index is
    `(account, service, tool, args_hash)`, so gating another family would let a prompt
    and a tool of the same name share one approval. No migration, no discriminator
    column, no ambiguity.

## 19. Inbound OAuth — the hub as an authorization server

*Added 2026-08-26. Reverses §14's deferral and §18 decision 13; §18 decisions 23–25
carry the owner-level calls. Implemented as its own workflow, ahead of §20.*

The gap this closes: a spec-conformant remote MCP client — claude.ai's custom
connectors first — cannot be handed a `pmcp_sa_` key through a header field. It expects
to discover an authorization server from the MCP endpoint, run authorization-code +
PKCE in the owner's browser, and present the resulting access token. Today
`/<user>/mcp` answers 401 with a bare `WWW-Authenticate: Bearer`, nothing serves
`/.well-known/*`, and the client's legacy fallback walks to a path-stripped
`/authorize` that does not exist. Everything below exists to make that walk end at a
consent screen instead of a 404.

**What it is not**: a second way to be the owner. §18 decision 23 is the whole security
story — an OAuth connection binds to a **service account**, and from the moment the
token reaches the door it is indistinguishable from that account's `pmcp_sa_` key:
same grants, same approval gates, same `sa:<slug>` audit principal, and the same
inability to hold a `pmcp` grant (§8), so no connected client can ever reach an admin
tool. The access model of §2 is untouched. What is new is a credential shape.

### 19.1 Vehicle

`oauthProvider()` from **`@better-auth/oauth-provider`** (1.7.1, in lockstep with
core), plus better-auth's `jwt()` plugin, which the provider requires and throws
`jwt_config` without. Two findings shaped this and are recorded because they contradict
what §14 assumed:

- `oidcProvider` and `mcp` no longer exist inside `better-auth` 1.7.1 — they were
  extracted into separate packages. `@better-auth/mcp` is not a companion plugin: it
  **is** `oauthProvider()` with MCP presets and explicitly cannot be combined with it.
- `mcp()`'s presets take exactly **one** `resource` string and serve RFC 9728 metadata
  for that identifier alone. This hub is multi-tenant — the resource identifier is
  `https://<origin>/<user>/mcp`, one per namespace — so the presets do not fit. The hub
  takes `oauthProvider()` and serves its own protected-resource documents, which is
  five lines of JSON interpolated from a path parameter.

**The verify side is not free, and the first version of this paragraph said it was.**
That claim — `verifyAccessTokenRequest` and `verifyJwsAccessToken` from
`better-auth/oauth2`, JWKS cached in-process, no D1 read on the hot path — is false
against the installed tree, and it is corrected here rather than quietly dropped because
§19.6's door leg and its lifetime argument both leaned on it. What 1.7.1 actually
exports:

- `better-auth/oauth2` exports **no verification primitive at all**. Its whole surface is
  the *outbound* social-provider helpers (`generateState`, `parseState`,
  `handleOAuthUserInfo`, `decryptOAuthToken`, …). Neither named symbol exists anywhere in
  the package; they were written into §14's estimate from a newer API surface than the one
  this spec pins.
- `better-auth/plugins/jwt` exports `verifyJWT`, `resolveSigningKey`, `signJWT` and
  `getJwtToken`. `verifyJWT(token, options?)` returns the payload or **`null`** — it never
  throws a decision, which suits a door leg that must fail closed — and it already
  enforces two of the door's own rules: it refuses anything that is not exactly three
  `.`-separated segments, and it verifies `iss`/`aud` against `options.jwt.issuer` /
  `options.jwt.audience`, defaulting both to `baseURL`. Two costs ride with it: it
  resolves the public key **through the auth adapter** (a D1 read of `jwks` per call, not
  an in-process cache), and it reads its auth context out of AsyncLocalStorage, so it is
  callable only inside a better-auth endpoint context. `resolveSigningKey` takes a
  `GenericEndpointContext` and is likewise not reachable from a plain Hono handler.
- `jose` is in the tree today only as better-auth's own transitive dependency. Verifying
  with `createRemoteJWKSet` + `jwtVerify` against the hub's `/api/auth/jwks` is the
  variant that genuinely caches in-process and costs zero D1 reads — at the price of one
  direct dependency and one self-`fetch` per isolate per cache window.

Which of the two the door takes is a **blocking probe observation**, not a decision this
spec makes: both satisfy every rule §19.6 states, and the choice turns on one fact
(whether `verifyJWT` can be driven from a Hono handler at all) that is far cheaper to
observe than to argue. What the spec does pin, because §19.6's revocation argument
depends on it and neither variant changes it: the door reads `oauth_binding` on **every**
call regardless, so verification is never the only per-request cost and a path that adds
one D1 read is a bounded regression, not a correctness one. No lifetime shortening
follows from either answer.

### 19.2 Routes and documents

One new top-level segment, `.well-known` (§2; the dot keeps it outside the username
charset, and it joins `ROUTES` so the §16 router walk stays total and the reservation
cannot drift). The segment claims its subtree like every other mount:

| Path | Method | What it answers |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 AS metadata, from the provider's own `oauthProviderAuthServerMetadata(auth)` helper — which exists precisely because a `basePath` (`/api/auth`) otherwise keeps this document off the root. |
| `/.well-known/oauth-protected-resource/:user/mcp` | GET | RFC 9728 protected-resource metadata for that namespace, built by the hub. |
| `/api/auth/oauth2/*` | (plugin) | `authorize`, `token`, `register`, `revoke`, `introspect`, `consent`, `continue`, `public-client(-prelogin)` and the client-management endpoints — all under the **existing** `api` segment, mounted by the plugin, no route work. |
| `/api/auth/jwks` | (plugin) | The JWKS the door verifies against (§19.1). Public by construction — it is public keys. |
| `/api/auth/token` | (plugin) | **Named here because it is easy to miss, and this table would otherwise read as complete.** `jwt()` mounts it as a side effect, and it converts a live *cookie session* into a hub-signed JWT. It is no part of §19's flow and nothing here ever calls it. Two independent things keep it harmless: §19.7's allowlist means no bearer can reach it, and §19.6 step 3 means the door refuses any hub-signed JWT that is not an access token for the addressed namespace — so even a cookie-holding browser that mints one gains nothing at `/<user>/mcp`. |
| `/oauth/consent` | GET, POST | §19.5's screen, under the **existing** `oauth` segment. |
| `/oauth/connections` | GET, POST | The connections list and its Revoke, same segment. |

Pinned properties of the two documents:

- **Issuer is the origin root.** `jwt`'s `issuer` is set to `PUBLIC_ORIGIN`, so a client
  that reads `authorization_servers: ["https://<origin>"]` probes exactly
  `/.well-known/oauth-authorization-server` and the document's own `issuer` is
  byte-identical to the URL it built — a client MUST NOT use metadata where it is not.
  Endpoints inside the document keep pointing at `${baseURL}/oauth2/*`
  (`/api/auth/oauth2/…`); an issuer and its endpoints need not share a path.
- **The PRM is per-namespace and derived from the path**, never from a lookup:
  `{ resource: "<origin>/<user>/mcp", authorization_servers: ["<origin>"],
  bearer_methods_supported: ["header"], scopes_supported: ["mcp"] }`. A username that
  does not exist gets a well-formed document, for the same anti-enumeration reason §7
  step 1 gives the 401 the same bytes either way. `authorization_servers` has exactly
  one entry — Claude reads entry [0] and never falls back to a later one.
- **The root PRM (`/.well-known/oauth-protected-resource`, no path) is deliberately not
  served** — 404. It could only name one namespace, and serving both forms raises a
  precedence question (which wins, and whether a non-matching `resource` is rejected or
  silently used) that not serving it removes.
- **Every unrouted path under `/.well-known` answers the hub's ONE anonymous 404**, the
  same bytes as any other unrouted path anywhere on the origin — `/.well-known` itself
  included. The mount serves exactly the two documents above and claims nothing else, and
  the one-404 doctrine is not weakened to make discovery legible: a client learns which
  documents exist by fetching them, and learns nothing from a miss. The alternative
  considered and rejected was a distinguishable "segment 404" so §16's router walk could
  tell served-from-reserved by probing `/<seg>`; that spends a security property on a test
  convenience. The walk changes instead — it probes this entry's own **document path** —
  and §16 pins that.
- **CORS.** `GET` on **the two served well-known documents** answers with
  `Access-Control-Allow-Origin: *`: they are public metadata, carry no credential and no
  per-caller content, and a browser-side client fetching them cross-origin is a supported
  way to discover the hub. The header lives on the documents, never on the mount — an
  unrouted path under `/.well-known` answers the ONE anonymous 404 with no CORS header,
  byte-identical to any other unrouted path, which the bullet above depends on.
  `/api/auth/oauth2/token` keeps the provider's own posture and gains no CORS headers —
  its callers are server-side, and adding them would only invite a browser to attempt a
  code exchange from script.
- The 401 challenge on `/<user>/mcp` is the other half of discovery, and the half that
  matters most: `WWW-Authenticate: Bearer error="invalid_token",
  resource_metadata="<origin>/.well-known/oauth-protected-resource/<user>/mcp",
  scope="mcp"`. It must ride a **401** — a `WWW-Authenticate` on a 200, or a JSON-RPC
  error payload, produces no auth prompt in Claude at all. The `<user>` in that URL is
  interpolated from the request **path**, and the reason no unvalidated text can reach a
  response *header* is an **ordering** property rather than an escaping one: the
  composition root rejects any first segment outside the username charset — or on the
  reserved list — with the anonymous 404 *before* the door runs, so by the time the
  challenge is built the segment is already known to be `[a-z0-9-]`. That ordering is what
  the byte-identical-challenge rule rests on; reordering the two is how this becomes a
  header-injection surface. `/api/whoami` keeps the bare `Bearer` challenge: it is not an
  MCP resource and has no metadata to name.

### 19.3 Provider options, pinned

- `scopes: ["mcp", "offline_access"]`. One functional scope, so the challenge's `scope`,
  the PRM's `scopes_supported`, and what the consent screen displays are trivially the
  same string. **No `openid`** — a connection is not a login, which also means no
  id_tokens and no `/.well-known/openid-configuration` to serve.
- `offline_access` is what mints refresh tokens; without it a connector dies at every
  access-token expiry. Rotation is the provider's default and stays on (both Claude
  surfaces register as public clients, where OAuth 2.1 requires it).
- PKCE S256 is required for every client — the provider's default, and Claude's
  unconditional behavior. Only `response_type=code`, only `response_mode=query`.
- `authorization_response_iss_parameter_supported: true`, and the `iss` parameter on
  every redirect: Claude Code's v2 runtime fails a sign-in whose authorization response
  names an unexpected issuer.
- **Dynamic client registration is on** (`allowDynamicClientRegistration` and
  `allowUnauthenticatedClientRegistration`), because it is the only mechanism both
  hosted Claude and Claude Code take with nothing typed by the owner. The accepted cost,
  stated plainly: anyone who can reach the origin can create a row in `oauthClient`
  (rate-limited by the provider at 5/60 s and by §15's WAF rule). A registered client
  authorizes **nothing** — it cannot obtain a token without the owner signing in and
  consenting in their own browser — so the exposure is table growth, not access. The
  daily cron (§15) deletes clients older than the retention window that hold no consent
  and no binding. Two properties below (`client_id` assignment and redirect matching) are
  what make "authorizes nothing" true; without them, open registration is open
  impersonation.
- **Client identity is assigned by the authorization server.** A `client_id` present in a
  registration body is **ignored**, and a fresh server-assigned id is minted; a
  registration can never name an id that already exists, and never inherits one. This is
  load-bearing, not hygiene: §19.4's `UNIQUE (owner_id, client_id)` and §19.6 step 4
  resolve authority from `(owner, client_id)` alone, so a client able to choose its own id
  would step straight into an already-consented binding — full impersonation of a
  consented client, through an unauthenticated endpoint, with no consent screen anywhere
  in the path. Verified as a **blocking probe observation**, not assumed: a registration
  body carrying `client_id` must come back with a different one.
- **Redirect URIs are matched as exact strings** against the set registered for that
  client: no wildcard, no prefix or suffix match, no path-relative match, no
  port-agnostic or scheme-agnostic comparison for `https` URIs, and no normalization
  beyond what registration itself stored. Pinned here rather than left to the provider
  because §19.5 step 4 ends with **the hub** redirecting the owner's browser to the URI
  the provider hands back: an unauthenticated registration endpoint plus a redirect target
  nobody validated is an open redirector carrying an authorization code, which is the
  classic way an authorization server gives its codes away. So: the hub never redirects a
  browser to a URI the provider did not validate, a mismatch is refused **before the
  consent screen renders** (there is nothing to consent to yet), and the provider's
  enforcement of exact matching is the third **blocking probe observation** — if it
  matches loosely for any shape, the hub validates before redirecting rather than
  shipping on trust. RFC 8252 loopback redirects, where port-agnostic matching is the
  *correct* behavior, are out of scope with Claude Code itself (§19.9); nothing in v1
  registers one, so no exception to exact matching exists.
- `enforcePerClientResources: false`. The alternative links each client to each
  namespace's resource at registration time — before the owner has consented, and
  through a table that would hold a second, weaker copy of the rule the door already
  enforces (`aud` must equal this endpoint's canonical URL, and the binding names the
  namespace). One rule, enforced where the traffic is.
- One `oauthResource` row per user, identifier `https://<origin>/<user>/mcp` — the same
  string the PRM names as `resource` and the door checks as `aud`, so the row, the
  document and the audience are one value with one spelling. Written by the same
  `/internal/users` path that creates the user (§12), removed by the same path that
  deletes one alongside §15's teardown, and **back-filled for pre-existing users by
  `0005` itself** — in the migration, not by a lazy first-request write. Both directions
  are pinned because their failure modes are silent and asymmetric: a missing row at
  provisioning means a *brand-new* user can never complete an authorization, and a
  missing back-fill means the *existing* owner — the one person this whole section was
  built for — cannot. Whether the provider strictly needs the row when
  `enforcePerClientResources` is false is the plan's open question 1; the row is written
  either way, because an unnecessary row costs one INSERT and a missing necessary one
  costs the entire flow.

### 19.4 Data model

Migration `0005_oauth.sql`, generated the way §4 already requires — `@better-auth/cli
generate` against a local SQLite dialect with the identical plugin list, emitted SQL
checked in unchanged. The 0001 postmortem (three hand-transcription deltas found at
runtime) is the argument: better-auth is a dependency now, so nothing here is
transcribed by hand. The generated half brings the provider's seven tables —
`oauthClient`, `oauthResource`, `oauthClientResource`, `oauthAccessToken`,
`oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion` — plus `jwks` from the jwt
plugin. Authorization codes and DPoP replay reservations reuse better-auth's existing
`verification` table; nothing else is added to what §5 already has.

The hub's own table is written by hand in the same migration, in this repo's snake_case
convention, and is the only one pinned in `migrations.test.ts`'s `SCHEMA_TABLES` (as
with `user` and `session`, better-auth's camelCase tables stay outside it):

```sql
CREATE TABLE oauth_binding (            -- §19: one OAuth client ↔ one service account
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,             -- oauthClient.clientId; no FK (better-auth owns
                                       -- that table, and §5 already takes this posture
                                       -- for token.ref_id)
  service_account_id TEXT NOT NULL REFERENCES service_account(id) ON DELETE CASCADE,
                                       -- deleting the account revokes the connection by
                                       -- construction: the door reads this row per call
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                -- coarse, same TOKEN_LAST_USED_STAMP_MS window as
                                       -- token.last_used_at (§5) — the same staleness
                                       -- signal, for the same reason
  revoked_at INTEGER,
  UNIQUE (owner_id, client_id)         -- one binding per client per namespace; re-consent
                                       -- with a different account UPDATEs it (audit row
                                       -- `oauth.rebound`) instead of accumulating rows
);
```

### 19.5 The consent screen

The provider owns the state machine and ships no pages; the hub owns every pixel.
`loginPage: "/login"` and `consentPage: "/oauth/consent"` are required options.

1. `/api/auth/oauth2/authorize` with no session → 302 to `/login?<signed query>`. §13's
   login page carries that query through and, on success, redirects back to `authorize`
   with it verbatim — the provider then re-runs the request, now with a session. **The
   post-login target is a constant**: the hub's own `/api/auth/oauth2/authorize`, built in
   code, with the signed query appended as the only thing taken from the request. The
   login page never reads a destination out of the query — no `next=`, no `return_to=`, no
   "carry through whatever URL was there". "Carries the query through" means exactly the
   opaque signed blob and nothing else. This is spelled out because the sentence invites
   the other reading, and a login page that immediately precedes an authorization grant is
   the highest-value phishing target the hub has: a generic post-login redirect parameter
   there is how it gets lost.
2. With a session and no covering consent → 302 to `/oauth/consent?<signed query>`. The
   query is the whole authorization request re-serialized plus `exp`, an issued-at, and
   an HMAC `sig` over the canonicalized parameters. **The page must echo it back
   byte-for-byte**; it cannot invent, drop or edit a parameter, which is exactly the
   property that keeps the screen from being a place where authority is widened. That
   signature is an asserted behavior of a package this repo has not installed yet, and the
   entire unforgeability argument rests on it, so it joins §19.1's verify API and §19.3's
   two client rules as a **blocking probe observation**: watch `authorize` actually sign
   the query, `public-client-prelogin` actually accept it, and `/oauth2/consent` actually
   take `{accept, oauth_query}` — before a line of the consent page is written against
   them.
3. The page (cookie session required, `requireOwnerSession`) is the whole security
   boundary of §19 (§18 decision 24), and every string it shows about the client came out
   of a body anyone could POST to an unauthenticated registration endpoint. It therefore
   shows, always:
   - the client's **name**, read from the provider's `public-client-prelogin` endpoint
     (which accepts the same signed query) — rendered as untrusted text, never as markup,
     never as a live link;
   - the **origin of the `redirect_uri`** the authorization code would be sent to. This is
     the one attacker-controlled string that actually decides where the authority lands,
     and the only one a human can check against "the thing I am trying to connect";
   - for a self-registered (DCR) client, an explicit **"registered itself — identity
     unverified"** marker beside the name. The hub vouches for nothing here, and the
     screen must not let a familiar-looking name read as a verified one;
   - the requested scopes, and the **namespace** the token will be audience-bound to;
   - a **service-account picker**: a `<select>` over `account_list`, defaulted to nothing,
     beside the plain sentence that the client will be able to do exactly what that
     account can. This is the lazy binding decision made explicit — the account is chosen
     at the moment the owner is already looking at the request, so no separate
     provisioning step exists.

   **Empty state, pinned**: a namespace with zero service accounts is the first-run path,
   not an edge case — the owner this section exists for may never have created one. With
   no accounts, the picker renders an empty state naming `/services` as the place to
   create one, the submit control is **disabled**, and consent is simply impossible until
   an account exists; Deny still works. There is deliberately no inline create and no
   implicit "default" account: an authority-granting screen is the wrong place to mint the
   thing that will hold the authority.
4. The POST goes to `/oauth/consent` (the hub's own route, through §13's `mutation`
   gate: session → form → CSRF → body — the same discipline as `/services`, not a
   weaker one, because this POST both writes a binding and authorizes a client). The
   handler **verifies before it writes**: it first calls the provider's
   `/oauth2/consent` endpoint with `{ accept, oauth_query }` carrying the session —
   which is where the signature over `oauth_query` is enforced — and only on the
   provider's success does it upsert `oauth_binding`, write `oauth.consented` (or
   `oauth.rebound`), and redirect the browser to the `redirect_uri` the provider
   returned. A provider refusal writes nothing: no binding, no audit row, no code —
   otherwise every failed call would strand an `oauth_binding` for an authorization
   that never completed, and the §19.8 row "an edited `oauth_query` is refused and
   writes no binding" could not hold. Deny posts `accept: false` and the client
   receives `access_denied`.

CSRF posture, stated once: the hub's own CSRF token gates the POST; the provider's
signed `oauth_query` is what makes the *request being consented to* unforgeable; and
because the POST carries a cookie it is additionally subject to better-auth's origin
check, which the hub's own origin satisfies by default. Cookie-less machine POSTs from
a connector to `/oauth2/token` and `/oauth2/register` bypass that check by design and
need no `trustedOrigins` entry.

### 19.6 The token, end to end

1. claude.ai discovers the PRM from the 401 (or by probing), reads the AS document, and
   registers or reuses a client. Its one redirect URI is
   `https://claude.ai/api/mcp/auth_callback`.
2. It sends the RFC 8707 `resource` parameter — `https://<origin>/<user>/mcp`, canonical
   form, path included — on **both** the authorization and token requests. That
   parameter is what makes the issued access token a **signed JWT** rather than an
   opaque string, with `aud` = the resource. A client that omits it silently receives an
   opaque token instead; the hub cannot validate one in-worker (validation needs an API
   reachable only from inside a provider endpoint), so an opaque token is refused at the
   door with the ordinary challenge. MCP clients are spec-required to send `resource`,
   and this is the failure mode to look for first when a client cannot connect.
3. **At the door** (§7 step 1, `identity.resolveCredential`'s prefix dispatch — the same
   function that resolves `pmcp_sa_` keys, gaining one leg, so `resolvePrincipal` and
   everything past it are unchanged). Four rules, each an authorization boundary rather
   than an implementation note:

   **The predicate.** A bearer carrying neither `pmcp_` prefix is **JWT-shaped** when it
   is exactly three `.`-separated segments, each non-empty and each drawn from the
   base64url alphabet `[A-Za-z0-9_-]`. Nothing looser — not "contains a dot", not "decodes
   to JSON". This predicate selects between two credential regimes, so it is pinned at the
   byte level; a fuzzy version of it is a way to route a credential into the wrong one.

   **The leg is terminal.** A JWT-shaped bearer is answered by the OAuth leg **alone**.
   Every failure in it — malformed, bad signature, wrong issuer, wrong audience, expired,
   missing `mcp` scope, wrong token type, no binding row, revoked binding, deleted account
   — is a **401**, and none of them falls through to the better-auth session lookup. Same
   hard rule the `pmcp_` prefixes carry, sharper reason: better-auth resolves some of its
   own signed tokens to a *session*, and a session resolves to the **owner**, so a
   fall-through would silently promote "this token's binding was revoked" to "this token
   is the owner" — the exact inversion §18 decision 23 exists to forbid. Fail closed,
   always.

   **Hub-signed is not sufficient.** The leg verifies, against the hub's own JWKS:
   signature; `iss` = the hub issuer; `exp`; the `mcp` scope; **and that the token is an
   access token minted by this authorization server for this namespace** — the `aud` rule
   below, plus the provider's own access-token claims. `jwt()` also mounts
   `/api/auth/token` (§19.2), which turns a live *cookie session* into a JWT that is
   correctly signed, correctly issued, and carries none of the rest. §19.7's allowlist
   means no bearer can reach that endpoint; the claim checks here mean it would not matter
   if one could. "Signed by our JWKS" is never the acceptance test, and a design that
   makes it one has handed every browser session an MCP credential.

   **Audience is namespace-wide.** `aud` must equal the namespace's canonical **aggregated**
   URL, `https://<origin>/<user>/mcp` — one identifier per namespace, the same string as
   the `oauthResource` row and the PRM's `resource` (§19.3). The door accepts that audience
   on the aggregated shape **and** on `/<user>/mcp/<slug>` within the same namespace;
   grants then filter per slug exactly as they do for a `pmcp_sa_` key, so the scoped
   endpoint refuses what the account may not reach and **404s** what it holds no grant on
   — `/<user>/mcp/pmcp` included, which refuses like it refuses a key (§8), not as a
   resolution failure. The alternative, an audience per addressed URL, was rejected because
   it makes an OAuth token strictly *weaker* than the key it is supposed to be
   indistinguishable from, and turns §16's "indistinguishable from a `pmcp_sa_` key" into
   a false sentence on every scoped URL. A token whose `aud` names a **different**
   namespace is not "a resolved principal on a foreign namespace" (§7's 404 rule) but no
   principal at all: the same 401 challenge as no token, learning nothing about whether
   that namespace exists.
4. The verified `azp`/`client_id` plus the addressed owner resolve `oauth_binding`. No
   row, or `revoked_at` set, or the account gone → the same 401 challenge, which is also
   the actionable answer: the owner can re-consent. A live row yields a
   `service_account` principal — the identical shape `pmcp_sa_` produces — and stamps
   `last_used_at` under the same coarse window.
5. Everything downstream is §7 unchanged: grants, `-32001`/`-32002`/`-32003`, approvals,
   `hub/principal: "sa:<slug>"`, `hub/roles`, and audit rows under principal
   `sa:<slug>`. Nothing in the pipeline branches on how the credential arrived.

Lifetimes: access tokens keep the provider's ordinary hour, refresh tokens 30 days with
rotation. The usual objection to a JWT — that the fast path never re-checks revocation —
does not apply here, because step 4 reads the binding row on every call. That read is
the same one-per-request D1 cost a `pmcp_sa_` key already pays — plus, depending on
which verify path the probe selects, at most one more for the signing key (§19.1) — and
it buys immediate
revocation: **the connection is revoked when the binding says so**, mid-session, without
waiting for `exp`. Revoking additionally deletes the provider's `oauthConsent` row, so
the client's next attempt walks the consent screen again rather than refreshing
silently.

### 19.7 Interaction with D11's credential-family gate

D11 landed a gate over `Authorization`-bearing requests to the `/api/auth` mount, so a
stolen CLI session token cannot enroll a second factor or revoke sessions (plan:
`docs/superpowers/plans/2026-08-26-d11-remediation.md`; the shape below is that plan's
PSD follow-up, which **inverted** the original deny-list). §19 mounts a whole plugin
bundle under the same prefix — including one endpoint, `/api/auth/token`, that must never
see a bearer. The invariant §19 relies on, and the one a test must pin in both directions:

> The gate is a fail-closed **allowlist**, not a rule about the mount and not a list of
> forbidden paths: under `/api/auth`, an `Authorization` header is admitted at
> **`/sign-out` and `/device/*`, and nowhere else**. Every other path on that mount —
> named, unnamed, or added tomorrow by a plugin nobody re-audited — refuses a
> bearer-carrying request.

Three consequences, stated rather than assumed:

- **`/api/auth/token` is out of reach by construction.** `jwt()` mounts it as a side
  effect and it converts a live session into a hub-signed JWT (§19.2). Under a deny-list
  it would have had to be *remembered* — precisely the class of mistake an allowlist makes
  structurally impossible. This is why §19 can adopt a plugin bundle without first
  auditing its whole route surface for credential-shaped endpoints, and it is the single
  most load-bearing thing D11 bought this section.
- **No §19 endpoint needs an allowlist entry**, because every client the hub supports is a
  **public** client: anonymous DCR forbids confidential registration, both Claude surfaces
  register with `token_endpoint_auth_method: "none"`, and PKCE S256 is required of
  everyone (§19.3). So `/oauth2/token` and `/oauth2/register` are reached by cookie-less,
  `Authorization`-less POSTs, and `/oauth2/introspect` is never called at all (§19.9). An
  `Authorization` header arriving at any of them is refused, and that refusal is correct
  rather than a gap: the day a confidential client is genuinely wanted, adding one
  allowlist entry is a deliberate reviewed edit, which is the entire point of the shape.
- **The door does not depend on any of this.** §19.6 step 3 refuses a hub-signed JWT that
  is not an access token for the addressed namespace, on its claims, whether or not one
  could ever have been minted. The allowlist is why `/api/auth/token` cannot be reached
  with a stolen CLI token; the claim checks are why it would not matter if it could. Two
  independent answers to one question, which is what a boundary this cheap should have.

The corollary is §18 decision 25 and §8's exception list: none of these endpoints, and
not `/oauth/consent`, ever appears on an MCP surface. The only MCP-reachable part of
§19 is `connection_list` / `connection_revoke` — grants-shaped ops on the caller's own
namespace, exactly what the `/oauth/connections` page fronts.

### 19.8 Failure modes

| Situation | Answer |
|---|---|
| No token, malformed token, expired token | 401 + challenge naming the per-user `resource_metadata`. Same bytes whether `<user>` exists or not. |
| Opaque token (client omitted `resource`) | Same 401 + challenge — the hub validates JWTs only, and says so here rather than pretending otherwise. |
| Token whose `aud` names another namespace | Same 401 + challenge. Audience is a resolution failure, not a namespace judgment, so no 404 and no existence signal about the namespace it was minted for or the one it was presented to. |
| Token whose `aud` names *this* namespace, addressed to `/<user>/mcp/<slug>` | **Accepted** — the audience is namespace-wide (§19.6 step 3). The slug is then judged by grants alone, exactly as for a `pmcp_sa_` key: `-32001` / `-32002` / 404 per §7, never an audience refusal. |
| Token whose `aud` is a *scoped* URL (`…/mcp/<slug>`) rather than the namespace's canonical aggregated URL | Same 401 + challenge, on both endpoint shapes. Namespace-wide means exactly one string; nothing issues that audience, so presenting it means the token came from somewhere else. |
| A hub-signed JWT that is not an access token — e.g. one minted from a cookie session at `/api/auth/token` | Same 401 + challenge. Correct signature and issuer are not the acceptance test (§19.6 step 3). |
| Any failure at all in the OAuth leg | 401. The leg is terminal — no failure falls through to a session lookup, so no failure can resolve as the owner (§19.6 step 3). |
| Unknown client (no binding row) | Same 401 + challenge; re-consent is the fix, and only the owner's browser session can perform it. |
| Binding revoked mid-session | The next call refuses with the same challenge; in-flight calls are not interrupted. The provider's consent row is gone too, so a refresh cannot resurrect it. |
| Service account deleted | The FK cascade removes the binding: identical to revoked, with no cleanup step to forget. |
| Consent POST without a valid CSRF token, or with an edited `oauth_query` | Refused by §13's `mutation` gate and by the provider's signature check respectively — nothing is written and no code is issued. |

### 19.9 Explicitly out of scope

Recorded so a later reader knows these were seen, not missed. None blocks the claude.ai
or Claude Code flows:

- **Advertising a scoped endpoint as its own OAuth resource** — no PRM is served at
  `/.well-known/oauth-protected-resource/<user>/mcp/<slug>` and no per-service
  `oauthResource` row exists, so a client cannot *discover* a scoped mount or obtain a
  token audience-bound to one. It can still *use* one: the audience is namespace-wide
  (§19.6 step 3), so an issued token works on `/<user>/mcp/<slug>` under that namespace's
  grants, which is what keeps §16's "indistinguishable from a `pmcp_sa_` key" true. What
  is out of scope is only the discovery half — one more route and one more resource row
  per service, the day a connector wants to mount a single service directly.
- **CIMD** (`@better-auth/cimd`, MCP 2026-07-28 Client ID Metadata Documents) — its
  bundled fetch transport is Node-only and would need a Workers replacement with
  private-range validation. DCR covers both clients today.
- **DPoP** — supported by the provider and advertised; no client here asks for it and no
  resource demands it.
- **Introspection as a validation path** — the endpoint exists (the provider mounts it)
  but the hub never calls it: it demands client credentials, so the hub would have to
  register itself as a client and POST to itself per request.
- **Claude Code over OAuth** — best-effort. Its existing `Authorization: Bearer
  pmcp_sa_…` header keeps working untouched and stays the supported CLI route; a
  configured header wins over OAuth in Claude Code anyway. Two unverified behaviors sit
  behind this — whether its DCR body declares `application_type: "native"` alongside its
  `http://localhost:PORT/callback` redirect (the provider's `"web"` default would
  otherwise reject it), and whether it sends `resource` — and both are recorded as open
  questions in the plan rather than designed around.

## 20. The MCP data model beyond tools

*Added 2026-08-26. Reverses §18 decision 4 and revises decision 9; decisions 26–27 carry
the owner-level calls. Implemented as its own workflow, **after** §19.*

v1 proxied tools because tools were what agents used. Both Claude surfaces now consume
more: Claude Code turns a service's prompts into `/mcp__<server>__<prompt>` slash
commands and its resources into `@server:uri` mentions (auto-materializing list/read
tools for them), and hosted connectors list Tools, prompts, and resources as supported.
A tunneled service that already declares prompts **answers them over the socket today** —
the client libraries are transparent transports, and `ServiceConnection.forward` is
method-agnostic. The hub is the only thing saying `-32601`.

### 20.1 What is in, and what is deferred with its reason

| Family | Methods | Status |
|---|---|---|
| Prompts | `prompts/list`, `prompts/get` | **In.** Request/response on the existing envelope. |
| Resources | `resources/list`, `resources/read` | **In**, scoped endpoint only (§18 decision 26). |
| Resource templates | `resources/templates/list` | **In**, scoped endpoint only, same reason. |
| Completions | `completion/complete` | **In**, scoped endpoint only, and **filtered by its `ref`** like every other read (§20.2) — it is a relay, not a pass-through, because an unfiltered one is a read straight past the caller's patterns. Served for conformance; nothing observably consumes it, so it gets no CLI command. |
| MRTR (elicitation / sampling / roots) | `input_required` results on `prompts/get` and `resources/read` | **In.** It is a *result shape*, not a stream: the hub already relays an `input_required` leg verbatim for `tools/call`, and §7's `clientCapabilities` mirroring already tells the service what the consumer can answer. |
| `subscriptions/listen` | — | **Deferred.** In this revision it is the *only* delivery mechanism for server→client notifications, and its response IS a long-lived `text/event-stream`. The consumer surface is POST/JSON with no stream at all, and the service socket lives in a Durable Object whose seam to the worker is strictly request/response — piping a service notification into a consumer's open stream needs a new DO→worker push channel, and a permanently-open subscription inverts the DO's hibernation discipline ("an unresolved inbound request blocks hibernation"). |
| `notifications/*/list_changed` **to consumers**, `resources/updated` | — | **Deferred**, same reason: they are only deliverable on a listen stream. Consequence, pinned: every capability the hub declares keeps `listChanged: false` and `resources.subscribe` is never declared. Declaring one without serving `subscriptions/listen` would make a Claude Code v2 client open a listen stream, take `-32601`, and burn its reopen budget (3 reopens then a stop; 5 in an hour then a ~6 h wait) — degrading that consumer's freshness for the rest of the day. **Never declare a capability the transport cannot honor.** |
| `logging/*`, `notifications/message` | — | **Out.** Deprecated in 2026-07-28 itself, and per-request SSE would be needed to carry it. |
| Server-initiated JSON-RPC requests | — | **Impossible in this revision** — servers MUST NOT send them; MRTR replaced them. |

Freshness without notifications is carried by `ttlMs` (§20.5): the hub's own view stays
current because the DO still invalidates on a service's `list_changed`; only the
consumer's view lags by the TTL.

### 20.2 Routing at the door

§7's method table gains seven entries. Refusal vocabulary, filter-first ordering, and
the archived/availability checks are unchanged — a new family reuses the pipeline
rather than growing one.

**Aggregated `/<user>/mcp`** — tools and prompts only:

- `prompts/list` — every prompt the caller may use across the namespace, names prefixed
  `<slug>_<prompt>`, split at the first `_` by the same `splitAggregatedName` the tools
  path uses (slugs contain no `_`, §7). Same parallel fan-out, same 10 s per-upstream
  deadline, same `_meta["pmcp/unavailable"]`, same "the aggregate always succeeds" rule.
  Filtered by name, on the existing pure code — see the matching-key rules below, which is
  where the families stop being interchangeable.
- `prompts/get` — prefix split, then filter → archived → availability. **No approval
  gate** (§18 decision 27).
- `resources/*` and `completion/complete` → `-32601`, and the aggregated endpoint does
  not declare those capabilities. §18 decision 26 has the reasoning; the short form is
  that a URI cannot take a `<slug>_` prefix and still be the URI the service knows, and
  rewriting URIs would have to reach inside `resource_link` and embedded resource blocks
  in *tool* results too — ending "the response is relayed verbatim".

**Scoped `/<user>/mcp/<slug>`** — everything, unprefixed and unrewritten:
`prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`,
`resources/read`, `completion/complete`. This is the mount for a prompt- or
resource-heavy service, and the documentation should say so: an aggregated prompt
reaches Claude Code as `/mcp__<hubentry>__<slug>_<prompt>`, doubly prefixed, while the
scoped mount gives `/mcp__<service>__<prompt>`.

**A read is routed by the addressed slug, never by the URI it names.** §18 decision 26
resolves aggregation by not aggregating, which leaves one residual worth pinning: two
services may legitimately serve the same URI (`file:///notes.txt` is nobody's private
namespace). A caller granted that URI on service A reads it on **A's** scoped endpoint;
the identical URI on B's scoped endpoint is judged against the caller's grants *on B* and
refuses `-32001` when they do not cover it. The URI never selects the service — the URL
does. Routing by URI would be the confused-deputy shape this design has otherwise avoided
by construction.

**Capabilities.** `initialize` stays exactly what §7 pins it as — **Worker-answered,
stateless, and never a live upstream call**. Two static answers, one per endpoint shape:

- **Aggregated**: `tools` and `prompts`, both `listChanged: false`, unconditionally. An
  empty `prompts/list` is a legal answer, and a constant beats composing a union that
  could only ever tell a consumer to expect nothing. Because it is one fixed result,
  `contracts/initialize.json` keeps pinning it byte-for-byte: that fixture gains the
  `prompts` capability and stays a fixture.
- **Scoped**: derived from what the hub already **stores** for that service — the
  capability set learned at registration (§6's `server/discover`, cached in the DO) for
  tunneled services; for proxied services, an **owner-declared `capabilities` list** on
  the service's own config (§9's YAML and the `service_create`/`service_update` wire gain
  the optional key, values a subset of `tools`/`prompts`/`resources`/`completions`;
  absent means `tools` only, so every existing proxied service is unchanged). Declared
  configuration, not cache — §20.5's "proxied services cache nothing" stands — and the
  declaration gates only what the handshake *advertises*: routing stays grant-filtered
  either way, so a wrong declaration can mislead a client's feature detection but never
  widen access. All of it — with `listChanged`
  and `subscribe` forced false whatever the service claims, since the hub cannot honor
  them and must not republish them. **Never a live upstream call**: an earlier draft of
  this paragraph said "live for proxied", which would have put an unbounded round trip
  inside the handshake, with no deadline and no answer for a down upstream, in the one
  method §7 pins as stateless. A tunneled service that has **never connected** advertises
  `tools` only — the same answer it already gives, and consistent with the empty
  `tools/list` it serves from an empty catalog. A capability the hub has never been told
  about is not declared.

The union-or-intersection question the aggregated constant sidesteps has one answer worth
recording: intersection would let a single tools-only service suppress every other
service's prompts.

The **consumer→hub** `server/discover` (distinct from §6's hub→service method of the same
name) answers from those same two static pictures and changes in lockstep with this
paragraph. One source, two spellings: a divergence between what `initialize` and
`server/discover` advertise is a bug, not a degree of freedom.

**Access control.** Every family is filtered by the caller's grants before anything is
listed or forwarded, using the per-family pattern lists of §20.3. A service account with
no matching pattern in a family gets an empty list and `-32001` on a fetch —
indistinguishable from not-permitted, as everywhere else. Owners see everything. Three
rules the families do **not** share, each pinned because the obvious implementation gets
it wrong in a way nothing else catches:

- **Prompts are matched by `name`.** `registry.buildToolFilter`'s `filterList` is already
  generic over `{name}`, so prompt filtering needs no new pure code.
- **Resources are matched by `uri`, never by `name`.** An MCP resource carries both, and
  §20.3's patterns are URI patterns — so reusing the name-keyed `filterList` here would
  filter a URI keyspace with a display string, and a resource whose *name* happened to
  match a granted pattern would be listed and readable although its URI matches nothing
  the caller was granted. Resource **templates** are matched by their raw `uriTemplate`
  string under the same rule, and `resources/templates/list` is filtered with it before
  anything is returned. The family argument §20.3 adds to the filter therefore selects the
  **key** as well as the pattern list; a family-aware filter that still reads `.name` is
  the bug this sentence exists to prevent.
- **`completion/complete` is filtered by its `ref`.** The method's `ref` names a prompt
  (`ref/prompt` → matched by name against the caller's prompt patterns) or a resource
  template (`ref/resource` → matched by its template string against the resource
  patterns). A `ref` no pattern matches is `-32001`, refused before anything reaches the
  service. Unfiltered, this method is a read straight past the role's patterns: a caller
  with zero prompt and resource grants could enumerate whatever the service completes —
  document titles, ids, user handles — which is exactly the data the patterns exist to
  confine. **Audit posture, decided rather than inherited:** it stays listing-class
  (§20.4, no row), like `prompts/list`. The refusal is what makes it safe; a row would be
  polling noise from a method a client calls on every keystroke.

**Identity and MRTR.** Forwarded requests in every family carry the same `_meta` §7
pins — `hub/principal`, `hub/roles`, the consumer's mirrored
`io.modelcontextprotocol/clientCapabilities` — with the same `hub/*` strip-then-set
hygiene. An `input_required` result relays back verbatim and the consumer's retry is an
ordinary request re-entering the pipeline; `requestState` stays opaque to the hub, never
inspected and never rewritten.

### 20.3 Roles: one language, three keyspaces

A role's declaration gains a family dimension (§18 decision 9). Wire shape, in
`hub/register`, in `contracts/tunnel-frames.json`, in the YAML, and in both libraries'
`serve({roles})`:

```jsonc
"roles": {
  "reader":  ["get_news", "search_.*"],              // bare list = tools. Unchanged, forever.
  "curator": { "tools":     ["publish"],             // per-family object; every key optional
               "prompts":   ["digest_.*"],
               "resources": ["news://feed/*"] }
}
```

- **Backward compatibility is total.** A bare list is normalized to
  `{ tools: [...] }` — so every service in the field, every YAML file, and every
  `serve({roles})` call keeps its exact current meaning, and a role that grants tools
  grants *nothing* in another family. The two spellings may be mixed across roles in one
  declaration. Normalization happens once, in the hub (`registry.validateRoles` and the
  filter builder); neither client library gains a rule that could disagree with it.
- **Storage**: `service.roles_json` holds the normalized per-family object. Existing rows
  hold bare lists and are read as tools-only, so no data migration exists.
- **Read shape**, pinned in one canonical wire form, because storage being normalized does
  not by itself say what a *read* returns. `service_list` / `service_get`, the YAML the
  planner diffs against, and anything the CLI prints all render the **canonical** form: a
  bare list when the role is tools-only, the per-family object otherwise. Both directions
  are pinned, and that is the point. Always rendering the object would make every YAML
  file written before this change diff against the server on the first `pmcp diff` after
  it lands; rendering whichever spelling happened to register would make the read shape a
  function of history, so `pmcp diff` would be stable or noisy by accident. One canonical
  form keeps an older CLI typed `Record<string, string[]>` correct for every tools-only
  service — which is every service in the field today — and makes the diff a function of
  meaning rather than of spelling.
- **Validation** (§6, applied identically to proxied virtual roles, §8): role names and
  the reserved `all` are unchanged; an unknown family key is a violation; every pattern
  must compile; `ROLE_PATTERN_MAX_LENGTH` bounds each pattern and `ROLE_PATTERNS_MAX`
  bounds **each family list** — the same two `limits.ts` constants, applied three times,
  so no new magic number enters the system.
- **The built-in `all` role** spans every family, present and future: it contributes
  `.*` in each without appearing in any declaration. Owners keep `["all"]`.
- **Pattern grammar**: the anchored-regex language of §7, with the per-family literal
  fast path §18 decision 9 pins — tool and prompt patterns are literal when they are
  tool-name characters only, resource patterns are literal when they carry no regex
  metacharacter (`* + ? ( ) [ ] { } | ^ $ \`). `.` stays literal in both, `*` still
  aliases `.*` in both, so `news://feed/*` means what its author thinks it means and
  `file:///notes.txt` does not match `file:///notesXtxt`.
  The metacharacter test is applied to the **pattern**, never to the subject — which is
  what makes resource *templates* answerable. `{` and `}` in a `uriTemplate`
  (`news://feed/{id}`) are ordinary characters of the string being matched: a pattern with
  no metacharacter is compared to that template byte-for-byte, and a pattern carrying one
  compiles and matches it as a regex, so `news://feed/*` covers `news://feed/{id}` because
  `*` aliases `.*`. A **template-shaped pattern** (`news://feed/{id}`) is by that same
  test *not* literal — `{` and `}` are metacharacters, so it **compiles** — and it still
  matches exactly its own template, because an unquantified brace sequence like `{id}` is
  a literal in the flagless regex grammar §7 pins (a `u`-flagged engine would refuse the
  very same pattern as a syntax error, which is one more place the no-flags rule is
  load-bearing, not stylistic). The
  hub never expands a template, never enumerates the concrete URIs it could produce, and
  never matches a template against a pattern's expansion. Without this rule the oracle
  "templates are filtered by the caller's resource patterns" is not assertable, because
  `{` and `}` are in the metacharacter set and every reader would guess differently.
- **Redaction keys stay family-blind.** §7's `redact:` / `redact_results:` maps are keyed
  by tool-or-pattern and now also match prompt names. Over-masking is safe (§7 says so
  for composition branches already), and the alternative — a second map per family —
  doubles the config surface to buy nothing. Prompts have no JSON Schema and therefore no
  `writeOnly` half, and that is not a cosmetic difference — it decides a default. §15's
  `log_bodies` is **on** for tunneled services *because* our libraries declare secrets in
  both schema directions; prompts have neither direction, so the reason does not reach
  them. **Prompt-argument bodies therefore take the proxied posture regardless of the
  service's kind or transport**: a `prompts/get` row records `params.arguments` only when
  `log_bodies` is on **and** the service's `redact` map has an entry matching that prompt
  name — the owner having written that entry is the declaration that stands in for the
  missing schema. With no entry, the arguments are simply not recorded; the row, its
  outcome, timing, principal and prompt name still are. Anything else gives this family
  the strong default and none of the protection that earned it. (Prompt *results* were
  never at issue: they are message content blocks, and §15 stubs those — §20.4.)

### 20.4 Audit and hygiene per family

- **Recorded** (§15): `prompts/get` and `resources/read` write an audit row like a call —
  `event` carries the method, `tool` carries the prompt name or the resource URI (both
  columns are generic `TEXT` with no CHECK, so no migration; the URI is query-redacted and
  capped first — see below), with `duration_ms`, outcome, and the caller's client
  metadata.
- **Not recorded**: `prompts/list`, `resources/list`, `resources/templates/list`,
  `completion/complete` — listings, by §15's existing "`tools/list` is agent polling
  noise" rule.
- **Bodies** ride the same `log_bodies` gate and the same envelope: structured data
  post-redaction, unstructured content as typed size stubs. Nothing new is needed for
  prompt messages or resource contents *because* they are content blocks, and §15
  already stubs those — "the resource returned a 4 MB png" is visible without the bytes.
  Prompt **arguments** are the one place a §15 default does not carry over: §20.3 puts
  them on the proxied posture, because a prompt has no schema to declare secrets in.
- **A resource URI is not a body, and is not recorded verbatim either.** It is the row's
  `tool` column, and this is the one place §20 *tightens* a §15 rule rather than
  inheriting it. Before the URI enters `audit.tool`, its **query component is dropped and
  replaced by the literal `?…`**, and the result is capped at **1 KiB**. URIs carry
  credentials in their query strings as a matter of routine (`?access_token=`, `?sig=`,
  `?key=`) and §15's scrubbing grammar knows only the hub's *own* `pmcp_(sa|svc)_` shape —
  so a verbatim URI is a documented way to write somebody else's bearer token into a
  column that any admin-token agent can read back through `audit_query` for the whole
  retention window, against §15's "token material never, in any column". The cap is there
  for the reason every body column has one: the value is caller-supplied and otherwise
  unbounded, and while 128 chars (client metadata) is too short for a real URI, 1 KiB is
  past every legitimate one. What an owner actually reads the row for — scheme, host and
  path — survives intact.
- **No approvals** (§18 decision 27), hence no new refusal code and no new column on
  `approval`.
- **The other new hygiene rule** (the URI rule above is the first): `resources/read` is the first relayed result the
  spec lets a service mark `cacheScope: "public"`, and a public result from an
  authenticated endpoint may be shared across access tokens. The hub's authorization
  context is per-token, so **the hub downgrades `public` to `private` on every result it
  relays**, in every family. One line in the serving path, and the only place where
  verbatim relay is actually unsafe.

### 20.5 Caching

The DO's catalog discipline (§6) extends unchanged to three more durable keys —
`catalog:prompts`, `catalog:resources`, `catalog:resourceTemplates` — alongside the
capability set learned at registration. Whole-write, whole-read, "a warm that draws
nothing leaves the previous cache in place", "absent means never-warmed, so re-warm;
stored `[]` is a genuinely empty set", wiped on delete. Invalidated by the matching
`notifications/prompts|resources/list_changed` frame, which the DO now routes instead of
dropping.

One rule is genuinely new, and it inverts that conservatism in exactly one case because
the reason for the conservatism does not hold there: **a successful registration whose
declared capability set omits a family clears that family's cache.** "Leave the previous
cache in place" exists to survive a *failed* warm — a transient error must never empty a
catalog — and it still does: a warm that errors or times out changes nothing, and neither
does a `server/discover` leg that fails (§6 then warms tools only, and touches no other
key). But an omission in a *successful* discover answer is not a failure; it is the
service saying it no longer serves that family. Without the clear, a service that drops
prompts serves its stale prompt catalog forever and every `prompts/get` against it becomes
a `-32000` against a list the hub is still publishing. Undeclare clears; failure does not.
The two are distinguishable precisely because the discover leg either answered or did
not.

`resources/read` results are **never** cached: per-caller, potentially large, and the
method can answer `input_required`. Proxied services cache nothing at all, as today —
their scoped handshake advertises the owner-declared `capabilities` config (§20.2),
which is configuration read per request, not a cache.

Consumer cache hints follow §7: `resultType: "complete"`, a `ttlMs`, and `cacheScope`
always `private` — a listing is grant-filtered, so a shared cache would serve one
account's view to another. A result carrying `inputResponses`/`requestState` is never
given a `ttlMs` at all.

**Known ceilings, recorded rather than solved**: the hub returns whole lists and never
emits `nextCursor` (pagination is optional for servers), so a *paginating* service is
silently truncated to its first page — which is already true for `tools/list` today and
matters more for resource lists; the hub mints its own TTL constant rather than composing
`min(service ttlMs)` across a fan-out; and a **`resource_link` inside a tool result is
dead on the aggregated endpoint**. §18 decision 26 relays such a block verbatim (rewriting
it is the thing that decision refuses), but `resources/read` answers `-32601` there, so the
link names a URI the consumer cannot fetch from the endpoint it is talking to. The scoped
mount is where a resource-linking service belongs, and §20.2 already says to document that;
this is the residue when an author does not.

### 20.6 Surfaces

- **CLI** (§10): `pmcp prompts <service>` (`prompts/list`), `pmcp prompt <service>
  <name> [key=value …]` (`prompts/get`), `pmcp resources <service> [--templates]`
  (`resources/list` / `resources/templates/list`), `pmcp read <service> <uri>`
  (`resources/read`). All four are gateway sugar of the kind `tools`/`call` already are —
  they front an MCP method, not an admin op, so §8's parity list is untouched.
- **Client libraries** (§11): no new API beyond the widened `roles` shape. The bridge is
  transparent, so a service that declares prompts or resources with its own SDK serves
  them through the hub with no library change; the libraries pass the declaration through
  and let the hub validate it.
- **The `pmcp` builtin**: tools only. Its scoped endpoint answers empty prompt and
  resource lists and declares neither capability.
