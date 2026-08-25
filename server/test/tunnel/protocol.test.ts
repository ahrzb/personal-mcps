/**
 * tunnel/protocol.test.ts — the §6 wire, pinned at the socket: what a service must
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
 * WebSockets, a DO alarm, and the ServiceConnection instance itself, all three of
 * which per-file storage isolation cannot cover (strategy §2).
 *
 * Isolation and ordering, load-bearing: smoke.test.ts must be green first — A2 (an
 * attachment surviving hibernation) is what makes `registered` readable on any wake.
 * With --no-isolate nothing resets between cases, so every case seeds its own owner,
 * slug and service id, and asserts on rows it created rather than on table counts.
 * Time is never slept: the registration deadline is reached by firing the pending
 * alarm with runDurableObjectAlarm.
 */

// deps: harness/seed · harness/fake-service · cloudflare:test (env.SERVICE_CONNECTION, runInDurableObject, runDurableObjectAlarm) · src/tunnel (handleConnect, ServiceConnection, CLOSE_REPLACED, CLOSE_ROW_GONE, CLOSE_PROTOCOL, HUB_METHODS) · src/registry (Registry.upsertDeclaredRoles, RoleDeclaration, validateSchemaIndirection) · src/audit (query) · src/limits (REGISTRATION_DEADLINE_MS)

import { describe, it } from "vitest";
import type { CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_ROW_GONE } from "../../src/tunnel";
import type { RoleDeclaration } from "../../src/registry";

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
 */
export type FirstMessage =
  | { kind: "register"; roles: RoleDeclaration }
  | { kind: "mcp"; method: string }
  | { kind: "control"; method: string }
  | { kind: "malformed" }
  | { kind: "silence" };

/**
 * One row of the registration table — the §6 handshake as data.
 *
 * `serviceRow` is the state of D1 at the moment the frame is handled, which is the
 * only input that separates 4003 from every other refusal. The four observable
 * columns are what a client and an owner can actually see, and nothing else: the
 * JSON-RPC reply on the socket, the close code (or a socket left open), whether the
 * service subsequently reads online, and whether the fake service observed the
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
  serviceRow: "present" | "deleted_after_upgrade";
  reply: "ok" | "jsonrpc_error" | "none";
  close: ProtocolCloseCode | "open";
  online: boolean;
  catalogWarmed: boolean;
  twin: string;
};

/**
 * The registration table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. Every refusal row
 * must sit beside its allow-twin: a rejected declaration next to an accepted one, a
 * too-early frame next to the register that arrives first (§9 rule 2). That "must" is
 * carried by the `twin` column and enforced by the runner, not by review.
 */
export const registrationRows: readonly RegistrationRow[] = [];

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
  // deps: harness/seed · harness/fake-service · src/tunnel.handleConnect · cloudflare:test runDurableObjectAlarm
  throw new Error("unimplemented");
}

describe("§6 registration", () => {
  it.todo("1. §6 · registration table — one case per row of `registrationRows`, driven by runRegistrationCase(row, registrationRows)");
  it.todo("1b. §9 rule 2 · every refusal row's `twin` resolves to a registering row present in this table — the invariant that makes case 2 the measure of cases 5-10 rather than a sentence in a comment above them");
  it.todo("2. §6 · a valid hub/register replies { ok: true } and the service reads online (the allow-twin every refusal below is measured against)");
  it.todo("3. §6 · registration warms the catalog: the fake service observes exactly one hub-originated tools/list immediately after the reply");
  it.todo("4. §6 · initialize never crosses the socket — the first hub-originated message of the connection's life is that tools/list, self-contained with its protocol _meta fields");
  it.todo("4a. §7 · a catalog answer carrying a tool whose schema trips the indirection refuse-line is reported LOUDLY and survives: the service receives a warning frame naming that tool's violations, the registration still succeeds, the service reads online, and that tool is cached schema-unsound (what unsoundness then costs a call — sensitivePaths null, -32001, no recorded bodies — is the worker project's)");
  it.todo("4b. §7 · the same catalog with a walkable schema draws no warning frame and caches the tool sound — the allow-twin without which a warm that warns about everything, or that refuses to register at all, passes case 4a");
  it.todo("4c. §7 · one unsound tool does not contaminate its siblings: the other tools in the same catalog answer are cached sound, so the refusal is per tool and never per service");
  it.todo("5. §6 · a socket silent past limits.REGISTRATION_DEADLINE_MS is closed 4004 when the pending alarm fires (fired, never slept)");
  it.todo("6. §6 · the same alarm is a no-op once registration succeeded: the socket is still open and still online afterwards");
  it.todo("7. §6 · a non-hub/register frame before registration gets a JSON-RPC error reply and then close 4004 — twin of case 2, where the same frame sent after registration is ordinary MCP traffic");
  it.todo("8. §6 · a refused declaration gets an error reply and close 4004, and D1's stored roles are unchanged — twin: the accepted declaration of case 2 stores them");
  it.todo("9. §6 · a service row deleted between upgrade and register closes 4003 — twin: case 2's surviving row registers");
  it.todo("10. §6 · the hub never forwards consumer traffic to an unregistered socket: a tools/call while a socket sits accepted-but-unregistered fails -32000");
});

describe("§6 audit of the connection lifecycle", () => {
  it.todo("11. §6 · a successful registration writes exactly one connect.register row");
  it.todo("12. §6 · a widening re-registration writes one connect.roles_widened row naming the affected roles (widening SEMANTICS are worker/registry.test.ts's)");
  it.todo("13. §6 · a re-registration whose pattern sets are a subset writes no roles_widened row (the allow-twin of case 12)");
});

describe("§6 replacement — newest wins at acceptance", () => {
  it.todo("14. §6 · a second socket for the same service: the first receives hub/replaced and is then closed 4000");
  it.todo("15. §6 · eviction happens at acceptance, before the newcomer registers — at the moment the newcomer is accepted the DO holds exactly one socket");
  it.todo("16. §6 · the eviction stands even when the newcomer's own registration is then refused: the service is offline, not healed back to the old socket (§6's accepted consequence, stated as a test so it can never be \"fixed\" silently)");
  it.todo("17. §6 · every replacement writes a connect.replaced audit row — with a stolen service token, impersonation looks exactly like this, so the row is the signal");
});

describe("§6 liveness", () => {
  it.todo("18. §6 · no application-level heartbeat: an idle registered socket receives no hub/* frame at all, and stays online across an idle stretch (protocol pings are the runtime's business, invisible to the DO)");
});

describe("§6 the published wire vocabulary — the behavior↔table lock", () => {
  it.todo("19. §6 · observed close codes and hub/* method names equal the exported vocabulary: every code this file's cases observe on a real socket is the VALUE of its CLOSE_* export (CLOSE_REPLACED, CLOSE_ROW_GONE, CLOSE_PROTOCOL) and every hub-originated control frame's method is a value of HUB_METHODS — asserted against the exports, never against a literal, so the fixtures contracts.test.ts emits from them describe this socket rather than a parallel opinion of it");
  it.todo("20. §6 · totality the other way: no hub-originated control frame carries a method outside HUB_METHODS, so a new control frame cannot enter the protocol without entering the published table — the half of the lock that a growing vocabulary would otherwise slip past");
});
