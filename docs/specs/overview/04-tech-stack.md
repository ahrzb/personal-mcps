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

