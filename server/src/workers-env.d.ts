// workers-env.d.ts — the hand-rolled shadow of the platform surface, in two halves.
//
// `cloudflare:workers` is the ambient binding access the seams that take no `db` parameter
// resolve through: identity (`issueToken(input, now?)`, `resolvePrincipal(req)`) and
// admin's ops table and §12 pair, none of which carry an Env argument, plus the tunnel DO
// (audit.ts's resolveAuditConfig header names it). Registry and audit are the other
// convention — they take the binding — and neither needs that half.
//
// `D1Like`/`D1Stmt` are the OTHER half: the one declaration of what a D1 binding is in
// this repo. It is a platform shape, not any module's, so registry, identity and admin all
// spell it by the same name and there is exactly one place for it to be wrong in — the
// widest shape any of them actually calls (prepare + batch; first/all/run, run carrying
// D1's `meta.changes`). Global rather than exported because a `declare module` file is a
// script, and because global is where `@cloudflare/workers-types` would put a platform
// type anyway.
//
// Hand-rolled because `@cloudflare/workers-types` is deliberately not a dependency: the
// skeletons type every binding `unknown` (index.ts's Env), so this file adds names, not a
// platform type surface. `Env` is imported by type only — no runtime edge to the
// composition root.

declare module "cloudflare:workers" {
  export const env: import("./index").Env;
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
