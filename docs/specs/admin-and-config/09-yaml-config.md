## 9. YAML config, diff, apply

One file per user, default `mcps.yaml`, authoritative for the logged-in user's
namespace: apps, agents, and grants. Users and tokens are deliberately
imperative (secrets and humans don't belong in a declarative file).

```yaml
apps:
  news:                     # kind: tunnel is the default; roles come from registration
    name: News MCP
    description: RSS digester on the home server
  notion:
    kind: proxy
    endpoint: https://mcp.notion.com/mcp
    log_bodies: true        # opt-in: proxied bodies are not audited by default (§15);
                            #   tunneled apps default to true — either flips
    roles:                  # virtual roles — defined here because the upstream can't
      editor: ["create_page", "update_.*"]   # anchored regexes over tool names
      reader: ["search", "fetch_.*"]
    redact:                 # sensitive argument paths per tool (§7) — config-declared
      create_page: ["credentials.token"]     #   because upstream schemas rarely mark writeOnly
    redact_results:         # identical shape, applied to result structuredContent (§7)
      create_page: ["page.share_token"]
    # upstream auth is imperative (app_set_upstream_auth) — never in this file
  linear:
    kind: proxy
    endpoint: https://mcp.linear.app/mcp
    auth: oauth             # connected interactively from /apps (§7); tokens never here
    capabilities: [tools, resources]  # §20.2: what a proxied app's scoped handshake
                            #   advertises (subset of tools/prompts/resources/completions);
                            #   absent means tools only — advertisement, never access
    roles:
      reader: ["list_.*", "get_.*"]        # bare list = tools, unchanged (§20)
      docs:                                # per-family form (§20, added 2026-08-26)
        prompts: ["summarize_.*"]
        resources: ["linear://docs/*"]     # anchored, `*` still aliases `.*`
  home:
    name: Home automation
    archived: true          # parked: connections refused, hidden from consumers,
                            # roles/grants/tokens retained (§6, "App lifecycle")

agents:
  claude:
    name: Claude
    grants:
      news: [reader]        # exact role names; warned (not rejected) if the app
                            # hasn't declared them yet
      notion: [editor]
      home: ["control:approval"]  # ':approval' suffix = approval mode (§2) — role names
                            # have no colon, so the suffix is unambiguous; bare = allow
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
```

- `pmcp diff -f mcps.yaml` — reads server state via `pmcp` tools, prints a create/update/
  delete plan (including archive/unarchive transitions from the `archived` field).
  Full desired state: deletes include apps/agents present on the
  server but absent from the file, **and** grants for any (agent, app) pair not
  listed under that agent's `grants:` block. `redact`, `redact_results`, and
  `log_bodies` (either kind) and, for proxied
  apps, `endpoint`, `auth`, `forward_identity`, `roles`, and *(2026-08-27)*
  `capabilities` are part of the desired state and diffed like any other field (an
  `auth` flip is shown as destructive — it wipes stored upstream credentials, §8).
  `capabilities` is compared as a **set** with absent ≡ `[tools]` (§20.2's default),
  so spelling out the default, or reordering the list, is never a diff. Listing the same role name in both modes (`[reader,
  "reader:approval"]`) is rejected as a config error — in the YAML and in `grant_set`
  alike. Grants
  referencing roles a *tunneled* app hasn't declared are applied but flagged with a
  warning (tunneled roles arrive at connect time, so the file can legitimately be ahead
  of the first connection); `all` is exempt, and for proxied apps undeclared roles are
  a hard error (their roles live in this same file). The reserved `pmcp` slug is
  excluded from the delete computation and rejected anywhere it appears in the file —
  as an `apps:` key or inside a `grants:` block.
- `pmcp apply -f mcps.yaml` — shows the same diff, asks for confirmation (`--yes` to
  skip), applies. Deleting an app or agent cascades its grants and deletes its
  tokens (server-side side effect of the `*_delete` tools, §8).

