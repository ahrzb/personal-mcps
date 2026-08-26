/**
 * cli/test/commands.test.ts — the witness behind `COMMANDS[].ops`.
 *
 * §4's parity direction D asks "does every CLI subcommand front an §8 admin op", and
 * `server/test/worker/contracts.test.ts` answers it from `cli/src/commands.ts`'s table.
 * That table is DATA main.ts only prints, so nothing there ties a row's `ops` to what the
 * dispatcher actually calls: drop `token_issue` from the `service create` row, or point
 * `service()` at a different op, and both direction-D cases stay green. Direction C has no
 * such gap — it runs the real planner and reads the steps it emitted — and this file closes
 * the asymmetry: it runs the real `main(argv)` for every row and asserts the admin ops the
 * dispatcher REACHED FOR equal the row's. The table stops being its own oracle.
 *
 * The recording seam is the wire, not an injected function: main.ts speaks the hub's
 * stateless POST endpoint with `fetch`, so a stubbed `fetch` sees exactly the tools/call
 * frames a real hub would, op name and all. Nothing about the CLI is mocked — argv parsing,
 * the whoami handshake, the confirmation prompts, the planner and its step ORDER all run.
 *
 * Scope, deliberately narrow: which ops a subcommand calls. What each op DOES is the
 * server's (server/test/worker/admin.test.ts), what a plan contains is plan.test.ts's, and
 * whether an op exists at all is direction D's other half in the parity suite. No case here
 * asserts a rendered line: the output is presentation and would make this file a golden-file
 * test of padding.
 *
 * Project: `cli` — plain Node, parallel. Every case owns its own stub and its own temp
 * file; nothing here reaches the network, the real config file, or the user's terminal.
 */

// deps: cli/src/main.ts (main — the real dispatcher) · cli/src/commands.ts (COMMANDS, the
//   table under test) · node:fs + node:os (the one YAML file `diff`/`apply` read) · a
//   stubbed global fetch (the recording seam) · vitest

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/commands";
import { main } from "../src/main";

/** Obviously fake, and never a `pmcp_svc_` value — main.ts refuses that kind outright. */
const TOKEN = "pmcp_sa_FAKE0000000000000000000000000000";
const ORIGIN = "https://hub.invalid";
const NAMESPACE = "owner";

/**
 * The namespace `diff` and `apply` are driven against, chosen — like direction C's own
 * fixture — to provoke every step kind the planner has: a server-only service and account
 * (deletes), a file-only pair (creates), a changed field (update), and both archive
 * transitions, plus a grant. `apply` is the only front for service_update and grant_set,
 * so a thinner file would leave two of its ten ops unwitnessed.
 */
const CONFIG = `services:
  fresh:
  keep:
    name: Renamed
  parked:
    archived: true
  revived:
service_accounts:
  agent:
    grants:
      keep: [reader]
`;

const serverService = (slug: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
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
    case "service_list":
      return {
        services: [
          serverService("gone"),
          serverService("keep"),
          serverService("parked"),
          serverService("revived", { archived: true }),
        ],
      };
    case "account_list":
      return { accounts: [{ slug: "stale", name: "stale", description: "", grants: {} }] };
    case "service_create":
      return { service: { slug: "news" } };
    case "service_get":
      // `connect` refuses anything but an `auth: oauth` proxied service before printing.
      return { service: { slug: "notion", kind: "proxy", auth: "oauth" } };
    case "token_issue":
      return { id: "tok_FAKE", token: "pmcp_svc_FAKE0000000000000000000000000000" };
    case "audit_query":
      return { rows: [], total: 0 };
    default:
      return {};
  }
}

/** Every admin op name the stubbed hub saw, in call order — the whole oracle of this file. */
let recorded: string[] = [];
let configPath = "";
let workdir = "";

beforeEach(() => {
  recorded = [];
  workdir = mkdtempSync(join(tmpdir(), "pmcp-cli-"));
  configPath = join(workdir, "mcps.yaml");
  writeFileSync(configPath, CONFIG);
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
    // Only the builtin `pmcp` endpoint carries admin ops; `tools`/`call` reach a service's
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
  rmSync(workdir, { recursive: true, force: true });
});

function json(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
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
  "service create": ["service", "create", "news"],
  "service archive": ["service", "archive", "news"],
  "service unarchive": ["service", "unarchive", "news"],
  "service delete": ["service", "delete", "news", "--yes"],
  "service disconnect": ["service", "disconnect", "notion"],
  "service set-auth": ["service", "set-auth", "notion", "--header", "X-Api-Key: k"],
  "account list": ["account", "list"],
  "account create": ["account", "create", "bot"],
  "account delete": ["account", "delete", "bot", "--yes"],
  approvals: ["approvals", "--pending"],
  approve: ["approve", "ap_FAKE"],
  reject: ["reject", "ap_FAKE"],
  "token issue": ["token", "issue", "--account", "bot"],
  "token list": ["token", "list"],
  "token revoke": ["token", "revoke", "tok_FAKE"],
  audit: ["audit", "--service", "news"],
  "audit --export jsonl": ["audit", "--export", "jsonl"],
  connect: ["connect", "notion"],
  diff: ["diff", "-f", "PATH"],
  apply: ["apply", "-f", "PATH", "--yes"],
};

/** The auth family reaches no op by definition (§8's first pinned exception). */
const driven = COMMANDS.filter((command) => command.exception !== "auth");

