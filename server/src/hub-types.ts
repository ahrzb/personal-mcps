// hub-types.ts — §23.6/§23.7's Node-clean pure contract: the hub-local TypeScript NAME
// system and the declaration renderer. One home for three things:
//
//   1. Alias grammar and reservations. `aliasViolations` judges the wire/owner
//      `typescriptAliases` shape; `aliasNameViolations` judges one name against §23.6's
//      rules (ASCII `[A-Za-z_$][A-Za-z0-9_$]*`, 1–128 bytes, no keywords, no
//      Object.prototype/Promise-sensitive name including `then`, and the namespace's fixed
//      members: root `hub`/`pmcp` for a service, `resources` inside every service).
//      `generatedAlias` derives the deterministic lower-camel candidate and prefixes `_`
//      for a leading digit or any name that family must not claim (keywords, the
//      Object.prototype/Promise-sensitive names including `then`, root `hub`/`pmcp` for a
//      service, `resources` inside a service); an explicit alias may never BE one of those
//      names, so a generated candidate is renamed around them rather than omitted.
//   2. `planAliasReservations` — the one pure mapping computation over
//      `typescript_name_reservation` rows. It resolves owner > sdk > generated precedence,
//      groups simultaneous candidates, protects tombstones against newcomers, reactivates a
//      returning member's own single reservation, supersedes a deliberately changed alias,
//      retires members a successful family fetch no longer lists, and reports every
//      omission as structured facts plus bounded messages. It never touches D1: the
//      registry reads and writes the rows this returns.
//   3. `renderSchema` and the declaration assembly. The renderer walks only §23.7's
//      allowlist, deep-copies JSON after byte/node/depth checks, and renders every
//      invalid/external/unsupported/unsafe construct as `unknown` plus a diagnostic rather
//      than a narrower type. Generated declarations, the runtime proxy and `search_types`
//      consume the same immutable map — nothing here ever reverses a TypeScript name back
//      into a canonical one.
//
// Two laws a caller must be able to rely on. (a) Canonical identities always survive: no
// function here rewrites, prefixes or truncates a canonical service/tool/URI — the
// upstream name is the wire name, forever. (b) Nothing is guessed: a name that is taken,
// ambiguous or underivable is omitted and named in a diagnostic; this module never
// suffixes, sorts-to-pick, or silently renames an established assignment.
//
// ALIAS NUMBERING: a rendered schema's local `$ref` aliases are numbered from the base the
// caller passes, and a declaration file that concatenates several rendered entries — the
// program declaration and a service's file — must be fed entries numbered from ONE running
// offset in canonical order (input before output), which is what hub-catalog's builder
// does. Two entries both starting at `T0` would emit two declarations of one name.
//
// PROJECT: `unit` and `worker` — plain data, strings and numbers. Its only imports are
// `./limits` and `./hub-contract`; neither reaches `cloudflare:workers`, gateway, admin,
// tunnel, or Sandbox, so registry/admin/tunnel may import it and the `unit` pool stays
// plain Node. Every export is total: bad input yields `unknown`/an omission/a violation
// string, never a throw.
//
// NOT HERE: the D1 reads/writes (registry owns `typescript_name_reservation` and the owner
// settings row), the caller-visible catalog snapshot and ranked search (hub-catalog.ts),
// and the wire descriptors themselves (hub-contract.ts). Declaration read routing — the
// one-decode/byte-identical-re-encode rule for template placeholders (§23.2) — belongs to
// the resource reader, which re-derives every URI through `catalogDeclarationUri` rather
// than parsing one back apart.

import { HUB_TOOLS } from "./hub-contract";
import type { HubToolName } from "./hub-contract";
import {
  HUB_DECLARATION_MAX_BYTES,
  HUB_SCHEMA_MAX_BYTES,
  HUB_SCHEMA_MAX_DEPTH,
  HUB_SCHEMA_MAX_NODES,
} from "./limits";

/**
 * §23.1/§23.6 — the reserved virtual slug: `hub` sits beside registry's `PMCP_SLUG`
 * (`pmcp`), never inside it. It is not an `app` row and every app-creation path rejects it;
 * the two spellings are separate constants because a rename of either must not silently
 * follow the other.
 */
export const HUB_SLUG = "hub";

/** §23.6 — the alias byte bound, in UTF-8 bytes. Explicit identifiers are bounded by it,
 *  and a generated candidate that exceeds it is omitted rather than emitted. */
export const TYPESCRIPT_ALIAS_MAX_BYTES = 128;

/** §23.2 — the program-surface declaration resource. Also the `search_types` match URI for
 *  a program-surface hub tool: hub tools have no per-tool template, so their direct
 *  declaration is the fixed file that declares them. */
export const HUB_PROGRAM_DECLARATION_URI = "pmcp://hub/types/program.d.ts";

/** §23.2 — the client-surface declaration resource; `client.d.ts` is a declaration surface
 *  only and is never loaded into the program checker (which is what keeps `mcp.hub.execute`
 *  out of reach of submitted code). */
export const HUB_CLIENT_DECLARATION_URI = "pmcp://hub/types/client.d.ts";

/** §23.2/§23.7 — which of the two declaration contexts a signature or match belongs to:
 *  `program` is the in-Sandbox surface (no `mcp.hub.execute`), `client` is the external
 *  ergonomic facade (both hub tools). */
export type CatalogSurface = "program" | "client";

/** §23.6 — the two namespace families a reservation can belong to: an app's service name
 *  (owner-scoped) or one of its canonical tool names (app-scoped). */
export type AliasFamily = "service" | "tool";

/** §23.6 — where a reservation's TypeScript name came from. Precedence is owner > sdk >
 *  generated; `generated` is the only source a later discovery may supersede freely. */
export type AliasSource = "owner" | "sdk" | "generated";

/**
 * §23.6 — the alias configuration shape, identical across the wire (`typescriptAliases` on
 * `hub/register`), the owner admin field (`typescript_aliases`) and app reads
 * (`typescriptAliases`). `service` aliases the app's namespace root; `tools` keys are
 * canonical tool names and values are hub-local aliases. An unconfigured member is simply
 * absent here — omission never clears an established assignment.
 */
export type TypescriptAliases = {
  /** The app's TypeScript service name, or absent to keep whatever is established. */
  readonly service?: string;
  /** Canonical tool name → TypeScript tool name; keys are upstream names and are never
   *  rewritten. */
  readonly tools?: Readonly<Record<string, string>>;
};

/** §23.6 — one canonical member's identity: the immutable app id plus the canonical name.
 *  The app id is what makes a reservation survive an app's scoped slug being deleted and
 *  recreated; the canonical name is the only name the upstream ever sees. */
export type AliasIdentity = {
  /** Immutable `app.id`; tool reservations are scoped to it, and a bridge operation refuses
   *  when a slug now resolves to a different id (§23.6). */
  readonly appId: string;
  /** Which namespace the member occupies. */
  readonly family: AliasFamily;
  /** Canonical slug (service) or canonical tool name, exactly as served upstream. */
  readonly canonicalName: string;
};

/**
 * §23.6 — one `typescript_name_reservation` row, as the planner reads and produces it.
 * `active` distinguishes a live assignment from a tombstone; a tombstone keeps its name
 * reserved in its family's collision domain but publishes no callable path.
 */
export type AliasReservation = AliasIdentity & {
  /** The reserved TypeScript name; a validated ASCII identifier. */
  readonly typescriptName: string;
  /** Which lane produced this name. */
  readonly source: AliasSource;
  /** True while the member is present and this is its current name. */
  readonly active: boolean;
};

/** §23.5/§23.6 — one service's canonical members for a planning pass. */
export type AliasServiceMembers = {
  /** Immutable app id of the service. */
  readonly appId: string;
  /** Canonical slug, exactly as the scoped endpoint serves it. */
  readonly service: string;
  /** Canonical tool names from the UNFILTERED fetched family, or `null` when that family's
   *  fetch failed — `null` disables disappearance retirement for this app, because an
   *  empty list and an unreachable family are not the same fact. */
  readonly tools: readonly string[] | null;
};

/** §23.6 — the two alias lanes for one app: `configured` is the owner's persisted
 *  configuration (authoritative), `hints` is what the SDK sent with `hub/register`. */
export type AliasLaneInput = {
  /** Immutable app id the lanes belong to. */
  readonly appId: string;
  /** Owner configuration; `null` means the owner configured nothing for this app. */
  readonly configured: TypescriptAliases | null;
  /** SDK registration hints; `null` means the transport sent none. */
  readonly hints: TypescriptAliases | null;
};

