// admin-pipeline.test.ts — the builtin `pmcp` service through the REAL endpoint (§8, §7).
//
// What this suite pins: that admin is not a special case. §8 makes the builtin a third
// ServiceBackend riding the same pipeline as tunnel and upstream, and the only way to
// pin "no special case" is to reach it the way a consumer does — `POST /<user>/mcp` and
// `POST /<user>/mcp/pmcp` — rather than by calling `ops` directly. The pins: an owner
// sees every op as a `pmcp_<op>` tool on the aggregated endpoint and unprefixed on the
// scoped one; a service account sees NO `pmcp_*` tool anywhere and is refused with the
// ordinary indistinguishable answers, structurally — the reservation means no `service`
// row exists, so no grant can reference it (§8: "structural rather than checked"); an
// owner is never approval-gated (["all"] resolves allow, so the gate is never entered);
// `service_list` carries the virtual `builtin: true` row that no D1 row backs; and §7's
// asymmetry between reply and record — the CALLER's response is never redacted, while
// what is persisted always is.
//
// Parity direction A (§8's parity invariant) is OWNED by admin-ops.test.ts, which proves
// the totality `Object.keys(ops)` ↔ the tools adminBackend renders from each op's one
// schema. What this file adds is the endpoint face of it: that the same set arrives at a
// consumer, correctly prefixed per endpoint shape. Direction B — the web form's fields
// against that same schema — is web-pages.test.ts's.
//
// Project: `worker` — real D1, every sibling real, driven through
// `exports.default.fetch`; no sockets, and the builtin needs none (it is the one backend
// with nothing to dial, which also makes it this project's cheapest dispatch-reaching
// allow-twin). Per-file storage isolation applies; no case here depends on another's
// state.
//
// Not pinned here: the ops themselves — validation, cascades, per-op audit rows
// (admin-ops.test.ts); authentication in front of the endpoint (auth-matrix.test.ts); the
// check order this traffic rides (order.table.test.ts); and the sentinel sweep proving no
// column ever holds a token (hygiene.test.ts), which owns the ledger half of the
// reply-vs-record pin below.
//
// deps: harness/seed (owner + one service account holding grants on a real service, so
//   "sees no pmcp tools" is asserted against an account that demonstrably sees something)
//   · harness/fake-upstream (the granted service's far side, and the push sink a
//   "nothing was sent" row needs) · ../../src/index (default.fetch) · ../../src/admin
//   (ops) · ../../src/gateway · ../../src/registry (PMCP_SLUG, REDACTED) ·
//   ../../src/approvals (the owner's push subscription) · ../../src/audit (query) ·
//   applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ops } from "../../src/admin";
import { Approvals } from "../../src/approvals";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import type { JsonRpcResponse } from "../../src/gateway";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { PMCP_SLUG, REDACTED } from "../../src/registry";
import { readObservations, upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

describe("§8 — the builtin rides the ordinary pipeline", () => {
  it("§8 · the owner's aggregated tools/list carries a `pmcp_<op>` tool for every ops key — the endpoint face of parity direction A", async () => {
    const hub = await fixture();
    const names = await toolNames(await hub.owner({ method: "tools/list", params: {} }));
    expect(names).toEqual(expect.arrayContaining(Object.keys(ops).map((op) => `${PMCP_SLUG}_${op}`)));
  });

  it("§8 · the scoped /mcp/pmcp list carries the same tools with bare names, no prefix", async () => {
    const hub = await fixture();
    const names = await toolNames(await hub.owner({ method: "tools/list", params: {} }, PMCP_SLUG));
    expect(names.slice().sort()).toEqual(Object.keys(ops).sort());
  });

  it("§7 · a scoped `pmcp` call runs the same filter → archived → approval → availability order as any service", async () => {
    const hub = await fixture();
    const answered = await hub.owner(call("service_list", {}), PMCP_SLUG);
    expect(answered.error, JSON.stringify(answered.error)).toBeUndefined();
    // Rode `callTool`, not a shortcut past it: the pipeline's own audit write is the one
    // place a dispatched call is recorded, and it stamps the hub-measured duration (§15).
    const [recorded] = await auditRows(hub.ownerId, "tools/call");
    expect(recorded).toMatchObject({ service: PMCP_SLUG, tool: "service_list", outcome: "ok" });
    expect(recorded.durationMs, "hub-measured wall time").toBeTypeOf("number");
    // And the refusal vocabulary is the pipeline's, not admin's own: an unknown tool on the
    // builtin answers exactly what an unknown tool on any service answers.
    const unknown = await hub.owner(call("no_such_op", {}), PMCP_SLUG);
    expect(unknown.error?.code).toBe(NOT_PERMITTED);
  });

  it("§8 · `pmcp` is never archived and never reports a connection status — the virtual row has neither", async () => {
    const hub = await fixture();
    const builtin = await builtinRow(hub);
    expect(builtin.archived).toBe(false);
    expect(builtin).not.toHaveProperty("status");
    expect(builtin).not.toHaveProperty("lastSeen");
    expect(builtin).not.toHaveProperty("connection");
  });

  it("§15 · the builtin's log_bodies is fixed ON: its schemas are the hub's own", async () => {
    const hub = await fixture();
    expect((await builtinRow(hub)).logBodies, "the flag the virtual row carries").toBe(true);
    // And observably so: a dispatched builtin call records its bodies, which is the only
    // thing the flag decides (§15).
    await hub.owner(call("account_list", {}), PMCP_SLUG);
    const [recorded] = await auditRows(hub.ownerId, "tools/call");
    expect(recorded.args, "a builtin call's arguments are recorded").toBeDefined();
    expect(recorded.result, "and so is its result").toBeDefined();
  });
});

describe("§8 — service accounts and the builtin, structurally", () => {
  it("§8 · an account holding grants elsewhere sees no `pmcp_*` tool in its aggregated list", async () => {
    const hub = await fixture();
    const names = await toolNames(await hub.account({ method: "tools/list", params: {} }));
    expect(names.filter((name) => name.startsWith(`${PMCP_SLUG}_`))).toEqual([]);
  });

  it("§8 · the same account's aggregated list does carry its granted service's tools (the allow-twin)", async () => {
    const hub = await fixture();
    const names = await toolNames(await hub.account({ method: "tools/list", params: {} }));
    expect(names).toContain(`${NOTION}_${UPSTREAM_TOOL}`);
  });

  it("§8 · an account calling `pmcp_service_list` gets -32001, indistinguishable from an unknown tool", async () => {
    const hub = await fixture();
    const builtin = await hub.account(call(`${PMCP_SLUG}_service_list`, {}));
    const ghost = await hub.account(call("ghost_whatever", {}));
    expect(builtin.error?.code).toBe(NOT_PERMITTED);
    // Byte for byte, not merely code for code — indistinguishability is a sameness property.
    expect(builtin.error).toEqual(ghost.error);
  });

  it("§7 step 2 · an account on scoped /mcp/pmcp gets 404, the same answer as a slug it holds no grants on", async () => {
    const hub = await fixture();
    const builtin = await hub.raw(hub.accountToken, { method: "tools/list", params: {} }, PMCP_SLUG);
    const ungranted = await hub.raw(hub.accountToken, { method: "tools/list", params: {} }, NEWS);
    expect(builtin.status).toBe(404);
    expect(ungranted.status).toBe(404);
    expect(builtin.text, "the hub's ONE 404, byte for byte").toBe(ungranted.text);
  });

  it("§8 · no grant can ever name `pmcp`: there is no service id to reference (the op-level refusal is admin-ops.test.ts's)", async () => {
    const hub = await fixture();
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM service WHERE owner_id = ? AND slug = ?`, hub.ownerId, PMCP_SLUG),
      "no row exists for the builtin, so nothing can reference one",
    ).toBe(0);
    // Structural rather than checked (§8): the grant table's foreign key is what refuses,
    // below any code an op could forget to write.
    await expect(
      db()
        .prepare(`INSERT INTO grant_ (service_account_id, service_id, role, mode) VALUES (?, ?, ?, ?)`)
        .bind(hub.accountId, PMCP_SLUG, "all", "allow")
        .run(),
    ).rejects.toBeDefined();
  });
});

describe("§7 — the owner is never approval-gated", () => {
  it("§7 · an owner's mutating `pmcp` call executes with no approval row created and no push sent", async () => {
    const hub = await fixture();
    const before = (await readObservations(hub.pushId)).length;
    const answered = await hub.owner(call("account_create", { slug: "second-agent" }), PMCP_SLUG);
    expect(answered.error, JSON.stringify(answered.error)).toBeUndefined();
    const accounts = (await ops.account_list.handler(hub.ownerId, {})) as { accounts: { slug: string }[] };
    expect(accounts.accounts.map((a) => a.slug), "the mutation executed").toContain("second-agent");
    expect(await countRows(`SELECT COUNT(*) AS n FROM approval WHERE owner_id = ?`, hub.ownerId)).toBe(0);
    // The owner IS subscribed, so "nothing was sent" is a fact about the gate rather than
    // about an empty subscription table.
    expect((await readObservations(hub.pushId)).length).toBe(before);
  });

  it('§7 · the owner\'s roles forward literally as ["all"], never expanded into declared role names', async () => {
    const hub = await fixture();
    // A proxied service dispatches only once a credential is stored (§7's availability
    // check), and the production seam for that is an admin op — so the fixture reaches the
    // state through the same front everything else here drives.
    await hub.owner(
      call("service_set_upstream_auth", { slug: NOTION, headers: { "X-Api-Key": SENTINEL } }),
      PMCP_SLUG,
    );
    // `notion` declares a role and the owner holds none of it — they hold the built-in.
    await hub.owner(call(`${NOTION}_${UPSTREAM_TOOL}`, { q: "x" }));
    const forwarded = (await readObservations(hub.upstreamId)).filter((o) => o.rpcMethod === "tools/call");
    expect(forwarded.length, "the call reached the upstream").toBeGreaterThan(0);
    expect(forwarded.at(-1)?.pmcpHeaders["x-pmcp-roles"]).toBe("all");
  });
});

describe("§8 — service_list's virtual row", () => {
  it("§8 · service_list includes `pmcp` flagged `builtin: true` while no `service` row exists for it", async () => {
    const hub = await fixture();
    expect((await builtinRow(hub)).builtin).toBe(true);
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM service WHERE slug = ?`, PMCP_SLUG),
      "the flag is synthesized, not stored",
    ).toBe(0);
  });

  it("§8 · the real services in the same listing carry their row fields and no builtin flag (the twin)", async () => {
    const hub = await fixture();
    const notion = (await listedServices(hub)).find((s) => s.slug === NOTION);
    expect(notion).toMatchObject({ kind: "proxy", archived: false, endpoint: hub.upstreamUrl, auth: "headers" });
    expect(notion).not.toHaveProperty("builtin");
  });

  it("§8 · service_get('pmcp') is refused here too — the builtin surfaces only through service_list", async () => {
    const hub = await fixture();
    const answered = await hub.owner(call("service_get", { slug: PMCP_SLUG }), PMCP_SLUG);
    expect(answered.error?.code).toBe(INVALID_PARAMS);
    expect(answered.error?.message).toContain(PMCP_SLUG);
  });
});

