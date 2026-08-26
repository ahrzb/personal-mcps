/**
 * tunnel/pipeline-tunnel.test.ts — §16's core integration test: a consumer POSTs into
 * the real worker entry, a fake service answers over a real WebSocket through the real
 * ServiceConnection DO, and everything in between is production code. Four green unit
 * tests compose into a wrong pipeline; only the pipeline exhibits the pipeline's bugs
 * (strategy §1), so this file is where both endpoint shapes, role filtering, `_meta`
 * hygiene and the audit chokepoint are pinned END TO END rather than per function.
 *
 * WHAT THIS SUITE PINS. That both endpoint shapes are ONE pipeline — the same call
 * reaches the same tool with the same params through `/<user>/mcp` and
 * `/<user>/mcp/<slug>`, prefixed and unprefixed; role filtering bounding both the
 * listing and the call; `_meta` hygiene as the SERVICE observes it (consumer-supplied
 * `hub/*` keys stripped then the hub's own set — overwrite, never merge; the consumer's
 * clientCapabilities mirrored, `{}` when absent; everything else untouched); that
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
 * service, account and tokens, and asserts on rows it created rather than on counts.
 * Nothing sleeps: the never-answering service reaches the deadline against a shrunk
 * constant, and the fake service's release gates make ordering explicit.
 */

// deps: harness/seed · harness/fake-service · harness/tunnel-do (backendCtx, untilStatus, untilCataloged) · cloudflare:workers (exports.default.fetch) · cloudflare:test (env) · src/gateway (JsonRpcRequest, JsonRpcResponse, Tool) · src/tunnel (tunnelBackend) · src/audit (query) · src/registry (Registry, buildToolFilter) · src/limits (CALL_TIMEOUT_MS)