/** §23.6 — why a member has no TypeScript name (or is not using the one it asked for). */
export type AliasDiagnosticReason =
  /** A configured/hinted alias is not a usable identifier; it was ignored. */
  | "invalid"
  /** The canonical name has no ASCII-alphanumeric segment to derive a name from. */
  | "no_segment"
  /** The derived name exceeds `TYPESCRIPT_ALIAS_MAX_BYTES` (the `_` prefix counts). */
  | "too_long"
  /** The wanted name is held by an established (active or tombstoned) reservation. */
  | "established"
  /** Two or more members appearing together derived the same free name; all were omitted. */
  | "simultaneous"
  /** The member's own rows disagree (a superseded alias plus a later one); nothing is
   *  revived without an explicit alias. */
  | "ambiguous";

/**
 * §23.6 — one bounded, self-scoped mapping diagnostic: it names the member's own canonical
 * name and the contested TypeScript name, never another member. Both are printable-ASCII
 * escaped and bounded, so a diagnostic is safe to publish wherever the member itself is
 * visible; contender facts live in `AliasConflict` and are for surfaces allowed to see
 * them.
 */
export type AliasDiagnostic = {
  /** Namespace the member belongs to. */
  readonly family: AliasFamily;
  /** The omitted/misconfigured member's canonical name. */
  readonly canonicalName: string;
  /** The TypeScript name the member wanted, or `null` when none was derivable. */
  readonly typescriptName: string | null;
  /** Which rule produced this diagnostic. */
  readonly reason: AliasDiagnosticReason;
};

/**
 * §23.6 — a contested TypeScript name as structured facts. `established` is the reservation
 * that already holds the name (null when the name was free but several members derived it
 * in the same pass); `contenders` are the canonical identities that could not be assigned
 * it. Owner-facing surfaces render this through `aliasConflictMessage`; caller-visible
 * surfaces must first drop any contender the caller cannot see.
 */
export type AliasConflict = {
  /** Namespace the contested name lives in. */
  readonly family: AliasFamily;
  /** The contested TypeScript name. */
  readonly typescriptName: string;
  /** The reservation that already holds the name, when one exists. */
  readonly established: AliasIdentity | null;
  /** Every identity that wanted the name in this pass. */
  readonly contenders: readonly AliasIdentity[];
};

/**
 * §23.6 — one tool's resolved TypeScript name, `null` when the member was omitted. A
 * resolution only ever describes an ACTIVE assignment: retired rows are what the caller
 * passed in `existing` (and what this plan's `retire` returns), never a resolved name.
 */
export type AliasResolvedMember = {
  /** Canonical tool name (upstream identity, never an alias). */
  readonly canonicalName: string;
  /** Resolved TypeScript name, or `null` when the member is omitted. */
  readonly typescriptName: string | null;
  /** Which lane the name came from; `null` when omitted. */
  readonly source: AliasSource | null;
};

/** §23.6 — one service's resolved names. */
export type AliasResolvedService = {
  /** Immutable app id. */
  readonly appId: string;
  /** Canonical slug. */
  readonly service: string;
  /** Resolved TypeScript service name, or `null` when the service was omitted. */
  readonly typescriptName: string | null;
  /** Which lane the service name came from; `null` when omitted. */
  readonly source: AliasSource | null;
  /** Every canonical tool member considered, in canonical order, omissions included. */
  readonly tools: readonly AliasResolvedMember[];
};

/**
 * §23.6 — one planning pass. `lane` selects the write semantics: `"owner"` is an app
 * create/update carrying owner configuration (a collision refuses the whole write, and the
 * caller must apply nothing), `"sdk"` is registration/discovery (a collision omits the
 * member and diagnoses it, never refusing and never disconnecting a healthy tunnel).
 */
export type AliasPlanRequest = {
  /** Services whose canonical families were fetched, in any order — the planner orders
   *  them. A service omitted here keeps every reservation it has. */
  readonly services: readonly AliasServiceMembers[];
  /** Every reservation the caller can see in both collision domains: owner-wide service
   *  rows (any app id) plus the tool rows of the apps in `services`. Tombstones included. */
  readonly existing: readonly AliasReservation[];
  /** Alias lanes per app. Apps absent here resolve from reservations/generation alone. */
  readonly aliases: readonly AliasLaneInput[];
  /** Write semantics; see the type description. */
  readonly lane: "owner" | "sdk";
};

/**
 * §23.6 — the outcome of one planning pass. `activate` rows are upserted with `active:
 * true` and `retire` rows with `active: false`; both are safe to apply as one D1 batch, and
 * the unique indexes arbitrate against a concurrent writer that re-reads and calls the
 * planner again (a second call over the committed rows resolves identically, so a retry
 * converges instead of oscillating).
 */
export type AliasPlan = {
  /** Resolved names per service, in canonical order. Empty when `refusals` is non-empty. */
  readonly services: readonly AliasResolvedService[];
  /** Reservations to write with `active: true`. Empty when `refusals` is non-empty. */
  readonly activate: readonly AliasReservation[];
  /** Reservations to write with `active: false` (superseded or disappeared members).
   *  Empty when `refusals` is non-empty. */
  readonly retire: readonly AliasReservation[];
  /** Bounded, self-scoped diagnostics, ordered by canonical service then member. */
  readonly diagnostics: readonly AliasDiagnostic[];
  /** Structured contender facts for every collision, in the same order as `diagnostics`. */
  readonly conflicts: readonly AliasConflict[];
  /** Owner-lane collisions, bounded and owner-visible (they name contenders). Non-empty
   *  means the whole write is refused atomically: nothing in this plan may be applied. */
  readonly refusals: readonly string[];
};

// ── alias grammar (§23.6) ─────────────────────────────────────────────────────────────

/** §23.6 — root members the hub owns: no real app candidate or alias may claim them. The
 *  `pmcp` spelling mirrors registry.PMCP_SLUG; it is repeated rather than imported so this
 *  module stays independent of the registry (which imports it back). */
const ROOT_MEMBERS: Readonly<Record<string, true>> = { hub: true, pmcp: true };

/** §23.6 — the fixed member of every service namespace: a tool may never be named
 *  `resources`, because that name is the structured resource API's. */
const SERVICE_MEMBERS: Readonly<Record<string, true>> = { resources: true };

/** §23.6 — ECMAScript keywords and reserved words. A TypeScript name is a property name,
 *  and property names may be keywords, but §23.6 excludes them outright so a name can never
 *  depend on its syntactic position. */
const KEYWORDS: Readonly<Record<string, true>> = {
  await: true, break: true, case: true, catch: true, class: true, const: true, continue: true,
  debugger: true, default: true, delete: true, do: true, else: true, enum: true, export: true,
  extends: true, false: true, finally: true, for: true, function: true, if: true,
  implements: true, import: true, in: true, instanceof: true, interface: true, let: true,
  new: true, null: true, package: true, private: true, protected: true, public: true,
  return: true, static: true, super: true, switch: true, this: true, throw: true, true: true,
  try: true, typeof: true, var: true, void: true, while: true, with: true, yield: true,
};

/** §23.6 — names that are legal identifiers but unsafe as namespace members: the
 *  Object.prototype surface (an inherited member would shadow or be shadowed), `__proto__`
 *  (assignment semantics in object literals), and the Promise protocol names including
 *  `then` (a namespace object with a `then` member IS a thenable, so any `await` on it
 *  would call user code). */
const SENSITIVE_NAMES = new Set([
  "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  "toLocaleString", "toString", "valueOf", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "__proto__", "then", "catch", "finally",
]);

/** §23.6's grammar, spelled as a rejection scan rather than an anchored regex: `$` in a
 *  JavaScript regex also matches before a trailing newline, which would admit `"a\n"`. */
function isAliasGrammar(alias: string): boolean {
  if (alias.length === 0 || alias.length > TYPESCRIPT_ALIAS_MAX_BYTES) return false;
  if (!/[A-Za-z_$]/.test(alias[0])) return false;
  return !/[^A-Za-z0-9_$]/.test(alias);
}

/**
 * A name echoed into a violation, diagnostic or banner: printable ASCII only and bounded,
 * so a hostile canonical name or alias cannot smuggle control characters into a refusal, a
 * record or a log line.
 */
function echo(name: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, "?");
  return clean.length <= 64 ? clean : `${clean.slice(0, 61)}...`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * §23.6 — why one explicit alias is not usable, as a bounded list (empty = legal). `family`
 * selects the fixed-member exclusion: root `hub`/`pmcp` for a service name, `resources`
 * inside a service for a tool name. Pure and total; callers turn a non-empty answer into
 * the existing payload-free `-32602`.
 */
export function aliasNameViolations(alias: string, family: AliasFamily): string[] {
  if (!isAliasGrammar(alias)) {
    return [
      `alias "${echo(alias)}" must match [A-Za-z_$][A-Za-z0-9_$]* within 1-${TYPESCRIPT_ALIAS_MAX_BYTES} bytes`,
    ];
  }
  if (KEYWORDS[alias] === true) return [`alias "${alias}" is a JavaScript keyword`];
  if (SENSITIVE_NAMES.has(alias)) {
    return [`alias "${alias}" is object-prototype/thenable-sensitive and reserved`];
  }
  if (family === "service" && ROOT_MEMBERS[alias] === true) {
    return [`alias "${alias}" is owned by the hub namespace`];
  }
  if (family === "tool" && SERVICE_MEMBERS[alias] === true) {
    return [`alias "${alias}" is a fixed member of every service namespace`];
  }
  return [];
}

