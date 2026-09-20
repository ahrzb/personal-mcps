// hub-surface.test.ts — §23.1's cutover, pinned at the wire: what the aggregate endpoint
// and scoped `/mcp/hub` ARE now, and what every other scoped endpoint still is.
//
// WHAT THIS SUITE PINS that no other file can. The old aggregate application catalog is
// gone: `/mcp` and `/mcp/hub` are one virtual surface serving exactly two tools and the
// hub's own declaration resources, an unknown or malformed name is the existing
// indistinguishable -32001, and every family the hub does not advertise is -32601. The
// caller-visible SNAPSHOT behind `search_types`, the declaration reader and `execute` is
// built per request from the caller's own grants (an agent sees only what its grants reach,
// an admin sees its `pmcp` subset and no real app, a zero-grant agent gets pure TypeScript),
// and every declaration URI resolves through decode-once/re-encode with exact snapshot
// membership — so an encoded `/` never becomes path structure and a member the caller cannot
// see is not found. `execute` validates closed arguments against the owner's settings before
// the executor runs, and hands the injected seam an admitted request whose deadline,
// settings and snapshot are the gateway's. The two exported dispatch seams are exercised
// directly because §23.9's QuickJS host functions call them: the pinned-app-id refusal, the
// unpinned twin, a revoked credential's reauthorization, and the exactly-one-audit-row rule.
//
// HOW EXECUTION IS FAKED: the executor is the seam hub-backend.ts declares for this purpose
// (`installHubExecutor`), and this file asserts only about the REQUEST the gateway admitted
// and the RESULT it relays. The real Wasm runtime and asynchronous host bridge are proved in
// hub-quickjs.test.ts.
//
// Project: `worker` — real D1, real proxied apps through the real fake upstream, no sockets.
// Every case seeds its own namespace, so per-file isolation plus a fresh
// owner keeps audit counts exact.
//
// deps: harness/seed · harness/fake-upstream · harness/deadlines · ../../src/index
//   (default.fetch) · ../../src/gateway (the two dispatch seams) · ../../src/hub-backend
//   (installHubExecutor, the request/result types) · ../../src/hub-quickjs
//   (createHubExecutor, restored after every fake) · ../../src/hub-contract ·
//   ../../src/capabilities · ../../src/audit (query) · ../../src/identity · ../../src/upstream

