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

import { describe, expect, it } from "vitest";
import { backoffDelay, caller, secret, sensitive } from "../src/index";
import type { CallerIdentity } from "../src/index";

/** A tool's schema as a hand-written JSON Schema node — what `sensitive()` takes. */
function schemaWithSecrets(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      password: { type: "string" },
      credentials: { type: "object", properties: { token: { type: "string" }, user: { type: "string" } } },
    },
  };
}

describe("caller() · §7 \"Caller identity forwarding\"", () => {
  it("§7 · hub/principal and hub/roles are read off _meta into principal and roles, with roles kept exactly as granted (never expanded)", () => {
    const identity = caller({ "hub/principal": "agent:claude", "hub/roles": ["all"] });
    expect(identity.principal).toBe("agent:claude");
    // `all` arrives literally; it is never expanded into the app's declared names.
    expect(identity.roles).toEqual(["all"]);
  });

  it("§7 · hasRole(x) is true when roles contains x, false for a role not granted — the twin pair in one case", () => {
    const identity = caller({ "hub/principal": "agent:cron", "hub/roles": ["reader"] });
    expect(identity.hasRole("reader")).toBe(true);
    expect(identity.hasRole("editor")).toBe(false);
  });

  it("§7 · hasRole(anything) is true when roles contains \"all\", so an owner ([\"all\"]) and an all-granted agent behave identically in app code", () => {
    const owner = caller({ "hub/principal": "user:ada", "hub/roles": ["all"] });
    const granted = caller({ "hub/principal": "agent:claude", "hub/roles": ["all"] });
    for (const identity of [owner, granted]) {
      expect(identity.hasRole("editor")).toBe(true);
      expect(identity.hasRole("anything-at-all")).toBe(true);
    }
  });

  it("§7 · a request that never passed through the hub — _meta absent, or present without hub/* keys — yields principal \"\", empty roles, and a uniformly false hasRole: no error for the author to handle", () => {
    const expectation: CallerExpectation = { principal: "", roles: [], hasRole: { reader: false, all: false } };
    for (const meta of [undefined, {}, { "io.modelcontextprotocol/clientCapabilities": {} }]) {
      const identity = caller(meta);
      expect(identity.principal).toBe(expectation.principal);
      expect(identity.roles).toEqual(expectation.roles);
      for (const [role, answer] of Object.entries(expectation.hasRole)) {
        expect(identity.hasRole(role)).toBe(answer);
      }
    }
  });

  it("§7 · a consumer-shaped forgery is not this library's problem to detect: what arrives under hub/* is read verbatim, because the hub strips inbound copies before injecting its own (the trust argument lives server-side)", () => {
    const identity = caller({ "hub/principal": "user:root", "hub/roles": ["all"], "hub/forged": true });
    expect(identity.principal).toBe("user:root");
    expect(identity.hasRole("admin")).toBe(true);
  });
});

