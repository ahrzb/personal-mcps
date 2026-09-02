# Owner sheet 3a — the open questions, with a recommendation each

> Roadmap step 3a (`2026-09-02-roadmap-after-d15.md` § Step 3). The roadmap's table cites
> the spec sentence and file line each answer touches; this sheet adds the orchestrator's
> recommendation so an answer can be one word ("agree" / a choice). Answers land as
> `spec:` commits or decision-log entries; rows they create or retire land in the step
> that implements them. Three questions were added after the roadmap was written (the last
> three rows). Answered rows are marked in place with the date.

| # | Question | Recommendation | Answer |
|---|---|---|---|
| 32(a) / G27 | `N args` vs `1 arg` on the Tools pane | `N args` (§13's text); the pane's string edit rides step 8 | |
| 32(b) | Does a never-connected tunneled app dim Tools | Yes — dim, with "never connected" as the reason; no catalog exists to list | |
| 32(c) / G27 | Literal `<hub>` vs the hub's origin in §20's scoped-endpoint sentence | The origin — a copyable endpoint is the point of printing it | |
| 32(d) | Does a failed proxied listing blank the Roles marker | Yes — the same failure blanks every catalog-derived marker, one rule | |
| 37(a) / G27 | What an unreachable headers-mode Tools pane says | "Couldn't reach `<endpoint>` — the last catalog refresh failed; the tools shown are from `<time>`" (verbatim into §13) | |
| 37(b) / G13 | Where Connect / Reconnect / Disconnect land | The app page (`/apps/<slug>`), notice on the pane: `dispatch` gains a per-request `back`; the two rows the refused fix broke move with it; G14 follows the same answer | |
| 37(c) / G27 | §20.6's Web bullet vs §13's Resources bullet on an approval line | Keep §13 (no approval line on Resources); amend §20.6 | |
| §10 / G29 | `pmcp connections` columns | Add ORIGIN and SELF-REGISTERED (the two fields `connection_list` already returns); step 8 | |
| G26 (i) | The `+1 passed` Tokens rail marker row: count the unfiltered pane, or the rail href carries `?kind=` | Count the unfiltered pane (the rail names the pane, not the view); retitle the row in its own `test:` commit | |
| G26 (ii) | May an unreviewed oracle row stand | No — amend the standard gate's item 2: a `+passed` key with no prior `todo` fails the gate unless the owner reviews it in that gate | |
| G12 | The Tokens sentence names an agent page with no route | Interim copy naming `pmcp token issue` in step 8; the link lands in step 9 | |
| G8 | §19.5's zero-agents state sends the owner to `/apps` | Amend `19-inbound-oauth.md:295-301` to name the Agents page; interim copy `pmcp agent create` in step 8 | |
| G23 | Push bodies are draft-04 `aesgcm`; Apple refuses | Library swap (step 14) — Safari/iOS is the phone §13 says installs; either way pin one HKDF label in `push-service.ts:189` now | |
| G28 | Reserve `agents` now | Reverse decision 30:239 — reserve in step 8 (a username `agents` registered first shadows the route for good; the cost of reserving early is nil) | |
| G39 | The D13.1 capabilities-column debt | Retire: §13 asks for no column and the app page's rail dimming answers it; fix the "/services" spelling | |
| G5, G6 | Severity calls | Both blocking, order-only; the fixes do not change | |
| 32(e) | `aria-current="page"` on the active mobile pill | Pin it (one attribute, one row) | |
| D16 flake | `tunnel/stream.test.ts:631` rings after `settle()`'s fixed 5 ticks instead of the `untilSockets(appId, n)` precondition its siblings use (`:552`, `:594`, `:771`); failed 3 of 8 runs on earlier trees, 11 / 0 on the final one | Change the precondition to `untilSockets` — testing §9 rule 3 says red is never resolved by editing the test, but this is a precondition its siblings already state, not an assertion; its own `test:` commit with the key unchanged | |
| PSD record | The retrospective found D10's "PSD sweep" script never loaded the skill, and D14's "15 findings (11 fixed, 4 rebutted)" matches no run (it equals D13's numbers) | Amend both ledger entries in place, dated, in step 13 with G38 | |
| D16 residue | Two local `withShrunkCallTimeout` copies (`data-model.test.ts:277`, `pipeline-tunnel.test.ts:571`) keyed `ms >= CALL_TIMEOUT_MS`; `timers.ts`'s over-claiming header | Migrate both to `withShrunkTimers` and reword the header in step 13 | |
