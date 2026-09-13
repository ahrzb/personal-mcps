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
    # per-family form, §20 (added 2026-08-26) — a bare list still means tools:
    # roles={"reader": {"tools": ["get_news"], "prompts": ["digest_.*"],
    #                   "resources": ["news://feed/*"]}},
)
```

JS (`@personal-mcps/client` on npm): identical shape — `serve(server, { url, token, roles })`,
with the same two spellings (`Roles = Record<string, string[] | { tools?: string[];
prompts?: string[]; resources?: string[] }>`).

Go (`github.com/ahrzb/personal-mcps/clients/go`): the same semantics through
`pmcp.Serve(ctx, server, pmcp.Options{URL, Token, Roles})`; `pmcp.Patterns` is the
bare tools list and `pmcp.Families` is the per-family form. All three libraries
pass the declaration through verbatim: normalization and validation are the
hub's (§6), so no library gains a rule that could disagree with it.

Library responsibilities: dial + authenticate, `hub/register`, answer the hub's
`server/discover`, bridge WS frames to the SDK's server session, pass through
list-changed/resource-updated notifications, protocol pings, reconnect with
backoff (403 at upgrade / close `4002` = archived → keep retrying at max
backoff, §6), and stop on `hub/replaced`. Python and JS answer
`server/discover` inside their transport because their SDK adapters predate the
method. The Go transport restricts the protocol to `2026-07-28` and lets the
official Go SDK ≥ 1.7 answer it from the server's real registered capabilities;
the observable wire contract is identical. A client boundary that cannot
answer sends `-32601`, the hub's “capabilities unknown” signal, and the hub
falls back to warming tools only (§6).

The packages also expose two in-handler affordances (§7): caller identity —
principal, roles, and a role predicate read from forwarded `_meta` — and
sensitive-field marking. Python exposes `Secret[T]` plus `sensitive()`, JS
exposes `secret()` plus `sensitive()`, and Go exposes `Secret()` plus
`Sensitive()` over `jsonschema.Schema`. Every spelling emits `writeOnly: true`
at the marked input or output path; values still serialize normally on the
wire, and the hub performs masking (§7, §15).

