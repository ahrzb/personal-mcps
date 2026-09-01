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
pmcp ls                                          # services + kind/status/roles (wire vocabulary)
pmcp describe <ref>                              # service/<slug>[/<item>] | account/<slug>
pmcp call <service> <tool> [key=value … | --args '{…}']   # or the aggregated name:
pmcp call <slug>_<tool> [...]                             # unambiguous, slugs have no '_'
pmcp get prompt/<service>/<name> [key=value … | --args '{…}']   # prompts/get
pmcp get resource/<service>/<uri>                # resources/read — scoped endpoint only (§20)
pmcp connections | connection revoke <id>        # connection_list / connection_revoke (§19)
pmcp diff  [-f mcps.yaml]
pmcp apply [-f mcps.yaml] [--yes]
pmcp token issue (--account <slug> | --service <slug>) [--expires 90d]
pmcp token list | revoke <id>
pmcp audit [--account <slug>] [--service <slug>] [--session <id>] [--since 7d]
pmcp audit --export jsonl > events.jsonl         # streams the same rows as the web export
pmcp approvals | approve <id> | reject <id>
pmcp connect <service>                           # prints the /services OAuth connect URL (§7)
pmcp service create <slug> (--tunneled | --proxied <endpoint> [--auth headers|oauth])
                                                 # tunneled create prints the service token once
pmcp service archive|unarchive|delete|disconnect <slug>
pmcp service set-auth <slug> --header 'Authorization: Bearer …'   # service_set_upstream_auth
```

**Refs.** `describe` and `get` take one path-style ref whose **first segment names
the kind of thing** (`service/`, `account/`, `prompt/`, `resource/`); splitting
stops after the second slash, so an item that is itself a URI keeps its slashes
(`get resource/notes/file:///todo.md`). `describe` is family-agnostic: the
service form lists all four catalog families (tools, prompts, resources,
templates — absent families print `(none)`), the item form matches tools and
prompts by name, resources by `uri`, templates by `uriTemplate`, and prints
every match. `describe service/…` renders from the gateway list calls alone and
works with any token; its kind/status/roles header is a best-effort admin read
that degrades to the bare slug for service-account callers.

**Transitional aliases.** The pre-redesign spellings `tools`, `prompts`,
`resources` (+ `--templates`), `prompt`, and `read` survive as hidden aliases —
their rows in the CLI command table are asserted by name by the parity suite
(`server/test/worker/contracts.test.ts`), which is frozen until D14 lands.
Retiring the rows and adding `describe`/`get` rows (they front several gateway
methods each; the table's one-method shape needs widening or a declared
exception) is that follow-up amendment. Guessable noun-verb forms resolve as
aliases instead of erroring: `service list` → `ls`, `connection list` →
`connections`, `approval list` → `approvals`.

**Output contract.** Every command that emits data takes `--json` (boolean):
one JSON document on stdout, nothing else on stdout, wire shapes and
vocabulary verbatim (`kind: tunnel|proxy|builtin`, `principal`/`namespace`,
the planner's `{steps, warnings, errors}`), identifiers always full and
unelided. Because `--json` now means output format everywhere, the argument
payload flag on `call`/`get` is `--args '{…}'` (the old `--json '{…}'`
spelling is the one deliberate grammar break). Human rendering: color and
truncation only on a TTY — piped output is complete and carries no ANSI
escapes (decorative glyphs like `→`/`·` appear in both renderings; the mock's
samples pin them). Exit codes: `0` success (including a computed
non-empty `diff`; drift detection is `--json` + `steps.length`), `1` any
runtime/remote failure (a tool result with `isError: true` exits 1 with the
result still printed), `2` malformed argv only.

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

**Interactivity.** Prompts (@clack) appear only in `login`/`profile add`, only
on a TTY. Destructive commands (`service delete`, `account delete`, `apply`,
`profile remove`) keep a y/N confirm on a TTY, bypassed by `--yes`; non-TTY
without `--yes` refuses on stderr, exit 1. Everything else is argv-in/text-out
— the CLI is built to be driven by agents, which get discoverability from
help text, error hints, and `--json` instead of pickers.

Every subcommand except the auth and profile families is presentation sugar:
`ls`, `describe`, `get`, `token`, `service`, `diff`, and `apply` are
compositions of the same `pmcp_*` and MCP tool calls that `pmcp call` (or any
agent) can make directly — nicer output, zero extra capability. `describe`
and `get` front MCP methods, not admin ops, so like `tools`/`call` before
them they sit outside §8's parity list rather than being exceptions to it
(`describe account/…` composes `account_list` + `token_list`; there is still
no `completion` command — nothing observably consumes `completion/complete`,
§20 serves it for conformance). The converse holds too: every UI capability
is reachable from the CLI (§8's parity invariant) — only the UX differs.
YAML `diff`/`apply` is the CLI-native way to manage services and grants
declaratively; the imperative `pmcp service` family covers the one-off
actions the UI does with buttons.

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
**smol-toml** behind a thin wrapper whose contract is pinned by tests — parse
errors are caught and replaced with a message rebuilt from line/column only
(the library's own message embeds the offending line's text, i.e. a live
credential, and must never reach stderr); unknown top-level and per-profile
keys survive a parse→emit round trip; writes stay mode 0600. `mcps.yaml`
likewise moves to the **yaml** package — YAML 1.2 core schema; anchors,
multi-line scalars, and flow mappings start working, while duplicate keys and
tabs, which the subset tolerated, become parse errors.)*

Profile selection precedence: `--profile <name>` flag > `PMCP_PROFILE` env var > the
file's top-level `profile` key > the name `default` (neutral on purpose — the CLI's
users are not only developers with environments). `login --profile <name>` writes
`url`+`token` into that profile alone; the top-level default is set only when the
write creates the file, and is otherwise touched only by an explicit
`profile use`. `profile add` writes the url alone and never destroys a
credential — a url change on a profile with a token warns instead of clearing.
`logout` clears the active profile's token only. Environment variables stay flat
and profile-free: `PMCP_TOKEN` and `PMCP_URL` override whatever the active
profile resolved — session or service-account tokens only (`pmcp_svc_` tokens
are rejected by every consumer surface). With a service-account key, the gateway
sugar (`call`, `get`, `describe service/…`) works within grants; `ls` and every
admin-backed command fail (`ls` is sugar over `pmcp_service_list`, and service
accounts can never hold `pmcp` grants, §8). The hub's `GET /api/whoami` route
(§8) accepts both token kinds and returns `{ principal, namespace }` — that's
how the CLI builds `/<user>/mcp/…` URLs when it holds only a service-account
key, and both fields survive into `whoami`'s human and `--json` output. `PMCP_URL`
overrides the URL and is always the **https origin** — everywhere, including the client
libraries, which derive `wss://<origin>/connect` from it.

Runtime dependencies (the §4 carve-out, amended 2026-09-01): `commander`,
`@clack/prompts`, `picocolors`, `wrap-ansi`, `smol-toml`, `yaml` — declared at
the repo root (the install the repo actually runs) and mirrored into
`cli/package.json` for the published bin, whose build type-strips without
bundling.
