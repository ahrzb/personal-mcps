/**
 * The gallery's frozen clock.
 *
 * The server fixtures (`seed.ts`) rendered against a fixed instant carried in props, and the
 * baselines were shot that way; the client formats against the browser's own clock. Left
 * alone, every relative label — "12m ago", "3h", "expires in 48m" — would differ from its
 * baseline for a reason that is not styling, and the comparison would report it every run.
 *
 * So the gallery overrides `Date.now` and the `Date` constructor's zero-argument form to the
 * same instant the fixtures use, BEFORE the app mounts. The screenshot scripts pin
 * `timezoneId: "UTC"` and `locale: "en-US"` on the browser context for the other half of the
 * same problem.
 *
 * Only the gallery ever calls this. It is a module in `src/preview/`, which the production
 * build drops entirely.
 */

/** The instant the server fixtures rendered against (their `NOW`): 17 minutes after the
 *  oldest pending approval, which is what makes its relative labels the ones they are. */
export const FROZEN_NOW = Date.parse("2026-08-24T14:47:00.000Z");

/**
 * Replaces the global clock. Irreversible within a page load, deliberately: a gallery that
 * could un-freeze would be a gallery whose screenshots depend on when they were taken.
 */
export function freezeClock(at: number = FROZEN_NOW): void {
  const RealDate = Date;
  // `Date.now()` is the reading nearly everything goes through — the formatters take `now`
  // explicitly, but TanStack Query stamps its own cache entries and React's scheduler reads
  // it too, so pinning it is what keeps a render deterministic rather than merely the labels.
  const frozen = function Frozen(this: unknown, ...args: unknown[]): unknown {
    // `new Date()` with no arguments is the only form that reads the clock; every other form
    // is a parse or a construction and must behave exactly as before.
    return args.length === 0
      ? new RealDate(at)
      : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  // `prototype` is read-only on a function TYPE, not at runtime — and it has to be the real
  // one, or `instanceof Date` fails for everything the app constructs.
  Object.defineProperty(frozen, "prototype", { value: RealDate.prototype });
  frozen.now = () => at;
  frozen.parse = RealDate.parse;
  frozen.UTC = RealDate.UTC;
  globalThis.Date = frozen;
}
