// gateway.ts — the consumer-facing MCP pipeline (§7): every /:user/mcp message is answered
// by this module. It OWNS the JSON-RPC half of both endpoint shapes (POST /:user/mcp
// aggregated, POST /:user/mcp/:slug scoped) and their SDK wiring (createMcpHandler with
// a per-request low-level Server, legacy-stateless lane included — comment-level only,
// the SDK never appears in sibling modules); the aggregated `<slug>_<tool>` split; the
// pinned check order filter → archived → approval → availability (§7's list, with the
// availability-first decision folding its last two into one test — see callTool);
// server/discover; `_meta` hygiene and client-metadata capture; the ONE redaction map per
// call; and the ONE mapping from HubError to JSON-RPC wire errors. It HIDES the wire
// entirely: sibling modules throw the HubError vocabulary errors.ts owns and never see a
// JSON-RPC error code, and backends never see an unfiltered tool name, an archived
// service, or an unapproved gated call.
//
// What it does NOT own: §7 step 1's HTTP-level door. Content-Type, the Origin rule, the
// 401 with WWW-Authenticate, the scoped-visibility 404 and the resolution of the caller
// all belong to index.mcpEntry, which hands the resolved principal in. One resolution per
// request, and one place to change step 1.
//
// IMPLEMENTATION NOTE (2026-08-25): `@modelcontextprotocol/server` is not a dependency of
// this repo and "no new dependencies" is binding, so the SDK wiring named above is served
// by hand: the composition root routes the two shapes and the JSON-RPC envelope is read
// and written here. The seam is unchanged — the SDK still appears in no sibling module —
// and swapping createMcpHandler in later is an edit to `mcpMessage`/`route` alone.

import { adminBackend, BUILTIN_LOG_BODIES } from "./admin";
import { Approvals } from "./approvals";
import type { ApprovalClaim, CheckResult } from "./approvals";
import { config as auditConfig, record } from "./audit";
import type { BodyStub } from "./audit";
import { archived, CODES, HubError, notPermitted, unavailable } from "./errors";
import { formatPrincipal } from "./principal";
import type { Principal } from "./principal";
import { applyRedaction, PMCP_SLUG, Registry } from "./registry";
import type { Service } from "./registry";
import { status as tunnelStatus, tunnelBackend } from "./tunnel";
import { availability, upstreamBackend, UpstreamError } from "./upstream";
import type { Env } from "./index";
import { AGGREGATED_LIST_DEADLINE_MS } from "./limits";

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

/** The -32003 payload, in `data` and in the message text alike (§7 step 2). */
function approvalRequired(check: Extract<CheckResult, { outcome: "required" }>): HubError {
  const { approvalId, approvalUrl, expiresAt } = check;
  return new HubError(CODES.approvalRequired, `approval required: ${approvalUrl}`, {
    approvalId,
    approvalUrl,
    expiresAt,
  });
}

/**
 * The consumer MCP pipeline as one entry point: §7 steps 2–3 for one already-admitted
 * message, from bytes to bytes. `slug` present ⇔ the scoped shape.
 *
 * The door is index.mcpEntry's, not this function's, and `principal` is the proof: by the
 * time a request arrives here Content-Type, the Origin rule, the caller's resolution and
 * (scoped) the service's visibility to that caller have all been decided ONCE, at the
 * composition root. What is left is JSON-RPC — this function answers `server/discover`
 * itself with hub capabilities, routes tools/list and tools/call into the pipeline below,
 * refuses every other method with -32601, and answers 200 whether or not it refused. (The
 * SDK's legacy-stateless lane would serve 2025-era clients from the same wiring; it is
 * comment-level only, like the rest of the SDK seam.)
 */
export async function mcpMessage(
  request: Request,
  env: Env,
  principal: Principal,
  slug?: string,
): Promise<Response> {
  // deps: splitAggregatedName · captureClientMeta · callTool · listScoped · listAggregated · toWire
  const msg = await readMessage(request);
  if (msg === null) {
    return jsonRpc(toWire(new HubError(CODES.invalidRequest, "invalid request"), null));
  }
  // A notification carries no id, so there is nothing to answer to (§ JSON-RPC 2.0).
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const ctx: BackendCtx = { principal, roles: [], clientMeta: captureClientMeta(msg) };
  const ownerId = principal.kind === "user" ? principal.userId : principal.ownerId;
  try {
    return jsonRpc(await route(env, ownerId, slug, msg, ctx));
  } catch (err) {
    if (err instanceof Response) throw err; // identity's convention, never ours to swallow
    return jsonRpc(toWire(err, msg.id ?? null));
  }
}

