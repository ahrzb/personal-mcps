// timers.ts — the suite's one timer lever: named worker durations, mapped to test-run ones.
//
// Why a map keyed by an EXACT millisecond value rather than a mock of limits.ts: `vi.mock`
// reaches the test file's own import and does NOT reach the hub's modules inside workerd
// (upstream-proxy.test.ts's header note has the measurement), so the only surface the test
// and the hub share in these pools is `globalThis` — and on globalThis a duration has no
// name, only a value. Exactness is what keeps that honest: `30_000` becomes the mapped
// value and every other timer in the worker keeps the duration it asked for, so a row that
// believes it watched CALL_TIMEOUT_MS cannot have watched something merely longer.
//
// Two patches, because the hub spells a deadline two ways: `setTimeout` (gateway.ts's
// `withDeadline` around each upstream in a fan-out, and the listen keepalive) and
// `AbortSignal.timeout` (upstream.ts's three dials). Installed together and restored
// together, so no caller has to know which one its case reaches.
//
// This fakes nothing on §9's never-faked list — no sibling module, no D1, no AppConnection
// DO, no WebCrypto, no MCP SDK is replaced. The hub still runs its own deadline code and
// still enforces a deadline; it is a shorter one, which is the strategy's "shrink the
// constant, never wait it out" applied where the constant can actually be reached.

/**
 * Map the named durations for the duration of `body` — the wrapper form, for a case that
 * owns its own shrunk window.
 */
export async function withShrunkTimers<T>(
  map: ReadonlyMap<number, number>,
  body: () => Promise<T>,
): Promise<T> {
  const restore = shrinkTimers(map);
  try {
    return await body();
  } finally {
    restore();
  }
}

/**
 * The same mapping as an install/restore pair, for a file that shrinks for its whole run:
 * `beforeAll(() => shrinkTimers(map))` hands vitest the restore as the hook's teardown.
 */
export function shrinkTimers(map: ReadonlyMap<number, number>): () => void {
  const shrink = (ms: number): number => map.get(ms) ?? ms;
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    (REAL_SET_TIMEOUT as (...args: unknown[]) => unknown)(
      handler,
      typeof ms === "number" ? shrink(ms) : ms,
      ...rest,
    )) as typeof globalThis.setTimeout;
  AbortSignal.timeout = ((ms: number) =>
    REAL_ABORT_TIMEOUT.call(AbortSignal, shrink(ms))) as typeof AbortSignal.timeout;
  return () => {
    globalThis.setTimeout = REAL_SET_TIMEOUT;
    AbortSignal.timeout = REAL_ABORT_TIMEOUT;
  };
}

/**
 * The genuine originals, captured ONCE when this module loads — never at install time, and
 * called through rather than merely restored to.
 *
 * Install time is wrong because two installs can overlap, and in this suite they routinely
 * do: vitest abandons a case at `testTimeout` but the case's BODY keeps running, so its
 * `finally` restore lands only after the NEXT case has already installed. An install that
 * captured "whatever setTimeout is right now" would then capture the previous case's PATCHED
 * one and put it back as if it were real — leaving every later case, and (this project runs
 * `isolate: false`) every later FILE in the tunnel project, silently running with a 30 s
 * budget shrunk to milliseconds. That is how one timed-out row in stream.test.ts turned into
 * unrelated red rows in the file that runs after it, and why a suite that was green per file
 * was red in a different place on every full run.
 *
 * Restoring to the module originals collapses any overlap onto the same correct end state.
 * It costs nesting, which nothing here does: a row shrinks once, around its whole body.
 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_ABORT_TIMEOUT = AbortSignal.timeout;
