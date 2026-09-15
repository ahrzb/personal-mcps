# Design: OpenTofu provider for the hub — draft 5

Becomes `docs/specs/provider/22-opentofu-provider.md` once settled.

Round 3 conceded the structural moves (separate `admin_token` table, admission-layer gate,
behavioural oracle, CLI fronts) and found five blockers in the detail. Draft 4 closes them:
secret hygiene is put back, audit attribution is abandoned as a non-goal rather than
half-plumbed, the header matrix gets a convergent state machine, the oracle witnesses fields and
paths, and the cross-repo gate gets an ordering rule that cannot deadlock.

**One question remains for the owner: D2's token scope.**

---

## D1 — The admin credential (ticket 01)

### Its own table

`token.kind` carries `CHECK (kind IN ('agent','app'))` (`0007_rename_app_agent.sql:47`), so a
migration is unavoidable; and `issueToken`'s two-key `TOKEN_PREFIX`, `referentOf`'s
non-agent-means-app assumption, `expiryFor`, and a `deleteUser` that sweeps no user-keyed tokens
would all need surgery on live credential paths.

**Migration 0009 adds `admin_token`:** `id`, `owner_id` (FK → `user`, **`ON DELETE CASCADE`** —
the orphan problem becomes structural), `hash`, `prefix`, `created_at`, `expires_at`,
`last_used_at`, `revoked_at`. Ops: `admin_token_issue`, `admin_token_list`,
`admin_token_revoke`. `TokenKind` is untouched, so `token_issue`'s schema needs no
conditionally-required `slug` that `Field.optional` and `jsonSchema`'s flat `required` array
cannot express.

- Prefix `pmcp_adm_`, plaintext once, SHA-256 at rest.
- **Issuance requires a session principal** — an admin token cannot mint a successor.
- Expiry fixed, not sliding: default 365 days, `never` permitted.

### Leaving the shared table means re-joining two hygiene mechanisms by hand

This is the cost of the separate table, and it must be paid explicitly or "plaintext once" is
false. The builtin app has `log_bodies` enabled, so an unmasked secret lands in an audit row.

1. **`admin_token_issue` declares a `writeOnly` output field** for the token value.
   `adminBackend.sensitivePaths` masks a returned secret only for ops that do, and the contract
   suite currently asserts `token_issue` is the *only* such op — that invariant and its fixture
   change with this work.
2. **`pmcp_adm_` joins the shared credential grammar.** `tokenPattern()` derives from the
   two-key `TOKEN_PREFIX` and feeds the audit and Sentry scrubbers, the gateway URI scrubber, the
   database hygiene sweep, the contract sweep, and socket hygiene. A prefix invisible to it is a
   secret that leaks everywhere those scrubbers run. So `tokenPattern()` is refactored to derive
   from a credential-prefix list — `TOKEN_PREFIX`'s values **plus** `pmcp_adm_` — while
   `TokenKind` stays two-membered. The prefix grammar and the token-kind union stop being the
   same thing, which is the actual latent coupling here.

### Restrictions are one policy consulted at two sites

`adminBackend.call` receives `ctx.principal` and discards it; every `AdminOp.handler` sees only
`ownerId`. So the containment rules cannot live in handlers. They live in a single exported
policy, `adminOpsFor(principal)`, returning the permitted op set:

- **`callTool`** checks it before `backend.call` — the op name and `ctx.principal` are both in
  scope there.
- **`listTools`** filters through it. Draft 3 said "one check, one place" and was wrong:
  `adminBackend.listTools` returns every `ops` entry, so without this an admin credential is
  *advertised* `approval_decide` and `admin_token_issue` and then refused when it calls them —
  an MCP capability contradiction and an ergonomic dead end.

An `admin` principal's set is every admin op minus `approval_decide` (a machine credential that
can approve its own pending requests defeats the human gate it administers) and
`admin_token_issue` (no self-minting).

### Audit attribution is an explicit non-goal in v1

