// hub-catalog.ts — §23.5's caller-visible catalog snapshot and §23.2's ranked search, as
// one immutable pure value. The catalog collector (gateway/hub backend) maps raw backend
// families into `CatalogServiceInput`; this module applies the per-entry and whole-catalog
// caps, renders each schema exactly once (through hub-types, so declarations, signatures
// and the runtime proxy share one mapping), and hands back a snapshot that declarations,
// search and `execute` all read.
//
// WHAT THE SNAPSHOT IS. Canonical service order, canonical tool order, raw-URI order for
// resources: every ordering here is by canonical identity, never by discovery order, so two
// runs over the same catalog produce byte-identical snapshots. Entries whose mapping
// omitted them (`typescriptName: null`) stay in the snapshot for diagnostics but render no
// declaration, no signature and no match. Aliases are numbered with ONE running offset
// across the whole snapshot in that same order — the program declaration and a service's
// file concatenate entries, so two entries both starting at `T0` would emit two
// declarations of one name (hub-types' header states the rule).
//
// WHAT THE CAPS DO. §23.5's 256-entry/2 MiB catalog cap truncates at a SERVICE boundary:
// services are included whole or not at all, `truncated` turns on, and `overflow` carries
// the banner that makes declarations refuse to emit a partially callable API and `execute`
// refuse before Sandbox start. Per-entry caps never truncate an identity: an over-long
// subject drops its entry with a diagnostic, an over-long description is cut for search,
// and an over-limit schema renders `unknown` (with the bytes still counted).
//
// WHAT SEARCH DOES. Case-insensitive, non-fuzzy ranking over the snapshot only: exact
// TypeScript path/canonical identity, then prefix, then substring, then description
// substring; ties by kind, canonical service, then canonical subject. It starts no Sandbox,
// writes no audit row, and never fetches anything — and its result is bounded by the
// caller's limit and §23.11's serialized response cap, reporting `incomplete` whenever any
// limit cut the ranked list.
//
// PROJECT: `unit` and `worker`. Imports `./limits`, `./hub-contract` and `./hub-types` —
// all Node-clean, none reaching `cloudflare:workers`, gateway, admin, tunnel, or Sandbox.
//
// NOT HERE: which families a caller may see (registry's `resolveAccess().filterList`), the
// per-family 3 s fetch deadlines (the collector), and D1 rows of any kind.

import { HUB_TOOLS } from "./hub-contract";
import type { HubSearchMatch, HubSearchResult } from "./hub-contract";
import {
  HUB_CATALOG_MAX_BYTES,
  HUB_CATALOG_MAX_ENTRIES,
  HUB_DESCRIPTION_MAX_BYTES,
  HUB_SEARCH_LIMIT_DEFAULT,
  HUB_SEARCH_LIMIT_MAX,
  HUB_SEARCH_RESPONSE_MAX_BYTES,
  HUB_SUBJECT_MAX_BYTES,
} from "./limits";
import {
  HUB_TOOL_TYPESCRIPT_NAMES,
  RESOURCE_READ_SIGNATURE,
  RESOURCE_TEMPLATE_READ_SIGNATURE,
  catalogDeclarationUri,
  hubToolDeclarationUri,
  hubToolSignature,
  renderSchema,
  surfaceHubToolNames,
  toolSignature,
  truncateUtf8,
  utf8Bytes,
} from "./hub-types";
import type {
  CatalogSurface,
  DeclarationCatalog,
  DeclarationResource,
  DeclarationResourceTemplate,
  DeclarationService,
  DeclarationTool,
} from "./hub-types";

/** §23.5 — the kind of real application a service row came from; mirrors registry's
 *  `AppKind` without importing it (the builtin `pmcp` virtual service is `builtin`). */
export type CatalogServiceKind = "tunnel" | "proxy" | "builtin";

/** §23.5 — one raw tool as the collector read it, before bounding/rendering. */
export type CatalogToolInput = {
  /** Canonical upstream tool name; never rewritten. */
  readonly canonicalName: string;
  /** Resolved TypeScript name from the mapping, or `null` when the member was omitted. */
  readonly typescriptName: string | null;
  /** Bounded plain-text description for search; absent means none was served. */
  readonly description?: string;
  /** The tool's input schema, or absent when it declares none. */
  readonly inputSchema?: unknown;
  /** The tool's output schema, or absent when it declares none (output becomes `unknown`). */
  readonly outputSchema?: unknown;
};