/**
 * §23.6 — validates the whole `typescriptAliases` shape from an untrusted wire or admin
 * value. `undefined` is the only legal absence (the member was not sent at all, meaning "no
 * aliases"); `null` is a malformed object like any other non-object, because a transport
 * that collapsed an explicit null into omission would let a client clear configuration by
 * sending the wrong value. An unknown key or a non-string value is malformed syntax too, and
 * every present name is judged by `aliasNameViolations` in its own family. Returns bounded
 * violations with the exact key path prefixed (`typescriptAliases.tools["<canonical>"]`),
 * empty when valid.
 */
export function aliasViolations(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["typescriptAliases must be an object"];
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "service" && key !== "tools") {
      violations.push(`typescriptAliases declares an unknown key "${echo(key)}"`);
    }
  }
  const service = value["service"];
  if (service !== undefined) {
    if (typeof service !== "string") {
      violations.push("typescriptAliases.service must be a string");
    } else {
      violations.push(
        ...aliasNameViolations(service, "service").map((message) => `typescriptAliases.service: ${message}`),
      );
    }
  }
  const tools = value["tools"];
  if (tools !== undefined) {
    if (!isJsonObject(tools)) {
      violations.push("typescriptAliases.tools must be an object of canonicalName -> alias");
    } else {
      for (const [canonical, alias] of Object.entries(tools)) {
        if (canonical.length === 0) {
          violations.push("typescriptAliases.tools declares an empty canonical name");
        }
        if (typeof alias !== "string") {
          violations.push(`typescriptAliases.tools["${echo(canonical)}"] must be a string`);
        } else {
          violations.push(
            ...aliasNameViolations(alias, "tool").map(
              (message) => `typescriptAliases.tools["${echo(canonical)}"]: ${message}`,
            ),
          );
        }
      }
    }
  }
  return violations;
}

/**
 * §23.6 step 3's reserved/sensitive set, family-aware: JavaScript keywords and
 * prototype/Promise-sensitive names for every name, the hub's root members (`hub`, `pmcp`)
 * for a service, and the structured resource API's fixed member (`resources`) for a tool.
 * Explicit aliases may never BE these names (`aliasNameViolations`); a generated candidate
 * is PREFIXED with `_` instead, which is why generation never claims one.
 */
function reservedName(name: string, family: AliasFamily): boolean {
  if (KEYWORDS[name] === true || SENSITIVE_NAMES.has(name)) return true;
  return family === "service" ? ROOT_MEMBERS[name] === true : SERVICE_MEMBERS[name] === true;
}

/**
 * §23.6 — the deterministic generated candidate for a canonical name: split on runs of
 * non-alphanumerics, lower-camel the segments (lowercase the first ASCII letter of the
 * first segment, uppercase the first ASCII letter of each later one, preserving the rest),
 * prefix `_` for a leading digit or any reserved/sensitive name for that family, and return
 * `null` when no ASCII-alphanumeric segment exists — the caller then omits the member with a
 * `no_segment` diagnostic. Grammar only: the result may still exceed the byte bound, and the
 * planner omits that with its own `too_long` diagnostic rather than conflating it with "no
 * derivable name". The `_` prefix is applied BEFORE the length check, because it is part of
 * the candidate. The virtual `pmcp` service is protocol infrastructure whose TypeScript
 * name is fixed: the catalog collector adds it to the snapshot with `pmcp` directly, never
 * through generation — generation prefixes a root member to `_pmcp`, and `mcp.pmcp` is the
 * member the credential's snapshot admits operations under.
 */
