# Delivery from tofu state to shed — design notes (prior art)

**Status: not a live design.** The delivery *procedure* was ruled out of scope for this map on
2026-09-15 — see [ticket 10](10-shed-token-delivery.md). The provider ships the capabilities
(§22.2, "What delivery may rely on"); `shed` designs the procedure in its own effort, where the
`mcp-tools` module change and the rotation ergonomics can be thought through rather than decided
at the tail of a provider spec.

This document is kept for the **verified facts** below, not its recommendation. It is draft 4,
the convergence of four adversarial rounds (five blockers, all closed); the reviewer's final
verdict was that no blocking design findings remained. A later effort should re-derive the
recommendation and inherit the facts.

The section headings below name the round each fix came from; "draft 2/3" references are internal
to that dialogue.

## Settled, not under review

- `pmcp_token` manages both `token_issue` kinds on one resource (§22.2). Owner override,
  2026-09-15. Plaintext persists in state; `TF_ENCRYPTION` mandatory; the mitigation for a leaked
  passphrase is revoking every token id the state has held.
- **Agent keys are out of delivery scope** — a coverage limit, not a proof that no host-resident
  agent-key consumer can appear. If one does, it is a fresh decision.
- `pmcp_tokens` is metadata-only; `last_used_at` omitted. Draft 2 made the revoke gate depend on
  that field via the CLI. **Draft 3 withdraws that** (blocker 1), so the field is once again
  purely an operator convenience and nothing in this design rests on it.

## Verified consumer inventory

| Consumer | Hub app | File | Payload | Option | Module change |
|---|---|---|---|---|---|
| `proton-mail-read` | `proton-mail-read` | `proton-mail-read-token.age` | bare token, trimmed | `readAppTokenFile` | **none** |
| `proton-mail-mutate` | `proton-mail-mutate` | `proton-mail-mutate-token.age` | bare token, trimmed | `mutateAppTokenFile` | **none** |
| `mcp-tools` | `mcp-tools` | `mcp-tools-environment.age` (bundled) | `PMCP_APP_TOKEN=…` | `environmentFile` (singular) | `environmentFiles`, private input |
| `openclaw` | **none** | `openclaw-environment.age` | n/a | n/a | n/a — not a hub consumer |

Sources: `shed/hosts/shed/default.nix:18-35`; `mcp-tools/nix/module.nix:33`;
`mcp-tools/nix/proton-mail.nix:86-102,325`;
`mcp-tools/proton-mail/cmd/proton-mail-mcp/config.go:94-111`.

**Corrected from draft 2.** `shed` *configures* two Proton gateways with app identities absent
from `mcps.yaml`. No live hub read was performed, so "live hub apps `mcps.yaml` has never heard
of" is **unverified**; what is verified is that the checked-in host config references them and
the checked-in declarative config does not. That asymmetry motivates lifecycle management under
either option; it is not the reason to prefer B. The reason to prefer B for these two is their
delivery contract — own file, bare payload, no bundle, no private-module change.

## The restart hole, closed in shed's own config

