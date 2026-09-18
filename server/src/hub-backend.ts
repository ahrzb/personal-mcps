// hub-backend.ts — §23's hub wire surface, as one module: the two tool descriptors each
// endpoint shape serves, the declaration resources and templates the hub publishes, the
// declaration READER (decode-once, re-encode, exact snapshot membership), the closed-object
// validation both hub tools need, the ranked `search_types` over an already-built snapshot,
// and the ONE seam the Sandbox execution plane plugs into.
//
// WHY THIS IS NOT gateway.ts. The gateway owns the consumer pipeline — the door's JSON-RPC
// half, the dispatch seams, the audit exit, the virtual app and its access filter, and the
// catalog COLLECTOR that turns live backends into a snapshot. This module owns the hub's own
// wire vocabulary and every decision that needs nothing but a snapshot: what the two tools
// look like on each shape, which declaration a URI names, what a `search_types`/`execute`
// argument object may contain, and what happens when no execution plane is installed. It
// imports gateway for TYPES alone (`import type`), so the runtime edge is one-way —
// gateway → hub-backend — exactly like admin/tunnel/upstream, and there is no cycle.
//
// WHAT IS NOT HERE: how the caller-visible snapshot is collected (gateway's
// collectHubCatalog: app selection, per-family deadlines, alias allocation, grant filtering,
// caps), what the outer `tools/call` row records (gateway's recordDispatch), and how a
// program actually runs (hub-sandbox.ts, which implements HubExecutor and is installed by
// the composition root). Nothing here reads D1, a DO, or `cloudflare:workers`.
//
// PROJECT: `unit` and `worker` — the runtime imports are hub-contract (the frozen wire
// constants), hub-catalog (the snapshot/search), hub-types (declaration renderers and the
// alias grammar), limits, and errors — every one of them Node-clean.

import {
  HUB_DECLARATION_TEMPLATES,
  HUB_DECLARATION_URIS,
  HUB_TOOLS,
} from "./hub-contract";
import type { HubExecutionResult, HubSearchResult, HubTool } from "./hub-contract";
import { searchCatalog } from "./hub-catalog";
import type { CatalogSnapshot } from "./hub-catalog";
import { invalidParams, unavailable } from "./errors";
import {
  HUB_HARD_MAX_TIMEOUT_MS,
  HUB_MIN_TIMEOUT_MS,
  HUB_QUERY_MAX_BYTES,
  HUB_SEARCH_LIMIT_DEFAULT,
  HUB_SEARCH_LIMIT_MAX,
  HUB_SOURCE_MAX_BYTES,
} from "./limits";
import {
  HUB_CLIENT_DECLARATION_URI,
  HUB_PROGRAM_DECLARATION_URI,
  renderClientDeclaration,
  renderProgramDeclaration,
  renderResourceDeclaration,
  renderResourceTemplateDeclaration,
  renderServiceDeclaration,
  renderToolDeclaration,
  utf8Bytes,
} from "./hub-types";
import type { CatalogSurface } from "./hub-types";
import type { BackendCtx, Resource, ResourceTemplate, Tool } from "./gateway";
import type { AuthenticatedCaller } from "./identity";
import type { HubExecutionSettings } from "./registry";

// ══ §23.1/§23.2 — the tools and the declaration resources each endpoint shape serves ═══
//
// The aggregate shape serves the `hub_`-prefixed names; the scoped `/mcp/hub` shape serves
// the canonical ones. Both lists come from the same frozen `HUB_TOOLS`/`HUB_DECLARATION_*`
// constants the contracts fixture pins, so the wire a consumer reads and the wire a fixture
// freezes cannot drift.

/** Which endpoint shape a hub answer is being produced for (§21.2's vocabulary, reused
 *  rather than respelled: an aggregate request has no slug, a scoped one does). */
export type HubEndpointShape = "aggregated" | "scoped";

/** §23.1 — the hub's two tool descriptors as the given shape lists them. The aggregate
 *  spelling is DERIVED (`hub_` + canonical name), never configured, and no third tool is
 *  ever listed on either shape. */