export function generatedAlias(canonicalName: string, family: AliasFamily): string | null {
  const segments = canonicalName.split(/[^A-Za-z0-9]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const [first, ...rest] = segments;
  let name = first[0].toLowerCase() + first.slice(1) + rest.map((segment) => segment[0].toUpperCase() + segment.slice(1)).join("");
  if (/^[0-9]/.test(name) || reservedName(name, family)) name = `_${name}`;
  return name;
}

// ── the reservation planner (§23.6) ───────────────────────────────────────────────────

/** The collision domain of a name: one per owner for services, one per app for tools. Two
 *  rows in the same domain may never share a `typescriptName`, active or tombstoned. */
function rowKey(row: AliasReservation): string {
  return `${row.appId}\u0000${row.family}\u0000${row.canonicalName}\u0000${row.typescriptName}`;
}

function identityOf(row: AliasReservation): AliasIdentity {
  return { appId: row.appId, family: row.family, canonicalName: row.canonicalName };
}

function sameIdentity(left: AliasIdentity, right: AliasIdentity): boolean {
  return left.appId === right.appId && left.family === right.family && left.canonicalName === right.canonicalName;
}

/** §23.6's precedence as one comparison: owner outranks sdk, which outranks generated. Used
 *  wherever two lanes want the same name, so a re-confirmation never downgrades a row. */
function strongerSource(left: AliasSource, right: AliasSource): AliasSource {
  const rank: Readonly<Record<AliasSource, number>> = { owner: 0, sdk: 1, generated: 2 };
  return rank[left] <= rank[right] ? left : right;
}

/** §23.6 — the configured alias for one member, owner lane first. */
function intendedAlias(
  lane: AliasLaneInput | undefined,
  identity: AliasIdentity,
): { readonly alias: string; readonly source: "owner" | "sdk" } | null {
  const fromOwner =
    identity.family === "service" ? lane?.configured?.service : lane?.configured?.tools?.[identity.canonicalName];
  if (typeof fromOwner === "string") return { alias: fromOwner, source: "owner" };
  const fromSdk = identity.family === "service" ? lane?.hints?.service : lane?.hints?.tools?.[identity.canonicalName];
  if (typeof fromSdk === "string") return { alias: fromSdk, source: "sdk" };
  return null;
}

/**
 * §23.6 — one planning pass over reservations: the pure half of every alias write and
 * catalog discovery. Reads nothing, writes nothing; returns the rows to activate/retire,
 * the resolved names, and every omission as a diagnostic. See `AliasPlanRequest` for the
 * two lanes and the meaning of `existing`.
 *
 * The resolution order per member is: owner configuration, then SDK hints, then the
 * member's own single tombstone (a returning member keeps its API), then a generated
 * candidate. Established reservations — active or tombstoned — always outrank a newcomer.
 */
export function planAliasReservations(request: AliasPlanRequest): AliasPlan {
  const serviceClaims = new Map<string, AliasReservation>();
  const toolClaims = new Map<string, AliasReservation>();
  for (const row of request.existing) {
    const claims = row.family === "service" ? serviceClaims : toolClaims;
    const key = row.family === "service" ? row.typescriptName : `${row.appId}\u0000${row.typescriptName}`;
    if (!claims.has(key)) claims.set(key, row);
  }

  const diagnostics: AliasDiagnostic[] = [];
  const conflicts: AliasConflict[] = [];
  const refusals: string[] = [];
  const activate: AliasReservation[] = [];
  const retire = new Map<string, AliasReservation>();
  const resolved = new Map<string, { typescriptName: string | null; source: AliasSource | null }>();

  const identityKey = (identity: AliasIdentity): string =>
    `${identity.appId}\u0000${identity.family}\u0000${identity.canonicalName}`;

  const claimedBy = (identity: AliasIdentity, name: string): AliasReservation | undefined =>
    identity.family === "service" ? serviceClaims.get(name) : toolClaims.get(`${identity.appId}\u0000${name}`);

  const rowsOf = (identity: AliasIdentity): AliasReservation[] =>
    request.existing.filter((row) => sameIdentity(identityOf(row), identity));

  /** Retires an active row once, keyed by its full identity so two paths cannot emit it
   *  twice. */
  const retireRow = (row: AliasReservation): void => {
    if (row.active) retire.set(rowKey(row), { ...row, active: false });
  };

  /** Records an omission and its contender facts. */
  const omit = (
    identity: AliasIdentity,
    reason: AliasDiagnosticReason,
    typescriptName: string | null,
    conflict?: AliasConflict,
  ): void => {
    diagnostics.push({ family: identity.family, canonicalName: identity.canonicalName, typescriptName, reason });
    if (conflict !== undefined) conflicts.push(conflict);
    resolved.set(identityKey(identity), { typescriptName: null, source: null });
  };

  /** Activates `name` for `identity`, superseding any other active name it held. */
  const assign = (identity: AliasIdentity, name: string, source: AliasSource): void => {
    const own = rowsOf(identity);
    const existing = own.find((candidate) => candidate.typescriptName === name);
    // A lane may re-assert a name another lane already owns; the stronger source stands,
    // so discovery never downgrades an owner configuration it merely re-confirms.
    const kept = existing === undefined ? source : strongerSource(existing.source, source);
    const row: AliasReservation =
      existing === undefined
        ? { ...identity, typescriptName: name, source: kept, active: true }
        : { ...existing, source: kept, active: true };
    activate.push(row);
    // The claim is live for the REST of this pass: a second member wanting the same name
    // must collide here — owner lane refuses, sdk lane omits — rather than at the D1
    // unique index after both rows were written.
    if (row.family === "service") serviceClaims.set(row.typescriptName, row);
    else toolClaims.set(`${row.appId}\u0000${row.typescriptName}`, row);
    for (const other of own) {
      if (other.active && other.typescriptName !== name) retireRow(other);
    }
    resolved.set(identityKey(identity), { typescriptName: name, source: kept });
  };

  /** The member's own one-row reactivation: only a single earlier assignment is
   *  unambiguous; more than one means a supersede happened, and nothing is revived. */
  const reactivate = (identity: AliasIdentity, rows: readonly AliasReservation[]): boolean => {
    const [only] = rows;
    if (rows.length !== 1 || only === undefined) return false;
    activate.push({ ...only, active: true });
    resolved.set(identityKey(identity), { typescriptName: only.typescriptName, source: only.source });
    return true;
  };

  /** The tool members one service contributes: the fetched canonical family when the fetch
   *  succeeded — it is authoritative for membership and disappearance — and otherwise
   *  (pre-fetch or a failed family) the configured/hinted canonical names, whose
   *  reservations must survive until a fetch can prove them gone. */
  const liveToolNames = (service: AliasServiceMembers): string[] => {
    if (service.tools !== null) return [...service.tools].sort();
    const lane = request.aliases.find((entry) => entry.appId === service.appId);
    const names = new Set<string>();
    for (const key of Object.keys(lane?.configured?.tools ?? {})) names.add(key);
    for (const key of Object.keys(lane?.hints?.tools ?? {})) names.add(key);
    return [...names].sort();
  };

  const services = [...request.services].sort((left, right) =>
    left.service < right.service ? -1 : left.service > right.service ? 1 : 0,
  );

  /** Members that fell through to generation, resolved together after every explicit name
   *  is known, so two members first seen at once can never race for one candidate. */
  const pending: { readonly identity: AliasIdentity; readonly name: string | null }[] = [];

  for (const service of services) {
    const lane = request.aliases.find((entry) => entry.appId === service.appId);
    const members: AliasIdentity[] = [{ appId: service.appId, family: "service", canonicalName: service.service }];
    for (const canonicalName of liveToolNames(service)) {
      members.push({ appId: service.appId, family: "tool", canonicalName });
    }
    for (const identity of members) {
      const own = rowsOf(identity);
      const intended = intendedAlias(lane, identity);
      if (intended !== null) {
        const violation = aliasNameViolations(intended.alias, identity.family)[0];
        if (violation !== undefined) {
          if (request.lane === "owner") {
            refusals.push(`${violation} — the ${intended.source} alias for ${identity.family} "${echo(identity.canonicalName)}" cannot be applied`);
          } else {
            omit(identity, "invalid", intended.alias);
          }
          continue;
        }
        const claimed = claimedBy(identity, intended.alias);
        if (claimed !== undefined && !sameIdentity(identityOf(claimed), identity)) {
          const conflict: AliasConflict = {
            family: identity.family,
            typescriptName: intended.alias,
            established: identityOf(claimed),
            contenders: [identity],
          };
          if (request.lane === "owner") {
            conflicts.push(conflict);
            refusals.push(
              `${aliasConflictMessage(conflict)} — the ${intended.source} alias for ${identity.family} "${echo(identity.canonicalName)}" cannot be applied`,
            );
          } else {
            omit(identity, "established", intended.alias, conflict);
          }
          continue;
        }
        assign(identity, intended.alias, intended.source);
        continue;
      }
      const active = own.find((row) => row.active);
      if (active !== undefined) {
        resolved.set(identityKey(identity), { typescriptName: active.typescriptName, source: active.source });
        continue;
      }
      if (own.length === 1) {
        if (reactivate(identity, own)) continue;
      }
      if (own.length > 1) {
        omit(identity, "ambiguous", null);
        continue;
      }
      pending.push({ identity, name: generatedAlias(identity.canonicalName, identity.family) });
    }
  }

  const groups = new Map<string, { readonly identity: AliasIdentity; readonly name: string }[]>();
  for (const entry of pending) {
    if (entry.name === null) {
      omit(entry.identity, "no_segment", null);
      continue;
    }
    if (!isAliasGrammar(entry.name)) {
      // Reachable only when the canonical name is so long that the `_` prefix pushes an
      // otherwise legal candidate past the byte bound.
      omit(entry.identity, "too_long", entry.name);
      continue;
    }
    const domain = entry.identity.family === "service" ? "service" : `tool\u0000${entry.identity.appId}`;
    const key = `${domain}\u0000${entry.name}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [{ identity: entry.identity, name: entry.name }]);
    else group.push({ identity: entry.identity, name: entry.name });
  }

  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const contenders = group.map((entry) => entry.identity);
    const holder = claimedBy(first.identity, first.name);
    if (holder !== undefined) {
      const conflict: AliasConflict = {
        family: first.identity.family,
        typescriptName: first.name,
        established: identityOf(holder),
        contenders,
      };
      for (const entry of group) omit(entry.identity, "established", first.name, entry === first ? conflict : undefined);
      continue;
    }
    if (group.length > 1) {
      const conflict: AliasConflict = { family: first.identity.family, typescriptName: first.name, established: null, contenders };
      for (const entry of group) omit(entry.identity, "simultaneous", first.name, entry === first ? conflict : undefined);
      continue;
    }
    assign(first.identity, first.name, "generated");
  }

  // Disappearance retirement: only a successfully fetched family can prove a member gone.
  for (const service of services) {
    if (service.tools === null) continue;
    const live = new Set(liveToolNames(service));
    for (const row of request.existing) {
      if (row.appId !== service.appId || row.family !== "tool" || !row.active) continue;
      if (!live.has(row.canonicalName)) retireRow(row);
    }
  }

  if (refusals.length > 0) {
    // Atomic refusal: the caller must apply nothing, so nothing applicable is returned.
    return { services: [], activate: [], retire: [], diagnostics, conflicts, refusals };
  }

  const planServices: AliasResolvedService[] = services.map((service) => {
    const name = resolved.get(identityKey({ appId: service.appId, family: "service", canonicalName: service.service }));
    const tools: AliasResolvedMember[] = liveToolNames(service).map((canonicalName) => {
      const tool = resolved.get(identityKey({ appId: service.appId, family: "tool", canonicalName }));
      return { canonicalName, typescriptName: tool?.typescriptName ?? null, source: tool?.source ?? null };
    });
    return {
      appId: service.appId,
      service: service.service,
      typescriptName: name?.typescriptName ?? null,
      source: name?.source ?? null,
      tools,
    };
  });

  return { services: planServices, activate, retire: [...retire.values()], diagnostics, conflicts, refusals };
}

// ── diagnostics rendering ─────────────────────────────────────────────────────────────

/**
 * §23.6 — one diagnostic as bounded prose, naming only the member and the contested name
 * (never another contender). Safe to publish wherever the member itself is visible.
 */
export function aliasDiagnosticMessage(diagnostic: AliasDiagnostic): string {
  const subject = `${diagnostic.family} "${echo(diagnostic.canonicalName)}"`;
  const wanted = diagnostic.typescriptName === null ? "" : ` ("${echo(diagnostic.typescriptName)}")`;
  switch (diagnostic.reason) {
    case "invalid":
      return `${subject}: the configured TypeScript alias${wanted} is not a usable identifier and was ignored`;
    case "no_segment":
      return `${subject}: the canonical name has no ASCII-alphanumeric segment to derive a TypeScript name`;
    case "too_long":
      return `${subject}: the derived TypeScript name exceeds ${TYPESCRIPT_ALIAS_MAX_BYTES} bytes`;
    case "established":
      return `${subject}: the derived TypeScript name${wanted} is already reserved; configure an explicit alias`;
    case "simultaneous":
      return `${subject}: several canonical names derive the same TypeScript name${wanted} at once; configure explicit aliases`;
    case "ambiguous":
      return `${subject}: earlier TypeScript assignments disagree; configure an explicit alias`;
  }
}

/**
 * §23.6 — one collision as owner-facing prose, naming the established holder and every
 * contender (bounded to eight names). Caller-visible surfaces must filter the structured
 * `AliasConflict` first: a contender the caller cannot see must not be named.
 */
export function aliasConflictMessage(conflict: AliasConflict): string {
  const holder =
    conflict.established === null
      ? "no established reservation"
      : `${conflict.established.family} "${echo(conflict.established.canonicalName)}"`;
  const shown = conflict.contenders
    .slice(0, 8)
    .map((contender) => `${contender.family} "${echo(contender.canonicalName)}"`)
    .join(", ");
  const more = conflict.contenders.length > 8 ? `, and ${conflict.contenders.length - 8} more` : "";
  return `TypeScript name "${echo(conflict.typescriptName)}" is held by ${holder}; contenders: ${shown}${more}`;
}

// ── the schema renderer (§23.7) ───────────────────────────────────────────────────────

/**
 * §23.7 — one rendered schema. `type` is the TypeScript expression and may reference the
 * generated aliases in `declarations` by name, so a rendered type is only usable beside
 * its declarations.
 */
export type RenderedSchema = {
  /** The TypeScript type expression; `unknown` whenever anything was unsupported. */
  readonly type: string;
  /** Generated alias declarations (`type T0 = ...;`), one per local `$ref` target in
   *  pointer order, so cycles are legal and output is deterministic. */
  readonly declarations: readonly string[];
  /** True when the root schema is an object whose `required` list has at least one string,
   *  so a declaration can make its `input` parameter required. */
  readonly requiredMembers: boolean;
  /** Bounded reasons why the render fell back to `unknown` or broadened; empty when the
   *  render is exactly the allowlisted subset. */
  readonly diagnostics: readonly string[];
  /** UTF-8 bytes of the schema's JSON copy (0 for an absent schema or a value JSON cannot
   *  carry), for the catalog's 2 MiB accounting. Measured even when the render bailed, so
   *  an over-limit schema still counts against the cap. */
  readonly bytes: number;
  /** Bounded deep JSON copy for the runtime's callable metadata, or `null` when the
   *  upstream value was absent, invalid, or over limit. */
  readonly json: unknown | null;
};

/** `renderSchema`'s one option: where a file's alias numbering starts, so a file that
 *  renders several schemas never emits two `T0`s. */
export type RenderedSchemaOptions = {
  /** First alias index to use; the caller passes the number of declarations already
   *  emitted for this file. Defaults to 0. */
  readonly aliasOffset?: number;
};

/** §23.7 — keywords that shape types but are outside the allowlist. A schema node carrying
 *  any of them renders `unknown` rather than a narrower (wrong) type. */
const UNSUPPORTED_KEYWORDS: readonly string[] = [
  "$dynamicRef", "$recursiveRef", "additionalItems", "contains", "dependentSchemas", "else",
  "if", "not", "patternProperties", "propertyNames", "then", "unevaluatedItems",
  "unevaluatedProperties",
];

/** Keys that shape an object type; their presence without `type: "object"` also admits
 *  non-objects, so the node is rendered `unknown` rather than narrowed. */
const OBJECT_KEYWORDS: readonly string[] = ["additionalProperties", "properties", "required"];

/** Keys that shape an array type; same rule as `OBJECT_KEYWORDS`. */
const ARRAY_KEYWORDS: readonly string[] = ["items", "prefixItems"];

const TEXT_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of a string — the one measure every cap in this plane uses (schemas,
 * aliases, descriptions, declarations, search responses).
 */
export function utf8Bytes(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

/**
 * Truncates to a whole number of UTF-8 bytes without splitting a code point, reporting
 * whether anything was dropped. Used for search-indexed descriptions, where a cut string is
 * metadata rather than identity.
 */
export function truncateUtf8(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) break;
    kept += character;
    bytes += size;
  }
  return { text: kept, truncated: true };
}

/** Validates, bounds and deep-copies one schema value, in three ordered steps so every
 *  failure can report the size it measured: JSON-ness (no accessors, non-plain prototypes,
 *  symbol keys, non-finite numbers or cycles), serialization plus the byte cap, then the
 *  node/depth budget on the copy. The copy shares nothing with the caller's graph. */
type SchemaCopy =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | { readonly ok: false; readonly reason: string; readonly bytes: number };

function copyJsonSchema(schema: unknown): SchemaCopy {
  const seen = new Set<unknown>();
  const checkJson = (value: unknown): string | null => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return null;
    if (typeof value === "number") return Number.isFinite(value) ? null : "a schema number is not finite";
    if (Array.isArray(value)) {
      if (seen.has(value)) return "the schema is cyclic";
      seen.add(value);
      for (const item of value) {
        const reason = checkJson(item);
        if (reason !== null) return reason;
      }
      seen.delete(value);
      return null;
    }
    if (typeof value === "object") {
      if (!isJsonObject(value)) return "a schema value is not a plain JSON object";
      if (seen.has(value)) return "the schema is cyclic";
      if (Object.getOwnPropertySymbols(value).length > 0) return "a schema object carries symbol keys";
      seen.add(value);
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) return "a schema property is an accessor";
        const reason = checkJson(descriptor.value);
        if (reason !== null) return reason;
      }
      seen.delete(value);
      return null;
    }
    return "a schema value is not JSON";
  };
  const jsonReason = checkJson(schema);
  if (jsonReason !== null) return { ok: false, reason: jsonReason, bytes: 0 };

  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    return { ok: false, reason: "the schema is not serializable JSON", bytes: 0 };
  }
  const bytes = utf8Bytes(text);
  if (bytes > HUB_SCHEMA_MAX_BYTES) {
    return { ok: false, reason: `the schema exceeds ${HUB_SCHEMA_MAX_BYTES} bytes`, bytes };
  }
  const value: unknown = JSON.parse(text);

  let nodes = 0;
  const overBudget = (node: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > HUB_SCHEMA_MAX_NODES) return `the schema exceeds ${HUB_SCHEMA_MAX_NODES} nodes`;
    if (depth > HUB_SCHEMA_MAX_DEPTH) return `the schema exceeds depth ${HUB_SCHEMA_MAX_DEPTH}`;
    if (Array.isArray(node)) {
      for (const item of node) {
        const reason = overBudget(item, depth + 1);
        if (reason !== null) return reason;
      }
    } else if (isJsonObject(node)) {
      for (const item of Object.values(node)) {
        const reason = overBudget(item, depth + 1);
        if (reason !== null) return reason;
      }
    }
    return null;
  };
  const budgetReason = overBudget(value, 0);
  if (budgetReason !== null) return { ok: false, reason: budgetReason, bytes };
  return { ok: true, value, bytes };
}

/** Resolves a local JSON Pointer (`#` or `#/a/b`, RFC 6901 percent- and `~`-decoded)
 *  against the schema copy; `undefined` for anything else, including external refs. */
function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "#") return document;
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const rawSegment of pointer.slice(2).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    segment = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isJsonObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Every local `$ref` pointer reachable from the root through positions the renderer may
 *  walk, plus whatever those targets reference. `$defs`/`definitions` containers are not
 *  walked on their own: a definition is rendered only because a ref names it. */
function collectRefPointers(document: unknown): Set<string> {
  const pointers = new Set<string>();
  const visited = new Set<object>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isJsonObject(node) || visited.has(node)) return;
    visited.add(node);
    const ref = node["$ref"];
    if (typeof ref === "string") {
      if (ref.startsWith("#") && !pointers.has(ref)) {
        pointers.add(ref);
        visit(resolvePointer(document, ref));
      }
      return;
    }
    if (isJsonObject(node["properties"])) {
      for (const member of Object.values(node["properties"])) visit(member);
    }
    for (const key of ["items", "additionalProperties"] as const) {
      if (node[key] !== undefined) visit(node[key]);
    }
    for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(node[key])) for (const member of node[key]) visit(member);
    }
  };
  visit(document);
  return pointers;
}

