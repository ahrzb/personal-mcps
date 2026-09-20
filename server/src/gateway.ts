// gateway.ts — the consumer-facing MCP pipeline (§7): every /:user/mcp message is answered
// by this module. It OWNS the JSON-RPC half of both endpoint shapes (POST /:user/mcp, the
// aggregate hub endpoint §23.1 defines, and POST /:user/mcp/:slug scoped) and their SDK
// wiring (createMcpHandler with a per-request low-level Server, legacy-stateless lane
// included — comment-level only, the SDK never appears in sibling modules); the pinned
// check order filter → archived → approval → availability (§7's list, with the
// availability-first decision folding its last two into one test — see dispatchTool);
// server/discover and the `initialize` handshake; `_meta` hygiene and client-metadata
// capture; the ONE redaction map per call; and the ONE mapping from HubError to JSON-RPC
// wire errors. It HIDES the wire entirely: sibling modules throw the HubError vocabulary
// errors.ts owns and never see a JSON-RPC error code, and backends never see an
// unfiltered tool name, an archived app, or an unapproved gated call.
//
// §23.1 REPLACED the aggregate application catalog: `/mcp` and `/mcp/hub` are one virtual
// hub, answering the same two tools and declaration resources (hub-backend.ts owns their
// wire vocabulary, the declaration reader and the execution seam) on either shape. The
// aggregate `<slug>_<tool>` split, the prompt/resource fan-out and every aggregate app
// listing are GONE — application tools/prompts/resources live on `/mcp/<app>` alone. What
// stays here is what the hub shares with every other request: the virtual hub's App row and
// synthetic access filter, the caller-visible catalog COLLECTOR (per-family deadlines,
// durable TypeScript-name allocation before filtering, grant filtering, bounded
// diagnostics) that declarations, search and `execute` all read, the two trusted dispatch
// seams the QuickJS host bridge reuses, and the metadata-only outer audit of a hub tool call.
//
// It also owns §21's ONE carve-out from statelessness: `subscriptions/listen`'s held
// `text/event-stream`, the session id the hub mints for it, its re-authorization tick and
// its Worker-side shape filter, plus the two per-URI methods (`resources/subscribe` /
// `resources/unsubscribe`) that mutate the subscription set on the socket feeding it. What
// it does NOT own of that: what rings (tunnel.ts's DO), and the shape/bell/tag vocabulary
// the filter asks (capabilities.ts, which is Node-clean and must stay so).
//
// What it does NOT own: §7 step 1's HTTP-level door. Content-Type, the Origin rule, the
// 401 with WWW-Authenticate, the scoped-visibility 404 and the resolution of the caller
// all belong to index.mcpEntry, which hands the resolved principal in — and, for a held
// stream, hands in the same verdict as a callable so the keepalive tick re-runs step 1
// rather than re-implementing it (§21.2). One resolution per request, one place to change
// step 1.
//
// IMPLEMENTATION NOTE (2026-08-25): `@modelcontextprotocol/server` is not a dependency of
// this repo and "no new dependencies" is binding, so the SDK wiring named above is served
// by hand: the composition root routes the two shapes and the JSON-RPC envelope is read
// and written here. The seam is unchanged — the SDK still appears in no sibling module —
// and swapping createMcpHandler in later is an edit to `mcpMessage`/`route` alone.

// `owner` is admin's, aliased on the way in: the id→username read has one home (admin
// already returns exactly the user principal this module builds), and the local name says
// which of the two "owner" questions this is.
import { adminBackend, BUILTIN_LOG_BODIES, owner as namespaceOwner } from "./admin";
import type { ApprovalClaim, Approvals, CheckResult } from "./approvals";
import { record, REDACTED_QUERY } from "./audit";
import type { BodyStub } from "./audit";
import {
  admits,
  HUB_CAPABILITIES,
  bellFrame,
  capabilityShape,
  DEFAULT_APP_CAPABILITIES,
  familyBell,
} from "./capabilities";
import type { CapabilityKind, EndpointShape } from "./capabilities";
import { archived, CODES, HubError, invalidParams, methodNotFound, notPermitted, unavailable } from "./errors";
import { formatPrincipal, principalKey, tokenPattern } from "./principal";
import type { Principal } from "./principal";
import type { AuthenticatedCaller } from "./identity";
import { reauthorize } from "./identity";
import { pushSender } from "./push";
import { applyRedaction, HUB_SLUG, PMCP_SLUG, patternFamilyOf, REDACTED, Registry, subjectKeyOf } from "./registry";
import type {
  AccessMode,
  App,
  AppCapability,
  AppDetail,
  ListKind,
  RoleFamily,
  ToolFilter,
} from "./registry";
import { buildCatalogSnapshot } from "./hub-catalog";
import type { CatalogServiceInput, CatalogSnapshot } from "./hub-catalog";
import { HUB_TOOLS } from "./hub-contract";
import {
  HubCredentialRevokedError,
  HubExecutionAbortedError,
  hubDeclarationText,
  hubExecuteRequest,
  hubResourceList,
  hubResourceTemplates,
  hubSearchTypes,
  hubToolFor,
  hubToolsFor,
  parseHubDeclarationUri,
  runHubExecution,
} from "./hub-backend";
import type { HubRequestLifecycle } from "./hub-backend";
import { aliasDiagnosticMessage, aliasNameViolations, generatedAlias } from "./hub-types";
import type { AliasPlan, AliasServiceMembers } from "./hub-types";
import {
  capabilities as tunnelCapabilities,
  openSubscriber,
  status as tunnelStatus,
  subscribe as tunnelSubscribe,
  tunnelBackend,
  unsubscribe as tunnelUnsubscribe,
} from "./tunnel";
import { availability, upstreamBackend } from "./upstream";
import { approvalsFromEnv, vapidFromEnv } from "./wiring";
import type { Env } from "./index";
import {
  AUDIT_URI_CAP_BYTES,
  deadlines,
  HUB_INNER_OPERATION_TIMEOUT_MS,
  OWNER_CATALOG_DEADLINE_MS,
} from "./limits";

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
 * An MCP tool descriptor as listed to consumers. `inputSchema` is the app's JSON
 * Schema passed through untouched — `writeOnly` markers survive so redaction (§7) can
 * derive from them, and on an input the keyword is standard usage. `outputSchema`
 * (present when the app declares one) is different: the hub co-opts `writeOnly`
 * there as its internal result-secret marker, so the listing paths below strip it
 * from every outputSchema before a consumer sees it (§7) — backends return the
 * catalog verbatim and never strip. `name` is always the app's own canonical tool name:
 * §23.1 removed the only rewriting this type ever saw (the aggregate `<slug>_` prefix),
 * and the hub's own two tools carry their endpoint-specific spellings instead.
 */
export type Tool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/**
 * §20.2's other three list items — verbatim from the backend, matched (never renamed) on
 * the key registry.ToolFilter reads: a prompt by `name`, a resource by `uri`, a template
 * by its raw `uriTemplate`. Deliberately minimal: the hub relays whatever else an app
 * attaches (a resource's `mimeType`, a prompt's `arguments`) untouched, so these types name
 * only the fields the door itself reads: the filter's subject key, and — since §23.5 — the
 * `description` the catalog collector indexes as bounded search metadata. Every other extra
 * field still rides through untouched.
 */
export type Prompt = { name: string; description?: string };
export type Resource = { uri: string; name?: string; description?: string; mimeType?: string };
export type ResourceTemplate = {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

/**
 * Per-request caller context handed to every backend: the resolved principal, the
 * caller's granted role names on this app exactly as granted (`"all"` stays
 * literal, never expanded; owners get `["all"]`), and untrusted display-only client
 * metadata (128-char-truncated, §7). Informational downstream — every authorization
 * decision has already run in the pipeline before a backend sees this.
 *
 * `deadlineAt` is §23.10's optional EARLIER deadline, set only for an execution-originated
 * operation: an absolute epoch-ms instant after which the operation must not run (and must
 * not still be running). Absent on every direct consumer call, where the backend's own
 * `CALL_TIMEOUT_MS` is the whole budget; the dispatch seams enforce it around
 * `AppBackend.call`, and a backend that reads it may shorten its own transport timeout.
 */
export type BackendCtx = {
  principal: Principal;
  roles: string[];
  clientMeta?: { name?: string; version?: string; sessionId?: string };
  deadlineAt?: number;
};

/**
 * The seam behind which the three dispatch targets — tunnel (AppConnection DO),
 * upstream (proxied endpoint), admin (the builtin `pmcp` ops table) — are
 * interchangeable. Backends receive only already-authorized traffic and report every
 * failure as HubError; they never touch the wire mapping.
 */
export interface AppBackend {
  /**
   * The app's full tool catalog as this backend knows it (tunnel: the DO's cached
   * list, populated even while offline; upstream: fetched live; admin: the ops table).
   * Unfiltered — the gateway applies the caller's grant patterns.
   * Throws HubError -32000 when the catalog is unreachable (proxied upstream down or
   * needs-reconnect); the hub's catalog collector catches that per service, the scoped
   * list surfaces it.
   */
  listTools(app: App, ctx: BackendCtx): Promise<Tool[]>;
  /**
   * §20.2's other three catalogs, on the same contract as `listTools` above: unfiltered,
   * relayed VERBATIM (the hub reads no field beyond the one its family is matched on —
   * a prompt by `name`, a resource by `uri`, a template by its raw `uriTemplate`), and
   * -32000 when unreachable. Tunnel serves them from the DO's cache, upstream live
   * (§20.5: proxied caches nothing, in any family), admin the builtin's three empty
   * lists (§20.6). They live here, beside `listTools`, because this is the seam's one
   * question — what the DOOR may ask a backend — and every backend answers all four.
   */
  listPrompts(app: App, ctx: BackendCtx): Promise<Prompt[]>;
  listResources(app: App, ctx: BackendCtx): Promise<Resource[]>;
  listResourceTemplates(app: App, ctx: BackendCtx): Promise<ResourceTemplate[]>;
  /**
   * Forwards one fully authorized tools/call and relays the app's response
   * verbatim. `msg` arrives post-hygiene (prepareForward already ran). Transport and
   * HTTP-level failures become HubError -32000 with a generic message — an upstream's
   * status line, headers, and body are never echoed to the consumer (§7).
   */
  call(app: App, msg: JsonRpcRequest, ctx: BackendCtx): Promise<JsonRpcResponse>;
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
    app: App,
    tool: string,
  ): Promise<{ args: string[]; results: string[] } | null>;
}

/**
 * One listed item as the DOOR handles it — whichever of §20.2's four descriptors a family
 * serves, seen through the only fields this module touches: the key the filter matches it
 * on, and the outputSchema `served` strips (tools alone carry one).
 */
export type ListedItem = {
  name?: string;
  uri?: string;
  uriTemplate?: string;
  outputSchema?: Record<string, unknown>;
};

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
 * §23.10/§23.12's narrow request lifecycle, as the composition root hands it in: the one
 * thing the gateway cannot read off the `Request` is the invocation's `ExecutionContext`.
 * Hub execution uses it for background abort cleanup and to keep the continuation alive
 * through its outer audit after disconnect. Absent is legitimate — a direct caller (a
 * test) has no background lifetime to register — and every non-hub path ignores it.
 */
export type RequestLifecycle = { waitUntil?: (work: Promise<unknown>) => void };

/**
 * The consumer MCP pipeline as one entry point: §7 steps 2–3 for one already-admitted
 * message, from bytes to bytes. `slug` present ⇔ the scoped shape.
 *
 * The door is index.mcpEntry's, not this function's, and `caller` is its proof: Content-Type,
 * Origin, credential resolution and scoped visibility were decided once at the composition
 * root. What remains is JSON-RPC: this function answers `server/discover` and
 * the `initialize` handshake itself, routes tools/list and tools/call into the pipeline
 * below, refuses every other method with -32601, absorbs every notification with a 202
 * (`notifications/initialized` included), and answers 200 whether or not it refused. (The
 * SDK's legacy-stateless lane would serve 2025-era clients from the same wiring; it is
 * comment-level only, like the rest of the SDK seam.)
 *
 * §21.1's `subscriptions/listen` is the ONE message whose answer is not a JSON-RPC
 * envelope — a `text/event-stream` this invocation then holds — so it is answered here,
 * ahead of `route`, rather than by a case that cannot express its return type. Everything
 * else about it is ordinary: the same door admitted it, and a refusal on the way to
 * opening it (a scoped archived app, -32002) leaves through the same mapping below.
 * `reauthorize` is the door's current-state verdict: the held stream re-reads the
 * non-secret credential reference and scoped visibility on every keepalive (§21.2),
 * rather than retaining or replaying the bearer.
 */
