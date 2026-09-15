{
  description = "Personal MCP hub — the `pmcp` CLI, and the toolchain the Worker is built with";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    let
      # ONE pinned pnpm, shared by the fetcher, the config hook and the devShell (§22.7). Three
      # pnpm versions resolving one lockfile is a way to get three different node_modules.
      #
      # Pinned to 10 rather than taking nixpkgs' default (11), because publish.yml's
      # `pnpm/action-setup` already pins 10: the installer that resolves this lockfile in CI and
      # the one that resolves it here should be the same major, and CI is the one that publishes.
      pnpmFor = pkgs: pkgs.pnpm_10;

      # Node 24 satisfies cli/package.json's `>=22.18` and provides native type stripping, which
      # is what lets `cli/pmcp.mts` run from source with no build step in the dev flow.
      nodeFor = pkgs: pkgs.nodejs_24;

      # Factored out of eachDefaultSystem so `overlays.default` can build it against the
      # CONSUMER's package set rather than this flake's — an overlay that pins its own nixpkgs
      # defeats the point of being an overlay.
      mkPmcp =
        pkgs:
        let
          pnpm = pnpmFor pkgs;
          nodejs = nodeFor pkgs;

          # Which `.pnpm/<id>` directories the CLI can actually reach.
          #
          # Needed because no pnpm flag prunes the virtual store: `--filter` plus `--prod`
          # plus a frozen lockfile still materialises every importer's dependencies, so a
          # naive copy shipped 583 MiB — wrangler, vitest, typescript and workerd included —
          # for a CLI that imports six packages.
          #
          # pnpm's layout makes the answer computable rather than guessable: every dependency
          # edge is a symlink from `.pnpm/<id>/node_modules/<name>` to another `.pnpm/<id>`,
          # so the runtime closure is a breadth-first walk from `cli/node_modules` over
          # realpaths, and anything unvisited is by construction unreachable at runtime.
          closureWalk = pkgs.writeText "pmcp-closure.mjs" ''
            import { readdirSync, realpathSync, existsSync } from "node:fs";
            import { join, relative, sep } from "node:path";

            const virtualStore = join(process.cwd(), "node_modules", ".pnpm");
            const reached = new Set();

            // One `node_modules` directory: each entry is a package (or an @scope holding
            // them). Following the realpath tells us which `.pnpm` entry backs it.
            function visit(dir) {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === ".bin" || entry.name === ".pnpm") continue;
                const path = join(dir, entry.name);
                if (entry.name.startsWith("@")) {
                  visit(path);
                  continue;
                }
                let real;
                try {
                  real = realpathSync(path);
                } catch {
                  continue; // a dangling workspace-sibling link; not part of the closure
                }
                const id = relative(virtualStore, real).split(sep)[0];
                if (!id || id.startsWith("..") || reached.has(id)) continue;
                reached.add(id);
                const nested = join(virtualStore, id, "node_modules");
                if (existsSync(nested)) visit(nested);
              }
            }

            visit(join(process.cwd(), "cli", "node_modules"));
            process.stdout.write([...reached].sort().join("\n") + "\n");
          '';
        in
        pkgs.stdenv.mkDerivation (final: {
          pname = "pmcp";
          # Read from the manifest rather than restated here: the CLI's version is already
          # duplicated into cli/src/main.ts (a literal, because the dist build has no JSON
          # reader) and a third spelling in Nix would be one more thing to forget.
          version = (builtins.fromJSON (builtins.readFile ./cli/package.json)).version;

          src = ./.;

          nativeBuildInputs = [
            nodejs
            # pnpm itself, explicitly: the top-level `pnpmConfigHook` does NOT propagate it the
            # way the deprecated `pnpm_10.configHook` alias did, so without this the hook fails
            # with "'pnpm' binary not found in PATH" — and installPhase calls pnpm directly too.
            pnpm
            # The hook with the pin applied, rather than the alias §22.7 names: that spelling
            # warns on every evaluation and the override is what keeps "one pnpm" true.
            (pkgs.pnpmConfigHook.override { inherit pnpm; })
            pkgs.makeWrapper
          ];

          # The whole workspace closure, to build a six-dependency CLI. Accepted deliberately:
          # filtering it would mean a second lockfile view to keep in step, and the hash has to
          # be regenerated on any lockfile edit either way.
          #
          # `fetcherVersion = 3`: version 2 is deprecated and scheduled for removal in 26.11.
          # The hash is fetcher-version-specific, so moving between them regenerates it.
          pnpmDeps = (pkgs.fetchPnpmDeps.override { inherit pnpm; }) {
            inherit (final) pname version src;
            fetcherVersion = 3;
            hash = "sha256-QxO+E40bs/9InDkyjO7BKS+qxqUz5/VTt0LkJ7+zj7E=";
          };

          # `--ignore-scripts` is the hook's default, and it is what keeps pnpm-workspace.yaml's
          # `allowBuilds` postinstalls — esbuild placing a platform binary, workerd downloading
          # the Workers runtime — from running in the sandbox. Safe only because nothing in the
          # CLI build path needs either: `cli/build.mjs` uses Node builtins and no bundler.
          buildPhase = ''
            runHook preBuild
            node cli/build.mjs
            runHook postBuild
          '';

          # Getting a self-contained CLI out of a symlinked workspace is the whole difficulty
          # here, and two obvious routes are dead ends worth naming so nobody retries them:
          #
          #   `pnpm deploy` is the documented tool and cannot run in a sandbox — even with
          #   `--offline` it re-RESOLVES the workspace, and resolution wants registry metadata
          #   the fetched store does not carry (ERR_PNPM_NO_OFFLINE_META, on a root dependency
          #   the CLI never imports).
          #
          #   `node-linker=hoisted` hoists to the WORKSPACE ROOT, so `cli/node_modules` comes
          #   out empty and the wrapper cannot resolve `commander`.
          #
          # So keep pnpm's own layout. A `--filter` + `--prod` install with a frozen lockfile
          # performs no resolution and prunes the virtual store to exactly the selected
          # importer's runtime closure — the CLI's six dependencies and their transitives, with
          # the dev toolchain (wrangler, vitest, typescript, workerd) gone. `--ignore-scripts`
          # is restated because this second install would otherwise run the `allowBuilds`
          # postinstalls that the config hook's first pass deliberately skipped.
          #
          # `cli/node_modules` is then a farm of symlinks RELATIVE to `../node_modules/.pnpm`,
          # so both halves are copied into the same relative positions and every link stays
          # valid inside the store. Copying either alone yields a tree that resolves nothing.
          installPhase = ''
            runHook preInstall

            pnpm --filter=@ahrzb/personal-mcp-cli install \
              --prod --offline --frozen-lockfile --ignore-scripts \
              --config.confirm-modules-purge=false

            # Copy the CLI's reachable closure and nothing else. `.pnpm` still holds every
            # importer's dependencies at this point — no pnpm flag prunes it — so the walk
            # decides what ships. `.pnpm/node_modules` is deliberately NOT copied: it holds
            # workspace-sibling links the CLI does not import, and their targets live outside
            # this output.
            node ${closureWalk} > reachable.txt
            echo "CLI runtime closure: $(wc -l < reachable.txt) of $(ls node_modules/.pnpm | wc -l) store entries"

            mkdir -p "$out/lib/pmcp/node_modules/.pnpm" "$out/lib/pmcp/cli"
            while read -r id; do
              cp -r "node_modules/.pnpm/$id" "$out/lib/pmcp/node_modules/.pnpm/$id"
            done < reachable.txt

            cp -r cli/dist "$out/lib/pmcp/cli/dist"
            cp -r cli/node_modules "$out/lib/pmcp/cli/node_modules"
            install -Dm644 cli/package.json "$out/lib/pmcp/cli/package.json"

            # `cli/node_modules` links every DECLARED dependency, including any that turned out
            # unreachable; and `.bin` entries point at packages we did not copy. Both arrive
            # dangling, which nixpkgs' noBrokenSymlinks check rejects. Dropping them is safe
            # because installCheckPhase then imports the real entrypoint, so a link the CLI
            # actually needed fails the build instead of shipping a tree that resolves nothing.
            find "$out/lib/pmcp" -xtype l -delete

            makeWrapper ${nodejs}/bin/node "$out/bin/pmcp" \
              --add-flags "$out/lib/pmcp/cli/dist/pmcp.mjs"

            runHook postInstall
          '';

          # The gate that makes every shortcut above safe — the closure walk, the pruned store
          # and the dangling-link sweep are each only as trustworthy as this phase — and the
          # reason `checks.pmcp` is simply this derivation.
          doInstallCheck = true;
          installCheckPhase = ''
            runHook preInstallCheck

            # Importing the entrypoint resolves EVERY static import transitively, so a
            # dependency the walk missed or the sweep deleted fails here. `--version` alone
            # would not: it exercises two of the six packages, and `yaml`, `smol-toml` and
            # `@clack/prompts` are reached only by commands that need a hub.
            node --input-type=module \
              -e "await import('$out/lib/pmcp/cli/dist/src/main.mjs')"

            # And the shipped bin must agree with the manifest it was built from.
            # `cli/src/main.ts` carries the version as a literal, because the dist build has no
            # JSON reader — so this is where a Nix build catches that drift.
            got=$("$out/bin/pmcp" --version)
            if [ "$got" != "${final.version}" ]; then
              echo "pmcp --version said '$got', cli/package.json says '${final.version}'" >&2
              exit 1
            fi
            "$out/bin/pmcp" help > /dev/null

            runHook postInstallCheck
          '';

          meta = {
            description = "CLI for a personal MCP hub — apps, agents, tokens, approvals, audit";
            homepage = "https://github.com/ahrzb/personal-mcps";
            license = pkgs.lib.licenses.mit;
            mainProgram = "pmcp";
          };
        });
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        pmcp = mkPmcp pkgs;
      in
      {
        packages = {
          inherit pmcp;
          default = pmcp;
        };

        # The build IS the check. `checks` deliberately does not run vitest: the suite needs
        # workerd, whose postinstall downloads a binary, and fighting that in a sandbox buys
        # nothing — tests stay `pnpm test` (§22.7).
        checks.pmcp = pmcp;

        # The version authority for this repo. It sits BESIDE the documented `pnpm install`
        # flow rather than replacing it, so contributors without Nix keep working; the
        # manifests and docs are corrected to match these versions, not the other way round.
        devShells.default = pkgs.mkShell {
          packages = [
            (nodeFor pkgs)
            (pnpmFor pkgs)
            pkgs.go_1_25 # clients/go
            pkgs.uv # clients/py
          ];

          # Wrangler stays an npm dependency so it matches the lockfile — a nixpkgs wrangler
          # would be a second version of the one tool whose version decides how the Worker runs.
          shellHook = ''
            echo "pmcp devShell — node $(node --version), pnpm $(pnpm --version)"
            echo "wrangler comes from the lockfile: pnpm install, then pnpm dev"
          '';
        };
      }
    )
    // {
      # Plural `overlays`, never the deprecated singular `overlay`: `shed` consumes
      # `overlays.default` and would silently miss the other spelling.
      overlays.default = final: _prev: { pmcp = mkPmcp final; };
    };
}
