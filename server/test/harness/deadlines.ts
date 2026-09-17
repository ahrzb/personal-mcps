// deadlines.ts — the suite's one timing lever: the hub's five configurable deadlines, set
// SHORT for the rows that watch them, through the worker's own env bindings.
//
// The hub reads each of these at the moment it arms the timer (limits.deadlines), from the
// same env object `cloudflare:test` hands the test — one object per isolate, shared by the
// fetch handler and by every Durable Object instance, whether it was constructed before or
// after the write (measured in both the `worker` and `tunnel` pools, 2026-09-17). So
// setting a binding here reaches the hub's next timer and nothing else.
//
// This fakes nothing on §9's never-faked list: no sibling module, no D1, no AppConnection
// DO, no WebCrypto, no MCP SDK is replaced, and `globalThis` is not touched. The hub still
// runs its own deadline code and still enforces a deadline; it is a shorter one — the
// strategy's "shrink the constant, never wait it out", now applied to the constant itself
// rather than to the timer primitive underneath it.
//
// WHY THE RESTORE IS A DELETE and never a captured value: the lever this replaced patched
// `globalThis.setTimeout` and restored "whatever was there", and two installs whose lifetimes
// overlapped restored out of order and left a patched timer behind for the next file (the
// 2026-09-17 §21 stream flake). Absence is the production default, so restoring TO absence
// is idempotent and order-independent — the failure mode has nowhere to live.

import { DEADLINE_ENV } from "../../src/limits";
import type { Deadlines } from "../../src/limits";

/** The deadlines a case shortens, by their `limits.Deadlines` names, in milliseconds. */
export type DeadlineOverrides = Partial<Deadlines>;

/**
 * Set the named deadlines for the duration of `body` — the wrapper form, for a case that
 * owns its own shortened window.
 */
export async function withDeadlines<T>(
  env: object,
  overrides: DeadlineOverrides,
  body: () => Promise<T>,
): Promise<T> {
  const restore = setDeadlines(env, overrides);
  try {
    return await body();
  } finally {
    restore();
  }
}

/**
 * The same setting as an install/restore pair, for a file that runs shortened throughout:
 * `beforeAll(() => setDeadlines(env, …))` hands vitest the restore as the hook's teardown.
 */
export function setDeadlines(env: object, overrides: DeadlineOverrides): () => void {
  const bag = env as Record<string, string | undefined>;
  const names = Object.entries(overrides).map(([key, ms]) => {
    const name = DEADLINE_ENV[key as keyof Deadlines];
    bag[name] = String(ms);
    return name;
  });
  return () => {
    for (const name of names) delete bag[name];
  };
}
