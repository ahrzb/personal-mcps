# Decide the migration path off mcps.yaml

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 04

## Question

Deleting `pmcp diff/apply` is a follow-on effort, but the **migration path is decided here**,
because a generated configuration must round-trip everything the YAML can express — which
constrains the resource model.

The real migration is small and known: `mcps.yaml` currently declares one app (`mcp-tools`,
tunnel, `log_bodies: true`) and two agents (`claude`, `pi`) each granted `mcp-tools: [all]`. The
destination is `shed`, which already imports `personal-mcps`-adjacent infrastructure and consumes
`inputs.gws-provider.terranixModules.gmail` the same way it would consume this one.

Settle:

1. **Is there tooling at all?** Given the config is four objects, a `pmcp export --format hcl`
   may be pure ceremony. But "can the provider express everything the YAML can" is a real
   acceptance test for the schema, whether or not a converter ships.
2. **Round-trip coverage.** Walk the YAML grammar against the schema from ticket 04 and name
   anything that cannot survive the trip: per-family proxy roles, `capabilities` with
   absent ≡ `[tools]`, `redact` / `redact_results` regex maps, `archived`, the `role:approval`
   suffix, `all`. Each gap is either a schema change or a documented loss.
3. **Adoption without destruction.** The provider arrives at a hub with existing objects. Does
   adoption mean `import` blocks per object, or creating from scratch against an empty hub? This
   matters because both planners **prune unmanaged objects** — pointing tofu at a live hub with
   a partial config deletes the rest.
4. **The double-pruner hazard.** Until `diff/apply` is deleted, both can prune the same
   namespace. Does the spec forbid running both, or is there a mechanical guard?
5. **Where the config lands in `shed`.** `shed/infra/` is freeform attrsets today
   (`infra/gmail.nix` just sets `gws.gmail.filters`). The pmcp module should follow the same
   consumer shape. Confirm the attribute namespace (`pmcp.*`?) and which file owns it.
6. **Ownership boundary.** `shed/docs/opentofu.md:137-140` explicitly records that tofu does not
   own the personal-mcps Worker. The new module manages hub *contents* while Wrangler still owns
   the deployment — that boundary needs restating in both repos so it is not eroded later.

## Answer

[§22.6](../../../docs/specs/provider/22-opentofu-provider.md).

**(1)** No `pmcp export` — the live config is one app and two agents. **(2)** The grammar walk
was done rather than deferred, and it found one real gap: `all` must be exempt from the
undeclared-role check on proxy apps as well as tunneled ones (`plan.ts:646`), or the very config
being migrated is rejected. Everything else maps: `kind` → two resource types; `archived`,
`redact`, `redact_results`, `log_bodies`, `endpoint`, `auth`, `forward_identity`, `capabilities`
→ attributes; per-family and bare-list `roles` → the typed object plus terranix normalization;
`role:approval` → the `approval` set. Upstream credentials, which §9 explicitly excluded, are now
covered by §22.2. **(3)** Adoption is `import` blocks. **(4)** See below. **(5)**
`shed/infra/pmcp.nix`, `pmcp.*` namespace, mirroring how `infra/gmail.nix` sets
`gws.gmail.filters`. **(6)** The boundary is restated in §22.6 here and beside the existing line
in `shed/docs/opentofu.md`.

**On (4), the guard — this is where the answer changed.** Deleting `mcps.yaml` is not a guard:
the missing-file error is a `usage` error whose own hint teaches the `-f` bypass, the file is
**untracked** so deleting it removes nothing authoritative — the realistic accident is a stale
working copy that still has one — and tickets 03/07 simultaneously put `pmcp` on every operator
PATH. So `pmcp diff`,
`pmcp apply` and `cli/src/plan.ts` are **removed**. The prune asymmetry makes this load-bearing:
OpenTofu destroys only what is in its state, while one `pmcp apply` deletes everything absent
from the file — a single invocation wipes a tofu-managed hub.

That forced a second decision. Direction D permits no exceptions, and `apply` is the only CLI row
reaching `app_update` and `grant_set`, with the new `agent_update` unreachable too — so the CLI
gains `pmcp app update`, `pmcp agent update` and `pmcp grant set`, with full argv contracts
(partial-patch vs full-replacement, paired `--flag`/`--no-flag` booleans, and a `grant set` that
refuses without a TTY unless `--yes`). This is a gap the planner was hiding, not new scope.

**This exceeds the map's ruling that CLI removal is a follow-on effort**, and the map's Out of
scope section is amended accordingly: removal of the two subcommands is in scope *because it is
the guard*; the broader CLI succession is not. The blast radius is enumerated in §22.6 —
including §9's deletion, the `planner-rows` fixture family, direction C's retirement, and `yaml`
leaving the CLI's dependency closure.
