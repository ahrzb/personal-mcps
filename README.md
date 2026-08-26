# personal-mcps

A personal MCP hub on Cloudflare Workers. Long-running bots connect **out** to the
hub over a reverse WebSocket tunnel (telegram-bot style) and become MCP services;
consumers — Claude Code, claude.ai, scripts — call them at a stable HTTPS endpoint
with per-account grants, human approvals, and an audit trail. One deploy, no ports
opened anywhere.

```
 bot (Python/JS, anywhere)                     consumer (Claude Code, scripts)
        │  wss://<hub>/connect                        │  POST https://<hub>/<user>/mcp
        │  Authorization: Bearer pmcp_svc_…           │  Authorization: Bearer pmcp_sa_…
        ▼                                             ▼
   ┌─────────────────────────── the hub (Cloudflare Worker) ───────────────────────────┐
   │  reverse tunnel (Durable Object,      grants · approvals · audit · admin MCP      │
   │  WebSocket hibernation)               web pages (Hono JSX) · better-auth · D1     │
   └───────────────────────────────────────────────────────────────────────────────────┘
```

## What's in the box

- **Reverse tunnel** — services dial `wss://<hub>/connect` with a `pmcp_svc_` token
  and reconnect forever; the hub proxies consumer MCP calls to them and fails fast
  while they're offline. One `ServiceConnection` Durable Object holds the sockets.
- **Consumer proxy** — each service is an MCP endpoint at
  `https://<hub>/<user>/mcp` (streamable HTTP). Access is per service account, per
  role; sensitive fields are masked before anything is stored or shown.
- **Approvals** — tool calls can require a human yes, delivered as Web Push to the
  hub's PWA and decided on the `/approvals` page or from the CLI.
- **Admin MCP** — hub administration (services, accounts, grants, approvals, audit)
  is itself exposed as a built-in MCP service, so Claude can operate the hub.
- **Web surface** — login (password, TOTP, passkey), device approval for CLI login,
  service management, approvals dashboard, audit view. `/` redirects to `/services`
  when signed in, `/login` otherwise.
- **CLI** — `pmcp` covers login (RFC 8628 device flow), services, accounts, tokens,
  approvals, audit, and a YAML access config with `diff`/`apply`.
- **Client libraries** — Python and TypeScript twins that keep an ordinary MCP
  server object reachable through the tunnel. See the
  [client quickstart](docs/quickstart-clients.md).

## Repo layout

| Path | What it is |
|---|---|
| [server/src](server/src) | The Worker: router, tunnel, proxy, identity, approvals, web pages |
| [server/test](server/test) | The suite (vitest, Workers pool + a real-tunnel project) |
| [cli](cli) | The `pmcp` CLI (`cli/pmcp.mts`, TypeScript run via `--experimental-strip-types`) |
| [clients/js](clients/js) | TypeScript service-author library |
| [clients/py](clients/py) | Python service-author library (`pmcp-client`, standalone `uv` project) |
| [contracts](contracts) | Checked-in wire fixtures (close codes, tunnel frames) shared by hub and both clients |
| [scripts](scripts) | `users.mts` (bootstrap user management), `smoke.ts` (post-deploy probe), `test-inventory.mjs` |
| [docs/superpowers/specs](docs/superpowers/specs) | **The source of truth.** [Design spec](docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md) (§-references throughout the code point here) and the [testing strategy](docs/superpowers/specs/2026-08-25-testing-strategy.md) |
| [docs/superpowers/plans](docs/superpowers/plans) | Implementation ledgers |
| [docs/superpowers/postmortems](docs/superpowers/postmortems) | One file per escaped bug |

## Everyday commands

```bash
pnpm install
```

```bash
pnpm dev          # wrangler dev on http://localhost:8787 (reads .dev.vars)
```

```bash
pnpm test         # the full suite
```

```bash
pnpm typecheck
```

Python client tests run in their own environment:

```bash
cd clients/py && uv run pytest
```

Deploy and verify:

```bash
npx wrangler deploy
```

```bash
pnpm smoke        # probes the deployed hub end to end
```

## Using the CLI

```bash
pnpm pmcp login   # device flow: opens <hub>/device, approve in a signed-in browser
```

Hubs are named by profiles in `~/.config/pmcp/config.toml`; pick one with
`--profile <name>` or `PMCP_PROFILE`, and the flat env vars `PMCP_URL` /
`PMCP_TOKEN` always override the stored values. `pnpm pmcp` with no arguments
lists every command. Spec §10 is the full contract.

## Identity and tokens

- **Users** exist only via the `BOOTSTRAP_SECRET`-gated bootstrap script
  (`pnpm users`) — there is no public sign-up. Sign-in is password plus TOTP or
  passkey.
- **`pmcp_svc_…`** — a service token: lets one bot hold one service's tunnel slot.
  Refused by every consumer surface.
- **`pmcp_sa_…`** — a service-account key: what consumers send to
  `/<user>/mcp`. Issued per account (`pnpm pmcp token issue --account <slug>`)
  and scoped by role grants.
- Browser sessions are cookie-based (better-auth); credential management demands
  recent authentication.

## Documentation

Start with the [design spec](docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md) —
the code cites it by section (§6 tunnel protocol, §7 proxy, §10 CLI, §11 client
libraries…). The [testing strategy](docs/superpowers/specs/2026-08-25-testing-strategy.md)
explains how the suite is built; [test-inventory.json](test-inventory.json) is the
generated map of every test. To write and connect a bot, read the
[client quickstart](docs/quickstart-clients.md).
