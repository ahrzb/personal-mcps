/**
 * limits.deadlines — the durations the hub reads from its env instead of from a
 * constant, so a test can shorten the one it watches without patching anything global.
 *
 * What is pinned here is the PARSE, which is the whole of the seam's logic: a binding is a
 * duration only when it is a positive integer count of milliseconds, and everything else is
 * the production constant. That direction matters more than it looks — the failure this
 * rejects is a mistyped binding silently DISARMING a deadline (a `0`, a `-1`, an empty
 * string from a shell that expanded nothing), which in production would turn a 30-second
 * budget into an instant timeout on every call, and in a test would turn a red row green.
 *
 * deps: src/limits (deadlines, DEADLINE_ENV, and the constants it defaults to)
 */

import { describe, expect, it } from "vitest";
import {
  AGGREGATED_LIST_DEADLINE_MS,
  CALL_TIMEOUT_MS,
  DEADLINE_ENV,
  HUB_CATALOG_FAMILY_DEADLINE_MS,
  LISTEN_BELL_MIN_INTERVAL_MS,
  LISTEN_KEEPALIVE_MS,
  REGISTRATION_DEADLINE_MS,
  deadlines,
} from "../../src/limits";

/** The production answer: what an env with none of the bindings must yield. */
const DEFAULTS = {
  callTimeoutMs: CALL_TIMEOUT_MS,
  aggregatedListDeadlineMs: AGGREGATED_LIST_DEADLINE_MS,
  registrationDeadlineMs: REGISTRATION_DEADLINE_MS,
  listenKeepaliveMs: LISTEN_KEEPALIVE_MS,
  listenBellMinIntervalMs: LISTEN_BELL_MIN_INTERVAL_MS,
  hubCatalogDeadlineMs: HUB_CATALOG_FAMILY_DEADLINE_MS,
} as const;

describe("limits.deadlines", () => {
  it("an env with none of the bindings is the production constants, exactly — this is what wrangler.jsonc sets and therefore what ships", () => {
    expect(deadlines({})).toEqual(DEFAULTS);
  });

  it("every deadline has its OWN binding, and setting one moves only that one — a lever that moved two would let a row watch the wrong duration", () => {
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const name = DEADLINE_ENV[key as keyof typeof DEFAULTS];
      const got = deadlines({ [name]: "40" } as Record<string, string>);
      expect(got[key as keyof typeof DEFAULTS], `${name} did not reach ${key}`).toBe(40);
      expect(
        { ...got, [key]: fallback },
        `${name} moved something other than ${key}`,
      ).toEqual(DEFAULTS);
    }
  });

  it("the binding names are distinct and PMCP_-prefixed, so none can collide with a wrangler var the hub already reads", () => {
    const names = Object.values(DEADLINE_ENV);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("PMCP_") && n.endsWith("_MS"))).toBe(true);
  });

  // A string that is not a positive integer count of milliseconds is not a duration. Each
  // of these is a real way the binding arrives wrong, and every one of them must land on
  // the constant rather than on whatever `Number()` happened to produce — "0" and "-1" are
  // the dangerous pair, because obeying either disarms the deadline instead of shortening
  // it, and "1e3"/" 40 " are the pair that would be tempting to accept.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "40.5"],
    ["NaN", "soon"],
    ["Infinity", "Infinity"],
    ["with a unit", "40ms"],
  ])("a %s PMCP_CALL_TIMEOUT_MS is ignored, not obeyed — the constant stands", (_label, raw) => {
    expect(deadlines({ PMCP_CALL_TIMEOUT_MS: raw }).callTimeoutMs).toBe(CALL_TIMEOUT_MS);
  });

  it("a positive integer is taken verbatim, including one LONGER than the constant — the seam is configuration, not a cap", () => {
    expect(deadlines({ PMCP_CALL_TIMEOUT_MS: "1" }).callTimeoutMs).toBe(1);
    expect(deadlines({ PMCP_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS * 2) }).callTimeoutMs).toBe(
      CALL_TIMEOUT_MS * 2,
    );
  });

  // `Number()` is the parse, deliberately: the value it is lenient about — surrounding
  // whitespace, an exponent — is still a positive integer count of milliseconds, so
  // accepting it costs nothing, and the strings it is NOT lenient about are exactly the
  // ones that would disarm a deadline (the block above). A regex here would buy a stricter
  // spelling of the same set of accepted DURATIONS.
  it.each([
    ["padded", " 40 ", 40],
    ["an exponent", "1e3", 1000],
  ])("%s PMCP_CALL_TIMEOUT_MS still names a positive whole number of ms, and is taken", (
    _label,
    raw,
    ms,
  ) => {
    expect(deadlines({ PMCP_CALL_TIMEOUT_MS: raw as string }).callTimeoutMs).toBe(ms);
  });

  it("reads the env AT THE CALL — the same object mutated between two calls gives two answers, which is what lets a row shorten a deadline the hub has already been running with", () => {
    const env: { PMCP_CALL_TIMEOUT_MS?: string } = {};
    expect(deadlines(env).callTimeoutMs).toBe(CALL_TIMEOUT_MS);
    env.PMCP_CALL_TIMEOUT_MS = "40";
    expect(deadlines(env).callTimeoutMs).toBe(40);
    delete env.PMCP_CALL_TIMEOUT_MS;
    expect(deadlines(env).callTimeoutMs).toBe(CALL_TIMEOUT_MS);
  });
});
