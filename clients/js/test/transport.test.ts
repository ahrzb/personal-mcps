/**
 * clients/js/test/transport.test.ts — HubTransport against an in-process fake
 * hub: the client half of §6's reverse-connection protocol. What it pins is the
 * DISCONNECT POLICY — the upgrade statuses (401 fatal vs 403 archived: the split
 * the whole fatal-vs-retry decision turns on) and the close-code vocabulary
 * 4000–4004, each mapping onto exactly one of three behaviors — `stop_fatal`,
 * `stop_quiet`, `reconnect` — plus, on the ones that reconnect, a `schedule`
 * attribute of `exponential` or `max_only`. Behavior and schedule are separate
 * axes (contracts/README.md, pinned 2026-08-25): "retry at max backoff" is a
 * SCHEDULE of reconnect, never a fourth behavior, which is why ReconnectPolicyRow
 * carries the two in separate columns. Plus the handshake around it: the derived
 * <host>/connect address (wss from an https origin, ws from the http one a local
 * `wrangler dev` and every fixture here use), hub/register re-sent on every (re)connect,
 * and the hub/* control frames never reaching the SDK session.
 *
 * The rows themselves live in ./policy-rows.ts, not here: contracts-consumer.test.ts
 * needs them as values, and this file is collected as a test file in its own right, so
 * importing them from it would register every case below a second time (that module's
 * header states the finding).
 *
 * Project: `scripts` + clients (plain Node, parallel). Two things follow from
 * being in Node rather than workerd: vitest fake timers actually work here, so
 * "keeps retrying at max backoff" is observed by advancing the clock and never by
 * sleeping; and the fake hub is a real `ws` server, so the upgrade statuses are
 * real HTTP responses to a real upgrade, not a stubbed branch. Each case owns its
 * own hub instance on its own ephemeral port — no shared listener, no ordering
 * between cases.
 *
 * What the fake hub must NOT fake (strategy §9): the WebSocket upgrade itself
 * (401/403 are HTTP statuses on a real upgrade — stubbing that erases the exact
 * distinction under test), JSON-RPC framing (one message per text frame, real
 * ids), and close codes (real `close(code)`, not a synthesized event). It fakes
 * only the hub's decisions: which status to answer, whether to accept the
 * registration, when to send hub/replaced.
 *
 * Design check, RESOLVED 2026-08-26: fake timers cannot drive the reconnect loop —
 * `ws`'s own timers fight them — so the wait is a seam, and so is the jitter draw
 * (the schedule is full jitter, so `max_only` and `exponential` overlap at every
 * attempt and are only told apart at a FIXED draw). Both are production concerns,
 * not test workarounds (strategy §6). They are the MODULE-level `seams` object, not
 * constructor options: HubTransport takes `{url, token, roles}` and nothing else, as
 * §11 promises, which is also the spelling clients/py uses (`pmcp_client._rng` /
 * `._sleep`, replaced with monkeypatch) — one contract, one shape, two languages.
 *
 * Durable vs incidental (§7): durable are the code→behavior mapping, its
 * totality, and the fact that reconnects are invisible to the SDK session.
 * Incidental — never asserted as a literal — the delay values themselves (rows
 * name the schedule, and backoffDelay's own numbers are pinned once in
 * api.test.ts) and every message string.
 */

// deps: ./fake-hub (in-process `ws` hub: chooses upgrade status, accepts/rejects hub/register, closes with a code) · ./policy-rows (reconnectPolicyRows, unlistedEndingRows, ReconnectPolicyRow) · clients/js/src/index.ts (HubTransport, serve, CredentialsError, RegistrationError, seams — the module-level rng/sleep this file replaces and restores) · contracts/close-codes.json (read-only — see contracts-consumer.test.ts) · vitest fake timers

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  connectAddress,
  CredentialsError,
  HubTransport,
  RegistrationError,
  seams,
  serve,
} from "../src/index";
import { startFakeHub } from "./fake-hub";
import type { FakeHub } from "./fake-hub";
import { reconnectPolicyRows, unlistedEndingRows, type ReconnectPolicyRow } from "./policy-rows";

