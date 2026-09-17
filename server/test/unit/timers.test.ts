// timers.test.ts — the suite's timer lever restores to the module ORIGINALS, so two
// overlapping installs (vitest abandons a case at testTimeout but its body keeps running)
// collapse onto the real setTimeout instead of leaving a shrunk one behind for every later
// case and file (2026-09-17: the mechanism behind the §21 stream rows going red under load).
import { describe, expect, it } from "vitest";
import { shrinkTimers } from "../harness/timers";

describe("harness · shrinkTimers", () => {
  it("§16 · two overlapping installs restored in the wrong order still leave the REAL setTimeout and AbortSignal.timeout behind · the twin: while installed, a mapped duration is the shrunk one", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realAbortTimeout = AbortSignal.timeout;
    const map = new Map([[30_000, 5]]);

    const first = shrinkTimers(map);
    const second = shrinkTimers(map);
    // The twin, on the installed lever: a 30 s timer fires in milliseconds.
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    expect(Date.now() - started).toBeLessThan(1_000);

    // The order a timed-out case produces: the FIRST install's restore lands after the
    // second install, then the second's — and neither may put a patched timer back.
    first();
    second();
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(AbortSignal.timeout).toBe(realAbortTimeout);
  });
});