import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import { CALL_TIMEOUT_MS } from "../../src/limits";
import { REDACTED, Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
import { tunnelBackend } from "../../src/tunnel";
import { connectFakeService, waitFor } from "../harness/fake-service";
import type { FakeService, ToolBehavior } from "../harness/fake-service";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededService } from "../harness/seed";
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
 * THE SERVICE (the fake service records the frame it received) rather than by
 * inspecting the gateway, because "a consumer cannot inject `hub/*`" is a claim about
 * what a service sees.
 *
 * Three columns, because §7 makes exactly three promises about a forwarded `_meta`:
 * `absent` — keys the service must not see at all (every consumer-supplied `hub/*`
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
   * accounts forward what they hold, resolved from the grant table — which is why the
   * built-in wildcard needs a caller of its own (`service_account_all`): §7's "never
   * expanded into declared role names" is a claim about grant RESOLUTION, and the owner's
   * hardcoded `["all"]` cannot witness it.
   */
  caller: "owner" | "service_account" | "service_account_all";
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
  // The fixture these rows are written against, named once: one tunneled service `notes`
  // declaring `reader: ["search"]`, one service account with the FIXED slug `claude`
  // holding `reader` in allow mode, a second account with the FIXED slug `wildcard`
  // holding the built-in `all` in allow mode, and the namespace owner. Every row is the
  // same `tools/call` for `search` on the scoped endpoint — the message differs only in
  // its `_meta` and, on the MRTR row, its params-level siblings.
  //
  // Three conventions, so no row repeats them:
  // · `written` lists only the keys whose expected value is STABLE across runs. `sa:claude`
  //   is stable because the account slug is fixture-chosen; `user:<username>` is not (the
  //   tunnel project mints a unique username per case, seed.uniqueSlug), so the owner row
  //   pins its `hub/roles` and its capabilities and leaves the principal VALUE to the
  //   service-account rows, where the same code path writes it.
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
  // name a role the account does not hold and the wildcard it may never grant itself; the
  // forged principal names another account. What arrives is what the hub resolved.
  {
    name: "§7 · a forged hub/roles and hub/principal never reach the service: the hub's own resolution arrives in their place, and an unknown hub/* key arrives not at all",
    caller: "service_account",
    sent: {
      "hub/roles": ["admin", "all"],
      "hub/principal": "sa:root",
      "hub/impersonate": "user:ahrzb",
      progressToken: "p-1",
    },
    absent: ["hub/impersonate"],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "sa:claude",
      "hub/roles": ["reader"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
  // §7's identity forwarding: "the built-in wildcard is forwarded literally as `"all"`,
  // never expanded into declared role names; owners get `["all"]`". The row also carries
  // the second half of the prefix rule — `hub/service` is a name the hub writes nothing
  // for, so it is dropped rather than passed through as a vendor key would be.
  {
    name: "§7 · an owner's _meta is scrubbed the same way: hub/roles arrives as the literal [\"all\"], never expanded into the service's declared roles",
    caller: "owner",
    sent: {
      "hub/roles": ["reader"],
      "hub/service": "other",
      "vendor.example/trace": "t-1",
    },
    absent: ["hub/service"],
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
    caller: "service_account",
    sent: {
      "io.modelcontextprotocol/clientCapabilities": { elicitation: {}, sampling: {} },
      progressToken: 7,
    },
    absent: [],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "sa:claude",
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
    caller: "service_account",
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
      "hub/principal": "sa:claude",
      "hub/roles": ["reader"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
  // §7's identity forwarding again, on the one path the owner row cannot reach: an ACCOUNT
  // granted the built-in `all` resolves its roles through the grant table rather than the
  // owner's hardcoded `["all"]`, and the wildcard must still arrive LITERAL — never expanded
  // into the service's declared role names (here `["reader"]`, which is what an expanding
  // implementation would send while every other row stayed green). unit/filter.test.ts
  // delegates exactly this claim to this file ("that `roleNames` reaches a service as
  // `hub/roles` with `all` still literal"), and worker/upstream-proxy.test.ts pins the
  // proxied twin (`x-pmcp-roles: all` for `sa:<agent>`), so this row is the tunneled half of
  // one rule rather than a second opinion about the owner's.
  {
    name: "§7 · a service account granted the built-in `all` forwards hub/roles as the literal [\"all\"] — granted wildcards are never expanded into the service's declared roles",
    caller: "service_account_all",
    sent: {
      progressToken: "p-2",
    },
    absent: [],
    passthrough: ["progressToken"],
    written: {
      "hub/principal": "sa:wildcard",
      "hub/roles": ["all"],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
];

/**
 * Runs one hygiene row: seeds the caller, sends the row's ConsumerCall through
 * `exports.default.fetch`, and asserts the three columns against the frame the fake
 * service recorded — plus, always, that the response the consumer receives bears the
 * consumer's own id.
 */
export async function runMetaHygieneCase(row: MetaHygieneRow): Promise<void> {
  // deps: harness/seed · harness/fake-service · cloudflare:workers exports.default.fetch
  const fixture = await seedFixture();
  const answer = await rpc(fixture, await credentialFor(fixture, row.caller), SERVICE_SLUG, {
    jsonrpc: "2.0",
    id: CONSUMER_ID,
    method: "tools/call",
    params: { name: TOOL, arguments: { q: "hygiene" }, ...(row.siblings ?? {}), _meta: row.sent },
  });
  expect(answer.body.error, `"${row.name}" was refused before it reached the service`).toBeUndefined();
  expect(
    await waitFor(() => fixture.fake.callCount(TOOL) > 0),
    `"${row.name}" never reached the service`,
  ).toBe(true);

  // Observed AT THE SERVICE, always: "a consumer cannot inject hub/*" is a claim about what
  // a service sees, and the frame — not the invocation projection — is where the
  // params-level siblings ride (ConsumerCall's doc).
  const params = servedParams(fixture.fake);
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  for (const key of row.absent) {
    expect(Object.keys(meta), `"${row.name}": ${key} reached the service`).not.toContain(key);
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
const SERVICE_SLUG = "notes";
const OTHER_SLUG = "vault";
const ACCOUNT = "claude";
const WILDCARD_ACCOUNT = "wildcard";
const UNDECLARED_ACCOUNT = "ghost";
const TOOL = "search";
const UNGRANTED_TOOL = "purge";

/** The consumer's own JSON-RPC id — asserted back on every answer, and hunted on the wire
 *  (case 12: ids never cross). A number, so a wire id (a UUID string) can never equal it. */
const CONSUMER_ID = 4242;

/** Planted in the service's answer, so "the consumer's relayed result is never masked" and
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

/** What the fake service answers by default: both result carriers, the structured one
 *  carrying the planted secret. */
const ANSWER = {
  structuredContent: { hits: 1, secret: RESULT_SECRET },
  content: [{ type: "text", text: "one hit" }],
};

type Fixture = {
  ns: SeededNamespace;
  service: SeededService;
  other: SeededService;
  fake: FakeService;
  /** The second service's socket — present only when the row asked for it (case 2). */
  otherFake?: FakeService;
};

const seeded: SeededNamespace[] = [];
const opened: FakeService[] = [];

afterEach(async () => {
  // Shared storage AND shared sockets across files in this project: a leak here is a leak
  // into the next file.
  for (const service of opened.splice(0)) await service.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

/**
 * The namespace metaHygieneRows names: one tunneled `notes` declaring `reader: ["search"]`,
 * the three accounts the rows call as, and a second tunneled service nobody but the owner
 * can see. The socket is dialled and its catalog warmed before this resolves, so a case's
 * first line is "this service is online" as a fact.
 */
async function seedFixture(
  options: { tools?: Tool[]; connectOther?: boolean; behavior?: ToolBehavior } = {},
): Promise<Fixture> {
  const ns = await seedNamespace(env.DB, {
    username: uniqueSlug("pipe"),
    services: [
      { slug: SERVICE_SLUG, kind: "tunnel", tokens: [{ as: "svc" }] },
      { slug: OTHER_SLUG, kind: "tunnel", tokens: [{ as: "otherSvc" }] },
    ],
    accounts: [
      {
        slug: ACCOUNT,
        grants: { [SERVICE_SLUG]: [{ role: "reader", mode: "allow" }] },
        tokens: [{ as: ACCOUNT }],
      },
      {
        // The built-in wildcard, granted rather than owned — §7's "never expanded" is a
        // claim about grant RESOLUTION, which the owner's hardcoded ["all"] cannot witness.
        slug: WILDCARD_ACCOUNT,
        grants: { [SERVICE_SLUG]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: WILDCARD_ACCOUNT }],
      },
      {
        // Granted a role the service never declares: grants exist (so the door does not
        // 404), and nothing matches (case 5).
        slug: UNDECLARED_ACCOUNT,
        grants: { [SERVICE_SLUG]: [{ role: "writer", mode: "allow" }] },
        tokens: [{ as: UNDECLARED_ACCOUNT }],
      },
    ],
  });
  seeded.push(ns);
  const fixture: Fixture = {
    ns,
    service: ns.services[SERVICE_SLUG],
    other: ns.services[OTHER_SLUG],
    fake: await connect(ns.tokens.svc.token, options.tools ?? [SEARCH_TOOL, PURGE_TOOL], options.behavior),
  };
  if (options.connectOther === true) {
    fixture.otherFake = await connect(ns.tokens.otherSvc.token, [SEARCH_TOOL]);
  }
  await warmed(fixture);
  return fixture;
}

/** One registered socket for a service token, with the given catalog. */
async function connect(token: string, tools: Tool[], behavior?: ToolBehavior): Promise<FakeService> {
  const service = await connectFakeService({
    origin: ORIGIN,
    token,
    roles: { reader: [TOOL] },
    tools,
    behavior: behavior ?? { mode: "answer", result: ANSWER },
  });
  opened.push(service);
  return service;
}

/** Waits until the DO holds the catalog — the state every case's first assertion assumes. */
async function warmed(fixture: Fixture): Promise<void> {
  await untilCataloged(await serviceRow(fixture));
}

/** The service row as the gateway hands it to a backend. */
async function serviceRow(fixture: Fixture, slug: string = SERVICE_SLUG): Promise<Service> {
  const row = await new Registry(env.DB).getService(fixture.ns.owner.userId, slug);
  if (row === null) throw new Error(`the fixture's service "${slug}" vanished`);
  return row;
}

/** The bearer each caller kind presents. The owner's is a real session (the device-flow
 *  credential a human holds); the accounts' are their `pmcp_sa_` keys. */
async function credentialFor(fixture: Fixture, caller: MetaHygieneRow["caller"]): Promise<string> {
  if (caller === "owner") return (await seedOwnerSession(fixture.ns.owner)).token;
  return fixture.ns.tokens[caller === "service_account" ? ACCOUNT : WILDCARD_ACCOUNT].token;
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

/** Every `tools/call` frame a socket received, verbatim — `invocations` is a projection of
 *  these, and the params-level siblings live only here. */
function callFrames(service: FakeService): Record<string, unknown>[] {
  return service.frames.filter((frame) => frame.method === "tools/call");
}

/** The params of the last `tools/call` frame the service received. */
function servedParams(service: FakeService): Record<string, unknown> {
  const frames = callFrames(service);
  const last = frames[frames.length - 1];
  if (last === undefined) throw new Error("no tools/call ever reached the service");
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

    const listed = servedTools(await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, listMessage()));

    // `reader: ["search"]` — the catalogued `purge` is outside it, and no name carries a prefix.
    expect(listed.map((tool) => tool.name)).toEqual([TOOL]);
  });

  it("2. §7 · aggregated tools/list prefixes `<slug>_` and spans only services the caller holds a grant on", async () => {
    const fixture = await seedFixture({ connectOther: true });

    const forAccount = servedTools(
      await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, null, listMessage()),
    );
    const forOwner = servedTools(
      await rpc(fixture, (await seedOwnerSession(fixture.ns.owner)).token, null, listMessage()),
    );

    expect(forAccount.map((tool) => tool.name)).toEqual([`${SERVICE_SLUG}_${TOOL}`]);
    // The second service is real, online and catalogued — the account simply holds no grant
    // on it, which is what makes its absence a filtering claim rather than an empty one.
    expect(forOwner.map((tool) => tool.name)).toContain(`${OTHER_SLUG}_${TOOL}`);
    expect(forOwner.map((tool) => tool.name)).toContain(`${SERVICE_SLUG}_${UNGRANTED_TOOL}`);
  });

  it("3. §7 · the same tool called through both shapes reaches the service with identical params — the prefix is split before anything else runs", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;

    await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL, { q: "both shapes" }));
    await rpc(fixture, credential, null, callMessage(`${SERVICE_SLUG}_${TOOL}`, { q: "both shapes" }));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) === 2)).toBe(true);
    const [scoped, aggregated] = callFrames(fixture.fake).map(
      (frame) => frame.params as Record<string, unknown>,
    );
    // The service never learns the prefix existed: same name, same arguments, same _meta.
    expect(aggregated.name).toBe(TOOL);
    expect(scoped.name).toBe(TOOL);
    expect(aggregated.arguments).toEqual(scoped.arguments);
    expect(aggregated._meta).toEqual(scoped._meta);
  });

  it("4. §7 · role filtering bounds both surfaces: a tool outside the granted patterns is absent from the listing and answers -32001 on call, while a matched tool lists and executes (the refusal and its allow-twin in one pair)", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;

    const listed = servedTools(await rpc(fixture, credential, SERVICE_SLUG, listMessage()));
    const refused = await rpc(fixture, credential, SERVICE_SLUG, callMessage(UNGRANTED_TOOL, {}));
    const allowed = await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));

    expect(listed.map((tool) => tool.name)).not.toContain(UNGRANTED_TOOL);
    expect(refused.body.error?.code).toBe(-32001);
    expect(listed.map((tool) => tool.name)).toContain(TOOL);
    expect(allowed.body.result).toBeDefined();
    // The refusal never left the hub: filtering is the FIRST check, so the service saw one
    // call, not two.
    expect(fixture.fake.callCount()).toBe(1);
  });

  it("5. §7 · a granted role the service has not declared yields an empty listing and -32001 — not a 404: the account still holds a grant", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[UNDECLARED_ACCOUNT].token;

    const listed = await rpc(fixture, credential, SERVICE_SLUG, listMessage());
    const called = await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));

    expect(listed.status, "a grant on an undeclared role is still a grant").toBe(200);
    expect(servedTools(listed)).toEqual([]);
    expect(called.status).toBe(200);
    expect(called.body.error?.code).toBe(-32001);
  });

  it("6. §7 · served outputSchemas carry no `writeOnly` while inputSchemas keep theirs, and the DO's cached catalog still holds both verbatim (stripping is serving-time, never storage-time)", async () => {
    const fixture = await seedFixture();

    const served = servedTools(
      await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, listMessage()),
    )[0];
    const cached = (await tunnelBackend.listTools(await serviceRow(fixture), backendCtx())).find(
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
});