/** §7 step 3's method table: three served methods, everything else -32601. */
async function route(
  env: Env,
  ownerId: string,
  slug: string | undefined,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  const id = msg.id ?? null;
  switch (msg.method) {
    // Answered by the hub on BOTH shapes: a slug in the URL is not resolved, dialed, or
    // filtered for it.
    case "server/discover":
      return { jsonrpc: "2.0", id, result: hubCapabilities() };
    case "tools/list": {
      if (slug !== undefined) {
        return { jsonrpc: "2.0", id, result: toolsResult(await listScoped(env, ownerId, slug, ctx)) };
      }
      const { tools, unavailable: omitted } = await listAggregated(env, ownerId, ctx);
      const result = toolsResult(tools);
      // §7: the omitted slugs are reported in the result's `_meta`, and logged as an ops
      // event — never an audit row (§15 keeps tools/list out of audit entirely).
      if (omitted.length > 0) {
        console.warn(`pmcp/unavailable: ${omitted.join(",")}`);
        result._meta = { "pmcp/unavailable": omitted };
      }
      return { jsonrpc: "2.0", id, result };
    }
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      if (slug !== undefined) return callTool(env, ownerId, slug, name, msg, ctx);
      const split = splitAggregatedName(name);
      // A name with no `_` at all names no service — the same -32001 as not-permitted,
      // never a distinct "malformed name" signal (§7).
      if (split === null) throw notPermitted();
      return callTool(env, ownerId, split.slug, split.tool, msg, ctx);
    }
    default:
      throw new HubError(CODES.methodNotFound, "method not found");
  }
}

/** The `server/discover` answer (§7): hub capabilities, no service resolved. */
function hubCapabilities(): Record<string, unknown> {
  return {
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { tools: { listChanged: false } },
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private",
  };
}

/** The one MCP revision this hub speaks (§7: stateless 2026-07-28 endpoints). */
const PROTOCOL_VERSION = "2026-07-28";

/**
 * §7's cache hints on a tools/list result. `cacheScope` is always `private` — a listing
 * is filtered by the caller's grants, so a shared cache would serve one account's view to
 * another. No § pins the window, only that there is one, so it lives here rather than in
 * limits.ts (audit's CLIENT_FIELD_MAX_LENGTH keeps its number for the same reason).
 */
const TOOLS_LIST_TTL_MS = 30_000;

