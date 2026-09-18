/**
 * cli/test/commands.test.ts — the witness behind `COMMANDS[].ops`.
 *
 * The recording seam is the wire: main.ts speaks the hub's stateless POST endpoint with
 * fetch, so a stub sees the same tools/call frames as a real hub. Each table row is driven
 * through the real argv dispatcher and must reach exactly the operations it declares.
 *
 * Scope is deliberately narrow: command-to-operation mapping and the CLI's observable
 * argv/output contracts. Server operation behavior belongs to the worker suites.
 *
 * Project: `cli` — plain Node, parallel. Nothing reaches the network or the developer's
 * own profile store.
 */

// deps: cli/src/main.ts (dispatcher) · cli/src/commands.ts (COMMANDS) · a stubbed
//   global fetch (the recording seam) · vitest

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/commands";
import { main } from "../src/main";

/** Obviously fake, and never a `pmcp_app_` value — main.ts refuses that kind outright. */
const TOKEN = "pmcp_agt_FAKE0000000000000000000000000000";
const ORIGIN = "https://hub.invalid";
const NAMESPACE = "owner";


const serverApp = (slug: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  kind: "tunnel",
  name: slug,
  description: "",
  archived: false,
  builtin: false,
  status: "online",
  roles: { reader: [".*"] },
  redact: {},
  redactResults: {},
  logBodies: true,
  ...over,
});

/** What each op answers, for the few ops whose reply the dispatcher reads on the way out. */
function replyFor(op: string): Record<string, unknown> {
  switch (op) {
    case "app_list":
      return {
        apps: [
          serverApp("gone"),
          serverApp("keep"),
          serverApp("parked"),
          serverApp("revived", { archived: true }),
        ],
      };
    case "agent_list":
      return { agents: [{ slug: "stale", name: "stale", description: "", grants: {} }] };
    case "app_create":
      return { app: { slug: "news" } };
    case "app_update":
      // §23.6's row: owner configuration, the resolved reservation map (one active owner
      // assignment, one superseded tombstone), and one bounded collision diagnostic — the
      // three keys `app aliases set` renders human-side and emits machine-side.
      return {
        app: {
          slug: "news",
          typescriptAliases: { service: "news" },
          typescriptReservations: [
            { family: "service", canonicalName: "news", typescriptName: "news", source: "owner", active: true, supersededAt: null },
            { family: "tool", canonicalName: "old-name", typescriptName: "oldName", source: "generated", active: false, supersededAt: 0 },
          ],
          typescriptDiagnostics: [
            {
              family: "tool",
              canonicalName: "ping",
              typescriptName: "ping",
              reason: "alias_conflict",
              message: 'TypeScript name "ping" is already held by another canonical member',
            },
          ],
        },
      };
    case "hub_settings_get":
    case "hub_settings_update":
      return { settings: { defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000 } };
    case "app_get":
      // `connect` refuses anything but an `auth: oauth` proxied app before printing.
      return { app: { slug: "notion", kind: "proxy", auth: "oauth" } };
    case "token_issue":
      return { id: "tok_FAKE", token: "pmcp_app_FAKE0000000000000000000000000000" };
    case "audit_query":
      return { rows: [], total: 0 };
    case "connection_list":
      // One row exercises the print path, lastUsedAt: null its "never" fallback (§19).
      return {
        connections: [
          {
            id: "conn_FAKE",
            clientId: "client_FAKE",
            clientName: "Claude",
            agentSlug: "bot",
            createdAt: 0,
            lastUsedAt: null,
            revokedAt: null,
            redirectOrigin: "https://client.example",
            selfRegistered: true,
          },
          // The twin row: vouched at registration, and a provider that holds no client row
          // reports an empty origin — the cell must print empty, never `undefined`.
          {
            id: "conn_FAKE2",
            clientId: "client_FAKE2",
            clientName: null,
            agentSlug: "bot",
            createdAt: 0,
            lastUsedAt: 0,
            revokedAt: null,
            redirectOrigin: "",
            selfRegistered: false,
          },
        ],
      };
    default:
      return {};
  }
}

/** Every admin op name the stubbed hub saw, in call order — the whole oracle of this file. */
let recorded: string[] = [];

beforeEach(() => {
  recorded = [];
  // The env overrides win over ~/.config/pmcp/config.json, so no case can read — or
  // write — the developer's own session.
  vi.stubEnv("PMCP_URL", ORIGIN);
  vi.stubEnv("PMCP_TOKEN", TOKEN);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/api/whoami")) {
      return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
    }
    const message = JSON.parse(init?.body ?? "{}") as { method?: string; params?: { name?: string } };
    // Only the builtin `pmcp` endpoint carries admin ops; `tools`/`call` reach an app's
    // own endpoint and are recorded as the zero ops their rows claim.
    if (message.method === "tools/call" && String(url).endsWith(`/${NAMESPACE}/mcp/pmcp`)) {
      const op = String(message.params?.name);
      recorded.push(op);
      return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: replyFor(op) } });
    }
    return json({ jsonrpc: "2.0", id: 1, result: message.method === "tools/list" ? { tools: [] } : {} });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

/**
 * A hub that COUNTS every request instead of recording frames — the whoami handshake
 * included. It is the only oracle that can see a local check performed after
 * `await context()`: a stub that records `pmcp` tools/call frames answers whoami before it
 * records anything, so "no frame" and "nothing on the wire" are not the same claim (§10 —
 * pure argv mistakes are caught locally, BEFORE any network).
 */
function countingHub(): { calls: number } {
  const counter = { calls: 0 };
  vi.stubGlobal("fetch", async () => {
    counter.calls += 1;
    return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE, jsonrpc: "2.0", id: 1, result: {} });
  });
  return counter;
}

/**
 * The argv that reaches each row's subcommand — the only thing this file spells by hand,
 * and deliberately so: it is the row's NAME as a user types it, not its mapping. `--yes`
 * appears where the row is destructive, because a prompt with no terminal behind it is a
 * refusal (main.confirm) and a refused command calls nothing.
 */
const ARGV: Record<string, string[]> = {
  ls: ["ls"],
  tools: ["tools", "news"],
  call: ["call", "news", "echo", "text=hi"],
  // §23's hub surface. The two tool rows address the virtual `hub` app's scoped mount and
  // reach zero admin ops — like the §20.6 four, the row-driven case witnesses only the
  // zero half, and the method/endpoint half is pinned by the §23 block below. The two
  // settings rows are real ops behind `pmcp`; `app aliases set` is one `app_update`.
  "hub execute": ["hub", "execute", "--args", '{"code":"export default 1","timeout_ms":5000}'],
  "hub search-types": ["hub", "search-types", "--args", '{"query":"news"}'],
  "hub settings get": ["hub", "settings", "get"],
  "hub settings set": ["hub", "settings", "set", "--default-timeout-ms", "30000", "--max-timeout-ms", "60000"],
  "app aliases set": ["app", "aliases", "set", "news", "--args", '{"service":"news"}'],
  // §20.6's four. They front an MCP method rather than an admin op, so each one reaches
  // exactly zero ops — which is the half of direction D the row-driven case witnesses, and
  // the half a table row claiming `ops: []` cannot witness about itself. The other half is
  // `server/test/worker/contracts.test.ts`'s "§8 parity D · pmcp prompts/prompt/resources/
  // read front MCP methods" row, which names the same four and the method each fronts —
  // the totality case below only holds once those rows exist in COMMANDS.
  prompts: ["prompts", "news"],
  prompt: ["prompt", "news", "digest"],
  resources: ["resources", "news"],
  read: ["read", "news", "news://feed/tech"],
  "app create": ["app", "create", "news"],
  "app archive": ["app", "archive", "news"],
  "app unarchive": ["app", "unarchive", "news"],
  "app delete": ["app", "delete", "news", "--yes"],
  "app disconnect": ["app", "disconnect", "notion"],
  "app set-auth": ["app", "set-auth", "notion", "--header", "X-Api-Key: k"],
  "agent list": ["agent", "list"],
  "agent create": ["agent", "create", "bot"],
  "agent update": ["agent", "update", "bot", "--name", "New Bot"],
  "agent delete": ["agent", "delete", "bot", "--yes"],
  approvals: ["approvals", "--pending"],
  approve: ["approve", "ap_FAKE"],
  reject: ["reject", "ap_FAKE"],
  "token issue": ["token", "issue", "--agent", "bot"],
  "token list": ["token", "list"],
  "token revoke": ["token", "revoke", "tok_FAKE"],
  "admin-token issue": ["admin-token", "issue"],
  "admin-token list": ["admin-token", "list"],
  "admin-token revoke": ["admin-token", "revoke", "adm_FAKE"],
  connections: ["connections"],
  "connection revoke": ["connection", "revoke", "conn_FAKE"],
  audit: ["audit", "--app", "news"],
  "audit --export jsonl": ["audit", "--export", "jsonl"],
  connect: ["connect", "notion"],
};

