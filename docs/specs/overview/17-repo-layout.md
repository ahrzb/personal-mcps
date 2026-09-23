## 17. Repo layout

```
personal-mcps/
  server/            # CF Worker, AppConnection DO, QuickJS/Wasm execution, D1 migrations
  cli/               # pmcp — a pnpm workspace importer, published as @ahrzb/personal-mcp-cli
  web/               # the browser client (§13) — React SPA for /apps/*, /agents/* and
                     #   /audit (2026-09-21, decision 36) — and, 2026-09-23 (decision 38),
                     #   every other page: /login, /device, /settings/*, /approvals*,
                     #   /oauth/consent — a
                     #   workspace importer, unpublished; `vite build` emits dist/app.{js,css}
    src/lib/          # the fetch door, the wire types, the query keys
    src/chrome/       # the shell, the pane rail, the dialogs
    src/features/     # apps, app-detail, agents, audit (+ the five page families, 2026-09-23)
    src/preview/      # the state gallery, preview-mode only — the kept demo of every
                      #   state once server/dev/ retires (2026-09-23)
    scripts/          # visual-compare.mts, drawer-check.mts, audit-search-check.mts
                      #   (2026-09-21), server-baselines.mts (2026-09-23) — hand-run,
                      #   browser-driven
  clients/
    js/              # @ahrzb/personal-mcp-client — the third workspace importer
    py/              # personal-mcp-client (uv project, not npm)
    go/              # github.com/ahrzb/personal-mcps/clients/go module (not npm)
    rust/            # personal-mcp-client package, `pmcp` crate (not npm)
  examples/
    news-py/         # smallest possible app, used in docs and e2e
  scripts/           # users.mts, smoke.ts, test-inventory.mjs
  contracts/         # generated wire fixtures, including hub.json
  docs/specs/        # source of truth; §23 owns hub execution
  pnpm-workspace.yaml
  flake.nix          # pinned toolchain + the pmcp package (§22.7)
```

**`cli`, `web` and `clients/js` are the workspace importers** — the two published npm
packages plus the browser client. `server/` has no manifest of its own on purpose: Wrangler
builds it from the root, so a manifest there would be a third declaration of the same
dependency set with nothing consuming it. `clients/py`, `clients/go`, and
`clients/rust` are not npm packages at all. Nothing in `server/src` imports anything from
`web/`: the Worker serves that
directory's two built files out of a static-asset binding, which is the whole of the edge
between them (§4's dependency policy).

The separate sibling `../terraform-provider-pmcp` repository owns provider
implementation and lifecycle tests. This repository owns its generated admin contracts
and provider specification; it never grows a provider subtree.

*(Amended 2026-09-15: `pnpm-workspace.yaml` had no `packages:` key until then, so despite this
layout nothing here was an importer and the lockfile carried only the root — which is why the
root manifest used to mirror the CLI's dependencies. See §4's dependency policy.)*

*(Amended 2026-09-23, decision 38: the server stops rendering pages. The worker stops serving
each page's template in the change that moves that page, but the files stay until the last
page (login) has moved, because the states preview renders them and is what the baselines are
re-shot from if one ever has to be: then `server/src/pages/{layout,login,device,settings,
approvals,approval-detail,consent}.tsx`, `server/dev/preview.ts`, `server/dev/fixtures.ts` and
`wrangler.preview.jsonc` go together — plus `pages/model.ts`'s page props types and their
view-only builders, whose server halves stay as the reads' implementations. `server/src/pages/spa.tsx`
stays as the one document, and `server/src/pages/styles.css` stays until pass 2 deletes it.
`design/baseline/` holds the server-rendered baselines the pass-1 screenshot gate diffs
against, shot once before any page moved.)*

