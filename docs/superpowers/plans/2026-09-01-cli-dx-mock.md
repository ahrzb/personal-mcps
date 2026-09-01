# pmcp CLI DX redesign — command & output mock

Status: **for review — nothing here is implemented.** Every block below is a mock
of what the redesigned CLI would print. Approve, edit, or reject per command.
A three-lens review panel (decision fidelity, codebase grounding, agent
usability) already ran over this doc; its findings are folded in, and the
judgment calls I made doing so are listed at the end for your veto.

Decisions this mock embodies (settled 2026-09-01):

- Profiles: `pmcp profile add <name> --url …` exists; `login` accepts an optional
  profile and prompts for whatever is missing. No wizard command.
- Exploration: `ls` stays flat; a new `describe` takes **one path-style ref** —
  `service/<slug>`, `service/<slug>/<item>`, `account/<slug>` — and is
  family-agnostic (tools, prompts, resources, templates).
- `prompt` and `read` merge into a single `get <ref>` verb with the same
  path-ref rule, family-first: `get prompt/<svc>/<name>`,
  `get resource/<svc>/<uri>`. The first segment of any ref always says what
  kind of thing it names. `call` stays as-is (muscle memory).
- Breaking the existing grammar is allowed; scope is `cli/` only.
- Libraries: commander@15 + @clack/prompts + picocolors + wrap-ansi
  (plus a small hand-rolled render module on top — none of the four does
  column layout, truncation, or JSON coloring by itself).
- Minimal interactivity — the CLI must be easy for agents to drive.
- Every read gains `--json`; machine output uses wire shapes verbatim.
- `toml.ts` → smol-toml, `yaml.ts` → `yaml`; both subset parsers deleted.

---

## 1. Global behavior

- **Help everywhere, before anything else.** `pmcp` prints the grouped overview;
  every command answers `-h` with usage + one example, parsed *before* context
  resolution. (Today `pmcp tools --help` first makes a network `whoami`, then
  fails `missing service`.) `--version` exists.
- **`--json`** (boolean) on every command that emits data — reads, `login`,
  `diff`, `apply`. One JSON document on stdout, nothing else on stdout.
  **Grammar break:** on `call`/`prompt` the argument-payload flag is renamed
  `--args '{…}'`, freeing `--json` to mean output-format everywhere.
- **Exit codes** (new — today everything exits 1): `0` success · `1` any
  runtime/remote failure · `2` malformed argv only. A well-formed ref naming a
  nonexistent thing is `1` (`not_found`), not `2`. `unknown command` moves from
  1 to 2. A tool result with `isError: true` exits 1 with the result still
  printed on stdout.
- **Errors** are machine-parseable: the first line is
  `error: <code>: <message>` with a stable snake_case code
  (`not_found`, `invalid_arguments`, `unauthenticated`, `ambiguous_id`,
  `approval_required`, `remote_error`, …), followed by zero or more
  `usage:` / `hint:` lines. Lines beginning with whitespace are
  human-readable detail attached to the line above (argument tables,
  did-you-mean suggestions); agents parse column-0 prefixes only, never
  line counts. All error lines go to **stderr** (today `confirm()`'s
  refusal and the approval-required block leak to stdout — fixed). With
  `--json`, stderr instead carries one document:
  `{"error":{"code":"…","message":"…","hint":"…"}}` plus enrichment fields
  when available (`didYouMean`, `expectedArguments`).
- **Color** only on a TTY; `NO_COLOR`/`--no-color` respected. Truncation is
  TTY-only: piped output is full-width, complete, and carries no ANSI escapes.
  (Decorative glyphs — `→`, `·`, `…` — appear in both; the samples below show
  them, and stripping them per-stream would make the two renderings diverge.)
- **Prompts** (@clack) appear only in `login`/`profile add`, only on a TTY.
  Separate, pre-existing carve-out: destructive commands (`service delete`,
  `account delete`, `apply`, `profile remove`) keep their y/N confirm on a
  TTY, bypassed by `--yes`; non-TTY without `--yes` refuses on stderr, exit 1.
