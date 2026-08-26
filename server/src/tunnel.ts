/**
 * tunnel.ts — the reverse-connection subsystem: the worker-side /connect upgrade and the
 * ServiceConnection Durable Object (the hub's only DO class), one instance per tunneled
 * service, addressed by the opaque `service.id` — never user/slug, so deleting a user and
 * recreating the username can never rebind to a stale DO.
 *
 * This module owns the whole §6 wire protocol so no other module ever learns its
 * MECHANICS — framing, correlation, the attachment format. The protocol's published
 * VOCABULARY (the 4000–4004 close codes and the hub/* method names) is different: it
 * is the cross-language contract the client libraries hard-code, so it is exported
 * below for exactly one consumer — the contracts fixture producer (§4 of the testing
 * strategy; the tunnel protocol suite asserts observed wire values equal these
 * exports, locking behavior to the table). No sibling module imports them:
 * hub/register validation with the 10 s registration deadline (close 4004), newest-wins
 * replacement at socket *acceptance* (hub/replaced, then close 4000) — only 4001/4002
 * escape as SeverCode for callers — liveness by WebSocket protocol pings (runtime auto-pong, no application
 * heartbeat), and the stateless 2026-07-28 wire — `initialize` never crosses; every
 * hub-originated request is self-contained, carrying its protocol `_meta` fields. It also
 * owns the hibernation discipline: socket identity rides serializeAttachment, in-flight
 * correlation lives in an in-memory Map with 30 s timeouts (safe because an unresolved
 * inbound request blocks hibernation), and the tools/list catalog is cached in DO SQLite
 * so it survives disconnects and deploys (invalidated by notifications/tools/list_changed,
 * and re-listed on the next demand when a registration's warm never landed one — an
 * online service serving no catalog refuses every call, so it may not be a terminal state).
 *
 * One MECHANIC is published rather than hidden, because a test leans on it: the
 * correlation deadline is armed ONCE per hub-originated request, as a single ambient
 * `setTimeout` at exactly limits.CALL_TIMEOUT_MS (ServiceConnection.request). That is the
 * seam tunnel/pipeline-tunnel.test.ts shrinks to observe §15's deadline against the
 * constant instead of waiting it out — so arming it differently (a storage alarm, a value
 * derived from the constant) is a change to this sentence and to that suite, never a
 * silent one.
 *
 * Role declarations pass straight through registry.upsertDeclaredRoles — the roles_json
 * format never enters this module. The worker half reaches its DO namespace binding
 * (SERVICE_CONNECTION) via the importable env of `cloudflare:workers`, so callers never
 * thread an env object; the composition root owns the binding name.
 */

import { DurableObject, env } from "cloudflare:workers";
import { record } from "./audit";
import { CODES, HubError, unavailable } from "./errors";
import type { BackendCtx, JsonRpcRequest, JsonRpcResponse, ServiceBackend, Tool } from "./gateway";
import { formatPrincipal } from "./principal";
import { resolveServiceToken } from "./identity";
import { CALL_TIMEOUT_MS, REGISTRATION_DEADLINE_MS } from "./limits";
import { Registry, validateRoles, validateSchemaIndirection, writeOnlyPaths } from "./registry";
import type { RoleDeclaration, Service } from "./registry";

/**
 * Close code for connection replacement: a newer socket took the slot (after the
 * hub/replaced notification) — the client stops quietly and never reconnects (§6).
 * Exported as published vocabulary (module header); never a SeverCode.
 */
export const CLOSE_REPLACED = 4000;

/**
 * Close code for token-revoked / service-deleted evictions: the client library treats it
 * like a 401 — stop reconnecting and surface a credentials error (§6).
 */
export const CLOSE_REVOKED = 4001;

/**
 * Close code for archival: the client library keeps retrying at max backoff, so
 * unarchiving heals within a minute without touching the bot (§6).
 */
export const CLOSE_ARCHIVED = 4002;

/**
 * Close code for the row-gone-during-register race: the service row vanished between
 * upgrade and registration — the client reconnects; a truly deleted service meets
 * 401 at the next upgrade (§6). Published vocabulary; never a SeverCode.
 */
export const CLOSE_ROW_GONE = 4003;

/**
 * Close code for protocol violations and the missed registration deadline — also the
 * self-heal path for an unintelligible hibernation attachment. The client
 * reconnects (§6). Published vocabulary; never a SeverCode.
 */
export const CLOSE_PROTOCOL = 4004;

/**
 * The hub/* control-frame method names — the other half of the published wire
 * vocabulary (§6): `register` is the client's one pre-traffic obligation,
 * `replaced` the hub's step-aside notification before CLOSE_REPLACED.
 */
export const HUB_METHODS = { register: "hub/register", replaced: "hub/replaced" } as const;

/**
 * What a client library must DO about a close — the third piece of published vocabulary,
 * and the one the two client reconnect tables transcribe verbatim. It lives here beside
 * the numbers for the same reason they do: a policy change and a renumbering are the same
 * kind of change to the cross-language contract, and both must reach the fixture through
 * this module rather than through a literal typed into the fixture's producer.
 */
export type CloseBehavior = "stop_fatal" | "stop_quiet" | "reconnect";

/** How a `reconnect` behavior redials — named only where reconnecting is the behavior. */
export type CloseSchedule = "exponential" | "max_only";

/** The closed behavior vocabulary, as a value: a client checking its own table against
 *  the contract needs the SET, not only the per-code entries. */
export const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ["stop_fatal", "stop_quiet", "reconnect"];

/** The closed schedule vocabulary, same reason. */
export const CLOSE_SCHEDULES: readonly CloseSchedule[] = ["exponential", "max_only"];

/**
 * §6's close-code → required-client-behavior table, whole. Every code above appears
 * exactly once, and the reasoning for each is on the constant itself.
 */
export const CLOSE_POLICY: Readonly<
  Record<number, { behavior: CloseBehavior; schedule?: CloseSchedule }>
> = {
  [CLOSE_REPLACED]: { behavior: "stop_quiet" },
  [CLOSE_REVOKED]: { behavior: "stop_fatal" },
  [CLOSE_ARCHIVED]: { behavior: "reconnect", schedule: "max_only" },
  [CLOSE_ROW_GONE]: { behavior: "reconnect", schedule: "exponential" },
  [CLOSE_PROTOCOL]: { behavior: "reconnect", schedule: "exponential" },
};

