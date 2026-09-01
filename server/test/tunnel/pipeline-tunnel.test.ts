/**
 * tunnel/pipeline-tunnel.test.ts — §16's core integration test: a consumer POSTs into
 * the real worker entry, a fake app answers over a real WebSocket through the real
 * AppConnection DO, and everything in between is production code. Four green unit
 * tests compose into a wrong pipeline; only the pipeline exhibits the pipeline's bugs
 * (strategy §1), so this file is where both endpoint shapes, role filtering, `_meta`
 * hygiene and the audit chokepoint are pinned END TO END rather than per function.
 *
 * WHAT THIS SUITE PINS. That both endpoint shapes are ONE pipeline — the same call
 * reaches the same tool with the same params through `/<user>/mcp` and
 * `/<user>/mcp/<slug>`, prefixed and unprefixed; role filtering bounding both the
 * listing and the call; `_meta` hygiene as the APP observes it (consumer-supplied
 * `hub/*` keys stripped then the hub's own set — overwrite, never merge; the consumer's
 * clientCapabilities mirrored, `{}` when absent; everything else untouched); that a
 * app's `notifications/tools/list_changed` reaches the consumer's next listing, and
 * that a re-list drawing nothing leaves the previous one standing; that
 * JSON-RPC ids never cross the socket in either direction; that `writeOnly` is stripped
 * from served outputSchemas while inputSchemas keep theirs; the 30 s call deadline
 * mapping to -32000; and the audit chokepoint — every tools/call resolves into exactly
 * one awaited row carrying hub-measured duration_ms, while tools/list produces none.
 *
 * WHAT IT DOES NOT PIN. The check ORDER table (filter → archived → approval →
 * availability) is worker/order.table.test.ts's, socket-free and exhaustive there; this
 * file assumes it. The approval gate itself is approval-e2e.test.ts's. Redaction
 * *grammar* is unit/redact.test.ts's, and the audit body TABLE is
 * worker/hygiene.test.ts's — here the only body claim is the direction one: what the
 * consumer receives is never redacted, while the row written for that same call is.
 *
 * Durable vs incidental (§7): the `hub/*` reservation, strip-then-set, the prefix
 * split, id non-crossing, and "a resolved call is audited exactly once" are durable.
 * Incidental and unasserted: audit `detail` layout, the ttlMs/cacheScope values, listing
 * order, and every timeout literal — the deadline case reads limits.CALL_TIMEOUT_MS
 * (shrunk for the run) and pins THAT a deadline is enforced, never how long it is.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): a live socket
 * and a real DO on every case (strategy §2). The consumer side is driven through
 * `exports.default.fetch` from `cloudflare:workers` — SELF is deprecated — so the
 * request crosses the same router, auth and handler wiring production uses.
 *
 * Isolation and ordering, load-bearing: smoke.test.ts green first, then protocol and
 * lifecycle, which own the handshake and the close codes this file merely relies on.
 * D1 migrations are applied once by the project setup file (read Node-side with
 * readD1Migrations, applied with applyD1Migrations — idempotent); with --no-isolate the
 * database is shared across this project's files, so every case seeds its own owner,
 * app, agent and tokens, and asserts on rows it created rather than on counts.
 * Nothing sleeps: the never-answering app reaches the deadline against a shrunk
 * constant, and the fake app's release gates make ordering explicit.
 */

// deps: harness/seed · harness/fake-app · harness/tunnel-do (backendCtx, untilStatus, untilCataloged) · cloudflare:workers (exports.default.fetch) · cloudflare:test (env) · src/gateway (JsonRpcRequest, JsonRpcResponse, Tool) · src/tunnel (tunnelBackend) · src/audit (query) · src/registry (Registry, buildToolFilter) · src/limits (CALL_TIMEOUT_MS) · src/errors (CODES)

import { abortAllDurableObjects, env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import { CODES } from "../../src/errors";
import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import { CALL_TIMEOUT_MS } from "../../src/limits";
import { REDACTED, Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { tunnelBackend } from "../../src/tunnel";
import { connectFakeApp, tick, waitFor } from "../harness/fake-app";
import type { FakeApp, ToolBehavior } from "../harness/fake-app";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededApp } from "../harness/seed";
import { backendCtx, untilCataloged, untilStatus } from "../harness/tunnel-do";

/**
 * The consumer request each hygiene row sends: an ordinary tools/call whose
 * `params._meta` is the row's `sent` map, plus — on an MRTR follow-up leg — the row's
 * `siblings`. Spelled from {@link JsonRpcRequest} so the table describes the message the
 * gateway actually parses.
 *
 * `inputResponses` and `requestState` are params-level SIBLINGS of `arguments`, never
 * `_meta` keys (§7: "the args binding is `params.arguments` only — `inputResponses` and
 * `requestState` on a retry are excluded"; approvals.check's header and
 * worker/approvals.test.ts spell the same two legs). Naming them here is what lets a row
 * pin their passthrough at the position they actually ride, which matters because
 * gateway.prepareForward REBUILDS `params` around the scrubbed `_meta` — a rebuild that
 * dropped the siblings would leave every `_meta`-only row green.
 */
export type ConsumerCall = JsonRpcRequest & {
  method: "tools/call";
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    inputResponses?: unknown;
    requestState?: unknown;
    _meta?: Record<string, unknown>;
  };
};

