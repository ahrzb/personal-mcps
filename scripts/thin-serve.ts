// thin-serve.ts — the smallest thing that is a real tunneled service (§6): one socket,
// one declared role, one tool. It exists so the live end-to-end walk (scripts/smoke.ts)
// has a service to be at the far end of a `tools/call`, against the DEPLOYED hub, in the
// same process that drives the walk. It lives in `scripts/` beside its one importer and
// NOT in clients/js/src, so the library's src holds only the library and there is no second
// `serve` beside it for a service author to mistake for the product. D8 is the completing
// owner.
//
// OWNS, for this slice only: the wss://<host>/connect address derived from the hub's https
// origin, the `hub/register` ceremony re-sent on every (re)connect, the split between
// `hub/*` control frames and MCP traffic, and the close-code vocabulary reduced to what a
// smoke run actually needs — 4000/4001 stop, 4002/4003/4004 (and every unlabelled drop)
// reconnect with backoff, 4002 at the max_only schedule. Every wire string below is the
// contracts fixtures' vocabulary (contracts/tunnel-frames.json, contracts/close-codes.json),
// spelled the way clients/js/src/index.ts spells it: HUB_METHODS, the pinned
// protocolVersion, the three behavior words.
//
// KNOWN CEILING: contracts/close-codes.json is the oracle for the table below and NOTHING
// CHECKS THIS COPY AGAINST IT — the totality check runs against the client transport's
// reconnect rows, not against this file. Flip a code's behavior in the fixture and this
// script keeps the old one, so a live walk hangs to its deadline instead of failing with
// the reason. Re-read both when the fixture moves; the fork ends when this file is deleted.
//
// WHAT IT IS NOT: clients/js/src/index.ts. That module is the author-facing library —
// an MCP SDK session, a Transport, the pure `caller`/`secret`/`sensitive` halves, the
// exported `backoffDelay`, and the full upgrade matrix including the 401-vs-403 split.
// This file speaks the wire directly and holds no SDK. It deliberately imports NOTHING
// from index.ts either: a live smoke run must not break the day that skeleton grows a
// dependency, so the error class and the schedule are re-spelled here in a dozen lines
// rather than shared. When index.ts lands, delete this file and let smoke.ts serve
// through `serve()`.
//
// ponytail: the upgrade matrix is absent. Node's global WebSocket surfaces a refused
// handshake as an error event with no HTTP status, so 401-fatal-vs-403-archived is not
// decidable here — every pre-establishment failure reconnects. Distinguishing them needs
// a raw upgrade (that is index.ts's `ws` dependency); add it there, not here.
// ponytail: no application heartbeat and no protocol pings — undici exposes no ping API
// and the hub auto-pongs. A service that must survive an idle hour needs index.ts.

/** The pinned MCP revision of the tunnel wire (contracts/tunnel-frames.json). */
const PROTOCOL_VERSION = "2026-07-28";

/** The `hub/*` control-frame method names — the fixture's `methods`, same spelling as the
 *  hub's own export and index.ts's header. */
const HUB_METHODS = { register: "hub/register", replaced: "hub/replaced" } as const;

/**
 * §6's close codes → the three behavior words of contracts/close-codes.json. A code the
 * table does not name (1006 on a dropped TCP connection, 1001 on a hub deploy) reconnects:
 * "reconnect" is the safe default, and the two stopping codes are both explicit.
 */
const CLOSE_POLICY: Readonly<Record<number, "stop_quiet" | "stop_fatal" | "reconnect">> = {
  4000: "stop_quiet",
  4001: "stop_fatal",
  4002: "reconnect",
  4003: "reconnect",
  4004: "reconnect",
};

/** The one code whose reconnect runs on the fixture's `max_only` schedule: archived, so
 *  unarchiving heals within a minute without touching the bot (§6). */
const MAX_ONLY_CLOSE = 4002;

/** Full-jitter backoff bounds: doubling from 1 s to a 60 s cap, jittered from zero so a
 *  hub deploy's reconnect storm spreads out (§6; index.ts's `backoffDelay` is the pure,
 *  table-tested home for this arithmetic — this is the slice's private copy). */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/** The wire id of the one request this client ever originates. */
