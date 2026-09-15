## 22. The OpenTofu provider

`terraform-provider-pmcp` is the hub's declarative surface, living in its own repository and
managing hub **contents** — apps, agents, grants, upstream credentials. Wrangler still owns the
Worker. It supersedes `pmcp diff`/`apply`, which §9 described and which this section retires.

This spec is the output of a wayfinding effort (`.scratch/opentofu-provider/`) and is written to
be built from without re-deciding anything. Where a decision was reversed during review, the
reversal is recorded, because the discarded option is usually the one a reader reaches for.

---

### 22.1 The admin credential

Administration is reachable only at `POST /<user>/mcp/pmcp` with an owner **better-auth session
bearer** — 7-day sliding, device-flow only. That cannot live in an age file, so the hub grows a
credential family.

#### Its own table, not a third `TokenKind`

`token.kind` carries `CHECK (kind IN ('agent','app'))` (`0007_rename_app_agent.sql:47`), so a
migration is required either way; and `OWNED_BY`, `TOKEN_READ`, `TOKEN_PREFIX`, `referentOf`,
`expiryFor` and `deleteUser` would all need surgery on live credential paths to carry a third
referent whose `ref_slug` would be a username — a pun on a column meaning *what this token is
bound to*.

Migration `0009_admin_token.sql`:

```sql
CREATE TABLE admin_token (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL UNIQUE,   -- SHA-256 of the plaintext, as token.hash
  prefix       TEXT NOT NULL,          -- display only, never a lookup key
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                -- NULL means never
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX admin_token_owner ON admin_token(owner_id);
```

The `ON DELETE CASCADE` is the point: unlike `token.ref_id`, which has no FK and needs explicit
sweeping, user deletion disposes of admin tokens structurally. `hash` is `UNIQUE` because
credential resolution is a hash lookup; `owner_id` is indexed because list and revoke filter by it.

#### Operations

| Op | Input | Output |
|---|---|---|
| `admin_token_issue` | `{ expires_in?: number \| "never" }` | `{ id, token (**writeOnly**), prefix, createdAt, expiresAt }` |
| `admin_token_list` | `{}` | `{ tokens: [{ id, prefix, createdAt, expiresAt, lastUsedAt, revokedAt }] }` |
| `admin_token_revoke` | `{ id }` | `{ id }` |

The casing split is the hub's existing convention, not a slip: inputs are snake_case because
they mirror §9's YAML, and outputs are camelCase because they are rows a TypeScript client
consumes. An op's input and output therefore spell the same column two ways.

`expires_in` defaults to 365 days. Expiry is **fixed, not sliding** — an admin token is not a
session. Revocation is by `id`, never by prefix or plaintext. **Rotation is issue-then-revoke**,
performed by a human: issue a new token from a signed-in session, install it, revoke the old id.
There is no rotate op anywhere in the hub and this family does not add one.

`token_issue`'s schema is untouched, which is deliberate — a conditionally-required `slug` cannot
be expressed by `Field.optional` and `jsonSchema`'s flat `required` array.

#### Leaving the shared table means rejoining two hygiene mechanisms by hand

The builtin app has `log_bodies` enabled, so an unmasked secret lands in an audit row. Both of
these are required, not optional:

1. **`admin_token_issue` declares a `writeOnly` output field** for `token`.
   `adminBackend.sensitivePaths` masks a returned secret only for ops that do, and the contract
   suite currently asserts `token_issue` is the *only* such op — that invariant and its fixture
   change with this work.
2. **`pmcp_adm_` joins the shared credential grammar.** `tokenPattern()` derives from the
   two-key `TOKEN_PREFIX` and feeds the audit and Sentry scrubbers, the gateway URI scrubber, the
   database hygiene sweep, the contract sweep, and socket hygiene. A prefix invisible to it leaks
   everywhere those run. `tokenPattern()` is refactored to derive from a credential-prefix list —
   `TOKEN_PREFIX`'s values plus `pmcp_adm_` — while `TokenKind` stays two-membered. *The prefix
   grammar and the token-kind union were the same thing by accident; this separates them.*

#### Issuance and authorization

**Issuance requires a session principal.** An admin token cannot mint another, so this
credential family cannot self-perpetuate: every `pmcp_adm_` token traces to a human sign-in.

**It does not follow that a leak cannot outlive revocation, and this spec previously claimed it
did.** An admin token reaches `agent_create`, `grant_set` and `token_issue`, so a holder can
create an agent, grant it `all` on a real app, and issue it a never-expiring `pmcp_agt_` key.
That key references the agent, not the admin token; `agentFor` never consults `admin_token`, so
revoking the admin token leaves it working — and it reaches `POST /<user>/mcp/<other-slug>`,
which its parent is refused. The `approval_decide` exclusion is likewise narrower than it looks:
`grant_set` can move a role from `approval` to `allow`, which removes the human gate without
deciding anything.

Those three ops are not removable. They are the provider's entire purpose — `pmcp_agent`,
`pmcp_grant` and `pmcp_token` are three of its five resources — so a credential that cannot
reach them cannot run a `tofu apply`. The authority is therefore real and deliberate: **an admin
token is a namespace-administration credential whose authority is the owner's, minus two acts.**
The two exclusions are integrity gates on those specific acts, not a boundary on what the
credential can cause to exist.

The operator consequence is the part worth writing down: **revocation is not retroactive.**
Revoking a leaked admin token stops that token; it does not undo what the token did. Recovery is
an audit — `agent_list`, `token_list` and each agent's inline grants — not a single revoke.

Three boundaries make "stops that token" narrower than it sounds, all traced rather than
assumed:

- **Already-admitted work finishes.** A request authenticated before the revoke write runs to
  completion, including a mutating one; the principal is resolved once per request and the
  dispatcher does not re-read `admin_token`. There is no wall-clock bound on that window,
  because the body may still be arriving.
- **A held stream closes on its next tick, not at the write.** An admin `subscriptions/listen`
  re-authorizes on the keepalive cadence (`LISTEN_KEEPALIVE_MS`), so a revoked token keeps its
  stream for up to one interval. The cost is bounded: that stream opens no subscriber sockets
  (`pmcp` returns an empty fan-out), so it carries no app notifications.
- **A minted app token's socket outlives even its own expiry.** App-token expiry is checked at
  the `/connect` upgrade only, and the socket then survives until reconnect or an explicit
  sever. So a `pmcp_app_` credential an admin token created can hold a live tunnel after both
  the admin token and the app token are dead. Revoking the parent triggers no sever.

`adminBackend.call` receives `ctx.principal` and discards it — every `AdminOp.handler` sees only
`ownerId` — so op restrictions cannot live in handlers. They live in one exported policy,
`adminOpsFor(principal)`, consulted at **both**:

- `callTool`, before `backend.call` (op name and principal are both in scope), and
- `listTools`, which otherwise advertises ops the credential will be refused — an MCP capability
  contradiction.

