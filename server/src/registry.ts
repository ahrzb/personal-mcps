// registry.ts — the hub's domain model: services, service accounts, and grants,
// plus the ENTIRE role-pattern language in one place.
//
// OWNS: the D1 rows for `service`, `service_account`, and `grant_` (row-level
// primitives only — cascade choreography across tokens, DO sever/wipe, and audit
// belongs to admin), the role-pattern semantics (anchored ^(?:p)$ compilation,
// the literal-grammar fast path, `*` as a `.*` alias, the built-in `all` role
// resolved at request time and never stored, union-of-roles with
// allow-beats-approval), role-declaration validation shared by hub/register and
// proxied config, textual drift detection on re-declaration, and the `pmcp` slug
// reservation.
//
// HIDES: the roles_json / redact column formats (the tunnel DO hands wire-shaped
// declarations to upsertDeclaredRoles and never touches the columns), how
// patterns compile and match, and how grant rows plus a declaration resolve into
// a ToolFilter. This module never writes audit rows, never maps errors to
// JSON-RPC, and never reads or decrypts upstream credential envelopes — its one
// touch is CLEARING the envelope column when updateService flips the auth mode,
// a row invariant (mode and envelope kind can never disagree), not a read.

import type { Principal } from "./identity";

/** The request-scoped Cloudflare D1 binding (`D1Database` from `@cloudflare/workers-types`). */
type D1Database = unknown;

/**
 * The two service shapes, in the wire vocabulary pinned by §5's CHECK constraint
 * and the YAML `kind:` field: `tunnel` dials in over the reverse WebSocket and
 * declares roles at registration; `proxy` is an upstream MCP endpoint the hub
 * forwards to, with roles defined in config. Immutable after create — a
 * conversion would orphan service tokens and DO state, so it's recreate-only.
 */
export type ServiceKind = "tunnel" | "proxy";

/**
 * The cross-module view of a service row — exactly what the request pipeline
 * needs to route, gate, and address. Richer reads go through ServiceDetail.
 */
export type Service = {
  id: string;        // opaque row id — the DO addressing key; never derived from user/slug, never reused
  ownerId: string;
  slug: string;
  kind: ServiceKind;
  archived: boolean;
};

/**
 * A per-tool access verdict. `deny` is only ever a resolver answer — grant rows
 * store `allow` or `approval`, never `deny` (an ungranted tool is simply
 * unmatched).
 */
export type AccessMode = "allow" | "approval" | "deny";

/**
 * A caller's resolved access to one service, produced by resolveAccess and
 * consumed by the gateway. Pure and snapshot-in-time: it holds the union of the
 * principal's granted roles resolved against the declaration as of the resolve
 * call, and does no I/O of its own.
 *
 * Semantics the gateway leans on: check() takes the UNPREFIXED tool name and
 * answers `allow` when any allow-mode role matches (allow beats approval),
 * `approval` when only approval-mode roles match, `deny` otherwise.
 * filterList() drops only `deny` tools — approval-gated tools list like any
 * other, since the agent must see them to call them. An empty roleNames on a
 * service-account principal means the account holds no grants at all on this
 * service (the gateway's scoped-404 signal) — distinct from granted-but-
 * undeclared roles, which appear in roleNames but match nothing (empty
 * tools/list and -32001, a normal state). Owners always carry ["all"].
 */
export type ToolFilter = {
  check(tool: string): AccessMode;
  filterList<T extends { name: string }>(tools: T[]): T[];
  roleNames: string[];   // granted role names, for hub/roles forwarding
};

/**
 * A role declaration in wire shape — role name to anchored patterns, exactly as
 * hub/register and the YAML `roles:` block carry it. `{}` means "no roles
 * declared": the service is reachable only by owners and `all`-granted accounts.
 */
export type RoleDeclaration = Record<string, string[]>;

/**
 * What upsertDeclaredRoles found when comparing old and new declarations.
 * A role appears here only when it holds at least one live grant AND its new
 * pattern set is not a subset of the old one (compared as exact strings — never
 * regex-language containment); `patterns` lists the added or changed strings.
 * Empty `widened` means no visible drift. The caller turns a non-empty report
 * into the `connect.roles_widened` audit row — this module never audits.
 */
