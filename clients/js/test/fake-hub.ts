// fake-hub.ts — a real hub, in-test: a genuine `ws` server on an ephemeral port that
// HubTransport dials over a genuine WebSocket upgrade, answers `hub/register` with a
// genuine JSON-RPC reply, and closes with genuine close codes. It is the other end of §6's
// wire seen from the client side, not a stand-in for it.
//
// WHAT THIS PINS: the disconnect policy's inputs, as things that actually happened. §6
// gives the client four kinds of ending and the whole fatal-vs-retry decision turns on
// telling them apart — a refused upgrade (an HTTP status, before any frame exists), a
// close code (after establishment), a rejected registration (a JSON-RPC error reply), and
// an ordinary drop. A stub that hands the transport a synthesized "401" erases exactly the
// distinction under test: the transport must learn 401-vs-403 from a real handshake, the
// same way it will in production. `dials` and `frames` are the observation side — they
// record at ARRIVAL, before any scripted decision runs, so "it re-registered after
// reconnecting" and "it never redialed" are things this harness observed rather than
// things the transport reported about itself.
//
// WHAT IT MUST NOT FAKE (strategy §9): the WebSocket upgrade (401 and 403 are HTTP
// statuses on a real handshake), the JSON-RPC framing (one message per text frame, ids
// echoed as received), or the close-code vocabulary (a real `close(code)`, never a
// synthesized event). It fakes only the hub's DECISIONS: which status to answer, whether
// to accept a declaration, when to send `hub/replaced`, when to close and with what. It
// equally must not fake the MCP SDK — it speaks the wire directly and therefore proves
// nothing about SDK conformance, which is `scripts/e2e.ts`'s job (§10). Nor does it
// implement any hub BEHAVIOR: no catalog, no grants, no approval gate. A fake hub that
// started answering `tools/list` would be a second implementation of the server, and the
// server's own suites already own every one of those sentences.
//
// PROJECT: `scripts` + clients (plain Node, parallel), and that is load-bearing in two
// ways. Node means vitest fake timers actually work, so "retries at max backoff" is
// observed by advancing the clock rather than by waiting — but a hub bound to a real
// socket has real I/O the fake clock does not drive, so every wait a fixture performs is
// on an observation (`nextDial`, `nextFrame`), never on a timer. And parallel means every
// case owns its own hub on its own ephemeral port: `port` is assigned by the OS, never
// chosen, so two files never collide. Every hub is closed in a teardown — a leaked
// listener outlives the case that made it.
//
// (RESOLVED at implementation: the reconnect SCHEDULE is observed through the library's
// module-level `seams.sleep` recorder rather than through fake timers — the transport's waits are
// then values a fixture reads, and this harness's real socket I/O never races a frozen
// clock. Fake timers remain the right tool for the ~25 s ping cadence, which is a timer
// this harness watches on the wire.)
//
// deps: `ws` (real WebSocketServer, real upgrade handling) · node:http (the server the
//   upgrade rides on) · clients/js/src/index.ts Roles (declaration shape only) — no MCP
//   SDK, no server module, nothing from `contracts/` (the fixture is the TEST's oracle,
//   not this harness's input)

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Roles } from "../src/index";

/**
 * What the hub answers to the NEXT upgrade attempt. §6 pins three, and they are scripted
 * rather than derived because this harness holds no credentials to derive them from: the
 * production 401/403 decision is the server's, and re-deciding it here would make the
 * client's table answer to a second implementation of the server's rule instead of to the
 * contract fixture (§4).
 *
 * - `accept` — 101, the allow-twin of every refusal row.
 * - `reject` — an HTTP status refused at the handshake. 401 is fatal-credential and 403
 *   is archived-keep-retrying; any other status is expressible so a row can pin what the
 *   client does with a status §6 never mentions.
 */
export type UpgradeOutcome = { kind: "accept" } | { kind: "reject"; status: number };

/**
 * What the hub does with `hub/register`. `reject` is a JSON-RPC ERROR REPLY — the
 * rejected-declaration ending, which §6 makes terminal (RegistrationError) precisely
 * because identical input cannot start succeeding. It is deliberately a distinct shape
 * from a close code: a client that conflated the two would retry a declaration forever.
 */