describe("§4 direction D · the dispatcher answers to the command table", () => {
  it("§4 · every non-auth row of COMMANDS has argv here — a subcommand added to the table without a way to run it would leave its `ops` unwitnessed", () => {
    expect(driven.map((command) => command.name).sort()).toEqual(Object.keys(ARGV).sort());
  });

  for (const command of driven) {
    it(`§4 · \`pmcp ${command.name}\` calls exactly the ops its row claims`, async () => {
      const argv = (ARGV[command.name] ?? []).map((word) => (word === "PATH" ? configPath : word));
      const code = await main(argv);
      expect(code, `pmcp ${command.name} exited non-zero`).toBe(0);
      // Both directions at once: an op the dispatcher calls and the row omits, and an op
      // the row claims and the dispatcher never makes.
      expect([...new Set(recorded)].sort()).toEqual([...command.ops].sort());
    });
  }

  it("§9 · `apply` executes the planner's steps in plan order — deletes before creates before updates before grants — so the ops its row claims are also the sequence a namespace actually receives", async () => {
    await main(["apply", "-f", configPath, "--yes"]);
    expect(recorded).toEqual([
      "service_list",
      "account_list",
      "service_delete",
      "account_delete",
      "service_create",
      "account_create",
      "service_update",
      "service_archive",
      "service_unarchive",
      "grant_set",
    ]);
  });
});

describe("§10 · the argv grammar, where a misreading is silent", () => {
  it("§10 · `-f` selects the file `apply` acts on: the short spelling both interface comments document reaches the planner, and never the `mcps.yaml` default in the working directory", async () => {
    // The default file does not exist here, so a `-f` that silently fell through to it
    // would fail to read rather than plan.
    const code = await main(["diff", "-f", configPath]);
    expect(code).toBe(0);
    expect(recorded).toEqual(["service_list", "account_list"]);
  });

  it("§10 · a boolean flag never swallows the word after it: `pmcp service --yes delete news` deletes, rather than reading `delete` as the value of `--yes` and failing with a usage error", async () => {
    const code = await main(["service", "--yes", "delete", "news"]);
    expect(code).toBe(0);
    expect(recorded).toEqual(["service_delete"]);
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

  it("§10 · a bare epoch and an ISO-8601 instant are `--since`'s other two spellings, and a value that is none of the three fails LOCALLY: exit 1 with NOTHING on the wire, never a frame the hub is left to refuse", async () => {
    const accepted = recordingHub();
    expect(await main(["audit", "--since", "1750000000000", "--until", "2026-08-26T00:00:00Z"])).toBe(0);
    expect(accepted.map((frame) => frame.arguments)).toEqual([
      { since: 1_750_000_000_000, until: Date.parse("2026-08-26T00:00:00Z") },
    ]);

    const rejected = recordingHub();
    expect(await main(["audit", "--since", "7 days"])).toBe(1);
    expect(rejected).toEqual([]);
  });

  it("§10 · a refusal the hub DOES send is reported rather than absorbed, and a refused page is not retried: `audit --export jsonl` is the one command that re-queries, and it stops at the first error", async () => {
    const frames = recordingHub({ code: INVALID_PARAMS, message: '"tool" has the wrong type' });
    expect(await main(["audit", "--tool", "echo", "--export", "jsonl"])).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it("§10 · `pmcp token issue --expires 90d` reaches the wire as the SECONDS integer token_issue declares — a LIFETIME, not an instant, and a different unit from audit's — while `never` and a bare count are the other two members of that union", async () => {
    const relative = recordingHub();
    expect(await main(["token", "issue", "--account", "bot", "--expires", "90d"])).toBe(0);
    expect(relative.map((frame) => frame.arguments)).toEqual([
      { kind: "service_account", slug: "bot", expires_in: 90 * 24 * 60 * 60 },
    ]);

    const never = recordingHub();
    expect(await main(["token", "issue", "--account", "bot", "--expires", "never"])).toBe(0);
    expect(never.map((frame) => frame.arguments)).toEqual([
      { kind: "service_account", slug: "bot", expires_in: "never" },
    ]);

    const bare = recordingHub();
    expect(await main(["token", "issue", "--service", "news", "--expires", "3600"])).toBe(0);
    expect(bare.map((frame) => frame.arguments)).toEqual([
      { kind: "service", slug: "news", expires_in: 3600 },
    ]);

    // Same local refusal as `--since`: an untranslatable lifetime never becomes a token.
    const rejected = recordingHub();
    expect(await main(["token", "issue", "--account", "bot", "--expires", "90 days"])).toBe(1);
    expect(rejected).toEqual([]);

    expect(declared("token_issue", "expires_in")).toMatchObject({
      oneOf: [{ type: "integer" }, { const: "never" }],
    });
  });

  it("§7 · `pmcp call` partitions its words by SHAPE: the aggregated `<slug>_<tool>` name composes with key=value arguments, and a word that is neither is an error rather than a silently dropped argument", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) return json({ principal: "user:owner", namespace: NAMESPACE });
      sent.push(JSON.parse(init?.body ?? "{}"));
      return json({ jsonrpc: "2.0", id: 1, result: {} });
    });
    expect(await main(["call", "news_echo", "text=hi"])).toBe(0);
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
    ]);
    // The service is `news` and the tool `echo` — never a service called `news_echo`.
    expect(await main(["call", "news", "echo", "hello"])).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