describe("§7/§15 — what the caller sees versus what is stored", () => {
  it("§7 · token_issue's plaintext key is present in the CALLER's reply: masking exists for persistence only", async () => {
    const hub = await fixture();
    const answered = await hub.owner(call("token_issue", { kind: "service_account", slug: AGENT }), PMCP_SLUG);
    expect(structured(answered).token, JSON.stringify(answered)).toMatch(/^pmcp_sa_/);
  });

  it("§15 · the same call's recorded result masks that key by the uniform body rule — no pmcp-specific rule exists (the ledger sweep is hygiene.test.ts's)", async () => {
    const hub = await fixture();
    const answered = await hub.owner(call("token_issue", { kind: "service_account", slug: AGENT }), PMCP_SLUG);
    const issued = structured(answered).token as string;
    const [recorded] = await auditRows(hub.ownerId, "tools/call");
    const stored = recorded.result as { structuredContent?: Record<string, unknown> };
    expect(stored.structuredContent?.token, "masked by the writeOnly mark alone").toBe(REDACTED);
    expect(JSON.stringify(recorded), "and the plaintext is nowhere in the row").not.toContain(issued);
  });

  it("§15 · one admin call writes two rows: the gateway's `tools/call` (with duration_ms) and the handler's `admin.<op>`", async () => {
    const hub = await fixture();
    await hub.owner(call("account_create", { slug: "ledger-agent" }), PMCP_SLUG);
    const { rows } = await query(env.DB, hub.ownerId, { limit: 50 });
    const written = rows.filter((row) => row.event === "tools/call" || row.event.startsWith("admin."));
    expect(written.map((row) => row.event).sort()).toEqual(["admin.account_create", "tools/call"]);
    expect(written.find((row) => row.event === "tools/call")?.durationMs).toBeTypeOf("number");
    expect(written.find((row) => row.event.startsWith("admin."))?.durationMs, "a handler measures nothing").toBeUndefined();
  });

  it("§7 · a HubError from a handler leaves through the ONE wire mapping — pinned code, no stack, no echo of the input", async () => {
    const hub = await fixture();
    const answered = await hub.owner(
      call("service_set_upstream_auth", { slug: PMCP_SLUG, headers: { "X-Api-Key": SENTINEL } }),
      PMCP_SLUG,
    );
    const wire = JSON.stringify(answered.error);
    expect(answered.error?.code, "the pinned code, not -32603").toBe(INVALID_PARAMS);
    expect(answered.error?.data, "only -32003 carries data").toBeUndefined();
    expect(wire, "no argument value is ever echoed back — several are credentials").not.toContain(SENTINEL);
    expect(wire).not.toContain("stack");
    expect(wire).not.toContain(".ts:");
  });
});

