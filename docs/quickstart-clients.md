# Client quickstart — put a bot behind the hub

The client libraries do one thing: keep an ordinary MCP server object reachable
through the hub's reverse tunnel. You write the server with the official MCP SDK;
`serve()` dials the hub, registers, reconnects forever, and never shows you a
socket. Python and TypeScript are twins — same options, same lifecycle, same
close-code policy (spec §6, §11).

Neither library is published to a registry yet — both install straight from this
git repo ([clients/py](../clients/py) and [clients/js](../clients/js) are the
package roots).

## 0. One-time setup

You need a hub you can sign in to. The CLI installs straight from the git repo —
no clone needed (any Node with default type stripping, ≥ 22.18 / 23.6):

```bash
npm install -g "github:ahrzb/personal-mcps"
```

(One-off alternative: `npx github:ahrzb/personal-mcps <command>`. Inside a clone,
`pnpm pmcp <command>` is the same CLI.)

Tell it where the hub is — an env var, or a profile in
`~/.config/pmcp/config.toml` — and sign in:

```bash
export PMCP_URL=https://personal-mcps.ahrzb.workers.dev
```

```bash
pmcp login
```

Create the service and capture its token — the `pmcp_svc_…` value is shown once:

```bash
pmcp service create mybot
```

(Lost it? Mint another with `pmcp token issue --service mybot` and revoke the
old one with `pmcp token list` / `token revoke`.)

Give the bot its environment (any machine, no inbound ports needed):

```bash
export PMCP_URL=https://personal-mcps.ahrzb.workers.dev
export PMCP_SERVICE_TOKEN=pmcp_svc_...   # from service create
```

## 1. Python

```bash
pip install "git+https://github.com/ahrzb/personal-mcps.git#subdirectory=clients/py"
```

or with uv:

```bash
uv add "pmcp-client @ git+https://github.com/ahrzb/personal-mcps.git#subdirectory=clients/py"
```

Requires Python ≥ 3.12. Build the server with the official `mcp` SDK, then hand it
to `serve`:

```python
import asyncio

import mcp.types as types
from mcp.server.lowlevel import Server

import pmcp_client

server = Server("mybot")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="get_weather",
            description="Current weather for a city",
            inputSchema={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    return [types.TextContent(type="text", text=f"sunny in {arguments['city']}")]


# Blocks for the life of the service — treat it as the bot's main loop.
asyncio.run(pmcp_client.serve(server, roles={"reader": ["get_*"]}))
```

`url=` and `token=` parameters override the `PMCP_URL` / `PMCP_SERVICE_TOKEN` env
vars. There is deliberately no service-name parameter: identity comes entirely
from the token.

## 2. TypeScript

```bash
pnpm add "github:ahrzb/personal-mcps#path:clients/js"
```

(npm cannot install a subdirectory of a git repo — use pnpm, or clone and depend
on `clients/js` by path.) The package ships TypeScript source: Node ≥ 23.6 runs
it natively via type stripping; older Nodes need `--experimental-strip-types` or
a bundler.

```ts
import { serve } from "@personal-mcps/client";

// `server` is your MCP server from @modelcontextprotocol/server v2
// (McpServer or Server) — register tools on it with the SDK as usual.
await serve(server, { roles: { reader: ["get_*"] } });
```

Same contract as Python: options fall back to `PMCP_URL` / `PMCP_SERVICE_TOKEN`,
and the returned promise pends for the life of the service. For a hand-rolled SDK
session, construct `HubTransport` directly — `serve()` is sugar over it.

## 3. Roles

The `roles` declaration maps role names to anchored patterns over tool names
(`get_*` matches `get_weather`; a bare name matches itself; `*` matches all).
Declaring none means only owner tokens or grants of the built-in `all` role can
reach the service. Grant a role to a service account:

```bash
pmcp diff      # preview against the YAML access config
```

```bash
pmcp apply
```

## 4. Who is calling?

Inside a tool handler, read the hub-asserted caller off the request's `_meta` —
consumers cannot forge these fields:

```python
who = pmcp_client.caller(request_meta)
who.principal        # "user:ahrzb" or "sa:claude"
who.has_role("admin")  # True for the role or the built-in "all"
```

```ts
const who = caller(extra.requestMeta);
if (!who.hasRole("admin")) throw new Error("admin only");
```

On a request that never passed through the hub (local testing), the fields are
simply absent: empty principal, no roles, no error.

## 5. Secrets in tool schemas

Mark fields whose values must never land in logs, audit, or approval prompts —
the hub masks them before anything is persisted or shown:

```python
from pmcp_client import Secret

class Login(BaseModel):
    username: str
    password: Secret[str]
```

```ts
import { secret, sensitive } from "@personal-mcps/client";

// zod shape:
const input = { username: z.string(), password: secret(z.string()) };
// or a hand-written JSON Schema:
const schema = sensitive(jsonSchema, ["credentials.token"]);
```

## 6. Connect a consumer

Issue a service-account key (shown once, `pmcp_sa_…`):

```bash
pmcp token issue --account claude
```

Point Claude Code at the service:

```bash
claude mcp add --transport http mybot https://personal-mcps.ahrzb.workers.dev/ahrzb/mcp --header "Authorization: Bearer pmcp_sa_..."
```

Or call it from anywhere that speaks streamable HTTP MCP — the endpoint is
`https://<hub>/<user>/mcp` with the key as a bearer token. Check what the account
can see:

```bash
pmcp tools
```

## 7. Lifecycle — what serve() does on failure

| Event | Behavior |
|---|---|
| Network drop, hub deploy, timeouts | Reconnects forever (jittered backoff, 1 s → 60 s cap) and re-registers; you never see it |
| Service archived (403 / close 4002) | Keeps retrying at max backoff — unarchiving heals within a minute |
| Newer connection takes the slot (close 4000) | This copy stops quietly: `serve()` returns |
| Dead credential (401 / close 4001) | Raises/rejects `CredentialsError` — terminal, never retried |
| Role declaration rejected | Raises/rejects `RegistrationError` — terminal |

Nothing is buffered while offline: the hub fails consumer calls fast and re-lists
tools after every reconnect, so a dropped `tools/list_changed` heals itself.
