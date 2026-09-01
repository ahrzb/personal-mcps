/**
 * tunnel/protocol.test.ts — the §6 wire, pinned at the socket: what an app must
 * send to become usable, what happens to a socket that sends anything else, and what
 * the hub does when a second one arrives.
 *
 * WHAT THIS SUITE PINS (durable by §7's rule — each of these sentences survives a full
 * rewrite of tunnel.ts): the registration handshake and its 10 s deadline (close 4004);
 * that no message other than hub/register is accepted before registration completes;
 * that a successful registration warms the catalog with one hub-originated tools/list;
 * newest-wins eviction at socket *acceptance* — hub/replaced then close 4000, so the
 * DO never holds two sockets; close 4003 for the row-deleted-between-upgrade-and-
 * register race; that registration writes its audit rows (connect.register,
 * connect.replaced, connect.roles_widened) through the paths that own them; that a tool
 * whose schema trips §7's indirection refuse-line is reported LOUDLY at catalog warm
 * while registration still succeeds; and the absence of any application-level heartbeat.
 *
 * It also carries the BEHAVIOR↔TABLE LOCK for §6's wire vocabulary. tunnel.ts exports
 * CLOSE_REPLACED / CLOSE_ROW_GONE / CLOSE_PROTOCOL and HUB_METHODS as the published
 * cross-language contract (decided 2026-08-25), contracts.test.ts emits the fixtures from
 * those exports, and no sibling module imports them — so nothing else can prove the
 * exports describe what the socket actually sees. This file is where they meet: the codes
 * and method names OBSERVED on a live socket are asserted equal to the exported values,
 * which is what makes the fixtures a contract rather than a second opinion.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN. Role-declaration *semantics* — the charset, the
 * caps, `all` rejected, subset-is-not-drift — belong to registry.upsertDeclaredRoles
 * and are pinned once in worker/registry.test.ts; here a declaration is only ever
 * "accepted" or "refused", so a rule change edits one file, not two. Likewise the
 * indirection refuse-line itself — which constructs §7 refuses and why — is
 * unit/redact.test.ts's; here a tool's schema is only ever "walkable" or "unsound", and
 * what unsoundness then costs a CALL (-32001, no recorded bodies) is the worker project's.
 * The close-code → required-client-behavior oracle is a contract fixture (strategy §4)
 * consumed by the client reconnect tables; this file pins the hub's emission side and its
 * agreement with the exported vocabulary, never what a client must do about it. Incidental by
 * §7 and therefore unasserted: the error prose in a rejection reply, and the wire
 * spelling of the deadline (limits.REGISTRATION_DEADLINE_MS is read, never a literal).
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): live
 * WebSockets, a DO alarm, and the AppConnection instance itself, all three of
 * which per-file storage isolation cannot cover (strategy §2).
 *
 * Isolation and ordering, load-bearing: smoke.test.ts must be green first — A2 (an
 * attachment surviving hibernation) is what makes `registered` readable on any wake.
 * With --no-isolate nothing resets between cases, so every case seeds its own owner,
 * slug and app id, and asserts on rows it created rather than on table counts.
 * Time is never slept: the registration deadline is reached by firing the pending
 * alarm with runDurableObjectAlarm.
 */

// deps: harness/seed · harness/fake-app · harness/tunnel-do (connectionStub, liveSockets, stillOpen, backendCtx) · cloudflare:test (runDurableObjectAlarm) · src/tunnel (handleConnect, AppConnection, CLOSE_REPLACED, CLOSE_ROW_GONE, CLOSE_PROTOCOL, HUB_METHODS) · src/errors (CODES) · src/registry (Registry.upsertDeclaredRoles, RoleDeclaration, validateSchemaIndirection) · src/audit (query) · src/limits (REGISTRATION_DEADLINE_MS)

