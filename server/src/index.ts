// index.ts — the composition root: the only module that knows the whole worker. It OWNS
// the canonical public origin (one config value every absolute URL the hub hands out is
// derived from), the wrangler Env shape (every binding and secret named exactly once),
// the top-level route table as data — from which RESERVED_ROUTES is derived so served
// routes and reserved usernames can never drift (§2; the §16 router-walk test pins this
// export, and identity receives the set as an argument rather than importing it back) —
// the daily cron fan-out, and the AppConnection Durable Object re-export
// wrangler requires from the entry module. It HIDES deployment topology: no sibling ever
// names a binding, a secret, a cron schedule, or a URL prefix.

import { httpServerIntegration, withSentry } from "@sentry/cloudflare";
import { Hono } from "hono";
import { beforeSend, HUB_NAMESPACE, prune, record, resolveAuditConfig } from "./audit";
import type { AuditConfig } from "./audit";
import { mcpMessage } from "./gateway";
import {
  anonymousNotFound,
  authRoutes,
  bootstrapRoute,
  requireOwnerSession,
  resolvePrincipal,
  unauthorized,
  USERNAME_CHARSET,
  whoamiRoute,
} from "./identity";
import type { Principal } from "./identity";
import {
  AUTH_SERVER_METADATA_PATH,
  PROTECTED_RESOURCE_PATH,
  authServerMetadata,
  protectedResourceMetadata,
} from "./oauth";
import { HUB_PRINCIPAL } from "./principal";
import { PMCP_SLUG, Registry } from "./registry";
import { handleConnect } from "./tunnel";
import {
  cleanupStaleState,
  clientMetadata,
  CLIENT_METADATA_PATH,
  handleCallback,
  OAUTH_CALLBACK_PATH,
} from "./upstream";
import { pageRoutes } from "./web";
import { approvalsFromEnv } from "./wiring";

/** @cloudflare/workers-types D1Database — external types never imported in skeletons. */
type D1Database = unknown;
/** @cloudflare/workers-types DurableObjectNamespace. */
type DurableObjectNamespace = unknown;

/**
 * The wrangler environment — bindings and secrets, named here and nowhere else.
 * Everything below reaches the tree only by being passed this object.
 */
export type Env = {
  /** D1: the shared control plane (§5) — better-auth tables plus ours. */
  DB: D1Database;
  /** AppConnection DO namespace, addressed by opaque `app.id` only (§3, §6). */
  APP_CONNECTION: DurableObjectNamespace;
  /**
   * The canonical public https origin, e.g. "https://mcp.example.com" — scheme + host,
   * no trailing slash, no path. The single source for every absolute URL the hub emits:
   * approvalUrl in -32003 errors (§7), WWW-Authenticate targets, the CIMD document and
   * the /oauth/upstream/callback redirect URI (§7), and the origin clients point
   * PMCP_URL at to derive wss://<origin>/connect (§10).
   */
  PUBLIC_ORIGIN: string;
  /** Secret: better-auth signing/session secret (§4). */
  BETTER_AUTH_SECRET: string;
  /** Secret: AES-GCM key enveloping `upstream_auth_json` at rest (§5). */
  UPSTREAM_CREDS_KEY: string;
  /** Secret: Web Push VAPID public key, ES256 (§13). */
  VAPID_PUBLIC_KEY: string;
  /** Secret: Web Push VAPID private key, ES256 (§13). */
  VAPID_PRIVATE_KEY: string;
  /**
   * Secret, optional on purpose: while unset, POST /internal/users does not exist —
   * 404 for everything (§12). Constant-time compared; an all-namespaces master key, so
   * the operator sets it for a use and rotates it after.
   */
  BOOTSTRAP_SECRET?: string;
  /**
   * Secret, optional: better-auth Dash (the hosted ops dashboard) API key. Unset —
   * dev, tests — means the dash plugin is not even constructed, so nothing phones
   * home from those environments (user-accepted exception 2026-08-26 to the
   * no-phone-home stance, production only).
   */
  BETTER_AUTH_API_KEY?: string;
  /**
   * Secret, optional: the Sentry DSN. Unset means Sentry is fully disabled — no
   * transport, no events, nothing to configure; the worker behaves exactly as if
   * the integration were absent.
   */
  SENTRY_DSN?: string;
  /**
   * Var, optional: audit/approval retention in days (§15). Unset means
   * limits.RETENTION_DAYS. Parsed only by audit.resolveAuditConfig, called at the
   * entry points (fetch/scheduled here, and the tunnel DO) — siblings receive the
   * resolved AuditConfig, never the string.
   */
  AUDIT_RETENTION_DAYS?: string;
  /**
   * Var, optional: per-body size cap for the audit body columns (§15). Unset means
   * limits.AUDIT_BODY_CAP_BYTES. Same parse path as AUDIT_RETENTION_DAYS.
   */
  AUDIT_BODY_CAP_BYTES?: string;
};