/** The auth family reaches no op by definition (§8's first pinned exception). */
const driven = COMMANDS.filter((command) => command.exception !== "auth");

describe("§4 direction D · the dispatcher answers to the command table", () => {
  it("§4 · every non-auth row of COMMANDS has argv here — a subcommand added to the table without a way to run it would leave its `ops` unwitnessed", () => {
    expect(driven.map((command) => command.name).sort()).toEqual(Object.keys(ARGV).sort());
  });

  for (const command of driven) {
    it(`§4 · \`pmcp ${command.name}\` calls exactly the ops its row claims`, async () => {
      const code = await main(ARGV[command.name] ?? []);
      expect(code, `pmcp ${command.name} exited non-zero`).toBe(0);
      // Both directions at once: an op the dispatcher calls and the row omits, and an op
      // the row claims and the dispatcher never makes.
      expect([...new Set(recorded)].sort()).toEqual([...command.ops].sort());
    });
  }

});

describe("§10 · the argv grammar, where a misreading is silent", () => {

  it("§10 · a boolean flag never swallows the word after it: `pmcp app --yes delete news` deletes, rather than reading `delete` as the value of `--yes` and failing with a usage error", async () => {
    const code = await main(["app", "--yes", "delete", "news"]);
    expect(code).toBe(0);
    expect(recorded).toEqual(["app_delete"]);
  });

  // §10's two duration flags — the CLI's only TRANSLATED argument values, and so the only
  // ones where a misreading is silent on both sides of the wire. §10 documents the human
  // spellings (`--since 7d`, `--expires 90d`); the hub declares integers of two different
  // units (audit_query's since/until are epoch MS, token_issue's expires_in is SECONDS of
  // lifetime — `declared` below reads both from the contract). Nothing but the CLI can
  // close that gap: the hub has no duration grammar to fall back on. The four cases below
  // walk every accepted spelling of both flags to the wire, and pin that an unaccepted one
  // fails LOCALLY — a frame the hub would refuse is a frame this CLI must never send.

  /** The `pmcp` tools/call frames one run put on the wire — name and arguments verbatim. */
  type PmcpFrame = { name: string; arguments: Record<string, unknown> };

  /**
   * A stubbed hub that RECORDS each `pmcp` frame instead of only its op name, so a case
   * can read the argument values the dispatcher chose. `refusal`, when given, is answered
   * in place of a result — the JSON-RPC error shape a real hub returns — which is how the
   * refusal cases observe what the CLI does with one without this file claiming to know
   * that the hub refuses. The claim that it does is the CONTRACT's (`declared` below),
   * not the stub's.
   */
  function recordingHub(refusal?: { code: number; message: string }): PmcpFrame[] {
    const frames: PmcpFrame[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) {
        return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      }
      const message = JSON.parse(init?.body ?? "{}") as {
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (message.method !== "tools/call" || !String(url).endsWith(`/${NAMESPACE}/mcp/pmcp`)) {
        return json({ jsonrpc: "2.0", id: 1, result: {} });
      }
      const name = String(message.params?.name);
      frames.push({ name, arguments: message.params?.arguments ?? {} });
      if (refusal !== undefined) return json({ jsonrpc: "2.0", id: 1, error: refusal });
      return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: replyFor(name) } });
    });
    return frames;
  }

  /**
   * One field of one op as `contracts/admin-ops.json` declares it — the cross-language
   * oracle (strategy §4: `server/test/worker/contracts.test.ts` is its only writer, the
   * CLI consumes it read-only). This is what makes "the hub refuses this frame" a fact
   * about the hub rather than about the stub above.
   */
  function declared(op: string, field: string): Record<string, unknown> {
    const path = fileURLToPath(new URL("../../contracts/admin-ops.json", import.meta.url));
    const fixture = JSON.parse(readFileSync(path, "utf8")) as {
      inputSchemas: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
    };
    const declaration = fixture.inputSchemas[op]?.properties?.[field];
    if (declaration === undefined) throw new Error(`contracts/admin-ops.json declares no ${op}.${field}`);
    return declaration;
  }

  /** JSON-RPC's own "invalid params", the code admin.ts refuses a mistyped field with. */
  const INVALID_PARAMS = -32602;

  /** One day in ms, spelled out here rather than imported: the test is the second opinion. */
  const DAY_MS = 86_400_000;

  it("§10 · `pmcp audit --since 7d --until 1d` reaches the wire as the epoch-MS integers audit_query declares: the duration is resolved against this machine's clock, because the hub has no grammar that would resolve it there", async () => {
    const frames = recordingHub();
    // The call spans an interval, so each instant is pinned to the window it could have
    // been stamped in rather than to an exact reading of a clock nothing here froze.
    const before = Date.now();
    expect(await main(["audit", "--since", "7d", "--until", "1d", "--limit", "5"])).toBe(0);
    const after = Date.now();
    expect(frames.map((frame) => frame.name)).toEqual(["audit_query"]);
    // The whole key set, so a flag that stopped reaching the frame at all cannot pass by
    // satisfying a looser assertion about the ones that remain.
    expect(Object.keys(frames[0].arguments).sort()).toEqual(["limit", "since", "until"]);
    const { since, until, limit } = frames[0].arguments as Record<string, number>;
    // "7d" means seven days AGO — an instant behind now, not a span and not a future one.
    expect(since).toBeGreaterThanOrEqual(before - 7 * DAY_MS);
    expect(since).toBeLessThanOrEqual(after - 7 * DAY_MS);
    expect(until).toBeGreaterThanOrEqual(before - DAY_MS);
    expect(until).toBeLessThanOrEqual(after - DAY_MS);
    expect(Number.isInteger(since), `since is ${JSON.stringify(since)}`).toBe(true);
    expect(Number.isInteger(until), `until is ${JSON.stringify(until)}`).toBe(true);
    expect(limit).toBe(5);
    // What makes an integer the RIGHT answer here is the hub's own declaration of these
    // fields, not this file's opinion of them.
    expect(declared("audit_query", "since")).toMatchObject({ type: "integer" });
    expect(declared("audit_query", "until")).toMatchObject({ type: "integer" });
    expect(declared("audit_query", "limit")).toMatchObject({ type: "integer" });
  });

  it("§10 · a bare epoch and an ISO-8601 instant are `--since`'s other two spellings, and a value that is none of the three fails LOCALLY: exit 2 with NOTHING on the wire, never a frame the hub is left to refuse", async () => {
    const accepted = recordingHub();
    expect(await main(["audit", "--since", "1750000000000", "--until", "2026-08-26T00:00:00Z"])).toBe(0);
    expect(accepted.map((frame) => frame.arguments)).toEqual([
      { since: 1_750_000_000_000, until: Date.parse("2026-08-26T00:00:00Z") },
    ]);

    // Counted at the FETCH, not at the `pmcp` frame: the whoami handshake is a request too,
    // and a `--since` resolved after `await context()` would reach the network before it
    // failed — invisible to a stub that records only tools/call frames, and reported as
    // `remote_error` exit 1 rather than `usage` exit 2 the moment the hub is unreachable.
    const rejected = countingHub();
    expect(await main(["audit", "--since", "7 days"])).toBe(2);
    expect(rejected.calls, "a malformed --since must be caught before any request").toBe(0);
  });

  it("§10 · a refusal the hub DOES send is reported rather than absorbed, and a refused page is not retried: `audit --export jsonl` is the one command that re-queries, and it stops at the first error", async () => {
    const frames = recordingHub({ code: INVALID_PARAMS, message: '"tool" has the wrong type' });
    expect(await main(["audit", "--tool", "echo", "--export", "jsonl"])).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it("§10 · `pmcp token issue --expires 90d` reaches the wire as the SECONDS integer token_issue declares — a LIFETIME, not an instant, and a different unit from audit's — while `never` and a bare count are the other two members of that union", async () => {
    const relative = recordingHub();
    expect(await main(["token", "issue", "--agent", "bot", "--expires", "90d"])).toBe(0);
    expect(relative.map((frame) => frame.arguments)).toEqual([
      { kind: "agent", slug: "bot", expires_in: 90 * 24 * 60 * 60 },
    ]);

    const never = recordingHub();
    expect(await main(["token", "issue", "--agent", "bot", "--expires", "never"])).toBe(0);
    expect(never.map((frame) => frame.arguments)).toEqual([
      { kind: "agent", slug: "bot", expires_in: "never" },
    ]);

    const bare = recordingHub();
    expect(await main(["token", "issue", "--app", "news", "--expires", "3600"])).toBe(0);
    expect(bare.map((frame) => frame.arguments)).toEqual([
      { kind: "app", slug: "news", expires_in: 3600 },
    ]);

    // Same local refusal as `--since`: an untranslatable lifetime never becomes a token,
    // and never becomes a request of any kind either.
    const rejected = countingHub();
    expect(await main(["token", "issue", "--agent", "bot", "--expires", "90 days"])).toBe(2);
    expect(rejected.calls).toBe(0);

    expect(declared("token_issue", "expires_in")).toMatchObject({
      oneOf: [{ type: "integer" }, { const: "never" }],
    });
  });

  it("§10 · `pmcp admin-token issue --expires <garbage>` fails locally, before `await context()` resolves a credential — the malformed duration is parsed left of the whoami round-trip, exactly like `token issue`'s", async () => {
    const rejected = countingHub();
    expect(await main(["admin-token", "issue", "--expires", "90 days"])).toBe(2);
    expect(rejected.calls, "a malformed --expires must be caught before any request, including whoami").toBe(0);
  });

  it("§22.1 · `refuseAdminToken` is target-based, not blanket: a `pmcp_adm_` token is refused against an ordinary app slug but honoured against the builtin `pmcp` slug — the same surface `ls` already fronts unconditionally", async () => {
    vi.stubEnv("PMCP_TOKEN", "pmcp_adm_FAKE0000000000000000000000000000");

    // Refused: `news` is an ordinary app surface, still closed to admin tokens.
    const rejected = countingHub();
    expect(await main(["call", "news", "echo", "text=hi"])).toBe(1);
    expect(rejected.calls, "the refusal fires after whoami resolves the token kind, before any app-facing request").toBe(1);
    const stderr = process.stderr.write as unknown as { mock: { calls: unknown[][] } };
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "a pmcp_adm_ admin token administers the hub and cannot reach a single app's tools",
    );

    // Honoured: `pmcp` IS the builtin admin surface `ls` already reaches unconditionally —
    // the same op dispatch §22.1's acceptance table grants `pmcp_adm_` outright.
    const frames = recordingHub();
    expect(await main(["call", "pmcp", "grant_set", "agent=bot", "app=news", "roles=reader"])).toBe(0);
    expect(frames.map((frame) => frame.name)).toEqual(["grant_set"]);
  });

  it("§23.1 · `pmcp call` no longer splits `<slug>_<tool>`: the aggregate endpoint serves no application tools, so a one-word target is the missing half of the pair — exit 2 with nothing on the wire, never an app called `news_echo`", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: "user:owner", namespace: NAMESPACE });
      sent.push(JSON.parse(init?.body ?? "{}"));
      return json({ jsonrpc: "2.0", id: 1, result: {} });
    });
    // The split that used to make this an aggregated name is gone with the aggregate
    // dispatch itself (§23.1), and it must fail LOCALLY: an aggregated frame would reach a
    // service that answers every application call with -32601.
    expect(await main(["call", "news_echo", "text=hi"])).toBe(2);
    expect(sent).toEqual([]);
    // A word that is neither an app, a tool, nor key=value is an error rather than a
    // silently dropped argument — the rule the partition-by-shape has always had.
    expect(await main(["call", "news", "echo", "hello"])).toBe(2);
    expect(sent).toEqual([]);
    // The two-positional form is the whole grammar now, and it reaches the wire verbatim.
    expect(await main(["call", "news", "echo", "text=hi"])).toBe(0);
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
    ]);
  });
});

