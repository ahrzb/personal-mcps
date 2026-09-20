// hub-contract.ts — §23's hub wire producers, extracted as one Node-clean pure module.
//
// PINS the values the hub endpoint serves and `contracts/hub.json` freezes:
//
// - HUB_TOOLS — the two tool descriptors (§23.1/§23.2). `name` is the canonical spelling
//   the scoped `/mcp/hub` endpoint serves; `aggregateName` is the fixed `hub_`-prefixed
//   spelling the aggregate endpoint serves. Input schemas are closed objects; the bounds
//   they can carry come from HUB_CONTRACT_LIMITS. `execute.code` carries the standard
//   `writeOnly: true` marker so §7's schema-declared redaction covers the source wherever
//   a hub body could be recorded. `execute`'s output schema is §23.11's bounded result
//   union discriminated by `kind` — four outcome variants, not a new error vocabulary.
// - HUB_DECLARATION_URIS — the two fixed declaration resources (§23.2), in served order.
// - HUB_DECLARATION_TEMPLATES — the four declaration templates (§23.2). Each brace
//   placeholder is exactly one canonical string segment in `encodeURIComponent` form; the
//   READER decodes once, re-encodes, and requires a byte-identical round trip, so an
//   encoded `/`, `%`, `{`, or `}` never becomes path structure.
// - HUB_CONTRACT_LIMITS — every numeric cap §23.11 states, in its order. Its home is
//   limits.ts, where one UPPER_SNAKE constant per cap is the runtime's name for it and the
//   grouped record is assembled from those values; this module re-exports both so the
//   producer surface stays whole. Schema keywords that can carry a bound reference the
//   record rather than repeating literals.
// - hubContractFixture() — the JSON snapshot `server/test/worker/contracts.test.ts` writes
//   to `contracts/hub.json`; that suite is the file's only writer.
//
// Canonical insertion order is part of the freeze: tools `execute` then `search_types`;
// resources client-before-program; templates services, tools, resources,
// resource-templates; limits in §23.11's own order. The fixture deep-copies through a JSON
// round trip, so what a producer case compares is exactly what is written to disk, and no
// caller can mutate these constants through the snapshot.
//
// The §23.1 handshake capability shape — `{tools:{listChanged:false},
// resources:{listChanged:false}}` — is NOT here: its one home is capabilities.ts's
// HUB_CAPABILITIES.
//
// PROJECT: `unit` and `worker` — plain data, milliseconds and bytes. Its only import is
// `./limits` (itself import-free) — in particular not `cloudflare:workers`, gateway,
// admin, or tunnel (a transitive `cloudflare:workers` import would kill the unit project's
// pool, capabilities.ts's rule): these shapes are source constants, not derived from a
// running app.
//
// NOT HERE: which endpoint serves which name (the hub backend), how the declaration
// renderer fills the template placeholders (hub-types.ts), and how execution enforces the
// limits (the QuickJS executor) — this file owns the wire VALUES alone.

import { HUB_CONTRACT_LIMITS } from "./limits";
import type { HubContractLimits } from "./limits";

// §23.11 puts the caps' names in limits.ts. Re-exported here so every consumer of this
// module's producer surface keeps importing from one place, while runtime callsites read
// the individual HUB_* constants from limits.ts directly.
export { HUB_CONTRACT_LIMITS };
export type { HubContractLimits };

/** §23.1 — the only two tool names either hub endpoint dispatches: `execute` typechecks
 *  and runs one TypeScript function body; `search_types` searches locally. */
export type HubToolName = "execute" | "search_types";

/**
 * §23.1/§23.2 — one hub tool descriptor, endpoint-shape-agnostic: the wire object minus the
 * one field an endpoint rewrites. `aggregateName` is derived, never configured — the
 * aggregate endpoint serves `hub_` + `name` and there is no other alias.
 */