import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import { HUB_CAPABILITIES } from "../../src/capabilities";
import { dispatchResourceRead, dispatchTool, mcpMessage } from "../../src/gateway";
import type { JsonRpcResponse, Tool } from "../../src/gateway";
import { installHubExecutor } from "../../src/hub-backend";
import type { HubExecutionRequest } from "../../src/hub-backend";
import { createHubExecutor } from "../../src/hub-quickjs";
import { HUB_DECLARATION_TEMPLATES, HUB_DECLARATION_URIS, HUB_TOOLS } from "../../src/hub-contract";
import type { HubExecutionResult, HubSearchResult } from "../../src/hub-contract";
import { issueAdminToken, resolveCaller, revokeToken } from "../../src/identity";
import type { AuthenticatedCaller } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { Registry } from "../../src/registry";
import { setHeaders } from "../../src/upstream";
import { registerOverride, upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { withDeadlines } from "../harness/deadlines";

/** The worker's bindings, as the composition root declares them. */
const bindings = env as unknown as Env;
const ORIGIN = bindings.PUBLIC_ORIGIN;

/** The slugs and names this file seeds per case. */
const SLUG = "notion";
const UNGRANTED_SLUG = "linear";
const BLOCKED_SLUG = "blocked";
const TUNNEL_SLUG = "quiet";
const AGENT = "agent";
const ZERO_AGENT = "zero";
const ROLE = "reader";
const TOOL = "search";
const TOOL_PAGES = "search_pages";
const INDEX_TOOL = "index_stats";
const PROMPT = "digest";
const RESOURCE = "demo://items/a/b";
const TEMPLATE = "demo://items/{id}";
const UPSTREAM_CREDENTIAL = { Authorization: "Bearer FAKE0000-upstream-static-token" };

/** A string that must never appear in an audit row, a log line, or a result: the source and
 *  the query the hub is forbidden to record (§23.12). */
const SENTINEL = "FAKE0000-hub-sentinel";

/** The upstream's answer to a tools/call, so a relay is distinguishable from a refusal. */
const ANSWER = { content: [{ type: "text", text: "FAKE0000-upstream-answer" }] };

/** The hub's own revision, as the contract suite reads it off `server/discover`. */
const PROTOCOL_VERSION = "2026-07-28";

/** The composition root's OWN executor — what `index.ts` installs at import — so a case
 *  that swaps in a fake restores the real plane rather than leaving the isolate unwired.
 *  Constructing it starts nothing: the pinned Wasm module is loaded only by an execution. */
const realExecutor = createHubExecutor();

// ── the world ─────────────────────────────────────────────────────────────────────────

/** One upstream scenario, parameterized by what it serves. */
function scenario(id: string, tools: Tool[], mode: UpstreamScenario["mode"] = { kind: "ok" }): UpstreamScenario {
  return {
    id,
    mode,
    tools,
    result: ANSWER,
    prompts: [{ name: PROMPT, description: "the daily digest" }],
    resources: [{ uri: RESOURCE, name: "the item", description: "a search result carrier" }],
    resourceTemplates: [{ uriTemplate: TEMPLATE, name: "item", description: "an item lookup" }],
  };
}

/** What the granted app serves: the ranking fixture, whose names, paths and descriptions
 *  each land in a different tier for the query "search". */
const GRANTED_TOOLS: Tool[] = [
  {
    name: TOOL,
    description: "Search the workspace pages",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  { name: TOOL_PAGES, description: "Search across every page", inputSchema: { type: "object" } },
  { name: INDEX_TOOL, description: "Statistics for the search index", inputSchema: { type: "object" } },
];

/** The ungranted app serves something ELSE, so a leaked catalog is visible as a name no
 *  caller could have derived, not merely as a count. */
const UNGRANTED_TOOLS: Tool[] = [
  { name: "get_profile", description: "Read a profile", inputSchema: { type: "object" } },
];

type World = {
  ns: SeededNamespace;
  /** A signed-in owner's bearer (the session family). */
  owner: string;
  /** The granted agent's key. */
  agent: string;
  /** A zero-grant agent's key. */
  zero: string;
  aggregate: string;
  hub: string;
  scoped: string;
};

/**
 * One namespace: a granted proxied app with tools and resources, an ungranted proxied
 * sibling, a failing sibling (made hanging only by the deadline case), a never-connected
 * tunnel, a granted agent, and a zero-grant agent.
 */
async function seedWorld(hangBlocked = false): Promise<World> {
  const granted = scenario(uniqueSlug("up"), GRANTED_TOOLS);
  const ungranted = scenario(uniqueSlug("up"), UNGRANTED_TOOLS);
  const blocked = scenario(
    uniqueSlug("up"),
    [{ name: "sync_state", inputSchema: { type: "object" } }],
    hangBlocked ? { kind: "hang" } : { kind: "status", status: 503 },
  );
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: SLUG,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(granted),
        upstreamAuthMode: "headers",
        capabilities: ["tools", "resources"],
        roles: { [ROLE]: { tools: [TOOL], prompts: [PROMPT] } },
      },
      { slug: UNGRANTED_SLUG, kind: "proxy", upstreamUrl: upstreamUrlFor(ungranted), upstreamAuthMode: "headers" },
      { slug: BLOCKED_SLUG, kind: "proxy", upstreamUrl: upstreamUrlFor(blocked), upstreamAuthMode: "headers" },
      { slug: TUNNEL_SLUG, kind: "tunnel" },
    ],
    agents: [
      { slug: AGENT, grants: { [SLUG]: [{ role: ROLE, mode: "allow" }] }, tokens: [{ as: "agent" }] },
      { slug: ZERO_AGENT, tokens: [{ as: "zero" }] },
    ],
  });
  const registry = new Registry(env.DB);
  for (const slug of [SLUG, UNGRANTED_SLUG, BLOCKED_SLUG]) {
    const app = await registry.getApp(ns.owner.userId, slug);
    if (app === null) throw new Error(`seedWorld: the seeded app "${slug}" vanished`);
    await setHeaders(app, UPSTREAM_CREDENTIAL);
  }
  const session = await seedOwnerSession(ns.owner);
  return {
    ns,
    owner: session.token,
    agent: ns.tokens.agent.token,
    zero: ns.tokens.zero.token,
    aggregate: `${ORIGIN}/${ns.owner.username}/mcp`,
    hub: `${ORIGIN}/${ns.owner.username}/mcp/hub`,
    scoped: `${ORIGIN}/${ns.owner.username}/mcp/${SLUG}`,
  };
}

// ── the wire helpers ──────────────────────────────────────────────────────────────────

const message = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
});

/** One JSON-RPC POST, with the text kept beside the parse: §23.12's hygiene claims are
 *  about BYTES reaching a consumer or a row, and a parsed object cannot testify to those. */
async function rpc(
  url: string,
  bearer: string,
  body: unknown,
): Promise<{ status: number; body: JsonRpcResponse; text: string }> {
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    bindings,
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as JsonRpcResponse, text };
}

/** One raw MCP POST for an expected HTTP-level refusal whose body is deliberately not JSON. */
async function rpcStatus(url: string, bearer: string, body: unknown): Promise<number> {
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    bindings,
  );
  await response.body?.cancel();
  return response.status;
}

/** One `tools/call` through the wire. */
async function call(url: string, bearer: string, name: string, args: unknown): Promise<{ body: JsonRpcResponse; text: string }> {
  const answer = await rpc(url, bearer, message("tools/call", { name, arguments: args }));
  return { body: answer.body, text: answer.text };
}

