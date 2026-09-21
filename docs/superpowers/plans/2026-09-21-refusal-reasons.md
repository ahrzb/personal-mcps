# Why a call was "not permitted" — the dispatch brief (2026-09-21)

The owner, reading `/audit` on the live hub: *"can the codes come with some actual
description"*, then, offered a recorded cause for `-32001`: *"that would be nice"* and *"having
a 'why' there would make things easier to understand/debug"*. This brief is that feature. It
reverses one sentence of §7 (written the same day, conservatively, before the owner ruled):
*"the `-32001` refusals this section makes indistinguishable gain no `reason` — the ledger
never becomes the oracle a refusal withholds."*

Everything here is decided. An agent that finds a contradiction between this brief and the code
as it stands stops and reports it.

## 1 · The rule

**The wire does not change. The ledger learns the cause.** Every `-32001` the consumer doors
emit stays byte-identical — `{ code: -32001, message: "tool not permitted" }`, no `data` —
whatever caused it *(the one pre-existing exception, untouched: `approval_decide`'s "no
decidable approval request", an owner-side op with its own message — caught by the specs
agent)*, so a probing agent still cannot map its grants, enumerate a namespace, or learn that
an app is real. The cause rides `HubError.auditDetail` — the road `failureClass` already rides
for `-32000` (`errors.ts`; `gateway.dispatchTool`'s catch MERGES `err.auditDetail` into the
row's `detail`) — and lands as **`detail.reason`** on the audit row. `toWire` serializes `code`,
`message` and `data` alone, so it never reaches a consumer.

Why this is safe to record: the ledger is the owner's. An `agent` principal reaches no audit
read at all — `adminOpsFor` gives it the empty set, `/audit` and `/api/hub/audit*` need the
owner's session, and the only machine credential that reads the ledger is the owner's own admin
token. The oracle the refusal withholds stays withheld from the caller it was withheld from.

Hygiene (§15): `reason` is a **closed vocabulary** — a class, never free text, never a name the
caller typed beyond what the row already records (`app`, `tool`).

## 2 · The vocabulary

`errors.ts` (the leaf) exports `type RefusalReason` and `notPermitted(reason: RefusalReason)` —
the argument is **required**, so the compiler finds every call site and no future one can forget.
The factory sets `auditDetail = { reason }`; the message stays the pinned one.

| `reason` | Thrown where | Short words (list rows) | Sentence (the record) |
|---|---|---|---|
| `no_app` | the slug resolves to no app this caller can see *(not "an aggregate name with no prefix" — §23.1 removed the aggregated namespace; those names land on the hub's own filter, `no_grant`, or its tool lookup, `not_in_catalog` — server agent's finding)* | no such app | The name leads to no app this caller can see — a typo, a deleted app, or a prefix that matches nothing. |
| `app_changed` | §23.6: `expectAppId` no longer matches (hub program) | app changed mid-program | The name now points at a different app than when the program that made this call started. |
| `no_grant` | the access filter answers `deny` (tools, prompts, resources, the hub's own fixed list) | no grant reaches it | The app exists, but no grant this caller holds reaches this tool. |
| `not_in_catalog` | the backend has no catalog entry for the subject (incl. the hub's own tools / resources answering null) | not in the app's catalog | The app's catalog has nothing by this name — a wrong name, or an app that has not re-registered since it gained it. |
| `unsound_schema` | the tool is cached schema-unsound, so no redaction map can be derived | schema can't be masked | The tool's schema cannot be masked safely, so the hub will not run it; the violation was reported to the app when it registered. |
| `credential_lapsed` | §23.4: `requireSamePrincipal` fails mid-program | credential lapsed mid-program | The credential was revoked, expired or rebound while the program that made this call was still running. |
| `op_withheld` | `admin.ts`: the op is not in `adminOpsFor(principal)` (unknown op → `not_in_catalog`) | op withheld from this credential | This kind of credential may not run this admin op. |
| `not_decidable` | `approvals.ts`: "no decidable approval request" (its own message stays) | nothing to decide | There is no pending approval request here for this credential to decide. |
| `wrong_endpoint` | an admin credential on the aggregate `/mcp` | wrong endpoint for this credential | This credential is not admitted at this endpoint. |

`not_in_catalog` vs `unsound_schema`: `AppBackend.sensitivePaths` answers bare `null` for both
today. It now says which (a discriminated result, not a second read) — the backend already knows
at the point it returns. If a backend genuinely cannot tell, it answers `not_in_catalog` and the
agent reports where.

Which paths write an audit row is **unchanged** and not this brief's business: a path that
leaves no row today (e.g. the aggregate's early admin refusal) still leaves none; its reason is
simply never stored. The server agent lists, in its report, every `notPermitted` site with its
reason and whether a row is written there.

## 3 · The page (`web/src/features/audit`)

- **Outcome words** (§13 "A code never stands alone"): the `-32001` sentence becomes
  `The hub refused this call. <reason sentence> The caller was told only "not permitted" — every
  cause gets the same answer.` (a full stop, not a colon: the reason sentences start with a
  capital) A row with **no** `detail.reason` (everything recorded before this
  ships) keeps today's sentence, ending "…rows recorded before 2026-09-21 do not say which." A
  reason the page does not know prints as its raw token: `Recorded cause: <token>.` The label
  stays **not permitted**; the class stays **denied**.
- **Events**: a `-32001` row's third line prints the reason's SHORT WORDS instead of the
  `reason=no_grant` detail pair, and a `-32000` row's prints its `failureClass` HUMANIZED
  (underscores to spaces: "needs reconnect") instead of `failureClass=needs_reconnect` — one
  list must not mix words and raw pairs (other detail pairs unchanged; the one absorption: a
  numeric `detail.upstreamStatus` beside `failureClass: "upstream_status"` reads "upstream status
  502" and its pair is not printed again). On the phone the card
  keeps its third line when it is the row's OWN EVIDENCE — the arguments preview or the recorded
  cause, the two things the signature splits on — and drops it otherwise *(boards agent's
  reading, accepted)*. **Sessions**: a waterfall line's right-hand text is the outcome label plus
  the recorded cause in the same words. The run signature's sixth field
  becomes *the recorded cause* — `detail.failureClass` on `-32000`, `detail.reason` on `-32001` —
  because two refusals with different causes are two different facts.
- **Summary → Refusals**: grouped by (principal, app/tool, **cause**), each line ending in the
  short words; the "worth a look" refusal insight names the cause when the group has one.
- No new facet, no new filter, no URL key — search already reaches `detail` server-side, so
  typing `no_grant` finds them. *ponytail: a Cause facet if the owner starts filtering by it.*

## 4 · Boards (`design/**`)

The demo week's `-32001` rows gain honest reasons: `agent:cron`'s 230 `news/search_news`
refusals are `no_grant`; the rest a believable mix (`no_grant` mostly, a few `not_in_catalog`,
one `no_app`, one `unsound_schema`); a handful keep NO reason so the pre-ship sentence is drawn
too. Boards to refresh: the refused record on `AuditDetailStates` (one WITH a reason, one
without), Events rows and Summary's Refusals on `Audit` / `AuditViews` / `MobileAudit`. Board
notes say the wire is unchanged and why the ledger may know.

## 5 · Specs (`docs/specs/**`)

§7: the quoted sentence is reversed by a dated amendment carrying the owner's words; the
indistinguishability rule is restated as a rule about the WIRE. §15: `detail.reason`, the closed
vocabulary and its hygiene, beside `failureClass`. §5: `detail` may carry `reason`. §13: the
outcome-words table gains the nine sentences, the no-reason fallback and the unknown-token
fallback; Events and Summary amendments. §18: **decision 37**. §16 / testing/03: the rows below.

## 6 · Tests

Server (worker suite, beside the existing indistinguishability rows): for each reason reachable
through a consumer door, the refusal leaves ONE row with that `detail.reason` and no bodies; the
JSON-RPC error objects of `no_app`, `no_grant`, `not_in_catalog` and `unsound_schema` are
**deep-equal to each other** and contain no `reason` anywhere; a `-32000` after a claim still
carries `failureClass` + `approvalId` (the merge is untouched). Web (`audit-derive.test.ts`):
the nine sentences verbatim, the no-reason and unknown-token fallbacks, the short words on the
preview line, the signature splitting on cause, Refusals grouping by cause.

## 7 · Ownership and order

| Agent | Owns |
|---|---|
| `specs` | `docs/specs/**` |
| `server` | `server/**` except `server/test/unit/audit-derive.test.ts`; `cli/**`; `contracts/**` |
| `boards` | `design/**` except `design/baseline/**`; `docs/superpowers/plans/tools/capture-audit.mjs` |
| `web` | `web/**`; `server/test/unit/audit-derive.test.ts`; `design/baseline/audit__*.png` |
| orchestrator | this brief, `test-inventory.json`, root `package.json`, commits, gate, ship |

`specs`, `server` and `boards` run together; `web` starts when `boards` reports (the fixture
week is generated from the demo's data). No agent commits, runs a git write command, or runs the
full suite; each stops any server it starts. **Two ships**: the server first (rows start carrying
reasons; the page shows them as a detail pair meanwhile), then the page.
