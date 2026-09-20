// drawer-check.mts — DEV-ONLY. Proves the phone drawer works, which `visual-compare.mts`
// structurally cannot: the gallery screenshots a state, and the drawer is not a state any
// seed can hold — it is what a TAP produces.
//
//   pnpm check:drawer             # exits non-zero on the first broken behaviour
//
// It exists because the drawer shipped broken. `styles.css` draws the panel and the scrim but
// keys OPEN on `#menu:target`, since the server-rendered pages ship no script and a URL
// fragment is the only switch they have. This client opens the same markup with a Base UI
// Dialog, whose switch is `data-open`, so the dialog opened — focus trapped, scroll locked —
// with the panel still translated a full width off-screen. Nothing in the suite noticed,
// because every screenshot was of a closed drawer and every unit test is of the Worker.
//
// The last case is the reason this is behavioural and not another baseline: a drawer entry
// pointing at the page already shown navigates nowhere, so it has no remount to hide behind.
//
// Deliberately NOT wired into CI, for the same reason as the two visual scripts: it needs two
// dev servers and a browser download the existing workflow does not provide.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { CONTEXT, finish, killTree, mounted, settle, startServer, waitForServer } from "./shots.mts";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Where the parity images land — the same folder `visual-compare.mts` reports into. */
const REPORT = fileURLToPath(new URL("../.visual/", import.meta.url));

// Overridable so a run can proceed beside `visual:compare`, which holds 5174 by default.
const SPA_PORT = Number(process.env.DRAWER_SPA_PORT ?? 5175);
const SSR_PORT = Number(process.env.DRAWER_SSR_PORT ?? 8789);
const SPA = `http://127.0.0.1:${SPA_PORT}`;
const SSR = `http://127.0.0.1:${SSR_PORT}`;

/** The phone shape. Above `styles.css`'s 767px breakpoint there is no hamburger to press. */
const VIEWPORT = { width: 390, height: 844 } as const;

/**
 * Where the open panel must land: 280px wide, flush to the right edge of a 390px viewport
 * (`styles.css:2610-2617`). Also the crop the parity diff compares, so the two pages'
 * differing content behind the scrim cannot reach the comparison.
 */
const PANEL = { x: VIEWPORT.width - 280, y: 0, width: 280, height: VIEWPORT.height } as const;

/** Same per-pixel tolerance as `visual-compare.mts`: glyph antialiasing is not a difference. */
const PIXEL_TOLERANCE = 0.1;

/** The share of the panel that may differ from the server-rendered one. */
const BUDGET = 0.02;

/**
 * The SPA page the drawer is driven from, and the SSR page its rendering is compared
 * against. `/audit` is a RETAINED server-rendered page, so it still draws the original
 * `#menu` drawer from the same `styles.css` classes — the only surviving reference for what
 * this drawer is supposed to look like, now that the server-rendered `/apps` is gone.
 */
const SPA_STATE = "/__preview/apps/default";
const SSR_STATE = "/preview/audit/default#menu";

const failures: string[] = [];