/** §23.5 — one raw resource as the collector read it. Resources carry no schema and keep
 *  their raw URI; they are read through the structured API, never aliased. */
export type CatalogResourceInput = {
  /** Raw resource URI, exactly as the application serves it. */
  readonly uri: string;
  /** Bounded plain-text description for search. */
  readonly description?: string;
};

/** §23.5 — one raw resource template as the collector read it. */
export type CatalogResourceTemplateInput = {
  /** Raw resource-template URI, exactly as the application serves it. */
  readonly uriTemplate: string;
  /** Bounded plain-text description for search. */
  readonly description?: string;
};

/** §23.5 — one service's raw catalog plus the mapping's caller-visible diagnostics. */
export type CatalogServiceInput = {
  /** Immutable app id the snapshot pins alongside the slug. */
  readonly appId: string;
  /** Canonical slug (or the fixed `pmcp`). */
  readonly service: string;
  /** Resolved TypeScript service name, or `null` when the mapping omitted the service. */
  readonly typescriptName: string | null;
  /** Which application kind served it. */
  readonly kind: CatalogServiceKind;
  /** Raw tools, in any order — the snapshot orders them. */
  readonly tools: readonly CatalogToolInput[];
  /** Raw resources, in any order — the snapshot orders them by URI. */
  readonly resources: readonly CatalogResourceInput[];
  /** Raw resource templates, in any order — the snapshot orders them by URI. */
  readonly resourceTemplates: readonly CatalogResourceTemplateInput[];
  /** Caller-visible mapping diagnostics for this service (already filtered by visibility
   *  by the collector, which alone knows what the caller may see). */
  readonly diagnostics?: readonly string[];
};

/** §23.5 — everything the snapshot builder reads: the caller-visible services, unfiltered
 *  within each family (the collector passes the fetched canonical family, because alias
 *  allocation happens before caller filtering). */
export type CatalogSnapshotInput = {
  /** Caller-visible services, in any order. */
  readonly services: readonly CatalogServiceInput[];
};

/** §23.5 — one tool in the snapshot: its canonical identity, resolved TypeScript name,
 *  rendered types and the search face derived from them. */
export type CatalogTool = DeclarationTool & {
  /** Bounded description (search metadata only; never emitted into source). */
  readonly description: string;
  /** Rendered callable signature, derived from the same types the declaration uses. */
  readonly signature: string;
  /** Direct declaration resource URI, or `null` when a placeholder segment is not
   *  encodable (the entry is then dropped at build time). */
  readonly declarationUri: string;
  /** Bounded schema-render diagnostics for this entry. */
  readonly diagnostics: readonly string[];
  /** Raw schema bytes this entry contributed to the catalog cap. */
  readonly bytes: number;
};

/** §23.5 — one raw resource in the snapshot. */
export type CatalogResource = DeclarationResource & {
  /** Bounded description (search metadata only). */
  readonly description: string;
  /** Rendered signature: the structured read, whose identity is the raw URI. */
  readonly signature: string;
  /** Direct declaration resource URI. */
  readonly declarationUri: string;
  /** Bounded diagnostics for this entry (description truncation). */
  readonly diagnostics: readonly string[];
};

/** §23.5 — one raw resource template in the snapshot. */
export type CatalogResourceTemplate = DeclarationResourceTemplate & {
  /** Bounded description (search metadata only). */
  readonly description: string;
  /** Rendered signature: the structured read, which takes the concrete URI. */
  readonly signature: string;
  /** Direct declaration resource URI. */
  readonly declarationUri: string;
  /** Bounded diagnostics for this entry (description truncation). */
  readonly diagnostics: readonly string[];
};

/** §23.5 — one service in the snapshot: canonical identity, resolved TypeScript name, and
 *  its bounded/rendered entries. */
export type CatalogService = Omit<
  DeclarationService,
  "tools" | "resources" | "resourceTemplates"
