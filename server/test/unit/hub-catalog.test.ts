// hub-catalog.test.ts — §23.5's immutable snapshot and §23.2's ranked search: canonical
// ordering, the per-entry and whole-catalog caps, the derived signature/declaration-URI
// face, surface separation (the program has no `mcp.hub.execute`), and the exact serialized
// response bound.
//
// PINS that the snapshot is a function of the canonical identities alone — two shuffled
// inputs build equal snapshots — that caps fail closed (an over-cap catalog is a canonical
// prefix with `truncated`, never a guessed or partially callable one), that an omitted
// mapping member stays visible to diagnostics but is not searchable, and that the search
// result is bounded by the ACTUAL serialization, not a heuristic reserve. The final case
// compiles the snapshot's program declaration with TypeScript, which is the integration
// proof that builder numbering and renderer numbering are the same numbering.
//
// PROJECT: `unit` — plain Node. deps: src/hub-catalog · src/hub-types · src/limits ·
// hub-compile (TypeScript) · no platform APIs.

import { describe, expect, it } from "vitest";
import {
  HUB_CATALOG_MAX_BYTES,
  HUB_CATALOG_MAX_ENTRIES,
  HUB_DESCRIPTION_MAX_BYTES,
  HUB_SCHEMA_MAX_BYTES,
  HUB_SEARCH_RESPONSE_MAX_BYTES,
  HUB_SUBJECT_MAX_BYTES,
} from "../../src/limits";
import { buildCatalogSnapshot, searchCatalog } from "../../src/hub-catalog";
import type { CatalogServiceInput } from "../../src/hub-catalog";
import {
  HUB_CLIENT_DECLARATION_URI,
  HUB_PROGRAM_DECLARATION_URI,
  renderProgramDeclaration,
  utf8Bytes,
} from "../../src/hub-types";
import { compileDiagnostics } from "./hub-compile";