/** One named field of a JSON value that may or may not be an object — the whole of the
 *  narrowing these helpers need, so a result half the hub did not build reads as absent
 *  rather than as a crash. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The `structuredContent` half of a tool result, which is where the hub's schemas live. */
function structuredOf(answer: JsonRpcResponse): unknown {
  return fieldOf(answer.result, "structuredContent");
}

/** The object items of one listing result (`tools`, `resources`, `prompts`, …). */
function itemsOf(answer: JsonRpcResponse, key: string): Record<string, unknown>[] {
  const items = fieldOf(answer.result, key);
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/** The tool names a `tools/list` answer served, in order. */
function toolNames(answer: JsonRpcResponse): string[] {
  return itemsOf(answer, "tools").flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : []));
}

/** One keyed string list out of a listing result (`uri`, `uriTemplate`, `name`, …). */
function stringsOf(answer: JsonRpcResponse, key: string, field: string): string[] {
  return itemsOf(answer, key).flatMap((item) => (typeof item[field] === "string" ? [item[field]] : []));
}

function capabilitiesOf(answer: JsonRpcResponse): unknown {
  return fieldOf(answer.result, "capabilities");
}

/** The single declaration block a `resources/read` answer carried. */
function declarationOf(answer: JsonRpcResponse): { uri: string; mimeType?: string; text: string } {
  const blocks = itemsOf(answer, "contents");
  expect(blocks, "the read served exactly one content block").toHaveLength(1);
  const block = blocks[0];
  return {
    uri: typeof block.uri === "string" ? block.uri : "",
    mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
    text: typeof block.text === "string" ? block.text : "",
  };
}

/** A pending promise and its resolver for observing lifetime boundaries. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A `completed` result for the fake executor: the union's allow twin. */
function completed(value: unknown = { ok: true }): HubExecutionResult {
  return {
    kind: "completed",
    value,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    operations: { calls: 0, reads: 0 },
  };
}

/** The audit rows one owner wrote for one event, newest first. */
async function rowsFor(ownerId: string, filters: { event: string; app?: string }): Promise<AuditRow[]> {
  const { rows } = await query(env.DB, ownerId, { ...filters, limit: 50 });
  return rows;
}

/** A caller resolved through the REAL door, for the two dispatch seams the bridge calls. */
async function callerOf(world: World, bearer: string): Promise<AuthenticatedCaller> {
  return resolveCaller(
    new Request(`${ORIGIN}/${world.ns.owner.username}/mcp`, { headers: { Authorization: `Bearer ${bearer}` } }),
  );
}

// ── the cases ────────────────────────────────────────────────────────────────────────

