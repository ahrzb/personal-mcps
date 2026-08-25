/**
 * tunnel.ts — the reverse-connection subsystem: the worker-side /connect upgrade and the
 * ServiceConnection Durable Object (the hub's only DO class), one instance per tunneled
 * service, addressed by the opaque `service.id` — never user/slug, so deleting a user and
 * recreating the username can never rebind to a stale DO.
 *
 * This module owns the whole §6 wire protocol so no other module ever learns it:
 * hub/register validation with the 10 s registration deadline (close 4004), newest-wins
 * replacement at socket *acceptance* (hub/replaced, then close 4000), the 4000–4004
 * close-code vocabulary and its client retry semantics (only 4001/4002 escape, as
 * SeverCode), liveness by WebSocket protocol pings (runtime auto-pong, no application
 * heartbeat), and the stateless 2026-07-28 wire — `initialize` never crosses; every
 * hub-originated request is self-contained, carrying its protocol `_meta` fields. It also
 * owns the hibernation discipline: socket identity rides serializeAttachment, in-flight
 * correlation lives in an in-memory Map with 30 s timeouts (safe because an unresolved
 * inbound request blocks hibernation), and the tools/list catalog is cached in DO SQLite
 * so it survives disconnects and deploys (invalidated by notifications/tools/list_changed).
 *
 * Role declarations pass straight through registry.upsertDeclaredRoles — the roles_json
 * format never enters this module. The worker half reaches its DO namespace binding
 * (SERVICE_CONNECTION) via the importable env of `cloudflare:workers`, so callers never
 * thread an env object; the composition root owns the binding name.
 */

import type { JsonRpcRequest, JsonRpcResponse, ServiceBackend, Tool } from "./gateway";
import type { Service } from "./registry";

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
 * The only close codes a caller may hand to sever(). The rest of the 4000–4004
 * vocabulary — 4000 replaced, 4003 row-gone-during-register race, 4004 protocol /
 * registration deadline — is issued by this module alone and never appears in any
 * other module's code.
 */
export type SeverCode = typeof CLOSE_REVOKED | typeof CLOSE_ARCHIVED;

/**
 * Outcome of ServiceConnection.forward — the worker↔DO seam for one forwarded call.
 * Both failure reasons map to -32000 at the backend, but they stay distinct because
 * "timeout" means the call may already have executed (every tools/call is at-most-once,
 * §15) while "offline" means it certainly did not; audit detail records which.
 */
export type ForwardResult =
  | { ok: true; response: JsonRpcResponse }
  | { ok: false; reason: "offline" | "timeout" };

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
  // deps: identity.resolveServiceToken · cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.fetch
  throw new Error("unimplemented");
}

/**
 * The tunnel implementation of ServiceBackend — how the gateway pipeline reaches a
 * tunneled service. Every method addresses the service's DO by `service.id`; none of
 * them performs authorization (the gateway's filter/archived/approval checks have
 * already run by the time a backend is called).
 */
export const tunnelBackend: ServiceBackend = {
  /**
   * The service's cached catalog, served from DO SQLite — works while the service is
   * offline and across deploys; a service that has never completed a registration lists
   * no tools. Returned unfiltered: role filtering is the gateway's job.
   */
  async listTools(service, ctx) {
    // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.listTools
    throw new Error("unimplemented");
  },

  /**
   * Forwards one request over the live registered socket and returns the service's
   * response verbatim (the gateway re-addresses it to the consumer). Before the frame
   * leaves, consumer-supplied `hub/*` `_meta` keys are stripped and the hub's own are
   * stamped — `hub/principal` and `hub/roles` from ctx, the built-in wildcard forwarded
   * literally as "all" — plus the self-contained protocol fields of §6 (protocolVersion;
   * the consumer's clientCapabilities ride through as an ordinary non-`hub/` key, `{}`
   * when the consumer declared none). Offline, unregistered, or 30 s without an answer
   * throws HubError -32000; the hub never queues, and a timed-out call may still have
   * executed (at-most-once, §15).
   */
  async call(service, msg, ctx) {
    // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.forward · gateway.HubError
    throw new Error("unimplemented");
  },

  /**
   * The schema-declared half of §7's redaction union: walks the cached catalog entry's
   * inputSchema for properties marked `writeOnly: true` at any depth and returns their
   * dot-paths relative to params.arguments (e.g. "credentials.token") — the same path
   * grammar as config-declared `redact` entries, which the caller unions in itself.
   * Returns null when the tool is absent from the cached catalog (never-connected
   * services included): the gateway answers -32000 and nothing downstream runs. Never
   * touches the live socket.
   */
  async sensitivePaths(service, tool) {
    // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.listTools
    throw new Error("unimplemented");
  },
};

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
  throw new Error("unimplemented");
}

/**
 * Erases the DO's durable footprint — cached catalog and connection metadata — returning
 * the service to its never-connected state, for service-delete and user-delete cascades.
 * Idempotent, and safe against a DO that was never woken. Leaves any live socket alone:
 * callers sever first (admin's cascade closes CLOSE_REVOKED before wiping).
 */
