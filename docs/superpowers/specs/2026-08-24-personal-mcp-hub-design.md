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
| **web pages** | Server-rendered pages (Hono JSX, §13): `/login`, `/device`, `/account`, plus `/services`, `/approvals`, `/audit` — fronts over the same handlers as the `pmcp` tools, no web-only capability (except `/account`, §13). |

Non-goals (v1): cross-namespace sharing between users, resources/prompts proxying, MCP-native OAuth for
third-party clients, push notifications (`subscriptions/listen`), any web UI beyond the
server-rendered pages of §13 (no SPA).

## 2. Concepts

- **User** — a human, owner of a namespace. Every user is the admin *of their own
  namespace* (services, service accounts, grants); there is no cross-namespace access.
  Created by a repo script; password + optional TOTP second factor and/or passkey.
  Usernames are `[a-z0-9-]`, minus a reserved list, since they become top-level URL
  segments: every top-level route segment the Worker serves is reserved — currently
  `login`, `device`, `account`, `audit`, `approvals`, `services`, `oauth`, `api`,
  `connect`, `internal`, plus `mcp`. Adding a top-level route extends this set; the
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
- **Role** — named subset of a service's tools. Declared in code at registration for
  tunneled services (`{"reader": ["get_news", "search_.*"]}`), in the YAML / admin tools
  for proxied ones. Patterns are **anchored regexes** over tool names (a pattern made
  only of tool-name characters `[A-Za-z0-9._-]` is matched as a literal tool name — §7
  pins the rule; anything else compiles as a regex, and `*` is accepted as an alias for
  `.*`). Every service additionally
  has the built-in wildcard role **`*`** matching all tools, present and future, with no
  declaration needed — for both kinds. Trust boundary, stated plainly: roles confine
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
    (not the full `@better-auth/oauth-provider` stack; see §14).
  - `bearer()` — lets the CLI present its session token as `Authorization: Bearer`.
- **Service-account and service tokens**: our own `token` table (§5), not a better-auth
  plugin. 256-bit random secrets with `pmcp_sa_` / `pmcp_svc_` prefixes, SHA-256 hashed at
  rest, plaintext shown once. Unsalted SHA-256 is deliberate and correct for 256-bit
  random secrets (GitHub PATs and Vault tokens do the same): preimage attacks are
  infeasible, salting adds nothing, and slow KDFs are for low-entropy human secrets —
  do not "fix" this into bcrypt. (`@better-auth/api-key` was considered and rejected:
  its keys can only reference users/organizations, not our service rows, and its
  session-minting behavior is an escalation footgun. A small hashed-token table is
  simpler and safer; better-auth handles humans only.)
- **Session-scope guards**: credential-management and password-change endpoints
  (`/account`, change-password) require a cookie-authenticated web session with recent
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
`deviceCode`.

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
  role TEXT NOT NULL,                    -- exact role name, or the literal '*' (§9)
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
                                         -- post-redaction (§7): the ONLY place the hub
                                         -- ever persists tool arguments
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
  name TEXT NOT NULL DEFAULT '',
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
  detail TEXT                          -- small JSON summary; NEVER tool arguments,
                                       -- results, or token material
);
CREATE INDEX audit_owner_ts ON audit(owner_id, ts);
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
     The service identity comes **exclusively** from the authenticated token — the
     payload carries no service field, so a token for one slug can never touch another
     service's registration. The hub validates the declaration before accepting it:
     role names must match `[a-z0-9_-]{1,64}` (`*` is rejected — it's the resolver's
     built-in), every pattern must compile as a regex, and pattern length (≤128 chars)
     and per-role pattern count (≤64) are capped; violations get a JSON-RPC error reply
     and the socket is closed. The hub verifies the service row still exists (close
     `4003` if not), upserts `roles_json` in D1 and checks for **role drift**: for each
     role name, the old and new pattern lists are compared as sets of exact pattern
     strings, with a role absent from either side treated as the empty set. Any role
     that holds ≥1 live grant and whose new set is not a subset of its old set — i.e.
     any pattern added or textually changed — writes a `connect.roles_widened` audit
     row listing the affected roles and their added/changed patterns. The comparison is
     textual only; the hub never attempts regex-language containment (rewriting
     `get_news` to `get_.*` is logged because the string changed, not because the hub
     reasons about the language). Self-declared roles mean a compromised bot can widen
     its own roles; the blast radius stays inside that service, but the drift must be
     visible, not silent. The hub then replies `{ "ok": true }` and immediately issues
     `tools/list` to warm its cache. A `roles` value of `{}` means "no roles declared" —
     the service is then reachable only by admin tokens or accounts granted the
     built-in `*` role.
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
   *server*. v1 forwards: `tools/list`, `tools/call`. The client library also sends
   `notifications/tools/list_changed` when the user's server changes its tool set; the DO
   invalidates its cache and re-lists.