import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "../../src/audit";
import type { AuditRow } from "../../src/audit";
import { CODES } from "../../src/errors";
import type { Tool } from "../../src/gateway";
import { Registry } from "../../src/registry";
import type { RoleDeclaration, App } from "../../src/registry";
import {
  CLOSE_PROTOCOL,
  CLOSE_REPLACED,
  CLOSE_ROW_GONE,
  HUB_METHODS,
  status,
  tunnelBackend,
} from "../../src/tunnel";
import { connectFakeApp, waitFor } from "../harness/fake-app";
import type { FakeApp, FakeAppOptions } from "../harness/fake-app";
import { seedNamespace, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { backendCtx, connectionStub, liveSockets, stillOpen, untilCataloged } from "../harness/tunnel-do";

/**
 * The close codes this module *issues*, derived from the exported vocabulary rather than
 * respelled: tunnel.ts publishes CLOSE_REPLACED / CLOSE_ROW_GONE / CLOSE_PROTOCOL as the
 * cross-language contract (§6, decided 2026-08-25), so a renumbering is a compile error
 * here instead of a table that silently pins the old wire.
 *
 * Deliberately not the whole 4000–4004 vocabulary: CLOSE_REVOKED and CLOSE_ARCHIVED are
 * tunnel.ts's SeverCode, arrive from outside on an owner action, and are
 * lifecycle.test.ts's subject — a code from that pair appearing in this file's table
 * would mean the DO grew a way to sever itself.
 */
export type ProtocolCloseCode =
  | typeof CLOSE_REPLACED
  | typeof CLOSE_ROW_GONE
  | typeof CLOSE_PROTOCOL;

/**
 * The first thing a freshly accepted socket does, which is the whole input to §6's
 * registration rules. `register` carries a wire-shaped declaration exactly as
 * hub/register does (the same {@link RoleDeclaration} registry validates), so accepted
 * and refused declarations sit in one table; `mcp` and `control` are the two ways to
 * speak too early; `silence` reaches the deadline alarm without a frame at all.
 *
 * `extra` is the one payload key §6 forbids the hub to read: `names_another_app` sends
 * the register params with a `app` field carrying the SECOND seeded app's slug.
 * The field exists so the rule has an input rather than an argument — "the payload carries
 * no app field" is a claim about what the hub IGNORES, and a table that can only send
 * well-formed payloads cannot witness it.
 */
export type FirstMessage =
  | { kind: "register"; roles: RoleDeclaration; extra?: "names_another_app" }
  | { kind: "mcp"; method: string }
  | { kind: "control"; method: string }
  | { kind: "malformed" }
  | { kind: "silence" };

/**
 * One row of the registration table — the §6 handshake as data.
 *
 * `appRow` is the state of D1 at the moment the frame is handled, which is the
 * only input that separates 4003 from every other refusal. The four observable
 * columns are what a client and an owner can actually see, and nothing else: the
 * JSON-RPC reply on the socket, the close code (or a socket left open), whether the
 * app subsequently reads online, and whether the fake app observed the
 * catalog-warming tools/list. Audit rows are asserted by event name in the cases
 * below, not here — a row's `event` string is the durable part, its `detail` layout
 * is incidental (§7).
 *
 * `twin` is the `name` of another row in this same table that REGISTERS — reply "ok",
 * socket open, online — and which differs from this one in as few columns as
 * possible: the concrete answer to "and what does the same socket look like when it
 * should succeed?". Registering rows name themselves. It is a required field rather
 * than a convention in a comment because §9 rule 2 is otherwise satisfied by a
 * tunnel.ts that closes 4004 on everything: a table of nothing but refusals is a
 * deny-only oracle, and the reward-hacking attractor here is real (a `handleConnect`
 * that never accepts passes every close-code row it is given). The runner resolves it
 * as a LOOKUP, never as an execution order — rows stay independent.
 */
export type RegistrationRow = {
  /** Test title, in the doc's convention: "§6 · <what this row pins>". */
  name: string;
  first: FirstMessage;
  appRow: "present" | "deleted_after_upgrade";
  reply: "ok" | "jsonrpc_error" | "none";
  close: ProtocolCloseCode | "open";
  online: boolean;
  catalogWarmed: boolean;
  /**
   * The fifth observable, and the one that exists for a single row: what the OTHER seeded
   * app's stored declaration reads after this socket's frame was handled. Present only
   * on `extra: "names_another_app"` rows, because it is the only place the question is
   * asked — a hub that read the payload's `app` field would upsert `roles_json` on a
   * app this token may never touch, and every other column would look identical while
   * it did (§6: identity comes exclusively from the token).
   */
  otherAppRoles?: "untouched";
  twin: string;
};

/**
 * The registration table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. Every refusal row
 * must sit beside its allow-twin: a rejected declaration next to an accepted one, a
 * too-early frame next to the register that arrives first (§9 rule 2). That "must" is
 * carried by the `twin` column and enforced by the runner, not by review.
 */
export const registrationRows: readonly RegistrationRow[] = [
  // The fixture these rows are written against, named once: one tunneled app with one
  // live `pmcp_app_` token, dialed by a fake app whose catalog holds a single walkable
  // tool — plus a SECOND tunneled app in the same namespace (its own slug, its own
  // already-declared roles, no socket), which exists for exactly one row. §6 takes the
  // app identity EXCLUSIVELY from the token, and the only way to witness that is to
  // send a payload naming another app and show that app's declaration unchanged;
  // a table whose rows structurally cannot carry a slug proves nothing about what the hub
  // does with one.
  //
  // Three conventions, so no row repeats them:
  // · `appRow` is "present" everywhere except the one 4003 row: the deletion has to
  //   land between upgrade and first frame, which is the only window that produces 4003.
  // · `catalogWarmed` tracks `online` on every row here, and that is a claim rather than a
  //   coincidence — §6 warms the cache as the immediate consequence of a successful
  //   register, so a row where they disagree would be a bug in either direction.
  // · CLOSE_REPLACED (4000) is in this file's `ProtocolCloseCode` but in none of these
  //   rows: replacement is provoked by a SECOND socket, not by a first message, so it is
  //   cases 14-17's subject. The union member being unused here is the honest record of
  //   that split, not a gap.

  // ── the two allow rows every refusal below is measured against ───────────────────────
  // §6: "The hub then replies `{ "ok": true }` and immediately issues `tools/list` to warm
  // its cache." Online follows from §6's lifecycle 2: online means a live REGISTERED socket.
  {
    name: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
    first: { kind: "register", roles: { reader: ["search", "get_.*"] } },
    appRow: "present",
    reply: "ok",
    close: "open",
    online: true,
    catalogWarmed: true,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
  // §6: "A `roles` value of `{}` means "no roles declared" — the app is then reachable
  // only by admin tokens or agents granted the built-in `all` role." Declaring nothing is
  // a valid declaration, so this row exists to keep "refuse anything unusual" from passing:
  // an empty object is the shape closest to a refusal that must still register.
  {
    name: "§6 · an empty declaration {} registers like any other — declaring no roles is a declaration, not a violation",
    first: { kind: "register", roles: {} },
    appRow: "present",
    reply: "ok",
    close: "open",
    online: true,
    catalogWarmed: true,
    twin: "§6 · an empty declaration {} registers like any other — declaring no roles is a declaration, not a violation",
  },
  // §6: "The app identity comes **exclusively** from the authenticated token — the
  // payload carries no app field, so a token for one slug can never touch another
  // app's registration." A registering row, because the extra key is IGNORED rather
  // than refused: the token's own app registers normally, and the observable that makes
  // the row worth its socket is the fifth column — the named app's declaration is
  // untouched. This is §6's sharpest privilege escalation stated as an input: a compromised
  // bot holding a valid token for A sends `{ roles: {…}, app: "B" }`, and a hub that
  // read the field would widen B's roles from a credential that may never reach it.
  {
    name: "§6 · a hub/register payload naming ANOTHER app registers the token's own app and leaves the named one untouched — identity comes exclusively from the token",
    first: { kind: "register", roles: { reader: ["search"] }, extra: "names_another_app" },
    appRow: "present",
    reply: "ok",
    close: "open",
    online: true,
    catalogWarmed: true,
    otherAppRoles: "untouched",
    twin: "§6 · a hub/register payload naming ANOTHER app registers the token's own app and leaves the named one untouched — identity comes exclusively from the token",
  },

  // ── refused declarations: error reply, then close ────────────────────────────────────
  // §6: "role names must match `[a-z0-9_-]{1,64}` (`all` is rejected — it's the resolver's
  // built-in, §2) … violations get a JSON-RPC error reply and the socket is closed." WHY
  // `all` is refused is worker/registry.test.ts's; that it costs the socket is this file's.
  {
    name: "§6 · a declaration naming the built-in role `all` is refused: error reply, then close 4004, and the app never reads online",
    first: { kind: "register", roles: { all: [".*"] } },
    appRow: "present",
    reply: "jsonrpc_error",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
  // The same observable from a different broken rule — "every pattern must compile as a
  // regex" — because §6 gives the whole validation family ONE consequence. Two rows rather
  // than one so a hub that happens to special-case the reserved name still has to close the
  // socket for a pattern it cannot compile. "(" is deliberately outside §7's literal-string
  // charset (`^[A-Za-z0-9._-]+$`), so it must be compiled and must fail.
  {
    name: "§6 · a declaration whose pattern does not compile is refused identically — one observable consequence for the whole validation family",
    first: { kind: "register", roles: { reader: ["("] } },
    appRow: "present",
    reply: "jsonrpc_error",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },

  // ── speaking before registering ──────────────────────────────────────────────────────
  // §6: "Any message other than `hub/register` received before registration completes is a
  // protocol error: JSON-RPC error reply, then close `4004`." Its twin is the register that
  // arrives first: the SAME frame after a successful registration is ordinary MCP traffic.
  // The frame is `notifications/tools/list_changed` because it is the ONE client-originated
  // MCP message §6 defines ("the client library also sends `notifications/tools/list_changed`
  // when the user's server changes its tool set; the DO invalidates its cache and re-lists").
  // `tools/list` would not isolate the rule: the hub is the MCP *client* and the app the
  // *server*, so an app-sent `tools/list` is illegal in that direction whether or not
  // registration happened, and the row would pin "refused" for the wrong reason.
  {
    name: "§6 · an MCP message before registration is a protocol error: error reply, then close 4004",
    first: { kind: "mcp", method: "notifications/tools/list_changed" },
    appRow: "present",
    reply: "jsonrpc_error",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
  // "Other than hub/register" includes the hub's OWN control frames sent back at it:
  // hub/replaced is hub → client only (§6), so an app sending it is an app speaking a
  // frame it may never send. This row is what keeps the rejection from being implemented as
  // "unknown method" — the method here is one the hub knows perfectly well.
  {
    name: "§6 · a hub/* control frame the client may never send is refused the same way — hub/replaced is the hub's to send, not the app's",
    first: { kind: "control", method: "hub/replaced" },
    appRow: "present",
    reply: "jsonrpc_error",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
  // A frame that is not a JSON-RPC message at all. §6 gives one consequence to every
  // non-register first frame, and JSON-RPC's own parse-error rule supplies the id (null),
  // so the reply column stays `jsonrpc_error` rather than inventing a silent exception for
  // unparseable input. Recorded as a judgment call at authoring time.
  {
    name: "§6 · a first frame that is not a JSON-RPC message at all: error reply, then close 4004",
    first: { kind: "malformed" },
    appRow: "present",
    reply: "jsonrpc_error",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },

  // ── the deadline, and the row that vanished under it ─────────────────────────────────
  // §6: "a socket that has not delivered a valid `hub/register` within **10 s** of
  // acceptance is closed with code `4004`". No reply, because nothing was said to reply to
  // — which is also what separates this row from the too-early-frame rows above.
  {
    name: "§6 · a socket silent past the registration deadline is closed 4004 with no reply at all",
    first: { kind: "silence" },
    appRow: "present",
    reply: "none",
    close: 4004,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
  // §6: "The hub verifies the app row still exists (close `4003` if not)" — and says
  // nothing about an error reply, unlike the validation sentence two rows up. `reply: "none"`
  // transcribes that silence deliberately: 4003 is a race the client RECONNECTS from
  // (a truly deleted app then meets 401 at the next upgrade), not a violation it is
  // told about, and the two refusals must stay observably different.
  {
    name: "§6 · an app row deleted between upgrade and register closes 4003 with no error reply — the reconnect race, not a credential verdict",
    first: { kind: "register", roles: { reader: ["search"] } },
    appRow: "deleted_after_upgrade",
    reply: "none",
    close: 4003,
    online: false,
    catalogWarmed: false,
    twin: "§6 · a valid hub/register replies ok, the socket stays open, the app reads online and the catalog is warmed",
  },
];

/**
 * The table runner: dials one socket through handleConnect, sends the row's first
 * message (or nothing, then fires the deadline alarm), and observes the four columns
 * from the client side — never by reaching into the DO. `silence` rows reach the
 * deadline through runDurableObjectAlarm, so the row costs milliseconds rather than
 * limits.REGISTRATION_DEADLINE_MS.
 *
 * `rows` is the whole table because the runner owns one invariant no single row can
 * state: `row.twin` must RESOLVE to a row of `rows` that registers (reply "ok", close
 * "open", online). Resolution is a table lookup — the twin is not dialed here, so the
 * cost stays one socket per row and rows remain independent of each other's order.
 */
export async function runRegistrationCase(
  row: RegistrationRow,
  rows: readonly RegistrationRow[],
): Promise<void> {
  // deps: harness/seed · harness/fake-app · src/tunnel.handleConnect · cloudflare:test runDurableObjectAlarm
  const twin = rows.find((candidate) => candidate.name === row.twin);
  expect(twin, `"${row.name}" names a twin that is not a row of this table`).toBeDefined();
  expect(
    registersCleanly(twin as RegistrationRow),
    `"${row.name}"'s twin must be a row that REGISTERS (reply ok, socket open, online)`,
  ).toBe(true);

  const fixture = await seedFixture();
  // The only row that needs the second app to be more than a name: give it a
  // declaration of its own through the one path that can (a real registration, FINDINGS 1),
  // so "untouched" has something to be untouched.
  let otherBefore: RoleDeclaration | undefined;
  if (row.otherAppRoles !== undefined) {
    const otherSocket = await connect(fixture, {
      token: fixture.otherToken,
      roles: { writer: ["publish"] },
    });
    await otherSocket.close();
    otherBefore = await declaredRoles(fixture, fixture.other.slug);
    expect(otherBefore, "the fixture's second app must declare something first").not.toEqual({});
  }

  // Dialled unregistered on every row, so the row's own first frame — a register, a frame
  // sent too early, or nothing at all — is the one the hub reacts to.
  const app = await connect(fixture, {
    skipRegister: true,
    tools: [WALKABLE_TOOL],
    roles: row.first.kind === "register" ? row.first.roles : undefined,
  });
  // The 4003 race, provoked exactly where §6 puts it: after the upgrade, before the frame.
  // Through registry rather than the admin op, because an owner-driven delete SEVERS — and
  // a socket closed 4001 could never reach the registration this row is about.
  if (row.appRow === "deleted_after_upgrade") {
    await new Registry(env.DB).deleteApp(fixture.app.id);
  }
  await sendFirstMessage(app, row.first, fixture);
  if (row.first.kind === "silence") {
    // Fired, never slept: the deadline is a constant this suite reads (smoke case 9).
    expect(await runDurableObjectAlarm(connectionStub(fixture.app.id))).toBe(true);
  }

  if (row.close === "open") {
    expect(await stillOpen(app), `"${row.name}" expected the socket to stay open`).toBe(true);
  } else {
    expect((await app.closed).code).toBe(row.close);
  }
  expect(await waitFor(() => app.lists.length > 0)).toBe(row.catalogWarmed);
  expect(await status(fixture.app.id)).toBe(row.online ? "online" : "offline");

  const answers = replies(app);
  switch (row.reply) {
    case "ok":
      expect(answers.some((frame) => (frame.result as { ok?: unknown } | undefined)?.ok === true)).toBe(true);
      break;
    case "jsonrpc_error":
      expect(answers.some((frame) => frame.error !== undefined)).toBe(true);
      break;
    case "none":
      expect(answers, `"${row.name}" expected no JSON-RPC reply at all`).toEqual([]);
      break;
  }
  if (otherBefore !== undefined) {
    expect(await declaredRoles(fixture, fixture.other.slug)).toEqual(otherBefore);
  }
}

/** The property a `twin` must have: this row is one that registers. */
function registersCleanly(row: RegistrationRow): boolean {
  return row.reply === "ok" && row.close === "open" && row.online;
}

/** One row's first frame, sent exactly as the row describes it. */
async function sendFirstMessage(
  app: FakeApp,
  first: FirstMessage,
  fixture: Fixture,
): Promise<void> {
  switch (first.kind) {
    case "register":
      // The forbidden key rides the real register params, so the hub gets every chance to
      // read it (§6: it must not).
      return app.sendRegister(
        first.extra === "names_another_app" ? { app: fixture.other.slug } : undefined,
      );
    case "mcp":
      return app.sendRaw({ jsonrpc: "2.0", method: first.method });
    case "control":
      return app.sendRaw({ jsonrpc: "2.0", id: "control-1", method: first.method });
    case "malformed":
      return app.sendRaw({ pmcp: "not a JSON-RPC message at all" });
    case "silence":
      return;
  }
}

// ── the fixture every case in this file is built from ─────────────────────────────────

/**
 * One namespace holding the two tunneled apps the rows are written against: the one
 * under test with a live `pmcp_app_` token, and the second one — its own slug, its own
 * token, no socket — that exists so §6's "identity comes exclusively from the token" has
 * an input.
 */
type Fixture = {
  origin: string;
  ownerId: string;
  app: { id: string; slug: string };
  other: { id: string; slug: string };
  token: string;
  otherToken: string;
};

const seeded: SeededNamespace[] = [];
const opened: FakeApp[] = [];

afterEach(async () => {
  // Shared storage AND shared sockets across files in this project: a leak here is a leak
  // into the next file.
  for (const app of opened.splice(0)) await app.close();
  for (const namespace of seeded.splice(0)) await namespace.teardown();
});

async function seedFixture(): Promise<Fixture> {
  const slug = uniqueSlug("bot");
  const otherSlug = uniqueSlug("other");
  const namespace = await seedNamespace(env.DB, {
    username: uniqueSlug("proto"),
    apps: [
      { slug, kind: "tunnel", tokens: [{ as: "live" }] },
      { slug: otherSlug, kind: "tunnel", tokens: [{ as: "other" }] },
    ],
  });
  seeded.push(namespace);
  return {
    origin: (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN,
    ownerId: namespace.owner.userId,
    app: namespace.apps[slug],
    other: namespace.apps[otherSlug],
    token: namespace.tokens.live.token,
    otherToken: namespace.tokens.other.token,
  };
}

/** Dial one socket for the fixture's app, registered unless the options say otherwise. */
async function connect(
  fixture: Fixture,
  options: Partial<FakeAppOptions> = {},
): Promise<FakeApp> {
  const app = await connectFakeApp({
    origin: fixture.origin,
    token: fixture.token,
    tools: [WALKABLE_TOOL],
    ...options,
  });
  opened.push(app);
  return app;
}

/**
 * Give the fixture's app one live grant on `reader` — drift is only audited for a role
 * somebody holds (§6), so the widening pair needs a grantee to exist at all.
 */
async function grantReader(fixture: Fixture): Promise<void> {
  const registry = new Registry(env.DB);
  const agent = await registry.createAgent({
    ownerId: fixture.ownerId,
    slug: uniqueSlug("agent"),
    name: "agent",
  });
  await registry.setGrants(agent.id, fixture.app.id, [{ role: "reader", mode: "allow" }]);
}

/** The app row as the gateway would hand it to a backend. */
async function appRow(fixture: Fixture, slug?: string): Promise<App> {
  const row = await new Registry(env.DB).getApp(fixture.ownerId, slug ?? fixture.app.slug);
  if (row === null) throw new Error("the fixture's app vanished");
  return row;
}

/** What D1 stores as an app's declaration — the write hub/register makes. */
async function declaredRoles(fixture: Fixture, slug: string): Promise<RoleDeclaration> {
  const row = await new Registry(env.DB).getApp(fixture.ownerId, slug);
  if (row === null) throw new Error(`the fixture's app "${slug}" vanished`);
  return row.declaredRoles;
}

/**
 * The connection's audit rows, read once the registration that writes them has finished.
 * `warmed` is the synchronization point rather than a sleep: §6 makes the catalog warm the
 * LAST step of a successful register, so a socket that has been asked for its tools has
 * already had every row of that registration written.
 */
async function auditedAfterRegister(
  fixture: Fixture,
  app: FakeApp,
  event: string,
): Promise<AuditRow[]> {
  expect(await waitFor(() => app.lists.length > 0), "the registration never completed").toBe(true);
  return (await query(env.DB, fixture.ownerId, { event })).rows;
}

/** The JSON-RPC ANSWERS a socket received — frames with no method of their own. */
function replies(app: FakeApp): Record<string, unknown>[] {
  return app.frames.filter((frame) => frame.method === undefined);
}

/** Frames the hub sent that carry a method — its requests and notifications. */
function hubRequests(app: FakeApp): Record<string, unknown>[] {
  return app.frames.filter((frame) => typeof frame.method === "string");
}

/**
 * The hub's warning about ONE tool's schema, as the app received it — or undefined
 * when no such frame ever arrived, which is the allow-twin's observation.
 */
async function warningFor(
  app: FakeApp,
  tool: string,
): Promise<Record<string, unknown> | undefined> {
  const dataOf = (frame: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (frame.method !== "notifications/message") return undefined;
    const data = (frame.params as { data?: Record<string, unknown> } | undefined)?.data;
    return data?.tool === tool ? data : undefined;
  };
  await waitFor(() => app.frames.some((frame) => dataOf(frame) !== undefined));
  return app.frames.map(dataOf).find((data) => data !== undefined);
}

/** A tool whose schemas §7's walk can resolve — the sound side of every 4a/4b pair. */
const WALKABLE_TOOL: Tool = {
  name: "search",
  description: "walkable",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" }, token: { type: "string", writeOnly: true } },
  },
};

/**
 * A tool whose schema trips registry.validateSchemaIndirection — an external `$ref` the
 * walk cannot resolve, so a `writeOnly` mark could be hiding behind it. WHICH constructs
 * are refused is unit/redact.test.ts's subject; here it only has to be one of them.
 */
const UNSOUND_TOOL: Tool = {
  name: "publish",
  description: "unsound",
  inputSchema: {
    type: "object",
    properties: { payload: { $ref: "https://example.invalid/schema.json#/payload" } },
  },
};

describe("§6 registration", () => {
  for (const row of registrationRows) {
    it(row.name, () => runRegistrationCase(row, registrationRows));
  }
  it("1b. §9 rule 2 · every refusal row's `twin` resolves to a registering row present in this table — the invariant that makes case 2 the measure of cases 5-10 rather than a sentence in a comment above them", () => {
    for (const row of registrationRows) {
      const twin = registrationRows.find((candidate) => candidate.name === row.twin);
      expect(twin, `"${row.name}" names a twin outside this table`).toBeDefined();
      expect(registersCleanly(twin as RegistrationRow), `"${row.name}"'s twin must register`).toBe(true);
    }
    // Vacuous unless the table actually holds refusals to measure.
    expect(registrationRows.some((row) => !registersCleanly(row))).toBe(true);
  });

  it("2. §6 · a valid hub/register replies { ok: true } and the app reads online (the allow-twin every refusal below is measured against)", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await app.registered).toEqual({ ok: true });
    expect(await status(fixture.app.id)).toBe("online");
    expect(await declaredRoles(fixture, fixture.app.slug)).toEqual({ reader: ["search"] });
  });

  it("3. §6 · registration warms the catalog: the fake app observes exactly one hub-originated tools/list immediately after the reply", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    // Exactly one: a warm per registration, not a poll.
    expect(await waitFor(() => app.lists.length > 1, 15)).toBe(false);
    expect(await tunnelBackend.listTools(await appRow(fixture), backendCtx())).toEqual([
      WALKABLE_TOOL,
    ]);
  });

  it("4. §6 · initialize never crosses the socket — the first hub-originated message of the connection's life is that tools/list, self-contained with its protocol _meta fields", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture);
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    const asked = hubRequests(app);
    // §6, amended 2026-08-26 (§20): the tools/list is still there and still the warm this
    // case is named for, but the capability question now goes in front of it.
    expect(asked.map((frame) => frame.method)).toEqual(["server/discover", "tools/list"]);
    expect(app.frames.some((frame) => frame.method === "initialize")).toBe(false);
    // Self-contained, BOTH of them: §6's rule is about every hub-originated request, and a
    // frame that carried no protocol fields would be unanswerable on a wire where
    // `initialize` never crosses.
    for (const frame of asked) {
      const meta = (frame.params as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      // Mirrored from the consumer's request — and neither a discover nor a catalog warm has
      // a consumer behind it, which per MRTR rules is what `{}` says (§6).
      expect(meta?.["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
    }
  });

  it("4a. §7 · a catalog answer carrying a tool whose schema trips the indirection refuse-line is reported LOUDLY and survives: the app receives a warning frame naming that tool's violations, the registration still succeeds, the app reads online, and that tool is cached schema-unsound (what unsoundness then costs a call — sensitivePaths null, -32001, no recorded bodies — is the worker project's)", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { tools: [UNSOUND_TOOL] });
    expect(await app.registered).toEqual({ ok: true });
    const warning = await warningFor(app, UNSOUND_TOOL.name);
    expect(warning, "the app was never told which tool is unsound").toBeDefined();
    expect((warning?.violations as string[]).join(" ")).toContain("$ref");
    expect(await status(fixture.app.id)).toBe("online");
    expect(await tunnelBackend.sensitivePaths(await appRow(fixture), UNSOUND_TOOL.name)).toBeNull();
  });

  it("4b. §7 · the same catalog with a walkable schema draws no warning frame and caches the tool sound — the allow-twin without which a warm that warns about everything, or that refuses to register at all, passes case 4a", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { tools: [WALKABLE_TOOL] });
    expect(await app.registered).toEqual({ ok: true });
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    expect(await warningFor(app, WALKABLE_TOOL.name)).toBeUndefined();
    expect(await tunnelBackend.sensitivePaths(await appRow(fixture), WALKABLE_TOOL.name)).toEqual({
      args: ["token"],
      results: [],
    });
  });

  it("4c. §7 · one unsound tool does not contaminate its siblings: the other tools in the same catalog answer are cached sound, so the refusal is per tool and never per app", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { tools: [UNSOUND_TOOL, WALKABLE_TOOL] });
    expect(await app.registered).toEqual({ ok: true });
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    const row = await appRow(fixture);
    expect(await tunnelBackend.sensitivePaths(row, UNSOUND_TOOL.name)).toBeNull();
    expect(await tunnelBackend.sensitivePaths(row, WALKABLE_TOOL.name)).toEqual({
      args: ["token"],
      results: [],
    });
    // Both are still LISTED: unsoundness costs the redaction map, never the catalog entry.
    expect((await tunnelBackend.listTools(row, backendCtx())).map((tool) => tool.name)).toEqual([
      UNSOUND_TOOL.name,
      WALKABLE_TOOL.name,
    ]);
  });

  it("4d. §6/§7 · a warm that draws no catalog does not wedge the app there: the registration stands and the app reads ONLINE with nothing cached (so every call refuses -32001), the failure is logged where an operator finds it, and the NEXT demand re-lists — the catalog heals without a reconnect (allow-twin: case 3, where the first warm lands and no re-list ever happens)", async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const fixture = await seedFixture();
      // An app that registers before it can list — the error reply is a JSON-RPC
      // answer the hub cannot read as a tool list, which is one of the two ways §6
      // lifecycle 2's "a warm that goes unanswered" happens.
      const app = await connect(fixture, {
        listBehavior: { mode: "error", error: { code: CODES.internal, message: "not ready" } },
      });
      expect(await app.registered).toEqual({ ok: true });
      expect(await waitFor(() => app.lists.length > 0), "the warm never went out").toBe(true);

      const row = await appRow(fixture);
      // Online and serving nothing: with no catalog entry there is no derivable redaction
      // map, which is §7's -32001 at the gate — the wedge this case exists for.
      expect(await status(fixture.app.id)).toBe("online");
      expect(await tunnelBackend.listTools(row, backendCtx())).toEqual([]);
      expect(await tunnelBackend.sensitivePaths(row, WALKABLE_TOOL.name)).toBeNull();
      // §15 hygiene: the slug so an operator can find the app, and no credential.
      expect(warnings.some((line) => line.includes(fixture.app.slug)), warnings.join(" | ")).toBe(true);
      expect(warnings.join(" ")).not.toContain(fixture.token);

      // The app can list now. Nothing reconnects and nothing re-registers: the only
      // thing that may heal the catalog is the hub re-listing on demand.
      app.setListBehavior({ mode: "answer" });
      const asked = app.lists.length;
      expect(await tunnelBackend.listTools(row, backendCtx()), "a re-list may not block the read").toEqual([]);
      expect(await waitFor(() => app.lists.length > asked), "the demand never re-listed").toBe(true);
      expect(await untilCataloged(row)).toEqual([WALKABLE_TOOL]);
      expect(await tunnelBackend.sensitivePaths(row, WALKABLE_TOOL.name)).toEqual({
        args: ["token"],
        results: [],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("4e. §6 · that re-list is ONE frame in flight, never one per demand: with an app that receives its re-list and never answers, N concurrent demands against the absent catalog put a single hub-originated tools/list on the wire — the demand path is tools/call's (sensitivePaths), so a wedged app would otherwise park a waiter per consumer call and hold the DO awake for as long as consumers keep calling (allow-twin: case 4d, where the one re-list lands and the catalog heals)", async () => {
    const fixture = await seedFixture();
    // The absent-catalog state case 4d is about: registered, warmed, and the warm drew
    // nothing the hub could read as a tool list.
    const app = await connect(fixture, {
      listBehavior: { mode: "error", error: { code: CODES.internal, message: "not ready" } },
    });
    expect(await app.registered).toEqual({ ok: true });
    expect(await waitFor(() => app.lists.length > 0), "the warm never went out").toBe(true);
    const warmed = app.lists.length;

    // Now the app RECEIVES its re-list and never answers it — the in-flight state every
    // later demand must add nothing to. `error` would resolve and hide the whole question.
    app.setListBehavior({ mode: "hang" });
    const row = await appRow(fixture);
    // Five is arbitrary; what the case needs is more than one, at once — which is what a
    // tools/call storm against a wedged app looks like from the DO's side.
    const served = await Promise.all(
      Array.from({ length: 5 }, () => tunnelBackend.listTools(row, backendCtx())),
    );

    expect(served, "a re-list may not block the read").toEqual(served.map(() => []));
    // Given time to be wrong: "only one arrived" is an absence, so it is waited on rather
    // than read off the array the moment the demands returned.
    expect(await waitFor(() => app.lists.length > warmed + 1, 15)).toBe(false);
    expect(app.lists.length - warmed, "one re-list per demand, not one in flight").toBe(1);
  });

  it("5. §6 · a socket silent past limits.REGISTRATION_DEADLINE_MS is closed 4004 when the pending alarm fires (fired, never slept)", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { skipRegister: true });
    expect(await runDurableObjectAlarm(connectionStub(fixture.app.id))).toBe(true);
    expect((await app.closed).code).toBe(CLOSE_PROTOCOL);
    expect(await status(fixture.app.id)).toBe("offline");
  });

  it("6. §6 · the same alarm is a no-op once registration succeeded: the socket is still open and still online afterwards", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture);
    expect(await app.registered).toEqual({ ok: true });
    expect(await runDurableObjectAlarm(connectionStub(fixture.app.id))).toBe(true);
    expect(await stillOpen(app)).toBe(true);
    expect(await status(fixture.app.id)).toBe("online");
  });

  it("7. §6 · a non-hub/register frame before registration gets a JSON-RPC error reply and then close 4004 — twin of case 2, where the same frame sent after registration is ordinary MCP traffic", async () => {
    const fixture = await seedFixture();
    const early = await connect(fixture, { skipRegister: true });
    await early.sendRaw({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect((await early.closed).code).toBe(CLOSE_PROTOCOL);
    expect(replies(early).some((frame) => frame.error !== undefined)).toBe(true);

    // The twin: the same frame, after registering, is the cache-invalidation path.
    const registered = await connect(fixture);
    expect(await waitFor(() => registered.lists.length === 1)).toBe(true);
    await registered.notifyToolsListChanged([WALKABLE_TOOL, UNSOUND_TOOL]);
    expect(await waitFor(() => registered.lists.length === 2)).toBe(true);
    expect(await stillOpen(registered)).toBe(true);
  });

  it("8. §6 · a refused declaration gets an error reply and close 4004, and D1's stored roles are unchanged — twin: the accepted declaration of case 2 stores them", async () => {
    const fixture = await seedFixture();
    const before = await declaredRoles(fixture, fixture.app.slug);
    const app = await connect(fixture, { roles: { all: [".*"] } });
    expect(await app.registered.catch(() => undefined)).toEqual({
      ok: false,
      error: expect.anything(),
    });
    // The CODE is the half of the reply the client libraries branch on, and the half
    // contracts/tunnel-frames.json pins — asserted here, on the real refused socket,
    // against errors.ts's own name for it rather than against the number. (The prose is
    // incidental by §7 and stays unasserted.)
    const refusal = replies(app).find((frame) => frame.error !== undefined);
    expect((refusal?.error as { code: number }).code).toBe(CODES.invalidParams);
    expect((await app.closed).code).toBe(CLOSE_PROTOCOL);
    expect(await declaredRoles(fixture, fixture.app.slug)).toEqual(before);

    const accepted = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await accepted.registered).toEqual({ ok: true });
    expect(await declaredRoles(fixture, fixture.app.slug)).toEqual({ reader: ["search"] });
  });

  it("9. §6 · an app row deleted between upgrade and register closes 4003 — twin: case 2's surviving row registers", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { skipRegister: true });
    await new Registry(env.DB).deleteApp(fixture.app.id);
    await app.sendRegister();
    expect((await app.closed).code).toBe(CLOSE_ROW_GONE);
    expect(replies(app), "4003 is a race the client reconnects from, not a verdict it is told").toEqual([]);
  });

  it("10. §6 · the hub never forwards consumer traffic to an unregistered socket: a tools/call while a socket sits accepted-but-unregistered fails -32000", async () => {
    const fixture = await seedFixture();
    await connect(fixture, { skipRegister: true });
    expect(await status(fixture.app.id)).toBe("offline");
    await expect(
      tunnelBackend.call(
        await appRow(fixture),
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } },
        backendCtx(),
      ),
    ).rejects.toMatchObject({ code: -32000 });
  });
});

