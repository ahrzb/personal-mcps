// admin.ts — the ops table: the ONE implementation of every management operation. Three
// fronts render it with zero added capability (§8's parity invariant): the builtin `pmcp`
// MCP app (adminBackend, below), the server-rendered web pages, and — over MCP — the
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
import { RESERVED_APP_SLUGS } from "./app-routes";
import type { Approvals } from "./approvals";
import { query, record } from "./audit";
import { approvalsFromEnv } from "./wiring";
import { CODES, HubError, methodNotFound, notPermitted } from "./errors";
import type { AppBackend, Tool } from "./gateway";
import {
  countTokensFor,
  deleteTokensForStatement,
  formatPrincipal,
  issueAdminToken,
  issueToken,
  listAdminTokens,
  listTokens,
  revokeAdminToken,
  revokeToken,
  tokenFor,
  USERNAME_CHARSET,
} from "./identity";
import type { Principal, TokenKind } from "./identity";
import { HUB_HARD_MAX_TIMEOUT_MS, HUB_MIN_TIMEOUT_MS } from "./limits";
import { listConnections, revokeConnection } from "./oauth";
import type { AliasDiagnostic, AliasReservation, TypescriptAliases } from "./hub-types";
import {
  APP_CAPABILITIES,
  HUB_SLUG,
  PMCP_SLUG,
  Registry,
  RegistryRefusal,
  patchViolations,
  SLUG_CHARSET,
  writeOnlyPaths,
} from "./registry";
import type { GrantEntry, RoleDeclaration, Agent, AgentPatch, AppDetail, Violation } from "./registry";
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
 * - `slug` — a `[a-z0-9-]` name of an app or agent. The shape is registry's
 *   SLUG_CHARSET, read here so the constraint the tool ADVERTISES (the JSON Schema
 *   `pattern`) and the constraint the table ENFORCES are the same regex — a read op that
 *   advertised a shape nothing checked would be the false abstraction this table exists
 *   to avoid.
 * - `text` / `flag` / `count` — a string (optionally one of `values`), a boolean, an integer.
 * - `stringList` — a list of strings, each optionally one of `values`: §9's grant syntax
 *   (`name` or `name:approval`), and §20.2's capability vocabulary, which is a CLOSED set
 *   and therefore renders as an `enum` an agent and the web form both read — the same
 *   "what the tool advertises is what the table refuses" the `slug` bullet states.
 * - `headerMap` — name → value, the shape `app_set_upstream_auth` seals.
 * - `pathMap` — tool-or-pattern → dot-paths, the shape `redact` / `redact_results` take (§7).
 * - `roleDeclaration` — a proxied app's virtual roles (§8, widened by §20.3): role
 *   name → either a bare pattern list OR the per-family object, mixable across roles in
 *   one declaration. This layer checks only the SHAPE (registry.RoleDeclaration's own
 *   union) — never family names, pattern compilation, or the size caps, which is
 *   registry.validateRoles' job inside `createApp`/`updateApp` (via `domain`,
 *   below); a shape this loose still refuses every malformed value `pathMap` used to.
 * - `aliasMap` — §23.6's `typescript_aliases`: optional `service` string plus an optional
 *   `tools` object of canonicalName → alias. Shape only, `roleDeclaration`'s own
 *   division of labour: the identifier grammar, the reserved names and the atomic
 *   collision arbitration are registry's (assertTypescriptAliases and the reservation
 *   planner), so the op advertises and the table enforces one shape while one module owns
 *   the language.
 * - `duration` — seconds, or the literal `never` (§8's `expires_in`).
 */
type Field = {
  kind:
    | "slug"
    | "text"
    | "flag"
    | "count"
    | "stringList"
    | "headerMap"
    | "pathMap"
    | "roleDeclaration"
    | "aliasMap"
    | "duration";
  /** Rendered into the JSON Schema, so the MCP tool and the web form describe a field once. */
  description: string;
  optional?: true;
  /** `text` and `stringList` only: the closed set of values, rendered as `enum` (on the
   *  list kind, the ITEM's enum) and refused by `coerce` — one constant, advertised and
   *  enforced. */
  values?: readonly string[];
  /** `count` only: the inclusive bounds `coerce` enforces, rendered as `minimum`/`maximum`
   *  so the advertised JSON Schema is the checked rule (§8's "what the tool advertises is
   *  what the table refuses"). Cross-field rules (a pair's ordering) stay in the handler,
   *  because JSON Schema cannot state them. */
  minimum?: number;
  maximum?: number;
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
 * not ignored" (§8) holds for `app_update` without app_update knowing about kind.
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
      return {
        ...base,
        type: nullable("integer"),
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      };
    case "stringList":
      return { ...base, type: "array", items: { type: "string", ...(field.values ? { enum: field.values } : {}) } };
    case "headerMap":
      return { ...base, type: "object", additionalProperties: { type: "string" } };
    case "pathMap":
      return { ...base, type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
    case "roleDeclaration":
      return {
        ...base,
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
          ],
        },
      };
    case "aliasMap":
      return {
        ...base,
        type: "object",
        properties: {
          service: { type: "string" },
          tools: { type: "object", additionalProperties: { type: "string" } },
        },
        additionalProperties: false,
      };
    case "duration":
      return { ...base, oneOf: [{ type: "integer" }, { const: "never" }] };
  }
}

/**
 * The op's input, checked against the same declaration the tool advertises. Every refusal
 * is the wire's `invalid params`, and every message names a FIELD, never a value: several
 * ops carry credentials (`app_set_upstream_auth`'s headers), and an error that echoed
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
      if (field.optional === undefined) throw refuse(name, `"${name}" is required`);
      continue;
    }
    parsed[name] = coerce(name, field, value);
  }
  return parsed;
}

function coerce(name: string, field: Field, value: unknown): unknown {
  const bad = (): never => {
    throw refuse(name, `"${name}" has the wrong type`);
  };
  switch (field.kind) {
    case "slug":
      if (typeof value !== "string") bad();
      // The same regex `render` put in the schema: what the tool advertises is what the
      // table refuses, on read ops as much as on the creates registry also checks.
      if (!SLUG_CHARSET.test(value as string)) throw refuse(name, `"${name}" is not a valid slug`);
      return value;
    case "text":
      if (typeof value !== "string") bad();
      if (field.values && !field.values.includes(value as string)) {
        throw refuse(name, `"${name}" is not one of the values this tool accepts`);
      }
      return value;
    case "flag":
      return typeof value === "boolean" ? value : bad();
    case "count": {
      if (!Number.isInteger(value)) bad();
      const count = value as number;
      if (field.minimum !== undefined && count < field.minimum) {
        throw refuse(name, `"${name}" is below the minimum this tool accepts`);
      }
      if (field.maximum !== undefined && count > field.maximum) {
        throw refuse(name, `"${name}" is above the maximum this tool accepts`);
      }
      return count;
    }
    case "duration":
      return value === "never" || Number.isInteger(value) ? value : bad();
    case "stringList": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) bad();
      const values = field.values;
      // The same closed set `render` put in the schema, refused where it is declared.
      if (values && !(value as string[]).every((entry) => values.includes(entry))) {
        throw refuse(name, `"${name}" is not one of the values this tool accepts`);
      }
      return value;
    }
    case "headerMap":
      return isStringMap(value) ? value : bad();
    case "pathMap":
      return isPathMap(value) ? value : bad();
    case "roleDeclaration":
      return isRoleDeclaration(value) ? value : bad();
    case "aliasMap":
      return isTypescriptAliases(value) ? value : bad();
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

/** §20.3's wire shape, checked for STRUCTURE only — a bare pattern list, or the per-family
 *  object, per role. registry.validateRoles is the semantic authority (family names,
 *  pattern compilation, size caps); this only keeps a value neither arm can be out. */