export type HubTool = {
  /** Canonical name: what the scoped `/mcp/hub` endpoint lists, calls, and searches. */
  readonly name: HubToolName;
  /** Aggregate spelling: `hub_` + `name`, what `/mcp` lists and calls. */
  readonly aggregateName: `hub_${HubToolName}`;
  /** Bounded plain-text description served verbatim in `tools/list`. */
  readonly description: string;
  /** Closed JSON Schema for `tools/call` arguments (§23.2). The runtime adds the UTF-8
   *  source-size and dynamic-timeout checks a JSON Schema cannot express. */
  readonly inputSchema: Record<string, unknown>;
  /** JSON Schema for the `structuredContent` result: §23.11's bounded union for `execute`,
   *  the ranked match list for `search_types`. */
  readonly outputSchema: Record<string, unknown>;
};

/** One bounded compiler diagnostic. Locations refer to the submitted body, never the
 * synthetic wrapper or generated declaration files. */
export type HubExecutionDiagnostic = {
  /** Stable severity; only errors prevent execution. */
  readonly category: "error";
  /** TypeScript diagnostic code, or zero for an internal emit refusal. */
  readonly code: number;
  /** Bounded compiler message with no submitted source excerpt. */
  readonly message: string;
  /** One-based submitted-source line when the diagnostic belongs to the program body. */
  readonly line?: number;
  /** One-based submitted-source column when the diagnostic belongs to the program body. */
  readonly column?: number;
};

/**
 * §23.11 — the bounded `execute` result union, served as `structuredContent` and pinned by
 * `execute`'s `outputSchema`. Request-level failures stay -32602 and never appear here;
 * an over-max integer timeout carries only its field and effective maximum, while other
 * request failures remain payload-free.
 */
export type HubExecutionResult =
  | {
      /** Discriminant: the program returned a valid bounded JSON value. */
      readonly kind: "completed";
      /** The returned value: acyclic JSON only (null, booleans, strings, finite numbers,
       *  arrays, plain string-keyed objects), serialized under the result byte cap. */
      readonly value: unknown;
      /** Captured user stdout, live-return only, byte-capped, never logged or persisted. */
      readonly stdout: string;
      /** Captured user stderr, live-return only, byte-capped, never logged or persisted. */
      readonly stderr: string;
      /** True when stdout hit its byte cap and was cut. */
      readonly stdoutTruncated: boolean;
      /** True when stderr hit its byte cap and was cut. */
      readonly stderrTruncated: boolean;
      /** Inner operations that completed during the run. */
      readonly operations: {
        /** Completed inner `tools/call` operations. */
        readonly calls: number;
        /** Completed inner `resources/read` operations. */
        readonly reads: number;
      };
    }
  | {
      /** Discriminant: TypeScript syntax or semantic checking failed before evaluation. */
      readonly kind: "type_error";
      /** Bounded errors in compiler order. */
      readonly diagnostics: readonly HubExecutionDiagnostic[];
      /** Type errors are deterministic for the same source and catalog snapshot. */
      readonly transient: false;
      /** Type checking runs before QuickJS evaluation or any inner operation. */
      readonly mayHaveRun: false;
    }
  | {
      /** Discriminant: evaluation or an uncaught guest error failed after typechecking. */
      readonly kind: "runtime_error";
      /** Sanitized bounded failure class; never source, credentials, or raw runtime text. */
      readonly cause: string;
      /** Bounded guest exception message; empty only when the thrown value has none. */
      readonly message: string;
      /** Bounded guest stack with generated filename and locations but no source excerpt. */
      readonly stack: string;
      /** Captured user stdout, live-return only, byte-capped, never logged or persisted. */
      readonly stdout: string;
      /** Captured user stderr, live-return only, byte-capped, never logged or persisted. */
      readonly stderr: string;
      /** True when stdout hit its byte cap and was cut. */
      readonly stdoutTruncated: boolean;
      /** True when stderr hit its byte cap and was cut. */
      readonly stderrTruncated: boolean;
      /** Whether a retry could plausibly succeed. */
      readonly transient: boolean;
      /** Whether an inner operation could have dispatched before the failure. */
      readonly mayHaveRun: boolean;
    }
  | {
      /** Discriminant: a named limit stopped the execution. */
      readonly kind: "limit_exceeded";
      /** The violated limit's name (§23.11's caps). */
      readonly limit: string;
      /** The observed quantity in that limit's own unit — bytes, count, or milliseconds —
       *  never source text or a credential. */
      readonly observed: number;
      /** Whether a retry could plausibly succeed. */
      readonly transient: boolean;
      /** Whether an inner operation could have dispatched before the limit stopped the run. */
      readonly mayHaveRun: boolean;
    };

