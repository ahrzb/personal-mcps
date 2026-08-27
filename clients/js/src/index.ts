// @personal-mcps/client — the service-author library (spec §6, §11). A plain MCP
// server object goes in; this module keeps it reachable through the hub's reverse
// tunnel.
//
// OWNS the client side of the reverse-connection protocol: deriving
// wss://<host>/connect from the hub's https origin, the hub/register handshake
// (re-sent on every (re)connect), the split between hub/* control frames and MCP
// traffic, WebSocket protocol pings (~25 s, no application heartbeat), and the
// entire disconnect policy — the close-code vocabulary 4000–4004 and the upgrade
// statuses 401/403 map onto exactly three behaviors (`stop_fatal`, `stop_quiet`,
// `reconnect`), with a reconnecting case additionally carrying a schedule
// (`exponential` or `max_only`), decided in HubTransport and nowhere else.
//
// HIDES the wire completely: the author never sees a socket, a JSON-RPC frame, or
// a reconnect. One deliberate absence: the library never buffers traffic for an
// offline hub — while disconnected the hub is already failing consumer calls with
// -32000, and outbound notifications are dropped (the hub re-lists tools after
// every registration, so a dropped list_changed heals itself).
//
// ABSORBED from scripts/thin-serve.ts (D7's verified slice): the derived address, the
// register ceremony, the control/MCP frame split, and the close-code table proven against
// the live hub. What the slice could not do and this module must — the upgrade matrix's
// 401-vs-403 split — is why the socket here is `ws` (§4 names it) rather than the platform
// global: a refused handshake arrives with its HTTP STATUS on `unexpected-response`, and
// the global WebSocket reports the same refusal as a bare error event.

import { WebSocket } from "ws";

/**
 * The author's MCP server — `Server` (or `McpServer`) from `@modelcontextprotocol/server`
 * v2; external, never imported here, and therefore named by the one method serve() uses
 * rather than by a type this module cannot see. `connect` is the SDK session's own entry:
 * it owns the MCP handshake and calls the transport's start() itself.
 *
 * Stated structurally on purpose. A wider type (`unknown`, with a runtime probe for
 * `connect`) would let a wrong object through to a fallback that registers with the hub and
 * then never assigns `onmessage` — the hub believes the service is healthy while every
 * forwarded call times out. Failing at the call site instead is the whole difference
 * between a typo and an unknown-unknown. A hand-rolled session is served by constructing
 * {@link HubTransport} directly, which is what that class documents.
 */
export type McpServer = {
  connect(transport: HubTransport): Promise<void>;
  /**
   * Optional: the SDK's own `ServerCapabilities`-shaped answer, read at
   * registration time to answer the hub's `server/discover` (§11/§6, added
   * §20). Structural and optional on purpose — every service already in the
   * field is an object with no such method, and §11 pins that absence as the
   * hub's "capabilities unknown" fallback rather than a TypeError here.
   */
  getCapabilities?(): Record<string, unknown>;
};

/** One MCP wire message — `JSONRPCMessage` from `@modelcontextprotocol/server`; external, never imported here. */
export type JsonRpcMessage = unknown;

/**
 * The role declaration sent in `hub/register`: role name → either a bare pattern
 * list — tools, forever, so every service written before §20 keeps registering
 * unchanged — or a per-family object, each key optional (§20.3). Validation is
 * the hub's job, not this library's: names must match `[a-z0-9_-]{1,64}`, `all`
 * is reserved, an unknown family key is a violation, and pattern length (≤128)
 * and per-family pattern count (≤64) are capped — a violating declaration is
 * rejected at registration, which serve() surfaces as RegistrationError. The two
 * spellings may be mixed across roles in one declaration; this library sends
 * whichever an author wrote, unchanged — no normalization here (§20.6).
 */
export type Roles = Record<
  string,
  string[] | { tools?: string[]; prompts?: string[]; resources?: string[] }
>;

/**
 * The `hub/*` control-frame method names (contracts/tunnel-frames.json `methods`, the
 * hub's own `HUB_METHODS` export). Exported because it is exactly the set this transport
 * CONSUMES: a `hub/` method outside it is ordinary traffic and reaches the SDK session
 * untouched, so a new control frame cannot be swallowed silently.
 */
export const HUB_METHODS = { register: "hub/register", replaced: "hub/replaced" } as const;

/** The pinned MCP revision of the tunnel wire (contracts/tunnel-frames.json). */
export const PROTOCOL_VERSION = "2026-07-28";

