// fake-app.ts — a real tunneled app, in-test: it dials `wss://<origin>/connect`
// over a genuine WebSocket, sends a genuine `hub/register`, and answers genuine JSON-RPC.
// It is the other end of §6's wire, not a stand-in for it.
//
// WHAT THIS PINS: the exactly-once oracle. `invocations` records every `tools/call` frame
// AT ARRIVAL — before any behavior branch, before any reply — so "the approval dispatched
// exactly once" is a count the app observed, never an inference from the hub's own
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
// Every wire string here is SPELLED, never imported from src: `hub/register`, the
// `_meta` key names, the 2026-07-28 revision, and — from §20 — `server/discover`, the four
// list methods, and the three `notifications/*/list_changed` frames. tunnel.ts publishes the
// same vocabulary as exports, and protocol.test.ts asserts the two agree — a fake that
// imported the constants would make that lock vacuous by construction.
//
// WHAT §20 ADDED, and why it is here rather than in a second fake: this app now serves
// four catalogs, not one, and answers the registration-time `server/discover` a real client
// library answers ITSELF (§11) — three behaviors deep, because §6's whole compatibility
// story is what the hub does when that answer does not come.
//
// WHAT §21 ADDED: the fourth frame of the DO's read-set — `notifications/resources/updated`
// — and the two forwarded methods an app answers natively (`resources/subscribe` /
// `resources/unsubscribe`, §11: the author's SDK answers them, so a client library that
// secretly kept a subscription set would fail these rows). And the OTHER CLASS of socket:
// FakeSubscriber is the consumer end of a §21.2 subscriber socket, opened through the DO's
// second upgrade door the same way the Worker opens it — `stub.fetch(upgrade)` with the
// peer accepted test-side, never fabricated inside runInDurableObject, because a
// fabricated socket silently vanishes at evictDurableObject and would make every
// hibernation row vacuous (measured). Its two headers are SPELLED here like every other
// wire string in this file.
//
// PROJECT: `tunnel` only, and that is load-bearing — live sockets and DOs are exactly what
// per-file storage isolation cannot hold, so this project runs serial (`--max-workers=1
// --no-isolate`). Consequences fixtures must respect: sockets from a previous file may
// still be open, so every fake app closes in a teardown; and the DO is addressed by
// the opaque `app.id`, so two fixtures sharing a slug across files still reach
// different DOs only if they seeded different apps (see seed.uniqueSlug).
//
// deps: WebSocket (workerd global) · cloudflare:workers exports.default.fetch (the running
// router, which is how a socket reaches /connect at all) · seed.SeededToken · gateway
// JsonRpc types (shape only) · registry.RoleDeclaration — no MCP SDK, no hub module

import { exports as workerExports } from "cloudflare:workers";
import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import type { RoleDeclaration } from "../../src/registry";

/**
 * What the app does with the NEXT matching `tools/call`. Chosen per tool and
 * changeable mid-test (setBehavior), because the interesting orderings — approve, go
 * offline, retry — are behavior changes between two identical calls.
 *
 * - `answer` — reply with `result`, the ordinary path and every refusal row's allow-twin.
 * - `error` — reply with a JSON-RPC error the app itself produced; the hub relays it
 *   verbatim (§7) and an approval stays consumed (§7 step 1's "app error" branch).
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
 * What the app does with the NEXT list of ANY family — the catalog warm's other half,
 * and the only way a fixture reaches the states §6 lifecycle 2 is about. `answer` is the
 * default every other fixture assumes; `error` and `hang` are the two ways a warm draws no
 * catalog at all (an error reply the hub cannot read as a list, and a list that never
 * comes back), which is what leaves a never-connected DO online with nothing cached.
 */
export type ListBehavior =
  | { mode: "answer" }
  | { mode: "error"; error: { code: number; message: string } }
  | { mode: "hang" };

/**
 * The four catalogs §20.5 gives the DO a durable key each — the tool list §6 always had,
 * plus `catalog:prompts`, `catalog:resources` and `catalog:resourceTemplates`. Spelled as
 * one union because every list behaves identically on this wire: one hub-originated
 * request, one result object whose single key is the family's own name.
 *
 * The METHOD each one rides is not derivable from the name (`resourceTemplates` is
 * `resources/templates/list`), so {@link LIST_METHOD} carries the mapping — spelled here
 * like every other wire string in this file, never imported from src.
 */
