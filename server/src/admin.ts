// admin.ts — the ops table: the ONE implementation of every management operation. Three
// fronts render it with zero added capability (§8's parity invariant): the builtin `pmcp`
// MCP service (adminBackend, below), the server-rendered web pages, and — over MCP — the
// CLI. This module owns and hides: per-op input validation; cross-module cascade ordering
// on every deleting op (D1 rows are deleted in one atomic batch BEFORE the tunnel DO is
// severed/wiped, so §15's guarantee holds: a racing re-register finds no row and dies);
// the uniform rejection of the reserved `pmcp` slug (§8: one error, every op, never
// per-tool); the `admin.<tool>` audit row each mutating handler writes about itself; the
// credential wipe on an upstream auth-mode flip; and the once-only presentation of
// plaintext secrets — returned to the caller, never stored, never logged. Today that is
// token_issue's key alone: §12's bootstrap password waits on better-auth, and until then
// provisionUser hands back no secret at all rather than one nothing authenticates.
//
// Anti-decay rule, binding at review: any handler reducible to a single registry call is
// a pass-through and gets folded back into its caller — an entry earns its row only while
// it composes validation, cascade ordering, and audit.

import { env } from "cloudflare:workers";
import type { Approvals } from "./approvals";
import { query, record } from "./audit";
import { approvalsFromEnv } from "./wiring";
import { CODES, HubError, notPermitted } from "./errors";
import type { ServiceBackend, Tool } from "./gateway";
import {
  countTokensFor,
  deleteTokensForStatement,
  formatPrincipal,
  issueToken,
  listTokens,
  revokeToken,
  tokenFor,
  USERNAME_CHARSET,
} from "./identity";
import type { Principal, TokenKind } from "./identity";
import { PMCP_SLUG, Registry, RegistryRefusal, SLUG_CHARSET, writeOnlyPaths } from "./registry";
import type { GrantEntry, RoleDeclaration, ServiceAccount, ServiceDetail } from "./registry";
import { CLOSE_ARCHIVED, CLOSE_REVOKED, sever, status, wipe } from "./tunnel";
import { connectionStatus, disconnect, setHeaders } from "./upstream";
import type { UpstreamConnectionStatus } from "./upstream";

/** The control plane, resolved the way every no-binding-parameter seam here resolves it.
 *  `D1Like` is workers-env.d.ts's — the binding's shape is declared once, for everyone. */
function db(): D1Like {
  return env.DB as D1Like;
}

/** The domain model over that binding, constructed per call (D1 bindings are request-scoped). */
function registry(): Registry {
  return new Registry(db());
}

/**
 * The approval gate as the two approval ops reach it. No `push` transport is wired —
 * neither op sends one (the push belongs to `check`, which only the gateway calls) — and
 * that absence is the whole difference between this construction and the gateway's, which
 * is why it is the only thing this call says.
 */
function approvals(): Approvals {
  return approvalsFromEnv();
}

/**
 * One row of the ops table. `schema` (an OpSchema below) is the op's single source of
 * input truth: it renders BOTH the MCP tool inputSchema (adminBackend.listTools) and the
 * web form, so the two fronts can never drift. `handler` receives `ownerId`, the
 * namespace every op operates on — callers pass it only after authentication has proven
 * it is the caller's own (the gateway's §7 step 1, or the web page's cookie session);
 * handlers never re-check namespace ownership. Handlers validate input against `schema`,
 * throw HubError (errors.ts's one vocabulary) for every failure, and — when
 * mutating — write their own `admin.<tool>` audit row: a summary of the change, never a
 * secret.
 */
export type AdminOp = {
  schema: unknown;
  /**
   * Optional result schema, rendered as the tool's MCP outputSchema. Declared only where
   * it carries weight: token_issue marks its key field `writeOnly`, so §15's uniform body
   * rule masks the one admin secret — the reason no pmcp-specific logging rule exists.
   */
  outputSchema?: unknown;
  /** `input` is the RAW value off the wire — unvalidated, hence `unknown`. Everything
   *  past defineOp's wrapper calls the checked value `parsed`; one name per concept, so a
   *  reader of any `run` below knows the validation has already happened. */
  handler(ownerId: string, input: unknown): Promise<unknown>;
};

// ── the input language: one declaration renders the schema AND validates the call ──────

/**
 * What an op's field is, in the vocabulary the ops below actually take. Deliberately a
 * closed list rather than a schema library: no dependency may be added here (§4 pins
 * better-auth as the only one), and eight kinds cover every §8 tool — a ninth is a new
 * line in `render` and `coerce`, which is where a reviewer would look for it anyway.
 *
 * - `slug` — a `[a-z0-9-]` name of a service or account. The shape is registry's
 *   SLUG_CHARSET, read here so the constraint the tool ADVERTISES (the JSON Schema
 *   `pattern`) and the constraint the table ENFORCES are the same regex — a read op that
 *   advertised a shape nothing checked would be the false abstraction this table exists
 *   to avoid.
 * - `text` / `flag` / `count` — a string (optionally one of `values`), a boolean, an integer.
 * - `roleList` — §9's grant syntax: `name` or `name:approval`, one string per entry.
 * - `headerMap` — name → value, the shape `service_set_upstream_auth` seals.
 * - `pathMap` — tool-or-pattern → dot-paths, the shape `redact` / `redact_results` take (§7).
 * - `duration` — seconds, or the literal `never` (§8's `expires_in`).
 */
type Field = {
  kind: "slug" | "text" | "flag" | "count" | "roleList" | "headerMap" | "pathMap" | "duration";
  /** Rendered into the JSON Schema, so the MCP tool and the web form describe a field once. */
  description: string;
  optional?: true;
  /** `text` only: the closed set of values, rendered as `enum`. */
  values?: readonly string[];
  /** Output schemas only: the hub's internal result-secret marker (§7). */
  writeOnly?: true;
  /** Output schemas only: the field is present but may be null. */
  nullable?: true;
};

/** One op's whole input (or output) surface: what the tool is for, and what it takes. */
type OpSchema = { description: string; fields: Record<string, Field> };

