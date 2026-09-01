/**
 * tunnel.ts — the reverse-connection subsystem: the worker-side /connect upgrade and the
 * AppConnection Durable Object (the hub's only DO class), one instance per tunneled
 * app, addressed by the opaque `app.id` — never user/slug, so deleting a user and
 * recreating the username can never rebind to a stale DO.
 *
 * This module owns the whole §6 wire protocol so no other module ever learns its
 * MECHANICS — framing, correlation, the attachment format. The protocol's published
 * VOCABULARY (the 4000–4004 close codes and the hub/* method names) is different: it
 * is the cross-language contract the client libraries hard-code, so it is exported
 * below for exactly one consumer — the contracts fixture producer (§4 of the testing
 * strategy; the tunnel protocol suite asserts observed wire values equal these
 * exports, locking behavior to the table). No sibling module imports them:
 * hub/register validation with the 10 s registration deadline (close 4004), newest-wins
 * replacement at socket *acceptance* (hub/replaced, then close 4000) — only 4001/4002
 * escape as SeverCode for callers — liveness by WebSocket protocol pings (runtime auto-pong, no application
 * heartbeat), and the stateless 2026-07-28 wire — `initialize` never crosses; every
 * hub-originated request is self-contained, carrying its protocol `_meta` fields. It also
 * owns the hibernation discipline: socket identity rides serializeAttachment, in-flight
 * correlation lives in an in-memory Map with 30 s timeouts (safe because an unresolved
 * inbound request blocks hibernation), and §20.5's FOUR catalogs — tools, prompts,
 * resources, resource templates — are cached in DO SQLite beside the capability set the
 * registration-time `server/discover` learned, so all of it survives disconnects and
 * deploys (each catalog invalidated by its family's own list_changed frame, and re-listed
 * on the next demand when a registration's warm never landed one — an online app
 * serving no catalog refuses every call, so it may not be a terminal state).
 *
 * One MECHANIC is published rather than hidden, because a test leans on it: the
 * correlation deadline is armed ONCE per hub-originated request, as a single ambient
 * `setTimeout` at exactly limits.CALL_TIMEOUT_MS (AppConnection.request). That is the
 * seam tunnel/pipeline-tunnel.test.ts shrinks to observe §15's deadline against the
 * constant instead of waiting it out — so arming it differently (a storage alarm, a value
 * derived from the constant) is a change to this sentence and to that suite, never a
 * silent one.
 *
 * Role declarations pass straight through registry.upsertDeclaredRoles — the roles_json
 * format never enters this module. The worker half reaches its DO namespace binding
 * (APP_CONNECTION) via the importable env of `cloudflare:workers`, so callers never
 * thread an env object; the composition root owns the binding name.
 *
 * §21 gave this DO a SECOND CLASS of socket, and with it three mechanics the module now
 * also owns. The SUBSCRIBER ACCEPT DOOR: a second upgrade path beside /connect's, through
 * which the Worker opens one hibernatable socket per held listen stream, tagged
 * `sub:<session-id>` and carrying the resolved principal and that stream's subscription
 * set in its attachment. The DOORBELL AT THE WRITE: a warm whose canonical catalog
 * differs from the stored one rings that family's bell on every subscriber socket the DO
 * holds, behind a leading-edge floor whose state is DURABLE (a burst that straddles a
 * hibernation must not lose its trailing ring). And the ALARM MULTIPLEXING: that floor's
 * coalescing timer shares §6's single alarm slot with the registration deadline, so the
 * handler runs both legs and neither purpose can clobber the other.
 *
 * The class invariant is the tag PREFIX and nothing else (§21.2): every reader below
 * selects the app socket by class rather than by position, so a subscriber socket
 * accepted first is never mistaken for the bot's connection, and a frame arriving on one
 * is never read as app traffic.
 */

import { DurableObject, env } from "cloudflare:workers";
import { record } from "./audit";
import {
  BELL_PROMPTS,
  BELL_RESOURCES,
  BELL_TOOLS,
  bellFrame,
  catalogChanged,
  DEFAULT_APP_CAPABILITIES,
  familyBell,
  parseSubscriberTag,
  RESOURCES_UPDATED,
  subscribeAllowed,
  subscriberTag,
} from "./capabilities";
import { CODES, HubError, unavailable } from "./errors";
import type { BackendCtx, JsonRpcRequest, JsonRpcResponse, AppBackend, Tool } from "./gateway";
import { formatPrincipal } from "./principal";
import { resolveAppToken } from "./identity";
import { CALL_TIMEOUT_MS, LISTEN_BELL_MIN_INTERVAL_MS, REGISTRATION_DEADLINE_MS } from "./limits";
import {
  patternFamilyOf,
  Registry,
  APP_CAPABILITIES,
  subjectKeyOf,
  validateRoles,
  validateSchemaIndirection,
  writeOnlyPaths,
} from "./registry";
import type { ListKind, RoleDeclaration, App, AppCapability } from "./registry";

/**
 * Close code for connection replacement: a newer socket took the slot (after the
 * hub/replaced notification) — the client stops quietly and never reconnects (§6).
 * Exported as published vocabulary (module header); never a SeverCode.
 */
export const CLOSE_REPLACED = 4000;

/**
 * Close code for token-revoked / app-deleted evictions: the client library treats it
 * like a 401 — stop reconnecting and surface a credentials error (§6).
 */
export const CLOSE_REVOKED = 4001;

/**
 * Close code for archival: the client library keeps retrying at max backoff, so
 * unarchiving heals within a minute without touching the bot (§6).
 */
export const CLOSE_ARCHIVED = 4002;

/**
 * Close code for the row-gone-during-register race: the app row vanished between
 * upgrade and registration — the client reconnects; a truly deleted app meets
 * 401 at the next upgrade (§6). Published vocabulary; never a SeverCode.
 */
export const CLOSE_ROW_GONE = 4003;

/**
 * Close code for protocol violations and the missed registration deadline — also the
 * self-heal path for an unintelligible hibernation attachment. The client
 * reconnects (§6). Published vocabulary; never a SeverCode.
 */
export const CLOSE_PROTOCOL = 4004;

/**
 * The hub/* control-frame method names — the other half of the published wire
 * vocabulary (§6): `register` is the client's one pre-traffic obligation,
 * `replaced` the hub's step-aside notification before CLOSE_REPLACED.
 */
export const HUB_METHODS = { register: "hub/register", replaced: "hub/replaced" } as const;

/**
 * What a client library must DO about a close — the third piece of published vocabulary,
 * and the one the two client reconnect tables transcribe verbatim. It lives here beside
 * the numbers for the same reason they do: a policy change and a renumbering are the same
 * kind of change to the cross-language contract, and both must reach the fixture through
 * this module rather than through a literal typed into the fixture's producer.
 */
export type CloseBehavior = "stop_fatal" | "stop_quiet" | "reconnect";

/** How a `reconnect` behavior redials — named only where reconnecting is the behavior. */
export type CloseSchedule = "exponential" | "max_only";

/** The closed behavior vocabulary, as a value: a client checking its own table against
 *  the contract needs the SET, not only the per-code entries. */
export const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ["stop_fatal", "stop_quiet", "reconnect"];

/** The closed schedule vocabulary, same reason. */
export const CLOSE_SCHEDULES: readonly CloseSchedule[] = ["exponential", "max_only"];

/**
 * §6's close-code → required-client-behavior table, whole. Every code above appears
 * exactly once, and the reasoning for each is on the constant itself.
 */
export const CLOSE_POLICY: Readonly<
  Record<number, { behavior: CloseBehavior; schedule?: CloseSchedule }>
> = {
  [CLOSE_REPLACED]: { behavior: "stop_quiet" },
  [CLOSE_REVOKED]: { behavior: "stop_fatal" },
  [CLOSE_ARCHIVED]: { behavior: "reconnect", schedule: "max_only" },
  [CLOSE_ROW_GONE]: { behavior: "reconnect", schedule: "exponential" },
  [CLOSE_PROTOCOL]: { behavior: "reconnect", schedule: "exponential" },
};

/**
 * The only close codes a caller may hand to sever(). CLOSE_REPLACED / CLOSE_ROW_GONE /
 * CLOSE_PROTOCOL are issued by this module alone — exported above as contract
 * vocabulary, never accepted here.
 */
export type SeverCode = typeof CLOSE_REVOKED | typeof CLOSE_ARCHIVED;

/**
 * Why a forward produced no answer — the §15 at-most-once question, in three words.
 * Exactly ONE of them means the frame certainly did not execute: `offline`, where nothing
 * was sent and the hub has no outbox. The other two are both "it LEFT and drew no readable
 * answer", told apart only for the operator reading the ledger: `timeout` is the budget
 * expiring (and an answer this hub cannot parse, which is the same silence), `disconnected`
 * is the socket dying under a frame already on the wire.
 */
export type ForwardFailure = "offline" | "timeout" | "disconnected";

/**
 * Outcome of AppConnection.forward — the worker↔DO seam for one forwarded call.
 * Every failure reason maps to -32000 at the backend, but they stay distinct because only
 * `offline` means the call certainly did not execute; the backend hands the reason to
 * errors.unavailable, which puts it on the thrown HubError as its `auditDetail` and — for
 * the two that may have run — as the may-have-executed clause of its message, which is how
 * it reaches the tools/call row and the consumer.
 *
 * `response` is ESTABLISHED, never asserted: answerOf parses it out of the inbound frame,
 * so `ok: true` really does mean a JSON-RPC response with exactly one of result/error.
 */
export type ForwardResult =
  | { ok: true; response: JsonRpcResponse }
  | { ok: false; reason: ForwardFailure };

/**
 * Worker half of `wss://<host>/connect`: authenticates the `pmcp_app_` bearer, resolves
 * the tunneled app, and hands the upgrade to that app's DO by `app.id`.
 *
 * The response status is a pinned contract with the client libraries (§6): 401 for every
 * credential failure — missing/invalid/expired/revoked token, wrong token kind, app
 * row gone or of proxy kind — meaning fatal, stop and surface; 403 means exactly one
 * thing, the app is archived — keep retrying at max backoff so unarchiving heals on
 * its own; success is the 101 upgrade with the socket accepted by the DO. Never consults
 * cookies or query-string tokens. The DO learns the connection's identity (app, owner,
 * opening token) from this handler, not from re-validating anything itself.
 */