/** An obviously fake service credential — the value every dial is checked to carry. */
const TOKEN = "pmcp_svc_FAKE0000000000000000000000000000";

/** The declaration handed to the constructor, echoed verbatim in `hub/register`. */
const ROLES = { reader: ["get_news", "search_.*"] };

/**
 * The fixed jitter draw the schedule column is only observable at (policy-rows.ts states
 * why): `max_only` and `exponential` overlap under a live Math.random.
 */
const DRAW = 0.999;

/** An attempt whose ceiling is past the cap — how `max_only`'s window is named without a literal. */
const PAST_THE_CAP = 40;

/** Every hub and transport a case opened, torn down whatever the case did. */
const opened: { hub?: FakeHub; transport?: HubTransport }[] = [];

/** The real seams, restored after every case — they are MODULE state, not per-transport options. */
const REAL_SEAMS = { ...seams };

afterEach(async () => {
  vi.useRealTimers();
  Object.assign(seams, REAL_SEAMS);
  for (const entry of opened.splice(0)) {
    await entry.transport?.close().catch(() => {});
    await entry.hub?.close().catch(() => {});
  }
});

/** What a case reads back from the seam it installed: every delay the reconnect loop asked for. */
type Sleeps = { delays: number[] };

/**
 * Install the two module seams for this case: the FIXED jitter draw the schedule column is
 * only observable at, and a sleep that RECORDS the delay and resolves at once for the first
 * `limit` waits, then never resolves — so a `reconnect` row observes its redial immediately
 * and a retrying client cannot spin the case into a busy loop. The Python twin is
 * conftest's `recorded_sleep` fixture plus its `_rng` monkeypatch.
 */
function useSeams(limit = 3): Sleeps {
  const delays: number[] = [];
  seams.rng = () => DRAW;
  seams.sleep = (ms: number) => {
    delays.push(ms);
    return delays.length <= limit ? Promise.resolve() : new Promise<void>(() => {});
  };
  return { delays };
}

/**
 * The session serve() takes: the SDK's own entry, spelled here as the one method the
 * library's type requires. A real `Server` does exactly this — owns the MCP handshake and
 * starts the transport — and every serve() case below is about the transport's terminal
 * state, not about the SDK.
 */
const SESSION = { connect: (transport: HubTransport): Promise<void> => transport.start() };

/** What `closed` has done so far — the settlement column, observed without awaiting forever. */
function watch(promise: Promise<void>): { status: "pending" | "resolved" | "rejected"; error?: unknown } {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = { status: "pending" };
  promise.then(
    () => (state.status = "resolved"),
    (error: unknown) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}

/** A few turns of the event loop — enough for a client that MEANT to redial to have done so. */
async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** One started transport against one fresh hub, torn down by the shared teardown. */
async function connected(
  options: {
    upgrades?: Parameters<typeof startFakeHub>[0] extends undefined ? never : NonNullable<Parameters<typeof startFakeHub>[0]>["upgrades"];
    registrations?: NonNullable<Parameters<typeof startFakeHub>[0]>["registrations"];
    roles?: Record<string, string[]>;
    sleeps?: Sleeps;
  } = {},
): Promise<{ hub: FakeHub; transport: HubTransport; state: ReturnType<typeof watch> }> {
  // A case that wants to READ the delays installs the seams itself and passes the handle;
  // everyone else just needs a loop that cannot busy-spin.
  if (options.sleeps === undefined) useSeams();
  const hub = await startFakeHub({ upgrades: options.upgrades, registrations: options.registrations });
  const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: options.roles ?? ROLES });
  opened.push({ hub, transport });
  const state = watch(transport.closed);
  void transport.start().catch(() => {});
  return { hub, transport, state };
}