/**
 * An OpSchema as JSON Schema — the ONE rendering, used for the MCP `inputSchema`, the MCP
 * `outputSchema`, and (via registry.writeOnlyPaths over the latter) the redaction map.
 * `additionalProperties: false` is not decoration: it is how "a kind change is rejected,
 * not ignored" (§8) holds for `service_update` without service_update knowing about kind.
 */
function jsonSchema(schema: OpSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    properties[name] = render(field);
    if (field.optional === undefined) required.push(name);
  }
  return {
    type: "object",
    description: schema.description,
    properties,
    required,
    additionalProperties: false,
  };
}

function render(field: Field): Record<string, unknown> {
  const base: Record<string, unknown> = { description: field.description };
  if (field.writeOnly) base.writeOnly = true;
  const nullable = <T>(type: T) => (field.nullable ? [type, "null"] : type);
  switch (field.kind) {
    case "slug":
      return { ...base, type: nullable("string"), pattern: SLUG_CHARSET.source };
    case "text":
      return { ...base, type: nullable("string"), ...(field.values ? { enum: field.values } : {}) };
    case "flag":
      return { ...base, type: nullable("boolean") };
    case "count":
      return { ...base, type: nullable("integer") };
    case "roleList":
      return { ...base, type: "array", items: { type: "string" } };
    case "headerMap":
      return { ...base, type: "object", additionalProperties: { type: "string" } };
    case "pathMap":
      return { ...base, type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
    case "duration":
      return { ...base, oneOf: [{ type: "integer" }, { const: "never" }] };
  }
}

/**
 * The op's input, checked against the same declaration the tool advertises. Every refusal
 * is the wire's `invalid params`, and every message names a FIELD, never a value: several
 * ops carry credentials (`service_set_upstream_auth`'s headers), and an error that echoed
 * one would put it on the wire and in the ledger (§15).
 */
function parseInput(schema: OpSchema, input: unknown): Record<string, unknown> {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw invalid("arguments must be an object");
  }
  const given = (input ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    // Unnamed on purpose: the name came from the caller, so naming it back is an echo.
    if (!Object.prototype.hasOwnProperty.call(schema.fields, name)) {
      throw invalid("arguments carry a field this tool does not declare");
    }
  }
  const parsed: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    const value = given[name];
    if (value === undefined) {
      if (field.optional === undefined) throw invalid(`"${name}" is required`);
      continue;
    }
    parsed[name] = coerce(name, field, value);
  }
  return parsed;
}

function coerce(name: string, field: Field, value: unknown): unknown {
  const bad = (): never => {
    throw invalid(`"${name}" has the wrong type`);
  };
  switch (field.kind) {
    case "slug":
      if (typeof value !== "string") bad();
      // The same regex `render` put in the schema: what the tool advertises is what the
      // table refuses, on read ops as much as on the creates registry also checks.
      if (!SLUG_CHARSET.test(value as string)) throw invalid(`"${name}" is not a valid slug`);
      return value;
    case "text":
      if (typeof value !== "string") bad();
      if (field.values && !field.values.includes(value as string)) {
        throw invalid(`"${name}" is not one of the values this tool accepts`);
      }
      return value;
    case "flag":
      return typeof value === "boolean" ? value : bad();
    case "count":
      return Number.isInteger(value) ? value : bad();
    case "duration":
      return value === "never" || Number.isInteger(value) ? value : bad();
    case "roleList":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : bad();
    case "headerMap":
      return isStringMap(value) ? value : bad();
    case "pathMap":
      return isPathMap(value) ? value : bad();
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  return plainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isPathMap(value: unknown): value is Record<string, string[]> {
  return (
    plainObject(value) &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((path) => typeof path === "string"),
    )
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── the one error vocabulary these ops speak ──────────────────────────────────────────

/**
 * JSON-RPC's own "invalid params" (errors.CODES.invalidParams). Not one of §7's four
 * refusal codes: those describe a CONSUMER's call being filtered, archived, gated or
 * unreachable, and every refusal below is an owner's configuration request being wrong
 * instead. The `pmcp` tools are the one place the two vocabularies meet, and keeping them
 * apart is what lets an agent tell "you may not" from "you asked wrongly".
 */
function invalid(message: string): HubError {
  return new HubError(CODES.invalidParams, message);
}

/**
 * "There is nothing here by that name", for every named thing an op can miss. One message
 * per family and no name echoed: a namespace's contents are not a caller's to enumerate
 * through error prose, and the caller already knows what they asked for.
 */
function absent(family: "service" | "service account" | "token"): HubError {
  return invalid(`no such ${family} in this namespace`);
}

/**
 * Domain refusals in the wire's vocabulary — and ONLY refusals. registry reports an
 * owner's configuration mistake as a typed RegistryRefusal naming the field it refused,
 * and that is the one thing this converts: `invalid params` carrying the field name and
 * registry's own reason, never a message this module did not authorize. A HubError is
 * already in the vocabulary and passes untouched.
 *
 * Everything else — a TypeError inside registry, a D1 failure, anything at all — is a BUG
 * and leaves unchanged, so the gateway maps it to -32603 with no cause (§15). That is the
 * half a message-forwarding version got wrong: it told the caller "you asked wrongly"
 * about a defect, and it put whatever prose the throw happened to carry onto the wire.
 */
async function domain<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof RegistryRefusal) throw invalid(err.message);
    throw err;
  }
}

/**
 * The uniform `pmcp`-slug rejection (§8): every op that takes a service slug —
 * `service_*`, `grant_set`, `token_issue` alike — refuses the reserved builtin slug via
 * this one check with its one error, so the reservation can never drift per-tool.
 * Internal seam, deliberately not exported: the reservation is reachable only through
 * the ops.
 */
function assertSlugNotReserved(slug: string): void {
  // deps: errors.HubError
  if (slug === PMCP_SLUG) {
    throw invalid(`the slug "${PMCP_SLUG}" is reserved for the builtin admin service`);
  }
}

// ── what every op needs before it can act ─────────────────────────────────────────────