export async function handleConnect(req: Request): Promise<Response> {
  // deps: identity.resolveAppToken · registry.appById · cloudflare:workers env.APP_CONNECTION · AppConnection.fetch
  if (!isUpgrade(req)) return refuse(426, "Upgrade Required");
  const resolved = await resolveAppToken(req);
  // One verdict for every credential failure — which check refused is never observable.
  // The verdict carries the token ROW's id, so the plaintext bearer never leaves
  // identity.ts and the hashing scheme keeps one home (§15).
  if (resolved === null) return refuse(401, "Unauthorized");
  const app = await new Registry(env.DB).appById(resolved.appId);
  if (app === null || app.kind !== "tunnel") return refuse(401, "Unauthorized");
  // The one thing 403 means (§6): archived, so the client keeps retrying and unarchiving
  // heals without touching the bot.
  if (app.archived) return refuse(403, "Forbidden");
  // A FRESH request, not a forward of this one: the DO learns the connection's identity
  // from these four headers and must never see the bearer that produced them (§3, §15).
  return connectionFor(app.id).fetch(
    new Request(req.url, {
      headers: {
        Upgrade: "websocket",
        [IDENTITY_HEADER.app]: app.id,
        [IDENTITY_HEADER.owner]: app.ownerId,
        [IDENTITY_HEADER.slug]: app.slug,
        [IDENTITY_HEADER.token]: resolved.tokenId,
      },
    }),
  );
}

/** The `Upgrade: websocket` test both halves of the seam apply — the worker's door and the
 *  DO's, which accepts nothing else. */
function isUpgrade(req: Request): boolean {
  return req.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** A refused upgrade: a status and nothing else. The client library reads the number, and
 *  §6 gives the body no meaning — so it carries no hint of which check refused. */
function refuse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * The four headers the worker half hands the DO — an internal seam between the two halves
 * of this module, never a wire format and never carrying credential material (§3: the DO
 * trusts the Worker and validates nothing itself; §15: the bearer stops here).
 */
const IDENTITY_HEADER = {
  app: "x-pmcp-app-id",
  owner: "x-pmcp-owner-id",
  slug: "x-pmcp-slug",
  token: "x-pmcp-token-id",
} as const;

/**
 * The two headers the worker half hands the DO for a SUBSCRIBER upgrade (§21.2) — the
 * same internal seam as IDENTITY_HEADER, under the same rules: never a wire format, never
 * credential material. The session id is the stream's minted correlation id and becomes
 * the socket's tag; the principal is the caller the Worker already resolved, stored so a
 * later `resources/subscribe` can be authorized against it (§21.4: the id selects, the
 * principal authorizes).
 */
const SUBSCRIBER_HEADER = {
  session: "x-pmcp-session-id",
  principal: "x-pmcp-principal",
} as const;

/** The one place an app id becomes a DO stub — every export below goes through it. */
function connectionFor(appId: App["id"]): AppConnection {
  const namespace = env.APP_CONNECTION as DurableObjectNamespaceLike<AppConnection>;
  return namespace.get(namespace.idFromName(appId));
}

/**
 * The tunnel implementation of AppBackend — how the gateway pipeline reaches a
 * tunneled app, §20's three further listings included. Every method addresses the
 * app's DO by `app.id`; none of them performs authorization (the gateway's
 * filter/archived/approval checks have already run by the time a backend is called).
 * What the app listed is cached and relayed VERBATIM; the hub reads no field of an
 * entry beyond the one key §20.2 matches its family on, and a second, weaker copy of the
 * MCP descriptors the gateway publishes is exactly what §20 must not grow.
 */
export const tunnelBackend: AppBackend = {
  /**
   * Serves AppConnection.listTools's cached catalog — that method owns the contract.
   * What this half adds: worker-side DO addressing, and that the list is returned
   * unfiltered, because role filtering is the gateway's job.
   */
  async listTools(app, ctx) {
    // deps: viaConnection · AppConnection.listTools
    return cachedCatalog(app.id);
  },

  /**
   * The cached prompt catalog (§20.5), under exactly the contract listTools answers under:
   * whole-read from storage, empty for an app that never declared the family, never a
   * wait on the socket. Unfiltered — matching prompts by NAME against the caller's patterns
   * is the gateway's (§20.2).
   */
  async listPrompts(app, ctx) {
    // deps: viaConnection · AppConnection.listCatalog
    return cachedFamily(app.id, "prompts");
  },

  /** The cached resource catalog, same contract — matched by `uri` at the door, never by
   *  `name` (§20.2), which is why nothing here reads either. */
  async listResources(app, ctx) {
    // deps: viaConnection · AppConnection.listCatalog
    return cachedFamily(app.id, "resources");
  },

  /** The cached resource-template catalog — its own key because §20.5 gives it one, warmed
   *  and cleared by the `resources` declaration that covers both. */
  async listResourceTemplates(app, ctx) {
    // deps: viaConnection · AppConnection.listCatalog
    return cachedFamily(app.id, "resourceTemplates");
  },

  /**
   * Forwards one request over the live registered socket and returns the app's
   * response verbatim (the gateway re-addresses it to the consumer). Before the frame
   * leaves it is stamped with the §6 fields a self-contained hub-originated request must
   * carry — see `stamped`. Offline, unregistered, 30 s without an answer, a socket that
   * died under the frame, or a DO that could not be reached at all: all throw HubError
   * -32000, and the hub never queues. Which of them it was is not lost — the class rides
   * errors.unavailable into the audit row and, for everything but the offline case, tells
   * the consumer the call may still have executed (at-most-once, §15).
   */
  async call(app, msg, ctx) {
    // deps: viaConnection · AppConnection.forward · errors.unavailable
    // A stub that breaks may have broken AFTER the frame left, so the DO's own failure is
    // a dispatch failure like any other rather than an unclassified -32603 (§10's code
    // contract: map any DO-stub throw to -32000).
    const outcome = await viaConnection(app.id, "do_unreachable", (connection) =>
      connection.forward(stamped(msg, ctx)),
    );
    // Every reason is one -32000 on the wire; which one it was rides the error's
    // auditDetail into the tools/call row, which is the only place §15's at-most-once
    // question — did this call certainly not execute, or may it have? — can be answered.
    if (!outcome.ok) throw unavailable(outcome.reason);
    return outcome.response;
  },

  /**
   * The schema-declared half of §7's redaction union, both directions: hands the
   * cached catalog entry's inputSchema and outputSchema each to
   * registry.writeOnlyPaths — the one definition of the path grammar — and returns
   * `{ args, results }` (an absent outputSchema yields empty results); the caller
   * unions config-declared `redact` / `redact_results` paths in itself.
   * Returns null when the tool is absent from the cached catalog (never-connected
   * apps included) OR cached flagged schema-unsound (its schema tripped
   * validateSchemaIndirection at catalog warm, §7): the gateway answers -32001
   * (indistinguishable from
   * not-permitted, §7) and nothing downstream runs. Answers from the cache: the one thing
   * it can put on the live socket is listTools's own re-warm, which nothing here awaits.
   */
  async sensitivePaths(app, tool) {
    // deps: viaConnection · AppConnection.listTools · registry.writeOnlyPaths
    const entry = (await cachedCatalog(app.id)).find((t) => t.name === tool);
    if (entry === undefined) return null;
    if (schemaViolations(entry).length > 0) return null;
    return {
      args: writeOnlyPaths(entry.inputSchema),
      results: entry.outputSchema === undefined ? [] : writeOnlyPaths(entry.outputSchema),
    };
  },
};

/** The DO's cached TOOL catalog as the worker half reads it — the one place both backend
 *  methods that need it go through, so the RPC contract below is applied once. */
function cachedCatalog(appId: App["id"]): Promise<Tool[]> {
  // deps: viaConnection · AppConnection.listTools
  return viaConnection(appId, "catalog_unreachable", (connection) => connection.listTools());
}

/**
 * …and the same read for §20.5's other three catalogs. Generic in what the caller CALLS
 * the entries: the DO caches whatever the app listed and interprets none of it, so the
 * shape is the reader's to name — AppBackend names each family by the one key §20.2
 * matches it on.
 */
function cachedFamily<T>(appId: App["id"], family: CatalogFamily): Promise<T[]> {
  // deps: viaConnection · AppConnection.listCatalog
  return viaConnection(appId, "catalog_unreachable", (connection) =>
    connection.listCatalog<T>(family),
  );
}

/**
 * The capability set this app DECLARED at its last successful registration (§20.5),
 * for §20.2's scoped handshake — configuration the hub was told, read from the DO's
 * durable state and never a live call, so a hung app still answers `initialize` at
 * full speed.
 *
 * Answers `tools` for an app that has never connected, whose discover has never
 * succeeded, or whose DO cannot be reached at all — §20.2's "a capability the hub has
 * never been told about is not declared", and the same swallow-to-the-truthful-answer
 * policy status() takes: a handshake has no consumer to hand a refusal to, and an app
 * whose declaration cannot be consulted is certainly not known to serve more than tools.
 */
export async function capabilities(appId: App["id"]): Promise<AppCapability[]> {
  // deps: viaConnection · AppConnection.capabilities
  return viaConnection(appId, "catalog_unreachable", (connection) =>
    connection.capabilities(),
  ).catch(() => [...DEFAULT_CAPABILITIES]);
}

/**
 * One DO RPC on the consumer's path, inside §7's pinned contract. A stub call can fail for
 * reasons that are nothing to do with the app — the instance forcibly restarted, the
 * namespace refusing, the RPC itself breaking — and none of those is a HubError, so without
 * this the gateway maps them to -32603 with the cause discarded and the tools/call row
 * loses its failure class. §10 names it as a code contract for exactly that reason: map any
 * DO-stub throw to -32000. A HubError from inside the DO is already in the contract and
 * passes through untouched.
 *
 * NOT applied to sever/wipe: those are owner-side cascades whose failure must reach the
 * owner as a failed admin op, and "app unavailable" is not what a failed teardown is.
 */
async function viaConnection<T>(
  appId: App["id"],
  reason: DispatchFailure,
  rpc: (connection: AppConnection) => Promise<T>,
): Promise<T> {
  // deps: connectionFor · errors.unavailable
  try {
    return await rpc(connectionFor(appId));
  } catch (err) {
    if (err instanceof HubError) throw err;
    // The operator's line for a hub-side fault: the app id and the class, never a
    // credential and never a frame (§15). The exception itself is Workers Logs' business.
    console.error(`pmcp/do-rpc: ${reason} for ${appId}`, err);
    throw unavailable(reason);
  }
}

/**
 * Why a tunneled dispatch failed, in the vocabulary the tools/call row records — the
 * forward's three reasons plus the two the DO seam itself can fail with. All five are one
 * -32000 on the wire (§7 makes dispatch failures indistinguishable BY CODE); the ledger is
 * where they stay apart, and errors.unavailable is where each one's at-most-once disclosure
 * is decided — this module hands over the class and reads no message of its own, because a
 * proxied timeout and a tunneled one are the same fact and must not answer differently.
 */
type DispatchFailure = ForwardFailure | "do_unreachable" | "catalog_unreachable";

/**
 * One catalog entry's §7 indirection violations, both schemas at once — the refuse-line
 * registry.validateSchemaIndirection owns, applied to what the cache holds.
 *
 * ponytail: DERIVED at read time rather than stored as a flag beside the cached tool.
 * validateSchemaIndirection is pure over the very schema the cache keeps verbatim, so a
 * stored bit could only ever disagree with it — and the cache stays the verbatim oracle
 * listTools promises. The registration-time call (warmCatalog) is the LOUD half: it is
 * what puts the violations in front of the app and the operator.
 */
function schemaViolations(tool: Tool): string[] {
  return [
    ...validateSchemaIndirection(tool.inputSchema),
    ...(tool.outputSchema === undefined ? [] : validateSchemaIndirection(tool.outputSchema)),
  ];
}

/**
 * One forwarded frame as the app receives it: §6's identity keys, resolved from ctx,
 * over the protocol fields every hub-originated request carries.
 *
 * It does NOT filter the consumer's `_meta`. `hub/*` HYGIENE — which consumer keys are
 * dropped, and what the reserved prefix means — is gateway.prepareForward's, a chokepoint
 * this message has already passed (that module's header owns the decision, and
 * AppBackend.call's interface comment says `msg` arrives post-hygiene). A second pass
 * here would be a second owner: idempotent today, and silently deleting the next `hub/*`
 * key the gateway learns to send.
 */
function stamped(msg: JsonRpcRequest, ctx: BackendCtx): JsonRpcRequest {
  const supplied = msg.params?._meta;
  const meta = withProtocolFields(
    typeof supplied === "object" && supplied !== null ? (supplied as Record<string, unknown>) : {},
  );
  meta["hub/principal"] = formatPrincipal(ctx.principal);
  meta["hub/roles"] = ctx.roles;
  return { ...msg, params: { ...(msg.params ?? {}), _meta: meta } };
}

/**
 * The self-contained protocol fields of the stateless 2026-07-28 wire — `initialize`
 * never crosses, so a request that did not carry them would be unanswerable. Shared with
 * warmCatalog, which needs them with no consumer behind it at all: the mirrored
 * capabilities are then `{}`, which is also what a consumer that declared none forwards.
 */
function withProtocolFields(meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...meta,
    [PROTOCOL_META.version]: WIRE_REVISION,
    [PROTOCOL_META.capabilities]: meta[PROTOCOL_META.capabilities] ?? {},
  };
}