/**
 * The only close codes a caller may hand to sever(). CLOSE_REPLACED / CLOSE_ROW_GONE /
 * CLOSE_PROTOCOL are issued by this module alone — exported above as contract
 * vocabulary, never accepted here.
 */
export type SeverCode = typeof CLOSE_REVOKED | typeof CLOSE_ARCHIVED;

/**
 * Why a forward produced no answer — the §15 at-most-once question, in three words.
 * Exactly ONE of them means the frame certainly did not execute: `offline`, where nothing
 * was sent and the hub has no outbox. The other two are both "it LEFT and drew no readable
 * answer", told apart only for the operator reading the ledger: `timeout` is the budget
 * expiring (and an answer this hub cannot parse, which is the same silence), `disconnected`
 * is the socket dying under a frame already on the wire.
 */
export type ForwardFailure = "offline" | "timeout" | "disconnected";

/**
 * Outcome of ServiceConnection.forward — the worker↔DO seam for one forwarded call.
 * Every failure reason maps to -32000 at the backend, but they stay distinct because only
 * `offline` means the call certainly did not execute; the backend hands the reason to
 * errors.unavailable, which puts it on the thrown HubError as its `auditDetail` and — for
 * the two that may have run — as the may-have-executed clause of its message, which is how
 * it reaches the tools/call row and the consumer.
 *
 * `response` is ESTABLISHED, never asserted: answerOf parses it out of the inbound frame,
 * so `ok: true` really does mean a JSON-RPC response with exactly one of result/error.
 */
export type ForwardResult =
  | { ok: true; response: JsonRpcResponse }
  | { ok: false; reason: ForwardFailure };

/**
 * Worker half of `wss://<host>/connect`: authenticates the `pmcp_svc_` bearer, resolves
 * the tunneled service, and hands the upgrade to that service's DO by `service.id`.
 *
 * The response status is a pinned contract with the client libraries (§6): 401 for every
 * credential failure — missing/invalid/expired/revoked token, wrong token kind, service
 * row gone or of proxy kind — meaning fatal, stop and surface; 403 means exactly one
 * thing, the service is archived — keep retrying at max backoff so unarchiving heals on
 * its own; success is the 101 upgrade with the socket accepted by the DO. Never consults
 * cookies or query-string tokens. The DO learns the connection's identity (service, owner,
 * opening token) from this handler, not from re-validating anything itself.
 */
export async function handleConnect(req: Request): Promise<Response> {
  // deps: identity.resolveServiceToken · registry.serviceById · cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.fetch
  if (!isUpgrade(req)) return refuse(426, "Upgrade Required");
  const resolved = await resolveServiceToken(req);
  // One verdict for every credential failure — which check refused is never observable.
  // The verdict carries the token ROW's id, so the plaintext bearer never leaves
  // identity.ts and the hashing scheme keeps one home (§15).
  if (resolved === null) return refuse(401, "Unauthorized");
  const service = await new Registry(env.DB).serviceById(resolved.serviceId);
  if (service === null || service.kind !== "tunnel") return refuse(401, "Unauthorized");
  // The one thing 403 means (§6): archived, so the client keeps retrying and unarchiving
  // heals without touching the bot.
  if (service.archived) return refuse(403, "Forbidden");
  // A FRESH request, not a forward of this one: the DO learns the connection's identity
  // from these four headers and must never see the bearer that produced them (§3, §15).
  return connectionFor(service.id).fetch(
    new Request(req.url, {
      headers: {
        Upgrade: "websocket",
        [IDENTITY_HEADER.service]: service.id,
        [IDENTITY_HEADER.owner]: service.ownerId,
        [IDENTITY_HEADER.slug]: service.slug,
        [IDENTITY_HEADER.token]: resolved.tokenId,
      },
    }),
  );
}

/** The `Upgrade: websocket` test both halves of the seam apply — the worker's door and the
 *  DO's, which accepts nothing else. */
