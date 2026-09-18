## 10. CLI (`pmcp`)

TypeScript, ships in the monorepo, run via `npx pmcp` or installed globally.

*(Rewritten 2026-09-01 — the CLI DX redesign. The reviewed mock with full sample
outputs is `docs/superpowers/plans/2026-09-01-cli-dx-mock.md`; this section pins
the contract, the mock shows the rendering.)*

```
pmcp login [--profile <name>] [--url <origin>]   # RFC 8628 device flow; prompts for missing
                                                 #   pieces on a TTY; --json for agents
pmcp logout | whoami
pmcp profile add <name> --url <origin>           # url only; login fills the token
pmcp profile list | use <name> | remove <name>
pmcp ls                                          # apps + kind/status/roles
pmcp describe <ref>                              # app/<slug>[/<item>] | agent/<slug>
pmcp call <app> <tool> [key=value … | --args '{…}']       # scoped canonical call
pmcp hub execute --args '{"code":"export default 1","timeout_ms":5000}'
pmcp hub search-types --args '{"query":"news"}'
pmcp get prompt/<app>/<name> [key=value … | --args '{…}']
pmcp get resource/<app>/<uri>                    # resources/read — scoped endpoint
pmcp connections | connection revoke <id>        # connection_list / connection_revoke (§19)
pmcp token issue (--agent <slug> | --app <slug>) [--expires 90d]
pmcp token list | revoke <id>
pmcp audit [--agent <slug>] [--app <slug>] [--session <id>] [--since 7d]
pmcp audit --export jsonl > events.jsonl         # streams the same rows as the web export
pmcp approvals | approve <id> | reject <id>
pmcp connect <app>                               # prints the /apps OAuth connect URL (§7)
pmcp app create <slug> (--tunneled | --proxied <endpoint> [--auth headers|oauth])
                                                 # tunneled create prints the app token once
pmcp app archive|unarchive|delete|disconnect <slug>
pmcp app set-auth <slug> --header 'Authorization: Bearer …'       # app_set_upstream_auth
pmcp hub settings get
pmcp hub settings set --default-timeout-ms <int> --max-timeout-ms <int>
pmcp app create <slug> ... [--typescript-aliases '<json>']
pmcp app aliases set <slug> --args '{"service":"...","tools":{...}}'
```

**Refs.** `describe` and `get` take one path-style ref whose **first segment names
the kind of thing** (`app/`, `agent/`, `prompt/`, `resource/`); splitting
stops after the second slash, so an item that is itself a URI keeps its slashes
(`get resource/notes/file:///todo.md`). `describe` is family-agnostic: the
app form lists all four catalog families (tools, prompts, resources,
templates — absent families print `(none)`), the item form matches tools and
prompts by name, resources by `uri`, templates by `uriTemplate`, and prints
every match. `describe app/…` renders from the gateway list calls alone and
works with any token; its kind/status/roles header is a best-effort admin read
that degrades to the bare slug for agent callers.

**Transitional aliases.** The pre-redesign spellings `tools`, `prompts`,
`resources` (+ `--templates`), `prompt`, and `read` survive as hidden aliases —
their rows in the CLI command table are asserted by name by the parity suite
(`server/test/worker/contracts.test.ts`), which is frozen until D14 lands.
Retiring the rows and adding `describe`/`get` rows (they front several gateway
methods each; the table's one-method shape needs widening or a declared
exception) is that follow-up amendment. Guessable noun-verb forms resolve as
aliases instead of erroring: `app list` → `ls`, `connection list` →
`connections`, `approval list` → `approvals`.

**Output contract.** Every command that emits data takes `--json` (boolean): one JSON
document on stdout, nothing else on stdout, wire shapes and vocabulary verbatim,
identifiers always full and unelided. Because `--json` means output format everywhere,
the argument payload flag on `call`/`get` is `--args '{…}'`. Human rendering uses color
and truncation only on a TTY; piped output is complete and carries no ANSI escapes.
Exit codes are `0` for success, `1` for runtime or remote failure, and `2` for malformed
argv only.