function isRoleDeclaration(value: unknown): value is RoleDeclaration {
  return (
    plainObject(value) &&
    Object.values(value).every(
      (declared) =>
        (Array.isArray(declared) && declared.every((pattern) => typeof pattern === "string")) ||
        isPathMap(declared),
    )
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** §23.6's alias shape, checked for STRUCTURE only (see the `aliasMap` bullet): an
 *  optional `service` string and an optional `tools` object of string values. The
 *  identifier grammar and the reserved names are registry's, so a value this loose still
 *  cannot smuggle a non-string alias past the op. */
function isTypescriptAliases(value: unknown): value is TypescriptAliases {
  if (!plainObject(value)) return false;
  const { service, tools } = value;
  if (service !== undefined && typeof service !== "string") return false;
  if (tools === undefined) return true;
  return plainObject(tools) && Object.values(tools).every((alias) => typeof alias === "string");
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
 * The same -32602 as a LIST (§8): `violations` is every violation the call found, in the
 * op's own field names, and `message` joins their sentences with `; ` — so `pmcp` prints
 * them all and §13's add-app form places each under the control it names. The list rides
 * the error object for in-process callers and never the wire: `data` is -32003's alone
 * (§7), so the mapping serializes code and message and nothing else. The one builder,
 * because the two halves may never disagree: the message a caller reads is the list a
 * caller parses, spelled out.
 */
function refusedWith(violations: readonly Violation[]): HubError {
  const refusal = invalid(violations.map((violation) => violation.reason).join("; "));
  refusal.violations = violations;
  return refusal;
}

/** A refusal about ONE named input — the shape almost every check below produces. */
function refuse(field: string, sentence: string): HubError {
  return refusedWith([{ field, reason: sentence }]);
}

/**
 * "There is nothing here by that name", for every named thing an op can miss. One message
 * per family and no name echoed: a namespace's contents are not a caller's to enumerate
 * through error prose, and the caller already knows what they asked for.
 */
function absent(family: "app" | "agent" | "token" | "connection"): HubError {
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
    // The refusal's own list rides along, so EVERY -32602 out of these ops carries one —
    // including the single-violation refusal a race produces after the ops already looked.
    if (err instanceof RegistryRefusal) throw refusedWith(err.violations);
    throw err;
  }
}

/**
 * §8's endpoint rule, at the OWNER'S TRUST BOUNDARY and deliberately not in the registry:
 * an `https://` URL, or `http://` to loopback, and nothing else — refused at create and
 * update alike, before anything is stored or dialed. It lives here because the registry is
 * a storage layer whose seeds and fixtures store what they like (decision 30, 2026-09-03),
 * and because the field this names is the OP's (`endpoint`), which the registry has never
 * heard of.
 */
function endpointViolation(endpoint: string): Violation | null {
  // deps: URL
  const url = parseUrl(endpoint);
  if (url?.protocol === "https:") return null;
  if (url?.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return { field: "endpoint", reason: `"endpoint" must be an https:// URL (http:// only for localhost)` };
}

/** The three hosts §8 lets `http://` reach. URL's `hostname` keeps the brackets on an
 *  IPv6 literal, which is why the third entry carries them. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A URL, or null — a scheme-less host is a caller's typo, not an exception. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The endpoint rule as a list, applied whenever the field is present at all — an absent
 *  `endpoint` is a different refusal (the registry's "required for a proxied app"). */
function endpointViolations(parsed: Record<string, unknown>): Violation[] {
  const endpoint = parsed.endpoint;
  if (typeof endpoint !== "string") return [];
  const violation = endpointViolation(endpoint);
  return violation === null ? [] : [violation];
}

/**
 * The uniform virtual-slug rejection (§8): every op that takes an app slug —
 * `app_*`, `grant_set`, `token_issue` alike — refuses BOTH reserved virtual slugs (`pmcp`
 * and `hub`) via this one check with its one error apiece, so the reserved set can never
 * drift per-tool. Internal seam, deliberately not exported: the reservations are
 * reachable only through the ops.
 */
function assertSlugNotReserved(slug: string): void {
  // deps: errors.HubError
  const violation = reservedSlugViolation(slug);
  if (violation !== null) throw refusedWith([violation]);
}

/** The same reservations as a VIOLATION, for `app_create` — which collects rather than
 *  throws, so its refusal can name a bad endpoint in the same breath (§8). Both virtual
 *  slugs are refused through this one check, so the reserved set can never drift per tool:
 *  `pmcp` for the builtin admin app, `hub` for §23's TypeScript surface. */
function reservedSlugViolation(slug: string): Violation | null {
  if (slug === PMCP_SLUG) {
    return { field: "slug", reason: `the slug "${PMCP_SLUG}" is reserved for the builtin admin app` };
  }
  if (slug === HUB_SLUG) {
    return { field: "slug", reason: `the slug "${HUB_SLUG}" is reserved for the TypeScript execution surface` };
  }
  return null;
}

/**
 * The SECOND reservation (§8/§13), and `app_create`'s alone: the charset-legal segments the
 * router mounts directly under `/apps/`, which an app of that name would have no page at.
 * Derived from the route table (app-routes.ts), never a list here — and NOT `pmcp`'s
 * sentence, whose reason ("reserved for the builtin") is false of a page segment. One
 * sentence with the slug substituted, so a segment added later needs no message of its own.
 *
 * Only create refuses these: no existing app can hold such a slug, so the ops that take one
 * would be refusing a row that cannot exist.
 */
function routeSlugViolation(slug: string): Violation | null {
  // deps: app-routes.RESERVED_APP_SLUGS
  return RESERVED_APP_SLUGS.has(slug)
    ? { field: "slug", reason: `the slug "${slug}" is reserved: /apps/${slug} is a page` }
    : null;
}

/** Both slug reservations as one list — `app_create`'s own half of its violations. */
function slugViolations(slug: string): Violation[] {
  return [reservedSlugViolation(slug), routeSlugViolation(slug)].filter(
    (violation): violation is Violation => violation !== null,
  );
}

// ── what every op needs before it can act ─────────────────────────────────────────────

/**
 * The namespace owner as the ledger and registry name them. Every op has already been
 * proven to act in this namespace (AdminOp.handler), and `pmcp` access is admin tokens
 * only (§8) — so the actor behind every row below is this user, and the one thing that
 * has to be looked up is what to call them.
 *
 * Exported because "what is this owner's username" has ONE answer and one home: gateway's
 * `ownerCatalog` builds the same principal for the same reason, and a second copy of the
 * `user` read is a second place for the not-found arm to disagree.
 */
export async function owner(ownerId: string): Promise<Extract<Principal, { kind: "user" }>> {
  const row = await db()
    .prepare(`SELECT "username" FROM "user" WHERE "id" = ?`)
    .bind(ownerId)
    .first<{ username: string }>();
  if (row === null) throw invalid("no such namespace");
  return { kind: "user", userId: ownerId, username: row.username };
}

/** The app a slug names, with the reservation refused first — the order every op shares. */
async function app(ownerId: string, slug: string): Promise<AppDetail> {
  assertSlugNotReserved(slug);
  const found = await registry().getApp(ownerId, slug);
  if (found === null) throw absent("app");
  return found;
}

/** The agent a slug names. No reservation applies: §8 reserves `pmcp` for APP slugs. */
async function agent(ownerId: string, slug: string): Promise<Agent> {
  const found = await registry().getAgent(ownerId, slug);
  if (found === null) throw absent("agent");
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
    ...(slug === undefined ? {} : { app: slug }),
    outcome: "ok",
    detail,
  });
}

// ── the tunnel DO's side of the ops that touch it ─────────────────────────────────────

/**
 * A tunneled app's eviction — sever, or sever-then-wipe — as a VERDICT rather than a
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
 * A tunneled app's connection state for the two read ops. A probe that cannot be
 * answered reads as `offline`: a DO the hub cannot reach is holding no serving socket, and
 * a listing that failed because one app's DO was unreachable would be the wrong trade
 * for a page whose job is to show the other nine.
 */
async function tunnelStatus(appId: string): Promise<"online" | "offline"> {
  try {
    return await status(appId);
  } catch {
    return "offline";
  }
}

// ── the rows app_list and app_get serve ───────────────────────────────────────

/**
 * §8's pinned cross-front row shape, as a type rather than three paragraphs of prose: the
 * fields every variant carries, then per kind — tunneled rows carry connection status and
 * last seen; proxied rows carry the endpoint, auth mode, forward_identity and the declared
 * `capabilities` in their place, plus the OAuth connection state where the mode is
 * `oauth`; the virtual builtin
 * carries neither, and says so with `builtin: true`. Credentials never appear in any
 * variant. Both read operations and the `/apps` page consume exactly this shape, so a
 * field added to one variant is a compile error until every producer carries it.
 */
export type AppRow = CommonRow & (BuiltinRow | TunnelRow | ProxyRow);

type CommonRow = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  logBodies: boolean;
  roles: RoleDeclaration;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  /**
   * §23.6's owner alias CONFIGURATION, always present (`{}` when the owner configured
   * none). Reported separately from the committed reservations below, because "what the
   * owner asked for" and "what the hub committed" are two different facts §13's owner view
   * and the provider's refresh both need distinct.
   */
  typescriptAliases: TypescriptAliases;
  /**
   * §23.6's committed reservation rows for this app — tombstones included (`active` false),
   * deterministic order — i.e. the resolved map with its source lane and its history.
   */
  typescriptReservations: readonly AliasReservation[];
  /**
   * Bounded, self-scoped mapping diagnostics for this app's canonical identities: a name
   * that is contested or underivable. Recomputed from committed rows on every read, and
   * safe to render wherever the app itself is visible.
   */
  typescriptDiagnostics: readonly AliasDiagnostic[];
};