describe("§10/§19 · pmcp connections prints what connection_list already knows", () => {
  // G29 (2026-09-03): the table dropped the client's redirect origin and the DCR marker,
  // the two facts a reader wants first when a row looks unfamiliar.
  it("§10 · `pmcp connections` prints ORIGIN and SELF-REGISTERED beside the six columns it had — the origin verbatim from connection_list's redirectOrigin, `yes` for a self-registered client and blank for a vouched one · a row with an empty origin prints an empty cell, never `undefined` (the twin)", async () => {
    expect(await main(["connections"])).toBe(0);
    const spy = process.stdout.write as unknown as { mock: { calls: unknown[][] } };
    const lines = spy.mock.calls.map((call) => String(call[0])).join("").split("\n");
    const header = lines[0] ?? "";
    for (const column of ["CONNECTION", "CLIENT", "AGENT", "CREATED", "LAST USED", "STATUS", "ORIGIN", "SELF-REGISTERED"]) {
      expect(header, column).toContain(column);
    }
    const first = lines.find((line) => line.includes("conn_FAKE ")) ?? lines.find((line) => line.includes("conn_FAKE")) ?? "";
    expect(first).toContain("https://client.example");
    expect(first).toContain("yes");
    // The twin: a vouched client with no provider row prints an empty origin, not a word.
    const second = lines.find((line) => line.includes("conn_FAKE2")) ?? "";
    expect(second).not.toContain("undefined");
    expect(second).not.toContain("yes");
    expect(second).not.toContain("https://");
  });
});