/**
 * The registration-time capability question (§6/§11, added §20) — plain MCP
 * namespace, not `hub/`-prefixed, but answered by this library rather than
 * bridged to the SDK session: no MCP SDK implements it, and this library is
 * what knows which families the author actually registered.
 */
const DISCOVER_METHOD = "server/discover";

/** What `clientVersion` reports on the register frame — a free string in the fixture. */
const CLIENT_VERSION = "@personal-mcps/client/0";

/** The wire id of the one request this library ever originates. */
const REGISTER_ID = "hub-register-1";

/** §6's reconnect schedule: doubling from 1 s to a 60 s cap, jittered from zero. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/** The first attempt whose ceiling is clamped to the cap — the `max_only` schedule's whole
 *  content: the window stops doubling and stays at the cap (never a floor under the wait). */
const MAX_ONLY_ATTEMPT = 6;

/** §6 — liveness is WebSocket PROTOCOL pings at this cadence; there is no application heartbeat. */
const PING_INTERVAL_MS = 25_000;

/**
 * The two seams the reconnect policy is otherwise unobservable through — the jitter draw
 * and the wait itself — as MODULE state the loop calls by name, never as constructor
 * options. Both are production concerns rather than test workarounds: the schedule is full
 * jitter, so `max_only` and `exponential` overlap at every attempt and are told apart only
 * at a FIXED draw, and a suite that waited out a real 60 s window is a suite nobody runs.
 *
 * Here rather than on the constructor because §11 promises `{url, token, roles}` and
 * nothing else: an author reading `new HubTransport(…)` should not have to learn about
 * jitter injection to use the three options that matter. This is the same spelling the
 * Python twin uses (`pmcp_client._rng` / `._sleep`, replaced with monkeypatch), so the two
 * libraries state one contract in one shape; a suite replaces these members and restores
 * them afterwards.
 */
