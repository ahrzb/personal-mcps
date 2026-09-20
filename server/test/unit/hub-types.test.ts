// hub-types.test.ts — §23.6/§23.7's pure contract: alias grammar and generated candidates,
// the reservation planner across the owner/sdk/generated lanes and their tombstones, the
// bounded schema renderer, and the generated declarations — the last of which are COMPILED
// with the repository's own TypeScript (hub-compile.ts), because "it renders" is not the
// claim being made.
//
// PINS, in order: a generated candidate is derived deterministically (punctuation splits,
// case preservation, `_` for a leading digit or any reserved/sensitive name for that
// family) and canonical identities are never rewritten; a name that is taken, ambiguous or
// underivable is omitted with a structured diagnostic rather than renamed; explicit
// collisions refuse the owner write atomically but only omit the SDK member; tombstones
// protect their names and a returning member keeps its own single reservation; the renderer
// falls back to `unknown` for everything outside the allowlist, including external refs and
// hostile values, while local recursive refs render as pointer-sorted aliases.
//
// PROJECT: `unit` — plain Node. deps: src/hub-types · src/hub-contract (the wire tool
// schemas the declarations render) · src/limits (the caps) · hub-compile (TypeScript) ·
// no platform APIs.

import { describe, expect, it } from "vitest";
import { HUB_TOOLS } from "../../src/hub-contract";
import {
  HUB_DECLARATION_MAX_BYTES,
  HUB_SCHEMA_MAX_BYTES,
  HUB_SCHEMA_MAX_DEPTH,
  HUB_SCHEMA_MAX_NODES,
} from "../../src/limits";
import {
  HUB_CLIENT_DECLARATION_URI,
  HUB_PROGRAM_DECLARATION_URI,
  aliasConflictMessage,
  aliasDiagnosticMessage,
  aliasNameViolations,
  aliasViolations,
  catalogDeclarationUri,
  generatedAlias,
  hubToolDeclarationUri,
  hubToolSignature,
  planAliasReservations,
  renderClientDeclaration,
  renderProgramDeclaration,
  renderResourceDeclaration,
  renderResourceTemplateDeclaration,
  renderSchema,
  renderServiceDeclaration,
  renderToolDeclaration,
  utf8Bytes,
} from "../../src/hub-types";
import type {
  AliasReservation,
  AliasServiceMembers,
  DeclarationCatalog,
  DeclarationTool,
  TypescriptAliases,
} from "../../src/hub-types";
import { compileDiagnostics } from "./hub-compile";

const APP = "app-news";
const OTHER = "app-other";

/** One planning request's service row, with the two fields tests vary most often. */
function service(appId: string, slug: string, tools: readonly string[] | null): AliasServiceMembers {
  return { appId, service: slug, tools };
}

/** One app's alias lanes. */
function lane(
  appId: string,
  configured: TypescriptAliases | null,
  hints: TypescriptAliases | null = null,
): { appId: string; configured: TypescriptAliases | null; hints: TypescriptAliases | null } {
  return { appId, configured, hints };
}

/** One committed reservation row. */
function row(
  appId: string,
  family: "service" | "tool",
  canonicalName: string,
  typescriptName: string,
  source: AliasReservation["source"],
  active: boolean,
): AliasReservation {
  return { appId, family, canonicalName, typescriptName, source, active };
}

/** The committed state after applying a plan's writes — what a retry would re-read. */
function applyRows(
  existing: readonly AliasReservation[],
  activate: readonly AliasReservation[],
  retire: readonly AliasReservation[],
): AliasReservation[] {
  const rows = new Map(existing.map((entry) => [`${entry.appId}/${entry.family}/${entry.canonicalName}/${entry.typescriptName}`, entry]));
  for (const entry of [...activate, ...retire]) {
    rows.set(`${entry.appId}/${entry.family}/${entry.canonicalName}/${entry.typescriptName}`, entry);
  }
  return [...rows.values()];
}

/** The tool-family rows of a plan's writes. Every request carries a service member too, so
 *  assertions about tool behavior filter it out rather than repeating it in every row. */
function toolRows(rows: readonly AliasReservation[]): AliasReservation[] {
  return rows.filter((entry) => entry.family === "tool");
}

/** A rendered tool declaration input, the way hub-catalog's builder produces one. */
function declaredTool(
  canonicalName: string,
  typescriptName: string | null,
  input: unknown,
  output: unknown,
): DeclarationTool {
  const inputSchema = input === undefined ? null : renderSchema(input);
  const outputSchema = output === undefined ? null : renderSchema(output, { aliasOffset: inputSchema?.declarations.length ?? 0 });
  return {
    canonicalName,
    typescriptName,
    inputType: inputSchema?.type ?? null,
    inputDeclarations: inputSchema?.declarations ?? [],
    inputRequired: inputSchema?.requiredMembers ?? false,
    outputType: outputSchema?.type ?? "unknown",
    outputDeclarations: outputSchema?.declarations ?? [],
  };
}

