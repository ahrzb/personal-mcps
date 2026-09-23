// drawer-check.mts — DEV-ONLY. Proves the phone drawer WORKS, which `visual-compare.mts`
// structurally cannot: the gallery screenshots a state, and the drawer is not a state any
// seed can hold — it is what a TAP produces.
//
//   pnpm check:drawer             # exits non-zero on the first broken behaviour
//
// It exists because the drawer shipped broken. `styles.css` (now `legacy.css`) drew the
// panel and the scrim but keyed OPEN on `#menu:target` — the server-rendered pages it was
// written for shipped no script, and a URL fragment was their only switch. This client opens the same markup with a
// Base UI Dialog, whose switch is `data-open`, so the dialog opened — focus trapped, scroll
// locked — with the panel still translated a full width off-screen. Nothing in the suite
// noticed, because every screenshot was of a closed drawer and every unit test is of the Worker.
//
// So it checks behaviour, against the SPA gallery alone: the press opens it where the sheet
// puts it and slides it in, the scrim takes the tap, Escape / a tap beside it / its own close
// button each close it and hand focus back to the hamburger, an entry navigates and the
// drawer goes with it — including the entry for the page already shown, which navigates
// nowhere and so has no remount to hide behind — and the scroll lock is released. How the
// open panel LOOKS is no longer compared here: the server preview it was compared against is
// retired (decision 38), and every page's look is `visual-compare.mts`'s to gate.
//
// Deliberately NOT wired into CI, for the same reason as `visual-compare.mts`: it needs a dev
// server and a browser download the existing workflow does not provide.

import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { CONTEXT, finish, killTree, mounted, settle, startServer, waitForServer } from "./shots.mts";

const WEB = fileURLToPath(new URL("../", import.meta.url));

// Overridable so a run can proceed beside `visual:compare`, which holds 5174 by default.
const SPA_PORT = Number(process.env.DRAWER_SPA_PORT ?? 5175);
const SPA = `http://127.0.0.1:${SPA_PORT}`;

/** The phone shape. Above `legacy.css`'s 767px breakpoint there is no hamburger to press. */
const VIEWPORT = { width: 390, height: 844 } as const;

/** Where the open panel must land: 280px wide, flush to the right edge of a 390px viewport
 *  (`legacy.css`'s `.menu`). */
const PANEL_X = VIEWPORT.width - 280;

/** The gallery state the drawer is driven from — any page drawing the Shell would do. */
const SPA_STATE = "/__preview/apps/default";

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

/** Opens the drawer and waits out `legacy.css`'s 0.22s transition. */
async function open(page: Page): Promise<void> {
  await page.click(".menu-open");
  await page.waitForTimeout(500);
}

/** Waits out the same transition on the way back, which Base UI holds the element through. */
async function closed(page: Page): Promise<boolean> {
  await page.waitForTimeout(500);
  return !(await panel(page)).mounted;
}

/** Whether focus went back to the hamburger that opened the drawer — the Dialog's promise,
 *  and what keeps a keyboard user from being dropped at the top of the document. */
async function focusReturned(page: Page): Promise<boolean> {
  return await page.evaluate(() => document.activeElement?.classList.contains("menu-open") === true);
}

const spaServer = startServer(
  ["npx", "vite", "dev", "--mode", "preview", "--host", "127.0.0.1", "--strictPort", "--port", String(SPA_PORT)],
  WEB,
);
let browser: Browser | undefined;
try {
  await waitForServer(spaServer, `${SPA}/__preview`);
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
  check("pressing it opens the drawer", shown.visible && shown.x === PANEL_X, `x=${shown.x}`);
  check("it slides in rather than appearing", entering !== null && entering > PANEL_X, `entered at x=${entering}`);

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

  await page.keyboard.press("Escape");
  check("Escape closes it", await closed(page));
  check("…and focus returns to the hamburger", await focusReturned(page));

  await open(page);
  await page.mouse.click(20, Math.floor(VIEWPORT.height / 2));
  check("a tap beside it closes it", await closed(page));

  await open(page);
  await page.click(".menu-close");
  check("its own close button closes it", await closed(page));
  check("…and focus returns to the hamburger", await focusReturned(page));

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
  // Reported and exited rather than rethrown: the server's piped stdio keeps this process's
  // event loop alive, so an escaping throw prints its stack and then hangs.
  console.error(failure);
  await browser?.close();
  killTree(spaServer);
  finish(1);
} finally {
  await browser?.close();
  killTree(spaServer);
}

console.log(failures.length === 0 ? "\nDRAWER PASS" : `\nDRAWER FAIL — ${failures.join("; ")}`);
finish(failures.length === 0 ? 0 : 1);
