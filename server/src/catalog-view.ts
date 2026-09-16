// catalog-view.ts — the pure computations `/apps/<slug>` needs and nothing else has: the
// **Arguments** table read off a tool's `inputSchema`, the same schema walked WHOLE into
// dotted leaf paths (`schemaLeaves` — what the Catalog details and the Recording pane's
// mask rows read), and the **reachability** set that answers §13's "Reachable by
// `<agent>` · via `<role>`".
//
// Both are the page's, and neither is a second implementation of anything: the reachability
// MODE is `registry.buildToolFilter(entries, declared).check(subject, family)` — the door's
// own verdict, which already owns `all`'s span across families, per-family independence and
// allow-beats-approval — so a page that disagreed with the door about access is impossible
// here rather than merely discouraged (§13: "never a second implementation"). What this
// module does own is the INPUT translation: `agent_list` reports grants in its own spelling
// (`"<role>"` allow, `"<role>:approval"` approval, §8/§9) and admin's inverse parser is
// private, so the strings are parsed here.
//
// A LEAF, deliberately: it imports `registry` and nothing else, so it runs in the `unit`
// project's plain-Node pool (gateway, admin and tunnel each drag `cloudflare:workers` in at
// module scope). Its rows are server/test/unit/catalog-view.test.ts.
//
// deps: registry.buildToolFilter · registry types

import { buildToolFilter } from "./registry";
import type { AccessMode, GrantEntry, RoleDeclaration, RoleFamily } from "./registry";

/**
 * One row of §13's Arguments table: the columns it draws (name, type, `required` or
 * `optional · defaults to <value>`) and nothing more. `default` carries the schema's own
 * VALUE — `false`, not `"false"` — and is absent when the schema declares none, which is
 * what `hasDefault` is for: a declared `default: undefined` and no default at all are the
 * same row to a reader and would not be to a `default !== undefined` test.
 */
export type ArgumentRow = {
  name: string;
  /** The declared `type`, or `""` when the schema names none (a union type is not a word). */
  type: string;
  required: boolean;
  hasDefault: boolean;
  default?: unknown;
};

/**
 * A tool's arguments as §13's table: the inputSchema's TOP-LEVEL `properties` in their own
 * declaration order, marked from `required` and `default`. Nested schemas print their outer
 * type and are not recursed into — the ceiling §13 states in as many words ("the row is a
 * glance, and `pmcp describe` prints the schema whole").
 *
 * Total over anything: a schema stored by an app is whatever that app sent, so a value that
 * is not an object, an object with no `properties`, and an absent schema all yield the empty
 * table the `no args` render draws — never a throw inside a page render.
 */
export function argumentRows(inputSchema: unknown): ArgumentRow[] {
  // deps: none
  const properties = objectOf(objectOf(inputSchema)?.properties);
  if (properties === null) return [];
  const declared = objectOf(inputSchema)?.required;
  const required = new Set(Array.isArray(declared) ? declared.filter((name) => typeof name === "string") : []);
  return Object.entries(properties).map(([name, value]) => {
    const property = objectOf(value) ?? {};
    const hasDefault = "default" in property;
    return {
      name,
      type: typeof property.type === "string" ? property.type : "",
      required: required.has(name),
      hasDefault,
      ...(hasDefault ? { default: property.default } : {}),
    };
  });
}

/**
 * One LEAF of a schema, as the Catalog details' Arguments/Result cards and the Recording
 * pane's path rows both read it: the dotted path, its type, and the three facts a mask
 * decision turns on — whether the level above requires it, whether the app declared it
 * `writeOnly` (already masked, never tickable), and its default. `default` and `hasDefault`
 * carry the same meaning they do on ArgumentRow above, for the same reason.
 */
export type SchemaLeaf = {
  path: string;
  type: string;
  required: boolean;
  writeOnly: boolean;
  hasDefault: boolean;
  default?: unknown;
};

/**
 * A JSON schema's leaves as dotted paths (`credentials.token`), objects recursed into,
 * arrays printed as `<type>[]` and not recursed; `required` from each level's list.
 *
 * The ceiling is deliberate and it is the ARRAY: `tags: string[]` is one leaf, not a
 * subtree, because §7's redaction paths address values and not elements — a mask on
 * `tags` covers the whole list, and a row per element index would be a path no mask could
 * ever be written against. An array OF objects prints `object[]` for the same reason.
 *
 * `required` is read PER LEVEL, never inherited: an optional object holding a required
 * child yields a required leaf, which is what the level's own `required` list says and
 * what the Arguments card draws. Composition keywords (`anyOf`, `$ref`, …) are not walked
 * — a schema with no `properties` at a level is a leaf there, typed by whatever `type` it
 * names — so this is total over anything an app sent: a non-object, an object with no
 * properties, and an absent schema all yield `[]` rather than a throw inside a render.
 *
 * Cycles cannot arise: a JSON schema arrives as parsed JSON from D1 or an upstream
 * listing, so it is a tree by construction.
 */