export function hubToolsFor(shape: HubEndpointShape): Tool[] {
  return HUB_TOOLS.map((tool) => ({
    name: shape === "aggregated" ? tool.aggregateName : tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));
}

/** §23.1 — the tool descriptor one shape dispatches `name` to, or null when the name is not
 *  one of the hub's two tools on this shape. Unknown and malformed names both land here, so
 *  the caller answers them the same indistinguishable -32001. */
export function hubToolFor(shape: HubEndpointShape, name: string): HubTool | null {
  return (
    HUB_TOOLS.find((tool) => (shape === "aggregated" ? tool.aggregateName : tool.name) === name) ?? null
  );
}

/** §23.1 — the hub's two fixed declaration resources, verbatim (each carries the
 *  `text/typescript` media type the reader answers with). */
export function hubResourceList(): Resource[] {
  return HUB_DECLARATION_URIS.map((resource) => ({ ...resource }));
}

/** §23.1 — the hub's four declaration templates, verbatim. */
export function hubResourceTemplates(): ResourceTemplate[] {
  return HUB_DECLARATION_TEMPLATES.map((template) => ({ ...template }));
}

// ══ §23.2 — the declaration reader ═════════════════════════════════════════════════════
//
// A hub declaration URI names exactly one snapshot record, and the resolution is the
// SECURITY boundary of the reader: every placeholder is one canonical `encodeURIComponent`
// segment, decoded exactly once and re-encoded to require a byte-identical round trip, so an
// encoded `/`, `%`, `{` or `}` never becomes path structure and a non-canonical spelling
// never matches. Nothing here fetches: the record comes from the caller's own immutable
// snapshot, which is why an unauthorized service or URI simply is not found.

/** The fixed prefix of every hub declaration URI — `catalogDeclarationUri` in hub-types
 *  writes it and `HUB_DECLARATION_TEMPLATES` spells it; a test pins the round trip. */
const DECLARATION_PREFIX = "pmcp://hub/types/";

/** Every declaration URI ends with this, after the encoded placeholder. */
const DECLARATION_SUFFIX = ".d.ts";

/** §23.2 — one hub declaration URI, resolved to the record it names. */
export type HubDeclarationRef =
  | { readonly kind: "client" }
  | { readonly kind: "program" }
  | { readonly kind: "service"; readonly service: string }
  | { readonly kind: "tool"; readonly service: string; readonly subject: string }
  | { readonly kind: "resource"; readonly service: string; readonly subject: string }
  | { readonly kind: "resourceTemplate"; readonly service: string; readonly subject: string };

/**
 * §23.2 — parses a declaration URI into the record it names, or null when it is not a hub
 * declaration URI at all (a fixed URI, a known family with a malformed or non-canonical
 * placeholder, or a path the hub never serves). Total: every input either resolves to a ref
 * or is refused, so the access filter and the reader cannot disagree about what a hub URI is.
 */
export function parseHubDeclarationUri(uri: string): HubDeclarationRef | null {
  if (uri === HUB_CLIENT_DECLARATION_URI) return { kind: "client" };
  if (uri === HUB_PROGRAM_DECLARATION_URI) return { kind: "program" };
  if (!uri.startsWith(DECLARATION_PREFIX)) return null;
  // The split happens BEFORE any decoding: a `%2F` inside a placeholder is one segment's
  // content, never a path separator, and a raw `/` in a placeholder therefore simply splits
  // it — which is how an encoded slash is told from a structural one.
  const parts = uri.slice(DECLARATION_PREFIX.length).split("/");
  if (parts.length === 2 && parts[0] === "services") {
    const service = placeholder(parts[1]);
    return service === null ? null : { kind: "service", service };
  }
  if (parts.length !== 3) return null;
  const service = placeholder(parts[1], false);
  const subject = placeholder(parts[2]);
  if (service === null || subject === null) return null;
  switch (parts[0]) {
    case "tools":
      return { kind: "tool", service, subject };
    case "resources":
      return { kind: "resource", service, subject };
    case "resource-templates":
      return { kind: "resourceTemplate", service, subject };
    default:
      return null;
  }
}

/**
 * One declaration placeholder segment: the final subject/service file segment carries
 * `.d.ts`, while an intermediate service segment does not. The payload is decoded EXACTLY
 * once and re-encoded to require byte-identical canonical form. Null for an empty or
 * non-canonical segment, or for a malformed `%` escape.
 */
function placeholder(segment: string, suffixed = true): string | null {
  if (suffixed && !segment.endsWith(DECLARATION_SUFFIX)) return null;
  const raw = suffixed ? segment.slice(0, -DECLARATION_SUFFIX.length) : segment;
  if (raw === "") return null;
  try {
    const decoded = decodeURIComponent(raw);
    return encodeURIComponent(decoded) === raw ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * §23.2 — the declaration text one hub URI names, from the caller's own immutable snapshot,
 * or null when the URI is not a hub declaration URI or names no record the caller can see
 * (an unknown service, an unaliased or filtered-out member, another namespace's URI). The
 * caller answers null with the existing indistinguishable -32001.
 *
 * `client.d.ts` and `program.d.ts` are the two fixed declarations; every other URI resolves
 * through the parsed ref against the snapshot, so a caller reads exactly the members their
 * own catalog contains and nothing else.
 */
export function hubDeclarationText(snapshot: CatalogSnapshot, uri: string): string | null {
  const ref = parseHubDeclarationUri(uri);
  if (ref === null) return null;
  switch (ref.kind) {
    case "client":
      return renderClientDeclaration();
    case "program":
      return renderProgramDeclaration(snapshot);
    case "service": {
      const service = snapshot.services.find((candidate) => candidate.service === ref.service);
      return service === undefined ? null : renderServiceDeclaration(service);
    }
    case "tool": {
      const tool = snapshot.services
        .find((candidate) => candidate.service === ref.service)
        ?.tools.find((candidate) => candidate.canonicalName === ref.subject);
      return tool === undefined ? null : renderToolDeclaration(tool);
    }
    case "resource": {
      const resource = snapshot.services
        .find((candidate) => candidate.service === ref.service)
        ?.resources.find((candidate) => candidate.uri === ref.subject);
      return resource === undefined ? null : renderResourceDeclaration(resource);
    }
    case "resourceTemplate": {
      const template = snapshot.services
        .find((candidate) => candidate.service === ref.service)
        ?.resourceTemplates.find((candidate) => candidate.uriTemplate === ref.subject);
      return template === undefined ? null : renderResourceTemplateDeclaration(template);
    }
  }
}

// ══ §23.2 — the two tools' argument validation ═════════════════════════════════════════
//
// Both arguments are CLOSED objects: a member the schema does not name is a shape failure
// rather than an ignored extra, and every failure here is the existing payload-free -32602
// (§23.2), never a structured result and never a distinct message that could distinguish
// two bad requests. The JSON Schema the wire lists carries the same bounds; these checks are
// the ones a schema cannot express — UTF-8 byte caps measured after encoding, an integer
// range against the OWNER's configured maximum, and a default that is not "the schema
// default" but the owner's stored setting.

/** One closed argument object, or the -32602 every shape failure answers. */
function closedArguments(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidParams();
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw invalidParams();
  }
  return args;
}

/** §23.2 — the `search_types` request, validated and defaulted. */
export type HubSearchRequest = {
  /** Query text, non-empty after trimming; at most HUB_QUERY_MAX_BYTES UTF-8 bytes before it. */
  readonly query: string;
  /** Declaration context, defaulting to the program surface. */
  readonly surface: CatalogSurface;
  /** Maximum matches, defaulting to HUB_SEARCH_LIMIT_DEFAULT. */
  readonly limit: number;
};

/** §23.2 — validates a `search_types` argument object. Throws the payload-free -32602 for a
 *  non-object, an unknown member, a missing/empty/over-long `query`, an unknown `surface`,
 *  or a `limit` outside 1–HUB_SEARCH_LIMIT_MAX (fractional values included). */
export function hubSearchRequest(raw: unknown): HubSearchRequest {
  const args = closedArguments(raw, ["query", "surface", "limit"]);
  const query = args.query;
  if (typeof query !== "string") throw invalidParams();
  if (utf8Bytes(query) > HUB_QUERY_MAX_BYTES) throw invalidParams();
  if (query.trim() === "") throw invalidParams();
  const surface = args.surface ?? "program";
  if (surface !== "program" && surface !== "client") throw invalidParams();
  const limit = args.limit ?? HUB_SEARCH_LIMIT_DEFAULT;
  if (typeof limit !== "number" || !Number.isInteger(limit)) throw invalidParams();
  if (limit < 1 || limit > HUB_SEARCH_LIMIT_MAX) throw invalidParams();
  return { query, surface, limit };
}

/** §23.2/§23.5 — the ranked search over one immutable snapshot: validation first, then the
 *  pure search. Starts no Sandbox, writes no audit row, and fetches nothing. */
export function hubSearchTypes(snapshot: CatalogSnapshot, raw: unknown): HubSearchResult {
  const request = hubSearchRequest(raw);
  return searchCatalog(snapshot, {
    query: request.query,
    surface: request.surface,
    limit: request.limit,
  });
}

/** §23.2 — the `execute` request, validated against the owner's settings. */
export type HubExecuteRequest = {
  /** The submitted TypeScript source; at most HUB_SOURCE_MAX_BYTES UTF-8 bytes. */
  readonly code: string;
  /** The resolved outer wall clock: the caller's `timeout_ms` or the owner's default. */
  readonly timeoutMs: number;
};

/**
 * §23.2 — validates an `execute` argument object against the owner's stored settings.
 * Throws the payload-free -32602 for a non-object, an unknown member, a missing or
 * non-string or over-long `code`, and for a `timeout_ms` that is not an integer in
 * 1_000–min(owner maximum, compiled ceiling). A requested timeout is NEVER clamped: over the
 * maximum is a refusal, not a silently shortened run.
 */
export function hubExecuteRequest(raw: unknown, settings: HubExecutionSettings): HubExecuteRequest {
  const args = closedArguments(raw, ["code", "timeout_ms"]);
  const code = args.code;
  if (typeof code !== "string") throw invalidParams();
  if (utf8Bytes(code) > HUB_SOURCE_MAX_BYTES) throw invalidParams();
  // The compiled ceiling bounds the owner's maximum even if a stored row somehow exceeded
  // it; the table's CHECK constraints make that unreachable, and a defense that cannot be
  // reached is still the right side to fail on.
  const max = Math.min(settings.maxTimeoutMs, HUB_HARD_MAX_TIMEOUT_MS);
  const timeoutMs = args.timeout_ms ?? settings.defaultTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) throw invalidParams();
  if (timeoutMs < HUB_MIN_TIMEOUT_MS || timeoutMs > max) throw invalidParams();
  return { code, timeoutMs };
}

// ══ §23.8/§23.10 — the execution seam ══════════════════════════════════════════════════
//
// The hub's `execute` is the ONE tool whose answer is not computed here: the run belongs to
// the Sandbox plane (a Durable Object class plus its container, `server/src/hub-sandbox.ts`),
// which this module must not import — a Worker entry that pulls the Sandbox SDK in through
// the gateway would pay for it on every request, and worker tests that never touch a
// container would need it bundled. So the dependency is INJECTED, exactly once, at the
// composition root: the seam is the `HubExecutor` function type below, and its absence is an
// honest -32000 rather than a fabricated result — there is no in-process fallback, no fake
// completed run, and nothing here that could be mistaken for one.

/**
 * §23.10 — the narrow request lifecycle the Sandbox plane needs and nothing more. `signal`
 * is the inbound request's own abort signal (the client-disconnect channel, live once
 * Wrangler's `enable_request_signal` is on; without it the signal simply never aborts);
 * `waitUntil` registers background cleanup with the invocation's ExecutionContext when the
 * runtime handed one in — absent when a caller (a test) invoked the worker directly, which
 * is a lifetime fact, not a failure.
 */
export type HubRequestLifecycle = {
  readonly signal: AbortSignal;
  readonly waitUntil?: (work: Promise<unknown>) => void;
};

/**
 * §23.8 — what one admitted execution hands the Sandbox plane. Everything here was decided
 * by the gateway before this point: the credential (keyed by `sandboxKey` and re-authorized
 * from `reference`), the resolved timeout and the settings it came from, and the immutable
 * snapshot the run's bridge operations resolve TypeScript names through. `code` is the
 * submitted source — the ONE field that never enters audit, a log, or a result.
 */
export type HubExecutionRequest = {
  /** The exact credential this execution is keyed to and re-authorized by. */
  readonly caller: AuthenticatedCaller;
  /** The owner whose settings and namespace this run belongs to. */
  readonly ownerId: string;
  /** The submitted TypeScript source, already bounded. */
  readonly code: string;
  /** The resolved outer wall clock in milliseconds, already validated against the maximum. */
  readonly timeoutMs: number;
  /** §23.8 — the ABSOLUTE epoch-ms instant the outer budget expires: the admission instant
   *  plus `timeoutMs`, which bounds the whole catalog/render/start/check/run/result/cleanup
   *  path. A later settings change never extends an admitted run (§23.3). */
  readonly deadlineAt: number;
  /** The owner settings the timeout was resolved from; changes govern new runs only. */
  readonly settings: HubExecutionSettings;
  /** The immutable caller-visible catalog/mapping this execution was admitted against. */
  readonly snapshot: CatalogSnapshot;
  /** Display-only client metadata for the outer audit row; never an authorization input. */
  readonly clientMeta?: BackendCtx["clientMeta"];
  /** The request lifecycle: disconnect cancellation and background cleanup. */
  readonly lifecycle: HubRequestLifecycle;
};

/** §23.8 — the Sandbox plane as this module sees it: one admitted execution in, §23.11's
 *  bounded result union out. Implemented by hub-sandbox.ts; never implemented here. */
export type HubExecutor = (request: HubExecutionRequest) => Promise<HubExecutionResult>;

/**
 * §23.4 — the executor's signal that the execution's credential no longer authorizes it
 * (revoked, expired, deleted, rebound, or a slug now resolving to another app): every bridge
 * operation and the pre-publication check raise it, and the caller discards the run's whole
 * value — result, diagnostics, stdout and stderr — answering the existing metadata-only
 * -32001 instead. Carries no data, so nothing of the credential or the run can ride out.
 */
export class HubCredentialRevokedError extends Error {
  constructor() {
    super("credential revoked");
    this.name = "HubCredentialRevokedError";
  }
}

/**
 * §23.10/§23.11 — the executor's signal that the inbound request was aborted (the consumer
 * disconnected): the run's process was terminated and its output discarded, no program
 * response is published, and nothing is replayed. Like the revocation signal it carries no
 * data — the caller still writes its one outer audit row and answers the wire normally,
 * because the disconnect already decided nobody is reading.
 */
export class HubExecutionAbortedError extends Error {
  constructor() {
    super("execution aborted");
    this.name = "HubExecutionAbortedError";
  }
}

/** The installed executor, or null while no execution plane is wired. Module state by
 *  necessity: the composition root wires it once and `mcpMessage`'s signature (the door's
 *  contract) has no channel for it. */
let executor: HubExecutor | null = null;

/** §23.8 — the composition root's ONE wiring point for the Sandbox plane. `null` unwires it
 *  (a test that wants the unwired refusal, or a deploy that must not run code at all). */
export function installHubExecutor(next: HubExecutor | null): void {
  executor = next;
}

/**
 * §23.11 — runs one admitted execution through the installed plane. With no executor
 * installed the hub refuses the -32000 it refuses everything with: the tool is listed and
 * honestly unavailable, never answered by a fabricated result. The failure class says
 * nothing dispatched (`errors.unavailable`'s own table), so the refusal carries no
 * at-most-once warning.
 */
export async function runHubExecution(request: HubExecutionRequest): Promise<HubExecutionResult> {
  if (executor === null) throw unavailable("execution_unavailable");
  return executor(request);
}