describe("§20.6 · the data-model commands, gateway sugar over an MCP method", () => {
  /** One JSON-RPC frame a run put on the wire, with the endpoint path it was addressed to. */
  type GatewayFrame = { path: string; method: string; params: Record<string, unknown> };

  /**
   * A stubbed hub that records the WHOLE frame rather than an op name: these four commands
   * front no admin op, so the oracle is the method they chose, the endpoint they chose it
   * on, and the params they built. `results` answers one method with the shape a real
   * app returns; an unanswered method gets `{}`, which every renderer reads as an empty
   * family. Nothing about the CLI is mocked — argv parsing and the whoami handshake run.
   */
  function gatewayHub(results: Record<string, unknown> = {}): GatewayFrame[] {
    const frames: GatewayFrame[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) {
        return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      }
      const message = JSON.parse(init?.body ?? "{}") as { method?: string; params?: Record<string, unknown> };
      const method = String(message.method);
      frames.push({ path: new URL(String(url)).pathname, method, params: message.params ?? {} });
      return json({ jsonrpc: "2.0", id: 1, result: results[method] ?? {} });
    });
    return frames;
  }

  /** Whatever the run wrote to one of the two streams the shared beforeEach spies on. */
  function written(stream: { write: unknown }): string[] {
    const spy = stream.write as { mock: { calls: unknown[][] } };
    return spy.mock.calls
      .map((call) => String(call[0]))
      .join("")
      .split("\n")
      .filter((line) => line !== "");
  }

  const printed = (): string[] => written(process.stdout);
  const errored = (): string[] => written(process.stderr);

  /** §20.2's mount for a prompt- or resource-heavy app: the scoped one, unprefixed. */
  const SCOPED = `/${NAMESPACE}/mcp/news`;

  /**
   * A second app, whose slug is deliberately NOT the scheme of the URI read below.
   * §20.2 routes a read by the ADDRESSED SLUG and never by the URI it names, and a fixture
   * that reads `news://…` on the app `news` cannot tell the two apart: a CLI that built
   * its mount out of the URI's scheme would produce the identical frame.
   */
  const SCOPED_DOCS = `/${NAMESPACE}/mcp/docs`;

  /**
   * A URI with something in every component a careless implementation would touch — a
   * scheme with `://`, a path, and a query carrying `&`, `=` and a space.
   */
  const URI = "news://feed/tech?q=a b&limit=5";

  it("§20.6 · pmcp prompts <app> calls prompts/list on the scoped endpoint and prints one row per prompt", async () => {
    const frames = gatewayHub({
      "prompts/list": {
        prompts: [
          { name: "digest", description: "the day in five lines" },
          { name: "brief", description: "" },
        ],
      },
    });
    expect(await main(["prompts", "news"])).toBe(0);
    // The SCOPED mount, and one call: §20.2 makes it the home of a prompt-heavy app,
    // and only there does a prompt keep the unprefixed name the app gave it.
    expect(frames).toEqual([{ path: SCOPED, method: "prompts/list", params: {} }]);
    // One row per prompt, each carrying its name. Padding is presentation (file header)
    // and is not asserted; the COUNT is what a renderer that dumped the whole result blob,
    // or printed only the first entry, would get wrong.
    const lines = printed();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("digest");
    expect(lines[1]).toContain("brief");
  });

  it("§20.6 · pmcp prompt <app> <name> key=value sends the arguments as params.arguments", async () => {
    const frames = gatewayHub({
      "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "tech, five lines" } }] },
    });
    expect(await main(["prompt", "news", "digest", "topic=tech", "limit=5"])).toBe(0);
    // The `key=value` grammar `pmcp call` already speaks, landing where a prompts/get
    // declares it — `params.arguments`, beside the prompt's own name, and nowhere else.
    expect(frames).toEqual([
      {
        path: SCOPED,
        method: "prompts/get",
        params: { name: "digest", arguments: { topic: "tech", limit: "5" } },
      },
    ]);
  });

  it("§20.6 · pmcp resources <app> calls resources/list · --templates calls resources/templates/list (the twin)", async () => {
    const listed = gatewayHub({ "resources/list": { resources: [{ uri: "news://feed/tech", name: "Tech" }] } });
    expect(await main(["resources", "news"])).toBe(0);
    expect(listed).toEqual([{ path: SCOPED, method: "resources/list", params: {} }]);
    // The row carries the URI, not the display name: §20.2 keys this family by `uri` and
    // never by `name`, and the URI is the word the operator hands to `pmcp read`. A
    // renderer copied from `tools` prints `.name` — here that is "Tech", which addresses
    // nothing. The fixture's uri and name differ so the two cannot be confused.
    expect(printed()).toHaveLength(1);
    expect(printed()[0]).toContain("news://feed/tech");

    // The twin: one flag, a different method — and still exactly one frame, which is what
    // a command that listed first and then templated on top would get wrong.
    const templated = gatewayHub({
      "resources/templates/list": { resourceTemplates: [{ uriTemplate: "news://feed/{id}", name: "Feed" }] },
    });
    expect(await main(["resources", "news", "--templates"])).toBe(0);
    expect(templated).toEqual([{ path: SCOPED, method: "resources/templates/list", params: {} }]);
    // The RAW template, unexpanded — it is the string §20.3's resource patterns are matched
    // against, so it is the string an operator has to be able to read.
    expect(printed()).toHaveLength(2);
    expect(printed()[1]).toContain("news://feed/{id}");

    // §10 spells `--templates` as a value-less flag, and the argv grammar has to be told:
    // a flag outside BOOLEAN_FLAGS swallows the word after it, so this spelling would read
    // `news` as the flag's value, find no app, and fail with a usage error — the exact
    // silent misreading the `pmcp app --yes delete news` case above already forbids for
    // the flags that existed before this one.
    const leading = gatewayHub({ "resources/templates/list": { resourceTemplates: [] } });
    expect(await main(["resources", "--templates", "news"])).toBe(0);
    expect(leading).toEqual([{ path: SCOPED, method: "resources/templates/list", params: {} }]);
  });

  it("§20.6 · pmcp read <app> <uri> calls resources/read with the URI verbatim — no encoding, no prefixing", async () => {
    const frames = gatewayHub({ "resources/read": { contents: [{ uri: URI, mimeType: "text/plain", text: "…" }] } });
    expect(await main(["read", "docs", URI])).toBe(0);
    // Verbatim on both counts: not percent-encoded (the URI is a param value, never part
    // of the URL), and not `<slug>_`-prefixed — §20.2 refuses the aggregated endpoint
    // precisely BECAUSE a URI cannot take a prefix and still be the URI the app knows.
    // And the mount is the SLUG's, though the URI's scheme names another app entirely.
    expect(frames).toEqual([{ path: SCOPED_DOCS, method: "resources/read", params: { uri: URI } }]);

    // The routing twin: the same URI addressed to a second slug is a second endpoint with
    // byte-identical params. Two apps may legitimately serve one URI (§20.2 —
    // `file:///notes.txt` is nobody's private namespace), and which one answers is decided
    // by the URL the CLI built, never by the URI it carries. Routing by URI is the
    // confused-deputy shape this design avoids by construction, and the CLI is the half of
    // it that builds `/<user>/mcp/<slug>`.
    const other = gatewayHub({ "resources/read": { contents: [] } });
    expect(await main(["read", "news", URI])).toBe(0);
    expect(other).toEqual([{ path: SCOPED, method: "resources/read", params: { uri: URI } }]);
  });

  it("§20.6 · pmcp read against the aggregated endpoint is refused by the CLI with the reason (resources are scoped-only)", async () => {
    const frames = gatewayHub();
    // A URI with no slug beside it addresses the aggregated mount — there is nothing else
    // it could address, since the CLI builds `/<user>/mcp/<slug>` from a slug it was given.
    // §20.2 answers `-32601` there and declares no resources capability, so this is the
    // same rule the duration flags follow above: a frame the hub would refuse is a frame
    // this CLI must never send. The reason travels with the refusal, because "missing
    // argument" would send the operator looking for a slug that does not exist.
    expect(await main(["read", URI])).toBe(2);
    expect(frames).toEqual([]);
    const refusal = [...printed(), ...errored()];
    expect(refusal.join(" ")).toMatch(/scoped/i);

    // …and that reason is not the CLI's answer to every short argv. §10's grammar is
    // `pmcp read <app> <uri>`, so a forgotten URI is an ordinary usage error naming
    // what is missing: answering it with "resources are scoped-only" would send an
    // operator who typed too little looking for an endpoint problem that is not there —
    // the mirror image of the confusion this row exists to prevent.
    const missing = gatewayHub();
    expect(await main(["read", "news"])).toBe(2);
    expect(missing).toEqual([]);
    const usage = [...printed(), ...errored()].filter((line) => !refusal.includes(line)).join(" ");
    expect(usage).toMatch(/uri/i);
    expect(usage).not.toMatch(/scoped/i);
  });
});

/**
 * §23's hub surface (2026-09-17) — the two hub tools on the virtual app's scoped mount, the
 * owner execution settings behind `pmcp`, and the owner alias lane on app create/update.
 * The oracle is the same one the §20.6 block uses — which endpoint, which method, and the
 * exact arguments built — plus what must NOT reach the wire when the argv is wrong: the
 * payloads here are JSON-only, because `timeout_ms` is a schema integer and the settings
 * flags are bounded integers, neither of which `key=value` can express without a coercion
 * (§10 forbids exactly that).
 */