describe("handshake · §6 \"Transport\", \"Framing\", \"Handshake\"", () => {
  it("§6 · the constructor rejects anything but a bare origin — a path, a query string, a wss:// URL — with a TypeError before any I/O; twin: a bare origin constructs and dials <host>/connect, derived — never passed in", async () => {
    for (const url of ["https://hub.example.com/mcp", "https://hub.example.com/?token=x", "wss://hub.example.com"]) {
      expect(() => new HubTransport({ url, token: TOKEN }), url).toThrow(TypeError);
    }
    const { hub } = await connected();
    const dial = await hub.nextDial(1);
    expect(dial.path).toBe("/connect");
  });

  it("§6/§10 · the derived scheme follows the origin's and is never downgraded: https:// derives wss://, http:// (the local `wrangler dev` case, and what the fake hub hands every case in this file) derives ws:// — a pmcp_svc_ credential rides this dial, so the https half is a rule and not a convenience", () => {
    expect(connectAddress("https://mcp.example.com")).toBe("wss://mcp.example.com/connect");
    expect(connectAddress("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/connect");
  });

  it("§6 · the dial carries the service token as `Authorization: Bearer`, and carries no service or slug anywhere: identity rides the token alone", async () => {
    const { hub } = await connected();
    const dial = await hub.nextDial(1);
    expect(dial.authorization).toBe(`Bearer ${TOKEN}`);
    const register = await hub.nextFrame(1);
    const params = register.message.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["clientVersion", "protocolVersion", "roles"]);
  });

  it("§6/§18 d13 · the derived address carries the token NOWHERE: no `?token=` query string and no Sec-WebSocket-Protocol fallback — the hub never accepts a query-string token, and Dial.path is recorded verbatim precisely to witness that the client never sends one", async () => {
    const { hub } = await connected();
    const dial = await hub.nextDial(1);
    expect(dial.path).toBe("/connect");
    expect(dial.path).not.toContain(TOKEN);
    expect(connectAddress("https://mcp.example.com")).not.toContain("token");
  });

  it("§15 · nothing the library surfaces echoes the credential: neither CredentialsError's message nor the error handed to onerror contains the pmcp_svc_ value, so a crashed bot's log cannot leak the service's sole secret", async () => {
    useSeams();
    const hub = await startFakeHub({ upgrades: [{ kind: "reject", status: 401 }] });
    const transport = new HubTransport({ url: hub.origin, token: TOKEN });
    opened.push({ hub, transport });
    const seen: Error[] = [];
    transport.onerror = (error) => seen.push(error);
    const failure = await transport.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(CredentialsError);
    for (const error of [failure as Error, ...seen]) {
      expect(error.message, error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain("pmcp_svc_");
    }
  });

  it("§6 · start() resolves only after hub/register is accepted, and the frame sent is the declaration handed to the constructor (roles verbatim, `{}` when omitted)", async () => {
    useSeams();
    const hub = await startFakeHub();
    const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: ROLES });
    opened.push({ hub, transport });
    const started = watch(transport.start());
    await hub.nextFrame(1);
    const register = hub.frames[0].message;
    expect(register.method).toBe("hub/register");
    expect((register.params as Record<string, unknown>).roles).toEqual(ROLES);
    await settle();
    expect(started.status).toBe("resolved");

    const bare = await connected({ roles: {} });
    const declaration = await bare.hub.nextFrame(1);
    expect((declaration.message.params as Record<string, unknown>).roles).toEqual({});
  });

  it("§6 · hub/* control frames are consumed internally and never surface on onmessage; ordinary MCP traffic does, one JSON-RPC message per text frame", async () => {
    const { hub, transport } = await connected();
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);
    await hub.nextFrame(1);
    await settle();
    await hub.send({ jsonrpc: "2.0", method: "hub/replaced" });
    await hub.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    await settle();
    expect(received).toEqual([{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
  });

  it("§7 · an MRTR exchange rides the transport unmodified: a result carrying `resultType: \"input_required\"` reaches the hub verbatim and a retry carrying `inputResponses` + `requestState` reaches the session verbatim — the transport relays, it never normalizes or strips a field it does not understand, which is the whole of §7's relay-verbatim path", async () => {
    const { hub, transport } = await connected();
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);
    await hub.nextFrame(1);
    await settle();
    const inputRequired = {
      jsonrpc: "2.0",
      id: 11,
      result: { resultType: "input_required", requestState: "opaque-state", inputRequests: [{ name: "otp" }] },
    };
    await transport.send(inputRequired);
    const relayed = await hub.nextFrame(2);
    expect(relayed.message).toEqual(inputRequired);
    const retry = {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "pay", arguments: {}, inputResponses: [{ name: "otp", value: "123456" }], requestState: "opaque-state" },
    };
    await hub.send(retry);
    await settle();
    expect(received).toEqual([retry]);
  });

  it("§6 · liveness is WebSocket PROTOCOL ping frames and nothing else: an idle connection produces pings (~25 s) that the fake hub's listener observes, and no application-level heartbeat frame ever appears — a bot behind NAT going dark after an idle hour is the failure, and this is the one §6 sentence the fake hub can witness directly", async () => {
    // Fake timers are installed BEFORE the transport exists, so the ping interval it
    // schedules is the one the clock advances; the socket I/O beneath it is real either way.
    vi.useFakeTimers();
    useSeams();
    const hub = await startFakeHub();
    const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: ROLES });
    opened.push({ hub, transport });
    void transport.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await hub.nextFrame(1);
    await vi.advanceTimersByTimeAsync(26_000);
    vi.useRealTimers();
    await hub.nextPing(1);
    expect(hub.pings.length).toBeGreaterThan(0);
    // The only frame on the wire is still the registration: no application heartbeat.
    expect(hub.frames.map((frame) => frame.message.method)).toEqual(["hub/register"]);
  });

  it("§6 · send() while the socket is down drops the message and does not throw or queue it — the hub re-lists after every registration, so a dropped notifications/tools/list_changed heals itself", async () => {
    useSeams();
    const hub = await startFakeHub();
    const transport = new HubTransport({ url: hub.origin, token: TOKEN });
    opened.push({ hub, transport });
    // Never started: there is no socket at all.
    await expect(transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).resolves.toBeUndefined();
    // …and after a local close, the same.
    await transport.start().catch(() => {});
    await hub.nextFrame(1);
    await transport.close();
    await transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await settle();
    expect(hub.frames.map((frame) => frame.message.method)).toEqual(["hub/register"]);
  });

  it("§6 · close() is idempotent: it stops reconnecting and resolves `closed`, and a second call changes nothing", async () => {
    const { hub, transport, state } = await connected();
    await hub.nextFrame(1);
    await transport.close();
    await transport.close();
    await settle();
    expect(state.status).toBe("resolved");
    expect(hub.dials.length).toBe(1);
  });
});