// ── the namespace every case above drives ─────────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** The fixture's slugs. Neither contains `_`: the aggregated split is at the first one (§7). */
const NOTION = "notion";
const NEWS = "news";
const AGENT = "agent";
const TOKEN = "agent.key";

/** The one tool the fake upstream serves, and the role `notion` declares over it. */
const UPSTREAM_TOOL = "search";
const ROLE = "reader";

/** A value that must never come back out of an error — visibly fake, and shaped like the
 *  credentials `service_set_upstream_auth` really carries. */
const SENTINEL = "FAKE0000-never-echoed-upstream-key";

/** §7's refusal codes as this file observes them, plus JSON-RPC's own for a bad input. */
const NOT_PERMITTED = -32001;
const INVALID_PARAMS = -32602;

/** One seeded world plus the two credentials that drive it. */
type Hub = {
  ns: SeededNamespace;
  ownerId: string;
  accountId: string;
  accountToken: string;
  upstreamId: string;
  upstreamUrl: string;
  pushId: string;
  owner(message: Record<string, unknown>, slug?: string): Promise<JsonRpcResponse>;
  account(message: Record<string, unknown>, slug?: string): Promise<JsonRpcResponse>;
  raw(credential: string, message: Record<string, unknown>, slug?: string): Promise<{ status: number; text: string }>;
};