/** §23.2 — one ranked `search_types` match. Canonical identities (`service`, `subject`)
 *  sit beside the TypeScript path: the wire never makes one stand for the other. */
export type HubSearchMatch = {
  /** Which catalog family the match belongs to. */
  readonly kind: "tool" | "resource" | "resourceTemplate" | "hubTool";
  /** The declaration surface searched for this match. */
  readonly surface: "program" | "client";
  /** TypeScript path the match is callable/readable through, e.g. `mcp.news.search`. */
  readonly path: string;
  /** Canonical service name (`hub` for hub-owned tools); never a TypeScript alias. */
  readonly service: string;
  /** Canonical tool name, raw resource URI, or raw resource-template URI; never an alias. */
  readonly subject: string;
  /** Rendered TypeScript signature for the entry. */
  readonly signature: string;
  /** Direct declaration resource URI for this match (one of the four template forms). */
  readonly uri: string;
  /** Bounded mapping/catalog diagnostics attached to this match; present when any exist. */
  readonly diagnostics?: readonly string[];
};

/** §23.5/§23.2 — the `search_types` result: ranked matches plus bounded diagnostics.
 * Search reads the immutable snapshot locally and starts no execution runtime. */
export type HubSearchResult = {
  /** Ranked matches: exact path/identity, then prefix, then substring, then description
   *  substring; ties by kind, then canonical service, then canonical subject. */
  readonly matches: readonly HubSearchMatch[];
  /** True when the caller's `limit`, the catalog cap, or the response byte cap cut the
   *  ranked list to its canonical prefix; the missing tail is never guessed at. */
  readonly incomplete: boolean;
  /** Bounded limit/catalog diagnostics; present when any exist. */
  readonly diagnostics?: readonly string[];
};

/** §23.2 — one hub-owned declaration resource, as served by `resources/list`. */
export type HubDeclarationResource = {
  /** Absolute `pmcp://hub/...` URI; `resources/read` matches it exactly, never by prefix. */
  readonly uri: string;
  /** Short display name. */
  readonly name: string;
  /** Bounded plain-text description served verbatim. */
  readonly description: string;
  /** Media type of the single UTF-8 text block each read returns. */
  readonly mimeType: "text/typescript";
};

/** §23.2 — one hub-owned declaration template, as served by `resources/templates/list`. */
export type HubDeclarationTemplate = {
  /** Template whose braces are the placeholders described below; nothing else in it is
   *  variadic. */
  readonly uriTemplate: string;
  /** Short display name. */
  readonly name: string;
  /** Bounded plain-text description; states the one-`encodeURIComponent`-segment rule. */
  readonly description: string;
  /** Media type of the single UTF-8 text block each read returns. */
  readonly mimeType: "text/typescript";
};

/** §23.2 — `execute` arguments: a closed object, so an unknown member is a shape failure
 *  rather than an ignored one. `code` is required and `writeOnly`-marked (the source is the
 *  most sensitive body the hub ever receives); a source over the byte cap and a
 *  `timeout_ms` over the owner's configured maximum are both refused -32602, never clamped. */