export async function mcpMessage(
  request: Request,
  env: Env,
  caller: AuthenticatedCaller,
  slug: string | undefined,
  reauthorize: Reauthorize,
  lifecycle?: RequestLifecycle,
): Promise<Response> {
  // deps: captureClientMeta · dispatchTool · listScoped · hubCall · hubRead · listenStream · toWire
  const msg = await readMessage(request);
  if (msg === null) {
    return jsonRpc(toWire(new HubError(CODES.invalidRequest, "invalid request"), null));
  }
  // A notification carries no id, so there is nothing to answer to (§ JSON-RPC 2.0).
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const principal = caller.principal;
  const ctx: BackendCtx = { principal, roles: [], clientMeta: captureClientMeta(msg) };
  const ownerId = principal.kind === "agent" ? principal.ownerId : principal.userId;
  // §22.1: the aggregate has no slug to check visibility against (index.visibleOnScoped
  // only runs when one is addressed), so an admin token that resolved past the door —
  // it carries a real session's credential shape — would otherwise reach every method
  // here undistinguished from its owner. Refused explicitly, before ANY method
  // dispatches: the scoped `pmcp` and `hub` endpoints are the only doors this credential
  // opens (§23.1 admits it to `/mcp/hub`, never to `/mcp`).
  if (slug === undefined && principal.kind === "admin") {
    return jsonRpc(toWire(notPermitted(), msg.id ?? null));
  }
  try {
    if (msg.method === LISTEN_METHOD) return await listenStream(env, ownerId, ctx, slug, reauthorize);
    // §21.4: the session id a subscribe names its stream with is a REQUEST header, and this
    // is the only place a consumer-supplied one is ever read (§21.1 — correlation, never
    // authentication: the bearer above decided everything).
    const requestLifecycle: HubRequestLifecycle = { signal: request.signal, waitUntil: lifecycle?.waitUntil };
    return jsonRpc(
      await route(env, ownerId, caller, slug, msg, ctx, request.headers.get(MCP_SESSION_HEADER), requestLifecycle),
    );
  } catch (err) {
    if (err instanceof Response) throw err; // identity's convention, never ours to swallow
    return jsonRpc(toWire(err, msg.id ?? null));
  }
}

/** §7 step 3's method table, widened by §20's seven entries, §21's three and §23's hub:
 *  served methods, everything else -32601. The handshake is answered first, by the hub
 *  itself, on both shapes; then the shape splits — §23.1's virtual hub (the aggregate
 *  endpoint and the scoped `hub` slug, ONE surface) is `hubRoute` below, and every other
 *  scoped slug keeps §7/§20/§21 unchanged. `subscriptions/listen` never reaches here — its
 *  answer is a held response, so mcpMessage answers it above (§21.1). */
async function route(
  env: Env,
  ownerId: string,
  caller: AuthenticatedCaller,
  slug: string | undefined,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
  sessionId: string | null,
  lifecycle: HubRequestLifecycle,
): Promise<JsonRpcResponse> {
  const id = msg.id ?? null;
  // Answered by the hub on BOTH shapes: a slug in the URL is not resolved, dialed, or
  // filtered for either of them.
  switch (msg.method) {
    case "server/discover":
      return { jsonrpc: "2.0", id, result: await discoverResult(env, ownerId, slug) };
    case "initialize":
      return { jsonrpc: "2.0", id, result: await initializeResult(env, ownerId, slug) };
  }
  // §23.1: the aggregate endpoint and the scoped `hub` slug are the same virtual surface,
  // and neither resolves an app for any other method.
  if (slug === undefined || slug === HUB_SLUG) {
    return hubRoute(env, ownerId, caller, slug, msg, ctx, lifecycle);
  }
  switch (msg.method) {
    // §20.2's four listings, answered from the addressed app's catalog under the caller's
    // grants. The hub shapes never reach this table — they list the hub's own tools and
    // declarations instead, and refuse the families they do not serve.
    case "tools/list":
      return { jsonrpc: "2.0", id, result: familyResult("tools", await listScoped(env, ownerId, slug, ctx, "tools")) };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: familyResult("prompts", await listScoped(env, ownerId, slug, ctx, "prompts")) };
    case "resources/list":
      return { jsonrpc: "2.0", id, result: familyResult("resources", await listScoped(env, ownerId, slug, ctx, "resources")) };
    case "resources/templates/list":
      return {
        jsonrpc: "2.0",
        id,
        result: familyResult("resourceTemplates", await listScoped(env, ownerId, slug, ctx, "resourceTemplates")),
      };
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      return dispatchTool(env, {
        caller,
        slug,
        tool: name,
        args: argumentsOf(msg),
        clientMeta: ctx.clientMeta,
        meta: metaOf(msg),
        ...("inputResponses" in (msg.params ?? {}) ? { inputResponses: msg.params?.inputResponses } : {}),
        ...("requestState" in (msg.params ?? {}) ? { requestState: msg.params?.requestState } : {}),
        id: msg.id,
      });
    }
    case "prompts/get": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      return getPrompt(env, ownerId, slug, name, msg, ctx);
    }
    // §20.2/§18 decision 26: application resources are scoped-only; on the hub shapes
    // `resources/read` serves the hub's own declarations instead (§23.1/§23.2).
    case "resources/read": {
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
      return dispatchResourceRead(env, {
        caller,
        slug,
        uri,
        clientMeta: ctx.clientMeta,
        meta: metaOf(msg),
        id: msg.id,
      });
    }
    case "completion/complete":
      return completeRef(env, ownerId, slug, msg, ctx);
    // §21.4's two per-URI methods, scoped-only for §18 decision 26's reason and
    // tunneled-only for §21.2's: a proxied app has no channel to ring from and the
    // builtin never changes, so neither ADVERTISES subscribe and neither has anywhere to
    // forward — refused inside, by kind, on the same -32601 this shape check gives. The
    // hub refuses them in `hubRoute` above: it has no app socket to mutate.
    case "resources/subscribe":
    case "resources/unsubscribe":
      return subscription(env, ownerId, slug, msg.method, sessionId, msg, ctx);
    default:
      // §7's 2026-09-01 amendment: with `subscriptions/listen` and the two per-URI methods
      // served, the leftover set is `logging/*` and every server-initiated request — both
      // dead in 2026-07-28 itself — and it falls here on both endpoint shapes alike.
      throw methodNotFound();
  }
}

/**
 * §23.1's hub method table, on BOTH hub shapes — the aggregate endpoint and the scoped
 * `/mcp/hub` slug are one surface differing only in tool spellings. It serves the two hub
 * tools (`hubToolsFor`/`hubToolFor`), the hub's own declaration resources and templates,
 * and hub declaration reads; every other method — `prompts/*`, `completion/complete`,
 * `resources/subscribe`, `resources/unsubscribe` — is -32601, because the hub advertises
 * none of those capabilities and holds no application subscriber socket.
 *
 * Nothing here resolves an app, dials a backend, or opens a socket: the only I/O behind
 * these methods is the catalog collector (`hubCall`'s snapshot), which reads each
 * caller-visible app's cached or declared families under its own deadline.
 */
async function hubRoute(
  env: Env,
  ownerId: string,
  caller: AuthenticatedCaller,
  slug: string | undefined,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
  lifecycle: HubRequestLifecycle,
): Promise<JsonRpcResponse> {
  const id = msg.id ?? null;
  const shape: EndpointShape = slug === undefined ? "aggregated" : "scoped";
  switch (msg.method) {
    case "tools/list":
      return { jsonrpc: "2.0", id, result: familyResult("tools", hubToolsFor(shape)) };
    case "resources/list":
      return { jsonrpc: "2.0", id, result: familyResult("resources", hubResourceList()) };
    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: familyResult("resourceTemplates", hubResourceTemplates()) };
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      return hubCall(env, caller, ownerId, shape, name, msg, ctx, lifecycle);
    }
    case "resources/read":
      return hubRead(env, ownerId, msg, ctx);
    default:
      throw methodNotFound();
  }
}


/**
 * What a method the hub forwards over an app socket carries beyond its own params (§6,
 * §7's identity clause, §21.4). `forwardedCall` names the six a CONSUMER drives: each
 * arrives post-hygiene with `hub/principal`, `hub/roles` and the mirrored
 * `clientCapabilities` in its `_meta`, under one strip-then-set. `protocol` names the five
 * the HUB itself drives — §6's registration-time `server/discover` and the four catalog
 * warms — which carry the protocol `_meta` fields alone, because at registration no
 * principal exists to attach.
 */
export type ForwardedCarrier = "forwardedCall" | "protocol";

/**
 * §6's hub→app forwarded methods, WHOLE — the eleven the hub ever sends over an app
 * socket, and which of the two `_meta` regimes each rides under. Published vocabulary, like
 * tunnel's HUB_METHODS and APP_NOTIFICATIONS: `contracts/tunnel-frames.json` is emitted
 * from this record, so a twelfth forwarded method cannot reach a client library's wire
 * without reaching the fixture. It sits beside the dispatch switch above — that switch is
 * where the six consumer-driven ones enter, and where the two §21.4 added were added — and
 * beside the warms tunnel.ts issues, which are the protocol half's only sender.
 */
export const FORWARDED_METHODS: Readonly<Record<string, ForwardedCarrier>> = {
  "tools/call": "forwardedCall",
  "prompts/get": "forwardedCall",
  "resources/read": "forwardedCall",
  "completion/complete": "forwardedCall",
  "resources/subscribe": "forwardedCall",
  "resources/unsubscribe": "forwardedCall",
  "server/discover": "protocol",
  "tools/list": "protocol",
  "prompts/list": "protocol",
  "resources/list": "protocol",
  "resources/templates/list": "protocol",
};

/**
 * The `server/discover` answer (§7, amended by §20.2): the same two static capability
 * pictures `initialize` publishes — "one source, two spellings" — so a divergence between
 * this and `initializeResult` is a bug this function's own body cannot introduce.
 */
async function discoverResult(env: Env, ownerId: string, slug: string | undefined): Promise<Record<string, unknown>> {
  return {
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: await capabilitiesFor(env, ownerId, slug),
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private",
  };
}

/**
 * The `initialize` answer (§7's dispatch table, amended 2026-08-26 and again by §20.2):
 * the handshake every standards-compliant MCP client opens with. STATELESS — nothing is
 * remembered between this message and the next, which is why the follow-up
 * `notifications/initialized` needs no case of its own: mcpMessage absorbs every
 * notification with a 202 ahead of this table. One revision is offered because the hub
 * speaks one (§7); a client that wants another reads the same answer `server/discover`
 * gives and decides for itself.
 */
async function initializeResult(env: Env, ownerId: string, slug: string | undefined): Promise<Record<string, unknown>> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: await capabilitiesFor(env, ownerId, slug),
    // ponytail: a literal version, because nothing in this repo produces a build stamp for
    // it and a client only displays the string. Wire it to one if a release ever mints one.
    serverInfo: { name: "Personal MCP Hub", version: "0" },
  };
}

/**
 * §20.2's real-app capability question and §23.1's virtual-hub answer, produced once
 * for both `initialize` and `server/discover`. Aggregate and scoped `hub` requests
 * return the fixed HUB_CAPABILITIES literal: tools then resources, both push flags
 * false. Other scoped requests derive their answer from what the hub already stores
 * for that app — the capability set §6's registration-time `server/discover` learned
 * (tunneled), or the owner-declared `capabilities` config (proxied, absent means tools
 * only) — never a live upstream call, which lets a hung app answer the handshake at
 * full speed.
 *
 * The KIND is §21.5's second input for real apps: a proxied app has no DO to ring from
 * and the builtin's tools never change, so both declare every push flag false whatever
 * their stored set says, while a tunneled app declares `listChanged` on each family it
 * stores and `subscribe` on its resources. An app the caller cannot resolve answers the
 * never-connected tunneled shape so the handshake is not an app-existence oracle.
 */
async function capabilitiesFor(env: Env, ownerId: string, slug: string | undefined): Promise<Record<string, unknown>> {
  // deps: registry.getApp · tunnel.capabilities · capabilities.capabilityShape
  if (slug === undefined || slug === HUB_SLUG) return HUB_CAPABILITIES;
  if (slug === PMCP_SLUG) return capabilityShape(DEFAULT_APP_CAPABILITIES, "builtin");
  const app = await new Registry(env.DB).getApp(ownerId, slug);
  if (app === null) return capabilityShape(DEFAULT_APP_CAPABILITIES, "tunnel");
  const declared =
    app.kind === "tunnel" ? await tunnelCapabilities(app.id) : app.capabilities ?? DEFAULT_APP_CAPABILITIES;
  return capabilityShape(declared, CAPABILITY_KINDS[app.kind]);
}

/** A stored app's kind as §21.5's capability axis spells it — the builtin is decided by
 *  slug above, so this table covers the two kinds a D1 row can hold. */
const CAPABILITY_KINDS = { tunnel: "tunnel", proxy: "proxy" } as const satisfies Record<
  App["kind"],
  CapabilityKind
>;

/**
 * The pure capability producers re-exported at the gateway seam. Keeping them in
 * `capabilities.ts` lets fixture producers import the wire verdicts without pulling
 * `cloudflare:workers`, admin, or tunnel into the Node test pool.
 */
export { HUB_CAPABILITIES, capabilityShape } from "./capabilities";

/** The one MCP revision this hub speaks (§7: stateless 2026-07-28 endpoints). */
const PROTOCOL_VERSION = "2026-07-28";

/**
 * §7's cache hints on a listing result — extended by §20.5 to every family's list, on the
 * same reasoning: `cacheScope` is always `private` because a listing is filtered by the
 * caller's grants, so a shared cache would serve one agent's view to another. No § pins
 * the window, only that there is one, so it lives here rather than in limits.ts (audit's
 * CLIENT_FIELD_MAX_LENGTH keeps its number for the same reason).
 */
const LIST_TTL_MS = 30_000;

/** One listing result, keyed by the wire field its family serves under — the same four
 *  names registry's ListKind spells, because a family IS its wire key (§20.2). */
