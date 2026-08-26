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
| D3 | Migrations, registry, identity, audit | workflow | **gated ✓** (`c83bb17`) |
| D4 | Gateway, admin, approvals | workflow | **gated ✓** (`ffe2c4a`) |
| D5 | Upstream proxy, cron, hygiene | workflow | **gated ✓** (`d036455`) |
| D6 | Tunnel DO + contracts + approval e2e | workflow | **gated ✓** (`f4370c9`+`eb0d5f1`) |
| D7 | First deploy + live wire (initialize, smoke.ts, thin tunnel client) | workflow + inline | **gated ✓** (`042aa96`, SMOKE PASS 22/22 live) |
| D8 | CLI + JS/Python clients, against the live hub | workflow | **gated ✓** (`80860c2`+`c308190` spec, SMOKE PASS 24/24 live) |
| D9 | Web surface wiring + Web Push | workflow | **gated ✓** (`59264a5`, deploy `b0853623`, SMOKE PASS 25/25 live) |
| D10 | Final sweep (zero-todo, cross-module PSD, cost actuals) | workflow + inline | **gated ✓** (`13a8179`+`c6f8ee9`, deploy `4d3bf3d7`, SMOKE PASS 25/25 live) |
| D11 | Remediation: D10 sweep's 9 findings + 12 coverage gaps | workflow ×2 + inline | **gated ✓** (`35a5268`+`3a3a67a`, deploy `d0879ada`, SMOKE PASS 25/25 live) |
| D12 | Inbound OAuth — the hub as an authorization server (§19) | probe + workflow (7 agents) + inline gate | **gated ✓** (`be94c17` fixture, `f4ffd75` impl, `b52e563`+`3a9526c` fixes, deploy `c31c4be0`, SMOKE PASS 26/26 live) |

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

### D4 — Gateway, admin, approvals *(detailed 2026-08-25, pre-launch)*