describe("§23.1 — one virtual surface, on both endpoint shapes", () => {
  it("the aggregate endpoint and /mcp/hub serve exactly the two hub tools, the fixed capability shape and the hub's declarations, and refuse every unserved family", async () => {
    const world = await seedWorld();
    const shapes = [
      { url: world.aggregate, names: HUB_TOOLS.map((tool) => tool.aggregateName) },
      { url: world.hub, names: HUB_TOOLS.map((tool) => tool.name) },
    ] as const;

    for (const shape of shapes) {
      const listed = await rpc(shape.url, world.agent, message("tools/list"));
      expect(toolNames(listed.body), shape.url).toEqual([...shape.names]);
      // The two spellings differ in the NAME alone: descriptions and schemas are the same
      // frozen constants on both shapes (§23.1).
      const descriptors = itemsOf(listed.body, "tools");
      expect(descriptors.map((tool) => tool.description), shape.url).toEqual(
        HUB_TOOLS.map((tool) => tool.description),
      );
      expect(descriptors.map((tool) => tool.inputSchema), shape.url).toEqual(
        HUB_TOOLS.map((tool) => tool.inputSchema),
      );

      const handshake = await rpc(
        shape.url,
        world.agent,
        message("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        }),
      );
      expect(capabilitiesOf(handshake.body), shape.url).toEqual(HUB_CAPABILITIES);

      const resources = await rpc(shape.url, world.agent, message("resources/list"));
      expect(stringsOf(resources.body, "resources", "uri"), shape.url).toEqual(
        HUB_DECLARATION_URIS.map((resource) => resource.uri),
      );
      const templates = await rpc(shape.url, world.agent, message("resources/templates/list"));
      expect(stringsOf(templates.body, "resourceTemplates", "uriTemplate"), shape.url).toEqual(
        HUB_DECLARATION_TEMPLATES.map((template) => template.uriTemplate),
      );

      // The hub advertises no prompts, completions or subscription, and serves none of
      // them: every one of these is the SAME -32601, on both shapes (§23.1).
      const unserved: readonly (readonly [string, Record<string, unknown> | undefined])[] = [
        ["prompts/list", undefined],
        ["prompts/get", { name: PROMPT }],
        ["completion/complete", { ref: { type: "ref/prompt", name: PROMPT }, argument: { name: "x", value: "y" } }],
        ["resources/subscribe", { uri: RESOURCE }],
        ["resources/unsubscribe", { uri: RESOURCE }],
      ];
      for (const [method, params] of unserved) {
        const answer = await rpc(shape.url, world.agent, message(method, params));
        expect(answer.body.error?.code, `${shape.url} ${method}`).toBe(-32601);
      }
    }
  });

  it("an unknown, malformed or wrong-shape tool name is the same -32001 an ungranted tool earns — indistinguishable bytes, and no row for a name that is no tool", async () => {
    const world = await seedWorld();
    const refused: string[] = [];
    const names: readonly (readonly [string, string])[] = [
      [world.aggregate, "hub_ghost"],
      [world.aggregate, "execute"],
      [world.aggregate, "notion_search"],
      [world.hub, "ghost"],
      [world.hub, "hub_execute"],
    ];
    for (const [url, name] of names) {
      const answer = await call(url, world.agent, name, {});
      expect(answer.body.error?.code, `${url} ${name}`).toBe(-32001);
      refused.push(answer.text);
    }
    // The twin that makes the claim about indistinguishability rather than about codes: an
    // UNGRANTED tool inside a granted app, on the scoped shape, is the same bytes.
    const ungranted = await call(world.scoped, world.agent, INDEX_TOOL, {});
    expect(ungranted.body.error?.code).toBe(-32001);
    expect(new Set([...refused, ungranted.text]).size, refused.join(" | ")).toBe(1);

    // A hub name that is no hub tool was never a hub tool call: there is no canonical name
    // to record, so only the scoped refusal left a row.
    expect(await rowsFor(world.ns.owner.userId, { event: "tools/call", app: "hub" })).toHaveLength(0);
    expect(await rowsFor(world.ns.owner.userId, { event: "tools/call", app: SLUG })).toHaveLength(1);
  });

  it("every other scoped endpoint is unchanged: the app's own unprefixed names, its prompts, and its tool calls", async () => {
    const world = await seedWorld();
    const listed = await rpc(world.scoped, world.agent, message("tools/list"));
    expect(toolNames(listed.body)).toEqual([TOOL]);
    const prompts = await rpc(world.scoped, world.agent, message("prompts/list"));
    expect(stringsOf(prompts.body, "prompts", "name")).toEqual([PROMPT]);
  });
});

describe("§23.5 — the caller-visible snapshot behind search, declarations and execute", () => {
  it("search_types ranks exact → prefix → substring → description, keeps canonical identities beside TypeScript paths, honours limit/surface, and starts no sandbox", async () => {
    const world = await seedWorld();
    const calls: HubExecutionRequest[] = [];
    installHubExecutor(async (request) => {
      calls.push(request);
      return completed();
    });
    try {
      const answer = await call(world.aggregate, world.owner, "hub_search_types", { query: "search" });
      expect(answer.body.error, JSON.stringify(answer.body.error)).toBeUndefined();
      const result = structuredOf(answer.body) as HubSearchResult;
      // One entry per tier, in the pinned tie order: the tool kind before the hub tool at
      // the same tier, and the tool kind before the resource at the description tier.
      expect(result.matches.map((match) => match.path)).toEqual([
        "mcp.notion.search",
        "mcp.notion.searchPages",
        "mcp.hub.searchTypes",
        "mcp.notion.indexStats",
        "mcp.notion.resources.read",
      ]);
      expect(result.incomplete).toBe(false);
      expect(result.matches[0]).toMatchObject({
        kind: "tool",
        surface: "program",
        service: SLUG,
        subject: TOOL,
        uri: `pmcp://hub/types/tools/${SLUG}/${TOOL}.d.ts`,
      });
      expect(result.matches[0].signature).toContain(`${TOOL}(`);
      expect(result.matches[0].signature).toContain("Promise<");
      expect(result.matches[2]).toMatchObject({
        kind: "hubTool",
        service: "hub",
        subject: "search_types",
        uri: "pmcp://hub/types/program.d.ts",
      });
      // The description tier really is the description: the index tool's NAME carries no
      // query text, only its description does.
      expect(result.matches[3].subject).toBe(INDEX_TOOL);

      const limited = structuredOf(
        (await call(world.hub, world.owner, "search_types", { query: "search", limit: 1 })).body,
      ) as HubSearchResult;
      expect(limited.matches).toHaveLength(1);
      expect(limited.incomplete).toBe(true);

      const client = structuredOf(
        (await call(world.hub, world.owner, "search_types", { query: "execute", surface: "client" })).body,
      ) as HubSearchResult;
      expect(client.matches.every((match) => match.surface === "client")).toBe(true);
      expect(client.matches.some((match) => match.path === "mcp.hub.execute")).toBe(true);

      expect(calls, "search never reaches the execution plane").toHaveLength(0);
    } finally {
      installHubExecutor(realExecutor);
    }
  });

  it("an agent's snapshot is exactly what its grants reach: the allowed member appears, the ungranted app and the denied member never do", async () => {
    const world = await seedWorld();
    const result = structuredOf((await call(world.hub, world.agent, "search_types", { query: "s" })).body) as HubSearchResult;
    const services = new Set(result.matches.map((match) => match.service));
    expect(services.has(SLUG)).toBe(true);
    expect(services.has(UNGRANTED_SLUG)).toBe(false);
    expect(services.has(BLOCKED_SLUG)).toBe(false);
    expect(services.has("pmcp"), "an agent never receives the builtin").toBe(false);

    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain(`mcp.${SLUG}.${TOOL}`);
    // The role declares the tools family alone, and one pattern: nothing else of the app —
    // its other tools or its resources — is in this caller's catalog.
    expect(paths).not.toContain(`mcp.${SLUG}.indexStats`);
    expect(result.matches.some((match) => match.kind === "resource" || match.kind === "resourceTemplate")).toBe(false);
  });

  it("a zero-grant agent gets pure TypeScript: an empty catalog, the hub's own declarations, and a program the execution plane receives", async () => {
    const world = await seedWorld();
    const result = structuredOf((await call(world.hub, world.zero, "search_types", { query: SLUG })).body) as HubSearchResult;
    expect(result.matches).toEqual([]);

    const program = await rpc(world.hub, world.zero, message("resources/read", { uri: "pmcp://hub/types/program.d.ts" }));
    const text = declarationOf(program.body).text;
    expect(text).toContain("declare const mcp: HubMcp");
    expect(text).toContain("HubSearchTypesInput");
    expect(text).not.toContain("HubExecuteInput");
    expect(text).not.toContain(SLUG);

    const calls: HubExecutionRequest[] = [];
    installHubExecutor(async (request) => {
      calls.push(request);
      return completed("hello");
    });
    try {
      const executed = await call(world.hub, world.zero, "execute", { code: "return 1" });
      expect(executed.body.error, JSON.stringify(executed.body.error)).toBeUndefined();
      expect(structuredOf(executed.body)).toEqual(completed("hello"));
      expect(calls).toHaveLength(1);
      expect(calls[0].snapshot.services).toEqual([]);
      expect(calls[0].caller.principal.kind).toBe("agent");
    } finally {
      installHubExecutor(realExecutor);
    }
  });

  it("an admin token is refused on the aggregate and admitted on /mcp/hub, where its catalog is its own pmcp subset and no real app", async () => {
    const world = await seedWorld();
    const admin = await issueAdminToken(world.ns.owner.userId, 3_600);

    const aggregate = await rpc(world.aggregate, admin.token, message("tools/list"));
    expect(aggregate.body.error?.code).toBe(-32001);
    const hub = await rpc(world.hub, admin.token, message("tools/list"));
    expect(toolNames(hub.body)).toEqual(HUB_TOOLS.map((tool) => tool.name));
    // A real app stays out of reach; the builtin is the one app this credential opens.
    expect(await rpcStatus(world.scoped, admin.token, message("tools/list"))).toBe(404);

    const program = await rpc(world.hub, admin.token, message("resources/read", { uri: "pmcp://hub/types/program.d.ts" }));
    const text = declarationOf(program.body).text;
    expect(text).toContain("readonly pmcp");
    expect(text).toContain("hubSettingsGet");
    expect(text).not.toContain("adminTokenIssue");
    expect(text).not.toContain("approvalDecide");
    expect(text).not.toContain(SLUG);
  });

  it("a family that cannot be read is omitted with a bounded diagnostic naming the service, and the request still answers", async () => {
    const world = await seedWorld(true);
    const result = await withDeadlines(env, { hubCatalogDeadlineMs: 300 }, async () =>
      structuredOf((await call(world.aggregate, world.owner, "hub_search_types", { query: "search" })).body) as HubSearchResult,
    );
    expect(result.diagnostics).toContain(`the tools catalog of service "${BLOCKED_SLUG}" could not be read`);
    // The omission is the slow service's alone: the hub's own locally-synthesized match is
    // still there, so one hung upstream never costs the whole catalog.
    expect(result.matches.some((match) => match.service === "hub")).toBe(true);
  });

  it("a catalog over the entry cap truncates search with incomplete: true and refuses execute before launch, while the scoped listing still serves the app whole", async () => {
    const id = uniqueSlug("up");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: SLUG, kind: "proxy", upstreamUrl: upstreamUrlFor(scenario(id, [])), upstreamAuthMode: "headers" }],
      agents: [{ slug: AGENT, grants: { [SLUG]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "agent" }] }],
    });
    const registry = new Registry(env.DB);
    const app = await registry.getApp(ns.owner.userId, SLUG);
    if (app === null) throw new Error("the seeded app vanished");
    await setHeaders(app, UPSTREAM_CREDENTIAL);
    const session = await seedOwnerSession(ns.owner);
    const aggregate = `${ORIGIN}/${ns.owner.username}/mcp`;
    const scoped = `${aggregate}/${SLUG}`;

    // 257 tools: one past §23.11's entry cap, registered OUT of the URL because the
    // scenario itself would not fit a request line.
    const many: Tool[] = Array.from({ length: 257 }, (_, index) => ({
      name: `tool_${String(index).padStart(3, "0")}`,
      inputSchema: { type: "object" },
    }));
    await registerOverride(id, { tools: many });

    const searched = structuredOf((await call(aggregate, session.token, "hub_search_types", { query: "tool_0" })).body) as HubSearchResult;
    expect(searched.incomplete).toBe(true);
    expect(searched.matches).toEqual([]);
    expect(searched.diagnostics?.some((line) => line.includes("entries or"))).toBe(true);

    const calls: HubExecutionRequest[] = [];
    installHubExecutor(async (request) => {
      calls.push(request);
      return completed();
    });
    try {
      const refused = structuredOf((await call(aggregate, session.token, "hub_execute", { code: "return 1" })).body);
      expect(refused).toMatchObject({ kind: "limit_exceeded", limit: "catalog", transient: false, mayHaveRun: false });
      expect(calls, "nothing launches over an overflowing catalog").toHaveLength(0);
    } finally {
      installHubExecutor(realExecutor);
    }

    // The twin: the scoped listing is the app's own surface and is not capped.
    const listed = await rpc(scoped, session.token, message("tools/list"));
    expect(toolNames(listed.body)).toHaveLength(257);
  });
});

