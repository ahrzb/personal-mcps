// routes.test.ts — the §2 equivalence the spec demands a test for by name: the segments a
// username may never claim ARE the segments the worker actually serves (∪ "mcp"). §2 says
// the implementation must derive the reserved list from the route table "or enforce the
// equivalence with a test that walks the router" — the composition root does the first and
// this file does the second, because a derived constant only proves ROUTES and
// RESERVED_ROUTES agree, never that ROUTES and the MOUNTS agree. Both directions are
// checked: nothing served is unreserved, and nothing reserved is unserved.
//
// No row table exists here, and none should: both sides are derived — one from the running
// router, one from the exported constant. §9 rule 1 governs TRANSCRIBED matrices; an
// equivalence with nothing transcribed has no oracle to author, and a hand-written list of
// segments would be the third copy this test exists to make impossible.
//
// One honest caveat, and it is a real one: with BOOTSTRAP_SECRET unset, /internal answers
// exactly like an unknown path — that indistinguishability is §12's whole point. A probe
// therefore cannot observe /internal at all, so the walk runs in a worker whose
// BOOTSTRAP_SECRET is SET. Running it unset would silently weaken the walk into "every
// segment except the one that can hide", which is why it gets its own named case rather
// than a comment in a helper.
//
// Project: `worker` — the route table only exists inside a running worker, so the walk is
// `exports.default.fetch` against real bindings; no sockets, and D1 is present only because
// the mounted groups touch it. Nothing here reads a response BODY: §7 puts HTML and error
// prose on the incidental side, so a segment's classification comes from how the request
// was ROUTED (see probeSegment), never from what it rendered.

