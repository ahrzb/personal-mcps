// fake-service.ts — a real tunneled service, in-test: it dials `wss://<origin>/connect`
// over a genuine WebSocket, sends a genuine `hub/register`, and answers genuine JSON-RPC.
// It is the other end of §6's wire, not a stand-in for it.
//
// WHAT THIS PINS: the exactly-once oracle. `invocations` records every `tools/call` frame
// AT ARRIVAL — before any behavior branch, before any reply — so "the approval dispatched
// exactly once" is a count the service observed, never an inference from the hub's own
// bookkeeping (strategy §16/§9: the hub must not be its own witness for at-most-once).
// Everything else this harness offers exists to make that count meaningful under stress:
// answer, hang, drop, and MRTR legs are the four ways a call can end, and each must leave
// the counter saying the same thing.
//
// WHAT IT MUST NOT FAKE (strategy §9): the WebSocket, the JSON-RPC framing, the close-code
// vocabulary, the DO, or D1. One JSON-RPC message per text frame, ids echoed as received,
// `hub/*` control frames handled as control — a fake that skips framing proves nothing
// about framing. It equally must not fake the MCP SDK: it speaks the wire directly and
// therefore proves nothing about SDK conformance, which is `scripts/e2e.ts`'s job (§10).
//
// PROJECT: `tunnel` only, and that is load-bearing — live sockets and DOs are exactly what
// per-file storage isolation cannot hold, so this project runs serial (`--max-workers=1
// --no-isolate`). Consequences fixtures must respect: sockets from a previous file may
// still be open, so every fake service closes in a teardown; and the DO is addressed by
// the opaque `service.id`, so two fixtures sharing a slug across files still reach
// different DOs only if they seeded different services (see seed.uniqueSlug).
//
// deps: WebSocket (workerd global) · seed.SeededToken · gateway JsonRpc types (shape only) · registry.RoleDeclaration — no MCP SDK, no hub module at runtime

import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import type { RoleDeclaration } from "../../src/registry";

/**
 * What the service does with the NEXT matching `tools/call`. Chosen per tool and
 * changeable mid-test (setBehavior), because the interesting orderings — approve, go
 * offline, retry — are behavior changes between two identical calls.
 *
 * - `answer` — reply with `result`, the ordinary path and every refusal row's allow-twin.
 * - `error` — reply with a JSON-RPC error the service itself produced; the hub relays it
 *   verbatim (§7) and an approval stays consumed (§7 step 1's "service error" branch).
 * - `input_required` — reply with an MRTR input-required leg, the ONE result that
 *   restores a claimed approval; the follow-up leg is an ordinary call carrying
 *   `inputResponses`/`requestState`, recorded like any other.
 * - `hang` — receive, count, and never reply: the hub's 30 s correlation timeout
 *   (limits.CALL_TIMEOUT_MS) is what ends it, and the call MAY have executed.
 * - `drop` — receive, count, then close the socket without replying: the
 *   disconnect-mid-call branch, distinct from `hang` because pending drains immediately.
 */
export type ToolBehavior =
  | { mode: "answer"; result: unknown }
  | { mode: "error"; error: { code: number; message: string; data?: unknown } }
  | { mode: "input_required"; result: unknown }
  | { mode: "hang" }
  | { mode: "drop" };

/**
 * One observed inbound frame, captured verbatim before interpretation — the oracle's row.
 * `meta` is the forwarded request's `_meta` exactly as it arrived, which is what proves
 * §7's strip-then-set hygiene at the only place it can be proven: the service's side.
 * `wireId` is the DO's own UUID for the correlation; a fixture asserts the CONSUMER's
 * JSON-RPC id never appears here (ids never cross, §16).
 */
export type Invocation = {
  tool: string;
  args: Record<string, unknown> | undefined;
  meta: Record<string, unknown> | undefined;
  wireId: string;
  /** Monotonic sequence within this connection — orderings are asserted on it, not on clocks. */
  seq: number;
};

/**
 * How a fixture asks for a service on the wire. `token` is the plaintext `pmcp_svc_`
 * string seed.ts minted — the service's identity comes from it and from nothing else
 * (§6: the register payload carries no service field), so there is deliberately no slug
 * option here either.
 */
export type FakeServiceOptions = {
  /** The hub's https origin; `wss://<host>/connect` is derived, never passed. */
  origin: string;
  token: string;
  /** The declaration `hub/register` carries. Omitted or `{}` declares none (§6). */
  roles?: RoleDeclaration;
  /** The catalog answered to `tools/list` — schemas included, since redaction walks them (§7). */
  tools?: Tool[];
  /** Default behavior for tools with no per-tool entry; absent means `answer` with an empty result. */
  behavior?: ToolBehavior;
  /**
   * Suppress the `hub/register` frame entirely — the only way to observe the 10 s
   * registration deadline (close 4004) and pre-register traffic rejection (§6).
   */
  skipRegister?: boolean;
};

/**
 * The hub's answer to `hub/register`, captured as sent. Success is `{ok: true}`; a
 * rejected declaration is a JSON-RPC error reply followed by close 4004, and both halves
 * are observable here so a refusal case can sit beside its accepted twin (§9 rule 2).
 */
