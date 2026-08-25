# Personal MCP Hub — Implementation Orchestration Plan

> **Executor:** the orchestrating session (Claude main loop), not a per-task engineer.
> The unit of execution here is the **dispatch** — a dynamic workflow, a single
> subagent, or inline main-loop work. Dispatched agents never read this plan; each
> receives a self-contained launch prompt derived from its entry. This plan replaces
> the per-task subagent ceremony of `superpowers:subagent-driven-development` with
> dispatch entries at workflow grain — the same idea, one level up. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the personal MCP hub from its pinned spec until the entire
authored test suite (582 vitest cases + 27 pytest cases) is green, deployed, and
reviewed.

**Architecture:** The spec and the test skeletons already fix *what* to build; this
plan fixes *how the orchestrator spends leveraged moves*: which dispatches run, in
what order, what context each is handed, and how success is measured. Quality is
determined almost entirely by two things the orchestrator writes — the launch prompt
and the gate — so those are where this plan is precise. Code-level detail is
deliberately absent: it is the agents' problem and the suite's to judge.

**Tech stack:** Cloudflare Workers (wrangler 4.125.0, workerd), Hono 4.13.3 JSX, D1,
one SQLite-backed Durable Object with WebSocket hibernation, better-auth, pnpm
11.23.0 workspace, vitest ^4.1 + `@cloudflare/vitest-plugin@1.0.0`, fast-check,
uv-managed CPython 3.12 + pytest, Sentry (`@sentry/cloudflare`, DSN-optional).

**Spec:** `docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md` (the system)
and `docs/superpowers/specs/2026-08-25-testing-strategy.md` (the suite and its
conventions). The plan argues from both; every dispatch's launch prompt names the
sections its agents must read.

## Global constraints

- **Tests are the spec.** A case leaves the pending column only by turning green.
  No dispatch may delete an `it.todo`, weaken an oracle row, or loosen an assertion
  to pass; the gate's inventory diff (below) catches this mechanically.
- **Oracle tables are owner-authored.** The empty `readonly` rows constants are
  filled by an Opus-tier authoring stage at the start of the phase that runs them —
  never by the implementing agents, and never ahead of their phase.
- **Model policy:** dispatched agents run on Opus 5 or cheaper; Sonnet for
  mechanical spread; Fable stays in the main loop only.
- **File ownership is per-dispatch.** Each entry's **Owns** globs are the only
  paths its agents may modify. At most one repo-mutating dispatch runs at a time
  unless ownerships are disjoint. Harness files belong to the first phase that
  needs them.
- **Commits happen only on the user's word.** Each gate *proposes* a commit; the
  orchestrator never commits or pushes unprompted.
- **Secrets hygiene (spec §15):** no real secrets anywhere in fixtures, YAML, logs,
  or test literals — fake tokens use obviously-fake patterns (`pmcp_sa_FAKE0000`).
  Bodies never on Sentry events; `beforeSend` strips `Authorization` and
  `pmcp_(sa|svc)_…`.
- **Pinned constants live in `server/src/limits.ts`**; tests reference names, never
  literals. `REDACTED` lives in registry. New magic numbers are a plan violation.
- **Auth/credential MCP parity exception:** login, device approval, TOTP/passkey,
  sessions, and passwords are never exposed to models — no dispatch may add them to
  any MCP surface.
- **Deploy target:** `https://personal-mcps.ahrzb.workers.dev` (account
  ahrzb5@gmail.com, D1 `personal-mcps`). Deploy smokes hit the real worker.

## Dispatch anatomy and the standard gate

Every dispatch entry carries: **Status · Grain/models · Owns · Preconditions ·
Spec sections · Suites (exit criteria) · Shape · Launch context · Gate · Est.
scale.** Two kinds of exit criteria:

- **Mechanical** — exact commands with expected outputs, re-run by the orchestrator
  in the main loop after the dispatch reports; an agent's claim of green is never
  the gate.
- **Judged** — what no runner measures (oracle fidelity to spec, design quality).
  These run as explicit verify stages *inside* the workflow with pinned verdict
  schemas, so judgment is structured output, not self-assessment.

**Standard gate protocol** (referenced by every entry as "standard gate"):

1. - [ ] `pnpm test` from repo root — the dispatch's target suites fully green,
     zero failures anywhere, remaining todo count equals plan.