export type CatalogFamily = "tools" | "prompts" | "resources" | "resourceTemplates";

/**
 * The hub-originated list method for each family, and the result key its answer carries
 * (they are the same string — MCP names the result member after the family, and
 * `resources/templates/list` answers `{resourceTemplates: [...]}`).
 */
export const LIST_METHOD: Readonly<Record<CatalogFamily, string>> = {
  tools: "tools/list",
  prompts: "prompts/list",
  resources: "resources/list",
  resourceTemplates: "resources/templates/list",
};

/**
 * What the app does with the hub's registration-time `server/discover` (§6, amended
 * 2026-08-26). Three modes because §6 gives the fallback three inputs and ONE meaning:
 * `error` covers the `-32601` a library that predates the method answers with — and, with
 * any other code, "any other error" — while `hang` is the correlation timeout. All three
 * are "capabilities unknown", and the hub then warms tools only.
 *
 * `answer` is the default, and the answer's `capabilities` are the fixture's declared
 * families (FakeAppOptions.capabilities) rendered as a real 2026-07-28 DiscoverResult.
 */
export type DiscoverBehavior =
  | { mode: "answer" }
  | { mode: "error"; error: { code: number; message: string } }
  | { mode: "hang" };

/**
 * One entry of a prompt, resource or resource-template catalog, structurally: the fake
 * app puts on the wire exactly the object a fixture handed it. Deliberately NOT the
 * hub's own `Prompt`/`Resource` types — this harness answers bytes, and a fixture whose
 * catalog entry is deliberately malformed (a resource whose `name` matches where its `uri`
 * does not, §20.2) must still be sendable.
 */
export type CatalogEntry = Record<string, unknown>;

/**
 * One observed inbound frame, captured verbatim before interpretation — the oracle's row.
 * `meta` is the forwarded request's `_meta` exactly as it arrived, which is what proves
 * §7's strip-then-set hygiene at the only place it can be proven: the app's side.
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
 * How a fixture asks for an app on the wire. `token` is the plaintext `pmcp_app_`
 * string seed.ts minted — the app's identity comes from it and from nothing else
 * (§6: the register payload carries no app field), so there is deliberately no slug
 * option here either.
 */
export type FakeAppOptions = {
  /** The hub's https origin; `wss://<host>/connect` is derived, never passed. */
  origin: string;
  token: string;
  /** The declaration `hub/register` carries. Omitted or `{}` declares none (§6). */
  roles?: RoleDeclaration;
  /** The catalog answered to `tools/list` — schemas included, since redaction walks them (§7). */
  tools?: Tool[];
  /** The catalog answered to `prompts/list` (§20.5). Its PRESENCE is also what makes the
   *  default `server/discover` answer declare the prompts family — an app that serves
   *  prompts is an app that says so. */
  prompts?: CatalogEntry[];
  /** The catalog answered to `resources/list`; present ⇒ the default discover answer
   *  declares `resources`, which is the one family whose declaration warms two keys. */
  resources?: CatalogEntry[];
  /** The catalog answered to `resources/templates/list` — the second key the `resources`
   *  declaration warms (§20.5), declared by either this or `resources`. */
  resourceTemplates?: CatalogEntry[];
  /**
   * The families the `server/discover` answer DECLARES, overriding what the catalogs above
   * imply — the seam for the two cases the implication cannot reach: an app that
   * declares a family it then fails to list (§20.5's failed warm), and one that stops
   * declaring a family it declared before (the undeclare that CLEARS). Values are §20.2's
   * capability vocabulary: `tools`, `prompts`, `resources`, `completions`.
   */
  capabilities?: readonly string[];
  /** Default behavior for tools with no per-tool entry; absent means `answer` with an empty result. */
  behavior?: ToolBehavior;
  /** What EVERY family's list does, from the registration warm onwards, unless
   *  `listBehaviors` names that family; absent means `answer`. */
  listBehavior?: ListBehavior;
  /** Per-family override of `listBehavior` — how a fixture makes one warm fail while its
   *  siblings land (§20.5: an undeclare clears, a failure does not). */
  listBehaviors?: Partial<Record<CatalogFamily, ListBehavior>>;
  /** What the registration-time `server/discover` does; absent means `answer`. */
  discoverBehavior?: DiscoverBehavior;
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
 * A refused upgrade, carrying the HTTP status verbatim (§6's pinned 401/403 split) — the
 * number, uninterpreted, because "403 means exactly archived" is the fixture's claim to
 * make and not this harness's.
 */
export class UpgradeRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`/connect refused the upgrade: ${status}`);
    this.status = status;
  }
}

