## 4. Tech stack (verified against current docs, 2026-08)

- **Runtime**: Cloudflare Workers, Hono for routing. D1 for the control plane,
  SQLite-backed Durable Objects (`new_sqlite_classes`) for per-app connection state.
- **MCP**: target spec revision **2026-07-28** (stateless, POST-only, no sessions
  *(amended 2026-09-01, §21: one exception each — `subscriptions/listen`'s response is a
  held `text/event-stream` served by a hub-owned route beside `createMcpHandler`, and
  the `Mcp-Session-Id` it mints is correlation only, never authentication and never
  server-side state on the POST path)*).
  Serve with `createMcpHandler` from `@modelcontextprotocol/server` v2 with a per-request
  factory building a **low-level `Server`** (`setRequestHandler('tools/list' | 'tools/call', …)`)
  — the SDK-endorsed gateway pattern. Its `legacy: 'stateless'` lane serves 2025-era
  clients for free. Do **not** use Cloudflare's `McpAgent` (deprecated, frozen on SDK v1).
  For proxied apps the Worker dials upstream with `Client` from
  `@modelcontextprotocol/client` (Streamable HTTP transport; it handles legacy-upstream
  handshakes itself).
- **Auth**: better-auth **≥ 1.7** with D1 as `database`. The hot read-only session path
  shares one instance per isolate; the public better-auth handler builds one per request,
  containing any stuck cookie-signing state to that request without paying the full
  `jwt()` + `oauthProvider()` construction cost on ordinary page and MCP traffic. Plugins:
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
- **Agent and app tokens**: our own `token` table (§5), not a better-auth
  plugin. 256-bit random secrets with `pmcp_agt_` / `pmcp_app_` prefixes, SHA-256 hashed at
  rest, plaintext shown once. Unsalted SHA-256 is deliberate and correct for 256-bit
  random secrets (GitHub PATs and Vault tokens do the same): preimage attacks are
  infeasible, salting adds nothing, and slow KDFs are for low-entropy human secrets —
  do not "fix" this into bcrypt. (`@better-auth/api-key` was considered and rejected:
  its keys can only reference users/organizations, not our app rows, and its
  session-minting behavior is an escalation footgun. A small hashed-token table is
  simpler and safer; better-auth handles humans only.)
- **Session-scope guards**: credential-management endpoints (`/settings` — TOTP and
  passkey enrollment/removal, session revocation, and *(amended 2026-09-02, decision
  30)* **changing** the password) require a
  cookie-authenticated web session with recent
  authentication — bearer-sourced (CLI) sessions are rejected there, so a stolen CLI
  token cannot enroll new credentials and become persistent account takeover. "Recent"
  is better-auth's own `session.freshAge` (default 24 h), read from its config so the hub
  never keeps a second window. *(2026-09-23, decision 38: with `/settings` in the client, the
  gate stands at two prefixes that are one rule — the `/settings/*` shell document and
  `/api/hub/settings/*`, every read and write the panes make — so the browser's only way to
  reach credential management is through the hub's recent-authentication check. better-auth's
  own mount still serves those endpoints to any cookie session without a freshness check
  (only `/list-sessions` and passkey *registration* read `freshAge`; §13's Password pane and
  its row pin that for `/change-password`), so the check guards the browser's path, not the
  mount.)* Session
  lifetime config is shared between web and CLI sessions (better-auth default 7 d
  sliding) — a conscious coupling; don't tune it up for CLI convenience without
  accepting the browser exposure.