const NEWS: CatalogServiceInput = {
  appId: "app-news",
  service: "news",
  typescriptName: "news",
  kind: "tunnel",
  tools: [
    {
      canonicalName: "get-news",
      typescriptName: "getNews",
      description: "Fetch the latest headlines",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      outputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
    { canonicalName: "a-tool", typescriptName: "aTool", description: "First alphabetically" },
  ],
  resources: [{ uri: "news://feed/latest", description: "The newest items" }],
  resourceTemplates: [{ uriTemplate: "news://feed/{id}", description: "One feed item" }],
};

const WEATHER: CatalogServiceInput = {
  appId: "app-weather",
  service: "weather",
  typescriptName: "weather",
  kind: "proxy",
  tools: [{ canonicalName: "forecast", typescriptName: "forecast", description: "Tomorrow's weather" }],
  resources: [],
  resourceTemplates: [],
};

/** `count` canonical tools whose names sort in creation order (`t000`, `t001`, …). */
function many(count: number): CatalogServiceInput["tools"] {
  return Array.from({ length: count }, (_value, index) => ({
    canonicalName: `t${String(index).padStart(3, "0")}`,
    typescriptName: `t${index}`,
  }));
}

/** One service whose tools each carry a ~58 KiB output schema — big enough to exercise the
 *  response byte cap with a handful of matches, small enough to pass the per-schema cap. */
function bulkyService(toolCount: number): CatalogServiceInput {
  return {
    appId: "app-bulky",
    service: "bulky",
    typescriptName: "bulky",
    kind: "tunnel",
    tools: Array.from({ length: toolCount }, (_value, index) => ({
      canonicalName: `bulk-${index}`,
      typescriptName: `bulk${index}`,
      outputSchema: { enum: Array.from({ length: 280 }, (_member, member) => `v${member}-${"x".repeat(200)}`) },
    })),
    resources: [],
    resourceTemplates: [],
  };
}

describe("§23.5 · the catalog snapshot", () => {
  it("orders by canonical identity, not discovery order, and builds equal snapshots from shuffled inputs", () => {
    const snapshot = buildCatalogSnapshot({ services: [WEATHER, NEWS] });
    expect(snapshot.services.map((service) => service.service)).toEqual(["news", "weather"]);
    expect(snapshot.services[0].tools.map((tool) => tool.canonicalName)).toEqual(["a-tool", "get-news"]);
    expect(snapshot.entryCount).toBe(5);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.overflow).toBeNull();
    expect(buildCatalogSnapshot({ services: [NEWS, WEATHER] })).toEqual(snapshot);
  });

  it("derives each entry's signature and declaration URI from the same rendered types the declarations use, and keeps canonical identities", () => {
    const snapshot = buildCatalogSnapshot({ services: [NEWS] });
    const tool = snapshot.services[0].tools.find((entry) => entry.canonicalName === "get-news");
    expect(tool?.signature).toBe('getNews(input: { "q": string }): Promise<HubCallToolResult<{ "title"?: string }>>');
    expect(tool?.declarationUri).toBe("pmcp://hub/types/tools/news/get-news.d.ts");
    expect(tool?.canonicalName).toBe("get-news");
    expect(tool?.diagnostics).toEqual([]);
    // A tool with no schemas at all is callable with an optional `unknown` input and an
    // `unknown` result — absent schemas never become `never` or a guessed shape.
    const bare = snapshot.services[0].tools.find((entry) => entry.canonicalName === "a-tool");
    expect(bare?.inputType).toBeNull();
    expect(bare?.signature).toBe("aTool(input?: unknown): Promise<HubCallToolResult<unknown>>");
    expect(snapshot.services[0].resources[0].signature).toBe("read(): Promise<HubReadResourceResult>");
    expect(snapshot.services[0].resourceTemplates[0].signature).toBe("read(uri: string): Promise<HubReadResourceResult>");
  });

  it("keeps an omitted mapping member in the snapshot for diagnostics but gives it no callable face, and drops an entry whose subject cannot be represented", () => {
    const omitted = buildCatalogSnapshot({
      services: [{ ...NEWS, tools: [{ canonicalName: "broken", typescriptName: null }] }],
    });
    expect(omitted.services[0].tools[0]).toMatchObject({ canonicalName: "broken", typescriptName: null, signature: "unknown" });

    const longSubject = buildCatalogSnapshot({
      services: [{ ...NEWS, tools: [{ canonicalName: "x".repeat(HUB_SUBJECT_MAX_BYTES + 1), typescriptName: "x" }] }],
    });
    expect(longSubject.services[0].tools).toEqual([]);
    expect(longSubject.services[0].diagnostics[0]).toContain("subject");

    // A lone surrogate has no canonical URI encoding: the entry is dropped, not mangled.
    const unencodable = buildCatalogSnapshot({
      services: [{ ...NEWS, tools: [{ canonicalName: "a\ud800b", typescriptName: "ab" }] }],
    });
    expect(unencodable.services[0].tools).toEqual([]);
    expect(unencodable.services[0].diagnostics[0]).toContain("declaration URI");
  });

  it("bounds descriptions and schemas per entry — a cut description is reported, an over-limit schema renders unknown while its bytes still count", () => {
    const described = buildCatalogSnapshot({
      services: [{ ...NEWS, tools: [{ ...NEWS.tools[0], description: "d".repeat(HUB_DESCRIPTION_MAX_BYTES + 10) }] }],
    });
    expect(utf8Bytes(described.services[0].tools[0].description)).toBe(HUB_DESCRIPTION_MAX_BYTES);
    expect(described.services[0].diagnostics[0]).toContain("description");

    const huge = buildCatalogSnapshot({
      services: [
        { ...NEWS, tools: [{ canonicalName: "big", typescriptName: "big", inputSchema: { type: "string", description: "x".repeat(HUB_SCHEMA_MAX_BYTES) } }] },
      ],
    });
    expect(huge.services[0].tools[0].inputType).toBe("unknown");
    expect(huge.services[0].tools[0].diagnostics[0]).toContain("bytes");
    expect(huge.services[0].tools[0].bytes).toBeGreaterThan(HUB_SCHEMA_MAX_BYTES);
    expect(huge.bytes).toBeGreaterThan(HUB_SCHEMA_MAX_BYTES);
  });

  it("cuts an over-cap catalog at a service boundary — earlier services stay whole, later ones are omitted with the banner that makes declarations refuse", () => {
    const aaa: CatalogServiceInput = { appId: "a", service: "aaa", typescriptName: "aaa", kind: "tunnel", tools: many(2), resources: [], resourceTemplates: [] };
    const zzz: CatalogServiceInput = {
      appId: "z",
      service: "zzz",
      typescriptName: "zzz",
      kind: "tunnel",
      tools: many(HUB_CATALOG_MAX_ENTRIES + 10),
      resources: [],
      resourceTemplates: [],
    };
    const capped = buildCatalogSnapshot({ services: [zzz, aaa] });
    expect(capped.services.map((service) => service.service)).toEqual(["aaa"]);
    expect(capped.entryCount).toBe(2);
    expect(capped.truncated).toBe(true);
    expect(capped.overflow).toContain(String(HUB_CATALOG_MAX_ENTRIES));
    expect(renderProgramDeclaration(capped)).toContain("declare const mcp: unknown;");

    // The byte twin: entries fit, but the raw schema/catalog bytes do not.
    const bytesCapped = buildCatalogSnapshot({ services: [bulkyService(40)] });
    expect(bytesCapped.services).toEqual([]);
    expect(bytesCapped.truncated).toBe(true);
    expect(bytesCapped.overflow).toContain(String(HUB_CATALOG_MAX_BYTES));
  });

  it("counts every family's subjects and descriptions toward the raw catalog bytes, not only tool schemas", () => {
    const bare = buildCatalogSnapshot({ services: [{ ...NEWS, resources: [{ uri: "news://feed/latest" }] }] });
    const padded = buildCatalogSnapshot({
      services: [{ ...NEWS, resources: [{ uri: "news://feed/latest", description: "r".repeat(HUB_DESCRIPTION_MAX_BYTES) }] }],
    });
    // The resource's bounded description is catalog payload, so the total grows by exactly it.
    expect(padded.bytes - bare.bytes).toBe(HUB_DESCRIPTION_MAX_BYTES);
    expect(padded.entryCount).toBe(bare.entryCount);

    // And so does a canonical subject: a longer tool name is more catalog bytes.
    const shortSubject = buildCatalogSnapshot({
      services: [{ appId: "a", service: "s", typescriptName: "s", kind: "tunnel", tools: [{ canonicalName: "aa", typescriptName: "aa" }], resources: [], resourceTemplates: [] }],
    });
    const longSubject = buildCatalogSnapshot({
      services: [{ appId: "a", service: "s", typescriptName: "s", kind: "tunnel", tools: [{ canonicalName: "a".repeat(50), typescriptName: "a" }], resources: [], resourceTemplates: [] }],
    });
    expect(longSubject.bytes - shortSubject.bytes).toBe(48);
  });
});