function isUpgrade(req: Request): boolean {
  return req.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** A refused upgrade: a status and nothing else. The client library reads the number, and
 *  §6 gives the body no meaning — so it carries no hint of which check refused. */
function refuse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * The four headers the worker half hands the DO — an internal seam between the two halves
 * of this module, never a wire format and never carrying credential material (§3: the DO
 * trusts the Worker and validates nothing itself; §15: the bearer stops here).
 */
const IDENTITY_HEADER = {
  service: "x-pmcp-service-id",
  owner: "x-pmcp-owner-id",
  slug: "x-pmcp-slug",
  token: "x-pmcp-token-id",
} as const;

/** The one place a service id becomes a DO stub — every export below goes through it. */
function connectionFor(serviceId: Service["id"]): ServiceConnection {
  const namespace = env.SERVICE_CONNECTION as DurableObjectNamespaceLike<ServiceConnection>;
  return namespace.get(namespace.idFromName(serviceId));
}

/**
 * The tunnel implementation of ServiceBackend — how the gateway pipeline reaches a
 * tunneled service. Every method addresses the service's DO by `service.id`; none of
 * them performs authorization (the gateway's filter/archived/approval checks have
 * already run by the time a backend is called).
 */
export const tunnelBackend: ServiceBackend = {
  /**
   * Serves ServiceConnection.listTools's cached catalog — that method owns the contract.
   * What this half adds: worker-side DO addressing, and that the list is returned
   * unfiltered, because role filtering is the gateway's job.
   */
  async listTools(service, ctx) {
    // deps: viaConnection · ServiceConnection.listTools
    return cachedCatalog(service.id);
  },

  /**
   * Forwards one request over the live registered socket and returns the service's
   * response verbatim (the gateway re-addresses it to the consumer). Before the frame
   * leaves it is stamped with the §6 fields a self-contained hub-originated request must
   * carry — see `stamped`. Offline, unregistered, 30 s without an answer, a socket that
   * died under the frame, or a DO that could not be reached at all: all throw HubError
   * -32000, and the hub never queues. Which of them it was is not lost — the class rides
   * errors.unavailable into the audit row and, for everything but the offline case, tells
   * the consumer the call may still have executed (at-most-once, §15).
   */
  async call(service, msg, ctx) {
    // deps: viaConnection · ServiceConnection.forward · errors.unavailable
    // A stub that breaks may have broken AFTER the frame left, so the DO's own failure is
    // a dispatch failure like any other rather than an unclassified -32603 (§10's code
    // contract: map any DO-stub throw to -32000).
    const outcome = await viaConnection(service.id, "do_unreachable", (connection) =>
      connection.forward(stamped(msg, ctx)),
    );
    // Every reason is one -32000 on the wire; which one it was rides the error's
    // auditDetail into the tools/call row, which is the only place §15's at-most-once
    // question — did this call certainly not execute, or may it have? — can be answered.
    if (!outcome.ok) throw unavailable(outcome.reason);
    return outcome.response;
  },

  /**
   * The schema-declared half of §7's redaction union, both directions: hands the
   * cached catalog entry's inputSchema and outputSchema each to
   * registry.writeOnlyPaths — the one definition of the path grammar — and returns
   * `{ args, results }` (an absent outputSchema yields empty results); the caller
   * unions config-declared `redact` / `redact_results` paths in itself.
   * Returns null when the tool is absent from the cached catalog (never-connected
   * services included) OR cached flagged schema-unsound (its schema tripped
   * validateSchemaIndirection at catalog warm, §7): the gateway answers -32001
   * (indistinguishable from
   * not-permitted, §7) and nothing downstream runs. Answers from the cache: the one thing
   * it can put on the live socket is listTools's own re-warm, which nothing here awaits.
   */
  async sensitivePaths(service, tool) {
    // deps: viaConnection · ServiceConnection.listTools · registry.writeOnlyPaths
    const entry = (await cachedCatalog(service.id)).find((t) => t.name === tool);
    if (entry === undefined) return null;
    if (schemaViolations(entry).length > 0) return null;
    return {
      args: writeOnlyPaths(entry.inputSchema),
      results: entry.outputSchema === undefined ? [] : writeOnlyPaths(entry.outputSchema),
    };
  },
};

/** The DO's cached catalog as the worker half reads it — the one place both backend
 *  methods that need it go through, so the RPC contract below is applied once. */
function cachedCatalog(serviceId: Service["id"]): Promise<Tool[]> {
  // deps: viaConnection · ServiceConnection.listTools
  return viaConnection(serviceId, "catalog_unreachable", (connection) => connection.listTools());
}

/**
 * One DO RPC on the consumer's path, inside §7's pinned contract. A stub call can fail for
 * reasons that are nothing to do with the service — the instance forcibly restarted, the
 * namespace refusing, the RPC itself breaking — and none of those is a HubError, so without
 * this the gateway maps them to -32603 with the cause discarded and the tools/call row
 * loses its failure class. §10 names it as a code contract for exactly that reason: map any
 * DO-stub throw to -32000. A HubError from inside the DO is already in the contract and
 * passes through untouched.
 *
 * NOT applied to sever/wipe: those are owner-side cascades whose failure must reach the
 * owner as a failed admin op, and "service unavailable" is not what a failed teardown is.
 */
async function viaConnection<T>(
  serviceId: Service["id"],
  reason: DispatchFailure,
  rpc: (connection: ServiceConnection) => Promise<T>,
): Promise<T> {
  // deps: connectionFor · errors.unavailable
  try {
    return await rpc(connectionFor(serviceId));
  } catch (err) {
    if (err instanceof HubError) throw err;
    // The operator's line for a hub-side fault: the service id and the class, never a
    // credential and never a frame (§15). The exception itself is Workers Logs' business.
    console.error(`pmcp/do-rpc: ${reason} for ${serviceId}`, err);
    throw unavailable(reason);
  }
}

/**
 * Why a tunneled dispatch failed, in the vocabulary the tools/call row records — the
 * forward's three reasons plus the two the DO seam itself can fail with. All five are one
 * -32000 on the wire (§7 makes dispatch failures indistinguishable BY CODE); the ledger is
 * where they stay apart, and errors.unavailable is where each one's at-most-once disclosure
 * is decided — this module hands over the class and reads no message of its own, because a
 * proxied timeout and a tunneled one are the same fact and must not answer differently.
 */
type DispatchFailure = ForwardFailure | "do_unreachable" | "catalog_unreachable";

/**
 * One catalog entry's §7 indirection violations, both schemas at once — the refuse-line
 * registry.validateSchemaIndirection owns, applied to what the cache holds.
 *
 * ponytail: DERIVED at read time rather than stored as a flag beside the cached tool.
 * validateSchemaIndirection is pure over the very schema the cache keeps verbatim, so a
 * stored bit could only ever disagree with it — and the cache stays the verbatim oracle
 * listTools promises. The registration-time call (warmCatalog) is the LOUD half: it is
 * what puts the violations in front of the service and the operator.
 */
function schemaViolations(tool: Tool): string[] {
  return [
    ...validateSchemaIndirection(tool.inputSchema),
    ...(tool.outputSchema === undefined ? [] : validateSchemaIndirection(tool.outputSchema)),
  ];
}

/**
 * One forwarded frame as the service receives it: §6's identity keys, resolved from ctx,
 * over the protocol fields every hub-originated request carries.
 *
 * It does NOT filter the consumer's `_meta`. `hub/*` HYGIENE — which consumer keys are
 * dropped, and what the reserved prefix means — is gateway.prepareForward's, a chokepoint
 * this message has already passed (that module's header owns the decision, and
 * ServiceBackend.call's interface comment says `msg` arrives post-hygiene). A second pass
 * here would be a second owner: idempotent today, and silently deleting the next `hub/*`
 * key the gateway learns to send.
 */
function stamped(msg: JsonRpcRequest, ctx: BackendCtx): JsonRpcRequest {
  const supplied = msg.params?._meta;
  const meta = withProtocolFields(
    typeof supplied === "object" && supplied !== null ? (supplied as Record<string, unknown>) : {},
  );
  meta["hub/principal"] = formatPrincipal(ctx.principal);
  meta["hub/roles"] = ctx.roles;
  return { ...msg, params: { ...(msg.params ?? {}), _meta: meta } };
}

/**
 * The self-contained protocol fields of the stateless 2026-07-28 wire — `initialize`
 * never crosses, so a request that did not carry them would be unanswerable. Shared with
 * warmCatalog, which needs them with no consumer behind it at all: the mirrored
 * capabilities are then `{}`, which is also what a consumer that declared none forwards.
 */
function withProtocolFields(meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...meta,
    [PROTOCOL_META.version]: WIRE_REVISION,
    [PROTOCOL_META.capabilities]: meta[PROTOCOL_META.capabilities] ?? {},
  };
}