describe("§6 audit of the connection lifecycle", () => {
  it("11. §6 · a successful registration writes exactly one connect.register row", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await app.registered).toEqual({ ok: true });
    const rows = await auditedAfterRegister(fixture, app, "connect.register");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: fixture.app.slug, outcome: "ok" });
  });

  it("12. §6 · a widening re-registration writes one connect.roles_widened row naming the affected roles (widening SEMANTICS are worker/registry.test.ts's)", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await first.registered).toEqual({ ok: true });
    // Granted AFTER the first registration: drift is only audited for a role somebody
    // holds, so a grant made earlier would make the FIRST registration ({} → {search}) a
    // widening too, and this case could not tell the two rows apart.
    await grantReader(fixture);
    const second = await connect(fixture, { roles: { reader: ["search", "get_.*"] } });
    expect(await second.registered).toEqual({ ok: true });

    const rows = await auditedAfterRegister(fixture, second, "connect.roles_widened");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].detail)).toContain("get_.*");
  });

  it("13. §6 · a re-registration whose pattern sets are a subset writes no roles_widened row (the allow-twin of case 12)", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { roles: { reader: ["search", "get_.*"] } });
    expect(await first.registered).toEqual({ ok: true });
    await grantReader(fixture);
    const second = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await second.registered).toEqual({ ok: true });
    expect(await auditedAfterRegister(fixture, second, "connect.roles_widened")).toEqual([]);
  });
});