function toolsResult(tools: Tool[]): Record<string, unknown> {
  return { tools, resultType: "complete", ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" };
}

/** The JSON-RPC envelope as HTTP: always 200 — refusals are payloads, not statuses. */
function jsonRpc(response: JsonRpcResponse): Response {
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The inbound body, or null when it is not a JSON-RPC request object at all. */
async function readMessage(request: Request): Promise<JsonRpcRequest | null> {
  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return typeof body.method === "string" ? body : null;
}

/**
 * Splits an aggregated tool name at its first `_` (§7: slugs contain no underscore, so
 * the split is unambiguous). Returns null for a name with no `_` at all; the pipeline
 * maps both that and a slug matching no visible service to -32001 — indistinguishable
 * from not-permitted, so nothing about the namespace leaks.
 */
function splitAggregatedName(name: string): { slug: string; tool: string } | null {
  // deps: none
  const at = name.indexOf("_");
  if (at <= 0 || at === name.length - 1) return null;
  return { slug: name.slice(0, at), tool: name.slice(at + 1) };
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
  return {
    // No row exists, so no row id does either: the slug IS the id, and every registry
    // read keyed by it comes back empty (which reads as "declares nothing", §8).
    id: PMCP_SLUG,
    ownerId,
    slug: PMCP_SLUG,
    kind: "tunnel",
    archived: false,
    // The same constant admin's builtin service_list row reads, so the two descriptions
    // of one virtual service cannot drift (§15).
    logBodies: BUILTIN_LOG_BODIES,
  };
}

/**
 * Picks the backend for a resolved service: slug `pmcp` → the admin builtin, otherwise
 * `service.kind` selects tunnel or upstream. The only place backend identity exists.
 */
function selectBackend(service: Service): ServiceBackend {
  // deps: admin.adminBackend · tunnel.tunnelBackend · upstream.upstreamBackend
  if (service.slug === PMCP_SLUG) return adminBackend;
  return service.kind === "tunnel" ? tunnelBackend : upstreamBackend;
}

/**
 * Pre-claim availability probe for the approval path (§7, approval step 1): answers
 * "would dispatch reach the service right now?" with no side effects — tunnel: the DO
 * holds a live registered socket; upstream: not flagged needs-reconnect; admin: always
 * true. Runs between approvals.check and approvals.claim so an offline service never
 * consumes an approval. Best-effort: a probe that passes can still lose the race, and
 * a post-claim dispatch failure leaves the claim consumed by design.
 */
async function probeAvailability(service: Service): Promise<HubError | null> {
  // deps: tunnel.status · upstream.availability
  if (service.slug === PMCP_SLUG) return null;
  if (service.kind === "tunnel") {
    return (await tunnelStatus(service.id)) === "online" ? null : unavailable();
  }
  // The REFUSAL, not a boolean: §7 spells "known unavailable" for a proxied service as
  // `not_connected` OR `needs_reconnect`, and only the module that owns the credential can
  // say which — `needs_reconnect` carries its failure class into the audit row's `detail`
  // so an owner reads "the credential died" rather than a bare -32000, while
  // `not_connected` is no upstream failure at all and refuses class-free. Both are the
  // same bytes on the wire: the class never leaves the ledger (§7).
  return availability(service);
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
  // The 128-char bound is applied by audit.record, at its chokepoint, so no call site has
  // to remember it (§15); this function only decides WHICH strings are display data.
  const meta = metaOf(msg);
  const info = meta[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  const captured = {
    name: displayString(info?.name),
    version: displayString(info?.version),
    sessionId: SESSION_ID_META_KEYS.map((key) => displayString(meta[key])).find(
      (value) => value !== undefined,
    ),
  };
  const empty = Object.values(captured).every((value) => value === undefined);
  return empty ? undefined : captured;
}

/** The reserved `_meta` keys of the 2026-07-28 wire this module reads or mirrors. */
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * §7's allowlist of vendor session-id `_meta` keys, maintained in code. Claude Code's
 * first — and, honestly, only: the exact vendor spelling is not pinned by any spec §, so
 * a hub that meets a second client adds one line here rather than parsing anything.
 */
const SESSION_ID_META_KEYS = ["claudecode/sessionId"];

/** Untrusted display data is a string or it is nothing — never coerced, never parsed. */
function displayString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A request's `_meta`, always an object so readers need no absence branch. */
function metaOf(msg: JsonRpcRequest): Record<string, unknown> {
  const meta = msg.params?._meta;
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
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
  // deps: principal.formatPrincipal
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metaOf(msg))) {
    // The `hub/` prefix is reserved: a consumer-supplied one is dropped, never merged.
    if (!key.startsWith(HUB_META_PREFIX)) meta[key] = value;
  }
  meta[`${HUB_META_PREFIX}principal`] = formatPrincipal(ctx.principal);
  meta[`${HUB_META_PREFIX}roles`] = ctx.roles;
  meta[CLIENT_CAPABILITIES_META_KEY] = meta[CLIENT_CAPABILITIES_META_KEY] ?? {};
  return { ...msg, params: { ...(msg.params ?? {}), _meta: meta } };
}

/** The reserved prefix of every `_meta` key the hub writes — and no consumer may. */
const HUB_META_PREFIX = "hub/";

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
  const registry = new Registry(env.DB);
  const service = slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
  // The door already answered 404 for a slug this caller cannot see, so a miss here is
  // the same not-permitted answer every other unresolvable name gets.
  if (service === null) throw notPermitted();
  const filter = await registry.resolveAccess(ctx.principal, service);
  if (service.archived) throw archived();
  const catalog = await selectBackend(service).listTools(service, { ...ctx, roles: filter.roleNames });
  return filter.filterList(catalog).map(served);
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
  const registry = new Registry(env.DB);
  const visible: Service[] = (await registry.listServicesFor(ctx.principal)).filter((s) => !s.archived);
  // The builtin participates like any other service for its owner; a service account can
  // hold no grants on it (§8), so it is never added for one.
  if (ctx.principal.kind === "user") visible.push(virtualPmcpService(ownerId));

  const listed: ListedService[] = await Promise.all(
    visible.map(async (service): Promise<ListedService> => {
      const filter = await registry.resolveAccess(ctx.principal, service);
      try {
        const catalog = await withDeadline(
          selectBackend(service).listTools(service, { ...ctx, roles: filter.roleNames }),
          AGGREGATED_LIST_DEADLINE_MS,
        );
        return {
          slug: service.slug,
          tools: filter
            .filterList(catalog)
            .map((tool) => ({ ...served(tool), name: `${service.slug}_${tool.name}` })),
        };
      } catch (err) {
        // Two failure classes, two OPERATOR signals. A HubError is somebody else's
        // downtime — errored, timed out, needs-reconnect — and `pmcp/unavailable` is the
        // line an operator reads before going to look at that upstream. A TypeError in
        // filterList, or a bug in served(), is a HUB defect: it is logged as one, against
        // this module, so it can never send anybody to a perfectly healthy upstream.
        //
        // Both still contribute zero tools, because §7 pins that the aggregate itself
        // always succeeds: one service's failure — ours or theirs — may not cost the
        // consumer the other nine, which is exactly what rethrowing here would do.
        if (!(err instanceof HubError)) {
          console.error(`pmcp/fan-out: hub defect listing "${service.slug}"`, err);
        }
        return { slug: service.slug, unavailable: true };
      }
    }),
  );
  return {
    tools: listed.flatMap((entry) => ("tools" in entry ? entry.tools : [])),
    unavailable: listed.filter((entry) => "unavailable" in entry).map((entry) => entry.slug),
  };
}

