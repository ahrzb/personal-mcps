/**
 * cli/src/plan.ts — the pure diff planner behind `pmcp diff` / `pmcp apply` (§9).
 *
 * This module OWNS the YAML config language and everything about interpreting it:
 * the document shape and its defaults (kind: tunnel, auth: headers,
 * forward_identity: false, archived: false, name: slug, redact/redact_results: {},
 * log_bodies by kind — tunnel true, proxy false, §15), the `role:approval`
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
  /** identical shape, applied to result structuredContent (§7) — either kind */
  redactResults: Record<string, string[]>;
  /** audit body logging (§15) — either kind; the normalized default is by kind */
  logBodies: boolean;
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
  redactResults: Record<string, string[]>;
  logBodies: boolean;
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
  const root = asMap(doc, "(root)");
  reject(root, ["services", "service_accounts"], "(root)");
  const services = asMap(root.services, "services");
  const accounts = asMap(root.service_accounts, "service_accounts");
  return {
    services: Object.keys(services).map((slug) => parseService(slug, services[slug])),
    serviceAccounts: Object.keys(accounts).map((slug) => parseAccount(slug, accounts[slug])),
  };
}

/** Every key the service grammar knows, split by the kind that may carry it (§9). */
const COMMON_SERVICE_KEYS = ["kind", "name", "description", "archived", "redact", "redact_results", "log_bodies"];
const PROXY_ONLY_KEYS = ["endpoint", "auth", "forward_identity", "roles"];

/** One `services:` entry, defaults applied. Structural problems throw with the path. */
function parseService(slug: string, value: unknown): DesiredService {
  const path = `services.${slug}`;
  const fields = asMap(value, path);
  const kind = pick(fields.kind, ["tunnel", "proxy"], `${path}.kind`) ?? "tunnel";
  // A proxy-only key on a tunneled service is a lie about the hub's role surface, not a
  // harmless extra — so the misplacement throws exactly like an unknown key would.
  reject(fields, kind === "proxy" ? [...COMMON_SERVICE_KEYS, ...PROXY_ONLY_KEYS] : COMMON_SERVICE_KEYS, path);
  const common = {
    slug,
    kind,
    name: text(fields.name, `${path}.name`) ?? slug,
    description: text(fields.description, `${path}.description`) ?? "",
    archived: flag(fields.archived, `${path}.archived`) ?? false,
    redact: pathMap(fields.redact, `${path}.redact`),
    redactResults: pathMap(fields.redact_results, `${path}.redact_results`),
    logBodies: flag(fields.log_bodies, `${path}.log_bodies`) ?? kind === "tunnel",
  };
  if (kind === "tunnel") return common;
  const endpoint = text(fields.endpoint, `${path}.endpoint`);
  // A proxied service with no forwarding target claims a hub capability that does not
  // exist; the hub's own op requires it too.
  if (endpoint === undefined) throw new TypeError(`${path}.endpoint is required for a proxied service`);
  return {
    ...common,
    endpoint,
    auth: pick(fields.auth, ["headers", "oauth"], `${path}.auth`) ?? "headers",
    forwardIdentity: flag(fields.forward_identity, `${path}.forward_identity`) ?? false,
    roles: pathMap(fields.roles, `${path}.roles`),
  };
}

/** One `service_accounts:` entry, with every grant string split into role and mode. */
function parseAccount(slug: string, value: unknown): DesiredAccount {
  const path = `service_accounts.${slug}`;
  const fields = asMap(value, path);
  reject(fields, ["name", "description", "grants"], path);
  const grants = asMap(fields.grants, `${path}.grants`);
  return {
    slug,
    name: text(fields.name, `${path}.name`) ?? slug,
    description: text(fields.description, `${path}.description`) ?? "",
    grants: Object.fromEntries(
      Object.keys(grants).map((service) => [
        service,
        strings(grants[service], `${path}.grants.${service}`).map((grant) =>
          parseGrant(grant, `${path}.grants.${service}`),
        ),
      ]),
    ),
  };
}

/**
 * `reader` → allow, `reader:approval` → approval. Anything else with a colon throws:
 * treating an unrecognized suffix as allow would turn a one-character typo into a silent
 * privilege escalation.
 */
function parseGrant(grant: string, path: string): DesiredGrant {
  const colon = grant.indexOf(":");
  if (colon === -1) return { role: grant, mode: "allow" };
  if (grant.slice(colon + 1) === "approval") return { role: grant.slice(0, colon), mode: "approval" };
  throw new TypeError(`${path}: "${grant}" — the only grant suffix is ":approval"`);
}

// ── the parse-time type checks, each naming the path it refused ────────────────────────