/** The reserved `_meta` keys of the 2026-07-28 wire every hub-originated request carries. */
const PROTOCOL_META = {
  version: "io.modelcontextprotocol/protocolVersion",
  capabilities: "io.modelcontextprotocol/clientCapabilities",
} as const;

/** The one MCP revision this hub speaks over the socket — gateway holds the consumer-side
 *  twin of this constant; §6 pins them to the same string. */
const WIRE_REVISION = "2026-07-28";

/**
 * §20.5's four catalogs — §6's tool list plus the three families §20 proxies. Everything
 * about a warm is identical in all four (one hub-originated request, one result object
 * whose single member is named after the family, one durable key written whole), so they
 * are ONE vocabulary here and the three tables below are all that differ.
 */
const CATALOG_FAMILIES = ["tools", "prompts", "resources", "resourceTemplates"] as const satisfies readonly ListKind[];
type CatalogFamily = (typeof CATALOG_FAMILIES)[number];

/** Each catalog's durable key, by the names §20.5 spells. `tools` keeps §6's original key:
 *  renaming it would strand the cache of every DO already in the field. */
const CATALOG_KEY: Readonly<Record<CatalogFamily, string>> = {
  tools: "catalog",
  prompts: "catalog:prompts",
  resources: "catalog:resources",
  resourceTemplates: "catalog:resourceTemplates",
};

/** The hub-originated list method each catalog is warmed with — not derivable from the
 *  family name, since resource templates ride `resources/templates/list`. */
const LIST_METHOD: Readonly<Record<CatalogFamily, string>> = {
  tools: "tools/list",
  prompts: "prompts/list",
  resources: "resources/list",
  resourceTemplates: "resources/templates/list",
};

/**
 * Which catalogs a declared capability owns — §20.2's vocabulary on one side, §20.5's keys
 * on the other. NOT a table: it is registry's `patternFamilyOf` read forwards, so the fact
 * that `resources` owns TWO (MCP gives resource templates no capability and no
 * list_changed frame of their own, so the resources declaration is the only thing that can
 * ever speak for them) is stated once, where the keyspace lives, instead of restated
 * backwards here. `completions` owns none — it is a method, not a keyspace, and no catalog
 * family answers to it.
 *
 * One rule, three readers: which warms a registration runs, which catalogs a
 * re-registration that no longer declares a family clears, and what a list_changed frame
 * re-lists. Splitting them would let the three disagree about what a family IS.
 */
function catalogsOf(capability: AppCapability): CatalogFamily[] {
  // deps: registry.patternFamilyOf
  return CATALOG_FAMILIES.filter((family) => patternFamilyOf(family) === capability);
}

/**
 * How the DO reads one app-originated notification — the WHOLE read-set (§6, as §21.4
 * amended it), and the two ways a frame in it is read. `invalidates` names the capability
 * whose catalogs the frame re-lists; `routes` names no capability at all, because
 * `notifications/resources/updated` invalidates nothing and re-warms nothing — it is
 * relayed to the subscriber sockets that subscribed its `uri` and to nobody else. Every
 * other frame a registered app sends is still dropped.
 *
 * The distinction is a VALUE rather than two tables because the contracts fixture producer
 * emits this record whole (§4 of the testing strategy): a fifth frame cannot reach the
 * wire without reaching the fixture. The keys are the bell constants from capabilities.ts
 * — the consumer-facing bell and the app-originated notification are the same MCP
 * method, which is exactly why one write can be read as both (§21.3).
 */
export type AppNotification =
  | { reads: "invalidates"; capability: AppCapability }
  | { reads: "routes" };

/** The four app-originated notifications the DO reads, by method (§6/§21.4). */
export const APP_NOTIFICATIONS: Readonly<Record<string, AppNotification>> = {
  [BELL_TOOLS]: { reads: "invalidates", capability: "tools" },
  [BELL_PROMPTS]: { reads: "invalidates", capability: "prompts" },
  [BELL_RESOURCES]: { reads: "invalidates", capability: "resources" },
  [RESOURCES_UPDATED]: { reads: "routes" },
};

/** §6's registration-time capability question, asked of the CLIENT LIBRARY and never of the
 *  author's SDK (§11) — which is why its refusal has to be survivable. */
const DISCOVER_METHOD = "server/discover";

/** The declared capability set, cached beside the catalogs (§20.5) and read by §20.2's
 *  scoped handshake. */
const CAPABILITIES_KEY = "capabilities";

/** What an app the hub has never been told anything about serves: tools — §20.2's
 *  never-connected answer, and exactly what §6's discover fallback warms. Imported rather
 *  than respelled: capabilities.ts owns the value, and two copies of one default is how a
 *  handshake and a warm start disagreeing. */
const DEFAULT_CAPABILITIES = DEFAULT_APP_CAPABILITIES;

/**
 * §21.3's floor state, DURABLE (constraint 5): when each bell last rang, and which bells
 * owe a trailing ring. Prefixed keys rather than one record so the coalescing alarm drains
 * them with a single list — and so `wipe`'s deleteAll takes them with everything else.
 */
const BELL_RANG_PREFIX = "bell:rang:";
const BELL_PENDING_PREFIX = "bell:pending:";

/**
 * The ONE alarm slot's other purpose, as stored state (constraint 2): the instant §6's
 * registration deadline falls due for the socket currently sitting unregistered. Durable
 * because the deadline has to outlive hibernation (an unregistered socket has no pending
 * request to keep the instance awake), and a stored TIMESTAMP rather than a flag because
 * `alarm()` has to be able to tell "this firing is mine" from "this firing belongs to the
 * coalescer and I am not due yet" — which is what keeps §6's ten seconds ten seconds.
 */
const ALARM_DEADLINE_KEY = "alarm:deadline";

/**
 * Closes the app's live socket, if any, with the given code — the two owner-triggered
 * evictions: CLOSE_REVOKED for token revocation / app deletion, CLOSE_ARCHIVED for
 * archival (retry semantics on each constant). `onlyIfTokenId` makes the close
 * conditional on the connection having been opened with that token — token_revoke's
 * "sever only the socket this token opened" rule (§8). A no-op when the app is
 * offline. Never touches cached state: deletion cascades pair it with wipe, and admin
 * owns that ordering.
 */
export async function sever(appId: App["id"], code: SeverCode, onlyIfTokenId?: string): Promise<void> {
  // deps: cloudflare:workers env.APP_CONNECTION · AppConnection.sever
  await connectionFor(appId).sever(code, onlyIfTokenId);
}

/**
 * Erases the DO's durable footprint — everything it persists, which today is the cached
 * catalog — returning
 * the app to its never-connected state, for app-delete and user-delete cascades.
 * Idempotent, and safe against a DO that was never woken. Leaves any live socket alone:
 * callers sever first (admin's cascade closes CLOSE_REVOKED before wiping).
 */
export async function wipe(appId: App["id"]): Promise<void> {
  // deps: cloudflare:workers env.APP_CONNECTION · AppConnection.wipe
  await connectionFor(appId).wipe();
}

/**
 * Worker half of §21.2's SECOND door: opens one subscriber socket into an app's DO and
 * hands back the Worker-side end, already accepted, for the held SSE invocation to pump.
 * A fresh request like handleConnect's, carrying no credential material — the Worker has
 * already resolved the principal and read the grants, and the DO trusts it (§3).
 *
 * Throws when the DO refuses the upgrade or cannot be reached: a stream that cannot open
 * one of its sockets is the caller's decision to make (§21.2 ends the whole stream on any
 * subscriber-socket failure it did not initiate), and inventing a dead socket here would
 * make that decision silently.
 */
