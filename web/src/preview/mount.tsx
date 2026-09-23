import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { freezeClock } from "./clock";
import { PREVIEW_PAGES } from "./seed";
import type { PreviewName, Seed } from "./seed";
import { seeds } from "./fixtures";
import { TransientProvider } from "./transient";
import { AppEnvProvider } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import type { ApiClient } from "@/lib/http";
import { parseSearch, routeTree, stringifySearch } from "@/router";

/**
 * The React state gallery — the living demo of every screen and component STATE of every
 * page, read beside the design boards as the reference for what a state looks like. It
 * replaced the server preview page by page (decision 38; `seed.ts` says what that was), and
 * it is what `scripts/visual-compare.mts` screenshots.
 *
 *   GET /__preview                   — an index linking every page × state pair
 *   GET /__preview/<page>/<state>    — that page, rendered against that state's seed
 *
 * PREVIEW MODE ONLY. `main.tsx` reaches this module behind `import.meta.env.MODE ===
 * "preview"`, which Vite replaces with a literal at build time, so Rollup drops this whole
 * subtree — and the fixtures with it — out of the production bundle.
 *
 * It mounts the REAL route tree over a memory history at the seeded URL, not the page
 * components directly. That is the point: the rail's `aria-current`, the level attribute, the
 * `?confirm=` dialogs and the pane switch are all functions of the route, so a gallery that
 * bypassed the router would be showing something the app never renders.
 */

/**
 * The gallery's whole entry point.
 *
 * A function CALLED AT THE END of this module rather than top-level statements at the top:
 * `const` declarations below are in their temporal dead zone until the module body has run
 * past them, so a dispatch written up here reads `BOOTSTRAP` before initialization and the
 * page renders nothing at all.
 */
function main(): void {
  freezeClock();
  const root = document.getElementById("root");
  if (root === null) throw new Error("pmcp: the preview document carries no #root");

  const match = /^\/__preview\/([^/]+)\/(.+?)\/?$/.exec(location.pathname);
  if (match === null) {
    root.innerHTML = indexHtml();
    return;
  }
  const name = match[1] as PreviewName;
  const state = decodeURIComponent(match[2] ?? "");
  const page = seeds[name] as Record<string, Seed> | undefined;
  const seed = page?.[state];
  if (seed === undefined) root.textContent = `No such preview: ${match[1]}/${state}`;
  else mount(root, name, state, seed);
}

/**
 * One state, rendered. Everything that could reach the network is closed off rather than
 * merely slowed: the query client retries nothing and treats every entry as permanently
 * fresh, and the API client throws on any call the seed did not answer — so an incomplete
 * seed shows up as a visible failure rather than as a silent hang or a real request.
 */
function mount(target: HTMLElement, name: PreviewName, state: string, seed: Seed): void {
  const client = new QueryClient({
    defaultOptions: {
      // `retryOnMount: false` is what lets a seeded FAILURE stand: a query in error with no
      // data is otherwise refetched the moment a component mounts it, and that refetch meets
      // the refusing client below — so the page drew "unseeded request to …" instead of its
      // own failure copy (found 2026-09-23; /audit's baselines had captured it).
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
  for (const entry of seed.queries) {
    if (entry.error === undefined) {
      client.setQueryData(entry.key, entry.data);
      continue;
    }
    // A FAILURE seed, and the reason `Seed.queries` carries an error channel at all: an
    // unread catalog is a 503 carrying `unread`, which is a different screen from an empty
    // one. Pushed into the cache entry's own error state, so the component reads it exactly
    // as it reads a real refusal. The entry is BUILT first: `setQueryData(key, undefined)`
    // creates nothing, so the state used to land on no query at all.
    const cached = client.getQueryCache().build(client, client.defaultQueryOptions({ queryKey: entry.key }));
    cached.setState({ ...cached.state, status: "error", error: refusalOf(entry.error), fetchStatus: "idle" });
  }

  // /login's island, written where the Worker writes it, so the page's own read finds it.
  if (seed.loginIsland !== undefined) {
    const island = document.createElement("script");
    island.type = "application/json";
    island.id = "pmcp-login";
    island.textContent = JSON.stringify(seed.loginIsland);
    document.body.append(island);
  }

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [urlOf(seed)] }),
    defaultPreload: false,
    // The SAME codec the app's own router uses, or a seeded `?calls=40` would arrive at the
    // page as the number 40 and the gallery would be showing a screen the app never draws.
    parseSearch,
    stringifySearch,
  });

  createRoot(target).render(
    <StrictMode>
      <AppEnvProvider value={{ api: refusingClient(name, state, seed.hanging ?? [], seed.respond), bootstrap: BOOTSTRAP }}>
        <QueryClientProvider client={client}>
          <TransientProvider value={seed.transient ?? {}}>
            <RouterProvider router={router} />
          </TransientProvider>
        </QueryClientProvider>
      </AppEnvProvider>
    </StrictMode>,
  );
}

