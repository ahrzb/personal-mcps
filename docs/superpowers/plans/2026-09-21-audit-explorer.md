# The audit page, redrawn as an explorer — the dispatch brief (2026-09-21)

The owner asked for `/audit` to stop being a plain table and chose the direction from
`design/concepts/AuditDemo.html` ("this concept is insanely good", 2026-09-21): three
readings — **Summary**, **Sessions**, **Events** — of one filtered set, a per-principal lane
strip with a brush, a facet rail with live counts, related events merged into one row, and
the record as a request inspector. The research behind the choices is
`docs/superpowers/reports/2026-09-20-audit-visualization-research.md`. The order of work the
owner set: **boards first, then the specs, then the code**.

Everything here is decided. An agent that finds a contradiction between this brief and the
demo follows the brief and reports the contradiction in its final report; one that finds a
contradiction between this brief and the *code as it stands* stops and reports, because the
brief was written from the code and a mismatch means one of us misread it.

Two questions the research raised are **not** decided and are not part of this dispatch:
whether `outcome` splits into a mechanism and a reason (why a `-32001` was a `-32001`), and
whether a weekly digest exists. The page below works on the ledger as it is recorded today,
plus the one field §1 adds.

## 1 · What the ledger gains (server)

**`detail.approvalId` on call rows.** Today only the four `approval.*` rows carry
`detail: { approvalId }` (`approvals.ts`); the `tools/call` row refused with `-32003` and the
`tools/call` row dispatched under a claimed approval carry nothing that ties them to it, so
the page cannot draw "asked → you approved → ran" as one row. Both now do:

- `gateway.approvalRequired()` sets `auditDetail = { approvalId }` on the `HubError` it builds
  — the same road `failureClass` rides (`errors.ts`, `HubError.auditDetail`).
- The dispatch that follows a successful `gate.claim(approvalId)` records
  `detail.approvalId` on its `tools/call` row, **merged** with whatever detail the outcome
  already owes (a `-32000` after a claim carries both `failureClass` and `approvalId`).

Hygiene (§15): an approval id is not token material — the four `approval.*` rows already
record it, and `/approvals/<id>` is owner-gated. Nothing else about `detail` changes; in
particular **no `reason` is invented** for `-32001` (§7's three sources stay
indistinguishable in the ledger as they are on the wire until the owner rules otherwise).

**`audit.query` gains three options and wider filters** (`audit.ts`, the one read path):

| Option | Meaning |
|---|---|
| `bodies?: boolean` (default `true`) | `false` selects every column **except** `args_json` / `result_json`, and adds `argsHead` — `substr(args_json, 1, 160)`, absent when the column is null — and `hasResult: boolean`. The projection happens **in SQL**: the explorer reads thousands of rows, and a body is up to `AUDIT_BODY_CAP_BYTES` each, which the Worker must never parse to throw away (128 MB / Error 1102 — `vitest` cannot see it). |
| `id?: number` | exact row id, owner-scoped like every read — the record drawer's one-row fetch. |
| `text?: string` | case-insensitive substring over `principal`, `event`, `app`, `tool`, `client_session_id`, `detail`, `args_json`, `result_json` — a `LIKE` with an explicit `ESCAPE` character, with `%`, `_` and the escape character itself escaped in the needle, OR-ed across the columns. A scan of a retention-pruned table; no index, by decision. Blank or whitespace-only is no filter. |
| the five exact filters (`principal`, `app`, `event`, `tool`, `session`) | each accepts **one value or a list**; a list matches any (`IN`). An empty list is no filter. |

`AuditRow` stays the full row. The slim row is its own exported type:

```ts
/** An audit row without its bodies — what a caller that lists thousands reads (§13's
 *  explorer). `argsHead` is the first 160 characters of the STORED args JSON (already
 *  masked, possibly an oversize stub's own JSON), for a one-line preview; absent when the
 *  row recorded no args. `hasResult` says a result column exists without shipping it. */
export type AuditSlimRow = Omit<AuditRow, "args" | "result"> & { argsHead?: string; hasResult: boolean };
```

`query()` is overloaded on `bodies: false` so neither caller casts.

