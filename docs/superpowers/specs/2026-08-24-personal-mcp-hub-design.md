# personal-mcps — Design Spec

Date: 2026-08-24
Status: draft, for review

## 1. Overview

A personal MCP hub. Services (small programs, written like telegram bots) dial **out** to a
central server with a persistent WebSocket and expose an MCP server through it. The hub
proxies inbound MCP clients (Claude, other agents, the CLI) to those services, enforcing
per-service-account role grants. Each user owns their own namespace — services, service
accounts, grants, YAML file — managed via a CLI and served under `/<user>/mcp…` URLs.

Components:

| Component | What it is |
|---|---|
| **server** | Cloudflare Worker + Durable Objects. Terminates auth, owns the registry, proxies MCP traffic. |
| **clients** (py + js) | Libraries a service author uses: write a normal MCP server, hand it to the lib, it maintains the reverse connection. |
| **cli** (`pmcp`) | Login via device flow, invoke MCP tools, diff/apply the YAML config. |
| **admin MCP** | The hub's own management (services, accounts, grants, tokens) exposed as a built-in MCP service named `hub`. |

Non-goals (v1): cross-namespace sharing between users, resources/prompts proxying, MCP-native OAuth for
third-party clients, push notifications (`subscriptions/listen`), web dashboard.

## 2. Concepts

- **User** — a human, owner of a namespace. Every user is the admin *of their own
  namespace* (services, service accounts, grants); there is no cross-namespace access.
  Created by a repo script; password + optional TOTP second factor and/or passkey.
  Usernames are `[a-z0-9-]`, minus a reserved list (`login`, `device`, `account`, `api`,
  `connect`, `internal`, `mcp`, …) since they become top-level URL segments.
- **Service** — a registered MCP service (the "bot"). Identified by `(owner, slug)` —
  slugs are `[a-z0-9-]` (no underscore; §7 relies on this), unique per owner. Has at
  most one live connection. Declares its **roles** at connect time.
- **Role** — named subset of a service's tools, declared by the service itself in code:
  `{"reader": ["get_news", "search_*"], "admin": ["*"]}`. Patterns are glob-style over
  tool names.
- **Service account** — an identity for an AI agent or system (`claude`, `cron`). Holds
  **grants**.
- **Grant** — (service account, service, role). A service account may call exactly the
  tools matched by the union of its granted roles per service.
- **Token** — bearer credential. Three kinds:
  - *user token*: better-auth session token obtained by the CLI via device flow → admin access.
  - *service-account token*: long-lived API key bound to a service account → limited by grants.
  - *service token*: long-lived API key bound to a service → only valid for opening the
    reverse WebSocket as that service.

## 3. Architecture

```
 ┌──────────┐  MCP Streamable HTTP                         ┌─────────────────────────────┐
 │ MCP      │  POST /<user>/mcp          (aggregated)      │  Worker                     │
 │ clients  │  POST /<user>/mcp/<service> (scoped)         │  - better-auth (D1)         │
 │          │ ───────────────────────────────────────────▶ │  - authz: grants → allowed  │
 └──────────┘   Bearer: user token | service-account key   │    tool patterns            │
 ┌──────────┐  POST /<user>/mcp/hub (admin MCP)            │  - hub service (built-in)   │
 │ pmcp CLI │ ───────────────────────────────────────────▶ │                             │
 └──────────┘                                              └──────────────┬──────────────┘
                                                            fetch(allowed, jsonrpc)
                                                           ┌──────────────▼──────────────┐
 ┌──────────┐    wss://host/connect                        │  ServiceConnection DO       │
 │ service  │ ────────────────────────────────────────────▶│  (one per <user>/<service>, │
 │ (bot)    │    Bearer: service token                     │   SQLite-backed, hibernating│
 └──────────┘    JSON-RPC frames, hub acts as MCP client   │   WebSocket)                │
```

- The Worker is the single trust boundary: it authenticates every consumer request,
  resolves grants from D1, and forwards the request plus the resolved *allowed-tools
  filter* to the service's Durable Object.
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
  rest, plaintext shown once. (`@better-auth/api-key` was considered and rejected: its
  keys can only reference users/organizations, not our service rows, and its
  session-minting behavior is an escalation footgun. A small hashed-token table is
  simpler and safer; better-auth handles humans only.)