/** The URL a seed names: its own `path`, plus its `search` as a query string. */
function urlOf(seed: Seed): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(seed.search ?? {})) {
    if (Array.isArray(value)) for (const each of value) search.append(key, each);
    else search.set(key, value);
  }
  const query = search.toString();
  return `${seed.path}${query === "" ? "" : `?${query}`}`;
}

/**
 * The bootstrap a gallery render stands on. Obviously fake, like the fixtures' own CSRF
 * value: nothing here submits anything, and a token is opaque to every component.
 *
 * `origin` is the one field that has to be EXACT rather than plausible. The surfaces build a
 * scoped endpoint URL from it, and the server fixtures (`seed.ts`) rendered those against
 * `https://hub.example` — so any other value changes a line's length and, at 390px, its
 * wrapping. Same reason the clock is frozen: a screenshot must not depend on where it was
 * taken from.
 */
const BOOTSTRAP = {
  csrf: "csrf_FAKE0000d41d8cd98f00b204e9800998",
  username: "ahrzb",
  origin: "https://hub.example",
  // The server fixtures' own obviously-fake key. Never drawn — the push control only
  // hands it to `PushManager.subscribe` on a click no gallery render makes.
  vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
} as const;

/**
 * An API client that answers nothing. A gallery render is a function of its seed, so a call
 * that escapes it is a seed that is incomplete — and a throw says so, where a stub that
 * resolved `{}` would quietly render an empty screen and be mistaken for a state.
 *
 * Two deliberate exceptions, tried in order. `respond` ANSWERS a path late, which is the only
 * way to show a page that refetches — what a seeded cache structurally cannot do. `hanging`
 * leaves a path in flight forever, which is the only way to hold a component in its loading
 * state. Everything else still throws, so an incomplete seed fails loudly.
 */
function refusingClient(
  name: string,
  state: string,
  hanging: string[],
  respond: Seed["respond"],
): ApiClient {
  const answer = <T,>(path: string, body?: unknown): Promise<T> => {
    // Every call this client handles, recorded for a browser walk to count. The gallery's reads
    // never reach the network — `respond` answers them in-page — so `page.on("request")` sees
    // nothing, and "how many times did that burst of typing read the window?" has no other
    // answer. Dev-only, like everything in this module.
    ((globalThis as unknown as { __pmcpReads?: string[] }).__pmcpReads ??= []).push(path);
    const answered = respond?.(path, body) ?? null;
    if (answered !== null) {
      return new Promise<T>((resolve) => setTimeout(() => resolve(answered.data as T), answered.delayMs));
    }
    return hanging.some((prefix) => path.startsWith(prefix))
      ? new Promise<T>(() => undefined)
      : Promise.reject(new Error(`preview ${name}/${state}: unseeded request to ${path}`));
  };
  return { get: answer, post: answer, put: answer };
}

/** A seeded failure as the client's own error type, so a pane's `instanceof ApiError` test
 *  and its `unread` branch behave exactly as they do against the real surface. */
function refusalOf(error: { status: number; body: unknown }): ApiError {
  const body = error.body;
  const described = typeof body === "object" && body !== null;
  const reason =
    described && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : `The request failed (${error.status}).`;
  return new ApiError(error.status, reason, {
    unread: described && "unread" in body && body.unread === true,
  });
}

/** The index: every pair, grouped by page, in the fixtures' own order. Plain HTML rather
 *  than a component — it is a directory, not a screen, and `visual-compare.mts` reads its
 *  links to discover what to screenshot. */
function indexHtml(): string {
  const sections = PREVIEW_PAGES.map((name) => {
    const links = Object.keys(seeds[name])
      .map((state) => `<li><a href="/__preview/${name}/${state}">${state}</a></li>`)
      .join("");
    return `<section><h2>${name}</h2><ul>${links}</ul></section>`;
  }).join("");
  return `<h1>personal-mcps — state gallery</h1><style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px}
h2{margin-top:2em} ul{padding-left:1.2em} a{color:#2563eb}</style>${sections}`;
}

main();