Handshake, pinned: the wire is stateless 2026-07-28-style — **`initialize` never crosses
the wire**. Hub-originated requests are self-contained, carrying all required `_meta`
protocol fields: `io.modelcontextprotocol/protocolVersion`, and
`io.modelcontextprotocol/clientCapabilities` **mirrored from the consumer's request** —
the hub asserts the calling client's capabilities, not its own (a legacy-lane consumer
that sent none gets `{}`, which per MRTR rules means the service must not emit
elicitation/sampling inputRequests for that caller). The client library performs
whatever session bootstrap its local SDK needs (synthesizing an initialize exchange
internally if the SDK requires one). After `hub/register` → `{ok: true}`, the first MCP
message from the hub is `tools/list`.

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
   better-auth session lookup → user. Failure matrix: any request that doesn't resolve
   to a valid principal → **401** with a `WWW-Authenticate: Bearer` header, regardless
   of whether `<user>` exists (so unauthenticated probes can't enumerate usernames). A
   *resolved* principal on another user's namespace (or a nonexistent user) → **404**
   (namespaces don't leak existence).
2. Resolve the allowed-tool filter (per service):
   - owner → all tools (sees everything in their namespace);
   - service account → the union of anchored-regex patterns of its granted roles,
     resolved against the service's `roles_json` **at request time**; the built-in `*`
     role contributes `.*` without ever appearing in `roles_json`. A granted role no
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
   - anything else → `-32601`.

### Approval flow

When the caller's only path to a tool is through approval-mode grants (§2), the call
does not execute on its own:

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
   `-32000` instead; such a call could not execute anyway) — and reply with JSON-RPC
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
(elicited values are exactly the secrets `writeOnly` exists for; like results, they
pass through the hub verbatim). One approval covers the whole MRTR exchange: a
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
there is no hourly job. v1 never blocks the original request while waiting — blocking
until decision, plus push-notifying the owner, is explicitly future work.
`tools/list` shows approval-gated tools like any other (the agent must see them to
call them).

### Caller identity forwarding

Services can do their own fine-grained authorization on top of the hub's role gate —
useful when one tool serves several roles. Every forwarded `tools/call` carries the
caller's identity and resolved roles (proxied: only when enabled, below):

- **Tunneled**: `_meta` fields on the forwarded request —
  `hub/principal` (`"sa:claude"` or `"user:ahrzb"`) and `hub/roles` (the caller's
  granted role names on this service, exactly as granted — the built-in wildcard is
  forwarded literally as `"*"`, never expanded into declared role names; owners get
  `["*"]`). The client libraries surface these on the tool context (e.g.
  `ctx.principal`, `ctx.roles`, `ctx.has_role("editor")`); `has_role(x)` returns true
  when the list contains `x` or `"*"`, so owner and `*`-granted calls behave
  identically, and `*` can never collide with a real role name (§6 rejects it in
  declarations).
- **Proxied**: only when the service sets `forward_identity: true` (default **false**):
  real HTTP headers on the upstream request — `X-Pmcp-Principal` and `X-Pmcp-Roles`
  (comma-separated, same values — including a literal `*`) — so an upstream you also
  control can branch on them. Third-party upstreams (Notion, Linear) have no need for
  internal identifiers, so with the flag off no `X-Pmcp-*` headers are sent.

The `hub/` prefix in `_meta` is **reserved**: before forwarding, the hub deletes every
consumer-supplied `_meta` key beginning with `hub/` and then sets its own values —
overwrite, never merge — so any `hub/*` field a service sees was written by the hub,
never the caller. (Other consumer `_meta` keys, e.g. `progressToken`, pass through
untouched. The proxied analogue holds by construction: `X-Pmcp-*` headers are set on
the hub's own upstream request, which never copies consumer headers.)

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

Some tool arguments (passwords, tokens) must never be persisted — not even in the
approval record. Two declaration paths, unioned:

- **Schema-declared** (tunneled): any property marked with standard JSON Schema
  **`writeOnly: true`** (at any depth) in a tool's input schema is sensitive. The hub
  derives the map from the catalog cached in the service's DO at `tools/list` time;
  the client libraries offer sugar for marking a parameter sensitive, which just sets
  `writeOnly` on the emitted schema.
- **Config-declared** (both kinds): the owner lists redaction paths per tool —
  `redact: { "<tool-or-pattern>": ["password", "credentials.token"] }` in the YAML /
  `service_update`. This is the **only** path for proxied services in v1: their
  `tools/list` is forwarded live and never cached, so there is no schema to derive
  from (honoring upstream `writeOnly` becomes possible if a proxied schema cache is
  ever added).

Redacted fields are replaced with `"‹redacted›"` before anything is stored or shown:
the approval `args_json` (§5), any error message that echoes arguments, and any debug
surface. This extends §15's log-hygiene rule; the audit table remains argument-free
entirely.

The hub terminates auth entirely; client tokens are never forwarded to services
(MCP audience-binding rules forbid pass-through anyway).

## 8. Admin MCP (the built-in `pmcp` service)

Built into the Worker at `POST /<user>/mcp/pmcp` — same proxy pipeline, but tools are
implemented locally instead of forwarded to a DO, and every tool operates on the
namespace of the `<user>` in the URL (which step 1 already proved is the caller's own).
Tools (names final, shapes reviewed at implementation time):

- `service_list` / `service_get` — includes kind, declared roles, redact paths,
  archived status, and for proxied services the endpoint, the `auth` mode, and
  `forward_identity`; connection status and last seen apply to tunneled services only
  (proxied rows report `kind: proxy` in their place). diff/apply depend on kind,
  endpoint, auth, forward_identity, roles, redact, and archived all being readable
  here.
- `service_create` / `service_update` / `service_delete` — create takes `kind`,
  `redact` (sensitive-field paths, §7 — either kind) and, for proxied services,
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
  as `hub/register` (§6): name charset, no `*`, patterns must compile, caps. Delete
  also deletes the service's `token` rows, tells its DO to close any live socket (code
  `4001`) and drop cached state (DO side effects apply to tunneled services only —
  proxied services have no DO and no tokens).
- `service_set_upstream_auth` — proxied only: stores the headers (e.g. a bearer token)
  the hub sends upstream. Imperative and write-only, like `token_issue` — secrets never
  appear in YAML or in read tools.
- `service_archive` / `service_unarchive` — archive severs any live socket (close
  `4002`) and hides the service from consumers; everything is retained for unarchive
  (§6, "Service lifecycle").
- `account_list` / `account_create` / `account_delete` — delete also deletes the
  account's `token` rows.
- `grant_set` — replaces the full grant set for (account, service); each entry is a
  role name plus optional mode (`reader` or `reader:approval`, the same syntax as §9).
  Applies the same role validation as the YAML layer (§9): undeclared roles warn for
  tunneled services, hard-error for proxied ones; a role literally named `*` is never
  declarable, only grantable (it's the built-in).
- `approval_list` — `{ status?, limit? }` → approval requests, newest first (pending
  and history alike).
- `approval_decide` — `{ id, decision: "approve" | "reject" }`. The web approval page
  (§13) and `pmcp approve/reject` are both fronts for this.
- `token_issue` — `{ kind: "service_account" | "service", slug, expires_in? }` → plaintext
  key (shown once). `kind: "service"` is rejected for proxied services (nothing connects).
  Service-account tokens default to 90 d expiry (pass `expires_in` to override,
  including `never`) — these are the tokens pasted into agent configs; service tokens
  default to no expiry (revoke-on-compromise, the telegram-bot model).
- `token_list` / `token_revoke` — listings include `last_used_at`; revoking a `service`
  token also closes that service's live socket (code `4001`) if the connection was
  opened with it.

- `audit_query` — `{ principal?, service?, event?, since?, until?, limit? (default 100) }`
  → audit rows, newest first. Read-only; like everything else, `pmcp audit` is sugar
  over this tool.

Every tool that takes a service slug rejects `pmcp` with the same error (`grant_set`,
`service_*`, `token_issue` alike) — the reservation is uniform, not per-tool. Every
mutating `pmcp` tool writes an `admin.<tool>` audit row with a summary of the change
(never secrets — `token_issue` logs that a token was issued and for whom, not the key).

The `pmcp` slug is **reserved and virtual**: no `service` row exists for it.
`service_list` includes it flagged `builtin: true`. Access is admin (user) tokens only in v1 —
service accounts can't hold `pmcp` grants. Turning `pmcp` into a grantable service later
is a config change, not a design change.

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
`pmcp_svc_`-prefixed bearer → **401**, never a session lookup; anything else →
better-auth session lookup → `{ "principal": "user:<name>", "namespace": "<name>" }`;
no valid principal → **401** with `WWW-Authenticate: Bearer`. This response shape is
pinned — it is the CLI↔server contract §10 depends on.

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
    roles:                  # virtual roles — defined here because the upstream can't
      editor: ["create_page", "update_.*"]   # anchored regexes over tool names
      reader: ["search", "fetch_.*"]
    redact:                 # sensitive argument paths per tool (§7) — config-declared
      create_page: ["credentials.token"]     #   because upstream schemas rarely mark writeOnly
    # upstream auth is imperative (service_set_upstream_auth) — never in this file
  linear:
    kind: proxy
    endpoint: https://mcp.linear.app/mcp
    auth: oauth             # connected interactively from /services (§7); tokens never here
    roles:
      reader: ["list_.*", "get_.*"]
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
      home: ["*:approval"]  # ':approval' suffix = approval mode (§2) — role names have
                            # no colon, so the suffix is unambiguous; bare = allow
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
```

- `pmcp diff -f mcps.yaml` — reads server state via `pmcp` tools, prints a create/update/
  delete plan (including archive/unarchive transitions from the `archived` field).
  Full desired state: deletes include services/accounts present on the
  server but absent from the file, **and** grants for any (account, service) pair not
  listed under that account's `grants:` block. `redact` (either kind) and, for proxied
  services, `endpoint`, `auth`, `forward_identity`, and `roles` are part of the
  desired state and diffed like any other field (an `auth` flip is shown as
  destructive — it wipes stored upstream credentials, §8). Listing the same role name in both modes (`[reader,
  "reader:approval"]`) is rejected as a config error — in the YAML and in `grant_set`
  alike. Grants
  referencing roles a *tunneled* service hasn't declared are applied but flagged with a
  warning (tunneled roles arrive at connect time, so the file can legitimately be ahead
  of the first connection); `*` is exempt, and for proxied services undeclared roles are
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
pmcp diff  -f mcps.yaml
pmcp apply -f mcps.yaml [--yes]
pmcp token issue (--account <slug> | --service <slug>) [--expires 90d]
pmcp token list | revoke <id>
pmcp audit [--account <slug>] [--service <slug>] [--since 7d]
pmcp approvals [--pending | --history]
pmcp approve <id> | reject <id>
pmcp connect <service>                        # prints the /services OAuth connect URL (§7)
```

All service and account references resolve within the logged-in user's namespace (the
CLI learns the username from `whoami` and builds `/<user>/mcp/…` URLs itself).

Every subcommand except the auth family is presentation sugar: `ls`, `tools`, `token`,
`diff`, and `apply` are compositions of the same `pmcp_*` and MCP tool calls that
`pmcp call` (or any agent) can make directly — nicer output, zero extra capability.

Config: `~/.config/pmcp/config.json` (server URL + session token). `PMCP_TOKEN` env var
overrides the stored token — session or service-account tokens only (`pmcp_svc_` tokens
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
)
```

JS (`@personal-mcps/client` on npm): identical shape — `serve(server, { url, token, roles })`.

Library responsibilities: dial + authenticate, `hub/register`, bridge WS frames to the
SDK's server session (custom transport), send `notifications/tools/list_changed` on tool
mutations, protocol pings, reconnect with backoff (403 at upgrade / close `4002` =
archived → keep retrying at max backoff, §6), stop on `hub/replaced`. Plus two
in-handler affordances (§7): the caller identity — `ctx.principal`, `ctx.roles`,
`ctx.has_role("editor")`, read from the forwarded `_meta` — and sensitive-parameter
sugar (e.g. `sensitive=["password"]` on a tool) that marks the schema property
`writeOnly: true` so the hub redacts it.

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
  server-rendered table, newest first, with account/service/since filters and a
  "before" cursor for paging. Same query logic as `audit_query`; no mutations, so no
  CSRF surface.
- `/approvals` — cookie-session-gated: pending requests up top (account, service, tool,
  redacted arguments, requested time, approve/reject buttons — CSRF token on the POST),
  decision history below. `/approvals/<id>` is the detail page the `-32003` error links
  to; only the namespace owner can open it.
- `/services` — cookie-session-gated service management: active services (kind, status —
  online/offline for tunneled, connection state for OAuth-proxied — roles, last seen)
  with archive/delete actions; an archived section with unarchive/delete; an add-service
  flow (pick tunneled / proxied / proxied + OAuth; tunneled creation shows the service
  token once; OAuth creation continues into the provider's consent screen, §7); and
  Connect/Reconnect/Disconnect for `auth: oauth` services. CSRF tokens on every
  mutation. `/oauth/upstream/callback` belongs to this cookie-session-gated surface:
  it requires the owner's session and a live single-use `state` bound to it, per §7 —
  the callback is a mutation (it writes `upstream_auth_json`) and is guarded like one.

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
- **Full OAuth provider now** (`@better-auth/oauth-provider` + `@better-auth/mcp`) —
  ~6 extra tables, jwt plugin, consent pages; only needed when third-party MCP clients
  should OAuth in directly with RFC 9728 discovery. Deferred; the design slots it in
  later without rework (the device-flow plugin and login pages are the groundwork).
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
  redacted from logs, error responses, and exception traces; MCP bodies for the `pmcp`
  service (which carry issued tokens) are never logged; `writeOnly`/config-declared
  sensitive fields are masked before any storage or display (§7). Approval rows are the
  only persisted arguments, always post-redaction, pruned by the same daily cron as
  audit (90 days).
- Audit trail: the D1 `audit` table (§5) is the durable record — Workers Logs retention
  is only 3–7 days, so log lines are ops debugging, not audit. Recorded: every
  `tools/call` (allowed and denied), approval lifecycle transitions
  (`approval.requested/approved/rejected/expired`), every mutating `pmcp` admin tool,
  logins, device approvals, connect/register/replaced/roles_widened events, and bootstrap
  invocations. Not recorded: `tools/list` (agent polling noise), and the audit table
  never holds tool arguments/results or token material (approval rows are the sole
  persisted arguments anywhere in the hub, post-redaction, §7). Queried via
  `audit_query` / `pmcp audit`. A daily cron trigger prunes rows older than 90 days.
  The coarse `last_used_at` on tokens (§5) complements it for at-a-glance rotation
  checks.

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
  `writeOnly` and config-declared fields masked in the stored `args_json`; identity
  `_meta` present on tunneled calls with the consumer's `clientCapabilities` mirrored
  onto the forwarded request (both kinds, `{}` when absent); a consumer-supplied
  `_meta` key under `hub/` (e.g. a forged `hub/roles`) is stripped before forwarding
  while non-reserved keys like `progressToken` survive; `X-Pmcp-*` headers present
  only with `forward_identity: true` and absent by default.
- **upstream oauth**: fake AS in-test — expired access token triggers refresh before
  forwarding; failed refresh surfaces needs-reconnect and calls fail `-32000`; a
  callback carrying a valid code but a missing, consumed, expired, or other-session
  `state` is rejected and writes nothing.
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
   on their own.
2. **Namespaces are silos.** Each user fully controls their own namespace and can't see
   any other; there is no sharing, no global admin, no cross-namespace grants. Sharing a
   service between users would be a real design extension — out of scope until wanted.
3. **Tunneled services' roles live in service code**, declared at registration — the
   YAML only references them; central YAML definitions for tunneled roles were rejected
   because only the service knows its tools. Proxied services are the exception: their
   virtual roles are defined in config, because the upstream can't declare any.
4. **v1 proxies tools only** — no resources, prompts, or push notification streams.
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
10. **The wildcard role `*` is built-in on every service** (both kinds), matching all
    tools present and future; it never appears in `roles_json` and is resolved at
    request time.
11. **Proxied upstream auth is static headers (default) or interactive OAuth**
    (`auth: oauth`, §7) — connected from `/services`, tokens encrypted at rest (§5),
    never in YAML (which declares only the mode; the mode is stored in its own
    `upstream_auth_mode` column, distinct from the credential envelope, and flipping
    it wipes stored credentials, §8).
12. **Token expiry defaults differ by kind**: 90 d for service-account tokens (they get
    pasted into agent configs), none for service tokens (telegram-bot model, bots on
    home servers shouldn't silently die) — both overridable at issue time.
13. **No MCP-native OAuth discovery in v1** (already §14): spec-conformant clients that
    require RFC 9728 discovery must configure a bearer header manually. We do send
    `WWW-Authenticate` on 401 and never accept query-string tokens, so the upgrade path
    stays clean.
14. **Roles are not a boundary against the service itself** (§2): grants confine
    accounts; the service is trusted. Drift logging, not pinning, is the v1 answer.
15. **Approvals never block the original request** in v1 — the agent gets `-32003` +
    a link immediately, and an approval is a single-use, args-hash-bound pass consumed
    by an identical retry. Blocking-until-decided and push notifications are declared
    future work (§7). The retry-with-identical-args contract is the simplification to
    revisit if agents handle it poorly. An approval spans a full MRTR exchange —
    consumed on `resultType: "complete"` (or service error), not at first dispatch —
    and the args binding is `params.arguments` only, excluding
    `inputResponses`/`requestState` (§7).
16. **Sensitive fields are declared as JSON Schema `writeOnly`** (standard keyword, no
    invented syntax) for tunneled services, plus config-declared `redact` paths on
    either kind — config is the *only* proxied path in v1, since proxied schemas are
    never cached (§7). The approval `args_hash` binds post-redaction arguments only.
17. **Caller identity rides `_meta` (tunneled) / `X-Pmcp-*` headers (proxied)** —
    informational for the hub — never a boundary the hub itself relies on — but
    trustworthy for service-side fine-grained checks because the hub strips
    consumer-supplied `hub/*` `_meta` keys before injecting its own (§7). Proxied
    identity headers are opt-in per service (`forward_identity`, default off) — never
    sent to upstreams the owner hasn't marked.
18. **Forwarded requests assert the consumer's `clientCapabilities`**, mirrored per
    request — the hub never advertises input capabilities of its own; MRTR round-trips
    pass through as ordinary `tools/call` retries (§7).
