// principal.ts — who is calling, as a value: the resolved-identity type every downstream
// decision keys on, and the ONE canonical spelling of it — of a human or machine caller
// (formatPrincipal, HUB_PRINCIPAL) and of the credential prefixes the §15 scrubbers hunt
// (TOKEN_PREFIX, tokenPattern).
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

/**
 * The fifth member of the `principal` vocabulary (see audit.AuditEntry): the MACHINE actor —
 * lazy approval expiry, and every row a scheduled run writes. It lives here for the same
 * reason `formatPrincipal` does: approvals and the composition root both write it into the
 * same column, and two spellings would split one actor's history in two with nothing to
 * catch it. Not a namespace: `audit.HUB_NAMESPACE` is a separate reservation in a column of
 * opaque user ids, and says so where it is declared.
 */
export const HUB_PRINCIPAL = "hub";

/**
 * The prefix per token kind — the ONE place the wire spelling of a credential lives.
 * Written at mint (identity.issueToken), matched at resolve, and never trusted as evidence
 * of kind (that is the `kind` column's job, §6). It sits in this leaf rather than in
 * identity for the same reason the principal format does: the §15 scrubbers have to NAME
 * credential material while only identity may MINT it, and a scrubber that transcribed the
 * grammar instead of importing it stops matching the day a prefix is rotated or extended.
 */
export const TOKEN_PREFIX = {
  service_account: "pmcp_sa_",
  service: "pmcp_svc_",
} as const;

/**
 * The credential grammar as a matcher, derived from TOKEN_PREFIX so a new kind — or a
 * longer scheme tag — is hunted by every §15 sink the day it is minted. `minBody` is what
 * separates token MATERIAL from §5's deliberately-stored display prefix: a real secret's
 * body is base64url over 256 bits, while `token.prefix` is a dozen characters the schema
 * means to keep, so a sweep over stored columns asks for a floor and a scrubber over prose
 * does not.
 */
export function tokenPattern(minBody = 1, flags = ""): RegExp {
  // deps: none
  return new RegExp(`(?:${Object.values(TOKEN_PREFIX).join("|")})[A-Za-z0-9_-]{${minBody},}`, flags);
}
