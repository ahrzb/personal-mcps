## 17. Repo layout

```
personal-mcps/
  server/            # CF Worker, AppConnection + HubSandbox DOs, D1 migrations
    sandbox/          # immutable pinned Deno parent/worker image inputs (§23)
  cli/               # pmcp — a pnpm workspace importer, published as @ahrzb/personal-mcp-cli
  clients/
    js/              # @ahrzb/personal-mcp-client — the other workspace importer
    py/              # personal-mcp-client (uv project, not npm)
    go/              # github.com/ahrzb/personal-mcps/clients/go module (not npm)
  examples/
    news-py/         # smallest possible app, used in docs and e2e
  scripts/           # users.mts, smoke.ts, test-inventory.mjs
  contracts/         # generated wire fixtures, including hub.json
  docs/specs/        # source of truth; §23 owns hub execution
  pnpm-workspace.yaml
  flake.nix          # pinned toolchain + the pmcp package (§22.7)
```

**`cli` and `clients/js` are the only workspace importers** — the two published npm packages.
`server/` has no manifest of its own on purpose: Wrangler builds it from the root, so a manifest
there would be a third declaration of the same dependency set with nothing consuming it.
`clients/py` and `clients/go` are not npm packages at all.

The separate sibling `../terraform-provider-pmcp` repository owns provider
implementation and lifecycle tests. This repository owns its generated admin contracts
and provider specification; it never grows a provider subtree.

*(Amended 2026-09-15: `pnpm-workspace.yaml` had no `packages:` key until then, so despite this
layout nothing here was an importer and the lockfile carried only the root — which is why the
root manifest used to mirror the CLI's dependencies. See §4's dependency policy.)*