export async function wipe(serviceId: Service["id"]): Promise<void> {
  // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.wipe
  throw new Error("unimplemented");
}

/**
 * "online" iff the DO holds a live socket that has completed hub/register — an accepted
 * but not-yet-registered socket reads as offline (the 10 s deadline bounds that window,
 * §6). This is the availability probe the approval pipeline runs *between* check and
 * claim, so an offline service never consumes an approval, and the status column behind
 * service_list / /services. Cheap and side-effect-free.
 */
export async function status(serviceId: Service["id"]): Promise<"online" | "offline"> {
  // deps: cloudflare:workers env.SERVICE_CONNECTION · ServiceConnection.status
  throw new Error("unimplemented");
}

/**
 * The per-service Durable Object: at most one accepted socket ever (newest wins at
 * acceptance), the cached tools/list catalog in its own SQLite, in-flight correlation in
 * memory. It trusts the worker half completely — an upgrade only reaches fetch() after
 * handleConnect authenticated the service token, and no other entry point carries
 * credentials at all. At implementation this extends DurableObject from
 * `cloudflare:workers` with the WebSocket hibernation API and SQLite storage
 * (new_sqlite_classes); every non-fetch entry point below is a stub RPC method.
 */
export class ServiceConnection {
  /**
   * Hub-initiated requests awaiting their response frame, keyed by wire id. In-memory on
   * purpose: an unresolved inbound consumer request blocks hibernation, so this map can
   * only vanish when it is already empty or the DO is forcibly restarted — and a forced
   * restart fails the call to a caller who retries (§6). Every entry is armed with the
   * 30 s timeout; webSocketClose/Error drain it immediately.
   */
  private pending = new Map<string, (outcome: ForwardResult) => void>();

  /**
   * The upgrade receiver — the only traffic that enters as HTTP, and only from
   * handleConnect. Evicts any current socket first (hub/replaced notification, then
   * close 4000) at *acceptance*, before the newcomer registers, so there is never a
   * two-socket window — and writes the connect.replaced audit row, because with a stolen
   * token eviction-and-impersonation looks exactly like this. Accepts the new socket
   * into the hibernation API with the connection identity (service id/slug/owner,
   * opening token, not-yet-registered) attached via serializeAttachment, and arms the
   * 10 s registration deadline. Anything that is not a WebSocket upgrade is rejected.
   */
  async fetch(req: Request): Promise<Response> {
    // deps: DO ctx.acceptWebSocket · DO ws.serializeAttachment · DO ctx.storage.setAlarm · audit.record
    throw new Error("unimplemented");
  }

  /**
   * One JSON-RPC message per WS text frame, routed by namespace. hub/register: the
   * declaration is handed to registry.upsertDeclaredRoles (which owns validation and
   * drift auditing); a rejected declaration gets a JSON-RPC error reply and close 4004,
   * a vanished service row closes 4003, success replies {ok:true}, writes the
   * connect.register audit row, and immediately issues tools/list to warm the catalog.
   * After registration: correlation replies resolve the pending map, and
   * notifications/tools/list_changed invalidates the cached catalog and re-lists. Any
   * pre-registration message other than hub/register is a protocol error — error reply,
   * then close 4004. The hub never forwards consumer traffic to an unregistered socket.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // deps: registry.upsertDeclaredRoles · audit.record · DO SQLite `catalog` · DO ws.serializeAttachment
    throw new Error("unimplemented");
  }

  /**
   * Fails every pending correlation entry fast — in-flight consumers get -32000 and
   * retry — and lets the socket go. Reconnection is entirely the client library's job;
   * the DO never dials out (outbound sockets block hibernation, §3).
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * A transport error is a disconnect: same drain-the-pending-map treatment as
   * webSocketClose, nothing more.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // deps: none
    throw new Error("unimplemented");
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
    throw new Error("unimplemented");
  }

  /**
   * The cached catalog, verbatim as last received from the service — names,
   * descriptions, inputSchema (the schemas are what sensitivePaths walks). Empty for a
   * service that has never completed a registration. Never touches the socket.
   */
  async listTools(): Promise<Tool[]> {
    // deps: DO SQLite `catalog`
    throw new Error("unimplemented");
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
    throw new Error("unimplemented");
  }

  /**
   * DO half of the worker-side sever(): closes the live socket with the given code, or
   * does nothing when offline — or when onlyIfTokenId names a token other than the one
   * this connection was opened with.
   */
  async sever(code: SeverCode, onlyIfTokenId?: string): Promise<void> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    throw new Error("unimplemented");
  }

  /**
   * DO half of the worker-side wipe(): drops everything this DO persists — catalog and
   * connection metadata — returning it to the never-connected state. Idempotent.
   */
  async wipe(): Promise<void> {
    // deps: DO SQLite `catalog` · DO SQLite `connection`
    throw new Error("unimplemented");
  }

  /**
   * DO half of the worker-side status(): "online" iff a live socket has completed
   * hub/register.
   */
  async status(): Promise<"online" | "offline"> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    throw new Error("unimplemented");
  }
}
