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
 *
 * ADDED 2026-08-26 (§20): the data model beyond tools, which is the library's
 * whole share of that section — §20.6 pins "no new API beyond the widened
 * `roles` shape", so what this file gains is the widened declaration passing
 * through untouched, the one MCP-namespace method the LIBRARY answers instead of
 * bridging (`server/discover`, §11/§6), and the pass-through of the prompt and
 * resource families the bridge already carries. The last is a regression pin
 * rather than new behavior — §20 opens by saying a tunneled app that
 * declares prompts answers them over the socket TODAY, and the hub is the only
 * thing that said -32601 — and pinning it here is what keeps a future
 * frame-inspecting transport from quietly becoming a tools-only one.
 */

// deps: ./fake-hub (in-process `ws` hub: chooses upgrade status, accepts/rejects hub/register, closes with a code) · ./policy-rows (reconnectPolicyRows, unlistedEndingRows, ReconnectPolicyRow) · clients/js/src/index.ts (HubTransport, serve, CredentialsError, RegistrationError, Roles, seams — the module-level rng/sleep this file replaces and restores) · contracts/close-codes.json (read-only — see contracts-consumer.test.ts) · vitest fake timers

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
import type { Roles } from "../src/index";
import { startFakeHub } from "./fake-hub";
import type { FakeHub } from "./fake-hub";
import { reconnectPolicyRows, unlistedEndingRows, type ReconnectPolicyRow } from "./policy-rows";