const EXECUTE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    code: {
      type: "string",
      writeOnly: true,
      description:
        "The body of one async TypeScript function with top-level await and return. It is checked against the caller-visible declaration before QuickJS starts. At most 64 KiB after UTF-8 encoding; a shape or source-size failure is -32602.",
    },
    timeout_ms: {
      type: "integer",
      minimum: HUB_CONTRACT_LIMITS.minTimeoutMs,
      maximum: HUB_CONTRACT_LIMITS.hardMaxTimeoutMs,
      description:
        "Whole-call wall clock in milliseconds: at least 1,000, never above the compiled 300,000 ceiling, and never above the owner's configured maximum. A request over the configured maximum is refused -32602; it is never clamped.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

/** §23.2 — `search_types` arguments: a closed object whose `query` is non-empty after
 * trimming and bounded in UTF-8 bytes before trimming; `surface` and `limit` default
 * rather than being inferred. Search starts no runtime, so nothing here is a source cap. */
const SEARCH_TYPES_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: HUB_CONTRACT_LIMITS.queryMaxBytes,
      description:
        "Case-insensitive, non-fuzzy search text: non-empty after trimming and at most 256 UTF-8 bytes before trimming. The `maxLength` keyword counts UTF-16 code units; the byte cap is enforced on the bytes.",
    },
    surface: {
      type: "string",
      enum: ["program", "client"],
      default: "program",
      description: "Which declaration surface to search; defaults to `program`.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: HUB_CONTRACT_LIMITS.searchLimitMax,
      default: HUB_CONTRACT_LIMITS.searchLimitDefault,
      description: "Maximum matches to return; defaults to 10.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/** §23.11 — `execute`'s structured result: the four-variant union, discriminated by
 *  `kind`. Failure fields are present on every failure variant rather than inferred from
 *  absence, which is what makes "never replayed" machine-checkable. */
const EXECUTE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "The bounded execute result, discriminated by `kind`. Request failures are -32602 and never appear here; an over-max integer timeout returns data.field and data.max.",
  oneOf: [
    {
      type: "object",
      description: "The program returned a valid bounded JSON value.",
      properties: {
        kind: { const: "completed" },
        value: {
          description:
            "The program return value: acyclic JSON (null, booleans, strings, finite numbers, arrays, plain string-keyed objects) under the result byte cap.",
        },
        stdout: {
          type: "string",
          description: "Captured user stdout, live-return only and byte-capped; never logged or persisted.",
        },
        stderr: {
          type: "string",
          description: "Captured user stderr, live-return only and byte-capped; never logged or persisted.",
        },
        stdoutTruncated: { type: "boolean", description: "True when stdout hit its byte cap and was cut." },
        stderrTruncated: { type: "boolean", description: "True when stderr hit its byte cap and was cut." },
        operations: {
          type: "object",
          description: "Inner operations that completed during the run.",
          properties: {
            calls: { type: "integer", minimum: 0, description: "Completed inner tools/call operations." },
            reads: { type: "integer", minimum: 0, description: "Completed inner resources/read operations." },
          },
          required: ["calls", "reads"],
          additionalProperties: false,
        },
      },
      required: ["kind", "value", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "operations"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "TypeScript syntax or semantic checking failed before evaluation.",
      properties: {
        kind: { const: "type_error" },
        diagnostics: {
          type: "array",
          maxItems: HUB_CONTRACT_LIMITS.diagnosticMax,
          items: {
            type: "object",
            properties: {
              category: { const: "error" },
              code: { type: "integer", minimum: 0 },
              message: {
                type: "string",
                description: "Bounded compiler message with no submitted source excerpt.",
              },
              line: { type: "integer", minimum: 1 },
              column: { type: "integer", minimum: 1 },
            },
            required: ["category", "code", "message"],
            additionalProperties: false,
          },
        },
        transient: { const: false },
        mayHaveRun: { const: false },
      },
      required: ["kind", "diagnostics", "transient", "mayHaveRun"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "The program failed during compilation or evaluation; the failure is never replayed.",
      properties: {
        kind: { const: "runtime_error" },
        cause: {
          type: "string",
          description: "Sanitized bounded failure class; never source, credentials, or raw runtime text.",
        },
        message: {
          type: "string",
          description: "Bounded guest exception message; empty only when the thrown value has none.",
        },
        stack: {
          type: "string",
          description: "Bounded guest stack with generated filename and locations but no source excerpt.",
        },
        stdout: {
          type: "string",
          description: "Captured user stdout, live-return only and byte-capped; never logged or persisted.",
        },
        stderr: {
          type: "string",
          description: "Captured user stderr, live-return only and byte-capped; never logged or persisted.",
        },
        stdoutTruncated: { type: "boolean", description: "True when stdout hit its byte cap and was cut." },
        stderrTruncated: { type: "boolean", description: "True when stderr hit its byte cap and was cut." },
        transient: { type: "boolean", description: "Whether a retry could plausibly succeed." },
        mayHaveRun: {
          type: "boolean",
          description: "Whether an inner operation could have dispatched before the failure.",
        },
      },
      required: ["kind", "cause", "message", "stack", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "transient", "mayHaveRun"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "A named limit stopped the execution.",
      properties: {
        kind: { const: "limit_exceeded" },
        limit: {
          type: "string",
          description:
            "The violated limit's name (§23.11's caps, e.g. `memory`, `stack`, `cpu`, `wall_clock`, `inner_operations`).",
        },
        observed: {
          type: "integer",
          minimum: 0,
          description:
            "The observed quantity in that limit's own unit — bytes, count, or milliseconds; never source text or a credential.",
        },
        transient: {
          type: "boolean",
          description: "Whether a retry could plausibly succeed; deterministic guest limits are not transient.",
        },
        mayHaveRun: {
          type: "boolean",
          description: "Whether an inner operation could have dispatched before the limit stopped the run.",
        },
      },
      required: ["kind", "limit", "observed", "transient", "mayHaveRun"],
      additionalProperties: false,
    },
  ],
};

/** §23.2/§23.5 — `search_types`' structured result: ranked matches plus bounded
 *  diagnostics, with `incomplete` naming a canonical-prefix truncation rather than a
 *  silently shortened list. */
const SEARCH_TYPES_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      description:
        "Ranked matches: exact TypeScript path/canonical identity, then prefix, then substring, then description substring; ties by kind, canonical service, then canonical subject.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["tool", "resource", "resourceTemplate", "hubTool"] },
          surface: { type: "string", enum: ["program", "client"] },
          path: { type: "string", description: "TypeScript path the entry is reachable through." },
          service: { type: "string", description: "Canonical service name; never a TypeScript alias." },
          subject: {
            type: "string",
            description: "Canonical tool name, raw resource URI, or raw resource-template URI; never an alias.",
          },
          signature: { type: "string", description: "Rendered TypeScript signature for the entry." },
          uri: { type: "string", description: "Direct declaration resource URI for this match." },
          diagnostics: {
            type: "array",
            items: { type: "string" },
            description: "Bounded mapping/catalog diagnostics attached to this match.",
          },
        },
        required: ["kind", "surface", "path", "service", "subject", "signature", "uri"],
        additionalProperties: false,
      },
    },
    incomplete: {
      type: "boolean",
      description:
        "True when a limit cut the ranked list to its canonical prefix; the missing tail is never guessed at.",
    },
    diagnostics: {
      type: "array",
      items: { type: "string" },
      description: "Bounded limit/catalog diagnostics.",
    },
  },
  required: ["matches", "incomplete"],
  additionalProperties: false,
};