/** One service's contribution to the fan-out: what it served, or that it could not. The
 *  union is the partition — no caller re-derives which is which from a container shape. */
type ListedService = { slug: string; tools: Tool[] } | { slug: string; unavailable: true };

/** §7's per-upstream deadline inside the fan-out; the timer never outlives the race. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tool as served to a consumer: the hub's internal result-secret marker stripped from
 * the outputSchema, the inputSchema untouched (there `writeOnly` is standard usage, §7).
 */
function served(tool: Tool): Tool {
  if (tool.outputSchema === undefined) return tool;
  return { ...tool, outputSchema: withoutWriteOnly(tool.outputSchema) as Record<string, unknown> };
}

/** Drops `writeOnly: true` at any depth — and only that: a PROPERTY named `writeOnly`
 *  (whose value is a schema, not `true`) is a field name and survives. */
function withoutWriteOnly(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutWriteOnly);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "writeOnly" && value === true) continue;
    out[key] = withoutWriteOnly(value);
  }
  return out;
}

/**
 * The one tools/call pipeline, identical for both endpoint shapes — `slug` and `tool`
 * arrive already split and unprefixed, so approvals bind to the same row either way.
 * Runs the pinned order: filter (-32001 — an ungranted account learns nothing more),
 * archived (-32002), availability (-32000 — §7 lists it last but the availability-first
 * decision puts it ahead of the approval gate, and one test serves both), the call's
 * redaction map (-32001 when no sound one exists, §7), then the approval gate —
 * approvals.check, the atomic claim, dispatch, settle: `-32003` with
 * { approvalId, approvalUrl, expiresAt } when a decision is still owed, and an MRTR
 * input_required leg restores the claim. A passing call
 * is forwarded post-hygiene with identity attached and relayed verbatim — what the
 * CONSUMER receives is never redacted; masking exists for persistence only.
 *
 * Exactly one audit row leaves this function, written after the try/catch: audit.record
 * is AWAITED with hub-measured duration — a failed audit write fails the call. When
 * the service's log_bodies is on AND the call was dispatched (§15 — refusal rows
 * never carry bodies), the entry carries the bodies: args
 * masked under the redaction map's args union (backend schema paths + config redact), the
 * result's structuredContent under its results union (backend + config
 * redact_results), each unstructured result block replaced by a blob BodyStub —
 * audit.record itself enforces the size cap. All
 * failures leave as HubError; only the caller of this seam maps them to the wire.
 */