Draft 2 accepted a manual `systemctl restart` as an irreducible fifth step, on the strength of
`shed/docs/agenix.md:63-66` ("the consuming unit is **not** restarted … `restartTriggers` is
empty"). That documents today's configuration, not a constraint. `restartTriggers` is empty
because nothing sets it — and setting it needs **no private-module change**, because
`restartTriggers` is a `systemd.services.*` option, settable from `hosts/shed/default.nix`:

```nix
systemd.services.proton-mail-read.restartTriggers  = [ config.age.secrets.proton-mail-read-token.file ];
systemd.services.proton-mail-mutate.restartTriggers = [ config.age.secrets.proton-mail-mutate-token.file ];
```

`.file` is the **ciphertext** path, which is a store path: new ciphertext → new store path → the
unit definition changes → activation restarts it. Nothing plaintext enters the store; the
ciphertext is already committed to a public-ish repo by design.

`grep -rn restartTriggers` across `shed` returns only that doc line, so this is new configuration
rather than a change to existing behaviour. The completion sequence becomes:

```
apply  →  deliver  →  commit  →  deploy-rs activates and restarts  →  installed and started
```

`deploy` is the **installation** boundary — legitimately, because the unit definition changed.
It is not a *serving* boundary: see below.

## Blocker 1 — the revoke gate

Withdrawn. `last_used_at` cannot carry it:

- `resolveAppToken` stamps after credential validity but **before** the caller checks app
  existence, kind and archive status, and before the DO accepts the socket
  (`server/src/identity.ts:471-495`, then `server/src/tunnel.ts:206-230`). A request bearing B can
  stamp B and then take a 403.
- Writes are throttled to `TOKEN_LAST_USED_STAMP_MS = 60 * 60_000` (`server/src/limits.ts:46-50`),
  so a static A timestamp proves nothing, and an established socket does not re-authenticate per
  forwarded call.
- No attribution: *someone* used B.

And there is no hub-side substitute — **per-credential audit attribution is deliberately
deferred** (§22, D1). So the hub cannot answer "which credential is this live consumer using".

**The gate is therefore host-side, and it must identify B by content rather than by timing.**
Draft 3 compared the unit's activation timestamp against the secret's mtime, which a failed
deployment and rollback satisfies just as well — agenix reinstalls A, systemd starts a fresh
process on A, and the timestamp relation holds. Three conditions, in order, each falsifiable:

```bash
want=$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)   # expected plaintext, computed locally

nix run nixpkgs#deploy-rs -- --skip-checks .#shed || exit 1   # 1. rollback must not authorize
ssh shed "sha256sum /run/agenix/proton-mail-read-token | grep -q $want" || exit 1  # 2. it is B
ssh shed 'systemctl is-active --quiet proton-mail-read'       || exit 1   # 3. started on it
```

Condition 2 is what draft 3 was missing: it names the generation by its bytes, so a rollback to
A fails it. Conditions 1 and 3 then establish that a process started *after* those bytes were
installed — and because the unit's sole credential source is that file (`config.go:94-111` reads
`appTokenFile` or the `LoadCredential` copy, and nothing else), A is unreachable by
configuration rather than merely unused.

**What this does not promise is *serving*.** Proton reads the token, initialises its local
gateway, then calls `pmcp.Serve` (`main.go:42-83`), and the unit declares no readiness protocol
(`nix/proton-mail.nix:305-350`), so `active` can precede a successful hub handshake. There is no
hub-side substitute either, since per-credential audit attribution is deferred. So the design
promises **installed-and-started**, and *serving* is established by one functional probe the
operator runs — a single tool call through the hub to `proton-mail-read`, whose success is
end-to-end proof because that gateway has no other credential. Revoke `-a` after the probe, not
after the deploy.

## Blocker 2 — the writer

`EDITOR="cp $tmp"` is wrong, and the correct interface is simpler. Pinned agenix
(`b027ee29d959fda4b60b57566d64c98a202e0feb`, `pkgs/agenix.sh`) does:

```bash
 27:  echo 'If STDIN is not interactive, EDITOR will be set to "cp /dev/stdin"'
167:      [ -t 0 ] || EDITOR='cp -- /dev/stdin'
169:      $EDITOR "$CLEARTEXT_FILE"
177:  … @diffBin@ -q -- "$CLEARTEXT_FILE.before" "$CLEARTEXT_FILE" && warn "$FILE wasn't changed, skipping re-encryption." && return
```

So the documented non-interactive path is **stdin**, and draft 2's idiom would be overridden by
it. Using it as intended deletes the caller's temp file, the `shred`, and the
cleanup-on-failure hole in one move:

```bash
# shed/flake.nix, apps.pmcp-deliver — per delivery
d=$(tofu output -json "$out")                      # one read: id, file, fmt, token together
tok=$(jq -r .token <<<"$d"); file=$(jq -r .file <<<"$d"); fmt=$(jq -r .fmt <<<"$d")
[ -n "$tok" ] && [ "$tok" != null ] || { echo "empty token for $file" >&2; exit 1; }

case "$fmt" in
  bare) printf '%s'                  "$tok" ;;
  env)  printf 'PMCP_APP_TOKEN=%s\n' "$tok" ;;
esac | TMPDIR=/dev/shm nix run .#agenix -- -e "$file"
```

- **Stdin is the payload by construction** — there is no `$EDITOR` for a redirect to defeat.
- **`TMPDIR=/dev/shm`** constrains agenix's own `mktemp -d` cleartext dir and its `.before` copy
  (`agenix.sh:157-163`), which draft 2's `/dev/shm` temp file did not. Memory-backing is a
  property of `/dev/shm`, not a swap guarantee.