/**
 * The top-level route table, as data: the first path segments the worker serves ahead
 * of the /:user/mcp* fallthrough, each annotated with the module that mounts there.
 * `fetch` mounts from this table and RESERVED_ROUTES derives from it below — adding a
 * top-level route here extends the username reservation automatically (§2).
 */
export const ROUTES = [
  "login", // web: sign-in — password, TOTP challenge, passkey (§13)
  "device", // web: device-approval page for the CLI flow (§13)
  "settings", // web: credential management, cookie-session + recent-auth only (§4, §13)
  "audit", // web: audit view + streaming JSONL export (§13)
  "approvals", // web: approval dashboard, /approvals/:id detail, push opt-in (§13)
  "apps", // web: app management, Connect/Reconnect/Disconnect (§13)
  "oauth", // upstream OAuth: /oauth/upstream/callback (§7)
  "api", // hub-owned JSON: GET /api/whoami (§8) and better-auth under /api/auth (§4)
  "connect", // tunnel WebSocket upgrade: wss://<origin>/connect (§6)
  "internal", // bootstrap user management: /internal/users, BOOTSTRAP_SECRET-gated (§12)
  ".well-known", // oauth: the two §19.2 discovery documents — the dot keeps it out of the username charset, and it joins the reservation so the §16 walk stays total
  "manifest.webmanifest", // web: PWA manifest (§13) — a dot keeps it out of the username charset anyway
  "sw.js", // web: install+push service worker (§13)
  "styles.css", // web: the one stylesheet every page's shell links (§13)
] as const;

/** One top-level segment, as the table above names it. */
export type ServedSegment = (typeof ROUTES)[number];

/**
 * Segments a username can never claim (§2): every served top-level segment, plus
 * "mcp", reserved by fiat though served only as a second segment. The §16 router-walk
 * test asserts this set equals the segments the router actually serves (∪ "mcp"), so
 * the reservation and the route table can never drift.
 */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set([...ROUTES, "mcp"]);

/**
 * wrangler resolves Durable Object classes against the entry module, so the DO is
 * re-exported here; it lives in — and is addressed only through — ./tunnel.
 */
export { AppConnection } from "./tunnel";

/**
 * The worker entrypoint: HTTP/WebSocket in `fetch`, the daily cron in `scheduled`.
 * Uninstrumented on purpose — `instrumented` below is what wraps it in Sentry, and only
 * when there is a DSN to wrap it for. `ctx` is declared and unused by both legs: neither
 * needs it, but the wrapper does (it is where the flush is scheduled), so it has to
 * survive the hop.
 */
const handler = {
  /**
   * Routes by first path segment through ROUTES; anything else falls through to
   * /:user/mcp* — the username validated as `[a-z0-9-]` and not in RESERVED_ROUTES —
   * and otherwise 404. Auth is not decided here: each mounted group enforces its own
   * regime (cookie sessions on web pages, Bearer-only on /:user/mcp*, app tokens
   * on /connect, BOOTSTRAP_SECRET on /internal).
   */
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    // deps: hono · identity.authRoutes · identity.whoamiRoute · identity.bootstrapRoute · web.pageRoutes · gateway.mcpMessage · tunnel.handleConnect · upstream.clientMetadata · audit.resolveAuditConfig
    try {
      return await router().fetch(request, env);
    } catch (thrown) {
      // identity's guards refuse by THROWING a built Response (its failure convention);
      // the composition root is where those become the answer, verbatim. Hono rethrows
      // non-Error values rather than routing them through its error handler, so this is
      // the one place they can be caught.
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  },
  /**
   * The platform's daily trigger, and nothing else: a one-line adapter over `sweep`, which
   * is where the fan-out and its seam live. `controller` is the schedule the runtime fired
   * and this handler has no use for it — what ran is answerable from the `cron.swept` row.
   */
  async scheduled(_controller: unknown, env: Env, _ctx?: unknown): Promise<void> {
    // deps: sweep
    await sweep(env);
  },
};