Draft 3 promised `formatPrincipal` → `admin:<username>`. That cannot be delivered cheaply:
`summarise` runs *inside each handler* and takes only `ownerId`; the web and page fronts call the
same handlers with no backend context at all; and secondary writers reconstruct the owner
independently (`app_disconnect` → `upstream.disconnected` via `ownerPrincipal(ownerId)`,
`connection_revoke` → `oauth.revoked`). Fixing only `summarise` would attribute one admin action
to two different principals across its own rows. Doing it properly means a shared invocation
context threaded through every audit writer and both non-MCP fronts — a refactor far outside
"hub changes stay minimal".

**So admin-token actions are audited as the owner, `user:<username>`, exactly as a browser
session is.** The owner identity is correct; only *which credential* is unrecorded.
Per-credential attribution is a named gap, not an oversight, and `formatPrincipal` is untouched.

### A third principal kind is ~10 edits the compiler will not find unaided

`Principal` is a two-member union and nearly every consumer uses a binary ternary
(`p.kind === "user" ? … : <assume agent>`), so a third member silently takes the agent branch:
`identity.namespaceIdOf:388`, `namespaceNameOf:1176`, `resolveCredential:305`,
`index.visibleOnScoped:596`, `index.admitted:576`, `gateway.ts:261`, `gateway.ts:802`,
`registry.listAppsFor:864`, `resolveAccess:1250`, `principal.formatPrincipal:42`,
`principalKey:60`.

Without them the *yes* rows below do not work (`/<user>/mcp/pmcp` 404s), and the *no* rows are
enforced only by accident — the aggregate has no kind gate and refuses an admin principal solely
because a grant query binds `undefined`. Each becomes a `switch` **with a `never` arm**: the
exhaustiveness check, not the keyword, is what makes the compiler the witness. The aggregate
gains an explicit kind gate.

| Surface | Session bearer | `pmcp_adm_` |
|---|---|---|
| `POST /<user>/mcp/pmcp` | yes | yes — minus `approval_decide`, `admin_token_issue` |
| `GET /api/whoami` | yes | yes |
| `POST /<user>/mcp` (aggregate) | yes | no — explicit kind gate |
| `POST /<user>/mcp/<other-slug>` | yes | no |
| browser, `/api/auth/*`, `/connect` | yes / n/a | no |

**Not `@better-auth/api-key`:** that plugin issues session-equivalent keys carrying the full
human surface — settings, credential management, OAuth consent, TOTP reset. This is a hub-owned
table scoped to one virtual app minus two ops, refused by every better-auth route.

**Principal serialization, stated because two surfaces demand it.** Draft 4 said
`formatPrincipal` is "untouched", which is not implementable: it is a binary ternary, so a third
kind falls into the agent arm and reads a `slug` that does not exist — and `gateway.ts` calls it
directly for dispatch audit and forwarded metadata. Since owner attribution is the decision, the
admin arm returns **the owner's user spellings verbatim**: `formatPrincipal(admin)` →
`user:<username>`, `principalKey(admin)` → `user:<userId>`. An admin credential is
indistinguishable from the owner downstream, which is precisely the non-goal made concrete.

**Governance:** `contracts/admin-ops.json` (three ops + the `writeOnly` output),
`contracts/whoami.json` (a third row pinning that an admin token yields the *same* principal
spelling as a session), and the "only `token_issue` has a writeOnly output" invariant all
change — owner-authored, separate commits.

**CLI:** `pmcp admin-token issue|list|revoke`.

---

## D2 — Secrets (ticket 02)

### Upstream headers: a convergent state machine, not a bare trigger

Two attributes, because one cannot both carry the operator's intent and record what actually
reached the hub:

- `headers_wo` — write-only, readable from request **Config** during Create/Update, null in plan
  and state always.
- `headers_version` — optional integer, the operator's intent. **`headers_wo` and
  `headers_version` are strictly co-required: both or neither.** Either alone is a plan-time
  error. The version may only change while `auth = "headers"`.