describe("§23 · the hub surface: execute, search-types, settings, and app aliases", () => {
  /** One `tools/call` frame a run put on the wire, with the mount it was addressed to. */
  type HubFrame = { path: string; name: string; arguments: Record<string, unknown> };

  /**
   * A stubbed hub that records every tools/call frame WHOLE. `hubResult` answers the two
   * hub tools (a real result is the structured union §23.11 pins); the `pmcp` mount keeps
   * answering through `replyFor`, so the settings and alias rows read the same documents
   * the row-driven case does. Nothing about the CLI is mocked — argv parsing and the whoami
   * handshake run.
   */
  function recordingHub(hubResult: Record<string, unknown> = {}): HubFrame[] {
    const frames: HubFrame[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) {
        return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      }
      const message = JSON.parse(init?.body ?? "{}") as {
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const path = new URL(String(url)).pathname;
      const name = String(message.params?.name);
      frames.push({ path, name, arguments: message.params?.arguments ?? {} });
      const result = path.endsWith("/mcp/hub") ? { structuredContent: hubResult } : { structuredContent: replyFor(name) };
      return json({ jsonrpc: "2.0", id: 1, result });
    });
    return frames;
  }

  /** Whatever one run wrote to one of the two streams the shared beforeEach spies on. */
  function written(stream: { write: unknown }): string[] {
    // The spies the shared beforeEach installed: `stream.write` is that spy, whose mock
    // record holds the calls. Named once here rather than asserted at each read.
    const spy = stream.write as { mock: { calls: unknown[][] } };
    return spy.mock.calls
      .map((call) => String(call[0]))
      .join("")
      .split("\n")
      .filter((line) => line !== "");
  }
  const printed = (): string[] => written(process.stdout);
  const stdoutText = (): string => printed().join("\n");
  const stderrText = (): string => written(process.stderr).join("\n");

  /** §23.1's scoped mount for the virtual hub app — the only mount the hub tools may use. */
  const SCOPED_HUB = `/${NAMESPACE}/mcp/hub`;
  /** The builtin admin mount every `pmcp` sugar rides, settings included. */
  const SCOPED_PMCP = `/${NAMESPACE}/mcp/pmcp`;

  /** §23.11's success variant, in the exact shape `hub-contract.ts` pins. */
  const COMPLETED = {
    kind: "completed",
    value: { answer: 1 },
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    operations: { calls: 0, reads: 0 },
  };

  it("§23.1 · `pmcp hub execute` is one tools/call on the SCOPED `/<namespace>/mcp/hub` mount with the --args payload verbatim — never the aggregate `hub_execute` spelling, and `timeout_ms` stays a JSON integer", async () => {
    const frames = recordingHub(COMPLETED);
    expect(await main(["hub", "execute", "--args", '{"code":"export default 1","timeout_ms":5000}'])).toBe(0);
    expect(frames).toEqual([
      { path: SCOPED_HUB, name: "execute", arguments: { code: "export default 1", timeout_ms: 5000 } },
    ]);
    // An integer on the wire, not a digit string: a payload run through the key=value
    // grammar would send "5000", and the hub would refuse the frame with -32602.
    expect(typeof frames[0].arguments.timeout_ms).toBe("number");

    // `--json` is the tool result itself — one parseable document, wire shapes verbatim.
    const machine = recordingHub(COMPLETED);
    const before = printed().length;
    expect(await main(["hub", "execute", "--args", '{"code":"export default 1"}', "--json"])).toBe(0);
    expect(machine).toHaveLength(1);
    expect(JSON.parse(printed().slice(before).join("\n"))).toEqual({ structuredContent: COMPLETED });
  });

  it("§23.1 · `pmcp hub search-types` is tools/call `search_types` on the same mount — the canonical scoped name, never `hub_search_types`", async () => {
    const frames = recordingHub();
    expect(await main(["hub", "search-types", "--args", '{"query":"news"}'])).toBe(0);
    expect(frames).toEqual([{ path: SCOPED_HUB, name: "search_types", arguments: { query: "news" } }]);
  });

  it("§10/§23.2 · the hub payload is JSON-only: a numeric key=value word is refused before any request (never coerced into a schema integer), as are a missing --args and a payload that is not one JSON object", async () => {
    const hub = countingHub();
    expect(await main(["hub", "execute", "code=export default 1", "timeout_ms=5000"])).toBe(2);
    expect(await main(["hub", "search-types", "query=news"])).toBe(2);
    expect(await main(["hub", "execute"])).toBe(2);
    expect(await main(["hub", "execute", "--args", "{oops}"])).toBe(2);
    expect(await main(["hub", "execute", "--args", "[1]"])).toBe(2);
    expect(await main(["hub", "search-types", "--args", '"news"'])).toBe(2);
    // Counted at the FETCH, not at the tools/call frame: the whoami handshake is a request
    // too, and a payload resolved after `await context()` would reach the network first.
    expect(hub.calls, "malformed payloads must be caught before any request, whoami included").toBe(0);
    const refusal = stderrText();
    expect(refusal).toMatch(/--args/);
  });

  it("§10 · the exit code follows the tool result's own `isError` flag, exactly like `pmcp call` — the result is printed either way, and a structured union with no flag is a 0", async () => {
    // The §23.11 union is `structuredContent`; `isError` is the tool result's own failure
    // signal, and the CLI reads exactly that one bit — the same rule `pmcp call` applies to
    // every other tool, so the generic path and this one cannot disagree about one frame.
    const union = recordingHub({ kind: "runtime_error", cause: "program threw", mayHaveRun: true, transient: false });
    expect(await main(["hub", "execute", "--args", '{"code":"throw new Error()"}'])).toBe(0);
    expect(union).toHaveLength(1);

    // A result the hub DID mark is exit 1 with the result still printed (§10).
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      return json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "limit exceeded" }] } });
    });
    expect(await main(["hub", "execute", "--args", '{"code":"export default 1"}'])).toBe(1);
    expect(stdoutText()).toContain("limit exceeded");
  });

  it("§23.3 · `pmcp hub settings get` reads hub_settings_get through the builtin `pmcp` app; the human pair and the --json document both carry the wire's names and values", async () => {
    const frames = recordingHub();
    expect(await main(["hub", "settings", "get"])).toBe(0);
    expect(frames).toEqual([{ path: SCOPED_PMCP, name: "hub_settings_get", arguments: {} }]);
    expect(printed()).toEqual(["default timeout  30000 ms", "max timeout      60000 ms"]);

    const machine = recordingHub();
    const before = printed().length;
    expect(await main(["hub", "settings", "get", "--json"])).toBe(0);
    expect(machine).toHaveLength(1);
    expect(JSON.parse(printed().slice(before).join("\n"))).toEqual({
      settings: { defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000 },
    });
  });

  it("§23.3 · `pmcp hub settings set` sends the pair as hub_settings_update's two schema INTEGERS — flag order does not matter, and no digit string is ever passed through", async () => {
    const frames = recordingHub();
    expect(await main(["hub", "settings", "set", "--default-timeout-ms", "30000", "--max-timeout-ms", "60000"])).toBe(0);
    expect(frames).toEqual([
      { path: SCOPED_PMCP, name: "hub_settings_update", arguments: { default_timeout_ms: 30000, max_timeout_ms: 60000 } },
    ]);
    for (const value of Object.values(frames[0].arguments)) expect(typeof value).toBe("number");

    const reversed = recordingHub();
    expect(await main(["hub", "settings", "set", "--max-timeout-ms", "60000", "--default-timeout-ms", "30000"])).toBe(0);
    expect(reversed[0].arguments).toEqual({ default_timeout_ms: 30000, max_timeout_ms: 60000 });
  });

  it("§23.3 · every pair outside `1_000 <= default <= max <= 300_000` fails LOCALLY — exit 2, nothing on the wire — while both inclusive edges are legal and are sent", async () => {
    const hub = countingHub();
    for (const argv of [
      ["hub", "settings", "set", "--default-timeout-ms", "999", "--max-timeout-ms", "60000"],
      ["hub", "settings", "set", "--default-timeout-ms", "30000", "--max-timeout-ms", "300001"],
      ["hub", "settings", "set", "--default-timeout-ms", "60000", "--max-timeout-ms", "30000"],
      ["hub", "settings", "set", "--default-timeout-ms", "30000"],
      ["hub", "settings", "set", "--max-timeout-ms", "60000"],
      ["hub", "settings", "set", "--default-timeout-ms", "30s", "--max-timeout-ms", "60000"],
      ["hub", "settings", "set", "--default-timeout-ms", "3e4", "--max-timeout-ms", "60000"],
      ["hub", "settings", "set", "--default-timeout-ms", "-1000", "--max-timeout-ms", "60000"],
    ]) {
      expect(await main(argv), argv.join(" ")).toBe(2);
    }
    expect(hub.calls, "an out-of-bounds or mistyped pair must never become a request").toBe(0);

    const edges = recordingHub();
    expect(await main(["hub", "settings", "set", "--default-timeout-ms", "1000", "--max-timeout-ms", "300000"])).toBe(0);
    expect(edges[0].arguments).toEqual({ default_timeout_ms: 1000, max_timeout_ms: 300000 });
  });

  it("§23.1/§22.1 · an admin token is ADMITTED to the scoped hub surface — execute/search-types reach /mcp/hub and the settings op reaches `pmcp` — while the same token still cannot address a real app", async () => {
    vi.stubEnv("PMCP_TOKEN", "pmcp_adm_FAKE0000000000000000000000000000");
    const frames = recordingHub();
    expect(await main(["hub", "execute", "--args", '{"code":"export default 1"}'])).toBe(0);
    expect(await main(["hub", "search-types", "--args", '{"query":"news"}'])).toBe(0);
    expect(await main(["hub", "settings", "get"])).toBe(0);
    expect(frames.map((frame) => `${frame.path} ${frame.name}`)).toEqual([
      `${SCOPED_HUB} execute`,
      `${SCOPED_HUB} search_types`,
      `${SCOPED_PMCP} hub_settings_get`,
    ]);

    // The target-based refusal is intact: an ordinary app is closed to this token, and the
    // refusal fires after whoami resolves the token kind, before any app-facing request.
    const refused = countingHub();
    expect(await main(["call", "news", "echo"])).toBe(1);
    expect(refused.calls, "the refusal fires after whoami resolves the token kind, before any app-facing request").toBe(1);
    expect(stderrText()).toContain("a pmcp_adm_ admin token administers the hub and cannot reach a single app's tools");
  });

  it("§23.6 · `pmcp app create --typescript-aliases '<json>'` carries the object as `typescript_aliases` on app_create — and omitting the flag sends NO field at all, so an established assignment is preserved rather than cleared", async () => {
    const frames = recordingHub();
    expect(
      await main(["app", "create", "news", "--typescript-aliases", '{"service":"news","tools":{"get-news":"getNews"}}']),
    ).toBe(0);
    expect(frames.map((frame) => `${frame.path} ${frame.name}`)).toEqual([
      `${SCOPED_PMCP} app_create`,
      `${SCOPED_PMCP} token_issue`,
    ]);
    expect(frames[0].arguments).toEqual({
      slug: "news",
      kind: "tunnel",
      typescript_aliases: { service: "news", tools: { "get-news": "getNews" } },
    });

    const omitted = recordingHub();
    expect(await main(["app", "create", "news"])).toBe(0);
    expect(Object.keys(omitted[0].arguments)).toEqual(["slug", "kind"]);
  });

  it("§23.6 · `pmcp app aliases set` sends the alias object as `typescript_aliases` on app_update; the human body shows canonical identities beside the resolved TypeScript paths and the collision diagnostics, and --json is the op's own document", async () => {
    const frames = recordingHub();
    expect(await main(["app", "aliases", "set", "news", "--args", '{"service":"news"}'])).toBe(0);
    expect(frames).toEqual([
      { path: SCOPED_PMCP, name: "app_update", arguments: { slug: "news", typescript_aliases: { service: "news" } } },
    ]);
    const out = stdoutText();
    expect(out).toContain("typescript aliases set for news");
    // The resolved map: canonical identity, resolved path, and the source that won the name
    // — plus the tombstone marker, because a superseded path stays reserved (§23.6).
    expect(out).toContain("oldName");
    expect(out).toContain("superseded");
    // …and the bounded diagnostic, which is what tells an owner why a member is missing.
    expect(out).toContain("alias_conflict");
    expect(out).toContain("already held by another canonical member");

    const machine = recordingHub();
    const before = printed().length;
    expect(await main(["app", "aliases", "set", "news", "--args", '{"service":"news"}', "--json"])).toBe(0);
    expect(machine).toHaveLength(1);
    expect(JSON.parse(printed().slice(before).join("\n"))).toEqual({
      app: expect.objectContaining({ slug: "news", typescriptAliases: { service: "news" } }),
    });
  });

  it("§10/§23.6 · alias input is validated locally: a value that is not one JSON object fails before any request, on create and on update alike", async () => {
    const hub = countingHub();
    expect(await main(["app", "create", "news", "--typescript-aliases", "{oops}"])).toBe(2);
    expect(await main(["app", "create", "news", "--typescript-aliases", '["news"]'])).toBe(2);
    expect(await main(["app", "aliases", "set", "news"])).toBe(2);
    expect(await main(["app", "aliases", "set", "news", "--args", "{oops}"])).toBe(2);
    expect(await main(["app", "aliases", "set", "news", "--args", "[1]"])).toBe(2);
    expect(await main(["app", "aliases", "set", "news", "service=news"])).toBe(2);
    expect(hub.calls, "malformed alias input must be caught before any request").toBe(0);
  });
});