// deps: harness/seed · src/index (exports.default.fetch, ROUTES, RESERVED_ROUTES) · src/identity (bootstrapRoute) · src/admin (provisionUser) · applyD1Migrations

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { RESERVED_ROUTES, ROUTES } from "../../src/index";
import type { Env } from "../../src/index";
import { USERNAME_CHARSET } from "../../src/identity";
import { paths } from "../../src/pages/model";
import { CLIENT_METADATA_PATH, OAUTH_CALLBACK_PATH } from "../../src/upstream";
import { seedNamespace, resetNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * One top-level segment, exactly as the composition root's route table names it — read
 * from the source of truth in type space, so a segment added to ROUTES widens this type
 * with no edit here.
 */
export type ServedSegment = (typeof import("../../src/index"))["ROUTES"][number];

/**
 * How the running router treated a request for `/<segment>`:
 * - "served" — a mounted group answered it (whatever it answered);
 * - "fallthrough" — it reached the /:user/mcp* namespace route, i.e. the segment was read
 *   as a username;
 * - "not-found" — neither, the worker's plain 404.
 *
 * The classification is deliberately about ROUTING, not about status codes: /login's
 * redirect, /account's login bounce, and a 404 from a mounted group are all "served", while
 * a nonexistent username is "fallthrough" even though the caller sees 401. The distinction
 * is drawn from the namespace route's own observable behavior (a request that reaches it
 * carries the WWW-Authenticate signature §7 pins), which is what makes this a router walk
 * rather than a status-code table.
 *
 * Two probes, because a segment is a subtree and not a page. `/<segment>/mcp` is the shape
 * that the fallthrough would claim, so it is the one that can carry the signature; the bare
 * `/<segment>` is where a mount answers for itself. "not-found" is the answer only when
 * BOTH come back byte-identical to a path the worker routes nowhere — which is exactly the
 * state a segment reserved with nothing mounted on it is in.
 */
export async function probeSegment(segment: ServedSegment | string): Promise<"served" | "fallthrough" | "not-found"> {
  // deps: src/index (exports.default.fetch) · cloudflare:test env (BOOTSTRAP_SECRET set)
  const asNamespace = await call(
    new Request(`${ORIGIN}/${segment}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  // The namespace route's own signature (§7 step 1): the only place in the worker that
  // answers 401 WITH `WWW-Authenticate` is identity's consumer refusal, which is reached
  // only once a request has been read as `/<user>/mcp`.
  if (asNamespace.status === 401 && asNamespace.headers.has("WWW-Authenticate")) return "fallthrough";
  const asPage = await call(new Request(`${ORIGIN}/${segment}`));
  const unrouted = await bytesOf(await call(new Request(`${ORIGIN}/${UNROUTED_PATH}`)));
  const answers = [await bytesOf(asPage), await bytesOf(asNamespace)];
  return answers.some((answer) => answer !== unrouted) ? "served" : "not-found";
}

/**
 * The served set as the RUNNING WORKER defines it — the walk's side of the equivalence.
 * Probes every ROUTES entry plus a control set of names that are NOT routes (so the walk
 * is proven able to tell the two apart before its answer is trusted), and returns the
 * segments that classified "served".
 */
export async function servedSegments(): Promise<Set<string>> {
  // deps: probeSegment · src/index (ROUTES) · src/pages/model (paths) · src/upstream (its two path constants)
  const served = new Set<string>();
  for (const segment of candidateSegments()) {
    if ((await probeSegment(segment)) === "served") served.add(segment);
  }
  return served;
}

/**
 * What the walk probes. ROUTES is one source and deliberately not the only one: a walk
 * over the route table alone could only ever rediscover the table, so the candidates also
 * come from the two places that put a top-level segment ON THE WIRE without consulting it
 * — the browser URL space (pages/model's `paths`, which every template links through) and
 * the two upstream-OAuth documents the hub publishes as URLs. Plus the negative controls.
 * A segment any of those serves and ROUTES does not reserve is precisely case 1's drift.
 */
function candidateSegments(): Set<string> {
  const first = (path: string): string => path.split("/")[1] ?? "";
  const fromPaths = [...Object.values(paths), ...Object.values(paths.auth)]
    .filter((value) => typeof value === "string")
    .map((value) => first(value as string));
  return new Set([
    ...ROUTES,
    ...fromPaths,
    first(CLIENT_METADATA_PATH),
    first(OAUTH_CALLBACK_PATH),
    ...CONTROL_NAMES,
  ]);
}

/**
 * Names shaped exactly like a username and served by nothing — the walk's negative
 * control. They are generated per run rather than spelled, so a control can never
 * accidentally become a route (which would make case 1 pass by agreeing with a bug).
 */
const CONTROL_NAMES = [uniqueSlug("control"), uniqueSlug("notaroute")];

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** A path this worker routes nowhere — the "not-found" side of every comparison here. */
const UNROUTED_PATH = "definitely-not-a-route";

/** §12's secret, set for the whole walk (see the header). Obviously fake. */
const BOOTSTRAP_SECRET = "FAKE0000-routes-bootstrap-secret";

/** Every request in this file goes through the composition root, with the secret SET —
 *  the one binding a case here ever varies (case 5 is the one that varies it). */
function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...(env as unknown as Env), BOOTSTRAP_SECRET, ...overrides });
}

/** A response reduced to what "indistinguishable" means: status, headers, body. */
async function bytesOf(response: Response): Promise<string> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  headers.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ status: response.status, headers, body: await response.text() });
}

/** One bootstrap invocation (§12), as scripts/users.ts makes it. */
function bootstrap(body: Record<string, unknown>, secret = BOOTSTRAP_SECRET): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/internal/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** A JSON-RPC answer, or null when the body was not one — how "did this reach the
 *  gateway" is asked without reading prose (the gateway answers JSON-RPC, always). */
async function jsonRpcOf(response: Response): Promise<Record<string, unknown> | null> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return body !== null && body.jsonrpc === "2.0" ? body : null;
}

/** One seeded namespace with a live service-account key — every consumer-shape case here
 *  needs a caller the gateway would actually admit, or it proves nothing about the door. */
let fixture: SeededNamespace;

beforeAll(async () => {
  fixture = await seedNamespace(env.DB, {
    services: [{ slug: "news", kind: "tunnel" }],
    accounts: [{ slug: "agent", grants: { news: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "live" }] }],
  });
});

describe("§2 · the router walk ≡ the reserved usernames", () => {
  it("1. §2 · every segment the running worker serves is in RESERVED_ROUTES — walked, not listed", async () => {
    for (const segment of await servedSegments()) {
      expect(RESERVED_ROUTES.has(segment), `the worker serves /${segment}, which no username is reserved from`).toBe(true);
    }
  });

  it("2. §2 · every RESERVED_ROUTES entry except \"mcp\" is served by the running worker (the other direction: a reservation with no mount is drift too, just the harmless-looking kind)", async () => {
    const served = await servedSegments();
    for (const segment of RESERVED_ROUTES) {
      if (segment === "mcp") continue;
      expect(served.has(segment), `/${segment} is reserved from usernames and nothing answers it`).toBe(true);
    }
  });

  it("3. §2 · \"mcp\" is reserved by fiat though served only as a second segment — the one member of the set the walk cannot produce, named here so the asymmetry is deliberate", async () => {
    expect(RESERVED_ROUTES.has("mcp")).toBe(true);
    expect([...ROUTES]).not.toContain("mcp");
    // It is reserved all the same: a namespace called "mcp" would put `/mcp/mcp` on the
    // wire, and the door refuses it before any lookup.
    expect(await probeSegment("mcp")).not.toBe("fallthrough");
  });

  it("4. §2 · the walk can tell served from unserved: a control name that is not a route classifies \"fallthrough\", never \"served\" (without this, case 1 passes vacuously)", async () => {
    for (const control of CONTROL_NAMES) {
      expect(RESERVED_ROUTES.has(control)).toBe(false);
      expect(await probeSegment(control)).toBe("fallthrough");
    }
    // …and the walk's own answer for a real route is the other value, so the two are not
    // one constant wearing two names.
    expect(await probeSegment("login")).toBe("served");
  });

  it("5. §12 · with BOOTSTRAP_SECRET unset, /internal is indistinguishable from an unknown path — so the walk runs with it SET; this case pins both halves and the reason", async () => {
    const disabled = { BOOTSTRAP_SECRET: undefined };
    const unset = await bytesOf(
      await call(
        new Request(`${ORIGIN}/internal/users`, {
          method: "POST",
          headers: { Authorization: `Bearer ${BOOTSTRAP_SECRET}`, "Content-Type": "application/json" },
          body: JSON.stringify({ op: "list" }),
        }),
        disabled,
      ),
    );
    const unrouted = await bytesOf(await call(new Request(`${ORIGIN}/${UNROUTED_PATH}`), disabled));
    expect(unset).toEqual(unrouted);
    // The other half: with the secret set the segment answers, which is the state every
    // other case in this file walks under.
    expect((await bootstrap({ op: "list" })).status).toBe(200);
    expect(await probeSegment("internal")).toBe("served");
  });

  it("6. §2 · RESERVED_ROUTES is ROUTES ∪ {\"mcp\"} — derived, so adding a route reserves its name with no second edit anywhere", () => {
    expect([...RESERVED_ROUTES].sort()).toEqual([...ROUTES, "mcp"].sort());
  });
});

describe("§2 · usernames may not collide with routes", () => {
  it("7. §12 · provisioning a user named for a reserved segment is refused · the same request with a non-reserved name of the same charset succeeds (the twin)", async () => {
    for (const reserved of ["login", "api", "connect"]) {
      const refused = await bootstrap({ op: "create", username: reserved });
      expect(refused.status, `creating a user named "${reserved}"`).toBe(409);
    }
    // The twin, without which "refused" is satisfied by a create that never works: the
    // same request, one charset-legal non-reserved name.
    const allowed = uniqueSlug("walker");
    const created = await bootstrap({ op: "create", username: allowed });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { username: string }).username).toBe(allowed);
    await resetNamespace(allowed);
  });

  it("8. §2 · a username outside [a-z0-9-] is refused at the route, before any namespace lookup", async () => {
    const illegal = "Not_A_User";
    expect(USERNAME_CHARSET.test(illegal)).toBe(false);
    const refused = await call(
      new Request(`${ORIGIN}/${illegal}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    // The proof that the CHARSET refused it and not a lookup: an unauthenticated request
    // for a charset-legal name reaches identity and comes back 401, while this one never
    // got that far — it is route-not-found, the same bytes an unrouted path gets.
    expect(refused.status).toBe(404);
    expect(await bytesOf(refused)).toEqual(await bytesOf(await call(new Request(`${ORIGIN}/${UNROUTED_PATH}`))));
    expect(await probeSegment(uniqueSlug("legal"))).toBe("fallthrough");
  });

  it("9. §2 · manifest.webmanifest and sw.js are reserved even though the dot already puts them outside the username charset — belt and braces, and the case says so", async () => {
    for (const segment of ["manifest.webmanifest", "sw.js"]) {
      expect(USERNAME_CHARSET.test(segment), `${segment} is already outside the charset`).toBe(false);
      expect(RESERVED_ROUTES.has(segment), `${segment} is reserved anyway`).toBe(true);
      expect(await probeSegment(segment)).toBe("served");
    }
  });
});

