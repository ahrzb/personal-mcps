// admin.ts — the ops table: the ONE implementation of every management operation. Three
// fronts render it with zero added capability (§8's parity invariant): the builtin `pmcp`
// MCP service (adminBackend, below), the server-rendered web pages, and — over MCP — the
// CLI. This module owns and hides: per-op input validation; cross-module cascade ordering
// on every deleting op (D1 rows are deleted in one atomic batch BEFORE the tunnel DO is
// severed/wiped, so §15's guarantee holds: a racing re-register finds no row and dies);
// the uniform rejection of the reserved `pmcp` slug (§8: one error, every op, never
// per-tool); the `admin.<tool>` audit row each mutating handler writes about itself; the
// credential wipe on an upstream auth-mode flip; and the once-only presentation of
// plaintext secrets (tokens, bootstrap passwords) — returned to the caller, never stored,
// never logged.
//
// Anti-decay rule, binding at review: any handler reducible to a single registry call is
// a pass-through and gets folded back into its caller — an entry earns its row only while
// it composes validation, cascade ordering, and audit.

import type { ServiceBackend } from "./gateway";

/**
 * One row of the ops table. `schema` (a zod schema at implementation) is the op's single
 * source of input truth: it renders BOTH the MCP tool inputSchema (adminBackend.listTools)
 * and the web form, so the two fronts can never drift. `handler` receives `ownerId`, the
 * namespace every op operates on — callers pass it only after authentication has proven
 * it is the caller's own (the gateway's §7 step 1, or the web page's cookie session);
 * handlers never re-check namespace ownership. Handlers validate input against `schema`,
 * throw HubError (gateway.ts's one error vocabulary) for every failure, and — when
 * mutating — write their own `admin.<tool>` audit row: a summary of the change, never a
 * secret.
 */
export type AdminOp = {
  schema: unknown;
  /**
   * Optional result schema (zod at implementation), rendered as the tool's MCP
   * outputSchema. Declared only where it carries weight: token_issue marks its key
   * field `writeOnly`, so §15's uniform body rule masks the one admin secret — the
   * reason no pmcp-specific logging rule exists.
   */
  outputSchema?: unknown;
  handler(ownerId: string, input: unknown): Promise<unknown>;
};

/**
 * The uniform `pmcp`-slug rejection (§8): every op that takes a service slug —
 * `service_*`, `grant_set`, `token_issue` alike — refuses the reserved builtin slug via
 * this one check with its one error, so the reservation can never drift per-tool.
 * Internal seam, deliberately not exported: the reservation is reachable only through
 * the ops.
 */
function assertSlugNotReserved(slug: string): void {
  // deps: gateway.HubError
  throw new Error("unimplemented");
}

/**
 * The ops table — every `pmcp` tool of §8, keyed by tool name. The gateway serves these
 * through adminBackend; the web pages and CLI call the same handlers. Read ops return
 * plain JSON-serializable objects (the MCP result and the page model are the same
 * data). Every `schema: undefined` below becomes the op's zod schema at implementation;
 * the input shape is pinned in each op's comment.
 */