/**
 * What wrangler runs: `handler`, plus §4's Sentry wrap when — and only when — SENTRY_DSN
 * is set. The dispatch is per-call because the DSN is a binding, not a build constant, and
 * bindings do not exist until a request arrives.
 *
 * The §15 contract, stated once, here: events leave through `audit.beforeSend`, which
 * strips `Authorization` and the `pmcp_(agt|app)_` grammar at every depth — this module
 * holds the DSN, audit holds what may leave in an event. Bodies never ride an event at
 * all: the SDK captures request bodies by DEFAULT (`maxRequestBodySize: "medium"`), so
 * that default is turned off at its source rather than scrubbed downstream, and PII
 * collection is pinned off beside it. The D1 `audit` table stays the only place a body is
 * ever persisted, post-redaction and capped.
 *
 * Unset DSN means fully off, not merely silent: the SDK's wrapper instruments every fetch
 * regardless of whether a client can send — AsyncLocalStorage, an env proxy, spans, a
 * re-wrapped streaming response body — so with no DSN it is never entered at all and the
 * worker behaves exactly as if the dependency were absent (which is the state the suite
 * runs in, and what `Env.SENTRY_DSN`'s comment promises).
 */
export default {
  fetch: (request: Request, env: Env, ctx?: unknown): Promise<Response> =>
    instrumented(env).fetch(request, env, ctx),
  scheduled: (controller: unknown, env: Env, ctx?: unknown): Promise<void> =>
    instrumented(env).scheduled(controller, env, ctx),
};

/**
 * `withSentry` instruments the object it is HANDED, in place, and returns it — so it is
 * given a copy, leaving `handler` itself the clean no-DSN path. Built once per isolate;
 * the options callback re-reads the DSN per request, which is the SDK's own contract.
 */
let sentried: typeof handler | undefined;
function instrumented(env: Env): typeof handler {
  if (!env.SENTRY_DSN) return handler;
  return (sentried ??= withSentry(
    (bound: Env) => ({
      dsn: bound.SENTRY_DSN,
      // Both hooks, not just the error one: tracing is off here (no sample rate), but the
      // SDK reads SENTRY_TRACES_SAMPLE_RATE from the environment on its own, so a var set
      // one day must not be what starts sending unscrubbed transaction events.
      beforeSend,
      beforeSendTransaction: beforeSend,
      sendDefaultPii: false,
      integrations: [httpServerIntegration({ maxRequestBodySize: "none" })],
    }),
    { ...handler },
  ));
}

/**
 * The daily cron fan-out (§15, §7): flip past-expiry pending approvals to expired
 * (one approval.expired audit row each), prune audit and approval rows past the
 * retention window (default limits.RETENTION_DAYS, AUDIT_RETENTION_DAYS
 * overrides), and drop stale upstream-OAuth `state` records (~10 min TTL, §7). The
 * legs run as a named list under Promise.allSettled — structurally, not by
 * promise: one leg failing never starves the others, and `legs` is the seam a test bends
 * to prove it (the real list with one member replaced by a rejecting one). The seam is a
 * parameter of THIS function rather than of `scheduled` because the platform's signature is
 * the platform's: a handler carrying its customer's fourth argument makes every caller read
 * a comment to learn which three the runtime supplies. Every run writes one `cron.swept`
 * audit row with per-leg outcome and counts, so "did the cron fire, and did every leg
 * succeed" is answerable from the /audit page — the cron's only monitoring.
 */
