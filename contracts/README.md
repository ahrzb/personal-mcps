# `contracts/` — the cross-language wire fixtures

The spec deliberately **copies** wire shapes across boundaries instead of sharing a
package: `cli/src/main.ts` re-declares the whoami response and the error codes,
`scripts/users.ts` re-declares the bootstrap bodies, and the client libraries re-state
the close-code policy in their own languages. That duplication is a choice — a shared
types package would couple independent package builds — but a copy with no
oracle drifts silently.

These JSON files are that oracle. Every copied shape answers to one checked-in fixture:
the server proves it emits it, and a consumer suite proves it reads it. The second half is
per-family and currently partial — the table below says which families have a reader and
which do not.

Plain JSON is also a choice. Neither side can `import` a type from a `.json` file, so the
copies stay copies — the fixture pins the *shape*, never the declaration.

---

## The fixture families

Per the testing strategy §4, these are **ten** families. Each family names one
boundary, and each has exactly one producer.

The **Read by** column names the suites that actually open the file — not the surfaces the
shape is copied into. The distinction is load-bearing: a family whose only reader is the
producer is pinned on the emitting side and on the consumer's *types*, but nothing yet
proves a consumer parses it (see "Families no consumer suite reads yet" below). Claiming
otherwise here would make this table the drift it exists to prevent.

