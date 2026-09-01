// gateway.ts — the consumer-facing MCP pipeline (§7): every /:user/mcp message is answered
// by this module. It OWNS the JSON-RPC half of both endpoint shapes (POST /:user/mcp
// aggregated, POST /:user/mcp/:slug scoped) and their SDK wiring (createMcpHandler with
// a per-request low-level Server, legacy-stateless lane included — comment-level only,
// the SDK never appears in sibling modules); the aggregated `<slug>_<tool>` split; the
// pinned check order filter → archived → approval → availability (§7's list, with the
// availability-first decision folding its last two into one test — see callTool);
// server/discover and the `initialize` handshake; `_meta` hygiene and client-metadata
// capture; the ONE redaction map per call; and the ONE mapping from HubError to JSON-RPC
// wire errors. It HIDES the wire entirely: sibling modules throw the HubError vocabulary
// errors.ts owns and never see a JSON-RPC error code, and backends never see an
// unfiltered tool name, an archived service, or an unapproved gated call.
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

import { adminBackend, BUILTIN_LOG_BODIES } from "./admin";
import type { ApprovalClaim, Approvals, CheckResult } from "./approvals";
import { record, REDACTED_QUERY } from "./audit";
import type { BodyStub } from "./audit";
import {
  admits,
  AGGREGATED_CAPABILITIES,
  bellFrame,
  capabilityShape,
  DEFAULT_SERVICE_CAPABILITIES,
  familyBell,
} from "./capabilities";
import type { CapabilityKind, EndpointShape } from "./capabilities";
import { archived, CODES, HubError, invalidParams, notPermitted, unavailable } from "./errors";
import { formatPrincipal, principalKey, tokenPattern } from "./principal";
import type { Principal } from "./principal";
import { pushSender } from "./push";
import { applyRedaction, PMCP_SLUG, REDACTED, Registry } from "./registry";
import type { ListKind, RoleFamily, Service } from "./registry";
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
  AGGREGATED_LIST_DEADLINE_MS,
  AUDIT_URI_CAP_BYTES,
  LISTEN_FANOUT_MAX,
  LISTEN_KEEPALIVE_MS,
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
 * §20.2's other three list items — verbatim from the backend, matched (never renamed) on
 * the key registry.ToolFilter reads: a prompt by `name`, a resource by `uri`, a template
 * by its raw `uriTemplate`. Deliberately minimal: the hub relays whatever else a service
 * attaches (a resource's `mimeType`, a prompt's `arguments`) untouched, so these types name
 * only the field the door itself reads or rewrites (the aggregated `<slug>_` prefix lands
 * on `name` alone).
 */
export type Prompt = { name: string; description?: string };
export type Resource = { uri: string; name?: string };
export type ResourceTemplate = { uriTemplate: string; name?: string };

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
   * §20.2's other three catalogs, on the same contract as `listTools` above: unfiltered,
   * relayed VERBATIM (the hub reads no field beyond the one its family is matched on —
   * a prompt by `name`, a resource by `uri`, a template by its raw `uriTemplate`), and
   * -32000 when unreachable. Tunnel serves them from the DO's cache, upstream live
   * (§20.5: proxied caches nothing, in any family), admin the builtin's three empty
   * lists (§20.6). They live here, beside `listTools`, because this is the seam's one
   * question — what the DOOR may ask a backend — and every backend answers all four.
   */
  listPrompts(service: Service, ctx: BackendCtx): Promise<Prompt[]>;
  listResources(service: Service, ctx: BackendCtx): Promise<Resource[]>;
  listResourceTemplates(service: Service, ctx: BackendCtx): Promise<ResourceTemplate[]>;
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
 * One listed item as the DOOR handles it — whichever of §20.2's four descriptors a family
 * serves, seen through the only fields this module touches: the key the filter matches it
 * on, and the outputSchema `served` strips (tools alone carry one).
 */