/**
 * One row of the `_meta` hygiene table — the §7 reservation as data, always observed AT
 * THE APP (the fake app records the frame it received) rather than by
 * inspecting the gateway, because "a consumer cannot inject `hub/*`" is a claim about
 * what an app sees.
 *
 * Three columns, because §7 makes exactly three promises about a forwarded `_meta`:
 * `absent` — keys the app must not see at all (every consumer-supplied `hub/*`
 * copy); `passthrough` — keys that must arrive byte-identical to what the consumer sent,
 * AT THE POSITION they were sent (`_meta` keys like progressToken and vendor keys, and
 * the params-level `siblings` below); `written` — keys the hub sets itself, whose values
 * are the hub's own resolution (hub/principal, hub/roles, the mirrored
 * clientCapabilities) and never the consumer's.
 */
export type MetaHygieneRow = {
  /** Test title, in the doc's convention: "§7 · <what this row pins>". */
  name: string;
  /**
   * Who calls. Owners forward roles `["all"]` literally down a path that hardcodes it;
   * agents forward what they hold, resolved from the grant table — which is why the
   * built-in wildcard needs a caller of its own (`agent_all`): §7's "never
   * expanded into declared role names" is a claim about grant RESOLUTION, and the owner's
   * hardcoded `["all"]` cannot witness it.
   */
  caller: "owner" | "agent" | "agent_all";
  sent: Record<string, unknown>;
  /**
   * Params-level keys sent beside `arguments` — MRTR's `inputResponses` / `requestState`
   * and nothing else in v1. Absent on every row but the MRTR leg; see {@link ConsumerCall}
   * for why the position rather than the key name is the load-bearing part.
   */
  siblings?: Record<string, unknown>;
  absent: readonly string[];
  passthrough: readonly string[];
  written: Record<string, unknown>;
};

/**
 * The `_meta` hygiene table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. Every stripping row
 * carries its passthrough twin in the same row (§9 rule 2): a suite that only proved
 * deletion is satisfied by forwarding no `_meta` at all.
 */
