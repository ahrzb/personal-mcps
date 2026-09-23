# Pass 2 inventory — every rule, every primitive, every hazard (2026-09-23)

The survey pass 2's brief is written from (decision 38; `2026-09-23-everything-spa.md` §"Pass 2").
Read-only: nothing here changed code. Taken on `spa-everything` at `a9fe7d8` plus the working tree,
while `/login` was still moving, so the login rows describe `web/src/features/login/` as it stood.

**Method.** Both sheets were parsed rule by rule (comments stripped, `@media` context kept). Every
class selector was cross-referenced against the string literals of every `web/src/**/*.ts(x)` file
except `components/ui/` (whose own classes are Tailwind), then re-checked against `className=`
expressions only, so common words (`note`, `list`, `more`, `save`) are not false users. Dynamic
templates (`badge--${tone}`, `a-sw--${cls}`, `a-c--…`, `a-wfbar--…`, `rail-dot--…`, the `seg-opt`
ternary, `STATUS_CLASS`, `lib/format.ts`'s alert map) were resolved by hand. `server/src/pages/*.tsx`
was not counted as a user, since those templates are being deleted. Every rule has a fate from an
ordered pattern table, and the counts below come from running that table.

---

## 0 · Headline

| | styles.css | app.css | total |
|---|---:|---:|---:|
| lines (bytes / gzip) | 3,233 (82.2 KB / 20.4 KB) | 1,683 (50.8 KB / 13.9 KB) | 4,916 |
| rules (inside `@media`) | 421 (99) | 275 (79) | 696 |
| distinct classes defined | 228 | 156 | 378 (a few names in both) |
| **(a) PRIMITIVE → shadcn component** | 133 | 44 | **177** |
| **(b) LAYOUT → utilities in the owning component** | 247 | 222 | **469** |
| **(c) TOKEN → `@theme` / variable** | 1 (`:root`, 64 tokens) | 2 + the `@theme inline` block | **3 + 1** |
| **(d) DEAD → delete** | 26 | 7 | **33** |
| **(e) STAYS as a small global sheet** | 14 | 0 | **14** |

- **Dead now (no user in `web/src`):** 22 rules. 21 are in styles.css and 1 is in app.css. They
  cover 15 class names (§1.3). The other 11 dead rules are covered by preflight or by an identical
  Tailwind utility, or they are app.css counter-rules that do harm (§1.3).
- **Missing components the look needs:** `card`, `alert`, `label`, `field`, `native-select`,
  `radio-group`, `switch`, `sheet`, `empty`. Optional: `skeleton`, `separator`, `tooltip`.
  **Not needed:** `toggle-group`. `.segmented` is navigation (Settings) or view tabs (Audit), and
  `.seg` is a radio group (§2.13). **Generated with no consumer:** `popover`, `combobox`, and
  `textarea`, which has no textarea anywhere and is kept only by `input-group`'s import.
- **Preflight hazards: 19** (§4). 8 need a restoration rule, 5 go away if a conversion lands
  first, 5 are verified harmless, and 1 changes behaviour only.
- **TSX surface:** 1,538 `className=` expressions in 44 files, 40 inline `style={{…}}` props (17 in
  `SettingsPage`) reading 17 `styles.css` tokens through `var(--…)`, and 9 dynamic class templates.
- **Things in the brief the code makes impossible or unwise:** §8. The biggest is that the
  generated components cannot render correctly in today's cascade. app.css's unlayered
  counter-rules make `<Input>` borderless, auto-height and unpadded, and erase every `ring-*` focus
  ring. They have to go before the first swap.

---

## 1 · Rule inventory

Users are file basenames under `web/src`. "n files" means the class is too widespread to list.
Line numbers are rule starts.

### 1.1 `server/src/pages/styles.css`

| Lines | Selectors | Used by | Fate → target |
|---|---|---|---|
| 9–95 | `:root`: 22 colours, 2 fonts, 8 sizes, 13 spaces, 4 radii, 3 shadows, 5 control/header heights, 7 widths | everything; inline `var(--…)` in ApprovalDetailPage, ApprovalsPage, AppNewPage, LaneStrip, ConsentPage, DevicePage, SettingsPage | **c** → `@theme` (§3) |
| 99 | `*` box-sizing | — | **d**, preflight |
| 106 | `[hidden]` | — | **d**, preflight has the same `!important` rule |
| 110, 120, 126 | `body`, `a`, `a:hover` | all; bare `<a>`/`<Link>` in 15 files rely on the underline | **e** → `@layer base` |
| 130 | `h1, h2, h3` | h1 ×11, h2 ×6, h3 ×2 | **e** → `@layer base` (line-height 1.2, 600) |
| 138 | `p` | — | **d**, preflight |
| 142 | `:focus-visible` | every non-primitive focusable | **e** → `@layer base` |
| 154–204, 2310–2331 | `.app-header(-main,-end)`, `.app-header-end form`, `.brand` ×3, `.nav`, `.header-user` | Shell; `.brand` also AppNewPage, ApprovalDetailPage, ConsentPage, DevicePage, LoginPage | **b** → `Shell.tsx`; `.brand` in the new `AuthFrame` |
| 213–235 | `.nav-link` (+hover, current) | Shell | **b** → Shell (`buttonVariants({variant:"ghost",size:"sm"})` + `aria-[current=page]:bg-muted`) |
| 237 | `.nav-badge` | Shell | **a** → Badge `count` |
| 254, 2333–2393, 2426 | `.menu-open`, `.menu`, `.scrim`, `.menu-head`, `.menu-close` | Shell | **a** → Sheet (side right) |
| 2369, 2437 | `#menu:target`, `#menu:target ~ .scrim` | none: the SPA opens the drawer by `data-open` | **d** |
| 2395–2423, 2485 | `.menu-link`, `.menu-foot`, `.menu .btn` | Shell | **b** → Shell |
| 264–308, 2442 | `.page--document/--table/--workspace` (+ ≥1024 gutter, narrow) | AgentFrame, AgentNewPage, AgentsPage, AppsPage, ApprovalsPage, AppDetailPage, AuditPage, SettingsPage | **b** → new `chrome/Page.tsx` |
| 305 | `.page--workspace .listing:not(.listing--wide)` | agent/app panes | **b** → new `chrome/Listing.tsx` |
| 310–336, 2469–2482 | `.page-head`, `.page-title`, `.title-row`, `.page-subtitle` (+ narrow) | the 8 pages above; `.title-row` in 12 files | **b** → `chrome/Page.tsx` |
| 344–364, 2465 | `.paned`, `.pane`, `.pane--narrow` | AgentFrame, AppDetailPage, SettingsPage | **b** → `Page.tsx` workspace |
| 366–458, 2452 | `.rail`, `.rail-group(--tail)`, `.rail-heading`, `.rail-link` (+hover/current/dim), `.rail-marker`, `.rail-dot(--on)` | Panes | **b** → `Panes.tsx` |
| 461–493, 2456 | `.pill-row`, `.pill` (+current) | Panes | **b** → Panes (`buttonVariants` outline sm + `rounded-full`) |
| 497 | `.sr-only` | AuditPage, LaneStrip, Panes, States | **d**, Tailwind's identical `sr-only`; call sites unchanged |
| 509–518 | `.section`, `.section-title` | ApprovalsPage, AppsPage | **b** |
| 522–542 | `.muted`, `.note`, `.eyebrow`, `.mono` | 13 / 25 / 14 / 26 files | **b** → four `@utility` definitions in app.css, so about 200 call sites stay as they are |
| 544 | `.error-text` | none | **d** |
| 551–633, 2491, 2505 | `.btn`, `--primary/--outline/--ghost(+hover)/--danger/--danger-outline/--danger-ghost(+hover)/--sm/--block`, `[disabled]`, narrow 44 px | 33 files, about 124 sites, at least 25 of them on `<a>`/`<Link>` | **a** → Button |
| 577 | `.btn--secondary` | none | **d** |
| 636–655, 2510 | `.btn-icon` (+disabled, narrow) | none | **d** |
| 657–673, 2583 | `.actions`, `--start`, `--bottom`, narrow `.actions .btn` | 14 files | **b** → call sites (`flex flex-wrap justify-end gap-3 max-md:*:flex-1`); DialogFooter in Confirm |
| 677–693 | `.form`, `.field`, `.label, .field > label` | 9 files | **a** → Field / FieldGroup / FieldLabel |
| 695–742, 2491 | `input[type=text…date]`, `select`, `textarea`, `::placeholder`, `[aria-invalid]`, `.input--mono`, narrow 44 px | typed inputs in 12 files; `<select>` ×2 (CredentialsPane, ConsentPage) | **a** → Input, NativeSelect |
| 744 | `.input--auto` | none | **d** |
| 748–756 | `.field-hint`, `.field-error` | 9 files | **a** → FieldDescription / FieldError |
| 759–773 | `.input-group` ×3 | none (the audit box is `.a-search`) | **d** |
| 775–795 | `.checkbox`, `.checkbox input`, `.checkbox-hint` | SettingsPage:306 (native box) | **a** → Checkbox + Label |
| 798–836 | `.choice-list`, `.choice` (+radio, `:has(:checked)`), `.choice-title/-desc` | AppNewPage | **a** → RadioGroup (card items) |
| 839–853, 2517 | `.otp`, `.otp input` | OtpBoxes | **a** → Input with sizing classes; OtpBoxes keeps its own markup |
| 856–887, 2587 | `.segmented` (+items, current, narrow) | AuditPage (buttons), SettingsPage (Links) | **a** → Tabs for Audit; Settings keeps links styled with `tabsListVariants` (§2.13) |
| 893–907, 2594 | `.confirm-actions` | ConsentPage, DevicePage | **b** |
| 909 | `.spacer` | none | **d** |
| 917 | `.contents` | AgentAppPage, AppsPage, LoginPage | **d**, Tailwind's identical `contents` |
| 923–984, 2104, 3152, 3206 | `.badge`, `--title/--outline/--muted/--success/--warning/--danger/--mono/--dashed/--xs`, `.cr-detail .badge` | 22 files, about 122 sites | **a** → Badge |
| 986–997 | `.dot`, `.dot--idle` | AppsPage, OverviewPane, SettingsPage | **a** → Badge (dot child) |
| 999 | `.badge-row` | AppDetailPage, AppsPage | **b** |
| 1008–1047, 2161, 2201, 2669 | `.card`, `.card--pad`, `.card-head`, `.card-title`, `.card-desc`, `.card--danger`, `.db .card--pad` | 22 files | **a** → Card (`size` default/sm) |
| 1038 | `.card-count` | none | **d** |
| 1049–1073, 2599, 2604 | `.stat`, `-label`, `-value`, `-value--danger` (+ narrow) | none | **d** (6 rules) |
| 1076–1102 | `.list`, `.list-item`, `.list-title`, `.list-meta` | SettingsPage; list-title also ApprovalsPage; list-meta also AgentsPage | **b** |
| 1106–1139, 2609–2633 | `.table`, `th`, `td`, last row, `.row--dim`, narrow stacking | AgentsPage, AppNewPage, ApprovalsPage, AppsPage, OverviewPane, SettingsPage | **a** → Table (+ a `stack` prop for the narrow cards) |
| 1142–1191, 1169, 2636–2656 | `.cell-mono/-time/-muted/-actions/-name/-slug/-summary`, `.table .cell-actions .btn` | the same 6 | **b** → TableCell className; the cell button is Button `sm` |
| 1159 | `.cell-strong` | none | **d** |
| 1195–1236, 2658–2667 | `.approval`, `-head/-tool/-where/-meta/-status`, `.expiry` | ApprovalsPage; `.expiry` also CredentialsPane | **b** |
| 1239–1277, 2169–2191, 2812–2825, 2926–2934, 3160 | `.kv`, `.kv-row`, `.kv-key` (+ `.auth-card`, `.db`, `[data-level]`, `--pad` contexts) | 14 files | **b** → promote `features/agents/panes/Kv.tsx` to `chrome/Kv.tsx` |
| 1282–1367, 2560, 2673 | `.code`, `.code-inline`, `.token-reveal`, `.token-value`, `.code-grid`, `.code-chip`, `.code-display`, `.secret` | code: ActivityPane, ApprovalDetailPage, ApprovalsPage; inline/grid/chip/secret: SettingsPage; token-*: Reveal; display: DevicePage | **b** → owners |
| 1371–1416 | `.alert`, `--warning/--danger/--success`, `> svg`, `-title`, `-text` | 20 files + `lib/format.ts` | **a** → Alert |
| 1420–1463 | `.empty`, `-title`, `-text`, `--inline`; `.empty .btn` (b) | 10 files | **a** → Empty |
| 1467 | `.empty-text--aside` | none | **d** |
| 1474–1511 | `dialog`, `dialog::backdrop`, `.dialog-body/-title/-text`, `.dialog .actions, dialog .actions` (the `.dialog` class half is dead) | Confirm | **a** → Dialog |
| 1515–1557, 2526–2557 | `.auth`, `.auth-title/-desc/-foot`, narrow `.auth .card-title/.card-desc/.brand` | LoginPage, DevicePage, ConsentPage, ApprovalDetailPage, AppNewPage | **b** → new `chrome/AuthFrame.tsx` |
| 1526, 2530 | `.auth-card` | the same 5 | **a** → Card `size="auth"` |
| 1560–1574 | `.divider` (+ `::before/::after`) | LoginPage | **a** → Separator ×2 in a flex row, or one utility string (one consumer) |
| 1576 | `.center` | 4 files | **b** → `text-center` |
| 1591 | `.md, .note` (72ch) | — | **b** → `@utility note`; the `.md` half stays |
| 1596–1644 | `.md > :first/:last-child`, `.md p/ul/ol/li/a/code/pre/pre code` | AppGrantDetails, CatalogPane, GrantRows, RolesPane (`dangerouslySetInnerHTML`) | **e** → stays (§1.4) |
| 1650 | `.alias-table td + td` (narrow) | AppNewPage, OverviewPane | **b** |
| 1659, 2298, 2303 | `.narrow-only`, `.wide-only` | 7 files | **b** → `max-md:hidden` / `md:hidden`, or two `@utility` |
| 1672–1693 | `.agent-row`, `.app-row` (+hover, raised cell), `.row-link::after` | AgentsPage, AppsPage; `.row-link` in 9 files | **b** → `@utility row-link` + page classes |
| 1698–1726, 2886 | `.crumb`, `.crumb-sep`, `.title-row--split`, `.title-row-end`, `.row-chevron` | AgentFrame, AppDetailPage, AgentsPage, AppsPage, panes | **b** |
| 1731, 2698–2743 | `.level-header`, `.level-back/-title/-end` | Panes | **b** → Panes |
| 1747–1833, 2746–2767 | `.paned--framed` + its rail/pane contexts (15 rules) | AgentFrame, AppDetailPage, SettingsPage | **b** → `Page.tsx` workspace frame |
| 1840–2194, 2201–2208, 3109, 3145, 3168, 3176, 2788–2952 | `.pane--split`, `.listing(--wide)`, `.listing-form`, `.lh(-filter)`, `.listing-title`, `.sum`, `.scroll`, `.gh(-note/-form/-state/.sticky)`, `.cr(--dim/--sub)`, `.cr-detail(--warn)`, `.cr-control`, `.via`, `.more`, `.save(-end)`, `.details`, `.dh`, `.db`, `.tiles`, `.alias-block`, `.kv--pad`, `.rail-dot--warn` | 12 agent/app pane files + AgentFrame, AppDetailPage | **b** → new `chrome/Listing.tsx` |
| 1995–2066 | `.seg`, `.seg-opt` (+ends, hidden input, checked, `--warn`, `.impl`, disabled, focus) | GrantRows (also imported by app-detail's AccessPane and RolesPane) | **a** → RadioGroup `segment` variant |
| 2074–2100 | `.badge-x` (+target, hover) | GrantRows | **a** → Badge remove button |
| 2214–2287, 2956–2967 | `.appcard(-main,-end)`, `.eps`, `.ep`, `.ep-family/-info/-roles` | GrantPane | **b** |
| 2566 | `.switch-method a` (narrow) | LoginPage | **b** → Button outline `max-md:` |
| 2770–2932 | `[data-level…]` narrow levels (27 rules) | AgentFrame, AppDetailPage (+ Panes) | **b** → owners: `group-data-[level=2]/page:` variants on the `<main>` |
| 2983–3050 | `.cb` (+target, checked/`.on`/`.mixed`/`.lock`, glyph, focus, disabled) | RecordingPane, RolesPane | **a** → Checkbox + a static `Tick` sharing its cva |
| 3057–3105 | `.sw-label`, `.sw` (+thumb, checked, focus) | RecordingPane | **a** → Switch + Label |
| 3117 | `.ty` | RecordingPane, RolesPane | **b** |
| 3124–3141, 3226–3232 | `.arg` | CatalogPane | **b** |
| 3182 | `input.role-name` | RolesPane | **b** → Input className |
| 3191–3201 | `.copyable`, `.copy-value` | Reveal | **b** |

### 1.2 `web/src/app.css`

| Lines | Selectors | Used by | Fate → target |
|---|---|---|---|
| 15–17, 48–56 | layer order, theme / utilities / `shadcn/tailwind.css` / `tw-animate-css` imports | — | keep; preflight joins at P4 |
| 19–26 | `@layer base { *,::before,::after { border-style; border-width } }` | primitives | **d**, preflight |
| 41–46 | `input:not([type])` revert | AgentNewPage's `.input` fields, the audit search | **d**, gone once those are Input |
| 66–81 | `:root` bridge (14 shadcn names → styles.css tokens) | components | **c** → `@theme` |
| 86–106 | `@theme inline` (19 colours) | components | **c** → `@theme`, extended |
| 130–175 | `[data-slot=…] a/button/badge`, `[data-slot]:focus-visible { box-shadow:none }`, `[data-slot=input…] {height:auto;padding:unset;border:0;width:auto}`, `[data-slot=*-content] {box-shadow:pop}` | no consumer of a generated component, but **Shell's `.menu` popup carries `data-slot="dialog-content"`** (Shell.tsx:165) | **d** → delete at P0. They neutralise the primitives (§8.2) |
| 192–214 | `<768: .menu[data-open]`, `.scrim[data-open]`, `.menu-open, .menu-close` button reset | Shell | **a** → Sheet |
| 243–267 | `.audit, .audit-drawer, .audit-level { --o-*, --a-* }` | audit | **c** → `@theme --color-o-*` |
| 272–295 | `.audit`, `.a-head/-ttl/-sub/-exp/-views`, `.a-sub2` | AuditPage | **b**; `.a-views` → Tabs |
| 297 | `.a-skel` | RecordDrawer, parts | **a** → Skeleton with the gradient as className |
| 304 | `.btn--mini` | LaneStrip | **a** → Button `xs` |
| 311–323 | `.a-sw`, `.a-sw--*` (dynamic) | parts | **b** |
| 327–403 | `.a-fbar`, `.a-fchip(-k,-v, button)`, `.a-search` (+input), `.a-searching`, `.a-main--stale`, `.a-filtersbtn` | AuditPage, parts, RecordDrawer | fchip **a** → Badge + remove; search **a** → InputGroup `sm`; rest **b** |
| 407–547 | `.a-strip`, `.a-striphead…`, `.a-lanes`, `.a-lane*`, `.a-cells`, `.a-c--*` (dynamic), `.a-brush`, `.a-axis`, `.a-legend*`, `.a-ceiling` | LaneStrip | **b**; `.a-ceiling` **a** → Alert (compact); `.a-legend-code` **d** |
| 551–655 | `.a-body`, `.a-rail(-title)`, `.a-fgroup`, `.a-railnote`, `.a-frow`, `.a-bar`, `.a-nm`, `.a-ct`, `.a-showall`, `.a-main` | FacetRail, AuditPage, SummaryView | **b** |
| 659–773 | `.a-grid2/3`, `.a-pad`, `.a-stat-*`, `.a-look(ul/li/button)`, `.a-topn*`, `.a-changes`, `.a-foot` | SummaryView | **b** (`.a-look ul` needs `list-disc` at P4) |
| 777–970 | `.a-etab` (th/td/cols), `.a-th-*`, `.a-ev(--sel)`, `.a-rowlink`, `.a-tmono/-title/-dim`, `.a-chain*`, `.a-rowline`, `.a-prev`, `.a-runtoggle`, `.a-runline`, `.a-members…`, `.a-more` | EventsView | `.a-etab` **a** → Table `dense`; rest **b** |
| 974–1094 | `.a-listhead`, `.a-sess`, `.a-shead`, `.a-who/-meta/-counts`, `.a-wf*` (`a-wfbar--*` dynamic), `button.a-wfr` | SessionsView | **b** |
| 1100–1119 | `.audit-scrim`, `.audit-drawer` | RecordDrawer | **a** → Sheet (right, `min(620px,100vw)`) |
| 1121–1300 | `.a-dhead/-lhead/-dtitle/-dtime/-dback/-dclose/-dbody/-actions`, `.a-ftab*`, `.a-olabel`, `.a-why`, `.a-tree/-tn/-tog/-tkey/-tnum/-stub/-hit/-tcount`, `.a-tl*` | RecordDrawer, JsonTree | **b** |
| 1303–1330 | `.audit-level` (**a** → Sheet, full screen), `.a-lbody/-lfoot/-lclear` | AuditPage | **b** |
| 1333–1352 | regular tier 768–1023 | audit | **b** → `md:max-lg:` |
| 1364–1683 | narrow tier | audit | **b** → `max-md:`; a few follow their primitive |

### 1.3 Dead now: delete, no gate needed beyond "no diff"

- **No user in `web/src` (22 rules, 15 class names).** styles.css: `.error-text` 544,
  `.btn--secondary` 577, `.btn-icon` 636/651/2510, `.input--auto` 744, `.input-group` 759/765/771,
  `.spacer` 909, `.card-count` 1038, `.stat*` 1049/1060/1065/1071/2599/2604, `.cell-strong` 1159,
  `.empty-text--aside` 1467, `#menu:target` 2369/2437, and the `.dialog` class half of 1508.
  app.css: `.a-legend-code` 532. They can go in P0.
- **Covered by preflight or an identical Tailwind utility (6):** `*` 99, `[hidden]` 106, `p` 138,
  `.sr-only` 497, `.contents` 917, app.css base border reset 20. They go at P4/P5 and not before,
  because the page still needs them until preflight is on.
- **Harmful (5):** app.css's four `[data-slot]` counter-rules (130–175) and `input:not([type])` (41).
- **Class names in TSX with no rule anywhere:** `input` (AgentNewPage:180, typeless, so it renders
  as the UA's own field), `k`/`v` (AccessPane, RecordingPane, RolesPane), and `page`
  (AppDetailPage:701). The last is a `<main className="page">` left over from the retired `.page`
  shape, so this `<main>` has no width rule. It is a pass-1 leftover worth a look.

### 1.4 What stays as a global sheet, and why

- **`.md` prose (9 rules, 1596–1644, plus 72ch).** It styles HTML that no component renders:
  `server/src/pages/markdown.ts` survives pass 1 and its output reaches the client through
  `dangerouslySetInnerHTML` in 4 files. Its whitelist strips `class`, so utilities cannot reach it
  and it needs descendant selectors. Under preflight it must **grow**, because marked+GFM also emits
  `blockquote`, `hr`, tables and task-list checkboxes, which rely on UA styling today (§4 #1–#3).
- **Base elements (5 rules):** `body` (Geist, 14 px, 1.55, colours), `a`/`a:hover` (underline,
  offset 2, fg→fg-subtle; 15 files have bare links), `h1–h3` (line-height 1.2, 600; preflight makes
  headings `inherit`), and `:focus-visible` (the ring for every focusable that is not a primitive:
  links, rail entries, the 20-odd `.a-*` row buttons). They move into `@layer base` in app.css.
  Preflight cannot supply them, because it resets to *inherit*, not to this design.

---

## 2 · The 12 generated components against today's look

> **P1a outcome (the theme, `web/src/app.css`): the vocabulary P1b builds with.** Every
> token now lives in `@theme` under Tailwind's names. `legacy.css`'s `:root` is dead, because
> the `theme` layer outranks `legacy`. Values are in px, today's values exactly, and
> `--spacing` is 4px. The "two facts" below were true at the time of the survey. They are now
> resolved: `rounded-md` is **8**, and a `text-*` utility sets **no line height**. It
> inherits, like every legacy class that sets a size does. When a component needs a line
> height, it says so with a `leading-*` utility (`leading-none` for Button, `leading-normal`
> for 1.5).
>
> | | Use | Not |
> |---|---|---|
> | **Height** | `h-control` 36 · `h-control-sm` 32 · `h-control-xs` 24 · `max-md:h-control-touch` 44. Badges: `h-badge` 20 · `h-badge-title` 22 · `h-badge-xs` 16 · `h-nav-badge min-w-nav-badge` 18. Also `h-rail-row` / `h-code-chip` 28 · `w-otp-w h-otp-h` 44×48, `max-md:w-otp-w-touch max-md:h-otp-h-touch` 48×52 · `max-md:h-code-display-touch` 52 · `h-level-header` 48 · `h-header` 56 | `h-9`/`h-8` (the same px, but the name says which control height it is), `h-10`, arbitrary `h-[22px]` |
> | **Radius** | `rounded-md` 8 for controls (Button, Input, InputGroup, NativeSelect, Tabs list, Alert) · `rounded-sm` 6 for Badge, Tab trigger, code chip, Skeleton, rail row · `rounded-lg` 12 for Card, Dialog, Empty · `rounded-xs` 3 for Checkbox, `.badge-x` · `rounded-full` for the nav count | `rounded-4xl`, `rounded-xl`, `rounded-[…]` |
> | **Text** | `text-base` 14 for controls · `text-sm` 13 for small controls, cells, helpers, descriptions · `text-xs` 12 · `text-2xs` 11 for Badge and eyebrows · `text-badge-xs` 10 · `text-md` 15 · `text-lg` 16 for Card and Dialog titles · `text-xl` 18 · `text-2xl` 24 · `max-md:text-title-narrow` 20 | `md:text-sm` (it makes desktop inputs 13) |
> | **Border** | `border`, with the colour from the base rule (`--color-border`, #e4e4e7) · `border-input` (the same) · `border-row-border` between body rows · `border-transparent` for `.btn`'s rim · tones `border-{success,warning,danger}-border` | an uncoloured `border-b` expecting black |
> | **Focus ring** | `focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35`. Invalid is `aria-invalid:border-destructive` with **no** ring | `ring-ring/50`, `aria-invalid:ring-3` |
> | **Colour** | `bg-muted text-primary` (Badge) · `text-muted-foreground` · `{bg,text,border}-{success,warning}{,-bg,-border}` · `text-danger-fg bg-danger-bg border-danger-border` · `bg-destructive text-destructive-foreground` (#fff) · `bg-sunken` · `text-fg-subtle` · `text-dim-fg` · `placeholder:text-ring` · audit's `o-*` and `a-*` | `bg-destructive/10`, `bg-black/10` |
> | **Elevation** | `shadow-xs` (card, control) · `shadow-pop` (Dialog, popups) · `shadow-menu` (phone drawer) · `shadow-record` (audit record) · `shadow-thumb` (Switch) · scrims `bg-scrim-dialog` .4 · `bg-scrim-drawer` .35 · `bg-scrim-record` .18 | `shadow-md`, `ring-1 ring-foreground/10` |
> | **Width** | `w-auth` 400 (auth card, Dialog) · `max-w-page` 1280 · `max-w-page-narrow` 760 · `max-w-pane` 640 · `w-rail` 200 · `w-kv-key` 180 · `w-kv-key-dense` 110 | `sm:max-w-md`, `w-100` |
>
> - **Breakpoints.** `max-md:` is legacy.css's `max-width: 767px`, and `md:max-lg:` its
>   768–1023 tier.
> - **`dark:` never fires.** It is keyed to a `.dark` class that nothing sets. Delete these
>   classes, or leave them inert.
> - **Spacing.** legacy.css's `--space-N` is Tailwind's scale at these steps: 1→`0.5`, 2→`1`,
>   3→`1.5`, 4→`2`, 5→`2.5`, 6→`3`, 7→`3.5`, 8→`4`, 9→`5`, 10→`6`, 11→`8`, 12→`9`, 13→`12`.
> - **Legacy names stay readable.** `var(--muted-fg)`, `var(--space-4)`, `var(--radius)` and
>   the rest all resolve through the theme until their last reader goes.

Two facts decide most rows:

- **Font sizes.** styles.css's unlayered `:root` re-declares Tailwind's `--text-*`, `--radius-sm`
  (6) and `--radius-lg` (12). So `text-sm` is already **13 px**, `text-base` 14, `text-xs` 12,
  `rounded-sm` 6 and `rounded-lg` 12, while `rounded-md` is Tailwind's **6 px**.
- **Line height.** Every `text-*` utility also sets Tailwind's line height (`text-sm` → 1.4286),
  where today's classes inherit 1.55 (§3.3).

Heights come out on the ladder by accident of the 4 px spacing: `h-9` 36, `h-8` 32, `h-6` 24,
`h-5` 20.

**No generated component is imported anywhere today**, so every row is a plan, not a regression.

### 2.1 Button (`button.tsx`)

Today, `.btn` is 36 tall with 16 px side padding, 8 px radius, 14 px/500 text, line-height 1, a 6 px
gap and a 1 px transparent border. `--sm` is 32/12/13, `.btn--mini` 24/8/11, and a cell button
32/10/13. Every `.btn`/`--sm` becomes 44 px/14 at narrow widths, except `--mini`, `.menu .btn`
(36/13) and the audit presets (44/12).

| Area | Generated | Change to |
|---|---|---|
| radius | `rounded-md` = 6 | `--radius-md: 8px` in `@theme`. This also fixes Input, Select and InputGroup. |
| text | `text-sm` = 13 on every size | default `text-base`; sm `text-sm`; xs `text-2xs` (11); `leading-none` |
| padding | default `px-2.5` (10), sm `px-2.5`, xs `px-2` | default `px-4`, sm `px-3`, xs `px-2` ✓; the cell button is exactly `sm` at `px-2.5` |
| gap | sm/xs `gap-1` (4) | `gap-1.5` on every size |
| sizes | `lg` h-10 (40, not on the ladder), `icon*` | drop `lg`/`icon*` (`.btn-icon` is dead); add `max-md:h-11 max-md:text-base` to default and sm |
| default variant | `border-transparent bg-clip-padding bg-primary`: the transparent border lets the page show through a **1 px rim** | `border-primary` (visible on every primary button if unchanged) |
| danger | `destructive` = 10 % red tint, matching none of today's three | replace with `danger` (solid red, white text), `danger-outline` (white, `--danger-border`, red text) and `danger-ghost` |
| secondary / link | no consumer (`.btn--secondary` is dead) | delete |
| icons | `[&_svg:not([class*='size-'])]:size-4` forces 16 px | today's hand-drawn icons are 14/16/20/22 px, so give each a `size-*` class or drop the selector |
| focus | `ring-3 ring-ring/50` | `ring-ring/35` (today's `--focus-ring`). **Probably captured**: both `showModal()` and Base UI move focus to a dialog's first control on open, so check the 13 confirm states × 2 widths for a ring |
| links | Base UI Button renders `<button>` | ≥25 `<a>`/`<Link>` sites use `buttonVariants()` on the link, not `render=` |

**Accepted-diff candidates:** the hover fills on default/outline (not captured) and
`active:translate-y-px` (not captured).

### 2.2 Badge (`badge.tsx`)

Today, `.badge` is 20 tall with 8 px side padding, 6 px radius, 11 px/500, a 6 px gap, `bg-muted`
and `text-primary`, plus 7 tones, `--title` (22/12), `--xs` (16/10), `--dashed`, a wrapping form
inside `.cr-detail`, a `.dot` child, a `.badge-x` remove button, and `.nav-badge`. Generated:
`h-5 rounded-4xl gap-1 px-2 text-xs overflow-hidden [&>svg]:size-3!`.

| Area | Change to |
|---|---|
| radius | `rounded-4xl` (a **pill**) → `rounded-sm`. The most visible single diff in the library. |
| text / gap | `text-xs` (12) → `text-2xs` (11); `gap-1` → `gap-1.5` |
| `overflow-hidden` | remove. It clips `.badge-x`'s overflowing 24 px target (a WCAG regression) and the wrapping badge. |
| `[&>svg]:size-3!` | remove. It resizes the audit run toggle's chevron. |
| variants | `default` becomes today's base (`bg-muted text-primary`); `outline` gains `bg-background`, since the details column's ground is `--sunken`; `destructive` becomes `danger` (bg/border/`--danger-fg` triad); add `muted`, `success`, `warning`, `mono`, `count` (nav badge: `rounded-full bg-destructive text-white h-[18px] min-w-[18px] px-[5px] font-semibold`) |
| sizes | add `title` (`h-[22px] text-xs`) and `xs` (16/10, **below the ladder**, §8.5) |
| wrap / dashed | call-site classes (`h-auto min-h-5 whitespace-normal`, `border-dashed`) |

### 2.3 Input (`input.tsx`)

Today, inputs are 36 tall with 12 px side padding, 8 px radius, `bg-background`, `shadow-xs`,
14 px text and a `--ring` placeholder. Focus draws `border-ring` plus a 3 px ring at 35 %. Invalid
draws `border-destructive` with **no** ring (`!important`). Narrow is 44 px.

| Area | Change to |
|---|---|
| text | drop `md:text-sm`, which makes desktop inputs 13 px |
| padding / ground | `px-2.5` → `px-3`; `bg-transparent` → `bg-background` |
| placeholder | `placeholder:text-muted-foreground` (#71717a) → `placeholder:text-ring` (#a1a1aa); visible in every empty search box |
| focus | `ring-ring/50` → `/35`. **Captured**: Login's username and password fields and the OTP first box have `autoFocus`, so every login/2FA baseline shows it |
| invalid | drop `aria-invalid:ring-3`, keeping the border; captured in error states (app-new, login, device) |
| narrow | add `max-md:h-11` |
| cascade | **today app.css line 156 zeroes its height, padding, border and width**, and styles.css's `input[type=…]` (0,1,1) beats its utilities. Fixed at P0 (§5). |

**Accepted-diff candidate:** `agent-new__*` (4 pairs). Those fields have no `type`, so they render
as the UA's own grey field today and will become the design's input.

### 2.4 Textarea

There is no `<textarea>` in `web/src`. It is kept only because `input-group.tsx` exports
`InputGroupTextarea`. Delete both, or apply Input's fixes plus `py-2 leading-normal` if kept.

### 2.5 Checkbox (`checkbox.tsx`)

Today there are two looks:

- `.checkbox input` (SettingsPage:306), a **native** 16 px box with `accent-color`.
- `.cb`, a 14 px box with a 1.5 px `--ring` border, 3 px radius, primary when checked, a `.lock`
  grey, a `.mixed` dash and a 24 px target via `::before`. It is also drawn as a **`<span>`
  statement** and as `<button class="cb on">`.

Generated: `size-4 rounded-[4px] border-input shadow-xs`, a lucide CheckIcon 14 px, and a
40×32 `after:` target.

- Change the `.cb` look to `size-3.5 rounded-[3px] border-[1.5px] border-ring bg-background
  shadow-none`, the indicator to about 10 px, and the target to `after:-inset-[5px]`, so it is
  24 px: 40×32 overlaps neighbours in dense rows.
- Map `data-indeterminate` to the dash, and `data-disabled data-checked` to `bg-ring border-ring`
  (lock).
- Export a static `Tick` from the same cva, since today's reason for one class over two elements
  still holds.

**Accepted-diff candidate:** the Settings native checkbox. Chrome's native rendering cannot be
matched by a Base UI box.

### 2.6 Select (`select.tsx`), and why NativeSelect instead

There are two `<select>`s: CredentialsPane's filter (32 px, auto width) and **ConsentPage's**, which
stays a form POST by decision 38. Base UI Select swaps the OS picker for a popup plus a hidden input.
That is a behaviour change on the trust page and on phones.

Recommend `native-select` (missing): `appearance-none` plus a chevron, `h-9`/`h-8`, `rounded-md`,
`px-3`, `text-base`, `shadow-xs`, `max-md:h-11`. The generated Select would need the same fixes
(`text-sm` → `text-base`, `pl-2.5` → `pl-3`, `w-fit` → `w-full`) and has no consumer.

**Accepted-diff candidate:** the UA arrow becomes a lucide chevron (consent states, credential
filter states).

### 2.7 Table (`table.tsx`)

Today: `th` and `td` have 12/20 padding. `th` is 13 px/500 in `--muted-fg`, nowrap, with a
`--border` rule. `td` has a **`--row-border`** (#f4f4f5) rule and **wraps**. The last row has no
rule. Hover is only on linked rows, as a full `bg-muted`. Narrow widths stack each row as a card.

| Generated | Change to |
|---|---|
| `TableHead h-10 px-2 text-foreground` | `px-5 py-3 text-muted-foreground` (no fixed height) |
| `TableCell p-2 whitespace-nowrap` | `px-5 py-3`, and **drop nowrap**. It defeats `.cell-mono`'s `overflow-wrap:anywhere` and pushes long tokens off the card. |
| `TableRow border-b hover:bg-muted/50` | body rows `border-row-border`, header `border-border`; hover only on `row-link` rows, as `bg-muted` |
| `border-b` with no colour | Tailwind v4's default border colour is **currentColor**, and app.css has no shadcn `* { border-color }` base, so these rows would draw near-black lines. Add the base rule (§3). |
| table `text-sm` | its 1.4286 line height shrinks every row by about 1.6 px per line, shifting every table page (§3.3) |
| container `overflow-x-auto` | harmless inside `.card`; keep it |
| — | add `size="dense"` (6/16 padding, for `.a-etab`) and a `stack` prop for the narrow card rendering |

### 2.8 Dialog (`dialog.tsx`)

Today, Confirm is a **native `<dialog>`** opened with `showModal()`: 400 wide, max `100vw − 40px`,
24 px padding, a 1 px `--border`, 12 px radius and `shadow-pop`. The backdrop is
`rgba(9,9,11,.4)`. The title is 16/600 in a div (1.55 line height); the text is 13 px `--muted-fg`
at 1.5 with an 8 px top margin; the body gap is 16. At narrow widths the actions sit **side by
side** with `flex:1`.

| Generated | Change to |
|---|---|
| `sm:max-w-md` (448) / `max-w-[calc(100%-2rem)]` | `w-100 max-w-[calc(100vw-40px)]`. At 390 px the generated box is 358 px, not 350. |
| `gap-6` | `gap-4` |
| `ring-1 ring-foreground/10` | `border border-border shadow-pop`. Under today's app.css:170 the ring would be replaced by `shadow-pop`, leaving the box with no edge. |
| overlay `bg-black/10 backdrop-blur-xs` | `bg-[rgb(9_9_11/.4)]`, no blur. Visible in 13 confirm states. |
| close ✕ (`showCloseButton` defaults true) | `false`; there is no ✕ today |
| Title `leading-none font-medium` (13 px) | `text-lg font-semibold`, inherited line height |
| Description | `leading-normal` |
| Footer `flex-col-reverse … sm:flex-row` | `flex-row justify-end gap-2`, with `max-md:*:flex-1`. At 390 px the generated footer stacks reversed. |
| `zoom-in-95`/`fade` 100 ms | screenshot timing hazard: have the capture wait for `animationend`, or drop the animation |

**Accepted-diff candidate:** sub-pixel centring. `translate(-50%)` against `dialog:modal`'s
`margin:auto` differs on odd heights and blurs text.

### 2.9 Tabs (`tabs.tsx`)

There is no consumer today. The right consumer is Audit's `.segmented a-views` (Events / Sessions /
Summary are in-page views). Settings' token-kind row is URL navigation, with Links and
`aria-current`: `role=tab` is wrong there, so it borrows `tabsListVariants` classes only.

| Generated | Change to (`.segmented`: 2 px pad, radius 8, `bg-muted`; items 32 px, 12 px pad, radius 6, 13/500 `--muted-fg`; current white + `shadow-xs`) |
|---|---|
| List `rounded-lg p-[3px] h-9` | `rounded-md p-0.5 gap-0.5 h-auto` |
| Trigger `h-[calc(100%-1px)] px-2 rounded-md text-foreground/60` | `h-8 px-3 rounded-sm text-muted-foreground` |
| active `shadow-sm` | `shadow-xs` |
| `after:` underline | line variant only; delete |
| narrow | `max-md:h-11 max-md:text-base max-md:flex-1` |

`web/scripts/audit-search-check.mts:268` clicks `.a-views button:nth-child(3)`, so update it with
the swap.

### 2.10 Popover / 2.11 Combobox

No consumer, and nothing in today's look is either. `.ep-info` uses a `title=` tooltip, and the
audit search is free text with chips, not a list picker. **Delete both** (386 lines; Combobox also
pulls in InputGroup and Button) unless the owner wants them parked. If Popover is kept:
`shadow-md ring-1` → `shadow-pop border border-border`.

### 2.12 InputGroup (`input-group.tsx`)

Consumer: `.a-search`, in the audit filter bar and the record drawer. It is 32 px, radius 8, with a
1 px border, **no shadow**, 10 px padding, a 6 px gap, a 14 px icon, a 13 px borderless input, and
"searching…" as a `.note` addon. It is 44 px at narrow widths.

Changes:

- Add `size="sm"` (`h-8`).
- `shadow-xs` → `shadow-none`.
- Addon `pl-2` → `pl-2.5 gap-1.5`, `font-medium` → normal, icon `size-3.5`.
- The input needs `px-0 text-sm` at **all** widths, because Input's base makes it 14 at narrow.

**Accepted-diff candidate (an a11y fix):** `focus-within` ring. Today a focused audit search shows
**no** focus indicator, because `.a-search input` (0,1,1) beats `:focus-visible`, and it sets
`box-shadow:none` while `:focus-visible` sets `outline:none`.

### 2.13 The missing components, with the target each must hit

| Component | Replaces | Target |
|---|---|---|
| **card** | `.card`, `.card--pad`, `.card-head/-title/-desc`, `.card--danger`, `.auth-card`, `.db .card--pad` | `rounded-lg border border-border bg-background shadow-xs overflow-hidden`. Sizes: default `p-6 gap-4`, `sm` (details column) `px-3.5 py-3 gap-2`, `auth` `w-100 max-w-full p-6 gap-5 max-md:border-0 max-md:shadow-none max-md:rounded-none`. Title `text-lg font-semibold`; description `mt-1 text-sm text-muted-foreground`. |
| **alert** | `.alert` (+3 tones), `.a-ceiling` | flex `gap-2.5 px-3.5 py-3 rounded-md border text-sm leading-normal`, icon `size-4 mt-0.5`, title `text-base font-medium`, text `mt-0.5`. Tones: default muted, warning, danger, success (all bordered). `compact` for the ceiling. |
| **label**, **field** | `.label`, `.field > label`, `.form`, `.field`, `.field-hint`, `.field-error`, `.checkbox-hint`, `.sw-label` | FieldGroup `gap-4`, Field `gap-1.5`, FieldLabel `text-base font-medium`, FieldDescription/FieldError `text-sm` (muted / destructive) |
| **native-select** | both `<select>` | §2.6 |
| **radio-group** | `.choice` cards (AppNewPage), `.seg` three-way (GrantRows) | `card` items with a 16 px radio, `border-primary` when checked; `segment` items 44×24, `text-2xs`, joined borders, primary / `--warning` when checked, hollow `impl` ring, sunken when disabled. **RadioGroup, not ToggleGroup**: today's markup is radios, with exactly one checked and arrow-key navigation. |
| **switch** | `.sw` | 36×20 track `bg-border`/`bg-primary`, 16 px thumb with `0 1px 2px rgb(0 0 0/.2)`, 150 ms. base-vega's default size is smaller, so set `w-9 h-5`. |
| **sheet** | Shell drawer (`.menu`: right, 280 / 85vw, shadow `0 0 40px .18`, scrim .35, 220 ms slide), audit record drawer (right, `min(620px,100vw)`, left border, shadow `-12px 0 40px .12`, scrim .18, full screen at narrow), audit filters level (full screen, narrow) | side right, with widths, shadows and scrims as listed; three scrim alphas become tokens |
| **empty** | `.empty`, `--inline` | Card look `py-7 px-6 items-center text-center`; title `text-md font-semibold leading-[1.4]`; text `mt-1.5 text-sm text-muted-foreground leading-5 max-w-[46ch]`; inline variant drops the box |
| skeleton (optional) | `States.Skeleton` (already utilities), `.a-skel` gradient | trivial: a className on a div is enough |
| separator (optional) | `.divider` "or" | one consumer (login); a utility string does it |
| tooltip (optional) | `.ep-info` `title=`, truncated rail entries' `title=` | behaviour change, not needed for the look |

**Not needed:** `toggle-group` (the brief's guess for the segmented control, see Tabs and
RadioGroup above), `input-otp` (it adds the `input-otp` dependency, and OtpBoxes works),
`breadcrumb` (one link and a separator), `item`.

---

## 3 · Tokens

### 3.1 Today's `:root` → pass 2's `@theme`

| Today (styles.css:9–95) | Value | shadcn / Tailwind name | Note |
|---|---|---|---|
| `--bg` / `--fg` | #fff / #09090b | `--background` / `--foreground`, also `--card*`, `--popover*` | bridged today (app.css:66–106) |
| `--muted` / `--muted-fg` | #f4f4f5 / #71717a | `--muted`, `--secondary`, `--accent` / `--muted-foreground` | bridged |
| `--border` | #e4e4e7 | `--border`, `--input` | bridged |
| `--primary` / `--primary-fg` | #18181b / #fafafa | `--primary` / `--primary-foreground` | bridged |
| `--destructive` | #dc2626 | `--destructive` | `--destructive-foreground` is bridged to #fafafa, but `.btn--danger`/`.nav-badge` use literal **#ffffff**: set it to #fff |
| `--ring` | #a1a1aa | `--ring` | also today's placeholder colour |
| `--success(-bg,-border)`, `--warning(-bg,-border)`, `--danger-fg/-bg/-border`, `--dim-fg`, `--sunken`, `--fg-subtle`, `--row-border` | 11 values | **none**. Add `--color-success`, `--color-success-bg`, … `--color-row-border` | needed by Badge, Alert, Table, Card danger, Sheet |
| `--font-sans` / `--font-mono` | Geist… / ui-monospace… | same names | already shadow Tailwind's; move into `@theme` |
| `--text-2xl … --text-2xs` | 24/18/16/15/14/13/12/11 | `--text-2xl/xl/lg/base/sm/xs` exist; **add `--text-md` (15) and `--text-2xs` (11)** | line heights: §3.3 |
| `--space-1…13` | 2,4,6,8,10,12,14,16,20,24,32,36,48 | Tailwind spacing `0.5,1,1.5,2,2.5,3,3.5,4,5,6,8,9,12` | exact. The indices differ (`--space-4` = `2`, `--space-10` = `6`), so put the translation in the brief. Keep `--space-*` until the 40 inline styles are converted. |
| `--radius-sm` / `--radius` / `--radius-lg` / `--radius-full` | 6 / 8 / 12 / 999 | `--radius-sm` 6 ✓, **`--radius-md: 8`** (today Tailwind's 6), `--radius-lg` 12 ✓ (`rounded-xl` is 12 by default too), `rounded-full` | the one token change that fixes Button, Input, InputGroup and Select at once. It also turns `States.Skeleton`'s `rounded-md` from 6 to 8. |
| `--shadow` | `0 1px 2px rgba(0,0,0,.05)` | `--shadow-xs` | identical |
| `--shadow-pop` | `0 4px 12px rgba(0,0,0,.15)` | **none**: add `--shadow-pop` | shadcn uses `shadow-md`, which differs |
| `--focus-ring` | 3 px `rgba(161,161,170,.35)` | `ring-3 ring-ring/35` | the generated components say `/50` |
| `--control-h(-sm,-xs,-touch)` | 36/32/24/44 | `h-9 / h-8 / h-6 / h-11` | exact on the 4 px scale; keep as named `@theme --spacing-control*` only if the brief wants names |
| `--header-h` | 56 | `h-14` | |
| `--page-wide` / `--page-narrow` | 1280 / 760 | `max-w-7xl` (1280 ✓) / **add `--container-page-narrow: 760px`** | `max-w-3xl` is 768 |
| `--card-auth` / `--rail-w` / `--pane-w` / `--kv-key` / `--kv-key-dense` | 400 / 200 / 640 / 180 / 110 | `w-100` / `w-50` / `max-w-160` / `w-45` / `w-27.5` | or named containers |
| breakpoints 768 / 1024 | — | Tailwind `md` / `lg` exactly | `max-width:767` = `max-md:`, 1023 = `max-lg:`, 768–1023 = `md:max-lg:`. No custom breakpoint needed. |
| audit `--o-*`, `--a-*` (app.css:243) | 5 outcomes + 4 fills + hatch | add `--color-o-ok…`, `--color-a-bar…` | the hatch gradient stays a local variable |

### 3.2 What shadcn needs that has no token today

- A base border colour. shadcn's standard `@layer base { * { @apply border-border outline-ring/50 } }`
  is **absent** from app.css, which sets only `border-style`/`border-width`. Without it, every
  generated `border`/`border-b` with no colour is currentColor.
- Scrim colours: three today (`rgba(9,9,11,.4)` dialog, `.35` drawer, `.18` audit), all literals.
- `--destructive-foreground` = #fff (see above).
- `--shadow-pop`.
- `--chart-*` and `--sidebar-*`: not needed. No chart, and the rail stays Panes, not shadcn Sidebar.

### 3.3 The line-height collision (decide in the theme phase, not per component)

Tailwind's `text-*` utilities set `line-height: var(--tw-leading, var(--text-*--line-height))` from
its own theme (`sm` → 1.4286, `base` → 1.5, `xs` → 1.333). Today's classes set a size and
**inherit** the line height: body 1.55, `.alert` 1.5, headings 1.2. Swapping `.table` for
`text-sm` moves every row by about 1.6 px per line, and every table page diffs.

Recommend declaring `--text-{2xs,xs,sm,md,base,lg,xl,2xl}--line-height: initial` in `@theme`, so
the utilities emit no line height and inherit as today. Verify by reading the emitted `.text-sm`
rule in `dist/app.css`. Where a component wants a line height, say so (`leading-normal`).

---

## 4 · Preflight: what the flip will strip

Tailwind 4.3.3's `preflight.css` against today's rules and markup. **R** means restore; **O** means
ordering, where the problem disappears if a conversion lands first; **✓** means harmless (checked).

| # | Preflight rule | What relies on the browser default today | Restore |
|---|---|---|---|
| 1 | `ol, ul, menu { list-style: none }` | `.md ul/ol` (1608) sets only margin and padding, so every bullet and number in app prose vanishes. `.a-look ul` (SummaryView "Worth a look") also loses its bullets. | **R** `.md ul{list-style:disc}` `.md ol{list-style:decimal}` (+ nested `circle`); `list-disc` on `.a-look ul` |
| 2 | `* { margin:0; padding:0 }` | markdown output `.md` does not style: `blockquote` (UA 40 px indent), `hr` (UA margins), GFM table cells (UA 1 px padding, `border-spacing`), task-list `<input type=checkbox>` (UA margin) | **R** add `.md blockquote/hr/table/th/td/input[type=checkbox]` rules |
| 3 | `hr { border-top-width:1px; color:inherit }` | markdown `---` would become a currentColor (near-black) line | **R** `.md hr { border-color: var(--color-border); margin: … }` |
| 4 | `* { margin:0 }` on `<dialog>` | Confirm's native `<dialog>` is centred **only** by the UA's `margin:auto`, so it would pin top-left in 13 confirm states | **O** convert Confirm to Dialog before P4 (or `margin:auto`) |
| 5 | `* { border:0 solid }` + removal of app.css's `input:not([type])` revert | AgentNewPage's typeless `.input` fields render as the UA's own field; they would go **borderless** | **O** Input conversion (agents family) before P4 |
| 6 | `a { color:inherit; text-decoration:inherit }` | bare links in 15 files, plus `.md a` (colour only) | **R** base `a` rule (§1.4) |
| 7 | `h1–h6 { font-size/weight: inherit }` | h1/h2/h3 classes all set size and weight ✓, but `.card-title`, `.section-title` and `.a-rail-title` headings take **line-height 1.2** from styles.css's `h1,h2,h3` | **R** base `h1,h2,h3{line-height:1.2;font-weight:600}` |
| 8 | `html { line-height:1.5; font-family: --font-sans }` | body sets 1.55, Geist and 14 px | **R** base `body` rule |
| 9 | `::placeholder { color: color-mix(currentcolor 50%) }` | styles.css's `::placeholder{color:--ring}`; placeholders in 17 inputs, including the typeless audit search | **R** Input `placeholder:text-ring` + base `::placeholder{color:var(--color-ring)}` |
| 10 | `button,input,select,textarea { font:inherit; color:inherit; border-radius:0; background:transparent }` | native `<select>` ×2 and native checkbox/radio: styled explicitly today ✓, but only while styles.css exists | **O** NativeSelect / Checkbox / RadioGroup conversions |
| 11 | same rule: `font: inherit` | AgentNewPage's typeless inputs use the UA's 13.33 px system font | **O** (#5) |
| 12 | `button { padding:0; border:0 }` (via `*`) | every classless or `.a-*` `<button>` already resets itself ✓ (checked: `.a-frow/-rowlink/-shead/-tog/-showall/-dback/-member/-wfr`, `.a-axis/.a-look/.a-topn/.a-fchip/.a-tl/.a-ftab-v button`, `.badge-x`, `.menu-open/-close`) | ✓ |
| 13 | the `:focus-visible` box-shadow ring goes with styles.css | links, rail entries and `.a-*` buttons would fall back to the UA outline | **R** base `:focus-visible` rule |
| 14 | the `[data-slot]` counter-rules must go (app.css:130–175) | after P0 they have nothing to counter | **O** P0 |
| 15 | `code,kbd,samp,pre { font-family: mono; font-size:1em }` | `.code` (pre), `.code-inline`, `.md code` (0.92 em) and `.md pre code` all set size and family ✓ | ✓ |
| 16 | `img { display:block; max-width:100%; height:auto }` | one `<img>`: the TOTP QR (SettingsPage:483), already a flex item at 140×140 ✓ | ✓ |
| 17 | `svg { display:block; vertical-align:middle }` | 25 inline SVGs; every parent is `flex`/`inline-flex` (`.btn`, `.brand`, `.alert`, `.badge`, `.row-chevron`, `.a-search`, `.a-ceiling`, `.cb`, flex divs) ✓ | ✓ |
| 18 | `table { border-collapse:collapse; text-indent:0; border-color:inherit }` | `.table`, `.a-etab`, `.a-ftab` already collapse ✓ | ✓ |
| 19 | `html { -webkit-tap-highlight-color: transparent }` | phones lose the grey tap flash (not captured) | behaviour only; accept |

That is 19 hazards: **R** 8 (#1–3, 6–9, 13), **O** 5 (#4, 5, 10, 11, 14), **✓** 5 (#12, 15–18),
and 1 that changes behaviour only (#19). Before the flip, add one gallery state rendering **every markdown
construct**: lists (nested), ordered lists, blockquote, hr, a GFM table, a task list, a fence and
inline code. No fixture exercises them today, and the flip is the only change that touches them.

---

## 5 · Phases and ownership

Every phase ends with the same gate: `pnpm visual:compare` exits 0, **plus** the phase's named
extra, plus the owning agents' own test files by exit code. The orchestrator runs the full suite
alone, with no preview server up. A difference that is right gets a named entry, and the phases
below list the entries each is expected to need.

### P0 · Foundation (1 web agent + 1 server agent, sequential, blocks everything)

1. **Pass-1 accepted pairs: the owner decides** (§7.2). Recommended: re-shoot the pairs listed in
   `web/visual-accepted.json` (51 today, more after consent and login) from the SPA at pass 1's
   closing commit, and empty the file. Pass 2 then starts with zero accepted entries. Also shoot
   gallery baselines for states the server never had: the phone drawer open (no baseline today),
   the audit filters level, and the markdown-constructs state (§4).
2. **Layer the legacy sheet** (§7.1). Move `server/src/pages/styles.css` →
   `web/src/legacy.css`, `@import`ed from app.css with
   `@layer theme, base, legacy, utilities`, so every utility outranks every legacy rule and no
   counter-rule is needed.
   - Server side, all in one deploy: `web.ts:63,422` (import + route), `index.ts:156,449` (reserved
     segment + route table), `pages/spa.tsx` (`<link>`), `pages/model.ts:276`,
     `workers-env.d.ts:75`, and `web-pages.test.ts:2454`. That row is the cacheable-asset "twin":
     **port it to `/app.css`, don't delete it.** Also `spa-shell.test.ts:35`.
   - Web side: `vite.config.ts`'s `sharedStylesheet`, and `index.html:18`.
3. Add `@source not inline("table")`. Tailwind already emits `.table{display:table}` into the
   utilities layer (it is in `dist/app.css`), and once legacy is layered it would beat the narrow
   `.table{display:block}` and un-stack every phone table.
4. Delete app.css:130–175 (the counter-rules) and the 22 dead-now rules (§1.3).
5. Split app.css's audit block (217–1683) into `web/src/features/audit/audit.css`, imported by
   app.css, so the audit family owns a file rather than a line range.
6. Add a non-route `primitives` page to the gallery (`preview/mount.tsx`, `seed.ts`
   `PREVIEW_PAGES`, `fixtures.ts`) with one stub state per component. Add a crop-compare mode to
   `visual-compare.mts`: new column against old column, budget 0. `drawer-check.mts` already
   crop-compares with `clip:`.

**Gate:** zero diffs. Layering flips only `.table` (neutralised) and the counter-rules (no
consumers). The full suite runs because of the server rows. **Expected entries: none.**

### P1 · Theme, then primitives

- **P1a (1 agent, owns `app.css`):** the `@theme` of §3 (`--radius-md: 8px`, the text sizes and
  line heights, the colours, `shadow-pop`, containers, the base border colour), and folding the
  `:root` bridge into it. **Gate:** zero diffs, except `States.Skeleton` `rounded-md` 6 → 8 in
  loading states. Accept it, or give the skeleton `rounded-sm`.
- **P1b (4 agents in parallel):** each owns only `components/ui/<x>.tsx` and
  `preview/fixtures/primitives/<x>.tsx`. Each gallery state draws the legacy classes beside the new
  component in every variant × size × state: rest, focus, invalid, disabled, checked, and narrow at
  390.
  - **Actions:** Button, Badge.
  - **Fields:** Input, InputGroup, Label, Field, NativeSelect, Checkbox + Tick, Switch, RadioGroup
    (card + segment).
  - **Surfaces:** Card, Alert, Empty, Table, Skeleton.
  - **Overlays:** Dialog, Sheet, Tabs; delete Popover and Combobox.

  **Gate:** crop compare new = old at budget 0. **Expected entries** (primitives page only): the
  native checkbox → Checkbox, the native select arrow → chevron, the InputGroup `focus-within` ring,
  and Dialog sub-pixel centring. Also the focus-ring alpha if `/35` is not adopted.

### P2 · Chrome (2 agents in parallel, disjoint files, before any family)

These files are on every page, so they convert once, first.

- **P2a:** `chrome/Shell.tsx` (Sheet, nav, Badge `count`), `Confirm.tsx` (Dialog), `Notice.tsx` +
  `lib/format.ts` (Alert), `States.tsx`, `Reveal.tsx`, `OtpBoxes.tsx`, and
  `web/scripts/drawer-check.mts` (selects `.menu`, `.menu-open`, `.scrim`, `.menu-close`).
- **P2b:** new `chrome/Page.tsx` (page shapes, page head, workspace frame), new
  `chrome/AuthFrame.tsx` (`.auth`, brand, foot), `chrome/Kv.tsx` (moved from
  `features/agents/panes/Kv.tsx`, updating its importers in both detail families), new
  `chrome/Listing.tsx` (lh/gh/cr/save/details/dh/db/scroll/sum/via/more/tiles), and
  `chrome/Panes.tsx`.

**Gate:** all pages. **Expected entries:** none if P1 matched, but watch the 13 confirm states and
the drawer-open state.

### P3 · Families (10 agents in parallel, exclusive file ownership)

| Family | Owns | `className=` | Expected entries |
|---|---|---:|---|
| apps | `features/apps/**` (AppsPage, AppNewPage) | 119 | — |
| agents | `features/agents/{AgentsPage,AgentNewPage}.tsx` | 41 | `agent-new__*` ×4 (typeless → Input) |
| agent-detail | `features/agents/{AgentFrame,AgentDetailPage,AgentAppPage,AppGrantDetails,GrantRows}.tsx`, `features/agents/panes/**` | 337 | — |
| app-detail | `features/app-detail/**` | 421 | — (`.sw`/`.cb` must match exactly) |
| audit | `features/audit/**` + `audit.css`, `web/scripts/audit-search-check.mts` | 238 | search focus ring if any state focuses it |
| approvals | `features/approvals/**` (list + detail) | 73 | — |
| settings | `features/settings/**` | 164 | native checkbox (SettingsPage:306) |
| device | `features/device/**` | 36 | — |
| consent | `features/consent/**` | 27 | select arrow (NativeSelect) |
| login | `features/login/**` | 30 | — (autofocused inputs must match exactly) |

**Shared and read-only in P3:** `components/ui/*`, `chrome/*`, `lib/*`, `app.css`, `legacy.css`. A
family that needs a primitive changed sends it back to the P1 owner; the orchestrator sequences it.

**The one cross-family import:** app-detail's AccessPane and RolesPane render agent-detail's
`GrantGroup` (`features/agents/GrantRows.tsx`). Agent-detail owns the file, app-detail must not
edit it, and agent-detail's gate must include app-detail's `roles*` and `access*` states.

**No family edits `legacy.css`.** A rule shared by 20 files cannot be deleted by the first family
to stop using it, and ten agents editing one 3,233-line file will conflict. Unused legacy rules
match nothing and are harmless until P5.

### P4 · Preflight flip (1 agent, all families frozen)

Import `tailwindcss/preflight.css` into `layer(base)`, and delete app.css's border reset and
`input:not([type])`. Add the §4 restorations: base `body/a/h1–h3/:focus-visible/::placeholder`,
the `* {border-color}` base, and the `.md` lists, blockquote, hr, table and task-list rules.

**Precondition:** Confirm is a Dialog, AgentNewPage uses Input, and both selects are NativeSelect.
**Gate:** all pages + the markdown-constructs state. **Expected entries: none.**

### P5 · Delete `legacy.css` (1 agent)

A script extracts every class selector in `legacy.css` and greps `web/src`; it must print nothing.
Move the `.md` sheet and the base rules into app.css if P4 did not already, then delete the file
and `--space-*` once no inline `var(--space-…)` remains.

**Gate:** all pages + full suite. **Expected entries: none.** If P0 did not move the sheet, the
server list in P0 step 2 lands here instead.

**Parallelism:** 1 → 1 → 4 → 2 → 10 → 1 → 1.

---

## 6 · Size

**Today.** Two stylesheets, 4,916 lines. The browser downloads styles.css (82.2 KB / 20.4 KB gz)
plus `dist/app.css` (73.1 KB / 12.4 KB gz), **155 KB / 32.8 KB gz in two requests**.
`components/ui` is 1,261 lines, none of them imported. The TSX class surface is 1,538 `className=`
expressions in 44 files, 40 inline style props and 3 class-string constants (`lib/format.ts`).

**Forecast after P5** (estimates; the basis is given for each):

| | Now | After | Δ |
|---|---:|---:|---:|
| styles.css / legacy.css | 3,233 | 0 | −3,233 |
| app.css (header, bridge, counter-rules, drawer) | 216 | about 250 (`@theme` about 110, base about 40, `.md` about 60, imports and layers about 20) | +35 |
| audit rules (app.css 217–1683 → `audit.css`) | 1,467 | about 0–150 of residue (pseudo-elements, hatch gradients, grid areas, the phone table-to-card reorder) | about −1,350 |
| `components/ui` | 1,261 | about 1,820 (+9 components ≈ 950; −popover −combobox 386; −textarea 17) | about +560 |
| new chrome (Page, AuthFrame, Listing, Kv) | 12 (Kv) | about 450 | about +440 |
| page TSX | — | utility strings run 2–3× the length of today's class names across about 900 non-component sites | about +1,500 to +2,500 |
| shipped CSS | 155 KB / 32.8 KB gz, 2 requests | about 55–75 KB / 11–14 KB gz, 1 request. Utilities are emitted once and shared; the 82 KB legacy sheet and about 45 KB of audit source collapse. | about −60 % gz |

The net is about **−4,500 CSS lines** and **+2,500 to +3,500 TSX lines**. One behaviour change
comes with it: sizes become `rem`, so a user's larger default font now scales the controls. Today
it does not.

---

## 7 · Decisions the brief should settle

### 7.1 Layer the legacy sheet at the start, or keep serving it to the end

**Context.** styles.css is linked unlayered, so every rule in it outranks every Tailwind utility.
That is why app.css carries counter-rules. Those counter-rules also neutralise the primitives: the
Input's height, padding and border, and every `ring-*` focus ring. `input[type=…]` (0,1,1) out-ranks
even them. Each primitive swapped in while the sheet is unlayered needs its own counter-rule
against `a`, `:focus-visible`, `input[type]`, `select`, `textarea` and `[aria-invalid] !important`.

| Option | Pros | Cons |
|---|---|---|
| **Move it into `web/src` and import it `layer(legacy)` in P0** | Utilities win by construction, so no counter-rules. The server's part of deleting the sheet happens up front, in one deploy, instead of at the end. One request instead of two. The final deletion becomes web-only. | It touches spa-server's files, 2 test rows and the gallery plumbing at the very start. It needs the `table` utility block (§5 P0.3). Layered `!important` inverts precedence: `[aria-invalid]` and `.wide-only` would then beat utilities' `!` too. That is harmless today, but it is a trap. |
| **Keep linking `/styles.css` unlayered until P5** (status quo) | No server change until the end, and the pass-1 wiring stays as shipped. | Every swap fights the base rules. app.css grows counter-rules scoped by `data-slot` that must all be deleted again. The first `<Input>` renders borderless until someone writes one. The gate cannot tell "component wrong" from "cascade wrong". |

**Recommendation: layer it in P0.** The deciding consideration is that pass 2's gate only means
something if a swapped component renders as its own classes say. Unlayered, it renders as its own
classes minus whatever styles.css and the counter-rules take away.

What would flip this: the owner wanting pass 2 to ship no server change at all before its last
step. The ownership of the server deploy at P0 is the orchestrator's call. It is easily reversed:
moving the `@import` back to a `<link>` restores today's order.

### 7.2 What "the same baselines" means for the 51 accepted pairs

**Context.** `visual-compare` passes an accepted pair at **any** ratio (visual-compare.mts:109–120).
51 pairs (agent-detail, app-detail, app-new …) are accepted because the server fixture was wrong
and React is right, and consent and login will add more. Under pass 2 those pairs are **ungated**.
A broken badge on the app-detail page at 390 would pass. The server preview that shot the
baselines retires with pass 1, so the baselines can no longer be re-shot from the server.

| Option | Pros | Cons |
|---|---|---|
| **Re-shoot only the accepted pairs from the SPA at pass 1's last commit, then empty `visual-accepted.json`** | Every pair gates pass 2. The accepted reasons already say the SPA render is the truth. Pass 2's accepted list then holds only pass-2 differences, which is what a reviewer needs. | The literal "same baselines" changes for 51+ files, so it needs the owner's nod. Re-shooting from the SPA trusts pass 1's render, which the accepted reasons vouch for pair by pair. |
| **Keep every baseline and the accepted list as is** (status quo) | Literally what decision 38 says. No new captures. | 51 of the 374 pairs (14 %) cannot fail in pass 2, and more once consent and login land. The accepted list mixes pass-1 fixture artefacts with pass-2 look changes. |
| **Add a second, pass-2 accepted file keyed by pair *and* ratio ceiling** | Keeps the baselines and gates the accepted pairs loosely. | A new mechanism, and a ratio ceiling is exactly the "loosened threshold" the brief forbids. |

**Recommendation: re-shoot the accepted pairs from the SPA.** The deciding consideration is that
a gate that passes a pair at any ratio is not a gate for that pair. This one is **the owner's
judgement**: it amends decision 38's wording. It is reversible, since the old PNGs are in git.

### 7.3 Current look against the density ladder, where they disagree

The brief says "themed to the CURRENT look **and** the density ladder". Today's look breaks the
ladder in these places:

- Framed rail entries are 28 px (the ladder's rows are 32/40/44).
- `.badge--xs` is 16 px / 10 px (the ladder allows one badge at 20/11, nothing below 11).
- `.nav-badge` is 18 px.
- `.code-chip` is 28 px.
- The OTP boxes are 44×48 and 48×52.
- The level header is 48 px.
- Narrow titles are 20 px (`.page-title`, `.auth-title`, `.auth .card-title`); 20 is not on the
  type scale.

Since the gate is the baselines, **the look wins in pass 2**: these become named theme values or
arbitrary values. Any move onto the ladder is its own later change with its own accepted entries.
Recommend the brief say so in one line. The alternative, fixing them inside pass 2, turns 60-odd
pairs into accepted entries for reasons that have nothing to do with the library. Owner's call
only if they want the ladder fixes bundled in.

---

## 8 · What the code makes impossible or unwise in decision 38 and the brief

1. **"Swap the hand-written primitives for the generated components" cannot work as generated.**
   §2 lists every disagreement that would show in a screenshot, and the brief should treat the 12
   files as *templates to edit*, not drop-ins. The biggest: badges become
   pills; `rounded-md` is 6, not 8; default-button text is 13, not 14; Input is 13 px on desktop
   with a darker placeholder; Table cells are nowrap with 8 px padding and currentColor borders;
   the Dialog is 448 wide with a blur overlay and a ✕; Tabs are 29 px triggers in a 12 px-radius
   list; the primary button has a 1 px rim.

2. **app.css's coexistence rules break the primitives, not just styles.css.** `[data-slot="input"]`
   (app.css:156) zeroes Input's height, padding, border and width. `[data-slot]:focus-visible
   {box-shadow:none}` erases every `ring-*` focus ring, because Tailwind rings *are* box-shadows.
   `[data-slot=*-content] {box-shadow}` removes the Dialog's and Popover's `ring-1` edge. They have
   never shown because nothing imports a generated component. They also reach Shell's drawer,
   which sets `data-slot="dialog-content"` by hand.

3. **The shadcn base layer is missing.** Without `* { border-color: var(--color-border) }`, every
   uncoloured `border` in a generated component is currentColor under Tailwind v4.

4. **The gate is weaker than "pass/fail" suggests, in three ways.**
   - The 51+ accepted pairs pass at any ratio (§7.2).
   - The 2 % per-pair budget absorbs component-level changes, such as a radius or a placeholder
     colour on a few elements of a full-page screenshot. Height changes cascade and are caught.
   - Only rest states are captured, except where focus is programmatic (login and OTP autofocus,
     Dialog initial focus). Hover, open popups and keyboard focus rings are unguarded.

   The primitives gallery with a crop compare at budget 0 (P0.6, P1b) is where component fidelity
   is actually gated. The brief should name it as the component gate.

5. **Current look against the ladder:** §7.3. The brief asks for both, and the code has at least
   7 places where it cannot have both.

6. **"styles.css deleted" is a server change and a test port, not a web deletion.** `/styles.css`
   is a route (`web.ts:422`), a reserved segment (`index.ts:156`), a link in every shell
   (`spa.tsx`), a path constant (`model.ts:276`), a TEXT-module declaration
   (`workers-env.d.ts:75`), and a `web-pages.test.ts` row (about line 2454) that proves the
   shell's assets stay cacheable. That row must be ported to `/app.css` (brief §1 rule 3). The
   pass-2 ownership needs a server agent at P0 or P5.

7. **"styles.css deleted" does not mean no global CSS.** The `.md` prose sheet must stay, and must
   grow under preflight. So must five base rules (§1.4). Deleted means *moved into app.css*.

8. **Tailwind's `table` utility collides with the `.table` class.** It is harmless only while
   styles.css is unlayered (§5 P0.3).

9. **Two of the suggested components are the wrong primitive.** The Settings segmented control is
   URL navigation, so Tabs or ToggleGroup roles would misdescribe it. `.seg` is a radio group, so
   ToggleGroup would change its semantics. And the Base UI Select on the consent page, a form POST
   the brief keeps, would replace the OS picker; `native-select` keeps it (§2.6).

10. **Scripts select by the classes pass 2 removes.** `drawer-check.mts` (`.menu`, `.menu-open`,
    `.scrim`, `.menu-close`) and `audit-search-check.mts` (`.a-ev`, `.a-skel`, `.a-main`,
    `.a-fbar .btn`, `.a-views button`, `.a-rail .a-railnote`, `.a-more .note`) must move to roles,
    labels or `data-slot` in the phase that converts their page.
