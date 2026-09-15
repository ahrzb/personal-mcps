# Decide how a token resource models an issue-once secret

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: —

## Question

`token_issue` returns plaintext **exactly once**; the hub stores only SHA-256. `token_list`
returns metadata forever (id, kind, refSlug, prefix, createdAt, expiresAt, lastUsedAt, revokedAt)
and never the secret. There is no rotate operation — rotation is issue-then-revoke. So a
`pmcp_token` resource can never re-read what it created.

OpenTofu's mechanisms, verified:

- **Write-only attributes** (v1.11+) are provider *inputs* only and are always `null` in state,
  plan, and provider responses — they cannot carry a returned secret, and they generate no diff,
  so `RequiresReplace` on the secret itself does not fire.
  <https://opentofu.org/docs/v1.12/language/ephemerality/write-only-attributes/>,
  <https://github.com/opentofu/opentofu/pull/3171>
- **Ephemeral resources** (v1.11+) can surface plaintext transiently but persist nothing, so a
  durable token minted from one orphans on every run unless `Close` revokes it — which defeats
  durable use. <https://opentofu.org/docs/v1.12/language/ephemerality/ephemeral-resources/>
- **State encryption** (v1.7+) is defence in depth; the secret is still persisted.
- Import generates `null` with a `# sensitive` comment — it cannot reconstruct the value.
  <https://opentofu.org/docs/v1.12/language/import/generating-configuration/#generated-hints>

What mature providers do: `aws_iam_access_key` and `gitlab_personal_access_token` persist the
secret in state and document it as unavailable on import; the GitHub provider **refuses** to
manage PATs (<https://github.com/integrations/terraform-provider-github/issues/2364>); Vault has
moved to ephemeral resources for the transient case.

Choose, and say why:

1. **Metadata-only managed resource** — the provider creates and revokes tokens and tracks
   lifecycle, but the plaintext is deliberately unavailable; `pmcp token issue` stays the way a
   human gets one. Honest, but the token is useless the moment tofu creates it.
2. **Managed resource with the secret in state**, `Sensitive`, unavailable on import — the
   industry-normal answer, and composable (the key can flow into an agenix/sops input). Accepts a
   plaintext credential in state, which `shed` encrypts via `TF_ENCRYPTION` anyway.
3. **Ephemeral resource** for same-run consumption, with explicit issue/revoke semantics.
4. **Excluded** — tokens stay imperative, as `mcps.yaml` already decided for exactly this reason
   (§9: "secrets and humans don't belong in a declarative file").

Then settle the consequences: if a secret can live in state, does `TF_ENCRYPTION` become a
documented requirement rather than a `shed` habit? If rotation is issue-then-revoke, is that a
persisted `rotation_trigger` attribute marked `RequiresReplace`? Does `pmcp_upstream_auth`
(`app_set_upstream_auth`, which carries upstream header credentials) inherit the same answer, or
is it different because the hub never returns those values either?

Note the tension with `contracts/README.md`: fixtures may contain **no secrets, ever**, and
`token_issue`'s key is `writeOnly`-marked precisely so masking covers it. Whatever is decided must
not put a plaintext token into a fixture.

## Answer

**Split by direction of flow.** Upstream auth headers are an *input* the hub never returns →
write-only attribute. A token is an *output* returned once → no mechanism avoids persistence, so
**option 2: a managed resource that keeps the secret in state**, `Sensitive`, unavailable on
import. [§22.2](../../../docs/specs/provider/22-opentofu-provider.md).

Headers live on `pmcp_proxy_app`, not a separate resource: `app_update`'s contract wipes stored
credentials on an `auth` flip, and a separate secret resource has no diff when that happens
(write-only is null by construction), so the app would go live with no credentials and apply
would report success. Three attributes — `headers_wo` (write-only), `headers_version` (optional,
**co-required**), `headers_applied_version` (computed) — plus a `ModifyPlan` that marks the
computed value unknown when it differs from the configured one. That last part is essential: a
computed attribute differing from a configured sibling does **not** produce a diff by itself, so
without it a failed credential write is never retried. The full transition matrix, including
pair-removal being a plan-time error because the hub has no operation that clears an envelope, is
in §22.2.

**Tokens were initially excluded, and the owner overruled it (2026-09-15).** The analysis stands
and is worth keeping, because it is the cost being accepted rather than an argument that lost:
`shed` commits its state file to git under one passphrase, so every token this resource issues
persists as ciphertext in history — rotating `TF_STATE_PASSPHRASE` re-encrypts the tip, not one
historical commit, and bumping `rotation` writes a new blob while the old stays reachable. A
passphrase compromise is therefore a compromise of every token ever issued.

What changed is the weighing, not the facts. The owner wants `shed` to manage **its own
services'** credentials declaratively, which is worth that exposure; §9's exclusion of secrets
from the YAML config was also a judgement about a different tool with no state encryption at all.
Two requirements follow and are recorded in §22.2: `TF_ENCRYPTION` is **mandatory**, not a
habit, and the mitigation for a leaked passphrase is **revoking every token id the state has
held** — enumerable via `token_list` — rather than rotating the passphrase, which cannot reach
history.

`admin_token_*` stay unmanaged regardless: the provider cannot mint the credential it
authenticates with.

**Which kinds, settled separately.** `token_issue` has exactly two — app tokens (a bot holding a
tunnelled app's slot) and agent keys (a consumer calling `/<user>/mcp`). App tokens were an
immediate yes. Agent keys were weighed on their own, because tofu cannot deliver them — their
consumers are laptops and scripts — and because the live grants are `[all]`, bare, so no approval
gate stands behind a leaked one. Managing app tokens only, with a data source for agent-key
visibility, was the standing recommendation.

**The owner chose both** (2026-09-15), on the reasoning that lifecycle, not delivery, is what the
resource is for: planned expiry, rotation and revocation are worth having even where the value is
hand-carried. One resource covers both kinds, matching the hub's single op with a `kind` field
rather than a split the wire does not make.

That choice rests on a property confirmed in the same exchange: **managed and ad-hoc tokens
coexist.** `token`'s only uniqueness is on `hash` — no constraint on `(kind, ref_id)`, and
`token_issue` never revokes a prior key — and the provider destroys only rows in its own state,
keyed by the `id` returned at issue. So `pmcp token issue` beside a `pmcp_token` resource is
supported, and individual credentials can be promoted to managed as they earn it. The sharp edge:
destroying a `pmcp_agent` revokes *every* token for that agent, ad-hoc ones included, because
`agent_delete` cascades all token rows.

**`pmcp_tokens` data source** was added alongside, and it is safe by construction rather than by
discipline: the hub stores only a SHA-256 and `TOKEN_READ` never projects it, so no code path can
return a plaintext token after issuance. The data source carries inventory and lifecycle only —
id, kind, referent, display prefix, created/expires/last-used/revoked. The asymmetry worth
remembering is that the *resource* is the half holding a secret, because it captured the one-time
value at creation; the data source reads a table with no secret in it.

The reversal surfaced one genuinely new question, now a live ticket:
[how a tofu-issued token reaches a systemd unit on shed](10-shed-token-delivery.md). Tofu owns
*which* credentials exist; delivery into agenix-backed `EnvironmentFile`s is undecided.

No ephemeral resources anywhere, which also keeps OpenTofu's `ExpectNonEmptyPlan` divergence out
of the test rig. Only `admin_token_*` are recorded as `unmanaged` in §22.5's list; `token_*` are
managed.