> & {
  /** Immutable app id. */
  readonly appId: string;
  /** Which application kind served it. */
  readonly kind: CatalogServiceKind;
  /** Fully rendered tools, not only the declaration renderer's subset. */
  readonly tools: readonly CatalogTool[];
  /** Fully rendered resources, including search metadata. */
  readonly resources: readonly CatalogResource[];
  /** Fully rendered resource templates, including search metadata. */
  readonly resourceTemplates: readonly CatalogResourceTemplate[];
  /** Caller-visible mapping diagnostics for this service. */
  readonly diagnostics: readonly string[];
};

/** §23.5 — the immutable caller-visible catalog. Structurally a `DeclarationCatalog`, so
 *  the declaration renderers take it directly, while its service entries retain the richer
 *  search and execution metadata derived by this module. */
export type CatalogSnapshot = Omit<DeclarationCatalog, "services"> & {
  /** The fully rendered caller-visible services in canonical order. */
  readonly services: readonly CatalogService[];
  /** Caller-visible collector diagnostics (families omitted, per-service notes). */
  readonly diagnostics: readonly string[];
  /** Entries included (tools + resources + templates); omitted-mapping entries included. */
  readonly entryCount: number;
  /** Raw schema/catalog bytes included: every retained subject, its bounded description and
   *  the raw schema bytes, plus each service's canonical slug (§23.5's 2 MiB measure). */
  readonly bytes: number;
  /** True when a catalog cap cut the snapshot to a canonical prefix. */
  readonly truncated: boolean;
};

/** Canonical string order, the one comparison every ordering in this module uses. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deduplicated diagnostic list, preserving first-seen order. */
function mergeDiagnostics(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}

/** §23.5's description cap: search metadata is cut rather than dropped, and the cut is
 *  reported so a truncated index is never mistaken for the whole description. */
function boundedDescription(raw: string | undefined, sink: string[]): string {
  const bounded = truncateUtf8(raw ?? "", HUB_DESCRIPTION_MAX_BYTES);
  if (bounded.truncated) {
    sink.push(`a description exceeds ${HUB_DESCRIPTION_MAX_BYTES} bytes and was truncated for search`);
  }
  return bounded.text;
}

/**
 * §23.5 — builds the immutable caller-visible snapshot: orders services and entries
 * canonically, bounds subjects/descriptions/schemas, renders each schema once, derives each
 * signature and declaration URI, and applies the entry/byte caps at service boundaries.
 * Pure and total: an entry that cannot be represented (an over-long or unencodable
 * subject) is dropped with a diagnostic, and a catalog that overflows a cap is truncated to
 * a canonical prefix with `truncated` set.
 */
