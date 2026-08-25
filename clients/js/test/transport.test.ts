/**
 * clients/js/test/transport.test.ts — HubTransport against an in-process fake
 * hub: the client half of §6's reverse-connection protocol. What it pins is the
 * DISCONNECT POLICY — the upgrade statuses (401 fatal vs 403 archived: the split
 * the whole fatal-vs-retry decision turns on) and the close-code vocabulary
 * 4000–4004, each mapping onto exactly one of three behaviors — `stop_fatal`,
 * `stop_quiet`, `reconnect` — plus, on the ones that reconnect, a `schedule`
 * attribute of `exponential` or `max_only`. Behavior and schedule are separate
 * axes (contracts/README.md, pinned 2026-08-25): "retry at max backoff" is a
 * SCHEDULE of reconnect, never a fourth behavior, which is why the row type
 * below carries the two in separate columns. Plus the handshake around it: the derived
 * wss://<host>/connect address, hub/register re-sent on every (re)connect, and
 * the hub/* control frames never reaching the SDK session.
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
 * Design check, resolved at implementation: if fake timers cannot drive the
 * reconnect loop because `ws`'s own timers fight them, HubTransport needs an
 * injectable sleep seam — the same seam clients/py solves with its recorded-sleep
 * fixture (anyio has no injectable clock on asyncio). Discovering that here is a
 * finding about the production seam, not a test workaround (strategy §6).
 *
 * Durable vs incidental (§7): durable are the code→behavior mapping, its
 * totality, and the fact that reconnects are invisible to the SDK session.
 * Incidental — never asserted as a literal — the delay values themselves (rows
 * name the schedule, and backoffDelay's own numbers are pinned once in
 * api.test.ts) and every message string.
 */

// deps: ./fake-hub (in-process `ws` hub: chooses upgrade status, accepts/rejects hub/register, closes with a code) · clients/js/src/index.ts (HubTransport, serve, CredentialsError, RegistrationError) · contracts/close-codes.json (read-only — see contracts-consumer.test.ts) · vitest fake timers

import { describe, it } from "vitest";
import type { CredentialsError, RegistrationError } from "../src/index";

describe("handshake · §6 \"Transport\", \"Framing\", \"Handshake\"", () => {
  it.todo("§6 · the constructor rejects anything but a bare https origin (a path, a wss URL) with a TypeError before any I/O; twin: a bare origin constructs and dials wss://<host>/connect, derived — never passed in");
  it.todo("§6 · the dial carries the service token as `Authorization: Bearer`, and carries no service or slug anywhere: identity rides the token alone");
  it.todo("§6 · start() resolves only after hub/register is accepted, and the frame sent is the declaration handed to the constructor (roles verbatim, `{}` when omitted)");
  it.todo("§6 · hub/* control frames are consumed internally and never surface on onmessage; ordinary MCP traffic does, one JSON-RPC message per text frame");
  it.todo("§6 · send() while the socket is down drops the message and does not throw or queue it — the hub re-lists after every registration, so a dropped notifications/tools/list_changed heals itself");
  it.todo("§6 · close() is idempotent: it stops reconnecting and resolves `closed`, and a second call changes nothing");
});

describe("reconnection is invisible to the SDK session · §6, §11", () => {
  it.todo("§6 · a mid-life network drop reconnects and re-sends hub/register, while onclose never fires and `closed` never settles — one transport is one service lifetime, not one socket");
  it.todo("§6 · onclose fires exactly once, and only at a terminal state");
  it.todo("§11 · serve()'s resolution mirrors the transport's terminal state — resolves after a replacement, rejects with the same error class otherwise — so the policy is decided in HubTransport and nowhere else");
});

describe("the policy itself · §6 upgrade matrix + close codes", () => {
  it.todo("the table below — one case per row, plus its allow-twin row: every refusal ending (401, 4001, a rejected registration) is authored beside the ending that keeps the connection alive, so a transport that gives up on everything cannot pass (strategy §9 rule 2)");
});

/**
 * How a connection ended — the row's input, driven by the fake hub. Four
 * shapes, because §6 gives the policy four kinds of input and the client must
 * not conflate them: a refused upgrade (an HTTP status, before any frame), a
 * close code (after establishment), a rejected registration (a JSON-RPC error
 * reply to hub/register), and an ordinary transport failure (drop, hub deploy).
 */
export type PolicyTrigger =
  | { kind: "upgrade"; status: number }
  | { kind: "close"; code: number }
  | { kind: "register-rejected" }
  | { kind: "network-drop" };

/**
 * What `HubTransport.closed` must do at that ending. `pending` is the load-
 * bearing case — an ending that reconnects must leave the promise unsettled
 * forever, which is what makes "reconnect" observably different from "stop". The
 * fatal cases name the constructor rather than a string, so renaming an error
 * class breaks this table instead of silently matching nothing.
 *
 * The fixture's three behavior words land here one-to-one: `stop_quiet` →
 * `resolve`, `stop_fatal` → `reject`, `reconnect` → `pending`. The mapping is
 * total in both directions, which is what lets contracts-consumer.test.ts check
 * a row against a fixture entry without either side owning a fourth word.
 */
export type PolicySettlement =
  | { kind: "pending" }
  | { kind: "resolve" }
  | { kind: "reject"; error: typeof CredentialsError | typeof RegistrationError };

/**
 * One row of §6's reconnect policy, transcribed from the shared close-code
 * contract fixture (§4) — the deliberate cross-language duplication: the Python
 * table in clients/py/tests/test_transport.py transcribes the same fixture, and
 * contracts-consumer.test.ts pins that the transcription is total in both
 * directions.
 *
 * The columns are the observable consequences, chosen so no two behaviors share
 * a signature: does the fake hub see another dial (`redials`), on which schedule
 * (`schedule` — named, never a millisecond literal: §7 puts timing numbers in
 * api.test.ts's schedule table and nowhere else), and what does `closed` do
 * (`settlement`). `stop_quiet` and `stop_fatal` differ in `settlement`; the two
 * `reconnect` entries differ only in `schedule`, which is precisely why the
 * fixture's vocabulary keeps the two axes apart.
 */
export type ReconnectPolicyRow = {
  /** spec reference printed in the case title, e.g. "§6 · close 4002 · archived reconnects on the max_only schedule" */
  spec: string;
  trigger: PolicyTrigger;
  /** whether the fake hub observes a further dial after this ending — `redials: true` IS the fixture's `reconnect` */
  redials: boolean;
  /** the fixture's `schedule` attribute for this entry; null when the behavior does not reconnect */
  schedule: "exponential" | "max_only" | null;
  settlement: PolicySettlement;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy
 * §9 rule 1) — agents never fill them. The oracle is §6's upgrade matrix and
 * close-code list plus the contracts fixture derived from them; rows are written
 * from the spec, never from the library.
 */
export const reconnectPolicyRows: readonly ReconnectPolicyRow[] = [];

/**
 * The table runner: one case per row, titled with the row's `spec`. It stands up
 * a fake hub configured to produce the row's `trigger`, then observes the three
 * consequences — further dials, the delay the loop asks for under fake timers,
 * and the settlement of `closed`. All the assertion logic in this suite lives
 * here, so adding a close code to the protocol is one fixture entry plus one row.
 */
export function runReconnectPolicy(rows: readonly ReconnectPolicyRow[]): void {
  // deps: ./fake-hub · clients/js/src/index.ts (HubTransport) · vitest fake timers
  throw new Error("unimplemented");
}