/**
 * A live fake app. One instance is one SOCKET, not one app lifetime — unlike the
 * client libraries this harness never reconnects, because the hub's replacement and
 * sever semantics are exactly what the tests are watching. Two instances against the same
 * token is how newest-wins is provoked.
 */
export class FakeApp {
  /**
   * Every `tools/call` frame this socket received, in arrival order — the exactly-once
   * oracle. Appended before the behavior branch runs, so a hung or dropped call counts
   * exactly like an answered one: "the app saw it" and "the consumer got a result"
   * are different questions, and only this array answers the first.
   */
  readonly invocations: readonly Invocation[] = [];

  /**
   * Every `tools/list` this socket received. Non-empty right after registration is how
   * §6's "register → hub immediately warms its cache" is observed from outside, and a
   * second entry after `notifyToolsListChanged` is how invalidation is.
   *
   * Tools ONLY, and deliberately so: §20.5's three further catalogs are read off
   * {@link frames} (which records every inbound frame before interpretation, so it carries
   * the same at-arrival guarantee), because a parallel array per family would say the same
   * thing four times and invite a fixture to ask the wrong one.
   */
  readonly lists: readonly { wireId: string; seq: number }[] = [];

  /**
   * Every frame this socket received, verbatim and uninterpreted — the totality oracle
   * `invocations` and `lists` are readings OF. It exists because three §6 claims are about
   * frames that arrive rather than frames that are understood: that an idle registered
   * socket receives no `hub/*` frame at all, that no hub-originated control frame carries a
   * method outside the published vocabulary, and that the catalog warm names an unsound
   * tool to the app. None of those can be observed through a typed accessor without
   * that accessor deciding the answer.
   */
  readonly frames: readonly Record<string, unknown>[] = [];

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

  private readonly socket: WebSocket;
  private readonly options: FakeAppOptions;
  private tools: Tool[];
  private readonly behaviors = new Map<string, ToolBehavior>();
  /** The three §20.5 catalogs that are not tools — tools keeps its own typed field because
   *  fixtures hand it `Tool[]` and redaction walks those schemas. */
  private readonly catalogs = new Map<CatalogFamily, CatalogEntry[]>();
  /** The families the discover answer declares — §20.2's capability vocabulary as strings,
   *  since `completions` is a capability with no catalog and no list method. */
  private capabilities: readonly string[];
  private discoverBehavior: DiscoverBehavior;
  /** The default for every family's list; `listBehaviors` overrides it per family. */
  private listBehavior: ListBehavior;
  private readonly listBehaviors = new Map<CatalogFamily, ListBehavior>();
  /** Calls parked by `hang`, in arrival order — what `release` answers, oldest first.
   *  Keyed by nothing: two concurrent calls on the same tool are two entries, so a double
   *  dispatch shows up on `invocations` rather than as one stranded frame that times out. */
  private readonly parked: { tool: string; wireId: string }[] = [];
  private seq = 0;
  private registerId = "";
  private settleRegistered: ((outcome: RegisterOutcome) => void) | undefined;
  private failRegistered: ((reason: Error) => void) | undefined;
  private settleReplaced: (() => void) | undefined;
  private settleClosed: ((end: { code: number; reason: string }) => void) | undefined;
  private ended = false;