export const ops: Record<string, AdminOp> = {
  /**
   * List the namespace's services, including the virtual builtin `pmcp` entry flagged
   * `builtin: true` (no row exists for it, §8; its synthesized flags are pinned —
   * log_bodies true, redact/redact_results empty — the same values gateway's
   * virtualPmcpService carries, §15). Rows carry everything diff/apply reads
   * (§8 pins the completeness): kind, declared roles, redact and redact_results
   * paths, log_bodies, archived; tunneled —
   * connection status (online/offline) and last seen; proxied — endpoint, auth mode,
   * forward_identity, and for `auth: oauth` the connection state (not connected /
   * connected / needs reconnect). Never credentials or token material.
   */
  service_list: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.listServicesFor · tunnel.status · upstream.connectionStatus
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` → one service, same row shape as service_list. The reserved `pmcp` slug
   * is rejected like everywhere else (the builtin surfaces only through service_list —
   * uniformity is worth more than the corner case).
   */
  service_get: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.getService · tunnel.status · upstream.connectionStatus
      throw new Error("unimplemented");
    },
  },

  /**
   * Create a service. `{ slug, name?, description?, kind, redact?, redact_results?,
   * log_bodies? }` (log_bodies absent defaults by kind — tunneled on, proxied off,
   * §15) plus, for proxied
   * kind only: `endpoint`, `roles` (virtual role definitions), `auth` ('headers' |
   * 'oauth', default 'headers'), `forward_identity` (default false) — those fields are
   * rejected on tunneled creates. Slug is `[a-z0-9-]`, unique per owner, never `pmcp`.
   * Proxied role definitions get exactly the `hub/register` validation (§6/§8): name
   * charset, `all` rejected, patterns compile, length/count caps. `kind` is immutable
   * forever after (recreate to convert). Mints no token — `token_issue` is the sole
   * credential path (§6).
   */
  service_create: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.createService · registry.validateRoles · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * Update a service: service_create's fields minus `kind` — a kind change is rejected,
   * not ignored (§8). Flipping `auth` in either direction is accepted but destructive:
   * any stored upstream credential envelope is wiped in the same write (audit row
   * `upstream.auth_mode_changed` beside this op's own `admin.service_update`), leaving
   * the service not-connected until Connect or service_set_upstream_auth runs. Role
   * redefinitions revalidate like create.
   */
  service_update: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.updateService · registry.validateRoles · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` — terminal delete. Cascade ordering pinned (§15): ONE atomic D1 batch
   * removes the service row (grants cascade by FK) and its token rows FIRST; only then
   * is the tunnel DO told to sever the live socket (close 4001) and wipe cached state —
   * so a racing re-register finds neither row nor token and fails, never rebinding.
   * Proxied services stop after the batch (no DO, no tokens). The DO stays addressed by
   * the opaque service.id, dead forever.
   */
  service_delete: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.deleteService · identity.deleteTokensFor · tunnel.sever · tunnel.wipe · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug, headers }` — store the static headers the hub sends upstream. Proxied
   * `auth: headers` services only: rejected on tunneled services and on `auth: oauth`
   * ones (each mode has exactly one credential path, §8). Write-only and imperative
   * like token_issue: headers are sealed into the encrypted envelope and never readable
   * back through any tool, page, or YAML; the audit row says auth was set, not what to.
   */
  service_set_upstream_auth: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.getService · upstream.setHeaders · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` — `auth: oauth` proxied services only: wipe the stored token bundle
   * (audit row `upstream.disconnected`), leaving the service not-connected until the
   * owner runs Connect again. The web Disconnect button fronts this; Connect itself has
   * no tool — the consent redirect is inherently a browser interaction (§8).
   */
  service_disconnect: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.getService · upstream.disconnect · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` — reversible parking (§6): the archived flag lands in D1 first (so a
   * retrying bot meets 403 at upgrade), then any live socket is severed (close 4002 —
   * the client library keeps retrying at max backoff). Consumers see -32002 scoped and
   * nothing aggregated; roles, grants, tokens, and the cached catalog are all retained.
   */
  service_archive: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.archiveService · tunnel.sever · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` — clear the archived flag; everything retained at archive time is live
   * again, and the bot's max-backoff retry reconnects within a minute without being
   * touched (§6).
   */
  service_unarchive: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.unarchiveService · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * List service accounts with their grants inline — per service: role names and modes
   * (§8). One service_list plus one account_list is the complete desired-state read the
   * CLI diff planner depends on; there is deliberately no separate grant-read tool.
   */
  account_list: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.listAccounts · registry.grantsFor
      throw new Error("unimplemented");
    },
  },

  /** `{ slug, name?, description? }` — create a service account. Slug `[a-z0-9-]`,
   *  unique per owner. Holds no grants until grant_set. */
  account_create: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.createAccount · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ slug }` — terminal delete: ONE atomic D1 batch removes the account row (grants
   * cascade by FK) and the account's token rows, so a racing request can never
   * authenticate against a half-deleted account. Accounts hold no sockets — the batch
   * alone is the whole cascade (the §15 ordering pin is satisfied vacuously).
   */
  account_delete: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.deleteAccount · identity.deleteTokensFor · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ account, service, roles }` — replace the FULL grant set for the pair: roles
   * absent from the list are revoked (§8). Each entry is `name` or `name:approval`
   * (§9's syntax — role names contain no colon, so the suffix is unambiguous); the same
   * role in both modes is a config error. Registry's role language validates: undeclared
   * roles warn for tunneled services (the file may be ahead of first connect) and
   * hard-error for proxied ones; `all` is grantable, never declarable. `pmcp` is
   * rejected — service accounts can never hold admin grants (§8).
   */
  grant_set: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.setGrants · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ status?, limit? }` → approval requests, newest first, pending and history alike
   * (§8). Lazy expiry applies on this read (approvals flips past-expiry pending rows and
   * writes `approval.expired` exactly once, §7). Read-only — no admin audit row.
   */
  approval_list: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: approvals.list
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ id, decision: 'approve' | 'reject' }` — decide one pending, unexpired approval;
   * anything else (already decided, expired, another namespace's id) is an error. The
   * /approvals buttons and `pmcp approve/reject` are both fronts for this op. The
   * lifecycle audit row (`approval.approved`/`.rejected`) is approvals' write; this
   * handler adds its own `admin.approval_decide`.
   */
  approval_decide: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: approvals.decide · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ kind: 'service_account' | 'service', slug, expires_in? }` → the plaintext token,
   * present ONLY in this result, once — never stored (SHA-256 at rest), never logged,
   * never readable again (§4, §8). The op declares an outputSchema with the key field
   * marked `writeOnly`, so §15's uniform body rule masks it wherever bodies are
   * recorded — the reply the CALLER sees is never redacted (§7), only persistence is.
   * Defaults by kind (§8): service-account tokens 90 d
   * (overridable, including 'never'); service tokens no expiry (revoke-on-compromise).
   * `kind: 'service'` is rejected for proxied services (nothing connects) and `pmcp` is
   * rejected like everywhere. Result also carries the row id and display prefix.
   */
  token_issue: {
    schema: undefined,
    outputSchema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: registry.getService · registry.getAccount · identity.issueToken · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * List the namespace's tokens: kind, referenced slug, display prefix, created,
   * expiry, revocation, and coarse `last_used_at` (updated at most hourly, §5 — makes
   * leaked-token use and rotation state observable). Never plaintext, never the hash.
   */
  token_list: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: identity.listTokens
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ id }` — revoke a token; consumer checks see it immediately (§15). Ordering
   * pinned: the row is revoked in D1 BEFORE any socket action, so a racing reconnect
   * presents a dead credential. Revoking a service token whose connection is live
   * additionally severs that socket (close 4001, §8).
   */
  token_revoke: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: identity.listTokens · identity.revokeToken · tunnel.sever · audit.record
      throw new Error("unimplemented");
    },
  },

  /**
   * `{ principal?, service?, event?, tool?, session?, since?, until?, limit?, offset? }`
   * → `{ rows, total }`, newest first (§8) — the ops-table front over audit.query, which
   * pins the filter semantics and defaults. Rows carry the recorded body fields when
   * present — post-redaction and stub-substituted, the only stored form (§15).
   * Read-only; `pmcp audit`, /audit, and the
   * JSONL export all reduce to it.
   */
  audit_query: {
    schema: undefined,
    async handler(ownerId: string, input: unknown) {
      // deps: audit.query
      throw new Error("unimplemented");
    },
  },
};