type ListedItem = {
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
 * The consumer MCP pipeline as one entry point: §7 steps 2–3 for one already-admitted
 * message, from bytes to bytes. `slug` present ⇔ the scoped shape.
 *
 * The door is index.mcpEntry's, not this function's, and `principal` is the proof: by the
 * time a request arrives here Content-Type, the Origin rule, the caller's resolution and
 * (scoped) the service's visibility to that caller have all been decided ONCE, at the
 * composition root. What is left is JSON-RPC — this function answers `server/discover` and
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
 * opening it (a scoped archived service, -32002) leaves through the same mapping below.
 * `reauthorize` is the door's own verdict, handed in because the held stream must re-run
 * §7 step 1 on every keepalive (§21.2) and a second implementation of step 1 is the one
 * thing §21 forbids.
 */
export async function mcpMessage(
  request: Request,
  env: Env,
  principal: Principal,
  slug: string | undefined,
  reauthorize: Reauthorize,
): Promise<Response> {
  // deps: splitAggregatedName · captureClientMeta · callTool · listScoped · listAggregated · listenStream · toWire
  const msg = await readMessage(request);
  if (msg === null) {
    return jsonRpc(toWire(new HubError(CODES.invalidRequest, "invalid request"), null));
  }
  // A notification carries no id, so there is nothing to answer to (§ JSON-RPC 2.0).
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const ctx: BackendCtx = { principal, roles: [], clientMeta: captureClientMeta(msg) };
  const ownerId = principal.kind === "user" ? principal.userId : principal.ownerId;
  try {
    if (msg.method === LISTEN_METHOD) return await listenStream(env, ownerId, ctx, slug, reauthorize);
    // §21.4: the session id a subscribe names its stream with is a REQUEST header, and this
    // is the only place a consumer-supplied one is ever read (§21.1 — correlation, never
    // authentication: the bearer above decided everything).
    return jsonRpc(await route(env, ownerId, slug, msg, ctx, request.headers.get(MCP_SESSION_HEADER)));
  } catch (err) {
    if (err instanceof Response) throw err; // identity's convention, never ours to swallow
    return jsonRpc(toWire(err, msg.id ?? null));
  }
}

/** §7 step 3's method table, widened by §20's seven entries and §21's three: served
 *  methods, everything else -32601. `resources/*` and `completion/complete` are refused on
 *  the AGGREGATED shape by name (§20.2) rather than falling to the default case, so the
 *  refusal is a method-table entry and not an accident of what nobody implemented.
 *  `subscriptions/listen` never reaches here — its answer is a held response, so mcpMessage
 *  answers it above (§21.1). */
async function route(
  env: Env,
  ownerId: string,
  slug: string | undefined,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
  sessionId: string | null,
): Promise<JsonRpcResponse> {
  const id = msg.id ?? null;
  switch (msg.method) {
    // Answered by the hub on BOTH shapes: a slug in the URL is not resolved, dialed, or
    // filtered for either of them.
    case "server/discover":
      return { jsonrpc: "2.0", id, result: await discoverResult(env, ownerId, slug) };
    case "initialize":
      return { jsonrpc: "2.0", id, result: await initializeResult(env, ownerId, slug) };
    // §20.2's four listings, answered from LIST_METHODS: the scoped shape serves every
    // family, the aggregated shape the two it can prefix — one branch, so `prompts/list`
    // obeys "tools/list's whole bullet" by construction rather than by inspection.
    case "tools/list":
    case "prompts/list":
    case "resources/list":
    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: await listResult(env, ownerId, slug, ctx, LIST_METHODS[msg.method]) };
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      if (slug !== undefined) return callTool(env, ownerId, slug, name, msg, ctx);
      const split = splitAggregatedName(name);
      // A name with no `_` at all names no service — the same -32001 as not-permitted,
      // never a distinct "malformed name" signal (§7).
      if (split === null) throw notPermitted();
      return callTool(env, ownerId, split.slug, split.tool, msg, ctx);
    }
    case "prompts/get": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      if (slug !== undefined) return getPrompt(env, ownerId, slug, name, msg, ctx);
      const split = splitAggregatedName(name);
      if (split === null) throw notPermitted();
      return getPrompt(env, ownerId, split.slug, split.tool, msg, ctx);
    }
    // §20.2/§18 decision 26: resources and completions are scoped-only — the aggregated
    // shape does not resolve a slug for them at all, refusing before any service exists.
    case "resources/read": {
      if (slug === undefined) throw methodNotFound();
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
      return readResource(env, ownerId, slug, uri, msg, ctx);
    }
    case "completion/complete": {
      if (slug === undefined) throw methodNotFound();
      return completeRef(env, ownerId, slug, msg, ctx);
    }
    // §21.4's two per-URI methods, scoped-only for §18 decision 26's reason and
    // tunneled-only for §21.2's: a proxied service has no channel to ring from and the
    // builtin never changes, so neither ADVERTISES subscribe and neither has anywhere to
    // forward — refused inside, by kind, on the same -32601 this shape check gives.
    case "resources/subscribe":
    case "resources/unsubscribe": {
      if (slug === undefined) throw methodNotFound();
      return subscription(env, ownerId, slug, msg.method, sessionId, msg, ctx);
    }
    default:
      // §7's 2026-09-01 amendment: with `subscriptions/listen` and the two per-URI methods
      // served, the leftover set is `logging/*` and every server-initiated request — both
      // dead in 2026-07-28 itself — and it falls here on both endpoint shapes alike.
      throw methodNotFound();
  }
}

/** §7's -32601, spelled once: an unserved method and a served one the ADDRESSED shape does
 *  not answer are the same refusal, so neither can be told from the other. */
function methodNotFound(): HubError {
  return new HubError(CODES.methodNotFound, "method not found");
}

/**
 * What a method the hub forwards over a service socket carries beyond its own params (§6,
 * §7's identity clause, §21.4). `forwardedCall` names the six a CONSUMER drives: each
 * arrives post-hygiene with `hub/principal`, `hub/roles` and the mirrored
 * `clientCapabilities` in its `_meta`, under one strip-then-set. `protocol` names the five
 * the HUB itself drives — §6's registration-time `server/discover` and the four catalog
 * warms — which carry the protocol `_meta` fields alone, because at registration no
 * principal exists to attach.
 */
export type ForwardedCarrier = "forwardedCall" | "protocol";

