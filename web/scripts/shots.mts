// shots.mts — DEV-ONLY. What the browser-driven checks — `visual-compare.mts` and
// `drawer-check.mts` — must do IDENTICALLY, in one place.
//
// Not merely shared for tidiness: a baseline and a candidate screenshot taken under
// different viewport, scale, timezone, locale or font-readiness settings differ for reasons
// that are not the rendering, and the whole comparison is then noise. So the settings live
// here and no script states one of its own.
//
// A module with no side effects on purpose, which is why it is not just `export`s added to
// one of the scripts: each of those runs its capture at import time, so importing one to
// borrow a helper would start a browser.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Page } from "playwright";

/**
 * The two artboard shapes, named as the output filenames spell them. The theme names 768 and
 * 1024 as the design's breakpoints (`app.css`), so 1280 is the wide shape above both; 390 is the phone shape
 * `design/README.md` records its mobile captures at.
 */
export const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
] as const;

/**
 * The browser-context settings a comparable screenshot needs.
 *
 * `deviceScaleFactor: 1` because a 2x shot differs per machine. The timezone and locale are
 * pinned because the fixtures render dates and `toLocaleDateString` reads the host's.
 */
export const CONTEXT = { deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US" } as const;

/**
 * Waits for the webfont and for a paint before a capture. Geist arrives over the network and
 * a shot taken mid-swap is a different file every run.
 *
 * Deliberately NOT `waitForLoadState("networkidle")`. The React gallery runs under `vite
 * dev`, which holds an HMR WebSocket open for the life of the page — so the network is never
 * idle and that wait never returns. Two frames after `fonts.ready` is what "the browser has
 * drawn this" actually means here.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Waits until the client has actually rendered into `#root`.
 *
 * REQUIRED before a gallery capture, and the reason is the same one `pairsFromPage` waits:
 * under `vite dev` the module graph is fetched dynamically, so `load` fires while the entry
 * module is still importing. Without this the screenshot is a blank page the height of the
 * viewport — which compares as a size mismatch against every baseline and looks like a
 * layout bug rather than a timing one.
 *
 * Not part of `settle`, which a capture of a page with no `#root` needs too.
 */
export async function mounted(page: Page): Promise<void> {
  await page.waitForSelector("#root > *", { timeout: 30_000 });
}

/**
 * Starts a dev server and hands back the child.
 *
 * `shell: true` is not a convenience: Node refuses to spawn a `.cmd` shim directly (EINVAL
 * since 18.20) and on Windows `npx` IS a `.cmd`. The argv is always the caller's own literal
 * — no external input reaches it — so the shell adds no injection surface.
 */
export function startServer(command: string[], cwd: string): ChildProcess {
  // Each server gets a dependency cache of its own, keyed by its port (vite.config.ts's
  // cacheDir): gallery gates run in parallel, and a shared `.vite` re-optimized under a
  // running server answers "504 Outdated Optimize Dep" and aborts its navigations.
  const port = command[command.indexOf("--port") + 1];
  const env = { ...process.env };
  if (port !== undefined && env.VITE_CACHE_DIR === undefined) env.VITE_CACHE_DIR = `node_modules/.vite-${port}`;
  return spawn(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
}

/**
 * Stops a dev server AND its children.
 *
 * `shell: true` above means the spawned process is a shell, and `ChildProcess.kill` signals
 * only that shell — the server keeps running, holds its port, and keeps the script's stdio
 * pipes open, so the run never exits. POSIX can signal the process group; Windows has no
 * group to signal, so `taskkill /T` is the only way to reach the tree.
 *
 * `spawnSync`, because the callers end with `process.exit`: an async taskkill is still
 * queued when the process goes, and the server it was sent to survive the run, holds its
 * `--strictPort` port and makes the NEXT run fail to start.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Waits until `probe` answers 200, or gives up.
 *
 * Polling a URL rather than matching a startup banner: neither wrangler's nor vite's banner
 * text is a contract, and "answers the index" is the readiness that actually matters to a
 * screenshot run.
 */
export async function waitForServer(server: ChildProcess, probe: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`${probe}: the dev server exited with ${server.exitCode}`);
    const ok = await fetch(probe)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the dev server did not answer ${probe} within 60s`);
}

/**
 * Every (page, state) pair the gallery index links, read off the RENDERED page rather than
 * its HTML — so the list cannot lag the fixtures, and a state added without the script
 * knowing still gets captured. `fetch` would see only the empty document shell, so the
 * links are read after the page has run, which is also a first proof that the gallery
 * mounts at all.
 *
 * `waitForSelector` rather than a bare read after `load`: under `vite dev` the module graph
 * is fetched dynamically, so `load` can fire before the entry module has finished importing
 * and the index would read as empty.
 */
export async function pairsFromPage(page: Page, indexUrl: string, prefix: string): Promise<[string, string][]> {
  await page.goto(indexUrl, { waitUntil: "load" });
  await page.waitForSelector(`a[href^="${prefix}/"]`, { timeout: 30_000 });
  const hrefs = await page.$$eval("a[href]", (nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
  const pattern = new RegExp(`^${prefix}/([^/]+)/(.+)$`);
  const pairs: [string, string][] = [];
  for (const href of hrefs) {
    const match = pattern.exec(href);
    if (match !== null) pairs.push([match[1] ?? "", match[2] ?? ""]);
  }
  if (pairs.length === 0) throw new Error(`${indexUrl} rendered no page x state links`);
  return pairs;
}

/**
 * Ends the run.
 *
 * An explicit exit, because `killTree` leaves this process holding the dev server's piped
 * stdio: the pipes keep the event loop alive and the script hangs after its last line with
 * every file already written, which reads as a stall rather than as a finished run.
 */
export function finish(code: number): never {
  process.exit(code);
}