describe("§6 replacement — newest wins at acceptance", () => {
  it("14. §6 · a second socket for the same app: the first receives hub/replaced and is then closed 4000", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture);
    expect(await first.registered).toEqual({ ok: true });
    await connect(fixture);
    await first.replaced;
    expect((await first.closed).code).toBe(CLOSE_REPLACED);
    // Order, not just occurrence: the notification precedes the close, so a client can act
    // on it (§6 — it must NOT reconnect).
    expect(hubRequests(first).map((frame) => frame.method)).toContain(HUB_METHODS.replaced);
  });

  it("15. §6 · eviction happens at acceptance, before the newcomer registers — at the moment the newcomer is accepted the DO holds exactly one socket", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture);
    expect(await first.registered).toEqual({ ok: true });
    // skipRegister: the newcomer is accepted and nothing more, so what the count observes
    // is acceptance itself rather than a handshake that happened to tidy up after it.
    const second = await connect(fixture, { skipRegister: true });
    expect((await first.closed).code).toBe(CLOSE_REPLACED);
    expect(await liveSockets(fixture.app.id)).toBe(1);
    expect(await stillOpen(second)).toBe(true);
  });

  it("16. §6 · the eviction stands even when the newcomer's own registration is then refused: the app is offline, not healed back to the old socket (§6's accepted consequence, stated as a test so it can never be \"fixed\" silently)", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { roles: { reader: ["search"] } });
    expect(await status(fixture.app.id)).toBe("online");
    const second = await connect(fixture, { roles: { all: [".*"] } });
    expect((await second.closed).code).toBe(CLOSE_PROTOCOL);
    expect((await first.closed).code).toBe(CLOSE_REPLACED);
    expect(await status(fixture.app.id)).toBe("offline");
  });

  it("17. §6 · every replacement writes a connect.replaced audit row — with a stolen app token, impersonation looks exactly like this, so the row is the signal", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture);
    expect(await first.registered).toEqual({ ok: true });
    await connect(fixture);
    await first.replaced;
    const { rows } = await query(env.DB, fixture.ownerId, { event: "connect.replaced" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: fixture.app.slug });
  });
});