function asMap(value: unknown, path: string): Record<string, unknown> {
  // `key:` with nothing under it parses as null and means "all defaults".
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}

/** Unknown keys are refused rather than ignored — a `rols:` typo must not plan a role wipe. */
function reject(fields: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw new TypeError(`${path}.${key} is not a key of this grammar`);
  }
}

function text(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function flag(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${path} must be true or false`);
  return value;
}

function pick<T extends string>(value: unknown, values: T[], path: string): T | undefined {
  const chosen = text(value, path);
  if (chosen === undefined) return undefined;
  if (!values.includes(chosen as T)) throw new TypeError(`${path} must be one of ${values.join(", ")}`);
  return chosen as T;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be a list of strings`);
  for (const entry of value) {
    if (typeof entry !== "string") throw new TypeError(`${path} must be a list of strings`);
  }
  return value as string[];
}

/** The `name → [string]` shape shared by redact, redact_results, and proxy roles. */
function pathMap(value: unknown, path: string): Record<string, string[]> {
  const map = asMap(value, path);
  return Object.fromEntries(Object.keys(map).map((key) => [key, strings(map[key], `${path}.${key}`)]));
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
  const errors: string[] = [];
  const warnings: string[] = [];
  const deletes: PlanStep[] = [];
  const creates: PlanStep[] = [];
  const updates: PlanStep[] = [];
  const grants: PlanStep[] = [];

  const onServer = new Map(current.services.filter((row) => !row.builtin).map((row) => [row.slug, row]));
  const accountsOnServer = new Map(current.accounts.map((row) => [row.slug, row]));
  /**
   * Every slug the file NAMES, valid or not — what the delete computation must not touch,
   * and the difference between "the file deletes this service" and "the file names it and
   * the planner refused it", which are opposite instructions to the operator reading a diff.
   */
  const named = new Set<string>();
  /** The subset the planner will actually emit steps for. */
  const plannable = new Map<string, DesiredService>();

  for (const service of desired.services) {
    named.add(service.slug);
    const problems = serviceProblems(service, onServer.get(service.slug));
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    plannable.set(service.slug, service);
  }

  const wantedAccounts = new Map(desired.serviceAccounts.map((account) => [account.slug, account]));

  // ── phase 1: deletes, freeing slugs before anything claims them ─────────────────────
  for (const slug of sorted(onServer.keys())) {
    if (named.has(slug)) continue;
    deletes.push({
      tool: "service_delete",
      args: { slug },
      summary: `delete service ${slug} (grants cascade, tokens deleted)`,
      destructive: true,
    });
  }
  for (const slug of sorted(accountsOnServer.keys())) {
    if (wantedAccounts.has(slug)) continue;
    deletes.push({
      tool: "account_delete",
      args: { slug },
      summary: `delete service account ${slug} (grants cascade, tokens deleted)`,
      destructive: true,
    });
  }

  // ── phase 2: creates ────────────────────────────────────────────────────────────────
  for (const slug of sorted(plannable.keys())) {
    if (onServer.has(slug)) continue;
    const service = plannable.get(slug) as DesiredService;
    creates.push({
      tool: "service_create",
      // `archived` is deliberately absent: service_create has no such property and
      // rejects additionalProperties — parking is its own step below.
      args: { slug, kind: service.kind, ...wireFields(service) },
      summary: `create ${service.kind} service ${slug}`,
      destructive: false,
    });
  }
  for (const slug of sorted(wantedAccounts.keys())) {
    if (accountsOnServer.has(slug)) continue;
    const account = wantedAccounts.get(slug) as DesiredAccount;
    creates.push({
      tool: "account_create",
      args: { slug, name: account.name, description: account.description },
      summary: `create service account ${slug}`,
      destructive: false,
    });
  }

  // ── phase 3: updates and archive transitions ────────────────────────────────────────
  for (const slug of sorted(plannable.keys())) {
    const service = plannable.get(slug) as DesiredService;
    const existing = onServer.get(slug);
    if (existing !== undefined) {
      const changed = changedFields(service, existing);
      if (Object.keys(changed).length > 0) {
        const flipped = changed.auth !== undefined;
        updates.push({
          tool: "service_update",
          args: { slug, ...changed },
          summary: `update ${slug}: ${Object.keys(changed).join(", ")}${
            flipped ? " — wipes the stored upstream credentials" : ""
          }`,
          destructive: flipped,
        });
      }
    }
    const wasArchived = existing?.archived ?? false;
    if (service.archived === wasArchived) continue;
    updates.push({
      tool: service.archived ? "service_archive" : "service_unarchive",
      args: { slug },
      summary: `${service.archived ? "archive" : "unarchive"} ${slug}`,
      destructive: false,
    });
  }

  // ── phase 4: grant_set, every (account, service) pair the file states ────────────────
  for (const slug of sorted(wantedAccounts.keys())) {
    const account = wantedAccounts.get(slug) as DesiredAccount;
    const held = accountsOnServer.get(slug)?.grants ?? {};
    for (const service of sorted(Object.keys(account.grants))) {
      const wanted = account.grants[service];
      const problems = grantProblems(service, wanted, plannable.get(service), onServer.get(service), named.has(service));
      errors.push(...problems.errors);
      warnings.push(...problems.warnings);
      if (problems.errors.length > 0) continue;
      if (!plannable.has(service)) {
        // Three states, not two: the file NAMES this service but the planner refused it —
        // its own error is already above, and calling that a delete would send the operator
        // to add back a service that is right there under a bad slug.
        if (named.has(service)) continue;
        // A pair naming a service this very plan deletes would be a step with nothing to
        // land on: the delete cascades the grants anyway, so it is dropped, loudly.
        if (onServer.has(service)) warnings.push(`${slug} → ${service}: the file deletes this service; its grants cascade`);
        continue;
      }
      if (sameRoles(wanted, held[service] ?? [])) continue;
      grants.push(grantStep(slug, service, wanted));
    }
    // Absence in the file is desired state: a pair the SERVER holds and the file omits is
    // replaced with the empty set, scoped to pairs that actually exist.
    for (const service of sorted(Object.keys(held))) {
      if (account.grants[service] !== undefined || !plannable.has(service)) continue;
      grants.push(grantStep(slug, service, []));
    }
  }

  return { steps: [...deletes, ...creates, ...updates, ...grants], warnings, errors };
}