describe("§23.2 — the declaration reader", () => {
  it("serves the two fixed declarations and a search result's direct URI, with decode-once/re-encode placeholders that never become path structure", async () => {
    const world = await seedWorld();
    const program = await rpc(world.aggregate, world.owner, message("resources/read", { uri: "pmcp://hub/types/program.d.ts" }));
    const programBlock = declarationOf(program.body);
    expect(programBlock.mimeType).toBe("text/typescript");
    expect(programBlock.text).toContain("declare const mcp: HubMcp");
    // The program surface deliberately has no recursive execution helper (§23.7).
    expect(programBlock.text).not.toContain("HubExecuteInput");

    const client = declarationOf(
      (await rpc(world.hub, world.owner, message("resources/read", { uri: "pmcp://hub/types/client.d.ts" }))).body,
    );
    expect(client.text).toContain("HubExecuteInput");
    expect(client.text).toContain("HubSearchTypesInput");

    const tool = declarationOf(
      (await rpc(world.hub, world.owner, message("resources/read", { uri: `pmcp://hub/types/tools/${SLUG}/${TOOL}.d.ts` }))).body,
    );
    expect(tool.text).toContain(`export declare const ${TOOL}: {`);
    expect(tool.text).toContain("readonly inputSchema:");
    expect(tool.text).toContain("readonly outputSchema:");

    // The app's raw URI carries slashes; its declaration URI carries them ENCODED, and the
    // reader resolves that one segment back to the record without ever splitting it.
    const encoded = `pmcp://hub/types/resources/${SLUG}/${encodeURIComponent(RESOURCE)}.d.ts`;
    const resource = declarationOf((await rpc(world.hub, world.owner, message("resources/read", { uri: encoded }))).body);
    expect(resource.text).toContain(JSON.stringify(RESOURCE));

    const template = declarationOf(
      (
        await rpc(world.hub, world.owner, message("resources/read", {
          uri: `pmcp://hub/types/resource-templates/${SLUG}/${encodeURIComponent(TEMPLATE)}.d.ts`,
        }))
      ).body,
    );
    expect(template.text).toContain(JSON.stringify(TEMPLATE));

    // Every refusal below is the same -32001: a URI the hub does not publish, a
    // non-canonical encoding, a raw slash that would become path structure, or an unknown
    // service.
    const refused = [
      `pmcp://hub/types/resources/${SLUG}/${RESOURCE}.d.ts`,
      `pmcp://hub/types/resources/${SLUG}/${encodeURIComponent(RESOURCE).replace(/%2F/g, "%2f")}.d.ts`,
      "pmcp://hub/types/services/ghost.d.ts",
      "pmcp://hub/types/tools/ghost/x.d.ts",
      `pmcp://hub/types/tools/${SLUG}/${TOOL}%2Fextra.d.ts`,
      "pmcp://elsewhere/thing.d.ts",
    ];
    for (const uri of refused) {
      const answer = await rpc(world.hub, world.owner, message("resources/read", { uri }));
      expect(answer.body.error?.code, uri).toBe(-32001);
    }
  });

  it("audits only the bounded URI, never the declaration text, and the member an agent cannot see is not found", async () => {
    const world = await seedWorld();
    const uri = `pmcp://hub/types/tools/${SLUG}/${TOOL}.d.ts`;
    const read = await rpc(world.hub, world.agent, message("resources/read", { uri }));
    expect(read.body.error, JSON.stringify(read.body.error)).toBeUndefined();
    const rows = await rowsFor(world.ns.owner.userId, { event: "resources/read", app: "hub" });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe(uri);
    expect(rows[0].result).toBeUndefined();
    expect(rows[0].args).toBeUndefined();

    // The role allows `search` alone: the sibling tool's declaration is not in the
    // snapshot, so the read is the same -32001 as an unknown service.
    const denied = await rpc(
      world.hub,
      world.agent,
      message("resources/read", { uri: `pmcp://hub/types/tools/${SLUG}/${INDEX_TOOL}.d.ts` }),
    );
    expect(denied.body.error?.code).toBe(-32001);
  });
});