describe("reconnection is invisible to the SDK session · §6, §11", () => {
  it("§6 · a mid-life network drop reconnects and re-sends hub/register, while onclose never fires and `closed` never settles — one transport is one service lifetime, not one socket", async () => {
    const { hub, transport, state } = await connected();
    let closes = 0;
    transport.onclose = () => (closes += 1);
    await hub.nextFrame(1);
    await hub.end({ kind: "drop" });
    const redial = await hub.nextDial(2);
    const reregistration = await hub.nextFrame(2);
    expect(redial.seq).toBe(2);
    expect(reregistration.message.method).toBe("hub/register");
    // The observation that makes it a RE-registration rather than a repeat: a second socket.
    expect(reregistration.connection).toBe(2);
    expect(state.status).toBe("pending");
    expect(closes).toBe(0);
  });

  it("§6 · onclose fires exactly once, and only at a terminal state", async () => {
    const { hub, transport } = await connected();
    let closes = 0;
    transport.onclose = () => (closes += 1);
    await hub.nextFrame(1);
    await hub.end({ kind: "drop" });
    await hub.nextFrame(2);
    expect(closes).toBe(0);
    await hub.end({ kind: "replaced" });
    await settle();
    expect(closes).toBe(1);
    await transport.close();
    await settle();
    expect(closes).toBe(1);
  });

  it("§6 · the delays the reconnect loop asks for are exactly backoffDelay's answers for the attempts it is on — the loop owns no schedule of its own, so a hard-coded sleep beside the exported schedule fails here rather than passing every row in the policy table (the twin of clients/py's test_reconnect_delays_follow_the_shared_schedule)", async () => {
    const sleeps = useSeams(3);
    // 500 at upgrade: an ending that reconnects on the ordinary exponential schedule, so
    // the attempts run 0, 1, 2 with nothing resetting them.
    const { hub } = await connected({ upgrades: [{ kind: "reject", status: 500 }], sleeps });
    await hub.nextDial(4);
    expect(sleeps.delays.slice(0, 3)).toEqual([0, 1, 2].map((attempt) => backoffDelay(attempt, () => DRAW)));
  });

  it("§11 · serve()'s resolution mirrors the transport's terminal state — resolves after a replacement, rejects with the same error class otherwise — so the policy is decided in HubTransport and nowhere else", async () => {
    useSeams();
    const quiet = await startFakeHub();
    opened.push({ hub: quiet });
    const served = watch(serve(SESSION, { url: quiet.origin, token: TOKEN, roles: ROLES }));
    await quiet.nextFrame(1);
    await quiet.end({ kind: "replaced" });
    await settle();
    expect(served.status).toBe("resolved");

    const dead = await startFakeHub({ upgrades: [{ kind: "reject", status: 401 }] });
    opened.push({ hub: dead });
    await expect(serve(SESSION, { url: dead.origin, token: TOKEN })).rejects.toBeInstanceOf(CredentialsError);

    const refused = await startFakeHub({
      registrations: [{ kind: "reject", error: { code: -32602, message: "bad role name" } }],
    });
    opened.push({ hub: refused });
    await expect(serve(SESSION, { url: refused.origin, token: TOKEN, roles: { All: [] } })).rejects.toBeInstanceOf(
      RegistrationError,
    );
  });

  it("§10/§11 · serve() resolves its options before any I/O: url and token default to PMCP_URL and PMCP_SERVICE_TOKEN, an explicit argument wins over the env var, and neither being set is a TypeError before a socket exists — an empty token dialed anyway would come back as upgrade 401 and be classified as a dead credential, turning a local config mistake into a revoked-token diagnosis", async () => {
    useSeams();
    const fromEnv = await startFakeHub();
    const explicit = await startFakeHub();
    opened.push({ hub: fromEnv }, { hub: explicit });
    const before = { url: process.env.PMCP_URL, token: process.env.PMCP_SERVICE_TOKEN };
    try {
      delete process.env.PMCP_URL;
      delete process.env.PMCP_SERVICE_TOKEN;
      await expect(serve(SESSION, {})).rejects.toBeInstanceOf(TypeError);
      await expect(serve(SESSION, { url: fromEnv.origin })).rejects.toBeInstanceOf(TypeError);
      expect(fromEnv.dials.length, "a socket was opened before the options resolved").toBe(0);

      process.env.PMCP_URL = fromEnv.origin;
      process.env.PMCP_SERVICE_TOKEN = TOKEN;
      const defaulted = watch(serve(SESSION, {}));
      await fromEnv.nextFrame(1);
      await fromEnv.end({ kind: "replaced" });
      await settle();
      expect(defaulted.status).toBe("resolved");

      const overridden = watch(serve(SESSION, { url: explicit.origin }));
      await explicit.nextDial(1);
      expect(fromEnv.dials.length).toBe(1);
      await explicit.end({ kind: "replaced" });
      await settle();
      expect(overridden.status).toBe("resolved");
    } finally {
      if (before.url === undefined) delete process.env.PMCP_URL;
      else process.env.PMCP_URL = before.url;
      if (before.token === undefined) delete process.env.PMCP_SERVICE_TOKEN;
      else process.env.PMCP_SERVICE_TOKEN = before.token;
    }
  });
});