export async function openSubscriber(
  appId: App["id"],
  sessionId: string,
  principal: string,
): Promise<WebSocket> {
  // deps: cloudflare:workers env.APP_CONNECTION · AppConnection.fetch
  const response = await connectionFor(appId).fetch(
    new Request("https://pmcp.invalid/subscribe", {
      headers: {
        Upgrade: "websocket",
        [SUBSCRIBER_HEADER.session]: sessionId,
        [SUBSCRIBER_HEADER.principal]: principal,
      },
    }),
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error(`pmcp/subscriber-upgrade refused: ${response.status}`);
  socket.accept();
  return socket;
}

/**
 * What a subscribe did inside the DO, in the three words the door needs (§21.4).
 * `stored` — the URI is on the caller's own live subscriber socket, so forward it;
 * `no_stream` — the session-and-principal pair matched no live subscriber socket, so
 * nothing was stored and the frame is STILL forwarded (a legal MCP request whose
 * notifications are simply undeliverable); `refused` — a cap said no, and the door answers
 * -32602 having stored and forwarded nothing.
 */
export type SubscribeOutcome = "stored" | "no_stream" | "refused";

/**
 * §21.4's subscription mutation as the door reaches it — the DO owns the whole rule (which
 * socket, whose principal, which caps), and the door owns only what a refusal is CALLED on
 * the consumer wire. A DO that cannot be reached is a dispatch failure like any other
 * (-32000 through viaConnection), never a silent no-op that would leave the consumer
 * believing it had subscribed.
 */
export function subscribe(
  appId: App["id"],
  sessionId: string,
  principal: string,
  uri: string,
): Promise<SubscribeOutcome> {
  // deps: viaConnection · AppConnection.subscribe
  return viaConnection(appId, "do_unreachable", (connection) =>
    connection.subscribe(sessionId, principal, uri),
  );
}

/** §21.4's mirror: filter, match, remove, forward. Removing can exceed no cap, so unlike
 *  subscribe it has no refusal to report — the door forwards whatever this answers. */
export function unsubscribe(
  appId: App["id"],
  sessionId: string,
  principal: string,
  uri: string,
): Promise<void> {
  // deps: viaConnection · AppConnection.unsubscribe
  return viaConnection(appId, "do_unreachable", (connection) =>
    connection.unsubscribe(sessionId, principal, uri),
  );
}

/**
 * "online" iff the DO holds a live socket that has completed hub/register — an accepted
 * but not-yet-registered socket reads as offline (the 10 s deadline bounds that window,
 * §6). This is the availability probe the approval gate consults FIRST (a known-offline
 * app is refused -32000 before any approval row is read, created, or consumed, §7)
 * and again between check and claim, so an offline app never consumes an approval —
 * and the status column behind app_list / /apps. Cheap and side-effect-free.
 *
 * A DO this hub cannot reach at all reads "offline" rather than throwing: it is the
 * truthful answer to the question asked (an app whose connection cannot be consulted is
 * certainly not known-online), and it keeps a broken instance from taking out a listing.
 * The refusal it produces at the approval gate is the same -32000 an offline app gets.
 *
 * The POLICY is this function's — swallow to "offline" where the dispatch path throws — but
 * the MECHANISM is viaConnection's, so the seam has one try/catch and one operator log line
 * instead of a near-duplicate in a second grammar. It swallows viaConnection's HubError
 * passthrough too, deliberately: this probe has no consumer to reach, so a refusal the DO
 * already classified has nowhere to go, and "cannot be consulted" is the same answer
 * however the consultation failed. The passthrough exists for the dispatch path, where the
 * refusal IS the consumer's answer.
 */
export async function status(appId: App["id"]): Promise<"online" | "offline"> {
  // deps: viaConnection · AppConnection.status
  return viaConnection(appId, "do_unreachable", (connection) => connection.status()).catch(
    () => "offline" as const,
  );
}

/**
 * The identity a socket carries through hibernation — stored via serializeAttachment
 * at acceptance, updated at registration, read back on every wake (alarm, forward,
 * sever, status). VERSIONED: `v` is bumped whenever this shape changes, and a wake
 * that reads an unknown or absent version treats the socket as unintelligible —
 * close 4004, and the client library's ordinary reconnect brings it back into
 * current code within seconds. That converts deploy version-skew (an old-code
 * attachment woken by new code, should hibernated sockets ever survive a deploy)
 * from silent corruption into a routine self-healing reconnect.
 */
type ConnectionAttachment = {
  v: 1;
  appId: string;
  ownerId: string;
  slug: string;
  /** Which token opened this connection — sever(code, onlyIfTokenId) compares against it. */
  tokenId: string;
  registered: boolean;
};

/**
 * A SUBSCRIBER socket's identity and its subscription set, as they ride
 * serializeAttachment through hibernation (§21.4/§5). Versioned like the app socket's
 * attachment and for the same reason, and never confused with it: the socket's `sub:` tag
 * decides which reader runs, so the two shapes never meet at a read.
 *
 * The set is bounded by LISTEN_SUBSCRIPTIONS_MAX URIs of at most SUBSCRIBE_URI_MAX_BYTES
 * each, whose product is what keeps this attachment far inside the platform's 16 KB (§5).
 */
type SubscriberAttachment = {
  v: 1;
  sessionId: string;
  principal: string;
  uris: string[];
};

/**
 * The per-app Durable Object: at most one accepted socket ever (newest wins at
 * acceptance), the cached tools/list catalog in its own SQLite, in-flight correlation in
 * memory. It trusts the worker half completely — an upgrade only reaches fetch() after
 * handleConnect authenticated the app token, and no other entry point carries
 * credentials at all. It extends DurableObject from `cloudflare:workers` with the
 * WebSocket hibernation API and SQLite storage (new_sqlite_classes); every non-fetch
 * entry point below is an RPC method the worker half calls through the namespace binding.
 */
export class AppConnection extends DurableObject {
  /**
   * Hub-initiated requests awaiting their response frame, keyed by wire id. Each entry
   * remembers the SOCKET it was sent on, so failing a socket fails exactly the calls that
   * socket could still have answered — the alternative makes the at-most-one-socket
   * invariant load-bearing for correctness, and a close arriving after a replacement
   * would fail the newcomer's in-flight calls "offline" (certainly did not execute) for
   * frames already on the wire: the exact at-most-once lie §15 exists to audit.
   *
   * In-memory on purpose: an unresolved inbound consumer request blocks hibernation, so
   * this map can only vanish when it is already empty or the DO is forcibly restarted —
   * and a forced restart fails the call to a caller who retries (§6). Every entry is armed
   * with the 30 s timeout; webSocketClose/Error drain that socket's share immediately.
   *
   * `method` is what was ASKED, kept because this map is the only durable-enough place to
   * ask "is a re-warm already in flight on this socket" (rewarm) — a field would be lost at
   * the first hibernation, and an entry here cannot be, since an unresolved inbound request
   * blocks hibernation.
   */
  private pending = new Map<
    string,
    { ws: WebSocket; method: string; resolve: (outcome: ForwardResult) => void }
  >();

  /**
   * The upgrade receiver — the only traffic that enters as HTTP, and only from
   * handleConnect. Evicts any current socket first (hub/replaced notification, then
   * close 4000) at *acceptance*, before the newcomer registers, so there is never a
   * two-socket window — and writes the connect.replaced audit row, because with a stolen
   * token eviction-and-impersonation looks exactly like this. Accepts the new socket
   * into the hibernation API with the versioned ConnectionAttachment (not-yet-registered)
   * attached via serializeAttachment, and arms the registration deadline
   * (limits.REGISTRATION_DEADLINE_MS). Anything that is not a WebSocket upgrade, or that
   * does not carry the four identity headers, is rejected — the only door is
   * handleConnect, which always writes all four.
   */
  async fetch(req: Request): Promise<Response> {
    // deps: DO ctx.acceptWebSocket · DO ws.serializeAttachment · DO ctx.storage.setAlarm · audit.record · audit.resolveAuditConfig
    if (!isUpgrade(req)) return refuse(426, "Upgrade Required");
    // §21.2's second door, tried first because it is the narrower one: a subscriber
    // upgrade carries the two subscriber headers and none of the four identity headers.
    const subscriber = subscriberFrom(req);
    if (subscriber !== null) return this.acceptSubscriber(subscriber);
    const arriving = identityFrom(req);
    // One refusal for "this did not come from handleConnect", whichever way it failed to.
    if (arriving === null) return refuse(426, "Upgrade Required");
    // Newest wins BEFORE the newcomer is accepted, so the two-socket window never exists.
    await this.evictCurrent(arriving);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [arriving.appId]);
    pair[1].serializeAttachment(arriving);
    // A storage alarm, not a timer: an unregistered socket has no pending request to keep
    // this instance awake, so the deadline has to outlive hibernation (§6). Its PURPOSE is
    // stored beside it (constraint 2), because one slot cannot remember two intentions and
    // the handler must not spend this deadline early on the coalescer's firing. Armed
    // through the multiplexer, which never pushes a pending ring out behind it (§21.3).
    const dueAt = Date.now() + REGISTRATION_DEADLINE_MS;
    await this.ctx.storage.put(ALARM_DEADLINE_KEY, dueAt);
    await this.armAlarm(dueAt);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * §21.2's subscriber accept: a socket of the OTHER class — tagged `sub:<session-id>` so
   * that no app-socket reader can ever return it, carrying the Worker's resolved
   * principal and an empty subscription set. It evicts nothing (§6's at-most-one invariant
   * counts app sockets), writes no audit row (§21.6, doorbells are listing-class), and
   * — the pin — arms NO registration deadline: a subscriber never registers, and a stream
   * that opened before its app reconnects must not be killed by the bot's clock.
   */
  private acceptSubscriber(attachment: SubscriberAttachment): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [subscriberTag(attachment.sessionId)]);
    pair[1].serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * §6's replacement, at acceptance: the sitting socket is told `hub/replaced`, closed
   * 4000, and the event is written to the ledger — with a stolen app token,
   * eviction-and-impersonation looks exactly like this, so the row is the signal.
   */
  private async evictCurrent(arriving: ConnectionAttachment): Promise<void> {
    const current = this.socket();
    if (current === null) return;
    this.send(current.ws, { jsonrpc: "2.0", method: HUB_METHODS.replaced });
    this.drop(current.ws, CLOSE_REPLACED, "replaced by a newer connection");
    await this.audit(current.attachment ?? arriving, "connect.replaced", {
      // Token IDs, never token material (§15) — which credential opened each socket is
      // exactly what an owner reads this row for.
      replacedTokenId: current.attachment?.tokenId,
      tokenId: arriving.tokenId,
    });
  }

  /**
   * One JSON-RPC message per WS text frame, routed by namespace. hub/register: the
   * declaration is handed to registry.upsertDeclaredRoles (which owns validation and
   * drift auditing); a rejected declaration gets a JSON-RPC error reply and close 4004,
   * a vanished app row closes 4003, success replies {ok:true}, writes the
   * connect.register audit row, and immediately runs the §6 capability warm — one
   * server/discover, then the catalogs its answer declared.
   * After registration: correlation replies resolve the pending map, and each frame of the
   * DO's read-set (APP_NOTIFICATIONS) is read the one way that record says — §6's
   * three list_changed invalidate their own family's catalogs and re-list, §21.4's
   * `resources/updated` is routed by `uri` and invalidates nothing.
   * When the warmed catalog lands, each tool's input/output schemas run
   * registry.validateSchemaIndirection: violations are LOUD — echoed to the app
   * as a warning frame and logged — and the tool is cached flagged schema-unsound,
   * which makes sensitivePaths answer null for it (§7's -32001 / no-body handling);
   * the registration itself still succeeds, so one exotic tool never bricks the
   * app. Any
   * pre-registration message other than hub/register is a protocol error — error reply,
   * then close 4004. The hub never forwards consumer traffic to an unregistered socket.
   *
   * Nothing a SUBSCRIBER socket sends is read at all (§21.2): the hub writes on those
   * sockets and listens on none of them, so a consumer that talks back can neither warm a
   * catalog nor ring a bell.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // deps: registry.upsertDeclaredRoles · registry.validateSchemaIndirection · audit.record · audit.resolveAuditConfig · DO SQLite `catalog` · DO ws.serializeAttachment
    // The class question, asked FIRST and by tag — never by position (§21.2).
    if (this.sessionOf(ws) !== null) return;
    const attachment = attachmentOf(ws);
    // §10: an attachment this code cannot read is a socket it cannot serve. Closing it
    // turns deploy version-skew into the client's ordinary reconnect.
    if (attachment === null) return this.drop(ws, CLOSE_PROTOCOL, "unintelligible connection");
    const frame = parseFrame(message);
    if (!attachment.registered) return this.register(ws, attachment, frame);
    if (frame === null) return;
    // A correlated answer to something this hub asked (a forwarded call, a catalog warm).
    if (frame.method === undefined) return this.settle(frame);
    const notification = APP_NOTIFICATIONS[String(frame.method)];
    // Anything else from a registered app is a frame the hub does not read (§6: every
    // MCP request on this socket is hub-originated). Ignored, never a close: the protocol
    // error is a PRE-registration rule.
    if (notification === undefined) return;
    // §21.4's per-URI relay: routing only, so no catalog is invalidated and no re-warm runs.
    if (notification.reads === "routes") return this.route(frame);
    // §6's three: that family's set changed, so re-list ITS catalogs and no others — and
    // ring its bell if the re-list changed what the hub stores (§21.3).
    return this.warmFamily(ws, attachment, notification.capability);
  }

  /**
   * §6's one pre-traffic obligation, and the only frame an unregistered socket may send.
   * The declaration's rules are registry's (validateRoles); what a violation COSTS is
   * this module's: an error reply, then 4004.
   */
  private async register(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    frame: Frame | null,
  ): Promise<void> {
    const id = idOf(frame);
    if (frame === null || frame.method !== HUB_METHODS.register) {
      this.send(ws, errorFrame(id, CODES.invalidRequest, "hub/register expected first"));
      return this.drop(ws, CLOSE_PROTOCOL, "protocol error");
    }
    // The payload carries no app field, and this is where that is true: identity comes
    // from `attachment`, which the worker half built from the token alone (§6).
    const roles = declarationOf(frame);
    const violations = roles === null ? ["roles must be an object of pattern lists"] : validateRoles(roles);
    if (roles === null || violations.length > 0) {
      this.send(ws, errorFrame(id, CODES.invalidParams, `invalid declaration: ${violations.join("; ")}`));
      return this.drop(ws, CLOSE_PROTOCOL, "invalid declaration");
    }
    const registry = new Registry(env.DB);
    let drift;
    try {
      drift = await registry.upsertDeclaredRoles(attachment.appId, roles);
    } catch (err) {
      // WHICH refusal, asked rather than assumed. §6's reconnect race is the one this
      // socket answers 4003 to — told apart from a violation by carrying no reply at all.
      // Everything else registry or D1 can fail with is a hub defect or somebody's
      // downtime, and disguising either as "your app row is gone, reconnect" would
      // send an operator to look at a healthy row and leave no trace of the real fault.
      if ((await registry.appById(attachment.appId)) !== null) throw err;
      return this.drop(ws, CLOSE_ROW_GONE, "app row is gone");
    }
    attachment.registered = true;
    ws.serializeAttachment(attachment);
    // The deadline's purpose is SPENT: this socket registered, so a later firing of the
    // shared slot has no deadline leg to run (constraint 2 — the handler dispatches on the
    // stored purpose, and a purpose nobody owns must not linger).
    await this.ctx.storage.delete(ALARM_DEADLINE_KEY);
    this.send(ws, { jsonrpc: "2.0", id, result: { ok: true } });
    await this.audit(attachment, "connect.register", { roles: Object.keys(roles) });
    if (drift.widened.length > 0) {
      await this.audit(attachment, "connect.roles_widened", { widened: drift.widened });
    }
    await this.warmDeclared(ws, attachment);
  }

  /**
   * §6's registration tail, and the one place §20.5 lets a cache be emptied. ONE
   * hub-originated `server/discover` — always first, since its answer decides everything
   * after it — then the warms for the families it declared, concurrent with each other. The
   * tail is therefore worst-case TWO correlation budgets wide, never four.
   *
   * The FALLBACK is the load-bearing half (§6): a `-32601` from a library that predates the
   * method, any other error, and a correlation timeout all mean "capabilities unknown", and
   * the hub then warms TOOLS ONLY and touches no other key — no catalog is emptied and the
   * stored capability set stands, so an app already in the field keeps the tool list it
   * has always had and its handshake keeps advertising what it last declared. Warming blind
   * instead would make every tools-only app log three spurious warm failures.
   *
   * A SUCCESSFUL answer replaces the stored set — never accumulates, or a family an app
   * has stopped serving would be advertised forever — and CLEARS the catalogs of every
   * family it omits: an omission in an answer is the app saying it no longer serves that
   * family, which is the one case §20.5 distinguishes from a failure. Cleared to `[]`, the
   * genuinely-empty answer, rather than to absent, which would re-warm on the next demand a
   * family the app just undeclared.
   */
  private async warmDeclared(ws: WebSocket, attachment: ConnectionAttachment): Promise<void> {
    const declared = await this.discover(ws);
    if (declared === null) return this.warmAndRing(ws, attachment, ["tools"]);
    await this.ctx.storage.put(CAPABILITIES_KEY, declared);
    const warming = new Set(declared.flatMap(catalogsOf));
    const changed = await Promise.all(
      CATALOG_FAMILIES.map((family) =>
        warming.has(family)
          ? this.warmCatalog(ws, attachment, family)
          : this.writeCatalog(family, []),
      ),
    );
    // §21.3: the clear that emptied a NON-empty catalog is a change like any other, and
    // rings — one bell per family this registration actually moved, whichever leg moved it.
    await this.ringChanged(CATALOG_FAMILIES.filter((_, index) => changed[index] === true));
  }

  /**
   * §6's capability question, asked once per registration: which families does this app
   * serve? Answered by the CLIENT LIBRARY rather than the author's SDK (§11), so every
   * answer this hub cannot read is a library that predates the method — null, meaning
   * "unknown", which is a different fact from an answer that declared nothing.
   */
  private async discover(ws: WebSocket): Promise<AppCapability[] | null> {
    const outcome = await this.request(ws, {
      jsonrpc: "2.0",
      method: DISCOVER_METHOD,
      params: { _meta: withProtocolFields() },
    });
    return outcome.ok ? declaredOf(outcome.response) : null;
  }

  /** One capability's catalogs, re-listed together — the `resources` declaration speaks for
   *  resource templates too, which have no list_changed frame of their own (§20.5). */
  private async warmFamily(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    capability: AppCapability,
  ): Promise<void> {
    await this.warmAndRing(ws, attachment, catalogsOf(capability));
  }

  /**
   * A set of catalogs warmed together, and the bells that warm owes (§21.3). ONE ring per
   * bell however many keys moved: both resource catalogs answer to
   * `notifications/resources/list_changed`, so a re-list that changed the resource list and
   * the templates list is one frame — MCP defines no templates frame, the same
   * one-frame-covers-both rule §6 pins for the invalidation.
   */
  private async warmAndRing(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    families: readonly CatalogFamily[],
  ): Promise<void> {
    const changed = await Promise.all(
      families.map((family) => this.warmCatalog(ws, attachment, family)),
    );
    await this.ringChanged(families.filter((_, index) => changed[index] === true));
  }

  /** The distinct bells a set of changed families owes, rung once each (§21.3/§6). A family
   *  with no bell — there is none for completions — owes nothing. */
  private async ringChanged(families: readonly CatalogFamily[]): Promise<void> {
    const bells = new Set(
      families.map((family) => familyBell(family)).filter((bell): bell is string => bell !== null),
    );
    for (const bell of bells) await this.ring(bell);
  }

  /**
   * One catalog's warm: a hub-originated list for that family, and — on the tool catalog —
   * the §7 indirection refuse-line applied LOUDLY to what comes back, so one exotic schema
   * names itself to the app and the operator while the registration still stands. A
   * warm that draws no catalog — unanswered, or answered with something that is not a list
   * — leaves the previous cache in place (a stale catalog serves better than an empty one,
   * §6 lifecycle 2; a failure is never an undeclare, §20.5) and is LOGGED: for a family that
   * never warmed the key stays ABSENT, which reads as never-warmed and re-lists on the next
   * demand, since an online app serving no catalog is not a state to sit in.
   */
  private async warmCatalog(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    family: CatalogFamily,
  ): Promise<boolean> {
    // Parking here is safe, and the reason is not local: the answer arrives as a SEPARATE
    // webSocketMessage invocation on this same object while this handler is still awaiting.
    // A Durable Object's input gate does not hold back websocket events behind a handler
    // awaiting a non-storage promise, so the successor that resolves this request can run —
    // which is why hub/register can await its own catalog warm without deadlocking for
    // CALL_TIMEOUT_MS. Self-contained, like every hub-originated request (§6).
    const outcome = await this.request(ws, {
      jsonrpc: "2.0",
      method: LIST_METHOD[family],
      params: { _meta: withProtocolFields() },
    });
    const entries = outcome.ok ? catalogOf(outcome.response, family) : null;
    if (entries === null) {
      // §15 hygiene: the slug so an operator can find the app, the family so they know
      // which list, and the failure class — never the answer's body. Loud because nothing
      // else about this state is: the registration succeeded and the app reads online.
      console.warn(
        `pmcp/catalog-warm-failed: ${attachment.slug} ${family}: ${outcome.ok ? "answer was not a catalog" : outcome.reason}`,
      );
      // §20.5/§21.3: a failure is not an undeclare. Nothing was written, so nothing rings.
      return false;
    }
    const changed = await this.writeCatalog(family, entries);
    // §7's refuse-line reads inputSchema and outputSchema, which only a tool has.
    if (family === "tools") this.reportUnsound(ws, attachment, entries as Tool[]);
    return changed;
  }

  /**
   * One catalog written, with §21.3's ring verdict taken BEFORE the write: the bell is
   * about the hub's STORED catalog changing, so the comparison is the old value against the
   * new one, canonically — and absent compares EQUAL to `[]`, so a first registration
   * writing empty family keys rings nothing while the undeclare that emptied a served
   * family rings.
   *
   * Answers whether it changed rather than ringing itself: one warm owes one bell per
   * FAMILY, and the resources declaration writes two keys.
   */
  private async writeCatalog(family: CatalogFamily, entries: readonly unknown[]): Promise<boolean> {
    const stored = await this.ctx.storage.get(CATALOG_KEY[family]);
    const changed = catalogChanged(stored, entries);
    await this.ctx.storage.put(CATALOG_KEY[family], entries);
    return changed;
  }

  /**
   * §21.3's doorbell, with its leading-edge floor. The first ring of a bell in a quiet
   * window goes out immediately; one inside LISTEN_BELL_MIN_INTERVAL_MS of it is suppressed
   * and remembered as PENDING, and the alarm delivers exactly one trailing frame for it —
   * so a burst is at most two frames and the final state always rings.
   *
   * Both halves of the floor — the per-bell last-rang stamp and the pending flag — live in
   * DO storage rather than in instance memory (constraint 5): a burst that straddles a
   * hibernation must not lose its trailing ring, and an evicted instance has no fields.
   */
  private async ring(bell: string): Promise<void> {
    const now = Date.now();
    const last = (await this.ctx.storage.get<number>(BELL_RANG_PREFIX + bell)) ?? 0;
    if (now - last >= LISTEN_BELL_MIN_INTERVAL_MS) {
      await this.ctx.storage.put(BELL_RANG_PREFIX + bell, now);
      this.fanout(bellFrame(bell));
      return;
    }
    await this.ctx.storage.put(BELL_PENDING_PREFIX + bell, true);
    await this.armAlarm(last + LISTEN_BELL_MIN_INTERVAL_MS);
  }

  /**
   * The coalescing leg of the alarm: every pending ring fires, UNCONDITIONALLY — no clock
   * re-check. That is what guarantees §21.3's "the final state always rings" when the alarm
   * runs late, and it is what makes the alarm a lever a suite can pull instead of a
   * duration a suite must wait out. Answers whether it rang anything, which is how `alarm`
   * tells its own firing apart from the deadline's (below).
   */
  private async flushBells(): Promise<boolean> {
    const pending = await this.ctx.storage.list<boolean>({ prefix: BELL_PENDING_PREFIX });
    const now = Date.now();
    for (const key of pending.keys()) {
      const bell = key.slice(BELL_PENDING_PREFIX.length);
      await this.ctx.storage.delete(key);
      await this.ctx.storage.put(BELL_RANG_PREFIX + bell, now);
      this.fanout(bellFrame(bell));
    }
    return pending.size > 0;
  }

  /**
   * The DO's ONE alarm slot, armed for the EARLIER of its two purposes (§21.3's
   * multiplexing): a registration deadline arriving while a ring is pending must not push
   * that ring ten seconds out, so neither purpose ever overwrites a sooner alarm.
   *
   * Sharing the slot this way is only safe because the purposes are stored SEPARATELY
   * (`bell:pending:*` and ALARM_DEADLINE_KEY) and `alarm()` dispatches on them: the earlier
   * purpose consumes the slot, runs, and re-arms whatever it borrowed the slot from. Firing
   * both legs on every firing instead would let a coalescing ring one second away spend
   * §6's ten-second deadline nine seconds early, closing a socket that was still inside its
   * handshake window.
   */
  private async armAlarm(at: number): Promise<void> {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || at < scheduled) await this.ctx.storage.setAlarm(at);
  }

  /** The LOUD half of §7's indirection refuse-line: every unsound tool named to the app
   *  in a warning frame and to the operator in a log line. The registration still stands. */
  private reportUnsound(ws: WebSocket, attachment: ConnectionAttachment, tools: Tool[]): void {
    for (const tool of tools) {
      const violations = schemaViolations(tool);
      if (violations.length === 0) continue;
      console.warn(`pmcp/schema-unsound: ${attachment.slug}.${tool.name}: ${violations.join("; ")}`);
      this.send(ws, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "warning",
          logger: "pmcp/schema",
          data: { tool: tool.name, violations },
        },
      });
    }
  }

  /**
   * Fails the correlation entries THIS socket was carrying — in-flight consumers get
   * -32000 and retry — and lets it go. Scoped to `ws` because a replaced socket's close
   * lands after its successor is already accepted and possibly mid-call: those entries
   * belong to the newcomer and no answer to them was lost. Reconnection is entirely the
   * client library's job; the DO never dials out (outbound sockets block hibernation, §3).
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // deps: none
    this.drain(ws);
  }

  /**
   * A transport error is a disconnect: same drain-this-socket's-waiters treatment as
   * webSocketClose, nothing more.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // deps: none
    this.drain(ws);
  }

  /**
   * The DO's one alarm, serving two purposes — and DISPATCHING on stored state rather than
   * running both legs blind (constraint 2), because one slot cannot remember two intentions
   * and the purposes do not fall due together.
   *
   * The COALESCING leg is §21.3's, and it runs first and unconditionally: whatever rings are
   * pending fire, with no clock re-check, which is what makes `runDurableObjectAlarm` a
   * lever rather than a duration to wait out.
   *
   * The DEADLINE leg is §6's. It runs when its stored instant is due — or when no ring was
   * pending at all, which means this firing was armed by the deadline itself and is the
   * case every suite pulls the lever for. It does NOT run on a firing the coalescer owns
   * while the deadline is still in the future: §6 pins that window at ten seconds, and
   * spending it on somebody else's alarm would close a socket mid-handshake. Borrowed slot
   * returned: the deadline re-arms itself for its own instant.
   *
   * A socket accept cancels neither purpose, and a subscriber accept arms neither.
   */
  async alarm(): Promise<void> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment · DO ctx.storage `bell:*` · DO ctx.storage `alarm:deadline`
    const dueAt = await this.ctx.storage.get<number>(ALARM_DEADLINE_KEY);
    const rang = await this.flushBells();
    if (dueAt === undefined) return;
    if (rang && Date.now() < dueAt) return this.armAlarm(dueAt);
    await this.ctx.storage.delete(ALARM_DEADLINE_KEY);
    const current = this.socket();
    // An unintelligible attachment is treated exactly like a missed deadline: the socket
    // cannot be served, and the client's reconnect is the cure (§10).
    if (current !== null && current.attachment?.registered !== true) {
      this.drop(current.ws, CLOSE_PROTOCOL, "registration deadline");
    }
  }

  /**
   * The cached catalog, verbatim as last received from the app — names,
   * descriptions, inputSchema and outputSchema (the schemas are what sensitivePaths
   * walks, both directions §7; serving-time `writeOnly` stripping on outputSchemas
   * is the gateway's job, never done here — the cache stays the verbatim oracle).
   * Empty for a
   * app that has never completed a registration. ALWAYS answers from storage and never
   * waits on the socket — but it does fire the re-warm below when the cache is absent while
   * a registered socket is live, which is the only way out of a failed first warm.
   */
  async listTools(): Promise<Tool[]> {
    // deps: DO ctx.storage `catalog` · warmCatalog
    return this.cached<Tool>("tools");
  }

  /**
   * The same contract for §20.5's other three catalogs — prompts, resources and resource
   * templates, each under its own key. Their entries are whatever the app listed, kept
   * VERBATIM: the hub reads only the key §20.2 matches the family on (and does that at the
   * door), so what an entry is called here is the caller's to say.
   *
   * Empty both for an app that never declared the family and for one that just stopped
   * declaring it — §20.5's clear stores `[]`, so an undeclared family answers empty instead
   * of re-warming forever against an app that no longer serves it.
   */
  async listCatalog<T>(family: CatalogFamily): Promise<T[]> {
    // deps: DO ctx.storage `catalog:*` · warmCatalog
    return this.cached<T>(family);
  }

  /**
   * One catalog, read whole from its durable key, with §20.5's absent-versus-empty rule
   * applied once for all four families: ABSENT means never-warmed, so re-warm on demand;
   * a stored `[]` is a genuinely empty set and is never re-asked.
   */
  private async cached<T>(family: CatalogFamily): Promise<T[]> {
    // ponytail: ONE durable key per family holding the whole catalog, absent until a warm
    // lands one — which is exactly the never-connected answer, with no table and no
    // migration to own; a SQLite-backed class stores it in SQLite either way. Each is
    // written whole and read whole, and the schema-unsound flag §7 needs is DERIVED from
    // the cached schemas at read time (sensitivePaths) rather than stored beside them.
    // Upgrade path, if a catalog ever grows past what one value should carry: rows keyed by
    // the family's subject key, with this method's contract unchanged.
    const cached = await this.ctx.storage.get<T[]>(CATALOG_KEY[family]);
    if (cached === undefined) this.rewarm(family);
    return cached ?? [];
  }

  /**
   * The capability set §20.2's scoped handshake advertises: what the last SUCCESSFUL
   * `server/discover` declared, durable beside the catalogs so a disconnect never narrows
   * it. Absent — never connected, or never a discover this hub could read — is `tools`,
   * because a capability the hub has never been told about is not declared (§20.2).
   */
  async capabilities(): Promise<AppCapability[]> {
    // deps: DO ctx.storage `capabilities`
    const declared = await this.ctx.storage.get<AppCapability[]>(CAPABILITIES_KEY);
    return declared ?? [...DEFAULT_CAPABILITIES];
  }

  /**
   * The recovery from a warm that never landed: an ABSENT key under a live registered
   * socket means this connection has never produced a catalog, so ask again — on demand,
   * because demand is the only thing that makes the answer worth anything. An app with a
   * genuinely empty tool set is not this: a warm that landed stored `[]`, which is present.
   *
   * Derived from the cache rather than remembered in a field, for the same reason the
   * schema-unsound flag is: an in-memory mark is lost at the first hibernation, which is
   * precisely when a wedged app would sit longest. Fired and not awaited — a tools/list
   * read must never wait out CALL_TIMEOUT_MS on an app that cannot answer — so the
   * demand that finds the gap serves the empty catalog and the one after it is served the
   * warm one; a rejection is swallowed for the same reason warmCatalog's failure is
   * survivable, and the next demand simply asks again.
   *
   * ONE at a time PER FAMILY, and that bound is the point: this runs on DEMAND, and the
   * demand is tools/call's (sensitivePaths reads the same cache), so a wedged app that
   * never answers would otherwise draw one hub-originated list per consumer call — each
   * parking a waiter for CALL_TIMEOUT_MS, and each keeping the instance awake, unbounded in
   * exactly the state this recovery was written for. The guard is READ OFF `pending` rather
   * than kept in a field of its own, which is the same no-in-memory-marks rule as above and
   * costs nothing here: a pending request cannot be hibernated away, so the map is as
   * durable as the in-flight request it is answering about.
   */
  private rewarm(family: CatalogFamily): void {
    const ws = this.live();
    // Offline: nothing to ask, and the reconnect's own hub/register warms it (§6).
    if (ws === null) return;
    const attachment = attachmentOf(ws);
    if (attachment === null) return;
    // Every list this DO originates is a warm — the gateway serves every family's listing
    // from these caches and forward() carries fetches (tools/call, prompts/get,
    // resources/read) — so one on this socket IS a warm of that family still in flight.
    for (const waiter of this.pending.values()) {
      if (waiter.ws === ws && waiter.method === LIST_METHOD[family]) return;
    }
    void this.warmAndRing(ws, attachment, [family]).catch(() => undefined);
  }

  /**
   * Sends one already-stamped frame to the live registered socket and resolves with the
   * correlated outcome. The wire id is a fresh UUID owned by this DO — the consumer's
   * JSON-RPC id never crosses the socket, and the returned response still bears the wire
   * id (re-addressing is the gateway's job). No live registered socket resolves
   * { ok: false, reason: "offline" } without sending; no answer within 30 s resolves
   * { ok: false, reason: "timeout" } and the late reply, if any, is dropped.
   */
  async forward(msg: JsonRpcRequest): Promise<ForwardResult> {
    // deps: crypto.randomUUID · DO ctx.getWebSockets · DO ws.deserializeAttachment
    const ws = this.live();
    // Nothing is sent and nothing is queued: the hub has no outbox (§15).
    if (ws === null) return { ok: false, reason: "offline" };
    return this.request(ws, msg);
  }

  /**
   * One hub-originated request over `ws`, correlated on a fresh wire id — the consumer's
   * own JSON-RPC id never crosses the socket. The 30 s budget is armed here rather than at
   * the call sites so every hub-originated request has exactly one; a late answer finds no
   * entry and is dropped.
   */
  private request(ws: WebSocket, msg: Omit<JsonRpcRequest, "id">): Promise<ForwardResult> {
    const id = crypto.randomUUID();
    return new Promise<ForwardResult>((resolve) => {
      // ONE ambient setTimeout at exactly CALL_TIMEOUT_MS — the module header publishes
      // this as the deadline's seam, because a suite shrinks it to observe §15's budget.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "timeout" });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        ws,
        method: msg.method,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(outcome);
        },
      });
      try {
        ws.send(JSON.stringify({ ...msg, id }));
      } catch {
        // The socket died between the liveness read and the send: the call never left, so
        // it certainly did not execute.
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, reason: "offline" });
      }
    });
  }

  /** A correlated answer: resolve its waiter, or drop it (a reply past the 30 s budget). */
  private settle(frame: Frame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    const answer = answerOf(frame);
    // A frame that is not a JSON-RPC response is not an answer. Resolving it `ok` would
    // hand the gateway something whose `error === undefined` reads as outcome "ok" and
    // relay a memberless response to the consumer. The call DID reach the app, so the
    // reason is the may-have-executed one — "timeout" is this type's word for exactly that.
    waiter.resolve(answer === null ? { ok: false, reason: "timeout" } : { ok: true, response: answer });
  }

  /**
   * Every waiter this socket was carrying fails at once — it is gone, so no answer to
   * those correlations can ever arrive. Waiters on any other socket are untouched.
   *
   * `disconnected`, never `offline`: every entry in this map is a frame that was already
   * SENT (request() registers it and sends in the same synchronous step, and a send that
   * threw removes it again), so each of these calls may already have executed at the
   * app. Reporting them as the certainly-did-not-execute reason is the exact
   * at-most-once lie §15 exists to audit — and the consumer, told nothing left, retries.
   */
  private drain(ws: WebSocket): void {
    for (const [id, waiter] of [...this.pending]) {
      if (waiter.ws !== ws) continue;
      this.pending.delete(id);
      waiter.resolve({ ok: false, reason: "disconnected" });
    }
  }

  /**
   * The DO's one socket, or null. §6's at-most-one invariant is maintained in a single
   * place — fetch(), which evicts before it accepts — and read in a single place here, so
   * no method below has to re-derive it or loop "just in case". `attachment` is null when
   * the identity cannot be read (§10's version-skew branch).
   */
  private socket(): { ws: WebSocket; attachment: ConnectionAttachment | null } | null {
    // By CLASS, never by position (§21.2, constraint 1). Spelled as the COMPLEMENT — the
    // socket carrying no `sub:` tag — rather than as a positive `getWebSockets(appId)`
    // lookup, and deliberately: this DO learns its own app id from an attachment, which
    // is exactly what a version-skewed or unintelligible attachment denies it (§10), and the
    // one socket that must still be findable then is this one. The prefix is what makes the
    // complement exact — app ids are themselves UUIDs, so no id can carry it, and a
    // `getWebSockets(app.id)` lookup can never return a subscriber socket either.
    for (const ws of this.ctx.getWebSockets()) {
      if (this.sessionOf(ws) === null) return { ws, attachment: attachmentOf(ws) };
    }
    return null;
  }

  /** The session id a socket's `sub:` tag carries, or null for the app socket — the one
   *  place the class question is asked, so no reader can answer it differently. */
  private sessionOf(ws: WebSocket): string | null {
    for (const tag of this.ctx.getTags(ws)) {
      const sessionId = parseSubscriberTag(tag);
      if (sessionId !== null) return sessionId;
    }
    return null;
  }

  /** One frame to every subscriber socket this DO holds, enumerated by TAG over
   *  getWebSockets() and never from an in-memory list (constraint 6): an evicted instance
   *  keeps no list, and a DO that went deaf after a hibernation is exactly the failure
   *  §21.2 refuses. The DO knows no endpoint shapes — the filter is the Worker's. */
  private fanout(frame: Record<string, unknown>): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.sessionOf(ws) !== null) this.send(ws, frame);
    }
  }

  /**
   * §21.4's per-URI relay: `notifications/resources/updated` reaches exactly the subscriber
   * sockets whose stored set CONTAINS the frame's uri, by exact string match — the hub
   * normalizes nothing here, so a trailing slash, a case difference or an added query
   * component is a different resource and matches nobody. Grant filtering already happened
   * at subscribe time, which is what makes a rogue frame inert rather than dangerous.
   *
   * Relayed VERBATIM, uri intact: the hub forwards the app's frame, it does not compose
   * one of its own.
   */
  private route(frame: Frame): void {
    const params = frame.params;
    const uri = isPlainObject(params) ? params.uri : undefined;
    if (typeof uri !== "string") return;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.sessionOf(ws) === null) continue;
      const attachment = subscriberAttachmentOf(ws);
      if (attachment !== null && attachment.uris.includes(uri)) this.send(ws, frame);
    }
  }

  /**
   * §21.4's subscription mutation, DO side. The session id SELECTS the socket — a direct
   * `getWebSockets("sub:<id>")` lookup, the tag being the index — and the socket's stored
   * principal AUTHORIZES the mutation: the same session id presented by another principal
   * matches a socket and changes nothing, which is the check §21.1's "a guessed session id
   * steals nothing" rests on.
   *
   * The caps are capabilities.subscribeAllowed's, so the off-by-one lives in one place. Two
   * consequences fall out of asking it exactly once: a URI already in the set is a no-op
   * that cannot exceed the count cap (the set is a SET, and re-subscribing must not double
   * anything), and a subscribe with no live socket is measured against an EMPTY set, so only
   * the byte cap — a property of the request, not of the socket — can refuse it.
   */
  async subscribe(sessionId: string, principal: string, uri: string): Promise<SubscribeOutcome> {
    // deps: DO ctx.getWebSockets(tag) · DO ws.serializeAttachment · capabilities.subscribeAllowed
    const found = this.subscriberFor(sessionId, principal);
    const stored = found === null ? [] : found.attachment.uris;
    if (stored.includes(uri)) return "stored";
    if (!subscribeAllowed(stored.length, uri)) return "refused";
    if (found === null) return "no_stream";
    found.ws.serializeAttachment({ ...found.attachment, uris: [...stored, uri] });
    return "stored";
  }

  /** §21.4's mirror, under the same select-then-authorize rule: a URI that is not in the
   *  set (or a socket that is not the caller's) leaves the attachment exactly as it was. */
  async unsubscribe(sessionId: string, principal: string, uri: string): Promise<void> {
    // deps: DO ctx.getWebSockets(tag) · DO ws.serializeAttachment
    const found = this.subscriberFor(sessionId, principal);
    if (found === null || !found.attachment.uris.includes(uri)) return;
    const uris = found.attachment.uris.filter((stored) => stored !== uri);
    found.ws.serializeAttachment({ ...found.attachment, uris });
  }

  /** The caller's own subscriber socket for one session id, or null — the id selects, the
   *  principal authorizes (§21.4), and both halves are asked in this one place. */
  private subscriberFor(
    sessionId: string,
    principal: string,
  ): { ws: WebSocket; attachment: SubscriberAttachment } | null {
    for (const ws of this.ctx.getWebSockets(subscriberTag(sessionId))) {
      const attachment = subscriberAttachmentOf(ws);
      if (attachment !== null && attachment.principal === principal) return { ws, attachment };
    }
    return null;
  }

  /** The live REGISTERED socket, or null — §6's whole definition of "online". */
  private live(): WebSocket | null {
    const current = this.socket();
    return current?.attachment?.registered === true ? current.ws : null;
  }

  /** Closes one socket and fails everything that was waiting on IT. Never throws: a socket
   *  that is already gone is the outcome this asks for. */
  private drop(ws: WebSocket, code: number, reason: string): void {
    this.drain(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  /** One frame out, best-effort: a send onto a dying socket is not a failure of whatever
   *  the hub was doing when it tried. */
  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // already closed
    }
  }

  /** One audit row for a connection event, in the namespace the connection belongs to. */
  private async audit(
    attachment: ConnectionAttachment,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await record(env.DB, {
      ownerId: attachment.ownerId,
      principal: `app:${attachment.slug}`,
      event,
      app: attachment.slug,
      outcome: "ok",
      detail,
    });
  }

  /** DO half of the module-level sever(), whose comment is this operation's contract. */
  async sever(code: SeverCode, onlyIfTokenId?: string): Promise<void> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    const current = this.socket();
    if (current === null) return;
    // §8's rotation rule: a revoke names ONE token, and a socket opened with the other
    // one must survive it. An attachment that cannot be read names no token either.
    if (onlyIfTokenId !== undefined && current.attachment?.tokenId !== onlyIfTokenId) return;
    this.drop(current.ws, code, "severed");
  }

  /** DO half of the module-level wipe(), whose comment is this operation's contract. */
  async wipe(): Promise<void> {
    // deps: DO ctx.storage `catalog` · DO ctx.getWebSockets
    // Everything this DO persists is durable storage, so the whole store IS the footprint
    // — and deleting all of it is idempotent on a DO that never woke.
    await this.ctx.storage.deleteAll();
    // §21.2: app DELETE closes the subscriber sockets too — a stream listening to a
    // app that no longer exists must end loudly rather than go quietly deaf, and the
    // consumer's reopen rebuilds the fan-out against current state. Archive and token
    // revocation never come through here: they sever the app socket alone.
    for (const ws of this.ctx.getWebSockets()) {
      if (this.sessionOf(ws) !== null) this.drop(ws, CLOSE_REVOKED, "app deleted");
    }
  }

  /** DO half of the module-level status(), whose comment is this operation's contract. */
  async status(): Promise<"online" | "offline"> {
    // deps: DO ctx.getWebSockets · DO ws.deserializeAttachment
    return this.live() === null ? "offline" : "online";
  }
}

