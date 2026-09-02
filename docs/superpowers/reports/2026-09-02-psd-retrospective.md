# PSD as a review lens — what fourteen dispatches of it actually did (2026-09-02)

> **Sources.** Every workflow run under `~/.claude/projects/C--Users-AmirHossein-repos-github-com-ahrzb-personal-mcps/<session>/` that carried a PSD review stage: its `journal.jsonl` result lines, its reviewer and fixer `agent-*.jsonl` transcripts, and the dispatch ledger (`docs/superpowers/plans/2026-08-25-implementation-orchestration.md`, dated entries). Counts below are from the reviewers' own severity fields and the fixers' own dispositions, not from the ledger's prose; where the two disagree, § 5 says so. Current-tree checks were run against `HEAD` = `c166772`.
> **Totals.** 13 PSD runs across 12 dispatches, **169 findings**, 43 at the top severity (high / must / blocker), **125 fixed**, 10 refused with a reason, 1 accepted-as-is, **33 with no disposition anywhere**.

## 1. Coverage

| Dispatch | Run | Gated | Findings | High/must | Fixed | Rebutted | Accepted | No disposition |
|---|---|---|---|---|---|---|---|---|
| D2 pure core | `wf_b4bb2c2c-130` | 2026-08-25 14:20 | 4 | 1 | 4 | 0 | 0 | 0 |
| D3 data layer | `wf_307a7f81-08b` | 2026-08-25 16:00 | 9 | 2 | 8 | 0 | 0 | 1 |
| D4 gateway/admin/approvals | `wf_846aae6a-485` | 2026-08-25 19:30 | 23 | 4 | 18 | 2 | 0 | 3 |
| D5 upstream/cron/hygiene | `wf_35c6dac9-a39` | 2026-08-25 22:45 | 19 | 4 | 14 | 0 | 0 | 5 |
| D6 tunnel DO | `wf_ff7f8cbf-d5b` | 2026-08-26 02:45 | 25 | 8 | 19 | 2 | 0 | 4 |
| D7 live wire | `wf_d6167336-02f` | 2026-08-26 04:40 | 8 | 2 | 6 | 0 | 0 | 2 |
| D8 CLI + clients | `wf_c98880bb-7a5` | 2026-08-26 11:15 | 26 | 5 | 19 | 0 | 0 | 7 |
| D9 web + push | `wf_1d5bdd17-f9a` | 2026-08-26 13:25 | 14 | 4 | 6 | 2 | 1 | 5 |
| D11 remediation | `wf_c65b03d1-52b` | 2026-08-26 | 5 | 3 | 5 | 0 | 0 | 0 |
| D11 PSD-remediation | `wf_d918fc31-904` | 2026-08-26 | 7 | 3 | 1 | 0 | 0 | 6 |
| D13 data model | `wf_7a558f86-783` | 2026-08-27 | 15 | 5 | 11 | 4 | 0 | 0 |
| D15 panes | `wf_7bc03268-0f5` | 2026-09-02 | 14 | 2 | 14 | 0 | 0 | 0 |
| D16 test speed | `wf_614da06f-00a` | not gated | **0** | — | — | — | — | — |
| | | | **169** | **43** | **125** | **10** | **1** | **33** |

**Dispatches with no verifiable PSD stage.** D1, DV, D10, D12, D13.1, D14, D16.