  constructor(socket: WebSocket, options: FakeAppOptions) {
    this.socket = socket;
    this.options = options;
    this.tools = options.tools ?? [];
    this.catalogs.set("prompts", options.prompts ?? []);
    this.catalogs.set("resources", options.resources ?? []);
    this.catalogs.set("resourceTemplates", options.resourceTemplates ?? []);
    this.capabilities = options.capabilities ?? declaredFamilies(options);
    this.discoverBehavior = options.discoverBehavior ?? { mode: "answer" };
    this.listBehavior = options.listBehavior ?? { mode: "answer" };
    for (const [family, behavior] of Object.entries(options.listBehaviors ?? {})) {
      this.listBehaviors.set(family as CatalogFamily, behavior as ListBehavior);
    }
    (this as { registered: Promise<RegisterOutcome> }).registered = new Promise((resolve, reject) => {
      this.settleRegistered = resolve;
      this.failRegistered = reject;
    });
    // Nothing forces a fixture to await `registered`, and a refusal row's socket closes
    // before any reply — an unobserved rejection must not fail an unrelated case.
    this.registered.catch(() => undefined);
    (this as { replaced: Promise<void> }).replaced = new Promise((resolve) => {
      this.settleReplaced = resolve;
    });
    (this as { closed: Promise<{ code: number; reason: string }> }).closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
    socket.accept();
    socket.addEventListener("message", (event) => this.receive(String((event as MessageEvent).data)));
    socket.addEventListener("close", (event) => {
      const end = event as CloseEvent;
      this.end(end.code, end.reason);
    });
    socket.addEventListener("error", () => this.end(1006, "transport error"));
  }

  /**
   * How many `tools/call` frames named `tool` — the count assertions read. Unfiltered
   * (no argument) it is the whole-connection total, which is what "exactly once across
   * N concurrent retries" needs.
   */
  callCount(tool?: string): number {
    // deps: none
    return tool === undefined
      ? this.invocations.length
      : this.invocations.filter((call) => call.tool === tool).length;
  }

  /**
   * Change what the next matching call does. The seam that makes deterministic
   * interleavings possible: a fixture flips a tool to `hang`, fires the racing call,
   * flips it back, and releases — never fire-fifty-and-hope (strategy §3: workerd is
   * cooperative, so interleavings are table-driven, not statistical).
   */
  setBehavior(tool: string, behavior: ToolBehavior): void {
    // deps: none
    this.behaviors.set(tool, behavior);
  }

  /**
   * Change what the next list does — every family, or just `family`. The lever for the
   * failed-warm pair: an app that registers while it cannot list yet, and then can —
   * with no reconnect in between, so what heals the catalog is the hub's own re-list rather
   * than a fresh registration.
   *
   * Naming a family sets an OVERRIDE that outlives later default changes, which is what
   * §20.5's "a failure is not an undeclare" pair needs: one family failing while its
   * siblings answer normally.
   */
  setListBehavior(behavior: ListBehavior, family?: CatalogFamily): void {
    // deps: none
    if (family === undefined) this.listBehavior = behavior;
    else this.listBehaviors.set(family, behavior);
  }

  /**
   * Change what the next `server/discover` does. Only a RECONNECT re-asks it (§6 issues it
   * once, at registration), so this exists for a fixture that dials a second socket against
   * the same app and wants that registration to take the fallback.
   */
  setDiscoverBehavior(behavior: DiscoverBehavior): void {
    // deps: none
    this.discoverBehavior = behavior;
  }

  /**
   * Answer the OLDEST call parked by `hang` on this tool, after the fact. This is the
   * availability-between-check-and-claim lever: the hub is mid-forward, the fixture changes
   * the world, and the reply lands into whatever state that produced. A tool with nothing
   * parked is a no-op; a second parked call is still parked, and a fixture that meant to
   * park only one reads that off `invocations`.
   */
  release(tool: string, result: unknown): void {
    // deps: none
    const index = this.parked.findIndex((call) => call.tool === tool);
    if (index === -1) return;
    const [call] = this.parked.splice(index, 1);
    this.reply({ jsonrpc: "2.0", id: call.wireId, result });
  }

