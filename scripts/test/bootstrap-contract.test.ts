/**
 * scripts/test/bootstrap-contract.test.ts — the operator side of §12's bootstrap
 * contract: how `scripts/users.ts` talks to POST /internal/users, and what it
 * tells the operator when the route answers something other than success.
 *
 * Two things are pinned here. First, the STATUS MAPPING as a table: 404 means the
 * route does not exist because BOOTSTRAP_SECRET is unset on the Worker — a
 * configuration fact the operator must be told, never a "not found" — 401 means
 * the secret is wrong, and any other non-2xx fails carrying its status. Second,
 * the COPIED wire shapes (BootstrapRequest / BootstrapResponse) against the
 * bootstrap contract fixture (§4), read-only: this is the client copy of a shape
 * the server owns, and the fixture is what keeps the two copies honest with no
 * shared package.
 *
 * Project: `scripts` + clients (plain Node, parallel). Cases share nothing.
 *
 * The fetch stub, and why it is legitimate exactly here (strategy §3, §9):
 * everything else in this suite reaches a real implementation — never a faked
 * sibling module, never a faked D1 or DO. `bootstrap()` is one HTTP call whose
 * entire behavior is the mapping from a status to an operator-facing outcome, and
 * the route it calls is guarded by an all-namespaces master key that no test may
 * hold. So the stub fakes the STATUS and BODY only; it does real request
 * inspection (method, URL, headers, serialized body) and must not fake the
 * request shape, the header placement of the secret, or the call count.
 *
 * Durable vs incidental (§7): durable are the CLASSIFICATION of each status —
 * disabled vs wrong-secret vs plain failure — that the secret rides the
 * Authorization header and nowhere else, that a password is printed exactly once,
 * and that nothing retries. The message prose is incidental: rows carry a failure
 * class, never a sentence, so rewording the CLI costs no test churn. §7's rule
 * applied literally — "assert code + presence", not the string.
 *
 * Not pinned here, deliberately: everything §12 hides server-side — password
 * generation, the constant-time compare (strategy §11 E1: reviewed, not tested,
 * since timing is not behaviorally observable), the route-absent-while-unset
 * behavior itself, the audit rows, namespace teardown on delete. Those belong to
 * the server suites; this file pins only the messenger.
 */

// deps: a bare fetch stub (status + body only — see header) · scripts/users.ts (bootstrap, main) · contracts/bootstrap.json (read-only; server/test/worker/contracts.test.ts is its only writer, §4)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, BootstrapError, main } from "../users";
import type { BootstrapRequest, BootstrapResponse } from "../users";

/** An obviously fake master key; nothing here reaches a real route. */
const SECRET = "FAKE0000-bootstrap-secret";
const ORIGIN = "https://hub.example.test";

/**
 * The stub: STATUS and BODY only (file header). It records every call verbatim so the
 * request half — method, URL, headers, serialized body, call count — is checked against
 * what actually went out.
 */