export const seams = {
  rng: (): number => Math.random(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
  // Options resolve BEFORE any I/O: an empty token dialed anyway comes back as upgrade
  // 401, turning a local config mistake into a revoked-token diagnosis (§10, §11).
  const url = options?.url ?? process.env.PMCP_URL;
  const token = options?.token ?? process.env.PMCP_SERVICE_TOKEN;
  if (url === undefined || url === "") throw new TypeError("no hub url: pass options.url or set PMCP_URL");
  if (token === undefined || token === "") {
    throw new TypeError("no service token: pass options.token or set PMCP_SERVICE_TOKEN");
  }
  const transport = new HubTransport({ url, token, roles: options?.roles, discover: () => probeCapabilities(server) });
  // The SDK session owns the handshake and calls start() itself.
  await server.connect(transport);
  await transport.closed;
}

/**
 * The author's declared capabilities, read the one way §11 sanctions: the SDK's
 * own optional `getCapabilities()`, never guessed from what this library can
 * carry. Absent — every service already in the field — is `undefined`, which
 * HubTransport answers `server/discover` with a `-32601` for: "capabilities
 * unknown", the hub's documented fallback (§6), not a fabricated empty set
 * (§20.5: an empty *answer* is an undeclare and clears a catalog; a missing
 * answer is not).
 */
function probeCapabilities(server: McpServer): Record<string, unknown> | undefined {
  return typeof server.getCapabilities === "function" ? server.getCapabilities() : undefined;
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
  readonly closed: Promise<void>;

  /** Assigned by the SDK session (Transport contract): called once per inbound MCP message; hub/* control frames are consumed internally and never appear here. */
  onmessage?: (message: JsonRpcMessage) => void;

  /** Assigned by the SDK session (Transport contract): fired once, at the terminal state only — reconnects are invisible. */
  onclose?: () => void;

  /** Assigned by the SDK session (Transport contract): transport-level errors worth logging; every fatal one also settles `closed`. */
  onerror?: (error: Error) => void;

  private readonly address: string;
  private readonly token: string;
  private readonly roles: Roles;
  /** Answers the hub's `server/discover` (§11/§6, §20). `undefined` when the
   *  caller gave none — every `server/discover` then gets `-32601`, the same
   *  "capabilities unknown" a library that predates this method sends. */
  private readonly discover: () => Record<string, unknown> | undefined;
  private readonly settleClosed: { resolve: () => void; reject: (error: Error) => void };
  private readonly started = deferred<void>();
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private running = false;
  private pinger: ReturnType<typeof setInterval> | null = null;

  /**
   * `url` is the hub's https origin — a bare origin, no path; anything else is a
   * TypeError here, before any I/O. `token` is the `pmcp_svc_` credential the
   * whole connection authenticates as. No network happens until start().
   *
   * These three and nothing else (§11). The reconnect policy's two observation
   * seams are the module-level {@link seams}, not options here.
   */
  constructor(options: {
    url: string;
    token: string;
    roles?: Roles;
    /** Internal: serve()'s wiring for `server/discover` (§20). Not part of §11's
     *  three public options — a hand-rolled session that wants to answer it
     *  passes this directly; one that does not gets the `-32601` fallback. */
    discover?: () => Record<string, unknown> | undefined;
  }) {
    // deps: none
    this.address = connectAddress(options.url);
    this.token = options.token;
    this.roles = options.roles ?? {};
    this.discover = options.discover ?? (() => undefined);
    const closed = deferred<void>();
    this.closed = closed.promise;
    this.settleClosed = { resolve: closed.resolve, reject: closed.reject };
    // The terminal state is settled by the loop, not necessarily awaited by the caller:
    // marking it handled keeps a fatal ending from becoming an unhandled rejection.
    void this.closed.catch(() => {});
  }

  /**
   * Open the connection: upgrade, `hub/register`, then MCP traffic (Transport
   * contract — the SDK calls this once). Resolves after the first successful
   * registration; rejects only on a terminal state reached before then. Later
   * disconnects are handled internally per the class policy.
   */
  async start(): Promise<void> {
    // deps: ws
    if (!this.running) {
      this.running = true;
      void this.loop();
    }
    return this.started.promise;
  }

  /**
   * Send one MCP message to the hub (Transport contract). While the socket is
   * down the message is dropped, never queued — the hub re-lists after every
   * registration, so a dropped `notifications/tools/list_changed` heals itself,
   * and responses to requests from a dead socket have no reader anyway.
   */
  async send(message: JsonRpcMessage): Promise<void> {
    // deps: ws
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send onto a dying socket is not a failure of whatever was being answered.
    }
  }

  /**
   * Local, graceful shutdown (Transport contract; SIGTERM path): closes the
   * socket, stops reconnecting, resolves `closed`. Idempotent.
   */
  async close(): Promise<void> {
    // deps: ws
    this.finish();
  }

  // ── the connection lifetime ───────────────────────────────────────────────────────────

  /** One transport is one service lifetime: this loop outlives every socket it opens. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      const ending = await this.connectOnce();
      if (this.stopped) return;
      if (ending.behavior === "stop_quiet") return this.finish();
      if (ending.behavior === "stop_fatal") return this.fail(ending.error);
      // A reconnecting ending never settles `closed` and never fires onclose — the SDK
      // session must not learn that the socket flapped.
      const attempt = ending.schedule === "max_only" ? MAX_ONLY_ATTEMPT : this.attempt++;
      // By NAME through `seams`, so the member a test replaced is the one this call reads.
      await seams.sleep(backoffDelay(attempt, seams.rng));
    }
  }

  /** One dial, from the upgrade to the ending — the only place the wire is touched. */
  private connectOnce(): Promise<Ending> {
    return new Promise<Ending>((resolve) => {
      // The credential rides `Authorization: Bearer` and nowhere else: no query string,
      // no subprotocol (§6, §18 d13).
      const socket = new WebSocket(this.address, { headers: { Authorization: `Bearer ${this.token}` } });
      this.socket = socket;
      let settled = false;
      const end = (ending: Ending): void => {
        if (settled) return;
        settled = true;
        this.stopPings();
        socket.removeAllListeners();
        // Tearing down a socket that never established makes `ws` emit one more error;
        // with no listener left, an EventEmitter turns that into an uncaught exception —
        // so the last listener standing swallows it.
        socket.on("error", () => {});
        try {
          socket.terminate();
        } catch {
          // already gone
        }
        if (this.socket === socket) this.socket = null;
        resolve(ending);
      };
      // A refused upgrade is an HTTP STATUS, and it is the whole 401-vs-403 split: this
      // event is the reason the library holds a `ws` socket instead of the global one.
      socket.on("unexpected-response", (_request: unknown, response: { statusCode?: number }) => {
        end(endingForUpgrade(response?.statusCode ?? 0));
      });
      socket.on("open", () => {
        this.attempt = 0;
        this.startPings(socket);
        // `hub/register` is re-sent on EVERY (re)connect, and carries no service or slug:
        // identity comes from the token alone.
        void this.send({
          jsonrpc: "2.0",
          id: REGISTER_ID,
          method: HUB_METHODS.register,
          params: { clientVersion: CLIENT_VERSION, protocolVersion: PROTOCOL_VERSION, roles: this.roles },
        });
      });
      socket.on("message", (data: unknown) => {
        const frame = parseFrame(data);
        if (frame === null) return;
        if (frame.id === REGISTER_ID && (frame.result !== undefined || frame.error !== undefined)) {
          if (frame.error !== undefined) {
            return end({
              behavior: "stop_fatal",
              error: new RegistrationError(`hub/register rejected: ${messageOf(frame.error)}`),
            });
          }
          this.started.resolve();
          return;
        }
        // The two control frames are consumed here; every other method — `hub/` prefixed
        // or not — is ordinary MCP traffic for the session.
        if (frame.method === HUB_METHODS.replaced) return;
        // §11/§6: the one MCP-namespace method this library answers itself. The author's
        // SDK never sees it — no SDK implements it, and this library is what knows which
        // families were actually registered.
        if (frame.method === DISCOVER_METHOD) return this.answerDiscover(frame);
        this.onmessage?.(frame as JsonRpcMessage);
      });
      socket.on("error", (error: Error) => {
        this.onerror?.(new Error(`hub connection failed: ${error?.message ?? "unknown"}`));
      });
      socket.on("close", (code: number) => end(endingForClose(code)));
    });
  }

  /**
   * Answer the hub's registration-time `server/discover` (§6/§11/§20) — never
   * forwarded to the SDK session. `undefined` capabilities means "unknown", the
   * fallback that keeps every service predating this method warming tools only
   * (§6); a real capability set is relayed exactly as the author's SDK reports
   * it, in the same DiscoverResult shape the reverse direction (hub→consumer)
   * uses, so both ends of the wire speak one envelope.
   */
  private answerDiscover(frame: Frame): void {
    const capabilities = this.discover();
    if (capabilities === undefined) {
      void this.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: "server/discover not implemented" },
      });
      return;
    }
    void this.send({
      jsonrpc: "2.0",
      id: frame.id,
      result: { supportedVersions: [PROTOCOL_VERSION], capabilities, resultType: "complete" },
    });
  }

  private startPings(socket: WebSocket): void {
    this.stopPings();
    this.pinger = setInterval(() => {
      try {
        socket.ping();
      } catch {
        // the close handler owns a dead socket
      }
    }, PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pinger !== null) clearInterval(this.pinger);
    this.pinger = null;
  }

  /** The quiet terminal state: replaced, or a local close(). Idempotent. */
  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPings();
    try {
      this.socket?.close(1000, "client shutdown");
    } catch {
      // already closed
    }
    this.socket = null;
    this.started.resolve();
    this.settleClosed.resolve();
    this.onclose?.();
  }

  /** The fatal terminal state: a dead credential or a refused declaration. */
  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPings();
    this.socket = null;
    this.onerror?.(error);
    this.started.reject(error);
    this.settleClosed.reject(error);
    this.onclose?.();
  }
}

