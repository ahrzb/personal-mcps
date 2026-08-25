// index.ts — the composition root: the only module that knows the whole worker. It OWNS
// the canonical public origin (one config value every absolute URL the hub hands out is
// derived from), the wrangler Env shape (every binding and secret named exactly once),
// the top-level route table as data — from which RESERVED_ROUTES is derived so served
// routes and reserved usernames can never drift (§2; the §16 router-walk test pins this
// export) — the daily cron fan-out, and the ServiceConnection Durable Object re-export
// wrangler requires from the entry module. It HIDES deployment topology: no sibling ever
// names a binding, a secret, a cron schedule, or a URL prefix.

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
  /** ServiceConnection DO namespace, addressed by opaque `service.id` only (§3, §6). */
  SERVICE_CONNECTION: DurableObjectNamespace;
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
  "account", // web: credential management, cookie-session + recent-auth only (§4, §13)
  "audit", // web: audit view + streaming JSONL export (§13)
  "approvals", // web: approval dashboard, /approvals/:id detail, push opt-in (§13)
  "services", // web: service management, Connect/Reconnect/Disconnect (§13)
  "oauth", // upstream OAuth: /oauth/upstream/callback (§7)
  "api", // hub-owned JSON: GET /api/whoami (§8) and better-auth under /api/auth (§4)
  "connect", // tunnel WebSocket upgrade: wss://<origin>/connect (§6)
  "internal", // bootstrap user management: /internal/users, BOOTSTRAP_SECRET-gated (§12)
  "manifest.webmanifest", // web: PWA manifest (§13) — a dot keeps it out of the username charset anyway
  "sw.js", // web: install+push service worker (§13)
] as const;

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
export { ServiceConnection } from "./tunnel";

/** The worker entrypoint: HTTP/WebSocket in `fetch`, the daily cron in `scheduled`. */
export default {
  /**
   * Routes by first path segment through ROUTES; anything else falls through to
   * /:user/mcp* — the username validated as `[a-z0-9-]` and not in RESERVED_ROUTES —
   * and otherwise 404. Auth is not decided here: each mounted group enforces its own
   * regime (cookie sessions on web pages, Bearer-only on /:user/mcp*, service tokens
   * on /connect, BOOTSTRAP_SECRET on /internal).
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    // deps: hono · identity.authRoutes · identity.whoamiRoute · identity.bootstrapRoute · web.pageRoutes · gateway.mcpRoutes · tunnel.handleConnect · upstream.clientMetadata
    throw new Error("unimplemented");
  },
  /**
   * The daily cron fan-out (§15, §7): flip past-expiry pending approvals to expired
   * (one approval.expired audit row each), prune audit and approval rows older than
   * 90 days, and drop stale upstream-OAuth `state` records (~10 min TTL, §7). The
   * legs run as a named list under Promise.allSettled — structurally, not by
   * promise: one leg failing never starves the others, and the list is a seam a
   * test can stub to prove it. Every run writes one `cron.swept` audit row with
   * per-leg outcome and counts, so "did the cron fire, and did every leg succeed"
   * is answerable from the /audit page — the cron's only monitoring.
   */
  async scheduled(controller: unknown, env: Env): Promise<void> {
    // deps: approvals.sweepExpired · audit.prune · upstream.cleanupStaleState · audit.record (cron.swept)
    throw new Error("unimplemented");
  },
};