export const metaHygieneRows: readonly MetaHygieneRow[] = [
  // The fixture these rows are written against, named once: one tunneled app `notes`
  // declaring `reader: ["search"]`, one agent with the FIXED slug `claude`
  // holding `reader` in allow mode, a second agent with the FIXED slug `wildcard`
  // holding the built-in `all` in allow mode, and the namespace owner. Every row is the
  // same `tools/call` for `search` on the scoped endpoint — the message differs only in
  // its `_meta` and, on the MRTR row, its params-level siblings.
  //
  // Three conventions, so no row repeats them:
  // · `written` lists only the keys whose expected value is STABLE across runs. `agent:claude`
  //   is stable because the agent slug is fixture-chosen; `user:<username>` is not (the
  //   tunnel project mints a unique username per case, seed.uniqueSlug), so the owner row
  //   pins its `hub/roles` and its capabilities and leaves the principal VALUE to the
  //   agent rows, where the same code path writes it.
  // · `io.modelcontextprotocol/protocolVersion` is hub-written on every forwarded frame
  //   (§6's stateless wire) but appears in no row's `written` map: its value is the wire
  //   version literal, which contracts.test.ts pins as a fixture and protocol.test.ts's
  //   case 4 observes on the socket. This table is about the three keys whose value is a
  //   RESOLUTION — principal, roles, mirrored capabilities — not about the protocol header.
  // · A forged `hub/*` key the hub also writes lands in `written` (overwrite), never in
  //   `absent`; `absent` is for consumer-supplied `hub/*` keys the hub writes nothing for,
  //   which is what makes the strip a PREFIX rule rather than a known-key allowlist.

  // §7: `hub/principal` and `hub/roles` are the hub's resolution, and a consumer's copy is
  // stripped before they are stamped — strip-then-set, never merge. The forged roles here
  // name a role the agent does not hold and the wildcard it may never grant itself; the
  // forged principal names another agent. What arrives is what the hub resolved.
  {
    name: "§7 · a forged hub/roles and hub/principal never reach the app: the hub's own resolution arrives in their place, and an unknown hub/* key arrives not at all",
    caller: "agent",
    sent: {
      "hub/roles": ["admin", "all"],
      "hub/principal": "agent:root",
      "hub/impersonate": "user:ahrzb",
      progressToken: "p-1",
    },
    absent: ["hub/impersonate"],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "agent:claude",
      "hub/roles": ["reader"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
  // §7's identity forwarding: "the built-in wildcard is forwarded literally as `"all"`,
  // never expanded into declared role names; owners get `["all"]`". The row also carries
  // the second half of the prefix rule — `hub/app` is a name the hub writes nothing
  // for, so it is dropped rather than passed through as a vendor key would be.
  {
    name: "§7 · an owner's _meta is scrubbed the same way: hub/roles arrives as the literal [\"all\"], never expanded into the app's declared roles",
    caller: "owner",
    sent: {
      "hub/roles": ["reader"],
      "hub/app": "other",
      "vendor.example/trace": "t-1",
    },
    absent: ["hub/app"],
    passthrough: ["vendor.example/trace"],
    written: {
      "hub/roles": ["all"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
  // §6: `io.modelcontextprotocol/clientCapabilities` is "**mirrored from the consumer's
  // request** — the hub asserts the calling client's capabilities, not its own". Mirrored,
  // so it is hub-written even though its value is the consumer's: the hub may not invent
  // capabilities the caller never declared, and may not drop the ones it did.
  {
    name: "§6 · the consumer's declared clientCapabilities are mirrored onto the forwarded request verbatim — the hub asserts the caller's capabilities, not its own",
    caller: "agent",
    sent: {
      "io.modelcontextprotocol/clientCapabilities": { elicitation: {}, sampling: {} },
      progressToken: 7,
    },
    absent: [],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "agent:claude",
      "hub/roles": ["reader"],
      "io.modelcontextprotocol/clientCapabilities": { elicitation: {}, sampling: {} },
    },
  },
  // §7's MRTR rule: `inputResponses` and `requestState` "pass through the hub verbatim and
  // never enter any persisted body". Verbatim is this file's half; never-persisted is
  // approval-e2e's. They ride as params-level SIBLINGS of `arguments` (§7's binding
  // sentence, approvals.check's header, worker/approvals.test.ts's leg2) — never as `_meta`
  // keys, which is why they sit in `siblings` here: the gateway rebuilds `params` around the
  // scrubbed `_meta`, so the siblings are exactly what a rebuild can silently drop. The
  // forged roles ride along in `_meta` so the row also shows that a follow-up leg gets no
  // weaker scrubbing than a first one.
  {
    name: "§7 · an MRTR follow-up leg's inputResponses and requestState arrive verbatim beside arguments, while its forged hub/roles is overwritten like any other",
    caller: "agent",
    sent: {
      "hub/roles": ["admin"],
    },
    siblings: {
      inputResponses: [{ name: "otp", value: "FAKE0000" }],
      requestState: "rs-1",
    },
    absent: [],
    passthrough: ["inputResponses", "requestState"],
    written: {
      "hub/principal": "agent:claude",
      "hub/roles": ["reader"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
  // §7's identity forwarding again, on the one path the owner row cannot reach: an AGENT
  // granted the built-in `all` resolves its roles through the grant table rather than the
  // owner's hardcoded `["all"]`, and the wildcard must still arrive LITERAL — never expanded
  // into the app's declared role names (here `["reader"]`, which is what an expanding
  // implementation would send while every other row stayed green). unit/filter.test.ts
  // delegates exactly this claim to this file ("that `roleNames` reaches an app as
  // `hub/roles` with `all` still literal"), and worker/upstream-proxy.test.ts pins the
  // proxied twin (`x-pmcp-roles: all` for `agent:<agent>`), so this row is the tunneled half of
  // one rule rather than a second opinion about the owner's.
  {
    name: "§7 · an agent granted the built-in `all` forwards hub/roles as the literal [\"all\"] — granted wildcards are never expanded into the app's declared roles",
    caller: "agent_all",
    sent: {
      progressToken: "p-2",
    },
    absent: [],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "agent:wildcard",
      "hub/roles": ["all"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
];

/**
 * Runs one hygiene row: seeds the caller, sends the row's ConsumerCall through
 * `exports.default.fetch`, and asserts the three columns against the frame the fake
 * app recorded — plus, always, that the response the consumer receives bears the
 * consumer's own id.
 */
export async function runMetaHygieneCase(row: MetaHygieneRow): Promise<void> {
  // deps: harness/seed · harness/fake-app · cloudflare:workers exports.default.fetch
  const fixture = await seedFixture();
  const answer = await rpc(fixture, await credentialFor(fixture, row.caller), APP_SLUG, {
    jsonrpc: "2.0",
    id: CONSUMER_ID,
    method: "tools/call",
    params: { name: TOOL, arguments: { q: "hygiene" }, ...(row.siblings ?? {}), _meta: row.sent },
  });
  expect(answer.body.error, `"${row.name}" was refused before it reached the app`).toBeUndefined();
  expect(
    await waitFor(() => fixture.fake.callCount(TOOL) > 0),
    `"${row.name}" never reached the app`,
  ).toBe(true);

  // Observed AT THE APP, always: "a consumer cannot inject hub/*" is a claim about what
  // an app sees, and the frame — not the invocation projection — is where the
  // params-level siblings ride (ConsumerCall's doc).
  const params = servedParams(fixture.fake);
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  for (const key of row.absent) {
    expect(Object.keys(meta), `"${row.name}": ${key} reached the app`).not.toContain(key);
  }
  for (const key of row.passthrough) {
    const rode = key in row.sent;
    expect(rode ? meta[key] : params[key], `"${row.name}": ${key} did not arrive verbatim`).toEqual(
      rode ? row.sent[key] : (row.siblings ?? {})[key],
    );
  }
  for (const [key, value] of Object.entries(row.written)) {
    expect(meta[key], `"${row.name}": the hub's own ${key} is not what arrived`).toEqual(value);
  }
  // Always, on every row: the consumer's own id comes back (ids never cross, §6).
  expect(answer.body.id).toBe(CONSUMER_ID);
}

// ── the fixture every case in this file is built from ─────────────────────────────────

const ORIGIN = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;

/** The fixture named once in metaHygieneRows' preamble, spelled here for every case. */
const APP_SLUG = "notes";
const OTHER_SLUG = "vault";
const AGENT = "claude";
const WILDCARD_AGENT = "wildcard";
const UNDECLARED_AGENT = "ghost";
const TOOL = "search";
const UNGRANTED_TOOL = "purge";

/** The consumer's own JSON-RPC id — asserted back on every answer, and hunted on the wire
 *  (case 12: ids never cross). A number, so a wire id (a UUID string) can never equal it. */
const CONSUMER_ID = 4242;

/** Planted in the app's answer, so "the consumer's relayed result is never masked" and
 *  "the row written for that same call is" are two readings of one value (case 20). */
const RESULT_SECRET = "FAKE0000-relayed-result-secret";

/** The granted tool: `writeOnly` in BOTH directions, which is what makes case 6 (serving
 *  strips outputs, keeps inputs) and case 20 (the row is masked, the wire is not) readable
 *  off one catalog entry. */
const SEARCH_TOOL: Tool = {
  name: TOOL,
  description: "the granted tool every row calls",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" }, token: { type: "string", writeOnly: true } },
  },
  outputSchema: {
    type: "object",
    properties: { hits: { type: "integer" }, secret: { type: "string", writeOnly: true } },
  },
};

/** A second catalogued tool outside `reader`'s patterns — the filter's other side. */
const PURGE_TOOL: Tool = {
  name: UNGRANTED_TOOL,
  description: "catalogued, never granted to reader",
  inputSchema: { type: "object", properties: {} },
};

/** A tool the seeded catalog does not hold, so a listing that serves it can only have been
 *  re-read after the app said its tool set changed (case 6a). */
const DIGEST_TOOL: Tool = {
  name: "digest",
  description: "catalogued only by the re-list",
  inputSchema: { type: "object", properties: {} },
};

/** What the fake app answers by default: both result carriers, the structured one
 *  carrying the planted secret. */
const ANSWER = {
  structuredContent: { hits: 1, secret: RESULT_SECRET },
  content: [{ type: "text", text: "one hit" }],
};

type Fixture = {
  ns: SeededNamespace;
  app: SeededApp;
  other: SeededApp;
  fake: FakeApp;
  /** The second app's socket — present only when the row asked for it (case 2). */
  otherFake?: FakeApp;
};

const seeded: SeededNamespace[] = [];
const opened: FakeApp[] = [];

afterEach(async () => {
  // Shared storage AND shared sockets across files in this project: a leak here is a leak
  // into the next file.
  for (const app of opened.splice(0)) await app.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/**
 * The namespace metaHygieneRows names: one tunneled `notes` declaring `reader: ["search"]`,
 * the three agents the rows call as, and a second tunneled app nobody but the owner
 * can see. The socket is dialled and its catalog warmed before this resolves, so a case's
 * first line is "this app is online" as a fact.
 */
async function seedFixture(
  options: { tools?: Tool[]; connectOther?: boolean; behavior?: ToolBehavior } = {},
): Promise<Fixture> {
  const ns = await seedNamespace(env.DB, {
    username: uniqueSlug("pipe"),
    apps: [
      { slug: APP_SLUG, kind: "tunnel", tokens: [{ as: "app" }] },
      { slug: OTHER_SLUG, kind: "tunnel", tokens: [{ as: "otherApp" }] },
    ],
    agents: [
      {
        slug: AGENT,
        grants: { [APP_SLUG]: [{ role: "reader", mode: "allow" }] },
        tokens: [{ as: AGENT }],
      },
      {
        // The built-in wildcard, granted rather than owned — §7's "never expanded" is a
        // claim about grant RESOLUTION, which the owner's hardcoded ["all"] cannot witness.
        slug: WILDCARD_AGENT,
        grants: { [APP_SLUG]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: WILDCARD_AGENT }],
      },
      {
        // Granted a role the app never declares: grants exist (so the door does not
        // 404), and nothing matches (case 5).
        slug: UNDECLARED_AGENT,
        grants: { [APP_SLUG]: [{ role: "writer", mode: "allow" }] },
        tokens: [{ as: UNDECLARED_AGENT }],
      },
    ],
  });
  seeded.push(ns);
  const fixture: Fixture = {
    ns,
    app: ns.apps[APP_SLUG],
    other: ns.apps[OTHER_SLUG],
    fake: await connect(ns.tokens.app.token, options.tools ?? [SEARCH_TOOL, PURGE_TOOL], options.behavior),
  };
  if (options.connectOther === true) {
    fixture.otherFake = await connect(ns.tokens.otherApp.token, [SEARCH_TOOL]);
  }
  await warmed(fixture);
  return fixture;
}

/** One registered socket for an app token, with the given catalog. */
async function connect(token: string, tools: Tool[], behavior?: ToolBehavior): Promise<FakeApp> {
  const app = await connectFakeApp({
    origin: ORIGIN,
    token,
    roles: { reader: [TOOL] },
    tools,
    behavior: behavior ?? { mode: "answer", result: ANSWER },
  });
  opened.push(app);
  return app;
}

/** Waits until the DO holds the catalog — the state every case's first assertion assumes. */
async function warmed(fixture: Fixture): Promise<void> {
  await untilCataloged(await appRow(fixture));
}

/** The app row as the gateway hands it to a backend. */
async function appRow(fixture: Fixture, slug: string = APP_SLUG): Promise<App> {
  const row = await new Registry(env.DB).getApp(fixture.ns.owner.userId, slug);
  if (row === null) throw new Error(`the fixture's app "${slug}" vanished`);
  return row;
}

/** The bearer each caller kind presents. The owner's is a real session (the device-flow
 *  credential a human holds); the agents' are their `pmcp_agt_` keys. */
async function credentialFor(fixture: Fixture, caller: MetaHygieneRow["caller"]): Promise<string> {
  if (caller === "owner") return (await seedOwnerSession(fixture.ns.owner)).token;
  return fixture.ns.tokens[caller === "agent" ? AGENT : WILDCARD_AGENT].token;
}

type Answer = { status: number; body: JsonRpcResponse };

/** One JSON-RPC message through the real worker entry — scoped when `slug` is a string,
 *  aggregated when it is null. */
async function rpc(
  fixture: Fixture,
  credential: string,
  slug: string | null,
  message: JsonRpcRequest,
): Promise<Answer> {
  const base = `${ORIGIN}/${fixture.ns.owner.username}/mcp`;
  const response = await workerExports.default.fetch(
    new Request(slug === null ? base : `${base}/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(message),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as JsonRpcResponse,
  };
}

/** A `tools/list` on either shape. */
function listMessage(): JsonRpcRequest {
  return { jsonrpc: "2.0", id: CONSUMER_ID, method: "tools/list" };
}

/** A `tools/call` on either shape — `name` carries the aggregated prefix or not. */
function callMessage(name: string, args: Record<string, unknown> = { q: "hello" }): JsonRpcRequest {
  return { jsonrpc: "2.0", id: CONSUMER_ID, method: "tools/call", params: { name, arguments: args } };
}

/** The tools a listing answer served. */
function servedTools(answer: Answer): Tool[] {
  return ((answer.body.result ?? {}) as { tools?: Tool[] }).tools ?? [];
}

/**
 * The scoped listing's tool names, polled until they are `expected` — the re-list a
 * `notifications/tools/list_changed` provokes is a hub round trip, so "has the catalog
 * changed yet" is a scheduling question and never a duration (fake-app.tick's doc).
 * Answers the LAST listing either way, so a change that never lands fails as an assertion
 * naming both sides rather than as a test timeout with nothing to read. The polled thing
 * stays a consumer-facing listing: peeking at the DO's storage would answer a different
 * question than the one case 6a asks.
 */
async function untilListed(
  fixture: Fixture,
  credential: string,
  expected: readonly string[],
): Promise<string[]> {
  let names: string[] = [];
  // waitFor's own default budget, spelled here because the predicate is a round trip.
  for (let turn = 0; turn < 250; turn++) {
    const listed = await rpc(fixture, credential, APP_SLUG, listMessage());
    names = servedTools(listed).map((tool) => tool.name);
    if (names.join() === expected.join()) return names;
    await tick();
  }
  return names;
}

/** Every `tools/call` frame a socket received, verbatim — `invocations` is a projection of
 *  these, and the params-level siblings live only here. */
function callFrames(app: FakeApp): Record<string, unknown>[] {
  return app.frames.filter((frame) => frame.method === "tools/call");
}

/** The params of the last `tools/call` frame the app received. */
function servedParams(app: FakeApp): Record<string, unknown> {
  const frames = callFrames(app);
  const last = frames[frames.length - 1];
  if (last === undefined) throw new Error("no tools/call ever reached the app");
  return (last.params ?? {}) as Record<string, unknown>;
}

/** The namespace's `tools/call` audit rows, newest first. */
async function callRows(fixture: Fixture): Promise<AuditRow[]> {
  return (await query(env.DB, fixture.ns.owner.userId, { event: "tools/call" })).rows;
}

/**
 * Runs `body` with every long timer the DO arms shrunk to a few milliseconds — the
 * §15 call deadline observed against the CONSTANT rather than waited out.
 *
 * This leans on a seam tunnel.ts's module header PUBLISHES rather than on a mechanic
 * inferred from its source: the correlation deadline is armed once per hub-originated
 * request, as a single ambient `setTimeout` at exactly limits.CALL_TIMEOUT_MS. A Durable
 * Object shares this isolate's globals, so that is the timer patched here, and the
 * predicate reads the constant — a spec change to the number changes what is shrunk and
 * nothing else, and a change to HOW the deadline is armed is a change to that published
 * sentence, which lands here. Restored unconditionally: a leaked patch is a leak into the
 * next file (this project shares one runtime).
 */
async function withShrunkCallTimeout<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  const patched = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    (real as (...args: unknown[]) => unknown)(
      handler,
      ms !== undefined && ms >= CALL_TIMEOUT_MS ? SHRUNK_DEADLINE_MS : ms,
      ...rest,
    )) as typeof globalThis.setTimeout;
  globalThis.setTimeout = patched;
  try {
    return await body();
  } finally {
    globalThis.setTimeout = real;
  }
}

/** What limits.CALL_TIMEOUT_MS is shrunk TO for the deadline case — a test-run duration, not
 *  a spec number, which is why it is not a limits.ts constant. */
const SHRUNK_DEADLINE_MS = 25;

/**
 * Runs `body` with the ledger unreachable — the `audit` table renamed out from under
 * audit.record, so the write fails for real rather than through a mocked sibling (§9: D1 is
 * never faked). Restored in `finally`, because every later file in this project shares this
 * database.
 */
async function withBrokenLedger<T>(body: () => Promise<T>): Promise<T> {
  const db = env.DB as D1Like;
  await db.prepare(`ALTER TABLE audit RENAME TO audit_unreachable`).run();
  try {
    return await body();
  } finally {
    await db.prepare(`ALTER TABLE audit_unreachable RENAME TO audit`).run();
  }
}


describe("§7 both endpoint shapes, one pipeline", () => {
  it("1. §7 · scoped tools/list serves the caller's filtered catalog with unprefixed names", async () => {
    const fixture = await seedFixture();

    const listed = servedTools(await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, listMessage()));

    // `reader: ["search"]` — the catalogued `purge` is outside it, and no name carries a prefix.
    expect(listed.map((tool) => tool.name)).toEqual([TOOL]);
  });

  it("2. §7 · aggregated tools/list prefixes `<slug>_` and spans only apps the caller holds a grant on", async () => {
    const fixture = await seedFixture({ connectOther: true });

    const forAgent = servedTools(
      await rpc(fixture, fixture.ns.tokens[AGENT].token, null, listMessage()),
    );
    const forOwner = servedTools(
      await rpc(fixture, (await seedOwnerSession(fixture.ns.owner)).token, null, listMessage()),
    );

    expect(forAgent.map((tool) => tool.name)).toEqual([`${APP_SLUG}_${TOOL}`]);
    // The second app is real, online and catalogued — the agent simply holds no grant
    // on it, which is what makes its absence a filtering claim rather than an empty one.
    expect(forOwner.map((tool) => tool.name)).toContain(`${OTHER_SLUG}_${TOOL}`);
    expect(forOwner.map((tool) => tool.name)).toContain(`${APP_SLUG}_${UNGRANTED_TOOL}`);
  });

  it("3. §7 · the same tool called through both shapes reaches the app with identical params — the prefix is split before anything else runs", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    await rpc(fixture, credential, APP_SLUG, callMessage(TOOL, { q: "both shapes" }));
    await rpc(fixture, credential, null, callMessage(`${APP_SLUG}_${TOOL}`, { q: "both shapes" }));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) === 2)).toBe(true);
    const [scoped, aggregated] = callFrames(fixture.fake).map(
      (frame) => frame.params as Record<string, unknown>,
    );
    // The app never learns the prefix existed: same name, same arguments, same _meta.
    expect(aggregated.name).toBe(TOOL);
    expect(scoped.name).toBe(TOOL);
    expect(aggregated.arguments).toEqual(scoped.arguments);
    expect(aggregated._meta).toEqual(scoped._meta);
  });

  it("4. §7 · role filtering bounds both surfaces: a tool outside the granted patterns is absent from the listing and answers -32001 on call, while a matched tool lists and executes (the refusal and its allow-twin in one pair)", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    const listed = servedTools(await rpc(fixture, credential, APP_SLUG, listMessage()));
    const refused = await rpc(fixture, credential, APP_SLUG, callMessage(UNGRANTED_TOOL, {}));
    const allowed = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));

    expect(listed.map((tool) => tool.name)).not.toContain(UNGRANTED_TOOL);
    expect(refused.body.error?.code).toBe(-32001);
    expect(listed.map((tool) => tool.name)).toContain(TOOL);
    expect(allowed.body.result).toBeDefined();
    // The refusal never left the hub: filtering is the FIRST check, so the app saw one
    // call, not two.
    expect(fixture.fake.callCount()).toBe(1);
  });

  it("5. §7 · a granted role the app has not declared yields an empty listing and -32001 — not a 404: the agent still holds a grant", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[UNDECLARED_AGENT].token;

    const listed = await rpc(fixture, credential, APP_SLUG, listMessage());
    const called = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));

    expect(listed.status, "a grant on an undeclared role is still a grant").toBe(200);
    expect(servedTools(listed)).toEqual([]);
    expect(called.status).toBe(200);
    expect(called.body.error?.code).toBe(-32001);
  });

  it("6. §7 · served outputSchemas carry no `writeOnly` while inputSchemas keep theirs, and the DO's cached catalog still holds both verbatim (stripping is serving-time, never storage-time)", async () => {
    const fixture = await seedFixture();

    const served = servedTools(
      await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, listMessage()),
    )[0];
    const cached = (await tunnelBackend.listTools(await appRow(fixture), backendCtx())).find(
      (tool) => tool.name === TOOL,
    );

    expect(JSON.stringify(served.outputSchema), "the hub's internal marker reached the wire").not.toContain(
      "writeOnly",
    );
    expect(JSON.stringify(served.inputSchema), "…and standard input usage was stripped too").toContain(
      "writeOnly",
    );
    expect(cached, "the cache is the verbatim oracle").toEqual(SEARCH_TOOL);
  });

  it("6a. §6 · a registered app's notifications/tools/list_changed reaches the consumer: the hub re-lists over that same socket and the NEXT tools/list serves the new set — the added tool present, the withdrawn one gone — with no reconnect and no second registration; and the twin, a re-list that draws no catalog, leaves the previous listing standing rather than emptying it (invalidation is a re-read, never a delete — §6 lifecycle 2)", async () => {
    const fixture = await seedFixture();
    // The owner, whose listing no grant bounds: role filtering is case 4's claim, and only
    // an unfiltered listing can show the whole catalog change.
    const credential = (await seedOwnerSession(fixture.ns.owner)).token;
    const before = servedTools(await rpc(fixture, credential, APP_SLUG, listMessage()));
    expect(before.map((tool) => tool.name)).toEqual([TOOL, UNGRANTED_TOOL]);

    // The real actor: the app itself, saying its tool set changed over its own socket.
    // Nothing reconnects and nothing re-registers, so the cache is the only thing that can
    // make the next listing differ.
    const warmed = fixture.fake.lists.length;
    await fixture.fake.notifyToolsListChanged([SEARCH_TOOL, DIGEST_TOOL]);

    const after = [TOOL, DIGEST_TOOL.name];
    expect(await untilListed(fixture, credential, after)).toEqual(after);
    // Re-LISTED: the new catalog came from a tools/list the hub issued, not from the
    // notification's own payload (§6 — the notification carries no tools).
    expect(
      fixture.fake.lists.length,
      "the catalog changed without the hub asking the app again",
    ).toBeGreaterThan(warmed);

    // The twin, one state later on the same socket: the app can no longer list, so the
    // re-list draws no catalog at all. A stale catalog serves better than an empty one, so
    // the previous listing stands — an invalidation that emptied the cache first would
    // serve nothing here.
    fixture.fake.setListBehavior({ mode: "error", error: { code: CODES.internal, message: "not ready" } });
    const relisted = fixture.fake.lists.length;
    await fixture.fake.notifyToolsListChanged([PURGE_TOOL]);
    expect(
      await waitFor(() => fixture.fake.lists.length > relisted),
      "the second notification never re-listed",
    ).toBe(true);
    const stale = servedTools(await rpc(fixture, credential, APP_SLUG, listMessage()));
    expect(stale.map((tool) => tool.name)).toEqual(after);
  });
});

describe("§7 `_meta` hygiene, observed at the app", () => {
  for (const row of metaHygieneRows) {
    it(`7. ${row.name}`, () => runMetaHygieneCase(row));
  }

  it("8. §7 · a forged consumer `hub/roles` never reaches the app; the hub's own resolution arrives in its place (strip-then-set, overwrite never merge)", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method: "tools/call",
      params: {
        name: TOOL,
        arguments: { q: "forged" },
        _meta: { "hub/roles": ["admin"], "hub/principal": "agent:root" },
      },
    });

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    const meta = servedParams(fixture.fake)._meta as Record<string, unknown>;
    // Overwritten, not merged: the arriving value is the hub's resolution and nothing of
    // the consumer's copy survives beside it.
    expect(meta["hub/roles"]).toEqual(["reader"]);
    expect(meta["hub/principal"]).toBe(`agent:${AGENT}`);
  });

  it("9. §7 · progressToken and unrecognized vendor `_meta` keys arrive untouched — the allow-twin of case 8", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method: "tools/call",
      params: {
        name: TOOL,
        arguments: { q: "passthrough" },
        _meta: { progressToken: "p-9", "vendor.example/trace": { span: "s-9" } },
      },
    });

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    const meta = servedParams(fixture.fake)._meta as Record<string, unknown>;
    expect(meta.progressToken).toBe("p-9");
    expect(meta["vendor.example/trace"]).toEqual({ span: "s-9" });
  });

  it("10. §7 · the consumer's clientCapabilities are mirrored onto the forwarded request, and a consumer that declared none forwards `{}` so the app refrains from elicitation", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;
    const capabilities = { elicitation: {}, sampling: {} };

    await rpc(fixture, credential, APP_SLUG, {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method: "tools/call",
      params: {
        name: TOOL,
        arguments: { q: "declared" },
        _meta: { "io.modelcontextprotocol/clientCapabilities": capabilities },
      },
    });
    expect(await waitFor(() => fixture.fake.callCount(TOOL) === 1)).toBe(true);
    const declared = servedParams(fixture.fake)._meta as Record<string, unknown>;

    await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(await waitFor(() => fixture.fake.callCount(TOOL) === 2)).toBe(true);
    const silent = servedParams(fixture.fake)._meta as Record<string, unknown>;

    expect(declared["io.modelcontextprotocol/clientCapabilities"]).toEqual(capabilities);
    expect(silent["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
  });

  it("11. §7 · an owner's call forwards hub/roles [\"all\"] literally, never expanded into the app's declared role names", async () => {
    const fixture = await seedFixture();
    const session = await seedOwnerSession(fixture.ns.owner);

    await rpc(fixture, session.token, APP_SLUG, callMessage(TOOL));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    const meta = servedParams(fixture.fake)._meta as Record<string, unknown>;
    expect(meta["hub/roles"]).toEqual(["all"]);
    expect(meta["hub/principal"]).toBe(`user:${fixture.ns.owner.username}`);
  });

  it("12. §6 · ids never cross: the consumer's JSON-RPC id never appears on the socket, and the response the consumer receives bears the consumer's id, not the wire id", async () => {
    const fixture = await seedFixture();

    const answer = await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(TOOL));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    expect(answer.body.id).toBe(CONSUMER_ID);
    expect(fixture.fake.invocations[0].wireId).not.toBe(String(CONSUMER_ID));
    // Not merely on the call frame: nothing the hub ever sent this socket carries it.
    expect(fixture.fake.frames.some((frame) => String(frame.id) === String(CONSUMER_ID))).toBe(false);
  });

  it("12a. §7 · \"relayed verbatim\" stops at the JSON-RPC error grammar: an app answering with an `error` member that is not an error OBJECT reaches the consumer as a well-formed one (code number, message string), while a well-formed app error passes through untouched — the app is the untrusted side of that socket", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    // The twin first: an app error the hub can read is the consumer's, verbatim.
    fixture.fake.setBehavior(TOOL, { mode: "error", error: { code: -32050, message: "no such city" } });
    const wellFormed = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(wellFormed.body.error).toMatchObject({ code: -32050, message: "no such city" });

    // And the ill-formed one, which only a raw frame can express: park the call, then
    // answer its wire id with an `error` that is a bare string.
    fixture.fake.setBehavior(TOOL, { mode: "hang" });
    const pending = rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 1), "the call never left").toBe(true);
    const parked = fixture.fake.invocations[fixture.fake.invocations.length - 1];
    await fixture.fake.sendRaw({ jsonrpc: "2.0", id: parked.wireId, error: "boom" });
    const answer = await pending;

    expect(typeof answer.body.error?.code, "the app's bytes sat in the error slot").toBe("number");
    expect(typeof answer.body.error?.message).toBe("string");
    // Still an ERROR row: the call reached the app and failed there (§15's vocabulary),
    // which is what separates this from a refusal.
    expect((await callRows(fixture))[0].outcome).toBe("error");
  });
});

describe("§15 deadline, disconnect, and the audit chokepoint", () => {
  it("13. §15 · an app that never answers fails -32000 at limits.CALL_TIMEOUT_MS — asserted against the constant with the run's value shrunk, never waited out", async () => {
    const fixture = await seedFixture({ behavior: { mode: "hang" } });

    const startedAt = Date.now();
    const answer = await withShrunkCallTimeout(() =>
      rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(TOOL)),
    );
    const elapsed = Date.now() - startedAt;

    expect(answer.body.error?.code).toBe(-32000);
    // The app RECEIVED it — a timed-out call may already have executed (§15's
    // at-most-once), which is exactly what separates this from an offline refusal.
    expect(fixture.fake.callCount(TOOL)).toBe(1);
    expect(elapsed, "the deadline was waited out rather than shrunk").toBeLessThan(CALL_TIMEOUT_MS);
  });

  it("14. §15 · a disconnect mid-call fails the waiting consumer -32000 immediately rather than at the deadline (the allow-twin: an app that answers in time resolves)", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    // The twin first, on the same socket: an app that answers in time resolves.
    const answered = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(answered.body.result).toBeDefined();

    fixture.fake.setBehavior(TOOL, { mode: "drop" });
    const startedAt = Date.now();
    const dropped = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));

    expect(dropped.body.error?.code).toBe(-32000);
    // Immediately: the pending map drains on close rather than waiting for the budget.
    expect(Date.now() - startedAt, "the consumer waited for the deadline").toBeLessThan(CALL_TIMEOUT_MS);
  });

  it("14a. §15 · a frame already on the wire is never reported as certainly-did-not-execute: the dropped call's -32000 discloses that it MAY have run and its row records the disconnect, while the next call — with the socket gone, so nothing left — discloses nothing and records `offline`", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    fixture.fake.setBehavior(TOOL, { mode: "drop" });
    const dropped = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));

    // The app RECEIVED it before dropping — which is what makes "certainly did not
    // execute" a lie about this call, and §15's at-most-once question a real one.
    expect(fixture.fake.callCount(TOOL)).toBe(1);
    expect(dropped.body.error?.code).toBe(-32000);
    expect(dropped.body.error?.message, "the consumer cannot tell this from an offline refusal").toMatch(
      /may have executed/,
    );
    // The ledger keeps the classes apart — §15's "was it offline or did it time out",
    // which one -32000 on the wire cannot answer and this column is the only place that can.
    const [droppedRow] = await callRows(fixture);
    expect(droppedRow.detail).toMatchObject({ failureClass: "disconnected" });

    // The twin, one state later on the same fixture: the socket is gone, so the frame
    // never leaves and the consumer is told nothing about execution.
    await untilStatus(fixture.app.id, "offline");
    const offline = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(offline.body.error?.code).toBe(-32000);
    expect(offline.body.error?.message).not.toMatch(/may have executed/);
    expect(fixture.fake.callCount(TOOL), "nothing was queued for the absent app").toBe(1);
  });

  it("14b. §10/§15 · a DO RPC that fails under a waiting consumer refuses -32000 with a failure class in the row, never the unclassified -32603: a forcibly restarted instance is downtime, and the ledger is where §15's at-most-once question about that call is answered", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;
    fixture.fake.setBehavior(TOOL, { mode: "hang" });

    const pending = rpc(fixture, credential, APP_SLUG, callMessage(TOOL));
    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0), "the call never left").toBe(true);
    // The one in-process way to a real DO failure: the instance is reset under the
    // in-flight RPC, which is §6's "forcibly restarted" branch — no stub is mocked.
    await abortAllDurableObjects();
    const answer = await pending;

    expect(answer.body.error?.code).toBe(-32000);
    const [row] = await callRows(fixture);
    expect(row.outcome).toBe("-32000");
    expect(row.detail, "the row lost the failure class").toMatchObject({
      failureClass: "do_unreachable",
    });
  });

  it("15. §15 · an offline app fails -32000 on call while its cached tools/list still lists tools — the pair that keeps \"unavailable\" from meaning \"invisible\"", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    await fixture.fake.close();
    await untilStatus(fixture.app.id, "offline");

    const listed = servedTools(await rpc(fixture, credential, APP_SLUG, listMessage()));
    const called = await rpc(fixture, credential, APP_SLUG, callMessage(TOOL));

    expect(listed.map((tool) => tool.name)).toEqual([TOOL]);
    expect(called.body.error?.code).toBe(-32000);
    expect(fixture.fake.callCount(), "nothing was queued for the absent app").toBe(0);
  });

  it("16. §15 · every resolved tools/call writes exactly one audit row carrying a hub-measured duration_ms", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(TOOL));

    const rows = await callRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: APP_SLUG, tool: TOOL, outcome: "ok" });
    expect(typeof rows[0].durationMs).toBe("number");
  });

  it("17. §15 · a denied tools/call writes one row too, with its refusal code as outcome — denials are just fast (the twin of case 16)", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(UNGRANTED_TOOL, {}));

    const rows = await callRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: UNGRANTED_TOOL, outcome: "-32001" });
    expect(typeof rows[0].durationMs).toBe("number");
    // A refusal row never carries bodies (§15), whatever log_bodies says.
    expect(rows[0].args).toBeUndefined();
  });

  it("18. §15 · tools/list writes no audit row on either endpoint shape — kept out by vocabulary, not by filtering", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[AGENT].token;

    await rpc(fixture, credential, APP_SLUG, listMessage());
    await rpc(fixture, credential, null, listMessage());

    expect(await callRows(fixture)).toEqual([]);
    expect(
      (await query(env.DB, fixture.ns.owner.userId, { event: "tools/list" })).total,
      "tools/list is out of the vocabulary, not merely filtered",
    ).toBe(0);
  });

  it("19. §15 · a failed audit write fails the call: the ledger is chosen over availability", async () => {
    const fixture = await seedFixture();

    const answer = await withBrokenLedger(() =>
      rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(TOOL)),
    );

    // The app answered — availability was never the problem, and the call still fails.
    expect(fixture.fake.callCount(TOOL)).toBe(1);
    expect(answer.body.result, "a call the ledger cannot attest to must not succeed").toBeUndefined();
    expect(answer.body.error).toBeDefined();
  });

  it("20. §7 · the consumer's relayed result is never masked, while the audit row written for that same call is — masking exists for persistence, not for the wire", async () => {
    const fixture = await seedFixture();

    const answer = await rpc(fixture, fixture.ns.tokens[AGENT].token, APP_SLUG, callMessage(TOOL));

    const relayed = (answer.body.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(relayed.secret, "the wire was masked").toBe(RESULT_SECRET);
    const recorded = (await callRows(fixture))[0].result as {
      structuredContent: Record<string, unknown>;
    };
    expect(recorded.structuredContent.secret, "the ledger was not").toBe(REDACTED);
  });
});
