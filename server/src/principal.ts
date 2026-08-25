// principal.ts — who is calling, as a value: the resolved-identity type every downstream
// decision keys on, and the ONE canonical spelling of it.
//
// A LEAF (deps: none), and for the same reason errors.ts is one: audit rows, the forwarded
// `hub/principal` _meta field, /api/whoami and the approval ledger all have to NAME a
// caller, while only identity may PRODUCE one — and identity reaches better-auth and
// `cloudflare:workers` at module scope. Splitting the name from the production is what lets
// approvals write `sa:<slug>` into the ledger without pulling workerd into the pure core,
// and it is what makes "one caller, one string, one query" a fact rather than a convention
// between four spellings. identity re-exports both, so producing a principal stays its
// monopoly and no caller has to learn that this file exists.

/**
 * The resolved caller identity that every downstream decision keys on — produced by
 * identity.resolvePrincipal, consumed by the gateway pipeline, never constructed
 * anywhere else.
 *
 * A `user` is the namespace owner acting as themself (web session or CLI device-flow
 * session): sees every service, never approval-gated. A `service_account` is a
 * machine identity confined by its grants; `ownerId` names the namespace it lives in
 * and `slug` is its per-owner name. Service tokens (`pmcp_svc_`) never become a
 * Principal — they authenticate only the /connect upgrade, via resolveServiceToken.
 */
export type Principal =
  | { kind: "user"; userId: string; username: string }
  | { kind: "service_account"; accountId: string; ownerId: string; slug: string };

/**
 * The one canonical principal string — `user:<username>` or `sa:<slug>` — used
 * identically by audit rows, the forwarded `hub/principal` _meta field, /api/whoami and
 * the approval ledger. Owning the format here keeps those surfaces from each knowing it:
 * they all write into the same `principal` column, so a second spelling would silently
 * split one caller's history in two.
 */
export function formatPrincipal(p: Principal): string {
  // deps: none
  return p.kind === "user" ? `user:${p.username}` : `sa:${p.slug}`;
}
