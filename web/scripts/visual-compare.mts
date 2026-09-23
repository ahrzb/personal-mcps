// visual-compare.mts — DEV-ONLY. Screenshots every state of the React preview gallery and
// compares it against the committed baselines in design/baseline/, so "nothing looks
// different" is evidence rather than an assertion. The baselines are the reference: shot from
// the server-rendered pages before each one moved to this client (decision 38 — the server
// preview that drew them is retired, `src/preview/seed.ts` says what it was), and for /audit
// from this gallery's own accepted render (decision 36).
//
//   pnpm visual:compare           # writes web/.visual/report.html, exits non-zero on a fail
//
// Deliberately NOT wired into CI: it needs a dev server and a browser download the existing
// workflow does not provide. It is run by hand, and its report is the evidence for the
// cutover.
//
// A pair over the threshold FAILS unless it is listed in `web/visual-accepted.json` with a
// one-line reason. That file is the point: where Base UI replaces a hand-rolled primitive the
// rendering SHOULD differ, and a named, reviewable exception records that better than a
// threshold loosened until everything passes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import {
  CONTEXT,
  finish,
  killTree,
  mounted,
  pairsFromPage,
  settle,
  startServer,
  VIEWPORTS,
  waitForServer,
} from "./shots.mts";

/** The share of differing pixels a pair may carry before it fails. */
const BUDGET = 0.02;

/**
 * Per-pixel colour tolerance handed to pixelmatch. Antialiasing along a glyph edge differs
 * between two renderings of identical text, and counting those as differences would spend the
 * whole pair budget on nothing. Lower this before raising BUDGET: a loosened pair budget is
 * where a real layout difference hides.
 */
const PIXEL_TOLERANCE = 0.1;

// Overridable so two runs can proceed side by side; --strictPort below would otherwise make
// the second one fight the first for 5174.
const PORT = Number(process.env.VISUAL_PORT ?? 5174);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WEB = fileURLToPath(new URL("../", import.meta.url));
const BASELINE = fileURLToPath(new URL("../../design/baseline/", import.meta.url));
const REPORT = fileURLToPath(new URL("../.visual/", import.meta.url));

/**
 * One compared pair. `sizeMismatch` is its own outcome rather than a 100% ratio because two
 * images of different dimensions cannot be diffed at all — reporting that as a ratio would
 * hide what actually changed, and it is also what a MISSING baseline reads as.
 */
type Result = { key: string; ratio: number; sizeMismatch: boolean; accepted: string | null };

const accepted = await acceptedPairs();
// `--host 127.0.0.1` and `--strictPort` are both load-bearing. Vite binds `localhost`,
// which resolves to `::1` on some machines while nothing listens on `127.0.0.1` — so the
// readiness probe below would poll a port nobody holds and time out with the server running
// fine. And without `--strictPort` a stale dev server makes vite silently move to the next
// port, so the probe waits on a URL this run does not serve.
const server = startServer(
  ["npx", "vite", "dev", "--mode", "preview", "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)],
  WEB,
);
let browser: Browser | undefined;
const results: Result[] = [];
try {
  await waitForServer(server, `${ORIGIN}/__preview`);
  browser = await chromium.launch();
  await mkdir(REPORT, { recursive: true });
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ ...CONTEXT, viewport });
    const page = await context.newPage();
    // Read the pair list from the RENDERED index rather than its HTML: the gallery is a
    // client-side router, so `fetch` would see only the empty document shell. It doubles as
    // the first proof that the gallery mounts at all.
    const pairs = await pairsFromPage(page, `${ORIGIN}/__preview`, "/__preview");
    for (const [name, state] of pairs) {
      const key = `${name}__${state}__${viewport.width}x${viewport.height}`;
      await page.goto(`${ORIGIN}/__preview/${name}/${state}`, { waitUntil: "load" });
      await mounted(page);
      await settle(page);
      const shot = await page.screenshot({ fullPage: true });
      await writeFile(`${REPORT}${key}.new.png`, shot);
      results.push(await compare(key, shot, accepted[key] ?? null));
    }
    await context.close();
  }
} catch (failure) {
  // Reported and EXITED rather than rethrown: the dev server's piped stdio keeps this
  // process's event loop alive, so an escaping throw prints its stack and then hangs, which
  // reads as a stall.
  console.error(failure);
  await browser?.close();
  killTree(server);
  finish(1);
} finally {
  await browser?.close();
  killTree(server);
}

