# Decide how a tofu-issued token reaches a systemd unit on shed

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: —

## Question

Surfaced by the owner's reversal on [ticket 02](02-token-resource-modelling.md): `pmcp_token` is
in scope, and `shed` uses it for its own services. Tofu therefore owns the hub-side lifecycle —
which credentials exist, their rotation and revocation. What it does **not** yet own is delivery.

**Scope: app tokens.** Agent keys are managed too, but their consumers are laptops and scripts
tofu cannot reach, so they are hand-carried by decision, not by omission. This ticket is about
the credentials whose consumer is a systemd unit on a host tofu already manages.

`shed`'s bots read their credentials from agenix env files, four of which carry hub identities:

- `mcp-tools-environment.age` — a hub token **bundled with** DuoCards, papers and Sentry creds
- `openclaw-environment.age` — "OpenClaw providers, gateway authentication, Telegram and Personal
  MCP access"
- `proton-mail-read-token.age` and `proton-mail-mutate-token.age` — the two gateway identities,
  already one file per credential

Each is age-encrypted to `operator` + `shed`, committed to git, and read at activation via
`age.secrets.<name>.path` into `services.<name>.environmentFile`. Tofu cannot produce an age file
without shelling out, and it runs on the operator machine, not the host.

Settle:

1. **The mechanism.** Options, none free:
   - **`local-exec` into agenix** — tofu issues, then pipes the value into `agenix -e`. Keeps the
     host path untouched. Makes `tofu apply` depend on the operator's age identity, and puts the
     plaintext in *two* places (state and the age file).
   - **Lifecycle-only, manual delivery** — tofu is authoritative for which tokens exist; the
     operator copies a newly issued value into agenix once. Honest intermediate state; the
     lifecycle half is where the drift actually was.
   - **Replace agenix for these secrets** — sops-nix with a host key, so tofu can write an
     encrypted artifact directly. Coherent, but introduces a second secret system to one host.
   - **Runtime fetch** — the bot obtains its token at boot from somewhere tofu populated. Removes
     the delivery problem and adds a bootstrap-credential problem.
2. **File granularity.** `mcp-tools-environment.age` mixes a hub token with three unrelated
   credentials, so any automated writer must read-modify-write an encrypted multi-value file. Does
   each hub token get **its own** age file — as `proton-mail` already does — with the unit taking
   a second `EnvironmentFile`? That is a change to the `mcp-tools` NixOS module's interface, which
   lives in a private flake input, not in `shed`.
3. **Where the plaintext is allowed to exist.** The owner has already accepted ciphertext in
   `shed`'s committed state. Does it also get to exist in an age file — and if both, is the
   revocation-not-rotation mitigation from §22.2 still the answer, given a leak now has two
   sources?
4. **Rotation ergonomics.** Bumping `rotation` issues a new token and revokes the old. Whatever
   the mechanism, the new value must reach the host *before* the old one is revoked, or the
   service breaks between apply and deploy. Does the order need to be tofu-apply → agenix →
   `deploy-rs`, and is that sequence enforced or merely documented?
5. **Which identities are in scope now.** All four, or only `mcp-tools` first? The proton-mail
   pair are already one-file-per-credential and therefore the cheapest to convert.

Touches a third repo (`shed`) and a private flake input (the `mcp-tools` NixOS module), neither of
which this map has changed before.

## Answer

**The provider ships the capabilities; `shed` designs the procedure.** Delivery and rotation
ergonomics are ruled **out of scope** for this map — they require changes to a third repo and a
private flake input, and a rotation procedure decided here, at the end of a provider-spec effort,
would be a rushed answer to a question that deserves its own effort. What this repo owes is a
surface that does not have to be renegotiated when that effort happens, and the facts that
effort would otherwise have to rediscover.

**Recorded in [§22.2](../../../docs/specs/provider/22-opentofu-provider.md)** as
"What delivery may rely on, and what it must not expect":

- `token` is a plain sensitive computed string, consumable by any output, provider argument or
  local value; the provider has no notion of "delivered". `id` and `token` read from one object,
  so a consumer cannot pair a value from one generation with an identity from another.
- **Overlapping generations are supported**, and `create_before_destroy` is now stated as a
  guarantee rather than an accident: `Create` revokes nothing, `Delete` revokes exactly its own
  `id`. Two live tokens for one referent is a supported state, so a procedure can install and
  retire in separate steps. The default destroy-then-create ordering revokes first and breaks
  everything holding the old value — both orderings available, the choice is the caller's.
- `pmcp_tokens` for inventory of what is not managed; idempotent revocation for retried
  procedures.
- **Not provided:** any way to ask the hub which credential a live consumer is using —
  per-credential audit attribution is deferred, and a tunnel socket does not re-authenticate per
  forwarded call. **`last_used_at` is explicitly not that signal**: stamped before the caller
  checks app existence, kind and archive status, throttled, and carrying no attribution. And no
  health or readiness probe, which would put a runtime check in a desired-state plan.

**The direction, non-binding on the later effort:** hybrid. Automate where the consumer's
contract already permits it — `proton-mail-read` and `proton-mail-mutate` take a bare token in
their own file via `LoadCredential` and need no module change — and hand-carry `mcp-tools`, whose
token is one line inside a four-secret bundle behind a singular `environmentFile` in a private
input.

**`openclaw` is not a hub-token consumer** — settled 2026-09-15 by decrypting
`openclaw-environment.age`, which holds exactly `OPENCLAW_GATEWAY_TOKEN`, `OPENROUTER_API_KEY`,
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`. `modules/openclaw.nix` references neither
the hub nor any `PMCP*` variable. `secrets/secrets.nix`'s comment — "OpenClaw providers, gateway
authentication, Telegram and **Personal MCP access**" — is stale, and it is what put openclaw on
this ticket's list in the first place. Worth correcting in `shed` so it does not mislead a third
time; the credential inventory for delivery is the two Proton tokens plus `mcp-tools`.

**[The design that produced this](10-delivery-design.md)** survived four adversarial rounds and
is kept as prior art, because most of its value is verified fact rather than opinion:

- Two payload formats, not one: `mcp-tools` wants `PMCP_APP_TOKEN` in an env file; Proton's
  services take a bare trimmed token via `LoadCredential=app-token:<path>`.
- `restartTriggers` on `config.age.secrets.<name>.file` closes the no-restart gap
  (`shed/docs/agenix.md:63-66`) from `shed`'s own config, with no private-module change — the
  ciphertext is a store path, so changed ciphertext changes the unit.
- Pinned agenix overrides `$EDITOR` with `cp -- /dev/stdin` whenever stdin is not a TTY
  (`agenix.sh:167`), so the non-interactive interface is a pipe; and it skips re-encryption when
  plaintext is unchanged (`:177`), so no separate churn gate is needed.
- The completion boundary is *installed-and-started*, not serving: Proton declares no readiness
  protocol, so `active` can precede a successful hub handshake.
- `shed` configures two Proton app identities that `mcps.yaml` does not declare — the blindness
  this ticket was opened over, as evidence rather than assertion.
