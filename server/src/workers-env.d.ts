// workers-env.d.ts — the hand-rolled shadow of the platform surface, in two halves.
//
// `cloudflare:workers` is the ambient binding access the seams that take no `db` parameter
// resolve through: identity (`issueToken(input, now?)`, `resolvePrincipal(req)`) and
// admin's ops table and §12 pair, none of which carry an Env argument, plus the tunnel DO
// (audit.ts's resolveAuditConfig header names it). Registry and audit are the other
// convention — they take the binding — and neither needs that half. `DurableObject` is
// the same module's other export: extending it is what makes a class's methods callable
// as RPC from the worker half, a plain class serving `fetch` alone.
//
// `D1Like`/`D1Stmt`/`DurableObjectNamespaceLike`/`DurableObjectStateLike`, the
// `WebSocketPair` constructor and the platform's additions to `WebSocket`/`Response` (the
// attachment pair, the 101 socket) are the OTHER half: the one declaration
// of what each binding is in this repo. They are platform shapes, not any module's, so
// registry, identity and admin all spell D1 by the same name and there is exactly one
// place for it to be wrong in — the widest shape any of them actually calls (prepare +
// batch; first/all/run, run carrying D1's `meta.changes`). Global rather than exported
// because a `declare module` file is a script, and because global is where
// `@cloudflare/workers-types` would put a platform type anyway.
//
// Hand-rolled because `@cloudflare/workers-types` is deliberately not a dependency: the
// skeletons type every binding `unknown` (index.ts's Env), so this file adds names, not a
// platform type surface. `Env` is imported by type only — no runtime edge to the
// composition root.

declare module "cloudflare:workers" {
  export const env: import("./index").Env;

  /** The Durable Object base class — it supplies `ctx`, and extending it is what makes a
   *  class's methods reachable as RPC. Shaped to what the tunnel DO actually touches:
   *  see DurableObjectStateLike. */
  export class DurableObject {
    protected ctx: DurableObjectStateLike;
  }

  /** The worker's own exported entrypoints as a loopback service binding — the running
   *  router reached from inside the same isolate. Test-side only in this repo (the router
   *  walk, the tunnel harness dialling /connect); no src module calls itself. */
  export const exports: { default: { fetch(request: Request): Promise<Response> } };
}

/**
 * The Durable Object's own context, as the tunnel DO uses it: SQLite-backed storage (the
 * durable KV face plus `sql` — a new_sqlite_classes DO has both, and only the smoke suite
 * touches the latter, to observe that the class really is SQLite-backed), the storage alarm
 * behind §6's registration deadline, and the WebSocket hibernation API.
 */
type DurableObjectStateLike = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    /** Everything stored, for the one sweep that has to look at ALL of it: §15's rule that
     *  no credential material is at rest in a store nothing else audits — and, with a
     *  `prefix`, the keyspace scan §21.3's coalescing alarm drains its pending rings with. */
    list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] } };
  };
  /** Hands a socket to the runtime so it survives hibernation; `tags` are the runtime's
   *  own filter for getWebSockets, never an identity (§6 puts identity in the attachment). */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  /** The tags a socket was accepted with — how §21.2's two socket CLASSES are told apart
   *  inside the DO (the `sub:` prefix is the whole separator), never an identity. */
  getTags(ws: WebSocket): string[];
};

/**
 * A stylesheet imported as a Text module — wrangler.jsonc's `rules` is what makes the
 * bytes of `pages/styles.css` reachable from a worker that has no filesystem, and web.ts
 * serves them at `/styles.css`. Vite (the test runner's bundler) resolves the same import
 * through its own CSS pipeline and hands back an empty string, so the tests render
 * unstyled pages: nothing asserts on CSS, and the alternative — a second copy of a
 * 1700-line stylesheet living in a .ts file — is the drift this repo exists to avoid.
 */
declare module "*.css" {
  const css: string;
  export default css;
}

/** The pair of ends `new WebSocketPair()` mints: `0` travels back to the client in a 101
 *  response, `1` is the end the DO accepts. */
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

/** The platform's additions to the DOM WebSocket: `accept()` for a socket handled without
 *  hibernation (the test-side client end), and the attachment pair §6's connection identity
 *  rides through hibernation. */
interface WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** A 101 response carries the client end of the pair — the platform's one extension to
 *  Response, on both the init and the read side. */
interface ResponseInit {
  webSocket?: WebSocket | null;
}
interface Response {
  readonly webSocket: WebSocket | null;
}

/** One prepared statement. `run` reports D1's `meta.changes` — what an UPDATE's "did it
 *  match" answer is read from; callers with nothing to read simply ignore it. */
type D1Stmt = {
  bind(...values: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};

/** The binding itself: prepared statements, and the atomic batch setGrants replaces a
 *  full grant set through. */
type D1Like = {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown>;
};

/** A Durable Object namespace binding, generic in the stub its ids resolve to — the stub's
 *  methods ARE the class's, called over RPC. The id is opaque: minted from a name (the
 *  tunnel's is the app's opaque `app.id`) and handed straight back to `get`, never
 *  inspected, which is why it needs no shape of its own. */
type DurableObjectNamespaceLike<Stub> = {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
};