export type RegisterOutcome =
  | { ok: true }
  | { ok: false; error: { code: number; message: string } };

/**
 * A live fake service. One instance is one SOCKET, not one service lifetime — unlike the
 * client libraries this harness never reconnects, because the hub's replacement and
 * sever semantics are exactly what the tests are watching. Two instances against the same
 * token is how newest-wins is provoked.
 */
export class FakeService {
  /**
   * Every `tools/call` frame this socket received, in arrival order — the exactly-once
   * oracle. Appended before the behavior branch runs, so a hung or dropped call counts
   * exactly like an answered one: "the service saw it" and "the consumer got a result"
   * are different questions, and only this array answers the first.
   */
  readonly invocations!: readonly Invocation[];

  /**
   * Every `tools/list` this socket received. Non-empty right after registration is how
   * §6's "register → hub immediately warms its cache" is observed from outside, and a
   * second entry after `notifyToolsListChanged` is how invalidation is.
   */
  readonly lists!: readonly { wireId: string; seq: number }[];

  /** Resolves with the hub's register reply — or rejects if the socket closed first. */
  readonly registered!: Promise<RegisterOutcome>;

  /**
   * Resolves when the hub sends the `hub/replaced` notification (§6). Pending forever on
   * a connection that is never replaced, so fixtures race it against a timeout rather
   * than awaiting it unconditionally.
   */
  readonly replaced!: Promise<void>;

  /**
   * Resolves with the close code and reason when the hub (or this side) closes — the
   * observation behind every close-code row: 4000 replaced, 4001 revoked/deleted, 4002
   * archived, 4003 row gone during register, 4004 protocol/deadline.
   */
  readonly closed!: Promise<{ code: number; reason: string }>;

  /**
   * How many `tools/call` frames named `tool` — the count assertions read. Unfiltered
   * (no argument) it is the whole-connection total, which is what "exactly once across
   * N concurrent retries" needs.
   */
  callCount(tool?: string): number {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Change what the next matching call does. The seam that makes deterministic
   * interleavings possible: a fixture flips a tool to `hang`, fires the racing call,
   * flips it back, and releases — never fire-fifty-and-hope (strategy §3: workerd is
   * cooperative, so interleavings are table-driven, not statistical).
   */
  setBehavior(tool: string, behavior: ToolBehavior): void {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Answer a call parked by `hang`, after the fact. This is the availability-between-
   * check-and-claim lever: the hub is mid-forward, the fixture changes the world, and the
   * reply lands into whatever state that produced. A tool with nothing parked is a no-op.
   */
  release(tool: string, result: unknown): void {
    // deps: none
    throw new Error("unimplemented");
  }

  /**
   * Send `notifications/tools/list_changed` with a new catalog — §6's cache-invalidation
   * path, and the only way a fixture changes a tunneled service's tools without
   * reconnecting (which would also stamp last-connected and re-run drift detection).
   */
  async notifyToolsListChanged(tools: Tool[]): Promise<void> {
    // deps: WebSocket.send
    throw new Error("unimplemented");
  }

  /**
   * Send one raw frame, bypassing every convenience above — the escape hatch protocol
   * tests need for the cases that are ill-formed BY CONSTRUCTION: a pre-register MCP
   * message, an unknown `hub/` method, a response to no request. A harness that could
   * only send well-formed frames could not test the rejection of malformed ones.
   */
  async sendRaw(frame: JsonRpcRequest | JsonRpcResponse | Record<string, unknown>): Promise<void> {
    // deps: WebSocket.send
    throw new Error("unimplemented");
  }

  /**
   * Close from this side, simulating the bot dying rather than the hub evicting it —
   * distinct from every hub-initiated close because no close code carries meaning back to
   * the hub. Idempotent; fixtures call it in teardown unconditionally (the tunnel project
   * shares storage, so a leaked socket is a leak into the NEXT file).
   */
  async close(): Promise<void> {
    // deps: WebSocket.close
    throw new Error("unimplemented");
  }
}

/**
 * Dial the hub and, unless `skipRegister` says otherwise, complete `hub/register` before
 * resolving — so a fixture's first line establishes "this service is online" as a fact
 * rather than a hope. Rejects when the upgrade itself fails, carrying the HTTP status
 * verbatim: 401 and 403 are the pinned §6 contract (fatal credential vs archived), and a
 * fixture asserting 403-means-exactly-archived needs the raw number, not an exception
 * class that has already interpreted it.
 */
export async function connectFakeService(options: FakeServiceOptions): Promise<FakeService> {
  // deps: WebSocket · JSON.stringify/parse (one message per text frame, §6)
  throw new Error("unimplemented");
}

/**
 * The upgrade WITHOUT a socket: performs the `/connect` request and returns the response
 * status, for the rows that are about refusal rather than about a connection — 401 for
 * every credential failure (missing, wrong kind, revoked, expired, service row gone,
 * proxy kind) and 403 for exactly one thing, archived. Its allow-twin is
 * connectFakeService itself: the same credential, one state different, reaching 101.
 */
export async function attemptUpgrade(options: {
  origin: string;
  token?: string;
}): Promise<{ status: number }> {
  // deps: fetch (Upgrade: websocket)
  throw new Error("unimplemented");
}