/** §23.1/§23.2 — the hub's two tool descriptors, canonical order. The scoped endpoint
 *  serves `name`, the aggregate endpoint serves `aggregateName`; nothing else is dispatched
 *  on either shape, and an unknown or malformed name is the existing indistinguishable
 *  -32001. */
export const HUB_TOOLS: readonly HubTool[] = [
  {
    name: "execute",
    aggregateName: "hub_execute",
    description:
      "Typecheck and run one async TypeScript function body in a fresh QuickJS runtime. Completed operations may already have effects and are never replayed.",
    inputSchema: EXECUTE_INPUT_SCHEMA,
    outputSchema: EXECUTE_OUTPUT_SCHEMA,
  },
  {
    name: "search_types",
    aggregateName: "hub_search_types",
    description:
      "Search this credential's hub TypeScript declarations and canonical catalog. Case-insensitive, non-fuzzy, ranked; starts no execution runtime.",
    inputSchema: SEARCH_TYPES_INPUT_SCHEMA,
    outputSchema: SEARCH_TYPES_OUTPUT_SCHEMA,
  },
];

/** §23.2 — the hub's two fixed declaration resources, in served order. Each read returns
 *  one UTF-8 text block; hub declaration reads audit only the sanitized URI, never text. */
export const HUB_DECLARATION_URIS: readonly HubDeclarationResource[] = [
  {
    uri: "pmcp://hub/types/client.d.ts",
    name: "client.d.ts",
    description:
      "The external hub facade declarations: mcp.hub.execute and mcp.hub.searchTypes. A declaration surface only; never loaded into the program checker.",
    mimeType: "text/typescript",
  },
  {
    uri: "pmcp://hub/types/program.d.ts",
    name: "program.d.ts",
    description:
      "The program global mcp declarations: authorized canonical service tools, structured resource reads, and the local searchTypes helper. Deliberately no mcp.hub.execute.",
    mimeType: "text/typescript",
  },
];