describe("§2/§7 · what the fallthrough serves", () => {
  it("10. §7 · /<reserved>/mcp never reaches the gateway — the mounted group owns the segment, so a user could not shadow a page even if the reservation were missed", async () => {
    for (const segment of RESERVED_ROUTES) {
      const answered = await call(
        new Request(`${ORIGIN}/${segment}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // A credential the gateway WOULD admit on a real namespace, so a 404 here is
            // the router refusing rather than the door.
            Authorization: `Bearer ${fixture.tokens.live.token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(await jsonRpcOf(answered), `/${segment}/mcp answered JSON-RPC`).toBeNull();
    }
  });

  it("11. §2 · an unmatched top-level segment falls through to the namespace route · an unmatched deeper path 404s (the fallthrough is one segment wide, not a catch-all)", async () => {
    const stranger = uniqueSlug("stranger");
    expect(await probeSegment(stranger)).toBe("fallthrough");
    // One segment wide: neither a deeper path under the same name nor a non-`mcp` second
    // segment is the namespace route's business.
    for (const path of [`${stranger}/mcp/one/two`, `${stranger}/settings`, `${stranger}`]) {
      const deeper = await call(new Request(`${ORIGIN}/${path}`, { method: "POST" }));
      expect(deeper.status, `POST /${path}`).toBe(404);
      expect(deeper.headers.has("WWW-Authenticate"), `POST /${path} reached the namespace route`).toBe(false);
    }
  });

  it("12. §7 · /<user>/mcp and /<user>/mcp/<slug> are the only consumer shapes — a third segment 404s rather than resolving a slug with a suffix", async () => {
    const user = fixture.owner.username;
    const bearer = { Authorization: `Bearer ${fixture.tokens.live.token}`, "Content-Type": "application/json" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const aggregated = await call(new Request(`${ORIGIN}/${user}/mcp`, { method: "POST", headers: bearer, body }));
    expect(await jsonRpcOf(aggregated)).not.toBeNull();
    const scoped = await call(new Request(`${ORIGIN}/${user}/mcp/news`, { method: "POST", headers: bearer, body }));
    expect(await jsonRpcOf(scoped)).not.toBeNull();
    // The third segment is not a suffix on the slug: it is not a shape at all.
    const suffixed = await call(
      new Request(`${ORIGIN}/${user}/mcp/news/extra`, { method: "POST", headers: bearer, body }),
    );
    expect(suffixed.status).toBe(404);
    expect(await jsonRpcOf(suffixed)).toBeNull();
  });

  it("13. §8 · /api/whoami answers under the reserved \"api\" segment and is never read as a username's namespace (the CLI contract's one non-MCP route)", async () => {
    const answered = await call(
      new Request(`${ORIGIN}/api/whoami`, {
        headers: { Authorization: `Bearer ${fixture.tokens.live.token}` },
      }),
    );
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      principal: "sa:agent",
      namespace: fixture.owner.username,
    });
    // "api" is a segment, never a namespace: the consumer shape under it is not the
    // gateway's, whatever credential asks.
    expect(await probeSegment("api")).toBe("served");
    const asNamespace = await call(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fixture.tokens.live.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(await jsonRpcOf(asNamespace)).toBeNull();
  });
});
