## 14. Alternatives considered

- **Tunnels per app (cloudflared/ngrok) + plain remote MCP servers** — no unified
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
- **D1 for per-app state** — network hop on every DO wake for no benefit; DO SQLite
  is colocated and priced identically. D1 kept only for the shared control plane.
- **OAuth to upstream servers** — originally deferred, now in scope as `auth: oauth`
  proxied apps (§7): the interactive connect flow was the missing piece for real
  upstreams like Linear, and the hub already had the encrypted credential store and
  browser surface it needs. Static headers remain the default for upstreams that take
  a token.