- **Line 177 deletes the churn gate.** Unchanged plaintext → agenix skips re-encryption entirely,
  so no ciphertext churn and no `git diff` noise. Draft 2's id-comparison skip was reinventing
  this. The sidecar's remaining job is narrower and stated below.
- **Line 190-195** encrypts to a staging dir before replacing the destination, so the destination
  is not truncated on failure.

## Major — what the sidecar and status actually promise

Draft 2 said "state versus committed sidecar" and then read the **working tree**, which
`pmcp-deliver` had just written. Picking one contract: the sidecar is a **committed record,
bound to the bytes it describes.**

```
secrets/proton-mail-read-token.age.id   →   "<token-id> <sha256-of-ciphertext>"
```

Written by `pmcp-deliver` after agenix exits 0, hashing the file agenix produced. Both halves of
the pair must then be read from **the same boundary** — draft 3 read the sidecar from `HEAD` and
hashed the *working tree*, so a commit carrying sidecar B beside ciphertext A passed while an
unstaged ciphertext B sat in the tree. That is exactly the incoherent pair the check exists to
catch.

```bash
# shed/flake.nix, apps.pmcp-status
outs=$(tofu output -json) || { echo "cannot read encrypted state" >&2; exit 2; }
names=$(jq -r 'keys[] | select(endswith("_delivery"))' <<<"$outs")
[ -n "$names" ] || { echo "no deliveries configured" >&2; exit 0; }

for out in $names; do
  file=$(jq -r ".\"$out\".value.file" <<<"$outs")
  want=$(jq -r ".\"$out\".value.id"   <<<"$outs")
  read -r have hash < <(git show "HEAD:secrets/$file.id" 2>/dev/null || echo "absent -")
  committed=$(git show "HEAD:secrets/$file" 2>/dev/null | sha256sum | cut -d' ' -f1)

  [ "$want" = "$have" ]      || echo "UNDELIVERED  $file: state=$want committed=$have" >&2
  [ "$hash" = "$committed" ] || echo "INCOHERENT   $file: committed sidecar vs committed bytes" >&2
  git diff --quiet -- "../secrets/$file" "../secrets/$file.id" \
                             || echo "UNCOMMITTED  $file: working tree differs from HEAD" >&2
done
```

Both compared values now come from `HEAD`, so the contract is exactly "what this repository has
published". Working-tree divergence is reported as a **separate third fact** rather than
contaminating the pair check — draft 3 conflated them in both directions, calling a coherent
`HEAD` incoherent whenever the tree had moved on.

This distinguishes four states: **unreadable state** (exit 2, not an empty loop — enumeration is
captured and checked, not expanded inline), **not yet committed** (`HEAD` still names A, or
nothing), **incoherent commit** (sidecar committed beside the wrong ciphertext), and
**uncommitted work in progress**. It still says nothing about the host — that is the three-condition
gate above, deliberately a separate question.

What it does **not** promise: that the host can decrypt. A recipient rotation changes ciphertext
and so changes the hash, surfacing as `INCOHERENT` until re-delivered — noisy but not silent.
`shed/docs/agenix.md` already requires a rekey after recipient changes.

## Major — the value/identity selection contract

Draft 2 defined `*_delivery` with `id`/`file`/`fmt` and then read an undefined `*_delivery_token`,
so two selectors could disagree. **One output object carries all four**, read once:

```nix
output.proton_mail_read_delivery = {
  sensitive = true;                                    # the object contains a token
  value = {
    id    = "\${pmcp_token.proton-read-b.id}";         # ← the only selector
    token = "\${pmcp_token.proton-read-b.token}";
    file  = "proton-mail-read-token.age";
    fmt   = "bare";
  };
};
```

`id` and `token` come from the same resource reference, so they cannot select different
generations. `pmcp-deliver` reads the object once; the sidecar's id comes from the same JSON as
the bytes it encrypted.

Generations stay one-file-per-consumer: commit 1 adds `-b` and repoints the output, commit 2
deletes `-a` once the host check passes. The interval where state selects B while the host still
runs A is intended and safe — A stays valid because the hub has no `(kind, ref_id)` uniqueness,
`token_issue` never revokes a predecessor
(`server/migrations/0007_rename_app_agent.sql:45-57`, `server/src/identity.ts:718-746`), and
revocation severs only the socket authenticated with the revoked id
(`server/src/tunnel.ts:625-635`).