**The `audit_query` op** (`admin.ts`) gains `id` (`count`), `text` (`text`), `bodies`
(`flag`, default true) and `outcome` (`text` — "Exact outcome string, e.g. ok or -32001.", a
sixth exact filter beside the five), described in the house style; all six exact filters
stay single-valued `text` fields on the op — only the **list form** is the module's own,
used by the page's export and by nothing on the op surface, and every list is expressible
to the op one value per call. `contracts/admin-ops.json` regenerated
(`pnpm contracts:update`). `pmcp audit` gains `--text <s>`, `--id <n>`, `--outcome <s>` and
`--no-bodies` (`cli/src/main.ts`, beside the existing filters; help text updated).

**Constants** (`limits.ts`, each with its interface comment):
`AUDIT_EXPLORER_ROWS = 5000` (the most slim rows the page loads for one window),
`AUDIT_EXPLORER_PAGE = 1000` (one request's worth), `AUDIT_ARGS_HEAD_CHARS = 160`.

## 2 · The SPA's server surface (`api.ts`, `web.ts`)

`/audit` becomes the SPA's **third route family**. The Worker serves the SPA shell for
`GET /audit` behind the same session gate as the other two families (`web.ts`'s `shell`), and
`server/src/pages/audit.tsx` is **deleted** with everything only it used: `AuditPage`,
`auditProps`, `AuditProps`, `AuditStats`, `AuditHistogram`, `AuditBucket`, `AuditPaging`,
`AuditFilterOptions`, `auditStats`, `auditHistogram`, `filterOptions`, the `AUDIT_SCAN_ROWS`
/ `AUDIT_PAGE_SIZE` / `AUDIT_DEFAULT_RANGE` constants, the audit rules in `styles.css` that
nothing else reads, the audit entries of `server/dev/preview.ts` + `server/dev/fixtures.ts`,
and the `design/baseline/audit__*.png` files. `eventRow` / `noBodiesReason` /
`AuditEventRow` / `RecordedBody` stay (the agent page's Activity pane reads them).

Reads, all through `reader` (cookie session, 401 JSON when absent), all `no-store`:

| Route | Answers |
|---|---|
| `GET /api/hub/audit` | **unchanged** — the Activity pane's paged read, bodies included. |
| `GET /api/hub/audit/window?since=&until=&text=&offset=` | `{ rows: AuditWindowRow[], total, since, until, retentionDays, ceiling }` — one page (`AUDIT_EXPLORER_PAGE`) of **slim** rows, newest first, via `audit_query { bodies: false }`. `since`/`until` are epoch ms; absent or invalid means the whole retention window ending now (the server resolves and echoes both, so the client never computes "now" twice). `offset` beyond `AUDIT_EXPLORER_ROWS` answers an empty page. `ceiling` is `AUDIT_EXPLORER_ROWS`. `AuditWindowRow = AuditSlimRow` minus `ownerId`, plus `noBodies?` exactly as `eventRow` computes it (a slim row "has bodies" when `argsHead !== undefined \|\| hasResult`). |
| `GET /api/hub/audit/:id` | `{ row: AuditEventRow }` — the one full row (bodies, `noBodies`), via `audit_query { id }`; `404` JSON when the id is not in the caller's namespace (unknown and foreign indistinguishable). |

**Export.** `GET /audit/export.jsonl` (`paths.auditExport`, unchanged — a bookmark must not
break) stays a Worker route and stays a serialization of the same read, never a second one:
it now accepts `since`, `until`, `text`, and **repeated** `principal` / `app` / `event` /
`tool` / `session` / `outcome` keys, handed to `exportJsonl` as lists. An outcome *class* is
the page's own grouping (`denied` folds two codes), so `outcome=` holds **raw outcome
strings** (`-32001`, `ok`, …) and the page's export link is what expands a class to its
codes. `range`, `limit`, `offset` and `expand` are ignored by the export as today.

**Deep links that must keep working** (the agent page, the app page and old bookmarks emit
them): `/audit?principal=agent:<slug>`, `/audit?app=<slug>`, `/audit?session=<id>`,
`/audit?expand=<id>#event-<id>`, and `?since=&until=` in epoch ms. `?range=1h|24h|7d` stays a
readable spelling of a window ending now; `30d` reads as the whole window; `?limit=` /
`?offset=` are ignored.

## 3 · The page (`web/src/features/audit/`)

**Shape.** The ladder's **workspace** (`design/layout-and-density.md` §2): full width inside
24 px gutters, a **facet rail 200 px** as its own card, the main pane the rest, 12 px between
cards as the demo draws. `Audit` moves from the table row to the workspace row of the
ladder's shape table. Dense rows (32 px, 6 / 16), controls 32 / 24, badges 20 / 11, nothing
below 11 px — the demo's 10 px axis labels and rail eyebrows become 11.

**One state, in the URL** (every key a string or repeated strings, per `router.tsx`'s
contract): `view=summary|sessions|events` (absent = `summary`), `since`, `until`, repeated
`principal` / `app` / `event` / `tool` / `outcome` / `session`, `q` (the search text; sent to
the server as `text`), `expand=<id>` (the open record), `open=<sessionId>` (the open session
in Sessions). `tool` values are `<app>/<tool>` on the page (the facet names a tool by its
app) and are split for the export link. `outcome` values are the five classes; the export
link expands a class to its codes.

**Outcome classes** (the demo's, unchanged): `ok` ← `ok`; `approval` ← `-32003`; `archived`
← `-32002`; `denied` ← `-32001`, `-32000`; `error` ← `error`. Colours are the demo's five
`--o-*` values; the class **name is always printed beside the colour** (chip text, legend),
never colour alone.

**Loading.** One TanStack query per `(since, until, q)`: page 0 first, then the remaining
pages up to the ceiling in parallel, concatenated. Facets, the brush, views, merging and
sessions are all computed client-side over the loaded rows — a facet click never fetches.
`q` is debounced 250 ms. The window the query asks for is always the **whole retention
window**; `since`/`until` in the URL are the **brush**, applied client-side, so dragging
never fetches either. When `total > ceiling`: the notice "Showing the newest 5,000 of N
events — narrow the search, or export JSONL for all of them." — a **template**: both numbers
are formatted at render, the first from the response's `ceiling` (never a second literal of
`AUDIT_EXPLORER_ROWS`) — and the lane cells older than the oldest loaded row draw as **not
loaded** (hatched), never as empty.

**Header.** "Audit log", the subtitle "N events · <from> → <to> UTC · kept for N days",
**Export JSONL** (a plain link to `/audit/export` carrying the current selection), and the
view segment.

**Lane strip.** One lane per principal present in the loaded rows (at most 6, busiest
first, the rest folded into a last lane "N others"), one cell per hour of the retention
window, each cell the **worst** outcome class in that hour under the current facets and
search (the brush does not dim the strip — it is drawn on it). Drag selects a window (≥ 1 h);
**1h · 24h · 7d** presets sit beside the title (the last labelled from `retentionDays`);
**Whole window** clears the brush (the demo's "Whole week" — retention is a knob, so the
label must not name a week). A legend names the five classes. Keyboard: the strip is
focusable, ←/→ move the brush by an hour, Shift+←/→ resize it.

**Facet rail.** Groups `outcome`, `principal`, `app`, `tool`, `event`; each value a toggle
with its count **under every other filter but its own group's** (Hearst's exhaustive counts),
a proportional bar, the top 5 (6 for tool and event) with **Show all N** expanding the group
in place. Several values in one group OR; groups AND. `session` is never listed — it is set
from a record. Active filters repeat as removable chips above the main pane, with the search
box ("Search events and bodies…", `/` focuses it) and **Clear**.

**Summary.** Three tiles (events · tool calls; refused or waiting on you; median call · p95);
**Worth a look** — the three hand-written rules of the demo, each with **show me**: the
worst refused (principal, target) pair when it exceeds 5, tools first seen in the last two
days of the loaded window, and changes to the setup (`admin.*`, `upstream.*`); top-N bars
for Agents, Apps, Tools; Refusals; Changes you made; and the foot "All N events →". With no
`reason` in the ledger the first rule's sentence ends at the outcome class: "**agent:cron was
refused 214 times** calling `news/get_news` — denied."

**Sessions.** One row per `client.sessionId` (rows without one group under
"<principal> · no session"), newest first, 40 at a time behind **Load more**; opening one
draws the salience waterfall: runs of more than two `ok` `tools/call` rows fold to "N ok
calls — apps", everything else keeps its own line and opens its record.

**Titles.** A row, a waterfall line, a record head and a timeline line are titled
`<app>/<tool>` only for the three call events (`tools/call`, `prompts/get`,
`resources/read`); every other event is titled by its **event name**, with `<app>/<tool>` as
dim secondary text when the row carries them — an `approval.*` row names an app and a tool
and must not read as a call *(added in review, 2026-09-21)*. The one exception is an Events
**chain row**: it is the story of a call, so it is titled by that call's `<app>/<tool>`
whichever row heads it (the record it opens is still the head row's, titled by the rule
above).

**Events.** Merged rows, newest first, 120 at a time behind **Load more**: rows sharing a
`detail.approvalId` are **one chain row** (headed by the `approval.requested` row, else the
earliest; a chain is ordered by (ts, id) — the hub writes `approval.requested` before the
refused call's own row), with the chain sentence ("asked for approval → you approved 18:00
→ ran ok 1.2 s" — the refused call IS the ask, not a step of its own) and the state of its
last event; consecutive un-chained rows with the same
(event, app, tool, principal, outcome, `detail.failureClass`) collapse to **×N runs**. The
third line previews `argsHead` clipped to 110 characters (an oversize stub's head renders as
its placeholder), else the first three `detail` pairs. The foot: "N rows from M events —
related events merged, repeats collapsed."

**Record** (`?expand=<id>`): a right-hand drawer, 620 px, over a scrim — a Base UI Dialog
(focus trap, Escape), not a hand-rolled one. Head: outcome swatch, title, time, Close. Body:
**Search this record…** (highlights matches in the tree), the **Record** field table (when,
principal, event, app, tool, outcome with its raw code, duration, client, session, id — every
id a button that filters by it and closes the drawer), **Arguments** / **Result** /
**Detail** as collapsible JSON trees (first level open; stubs as `‹blob image/png · 4.2 MB›`
/ `‹oversize · 20 KB›` per §13's KB/MB rule; `‹redacted›` as a stub chip), the three
no-bodies sentences verbatim from §13, a chain record's sibling events as a short timeline
whose lines open their own records, and **Show this session** / **Copy as JSON**. The bodies
arrive from `GET /api/hub/audit/:id` when the drawer opens; until then the field table is
already drawn from the slim row and the body sections show a skeleton. A record id outside
the loaded rows still opens (the one-row read does not need the window).

**States** (each a preview fixture, §5): loading skeleton; load failed (the shell's error
card, **Try again**); empty ledger ("Nothing recorded yet — calls, approvals and config
changes will appear here."); filters match nothing ("Nothing matches — widen the window or
drop a filter." + **Clear**); over the ceiling; record loading; record not found ("That
record is gone — audit rows are kept for N days.").

**The phone** (< 768 px, the narrow shell — brand + hamburger): one column. The view segment
runs full width at 44 px. The strip keeps its lanes with each name **above** its cells; there
is **no drag** on touch — the presets and tapping a day on the axis set the window. The rail
becomes a **Filters · N** button opening a full-screen level headed `‹ Audit` with the same
groups at 44 px rows and a sticky **Show N events**. Event rows become two-line cards (time ·
principal · outcome chip; then the mono title, the chain line, ×N). A session header wraps
to two lines and its waterfall puts each label above its bar. The record is a full-screen
level headed `‹ Audit`, not a drawer. 768–1023: the desktop layout with the rail above the
main pane as a wrapping row of groups.

**Files.** `AuditPage.tsx` (the route component and URL state), `derive.ts` (**pure**:
outcome class, facet counts, lanes, merge, runs, sessions, waterfall fold, insights, export
href — no React, no `@/` runtime imports, so the `unit` project can import it),
`LaneStrip.tsx`, `FacetRail.tsx`, `SummaryView.tsx`, `SessionsView.tsx`, `EventsView.tsx`,
`RecordDrawer.tsx`, `JsonTree.tsx`. Types in `web/src/lib/types.ts`, keys and fetchers in
`queries.ts`, `paths.audit(...)` in `paths.ts`, the family in `router.tsx` (whose header
comment loses `/audit` from the server-rendered list), and the shell's Audit nav entry
becomes a router link like Apps and Agents. Styles: the demo's stylesheet is the visual
contract — copy its rules into `app.css` under an `.audit` scope on the shared tokens of
`styles.css`; do not re-derive them from a description
(`docs/superpowers/postmortems/2026-09-16-agent-page-layout-not-the-board.md`).

## 4 · Boards (`design/`)

Captured headlessly from the demo, the way `docs/superpowers/plans/tools/capture*.mjs` did
for the agent and app pages — after the demo itself is brought to this brief: the ladder's
sizes, the **Export JSONL** action, the presets and legend on the strip, **Show all N**,
**Load more**, the real ledger's shapes in `AuditDemo.data.js` (`detail.approvalId` on the
four `approval.*` rows and on the two call rows of §1; **no** `detail.reason` on a refusal;
`detail.failureClass` on a `-32000`; `approval.*` rows' `outcome` is `ok`; every other
`detail` checked against its `record(` call site), and the phone rendering as a **responsive
rule set in the same file**, not a second demo.

| Board | Replaces | Draws |
|---|---|---|
| `Audit` (1380) | the table board | Summary, whole window, nothing filtered |
| `AuditViews` (1380, new) | — | Events with a brush, two facet chips, a chain row, a ×N run and a selected row; Sessions with one session open on its waterfall |
| `AuditDetailStates` | the expanded-row board | the record: a call with bodies (a blob stub, an oversize stub, a redacted leaf), the three no-bodies sentences, a chain record's timeline, search-within-record highlighting, a config change; and the page states of §3 |
| `MobileAudit` (390 phones in a row) | the phone table board | Summary, Events, Sessions (one open), the Filters level, the record level |

`design/README.md` (the artboard table, the shape table, a dated section in the style of
"The app page, redrawn as three panes"), `design/concepts/README.md` (the demo marked
adopted; `AuditDirections` kept as the round behind it), both `canvas.json` files re-laid
out with no overlaps.

## 5 · Tests, fixtures, gates

- **Worker tests first**, before the implementation they pin: `audit.query`'s four additions
  (each option, the list filters, the `LIKE` escaping — a needle of `%` must match only a
  literal `%`, owner scoping on `id`), the two new routes (401, 404, the slim row never
  carrying `args` / `result`, `offset` past the ceiling), the export's repeated keys, the
  `approvalId` on both call rows (refused, and dispatched after a claim), the SPA shell on
  `/audit` (session gate, `no-store`). The two `/audit` `describe`s in
  `server/test/worker/web-pages.test.ts` go with the page they pinned; what they pinned that
  still holds (the three sentences, the stub sizes) moves to the unit test below.
- **`server/test/unit/audit-derive.test.ts`** over `web/src/features/audit/derive.ts`: outcome
  classes, facet counts excluding their own group, the chain merge, ×N runs (and that a chain
  never joins a run), the waterfall fold threshold, the three insight rules, the export href
  (class → codes, `<app>/<tool>` split, repeated keys), lanes' worst-outcome and not-loaded
  cells. Strategy §3 gains the file's row.
- **Preview gallery**: `web/src/preview/fixtures/audit.ts`, `PreviewName` gains `audit` — one
  seed per state §3 names plus `summary`, `events`, `eventsFiltered`, `sessionsOpen`,
  `record`, `recordChain`, `recordNoBodiesOff` / `Refused` / `Unrecorded`, `recordStubs`,
  `longData` (a 300-character tool name, a 40-key args object, a 64-character session id).
  New baselines are written from the accepted render; `web/visual-accepted.json` untouched.
- `test-inventory.json` regenerated; `scripts/smoke.ts`'s `/audit` probe updated to the shell
  and the window route.
- **Gate** (run alone, nothing else running): `pnpm typecheck`, `pnpm test`, the inventory
  diff exact. **Visual gate**: the gallery beside the boards at 1300 × 900 and 375 × 812
  before any ship.

## 6 · Who owns which files

| Agent | Owns |
|---|---|
| boards | `design/**` |
| specs | `docs/specs/**` |
| server | `server/**`, `cli/**`, `contracts/**`, `scripts/smoke.ts` |
| web | `web/**`, `server/test/unit/audit-derive.test.ts`, `design/baseline/audit__*.png` (the old page's baselines out, the accepted render's in) |
| orchestrator | `test-inventory.json` — regenerating it runs the whole suite, so it happens once, at the gate, with nothing else running |

An agent never edits outside its row; a needed change elsewhere goes in its final report.
No agent commits: the tree and the index are shared, so the orchestrator commits by path —
the tests before the code they pin.