describe("§23.6 · alias grammar and generated candidates", () => {
  it("generatedAlias derives one deterministic lower-camel name: punctuation splits, the first ASCII letter of each later segment is uppercased while the rest is preserved, and digits are prefixed — never suffixed, never sorted-to-pick", () => {
    expect(generatedAlias("get-news", "tool")).toBe("getNews");
    expect(generatedAlias("get_news", "tool")).toBe("getNews");
    expect(generatedAlias("Get-News", "tool")).toBe("getNews");
    // `GET-NEWS` is the case-preservation pin: only the FIRST letter of each segment is
    // touched, so an all-caps upstream name keeps its shouting instead of silently
    // collapsing into `getNews` and colliding with a different member.
    expect(generatedAlias("GET-NEWS", "tool")).toBe("gETNEWS");
    expect(generatedAlias("v2-api", "tool")).toBe("v2Api");
    expect(generatedAlias("a--b", "tool")).toBe("aB");
    expect(generatedAlias("_private", "tool")).toBe("_private");
    expect(generatedAlias("$dollar", "tool")).toBe("dollar");
    expect(generatedAlias("2fast", "tool")).toBe("_2fast");
    // No ASCII-alphanumeric segment means no derivable name at all — omitted, not mangled.
    expect(generatedAlias("---", "tool")).toBeNull();
    expect(generatedAlias("日本語", "tool")).toBeNull();
    // Non-ASCII letters are separators, so the surrounding ASCII runs still form a name.
    expect(generatedAlias("háteo", "tool")).toBe("hTeo");
    expect(generatedAlias("café-latte", "tool")).toBe("cafLatte");
  });

  it("generatedAlias prefixes every reserved/sensitive name for its family — keywords and thenable-sensitive names everywhere, root `hub`/`pmcp` for a service, `resources` for a tool — so a candidate never claims a fixed member", () => {
    expect(generatedAlias("for", "tool")).toBe("_for");
    expect(generatedAlias("then", "service")).toBe("_then");
    expect(generatedAlias("catch", "tool")).toBe("_catch");
    expect(generatedAlias("resources", "tool")).toBe("_resources");
    // The twins: `resources` is reserved INSIDE a service, not at the root, and a tool may
    // be named `hub` because the root members live one namespace up.
    expect(generatedAlias("resources", "service")).toBe("resources");
    expect(generatedAlias("hub", "tool")).toBe("hub");
    expect(generatedAlias("hub", "service")).toBe("_hub");
    expect(generatedAlias("pmcp", "service")).toBe("_pmcp");
  });

  it("aliasNameViolations refuses explicit aliases the generator would rename around: grammar, keywords, prototype/thenable names, root members and `resources`", () => {
    for (const legal of ["news", "getNews", "_x", "$x", "a1", "x".repeat(128)]) {
      expect(aliasNameViolations(legal, "service"), legal).toEqual([]);
    }
    expect(aliasNameViolations("hub", "service")).toHaveLength(1);
    expect(aliasNameViolations("pmcp", "service")).toHaveLength(1);
    expect(aliasNameViolations("resources", "tool")).toHaveLength(1);
    expect(aliasNameViolations("then", "tool")).toHaveLength(1);
    expect(aliasNameViolations("class", "tool")).toHaveLength(1);
    expect(aliasNameViolations("a-b", "tool")).toHaveLength(1);
    expect(aliasNameViolations("1a", "tool")).toHaveLength(1);
    expect(aliasNameViolations("", "tool")).toHaveLength(1);
    expect(aliasNameViolations("x".repeat(129), "tool")).toHaveLength(1);
    // The anchored-regex trap: `$` also matches before a trailing newline, so `"a\n"` must
    // be rejected by the scan, not admitted by a regex.
    expect(aliasNameViolations("a\n", "tool")).toHaveLength(1);
    expect(aliasNameViolations("néws", "tool")).toHaveLength(1);
    // The twins of the two family-reserved refusals: legal in the other family.
    expect(aliasNameViolations("resources", "service")).toEqual([]);
    expect(aliasNameViolations("hub", "tool")).toEqual([]);
  });

  it("aliasViolations treats `undefined` as the only absence and `null` as a malformed object, and reports the exact key path of every syntax failure", () => {
    expect(aliasViolations(undefined)).toEqual([]);
    expect(aliasViolations(null)).toEqual(["typescriptAliases must be an object"]);
    expect(aliasViolations({})).toEqual([]);
    expect(aliasViolations({ service: "news", tools: { "get-news": "getNews" } })).toEqual([]);
    expect(aliasViolations({ service: "hub" })[0]).toContain("typescriptAliases.service");
    expect(aliasViolations({ tools: { "get-news": "then" } })[0]).toContain('typescriptAliases.tools["get-news"]');
    expect(aliasViolations({ tools: { "": "x" } })).toHaveLength(1);
    expect(aliasViolations({ tools: { a: 5 } })).toHaveLength(1);
    expect(aliasViolations({ tools: [] })).toHaveLength(1);
    expect(aliasViolations({ extra: 1 })).toHaveLength(1);
    expect(aliasViolations("nope")).toHaveLength(1);
    expect(aliasViolations([])).toHaveLength(1);
    // A hostile key is echoed sanitized: no control character may reach a refusal record.
    const hostile = aliasViolations({ tools: { "a\u0007b": 1 } })[0] ?? "";
    expect(hostile).not.toMatch(/[\u0000-\u001f]/);
    expect(hostile).toContain("a?b");
  });
});