/**
 * Owner, one proxied service on the fake upstream, one tunneled service nobody is granted
 * on, and one account granted only on the proxied one — so "sees no `pmcp_*` tool" is
 * asserted against an account that demonstrably sees something.
 */
async function fixture(): Promise<Hub> {
  const upstream: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: [{ name: UPSTREAM_TOOL, inputSchema: { type: "object" } }],
  };
  // A push service, not an MCP upstream: `sink` is the mode that says so, and 201 is what
  // a real one answers a delivered notification with.
  const push: UpstreamScenario = { id: uniqueSlug("push"), mode: { kind: "sink", status: 201 } };
  const upstreamUrl = upstreamUrlFor(upstream);
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: NOTION,
        kind: "proxy",
        upstreamUrl,
        upstreamAuthMode: "headers",
        roles: { [ROLE]: [UPSTREAM_TOOL] },
        // §7's identity headers, so the forwarded `hub/roles` is observable at the far end.
        forwardIdentity: true,
      },
      { slug: NEWS, kind: "tunnel" },
    ],
    accounts: [
      { slug: AGENT, grants: { [NOTION]: [{ role: ROLE, mode: "allow" }] }, tokens: [{ as: TOKEN }] },
    ],
  });
  // Subscribed on purpose: a "no push sent" assertion against nobody proves nothing.
  await new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: async () => {} },
    vapid: {
      publicKey: "FAKE0000-vapid-public",
      privateKey: "FAKE0000-vapid-private",
      subject: "mailto:fake@pmcp-test.invalid",
    },
    retentionDays: 7,
    now: Date.now,
  }).subscribePush(ns.owner.userId, {
    endpoint: upstreamUrlFor(push),
    keys: { p256dh: "FAKE0000-p256dh", auth: "FAKE0000-auth" },
  });

  const ownerToken = (await seedOwnerSession(ns.owner)).token;
  const accountToken = ns.tokens[TOKEN].token;
  const raw = async (credential: string, message: Record<string, unknown>, slug?: string) => {
    const url = slug === undefined
      ? `${ORIGIN}/${ns.owner.username}/mcp`
      : `${ORIGIN}/${ns.owner.username}/mcp/${slug}`;
    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
      }),
      env as unknown as Env,
    );
    return { status: response.status, text: await response.text() };
  };
  const speak = (credential: string) => async (message: Record<string, unknown>, slug?: string) => {
    const { status, text } = await raw(credential, message, slug);
    if (status !== 200) throw new Error(`the door answered ${status}: ${text}`);
    return JSON.parse(text) as JsonRpcResponse;
  };

  return {
    ns,
    ownerId: ns.owner.userId,
    accountId: ns.accounts[AGENT].id,
    accountToken,
    upstreamId: upstream.id,
    upstreamUrl,
    pushId: push.id,
    owner: speak(ownerToken),
    account: speak(accountToken),
    raw,
  };
}

