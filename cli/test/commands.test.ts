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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
