## 3. Architecture

```
 ┌──────────┐  MCP Streamable HTTP                         ┌─────────────────────────────┐
 │ MCP      │  POST /<user>/mcp          (aggregated)      │  Worker                     │
 │ clients  │  POST /<user>/mcp/<app> (scoped)             │  - better-auth (D1)         │
 │          │ ───────────────────────────────────────────▶ │  - authz: grants → allowed  │
 └──────────┘   Bearer: user token | agent key             │    tool patterns            │
 ┌──────────┐  POST /<user>/mcp/pmcp (admin MCP)           │  - pmcp app (built-in)      │
 │ pmcp CLI │ ───────────────────────────────────────────▶ │                             │
 └──────────┘                                              └──────────────┬──────────────┘
                                                            fetch(allowed, jsonrpc)
                                                           ┌──────────────▼──────────────┐
 ┌──────────┐    wss://host/connect                        │  AppConnection DO           │
 │ tunneled │ ────────────────────────────────────────────▶│  (one per <user>/<app>,     │
 │ app      │    Bearer: app token                         │   SQLite-backed, hibernating│
 └──────────┘    JSON-RPC frames, hub acts as MCP client   │   WebSocket)                │
                                                           └─────────────────────────────┘
 ┌──────────┐    Streamable HTTP (hub as MCP client,       ┌─────────────────────────────┐
 │ upstream │ ◀────────────────────────────────────────────│  Worker (proxied kind:      │
 │ MCP      │    stored upstream auth header)              │  forwards directly, no DO)  │
 └──────────┘                                              └─────────────────────────────┘
```

- The Worker is the single trust boundary: it authenticates every consumer request,
  resolves grants from D1, and forwards the request plus the resolved *allowed-tools
  filter* to the app's Durable Object (tunneled) or straight to the upstream
  endpoint as an MCP client (proxied — no DO involved).
- The DO owns the live WebSocket (hibernatable), a cached tool list, and pending
  request correlation. It never validates tokens itself for consumer traffic — it trusts
  the Worker.
- Apps always dial **in**; the DO never opens outbound sockets (outbound sockets
  block hibernation and wreck the cost model).