- **Schema migrations**: generated SQL checked in as `wrangler d1 migrations` files
  (better-auth CLI generate + our own tables); applied with `wrangler d1 migrations apply`.
  No runtime migration endpoint.
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
  roles_json TEXT NOT NULL DEFAULT '{}',  -- {"reader": ["get_news","search_*"], ...}, updated at registration
  created_at INTEGER NOT NULL,
  last_connected_at INTEGER,
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
  PRIMARY KEY (service_account_id, service_id, role)
);

CREATE TABLE token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service_account', 'service')),
  ref_id TEXT NOT NULL,                  -- service_account.id or service.id per kind
  name TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL UNIQUE,             -- SHA-256 of the full token string
  prefix TEXT NOT NULL,                  -- first ~12 chars, for display in listings
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
```

(`ref_id` can't be a foreign key to two tables; `service_delete` / `account_delete`
delete matching token rows as a server-side side effect, and verification additionally
rejects tokens whose referenced row no longer exists — see §8.)

The DO keeps per-service volatile/cached state in its own SQLite: cached `tools/list`
result, connection metadata. Identity/auth facts for the socket ride in
`serializeAttachment` (≤16 KB).

## 6. Reverse connection protocol (service ↔ hub)

Transport: WebSocket to `wss://<host>/connect`, `Authorization: Bearer pmcp_svc_…`.
The Worker verifies the service token, resolves the service (and its owner), and hands
the socket to `ServiceConnection` DO `getByName("<username>/<slug>")`, which calls
`ctx.acceptWebSocket(ws, ["<username>/<slug>"])`.

Framing: **one JSON-RPC 2.0 message per WebSocket text message** (WS already provides
message framing; each side generates UUID-string ids for the requests it initiates).
Two message namespaces:

1. **Control** — JSON-RPC methods prefixed `hub/`, handled by the client library, never
   reaching the user's MCP server:
   - `hub/register` (client → hub, first message):
     `{ "clientVersion": "...", "protocolVersion": "2026-07-28", "roles": { "<role>": ["<glob>", …] } }`
     The service identity comes **exclusively** from the authenticated token — the
     payload carries no service field, so a token for one slug can never touch another
     service's registration. The hub verifies the service row still exists (close `4003`
     if not), upserts `roles_json` in D1, replies `{ "ok": true }`, then immediately
     issues `tools/list` to warm its cache. A `roles` value of `{}` means "no roles
     declared" — only admin tokens can call the service.
   - `hub/replaced` (hub → client, notification): a newer connection for the same slug
     arrived; the old socket is closed with code `4000` after this. Client must NOT
     reconnect automatically in this case (two copies of a bot fighting for the slot is an
     operator error worth surfacing).
2. **MCP** — everything else. The hub acts as the MCP *client*; the service is the MCP
   *server*. v1 forwards: `tools/list`, `tools/call`. The client library also sends
   `notifications/tools/list_changed` when the user's server changes its tool set; the DO
   invalidates its cache and re-lists.

Handshake, pinned: the wire is stateless 2026-07-28-style — **`initialize` never crosses
the wire**. Hub-originated requests are self-contained (required `_meta` protocol-version
fields included); the client library performs whatever session bootstrap its local SDK
needs (synthesizing an initialize exchange internally if the SDK requires one). After
`hub/register` → `{ok: true}`, the first MCP message from the hub is `tools/list`.

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

## 7. Consumer-facing proxy

Two shapes, one pipeline — both stateless 2026-07-28 MCP endpoints (via
`createMcpHandler`, user and service resolved from the URL):

- `POST /<user>/mcp` — **aggregated**: every tool the caller may use across `<user>`'s
  services, tool names prefixed `<slug>_<tool>`. Slugs contain no `_`, so the first `_`
  splits the name unambiguously. The built-in `hub` service is *excluded* from
  aggregation (admin tools would pollute agent tool lists).
- `POST /<user>/mcp/<slug>` — **scoped** to one service, unprefixed tool names. This is
  also how `hub` is reached (`/<user>/mcp/hub`).

Per request:

1. Authenticate the Bearer token: `pmcp_sa_` prefix → SHA-256 lookup in `token` (must be
   unrevoked, unexpired, and its `ref_id` must still resolve to a live service account) →
   service account; otherwise better-auth session lookup → user. `pmcp_svc_` tokens are
   rejected here. The resolved principal must belong to the `<user>` namespace in the
   URL — a session or service-account of any other user gets 404 (not 403; namespaces
   don't leak existence).
2. Resolve the allowed-tool filter (per service):
   - owner → `["*"]` (sees everything in their namespace);
   - service account → its grant rows for the service, where a stored role of `*`
     expands **at request time** to every role currently in the service's `roles_json`;
     the filter is the union of those roles' glob patterns. Scoped endpoint with no
     grants → 403 (with a JSON-RPC-shaped body per spec); aggregated endpoint simply
     spans the services with at least one grant.
3. Dispatch:
   - `server/discover` → answered by the Worker (hub capabilities).
   - `tools/list` → served from the DO's **cached** list (kept in DO SQLite, so it
     survives disconnects — deploy-induced reconnect flapping doesn't churn agent tool
     lists), filtered by the allowed patterns; aggregated adds the slug prefix and
     fans out over the relevant DOs. `ttlMs`/`cacheScope` hints set so clients can
     cache. A service that has never connected lists no tools.
   - `tools/call` → (aggregated: split off the slug prefix first) name must match the
     filter, else JSON-RPC error `-32001` ("tool not permitted"). Otherwise forwarded
     through the DO to the live connection; response relayed back verbatim. Service not
     connected → `-32000` ("service offline").
   - anything else → `-32601`.

The hub terminates auth entirely; client tokens are never forwarded to services
(MCP audience-binding rules forbid pass-through anyway).

## 8. Admin MCP (`hub` service)

Built into the Worker at `POST /<user>/mcp/hub` — same proxy pipeline, but tools are
implemented locally instead of forwarded to a DO, and every tool operates on the
namespace of the `<user>` in the URL (which step 1 already proved is the caller's own).
Tools (names final, shapes reviewed at implementation time):

- `service_list` / `service_get` — includes declared roles, connection status, last seen.
- `service_create` / `service_delete` — delete also deletes the service's `token` rows,
  tells its DO to close any live socket (code `4001`) and drop cached state.
- `account_list` / `account_create` / `account_delete` — delete also deletes the
  account's `token` rows.
- `grant_set` — replaces the full grant set for (account, service).
- `token_issue` — `{ kind: "service_account" | "service", slug, expires_in? }` → plaintext
  key (shown once).
- `token_list` / `token_revoke` — revoking a `service` token also closes that service's
  live socket (code `4001`) if the connection was opened with it.

The `hub` slug is **reserved and virtual**: no `service` row exists for it.
`service_list` includes it flagged `builtin: true`; `service_create`, `service_delete`,
and `grant_set` reject the slug. Access is therefore admin (user) tokens only in v1 —
service accounts can't hold hub grants. Turning `hub` into a grantable service later is
a config change, not a design change.

The CLI performs every admin operation by calling these tools — the CLI has no private
admin API. (`diff`/`apply` are CLI-side compositions of `*_list` reads and `*_create` /
`*_delete` / `grant_set` writes.)

## 9. YAML config, diff, apply

One file per user, default `mcps.yaml`, authoritative for the logged-in user's
namespace: services, service accounts, and grants. Users and tokens are deliberately
imperative (secrets and humans don't belong in a declarative file).

```yaml
services:
  news:
    name: News MCP
    description: RSS digester on the home server
  home:
    name: Home automation

service_accounts:
  claude:
    name: Claude
    grants:
      news: [reader]        # exact role names, validated against the service's declared roles
      home: ["*"]           # the literal '*' (no other patterns): stored verbatim, expanded
                            # at request time to every declared role, present and future
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
```

- `pmcp diff -f mcps.yaml` — reads server state via `hub` tools, prints a create/update/
  delete plan. Full desired state: deletes include services/accounts present on the
  server but absent from the file, **and** grants for any (account, service) pair not
  listed under that account's `grants:` block. Grants referencing roles the service
  hasn't declared are applied but flagged with a warning (services declare roles at
  connect time, so the file can legitimately be ahead of the first connection); `*` is
  exempt from that warning. The reserved `hub` slug is excluded from the delete
  computation and rejected if it appears in the file.
- `pmcp apply -f mcps.yaml` — shows the same diff, asks for confirmation (`--yes` to
  skip), applies. Deleting a service or account cascades its grants and deletes its
  tokens (server-side side effect of the `*_delete` tools, §8).

## 10. CLI (`pmcp`)

TypeScript, ships in the monorepo, run via `npx pmcp` or installed globally.

```
pmcp login [--url https://mcp.example.com]   # RFC 8628 device flow; prints code + URL
pmcp logout | whoami
pmcp ls                                       # services + online/offline + roles
pmcp tools <service>                          # tools/list as seen with current token
pmcp call <service> <tool> [--json '{…}' | key=value …]
pmcp diff  -f mcps.yaml
pmcp apply -f mcps.yaml [--yes]
pmcp token issue (--account <slug> | --service <slug>) [--expires 90d]
pmcp token list | revoke <id>
```

All service and account references resolve within the logged-in user's namespace (the
CLI learns the username from `whoami` and builds `/<user>/mcp/…` URLs itself).