- `headers_applied_version` — **computed**, the version whose `app_set_upstream_auth` actually
  succeeded.

The provider re-sends when `headers_applied_version != headers_version`, or when `auth` becomes
`headers`. The computed companion is what makes failure converge: if `app_set_upstream_auth`
fails, `headers_applied_version` stays behind, so the next plan still shows work. Retaining a
stale value is legal precisely because the attribute is computed — retaining a stale *optional*
value would trip "Provider produced inconsistent result after apply".

| Transition | Behaviour |
|---|---|
| `headers` → `headers`, versions differ | `app_set_upstream_auth`; advance `headers_applied_version` only on success. |
| `headers` → `headers`, versions equal | nothing. Out-of-band header changes stay invisible — no drift detection for this attribute, by construction. |
| `headers` → `oauth` | `app_update` only; `headers_applied_version` becomes **null**, because the update destroys the credential whose write it witnessed. `headers_wo` set while `auth = "oauth"` is rejected at plan time. App is `not_connected` until a human connects; warning says so. |
| `oauth` → `headers`, pair configured | `app_update` first (wiping the oauth bundle), then `app_set_upstream_auth`. |
| `oauth` → `headers`, pair absent | `app_update` only; `headers_applied_version` stays null. Legal, with a warning. |
| `oauth` → `oauth`, `headers_version` changed | unreachable — the pair is co-required and rejected under `auth = "oauth"`, so the attribute cannot be set in this mode at all. |
| Create, `auth = "headers"`, pair configured | `app_create` then `app_set_upstream_auth`. |
| Create with neither attribute | legal — app exists without credentials — with a warning. Adding headers later means adding **both** attributes, which is a diff by construction. |

Co-requirement is what removes draft 4's contradiction: `{ auth = "headers", headers_version = 1 }`
with no secret is no longer a reachable configuration, so the "mismatch means re-send" rule and
the "no secret is legal" row can never both apply to the same plan.

Write-only needs **OpenTofu ≥ 1.11**; the terranix module emits `required_version = ">= 1.11"`
and `shed/infra/default.nix:13` pins `">= 1.9"` today and must be raised.

### `pmcp_token` — excluded, pending owner sign-off

**For exclusion:** `shed` commits its state file to git, AES-GCM encrypted under one passphrase,
so every token ever minted would persist as ciphertext in history — rotation re-encrypts the tip,
not one historical commit. §9 already excluded secrets from declarative config for this reason.
OpenTofu offers nothing that both mints durably and avoids persistence: write-only cannot carry a
returned value; ephemeral resources orphan a token per run. In `shed`, agent keys already flow
through agenix.

**Against:** the destination commissioned a provider covering apps, agents, grants **and
tokens**, and the owner approved that cut. Excluding them makes the API contingent on one
consumer's repository practice and leaves a remote-state user unable to manage an object the
provider exists for.

**Proceeding with tokens excluded, recorded as a scope ruling rather than a "v1" deferral — and
flagged for the owner to confirm or overrule.** If overruled, `pmcp_token` returns as a
state-persisting resource with `TF_ENCRYPTION` mandatory and a documented warning that committed
state preserves ciphertext permanently.

**No ephemeral resources** either way, which keeps OpenTofu's `ExpectNonEmptyPlan` divergence out
of D9.

---

## D3 — Making the CLI packageable (ticket 03)

- `pnpm-workspace.yaml` gains `packages: [cli, clients/js]`; `server/` gets no manifest (Wrangler
  builds from root) and §4/§17 are corrected rather than describing a workspace that never existed.
- **Root loses the mirrored CLI dependencies** — the fork draft 1 walked past. Two manifests
  declaring the same deps drift, with npm and Nix resolving from `cli/` and local `pnpm pmcp`
  from root. After the change pnpm gives `cli/` its own `node_modules` and `pnpm pmcp` resolves
  upward. Verification: `pnpm install && pnpm pmcp --version`. **The closure is five packages,
  not six, once D6 lands** — `yaml` is imported only at `main.ts:29`.