/**
 * The connection's identity as the worker half wrote it, or null when any of the four
 * headers is absent — total, like every other reader of an inbound message here. The DO's
 * only door is handleConnect, which always writes all four, so null means the request did
 * not come through it: refusing beats manufacturing an attachment that would then audit
 * under `ownerId: ""`, tag the socket `""`, and survive every targeted revoke (§8).
 */
function identityFrom(req: Request): ConnectionAttachment | null {
  const appId = req.headers.get(IDENTITY_HEADER.app);
  const ownerId = req.headers.get(IDENTITY_HEADER.owner);
  const slug = req.headers.get(IDENTITY_HEADER.slug);
  const tokenId = req.headers.get(IDENTITY_HEADER.token);
  if (appId === null || ownerId === null || slug === null || tokenId === null) return null;
  return { v: 1, appId, ownerId, slug, tokenId, registered: false };
}

/**
 * A subscriber upgrade's identity as the worker half wrote it, or null when either header
 * is absent — which is how the app door and the subscriber door tell each other's
 * traffic apart, since neither writes the other's headers (§21.2).
 */
function subscriberFrom(req: Request): SubscriberAttachment | null {
  const sessionId = req.headers.get(SUBSCRIBER_HEADER.session);
  const principal = req.headers.get(SUBSCRIBER_HEADER.principal);
  if (sessionId === null || principal === null) return null;
  return { v: 1, sessionId, principal, uris: [] };
}