/**
 * The builtin `pmcp` service — the third ServiceBackend beside tunnel and upstream, so
 * the gateway pipeline (auth → filter → archived → approvals → dispatch) has no admin
 * special case. listTools renders every op as a Tool (name = ops key, inputSchema from
 * its schema, outputSchema where declared); call dispatches to ops[tool].handler with
 * `service.ownerId` and wraps a
 * successful result — HubError escapes to the gateway, the only place errors become
 * JSON-RPC. sensitivePaths answers `{ args: [], results: [...] }` for known ops — no
 * admin tool takes a sensitive argument, and the only sensitive result is
 * token_issue's `writeOnly`-marked key, masked by §15's uniform body rule (no
 * pmcp-specific logging rule exists) — and
 * null for unknown names. Only `service.ownerId` is consulted — the pmcp Service value
 * is virtual, no row exists for it (§8).
 */
export const adminBackend: ServiceBackend = {
  async listTools(service, ctx) {
    // deps: ops · zod (schema → inputSchema rendering)
    throw new Error("unimplemented");
  },
  async call(service, msg, ctx) {
    // deps: ops · gateway.HubError
    throw new Error("unimplemented");
  },
  async sensitivePaths(service, tool) {
    // deps: ops
    throw new Error("unimplemented");
  },
};

/**
 * Bootstrap a namespace (§12, served by POST /internal/users — never a pmcp tool; the
 * auth family is pinned outside the parity invariant, §8). Creates the better-auth user
 * — username plus a generated random password; email is the synthesized
 * `<username>@users.local` placeholder, never used — and returns the password: the ONLY
 * time it exists in plaintext, never stored or logged (the audit row, principal
 * 'bootstrap', records the creation, not the secret). Validates the username charset
 * (`[a-z0-9-]`); collision with reserved top-level routes is the route's own check — the
 * composition root owns the route table RESERVED_ROUTES derives from (§2).
 */
export async function provisionUser(
  username: string,
): Promise<{ userId: string; password: string }> {
  // deps: better-auth (user create) · crypto · audit.record
  throw new Error("unimplemented");
}

/**
 * Full namespace teardown (§15): every tunneled service gets the service_delete cascade
 * — D1 batch first, THEN sever (4001) + DO wipe — and only after all services are down
 * does the user row go, cascading accounts, grants, sessions, approvals, and the rest.
 * DOs are addressed by opaque service.id, so even a missed wipe can never be rebound by
 * recreating the username. Deleting a user that does not exist is a no-op, not an error
 * — the postcondition is absence. Audited as principal 'bootstrap'.
 */
export async function deleteUser(username: string): Promise<void> {
  // deps: ops.service_delete · better-auth (user delete) · D1 `user` · audit.record
  throw new Error("unimplemented");
}
