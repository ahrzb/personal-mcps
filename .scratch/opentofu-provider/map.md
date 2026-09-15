# Map: OpenTofu provider for the hub

Label: `wayfinder:map`

## Destination

A spec in this repo, precise enough to build `terraform-provider-pmcp` in a new repo without
re-deciding anything: the resource and data-source model, the credential the provider
authenticates with and the hub change that creates it, the split of flake outputs across the
two repos, and the parity tripwire that makes a hub change fail CI here when it outruns the
provider.

Planning only. This map produces decisions and a spec; it builds no provider, writes no Go,
and ships no flake.

## Notes

**Domain.** MCP hub administration — apps, agents, grants, tokens — expressed as declarative
infrastructure. The hub's admin surface is exclusively MCP: 21 tools on the virtual `pmcp`
slug at `POST /<user>/mcp/pmcp`, pinned in `contracts/admin-ops.json`. There is no REST admin
API and there will not be one.

**Source of truth.** `docs/specs/**`, one file per section, cited by § throughout the code.
Wire shapes answer to `contracts/*.json`, whose governance (`contracts/README.md`) is binding:
one writer, owner-authored, always their own commit, never agent-authored.

**Skills.** `/grilling` and `/domain-modeling` on every ticket unless the ticket says otherwise.

**Standing preferences for this effort.**

- The provider is the *complete* declarative surface. `pmcp diff/apply` is the incomplete
  precursor; it is frozen, not extended.
- Two app resource types (`pmcp_tunnel_app`, `pmcp_proxy_app`) rather than one `kind`-discriminated
  type: proxy-only fields are meaningless on tunnels and the hub rejects them, so invalid
  combinations should fail at plan time.
- Grants are their own resource keyed `(agent, app)` — that is exactly `grant_set`'s lifecycle.
- The terranix module is typed, with a freeform escape hatch whose *use* is a design smell.
- Hub changes are permitted but must stay minimal.

**Precedents to follow, not re-derive.**

- `../terraform-provider-gws` — the same author's existing provider. framework v1.19.0, Go 1.25,
  address `registry.opentofu.org/ahrzb/gws`, `buildGoModule` + `postInstall` into
  `libexec/terraform-providers/${sourceAddress}/${version}/${GOOS}_${GOARCH}/`, outputs
  `packages.default` / named package / `overlay` / `terranixModules.<name>` + `default`,
  CI is `nix flake check`, every mutable attribute `RequiresReplace` with Update erroring loudly,
  thin `net/http` client with typed `APIError`/`NotFound`, unit tests against an `httptest` fake.
  Naming follows: `terraform-provider-pmcp` → `registry.opentofu.org/ahrzb/pmcp`.
- `../shed` — the consumer. NixOS on Hetzner `aarch64-linux`; operator is `x86_64-linux` under WSL.
  Plain flake, no flake-parts. Providers arrive through
  `opentofu.withPlugins (p: [ … inputs.gws-provider.packages.${operatorSystem}.default ])` — no
  `dev_overrides`, no filesystem mirror. Credentials live in an operator-only `infra.env.age`,
  decrypted by the `nix run .#tofu` wrapper and exported before `exec tofu`, alongside
  `HCLOUD_TOKEN` / `GITHUB_TOKEN` / `TF_STATE_PASSPHRASE`. `shed/docs/opentofu.md:137-140` already
  records that tofu does **not** own the personal-mcps Worker.

**Verification reality.** Development happens on Windows; Nix runs in WSL (`x86_64-linux`) and on
the NixOS host (`aarch64-linux`). Every flake ticket must state how its decision gets verified,
because the deciding session cannot evaluate a flake natively.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

The settled spec is [§22, The OpenTofu provider](../../docs/specs/provider/22-opentofu-provider.md).
The working draft and its revision history are in [design.md](design.md).

- [Design the admin token family the provider authenticates with](issues/01-admin-token-family.md) —
  a `pmcp_adm_` family in its **own `admin_token` table** with an `ON DELETE CASCADE` owner FK, not
  a third `TokenKind`; session-only issuance, fixed expiry, `adminOpsFor(principal)` enforced at
  both `listTools` and `callTool`, and per-credential audit attribution a named non-goal.
- [Decide how a token resource models an issue-once secret](issues/02-token-resource-modelling.md) —
  write-only for upstream **headers** (an input) folded into `pmcp_proxy_app` with a computed
  applied-version and a `ModifyPlan`; **`pmcp_token` manages both kinds** (owner override,
  2026-09-15), persisting the secret in state with the committed-history cost accepted and
  revocation, not passphrase rotation, as the mitigation. Managed and ad-hoc tokens coexist, and
  `pmcp_tokens` reports what is not managed.
- [Decide how the CLI becomes Nix-packageable](issues/03-cli-nix-packageability.md) — real pnpm
  workspace members, root manifest **loses** the mirrored CLI deps, `pnpm.fetchDeps` +
  `pnpmConfigHook` on a pinned `pnpm_10`, and the devShell becomes the version authority.