describe("the policy itself · §6 upgrade matrix + close codes", () => {
  describe("the table below — one case per row, plus its allow-twin row: every refusal ending (401, 4001, a rejected registration) is authored beside the ending that keeps the connection alive, so a transport that gives up on everything cannot pass (strategy §9 rule 2)", () => {
    runReconnectPolicy(reconnectPolicyRows);
  });

  describe("policy-rows.ts's unlistedEndingRows, run by the same runner: the endings contracts/close-codes.json deliberately does not key — a rejected registration, a bare TCP drop, and a close code or upgrade status outside the vocabulary — so \"unknown means reconnect\" is asserted rather than inherited from an implementation, and the refusal again sits beside the ending that keeps going", () => {
    runReconnectPolicy(unlistedEndingRows);
  });

  it("§6 · unarchiving heals without touching the bot: the hub refuses 403 until the client is provably retrying, then accepts — and the very next dial connects and re-registers. The 403 row above pins that the client keeps dialing; this pins what the dialing is FOR, and it is the one §6 sentence about an archived service that a retry count alone cannot witness", async () => {
    useSeams(10);
    const hub = await startFakeHub({ upgrades: [{ kind: "reject", status: 403 }] });
    const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: ROLES });
    opened.push({ hub, transport });
    const started = watch(transport.start());
    // Provably retrying: two refused dials, and nothing connected.
    await hub.nextDial(2);
    expect(hub.connectionCount()).toBe(0);
    // The world changes — the service is unarchived — and nothing about the bot does.
    hub.setUpgrades([{ kind: "accept" }]);
    const registration = await hub.nextFrame(1);
    expect(registration.message.method).toBe("hub/register");
    await settle();
    expect(started.status, "start() never resolved after the hub healed").toBe("resolved");
  });
});

