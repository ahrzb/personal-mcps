# CLI DX redesign — implementation plan

Spec of record: `docs/specs/admin-and-config/10-cli.md` (rewritten 2026-09-01).
Rendering reference with sample outputs: `docs/superpowers/plans/2026-09-01-cli-dx-mock.md`.
Both are settled and owner-approved; where this plan is silent, those two decide.

## Hard constraints (read before touching anything)

1. **Frozen paths** — another session is implementing D14 in this same working
   tree. Do not modify: `server/**`, `contracts/**`, `test-inventory.json`
   (generated; leave it), `docs/superpowers/plans/2026-09-01-d14-push.md`.
2. **`cli/src/commands.ts` is byte-frozen.** `server/test/worker/contracts.test.ts`
   imports its `COMMANDS` table and asserts rows by name; adding or removing rows
   turns a frozen suite red. New commands (`profile *`, `describe`, `get`) are
   registered in `main.ts` only, NOT in the table. Legacy spellings (`tools`,
   `prompts`, `resources`, `prompt`, `read`) keep working as hidden aliases so
   every existing row stays truthful.
3. **Deps are installed** (root `package.json`, mirrored in `cli/package.json`):
   commander 15, @clack/prompts 1.7, picocolors, wrap-ansi 10, smol-toml 1.8,
   yaml 2.9. Add nothing else.
4. The full suite must stay green: `pnpm vitest run` (projects: unit, worker,
   tunnel, cli, clients) and `pnpm typecheck`. You may edit `cli/test/**` freely;
   never `server/test/**`. CLI-only iteration: `pnpm vitest run --project cli`.
5. Windows dev box, PowerShell 5.1 (no `&&`). Node ≥22.18 runs `.mts`/`.ts`
   directly via type stripping — imports carry explicit `.ts` extensions
   (house style; `cli/build.mjs` rewrites them to `.mjs` on publish).
6. If a file already contains changes you don't remember making, they are most
   likely YOURS from earlier in this session (context summarization drops
   memories of edits). Check `git diff` before concluding someone else wrote
   them; never revert work you merely don't remember.

## Module map

New files under `cli/src/` (each also gets its row added to `cli/build.mjs`'s
`FILES` map; `toml.ts`/`yaml.ts` rows are removed when those files die):

### `cli/src/config.ts` (replaces `toml.ts` + the config half of `main.ts`)

Owns the profile store. Moves `configPath`, `readConfig`, `writeConfig`,
`activeProfile`, `profileOf`, `applyProfile` out of `main.ts` (same behavior,
same tests), parsing/emitting via **smol-toml** behind a wrapper whose pinned
contract is:

- Parse errors: catch smol-toml's `TomlError` and throw
  `new Error("config: line N is not valid TOML")` built from its line/column —
  the library message embeds the offending line's text (a live credential) and
  must never propagate.
- Unknown top-level and per-profile keys survive a parse→emit round trip.
- Writes stay `{ mode: 0o600 }`. Values are plain strings (profiles are
  `Record<string, string>`); non-string TOML values in an existing file may be
  stringified or rejected — pick one, test it.
- Legacy `~/.config/pmcp/config.json` fallback behavior is preserved verbatim.
- New: `resolveActiveProfile(flagValue?)` returns `{ name, source }` where
  source ∈ `"flag" | "env" | "config" | "builtin"` (for `profile list --json`).

### `cli/src/render.ts`

Presentation helpers, pure functions where possible:

- `styling(stream)`: picocolors instance gated on `stream.isTTY`, `NO_COLOR`,
  and the `--no-color` flag (pass a boolean in rather than reading argv here).
- `wrapText(text, width, indent)`: wrap-ansi based.
- `columnize(rows: string[][], opts)`: width-aware one-line-row columns with a
  header; truncation with `…` ONLY when the target stream is a TTY — non-TTY
  output is complete and plain (spec §10 output contract).
- `catalogLine(name, description, width, tty)`: padded name + one-line
  description (first line, truncated on TTY only).
- `schemaTable(schema)`: flat object JSON Schema → aligned
  `name / type / required / description` rows; nested schemas → indented tree;
  anything else → `JSON.stringify(schema, null, 2)`.
- `renderJson(value, colored)`: `JSON.stringify(value, null, 2)`, with light
  key/string/number coloring when `colored`.

### `cli/src/errors.ts`

The frozen error contract (spec §10 "Errors"):

- `class CliError extends Error { code: string; exitCode: 1 | 2; usage?: string;
  hints: string[]; detail: string[]; extra?: Record<string, unknown> }`
  (`extra` carries `didYouMean` / `expectedArguments` for the JSON doc).
- Codes: `usage` (exit 2), `not_found`, `invalid_arguments`, `unauthenticated`,
  `ambiguous_id`, `approval_required`, `remote_error`, `login_timeout`,
  `no_url` (exit 1). Unknown/unexpected errors map to `remote_error` or a bare
  message with exit 1.
- `emitError(err, { json, stream })`: human form — `error: <code>: <message>`,
  then indented detail lines, then `usage:` / `hint:` lines, all column-0
  prefixed except detail; JSON form — one
  `{"error":{code,message,hint?,didYouMean?,expectedArguments?}}` document.
  Both to stderr.
- `didYouMean(input, candidates)`: small Levenshtein, returns best candidate
  within distance ≤2 or undefined.