/** The reserved `_meta` keys of the 2026-07-28 wire every hub-originated request carries. */
const PROTOCOL_META = {
  version: "io.modelcontextprotocol/protocolVersion",
  capabilities: "io.modelcontextprotocol/clientCapabilities",
} as const;

/** The one MCP revision this hub speaks over the socket — gateway holds the consumer-side
 *  twin of this constant; §6 pins them to the same string. */
const WIRE_REVISION = "2026-07-28";

/** The client-originated MCP notification §6 defines: the service's tool set changed. */
const TOOLS_LIST_CHANGED = "notifications/tools/list_changed";

/** The catalog, under one durable key — see ServiceConnection.listTools. */
const CATALOG_KEY = "catalog";

/**
 * Closes the service's live socket, if any, with the given code — the two owner-triggered
 * evictions: CLOSE_REVOKED for token revocation / service deletion, CLOSE_ARCHIVED for
 * archival (retry semantics on each constant). `onlyIfTokenId` makes the close
 * conditional on the connection having been opened with that token — token_revoke's
 * "sever only the socket this token opened" rule (§8). A no-op when the service is
 * offline. Never touches cached state: deletion cascades pair it with wipe, and admin
 * owns that ordering.
 */
export async function sever(serviceId: Service["id"], code: SeverCode, onlyIfTokenId?: string): Promise<void> {
  // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.sever
  await connectionFor(serviceId).sever(code, onlyIfTokenId);
}

/**
 * Erases the DO's durable footprint — everything it persists, which today is the cached
 * catalog — returning
 * the service to its never-connected state, for service-delete and user-delete cascades.
 * Idempotent, and safe against a DO that was never woken. Leaves any live socket alone:
 * callers sever first (admin's cascade closes CLOSE_REVOKED before wiping).
 */
export async function wipe(serviceId: Service["id"]): Promise<void> {
  // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.wipe
  await connectionFor(serviceId).wipe();
}

/**
 * "online" iff the DO holds a live socket that has completed hub/register — an accepted
 * but not-yet-registered socket reads as offline (the 10 s deadline bounds that window,
 * §6). This is the availability probe the approval gate consults FIRST (a known-offline
 * service is refused -32000 before any approval row is read, created, or consumed, §7)
 * and again between check and claim, so an offline service never consumes an approval —
 * and the status column behind service_list / /services. Cheap and side-effect-free.
 *
 * A DO this hub cannot reach at all reads "offline" rather than throwing: it is the
 * truthful answer to the question asked (a service whose connection cannot be consulted is
 * certainly not known-online), and it keeps a broken instance from taking out a listing.
 * The refusal it produces at the approval gate is the same -32000 an offline service gets.
 *
 * The POLICY is this function's — swallow to "offline" where the dispatch path throws — but
 * the MECHANISM is viaConnection's, so the seam has one try/catch and one operator log line
 * instead of a near-duplicate in a second grammar. It swallows viaConnection's HubError
 * passthrough too, deliberately: this probe has no consumer to reach, so a refusal the DO
 * already classified has nowhere to go, and "cannot be consulted" is the same answer
 * however the consultation failed. The passthrough exists for the dispatch path, where the
 * refusal IS the consumer's answer.
 */
export async function status(serviceId: Service["id"]): Promise<"online" | "offline"> {
  // deps: viaConnection · ServiceConnection.status
  return viaConnection(serviceId, "do_unreachable", (connection) => connection.status()).catch(
    () => "offline" as const,
  );
}

/**
 * The identity a socket carries through hibernation — stored via serializeAttachment
 * at acceptance, updated at registration, read back on every wake (alarm, forward,
 * sever, status). VERSIONED: `v` is bumped whenever this shape changes, and a wake
 * that reads an unknown or absent version treats the socket as unintelligible —
 * close 4004, and the client library's ordinary reconnect brings it back into
 * current code within seconds. That converts deploy version-skew (an old-code
 * attachment woken by new code, should hibernated sockets ever survive a deploy)
 * from silent corruption into a routine self-healing reconnect.
 */
type ConnectionAttachment = {
  v: 1;
  serviceId: string;
  ownerId: string;
  slug: string;
  /** Which token opened this connection — sever(code, onlyIfTokenId) compares against it. */
  tokenId: string;
  registered: boolean;
};

/**
 * The per-service Durable Object: at most one accepted socket ever (newest wins at
 * acceptance), the cached tools/list catalog in its own SQLite, in-flight correlation in
 * memory. It trusts the worker half completely — an upgrade only reaches fetch() after
 * handleConnect authenticated the service token, and no other entry point carries
 * credentials at all. It extends DurableObject from `cloudflare:workers` with the
 * WebSocket hibernation API and SQLite storage (new_sqlite_classes); every non-fetch
 * entry point below is an RPC method the worker half calls through the namespace binding.
 */
export class ServiceConnection extends DurableObject {
  /**
   * Hub-initiated requests awaiting their response frame, keyed by wire id. Each entry
   * remembers the SOCKET it was sent on, so failing a socket fails exactly the calls that
   * socket could still have answered — the alternative makes the at-most-one-socket
   * invariant load-bearing for correctness, and a close arriving after a replacement
   * would fail the newcomer's in-flight calls "offline" (certainly did not execute) for
   * frames already on the wire: the exact at-most-once lie §15 exists to audit.
   *
   * In-memory on purpose: an unresolved inbound consumer request blocks hibernation, so
   * this map can only vanish when it is already empty or the DO is forcibly restarted —
   * and a forced restart fails the call to a caller who retries (§6). Every entry is armed
   * with the 30 s timeout; webSocketClose/Error drain that socket's share immediately.
   *
   * `method` is what was ASKED, kept because this map is the only durable-enough place to
   * ask "is a re-warm already in flight on this socket" (rewarm) — a field would be lost at
   * the first hibernation, and an entry here cannot be, since an unresolved inbound request
   * blocks hibernation.
   */
  private pending = new Map<
    string,
    { ws: WebSocket; method: string; resolve: (outcome: ForwardResult) => void }
  >();