/**
 * §6's hub→service forwarded methods, WHOLE — the eleven the hub ever sends over a service
 * socket, and which of the two `_meta` regimes each rides under. Published vocabulary, like
 * tunnel's HUB_METHODS and SERVICE_NOTIFICATIONS: `contracts/tunnel-frames.json` is emitted
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
 * §20.2's four listings as data: which catalog each method serves, and whether the
 * AGGREGATED shape answers it at all. Resources and templates are scoped-only (§18
 * decision 26: a URI cannot take a `<slug>_` prefix and still be the URI the service
 * knows), so their refusal is an entry in this table rather than an accident of what
 * nobody implemented. A fifth family is one row here and one row in tunnel's catalog
 * tables.
 */
const LIST_METHODS = {
  "tools/list": { kind: "tools", aggregated: true },
  "prompts/list": { kind: "prompts", aggregated: true },
  "resources/list": { kind: "resources", aggregated: false },
  "resources/templates/list": { kind: "resourceTemplates", aggregated: false },
} as const satisfies Record<string, { kind: ListKind; aggregated: boolean }>;

/**
 * One listing answer, on whichever shape asked for it (§7, widened by §20.2 to every
 * family). Scoped: the family's catalog, filtered by the caller's grants. Aggregated: the
 * fan-out, with the services it could not reach named in the result's `_meta` — and a
 * family the aggregated shape does not serve refused -32601 before any service exists.
 */
