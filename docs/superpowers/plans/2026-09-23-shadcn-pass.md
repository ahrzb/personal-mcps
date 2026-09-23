# Pass 2 — every page is shadcn — the dispatch brief (2026-09-23)

Decision 38's second pass. Pass 1 shipped whole (`d815c18`, deploy `b73374fd`): every page is the
SPA, looking exactly as the server drew it. The owner: "start pass 2 right after login ships."

**The design is `2026-09-23-shadcn-inventory.md`** — every rule of both sheets with its fate
(§1), what each of the 12 generated components must change to hold today's look (§2), the token
map (§3), the preflight hazards (§4), the phases and file ownership (§5), and the size forecast
(§6). It is accepted as written, with the rulings below. Everything here is decided; an agent that
finds a contradiction with the code stops and reports it.

## 1 · Rulings on the inventory's §7 and §8

1. **The legacy sheet is layered in P0** (§7.1, orchestrator's call): `server/src/pages/styles.css`
   moves to `web/src/legacy.css`, imported by app.css under
   `@layer theme, base, legacy, utilities`, so every utility outranks every legacy rule and no
   counter-rule is ever written. The server half (the `/styles.css` route, its reserved segment,
   the shell's `<link>`, the path constant, the env type, the ported test rows) ships in the SAME
   deploy as the web half. `/styles.css` then answers 404 like any unclaimed path.
2. **The pass-1 accepted pairs are re-shot from the SPA at `d815c18` and `web/visual-accepted.json`
   is emptied** (§7.2). The owner chose screenshots as the gate because "it's more testable"; a
   pair that passes at any ratio is not tested, and every one of those pairs is on the list
   because the SPA render was judged right and the server fixture wrong. The old PNGs stay in git.
   Pass 2 starts with zero accepted entries, so every entry it adds is a pass-2 difference a
   reviewer can read. (Recorded as a decision-38 amendment; reversible.)
3. **The look wins over the density ladder** (§7.3): the seven places today's look breaks
   `design/layout-and-density.md` become named theme values or arbitrary values, not ladder
   fixes. Moving onto the ladder is its own later change.
4. **The generated components are templates to edit, not drop-ins** (§8.1): each is changed to
   draw today's look (radius 8, text 14, badge shape, border colour, line heights — §2), in its
   own file, proven on the primitives gallery page at budget 0 before any page uses it.
5. **Semantics over resemblance** (§8.6): the settings segmented control stays links, `.seg` is a
   RadioGroup, and both selects are NativeSelect (the phone keeps its native picker).
6. **Gate, every phase:** `pnpm visual:compare` exit 0 with the phase's expected entries only
   (inventory §5 lists them per phase), every 390 PNG exactly 390 wide, `pnpm check:drawer` and
   `pnpm check:audit-search` exit 0 (both select by classes pass 2 renames — their owners update
   the selectors), the owners' test files by exit code; the orchestrator runs the full suite alone
   in the gate worktree, commits by path, and ships. **One ship per phase**, and per family in P3.

## 2 · Phases (inventory §5), agents, ownership

| Phase | Agents (model) | Owns | Runs |
|---|---|---|---|
| P0 foundation | `p2-foundation` (Opus), `spa-server` (Opus) for the server half | P0 steps 1–6; server: the `/styles.css` retirement | first, alone |
| P1a theme | `p2-foundation` | `app.css` `@theme` | after P0 ships |
| P1b primitives | 4 × Opus: actions, fields, surfaces, overlays | `components/ui/<x>.tsx` + `preview/fixtures/primitives/<x>.tsx` | parallel, after P1a |
| P2 chrome | 2 × Opus | inventory §5 P2a / P2b files | parallel, after P1b |
| P3 families | 10 agents (Sonnet for device, consent, login, approvals; Opus for the rest) | inventory §5's table, exclusive | parallel, after P2 |
| P4 preflight | 1 × Opus | app.css base + `.md` restorations | after every family |
| P5 delete legacy | 1 × Sonnet | `legacy.css` removal, the class-grep proof | last |

Shared and read-only during P3: `components/ui/*`, `chrome/*`, `lib/*`, `app.css`, `legacy.css`. A
family that needs a primitive changed sends it back; the orchestrator sequences it. No family
edits `legacy.css` (unused rules are harmless until P5). `GrantRows.tsx` is agent-detail's; its
gate includes app-detail's `roles*` and `access*` states.

Same standing rules as pass 1: no agent commits, runs a git write command or runs the full suite;
each stops every server it starts; checks are reported by exit code, never through a filter; an
agent that has been summarized checks its own transcript before believing in a second writer.