export type DriftReport = {
  widened: { role: string; patterns: string[] }[];
};

/** The grant modes an owner can actually store — `deny` is never a grant. */
export type GrantMode = "allow" | "approval";

/** One granted role on one service, exactly as stored: name plus mode. */
export type GrantEntry = { role: string; mode: GrantMode };

/**
 * An account's grants on one service — the shape account_list returns inline
 * and the CLI diff planner consumes, so desired state is readable in one
 * grantsFor call per account.
 */
export type ServiceGrants = {
  serviceId: string;
  serviceSlug: string;
  entries: GrantEntry[];
};

/**
 * The full owner-facing read of a service row — everything service_get and the
 * diff planner need. Timestamps are epoch milliseconds. The upstream credential
 * envelope is deliberately absent: credentials never surface through any
 * registry read.
 */
export type ServiceDetail = Service & {
  name: string;
  description: string;
  upstreamUrl: string | null;              // proxied only, null on tunneled
  upstreamAuthMode: "headers" | "oauth" | null;  // proxied only; configuration, not credentials
  forwardIdentity: boolean;                // proxied only; X-Pmcp-* headers upstream
  declaredRoles: RoleDeclaration;
  redact: Record<string, string[]>;        // tool-or-pattern → argument paths (config-declared, §7)
  createdAt: number;
  lastConnectedAt: number | null;          // tunneled only, null until first registration
};

/**
 * Input to createService. Proxied drafts must carry upstreamUrl and a valid
 * roles declaration; tunneled drafts must not (their roles arrive at
 * registration). `kind` is here and only here — no patch can ever change it.
 */
export type ServiceDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ServiceKind;
  upstreamUrl?: string;
  upstreamAuthMode?: "headers" | "oauth";
  forwardIdentity?: boolean;
  roles?: RoleDeclaration;
  redact?: Record<string, string[]>;
};

/**
 * Input to updateService. `kind` and `archived` are absent by construction:
 * kind is immutable, and archive/unarchive are their own primitives.
 */
export type ServicePatch = Partial<{
  name: string;
  description: string;
  upstreamUrl: string;
  upstreamAuthMode: "headers" | "oauth";
  forwardIdentity: boolean;
  roles: RoleDeclaration;
  redact: Record<string, string[]>;
}>;

/** A service-account row. Timestamps are epoch milliseconds. */
export type ServiceAccount = {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string;
  createdAt: number;
};

/** Input to createAccount. */
export type AccountDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
};

/**
 * The reserved slug of the built-in admin service. No `service` row ever exists
 * for it: createService rejects it, getService returns null for it, and every
 * admin op that takes a slug rejects it with one uniform error. Because the
 * builtin has no row id, service accounts can never accumulate grants on it —
 * the reservation is what makes "accounts can't hold pmcp grants" structural
 * rather than checked.
 */
export const PMCP_SLUG = "pmcp";

/**
 * The one pattern-language decision point: does `pattern` match `tool`?
 * A pattern made only of tool-name characters ([A-Za-z0-9._-]) is compared as a
 * literal string, never compiled — `get.news` matches only the tool `get.news`.
 * Anything else compiles as ^(?:pattern)$ with no flags, so top-level `|` stays
 * anchored (`foo|bar` never matches `foox`). An un-escaped `*` not already
 * preceded by `.` reads as `.*`, so glob-style `get_*` and regex-style `get_.*`
 * mean the same thing. Never throws: a pattern that fails to compile matches
 * nothing (validateRoles is where compilation failures are reported).
 */