/**
 * A subscriber socket's attachment, or null when it is absent or of an unknown version —
 * the §10 version-skew branch again, answered here by treating the socket as carrying no
 * subscriptions at all rather than by closing it: a stream whose attachment cannot be read
 * hears no doorbell, and the re-auth tick (§21.2) is what ends it.
 */
function subscriberAttachmentOf(ws: WebSocket): SubscriberAttachment | null {
  const raw = ws.deserializeAttachment() as Partial<SubscriberAttachment> | null;
  if (raw === null || raw.v !== 1) return null;
  if (typeof raw.sessionId !== "string" || typeof raw.principal !== "string") return null;
  return { v: 1, sessionId: raw.sessionId, principal: raw.principal, uris: [...(raw.uris ?? [])] };
}

/** One inbound frame, read as far as the router needs: a method makes it a request or
 *  notification, its absence makes it an answer. Everything else stays opaque. */
type Frame = Record<string, unknown> & { method?: unknown; id?: unknown };

/** The socket's identity, or null when the attachment is absent or of an unknown version
 *  (§10's version-skew branch — every read goes through here, so there is one place it can
 *  be decided). */
function attachmentOf(ws: WebSocket): ConnectionAttachment | null {
  const raw = ws.deserializeAttachment();
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as ConnectionAttachment;
  return candidate.v === 1 ? candidate : null;
}