export function buildCatalogSnapshot(input: CatalogSnapshotInput): CatalogSnapshot {
  const services = [...input.services].sort((left, right) => compare(left.service, right.service));
  const diagnostics: string[] = [];
  const built: CatalogService[] = [];
  let entryCount = 0;
  let bytes = 0;
  let truncated = false;
  let overflow: string | null = null;
  let aliasOffset = 0;

  const buildTool = (service: CatalogServiceInput, tool: CatalogToolInput, sink: string[]): CatalogTool | null => {
    if (utf8Bytes(tool.canonicalName) > HUB_SUBJECT_MAX_BYTES) {
      sink.push(`a tool subject exceeds ${HUB_SUBJECT_MAX_BYTES} bytes and was omitted`);
      return null;
    }
    const declarationUri = catalogDeclarationUri("tool", service.service, tool.canonicalName);
    if (declarationUri === null) {
      sink.push("a tool subject cannot be encoded into a declaration URI and was omitted");
      return null;
    }
    const inputSchema = tool.inputSchema === undefined ? null : renderSchema(tool.inputSchema, { aliasOffset });
    if (inputSchema !== null) aliasOffset += inputSchema.declarations.length;
    const outputSchema = tool.outputSchema === undefined ? null : renderSchema(tool.outputSchema, { aliasOffset });
    if (outputSchema !== null) aliasOffset += outputSchema.declarations.length;
    const entry: CatalogTool = {
      canonicalName: tool.canonicalName,
      typescriptName: tool.typescriptName,
      description: boundedDescription(tool.description, sink),
      inputType: inputSchema?.type ?? null,
      inputDeclarations: inputSchema?.declarations ?? [],
      inputRequired: inputSchema?.requiredMembers ?? false,
      outputType: outputSchema?.type ?? "unknown",
      outputDeclarations: outputSchema?.declarations ?? [],
      signature: "",
      declarationUri,
      diagnostics: mergeDiagnostics(inputSchema?.diagnostics ?? [], outputSchema?.diagnostics ?? []),
      bytes: (inputSchema?.bytes ?? 0) + (outputSchema?.bytes ?? 0),
    };
    return { ...entry, signature: toolSignature(entry) };
  };

  const buildResource = (
    service: CatalogServiceInput,
    resource: CatalogResourceInput,
    sink: string[],
  ): CatalogResource | null => {
    if (utf8Bytes(resource.uri) > HUB_SUBJECT_MAX_BYTES) {
      sink.push(`a resource subject exceeds ${HUB_SUBJECT_MAX_BYTES} bytes and was omitted`);
      return null;
    }
    const declarationUri = catalogDeclarationUri("resource", service.service, resource.uri);
    if (declarationUri === null) {
      sink.push("a resource URI cannot be encoded into a declaration URI and was omitted");
      return null;
    }
    return {
      uri: resource.uri,
      description: boundedDescription(resource.description, sink),
      signature: RESOURCE_READ_SIGNATURE,
      declarationUri,
      diagnostics: [],
    };
  };

  const buildResourceTemplate = (
    service: CatalogServiceInput,
    template: CatalogResourceTemplateInput,
    sink: string[],
  ): CatalogResourceTemplate | null => {
    if (utf8Bytes(template.uriTemplate) > HUB_SUBJECT_MAX_BYTES) {
      sink.push(`a resource-template subject exceeds ${HUB_SUBJECT_MAX_BYTES} bytes and was omitted`);
      return null;
    }
    const declarationUri = catalogDeclarationUri("resourceTemplate", service.service, template.uriTemplate);
    if (declarationUri === null) {
      sink.push("a resource-template URI cannot be encoded into a declaration URI and was omitted");
      return null;
    }
    return {
      uriTemplate: template.uriTemplate,
      description: boundedDescription(template.description, sink),
      signature: RESOURCE_TEMPLATE_READ_SIGNATURE,
      declarationUri,
      diagnostics: [],
    };
  };

  for (const service of services) {
    const sink = mergeDiagnostics(service.diagnostics ?? []);
    const tools = [...service.tools]
      .sort((left, right) => compare(left.canonicalName, right.canonicalName))
      .flatMap((tool) => {
        const entry = buildTool(service, tool, sink);
        return entry === null ? [] : [entry];
      });
    const resources = [...service.resources]
      .sort((left, right) => compare(left.uri, right.uri))
      .flatMap((resource) => {
        const entry = buildResource(service, resource, sink);
        return entry === null ? [] : [entry];
      });
    const resourceTemplates = [...service.resourceTemplates]
      .sort((left, right) => compare(left.uriTemplate, right.uriTemplate))
      .flatMap((template) => {
        const entry = buildResourceTemplate(service, template, sink);
        return entry === null ? [] : [entry];
      });

    const serviceEntries = tools.length + resources.length + resourceTemplates.length;
    // §23.5's "raw schema/catalog bytes": every retained subject, its bounded description,
    // and the raw schema bytes the renderer measured — for every family, not just tools —
    // plus the service's own canonical slug.
    const serviceBytes =
      utf8Bytes(service.service) +
      tools.reduce((total, tool) => total + utf8Bytes(tool.canonicalName) + utf8Bytes(tool.description) + tool.bytes, 0) +
      resources.reduce((total, resource) => total + utf8Bytes(resource.uri) + utf8Bytes(resource.description), 0) +
      resourceTemplates.reduce(
        (total, template) => total + utf8Bytes(template.uriTemplate) + utf8Bytes(template.description),
        0,
      );
    if (entryCount + serviceEntries > HUB_CATALOG_MAX_ENTRIES || bytes + serviceBytes > HUB_CATALOG_MAX_BYTES) {
      truncated = true;
      overflow = `the catalog exceeds ${HUB_CATALOG_MAX_ENTRIES} entries or ${HUB_CATALOG_MAX_BYTES} bytes; later services were omitted`;
      break;
    }
    entryCount += serviceEntries;
    bytes += serviceBytes;
    built.push({
      appId: service.appId,
      service: service.service,
      typescriptName: service.typescriptName,
      kind: service.kind,
      tools,
      resources,
      resourceTemplates,
      diagnostics: sink,
    });
    diagnostics.push(...sink);
  }

  return { services: built, diagnostics, entryCount, bytes, truncated, overflow };
}