export type RegisterOutcome =
  | { kind: "accept" }
  | { kind: "reject"; error: { code: number; message: string } }
  /**
   * Answer with this exact frame, with the OBSERVED request id filled in — the seam
   * contracts-consumer.test.ts needs to replay `contracts/tunnel-frames.json`'s own ack
   * and rejection rather than a paraphrase of them. The id is the one thing a fixture
   * cannot pin (contracts/README: "nothing that varies per run"), and a reply that
   * correlates to nothing would leave registration unanswered until the 10 s deadline.
   */
  | { kind: "replay"; frame: Record<string, unknown> };

/**
 * How the hub ends a live connection — the second half of §6's policy input. `replaced`
 * is the two-step the spec spells out (the `hub/replaced` notification, THEN close 4000),
 * and it is one option rather than two so a fixture cannot accidentally test the close
 * without the notification that gives it meaning. `close` covers the rest of the 4000–4004
 * vocabulary; `drop` severs the TCP connection with no close frame at all, which is what a
 * hub deploy and a network failure actually look like and is the ending most likely to be
 * mishandled.
 */
export type Ending =
  | { kind: "replaced" }
  | { kind: "close"; code: number; reason?: string }
  | { kind: "drop" };

/**
 * One observed dial, recorded when the upgrade REQUEST arrives — before the scripted
 * outcome is applied, so a refused dial counts exactly like an accepted one. That is the
 * whole point of the record: "the client kept retrying at max backoff" is a claim about
 * attempts, and a hub that only counted successes could never witness it.
 *
 * `path` and `authorization` are captured verbatim because §6 pins both on the client
 * side: the address is DERIVED (`wss://<host>/connect`) rather than passed in, and the
 * service token rides `Authorization: Bearer` and nowhere else. `at` is the arrival time
 * a fixture differences to observe a schedule; it is a real clock reading, so a table
 * asserts the ORDER and the shape of the gaps, never a millisecond literal (§7).
 */
export type Dial = {
  seq: number;
  path: string;
  authorization: string | undefined;
  at: number;
};

/**
 * One observed inbound frame, captured verbatim before interpretation. Registration
 * re-sends are the reason this exists as a list rather than a flag: §6 requires
 * `hub/register` on every (re)connect, so "it registered" is a count per connection, not a
 * boolean per transport.
 *
 * `connection` is the ordinal of the socket the frame arrived on, so a fixture can say
 * "the second connection re-registered" without inspecting the transport at all.
 */
export type ReceivedFrame = {
  seq: number;
  connection: number;
  /** The parsed JSON-RPC message exactly as it arrived — never normalized, never re-serialized. */
  message: Record<string, unknown>;
};

/**
 * How a fixture asks for a hub. Every field is a SCRIPT rather than a rule: the hub does
 * what the row said and records what happened, and the assertions live in the test.
 */
export type FakeHubOptions = {
  /**
   * The upgrade answer per attempt, consumed in order; the last entry repeats forever once
   * the list runs out. A list rather than a single value because the interesting rows are
   * TRANSITIONS — refused 403 while archived, then 101 once unarchived, which is §6's
   * "unarchiving heals without touching the bot" observed rather than assumed. Omitted
   * means accept every dial.
   */
  upgrades?: readonly UpgradeOutcome[];
  /** The register answer per connection, consumed and repeated the same way. Omitted means accept. */
  registrations?: readonly RegisterOutcome[];
};

/** How long an observation wait may go unanswered before the case fails instead of hanging. */
const OBSERVATION_DEADLINE_MS = 5_000;

/**
 * A live fake hub — one LISTENER, many connections. Unlike the fake service on the server
 * side, this one deliberately survives the sockets it accepts: the entire subject of
 * transport.test.ts is what the client does after a connection ends, so the hub must
 * outlive the ending to witness the redial (or its absence).
 */
export class FakeHub {
  /** The https origin a fixture hands the transport: `http://127.0.0.1:<port>`. The wss address is the client's to derive (§6), and asserting that derivation is what `Dial.path` is for. */
  readonly origin: string;

  /**
   * Every upgrade attempt this listener saw, in arrival order — the redial oracle. A
   * refusal row asserts this stops growing; a retry row asserts it keeps growing, and on
   * which schedule.
   */
  readonly dials: Dial[] = [];

