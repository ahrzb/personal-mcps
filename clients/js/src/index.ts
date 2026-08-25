// @personal-mcps/client — the service-author library (spec §6, §11). A plain MCP
// server object goes in; this module keeps it reachable through the hub's reverse
// tunnel.
//
// OWNS the client side of the reverse-connection protocol: deriving
// wss://<host>/connect from the hub's https origin, the hub/register handshake
// (re-sent on every (re)connect), the split between hub/* control frames and MCP
// traffic, WebSocket protocol pings (~25 s, no application heartbeat), and the
// entire disconnect policy — the close-code vocabulary 4000–4004 and the upgrade
// statuses 401/403 map onto exactly three behaviors (stop quietly, stop with an
// error, reconnect with backoff), decided in HubTransport and nowhere else.
//
// HIDES the wire completely: the author never sees a socket, a JSON-RPC frame, or
// a reconnect. One deliberate absence: the library never buffers traffic for an
// offline hub — while disconnected the hub is already failing consumer calls with
// -32000, and outbound notifications are dropped (the hub re-lists tools after
// every registration, so a dropped list_changed heals itself).

/** The author's MCP server — `Server` (or `McpServer`) from `@modelcontextprotocol/server` v2; external, never imported here. */
export type McpServer = unknown;

/** One MCP wire message — `JSONRPCMessage` from `@modelcontextprotocol/server`; external, never imported here. */
export type JsonRpcMessage = unknown;

/**
 * The role declaration sent in `hub/register`: role name → anchored patterns over
 * tool names (§2's one pattern language — a bare tool name matches itself, `*`
 * aliases `.*`). Validation is the hub's job, not this library's: names must match
 * `[a-z0-9_-]{1,64}`, `all` is reserved, and pattern length (≤128) and per-role
 * count (≤64) are capped — a violating declaration is rejected at registration,
 * which serve() surfaces as RegistrationError.
 */
export type Roles = Record<string, string[]>;

export type ServeOptions = {
  /**
   * The hub's https origin, e.g. "https://mcp.example.com" — a bare origin, no
   * path (PMCP_URL, §10). Default: the PMCP_URL env var; neither set is a
   * TypeError. The wss://<host>/connect address is derived internally — it is
   * never passed in directly.
   */
  url?: string;
  /**
   * The service token (`pmcp_svc_…`). Default: the PMCP_SERVICE_TOKEN env var.
   * The service identity comes entirely from this token — there is deliberately
   * no service/slug option (§6: a token for one slug can never touch another).
   */
  token?: string;
  /**
   * Role declaration for this service. Omitted or `{}` declares none — the
   * service is then reachable only by owner tokens or grants of the built-in
   * `all` role (§6).
   */
  roles?: Roles;
};

/**
 * The credential is dead: 401 at upgrade or close 4001 after establishment —
 * revoked/expired token, wrong token kind, or deleted service. Terminal; the
 * library never retries a dead credential (§6's upgrade matrix).
 */
export class CredentialsError extends Error {}

/**
 * The hub rejected the `hub/register` role declaration (bad role name,
 * non-compiling pattern, over caps — §6). Terminal: identical input cannot start
 * succeeding, so this is surfaced immediately instead of retried.
 */
export class RegistrationError extends Error {}

/**
 * Run `server` as a tunneled hub service: dial, register the role declaration,
 * and stay reachable until the hub says otherwise. The returned promise pends for
 * the life of the service — hours to months; treat it as the bot's main loop.
 *
 * Terminal outcomes are the whole resolution contract:
 * - resolves quietly when the hub replaces this connection with a newer one for
 *   the same service (`hub/replaced`, close 4000) — this copy steps aside and
 *   never reconnects (§6: two copies fighting for the slot is an operator error
 *   worth surfacing);
 * - rejects with CredentialsError or RegistrationError (see those types);
 * - every other failure — network drop, hub deploy, registration deadline (4004),
 *   archived service (403 at upgrade / close 4002) — reconnects forever and never
 *   resolves. The full policy lives on HubTransport.
 *
 * Reconnects re-register and re-warm the hub's tool cache automatically; nothing
 * is buffered while offline (module header).
 */
export async function serve(server: McpServer, options?: ServeOptions): Promise<void> {
  // deps: HubTransport · @modelcontextprotocol/server (Server.connect)
  throw new Error("unimplemented");
}

/**
 * The Transport bridge: implements the MCP SDK `Transport` interface (from
 * `@modelcontextprotocol/server` v2) over an outbound `ws` WebSocket to
 * wss://<host>/connect. serve() is sugar over this; construct it directly only to
 * wire the SDK session yourself.
 *
 * One transport is one service lifetime, not one socket: reconnects — jittered
 * exponential backoff, 1 s → 60 s cap, forever (hub deploys sever every socket,
 * so this is routine; the schedule itself is backoffDelay, exported pure) —
 * happen inside, invisible to the SDK session, and
 * `hub/register` is re-sent on every (re)connect. `onclose` fires once, at a
 * terminal state only.
 *
 * The disconnect policy, decided here and nowhere else (§6):
 * - 401 at upgrade, close 4001 — dead credential: terminal, CredentialsError.
 * - 403 at upgrade, close 4002 — archived: keep retrying at max backoff, so
 *   unarchiving heals within a minute without touching the bot.
 * - close 4000 (after `hub/replaced`) — a newer connection took the slot: stop
 *   quietly, never reconnect.
 * - register rejected — terminal, RegistrationError.
 * - everything else (network, deploy, close 4003/4004) — reconnect with backoff;
 *   a truly deleted service becomes 401 at the next upgrade, the fatal path.
 *
 * `hub/*` control frames never reach the SDK session; everything else is MCP
 * traffic, one JSON-RPC message per WS text frame. Liveness is WebSocket protocol
 * pings (~25 s); there is no application heartbeat.
 */