  /**
   * The upgrade receiver — the only traffic that enters as HTTP, and only from
   * handleConnect. Evicts any current socket first (hub/replaced notification, then
   * close 4000) at *acceptance*, before the newcomer registers, so there is never a
   * two-socket window — and writes the connect.replaced audit row, because with a stolen
   * token eviction-and-impersonation looks exactly like this. Accepts the new socket
   * into the hibernation API with the versioned ConnectionAttachment (not-yet-registered)
   * attached via serializeAttachment, and arms the registration deadline
   * (limits.REGISTRATION_DEADLINE_MS). Anything that is not a WebSocket upgrade, or that
   * does not carry the four identity headers, is rejected — the only door is
   * handleConnect, which always writes all four.
   */
  async fetch(req: Request): Promise<Response> {
    // deps: DO ctx.acceptWebSocket · DO ws.serializeAttachment · DO ctx.storage.setAlarm · audit.record · audit.resolveAuditConfig
    const arriving = identityFrom(req);
    // One refusal for "this did not come from handleConnect", whichever way it failed to.
    if (!isUpgrade(req) || arriving === null) return refuse(426, "Upgrade Required");
    // Newest wins BEFORE the newcomer is accepted, so the two-socket window never exists.
    await this.evictCurrent(arriving);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [arriving.serviceId]);
    pair[1].serializeAttachment(arriving);
    // A storage alarm, not a timer: an unregistered socket has no pending request to keep
    // this instance awake, so the deadline has to outlive hibernation (§6).
    await this.ctx.storage.setAlarm(Date.now() + REGISTRATION_DEADLINE_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * §6's replacement, at acceptance: the sitting socket is told `hub/replaced`, closed
   * 4000, and the event is written to the ledger — with a stolen service token,
   * eviction-and-impersonation looks exactly like this, so the row is the signal.
   */
  private async evictCurrent(arriving: ConnectionAttachment): Promise<void> {
    const current = this.socket();
    if (current === null) return;
    this.send(current.ws, { jsonrpc: "2.0", method: HUB_METHODS.replaced });
    this.drop(current.ws, CLOSE_REPLACED, "replaced by a newer connection");
    await this.audit(current.attachment ?? arriving, "connect.replaced", {
      // Token IDs, never token material (§15) — which credential opened each socket is
      // exactly what an owner reads this row for.
      replacedTokenId: current.attachment?.tokenId,
      tokenId: arriving.tokenId,
    });
  }

  /**
   * One JSON-RPC message per WS text frame, routed by namespace. hub/register: the
   * declaration is handed to registry.upsertDeclaredRoles (which owns validation and
   * drift auditing); a rejected declaration gets a JSON-RPC error reply and close 4004,
   * a vanished service row closes 4003, success replies {ok:true}, writes the
   * connect.register audit row, and immediately issues tools/list to warm the catalog.
   * After registration: correlation replies resolve the pending map, and
   * notifications/tools/list_changed invalidates the cached catalog and re-lists.
   * When the warmed catalog lands, each tool's input/output schemas run
   * registry.validateSchemaIndirection: violations are LOUD — echoed to the service
   * as a warning frame and logged — and the tool is cached flagged schema-unsound,
   * which makes sensitivePaths answer null for it (§7's -32001 / no-body handling);
   * the registration itself still succeeds, so one exotic tool never bricks the
   * service. Any
   * pre-registration message other than hub/register is a protocol error — error reply,
   * then close 4004. The hub never forwards consumer traffic to an unregistered socket.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // deps: registry.upsertDeclaredRoles · registry.validateSchemaIndirection · audit.record · audit.resolveAuditConfig · DO SQLite `catalog` · DO ws.serializeAttachment
    const attachment = attachmentOf(ws);
    // §10: an attachment this code cannot read is a socket it cannot serve. Closing it
    // turns deploy version-skew into the client's ordinary reconnect.
    if (attachment === null) return this.drop(ws, CLOSE_PROTOCOL, "unintelligible connection");
    const frame = parseFrame(message);
    if (!attachment.registered) return this.register(ws, attachment, frame);
    if (frame === null) return;
    // A correlated answer to something this hub asked (a forwarded call, a catalog warm).
    if (frame.method === undefined) return this.settle(frame);
    // §6's one client-originated MCP notification: the tool set changed, so re-list.
    if (frame.method === TOOLS_LIST_CHANGED) return this.warmCatalog(ws, attachment);
    // Anything else from a registered service is a frame the hub does not read (§6 v1
    // forwards tools/list and tools/call, both hub-originated). Ignored, never a close:
    // the protocol error is a PRE-registration rule.
  }

  /**
   * §6's one pre-traffic obligation, and the only frame an unregistered socket may send.
   * The declaration's rules are registry's (validateRoles); what a violation COSTS is
   * this module's: an error reply, then 4004.
   */
  private async register(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    frame: Frame | null,
  ): Promise<void> {
    const id = idOf(frame);
    if (frame === null || frame.method !== HUB_METHODS.register) {
      this.send(ws, errorFrame(id, CODES.invalidRequest, "hub/register expected first"));
      return this.drop(ws, CLOSE_PROTOCOL, "protocol error");
    }
    // The payload carries no service field, and this is where that is true: identity comes
    // from `attachment`, which the worker half built from the token alone (§6).
    const roles = declarationOf(frame);
    const violations = roles === null ? ["roles must be an object of pattern lists"] : validateRoles(roles);
    if (roles === null || violations.length > 0) {
      this.send(ws, errorFrame(id, CODES.invalidParams, `invalid declaration: ${violations.join("; ")}`));
      return this.drop(ws, CLOSE_PROTOCOL, "invalid declaration");
    }
    const registry = new Registry(env.DB);
    let drift;
    try {
      drift = await registry.upsertDeclaredRoles(attachment.serviceId, roles);
    } catch (err) {
      // WHICH refusal, asked rather than assumed. §6's reconnect race is the one this
      // socket answers 4003 to — told apart from a violation by carrying no reply at all.
      // Everything else registry or D1 can fail with is a hub defect or somebody's
      // downtime, and disguising either as "your service row is gone, reconnect" would
      // send an operator to look at a healthy row and leave no trace of the real fault.
      if ((await registry.serviceById(attachment.serviceId)) !== null) throw err;
      return this.drop(ws, CLOSE_ROW_GONE, "service row is gone");
    }
    attachment.registered = true;
    ws.serializeAttachment(attachment);
    this.send(ws, { jsonrpc: "2.0", id, result: { ok: true } });
    await this.audit(attachment, "connect.register", { roles: Object.keys(roles) });
    if (drift.widened.length > 0) {
      await this.audit(attachment, "connect.roles_widened", { widened: drift.widened });
    }
    await this.warmCatalog(ws, attachment);
  }

  /**
   * The cache warm: one hub-originated `tools/list`, and the §7 indirection refuse-line
   * applied LOUDLY to what comes back — each offending tool is named to the service in a
   * warning frame and logged, while the registration itself stands, so one exotic schema
   * never bricks a service. A warm that draws no catalog — unanswered, or answered with
   * something that is not a tool list — leaves the previous cache in place (a stale catalog
   * serves better than an empty one, §6 lifecycle 2) and is LOGGED: for a service that
   * never had a catalog the cache stays empty, which reads online while refusing every call
   * -32001, and listTools re-lists on the next demand to get out of it.
   */
  private async warmCatalog(ws: WebSocket, attachment: ConnectionAttachment): Promise<void> {
    // Parking here is safe, and the reason is not local: the answer arrives as a SEPARATE
    // webSocketMessage invocation on this same object while this handler is still awaiting.
    // A Durable Object's input gate does not hold back websocket events behind a handler
    // awaiting a non-storage promise, so the successor that resolves this request can run —
    // which is why hub/register can await its own catalog warm without deadlocking for
    // CALL_TIMEOUT_MS. Self-contained, like every hub-originated request (§6).
    const outcome = await this.request(ws, {
      jsonrpc: "2.0",
      method: "tools/list",
      params: { _meta: withProtocolFields() },
    });
    const tools = outcome.ok ? catalogOf(outcome.response) : null;
    if (tools === null) {
      // §15 hygiene: the slug so an operator can find the service, and the failure class —
      // never the answer's body. Loud because nothing else about this state is: the
      // registration succeeded and the service reads online.
      console.warn(
        `pmcp/catalog-warm-failed: ${attachment.slug}: ${outcome.ok ? "answer was not a tool list" : outcome.reason}`,
      );
      return;
    }
    await this.ctx.storage.put(CATALOG_KEY, tools);
    for (const tool of tools) {
      const violations = schemaViolations(tool);
      if (violations.length === 0) continue;
      console.warn(`pmcp/schema-unsound: ${attachment.slug}.${tool.name}: ${violations.join("; ")}`);
      this.send(ws, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "warning",
          logger: "pmcp/schema",
          data: { tool: tool.name, violations },
        },
      });
    }
  }

  /**
   * Fails the correlation entries THIS socket was carrying — in-flight consumers get
   * -32000 and retry — and lets it go. Scoped to `ws` because a replaced socket's close
   * lands after its successor is already accepted and possibly mid-call: those entries
   * belong to the newcomer and no answer to them was lost. Reconnection is entirely the
   * client library's job; the DO never dials out (outbound sockets block hibernation, §3).
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // deps: none
    this.drain(ws);
  }

  /**
   * A transport error is a disconnect: same drain-this-socket's-waiters treatment as
   * webSocketClose, nothing more.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // deps: none
    this.drain(ws);
  }

  /**
   * Enforces the registration deadline: fires ~10 s after acceptance and closes the
   * socket 4004 if hub/register has not completed. A storage alarm rather than a timer
   * because an unregistered socket has no pending request to keep the DO awake — the
   * deadline must survive hibernation. A no-op when registration already succeeded or
   * the socket is gone.
   */
  async alarm(): Promise<void> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    const current = this.socket();
    // An unintelligible attachment is treated exactly like a missed deadline: the socket
    // cannot be served, and the client's reconnect is the cure (§10).
    if (current === null || current.attachment?.registered === true) return;
    this.drop(current.ws, CLOSE_PROTOCOL, "registration deadline");
  }

  /**
   * The cached catalog, verbatim as last received from the service — names,
   * descriptions, inputSchema and outputSchema (the schemas are what sensitivePaths
   * walks, both directions §7; serving-time `writeOnly` stripping on outputSchemas
   * is the gateway's job, never done here — the cache stays the verbatim oracle).
   * Empty for a
   * service that has never completed a registration. ALWAYS answers from storage and never
   * waits on the socket — but it does fire the re-warm below when the cache is absent while
   * a registered socket is live, which is the only way out of a failed first warm.
   */
  async listTools(): Promise<Tool[]> {
    // deps: DO ctx.storage `catalog` · warmCatalog
    // ponytail: ONE durable key holding the whole catalog, absent until a registration
    // warms it — which is exactly the never-connected answer, with no table and no
    // migration to own; a SQLite-backed class stores it in SQLite either way. It is
    // written whole and read whole, and the schema-unsound flag §7 needs is DERIVED from
    // these very schemas at read time (sensitivePaths) rather than stored beside them.
    // Upgrade path, if a catalog ever grows past what one value should carry: rows keyed by
    // tool name, with this method's contract unchanged.
    const cached = await this.ctx.storage.get<Tool[]>(CATALOG_KEY);
    if (cached === undefined) this.rewarm();
    return cached ?? [];
  }

  /**
   * The recovery from a warm that never landed: an ABSENT key under a live registered
   * socket means this connection has never produced a catalog, so ask again — on demand,
   * because demand is the only thing that makes the answer worth anything. A service with a
   * genuinely empty tool set is not this: a warm that landed stored `[]`, which is present.
   *
   * Derived from the cache rather than remembered in a field, for the same reason the
   * schema-unsound flag is: an in-memory mark is lost at the first hibernation, which is
   * precisely when a wedged service would sit longest. Fired and not awaited — a tools/list
   * read must never wait out CALL_TIMEOUT_MS on a service that cannot answer — so the
   * demand that finds the gap serves the empty catalog and the one after it is served the
   * warm one; a rejection is swallowed for the same reason warmCatalog's failure is
   * survivable, and the next demand simply asks again.
   *
   * ONE at a time, and that bound is the point: this runs on DEMAND, and the demand is
   * tools/call's (sensitivePaths reads the same cache), so a wedged service that never
   * answers would otherwise draw one hub-originated tools/list per consumer call — each
   * parking a waiter for CALL_TIMEOUT_MS, and each keeping the instance awake, unbounded in
   * exactly the state this recovery was written for. The guard is READ OFF `pending` rather
   * than kept in a field of its own, which is the same no-in-memory-marks rule as above and
   * costs nothing here: a pending request cannot be hibernated away, so the map is as
   * durable as the in-flight request it is answering about.
   */
  private rewarm(): void {
    const ws = this.live();
    // Offline: nothing to ask, and the reconnect's own hub/register warms it (§6).
    if (ws === null) return;
    const attachment = attachmentOf(ws);
    if (attachment === null) return;
    // The only tools/list this DO ever originates is a warm — forward() carries consumer
    // tools/call and nothing else — so one on this socket IS a warm still in flight.
    for (const waiter of this.pending.values()) {
      if (waiter.ws === ws && waiter.method === "tools/list") return;
    }
    void this.warmCatalog(ws, attachment).catch(() => undefined);
  }

  /**
   * Sends one already-stamped frame to the live registered socket and resolves with the
   * correlated outcome. The wire id is a fresh UUID owned by this DO — the consumer's
   * JSON-RPC id never crosses the socket, and the returned response still bears the wire
   * id (re-addressing is the gateway's job). No live registered socket resolves
   * { ok: false, reason: "offline" } without sending; no answer within 30 s resolves
   * { ok: false, reason: "timeout" } and the late reply, if any, is dropped.
   */
  async forward(msg: JsonRpcRequest): Promise<ForwardResult> {
    // deps: crypto.randomUUID · DO ctx.getWebSockets · DO ws.deserializeAttachment
    const ws = this.live();
    // Nothing is sent and nothing is queued: the hub has no outbox (§15).
    if (ws === null) return { ok: false, reason: "offline" };
    return this.request(ws, msg);
  }

  /**
   * One hub-originated request over `ws`, correlated on a fresh wire id — the consumer's
   * own JSON-RPC id never crosses the socket. The 30 s budget is armed here rather than at
   * the call sites so every hub-originated request has exactly one; a late answer finds no
   * entry and is dropped.
   */
  private request(ws: WebSocket, msg: Omit<JsonRpcRequest, "id">): Promise<ForwardResult> {
    const id = crypto.randomUUID();
    return new Promise<ForwardResult>((resolve) => {
      // ONE ambient setTimeout at exactly CALL_TIMEOUT_MS — the module header publishes
      // this as the deadline's seam, because a suite shrinks it to observe §15's budget.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "timeout" });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        ws,
        method: msg.method,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(outcome);
        },
      });
      try {
        ws.send(JSON.stringify({ ...msg, id }));
      } catch {
        // The socket died between the liveness read and the send: the call never left, so
        // it certainly did not execute.
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, reason: "offline" });
      }
    });
  }

  /** A correlated answer: resolve its waiter, or drop it (a reply past the 30 s budget). */
  private settle(frame: Frame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    const answer = answerOf(frame);
    // A frame that is not a JSON-RPC response is not an answer. Resolving it `ok` would
    // hand the gateway something whose `error === undefined` reads as outcome "ok" and
    // relay a memberless response to the consumer. The call DID reach the service, so the
    // reason is the may-have-executed one — "timeout" is this type's word for exactly that.
    waiter.resolve(answer === null ? { ok: false, reason: "timeout" } : { ok: true, response: answer });
  }

  /**
   * Every waiter this socket was carrying fails at once — it is gone, so no answer to
   * those correlations can ever arrive. Waiters on any other socket are untouched.
   *
   * `disconnected`, never `offline`: every entry in this map is a frame that was already
   * SENT (request() registers it and sends in the same synchronous step, and a send that
   * threw removes it again), so each of these calls may already have executed at the
   * service. Reporting them as the certainly-did-not-execute reason is the exact
   * at-most-once lie §15 exists to audit — and the consumer, told nothing left, retries.
   */
  private drain(ws: WebSocket): void {
    for (const [id, waiter] of [...this.pending]) {
      if (waiter.ws !== ws) continue;
      this.pending.delete(id);
      waiter.resolve({ ok: false, reason: "disconnected" });
    }
  }

  /**
   * The DO's one socket, or null. §6's at-most-one invariant is maintained in a single
   * place — fetch(), which evicts before it accepts — and read in a single place here, so
   * no method below has to re-derive it or loop "just in case". `attachment` is null when
   * the identity cannot be read (§10's version-skew branch).
   */
  private socket(): { ws: WebSocket; attachment: ConnectionAttachment | null } | null {
    const [ws] = this.ctx.getWebSockets();
    return ws === undefined ? null : { ws, attachment: attachmentOf(ws) };
  }

  /** The live REGISTERED socket, or null — §6's whole definition of "online". */
  private live(): WebSocket | null {
    const current = this.socket();
    return current?.attachment?.registered === true ? current.ws : null;
  }

  /** Closes one socket and fails everything that was waiting on IT. Never throws: a socket
   *  that is already gone is the outcome this asks for. */
  private drop(ws: WebSocket, code: number, reason: string): void {
    this.drain(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  /** One frame out, best-effort: a send onto a dying socket is not a failure of whatever
   *  the hub was doing when it tried. */
  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // already closed
    }
  }

  /** One audit row for a connection event, in the namespace the connection belongs to. */
  private async audit(
    attachment: ConnectionAttachment,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await record(env.DB, {
      ownerId: attachment.ownerId,
      principal: `svc:${attachment.slug}`,
      event,
      service: attachment.slug,
      outcome: "ok",
      detail,
    });
  }

  /** DO half of the module-level sever(), whose comment is this operation's contract. */
  async sever(code: SeverCode, onlyIfTokenId?: string): Promise<void> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    const current = this.socket();
    if (current === null) return;
    // §8's rotation rule: a revoke names ONE token, and a socket opened with the other
    // one must survive it. An attachment that cannot be read names no token either.
    if (onlyIfTokenId !== undefined && current.attachment?.tokenId !== onlyIfTokenId) return;
    this.drop(current.ws, code, "severed");
  }

  /** DO half of the module-level wipe(), whose comment is this operation's contract. */
  async wipe(): Promise<void> {
    // deps: DO ctx.storage `catalog`
    // Everything this DO persists is durable storage, so the whole store IS the footprint
    // — and deleting all of it is idempotent on a DO that never woke.
    await this.ctx.storage.deleteAll();
  }

  /** DO half of the module-level status(), whose comment is this operation's contract. */
  async status(): Promise<"online" | "offline"> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    return this.live() === null ? "offline" : "online";
  }
}