Config: `~/.config/pmcp/config.json` (server URL + session token). `PMCP_TOKEN` env var
overrides the stored token (any token kind — with a service-account key, `ls`/`tools`/
`call` work within grants and admin commands fail with 403). `PMCP_URL` overrides the
URL and is always the **https origin** — everywhere, including the client libraries,
which derive `wss://<origin>/connect` from it.

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
    roles={"reader": ["get_news", "search_*"]},
)
```

JS (`@personal-mcps/client` on npm): identical shape — `serve(server, { url, token, roles })`.

Library responsibilities: dial + authenticate, `hub/register`, bridge WS frames to the
SDK's server session (custom transport), send `notifications/tools/list_changed` on tool
mutations, protocol pings, reconnect with backoff, stop on `hub/replaced`.

## 12. User management script

`scripts/users.ts` (run with `pnpm users …`), talking to `POST /internal/users` on the
Worker, guarded by a `BOOTSTRAP_SECRET` wrangler secret (constant-time compare; route
returns 404 without it). No email involved anywhere.

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
- `/device` — better-auth's device-approval page (user enters the code the CLI printed).
- `/account` — enroll/remove TOTP and passkeys, active sessions.

No dashboard; the CLI and admin MCP are the management UI.

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

## 15. Error handling and operational behavior

- Every proxied request: 30 s hard timeout → JSON-RPC error to the caller; pending map
  rejected on socket close.
- Hub deploys terminate all WebSockets: services reconnect (backoff), consumers retry.
  Treat every `tools/call` as at-most-once.
- Duplicate service connection: newest wins, oldest gets `hub/replaced` + close 4000.
- Offline service: `-32000` immediately, no queueing. (Queue-and-retry is a later
  feature if it ever hurts.)
- Token revocation: consumer tokens are checked on every request, so revocation is
  immediate there. A revoked *service* token (or a deleted service) additionally severs
  the live reverse connection — the Worker tells the DO to close the socket with code
  `4001` (§8); a racing re-register fails because the service row / token is gone.
- Rate limiting: per-key limits are available in the api-key plugin config; off in v1.

## 16. Testing

- **server**: vitest + `@cloudflare/vitest-pool-workers`. Core integration test: fake
  service connects over WS to the DO, consumer POSTs `tools/list`/`tools/call` through
  both the aggregated and scoped endpoints, asserts role filtering, prefix routing,
  namespace isolation (cross-user 404), offline errors, timeout behavior, connection
  replacement.
- **clients/py**: pytest; the WS↔anyio bridge tested against an in-process websocket
  server; reconnect/backoff logic unit-tested with a fake clock.
- **clients/js**: vitest; same shape.
- **cli**: unit tests for YAML diff (pure function: desired + current → plan).
- One `scripts/e2e.md` runbook (manual): deploy to a dev worker, run the example service,
  `pmcp call` round-trip.

## 17. Repo layout

```
personal-mcps/
  server/            # CF Worker: auth, proxy, hub MCP, ServiceConnection DO, migrations/
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
3. **Roles live in service code**, declared at registration; the YAML only references
   them. The alternative (roles defined centrally in YAML) was rejected because only the
   service knows its tools.
4. **v1 proxies tools only** — no resources, prompts, or push notification streams.
5. **Usernames, not emails**, with synthesized placeholder emails internally.
6. **`apply` deletes by default** (after showing the diff and confirming) — the YAML is
   desired state, not additive patches.
7. Naming: repo `personal-mcps`, CLI/binary `pmcp`, packages `@personal-mcps/*` /
   `pmcp-client`.
8. **Service/service-account tokens are our own hashed-token table**, not the
   `@better-auth/api-key` plugin — the plugin can only bind keys to users/organizations
   and can mint sessions from keys, which would bypass the grants model (§4).
