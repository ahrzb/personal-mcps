# Design the admin token family the provider authenticates with

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: —

## Question

The provider needs a credential that survives in an age file and works unattended. Today the
only thing that reaches the builtin `pmcp` admin tools is an owner better-auth session bearer:
a 32-char unprefixed random string, **7-day sliding expiry** at better-auth defaults
(`expiresIn` 604800, `updateAge` 86400), obtainable only through the RFC 8628 device flow with
an unavoidable browser step. `shed`'s workflow — `nix run .#tofu -- apply` decrypting
`infra.env.age` and exporting env vars — would silently rot on that.

It was decided that the hub grows an owner-scoped admin token family. This ticket designs it.

Settle:

1. **Spelling and shape.** `pmcp_adm_` alongside `pmcp_app_` and `pmcp_agt_`? Stored hashed in
   the existing `token` table (SHA-256, as agent keys are) with a new `kind`, or somewhere else?
2. **Issuance.** Through `token_issue` with a new mode, a separate op, or the web UI only? Note
   `token_issue` currently calls `assertSlugNotReserved`, and an admin token binds to no app or
   agent — so `ref_id`/`ref_slug` have no natural value. What do they hold?
3. **Expiry.** Agent keys default to 90 days. Does an admin token expire, and can it be
   never-expiring? What does rotation look like given there is no rotate op anywhere in the hub?
4. **Acceptance surface.** Exactly which surfaces accept it: only `/<user>/mcp/pmcp`, or also
   `/api/whoami` (the CLI and provider both call it to resolve the namespace)? It must be refused
   everywhere a consumer credential is accepted, mirroring how `pmcp_app_` is refused.
5. **Authorization.** `resolveCredential` dispatches on prefix and `resolveAccess` grants owners
   `[all]`. An admin token is owner-scoped but is not a session. Which principal does it resolve
   to, and does `session.source` or an equivalent distinguish it in the audit trail?
6. **The rejected-plugin argument.** Decision-log §8 and `docs/specs/overview/04-tech-stack.md`
   explicitly reject `@better-auth/api-key`. The spec must argue why a hub-owned token family in
   the existing `token` table is not that plugin by another name — or concede and reopen it.
7. **Error distinguishability.** Expiry currently returns `401 Unauthorized` with
   `WWW-Authenticate: Bearer error="invalid_token"`, indistinguishable from revoked or malformed.
   Does the provider need to tell "rotate your admin token" from "your token is wrong", and if so
   what changes?
8. **CLI consequence.** Does `pmcp token issue --admin` exist, and does the CLI accept an admin
   token in `PMCP_TOKEN` / a profile, or is it provider-only?

Also decide what the provider's own config looks like: attribute names (`endpoint`, `token`), env
fallbacks (`PMCP_URL` / `PMCP_TOKEN`, following the CLI, or provider-specific names), and whether
the provider reads `~/.config/pmcp/config.toml` profiles at all. `gws` sources every credential
from config-then-env and never reads a config file — that is the precedent.

Touches: `server/src/identity.ts` (credential dispatch, token lifecycle), `server/src/admin.ts`
(`token_issue`, `assertSlugNotReserved`), `contracts/admin-ops.json`, `docs/specs/data-model/05`,
`docs/specs/admin-and-config/08`, `docs/specs/overview/04`, decision log §18.

## Answer

A new `pmcp_adm_` family in **its own `admin_token` table** (migration 0009), not a third
`TokenKind`. Full DDL, ops, CLI argv and the provider's own config block are in
[§22.1](../../../docs/specs/provider/22-opentofu-provider.md) and §22.3.

Why not the shared `token` table: `CHECK (kind IN ('agent','app'))` sinks the insert before
anything else, and `OWNED_BY`, `TOKEN_READ`, `TOKEN_PREFIX`, `referentOf`, `expiryFor` and
`deleteUser` would all need surgery on live credential paths — for a row whose `ref_slug` would
be a username, punning on a column that means *what this token is bound to*. The separate table
gets `owner_id REFERENCES "user"(id) ON DELETE CASCADE`, making user deletion structural rather
than a sweep obligation, and leaves `token_issue`'s schema untouched (a conditionally-required
`slug` cannot be expressed by `Field.optional` and `jsonSchema`'s flat `required` array).

Point by point: **(1)** `pmcp_adm_`, hashed SHA-256, own table. **(2)** `admin_token_issue`,
session principals only — an admin token cannot mint a successor. **(3)** Fixed 365-day default,
`never` permitted, no sliding; rotation is issue-then-revoke by a human. **(4)** Accepted only at
`/<user>/mcp/pmcp` and `/api/whoami`; refused on the aggregate, other slugs, browser routes and
`/connect`. **(5)** A third `Principal` kind, which is ~10 ternary sites that must become
`switch` statements with `never` arms; `formatPrincipal(admin)` → `user:<username>` and
`principalKey(admin)` → `user:<userId>`. **(6)** Distinguished from `@better-auth/api-key`:
hub-owned table, one virtual app minus two ops, refused by every better-auth route. **(7)** No
error distinguishability — expired, revoked and malformed all stay `401 invalid_token`, because
distinguishing expiry tells a holder the string was once valid. **(8)** `pmcp admin-token
issue|list|revoke`; the CLI accepts `pmcp_adm_` and consumer subcommands fail with
`unauthenticated` naming the kind.

Two things the design had to be forced into. Restrictions live in one `adminOpsFor(principal)`
policy consulted by **both** `callTool` and `listTools` — `adminBackend.call` discards
`ctx.principal` and handlers see only `ownerId`, so they cannot enforce anything, and a
call-time-only gate would advertise ops it then refuses. And **per-credential audit attribution
is a named non-goal**: `summarise` runs inside handlers, the web and page fronts bypass any
backend context, and secondary writers reconstruct the owner independently, so a partial fix
would attribute one action to two principals across its own rows.

Governance cost: `admin-ops.json`, `whoami.json`, and the "only `token_issue` has a `writeOnly`
output" invariant all change, each as an owner-authored two-commit sequence.