async function listResult(
  env: Env,
  ownerId: string,
  slug: string | undefined,
  ctx: BackendCtx,
  method: (typeof LIST_METHODS)[keyof typeof LIST_METHODS],
): Promise<Record<string, unknown>> {
  // deps: listScoped · listAggregated
  if (slug !== undefined) return familyResult(method.kind, await listScoped(env, ownerId, slug, ctx, method.kind));
  if (!method.aggregated) throw methodNotFound();
  const { items, unavailable: omitted } = await listAggregated(env, ownerId, ctx, method.kind);
  const result = familyResult(method.kind, items);
  // §7: the omitted slugs are reported in the result's `_meta`, and logged as an ops
  // event — never an audit row (§15 keeps every listing out of audit entirely).
  if (omitted.length > 0) {
    console.warn(`pmcp/unavailable: ${omitted.join(",")}`);
    result._meta = { "pmcp/unavailable": omitted };
  }
  return result;
}

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
 * §20.2's capabilities question — reversed in one direction by §21.5 — answered once for
 * both `initialize` and `server/discover` on both endpoint shapes. Aggregated (`slug`
 * absent): the fixed two-family constant, whatever the namespace holds, now with
 * `listChanged: true` on both, because the transport that honors it flipped in the same
 * deploy (§21.5's lockstep rule). Scoped: derived from what the hub already STORES for that
 * service — the capability set §6's registration-time `server/discover` learned (tunneled),
 * or the owner-declared `capabilities` config (proxied, absent means tools only) — NEVER a
 * live upstream call, which is what lets a hung service answer the handshake at full speed.
 *
 * The KIND is the second input, and the one §21.5 added: a proxied service has no DO to
 * ring from and the builtin's tools never change, so both declare every push flag false
 * whatever their stored set says, while a tunneled service declares `listChanged` on each
 * family it stores and `subscribe` on its resources. The three are named, never inferred
 * from "is not proxied" (capabilities.CapabilityKind), which is what keeps the builtin off
 * the tunneled branch. A service the caller cannot even resolve answers the NEVER-CONNECTED
 * tunneled shape — the handshake must not become a service-existence oracle (§20.2's
 * anti-enumeration posture, and §21.5's own sentence about it).
 */
async function capabilitiesFor(env: Env, ownerId: string, slug: string | undefined): Promise<Record<string, unknown>> {
  // deps: registry.getService · tunnel.capabilities · capabilities.capabilityShape
  if (slug === undefined) return AGGREGATED_CAPABILITIES;
  if (slug === PMCP_SLUG) return capabilityShape(DEFAULT_SERVICE_CAPABILITIES, "builtin");
  const service = await new Registry(env.DB).getService(ownerId, slug);
  if (service === null) return capabilityShape(DEFAULT_SERVICE_CAPABILITIES, "tunnel");
  const declared =
    service.kind === "tunnel" ? await tunnelCapabilities(service.id) : service.capabilities ?? DEFAULT_SERVICE_CAPABILITIES;
  return capabilityShape(declared, CAPABILITY_KINDS[service.kind]);
}

/** A stored service's kind as §21.5's capability axis spells it — the builtin is decided by
 *  slug above, so this table covers the two kinds a D1 row can hold. */
const CAPABILITY_KINDS = { tunnel: "tunnel", proxy: "proxy" } as const satisfies Record<
  Service["kind"],
  CapabilityKind
>;

/**
 * Constraint 4's seam, spelled once: the pure capability core lives in a Node-clean module
 * (`capabilities.ts`, which must never gain a `cloudflare:workers` import — this module has
 * one, through admin.ts), and the DOOR is where a fixture producer or a sibling reads it
 * from. §21.5's four-picture split landed with it, so the pre-flip `CAPABILITY_SHAPE`
 * constant that used to sit here is gone: `capabilityShape` answers both handshakes and
 * emits every fixture picture.
 */
export { AGGREGATED_CAPABILITIES, capabilityShape } from "./capabilities";

/** The one MCP revision this hub speaks (§7: stateless 2026-07-28 endpoints). */
const PROTOCOL_VERSION = "2026-07-28";

/**
 * §7's cache hints on a listing result — extended by §20.5 to every family's list, on the
 * same reasoning: `cacheScope` is always `private` because a listing is filtered by the
 * caller's grants, so a shared cache would serve one account's view to another. No § pins
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
 * Which catalog each family is read from — the seam's four listing methods, indexed by the
 * catalog they serve. Kept apart from the pattern-matching side because §20.2 pins the KEY
 * each family is matched on (`name` for tools/prompts, `uri` for resources, `uriTemplate`
 * for templates) and `filterList`'s own `kind` argument is what selects it — a family-aware
 * caller that forgot to pass it would filter every family by `name`.
 */
const LIST_CATALOG: Record<
  ListKind,
  (backend: ServiceBackend, service: Service, ctx: BackendCtx) => Promise<ListedItem[]>
> = {
  tools: (b, s, c) => b.listTools(s, c),
  prompts: (b, s, c) => b.listPrompts(s, c),
  resources: (b, s, c) => b.listResources(s, c),
  resourceTemplates: (b, s, c) => b.listResourceTemplates(s, c),
};

/**
 * Scoped listing (§7, widened by §20.2 to every family): the backend's catalog for `kind`,
 * filtered by the caller's grant patterns, names unprefixed and every outputSchema served
 * with its `writeOnly` markers stripped (§7 — the hub's internal result-secret co-opt never
 * reaches the wire). Archived → -32002; an unreachable or needs-reconnect proxied upstream
 * → -32000 (the backend's own throw) — the scoped endpoint is where the aggregate's silent
 * omissions surface. Never audited (§15).
 */
async function listScoped(
  env: Env,
  ownerId: string,
  slug: string,
  ctx: BackendCtx,
  kind: ListKind,
): Promise<ListedItem[]> {
  // deps: registry.getService · registry.resolveAccess · selectBackend · virtualPmcpService
  const registry = new Registry(env.DB);
  const service = slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
  // The door already answered 404 for a slug this caller cannot see, so a miss here is
  // the same not-permitted answer every other unresolvable name gets.
  if (service === null) throw notPermitted();
  const filter = await registry.resolveAccess(ctx.principal, service);
  if (service.archived) throw archived();
  const catalog = await LIST_CATALOG[kind](selectBackend(service), service, { ...ctx, roles: filter.roleNames });
  return filter.filterList(catalog, kind).map(served);
}

/**
 * Aggregated fan-out (§7, widened by §20.2 to `prompts/list` — same cache, same live
 * fetch, same filter, same `<slug>_` prefix, same fan-out, same `_meta`): every service
 * the caller can see (owner: all non-archived, including `pmcp`; service account:
 * services holding ≥1 grant, never `pmcp`), queried in parallel under a 10 s per-upstream
 * deadline, names prefixed `<slug>_`. A failing or hanging upstream contributes zero
 * items and its slug is returned in `unavailable` — surfaced to the consumer as
 * `_meta["pmcp/unavailable"]` and logged as an ops event, never an audit row — while the
 * aggregate itself always succeeds. Tunneled lists come from DO cache and cannot miss the
 * deadline.
 *
 * The composed name is also the one name the HUB mints, so this is where it is checked:
 * a `<slug>_<item>` outside CONSUMER_TOOL_NAME is dropped from the listing and named once
 * on the ops log as `pmcp/unlistable` (a name is catalog metadata, not a secret, §15). The
 * cost stays proportional — an out-of-charset item costs only itself, never its service's
 * other nine, and never the aggregate. Two ceilings, deliberate: the SCOPED listing serves
 * the upstream's own names unvalidated, because nothing is composed there and the name is
 * the service's to answer for; and `tools/call`/`prompts/get` are untouched, so an
 * unlisted name that still resolves upstream keeps working — real consumers refuse the
 * listing ENTRY, not the call, and the contract governs what the listing serves.
 */
async function listAggregated(
  env: Env,
  ownerId: string,
  ctx: BackendCtx,
  kind: ListKind,
): Promise<{ items: ListedItem[]; unavailable: string[] }> {
  // deps: registry.listServicesFor · registry.resolveAccess · selectBackend · virtualPmcpService
  const registry = new Registry(env.DB);
  const visible: Service[] = (await registry.listServicesFor(ctx.principal)).filter((s) => !s.archived);
  // The builtin participates like any other service for its owner; a service account can
  // hold no grants on it (§8), so it is never added for one.
  if (ctx.principal.kind === "user") visible.push(virtualPmcpService(ownerId));

  const listed: ListedFamily[] = await Promise.all(
    visible.map(async (service): Promise<ListedFamily> => {
      const filter = await registry.resolveAccess(ctx.principal, service);
      try {
        const catalog = await withDeadline(
          LIST_CATALOG[kind](selectBackend(service), service, { ...ctx, roles: filter.roleNames }),
          AGGREGATED_LIST_DEADLINE_MS,
        );
        return {
          slug: service.slug,
          items: filter.filterList(catalog, kind).flatMap((item) => {
            // filterList already dropped anything without the key its family is matched
            // on, so an aggregated item always has the `name` this composes.
            const name = `${service.slug}_${item.name}`;
            if (CONSUMER_TOOL_NAME.test(name)) return [{ ...item, name }];
            console.warn(`pmcp/unlistable: ${name}`);
            return [];
          }),
        };
      } catch (err) {
        // Two failure classes, two OPERATOR signals. A HubError is somebody else's
        // downtime — errored, timed out, needs-reconnect — and `pmcp/unavailable` is the
        // line an operator reads before going to look at that upstream. A TypeError in
        // filterList is a HUB defect: it is logged as one, against this module, so it can
        // never send anybody to a perfectly healthy upstream.
        //
        // Both still contribute zero items, because §7 pins that the aggregate itself
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
    // `served` maps over the assembled listing, exactly as the scoped path applies it to
    // its own — one position for the transform, so the two shapes cannot present a tool
    // differently.
    items: listed.flatMap((entry) => ("items" in entry ? entry.items : [])).map(served),
    unavailable: listed.filter((entry) => "unavailable" in entry).map((entry) => entry.slug),
  };
}

/**
 * The tool-name charset real consumers accept (strategy §10 — the spec's own `get.news`
 * example violates it). Not a hub limit, which is why it is not in limits.ts: it is the
 * CONSUMER's rule, and the aggregated composition above is the only place the hub mints a
 * name that has to satisfy it.
 */
const CONSUMER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

/** One service's contribution to the fan-out: what it served, or that it could not. The
 *  union is the partition — no caller re-derives which is which from a container shape. */
type ListedFamily = { slug: string; items: ListedItem[] } | { slug: string; unavailable: true };

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
  // ONE exit: `recordDispatch` is invoked after the try/catch and nowhere else, which is what
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
    if (claim) await approvalsFor().settle(claim, relayed);
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
  const gate = approvalsFor();
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

// ══ §20.2 — prompts/get and resources/read: the two audited reads ═════════════════════
//
// Both share the pipeline `callTool` runs, minus two things: NO approval gate (§18
// decision 27 — a read is never gated), and no redaction-map-required gate either — a
// prompt or a resource has no catalog-miss concept, because neither carries a schema for
// `sensitivePaths` to walk in the first place (§20.3). What is left is exactly §7's other
// three checks, in order: filter (-32001) → archived (-32002) → availability (-32000).
// Each ends in exactly one audit row, like a call (§20.4) — the same `recordDispatch`,
// invoked after the try/catch and nowhere else, for the same reason `callTool` does it.

/**
 * §20.2's `prompts/get` pipeline, identical on both endpoint shapes once `slug`/`name`
 * arrive already split and unprefixed. Bodies (§20.3/§20.4): arguments are recorded ONLY
 * when the service's `redact` map names this prompt — with no entry, prompts carry no
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
  // deps: registry.getService · registry.resolveAccess · registry.redactPathsFor · selectBackend · virtualPmcpService · probeAvailability · prepareForward · audit.record
  const startedAt = Date.now();
  const registry = new Registry(env.DB);
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = slug;
  try {
    const service = slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
    if (service === null) throw notPermitted();
    recordedSlug = service.slug;

    // 1 — filter, matched by NAME against the caller's prompt patterns (§20.2).
    const filter = await registry.resolveAccess(ctx.principal, service);
    if (filter.check(name, "prompts") === "deny") throw notPermitted();
    // 2 — archived.
    if (service.archived) throw archived();
    // 3 — availability. No approval gate follows it (§18 decision 27).
    const unavailableAs = await probeAvailability(service);
    if (unavailableAs !== null) throw unavailableAs;

    const serviceCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, name } }, serviceCtx);
    const relayed = await selectBackend(service).call(service, forwarded, serviceCtx);
    outcome = relayed.error === undefined ? "ok" : "error";
    if (service.logBodies) bodies = await promptBodies(registry, service, name, msg, relayed);
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
  service: Service,
  name: string,
  msg: JsonRpcRequest,
  relayed: JsonRpcResponse,
): Promise<CallBodies> {
  const bodies: CallBodies = {};
  const paths = await registry.redactPathsFor(service, name, "args");
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
 * §20.2's `resources/read` pipeline — the twin of `getPrompt` above, matched by `uri`
 * (never `name`, §20.2) against the caller's resource patterns. Two things it alone does:
 * the outgoing result is decorated (§20.4 — `cacheScope: "public"` downgraded to
 * `"private"`, and a still-pending MRTR exchange never given a `ttlMs`), and the audited
 * `tool` column is the URI itself, put through §20.4's own hygiene (auditableUri) before
 * it ever reaches `record` — dropped query, capped length, §15's token grammar scrubbed.
 * Resource reads carry no argument body at all (§20.4); only the result is ever recorded.
 */
async function readResource(
  env: Env,
  ownerId: string,
  slug: string,
  uri: string,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  // deps: registry.getService · registry.resolveAccess · selectBackend · virtualPmcpService · probeAvailability · prepareForward · audit.record
  const startedAt = Date.now();
  const registry = new Registry(env.DB);
  let outcome = "error";
  let bodies: CallBodies = {};
  let answer: JsonRpcResponse | undefined;
  let refusal: unknown;
  let recordedSlug = slug;
  try {
    const service = slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
    if (service === null) throw notPermitted();
    recordedSlug = service.slug;

    const filter = await registry.resolveAccess(ctx.principal, service);
    if (filter.check(uri, "resources") === "deny") throw notPermitted();
    if (service.archived) throw archived();
    const unavailableAs = await probeAvailability(service);
    if (unavailableAs !== null) throw unavailableAs;

    const serviceCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, uri } }, serviceCtx);
    const relayed = await selectBackend(service).call(service, forwarded, serviceCtx);
    outcome = relayed.error === undefined ? "ok" : "error";
    const result = relayed.result as Record<string, unknown> | undefined;
    if (service.logBodies && result !== undefined) bodies.result = resourceReadBody(result);
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
    tool: auditableUri(uri),
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
 * own grammar cannot see it; §15's `pmcp_(sa|svc)_` grammar is then applied to whatever is
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
// BEFORE anything reaches the service, because unfiltered this method is a read straight
// past the role's patterns. Listing-class for audit (§20.4) — no row, refusals included —
// because the refusal is what makes the method safe, and a row per keystroke would be
// polling noise from a method a client calls on every one.

/**
 * §20.2's `completion/complete` pipeline, scoped-only (the aggregated shape refuses this
 * method in `route` before a slug is ever resolved). Filter → archived → availability,
 * exactly like `getPrompt`/`readResource`; no redaction, no bodies, no audit row.
 */
async function completeRef(
  env: Env,
  ownerId: string,
  slug: string,
  msg: JsonRpcRequest,
  ctx: BackendCtx,
): Promise<JsonRpcResponse> {
  // deps: registry.getService · registry.resolveAccess · selectBackend · virtualPmcpService · probeAvailability · prepareForward
  const registry = new Registry(env.DB);
  const service = slug === PMCP_SLUG ? virtualPmcpService(ownerId) : await registry.getService(ownerId, slug);
  if (service === null) throw notPermitted();
  const target = refTarget(msg);
  // A `ref` naming neither a prompt nor a resource template matches no pattern in any
  // family — the same -32001 an unmatched one gets, never a distinct "malformed ref" code.
  if (target === null) throw notPermitted();

  const filter = await registry.resolveAccess(ctx.principal, service);
  if (filter.check(target.subject, target.family) === "deny") throw notPermitted();
  if (service.archived) throw archived();
  const unavailableAs = await probeAvailability(service);
  if (unavailableAs !== null) throw unavailableAs;

  const serviceCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
  const forwarded = prepareForward(msg, serviceCtx);
  const relayed = await selectBackend(service).call(service, forwarded, serviceCtx);
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
// the very calls the aggregated fan-out makes (`listServicesFor` / `getService`), and its
// re-authorization tick re-runs §7 step 1 by CALLING the door's verdict (`Reauthorize`,
// constructed once in index.ts) rather than re-deciding it here. The only things this
// section decides for itself are what a stream writes and when it stops.
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
 * resolve the bearer, judge the namespace, and (scoped) this service's visibility to that
 * caller — and answer the principal it now admits, or null when it admits nobody. A held
 * stream is one request, and "revocation is immediate" is a per-request property (§15), so
 * the tick has to ask the door again; it must not ask a second implementation of it.
 */
export type Reauthorize = () => Promise<Principal | null>;

/**
 * §21.1's held answer, opened: mint the session id, open one subscriber socket into each
 * granted tunneled service's DO, write the first keepalive so the client can see the stream
 * is live, and hand the response back while this invocation keeps writing to it.
 *
 * The refusals are the listings', never the calls': a scoped ARCHIVED service refuses
 * -32002 before a byte is written, availability is never asked (a stream against an offline
 * service is the point — the bell rings when it comes back changed), and a caller whose
 * grants match nothing gets a stream that simply never rings.
 */
async function listenStream(
  env: Env,
  ownerId: string,
  ctx: BackendCtx,
  slug: string | undefined,
  reauthorize: Reauthorize,
): Promise<Response> {
  // deps: registry.getService · registry.listServicesFor · tunnel.openSubscriber · tunnel.capabilities
  // The refusal comes first, whole: a -32002 must leave no half-opened stream behind it.
  const services = await subscribable(new Registry(env.DB), ownerId, ctx.principal, slug);
  const stream = new ListenStream(slug === undefined ? "aggregated" : "scoped");
  try {
    await stream.begin(services, principalKey(ctx.principal));
  } catch (err) {
    // A DO that cannot be reached is the same failure class here as on any other method, so
    // it answers -32000 like every other one (never a generic internal error) — and the
    // sockets the fan-out DID open are closed before the refusal goes out, because an open
    // that failed must leave no stream behind it either.
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
 * The services one stream subscribes (§21.2) — the SAME reads every other shape performs,
 * and on the scoped shape the same access verdict every other scoped method gets: a service
 * this caller cannot see was already 404'd at the door, an ARCHIVED one refuses -32002
 * before the stream opens, and availability is never asked.
 *
 * TUNNELED services only. A proxied service has no DO to ring from (a Worker cannot hold an
 * outbound stream to an upstream past its own invocation) and the builtin's tools never
 * change, so neither is dialed at all — which is also why neither advertises push (§21.5).
 * Deterministic SLUG order, capped at LISTEN_FANOUT_MAX: the platform bounds an
 * invocation's simultaneous connections, and the excess is silent until the client reopens
 * (§21.7's recorded ceiling). Slug order rather than any other is what makes two concurrent
 * streams over one namespace — and one reopened stream — choose the same set.
 *
 * No FILTER runs here, and that is §21.1's listing-class sentence rather than an omission:
 * a stream serves no items, so there is nothing for the caller's patterns to match; a
 * caller the door admits whose patterns match nothing gets the never-ringing stream.
 */
async function subscribable(
  registry: Registry,
  ownerId: string,
  principal: Principal,
  slug: string | undefined,
): Promise<Service[]> {
  // deps: registry.getService · registry.listServicesFor
  if (slug !== undefined) {
    // The builtin is addressable by its owner and rings nothing: a legal, permanently quiet
    // stream, answered before any registry read (no D1 row for `pmcp` exists to read).
    if (slug === PMCP_SLUG) return [];
    const service = await registry.getService(ownerId, slug);
    if (service === null) throw notPermitted();
    if (service.archived) throw archived();
    return service.kind === "tunnel" ? [service] : [];
  }
  const visible = await registry.listServicesFor(principal);
  return visible
    .filter((service) => !service.archived && service.kind === "tunnel")
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
    .slice(0, LISTEN_FANOUT_MAX);
}

/**
 * One held listen stream: the SSE writer this invocation owns, the subscriber sockets it
 * opened (keyed by service id — its own fan-out), and whether it has ended. Every §21.2
 * delivery rule lives in these methods and nowhere else:
 *
 * - a frame a socket delivers is written PAYLOAD-VERBATIM and admission-filtered by the
 *   endpoint shape (`admits`): the DO rang every subscriber socket it holds and knows no
 *   shapes, so this is the only party that can drop the resources bell an aggregated stream
 *   does not serve;
 * - a socket close the Worker did not initiate ends the WHOLE stream — fail loud, not deaf,
 *   because a stream that silently stopped hearing one service is the one failure a doorbell
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
   * The open: one socket per service, then the first keepalive — a client learns its stream
   * is live from a byte, not from a header. Nothing is RUNG here: an open is not a change.
   *
   * That first write is deliberately not awaited. A transform stream applies backpressure
   * from its reader, and nothing reads this body until `response()` has been returned to the
   * consumer — so awaiting it here would deadlock the open against the answer it is opening.
   * `write` swallows its own failure into `end()`, so the unawaited promise can reject only
   * into a stream that has already ended.
   */
  async begin(services: readonly Service[], principal: string): Promise<void> {
    // Concurrently, like the aggregated fan-out's listing (`listAggregated`): these are up
    // to LISTEN_FANOUT_MAX round trips on the latency-critical path of a held response, and
    // the subscribed SET is already fixed by `subscribable`'s slug order, so nothing here
    // depends on the order the sockets come up in.
    await Promise.all(services.map((service) => this.subscribe(service, principal)));
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
        setTimeout(resolve, LISTEN_KEEPALIVE_MS);
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
   * One re-authorization (§21.2). The door's verdict first: a revoked or expired bearer, a
   * deleted account, another user's namespace, or (scoped) a service the caller can no
   * longer see CLOSES the stream — the tick answers exactly as a fresh open would, which is
   * what makes "a fresh open would now 404" and "the stream closed" the same sentence.
   *
   * Then the grant set, re-read: a service that left it has its socket dropped and its
   * subscriptions die with the socket, so no `resources/updated` outlives the grant that
   * authorized it; a service that joined it is subscribed and rung — the Worker is the party
   * that knows the set changed, and it rings exactly the family bells its endpoint shape
   * serves that the service's STORED capability set contains (a tools-only service granted
   * mid-stream rings the tools bell alone, because no other family of the caller's view
   * changed). On the aggregated shape the stream narrows and stays open; on the scoped shape
   * losing the service is losing the stream, which the door's verdict above already said.
   *
   * Any failure reaching a DO ends the stream rather than leaving it deaf to one service —
   * §21.2's rule for every subscriber-socket failure the Worker did not initiate.
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
      const next = await subscribable(new Registry(env.DB), ownerId, principal, slug);
      for (const serviceId of [...this.sockets.keys()]) {
        if (!next.some((service) => service.id === serviceId)) this.drop(serviceId);
      }
      for (const service of next) {
        if (this.sockets.has(service.id)) continue;
        await this.subscribe(service, principalKey(principal));
        await this.ring(service);
      }
    } catch (err) {
      // A scoped -32002 (archived mid-stream), a vanished service, a credential the door
      // refuses by throwing, or a DO that could not be reached: every one of them is a
      // stream that can no longer answer for itself, and §21.2 closes rather than deafens.
      //
      // Two failure classes, two OPERATOR signals, exactly as `listAggregated` splits them:
      // a HubError is the door or somebody's downtime answering as designed, and a stream
      // closing on it is the specified outcome rather than news. Anything else is a HUB
      // defect, and a stream that vanished with nothing in the logs is the one way this
      // design fails invisibly — so it is logged against this module.
      if (!(err instanceof HubError)) {
        console.error("pmcp/listen: hub defect on the re-authorization tick", err);
      }
      await this.end();
      return false;
    }
    return !this.ended;
  }

  /** One subscriber socket into one service's DO, wired to this stream (§21.2). */
  private async subscribe(service: Service, principal: string): Promise<void> {
    const socket = await openSubscriber(service.id, this.sessionId, principal);
    this.sockets.set(service.id, socket);
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
      if (this.sockets.get(service.id) !== socket) return;
      void this.write(`data: ${text}\n\n`, false);
    });
    socket.addEventListener("close", () => {
      // Still in the map ⇒ nobody here closed it: the DO, a deploy, or a restart did, and
      // §21.2 ends the whole stream so the client's ordinary reopen rebuilds the fan-out.
      if (this.sockets.get(service.id) === socket) void this.end();
    });
  }

  /** The bells a newly subscribed service owes this shape, derived from the SAME kind-aware
   *  shape the handshake answered (`capabilityShape`) rather than from the stored set again:
   *  a family whose shape carries no `listChanged` promises no bell, so it may not ring one.
   *  Then intersected with what the endpoint shape serves, and deduplicated — both resource
   *  catalogs answer to the one bell (§21.3).
   *
   *  Not awaited, for the reason `write` gives: a cancelled body never settles a write, and
   *  awaiting one here would wedge the tick that called it, holding every socket open. */
  private async ring(service: Service): Promise<void> {
    const shape = capabilityShape(await tunnelCapabilities(service.id), "tunnel");
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
  private drop(serviceId: string): void {
    const socket = this.sockets.get(serviceId);
    if (socket === undefined) return;
    this.sockets.delete(serviceId);
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
    for (const serviceId of [...this.sockets.keys()]) this.drop(serviceId);
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
   * is already due" is a statement about the CONSUMER. A doorbell is written when a service
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
 * TUNNELED-only: the builtin and a proxied service answer -32601 (the capability is never
 * advertised for them and there is nowhere to forward), which is decided before the audited
 * body below, exactly as the aggregated shape's refusal is decided in `route`.
 *
 * Then §7's order, with §21.4's own step in it: the URI is matched against the caller's
 * resource patterns FIRST (-32001 — an unfiltered subscribe is a standing read past the
 * role's patterns, and the filter running first is also why an ungranted URI on an archived
 * service is -32001 and not -32002), then archived (-32002), then availability (-32000),
 * then the DO's own verdict: a subscribe past either cap is refused -32602 having stored and
 * forwarded NOTHING. Passing, the frame is forwarded with its params unrewritten and the
 * same `_meta` every family carries — hub/principal, hub/roles and the mirrored
 * clientCapabilities under one strip-then-set (`prepareForward`) — and relayed verbatim.
 *
 * Exactly one audit row, written after the try/catch like every other dispatching method:
 * §21.6 records these two like a READ, so the row's `tool` column is the URI under §20.4's
 * hygiene, no body is ever carried (there is none to carry), and — like a read's — the
 * -32001 an unresolvable service earns is IN the ledger. The -32601 above it is not: a
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
  // deps: registry.getService · registry.resolveAccess · probeAvailability · tunnel.subscribe · tunnel.unsubscribe · prepareForward · audit.record
  const registry = new Registry(env.DB);
  if (slug === PMCP_SLUG) throw methodNotFound();
  const service = await registry.getService(ownerId, slug);
  if (service !== null && service.kind !== "tunnel") throw methodNotFound();

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
    // against `""` — a URI that passed no meaningful filter and that no service can emit.
    if (typeof uri !== "string") throw invalidParams();
    if (service === null) throw notPermitted();
    const filter = await registry.resolveAccess(ctx.principal, service);
    if (filter.check(uri, "resources") === "deny") throw notPermitted();
    if (service.archived) throw archived();
    const unavailableAs = await probeAvailability(service);
    if (unavailableAs !== null) throw unavailableAs;

    // The socket's stored principal is an authorization key, never the audit spelling
    // (principal.principalKey says why the two must not be the same string).
    const principal = principalKey(ctx.principal);
    if (method === "resources/subscribe") {
      if ((await tunnelSubscribe(service.id, session, principal, uri)) === "refused") {
        throw invalidParams();
      }
    } else {
      await tunnelUnsubscribe(service.id, session, principal, uri);
    }

    const serviceCtx: BackendCtx = { ...ctx, roles: filter.roleNames };
    const forwarded = prepareForward({ ...msg, params: { ...msg.params, uri } }, serviceCtx);
    const relayed = await selectBackend(service).call(service, forwarded, serviceCtx);
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
    slug: service?.slug ?? slug,
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