/** One grant_set step, in the op's wire spelling: a flat list with `:approval` re-joined. */
function grantStep(account: string, service: string, roles: readonly DesiredGrant[]): PlanStep {
  const wire = roles.map((grant) => (grant.mode === "approval" ? `${grant.role}:approval` : grant.role));
  return {
    tool: "grant_set",
    args: { account, service, roles: wire },
    summary: `grant ${account} → ${service}: ${wire.length === 0 ? "(none)" : wire.join(", ")}`,
    destructive: false,
  };
}

/** Everything that makes one `services:` entry unplannable, all of it at once (§8, §9). */
function serviceProblems(service: DesiredService, existing: CurrentService | undefined): string[] {
  const problems: string[] = [];
  const path = `services.${service.slug}`;
  if (service.slug === RESERVED_SLUG) problems.push(`${path}: the \`${RESERVED_SLUG}\` slug is reserved`);
  else if (!SLUG_PATTERN.test(service.slug)) {
    problems.push(`${path}: a slug is [a-z0-9-] — an underscore makes \`<slug>_<tool>\` ambiguous`);
  }
  if (existing !== undefined && existing.kind !== service.kind) {
    problems.push(`${path}: kind is immutable (${existing.kind} on the server, ${service.kind} in the file)`);
  }
  if (service.kind === "proxy") problems.push(...roleDeclarationProblems(path, service.roles ?? {}));
  return problems;
}

/**
 * `hub/register`'s validation, applied to a proxied service's config-declared roles (§6,
 * §8). It is deliberately a SECOND implementation of `server/src/registry.ts`'s
 * validateRoles — §9 keeps the planner free of any server import — so the caps below are
 * exported and locked to `server/src/limits.ts` in the parity suite; see them.
 */
function roleDeclarationProblems(path: string, roles: Record<string, string[]>): string[] {
  const problems: string[] = [];
  for (const [role, patterns] of Object.entries(roles)) {
    if (role === BUILTIN_ROLE) problems.push(`${path}.roles.${role}: \`${BUILTIN_ROLE}\` is the built-in, never declarable`);
    else if (!ROLE_NAME_PATTERN.test(role)) {
      problems.push(`${path}.roles.${role}: a role name is [a-z0-9_-]{1,${ROLE_NAME_MAX_LENGTH}}`);
    }
    if (patterns.length > ROLE_PATTERNS_MAX) {
      problems.push(`${path}.roles.${role}: at most ${ROLE_PATTERNS_MAX} patterns`);
    }
    for (const pattern of patterns) {
      if (pattern.length > ROLE_PATTERN_MAX_LENGTH) {
        problems.push(`${path}.roles.${role}: a pattern is at most ${ROLE_PATTERN_MAX_LENGTH} characters`);
        continue;
      }
      try {
        new RegExp(`^(?:${pattern === "*" ? ".*" : pattern})$`);
      } catch {
        problems.push(`${path}.roles.${role}: "${pattern}" does not compile`);
      }
    }
  }
  return problems;
}

