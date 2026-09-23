// audit-search-check.mts — DEV-ONLY. Proves that typing in /audit's search box does not tear
// the page down, which no screenshot and no unit test can see.
//
//   pnpm check:audit-search       # exits non-zero on the first broken behaviour
//
// It exists because the search shipped broken (postmortem
// `docs/superpowers/postmortems/2026-09-21-audit-search-unmounts-the-page.md`). The search text
// is part of the window query's KEY — correctly, `text` is the one filter the server applies —
// and the page rendered its loading skeleton whenever that query was pending. A new key has no
// data, so every settled keystroke UNMOUNTED the explorer, the `<input>` with it, drew a
// skeleton, and remounted a moment later: focus, caret, "Load more" counts, expanded facet
// groups and scroll position all went. Search was unusable past one word.
//
// Why it is a browser walk and not a test: the whole bug is "which subtree is mounted while a
// query is pending", and the gallery — the only place the page was rendered before ship —
// could not reach it at all. Its cache is seeded and its API client THROWS on any unseeded
// read, so a refetch could never happen there. The `searchLive` seed answers `/audit/window`
// LATE instead of throwing, which is what makes this walk possible.
//
// The load-bearing assertion is `sameNode`: a remount is invisible in a screenshot — the page
// looks identical a moment later — and is exactly what the reader experiences as the box
// "fucking things up". Comparing the element's identity across keystrokes is the only way to
// see it.
//
// Deliberately NOT wired into CI, for the same reason as the other browser scripts: it needs a
// dev server and a browser download the existing workflow does not provide.

import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { CONTEXT, finish, killTree, mounted, settle, startServer, waitForServer } from "./shots.mts";

const WEB = fileURLToPath(new URL("../", import.meta.url));

// Its own port by default: 5174 is `visual:compare`'s and 5175 is `check:drawer`'s, and all
// three are run by hand and sometimes at once.
const PORT = Number(process.env.AUDIT_SEARCH_PORT ?? 5176);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The one state whose API answers rather than throws, so typing here actually refetches. */
const STATE = "/__preview/audit/searchLive";

/** The page debounces at 250ms and the seed's responder takes another 250ms. Typing slower than
 *  the sum is what makes each keystroke its own settled read, which is the case that broke. */
const PAUSE = 700;

/** What is typed slowly, character by character: three settled reads where the bug needed one. */
const TYPED = "sla";

/**
 * And what is typed as a BURST, at speed, under a throttled CPU.
 *
 * This is the case a comfortable machine hides. Typing fast is when a render that takes longer
 * than a keystroke lets the page's own lagging echo of the URL arrive between two characters —
 * and a box that re-seeds itself from that echo eats whatever was typed in the gap. A ten-
 * character burst at 20ms on a CPU six times too slow is that window held open.
 */
const BURST = "slack post";
const BURST_DELAY_MS = 20;
const THROTTLE = 6;

/** How many window reads a single burst may cost. One for the burst's own settled text, and one
 *  spare for a debounce that happened to split it — never one per character. */
const BURST_READS = 2;

/** Where the mid-search shots land, when the caller asks for them. The gate puts them beside
 *  "PAGE — SEARCHING" on `AuditDetailStates`, which has a board and no picture otherwise. */
const OUT = process.env.OUT ?? null;

/* What the walk finds on the page. By role, label and `data-slot` rather than by class: the page
   draws in utilities, whose class strings say how a thing looks, not what it is. */

/** The Events tab of the view segment. */
const EVENTS_TAB = 'role=tab[name="Events"]';
/** A row of the events table. */
const EVENT_ROW = "[data-slot=table-body] > tr";
/** The filter bar's own Clear, not the one "Nothing matches" can draw at the same time. */
const CLEAR = "[data-slot=filter-bar] button:has-text('Clear')";

const failures: string[] = [];