  /**
   * Send `notifications/tools/list_changed` with a new catalog — §6's cache-invalidation
   * path, and the only way a fixture changes a tunneled app's tools without
   * reconnecting (which would also stamp last-connected and re-run drift detection).
   */
  async notifyToolsListChanged(tools: Tool[]): Promise<void> {
    // deps: WebSocket.send
    this.tools = tools;
    await this.sendRaw({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /**
   * Send `notifications/prompts/list_changed` with a new prompt catalog — §20.5's second
   * invalidation path, which §6 amended the DO to ROUTE rather than drop. Same shape as the
   * tools notification for the same reason: the new catalog is installed before the frame
   * goes out, so the hub's re-list draws the new one and nothing races.
   */
  async notifyPromptsListChanged(prompts: CatalogEntry[]): Promise<void> {
    // deps: WebSocket.send
    this.catalogs.set("prompts", prompts);
    await this.sendRaw({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
  }

  /** Send `notifications/resources/list_changed` with a new resource catalog — §20.5's
   *  third invalidation path. */
  async notifyResourcesListChanged(resources?: CatalogEntry[]): Promise<void> {
    // deps: WebSocket.send
    // The catalog is optional because §21.3's templates-only twin changes the OTHER key
    // this one frame speaks for (MCP defines no templates frame) and leaves this one alone.
    if (resources !== undefined) this.catalogs.set("resources", resources);
    await this.sendRaw({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  }

  /** Install a catalog WITHOUT announcing it — the lever for the changes an app makes
   *  before the one frame that speaks for them goes out (§20.5's two resource keys), and
   *  for the re-warm that draws exactly what the hub already has (§21.3's equal-catalog
   *  twin, which must ring nothing however loudly the app said something changed). */
  setCatalog(family: CatalogFamily, entries: CatalogEntry[]): void {
    // deps: none
    this.catalogs.set(family, entries);
  }

  /**
   * Send `notifications/resources/updated` for one URI — §21.4's per-URI frame, the fourth
   * member of the DO's read-set and the only one carrying a payload the hub reads. Sent
   * raw and uninterpreted: a fixture may name a URI nobody subscribed, or one that differs
   * from a subscribed URI by a trailing slash, and this harness must put both on the wire
   * unchanged.
   */
  async notifyResourcesUpdated(uri: string): Promise<void> {
    // deps: WebSocket.send
    await this.sendRaw({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
  }

  /**
   * Send one raw frame, bypassing every convenience above — the escape hatch protocol
   * tests need for the cases that are ill-formed BY CONSTRUCTION: a pre-register MCP
   * message, an unknown `hub/` method, a response to no request. A harness that could
   * only send well-formed frames could not test the rejection of malformed ones.
   */
  async sendRaw(frame: JsonRpcRequest | JsonRpcResponse | Record<string, unknown>): Promise<void> {
    // deps: WebSocket.send
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Close from this side, simulating the bot dying rather than the hub evicting it —
   * distinct from every hub-initiated close because no close code carries meaning back to
   * the hub. Idempotent; fixtures call it in teardown unconditionally (the tunnel project
   * shares storage, so a leaked socket is a leak into the NEXT file).
   */
  async close(): Promise<void> {
    // deps: WebSocket.close
    if (this.ended) return;
    try {
      this.socket.close(1000, "fixture teardown");
    } catch {
      // already gone
    }
    this.end(1000, "fixture teardown");
  }

  /** The register frame, sent by connectFakeApp — spelled here so the whole wire
   *  shape §6 pins lives in one place. */
  async sendRegister(extra?: Record<string, unknown>): Promise<void> {
    this.registerId = crypto.randomUUID();
    await this.sendRaw({
      jsonrpc: "2.0",
      id: this.registerId,
      method: "hub/register",
      params: {
        clientVersion: "fake-app/0",
        protocolVersion: "2026-07-28",
        roles: this.options.roles ?? {},
        ...extra,
      },
    });
  }

  /** One inbound frame: recorded verbatim first, interpreted second. */
  private receive(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    (this.frames as Record<string, unknown>[]).push(frame);
    const method = frame.method;
    if (method === undefined) return this.answerToOurs(frame);
    if (method === "hub/replaced") return this.settleReplaced?.();
    if (method === "server/discover") return this.serveDiscover(frame);
    const family = familyOfMethod(method);
    if (family !== undefined) return this.serveList(family, frame);
    if (method === "tools/call") return this.serveCall(frame);
    if (method === "resources/subscribe" || method === "resources/unsubscribe") {
      // §21.4/§11: the author's SDK answers these itself, so the app answers with the
      // empty result MCP defines and keeps no set of its own. Already recorded in `frames`.
      return this.reply({ jsonrpc: "2.0", id: String(frame.id), result: {} });
    }
    // Everything else (the hub's warning notifications) is recorded and nothing more.
  }

  /**
   * §6's one registration-time control question in the MCP namespace: which families does
   * this app serve? A real client library answers it ITSELF, from what the author's SDK
   * registered (§11) — which is why this fake answers from its own catalogs rather than
   * bridging anywhere, and why a fixture can make it answer `-32601` to stand in for every
   * library in the field that predates the method.
   *
   * The answer is a genuine 2026-07-28 `DiscoverResult`: `supportedVersions`, a
   * `capabilities` object keyed by family, `resultType`. `listChanged` and `subscribe` are
   * claimed TRUE deliberately — §20.2 forces both false in what the hub re-advertises
   * "whatever the app claims", and a fixture that claimed false could not tell a hub
   * that forces them from one that merely copies them.
   */
  private serveDiscover(frame: Record<string, unknown>): void {
    const wireId = String(frame.id);
    switch (this.discoverBehavior.mode) {
      case "answer":
        return this.reply({
          jsonrpc: "2.0",
          id: wireId,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: capabilitiesOf(this.capabilities),
            resultType: "complete",
          },
        });
      case "error":
        return this.reply({ jsonrpc: "2.0", id: wireId, error: this.discoverBehavior.error });
      case "hang":
        return;
    }
  }

  /** A reply to a request THIS side sent — only `hub/register` is ever one. */
  private answerToOurs(frame: Record<string, unknown>): void {
    if (frame.id !== this.registerId) return;
    const error = frame.error as { code: number; message: string } | undefined;
    this.settleRegistered?.(error === undefined ? { ok: true } : { ok: false, error });
  }

  private serveList(family: CatalogFamily, frame: Record<string, unknown>): void {
    const wireId = String(frame.id);
    // BEFORE the branch, like serveCall: "the hub asked" and "the hub was answered" are
    // different questions, and a warm that draws no catalog is still a list that arrived.
    // (`frames` already recorded it; `lists` is the tools-only reading of the same event.)
    if (family === "tools") (this.lists as { wireId: string; seq: number }[]).push({ wireId, seq: ++this.seq });
    else this.seq++;
    const behavior = this.listBehaviors.get(family) ?? this.listBehavior;
    switch (behavior.mode) {
      case "answer":
        // The result member is named after the family, for all four (§20.5's key names are
        // the catalog's; MCP's result members are the same words).
        return this.reply({
          jsonrpc: "2.0",
          id: wireId,
          result: { [family]: family === "tools" ? this.tools : (this.catalogs.get(family) ?? []) },
        });
      case "error":
        return this.reply({ jsonrpc: "2.0", id: wireId, error: behavior.error });
      case "hang":
        return;
    }
  }

  private serveCall(frame: Record<string, unknown>): void {
    const wireId = String(frame.id);
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const tool = String(params.name ?? "");
    // BEFORE the branch: a hung or dropped call counts exactly like an answered one.
    (this.invocations as Invocation[]).push({
      tool,
      args: params.arguments as Record<string, unknown> | undefined,
      meta: params._meta as Record<string, unknown> | undefined,
      wireId,
      seq: ++this.seq,
    });
    const behavior = this.behaviors.get(tool) ?? this.options.behavior ?? { mode: "answer", result: {} };
    switch (behavior.mode) {
      case "answer":
      case "input_required":
        return this.reply({ jsonrpc: "2.0", id: wireId, result: behavior.result });
      case "error":
        return this.reply({ jsonrpc: "2.0", id: wireId, error: behavior.error });
      case "hang":
        this.parked.push({ tool, wireId });
        return;
      case "drop":
        void this.close();
        return;
    }
  }

  private reply(frame: Record<string, unknown>): void {
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // the hub closed the socket under us; the fixture reads `closed` for why
    }
  }

  /** The one place this side learns the connection is over, whoever ended it. */
  private end(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.settleClosed?.({ code, reason });
    this.failRegistered?.(new Error(`socket closed (${code}) before hub/register was answered`));
  }
}

/**
 * The consumer end of one §21.2 SUBSCRIBER socket: opened through the DO's second upgrade
 * door with the two headers the Worker writes, and accepted test-side, so it hibernates,
 * survives eviction, and is enumerated by the DO exactly like the Worker's own.
 *
 * It records frames and sends almost nothing: the hub writes on these sockets and reads
 * nothing from them (§21.2), and `sendRaw` exists only so a fixture can prove that — a
 * frame from here must warm no catalog and ring no bell.
 */
export class FakeSubscriber {
  /** The stream's minted session id, which is also this socket's tag suffix (§21.2). */
  readonly sessionId: string;
  /** The principal the Worker resolved, stored in the DO's attachment — a subscribe by any
   *  other principal must not mutate this socket, however right its session id is (§21.4). */
  readonly principal: string;
  /** Resolves with the close code when the socket ends — §21.2's "app delete closes
   *  subscriber sockets too" and its twins are read here. */
  readonly closed: Promise<{ code: number; reason: string }>;

  private readonly received: Record<string, unknown>[] = [];
  private readonly socket: WebSocket;
  private readonly settleClosed: (end: { code: number; reason: string }) => void;
  private ended = false;

  constructor(socket: WebSocket, sessionId: string, principal: string) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.principal = principal;
    // The executor form, not Promise.withResolvers: this repo's lib target is ES2022 and
    // workerd's own runtime is what the suite runs on — the same shape FakeApp uses.
    let settle: (end: { code: number; reason: string }) => void = () => undefined;
    this.closed = new Promise((resolve) => {
      settle = resolve;
    });
    this.settleClosed = settle;
    socket.accept();
    socket.addEventListener("message", (event) => this.record(event as MessageEvent));
    socket.addEventListener("close", (event) => {
      const closing = event as CloseEvent;
      this.end(closing.code, closing.reason);
    });
    socket.addEventListener("error", () => this.end(1006, "transport error"));
  }

  /** Every frame the DO wrote here, verbatim: a doorbell carries nothing but a method and
   *  an `updated` carries a uri, so the whole claim of both is readable off this array. */
  get frames(): readonly Record<string, unknown>[] {
    // deps: none
    return this.received;
  }

  /** How many frames carried this method — the doorbell count every §21.3 row asserts on. */
  count(method: string): number {
    // deps: none
    return this.frames.filter((frame) => frame.method === method).length;
  }

  /** True until this side or the hub ended the socket. */
  get open(): boolean {
    // deps: none
    return !this.ended;
  }

  /** One frame FROM the consumer — the thing the hub must never read (§21.2). */
  async sendRaw(frame: Record<string, unknown>): Promise<void> {
    // deps: WebSocket.send
    this.socket.send(JSON.stringify(frame));
  }

  /** Close from this side — the stream ending. Idempotent; every fixture calls it in
   *  teardown, because this project shares sockets across files. */
  async close(): Promise<void> {
    // deps: WebSocket.close
    if (this.ended) return;
    try {
      this.socket.close(1000, "fixture teardown");
    } catch {
      // already gone
    }
    this.end(1000, "fixture teardown");
  }

  /** One inbound frame, parsed and kept whole. A frame that is not JSON at all is nothing
   *  this wire carries, and the row that cares reads `frames` and finds it absent. */
  private record(event: MessageEvent): void {
    try {
      this.received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    } catch {
      // not JSON — see above
    }
  }

  private end(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.settleClosed({ code, reason });
  }
}

/**
 * Open one subscriber socket into an app's DO, through the DO's own fetch door — the
 * SAME door the Worker uses, reached with the DO stub the fixture already has (the stub is
 * a parameter rather than an import so this file stays free of `cloudflare:test`, whose
 * absence is what lets it be a plain WebSocket client).
 *
 * The two headers are spelled, not imported: tunnel.ts's door names them, and a harness
 * that imported the names could not fail when the door renamed one.
 */
export async function openSubscriber(
  connection: { fetch(req: Request): Promise<Response> },
  options: { principal: string; sessionId?: string },
): Promise<FakeSubscriber> {
  // deps: AppConnection.fetch (the DO's second upgrade door) · WebSocket
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const response = await connection.fetch(
    new Request("https://pmcp.invalid/subscribe", {
      headers: {
        Upgrade: "websocket",
        "x-pmcp-session-id": sessionId,
        "x-pmcp-principal": options.principal,
      },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) throw new UpgradeRefused(response.status);
  return new FakeSubscriber(socket, sessionId, options.principal);
}

/** Which catalog a hub-originated list method asks for, or undefined for anything that is
 *  not one — the inverse of {@link LIST_METHOD}, kept beside it so the two cannot drift. */
function familyOfMethod(method: unknown): CatalogFamily | undefined {
  const entry = Object.entries(LIST_METHOD).find(([, name]) => name === method);
  return entry === undefined ? undefined : (entry[0] as CatalogFamily);
}

/**
 * The families a fixture's catalogs imply, when it did not spell `capabilities` itself:
 * tools always (every app has a tool list, empty or not, and §6's fallback warms
 * exactly that), plus prompts and resources when a catalog for them was supplied. The
 * `resources` declaration covers BOTH resource keys (§20.5), so either catalog declares it.
 */
function declaredFamilies(options: FakeAppOptions): readonly string[] {
  const families = ["tools"];
  if (options.prompts !== undefined) families.push("prompts");
  if (options.resources !== undefined || options.resourceTemplates !== undefined) {
    families.push("resources");
  }
  return families;
}

/** A `ServerCapabilities` object over the declared family names — the shape a 2026-07-28
 *  `server/discover` answers with, so the hub reads capabilities rather than a bare list. */
function capabilitiesOf(families: readonly string[]): Record<string, Record<string, unknown>> {
  const claimed: Record<string, Record<string, unknown>> = {};
  for (const family of families) {
    if (family === "resources") claimed[family] = { subscribe: true, listChanged: true };
    else if (family === "completions") claimed[family] = {};
    else claimed[family] = { listChanged: true };
  }
  return claimed;
}

/**
 * Dial the hub and, unless `skipRegister` says otherwise, complete `hub/register` before
 * resolving — so a fixture's first line establishes "this app is online" as a fact
 * rather than a hope. Rejects when the upgrade itself fails, carrying the HTTP status
 * verbatim: 401 and 403 are the pinned §6 contract (fatal credential vs archived), and a
 * fixture asserting 403-means-exactly-archived needs the raw number, not an exception
 * class that has already interpreted it.
 *
 * "Complete" includes completing badly: a refused declaration and the 4003 race both END
 * the handshake, and the fixture reads `registered` / `closed` for which happened. Only
 * the UPGRADE throws — a socket that was never opened is a fixture bug, a socket that was
 * opened and then refused is the subject of half this directory.
 */
export async function connectFakeApp(options: FakeAppOptions): Promise<FakeApp> {
  // deps: WebSocket · JSON.stringify/parse (one message per text frame, §6)
  const response = await upgrade(options.origin, options.token);
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) throw new UpgradeRefused(response.status);
  const app = new FakeApp(socket, options);
  if (options.skipRegister === true) return app;
  await app.sendRegister();
  await app.registered.catch(() => undefined);
  return app;
}

/**
 * The upgrade WITHOUT a socket: performs the `/connect` request and returns the response
 * status, for the rows that are about refusal rather than about a connection — 401 for
 * every credential failure (missing, wrong kind, revoked, expired, app row gone,
 * proxy kind) and 403 for exactly one thing, archived. Its allow-twin is
 * connectFakeApp itself: the same credential, one state different, reaching 101.
 */
export async function attemptUpgrade(options: {
  origin: string;
  token?: string;
}): Promise<{ status: number }> {
  // deps: fetch (Upgrade: websocket)
  const response = await upgrade(options.origin, options.token);
  // A row that reached 101 still has to give the socket back, or it leaks into the next
  // file: this project shares storage AND sockets across files.
  response.webSocket?.close(1000, "upgrade probe");
  return { status: response.status };
}

/**
 * The one dial. Goes through the RUNNING ROUTER (`exports.default.fetch`) rather than
 * calling tunnel.handleConnect: /connect being mounted, and mounted for the right method,
 * is part of what a fixture claims when it says an app connected.
 */
function upgrade(origin: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return workerExports.default.fetch(new Request(`${origin}/connect`, { headers }));
}

/**
 * One turn of the event loop — long enough for frames already in flight to be delivered.
 * The whole of a fixture's waiting is built from this rather than from durations: workerd
 * is cooperative, so "has it arrived yet" is a question about scheduling, not about time,
 * and no suite in this directory ever sleeps (strategy §3).
 *
 * One millisecond rather than zero, and the difference is load-bearing: a hub round trip
 * crosses D1 and the DO's own storage, and a queue of zero-delay turns drains in less wall
 * time than one of those writes takes — which reads in a suite as "the frame never came".
 */
export function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait until `predicate` holds, or give up after `turns` of the loop and answer false —
 * bounded so a claim that never becomes true fails as an assertion rather than as a test
 * timeout with nothing to read. `false` is a legitimate answer, which is what makes it the
 * way to observe an absence too ("no frame like this ever arrived"); the default budget is
 * generous for that reason — it is paid in full only when the answer is "never".
 */
export async function waitFor(predicate: () => boolean, turns = 250): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}