- **D10** is titled "cross-module PSD" in the dispatch table (ledger :130), but its checked-in script `.claude/workflows/d10-sweep.js` contains no PSD mention and its four lenses are *seam* lenses (registry↔gateway, gateway↔tunnel, identity↔custody, pages↔web) plus a coverage critic. Loose labelling: D10 ran an adversarial sweep, not the PSD skill.
- **D12** ledger (:975-977) records "a two-agent adversarial PSD (both PASS)" — zero findings — but its implementation workflow has no directory in the inventory; only `wf_92e10f8f-2d1` (spec-blocker fix, 2 agents, no reviewer) survives. The claim is unverifiable from the records.
- **D14** ledger (:1077-1079) records "15 from the PSD lens (11 fixed, 4 rebutted with reasons written down)" — numbers *identical* to D13's, for a different dispatch — and names no run id. No D14 run appears in any session's `workflows/scripts/`. Either a coincidence or a restatement; the record cannot tell.
- **D16** ran a reviewer (`a17085580b69d2333`) that **died mid-investigation** at 2026-09-02T21:19:58Z on an in-flight Bash call: `started` in the journal, no `result`, no `StructuredOutput`, no final message. Zero findings delivered, no fixer stage, no ledger entry. Its thinking blocks show five near-findings in flight, including a **must**-level one: `stream.test.ts:611` failed 3 of 8 post-cause-1 runs, so the DoD's green checkboxes rest on single runs of a suite failing ~1-in-3.

## 2. What PSD found, by category

Categories are the reviewers' own words. Findings carrying two flags are counted under the first.

| Category | Count | Dispatches it appears in | Recurs? |
|---|---|---|---|
| **Information Leakage** (incl. back-door) | 45 | D2 D3 D4 D5 D6 D7 D8 D9 D11×2 D13 D15 | **every run** |
| **Nonobvious Code** | 32 | D2 D3 D4 D5 D6 D8 D11b | 7 of 12 |
| **Repetition** | 30 | D3 D4 D5 D6 D7 D8 D9 D11a D13 D15 | **10 of 12** |
| Pass-Through Method / Variable | 9 | D3 D4 D5 D6 D8 D9 D13 | 7 of 12 |
| Vague Name / one-name-two-concepts | 8 | D4 D7 D8 D13 D15 | 5 of 12 |
| Overexposure | 8 | D4 D5 D6 D7 D8 D11×2 | 6 of 12 |
| Comment contradicts / contaminates interface | 9 | D3 D7 D8 D9 D11b (D16 in flight) | 5 of 12 |
| Over-masking | 5 | D5 D7 D8 D15 | 4 of 12 |
| Special-General Mixture | 5 | D4 D5 D7 D8 | 4 of 12 |
| False abstraction | 5 | D7 D8 D13 D15 | 4 of 12 |
| Shallow Module | 4 | D6 D13 D15 | 3 of 12 |
| Temporal Decomposition | 2 | D4 D5 | 2 of 12 |
| Consistency / Conjoined / Hard to Describe / Dead flexibility / Fail-open | 7 | scattered | — |

**Information Leakage recurs in every single run and Repetition in ten of twelve. That is the headline.** The prevention is not sticking: the same shape — one decision spelled in N places, nothing binding the copies — is found, named, fixed, and then found again in the next dispatch's diff, against new code written after the previous fix. Three concrete instances a dispatch apart:

- **D3** `server/src/registry.ts:1074` — the D1 binding shape redeclared in `registry.ts`, `identity.ts` and `admin.ts`, three different subsets. Fixed into one `D1Like` in `workers-env.d.ts` (ledger :581 "one global D1Like").
- **D5** `server/src/index.ts:280` — the `pmcp_(sa|svc)_` token grammar spelled in four places (`identity.TOKEN_PREFIX`, `index.TOKEN_GRAMMAR`, `hygiene.test.TOKEN_MATERIAL`, and Sentry fixture literals), so rotating the prefix silently breaks the log scrubber while every suite stays green because the test transcribed the same literal. Fixed into `principal.ts` (`TOKEN_PREFIX`/`tokenPattern`), not `identity.ts` as the finding spelled it — a real import cycle forced the move.
- **D15** `server/src/gateway.ts:766` — `ownerPrincipal`, the **fourth verbatim copy** of the id→username D1 lookup, colliding in name with `upstream.ts`'s differently-typed `ownerPrincipal`. Deleted for `admin.owner`, verified on disk (`gateway.ts:37` imports `owner as namespaceOwner`).

Repetition examples with the same arc:

