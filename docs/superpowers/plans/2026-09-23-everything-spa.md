# Every page is the SPA, then every page is shadcn — the dispatch brief (2026-09-23)

The owner asked for "a proper migration to shadcn + Base UI + Tailwind", chose to keep the
current look with screenshots as the gate ("A is wiser, as it's more testable"), then asked
"can we make all and everything into a SPA?" and chose **everything, in two passes**:

- **Pass 1 — one rendering.** The six server-rendered pages — `/login`, `/device`,
  `/settings/*`, `/approvals`, `/approvals/<id>`, `/oauth/consent` — become SPA routes that
  LOOK EXACTLY AS THEY DO TODAY. Gate: `pnpm visual:compare` against baselines captured from
  today's server rendering.
- **Pass 2 — one component library.** Only after pass 1 has fully shipped: the hand-written
  primitives become the shadcn components in `web/src/components/ui/`, themed to the current
  tokens and the density ladder (`design/layout-and-density.md`), page family by page family,
  gated by the SAME baselines. Ends with Tailwind's preflight on and `styles.css` deleted.
  Pass 2 gets its own brief when pass 1 is done; nothing below is about it.

Each pass changes one variable while the look is held constant, which is what makes a
screenshot a pass/fail gate rather than an opinion.

Everything here is decided. An agent that finds a contradiction between this brief and the
code stops and reports it.

## 1 · Pass 1's rules

1. **Nothing looks different.** Every migrated page's gallery states pair with a server
   baseline and pass `visual:compare`. A difference that is right (e.g. a focus ring a Base UI
   primitive draws) is named in `web/visual-accepted.json` with a one-line reason — never a
   loosened threshold. Every phone PNG is exactly the viewport's width.
2. **Every URL stays.** The six GET URLs, their query parameters and every deep link into
   them keep working: `/approvals/<id>` is in every `-32003`'s `data.approvalUrl` and in push
   notifications; `/device?user_code=…` is printed by the CLI; `/login?<signed>` and
   `/oauth/consent?<signed>` are better-auth's own redirects; `/settings/<pane>` is linked from
   the other pages. The worker serves the SPA shell at each.
3. **The server stays the authority.** Every check a server-rendered handler performs today —
   session, owner, same-origin, CSRF, the relative-only return-path rule on `/login`, the
   binding of a consent decision to its signed authorization request, the device `user_code`
   checks, the audit rows the auth wrappers write (§15's two auth events), the notices a
   refusal lands with — survives at the JSON route that replaces it. The row in
   `web-pages.test.ts` that pins it today is PORTED to that route, not deleted: tests are the
   precise spec, and a check that loses its row is a check nobody will notice losing.
4. **The pages that decide trust are reviewed hardest.** Consent (§19.5, decision 24) and
   device (RFC 8628, §7) gain JSON reads for the first time: each read requires the owner's
   session and is bound to the signed request / the user code — it answers nothing to anyone
   else and nothing beyond what the page shows today. Untrusted client strings stay text.
   Every anti-framing header the server pages send today is sent on the shell at those URLs.
5. **What is given up, by the owner's choice:** the pages no longer work with scripting off.
   `/login` loads the SPA bundle. *ponytail: one bundle for now; a separate login entry if the
   login page's weight is ever measured to matter.*
6. **Old form endpoints go when nothing posts to them.** A form-POST route is deleted in the
   same change that moves its last page, unless something outside the web surface calls it
   (the spec agent's inventory says which).
7. **The server-rendered preview retires page by page.** Every fixture in
   `server/dev/fixtures.ts` becomes a React gallery state with the SAME page and state names
   (`/__preview/<page>/<state>` ↔ `/preview/<page>/<fixture>`), so `visual:compare` pairs them.
   When the last page leaves, `server/dev/preview.ts`, `server/dev/fixtures.ts`,
   `wrangler.preview.jsonc`, `server/src/pages/{layout,login,device,settings,approvals,
   approval-detail,consent}.tsx` and their `model.ts` props go. `styles.css` STAYS — the SPA
   reads it until pass 2.

## 2 · Order

1. **Baselines first** (`spa-baselines`), before anything changes: every page × fixture of
   the server preview at 1280×900 and 390×844 into `design/baseline/<page>__<fixture>__<w>x<h>.png`,
   with a committed script so they can be re-shot. These are the reference for the whole
   project.
2. **Spec** (`spa-specs`), concurrently: decision 38 and the route design (§4 below). The
   orchestrator reviews it before any code starts.
3. **Families, one ship each**, easiest and least availability-critical first:
   **approvals + approval detail → settings → device → consent → login**. Login is last because
   every other page stands behind it. Per family: server routes + ported tests (`spa-server`) ∥
   the SPA page + gallery states (`spa-web`), then the orchestrator's visual gate, full gate,
   commits (spec → test → feat) and `pnpm ship`.

## 3 · Ownership

| Agent | Model | Owns |
|---|---|---|
| `spa-baselines` | Sonnet | `design/baseline/` (new server-page PNGs only), `web/scripts/` (the capture script) |
| `spa-specs` | Opus | `docs/specs/**` |
| `spa-server` | Opus | `server/**`, `cli/**`, `contracts/**`, `scripts/smoke.ts` |
| `spa-web` | Opus | `web/**`, `design/baseline/**` from the first family on, `web/visual-accepted.json` |
| orchestrator | — | this brief, `test-inventory.json`, root `package.json`, `.claude/launch.json`, commits, gates, ships |

No agent commits, runs a git write command, or runs the full suite; each runs the files it
touches, stops every server it starts, and reports checks by EXIT CODE, never through a
filter. Every agent has been or will be summarized: before believing "someone else edited my
file", check your own transcript.

## 4 · What the spec agent designs (reviewed before code)

For each of the six pages, a table: every route it has today (GET and POST, file:line), what
the handler checks, what it reads, what it writes (incl. audit rows and redirects/notices),
who else calls it (better-auth redirects, the CLI, push, the smoke, external clients) — and
the route that replaces it: path, method, request and response shapes (TypeScript), the
checks it keeps, and the tests from `web-pages.test.ts` / `oauth-provider.test.ts` /
`admin-ops.test.ts` / `contracts.test.ts` that move onto it. Prefer what exists: `/api/hub/*`
routes and `/api/hub/ops/<op>` already carry the cookie session, the same-origin check and
`X-Pmcp-Csrf`; better-auth's own JSON endpoints where the hub wrapper adds nothing. Then:
decision 38 (withdrawing decision 21's remaining "stay server-rendered" half; what is given
up), §13's "Two renderings, one design language" becoming one, §16 / testing/03 for the moved
rows and the retired preview, §17 for the files that go.