/**
 * The namespace owner as the ledger and registry name them. Every op has already been
 * proven to act in this namespace (AdminOp.handler), and `pmcp` access is admin tokens
 * only (§8) — so the actor behind every row below is this user, and the one thing that
 * has to be looked up is what to call them.
 */
async function owner(ownerId: string): Promise<Extract<Principal, { kind: "user" }>> {
  const row = await db()
    .prepare(`SELECT "username" FROM "user" WHERE "id" = ?`)
    .bind(ownerId)
    .first<{ username: string }>();
  if (row === null) throw invalid("no such namespace");
  return { kind: "user", userId: ownerId, username: row.username };
}

/** The service a slug names, with the reservation refused first — the order every op shares. */
async function service(ownerId: string, slug: string): Promise<ServiceDetail> {
  assertSlugNotReserved(slug);
  const found = await registry().getService(ownerId, slug);
  if (found === null) throw absent("service");
  return found;
}

/** The account a slug names. No reservation applies: §8 reserves `pmcp` for SERVICE slugs. */
async function account(ownerId: string, slug: string): Promise<ServiceAccount> {
  const found = await registry().getAccount(ownerId, slug);
  if (found === null) throw absent("service account");
  return found;
}

/**
 * One `admin.<tool>` audit row: what every mutating op owes about itself (§8). `detail` is
 * a summary of the change and never a secret — token_issue records that a key was issued
 * and for whom, never the key.
 */
async function summarise(
  ownerId: string,
  op: string,
  detail: Record<string, unknown>,
  slug?: string,
): Promise<void> {
  await record(db(), {
    ownerId,
    principal: formatPrincipal(await owner(ownerId)),
    event: `admin.${op}`,
    ...(slug === undefined ? {} : { service: slug }),
    outcome: "ok",
    detail,
  });
}

// ── the tunnel DO's side of the ops that touch it ─────────────────────────────────────

/**
 * A tunneled service's eviction — sever, or sever-then-wipe — as a VERDICT rather than a
 * throw, and deliberately best-effort. D1 is the authority and every caller below has
 * already written it: by the time this runs the row is gone, the archived flag is set, or
 * the token is revoked, which is exactly §15's ordering pin. A DO that cannot be reached
 * therefore cannot resurrect access — the next request resolves D1 and refuses — so
 * failing the op, and telling an owner that a delete which HAPPENED did not, would be the
 * worse answer. Nothing is swallowed: the verdict lands in the op's own audit row, which
 * is where an owner reads what a change actually did.
 *
 * ponytail: with tunnel.ts landed (D6), a reachable DO records `ok`; `unreachable` is
 * now the genuine transport-failure verdict this seam was built to absorb.
 */
async function evict(work: () => Promise<void>): Promise<"ok" | "unreachable"> {
  try {
    await work();
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * A tunneled service's connection state for the two read ops. A probe that cannot be
 * answered reads as `offline`: a DO the hub cannot reach is holding no serving socket, and
 * a listing that failed because one service's DO was unreachable would be the wrong trade
 * for a page whose job is to show the other nine.
 */
async function tunnelStatus(serviceId: string): Promise<"online" | "offline"> {
  try {
    return await status(serviceId);
  } catch {
    return "offline";
  }
}

// ── the rows service_list and service_get serve ───────────────────────────────────────

/**
 * §8's pinned cross-front row shape, as a type rather than three paragraphs of prose: the
 * fields every variant carries, then per kind — tunneled rows carry connection status and
 * last seen; proxied rows carry the endpoint, auth mode and forward_identity in their
 * place, plus the OAuth connection state where the mode is `oauth`; the virtual builtin
 * carries neither, and says so with `builtin: true`. Credentials never appear in any
 * variant. The CLI diff/apply planner, both read ops and the /services page all read
 * exactly this, so a field added to one variant is a compile error until every producer
 * carries it — which is what "§8 pins the completeness" has to mean to be worth anything.
 */
export type ServiceRow = CommonRow & (BuiltinRow | TunnelRow | ProxyRow);

type CommonRow = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  logBodies: boolean;
  roles: RoleDeclaration;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
};

type BuiltinRow = { kind: "builtin"; builtin: true };
type TunnelRow = { kind: "tunnel"; createdAt: number; status: "online" | "offline"; lastSeen: number | null };
type ProxyRow = {
  kind: "proxy";
  createdAt: number;
  // Typed through registry's own row rather than re-declared: what a proxied service may
  // carry in these columns is registry's decision, and a second spelling here would be a
  // second answer to it.
  endpoint: ServiceDetail["upstreamUrl"];
  auth: ServiceDetail["upstreamAuthMode"];
  forwardIdentity: boolean;
  connection?: UpstreamConnectionStatus;
};

/** One real service as both read ops report it (§8's shape, above). */
async function serviceRow(detail: ServiceDetail): Promise<ServiceRow> {
  const common: CommonRow = {
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    archived: detail.archived,
    logBodies: detail.logBodies,
    roles: detail.declaredRoles,
    redact: detail.redact,
    redactResults: detail.redactResults,
  };
  if (detail.kind === "tunnel") {
    return {
      ...common,
      kind: "tunnel",
      createdAt: detail.createdAt,
      status: await tunnelStatus(detail.id),
      lastSeen: detail.lastConnectedAt,
    };
  }
  return {
    ...common,
    kind: "proxy",
    createdAt: detail.createdAt,
    endpoint: detail.upstreamUrl,
    auth: detail.upstreamAuthMode,
    forwardIdentity: detail.forwardIdentity,
    ...(detail.upstreamAuthMode === "oauth" ? { connection: await connectionStatus(detail) } : {}),
  };
}

/**
 * The virtual builtin row (§8): no `service` row exists for it, so its flags are
 * synthesized from the SAME constant gateway's virtualPmcpService reads (log_bodies ON,
 * nothing to redact, never archived, §15) rather than from a promise that the two agree.
 * Built per call — a shared mutable object handed out in every service_list result is one
 * caller's mutation away from being everybody's.
 */
function builtinRow(): ServiceRow {
  return {
    slug: PMCP_SLUG,
    name: "pmcp",
    description: "The hub's own management tools.",
    kind: "builtin",
    builtin: true,
    archived: false,
    logBodies: BUILTIN_LOG_BODIES,
    roles: {},
    redact: {},
    redactResults: {},
  };
}

/**
 * §15's log_bodies for the builtin, exported because gateway's virtualPmcpService is the
 * other half of the same decision: the builtin's schemas are the hub's own, so the
 * tunneled default applies and token_issue's key is masked by the uniform rule. One
 * constant is what makes "the same values gateway carries" true rather than claimed.
 */
export const BUILTIN_LOG_BODIES = true;

/** One service account as `account_list` reports it: the row plus its grants inline (§8). */
async function accountRow(row: ServiceAccount): Promise<Record<string, unknown>> {
  const grants: Record<string, string[]> = {};
  for (const held of await registry().grantsFor(row.id)) {
    // §9's own syntax, so what account_list reads back is what grant_set takes — the CLI
    // planner diffs one spelling against itself.
    grants[held.serviceSlug] = held.entries.map((entry) =>
      entry.mode === "approval" ? `${entry.role}:approval` : entry.role,
    );
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    grants,
  };
}

/** §9's grant syntax as stored entries. Role names contain no colon, so the suffix is
 *  unambiguous; `all` is the built-in and needs no declaration (§18 decision 10). */
function grantEntries(roles: string[]): GrantEntry[] {
  return roles.map((entry) => {
    const at = entry.indexOf(":");
    if (at < 0) return { role: entry, mode: "allow" };
    if (entry.slice(at + 1) !== "approval") {
      throw invalid(`"roles" takes a role name or "<role>:approval"`);
    }
    return { role: entry.slice(0, at), mode: "approval" };
  });
}

/** The proxy-only half of a create/update draft, spelled once for both. */
function proxyFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(input.endpoint === undefined ? {} : { upstreamUrl: input.endpoint }),
    ...(input.auth === undefined ? {} : { upstreamAuthMode: input.auth }),
    ...(input.forward_identity === undefined ? {} : { forwardIdentity: input.forward_identity }),
    ...(input.roles === undefined ? {} : { roles: input.roles as RoleDeclaration }),
  };
}