- **D4** `server/src/gateway.ts:748` (high) — the redaction map derived twice in one call pipeline (`passGate`, `callBodies`), so the approval row and audit row of the same call could be masked under different maps. Derived once at the top of `callTool`.
- **D9** `server/src/web.ts:150` (high) — `requireOwnerSession → formData → checkCsrf → refused` copy-pasted at **five** call sites, so the CSRF guarantee held only while all five stayed in sync. Collapsed into one `mutation(fn)`; `checkCsrf` now called from exactly one place.
- **D15** `server/src/pages/app-detail.tsx:95` — `formatLastSeen` plus four constants copied verbatim from `apps.tsx`, against D15's own just-established pattern of extracting shared chrome. Fixed by creating `server/src/pages/format.ts`.

Nonobvious Code was where the *behavioural* bugs hid, not just reader cost:

- **D2** `registry.ts:429` — the `$defs` walk is 2^n in sharing depth, measured 6/181/2870 ms at 10/16/20 levels; `validateSchemaIndirection` accepted such a schema with zero violations while never returning at ~30 levels, **over schemas supplied by a registered service**. Memoized: 20 levels 2804 ms → 1 ms, 1000 levels "does not return" → 11 ms.
- **D8** `cli/src/main.ts:990` — `confirm()` only resolves off a stdin `data` event, so off a TTY `pmcp apply` **applied nothing and exited 0**. Now refuses and exits 1 with the plan on screen.
- **D8** `cli/src/main.ts:886` — the documented `-f` short flag never worked; `pmcp apply -f prod.yaml --yes` silently applied `mcps.yaml`'s plan, deletes included.

## 3. Refusals, and whether the reason holds

Eleven findings were refused (10 rebutted, 1 accepted-as-is). Read against the current tree:

