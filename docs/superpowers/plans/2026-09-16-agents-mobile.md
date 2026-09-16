# The agent page on a phone — the dispatch brief (2026-09-16, second track)

The owner approved the phone rendering on 2026-09-16 (`design/MobileAgentDetail`,
`MobileAgentDetailStates`; the clickable reference is `design/concepts/AgentMobileDemo.html`;
`design/README.md` § "Agents, redrawn as three panes" records the decisions). This track
lands after the desktop pages shipped. Everything here is decided; contradictions with a
board follow the brief and are reported.

Two things change, one of them shell-wide:

## 1 · The narrow shell: brand + hamburger + sidebar (every page)

Under the existing 900 px breakpoint the top bar is the brand mark and name on the left
and a **hamburger** button on the right. The hamburger opens a **sidebar** that slides in
from the right (the hamburger's own side) over a scrim: at its top the brand and a close
button at the same corner the hamburger occupied; then the five nav entries (Apps, Agents,
Audit, Approvals with its pending count as a pill, Settings), the current one marked
`aria-current="page"`; at the foot the username and the Sign out form. Tapping the scrim
or the close button closes it. This replaces §13's horizontally scrolling five-entry nav
on narrow screens; the wide shell is unchanged.

**No script.** The sidebar is `:target`-driven: the hamburger is `<a href="#menu"
class="menu-open" aria-label="Menu">`, the sidebar is `<nav id="menu" class="menu">`, the
close control `<a href="#" aria-label="Close menu">`, the scrim `<a href="#" class="scrim"
aria-hidden="true">`; CSS shows the menu and scrim when `#menu:target`. A wide viewport
never shows the hamburger, the menu or the scrim (`display: none` above the breakpoint).
The wide nav markup stays in the document and is hidden below the breakpoint, so
`aria-current` is tested once on either.

`layout.tsx` owns this (the shell); `styles.css` the rules. Every page inherits it.

## 2 · The agent page as three levels (narrow only)

Wide: unchanged, three panes. Narrow: one level visible at a time, chosen from the URL
by the server and applied by CSS, so scripting off works and nothing is decided twice:

| URL | level | what shows |
|---|---|---|
| `/agents/<slug>` (the landing) | 1 | the header (title line "Agents › <slug>", description, tiles) and the **rail as a list** — every entry a full-width row with its marker and a trailing chevron |
| `/agents/<slug>/apps/<app>`, `/grant`, `/credentials`, `/activity`, `/danger` without `sel` | 2 | the **listing** alone (header + groups + foot) |
| the same with `sel=` | 3 | the **details** alone |

The page root carries `data-level="1|2|3"`; the narrow stylesheet shows one of `.rail`,
`.listing`, `.details` by that attribute and the wide one ignores it. On wide screens
the landing still renders the first app pane (unchanged) — the attribute only matters
below the breakpoint, where the landing's listing is hidden and the rail is the screen.

**The level header**, rendered on every pane and shown only below the breakpoint, above
the content: a **back link** on the left naming the level above and the current thing
centred:

| level | back link | title |
|---|---|---|
| 1 | `‹ Agents` → `/agents` | the slug |
| 2 | `‹ <slug>` → `/agents/<slug>` | the app's name, or `Grant another app` / `Credentials` / `Activity` / `Danger zone` |
| 3 | `‹ <app name or pane name>` → the pane URL without `sel` (keeping `q`, `show`, `calls`) | the selected row's name |

Below the breakpoint the wide title line and the rail's `aria-label`ed nav are hidden
(the level header replaces them); the pill row (`PanePills`) is **removed** from the agent
page — the rail-as-list is its replacement. Other paned pages keep their pill row.

**Listing header on a phone.** The listing header never repeats what the level header
shows: below the breakpoint the app pane's name is hidden (slug, kind and status badges,
the reach line and the filter stay), and the Credentials / Activity / Grant / Danger
titles are hidden (their subtitles stay). The Activity pane's "Open in Audit" button
drops under the subtitle on its own line.

**The foot** (Remove from <agent> · Discard · Save) stays one row, Save at the right
edge; the change count is script-only and absent.

**Rows and controls** are the desktop's, unchanged: the none · ask · allow radios at the
right edge; on a phone the "via <roles>" text sits above the control (`display:block`),
and the details pane's key/value pairs stack (key above value).

**Tapping a row** on a phone = the row's existing `?sel=` link (level 3). Tapping a rail
entry = its existing link (level 2). Nothing new is linked; only what shows changes.

**Grant another app** on a phone: cards one column, the Grant button full width beneath
the description. **Activity** paging is unchanged (links).

## 3 · What §13 says afterwards

- *Panes behind a rail*: the narrow rule for `/agents/<slug>` is the three levels (the
  pill row stays the rule for `/settings` and `/apps/<slug>`).
- The shell paragraph on the narrow nav: brand + hamburger + sidebar, `:target`-driven,
  the strings above.
- The `/agents/<slug>` bullet: the level table and the header table above.

## 4 · Ownership

| Agent | Owns | Must not touch |
|---|---|---|
| spec | `docs/specs/web-and-oauth/13-web-surface.md`, decision log (append to 31, no new number) | code, tests, design |
| pages | `server/src/pages/layout.tsx`, `server/src/pages/agent-detail.tsx`, `server/src/pages/styles.css`, `server/src/pages/model.ts` (level + back link fields only), `server/dev/fixtures.ts`, `server/dev/preview.ts` | the test file, registry/admin/web.ts |
| web tests | `server/test/worker/web-pages.test.ts` (the shell describe for the sidebar; the agents describe for levels) | everything else |

Tests pin markup, not CSS: the sidebar's elements and `aria-current` on every shell page;
`data-level` per URL; the level header's back link href and text per level; the absent
pill row on the agent page. Each agent runs only its own files; the full suite is the
orchestrator's gate.

Your context may be summarized mid-run. If a file contains unexpected work converging with
your plans, it is almost certainly your own — disk is truth: re-read and integrate, grep
for existing helpers before writing new ones, and never stop to wait on a collaborator.
Record nothing about "another writer" in your report.