/** One text frame as JSON, or null for anything that is not a JSON object at all —
 *  binary frames included, which this protocol never uses. */
function parseFrame(message: string | ArrayBuffer): Frame | null {
  if (typeof message !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Frame)
      : null;
  } catch {
    return null;
  }
}

/** A frame's JSON-RPC id, or null — JSON-RPC's own rule for a message whose id cannot be
 *  read, which is what an unparseable first frame is answered with. */
function idOf(frame: Frame | null): string | number | null {
  const id = frame?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/**
 * `hub/register`'s declaration, or null when the payload is not one — the wire shape
 * registry.validateRoles is contracted to receive, in either of §20.3's two spellings: a
 * bare list of pattern strings (which MEANS tools, forever) or the per-family object.
 *
 * TYPE only. Which family names are legal, how long a pattern may be, whether it compiles
 * and whether `all` was reserved are all registry's, and every one of them comes back as a
 * violation with a message — so anything this reader refuses is a frame that could not have
 * produced one.
 */
function declarationOf(frame: Frame): RoleDeclaration | null {
  const params = frame.params;
  const roles = typeof params === "object" && params !== null ? (params as Record<string, unknown>).roles : undefined;
  // §6: `{}` and an absent `roles` alike mean "no roles declared" — a declaration, not a
  // violation.
  if (roles === undefined) return {};
  if (!isPlainObject(roles)) return null;
  for (const declared of Object.values(roles)) {
    // The bare list IS the tools list (§20.3), so both spellings are read as one shape here
    // — the normalization that STORES it is registry's, spelled once.
    const families = Array.isArray(declared) ? { tools: declared } : declared;
    if (!isPlainObject(families)) return null;
    for (const patterns of Object.values(families)) {
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) return null;
    }
  }
  return roles as RoleDeclaration;
}