  /**
   * Every frame received across every connection, in arrival order. `hub/register`
   * re-sends appear here once per connection, which is how §6's "re-sent on every
   * (re)connect" is observed from outside the transport.
   */
  readonly frames: ReceivedFrame[] = [];

  /** Every protocol PING this listener observed, by arrival time — §6's liveness sentence,
   *  witnessed on the wire rather than inferred from the client's own report. */
  readonly pings: number[] = [];

  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly open = new Set<WebSocket>();
  private upgrades: readonly UpgradeOutcome[];
  private readonly registrations: readonly RegisterOutcome[];
  private connections = 0;
  private watchers: (() => void)[] = [];

  constructor(server: Server, port: number, options: FakeHubOptions) {
    this.server = server;
    this.origin = `http://127.0.0.1:${port}`;
    this.upgrades = options.upgrades ?? [{ kind: "accept" }];
    this.registrations = options.registrations ?? [{ kind: "accept" }];
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      // Recorded at ARRIVAL: a refused dial counts exactly like an accepted one.
      this.dials.push({
        seq: this.dials.length + 1,
        path: request.url ?? "",
        authorization: request.headers.authorization,
        at: Date.now(),
      });
      this.notify();
      // A harness that answered a plain GET with 101 would let a transport that never
      // upgraded pass, so the well-formedness check has no off switch.
      if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket") return refuse(socket, 426);
      const outcome = next(this.upgrades, this.dials.length - 1);
      if (outcome.kind === "reject") return refuse(socket, outcome.status);
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
  }

  /** One accepted connection: record its frames, answer its registration, nothing else. */
  private accept(ws: WebSocket): void {
    const connection = ++this.connections;
    this.open.add(ws);
    ws.on("ping", () => {
      this.pings.push(Date.now());
      this.notify();
    });
    ws.on("close", () => this.open.delete(ws));
    ws.on("error", () => this.open.delete(ws));
    ws.on("message", (data: unknown) => {
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      this.frames.push({ seq: this.frames.length + 1, connection, message });
      this.notify();
      if (message.method !== "hub/register") return;
      const outcome = next(this.registrations, connection - 1);
      // The id is echoed AS RECEIVED: a reply that correlates to nothing would leave
      // registration unanswered until the deadline.
      const reply =
        outcome.kind === "accept"
          ? { jsonrpc: "2.0", id: message.id, result: { ok: true } }
          : outcome.kind === "reject"
            ? { jsonrpc: "2.0", id: message.id, error: outcome.error }
            : { ...outcome.frame, id: message.id };
      ws.send(JSON.stringify(reply));
    });
  }

  /** How many sockets are open right now — the invariant behind "a refused upgrade leaves nothing connected". */
  connectionCount(): number {
    // deps: none
    return this.open.size;
  }

  /**
   * Resolve once the number of recorded dials reaches `n`. The ONLY way a fixture waits
   * in this harness: waiting on an observation rather than on a duration is what keeps
   * "the client redialed" from decaying into "the client redialed within 50 ms", and what
   * lets vitest fake timers drive the schedule without racing real socket I/O. Rejects on
   * a bounded deadline so a transport that never redials fails the case instead of hanging
   * it.
   */
  async nextDial(n: number): Promise<Dial> {
    // deps: none
    await this.until(() => this.dials.length >= n, `dial ${n}`);
    return this.dials[n - 1];
  }

  /** The frame counterpart of nextDial, with the same rationale and the same bounded failure. */
  async nextFrame(n: number): Promise<ReceivedFrame> {
    // deps: none
    await this.until(() => this.frames.length >= n, `frame ${n}`);
    return this.frames[n - 1];
  }

  /** The ping counterpart — §6's liveness cadence, waited on as an observation like the rest. */
  async nextPing(n: number): Promise<number> {
    // deps: none
    await this.until(() => this.pings.length >= n, `ping ${n}`);
    return this.pings[n - 1];
  }

  /**
   * Rewrite the remaining upgrade script mid-test. The seam the healing row needs: it
   * refuses 403 until the client is provably retrying, then flips to accept and asserts the
   * very next dial connects — §6's unarchive path, expressed as a change in the world
   * rather than as a second hub.
   */
  setUpgrades(outcomes: readonly UpgradeOutcome[]): void {
    // deps: none
    // The script is consumed by dial ORDINAL, so a rewrite mid-flight has to start from
    // where the client is, not from the beginning of time.
    this.upgrades = [...Array.from({ length: this.dials.length }, () => outcomes[0]), ...outcomes];
  }

