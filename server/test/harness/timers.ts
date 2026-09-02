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
  const realSetTimeout = globalThis.setTimeout;
  const realAbortTimeout = AbortSignal.timeout;
  const shrink = (ms: number): number => map.get(ms) ?? ms;
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    (realSetTimeout as (...args: unknown[]) => unknown)(
      handler,
      typeof ms === "number" ? shrink(ms) : ms,
      ...rest,
    )) as typeof globalThis.setTimeout;
  AbortSignal.timeout = ((ms: number) =>
    realAbortTimeout.call(AbortSignal, shrink(ms))) as typeof AbortSignal.timeout;
  return () => {
    globalThis.setTimeout = realSetTimeout;
    AbortSignal.timeout = realAbortTimeout;
  };
}
