## 17. Repo layout

```
personal-mcps/
  server/            # CF Worker: auth, proxy, pmcp admin MCP, ServiceConnection DO, migrations/
  cli/               # pmcp
  clients/
    js/              # @personal-mcps/client
    py/              # pmcp-client (uv project)
  examples/
    news-py/         # smallest possible service, used in docs and e2e
  scripts/           # users.ts
  docs/superpowers/specs/
  mcps.yaml          # the owner's actual config (gitignored? — no: it contains no secrets, keep it)
  pnpm-workspace.yaml
```