- README's `npm install -g github:ahrzb/personal-mcps` is removed (the root has no `bin` and no
  `prepare`, so it installs nothing runnable) in favour of `@ahrzb/personal-mcp-cli`.
- `stdenv.mkDerivation` + `pnpm.fetchDeps` + `pnpmConfigHook`, one pinned `pnpm_10` across
  fetcher, hook and devShell; build `node cli/build.mjs`; install `dist`, pruned store, and a
  `bin/pmcp` wrapper. `fetchDeps` pulls the whole workspace closure to build a five-package CLI —
  accepted; `--ignore-scripts` keeps the `allowBuilds` postinstalls from running, which is safe
  only because nothing in the CLI build path needs esbuild or workerd.
- **The devShell is the authority** for Node, pnpm, Go and Python versions.

---

## D4 — Provider schema (ticket 04)

Draft 3 listed attribute names; that is an inventory, not a schema. Full form, since "precise
enough to build without re-deciding anything" is the destination:

### `pmcp_tunnel_app`

| Attribute | Type | Mode | Notes |
|---|---|---|---|
| `slug` | string | required, `RequiresReplace` | `[a-z0-9-]+`; `pmcp` refused |
| `name` | string | optional, computed | hub defaults to slug |
| `description` | string | optional | default `""` |
| `archived` | bool | optional | default `false`; fires `app_archive`/`app_unarchive`, **not** `app_update` |
| `redact` / `redact_results` | map(list(string)) | **optional + computed** | anchored regex keys, must compile; see collection semantics below |
| `log_bodies` | bool | optional | **default `true`** for tunnel |

### `pmcp_proxy_app`

The above (with `log_bodies` **default `false`**) plus:

| Attribute | Type | Mode | Notes |
|---|---|---|---|
| `endpoint` | string | **required** | |
| `auth` | string | optional | `headers`\|`oauth`, default `headers` |
| `forward_identity` | bool | optional | default `false` |
| `roles` | map(role) | **optional + computed** | bare list ≡ `{tools=[…]}`; ≤64 patterns, ≤128 chars |
| `capabilities` | set(string) | optional + computed | absent ≡ `[tools]`; `Set` so order never diffs |
| `headers_wo` | map(string) | optional, **write-only**, sensitive | co-required with `headers_version`; see D2 |
| `headers_version` | number | optional | co-required with `headers_wo` |
| `headers_applied_version` | number | **computed** | convergence witness |

### `pmcp_agent`

`slug` (required, `RequiresReplace`), `name` (optional, computed), `description` (optional).
No attribute forces replacement except `slug`, **because the hub grows `agent_update`** —
verified: no such op exists, and `agent_delete` cascades `deleteTokensForStatement` and
`deleteAgentStatement` in one batch, so a display-name typo would otherwise silently revoke every
live credential for that agent.

### `pmcp_grant`

`agent`, `app` (required, `RequiresReplace`); `allow`, `approval` (optional sets of string, at
least one non-empty, `allow ∩ approval = ∅`). Create and Update are both `grant_set`; Delete is
`grant_set {roles: []}`. A grant naming an undeclared role is a **warning** on a tunneled app
(roles arrive at connect time) and an **error** on a proxy app (roles live in the same config).

### Server-defaulted collections

`redact`, `redact_results`, `roles` and `capabilities` are **Optional + Computed**, not plain
optional. The hub stores and returns concrete empty collections for all of them, so a plain
optional attribute would force the provider to choose between writing a value into a
configured-null attribute (a plan-consistency violation) and hiding real remote state. With
Optional + Computed, an omitted attribute takes whatever the hub reports, and an explicitly
empty one (`{}` / `[]`) is a real instruction to clear. The one asymmetry to document: once
omitted, an attribute cannot later be distinguished from an empty one, so clearing a populated
`redact` map requires writing `{}` rather than deleting the block.

### Lifecycle rules, all resources