describe("§7 `_meta` hygiene, observed at the service", () => {
  for (const row of metaHygieneRows) {
    it(`7. ${row.name}`, () => runMetaHygieneCase(row));
  }

  it("8. §7 · a forged consumer `hub/roles` never reaches the service; the hub's own resolution arrives in its place (strip-then-set, overwrite never merge)", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, {
      jsonrpc: "2.0",
      id: CONSUMER_ID,
      method: "tools/call",
      params: {
        name: TOOL,
        arguments: { q: "forged" },
        _meta: { "hub/roles": ["admin"], "hub/principal": "sa:root" },
      },
    });

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    const meta = servedParams(fixture.fake)._meta as Record<string, unknown>;
    // Overwritten, not merged: the arriving value is the hub's resolution and nothing of
    // the consumer's copy survives beside it.
    expect(meta["hub/roles"]).toEqual(["reader"]);
    expect(meta["hub/principal"]).toBe(`sa:${ACCOUNT}`);
  });

  it("9. §7 · progressToken and unrecognized vendor `_meta` keys arrive untouched — the allow-twin of case 8", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, {
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

  it("10. §7 · the consumer's clientCapabilities are mirrored onto the forwarded request, and a consumer that declared none forwards `{}` so the service refrains from elicitation", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;
    const capabilities = { elicitation: {}, sampling: {} };

    await rpc(fixture, credential, SERVICE_SLUG, {
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

    await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));
    expect(await waitFor(() => fixture.fake.callCount(TOOL) === 2)).toBe(true);
    const silent = servedParams(fixture.fake)._meta as Record<string, unknown>;

    expect(declared["io.modelcontextprotocol/clientCapabilities"]).toEqual(capabilities);
    expect(silent["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
  });

  it("11. §7 · an owner's call forwards hub/roles [\"all\"] literally, never expanded into the service's declared role names", async () => {
    const fixture = await seedFixture();
    const session = await seedOwnerSession(fixture.ns.owner);

    await rpc(fixture, session.token, SERVICE_SLUG, callMessage(TOOL));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    const meta = servedParams(fixture.fake)._meta as Record<string, unknown>;
    expect(meta["hub/roles"]).toEqual(["all"]);
    expect(meta["hub/principal"]).toBe(`user:${fixture.ns.owner.username}`);
  });

  it("12. §6 · ids never cross: the consumer's JSON-RPC id never appears on the socket, and the response the consumer receives bears the consumer's id, not the wire id", async () => {
    const fixture = await seedFixture();

    const answer = await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(TOOL));

    expect(await waitFor(() => fixture.fake.callCount(TOOL) > 0)).toBe(true);
    expect(answer.body.id).toBe(CONSUMER_ID);
    expect(fixture.fake.invocations[0].wireId).not.toBe(String(CONSUMER_ID));
    // Not merely on the call frame: nothing the hub ever sent this socket carries it.
    expect(fixture.fake.frames.some((frame) => String(frame.id) === String(CONSUMER_ID))).toBe(false);
  });
});

