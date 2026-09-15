# Design the cross-repo test rig

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 08

## Question

Direction E (ticket 05) proves the provider's *surface* covers the hub's ops. It proves nothing
about behaviour. This ticket decides what actually exercises the provider against a hub.

The tension is between two established cultures:

- **`gws` does no acceptance testing.** Unit tests only: an `httptest` fake for the client, pure
  model-conversion tests for the resource. No `TF_ACC`, no `TF_ACC_TERRAFORM_PATH`, no OpenTofu
  in the loop. CI is `nix flake check`.
- **`personal-mcps` has a serious testing culture** — a multi-project vitest setup including a
  real-tunnel project, cross-language contract fixtures with three consumer suites, a generated
  `test-inventory.json`, and a written strategy in `docs/specs/testing/**` with rules about who
  authors what.

Settle:

1. **Fake, real, or both.** An `httptest` fake speaking the admin JSON-RPC shape is cheap and
   matches `gws`. A real hub — `wrangler dev` / `workerd` with a seeded D1 — catches the things
   a fake cannot: the reserved-slug refusals, the cascade on delete, `grant_set`'s replace
   semantics, the 401 shapes. Which, and if both, what each one owns.
2. **Where the real hub comes from.** A flake input pinning `personal-mcps` and booting the
   Worker, or a published container, or nothing. Note the hub needs D1 migrations and a
   bootstrapped user (`BOOTSTRAP_SECRET` via `/internal/users`) before any admin call works, and
   the admin credential from ticket 01 has to be mintable non-interactively for this to run at
   all — if it is not, the rig is impossible and ticket 01 must account for that.
3. **`TF_ACC` against OpenTofu.** `terraform-plugin-testing` needs `TF_ACC=1` plus
   `TF_ACC_TERRAFORM_PATH` pointed at a `tofu` binary, and OpenTofu documents a divergence —
   ephemeral resources surface an internal `open` action in the JSON plan, so plugin-testing sees
   a non-empty plan and needs `ExpectNonEmptyPlan` conditioned on OpenTofu
   (<https://opentofu.org/docs/language/providers/>). Relevant only if ticket 02 chose ephemeral.
4. **Which repo runs it.** Acceptance tests in the provider repo against a hub from a flake
   input; a smoke test here that exercises the provider binary; or both. `personal-mcps` already
   has `pnpm smoke` probing a deployed hub — is there a provider equivalent?
5. **Contract consumption.** `contracts/README.md` records that `admin ops` is a family **no
   consumer suite reads yet** — "a family with none is a fixture nobody needs". A provider-repo
   suite reading `admin-ops.json` would close that recorded gap. Should it?
6. **What CI actually gates.** This repo's CI runs no tests today. The provider repo's is
   `nix flake check`. Decide the minimum gate on each side and resist inventing more.

## Answer

[§22.8](../../../docs/specs/provider/22-opentofu-provider.md).

**(1)** Both. The `httptest` fake carries the normalization logic where perpetual-diff bugs live,
and doubles as ticket 05's oracle; acceptance covers what a fake cannot model — reserved-slug
refusal, the agent delete cascade, `grant_set` replace semantics, `archived` firing a different
RPC, the auth-flip wipe matrix, the 401 shapes. **(2)** The `personal-mcps` flake input provides
the Worker under `wrangler dev` local mode, with `wrangler d1 migrations apply DB --local` and
throwaway `PUBLIC_ORIGIN`, `BOOTSTRAP_SECRET`, `BETTER_AUTH_SECRET`, `UPSTREAM_CREDS_KEY`.
**(3)** `TF_ACC=1` and `TF_ACC_TERRAFORM_PATH` at the nixpkgs `opentofu`; the
`ExpectNonEmptyPlan` divergence never arises because ticket 02 declined ephemeral resources.
**(4)** Both suites live in the provider repo; this repo keeps the `coverage-check` invocation
and the documentation duty. **(5)** Yes — a provider-repo suite reading `admin-ops.json` closes
the gap `contracts/README.md` records ("admin ops" is a family no consumer suite reads).
**(6)** Here, `nix flake check` plus `coverage-check`. There, `nix flake check` on push and
acceptance separately.

The conflict this ticket was watching for turned out to be real but survivable: ticket 01 forbids
machine-minted admin tokens, so CI cannot bootstrap one. The rig signs in instead — but **not**
through `POST /login/sign-in/username`, which is the HTML form route reading `formData()` and
answering `302` + `Set-Cookie`. The API is better-auth's own mount,
`POST /api/auth/sign-in/username` with a JSON body, returning the session token in the
**`set-auth-token`** header; no CSRF, no cookie, and an absent `Origin` passes. Precondition: the
rig's user never enrols TOTP, or sign-in becomes a `twoFactorRedirect` with no session.

Two mechanical traps were caught late and are worth flagging to the builder. **Acceptance is a
flake app, not a check** — `nix flake check`'s sandbox cannot boot a Worker and reach loopback,
and `checks.gotest` sets no `TF_ACC`, so routing acceptance through it would silently skip every
test. And the **nightly must override the pinned input**
(`nix run .#acceptance --override-input personal-mcps github:ahrzb/personal-mcps/master`) and
record the revision, or an ordinary flake evaluation re-tests yesterday's lock forever.

Stated limit: `coverage-check` catches surface drift at hub-commit time; behavioural drift — same
`admin-ops.json`, changed semantics — is caught by the nightly, so within a day rather than
immediately.