## Major — the standalone command execution contract

Draft 2's "read-only, runs everywhere" was false: these commands read **encrypted** state, and the
existing wrapper builds `TF_ENCRYPTION` in its own process immediately before `exec tofu`
(`shed/flake.nix:175-190`), so nothing survives into a parent shell. The wrapper's preamble
splits in two:

- **`stateEnv`** — `cd infra`, symlink `config.tf.json`, decrypt `../secrets/infra.env.age`,
  build and export `TF_ENCRYPTION`, unset `TF_STATE_PASSPHRASE`. Needs the operator's age
  identity and nothing else.
- **`providerEnv`** — the `GITHUB_TOKEN` check, `gws auth export`, gcloud ADC discovery
  (`flake.nix:131-174`). Needed to *plan*, not to read an output.

`tofu` = `stateEnv` + `providerEnv` + `exec tofu "$@"`. `pmcp-status` and `pmcp-deliver` =
`stateEnv` only. So both are operator-only commands requiring the age identity — **not callable
from CI**, which uses the credential-free `.#opentofu` with `-backend=false`
(`shed/flake.nix:302-303`, `.github/workflows/check.yml`). Read-only is not credential-free, and
this design does not claim CI coverage.

**Also corrected from draft 2:** the retired tail was *not* skipped on `apply -target` — it ran
the full all-output loop after a targeted apply, ignoring target scope. That was round 1's
objection and draft 2 mis-restated it.

**Conceded and unsolved:** single-operator, single-checkout orchestration over a committed local
state file. No lock spans apply→deliver→commit→deploy. Two checkouts can publish divergent
ciphertext; the `INCOHERENT`/`UNDELIVERED` pair catches the *result* in the repository but
prevents nothing. `shed/docs/opentofu.md` already names a real backend as the two-operator
prerequisite, and that is not this ticket's to satisfy.

## Accepted residuals, written down so they are not rediscovered

- **Collateral restart of `proton-maild`.** The read/mutate gateways are not socket-activated —
  their same-named sockets set `Service="proton-maild.service"`, and the core `require`s those
  sockets (`mcp-tools/nix/proton-mail.nix:210-269`). `switch-to-configuration-ng` infers a
  `<basename>.socket` association for a service with no `Sockets=` and schedules it through its
  stop/start path, so rotating one gateway's token can disturb the core too. The active
  `multi-user.target` pulls the wanted gateways back in on reactivation, so this is a wider
  reconnect than intended, not a stopped service. Accepted under the reconnect window already
  conceded above.
- **Rollback after revoke restores a dead credential.** Once `-a` is revoked, rolling the system
  back to a generation carrying `-a` gets a credential the hub refuses. This is why the revoke is
  gated on a functional probe and why it is a *second commit*: the runbook must say that
  rollback across a revoke boundary requires re-delivering the current generation, not just
  reactivating an old closure.
- **Option A's `mcp-tools` rotation still needs a manual restart.** The two `restartTriggers`
  lines cover Proton only. `mcp-tools` could get the same treatment on its bundle
  (`config.age.secrets.mcp-tools-environment.file`), at the cost of restarting it whenever *any*
  of the four bundled secrets changes. That is a defensible trade but it is a separate choice,
  not part of this recommendation.

## Recommendation

Unchanged from draft 2, now cheaper:

- **B for `proton-mail-read` and `proton-mail-mutate`.** Own file, bare payload, no bundle
  surgery, no private-module change — and with `restartTriggers` set in `hosts/shed/default.nix`,
  no manual restart either. Cost: two `pmcp_token` resources, two outputs, two `restartTriggers`
  lines, and the `pmcp-deliver`/`pmcp-status` apps.
- **A for `mcp-tools`.** One line inside a four-secret bundle behind a singular `environmentFile`
  in a private input. Manage lifecycle; paste on rotation; revisit when that module is being
  touched anyway.
- **`openclaw` out, settled rather than deferred.** Its env file holds `OPENCLAW_GATEWAY_TOKEN`,
  `OPENROUTER_API_KEY` and two Telegram values — no hub credential. `secrets.nix`'s "Personal
  MCP access" comment is stale and is why it appeared on this list at all.
