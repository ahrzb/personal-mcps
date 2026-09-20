## 3. Architecture

```
 ┌──────────┐  POST /<user>/mcp or /mcp/hub              ┌─────────────────────────────┐
 │ MCP      │  hub execute/search + type resources       │ Worker trust boundary       │
 │ client   │ ──────────────────────────────────────────▶│ auth · catalog · dispatch   │
 └──────────┘                                            └───────────┬─────────────────┘
                                                                    │ explicit host calls
                                                       ┌────────────▼────────────────┐
                                                       │ fresh QuickJS/Wasm runtime  │
                                                       │ no host globals or modules  │
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
- A fresh QuickJS runtime and context isolate every execution inside the Worker. D1 owns
  durable execution settings and TypeScript reservations. Untrusted code receives neither
  the bearer nor a generic Worker binding, filesystem, network, module loader, or host
  global.
- Host callables close over canonical snapshot identities and enter the same scoped
  dispatch functions as direct traffic (§23).