describe("§23.6 · the reservation planner", () => {
  it("resolves owner over sdk over generated, and reports which lane the name came from", () => {
    const request = { services: [service(APP, "news", ["get-news"])], existing: [], lane: "sdk" as const };
    const owner = planAliasReservations({
      ...request,
      aliases: [lane(APP, { service: "wire", tools: { "get-news": "fetchNews" } }, { service: "hint", tools: { "get-news": "hintNews" } })],
    });
    expect(owner.services[0]).toMatchObject({ service: "news", typescriptName: "wire", source: "owner" });
    expect(owner.services[0].tools[0]).toEqual({ canonicalName: "get-news", typescriptName: "fetchNews", source: "owner" });

    const sdk = planAliasReservations({ ...request, aliases: [lane(APP, null, { service: "hint" })] });
    expect(sdk.services[0]).toMatchObject({ typescriptName: "hint", source: "sdk" });

    const generated = planAliasReservations({ ...request, aliases: [] });
    expect(generated.services[0]).toMatchObject({ typescriptName: "news", source: "generated" });
    expect(generated.services[0].tools[0]).toEqual({ canonicalName: "get-news", typescriptName: "getNews", source: "generated" });
  });

  it("an established reservation — active or tombstoned — beats a newcomer, which is omitted with the contender facts rather than renamed", () => {
    const request = { services: [service(APP, "news", null)], aliases: [], lane: "sdk" as const };
    const active = planAliasReservations({ ...request, existing: [row(OTHER, "service", "news", "news", "generated", true)] });
    expect(active.services[0].typescriptName).toBeNull();
    expect(active.diagnostics).toEqual([{ family: "service", canonicalName: "news", typescriptName: "news", reason: "established" }]);
    expect(active.conflicts).toEqual([
      { family: "service", typescriptName: "news", established: { appId: OTHER, family: "service", canonicalName: "news" }, contenders: [{ appId: APP, family: "service", canonicalName: "news" }] },
    ]);
    expect(active.activate).toEqual([]);

    // The tombstone twin: the name stays protected after its member disappeared.
    const tombstoned = planAliasReservations({ ...request, existing: [row(OTHER, "service", "news", "news", "generated", false)] });
    expect(tombstoned.services[0].typescriptName).toBeNull();
    expect(tombstoned.diagnostics[0].reason).toBe("established");
  });

  it("two members first appearing together on one free candidate are BOTH omitted; a later addition leaves the established member's API alone", () => {
    const together = planAliasReservations({ services: [service(APP, "news", ["get-news", "get_news"])], existing: [], aliases: [], lane: "sdk" });
    expect(together.services[0].tools).toEqual([
      { canonicalName: "get-news", typescriptName: null, source: null },
      { canonicalName: "get_news", typescriptName: null, source: null },
    ]);
    expect(together.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(["simultaneous", "simultaneous"]);
    expect(together.conflicts).toHaveLength(1);
    expect(together.conflicts[0].established).toBeNull();
    expect(toolRows(together.activate)).toEqual([]);

    // The singleton twin: alone, the same candidate is assigned.
    const singleton = planAliasReservations({ services: [service(APP, "news", ["get-news"])], existing: [], aliases: [], lane: "sdk" });
    expect(singleton.services[0].tools[0].typescriptName).toBe("getNews");
    expect(toolRows(singleton.activate)).toEqual([row(APP, "tool", "get-news", "getNews", "generated", true)]);

    // Later: `get_news` appears after `get-news` published its path — the newcomer is
    // omitted, the established row is not rewritten.
    const later = planAliasReservations({
      services: [service(APP, "news", ["get-news", "get_news"])],
      existing: [row(APP, "tool", "get-news", "getNews", "generated", true)],
      aliases: [],
      lane: "sdk",
    });
    expect(later.services[0].tools).toEqual([
      { canonicalName: "get-news", typescriptName: "getNews", source: "generated" },
      { canonicalName: "get_news", typescriptName: null, source: null },
    ]);
    expect(toolRows(later.activate)).toEqual([]);
    expect(later.diagnostics[0]).toMatchObject({ canonicalName: "get_news", reason: "established" });
  });

  it("a returning member reactivates its own single tombstone, while two of its own rows are ambiguous and nothing is revived", () => {
    const returning = planAliasReservations({
      services: [service(APP, "news", ["get-news"])],
      existing: [row(APP, "tool", "get-news", "getNews", "generated", false)],
      aliases: [],
      lane: "sdk",
    });
    expect(returning.services[0].tools[0]).toEqual({ canonicalName: "get-news", typescriptName: "getNews", source: "generated" });
    expect(toolRows(returning.activate)).toEqual([row(APP, "tool", "get-news", "getNews", "generated", true)]);
    expect(returning.retire).toEqual([]);

    // A supersede happened here (two of its own names), so the planner cannot know which
    // one is current: it revives neither and asks for an explicit alias.
    const ambiguous = planAliasReservations({
      services: [service(APP, "news", ["get-news"])],
      existing: [row(APP, "tool", "get-news", "getNews", "generated", false), row(APP, "tool", "get-news", "headlines", "owner", false)],
      aliases: [],
      lane: "sdk",
    });
    expect(ambiguous.services[0].tools[0].typescriptName).toBeNull();
    expect(ambiguous.diagnostics).toEqual([{ family: "tool", canonicalName: "get-news", typescriptName: null, reason: "ambiguous" }]);
    expect(toolRows(ambiguous.activate)).toEqual([]);
  });

  it("an intentional alias change supersedes the old name — new path active, old path tombstoned and still protecting against newcomers", () => {
    const existing = [row(APP, "service", "news", "news", "generated", true)];
    const changed = planAliasReservations({
      services: [service(APP, "news", null)],
      existing,
      aliases: [lane(APP, { service: "wire" })],
      lane: "sdk",
    });
    expect(changed.services[0]).toMatchObject({ typescriptName: "wire", source: "owner" });
    expect(changed.activate).toEqual([row(APP, "service", "news", "wire", "owner", true)]);
    expect(changed.retire).toEqual([row(APP, "service", "news", "news", "generated", false)]);

    const committed = applyRows(existing, changed.activate, changed.retire);
    const newcomer = planAliasReservations({ services: [service(OTHER, "news", null)], existing: committed, aliases: [], lane: "sdk" });
    expect(newcomer.services[0].typescriptName).toBeNull();
    expect(newcomer.diagnostics[0].reason).toBe("established");
  });

  it("a successfully fetched family is authoritative for membership: a configured member that disappeared is tombstoned, and its configured name reactivates on return", () => {
    const configured = lane(APP, { tools: { "get-news": "fetchNews" } });
    const existing = [row(APP, "tool", "get-news", "fetchNews", "owner", true)];

    const disappeared = planAliasReservations({
      services: [service(APP, "news", ["other-tool"])],
      existing,
      aliases: [configured],
      lane: "sdk",
    });
    expect(disappeared.retire).toEqual([row(APP, "tool", "get-news", "fetchNews", "owner", false)]);
    expect(disappeared.services[0].tools).toEqual([{ canonicalName: "other-tool", typescriptName: "otherTool", source: "generated" }]);

    // The unavailable-family twin: a failed fetch (tools null) proves nothing, so the
    // configured reservation stays active and its name stays resolvable.
    const unavailable = planAliasReservations({ services: [service(APP, "news", null)], existing, aliases: [configured], lane: "sdk" });
    expect(unavailable.retire).toEqual([]);
    expect(unavailable.services[0].tools).toEqual([{ canonicalName: "get-news", typescriptName: "fetchNews", source: "owner" }]);

    // Return: the configured alias is still there, so its own tombstone is reactivated.
    const returned = planAliasReservations({
      services: [service(APP, "news", ["get-news"])],
      existing: applyRows(existing, disappeared.retire, []),
      aliases: [configured],
      lane: "sdk",
    });
    expect(returned.services[0].tools[0]).toEqual({ canonicalName: "get-news", typescriptName: "fetchNews", source: "owner" });
    expect(toolRows(returned.activate)).toEqual([row(APP, "tool", "get-news", "fetchNews", "owner", true)]);
  });

  it("two explicit aliases colliding inside ONE request: the owner lane refuses the whole write atomically, the sdk lane keeps the first and diagnoses the second", () => {
    const collision: TypescriptAliases = { tools: { alpha: "shared", beta: "shared" } };
    const request = { services: [service(APP, "news", ["alpha", "beta"])], existing: [], aliases: [lane(APP, collision)] };

    const owner = planAliasReservations({ ...request, lane: "owner" });
    expect(owner.refusals).toHaveLength(1);
    expect(owner.refusals[0]).toContain("shared");
    expect(owner.services).toEqual([]);
    expect(owner.activate).toEqual([]);
    expect(owner.retire).toEqual([]);
    expect(owner.conflicts).toEqual([
      { family: "tool", typescriptName: "shared", established: { appId: APP, family: "tool", canonicalName: "alpha" }, contenders: [{ appId: APP, family: "tool", canonicalName: "beta" }] },
    ]);

    const sdk = planAliasReservations({ ...request, lane: "sdk" });
    expect(sdk.refusals).toEqual([]);
    expect(sdk.services[0].tools).toEqual([
      { canonicalName: "alpha", typescriptName: "shared", source: "owner" },
      { canonicalName: "beta", typescriptName: null, source: null },
    ]);
    expect(toolRows(sdk.activate)).toEqual([row(APP, "tool", "alpha", "shared", "owner", true)]);
    expect(sdk.diagnostics).toEqual([{ family: "tool", canonicalName: "beta", typescriptName: "shared", reason: "established" }]);
  });

  it("the owner lane refuses a collision with another app's reservation and invalid syntax; the sdk lane omits and diagnoses both instead", () => {
    const existing = [row(OTHER, "service", "news", "news", "generated", true)];
    const collision = { services: [service(APP, "news", null)], existing, aliases: [lane(APP, { service: "news" })] };
    const refused = planAliasReservations({ ...collision, lane: "owner" });
    expect(refused.refusals).toHaveLength(1);
    expect(refused.activate).toEqual([]);
    const lenient = planAliasReservations({ ...collision, lane: "sdk" });
    expect(lenient.refusals).toEqual([]);
    expect(lenient.services[0].typescriptName).toBeNull();
    expect(lenient.diagnostics[0].reason).toBe("established");

    const invalid = { services: [service(APP, "news", null)], existing: [], aliases: [lane(APP, { service: "1bad" })] };
    expect(planAliasReservations({ ...invalid, lane: "owner" }).refusals).toHaveLength(1);
    const omitted = planAliasReservations({ ...invalid, lane: "sdk" });
    expect(omitted.diagnostics).toEqual([{ family: "service", canonicalName: "news", typescriptName: "1bad", reason: "invalid" }]);
  });

  it("omits with the right reason when nothing is derivable or the derived name cannot be an identifier, and never rewrites the canonical identity", () => {
    const hostileTool = "we\u202eird";
    const plan = planAliasReservations({
      services: [service(APP, "---", ["日本語", "x".repeat(200), hostileTool])],
      existing: [],
      aliases: [],
      lane: "sdk",
    });
    expect(plan.services[0].typescriptName).toBeNull();
    expect(plan.diagnostics.map((diagnostic) => diagnostic.reason).sort()).toEqual(["no_segment", "no_segment", "too_long"]);
    // The hostile canonical name is preserved byte-for-byte and only its TypeScript side is
    // derived — and the derived name contains no Unicode control character.
    expect(plan.services[0].tools.map((tool) => tool.canonicalName).sort()).toEqual([hostileTool, "x".repeat(200), "日本語"].sort());
    expect(plan.services[0].tools.find((tool) => tool.canonicalName === hostileTool)?.typescriptName).toBe("weIrd");
  });

  it("is deterministic over shuffled inputs, and a second pass over the committed rows resolves identically — a re-read retry converges", () => {
    const request = {
      services: [service(APP, "news", ["b-tool", "a-tool"]), service(OTHER, "other", ["x"])],
      existing: [row(APP, "tool", "a-tool", "aTool", "generated", false)],
      aliases: [lane(APP, { tools: { "a-tool": "first" } }, null)],
      lane: "sdk" as const,
    };
    const first = planAliasReservations(request);
    const shuffled = planAliasReservations({
      ...request,
      services: [service(OTHER, "other", ["x"]), service(APP, "news", ["a-tool", "b-tool"])],
    });
    expect(shuffled).toEqual(first);

    const committed = applyRows(request.existing, first.activate, first.retire);
    const second = planAliasReservations({ ...request, existing: committed });
    expect(second.services).toEqual(first.services);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.conflicts).toEqual(first.conflicts);
    for (const written of [...second.activate, ...second.retire]) {
      expect(committed, `row ${written.canonicalName}/${written.typescriptName}`).toContainEqual(written);
    }
  });

  it("renders diagnostics as bounded prose: self-scoped per member, and contender facts only in the owner-facing conflict message", () => {
    const diagnostic = aliasDiagnosticMessage({ family: "tool", canonicalName: "get_news", typescriptName: "getNews", reason: "simultaneous" });
    expect(diagnostic).toContain('"get_news"');
    expect(diagnostic).not.toContain('"get-news"');
    const conflict = aliasConflictMessage({
      family: "tool",
      typescriptName: "getNews",
      established: { appId: OTHER, family: "tool", canonicalName: "get-news" },
      contenders: [{ appId: APP, family: "tool", canonicalName: "get_news" }],
    });
    expect(conflict).toContain('"get-news"');
    expect(conflict).toContain('"get_news"');
  });
});