**Owns:** `server/src/gateway.ts`, `server/src/admin.ts` (rest),
`server/src/approvals.ts` (rest),
`server/test/worker/{approvals,admin-ops,admin-pipeline,auth-matrix,order.table}.test.ts`
(116 cases), **plus three seam extensions the suites' dep lines force**:
`server/src/identity.ts` session half (`resolvePrincipal` consumer matrix,
`requireOwnerSession`, better-auth wiring — auth-matrix pins them),
`server/src/index.ts` fetch routing for `/<user>/mcp*`, `/api/whoami`, bootstrap
(auth-matrix drives `exports.default.fetch`; D7 keeps the web-page routes), and a
**minimal** `server/test/harness/fake-upstream.ts` (order.table's proxied
allow-twins need `miniflare.outboundService`; D5 extends it).
**Spec:** §7 (pipeline order filter→archived→approval→availability, refusal
vocabulary -32000..-32003, approval machinery, virtual `pmcp`), §8 (admin ops
incl. `token_issue`'s writeOnly key, whoami mirror), §4/§13 session-scope guards,
§12 bootstrap 404-shape, §18 decision 22, availability-first decision.
**Preconditions:** D3 gated (seed harness + migrations + identity machine half).
**Suites (exit):** all five green; order.table is the marquee (refusal beside
allow-twin, refusals never carrying bodies); auth-matrix's ~32 rows
indistinguishability-checked.
**Shape:** probe FIRST alongside oracles — strategy §11's prerequisite: a spike
agent proves better-auth 1.7 sessions resolve on D1 inside workerd (Kysely D1
dialect is contested) *before* auth-matrix implementation starts; a red probe
halts the dispatch as a spec/toolchain escalation. Then as D2/D3: author → 2
adversarial verifiers → reconcile → implement in dependency order (approvals ∥
identity-session first, then gateway, then admin) → verbatim check → PSD → fix.
The approvals implementer gets the seeded-clock twin pattern (`ApprovalsConfig.now`,
`TokenSpec.expired`) spelled out.
**Gate:** standard gate (with the table-expansion amendment).
**Est. scale:** ~12 agents, ~1.2–1.6M tokens.

### D5 — Upstream proxy, cron, hygiene *(detailed 2026-08-25, pre-launch)*

**Owns:** `server/src/upstream.ts` (rest — D4 left the minimal transport
`dial`/`listTools`/`call`/`sensitivePaths` and the credential-seal half
`setHeaders`/`disconnect`/`seal`/`envelopeKey`; every ponytail ceiling in the
file names D5's half: envelope-open, the §7 connect flow — RFC 9728 discovery,
CIMD/DCR, PKCE, RFC 9207 — proactive refresh, the `needs_reconnect` flip,
`UpstreamError.failureClass` mapping), `server/src/audit.ts` (`prune`,
`exportJsonl`; add the `hub` principal member to the AuditEntry doc),
`server/src/index.ts` (scheduled leg: approvals.sweepExpired + audit.prune +
stale OAuth-state drop, one `cron.swept` row), `server/test/harness/fake-upstream.ts`
(extend: OAuth server behaviors, failure modes), 
`server/test/worker/{upstream-credentials,upstream-proxy,cron,hygiene}.test.ts`.
**Spec:** §7 (proxied dispatch, per-service `log_bodies` opt-in, `redact:` /
`redact_results:`), §15 (log hygiene incl. Sentry beforeSend, retention-as-guard
cron), §5 (OAuth state TTL).
**Preconditions:** D4 gated (envelope format v1 pinned by `seal`:
version-byte ‖ 12-byte IV ‖ AES-GCM under `UPSTREAM_CREDS_KEY`; fake test
binding already in vitest.config.mts).
**Suites (exit):** the four worker suites green; hygiene is the judged one made
mechanical — planted fake secrets provably absent from every log/event/stored body
(incl. case 14a: schema-unsound tool records no body). Sentry's beforeSend is
pinned as a pure exported function — the SDK is not a dependency and this
dispatch adds none.
**Shape:** as D4 minus the probe (no contested toolchain): author → 2
adversarial verifiers → reconcile → implement in dependency order (upstream
credentials+proxy with the fake-upstream extension first, then cron+hygiene,
which consume it) → verbatim check → PSD → fix.
**Gate:** standard gate (with the table-expansion amendment).
**Est. scale:** ~9 agents, ~800k–1.2M tokens.

### D6 — Tunnel DO, contracts, approval e2e *(outline)*

**Inherits from D4/D5 pull-forwards (all reshapeable):** `ServiceConnection.listTools`
(KV-key `catalog` read) and `status()` (registered-socket check) are minimally
implemented; the DurableObject/namespace shadow types in `workers-env.d.ts` exist.
**Named debt D6 must collect:** hygiene.test.ts case 14a's fixture drives the
null-sensitivePaths law through adminBackend (unknown op) because the title's real
producer — a schema-unsound tool in the tunneled catalog — is unreachable until
`tunnel.sensitivePaths` lands; D6 repoints that fixture to the real producer (the
case comment carries the promise; checked at D6's gate).

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

### D7 — First deploy + live wire *(restructured 2026-08-25: shift-left)*

The old plan back-loaded every real-world integration — first true deploy,
first WebSocket through Cloudflare's edge, first standards-compliant MCP
client — into D9, after the clients were already built against fakes. This
dispatch pulls all of it directly behind D6, so structural issues (edge
behavior, DO migrations in production, handshake gaps, wrangler quirks) are
found while everything downstream can still absorb the fix cheaply. From this
dispatch on, **deploy-freshest-master + run the live smoke is a standing step
of every gate**, not a D-final ceremony.

**Owns:**
- `initialize` handshake pull-forward: spec §7 commit (method table gains
  `initialize`; `notifications/initialized` already absorbed by the
  notification-202 branch), order.table oracle rows for both shapes, the
  minimal hand-rolled answer in gateway.route (protocolVersion, capabilities,
  serverInfo). The SDK swap stays the recorded ceiling — this makes real MCP
  clients work, nothing more.
- First real deploy: `wrangler secret put` (BETTER_AUTH_SECRET,
  UPSTREAM_CREDS_KEY, BOOTSTRAP_SECRET — generated values), remote D1
  migrations, PUBLIC_ORIGIN → the workers.dev origin, `wrangler deploy` +
  `--dry-run` in the gate.
- `scripts/smoke.ts` — the live end-to-end walk against a deployed origin
  (HUB_ORIGIN + BOOTSTRAP_SECRET env): bootstrap user → sign-in → whoami →
  `token_issue` via pmcp → `server/discover`/`initialize`/`tools/list` as the
  service account → create tunneled service + token → connect the thin client
  (below) from THIS machine through the edge → online → `tools/call` over the
  live socket → full approval walk → `audit_query` verification → cleanup
  cascade. Exit code + printed report; every later gate runs it.
- Thin tunnel-client slice: the minimal JS `serve()` transport half pulled
  forward from D8's `clients/js` (connect, register, answer tools/list +
  one tool, reconnect-on-4002) — just enough for smoke to drive a REAL
  process through a REAL edge WebSocket into the production DO. D8 absorbs
  and completes it; its file lives where D8 expects it.
- Claude-as-client proof: the orchestrator adds the deployed hub to Claude
  Code (`claude mcp add --transport http` + bearer) and drives
  tools/list/tools/call interactively — a second, independent
  standards-compliant client exercising the wire.
**Spec:** §7 (method table amendment), §12 (bootstrap flow live), §6 (the
protocol through a real edge), §10 (deploy).
**Grain:** inline (deploy, secrets, Claude-as-client) + one small workflow
(initialize rows + gateway change + smoke.ts + thin client, ~5 agents).
**Est. scale:** ~5 agents, ~400–600k tokens.

### D8 — CLI + JS/Python clients *(outline; now against a LIVE hub)*

**Owns:** `cli/src/**`, `clients/js/src/**` (absorbing and completing D7's
thin transport slice), `clients/py/src/**`, `clients/js/test/**` (incl.
fake-hub.ts), `clients/py/tests/**` (incl. fake_hub.py), `scripts/users.ts`,
`scripts/test/bootstrap-contract.test.ts`, `cli/test/plan.test.ts`,
`scripts/smoke.ts` (extended: CLI login via device flow, YAML apply, both
client libraries driven against the deployed hub).
**Spec:** §9 (YAML diff/apply — `plan.ts` is pure and goes first), §10, §11
(serve/caller/secret/sensitive; the reconnect contract's three behaviors +
schedule), §12, §14 (device flow live); contracts families as the
cross-language lock.
**Suites (exit):** plan, bootstrap-contract, js api/transport/
contracts-consumer (against fake-hub + committed fixtures), py mirrors green
under `uv run pytest` — AND the extended live smoke green against the
deployed hub, which is what the fixtures cannot prove (real TLS, real edge,
real clocks).
**Shape:** JS first establishes behavior; the Python port is a Sonnet
translation task judged by its own suite, not by diff similarity. Contract
fixtures are read-only here (single-writer: worker suite) — a client dispatch
editing `contracts/*.json` is a gate failure.
**Est. scale:** ~8 agents, Sonnet-weighted, ~700k–1M tokens.

### D9 — Web surface wiring + Web Push *(outline; moved after clients — lowest structural risk)*

**Named debt D9 must collect:** `audit.exportJsonl` is implemented (D5) but
pinned by no oracle row anywhere — its consumer is §13's /audit Export action;
web-pages todos 12–15 are exactly those rows (pre-authored, so D9 flips them
rather than authoring). `cron.swept` visibility: weighed at the D8 gate and
RESOLVED as stays-invisible-by-design — hub-namespace rows are outside
owner-scoped /audit, the trade is recorded at the HUB_NAMESPACE export, and
no owner-facing need has appeared; revisit only if one does.
The parked approvals push-decrypt todo lands here too: webpush-webcrypto is
this dispatch's sanctioned dependency (§13 names it), the gateway's bare-POST
push transport becomes real RFC 8291/VAPID, and the approvals suite's parked
case goes green with nothing else moving.

**Owns:** `server/src/web.ts`, `server/src/index.ts` (ROUTES data),
`server/src/pages/model.ts` (fixture seam → real queries),
`server/test/worker/{web-pages,routes}.test.ts`, the push transport.
Templates under `pages/*.tsx` deliberately unchanged — `model.ts` is the
seam; a template edit here is a design smell the gate rejects (change
amplification: the seam exists so wiring touches one file per page, not two).
**Spec:** §13, §16 (router-walk test: every route in ROUTES reachable, every
reserved route refused), better-auth wiring, the ROUTES-as-data pin.
**Suites (exit):** web-pages (incl. the substituted-handler proof that pages
never execute admin ops), routes; live smoke extended with a page-render
check and (manual, once) a real push notification to a real browser.
**Grain note:** Sonnet-heavy — wiring is mechanical by construction.
**Est. scale:** ~6 agents, ~500–800k tokens.

### D10 — Final sweep *(outline; was D9's back half)*

**Grain:** inline (gates) + one review workflow.
**Owns:** nothing new — fixes route back through the owning dispatch's resume.
- [ ] Full `pnpm test` + `uv run pytest`: zero todo, zero skip, zero fail.
- [ ] `test-inventory.json` final state: every authored case `passed`; diff
  against the D1 baseline shows only `todo → passed` across the whole history
  (plus the amendments each gate recorded).
- [ ] Final deploy + the full extended smoke (by now it covers bootstrap,
  MCP handshake, tunnel, approvals, CLI device flow, both clients, pages) —
  this is a re-run of a standing step, not a first encounter.
- [ ] Cross-module PSD sweep (workflow, ~4 Opus lenses over module
  boundaries — the per-dispatch reviews saw diffs; this one judges the seams:
  registry↔gateway, gateway↔tunnel, identity↔everything, pages-model↔web) +
  a completeness critic ("which spec § has no green case pointing at it?"),
  incl. the D2 array-items redaction rows debt and the 0004 migrations-pin
  owner rows. Script staged 2026-08-26 at `.claude/workflows/d10-sweep.js` —
  launch as `Workflow({name: "d10-sweep"})`; returns `{seams, coverage}` raw,
  orchestrator writes the close-out.
- [ ] Root `/` route (user-ordered 2026-08-26): 302 to `/services` when a
  cookie session is present, 302 to `/login` when not — today bare `/` falls
  through the username matcher to a plain-text 404. One spec §13 sentence, one
  route ahead of the `/:user/mcp` fallthrough (read-only session peek via the
  existing get-session seam), and the §16 router-walk totality test learns the
  root path (it asserts served-segments set equality; `/` has no segment).
- [ ] Set root `"type": "module"` and re-verify everything: Node asks for it
  on every script run and Vite asks for it for fake-upstream.ts; deferred
  while dispatches were mutating the repo (a module-semantics flip is
  disjoint with nothing). Until then the operator scripts carry
  `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`; drop the flag with it.
- [ ] Close the loop with the user: findings, cost actuals vs estimates, what
  to harden next (real service migrations, custom domain). Dash decision
  RESOLVED 2026-08-26 (no longer parked): dash() wired production-only —
  identity.ts adds the plugin solely when env.BETTER_AUTH_API_KEY is set, so
  dev and tests never phone home; user accepted the exception, key set as a
  wrangler secret, proven live.

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
- 2026-08-25 16:00 — **D3 gated.** Workflow `wf_307a7f81-08b`: 12 agents, 0
  errors, ~1.96M subagent tokens. Oracles: 96 rows reviewed per verifier, 12
  discrepancies, 8 fixed, 4 rejected with citations (the referent-gone row's
  verdict split between resolveServiceToken and the upgrade handler was the
  substantive one). Three migrations from §5; the migrations suite's
  exhaustiveness case parses the applied DDL and found it needed **zero**
  edits. Mid-workflow red was real but shallow: registry (37) and
  identity-tokens (23) both died in seedOwner on the one unimplemented
  `resolveAuditConfig` stub — the PSD fix agent landed the minimal audit slice
  while fixing the admin auditConfig leakage finding, and the orchestrator
  re-ran everything: **worker 139 / unit 90 / 0 failures, tsc 0**. Inventory
  audit under the amended rule: 42 pure flips, exactly the 5 aggregate
  placeholders removed, 97 row-titled additions all passed, 0 regressions, 0
  foreign files. PSD: 9 findings, 7 non-low fixed, 0 disputed (proxy-only
  field set spelled once; provisionUser stopped returning a password that
  authenticates nothing; one global `D1Like` in new `workers-env.d.ts`; DDL
  DEFAULTs dropped where the domain writer always binds; identity's OWNED_BY
  fragment made one-parameter). Granted ownership extensions, recorded:
  `upstream.connectionStatus` (envelope-presence read with a ponytail ceiling
  comment; D5 replaces), two appended limits.ts constants
  (SERVICE_ACCOUNT_TOKEN_TTL_MS, TOKEN_LAST_USED_STAMP_MS). **Gate catch:**
  the inventory run flushed out a 1-in-N flake in D2's canonical key-order law
  — shuffleKeysDeep lost a fast-check-generated "__proto__" key to prototype
  assignment; fixed with fromEntries, root-caused and proven inline.
  **Debt for D4:** auth-matrix's sessionShapedBearer() fixture must become a
  real better-auth sign-in; seed teardown routes through admin's
  service_delete stub, so the tunnel project cannot seed services until D4
  lands; identity's raw forceKindColumn helper is documented in place.
  Committed `c83bb17`; D4 launched immediately.
- 2026-08-25 19:30 — **D4 gated.** Workflow `wf_846aae6a-485`: 13 agents, 0
  errors, ~3.17M subagent tokens (the biggest dispatch yet, as predicted).
  Probe first, and it earned its slot: better-auth 1.7.1 needs **no** D1
  adapter package — the kysely adapter ships its own `D1SqliteDialect` and
  duck-types the binding, so `database: env.DB` is the whole wiring; the
  contested `kysely-d1` sources were wrong. It also caught three transcription
  errors in 0001_auth.sql by field-by-field comparison against the installed
  plugin schemas (`account.issuer` missing, three `twoFactor` columns missing,
  two `deviceCode` timestamp columns that better-auth never writes) — each
  verified as a live 500 before the fix. Oracles: 85 rows per verifier, 22
  discrepancies reconciled; the substantive one was an unreachable order.table
  row (approval-gate catalog miss on an *offline* tunneled service — 
  availability-first refuses -32000 before the catalog is ever read), deleted
  rather than implemented around. Implementation: approvals 35 cases (push
  transport parked as a seam — `ApprovalsConfig.push` — with one honest todo
  until webpush-webcrypto lands), auth surface 36 (real sign-in through
  `exports.default.fetch` in the seed harness; D3's sessionShapedBearer debt
  paid), gateway 29, admin 40 (19 ops from one declaration table with a closed
  schema language in lieu of zod). PSD: 23 findings, 4 high, 18 fixed, 2
  disputed with reasons the gate accepts (§7's always-successful aggregate
  forbids the rethrow; the auth-matrix oracle ceiling needs locked-row edits).
  The fix pass extracted `errors.ts` and `principal.ts` as dependency-free
  leaf modules — the dynamic-import workarounds and their prose-guarded
  boot-crash class dissolved structurally. **Gate action:** one row stayed red
  because it needs the DO's cached catalog — a D6 dependency the plan
  scheduled two dispatches late. Pulled the minimal slice forward with a
  scoped agent: `ServiceConnection` now extends DurableObject and
  `listTools()` serves `ctx.storage.get("catalog") ?? []`; everything else in
  tunnel.ts still throws. D6 inherits the storage shape as reshapeable.
  Inventory audit: **111 pure flips, 28 additions, 4 removals** (2 aggregate
  placeholders per the amendment, 1 reconciliation-deleted row, 1 invariant
  case folded into per-row assertions — its law survives as the registered
  "three -32001 sources" case), 0 regressions. Suite 368/330/0, tsc 0.
  Excursions accepted and recorded: migrations deltas (probe-verified),
  `limits.DEVICE_CODE_TTL_MS`, `audit.query()` + `audit.config()`,
  upstream.ts's minimal transport + credential-seal halves (ponytail ceilings
  name what D5 adds: envelope-open, connect flow, refresh, needs_reconnect),
  `UPSTREAM_CREDS_KEY` fake binding in vitest config, registry typed
  refusals + delete statements. **Spec flag for the user:** §7's "expired
  regardless of stored status" is implemented as pending/approved only —
  the literal reading would erase used/rejected decision history inside the
  retention window; reasoning sits on `readStatus`, and the literal version
  is a spec commit + new table rows if wanted. **Debt:** audit's principal
  vocabulary gained a `hub` member (lazy-expiry rows; cron.swept will want
  it — D5 updates the AuditEntry doc); BETTER_AUTH_SECRET unbound in the
  test env (dev-default fallback, harmless); the parked push-decrypt todo
  becomes real when a dispatch is granted webpush-webcrypto (§13 names it —
  D7's call); scripts/test-inventory.mjs now shells `npx pnpm` because
  proto's shim went stale mid-session. Committed `ffe2c4a`; D5 launched
  immediately.
- 2026-08-25 22:45 — **D5 gated.** Workflow `wf_35c6dac9-a39`: 10 agents, 0
  errors, ~2.29M subagent tokens. Oracles: 48 rows per verifier, 20
  discrepancies, 18 fixed, 2 rejected with citations. **Six mid-flight
  grants**, all requested before use and paired with diffs at this gate:
  (1) NEW migration 0004_upstream_oauth_state — the state table §7's prose
  requires but §5's DDL never declared; spec §5 now carries the DDL
  (committed with D5); (2) fixture swap in registry/order.table tests: raw
  envelope plants → the real setHeaders seam their own stale comments named;
  (3) gateway threads UpstreamError.failureClass + bare status into audit
  detail (the cell three contracts said existed "solely for the gateway to
  copy" — D4 never copied it); (4) probeAvailability returns the refusal
  (upstream.availability minting the classed error; wire answers for
  needs_reconnect and not_connected stay byte-identical); (5) tunnel.status
  minimal slice (unconditional offline + ponytail ceiling); (6)
  gateway.blobStub reads mimeType, not the MCP block type (real D4 bug).
  **Two self-ghost episodes**: both implementers, post-summarization, forgot
  their own edits and stopped the line over a "concurrent writer"; both
  resolved by transcript-timestamp proof (67 and 10 logged writes matching
  the "foreign" mtimes to the second). Orchestrator memory updated; D6+
  prompts carry an inoculation line. **Two load-bearing harness findings**,
  both documented in fake-upstream's header: miniflare's outboundService
  cannot reject a fetch (six shapes probed — everything resolves; only an
  unsupported scheme refuses pre-routing, so "unreachable" lives in an
  ftp:// URL), and vi.mock of limits reaches test files but never src inside
  workerd (deadline rows now cost real time; worker suite ~3 min). Cron's
  implementer caught a real production bug in its own seam (scheduled()
  arity vs workerd) and collapsed it to a platform-shaped adapter at PSD.
  PSD: 19 findings (5 high), 14 non-low ALL fixed, 0 disputed — the big
  three: credentialOf() computes one verdict over mode × envelope for every
  reader (the list path had been dialing mode-mismatched services
  anonymously); redeem() distinguishes rejected from unreachable/timeout so
  a token-endpoint blip no longer bricks a service into needs_reconnect;
  wellKnown() owns RFC path insertion for both discovery documents (the
  8414 leg had been concatenating — a real 404 against tenant-scoped AS).
  Token grammar got ONE home (principal.ts TOKEN_PREFIX/tokenPattern/
  HUB_PRINCIPAL); the hygiene sweep hunts the FAKE0000 prefix structurally
  instead of a mutable planted-list. Gate: suite 500/250/0, tsc 0;
  inventory 68 pure flips, 64 additions, 12 justified removals (4
  placeholders per the amendment, 8 failure-table todos re-registered
  verbatim from verified rows), 0 regressions. **Debt recorded**: 0004 DDL
  unpinned by migrations.test.ts until an owner authors its constraint/
  cascade rows (§9 rule 1); hygiene 14a fixture repoint at D6 (in D6's
  entry); audit.exportJsonl oracle row at D7 (in D7's entry). Committed
  `d036455`; D6 launched immediately.
- 2026-08-25 23:20 — **Shift-left restructure of D7–D9 → D7–D10** (user
  request: "restructure … so that things can be end to end tested earlier, so
  that we can find structural issues earlier"). The old ordering back-loaded
  every real-world integration into the final dispatch: first true deploy,
  first WebSocket through Cloudflare's edge, and first standards-compliant
  MCP client (the gateway's method table refuses `initialize` with -32601
  today, so no real MCP client can complete a handshake) all sat in D9,
  AFTER the CLI and clients were built against fakes. New order, by
  structural risk: **D7** = initialize pull-forward (spec §7 method-table
  commit + oracle rows + minimal answer; SDK swap stays the ceiling), first
  real deploy (secrets, remote migrations, workers.dev), `scripts/smoke.ts`
  (the full live walk incl. a thin tunnel-client slice pulled from D8 driving
  a real process through the real edge into the production DO), and
  Claude-as-client as a second independent conformance check. From D7 on,
  deploy+smoke is a STANDING gate step. **D8** = CLI + clients, now proven
  against the live hub as well as fixtures. **D9** = web surface + Web Push
  (lowest structural risk — a model-seam wiring job — so it goes late; the
  exportJsonl and push-decrypt debts move with it). **D10** = the old final
  sweep, now a re-run of standing steps rather than a first encounter. D6
  unchanged and in flight.
- 2026-08-26 02:45 — **D6 gated.** Workflow `wf_ff7f8cbf-d5b`: 11 agents, 0
  errors, ~2.63M subagent tokens. The platform gate held: SQLite-backed DOs +
  WebSocket hibernation run under workerd on Windows, and serializeAttachment
  provably survives evictDurableObject. Tunnel: 154 cases across six suites
  incl. the full §7 approval walk over a live socket and CAS interleavings;
  contracts locked to nine committed fixture files (regeneration idempotent;
  fixture-only commit per README CI rule, landed FIRST so every tree is
  consistent). Design notes worth keeping: the schema-unsound verdict is
  DERIVED at read (no cache bit to disagree with itself); the catalog is one
  durable key; a 1 ms (not 0) wait turn in the harness was load-bearing
  against false "frame never came" failures. Off-workflow interleaved work
  (user-driven, committed separately): better-auth Dash wired production-only;
  Sentry wired with a conditional wrap (SDK instruments unconditionally
  otherwise), request-body capture off, scrub proven on a live stored event;
  remote D1 migrated; all seven secrets set incl. a generated VAPID pair;
  first deploys done — the live hub's auth stack is proven with a real
  bootstrap→sign-in→whoami→delete round-trip. PSD: 25 findings (9 high), 19
  fixed, 1 disputed for row-locking reasons with a compensating contract
  comment (CasStep's checked/claimed semantics — the release-seam design
  routes to a future owner call). Fix highlights: HubError.auditDetail
  generalizes the failure-class thread-through (gateway's upstream
  special-case deleted), resolveServiceToken widened to {serviceId, tokenId},
  Registry.serviceById, stamped()/prepareForward deduped, shared tunnel-do
  harness. Gate actions: deleted approval-e2e row 23 (contradicted
  availability-first; its healing-arc half moves to D7's oracle stage as a
  new verified row), fixed admin.evict's stale ponytail note. Suite
  698/104/0, tsc 0; inventory 139 pure flips, 59 additions, 7 removals (6
  placeholders + the documented row deletion), 0 regressions. **Debt:** 5
  contracts parity todos wait for D8's CLI by design; spec §7 amended with
  the initialize method (D7 implements it). Committed `f4370c9` (fixtures) +
  `eb0d5f1` (implementation); D7 launched immediately.
- 2026-08-26 04:40 — **D7 gated — the shift-left milestone: SMOKE PASS, 22/22
  steps against the production hub.** Workflow `wf_d6167336-02f`: 8 agents, 0
  errors, ~1.1M tokens. The initialize handshake landed with its values pinned
  by a mutation-proven case (the PSD pass caught that the first two oracle
  rows asserted only "not -32601" — green under `result: {}` — deleted them
  and wrote a case reading the revision off server/discover, never a
  transcription); notifications/initialized got a real 202 case; approval-e2e
  case 23 reborn correctly (availability outranks the catalog; falsifiability
  proven by mutation since D6 had already shipped the ordering).
  scripts/thin-serve.ts (moved out of clients/js/src by PSD — no second
  working serve beside the throwing product API) verified against a
  hand-rolled WebSocket harness covering every close-codes.json behavior.
  Inventory: 3 pure additions, zero anything else. Then the inline half:
  deployed `73904cdd`, ran scripts/smoke.ts against production — bootstrap,
  auth, tokens, MCP handshake, a REAL tunneled service from this machine
  through the edge into the production DO, grant, list/call over the live
  socket, the full approval walk executing exactly once, 9 audit rows, full
  cleanup. **Deploy+smoke is now the proven standing gate step.** Debt noted:
  initialize's answer values want an owner-run contracts family (flagged by
  two agents independently); §6's upgrade-matrix split (401-fatal vs
  403-archived) is undecidable on Node's bare WebSocket — the full client's
  raw-upgrade path owns it (D8). Committed `042aa96`; D8 launched
  immediately.
- 2026-08-26 11:15 — **D8 gated.** Workflow `wf_c98880bb-7a5`: 10 agents; the
  psd-fix stage died on a transient API refusal and was re-run via cached
  resume (9 agents replayed free; the retry leg ~362k tokens). Landed: the
  pmcp CLI (pure planner, command table driven end-to-end by a
  recording-fetch suite, subset YAML parser proven by planning §9's own
  example, device-flow login), both client libraries (JS
  HubTransport/serve/caller with the ws raw-upgrade 401/403 split; Python
  port 58 cases with a public terminal/closed() surface), the bootstrap CLI,
  smoke at 24 steps riding the real client, the 5 contracts parity todos
  green. thin-serve.ts deleted — its own header's ceiling ("the fork ends
  when this file is deleted"), net -363 lines. PSD: 16 findings applied;
  notable: the constructor stays §11's {url, token, roles} with a
  module-level `seams` object (the ESM twin of Python's monkeypatched module
  attrs); commands.ts witnessed by real main(argv) runs against a recording
  fetch; confirm() refuses off-TTY instead of applying nothing and exiting 0.
  Gate (owner) actions: `ws` + @types/node + @types/ws declared and
  types/ambient.d.ts deleted (4 small type fixes); `pydantic` declared in
  clients/py (same undeclared-direct-import gap as ws); spec §9 wildcard
  example fixed (`c308190`) and yaml.test.ts's SPEC_EXAMPLE made truly
  verbatim — it had silently dropped linear and the home grant, and its
  title said "four services" while asserting three; thin-serve citations in
  policy-rows.ts/test_transport.py annotated as historical; Direction-D
  classification ACCEPTED as authored (tools/list & tools/call rows map to
  the gateway method they front; unmapped = {login, logout, whoami});
  cron.swept visibility RESOLVED stays-invisible (recorded at D9's header).
  Suite 850/34/0, tsc 0, pytest 58, SMOKE PASS 24/24 — no deploy: D8
  touched no server/src file, production still runs D7's worker. Inventory:
  61 flips, 88 additions, 9 removals all audited (aggregate placeholders
  row-registered per the standing amendment, plus verifier-CONFIRMED
  re-authorings: the constructor row's https-only claim was false against
  the fake hub's http dial; the empty-grants row contradicted the
  empty-plan sentence), 0 regressions. WATCH: approval-e2e CAS case 9
  ("two identical legs both check the same approved pass") flaked ONCE
  under a reporter-mode full run, passed twice directly and once isolated —
  a deterministic-interleaving case that can flake is a harness bug if it
  recurs. Debt → D10: CLI-side fixture consumer for
  service-list/account-list (the CONTRACT_FAMILIES consumers row is
  owner-authored data); the yaml-package swap stays a one-line upgrade.
  Committed `80860c2`; D9 launched immediately.
- 2026-08-26 13:25 — **D9 gated, plus the user-driven profiles dispatch — one
  combined gate. The suite is at zero: 899/899, no todo, no skip, no fail**
  (D10's first criterion met a dispatch early); pytest 58; tsc 0; deployed
  `b0853623`; SMOKE PASS 25/25 against production including the page leg.
  D9 (workflow `wf_1d5bdd17-f9a`, 5 agents, ~1.14M tokens): all eight pages
  get real loaders in pages/model.ts (fixture seam retired, templates
  byte-untouched as fenced); web.ts's five mutations share one mutation()
  gate; index.ts mounts from a MOUNTS table so §16's walk derives
  RESERVED_ROUTES (13 segments — styles.css rides the bundle via a Text rule;
  spec §2 amended `f69a4c1`); identity.callAuth is §4's custodianship as a
  function; wiring.ts reads VAPID_PRIVATE_KEY in exactly one place. Push is
  real VAPID ES256 + encrypted body, proven by a suite that plays the push
  service (wrong key REJECTS; plaintext exactly {approvalId, service, tool,
  url}; ciphertext opaque). Production VAPID pair regenerated in the tested
  raw-scalar form (the format blocker closed). KNOWN CEILING recorded in
  push.ts: webpush-webcrypto speaks draft-04 aesgcm, not RFC 8291 — Apple
  Web Push will refuse; D10 decides (library swap vs accept). PSD: 9
  findings, 6 designs applied incl. two repairs of PRE-EXISTING breakage my
  own operator commits caused (users.mts made `../users` ambiguous;
  developer .env leaked BOOTSTRAP_SECRET into the unset-row) — lesson
  absorbed: owner-convenience commits get a suite run too. Escalations
  parked to D10: dead ApprovalsConfig.vapid field (11 sites, locked files);
  audit-page chevron (template-locked); manifest icons; /device §5.4 gap;
  /account's three unsourceable fields; AUDIT_SCAN_ROWS ceiling.
  **THE SHIPPED BUG:** the pages lane's highest blocker — credential forms
  post form-encoded, better-auth accepts only JSON, so web login 415s — was
  gated as a D10 work item, and the USER HIT IT LIVE the same hour (account
  `ahrzb` exists, created via pnpm users). Promoted immediately: a login-fix
  agent is in flight (hub-side translation routes over identity.callAuth,
  plus the missing oracle class). Root cause written into testing-strategy
  §9 rule 4: the CSRF walk excluded /login, the parity walk excluded
  better-auth forms — two principled exclusions intersecting to an unwalked
  front door; henceforth exclusions are enumerated and spent, and every
  rendered form gets a submitted-as-the-browser case, third-party action or
  not. Profiles dispatch (`wf_d7bed4f4-d1d`, spec-first `ac4b335`, committed
  `5f5da04`): ~/.config/pmcp/config.toml with [profiles.*] tables via a
  hand-rolled TOML subset; --profile > PMCP_PROFILE > file default >
  "default"; per-profile login/logout; 15 cases. Operator setup done: config
  file holds prod+local, .dev.vars created (dev-only secrets incl. a local
  VAPID pair), .env DELETED (it was overriding profiles — env always wins),
  smoke joined applyProfile post-gate. Inventory: 34 flips + 15 additions,
  0 removals, 0 regressions. approval-e2e CAS case 9 flaked once more under
  concurrent-agent load (cleared unchanged) — the D10 investigation stands.
  Commits: `ac4b335`+`f69a4c1` (spec), `5f5da04` (profiles), `59264a5` (D9),
  this entry + strategy rule + inventory close the gate.
- 2026-08-26 — **Login-fix gated.** The 415 postmortem's fix: commit
  `c6abf9d`, deploy `f880d71f`, SMOKE PASS 25/25 live, suite 904/904 (+5:
  web-pages cases 21-25, red observed first), tsc 0, pytest 58/58. The bug
  was three-headed with one root — sign-in 415, sign-out 415 on its empty
  form post, and better-auth's MISSING_OR_NULL_ORIGIN refusing every
  cookie-bearing internal call (so /device approve/deny was broken too).
  Fixed at the seams: nine translation routes in web.ts (login family gated
  by crossOrigin, account family by mutation()), callAuthResponse in
  identity.ts (sole-custodian rule intact; internal requests state
  origin: PUBLIC_ORIGIN), 9/11 paths.auth repoints plus two dead-link fixes
  in model.ts (?confirm=, ?method=). Live proof: 303+Set-Cookie, deep link
  honoured, evil callbackURL refused, cross-origin POST 403, prod probe
  answers the old 415 with a field-error 303. Agent-recorded ceilings:
  passkey plugin absent (buttons inert), 2FA-enable needs a password field
  the locked template lacks (TOTP enrollment card unreachable), /login TOTP
  step needs JS, sign-out stands on crossOrigin alone (case 4 names the
  exclusion). Riding this gate as the owner batch: the postmortem track
  (docs/superpowers/postmortems/, 3 entries), the libuv exitCode workaround
  in cli/pmcp.mts + scripts/users.mts (nodejs/node#56645, fixed upstream
  only in Node 26.7; postmortem closed with deterministic repro), the
  smoke.ts profile bridge, `pnpm dev`, and the staged D10 sweep workflow
  (.claude/workflows/d10-sweep.js). D10 launch HELD at user request.
- 2026-08-26 — **D10 gated — the dispatch ledger closes.** The seam sweep
  (.claude/workflows/d10-sweep.js: four Opus lenses over registry↔gateway,
  gateway↔tunnel, identity↔custody, pages↔web, plus a coverage critic;
  every finding adversarially refuted, two refuters per blocker) surfaced
  ONE live blocker: better-auth's /api/auth/sign-up/email was open on the
  public mount — any anonymous POST self-provisioned a full namespace,
  bypassing §12's bootstrap gate. Killed same turn: disableSignUp in
  identity.ts, actor-real regression test, commit `13a8179`, deploy
  `dc835e60`, live before/after probes (now EMAIL_PASSWORD_SIGN_UP_DISABLED).
  Postmortem: docs/superpowers/postmortems/2026-08-26-public-signup-open.md
  (class: boundary-actor — no test had ever POSTed sign-up). By owner
  decision the sweep's remaining 9 findings (2 auth-seam security, 4 tunnel,
  redaction fail-open, 2FA-password ceiling) + 12 coverage gaps went to
  docs/superpowers/plans/2026-08-26-d11-remediation.md, not fixed inline.
  Inline batch `c6f8ee9`: bare `/` redirects by cookie session (owner →
  /services, else /login — user request, requireOwnerSession reused, §16
  walk untouched); dead ApprovalsConfig.vapid removed across 8 files;
  approval-e2e CAS case 9 root-caused as a test-orchestration race (it
  asserted WHICH racing leg wins — workerd's call; now multisets within
  runner-unorderable cohorts, mutation-tested, 11 green runs) — the flake
  that stalked D6–D9 is closed; package.json type:module (warning flag
  dropped); .tokens gitignored. Gate: suite 907/907 (34 files), tsc 0,
  pytest 58/58, inventory +3 / 0 removals / 0 flips, deploy `4d3bf3d7`,
  SMOKE PASS 25/25 live, anonymous GET / → 302 /login probed on prod.
  Cost shape: ~17 sweep agents (4 lenses + critic + refuters) + 1 CAS9
  investigator, all Opus per the subagent-model rule. Docs rode the gate
  as `5d8a112` (README + client quickstart, user request). Every dispatch
  D0–D10 is now gated ✓; open threads live in the D11 plan (incl. the
  inbound OAuth server for claude.ai connectors) and the postmortem index.
- 2026-08-26 — **D11 gated — the D10 sweep's debt is paid.** Two Opus
  workflows: the remediation wave (`wf_c65b03d1-52b`, 4 fix + 4 gap + 1 PSD)
  fixed §4's recent-auth-on-credential-POSTs, the bearer→credential-family
  reach, redaction fail-open, and four tunnel findings, and authored the 12
  coverage gaps red-first; then a PSD-remediation wave (`wf_d918fc31-904`, 5
  fix + 1 PSD) turned that review's own findings into fixes — the bearer guard
  inverted from a fail-OPEN denylist of better-auth's route table to a
  fail-CLOSED allowlist, the "may have executed" disclosure unified into one
  errors.ts class→semantics table both dispatch backends read, an unbounded
  re-warm bounded to one in flight, the §10 aggregated-tool-name charset gate
  implemented, PasswordField's per-caller id dropped, and the 100%-dead
  `pmcp --since/--until/--expires` duration flags made real. The second PSD
  found ONE blocker and verified it end-to-end: the first allowlist admitted
  the whole `/device` subtree, so a stolen CLI token could self-approve a
  SECOND owner session surviving revocation of the first (§4's persistent
  takeover, reached through the door the fix closed). Fixed inline — allowlist
  narrowed to `/sign-out` + the anonymous `/device/code`·`/device/token` legs,
  claim/approve/deny cookie-only, smoke.ts moved to cookie approval — and
  mutation-checked (reverting the allowlist reddens the retargeted case).
  Gate: suite 967/967 (34 files, 907→967: 60 passing adds + 3 cascade-case
  rewordings for `upstream_oauth_state`, no removed coverage), tsc 0, pytest
  58/58, deploy `d0879ada`, SMOKE PASS 25/25 live (the device step now drives
  cookie approval on prod). The `initialize` fixture landed as its own commit
  `3a3a67a` per the contracts rule. Candidate finding recorded, not fixed:
  nothing prunes stale audit rows past retention (out of D11 scope). All Opus
  per the subagent-model rule. Next: D12 — inbound OAuth — off the READY spec
  (`26d5d12`); its plan opens with a blocking better-auth probe stage.
- 2026-08-26 — **D12 gated — the hub is an inbound OAuth authorization server.**
  A claude.ai connector can now attach without a pasted key: discover the AS off
  `/<user>/mcp`'s 401, run code+PKCE in the owner's browser, consent to a service
  account, present a hub-signed JWT the door resolves to `sa:<slug>` —
  indistinguishable from that account's `pmcp_sa_` key from the moment it lands
  (§18 decision 23). The blocking probe ran first and settled §19.1: the verify
  primitive is `verifyJwsAccessToken` from `better-auth/oauth2` (the symbol the
  first spec draft wrongly said didn't exist) with a FUNCTION `jwksFetch` source —
  local verify, zero extra D1 reads, no direct `jose` dep; `verifyJWT` is unusable
  outside an endpoint context. Six GREEN, one AMBER (that §19.1 correction), no
  RED; the probe also closed open questions 1 (the `oauthResource` row is
  necessary) and 5 (Ed25519 works on workerd). Implementation ran A→B→C→D→E, each
  group red-first from the plan's oracle titles, then a two-agent adversarial PSD
  (both PASS: the door leg is provably terminal — no JWT-shaped bearer reaches the
  session lookup, structural not enumerative; `oauth.ts` hides that better-auth is
  the AS). Three integration-seam blockers surfaced by the groups and fixed inline
  by the orchestrator (each an unowned seam: the `oauth` mount's page fallback, the
  missing `allowPublicClientPrelogin`, and `cli/test/commands.test.ts`'s ARGV
  mirror). Gate: suite 1041/1041 (35 files), tsc 0, pytest 58/58, inventory +74 /
  0 removed / 0 downgraded, migration 0005 applies fresh + no-op re-applies.
  **The live smoke earned its keep**: it caught a production **Error 1102**
  ("Worker exceeded resource limits") on the create path that the vitest suite
  could never see (miniflare enforces no resource limits) — root-caused by
  benchmark to D12's `jwt()`+`oauthProvider()` making each `betterAuth()`
  construction ~5.6x heavier (~0.65→~4.30 ms) while `auth()` rebuilt it per
  request; fixed by memoizing `auth()` per isolate (`buildAuth()`, 29x cheaper
  repeated construction, worker suite 624/624 green — env from `cloudflare:workers`
  is per-isolate-stable). Two smoke-only fixes for real provider behavior: the
  `/oauth2/authorize` `{redirect,url}` envelope a `fetch` gets vs the 302 a browser
  gets, and the form-encoded `/oauth2/token` exchange (JSON is 415). Deploy
  `c31c4be0`, **SMOKE PASS 26/26 live** — the full round-trip mints a JWT reaching
  `tools/call` on both endpoint shapes as `sa:<slug>`, and revoking it 401s the
  next call. The contracts fixture landed alone (`be94c17`) per the CI rule.
  Candidate recorded, not a postmortem (the gate caught it pre-user): the vitest
  suite cannot catch Workers resource-limit regressions — the live smoke is the
  only net, so bundle/construction-cost growth needs a deliberate watch. All
  subagents Opus/Sonnet per the model rule. Next: D13 (§20, the MCP data model) —
  NOT started at the owner's instruction.
