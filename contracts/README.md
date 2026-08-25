# `contracts/` — the cross-language wire fixtures

The spec deliberately **copies** wire shapes across boundaries instead of sharing a
package: `cli/src/main.ts` re-declares the whoami response and the error codes,
`scripts/users.ts` re-declares the bootstrap bodies, and both client libraries re-state
the close-code policy in their own language. That duplication is a choice — a shared
types package would couple a Python library to a TypeScript build — but a copy with no
oracle drifts silently.

These JSON files are that oracle. Every copied shape answers to one checked-in fixture:
the server proves it emits it, and a consumer suite proves it reads it. The second half is
per-family and currently partial — the table below says which families have a reader and
which do not.

Plain JSON is also a choice. Neither side can `import` a type from a `.json` file, so the
copies stay copies — the fixture pins the *shape*, never the declaration.

---

## The fixture families

Per the testing strategy §4, which pins **eight** families. Each family names one
boundary, and each has exactly one producer.

The **Read by** column names the suites that actually open the file — not the surfaces the
shape is copied into. The distinction is load-bearing: a family whose only reader is the
producer is pinned on the emitting side and on the consumer's *types*, but nothing yet
proves a consumer parses it (see "Families no consumer suite reads yet" below). Claiming
otherwise here would make this table the drift it exists to prevent.

| Family | Pins | Read by |
|---|---|---|
| whoami | `GET /api/whoami`'s `{ principal, namespace }` for both credential kinds, and the 401 | producer only — `cli`'s `WhoamiResponse` is pinned as a *type* in `contracts.test.ts` |
| error codes | the five JSON-RPC codes (§7) and the `-32003` `data` shape | producer only — `cli`'s `HUB_ERRORS` and `ApprovalRequiredData` are pinned as types there |
| tunnel frames | `hub/register` and its ack, `hub/replaced`, the forwarded-call `_meta` key names (§6, §7) — emitted from `tunnel.ts`'s exported `HUB_METHODS` | `clients/js/test/contracts-consumer.test.ts`, `clients/py/tests/test_contracts.py` |
| close codes | close code → **required client behavior**, one of `stop_fatal` / `stop_quiet` / `reconnect`, plus a `schedule` attribute (`exponential` / `max_only`) on the entries that reconnect (§6's upgrade matrix and 4000–4004) — emitted from `tunnel.ts`'s exported `CLOSE_*` vocabulary | the same two consumer suites, plus the two reconnect tables that transcribe it |
| bootstrap | the `POST /internal/users` request and response bodies per op (§12) | `scripts/test/bootstrap-contract.test.ts` |
| admin ops | op names and their rendered input/output schemas (§8) | producer only — parity directions C/D read `ops` and the CLI command table directly |
| planner rows | the `service_list` / `account_list` row shapes the diff planner reads (§8, §9) | producer only — `cli/test/plan.test.ts` builds `CurrentState` from literals |
| audit body stubs | the wire spelling of the two typed size stubs §15 defers to this directory: the `blob` stub an unstructured result block collapses into and the `oversize` stub that replaces a whole over-cap body — the discriminator, the field names, and which fields carry a variable value | `server/test/worker/hygiene.test.ts` (its `BodyColumnShape` / `BodyStub` rows), and any client-side renderer of a recorded body |

The close-code family is the one whose *content* is behavior rather than shape: it maps a
code to what a client must do. That is **three** behaviors — `stop_fatal`, `stop_quiet`,
`reconnect` — and a separate `schedule` attribute, `exponential` or `max_only`, on the
entries that reconnect. "Retry at max backoff" is therefore a *schedule* of `reconnect`,
not a fourth behavior: the two axes are independent, and collapsing them would make the
vocabulary describe a client's timer instead of its decision. Both client libraries
transcribe this one vocabulary into their own reconnect-policy table — their row types
carry the schedule as its own column for exactly this reason. That duplication is
deliberate and the fixture is what keeps the two languages from disagreeing.

The audit-body-stub family is the one whose consumer is *inside the server*. §15 pins that
an unstructured block and an over-cap body become typed stubs, and deliberately does not
spell them — the fixture is the spelling. `hygiene.test.ts` transcribes it into
`BodyColumnShape`, so the audit page, the JSONL export, and any client rendering a
recorded body all answer to one shape rather than to whatever `audit.ts` emitted first.
It is a contract for the same reason the others are: the recorder writes the stub and
something else reads it, with no shared declaration between them.

**Families no consumer suite reads yet.** whoami, error codes, admin ops and planner rows
are produced and type-pinned, but no consumer suite opens the JSON. That is a recorded
gap, not a hidden one — `contracts.test.ts` states it as a row property ("a family with
none is a fixture nobody needs — the emptiness is itself a finding"), and the honest place
for it to surface is `ContractFamily.consumers` going empty for those rows. `cli/test/`
currently holds only `plan.test.ts`, whose deps line reads `none`; a CLI consumer suite
that reads whoami, the error codes, and the ops schemas is the work that closes this.

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

**Consumers are read-only.** Today that is `clients/js/test/contracts-consumer.test.ts`,
`clients/py/tests/test_contracts.py` (close codes and tunnel frames), and
`scripts/test/bootstrap-contract.test.ts` (bootstrap); `server/test/worker/hygiene.test.ts`
reads the audit body stubs from inside the server. `cli/test/` reads none yet — see the
gap noted above. Whichever suite reads a fixture, it asserts against it and never writes:
a consumer that needs a fixture changed has found either a bug or a spec question — see
below — never a reason to write.

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

## Parity directions C and D

Two of the four parity invariants (§8's "anything the UI or CLI can do has a `pmcp` tool")
are checked here, because both sides are data:

- **Direction C** — every step the CLI's diff planner can emit maps to an ops key, with
  that op's schema-required fields present in the step's arguments.
- **Direction D** — every non-auth CLI subcommand maps to an ops key, **total in both
  directions**: no subcommand without an op, no op unreachable from the CLI.

Directions A (every op renders as a `pmcp` tool) and B (web form fields come from the same
zod schema) live in `admin-ops.test.ts` and `web-pages.test.ts`, where the other side of
each mapping lives.