async function callTool(env: Env, ownerId: string, slug: string, tool: string, msg: JsonRpcRequest, ctx: BackendCtx): Promise<JsonRpcResponse> {
  // deps: registry.getService · registry.resolveAccess · registry.redactPathsFor · registry.applyRedaction · approvals.check · approvals.claim · approvals.settle · audit.record · selectBackend · virtualPmcpService · probeAvailability · prepareForward
  const startedAt = Date.now();
  const registry = new Registry(env.DB);
  // The row this call will leave, filled in by whichever branch below reaches an answer.
  // ONE exit: `recordCall` is invoked after the try/catch and nowhere else, which is what
  // makes "every path through callTool ends in exactly one audit row" readable off the
  // control flow instead of inferred from which statements can throw. It also means a
  // failure in the ledger path can never masquerade as a refusal of the call it is
  // recording — a second, refusal-shaped row for a call that actually dispatched.
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = slug;
  let detail: Record<string, unknown> | undefined;
  try {
    const service =
      slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
    // An aggregated prefix matching no visible service: -32001, indistinguishable from
    // not-permitted, so tool names cannot enumerate a namespace (§7 step 3).
    if (service === null) throw notPermitted();
    recordedSlug = service.slug;

    // 1 — filter. First, always: an ungranted account may not learn that a service is
    // archived, unreachable, or even real.
    const filter = await registry.resolveAccess(ctx.principal, service);
    const mode = filter.check(tool);
    if (mode === "deny") throw notPermitted();

    // 2 — archived.
    if (service.archived) throw archived();

    const backend = selectBackend(service);
    const serviceCtx: BackendCtx = { ...ctx, roles: filter.roleNames };

    // 3 — availability, tested ONCE. §7 lists it last, after the approval gate, but the
    // 2026-08-25 availability-first decision puts it first INSIDE that gate: a service the
    // hub already knows cannot execute fails -32000 before any approval row is read,
    // created or consumed. Two sentences, one verdict, one place — a gated call and an
    // ungated one reach it at the same point, which is also what keeps the map below (a
    // backend round trip and a D1 read) off the path of a call that was never going to run.
    const unavailableAs = await probeAvailability(service);
    if (unavailableAs !== null) throw unavailableAs;

    // Derived ONCE for the whole call, so the approval row and the audit row of the same
    // call can never be masked under different maps (§15). Null means no sound map exists
    // for this tool and nothing downstream may run — -32001, the same code as
    // not-permitted, so the refusal cannot be used to map grant patterns (§7).
    const redaction = await redactionMapFor(registry, backend, service, tool);
    if (redaction === null) throw notPermitted();

    // 4 — the approval gate (owners are never routed into it; the filter answered
    // `allow` for them via the built-in `all`).
    const claim = mode === "approval"
      ? await passGate(env, service, tool, msg, redaction.args, ctx.principal)
      : undefined;

    // The forwarded message carries the UNPREFIXED name; the aggregated prefix is the
    // hub's addressing, never the service's business.
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, name: tool } }, serviceCtx);
    const relayed = await backend.call(service, forwarded, serviceCtx);
    // An MRTR input_required leg restores the pass; anything else leaves it spent.
    if (claim) await approvalsFor(env).settle(claim, relayed);
    // The hub's own outcome vocabulary (§15): a service that answered with a JSON-RPC
    // error was still reached, and `error` — not one of the hub's refusal codes — is
    // what that is.
    outcome = relayed.error === undefined ? "ok" : "error";
    if (service.logBodies) bodies = callBodies(redaction, msg, relayed);
    // Re-addressed to the consumer's own id; everything else is relayed verbatim.
    answer = { ...relayed, id: msg.id ?? null };
  } catch (err) {
    // §15: every tools/call leaves a row, denials included (they are just fast) — and a
    // refusal row NEVER carries bodies, whatever the service's log_bodies says.
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
    bodies = {};
    // §7: every upstream failure class collapses into one -32000, and the real class
    // survives ONLY here — which is what lets an owner tell expired static headers from a
    // down upstream. The class name and the bare status NUMBER are all that may cross:
    // the status text, the headers (WWW-Authenticate especially) and the body are never
    // echoed to a consumer and never recorded (§15's hygiene rule, extended to `detail`).
    if (err instanceof UpstreamError) {
      detail = {
        failureClass: err.failureClass,
        ...(err.upstreamStatus === undefined ? {} : { upstreamStatus: err.upstreamStatus }),
      };
    }
  }
  await recordCall(env, {
    ownerId,
    ctx,
    slug: recordedSlug,
    tool,
    outcome,
    durationMs: Date.now() - startedAt,
    bodies,
    detail,
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/**
 * §7's approval gate: check → claim, and nothing before them. Its two preconditions are
 * the caller's, tested once each in callTool above — the service is available (§7's
 * availability-first clause: no pending row, no push, no existing pass touched for a
 * service the hub already knows cannot execute) and the call's redaction map is derived,
 * so the approval row and the audit row of the same call cannot be masked differently
 * (§15). A lost claim is no approval at all: re-entering check is what opens the fresh
 * pending row §7 step 1 hands back as -32003.
 */
async function passGate(
  env: Env,
  service: Service,
  tool: string,
  msg: JsonRpcRequest,
  redactPaths: string[],
  principal: Principal,
): Promise<ApprovalClaim> {
  const gate = approvalsFor(env);
  const args = argumentsOf(msg);

  let verdict = await gate.check(principal, service, tool, args, redactPaths);
  while (verdict.outcome === "ok") {
    const claim = await gate.claim(verdict.approvalId);
    if (claim !== "lost") return claim;
    // A concurrent identical call consumed the pass: treat it as no approval and fall
    // through to step 2, which is exactly what a fresh check does.
    verdict = await gate.check(principal, service, tool, args, redactPaths);
  }
  throw approvalRequired(verdict);
}

/**
 * §7's per-direction redaction map for ONE call, derived exactly once and handed to every
 * site that masks anything: the approval row's arguments and the audit row's bodies alike.
 * Each direction is the union of the backend's SCHEMA-declared paths (`writeOnly`) with
 * the service's configured ones (`redact` / `redact_results`).
 *
 * Null has ONE meaning here — no sound map can exist for this tool (unknown to the
 * backend, or its cached schema tripped registry.validateSchemaIndirection) — and one
 * consequence, taken by callTool at the gate: -32001, the same code as not-permitted, so
 * the refusal cannot be used to map grant patterns (§7). Nothing downstream runs, and no
 * body is ever recorded for such a tool (§15).
 */
async function redactionMapFor(
  registry: Registry,
  backend: ServiceBackend,
  service: Service,
  tool: string,
): Promise<{ args: string[]; results: string[] } | null> {
  // deps: ServiceBackend.sensitivePaths · registry.redactPathsFor
  const schemaPaths = await backend.sensitivePaths(service, tool);
  if (schemaPaths === null) return null;
  return {
    args: union(schemaPaths.args, await registry.redactPathsFor(service, tool, "args")),
    results: union(schemaPaths.results, await registry.redactPathsFor(service, tool, "results")),
  };
}

/** `params.arguments` and nothing else — the whole args binding (§7, MRTR clause). */
function argumentsOf(msg: JsonRpcRequest): Record<string, unknown> | undefined {
  const args = msg.params?.arguments;
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
}

/** Two path lists as one set — §7's per-direction union of schema and config paths. */
function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** What a `tools/call` row may carry: both masked, or — on every refusal — neither (§15). */
type CallBodies = { args?: Record<string, unknown>; result?: Record<string, unknown> };

/**
 * The audit bodies of a DISPATCHED call whose service opts into them (§15): arguments
 * masked under the args union, `structuredContent` under the results union, and every
 * unstructured content block replaced by a blob stub — bytes never stored. `redaction` is
 * the call's ONE map (redactionMapFor), which is why a tool with no derivable map cannot
 * reach here at all: callTool refused it at the gate.
 */
function callBodies(
  redaction: { args: string[]; results: string[] },
  msg: JsonRpcRequest,
  relayed: JsonRpcResponse,
): CallBodies {
  const result = (relayed.result ?? {}) as Record<string, unknown>;
  const structured = result.structuredContent;
  const body: Record<string, unknown> = {};
  if (typeof structured === "object" && structured !== null) {
    body.structuredContent = applyRedaction(structured as Record<string, unknown>, redaction.results);
  }
  // Unstructured content is never persisted, only stubbed — which is why only structured
  // data is ever redactable (§7, §15).
  if (Array.isArray(result.content)) body.content = result.content.map(blobStub);
  return { args: applyRedaction(argumentsOf(msg) ?? {}, redaction.args), result: body };
}

/**
 * One unstructured result block, as the ledger keeps it: type and size, never bytes.
 * `contentType` is the block's DECLARED media type — `mimeType` on an image or audio block,
 * `resource.mimeType` on an embedded resource — and absent on a text block, which declares
 * none. Not the MCP `type` discriminator, which is already implied by the stub: §15's
 * example is "the image generator returned a 4 MB png", and "image" is not a png.
 */
function blobStub(block: unknown): BodyStub {
  const carrier = (block ?? {}) as { mimeType?: unknown; resource?: { mimeType?: unknown } };
  const declared = carrier.mimeType ?? carrier.resource?.mimeType;
  return {
    stub: "blob",
    contentType: typeof declared === "string" ? declared : undefined,
    bytes: new TextEncoder().encode(JSON.stringify(block ?? null)).length,
  };
}

/** The one `tools/call` audit write — every path through callTool ends in exactly one. */
async function recordCall(
  env: Env,
  entry: {
    ownerId: string;
    ctx: BackendCtx;
    slug: string;
    tool: string;
    outcome: string;
    durationMs: number;
    bodies: CallBodies;
    /** The upstream failure class, on the rows that had one (§7) — never a body fragment. */
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await record(env.DB, {
    ownerId: entry.ownerId,
    principal: formatPrincipal(entry.ctx.principal),
    event: "tools/call",
    service: entry.slug,
    tool: entry.tool,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    client: entry.ctx.clientMeta,
    args: entry.bodies.args,
    result: entry.bodies.result,
    detail: entry.detail,
  });
}

/**
 * The approval gate, wired from the composition root's env. Built per request because
 * every binding it closes over is (D1 especially); the clock is the real one — only
 * tests inject another, and they construct their own.
 */
function approvalsFor(env: Env): Approvals {
  return new Approvals({
    db: env.DB,
    publicOrigin: env.PUBLIC_ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.PUBLIC_ORIGIN,
    },
    retentionDays: auditConfig().retentionDays,
    now: Date.now,
    push: sendPush,
  });
}

/**
 * The Web Push TRANSPORT (§13): one POST per subscription, answering the push service's
 * status so approvals can prune dead endpoints.
 *
 * ponytail: RFC 8291 payload encryption and the VAPID ES256 signature belong to a
 * library (§7 names webpush-webcrypto) that this repo does not depend on yet, so this is
 * a bare POST — real push services will refuse it, which is why push is best-effort by
 * contract and a refusal never fails the request that created the row. The payload
 * carries only what §15 already permits on a third-party service (service, tool, id,
 * link) and never arguments. Swap in the library and this function is the only edit.
 */
async function sendPush(
  subscription: { endpoint: string },
  payload: string,
): Promise<{ status: number }> {
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", TTL: "60" },
    body: payload,
  });
  return { status: response.status };
}

/**
 * The ONE error-to-wire mapping (§7, §15): a HubError's code/message/data go out
 * as-is; anything else becomes a generic internal error with nothing of the cause
 * attached. Log hygiene is enforced here as the last line: no upstream bodies, token
 * material, or argument echoes ever leave through this function.
 */
function toWire(err: unknown, id: JsonRpcId | null): JsonRpcResponse {
  // deps: none
  if (err instanceof HubError) {
    const error = { code: err.code, message: err.message };
    return {
      jsonrpc: "2.0",
      id,
      error: err.data === undefined ? error : { ...error, data: err.data },
    };
  }
  // Nothing of the cause: not its message, not its stack, not its type.
  return { jsonrpc: "2.0", id, error: { code: CODES.internal, message: "internal error" } };
}