type BuiltinRow = { kind: "builtin"; builtin: true };
type TunnelRow = {
  kind: "tunnel";
  createdAt: number;
  status: "online" | "offline";
  lastSeen: number | null;
  /**
   * §20.3's owner map (2026-09-17) — the tunnel variant's alone, because a proxied app's
   * roles are already all the owner's and its `roles` IS this. Always present, `{}` when
   * the owner defined none: unlike `capabilities`, there is no "undeclared" state to
   * preserve — the column is NOT NULL DEFAULT '{}' and the Roles pane always has a map.
   */
  ownerRoles: RoleDeclaration;
};
type ProxyRow = {
  kind: "proxy";
  createdAt: number;
  // Typed through registry's own row rather than re-declared: what a proxied app may
  // carry in these columns is registry's decision, and a second spelling here would be a
  // second answer to it.
  endpoint: AppDetail["upstreamUrl"];
  auth: AppDetail["upstreamAuthMode"];
  forwardIdentity: boolean;
  /**
   * §20.2's owner-declared advertisement, made readable by §8's 2026-08-27 amendment.
   * Optional means the row reports what is stored: an app that never configured the key
   * carries no key. Filling in the `["tools"]` runtime default here would erase the
   * distinction between an absent declaration and an explicit declaration.
   */
  capabilities?: NonNullable<AppDetail["capabilities"]>;
  connection?: UpstreamConnectionStatus;
};

/** One real app as both read ops report it (§8's shape, above). */
async function appRow(detail: AppDetail): Promise<AppRow> {
  const mapping = await registry().typescriptReservationsFor(detail.id);
  const common: CommonRow = {
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    archived: detail.archived,
    logBodies: detail.logBodies,
    roles: detail.declaredRoles,
    redact: detail.redact,
    redactResults: detail.redactResults,
    typescriptAliases: detail.typescriptAliases,
    typescriptReservations: mapping.reservations,
    typescriptDiagnostics: mapping.diagnostics,
  };
  if (detail.kind === "tunnel") {
    return {
      ...common,
      kind: "tunnel",
      createdAt: detail.createdAt,
      status: await tunnelStatus(detail.id),
      lastSeen: detail.lastConnectedAt,
      ownerRoles: detail.ownerRoles,
    };
  }
  return {
    ...common,
    kind: "proxy",
    createdAt: detail.createdAt,
    endpoint: detail.upstreamUrl,
    auth: detail.upstreamAuthMode,
    forwardIdentity: detail.forwardIdentity,
    // Registry's `null` is "undeclared", and it stays absent rather than becoming a
    // default here (ProxyRow.capabilities says why).
    ...(detail.capabilities === null ? {} : { capabilities: detail.capabilities }),
    ...(detail.upstreamAuthMode === "oauth" ? { connection: await connectionStatus(detail) } : {}),
  };
}

/**
 * The virtual builtin row (§8): no `app` row exists for it, so its flags are
 * synthesized from the SAME constant gateway's virtualPmcpApp reads (log_bodies ON,
 * nothing to redact, never archived, §15) rather than from a promise that the two agree.
 * Built per call — a shared mutable object handed out in every app_list result is one
 * caller's mutation away from being everybody's.
 */
function builtinRow(): AppRow {
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
    // §23.6: the builtin is virtual — no row, no owner configuration, no reservations, so
    // the three keys report the empty facts rather than being absent from one variant of
    // the row shape (which would make every consumer branch on kind).
    typescriptAliases: {},
    typescriptReservations: [],
    typescriptDiagnostics: [],
  };
}

/**
 * §15's log_bodies for the builtin, exported because gateway's virtualPmcpApp is the
 * other half of the same decision: the builtin's schemas are the hub's own, so the
 * tunneled default applies and token_issue's key is masked by the uniform rule. One
 * constant is what makes "the same values gateway carries" true rather than claimed.
 */
export const BUILTIN_LOG_BODIES = true;

/** One agent as `agent_list` reports it: the row plus its grants inline (§8). */
async function agentRow(row: Agent): Promise<Record<string, unknown>> {
  const grants: Record<string, string[]> = {};
  for (const held of await registry().grantsFor(row.id)) {
    // agent_list and grant_set share the same role[:approval] spelling (§8).
    grants[held.appSlug] = held.entries.map((entry) =>
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

/** §8's grant syntax as stored entries: the mode is the `:approval` SUFFIX, never the first
 *  colon — an inline resource item (`resource/news://feed/*`) carries colons of its own.
 *  What is left over is the entry verbatim, role or item alike; whether it is a legal one is
 *  registry's to answer (`setGrants`), which is also where `all` is exempt from declaration. */
function grantEntries(roles: string[]): GrantEntry[] {
  return roles.map((entry) =>
    entry.endsWith(APPROVAL_SUFFIX)
      ? { role: entry.slice(0, -APPROVAL_SUFFIX.length), mode: "approval" }
      : { role: entry, mode: "allow" },
  );
}

/** The wire spelling of approval mode — the suffix `agentView` writes and this reads back. */
const APPROVAL_SUFFIX = ":approval";

/** The proxy-only half of a create/update draft, spelled once for both. */
function proxyFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(input.endpoint === undefined ? {} : { upstreamUrl: input.endpoint }),
    ...(input.auth === undefined ? {} : { upstreamAuthMode: input.auth }),
    ...(input.forward_identity === undefined ? {} : { forwardIdentity: input.forward_identity }),
    ...(input.roles === undefined ? {} : { roles: input.roles as RoleDeclaration }),
    // §20.2 — proxy-only, like `roles`: a tunnel's capability set comes from its own
    // registration-time discovery and is never owner-configured.
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities as string[] }),
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
    // §20.3's owner map is TUNNEL-only, and it is relayed here rather than from a
    // `tunnelFields` twin of proxyFields: the kind rule is registry's (assertOwnerRoles),
    // which is what makes the refusal one sentence in one place for create and update
    // alike, in the op's own field name.
    ...(input.owner_roles === undefined ? {} : { ownerRoles: input.owner_roles as RoleDeclaration }),
    // §23.6's owner alias lane: either kind, and the value is relayed whole — omission
    // preserves established configuration, which registry's patch/insert paths enforce by
    // only touching the column when the key is present.
    ...(input.typescript_aliases === undefined
      ? {}
      : { typescriptAliases: input.typescript_aliases as TypescriptAliases }),
  };
}