/** One behaviour, reported as it is checked so a failing run still shows what did work. */
function check(name: string, held: boolean, detail = ""): void {
  console.log(`${held ? "[ ok ]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  if (!held) failures.push(name);
}

/**
 * The drawer's state as the eye sees it: mounted at all, actually visible, and where. All
 * three are needed because the shipped bug was a panel that was mounted and invisible, and a
 * panel that is merely mounted proves nothing.
 */
async function panel(page: Page): Promise<{ mounted: boolean; visible: boolean; x: number | null }> {
  return await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".menu");
    if (menu === null) return { mounted: false, visible: false, x: null };
    return {
      mounted: true,
      visible: getComputedStyle(menu).visibility === "visible",
      x: menu.getBoundingClientRect().x,
    };
  });
}

/** Opens the drawer and waits out `styles.css`'s 0.22s transition. */
async function open(page: Page): Promise<void> {
  await page.click(".menu-open");
  await page.waitForTimeout(500);
}

/** Waits out the same transition on the way back, which Base UI holds the element through. */
async function closed(page: Page): Promise<boolean> {
  await page.waitForTimeout(500);
  return !(await panel(page)).mounted;
}

const spaServer = startServer(
  ["npx", "vite", "dev", "--mode", "preview", "--host", "127.0.0.1", "--strictPort", "--port", String(SPA_PORT)],
  WEB,
);
const ssrServer = startServer(
  ["npx", "wrangler", "dev", "-c", "wrangler.preview.jsonc", "--port", String(SSR_PORT)],
  ROOT,
);
let browser: Browser | undefined;
try {
  await waitForServer(spaServer, `${SPA}/__preview`);
  await waitForServer(ssrServer, `${SSR}/`);
  browser = await chromium.launch();
  const context = await browser.newContext({ ...CONTEXT, viewport: VIEWPORT });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.goto(`${SPA}${SPA_STATE}`, { waitUntil: "load" });
  await mounted(page);
  await settle(page);

  check("the hamburger is reachable at the phone width", await page.isVisible(".menu-open"));
  check("nothing is drawn until it is pressed", !(await panel(page)).mounted);

  // The first animation frame after the press must still be off-screen. Base UI mounts the
  // popup with `data-starting-style` for exactly one frame, and that frame is what the enter
  // transition runs FROM — without it the panel appears in place instead of sliding.
  await page.click(".menu-open");
  const entering = await page.evaluate(
    () =>
      new Promise<number | null>((resolve) =>
        requestAnimationFrame(() => {
          const menu = document.querySelector<HTMLElement>(".menu");
          resolve(menu === null ? null : menu.getBoundingClientRect().x);
        }),
      ),
  );
  await page.waitForTimeout(500);
  const shown = await panel(page);
  check("pressing it opens the drawer", shown.visible && shown.x === PANEL.x, `x=${shown.x}`);
  check("it slides in rather than appearing", entering !== null && entering > PANEL.x, `entered at x=${entering}`);

  const scrim = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".scrim");
    if (element === null) return null;
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
  check(
    "the scrim dims the page and takes the tap that closes it",
    scrim?.opacity === "1" && scrim.pointerEvents === "auto",
    JSON.stringify(scrim),
  );

  // Parity against the original. Cropped to the panel, so only the drawer is compared.
  const ours = PNG.sync.read(await page.screenshot({ clip: PANEL }));
  const ssrPage = await context.newPage();
  await ssrPage.goto(`${SSR}${SSR_STATE}`, { waitUntil: "load" });
  await settle(ssrPage);
  await ssrPage.waitForTimeout(500);
  const theirs = PNG.sync.read(await ssrPage.screenshot({ clip: PANEL }));
  await ssrPage.close();
  const diff = new PNG({ width: PANEL.width, height: PANEL.height });
  const differing =
    ours.width === theirs.width && ours.height === theirs.height
      ? pixelmatch(ours.data, theirs.data, diff.data, ours.width, ours.height, { threshold: PIXEL_TOLERANCE })
      : ours.width * ours.height;
  // Written whether or not the pair passes, beside `visual-compare.mts`'s report: a ratio
  // says how much differs and never what.
  await mkdir(REPORT, { recursive: true });
  await writeFile(`${REPORT}drawer.new.png`, PNG.sync.write(ours));
  await writeFile(`${REPORT}drawer.old.png`, PNG.sync.write(theirs));
  await writeFile(`${REPORT}drawer.diff.png`, PNG.sync.write(diff));
  const ratio = differing / (PANEL.width * PANEL.height);
  check("it renders as the server-rendered drawer does", ratio < BUDGET, `${(ratio * 100).toFixed(2)}% of the panel differs`);

  await page.keyboard.press("Escape");
  check("Escape closes it", await closed(page));

  await open(page);
  await page.mouse.click(20, Math.floor(VIEWPORT.height / 2));
  check("a tap beside it closes it", await closed(page));

  await open(page);
  await page.click(".menu-close");
  check("its own close button closes it", await closed(page));

  await open(page);
  await page.click('.menu-link:has-text("Agents")');
  await page.waitForTimeout(700);
  // The gallery runs the real route tree over a MEMORY history, so the rendered page is the
  // evidence that a navigation happened; `page.url()` never moves.
  const heading = await page.evaluate(() => document.querySelector("h1")?.textContent ?? null);
  check("an entry navigates and the drawer goes with it", heading === "Agents" && !(await panel(page)).mounted, `h1=${heading}`);

  await open(page);
  await page.click('.menu-link:has-text("Agents")');
  await page.waitForTimeout(700);
  check("the entry for the page already shown closes it too", !(await panel(page)).mounted);

  check(
    "the scroll lock is released with it",
    await page.evaluate(() => getComputedStyle(document.body).overflow !== "hidden"),
  );
} catch (failure) {
  // Reported and exited rather than rethrown: the servers' piped stdio keeps this process's
  // event loop alive, so an escaping throw prints its stack and then hangs.
  console.error(failure);
  await browser?.close();
  killTree(spaServer);
  killTree(ssrServer);
  finish(1);
} finally {
  await browser?.close();
  killTree(spaServer);
  killTree(ssrServer);
}

console.log(failures.length === 0 ? "\nDRAWER PASS" : `\nDRAWER FAIL — ${failures.join("; ")}`);
finish(failures.length === 0 ? 0 : 1);
