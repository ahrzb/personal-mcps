## 11. Client libraries

The app author writes a plain MCP server with the official SDK; our library owns the
connection. Roles are part of the app's code because the app is what knows its
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
    token=...,                        # or PMCP_APP_TOKEN
    roles={"reader": ["get_news", "search_.*"]},
    # Optional hub-local hints; canonical MCP names remain unchanged:
    typescript_aliases={"service": "news", "tools": {"get-news": "getNews"}},
)
```

JS (`@personal-mcps/client` on npm) has the same shape:
`serve(server, { url, token, roles, typescriptAliases })`. Python spells the option
`typescript_aliases` at its public API and emits wire `typescriptAliases`.

Go carries the same semantics in
`pmcp.Options{URL, Token, Roles, TypeScriptAliases}`. Rust uses
`pmcp::Options { url, token, roles, typescript_aliases }`. All four
transports copy the optional `{service, tools}` shape into `hub/register`; they
validate no alias policy locally, because the hub must be the single
syntax/collision authority. SDK hints rank below owner configuration and a
collision does not disconnect the tunnel.

Library responsibilities remain dial/authenticate, `hub/register`, answer
`server/discover`, bridge frames, pass notifications, ping, reconnect/backoff,
and stop on `hub/replaced`. Alias hints change only the registration control
object. Python/JS continue answering discover in transport; Go and Rust use their
official SDKs. A boundary that cannot answer discover returns `-32601`, preserving
the tools-only warm fallback.


The packages also expose two in-handler affordances (§7): caller identity —
principal, roles, and a role predicate read from forwarded `_meta` — and
sensitive-field marking. Python exposes `Secret[T]` plus `sensitive()`, JS
exposes `secret()` plus `sensitive()`, Go exposes `Secret()` plus `Sensitive()`
over `jsonschema.Schema`, and Rust exposes `secret()` plus `sensitive()` over
`schemars::Schema`. Every spelling emits `writeOnly: true` at the marked input
or output path; values still serialize normally on the wire, and the hub performs
masking (§7, §15).