/** The app fields both create and update declare, so the two forms cannot drift. */
const APP_FIELDS: Record<string, Field> = {
  name: { kind: "text", description: "Display name; defaults to the slug.", optional: true },
  description: { kind: "text", description: "Free-text note shown beside the app.", optional: true },
  endpoint: { kind: "text", description: "Proxied only: the upstream MCP endpoint URL.", optional: true },
  auth: {
    kind: "text",
    description: "Proxied only: which credential path this app uses.",
    values: ["headers", "oauth"],
    optional: true,
  },
  forward_identity: {
    kind: "flag",
    description: "Proxied only: send X-Pmcp-* identity headers upstream (default false).",
    optional: true,
  },
  roles: {
    kind: "roleDeclaration",
    description:
      "Proxied only: role name → tool patterns, or (§20.3) the per-family object of tool/prompt/resource patterns.",
    optional: true,
  },
  owner_roles: {
    kind: "roleDeclaration",
    description: "Owner-defined roles on a tunneled app — the app's own declaration wins on a name collision.",
    optional: true,
  },
  typescript_aliases: {
    kind: "aliasMap",
    description:
      "Hub-local TypeScript names for this app: `service` renames its namespace, `tools` maps canonical tool names to aliases. Omission preserves established names; a collision refuses the whole write. Never renames the upstream.",
    optional: true,
  },
  capabilities: {
    kind: "stringList",
    // The vocabulary itself is registry's export, not prose: what the tool advertises,
    // what the /apps form offers, and what the hub enforces are one constant (§20.2).
    values: APP_CAPABILITIES,
    description: "Proxied only: which MCP families this upstream serves (default: tools only).",
    optional: true,
  },
  redact: { kind: "pathMap", description: "Tool-or-pattern → sensitive ARGUMENT paths.", optional: true },
  redact_results: { kind: "pathMap", description: "Tool-or-pattern → sensitive RESULT paths.", optional: true },
  log_bodies: {
    kind: "flag",
    description: "Record call bodies in the audit ledger (defaults by kind: tunneled on, proxied off).",
    optional: true,
  },
};

/** The slug field, spelled once — every op that takes one takes the same one. */
const SLUG_FIELD: Field = { kind: "slug", description: "The app's slug, unique in this namespace." };

/** The agent fields both create and update declare, so the two forms cannot drift —
 *  APP_FIELDS' twin, minus everything proxy-only: an agent is a credential holder, not
 *  an upstream, and has no `slug` here either — create takes its own (unique-per-owner)
 *  and update has none at all (§22.4: no rename op). */
const AGENT_FIELDS: Record<string, Field> = {
  name: { kind: "text", description: "Display name; defaults to the slug.", optional: true },
  description: { kind: "text", description: "Free-text note shown beside the agent.", optional: true },
};

/**
 * The same two fields as a PATCH declares them. The kinds and optionality are derived from
 * `AGENT_FIELDS` rather than restated, so the pair still cannot drift on the parts a caller
 * is validated against — only the prose differs, and it has to: `optional` means "defaults
 * to the slug" on create and "leaves the current value alone" on update, and these
 * descriptions are SERVED as the tool's inputSchema. Sharing the create wording told an
 * MCP client that omitting `name` would reset it, which would make a careful client resend
 * the current value on every patch — the one thing §22.4's partial patch exists to avoid.
 */