/** One `tools/call` message, as a consumer spells it. */
function call(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { method: "tools/call", params: { name, arguments: args } };
}

function toolNames(answered: JsonRpcResponse): string[] {
  const result = answered.result as { tools?: { name: string }[] } | undefined;
  if (result?.tools === undefined) throw new Error(`no catalog in ${JSON.stringify(answered)}`);
  return result.tools.map((tool) => tool.name);
}

/** A tools/call result's structured half — the only half §15's masking rule applies to. */
function structured(answered: JsonRpcResponse): Record<string, unknown> {
  const result = answered.result as { structuredContent?: Record<string, unknown> } | undefined;
  if (result?.structuredContent === undefined) throw new Error(`no structuredContent in ${JSON.stringify(answered)}`);
  return result.structuredContent;
}

/** `service_list` as the endpoint serves it — the listing three cases here read. */
async function listedServices(hub: Hub): Promise<Record<string, unknown>[]> {
  const answered = await hub.owner(call("service_list", {}), PMCP_SLUG);
  return structured(answered).services as Record<string, unknown>[];
}

async function builtinRow(hub: Hub): Promise<Record<string, unknown>> {
  const row = (await listedServices(hub)).find((service) => service.slug === PMCP_SLUG);
  if (row === undefined) throw new Error("service_list served no builtin row");
  return row;
}

/** One namespace's rows of one event, newest first — the ledger as audit_query reads it. */
async function auditRows(ownerId: string, event: string): Promise<AuditRow[]> {
  const { rows } = await query(env.DB, ownerId, { event, limit: 50 });
  if (rows.length === 0) throw new Error(`no "${event}" row was written`);
  return rows;
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db().prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

function db(): D1Like {
  return env.DB as D1Like;
}