- **Import IDs:** apps and agents by `slug`; grants by `<agent>/<app>` — unambiguous under the
  slug grammar. `headers_wo`/`headers_applied_version` are unavailable on import; the first
  subsequent apply re-sends if a version is configured.
- **Missing on Read** → `RemoveResource`, via the client's typed `NotFound`. Reads use `app_get`
  (it exists); agents and grants read through `agent_list`, skipping the builtin `pmcp` row.
- **Delete is idempotent:** a `NotFound` on delete succeeds.
- **No memoization.** There is no plan/apply boundary a provider can observe, and the framework
  serves RPCs concurrently against one instance — a lazily-filled shared map is both
  stale-by-construction and a data race.
- **Partial apply:** OpenTofu persists the state a provider *returns* from
  `ApplyResourceChange`, including alongside an error diagnostic — it does not snapshot after
  each remote call. So the provider updates response state after each successful RPC and returns
  it with any later error; if the process dies before returning, the hub has changed and tofu
  holds no snapshot. Multi-RPC resources order least-destructive first. The 30-second budget and
  at-most-once delivery mean a 30s client timeout and retries **only** on connection errors
  raised before the request was sent.
- **Compatibility:** no pinned wire revision; unknown response fields ignored; `-32601` reported
  as an actionable error naming the hub change required.
- **Toolchain:** framework v1.19.0, protocol 6, Go 1.25 — matching `gws`.

**Data sources.** `pmcp_app` and `pmcp_agent`, singular, by slug — and their outputs are
enumerated, not implied. `pmcp_app` returns every `app_get` field: `slug`, `kind`, `name`,
`description`, `archived`, `log_bodies`, `redact`, `redact_results`, and for proxied apps
`endpoint`, `auth`, `forward_identity`, `roles`, `capabilities`. It carries **no** header
attributes — the hub never returns them. A `pmcp_app` lookup of the builtin `pmcp` slug is an
error, not an empty result. `pmcp_agent` returns `slug`, `name`, `description`, `created_at`,
and `grants` as a map of app slug to the `{allow, approval}` pair, normalized exactly as
`pmcp_grant` normalizes. Neither data source has a plural form: listing is what the terranix
module's own option set is for.

No audit data source — an unbounded newest-first log would bake a stale page into state.

---

## D5 — The parity oracle (ticket 05)

A hand-written table was its own oracle; `tofu providers schema -json` cannot see which op a CRUD
path calls. **The oracle is the `httptest` fake's request recorder, driving real
Create/Read/Update/Delete through the framework's test harness** — the pattern this repo already
used to fix direction D, where `cli/test/commands.test.ts` drives real `main(argv)`.

Draft 3's version recorded only op *names*, which is too weak: a union of names survives swapping
`app_update` into Delete and `app_delete` into Update, and it silently dropped the "every op
**and every op input field**" requirement. So the recorder captures **`(resource, action, op,
argument field names)`** and the assertion is threefold:

1. **Per-path:** each resource/action's recorded op sequence equals its declared expectation.
   A union of names would survive swapping `app_update` into Delete and `app_delete` into
   Update; a per-path sequence does not.
2. **Field coverage — every input field, not only the required ones.** Draft 4 checked
   `required` only, which leaves the likeliest evolution unguarded: `app_update`'s useful
   controls are predominantly *optional*, so a new optional hub control, or an existing one
   accidentally dropped from every provider path, would keep all gates green. Every field of
   every op must appear in some recorded call or carry an explicit `unmanaged` exclusion with a
   reason.
3. **Totality:** every op appears, or sits in the same `unmanaged` list.

The fake **validates requests against `admin-ops.json`'s `inputSchemas`** rather than accepting
anything, so it cannot drift into accepting what the real `parseInput` would reject.

### Gating here, without a deadlock

Draft 2's `repository_dispatch` was ceremony — a `204` fire-and-forget the hub workflow cannot
fail on, evaluating a stale pin, needing cross-repo credentials. Draft 3 replaced it with
`nix run github:ahrzb/terraform-provider-pmcp#coverage-check -- ./contracts/admin-ops.json` in
this repo's CI, which does gate here with no circular flake input.

