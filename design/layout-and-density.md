# Layout width and density — the guideline

Written 2026-09-16 after the owner found the pages inconsistent ("very inconsistent right
now"): five page widths, two rail widths, five button heights, three badge heights, two
auth-card widths, two row paddings. This document pins one ladder for each, derived from
published guidelines (§1), decided for this product (§2), and mapped onto what the code
and boards do today (§3). The tokens in `server/src/pages/styles.css` `:root` and the
**Layout & density** panel on `design/Main.dc.html` are the two homes of the values; this
file is the reasoning. Nothing here overrides §13's pane rules; it decides the numbers
§13 leaves to the design system.

## 1 · What the published systems agree on

All fetched on 2026-09-16; the numbers are quoted, not inferred. Material 3's own spec
pages are script-only and could not be fetched — its numbers come from Google's
developer.android.com mirror and the AndroidX reference implementation.

| Question | Agreement | Sources |
|---|---|---|
| **How page width scales** | Capped fluid: fluid below a cap, centred or left-aligned above it. Caps cluster at 1000–1600 px — Polaris 998, Atlassian "wide" 1128, Ant "e.g. 1200", Primer 1280 (with 24 px padding inside), Carbon 1584. The reason for the cap is prose: Primer caps "so the content region doesn't render paragraphs with too many words per line". Carbon names the one exception, and it is exactly the admin-dashboard case: its **high-density interface** model is "full width, add columns as needed", for "complex product interfaces, catalogs and data visualization dashboards". | [Primer layout](https://primer.style/product/getting-started/foundations/layout/) · [Carbon 2x grid usage](https://carbondesignsystem.com/elements/2x-grid/usage/) · [Atlassian grid](https://atlassian.design/components/grid/examples) · [Ant Layout](https://ant.design/components/layout) · Polaris 13 CSS (`.Polaris-Page` max 998 px) |
| **When a list-detail / three-pane layout is appropriate** | Two panes only from about 840–1012 px up, three only at desktop scale. M3: one pane compact and medium (< 840 dp), two at expanded, three at large (≥ 1200 dp); two panes at medium is "too packed". Primer: one column < 768, up to two ≥ 768, a third only ≥ 1400. Apple: "prefer using a split view in a regular — not a compact — environment". | [M3 window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes) · [M3 canonical layouts](https://developer.android.com/develop/ui/compose/layouts/adaptive/canonical-layouts) · [AndroidX PaneScaffoldDirective](https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/adaptive/adaptive-layout/src/commonMain/kotlin/androidx/compose/material3/adaptive/layout/PaneScaffoldDirective.kt) · Apple HIG split views |
| **Pane widths** | 240–412 px: M3 360 dp (412 at extra-large), Primer side pane 256 / 296 / 320 px at ≥ 1012, Atlassian left sidebar 240 / right 280 / panel 368, Ant Sider 200 (collapsed 80). Split ratios where given: M3 70/30 at expanded, 50/50 at medium. Pane spacer 24 dp (M3). | as above · Primer `PageLayout.module.css` · `@atlaskit/page-layout` constants |
| **Row density** | Only Carbon pins a full ladder: **24 / 32 / 40 / 48 / 64 px** (xs–xl), 64 "only if two lines per row". Everyone else pins padding from which the same rhythm follows: Primer 4 / 8 / 12 px block (condensed / normal / spacious), Ant 8 / 12 / 16 px (small / middle / large). The default sits at 40–48, the dense tier at 32; 24 is Carbon's floor. | [Carbon data table](https://carbondesignsystem.com/components/data-table/style/) · Primer `DataTable/Table.module.css` · [Ant Table](https://ant.design/components/table) |
| **Control heights and targets** | Apple button heights mini 28 / small 32 / regular 44 / large 52 pt; touch target **44 × 44** (Apple, Fluent web/iOS, Primer's AAA advice), 48 on Android, **24 px** as the WCAG AA minimum target (Primer). Dense rows therefore mean a pointer-first product with 44 px on touch. | Apple HIG buttons · [Fluent 2 layout](https://fluent2.microsoft.design/layout) · [Primer responsive](https://primer.style/product/getting-started/foundations/responsive/) |
| **Gutters and margins** | A 4 or 8 px base everywhere (Fluent 4, Carbon 8, Atlassian 8, Polaris 4). Margins step up once at desktop: Carbon 16 → 24 at max, Primer 16 → 24 at ≥ 1280, Polaris 24. Carbon's gutter is 16 px padding each side, "a total gutter of 32 pixels". | Carbon 2x grid overview · Primer layout · Polaris tokens |
| **Line length inside dense UIs** | NN/g 50–75 characters; WCAG 2.2 SC 1.4.8 (AAA) 80 characters (40 CJK); Primer's 1280 cap exists for words per line. Cap prose at 60–75 ch even when the shell runs wide. | [NN/g chunking](https://www.nngroup.com/articles/chunking/) · [WCAG 1.4.8](https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html) |
| **Breakpoints** | M3 600 / 840 / 1200 / 1600; Primer 544 / 768 / 1012 / 1280 / 1400; Carbon 672 / 1056 / 1312 / 1584; Polaris 490 / 768 / 1040 / 1440; Fluent 480 / 640 / 1024 / 1366 / 1920. 768 and ~1024–1056 recur; nobody uses 900. | as above |

Not pinned anywhere fetchable, so not used here: M3's 4 dp density steps, Ant's compact
algorithm deltas, Polaris index-table row heights, Apple sidebar widths, a Fluent density
mode, any Refactoring UI / Baymard number.

## 2 · The decisions for this hub

The hub is a pointer-first admin surface with one phone rendering. Three page shapes exist
and get three width rules; one density ladder serves all of them.

**Breakpoints (three, replacing the single 900 px).**

| Name | Range | What changes |
|---|---|---|
| narrow | < 768 px | the phone shell: brand + hamburger + sidebar, pill rows or the agent page's three levels, every tappable control 44 px |
| regular | 768 – 1023 px | the wide shell; paned pages keep the rail; a two-column pane (listing + details) is NOT split — the agent page stays on its levels, since the split needs the rail + 520 + 360 = 1080 px minimum (M3: two panes below expanded are "too packed") |
| wide | ≥ 1024 px | everything side by side; gutters grow to 24 px |

**Page width by shape.** Fluid under a cap in every case; the cap depends on what the
page holds, per Primer's reason (prose) and Carbon's exception (data).

| Shape | Pages | Cap | Why |
|---|---|---|---|
| **document** — prose, forms, one column of cards | approvals, approval detail, new agent, new app, the auth family | 760 px (`--page-narrow`); the auth card 400 px | ~70 ch at 14 px; WCAG 1.4.8's 80-ch ceiling with room |
| **table** — a list the eye scans row by row | apps, agents, audit | 1280 px (`--page-wide`, was 1140) | Primer's cap: rows read left to right, and past 1280 the row's first and last cells fall out of one fixation; Carbon's 1312 breakpoint is the same judgement |
| **workspace** — a rail and one or two panes, browsed rather than read | `/agents/<slug>`, `/apps/<slug>`, `/settings` | full width inside 24 px gutters, the *panes* capped, not the page: rail 200, listing 520 growing to 760, details the rest, prose blocks inside the details capped at 72 ch | Carbon's high-density model for "complex product interfaces"; M3's 70/30 supporting-pane split at expanded |

A `<main>` carries exactly one of `page--document`, `page--table`, `page--workspace`
(replacing `page`, `page--narrow`, `page--paned`, `page--fluid`). Settings and the app
page become workspaces: their rail and pane run in the same framed box the agent page
uses, so the three paned pages read as one family.

**Rail and panes.** One rail width: **200 px** (Ant's default, inside Atlassian's
240 / Primer's 256; the framed rail's 180 goes). Listing **520 px at 1024, growing to 760**;
details never below 360 (M3's pane floor). Pane spacer 0 inside the frame (the frame's
own borders divide), 24 px between free-standing cards.

**The density ladder (rows).** Carbon's, trimmed to what the hub draws:

| Tier | Row height | Padding | Where |
|---|---|---|---|
| dense | 32 px | 6 / 16 | the agent page's listing rows (`.cr`), audit rows, the grant step's endpoint rows |
| default | 40 px | 12 / 20 | table rows (apps, agents, tokens, sessions), rail entries, menu entries on pointer devices |
| touch | 44 px | 12 / 16 | every row and control at narrow |

No 24 px rows (Carbon's xs is for spreadsheets) and no 48/64 (nothing here needs two
lines per row).

**Controls.** Four heights, each a token, nothing in between:

| Token | Height | Use |
|---|---|---|
| `--control-h` | 36 px | the page's own actions: New agent, Save, Issue, form inputs |
| `--control-h-sm` | 32 px | actions inside a card, a table cell or a listing foot (Discard / Save in the foot, Revoke on a row) |
| `--control-h-xs` | 24 px | inline controls that live in a dense row: the none · ask · allow segments, Ask / Allow on the pattern offer, Approve / Reject on a request, the × on a badge — 24 is the WCAG AA minimum target, and these rows are pointer-first |
| `--control-h-touch` | 44 px | every control at narrow |

The 30 px "Load more" button and the 28 px segmented filter become 32; the 22 px
segments and minis become 24 (two pixels taller, still inside a 32 px row).

**Badges.** One badge: **20 px, 11 px text** (the newest boards' value; 22/12 was the
2026-08 boards'). A badge inside a page title may scale to 22 as a title-row variant, and
that is the only exception.

**Type.** The existing scale stays (24 / 18 / 16 / 15 / 14 / 13 / 12 / 11). Nothing
below 11 px: the 10 px family labels and 9 px info glyph in the endpoint list move to 11.

**Gutters.** 16 px at narrow and regular, 24 px at wide (Primer, Carbon); card padding 24
(default) or 12 / 14 inside a details column (dense).

**Prose.** Any paragraph that can run long — a description, a note, the details pane's
sentences — sits in a block capped at `72ch`, even when its container is fluid.

## 3 · What is inconsistent today, and its fix

From the audit of `styles.css`, the boards and the prototypes (2026-09-16):

| Concept | Today | Rule | Fix |
|---|---|---|---|
| page width | 1140 (`--page-wide`, Apps/Audit/Agents boards) · 1176 (agent boards and both prototypes' `.wrap`) · 1180 (`--page-paned`, Settings/AppDetail boards) · 1220 (shipped `.page--paned` = 1180 + 2×20) · fluid (`.page--fluid`) · 760 | three shapes: 760 / 1280 / workspace | `--page-wide` → 1280; `--page-paned` and `page--fluid` retired for `page--workspace`; boards recaptured at 1280 / workspace |
| rail | 200 (`--rail-w`, Settings, AppDetail) · 180 (framed rail, agent boards, prototypes) | 200 | `.paned--framed .rail` uses `--rail-w`; the agent boards recaptured |
| auth card | 400 (`--card-auth`, Device, ApprovalDetail, AppNew) · 360 (Login, TwoFactor boards) | 400 | the two boards redrawn at 400 |
| button heights | 36 · 32 · 30 (`.more .btn`) · 28 (`.segmented`, one concept) · 22 (`.mini`, `.seg`) | 36 / 32 / 24 / 44 | `.more .btn` and `.segmented` → `--control-h-sm`; `.seg-opt`, `.mini`, `.badge-x` → `--control-h-xs` |
| segment width | 46 (`.seg-opt`) · 44 (prototypes) | 44 | `.seg-opt` → 44 |
| badges | 22/12 (`.badge`, Main, Agents, 2026-08 boards) · 20/11 (all agent boards and prototypes) · 18/10 (one concept) | 20/11 | `.badge` → 20/11; Main's badge row redrawn |
| row padding | tables 10 (th) / 12 (td) · Audit board 10 everywhere · Apps board 12 rows | default 12/20, dense 6/16 | `.table th` → 12; Audit's rows are dense (6/16) as a table of events |
| key column | 110 (`.db .kv-key`, agent boards) · 180 (AppDetailPanes Overview) · none (`.kv-key`) | 110 inside a details column, 180 in a page-width overview | `.kv-key` gets the 180 the board draws; both become tokens (`--kv-key`, `--kv-key-dense`) |
| type below 11 | 10 px (`.ep-family`), 9 px (`.ep-info`) | 11 minimum | both → `--text-2xs` |
| breakpoint | 900, used twice | 768 / 1024 | the narrow block splits: shell and touch rules at 768, the split-pane rule at 1024 |
| `<main>` | `<div class="page">` on apps and approvals | one `<main>` per page | the two pages get a `<main>` |

Applying §3 is a dispatch of its own (every page and most boards change), gated visually
page by page beside its board, per the process change in
`docs/superpowers/postmortems/2026-09-16-agent-page-layout-not-the-board.md`.