| # | Finding | Reason given | Holds? |
|---|---|---|---|
| 1 | D4 `gateway.ts:535` — bare `catch{}` makes a hub bug indistinguishable from upstream downtime | rethrow contradicts §7's "the aggregate itself always succeeds", and broke `tunnel.ts`'s unimplemented `listTools` (out of fence) | **Holds, and improved.** `gateway.ts:823-836` now narrows by class *and* logs `pmcp/fan-out: hub defect` distinctly from `pmcp/unavailable`, with the §7 reasoning written at the catch. The finding's real complaint (a defect looks like downtime) is answered without the rethrow. |
| 2 | D4 `auth-matrix.test.ts:1050` — allow rows re-derive the principal instead of reading the response | two rows (`/account`'s 501 stub, scoped `/mcp/<granted>`) have no oracle; the fix needs edits to locked rows | Holds as stated; the ceiling is named in the contract comment rather than passing as an oracle. Correct disposition for a fenced dispatch. |
| 3 | D6 `approval-e2e.test.ts:396` — `CasStep`'s `checked`/`claimed` columns encode interleavings the runner cannot produce | fixer **confirmed the defect is real**; both fixes are out of fence (rewriting 9 owner-authored rows, or new production code in `approvals.ts` built solely for a test) | Holds procedurally, but this is a defect deferred, not refuted — and nothing carried it forward. |
| 4 | D6 `contracts.test.ts:1016` — ten property cases re-compare what the snapshot case already deep-equals | 8 of 10 have **locked titles that literally assert the comparison**; two have no body beyond it | Holds. The right answer needed a title change, which the regime forbade. 2 of 10 were trimmed. |
| 5 | D9 `index.ts:451` — per-segment 404 bodies exist only for the router walk; case 2 is unfalsifiable | premise **empirically falsified**: the fixer deleted `claim(...)` from the `api` mount and watched case 2 fail | **Holds — the strongest rebuttal in the record.** `index.ts:475` still carries the per-segment body with the §16 reasoning above it. The proposed redesign was shown strictly weaker. |
| 6 | D9 `model.ts:1239` — `accountProps` fabricates `backupCodesRemaining: 0` / `generatedAt: now` under a comment denying it fabricates anything | fixer agreed **fully**; `account.tsx` is locked and better-auth exposes no source | **Does not hold as a resolution.** The comment was fixed, the fabrication shipped, and it is **G10** in the gap register five dispatches later — deleted only in step 2 of the post-D15 roadmap. |
| 7 | D9 `push.ts:16` — the case title claims RFC 8291 while the library speaks draft-04 `aesgcm` | accepted-as-is; dependency decision, escalated to D10 | Reason holds; the outcome does not. Still open as **G23** ("Apple refuses"), deferred again in the roadmap's optional step 14. |
| 8 | D13 `gateway.ts:1053` — the §7 gate order re-spelled across four dispatch bodies | 2/2 refuters: "four bodies is two"; every site already carries a named cross-reference; `admit()` relocates rather than eliminates; the line saving was wrong by ~4× | **Holds on the current file.** `gateway.ts:6-7`, `:949-961`, `:1190`, `:1421` each name the pinned order in a comment. |
| 9 | D13 `tunnel.ts:247` — three per-family list methods should collapse to `listCatalog<T>` | 2/2: a caller-chosen `T` would let the family/shape mismatch compile silently; the flag's own text exempts multiple implementations of one interface | Holds. The neighbouring Together-or-Apart fix (deleting `DataModelBackend`) resolved the cross-module half while keeping the typed signatures. |
| 10 | D13 `contracts/tunnel-frames.json:3` — `server/discover` pinned in no fixture | 2/2: it is the MCP spec's own vocabulary, both halves are already asserted elsewhere, and `contracts.test.ts` runs in workerd and could only hand-type the fixture — the thing the README forbids | Holds. |
| 11 | D13 `cli/src/plan.ts:671` — `capabilities` destructured out of the diff wire, so it never replans | 2/2 refuted on severity; both conceded "a spec gap worth its own tracked item" | **The rebuttal was overtaken.** `plan.ts:713-718` today does `deepEqual(canonicalCapabilities(...))` and writes `changed.capabilities` — D13.1 (ledger :1014) implemented exactly the refused design one dispatch later. |

Nine of eleven reasons hold on reading. The two that do not (#6, #11) fail the same way: the *reason* was locally correct (a fence, a severity argument) and the *finding* was right, and nothing in the pipeline carried the finding past the refusal.

## 4. Assessment

**Signal vs noise.** Very little noise. Of 169 findings I count exactly one whose premise was false (#5 above, disproven by experiment), and roughly a dozen that are taste rather than complexity (naming splits like D7's `handshake()`/`hubCapabilities()`, D8's `formatBytes` KB-vs-KiB). The rest name a real cost, and a meaningful minority name a **live defect** reached through a complexity read rather than a test: D2's two redaction coverage gaps (array `items` never redacted; `writeOnly` inside a `default` poisoning a whole schema); D3's `provisionUser` returning a password that authenticates nothing while a hygiene test passed vacuously on it; D5's list path dialling mode-mismatched services **anonymously** and the RFC 8414 leg concatenating (a real 404 against tenant-scoped ASes); D8's two CLI bugs above; D11's fail-open bearer denylist (a stolen CLI token could enroll credentials — persistent takeover) and, one wave later, the *same shape one level down* — the corrected allowlist still admitted the whole `/device` subtree, verified end to end by minting a second owner session that survived revoking the first. That last pair is the clearest evidence the lens works and that a single pass is not enough.

**Severity calibration.** The top band is where the arguing happens: 10 of 11 refusals are of high/must findings, and in D13 — the only dispatch that put highs to a two-refuter vote — **4 of 5 highs were killed** with code-grounded essays while all 11 non-highs sailed through unexamined. That is partly a sampling artifact (mediums and lows are never refuted by design) and partly real: reviewers reach for "high" on a change-amplification argument that a refuter can price out. The counter-evidence is that the two most valuable findings in the whole record — D11's two bearer-guard blockers — were both top-band and both survived scrutiny end to end. Blocking-ness is honest at the extremes and inflated in the middle.

**What PSD catches that the other lenses do not.** Spec-fidelity checks each site against the spec and passes *both* copies of a duplicated decision; rows-fidelity checks that a test asserts what its title says; design parity compares a rendered page to a board. None of them can see one decision spelled twice. Nor can they see an oracle that cannot fail — and roughly a third of PSD's findings land in test and harness files, several of them making suites pass vacuously: D4's `OBSERVED` module-level map (per-row laws only as strong as whichever rows ran), D5's `PLANTED_SENTINELS` array (a `-t` or `.only` silently weakens the hygiene sweep with no assertion failing), D6's `parked` map keyed by tool name (a second concurrent hang overwrites the first, so the exactly-once oracle times out exactly when it should catch a double dispatch), D7's two `initialize` rows green against `result: {}`.

**What it consistently misses.** Compared against the gap audit (`2026-09-02-roadmap-after-d15.md`, G1–G58) and the orphan sweep (`2026-09-02-orphan-states.md`, 40 orphans over 192 states):

1. **Reachability.** The whole G40–G58 class — a rendered branch, tone, or arm with no producer — is invisible to PSD by construction. PSD reads a diff for reader effort; nothing in its vocabulary asks "does any loader produce this input?" 19 register entries, zero PSD antecedents.
2. **The code that is not there.** G5 (a GET filter form with no submit control), G1 (a chevron nothing sets `?expand=` for), G6 (`icons: []`), G11, G17. A diff-local complexity read cannot miss what was never written.
3. **A value crossing into a template.** **G15** (blocking: reflected XSS + open redirect via `?next=`) lives at `server/src/pages/login.tsx:109/241`, where `landingUrl(redirectTo)` is `JSON.stringify`'d into a `dangerouslySetInnerHTML` script. `login.tsx` was in D15's implementation commit `3db6e49`; D15's PSD returned 14 findings and **none in that file**. The lens does catch security when it reads a *guard* (D11 twice) and misses it when the flaw is data flow into a string.
4. **Its own escalations.** Four register entries were found by PSD first and then simply aged: **G10** (D9, fenced), **G22** (D9 `model.ts:1169`, "fixed" by documenting the `AUDIT_SCAN_ROWS` ceiling), **G23** (D9, accepted-as-is), **G39** (D13 `plan.ts:671`, rebutted 2/2). The lens found them one to five dispatches before the audit; nothing carried them.
5. **Its own severity filter.** **33 of 169 findings (20%) have no disposition anywhere.** Most are the workflow scripts' mechanical `findings.filter(f => f.severity !== 'low')` (`d8-cli-clients-wf_c98880bb-7a5.js:87` and siblings) dropping lows before the fix stage — 8 in D8, 5 each in D5 and D9, 4 in D6, 2 in D7. Some are worse: D8's `secret()`/`sensitive()` finding *was* in the fixer's prompt and appears in neither its fixed nor its (empty) disputed list, with zero mentions in the transcript; D11's second review has **6 of 7 findings** with no fix and no rebuttal — I re-read every file and line it named and each still matches the reviewer's description exactly.

**Cost.** Journals record agent identity and result text, never token usage, so per-stage token cost is not recoverable. Agent counts are: **20 reviewers, 10 dedicated fixers, 10 refuters ≈ 40 agents** across 13 runs. As a share of the dispatch: D9 2 of 5 agents, D6 4 of 11, D13 14 of 41, D15 1 dedicated reviewer inside a twelve-lens panel whose findings were routed into shared per-file fixers. The ledger's run-level totals (D13 41 agents / ~7.69M subagent tokens; D15 implementation ≈7.6M / 43 agents) put a PSD stage at roughly a tenth to a third of a dispatch's agent budget — and D13's refuter round, ten agents to kill four findings, is the single most expensive PSD sub-stage in the record.

**Three recommendations.**

1. **Pre-name the two misses in the prompt.** Add two required checks the PSD vocabulary has no word for, which is exactly why they never fire: *(a)* for every branch or state the diff adds, name its producer; *(b)* for every control the diff draws, name the handler. Both are one-line questions a reviewer already holding the diff can answer, and between them they cover 19 register entries and 5 missing-affordance gaps. If the answer is that this belongs to a different lens, then say so and run the orphan tracer at the same gate — but stop expecting PSD to find it.
2. **Delete the `severity !== 'low'` filter, or make the drop visible.** Today the lens pays full price to find the cheapest fixes and the script discards them with no record; three later resurfaced as owner work (`ws` undeclared, fixed by hand at D8's gate), as register entries (G31, G35), or as nothing at all. Either forward everything and let the fixer batch the lows into one commit, or require the ledger row to enumerate what was dropped — an unread finding must cost a line of prose.
3. **Give every refused, fenced or escalated finding a register id at the moment of refusal.** Four of them (G10, G22, G23, G39) reappeared in the gap audit unchanged, and one (`plan.ts:671`) was refuted 2/2 and implemented by the very next dispatch. The refusal reason is usually right and the finding usually survives it; a `PSD-<dispatch>-<n>` id carried into the ledger row costs nothing and closes the only leak that is entirely procedural. Bonus placement note: D13's two-refuter vote is the best calibration machinery in the record and ran exactly once — and D16 shows the opposite failure, a single reviewer with no result contract dying at eight minutes and leaving a "gate green" with no review behind it. One reviewer is a single point of failure; require a result line before the gate can close.

## 5. Ledger cross-check

| Where | Ledger says | Records say | Read |
|---|---|---|---|
| D2 :556 | "4 findings (1 high, 3 medium), all fixed and re-greened" | 4 / 1 high / 4 fixed | agrees |
| D3 :581 | "9 findings, 7 non-low fixed, 0 disputed" | 9 / 7 non-low fixed / 0 disputed; 1 low fixed as a side effect, 1 low (`registry.ts:920`) untraceable | agrees; 2 lows invisible |
| D4 :615 | "23 findings, 4 high, 18 fixed, 2 disputed" | identical | agrees; 3 lows never dispatched are not mentioned |
| D5 :674 | "19 findings (**5 high**), 14 non-low ALL fixed" | 19 findings, **4 high** + 10 medium + 5 low by the reviewers' own severity fields | **off by one on highs**; the 14 non-low agrees |
| D6 :727 | "25 findings (**9 high**), 19 fixed, 1 disputed" | 25 findings, **8 high** by raw journal severity; 19 fixed, 1 disputed, 1 de-facto rebutted, 4 untouched | **off by one on highs**; fixed/disputed exact |
| D7 :745 | no count; credits the mutation-proven handshake fix and the `thin-serve.ts` move | 8 findings, 6 forwarded, 6 fixed; 2 lows dropped between stages | ledger under-reports by omission |
| D8 :775 | "16 findings applied" | 26 findings; 18 forwarded; 17 applied, of which 1 was already on disk → 16 newly applied | the number is *fixes*, not findings; 8 lows + 1 silently dropped medium are invisible |
| D9 :820 | "9 findings, 6 designs applied" | **14** findings; 9 forwarded past the severity filter; 6 fixed, 2 rebutted, 1 accepted | ledger counts the post-filter list as the finding count |
| D11 :900-914 | names the one blocker and 4 of the first review's 5 fixes | first review 5/5 fixed (the `status()`/`viaConnection` nit confirmed only in the fixer transcript); second review 1 of 7 disposed | 6 findings unaccounted for in the record |
| D13 :980-993 | "15 findings, 5 highs put to two-refuter votes, survivors all fixed, 0 accepted-without-fix" | identical | agrees exactly — the best-documented run |
| D14 :1077 | "15 from the PSD lens (11 fixed, 4 rebutted)" | **no D14 run exists in any session's `workflows/scripts/`**; the numbers are D13's, digit for digit | unverifiable |
| D15 :1174-1178 | "80 findings, 16 must" across a twelve-lens panel; "one must REFUSED" | PSD's share: 14 findings, 2 must, 14/14 fixed; the refused must was the non-PSD header-redirect finding (open question 37(b)) | agrees; PSD is not separable in the ledger's number |
| D16 | no entry | reviewer truncated, 0 findings | agrees by absence |

Two systematic effects: the ledger's finding counts are **post-filter** (D8, D9), so the record understates how much the lens produced and overstates how much of it was acted on; and its high-severity counts drift by one in both D5 and D6 against the reviewers' own severity fields.