/** The either-kind half, likewise. */
function commonFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.redact === undefined ? {} : { redact: input.redact }),
    ...(input.redact_results === undefined ? {} : { redactResults: input.redact_results }),
    ...(input.log_bodies === undefined ? {} : { logBodies: input.log_bodies }),
  };
}

/** The service fields both create and update declare, so the two forms cannot drift. */
const SERVICE_FIELDS: Record<string, Field> = {
  name: { kind: "text", description: "Display name; defaults to the slug.", optional: true },
  description: { kind: "text", description: "Free-text note shown beside the service.", optional: true },
  endpoint: { kind: "text", description: "Proxied only: the upstream MCP endpoint URL.", optional: true },
  auth: {
    kind: "text",
    description: "Proxied only: which credential path this service uses.",
    values: ["headers", "oauth"],
    optional: true,
  },
  forward_identity: {
    kind: "flag",
    description: "Proxied only: send X-Pmcp-* identity headers upstream (default false).",
    optional: true,
  },
  roles: { kind: "pathMap", description: "Proxied only: role name → tool patterns.", optional: true },
  redact: { kind: "pathMap", description: "Tool-or-pattern → sensitive ARGUMENT paths.", optional: true },
  redact_results: { kind: "pathMap", description: "Tool-or-pattern → sensitive RESULT paths.", optional: true },
  log_bodies: {
    kind: "flag",
    description: "Record call bodies in the audit ledger (defaults by kind: tunneled on, proxied off).",
    optional: true,
  },
};

/** The slug field, spelled once — every op that takes one takes the same one. */
const SLUG_FIELD: Field = { kind: "slug", description: "The service's slug, unique in this namespace." };

/**
 * One row of the table, assembled so its schema is USED twice from one declaration rather
 * than restated: `defineOp` runs the input through it before `run` is entered, and
 * adminBackend renders the same object as the tool's inputSchema. Two things follow that
 * are worth the wrapper. A handler receives fields that are present, typed and declared,
 * so no `run` below opens with a validation line anybody could forget to write. And the
 * validation is bound to the op rather than to how it was reached — a front that pulls a
 * handler out of the table and calls it bare gets exactly the same checking as the MCP
 * dispatch does.
 */
function defineOp(op: {
  schema: OpSchema;
  outputSchema?: OpSchema;
  /** `parsed`, never `input`: by the time a `run` is entered the value has been through
   *  the op's own schema, and the parameter's NAME is where a reader learns that. */
  run(ownerId: string, parsed: Record<string, unknown>): Promise<unknown>;
}): AdminOp {
  return {
    schema: op.schema,
    ...(op.outputSchema === undefined ? {} : { outputSchema: op.outputSchema }),
    handler: (ownerId, input) => op.run(ownerId, parseInput(op.schema, input)),
  };
}

/**
 * The ops table — every `pmcp` tool of §8, keyed by tool name. The gateway serves these
 * through adminBackend; the web pages and CLI call the same handlers. Read ops return
 * plain JSON-serializable objects (the MCP result and the page model are the same data).
 */
