# Roadmap after D15 — tests faster, then the gaps

> **Status.** D15 gated 2026-09-02: `005843d` prep, `628a5ee` rows, `3db6e49` impl, `b7c0a3d` ledger; deploy `16bdc8e5`, SMOKE PASS 29/29 live; `test-inventory.json` 45 files / 1432 passed / 0 todo; `tsc` 0. Gap audit 2026-09-02: 85 raw claims → 38 merged → 37 verified by two lenses, 5 refuted; register G1–G39 (5 blocking, 12 visible, 11 recorded, 11 hygiene). Orphan-states report 2026-09-02 (`2026-09-02-orphan-states.md`): 192 states traced, 146 reachable, 40 orphans O1–O40, 6 refuted, 55 fixture notes — its facts are G40–G58, and the **owner decided every one on 2026-09-02** (concept / garbage / meaningful — the appendix's disposition column). Concepts already moved, uncommitted: seven boards (`Agents`, `AgentDetail`, `GrantEditorStates`, `AuditDetailStates`, `AppNewProxiedStates`, `ReauthGate`, `OauthConsentStates`) now live in `design/concepts/` with their own `canvas.json` and README (`git status`: seven renames + two untracked), `design/README.md:51-55` points there, and the main canvas's page 2 is "Adopted 2026-09-02 (re-layout pending)" holding only `AppDetail`, `AppDetailPanes`, `AppDetailStates`, `SettingsTokens`, `OauthConnections`, `OauthConsent`. That move rides **D16's ledger-row commit** (step 1's last act — first in order, and a docs/design commit, so D16's four `test:` commits stay pinned to `server/test/**` + `vitest.config.mts`). Also untracked: the profiler's report and optimizer config, `.mcp.json`, `mcps.yaml`, `.impeccable/`.
> **Covers.** Every step the orchestrator runs from here until the register is closed, in the owner's fixed order: the test-speed dispatch (D16) first, then the gaps in the audit's closing order. Each step gets its own detailed plan when it is reached; this document says what that plan must settle and gives each step a checkable Definition of Done. It settles nothing a detailed plan owns.

## What a step is

A step is a unit of the orchestrator's own work, run end to end before the next begins. Agent stages inside a workflow are not steps.

| Shape | What the orchestrator does | Its gate |
|---|---|---|
| inline fix | edits in the main loop; rows (if any) land as `it.todo` in a `test:` commit first, the `fix:` commit flips them; production changes deploy with the step or with the next inline step's deploy, never wait for a dispatch | the inline gate |
| dispatch | detailed plan → oracle rows as `it.todo` in their own commit (testing §9 rule 1) → implementation workflow → gate → ledger row | the standard gate |
| spec-first dispatch | the owner reviews the §13 text and the design board first — no oracle row exists before that review — then a dispatch | owner sign-off, then the standard gate |
| owner decision | a written question sheet citing the spec sentence and file line each answer touches; the answer lands as a `spec:` commit or a decision-log entry | the commit |

**The standard gate**, stated once and inherited by every dispatch-shaped step as the first line of its DoD: `docs/superpowers/plans/2026-08-25-implementation-orchestration.md` § "Dispatch anatomy and the standard gate", items 1–7 — `pnpm test` green with the todo count equal to plan; `node scripts/test-inventory.mjs` then `git diff test-inventory.json` showing only `todo → passed` for the dispatch's rows plus enumerated retirements at the key level; `npx tsc --noEmit` 0 and `uv run pytest` collecting; the ownership audit against the plan's Owns globs; the PSD verdicts (`.claude/skills/psd/SKILL.md`, schema `{flag, file, line, readerCost, eliminatingDesign, severity}`) each fixed or accepted with a reason; the delta shown and a commit proposed; the next entry detailed. Since D7: deploy + `pnpm smoke` (29 legs today) and the ledger row. Two lines added 2026-09-02: the states preview is a kept reference (D15 plan constraint 13), so a fixture for an orphan state — a state no loader or route produces — is a fixture to retire or a state to build, never left as decoration; every gate's preview walk asks that of each fixture the step touches, and `2026-09-02-orphan-states.md` § "Fixture notes" (55 entries, values fabricated for states that are reachable) is read for the step's pages. And boards under `design/concepts/` are exploration, never contract — a spec-first step adopts one by moving it onto the main canvas in its `spec:` commit. **The inline gate** is items 1–3 plus the deploy and a dated one-line ledger entry — no workflow, no PSD panel; the orchestrator's own diff read stands in for item 5. A step's DoD lists only what it adds.

## Step table

Audit closing-order steps 6 and 7 (owner decisions; the browser session) are folded into step 3; the other nine keep the audit's order and shapes, with two insertions: the owner's garbage list is one chore commit placed immediately after D16 (step 2 — it edits `server/src`, which D16's DoD needs untouched until D16 lands), and the proxied add-app states (G43–G46) are their own spec-first step (11). One deviation, argued in step 3: the browser session's passkey, TOTP and install legs run after steps 5 and 7, which change what they observe.

| # | Step | Audit step | Shape | Depends on | DoD, one line |
|---|---|---|---|---|---|
| 1 | D16 — test speed: the profiler's four causes, in order | — | dispatch, four commits, no new rows | — | 45 / 1432 / 0 unchanged, inventory byte-identical, no production constant changed, wall ≤ 210 s after each commit; the concepts move rides the ledger-row commit |
| 2 | Garbage — `chore: remove unreachable page branches` (G40's `info` half, G41, G42, G47, G48, G53, G54, G56, G58, the fabricated backup-codes line of G10) | — (inserted) | inline fix, one commit | 1 | every named identifier greps to nothing; 45 / 1432 / 0 with the inventory byte-identical; `tsc` 0; diff confined to the six file kinds |
| 3 | Owner sitting — 3a decisions (D15's seven + the audit's eight), 3b the browser session (D15's manual leg + G25's five CSS checks + the legs steps 5 and 7 create) | 6, 7 | owner decision + owner action | 3a: — (beside 1); 3b: 5, 7 | answers in `spec:` commits; observations in the ledger; the gate rule for unreviewed rows amended |
| 4 | `/login` landing: reflected XSS + open redirect (G15), the method-switch link dropping the landing (G7) | 1 | inline fix, own deploy | 2 | rows green, no raw `<` from `?next=` in the inline script, absolute `next` refused on both consumers, CSP decision recorded |
| 5 | `/settings` truth pass: `credential()` returns better-auth's body → TOTP enrol + its error arm (G3, O4), backup codes with a working Copy codes (G4, G30), the session `source` seam (G9), passkey names (G16), the dangling comment (G31) | 2 | small dispatch | 4 (shares `login.tsx`'s OTP script) | standard gate; every settings fixture has a producer; `plantPasskey`'s row made honest |
| 6 | `/audit` chrome: the filter form's missing submit (G5), the date-range input and the inert sort glyph (G11), and what the input makes real — the empty-window copy (G50) and the custom-range tiles (G51) | 3 | inline fix | 2 | rows green; `#audit-filters` submits with scripting off; `custom` and `empty` fixtures have producers |
| 7 | PWA icons (G6) | 4 | inline fix | 2 | manifest `icons` non-empty, each `src` 200; head links an icon; install affordance observed in 3b |
| 8 | One-liners: G17, G18, G14, G36, the `agents` reservation (G28, if 3a reverses decision 30:239), the failed-decision warning notice (G52, built), and the string edits 3a produces (G27's four, G8/G12 interim copy, G29's two CLI columns) | 5 | inline fix, one deploy for 6–8 | 3a | one commit per gap id; rows where a row is possible; SMOKE PASS |
| 9 | `/agents` list + detail + the (agent × app) grant editor (G2), the fifth nav slot (G28 nav half), closing G8's and G12's pointers | 8 | spec-first dispatch, from `design/concepts/` | 3a, 5, 8 | board pair + §13 text signed off; rows in own commit; standard gate; two new smoke legs |
| 10 | `/audit` expanded row: the expand control (G1), the bodies-not-recorded sentence (G24), the body-stub placeholders the loader never emits (G49) | 9 | spec-first dispatch (implementation may run inline), from `design/concepts/` | 6 | §13 paragraph + board signed off; toggle row, bodies-off twin and stub row green |
| 11 | Proxied add-app states: field errors for name and endpoint (G43), the endpoint URL check (G44), the multi-error state (G45), the "Connecting to …" interstitial (G46) | — (inserted) | spec-first dispatch, from `design/concepts/` | 8 | §13 add-app text + `AppNewProxiedStates` adopted; every `/apps/new` fixture has a producer |
| 12 | Design pass: the adopted boards vs §13 (G20), Apps row links (G19), fixture mis-citations + Dialogs/MobileAppDetail (G32), README/flows staleness (G33), `support.js` (G34), page 2's pending re-layout | 10 | small dispatch, design/ + server/dev/ only | 9, 10, 11 | inventory byte-identical; owner eyeballs the boards; README says which width is contract |
| 13 | Hygiene: rules spelled twice (G35), the audit scan ceiling labelled (G22), the ownership sentence (G37), the two false records (G38), G39's line retired or paid | 11 | small dispatch | 3a | +2 rows green; each rule defined once by grep; the amendments in place |
| (14) | Push encoding swap — only if 3a chooses the library swap for G23 | — | small dispatch | 3a | `aes128gcm` / `vapid t=,k=` on the wire; `push-service.ts:189` pins the RFC label so the test can go red |

## Step 1 — D16: the test-speed dispatch

> **Landed 2026-09-02, gated.** Three commits (`fb84d66`, `8200625`, `43b0e06`); cause 4
> nulled (the shape was already in the tree; sharing cannot reach the threshold). Wall
> 385.26 → 213.07 s (median of five on the final tree); the ≤ 210 s target missed inside
> the 2.6 % run-to-run noise, the Exit clause fired, **the owner accepted 213 s**. The
> `design/concepts/` move rode the ledger-row commit as planned. Details: the D16 plan's
> "As landed" section and the ledger entry. Carried to step 3a: the `stream.test.ts:631`
> flake's precondition fix; to step 13: two surviving timer-wrapper copies.

**Achieves.** The full suite's wall drops from 385 s (`2026-09-02-test-slowness-profile.md` §0, run D: 45 files, 1432 tests) to a committed ≤ 210 s by removing the four ranked causes the profiler measured, in its order, without changing what the suite proves: (1) `upstream-proxy.test.ts` waits out the real `CALL_TIMEOUT_MS` 30 s / `AGGREGATED_LIST_DEADLINE_MS` 10 s (`limits.ts:13`, `:21`; enforced at `upstream.ts:207/446/1033` via `AbortSignal.timeout` and `gateway.ts:862 withDeadline` via `setTimeout`) — 10 of its 48 tests cost 193 s, ≈123 s of wall (report §1 #1); (2) `protocol.test.ts:401` spends the full 250-tick `waitFor` budget on eight `catalogWarmed: false` rows at 4.07 s each — ≈31 s (#2); (3) every worker-project file re-loads 1,678 modules through the host, 13.2 s cold setup per file, pre-bundling the seven direct deps measured 6.8 s and 417 URLs — ≈25–30 s extrapolated (#3); (4) `web-pages.test.ts` mints a scrypt-backed owner session per case (77 `seedOwnerSession` call sites, 92 ms per hash) — ≈20–30 s (#4). All four are the strategy's own rule — "shrink the constant, never wait it out" (testing §2; `limits.ts` header) — and none touches the never-faked list.

**Depends on.** Nothing; runs on the D15-gated tree at `b7c0a3d`.

**Shape.** Dispatch with no oracle rows: this dispatch adds no rows and retires none, so its oracle is the existing suite's byte-identical inventory plus the measured wall. Four commits, one per cause, in the report's order, each green alone. The edits are small (≈15 lines, one line, one config block, one describe restructure), so the workflow is Opus 5 or cheaper per agent (memory: Fable stays in the main loop); one agent per cause or one agent under a per-cause commit discipline is the detailed plan's call.

**The four commits, in order.**

| # | Commit | Mechanism | Expected (report) |
|---|---|---|---|
| 1 | `test: upstream-proxy — map the two deadlines to shrunk values` | wrap `globalThis.setTimeout` (covers `withDeadline`) and `AbortSignal.timeout` (covers `upstream.ts`) with an exact-`ms` mapping for the two named constants, restored in `afterAll`; precedent `listen.test.ts:191-206 withShrunkKeepalive` (`ms === LISTEN_KEEPALIVE_MS ? SHRUNK : ms`) and `tunnel/stream.test.ts:150-160` | file's tests 194 s → 5–10 s; wall ≈ 260 s |
| 2 | `test: protocol — 15-tick budget for the catalogWarmed=false rows` | `protocol.test.ts:401` takes the short budget lines 634 / 768 already pass (`15`) | −31 s |
| 3 | `test: vitest — pre-bundle the worker project's direct deps` | `test.deps.optimizer.ssr` block from `2026-09-02-test-slowness-profile.optimizer.mts` into `vitest.config.mts`: `include` the seven direct deps, `node:` / `cloudflare:` external | cold setup 13.2 → 6.8 s per file; −25–30 s wall |
| 4 | `test: web-pages — one owner session per read-only describe` | describe-level `beforeAll` session for the sweeps that only read pages; per-case sessions stay where a case mutates the session or credential | −20–30 s |

**Target and its margin.** The report's arithmetic: 385 − 123 − 31 − (25…30) − (20…30) ≈ 171–186 s, "≈180 s". The commitment is **≤ 210 s**. #1 and #2 are measured deltas (run G, the worker phase without the file: 117 s against 240 s; eight rows × 4.07 s); #3 is extrapolated from 1- and 3-file setup deltas, never run end to end (report §4); #4 is a grep count of call sites, not executed sessions (§4). 210 s holds if the two extrapolated causes deliver 22 s of their estimated 45–60 s. Above 210 s the dispatch is not gated: the detailed plan names the next cause to open (report §1 #5 is the list) or the owner accepts the number in the ledger row with the shortfall attributed per commit. These are Windows numbers — a 1 ms timer costs 15–16 ms here (report §3 item 3) — and the ledger row says so.

**Definition of Done.**

- [ ] The standard gate, with item 2 read strictly: after `node scripts/test-inventory.mjs`, `git diff --exit-code test-inventory.json` exits 0 — zero added, removed or changed keys; `pnpm test` reports 45 files / 1432 passed / 0 todo / 0 failed.
- [ ] If a row must legitimately change (a title or assertion the shrunk values falsify): it does not ride a speed commit — it lands as its own `test:` commit ahead of the speed commit that needs it, the removed + added key pair enumerated in the ledger row, owner-reviewed (testing §9 rule 3: red is never resolved by editing the test). No title in `upstream-proxy.test.ts` names a duration today (`:1337` names the two constants by name), so the expected count is zero.
- [ ] `npx tsc --noEmit` 0.
- [ ] No production constant changed: `git diff b7c0a3d..HEAD --stat -- server/src cli clients scripts contracts wrangler.jsonc` is empty. `limits.ts` still says `CALL_TIMEOUT_MS = 30_000`, `AGGREGATED_LIST_DEADLINE_MS = 10_000`; `fake-app.ts:865`'s 1 ms tick untouched. The four `test:` commits touch only `server/test/**` and `vitest.config.mts` — committed by explicit path, so the uncommitted `design/` move is not swept up.
- [ ] The never-faked list (testing §9: sibling module, D1, the `AppConnection` DO, WebCrypto, the MCP SDK) untouched, checked on the diff: no `vi.mock(`, no new file under `server/test/harness/` beyond a shared timer helper, no `isolate: false` on the worker project (report #3: "not a fix"), no `emailAndPassword.password` override (report #4: a prod-code branch on env, "arguably faking better-auth").
- [ ] Four commits, one per cause, in the report's order, `pnpm test` green at each — a regression bisects to one cause.
- [ ] Measured wall, four numbers: the before is 385.26 s (run D, report §0). After each commit, full `pnpm test` wall from vitest's own `Duration` line on the same machine with nothing else running — `tasklist | findstr /i "workerd wrangler"` empty before the run (run D itself carried two idle `wrangler dev` servers, report §4; the after-runs carry none, a small unknown in the after's favour that the per-file numbers below bound). The fourth number ≤ 210 s. All four in the ledger row as a descent.
- [ ] Per-file bisect handles from the final run (vitest `--reporter=json`): `upstream-proxy.test.ts` tests ≤ 10 s; `protocol.test.ts` tests ≤ 12 s; first-wave worker-file `setup` ≤ 25 s (was 38–39 s); `web-pages.test.ts` tests ≤ 55 s (was 72.8 s).
- [ ] The two-knob assertions at `upstream-proxy.test.ts:1346-1349` still compare by name against the shrunk values with the ratio kept (shrunk list deadline < shrunk call budget), and `CASE_BUDGET_MS` (`:717`) derives from the shrunk values — read off the diff; mechanically, the file's runtime bound above cannot hold otherwise.
- [ ] PSD review over the four diffs. One finding pre-named so it is not discovered late: the setTimeout-wrapper shape now exists in three files (`listen.test.ts`, `stream.test.ts`, `upstream-proxy.test.ts`) — fixed (a harness helper) or accepted with a reason.
- [ ] Deploy: none — the empty-diff check above is the proof nothing shipped; the ledger row cites `16bdc8e5` as the standing deploy and `pnpm smoke` is not re-run for this dispatch.
- [ ] Ledger row in the orchestration plan's dispatch table and dated entries: D16, the four commits, the four wall numbers, the per-file numbers, the PSD disposition, the cold-cache number from the next item. **The same commit carries the `design/concepts/` move** (seven renames, `design/concepts/README.md` + `canvas.json`, `design/README.md`, `design/canvas.json`) and says so.

**What step 1's detailed plan must settle** (named, not settled):

- Cause 1: the exact shrunk values (the report suggests ≈300 ms / ≈150 ms) and the ratio; whether one wrapper covers both `globalThis.setTimeout` and `AbortSignal.timeout` or two; file-local like `listen.test.ts` or a harness helper the three files share; `beforeAll`/`afterAll` scope or per-row; which of the file's ten slow tests are hang rows (`:450`, `:462`, `:1277`) and which merely share the `HANGING` app at `:1174`; and the header comment at `:51-59` ("the constants here are the REAL ones"), which becomes false and must say what the wrapper does and why `vi.mock` still cannot.
- Cause 2: whether `hibernation.test.ts:255` (`.toBe(row.survives)`) shrinks with `protocol.test.ts:401` — run D showed no 4 s rows there, so probably not; whether `15` stays a literal beside `:634` / `:768` / `:940` or becomes a named negative budget in `harness/fake-app.ts`.
- Cause 3: the `include` list (the optimizer config's seven direct deps; transitive packages fail on pnpm's strict layout and `@sentry/cloudflare`'s `node:async_hooks`, report #3 risk a); worker project only or the tunnel project too — the report's −6 s tunnel setup assumes both, and the tunnel pool is `workersPool`, not `workerPool` (`vitest.config.mts`), so it is one block or two; the canary (the report's 121-test run vs the whole worker project, which the gate runs anyway); the **cold-cache cost**: the bundle lives in `node_modules/.vite` (gitignored through `node_modules/`; no `.vite` entry needed), no test CI workflow exists (`.github/workflows/` holds `publish.yml` only), so "CI cold cache" today is an owner-side `rm -rf node_modules/.vite` costing the ~2–3 s optimizer build — measured once and recorded; and the stale `results.json` probe entries (report §3 item 7) cleared or left.
- Cause 4: which of the 19 `describe` blocks (7 `beforeAll`, 77 `seedOwnerSession`, 61 `seedNamespace` call sites) are read-only — the mechanical criterion is a per-describe count of `formPost(` / `post(` / `ageSession(` / sign-out calls; the sharing shape (describe-level `beforeAll` session); whether `vitest run --project worker web-pages --sequence.shuffle` is adopted as the coupling check, given it may expose pre-existing order dependence outside this dispatch's scope; and the floor (the ~30 real form-POST cases stay per-case).
- Measurement: wall from vitest's `Duration` line; per-file numbers from `--reporter=json` or by bringing the profiler's `timing-reporter.mjs` (scratch dir, not in the repo) into `scripts/`; one run per commit or best-of-two.

## Step 2 — Garbage: `chore: remove unreachable page branches` (inline fix, one commit)

> **Landed 2026-09-03.** Ten files, 45 / 1432 / 0, inventory byte-identical, `tsc` 0. G42's
> premise was false (`noticeOf`'s success arm sets no title) — settled as a `Notice` union
> where only `danger` requires a title; nothing rendered changed. Settled: the tone tables
> keep their copies (step 13); the revoke-session confirm carries `label`; the detail page
> reads a status-narrowed `DetailApproval`. Details: the ledger entry.

**Achieves.** The owner's 2026-09-02 garbage list from the orphan report, deleted in one commit with no behaviour change, placed here because it edits `server/src` and D16's DoD needs that diff empty until D16 lands. Deleted, each with its selector: the `info` notice tone everywhere — the `Notice` union member (`model.ts:111`), the `info` rows of `format.ts`'s tone table and its copies, the info glyph arms (`apps.tsx:203-209`, `approvals.tsx:110`), any CSS that exists only for it (G40's info half; `warning` stays, it has a producer after step 8); `/apps`'s title-less danger branch (`apps.tsx:224`, G42); the Overview "Created —" arm (`app-detail.tsx:666`, `model.ts:1626`'s `null` writer, the type narrowed, G47); the unparseable-grant chip path and its inverted comment (`model.ts:1647-1657`, G48); the `confirm.client` dialog-title fallback (`settings.tsx:1001`, G58); `/approvals`' `pending` badge arm on history rows (`approvals.tsx:72`, G53); `/approvals/<id>`'s "Decided —" arm (`approval-detail.tsx:110`, G54); `LayoutProps.pendingApprovals?` made required (`layout.tsx:26`; `active` already is, `:22` — O34 was "not representable", nothing to delete, G56); `/audit`'s notice block, its class table and `AuditProps.notice` (`audit.tsx:54`, `:383-390`, G41); the fabricated "N backup codes remaining · generated <date>" line — both halves hard-coded (`model.ts:2161-2162`, `settings.tsx:492-496`, the `backupCodesRemaining` / `generatedAt` fields; G10 closes here, not in step 5, and if better-auth ever exposes a count it is a build with a §13 sentence); and every fixture value or preview entry that existed only to draw those (`longNames`' `backupCodesRemaining: 1`, the eight-code enabled arm at `fixtures.ts:534`). Kept on purpose, owner-accepted 2026-09-02 and recorded as such, not garbage: the service worker's push fallback copy (O40 / G57) and `/device`'s relative-time arms (O31 / G55).

**Depends on.** Step 1 (the `server/src` diff D16's DoD checks).

**Shape.** Inline fix, one `chore:` commit; no rows (deleting dead branches pins nothing); deploy rides step 4's.

**Definition of Done.**

- [ ] A grep list per deleted branch returns nothing: `tone: "info"` and `"info"` in the `Notice` union; `.info` on `NOTICE_CLASS` / `TONE_CLASS` / `ALERT_CLASS`; `NoticeIcon`'s info arm; `createdAt === null` in `app-detail.tsx`; `slice !== "approval"` in `grantChip`; `confirm.client`; `outcome("pending")`'s arm; `decidedAt ? … : "—"`; `pendingApprovals?:`; `AuditProps.notice` and `audit.tsx`'s `ALERT_CLASS`; `backupCodesRemaining`; `generatedAt` on `twoFactor`.
- [ ] `server/dev/fixtures.ts` and `preview.ts` hold no entry or value for a deleted state; the preview index still renders every remaining entry.
- [ ] `pnpm test` 45 / 1432 / 0 and `git diff --exit-code test-inventory.json` exits 0 — if a row pinned a deleted branch it is retired in the same commit with its key pair enumerated in the ledger line (expected: none; the one to check is web-pages row 27 at `web-pages.test.ts:1170`, which renders the enabled arm the deleted line sat on).
- [ ] `npx tsc --noEmit` 0 after the union and the props narrow.
- [ ] `git diff --stat` touches only `server/src/pages/*.tsx`, `server/src/pages/format.ts`, `server/src/pages/styles.css`, `server/src/pages/model.ts` (types and the dead writers), `server/dev/fixtures.ts`, `server/dev/preview.ts` — no route, loader logic, op or migration.
- [ ] `chore:` commit; one-line ledger entry naming the fourteen selectors above and the two owner-accepted keeps.

**What its detailed plan must settle.** Whether the tone-table copies in `settings.tsx` / `audit.tsx` / `approvals.tsx` are collapsed onto `format.ts` here (G35's half, one import each) or left for step 13; whether `SettingsConfirm.revoke-session`'s `client` field goes with its only reader; the `decidedAt` type for `rejected` / `used` rows.

## Step 3 — Owner sitting: decisions (3a) and the browser session (3b)

**Achieves.** One context load for every open question the record still carries — D15's seven (constraints 32 and 37), the §10 column, the unreviewed row, the audit's eight (closing-order step 6); the orphan calls are already made — so no later step inherits an unanswered spec sentence; then one browser visit that discharges D15's manual leg (G21), the five CSS-only shell behaviours nothing verifies (G25), and the two legs steps 5 and 7 create. Decisions precede spec-first dispatches by the grouping rule; the sitting also settles the register's one process defect (G26: an oracle row landed `passed` that the owner never reviewed, pinning behaviour the D15 plan twice told implementers not to infer — `d15-panes.md:532`, `:544`).

**Depends on.** 3a: nothing, runs beside step 1. 3b: steps 5 and 7 — the audit's own reason for placing its step 7 late: the passkey ceremony is what G16's name fix changes, so a session run before step 5 has to be run twice; the install prompt is what step 7 creates. This is the roadmap's one deviation from folding both audit steps into a single sitting.

**Shape.** Owner decision + owner action. The orchestrator prepares the sheet, the owner answers, the orchestrator lands `spec:` commits, the decision-log entries and the ledger amendment. No agent.

**3a — the question sheet.**

| # | Question | Answer lands in |
|---|---|---|
| 32(a) / G27 | `N args` vs `1 arg` — §13 writes `N args`; `design/AppDetail.dc.html` and the shipped pane say `1 arg` | §13 Tools bullet; the string edit rides step 8 |
| 32(b) | Does a never-connected tunneled app dim Tools too — §13's parenthetical reads two ways | §13; a row in the step that next touches app-detail |
| 32(c) / G27 | The literal `<hub>` vs the hub's origin in §20's scoped-endpoint sentence — the pane prints the literal | §13 / §20; step 8 |
| 32(d) | Does a failed proxied listing blank the Roles marker too | §13 shell rules |
| 37(a) / G27 | What an unreachable headers-mode upstream's Tools pane says — the pane invents a sentence §13 does not pin | §13 verbatim copy; step 8 |
| 37(b) / G13 | Where the header's Connect / Reconnect / Disconnect land — today `web.ts:547 dispatch(paths.apps)` → the notice renders on the app list; if the pane owns it, `dispatch` needs a per-request `back` and the two owner-reviewed rows the refused fix broke move with it | §13 redirect-back rule; step 8 (and G14's landing follows the same answer) |
| 37(c) / G27 | §20.6's Web bullet vs §13's Resources bullet on an approval line — the one spec-vs-spec conflict; the pane shows none | one of the two sentences; step 8 |
| §10 / G29 | `pmcp connections` prints six columns (`cli/src/main.ts:1663`) and omits `redirectOrigin` / the self-registered marker `connection_list` already returns; STATUS from `revokedAt` was answered minimally | `10-cli.md`; two headers + two fields ride step 8 if the CLI catches up |
| G26 | The `+1 passed` row "the Tokens rail marker narrows with `?kind=`": (i) which behaviour — count the unfiltered pane, or make the rail href carry `?kind=`; (ii) may an unreviewed oracle row stand — the strategy's rule (§9 rule 1), not this page's | (i) `spec:` + a `test:` commit retitling/retiring the row with its key pair enumerated; (ii) the standard gate's item 2 amended: a `+passed` key with no prior `todo` fails the gate unless the owner reviews it in that gate |
| G12 | The Tokens sentence names "an agent page" that has no route; §13:116-118 pins it while its prose says `pmcp token issue` | amend §13 and edit `settings.tsx:769` in step 8, or leave until step 9 |
| G8 | §19.5's zero-agents empty state sends the owner to `/apps`, which has no agent affordance (`consent.tsx:45-53`, `web-pages.test.ts:1385` asserts it; the concept board already draws "Create one under Agents") | amend `19-inbound-oauth.md:295-301`; interim copy naming `pmcp agent create` rides step 8; the `/agents` link lands in step 9 |
| G23 | Push bodies are draft-04 `aesgcm` + `Authorization: WebPush`, not §13:368's RFC 8291/8292 — Apple Web Push refuses every notification; `push.ts:16-27` records it, D10 never decided. Library swap, or accept and amend §13 | either way `push-service.ts:189` pins one HKDF label so `approvals.test.ts:1105` stops passing under both encodings (testing §3 requires it); swap → step 14 |
| G28 | Reserve `agents` now — decision 30:239 pins "`agents` does not join §2's reserved segments", and a username `agents` registered first shadows the route for good | reverse the sentence (decision log) → step 8 adds it; keep it → step 9 reserves it with the route |
| G39 | The D13.1 debt line (orchestration plan :1033, `/apps` capabilities column, still spelled "/services") — retire (§13:173-176 asks for no column; the app page's rail dimming answers the question) or pay with a §13 amendment | step 13 amends the line either way |
| G5, G6 | Severity calls the audit left open: G5 blocking (with scripting off the whole filter row submits nothing) vs visible; G6 blocking (no Chromium install prompt) vs visible — order-only, the fixes do not change | the ledger |
| 32(e) | Whether the active mobile pill carries `aria-current="page"` — scoping note; no answer needed unless the owner wants it pinned | — |

**3b — the browser session** (after steps 5 and 7; one visit, recorded as observed, never as expected):

- D15's leg: **Add passkey** on `/settings/passkeys`, sign out, sign in with it, "last used" moves (`stampPasskeyUse`) — and after step 5 the row shows the authenticator's name, not "Passkey" (G16). The ticked password change: the owner has changed the password since D15 gated — record what was observed (did `pmcp whoami` answer 401 while the browser stayed signed in?); if unticked or unwatched, re-run ticked or record "not observed".
- Step 5's leg: enable two-factor, see the QR and secret, type a wrong code and see the error arm, verify with a real authenticator, see the backup codes once (and not on the next render), Copy codes fills the clipboard, sign in once with a backup code.
- Step 7's leg: Chrome offers the install affordance on `/apps`; an installed tile shows the mark.
- G25: on the deployed `/settings` and `/apps/<slug>` at ≥ 900 px and at 390 px beside the boards — the pill row appears below the breakpoint, scrolls horizontally, highlights the active pill, the rail dims and colours as drawn, the Danger-zone entry is neutral. Five ticks, recorded.

**Definition of Done.**

- [ ] Every 3a row has a one-line answer in `spec:` commit(s) touching `13-web-surface.md`, `19-inbound-oauth.md`, `20-mcp-data-model-beyond-tools.md`, `10-cli.md` and/or `18-decision-log.md`; decision 30's "Scope, pinned" paragraph amended where an answer moves scope (G28, G2's go).
- [ ] Answers that create, change or retire rows are listed by title in the commit message; rows land in the step that implements them — except G26's, retitled or retired now in its own `test:` commit whose inventory diff shows exactly that key pair.
- [ ] The standard gate's item 2 amended in the orchestration plan with the unreviewed-row rule (G26 ii).
- [ ] G23's label pinned in `server/test/harness/push-service.ts:189` in a `test:` commit — the test goes red under the encoding §13 does not name, whichever way the decision went; if swap, step 14 is appended to this roadmap with its own detailed plan.
- [ ] 3b's observations — the passkey, the password change, the TOTP journey, the install affordance, the five CSS ticks — written into the D15 entry of the dated ledger with the date; anything not observed says so with a re-run scheduled.
- [ ] No implementation in 3a: `git status` shows only `docs/**`, and where rows moved, `server/test/**` + `test-inventory.json`.

## Step 4 — `/login` landing: G15 and G7 (inline fix, own deploy)

**Achieves.** Closes the register's only security defect. `login.tsx:241` embeds the landing into an inline `<script>` through `JSON.stringify` (rendered via `dangerouslySetInnerHTML` at `:109`), which escapes neither `<` nor `/`; `model.ts:2321` takes `?next=` unvalidated and `:2332-2335` appends the raw query verbatim; `login.tsx:291 location.assign(LANDING)` runs after a verified passkey assertion and bypasses `web.ts:872-880 landingOf`'s relative-only guard — reflected XSS plus an open redirect on the ungated auth origin, with no `Content-Security-Policy` anywhere in `server/`. Fix: run the landing through the guard that already exists (`landingOf`) inside `loginProps` before either consumer sees it; escape on embedding (`JSON.stringify(v).replace(/</g, "\\u003c")`); a CSP header as the second layer. G7 rides in the same three files: `login.tsx:51-53 switchMethod` rebuilds `/login?method=` alone, dropping the OAuth signed-authorize landing and any `?next=`, so the second-factor verify posts `callbackURL=/apps` — fix as `web.ts:818` already does, `loginUrl({ method, next: redirectTo })`.

**Depends on.** Step 2 (sequential `server/src` edits). First among the fixes because nothing depends on it and it is the one security item.

**Shape.** Inline fix with its own `fix:` commit and deploy — a security fix does not wait for step 5's gate; step 2's chore deploys with it. Rows first, as `it.todo` in a `test:` commit, titles shown to the owner with the commit proposal.

**Definition of Done.**

- [ ] The inline gate; inventory diff = exactly the new rows `todo → passed`, nothing else.
- [ ] Rows, each refusal beside its twin: `?next=%3C/script%3E%3Cimg…` — the rendered `/login` carries no `</script` and no raw `<` sourced from the value; `?next=https://evil.example` and `?next=//evil.example` — the embedded `LANDING` and the form's hidden `callbackURL` both fall back to `paths.apps`, while `?next=/settings/tokens` survives both consumers; the OAuth arm (`sig` + `client_id`, the existing `:1314` consent describe) still lands on the authorize URL; G7 — the two switch links carry the current landing on both arms.
- [ ] A `Content-Security-Policy` header on the shell, or a recorded decision not to: `grep -rn "Content-Security-Policy" server/src` is non-empty, or the ledger line says why not and what replaces it.
- [ ] Deploy + `pnpm smoke` 29/29 plus one leg: `GET /login?next=<payload>` body does not contain the payload's `<`.
- [ ] `fix:` commit; one-line ledger entry.

**What its detailed plan must settle.** Where the guard lives — `model.ts` must not import `web.ts`, so `landingOf` moves to model or a leaf; the escape set (`<` alone kills `</script>` and `<!--`; the audit names `/` too); the CSP shape — five inline scripts exist (`login.tsx`, `approvals.tsx`, `app-new.tsx`, `layout.tsx`'s `#copy-token` and the SW registration), so nonce-per-response or hashes, and whether that is this step or a follow-up; whether the OAuth arm's `rawSearch` embedding is bounded by the same guard (it is relative by construction but still embedded).

## Step 5 — `/settings` truth pass: G3, G4, G30, G9, G16, G31 (small dispatch)

**Achieves.** The two remaining blocking gaps and everything behind the same door, from one root cause (audit note 1): `web.ts:838-870 credential()` reads only `answered.ok` and discards better-auth's response body, so `model.ts:2164 enrollment: null` and `:2165 revealedBackupCodes: null` can never be populated — the TOTP setup card (`settings.tsx:413-453`) and `BackupCodesCard` (`:546-570`) are unreachable, Enable redraws the not-enrolled arm under a success notice (G3), Regenerate rotates the owner's codes out of reach (G4), and `/login`'s backup-code card is unusable. Built here, per the owner's meaningful list: the enrolment card **and its error arm** (O4 — nothing today writes `enrollment.error`; a bad code lands on `/login?step=totp&error=…`, a query `settingsProps` never reads), the backup-codes reveal **with a working Copy codes** (G30: the card's six digit boxes have no hidden `code`, no OTP-stitching script, no `callbackURL`, and post to `/login`'s route; Copy codes is inert — reuse `login.tsx`'s input + script and `layout.tsx`'s `#copy-token` handler), the authenticator-supplied passkey name (G16: the ceremony sends no `name` and `identity.ts:130` sets no `registration.afterVerification`, so every passkey renders as "Passkey" against §13:100-103 — add `aaguid` to the row type at `model.ts:2212` and render `pk.name || getAuthenticatorName(pk.aaguid) || "Passkey"`, both exported by the plugin), the CLI session label via a `source` field (G9: `model.ts:2290 source: "web"` hardcoded — better-auth `session.additionalFields.source`, stamped `"cli"` on the device-flow sign-in, read by `sessionRow`; §13:105-107's "pmcp CLI · device flow" becomes assertable), and G31's dangling comment deleted with G3. G10's fabricated line is gone since step 2. §13 pins every string, so no board review gates it.

**Depends on.** Step 4 (`login.tsx` is the OTP script's source). Its `identity.ts` / `model.ts` / `settings.tsx` edits collide with no other step.

**Shape.** Small dispatch: rows (owner-reviewed, own commit) → implementation → standard gate. The rows must repair the audit's second note: `plantPasskey` (`web-pages.test.ts:6229-6250`) INSERTs a name straight into D1, so the row titled "under the name the authenticator reported" is green on data the ceremony never produces — it is retired-and-replaced by a row whose fixture plants `aaguid` with a null name.

**Definition of Done.**

- [ ] The standard gate; inventory diff = the new rows `todo → passed` plus the enumerated retirement of the `plantPasskey`-based name row.
- [ ] Rows: Enable renders the enrolment card in place (totpURI, grouped secret, six boxes stitched into one `code`, `callbackURL` back to the pane) at 200 — a secret never rides a URL (§15; D15 constraint 5's precedent); a wrong verify code re-renders the card with `enrollment.error` and `aria-invalid` on the boxes, and a right one reaches the enabled arm (the twin); Regenerate reveals the codes exactly once — the next render shows none (the twin); the reveal carries the Copy-codes control and its script names the eight codes (the copy itself is 3b's); a device-flow session renders "pmcp CLI · device flow" beside a browser session that does not (G9); the passkey name row above; the refuted-claim residue (audit note 8): a stale cookie at the plugin's two passkey register endpoints is refused, pinned against a future `requireSession: false`.
- [ ] `credential()` returns the parsed body and stays the only translation wrapper (D15 ledger entry 9's PSD concern) — read off the diff by the PSD stage; no `skipVerificationOnEnable`.
- [ ] A migration adds `session.source` (`server/migrations/`), walked by `migrations.test.ts`'s forward test; `pmcp whoami` and every auth-matrix row unchanged.
- [ ] States preview: every settings fixture has a producer — `totpEnrolling`, `totpEnrollError`, `backupCodesRevealed` (`fixtures.ts:527-537`), the CLI session (`:230`), the authenticator-named passkeys (`:200-213`); the orphan report's settings fixture notes applied; walked in the Browser pane (D15 constraint 13).
- [ ] Deploy + `pnpm smoke`: `GET /settings/two-factor` 200 with the not-enrolled arm; the enrolment itself is 3b's leg.
- [ ] Ledger row.

**What its detailed plan must settle.** How the body rides from `credential()` to the one render (in-place 200 like Issue token, or a one-shot server-side stash — never the URL; the flash protocol `NOTICE_KEYS` at `model.ts:614-622` cannot carry it); how the wrong-code refusal returns to the pane rather than `/login` (the verify target and its `callbackURL`); the `source` column's default and stamping site (the device plugin mints with `internalAdapter.createSession` and no request context — the after-hook seam); `getAuthenticatorName`'s import path from `@better-auth/passkey` (`index.mjs:764`); the row titles for the two journeys.

## Step 6 — `/audit` chrome: G5, G11, G50, G51 (inline fix)

**Achieves.** The dead controls on an owner-reviewed page whose filter §13 already pins. `audit.tsx:408`'s `#audit-filters` GET form closes at `:477-480` with no submit control; the four selects submit via `onchange` while the tool box (`:428`) has nothing, and implicit Enter is blocked by the second text field (`:423`) — with scripting off the whole row submits nothing (G5, blocking). The date-range input (`:420-424`) is nameless and readonly although `model.ts:1992-1993` already parses `since`/`until` and `:2019-2023` has a `range: "custom"` window; the Time header's sort glyph (`:570-574`) has no anchor and §13:141 pins no sort (G11). Fix: one submit button; two native `<input type="date" name="since|until">`; delete the glyph. Two builds are tied to the input, per the owner: the custom range becomes reachable through it (G51 — the segmented control with no `aria-current` and the "vs previous period" tiles become real states, with a fixture that has a producer), and "No events in this window." (`audit.tsx:523`) is drawn for an empty window — today `auditHistogram` (`model.ts:2072-2090`) returns 24 zero buckets on every path, so one early return (G50).

**Depends on.** Step 2; placed before step 10 so `audit.tsx` sees one more pass, not two.

**Shape.** Inline fix; commits itself; deploys with step 8.

**Definition of Done.**

- [ ] The inline gate; inventory diff = the new rows only.
- [ ] Rows: the filter form renders a submit control and a form-encoded GET with `tool=` filters the listing (the paging describe at `web-pages.test.ts:901` is the neighbour); the range inputs are named `since` / `until` and a submitted pair reaches the loader and renders the custom-range state; an empty window renders the empty-histogram copy and a non-empty one the bars (the twin); `IconSort` no longer rendered (grep).
- [ ] The `custom`-range and `empty` fixtures correspond to producers in the states preview; the orphan report's audit fixture notes applied.
- [ ] `fix:` commit; ledger line; deploy rides step 8.

**What its detailed plan must settle.** The button's placement and label (visible Apply vs visually hidden beside the tool box); whether the `onchange` selects stay; the boards draw a picker — native date inputs deviate, reconciled in step 12; the empty-window rule (`total === 0` vs all-zero buckets).

## Step 7 — PWA icons: G6 (inline fix)

**Achieves.** §13's "installs to phone and desktop home screens" is unmet: `web.ts:650-666` serves the manifest with `icons: []` (`:662`), `layout.tsx:228-242` emits no icon link, `paths` (`model.ts:230-236`) has no icon route, and Chromium offers no install prompt — while the mark already exists as inline SVG (`layout.tsx:47-54`). Parked as a D9→D10 escalation (orchestration plan `:825-827`) and never discharged. Fix: serve the SVG at one path beside the stylesheet, list it in `icons` (plus a 180 px PNG or a `maskable` entry for iOS), add `<link rel="icon">` / `apple-touch-icon`.

**Depends on.** Step 2; touches files no other step edits.

**Shape.** Inline fix; deploys with step 8.

**Definition of Done.**

- [ ] The inline gate; rows: `GET /manifest.webmanifest` lists ≥ 1 icon and each `src` answers 200 with an image content-type through `worker.fetch`; the shell head links an icon whose href is a `paths` value.
- [ ] The install affordance observed in 3b.
- [ ] `fix:` commit; ledger line.

**What its detailed plan must settle.** SVG with `sizes="any"` vs the 192/512 px PNGs Chromium's installability check wants (verify against current docs); if PNG, a base64 constant served from a route vs an `assets` binding in `wrangler.jsonc`; `purpose: "maskable"`; cache headers on the icon route (the stylesheet's precedent).

## Step 8 — One-liners: G17, G18, G14, G36, G28, G52, and 3a's string edits (inline fix)

**Achieves.** Independent small fixes in files no other step touches, batched because scheduling costs more than doing: G17 `app-new.tsx:198 querySelector` → `querySelectorAll` + `forEach` like its siblings at `:186`, `:192` (the narrow-width submit label never updates); G18 `approvals.tsx:249-254` — check `res.ok` before `markEnabled` and replace the empty `catch` with a label or notice (denied permission and a rejected store both read as success today); G14 `upstream.ts:734`'s hardcoded `/apps` → `noticeUrl(paths.apps, "connect", …)`, or the originating pane through `state` if 37(b) said the pane owns the notice; G36 `paths.auth`'s four WebAuthn literals templated off `AUTH_BASE_PATH`, the two-vs-four comment fixed; G28's reservation half if 3a reversed decision 30:239 — `agents` into `index.ts:116-131 ROUTES` so `RESERVED_ROUTES` derives it (a hand-kept extra would break §2's derivation rule, so it is a stub route or nothing); **G52, built** — the failed-decision notice "That request is no longer pending" with its expiry line, the one real use of the `warning` tone: today a decide that loses the race throws `notPermitted` and lands through `dispatch` as a danger "failed" notice, so `noticeOf` (`web.ts:1063-1077`) gains a warning arm for that op + reason and `approvals.tsx`'s warning glyph gets its producer (placed here rather than step 6 because `approvals.tsx` is already open for G18). Plus the string edits 3a produced: G27's four in `app-detail.tsx`, G8's interim consent copy (+ `web-pages.test.ts:1385` re-pointed), G12's Tokens sentence, G29's two CLI columns.

**Depends on.** 3a, step 2.

**Shape.** Inline fix; one commit per gap id (cheap, bisects); one deploy + `pnpm smoke` for steps 6–8.

**Definition of Done.**

- [ ] The inline gate; inventory diff = the rows this step can write plus enumerated re-points: G14's success arm — the callback's `Location` is built by `noticeUrl` and carries `done=connect` (beside the callback matrix in `upstream-credentials.test.ts`); G36 — every `paths.auth` passkey endpoint starts with `AUTH_BASE_PATH`; G28 — `routes.test.ts`'s walk passes with the new segment; G52 — a decide posted for an id no longer pending answers 303 and `/approvals` renders the warning-tone notice with "no longer pending", while a decide on a live request answers `done=` (the twin), and the `decideFailed` fixture now has a producer; G8 — `:1385` re-pointed with its title kept or its key pair enumerated. G17 and G18 are client scripts: no row (§7); observed in 3b if the owner wants.
- [ ] `pnpm smoke` green after the batch deploy.
- [ ] Commits and ledger lines per gap id.

**What its detailed plan must settle.** G18's failure copy (two sentences: permission denied vs store failed) and whether the button renders at all when `VAPID_PUBLIC_KEY` is unset (`model.ts:1888`); G14's `state` carriage if the pane wins; the stub-route shape for G28; how G52's redirect distinguishes the lost race from other `approval_decide` refusals (a reason code on the `failed=` query, not prose matching).

## Step 9 — `/agents`: G2, G28's nav half, closing G8 and G12 (spec-first dispatch)

**Achieves.** The whole page family decision 30 deferred: the `/agents` list, `/agents/<slug>` detail with the (agent × app) grant editor, the fifth nav slot (`layout.tsx:39-44` holds four; 390 px cannot hold five — scroller or overflow, §13:358-360), §19.5's read-only clients row on the agent page (`19-inbound-oauth.md:403`), and the four dangling pointers become links (`consent.tsx:45-53`, `settings.tsx:769` / `:818`, `app-detail.tsx:708`). Agents exist as first-class objects everywhere in the model and can be created, listed and granted only through the admin MCP or `pmcp`; the visible harm rides G8 and G12.

**Depends on.** 3a (the go; G28's reservation answer), 5 and 8 (sequential edits to `settings.tsx`, `consent.tsx`, `app-detail.tsx`).

**Shape.** Spec-first: (i) the concept boards `design/concepts/Agents`, `AgentDetail`, `GrantEditorStates` redrawn as contract and moved onto the main canvas, plus their mobile variants; §13 gains both pages' sections with pinned strings and the editor's semantics (Save replaces the pair's whole set; undeclared-role warn for tunneled, error for proxied; the built-in `all`); §2's reserved segments amended; decision 30's scope paragraph amended — one `spec:` commit the owner signs off. (ii) A D15-shaped dispatch: oracle workflow (areas × two lenses, completeness critic) → rows in their own commit, owner-reviewed → implementation → standard gate. Models as D15: Opus 5 for shell, routes, seams and every verify stage; Sonnet 5 for pane markup, CSS and fixtures.

**Definition of Done.**

- [ ] The `spec:` commit with the owner's sign-off recorded; the three boards leave `design/concepts/` for the main canvas and `design/README.md`'s tables move with them.
- [ ] Rows in their own commit; the standard gate; inventory diff = those rows plus the enumerated re-points of the four pointer rows.
- [ ] Reads through the admin ops only (`agent_list`, `token_list?kind=agent`, `connection_list`, `grant_set`) — parity direction B holds: every form's fields are the op's zod keys; no second read path.
- [ ] `NAV` has five entries; the mobile nav's overflow is CSS — observed by the owner on the deployed page, recorded.
- [ ] Every state the boards draw is a preview fixture with a producer (D15 constraint 13); `PagePropsByName` enumerates both pages.
- [ ] Deploy + `pnpm smoke` with two new legs: `GET /agents` 200 listing the smoke agent; `GET /agents/<smoke agent>` 200 with its grants.
- [ ] Ledger row; `app-detail.tsx:708`'s "deferred" comment and consent's `pmcp agent create` interim copy are gone.

**What its detailed plan must settle.** The editor's exact surface (per-app cards, role chips, mode toggles) and its POST shape; whether an agent gets a Danger zone (`agent_delete`) and a Token pane (`token_issue` for agents, which §13:116-118 currently routes to `pmcp`); the overflow mechanism; the `agents` reservation if not done in step 8; the smoke agent (`scripts/smoke.ts`'s `OAUTH_AGENT` reused); the ownership groups and the row count.

## Step 10 — `/audit` expanded row: G1, G24, G49 (spec-first dispatch)

**Achieves.** The owner's own finding: an expandable row draws a `Chevron` at both widths (`audit.tsx:333-349`) inside a `<tr>` with no anchor, form or script, and `AuditLinkQuery` / `paths.auditWith` (`model.ts:243-246`) cannot spell `expand`, so the shipped expanded state is reachable only by hand-editing the URL (G1). Once open, a row from an app with body logging off shows a bare "Client: …" with no explanation — `AuditEventRow` carries no `log_bodies` signal (G24) — and a row with neither client metadata nor bodies draws an empty panel (O27). The body-stub placeholders (`‹blob image/png · 4.2 MB›`, `‹oversize …›`, `audit.tsx:117-129`) are pinned by §13 and stored by `audit.ts:248-256`, but the loader never emits a stub onto `AuditEventRow` and the page renders them only through the same `?expand=` chain — built here: the loader carries stubs through, the `bodyStubs` fixture and test 14's page half become honest (G49). Both sit inside decision 30's deferral of the expanded-row states, so the §13 paragraph (`13-web-surface.md:162-166`) and the concept board (`design/concepts/AuditDetailStates`, whose lazy-fetch LOADING panel the spec never adopted — audit note 10; the synchronous render is the pinned pattern) are reviewed first. Fix: `expand` joins the link query; the chevron becomes `<a href={auditWith({...filters, expand: isOpen ? undefined : row.id})}>` so the open row's chevron closes it; the row gets an `id` anchor; one bodies-off sentence and one nothing-recorded sentence.

**Depends on.** Step 6 (`audit.tsx` quiet).

**Shape.** Spec-first; the implementation is small enough that the detailed plan may run it inline after the rows are reviewed — the "dispatch" is the two owner reviews.

**Definition of Done.**

- [ ] The `spec:` commit: §13's expanded-row paragraph names the control, the bodies-off sentence and the empty-panel sentence; the board adopted onto the main canvas without its LOADING panel.
- [ ] Rows: every expandable row carries an expand link that round-trips the current filters and toggles; `?expand=<id>` renders the open row with its close link; the bodies-off sentence renders for a `log_bodies=false` app's row and not for one with bodies (the twin); a stored `oversize` and a stored `blob` stub reach the row through the loader and render as typed placeholders, never bytes; a non-expandable row carries no link.
- [ ] The standard (or inline) gate; fixtures for the expanded states (bodies, bodies-off, stubs, non-call event, neither) each with a producer; deploy + smoke.

**What its detailed plan must settle.** The two sentences' copy; whether `expand` survives paging links; the anchor `id` scheme; where the loader drops stubs today; inline vs workflow.

## Step 11 — Proxied add-app states: G43, G44, G45, G46 (spec-first dispatch)

**Achieves.** Decision 30's fourth deferral, all four built per the owner. `web.ts:1246-1251 createErrors` keys a refusal to a field by whether the message contains the literal `"name"` / `"slug"` / `"endpoint"`, so the only endpoint refusal (`registry.ts:897 RegistryRefusal("upstreamUrl", …)`) lands in `errors.form` and the name/endpoint field errors (`app-new.tsx:94-95`, `:127-129`) never render (G43); there is no URL-format check at all — `registry.createApp` (`:889-935`) tests only `!draft.upstreamUrl`, so `not-a-url` is accepted and dialed later (G44 — a validation gap at the owner's own trust boundary; §13:181 already names probing the entered URL as future work); `createErrors` returns on the first match, so the `appNew.errors` fixture's simultaneous errors are impossible — built as collected violations (G45); the "Connecting to <provider>… Finish signing in, in the tab that just opened" interstitial has no type — `AppNewStep` (`model.ts:1013-1015`) has two members and a proxy+oauth create 303s straight to the provider (`web.ts:514-516`, `:1169`) — built as a third step (G46). Spec-first: §13's add-app sentence (`13-web-surface.md:175-182`) gains the states, `design/concepts/AppNewProxiedStates` is adopted onto the main canvas, §8's `app_create` refusal shape gains the field.

**Depends on.** Step 8 (`app-new.tsx`'s G17 edit).

**Shape.** Spec-first dispatch; small enough that the implementation may run inline after the rows are reviewed.

**Definition of Done.**

- [ ] The `spec:` commit: §13's add-app states pinned (the field errors' sentences, the interstitial's copy, the URL rule — `https` only, or `http` for loopback, the owner's call); `AppNewProxiedStates` adopted; decision 30's paragraph amended.
- [ ] Rows: a refusal carries its field (`RegistryRefusal`'s first argument, not a substring of the message) and renders under that control with `aria-invalid`, beside the twin that a well-formed create succeeds; a non-URL and a non-`https` endpoint are refused at `app_create` (admin suite) and on the page; a submission with two violations renders both field errors at once (the twin: one violation renders one); the interstitial renders at 200 for a proxy+oauth create with the provider's name and the link the browser opens; every `appNew` fixture has a producer.
- [ ] The states preview walked; the orphan report's `/apps/new` fixture notes applied.
- [ ] The standard (or inline) gate; deploy + smoke.

**What its detailed plan must settle.** How violations are collected without changing §8's single-refusal wire shape for `pmcp` (a page-side pre-check over the same rules, or a refusal that carries a list); the interstitial's mechanism (a 200 page with a link vs a `meta refresh`, and what it says when the tab is blocked); the URL rule's exact grammar and where it lives (`registry.createApp`, one place); the field-carrying refusal's shape across admin and the page.

## Step 12 — Design pass: G20, G19, G32, G33, G34, page 2's re-layout (small dispatch)

**Achieves.** The adopted boards and design docs catch up with §13 and the tree. Concepts are already out of the way (status block): `ReauthGate`, `AuditDetailStates`, `OauthConsentStates` and the rest sit in `design/concepts/` as non-normative exploration, so O26/O27/O32/O33 need nothing here. What remains on the main canvas: `AppDetailPanes:143/:156` Edit grants and `SettingsTokens:108/119/130/141` agent slugs as links (both dead by §13:287-289 / §13:114-116 — or live, if step 9 landed first), `MobileSettings:86` dropping §13:55-59's footer clause and the checkbox hint, `Settings.dc.html:26-30`'s five-item nav reconciled to whatever `NAV` holds after step 9 (G20); `Apps.dc.html:62/76/90/106` row names as text where `apps.tsx:112-115` links them (G19); two fixture comments in `server/dev/fixtures.ts` crediting boards that do not draw the state, Dialogs drawing 3 of 9 confirm dialogs, no `MobileAppDetail` (G32); README's "every other pane" mis-partition, `flows/04`'s stale Gap note, `flows/05` naming `/oauth/connections` with no wireframe map, README:62's "lazily fetched" (G33); a README line saying `./support.js` is supplied by the published canvas (G34); page 2 "Adopted 2026-09-02 (re-layout pending)" re-laid out into the canvas proper, with the full-shell `SettingsTokens` / `OauthConnections` duplication (decision 30:244-246) resolved in the same pass; O34 recorded — `/apps/new` and `/approvals/<id>` are chromeless by design and lose the badge and Sign out; G25's optional viewport control on the states preview.

**Depends on.** Steps 9, 10 and 11 (they adopt boards; G20's nav reconciliation depends on whether `/agents` landed).

**Shape.** Small dispatch over `design/**` and `server/dev/**` only (the `design` skill's canvases; Sonnet-grade). No rows: design files carry no tests.

**Definition of Done.**

- [ ] Every listed board edit made and viewable in the canvas; page 2 no longer says "re-layout pending"; the owner eyeballs the redrawn boards (judged) and the ledger line says which.
- [ ] `design/README.md` states which width is contract for each pane, corrects the four statements, carries the `support.js` line and records the two chromeless pages; the two fixture comments cite the right boards.
- [ ] `git diff --exit-code test-inventory.json` exits 0; `npx tsc --noEmit` 0; `git status` touches only `design/**` and `server/dev/**`.
- [ ] `design:` commit; ledger line.

**What its detailed plan must settle.** Whether Dialogs gets the other six; whether `MobileAppDetail` is drawn now (with step 9's mobile boards) or dropped by the owner; the preview viewport control (a small `server/dev/preview.ts` addition, or not).

## Step 13 — Hygiene: G35, G22, G37, G38, G39 (small dispatch)

**Achieves.** Code and record hygiene, last because nothing waits on it. G35: `format.ts`'s exported notice-tone class table duplicated verbatim in `settings.tsx`, `audit.tsx`, `approvals.tsx` → three imports (two if step 2 already collapsed them; the table keeps `success` / `danger` / `warning` since G52 gave `warning` its producer); `familyMarker` in `model.ts:1709` and `fixtures.ts:946` → export once; `cli/src/plan.ts`'s unexported `DEFAULT_CAPABILITIES` twins `server/src/capabilities.ts`'s exported `DEFAULT_APP_CAPABILITIES` → export it and add one contracts drift case beside `plan.ts:816-823`. G22: `model.ts:1927 AUDIT_SCAN_ROWS = 1000` bounds the tiles and histogram while `paging.total` is exact → label them "newest 1000" when the total exceeds the constant (the recorded `audit_stats` op stays a future dispatch); record that the same constant caps the filter selects' option scan (`:1970`, `:1975`). G37: the D15 ledger's "three reaches" is five (`app-new.tsx`, `harness/seed.ts`). G38 (audit note 5, the sharpest record failure): the D11 candidate finding at plan `:924` was false when written — `audit.prune` and its cron leg landed in `d036455` the day before — and decision 30's "nothing in this entry is implemented" has been false since D15 gated; both amended in place. G39 per 3a: the D13.1 line at `:1033` retired or paid, "/services" fixed either way.

**Depends on.** 3a (G39). Touches files no earlier step revisits.

**Shape.** Small dispatch.

**Definition of Done.**

- [ ] The standard gate; inventory diff = +2 rows `todo → passed` (the contracts drift case; the scan-ceiling label with its below-ceiling twin), nothing else.
- [ ] Each rule defined once, by grep: the tone-table literal appears only in `format.ts`; `familyMarker` has one definition; `DEFAULT_CAPABILITIES` is exported from `plan.ts` and equal to the server constant in the contracts case.
- [ ] The four record amendments in place (`2026-08-25-implementation-orchestration.md` ×3, `18-decision-log.md` ×1), each following the log's own convention of amending in place with the date.
- [ ] Commit; ledger row — which also records the process lesson: a ledger claim about the tree is checked against the tree before it is written.

**What its detailed plan must settle.** The label's copy; seeding > 1000 audit rows in-process for the twin (cheap in D1) vs shrinking the constant for the test (it is a named constant, so the strategy allows either); whether the gate script gains a check for G38's failure class.

## D15 leftovers placed

| Leftover | Source | Rides |
|---|---|---|
| The manual leg (passkey; ticked password change) — G21 | D15 exit criteria; ledger "NOT discharged" | step 3b (after 5 and 7) |
| The seven owner questions 32(a–d), 37(a–c) — G27, G13 | D15 constraints 32, 37 | step 3a; string edits in step 8 |
| The §10 CLI column — G29 | D15 open question 3; ledger debt | step 3a; CLI edit in step 8 |
| The unreviewed +1 row — G26 | D15 ledger | step 3a (behaviour + the gate rule) |
| Mobile top nav has no `Agents` slot — G28 nav half | §13:358-360; README:88-89 | step 9 |
| The Sessions pane cannot label a CLI session — G9 | D15 ledger debt; out-of-process ledger entries 10 and 32 | step 5 |
| `familyMarker` spelled twice — G35 | D15 ledger debt | step 13 |
| `/apps/<slug>` has no mobile board — G32 | README:43-45; decision 30 | step 12 (drawn with step 9's mobile boards, or dropped by the owner) |
| The full-shell `SettingsTokens` / `OauthConnections` boards duplicate the `…Panes` boards — decision 30:244-246 | now on canvas page 2 "Adopted 2026-09-02 (re-layout pending)", uncommitted | the move rides step 1's ledger-row commit; the re-layout is step 12 |
| The exploration boards (`Agents`, `AgentDetail`, `GrantEditorStates`, `AuditDetailStates`, `AppNewProxiedStates`, `ReauthGate`, `OauthConsentStates`) | README:60-65 | moved to `design/concepts/` 2026-09-02 (done, uncommitted, rides step 1's ledger-row commit); steps 9, 10 and 11 adopt theirs from there |
| D14's carried debts (the `alarm:deadline` hibernation tier without a row; two §21 cosmetic nits; `contracts.test.ts`'s unclaimed +521/−50) | D14 ledger entry | outside the audit's register (web surface only); remain the D14 entry's, claimed by no step here |

## Appendix — the gap register

From the audit's synthesis (2026-09-02):

| id | sev | size | area | gap, one line | recorded in |
|---|---|---|---|---|---|
| G1 | visible | small | /audit expand | chevron drawn, nothing sets `?expand=`; `auditWith` cannot spell it | decision 30 (states only) |
| G2 | recorded | dispatch | /agents | no list, no detail, no grant editor; four dangling pointers | decision 30; §13:358-360 |
| G3 | blocking | dispatch | /settings/two-factor | TOTP setup card never renders — `credential()` discards the body | stale cause only (orch :862-863) |
| G4 | blocking | dispatch | /settings/two-factor | backup codes never revealed; Regenerate rotates them out of reach | unrecorded |
| G5 | blocking | one-line | /audit filters | the GET form has no submit control | unrecorded |
| G6 | blocking | small | PWA manifest | `icons: []`, no icon link — no install prompt | orch :825-827, undischarged |
| G7 | visible | small | /login switch links | `?method=` rebuild drops the landing | unrecorded |
| G8 | visible | small | /oauth/consent | zero-agents state sends the owner to /apps, which has no agent affordance | README:67-69 (as future amendment) |
| G9 | visible | small | /settings/sessions | `source: "web"` hardcoded; "pmcp CLI · device flow" unreachable | model.ts; D15 ledger 10; orch :1208 |
| G10 | visible | small | /settings/two-factor | "0 backup codes remaining · generated today" fabricated — deleted in step 2 | model.ts comment; orch :827 |
| G11 | visible | small | /audit | nameless readonly date field; sort glyph with nothing behind it | unrecorded |
| G12 | visible | one-line | /settings/tokens | copy names an agent page that has no route | §13:116-118 (spec side only) |
| G13 | recorded | small | /apps/<slug> header | Connect/Disconnect notices land on /apps — owner question 37(b) | D15 c.37(b); ledger 25; D15 row |
| G14 | visible | one-line | upstream callback | success redirects to a hardcoded `/apps` with no notice | unrecorded |
| G15 | blocking | small | /login script | reflected XSS + open redirect via `?next=`; no CSP | unrecorded |
| G16 | visible | small | /settings/passkeys | every passkey named "Passkey" — no `name`, no `aaguid` lookup | unrecorded (§13:100-103 pinned) |
| G17 | visible | one-line | /apps/new | narrow submit label never updates (`querySelector`) | unrecorded |
| G18 | visible | small | /approvals push | rejections swallowed; `res.ok` unchecked | unrecorded |
| G19 | hygiene | one-line | Apps board | row names drawn as text, shipped as links | unrecorded |
| G20 | visible | small | adopted boards | draw Edit grants, agent links, a five-item nav; drop two sentences (DENIED is now a concept) | partly (decision 30:244-246; c.32(f)) |
| G21 | recorded | small | D15 manual gate | passkey + ticked password change never observed | D15 plan :5-8; orch :1198-1201 |
| G22 | recorded | small | /audit tiles | tiles/histogram over newest 1000 rows beside an exact total | model.ts:24-32; orch :827 |
| G23 | recorded | dispatch | Web Push | draft-04 `aesgcm` + `WebPush` auth, not RFC 8291/8292; Apple refuses | push.ts:16-27; orch :816-819 |
| G24 | recorded | small | /audit expanded row | bodies-off row shows a bare "Client: …" | decision 30 (states) |
| G25 | recorded | small | shell CSS | five D15 behaviours checked by nobody | D15 ledger head + 4, 14, 23, 35 |
| G26 | recorded | one-line | /settings/tokens marker | unreviewed row pins the filtered count the plan said not to infer | orch :1182-1184 vs D15 :532, :544 |
| G27 | recorded | small | /apps/<slug> copy | four owner questions answered unilaterally by the panes | D15 c.32/37; ledger entries |
| G28 | recorded | one-line | routing / nav | no fifth nav slot; `agents` unreserved — a username can squat it | nav ×4; reservation: decision 30:239 (choice only) |
| G29 | recorded | one-line | `pmcp connections` | omits `redirectOrigin` and the self-registered marker | D15 :586-587; orch :1211-1212 |
| G30 | hygiene | small | /settings/two-factor | the unreachable cards' wiring is broken (no `code`, no script, inert Copy) | unrecorded |
| G31 | hygiene | one-line | model.ts | `totpVerify` comment points at a note that does not exist | unrecorded |
| G32 | hygiene | one-line | boards / fixtures | Dialogs draws 3 of 9; no MobileAppDetail; two fixture mis-citations | partly (D15 :359; README:43-45) |
| G33 | hygiene | small | design docs | README mis-partition; flows/04, flows/05 stale; "lazily fetched" | partly (decision 30:244-246) |
| G34 | hygiene | one-line | design/*.dc.html | all 39 load a `./support.js` that never existed | unrecorded |
| G35 | hygiene | small | shared rules | tone table ×4, `familyMarker` ×2, CLI capabilities twin | partly (orch :1211; :1031-1032) |
| G36 | hygiene | one-line | `paths.auth` | four WebAuthn literals not composed from `base`; stale two-vs-four comment | unrecorded |
| G37 | hygiene | one-line | D15 ownership | two touched files outside every group; ledger says "clean" | unrecorded, contradicted by the ledger |
| G38 | hygiene | one-line | the record | D11 :924 false when written; decision 30's "nothing implemented" false since D15 | the records themselves |
| G39 | hygiene | one-line | /apps list | D13.1 capabilities-column debt: retire or pay; "/services" spelling | orch :1033 |

From the orphan-states report (`2026-09-02-orphan-states.md`) — one row per distinct fact; O3–O8 restate G3/G4/G10/G30/G16/G9, and O20/O21/O26/O27/O32/O33 are the board-only states now under `design/concepts/` (O20/O21's main-canvas twins stay under G20). The disposition column is the **owner's, 2026-09-02**: concept (moved, done) / delete (step 2) / build (the step) / keep (owner-accepted):

| id | sev | size | area | gap, one line (orphan ids) | disposition → step |
|---|---|---|---|---|---|
| G40 | hygiene | small | every notice | tones `info` and `warning` have no producer — `noticeOf` emits success/danger only (O1 O2 O10 O11 O19 O36 O37) | `info` delete → 2; `warning` build via G52 → 8 |
| G41 | hygiene | one-line | /audit notice | the notice block never receives one — no `noticeUrl` targets `paths.audit`, no POST exists (O25 O38) | delete → 2 |
| G42 | hygiene | one-line | /apps notice | title-less danger arm — `noticeOf` always sets a title (O12) | delete → 2 |
| G43 | visible | small | /apps/new | field errors keyed by message substring; no refusal ever lands on Name or Endpoint (O13 O14) | build, spec-first → 11 |
| G44 | visible | small | /apps/new | no endpoint URL-format check — `createApp` tests only presence; §13:181 names the probe as future work (O14) | build, spec-first → 11 |
| G45 | visible | small | /apps/new | multi-error state impossible — `createErrors` returns on the first match (O15) | build, spec-first → 11 |
| G46 | visible | small | /apps/new | the "Connecting…" interstitial has no type, prop or template — `AppNewStep` has two members (O16) | build, spec-first → 11 |
| G47 | hygiene | one-line | /apps/<slug> Overview | "Created —" arm — the builtin never reaches this page (O17) | delete → 2 |
| G48 | hygiene | one-line | /apps/<slug> Access | unparseable-grant chip path — admin emits two spellings only; the comment says the opposite (O18) | delete → 2 |
| G49 | visible | small | /audit expanded row | §13-pinned stub placeholders; the loader never emits a stub and the page renders them only via `?expand=` (O22) | build, spec-first → 10 |
| G50 | visible | one-line | /audit histogram | "No events in this window." never drawn — 24 zero buckets on every path (O23) | build → 6 |
| G51 | visible | one-line | /audit range | `custom` range unreachable — every link carries a preset span; no fixture (O24) | build with G11 → 6 |
| G52 | visible | small | /approvals | the failed-decision notice "That request is no longer pending" — the lost race lands as a danger "failed" via `dispatch` (O28) | build; keeps `warning` → 8 |
| G53 | hygiene | one-line | /approvals | history row badged `pending` — history is filtered to non-pending (O29) | delete → 2 |
| G54 | hygiene | one-line | /approvals/<id> | "Decided —" — both writers stamp `decided_at` (O30) | delete → 2 |
| G55 | hygiene | one-line | /device | relative-time arms — `requestedAt` is `ctx.now`, always "Just now" (O31) | keep — owner-accepted 2026-09-02 |
| G56 | hygiene | one-line | shell | `pendingApprovals?` optional with five required callers (O35); two chromeless pages lose badge + Sign out by design (O34) | required → 2; O34 record → 12 |
| G57 | hygiene | one-line | service worker | five push fallbacks with one producer that always sends every field (O40) | keep — owner-accepted 2026-09-02 |
| G58 | hygiene | one-line | /settings/sessions dialog | `confirm.client` fallback title — the confirm is built from the same array it searches (O9 O39) | delete → 2 |

Refuted by the audit (not gaps): `/apps/new`'s proxied branch with scripting off is reachable; passkey enrolment has a recent-auth gate (residue: no stale-cookie row — step 5); the recent-auth refusal is served (`identity.ts:658`); `AuditDetailStates`' LOADING panel is unadopted exploration (residue in G33); the Access pane's grants footer is pinned verbatim (residue: a stale comment at `app-detail.tsx:709-713`); the upstream callback's `text/plain` refusal arms are the surface's convention (only the success landing survives, G14); D15's `.actions` CSS edit was inside its groups (only `app-new.tsx` and `seed.ts` survive, G37). Refuted by the orphan report's skeptic (reachable, not orphans): `/apps`'s titled success notice (`passwordDone`), `/audit`'s expanded detail and session-filtered view, `/approvals/<id>`'s `null` / array argument arms, `/login`'s `?step=totp` as a sign-in destination, `/device`'s expired-code copy. The report's 55 fixture-quality notes (values fabricated for reachable states, grouped by page) are not copied here — each step reads its pages' notes at its preview walk, per the gate line above.
