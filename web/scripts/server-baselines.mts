// server-baselines.mts — DEV-ONLY, RUN ONCE PER SSR CHANGE. Shoots every page × fixture pair
// the server-rendered preview (`wrangler dev -c wrangler.preview.jsonc`, `server/dev/preview.ts`)
// still serves, into design/baseline/, before the SPA rewrite (2026-09-23) touches a single
// page. These are the pass/fail reference `visual-compare.mts` diffs the React gallery against
// as each page family migrates — a baseline shot after the rewrite started would no longer
// prove the two renderings agree, so this runs first and is committed once, not re-run per PR.
//
//   pnpm --filter @ahrzb/personal-mcp-web exec node --experimental-strip-types \
//     scripts/server-baselines.mts
//
// Uses shots.mts's shared CONTEXT/VIEWPORTS/settle, so a baseline and the React candidate
// `visual-compare.mts` later diffs it against are captured under identical conditions — see
// shots.mts's own header for why that sharing matters. The server pages draw their own
// `<html>` with no `#root`, so `mounted()` (React-gallery-only) is never called here.
//
// Exits non-zero — and always stops the wrangler dev server it started — if any page × fixture
// fails to load, renders with no visible text, or produces a PNG whose width does not exactly
// match the viewport: each is a baseline that would fail every later visual:compare run for a
// reason that has nothing to do with the SPA rewrite it is meant to gate.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { PNG } from "pngjs";
import { CONTEXT, finish, killTree, pairsFromPage, settle, startServer, VIEWPORTS, waitForServer } from "./shots.mts";

// Overridable so a run can proceed beside an already-running `preview` dev server
// (.claude/launch.json also defaults to 8788) without the two fighting over the port.
const PORT = Number(process.env.PREVIEW_PORT ?? 8788);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = fileURLToPath(new URL("../../design/baseline/", import.meta.url));

/** One captured (or rejected) file: its name and, when rejected, why. */
type Shot = { file: string; ok: boolean; reason?: string };

const server = startServer(
  ["npx", "wrangler", "dev", "-c", "wrangler.preview.jsonc", "--port", String(PORT)],
  ROOT,
);
let browser: Browser | undefined;
const shots: Shot[] = [];
try {
  await waitForServer(server, `${ORIGIN}/`);
  browser = await chromium.launch();
  await mkdir(BASELINE, { recursive: true });
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ ...CONTEXT, viewport });
    const page = await context.newPage();
    // Read off the RENDERED index, per pairsFromPage's own contract, rather than assuming
    // fixtures.ts's keys: the list must be exactly what the preview links, since that is
    // what a later React gallery is paired against by name.
    const pairs = await pairsFromPage(page, `${ORIGIN}/`, "/preview");
    for (const [pageName, fixture] of pairs) {
      shots.push(await shootOne(page, pageName, fixture, viewport));
    }
    await context.close();
  }
} catch (failure) {
  // Reported and EXITED rather than rethrown: `killTree` below leaves this process holding
  // the dev server's piped stdio, so an escaping throw prints its stack and then hangs — see
  // shots.mts's `finish`.
  console.error(failure);
  await browser?.close();
  killTree(server);
  finish(1);
} finally {
  await browser?.close();
  killTree(server);
}

for (const shot of shots) {
  console.log(`${shot.ok ? "ok  " : "FAIL"}  ${shot.file}${shot.reason ? `  — ${shot.reason}` : ""}`);
}
console.log("");
const perPage = new Map<string, number>();
for (const shot of shots) {
  if (!shot.ok) continue;
  const pageName = shot.file.split("__")[0] ?? shot.file;
  perPage.set(pageName, (perPage.get(pageName) ?? 0) + 1);
}
for (const [pageName, count] of perPage) console.log(`${pageName}: ${count}`);
const failures = shots.filter((shot) => !shot.ok);
if (failures.length > 0) console.error(`\n${failures.length} of ${shots.length} shot(s) failed`);
finish(failures.length > 0 ? 1 : 0);

/**
 * Captures one page × fixture pair at one viewport into design/baseline/, and reports whether
 * it is fit to BE a baseline: the page answered 2xx, rendered visible text, and the PNG's own
 * width — read from its IHDR chunk via `pngjs`, not assumed from the request — matches the
 * viewport exactly. A bad baseline fails every future visual:compare pair built on it, so a
 * failing shot here is refused rather than written.
 */
async function shootOne(
  page: Page,
  pageName: string,
  fixture: string,
  viewport: { width: number; height: number },
): Promise<Shot> {
  const file = `${pageName}__${fixture}__${viewport.width}x${viewport.height}.png`;
  const response = await page.goto(`${ORIGIN}/preview/${pageName}/${fixture}`, { waitUntil: "load" }).catch(() => null);
  if (response === null || !response.ok()) {
    return { file, ok: false, reason: `did not load (status ${response?.status() ?? "none"})` };
  }
  await settle(page);
  const text = await page.evaluate(() => document.body.innerText.trim());
  if (text.length === 0) return { file, ok: false, reason: "rendered empty" };
  const bytes = await page.screenshot({ fullPage: true });
  const width = PNG.sync.read(bytes).width;
  if (width !== viewport.width) {
    return { file, ok: false, reason: `PNG width ${width} does not match viewport ${viewport.width}` };
  }
  await writeFile(`${BASELINE}${file}`, bytes);
  return { file, ok: true };
}