describe("secret() and sensitive() · §7 \"Sensitive-field redaction\", §11", () => {
  it("§7 · secret(schema) emits writeOnly: true at that node — inside a tool's INPUT shape and its OUTPUT shape alike (the hub reads both directions)", () => {
    const input = secret({ type: "string", description: "the upstream api key" });
    const output = secret({ type: "string" });
    expect(input).toMatchObject({ type: "string", description: "the upstream api key", writeOnly: true });
    expect(output).toMatchObject({ type: "string", writeOnly: true });
  });

  it("§7 · secret() returns a derived schema: the schema passed in is unchanged, and a second call on the same input is independent", () => {
    const original = { type: "string" };
    const marked = secret(original);
    expect(original).toEqual({ type: "string" });
    expect(marked).not.toBe(original);
    expect(secret(original)).not.toBe(marked);
  });

  it("§7 · secret() is schema-only — a marked field validates and serializes exactly as the wrapped schema does, so real values still cross the wire and the HUB does the masking (§15)", () => {
    // A zod-shaped schema: the derived value keeps the parser, so the runtime value is
    // untouched — marking is metadata, never a transform.
    const zodLike = {
      parse: (value: unknown) => value,
      meta(data: Record<string, unknown>) {
        return { ...this, ...data };
      },
    };
    const marked = secret(zodLike) as typeof zodLike & { writeOnly?: boolean };
    expect(marked.writeOnly).toBe(true);
    expect(marked.parse("hunter2")).toBe("hunter2");
  });

  it("§7 · sensitive(schema, [\"password\", \"credentials.token\"]) sets writeOnly at a top-level property and at a dot-path, on an input schema and an output schema alike", () => {
    for (const schema of [schemaWithSecrets(), schemaWithSecrets()]) {
      const marked = sensitive(schema, ["password", "credentials.token"]) as Record<string, any>;
      expect(marked.properties.password.writeOnly).toBe(true);
      expect(marked.properties.credentials.properties.token.writeOnly).toBe(true);
      // Only the named paths: a neighbour is left alone.
      expect(marked.properties.credentials.properties.user.writeOnly).toBeUndefined();
    }
  });

  it("§7 · sensitive() copies — the original object is not mutated at any depth", () => {
    const original = schemaWithSecrets();
    const before = structuredClone(original);
    sensitive(original, ["password", "credentials.token"]);
    expect(original).toEqual(before);
  });

  it("§7 · a path naming no property in the schema is a TypeError: a silent typo would quietly persist a secret; twin: the correctly spelled path in the same schema marks it", () => {
    expect(() => sensitive(schemaWithSecrets(), ["passwrod"])).toThrow(TypeError);
    expect(() => sensitive(schemaWithSecrets(), ["credentials.tokne"])).toThrow(TypeError);
    const marked = sensitive(schemaWithSecrets(), ["password"]) as Record<string, any>;
    expect(marked.properties.password.writeOnly).toBe(true);
  });
});

describe("backoffDelay() · §6 \"Reconnect\"", () => {
  runBackoffTable(backoffRows);
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
export const backoffRows: readonly BackoffRow[] = [
  {
    spec: "§6 · attempt 0, draw 0 · the very first retry may be immediate — jitter is drawn from zero, so a hub deploy's reconnect storm spreads out instead of every bot returning in the same second",
    attempt: 0,
    rng: 0,
    expectedMs: 0,
  },
  {
    spec: "§6 · attempt 0, draw just under 1 · the first window's ceiling is the 1 s base and no draw exceeds it — the twin that pins the other end of attempt 0's jitter",
    attempt: 0,
    rng: 0.999,
    expectedMs: 999,
  },
  {
    spec: "§6 · attempt 1, draw just under 1 · one consecutive failure later the ceiling has doubled to 2 s",
    attempt: 1,
    rng: 0.999,
    expectedMs: 1998,
  },
  {
    spec: "§6 · attempt 2, draw 0.5 · the draw scales the WHOLE window — half of the 4 s ceiling, not half of a fixed 4 s delay",
    attempt: 2,
    rng: 0.5,
    expectedMs: 2000,
  },
  {
    spec: "§6 · attempt 5, draw just under 1 · the doubling runs 1→2→4→8→16→32 s, the last ceiling still below the cap",
    attempt: 5,
    rng: 0.999,
    expectedMs: 31968,
  },
  {
    spec: "§6 · attempt 6, draw just under 1 · attempt 6's 64 s is clamped to the 60 s cap — the cap applies to the ceiling BEFORE the jitter is drawn, so no delay can exceed 60 s",
    attempt: 6,
    rng: 0.999,
    expectedMs: 59940,
  },
  {
    spec: "§6 · attempt 40, draw just under 1 · the cap holds arbitrarily far out: reconnect is forever, and the doubling neither overflows nor drifts past 60 s",
    attempt: 40,
    rng: 0.999,
    expectedMs: 59940,
  },
  {
    spec: "§6 · attempt 40, draw 0 · even at the cap the window still starts at zero — max backoff is a ceiling on the wait, never a floor under it",
    attempt: 40,
    rng: 0,
    expectedMs: 0,
  },
];

/**
 * The table runner: one case per row, titled with the row's `spec` so a failure
 * names the sentence to re-read (strategy §8). It calls backoffDelay with a stub
 * rng that returns the row's draw and compares to `expectedMs` — that is the
 * entire assertion logic for the schedule, so a retune is a row edit with zero
 * test churn.
 */
export function runBackoffTable(rows: readonly BackoffRow[]): void {
  // deps: clients/js/src/index.ts (backoffDelay)
  for (const row of rows) {
    it(row.spec, () => {
      expect(backoffDelay(row.attempt, () => row.rng)).toBe(row.expectedMs);
    });
  }
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