/** An obviously fake app credential — the value every dial is checked to carry. */
const TOKEN = "pmcp_app_FAKE0000000000000000000000000000";

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

  it("§6/§10 · the derived scheme follows the origin's and is never downgraded: https:// derives wss://, http:// (the local `wrangler dev` case, and what the fake hub hands every case in this file) derives ws:// — a pmcp_app_ credential rides this dial, so the https half is a rule and not a convenience", () => {
    expect(connectAddress("https://mcp.example.com")).toBe("wss://mcp.example.com/connect");
    expect(connectAddress("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/connect");
  });

  it("§6 · the dial carries the app token as `Authorization: Bearer`, and carries no app or slug anywhere: identity rides the token alone", async () => {
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

  it("§15 · nothing the library surfaces echoes the credential: neither CredentialsError's message nor the error handed to onerror contains the pmcp_app_ value, so a crashed bot's log cannot leak the app's sole secret", async () => {
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
      expect(error.message).not.toContain("pmcp_app_");
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
  it("§6 · a mid-life network drop reconnects and re-sends hub/register, while onclose never fires and `closed` never settles — one transport is one app lifetime, not one socket", async () => {
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

  it("§10/§11 · serve() resolves its options before any I/O: url and token default to PMCP_URL and PMCP_APP_TOKEN, an explicit argument wins over the env var, and neither being set is a TypeError before a socket exists — an empty token dialed anyway would come back as upgrade 401 and be classified as a dead credential, turning a local config mistake into a revoked-token diagnosis", async () => {
    useSeams();
    const fromEnv = await startFakeHub();
    const explicit = await startFakeHub();
    opened.push({ hub: fromEnv }, { hub: explicit });
    const before = { url: process.env.PMCP_URL, token: process.env.PMCP_APP_TOKEN };
    try {
      delete process.env.PMCP_URL;
      delete process.env.PMCP_APP_TOKEN;
      await expect(serve(SESSION, {})).rejects.toBeInstanceOf(TypeError);
      await expect(serve(SESSION, { url: fromEnv.origin })).rejects.toBeInstanceOf(TypeError);
      expect(fromEnv.dials.length, "a socket was opened before the options resolved").toBe(0);

      process.env.PMCP_URL = fromEnv.origin;
      process.env.PMCP_APP_TOKEN = TOKEN;
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
      if (before.token === undefined) delete process.env.PMCP_APP_TOKEN;
      else process.env.PMCP_APP_TOKEN = before.token;
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

  it("§6 · unarchiving heals without touching the bot: the hub refuses 403 until the client is provably retrying, then accepts — and the very next dial connects and re-registers. The 403 row above pins that the client keeps dialing; this pins what the dialing is FOR, and it is the one §6 sentence about an archived app that a retry count alone cannot witness", async () => {
    useSeams(10);
    const hub = await startFakeHub({ upgrades: [{ kind: "reject", status: 403 }] });
    const transport = new HubTransport({ url: hub.origin, token: TOKEN, roles: ROLES });
    opened.push({ hub, transport });
    const started = watch(transport.start());
    // Provably retrying: two refused dials, and nothing connected.
    await hub.nextDial(2);
    expect(hub.connectionCount()).toBe(0);
    // The world changes — the app is unarchived — and nothing about the bot does.
    hub.setUpgrades([{ kind: "accept" }]);
    const registration = await hub.nextFrame(1);
    expect(registration.message.method).toBe("hub/register");
    await settle();
    expect(started.status, "start() never resolved after the hub healed").toBe("resolved");
  });
});

/**
 * §20's data model beyond tools, seen from the app author's side: the widened role
 * declaration going out untouched, the one MCP-namespace method the library answers itself,
 * and the prompt/resource traffic the bridge carries in both directions.
 *
 * Every case here drives `serve()` rather than HubTransport directly, and that is the point
 * of §20.6's "no new API": the author hands over an SDK server and a declaration and writes
 * nothing else, so the surface these rows are allowed to touch is exactly the surface an
 * author has.
 */
describe("the data model beyond tools · §20, §11", () => {
  it("§11/§20.3 · serve({roles}) passes a bare pattern list through to hub/register unchanged", async () => {
    const hub = await servingAuthor(new AuthorApp({ tools: {} }), ROLES);
    const declared = declaredRoles(hub);
    expect(declared).toEqual(ROLES);
    // Unchanged means UNNORMALIZED: `["get_news"]` becoming `{tools: ["get_news"]}` is the
    // hub's business (§20.3 — normalization happens once, in `registry.validateRoles` and
    // the filter builder), and a library that did it here would be a second rule that could
    // disagree with the first.
    expect(Array.isArray(declared.reader)).toBe(true);
  }, OBSERVATION_BUDGET_MS);

  it("§11/§20.3 · serve({roles}) passes a per-family object through unchanged — the library normalizes nothing", async () => {
    const hub = await servingAuthor(new AuthorApp({ tools: {}, prompts: {}, resources: {} }), MIXED_ROLES);
    const declared = declaredRoles(hub);
    expect(declared).toEqual(MIXED_ROLES);
    // The two spellings survive SIDE BY SIDE in one declaration (§20.3's own example): the
    // object is not flattened to its tools, and the bare list beside it is not lifted into
    // an object. Either repair would make the wire a function of which library sent it.
    expect(declared.curator).toEqual(MIXED_ROLES.curator);
    expect(Array.isArray(declared.reader)).toBe(true);
  }, OBSERVATION_BUDGET_MS);

  it("§11/§20.3 · a roles value the hub will reject is still sent as written; the library surfaces the hub's rejection rather than pre-validating", async () => {
    useSeams();
    const hub = await startFakeHub({
      registrations: [{ kind: "reject", error: { code: -32602, message: "unknown role family" } }],
    });
    opened.push({ hub });
    const served = watch(serve(new AuthorApp({ tools: {} }), { url: hub.origin, token: TOKEN, roles: REJECTED_ROLES }));
    await hub.nextFrame(1);
    // AS WRITTEN: not repaired into `{tools: […]}`, not dropped, not refused locally. §20.3
    // gives the family vocabulary exactly one validator and it is the hub's — a library
    // that pre-validated would be a second one, and the day they disagreed the author would
    // get a local TypeError for a declaration the hub was perfectly happy with.
    expect(declaredRoles(hub)).toEqual({ curator: { toolz: ["publish"] } });
    await settle();
    // …and what the author sees is the HUB's refusal, surfaced rather than retried: an
    // identical declaration cannot start succeeding (§6).
    expect(served.status).toBe("rejected");
    expect(served.error).toBeInstanceOf(RegistrationError);
    expect(hub.dials.length).toBe(1);
  }, OBSERVATION_BUDGET_MS);

  it("§11/§6 · the library answers the hub's server/discover itself with the families the author's SDK actually registered — the author writes nothing, and the request never reaches the SDK", async () => {
    const app = new AuthorApp({ tools: {}, prompts: {}, resources: {} });
    const hub = await servingAuthor(app);
    await hub.send({ jsonrpc: "2.0", id: DISCOVER_ID, method: "server/discover" });
    const answer = await hub.nextFrame(2);
    expect(answer.message.id).toBe(DISCOVER_ID);
    expect(familiesIn(answer.message)).toEqual(["prompts", "resources", "tools"]);
    // The author registered no handler for it and the SDK never saw the request: §11 makes
    // this the one MCP-namespace method the library handles itself, because it is a
    // hub↔library control question and the library is what knows which families were
    // registered.
    expect(app.reached.map((frame) => frame.method)).not.toContain("server/discover");
  }, OBSERVATION_BUDGET_MS);

  it("§11/§6 · an app whose SDK registers only tools answers server/discover with tools alone — the declaration is observed, not assumed from the library's own capabilities", async () => {
    const app = new AuthorApp({ tools: {} });
    const hub = await servingAuthor(app);
    await hub.send({ jsonrpc: "2.0", id: DISCOVER_ID, method: "server/discover" });
    const answer = await hub.nextFrame(2);
    // The library CAN carry all three — the bridge is transparent, and the two round-trip
    // rows below prove it — so answering with what the LIBRARY can do rather than with what
    // the AUTHOR registered would make every tools-only app in the field log three
    // spurious catalog-warm failures at the hub (§6/§20.5). That is the whole reason the
    // discover leg exists.
    expect(familiesIn(answer.message)).toEqual(["tools"]);
    expect(app.reached.map((frame) => frame.method)).not.toContain("server/discover");
  }, OBSERVATION_BUDGET_MS);

  it("§11/§6 · an app object the library cannot introspect for capabilities answers server/discover with -32601 — the \"capabilities unknown\" signal — and never a successful empty capability set, because a successful answer that omits a family is an UNDECLARE and §20.5 makes an undeclare clear that family's catalog", async () => {
    // Not a corner case: this package deliberately has no MCP SDK dependency and types the
    // author's server by the one method serve() calls, so an object with no capability seam
    // is the ORDINARY object — every app already in the field is one. §11 pins the
    // answer for it (the -32601 falls through to the hub, which warms tools only, "which is
    // what keeps every app already in the field working unchanged"), and §20.5 is why
    // the plausible repair is worse than the fallback: a discover leg that ERRORS changes no
    // catalog, while a successful `{}` tells the hub this app no longer serves prompts
    // or resources — clearing both catalogs for an app that is serving them right now.
    // Failure never empties one; success does. So the absence of a seam must stay a failure.
    const opaque = { connect: (transport: HubTransport): Promise<void> => transport.start() };
    useSeams();
    const hub = await startFakeHub();
    opened.push({ hub });
    watch(serve(opaque, { url: hub.origin, token: TOKEN, roles: ROLES }));
    await hub.nextFrame(1);
    await hub.send({ jsonrpc: "2.0", id: DISCOVER_ID, method: "server/discover" });
    // Observed on the frame the HUB sees, never on a library internal: what the hub reads is
    // the whole of this rule, and an answer that never arrives at all is a correlation
    // timeout, which §6 classes with -32601 but is not what this row asks for.
    const answer = await hub.nextFrame(2);
    expect(answer.message.id).toBe(DISCOVER_ID);
    expect((answer.message as { error?: { code?: number } }).error?.code).toBe(-32601);
    expect(answer.message.result, "an empty capability set is an undeclare, not an absence").toBeUndefined();
  }, OBSERVATION_BUDGET_MS);

  it("§11/§20.1 · a prompts/get request from the hub reaches the author's SDK server and its response returns over the socket", async () => {
    const app = new AuthorApp({ tools: {}, prompts: {} }, { "prompts/get": PROMPT_RESULT });
    const hub = await servingAuthor(app);
    const request = {
      jsonrpc: "2.0",
      id: 21,
      method: "prompts/get",
      params: { name: "digest", arguments: { topic: "ai" } },
    };
    await hub.send(request);
    const relayed = await hub.nextFrame(2);
    // Both directions verbatim: the request arrives at the author's server exactly as the
    // hub sent it — `arguments` included, which is what the hub's redact map keys on (§20.3)
    // — and the answer goes back on the socket the hub asked over.
    expect(app.reached).toEqual([request]);
    expect(relayed.message).toEqual({ jsonrpc: "2.0", id: 21, result: PROMPT_RESULT });
  }, OBSERVATION_BUDGET_MS);

  it("§11/§20.1 · a resources/read request round-trips the same way", async () => {
    const app = new AuthorApp({ tools: {}, resources: {} }, { "resources/read": RESOURCE_RESULT });
    const hub = await servingAuthor(app);
    const request = { jsonrpc: "2.0", id: 22, method: "resources/read", params: { uri: RESOURCE_URI } };
    await hub.send(request);
    const relayed = await hub.nextFrame(2);
    expect(app.reached).toEqual([request]);
    expect(relayed.message).toEqual({ jsonrpc: "2.0", id: 22, result: RESOURCE_RESULT });
    // The URI the app knows is the URI it is asked for and the URI it answers with:
    // §20.2 refuses to rewrite one anywhere, which is why resources are scoped-only.
    expect(JSON.stringify(relayed.message)).toContain(RESOURCE_URI);
  }, OBSERVATION_BUDGET_MS);

  it("§11/§20.5 · a prompts/list_changed notification emitted by the author's SDK reaches the hub unchanged", async () => {
    const app = new AuthorApp({ tools: {}, prompts: {} });
    const hub = await servingAuthor(app);
    const notification = { jsonrpc: "2.0", method: "notifications/prompts/list_changed" };
    await app.emit(notification);
    const relayed = await hub.nextFrame(2);
    // A pass-through, not a feature (§11): the DO routes this frame to invalidate its
    // `catalog:prompts` key (§20.5), so a library that swallowed or renamed it would leave
    // the hub serving a stale prompt list until the next registration.
    expect(relayed.message).toEqual(notification);
  }, OBSERVATION_BUDGET_MS);

  // ── §21.4's per-URI push, from the author's side ────────────────────────────────────
  // Subscribe, unsubscribe and `resources/updated` are to the bridge what reads and the
  // list_changed notifications are: ordinary framed MCP traffic the library neither
  // recognizes nor stashes. A library that kept its own subscription set would contradict
  // the "session-scoped, lives on the socket" lifetime §21.4 pins, no matter how useful
  // the shortcut looked.

  it("§11/§21.4 · a resources/subscribe from the hub reaches the author's SDK and its response returns over the socket — the library keeps no subscription set · resources/unsubscribe round-trips identically", async () => {
    const app = new AuthorApp({ tools: {}, resources: {} }, {
      "resources/subscribe": SUBSCRIBE_RESULT,
      "resources/unsubscribe": SUBSCRIBE_RESULT,
    });
    const hub = await servingAuthor(app);
    const subscribe = {
      jsonrpc: "2.0",
      id: 23,
      method: "resources/subscribe",
      params: { uri: RESOURCE_URI },
    };
    await hub.send(subscribe);
    // Both directions verbatim: the request arrives at the author's SDK exactly as the
    // hub sent it — URI included, which §21.4 keys on — and the answer goes back on the
    // socket the hub asked over.
    const relayed = await hub.nextFrame(2);
    expect(app.reached).toEqual([subscribe]);
    expect(relayed.message).toEqual({ jsonrpc: "2.0", id: 23, result: SUBSCRIBE_RESULT });
    // The no-set half of the row: the SAME URI subscribed TWICE reaches the SDK twice.
    // A library that retained subscriptions would dedupe, cache, or prefetch here and the
    // second ask would vanish — but the set lives on the hub's socket, never in the
    // library, so there is nothing to remember.
    await hub.send(subscribe);
    const again = await hub.nextFrame(3);
    expect(app.reached).toEqual([subscribe, subscribe]);
    expect(again.message).toEqual({ jsonrpc: "2.0", id: 23, result: SUBSCRIBE_RESULT });
    const unsubscribe = {
      jsonrpc: "2.0",
      id: 24,
      method: "resources/unsubscribe",
      params: { uri: RESOURCE_URI },
    };
    await hub.send(unsubscribe);
    const unrelayed = await hub.nextFrame(4);
    expect(app.reached).toEqual([subscribe, subscribe, unsubscribe]);
    expect(unrelayed.message).toEqual({ jsonrpc: "2.0", id: 24, result: SUBSCRIBE_RESULT });
  }, OBSERVATION_BUDGET_MS);

  it("§11/§21.4 · a notifications/resources/updated the SDK emits crosses the socket verbatim, its uri untouched — for a URI no subscribe ever crossed this socket, so a library that secretly kept a set would fail it", async () => {
    const app = new AuthorApp({ tools: {}, resources: {} });
    const hub = await servingAuthor(app);
    // The one outbound frame §21.4 adds. The DO routes it by EXACT uri match against the
    // subscriber socket's set (§21.4) — nothing for the SDK session to do, and nothing for
    // a transparent bridge to decide, so the frame must arrive untouched.
    const updated = {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: `${RESOURCE_URI}/late` },
    };
    await app.emit(updated);
    const relayed = await hub.nextFrame(2);
    expect(relayed.message).toEqual(updated);
    // …for a URI NO subscribe ever crossed this socket: frame 1 is the registration and
    // this row sends no subscribe — a library that kept a set would have nothing to match
    // against and (in the eager spelling of that bug) silence the relay; a library that
    // filters sends a frame that is NOT this one. The observed wire is both frames.
    expect(hub.frames.map((frame) => frame.message.method)).toEqual([
      "hub/register",
      "notifications/resources/updated",
    ]);
  }, OBSERVATION_BUDGET_MS);
});

/**
 * What a §20 case may take. Past the fake hub's own 5 s observation deadline on purpose: a
 * row that fails because a frame never arrived should report the harness's diagnosis ("the
 * fake hub never observed frame 2") rather than a bare vitest timeout, and with the two
 * budgets equal the race decides which one the reader gets.
 */
const OBSERVATION_BUDGET_MS = 10_000;

/**
 * The author's app as `serve()` receives it — §11's "plain MCP server written with the
 * official SDK", stood in for here because this package deliberately has no SDK dependency
 * (which is also why the library names it structurally). The Python twin wraps a REAL
 * `mcp.server.Server` for the capability half; this side cannot, so the capabilities are
 * handed in.
 *
 * Three abilities and no more, one per thing §20 asks of an author's server: report the
 * families it registered, answer a forwarded request, and emit a notification of its own.
 * `reached` records at ARRIVAL, before any scripted answer runs, which is what makes "the
 * request never reaches the SDK" an observation rather than an absence.
 */
class AuthorApp {
  /** Every message that reached the session, in arrival order. */
  readonly reached: Record<string, unknown>[] = [];

  private transport: HubTransport | null = null;

  constructor(
    /**
     * What the author's SDK registered, in the SDK's own `ServerCapabilities` shape. Read
     * through `getCapabilities()` — the twin of the Python SDK's `Server.get_capabilities()`,
     * which really does derive this from the handlers the author registered (verified against
     * the installed `mcp` package: the no-argument call is its own default). §11 gives the
     * LIBRARY the `server/discover` answer precisely because this is what it can see and the
     * hub cannot.
     *
     * RECORDED, not resolved (2026-08-26, reconciliation): §11 names the ANSWER but no
     * accessor, and this package has no `@modelcontextprotocol/*` dependency anywhere in the
     * workspace, so the TS SDK's real spelling cannot be checked from this repo. `getCapabilities()`
     * is chosen as the camelCase twin of the Python SDK's verified name — one seam, one
     * spelling, two languages, the same decision the module-level `seams` object already
     * carries — and it is read OPTIONALLY, which is what the row above pins: an author's
     * object that does not answer to it takes §11's blessed fallback rather than a
     * fabricated capability set. If the TS SDK turns out to publish a different accessor,
     * this fake and the library's probe change together and no row's claim moves.
     */
    private readonly capabilities: Record<string, unknown>,
    /** method → the result this server answers it with. A method with no entry is recorded and left unanswered. */
    private readonly answers: Record<string, unknown> = {},
  ) {}

  getCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  async connect(transport: HubTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      const frame = message as { id?: unknown; method?: string };
      this.reached.push(frame as Record<string, unknown>);
      const answer = this.answers[frame.method ?? ""];
      if (answer !== undefined && frame.id !== undefined) {
        void transport.send({ jsonrpc: "2.0", id: frame.id, result: answer });
      }
    };
    await transport.start();
  }

  /** One notification the author's SDK emits on its own — the outbound half of the bridge. */
  async emit(frame: Record<string, unknown>): Promise<void> {
    await this.transport?.send(frame);
  }
}

/** One author's app running against one fresh hub, registered — the shape every §20 row
 *  starts from. The hub is torn down by the shared teardown; the transport is serve()'s own. */
async function servingAuthor(app: AuthorApp, roles?: Roles): Promise<FakeHub> {
  useSeams();
  const hub = await startFakeHub();
  opened.push({ hub });
  watch(serve(app, { url: hub.origin, token: TOKEN, roles: roles ?? ROLES }));
  await hub.nextFrame(1);
  return hub;
}

/** The declaration the hub really received on the first frame. */
function declaredRoles(hub: FakeHub): Record<string, unknown> {
  return (hub.frames[0].message.params as Record<string, unknown>).roles as Record<string, unknown>;
}

/**
 * The families one `server/discover` answer names, sorted. Read off `result.capabilities`
 * and intersected with §20.3's vocabulary, because an SDK's capability object also carries
 * keys that are not families (`experimental`, `extensions`) — what the hub reads from this
 * answer is which catalogs to warm, and that is a question about families alone.
 */
function familiesIn(frame: Record<string, unknown>): string[] {
  const result = frame.result as { capabilities?: Record<string, unknown> } | undefined;
  return Object.keys(result?.capabilities ?? {})
    .filter((key) => FAMILIES.includes(key))
    .sort();
}

/** The capability families §20 knows. `completions` is here so a library that declared it
 *  unasked is visible, not because any row expects it. */
const FAMILIES = ["tools", "prompts", "resources", "completions"];

/**
 * §20.3's two spellings in ONE declaration — the example the spec itself writes. Typed
 * against the library's own {@link Roles} on purpose: §20.6 pins "no new API beyond the
 * widened `roles` shape", so a declaration type that still reads `Record<string, string[]>`
 * is the library's half of this dispatch left undone, and it should fail at the type rather
 * than pass silently at runtime.
 */
const MIXED_ROLES: Roles = {
  reader: ["get_news", "search_.*"],
  curator: { tools: ["publish"], prompts: ["digest_.*"], resources: ["news://feed/*"] },
};

/**
 * A declaration the HUB rejects — §20.3 makes an unknown family key a violation like any
 * other. The cast IS the case: an author writing plain JS can produce exactly this, and the
 * library must send it rather than repair it or refuse it locally.
 */
const REJECTED_ROLES = { curator: { toolz: ["publish"] } } as unknown as Roles;

/** The correlation id the hub puts on its own `server/discover` — the hub's id, never one
 *  the library minted (it originates exactly one request, `hub/register`). */
const DISCOVER_ID = "hub-discover-1";

/** What the author's server answers a `prompts/get` with: §20.1's message list. Content
 *  blocks, which is why §15 stubs them in the audit ledger rather than storing the text. */
const PROMPT_RESULT = {
  description: "a digest",
  messages: [{ role: "user", content: { type: "text", text: "headlines" } }],
};

/** …and a `resources/read`: contents keyed by the URI the app itself knows. */
const RESOURCE_URI = "news://feed/tech";
const RESOURCE_RESULT = {
  contents: [{ uri: RESOURCE_URI, mimeType: "text/plain", text: "headline" }],
};
/** …and §21.4's per-URI methods: the one result the author's SDK answers with. Shaped
 *  like MCP's own definition (a subscription that took, an unsubscription that took) and
 *  distinctive enough that the two round-trip rows can tell the response from a nil. */
const SUBSCRIBE_RESULT = { resultType: "complete" };

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