- **Unchanged:** profile precedence (`--profile` > `PMCP_PROFILE` > config
  default > `default`), `PMCP_URL`/`PMCP_TOKEN` overrides, config at
  `~/.config/pmcp/config.toml` (same keys, 0600 writes, parse errors report
  line numbers only — never line content), the aggregated `<slug>_<tool>` call
  form, `audit --export jsonl`.

## 2. `pmcp` (overview help)

```
pmcp — personal MCP hub CLI

Explore
  ls                          services with kind, status, and your roles
  describe <ref>              service/<slug>[/<item>] or account/<slug>

Invoke
  call <service> <tool> [key=value … | --args '{…}']
  get prompt/<service>/<name> [key=value … | --args '{…}']
  get resource/<service>/<uri>

Auth & profiles
  login [--profile <name>] [--url <origin>]
  logout · whoami
  profile add|list|use|remove

Admin
  service create|archive|unarchive|delete|disconnect|set-auth
  account list|create|delete
  approvals · approve <id> · reject <id>
  token issue|list|revoke
  connect <service> · connections · connection revoke <id>
  audit [--export jsonl]

Declarative
  diff [-f <file>] · apply [-f <file>] [--yes]

Global: --profile <name>, --json, --no-color, --version, -h
```

Wrong-but-reasonable guesses resolve as aliases instead of erroring:
`service list` → `ls`, `connection list` → `connections`,
`approval list` → `approvals`.

## 3. Profiles & auth

### `pmcp profile add`

```
$ pmcp profile add work --url https://hub.example.com
profile work → https://hub.example.com
no token yet: pmcp login --profile work
```

Re-running with a different URL updates the url and **leaves the token
untouched**, warning `token was issued by the previous origin: pmcp login
--profile work`. (No credential is ever destroyed as a side effect.)

### `pmcp profile list`

```
$ pmcp profile list
* default   https://personal-mcps.ahrzb.workers.dev   logged in
  work      https://hub.example.com                   no token
  ops       https://hub.example.com                   bootstrap only
```

`*` marks the profile actually in effect. `--json` resolves the precedence
chain for you:

```json
{
  "active": "default",
  "activeSource": "config",
  "profiles": [
    { "name": "default", "url": "https://personal-mcps.ahrzb.workers.dev", "token": true, "bootstrapSecret": false }
  ]
}
```

(`activeSource`: `"flag" | "env" | "config" | "builtin"`. Token presence as a
boolean; the value never prints.)

### `pmcp profile use` / `pmcp profile remove`

```
$ pmcp profile use work
default profile → work
```

`remove` refuses to remove the active profile without `--yes` (the CLI's one
destructive-override spelling; no `--force`).

### `pmcp login`

TTY, nothing configured — @clack fills the gaps, then today's device flow:

```
$ pmcp login
◆ Hub URL › https://personal-mcps.ahrzb.workers.dev
◇ Visit https://personal-mcps.ahrzb.workers.dev/device and enter code MHRT-JQZK
◇ Waiting for approval … done
└ Logged in as user:ahrzb (profile default)
```

`login --json` is the agent path: progress chatter goes to stderr; stdout gets
the device document immediately, then the outcome —

```json
{"verificationUri":"https://…/device","userCode":"MHRT-JQZK","expiresIn":600}
{"principal":"user:ahrzb","namespace":"ahrzb","profile":"default"}
```

Polling stops at the device code's expiry (`expiresIn`), exit 1
`login_timeout`. Non-TTY with a missing URL: `error: no_url: run pmcp login
--url https://…`, exit 1 — `no_url` is a runtime code (missing config/state),
not malformed argv, so it sits outside exit 2 with the rest of the frozen
vocabulary.

### `pmcp whoami` / `pmcp logout`

```
$ pmcp whoami
user:ahrzb @ https://personal-mcps.ahrzb.workers.dev (namespace ahrzb, profile default)
```

The wire's `principal` (`user:<name>` or `sa:<slug>`) and `namespace` both
survive — for a service-account key they differ (`sa:ci @ … (namespace
ahrzb, …)`). `--json`:
`{ "principal": "user:ahrzb", "namespace": "ahrzb", "url": "…", "profile": "default" }`.
Logged out: exit 1, `unauthenticated`, hint `pmcp login`. `logout` unchanged:
clears the active profile's token only.

## 4. Exploring

### `pmcp ls`

