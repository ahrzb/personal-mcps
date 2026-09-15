# Decide this repo's flake outputs

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 03

## Question

This repo has no Nix at all — none in the tree, none in history. It gains a flake exposing the
`pmcp` CLI and a devShell that becomes the single source of truth for the toolchain.

Settle:

1. **Output set.** `packages.<system>.pmcp`, presumably `packages.<system>.default`, an
   `overlays.default`, and `devShells.<system>.default`. `gws` exports `packages.default` plus a
   named package plus an overlay; follow that unless there's a reason not to.
2. **Systems.** `shed` exposes operator outputs only at `x86_64-linux` and the host at
   `aarch64-linux`. Node runs anywhere, so the CLI *could* cover more. Does this flake enumerate
   systems by hand (plain flake, as `shed` and `gws` both do — no flake-parts, no flake-utils) or
   adopt a helper? The precedent is plain.
3. **devShell contents.** Node (pinned to match `cli/package.json` engines), pnpm 10, wrangler,
   Go 1.25 for `clients/go`, uv for `clients/py`, plus whatever the vitest Workers pool needs
   (`workerd` has a postinstall build that `pnpm-workspace.yaml` currently allows — check it
   survives a Nix sandbox). Does the devShell replace the documented `pnpm install` flow, or sit
   beside it for people without Nix?
4. **`nix flake check`.** `gws`'s entire CI is `nix flake check` + build. Does this repo's flake
   get checks, and do they overlap or conflict with the existing vitest suite and the
   publish-only GitHub workflow? Note CI here currently runs **no** tests at all — only npm/PyPI
   publication on push to master — so a flake check would be the first real CI gate.
5. **Consumption from `shed`.** `shed` already imports private repos over `git+ssh` with
   `inputs.nixpkgs.follows`. Would `pmcp` be installed on the host, used only by the operator, or
   both? The host already runs the `mcp-tools` NixOS module with an agenix `EnvironmentFile`.
6. **Relationship to npm.** `@ahrzb/personal-mcp-cli` is published to npm from
   `.github/workflows/publish.yml`. Does the flake build from the repo source, or consume the
   published tarball? Source keeps them in lockstep; the tarball is simpler but lags.

Verification: state how the decision is checked given the deciding session is on Windows —
`nix flake check` under WSL `x86_64-linux`, or in CI.

## Answer

[§22.7](../../../docs/specs/provider/22-opentofu-provider.md), "This repository".

**(1)** `packages.<sys>.pmcp` and `.default`, `overlays.default`, `devShells.<sys>.default`,
`checks.<sys>.pmcp`. Note `overlays.default`, not the deprecated singular `overlay` — `gws`
emits the plural and `shed`'s consumption depends on it. **(2)** `flake-utils.lib.eachDefaultSystem`,
matching `gws`, which *does* use flake-utils (an earlier draft claimed neither neighbour did;
only `shed` hardcodes its systems). That also means darwin builds, contradicting the earlier
"no darwin anywhere". **(3)** devShell carries `nodejs_24`, `pnpm_10`, `go_1_25`, `uv`; wrangler
stays an npm dependency so it matches the lockfile. It sits **beside** the documented
`pnpm install` flow, not replacing it, so contributors without Nix keep working — and it is the
version authority the manifests and docs are corrected to. **(4)** `checks` does **not** run
vitest: the suite needs `workerd`, and fighting that in a Nix sandbox buys nothing. CI gains
`nix flake check` plus the ticket-05 `coverage-check` invocation — the first real gates in a repo
whose only workflow publishes on push and runs no tests. **(5)** `shed` consumes
`packages.x86_64-linux.pmcp` operator-side; the host runs the hub's clients, not the CLI.
**(6)** Builds from source, not the published tarball, so the two cannot skew.

Verification, since the deciding session is on Windows: `nix flake check` and
`nix run .#pmcp -- --version` under WSL (`x86_64-linux`) and again in CI.
