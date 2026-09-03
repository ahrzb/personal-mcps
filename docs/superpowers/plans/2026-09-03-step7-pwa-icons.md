# Step 7 — PWA icons: G6 (inline fix)

> Roadmap step 7 (`2026-09-02-roadmap-after-d15.md` § Step 7; register row G6 at `:361`) holds the goal,
> the shape and the DoD; none of that is restated. Evidence read 2026-09-03: `web.ts:648-675` (`icons:
> []` at `:664`), `:1300-1302`, `:1304+`; `model.ts:237-245`; `layout.tsx:32-38`, `:47-55`, `:233-244`;
> `index.ts:115-130`, `:141`, `:368-385`, `:527`; `identity.ts:409-419`; `routes.test.ts:72-90`,
> `:122-140`, `:195-221`; `web-pages.test.ts:33-34`, `:890`; `preview.ts:16-18`; `02-concepts.md:6-16`.

## Settled

**Format: two PNGs in `icons`, no SVG anywhere.** Chromium's criterion is px-shaped and both Google-owned sources
still say a 192×192 and a 512×512 (web.dev/articles/install-criteria; developer.chrome.com installable-manifest, which
now banners "PWA testing in Lighthouse is deprecated" — Lighthouse is never the gate below, only a note on what it
audits). `sizes: "any"` is **forbidden in writing**: the spelling MDN documents for scalable SVG is the one that makes
Android WebAPK install fail outright (chromium issue 40925759). No SVG icon route either: an SVG favicon is a seventh
copy of `BrandMark`'s geometry, and each entry must declare its own bytes' size — one file under two sizes makes 3b,
the one observation grading this step, a coin flip. **The icons are the whole remaining gap:** the only other
criterion this shell could fail, a service worker with a fetch handler (`web.ts:670-673` refuses one — the no-SPA
pin), stopped being one in Chrome 108 mobile / 112 desktop (chrome blog, update-install-criteria).

**Packaging: two base64 constants in a new `server/src/pages/icon.ts`.** Reject the `assets` binding: it puts a
static-asset router in FRONT of the worker, the one option that can move routing semantics under §2's claim model,
`RESERVED_ROUTES`'s derivation and §16's walk. Reject a `{"type":"Data"}` module rule over a committed `.png`: Vite
resolves asset imports to URL strings (`workers-env.d.ts:70-81` records the `.css` case — the import comes back `""`,
so the suite renders unstyled), so the bytes under test would not be the bytes in production, testing §9's whole
reason to exist. base64 in a `.ts` is byte-identical in both runtimes and is the `SERVICE_WORKER` precedent two lines
from where the route goes; its own file keeps two multi-KB literals out of the file step 5 also edits. Shape:
`bytes(b64)` = `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))`, `ICON_192`/`ICON_512` decoded at module scope;
`web.ts` gains `const PNG = { "Content-Type": "image/png" } as const;` and two routes.

**The bytes come from `scripts/icon.mjs`** (amended by the orchestrator 2026-09-03): a dependency-free signed-distance
rasterizer over `BrandMark`'s four strokes, 8×8 supersampled, written as an RGB PNG through `node:zlib` — deterministic,
so `node scripts/icon.mjs` reproduces the embedded bytes exactly (192 → 1 520 bytes, 512 → 5 332 bytes). The browser
recipe below was tried first and its 192 came through intact, but a 512 px PNG's base64 is 18 K characters and one
transcription slip on the way from the pane to the file broke an IDAT chunk's CRC — the "fallback ≈ 40 `node:zlib`
lines" this paragraph named is the path, and the script is the provenance instead of a pasted recipe. Rows and smoke
are unchanged: they read the bytes, not their origin. The recipe, kept as the record of what was tried: `about:blank` → canvas N×N → fill `#ffffff` full-bleed → `drawImage` at
`0.1N, 0.1N, 0.8N, 0.8N` of an `Image` whose src is `"data:image/svg+xml," + encodeURIComponent(doc)` →
`toDataURL("image/png").split(",")[1]`. `doc` is a **standalone** SVG document, not the JSX: `BrandMark`'s four
children under `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24" fill="none"
stroke="#09090b" stroke-width="2" stroke-linecap="round">` — the namespace because a standalone `data:` SVG parses as
XML and one without it fails to load *silently* (blank canvas, still-valid base64); the intrinsic size because Chrome
needs it on an SVG image; the literal colour because `currentColor` has nothing to inherit from; `encodeURIComponent`
because a bare `#` ends the URL at the fragment. Two render-time checks make that silent failure loud: `await
img.decode()` before `drawImage`, and a byte floor on each pasted base64 (blank 512 ≈ 1 KB, drawn several KB). Recipe
and source (`layout.tsx:47-55`; ground `--bg`, stroke `--fg`) go verbatim into `icon.ts`'s provenance comment;
fallback ≈ 40 `node:zlib` lines.

