# Settle the provider's resource and data-source schema

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

The central ticket. Produce the full schema an implementation session can type out: every
resource, every attribute, every plan modifier, every data source.

Already decided: two app types (`pmcp_tunnel_app`, `pmcp_proxy_app`) rather than one
`kind`-discriminated type; grants as their own resource keyed `(agent, app)`; the entity cut is
apps, agents, grants, upstream auth, and tokens as resources, with apps/agents/audit as data
sources, excluding approvals, OAuth connections, and users.

Settle:

1. **Attributes per resource**, from the hub's real mutability. `app_update` accepts `name`,
   `description`, `endpoint`, `auth`, `forward_identity`, `roles`, `capabilities`, `redact`,
   `redact_results`, `log_bodies`. Immutable: `kind`, `slug`, `id`, `owner`, `createdAt`.
   `archived` is **not** an update field — it is separate `app_archive`/`app_unarchive` calls, so
   it is an attribute whose change fires two different RPCs.
2. **`agent` has no update operation at all.** Only `agent_list` / `agent_create` / `agent_delete`
   exist. So `name` and `description` are `RequiresReplace` — and replacing an agent
   **server-side cascades its grants and its tokens**. Is that acceptable, or does this justify
   adding `agent_update` to the hub (the second permitted hub change)? `gws` sets
   `RequiresReplace` on every mutable attribute and makes Update error loudly; that precedent
   points one way, the cascade points the other.
3. **Proxy roles** are a map of role name to either a bare pattern list (tools) or a per-family
   map (`tools`/`prompts`/`resources`). The YAML planner compares them *by meaning* — a bare list
   equals `{tools: […]}`, empty families are dropped. The provider must not produce a perpetual
   diff where the planner produced none. Same for `capabilities`, compared as a **set** with
   absent ≡ `[tools]`, and `app_update` has no unset operation.
4. **Grant modes.** A grant is `role` or `role:approval`; the same role in both modes is a hard
   error. Is that one `roles` set of strings, or two attributes (`allow`, `approval`)? `grant_set`
   replaces the whole set for the pair, so Create and Update are the same call, and Delete is
   `roles: []`.
5. **Read against list-only endpoints.** There is no per-object GET. Every `Read` is a list call
   filtered client-side; grants come inline on `agent_list`. Decide the reconciliation, and what
   `RemoveResource` is triggered by (`gws` uses a typed `NotFound` from its client).
6. **Reserved slug.** `pmcp` is virtual, has no D1 row, and is rejected everywhere. The provider
   must refuse it at validation time, not at apply.
7. **Slug rules.** `[a-z0-9-]+` — underscores are rejected because they make aggregated
   `<slug>_<tool>` ambiguous. Validate in-schema.
8. **Data sources.** Which of apps/agents/audit earn one, and what `audit_query`'s pagination
   (`limit` default 100, `offset`, returning `{rows,total}`) looks like as a data source — if it
   belongs in a provider at all.
9. **No idempotency, no transaction.** Each step is one MCP call; there is no rollback. What the
   provider owes on partial failure.
10. **Protocol and deps.** `gws` uses framework v1.19.0 at the default protocol 6 with Go 1.25.
    Match it, or serve protocol 5 for wider OpenTofu v1.x reach
    (<https://opentofu.org/docs/language/v1-compatibility-promises/>)?

The output of this ticket is a written schema, not prose about one.

## Answer

Full schema — attributes, modes, defaults, lifecycle — in
[§22.4](../../../docs/specs/provider/22-opentofu-provider.md).

**(1)** Attribute tables per resource; `archived` is an attribute whose change fires
`app_archive`/`app_unarchive` rather than `app_update`. **(2)** The hub grows `agent_update`:
`agent_delete` cascades grants *and* tokens in one batch, so without it a display-name typo
would be `RequiresReplace` and silently revoke every live credential for that agent, with
nothing in the plan saying so. **(3)** `roles` is typed as `map(object({tools, prompts,
resources}))` — the wire's `oneOf` (bare list or per-family object) cannot be expressed by the
framework, so the bare-list sugar lives in the terranix module and the provider sends the object
form. `capabilities` is a `Set` whose absent value is `["tools"]`, **not** `[]`: the hub omits
the key when undeclared, and normalizing to empty would plan a spurious update on every imported
app. **(4)** `allow` and `approval` as separate sets, so same-role-both-modes is a plan-time
conflict. **(5)** Reads use `app_get` (it exists — "no per-object GET" was false); agents and
grants read through `agent_list`; "gone" for a grant is agent-absent, key-absent, or empty list.
**(6)** `pmcp` refused at validation. **(7)** Slug grammar validated in-schema. **(8)** Data
sources `pmcp_app` and `pmcp_agent` with enumerated outputs; **no audit data source** — an
unbounded newest-first log would bake a stale page into state. **(9)** Partial apply stated
against OpenTofu's real persistence boundary: state is persisted when `ApplyResourceChange`
*returns*, not per remote call. **(10)** framework v1.19.0, protocol 6, Go 1.25, matching `gws`.

Two corrections worth carrying forward. There is **no memoization** of list reads: there is no
plan/apply boundary a provider can observe (one process refreshes, plans and applies), and the
framework serves RPCs concurrently against one instance, so a lazily-filled cache is both
stale-by-construction and a data race. And **`all` is exempt** from the undeclared-role check on
*both* app kinds — `plan.ts:646` exempts the builtin, and the live `mcps.yaml` grants it, so an
error rule without the exemption would reject the very config being migrated.

Where the undeclared-role check runs had to be decided too: at apply time in `pmcp_grant`
Create/Update after an `app_get`, because a provider cannot read a sibling resource during plan
and the app may not exist yet. Configurations reference `pmcp_*_app.<name>.slug` so the graph
orders app before grants; the terranix module emits that reference.