But that created an **atomic-release deadlock**: land the hub first and its CI calls a provider
that lacks the new path; land the provider first and its own totality check runs against the old
fixture. Neither side can go first.

**The ordering rule: the provider always leads, and the check is asymmetric —** an op or field
the *provider* handles that the fixture lacks is allowed; one the *fixture* has that the
provider lacks fails.

**But asymmetry alone is not enough, because the fake validates against the fixture.** A
provider-ahead op has no schema there, and a provider-ahead argument is rejected outright since
every op schema sets `additionalProperties: false` — so validation fails before the asymmetric
comparison ever runs, and the deadlock returns. Blanket-exempting unknown ops and fields would
make a typo indistinguishable from intentional staging, gutting the tripwire exactly where it
matters.

**So staging is declared.** The provider repo carries a `staged` list naming each op and field
it supports ahead of the fixture, with the reason. Validation is skipped **only** for declared
staged entries; anything else unknown still fails, so a misspelled op or argument is caught. And
a staged entry the fixture has since caught up to **fails the check until it is removed** —
staging cannot silently become permanent.

The sequence is then: provider ships support with a `staged` entry → green; the hub's fixture
and implementation land as their two owner-authored commits → green; the provider drops the
staged entry → green. Three landings, none blocked, and no window where the gate is blind.

**Documentation duty:** §22 is the provider's home; `contracts/README.md` records the new
direction and direction C's retirement; §8 gains a pointer. `admin-ops.json` finally gets a
consumer, closing a gap `contracts/README.md` records today.

---

## D6 — Retiring the planner (ticket 06)

**`pmcp diff`, `pmcp apply` and `cli/src/plan.ts` are removed.** Deleting `mcps.yaml` was never a
guard: the missing-file error is a `usage` error whose own hint teaches the `-f` bypass, git
restores the file, and D3/D7 simultaneously put `pmcp` on every PATH.

**Direction D survives by closing a gap the planner was hiding.** `apply` is the only CLI row
reaching `app_update` and `grant_set`, the new `agent_update` has no front either, and the
reverse-direction test permits no exceptions — so three ops would be unreachable. The CLI gains:

- `pmcp app update <slug> [--name <s>] [--description <s>] [--endpoint <url>] [--auth headers|oauth] [--forward-identity <bool>] [--log-bodies <bool>]` — a **partial patch**: only flags actually passed are sent, so an omitted flag is *unchanged*, never "clear". Clearing a string field is `--description ""`; there is no unset, matching `app_update`.
- `pmcp agent update <slug> [--name <s>] [--description <s>]` — same semantics.
- `pmcp grant set <agent> <app> [--allow <role>]… [--approval <role>]…` — **full replacement**, matching `grant_set`. Because replacement silently drops omitted roles it is guarded in both directions: on a TTY it prints the resulting role set and asks for confirmation; **without a TTY it refuses outright unless `--yes`**, so a piped or CI invocation is never *less* protected than an interactive operator. Passing neither flag clears all roles and is refused without `--yes` either way.

All three honour `--json`. Specifying argv matters: direction D goes green as soon as each row
names an op, so a set-equality test would happily accept unusable or destructive commands.

**Blast radius, honestly** (draft 2 called this "two subcommands and a pure module"):
`cli/src/main.ts` (planner imports, YAML I/O, diff/apply render and execute; `yaml` leaves the
closure) · `cli/test/commands.test.ts` (surgery, not deletion) · `server/test/worker/contracts.test.ts`
(planner types and constants, plus role/capability locks *outside* direction C) · the
`planner-rows` fixture family and direction C both retire, changing `contracts/README.md`'s family
table and parity section · `test-inventory.json` regenerates · docs promising YAML diff/apply:
`README.md:35-36`, the quickstart, `docs/specs/README.md`, §8, **§9 entirely**, §10, the overview,
repo layout, testing docs, decision log.