function stubFetch(answers: readonly { status: number; body: unknown }[]): {
  calls: { url: string; init: Record<string, any> }[];
} {
  const calls: { url: string; init: Record<string, any> }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", (url: string, init: Record<string, any>) => {
    calls.push({ url, init });
    const answer = answers[Math.min(index++, answers.length - 1)];
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return Promise.resolve(
      new Response(body, { status: answer.status, headers: { "Content-Type": "application/json" } }),
    );
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the request · §12", () => {
  it("§12 · the POST targets <origin>/internal/users and carries the secret as `Authorization: Bearer` — never in the body, never in the URL or query string, so it stays out of logs and process listings", async () => {
    const stub = stubFetch([{ status: 200, body: { op: "list", usernames: [] } }]);
    await bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "list" });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.url).toBe(`${ORIGIN}/internal/users`);
    expect(call.url).not.toContain(SECRET);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(String(call.init.body)).not.toContain(SECRET);
    // Never followed: a same-origin 3xx would walk off with the master key.
    expect(call.init.redirect).toBe("manual");
  });

  it("§12 · one op per request: the serialized body is exactly the BootstrapRequest for that invocation, with no extra fields and no password in either direction of a `create`", async () => {
    const stub = stubFetch([{ status: 200, body: { op: "create", username: "ada", password: "generated" } }]);
    await bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "create", username: "ada" });
    expect(JSON.parse(String(stub.calls[0].init.body))).toEqual({ op: "create", username: "ada" });
    expect(String(stub.calls[0].init.body)).not.toContain("password");
  });

  it("§12 · bootstrap never retries on its own — the stub sees exactly one call per invocation, for a 5xx as much as for a 200: `create` is not idempotent and every accepted invocation is audited server-side", async () => {
    const failing = stubFetch([{ status: 500, body: "" }]);
    await expect(bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "create", username: "ada" })).rejects.toBeInstanceOf(
      BootstrapError,
    );
    expect(failing.calls).toHaveLength(1);
    vi.unstubAllGlobals();
    const ok = stubFetch([{ status: 200, body: { op: "create", username: "ada", password: "generated" } }]);
    await bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "create", username: "ada" });
    expect(ok.calls).toHaveLength(1);
  });
});

describe("the status mapping · §12", () => {
  runBootstrapStatusTable(bootstrapStatusRows);
});

describe("the copied wire shapes · §4", () => {
  it("§4 · each BootstrapRequest variant serializes deep-equal to its request shape in the fixture — the client copy is checked against the oracle, not against itself", async () => {
    for (const [op, pinned] of Object.entries(fixtureRequests())) {
      const stub = stubFetch([{ status: 200, body: { op: "list", usernames: [] } }]);
      await bootstrap({ origin: ORIGIN, secret: SECRET }, pinned as BootstrapRequest).catch(() => undefined);
      expect(JSON.parse(String(stub.calls[0].init.body)), op).toEqual(pinned);
      vi.unstubAllGlobals();
    }
  });

  it("§4 · each fixture response shape parses into the BootstrapResponse variant echoing its `op`, including `list` with an empty `usernames` array", async () => {
    for (const pinned of fixtureResponses()) {
      const stub = stubFetch([{ status: 200, body: pinned }]);
      const request = (pinned.op === "list" ? { op: "list" } : { op: pinned.op, username: pinned.username }) as BootstrapRequest;
      const parsed = await bootstrap({ origin: ORIGIN, secret: SECRET }, request);
      expect(parsed.op, JSON.stringify(pinned)).toBe(pinned.op);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(pinned).sort());
      vi.unstubAllGlobals();
      expect(stub.calls).toHaveLength(1);
    }
    const empty = stubFetch([{ status: 200, body: { op: "list", usernames: [] } }]);
    const listed = (await bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "list" })) as Extract<
      BootstrapResponse,
      { op: "list" }
    >;
    expect(listed.usernames).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });

  it("§12 · `delete` of an absent username is an ordinary success shape — the postcondition is absence, not existence; twin: `delete` of a live username produces the same shape, so the caller cannot use the response to probe which usernames exist", async () => {
    const shapes: BootstrapResponse[] = [];
    for (const username of ["never-existed", "contracts-user"]) {
      stubFetch([{ status: 200, body: { op: "delete", username } }]);
      shapes.push(await bootstrap({ origin: ORIGIN, secret: SECRET }, { op: "delete", username }));
      vi.unstubAllGlobals();
    }
    expect(Object.keys(shapes[0]).sort()).toEqual(Object.keys(shapes[1]).sort());
    expect(shapes.map((shape) => shape.op)).toEqual(["delete", "delete"]);
  });
});