- **Password change vs. password reset** *(added 2026-09-02, decision 30 — until then
  the bullet above read "there is no self-serve password change, the users script (§12)
  is the only password path": **reversed for the change half, kept for the reset
  half**)*. An owner who **knows** the current password changes it self-serve on
  `/settings` (§13's Password pane): core better-auth's `POST /change-password` —
  `{ currentPassword, newPassword, revokeOtherSessions? }`, verified in
  `better-auth@1.7.1`, no plugin — which requires the current password and which the hub
  gates as above. That gate is the only freshness check the change has: in 1.7.1 the
  endpoint sits behind `sensitiveSessionMiddleware`, which proves an authoritative
  session and nothing about its age (`freshSessionMiddleware` is the one that reads
  `freshAge`, and `/change-password` does not use it). An owner who has **forgotten** it
  is reset only by `pnpm users reset-password <username>` (§12) — structural, not an
  oversight: the `username()` plugin's synthesized email is delivered to nowhere, so no
  reset link can be sent, and no self-serve reset can exist without first putting a real
  address on file, a decision this spec has not taken (§18 decision 5). Pinned alongside:
  `emailAndPassword.minPasswordLength` is **12** (better-auth's default is 8; the pane's
  "At least 12 characters." renders from the configured number, never a second literal;
  the `maxPasswordLength` default of 128 stands — §12's generated passwords are random
  and unaffected); `revokeOtherSessions: true` deletes **every** session of the user —
  CLI device-flow sessions and the current browser session included — then mints a fresh
  session and sets its cookie on the response, so the hub's ~~translation~~ route
  *(2026-09-23, decision 38: `POST /api/hub/settings/change-password`, JSON in and out)* must
  forward that `Set-Cookie` and the CLI signs in again; and app and agent tokens are
  untouched by a change, because nothing derives them from the password (the `token`
  table above holds random secrets).
- **Schema migrations**: generated SQL checked in as `wrangler d1 migrations` files
  (better-auth CLI generate + our own tables); applied with `wrangler d1 migrations apply`.
  The better-auth CLI cannot run against the production config — D1 bindings exist only
  inside the Workers runtime, so `@better-auth/cli generate` fails with "Failed to
  initialize database adapter". Generation therefore uses a small CLI-only auth config
  with the identical plugin list (username, twoFactor, passkey, deviceAuthorization,
  bearer) pointed at a local SQLite Kysely dialect (e.g. better-sqlite3); better-auth
  targets the same SQLite dialect either way, so the emitted SQL is checked in
  unchanged as the wrangler migration. No runtime migration endpoint.
- **Clients**: Python — `mcp` package v2 (`MCPServer`, low-level
  `Server.run(read, write)` over an anyio/WebSocket bridge). JS —
  `@modelcontextprotocol/server` v2 with a `Transport` over `ws`. Go —
  `modelcontextprotocol/go-sdk` over `coder/websocket`. Rust — official `rmcp`
  over `tokio-tungstenite`. Each bridge is a small custom reverse-tunnel
  transport; the official SDK continues to own MCP dispatch and discovery.
- **Dependency policy** *(amended 2026-09-20, §23)*: the Worker runtime dependency
  boundary admits the existing authentication/MCP packages plus exact-pinned
  `typescript`, `@cfworker/json-schema`, `quickjs-emscripten-core`, and
  `@jitl/quickjs-wasmfile-release-sync`. TypeScript supplies the in-memory checker/emitter;
  the Worker-safe validator interprets per-tool schemas without dynamic code generation;
  the QuickJS packages supply the interpreter and Wasm artifact. No Sandbox SDK,
  container control package, schema renderer, ref resolver, or execution framework is
  admitted. §23's bounded renderer and host bridge remain in-repo. Two carve-outs remain,
  and each is a directory whose packages `server/src` never imports and which therefore
  never enter
  the Worker's dependency closure: `cli/` may declare its own commander, @clack/prompts,
  picocolors, wrap-ansi, and smol-toml; and `web/` may declare React,
  `@tanstack/react-query`, `@tanstack/react-router`, `@base-ui/react` with the
  shadcn-generated components' helpers, Vite, Tailwind, and screenshot tooling. The Worker
  serves `web/dist` through a static-asset binding and never imports it. Clients keep their
  own minimal declarations.
- **Monorepo**: pnpm workspaces with exactly three importers, `cli`, `web` and
  `clients/js` — the two published npm packages plus the browser client — plus a `uv`
  project (`clients/py`), a standalone Go module (`clients/go`), and a standalone
  Cargo crate (`clients/rust`); none of those three is npm. `server/` deliberately has
  **no manifest**: Wrangler builds it from the
  root, so one there would be a third declaration with no consumer. *(Amended
  2026-09-15: this line previously named `server` as a workspace package and
  omitted that none of the three directories were importers at all. Amended 2026-09-18:
  `web` became the third importer — unpublished, but a manifest of its own for the same
  reason the other two have one, since the root is where a mirrored declaration drifts.)*
- **Toolchain authority**: `flake.nix`'s devShell — Node 24, pnpm 10, Go 1.25,
  Rust, and `uv` — added 2026-09-15 (§22.7). It sits beside the documented
  `pnpm install`
  flow rather than replacing it, so contributors without Nix keep working, and
  where a manifest or document disagrees with the flake the flake is correct.
  Wrangler stays an npm dependency so it matches the lockfile: its version
  decides how the Worker runs, and two sources for that is one too many.

- **Untrusted TypeScript runtime** *(revised 2026-09-20, §23)*: the exact-pinned compiler
  checks each submitted function body against the caller-specific generated declaration
  and emits JavaScript before `quickjs-emscripten-core` evaluates it. Each execution gets
  a fresh memory- and stack-bounded runtime; interrupt checks enforce a deterministic CPU
  budget as well as the deadline and abort flag when the platform clock or signal
  advances. Tool arguments are interpreted against their application JSON Schemas before
  dispatch. MCP operations cross only explicit host functions that return guest promises.
  There is no Container, Deno, filesystem, network, module loader, or guest-visible Worker
  binding.