  /**
   * Send one raw frame on the current connection, bypassing every convenience above — the
   * escape hatch for frames that are ill-formed BY CONSTRUCTION: an unknown `hub/` method,
   * a reply to no request, two messages in one text frame. A harness that could only send
   * well-formed frames could not test that ordinary MCP traffic reaches the SDK session
   * while unknown control frames do not.
   */
  async send(frame: Record<string, unknown>): Promise<void> {
    // deps: ws (WebSocket.send)
    for (const ws of this.open) ws.send(JSON.stringify(frame));
  }

  /**
   * End the current connection the way `ending` describes, leaving the listener up. This
   * is the trigger every close-code row fires: the hub decides how the connection dies and
   * then watches whether the client comes back. `replaced` sends the notification and the
   * 4000 close in that order, because a client is entitled to act on the notification.
   * A no-op when nothing is connected.
   */
  async end(ending: Ending): Promise<void> {
    // deps: ws (WebSocket.close, socket destroy for `drop`)
    for (const ws of [...this.open]) {
      if (ending.kind === "replaced") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hub/replaced" }));
        ws.close(4000, "replaced");
      } else if (ending.kind === "close") {
        ws.close(ending.code, ending.reason);
      } else {
        // A bare TCP sever with no close frame at all — what a hub deploy looks like.
        ws.terminate();
      }
      this.open.delete(ws);
    }
  }

  /**
   * Stop the listener and every socket on it. Idempotent; fixtures call it in teardown
   * unconditionally, because a leaked listener holds a port and an open handle past the
   * end of the case that made it — and in a parallel project that is a failure in some
   * other file.
   */
  async close(): Promise<void> {
    // deps: ws · node:http (server.close)
    for (const ws of [...this.open]) ws.terminate();
    this.open.clear();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Every observation wait, with the bounded failure that keeps a hang from being a hang. */
  private until(done: () => boolean, what: string): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.watchers = this.watchers.filter((watcher) => watcher !== check);
        reject(new Error(`the fake hub never observed ${what} (within ${OBSERVATION_DEADLINE_MS} ms)`));
      }, OBSERVATION_DEADLINE_MS);
      const check = (): void => {
        if (!done()) return;
        clearTimeout(deadline);
        this.watchers = this.watchers.filter((watcher) => watcher !== check);
        resolve();
      };
      this.watchers.push(check);
    });
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher();
  }
}

/**
 * Start a hub on an OS-assigned port and resolve once it is accepting connections — so a
 * fixture's first line establishes "the hub is listening" as a fact rather than a hope,
 * and the transport's first dial cannot lose a race with the listener's own startup.
 */
export async function startFakeHub(options?: FakeHubOptions): Promise<FakeHub> {
  // deps: ws (WebSocketServer) · node:http (createServer, listen on port 0)
  const server = createServer((_request, response) => {
    response.statusCode = 426;
    response.end("Upgrade Required");
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return new FakeHub(server, port, options ?? {});
}

/**
 * The declaration a fixture expects to find in a recorded `hub/register` frame, spelled
 * against the library's own {@link Roles} so a rename in the client's declaration type
 * breaks compilation here rather than surfacing as a frame that silently stopped matching.
 * The harness never validates a declaration — validation is the hub's job (§6), pinned in
 * server/test/worker/registry.test.ts, and duplicating it here would give the client's
 * table a second oracle.
 */
export type RegisteredDeclaration = { roles: Roles; protocolVersion: string };

/** The scripted answer for the nth event; the last entry repeats forever. */
function next<T>(script: readonly T[], index: number): T {
  return script[Math.min(index, script.length - 1)];
}

/** A refused upgrade, answered as a REAL HTTP status on the raw socket. */
function refuse(socket: Socket, status: number): void {
  const phrase = { 401: "Unauthorized", 403: "Forbidden", 426: "Upgrade Required", 500: "Internal Server Error" }[
    status
  ] ?? "Refused";
  socket.write(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
