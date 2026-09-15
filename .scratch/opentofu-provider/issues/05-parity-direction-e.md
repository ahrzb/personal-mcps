# Specify parity direction E and decide where its manifest lives

Part of [Map: OpenTofu provider for the hub](../map.md)

Type: grilling
Status: resolved
Blocked by: 04

## Question

The provider lives in another repo, so a change here can outrun it silently. This repo already
has the exact mechanism for that problem, and it has a name: **parity directions**
(`contracts/README.md`, §8's "anything the UI or CLI can do has a `pmcp` tool").

- **A** — every op renders as a `pmcp` tool (`admin-ops.test.ts`)
- **B** — web form fields come from the same zod schema (`web-pages.test.ts`)
- **C** — every diff-planner step maps to an ops key with required fields present
- **D** — every non-auth CLI subcommand maps to an ops key, **total in both directions**

This ticket defines **direction E**: every admin op, and every field of every op, maps to a
provider resource/attribute or is explicitly listed as unmanaged — total in both directions, so
a provider attribute with no op is also a failure.

Settle:

1. **Where the manifest lives.** `contracts/` carries hard governance: one writer
   (`server/test/worker/contracts.test.ts`), owner-authored, **agents never author fixture
   content**, and CI **rejects any commit touching `contracts/**` alongside implementation
   files**. A provider-coverage manifest is a hand-maintained list of deliberate decisions, which
   is not the same thing as a generated wire fixture. Does it become a ninth fixture family, a
   non-fixture checked-in file elsewhere, or a table inside the spec that a test parses?
2. **What "unmanaged" looks like.** Approvals, OAuth connections, and users are out of scope by
   decision. They still need an explicit row saying so, with a reason, or direction E is just a
   failing test everyone learns to ignore.
3. **Field granularity.** Op-level coverage is cheap and weak; field-level catches the real
   case — someone adds a field to `app_update` and the provider silently cannot set it. Field
   level means tracking `contracts/admin-ops.json`'s rendered input schemas, which change shape
   when zod schemas change. Is that sustainable?
4. **Which side fails.** The tripwire here can only see this repo. It can assert the manifest
   covers the ops; it cannot assert the *provider* matches the manifest — that check belongs in
   the provider repo against a pinned copy. Define both halves and how the copy is pinned
   (flake input? vendored JSON? a version constraint?).
5. **Failure ergonomics.** When someone adds an op, what exactly do they see, and what is the
   documented one-line fix? A tripwire whose remedy is unclear gets deleted.
6. **Documentation duty.** Where in `docs/specs/**` the provider is described so a session
   changing the admin surface encounters it. This is the "don't let it become an unknown unknown"
   requirement, and a test alone does not satisfy it.

## Answer

[§22.5](../../../docs/specs/provider/22-opentofu-provider.md). The mechanism went through three
shapes before one survived, and the discarded two are instructive.

**Rejected: a hand-written `PROVIDER_COVERAGE` table in this repo.** It would be its own oracle
— the session adding an op satisfies it by editing the list, with `unmanaged: <reason>` accepting
any prose. This repo had already diagnosed that exact shape for direction D, whose `COMMANDS`
table was fixed by `cli/test/commands.test.ts` driving the real `main(argv)`.

**Rejected: `tofu providers schema -json`.** Schema output lists attributes but not which op a
CRUD path calls, and the mappings here are deliberately non-isomorphic — `archived` →
`app_archive`, `grant_set.roles` → two attributes, `headers_version` → no admin input at all,
`app_update` → two resource types.

**Adopted:** the `httptest` fake's request recorder, driving real Create/Read/Update/Delete and
capturing `(resource, action, op, argument fields)`. Three assertions — per-path sequences, **all
input fields** (not just required, since `app_update`'s useful controls are mostly optional), and
totality against an enumerated `unmanaged` list. The fake validates requests against
`admin-ops.json`'s `inputSchemas`, so it cannot drift into accepting what `parseInput` rejects.

**(1)** It lives in the provider repo, not `contracts/` — governance there forbids writing and
sanctions read-only consumers, and C and D already keep their tables outside the fixtures; the
placement was never the problem, the missing oracle was. **(2)** The unmanaged rows are
enumerated in §22.5 rather than left to the test author. **(3)** Field-level, all fields.
**(4)** Gating happens **here** via `nix run …#coverage-check -- ./contracts/admin-ops.json`,
which needs a read credential for the private provider repo. **(5)** The failure message names
the op or `op.field` and states both remedies verbatim. **(6)** `contracts/README.md` and §8 get
the pointers; `admin-ops.json` finally gains a consumer, closing a gap that file records today.

The subtle part is the **two-repo landing order**. An asymmetric check (fixture-ahead fails,
provider-ahead passes) is necessary but insufficient, because the fake validates against a
fixture whose op schemas set `additionalProperties: false`. So staging is *declared* in
`coverage/staged.json`, validation is skipped only for declared entries — a typo still fails —
and the expiry rule ("a staged entry the fixture caught up to must go") runs **only in the
provider's own CI against its own pin**, never from the hub's invocation. That is what keeps all
three landings unblocked instead of deadlocked at cleanup.