/**
 * The connection's identity as the worker half wrote it, or null when any of the four
 * headers is absent — total, like every other reader of an inbound message here. The DO's
 * only door is handleConnect, which always writes all four, so null means the request did
 * not come through it: refusing beats manufacturing an attachment that would then audit
 * under `ownerId: ""`, tag the socket `""`, and survive every targeted revoke (§8).
 */
function identityFrom(req: Request): ConnectionAttachment | null {
  const serviceId = req.headers.get(IDENTITY_HEADER.service);
  const ownerId = req.headers.get(IDENTITY_HEADER.owner);
  const slug = req.headers.get(IDENTITY_HEADER.slug);
  const tokenId = req.headers.get(IDENTITY_HEADER.token);
  if (serviceId === null || ownerId === null || slug === null || tokenId === null) return null;
  return { v: 1, serviceId, ownerId, slug, tokenId, registered: false };
}

/** One inbound frame, read as far as the router needs: a method makes it a request or
 *  notification, its absence makes it an answer. Everything else stays opaque. */
type Frame = Record<string, unknown> & { method?: unknown; id?: unknown };

/** The socket's identity, or null when the attachment is absent or of an unknown version
 *  (§10's version-skew branch — every read goes through here, so there is one place it can
 *  be decided). */
function attachmentOf(ws: WebSocket): ConnectionAttachment | null {
  const raw = ws.deserializeAttachment();
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as ConnectionAttachment;
  return candidate.v === 1 ? candidate : null;
}