describe("§15 deadline, disconnect, and the audit chokepoint", () => {
  it("13. §15 · a service that never answers fails -32000 at limits.CALL_TIMEOUT_MS — asserted against the constant with the run's value shrunk, never waited out", async () => {
    const fixture = await seedFixture({ behavior: { mode: "hang" } });

    const startedAt = Date.now();
    const answer = await withShrunkCallTimeout(() =>
      rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(TOOL)),
    );
    const elapsed = Date.now() - startedAt;

    expect(answer.body.error?.code).toBe(-32000);
    // The service RECEIVED it — a timed-out call may already have executed (§15's
    // at-most-once), which is exactly what separates this from an offline refusal.
    expect(fixture.fake.callCount(TOOL)).toBe(1);
    expect(elapsed, "the deadline was waited out rather than shrunk").toBeLessThan(CALL_TIMEOUT_MS);
  });

  it("14. §15 · a disconnect mid-call fails the waiting consumer -32000 immediately rather than at the deadline (the allow-twin: a service that answers in time resolves)", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;

    // The twin first, on the same socket: a service that answers in time resolves.
    const answered = await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));
    expect(answered.body.result).toBeDefined();

    fixture.fake.setBehavior(TOOL, { mode: "drop" });
    const startedAt = Date.now();
    const dropped = await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));

    expect(dropped.body.error?.code).toBe(-32000);
    // Immediately: the pending map drains on close rather than waiting for the budget.
    expect(Date.now() - startedAt, "the consumer waited for the deadline").toBeLessThan(CALL_TIMEOUT_MS);
  });

  it("15. §15 · an offline service fails -32000 on call while its cached tools/list still lists tools — the pair that keeps \"unavailable\" from meaning \"invisible\"", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;

    await fixture.fake.close();
    await untilStatus(fixture.service.id, "offline");

    const listed = servedTools(await rpc(fixture, credential, SERVICE_SLUG, listMessage()));
    const called = await rpc(fixture, credential, SERVICE_SLUG, callMessage(TOOL));

    expect(listed.map((tool) => tool.name)).toEqual([TOOL]);
    expect(called.body.error?.code).toBe(-32000);
    expect(fixture.fake.callCount(), "nothing was queued for the absent service").toBe(0);
  });

  it("16. §15 · every resolved tools/call writes exactly one audit row carrying a hub-measured duration_ms", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(TOOL));

    const rows = await callRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: SERVICE_SLUG, tool: TOOL, outcome: "ok" });
    expect(typeof rows[0].durationMs).toBe("number");
  });

  it("17. §15 · a denied tools/call writes one row too, with its refusal code as outcome — denials are just fast (the twin of case 16)", async () => {
    const fixture = await seedFixture();

    await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(UNGRANTED_TOOL, {}));

    const rows = await callRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: UNGRANTED_TOOL, outcome: "-32001" });
    expect(typeof rows[0].durationMs).toBe("number");
    // A refusal row never carries bodies (§15), whatever log_bodies says.
    expect(rows[0].args).toBeUndefined();
  });

  it("18. §15 · tools/list writes no audit row on either endpoint shape — kept out by vocabulary, not by filtering", async () => {
    const fixture = await seedFixture();
    const credential = fixture.ns.tokens[ACCOUNT].token;

    await rpc(fixture, credential, SERVICE_SLUG, listMessage());
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
      rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(TOOL)),
    );

    // The service answered — availability was never the problem, and the call still fails.
    expect(fixture.fake.callCount(TOOL)).toBe(1);
    expect(answer.body.result, "a call the ledger cannot attest to must not succeed").toBeUndefined();
    expect(answer.body.error).toBeDefined();
  });

  it("20. §7 · the consumer's relayed result is never masked, while the audit row written for that same call is — masking exists for persistence, not for the wire", async () => {
    const fixture = await seedFixture();

    const answer = await rpc(fixture, fixture.ns.tokens[ACCOUNT].token, SERVICE_SLUG, callMessage(TOOL));

    const relayed = (answer.body.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(relayed.secret, "the wire was masked").toBe(RESULT_SECRET);
    const recorded = (await callRows(fixture))[0].result as {
      structuredContent: Record<string, unknown>;
    };
    expect(recorded.structuredContent.secret, "the ledger was not").toBe(REDACTED);
  });
});