export async function sweep(
  env: Env,
  legs: readonly CronLeg[] = cronLegs(env, resolveAuditConfig(env)),
): Promise<void> {
  // deps: approvals.sweepExpired · audit.prune · upstream.cleanupStaleState · audit.record (cron.swept) · audit.resolveAuditConfig
  const settled = await Promise.allSettled(legs.map((leg) => leg.run()));
  const outcomes: Record<string, { ok: boolean; count: number }> = {};
  legs.forEach((leg, at) => {
    const result = settled[at];
    // Only the outcome and the count cross into the ledger — never the rejection's
    // message, which is the one thing here that could carry an upstream detail (§15).
    outcomes[leg.leg] =
      result.status === "fulfilled" ? { ok: true, count: result.value } : { ok: false, count: 0 };
  });
  // §15's one heartbeat. Written after every run, failures included: "did the cron fire,
  // and did every leg succeed" has to be answerable from /audit, which it is not if a bad
  // run is silent.
  await record(env.DB, {
    ownerId: HUB_NAMESPACE,
    principal: HUB_PRINCIPAL,
    event: "cron.swept",
    outcome: settled.every((result) => result.status === "fulfilled") ? "ok" : "error",
    detail: { legs: outcomes },
  });
}

/** One leg of the daily sweep: its name in the ledger, and the row count it reports. */
export type CronLeg = { leg: CronLegName; run(): Promise<number> };

/**
 * §15's named list, as a vocabulary. Exported so the suite can drive the legs themselves
 * rather than a transcription of them — a fourth leg added here has nowhere to hide.
 */
export const CRON_LEG_NAMES = [
  "approvals.sweepExpired",
  "audit.prune",
  "upstream.cleanupStaleState",
] as const;

export type CronLegName = (typeof CRON_LEG_NAMES)[number];

/**
 * The three legs, wired from the composition root's env. Each answers ONE number — how many
 * rows it acted on — because that is all the `cron.swept` row records and all an operator
 * reads. `approvals.sweepExpired` does two things and reports their sum: the flip and the
 * prune answer to different windows, but the ledger's question is "how much did this leg
 * touch", not "which half".
 */
export function cronLegs(env: Env, config: AuditConfig): readonly CronLeg[] {
  // Two things this site says for itself and nothing else does: the retention window is
  // the one THIS run resolved (which is what makes AUDIT_RETENTION_DAYS observable through
  // the sweep), and there is no `push` — a sweep notifies nobody, because an expiry the
  // owner never looked at is not news.
  const approvals = approvalsFromEnv({ retentionDays: config.retentionDays });
  return [
    {
      leg: "approvals.sweepExpired",
      run: async () => {
        const { expired, pruned } = await approvals.sweepExpired();
        return expired + pruned;
      },
    },
    { leg: "audit.prune", run: () => prune(env.DB, config) },
    { leg: "upstream.cleanupStaleState", run: () => cleanupStaleState() },
  ];
}

/**
 * The router, built once per isolate. Registration order is the route table's order plus
 * the `/:user/mcp*` fallthrough last, so a reserved segment can never be shadowed by a
 * username — and the reservation is checked again at the door anyway, because a route
 * this worker does not serve yet (a stub below) must not become a claimable namespace.
 */
let built: Hono<{ Bindings: Env }> | undefined;
function router(): Hono<{ Bindings: Env }> {
  return (built ??= buildRouter());
}

function buildRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  // ONE 404 for the whole worker: an unrouted path, a foreign namespace, an app the
  // caller holds no grants on, and a disabled bootstrap route all answer with these
  // bytes. "Indistinguishable from route-not-found" is only true if it is the same
  // Response, so identity builds it and this is where the router agrees to use it.
  app.notFound(() => anonymousNotFound());

  // Bare `/` is the one URL a person types by hand; it names no segment, so without this it
  // falls through to the anonymous 404. A read-only peek at the cookie session (the same
  // seam every page gates on, which returns on a real owner session and throws the login
  // bounce otherwise) sends a signed-in owner to their apps and everyone else to sign
  // in. Not a ROUTES segment — "" is no username — so the §16 walk is untouched.
  app.get("/", async (c) =>
    c.redirect(await requireOwnerSession(c.req.raw).then(() => "/apps", () => "/login"), 302),
  );

  // Every segment the route table names, mounted from the table itself — and each mount
  // CLAIMS its whole subtree (see `claim`), which is what the §16 router walk observes.
  for (const segment of ROUTES) MOUNTS[segment](app, segment);

  // §7's two consumer endpoint shapes, registered LAST so a reserved segment can never be
  // shadowed by a username. POST only — the 2026-07-28 revision is POST-only, and every
  // other method falls through to the same 404 an unknown path gets.
  app.post("/:user/mcp", (c) => mcpEntry(c.req.raw, c.env, c.req.param("user")));
  app.post("/:user/mcp/:slug", (c) =>
    mcpEntry(c.req.raw, c.env, c.req.param("user"), c.req.param("slug")),
  );
  return app;
}

/**
 * What one row of ROUTES mounts. A mount registers whatever routes its segment serves and
 * then CLAIMS the segment — `/<segment>` and everything under it — so the fallthrough can
 * never see a reserved name. The claim is each mount's own act rather than a blanket loop
 * over ROUTES, and that is deliberate: §16's walk is only worth running if a segment this
 * table reserves and nothing serves is observably different from one that is served.
 */
type Mount = (app: Hono<{ Bindings: Env }>, segment: ServedSegment) => void;

/**
 * Segment → mount, exhaustive over ROUTES by type: a segment added to the table above with
 * no mount here is a compile error, and a mount that claims nothing is caught at runtime by
 * the router walk. The browser surface is one app (web.pageRoutes) that eight segments
 * dispatch into whole; the four machine segments are mounted here because each is the
 * composition root's own wiring of a sibling module.
 */
const MOUNTS: Record<ServedSegment, Mount> = {
  login: browser,
  device: browser,
  settings: browser,
  audit: browser,
  approvals: browser,
  apps: browser,
  "manifest.webmanifest": browser,
  "sw.js": browser,
  "styles.css": browser,

  // better-auth's own surface (§4) and the CLI's one non-MCP data route (§8).
  api: (app, segment) => {
    app.route("/api/auth", authRoutes() as Hono);
    app.route("/api", whoamiRoute() as Hono);
    claim(app, segment, () => segmentNotFound(segment));
  },

  // §7's upstream-OAuth pair, both on the canonical public origin because both are URLs
  // the hub PUT ON THE WIRE at Connect time: the CIMD document is the client_id itself,
  // and the callback is the redirect_uri bound into every state row. The document is
  // static and secret-free, so it is served unauthenticated; the callback enforces its own
  // cookie-session gate inside `handleCallback` (§13), before it looks at `state` at all —
  // which is why no page shell wraps it.
  oauth: (app, segment) => {
    app.get(CLIENT_METADATA_PATH, (c) => clientMetadata(new URL(c.env.PUBLIC_ORIGIN)));
    app.get(OAUTH_CALLBACK_PATH, (c) => handleCallback(c.req.raw));
    // §19.5's pages (/oauth/consent, /oauth/connections) ride the page router like every
    // other page-serving segment; pageRoutes' own 404 is the tail for anything else here.
    claim(app, segment, (c) => (pages() as PageApp).fetch(c.req.raw, c.env));
  },

  // §6: the reverse connection's one door. GET only — an upgrade is a GET — and the
  // handler owns the whole 401/403/101 matrix, including what a request without
  // `Upgrade: websocket` gets.
  connect: (app, segment) => {
    app.get("/connect", (c) => handleConnect(c.req.raw));
    claim(app, segment, () => segmentNotFound(segment));
  },

  // §12: the bootstrap route EXISTS only while its secret does. Unset → the whole segment
  // answers the one anonymous 404, which is the spec's "404 for everything" and the reason
  // this segment claims itself rather than taking the shared tail. The secret is read here
  // and passed in: no sibling names a binding.
  internal: (app, segment) => {
    claim(app, segment, (c) => {
      const secret = c.env.BOOTSTRAP_SECRET;
      if (!secret) return anonymousNotFound();
      return bootstrapApp(secret).fetch(c.req.raw, c.env);
    });
  },

  // §19.2's two OAuth discovery documents — the AS metadata at the origin root and the
  // per-namespace PRM. Deliberately does NOT `claim` its subtree: this mount serves EXACTLY
  // these two paths and NOTHING else under /.well-known, so every other path there falls
  // through to the ONE anonymous 404 (`app.notFound`), byte-identical to any unrouted path
  // and carrying no CORS header. Distinguishing served-from-reserved by probing /<seg> would
  // spend that anti-enumeration property; the §16 walk probes this entry's DOCUMENT path
  // instead (routes.test.ts's per-entry rule). `oauth.ts` owns the documents; this is only
  // the wiring, so — like the `oauth`/`api` mounts — the path strings are the module's.
  ".well-known": (app) => {
    app.get(AUTH_SERVER_METADATA_PATH, () => authServerMetadata());
    app.get(PROTECTED_RESOURCE_PATH, (c) => protectedResourceMetadata(c.req.param("user")));
  },
};