/**
 * §23.7 — renders one JSON Schema as a TypeScript type inside the allowlist: primitives and
 * type arrays, JSON `enum`/`const` literals, objects with `properties`/`required`/
 * `additionalProperties`, arrays and tuples with `items`/`prefixItems`, `anyOf`/`oneOf`
 * unions, `allOf` intersections, and local JSON Pointer `$ref`s as deterministic
 * pointer-sorted aliases. Anything else — an external or unresolvable ref, an unsupported
 * type-shaping keyword, object/array keywords without an explicit type, a non-JSON value,
 * an over-limit node/depth/byte count — renders `unknown` with a bounded diagnostic instead
 * of a narrower type. `undefined` (an absent schema) renders `unknown` with no diagnostic.
 * Never mutates its input, performs no I/O, and never emits a caller-supplied description
 * or canonical name into the generated source.
 */
export function renderSchema(schema: unknown, options?: RenderedSchemaOptions): RenderedSchema {
  if (schema === undefined) {
    return { type: "unknown", declarations: [], requiredMembers: false, diagnostics: [], bytes: 0, json: null };
  }
  const copy = copyJsonSchema(schema);
  if (!copy.ok) {
    return {
      type: "unknown",
      declarations: [],
      requiredMembers: false,
      diagnostics: [copy.reason],
      bytes: copy.bytes,
      json: null,
    };
  }
  const document = copy.value;
  const diagnostics: string[] = [];
  const aliases = new Map<string, string>();
  [...collectRefPointers(document)]
    .sort()
    .forEach((pointer, index) => aliases.set(pointer, `T${(options?.aliasOffset ?? 0) + index}`));

  const literalType = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "unknown";
    if (Array.isArray(value)) return `[${value.map(literalType).join(", ")}]`;
    if (isJsonObject(value)) {
      const entries = Object.entries(value);
      return entries.length === 0
        ? "Record<string, never>"
        : `{ ${entries.map(([key, member]) => `${JSON.stringify(key)}: ${literalType(member)}`).join("; ")} }`;
    }
    return "unknown";
  };

  const parenthesize = (rendered: string): string =>
    rendered.includes(" | ") || rendered.includes(" & ") ? `(${rendered})` : rendered;
  const union = (members: readonly string[]): string => [...new Set(members)].join(" | ");

  /** The members of a combinator keyword, or `null` when any is not a schema. */
  const schemaNodes = (value: unknown): readonly unknown[] | null => {
    if (!Array.isArray(value)) return null;
    return value.every((member) => typeof member === "boolean" || isJsonObject(member)) ? value : null;
  };

  const objectType = (node: Record<string, unknown>): string | null => {
    const properties = node["properties"];
    const entries: string[] = [];
    if (properties !== undefined) {
      if (!isJsonObject(properties)) {
        diagnostics.push("an object schema declares non-object properties and rendered unknown");
        return null;
      }
      const required = Array.isArray(node["required"])
        ? node["required"].filter((member): member is string => typeof member === "string")
        : [];
      for (const [key, member] of Object.entries(properties)) {
        entries.push(`${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${render(member)}`);
      }
    }
    const additional = node["additionalProperties"];
    if (additional !== undefined && additional !== true && additional !== false && !isJsonObject(additional)) {
      diagnostics.push("an object schema declares neither a boolean nor a schema additionalProperties and rendered unknown");
      return null;
    }
    if (entries.length === 0) {
      if (additional === undefined || additional === true) return "Record<string, unknown>";
      if (additional === false) return "Record<string, never>";
      return `Record<string, ${render(additional)}>`;
    }
    // Named members win and extra members are not narrowed: JSON Schema applies a
    // schema-valued additionalProperties only to undeclared keys, and an index signature
    // would wrongly reject the declared ones.
    return `{ ${entries.join("; ")} }`;
  };

  const arrayType = (node: Record<string, unknown>): string | null => {
    const prefix = node["prefixItems"];
    const items = node["items"];
    if (prefix !== undefined) {
      const members = schemaNodes(prefix);
      if (members === null) {
        diagnostics.push("an array schema declares non-schema prefixItems and rendered unknown");
        return null;
      }
      const tuple = members.map(render);
      if (items === false) return `[${tuple.join(", ")}]`;
      if (items === undefined || items === true) return `[${tuple.join(", ")}, ...unknown[]]`;
      return `[${tuple.join(", ")}, ...${parenthesize(render(items))}[]]`;
    }
    if (items === undefined || items === true) return "unknown[]";
    if (items === false) return "[]";
    return `${parenthesize(render(items))}[]`;
  };

  /** One `type` keyword's rendering, or `null` when it is unsupported or its shaping
   *  keywords are malformed — in both cases a diagnostic is already recorded and the whole
   *  node renders `unknown` (a partially narrowed union would be wrong). */
  const renderTypeKeyword = (keyword: string, node: Record<string, unknown>): string | null => {
    switch (keyword) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "object":
        return objectType(node);
      case "array":
        return arrayType(node);
      default:
        diagnostics.push(`a schema declares an unsupported type "${echo(keyword)}" and rendered unknown`);
        return null;
    }
  };

  const render = (node: unknown): string => {
    if (node === true) return "unknown";
    if (node === false) return "never";
    if (!isJsonObject(node)) {
      diagnostics.push("a schema value is neither an object nor a boolean and rendered unknown");
      return "unknown";
    }
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const alias = aliases.get(ref);
      if (alias !== undefined) return alias;
      diagnostics.push(
        ref.startsWith("#")
          ? `a local $ref "${echo(ref)}" did not resolve and rendered unknown`
          : "a non-local $ref rendered unknown",
      );
      return "unknown";
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (keyword in node) {
        diagnostics.push(`a schema uses the unsupported keyword "${keyword}" and rendered unknown`);
        return "unknown";
      }
    }
    if (Array.isArray(node["enum"])) {
      const values = node["enum"];
      return values.length === 0 ? "never" : union(values.map(literalType));
    }
    if ("const" in node) return literalType(node["const"]);

    const parts: string[] = [];
    const type = node["type"];
    if (typeof type === "string") {
      const rendered = renderTypeKeyword(type, node);
      if (rendered === null) return "unknown";
      parts.push(rendered);
    } else if (Array.isArray(type)) {
      const renderedTypes: string[] = [];
      for (const keyword of type) {
        if (typeof keyword !== "string") {
          diagnostics.push("a schema type array carries a non-string member and rendered unknown");
          return "unknown";
        }
        const rendered = renderTypeKeyword(keyword, node);
        if (rendered === null) return "unknown";
        renderedTypes.push(rendered);
      }
      parts.push(union(renderedTypes));
    } else if (type !== undefined) {
      diagnostics.push("a schema type is neither a string nor an array and rendered unknown");
      return "unknown";
    } else if (OBJECT_KEYWORDS.some((keyword) => keyword in node) || ARRAY_KEYWORDS.some((keyword) => keyword in node)) {
      diagnostics.push("object/array keywords without an explicit type rendered unknown");
      return "unknown";
    }

    const anyOf = node["anyOf"];
    const oneOf = node["oneOf"];
    if (anyOf !== undefined || oneOf !== undefined) {
      const declared = (Array.isArray(anyOf) ? anyOf.length : 0) + (Array.isArray(oneOf) ? oneOf.length : 0);
      const members = [
        ...(anyOf === undefined ? [] : schemaNodes(anyOf) ?? []),
        ...(oneOf === undefined ? [] : schemaNodes(oneOf) ?? []),
      ];
      if (members.length === 0 || members.length !== declared) {
        diagnostics.push("a union carries no schema members or a non-schema member and rendered unknown");
        return "unknown";
      }
      parts.push(union(members.map(render)));
    }

    const allOf = node["allOf"];
    if (allOf !== undefined) {
      const members = schemaNodes(allOf);
      if (members === null) {
        diagnostics.push("an intersection carries a non-schema member and rendered unknown");
        return "unknown";
      }
      if (members.length > 0) parts.push(members.map(render).map(parenthesize).join(" & "));
    }

    const deduped = [...new Set(parts)];
    if (deduped.length === 0) return "unknown";
    return deduped.length === 1 ? deduped[0] : deduped.map(parenthesize).join(" & ");
  };

  const rootType = render(document);
  const declarations = [...aliases.entries()].map(([pointer, alias]) => {
    const target = resolvePointer(document, pointer);
    const body =
      target === undefined
        ? (diagnostics.push(`a local $ref "${echo(pointer)}" did not resolve and rendered unknown`), "unknown")
        : render(target);
    return `type ${alias} = ${body};`;
  });

  const requiredMembers =
    isJsonObject(document) &&
    Array.isArray(document["required"]) &&
    document["required"].some((member) => typeof member === "string");

  return { type: rootType, declarations, requiredMembers, diagnostics, bytes: copy.bytes, json: document };
}