function familyResult(key: ListKind, items: unknown[]): Record<string, unknown> {
  return { [key]: items, resultType: "complete", ttlMs: LIST_TTL_MS, cacheScope: "private" };
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
 * The virtual App row for the builtin `pmcp` admin app (§8): reserved slug, no
 * D1 row ever exists for it, never archived, logBodies fixed ON (§15 — the builtin's
 * schemas are the hub's own, so the tunneled default applies and token_issue's key is
 * masked by the uniform rule). Exists so the admin backend rides the
 * same pipeline as everything else; its `kind` field is set only to satisfy the type —
 * backend selection happens on the slug before kind is ever read.
 */
function virtualPmcpApp(ownerId: string): App {
  // deps: none
  return {
    // No row exists, so no row id does either: the slug IS the id, and every registry
    // read keyed by it comes back empty (which reads as "declares nothing", §8).
    id: PMCP_SLUG,
    ownerId,
    slug: PMCP_SLUG,
    kind: "tunnel",
    archived: false,
    // The same constant admin's builtin app_list row reads, so the two descriptions
    // of one virtual app cannot drift (§15).
    logBodies: BUILTIN_LOG_BODIES,
  };
}

/**
 * Picks the backend for a resolved app: slug `pmcp` → the admin builtin, otherwise
 * `app.kind` selects tunnel or upstream. The only place backend identity exists.
 */
function selectBackend(app: App): AppBackend {
  // deps: admin.adminBackend · tunnel.tunnelBackend · upstream.upstreamBackend
  if (app.slug === PMCP_SLUG) return adminBackend;
  return app.kind === "tunnel" ? tunnelBackend : upstreamBackend;
}

/**
 * Pre-claim availability probe for the approval path (§7, approval step 1): answers
 * "would dispatch reach the app right now?" with no side effects — tunnel: the DO
 * holds a live registered socket; upstream: not flagged needs-reconnect; admin: always
 * true. Runs between approvals.check and approvals.claim so an offline app never
 * consumes an approval. Best-effort: a probe that passes can still lose the race, and
 * a post-claim dispatch failure leaves the claim consumed by design.
 */
async function probeAvailability(app: App): Promise<HubError | null> {
  // deps: tunnel.status · upstream.availability
  if (app.slug === PMCP_SLUG) return null;
  if (app.kind === "tunnel") {
    return (await tunnelStatus(app.id)) === "online" ? null : unavailable();
  }
  // The REFUSAL, not a boolean: §7 spells "known unavailable" for a proxied app as
  // `not_connected` OR `needs_reconnect`, and only the module that owns the credential can
  // say which — `needs_reconnect` carries its failure class into the audit row's `detail`
  // so an owner reads "the credential died" rather than a bare -32000, while
  // `not_connected` is no upstream failure at all and refuses class-free. Both are the
  // same bytes on the wire: the class never leaves the ledger (§7).
  return availability(app);
}

/**
 * Client-metadata capture (§7): copies clientInfo.name/version and a recognized vendor
 * session-id `_meta` key (a small in-code allowlist, Claude Code's key first), each
 * value truncated to 128 chars. Strictly untrusted display-and-audit data — never
 * parsed, never an authorization input. Unrecognized vendor `_meta` is not captured
 * here but still passes through to apps untouched.
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
 * any `hub/*` value an app sees was written by the hub — and mirrors the consumer's
 * `io.modelcontextprotocol/clientCapabilities` (`{}` when the consumer declared none,
 * so apps refrain from elicitation/sampling for legacy callers). Other `_meta` keys,
 * including progress tokens and vendor keys, pass untouched. `dispatchTool` separately
 * preserves MRTR's params-level `inputResponses` and `requestState` siblings. Pure: returns
 * a new message and never mutates the input.
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
 * Which catalog each family is read from — the seam's four listing methods, indexed by the
 * catalog they serve. Kept apart from the pattern-matching side because §20.2 pins the KEY
 * each family is matched on (`name` for tools/prompts, `uri` for resources, `uriTemplate`
 * for templates) and `filterList`'s own `kind` argument is what selects it — a family-aware
 * caller that forgot to pass it would filter every family by `name`.
 */
const LIST_CATALOG: Record<
  ListKind,
  (backend: AppBackend, app: App, ctx: BackendCtx) => Promise<ListedItem[]>
> = {
  tools: (b, s, c) => b.listTools(s, c),
  prompts: (b, s, c) => b.listPrompts(s, c),
  resources: (b, s, c) => b.listResources(s, c),
  resourceTemplates: (b, s, c) => b.listResourceTemplates(s, c),
};

/**
 * Scoped listing (§7, widened by §20.2 to every family): the backend's catalog for `kind`,
 * filtered by the caller's grant patterns, every outputSchema served with its `writeOnly`
 * markers stripped (§7 — the hub's internal result-secret co-opt never reaches the wire;
 * the `owner` flag below is the one read that is not a serving).
 * Archived → -32002; an unreachable or needs-reconnect proxied upstream
 * → -32000 (the backend's own throw) — the scoped endpoint is where a failure surfaces
 * instead of being omitted from a hub snapshot. Never audited (§15).
 */
async function listScoped(
  env: Env,
  ownerId: string,
  slug: string,
  ctx: BackendCtx,
  kind: ListKind,
  /**
   * The OWNER's own read of their own app (`ownerCatalog`, §13) rather than a consumer
   * call — one predicate with two consequences, because both follow from the same fact.
   * It may see an ARCHIVED app's retained catalog, where every wire path keeps the -32002;
   * and it gets the declaration WHOLE, `writeOnly` markers and all, where every wire path
   * gets `served`'s stripped outputSchema (§7 — the co-opt never reaches a consumer, but
   * the Recording pane's "declared writeOnly" rows and the Catalog details' result table
   * are readings OF the declaration and have nothing else to read). Every wire path leaves
   * this false.
   */
  owner = false,
): Promise<ListedItem[]> {
  // deps: registry.getApp · registry.resolveAccess · selectBackend · virtualPmcpApp
  const registry = new Registry(env.DB);
  const app = slug === PMCP_SLUG ? virtualPmcpApp(ownerId) : await registry.getApp(ownerId, slug);
  // The door already answered 404 for a slug this caller cannot see, so a miss here is
  // the same not-permitted answer every other unresolvable name gets.
  if (app === null) throw notPermitted();
  const filter = await registry.resolveAccess(ctx.principal, app);
  if (app.archived && !owner) throw archived();
  const catalog = await LIST_CATALOG[kind](selectBackend(app), app, { ...ctx, roles: filter.roleNames });
  const listed = filter.filterList(catalog, kind);
  return owner ? listed : listed.map(served);
}

/**
 * The owner's own view of one app's catalog — `/apps/<slug>`'s ONE read path for tools,
 * prompts, resources and templates (§13), and deliberately `listScoped` under the OWNER
 * principal rather than a second read: an owner resolves to the everything-filter, so
 * "unfiltered by §7 step 2" holds by construction and cannot drift from what the door
 * would answer. Never audited, like every other listing (§15).
 *
 * Three things a page needs that the wire cannot say. First, "unreadable" as distinct from
 * "empty": a needs-reconnect credential (-32000 from the refresh) and an upstream that
 * never answered at all (`dial`'s own catch, which never reaches JSON-RPC) BOTH leave
 * through the failure arm, so the page renders a blank marker — an unread count is not an
 * empty set. Second, an ARCHIVED app's retained catalog, which §13 keeps on the archived
 * page while the wire refuses it -32002 before reading anything. Third, the declaration
 * WHOLE: `served` strips `writeOnly: true` from every outputSchema on its way to a
 * consumer (§7), and the page is not a consumer — it is the surface that SHOWS the owner
 * what their app declared, so a stripped schema would leave "declared writeOnly by the
 * app" unsayable on the Recording pane and unshowable in the Catalog's result table.
 */
export async function ownerCatalog(
  env: Env,
  ownerId: string,
  slug: string,
  kind: ListKind,
): Promise<{ ok: true; items: ListedItem[] } | { ok: false; failure: HubError }> {
  // deps: admin.owner · listScoped · registry.allocateTypescriptNames
  try {
    // Inside the try because the username is READ, never synthesized — a forwarded
    // identity header must never carry an internal id (§7) — so a namespace with no user
    // row leaves as an unreadable catalog like any other, not as a crashed page render.
    const ctx: BackendCtx = { principal: await namespaceOwner(ownerId), roles: [] };
    // Bounded here rather than left to the per-fetch timeout: a page's four family reads
    // are what an owner waits on, and an endpoint that accepts a connection and then says
    // nothing would otherwise hold the answer for a whole CALL_TIMEOUT_MS. The rejection
    // leaves through the catch below as the ordinary unreadable-catalog failure, which is
    // exactly what the unread marker already renders.
    const items = await withDeadline(
      listScoped(env, ownerId, slug, ctx, kind, true),
      OWNER_CATALOG_DEADLINE_MS,
      "timeout",
    );
    // A successful canonical tools listing is also the discovery boundary for §23.6's
    // stable names. The page and runtime therefore consume one reservation map rather than
    // independently deriving TypeScript paths.
    if (kind === "tools") {
      const registry = new Registry(env.DB);
      const app = await registry.getApp(ownerId, slug);
      if (app !== null) {
        await registry.allocateTypescriptNames([
          {
            appId: app.id,
            service: slug,
            tools: items.flatMap((item) => (typeof item.name === "string" ? [item.name] : [])),
          },
        ]);
      }
    }
    return { ok: true, items };
  } catch (err) {
    // identity's convention: a thrown Response is never ours to swallow.
    if (err instanceof Response) throw err;
    // Everything else is "this catalog could not be read" — the two upstream failure
    // mechanisms above arrive as HubErrors; anything else is reported as the same -32000
    // rather than crashing a page render.
    return { ok: false, failure: err instanceof HubError ? err : unavailable() };
  }
}

/** §7's per-upstream deadline inside a catalog read or a bounded inner operation; the timer
 *  never outlives the race. `failureClass` names the cause for the ledger (`unavailable`'s
 *  at-most-once table decides what the consumer is told), absent for the collector's own
 *  omission path, which never surfaces as a wire error at all. */
async function withDeadline<T>(work: Promise<T>, ms: number, failureClass?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable(failureClass)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One listed item as served to a consumer: the hub's internal result-secret marker stripped
 * from the outputSchema, the inputSchema untouched (there `writeOnly` is standard usage,
 * §7). Total over the four families rather than tools-only — the other three carry no
 * outputSchema, so this is their identity, and one transform on one listing path beats a
 * per-family branch that has to be got right twice.
 */
function served(item: ListedItem): ListedItem {
  if (item.outputSchema === undefined) return item;
  return { ...item, outputSchema: withoutWriteOnly(item.outputSchema) as Record<string, unknown> };
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

// ══ §23 — the virtual hub: access, the catalog collector, and its two calls ════════════
//
// §23.1's `hub` is a virtual service: no D1 row, never archived, always availability-
// probeable, `logBodies: false`, and — like `pmcp` — reachable only through the namespace's
// own credentials. It has no backend, so nothing here dials one: `search_types` is computed
// from the caller-visible snapshot below, `execute` is handed to the injected QuickJS executor
// (hub-backend.ts's seam), and its resources are its own declarations. What it SHARES with
// every other request is the outer exit: one metadata-only audit row per tools/call, written
// by the same `recordDispatch`, under app `hub` and the canonical tool name.

/**
 * §23.1's synthetic access filter: the virtual hub's whole admitted surface — its two tools
 * (both endpoint spellings) and its own declaration URIs/templates — never built from
 * grants, never persisted, and never consulted for a real app. `check` is the admission
 * authority the two hub methods use, which is what makes an unknown name, a malformed name
 * and a URI the hub does not publish all the same indistinguishable -32001.
 *
 * `roleNames` is `["all"]` because the hub's surface is the hub's own (the filter is never
 * forwarded anywhere: a hub tool's inner operations resolve THEIR app's filter through the
 * dispatch seam). `filterList` mirrors `buildToolFilter`'s shape — the same subject key per
 * family, the same family-to-patterns mapping — so it cannot disagree with it about which
 * key a family is matched on.
 */
function hubAccess(): ToolFilter {
  function check(subject: string, family: RoleFamily = "tools"): AccessMode {
    if (family === "resources") return parseHubDeclarationUri(subject) === null ? "deny" : "allow";
    return HUB_TOOLS.some((tool) => tool.name === subject || tool.aggregateName === subject) ? "allow" : "deny";
  }
  return {
    check,
    filterList: (items, kind = "tools") =>
      items.filter((item) => {
        const subject = item[subjectKeyOf(kind)];
        return typeof subject === "string" && check(subject, patternFamilyOf(kind)) !== "deny";
      }),
    roleNames: ["all"],
  };
}

/** One app the collector is about to read, plus the families the hub was TOLD it serves —
 *  a proxied app's owner configuration, or the builtin's fixed tools-only answer. A tunneled
 *  app's declaration is read from its DO inside the read: only the DO knows it. */
type HubServiceTarget = { app: App; capabilities: readonly AppCapability[] };

/** One service's fetched families and its caller-visible diagnostics, before the snapshot
 *  is built. `null` marks a family that could not be read (or was never fetched because the
 *  app does not declare it) — an omission, never an empty catalog. */
type HubServiceRead = {
  app: App;
  filter: ToolFilter;
  tools: Tool[] | null;
  resources: Resource[] | null;
  resourceTemplates: ResourceTemplate[] | null;
  diagnostics: string[];
};

/**
 * §23.5 — the caller-visible catalog snapshot: the immutable value declarations, search and
 * `execute` all read, built fresh per request and never persisted. In canonical service
 * order it selects the apps this caller may see (excluding the virtual hub), adds the
 * virtual `pmcp` builtin for user/admin credentials alone, skips archived rows, reads each
 * declared family under its own deadline, ALLOCATES durable TypeScript names from the
 * unfiltered canonical families before applying the caller's grant filter, and records
 * bounded diagnostics for everything omitted.
 *
 * "Caller-visible" means exactly what a scoped listing would serve: `listAppsFor` (an agent
 * sees only apps it holds grants on, an admin sees no real apps at all) and
 * `resolveAccess`'s `filterList` per family. The snapshot is a moment, not an authority: a
 * revoked grant still refuses the next inner operation, and a name a program already saw
 * lives at most one execution deadline.
 */
async function collectHubCatalog(env: Env, principal: Principal, ownerId: string): Promise<CatalogSnapshot> {
  const registry = new Registry(env.DB);
  // §23.5.2: an admin token's program catalog is its `pmcp` subset and nothing else — the
  // owner's own rows are not its business, and `listAppsFor` would happily return them.
  const visible: AppDetail[] = principal.kind === "admin" ? [] : await registry.listAppsFor(principal);
  const targets: HubServiceTarget[] = visible
    .filter((app) => !app.archived && app.slug !== HUB_SLUG)
    .map((app) => ({ app, capabilities: app.capabilities ?? DEFAULT_APP_CAPABILITIES }));
  // The builtin joins for user/admin credentials; an agent can hold no grants on it (§8).
  if (principal.kind !== "agent") targets.push({ app: virtualPmcpApp(ownerId), capabilities: ["tools"] });
  targets.sort((left, right) => (left.app.slug < right.app.slug ? -1 : left.app.slug > right.app.slug ? 1 : 0));

  const reads = await Promise.all(targets.map((target) => readHubService(env, registry, target, principal)));
  const plan = await allocateHubNames(registry, reads);
  return buildCatalogSnapshot({ services: reads.map((read) => hubServiceInput(read, plan)) });
}

/**
 * One service's families, under §23.5's per-family deadline. The filter is resolved FIRST
 * and passed to the backend as `roles`, so a family read is scoped the same way a scoped
 * listing scopes it; the FETCHED list stays unfiltered, because alias allocation runs over
 * the canonical family and only the published snapshot is filtered.
 */
async function readHubService(
  env: Env,
  registry: Registry,
  target: HubServiceTarget,
  principal: Principal,
): Promise<HubServiceRead> {
  const { app } = target;
  const filter = await registry.resolveAccess(principal, app);
  const ctx: BackendCtx = { principal, roles: filter.roleNames };
  const backend = selectBackend(app);
  // A tunneled app's declaration lives in its DO, and only the DO knows it; every other
  // target (a proxied app's owner configuration, the builtin's fixed tools-only answer)
  // carries its own — the builtin is NOT dialed, because no DO row exists for it.
  const declared =
    app.kind === "tunnel" && app.slug !== PMCP_SLUG ? await tunnelCapabilities(app.id) : target.capabilities;
  const diagnostics: string[] = [];
  const tools = await readFamily(env, () => backend.listTools(app, ctx), app.slug, "tools", diagnostics);
  // §23.5.4: resource families are read only for an app that DECLARED the capability —
  // dialing a proxied upstream for a family its owner never declared is a wasted round trip
  // and a spurious failure diagnostic.
  const resourceCapable = declared.includes("resources");
  const resources = resourceCapable
    ? await readFamily(env, () => backend.listResources(app, ctx), app.slug, "resources", diagnostics)
    : [];
  const resourceTemplates = resourceCapable
    ? await readFamily(env, () => backend.listResourceTemplates(app, ctx), app.slug, "resource templates", diagnostics)
    : [];
  return { app, filter, tools, resources, resourceTemplates, diagnostics };
}

/**
 * One family of one app's catalog, bounded by the hub's per-family deadline. A failure — a
 * slow or failing upstream, a DO that cannot be reached — omits the family with one bounded
 * diagnostic naming the service and the family, and NOTHING of the backend's own error: a
 * refusal's class can carry an upstream status or a credential state, and neither belongs in
 * a value an untrusted program reads. The family's entries never partially survive: a read
 * either answered whole or is an omission.
 */
async function readFamily<T>(
  env: Env,
  read: () => Promise<T[]>,
  slug: string,
  family: string,
  diagnostics: string[],
): Promise<T[] | null> {
  try {
    return await withDeadline(read(), deadlines(env).hubCatalogDeadlineMs);
  } catch {
    diagnostics.push(`the ${family} catalog of service "${slug}" could not be read`);
    return null;
  }
}

/**
 * §23.5/§23.6 — allocates durable TypeScript names from the UNFILTERED fetched families,
 * before caller filtering, and answers the committed plan (null when the write could not
 * commit). `tools: null` disables disappearance retirement for that app: an unreachable
 * family and an empty one are not the same fact, and only a fetched list may retire a name.
 *
 * The virtual builtin is excluded: it has no row, so no reservation can hang from it — its
 * fixed root name and generated tool names are allocated locally by `hubServiceInput`.
 */
async function allocateHubNames(registry: Registry, reads: readonly HubServiceRead[]): Promise<AliasPlan | null> {
  const members: AliasServiceMembers[] = reads
    .filter((read) => read.app.slug !== PMCP_SLUG)
    .map((read) => ({
      appId: read.app.id,
      service: read.app.slug,
      tools: read.tools === null ? null : read.tools.map((tool) => tool.name),
    }));
  try {
    return await registry.allocateTypescriptNames(members);
  } catch {
    // The realistic failure is a race with deletion or recreation between the listing read
    // and this write. The snapshot then degrades to "no TypeScript names" — declarations
    // render their diagnostic banner, search matches no application entry — rather than
    // failing the whole request, and nothing is published for a name that did not commit.
    return null;
  }
}

/**
 * §23.6 — the builtin `pmcp` service's TypeScript identity, allocated locally because the
 * virtual app has no row for a reservation to hang from. `pmcp` is a fixed ROOT member the
 * hub owns (no real app may claim it); its tools are the generated candidates over the
 * builtin's own stable op names, under the same rules the durable planner applies to real
 * apps — including the omission of a candidate two members would share.
 */
function pmcpTypeNames(tools: readonly string[]): { names: Map<string, string | null>; diagnostics: string[] } {
  const names = new Map<string, string | null>();
  const diagnostics: string[] = [];
  const contenders = new Map<string, string[]>();
  for (const tool of tools) {
    const candidate = generatedAlias(tool, "tool");
    if (candidate === null) {
      diagnostics.push(aliasDiagnosticMessage({ family: "tool", canonicalName: tool, typescriptName: null, reason: "no_segment" }));
      names.set(tool, null);
      continue;
    }
    if (aliasNameViolations(candidate, "tool").length > 0) {
      diagnostics.push(aliasDiagnosticMessage({ family: "tool", canonicalName: tool, typescriptName: candidate, reason: "too_long" }));
      names.set(tool, null);
      continue;
    }
    contenders.set(candidate, [...(contenders.get(candidate) ?? []), tool]);
  }
  for (const [candidate, members] of contenders) {
    if (members.length > 1) {
      for (const member of members) {
        diagnostics.push(
          aliasDiagnosticMessage({ family: "tool", canonicalName: member, typescriptName: candidate, reason: "simultaneous" }),
        );
        names.set(member, null);
      }
      continue;
    }
    names.set(members[0], candidate);
  }
  return { names, diagnostics };
}

/**
 * One service's contribution to the snapshot: its resolved TypeScript names, its entries
 * filtered by the caller's own access verdict, and the diagnostics the caller may see.
 *
 * Two visibility rules, both about not leaking what the caller cannot see. A PLAN
 * diagnostic names the member it is about, so only the members that survived filtering keep
 * theirs — an omitted contender the caller cannot see never surfaces through the service
 * that happened to hold it. And an entry the filter dropped is simply absent: no name, no
 * canonical identity, no diagnostic.
 */
function hubServiceInput(read: HubServiceRead, plan: AliasPlan | null): CatalogServiceInput {
  const { app, filter } = read;
  const resolved = plan?.services.find((service) => service.appId === app.id);
  const tools = filter.filterList(read.tools ?? [], "tools");
  const resources = filter.filterList(read.resources ?? [], "resources");
  const resourceTemplates = filter.filterList(read.resourceTemplates ?? [], "resourceTemplates");
  const builtin = app.slug === PMCP_SLUG ? pmcpTypeNames(tools.map((tool) => tool.name)) : null;
  const visibleTools = new Set(tools.map((tool) => tool.name));
  const planDiagnostics = (plan?.diagnostics ?? []).filter((diagnostic) =>
    diagnostic.family === "service"
      ? diagnostic.canonicalName === app.slug
      : visibleTools.has(diagnostic.canonicalName),
  );
  return {
    appId: app.id,
    service: app.slug,
    // The builtin's service name is the fixed root member; a real app's is the plan's.
    typescriptName: builtin === null ? resolved?.typescriptName ?? null : PMCP_SLUG,
    kind: app.slug === PMCP_SLUG ? "builtin" : app.kind,
    tools: tools.map((tool) => ({
      canonicalName: tool.name,
      typescriptName: builtin === null
        ? resolved?.tools.find((member) => member.canonicalName === tool.name)?.typescriptName ?? null
        : builtin.names.get(tool.name) ?? null,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // §7's result-secret co-opt: the OUTPUT schema is served with `writeOnly` stripped,
      // exactly as the scoped listing serves it — the snapshot is consumer-facing data.
      outputSchema: tool.outputSchema === undefined ? undefined : withoutWriteOnly(tool.outputSchema),
    })),
    resources: resources.map((resource) => ({ uri: resource.uri, description: resource.description })),
    resourceTemplates: resourceTemplates.map((template) => ({
      uriTemplate: template.uriTemplate,
      description: template.description,
    })),
    diagnostics: [...read.diagnostics, ...planDiagnostics.map(aliasDiagnosticMessage), ...(builtin?.diagnostics ?? [])],
  };
}

/**
 * §23.1's `tools/call` on the hub: the two tools, and nothing else. The name is admitted by
 * the hub's own filter and resolved to its descriptor; an unknown or malformed name is the
 * same -32001 as not-permitted, refused BEFORE the audit path — there is no canonical tool
 * to record, and §15's `tool` column is not a place for unbounded caller text.
 *
 * One metadata-only row leaves this function, written after the try/catch like every other
 * dispatching method: app `hub`, the canonical tool name, the outcome and the duration. No
 * body is ever recorded — no source, query, snapshot, diagnostic or result — which is what
 * `logBodies: false` means for the virtual app and what §23.12 pins.
 *
 * `search_types` reads the snapshot and answers; `execute` validates against the owner's
 * settings, builds the same snapshot, refuses before launch on a catalog overflow, and hands
 * the admitted request to the injected QuickJS executor.
 */
async function hubCall(
  env: Env,
  caller: AuthenticatedCaller,
  ownerId: string,
  shape: EndpointShape,
  name: string,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
  lifecycle: HubRequestLifecycle,
): Promise<JsonRpcResponse> {
  if (hubAccess().check(name, "tools") === "deny") throw notPermitted();
  const tool = hubToolFor(shape, name);
  if (tool === null) throw notPermitted();

  const startedAt = Date.now();
  let outcome = "error";
  let value: unknown;
  let refusal: unknown;
  let detail: Record<string, unknown> | undefined;
  let finishAuditLifetime: (() => void) | undefined;
  if (tool.name === "execute" && lifecycle.waitUntil !== undefined) {
    // Keep the gateway continuation alive through its outer audit, not merely until the
    // Durable Object's cancellation and run promises have settled.
    const auditLifetime = new Promise<void>((resolve) => {
      finishAuditLifetime = resolve;
    });
    lifecycle.waitUntil(auditLifetime);
  }
  try {
    if (tool.name === "search_types") {
      value = hubSearchTypes(await collectHubCatalog(env, caller.principal, ownerId), msg.params?.arguments);
    } else {
      const settings = await new Registry(env.DB).hubExecutionSettings(ownerId);
      const request = hubExecuteRequest(msg.params?.arguments, settings);
      const snapshot = await collectHubCatalog(env, caller.principal, ownerId);
      // §23.5: an overflowing catalog refuses BEFORE Sandbox start — a deterministic,
      // non-transient limit, and nothing ran.
      value = snapshot.truncated
        ? { kind: "limit_exceeded", limit: "catalog", observed: snapshot.entryCount, transient: false, mayHaveRun: false }
        : await runHubExecution({
            caller,
            ownerId,
            code: request.code,
            timeoutMs: request.timeoutMs,
            // §23.8: the admitted budget is an ABSOLUTE instant, so it bounds the whole
            // path — the collection above included — and a later settings change cannot
            // extend it.
            deadlineAt: startedAt + request.timeoutMs,
            settings,
            snapshot,
            clientMeta: ctx.clientMeta,
            lifecycle,
          });
    }
    outcome = "ok";
  } catch (err) {
    // §23.4/§23.10: the executor's two out-of-band signals are mapped BEFORE the generic
    // handling. A revoked credential becomes the existing metadata-only -32001, with
    // nothing of the run published; an aborted request becomes a class-carrying -32000
    // (may-have-executed is the truth here) whose response nobody is reading.
    refusal = err instanceof HubCredentialRevokedError
      ? notPermitted()
      : err instanceof HubExecutionAbortedError
        ? unavailable("execution_aborted")
        : err;
    outcome = refusal instanceof HubError ? String(refusal.code) : "error";
    if (refusal instanceof HubError) detail = refusal.auditDetail;
  }
  try {
    await recordDispatch(env, {
      ownerId,
      ctx,
      event: "tools/call",
      slug: HUB_SLUG,
      tool: tool.name,
      outcome,
      durationMs: Date.now() - startedAt,
      bodies: {},
      detail,
    });
    if (value === undefined) throw refusal;
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      // The wire shape every tool result takes here: the structured half is the contract
      // (`outputSchema` pins it) and the text half is what a client without a schema reads —
      // the builtin's own result shape, for the same reason.
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    };
  } finally {
    finishAuditLifetime?.();
  }
}

/**
 * §23.1/§23.2's hub `resources/read`: the hub's own declaration URIs and nothing else. The
 * filter decides whether the URI is a hub declaration at all; the caller's snapshot then
 * decides whether it names a record this caller's catalog contains — so a URI for a service
 * or member the caller cannot see is refused exactly like a URI the hub never publishes
 * (-32001, indistinguishable from not-permitted).
 *
 * Exactly one audit row leaves, like every other read: the row's `tool` column is the URI
 * under §20.4's hygiene and the declaration TEXT is recorded nowhere.
 */
async function hubRead(env: Env, ownerId: string, msg: JsonRpcRequest, ctx: BackendCtx): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
  let outcome = "error";
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  try {
    if (hubAccess().check(uri, "resources") === "deny") throw notPermitted();
    const text = hubDeclarationText(await collectHubCatalog(env, ctx.principal, ownerId), uri);
    if (text === null) throw notPermitted();
    answer = {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: { contents: [{ uri, mimeType: "text/typescript", text }] },
    };
    outcome = "ok";
  } catch (err) {
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
  }
  await recordDispatch(env, {
    ownerId,
    ctx,
    event: "resources/read",
    slug: HUB_SLUG,
    tool: auditableUri(uri),
    outcome,
    durationMs: Date.now() - startedAt,
    bodies: {},
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/**
 * §23.10's trusted input to one `tools/call`: identity and addressing that arrived already
 * resolved, never a raw JSON-RPC message. The scoped route builds it from the consumer's
 * message; hub-quickjs.ts builds it from a program callable whose canonical target is
 * closed over, with admitted display metadata and ordinary arguments only.
 */
export type ToolDispatch = {
  /** The caller the door admitted (§7 step 1); its `principal` decides the owner, and its
   *  `credential` is what `reauthorizeCredential` re-proves. */
  caller: AuthenticatedCaller;
  /** The canonical app slug, addressed by the consumer or pinned in a snapshot. */
  slug: string;
  /** The canonical tool name — never a TypeScript alias. */
  tool: string;
  /** `params.arguments`, verbatim. */
  args?: Record<string, unknown>;
  /** Untrusted display-only client metadata for the audit row (§7). */
  clientMeta?: BackendCtx["clientMeta"];
  /** The consumer's `_meta`, carried for direct calls; absent for execution-originated
   * operations, which inherit no arbitrary outer `_meta` (§23.10). */
  meta?: Record<string, unknown>;
  /** MRTR answers from the consumer, preserved as a params-level sibling of `arguments`. */
  inputResponses?: unknown;
  /** MRTR continuation state from the consumer, preserved as a params-level sibling of `arguments`. */
  requestState?: unknown;
  /** The consumer's JSON-RPC id; absent for a bridge call, whose answer is not a consumer's. */
  id?: JsonRpcId;
  /** Absolute epoch-ms deadline for THIS operation (§23.10). Absent for direct calls. */
  deadlineAt?: number;
  /** §23.6 — the immutable app id an execution snapshot pinned: a slug that now resolves
   * to another app id is refused before dispatch with the existing not-permitted code. */
  expectAppId?: string;
  /** §23.4 — execution-originated dispatches set this: re-authorize the credential from its
   * non-secret reference and refuse -32001 unless the live principal key is unchanged,
   * BEFORE the app is resolved. A direct consumer call omits it: the door resolved this
   * very credential for this very request. */
  reauthorizeCredential?: boolean;
};

/**
 * The one tools/call pipeline — the scoped route's and §23.10's QuickJS host bridge's alike,
 * so a program's operation crosses exactly the checks a direct consumer call crosses.
 * `slug` and `tool` arrive already resolved and canonical, so approvals bind to the same row either way.
 * Runs the pinned order: resolve app → pinned-app-id check → filter (-32001 — an ungranted
 * agent learns nothing more), archived (-32002), availability (-32000 — §7 lists it last but
 * the availability-first decision puts it ahead of the approval gate, and one test serves
 * both), the call's redaction map (-32001 when no sound one exists, §7), then the approval
 * gate — approvals.check, the atomic claim, dispatch, settle: `-32003` with
 * { approvalId, approvalUrl, expiresAt } when a decision is still owed, and an MRTR
 * input_required leg restores the claim. A passing call is forwarded post-hygiene with
 * identity attached and relayed verbatim — what the CONSUMER receives is never redacted;
 * masking exists for persistence only.
 *
 * Exactly one audit row leaves this function, written after the try/catch: audit.record
 * is AWAITED with hub-measured duration — a failed audit write fails the call. When
 * the app's log_bodies is on AND the call was dispatched (§15 — refusal rows
 * never carry bodies), the entry carries the bodies: args
 * masked under the redaction map's args union (backend schema paths + config redact), the
 * result's structuredContent under its results union (backend + config
 * redact_results), each unstructured result block replaced by a blob BodyStub —
 * audit.record itself enforces the size cap. All
 * failures leave as HubError; only the caller of this seam maps them to the wire.
 */
export async function dispatchTool(env: Env, input: ToolDispatch): Promise<JsonRpcResponse> {
  // deps: identity.reauthorize · registry.getApp · registry.resolveAccess · registry.redactPathsFor · registry.applyRedaction · approvals.check · approvals.claim · approvals.settle · audit.record · selectBackend · virtualPmcpApp · probeAvailability · prepareForward
  const principal = input.caller.principal;
  const ownerId = principal.kind === "agent" ? principal.ownerId : principal.userId;
  const startedAt = Date.now();
  // The forwarded message is rebuilt from trusted addressing plus the ordinary fields this
  // method owns. MRTR continuations remain params-level siblings of `arguments`; neither is
  // allowed to disappear into `_meta` or the approval binding.
  const msg: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "tools/call",
    ...(input.id === undefined ? {} : { id: input.id }),
    params: {
      name: input.tool,
      ...(input.args === undefined ? {} : { arguments: input.args }),
      ...(input.inputResponses === undefined ? {} : { inputResponses: input.inputResponses }),
      ...(input.requestState === undefined ? {} : { requestState: input.requestState }),
      ...(input.meta === undefined ? {} : { _meta: input.meta }),
    },
  };
  const ctx: BackendCtx = {
    principal,
    roles: [],
    clientMeta: input.clientMeta,
    deadlineAt: input.deadlineAt,
  };
  const registry = new Registry(env.DB);
  // The row this call will leave, filled in by whichever branch below reaches an answer.
  // ONE exit: `recordDispatch` is invoked after the try/catch and nowhere else, which is what
  // makes "every path through dispatchTool ends in exactly one audit row" readable off the
  // control flow instead of inferred from which statements can throw. It also means a
  // failure in the ledger path can never masquerade as a refusal of the call it is
  // recording — a second, refusal-shaped row for a call that actually dispatched.
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = input.slug;
  let detail: Record<string, unknown> | undefined;
  try {
    // A bridge dispatch re-proves the credential inside the single audited path. The
    // refusal remains -32001, but now leaves the same canonical row as every other denial.
    if (input.reauthorizeCredential === true) await requireSamePrincipal(input.caller);
    const app =
      input.slug === PMCP_SLUG ? virtualPmcpApp(ownerId) : await registry.getApp(ownerId, input.slug);
    // A slug that resolves to no visible app: -32001, indistinguishable from
    // not-permitted, so tool names cannot enumerate a namespace (§7 step 3).
    if (app === null) throw notPermitted();
    recordedSlug = app.slug;
    // §23.6: the snapshot pinned an immutable app id, and a slug that now resolves to
    // another one is refused exactly like an app the caller cannot see.
    if (input.expectAppId !== undefined && app.id !== input.expectAppId) throw notPermitted();

    // 1 — filter. First, always: an ungranted agent may not learn that an app is
    // archived, unreachable, or even real.
    const filter = await registry.resolveAccess(ctx.principal, app);
    const mode = filter.check(input.tool);
    if (mode === "deny") throw notPermitted();

    // 2 — archived.
    if (app.archived) throw archived();

    const backend = selectBackend(app);
    const appCtx: BackendCtx = { ...ctx, roles: filter.roleNames };

    // 3 — availability, tested ONCE. §7 lists it last, after the approval gate, but the
    // 2026-08-25 availability-first decision puts it first INSIDE that gate: an app the
    // hub already knows cannot execute fails -32000 before any approval row is read,
    // created or consumed. Two sentences, one verdict, one place — a gated call and an
    // ungated one reach it at the same point, which is also what keeps the map below (a
    // backend round trip and a D1 read) off the path of a call that was never going to run.
    const unavailableAs = await probeAvailability(app);
    if (unavailableAs !== null) throw unavailableAs;

    // Derived ONCE for the whole call, so the approval row and the audit row of the same
    // call can never be masked under different maps (§15). Null means no sound map exists
    // for this tool and nothing downstream may run — -32001, the same code as
    // not-permitted, so the refusal cannot be used to map grant patterns (§7).
    const redaction = await redactionMapFor(registry, backend, app, input.tool);
    if (redaction === null) throw notPermitted();

    // 4 — the approval gate (owners are never routed into it; the filter answered
    // `allow` for them via the built-in `all`).
    const claim = mode === "approval"
      ? await passGate(env, app, input.tool, msg, redaction.args, ctx.principal)
      : undefined;

    // The forwarded message carries the canonical name, never a hub-local alias: the
    // address a consumer wrote is not the app's business.
    const forwarded = prepareForward(msg, appCtx);
    const relayed = await boundedCall(backend, app, forwarded, appCtx);
    // An MRTR input_required leg restores the pass; anything else leaves it spent.
    if (claim) await approvalsFor().settle(claim, relayed);
    // The hub's own outcome vocabulary (§15): an app that answered with a JSON-RPC
    // error was still reached, and `error` — not one of the hub's refusal codes — is
    // what that is.
    outcome = relayed.error === undefined ? "ok" : "error";
    if (app.logBodies) bodies = callBodies(redaction, msg, relayed);
    // Re-addressed to the consumer's own id; everything else is relayed verbatim.
    answer = { ...relayed, id: msg.id ?? null };
  } catch (err) {
    // §15: every tools/call leaves a row, denials included (they are just fast) — and a
    // refusal row NEVER carries bodies, whatever the app's log_bodies says.
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
    bodies = {};
    // §7: every dispatch failure class collapses into one -32000, and the real class
    // survives ONLY here — which is what lets an owner tell expired static headers from a
    // down upstream, or a tunnel that was offline from one that timed out (§15's
    // at-most-once). ONE rule for every backend: whichever layer knew the cause attached
    // it to the error, and this function decides nothing about what a backend is allowed
    // to record. §15's hygiene travels with the field (HubError.auditDetail).
    if (err instanceof HubError) detail = err.auditDetail;
  }
  await recordDispatch(env, {
    ownerId,
    ctx,
    event: "tools/call",
    slug: recordedSlug,
    tool: input.tool,
    outcome,
    durationMs: Date.now() - startedAt,
    bodies,
    detail,
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/** §23.4 — the one liveness check a mid-execution operation adds to a door-resolved caller:
 *  re-authorize the non-secret reference and require the same principal key. Refuses -32001
 *  (never a distinct code), so a revoked credential is indistinguishable from an ungranted
 *  one at this seam. */
async function requireSamePrincipal(caller: AuthenticatedCaller): Promise<void> {
  if (!(await reauthorizeCaller(caller))) throw notPermitted();
}

/**
 * §23.4 — `requireSamePrincipal` as a verdict rather than a refusal, for the QuickJS
 * executor's two call sites: the per-host-operation check (which the dispatch seams do
 * themselves, via `reauthorizeCredential`) and the pre-PUBLICATION check, whose failure
 * discards a finished run's value, stdout and stderr. Answers false for every
 * refusal and never leaks which one — a revoked row, an expired reference, a deleted agent
 * and a rebound principal are one answer, exactly like the door's.
 */
export async function reauthorizeCaller(caller: AuthenticatedCaller): Promise<boolean> {
  const current = await reauthorize(caller.credential.reference);
  return current !== null && principalKey(current) === principalKey(caller.principal);
}

/**
 * §23.10 — one backend call under the effective inner deadline: the earlier of the caller's
 * absolute deadline and the hub-inner cap. A direct call (`deadlineAt` absent) is unchanged —
 * the backend's own `CALL_TIMEOUT_MS` is the whole budget — and an operation whose deadline
 * has already passed never starts at all. The timeout class rides `auditDetail` like every
 * other class; the message's at-most-once warning is correct here, because a call that timed
 * out may have reached the app.
 */
async function boundedCall(
  backend: AppBackend,
  app: App,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  if (ctx.deadlineAt === undefined) return backend.call(app, msg, ctx);
  const remaining = ctx.deadlineAt - Date.now();
  if (remaining <= 0) throw unavailable("deadline_passed");
  return withDeadline(backend.call(app, msg, ctx), Math.min(remaining, HUB_INNER_OPERATION_TIMEOUT_MS), "timeout");
}

/**
 * §7's approval gate: check → claim, and nothing before them. Its two preconditions are
 * the caller's, tested once each in dispatchTool above — the app is available (§7's
 * availability-first clause: no pending row, no push, no existing pass touched for a
 * app the hub already knows cannot execute) and the call's redaction map is derived,
 * so the approval row and the audit row of the same call cannot be masked differently
 * (§15). A lost claim is no approval at all: re-entering check is what opens the fresh
 * pending row §7 step 1 hands back as -32003.
 */
async function passGate(
  env: Env,
  app: App,
  tool: string,
  msg: JsonRpcRequest,
  redactPaths: string[],
  principal: Principal,
): Promise<ApprovalClaim> {
  const gate = approvalsFor();
  const args = argumentsOf(msg);

  let verdict = await gate.check(principal, app, tool, args, redactPaths);
  while (verdict.outcome === "ok") {
    const claim = await gate.claim(verdict.approvalId);
    if (claim !== "lost") return claim;
    // A concurrent identical call consumed the pass: treat it as no approval and fall
    // through to step 2, which is exactly what a fresh check does.
    verdict = await gate.check(principal, app, tool, args, redactPaths);
  }
  throw approvalRequired(verdict);
}

/**
 * §7's per-direction redaction map for ONE call, derived exactly once and handed to every
 * site that masks anything: the approval row's arguments and the audit row's bodies alike.
 * Each direction is the union of the backend's SCHEMA-declared paths (`writeOnly`) with
 * the app's configured ones (`redact` / `redact_results`).
 *
 * Null has ONE meaning here — no sound map can exist for this tool (unknown to the
 * backend, or its cached schema tripped registry.validateSchemaIndirection) — and one
 * consequence, taken by dispatchTool at the gate: -32001, the same code as not-permitted, so
 * the refusal cannot be used to map grant patterns (§7). Nothing downstream runs, and no
 * body is ever recorded for such a tool (§15).
 */
async function redactionMapFor(
  registry: Registry,
  backend: AppBackend,
  app: App,
  tool: string,
): Promise<{ args: string[]; results: string[] } | null> {
  // deps: AppBackend.sensitivePaths · registry.redactPathsFor
  const schemaPaths = await backend.sensitivePaths(app, tool);
  if (schemaPaths === null) return null;
  return {
    args: union(schemaPaths.args, await registry.redactPathsFor(app, tool, "args")),
    results: union(schemaPaths.results, await registry.redactPathsFor(app, tool, "results")),
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
 * The audit bodies of a DISPATCHED call whose app opts into them (§15): arguments
 * masked under the args union, `structuredContent` under the results union, and every
 * unstructured content block replaced by a blob stub — bytes never stored. `redaction` is
 * the call's ONE map (redactionMapFor), which is why a tool with no derivable map cannot
 * reach here at all: dispatchTool refused it at the gate.
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

/**
 * The one audit write of every DISPATCHING method — `tools/call`, `prompts/get`,
 * `resources/read` and §21.6's two per-URI methods alike (§15, §20.4, §21.6). Every path
 * through each of those five ends in
 * exactly one call to this function, invoked after the try/catch and nowhere else, which is
 * what makes "one row per call" readable off the control flow rather than inferred from
 * which statements can throw. One row shape, one place for it to change.
 */
async function recordDispatch(
  env: Env,
  entry: {
    ownerId: string;
    ctx: BackendCtx;
    /** The audited event — `tool` is the call's tool name, a prompt's name, or §20.4's
     *  hygiened resource URI (which §21.6 gives the two subscription methods too),
     *  whichever this event addresses. */
    event:
      | "tools/call"
      | "prompts/get"
      | "resources/read"
      | "resources/subscribe"
      | "resources/unsubscribe";
    slug: string;
    tool: string;
    outcome: string;
    durationMs: number;
    bodies: CallBodies;
    /** The upstream failure class, on the rows that had one (§7) — never a body fragment.
     *  A read never carries one: only a call's refusal classes are worth a class. */
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await record(env.DB, {
    ownerId: entry.ownerId,
    principal: formatPrincipal(entry.ctx.principal),
    event: entry.event,
    app: entry.slug,
    tool: entry.tool,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    client: entry.ctx.clientMeta,
    args: entry.bodies.args,
    result: entry.bodies.result,
    detail: entry.detail,
  });
}

// ══ §20.2 — prompts/get and resources/read: the two audited reads ═════════════════════
//
// Both share the pipeline `dispatchTool` runs, minus two things: NO approval gate (§18
// decision 27 — a read is never gated), and no redaction-map-required gate either — a
// prompt or a resource has no catalog-miss concept, because neither carries a schema for
// `sensitivePaths` to walk in the first place (§20.3). What is left is exactly §7's other
// three checks, in order: filter (-32001) → archived (-32002) → availability (-32000).
// Each ends in exactly one audit row, like a call (§20.4) — the same `recordDispatch`,
// invoked after the try/catch and nowhere else, for the same reason `dispatchTool` does it.

/**
 * §20.2's `prompts/get` pipeline, scoped-only (the hub shapes list no prompts and refuse
 * this method in `hubRoute`) and reached with `slug`/`name` already read off the message.
 * Bodies (§20.3/§20.4): arguments are recorded ONLY
 * when the app's `redact` map names this prompt — with no entry, prompts carry no
 * writeOnly channel to earn §15's tunneled default, so nothing is recorded regardless of
 * `log_bodies` or the backend's kind; the result's message content blocks are always
 * stubbed, never text, whenever `log_bodies` is on and the call dispatched. An
 * `input_required` leg relays verbatim — no field is added, none is stripped.
 */
async function getPrompt(
  env: Env,
  ownerId: string,
  slug: string,
  name: string,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  // deps: registry.getApp · registry.resolveAccess · registry.redactPathsFor · selectBackend · virtualPmcpApp · probeAvailability · prepareForward · audit.record
  const startedAt = Date.now();
  const registry = new Registry(env.DB);
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = slug;
  try {
    const app = slug === PMCP_SLUG ? virtualPmcpApp(ownerId) : await registry.getApp(ownerId, slug);
    if (app === null) throw notPermitted();
    recordedSlug = app.slug;

    // 1 — filter, matched by NAME against the caller's prompt patterns (§20.2).
    const filter = await registry.resolveAccess(ctx.principal, app);
    if (filter.check(name, "prompts") === "deny") throw notPermitted();
    // 2 — archived.
    if (app.archived) throw archived();
    // 3 — availability. No approval gate follows it (§18 decision 27).
    const unavailableAs = await probeAvailability(app);
    if (unavailableAs !== null) throw unavailableAs;

    const appCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, name } }, appCtx);
    const relayed = await selectBackend(app).call(app, forwarded, appCtx);
    outcome = relayed.error === undefined ? "ok" : "error";
    if (app.logBodies) bodies = await promptBodies(registry, app, name, msg, relayed);
    answer = { ...relayed, id: msg.id ?? null };
  } catch (err) {
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
    bodies = {};
  }
  await recordDispatch(env, {
    ownerId,
    ctx,
    event: "prompts/get",
    slug: recordedSlug,
    tool: name,
    outcome,
    durationMs: Date.now() - startedAt,
    bodies,
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/**
 * A dispatched `prompts/get`'s audit bodies (§20.3/§20.4). Arguments: the config `redact`
 * map, matched family-blind under the tool-name grammar (registry.redactPathsFor is
 * already generic over the key) — an EMPTY match list means no entry names this prompt,
 * which is the one place §20.3 withholds the body entirely rather than recording an
 * unmasked empty object; a non-empty list masks and records the whole thing, exactly like
 * a tool's arguments. Result: every message's content block replaced by a typed size stub
 * — never text — the same rule §15 already applies to unstructured tool-call content.
 */
async function promptBodies(
  registry: Registry,
  app: App,
  name: string,
  msg: JsonRpcRequest,
  relayed: JsonRpcResponse,
): Promise<CallBodies> {
  const bodies: CallBodies = {};
  const paths = await registry.redactPathsFor(app, name, "args");
  if (paths.length > 0) bodies.args = applyRedaction(argumentsOf(msg) ?? {}, paths);
  const messages = (relayed.result as { messages?: unknown } | undefined)?.messages;
  bodies.result = Array.isArray(messages) ? { messages: messages.map(stubMessage) } : {};
  return bodies;
}

/** One prompt message, as the ledger keeps it: the role verbatim, the content block
 *  stubbed — a message carries no other field §15's body columns are for. */
function stubMessage(message: unknown): Record<string, unknown> {
  const carrier = (message ?? {}) as { role?: unknown; content?: unknown };
  return { role: carrier.role, content: blobStub(carrier.content) };
}

/**
 * §23.10's trusted input to one `resources/read`, the twin of `ToolDispatch`: identity and
 * addressing arrive resolved, and the URI is the app's OWN raw URI — never prefixed,
 * normalized or reverse-translated from a hub alias (§23.7).
 */
export type ResourceDispatch = {
  /** The caller the door admitted. */
  caller: AuthenticatedCaller;
  /** The canonical app slug the read is addressed to. */
  slug: string;
  /** The raw resource URI, exactly as the application serves it. */
  uri: string;
  /** Untrusted display-only client metadata for the audit row (§7). */
  clientMeta?: BackendCtx["clientMeta"];
  /** The consumer's `_meta`, carried for direct calls; absent for execution-originated operations. */
  meta?: Record<string, unknown>;
  /** The consumer's JSON-RPC id; absent for a host operation. */
  id?: JsonRpcId;
  /** Absolute epoch-ms deadline for THIS read (§23.10). Absent for direct calls. */
  deadlineAt?: number;
  /** §23.6 — the immutable app id an execution snapshot pinned; a slug resolving elsewhere
   * is refused -32001. */
  expectAppId?: string;
  /** §23.4 — see `ToolDispatch.reauthorizeCredential`; identical here. */
  reauthorizeCredential?: boolean;
};

/**
 * §20.2's `resources/read` pipeline and §23.10's second dispatch seam — the scoped route's
 * and the QuickJS host bridge's alike — matched by `uri` (never `name`, §20.2) against the
 * caller's resource patterns. Two things it alone does: the outgoing result is decorated
 * (§20.4 — `cacheScope: "public"` downgraded to `"private"`, and a still-pending MRTR
 * exchange never given a `ttlMs`), and the audited `tool` column is the URI itself, put
 * through §20.4's own hygiene (auditableUri) before it ever reaches `record` — dropped
 * query, capped length, §15's token grammar scrubbed. Resource reads carry no argument body
 * at all (§20.4); only the result is ever recorded.
 */
export async function dispatchResourceRead(env: Env, input: ResourceDispatch): Promise<JsonRpcResponse> {
  // deps: identity.reauthorize · registry.getApp · registry.resolveAccess · selectBackend · virtualPmcpApp · probeAvailability · prepareForward · audit.record
  const principal = input.caller.principal;
  const ownerId = principal.kind === "agent" ? principal.ownerId : principal.userId;
  const startedAt = Date.now();
  const msg: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "resources/read",
    ...(input.id === undefined ? {} : { id: input.id }),
    params: {
      uri: input.uri,
      ...(input.meta === undefined ? {} : { _meta: input.meta }),
    },
  };
  const ctx: BackendCtx = {
    principal,
    roles: [],
    clientMeta: input.clientMeta,
    deadlineAt: input.deadlineAt,
  };
  const registry = new Registry(env.DB);
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = input.slug;
  try {
    // Revocation is itself a dispatch decision and therefore belongs inside the one
    // audited path rather than escaping before the row is initialized.
    if (input.reauthorizeCredential === true) await requireSamePrincipal(input.caller);
    const app =
      input.slug === PMCP_SLUG ? virtualPmcpApp(ownerId) : await registry.getApp(ownerId, input.slug);
    if (app === null) throw notPermitted();
    recordedSlug = app.slug;
    if (input.expectAppId !== undefined && app.id !== input.expectAppId) throw notPermitted();

    const filter = await registry.resolveAccess(ctx.principal, app);
    if (filter.check(input.uri, "resources") === "deny") throw notPermitted();
    if (app.archived) throw archived();
    const unavailableAs = await probeAvailability(app);
    if (unavailableAs !== null) throw unavailableAs;

    const appCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward(msg, appCtx);
    const relayed = await boundedCall(selectBackend(app), app, forwarded, appCtx);
    outcome = relayed.error === undefined ? "ok" : "error";
    const result = relayed.result as Record<string, unknown> | undefined;
    if (app.logBodies && result !== undefined) bodies.result = resourceReadBody(result);
    answer = {
      ...relayed,
      id: msg.id ?? null,
      ...(result === undefined ? {} : { result: decorateReadResult(result) }),
    };
  } catch (err) {
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
    bodies = {};
  }
  await recordDispatch(env, {
    ownerId,
    ctx,
    event: "resources/read",
    slug: recordedSlug,
    tool: auditableUri(input.uri),
    outcome,
    durationMs: Date.now() - startedAt,
    bodies,
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/** A dispatched `resources/read`'s one body: every content entry stubbed, never bytes —
 *  there is no argument channel for a read, so this is the whole of `bodies` (§20.4). */
function resourceReadBody(result: Record<string, unknown>): Record<string, unknown> {
  const contents = result.contents;
  return Array.isArray(contents) ? { contents: contents.map(blobStub) } : {};
}

/**
 * §20.4's two relay adjustments, applied to the OUTGOING result — never to what is
 * recorded, which stubs contents unconditionally. `cacheScope: "public"` is downgraded to
 * `"private"` unconditionally (the hub's authorization context is per-token, so a public
 * result from an authenticated endpoint could be shared across access tokens); a result
 * still mid MRTR exchange (`resultType: "input_required"`, or simply carrying
 * `requestState`) is never given a `ttlMs` — an exchange in flight is not a cacheable
 * answer. Every other field, `ttlMs` on a genuinely complete result included, passes
 * through untouched: this hub mints no cache hint of its own for a read, unlike a listing.
 */
function decorateReadResult(result: Record<string, unknown>): Record<string, unknown> {
  const pending = result.resultType === "input_required" || result.requestState !== undefined;
  const decorated = { ...result };
  if (decorated.cacheScope === "public") decorated.cacheScope = "private";
  if (pending) delete decorated.ttlMs;
  return decorated;
}

/**
 * §20.4's URI hygiene, applied before a resource URI ever reaches `audit.tool` — three
 * rules, in order, because a later one must never re-expose what an earlier one removed:
 * the query component is DROPPED (not pattern-scrubbed) and replaced by `REDACTED_QUERY`,
 * because a query string is a routine carrier of somebody else's bearer token and §15's
 * own grammar cannot see it; §15's `pmcp_(agt|app)_` grammar is then applied to whatever is
 * left (the query rule cannot reach a token-shaped segment sitting in the PATH); and the
 * result is capped at AUDIT_URI_CAP_BYTES, like every other caller-supplied string the hub
 * persists.
 */
function auditableUri(uri: string): string {
  const at = uri.indexOf("?");
  const withoutQuery = at < 0 ? uri : `${uri.slice(0, at)}${REDACTED_QUERY}`;
  const scrubbed = withoutQuery.replace(TOKEN_GRAMMAR, REDACTED);
  return capUtf8Bytes(scrubbed, AUDIT_URI_CAP_BYTES);
}

/** §15's credential grammar, built from the leaf that owns the wire spelling (principal.ts)
 *  — the same construction audit.ts's own Sentry scrubber uses, applied here to the one
 *  caller-supplied string that rule did not already cover: a resource URI (§20.4). */
const TOKEN_GRAMMAR = tokenPattern(1, "g");

/** Truncates at a UTF-8 byte boundary — capped, never replaced, so the readable head of an
 *  over-long value survives (§20.4). A boundary that lands mid-codepoint decodes with the
 *  standard replacement character rather than throwing; a byte cap can promise no more. */
function capUtf8Bytes(value: string, capBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= capBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, capBytes));
}

// ══ §20.2 — completion/complete: filtered by its `ref`, and never audited ═════════════
//
// A relay, not a pass-through (§20.2): the `ref` is checked against the caller's patterns
// BEFORE anything reaches the app, because unfiltered this method is a read straight
// past the role's patterns. Listing-class for audit (§20.4) — no row, refusals included —
// because the refusal is what makes the method safe, and a row per keystroke would be
// polling noise from a method a client calls on every one.

/**
 * §20.2's `completion/complete` pipeline, scoped-only (both hub shapes refuse this
 * method in `hubRoute` before a slug is ever resolved). Filter → archived → availability,
 * exactly like `getPrompt`/`dispatchResourceRead`; no redaction, no bodies, no audit row.
 */
async function completeRef(
  env: Env,
  ownerId: string,
  slug: string,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  // deps: registry.getApp · registry.resolveAccess · selectBackend · virtualPmcpApp · probeAvailability · prepareForward
  const registry = new Registry(env.DB);
  const app = slug === PMCP_SLUG ? virtualPmcpApp(ownerId) : await registry.getApp(ownerId, slug);
  if (app === null) throw notPermitted();
  const target = refTarget(msg);
  // A `ref` naming neither a prompt nor a resource template matches no pattern in any
  // family — the same -32001 an unmatched one gets, never a distinct "malformed ref" code.
  if (target === null) throw notPermitted();

  const filter = await registry.resolveAccess(ctx.principal, app);
  if (filter.check(target.subject, target.family) === "deny") throw notPermitted();
  if (app.archived) throw archived();
  const unavailableAs = await probeAvailability(app);
  if (unavailableAs !== null) throw unavailableAs;

  const appCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
  const forwarded = prepareForward(msg, appCtx);
  const relayed = await selectBackend(app).call(app, forwarded, appCtx);
  return { ...relayed, id: msg.id ?? null };
}

/**
 * A `completion/complete` request's `ref`, resolved to the (subject, family) pair §20.2
 * judges it by: `ref/prompt` matched by NAME against the prompt patterns, `ref/resource`
 * matched by its raw `uri` (a template string, never expanded) against the resource
 * patterns. Null for anything else — the caller refuses it exactly like an unmatched ref.
 */
function refTarget(msg: JsonRpcRequest): { subject: string; family: RoleFamily } | null {
  const ref = msg.params?.ref as { type?: unknown; name?: unknown; uri?: unknown } | undefined;
  if (ref?.type === "ref/prompt" && typeof ref.name === "string") return { subject: ref.name, family: "prompts" };
  if (ref?.type === "ref/resource" && typeof ref.uri === "string") return { subject: ref.uri, family: "resources" };
  return null;
}

// ══ §21 — the held listen stream, and the two per-URI methods ══════════════════════════
//
// One method whose answer is a `text/event-stream` this invocation then HOLDS (§21.1), and
// two that mutate the subscription set on the socket feeding it (§21.4).
//
// What makes this the SAME door and not a second one: the open resolves nothing itself —
// it is handed the principal index.mcpEntry already resolved — reads the grant set through
// the very calls every other scoped method makes (`getApp`), and its re-authorization tick
// re-runs §7 step 1 by CALLING the door's verdict (`Reauthorize`, constructed once in
// index.ts) rather than re-deciding it here. The only things this section decides for
// itself are what a stream writes and when it stops.
//
// NOT here: what rings (the DO's, tunnel.ts — it rings every subscriber socket it holds and
// knows no endpoint shapes), nor what a bell frame looks like or which shape serves it
// (capabilities.ts — this section only asks `admits`).

/** §21.1's one method whose answer is a held response rather than a JSON-RPC envelope. */
const LISTEN_METHOD = "subscriptions/listen";

/**
 * §21.1's correlation header, in both directions: the hub MINTS one on every stream it
 * opens — a client-supplied value is never echoed, so the id's shape and uniqueness are the
 * hub's own — and reads one back on a `resources/subscribe` to know which of that
 * principal's streams to feed. It authenticates NOTHING (the bearer decides everything on
 * every request, §7), which is why the DO requires principal equality beside it (§21.4).
 */
const MCP_SESSION_HEADER = "Mcp-Session-Id";

/**
 * §21.2's re-authorization leg, as the DOOR hands it in: re-run §7 step 1's whole verdict —
 * resolve the bearer, judge the namespace, and (scoped) this app's visibility to that
 * caller — and answer the principal it now admits, or null when it admits nobody. A held
 * stream is one request, and "revocation is immediate" is a per-request property (§15), so
 * the tick has to ask the door again; it must not ask a second implementation of it.
 */
export type Reauthorize = () => Promise<Principal | null>;

/**
 * §21.1's held answer, opened: mint the session id, open one subscriber socket into each
 * granted tunneled app's DO, write the first keepalive so the client can see the stream
 * is live, and hand the response back while this invocation keeps writing to it.
 *
 * The refusals are the listings', never the calls': a scoped ARCHIVED app refuses
 * -32002 before a byte is written, availability is never asked (a stream against an offline
 * app is the point — the bell rings when it comes back changed), and a caller whose
 * grants match nothing gets a stream that simply never rings.
 */
async function listenStream(
  env: Env,
  ownerId: string,
  ctx: BackendCtx,
  slug: string | undefined,
  reauthorize: Reauthorize,
): Promise<Response> {
  // deps: registry.getApp · registry.listAppsFor · tunnel.openSubscriber · tunnel.capabilities
  // The refusal comes first, whole: a -32002 must leave no half-opened stream behind it.
  const apps = await subscribable(new Registry(env.DB), ownerId, slug);
  const stream = new ListenStream(slug === undefined ? "aggregated" : "scoped");
  try {
    await stream.begin(apps, principalKey(ctx.principal));
  } catch (err) {
    // A DO that cannot be reached is the same failure class here as on any other method, so
    // it answers -32000 like every other one (never a generic internal error) — and the
    // sockets the open DID establish are closed before the refusal goes out, because an
    // open that failed must leave no stream behind it either.
    await stream.abandon();
    if (err instanceof HubError) throw err;
    throw unavailable("do_unreachable");
  }
  // Deliberately not awaited: the loop outlives this function by design — it IS the held
  // response — and it ends when the consumer disconnects, the door stops admitting the
  // caller, or a socket closes under it. Nothing inside it throws (the tick is
  // failure-closed), so a rejection here is a hub defect and says so.
  void stream.hold(env, ownerId, slug, reauthorize).catch((err: unknown) => {
    console.error("pmcp/listen: the held stream's tick failed", err);
  });
  return stream.response();
}

/**
 * The apps one stream subscribes (§21.2) — the SAME reads every other scoped method
 * performs, and the same access verdict: an app this caller cannot see was already 404'd at
 * the door, an ARCHIVED one refuses -32002 before the stream opens, and availability is
 * never asked.
 *
 * TWO shapes subscribe to nothing: §23.1's virtual hub (the aggregate endpoint and scoped
 * `/mcp/hub`, whose push flags are false and which opens no application subscriber socket),
 * and the builtin `pmcp` (a legal, permanently quiet stream — no row exists to read).
 *
 * Real scoped apps: TUNNELED only. A proxied app has no DO to ring from (a Worker cannot
 * hold an outbound stream to an upstream past its own invocation) and the builtin's tools
 * never change, so neither is dialed at all — which is also why neither advertises push
 * (§21.5). No FILTER runs here, and that is §21.1's listing-class sentence rather than an
 * omission: a stream serves no items, so there is nothing for the caller's patterns to
 * match; a caller the door admits whose patterns match nothing gets the never-ringing
 * stream. Deterministic SLUG order is what makes one client's own streams address one set.
 */
async function subscribable(
  registry: Registry,
  ownerId: string,
  slug: string | undefined,
): Promise<App[]> {
  // deps: registry.getApp
  // §23.1: the virtual hub — the aggregate endpoint and scoped `/mcp/hub` alike — opens no
  // application subscriber sockets. The stream itself stays available (authenticated SSE
  // keepalives, §21's reauthorization tick), which is all a surface whose push flags are
  // false can promise: there is nothing to ring.
  if (slug === undefined || slug === HUB_SLUG) return [];
  // The builtin is addressable by its owner and rings nothing: a legal, permanently quiet
  // stream, answered before any registry read (no D1 row for `pmcp` exists to read).
  if (slug === PMCP_SLUG) return [];
  const app = await registry.getApp(ownerId, slug);
  if (app === null) throw notPermitted();
  if (app.archived) throw archived();
  return app.kind === "tunnel" ? [app] : [];
}

/**
 * One held listen stream: the SSE writer this invocation owns, its optional scoped-app
 * subscriber socket, and whether it has ended. Every §21.2 delivery rule lives in these
 * methods and nowhere else:
 *
 * - a frame a socket delivers is written PAYLOAD-VERBATIM and admission-filtered by the
 *   endpoint shape (`admits`): the DO rang every subscriber socket it holds and knows no
 *   shapes, so this is the only party that can drop a bell the addressed endpoint shape
 *   does not serve (the scoped shape serves all three; §23.1's hub shapes open no socket
 *   at all, so nothing ever arrives to filter);
 * - a socket close the Worker did not initiate ends the WHOLE stream — fail loud, not deaf,
 *   because a stream that silently stopped hearing one app is the one failure a doorbell
 *   design cannot afford. A close this stream DID initiate is told from it by the socket
 *   having already left the map, which is why `drop` deletes before it closes;
 * - a KEEPALIVE the body has not accepted by the time the next one is due means nobody is
 *   reading it: the stream ends and closes its sockets, which is what makes subscriptions
 *   die with the stream (§21.1) rather than outlive it (`write` and `hold` say why the
 *   counters, rather than an awaited write, are what can observe that — and why only the
 *   keepalive is counted: a doorbell still in flight is a busy consumer, not a gone one);
 * - the keepalive is a BARE `setTimeout(…, LISTEN_KEEPALIVE_MS)` (constraint 3), and the
 *   same tick carries the re-authorization, so the revocation window IS the keepalive
 *   window (§21.1) and the suite's exact-constant shim reaches this timer and no other.
 */
class ListenStream {
  /** Minted here and never read off the request: a client-supplied id is never echoed. */
  private readonly sessionId = crypto.randomUUID();
  private readonly encoder = new TextEncoder();
  private readonly body: ReadableStream<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly sockets = new Map<string, WebSocket>();
  /** KEEPALIVE blocks handed to the body, and keepalive blocks the body accepted — the
   *  stall detector's whole input, see `write`. Data blocks are deliberately uncounted. */
  private keepalivesIssued = 0;
  private keepalivesAccepted = 0;
  private ended = false;

  constructor(private readonly endpoint: EndpointShape) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.body = readable;
    this.writer = writable.getWriter();
  }

  /** The answer, exactly as §21.1 spells it: 200, `text/event-stream`, a minted session id.
   *  No `Last-Event-ID` is honored anywhere, so nothing here advertises resumption. */
  response(): Response {
    return new Response(this.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        // An intermediary that buffered a doorbell would defeat the whole mechanism.
        "Cache-Control": "no-cache",
        [MCP_SESSION_HEADER]: this.sessionId,
      },
    });
  }

  /**
   * The open: one socket per app, then the first keepalive — a client learns its stream
   * is live from a byte, not from a header. Nothing is RUNG here: an open is not a change.
   *
   * That first write is deliberately not awaited. A transform stream applies backpressure
   * from its reader, and nothing reads this body until `response()` has been returned to the
   * consumer — so awaiting it here would deadlock the open against the answer it is opening.
   * `write` swallows its own failure into `end()`, so the unawaited promise can reject only
   * into a stream that has already ended.
   */
  async begin(apps: readonly App[], principal: string): Promise<void> {
    // Concurrently: these are one round trip per subscribed app on the latency-critical path
    // of a held response (today's shapes yield at most one), and the subscribed SET is
    // already fixed by `subscribable`, so nothing here depends on the order they come up in.
    await Promise.all(apps.map((app) => this.subscribe(app, principal)));
    void this.write(KEEPALIVE, true);
  }

  /** The open that failed: every socket it did open, closed, and the body finished — so a
   *  refusal leaves no half-opened stream behind it either (§21.2). */
  async abandon(): Promise<void> {
    await this.end();
  }

  /**
   * §21.1/§21.2's tick loop: one SSE comment and one re-authorization per
   * LISTEN_KEEPALIVE_MS, forever, until the consumer stops reading, the door stops admitting
   * the caller, or a socket ends the stream under it.
   *
   * The keepalive is written but NOT awaited, and the stall check is what replaces awaiting
   * it: a KEEPALIVE still unaccepted when the next tick comes due means nobody is reading
   * this body — a consumer that disconnected, or one so far behind that it may as well have
   * — so the stream ends and its subscriptions die with it (§21.1). Waiting on the write
   * instead would hang here forever, since a cancelled body neither accepts nor refuses one.
   *
   * DATA blocks are not counted: a doorbell written microseconds before a tick has not
   * failed, it is merely in flight, and reading it as a stall would close a healthy stream
   * for having something to say.
   */
  async hold(
    env: Env,
    ownerId: string,
    slug: string | undefined,
    reauthorize: Reauthorize,
  ): Promise<void> {
    for (;;) {
      await new Promise<void>((resolve) => {
        // Re-read every tick: a row that shortens the keepalive through its binding gets
        // the short one from the very next tick, and nothing global is patched.
        setTimeout(resolve, deadlines(env).listenKeepaliveMs);
      });
      if (this.ended) return;
      if (this.keepalivesIssued !== this.keepalivesAccepted) {
        await this.end();
        return;
      }
      void this.write(KEEPALIVE, true);
      if (!(await this.retick(env, ownerId, slug, reauthorize))) return;
    }
  }
  /**
   * One re-authorization (§21.2). The door's verdict comes first: a revoked or expired
   * bearer, deleted agent, another user's namespace, or scoped app the caller can no
   * longer see closes the stream. A tick therefore answers exactly as a fresh open would.
   *
   * Then the addressed app is re-read. A real scoped tunneled app keeps exactly one socket;
   * the virtual hub shapes and builtin `pmcp` keep none. The small reconciliation below
   * closes stale authority before opening any newly required socket.
   *
   * Any failure reaching a DO ends the stream rather than leaving it deaf to its app.
   */
  private async retick(
    env: Env,
    ownerId: string,
    slug: string | undefined,
    reauthorize: Reauthorize,
  ): Promise<boolean> {
    try {
      const principal = await reauthorize();
      if (principal === null) {
        await this.end();
        return false;
      }
      const next = await subscribable(new Registry(env.DB), ownerId, slug);
      for (const appId of [...this.sockets.keys()]) {
        if (!next.some((app) => app.id === appId)) this.drop(appId);
      }
      for (const app of next) {
        if (this.sockets.has(app.id)) continue;
        await this.subscribe(app, principalKey(principal));
        await this.ring(app);
      }
    } catch (err) {
      // A scoped -32002 (archived mid-stream), a vanished app, a credential the door
      // refuses by throwing, or a DO that could not be reached: every one of them is a
      // stream that can no longer answer for itself, and §21.2 closes rather than deafens.
      //
      // Two failure classes, two OPERATOR signals, the same split the catalog collector
      // makes: a HubError is the door or somebody's downtime answering as designed, and a
      // stream closing on it is the specified outcome rather than news. Anything else is a
      // HUB defect, and a stream that vanished with nothing in the logs is the one way this
      // design fails invisibly — so it is logged against this module.
      if (!(err instanceof HubError)) {
        console.error("pmcp/listen: hub defect on the re-authorization tick", err);
      }
      await this.end();
      return false;
    }
    return !this.ended;
  }

  /** One subscriber socket into one app's DO, wired to this stream (§21.2). */
  private async subscribe(app: App, principal: string): Promise<void> {
    const socket = await openSubscriber(app.id, this.sessionId, principal);
    this.sockets.set(app.id, socket);
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        // A frame this stream cannot classify is not one it may forward.
        return;
      }
      const method =
        typeof frame === "object" && frame !== null && "method" in frame ? frame.method : undefined;
      if (typeof method !== "string" || !admits(method, this.endpoint)) return;
      // The map is the authority on which socket this stream is still listening to: `drop`
      // deletes before it closes, so a frame that arrives after a narrowing — in flight, or
      // sent by a DO that has not processed the close yet — is not one this stream forwards.
      if (this.sockets.get(app.id) !== socket) return;
      void this.write(`data: ${text}\n\n`, false);
    });
    socket.addEventListener("close", () => {
      // Still in the map ⇒ nobody here closed it: the DO, a deploy, or a restart did, and
      // §21.2 ends the stream so the client's ordinary reopen rebuilds the scoped channel.
      if (this.sockets.get(app.id) === socket) void this.end();
    });
  }

  /** The bells a newly subscribed app owes this shape, derived from the SAME kind-aware
   *  shape the handshake answered (`capabilityShape`) rather than from the stored set again:
   *  a family whose shape carries no `listChanged` promises no bell, so it may not ring one.
   *  Then intersected with what the endpoint shape serves, and deduplicated — both resource
   *  catalogs answer to the one bell (§21.3).
   *
   *  Not awaited, for the reason `write` gives: a cancelled body never settles a write, and
   *  awaiting one here would wedge the tick that called it, holding every socket open. */
  private async ring(app: App): Promise<void> {
    const shape = capabilityShape(await tunnelCapabilities(app.id), "tunnel");
    const bells = new Set<string>();
    for (const [family, flags] of Object.entries(shape)) {
      if (flags.listChanged !== true) continue;
      const bell = familyBell(family);
      if (bell !== null && admits(bell, this.endpoint)) bells.add(bell);
    }
    for (const bell of bells) void this.write(`data: ${JSON.stringify(bellFrame(bell))}\n\n`, false);
  }

  /** A socket this stream is done with: out of the map FIRST, so its close event reads as
   *  hub-initiated and does not end the stream (§21.2 — a narrowing is not a failure). */
  private drop(appId: string): void {
    const socket = this.sockets.get(appId);
    if (socket === undefined) return;
    this.sockets.delete(appId);
    try {
      socket.close(1000, "grant revoked");
    } catch {
      // already gone
    }
  }

  /** The end, from whichever direction reached it: every socket closed as hub-initiated,
   *  every subscription riding them gone, and the response body finished. Idempotent. */
  private async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const appId of [...this.sockets.keys()]) this.drop(appId);
    await this.writer.close().catch(() => undefined);
  }

  /**
   * One SSE block out. `keepalivesIssued`/`keepalivesAccepted` are the ONLY way this
   * invocation can learn its consumer is gone: a cancelled response body neither errors this
   * writable nor rejects the write — the write simply never settles again — so the tick
   * above reads the counters rather than waiting on a promise that has no answer for it
   * (measured against workerd, both in-process and over a service binding).
   *
   * `counted` is what the stall detector observes, and only the keepalive sets it: it is the
   * one block written on a fixed cadence, so "the previous one has not landed and the next
   * is already due" is a statement about the CONSUMER. A doorbell is written when an app
   * happens to change something, which is no schedule at all.
   */
  private async write(text: string, counted: boolean): Promise<boolean> {
    if (this.ended) return false;
    if (counted) this.keepalivesIssued += 1;
    try {
      await this.writer.write(this.encoder.encode(text));
      if (counted) this.keepalivesAccepted += 1;
      return true;
    } catch {
      await this.end();
      return false;
    }
  }
}

/** §21.1's keepalive: an SSE COMMENT, so a client parsing `data:` lines as JSON-RPC sees
 *  nothing at all here — the form is the contract, the interval is limits.ts's. */
const KEEPALIVE = ": keepalive\n\n";

/**
 * §21.4's two per-URI methods, in one pipeline because they differ in one line. Scoped and
 * TUNNELED-only: the builtin and a proxied app answer -32601 (the capability is never
 * advertised for them and there is nowhere to forward), which is decided before the audited
 * body below, exactly as the hub shapes' refusal is decided in `hubRoute` (the hub has no
 * app socket to mutate, and never advertises the capability).
 *
 * Then §7's order, with §21.4's own step in it: the URI is matched against the caller's
 * resource patterns FIRST (-32001 — an unfiltered subscribe is a standing read past the
 * role's patterns, and the filter running first is also why an ungranted URI on an archived
 * app is -32001 and not -32002), then archived (-32002), then availability (-32000),
 * then the DO's own verdict: a subscribe past either cap is refused -32602 having stored and
 * forwarded NOTHING. Passing, the frame is forwarded with its params unrewritten and the
 * same `_meta` every family carries — hub/principal, hub/roles and the mirrored
 * clientCapabilities under one strip-then-set (`prepareForward`) — and relayed verbatim.
 *
 * Exactly one audit row, written after the try/catch like every other dispatching method:
 * §21.6 records these two like a READ, so the row's `tool` column is the URI under §20.4's
 * hygiene, no body is ever carried (there is none to carry), and — like a read's — the
 * -32001 an unresolvable app earns is IN the ledger. The -32601 above it is not: a
 * method that is not served for this kind of target had no dispatch to record, which is
 * exactly how `route` treats its own.
 */
async function subscription(
  env: Env,
  ownerId: string,
  slug: string,
  method: "resources/subscribe" | "resources/unsubscribe",
  sessionId: string | null,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  // deps: registry.getApp · registry.resolveAccess · probeAvailability · tunnel.subscribe · tunnel.unsubscribe · prepareForward · audit.record
  const registry = new Registry(env.DB);
  if (slug === PMCP_SLUG) throw methodNotFound();
  const app = await registry.getApp(ownerId, slug);
  if (app !== null && app.kind !== "tunnel") throw methodNotFound();

  const startedAt = Date.now();
  const uri = msg.params?.uri;
  // The session id names WHICH of the caller's streams to feed; the DO authorizes the
  // mutation by the socket's stored principal, so a missing header can only fail to match.
  const session = sessionId ?? "";
  let outcome = "error";
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  try {
    // A request with no `uri`, or one that is not a string, names no resource: -32602, the
    // same code the caps refuse with, because the alternative is a subscription stored
    // against `""` — a URI that passed no meaningful filter and that no app can emit.
    if (typeof uri !== "string") throw invalidParams();
    if (app === null) throw notPermitted();
    const filter = await registry.resolveAccess(ctx.principal, app);
    if (filter.check(uri, "resources") === "deny") throw notPermitted();
    if (app.archived) throw archived();
    const unavailableAs = await probeAvailability(app);
    if (unavailableAs !== null) throw unavailableAs;

    // The socket's stored principal is an authorization key, never the audit spelling
    // (principal.principalKey says why the two must not be the same string).
    const principal = principalKey(ctx.principal);
    if (method === "resources/subscribe") {
      if ((await tunnelSubscribe(app.id, session, principal, uri)) === "refused") {
        throw invalidParams();
      }
    } else {
      await tunnelUnsubscribe(app.id, session, principal, uri);
    }

    const appCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, uri } }, appCtx);
    const relayed = await selectBackend(app).call(app, forwarded, appCtx);
    outcome = relayed.error === undefined ? "ok" : "error";
    answer = { ...relayed, id: msg.id ?? null };
  } catch (err) {
    refusal = err;
    outcome = err instanceof HubError ? String(err.code) : "error";
  }
  await recordDispatch(env, {
    ownerId,
    ctx,
    event: method,
    slug: app?.slug ?? slug,
    tool: auditableUri(typeof uri === "string" ? uri : ""),
    outcome,
    durationMs: Date.now() - startedAt,
    bodies: {},
  });
  if (answer === undefined) throw refusal;
  return answer;
}

/**
 * The approval gate, built per request because every binding it closes over is (D1
 * especially). The ONE thing this site says for itself is the transport: the gateway is
 * where `check` opens a pending row, so the gateway is the only construction that can
 * notify the owner. The keys ride in the closure rather than through the seam, which is
 * passed only (subscription, payload) — src/push.
 */
function approvalsFor(): Approvals {
  return approvalsFromEnv({ push: pushSender(vapidFromEnv()) });
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