/** The browser surface: one Hono app (web.pageRoutes), handed every request under the
 *  segments §13 gives it, including the ones it does not serve — its own 404 is the tail. */
function browser(app: Hono<{ Bindings: Env }>, segment: ServedSegment): void {
  claim(app, segment, (c) => (pages() as PageApp).fetch(c.req.raw, c.env));
}

/** web.pageRoutes as this module uses it: a fetch handler over the bindings. */
type PageApp = { fetch(request: Request, env: Env): Promise<Response> };

/** Built once per isolate, like the router it is mounted into. */
let pageApp: unknown;
function pages(): unknown {
  return (pageApp ??= pageRoutes());
}

/** `/<segment>` and everything under it, answered by one handler — the claim §2 needs and
 *  §16 walks. Registered after the segment's own routes, so those match first. */
function claim(
  app: Hono<{ Bindings: Env }>,
  segment: ServedSegment,
  handler: (c: { req: { raw: Request }; env: Env }) => Response | Promise<Response>,
): void {
  app.all(`/${segment}`, handler);
  app.all(`/${segment}/*`, handler);
}

/**
 * A path under a served segment. Deliberately NOT the hub's one anonymous 404: that answer
 * exists so namespaces, apps and unrouted paths are indistinguishable from each other,
 * and a segment the public route table already names has nothing left to hide. Saying so is
 * also what lets §16's walk tell "this segment is served" from "this segment is reserved and
 * nothing answers it", which no shared 404 could.
 */