/**
 * The severity of one (account, service) grant list — §9's warn/error split. `declaredIn`
 * is the service only if the planner accepted it; `namedInFile` is the third state that
 * keeps "the file names this service under an invalid slug" from being reported as "no
 * such service".
 */
function grantProblems(
  service: string,
  wanted: readonly DesiredGrant[],
  declaredIn: DesiredService | undefined,
  onServer: CurrentService | undefined,
  namedInFile: boolean,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (service === RESERVED_SLUG) {
    errors.push(`grants.${service}: the \`${RESERVED_SLUG}\` slug is reserved`);
    return { errors, warnings };
  }
  // The file names it and the planner refused it: serviceProblems already reported why, and
  // a second finding about its grants would only compete with the real fix.
  if (declaredIn === undefined && namedInFile) return { errors, warnings };
  if (declaredIn === undefined && onServer === undefined) {
    errors.push(`grants.${service}: no such service in the file or on the server`);
    return { errors, warnings };
  }
  const modes = new Map<string, Set<string>>();
  for (const grant of wanted) {
    const seen = modes.get(grant.role) ?? new Set<string>();
    seen.add(grant.mode);
    modes.set(grant.role, seen);
    if (seen.size > 1) errors.push(`grants.${service}: ${grant.role} is granted in both modes`);
  }
  const kind = declaredIn?.kind ?? onServer?.kind;
  // A proxied service's roles live in this very file, so an undeclared one can never
  // become declared later; a tunneled service's arrive at connect time, so the file is
  // merely ahead of the first connection.
  const declared = kind === "proxy" ? Object.keys(declaredIn?.roles ?? {}) : Object.keys(onServer?.roles ?? {});
  for (const grant of wanted) {
    if (grant.role === BUILTIN_ROLE || declared.includes(grant.role)) continue;
    const message = `grants.${service}: role "${grant.role}" is not declared`;
    if (kind === "proxy") errors.push(message);
    else warnings.push(message);
  }
  return { errors, warnings };
}

/** The service fields as service_create takes them — snake_case, kind-appropriate. */
function wireFields(service: DesiredService): Record<string, unknown> {
  return {
    name: service.name,
    description: service.description,
    redact: service.redact,
    redact_results: service.redactResults,
    log_bodies: service.logBodies,
    ...(service.kind === "proxy"
      ? {
          endpoint: service.endpoint,
          auth: service.auth,
          forward_identity: service.forwardIdentity,
          roles: service.roles ?? {},
        }
      : {}),
  };
}

/**
 * The fields that differ, in the op's wire spelling. `archived` is never among them (it
 * has its own ops) and a tunneled service's `roles` are never compared — they arrive at
 * connect time and are not desired state (§9).
 */
function changedFields(service: DesiredService, existing: CurrentService): Record<string, unknown> {
  const wire = wireFields(service);
  const server: Record<string, unknown> = {
    name: existing.name,
    description: existing.description,
    redact: existing.redact,
    redact_results: existing.redactResults,
    log_bodies: existing.logBodies,
    endpoint: existing.endpoint,
    auth: existing.auth,
    forward_identity: existing.forwardIdentity,
    roles: existing.roles,
  };
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    if (!deepEqual(value, server[key])) changed[key] = value;
  }
  return changed;
}

/** Two grant lists as the same set, order and spelling normalized. */
function sameRoles(a: readonly DesiredGrant[], b: readonly DesiredGrant[]): boolean {
  const key = (grants: readonly DesiredGrant[]): string =>
    grants.map((grant) => `${grant.role}:${grant.mode}`).sort().join(",");
  return key(a) === key(b);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Structural equality over the JSON the config language is made of. */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The reserved slug and the two charsets §6/§8 pin — spelled once. */
const RESERVED_SLUG = "pmcp";
const BUILTIN_ROLE = "all";
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * The role caps, EXPORTED because they are a second copy of the server's rule and a copy
 * needs a lock: §9 forbids plan.ts importing from the server (the planner is pure and the
 * hub never learns YAML exists), so `server/test/worker/contracts.test.ts` reads these by
 * name beside `server/src/limits.ts`'s and fails when the two drift. Without that case the
 * planner would keep calling a file valid that `pmcp apply` then dies on server-side —
 * after the destructive delete phase has already run. The name charset is derived from the
 * cap rather than baked into the pattern, so there is one number per rule here too.
 */
export const ROLE_NAME_MAX_LENGTH = 64;
export const ROLE_PATTERN_MAX_LENGTH = 128;
export const ROLE_PATTERNS_MAX = 64;
const ROLE_NAME_PATTERN = new RegExp(`^[a-z0-9_-]{1,${ROLE_NAME_MAX_LENGTH}}$`);