2. - [ ] `node scripts/test-inventory.mjs` — regenerate `test-inventory.json`
     (per-file case titles × state from vitest's JSON reporter). `git diff
     test-inventory.json` shows **only** `todo → passed` transitions for this
     dispatch's cases: no case deleted, no title reworded, no foreign suite
     touched. (The inventory file is committed at each gate, so the diff *is* the
     audit trail.) *Amendment (D3 onward):* table-driven suites carry aggregate
     placeholder todos ("one case per <X>Row — title as authored"); at the gate
     each placeholder is replaced by the row-registered cases whose titles were
     authored and adversarially verified in the Oracles stage. The audit then
     checks: placeholder removed → its describe gained ≥1 passed case titled
     verbatim from the oracle rows; concrete todos still flip purely; nothing
     regresses passed → anything.
3. - [ ] `npx tsc --noEmit` exit 0; `uv run pytest` (clients/py) still collects
     with no new failures.
4. - [ ] Ownership audit: `git status` touches only the entry's **Owns** globs.
5. - [ ] Read the workflow's judged-stage verdicts; every PSD finding is either
     fixed or explicitly accepted with a reason in the dispatch report.
6. - [ ] Show the user the delta (cases green, files, findings); propose a commit.
7. - [ ] Detail the *next* dispatch entry in this plan from outline grain to full
     precision, folding in anything this dispatch taught.

**PSD review stage** (inside every implementation workflow, post-green, pre-gate):
1–2 Opus reviewer agents are handed the diff plus `.claude/skills/psd/SKILL.md` and
instructed to judge by its value system and report via schema
`{flag, file, line, readerCost, eliminatingDesign, severity}` — findings must name
an official red flag (Shallow Module, Information Leakage, Pass-Through Method,
Comment Repeats Code, …) and propose the eliminating design, weighted by depth of
damage × touch frequency. Findings that only describe discomfort are discarded by
an adversarial filter vote. Reviewers are told the house conventions (psd contract
headers, `// deps:` lines, comments-first) are documented conventions — not
re-litigated.

**On a red gate:** resume the workflow run (`resumeFromRunId` — cached prefix, only
the failed stage re-runs) with a scoped fix stage; escalate to the user only when
the failure is a spec question, not an execution one.

---

## Dispatch ledger

| # | Dispatch | Grain | Status |
|---|----------|-------|--------|
| D0 | Checkpoint commit | inline | **done** (six commits `4c6b937..3cd694f`) |
| D1 | Test runners + pending inventory | single agent (Opus) | **gated ✓** |
| DV | UI visual checkers vs artboards | workflow (Sonnet) | **gated ✓** |
| D2 | Pure core (pattern, filter, canonical, redact) | workflow | **gated ✓** (`ce5392e`) |
| D3 | Migrations, registry, identity, audit | workflow | in flight |
| D4 | Gateway, admin, approvals | workflow | outline |
| D5 | Upstream proxy, cron, hygiene | workflow | outline |
| D6 | Tunnel DO + contracts + approval e2e | workflow | outline |
| D7 | Web surface wiring | workflow | outline |
| D8 | CLI + JS/Python clients | workflow | outline |
| D9 | Full-suite deploy + cross-module PSD sweep | workflow + inline | outline |

Order is dependency-driven: nothing waits on anything it doesn't consume. D2–D3
could overlap in principle (disjoint suites) but share `server/src/registry.ts`, so
they stay serial.

---

### D0 — Checkpoint commit

**Grain:** inline. **Status:** awaits the user's word.

The "everything stubbed, everything typechecks" tree (uncommitted since `ca37c81`)
is the baseline every later inventory diff and review argues against, and D1 is
already churning it.

- [ ] On the user's go: commit the current tree (spec, skeletons, test outlines,
  UI pages, boilerplate) as one checkpoint; commit D1's runner changes separately
  when its gate passes.

### D1 — Test runners + pending inventory *(in flight)*

**Grain:** single background agent, Opus 5.
**Owns:** package.json files, pnpm-workspace.yaml, lockfile, vitest configs,
`server/test/**`, `cli/test/**`, `clients/js/test/**`, `clients/py/**` (tests +
pyproject), `scripts/test/**`. Explicitly fenced off `server/src/**`, `server/dev/**`,
root tsconfig.json (UI dispatch owns those concurrently).
**Spec:** testing-strategy runner sections; contracts/README.md.