/**
 * §10's `describe` and `get` (2026-09-01) — the documented surface the five hidden aliases
 * above now sit behind. They front GATEWAY methods, several each, so they are outside §8's
 * parity list and carry no COMMANDS row (the table is frozen until D14 lands): the oracle
 * here is the same one the §20.6 block uses — which methods, on which endpoint, and which
 * refusals are absorbed rather than propagated.
 */
describe("§10 · describe and get, the composed exploration verbs", () => {
  type Frame = { path: string; method: string; name?: string };

  /** Every frame one run put on the wire; `answers` replies per method, `refuse` per method. */
  function hub(answers: Record<string, unknown> = {}, refuse: Record<string, number> = {}): Frame[] {
    const frames: Frame[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) {
        return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      }
      const message = JSON.parse(init?.body ?? "{}") as { method?: string; params?: { name?: string } };
      const method = String(message.method);
      frames.push({ path: new URL(String(url)).pathname, method, ...(message.params?.name === undefined ? {} : { name: message.params.name }) });
      const key = method === "tools/call" ? String(message.params?.name) : method;
      if (refuse[key] !== undefined) return json({ jsonrpc: "2.0", id: 1, error: { code: refuse[key], message: "no" } });
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: method === "tools/call" ? { structuredContent: answers[key] ?? {} } : (answers[key] ?? {}),
      });
    });
    return frames;
  }

  const CATALOG = {
    "tools/list": { tools: [{ name: "paper_fetch", description: "fetch a paper", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }] },
    "prompts/list": { prompts: [] },
    "resources/list": { resources: [] },
    "resources/templates/list": { resourceTemplates: [] },
  };

  it("§10 · `pmcp describe app/<slug>` calls all FOUR gateway list methods on the scoped endpoint, plus ONE best-effort app_list for the header — the catalog is the command, the admin read is decoration", async () => {
    const frames = hub({ ...CATALOG, app_list: { apps: [serverApp("news")] } });
    expect(await main(["describe", "app/news"])).toBe(0);
    expect(frames.filter((frame) => frame.method !== "tools/call").map((frame) => frame.method).sort()).toEqual([
      "prompts/list",
      "resources/list",
      "resources/templates/list",
      "tools/list",
    ]);
    // Every list goes to the APP's own mount; only the header read goes to `pmcp`.
    for (const frame of frames.filter((f) => f.method !== "tools/call")) expect(frame.path).toBe(`/${NAMESPACE}/mcp/news`);
    expect(frames.filter((frame) => frame.method === "tools/call").map((frame) => frame.name)).toEqual(["app_list"]);
  });

  it("§10 · an agent caller still gets the catalog: a refused app_list degrades the header, it does not fail the command — and a family answering -32601 prints as absent rather than propagating", async () => {
    const frames = hub(
      { "tools/list": CATALOG["tools/list"] },
      { app_list: -32001, "prompts/list": -32601, "resources/list": -32601, "resources/templates/list": -32601 },
    );
    expect(await main(["describe", "app/news"])).toBe(0);
    expect(frames.some((frame) => frame.name === "app_list")).toBe(true);
  });

  it("§10 · `describe app/<slug>/<item>` matches inside the catalog it already read — no per-item round trip — and a miss is `not_found` (exit 1), not malformed argv", async () => {
    const found = hub({ ...CATALOG, app_list: { apps: [serverApp("news")] } });
    expect(await main(["describe", "app/news/paper_fetch"])).toBe(0);
    // The four lists and nothing else: the item form makes no admin read at all, because
    // the header line it would decorate is not printed for a leaf.
    expect(found.filter((frame) => frame.method === "tools/call")).toEqual([]);

    const missed = hub(CATALOG);
    expect(await main(["describe", "app/news/paper"])).toBe(1);
    expect(missed.filter((frame) => frame.method === "tools/call")).toEqual([]);
  });

  it("§10 · `describe agent/<slug>` composes agent_list + token_list — the same two reads the admin family already makes, and no gateway call at all", async () => {
    const frames = hub({
      agent_list: { agents: [{ slug: "ci", name: "ci", description: "", grants: { news: ["reader:approval"] } }] },
      token_list: { tokens: [{ id: "tk_1", kind: "agent", refSlug: "ci", prefix: "pmcp_agt_x9", expiresAt: null, lastUsedAt: null }] },
    });
    expect(await main(["describe", "agent/ci"])).toBe(0);
    expect(frames.map((frame) => frame.name)).toEqual(["agent_list", "token_list"]);
  });

  it("§10 · `get` fronts exactly the two methods the retired `prompt`/`read` spellings did, chosen by the ref's FIRST segment", async () => {
    const prompted = hub({ "prompts/get": { messages: [] } });
    expect(await main(["get", "prompt/news/digest", "topic=tech"])).toBe(0);
    expect(prompted).toEqual([{ path: `/${NAMESPACE}/mcp/news`, method: "prompts/get", name: "digest" }]);

    const readIt = hub({ "resources/read": { contents: [] } });
    expect(await main(["get", "resource/news/news://feed/tech"])).toBe(0);
    expect(readIt).toEqual([{ path: `/${NAMESPACE}/mcp/news`, method: "resources/read" }]);
  });

  it("§10 · `--args '{…}'` is the payload flag now that `--json` means output format: both reach params.arguments, and `--json` on the same call changes only what stdout carries", async () => {
    const sent: { arguments?: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      const message = JSON.parse(init?.body ?? "{}") as { params?: { arguments?: unknown } };
      sent.push({ arguments: message.params?.arguments });
      return json({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    });
    expect(await main(["call", "news", "echo", "--args", '{"text":"hi","n":2}'])).toBe(0);
    expect(await main(["call", "news", "echo", "--args", '{"text":"hi","n":2}', "--json"])).toBe(0);
    expect(sent).toEqual([{ arguments: { text: "hi", n: 2 } }, { arguments: { text: "hi", n: 2 } }]);

    // A payload that is not JSON is malformed argv, caught before any REQUEST — not merely
    // before the tools/call frame. Counting fetches is what makes that a claim about the
    // network rather than about the frame: `--args` parsed after `await context()` would
    // report the whoami's failure on an unreachable hub instead of the operator's typo.
    const rejected = countingHub();
    expect(await main(["call", "news", "echo", "--args", "{text: hi}"])).toBe(2);
    expect(rejected.calls).toBe(0);
    // …and the same for `get`, whose arguments are parsed on the same seam.
    const refusedGet = countingHub();
    expect(await main(["get", "prompt/news/digest", "--args", "{oops}"])).toBe(2);
    expect(refusedGet.calls).toBe(0);
    // …and on the hidden `prompt` alias, which an agent taught the old spelling still types:
    // the two spellings must agree on the exit code, not just on the happy path.
    const refusedAlias = countingHub();
    expect(await main(["prompt", "news", "digest", "--args", "{oops}"])).toBe(2);
    expect(refusedAlias.calls).toBe(0);
  });

  it("§10 · a malformed describe ref is argv, caught before any request — `describe news` with the ref type left off gets exit 2 and the correction, never whatever the hub said about the token", async () => {
    const hub = countingHub();
    expect(await main(["describe", "news"])).toBe(2);
    expect(hub.calls).toBe(0);
  });

  it("§10 · both argument spellings at once are a refusal, not a silent precedence — the CLI never executes a different call than the one typed", async () => {
    const hub = countingHub();
    // `--args` beside a key=value word: one of them would silently lose.
    expect(await main(["call", "news", "echo", "--args", '{"a":1}', "b=2"])).toBe(2);
    // A trailing word on a resource read would be dropped: resources/read takes no arguments.
    expect(await main(["get", "resource/news/file:///x", "topic=ai"])).toBe(2);
    expect(hub.calls).toBe(0);
  });

  it("§10 · a tool result carrying `isError: true` exits 1 with the result still on stdout — the failure is the tool's, and the caller needs to read it", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      return json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "upstream said no" }] } });
    });
    const stdout = process.stdout.write as unknown as { mock: { calls: unknown[][] } };
    expect(await main(["call", "news", "echo"])).toBe(1);
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("upstream said no");
  });

  it("§10 · a hub refusal is enriched on the ERROR path only: the unknown-tool case fetches the catalog it did not pre-flight, and says which name was meant", async () => {
    const frames = hub({ "tools/list": CATALOG["tools/list"] }, { paper_fetc: -32001 });
    const stderr = process.stderr.write as unknown as { mock: { calls: unknown[][] } };
    expect(await main(["call", "news", "paper_fetc", "url=x"])).toBe(1);
    // The failing call first, THEN the enrichment read — never the other way round.
    expect(frames.map((frame) => frame.method)).toEqual(["tools/call", "tools/list"]);
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("error: not_found:");
    expect(written).toContain('did you mean "paper_fetch"?');
  });
});