/** §23.2 — the `search_types` request as the pure function takes it, already shape-validated
 *  by the gateway (query non-empty after trimming, limit within 1–50). */
export type CatalogSearchRequest = {
  /** Raw query text; the search trims and lowercases it. */
  readonly query: string;
  /** Declaration context; defaults to `program` (§23.2). */
  readonly surface?: CatalogSurface;
  /** Maximum matches; defaults to 10 and is clamped to 1–50. */
  readonly limit?: number;
};

/** One rankable candidate: the wire match plus the lowercased haystacks it is ranked on. */
type Candidate = {
  readonly match: HubSearchMatch;
  /** Lowercased TypeScript path, canonical service and canonical subject. */
  readonly haystack: readonly string[];
  /** Lowercased bounded description, the tier-3 haystack. */
  readonly description: string;
};

/** §23.2's tie order: kind, then canonical service, then canonical subject. */
const KIND_ORDER: Readonly<Record<HubSearchMatch["kind"], number>> = {
  tool: 0,
  resource: 1,
  resourceTemplate: 2,
  hubTool: 3,
};

/** §23.2's ranking tiers, or `null` when the entry does not match at all. */
function tierOf(candidate: Candidate, query: string): number | null {
  if (candidate.haystack.some((value) => value === query)) return 0;
  if (candidate.haystack.some((value) => value.startsWith(query))) return 1;
  if (candidate.haystack.some((value) => value.includes(query))) return 2;
  if (candidate.description.includes(query)) return 3;
  return null;
}

/**
 * §23.2/§23.5 — the deterministic ranked search over one immutable snapshot. Case-
 * insensitive and non-fuzzy: exact path/canonical identity, then prefix, then substring,
 * then description substring, ties broken by kind, canonical service and canonical subject.
 * Applies the caller's limit (default 10, max 50), then §23.11's serialized response cap,
 * setting `incomplete` whenever any limit — including a truncated snapshot — cut the
 * ranked list, and reports the cut with a bounded diagnostic. Starts no Sandbox and
 * performs no I/O; an empty query returns an empty result with a diagnostic rather than
 * matching everything.
 */