**Exit criteria (mechanical):** `pnpm test` runs unit/worker/tunnel/cli/clients-js
projects with 0 failures and ~340 todo; `uv run pytest` collects clean, all
outlined tests skipped; `npx tsc --noEmit` exit 0; every outline comment case-line
converted to `it.todo` with text verbatim; nothing falsely passes.
**Exit criteria (observed, not reasoned):** the workerd fixture probe — the
demonstrated mechanism by which a Workers-pool test writes a contract fixture file
to `contracts/` (file-snapshot round-trip vs host-side hook). **This finding patches
D6's and D8's gate detail; record it in the changelog at the bottom of this plan.**

**Gate:**
- [ ] Standard gate items 1, 3, 4, 6 (inventory tooling doesn't exist yet — see next).
- [ ] Write `scripts/test-inventory.mjs` inline (orchestrator, ~30 lines: run
  vitest with JSON reporter, emit sorted `{file: {title: state}}` to
  `test-inventory.json`); generate the baseline file.
- [ ] Record the fixture mechanism in the changelog; update D6/D8.
- [ ] Confirm release-age excludes (if any were needed) are minimally scoped.

**Est. scale:** 1 agent, ~150–250k tokens.

### DV — UI visual checkers *(queued on the ui-pages-fake-data workflow)*

**Grain:** workflow, Sonnet checkers (user-approved split: Opus authored the model,
Sonnets implement and check). **Owns:** `server/src/pages/**` (fix-ups only),
nothing else.
**Preconditions:** UI workflow complete; preview server up
(`wrangler dev -c wrangler.preview.jsonc`); root tsconfig widened to test trees —
an inline orchestrator edit the moment the UI workflow lands (deferred until then
precisely because two dispatches would otherwise have owned the file).
**Shape:** one Sonnet checker per page, each with a browser tab: rendered page vs
its `design/*.dc.html` artboard (desktop + 900px narrow + state boards), reporting
`{page, mismatches[]}`; a fix stage applies confirmed mismatches; re-check.
**Exit criteria:** every page's checker reports zero unaccepted mismatches; the
7-day retention copy (not 90) everywhere; standard gate items 3, 4, 6.
**Est. scale:** ~10 agents Sonnet, ~400–700k tokens.

### D2 — Pure core *(next; full detail)*

**Grain:** workflow. Oracle author + verify: Opus. Implementation: Opus for
`redact` (the writeOnly walk is the subtlest pure code in the system), Sonnet for
pattern/filter/canonical. PSD reviewers: Opus.
**Owns:** `server/src/registry.ts` (pure seams only: `matchesPattern`,
`validateRoles`, `buildToolFilter`, `writeOnlyPaths`, `validateSchemaIndirection`,
`applyRedaction`), `server/src/approvals.ts` (`canonicalJson` only),
`server/test/unit/**`.
**Preconditions:** D1 gate passed; UI workflow no longer touching `server/src`
(registry/approvals are not UI files, but the one-mutating-dispatch rule applies —
DV may run concurrently only because its ownership is disjoint).
**Spec:** §2 (the one pattern language), §6 (role declaration + caps), §7
(redaction both directions, the local-ref walk, the indirection refuse-line,
approvals canonical form), §18 decisions 16 and 22; testing-strategy rows for the
four unit suites.

**Suites (exit):** `server/test/unit/pattern.test.ts`, `filter.test.ts`,
`canonical.test.ts`, `redact.test.ts` — every case green, including the fast-check
property cases and the indirection refuse-table (each refusal beside its walkable
twin).

**Shape:**
1. *Author* (1 Opus): fill the empty oracle tables in all four suites from the
   named spec sections — rows only, no implementation, no runner edits.
2. *Verify oracles* (2 Opus, adversarial): independently re-derive rows from the
   spec and vote per row `{row, faithful, citation}`; majority-refuted rows go
   back to stage 1. This is the judged half of "the tables are the spec".
3. *Implement* (per-module agents; convert `it.todo` → `it` wired to the runner
   stubs, then implement in src until green — TDD at agent grain, red observed
   before green).
4. *PSD review stage* (as defined above) over the src diff.
5. *Fix* confirmed findings; re-green.

**Launch context each agent is handed:** the exact spec sections above (by path +
heading), its one test file, the psd house conventions note, the constraint that
`limits.ts` names are referenced never re-spelled, and — for the redact
implementer — the pinned walk semantics (same-document `#/…` JSON-Pointer refs;
marks unioned across `allOf`/`anyOf`/`oneOf`; secret-free cycles cut;
`validateSchemaIndirection` refuses external/non-local refs, `$id`/`$anchor`/
`$dynamicRef`, recursive-secret cycles) plus decision 16's rejected alternative
(forced client inlining) so it doesn't reinvent it.

**Gate:** standard gate. Additional check: `pnpm test --project unit` runs with no
Workers pool (pure seams stay pure — importing a platform API in these four files
is a red flag the ownership audit must catch).

**Est. scale:** ~7 agents (1 author, 2 oracle-verify, 3 implement, 1–2 PSD),
Opus-weighted, ~600k–1M tokens.

### D3 — Migrations, registry, identity, audit *(outline)*

**Grain:** workflow, Opus author/verify + mixed implementers.
**Owns:** `server/migrations/*.sql` (created here, from spec §5),
`server/src/registry.ts` (persistence), `server/src/identity.ts`,
`server/src/audit.ts`, `server/src/admin.ts` (*only* the `provisionUser` /
`deleteUser` slice `seed.ts` depends on), `server/test/harness/seed.ts`,
`server/test/worker/{migrations,registry,identity-tokens}.test.ts`,
`server/test/setup/d1.ts`.
**Spec:** §5 (full schema incl. audit bodies + redact columns), §12, identity
portions of §2/§8/§15 (token kinds, injected clock, retention).
**Suites (exit):** migrations, registry, identity-tokens — green in the Workers
pool against real D1 with migrations applied; seed.ts fully implemented (it is the
root of every later worker/tunnel suite — its quality is this dispatch's real
deliverable).
**Shape:** as D2 (author → adversarial oracle verify → implement → PSD review),
plus a migrations-forward check (fresh DB vs migrated DB equality).
**Est. scale:** ~8 agents, ~800k–1.2M tokens.

### D4 — Gateway, admin, approvals *(outline)*

**Owns:** `server/src/gateway.ts`, `server/src/admin.ts` (rest), 
`server/src/approvals.ts` (rest),
`server/test/worker/{approvals,admin-ops,admin-pipeline,auth-matrix,order.table}.test.ts`.
**Spec:** §7 (pipeline order, refusal vocabulary, `-32001` approval machinery,
virtual `pmcp` service), §8 (admin ops incl. `token_issue`'s writeOnly key), §18
decision 22.
**Suites (exit):** the five worker suites above green — the order table is the
marquee: every refusal case beside its allow-twin, refusal rows never carrying
bodies.
**Shape:** as D2; the approvals implementer gets the seeded-clock twin pattern
(`ApprovalsConfig.now`, `TokenSpec.expired`) spelled out.
**Est. scale:** ~9 agents, ~1–1.5M tokens.

### D5 — Upstream proxy, cron, hygiene *(outline)*

**Owns:** `server/src/upstream.ts`, `server/src/index.ts` (scheduled leg + Env
parse via `audit.resolveAuditConfig`), `server/test/harness/fake-upstream.ts`,
`server/test/worker/{upstream-credentials,upstream-proxy,cron,hygiene}.test.ts`.
**Spec:** §7 (proxied dispatch, per-service `log_bodies` opt-in, `redact:` /
`redact_results:`), §15 (log hygiene incl. Sentry beforeSend, retention-as-guard
cron), §5 (OAuth state TTL).
**Suites (exit):** the four worker suites green; hygiene is the judged one made
mechanical — planted fake secrets provably absent from every log/event/stored body
(incl. case 14a: schema-unsound tool records no body).
**Est. scale:** ~8 agents, ~800k–1.2M tokens.

### D6 — Tunnel DO, contracts, approval e2e *(outline)*

**Owns:** `server/src/tunnel.ts`, `server/test/harness/fake-service.ts`,
`server/test/tunnel/**`, `server/test/worker/contracts.test.ts`, `contracts/*.json`
(produced), `server/src/index.ts` (fetch wiring for `/connect` if not already).
**Spec:** §6 (whole protocol: register deadline, replaced/row-gone/protocol
closes, hibernation, correlation), §15 (CALL_TIMEOUT), contracts/README (8
families, single-writer rule).
**Suites (exit):** smoke, protocol (observed close codes == exported vocabulary),
lifecycle, hibernation (eviction + alarm survival), pipeline-tunnel, and
**approval-e2e** — the full §7 walk through a live tunnel; contracts.test.ts green
*and* the `contracts/*.json` fixtures regenerated via `pnpm contracts:update`
(`toMatchFileSnapshot` from the worker project — the D1-probed mechanism),
byte-diffed against committed copies.
**Shape:** as D2 but Opus-only implementation (hibernation correctness is the
hardest code in the repo) and a doubled PSD stage (the DO is the deepest module —
judge it as one: what does it hide behind `handleConnect`/`tunnelBackend`/
`status`/`sever`/`wipe`?).
**Est. scale:** ~10–12 agents, ~1.5–2.5M tokens. The big one.

### D7 — Web surface wiring *(outline)*

**Owns:** `server/src/web.ts`, `server/src/index.ts` (ROUTES data), 
`server/src/pages/model.ts` (fixture seam → real queries), 
`server/test/worker/{web-pages,routes}.test.ts`. Templates under `pages/*.tsx`
deliberately unchanged — `model.ts` is the seam; a template edit here is a design
smell the gate rejects (change amplification: the seam exists so wiring touches one
file per page, not two).
**Spec:** §13, §16 (router-walk test: every route in ROUTES reachable, every
reserved route refused), better-auth wiring, the ROUTES-as-data pin.
**Suites (exit):** web-pages (incl. the substituted-handler proof that pages never
execute admin ops), routes. Deploy smoke: login page renders on workers.dev.
**Grain note:** Sonnet-heavy — wiring is mechanical by construction.
**Est. scale:** ~6 agents, ~500–800k tokens.

### D8 — CLI + JS/Python clients *(outline)*

**Owns:** `cli/src/**`, `clients/js/src/**`, `clients/py/src/**`,
`clients/js/test/**` (incl. fake-hub.ts), `clients/py/tests/**` (incl.
fake_hub.py), `scripts/users.ts`, `scripts/test/bootstrap-contract.test.ts`,
`cli/test/plan.test.ts`.
**Spec:** §9 (YAML diff/apply — `plan.ts` is pure and goes first), §10, §11
(serve/caller/secret/sensitive; the reconnect contract's three behaviors +
schedule), §12; contracts families as the cross-language lock.
**Suites (exit):** plan, bootstrap-contract, js api/transport/contracts-consumer
(against fake-hub + committed fixtures), py mirrors green under `uv run pytest`.
**Shape:** JS first establishes behavior; the Python port is a Sonnet translation
task judged by its own suite, not by diff similarity. Contract fixtures are
read-only here (single-writer: worker suite) — a client dispatch editing
`contracts/*.json` is a gate failure.
**Est. scale:** ~8 agents, Sonnet-weighted, ~700k–1M tokens.

### D9 — Full-suite deploy + cross-module PSD sweep *(outline)*

**Grain:** inline (deploy, gates) + one review workflow.
**Owns:** nothing new — fixes route back through the owning dispatch's resume.
- [ ] Full `pnpm test` + `uv run pytest`: zero todo, zero skip, zero fail.
- [ ] `test-inventory.json` final state: every one of the 582 authored cases
  `passed`; diff against the D1 baseline shows only `todo → passed` across the
  whole history.
- [ ] Real deploy; smoke the live worker: bootstrap flow, one tunneled fake
  service registering from a local process, one `tools/call` end-to-end, audit row
  visible in `/audit` with body per config.
- [ ] Cross-module PSD sweep (workflow, ~4 Opus lenses over module boundaries —
  the per-dispatch reviews saw diffs; this one judges the seams: registry↔gateway,
  gateway↔tunnel, identity↔everything, pages-model↔web) + a completeness critic
  ("which spec § has no green case pointing at it?").
- [ ] Close the loop with the user: findings, cost actuals vs estimates, what to
  harden next (PWA push, real service migrations).

---

## Changelog

- 2026-08-25 — plan written. D1 in flight (launched before this document; its
  entry records the launch scope verbatim). Fixture-production mechanism: pending
  D1's probe; D6/D8 carry the dependency explicitly.
- 2026-08-25 — **D1 gated.** All checks re-run by the orchestrator: `pnpm test`
  30 files / **582 todo** (not ~340 — sub-cases and the big tables were
  undercounted; counts corrected throughout), 0 failures; `tsc` 0; pytest 27
  skipped. Baseline `test-inventory.json` generated via new
  `scripts/test-inventory.mjs`. **Fixture mechanism (observed):**
  `expect(string).toMatchFileSnapshot(path)` from a Workers-pool test round-trips
  to the host with no wrapper (`cloudflare:snapshot` env routes I/O over pool
  RPC); producer stringifies its own JSON; `pnpm contracts:update` =
  `vitest run --project worker contracts -u` — D6's gate uses exactly this. No
  release-age excludes were needed. Deviations accepted: `vitest.config.mts`
  (top-level await for `readD1Migrations`), tunnel serialization via vitest
  options + `sequence.groupOrder` (plugin 1.0.0 dropped `singleWorker`), five
  projects (scripts joins clients), Python is uv CPython **3.14** (3.12 absent).
  Root tsconfig widened to the test trees at this gate (UI workflow had landed),
  with `server/test/env.d.ts` as a deliberate minimal shadow of `cloudflare:test`
  types — replaced at D3 when `wrangler types` adoption is decided.
- 2026-08-25 — UI workflow complete (11 agents, model.ts single authority,
  fixtures for every page state). Preview server pinned in `.claude/launch.json`
  ("preview", port 8788) with `wrangler.preview.jsonc` gaining
  `assets: server/src/pages` so `/styles.css` resolves. Inline orchestrator
  fixes: `layout.tsx` `Section` collapsed into model's `NavSection` (drift risk
  two agents flagged); stale runner-stage note in `smoke.test.ts` corrected.
  DV launched.
- 2026-08-25 07:15 — **DV Check + Fix landed, Recheck credit-killed.** 8/8 pages
  checked (screenshots often unavailable to headless checkers — DOM +
  computed-style verification carried the pass), 16 actionable findings, all
  fixed in one pass (4 files, `server/src/pages` only, tsc 0) and committed
  (bc6cef9). All 6 recheck agents failed on "session limit · resets 8am
  Europe/Berlin" — Amir predicted this. Resume plan: the 08:10 wakeup re-runs
  `Workflow({scriptPath, resumeFromRunId: "wf_f0c53c9c-564"})`; Check/Fix replay
  from cache, only rechecks execute. Board gaps noted by checkers (no artboard
  for login backupCodeError or device denied) are artboard debt, not page bugs.
  Six commits `4c6b937..3cd694f` checkpointed the whole session's tree first
  (spec pins / skeleton pins / toolchain / test outlines / UI pages / this
  plan).
- 2026-08-25 08:35 — **DV gated.** Recheck resumed post-reset with per-page
  findings inlined into the prompts (the resume's one script edit); Check/Fix
  replayed from cache, 15/15 agents, 0 errors. Five pages fully clean; the
  approval-detail recheck caught two survivors — its mobile type scale (wears
  `card-title`/`card-desc`, so the `.auth-title` fix skipped it) and `.code`
  lacking `pre-wrap` (single-line JSON became a ~17,000px scroll strip on
  bulkyArgs, pre-existing) — both fixed inline, verified live at 375px, account
  regression-checked, committed. **Recorded debt, no action taken:** 4 nits
  (login backup-code input not monospace; service-new token clipped without
  ellipsis vs the board's middle-ellipsis; approvals mobile footnote carries the
  desktop "Times are local." sentence; one audit event-detail nit) and artboard
  gaps (no board for login backupCodeError or device denied). Ops note for
  browser-using workflows: headless subagents cannot composite screenshots
  (DOM/computed-style verification carries the pass) and the pane has a ~10-tab
  cap — dead checkers leak tabs, so prompts must demand tab cleanup; two
  orphans were closed by hand mid-run. Loop stopped; D2 awaits Amir's go.
- 2026-08-25 14:20 — **D2 gated** ("move forward, do all steps back to back" —
  continuous mode from here). Workflow `wf_b4bb2c2c-130`: 11 agents, 0 errors,
  ~1.45M subagent tokens. Oracle authoring caught **23 discrepancies** in
  adversarial verify before any implementation ran. Gate re-run by the
  orchestrator: full suite 90 passed / 492 todo / 0 fail; inventory diff exactly
  90 pure `todo → passed` flips (line-pairing audit — no title changed, no case
  added); tsc 0; ownership exact (registry.ts, approvals.ts, unit tests,
  inventory). PSD: 4 findings (1 high, 3 medium), all fixed and re-greened —
  the high one was two live coverage gaps in the redaction walk (array `items`
  never walked → under-redaction; carriesMark over-refusal); the fix unified
  the keyword decision into one `samePathSubschemas` helper and memoized the
  walk on relative paths (2^n `$defs` re-walk → linear, measured 2870ms → fast
  at depth 20). Orchestrator eyeballed the final redaction section — design
  sound, soundness argument for memo-under-cycle-cut written into the code.
  **Recorded debt:** the two redaction holes PSD found were *untested* — unit
  tables carry no array-`items` redaction rows, so that behavior rests on the
  fix + PSD re-green, not a pinned oracle. Candidate rows for D9's
  completeness critic (D2 titles stay locked). Committed `ce5392e`; D3
  launched immediately.