export class HubTransport {
  /**
   * Settles when the transport reaches a terminal state: resolves after
   * `hub/replaced` (close 4000) or a local close(); rejects with
   * CredentialsError / RegistrationError. Never settles on an ordinary
   * disconnect — those reconnect. serve() awaits exactly this.
   */
  readonly closed!: Promise<void>;

  /** Assigned by the SDK session (Transport contract): called once per inbound MCP message; hub/* control frames are consumed internally and never appear here. */
  onmessage?: (message: JsonRpcMessage) => void;

  /** Assigned by the SDK session (Transport contract): fired once, at the terminal state only — reconnects are invisible. */
  onclose?: () => void;

  /** Assigned by the SDK session (Transport contract): transport-level errors worth logging; every fatal one also settles `closed`. */
  onerror?: (error: Error) => void;

  /**
   * `url` is the hub's https origin — a bare origin, no path; anything else is a
   * TypeError here, before any I/O. `token` is the `pmcp_svc_` credential the
   * whole connection authenticates as. No network happens until start().
   */
  constructor(options: { url: string; token: string; roles?: Roles }) {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Open the connection: upgrade, `hub/register`, then MCP traffic (Transport
   * contract — the SDK calls this once). Resolves after the first successful
   * registration; rejects only on a terminal state reached before then. Later
   * disconnects are handled internally per the class policy.
   */
  async start(): Promise<void> {
    // deps: ws
    throw new Error("unimplemented");
  }

  /**
   * Send one MCP message to the hub (Transport contract). While the socket is
   * down the message is dropped, never queued — the hub re-lists after every
   * registration, so a dropped `notifications/tools/list_changed` heals itself,
   * and responses to requests from a dead socket have no reader anyway.
   */
  async send(message: JsonRpcMessage): Promise<void> {
    // deps: ws
    throw new Error("unimplemented");
  }

  /**
   * Local, graceful shutdown (Transport contract; SIGTERM path): closes the
   * socket, stops reconnecting, resolves `closed`. Idempotent.
   */
  async close(): Promise<void> {
    // deps: ws
    throw new Error("unimplemented");
  }
}

/**
 * The reconnect schedule as pure arithmetic — `attempt` (consecutive failures,
 * 0-based) → delay in milliseconds. Doubling from 1 s to the 60 s cap, jitter
 * drawn from `rng` (a [0,1) source; the loop passes Math.random, tests a seeded
 * stub). Attempt 0 is jittered from zero, so a hub deploy's reconnect storm
 * spreads out instead of every bot re-registering in the same second. Exported
 * so doubling, cap, and jitter bounds are a table test, not a property of a
 * live loop; HubTransport's reconnect loop is its only production caller.
 */
export function backoffDelay(attempt: number, rng: () => number): number {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The hub-asserted caller of the current tool call (§7, "Caller identity
 * forwarding"). `principal` is `"user:<name>"` or `"sa:<slug>"`. `roles` is the
 * caller's granted role names on this service exactly as granted — the built-in
 * wildcard arrives literally as `"all"` (owners get `["all"]`), never expanded
 * into declared names. Informational for the service's own branching: the hub's
 * grant check has already run, and these are not secrets.
 */
export type CallerIdentity = {
  principal: string;
  roles: readonly string[];
  /** True when `roles` contains `role` or `"all"` — so owner and all-granted callers behave identically, and `all` can never collide with a declared role name (the hub rejects declaring it). */
  hasRole(role: string): boolean;
};

/**
 * Read the caller identity off a forwarded request's `_meta` (`hub/principal`,
 * `hub/roles`). Trustworthy for fine-grained service-side checks: the hub strips
 * consumer-supplied `hub/*` keys before injecting its own, so a consumer cannot
 * forge these (§7). On a request that never passed through the hub (e.g. local
 * testing), the fields are simply absent: principal is `""`, roles is empty, and
 * hasRole() is uniformly false — no error to handle.
 */
export function caller(meta: Record<string, unknown> | undefined): CallerIdentity {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Mark input-schema properties sensitive so the hub redacts them (§7,
 * "Sensitive-field redaction"): returns a copy of `schema` — the original is not
 * mutated — with `writeOnly: true` (the standard JSON Schema keyword; no invented
 * syntax) set at each dot-path in `paths`, e.g. "password" or
 * "credentials.token". A path naming no property in the schema is a TypeError: a
 * silent typo here would quietly persist a secret. Marking is all this does —
 * redaction itself happens in the hub, before anything is stored or shown.
 */
export function sensitive<S extends Record<string, unknown>>(schema: S, paths: string[]): S {
  // deps: none
  throw new Error("unimplemented");
}