- [Settle the provider's resource and data-source schema](issues/04-provider-resource-schema.md) —
  five resources and two data sources with full modes and defaults; `app_get` for reads, **no**
  memoization, `roles` typed as a per-family object, `capabilities` absent ≡ `["tools"]`, `all`
  exempt from the undeclared-role check, and the hub grows `agent_update`.
- [Specify parity direction E and decide where its manifest lives](issues/05-parity-direction-e.md) —
  the oracle is the fake's **request recorder** over real CRUD, not a table and not a schema dump;
  gated from this repo via `nix run …#coverage-check`, with declared staging so a two-repo change
  can land.
- [Decide the migration path off mcps.yaml](issues/06-mcps-yaml-migration.md) — the guard is
  **removing `pmcp diff`/`apply`**, not deleting the file; three replacement CLI subcommands keep
  parity direction D total.
- [Decide this repo's flake outputs](issues/07-flake-outputs-here.md) — `flake-utils`,
  `packages.pmcp`, `overlays.default`, a devShell that owns the toolchain pins, and the repo's
  first real CI gates.
- [Decide the provider repo's flake and terranix module shape](issues/08-provider-repo-flake-and-terranix.md) —
  `gws`'s layout including `passthru.provider-source-address`; one terranix module with
  **separate tunnel and proxy option trees**, kept honest by `checks.terranix`.
- [Design the cross-repo test rig](issues/09-acceptance-test-rig.md) — fake for unit and oracle,
  real hub for acceptance, authenticated through `POST /api/auth/sign-in/username`; acceptance is
  a flake **app** and the nightly overrides the pinned hub input.
- [Decide how a tofu-issued token reaches a systemd unit on shed](issues/10-shed-token-delivery.md) —
  **the provider ships capabilities, `shed` designs the procedure.** §22.2 states what delivery
  may rely on (overlapping generations, `create_before_destroy` as a guarantee, `pmcp_tokens`
  inventory, idempotent revoke) and what it must not expect (nothing hub-side identifies which
  credential a live consumer uses; `last_used_at` is not that signal). Direction, non-binding:
  automate Proton, hand-carry `mcp-tools`.

## Not yet specified

Empty. Every patch either graduated into a ticket and was resolved, or was corrected: *read
without GET* dissolved when `app_get` turned out to exist (the map's premise was stale); *import
identity*, *retry and partial-apply*, *tunnel roles vs. grants* and *hub/provider compatibility*
were answered in §22.4; *where the spec lands* is §22. "Whether `shed`'s pinned nixpkgs ships
OpenTofu ≥ 1.11" was briefly recorded as unevaluable from Windows and was simply unread fog —
nixos-26.05 ships 1.11.8.

The owner's token reversal opened one sharp question, now resolved: the provider ships delivery
*capabilities* and `shed` designs the procedure — see
[Decide how a tofu-issued token reaches a systemd unit on shed](issues/10-shed-token-delivery.md)
in Decisions so far, and the scope ruling below.

**The frontier is empty. The map is complete.**

## Out of scope

- **OpenTofu registry publication, GPG signing, goreleaser, `tfplugindocs`.** Personal use for now;
  `gws` is consumed from a flake input and never published, and the registry requires a GitHub
  issue submission plus a maintained GPG key. The naming decision keeps the door open.
- **The broader CLI succession.** Removing `pmcp diff`/`apply` moved **into** scope during
  [ticket 06](issues/06-mcps-yaml-migration.md), because it turned out to *be* the guard against
  one `pmcp apply` wiping a tofu-managed hub — deleting `mcps.yaml` is bypassed by the error
  message's own hint. What stays out is everything beyond those two subcommands and their
  replacements: rewriting the CLI's command model, migrating profiles, or reshaping §10.
- **The delivery procedure itself.** `pmcp_token` is in scope and §22.2 now states what a delivery
  design may rely on — overlapping generations, `create_before_destroy` as a guarantee, inventory
  of the unmanaged — and what it must not expect, notably that nothing hub-side can say which
  credential a live consumer is using and that `last_used_at` is not that signal. The *procedure*
  is out: it changes `shed` and a private flake input, and a rotation design decided at the tail
  of a provider effort would be rushed. Ruled out by the owner, 2026-09-15, with
  [ticket 10](issues/10-shed-token-delivery.md) resolved as the capability contract and
  [its design](issues/10-delivery-design.md) kept as prior art for the later effort. Also out: any
  broader migration of `shed`'s secret management away from agenix.
- **Managing users.** `/internal/users` is a different protocol behind `BOOTSTRAP_SECRET`, and §9
  deliberately keeps humans imperative.
- **Approvals and inbound OAuth connections as resources.** Runtime events with no create
  operation; at most they are data sources, and that is folded into the schema ticket.
- **Nix-building the Worker deploy.** `shed` already records that tofu does not own the Worker.