/** One text frame as JSON, or null for anything that is not a JSON object at all —
 *  binary frames included, which this protocol never uses. */
function parseFrame(message: string | ArrayBuffer): Frame | null {
  if (typeof message !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Frame)
      : null;
  } catch {
    return null;
  }
}

/** A frame's JSON-RPC id, or null — JSON-RPC's own rule for a message whose id cannot be
 *  read, which is what an unparseable first frame is answered with. */
function idOf(frame: Frame | null): string | number | null {
  const id = frame?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** `hub/register`'s declaration, or null when the payload is not one — the wire shape
 *  registry.validateRoles is contracted to receive (role → list of pattern strings). */
function declarationOf(frame: Frame): RoleDeclaration | null {
  const params = frame.params;
  const roles = typeof params === "object" && params !== null ? (params as Record<string, unknown>).roles : undefined;
  // §6: `{}` and an absent `roles` alike mean "no roles declared" — a declaration, not a
  // violation.
  if (roles === undefined) return {};
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) return null;
  for (const value of Object.values(roles)) {
    if (!Array.isArray(value) || value.some((p) => typeof p !== "string")) return null;
  }
  return roles as RoleDeclaration;
}

/**
 * A correlated answer, or null for a frame that is not a JSON-RPC response at all —
 * JSON-RPC's own rule: the 2.0 envelope, and exactly one of `result`/`error`. The service
 * is the untrusted side of this socket, so ForwardResult's `response` is ESTABLISHED here
 * rather than asserted; nothing crosses into hub types on a cast.
 */