### `cli/src/main.ts` (rewrite in place)

Commander 15 program. Keep: the fetch-based MCP/admin client functions, plan
integration, device flow, all wire shapes (`ServiceRow` etc.), `COMMANDS`
re-export. Change:

- Argv layer → commander. Global options `--profile <name>`, `--json`,
  `--no-color`, `--version`, `-h`. Help (grouped as in the mock §2) and
  `--version` resolve **before** any context resolution or network call.
- All 32 legacy spellings registered; `tools`, `prompts`, `resources`,
  `prompt`, `read` as hidden (undocumented in help) aliases of the new
  surface. `service list`/`connection list`/`approval list` alias
  `ls`/`connections`/`approvals`.
- New commands per spec §10: `profile add|list|use|remove`, `describe <ref>`,
  `get <ref>`. Ref parsing: split on the first two `/` only; first segment ∈
  `service | account` (describe) / `prompt | resource` (get); unknown segment
  → `usage` error with did-you-mean.
- `describe service/<slug>`: the four gateway lists (tools/list, prompts/list,
  resources/list, resources/templates/list) — tolerate `-32601` per family
  (family prints `(none)`); kind/status/roles header from `service_list`,
  best-effort (refusal → bare slug header). `describe service/<slug>/<item>`:
  match tools+prompts by name, resources by uri, templates by uriTemplate; all
  matches print; none → `not_found` with cross-family closest suggestion.
  `describe account/<slug>`: `account_list` + `token_list` composition.
- `call`/`get`: `--args '{…}'` is the payload flag (`--json '{…}'` payload
  spelling is GONE; `--json` is output-format only). `key=value` and
  aggregated `<slug>_<tool>` forms unchanged. `isError: true` results exit 1,
  result still printed on stdout.
- `--json` output mode on every data-emitting command, wire shapes verbatim,
  full ids (mock §3–§7 shows every document shape — copy them exactly).
- Error path: all errors through `emitError`; hub refusals get ONE
  best-effort enrichment fetch (catalog or schema) — never pre-flight,
  silently skipped on failure. Mock §5 "When the arguments are wrong" is the
  rendering oracle.
- Exit codes 0/1/2 per spec. Destructive confirms (`service delete`,
  `account delete`, `apply`, `profile remove`): TTY y/N kept, `--yes`
  bypasses, non-TTY refusal goes to **stderr** exit 1.
- `login`: @clack prompts for missing url (TTY only); `--json` mode emits the
  device document then the outcome document (mock §3), chatter to stderr;
  poll deadline = device code expiry → `login_timeout`.
- `whoami`: principal + namespace in both renderings; logged-out → exit 1
  `unauthenticated`.
- `ls`: builtin row stays, wire vocabulary verbatim, header + color.
- `approvals`: map real wire fields (`accountSlug`/`serviceSlug`/`args` —
  today's code reads nonexistent fields and renders blanks). `audit`: format
  epoch-ms `ts` (today reads nonexistent `at`).
- `diff`/`apply`: `-f` flag unchanged; yaml via the `yaml` package (delete
  `cli/src/yaml.ts`); `diff --json` = planner `{steps,warnings,errors}`
  verbatim; `apply --json` = steps with per-step
  `status: applied|skipped|failed` (+`error`); diff exits 0 on a non-empty
  computed plan.

### Deletions

`cli/src/toml.ts`, `cli/src/yaml.ts`, `cli/test/toml.test.ts`,
`cli/test/yaml.test.ts`; their rows in `cli/build.mjs` `FILES` (add rows for
`config.ts`, `render.ts`, `errors.ts`).

## Tests (cli project only)

- `cli/test/config.test.ts`: keep every behavioral pin (precedence, login
  writes, logout, legacy json, 0600, profile-naming errors); port imports to
  `config.ts`; add wrapper pins: unknown-key round-trip, line-number-only
  parse errors (assert the offending line's text does NOT appear in the
  message), non-TTY behaviors.
- `cli/test/commands.test.ts`: keep the parity fixtures (every non-auth
  COMMANDS row exercised, calling exactly the ops the row claims) — update
  argv spellings where the spec changed them (`--json '{…}'` → `--args`),
  add fixtures for the new commands' op composition (describe → the gateway
  methods + best-effort service_list; get → prompts/get / resources/read;
  profile → no network at all).
- New: `cli/test/errors.test.ts` (error grammar: column-0 prefixes, codes,
  exit codes, JSON error doc, didYouMean), `cli/test/render.test.ts`
  (wrapping never shears multi-line descriptions, TTY-only truncation,
  schemaTable shapes), `cli/test/refs.test.ts` (ref splitting incl. URI
  items).
- `cli/test/plan.test.ts` untouched (planner is pure; verify `yaml`-package
  coercions feeding it still satisfy it).

## Phases

1. **Foundations** (parallel): `config.ts`, `render.ts` + `errors.ts`, each
   with tests, no `main.ts` edits, no deletions.
2. **Migration** (single agent): the `main.ts` rewrite, aliases, new
   commands, yaml swap, deletions, `build.mjs`, test updates; iterate until
   `--project cli` is green and `pnpm typecheck` passes.
3. **Verify**: full `pnpm vitest run` + typecheck; adversarial review vs spec
   §10 + the mock (including actually running local behaviors: help, usage
   errors, `--version`, ref parsing); fix; re-verify.
