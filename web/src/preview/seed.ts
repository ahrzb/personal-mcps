import type { Transient } from "./transient";

/**
 * One state of one page, as the gallery reproduces it.
 *
 * A seed is NOT just API response data, which is the mistake this shape exists to prevent:
 * several of `server/dev/fixtures.ts`' states are not query results at all. So it has four
 * channels, and a state that needs one of the last three must say so explicitly.
 */
export type Seed = {
  /**
   * The query cache, success AND failure. The failure channel is load-bearing: an "unread"
   * catalog is an ERROR (a 503 carrying `unread`), not empty data, and a seed that could
   * only express data would make the two indistinguishable — which is the one distinction
   * `gateway.ownerCatalog` exists to keep.
   */
  queries: {
    key: readonly unknown[];
    data?: unknown;
    error?: { status: number; body: unknown };
  }[];
  /**
   * The app URL this state renders at, path only — `/apps`, `/apps/news/roles`,
   * `/agents/ci/apps/news`. Required, because which route is open IS part of the state: the
   * rail's `aria-current`, the narrow level and the pane switch are all functions of it, and
   * a gallery that guessed would be showing something the app never renders.
   */
  path: string;
  /** Router state: `?confirm=`, `?sel=`, `?q=`, `?show=`, `?which=`, `?new=` — the
   *  URL-addressed dialogs and selections. Absent means the bare route. */
  search?: Record<string, string | string[]>;
  /** Transient component state that no resource returns. See `./transient.ts` for why these
   *  four exist and nothing else does. */
  transient?: Transient;
  /**
   * API paths this state leaves IN FLIGHT — `/api/hub` prefixes the gallery's client answers
   * with a promise that never settles, instead of the throw an unseeded path gets.
   *
   * The one way to show a LOADING state, and the reason it is a channel of its own rather than a
   * missing seed: an unseeded read rejects, so the component would render its failure card, and
   * a skeleton is a different screen from an error. `/audit`'s loading skeleton and its record
   * skeleton are both this, and both are states §13 pins.
   */
  hanging?: string[];
  /**
   * A read this state ANSWERS ITSELF, after a delay — the gallery's only way to show a page
   * that REFETCHES.
   *
   * It exists because the absence of it hid a shipped bug (postmortem 2026-09-21). Every other
   * channel is a cache entry: seeded, permanently fresh, behind a client that throws on
   * anything unseeded. A state that types into a search box changes the query key, and the
   * read for the new key could only ever reject — so the screen a reader actually sees while
   * searching was never rendered here before it reached the owner.
   *
   * Returns null for a path this state does not answer, which then falls through to `hanging`
   * and finally to the throw, so an incomplete seed still fails loudly.
   */
  respond?: (path: string) => { delayMs: number; data: unknown } | null;
};

/**
 * The seven migrated pages, keyed exactly as `server/dev/preview.ts` keys them — so a state
 * name in this gallery and a fixture name in that one are the same string, which is what
 * lets `visual-compare.mts` pair a screenshot with its baseline by filename.
 *
 * `audit` is the exception to "keyed as that one keys them": the server-rendered page it
 * replaces had entirely different states, so its baselines are written from this gallery's
 * own accepted render rather than inherited (§5, decision 36).
 */
export const PREVIEW_PAGES = [
  "apps",
  "app-detail",
  "app-new",
  "agents",
  "agent-detail",
  "agent-new",
  "audit",
] as const;

export type PreviewName = (typeof PREVIEW_PAGES)[number];

/**
 * Every page's every state. `Record<PreviewName, …>` rather than a partial, so a page added
 * without seeds is a TYPE ERROR — the property `server/dev/preview.ts` provides with its own
 * `Record<PageName, FC>`, and the reason its index can never silently lag the pages.
 */
export type PreviewSeeds = Record<PreviewName, Record<string, Seed>>;