describe("§23.2/§23.10 — execute's admission", () => {
  it("returns the owner's timeout ceiling with an over-max -32602 and refuses every admission violation before any plane runs", async () => {
    const world = await seedWorld();
    const calls: HubExecutionRequest[] = [];
    installHubExecutor(async (request) => {
      calls.push(request);
      return completed();
    });
    try {
      const bad: unknown[] = [
        undefined,
        {},
        { code: 42 },
        { code: SENTINEL, extra: 1 },
        { code: SENTINEL, timeout_ms: 999 },
        { code: SENTINEL, timeout_ms: 5_000.5 },
        { code: "x".repeat(65_537) },
      ];
      for (const args of bad) {
        const answer = await call(world.aggregate, world.owner, "hub_execute", args);
        expect(answer.body.error?.code, JSON.stringify(args)?.slice(0, 40)).toBe(-32602);
        expect(answer.body.error?.data, "only an over-max timeout carries its discoverable ceiling").toBeUndefined();
      }
      const overMax = await call(world.aggregate, world.owner, "hub_execute", {
        code: SENTINEL,
        timeout_ms: 60_000,
      });
      expect(overMax.body.error).toEqual({
        code: -32602,
        message: "invalid params",
        data: { field: "timeout_ms", max: 30_000 },
      });
      expect(calls, "no plane ran for a refused request").toHaveLength(0);

      const started = Date.now();
      const admitted = await call(world.aggregate, world.owner, "hub_execute", { code: SENTINEL, timeout_ms: 5_000 });
      expect(admitted.body.error, JSON.stringify(admitted.body.error)).toBeUndefined();
      expect(structuredOf(admitted.body)).toEqual(completed());
      expect(calls).toHaveLength(1);
      const request = calls[0];
      expect(request.code).toBe(SENTINEL);
      expect(request.timeoutMs).toBe(5_000);
      expect(request.deadlineAt).toBeGreaterThanOrEqual(started + 5_000);
      expect(request.deadlineAt).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(request.settings).toEqual({ defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000 });
      expect(request.snapshot.services.map((service) => service.service)).toContain(SLUG);
      expect(request.lifecycle.signal).toBeInstanceOf(AbortSignal);

      // The default is the owner's stored pair, not the schema's: no `timeout_ms` selects
      // the pinned 30 s.
      await call(world.hub, world.owner, "execute", { code: "return 1" });
      expect(calls[1].timeoutMs).toBe(30_000);

      // The outer row is metadata-only, and the source never reaches the ledger.
      const rows = await rowsFor(world.ns.owner.userId, { event: "tools/call", app: "hub" });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((row) => row.tool === "execute")).toBe(true);
      expect(rows.every((row) => row.args === undefined && row.result === undefined)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    } finally {
      installHubExecutor(realExecutor);
    }
  });

  it("keeps the request lifetime open through execution and its outer audit after disconnect", async () => {
    const world = await seedWorld();
    const caller = await callerOf(world, world.owner);
    const execution = deferred<HubExecutionResult>();
    const entered = deferred<void>();
    const lifetimes: Promise<unknown>[] = [];
    installHubExecutor(async () => {
      entered.resolve();
      return execution.promise;
    });
    try {
      const controller = new AbortController();
      const response = mcpMessage(
        new Request(world.hub, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message("tools/call", {
            name: "execute",
            arguments: { code: "return 1" },
          })),
          signal: controller.signal,
        }),
        bindings,
        caller,
        "hub",
        async () => caller.principal,
        { waitUntil: (work) => lifetimes.push(work) },
      );
      await entered.promise;
      expect(lifetimes).toHaveLength(1);
      let lifetimeSettled = false;
      void lifetimes[0]?.then(() => { lifetimeSettled = true; });
      controller.abort();
      await Promise.resolve();
      expect(lifetimeSettled).toBe(false);

      execution.resolve(completed("after-disconnect"));
      const body = await (await response).json() as JsonRpcResponse;
      expect(structuredOf(body)).toEqual(completed("after-disconnect"));
      await lifetimes[0];
      expect(lifetimeSettled).toBe(true);
      const rows = await rowsFor(world.ns.owner.userId, { event: "tools/call", app: "hub" });
      expect(rows[0]).toMatchObject({ tool: "execute", outcome: "ok" });
    } finally {
      installHubExecutor(realExecutor);
    }
  });

  it("an unwired execution plane is an honest -32000, never a fabricated result", async () => {
    const world = await seedWorld();
    // The composition root installs the real plane at import; this case unwires it
    // deliberately, because the seam's absent-executor branch is what it pins — and the
    // unwired refusal must be a refusal, never a fabricated `completed`.
    installHubExecutor(null);
    try {
      const answer = await call(world.hub, world.owner, "execute", { code: "return 1" });
      expect(answer.body.error?.code).toBe(-32000);
      expect(structuredOf(answer.body)).toBeUndefined();
    } finally {
      installHubExecutor(realExecutor);
    }
  });
});