describe("main(), the printing contract · §12", () => {
  /** Both streams as arrays of writes, so "exactly once" is a count and not an eyeball. */
  function captureStreams(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  }

  /** The env this script reads, set for one case and restored after it. */
  function withEnv(env: Record<string, string | undefined>, run: () => Promise<number>): Promise<number> {
    const before = { PMCP_URL: process.env.PMCP_URL, BOOTSTRAP_SECRET: process.env.BOOTSTRAP_SECRET };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run().finally(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it("§12 · `create` and `reset-password` write the generated password to stdout exactly once and the rotate-the-master-key reminder to stderr; the secret itself is never printed on either stream", async () => {
    for (const op of ["create", "reset-password"]) {
      stubFetch([{ status: 200, body: { op, username: "ada", password: "GENERATED-ONCE" } }]);
      const streams = captureStreams();
      const code = await withEnv({ PMCP_URL: ORIGIN, BOOTSTRAP_SECRET: SECRET }, () => main([op, "ada"]));
      expect(code, op).toBe(0);
      const stdout = streams.out.join("");
      expect(stdout.match(/GENERATED-ONCE/g) ?? [], op).toHaveLength(1);
      expect(streams.err.join("")).toMatch(/rotate/i);
      expect(stdout).not.toContain(SECRET);
      expect(streams.err.join("")).not.toContain(SECRET);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("§12 · exit 0 on success and 1 on any failure, and a missing BOOTSTRAP_SECRET or PMCP_URL fails before any request is made — the master key is read from the environment, never from a flag", async () => {
    const ok = stubFetch([{ status: 200, body: { op: "list", usernames: ["ada"] } }]);
    captureStreams();
    expect(await withEnv({ PMCP_URL: ORIGIN, BOOTSTRAP_SECRET: SECRET }, () => main(["list"]))).toBe(0);
    expect(ok.calls).toHaveLength(1);

    const refused = stubFetch([{ status: 401, body: "" }]);
    expect(await withEnv({ PMCP_URL: ORIGIN, BOOTSTRAP_SECRET: SECRET }, () => main(["list"]))).toBe(1);
    expect(refused.calls).toHaveLength(1);

    // Neither env var set: the failure happens before any dial exists.
    const untouched = stubFetch([{ status: 200, body: { op: "list", usernames: [] } }]);
    expect(await withEnv({ PMCP_URL: undefined, BOOTSTRAP_SECRET: SECRET }, () => main(["list"]))).toBe(1);
    expect(await withEnv({ PMCP_URL: ORIGIN, BOOTSTRAP_SECRET: undefined }, () => main(["list"]))).toBe(1);
    expect(untouched.calls).toHaveLength(0);
  });
});

/**
 * One row of §12's status mapping.
 *
 * `req` is a column because the op is part of the contract, not scenery: the
 * no-retry rule matters most for the non-idempotent `create`, and the 2xx rows
 * need an op to shape their body. `failure` is a CLASSIFICATION rather than a
 * message — `null` is the success twin, "route-disabled" is the 404 that must
 * never read as a plain not-found, "wrong-secret" is the 401, and "http" is
 * everything else. `namesStatus` applies to the "http" class alone: the operator
 * has to be able to tell a 500 from a 502, so the status must survive into the
 * failure even though its wording does not.
 */
export type BootstrapStatusRow = {
  /** spec reference printed in the case title, e.g. "§12 · 404 · route disabled, not not-found" */
  spec: string;
  /** the invocation this row answers */
  req: BootstrapRequest;
  /** the status the stub returns */
  status: number;
  /** the body the stub serves — a fixture-shaped BootstrapResponse on 2xx, arbitrary otherwise */
  body: unknown;
  /** null means bootstrap resolves with the parsed response; otherwise the failure class */
  failure: null | "route-disabled" | "wrong-secret" | "http";
  /** "http" rows only: the status must be recoverable from the failure */
  namesStatus?: boolean;
  /**
   * The contracts/bootstrap.json key this row's status is PINNED by, when there is one.
   * The two statuses that are pure contract — 404 for the disabled route, 401 for the
   * wrong secret — live in the fixture as `disabled.status` / `wrongSecret.status`, and
   * without this column they had no reader anywhere in the repo: the rows spelled them as
   * literals and `fixtureResponses()` returns responses only, so a `spec:` commit moving
   * the disabled status (say to 410) would regenerate the fixture and leave this table
   * green on the old value — the exact silent drift the fixture family exists to prevent,
   * and the exact mis-diagnosis the 401 row exists to prevent. Where present, the runner
   * resolves the status through {@link fixtureStatus} and the literal in `status` must
   * equal it.
   */
  fixtureStatus?: "disabled" | "wrongSecret";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy
 * §9 rule 1) — agents never fill them. The oracle is §12 plus the failure mapping
 * spelled in scripts/users.ts's own contract comment, read from the spec and
 * never from an implementation.
 */
export const bootstrapStatusRows: readonly BootstrapStatusRow[] = [
  {
    spec: "§12 · 200 · `create` resolves with the parsed response — the success twin every refusal row below is authored against, and the one invocation whose non-idempotence makes the no-retry rule matter",
    req: { op: "create", username: "contracts-user" },
    status: 200,
    body: { op: "create", username: "contracts-user", password: "<string>" },
    failure: null,
  },
  {
    spec: "§12 · 200 · `list` on a hub with no users resolves with an empty `usernames` array — emptiness is a success, not a not-found",
    req: { op: "list" },
    status: 200,
    body: { op: "list", usernames: [] },
    failure: null,
  },
  {
    spec: "§12 · 200 · `delete` resolves with the plain echo shape carrying no password in either direction — the postcondition is absence, so the caller cannot use the response to probe which usernames existed",
    req: { op: "delete", username: "contracts-user" },
    status: 200,
    body: { op: "delete", username: "contracts-user" },
    failure: null,
  },
  {
    spec: "§12 · 404 · the route does not exist because BOOTSTRAP_SECRET is unset on the Worker — classified as route-disabled, never as a plain not-found, because the operator's next action is `wrangler secret put` and not a URL check",
    req: { op: "create", username: "contracts-user" },
    status: 404,
    body: "Not Found",
    failure: "route-disabled",
    fixtureStatus: "disabled",
  },
  {
    spec: "§12 · 404 · the classification is made from the STATUS alone: a 404 whose body happens to parse as a success shape is still the disabled route, and never a resolved call",
    req: { op: "list" },
    status: 404,
    body: { op: "list", usernames: [] },
    failure: "route-disabled",
    fixtureStatus: "disabled",
  },
  {
    spec: "§12 · 401 · the secret is wrong — a classification distinct from the disabled route, so an operator holding a rotated key is never told to go re-enable a route that is already live",
    req: { op: "create", username: "contracts-user" },
    status: 401,
    body: "",
    failure: "wrong-secret",
    fixtureStatus: "wrongSecret",
  },
  {
    spec: "§12 · 403 · a 4xx outside the mapping is an ordinary failure carrying its status — only 401 means wrong secret, so a client that lumped the 4xx range together fails here",
    req: { op: "create", username: "contracts-user" },
    status: 403,
    body: "",
    failure: "http",
    namesStatus: true,
  },
  {
    spec: "§12 · 500 · a server failure fails carrying its status, and `create` is still issued exactly once — a retry would risk a second audited user creation",
    req: { op: "create", username: "contracts-user" },
    status: 500,
    body: "",
    failure: "http",
    namesStatus: true,
  },
  {
    spec: "§12 · 502 · a different 5xx is distinguishable from the 500 above — the status survives into the failure even though its wording does not, which is how an operator tells an app error from an edge error. Same `req` as that row on purpose: changing the op and the status together would let a bootstrap() that derived its failure from the OP pass both, which is the confusion `namesStatus` exists to rule out",
    req: { op: "create", username: "contracts-user" },
    status: 502,
    body: "",
    failure: "http",
    namesStatus: true,
  },
  {
    spec: "§12 · 302 · a redirect is never FOLLOWED: the dial is issued with `redirect: \"manual\"`, so the 3xx reaches the status mapping as an ordinary failure carrying its status instead of being replayed against another handler. This is the one request in the system carrying an all-namespaces master key, fetch follows redirects transparently by default, and undici strips `authorization` on CROSS-origin redirects only — a same-origin 302 to any other route would walk off with the key. Without this row the mapping's own \"any other non-2xx\" claim is unreachable for the whole 3xx range (strategy §10's code contract, applied to the CLI side of the same rule)",
    req: { op: "create", username: "contracts-user" },
    status: 302,
    body: "",
    failure: "http",
    namesStatus: true,
  },
];

/**
 * The table runner: one case per row, titled with the row's `spec` so a failure
 * names the sentence to re-read (strategy §8). It stubs fetch to answer the row's
 * status and body, invokes bootstrap() with the row's request, and checks the
 * outcome against `failure` — resolving rows additionally deep-equal their parsed
 * BootstrapResponse. A row carrying `fixtureStatus` first resolves that status through
 * {@link fixtureStatus} and asserts the row's literal equals it, so the fixture is the
 * oracle for the two statuses that are pure contract. This is all the assertion logic
 * for the mapping, so adding a status is one row.
 */
export function runBootstrapStatusTable(rows: readonly BootstrapStatusRow[]): void {
  // deps: a bare fetch stub · scripts/users.ts (bootstrap) · fixtureStatus
  for (const row of rows) {
    it(row.spec, async () => {
      // The two statuses that are pure contract answer to the fixture, not to this table.
      if (row.fixtureStatus !== undefined) expect(row.status).toBe(fixtureStatus(row.fixtureStatus));
      const stub = stubFetch([{ status: row.status, body: row.body }]);
      const outcome = await bootstrap({ origin: ORIGIN, secret: SECRET }, row.req).then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // Never more than one dial, whatever the answer was.
      expect(stub.calls).toHaveLength(1);
      if (row.failure === null) {
        expect(outcome.ok, "the call was refused").toBe(true);
        if (outcome.ok) expect(outcome.response).toEqual(row.body);
        return;
      }
      expect(outcome.ok, "the call resolved and should not have").toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBeInstanceOf(BootstrapError);
      const failure = outcome.error as BootstrapError;
      expect(failure.kind).toBe(row.failure);
      if (row.namesStatus === true) expect(failure.status).toBe(row.status);
    });
  }
}

/** One fixture read, shared by the shape cases and the two contract statuses. Read-only. */
function bootstrapFixture(): Record<string, any> {
  const path = fileURLToPath(new URL("../../contracts/bootstrap.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

/** The fixture's request shape per op — the other half of {@link fixtureResponses}. */
function fixtureRequests(): Record<string, unknown> {
  const fixture = bootstrapFixture();
  return Object.fromEntries(
    Object.entries(fixture)
      .filter(([, value]) => (value as Record<string, unknown>).request !== undefined)
      .map(([op, value]) => [op, (value as Record<string, unknown>).request]),
  );
}

/**
 * The status contracts/bootstrap.json pins for a non-2xx outcome — `disabled` (the route
 * does not exist because BOOTSTRAP_SECRET is unset) and `wrongSecret`. These are the
 * fixture's two response-less keys, and this is their only reader: without it the
 * bootstrap family is "read by" this suite for two of its four halves, which would make
 * contracts/README's own family table the drift it exists to prevent. Read-only.
 */
export function fixtureStatus(key: "disabled" | "wrongSecret"): number {
  // deps: node:fs · contracts/bootstrap.json
  return bootstrapFixture()[key].status as number;
}

/**
 * The fixture side of the shape cases: one canonical example per `op`, read from
 * contracts/bootstrap.json. Declared as a signature so the fixture's own layout
 * (how it keys the four ops, whether requests and responses sit in one document
 * or two) is decided once with the producer suite instead of at each call site.
 * Read-only — nothing in this file writes a fixture.
 */
export function fixtureResponses(): readonly BootstrapResponse[] {
  // deps: node:fs · contracts/bootstrap.json
  // The fixture keys one entry per op; the two response-less keys (`disabled`,
  // `wrongSecret`) are {@link fixtureStatus}'s half of the same document.
  return Object.values(bootstrapFixture())
    .filter((entry: Record<string, unknown>) => entry.response !== undefined)
    .map((entry: Record<string, unknown>) => entry.response as BootstrapResponse);
}