Still smaller than the full CLI succession the map ruled out, and load-bearing rather than
optional — but no longer pretending to be local.

- **The prune asymmetry stands:** OpenTofu destroys only what is in state; `pmcp apply` deletes
  everything absent from the file.
- **No `pmcp export`** — the live config is one app and two agents. Round-trip is an acceptance
  criterion on §22 instead: every YAML grammar element has a schema home.
- **Adoption is `import` blocks**; config lands in `shed/infra/pmcp.nix` under `pmcp.*`.
- **Ownership boundary:** the provider manages hub contents; Wrangler owns the Worker.

---

## D7 — This repo's flake (ticket 07)

- `flake-utils.lib.eachDefaultSystem`, matching `gws` — which does use flake-utils, and therefore
  builds darwin too. (`shed` hardcodes its systems; the repos disagree and `gws` is the analogue.)
- Outputs: `packages.<sys>.pmcp` / `.default`, **`overlays.default`** (singular `overlay` is the
  deprecated spelling `shed`'s consumption would miss), `devShells.<sys>.default`,
  `checks.<sys>.pmcp`.
- **`checks` does not run vitest** — it needs `workerd`, and fighting that in a sandbox buys
  nothing. Tests stay `pnpm test`.
- devShell: shared Node, `pnpm_10`, `go_1_25`, `uv`; wrangler stays an npm dependency.
- CI gains `nix flake check` **and** the D5 `coverage-check` invocation — the first real gates in
  a repo whose only workflow publishes on push and runs nothing.
- `shed` consumes `packages.x86_64-linux.pmcp` operator-side. Builds from source, not the tarball.

---

## D8 — Provider repo flake and terranix module (ticket 08)

- Repo `terraform-provider-pmcp`; address `registry.opentofu.org/ahrzb/pmcp`; type `pmcp`.
- `buildGoModule`, `vendorHash`, `subPackages = ["."]`, `CGO_ENABLED = 0`, `postInstall` into
  `$out/libexec/terraform-providers/${sourceAddress}/${version}/${GOOS}_${GOARCH}/terraform-provider-pmcp_${version}`.
- **`passthru.provider-source-address = sourceAddress`** — nixpkgs' `withPlugins` keys the plugin
  directory off it; without it tofu ignores the plugin and reaches for a registry that never
  heard of it.
- Outputs: `packages.default`, `packages.terraform-provider-pmcp`, `packages.tofu`,
  `overlays.default`, `checks.build`, `checks.gotest` (`overrideAttrs { doCheck = true; }` —
  unit tests only), **`apps.coverage-check`**, **`apps.acceptance`**, `terranixModules.pmcp` +
  `.default`. devShell carries **`gcc`** — `gws` needs it for cgo test binaries despite
  `CGO_ENABLED = 0` — plus go, gopls, opentofu, gofumpt.
- **Acceptance is an app, not a check**, because it must boot a Worker and reach it over the
  loopback — `nix flake check`'s sandbox cannot. `apps.acceptance` starts the rig and runs
  `TF_ACC=1 TF_ACC_TERRAFORM_PATH=$(command -v tofu) go test ./... -run '^TestAcc'`. Draft 4's
  nightly was inert: `checks.gotest` sets no `TF_ACC`, so every acceptance test would have
  skipped and the nightly would have stayed green through any amount of behavioural drift.
- **One terranix module**: apps, agents and grants are one namespace. Options `pmcp.apps.<slug>`,
  `pmcp.agents.<slug>`, `pmcp.grants`, plus `pmcp.extraConfig` — typed and hand-maintained, since
  terranix has no schema codegen ([issue #100](https://github.com/terranix/terranix/issues/100));
  reaching for the hatch signals the typed layer is behind.
- Emits `required_version = ">= 1.11"`; **`shed` must raise its `">= 1.9"`**.
- **Credentials from the environment:** `provider.pmcp = {}`; `PMCP_URL` and `PMCP_ADMIN_TOKEN`
  join `infra.env.age` and the `nix run .#tofu` wrapper's exports beside `HCLOUD_TOKEN` and
  `TF_STATE_PASSPHRASE`. A third-repo change, recorded as such.
- Version hardcoded (`0.1.0`), bumped by hand — `gws` is at `0.2.0` by the same discipline.
- Takes `personal-mcps` as a `git+ssh` input with `inputs.nixpkgs.follows` **for the acceptance
  hub only**; `coverage-check` takes its fixture as an argument so the gate never depends on a
  pinned revision.

---

## D9 — The test rig (ticket 09)

**Unit:** the `httptest` fake plus pure model-conversion tests (null-vs-empty, role
canonicalization, `capabilities` set equality) — where perpetual-diff bugs live. The fake's
recorder is D5's oracle and its schema validation is what keeps it honest.

**Acceptance:** what a fake cannot model — reserved-slug refusal, the agent delete cascade,
`grant_set` replace semantics, `archived` firing a different RPC, the auth-flip wipe matrix, the
401 shapes.

**Authentication.** D1 forbids machine-minted admin tokens, so the rig signs in — but **not** via
`POST /login/sign-in/username`, which is the HTML form route (`web.ts` reads `formData()`,
answers `302` + `Set-Cookie`). The API is better-auth's own mount,
**`POST /api/auth/sign-in/username`** with a JSON body, returning the session token in the
**`set-auth-token`** header: no CSRF (login routes sit outside `mutation()`), same-origin is
if-present-must-match so an absent `Origin` passes, and `callAuthResponse` exists precisely
because sign-in arrives without a cookie. `/internal/users` with a test `BOOTSTRAP_SECRET`
creates the user. **Precondition: the rig's user never enrols TOTP** — two-factor turns sign-in
into a `twoFactorRedirect` with no session. The rig then exercises admin-token issuance end to
end.

- Harness: the `personal-mcps` flake input provides the Worker; `wrangler dev` local mode over a
  temporary D1 with migrations applied.
- `TF_ACC=1`, `TF_ACC_TERRAFORM_PATH` at the nixpkgs `opentofu`. No ephemeral resources, so
  OpenTofu's `ExpectNonEmptyPlan` divergence never arises.

**What each gate catches, and what none does.** `coverage-check` runs on every push in both
repos and from this repo's CI: it catches *surface* drift — an op or field with no provider
path. It cannot catch *behavioural* drift; the hub can keep `admin-ops.json` byte-identical and
change response semantics, ordering, or auth rejection.

Acceptance catches that, and it must actually run. The nightly workflow is
`nix run .#acceptance --override-input personal-mcps github:ahrzb/personal-mcps/master`, and it
records the resolved hub revision in its output. Both halves matter: without `apps.acceptance`
the tests skip for want of `TF_ACC`, and without the override an ordinary flake evaluation
re-tests yesterday's lock forever. With both, behavioural drift surfaces within a day rather
than at hub-commit time — the accepted limit, written down rather than implied.

---

## Open items answered

Import IDs (`slug`, `<agent>/<app>`) · headers die with the app · audit attribution is a named
non-goal; actions log as `user:<username>` · partial apply stated per OpenTofu's real persistence
boundary · no pinned wire revision · root manifest loses the CLI deps, closure of five ·
oracle records `(resource, action, op, fields)` and validates against `inputSchemas` ·
provider-leads ordering rule · tofu `>= 1.11` · admin credential in its own table, rejoined to
both hygiene mechanisms by hand · `adminOpsFor(principal)` consulted by both `listTools` and
`callTool` · nightly overrides the pinned hub input.

## Still undecided

- **Token scope** — owner sign-off (D2).
- Whether `shed`'s pinned nixpkgs ships OpenTofu ≥ 1.11. Not evaluable from Windows.
- Per-credential audit attribution — deliberately deferred, see D1.