An `admin` principal gets every admin op except `approval_decide` (a machine credential that can
approve its own requests defeats the human gate it administers) and `admin_token_issue`.

#### Acceptance surface

| Surface | Session bearer | `pmcp_adm_` |
|---|---|---|
| `POST /<user>/mcp/pmcp` | yes | yes, minus `approval_decide` and `admin_token_issue` |
| `GET /api/whoami` | yes | yes |
| `POST /<user>/mcp` (aggregate) | yes | **no** — explicit kind gate |
| `POST /<user>/mcp/<other-slug>` | yes | no |
| browser routes, `/api/auth/*`, `/connect` | see below | no |
| `POST /internal/users` | no | no |

Two rows need their cells read carefully rather than as a route matrix.

**The browser row's session column is not "yes".** Browser authentication is cookie-only —
`requireOwnerSession` reads `Cookie` and never `Authorization` — so a *session bearer* does not
open those routes either. The better-auth mount rejects `Authorization` except for three
anonymous legs (`sign-out`, `device/code`, `device/token`), and none confers authority on the
bearer it arrives with; `/connect` requires a `pmcp_app_` prefix specifically, so no session or
admin bearer reaches it. The admin **no** is what the row is for; the session cell is "cookie,
not bearer".

**`/internal/users` is not Principal-dispatched at all**, which is why it was missing. It is
gated by a constant-time comparison against `BOOTSTRAP_SECRET`, answering an anonymous 404 when
that is unset. Neither a session nor an admin token is a credential there, and adding admin
tokens changed nothing about it — it belongs in the table precisely so the next reader does not
have to re-derive that.

The narrowing is about **app tools**: an admin token administers the hub and cannot itself call a
single app tool. Read as containment that claims too much — as shown above, it can issue an agent
key that does. What the rows above actually buy, stated without overreach:

- **A smaller live surface.** No browser routes, no `/api/auth/*`, no `/connect`, no aggregate
  endpoint, no direct app tool. A stolen admin token cannot be replayed into a web session.
- **A bounded life.** A fixed, non-sliding default expiry, where a session token slides forward
  on every use and so lives as long as it is used.
- **Individual revocability and visibility.** One credential of many, revocable by `id` without
  disturbing the others, and enumerable in `admin_token_list` / the `pmcp_tokens` data source —
  where a leaked session token is a row an operator cannot name.

That is the real inversion, and it is still worth having: today an operator credential in an age
file **is** a full human session, with none of those three properties.

**Expired, revoked and malformed remain indistinguishable**: all return `401` with
`WWW-Authenticate: Bearer error="invalid_token"`, unchanged. Distinguishing expiry would tell a
holder that a string was once valid. The provider's error text names both causes instead.

#### A third principal kind is ~10 edits the compiler will not find unaided

`Principal` is a two-member union and nearly every consumer uses a binary ternary
(`p.kind === "user" ? … : <assume agent>`), so a third member silently takes the **agent** branch
and reads fields it does not carry: `identity.namespaceIdOf:388`, `namespaceNameOf:1176`,
`resolveCredential:305`, `index.visibleOnScoped:596`, `index.admitted:576`, `gateway.ts:261`,
`gateway.ts:802`, `registry.listAppsFor:864`, `resolveAccess:1250`, `principal.formatPrincipal:42`,
`principalKey:60`.

Without them the *yes* rows above do not work — `/<user>/mcp/pmcp` 404s — and the *no* rows are
enforced only by accident, since the aggregate has no kind gate and refuses an admin principal
solely because a grant query binds `undefined`. The aggregate gains an explicit kind gate.

**Which sites need a `switch`, established empirically rather than by rule.** Add a fourth member
to the union and typecheck: that is the whole test, and it is cheap enough to re-run whenever the
union grows. Most of the sites above already error under `strict` without any rewrite, because
they *read a field* the new member does not carry (TS2339) or already return from every arm of an
annotated function (TS2366) — the exhaustiveness check, not the keyword, is what makes the
compiler the witness, so a field read is the same witness as a `never` arm and needs no edit.

What the canary actually finds is the minority that stay **silent**, and those are the ones that
matter, because both of them fail *open*:

- `registry.resolveAccess` keyed on `kind !== "agent"` and returned an everything-filter — the
  widest privilege in the hub — to any kind it had never heard of.
- `admin.adminOpsFor` ended in a bare `return` of the admin arm, so a new kind would inherit
  every admin op but two.

Both become `switch`es whose omitted `default` makes the next kind a type error. The rule is
therefore **"every site that fails open becomes a switch"**, not "every site becomes a switch":
rewriting the seven the compiler already catches buys nothing and costs a diff.

**Serialization.** The existing user and agent spellings are unchanged, and the new arm returns
the owner's spellings verbatim: `formatPrincipal(admin)` → `user:<username>`,
`principalKey(admin)` → `user:<userId>`. An admin credential is deliberately indistinguishable
from the owner downstream.

**Per-credential audit attribution is a named non-goal.** Doing it properly means threading an
invocation context through every audit writer: `summarise` runs inside each handler and takes
only `ownerId`, the web and page fronts call the same handlers with no backend context, and
secondary writers reconstruct the owner independently (`app_disconnect` → `upstream.disconnected`,
`connection_revoke` → `oauth.revoked`). A partial fix would attribute one action to two different
principals across its own rows. Admin-token actions therefore audit as the owner, exactly as a
browser session does; *which* credential acted is unrecorded.

#### Why this is not the rejected `@better-auth/api-key`

That plugin issues session-equivalent keys inside better-auth's plane, carrying the full human
surface — settings, credential management, OAuth consent, TOTP reset. This is a hub-owned table
scoped to one virtual app minus two ops, refused by every better-auth route.

#### CLI

```
pmcp admin-token issue [--expires 365d|<seconds>|never]   # prints the plaintext once
pmcp admin-token list
pmcp admin-token revoke <id>
```

All honour `--json`. The CLI **accepts** `pmcp_adm_` in `PMCP_TOKEN` and in profiles. The consumer
subcommands that address a single app — `call`, `get`, `read`, and the hidden
`tools`/`prompts`/`resources` — fail with `unauthenticated` and a hint naming the credential kind
**when the addressed slug is not `pmcp`**, because those reach
`POST /<user>/mcp/<other-slug>`, which the table above refuses.
`cli/src/main.ts`'s existing `pmcp_app_` refusal gains this second arm.