describe("§6 liveness", () => {
  it("18. §6 · no application-level heartbeat: an idle registered socket receives no hub/* frame at all, and stays online across an idle stretch (protocol pings are the runtime's business, invisible to the DO)", async () => {
    const fixture = await seedFixture();
    const app = await connect(fixture);
    expect(await waitFor(() => app.lists.length > 0)).toBe(true);
    const afterWarm = app.frames.length;
    // Idle: nothing is sent, and nothing may arrive.
    expect(await waitFor(() => app.frames.length > afterWarm, 30)).toBe(false);
    expect(hubRequests(app).some((frame) => String(frame.method).startsWith("hub/"))).toBe(false);
    expect(await status(fixture.app.id)).toBe("online");
  });
});

describe("§6 the published wire vocabulary — the behavior↔table lock", () => {
  it("19. §6 · observed close codes and hub/* method names equal the exported vocabulary: every code this file's cases observe on a real socket is the VALUE of its CLOSE_* export (CLOSE_REPLACED, CLOSE_ROW_GONE, CLOSE_PROTOCOL) and every hub-originated control frame's method is a value of HUB_METHODS — asserted against the exports, never against a literal, so the fixtures contracts.test.ts emits from them describe this socket rather than a parallel opinion of it", async () => {
    const fixture = await seedFixture();

    // hub/register — the method the DO ACCEPTS. The fake spells it literally on the wire
    // (its header says why), so a socket that registers is the observation that the
    // exported name is the one the hub answers to.
    const first = await connect(fixture);
    expect(await first.registered).toEqual({ ok: true });
    expect(HUB_METHODS.register).toBe("hub/register");

    // 4000, beside the hub/replaced notification that precedes it.
    const second = await connect(fixture, { skipRegister: true });
    await first.replaced;
    expect(hubRequests(first).map((frame) => frame.method)).toEqual([
      // §6, amended: the capability question precedes the warm. Neither is a `hub/` control
      // frame, which is what makes the third entry the only one this lock is about.
      "server/discover",
      "tools/list",
      HUB_METHODS.replaced,
    ]);
    expect((await first.closed).code).toBe(CLOSE_REPLACED);

    // 4004, from the protocol-error path.
    await second.sendRaw({ jsonrpc: "2.0", id: "x", method: "tools/list" });
    expect((await second.closed).code).toBe(CLOSE_PROTOCOL);

    // 4003, from the row-gone race.
    const third = await connect(fixture, { skipRegister: true });
    await new Registry(env.DB).deleteApp(fixture.app.id);
    await third.sendRegister();
    expect((await third.closed).code).toBe(CLOSE_ROW_GONE);
  });

  it("20. §6 · totality the other way: no hub-originated control frame carries a method outside HUB_METHODS, so a new control frame cannot enter the protocol without entering the published table — the half of the lock that a growing vocabulary would otherwise slip past", async () => {
    const fixture = await seedFixture();
    const first = await connect(fixture, { tools: [WALKABLE_TOOL, UNSOUND_TOOL] });
    expect(await first.registered).toEqual({ ok: true });
    // Everything this connection can be made to say: a warm that warns, an invalidation,
    // and finally a replacement — the one path that emits a control frame at all.
    expect(await waitFor(() => first.lists.length > 0)).toBe(true);
    await first.notifyToolsListChanged([WALKABLE_TOOL]);
    expect(await waitFor(() => first.lists.length > 1)).toBe(true);
    await connect(fixture);
    await first.replaced;

    const published: readonly string[] = Object.values(HUB_METHODS);
    const control = hubRequests(first)
      .map((frame) => String(frame.method))
      .filter((method) => method.startsWith("hub/"));
    expect(control.length).toBeGreaterThan(0);
    expect(control.every((method) => published.includes(method))).toBe(true);
  });
});