/**
 * §10's output contract and error vocabulary (2026-09-01), on the seams where getting it
 * wrong is invisible to every other case here: the bytes `--json` puts on stdout when the
 * process happens to own a terminal (agent harnesses allocate a pty, so this is the common
 * case, not the exotic one), which stream a confirmation question uses, which code a local
 * file typo reports, and what a mutating verb does with a partial id.
 */
describe("§10 · the output contract and the code vocabulary", () => {
  /** Whatever the run wrote to one of the two streams the shared beforeEach spies on. */
  function textOf(stream: { write: unknown }): string {
    return (stream.write as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0])).join("");
  }
  const stdoutText = (): string => textOf(process.stdout);
  const stderrText = (): string => textOf(process.stderr);

  /**
   * Runs `body` with stdout claiming to be a terminal — the state an agent harness that
   * allocates a pty puts this process in. `NO_COLOR` is pinned empty so the runner's own
   * environment cannot decide the answer for the colour gate either way.
   */
  async function onATty(body: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    vi.stubEnv("NO_COLOR", "");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await body();
    } finally {
      if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", original);
    }
  }

  it("§10 · `--json` emits plain bytes even when stdout is a terminal: the machine stream is one document that PARSES, and the human colour gate does not reach it", async () => {
    await onATty(async () => {
      expect(await main(["ls", "--json"])).toBe(0);
      const out = stdoutText();
      expect(out).not.toContain("[");
      expect(() => JSON.parse(out) as unknown).not.toThrow();
      expect((JSON.parse(out) as { apps: unknown[] }).apps).toHaveLength(4);
    });
  });

  it("§10 · a tool result follows the same rule — `call --json` on a terminal parses, while the human rendering of the same result keeps its colour", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hello" }] } });
    });
    await onATty(async () => {
      expect(await main(["call", "news", "echo", "--json"])).toBe(0);
      const machine = stdoutText();
      expect(machine).not.toContain("[");
      expect(() => JSON.parse(machine) as unknown).not.toThrow();

      const before = stdoutText().length;
      expect(await main(["call", "news", "echo"])).toBe(0);
      // Without `--json` the same bytes are for a human, and §10 keeps colour on a TTY.
      expect(stdoutText().slice(before)).toContain("[");
    });
  });


  it("§10 · `approvals --history` is a CLIENT-side selection: `approval_list.status` is the wire enum and has no \"decided\" member, so the hub is asked for everything and the pending rows are dropped here", async () => {
    const frames: { name: string; arguments: Record<string, unknown> }[] = [];
    const approvals = [
      { id: "ap_1", status: "pending", agentSlug: "ci", appSlug: "news", tool: "echo", args: {} },
      { id: "ap_2", status: "approved", agentSlug: "ci", appSlug: "news", tool: "echo", args: {} },
    ];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      const message = JSON.parse(init?.body ?? "{}") as { params?: { name?: string; arguments?: Record<string, unknown> } };
      frames.push({ name: String(message.params?.name), arguments: message.params?.arguments ?? {} });
      return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { approvals } } });
    });

    expect(await main(["approvals", "--history", "--json"])).toBe(0);
    expect(frames).toEqual([{ name: "approval_list", arguments: {} }]);
    expect((JSON.parse(stdoutText()) as { approvals: { id: string }[] }).approvals.map((row) => row.id)).toEqual(["ap_2"]);

    // `--pending` is the one spelling the wire itself understands, and it is sent as such.
    frames.length = 0;
    expect(await main(["approvals", "--pending"])).toBe(0);
    expect(frames).toEqual([{ name: "approval_list", arguments: { status: "pending" } }]);

    // What makes "history" unsendable is the CONTRACT's enum, not this file's opinion.
    const contract = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../contracts/admin-ops.json", import.meta.url)), "utf8"),
    ) as { inputSchemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
    const status = contract.inputSchemas.approval_list?.properties?.status;
    expect(status?.enum).toContain("pending");
    expect(status?.enum).not.toContain("history");
  });

  /**
   * Mock §6's id-prefix acceptance for the mutating verbs, and the `ambiguous_id` code §10
   * freezes for the collision. Resolution happens on the ERROR path: an exact id costs one
   * call, and only a refusal buys the list.
   */
  describe("§10 · id prefixes on the mutating verbs", () => {
    /** A hub where `token_revoke` accepts only the ids in `known`, and `token_list` lists them. */
    function tokenHub(known: string[]): { name: string; arguments: Record<string, unknown> }[] {
      const frames: { name: string; arguments: Record<string, unknown> }[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
        if (String(url).endsWith("/api/whoami")) return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
        const message = JSON.parse(init?.body ?? "{}") as { params?: { name?: string; arguments?: Record<string, unknown> } };
        const name = String(message.params?.name);
        const args = message.params?.arguments ?? {};
        frames.push({ name, arguments: args });
        if (name === "token_list") return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { tokens: known.map((id) => ({ id })) } } });
        if (!known.includes(String(args.id))) {
          return json({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: `no token ${String(args.id)}` } });
        }
        return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: {} } });
      });
      return frames;
    }

    it("an exact id costs exactly one call — the prefix machinery never runs on the happy path", async () => {
      const frames = tokenHub(["tok_abc123"]);
      expect(await main(["token", "revoke", "tok_abc123"])).toBe(0);
      expect(frames.map((frame) => frame.name)).toEqual(["token_revoke"]);
    });

    it("an unambiguous prefix is resolved after the refusal and the verb is re-issued with the full id", async () => {
      const frames = tokenHub(["tok_abc123"]);
      expect(await main(["token", "revoke", "tok_abc"])).toBe(0);
      expect(frames.map((frame) => frame.name)).toEqual(["token_revoke", "token_list", "token_revoke"]);
      expect(frames[2].arguments).toEqual({ id: "tok_abc123" });
      expect(stdoutText()).toContain("tok_abc123");
    });

    it("a prefix matching several ids is `ambiguous_id`, and nothing is revoked", async () => {
      const frames = tokenHub(["tok_ab1", "tok_ab2"]);
      expect(await main(["token", "revoke", "tok_ab"])).toBe(1);
      expect(frames.map((frame) => frame.name)).toEqual(["token_revoke", "token_list"]);
      const written = stderrText();
      expect(written).toContain("error: ambiguous_id:");
      expect(written).toContain("tok_ab1");
      expect(written).toContain("tok_ab2");
    });

    it("a prefix matching nothing keeps the hub's own refusal — the CLI never invents a not-found the hub did not send", async () => {
      const frames = tokenHub(["tok_zzz"]);
      expect(await main(["token", "revoke", "tok_ab"])).toBe(1);
      expect(frames.map((frame) => frame.name)).toEqual(["token_revoke", "token_list"]);
      expect(stderrText()).toContain("no token tok_ab");
    });
  });
});