function segmentNotFound(segment: string): Response {
  return new Response(`No such path under /${segment}\n`, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * The bootstrap sub-app, rebuilt only if the secret it closes over is rotated. §2's
 * reservation travels with it as an ARGUMENT, like the secret and for the same reason:
 * the route table it derives from is this module's, and a leg that refuses a reserved
 * username must not have to import the composition root to learn what one is.
 */
let bootstrap: { secret: string; app: Hono } | undefined;
function bootstrapApp(secret: string): Hono {
  if (bootstrap?.secret !== secret) {
    bootstrap = { secret, app: bootstrapRoute(secret, RESERVED_ROUTES) as Hono };
  }
  return bootstrap.app;
}

/**
 * The door on `/<user>/mcp*` — §7 step 1's whole HTTP-level verdict, in the order the
 * spec states it: transport hygiene, then who is calling, then whether this namespace and
 * (scoped) this app exist FOR THEM. Everything here refuses with a status; the
 * pipeline past it speaks JSON-RPC and never sees a request that failed any of it.
 *
 * The refusals are deliberately few and shared: one 401 (identity's, with
 * `WWW-Authenticate`), one 403 (the Origin rule's — the only 403 on this surface), one
 * 404 (the worker's single anonymous one). That is what makes the anti-enumeration
 * claims byte-true instead of merely status-true.
 *
 * The resolved principal is HANDED to the pipeline rather than left for it to re-derive:
 * §7 step 1 runs once per request, here, and gateway never has to trust — or re-prove —
 * who is calling. That is what "entered ONLY past the door" buys, and it is why a
 * session-bearer call costs one better-auth round trip rather than two.
 *
 * §21.2 adds the one request that outlives its own step 1: a held listen stream, which
 * re-authorizes itself on every keepalive. It is given the SAME verdict as a callable
 * (`admitted` below, which is also what this function's own last two lines run), so the
 * tick answers exactly as a fresh open would and there is no second spelling of step 1 to
 * drift from this one.
 */
async function mcpEntry(
  request: Request,
  env: Env,
  user: string,
  slug?: string,
): Promise<Response> {
  // A reserved segment is never a namespace (§2), so a request shaped like one is
  // route-not-found — checked here as well as at registration, because a segment stubbed
  // today is a served route tomorrow and must not be claimable in between.
  if (!USERNAME_CHARSET.test(user) || RESERVED_ROUTES.has(user)) return anonymousNotFound();
  // OPEN (auth-matrix.test.ts's row says so too): §7 step 1 requires `application/json`
  // and states no status for its absence, while giving the Origin failure an explicit
  // 403. Refusing as "no valid principal" is what the stated vocabulary leaves; if the
  // owner decides 415 or 400, this line and that row change together.
  if (!isJson(request)) return unauthorized();
  const origin = request.headers.get("Origin");
  // If-present-must-match: non-browser consumers send none and pass, which is every
  // legitimate caller; a browser that sends someone else's origin is the case this exists
  // for (the SDK's originValidation semantics, which createMcpHandler does not apply).
  if (origin !== null && origin !== env.PUBLIC_ORIGIN) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const principal = await admitted(request, env, slug);
  if (principal === null) return anonymousNotFound();
  // The tick re-reads the credential and (scoped) the app's visibility off the SAME
  // request — bearer, namespace and slug are all still on it — so nothing about the
  // stream's own state can widen what the door already decided. Identity refuses by
  // THROWING a Response, and on a tick there is nobody to hand one to: every way step 1
  // can refuse means one thing to a held stream, which is that it is no longer admitted
  // (§21.2 — the stream closes, and the client's reopen meets the door properly).
  return mcpMessage(request, env, principal, slug, () =>
    admitted(request, env, slug).catch(() => null),
  );
}

/**
 * §7 step 1's identity half, as one verdict: the caller resolved (identity's own 401/404
 * throws travel out of here untouched — the composition root turns them into the answer)
 * and, on the scoped shape, judged visible for the addressed slug. `null` is the
 * scoped-visibility 404 alone; a credential that resolves to nobody never gets this far.
 *
 * Called twice per held stream and once per POST, which is the whole reason it is a
 * function: §21.2's re-authorization tick has to ask the door, not a copy of it.
 */
async function admitted(request: Request, env: Env, slug?: string): Promise<Principal | null> {
  const principal = await resolvePrincipal(request);
  if (slug !== undefined && !(await visibleOnScoped(env, principal, slug))) return null;
  return principal;
}

/** §7 step 1: `Content-Type: application/json` is required (parameters ignored). */
function isJson(request: Request): boolean {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

/**
 * §7 step 2's scoped-endpoint visibility, as a 404: an agent gets the same
 * answer for a slug that does not exist and for one it holds no grants on, so a
 * zero-grant agent cannot enumerate the namespace — and the reserved `pmcp` builtin is
 * one more slug it holds no grants on (§8: admin tokens only), never a 401 that would
 * invite it to authenticate differently. Owners see every app in their own namespace.
 */
async function visibleOnScoped(env: Env, principal: Principal, slug: string): Promise<boolean> {
  if (slug === PMCP_SLUG) return principal.kind === "user";
  const registry = new Registry(env.DB);
  const ownerId = principal.kind === "user" ? principal.userId : principal.ownerId;
  const app = await registry.getApp(ownerId, slug);
  if (app === null) return false;
  if (principal.kind === "user") return true;
  // registry's own signal: an empty roleNames on an agent means no grants at all here,
  // as opposed to grants whose roles have gone undeclared (a normal, listable state).
  return (await registry.resolveAccess(principal, app)).roleNames.length > 0;
}