await writeFile(`${REPORT}report.html`, reportHtml(results));
for (const each of results) {
  const mark = each.accepted !== null ? "accepted" : failed(each) ? "FAIL" : "ok";
  console.log(`${mark.padEnd(8)} ${(each.ratio * 100).toFixed(2).padStart(6)}%  ${each.key}`);
}
console.log(`\nreport: web/.visual/report.html`);
const failures = results.filter((each) => each.accepted === null && failed(each));
if (failures.length > 0) {
  console.error(`${failures.length} pair(s) over ${BUDGET * 100}% and not listed in visual-accepted.json`);
}
finish(failures.length > 0 ? 1 : 0);

function failed(result: Result): boolean {
  return result.sizeMismatch || result.ratio > BUDGET;
}

/** One pair, diffed against its baseline. A MISSING baseline is a failure with a reason
 *  rather than a crash: it means the gallery holds a state no baseline was shot for, which is
 *  worth seeing in the report. */
async function compare(key: string, shot: Buffer, accepted: string | null): Promise<Result> {
  const baselineBytes = await readFile(`${BASELINE}${key}.png`).catch(() => null);
  if (baselineBytes === null) return { key, ratio: 1, sizeMismatch: true, accepted };
  const before = PNG.sync.read(baselineBytes);
  const after = PNG.sync.read(shot);
  if (before.width !== after.width || before.height !== after.height) {
    await writeFile(`${REPORT}${key}.old.png`, baselineBytes);
    return { key, ratio: 1, sizeMismatch: true, accepted };
  }
  const diff = new PNG({ width: before.width, height: before.height });
  const differing = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
    threshold: PIXEL_TOLERANCE,
  });
  await writeFile(`${REPORT}${key}.diff.png`, PNG.sync.write(diff));
  await writeFile(`${REPORT}${key}.old.png`, baselineBytes);
  return { key, ratio: differing / (before.width * before.height), sizeMismatch: false, accepted };
}

/** The named exceptions: key → the one-line reason the difference is intended. */
async function acceptedPairs(): Promise<Record<string, string>> {
  const raw = await readFile(`${WEB}visual-accepted.json`, "utf8").catch(() => "{}");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, string> = {};
  for (const [key, reason] of Object.entries(parsed)) {
    if (typeof reason === "string") out[key] = reason;
  }
  return out;
}

/** Side by side: the baseline, the React rendering, and the diff. */
function reportHtml(results: Result[]): string {
  const rows = results
    .slice()
    .sort((left, right) => right.ratio - left.ratio)
    .map((each) => {
      const verdict =
        each.accepted !== null
          ? `<span class="accepted">accepted — ${escapeHtml(each.accepted)}</span>`
          : each.sizeMismatch
            ? `<span class="fail">size mismatch or missing baseline</span>`
            : each.ratio > BUDGET
              ? `<span class="fail">over budget</span>`
              : `<span class="ok">ok</span>`;
      return `<section><h2>${escapeHtml(each.key)}</h2>
<p>${(each.ratio * 100).toFixed(2)}% differing · ${verdict}</p>
<div class="shots">
  <figure><figcaption>baseline</figcaption><img src="${each.key}.old.png"></figure>
  <figure><figcaption>react</figcaption><img src="${each.key}.new.png"></figure>
  <figure><figcaption>diff</figcaption><img src="${each.key}.diff.png"></figure>
</div></section>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>personal-mcps — visual comparison</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;max-width:1600px}
h2{font-size:15px;margin:32px 0 4px;font-family:ui-monospace,monospace}
p{margin:0 0 8px;font-size:13px;color:#52525b}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
figure{margin:0}figcaption{font-size:11px;color:#71717a;margin-bottom:4px}
img{width:100%;border:1px solid #e4e4e7;background:#fff}
.ok{color:#15803d}.fail{color:#b91c1c;font-weight:600}.accepted{color:#92400e}</style>
<h1>personal-mcps — baseline vs React, ${results.length} pairs</h1>
${rows}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
