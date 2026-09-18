## 3. Architecture

```
 ┌──────────┐  POST /<user>/mcp or /mcp/hub              ┌─────────────────────────────┐
 │ MCP      │  hub execute/search + type resources       │ Worker trust boundary       │
 │ client   │ ──────────────────────────────────────────▶│ auth · catalog · dispatch   │
 └──────────┘  exact bearer → token-scoped Sandbox       └───────────┬─────────────────┘
                                                                    │ explicit mapped RPC
                                                       ┌────────────▼────────────────┐
                                                       │ HubSandbox DO + container   │
                                                       │ pinned Deno, no Internet    │
                                                       └────────────┬────────────────┘
                                                                    │ reauthorized operation
 ┌──────────┐  POST /<user>/mcp/<app>                   ┌────────────▼────────────────┐
 │ MCP      │ ─────────────────────────────────────────▶│ shared scoped dispatch      │
 │ clients  │  direct unprefixed app surface            │ grant · archive · approval  │
 └──────────┘                                           │ availability · audit        │
                                                       └──────┬───────────────┬──────┘
                                                              │               │
                                                ┌─────────────▼──┐      ┌─────▼──────────┐
                                                │ AppConnection │      │ proxied MCP    │
                                                │ DO + tunnel   │      │ upstream       │
                                                └────────────────┘      └────────────────┘
```

- The Worker is the single authorization boundary. Every direct scoped request and every
  operation initiated by a program crosses the same current-grant, archive, availability,
  approval, metadata-hygiene, redaction, backend, and audit seams.
- `AppConnection` owns the hibernatable app and subscriber sockets plus cached tunneled
  catalogs. Proxied upstreams still use no app DO.
- `HubSandbox` is a separate exact-bearer-scoped DO/container boundary. It holds only
  ephemeral execution generations; D1 owns durable execution settings and TypeScript
  reservations. Untrusted code receives neither the bearer nor a generic Worker binding.
- Apps always dial **in**. The program bridge reaches the Worker only through the fixed
  `mcp.internal` container proxy and explicit mapped call/read RPCs (§23).