/** §23.2 — the hub's four declaration templates, in served order. Placeholder values are
 *  never decoded into path structure: exact `encodeURIComponent` form, one decode, and a
 *  byte-identical re-encode are required before a snapshot record is matched. */
export const HUB_DECLARATION_TEMPLATES: readonly HubDeclarationTemplate[] = [
  {
    uriTemplate: "pmcp://hub/types/services/{service}.d.ts",
    name: "Service declarations",
    description:
      "TypeScript declarations for one canonical service. `{service}` is exactly one `encodeURIComponent`-encoded segment.",
    mimeType: "text/typescript",
  },
  {
    uriTemplate: "pmcp://hub/types/tools/{service}/{tool}.d.ts",
    name: "Tool declarations",
    description:
      "TypeScript declarations for one canonical tool within one canonical service. `{service}` and `{tool}` are each exactly one `encodeURIComponent`-encoded segment.",
    mimeType: "text/typescript",
  },
  {
    uriTemplate: "pmcp://hub/types/resources/{service}/{uri}.d.ts",
    name: "Resource declarations",
    description:
      "TypeScript declarations for one raw resource URI within one canonical service. `{uri}` is exactly one `encodeURIComponent`-encoded segment and never becomes path structure.",
    mimeType: "text/typescript",
  },
  {
    uriTemplate: "pmcp://hub/types/resource-templates/{service}/{uriTemplate}.d.ts",
    name: "Resource-template declarations",
    description:
      "TypeScript declarations for one raw resource-template URI within one canonical service. `{uriTemplate}` is exactly one `encodeURIComponent`-encoded segment and never becomes path structure.",
    mimeType: "text/typescript",
  },
];

/** The four frozen sections of the hub wire snapshot, in canonical insertion order. */
export type HubContractFixture = {
  /** §23.1/§23.2 — the two tool descriptors, `execute` then `search_types`. */
  readonly tools: readonly HubTool[];
  /** §23.2 — the two declaration resources, client-before-program. */
  readonly resources: readonly HubDeclarationResource[];
  /** §23.2 — the four declaration templates, services/tools/resources/resource-templates. */
  readonly resourceTemplates: readonly HubDeclarationTemplate[];
  /** §23.11 — every numeric cap, in the spec's order. */
  readonly limits: HubContractLimits;
};

/**
 * §23.2 — the hub wire contract as one fresh, JSON-safe snapshot: exactly what
 * `server/test/worker/contracts.test.ts` writes to `contracts/hub.json`, and the only
 * writer of that file. Each call deep-copies through a JSON round trip, so the returned
 * value shares nothing with the constants above (a consumer cannot mutate them through it)
 * and is provably serializable — undefined, cycles, and accessors cannot survive it.
 */
export function hubContractFixture(): HubContractFixture {
  const snapshot = {
    tools: HUB_TOOLS,
    resources: HUB_DECLARATION_URIS,
    resourceTemplates: HUB_DECLARATION_TEMPLATES,
    limits: HUB_CONTRACT_LIMITS,
  };
  return JSON.parse(JSON.stringify(snapshot)) as HubContractFixture;
}