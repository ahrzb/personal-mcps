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

import { describe, it } from "vitest";

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
 */
export async function probeSegment(segment: ServedSegment | string): Promise<"served" | "fallthrough" | "not-found"> {
  // deps: src/index (exports.default.fetch) · cloudflare:test env (BOOTSTRAP_SECRET set)
  throw new Error("unimplemented");
}

/**
 * The served set as the RUNNING WORKER defines it — the walk's side of the equivalence.
 * Probes every ROUTES entry plus a control set of names that are NOT routes (so the walk
 * is proven able to tell the two apart before its answer is trusted), and returns the
 * segments that classified "served".
 */
export async function servedSegments(): Promise<Set<string>> {
  // deps: probeSegment · src/index (ROUTES)
  throw new Error("unimplemented");
}

describe("§2 · the router walk ≡ the reserved usernames", () => {
  it.todo("1. §2 · every segment the running worker serves is in RESERVED_ROUTES — walked, not listed");
  it.todo("2. §2 · every RESERVED_ROUTES entry except \"mcp\" is served by the running worker (the other direction: a reservation with no mount is drift too, just the harmless-looking kind)");
  it.todo("3. §2 · \"mcp\" is reserved by fiat though served only as a second segment — the one member of the set the walk cannot produce, named here so the asymmetry is deliberate");
  it.todo("4. §2 · the walk can tell served from unserved: a control name that is not a route classifies \"fallthrough\", never \"served\" (without this, case 1 passes vacuously)");
  it.todo("5. §12 · with BOOTSTRAP_SECRET unset, /internal is indistinguishable from an unknown path — so the walk runs with it SET; this case pins both halves and the reason");
  it.todo("6. §2 · RESERVED_ROUTES is ROUTES ∪ {\"mcp\"} — derived, so adding a route reserves its name with no second edit anywhere");
});

describe("§2 · usernames may not collide with routes", () => {
  it.todo("7. §12 · provisioning a user named for a reserved segment is refused · the same request with a non-reserved name of the same charset succeeds (the twin)");
  it.todo("8. §2 · a username outside [a-z0-9-] is refused at the route, before any namespace lookup");
  it.todo("9. §2 · manifest.webmanifest and sw.js are reserved even though the dot already puts them outside the username charset — belt and braces, and the case says so");
});

describe("§2/§7 · what the fallthrough serves", () => {
  it.todo("10. §7 · /<reserved>/mcp never reaches the gateway — the mounted group owns the segment, so a user could not shadow a page even if the reservation were missed");
  it.todo("11. §2 · an unmatched top-level segment falls through to the namespace route · an unmatched deeper path 404s (the fallthrough is one segment wide, not a catch-all)");
  it.todo("12. §7 · /<user>/mcp and /<user>/mcp/<slug> are the only consumer shapes — a third segment 404s rather than resolving a slug with a suffix");
  it.todo("13. §8 · /api/whoami answers under the reserved \"api\" segment and is never read as a username's namespace (the CLI contract's one non-MCP route)");
});
