# Step 6 — `/audit` chrome: G5, G11, G50, G51 (inline fix)

> Roadmap step 6 (`2026-09-02-roadmap-after-d15.md` § Step 6) holds the goal, the shape and the DoD; none of that is restated. This
> settles what it listed, plus the six unknowns the reader left. Evidence re-read 2026-09-03: `audit.tsx:390-394`, `:403-406`,
> `:414-448`, `:442-447`, `:590`, `:369`+`:501`, `:505-508`+`:519-528`, `:575-576`, `:248-256`, `:63-76`+`:469-471`,
> `:326`/`:330`/`:339`, `:204-209`+`:552-556`; `pages/model.ts` symbols `auditFilters`, `auditQueryOf`, `rangeOf`, `auditStats`,
> `auditHistogram`, `positive`; `styles.css:656`, `:844-880`, `:1770-1773`, `:1976-2010`; `src/audit.ts` `record`; `fixtures.ts`'s
> `AUDIT_SINCE`, `auditHistogram` const and `audit` record; `preview.ts:64-71`+`:88`; `13-web-surface.md:156-170`; testing §9 rule
> 4(b); O22-O24 and audit fixture notes 84-88, 92, 93.

## Settled

**The submit control — a visible `Apply`, a DIRECT child of the second `.filters` row** (`<button type="submit" class="btn
btn--outline btn--sm">`, last child of `:414-448`, a sibling of the wide-only block at `:442-447`, never inside it). A visually
hidden button fixes the mechanism and leaves G5's complaint standing: a sighted owner with scripting off still sees no way to apply
the tool text. Inside that block is worse — `.wide-only` is `display:none !important` at ≤900px (`styles.css:1770-1773`), so G5
would stay unfixed on the exact breakpoint `MobileAudit.dc.html` is the contract for. Wide: it follows the spacer and reads as one
pair with "Clear filters". Narrow: `.filters{display:contents}` flattens it at `order: 0`, i.e. BEFORE the tool box it applies
(`.filter-tool{order:1}`, `:1998-2000`), so it takes `order: 2` — the second of the two CSS edits below; `.filter-group` is
`align-items:stretch` (`:868-874`), so no width rule. It carries the pager's `limit` by `form=` (`:590`), and it is what makes
Return apply — three text fields block implicit submission.

**The three `onchange="this.form.submit()"` selects stay, and the pager's with them.** One select click filtering the page is
behaviour today; dropping it to buy "one apply gesture" is a regression G5 never asked for, and Rows-per-page would then need two
gestures in two parts of the page. Instant with script, Apply without — so step 12 leaves it alone.

**Two native date inputs named `since`/`until`; the hidden epoch pair deleted; a hidden `range` carries a preset.** (Amended by
the orchestrator 2026-09-03: the revised draft had EVERY submission normalize the window to whole days and drop the preset — a
select click on a 7d page would land on a custom window with no segment current, a regression G5 never asked for; the refuter's
alternative, blank inputs, was rejected only because the deleted pair left nothing to carry the preset. One hidden field carries
it.) The readonly box (`.input-group`, `:403-406`) becomes a NEW `.filter-pair` — the class is reused, the element is new — holding
`<input type="date" name="since" aria-label="From" value={…} />` and its `until` twin. The hidden `since`/`until` (`:391-392`)
MUST go: same name twice and `URLSearchParams.get` takes the first, so the owner's date would never take; hidden `session` (`:393`)
and `offset="0"` (`:394`) stay. `value` is `new Date(ms).toISOString().slice(0, 10)` ONLY when `range === "custom"`; on a preset
both inputs are empty and one `<input type="hidden" name="range" value={range} />` is rendered instead — the segment is the
preset's indicator, the inputs are the custom window's. So a select's `onchange`, the pager and an untouched Apply on a preset page
submit `range=24h&since=&until=` and get the same preset back, anchored to now exactly as the segment's own link would be; a typed
pair submits two `YYYY-MM-DD` days and gets the custom whole-day window, `rangeOf` (exact-span match) calling it `custom`, no
segment current. Segments and links keep emitting epoch ms and `auditQueryOf` is untouched, so §8's boundary parity is; `range` is
a form-only spelling that never appears on a rendered link. Parsing: one helper in `pages/model.ts` used by `auditFilters` only —
an epoch-ms integer via `positive()` as today, else a `/^\d{4}-\d{2}-\d{2}$/` day through `Date.parse` (UTC midnight by spec);
`positive()` itself is untouched, shared as it is by approvals' and audit's numeric params. A day in `until` snaps to that day's
END (`+ 86_399_999`): `AuditQuery.since/until` are inclusive, so a same-day pick would otherwise select one instant and read as
broken. A pair that is absent, empty, half-typed or inverted (the guard gains `&& until >= since`) is simply not a window:
`auditFilters` falls back to the preset `range` names when it is one of the four keys, else to `AUDIT_DEFAULT_RANGE` — which the
segments then show. `web.ts` owns no edit — the JSONL export re-uses `auditFilters`.