export function schemaLeaves(schema: unknown): SchemaLeaf[] {
  // deps: none
  const properties = objectOf(objectOf(schema)?.properties);
  if (properties === null) return [];
  const declared = objectOf(schema)?.required;
  const required = new Set(Array.isArray(declared) ? declared.filter((name) => typeof name === "string") : []);
  return Object.entries(properties).flatMap(([name, value]) => {
    const property = objectOf(value) ?? {};
    const type = typeof property.type === "string" ? property.type : "";
    const nested = type === "object" ? schemaLeaves(property) : [];
    // An object that declares no properties of its own has no leaves BELOW it, so it is
    // one itself — otherwise it would vanish from the table entirely.
    if (nested.length > 0) return nested.map((leaf) => ({ ...leaf, path: `${name}.${leaf.path}` }));
    const hasDefault = "default" in property;
    return [
      {
        path: name,
        type: type === "array" ? `${itemType(property.items)}[]` : type,
        required: required.has(name),
        writeOnly: property.writeOnly === true,
        hasDefault,
        ...(hasDefault ? { default: property.default } : {}),
      },
    ];
  });
}

/** An array's element type as the `<type>[]` rendering names it — `""` when the schema
 *  declares no `items`, or declares them as anything but a plain typed schema, so the
 *  leaf reads `[]` rather than claiming a type nobody wrote down. */
function itemType(items: unknown): string {
  const type = objectOf(items)?.type;
  return typeof type === "string" ? type : "";
}

/** One agent that reaches a subject, as §13's "Reachable by …" line renders it. */
export type Reach = {
  /** The agent's slug — `agent_list`'s own key. */
  agent: string;
  /** The door's verdict for this agent on this subject: never `deny` (those are dropped). */
  mode: Exclude<AccessMode, "deny">;
  /** The granted entries that matched, each named as it is stored: `all` naming itself and
   *  never expanded, and an inline item naming itself too (`tool/get_news`), which is what
   *  lets a page say "via reader" or "direct" from this one list. */
  roles: string[];
};

/** One app's grants, parsed and built into doors once — `reachabilityFor`'s return. */
export type Reachability = {
  /** Which agents reach this subject in this family, and how (§13's reachability line). */
  reach(subject: string, family: RoleFamily): Reach[];
};

/**
 * The door's build-then-check split, kept split (§13's reachability line, §20.3's
 * per-family keyspaces). `declared` is the app's role declaration as `app_get` reports it;
 * `grants` is `agent_list`'s inline map, agent slug → its grant strings on THIS app.
 *
 * BUILD phase, once per app: `buildToolFilter` normalizes the whole declaration on every
 * construction, so building inside the per-row call would re-normalize it for every
 * (subject × agent × grant) — and /apps/<slug> renders every family of every row. The
 * doors here are the app's, not a row's, so they are built where the app is.
 *
 * The verdict is the door's `check`, per agent — so `all`'s span, the per-family literal
 * fast path and allow-beats-approval are answered once, in registry, and this function adds
 * only the per-agent loop. The role NAMES are the granted roles that matched on their own,
 * asked the same way (each as a lone allow), so "via `<role>`" can never name a role that
 * did not match.
 */
export function reachabilityFor(declared: RoleDeclaration, grants: Record<string, string[]>): Reachability {
  // deps: buildToolFilter · parseGrant
  const doors = Object.entries(grants).map(([agent, spelled]) => {
    const entries = spelled.map(parseGrant);
    return {
      agent,
      filter: buildToolFilter(entries, declared),
      roles: entries.map((entry) => ({
        role: entry.role,
        filter: buildToolFilter([{ ...entry, mode: "allow" }], declared),
      })),
    };
  });
  return {
    reach(subject, family) {
      const reached: Reach[] = [];
      for (const door of doors) {
        const mode = door.filter.check(subject, family);
        if (mode === "deny") continue;
        const matched = door.roles.filter((role) => role.filter.check(subject, family) !== "deny");
        reached.push({ agent: door.agent, mode, roles: [...new Set(matched.map((role) => role.role))] });
      }
      return reached;
    },
  };
}

/** One subject's reachability, doors and all — the whole answer for callers holding a single
 *  subject. A page holding many builds the doors once with `reachabilityFor`. */
export function reachability(
  subject: string,
  family: RoleFamily,
  declared: RoleDeclaration,
  grants: Record<string, string[]>,
): Reach[] {
  // deps: reachabilityFor
  return reachabilityFor(declared, grants).reach(subject, family);
}

/**
 * §9's grant syntax as a stored entry — admin's `grantEntries` read backwards, spelled here
 * because that one is private and `admin` cannot be imported by a Node-clean module.
 *
 * The mode is the `:approval` SUFFIX, not the first colon: an inline resource item
 * (`resource/news://feed/*`) carries colons of its own, and splitting at the first one
 * would hand the door the pattern `//feed/*` under a family that is not resources. What
 * is left is the entry verbatim; an entry naming nothing real (a mis-typed suffix, an
 * unknown role) reaches nothing, because `buildToolFilter` finds no patterns for it.
 */
function parseGrant(entry: string): GrantEntry {
  return entry.endsWith(APPROVAL_SUFFIX)
    ? { role: entry.slice(0, -APPROVAL_SUFFIX.length), mode: "approval" }
    : { role: entry, mode: "allow" };
}

/** The wire spelling of approval mode — `agent_list`'s own (§8/§9). */
const APPROVAL_SUFFIX = ":approval";

/** A value as a plain record, or null when it is anything else (an array included). */
function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