export const ops: Record<string, AdminOp> = {
  /**
   * List the namespace's services as ServiceRow (above — the type is the shape §8 pins),
   * including the virtual builtin `pmcp` entry flagged `builtin: true`.
   */
  service_list: defineOp({
    schema: { description: "List this namespace's services, the builtin included.", fields: {} },
    async run(ownerId) {
      // deps: registry.listServicesFor · tunnel.status · upstream.connectionStatus
      const details = await registry().listServicesFor(await owner(ownerId));
      const services = await Promise.all(details.map(serviceRow));
      return { services: [...services, builtinRow()] };
    },
  }),

  /**
   * `{ slug }` → one service, same row shape as service_list. The reserved `pmcp` slug
   * is rejected like everywhere else (the builtin surfaces only through service_list —
   * uniformity is worth more than the corner case).
   */
  service_get: defineOp({
    schema: { description: "Read one service.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.getService · tunnel.status · upstream.connectionStatus
      const { slug } = parsed as { slug: string };
      return { service: await serviceRow(await service(ownerId, slug)) };
    },
  }),

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
  service_create: defineOp({
    schema: {
      description: "Create a service. `kind` is immutable afterwards — recreate to convert.",
      fields: {
        slug: SLUG_FIELD,
        kind: { kind: "text", description: "tunnel (dials in) or proxy (the hub forwards).", values: ["tunnel", "proxy"] },
        ...SERVICE_FIELDS,
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.createService · registry.validateRoles · audit.record
      const slug = parsed.slug as string;
      const kind = parsed.kind as "tunnel" | "proxy";
      assertSlugNotReserved(slug);
      const created = await domain(
        registry().createService({
          ownerId,
          slug,
          kind,
          ...commonFields(parsed),
          ...proxyFields(parsed),
          // registry takes a concrete name; §8 lets the owner omit one.
          name: (parsed.name as string) ?? slug,
          // §8's default for the one proxy-only field that has one; registry stores what
          // it is given, so "default 'headers'" is resolved here, where §8 states it.
          ...(kind === "proxy" && parsed.auth === undefined ? { upstreamAuthMode: "headers" as const } : {}),
        }),
      );
      await summarise(ownerId, "service_create", { slug, kind }, slug);
      return { service: await serviceRow(created) };
    },
  }),

  /**
   * Update a service: service_create's fields minus `kind` — a kind change is rejected,
   * not ignored (§8). Flipping `auth` in either direction is accepted but destructive:
   * any stored upstream credential envelope is wiped in the same write (audit row
   * `upstream.auth_mode_changed` beside this op's own `admin.service_update`), leaving
   * the service not-connected until Connect or service_set_upstream_auth runs. Role
   * redefinitions revalidate like create.
   */
  service_update: defineOp({
    schema: {
      // `kind` is absent from the fields, and additionalProperties is false — which is how
      // "a kind change is rejected, not ignored" holds without a check of its own.
      description: "Update a service. `kind` is immutable; changing `auth` wipes stored credentials.",
      fields: { slug: SLUG_FIELD, ...SERVICE_FIELDS },
    },
    async run(ownerId, parsed) {
      // deps: registry.updateService · registry.validateRoles · audit.record
      const slug = parsed.slug as string;
      const before = await service(ownerId, slug);
      const flipped = parsed.auth !== undefined && parsed.auth !== before.upstreamAuthMode;
      const patch = { ...commonFields(parsed), ...proxyFields(parsed) };
      const updated = await domain(registry().updateService(before.id, patch));
      // The field NAMES, not their values: several are configuration an owner wants to see
      // changed in the ledger, and none of them is a credential (§8's write-only pair is
      // its own op).
      await summarise(ownerId, "service_update", { slug, fields: Object.keys(patch) }, slug);
      if (flipped) {
        // registry cleared the envelope in the same write (its row invariant); the row
        // SAYING so is this op's, because registry never audits.
        await record(db(), {
          ownerId,
          principal: formatPrincipal(await owner(ownerId)),
          event: "upstream.auth_mode_changed",
          service: slug,
          outcome: "ok",
          detail: { from: before.upstreamAuthMode, to: parsed.auth, credentials: "wiped" },
        });
      }
      return { service: await serviceRow(updated) };
    },
  }),

  /**
   * `{ slug }` — terminal delete. Cascade ordering pinned (§15): the service row (grants
   * cascade by FK) and its token rows go FIRST, in ONE D1 batch — both or neither, D1
   * having no interactive transaction to offer instead; only then is the tunnel DO told
   * to sever the live socket (close 4001) and wipe cached state — so a racing re-register
   * finds neither row nor token and fails, never rebinding. Proxied services stop after
   * the batch (no DO, no tokens). The DO stays addressed by the opaque service.id, dead
   * forever. Everything that can refuse — the reservation, the lookup — runs before the
   * batch, so a refused delete deletes nothing.
   */
  service_delete: defineOp({
    schema: { description: "Delete a service, its grants, and its tokens. Terminal.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.deleteServiceStatement · identity.countTokensFor · identity.deleteTokensForStatement · tunnel.sever · tunnel.wipe · audit.record
      const { slug } = parsed as { slug: string };
      const target = await service(ownerId, slug);
      const tokens = await countTokensFor(target.id);
      // The credential leads the batch: if a future D1 ever tore one apart, the surviving
      // half must be "the token is dead and the row is not", never the reverse.
      await db().batch([
        deleteTokensForStatement(target.id),
        registry().deleteServiceStatement(target.id),
      ]);
      const tunnel =
        target.kind === "tunnel"
          ? await evict(async () => {
              await sever(target.id, CLOSE_REVOKED);
              await wipe(target.id);
            })
          : undefined;
      await summarise(
        ownerId,
        "service_delete",
        { slug, kind: target.kind, tokens, ...(tunnel === undefined ? {} : { tunnel }) },
        slug,
      );
      return { slug };
    },
  }),

  /**
   * `{ slug, headers }` — store the static headers the hub sends upstream. Proxied
   * `auth: headers` services only: rejected on tunneled services and on `auth: oauth`
   * ones (each mode has exactly one credential path, §8). Write-only and imperative
   * like token_issue: headers are sealed into the encrypted envelope and never readable
   * back through any tool, page, or YAML; the audit row says auth was set, not what to.
   */
  service_set_upstream_auth: defineOp({
    schema: {
      description: "Store the upstream headers this proxied service is called with. Write-only.",
      fields: {
        slug: SLUG_FIELD,
        headers: { kind: "headerMap", description: "Header name → value, sealed at rest and never readable back." },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.getService · upstream.setHeaders · audit.record
      const { slug, headers } = parsed as { slug: string; headers: Record<string, string> };
      const target = await service(ownerId, slug);
      await setHeaders(target, headers);
      // The COUNT, never the names or the values: this row exists to say auth was set.
      await summarise(
        ownerId,
        "service_set_upstream_auth",
        { slug, headers: Object.keys(headers).length },
        slug,
      );
      return { slug };
    },
  }),

  /**
   * `{ slug }` — `auth: oauth` proxied services only: wipe the stored token bundle
   * (audit row `upstream.disconnected`), leaving the service not-connected until the
   * owner runs Connect again. The web Disconnect button fronts this; Connect itself has
   * no tool — the consent redirect is inherently a browser interaction (§8).
   */
  service_disconnect: defineOp({
    schema: { description: "Wipe an oauth-mode proxied service's stored token bundle.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.getService · upstream.disconnect · audit.record
      const { slug } = parsed as { slug: string };
      const target = await service(ownerId, slug);
      if (target.kind !== "proxy" || target.upstreamAuthMode !== "oauth") {
        throw invalid("only an oauth-mode proxied service can be disconnected");
      }
      await disconnect(target);
      await summarise(ownerId, "service_disconnect", { slug }, slug);
      return { slug };
    },
  }),

  /**
   * `{ slug }` — reversible parking (§6): the archived flag lands in D1 first (so a
   * retrying bot meets 403 at upgrade), then any live socket is severed (close 4002 —
   * the client library keeps retrying at max backoff). Consumers see -32002 scoped and
   * nothing aggregated; roles, grants, tokens, and the cached catalog are all retained.
   */
  service_archive: defineOp({
    schema: { description: "Hide a service from consumers, retaining everything.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.archiveService · tunnel.sever · audit.record
      const { slug } = parsed as { slug: string };
      const target = await service(ownerId, slug);
      await registry().archiveService(target.id);
      const tunnel =
        target.kind === "tunnel" ? await evict(() => sever(target.id, CLOSE_ARCHIVED)) : undefined;
      await summarise(ownerId, "service_archive", { slug, ...(tunnel === undefined ? {} : { tunnel }) }, slug);
      return { slug };
    },
  }),

  /**
   * `{ slug }` — clear the archived flag; everything retained at archive time is live
   * again, and the bot's max-backoff retry reconnects within a minute without being
   * touched (§6).
   */
  service_unarchive: defineOp({
    schema: { description: "Make an archived service visible to consumers again.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.unarchiveService · audit.record
      const { slug } = parsed as { slug: string };
      const target = await service(ownerId, slug);
      await registry().unarchiveService(target.id);
      await summarise(ownerId, "service_unarchive", { slug }, slug);
      return { slug };
    },
  }),

  /**
   * List service accounts with their grants inline — per service: role names and modes
   * (§8). One service_list plus one account_list is the complete desired-state read the
   * CLI diff planner depends on; there is deliberately no separate grant-read tool.
   */
  account_list: defineOp({
    schema: { description: "List this namespace's service accounts and their grants.", fields: {} },
    async run(ownerId) {
      // deps: registry.listAccounts · registry.grantsFor
      const rows = await registry().listAccounts(ownerId);
      return { accounts: await Promise.all(rows.map(accountRow)) };
    },
  }),

  /** `{ slug, name?, description? }` — create a service account. Slug `[a-z0-9-]`,
   *  unique per owner. Holds no grants until grant_set. */
  account_create: defineOp({
    schema: {
      description: "Create a service account. It holds no grants until grant_set runs.",
      fields: {
        slug: { kind: "slug", description: "The account's slug, unique in this namespace." },
        name: { kind: "text", description: "Display name; defaults to the slug.", optional: true },
        description: { kind: "text", description: "Free-text note shown beside the account.", optional: true },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.createAccount · audit.record
      const slug = parsed.slug as string;
      const created = await domain(
        registry().createAccount({
          ownerId,
          slug,
          name: (parsed.name as string) ?? slug,
          description: parsed.description as string | undefined,
        }),
      );
      await summarise(ownerId, "account_create", { slug });
      return { account: await accountRow(created) };
    },
  }),

  /**
   * `{ slug }` — terminal delete: the account row (grants cascade by FK) and the
   * account's token rows go together in one D1 batch, so a racing request can never
   * authenticate against a half-deleted account. Accounts hold no sockets — the rows are
   * the whole cascade (the §15 ordering pin is satisfied vacuously).
   */
  account_delete: defineOp({
    schema: {
      description: "Delete a service account, its grants, and its tokens. Terminal.",
      fields: { slug: { kind: "slug", description: "The account's slug." } },
    },
    async run(ownerId, parsed) {
      // deps: registry.deleteAccountStatement · identity.countTokensFor · identity.deleteTokensForStatement · audit.record
      const { slug } = parsed as { slug: string };
      const target = await account(ownerId, slug);
      const tokens = await countTokensFor(target.id);
      await db().batch([
        deleteTokensForStatement(target.id),
        registry().deleteAccountStatement(target.id),
      ]);
      await summarise(ownerId, "account_delete", { slug, tokens });
      return { slug };
    },
  }),

  /**
   * `{ account, service, roles }` — replace the FULL grant set for the pair: roles
   * absent from the list are revoked (§8). Each entry is `name` or `name:approval`
   * (§9's syntax — role names contain no colon, so the suffix is unambiguous); the same
   * role in both modes is a config error. Registry's role language validates: undeclared
   * roles warn for tunneled services (the file may be ahead of first connect) and
   * hard-error for proxied ones; `all` is grantable, never declarable. `pmcp` is
   * rejected — service accounts can never hold admin grants (§8).
   */
  grant_set: defineOp({
    schema: {
      description: "Replace the full grant set for one (account, service) pair.",
      fields: {
        account: { kind: "slug", description: "The service account's slug." },
        service: { kind: "slug", description: "The service's slug." },
        roles: { kind: "roleList", description: 'Role names, each optionally suffixed ":approval".' },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.setGrants · audit.record
      // Aliased because `account` and `service` are the two resolvers on the next lines.
      const {
        account: accountSlug,
        service: serviceSlug,
        roles,
      } = parsed as { account: string; service: string; roles: string[] };
      const holder = await account(ownerId, accountSlug);
      const target = await service(ownerId, serviceSlug);
      const entries = grantEntries(roles);
      const warnings = await domain(registry().setGrants(holder.id, target.id, entries));
      await summarise(
        ownerId,
        "grant_set",
        { account: accountSlug, service: serviceSlug, roles },
        serviceSlug,
      );
      return { account: accountSlug, service: serviceSlug, roles, warnings };
    },
  }),

  /**
   * `{ status?, limit? }` → approval requests, newest first, pending and history alike
   * (§8). Lazy expiry applies on this read (approvals flips past-expiry pending rows and
   * writes `approval.expired` exactly once, §7). Read-only — no admin audit row.
   */
  approval_list: defineOp({
    schema: {
      description: "List approval requests, newest first — pending and history alike.",
      fields: {
        status: {
          kind: "text",
          description: "Narrow to one status.",
          values: ["pending", "approved", "rejected", "expired", "used"],
          optional: true,
        },
        limit: { kind: "count", description: "How many rows to return (default 100).", optional: true },
      },
    },
    async run(ownerId, parsed) {
      // deps: approvals.list
      return { approvals: await approvals().list(ownerId, parsed) };
    },
  }),

  /**
   * `{ id, decision: 'approve' | 'reject' }` — decide one pending, unexpired approval;
   * anything else (already decided, expired, another namespace's id) is an error. The
   * /approvals buttons and `pmcp approve/reject` are both fronts for this op. The
   * lifecycle audit row (`approval.approved`/`.rejected`) is approvals' write; this
   * handler adds its own `admin.approval_decide`.
   */
  approval_decide: defineOp({
    schema: {
      description: "Approve or reject one pending approval request.",
      fields: {
        id: { kind: "text", description: "The approval request's id." },
        decision: { kind: "text", description: "approve or reject.", values: ["approve", "reject"] },
      },
    },
    async run(ownerId, parsed) {
      // deps: approvals.decide · audit.record
      const { id, decision } = parsed as { id: string; decision: "approve" | "reject" };
      await approvals().decide(ownerId, id, decision);
      await summarise(ownerId, "approval_decide", { approvalId: id, decision });
      return { id, decision };
    },
  }),

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
  token_issue: defineOp({
    schema: {
      description: "Mint a credential. The plaintext key is shown once, here, and never again.",
      fields: {
        kind: {
          kind: "text",
          description: "service_account (an agent's key) or service (a tunneled service's key).",
          values: ["service_account", "service"],
        },
        slug: { kind: "slug", description: "The account or service the key is bound to." },
        expires_in: {
          kind: "duration",
          description: "Seconds until expiry, or never. Defaults by kind: 90 days for an account key, never for a service key.",
          optional: true,
        },
      },
    },
    outputSchema: {
      description: "The minted credential.",
      fields: {
        id: { kind: "text", description: "The token row's id — what token_revoke takes." },
        token: {
          kind: "text",
          description: "The plaintext key. Shown once; the hub stores only its SHA-256.",
          // The hub's internal result-secret marker (§7): §15's uniform body rule reads it
          // through registry.writeOnlyPaths and masks the key wherever bodies are recorded.
          writeOnly: true,
        },
        prefix: { kind: "text", description: "The first characters, as token_list displays them." },
        kind: { kind: "text", description: "Which credential kind was minted." },
        slug: { kind: "slug", description: "What it is bound to." },
        expiresAt: { kind: "count", description: "Epoch ms, or null when it never expires.", nullable: true },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.getService · registry.getAccount · identity.issueToken · identity.tokenFor · audit.record
      const { kind, slug, expires_in } = parsed as {
        kind: TokenKind;
        slug: string;
        expires_in?: number | "never";
      };
      assertSlugNotReserved(slug);
      const refId = await referentOf(ownerId, kind, slug);
      const issued = await issueToken({ kind, refId, expiresIn: expires_in });
      // Read back rather than recomputed: the display prefix and the resolved expiry are
      // identity's decisions, and its own read is where it makes them — a second spelling
      // here would be a second answer to "how much of a key may be shown".
      const row = await tokenFor(ownerId, issued.id);
      if (row === null) throw absent("token"); // the row was written one statement ago
      // What was issued and for whom — never the key itself (§8).
      await summarise(ownerId, "token_issue", { kind, slug, tokenId: issued.id });
      return {
        id: issued.id,
        token: issued.token,
        prefix: row.prefix,
        kind,
        slug,
        expiresAt: row.expiresAt,
      };
    },
  }),

  /**
   * List the namespace's tokens: kind, referenced slug, display prefix, created,
   * expiry, revocation, and coarse `last_used_at` (updated at most hourly, §5 — makes
   * leaked-token use and rotation state observable). Never plaintext, never the hash.
   */
  token_list: defineOp({
    schema: { description: "List this namespace's credentials. Never plaintext.", fields: {} },
    async run(ownerId) {
      // deps: identity.listTokens
      return { tokens: await listTokens(ownerId) };
    },
  }),

  /**
   * `{ id }` — revoke a token; consumer checks see it immediately (§15). Ordering
   * pinned: the row is revoked in D1 BEFORE any socket action, so a racing reconnect
   * presents a dead credential. Revoking a service token whose connection is live
   * additionally severs that socket (close 4001, §8).
   */
  token_revoke: defineOp({
    schema: {
      description: "Revoke one credential. Immediate on every surface.",
      fields: { id: { kind: "text", description: "The token row's id, as token_list reports it." } },
    },
    async run(ownerId, parsed) {
      // deps: identity.tokenFor · identity.revokeToken · tunnel.sever · audit.record
      const { id } = parsed as { id: string };
      const target = await tokenFor(ownerId, id);
      if (target === null) throw absent("token");
      await revokeToken(ownerId, target.id);
      // Only the socket THIS token opened (§8) — a service's other credentials are still
      // good, and the connection they hold is not this revocation's business.
      const tunnel =
        target.kind === "service"
          ? await evict(() => sever(target.refId, CLOSE_REVOKED, target.id))
          : undefined;
      await summarise(
        ownerId,
        "token_revoke",
        { tokenId: target.id, kind: target.kind, slug: target.refSlug, ...(tunnel === undefined ? {} : { tunnel }) },
        target.kind === "service" ? target.refSlug : undefined,
      );
      return { id: target.id };
    },
  }),

  /**
   * `{ principal?, service?, event?, tool?, session?, since?, until?, limit?, offset? }`
   * → `{ rows, total }`, newest first (§8) — the ops-table front over audit.query, which
   * pins the filter semantics and defaults. Rows carry the recorded body fields when
   * present — post-redaction and stub-substituted, the only stored form (§15).
   * Read-only; `pmcp audit`, /audit, and the
   * JSONL export all reduce to it.
   */
  audit_query: defineOp({
    schema: {
      description: "Read the audit ledger, newest first.",
      fields: {
        principal: { kind: "text", description: "Exact principal string, e.g. sa:claude.", optional: true },
        service: { kind: "text", description: "Exact service slug.", optional: true },
        event: { kind: "text", description: "Exact event name, e.g. tools/call.", optional: true },
        tool: { kind: "text", description: "Exact unprefixed tool name.", optional: true },
        session: { kind: "text", description: "Exact client session id.", optional: true },
        since: { kind: "count", description: "Lower bound on the row timestamp, epoch ms.", optional: true },
        until: { kind: "count", description: "Upper bound on the row timestamp, epoch ms.", optional: true },
        limit: { kind: "count", description: "Page size (default 100).", optional: true },
        offset: { kind: "count", description: "Rows to skip (default 0).", optional: true },
      },
    },
    async run(ownerId, parsed) {
      // deps: audit.query
      return query(db(), ownerId, parsed);
    },
  }),
};

/**
 * The opaque id a new token binds to. Both kinds resolve their slug through the row that
 * owns it, which is also where the two kind-specific refusals live: `pmcp` is reserved
 * (checked by the caller, uniformly), and a proxied service has nothing that connects.
 */
async function referentOf(ownerId: string, kind: TokenKind, slug: string): Promise<string> {
  if (kind === "service_account") return (await account(ownerId, slug)).id;
  const target = await service(ownerId, slug);
  if (target.kind !== "tunnel") {
    throw invalid("a proxied service has nothing that connects, so it takes no service token");
  }
  return target.id;
}

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
    // deps: ops · jsonSchema (schema → inputSchema rendering)
    return Object.entries(ops).map(([name, op]) => {
      const schema = op.schema as OpSchema;
      const tool: Tool = { name, description: schema.description, inputSchema: jsonSchema(schema) };
      if (op.outputSchema !== undefined) tool.outputSchema = jsonSchema(op.outputSchema as OpSchema);
      return tool;
    });
  },
  async call(service, msg, ctx) {
    // deps: ops · errors.notPermitted
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    const op = opNamed(name);
    // The same code and the same words the gateway answers an ungranted tool with: an
    // unknown admin tool must not be distinguishable from one (§7) — which is why this
    // reaches for the shared factory rather than spelling either half again.
    if (op === undefined) throw notPermitted();
    const value = await op.handler(service.ownerId, msg.params?.arguments);
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      // Both carriers of the 2026-07-28 result: the structured half is what §15's masking
      // rule applies to, and the text half is what a client without a schema reads.
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    };
  },
  async sensitivePaths(service, tool) {
    // deps: ops · registry.writeOnlyPaths
    const op = opNamed(tool);
    if (op === undefined) return null;
    return {
      args: [],
      results: op.outputSchema === undefined ? [] : writeOnlyPaths(jsonSchema(op.outputSchema as OpSchema)),
    };
  },
};

/** An op by name, or undefined — `hasOwnProperty` so `toString` names no tool. */
function opNamed(name: string): AdminOp | undefined {
  return Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
}

/**
 * Bootstrap a namespace (§12, served by POST /internal/users — never a pmcp tool; the
 * auth family is pinned outside the parity invariant, §8). Creates the user row —
 * username plus the synthesized `<username>@users.local` placeholder email, never used —
 * and writes the audit row (principal 'bootstrap') that records the creation. Validates
 * the username charset (`[a-z0-9-]`); collision with reserved top-level routes is the
 * route's own check — the composition root owns the route table RESERVED_ROUTES derives
 * from (§2).
 *
 * Returns the id ALONE. §12's generated password belongs to the call that can also store
 * a credential for it, which is better-auth's user-create — not a dependency of this repo
 * yet (0001_auth.sql's header; D4's dispatch opens with the probe that decides it). Until
 * then the namespace has no human sign-in, and every caller that needs one fails to
 * compile here rather than holding a string that authenticates nothing. Machine
 * credentials are unaffected: they are identity's `token` table, which needs no
 * better-auth.
 */
export async function provisionUser(username: string): Promise<{ userId: string }> {
  // deps: better-auth (user create) · crypto · audit.record
  if (!USERNAME_CHARSET.test(username)) {
    throw new Error(`username must match [a-z0-9-]: "${username}"`);
  }
  const userId = crypto.randomUUID();
  const now = Date.now();
  // ponytail: the `user` row is written here rather than through better-auth. Upgrade path:
  // replace this INSERT with better-auth's user-create call — which mints the §12 password
  // AND the `account` row behind it — and widen the return to carry it back once.
  await db()
    .prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "username", "displayUsername")
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(userId, username, `${username}@users.local`, now, now, username, username)
    .run();
  await record(db(), {
    ownerId: userId,
    principal: "bootstrap",
    event: "bootstrap.user_created",
    outcome: "ok",
    detail: { username },
  });
  return { userId };
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
  const user = await db()
    .prepare(`SELECT "id" FROM "user" WHERE "username" = ?`)
    .bind(username)
    .first<{ id: string }>();
  if (!user) return; // the postcondition is absence, so an absent user is already met
  const owner: Principal = { kind: "user", userId: user.id, username };
  // Services first, one at a time through the op that owns the ordering (D1 batch, THEN
  // sever + wipe) — the `user` row's own cascade cannot reach tokens or DOs.
  const services = await new Registry(db()).listServicesFor(owner);
  for (const service of services) {
    await ops.service_delete.handler(user.id, { slug: service.slug });
  }
  await db().prepare(`DELETE FROM "user" WHERE "id" = ?`).bind(user.id).run();
  await record(db(), {
    ownerId: user.id,
    principal: "bootstrap",
    event: "bootstrap.user_deleted",
    outcome: "ok",
    detail: { username, services: services.length },
  });
}
