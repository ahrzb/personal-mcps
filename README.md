# personal-mcps

A personal MCP hub on Cloudflare Workers. Long-running bots connect **out** over a
reverse WebSocket tunnel and proxied apps stay remote. Consumers call each app at a
stable scoped HTTPS endpoint, or submit one TypeScript program to the aggregate hub
orchestration endpoint. Programs are checked before isolated QuickJS execution; per-agent
grants, human approvals, and the audit trail apply end to end.

```
 bot / proxied MCP                       consumer
        │                               │ POST /<user>/mcp      (hub execute/search)
        │ wss / upstream HTTP           │ POST /<user>/mcp/<app> (direct scoped MCP)
        ▼                               ▼
 ┌──────────────────────── Cloudflare Worker trust boundary ────────────────────────┐
 │ D1 registry · grants · approvals · audit · AppConnection tunnel DO              │
 │ hub catalog + declarations ──▶ fresh QuickJS/Wasm runtime per execution          │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

## What's in the box

- **Reverse tunnel** — apps dial `wss://<hub>/connect` with a `pmcp_app_` token
  and reconnect forever; the hub proxies consumer MCP calls to them and fails fast
  while they're offline. One `AppConnection` Durable Object holds the sockets.
- **Consumer proxy** — every app has a canonical scoped endpoint at
  `https://<hub>/<user>/mcp/<app>`. The aggregate endpoint exposes only
  `hub_execute`, `hub_search_types`, and TypeScript declarations; its programs compose
  authorized scoped tool calls/resource reads without receiving the invoking bearer.
- **Approvals** — gated tool calls require a human yes; programs never auto-resume or
  replay around that decision.
- **Admin MCP** — hub administration is the scoped virtual `pmcp` app and is available
  inside a program only to the exact operations the invoking owner/admin credential has.
- **Web surface** — login (password, TOTP, passkey), device approval for CLI login,
  app management, approvals dashboard, audit view. `/` redirects to `/apps`
  when signed in, `/login` otherwise.
- **CLI** — `pmcp` covers login (RFC 8628 device flow), apps, agents, tokens,
  approvals, audit, and generic MCP/admin operation invocation.
- **Client libraries** — Python, TypeScript, and Go packages keep an ordinary MCP
  server object reachable through the tunnel. See the
  [client quickstart](docs/quickstart-clients.md).

## Repo layout

| Path | What it is |
|---|---|
| [server/src](server/src) | Worker trust boundary: router, identity, scoped dispatch, tunnel, hub catalog/types/QuickJS runtime |
| [server/test](server/test) | Unit, workerd, tunnel, and adapter suites |
| [cli](cli) | The `pmcp` CLI |
| [web](web) | The browser client: a React SPA for `/apps/*` and `/agents/*` over the JSON surface at `/api/hub`. `vite build` emits `dist/app.js` and `dist/app.css`, which the Worker serves out of a static-asset binding — nothing in `server/src` imports from here |
| [clients/js](clients/js) | TypeScript app-author library |
| [clients/py](clients/py) | Python app-author library |
| [clients/go](clients/go) | Go app-author library |
| [contracts](contracts) | Producer-generated wire fixtures shared by every consumer |
| [scripts](scripts) | `users.mts` (bootstrap user management), `smoke.ts` (post-deploy probe), `test-inventory.mjs` |
| [docs/specs](docs/specs/README.md) | **The source of truth.** The design spec (§-references throughout the code point here) and the testing strategy, one file per section — [docs/specs/README.md](docs/specs/README.md) is the index |
| [docs/superpowers/plans](docs/superpowers/plans) | Implementation ledgers |
| [docs/superpowers/postmortems](docs/superpowers/postmortems) | One file per escaped bug |
| [flake.nix](flake.nix) | The pinned toolchain and the `pmcp` package; the version authority |

The pnpm workspace has three importers: `cli` and `clients/js` — the two published npm
packages — and `web`, the browser client, which is unpublished but carries its own manifest
because its dependency set is one no other part of the repo may import. `server/`
deliberately has no manifest of its own, because Wrangler builds it from the root, and
`clients/py` and `clients/go` are not npm packages at all.

## Everyday commands

```bash
pnpm install
```

```bash
pnpm dev          # builds the client, then wrangler dev on http://localhost:8787 (reads .dev.vars)
```

`pnpm dev` builds `web/dist` first because `wrangler dev` reads that directory once, at
startup: rebuilding the client under a running dev server leaves it serving a 404 for
`/app.js` until it is restarted. Rebuild and restart together.

```bash
pnpm test         # the full suite
```

```bash
pnpm typecheck
```

Two checks drive a real browser, so they are run by hand rather than in CI — the workflow
provides neither a dev server nor a browser download:

```bash
pnpm visual:compare   # every gallery state against design/baseline/ → web/.visual/report.html
pnpm check:drawer     # the phone drawer's behaviour, which no screenshot can capture
```

`design/baseline/` is a fixed reference: the server-rendered `/apps` and `/agents` pages it
was captured from no longer exist, so it is read and never recaptured.

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
pnpm run build:web   # wrangler validates that assets.directory exists, so this comes first
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