describe("§23.7 · the schema renderer", () => {
  it("renders primitives, type arrays, literals and the object/array allowlist, broadening where a JSON Schema constraint cannot be expressed", () => {
    expect(renderSchema({ type: "string" }).type).toBe("string");
    expect(renderSchema({ type: ["string", "null"] }).type).toBe("string | null");
    expect(renderSchema({ type: "integer" }).type).toBe("number");
    expect(renderSchema({ type: "boolean" }).type).toBe("boolean");
    expect(renderSchema({ enum: ["a", "b"] }).type).toBe('"a" | "b"');
    expect(renderSchema({ enum: [1, 2] }).type).toBe("1 | 2");
    expect(renderSchema({ enum: [] }).type).toBe("never");
    expect(renderSchema({ const: null }).type).toBe("null");
    expect(renderSchema({ const: { a: 1 } }).type).toBe('{ "a": 1 }');

    const object = renderSchema({
      type: "object",
      properties: { doi: { type: "string" }, force: { type: "boolean" } },
      required: ["doi"],
    });
    expect(object.type).toBe('{ "doi": string; "force"?: boolean }');
    expect(object.requiredMembers).toBe(true);
    expect(renderSchema({ type: "object", properties: { doi: { type: "string" } } }).requiredMembers).toBe(false);
    expect(renderSchema({ type: "object", properties: {} }).type).toBe("Record<string, unknown>");
    expect(renderSchema({ type: "object", properties: {}, additionalProperties: false }).type).toBe("Record<string, never>");
    expect(renderSchema({ type: "object", additionalProperties: { type: "number" } }).type).toBe("Record<string, number>");
    // Named members win and extras are not narrowed: an index signature would reject the
    // declared ones, and JSON Schema applies a schema-valued additionalProperties only to
    // undeclared keys.
    expect(
      renderSchema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } }).type,
    ).toBe('{ "a"?: string }');

    expect(renderSchema({ type: "array", items: { type: "string" } }).type).toBe("string[]");
    expect(renderSchema({ type: "array", items: { type: ["string", "null"] } }).type).toBe("(string | null)[]");
    expect(renderSchema({ type: "array", items: false }).type).toBe("[]");
    expect(renderSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }).type).toBe("[string, number, ...unknown[]]");
    expect(renderSchema({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }).type).toBe("[string, ...number[]]");
    expect(renderSchema({ type: "array", prefixItems: [{ type: "string" }], items: false }).type).toBe("[string]");
    expect(renderSchema({ type: "array", items: { allOf: [{ type: "string" }, { const: "a" }] } }).type).toBe(
      "(string & \"a\")[]",
    );
    expect(
      renderSchema({
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { allOf: [{ type: "string" }, { const: "a" }] },
      }).type,
    ).toBe("[string, ...(string & \"a\")[]]");

    expect(renderSchema({ anyOf: [{ type: "string" }, { type: "number" }] }).type).toBe("string | number");
    expect(renderSchema({ oneOf: [{ const: "a" }, { const: "b" }] }).type).toBe('"a" | "b"');
    expect(
      renderSchema({
        allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }],
      }).type,
    ).toBe('{ "a"?: string } & { "b"?: number }');
    expect(renderSchema({ allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "object" }] }).type).toBe(
      "(string | number) & Record<string, unknown>",
    );
    expect(
      renderSchema({ type: "string", anyOf: [{ const: "a" }, { const: "b" }] }).type,
    ).toBe("string & (\"a\" | \"b\")");
  });

  it("renders local JSON Pointer refs as pointer-sorted aliases so recursive schemas are legal and deterministic", () => {
    const recursive = renderSchema({ type: "object", properties: { name: { type: "string" }, child: { $ref: "#" } }, required: ["name"] });
    expect(recursive.type).toBe('{ "name": string; "child"?: T0 }');
    expect(recursive.declarations).toEqual(['type T0 = { "name": string; "child"?: T0 };']);

    const mutual = renderSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
      },
    });
    expect(mutual.type).toBe('{ "a"?: T0 }');
    expect(mutual.declarations).toEqual(['type T0 = { "b"?: T1 };', 'type T1 = { "a"?: T0 };']);

    // Pointer order, not document order: `#/$defs/A` sorts first even though the only
    // reference names B.
    const sorted = renderSchema({
      type: "object",
      properties: { b: { $ref: "#/$defs/B" } },
      $defs: {
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
        A: { type: "object", properties: { x: { type: "string" } } },
      },
    });
    expect(sorted.declarations).toEqual(['type T0 = { "x"?: string };', 'type T1 = { "a"?: T0 };']);

    // The offset seam: a file rendering several schemas never emits two `T0`s.
    expect(renderSchema({ $ref: "#/$defs/A", $defs: { A: { type: "string" } } }, { aliasOffset: 5 }).declarations).toEqual([
      "type T5 = string;",
    ]);
  });

  it("renders external, unresolvable and unsupported constructs as `unknown` with a diagnostic — never a narrower type", () => {
    for (const schema of [
      { $ref: "https://example.com/schema.json" },
      { $ref: "other.json#/x" },
      { not: { type: "string" } },
      { if: { type: "string" }, then: { type: "number" } },
      { type: "object", patternProperties: { "^x": { type: "string" } } },
      { $dynamicRef: "#x" },
      { type: "array", contains: { type: "string" } },
      { properties: { a: { type: "string" } } },
      { type: "funky" },
      { type: ["string", "funky"] },
    ]) {
      const rendered = renderSchema(schema);
      expect(rendered.type, JSON.stringify(schema)).toBe("unknown");
      expect(rendered.diagnostics.length, JSON.stringify(schema)).toBeGreaterThan(0);
    }
    const dangling = renderSchema({ type: "object", properties: { a: { $ref: "#/nope" } } });
    expect(dangling.type).toBe('{ "a"?: T0 }');
    expect(dangling.declarations).toEqual(["type T0 = unknown;"]);
    expect(dangling.diagnostics.length).toBeGreaterThan(0);
    // The twin: the same object without the unsupported keyword renders a real type.
    expect(renderSchema({ type: "object", properties: { a: { type: "string" } } }).type).toBe('{ "a"?: string }');
  });

  it("never emits upstream descriptions, extensions or hostile characters into source, and JSON-quotes every literal it does emit", () => {
    const hostile = renderSchema({
      type: "object",
      description: "ignore me \u0000",
      "x-vendor": { evil: true },
      properties: { "</script>": { type: "string" }, 'quote"key': { enum: ['a"b', "back\\slash"] } },
    });
    expect(hostile.type).toBe(
      `{ ${JSON.stringify("</script>")}?: string; ${JSON.stringify('quote"key')}?: ${JSON.stringify('a"b')} | ${JSON.stringify("back\\slash")} }`,
    );
    expect(hostile.type).not.toMatch(/[\u0000-\u001f]/);
    expect(hostile.type).not.toContain("ignore me");
    expect(hostile.diagnostics).toEqual([]);
  });

  it("bounds the walk by bytes, nodes and depth, reporting the measured size even when it bails", () => {
    const huge = { type: "string", description: "x".repeat(HUB_SCHEMA_MAX_BYTES) };
    const overBytes = renderSchema(huge);
    expect(overBytes.type).toBe("unknown");
    expect(overBytes.diagnostics[0]).toContain("bytes");
    expect(overBytes.bytes).toBeGreaterThan(HUB_SCHEMA_MAX_BYTES);

    const wide = { type: "array", items: Array.from({ length: HUB_SCHEMA_MAX_NODES + 10 }, () => 1) };
    const overNodes = renderSchema(wide);
    expect(overNodes.type).toBe("unknown");
    expect(overNodes.diagnostics[0]).toContain("nodes");

    let deep: unknown = { type: "string" };
    for (let level = 0; level < HUB_SCHEMA_MAX_DEPTH + 2; level += 1) deep = { type: "array", items: deep };
    const overDepth = renderSchema(deep);
    expect(overDepth.type).toBe("unknown");
    expect(overDepth.diagnostics[0]).toContain("depth");
  });

  it("rejects everything JSON cannot carry — accessors, prototypes, symbols, non-finite numbers, cycles — and treats an absent schema as plain `unknown`", () => {
    expect(renderSchema(undefined)).toEqual({ type: "unknown", json: null, declarations: [], requiredMembers: false, diagnostics: [], bytes: 0 });
    for (const value of [new Date(), { type: "string", description: () => "x" }, { type: "string", default: Number.NaN }]) {
      expect(renderSchema(value).type, String(value)).toBe("unknown");
      expect(renderSchema(value).diagnostics.length).toBeGreaterThan(0);
    }
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "type", { get: () => "string" });
    expect(renderSchema(accessor).type).toBe("unknown");
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["self"] = cyclic;
    expect(renderSchema(cyclic).type).toBe("unknown");
    const symbol = { type: "string" } as Record<string | symbol, unknown>;
    symbol[Symbol("x")] = true;
    expect(renderSchema(symbol).type).toBe("unknown");
  });

  it("is deterministic: identical input renders byte-identical output, and diagnostics carry no upstream payload", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } }, B: { type: "string" } },
    };
    expect(renderSchema(schema)).toEqual(renderSchema(schema));
    expect(renderSchema(schema).declarations.join("\n")).toBe(renderSchema(schema).declarations.join("\n"));
  });
});