const REGISTER_ID = "register-1";

/** What `clientVersion` says on the register frame — a free string in the fixture. */
const CLIENT_VERSION = "thin-serve/0";

/** The hub-asserted caller of a forwarded call, read off `_meta` (§7). Absent fields read
 *  as `""` / `[]`, exactly as index.ts's `caller()` promises. */
export type ThinCaller = { principal: string; roles: readonly string[] };

/** The one tool this service serves. `run` returns the STRUCTURED value; both carriers of
 *  the 2026-07-28 result (text and structuredContent) are built from it. */
export type ThinTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, caller: ThinCaller): unknown;
};

export type ThinServeOptions = {
  /** The hub's https origin — a bare origin, no path. The wss://<host>/connect address is
   *  derived, never passed in (§6). `http://` is accepted for a local `wrangler dev`. */
  url: string;
  /** The `pmcp_svc_` credential. The service identity comes entirely from this token —
   *  there is deliberately no slug option (§6). */
  token: string;
  /** The single role declared for the single tool, e.g. `reader`. */
  role: string;
  tool: ThinTool;
  /** Progress out, for a caller that prints a walk. Never carries token material. */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
};

export type ThinService = {
  /** Resolves after the first accepted `hub/register`; rejects on a terminal failure. */
  registered: Promise<void>;
  /** Resolves at a quiet stop (`hub/replaced`, or a local close()); rejects with
   *  {@link ThinConnectionError} on a dead credential or a rejected declaration. Never
   *  settles on an ordinary disconnect — those reconnect. */
  closed: Promise<void>;
  /** Local shutdown: stops reconnecting and settles `closed`. Idempotent. */
  close(): Promise<void>;
};

/**
 * Terminal failure of the connection: close 4001 (dead credential) or a rejected
 * `hub/register` declaration. Both are terminal for the same reason — identical input
 * cannot start succeeding — so the slice does not split them into two classes the way
 * index.ts does (CredentialsError / RegistrationError).
 */
export class ThinConnectionError extends Error {}

/**
 * Run one tool as a tunneled hub service: dial, register `{ [role]: [tool.name] }`, and
 * answer `tools/list` and that tool's `tools/call` until the hub says otherwise.
 */
export function serveThin(options: ThinServeOptions): ThinService {
  const address = connectAddress(options.url);
  const registered = deferred<void>();
  const closed = deferred<void>();
  const say = (event: string, detail?: Record<string, unknown>): void => options.onEvent?.(event, detail);

  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  /** The terminal state, reached once: no more dials, both promises settled. */
  const stop = (error?: Error): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (error === undefined) {
      registered.resolve();
      closed.resolve();
      return;
    }
    registered.reject(error);
    closed.reject(error);
  };

  const reconnect = (code: number): void => {
    const delay = code === MAX_ONLY_CLOSE ? BACKOFF_CAP_MS : backoff(attempt++);
    say("reconnect", { code, delayMs: Math.round(delay) });
    timer = setTimeout(dial, delay);
  };

  const onFrame = (ws: WebSocket, raw: unknown): void => {
    const frame = parseFrame(raw);
    if (frame === null) return;
    // The one request this client originated: its answer is the registration verdict.
    if (frame.id === REGISTER_ID) {
      if (frame.error !== undefined) {
        return stop(new ThinConnectionError(`hub/register rejected: ${messageOf(frame.error)}`));
      }
      attempt = 0;
      say("registered", { role: options.role, tool: options.tool.name });
      return registered.resolve();
    }
    // A `hub/*` control frame is consumed here and never treated as MCP traffic; close
    // 4000 follows this one and carries the stop-quietly decision.
    if (frame.method === HUB_METHODS.replaced) return say("replaced");
    if (typeof frame.method !== "string" || frame.id === undefined) return; // a notification: nothing to answer
    send(ws, answer(frame, options.tool));
  };

  const dial = (): void => {
    if (stopped) return;
    say("dial", { address });
    // The credential rides `Authorization: Bearer` and nowhere else (§6). Node's global
    // WebSocket takes non-standard options in the protocols position; the DOM lib types
    // only the standard overload, hence the cast — the runtime contract is undici's.
    const ws = new WebSocket(address, {
      headers: { Authorization: `Bearer ${options.token}` },
    } as unknown as string[]);
    socket = ws;
    let ended = false;
    // `error` and `close` both fire for a refused or dropped connection; whichever lands
    // first owns the decision.
    const end = (code: number): void => {
      if (ended || stopped || ws !== socket) return;
      ended = true;
      const behavior = CLOSE_POLICY[code] ?? "reconnect";
      if (behavior === "stop_quiet") return stop();
      if (behavior === "stop_fatal") {
        return stop(new ThinConnectionError(`hub refused the service credential (close ${code})`));
      }
      reconnect(code);
    };
    ws.addEventListener("open", () => {
      say("connected");
      send(ws, {
        jsonrpc: "2.0",
        id: REGISTER_ID,
        method: HUB_METHODS.register,
        params: {
          clientVersion: CLIENT_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          // No service or slug field, ever: identity comes from the token alone (§6).
          roles: { [options.role]: [options.tool.name] },
        },
      });
    });
    ws.addEventListener("message", (event) => onFrame(ws, (event as MessageEvent).data));
    ws.addEventListener("error", () => end(1006));
    ws.addEventListener("close", (event) => end((event as CloseEvent).code));
  };

  dial();
  // The promises are settled by the loop, not necessarily awaited by the caller: marking
  // them handled here keeps a terminal failure from becoming an unhandled rejection.
  void registered.promise.catch(() => {});
  void closed.promise.catch(() => {});

  return {
    registered: registered.promise,
    closed: closed.promise,
    async close() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      try {
        socket?.close(1000, "client shutdown");
      } catch {
        // already closed
      }
      registered.resolve();
      closed.resolve();
    },
  };
}