function answerOf(frame: Frame): JsonRpcResponse | null {
  if (frame.jsonrpc !== "2.0") return null;
  const carriesResult = "result" in frame;
  const carriesError = "error" in frame;
  if (carriesResult === carriesError) return null;
  const id = idOf(frame);
  return carriesResult
    ? { jsonrpc: "2.0", id, result: frame.result }
    : { jsonrpc: "2.0", id, error: errorMemberOf(frame.error) };
}

/**
 * The service's `error` member, NORMALIZED rather than cast. The gateway relays a service's
 * error to the consumer verbatim (§7), so whatever sits here becomes a JSON-RPC error
 * object on a consumer's wire — and JsonRpcResponse says error shapes come from the
 * gateway's own table, which a cast quietly makes untrue for the one member the untrusted
 * side of this socket writes. A member that is not an object, or whose `code`/`message` are
 * not an integer and a string, is replaced whole by the generic internal error: the answer
 * still counts as an error — the call DID reach the service and DID fail there, which is
 * the audit row's "error" outcome — it simply cannot put arbitrary bytes in the error slot.
 * `data` is free-form by JSON-RPC and passes through, but only alongside a well-formed rest.
 */
function errorMemberOf(raw: unknown): JsonRpcResponse["error"] {
  const carrier = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const { code, message } = carrier;
  if (!Number.isInteger(code) || typeof message !== "string") {
    return { code: CODES.internal, message: "service error" };
  }
  const error = { code: code as number, message };
  return "data" in carrier ? { ...error, data: carrier.data } : error;
}

/** A `tools/list` answer's catalog, or null when the service answered with an error or
 *  with something that is not a tool list — either way the previous cache stands. A tool
 *  with no object inputSchema is not a Tool: sensitivePaths walks that schema, and a
 *  string there would be a walk over something the type says cannot happen. */
function catalogOf(response: JsonRpcResponse): Tool[] | null {
  const result = response.result;
  if (typeof result !== "object" || result === null) return null;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return null;
  return tools.filter(
    (tool): tool is Tool =>
      typeof tool?.name === "string" && typeof tool?.inputSchema === "object" && tool.inputSchema !== null,
  );
}

/** A JSON-RPC error reply, the only error object this module builds — §7's consumer wire
 *  is gateway's, and none of these frames ever reaches a consumer. */
function errorFrame(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
