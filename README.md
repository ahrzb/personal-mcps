# personal-mcps

A personal MCP hub on Cloudflare Workers. Long-running bots connect **out** to the
hub over a reverse WebSocket tunnel (telegram-bot style) and become MCP apps;
consumers — Claude Code, claude.ai, scripts — call them at a stable HTTPS endpoint
with per-agent grants, human approvals, and an audit trail. One deploy, no ports
opened anywhere.

```
 bot (Python/JS/Go, anywhere)                  consumer (Claude Code, scripts)
        │  wss://<hub>/connect                        │  POST https://<hub>/<user>/mcp
        │  Authorization: Bearer pmcp_app_…           │  Authorization: Bearer pmcp_agt_…
        ▼                                             ▼
   ┌─────────────────────────── the hub (Cloudflare Worker) ───────────────────────────┐
   │  reverse tunnel (Durable Object,      grants · approvals · audit · admin MCP      │
   │  WebSocket hibernation)               web pages (Hono JSX) · better-auth · D1     │
   └───────────────────────────────────────────────────────────────────────────────────┘
```

## What's in the box

- **Reverse tunnel** — apps dial `wss://<hub>/connect` with a `pmcp_app_` token
  and reconnect forever; the hub proxies consumer MCP calls to them and fails fast
  while they're offline. One `AppConnection` Durable Object holds the sockets.
- **Consumer proxy** — each app is an MCP endpoint at
  `https://<hub>/<user>/mcp` (streamable HTTP). Access is per agent, per
  role; sensitive fields are masked before anything is stored or shown.
- **Approvals** — tool calls can require a human yes, delivered as Web Push to the
  hub's PWA and decided on the `/approvals` page or from the CLI.
- **Admin MCP** — hub administration (apps, agents, grants, approvals, audit)
  is itself exposed as a built-in MCP app, so Claude can operate the hub.
- **Web surface** — login (password, TOTP, passkey), device approval for CLI login,
  app management, approvals dashboard, audit view. `/` redirects to `/apps`
  when signed in, `/login` otherwise.
- **CLI** — `pmcp` covers login (RFC 8628 device flow), apps, agents, tokens,
  approvals, audit, and a YAML access config with `diff`/`apply`.
- **Client libraries** — Python, TypeScript, and Go packages keep an ordinary MCP
  server object reachable through the tunnel. See the
  [client quickstart](docs/quickstart-clients.md).

## Repo layout

| Path | What it is |
|---|---|
| [server/src](server/src) | The Worker: router, tunnel, proxy, identity, approvals, web pages |
| [server/test](server/test) | The suite (vitest, Workers pool + a real-tunnel project) |
| [cli](cli) | The `pmcp` CLI (`cli/pmcp.mts`, TypeScript run via `--experimental-strip-types`) |
| [clients/js](clients/js) | TypeScript app-author library |
| [clients/py](clients/py) | Python app-author library (`pmcp-client`, standalone `uv` project) |
| [clients/go](clients/go) | Go app-author library (official MCP Go SDK transport) |
| [contracts](contracts) | Checked-in wire fixtures (close codes, tunnel frames) shared by hub and all clients |
| [scripts](scripts) | `users.mts` (bootstrap user management), `smoke.ts` (post-deploy probe), `test-inventory.mjs` |
| [docs/specs](docs/specs/README.md) | **The source of truth.** The design spec (§-references throughout the code point here) and the testing strategy, one file per section — [docs/specs/README.md](docs/specs/README.md) is the index |
| [docs/superpowers/plans](docs/superpowers/plans) | Implementation ledgers |
| [docs/superpowers/postmortems](docs/superpowers/postmortems) | One file per escaped bug |
| [flake.nix](flake.nix) | The pinned toolchain and the `pmcp` package; the version authority |

The pnpm workspace has exactly two importers, `cli` and `clients/js` — the two published npm
packages. `server/` deliberately has no manifest of its own, because Wrangler builds it from the
root, and `clients/py` and `clients/go` are not npm packages at all.

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

The Go client is a standalone module:

```bash
cd clients/go && go test ./...
```

Deploy and verify:

```bash
npx wrangler deploy
```

```bash
pnpm smoke        # probes the deployed hub end to end
```

### The toolchain, and where its versions come from

`nix develop` gives you a shell with the versions this repo is actually built and tested
against — Node 24, pnpm 10, Go 1.25, uv — and **the flake is the authority**: when a manifest or
a document disagrees with `flake.nix`, the flake is right and the other is stale.

It sits **beside** `pnpm install`, not in front of it. Contributors without Nix keep working
exactly as before; the flake exists so the versions stop being folklore, and so the `pmcp` CLI
can be built reproducibly from source.

```bash
nix develop             # the pinned toolchain
nix build .#pmcp        # the CLI, built from this tree rather than from npm
nix flake check         # builds the CLI and asserts it runs and matches its manifest
```

Wrangler is deliberately *not* in the shell: it stays an npm dependency so it matches the
lockfile, because its version decides how the Worker runs and two sources for that is one too
many.

One maintenance note. `flake.nix` pins a `pnpmDeps` hash covering the whole lockfile, so **any
dependency change needs it regenerated** — `nix build .#pmcp` fails with the expected hash in its
`got:` line, and `nix flake check` in CI is what catches a stale one.


## Using the CLI

Three ways in, in the order most people want them:

```bash
npm i -g @ahrzb/personal-mcp-cli      # published; `pmcp` on your PATH (Node ≥ 22.18)
nix run github:ahrzb/personal-mcps#pmcp -- --version   # no install, no Node of your own
nix develop                           # a shell with the pinned Node, pnpm, Go and uv
```

```bash
pmcp login        # device flow: opens <hub>/device, approve in a signed-in browser
```

Inside a clone, `pnpm pmcp <command>` runs the same CLI from source — no build step, because
Node ≥ 22.18 strips the TypeScript types natively.

`npm install -g github:ahrzb/personal-mcps` used to be documented here and **never worked**: the
root manifest is `private` with no `bin` and no `prepare`, so npm installed a package that
exposed nothing runnable. The published `@ahrzb/personal-mcp-cli` replaces it.

Hubs are named by profiles in `~/.config/pmcp/config.toml`; pick one with
`--profile <name>` or `PMCP_PROFILE`, and the flat env vars `PMCP_URL` /
`PMCP_TOKEN` always override the stored values. `pnpm pmcp` with no arguments
lists every command. Spec §10 is the full contract.

## Identity and tokens

- **Users** exist only via the `BOOTSTRAP_SECRET`-gated bootstrap script
  (`pnpm users`) — there is no public sign-up. Sign-in is password plus TOTP or
  passkey.
- **`pmcp_app_…`** — an app token: lets one bot hold one app's tunnel slot.
  Refused by every consumer surface.
- **`pmcp_agt_…`** — an agent key: what consumers send to
  `/<user>/mcp`. Issued per agent (`pnpm pmcp token issue --agent <slug>`)
  and scoped by role grants.
- Browser sessions are cookie-based (better-auth); credential management demands
  recent authentication.

## Documentation

Start with the [spec index](docs/specs/README.md) — the design spec is one file per
section there, and the code cites it by section (§6 tunnel protocol, §7 proxy, §10 CLI,
§11 client libraries…). The testing strategy, split the same way in
[docs/specs/testing](docs/specs/testing),
explains how the suite is built; [test-inventory.json](test-inventory.json) is the
generated map of every test. To write and connect a bot, read the
[client quickstart](docs/quickstart-clients.md); to stand up your own instance on
your own Cloudflare account, the [deployment guide](docs/deploy.md).