/** One behaviour, reported as it is checked so a failing run still shows what did work. */
function check(name: string, held: boolean, detail = ""): void {
  console.log(`${held ? "[ ok ]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  if (!held) failures.push(name);
}

/**
 * Marks the live `<input>` so a later render can be asked whether it is the SAME element.
 *
 * A property on the node rather than an attribute: React reconciles attributes, so an attribute
 * could survive a remount on a newly created element and report a false pass. An expando is
 * destroyed with the element it sat on.
 */
async function markInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search events and bodies"]');
    if (input !== null) (input as unknown as { __pmcpMark?: number }).__pmcpMark = Date.now();
  });
}

/** The box as the walk needs to see it: still the marked node, still focused, and what it holds. */
async function inputState(page: Page): Promise<{ present: boolean; sameNode: boolean; focused: boolean; value: string }> {
  return await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search events and bodies"]');
    if (input === null) return { present: false, sameNode: false, focused: false, value: "" };
    return {
      present: true,
      sameNode: (input as unknown as { __pmcpMark?: number }).__pmcpMark !== undefined,
      focused: document.activeElement === input,
      value: input.value,
    };
  });
}

/**
 * How many EVENTS the current answer holds, read off the table's own foot ("N rows from M
 * events").
 *
 * Not the number of drawn rows: those are capped at one page of 120, so a search that cut the
 * window from 1,395 events to 40 would leave the count unchanged and the walk would report that
 * nothing had happened.
 */
async function eventCount(page: Page): Promise<number> {
  const foot = await page.evaluate(() => document.body.textContent);
  const match = /rows from ([\d,]+) events/.exec(foot ?? "");
  return match === null ? -1 : Number(match[1]?.replace(/,/g, ""));
}

/** How many window reads the gallery's client has answered. Counted IN THE PAGE because these
 *  reads never reach the network — the seed answers them itself — so no request ever fires. */
async function windowReads(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      ((globalThis as unknown as { __pmcpReads?: string[] }).__pmcpReads ?? []).filter((path) =>
        path.startsWith("/audit/window"),
      ).length,
  );
}

/** What `?q=` the router holds. The gallery runs a MEMORY history, so the browser's address bar
 *  never moves and the router's own state is the only place to read it. */
async function routerQ(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a[download="audit.jsonl"]');
    const href = link?.getAttribute("href") ?? "";
    const at = href.indexOf("?");
    return at < 0 ? "" : (new URLSearchParams(href.slice(at + 1)).get("text") ?? "");
  });
}

const server = startServer(
  ["npx", "vite", "dev", "--mode", "preview", "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)],
  WEB,
);
let browser: Browser | undefined;
try {
  await waitForServer(server, `${ORIGIN}/__preview`);
  browser = await chromium.launch();
  const context = await browser.newContext({ ...CONTEXT, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.goto(`${ORIGIN}${STATE}`, { waitUntil: "load" });
  await mounted(page);
  await settle(page);
  await page.click(EVENTS_TAB);
  await page.waitForSelector(EVENT_ROW);

  const before = await eventCount(page);
  check("the events view draws rows to begin with", before > 0, `${before} events`);

  /* Watch the WHOLE document for a skeleton, for the entire walk. The bug's signature is an
     element that appears and is gone again within a few hundred milliseconds, which a poll
     between keystrokes would miss — so this observes every node ever attached. */
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __pmcpSkeletons: string[] }).__pmcpSkeletons = seen;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches("[data-slot=skeleton]") || node.querySelector("[data-slot=skeleton]") !== null) {
            seen.push(node.className || node.tagName);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  const input = page.locator('input[aria-label="Search events and bodies"]');
  await input.click();
  await markInput(page);

  const steps: string[] = [];
  for (const character of TYPED) {
    await page.keyboard.type(character);
    // Longer than the debounce plus the seed's own delay, so each character is a settled read
    // that has already come back — which is precisely when the page used to remount.
    await page.waitForTimeout(PAUSE);
    const state = await inputState(page);
    steps.push(
      `after "${state.value}": present=${state.present} same=${state.sameNode} focused=${state.focused} events=${await eventCount(page)}`,
    );
    if (!state.present || !state.sameNode || !state.focused) break;
  }
  console.log(steps.map((line) => `       ${line}`).join("\n"));

  const after = await inputState(page);
  check("the input is the SAME DOM node after three settled searches", after.sameNode);
  check("it never lost focus", after.focused);
  check("it holds everything that was typed", after.value === TYPED, `value="${after.value}"`);

  const skeletons = await page.evaluate(
    () => (window as unknown as { __pmcpSkeletons: string[] }).__pmcpSkeletons,
  );
  check("no skeleton was ever attached while searching", skeletons.length === 0, skeletons.slice(0, 3).join(" | "));

  const searched = await eventCount(page);
  check("the search actually narrowed the list", searched > 0 && searched < before, `${before} events → ${searched}`);

  // The rows that are on screen during a search must be the PREVIOUS answer, visibly stale —
  // not a skeleton and not an empty pane.
  await page.keyboard.type("s");
  // Past the 250ms debounce and INSIDE the seed responder’s own 250ms, which is the only
  // window in which a search is in flight at all.
  await page.waitForTimeout(380);
  // The pane is `aria-busy` while its rows are the previous answer, and that is also what dims
  // it — so the stale pane is the busy element that holds the rows, drawn below full opacity.
  const during = await page.evaluate((row) => {
    const main = document.querySelector<HTMLElement>('[aria-busy="true"]');
    return {
      rows: document.querySelectorAll(row).length,
      stale: main !== null && main.querySelector(row) !== null && Number(getComputedStyle(main).opacity) < 1,
      busy: document.querySelector('[role="status"]')?.textContent ?? "",
    };
  }, EVENT_ROW);
  check("mid-search the previous rows stay, dimmed", during.rows > 0 && during.stale, JSON.stringify(during));
  check("and the box says it is searching", during.busy.includes("Searching"), during.busy);
  // The searching page is a BOARD state with no other picture: the gallery seeds a resting page,
  // and this screen exists for a few hundred milliseconds in the middle of a keystroke.
  if (OUT !== null) await page.screenshot({ path: `${OUT}/audit__searching__1300x900.png`, fullPage: true });
  await page.waitForTimeout(PAUSE);

  /* ---- the burst: fast typing on a slow machine, which is where the race lived ---- */
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.click(CLEAR);
  await page.waitForTimeout(PAUSE);

  const readsBefore = await windowReads(page);
  await input.click();
  await markInput(page);
  await page.keyboard.type(BURST, { delay: BURST_DELAY_MS });
  await page.waitForTimeout(PAUSE * 2);

  const burst = await inputState(page);
  check(`a ${BURST.length}-character burst under ${THROTTLE}x CPU keeps every character`, burst.value === BURST, `value="${burst.value}"`);
  check("the URL took the same text", (await routerQ(page)) === BURST, `q="${await routerQ(page)}"`);
  check("the input is still the same node, still focused", burst.sameNode && burst.focused);
  const burstReads = (await windowReads(page)) - readsBefore;
  check(`the burst cost at most ${BURST_READS} window reads`, burstReads <= BURST_READS, `${burstReads} reads for ${BURST.length} characters`);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  /* ---- Clear: the one thing that may re-seed the box from outside ---- */
  // The rail's first line, "N of M in window".
  const full = await page.evaluate(() => {
    const line = [...document.querySelectorAll("aside p")].find((each) => / in window$/.test(each.textContent ?? ""));
    return Number(line?.textContent?.match(/of ([\d,]+)/)?.[1]?.replace(/,/g, "") ?? -1);
  });
  await page.click(CLEAR);
  await page.waitForTimeout(PAUSE);
  const cleared = await inputState(page);
  check("Clear empties the box", cleared.value === "", `value="${cleared.value}"`);
  check("Clear drops q from the URL", (await routerQ(page)) === "", `q="${await routerQ(page)}"`);
  check("and the rows come back", (await eventCount(page)) === before, `${await eventCount(page)} events (was ${before}, mid-search ${full})`);

  /* ---- the same mid-search moment at the phone width, for the board ---- */
  if (OUT !== null) {
    const narrow = await browser.newContext({ ...CONTEXT, viewport: { width: 375, height: 812 } });
    const phone = await narrow.newPage();
    await phone.goto(`${ORIGIN}${STATE}`, { waitUntil: "load" });
    await mounted(phone);
    await settle(phone);
    await phone.click(EVENTS_TAB);
    await phone.waitForSelector(EVENT_ROW);
    await phone.click('input[aria-label="Search events and bodies"]');
    await phone.keyboard.type("slac");
    // Past the debounce and inside the responder's own delay: the only moment the page is
    // showing the previous answer and saying so.
    await phone.waitForTimeout(380);
    await phone.screenshot({ path: `${OUT}/audit__searching__375x812.png`, fullPage: true });
    await narrow.close();
    console.log(`\nsearching shots → ${OUT}/audit__searching__{1300x900,375x812}.png`);
  }
} catch (failure) {
  // Reported and exited rather than rethrown: the server's piped stdio keeps this process's
  // event loop alive, so an escaping throw prints its stack and then hangs.
  console.error(failure);
  await browser?.close();
  killTree(server);
  finish(1);
} finally {
  await browser?.close();
  killTree(server);
}

console.log(failures.length === 0 ? "\nAUDIT SEARCH PASS" : `\nAUDIT SEARCH FAIL — ${failures.join("; ")}`);
finish(failures.length === 0 ? 0 : 1);