/** A JSON object, as the wire can produce one — arrays and null excluded. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A correlated answer, or null for a frame that is not a JSON-RPC response at all —
 * JSON-RPC's own rule: the 2.0 envelope, and exactly one of `result`/`error`. The app
 * is the untrusted side of this socket, so ForwardResult's `response` is ESTABLISHED here
 * rather than asserted; nothing crosses into hub types on a cast.
 */
function answerOf(frame: Frame): JsonRpcResponse | null {
  if (frame.jsonrpc !== "2.0") return null;
  const carriesResult = "result" in frame;
  const carriesError = "error" in frame;
  if (carriesResult === carriesError) return null;
  const id = idOf(frame);
  return carriesResult
    ? { jsonrpc: "2.0", id, result: frame.result }
    : { jsonrpc: "2.0", id, error: errorMemberOf(frame.error) };
}

/**
 * The app's `error` member, NORMALIZED rather than cast. The gateway relays an app's
 * error to the consumer verbatim (§7), so whatever sits here becomes a JSON-RPC error
 * object on a consumer's wire — and JsonRpcResponse says error shapes come from the
 * gateway's own table, which a cast quietly makes untrue for the one member the untrusted
 * side of this socket writes. A member that is not an object, or whose `code`/`message` are
 * not an integer and a string, is replaced whole by the generic internal error: the answer
 * still counts as an error — the call DID reach the app and DID fail there, which is
 * the audit row's "error" outcome — it simply cannot put arbitrary bytes in the error slot.
 * `data` is free-form by JSON-RPC and passes through, but only alongside a well-formed rest.
 */
function errorMemberOf(raw: unknown): JsonRpcResponse["error"] {
  const carrier = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const { code, message } = carrier;
  if (!Number.isInteger(code) || typeof message !== "string") {
    return { code: CODES.internal, message: "app error" };
  }
  const error = { code: code as number, message };
  return "data" in carrier ? { ...error, data: carrier.data } : error;
}

/**
 * One list answer's catalog, or null when the app answered with an error or with
 * something that is not a list at all — either way the previous cache stands (§20.5: a
 * failure never empties one). MCP names the result member after the family in all four,
 * `resources/templates/list` included, so the family's own name is the key.
 *
 * Entries are kept VERBATIM but not indiscriminately: one without the key its family is
 * matched on (§20.2) names nothing any grant could cover, so caching it would only put a
 * permanently unlistable row in front of every reader. A tool additionally needs its object
 * inputSchema — sensitivePaths walks that schema, and a string there would be a walk over
 * something the type says cannot happen.
 */
function catalogOf(response: JsonRpcResponse, family: CatalogFamily): Record<string, unknown>[] | null {
  const result = response.result;
  if (typeof result !== "object" || result === null) return null;
  const entries = (result as Record<string, unknown>)[family];
  if (!Array.isArray(entries)) return null;
  // The key registry matches this family on: an entry that does not carry it names nothing
  // any grant could cover, so caching it would put a permanently unlistable row in front of
  // every reader. Which patterns then match it is the gateway's question, not this one's.
  const key = subjectKeyOf(family);
  return entries.filter(
    (entry) =>
      typeof entry?.[key] === "string" &&
      (family !== "tools" || (typeof entry.inputSchema === "object" && entry.inputSchema !== null)),
  );
}

/**
 * A `server/discover` answer's declared families, or null for everything §6 reads as
 * "capabilities unknown": an error reply — `-32601` from a library that predates the method,
 * or any other code — and an answer carrying no capabilities object at all, which is no
 * more legible than an error. Null and an answer that declared NOTHING are deliberately
 * different facts: only the second one is the app undeclaring itself (§20.5).
 *
 * Filtered to §20.2's vocabulary, so a family the handshake cannot spell is never stored,
 * never advertised, and never warmed.
 */
function declaredOf(response: JsonRpcResponse): AppCapability[] | null {
  const result = response.result;
  if (typeof result !== "object" || result === null) return null;
  const claimed = (result as { capabilities?: unknown }).capabilities;
  if (typeof claimed !== "object" || claimed === null) return null;
  // The CLAIM alone: what an app says about listChanged or subscribe is not read here
  // and never republished — §20.2 forces both false whatever the app claims.
  return APP_CAPABILITIES.filter((capability) => capability in claimed);
}

/** A JSON-RPC error reply, the only error object this module builds — §7's consumer wire
 *  is gateway's, and none of these frames ever reaches a consumer. */
function errorFrame(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