**`purpose: "maskable"`: no, and never `"any maskable"`.** One reason, and it is the gate: `purpose` is not part of
the installability check. Omitted entirely (Chromium defaults to `any`, what iOS's fallback wants). A declaration
decision, not an art one — the 80 % inset already puts the mark's farthest point (the (18.5,18.5) spoke end plus its
1-unit round cap, ≈10.19 of 12 viewBox units) at ≈0.34N from the icon centre, inside the 0.4N safe radius. `ponytail:`
ceiling: Android adaptive icons get the launcher's backing, not an edge-to-edge mark; upgrade = a second entry on the
**same** 512 bytes. **Cache headers: none** either — no shell asset sets any (`:666`, `:673`, `:675` set Content-Type
and stop), and a year-long `immutable` on an unversioned `/icon-512.png` would make the icon the one un-bustable
asset.

**URLs and the coupled edits.** Two dotted top-level files, `/icon-192.png` and `/icon-512.png`, in `paths` as
`icon192` / `icon512` beside the shell trio (`model.ts:237-245`); the dot keeps both out of `USERNAME_CHARSET`, as
`manifest.webmanifest` already is. Each costs a `ROUTES` row (`index.ts:115-130`) and a `browser` `MOUNTS` row
(`:368-385` — omitting it is a compile error, `MOUNTS` being a `Record<ServedSegment, Mount>`). **Row 1 is what forces
that pair** — without it the routes are unreachable and row 1's `worker.fetch` gets the anonymous 404.
`routes.test.ts` catches nothing here and needs no edit: a segment `ROUTES` omits is claimed by no mount, so
`/icon-192.png` and POST `/icon-192.png/mcp` (charset-refused at `:527`) return the *same* `anonymousNotFound()`
bytes, `probeSegment` (`:72-90`) calls it "not-found", and cases 1 and 2 (`:202`, `:208`) stay green. With the pair,
the walk picks both up unaided (`:128-140`); no probe-path entry. Only the shell head is edited: a fourth local
constant, `const ICON = "/icon-192.png";` beside `layout.tsx:32-38`, plus `rel="icon"` and `rel="apple-touch-icon"` by
the manifest link — the second because iOS prefers it over any manifest entry and costs one line. The five own-head
page files (`preview.ts:16-18`) — `/login`, `/device`, `/oauth/consent`, `/apps/new`, `/approvals/<id>` — keep
icon-less heads; one `/favicon.ico` route would cover all five with no head edit. Three counts go stale and are fixed
in the same commit: `layout.tsx:32-34`'s "three asset URLs … that `paths` does not name" (`paths` names all three
today) → the four the shell *links* rather than navigates to; `model.ts:239-240`'s "the same three URLs" → five named
there, four spelled by the shell; and `index.ts:372-373`'s "eight … four", already wrong (nine browser rows, five
machine) → eleven/five.

**One spec edit, one smoke leg.** §2's reserved list enumerates the shell assets by name (`02-concepts.md:6-16`) and
this step makes them five, so that sentence takes the dated amendment `styles.css` and `.well-known` already carry —
in the `fix:` commit, where it becomes true (`13-web-surface.md:364-366`'s installability promise needs nothing). The
smoke leg is one `step(…)` in `scripts/smoke.ts`: `GET /icon-512.png` → 200, `image/png`, PNG signature, IHDR width
512 — the rows run under Vite and the packaging argument above is about exactly that divergence, and a browser that
finds no icon shows no affordance, the ambiguity 3b would otherwise open DevTools to resolve. Not touched:
`wrangler.jsonc`, fixtures, `BrandMark` factoring.

## Rows

Three `it.todo` rows in one new describe in `web-pages.test.ts`, `§13 · the PWA icons — the install gate's own bytes`,
in a `test:` commit before the fix. Unnumbered, like the file's newer describes (`:1209`, `:990`), placed after the closing `});` of the numbered `§15 · the two auth events the ledger records` describe (its title at `:1500`; `:1517` is inside row 30's body, not a describe) and before `§19.5 · the consent screen` — after the
`§15` describe so no row renumbers:

1. `§13 · every icons[] src the manifest lists answers 200 through worker.fetch with no cookie, Content-Type image/png, and a body whose PNG signature and IHDR width are the size its entry declares — so a constant pasted under the wrong entry, or a bundler handing back a path string where bytes belong, reddens here — while /icon-256.png, a spelling ROUTES does not serve, is no segment at all and comes back on the hub's one anonymous 404 (the twin)`
2. `§13 · the icons array carries exactly the pair §13's install gate is built around, 192x192 and 512x512, beside the name, start_url, scope and display that already satisfied the rest of it — while no entry declares sizes "any" (the Android WebAPK install failure chromium issue 40925759 reports) and none declares a purpose at all, the two spellings this step refuses to write (the twin)`
3. `§13 · the shell head links the icon the worker serves — /apps renders rel="icon" and rel="apple-touch-icon" at paths.icon192 beside the manifest link, the row importing paths while layout.tsx spells the URL itself as the other three assets already do — while /login's head, one of the five page files that write their own, links neither, the ceiling this fix keeps deliberately (the twin)`

Row 1's body opens with `expect(icons.length, "the manifest lists no icons — the walk below is vacuous").toBe(2);`,
the guard `routes.test.ts:554` already spends on its own walk. Row 3 pins two `rel` tokens, which the header's "never
markup" sentence (`:33-34`) forbids, so the same `test:` commit spends the exclusion there: one named exception, §13's
icon links, where the `rel` token IS the browser contract and not presentation — the href stays `paths.icon192`, never
a literal. Row 9 (`:890`) is untouched. **Inventory diff = exactly three `todo → passed`, no retirements, no title
changes.** No fixture producers: two head links, no new page state.

## Ownership

| Owns | Files |
|---|---|
| rows | `server/test/worker/web-pages.test.ts` (the new describe, and the one header sentence), `test-inventory.json` |
| fix | `scripts/icon.mjs` (new — the generator, run once by the orchestrator), `server/src/pages/icon.ts` (new), `server/src/web.ts` (`PNG`, the two routes, the `icons` array), `server/src/pages/model.ts` (`icon192`, `icon512`, the count in their doc comment), `server/src/pages/layout.tsx` (`ICON`, its block comment, two head lines), `server/src/index.ts` (`ROUTES`, `MOUNTS`, the two counts in the `MOUNTS` docblock), `scripts/smoke.ts` (one `step`) |
| spec | `docs/specs/overview/02-concepts.md` (§2's reserved-list sentence only) |

## Shape

A rows workflow lands the three `it.todo` rows and regenerates the inventory → `test:` commit. The orchestrator
runs `scripts/icon.mjs` and passes the base64 to one implementer (Opus 5 or cheaper), who flips them: `icon.ts`, the two
routes and `PNG`, the `icons` array, the two `paths` members, the `ROUTES`/`MOUNTS` pairs, the head lines, the smoke
leg, the §2 amendment, the three stale counts. Then the inline gate — full suite; the inventory diff exactly those
three `todo → passed`; `npx tsc --noEmit` 0; the diff confined to the Ownership table → at most two fix rounds →
`fix:` commit and a dated ledger line carrying the new smoke step count. The deploy rides step 8's batch, and **3b's
install leg runs only after that deploy lands**, or it is re-run.

## Open

- Whether Chromium's runtime check really wants both a 192 and a 512 (the 144 px floor is unconfirmed
  source lore). Shipping both moots it in the passing direction; only 3b can say it passed. If 3b sees no
  affordance, in order: the smoke leg says whether the bytes are live, then DevTools → Application →
  Manifest names the missing criterion, then the `maskable` entry.
- **Kept against a refuter:** no permanent row asserts the icons are non-blank, though row 1's signature +
  IHDR checks would pass a white square. A row cannot tell blank from wrong-art anyway; the recipe's
  `img.decode()` + byte floor catches the paste, and 3b's tile is the standing check. Evidence: `toDataURL`
  returns valid base64 for an empty canvas, so the assertion would be a byte threshold — an incidental
  number under §7 (`web-pages.test.ts:33-34`), pinned nowhere else here.
