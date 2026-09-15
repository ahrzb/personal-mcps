# Decide the provider repo's flake and terranix module shape

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 04

## Question

`terraform-provider-pmcp` carries its own flake exposing the provider package and the terranix
module. `terraform-provider-gws` is the template; this ticket decides where to follow it and
where to diverge.

The `gws` shape, verified:

- `buildGoModule`, `vendorHash`, `subPackages = ["."]`, `CGO_ENABLED = 0`, ldflags
- `postInstall` relocates the binary to
  `$out/libexec/terraform-providers/${sourceAddress}/${version}/${GOOS}_${GOARCH}/terraform-provider-gws_${version}`
  with `sourceAddress = "registry.opentofu.org/ahrzb/gws"`
- outputs: `packages.default`, `packages.terraform-provider-gws`, `packages.tofu`, `checks`
  (build + gotest), `overlay`, `terranixModules.gmail` and `terranixModules.default`
- devShell: go, gopls, gcc, opentofu, gofumpt
- consumed by `shed` as
  `opentofu.withPlugins (p: [ … inputs.gws-provider.packages.${operatorSystem}.default ])`

Settle:

1. **Names.** Repo `terraform-provider-pmcp`, source address `registry.opentofu.org/ahrzb/pmcp`,
   provider type `pmcp` — matching how `gws` shortens. Confirm, since the source address is
   baked into `.terraform.lock.hcl` and is painful to change later. (The registry's validator
   requires `{owner}/terraform-provider-{name}` lowercase if publication ever happens.)
2. **Module granularity.** `gws` exports one module per domain (`terranixModules.gmail`) plus a
   combined `default`. Does pmcp export one module, or several (apps / agents / grants)?
3. **Typed options.** Decided: typed with a freeform escape hatch, and using the escape hatch is
   a design smell. Settle the option namespace (`pmcp.*`), how closely options mirror the
   provider schema, and how they stay in sync — terranix has **no** provider-schema codegen
   (<https://github.com/terranix/terranix/issues/100>), so this is hand-maintained.
4. **Provider configuration in the module.** `gws`'s module emits `terraform.required_providers`,
   an empty `provider.gws = {}`, and the resources. Where does the pmcp endpoint come from —
   a module option, or env vars from the `shed` tofu wrapper as every other credential does?
5. **Credential wiring.** `shed` decrypts an operator-only `infra.env.age` and exports env before
   `exec tofu`. The admin token from ticket 01 joins `HCLOUD_TOKEN` / `GITHUB_TOKEN` /
   `TF_STATE_PASSPHRASE` there. Name the variable and write down the `shed` change, since it
   lands in a third repo.
6. **Version pinning.** `gws` hardcodes `version = "0.2.0"` in the flake and it appears in
   `.terraform.lock.hcl`. Decide the release/version discipline given there are no git tags and
   no goreleaser.
7. **Cross-repo input.** Does this flake take `personal-mcps` as an input (for the contract
   fixture from ticket 05 and the acceptance hub from ticket 09), or vendor what it needs?
   `personal-mcps` is a private repo, so `git+ssh` with `inputs.nixpkgs.follows`, as `shed` does
   for `mcp-tools` and `jobfeed`.

## Answer

[§22.7](../../../docs/specs/provider/22-opentofu-provider.md), "The provider repository" and
"The terranix module".

**(1)** `terraform-provider-pmcp`, address `registry.opentofu.org/ahrzb/pmcp`, type `pmcp` —
short, as `gws` shortens, and chosen once because it is baked into `.terraform.lock.hcl`.
**(2)** One module, since apps, agents and grants are one namespace and splitting would force
consumers to wire cross-references by hand. **(3)** Options are `pmcp.tunnelApps.<slug>`,
`pmcp.proxyApps.<slug>`, `pmcp.grants.<agent>.<app>`, `pmcp.extraConfig` — **separate trees for
tunnel and proxy rather than one tree with a `kind`**, which preserves at Nix evaluation time the
property the two resource types give at plan time: a proxy-only field on a tunneled app is
unrepresentable, not rejected later. The module owns the bare-list `roles` sugar the provider's
typed schema cannot accept. Staying in sync gets a mechanism rather than a promise —
`checks.terranix` evaluates the module against a sample config and asserts every attribute name
it emits exists in the provider schema, since terranix has no codegen
([#100](https://github.com/terranix/terranix/issues/100)). **(4)** The module emits
`provider.pmcp = {}`; the endpoint comes from the environment. **(5)** `PMCP_URL` and
`PMCP_ADMIN_TOKEN` join the operator-only `infra.env.age` and the `nix run .#tofu` wrapper's
exports beside `HCLOUD_TOKEN` and `TF_STATE_PASSPHRASE` — a change in a third repo, recorded as
such. The env name deliberately differs from the CLI's `PMCP_TOKEN` because the two hold
different credential families. **(6)** Version hardcoded (`0.1.0`), bumped by hand, no tags and
no goreleaser — `gws` is at `0.2.0` by the same discipline. **(7)** Takes `personal-mcps` as a
`git+ssh` input **for the acceptance hub only**; `coverage-check` takes its fixture as an
argument so the gate never depends on a pinned revision.

The single most load-bearing line, nearly missed: **`passthru.provider-source-address`**.
nixpkgs' `withPlugins` keys the plugin directory off that attribute, and `gws`'s own comment
explains the failure — without it tofu ignores the plugin and reaches for a registry that has
never heard of it. Also copied from `gws`: `gcc` in the devShell, needed to build cgo test
binaries even though the package sets `CGO_ENABLED = 0`.

The module emits `required_version = ">= 1.11"` for write-only attributes; `shed` pins
`">= 1.9"` and must be raised. nixos-26.05 ships OpenTofu 1.11.8, so the floor is satisfiable.
