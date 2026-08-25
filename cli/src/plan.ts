/**
 * cli/src/plan.ts — the pure diff planner behind `pmcp diff` / `pmcp apply` (§9).
 *
 * This module OWNS the YAML config language and everything about interpreting it:
 * the document shape and its defaults (kind: tunnel, auth: headers,
 * forward_identity: false, archived: false, name: slug), the `role:approval`
 * grant suffix, every validation severity (what warns vs what hard-errors), the
 * field-by-field equality that decides an update, what counts as destructive,
 * and the order plan steps must execute in. It HIDES YAML from everything else:
 * the server only ever sees admin-tool calls (the hub never learns YAML exists),
 * and main.ts merely renders and executes the returned Plan. Everything here is
 * pure — no I/O, no clock, no network — which is exactly what makes the planner
 * testable as (desired, current) → plan (§16).
 */

/**
 * One granted role after grammar normalization: `"reader"` → allow,
 * `"reader:approval"` → approval (§2, §9). Role names contain no colon, so the
 * split is unambiguous. `role` is an exact name; the built-in `all` may appear
 * here (grantable, never declarable).
 */
export type DesiredGrant = { role: string; mode: "allow" | "approval" };

/**
 * One service as the YAML declares it, fully normalized: every default already
 * applied, so two files that mean the same thing compare equal. Tunneled
 * services never carry `roles` — their roles arrive at connect time and are not
 * desired state (§9); the proxy-only fields (`endpoint`, `auth`,
 * `forwardIdentity`, `roles`) are absent on tunnel kind. Upstream credentials
 * never appear here — the YAML declares only the `auth` mode.
 */
export type DesiredService = {
  slug: string;
  kind: "tunnel" | "proxy";
  name: string;
  description: string;
  archived: boolean;
  /** sensitive argument paths per tool-name-or-pattern (§7) — either kind */
  redact: Record<string, string[]>;
  endpoint?: string;
  auth?: "headers" | "oauth";
  forwardIdentity?: boolean;
  /** proxy only: virtual role definitions, role name → anchored patterns (§2) */
  roles?: Record<string, string[]>;
};

/**
 * One service account as declared: grants keyed by service slug. Desired state
 * is total — a (account, service) pair absent from `grants` means "no grants",
 * and the planner will clear it (§9).
 */
export type DesiredAccount = {
  slug: string;
  name: string;
  description: string;
  grants: Record<string, DesiredGrant[]>;
};

/**
 * The whole parsed file — authoritative desired state for one namespace. Users
 * and tokens are deliberately absent: secrets and humans are imperative-only
 * and never live in this file (§9).
 */
export type DesiredConfig = {
  services: DesiredService[];
  serviceAccounts: DesiredAccount[];
};

/**
 * The diff-relevant projection of one service_list row. Runtime facts (online/
 * offline, OAuth connection state, last seen) are deliberately absent — they
 * are status, not desired state, and must never influence a plan. `builtin`
 * marks the virtual `pmcp` row, which the planner never plans against.
 */
export type CurrentService = {
  slug: string;
  kind: "tunnel" | "proxy";
  name: string;
  description: string;
  archived: boolean;
  builtin: boolean;
  /** declared roles — from registration for tunnel kind, from config for proxy kind */
  roles: Record<string, string[]>;
  redact: Record<string, string[]>;
  endpoint?: string;
  auth?: "headers" | "oauth";
  forwardIdentity?: boolean;
};

/**
 * One account_list row with its grants inline — §8 pins that account_list
 * returns them, so the full current-state read is exactly two calls and there
 * is no separate grant-read tool.
 */
export type CurrentAccount = {
  slug: string;
  name: string;
  description: string;
  grants: Record<string, DesiredGrant[]>;
};

/**
 * Everything the planner is allowed to know about the server: one service_list
 * plus one account_list, nothing else (§8). Built by main.ts from those reads;
 * this module never performs them.
 */
export type CurrentState = {
  services: CurrentService[];
  accounts: CurrentAccount[];
};

/**
 * One executable unit of a plan: exactly one admin-tool call, ready to forward
 * verbatim — apply is a fold of adminCall over steps, with no interpretation
 * left to the executor. Archive transitions are their own steps
 * (service_archive / service_unarchive), mirroring §8's tool split.
 * `destructive` marks steps that irreversibly discard something — service and
 * account deletes (cascade grants, delete tokens) and a service_update carrying
 * an `auth` mode flip (wipes stored upstream credentials, §8) — and is what
 * apply's confirmation flags. `summary` is the one human line diff prints.
 */
export type PlanStep = {
  /** unprefixed admin tool name: "service_create", "grant_set", … */
  tool: string;
  /** the tool's tools/call params.arguments, exactly as sent */
  args: Record<string, unknown>;
  summary: string;
  destructive: boolean;
};

/**
 * The planner's whole answer. `steps` is valid to execute strictly in order —
 * deletes first (freeing slugs), then creates, then updates and archive/
 * unarchive transitions, then grant_set replacements — so every reference
 * exists by the time it is used. `warnings` accompany an applicable plan. A
 * non-empty `errors` means the file is invalid and the plan MUST NOT be
 * applied; steps are still computed best-effort so diff can show everything
 * at once.
 */
export type Plan = {
  steps: PlanStep[];
  warnings: string[];
  errors: string[];
};

/**
 * Normalize a YAML.parse'd document into DesiredConfig: apply every default and
 * split the `role:approval` grant suffix. Structural invalidity — wrong types,
 * or any unrecognized key, so a typo like `rols:` fails loudly instead of
 * silently planning a role wipe — throws with the offending path in the
 * message. Semantic validation (reserved slugs, dual modes, undeclared roles,
 * kind changes) is planChanges' job, so diff reports every problem in one pass.
 * Pure; never reads files.
 */
export function parseDesired(doc: unknown): DesiredConfig {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The diff: desired + current → Plan. Pure and total — semantic problems land
 * in the Plan, never as throws. Absence deletes (§9): services and accounts on
 * the server but missing from the file get delete steps, and a (account,
 * service) grant pair missing from the file plans a grant_set with an empty
 * role list. Warns: a grant naming a role a *tunneled* service hasn't declared
 * yet (the file may legitimately be ahead of the first connection; the built-in
 * `all` is exempt). Hard errors: the same on a *proxied* service (its roles
 * live in this very file); the reserved `pmcp` slug anywhere — as a service key
 * or inside a grants block (`builtin` rows are likewise excluded from the
 * delete computation); the same role granted in both modes for one (account,
 * service); and a kind change on an existing slug (kind is immutable, §8 — the
 * planner never invents the delete-and-recreate the file didn't ask for).
 */
export function planChanges(desired: DesiredConfig, current: CurrentState): Plan {
  // deps: none
  throw new Error("unimplemented");
}