/**
 * The table runner: one case per row, titled with the row's `spec`. It stands up
 * a fake hub configured to produce the row's `trigger`, then observes the three
 * consequences — further dials, the ceiling the loop's delay is drawn from at a FIXED
 * jitter draw (ReconnectPolicyRow.schedule states why a live draw cannot tell the two
 * schedules apart), and the settlement of `closed`. All the assertion logic in this
 * suite lives here, so adding a close code to the protocol is one fixture entry plus one
 * row, and an ending the fixture does not key is one row in `unlistedEndingRows`.
 *
 * Called twice: once over `reconnectPolicyRows` (the fixture's vocabulary) and once over
 * `unlistedEndingRows` (the endings the fixture deliberately does not key).
 */
export function runReconnectPolicy(rows: readonly ReconnectPolicyRow[]): void {
  // deps: ./fake-hub · ./policy-rows · clients/js/src/index.ts (HubTransport) · an injected sleep recorder · a seeded rng stub
  for (const row of rows) {
    it(row.spec, async () => {
      const sleeps = useSeams();
      const hub = await startFakeHub({
        upgrades: row.trigger.kind === "upgrade" ? [{ kind: "reject", status: row.trigger.status }] : undefined,
        registrations:
          row.trigger.kind === "register-rejected"
            ? [{ kind: "reject", error: { code: -32602, message: "role `all` is the built-in" } }]
            : undefined,
      });
      const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: ROLES });
      opened.push({ hub, transport });
      const state = watch(transport.closed);
      void transport.start().catch(() => {});
      await hub.nextDial(1);
      // The two endings that happen to a LIVE connection need one first.
      if (row.trigger.kind === "close" || row.trigger.kind === "network-drop") {
        await hub.nextFrame(1);
        await hub.end(row.trigger.kind === "close" ? { kind: "close", code: row.trigger.code } : { kind: "drop" });
      }

      if (row.redials) {
        const redial = await hub.nextDial(2);
        expect(redial.seq, "the hub saw no second dial").toBe(2);
        // The schedule is only observable as the CEILING the delay was drawn from, at a
        // fixed draw: `max_only` stays at the cap, `exponential` starts at the base.
        const expected = backoffDelay(row.schedule === "max_only" ? PAST_THE_CAP : 0, () => DRAW);
        expect(sleeps.delays[0], `${row.schedule} schedule`).toBe(expected);
      } else {
        await settle();
        expect(hub.dials.length, "the client dialed again after a stopping ending").toBe(1);
        expect(sleeps.delays, "the client scheduled a retry it must not make").toEqual([]);
        expect(row.schedule).toBeNull();
      }

      await settle();
      if (row.settlement.kind === "pending") expect(state.status).toBe("pending");
      if (row.settlement.kind === "resolve") expect(state.status).toBe("resolved");
      if (row.settlement.kind === "reject") {
        expect(state.status).toBe("rejected");
        expect(state.error).toBeInstanceOf(row.settlement.error);
      }
      // A stopping ending leaves nothing connected.
      if (!row.redials) expect(hub.connectionCount()).toBe(0);
    });
  }
}