export function searchCatalog(snapshot: CatalogSnapshot, request: CatalogSearchRequest): HubSearchResult {
  const query = request.query.trim().toLowerCase();
  const surface = request.surface ?? "program";
  const limit = Math.min(Math.max(request.limit ?? HUB_SEARCH_LIMIT_DEFAULT, 1), HUB_SEARCH_LIMIT_MAX);
  if (query.length === 0) {
    return { matches: [], incomplete: false, diagnostics: ["the query is empty after trimming"] };
  }

  const candidates: Candidate[] = [];
  for (const service of snapshot.services) {
    if (service.typescriptName === null) continue;
    const serviceHaystack = service.service.toLowerCase();
    const serviceDiagnostics = service.diagnostics;
    for (const tool of service.tools) {
      if (tool.typescriptName === null) continue;
      const path = `mcp.${service.typescriptName}.${tool.typescriptName}`;
      const entryDiagnostics = mergeDiagnostics(serviceDiagnostics, tool.diagnostics);
      candidates.push({
        match: {
          kind: "tool",
          surface,
          path,
          service: service.service,
          subject: tool.canonicalName,
          signature: tool.signature,
          uri: tool.declarationUri,
          ...(entryDiagnostics.length === 0 ? {} : { diagnostics: entryDiagnostics }),
        },
        haystack: [path.toLowerCase(), serviceHaystack, tool.canonicalName.toLowerCase()],
        description: tool.description.toLowerCase(),
      });
    }
    for (const resource of service.resources) {
      const path = `mcp.${service.typescriptName}.resources.read`;
      candidates.push({
        match: {
          kind: "resource",
          surface,
          path,
          service: service.service,
          subject: resource.uri,
          signature: resource.signature,
          uri: resource.declarationUri,
          ...(serviceDiagnostics.length === 0 ? {} : { diagnostics: serviceDiagnostics }),
        },
        haystack: [path.toLowerCase(), serviceHaystack, resource.uri.toLowerCase()],
        description: resource.description.toLowerCase(),
      });
    }
    for (const template of service.resourceTemplates) {
      const path = `mcp.${service.typescriptName}.resources.read`;
      candidates.push({
        match: {
          kind: "resourceTemplate",
          surface,
          path,
          service: service.service,
          subject: template.uriTemplate,
          signature: template.signature,
          uri: template.declarationUri,
          ...(serviceDiagnostics.length === 0 ? {} : { diagnostics: serviceDiagnostics }),
        },
        haystack: [path.toLowerCase(), serviceHaystack, template.uriTemplate.toLowerCase()],
        description: template.description.toLowerCase(),
      });
    }
  }
  for (const name of surfaceHubToolNames(surface)) {
    const tool = HUB_TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) continue;
    const typescriptName = HUB_TOOL_TYPESCRIPT_NAMES[name];
    const path = `mcp.hub.${typescriptName}`;
    candidates.push({
      match: {
        kind: "hubTool",
        surface,
        path,
        service: "hub",
        subject: name,
        signature: hubToolSignature(name),
        uri: hubToolDeclarationUri(surface),
      },
      haystack: [path.toLowerCase(), "hub", name.toLowerCase()],
      description: tool.description.toLowerCase(),
    });
  }

  const ranked = candidates
    .flatMap((candidate) => {
      const tier = tierOf(candidate, query);
      return tier === null ? [] : [{ candidate, tier }];
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        KIND_ORDER[left.candidate.match.kind] - KIND_ORDER[right.candidate.match.kind] ||
        compare(left.candidate.match.service, right.candidate.match.service) ||
        compare(left.candidate.match.subject, right.candidate.match.subject),
    );

  const notes: string[] = [];
  if (snapshot.overflow !== null) notes.push(snapshot.overflow);
  const limited = ranked.slice(0, limit);
  if (limited.length < ranked.length) notes.push(`more than ${limit} matches; the ranked prefix is returned`);

  // §23.11's response cap, measured on the ACTUAL serialization at every step and never on
  // a heuristic reserve: the result object is serialized with `incomplete: false`, the
  // longest possible value of that field, so a final `true` can only shrink the bytes. Each
  // candidate match, then each diagnostic, is kept only while the whole result still fits;
  // `incomplete` is exact at the end (it is true whenever anything was cut).
  const serialize = (chosenMatches: readonly HubSearchMatch[], chosenDiagnostics: readonly string[]): string =>
    JSON.stringify({
      matches: chosenMatches,
      incomplete: false,
      ...(chosenDiagnostics.length === 0 ? {} : { diagnostics: chosenDiagnostics }),
    });
  const fits = (chosenMatches: readonly HubSearchMatch[], chosenDiagnostics: readonly string[]): boolean =>
    utf8Bytes(serialize(chosenMatches, chosenDiagnostics)) <= HUB_SEARCH_RESPONSE_MAX_BYTES;

  const matches: HubSearchMatch[] = [];
  for (const entry of limited) {
    const next = [...matches, entry.candidate.match];
    if (!fits(next, [])) break;
    matches.push(entry.candidate.match);
  }
  const byteCut = matches.length < limited.length;
  if (byteCut) notes.push(`the serialized response cap ${HUB_SEARCH_RESPONSE_MAX_BYTES} bytes cut the ranked matches`);

  const allDiagnostics = mergeDiagnostics(notes, snapshot.diagnostics);
  const keptDiagnostics: string[] = [];
  for (const diagnostic of allDiagnostics) {
    const next = [...keptDiagnostics, diagnostic];
    if (!fits(matches, next)) break;
    keptDiagnostics.push(diagnostic);
  }
  if (keptDiagnostics.length < allDiagnostics.length) {
    // The cut is itself reported. Making room for that report may cost one note — the
    // marker is what keeps a bounded answer honest, so it outranks the last note.
    const marker = "additional diagnostics omitted";
    while (keptDiagnostics.length > 0 && !fits(matches, [...keptDiagnostics, marker])) keptDiagnostics.pop();
    if (fits(matches, [...keptDiagnostics, marker])) keptDiagnostics.push(marker);
  }

  const incomplete = snapshot.truncated || limited.length < ranked.length || byteCut;
  return keptDiagnostics.length === 0
    ? { matches, incomplete }
    : { matches, incomplete, diagnostics: keptDiagnostics };
}