/**
 * wss://<host>/connect, DERIVED from the hub's origin — never passed in (§6). The scheme
 * follows the origin's and is never downgraded: https → wss, and the http a local
 * `wrangler dev` serves → ws. Anything but a bare origin is a TypeError before any I/O.
 *
 * Exported because the derivation is the one part of the handshake a pure test can see:
 * a fixture hub speaks ws, so "https derives wss" is otherwise unobservable without TLS.
 */
export function connectAddress(url: string): string {
  const origin = new URL(url);
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new TypeError(`expected a bare hub origin, got ${url}`);
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new TypeError(`expected an http(s) hub origin, got ${url}`);
  }
  return `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/connect`;
}

/** How one connection ended, in the fixture's vocabulary (contracts/close-codes.json). */
type Ending =
  | { behavior: "stop_quiet" }
  | { behavior: "stop_fatal"; error: Error }
  | { behavior: "reconnect"; schedule: "exponential" | "max_only" };

/**
 * A refused upgrade → its behavior. Only 401 is fatal; 403 is archived and heals by
 * retrying; every other status (500 from an edge failure, and anything §6 never mentions)
 * reconnects, so a transient outage never strands a fleet of bots.
 */
function endingForUpgrade(status: number): Ending {
  if (status === 401) {
    // The message names the status, never the credential (§15).
    return { behavior: "stop_fatal", error: new CredentialsError("the hub refused the service credential (401)") };
  }
  if (status === 403) return { behavior: "reconnect", schedule: "max_only" };
  return { behavior: "reconnect", schedule: "exponential" };
}