export function matchesPattern(pattern: string, tool: string): boolean {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Validates a role declaration against the rules shared by hub/register and
 * proxied config: role names match [a-z0-9_-]{1,64}, `all` is reserved (built
 * in, never declarable), every pattern compiles under the pattern language,
 * patterns are ≤128 chars, and each role holds ≤64 patterns. Returns
 * human-readable violations, empty when valid ({} is valid — no roles
 * declared). Pure; callers decide whether violations become a JSON-RPC reply
 * (the tunnel DO) or a config error (admin/YAML).
 */
export function validateRoles(decl: RoleDeclaration): string[] {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The pure heart of access resolution: grant entries (exactly as stored, or the
 * synthesized owner grant [{role: "all", mode: "allow"}]) plus the service's
 * declaration → a ToolFilter. A granted `all` contributes `.*` without touching
 * the declaration; a granted role absent from it contributes no patterns but
 * still appears in roleNames; per tool, any allow-mode match beats every
 * approval-mode match. Exported as the testable seam for the union and
 * precedence rules — resolveAccess is D1 reads plus this.
 */
export function buildToolFilter(entries: GrantEntry[], declared: RoleDeclaration): ToolFilter {
  // deps: matchesPattern
  throw new Error("unimplemented");
}

/**
 * The domain model over the shared D1 control plane. Construct one per request
 * (D1 bindings are request-scoped); the tunnel DO constructs its own around the
 * same binding for upsertDeclaredRoles. Methods are row-level primitives: they
 * keep the row invariants (slug uniqueness, kind immutability, mode/envelope
 * agreement) but never orchestrate across modules — token deletion, DO
 * sever/wipe, and audit rows are the caller's choreography.
 */
export class Registry {
  constructor(db: D1Database) {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Looks up one service row by (owner, slug), archived or not — the archived
   * check is a later pipeline stage, not a lookup filter. Returns null for a
   * missing slug and for the reserved `pmcp` slug alike (the builtin is
   * virtual; admin materializes it). Never throws for absence.
   */
  async getService(ownerId: string, slug: string): Promise<ServiceDetail | null> {
    // deps: D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * The services a principal can see, archived rows included: for an owner,
   * every row in their namespace; for a service account, exactly the rows it
   * holds at least one grant on — so a zero-grant account sees nothing and can
   * enumerate nothing. Never contains the virtual `pmcp` builtin. Aggregation
   * skips archived rows itself; they are returned here because the -32002
   * answer and the /services page both need them.
   */
  async listServicesFor(principal: Principal): Promise<ServiceDetail[]> {
    // deps: D1 `service` · D1 `grant_`
    throw new Error("unimplemented");
  }

  /**
   * Creates a service row with a fresh opaque id (never derived from
   * user/slug, never reused — deleting and recreating a slug can never rebind
   * a stale DO). Rejects a malformed slug ([a-z0-9-] only — no underscore; §7's
   * prefix split relies on it), the reserved `pmcp` slug, a duplicate (owner,
   * slug), and kind/field mismatches: proxied drafts need upstreamUrl and a
   * declaration that passes validateRoles; tunneled drafts must carry neither.
   */
  async createService(draft: ServiceDraft): Promise<ServiceDetail> {
    // deps: validateRoles · D1 `service` · crypto
    throw new Error("unimplemented");
  }

  /**
   * Patches one service row. Kind is unpatchable by construction. Declared
   * roles and upstream fields are writable for proxied rows only (tunneled
   * declarations arrive via upsertDeclaredRoles) and get the same validation
   * as create; redact paths are writable for either kind. Flipping
   * upstreamAuthMode clears the stored credential envelope in the same write —
   * the mode column and the envelope kind can never disagree; the audit row
   * for that wipe is the caller's. Throws on an unknown id.
   */
  async updateService(serviceId: string, patch: ServicePatch): Promise<ServiceDetail> {
    // deps: validateRoles · D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * Deletes the row; grant and approval rows go with it via FK cascade. Token
   * deletion and DO sever/wipe are admin's cascade, ordered D1-first — this
   * method knows nothing of them. Deleting an already-absent id is a no-op.
   */
  async deleteService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * Marks the row archived (reversible parking; roles, grants, and tokens all
   * survive). Row flag only — severing a live socket is admin's choreography.
   * Archiving an archived row is a no-op; throws on an unknown id.
   */
  async archiveService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * Clears the archived flag; the service is consumer-visible again on the
   * next request (reconnecting bots heal on their own — the hub does nothing
   * active). Unarchiving an unarchived row is a no-op; throws on an unknown id.
   */
  async unarchiveService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    throw new Error("unimplemented");
  }

  /** Looks up one service-account row by (owner, slug); null when absent. */
  async getAccount(ownerId: string, slug: string): Promise<ServiceAccount | null> {
    // deps: D1 `service_account`
    throw new Error("unimplemented");
  }

  /** Every service-account row in the namespace; grants ride grantsFor. */
  async listAccounts(ownerId: string): Promise<ServiceAccount[]> {
    // deps: D1 `service_account`
    throw new Error("unimplemented");
  }

  /**
   * Creates a service-account row with a fresh opaque id. Rejects a malformed
   * slug and a duplicate (owner, slug). Tokens are a separate, imperative
   * surface — an account is born credential-less.
   */
  async createAccount(draft: AccountDraft): Promise<ServiceAccount> {
    // deps: D1 `service_account` · crypto
    throw new Error("unimplemented");
  }

  /**
   * Deletes the row; grant rows cascade via FK. Token deletion is admin's
   * cascade. Deleting an already-absent id is a no-op.
   */
  async deleteAccount(accountId: string): Promise<void> {
    // deps: D1 `service_account`
    throw new Error("unimplemented");
  }

  /**
   * Replaces the FULL grant set for (account, service) atomically — an empty
   * entries list revokes everything on that pair. Rejects the same role in
   * both modes and, for proxied services, roles absent from the declaration;
   * `all` is always grantable and never declared. Returns warnings instead of
   * failing for tunneled roles not yet declared (the file may legitimately be
   * ahead of the first connection). The `pmcp` builtin is unreachable here by
   * construction — it has no service id.
   */
  async setGrants(accountId: string, serviceId: string, entries: GrantEntry[]): Promise<string[]> {
    // deps: validateRoles · D1 `grant_` · D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * Every grant the account holds, grouped per service — the one read behind
   * account_list's inline grants and the CLI diff planner's current-state
   * picture. Services with no grants simply don't appear.
   */
  async grantsFor(accountId: string): Promise<ServiceGrants[]> {
    // deps: D1 `grant_` · D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * Resolves what a principal may call on one service, at request time — the
   * declaration is re-read on every call, so a role widened at reconnect takes
   * effect immediately. Owners get the everything-filter (roleNames ["all"]);
   * service accounts get their stored grants resolved through buildToolFilter.
   * Works unchanged for the virtual `pmcp` service: owners see everything,
   * accounts resolve to zero grants — no special case. Never throws for
   * "no access"; absence of grants is a normal ToolFilter (see roleNames).
   */
  async resolveAccess(principal: Principal, service: Service): Promise<ToolFilter> {
    // deps: buildToolFilter · D1 `grant_` · D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * The CONFIG-declared sensitive-argument paths for one tool: the union of
   * paths under every redact key matching the tool (keys are tool names or
   * patterns in the same pattern language). Empty when nothing is declared.
   * Schema-declared writeOnly paths are the tunnel backend's business; the
   * gateway unions the two before anything is stored or shown.
   */
  async redactPathsFor(service: Service, tool: string): Promise<string[]> {
    // deps: matchesPattern · D1 `service`
    throw new Error("unimplemented");
  }

  /**
   * The tunnel registration write: stores a service's self-declared roles and
   * reports drift. The DO hands the wire-shaped declaration straight here — the
   * stored column format never enters tunnel code. Throws on an invalid
   * declaration (never partially writes; callers wanting the violation list
   * for their error reply run validateRoles first), on a proxied service, and
   * on a row that no longer exists (the caller's close-4003 signal). Also
   * stamps the row's last-connected timestamp — successful registration is the
   * only moment a tunnel comes online. Drift is textual only (see DriftReport);
   * auditing a non-empty report is the caller's job.
   */
  async upsertDeclaredRoles(serviceId: string, roles: RoleDeclaration): Promise<DriftReport> {
    // deps: validateRoles · D1 `service` · D1 `grant_`
    throw new Error("unimplemented");
  }
}