**Errors.** The first stderr line is `error: <code>: <message>` with a stable
snake_case code (`usage`, `not_found`, `invalid_arguments`, `unauthenticated`,
`ambiguous_id`, `approval_required`, `remote_error`, `login_timeout`, `no_url`
— the vocabulary may grow, codes are never renamed), followed by zero or more
`usage:`/`hint:` lines; indented lines are human detail attached to the line
above — consumers parse column-0 prefixes, never line counts. With `--json`,
stderr instead carries one `{"error":{code, message, hint?, didYouMean?,
expectedArguments?}}` document. Hub refusals get **one best-effort enrichment
fetch on the error path only** (did-you-mean from the catalog, the expected
arguments rendered from `inputSchema`) — never a pre-flight cost, silently
skipped if the fetch fails.

**Interactivity.** Prompts (@clack) appear only in `login`/`profile add`, only on a TTY.
Destructive commands (`app delete`, `agent delete`, `profile remove`) keep a y/N confirm
on a TTY, bypassed by `--yes`; non-TTY without `--yes` refuses on stderr, exit 1.
Everything else is argv-in/text-out.

Every subcommand except auth/profile is presentation sugar over the same scoped admin
operations and MCP methods. `pmcp call pmcp <operation>` remains the universal admin
path; old generic aggregate `<slug>_<tool>` dispatch does not. Hub execution uses the
ordinary JSON `--args` payload so `timeout_ms` remains a JSON integer. Dedicated settings
flags parse bounded integers before invoking `hub_settings_update`; numeric `key=value`
strings are never passed as schema integers.

Config: `~/.config/pmcp/config.toml` *(amended 2026-08-26; was config.json — an
existing flat `config.json` is read once as profile `default` and superseded by
the next write)*, holding named **profiles** — a profile is one hub identity:
`url`, `token`, and optionally `bootstrap_secret` (operator-written by hand,
never by the CLI; §12's script reads it):

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

*(Amended 2026-09-01: parsing/emitting moves from the hand-rolled subset to
**smol-toml** behind a thin wrapper whose contract is pinned by tests — parse errors are
caught and rebuilt from line/column only because the library's own message embeds the
offending line's text; unknown top-level and per-profile keys survive a parse→emit round
trip; writes stay mode 0600.)*

Profile selection precedence: `--profile <name>` flag > `PMCP_PROFILE` env var > the
file's top-level `profile` key > the name `default` (neutral on purpose — the CLI's
users are not only developers with environments). `login --profile <name>` writes
`url`+`token` into that profile alone; the top-level default is set only when the
write creates the file, and is otherwise touched only by an explicit
`profile use`. `profile add` writes the url alone and never destroys a
credential — a url change on a profile with a token warns instead of clearing.
`logout` clears the active profile's token only. Environment variables stay flat
and profile-free: `PMCP_TOKEN` and `PMCP_URL` override whatever the active
profile resolved — session or agent tokens only (`pmcp_app_` tokens
are rejected by every consumer surface). With an agent key, the gateway
sugar (`call`, `get`, `describe app/…`) works within grants; `ls` and every
admin-backed command fail (`ls` is sugar over `pmcp_app_list`, and agents
can never hold `pmcp` grants, §8). The hub's `GET /api/whoami` route
(§8) accepts both token kinds and returns `{ principal, namespace }` — that's
how the CLI builds `/<user>/mcp/…` URLs when it holds only an agent
key, and both fields survive into `whoami`'s human and `--json` output. `PMCP_URL`
overrides the URL and is always the **https origin** — everywhere, including the client
libraries, which derive `wss://<origin>/connect` from it.

App alias commands configure only hub-local TypeScript paths. They never ask a proxied
upstream to rename a service/tool. Human output shows canonical scoped identities beside
resolved TypeScript paths and collision diagnostics.


Runtime dependencies (the §4 carve-out): `commander`, `@clack/prompts`, `picocolors`,
`wrap-ansi`, and `smol-toml`, declared in `cli/package.json`.