/** wss://<host>/connect, DERIVED from the hub's origin (§6). Anything but a bare origin is
 *  a TypeError before any I/O. */
export function connectAddress(url: string): string {
  const origin = new URL(url);
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new TypeError(`expected a bare hub origin, got ${url}`);
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new TypeError(`expected an http(s) hub origin, got ${url}`);
  }
  // http is the local `wrangler dev` case; production is https → wss.
  return `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/connect`;
}

/** One hub-originated request answered — the whole MCP surface of this slice. */
function answer(frame: Frame, tool: ThinTool): Record<string, unknown> {
  const id = frame.id;
  if (frame.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: tool.name,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema,
          },
        ],
      },
    };
  }
  if (frame.method !== "tools/call") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  const params = asObject(frame.params);
  if (params.name !== tool.name) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown tool" } };
  }
  try {
    const value = tool.run(asObject(params.arguments), callerOf(params._meta));
    // Both carriers of the 2026-07-28 result: the text half for a client with no schema,
    // the structured half for one that has it.
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    };
  } catch (err) {
    // A tool that threw is a TOOL error, not a protocol one: isError on the result, so the
    // hub relays it to the consumer instead of reading it as a transport failure.
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: messageOf(err) }], isError: true },
    };
  }
}

/** The hub's identity assertion off a forwarded request's `_meta` (§7). The hub strips
 *  consumer-supplied `hub/*` keys before writing its own, so this needs no validation. */
function callerOf(meta: unknown): ThinCaller {
  const fields = asObject(meta);
  const roles = fields["hub/roles"];
  return {
    principal: typeof fields["hub/principal"] === "string" ? fields["hub/principal"] : "",
    roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
  };
}

/** One inbound frame, read as far as this slice needs. */
type Frame = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

/** One text frame as a JSON object, or null for anything else — binary frames included,
 *  which this protocol never uses. */
function parseFrame(raw: unknown): Frame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Frame) : null;
  } catch {
    return null;
  }
}

/** One frame out, best-effort: a send onto a dying socket is not a failure of whatever was
 *  being answered. */
function send(ws: WebSocket, frame: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // already closed — the hub fails the correlation and the consumer retries (§6)
  }
}

/** Full jitter over a doubling schedule: `attempt` (0-based) → milliseconds. */
function backoff(attempt: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  const message = asObject(value).message;
  return typeof message === "string" ? message : JSON.stringify(value);
}

/** `Promise.withResolvers` in three lines — the ES2024 builtin is outside this repo's
 *  `lib` setting. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
