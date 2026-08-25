// registry.test.ts — the domain model against real D1: what a `Registry` method does to
// a row, and what the next read sees. It pins the rules that only exist once a database
// is underneath — slug uniqueness per owner, the reserved `pmcp` slug, archived as a row
// flag rather than a lookup filter, the request-time re-read that makes a widened role
// take effect on the next call, the auth-flip that clears the credential envelope in the
// SAME write, textual drift on re-declaration, grant validation differing by kind, and
// §15's `log_bodies` resolving to a concrete column at create time (tunnel on, proxy
// off) rather than to a "default" the readers would each have to interpret.
//
// It deliberately does NOT pin the pure seams this module also exports: matchesPattern,
// buildToolFilter, writeOnlyPaths and applyRedaction are `deps: none` functions and live
// in unit/pattern.test.ts, unit/filter.test.ts and unit/redact.test.ts, where a table
// costs microseconds. What lands here is only what needs the row.
//
// Project: `worker` — real D1, every sibling real, no socket and no DO, so it runs
// parallel under per-file storage isolation. Cases are order-independent; the drift and
// re-read cases each seed their own service rather than leaning on a neighbour's.
//
// deps: test/harness/seed (namespace, services, accounts) · server/src/registry
// (Registry, PMCP_SLUG) · server/src/upstream (connectionStatus — the observable read of
// the envelope column registry only ever clears) · env.DB (real D1)

import { describe, it } from "vitest";
import type { AccessMode, GrantEntry, RoleDeclaration, ServiceKind } from "../../src/registry";

/**
 * One slug rule, stated as the slug it refuses beside the nearest slug it accepts.
 *
 * Pairing is structural (§9 rule 2): a `createService` that threw on everything would
 * satisfy a refusals-only table. Keeping `accepted` one edit away from `rejected` is
 * also what makes the row evidence about `rule` — "pmcp" refused beside "pmcp-tools"
 * accepted says the reservation bites; refused beside an unrelated slug says nothing.
 */
export type SlugRuleRow = {
  title: string;
  /** both surfaces enforce the same charset; only services carry the reservation */
  target: "service" | "account";
  rule: "charset" | "reserved" | "duplicate";
  rejected: string;
  accepted: string;
};

/**
 * One `setGrants` call against one service's declaration, and what it is allowed to
 * store.
 *
 * The three outcomes are the whole rule and the reason kind matters: a proxied service's
 * declaration is complete by construction (config defines it), so an undeclared role is
 * an owner error; a tunneled declaration arrives at registration, so the config file may
 * legitimately be ahead of the first connection and an undeclared role warns and stores.
 * `probe` closes the loop — it asserts the grant landed as an observable verdict through
 * resolveAccess, not merely that setGrants returned without complaint.
 */
export type GrantValidationRow = {
  title: string;
  serviceKind: ServiceKind;
  declared: RoleDeclaration;
  entries: readonly GrantEntry[];
  /** stored: no warnings · warned: stored WITH warnings · rejected: throws, stores nothing */
  outcome: "stored" | "warned" | "rejected";
  /** unused on `rejected` rows, where nothing was stored to probe */
  probe?: { tool: string; verdict: AccessMode };
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const slugRuleRows: readonly SlugRuleRow[] = [];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const grantValidationRows: readonly GrantValidationRow[] = [];

/**
 * Registers one case per slug row: the rejected slug is refused on `target`'s create
 * surface, and the accepted twin creates. The refusal's shape is not asserted — which
 * exception a bad slug raises is incidental (§7); that it never becomes a row is not.
 */
export function runSlugRuleTable(rows: readonly SlugRuleRow[]): void {
  // deps: test/harness/seed · server/src/registry (Registry)
  throw new Error("unimplemented");
}

/**
 * Registers one case per grant row: setGrants stores, stores-with-warnings, or throws
 * without storing, and where a `probe` is given, resolveAccess answers its verdict.
 */
export function runGrantValidationTable(rows: readonly GrantValidationRow[]): void {
  // deps: test/harness/seed · server/src/registry (Registry)
  throw new Error("unimplemented");
}

describe("§5 · slugs and identity", () => {
  it.todo("one case per slugRuleRow — title as authored");
  it.todo("§5 · createService mints an opaque id: deleting a slug and recreating it yields a different id, so no recreated service can be rebound to a stale DO");
  it.todo("§5/§8 · the reserved slug is virtual in both directions — createService refuses `pmcp` and getService answers null for it · twin: any other slug creates and reads back");
});

describe("§7 step 2 · resolution at request time", () => {
  it.todo("§7 step 2 · a role widened by upsertDeclaredRoles takes effect on the very next resolveAccess — the declaration is re-read, never cached across calls");
  it.todo("§7 step 2 · a granted role absent from the declaration stays in roleNames and matches nothing (empty listing, not an absent grant)");
  it.todo("§7 step 2 · a zero-grant account resolves to empty roleNames — the gateway's scoped-404 signal, distinct from the row above · twin: one grant makes it non-empty");
  it.todo("§7 · an owner resolves to roleNames ['all'] on every service in the namespace");
});

describe("§6 · archived is a pipeline stage, not a filter", () => {
  it.todo("§6 · getService returns an archived row — the -32002 answer needs the row that a filtering lookup would have hidden");
  it.todo("§6 · listServicesFor keeps archived rows for the owner, and an account still sees only services it holds a grant on");
  it.todo("§6 · archive and unarchive are idempotent and preserve roles, grants and redaction config across the round trip");
});

describe("§5/§9 · create and update invariants", () => {
  it.todo("one case per grantValidationRow — title as authored");
  it.todo("§5 · kind/field mismatch: a proxy draft without upstreamUrl and a tunnel draft carrying a declaration are both refused · twins: the well-formed draft of each kind creates");
  it.todo("§7 · flipping upstreamAuthMode clears the credential envelope in the same write — connectionStatus reads not_connected immediately after, so no read can observe a mode and an envelope kind disagreeing");
  it.todo("§15 · log_bodies resolves at create from the kind when the draft omits it — tunnel on, proxy off — and an explicit value overrides either way");
  it.todo("§15 · updateService flips log_bodies in both directions on either kind, changing nothing else about the row");
});

describe("§7 · config-declared redaction paths", () => {
  it.todo("§7 · redactPathsFor keeps the directions apart: `redact` answers 'args' only and `redact_results` answers 'results' only, on the same tool");
  it.todo("§7 · redactPathsFor unions every matching key (literal and pattern alike) and answers [] — never an error — for a tool nothing matches");
});

describe("§6 · declaration drift", () => {
  it.todo("§6 · drift is reported only for roles holding a live grant — widening a role nobody was granted is silent");
  it.todo("§6 · a subset re-declaration is not drift, and an added pattern string is, even when the regex language is unchanged (comparison is textual by design)");
  it.todo("§6 · upsertDeclaredRoles refuses a proxied service, refuses an invalid declaration without partially writing, and throws on a row that vanished (the caller's close-4003 signal) · twin: a valid declaration on a live tunneled row stores and reports no drift");
  it.todo("§6 · a successful registration stamps last_connected_at — the one moment a tunnel comes online");
});
