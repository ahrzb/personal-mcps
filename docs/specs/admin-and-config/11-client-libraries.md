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
    # per-family form, §20 (added 2026-08-26) — a bare list still means tools:
    # roles={"reader": {"tools": ["get_news"], "prompts": ["digest_.*"],
    #                   "resources": ["news://feed/*"]}},
)
```

JS (`@personal-mcps/client` on npm): identical shape — `serve(server, { url, token, roles })`,
with the same two spellings (`Roles = Record<string, string[] | { tools?: string[];
prompts?: string[]; resources?: string[] }>`). Both libraries pass the declaration through
verbatim: normalization and validation are the hub's (§6), so neither library gains a
rule that could disagree with it.

Library responsibilities: dial + authenticate, `hub/register`, **answer the hub's
`server/discover`** *(added 2026-08-26, §20/§6: the library, not the author's SDK, owns
this answer — it is a hub↔library control question, no MCP SDK implements the method, and
the library is what knows which families the author actually registered. It is the one
MCP-namespace method the library handles itself instead of bridging through. A library
that does **not** implement it is not broken: the resulting `-32601` is the hub's
"capabilities unknown" signal and the hub falls back to warming tools only, §6 — which is
what keeps every service already in the field working unchanged)*, bridge WS frames to the
SDK's server session (custom transport), send `notifications/tools/list_changed` on tool
mutations *(and, from 2026-08-26, whichever of the prompts/resources list_changed
notifications the author's SDK emits — the bridge is transparent, so this is a
pass-through, not a feature the library implements)*, protocol pings, reconnect with backoff (403 at upgrade / close `4002` =
archived → keep retrying at max backoff, §6), stop on `hub/replaced`. Plus two
in-handler affordances (§7): the caller identity — `ctx.principal`, `ctx.roles`,
`ctx.has_role("editor")`, read from the forwarded `_meta` — and sensitive-field
marking, in two spellings: a `Secret` field type for pydantic-/zod-style tool
definitions (`api_key: Secret[str]` — the emitted JSON Schema carries
`writeOnly: true` at that path, in input and output models alike; schema-only,
values still serialize normally on the wire — the HUB does the masking, §7), and
path-based sugar for hand-written schemas (`sensitive(schema, ["password"])`,
input or output schema alike).