**The slug condition is load-bearing, and an earlier draft omitted it.** The premise "these reach
another slug" is false exactly when the slug IS the builtin: the table grants `POST
/<user>/mcp/pmcp` to an admin token, so `pmcp call pmcp grant_set` — the documented imperative
grant-edit path — is honoured by the hub and was refused by its own client. The refusal is
therefore target-based at all six sites, not blanket. Per subcommand against `pmcp`: `call` and
`tools` are real (the builtin dispatches ops and renders a catalog); `prompts` and `resources`
legitimately answer EMPTY rather than refusing, since §20.6 makes those empty families here, and
an empty family is not an auth failure; `get` and `read` name an item that cannot exist, and get
the server's own not-found semantics rather than a client-side lie about the credential.

**`ls` is not among them**, though an earlier draft listed it. It fronts `app_list` — an admin op
on `/mcp/pmcp`, which the table grants outright — so refusing it client-side would deny an admin
token an operation the hub honours, and basic inventory is exactly what an automation credential
needs. The rationale that these commands "reach the aggregate endpoint" was also loose: none of
them reach the aggregate; the six reach a *per-app* slug, which is a different row of the same
table.

#### Governance cost

`contracts/admin-ops.json` (three ops plus the `writeOnly` output), `contracts/whoami.json` (a
third row pinning that an admin token yields the **same** principal spelling as a session), and
the "only `token_issue` has a writeOnly output" invariant all change. These are owner-authored,
regenerated only by `contracts.test.ts` in update mode, and CI rejects any commit touching
`contracts/**` beside implementation — so each lands as a two-commit sequence.

---

### 22.2 Secrets

#### Upstream headers: write-only, on the app resource, with a convergent state machine

An earlier draft gave upstream credentials their own resource. That loses the secret silently:
`app_update`'s contract is *"changing `auth` wipes stored credentials"*, an `auth` flip is an
update of the **app**, and a separate secret resource has no diff — so the headers are never
re-sent and the app goes live with none. The credential belongs on the resource whose field
invalidates it.

Three attributes on `pmcp_proxy_app`:

- **`headers_wo`** — write-only, sensitive. Readable from request **Config** during Create and
  Update; null in plan and state always.
- **`headers_version`** — optional integer, the operator's intent. **Co-required with
  `headers_wo`: both or neither**; either alone is a plan-time error.
- **`headers_applied_version`** — computed integer, the version whose `app_set_upstream_auth`
  actually succeeded.

**`ModifyPlan` is what makes this work.** A computed attribute differing from a configured one
does **not** by itself produce a diff — OpenTofu does not compare sibling values to invent work,
and would retain the computed value and schedule nothing. So the resource implements `ModifyPlan`:
when `headers_version != headers_applied_version` in state, it marks `headers_applied_version`
**unknown** in the plan, which produces the diff that schedules Update. Without this, a failed
credential write is never retried.

| Transition | Behaviour |
|---|---|
| `headers` → `headers`, versions differ | `app_set_upstream_auth`; advance `headers_applied_version` **only on success** |
| `headers` → `headers`, versions equal | nothing; out-of-band header changes are invisible — no drift detection for this attribute, by construction |
| `headers` → `oauth` | `app_update` only; `headers_applied_version` becomes **null**, since the update destroys the credential it witnessed. `headers_wo` under `auth = "oauth"` is rejected at plan time. App is `not_connected` until a human connects; warning says so |
| `oauth` → `headers`, pair configured | `app_update` first (wiping the oauth bundle), then `app_set_upstream_auth` |
| `oauth` → `headers`, pair absent | `app_update` only; applied version stays null. Legal, with a warning |
| `oauth` → `oauth`, version changed | unreachable — the pair is co-required and rejected under `oauth`, so the attribute cannot be set in that mode |
| Create, `auth = "headers"`, pair configured | `app_create` then `app_set_upstream_auth` |
| Create with neither attribute | legal (app without credentials), with a warning. Adding headers later means adding **both**, which is a diff by construction |
| **Pair removed while `headers_applied_version` is non-null** | **plan-time error.** The hub has no operation that clears a headers envelope, so removal cannot express "delete the credential". The error names the only mechanism that does: flip `auth`, or destroy the app |

Co-requirement is what keeps this total: `{auth = "headers", headers_version = 1}` with no secret
is unreachable, so the mismatch rule and the no-secret row can never both apply to one plan.

Write-only requires **OpenTofu ≥ 1.11**. The terranix module emits
`required_version = ">= 1.11"`; `shed/infra/default.nix:13` pins `">= 1.9"` and must be raised.
(nixos-26.05 ships OpenTofu 1.11.8, so the floor is satisfiable today.)

#### `pmcp_token` — in scope, with the state cost accepted

`token_issue` returns plaintext exactly once and the hub stores only a hash, so a managed
resource **must** persist the secret in state. There is no way around it: write-only attributes
cannot carry a *returned* value (core forces `null`), and an ephemeral resource re-`Open`s and
would orphan a credential per run. This is the `aws_iam_access_key` /
`gitlab_personal_access_token` shape, and it is adopted deliberately.

The consequence, stated once and plainly rather than discovered later: **`shed` commits its
state file to git**, AES-GCM encrypted under one passphrase, so every token this resource ever
issues persists as ciphertext in git history. Rotating `TF_STATE_PASSPHRASE` re-encrypts the tip
and not one historical commit, and bumping a token's `rotation` writes a new blob while the old
one stays reachable at the old commit. A passphrase compromise is therefore a compromise of
every token the resource has ever issued, not just the live ones. The owner has accepted that in
exchange for `shed` managing its own services' credentials declaratively.

Two things follow and are requirements, not advice:

- **`TF_ENCRYPTION` is mandatory** wherever this resource is used — not a `shed` habit. A plan
  file is as sensitive as the state.
- **Revocation is the mitigation that actually works.** Because history cannot be rewritten
  cheaply, a leaked passphrase is answered by revoking every token id the state has ever held —
  `token_list` enumerates them — not by rotating the passphrase.

`admin_token_issue`, `admin_token_list` and `admin_token_revoke` remain **unmanaged**: the
provider cannot mint or manage the credential it authenticates with. `token_*` are managed.

**Both `token_issue` kinds are managed** — app tokens and agent keys alike — on one resource,
matching the hub's single op with a `kind` field rather than inventing a split the wire does not
make. Managing app tokens only was considered and rejected: the delivery stories differ (an app
token's consumer is a systemd unit on a host tofu already manages; an agent key's consumer is a
laptop or script it cannot reach), but delivery is not what the resource is for. Lifecycle is.

The cost accepted with agent keys specifically: tofu cannot deliver them, so management buys
planned expiry, rotation and revocation rather than automation, while the plaintext still lands
in committed state — and permanently, since every token ever issued persists as ciphertext in
history that revocation cannot unpublish. That trade was made deliberately, and it is the reason
`pmcp_tokens` exists beside the resource: whatever is *not* managed should at least be visible.

**Managed and ad-hoc tokens coexist, by construction.** `token`'s only uniqueness is on `hash`
— there is no constraint on `(kind, ref_id)` and `token_issue` never revokes a prior key — so an
agent or app may hold any number of live tokens. The provider is *additive* here, unlike the
YAML planner it replaces: it destroys only rows in its own state, each identified by the `id`
returned at issue, so a hand-issued key is invisible to plan, apply and destroy alike. Issuing
with `pmcp token issue` beside a `pmcp_token` resource is a supported workflow, not a conflict.

Three consequences that must be documented for an operator, because two of them surprise:

- **Destroying a `pmcp_agent` revokes every token for that agent, including ad-hoc ones.**
  `agent_delete` cascades all token rows — the same cascade that justified `agent_update` — so
  `tofu destroy` reaches credentials the provider never created and cannot list in its plan.
- **Bumping `rotation` replaces only the managed row.** Ad-hoc keys for the same principal keep
  working. That enables staged rotation and misleads anyone who reads it as rotating "the" key.
- **Ad-hoc keys are invisible to state**, which is how `shed` came to hold app tokens for
  `proton-mail-read` and `proton-mail-mutate` — two identities `mcps.yaml` does not declare. The
  `pmcp_tokens` data source (§22.4) exists to close that blind spot.

**Schema** (`pmcp_token`):

| Attribute | Type | Mode | Notes |
|---|---|---|---|
| `agent` | string | optional, `RequiresReplace` | exactly one of `agent` / `app` |
| `app` | string | optional, `RequiresReplace` | tunnelled apps only — the hub refuses a proxied app |
| `expires_in` | number \| string | optional, `RequiresReplace` | seconds or `"never"`; omitted takes the hub default (90 days for an agent key) |
| `rotation` | number | optional, `RequiresReplace` | bump to reissue; the hub has no rotate op, so replacement *is* issue-then-revoke |
| `token` | string | computed, **sensitive** | the plaintext, available only from the apply that created it |
| `id`, `prefix`, `created_at`, `expires_at`, `revoked_at` | | computed | metadata, readable forever via `token_list`. `revoked_at` is here because the lifecycle rule below needs it: a revoked row stays in state, and without this attribute revocation would be invisible there |

Lifecycle specifics, because this resource is the least ordinary one here:

- **Read** refreshes metadata from `token_list` by `id` and **preserves the prior `token` value
  verbatim**. Setting it to `""` or unknown on refresh would produce a permanent diff; the hub
  can never return it again.
- **Import** sets `token` to null and documents it as unavailable, matching how OpenTofu's config
  generation emits `null # sensitive`. An imported token is manageable and revocable but its
  value is gone.
- **A revoked-or-expired token read back is not drift.** `token_list` still returns the row with
  `revoked_at` / `expires_at` set. The resource surfaces them as computed attributes and does
  **not** call `RemoveResource` — the object exists, it is merely useless. Only a row absent from
  `token_list` means gone. (Contrast the apps and agents, where absence is the only signal.)
- **Delete** is `token_revoke`, idempotent: already-revoked succeeds.
- **`create_before_destroy` is supported and is the point of the additive design.** `Create`
  issues and revokes nothing; `Delete` revokes exactly its own `id` and issues nothing. So a
  replacement under `create_before_destroy` leaves the predecessor valid until the new row's
  `Delete` leg runs, and a consumer can be switched over in between. Under the default
  destroy-then-create ordering the predecessor is revoked first, and everything holding it breaks
  until the new value is delivered — revocation closes the socket authenticated with the revoked
  id (§6). Which ordering to use is the caller's choice; that both are *available* is this
  resource's contract.
- **Deleting the referenced agent or app destroys the token server-side** — both `*_delete` ops
  cascade token rows. Configurations must reference `pmcp_agent.<name>.slug` so the graph orders
  the destroy, or tofu will try to revoke a token the hub has already dropped; the idempotent
  delete above is what keeps that merely untidy rather than a failure.

**No ephemeral resources** anywhere in the provider, which also keeps OpenTofu's plugin-testing
divergence (an internal `open` action making plans look non-empty) out of the test rig.

#### What delivery may rely on, and what it must not expect

Getting an issued value *to* its consumer is out of scope for this provider and for this
repository: the consumers are hosts and their configuration lives elsewhere. But a delivery
design has to be buildable against this surface without renegotiating it, so the guarantees it
may lean on are stated here, and so are the things it will go looking for and not find.

**Provided.**

- `token` is a plain computed sensitive string. It can be consumed by anything a configuration
  can reach — an output, another provider's argument, a local value — and the provider imposes no
  notion of "delivered". `id` and `token` on the same resource come from one object, so a
  consumer that reads them together cannot get a value from one generation and an identity from
  another.
- **Overlapping generations**, via the additive design and `create_before_destroy` above. Two
  live tokens for one referent is a supported state, not a race, so a delivery design can install
  the new value and retire the old one in separate steps at its own pace.
- **Inventory of what is not managed**, via `pmcp_tokens` (§22.4) — the mechanism for noticing
  that a host holds a credential no configuration declares.
- **Idempotent revocation**, so a retried or partially-completed procedure is untidy rather than
  broken.

**Not provided, and not fixable here.**

- **No way to ask the hub which credential a live consumer is using.** Per-credential audit
  attribution is a named non-goal (§22.1), and a tunnel socket does not re-authenticate per
  forwarded call. A procedure that must know "has the consumer switched to the new token" has to
  establish that on the host — by identifying the installed credential's bytes, for instance —
  not by asking the hub.
- **`last_used_at` is not that signal**, and it is the field someone will reach for. It is
  stamped after credential validity but *before* the caller checks whether the app exists, is a
  tunnel, or is archived, so a request bearing a token can stamp it and then take a 403; writes
  are throttled to `TOKEN_LAST_USED_STAMP_MS`; and it carries no caller attribution. Non-null
  means *something* authenticated once, which is why it stays a CLI convenience (§10) and is
  absent from `pmcp_tokens`.
- **No health, readiness or reachability check.** The provider never verifies that a token works,
  and adding one would put a runtime probe in a desired-state plan.

---

### 22.3 Provider configuration

```hcl
provider "pmcp" {
  endpoint = "https://personal-mcps.example.workers.dev"  # or PMCP_URL
  token    = "pmcp_adm_…"                                 # or PMCP_ADMIN_TOKEN
}
```

Both attributes are **optional and sensitive**, config-then-env, with no config-file fallback —
the provider does **not** read `~/.config/pmcp/config.toml`. That matches `gws`, whose provider
block declares optional attributes with env fallbacks and reads no file, and it keeps a CI
credential from being shadowed by an operator's stale profile.

The env var is `PMCP_ADMIN_TOKEN`, deliberately **not** the CLI's `PMCP_TOKEN`: the two hold
different credential families with different acceptance surfaces, and sharing the name would let
a session bearer silently drive `tofu apply` until it expired mid-week.

**`Configure` resolves the namespace before anything else.** It calls `GET /api/whoami` with the
bearer, reads `{principal, namespace}`, and builds the admin path `/<namespace>/mcp/pmcp`. The
namespace is never guessed from token text — the CLI does the same, and it is why `/api/whoami`
appears in §22.1's acceptance table.

---

### 22.4 Resources and data sources

Five resources and three data sources. `pmcp_token` is specified in §22.2 beside the state-cost
decision that shapes it, rather than repeated here.

#### `pmcp_tunnel_app`

| Attribute | Type | Mode | Notes |
|---|---|---|---|
| `slug` | string | required, `RequiresReplace` | `[a-z0-9-]+`; `pmcp` refused |
| `name` | string | optional + computed | hub defaults to slug |
| `description` | string | optional | default `""` |
| `archived` | bool | optional | default `false`; fires `app_archive`/`app_unarchive`, **not** `app_update` |
| `redact`, `redact_results` | map(list(string)) | optional + computed | anchored regex keys, must compile |
| `log_bodies` | bool | optional | default **`true`** |

#### `pmcp_proxy_app`

The above with `log_bodies` default **`false`**, plus:

| Attribute | Type | Mode | Notes |
|---|---|---|---|
| `endpoint` | string | required | |
| `auth` | string | optional | `headers` \| `oauth`, default `headers` |
| `forward_identity` | bool | optional | default `false` |
| `roles` | map(object) | optional + computed | see below |
| `capabilities` | set(string) | optional + computed | see below |
| `headers_wo` | map(string) | optional, write-only, sensitive | §22.2 |
| `headers_version` | number (integer) | optional | co-required with `headers_wo` |
| `headers_applied_version` | number (integer) | computed | convergence witness |

**`roles` is typed, not dynamic.** The wire shape is a `oneOf` — a bare pattern list *or* a
per-family object — which the plugin framework cannot express. The provider takes only the object
form:

```hcl
roles = {
  reader = { tools = ["get_.*"] }
  docs   = { prompts = ["summarize_.*"], resources = ["linear://docs/*"] }
}
```

with `tools`, `prompts`, `resources` all optional lists. The bare-list sugar lives in the terranix
module, which normalizes `["get_.*"]` to `{ tools = ["get_.*"] }` before emitting. The client
always sends the object form; comparison drops empty families, so the hub's canonical rendering
never diffs.

**`capabilities` absent means `["tools"]`, not `[]`.** The hub omits the key entirely when
undeclared, and §20.2's default is tools-only; normalizing absent to an empty set would plan a
spurious update on every imported pre-amendment app. Typed as a `Set` so ordering never diffs.
Because `app_update` has no unset, an update that must touch it sends `["tools"]` explicitly.

#### `pmcp_agent`

`slug` (required, `RequiresReplace`), `name` (optional + computed), `description` (optional).
Nothing but `slug` forces replacement, **because the hub grows `agent_update`**.

That op is the second permitted hub change and it is not cosmetic: no `agent_update` exists today,
and `agent_delete` cascades `deleteTokensForStatement` and `deleteAgentStatement` in one batch
("Delete an agent, its grants, and its tokens. Terminal."). Without it, correcting a display-name
typo would be `RequiresReplace` and would silently revoke every live consumer credential for that
agent, with nothing in the plan saying so. It mirrors `app_update`'s name/description branch, and
costs a fixture regeneration plus a CLI front (§22.6).

#### `pmcp_grant`

`agent`, `app` (required, `RequiresReplace`); `allow` and `approval` (optional sets of string).
Separate sets rather than the wire's `role[:approval]` strings: the suffix is an encoding detail,
and "same role in both modes" becomes a plan-time conflict instead of a server error. At least one
must be non-empty; `allow ∩ approval = ∅`.

Create and Update are both `grant_set`; Delete is `grant_set {roles: []}`.

**Undeclared roles.** A grant naming a role the app has not declared is a **warning** on a
tunneled app (roles arrive at connect time, so config may legitimately lead the first connection)
and an **error** on a proxy app (its roles live in the same config). **`all` is exempt from both**
— it is the built-in role, never declarable, and the live `mcps.yaml` grants it.

The check runs at **apply** time in Create/Update, after an `app_get` on the referenced app: a
provider cannot read a sibling resource's configuration during plan, and on first create the app
may not exist yet. Configurations must therefore reference `pmcp_*_app.<name>.slug` rather than a
bare string, so the dependency graph orders the app before its grants; the terranix module emits
that reference automatically.

#### Lifecycle, all resources

- **Import IDs:** apps and agents by `slug`; grants by `<agent>/<app>` — unambiguous under the
  slug grammar. `headers_wo` and `headers_applied_version` are unavailable on import; an import
  followed by a plan with a configured pair re-sends on the first apply, which is the intended
  behaviour rather than a validation error.
- **Reads** use `app_get` for apps. Agents and grants read through `agent_list`, skipping the
  builtin `pmcp` row.
- **"Gone" for a grant** is any of: the agent is absent, the agent is present with no key for the
  app, or the key is present with an empty role list. All three mean `RemoveResource`.
- **Missing on read** → `RemoveResource`, via the client's typed `NotFound`.
- **Delete is idempotent:** `NotFound` on delete succeeds.
- **No memoization.** There is no plan/apply boundary a provider can observe — `tofu apply`
  refreshes, plans and applies in one process, so an uninvalidated cache serves pre-write data —
  and the framework serves RPCs concurrently against one instance, making a lazily-filled shared
  map a data race.
- **Partial apply.** OpenTofu persists the state a provider *returns* from `ApplyResourceChange`,
  including alongside an error diagnostic; it does **not** snapshot after each remote call. The
  provider therefore updates response state after each successful RPC and returns it with any
  later error — but if the process dies before returning, the hub has changed and tofu holds no
  new snapshot. Multi-RPC resources order least-destructive first. The 30-second forwarded-call
  budget and at-most-once delivery mean a 30s client timeout and retries **only** on connection
  errors raised before the request was sent.
- **Compatibility.** No pinned wire revision; unknown response fields ignored; `-32601` surfaces
  as an actionable error naming the hub change required.
- **Toolchain.** `terraform-plugin-framework` v1.19.0 at its default protocol 6, Go 1.25 —
  matching `gws`. (OpenTofu promises protocol 5 across all of v1.x; 6 is fine against a modern
  `tofu` and is what the precedent already ships.)

#### Data sources

`pmcp_app` and `pmcp_agent`, singular by slug, plus `pmcp_tokens`.

`pmcp_app` returns every `app_get` field — `slug`, `kind`, `name`, `description`, `archived`,
`log_bodies`, `redact`, `redact_results`, and for proxied apps `endpoint`, `auth`,
`forward_identity`, `roles`, `capabilities`. It carries **no** header attributes; the hub never
returns them. Looking up the builtin `pmcp` slug is an error, not an empty result.

`pmcp_agent` returns `slug`, `name`, `description`, `created_at`, and `grants` as a map of app
slug to `{allow, approval}`, normalized as `pmcp_grant` normalizes.

`pmcp_tokens` is the one **plural** data source, and it earns the exception: its whole purpose is
to surface tokens the provider did *not* create. It wraps `token_list`, optionally filtered by
`agent` or `app`, and returns metadata only — `id`, `kind`, `ref_slug`, `prefix`, `created_at`,
`expires_at`, `revoked_at` — never a value, because the hub has none to give. The list is small
and bounded by how many credentials exist, so holding it in state is honest rather than stale.
Use it to assert on inventory: that no unmanaged key exists for a sensitive agent, or that
nothing expired is still live.

**`last_used_at` is deliberately omitted**, though `token_list` returns it. It changes on every
use, so including it would make the data source dirty on refreshes that have nothing to do with
the configuration — noise in every plan. "When was this last used" is an operator question, and
`pmcp token list` is its surface.

**There is no audit data source** — an unbounded newest-first log with `limit`/`offset` would
bake one stale page into state and re-plan dirty every run.

---

### 22.5 The parity oracle

A hand-written coverage table is its own oracle — the session adding an op satisfies it by editing
the list. This repo already diagnosed that shape for parity direction D, whose `COMMANDS` table
was fixed by `cli/test/commands.test.ts` driving the real `main(argv)`. `tofu providers schema
-json` fails differently: it shows attributes but not which op a CRUD path calls, and the mappings
here are deliberately non-isomorphic (`archived` → `app_archive`; `grant_set.roles` → two
attributes; `headers_version` → no admin input at all; `app_update` → two resource types).

**The oracle is the `httptest` fake's request recorder**, driving real Create/Read/Update/Delete
through the framework's test harness and capturing `(resource, action, op, argument field names)`.
Three assertions:

1. **Per-path** — each resource/action's recorded op sequence equals its declared expectation.
   A union of names would survive swapping `app_update` into Delete and `app_delete` into Update.
2. **Field coverage — every input field, not only required ones.** `app_update`'s useful controls
   are predominantly optional, so a new optional hub control (or an existing one dropped from
   every provider path) is the likeliest drift and a required-only check would miss it.
3. **Totality** — every op appears, or carries an explicit `unmanaged` reason.

The fake **validates requests against `admin-ops.json`'s `inputSchemas`**, so it cannot drift into
accepting what the hub's `parseInput` would reject.

**Unmanaged ops**, enumerated here rather than left to the test author:

| Op | Reason |
|---|---|
| `admin_token_issue`, `admin_token_list`, `admin_token_revoke` | the provider cannot mint or manage the credential it authenticates with |
| `approval_list`, `approval_decide` | runtime events, no desired state; `approval_decide` is refused to admin credentials |
| `connection_list`, `connection_revoke` | inbound OAuth bindings are created by browser consent; revoke-only |
| `app_disconnect` | clears a live oauth bundle — an imperative act, not a state |
| `audit_query` | unbounded log; see the data-source ruling |
| `app_list` | no plural apps data source: §22.4 makes `pmcp_tokens` "the one **plural** data source, and it earns the exception" because its purpose is surfacing what the provider did *not* create. Apps have no such blind spot — every managed app is a resource, and `pmcp_app` reads one by slug — so a plural source would bake a whole inventory into state for nothing. Reads go through `app_get`; `agent_list` is managed only because there is no `agent_get` |

#### Gating here, without a deadlock

`repository_dispatch` was rejected: the POST returns `204` fire-and-forget so the hub workflow
cannot fail on a red provider run, the target would evaluate a stale pin anyway, and it needs
cross-repo credentials.

Instead the provider exposes the check as a flake app taking the fixture as an argument, and this
repo's CI runs it against its own working tree:

```
nix run github:ahrzb/terraform-provider-pmcp#coverage-check -- ./contracts/admin-ops.json
```

No circular flake input, and a hub change that outruns the provider fails CI **here**. Because
both repositories are private, the CI step needs a deploy key or PAT with read access to the
provider repo — an explicit prerequisite, not an implementation detail.

**Staging, so a two-repo change can land.** The check is asymmetric — an op or field the
*provider* handles that the fixture lacks is allowed; one the *fixture* has that the provider
lacks fails. Asymmetry alone is insufficient, because the fake validates against the fixture and
every op schema sets `additionalProperties: false`, so a provider-ahead field would be rejected
before the comparison ran. Blanket-exempting unknowns would make a typo indistinguishable from
intent.

So the provider repo carries `coverage/staged.json`: each entry names an op or `op.field` it
supports ahead of the fixture, with a reason. Validation is skipped **only** for declared entries;
anything else unknown still fails.

The expiry rule — a staged entry the fixture has caught up to must be removed — runs **only in
the provider repo's own CI, against its own pinned fixture**. The hub's invocation checks
fixture-ahead failures alone. That is what breaks the cleanup deadlock:

1. Provider ships support with a `staged` entry → its CI green (old pin still needs the entry).
2. Hub's fixture and implementation land as two owner-authored commits → hub CI green (the
   provider is already ahead; the expiry rule does not run here).
3. Provider bumps its pin and drops the entry in one commit → green.

**Failure ergonomics.** When the check fails because the fixture is ahead, the message names the
op or `op.field`, and states the two remedies verbatim: map it to a provider attribute, or add an
`unmanaged` row with a reason. A tripwire whose fix is unobvious is deleted within a year.

**Documentation duty.** `contracts/README.md`'s parity section records this direction and the
retirement of direction C; §8 gains a pointer to this section so a session changing the admin
surface meets it. `admin-ops.json` finally gets a consumer, closing the gap that file records
today ("a family with none is a fixture nobody needs").

---

### 22.6 Retiring `pmcp diff` / `apply`

`pmcp diff`, `pmcp apply` and `cli/src/plan.ts` are **removed**.

Merely deleting `mcps.yaml` is not a guard: the missing-file error is a `usage` error whose own
hint teaches the `-f` bypass — and the file is **untracked**, so any working copy or stale
worktree still holds one while git offers no authoritative version to delete. The Nix packaging
work simultaneously puts `pmcp` on every operator PATH. The prune asymmetry makes this
load-bearing — OpenTofu
destroys only what is in its state, while `pmcp apply` unconditionally deletes everything present
on the server and absent from the file. One `pmcp apply` against a tofu-managed hub wipes it.

**Three replacement subcommands**, because direction D permits no exceptions and `apply` is the
only row reaching `app_update` and `grant_set` — with `agent_update` newly unreachable too. This
is a gap the planner was hiding:

```
pmcp app update <slug> [--name <s>] [--description <s>] [--endpoint <url>]
                       [--auth headers|oauth] [--forward-identity] [--no-forward-identity]
                       [--log-bodies] [--no-log-bodies]
pmcp agent update <slug> [--name <s>] [--description <s>]
pmcp grant set <agent> <app> [--allow <role>]… [--approval <role>]… [--yes]
```

- `app update` and `agent update` are **partial patches**: only flags actually passed are sent, so
  an omitted flag means *unchanged*, never "clear". Booleans use paired `--flag`/`--no-flag` so
  that absence is distinguishable from `false`. Clearing a string is `--description ""`; there is
  no unset, matching `app_update`.
- `grant set` is **full replacement**, matching `grant_set`. Because replacement silently drops
  omitted roles it is guarded in both directions: on a TTY it prints the resulting role set and
  asks for confirmation; **without a TTY it refuses unless `--yes`**, so a piped or CI invocation
  is never less protected than a human. Passing neither flag clears all roles and is refused
  without `--yes` either way.

All honour `--json`; the refusal emits the standard `{"error":{"code":"confirmation_required",…}}`
document. Specifying argv matters because direction D goes green as soon as each row names an op —
a set-equality test would happily bless an unusable or destructive command.

**Round-trip.** Walking §9's grammar against §22.4: `kind` → two resource types; `name`,
`description`, `archived`, `redact`, `redact_results`, `log_bodies`, `endpoint`, `auth`,
`forward_identity`, `capabilities` → attributes; per-family and bare-list `roles` → the typed
object plus terranix normalization; `role:approval` → the `approval` set; `all` → exempt from the
undeclared-role check. No gaps. Upstream credentials, which §9 explicitly excluded, are now
covered by §22.2.

**Adoption** is `import` blocks, one per existing object, since the hub predates the provider.

**Blast radius**, because this is larger than two subcommands: `cli/src/main.ts` (planner imports,
YAML I/O, diff/apply render and execute paths — `yaml` leaves the CLI's dependency closure, which
becomes five packages) · `cli/test/commands.test.ts` (surgery, not deletion) ·
`server/test/worker/contracts.test.ts` (planner types and constants, plus role/capability locks
that live outside direction C) · the `planner-rows` fixture family and direction C both retire,
changing `contracts/README.md`'s family table and parity section · `test-inventory.json`
regenerates · and the docs that promise YAML diff/apply: `README.md`, the client quickstart,
`docs/specs/README.md`, §8, **§9 in its entirety**, §10, the overview, the repo layout, the
testing docs, and the decision log.

**Ownership boundary**, restated in both repositories — in this section, and in
`shed/docs/opentofu.md` beside its existing line: the provider manages hub *contents*; Wrangler
owns the Worker.

---

### 22.7 Packaging

#### This repository

- Plain flake using `flake-utils.lib.eachDefaultSystem`, matching `gws` (which does use
  flake-utils, and therefore builds darwin too; `shed` hardcodes its systems instead).
- Outputs `packages.<sys>.pmcp` and `.default`, `overlays.default` (the singular `overlay` is the
  deprecated spelling `shed`'s consumption would miss), `devShells.<sys>.default`, and
  `checks.<sys>.pmcp`.
- `pnpm-workspace.yaml` gains `packages: [cli, clients/js]` — it has no `packages:` key today, so
  neither directory is an importer and the lockfile has only the root. `server/` gets no manifest,
  because Wrangler builds it from the root; §4 and §17 are corrected to describe the workspace
  that exists rather than the one they claim.
- **The root manifest loses its mirrored CLI dependencies.** Two manifests declaring the same deps
  drift, with npm and Nix resolving from `cli/` while local `pnpm pmcp` resolves from root. After
  the change pnpm gives `cli/` its own `node_modules` and `pnpm pmcp` resolves upward into it.
- The README's `npm install -g github:ahrzb/personal-mcps` is removed: the root is `private` with
  no `bin` and no `prepare`, so it installs nothing runnable. `@ahrzb/personal-mcp-cli` replaces it.
- Derivation: `stdenv.mkDerivation` + `pnpm.fetchDeps` + `pnpmConfigHook`, one pinned `pnpm_10`
  shared by fetcher, hook and devShell; build is `node cli/build.mjs` (node builtins only, no
  bundler); install `dist`, the pruned store, and a `bin/pmcp` wrapper. `fetchDeps` pulls the whole
  workspace closure to build a five-package CLI — accepted for simplicity; `--ignore-scripts`
  keeps the `allowBuilds` postinstalls for esbuild and workerd from running, which is safe only
  because nothing in the CLI build path needs either.
- **The devShell is the version authority**: `nodejs_24` (satisfying `cli/package.json`'s
  `>=22.18` and providing native type stripping), `pnpm_10`, `go_1_25`, `uv`. Wrangler stays an
  npm dependency so it matches the lockfile. The manifests and docs are corrected **to** the
  devShell: `cli/package.json`'s `engines`, `docs/deploy.md`'s prose, and the stale `>=20` spec
  line. The devShell sits **beside** the documented `pnpm install` flow rather than replacing it —
  contributors without Nix keep working.
- `checks` does **not** run vitest: the suite needs `workerd`, and fighting that in a sandbox buys
  nothing here. Tests stay `pnpm test`.
- CI gains `nix flake check` and the §22.5 `coverage-check` invocation — the first real gates in a
  repo whose only workflow publishes on push and runs no tests.
- **`pnpmDeps` hash maintenance:** the hash changes with every lockfile edit, and `nix flake check`
  in CI is the mechanism that catches a stale one. Whoever changes a dependency regenerates it;
  the failure names the expected hash.
- **Verification, given development happens on Windows:** every flake decision here is verified by
  `nix flake check` and `nix run .#pmcp -- --version` under WSL (`x86_64-linux`) and again in CI.
  The workspace change alone is verified by `pnpm install && pnpm pmcp --version`, which is a
  different assertion and does not substitute.

#### The provider repository

- `terraform-provider-pmcp`; source address `registry.opentofu.org/ahrzb/pmcp`; type `pmcp`. The
  address is baked into `.terraform.lock.hcl`, so it is chosen once.
- `buildGoModule`, `vendorHash`, `subPackages = ["."]`, `CGO_ENABLED = 0`, and a `postInstall`
  relocating the binary to
  `$out/libexec/terraform-providers/${sourceAddress}/${version}/${GOOS}_${GOARCH}/terraform-provider-pmcp_${version}`.
- **`passthru.provider-source-address = sourceAddress`.** nixpkgs' `withPlugins` keys the plugin
  directory off this attribute; omit it and tofu ignores the plugin and reaches for a registry that
  has never heard of it.
- Outputs: `packages.default`, `packages.terraform-provider-pmcp`, `packages.tofu`,
  `overlays.default`, `checks.build`, `checks.gotest` (`overrideAttrs { doCheck = true; }`, unit
  tests only), `apps.coverage-check`, `apps.acceptance`, and `terranixModules.pmcp` + `.default`.
  The devShell carries **`gcc`** — `gws` needs it to build cgo test binaries even though the
  package sets `CGO_ENABLED = 0` — plus go, gopls, opentofu, gofumpt.
- Version is hardcoded in the flake (`0.1.0`) and bumped by hand; `gws` is at `0.2.0` by the same
  discipline. No tags, no goreleaser, no registry publication.
- Takes `personal-mcps` as a `git+ssh` input with `inputs.nixpkgs.follows`, **for the acceptance
  hub only** — `coverage-check` takes its fixture as an argument so the gate never depends on a
  pinned revision.

#### The terranix module

One module, because apps, agents and grants are one namespace and splitting them would force
consumers to wire cross-references by hand. Options:

```nix
pmcp.tunnelApps.<slug> = { name, description, archived, redact, redactResults, logBodies };
pmcp.proxyApps.<slug>  = { …, endpoint, auth, forwardIdentity, roles, capabilities,
                           headersVersion };
pmcp.grants.<agent>.<app> = { allow = [ … ]; approval = [ … ]; };
pmcp.extraConfig = { … };   # freeform escape hatch
```

**Tunnel and proxy are separate option trees, not one tree with a `kind`.** That preserves at Nix
evaluation time the property the two resource types give at plan time: a proxy-only field on a
tunneled app is unrepresentable rather than rejected later.

`roles` accepts the bare-list sugar and normalizes it to the per-family object the provider
requires. Grants are keyed agent-then-app, mirroring `mcps.yaml`. Secrets never appear: there is
no `headersWo` option — `headers_wo` is supplied through `extraConfig` or a variable, because a
terranix module renders to JSON on disk.

The module emits `terraform.required_providers`, `required_version = ">= 1.11"`, and
`provider.pmcp = {}` — credentials come from the environment, as every other provider in `shed`
does. `PMCP_URL` and `PMCP_ADMIN_TOKEN` join the operator-only `infra.env.age` and the
`nix run .#tofu` wrapper's exports beside `HCLOUD_TOKEN` and `TF_STATE_PASSPHRASE`. That is a
change in a third repository and is recorded as such.

**Keeping the typed layer in sync** has no codegen — terranix has none
([terranix#100](https://github.com/terranix/terranix/issues/100)) — so it gets a check instead:
`checks.terranix` evaluates the module against a sample configuration and asserts that every
attribute name it emits exists in the provider's schema. That catches the module lagging the
provider, which is the failure the escape hatch would otherwise hide. Reaching for `extraConfig`
is itself the signal that the typed layer is behind.

#### Consuming it from `shed`, including its own services' tokens

`shed` runs several bots that dial this hub, and it manages their credentials declaratively
through `pmcp_token` rather than minting them by hand. Three of its agenix files carry hub
identities: `mcp-tools-environment.age` (a hub token bundled with DuoCards, papers and Sentry
credentials, read as `PMCP_APP_TOKEN` from `services.mcp-tools.environmentFile`), and
`proton-mail-read-token.age` / `proton-mail-mutate-token.age`, each a **bare token file** loaded
with `LoadCredential=app-token:<path>` and read with a whole-file trim. `openclaw-environment.age`
carries no hub credential.

**Decided:** tofu owns the hub-side lifecycle — the app or agent row, the token's issuance, its
`rotation`, and its revocation. `pmcp_token` is the authority for *which* credentials exist.

**Delivery is out of scope**, ruled 2026-09-15: it changes `shed` and a private flake input, and
a rotation procedure settled at the tail of this effort would be rushed. What this section owes
instead is the capability contract in §22.2 — overlapping generations, `create_before_destroy` as
a guarantee, `pmcp_tokens` inventory, idempotent revoke — and the boundary that nothing hub-side
identifies which credential a live consumer is using.

Two facts a later effort should not have to rediscover, because both were established the
expensive way:

- **A restart is not implied by a deploy.** agenix activation rewrites `/run/agenix/<name>` behind
  a constant path, so a unit whose definition did not change is not restarted. Setting
  `restartTriggers` to `config.age.secrets.<name>.file` — the *ciphertext* store path — fixes this
  from `shed`'s own configuration, with no private-module change.
- **The delivery payloads differ per consumer**, per the formats above, so one writer cannot serve
  all three. And `mcp-tools`' token sits inside a multi-credential env file behind a singular
  `environmentFile` in a private input, which is why it is the expensive one and Proton's two are
  not.

Until delivery is settled, `shed` adopts `pmcp_token` for lifecycle and delivers values by hand:
the resource is authoritative, and the operator copies a newly issued value into agenix once.
That is a real intermediate state rather than a broken one, because the lifecycle half is where
the drift was.

---

### 22.8 Tests

**Unit**, as `gws` does: the `httptest` fake plus pure model-conversion tests — null-vs-empty,
role canonicalization, `capabilities` set equality. That is where perpetual-diff bugs live. The
fake's recorder is §22.5's oracle and its schema validation is what keeps it honest.

**Acceptance**, which `gws` skips, because this provider has state a fake cannot model: reserved
slug refusal, the agent delete cascade, `grant_set` replace semantics, `archived` firing a
different RPC, the §22.2 auth-flip matrix, and the 401 shapes.

**How the rig authenticates.** §22.1 forbids machine-minted admin tokens, so the rig signs in —
but **not** through `POST /login/sign-in/username`, which is the HTML form route (`web.ts` reads
`formData()` and answers `302` + `Set-Cookie`). The API is better-auth's own mount,
`POST /api/auth/sign-in/username` with a JSON body, which returns the session token in the
**`set-auth-token`** header. It is headlessly reachable: the login routes sit outside the
`mutation()` CSRF gate, same-origin is if-present-must-match so an absent `Origin` passes, and
`callAuthResponse` exists precisely because a sign-in arrives without a cookie.

`POST /internal/users` with a test `BOOTSTRAP_SECRET` creates the user. **The rig's user must
never enrol TOTP** — two-factor turns sign-in into a `twoFactorRedirect` with no session, so a rig
seeded from a snapshot of a real user would silently get a redirect instead of a credential. The
rig then exercises admin-token issuance end to end as a first-class case.

**Harness.** The `personal-mcps` flake input provides the Worker, run under `wrangler dev` local
mode with `wrangler d1 migrations apply DB --local` against the `DB` binding, and with
`PUBLIC_ORIGIN`, `BOOTSTRAP_SECRET`, `BETTER_AUTH_SECRET` and `UPSTREAM_CREDS_KEY` set to
throwaway values. `TF_ACC=1` and `TF_ACC_TERRAFORM_PATH` point at the nixpkgs `opentofu`. Because
no ephemeral resources exist, OpenTofu's `ExpectNonEmptyPlan` divergence never arises.

**Acceptance is an app, not a check** — `nix flake check`'s sandbox cannot boot a Worker and reach
it over loopback. `apps.acceptance` starts the rig and runs
`TF_ACC=1 TF_ACC_TERRAFORM_PATH=$(command -v tofu) go test ./... -run '^TestAcc'`. This matters:
`checks.gotest` sets no `TF_ACC`, so routing acceptance through it would skip every test and stay
green through any amount of drift.

**What each gate catches, and what none does.** `coverage-check` runs on every push in both
repositories and from this repo's CI, catching *surface* drift — an op or field with no provider
path. It cannot catch *behavioural* drift: the hub can keep `admin-ops.json` byte-identical and
change response semantics, ordering, or auth rejection. Acceptance catches that, and the nightly
workflow is
`nix run .#acceptance --override-input personal-mcps github:ahrzb/personal-mcps/master`, recording
the resolved hub revision. Both halves are required — without the app the tests skip, and without
the override an ordinary flake evaluation re-tests yesterday's lock forever.

**So behavioural drift surfaces within a day, not at hub-commit time.** That is the accepted
limit, written down rather than implied.
