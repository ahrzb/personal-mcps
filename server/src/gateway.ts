// gateway.ts — the consumer-facing MCP pipeline (§7): every /:user/mcp request enters
// and leaves through this module. It OWNS both endpoint shapes (POST /:user/mcp
// aggregated, POST /:user/mcp/:slug scoped) and their SDK wiring (createMcpHandler with
// a per-request low-level Server, legacy-stateless lane included — comment-level only,
// the SDK never appears in sibling modules); the aggregated `<slug>_<tool>` split; the
// pinned check order filter → archived → approval → availability; server/discover;
// `_meta` hygiene and client-metadata capture; and the ONE mapping from HubError to
// JSON-RPC wire errors. It HIDES the wire entirely: sibling modules throw HubError and
// never see a JSON-RPC error code, and backends never see an unfiltered tool name, an
// archived service, or an unapproved gated call.

import type { Principal } from "./identity";
import type { Service } from "./registry";
import type { Env } from "./index";

/**
 * A JSON-RPC 2.0 id as the hub accepts it on requests. `null` ids are never accepted
 * inbound; null appears only on responses to messages whose id was unrecoverable.
 */
export type JsonRpcId = string | number;

/**
 * One inbound JSON-RPC 2.0 message. An absent `id` marks a notification — the hub
 * processes it (or ignores it) but never answers. `params` is carried opaquely except
 * for the keys this module is contracted to touch: `name`, `arguments`, and `_meta`.
 */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * One outbound JSON-RPC 2.0 message. Exactly one of `result`/`error` is set; `id` is
 * null only when the request's own id could not be read. `error` shapes come solely
 * from the mapping table in this module (§7's five codes) — no other module writes one.
 */
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * An MCP tool descriptor as listed to consumers. `inputSchema` is the service's JSON
 * Schema passed through untouched — `writeOnly` markers survive so redaction (§7) can
 * derive from them, and on an input the keyword is standard usage. `outputSchema`
 * (present when the service declares one) is different: the hub co-opts `writeOnly`
 * there as its internal result-secret marker, so the listing paths below strip it
 * from every outputSchema before a consumer sees it (§7) — backends return the
 * catalog verbatim and never strip. On the aggregated endpoint `name` carries the
 * `<slug>_` prefix; on the scoped endpoint it never does.
 */
export type Tool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/**
 * Per-request caller context handed to every backend: the resolved principal, the
 * caller's granted role names on this service exactly as granted (`"all"` stays
 * literal, never expanded; owners get `["all"]`), and untrusted display-only client
 * metadata (128-char-truncated, §7). Informational downstream — every authorization
 * decision has already run in the pipeline before a backend sees this.
 */
export type BackendCtx = {
  principal: Principal;
  roles: string[];
  clientMeta?: { name?: string; version?: string; sessionId?: string };
};

/**
 * The seam behind which the three dispatch targets — tunnel (ServiceConnection DO),
 * upstream (proxied endpoint), admin (the builtin `pmcp` ops table) — are
 * interchangeable. Backends receive only already-authorized traffic and report every
 * failure as HubError; they never touch the wire mapping.
 */
export interface ServiceBackend {
  /**
   * The service's full tool catalog as this backend knows it (tunnel: the DO's cached
   * list, populated even while offline; upstream: fetched live; admin: the ops table).
   * Unfiltered — the gateway applies the caller's grant patterns and any prefixing.
   * Throws HubError -32000 when the catalog is unreachable (proxied upstream down or
   * needs-reconnect); the aggregated fan-out catches that per slug, the scoped list
   * surfaces it.
   */
  listTools(service: Service, ctx: BackendCtx): Promise<Tool[]>;
  /**
   * Forwards one fully authorized tools/call and relays the service's response
   * verbatim. `msg` arrives post-hygiene (prepareForward already ran). Transport and
   * HTTP-level failures become HubError -32000 with a generic message — an upstream's
   * status line, headers, and body are never echoed to the consumer (§7).
   */
  call(service: Service, msg: JsonRpcRequest, ctx: BackendCtx): Promise<JsonRpcResponse>;
  /**
   * The SCHEMA-declared sensitive paths for one tool, per direction (§7): `args`
   * from `writeOnly` in the cached inputSchema, `results` from `writeOnly` in the
   * cached outputSchema (tunnel walks both; upstream has no cache and answers empty;
   * admin marks its own — token_issue's key). The gateway unions each direction with
   * the matching config map (registry.redactPathsFor "args" / "results") before
   * anything is stored or shown — approval rows and audit bodies alike. Returns null
   * when no sound map can exist: the tool is unknown to this backend (absent from a
   * tunnel's cached catalog) OR its cached schema tripped
   * registry.validateSchemaIndirection at registration (unsupported indirection could
   * conceal a mark, §7). Either way the gateway answers -32001 — the same code as
   * not-permitted/unknown, so the refusal cannot be used to map grant patterns (§7) —
   * nothing downstream runs, and no body is ever recorded for such a tool (§15).
   */
  sensitivePaths(
    service: Service,
    tool: string,
  ): Promise<{ args: string[]; results: string[] } | null>;
}

/**
 * The hub's one error vocabulary. `code` is a code from the pinned table — -32000
 * service unavailable · -32001 tool not permitted / unknown (deliberately
 * indistinguishable, §7) · -32002 service archived · -32003 approval required, `data`
 * carrying { approvalId, approvalUrl, expiresAt } · -32601 method not found. Thrown
 * anywhere in the pipeline or backends; it reaches the wire only through this module's
 * mapping, so no sibling ever builds a JSON-RPC error object.
 */
export class HubError extends Error {
  code: number;
  data?: unknown;
  /** `message` must already respect log hygiene (§15): no secrets, no upstream bodies. */
  constructor(code: number, message: string, data?: unknown) {
    // deps: none
    super(message);
    throw new Error("unimplemented");
  }
}

/**
 * The consumer MCP surface as one mountable route group — mounted by the composition
 * root under /:user/mcp and /:user/mcp/:slug (typed unknown here; hono and the MCP SDK
 * exist only at implementation). Enforces §7 step 1 at the door: Bearer-only (cookies
 * never consulted, query-string tokens rejected), Content-Type application/json
 * required, an Origin header if present must equal the hub's origin (else 403); no
 * valid principal → 401 with WWW-Authenticate regardless of the username's existence,
 * a resolved principal on a foreign or missing namespace → 404. Answers
 * server/discover itself with hub capabilities, routes tools/list and tools/call into
 * the pipeline below, and everything else to -32601. The SDK's legacy-stateless lane
 * serves 2025-era clients from the same wiring.
 */
export function mcpRoutes(): unknown {
  // deps: hono · @modelcontextprotocol/server (createMcpHandler, Server) · identity.resolvePrincipal · splitAggregatedName · captureClientMeta · callTool · listScoped · listAggregated · toWire
  throw new Error("unimplemented");
}

/**
 * Splits an aggregated tool name at its first `_` (§7: slugs contain no underscore, so
 * the split is unambiguous). Returns null for a name with no `_` at all; the pipeline
 * maps both that and a slug matching no visible service to -32001 — indistinguishable
 * from not-permitted, so nothing about the namespace leaks.
 */
function splitAggregatedName(name: string): { slug: string; tool: string } | null {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The virtual Service row for the builtin `pmcp` admin service (§8): reserved slug, no
 * D1 row ever exists for it, never archived, logBodies fixed ON (§15 — the builtin's
 * schemas are the hub's own, so the tunneled default applies and token_issue's key is
 * masked by the uniform rule). Exists so the admin backend rides the
 * same pipeline as everything else; its `kind` field is set only to satisfy the type —
 * backend selection happens on the slug before kind is ever read.
 */
function virtualPmcpService(ownerId: string): Service {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Picks the backend for a resolved service: slug `pmcp` → the admin builtin, otherwise
 * `service.kind` selects tunnel or upstream. The only place backend identity exists.
 */
function selectBackend(service: Service): ServiceBackend {
  // deps: admin.adminBackend · tunnel.tunnelBackend · upstream.upstreamBackend
  throw new Error("unimplemented");
}

/**
 * Pre-claim availability probe for the approval path (§7, approval step 1): answers
 * "would dispatch reach the service right now?" with no side effects — tunnel: the DO
 * holds a live registered socket; upstream: not flagged needs-reconnect; admin: always
 * true. Runs between approvals.check and approvals.claim so an offline service never
 * consumes an approval. Best-effort: a probe that passes can still lose the race, and
 * a post-claim dispatch failure leaves the claim consumed by design.
 */
async function probeAvailability(env: Env, service: Service): Promise<boolean> {
  // deps: tunnel.status · upstream.connectionStatus
  throw new Error("unimplemented");
}

/**
 * Client-metadata capture (§7): copies clientInfo.name/version and a recognized vendor
 * session-id `_meta` key (a small in-code allowlist, Claude Code's key first), each
 * value truncated to 128 chars. Strictly untrusted display-and-audit data — never
 * parsed, never an authorization input. Unrecognized vendor `_meta` is not captured
 * here but still passes through to services untouched.
 */
function captureClientMeta(msg: JsonRpcRequest): BackendCtx["clientMeta"] {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * `_meta` hygiene on every forwarded tools/call (§7): deletes every consumer-supplied
 * `hub/*` key, then sets `hub/principal` and `hub/roles` — overwrite, never merge, so
 * any `hub/*` value a service sees was written by the hub — and mirrors the consumer's
 * `io.modelcontextprotocol/clientCapabilities` (`{}` when the consumer declared none,
 * so services refrain from elicitation/sampling for legacy callers). Everything else —
 * progressToken, vendor keys, MRTR inputResponses/requestState — passes untouched.
 * Pure: returns a new message, never mutates the input.
 */
function prepareForward(msg: JsonRpcRequest, ctx: BackendCtx): JsonRpcRequest {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Scoped tools/list (§7): the backend's catalog filtered by the caller's grant
 * patterns, names unprefixed, with ttlMs/cacheScope hints — and every outputSchema
 * served with its `writeOnly` markers stripped (the hub's internal result-secret
 * co-opt never reaches the wire, §7). Archived → -32002; an
 * unreachable or needs-reconnect proxied upstream → -32000 — the scoped endpoint is
 * where the aggregate's silent omissions surface. Never audited (§15).
 */
async function listScoped(env: Env, ownerId: string, slug: string, ctx: BackendCtx): Promise<Tool[]> {
  // deps: registry.getService · registry.resolveAccess · selectBackend · virtualPmcpService
  throw new Error("unimplemented");
}

/**
 * Aggregated tools/list fan-out (§7): every service the caller can see (owner: all
 * non-archived, including `pmcp`; service account: services holding ≥1 grant, never
 * `pmcp`), queried in parallel under a 10 s per-upstream deadline, names prefixed
 * `<slug>_`. A failing or hanging upstream contributes zero tools and its slug is
 * returned in `unavailable` — surfaced to the consumer as `_meta["pmcp/unavailable"]`
 * and logged as an ops event, never an audit row — while the aggregate itself always
 * succeeds. Served outputSchemas get the same `writeOnly` strip as the scoped list
 * (§7). Tunneled lists come from DO cache and cannot miss the deadline.
 */
async function listAggregated(env: Env, ownerId: string, ctx: BackendCtx): Promise<{ tools: Tool[]; unavailable: string[] }> {
  // deps: registry.listServicesFor · registry.resolveAccess · selectBackend · virtualPmcpService
  throw new Error("unimplemented");
}

/**
 * The one tools/call pipeline, identical for both endpoint shapes — `slug` and `tool`
 * arrive already split and unprefixed, so approvals bind to the same row either way.
 * Runs the pinned order: filter (-32001 — an ungranted account learns nothing more),
 * archived (-32002), the approval gate (which consults probeAvailability FIRST: a
 * known-unavailable service fails -32000 before any approval row is read, created, or
 * consumed — no pending, no push, an existing pass untouched; then the three phases:
 * approvals.check, the atomic claim, dispatch, settle — `-32003` with
 * { approvalId, approvalUrl, expiresAt } when a decision is still owed, and an MRTR
 * input_required leg restores the claim), then availability (-32000). A passing call
 * is forwarded post-hygiene with identity attached and relayed verbatim — what the
 * CONSUMER receives is never redacted; masking exists for persistence only.
 * audit.record
 * is AWAITED with hub-measured duration — a failed audit write fails the call. When
 * the service's log_bodies is on AND the call was dispatched (§15 — refusal rows
 * never carry bodies; several refusals predate any redaction map), the audit entry
 * carries the bodies: args
 * masked under the args union (backend schema paths + config redact), the result's
 * structuredContent masked under the results union (backend + config
 * redact_results), each unstructured result block replaced by a blob BodyStub —
 * audit.record itself enforces the size cap. All
 * failures leave as HubError; only the caller of this seam maps them to the wire.
 */
async function callTool(env: Env, ownerId: string, slug: string, tool: string, msg: JsonRpcRequest, ctx: BackendCtx): Promise<JsonRpcResponse> {
  // deps: registry.getService · registry.resolveAccess · registry.redactPathsFor · registry.applyRedaction · approvals.check · approvals.claim · approvals.settle · audit.record · selectBackend · virtualPmcpService · probeAvailability · prepareForward
  throw new Error("unimplemented");
}

/**
 * The ONE error-to-wire mapping (§7, §15): a HubError's code/message/data go out
 * as-is; anything else becomes a generic internal error with nothing of the cause
 * attached. Log hygiene is enforced here as the last line: no upstream bodies, token
 * material, or argument echoes ever leave through this function.
 */
function toWire(err: unknown, id: JsonRpcId | null): JsonRpcResponse {
  // deps: none
  throw new Error("unimplemented");
}