| Family | Pins | Read by |
|---|---|---|
| whoami | `GET /api/whoami`'s `{ principal, namespace }` for both credential kinds, and the 401 | producer only — `cli`'s `WhoamiResponse` is pinned as a *type* in `contracts.test.ts` |
| initialize | the hub's fixed handshake capability picture and the four scoped application capability pictures (§7, §20, §21, §23) | producer only — consumer capabilities are pinned as types and behavior |
| error codes | the six JSON-RPC codes (§7) and their data shapes | producer only — `cli`'s `HUB_ERRORS` and `ApprovalRequiredData` are pinned as types there |
| tunnel frames | `hub/register` and its ack, `hub/replaced`, the forwarded-call `_meta` key names (§6, §7) — emitted from `tunnel.ts`'s exported `HUB_METHODS` | `clients/js/test/contracts-consumer.test.ts`, `clients/py/tests/test_contracts.py`, `clients/go/pmcp_test.go` |
| close codes | close code → **required client behavior**, one of `stop_fatal` / `stop_quiet` / `reconnect`, plus a `schedule` attribute (`exponential` / `max_only`) on the entries that reconnect (§6's upgrade matrix and 4000–4004) — emitted from `tunnel.ts`'s exported `CLOSE_*` vocabulary | the same three consumer suites and their reconnect tables |
| bootstrap | the `POST /internal/users` request and response bodies per op (§12) | `scripts/test/bootstrap-contract.test.ts` |
| admin ops | op names and their rendered input/output schemas (§8) | `cli/test/commands.test.ts` and the provider parity check (§22.5) |
| audit body stubs | the wire spelling of the two typed size stubs §15 defers to this directory: the `blob` stub an unstructured result block collapses into and the `oversize` stub that replaces a whole over-cap body — the discriminator, the field names, and which fields carry a variable value | `server/test/worker/hygiene.test.ts` (its `BodyColumnShape` / `BodyStub` rows), and any client-side renderer of a recorded body |
| push frames | three bare list-changed notifications and the URI-bearing resource update frame (§21) | producer only — client relays are pinned as behavior |
| hub | the §23 hub's whole wire surface: the aggregate `hub_execute` / `hub_search_types` and the scoped `execute` / `search_types` names with their complete input/output JSON schemas, the two declaration resources and four declaration templates, and the numeric limits — emitted from `hub-contract.ts`'s exported producers | producer only — the hub router's refusals and allow-twins are pinned as behavior |

The close-code family is the one whose *content* is behavior rather than shape: it maps a
code to what a client must do. That is **three** behaviors — `stop_fatal`, `stop_quiet`,
`reconnect` — and a separate `schedule` attribute, `exponential` or `max_only`, on the
entries that reconnect. "Retry at max backoff" is therefore a *schedule* of `reconnect`,
not a fourth behavior: the two axes are independent, and collapsing them would make the
vocabulary describe a client's timer instead of its decision. Each client library
transcribes this one vocabulary into its own reconnect-policy table — its row types
carry the schedule as a separate column for exactly this reason. That duplication is
deliberate, and the fixture keeps the languages from disagreeing.

The audit-body-stub family is the one whose consumer is *inside the server*. §15 pins that
an unstructured block and an over-cap body become typed stubs, and deliberately does not
spell them — the fixture is the spelling. `hygiene.test.ts` transcribes it into
`BodyColumnShape`, so the audit page, the JSONL export, and any client rendering a
recorded body all answer to one shape rather than to whatever `audit.ts` emitted first.
It is a contract for the same reason the others are: the recorder writes the stub and
something else reads it, with no shared declaration between them.

The hub family is the one whose producer is a *pure module* rather than a captured
surface: §23 gives the hub's tool names and declaration vocabulary one home in
`hub-contract.ts`, while the numeric runtime caps live as named constants in
`server/src/limits.ts`; `contracts.test.ts` freezes their composed snapshot as
`contracts/hub.json`. The hub that serves those names is built from the same
exports, so the fixture pins the vocabulary — the file's cases re-read the composed value
against each individual export, and against §23's own spellings, so a renamed or dropped
declaration fails there rather than becoming the standard by default.

**Families no consumer suite reads yet.** Whoami, initialize, error codes, push frames, and
hub are produced and type- or behavior-pinned, but no consumer suite opens their JSON
fixtures. That is a recorded gap, not a hidden one: `contracts.test.ts` leaves their
`ContractFamily.consumers` empty.

---

## Governance

**One writer.** `server/test/worker/contracts.test.ts` is the only file that writes
anything here. It asserts the server's real emissions deep-equal each fixture, and
regenerates them when run in update mode. Nothing else — no script, no client suite, no
agent — writes to this directory.

That is literally true rather than approximately, because `tunnel.ts` **exports** its wire
vocabulary — `CLOSE_REPLACED` / `CLOSE_ROW_GONE` / `CLOSE_PROTOCOL` beside the
`SeverCode` pair, and `HUB_METHODS` for the `hub/*` control-frame names. Those values are
a published cross-language contract, not module-private mechanics, so the close-code and
tunnel-frame fixtures are emitted from them in the same suite as every other family. No
sibling module imports the vocabulary; the one place it is checked against a live socket
is `server/test/tunnel/protocol.test.ts`, which asserts that the codes and method names
observed on the wire equal the exports. One definition, one emitter, one behavioral
witness.

**Regeneration is `pnpm contracts:update`.** It runs that one suite in update mode.
Never hand-edit a fixture to make a test pass; that is the failure mode this whole
directory exists to prevent.

**Consumers are read-only.** Today those are
`clients/js/test/contracts-consumer.test.ts`, `clients/py/tests/test_contracts.py`,
`clients/go/pmcp_test.go` (close codes and tunnel frames),
`scripts/test/bootstrap-contract.test.ts` (bootstrap),
`cli/test/commands.test.ts` (admin operation schemas), and
`server/test/worker/hygiene.test.ts` (audit body stubs). A consumer asserts against a
fixture and never writes it.

**Fixtures are owner-authored, and always their own commit.** Strategy §9 rule 1: the
oracle lands separately from the implementation that satisfies it. CI rejects any commit
touching `contracts/**` together with implementation files. A commit that changes a
fixture *and* the code it pins is indistinguishable from someone making a test pass, so
the tooling refuses to let it be either.

**Agents never author fixture content.** They write runners, harnesses, and
implementations. A fixture is the sentence the implementation is judged against; an agent
writing both is grading its own paper.

---

## What a fixture may and may not contain

- **No secrets.** No plaintext token, password, session value, or upstream credential —
  ever, in any family. `token_issue`'s key is a `writeOnly`-marked output field precisely
  so the uniform masking rule (§15) covers it here too.
- **Nothing that varies per run.** No row ids, no timestamps, no generated slugs. A
  fixture that changes when nothing changed is a fixture nobody trusts. Where a shape
  genuinely carries a variable value, the fixture pins the *key* and the value's type,
  not the value.
- **Shapes, not prose.** Error *messages* are incidental (§7's durable/incidental rule);
  error *codes* and the presence of `approvalUrl` are durable. Pin the second, never the
  first.

---

## When the producer suite goes red

The commit type declares the diagnosis (strategy §8), and the fixture makes the diagnosis
nearly automatic — a spec change touches fixtures, a code regression touches none:

- **`fix:`** — the server emitted the wrong thing. The fixture is right; change the code.
- **`spec:`** — the shape genuinely changed. The fixture **and the spec line** change in
  the same commit, and that commit touches no implementation file.
- **`test:`** — the fixture mis-transcribed the spec. Spec unchanged.

---

## Parity direction D

Direction D of §8's parity invariant is checked here because both sides are data: every
non-auth CLI subcommand maps to a served admin operation or a named MCP method.

Directions A (every op renders as a `pmcp` tool) and B (web form fields come from the same
zod schema) live in `admin-ops.test.ts` and `web-pages.test.ts`, where the other side of
each mapping lives.