/**
 * §10's help and version contract (2026-09-01). The rule with teeth is the ORDER: help is
 * answered before any context resolution, so it works logged out, offline, and with a
 * `--profile` that does not exist. Before the commander rewrite `pmcp tools --help` made a
 * network `whoami` first and then failed with `missing app` — the shape this block
 * forbids by counting requests, not by reading text.
 */
describe("§10 · help and --version, answered before anything is resolved", () => {
  /** Counts every request a run made — the oracle is zero, whatever the stub would answer. */
  function countingHub(): { calls: number } {
    const counter = { calls: 0 };
    vi.stubGlobal("fetch", async () => {
      counter.calls += 1;
      return json({ principal: "user:owner", namespace: NAMESPACE });
    });
    return counter;
  }

  for (const argv of [[], ["help"], ["--help"], ["-h"], ["--version"], ["tools", "--help"], ["describe", "-h"], ["token"], ["hub"], ["hub", "settings"], ["app", "aliases"]]) {
    it(`§10 · \`pmcp ${argv.join(" ")}\` prints and exits 0 without reaching the hub`, async () => {
      const hub = countingHub();
      expect(await main(argv)).toBe(0);
      expect(hub.calls, "help must not resolve a context").toBe(0);
      const stdout = process.stdout.write as unknown as { mock: { calls: unknown[][] } };
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).not.toBe("");
    });
  }

  it("§10 · a `--profile` that names nothing still gets help — the flag is consumed, never resolved, before the answer", async () => {
    const hub = countingHub();
    expect(await main(["--profile", "does-not-exist", "--help"])).toBe(0);
    expect(hub.calls).toBe(0);
  });

  it("§10 · `--version` prints one line, and that line is cli/package.json's version — the published bin must not disagree with the package that shipped it", async () => {
    countingHub();
    expect(await main(["--version"])).toBe(0);
    const stdout = process.stdout.write as unknown as { mock: { calls: unknown[][] } };
    const printed = stdout.mock.calls.map((call) => String(call[0])).join("").trim().split("\n");
    expect(printed).toHaveLength(1);
    // main.ts's VERSION is a literal because the dist build has no JSON reader, so the two
    // spellings can drift silently — and did: a release bumped package.json while the bin
    // kept printing the previous version. The manifest is the source of truth here.
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(printed[0], "`pmcp --version` versus cli/package.json").toBe(manifest.version);
  });

  it("§10 · every COMMANDS row is discoverable in the top-level overview — the help literal is a separate surface from the argv table, and nothing else notices when a new family misses it", async () => {
    countingHub();
    expect(await main(["help"])).toBe(0);
    const stdout = process.stdout.write as unknown as { mock: { calls: unknown[][] } };
    const overview = stdout.mock.calls.map((call) => String(call[0])).join("");
    // Word-wise rather than by the literal row name: the overview groups subcommands
    // (`token issue|list|revoke`, `connection revoke <id>`) so no row appears verbatim.
    // What has to hold is that every word a caller would type is somewhere in the text —
    // which is exactly what fails when a whole family is added and never announced.
    // Boundaries include `[`/`]` so `audit [--export jsonl]` counts as announcing both
    // of its words.
    const announced = (word: string) => new RegExp(`(^|[\\s|·\\[])${word}([\\s|·\\]]|$)`, "m").test(overview);
    // The five deliberately hidden aliases, whose documented forms ARE announced:
    // `describe app/<slug>` covers tools/prompts/resources, and `get prompt|resource/…`
    // covers prompt/read (main.ts's command builder marks exactly these five hidden). A
    // sixth hidden command added later fails here until it is named in this list, which is
    // the right direction: the omission becomes a deliberate act rather than an oversight.
    const hiddenAliases = ["tools", "prompts", "resources", "prompt", "read"];
    const missing = COMMANDS.filter(
      (command) => !hiddenAliases.includes(command.name) && command.name.split(" ").some((word) => !announced(word)),
    ).map((command) => command.name);
    expect(missing, "COMMANDS rows absent from the overview help").toEqual([]);
  });
});