describe("§23.2 · ranked search", () => {
  const snapshot = buildCatalogSnapshot({ services: [NEWS, WEATHER] });

  it("ranks exact path/canonical identity, then prefix, then substring, then description — case-insensitively and without fuzzing", () => {
    const exact = searchCatalog(snapshot, { query: "get-news" });
    expect(exact.matches[0]).toMatchObject({ kind: "tool", service: "news", subject: "get-news", path: "mcp.news.getNews" });
    expect(exact.incomplete).toBe(false);

    // Path equality is case-insensitive; the subject still reports the canonical spelling.
    const path = searchCatalog(snapshot, { query: "MCP.NEWS.GETNEWS" });
    expect(path.matches[0].subject).toBe("get-news");
    expect(path.matches[0].path).toBe("mcp.news.getNews");

    // A canonical service identity matches all of its entries, kind-ordered.
    const service = searchCatalog(snapshot, { query: "news" });
    expect(service.matches.map((match) => match.kind).slice(0, 4)).toEqual(["tool", "tool", "resource", "resourceTemplate"]);
    expect(service.matches).toHaveLength(4);

    // Description is the last tier, so a description-only hit never outranks an identity hit.
    expect(searchCatalog(snapshot, { query: "headlines" }).matches.map((match) => match.subject)).toEqual(["get-news"]);
    expect(searchCatalog(snapshot, { query: "weather" }).matches.map((match) => match.subject)).toEqual(["forecast"]);
    // Non-fuzzy: a subsequence is not a match.
    expect(searchCatalog(snapshot, { query: "gNw" }).matches).toEqual([]);
    // An empty query matches nothing and says why, rather than matching everything.
    expect(searchCatalog(snapshot, { query: "   " })).toEqual({
      matches: [],
      incomplete: false,
      diagnostics: ["the query is empty after trimming"],
    });
  });

  it("carries canonical identity beside the TypeScript path and attaches the snapshot's caller-visible diagnostics to matching entries", () => {
    const diagnosticSnapshot = buildCatalogSnapshot({
      services: [{ ...NEWS, diagnostics: ["the tools family was unavailable"] }],
    });
    const found = searchCatalog(diagnosticSnapshot, { query: "get-news" });
    expect(found.matches[0]).toMatchObject({ service: "news", subject: "get-news", path: "mcp.news.getNews" });
    expect(found.matches[0].diagnostics).toContain("the tools family was unavailable");
    expect(found.diagnostics).toContain("the tools family was unavailable");
    expect(searchCatalog(snapshot, { query: "news" })).toEqual(searchCatalog(snapshot, { query: "news" }));
  });

  it("exposes `execute` only on the client surface, pointing each hub tool at the fixed declaration file of the surface searched", () => {
    expect(searchCatalog(snapshot, { query: "mcp.hub.execute" }).matches).toEqual([]);
    const client = searchCatalog(snapshot, { query: "mcp.hub.execute", surface: "client" });
    expect(client.matches[0]).toMatchObject({
      kind: "hubTool",
      surface: "client",
      service: "hub",
      subject: "execute",
      path: "mcp.hub.execute",
      uri: HUB_CLIENT_DECLARATION_URI,
    });
    expect(client.matches[0].signature).toBe("execute(input: HubExecuteInput): Promise<HubCallToolResult<HubExecutionResult>>");

    const program = searchCatalog(snapshot, { query: "search_types" });
    expect(program.matches[0]).toMatchObject({ kind: "hubTool", surface: "program", uri: HUB_PROGRAM_DECLARATION_URI });
    expect(program.matches[0].signature).toBe("searchTypes(input: HubSearchTypesInput): HubSearchResult");
    expect(searchCatalog(snapshot, { query: "search_types", surface: "client" }).matches[0].uri).toBe(HUB_CLIENT_DECLARATION_URI);
  });

  it("applies the caller limit (default 10, clamped to 50) and marks the result incomplete with a bounded diagnostic", () => {
    const wide = buildCatalogSnapshot({
      services: [{ appId: "app-aaa", service: "aaa", typescriptName: "aaa", kind: "tunnel", tools: many(60), resources: [], resourceTemplates: [] }],
    });
    const defaults = searchCatalog(wide, { query: "aaa" });
    expect(defaults.matches).toHaveLength(10);
    expect(defaults.incomplete).toBe(true);
    expect(defaults.diagnostics?.[0]).toContain("10");

    const clamped = searchCatalog(wide, { query: "aaa", limit: 999 });
    expect(clamped.matches).toHaveLength(50);
    expect(clamped.incomplete).toBe(true);
  });

  it("marks a truncated snapshot incomplete even when the query matches every entry it holds", () => {
    const aaa: CatalogServiceInput = { appId: "a", service: "aaa", typescriptName: "aaa", kind: "tunnel", tools: many(2), resources: [], resourceTemplates: [] };
    const zzz: CatalogServiceInput = {
      appId: "z",
      service: "zzz",
      typescriptName: "zzz",
      kind: "tunnel",
      tools: many(HUB_CATALOG_MAX_ENTRIES + 10),
      resources: [],
      resourceTemplates: [],
    };
    const result = searchCatalog(buildCatalogSnapshot({ services: [zzz, aaa] }), { query: "t00" });
    expect(result.matches.map((match) => match.subject)).toEqual(["t000", "t001"]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics?.some((diagnostic) => diagnostic.includes(String(HUB_CATALOG_MAX_ENTRIES)))).toBe(true);
  });

  it("bounds the ACTUAL serialized response: oversized signatures cut the ranked prefix and the result stays within §23.11's byte cap", () => {
    const bulky = buildCatalogSnapshot({ services: [bulkyService(6)] });
    const result = searchCatalog(bulky, { query: "mcp.bulky" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(6);
    expect(result.incomplete).toBe(true);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(HUB_SEARCH_RESPONSE_MAX_BYTES);
    expect(result.diagnostics?.some((diagnostic) => diagnostic.includes(String(HUB_SEARCH_RESPONSE_MAX_BYTES)))).toBe(true);
  });

  it("drops diagnostics that would exceed the response cap, marks the cut, and still serializes within the cap", () => {
    const flooded = buildCatalogSnapshot({
      services: [
        { ...NEWS, tools: [NEWS.tools[0]] },
        {
          appId: "app-noisy",
          service: "noisy",
          typescriptName: "noisy",
          kind: "tunnel",
          tools: [{ canonicalName: "quiet", typescriptName: "quiet" }],
          resources: [],
          resourceTemplates: [],
          diagnostics: Array.from({ length: 2000 }, (_value, index) => `note ${index} ${"y".repeat(200)}`),
        },
      ],
    });
    const result = searchCatalog(flooded, { query: "get-news" });
    expect(result.matches).toHaveLength(1);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(HUB_SEARCH_RESPONSE_MAX_BYTES);
    expect(result.diagnostics).toContain("additional diagnostics omitted");
  });
});

describe("§23.7 · snapshot to declaration", () => {
  it("compiles the program declaration built from a real snapshot — the builder's alias numbering and the renderer's are the same numbering", () => {
    const snapshot = buildCatalogSnapshot({
      services: [
        NEWS,
        {
          ...NEWS,
          appId: "app-linked",
          service: "linked",
          typescriptName: "linked",
          tools: [
            {
              canonicalName: "walk",
              typescriptName: "walk",
              inputSchema: { type: "object", properties: { next: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } },
            },
          ],
          resources: [],
          resourceTemplates: [],
        },
      ],
    });
    const program = renderProgramDeclaration(snapshot);
    const probe = [
      'const call = await mcp.news.getNews({ q: "x" });',
      'const read = await mcp.news.resources.read("news://feed/latest");',
      'const walk = await mcp.linked.walk({ next: {} });',
      'const search = mcp.hub.searchTypes({ query: "news" });',
      "export { call, read, walk, search };",
    ].join("\n");
    expect(compileDiagnostics({ "program.d.ts": program, "probe.ts": probe })).toEqual([]);
    expect(program).toContain("walk(input?: { \"next\"?: T0 })");
    expect(program).toContain('type T0 = { "child"?: T0 };');
  });
});