const AGENT_PATCH_FIELDS: Record<string, Field> = {
  name: { ...AGENT_FIELDS.name, description: "Display name; omit to leave it unchanged." },
  description: { ...AGENT_FIELDS.description, description: "Free-text note shown beside the agent; omit to leave it unchanged." },
};

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
   * List the namespace's apps as AppRow (above — the type is the shape §8 pins),
   * including the virtual builtin `pmcp` entry flagged `builtin: true`.
   */
  app_list: defineOp({
    schema: { description: "List this namespace's apps, the builtin included.", fields: {} },
    async run(ownerId) {
      // deps: registry.listAppsFor · tunnel.status · upstream.connectionStatus
      const details = await registry().listAppsFor(await owner(ownerId));
      const apps = await Promise.all(details.map(appRow));
      return { apps: [...apps, builtinRow()] };
    },
  }),

  /**
   * `{ slug }` → one app, same row shape as app_list. The reserved `pmcp` slug
   * is rejected like everywhere else (the builtin surfaces only through app_list —
   * uniformity is worth more than the corner case).
   */
  app_get: defineOp({
    schema: { description: "Read one app.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.getApp · tunnel.status · upstream.connectionStatus
      const { slug } = parsed as { slug: string };
      return { app: await appRow(await app(ownerId, slug)) };
    },
  }),

  /**
   * Create an app. `{ slug, name?, description?, kind, redact?, redact_results?,
   * log_bodies? }` (log_bodies absent defaults by kind — tunneled on, proxied off,
   * §15) plus, for proxied
   * kind only: `endpoint`, `roles` (virtual role definitions), `auth` ('headers' |
   * 'oauth', default 'headers'), `forward_identity` (default false) — those fields are
   * rejected on tunneled creates. Slug is `[a-z0-9-]`, unique per owner, never `pmcp` or
   * `hub`. Proxied role definitions get exactly the `hub/register` validation (§6/§8): name
   * charset, `all` rejected, patterns compile, length/count caps. `kind` is immutable
   * forever after (recreate to convert). Mints no token — `token_issue` is the sole
   * credential path (§6).
   *
   * §23.6: `typescript_aliases` (either kind) sets the hub-local names for the app's
   * service and canonical tools; syntax is refused as `-32602` and a collision with another
   * identity's committed reservation refuses the whole create, while the app row and its
   * reservations commit in one batch.
   */
  app_create: defineOp({
    schema: {
      description: "Create an app. `kind` is immutable afterwards — recreate to convert.",
      fields: {
        slug: SLUG_FIELD,
        kind: { kind: "text", description: "tunnel (dials in) or proxy (the hub forwards).", values: ["tunnel", "proxy"] },
        ...APP_FIELDS,
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.violationsOf · registry.createApp · audit.record
      const slug = parsed.slug as string;
      const kind = parsed.kind as "tunnel" | "proxy";
      const draft = {
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
      };
      // §8's "every violation at once": this op's own two checks and the registry's, asked
      // before either is thrown, so a reserved slug and a bad endpoint arrive together. A
      // registry violation on a field this op already refused is the SAME fact in the
      // storage layer's words (`pmcp`), so it is dropped rather than said twice.
      const own = [...slugViolations(slug), ...endpointViolations(parsed)];
      const violations = [
        ...own,
        ...(await registry().violationsOf(draft)).filter(
          (violation) => !own.some((mine) => mine.field === violation.field),
        ),
      ];
      if (violations.length > 0) throw refusedWith(violations);
      // createApp validates again, atomically — which is what makes a slug taken between
      // the look and the write a refusal rather than a stored row (`domain` renders it).
      const created = await domain(registry().createApp(draft));
      await summarise(ownerId, "app_create", { slug, kind }, slug);
      return { app: await appRow(created) };
    },
  }),

  /**
   * Update an app: app_create's fields minus `kind` — a kind change is rejected,
   * not ignored (§8). Flipping `auth` in either direction is accepted but destructive:
   * any stored upstream credential envelope is wiped in the same write (audit row
   * `upstream.auth_mode_changed` beside this op's own `admin.app_update`), leaving
   * the app not-connected until Connect or app_set_upstream_auth runs. Role
   * redefinitions revalidate like create. §23.6: `typescript_aliases` replaces the owner
   * alias configuration whole — omitted, it preserves both the configuration and every
   * committed name — and a collision refuses the entire patch.
   */
  app_update: defineOp({
    schema: {
      // `kind` is absent from the fields, and additionalProperties is false — which is how
      // "a kind change is rejected, not ignored" holds without a check of its own.
      description: "Update an app. `kind` is immutable; changing `auth` wipes stored credentials.",
      fields: { slug: SLUG_FIELD, ...APP_FIELDS },
    },
    async run(ownerId, parsed) {
      // deps: registry.patchViolations · registry.updateApp · audit.record
      const slug = parsed.slug as string;
      const before = await app(ownerId, slug);
      const flipped = parsed.auth !== undefined && parsed.auth !== before.upstreamAuthMode;
      const patch = { ...commonFields(parsed), ...proxyFields(parsed) };
      // The same "every violation at once" as create, over the same two sources: the URL
      // rule this op owns, and the checks updateApp would have thrown at.
      const violations = [...endpointViolations(parsed), ...patchViolations(before.kind, patch)];
      if (violations.length > 0) throw refusedWith(violations);
      const updated = await domain(registry().updateApp(before.id, patch));
      // The field NAMES, not their values: several are configuration an owner wants to see
      // changed in the ledger, and none of them is a credential (§8's write-only pair is
      // its own op).
      await summarise(ownerId, "app_update", { slug, fields: Object.keys(patch) }, slug);
      if (flipped) {
        // registry cleared the envelope in the same write (its row invariant); the row
        // SAYING so is this op's, because registry never audits.
        await record(db(), {
          ownerId,
          principal: formatPrincipal(await owner(ownerId)),
          event: "upstream.auth_mode_changed",
          app: slug,
          outcome: "ok",
          detail: { from: before.upstreamAuthMode, to: parsed.auth, credentials: "wiped" },
        });
      }
      return { app: await appRow(updated) };
    },
  }),

  /**
   * `{ slug }` — terminal delete. Cascade ordering pinned (§15): the app row (grants
   * cascade by FK), its token rows and §23.6's reservation tombstones go FIRST, in ONE D1
   * batch — all or nothing, D1 having no interactive transaction to offer instead; only
   * then is the tunnel DO told to sever the live socket (close 4001) and wipe cached state
   * — so a racing re-register finds neither row nor token and fails, never rebinding
   * (and a later app reusing the slug gets a new app id, so the old names stay reserved).
   * Proxied apps stop after the batch (no DO, no tokens). The DO stays addressed by the
   * opaque app.id, dead forever. Everything that can refuse — the reservation, the lookup —
   * runs before the batch, so a refused delete deletes nothing.
   */
  app_delete: defineOp({
    schema: { description: "Delete an app, its grants, and its tokens. Terminal.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.deleteAppStatements · identity.countTokensFor · identity.deleteTokensForStatement · tunnel.sever · tunnel.wipe · audit.record
      const { slug } = parsed as { slug: string };
      const target = await app(ownerId, slug);
      const tokens = await countTokensFor(target.id);
      // The credential leads the batch: if a future D1 ever tore one apart, the surviving
      // half must be "the token is dead and the row is not", never the reverse.
      // §23.6's reservation tombstones ride the same batch (deleteAppStatements): the app's
      // names flip inactive rather than disappearing, so a deleted-and-recreated slug (a
      // NEW app id) can never claim TypeScript code written against the old member.
      await db().batch([
        deleteTokensForStatement(target.id),
        ...registry().deleteAppStatements(target.id),
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
        "app_delete",
        { slug, kind: target.kind, tokens, ...(tunnel === undefined ? {} : { tunnel }) },
        slug,
      );
      return { slug };
    },
  }),

  /**
   * `{ slug, headers }` — store the static headers the hub sends upstream. Proxied
   * `auth: headers` apps only: rejected on tunneled apps and on `auth: oauth`
   * ones (each mode has exactly one credential path, §8). Write-only and imperative
   * like token_issue: headers are sealed into the encrypted envelope and never readable
   * back through any tool, page, or provider state; the audit row says auth was set, not what to.
   */
  app_set_upstream_auth: defineOp({
    schema: {
      description: "Store the upstream headers this proxied app is called with. Write-only.",
      fields: {
        slug: SLUG_FIELD,
        headers: { kind: "headerMap", description: "Header name → value, sealed at rest and never readable back." },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.getApp · upstream.setHeaders · audit.record
      const { slug, headers } = parsed as { slug: string; headers: Record<string, string> };
      const target = await app(ownerId, slug);
      await setHeaders(target, headers);
      // The COUNT, never the names or the values: this row exists to say auth was set.
      await summarise(
        ownerId,
        "app_set_upstream_auth",
        { slug, headers: Object.keys(headers).length },
        slug,
      );
      return { slug };
    },
  }),

  /**
   * `{ slug }` — `auth: oauth` proxied apps only: wipe the stored token bundle
   * (audit row `upstream.disconnected`), leaving the app not-connected until the
   * owner runs Connect again. The web Disconnect button fronts this; Connect itself has
   * no tool — the consent redirect is inherently a browser interaction (§8).
   */
  app_disconnect: defineOp({
    schema: { description: "Wipe an oauth-mode proxied app's stored token bundle.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.getApp · upstream.disconnect · audit.record
      const { slug } = parsed as { slug: string };
      const target = await app(ownerId, slug);
      if (target.kind !== "proxy" || target.upstreamAuthMode !== "oauth") {
        throw invalid("only an oauth-mode proxied app can be disconnected");
      }
      await disconnect(target);
      await summarise(ownerId, "app_disconnect", { slug }, slug);
      return { slug };
    },
  }),

  /**
   * `{ slug }` — reversible parking (§6): the archived flag lands in D1 first (so a
   * retrying bot meets 403 at upgrade), then any live socket is severed (close 4002 —
   * the client library keeps retrying at max backoff). Consumers see -32002 scoped and
   * nothing aggregated; roles, grants, tokens, and the cached catalog are all retained.
   */
  app_archive: defineOp({
    schema: { description: "Hide an app from consumers, retaining everything.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.archiveApp · tunnel.sever · audit.record
      const { slug } = parsed as { slug: string };
      const target = await app(ownerId, slug);
      await registry().archiveApp(target.id);
      const tunnel =
        target.kind === "tunnel" ? await evict(() => sever(target.id, CLOSE_ARCHIVED)) : undefined;
      await summarise(ownerId, "app_archive", { slug, ...(tunnel === undefined ? {} : { tunnel }) }, slug);
      return { slug };
    },
  }),

  /**
   * `{ slug }` — clear the archived flag; everything retained at archive time is live
   * again, and the bot's max-backoff retry reconnects within a minute without being
   * touched (§6).
   */
  app_unarchive: defineOp({
    schema: { description: "Make an archived app visible to consumers again.", fields: { slug: SLUG_FIELD } },
    async run(ownerId, parsed) {
      // deps: registry.unarchiveApp · audit.record
      const { slug } = parsed as { slug: string };
      const target = await app(ownerId, slug);
      await registry().unarchiveApp(target.id);
      await summarise(ownerId, "app_unarchive", { slug }, slug);
      return { slug };
    },
  }),

  /**
   * List agents with their grants inline — per app: role names and modes (§8).
   * There is deliberately no separate grant-read tool.
   */
  agent_list: defineOp({
    schema: { description: "List this namespace's agents and their grants.", fields: {} },
    async run(ownerId) {
      // deps: registry.listAgents · registry.grantsFor
      const rows = await registry().listAgents(ownerId);
      return { agents: await Promise.all(rows.map(agentRow)) };
    },
  }),

  /** `{ slug, name?, description? }` — create an agent. Slug `[a-z0-9-]`,
   *  unique per owner. Holds no grants until grant_set. */
  agent_create: defineOp({
    schema: {
      description: "Create an agent. It holds no grants until grant_set runs.",
      fields: {
        slug: { kind: "slug", description: "The agent's slug, unique in this namespace." },
        ...AGENT_FIELDS,
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.createAgent · audit.record
      const slug = parsed.slug as string;
      // §2 (2026-09-03): `/agents/new` is the create form, so `new` can be no agent —
      // the same rule that keeps `new` and `connect` out of app slugs, spelled here
      // because admin must not import the pages that own the segment.
      if (slug === "new") throw invalid(`the slug "new" is reserved: /agents/new is a page`);
      const created = await domain(
        registry().createAgent({
          ownerId,
          slug,
          name: (parsed.name as string) ?? slug,
          description: parsed.description as string | undefined,
        }),
      );
      await summarise(ownerId, "agent_create", { slug });
      return { agent: await agentRow(created) };
    },
  }),

  /**
   * `{ slug, name?, description? }` — patch an agent's display fields. `slug` is
   * immutable: §22.4's whole reason for this op is that without it, correcting a
   * display-name typo is `RequiresReplace` in the provider, and the only replacement
   * path is `agent_delete` then `agent_create` — which cascades `deleteTokensForStatement`
   * and revokes every live token on the agent for a cosmetic edit. Same optional-field
   * semantics as app_update: an omitted field is left alone, and a call with neither
   * field set reaches registry.updateAgent's own no-column, no-write, unchanged-row
   * branch — a legal no-op, not a refusal.
   */
  agent_update: defineOp({
    schema: {
      description: "Update an agent's display fields. `slug` selects the agent and is immutable.",
      fields: { slug: { kind: "slug", description: "The agent to patch." }, ...AGENT_PATCH_FIELDS },
    },
    async run(ownerId, parsed) {
      // deps: registry.updateAgent · audit.record
      const slug = parsed.slug as string;
      const target = await agent(ownerId, slug);
      const patch: AgentPatch = {
        ...(parsed.name === undefined ? {} : { name: parsed.name as string }),
        ...(parsed.description === undefined ? {} : { description: parsed.description as string }),
      };
      const updated = await registry().updateAgent(target.id, patch);
      // The field NAMES, not their values — app_update's own audit shape.
      await summarise(ownerId, "agent_update", { slug, fields: Object.keys(patch) });
      return { agent: await agentRow(updated) };
    },
  }),

  /**
   * `{ slug }` — terminal delete: the agent row (grants cascade by FK) and the
   * agent's token rows go together in one D1 batch, so a racing request can never
   * authenticate against a half-deleted agent. Agents hold no sockets — the rows are
   * the whole cascade (the §15 ordering pin is satisfied vacuously).
   */
  agent_delete: defineOp({
    schema: {
      description: "Delete an agent, its grants, and its tokens. Terminal.",
      fields: { slug: { kind: "slug", description: "The agent's slug." } },
    },
    async run(ownerId, parsed) {
      // deps: registry.deleteAgentStatement · identity.countTokensFor · identity.deleteTokensForStatement · audit.record
      const { slug } = parsed as { slug: string };
      const target = await agent(ownerId, slug);
      const tokens = await countTokensFor(target.id);
      await db().batch([
        deleteTokensForStatement(target.id),
        registry().deleteAgentStatement(target.id),
      ]);
      await summarise(ownerId, "agent_delete", { slug, tokens });
      return { slug };
    },
  }),

  /**
   * `{ agent, app, roles }` — replace the FULL grant set for the pair: roles
   * absent from the list are revoked (§8). Each entry is a role name or an inline item
   * (`tool/<pattern>`, `prompt/<pattern>`, `resource/<uri-pattern>`), optionally suffixed
   * `:approval` — by SUFFIX, since a resource URI carries colons; the same
   * entry in both modes is a config error. Registry's role language validates: undeclared
   * roles warn for tunneled apps (the file may be ahead of first connect) and
   * hard-error for proxied ones (an inline item declares itself and is never undeclared);
   * `all` is grantable, never declarable. `pmcp` is
   * rejected — agents can never hold admin grants (§8).
   */
  grant_set: defineOp({
    schema: {
      description: "Replace the full grant set for one (agent, app) pair.",
      fields: {
        agent: { kind: "slug", description: "The agent's slug." },
        app: { kind: "slug", description: "The app's slug." },
        roles: {
          kind: "stringList",
          description:
            'Entries: a role name, or tool/<pattern>, prompt/<pattern>, resource/<uri-pattern>; each optionally suffixed ":approval".',
        },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.setGrants · audit.record
      // Aliased because `agent` and `app` are the two resolvers on the next lines.
      const {
        agent: agentSlug,
        app: appSlug,
        roles,
      } = parsed as { agent: string; app: string; roles: string[] };
      const holder = await agent(ownerId, agentSlug);
      const target = await app(ownerId, appSlug);
      const entries = grantEntries(roles);
      const warnings = await domain(registry().setGrants(holder.id, target.id, entries));
      await summarise(
        ownerId,
        "grant_set",
        { agent: agentSlug, app: appSlug, roles },
        appSlug,
      );
      return { agent: agentSlug, app: appSlug, roles, warnings };
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
   * `{ kind: 'agent' | 'app', slug, expires_in? }` → the plaintext token,
   * present ONLY in this result, once — never stored (SHA-256 at rest), never logged,
   * never readable again (§4, §8). The op declares an outputSchema with the key field
   * marked `writeOnly`, so §15's uniform body rule masks it wherever bodies are
   * recorded — the reply the CALLER sees is never redacted (§7), only persistence is.
   * Defaults by kind (§8): agent tokens 90 d
   * (overridable, including 'never'); app tokens no expiry (revoke-on-compromise).
   * `kind: 'app'` is rejected for proxied apps (nothing connects) and `pmcp` is
   * rejected like everywhere. Result also carries the row id and display prefix.
   */
  token_issue: defineOp({
    schema: {
      description: "Mint a credential. The plaintext key is shown once, here, and never again.",
      fields: {
        kind: {
          kind: "text",
          description: "agent (an agent's key) or app (a tunneled app's key).",
          values: ["agent", "app"],
        },
        slug: { kind: "slug", description: "The agent or app the key is bound to." },
        expires_in: {
          kind: "duration",
          description: "Seconds until expiry, or never. Defaults by kind: 90 days for an agent key, never for an app key.",
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
      // deps: registry.getApp · registry.getAgent · identity.issueToken · identity.tokenFor · audit.record
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
   * presents a dead credential. Revoking an app token whose connection is live
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
      // Only the socket THIS token opened (§8) — an app's other credentials are still
      // good, and the connection they hold is not this revocation's business.
      const tunnel =
        target.kind === "app"
          ? await evict(() => sever(target.refId, CLOSE_REVOKED, target.id))
          : undefined;
      await summarise(
        ownerId,
        "token_revoke",
        { tokenId: target.id, kind: target.kind, slug: target.refSlug, ...(tunnel === undefined ? {} : { tunnel }) },
        target.kind === "app" ? target.refSlug : undefined,
      );
      return { id: target.id };
    },
  }),

  /**
   * `{ expires_in? }` → a `pmcp_adm_` credential, present ONLY in this result, once —
   * the whole point of the shared `writeOnly`-marked-output masking rule (§8/§22.1):
   * this op joins token_issue as the second (and last) admin op whose output declares
   * one. Session principals only — an admin token cannot mint a successor — enforced by
   * adminOpsFor below, never here: op restrictions cannot live in a handler that sees
   * only `ownerId` (§22.1's own accounting of why). Expiry is fixed, never sliding:
   * defaults to 365 days (ADMIN_TOKEN_TTL_MS); `never` is honored like every other
   * expiring credential here.
   */
  admin_token_issue: defineOp({
    schema: {
      description: "Mint a hub-admin credential from a signed-in session. Shown once, here.",
      fields: {
        expires_in: {
          kind: "duration",
          description: "Seconds until expiry, or never. Defaults to 365 days — fixed, never sliding.",
          optional: true,
        },
      },
    },
    outputSchema: {
      description: "The minted admin credential.",
      fields: {
        id: { kind: "text", description: "The token row's id — what admin_token_revoke takes." },
        token: {
          kind: "text",
          description: "The plaintext key. Shown once; the hub stores only its SHA-256.",
          writeOnly: true,
        },
        prefix: { kind: "text", description: "The first characters, as admin_token_list displays them." },
        createdAt: { kind: "count", description: "Epoch ms." },
        expiresAt: { kind: "count", description: "Epoch ms, or null when it never expires.", nullable: true },
      },
    },
    async run(ownerId, parsed) {
      // deps: identity.issueAdminToken · audit.record
      const { expires_in } = parsed as { expires_in?: number | "never" };
      const issued = await issueAdminToken(ownerId, expires_in);
      // What was issued, never the key itself (§8) — no referent to name, unlike token_issue.
      await summarise(ownerId, "admin_token_issue", { tokenId: issued.id });
      return {
        id: issued.id,
        token: issued.token,
        prefix: issued.prefix,
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
      };
    },
  }),

  /**
   * List the namespace's admin tokens: display prefix, created, expiry, revocation, and
   * the coarse `last_used_at` — the same rotation-state shape token_list shows the
   * shared table's rows, minus the `kind`/referent fields an admin token has none of.
   */
  admin_token_list: defineOp({
    schema: { description: "List this namespace's admin tokens. Never plaintext.", fields: {} },
    async run(ownerId) {
      // deps: identity.listAdminTokens
      return { tokens: await listAdminTokens(ownerId) };
    },
  }),

  /**
   * `{ id }` — revoke an admin token; the credential is dead on its next resolve (§15).
   * No socket to sever, unlike token_revoke's app leg: an admin token opens none.
   */
  admin_token_revoke: defineOp({
    schema: {
      description: "Revoke one admin token. Immediate on every surface.",
      fields: { id: { kind: "text", description: "The token row's id, as admin_token_list reports it." } },
    },
    async run(ownerId, parsed) {
      // deps: identity.revokeAdminToken · audit.record
      const { id } = parsed as { id: string };
      if (!(await revokeAdminToken(ownerId, id))) throw absent("token");
      await summarise(ownerId, "admin_token_revoke", { tokenId: id });
      return { id };
    },
  }),

  /**
   * §19/§8: the OAuth clients connected to this namespace — client name and id, the
   * agent each is bound to, created/last-used, the two identity strings §19.5's consent
   * screen shows about the client (its registered redirect ORIGIN, and whether it
   * self-registered), and the revoked stamp: a revoked binding is REPORTED, not dropped,
   * because §13's Connected clients pane keeps its row and has no second read path.
   * Never a token, a client secret, or a JWT: a connection is a binding, and a binding
   * holds no credential (oauth.ts's `Connection` shape). Read-only, fronting
   * oauth.listConnections exactly as every other read here fronts its own module.
   */
  connection_list: defineOp({
    schema: { description: "List the OAuth clients connected to this namespace.", fields: {} },
    async run(ownerId) {
      // deps: oauth.listConnections
      return { connections: await listConnections(ownerId) };
    },
  }),

  /**
   * `{ id }` — revoke one OAuth connection by id (§19.6/§8): the `/oauth/connections`
   * Revoke button fronts this. oauth.revokeConnection sets `revoked_at` (immediate at the
   * door) and deletes the provider's `oauthConsent` row so a refresh cannot resurrect it;
   * this op adds its own `admin.connection_revoke` row (via `summarise`, like every other
   * mutating op) plus the domain event `oauth.revoked` beside it — oauth.ts writes no audit
   * row of its own (see its header), so both live here. An id naming no connection in this
   * namespace — nonexistent or another namespace's — is the one uniform refusal.
   */
  connection_revoke: defineOp({
    schema: {
      description: "Revoke one OAuth connection. Immediate at the door.",
      fields: { id: { kind: "text", description: "The connection's id, as connection_list reports it." } },
    },
    async run(ownerId, parsed) {
      // deps: oauth.revokeConnection · audit.record
      const { id } = parsed as { id: string };
      const revoked = await revokeConnection(ownerId, id);
      if (revoked === null) throw absent("connection");
      await summarise(ownerId, "connection_revoke", { connectionId: revoked.id, clientId: revoked.clientId });
      await record(db(), {
        ownerId,
        principal: formatPrincipal(await owner(ownerId)),
        event: "oauth.revoked",
        outcome: "ok",
        detail: { connectionId: revoked.id, clientId: revoked.clientId },
      });
      return { id: revoked.id };
    },
  }),

  /**
   * §23.3's settings read: `{}` → `{ settings: { defaultTimeoutMs, maxTimeoutMs } }` in
   * milliseconds, with the absent row answering the pinned `30_000/30_000` pair. Owner
   * scoped and read-only, so it writes no `admin.*` row — it fronts
   * `registry.hubExecutionSettings` exactly as every other read here fronts its module.
   */
  hub_settings_get: defineOp({
    schema: { description: "Read this namespace's hub execution timeout settings.", fields: {} },
    async run(ownerId) {
      // deps: registry.hubExecutionSettings
      return { settings: await registry().hubExecutionSettings(ownerId) };
    },
  }),

  /**
   * §23.3's settings write: both integers required, `1_000 <= default <= max <= 300_000`,
   * one atomic upsert, and the same read shape back. The advertised bounds are the checked
   * ones (render/coerce share this one declaration); the ORDERING is the cross-field rule
   * JSON Schema cannot state, so it lives in registry's `executionSettingViolations`, whose
   * field names are this op's. Settings are snapshotted at admission, so this governs new
   * executions and never extends a running one.
   */
  hub_settings_update: defineOp({
    schema: {
      description: "Set this namespace's hub execution timeout pair. Affects new executions only.",
      fields: {
        default_timeout_ms: {
          kind: "count",
          description: "Default execution wall clock, milliseconds — used when a program sends no timeout_ms.",
          minimum: HUB_MIN_TIMEOUT_MS,
          maximum: HUB_HARD_MAX_TIMEOUT_MS,
        },
        max_timeout_ms: {
          kind: "count",
          description: "Largest timeout_ms a program may request, milliseconds (at least default, at most the hard ceiling).",
          minimum: HUB_MIN_TIMEOUT_MS,
          maximum: HUB_HARD_MAX_TIMEOUT_MS,
        },
      },
    },
    async run(ownerId, parsed) {
      // deps: registry.updateHubExecutionSettings · audit.record
      const settings = await domain(
        registry().updateHubExecutionSettings(ownerId, {
          defaultTimeoutMs: parsed.default_timeout_ms as number,
          maxTimeoutMs: parsed.max_timeout_ms as number,
        }),
      );
      await summarise(ownerId, "hub_settings_update", {
        defaultTimeoutMs: settings.defaultTimeoutMs,
        maxTimeoutMs: settings.maxTimeoutMs,
      });
      return { settings };
    },
  }),

  /**
   * `{ principal?, app?, event?, tool?, session?, since?, until?, limit?, offset? }`
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
        principal: { kind: "text", description: "Exact principal string, e.g. agent:claude.", optional: true },
        app: { kind: "text", description: "Exact app slug.", optional: true },
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
 * (checked by the caller, uniformly), and a proxied app has nothing that connects.
 */
async function referentOf(ownerId: string, kind: TokenKind, slug: string): Promise<string> {
  if (kind === "agent") return (await agent(ownerId, slug)).id;
  const target = await app(ownerId, slug);
  if (target.kind !== "tunnel") {
    throw invalid("a proxied app has nothing that connects, so it takes no app token");
  }
  return target.id;
}

/**
 * Which admin ops a principal may reach — the ONE policy `adminBackend.call` and
 * `adminBackend.listTools` both consult (§22.1), because `adminBackend.call` receives
 * `ctx.principal` and would otherwise discard it: every `AdminOp.handler` sees only
 * `ownerId`, so op-level restriction cannot live in a handler. Consulted at both sites
 * rather than call alone, because listTools advertising an op the credential will then
 * be refused is an MCP capability contradiction, not merely an inconsistency.
 *
 * A `user` principal (a session) reaches every op. An `admin` principal (a `pmcp_adm_`
 * bearer) reaches every op except `approval_decide` — a machine credential approving its
 * own pending requests defeats the human gate it administers — and `admin_token_issue`,
 * because an admin token must never mint a successor. An `agent` principal never reaches
 * this surface at all (index.visibleOnScoped refuses it before the request arrives), so
 * its set is empty rather than a case this policy has to reason about.
 */
export function adminOpsFor(principal: Principal): ReadonlySet<string> {
  const names = Object.keys(ops);
  // A `switch` returning from every arm, not a chain of `if`s with a bare final `return`:
  // §22.1 asks for the exhaustiveness check because the FINAL arm is the dangerous one.
  // Written as a fall-through, a fourth `Principal` kind would inherit the admin arm and
  // silently receive every op but two — this function fails OPEN by default, so the
  // compiler has to be the thing that notices. With an annotated return type and no
  // `default`, adding a kind makes this a type error (TS2366) rather than a grant.
  switch (principal.kind) {
    case "agent":
      // index.visibleOnScoped refuses an agent before the request arrives, so this is
      // unreachable rather than a policy — empty is the fail-closed spelling of that.
      return new Set();
    case "user":
      return new Set(names);
    case "admin":
      return new Set(names.filter((name) => name !== "approval_decide" && name !== "admin_token_issue"));
  }
}

/**
 * The builtin `pmcp` app — the third AppBackend beside tunnel and upstream, so
 * the gateway pipeline (auth → filter → archived → approvals → dispatch) has no admin
 * special case. listTools renders every op adminOpsFor(ctx.principal) admits as a Tool
 * (name = ops key, inputSchema from its schema, outputSchema where declared); call
 * dispatches to ops[tool].handler with `app.ownerId`, refusing the same way for an op
 * that does not exist and one adminOpsFor refuses (§22.1/§7: the two must be
 * indistinguishable, or a probe could tell them apart) and wraps a
 * successful result — HubError escapes to the gateway, the only place errors become
 * JSON-RPC. sensitivePaths answers `{ args: [], results: [...] }` for known ops — no
 * admin tool takes a sensitive argument, and the only sensitive results are
 * token_issue's and admin_token_issue's `writeOnly`-marked keys, masked by §15's uniform
 * body rule (no pmcp-specific logging rule exists) — and
 * null for unknown names. Only `app.ownerId` is consulted for dispatch — the pmcp App
 * value is virtual, no row exists for it (§8); `ctx.principal` is consulted for
 * adminOpsFor alone.
 */
export const adminBackend: AppBackend = {
  async listTools(app, ctx) {
    // deps: ops · adminOpsFor · jsonSchema (schema → inputSchema rendering)
    const allowed = adminOpsFor(ctx.principal);
    return Object.entries(ops)
      .filter(([name]) => allowed.has(name))
      .map(([name, op]) => {
        const schema = op.schema as OpSchema;
        const tool: Tool = { name, description: schema.description, inputSchema: jsonSchema(schema) };
        if (op.outputSchema !== undefined) tool.outputSchema = jsonSchema(op.outputSchema as OpSchema);
        return tool;
      });
  },
  // §20.6: the pmcp builtin is tools only — its scoped endpoint answers these three empty
  // rather than -32601, because an empty family is a different fact from an unimplemented
  // method (§20.2), and declares neither capability (gateway.capabilitiesFor's own
  // special case for PMCP_SLUG, so this module states no capability list of its own).
  async listPrompts(app, ctx) {
    return [];
  },
  async listResources(app, ctx) {
    return [];
  },
  async listResourceTemplates(app, ctx) {
    return [];
  },
  async call(app, msg, ctx) {
    // deps: ops · adminOpsFor · errors.notPermitted · errors.methodNotFound
    //
    // The gateway routes THREE consumer methods through one `AppBackend.call` —
    // `tools/call`, `prompts/get` and `resources/read` — each arriving with the addressed
    // item in `params.name`. A backend that reads `params.name` without reading `method`
    // therefore answers all three identically, and this one serves only the first: §20.6
    // makes the builtin tools-only, listing prompts and resources as empty families.
    //
    // Unguarded, `prompts/get` with `name: "agent_list"` EXECUTED the admin op, and the
    // gateway then wrote the row as a prompt fetch — whose audit shape carries no
    // arguments and consults no `sensitivePaths`, unlike the tool path. Authorization was
    // never the hole (`adminOpsFor` still gated it, and only `user`/`admin` principals
    // reach this app at all); §15's argument record was, so a mutation could be driven
    // through a method whose audit row cannot describe it.
    if (msg.method !== "tools/call") throw methodNotFound();
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    const op = opNamed(name);
    // The same code and the same words the gateway answers an ungranted tool with: an
    // unknown admin tool, and one adminOpsFor(ctx.principal) refuses, must not be
    // distinguishable from each other (§7/§22.1) — which is why this reaches for the
    // shared factory rather than spelling any of the three refusals again.
    if (op === undefined || !adminOpsFor(ctx.principal).has(name)) throw notPermitted();
    const value = await op.handler(app.ownerId, msg.params?.arguments);
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      // Both carriers of the 2026-07-28 result: the structured half is what §15's masking
      // rule applies to, and the text half is what a client without a schema reads.
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    };
  },
  async sensitivePaths(app, tool) {
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
/**
 * §19.3's one spelling of a namespace's OAuth resource identifier — `https://<origin>/<user>/mcp`,
 * scheme+host from PUBLIC_ORIGIN, path included. provisionUser writes it, deleteUser removes it,
 * and 0005's back-fill embeds the identical string (as a literal, a .sql migration having no way
 * to read the var). The PRM (§19.2) and the door's `aud` check (§19.6) name the same value; one
 * function here is what keeps them one string with one spelling.
 */
function oauthResourceIdentifier(username: string): string {
  return `${env.PUBLIC_ORIGIN}/${username}/mcp`;
}

export async function provisionUser(username: string): Promise<{ userId: string }> {
  // deps: better-auth (user create) · crypto · audit.record · D1 `oauthResource`
  if (!USERNAME_CHARSET.test(username)) {
    throw new Error(`username must match [a-z0-9-]: "${username}"`);
  }
  const userId = crypto.randomUUID();
  const now = Date.now();
  // ponytail: the `user` row is written here rather than through better-auth. Upgrade path:
  // replace this INSERT with better-auth's user-create call — which mints the §12 password
  // AND the `agent` row behind it — and widen the return to carry it back once.
  await db()
    .prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "username", "displayUsername")
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(userId, username, `${username}@users.local`, now, now, username, username)
    .run();
  // §19.3: one oauthProvider `oauthResource` row per namespace, identifier
  // https://<origin>/<user>/mcp — the SAME string the PRM names as `resource`, the door
  // checks as `aud`, and 0005 back-fills for users that predate §19. Written on the
  // provisioning path (not lazily on first request) because its failure mode is silent: a
  // brand-new user with no row can never complete an authorization, and MCP clients always
  // send `resource` (the provider refuses `invalid_target` before consent otherwise). The
  // row's minimal shape — id/identifier/name, every policy column null — is deliberate:
  // null `allowedScopes`/`disabled` inherit the plugin defaults at issuance.
  await db()
    .prepare(`INSERT INTO "oauthResource" ("id", "identifier", "name") VALUES (?, ?, ?)`)
    .bind(crypto.randomUUID(), oauthResourceIdentifier(username), username)
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
 * Full namespace teardown (§15): every tunneled app gets the app_delete cascade
 * — D1 batch first, THEN sever (4001) + DO wipe — and only after all apps are down
 * does the user row go, cascading agents, grants, sessions, approvals, and the rest.
 * DOs are addressed by opaque app.id, so even a missed wipe can never be rebound by
 * recreating the username. Deleting a user that does not exist is a no-op, not an error
 * — the postcondition is absence. Audited as principal 'bootstrap'.
 */
export async function deleteUser(username: string): Promise<void> {
  // deps: ops.app_delete · better-auth (user delete) · D1 `user` · audit.record
  const user = await db()
    .prepare(`SELECT "id" FROM "user" WHERE "username" = ?`)
    .bind(username)
    .first<{ id: string }>();
  if (!user) return; // the postcondition is absence, so an absent user is already met
  const owner: Principal = { kind: "user", userId: user.id, username };
  // Apps first, one at a time through the op that owns the ordering (D1 batch, THEN
  // sever + wipe) — the `user` row's own cascade cannot reach tokens or DOs.
  const apps = await new Registry(db()).listAppsFor(owner);
  for (const app of apps) {
    await ops.app_delete.handler(user.id, { slug: app.slug });
  }
  // §19.3: the namespace's `oauthResource` row carries no FK to `user` (better-auth owns the
  // table and generates no owner column), so the user-row cascade below cannot reach it. This
  // is that teardown, by the identifier provisionUser wrote — the other half of the pinned
  // pair, whose failure mode (a stranded resource row a recreated username would inherit) is
  // as silent as a missing write. oauth_binding rows DO cascade (owner_id FK, §19.4), so they
  // are gone with the user row and need no line here.
  await db()
    .prepare(`DELETE FROM "oauthResource" WHERE "identifier" = ?`)
    .bind(oauthResourceIdentifier(username))
    .run();
  await db().prepare(`DELETE FROM "user" WHERE "id" = ?`).bind(user.id).run();
  await record(db(), {
    ownerId: user.id,
    principal: "bootstrap",
    event: "bootstrap.user_deleted",
    outcome: "ok",
    detail: { username, apps: apps.length },
  });
}