/** A close code → its behavior. Unknown means reconnect — the safe default (§6). */
function endingForClose(code: number): Ending {
  if (code === 4000) return { behavior: "stop_quiet" };
  if (code === 4001) {
    return { behavior: "stop_fatal", error: new CredentialsError("the hub severed the connection (close 4001)") };
  }
  if (code === 4002) return { behavior: "reconnect", schedule: "max_only" };
  return { behavior: "reconnect", schedule: "exponential" };
}

/** One inbound frame, read as far as the transport needs. */
type Frame = { id?: unknown; method?: unknown; result?: unknown; error?: unknown };

/** One text frame as a JSON object, or null for anything else (binary included). */
function parseFrame(data: unknown): Frame | null {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Frame) : null;
  } catch {
    return null;
  }
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(value) ?? "unknown";
}

/** `Promise.withResolvers` in three lines — the ES2024 builtin is outside this repo's `lib`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  // The cap applies to the CEILING, before the draw — so no delay can exceed it, and the
  // window still starts at zero at every attempt.
  return rng() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
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
  const principal = meta?.["hub/principal"];
  const granted = meta?.["hub/roles"];
  const roles = Array.isArray(granted) ? granted.filter((role): role is string => typeof role === "string") : [];
  return {
    principal: typeof principal === "string" ? principal : "",
    roles,
    hasRole: (role: string) => roles.includes(role) || roles.includes("all"),
  };
}

/**
 * Mark one schema node secret — the zod-style spelling of §7's sensitive-field
 * declaration, usable wherever a field type goes: `secret(z.string())` inside a
 * tool's INPUT shape or its OUTPUT shape alike. Returns a derived schema (the
 * input is untouched) whose emitted JSON Schema carries `writeOnly: true` at
 * that node — the hub reads the marker in both directions and strips it from
 * outputSchemas served to consumers (§7). Schema-only: runtime values validate
 * and serialize exactly as the wrapped schema does — real values cross the wire,
 * and the HUB masks before anything is persisted or shown (§15). A value that is
 * neither is a TypeError, exactly as in {@link sensitive}: returning it unmarked
 * would ship the secret with nothing to see.
 */
export function secret<S>(schema: S): S {
  // deps: none
  // A zod schema carries `.describe()`/`.meta()`; a plain JSON Schema node is an object.
  // Both are marked the same way — a DERIVED value with writeOnly at this node — because
  // the hub reads the emitted JSON Schema either way.
  const node = schema as unknown;
  if (typeof node === "object" && node !== null) {
    const zod = node as { meta?: (data: Record<string, unknown>) => unknown };
    if (typeof zod.meta === "function") return zod.meta({ writeOnly: true }) as S;
    return { ...(node as Record<string, unknown>), writeOnly: true } as S;
  }
  // The same failure posture as sensitive(), for the same reason: a value that cannot be
  // marked, returned unchanged, ships the field unmarked and tells the author nothing.
  throw new TypeError("secret(): cannot mark this value — expected a zod schema or a JSON Schema object");
}

/**
 * Mark schema properties sensitive by path — the hand-written-schema spelling of
 * §7's sensitive-field declaration, for authors not using zod shapes. Works on an
 * input schema or an output schema alike: returns a copy of `schema` — the
 * original is not
 * mutated — with `writeOnly: true` (the standard JSON Schema keyword; no invented
 * syntax) set at each dot-path in `paths`, e.g. "password" or
 * "credentials.token". A path naming no property in the schema is a TypeError: a
 * silent typo here would quietly persist a secret. Marking is all this does —
 * redaction itself happens in the hub, before anything is stored or shown.
 */
export function sensitive<S extends Record<string, unknown>>(schema: S, paths: string[]): S {
  // deps: none
  const copy = structuredClone(schema) as Record<string, unknown>;
  for (const path of paths) mark(copy, path.split("."), path);
  return copy as S;
}

/** Sets `writeOnly` at one dot-path of a JSON Schema object, refusing an absent property. */
function mark(node: Record<string, unknown>, segments: string[], path: string): void {
  const properties = node.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new TypeError(`sensitive(): "${path}" names no property in this schema`);
  }
  const [head, ...rest] = segments;
  const child = (properties as Record<string, unknown>)[head];
  if (typeof child !== "object" || child === null) {
    throw new TypeError(`sensitive(): "${path}" names no property in this schema`);
  }
  if (rest.length === 0) (child as Record<string, unknown>).writeOnly = true;
  else mark(child as Record<string, unknown>, rest, path);
}