// ── signatures (the search face of a rendered entry) ──────────────────────────────────

/** §23.7 — the fixed TypeScript names of the hub's own two tools. Protocol infrastructure,
 *  never generated or owner-configurable, so the declarations and the search index spell
 *  them identically. */
export const HUB_TOOL_TYPESCRIPT_NAMES: Readonly<Record<HubToolName, string>> = {
  execute: "execute",
  search_types: "searchTypes",
};

/** Fixed names the generated declarations own; upstream data never reaches an identifier. */
const CALL_TOOL_RESULT = "HubCallToolResult";
const READ_RESULT = "HubReadResourceResult";
const SEARCH_TYPES_INPUT = "HubSearchTypesInput";
const SEARCH_RESULT = "HubSearchResult";
const EXECUTE_INPUT = "HubExecuteInput";
const EXECUTION_RESULT = "HubExecutionResult";
const MCP_ROOT = "HubMcp";
const RESOURCE_HANDLE = "HubResourceHandle";

/** The shared result-shaped declarations every generated file may need, emitted as one
 *  fixed block so a per-tool or per-resource file is self-contained (declaration resources
 *  cannot import each other). */
const RESULT_TYPES: readonly string[] = [
  "/** One MCP content block; extra members are carried through untouched. */",
  "interface HubContentBlock {",
  "  readonly type: string;",
  "  readonly [key: string]: unknown;",
  "}",
  "/** A tools/call result: `structuredContent` is the tool's rendered output type. */",
  `interface ${CALL_TOOL_RESULT}<T = unknown> {`,
  "  readonly content: readonly HubContentBlock[];",
  "  readonly structuredContent?: T;",
  "  readonly isError?: boolean;",
  "}",
  "/** One text or blob body of a resource read. */",
  "interface HubResourceContents {",
  "  readonly uri: string;",
  "  readonly mimeType?: string;",
  "  readonly text?: string;",
  "  readonly blob?: string;",
  "}",
  "/** A resources/read result. */",
  `interface ${READ_RESULT} {`,
  "  readonly contents: readonly HubResourceContents[];",
  "}",
  "/** One resource listing entry. */",
  "interface HubResourceEntry {",
  "  readonly uri: string;",
  "  readonly name?: string;",
  "  readonly description?: string;",
  "  readonly mimeType?: string;",
  "}",
  "/** One resource-template listing entry. */",
  "interface HubResourceTemplateEntry {",
  "  readonly uriTemplate: string;",
  "  readonly name?: string;",
  "  readonly description?: string;",
  "  readonly mimeType?: string;",
  "}",
  "/** A service's structured resource API: local listings, bridge-backed reads. */",
  `interface ${RESOURCE_HANDLE} {`,
  "  list(): readonly HubResourceEntry[];",
  "  templates(): readonly HubResourceTemplateEntry[];",
  "  read(uri: string): Promise<HubReadResourceResult>;",
  "}",
];

