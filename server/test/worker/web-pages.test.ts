// web-pages.test.ts — the browser surface, kept thin on purpose. §13's pages carry no
// business logic, so this suite deliberately pins only what is TRUE OF THE PAGES and false
// nowhere else: the CSRF gate (with the ops handler provably not run — a 403 that still
// mutated is the failure this file exists to catch), cookie-session-only access with
// `/approvals/<id>` owner-only, the one paging contract behind two presentations
// (`{ rows, total }`) with the JSONL export's line count equal to `total`, and parity
// DIRECTION B: every mutating form's fields are exactly the fronted op's schema keys.
//
// Direction B is derived on BOTH sides, which is why this file exports no row table and
// declares none: one side is walked out of the rendered HTML, the other read off
// admin.ops[name].schema. A transcribed form→field list would be a third copy of the
// truth, and maintaining it is precisely the drift Direction B exists to catch.
// (`pageRoutes`-as-data was considered and rejected for the same reason — exporting the
// route table solely for a test violates the suite's no-test-only-exports rule; Direction
// B plus review is the guard.)
//
// Project: `worker` — real D1, real better-auth sessions, no sockets; pages are driven
// through `exports.default.fetch`, never by calling web.ts internals (csrfTokenFor,
// checkCsrf, streamAuditJsonl and upstreamCallbackShell are unexported by design, and a
// test that reached past `pageRoutes` would pin the module's private business).
//
// Isolation, load-bearing: proving "the handler never ran" means substituting a counting
// handler into the exported `admin.ops` table for the length of one case and restoring it
// there. Per-file storage and module isolation is what keeps a leaked substitution inside
// this file; no case may depend on a substitution another case made.
//
// Not pinned here, on purpose: every page's HTML (§7 — all HTML is incidental). Assertions
// name form fields, row counts, and status codes; never markup, copy, or layout.

// deps: harness/seed · src/index (exports.default.fetch) · src/admin (ops — one handler substituted to prove non-execution) · src/audit · src/approvals · src/identity (session minting) · applyD1Migrations

import { describe, it } from "vitest";
import type { AdminOp } from "../../src/admin";

/**
 * Direction B, side one: every mutating form a rendered page carries, as the ops key it
 * fronts plus the field names it submits. How a form DECLARES its op — action path, hidden
 * field, whatever web.ts chooses at implementation — is known only here, so Direction B
 * survives that choice being made or changed. A page with no mutating form yields [], which
 * is the correct answer for /audit and the required answer for /account.
 */
export function formsRenderedOn(html: string): { op: string; fields: string[] }[] {
  // deps: HTMLRewriter (form/input/select/textarea walk)
  throw new Error("unimplemented");
}

/**
 * Direction B, side two: the input field names an op accepts, read off its single source of
 * input truth (the zod schema that also renders the MCP inputSchema). Nothing between the
 * two sides is hand-maintained — that is the whole point of the direction.
 */
export function schemaKeysOf(op: AdminOp): string[] {
  // deps: zod (schema introspection)
  throw new Error("unimplemented");
}

describe("§13 · CSRF on every mutating POST", () => {
  it.todo("1. §13 · a mutating POST with no CSRF field is 403 AND the substituted ops handler was never invoked (a rejected-but-executed mutation is the bug this case exists for)");
  it.todo("2. §13 · the same POST carrying the token the page rendered succeeds and the handler ran exactly once (the allow-twin of 1 — without it, `throw 403` passes)");
  it.todo("3. §13 · a token minted under a different cookie session is 403, handler not invoked");
  it.todo("4. §13 · every mutating form the pages render carries a CSRF field — walked out of the rendered HTML, never listed, so a new form cannot forget one");
  it.todo("5. §13 · /audit renders no mutating form and needs no token (no mutations, no CSRF surface)");
});

describe("§4/§13 · cookie sessions are the only page credential", () => {
  it.todo("6. §4 · a bearer-sourced (device-flow) session is refused on /account · a browser session renders it (the twin — the guard is about provenance, not about being logged out)");
  it.todo("7. §7 · an Authorization: Bearer header with no cookie opens no page — bearer tokens are never consulted on page routes");
  it.todo("8. §13 · /approvals/<id> for another namespace's approval refuses · the owner's own id renders (owner-only, and indistinguishable from a nonexistent id)");
  it.todo("9. §13 · /manifest.webmanifest and /sw.js are served without a session — installability is not gated, and the PWA shell holds nothing to gate");
});

describe("§8/§13 · one paging contract, two presentations", () => {
  it.todo("10. §8 · the page's \"N events match\" line is audit.query's `total`, not the rendered row count — they differ whenever a page is not the last one");
  it.todo("11. §13 · desktop page numbers and mobile \"Load more\" walk the same offset/limit contract to the same final row set");
  it.todo("12. §13 · Export JSONL emits exactly `total` lines for the current filters");
  it.todo("13. §13 · the export applies the page's filters verbatim — a filtered export is a strict subset of the unfiltered one over the same seed");
  it.todo("14. §15 · an exported row carries its recorded bodies post-redaction, with stubs rendered as typed placeholders · never the bytes a blob stub stands for");
  it.todo("15. §13 · a row's client session id links back to this same view as ?session=… and that link returns exactly the rows sharing the session");
});

describe("§8 · parity direction B — forms and schemas are one source", () => {
  it.todo("16. §8 · every form rendered on /services and /approvals names an ops key that exists in admin.ops (no form fronts a tool that is gone)");
  it.todo("17. §8 · each form's field set equals schemaKeysOf(ops[name]) — both sides derived, so a schema change with no form change fails here rather than at a user's keyboard");
  it.todo("18. §8 · /account renders no ops-backed form at all — the pinned parity exception: credentials ride better-auth's endpoints and are never reachable from a pmcp tool");
  it.todo("19. §8 · every page mutation reaches an ops handler (or better-auth): no page route mutates D1 on its own — the no-web-only-capability invariant, checked by substituting handlers across the ops table rather than by reading web.ts");
});

describe("§7/§13 · the OAuth callback shell", () => {
  it.todo("20. §7 · /oauth/upstream/callback without an owner session is refused before any upstream code runs and stores nothing · with the session and a live single-use state it completes (the twin; every other state failure is upstream-credentials.test.ts's table)");
});