```
$ pmcp ls
SERVICE     KIND      STATUS    ROLES
mcp-tools   tunnel    online    all
linear      proxy     proxy     issues, comments
scratch     tunnel    offline   all       (archived)
pmcp        builtin   builtin   all
```

Kind/status show the **wire vocabulary verbatim** (`tunnel`/`proxy`/`builtin`
— the contracts/service-list.json enum; no CLI-private respelling). Colors:
online green, offline red, builtin dim, slug bold. `--json` passes the
`service_list` rows through untouched (slug, kind, status, roles, archived,
builtin, and the proxied rows' connection/endpoint fields).

### `pmcp describe <ref>`

One argument, a path-style ref: `service/<slug>`, `service/<slug>/<item>`,
`account/<slug>`. Splitting happens on the first two slashes only, so an item
that is itself a URI keeps its slashes.

### `pmcp describe service/<slug>`

Rendered from the four **gateway** list calls alone — it works with any
token, including `pmcp_sa_` keys. The kind/status/roles header line comes
from an admin read and is best-effort: when that's refused (service-account
callers), the header degrades to the bare slug and the catalog still prints.

```
$ pmcp describe service/mcp-tools
mcp-tools — tunnel, online — roles: all

tools
  duocards_query    Run a read-only SQL query against the Duocards database …
  duocards_schema   Dump the table schema of the Duocards database
  jobfeed_crawl     Crawl the configured job boards and store fresh postings
  jobfeed_feed      Return the most recent crawled job postings
  paper_fetch       Fetch a paper by URL or arXiv id and extract its text …

prompts     (none)
resources   (none)
templates   (none)

pmcp describe service/mcp-tools/<item> shows an item's full shape
```

Descriptions truncate to width on a TTY only. An offline tunneled service
prints `offline — catalog from last connection` above the listing (in
`--json`, `status != "online"` means the catalog is the last-known snapshot).

The catalog `--json` shape — family-keyed, arrays always present, schemas
inline (no per-item round trips):

```json
{
  "service": "mcp-tools", "kind": "tunnel", "status": "online",
  "roles": ["all"], "archived": false,
  "tools": [ { "name": "paper_fetch", "description": "…", "inputSchema": { "…": "…" }, "outputSchema": { "…": "…" } } ],
  "prompts": [], "resources": [], "resourceTemplates": []
}
```

(`kind`/`status`/`roles` are omitted, not faked, when the admin read was
refused.)

### `pmcp describe service/<slug>/<item>`

The item matches tools and prompts by **name**, resources by **uri**, and
templates by **uriTemplate** (names key nothing in those two families —
§20.2). Every match prints, each under its family header:

```
$ pmcp describe service/mcp-tools/paper_fetch
paper_fetch — tool on mcp-tools

  Fetch a paper by URL or arXiv id and extract its title, abstract, and full
  text when the source allows it. Large PDFs are truncated to max_pages.

arguments
  url        string    required  paper URL or arXiv id
  format     string              "text" | "markdown"   (default "markdown")
  max_pages  integer             cap on extracted pages

returns
  title      string
  abstract   string
  text       string
```

A resource leaf (`pmcp describe service/mcp-tools/file:///notes/todo.md`)
shows `uri`, `name`, `mimeType`; a template leaf its `uriTemplate`; a prompt
leaf its `arguments` list. The `arguments` table renders flat object
`inputSchema`s; nested ones render as an indented tree; anything the renderer
can't lay out falls back to raw schema — and `--json` always carries the
schemas verbatim under `matches`:

```json
{ "service": "mcp-tools", "matches": [ { "family": "tools", "name": "paper_fetch", "description": "…", "inputSchema": { "…": "…" }, "outputSchema": { "…": "…" } } ] }
```

### `pmcp describe account/<slug>`

The same verb inspects hub entities (admin-backed, so owner sessions only —
like every `account` command today):

```
$ pmcp describe account/ci
ci — service account

grants
  mcp-tools   jobfeed_*        allow
  linear      issues           approval

tokens
  tk_8a31c9d2e4f0a1b7   pmcp_sa_x9   expires 2026-10-01   last used 2026-08-30
```

Composed from the same `account_list` + `token_list` tools the admin commands
already call — sugar, zero new capability. More nouns (`token/…`,
`connection/…`, `approval/…`) can join later without grammar changes.