/** The comment every generated file opens with; fixed text, never upstream data. */
const GENERATED_HEADER = "// Generated hub TypeScript declarations. Do not edit.";

/** §23.7 — one tool's data as the declaration renderers consume it. Types are rendered
 *  ONCE by `renderSchema` at catalog-build time, with the alias numbering threaded across
 *  the whole snapshot (see this module's header), so no concatenated file emits two
 *  declarations of one name. */
export type DeclarationTool = {
  /** Canonical tool name; retained for identity, never emitted into source. */
  readonly canonicalName: string;
  /** Resolved TypeScript name, or `null` when the mapping omitted this member (it then
   *  appears in no declaration and no signature). */
  readonly typescriptName: string | null;
  /** Rendered input type, or `null` when the tool declares no input schema (the parameter
   *  is then optional `unknown`). */
  readonly inputType: string | null;
  /** Alias declarations the input type references. */
  readonly inputDeclarations: readonly string[];
  /** True when the input schema's root requires at least one member, making the parameter
   *  required. */
  readonly inputRequired: boolean;
  /** Rendered result type; `unknown` when the tool declares no output schema. */
  readonly outputType: string;
  /** Alias declarations the output type references. */
  readonly outputDeclarations: readonly string[];
};

/** §23.7 — one resource as the declaration renderers consume it: resources carry no schema,
 *  only their raw URI, which is never rewritten or prefixed. */
export type DeclarationResource = {
  /** Raw resource URI, exactly as the application serves it. */
  readonly uri: string;
};

/** §23.7 — one resource template as the declaration renderers consume it. */
export type DeclarationResourceTemplate = {
  /** Raw resource-template URI, exactly as the application serves it. */
  readonly uriTemplate: string;
};

/** §23.7 — one service as the declaration renderers consume it. */
export type DeclarationService = {
  /** Canonical slug (or the fixed `pmcp` for the builtin). */
  readonly service: string;
  /** Resolved TypeScript service name, or `null` when omitted. */
  readonly typescriptName: string | null;
  /** Canonical tools, including omitted members (which render nothing). */
  readonly tools: readonly DeclarationTool[];
  /** Resources, in any order — renderers order them by raw URI. */
  readonly resources: readonly DeclarationResource[];
  /** Resource templates, in any order — renderers order them by raw URI. */
  readonly resourceTemplates: readonly DeclarationResourceTemplate[];
};

/** §23.7 — everything a declaration render needs. `overflow` is the catalog's truncation
 *  banner: when set, every declaration renders as a banner plus an `unknown` root rather
 *  than a partially callable API. */
export type DeclarationCatalog = {
  /** Services, in any order — renderers order them by canonical slug. */
  readonly services: readonly DeclarationService[];
  /** Non-null when a hub catalog cap cut the snapshot; the renderers then refuse to emit a
   *  callable surface. */
  readonly overflow: string | null;
};

/** A property key in generated source: a bare identifier when it is one, JSON-quoted
 *  otherwise, so a caller-supplied name can never change the shape of the emitted code. */
function memberKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** The `input` parameter of a callable entry, derived once so a signature and its
 *  declaration can never disagree. */
function toolParameter(tool: DeclarationTool): string {
  if (tool.inputType === null) return "input?: unknown";
  return tool.inputRequired ? `input: ${tool.inputType}` : `input?: ${tool.inputType}`;
}

/** A service's callable members, ordered by canonical tool name, omissions dropped. */
function namedTools(service: DeclarationService): (DeclarationTool & { typescriptName: string })[] {
  return service.tools
    .filter((tool): tool is DeclarationTool & { typescriptName: string } => tool.typescriptName !== null)
    .sort((left, right) => (left.canonicalName < right.canonicalName ? -1 : left.canonicalName > right.canonicalName ? 1 : 0));
}

/** §23.7 — the callable signature `search_types` reports for one tool. */
export function toolSignature(tool: DeclarationTool): string {
  if (tool.typescriptName === null) return "unknown";
  return `${tool.typescriptName}(${toolParameter(tool)}): Promise<${CALL_TOOL_RESULT}<${tool.outputType}>>`;
}

/** §23.7 — the signature of a raw resource read. The URI identity lives in the match's
 *  canonical `subject`, and the bounded declaration exposes it as a literal `uri` const, so
 *  the signature is the same for every resource. */
export const RESOURCE_READ_SIGNATURE = `read(): Promise<${READ_RESULT}>`;

/** §23.7 — the signature of a raw resource-template read, which takes the concrete URI. */
export const RESOURCE_TEMPLATE_READ_SIGNATURE = `read(uri: string): Promise<${READ_RESULT}>`;

/** §23.2/§23.7 — the hub tools a surface exposes, in canonical `HUB_TOOLS` order. `execute`
 *  is client-only, because the program surface deliberately has no recursive execution
 *  helper. */
export function surfaceHubToolNames(surface: CatalogSurface): readonly HubToolName[] {
  return surface === "client" ? ["execute", "search_types"] : ["search_types"];
}

/** §23.7 — the signature `search_types` reports for one hub tool. The surface does not
 *  change the spelling: both surfaces declare the tools they expose under the same names. */
export function hubToolSignature(canonicalName: HubToolName): string {
  const name = HUB_TOOL_TYPESCRIPT_NAMES[canonicalName];
  if (canonicalName === "execute") {
    return `${name}(input: ${EXECUTE_INPUT}): Promise<${CALL_TOOL_RESULT}<${EXECUTION_RESULT}>>`;
  }
  return `${name}(input: ${SEARCH_TYPES_INPUT}): ${SEARCH_RESULT}`;
}

/**
 * §23.2 — the fixed declaration resource a hub-tool match points at: `program.d.ts` for the
 * program surface, `client.d.ts` for the client one. Hub tools have no per-tool template.
 */
export function hubToolDeclarationUri(surface: CatalogSurface): string {
  return surface === "client" ? HUB_CLIENT_DECLARATION_URI : HUB_PROGRAM_DECLARATION_URI;
}

/** One canonical placeholder segment in exactly `encodeURIComponent` form, or `null` when
 *  the segment is not encodable (a lone surrogate): a value this module refuses to turn
 *  into a URI rather than a value it silently mangles. */