describe("§23.7 · generated declarations", () => {
  const catalog: DeclarationCatalog = {
    overflow: null,
    services: [
      {
        service: "news",
        typescriptName: "news",
        tools: [
          declaredTool(
            "get-news",
            "getNews",
            { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
            { type: "object", properties: { title: { type: "string" } } },
          ),
          declaredTool("broken", null, { type: "object" }, { type: "object" }),
        ],
        resources: [{ uri: "news://feed/latest" }],
        resourceTemplates: [{ uriTemplate: "news://feed/{id}" }],
      },
    ],
  };

  it("the program declaration compiles with a probe that calls a tool, lists and reads resources, and searches — and it carries no application identity, only TypeScript names", () => {
    const program = renderProgramDeclaration(catalog);
    const probe = [
      'const call = await mcp.news.getNews({ q: "x" });',
      "const title: string | undefined = call.structuredContent?.title;",
      "const listing = mcp.news.resources.list();",
      'const read = await mcp.news.resources.read("news://feed/latest");',
      'const found = mcp.hub.searchTypes({ query: "news" });',
      "export { call, title, listing, read, found };",
    ].join("\n");
    expect(compileDiagnostics({ "program.d.ts": program, "probe.ts": probe })).toEqual([]);
    // The omitted member appears nowhere, and no canonical name is emitted as an identifier.
    expect(program).not.toContain("broken");
    expect(program).toContain("getNews");
    expect(renderProgramDeclaration(catalog)).toBe(program);
  });

  it("the program declaration deliberately omits `mcp.hub.execute` while the client declaration has it — recursive execution is unreachable from inside a program", () => {
    const program = renderProgramDeclaration(catalog);
    const programProbe = 'const run = mcp.hub.execute({ code: "return 1" }); export { run };';
    const programDiagnostics = compileDiagnostics({ "program.d.ts": program, "probe.ts": programProbe });
    expect(programDiagnostics.length).toBeGreaterThan(0);
    expect(programDiagnostics.every((message) => message.includes("execute"))).toBe(true);

    const client = renderClientDeclaration();
    const clientProbe = [
      'const run = await mcp.hub.execute({ code: "return 1" });',
      "const kind = run.structuredContent?.kind;",
      'const found = mcp.hub.searchTypes({ query: "news" });',
      "export { run, kind, found };",
    ].join("\n");
    expect(compileDiagnostics({ "client.d.ts": client, "probe.ts": clientProbe })).toEqual([]);
    expect(client).toContain("execute");
    expect(client).toBe(renderClientDeclaration());
  });

  it("the bounded subset declarations compile standalone: service, tool, resource and resource template", () => {
    const service = catalog.services[0];
    const files = {
      "service.d.ts": renderServiceDeclaration(service),
      "tool.d.ts": renderToolDeclaration(service.tools[0]),
      "resource.d.ts": renderResourceDeclaration({ uri: "news://feed/latest" }),
      "template.d.ts": renderResourceTemplateDeclaration({ uriTemplate: "news://feed/{id}" }),
      "probe.ts": [
        'import type { Service } from "./service";',
        'import { service } from "./service";',
        'import { getNews } from "./tool";',
        'import { uri, read } from "./resource";',
        'import { uriTemplate, read as readTemplate } from "./template";',
        "const typed: Service = service;",
        "const names: readonly string[] = typed.resources.list().map((entry) => entry.uri);",
        'const same: boolean = uri === "news://feed/latest";',
        'const body = await readTemplate("news://feed/1");',
        "export { getNews, names, same, read, body, uriTemplate };",
      ].join("\n"),
    };
    expect(compileDiagnostics(files)).toEqual([]);
    // An omitted tool renders no callable subset: its declaration is a banner, not a
    // partially usable function.
    const omitted = renderToolDeclaration(catalog.services[0].tools[1]);
    expect(omitted).toContain("export declare const tool: unknown;");
    expect(omitted).not.toContain("broken");
  });

  it("a catalog whose cap was exceeded renders a banner and an unknown root instead of a partially callable API", () => {
    const banner = renderProgramDeclaration({ ...catalog, overflow: "the catalog exceeds 256 entries; later services were omitted" });
    expect(banner).toContain("declare const mcp: unknown;");
    expect(banner).not.toContain("getNews");
  });

  it("a declaration over §23.11's byte cap falls back to the same banner, so an oversized catalog cannot emit a truncated callable API", () => {
    const bulky = (index: number): DeclarationTool =>
      declaredTool(
        `tool-${index}`,
        `tool${index}`,
        { type: "object" },
        { enum: Array.from({ length: 280 }, (_value, member) => `v${member}-${"x".repeat(200)}`) },
      );
    const huge: DeclarationCatalog = {
      overflow: null,
      services: [
        {
          service: "big",
          typescriptName: "big",
          tools: Array.from({ length: 20 }, (_value, index) => bulky(index)),
          resources: [],
          resourceTemplates: [],
        },
      ],
    };
    const rendered = renderProgramDeclaration(huge);
    expect(rendered).toContain("declare const mcp: unknown;");
    expect(utf8Bytes(rendered)).toBeLessThan(HUB_DECLARATION_MAX_BYTES);
  });

  it("builds declaration URIs with exactly one encodeURIComponent per placeholder, refuses unencodable segments, and points hub tools at their fixed file", () => {
    expect(catalogDeclarationUri("tool", "news", "get-news")).toBe("pmcp://hub/types/tools/news/get-news.d.ts");
    expect(catalogDeclarationUri("resource", "news", "news://feed/latest")).toBe(
      "pmcp://hub/types/resources/news/news%3A%2F%2Ffeed%2Flatest.d.ts",
    );
    expect(catalogDeclarationUri("resourceTemplate", "news", "news://feed/{id}")).toBe(
      "pmcp://hub/types/resource-templates/news/news%3A%2F%2Ffeed%2F%7Bid%7D.d.ts",
    );
    // One decode returns the canonical subject exactly: an encoded `/`, `%`, `{` or `}`
    // never became path structure.
    const subject = "a/b%c{d}e";
    const uri = catalogDeclarationUri("tool", "news", subject);
    expect(uri).not.toBeNull();
    const segment = (uri as string).split("/").pop()?.replace(/\.d\.ts$/, "") ?? "";
    expect(segment).toBe(encodeURIComponent(subject));
    expect(decodeURIComponent(segment)).toBe(subject);
    // A lone surrogate has no canonical encoding: the entry is refused, never mangled.
    expect(catalogDeclarationUri("tool", "news", "a\ud800b")).toBeNull();

    expect(hubToolDeclarationUri("program")).toBe(HUB_PROGRAM_DECLARATION_URI);
    expect(hubToolDeclarationUri("client")).toBe(HUB_CLIENT_DECLARATION_URI);
  });

  it("spells the hub tools' TypeScript names from the fixed map and derives their signatures from the same wire schemas", () => {
    expect(hubToolSignature("execute")).toBe("execute(input: HubExecuteInput): Promise<HubCallToolResult<HubExecutionResult>>");
    expect(hubToolSignature("search_types")).toBe("searchTypes(input: HubSearchTypesInput): HubSearchResult");
    const client = renderClientDeclaration();
    expect(client).toContain("HubExecutionResult");
    // The rendered hub input type is the wire schema's, not a hand-written shape.
    const searchInput = renderSchema(HUB_TOOLS[1].inputSchema);
    expect(client).toContain(`type HubSearchTypesInput = ${searchInput.type};`);
  });
});