Missing/unknown ref:

```
error: usage: missing ref
usage: pmcp describe <service/<slug>[/<item>] | account/<slug>>
hint: pmcp ls lists your services
```

### Retired listing commands

`tools`, `prompts`, `resources` (+ `--templates`) leave the documented
surface — `describe` covers all four families. Their rows **stay in the
COMMANDS table as hidden aliases** for now: the parity suite in
`server/test/worker/contracts.test.ts` asserts those rows by name, and that
file is out of scope until D14 lands. Removing the rows (and adding
`describe`'s own row, which fronts four gateway methods) is the follow-up
amendment in §10.

## 5. Invoking

`call` keeps its shape, with one deliberate break: **`--args '{…}'` replaces
`--json '{…}'` as the payload flag** (the old spelling collided with the new
output flag). `key=value` args and the aggregated `pmcp call <slug>_<tool>`
form are untouched.

`prompt` and `read` merge into **`get <ref>`**, family-first:

```
$ pmcp get prompt/mcp-tools/daily-digest topic=ai
$ pmcp get resource/mcp-tools/file:///notes/todo.md
```

The family segment tells `get` which operation to run (`prompts/get` takes
arguments; `resources/read` doesn't). Splitting stops after the second
slash, so resource URIs keep theirs. `prompt` and `read` stay as hidden
aliases — same parity-suite constraint as the listing commands (their rows
are asserted by name in `server/test`, untouchable until D14 lands).

- Results render as colored, indented JSON on a TTY; `--json` or a pipe emits
  the same bytes plain. A result carrying `isError: true` exits 1, result
  still on stdout.
- Usage errors gain hints (no counts — hints never cost a network call):

```
$ pmcp call mcp-tools
error: usage: "mcp-tools" is not <service> <tool> or <slug>_<tool>
usage: pmcp call <service> <tool> [key=value … | --args '{…}']
hint: pmcp describe service/mcp-tools lists its tools
```

### When the arguments are wrong

Pure argv mistakes are caught locally, before any network:

```
$ pmcp call mcp-tools paper_fetch --args '{url: x}'
error: usage: --args is not valid JSON (unexpected token "u" at position 1)
hint: quote the keys: --args '{"url":"…"}'
```

```
$ pmcp get prompts/mcp-tools/daily-digest
error: usage: unknown ref type "prompts" (valid: prompt, resource)
hint: pmcp get prompt/mcp-tools/daily-digest
```

Hub-side refusals are **enriched on the error path**: after a failure the CLI
makes one best-effort catalog/schema fetch and renders what the caller should
have sent — silently skipped if that fetch itself fails, and never a
pre-flight cost on the happy path.

Unknown service (`-32001`), with a suggestion from `service_list`:

```
$ pmcp call mcptools paper_fetch url=https://arxiv.org/abs/2408.00001
error: not_found: no service "mcptools" in your namespace
  did you mean "mcp-tools"?
hint: pmcp ls lists your services
```

Unknown tool, suggestion from the catalog:

```
$ pmcp call mcp-tools paper_fetc url=…
error: not_found: no tool "paper_fetc" on mcp-tools
  did you mean "paper_fetch"?
hint: pmcp describe service/mcp-tools lists everything it serves
```

Bad arguments (`-32602`), rendered against the tool's `inputSchema`:

```
$ pmcp call mcp-tools paper_fetch ur=https://arxiv.org/abs/2408.00001
error: invalid_arguments: unknown argument "ur"
  did you mean "url"?
  paper_fetch expects
    url        string    required  paper URL or arXiv id
    format     string              "text" | "markdown"
    max_pages  integer             cap on extracted pages
hint: pmcp describe service/mcp-tools/paper_fetch
```

```
$ pmcp call mcp-tools paper_fetch format=text
error: invalid_arguments: missing required argument "url"
    url   string   required   paper URL or arXiv id
hint: pmcp describe service/mcp-tools/paper_fetch
```

```
$ pmcp call mcp-tools paper_fetch url=… max_pages=many
error: invalid_arguments: "max_pages" expects integer, got "many"
```

A `describe` leaf that matches nothing gets the same treatment, locally
cross-family:

```
$ pmcp describe service/mcp-tools/paper
error: not_found: nothing named "paper" on mcp-tools (searched tools, prompts, resources, templates)
  closest: paper_fetch (tool)
hint: pmcp describe service/mcp-tools lists everything
```

With `--json`, the enrichment rides the error document:

```json
{"error":{"code":"invalid_arguments","message":"unknown argument \"ur\"","didYouMean":"url","expectedArguments":{"type":"object","properties":{"…":"…"},"required":["url"]},"hint":"pmcp describe service/mcp-tools/paper_fetch"}}
```

## 6. Admin

Spellings unchanged; the guessable noun-verb forms exist as aliases (§2).
Every read gains `--json`; identifiers in `--json` are always **full and
unelided**. (Id-prefix resolution on the mutating verbs — `approve`, `reject`,
`token revoke`, `connection revoke` accepting any unambiguous prefix, with
`ambiguous_id` otherwise — is deferred: resolving a prefix needs a list call
the frozen parity table doesn't claim for those rows, so it lands with the
post-D14 parity amendment. Ids are sent verbatim until then; `ambiguous_id`
stays reserved in the vocabulary.) Samples:

```
$ pmcp approvals
APPROVAL                  STATUS    WHO → WHAT
ap_9f2kd8a1c33e7b02      pending   sa:ci → mcp-tools/jobfeed_crawl
                                   args {"boards":["hn"]} · expires in 9m
```

(Not just polish: today's renderer reads fields the wire doesn't send —
`principal`/`service`/`arguments` instead of `accountSlug`/`serviceSlug`/
`args` — so WHO/WHAT/args render blank right now. The redesign maps the real
fields; `sa:` is prefixed client-side.)

```
$ pmcp token list
TOKEN                     PREFIX        EXPIRES       LAST USED
tk_8a31c9d2e4f0a1b7      pmcp_sa_x9    2026-10-01    2026-08-30 14:02
```

```
$ pmcp audit --limit 3
2026-09-01 09:14  ahrzb        tools/call      mcp-tools/paper_fetch  ok
2026-09-01 09:12  sa:ci        tools/call      mcp-tools/jobfeed_feed ok
2026-09-01 08:55  ahrzb        connect.register mcp-tools             ok
3 of 1204 events match
```

(Also a fix, not polish: the wire sends epoch-ms `ts`, today's code prints a
nonexistent `at` — the timestamp column is currently blank. Event names use
the audit vocabulary verbatim: `tools/call`, `admin.<tool>`,
`connect.register`.) `audit --export jsonl` unchanged; `--json` returns the
current page as one document.

## 7. Declarative

Grammar unchanged: `diff [-f <file>]`, `apply [-f <file>] [--yes]` (default
`mcps.yaml`). Rendering gains color (`+` green, `!` red, warnings yellow).

`diff` exits 0 whenever the plan computes, **empty or not** — drift detection
is `--json` + `steps.length`. Plan errors exit 1 with the errors in the
document. `diff --json` is the planner's shape verbatim
(`plan.ts` stays pure):

```json
{ "steps": [ { "tool": "service_create", "args": { "slug": "notes" }, "summary": "create service notes", "destructive": false } ], "warnings": [], "errors": [] }
```

`apply --json` emits the same steps with per-step outcome —
`"status": "applied" | "skipped" | "failed"` plus `"error"` on failures — so
CI never parses colored prose for the result of a mutation.

`mcps.yaml` moves to the `yaml` package: anchors, multi-line scalars, flow
mappings, and multi-document files start working (comments and nesting
already did). It's also stricter — duplicate keys and tabs, which the subset
tolerated, become parse errors; `plan.parseDesired`'s value coercions get
re-checked against YAML 1.2 core schema.

## 8. Errors as the agent interface

An error block is one `error: <code>: <message>` line followed by zero or
more `usage:`/`hint:` lines, with indented detail lines attached to the line
above — parse by column-0 prefix, never by line count. The code vocabulary
is frozen; prose may be reworded, codes may not. Hub refusals get one
best-effort enrichment fetch (did-you-mean, expected arguments) on the error
path only. Discovery chain,
zero interactivity, works with a service-account token:

```
pmcp            → grouped command list
pmcp <cmd> -h   → usage + example
pmcp ls --json  → services
pmcp describe service/<slug> --json      → full catalog with schemas
pmcp call <svc> <tool> --args '{…}' --json → result
```

## 9. Disposition of the current command table

All 32 rows of `cli/src/commands.ts` (`resources --templates` is a flag on
the `resources` row, shown here separately):

| Current | Fate |
|---|---|
| `login`, `logout`, `whoami` | kept; `login` prompts on TTY + gains `--json` device flow; `whoami` keeps principal+namespace, gains `--json` |
| `ls` | kept; header/color/width-aware, builtin row stays, + `--json` (wire shapes verbatim) |
| `tools`, `prompts` (list), `resources`, `resources --templates` | **hidden aliases** (rows kept for the parity suite until D14 lands) → documented surface is `describe` |
| `call` | kept; **`--json '{…}'` → `--args '{…}'`**, colored output, `isError` → exit 1, better errors |
| `prompt` (get), `read` | **hidden aliases** (rows kept for the parity suite) → documented surface is `get <ref>` |
| `service create/archive/unarchive/delete/disconnect/set-auth` | kept; delete keeps y/N + `--yes`; reads + `--json` |
| `account list/create/delete` | kept; `account list` + `--json`; delete keeps y/N + `--yes` |
| `approvals`, `approve`, `reject` | kept; **field mapping fixed** (accountSlug/serviceSlug/args — blank today) + block rows + `--json`; id prefixes accepted |
| `token issue/list/revoke` | kept; `token list` + `--json` |
| `audit`, `audit --export jsonl` | kept; **`ts` rendered** (blank today), `--json` for the page form |
| `connect`, `connections`, `connection revoke` | kept; `connections` + `--json`; `connection list` alias |
| `diff`, `apply` | kept; `-f` unchanged, color, `diff --json` (planner shape), `apply --json` (per-step status), diff exits 0 on non-empty plan |
| — | **new**: `profile add/list/use/remove`, `describe <ref>`, `get <ref>`, `--version`, noun-verb aliases |

## 10. Dependencies and follow-ups

New runtime deps: `commander@15`, `@clack/prompts`, `picocolors`,
`wrap-ansi`, `smol-toml`, `yaml`. They go in the **root** `package.json`
(that's the install the repo performs — `cli/` is not a pnpm workspace
member and local runs resolve from the root `node_modules`) **and** are
mirrored into `cli/package.json`'s `dependencies` for the published bin —
`cli/build.mjs` type-strips without bundling, so the published `dist/`
imports them at runtime.

Deleted: `cli/src/toml.ts`, `cli/src/yaml.ts`, their test files, and their
`test-inventory.json` rows; `cli/build.mjs`'s hard-coded `FILES` map is
edited to match. The smol-toml wrapper's contract, pinned by tests:

- parse errors are caught and **replaced** — the message is rebuilt from the
  library's line/column as `config: line N is not valid TOML`; smol-toml's
  own message embeds the offending line's text (a live credential) and must
  never reach stderr;
- the emit half preserves unknown top-level and per-profile keys through a
  parse→emit round trip, and writes stay 0600.

Owed after the shape settles (out of scope now): §4/§10 spec amendments (the
CLI dependency carve-out, the new grammar, the frozen error-code vocabulary),
test-suite updates, and the parity-suite amendment in
`server/test/worker/contracts.test.ts` — retiring the hidden-alias rows
(`tools`, `prompts`, `resources`, `prompt`, `read`) and adding rows for
`describe` (fronts four gateway methods) and `get` (fronts two); the table's
one-method shape needs a widened entry or a declared exception. Waits for
D14 regardless.

## Judgment calls folded in from the review — veto any

1. `--args` replaces `--json` as the payload flag on `call`/`prompt` (the
   collision was unshippable; muscle-memory break).
2. `tools`/`prompts`/`resources` become hidden aliases rather than deleted,
   so `server/test` stays untouched until the D14 session lands.
3. Destructive y/N confirms stay (as today), `--yes` bypasses; non-TTY
   refusal moves from stdout to stderr.
4. With `--json`, errors become one JSON document on stderr.
5. `call` results with `isError: true` exit 1 (result still printed).
6. `diff` keeps exit 0 on a non-empty plan (drift via `--json`).