**`fmtDateRange` and `IconCalendar` die with the box they served.** Chromium and Safari draw their own calendar affordance inside
`input[type="date"]`, colliding with `.input-group`'s absolutely-positioned icon and 34px padding; each helper has one call site, so
both go (step 2's rule). The input is already styled (`styles.css:656`, `:852-855`, `:1881`, `:1989-1993`); the CSS edits are
exactly two, both in the narrow block — extend `.filter-pair select` (`:2007-2010`) to `select, input`, and the submit's `order: 2`.
The boards draw one combined picker (`Audit.dc.html:58-63`, `MobileAudit.dc.html:50-56`) and no Apply: two deviations, step 12's.

**The empty histogram (G50) is one early return on `scan.length === 0`** — `auditHistogram` returns `{ bucketMs, buckets: [], peak:
0 }` before building the 24-slot array. It reads as what it is ("nothing matched") and keeps `bucketMs` derived; a `peak === 0` or
template gate would also fire when rows fall outside the bucket guard, i.e. mean "nothing drew". Page read and scan share the
window, so "No events in this window." (`:505-508`, which also suppresses the day axis `:519-528`) now ALWAYS co-occurs with the
table's "No events in this range" (`:575-576`); not the reverse — an `offset` past `total` empties the table, bars intact.

**The bucket caption is fixed here, with no G id.** `bucketMs = max(60_000, ceil(span / 24))` renders "0.041666666666666664-hour
buckets" on the live 1h preset today (`:369` → `:501`) and nearly every custom span is fractional, so this step pays for the defect
it makes ubiquitous: `bucketHours` goes, for a one-line helper beside `fmtDuration` (`:48`) reading minutes under an hour and
one-decimal hours above (150 000 ms → "2.5-minute buckets"). Not suppressed when empty — it describes the window, not the data.

**A custom window marks no segment; the delta sentence needs no code.** `RangeSegment` sets `aria-current` only on an exact preset
(`:248-256`), so a custom window paints four unselected segments: O24's state made reachable and the intended reading, not a second
gap. No fifth "Custom" segment — it invents a control on a board-pinned component in an inline-fix step. UNCHANGED, not a diff: the
tile already reads "… vs previous period" when the range is custom and the previous window is non-empty, "No comparison available"
when it is empty (`auditStats`' `previousTotal === 0` null, `:469-471`) — the loader needs nothing and NO guard is added. In this
suite that empty arm is the only one a preset can reach: `audit.record` binds `ts` to `Date.now()` (`src/audit.ts:203-215`) and owns
the one INSERT, so every seeded row sits at ≈now while a preset's previous window lies one span back — rows 2 and 3 pin it.

**The sort glyph goes; its absence is a gate grep, not a row** — `IconSort` (`:204-209`) renders once (`:552-556`) with no anchor
and no sort parameter, §13:156-170 pins no sort, and a row asserting a deleted icon has no twin (§9).

**Fixtures: `default` becomes a true 7d, `middlePage` becomes the custom producer.** Both declare `range: "7d"` over a 6 d 14 h 47 m
span (`AUDIT_SINCE`/`AUDIT_UNTIL`) that `rangeOf` calls custom (note 84). `default` gets its own `since` =
`2026-08-17T14:47:00.000Z`; `middlePage` keeps `AUDIT_SINCE` and declares `range: "custom"` — its reason to exist (both pager arrows
live) is orthogonal — so the preview gains the four-unselected-segments state and, via its non-null `eventsDeltaPct`, the "vs
previous period" tile. No sixth key, no registration edit (`preview.ts:64-71` walks `Object.keys(fixtures[page])`, `:88` looks the
name up). The shared module-level `auditHistogram` const cannot survive — `default`, `middlePage` and `bodyStubs` all assign it and
their spans now differ (7 d, 6 d 14 h 47 m, 24 h) — so it becomes one `histogramFor(since, until, counts)` helper computing
`bucketMs = ceil(span / 24)` and the 24 starts, four call sites (`default`, `middlePage`, `filteredBySession`, `bodyStubs`; the last
two share a window), and note 85 cannot drift back. `empty`'s becomes `{ bucketMs: 150_000, buckets: [], peak: 0 }` — what the
loader computes for its 1 h window (note 86 / O23). Note 92 rides along: `HUB_PRINCIPAL` (`index.ts:270`) into `auditOptions`'
principals. So does note 87's badge half — `OutcomeBadge` renders on the COLLAPSED row (`:326`, `:330`, `:339`), so `default` row
41284's `outcome: "-32003"` is a fabrication shown with nothing expanded; its `detail` shape, and notes 88 and 93, ride step 10's.

## Rows

One new describe in `web-pages.test.ts`, `§13 · /audit's filter row — the window it names and the window it empties`, landed as
`it.todo` in a `test:` commit before any fix, beside `§8/§13 · one paging contract, two presentations`. One new local helper,
`formSubmission(html)`, returns `{ method, action, params }` — method and action off `<form id="audit-filters">`'s start tag through
the file's own `attributeOf`/`decodeEntities` (`:134-136`), params from its own named fields plus the pager's `limit`. It IS the
scripting-off browser, which is why these rows skip `auditPath` (whose "spelled the way a link spells it" comment O22 flags as false
— that comment is step 10's, with G49), and it makes row 1 this form's discharge of §9 rule 4(b). Each refusal beside its twin:

1. `§13 · with scripting off the filter row still applies: #audit-filters renders a submit control that sits in no wide-only subtree, and its own method, action and fields replayed as a browser submits them (§9 rule 4(b), no onchange) return exactly the rows query(env.DB, …) holds for the tool the owner typed over the window that submission names, with since and until each submitted once (the hidden pair is gone, so the value the owner set is the value the loader reads) · the same form replayed untouched returns the default 24h window unchanged — the same seeded rows, the same tool box, 24h still current, carried by the form's own hidden range field — which is also exactly what a select's onchange submits (the twin)`
2. `§13 · the range inputs are named since/until and take a day, not epoch ms: a submission carrying since=<the seed's day>&until=<the same day> renders that day's rows, echoes both days back as the two value attributes, and marks no segment aria-current="page" — a custom window has no current preset · the 24h segment's own epoch-ms link over the same seed marks 24h current, renders both date inputs empty beside a hidden range=24h, and reads "No comparison available", every row being stamped now and a preset's previous window lying one span further back (the preset twin)`
3. `§13 · a window with nothing in it draws the empty histogram, not 24 flat bars: over the UTC day AFTER the ledger's own — the case derives that day from the rows and asserts min(ts) and max(ts) share it, so a midnight straddle fails by name — /audit renders "No events in this window." with no day axis AND the table's "No events in this range", and, that day being the previous window, an events tile reading "-100% vs previous period" · the seeded day itself draws bars, a day axis and "No comparison available", its own previous window being empty (the twin)`

Row 1's "no wide-only subtree" is one markup read — the form's `<div class="…wide-only…">…</div>` bodies (non-greedy; none nests a
`<div>` today) must not contain the control, the grip `nextPageLink` already takes. No existing row changes: nothing asserts the
readonly box, the hidden pair or `IconSort`, row 5's sweep walks POST forms only, `smoke.ts` has no `/audit` page leg, and §13:158
already pins "time range".

## Ownership

| Owns | Files |
|---|---|
| rows | `server/test/worker/web-pages.test.ts` (the new describe only — titles as `it.todo`; the `formSubmission` helper is the body author's, written with the bodies), `test-inventory.json` |
| fix | `server/src/pages/audit.tsx` (the form, two date inputs, the hidden `range`, `Apply`, `fmtBucket`; minus `IconSort`, `IconCalendar`, `fmtDateRange`, `bucketHours`), `server/src/pages/model.ts` (`auditFilters` + its day parser and `range` fallback, `auditHistogram`'s early return), `server/src/pages/styles.css` (the two narrow rules: `.filter-pair select, input`; the submit's `order`), `server/dev/fixtures.ts` (`default`'s own `since` beside `AUDIT_SINCE`, the `auditHistogram` const → a `histogramFor` helper, the `audit` record's five keys, `auditOptions`) |

Nothing else. `web.ts` owns no edit; `positive`, `rangeOf`, `auditQueryOf`, `auditStats`, `rangeNoun` are read.

## Shape

Two workflows, the orchestrator between them: (1) a rows agent lands the three `it.todo` rows and regenerates the inventory →
`test:` commit; (2) one implementer flips them, fixes the fixtures, runs `tsc` and the web-pages file → a verifier runs the inline
gate (full suite; inventory diff exactly the three `todo → passed`; `tsc` 0; confinement to the six files in Ownership; `grep -rn
"IconSort\|IconCalendar\|fmtDateRange" server/src` → 0; no `name="since"` hidden input left) → at most two fix rounds → `fix:`
commit, ledger line. Deploy rides step 8. All agents Opus.

## Open

- **Kept: no fourth row for the select round-trip.** A replay of the untouched form IS a select submit minus the select's own
  field, so row 1's twin already pins it; a separate row would issue the same GET twice.
- **Amended 2026-09-03 (orchestrator): the window's carrier.** The revised draft's "every submission normalizes to whole UTC
  days" is superseded by the hidden `range` above; rows 1 and 2 were reworded to match before landing. Nothing else moved.
- **Kept: "vs previous 24 hours" is asserted nowhere.** Reaching `rangeNoun`'s preset arm needs a backdated row, and `record`
  (`src/audit.ts:203-215`) binds `Date.now()` with no `ts` on `AuditEntry` — a `ts?` on the hub's one audit writer plus a faked-age
  seed row, for a `switch` this step neither reads nor writes. Row 3 pins the custom noun.
- **Step 7's plan is not this file.** Two findings land there, handed to its planner unapplied: `purpose: "maskable"` is rejected
  for "unpadded art" about bytes its own recipe insets to the safe zone; `sizes:"any"`'s chromium issue is not publicly fetchable.
- Otherwise none: the `until` day-end snap, the dropped `.input-group`, `aria-label` From/To, the caption in scope, the inverted
  pair falling back to the preset, and three rows plus a gate grep are decided above; the boards are step 12's.