function encodeSegment(segment: string): string | null {
  try {
    const encoded = encodeURIComponent(segment);
    return decodeURIComponent(encoded) === segment ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * §23.2 — the direct declaration URI of one canonical catalog entry, with every
 * placeholder an exact `encodeURIComponent` segment (a raw `/`, `%`, `{` or `}` inside a
 * name or URI therefore never becomes path structure). Returns `null` when a segment is not
 * encodable; the caller omits that entry with a diagnostic rather than inventing a URI.
 */
export function catalogDeclarationUri(
  kind: "tool" | "resource" | "resourceTemplate",
  service: string,
  subject: string,
): string | null {
  const prefix = { tool: "tools", resource: "resources", resourceTemplate: "resource-templates" }[kind];
  const encodedService = encodeSegment(service);
  const encodedSubject = encodeSegment(subject);
  if (encodedService === null || encodedSubject === null) return null;
  return `pmcp://hub/types/${prefix}/${encodedService}/${encodedSubject}.d.ts`;
}

/** §23.5/§23.7 — the declaration text for a catalog whose cap was exceeded: a banner and
 *  an `unknown` root, never a partially callable API. */
function unavailable(reason: string, root: string): string {
  const declaration = root === "mcp" ? "declare const mcp: unknown;" : `export declare const ${root}: unknown;`;
  return `${GENERATED_HEADER}\n// Declaration unavailable: ${reason}\n${declaration}\n`;
}

/** §23.11's declaration cap as one gate: over it, the same banner-plus-unknown contract a
 *  catalog overflow produces. */
function bounded(text: string, root: string): string {
  if (utf8Bytes(text) <= HUB_DECLARATION_MAX_BYTES) return text;
  return unavailable(`the declaration exceeds ${HUB_DECLARATION_MAX_BYTES} bytes`, root);
}

/** The rendered hub-tool type aliases a surface needs, from the same `HUB_TOOLS` schemas
 *  the wire serves, with ONE running alias offset across every schema so two tools' local
 *  refs never both emit `T0`. */
function hubTypeAliases(surface: CatalogSurface): readonly string[] {
  const byName = new Map(HUB_TOOLS.map((tool) => [tool.name, tool]));
  const declarations: string[] = [];
  let offset = 0;
  for (const name of surfaceHubToolNames(surface)) {
    const tool = byName.get(name);
    if (tool === undefined) continue;
    const input = renderSchema(tool.inputSchema, { aliasOffset: offset });
    offset += input.declarations.length;
    declarations.push(`type ${name === "execute" ? EXECUTE_INPUT : SEARCH_TYPES_INPUT} = ${input.type};`);
    declarations.push(...input.declarations);
    const output = renderSchema(tool.outputSchema, { aliasOffset: offset });
    offset += output.declarations.length;
    declarations.push(`type ${name === "execute" ? EXECUTION_RESULT : SEARCH_RESULT} = ${output.type};`);
    declarations.push(...output.declarations);
  }
  return declarations;
}

/** One declaration member for a runtime tool: callable plus the bounded schemas exposed as
 * frozen metadata on that function. */
function toolMember(tool: DeclarationTool, indent: string): string[] {
  if (tool.typescriptName === null) return [];
  return [
    `${indent}readonly ${memberKey(tool.typescriptName)}: {`,
    `${indent}  readonly inputSchema: unknown | null;`,
    `${indent}  readonly outputSchema: unknown | null;`,
    `${indent}  (${toolParameter(tool)}): Promise<${CALL_TOOL_RESULT}<${tool.outputType}>>;`,
    `${indent}};`,
  ];
}

/** Every declaration block for a service's callable members plus the shared resource
 * handle, as object-type members. */
function serviceMembers(service: DeclarationService): string[] {
  const lines = namedTools(service).flatMap((tool) => toolMember(tool, "  "));
  lines.push(`  readonly resources: ${RESOURCE_HANDLE};`);
  return lines;
}

/** §23.7 — the program-surface declaration: the read-only global `mcp` with the caller's
 * authorized services, their TypeScript tool names and structured resource API, plus the
 * local `mcp.hub.searchTypes` helper. Deliberately no `mcp.hub.execute`: recursive
 * execution is impossible from inside a program. */
export function renderProgramDeclaration(catalog: DeclarationCatalog): string {
  if (catalog.overflow !== null) return unavailable(catalog.overflow, "mcp");
  const services = [...catalog.services].sort((left, right) =>
    left.service < right.service ? -1 : left.service > right.service ? 1 : 0,
  );
  const aliases: string[] = [];
  const root: string[] = [`interface ${MCP_ROOT} {`];
  for (const service of services) {
    if (service.typescriptName === null) continue;
    for (const tool of namedTools(service)) aliases.push(...tool.inputDeclarations, ...tool.outputDeclarations);
    root.push(`  readonly ${memberKey(service.typescriptName)}: {`, ...serviceMembers(service), "  };");
  }
  aliases.push(...hubTypeAliases("program"));
  root.push(
    "  readonly hub: {",
    `    searchTypes(input: ${SEARCH_TYPES_INPUT}): ${SEARCH_RESULT};`,
    "  };",
    "}",
    "declare const mcp: HubMcp;",
  );
  const lines = [GENERATED_HEADER, "", ...RESULT_TYPES, ...(aliases.length === 0 ? [] : ["", ...aliases]), "", ...root];
  return bounded(`${lines.join("\n")}\n`, "mcp");
}

/** §23.7 — the client-surface declaration: the external ergonomic facade with
 *  `mcp.hub.execute` and `mcp.hub.searchTypes`, plus the shared result shapes. It is never
 *  loaded into the program checker. */
export function renderClientDeclaration(): string {
  const lines = [
    GENERATED_HEADER,
    "",
    ...RESULT_TYPES,
    "",
    ...hubTypeAliases("client"),
    "",
    `interface ${MCP_ROOT} {`,
    "  readonly hub: {",
    `    execute(input: ${EXECUTE_INPUT}): Promise<${CALL_TOOL_RESULT}<${EXECUTION_RESULT}>>;`,
    `    searchTypes(input: ${SEARCH_TYPES_INPUT}): ${SEARCH_RESULT};`,
    "  };",
    "}",
    "declare const mcp: HubMcp;",
  ];
  return bounded(`${lines.join("\n")}\n`, "mcp");
}

/** §23.7 — the bounded subset declaration for one service: its callable members and the
 *  structured resource API, exported as `Service`/`service`. */
export function renderServiceDeclaration(service: DeclarationService): string {
  if (service.typescriptName === null) return unavailable("the service has no TypeScript name", "service");
  const aliases = namedTools(service).flatMap((tool) => [...tool.inputDeclarations, ...tool.outputDeclarations]);
  const lines = [
    GENERATED_HEADER,
    "",
    ...RESULT_TYPES,
    ...(aliases.length === 0 ? [] : ["", ...aliases]),
    "",
    "export interface Service {",
    ...serviceMembers(service),
    "}",
    "export declare const service: Service;",
  ];
  return bounded(`${lines.join("\n")}\n`, "service");
}

/** §23.7 — the bounded subset declaration for one canonical tool. */
export function renderToolDeclaration(tool: DeclarationTool): string {
  if (tool.typescriptName === null) return unavailable("the tool has no TypeScript name", "tool");
  const aliases = [...tool.inputDeclarations, ...tool.outputDeclarations];
  const lines = [
    GENERATED_HEADER,
    "",
    ...RESULT_TYPES,
    ...(aliases.length === 0 ? [] : ["", ...aliases]),
    "",
    `export declare const ${memberKey(tool.typescriptName)}: {`,
    "  readonly inputSchema: unknown | null;",
    "  readonly outputSchema: unknown | null;",
    `  (${toolParameter(tool)}): Promise<${CALL_TOOL_RESULT}<${tool.outputType}>>;`,
    "};",
  ];
  return bounded(`${lines.join("\n")}\n`, "tool");
}

/** §23.7 — the bounded subset declaration for one raw resource URI. The URI is a string
 *  literal in its own declaration; it is never parsed apart into path segments. */
export function renderResourceDeclaration(resource: DeclarationResource): string {
  const lines = [
    GENERATED_HEADER,
    "",
    "/** One text or blob body of a resource read. */",
    "interface HubResourceContents {",
    "  readonly uri: string;",
    "  readonly mimeType?: string;",
    "  readonly text?: string;",
    "  readonly blob?: string;",
    "}",
    "/** A resources/read result. */",
    `interface ${READ_RESULT} {`,
    "  readonly contents: readonly HubResourceContents[];",
    "}",
    "",
    `export declare const uri: ${JSON.stringify(resource.uri)};`,
    `export function read(): Promise<${READ_RESULT}>;`,
  ];
  return bounded(`${lines.join("\n")}\n`, "resource");
}

/** §23.7 — the bounded subset declaration for one raw resource template, whose placeholders
 *  stay inside the literal template string. */
export function renderResourceTemplateDeclaration(template: DeclarationResourceTemplate): string {
  const lines = [
    GENERATED_HEADER,
    "",
    "/** One text or blob body of a resource read. */",
    "interface HubResourceContents {",
    "  readonly uri: string;",
    "  readonly mimeType?: string;",
    "  readonly text?: string;",
    "  readonly blob?: string;",
    "}",
    "/** A resources/read result. */",
    `interface ${READ_RESULT} {`,
    "  readonly contents: readonly HubResourceContents[];",
    "}",
    "",
    `export declare const uriTemplate: ${JSON.stringify(template.uriTemplate)};`,
    `export function read(uri: string): Promise<${READ_RESULT}>;`,
  ];
  return bounded(`${lines.join("\n")}\n`, "resourceTemplate");
}
