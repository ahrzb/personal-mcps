## 10. CLI (`pmcp`)

TypeScript, ships in the monorepo, run via `npx pmcp` or installed globally.

```
pmcp login [--url https://mcp.example.com]   # RFC 8628 device flow; prints code + URL
pmcp logout | whoami
pmcp ls                                       # services + status (online/offline for tunneled,
                                              #   proxy for proxied) + roles
pmcp tools <service>                          # tools/list as seen with current token
pmcp call <service> <tool> [--json '{…}' | key=value …]   # or the aggregated name:
pmcp call <service>_<tool> [...]                          # unambiguous, slugs have no '_'
pmcp prompts <service>                        # prompts/list          (§20, added 2026-08-26)
pmcp prompt <service> <name> [key=value …]    # prompts/get
pmcp resources <service> [--templates]        # resources/list | resources/templates/list
pmcp read <service> <uri>                     # resources/read — scoped endpoint only (§20)
pmcp connections | connection revoke <id>     # connection_list / connection_revoke (§19)
pmcp diff  -f mcps.yaml
pmcp apply -f mcps.yaml [--yes]
pmcp token issue (--account <slug> | --service <slug>) [--expires 90d]
pmcp token list | revoke <id>
pmcp audit [--account <slug>] [--service <slug>] [--session <id>] [--since 7d]
pmcp audit --export jsonl > events.jsonl      # streams the same rows as the web export
pmcp approvals [--pending | --history]
pmcp approve <id> | reject <id>
pmcp connect <service>                        # prints the /services OAuth connect URL (§7)
pmcp service create <slug> (--tunneled | --proxied <endpoint> [--auth headers|oauth])
                                              # tunneled create prints the service token once
pmcp service archive|unarchive|delete|disconnect <slug>
pmcp service set-auth <slug> --header 'Authorization: Bearer …'   # service_set_upstream_auth
```

All service and account references resolve within the logged-in user's namespace (the
CLI learns the username from `whoami` and builds `/<user>/mcp/…` URLs itself).

*(Amended 2026-08-26: the four §20 commands are gateway sugar of exactly the kind
`tools`/`call` already are — they front an MCP method, not an admin op, so they are
outside §8's parity list rather than an exception to it. `connections` is the opposite:
it fronts §19's two admin ops and is inside it. There is no `completion` command —
nothing observably consumes `completion/complete`, and §20 serves it for conformance,
not for a human.)*

Every subcommand except the auth family is presentation sugar: `ls`, `tools`, `token`,
`service`, `diff`, and `apply` are compositions of the same `pmcp_*` and MCP tool
calls that `pmcp call` (or any agent) can make directly — nicer output, zero extra
capability. The converse holds too: every UI capability is reachable from the CLI
(§8's parity invariant) — only the UX differs. YAML `diff`/`apply` is the CLI-native
way to manage services and grants declaratively; the imperative `pmcp service` family
covers the one-off actions the UI does with buttons.

Config: `~/.config/pmcp/config.toml` *(amended 2026-08-26; was config.json — an
existing flat `config.json` is read once as profile `default` and superseded by the
next write)*, holding named **profiles** — a profile is one hub identity: `url`,
`token`, and optionally `bootstrap_secret` (operator-written by hand, never by the
CLI; §12's script reads it):

```toml
profile = "default"        # active when nothing else selects one

[profiles.default]
url = "https://hub.example"
token = "…"                # written by `pmcp login`, cleared by `pmcp logout`

[profiles.local]
url = "http://localhost:8787"
token = "…"
bootstrap_secret = "…"     # dev-only; hand-written, survives login/logout
```

Profile selection precedence: `--profile <name>` flag > `PMCP_PROFILE` env var > the
file's top-level `profile` key > the name `default` (neutral on purpose — the CLI's
users are not only developers with environments). `login --profile <name>` writes
`url`+`token` into that profile alone; the top-level default is set only when the
write creates the file, and is otherwise never touched implicitly. `logout` clears
the active profile's token only. Environment variables stay flat and profile-free:
`PMCP_TOKEN` and `PMCP_URL` override whatever the active profile resolved — session
or service-account tokens only (`pmcp_svc_` tokens
are rejected by every consumer surface). With a service-account key, `tools`/`call`
work within grants; `ls` and every other admin-backed command fail (`ls` is sugar over
`pmcp_service_list`, and service accounts can never hold `pmcp` grants, §8). The hub's
`GET /api/whoami` route (§8) accepts both token kinds and returns
`{ principal, namespace }` — that's how the CLI builds `/<user>/mcp/…` URLs when it
holds only a service-account key. `PMCP_URL`
overrides the URL and is always the **https origin** — everywhere, including the client
libraries, which derive `wss://<origin>/connect` from it.

