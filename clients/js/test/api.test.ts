/**
 * clients/js/test/api.test.ts — the JS client library's PURE halves: the three
 * author-facing functions that never touch a socket (`caller`, `secret`,
 * `sensitive` — §7's caller-identity and sensitive-field affordances, §11) plus
 * the reconnect schedule `backoffDelay` (§6), which is exported pure precisely
 * so its doubling, cap, and jitter bounds are a table instead of a property of a
 * live loop (strategy §11, nudge N2).
 *
 * Project: `scripts` + clients (plain Node, parallel). Nothing here dials, sleeps,
 * or reads a clock — `rng` is injected, so the schedule is deterministic
 * arithmetic. Cases share nothing and may run in any order. (Strategy §3's unit
 * table lists this file under `unit` — every function it pins is a pure seam
 * whose deps line reads `none`, which is that project's whole admission rule —
 * while §2's project table files the client libraries under `scripts` + clients.
 * Both are the same Node-parallel semantics, so the eventual config picks one;
 * nothing here depends on which, and cli/test/plan.test.ts records the identical
 * ambiguity. What the picked project must NOT be is `worker` or `tunnel`: this
 * suite deliberately never enters workerd.)
 *
 * What this suite must NOT drift into: transport behavior. Whether the reconnect
 * loop actually waits backoffDelay's answer belongs to transport.test.ts against
 * the fake hub; this file pins only the number it is handed.
 *
 * Durable vs incidental (§7): durable are the marking semantics (writeOnly at the
 * named path, both schema directions, original never mutated, values untouched),
 * the wildcard rule in hasRole, and the schedule's shape — doubling, the cap, and
 * that attempt 0 jitters from zero. Incidental: the 1 s base and 60 s cap as
 * literals, which live in the rows and nowhere else, so retuning the schedule
 * edits data and no assertion logic.
 *
 * Cross-language duplication, deliberate (strategy §3): clients/py's
 * `tests/test_api.py` holds the same schedule table against `backoff_delay`. The
 * two tables are transcriptions of one oracle — §6's schedule sentence — and
 * differ in units: this one is MILLISECONDS, Python's is SECONDS. Nothing shared
 * at runtime; that is the point.
 */

// deps: none (pure — no fake hub, no fixtures) · clients/js/src/index.ts (caller, secret, sensitive, backoffDelay)

import { describe, it } from "vitest";
import type { CallerIdentity } from "../src/index";

describe("caller() · §7 \"Caller identity forwarding\"", () => {
  it.todo("§7 · hub/principal and hub/roles are read off _meta into principal and roles, with roles kept exactly as granted (never expanded)");
  it.todo("§7 · hasRole(x) is true when roles contains x, false for a role not granted — the twin pair in one case");
  it.todo("§7 · hasRole(anything) is true when roles contains \"all\", so an owner ([\"all\"]) and an all-granted account behave identically in service code");
  it.todo("§7 · a request that never passed through the hub — _meta absent, or present without hub/* keys — yields principal \"\", empty roles, and a uniformly false hasRole: no error for the author to handle");
  it.todo("§7 · a consumer-shaped forgery is not this library's problem to detect: what arrives under hub/* is read verbatim, because the hub strips inbound copies before injecting its own (the trust argument lives server-side)");
});

describe("secret() and sensitive() · §7 \"Sensitive-field redaction\", §11", () => {
  it.todo("§7 · secret(schema) emits writeOnly: true at that node — inside a tool's INPUT shape and its OUTPUT shape alike (the hub reads both directions)");
  it.todo("§7 · secret() returns a derived schema: the schema passed in is unchanged, and a second call on the same input is independent");
  it.todo("§7 · secret() is schema-only — a marked field validates and serializes exactly as the wrapped schema does, so real values still cross the wire and the HUB does the masking (§15)");
  it.todo("§7 · sensitive(schema, [\"password\", \"credentials.token\"]) sets writeOnly at a top-level property and at a dot-path, on an input schema and an output schema alike");
  it.todo("§7 · sensitive() copies — the original object is not mutated at any depth");
  it.todo("§7 · a path naming no property in the schema is a TypeError: a silent typo would quietly persist a secret; twin: the correctly spelled path in the same schema marks it");
});

describe("backoffDelay() · §6 \"Reconnect\"", () => {
  it.todo("the schedule is the table below — one case per row, no bespoke assertions");
});

/**
 * One row of §6's reconnect schedule, as data.
 *
 * The columns are the whole design: `attempt` and a FIXED `rng` draw make the
 * answer exact, so the runner is a single equality and never re-implements the
 * arithmetic (which would make the test a second implementation of the schedule
 * — strategy §5's rejected "model of the same rules"). Jitter bounds are
 * expressed as pairs of rows at the same attempt (draw 0 and a draw just under
 * 1), never as an inequality in code; the cap is a row at a large attempt; the
 * deploy-storm mitigation is the attempt-0 row whose draw of 0 yields 0.
 *
 * `expectedMs` is milliseconds — the JS library's unit. Python's mirror of this
 * table is in seconds.
 */
export type BackoffRow = {
  /** spec reference printed in the case title, e.g. "§6 · attempt 0 jitters from zero" */
  spec: string;
  /** consecutive failures, 0-based — backoffDelay's first argument */
  attempt: number;
  /** the fixed [0,1) value the seeded stub returns for this row */
  rng: number;
  /** the exact delay for that draw, in milliseconds */
  expectedMs: number;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy
 * §9 rule 1) — agents never fill them. The oracle is §6's schedule sentence
 * ("exponential backoff with jitter, 1 s → 60 s cap, forever") plus §11's
 * jitter-from-zero decision, read from the spec alone and never from the
 * implementation.
 */
export const backoffRows: readonly BackoffRow[] = [];

/**
 * The table runner: one case per row, titled with the row's `spec` so a failure
 * names the sentence to re-read (strategy §8). It calls backoffDelay with a stub
 * rng that returns the row's draw and compares to `expectedMs` — that is the
 * entire assertion logic for the schedule, so a retune is a row edit with zero
 * test churn.
 */
export function runBackoffTable(rows: readonly BackoffRow[]): void {
  // deps: clients/js/src/index.ts (backoffDelay)
  throw new Error("unimplemented");
}

/**
 * What one caller() case expects, spelled against the library's own type so a
 * change to CallerIdentity breaks here rather than in every case body. `hasRole`
 * carries both directions — a role that must answer true and one that must
 * answer false — because a hasRole that returns true for everything satisfies a
 * true-only expectation (strategy §9 rule 2, applied in miniature).
 */
export type CallerExpectation = {
  principal: CallerIdentity["principal"];
  roles: readonly string[];
  hasRole: Readonly<Record<string, boolean>>;
};