describe("§23.9 — the dispatch seams the QuickJS host bridge calls", () => {
  it("refuses a snapshot-pinned app id that no longer matches with -32001, while the unpinned twin reaches the availability check", async () => {
    const world = await seedWorld();
    const caller = await callerOf(world, world.owner);
    const pinned = uniqueSlug("app-id"); // no app has this id

    await expect(
      dispatchTool(bindings, {
        caller,
        slug: TUNNEL_SLUG,
        tool: TOOL,
        args: {},
        expectAppId: pinned,
      }),
    ).rejects.toMatchObject({ code: -32001 });
    await expect(
      dispatchResourceRead(bindings, {
        caller,
        slug: TUNNEL_SLUG,
        uri: RESOURCE,
        expectAppId: pinned,
      }),
    ).rejects.toMatchObject({ code: -32001 });

    // The twin: without the pin, the same call reaches the availability probe — a
    // never-connected tunnel is -32000, which is what proves the pin is what refused.
    await expect(
      dispatchTool(bindings, { caller, slug: TUNNEL_SLUG, tool: TOOL, args: {} }),
    ).rejects.toMatchObject({ code: -32000 });

    // Exactly one row per dispatch, refusal or not (§15).
    const rows = await rowsFor(world.ns.owner.userId, { event: "tools/call", app: TUNNEL_SLUG });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["-32000", "-32001"]);
  });

  it("re-authorizes a bridge dispatch from the credential reference: a revoked credential refuses -32001 before anything resolves", async () => {
    const world = await seedWorld();
    const caller = await callerOf(world, world.agent);
    // The door resolved this credential, and then it was revoked: the reference is what a
    // mid-execution operation re-checks.
    await revokeToken(world.ns.owner.userId, world.ns.tokens.agent.id);

    await expect(
      dispatchTool(bindings, {
        caller,
        slug: SLUG,
        tool: TOOL,
        args: {},
        reauthorizeCredential: true,
      }),
    ).rejects.toMatchObject({ code: -32001 });
    await expect(
      dispatchResourceRead(bindings, {
        caller,
        slug: SLUG,
        uri: RESOURCE,
        reauthorizeCredential: true,
      }),
    ).rejects.toMatchObject({ code: -32001 });

    // The allow twin, on a live credential: the same dispatch reaches the app.
    const live = await callerOf(world, world.owner);
    const allowed = await dispatchTool(bindings, {
      caller: live,
      slug: SLUG,
      tool: TOOL,
      args: {},
      reauthorizeCredential: true,
    });
    expect(allowed.error, JSON.stringify(allowed.error)).toBeUndefined();

    const toolRows = await rowsFor(world.ns.owner.userId, { event: "tools/call", app: SLUG });
    expect(toolRows.map((row) => row.outcome).sort()).toEqual(["-32001", "ok"]);
    const readRows = await rowsFor(world.ns.owner.userId, { event: "resources/read", app: SLUG });
    expect(readRows.map((row) => row.outcome)).toEqual(["-32001"]);
  });

  it("keeps the pinned order and exactly one row per call on the ordinary scoped route", async () => {
    const world = await seedWorld();
    const granted = await call(world.scoped, world.agent, TOOL, { q: "x" });
    expect(granted.body.error, JSON.stringify(granted.body.error)).toBeUndefined();
    expect(granted.body.result).toEqual(ANSWER);

    const denied = await call(world.scoped, world.agent, INDEX_TOOL, {});
    expect(denied.body.error?.code).toBe(-32001);

    const rows = await rowsFor(world.ns.owner.userId, { event: "tools/call", app: SLUG });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["-32001", "ok"]);
    // A refusal carries no bodies, whatever the app's log_bodies says (§15).
    expect(rows.every((row) => row.args === undefined && row.result === undefined)).toBe(true);
  });
});

/** This file fakes the one executor seam hub-backend.ts declares. Every case restores the
 * composition root's real QuickJS executor; this final restoration covers a case that
 * threw before reaching its own `finally`. */
afterAll(() => installHubExecutor(realExecutor));
