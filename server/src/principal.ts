// principal.ts — who is calling, as a value: the resolved-identity type every downstream
// decision keys on, the ONE canonical DISPLAY spelling of it — of a human or machine caller
// (formatPrincipal, HUB_PRINCIPAL) — the ONE comparison key for an access check over time
// (principalKey, §21.4's subscriber authorization), and the credential prefixes the §15
// scrubbers hunt (TOKEN_PREFIX, tokenPattern). The first two are deliberately different
// functions: one names a caller in a ledger, the other decides whether a caller may mutate
// something, and `principalKey` says why a slug cannot do both jobs.
//
// A LEAF (deps: none), and for the same reason errors.ts is one: audit rows, the forwarded
// `hub/principal` _meta field, /api/whoami and the approval ledger all have to NAME a
// caller, while only identity may PRODUCE one — and identity reaches better-auth and
// `cloudflare:workers` at module scope. Splitting the name from the production is what lets
// approvals write `agent:<slug>` into the ledger without pulling workerd into the pure core,
// and it is what makes "one caller, one string, one query" a fact rather than a convention
// between four spellings. identity re-exports both, so producing a principal stays its
// monopoly and no caller has to learn that this file exists.

/**
 * The resolved caller identity that every downstream decision keys on — produced by
 * identity.resolvePrincipal, consumed by the gateway pipeline, never constructed
 * anywhere else.
 *
 * A `user` is the namespace owner acting as themself (web session or CLI device-flow
 * session): sees every app, never approval-gated. A `agent` is a
 * machine identity confined by its grants; `ownerId` names the namespace it lives in
 * and `slug` is its per-owner name. App tokens (`pmcp_app_`) never become a
 * Principal — they authenticate only the /connect upgrade, via resolveAppToken.
 *
 * `admin` (§22.1) is a `pmcp_adm_` bearer: an owner-scoped credential that reaches only
 * the builtin `pmcp` admin surface, never a single app tool. It carries the SAME fields
 * a `user` does — an admin token is deliberately indistinguishable from its owner
 * downstream (formatPrincipal, principalKey) — and exists as its own union member
 * anyway, because authorization (index.visibleOnScoped, registry.resolveAccess,
 * admin.adminOpsFor) has to tell the two apart even where display does not.
 */
export type Principal =
  | { kind: "user"; userId: string; username: string }
  | { kind: "agent"; agentId: string; ownerId: string; slug: string }
  | { kind: "admin"; userId: string; username: string };

/**
 * The one canonical principal string — `user:<username>` or `agent:<slug>` — used
 * identically by audit rows, the forwarded `hub/principal` _meta field, /api/whoami and
 * the approval ledger. Owning the format here keeps those surfaces from each knowing it:
 * they all write into the same `principal` column, so a second spelling would silently
 * split one caller's history in two.
 */
export function formatPrincipal(p: Principal): string {
  // deps: none
  // §22.1: an admin token's audience is the SAME owner a session names — the non-goal
  // is per-credential attribution, not per-kind — so it falls into the `user` arm rather
  // than growing one of its own.
  switch (p.kind) {
    case "user":
    case "admin":
      return `user:${p.username}`;
    case "agent":
      return `agent:${p.slug}`;
  }
}

/**
 * The principal as an AUTHORIZATION key, deliberately not `formatPrincipal`'s string:
 * `user:<userId>` / `agent:<agentId>`, over the immutable row ids.
 *
 * §21.4 authorizes a `resources/subscribe` by comparing the subscriber socket's stored
 * principal to the caller's, and a key used for that has to be stable and unique OVER
 * TIME. `agent:<slug>` is neither: a slug is unique only among LIVE agents, so
 * delete-and-recreate reuses one, and an agent recreated under an old slug would
 * authorize against the deleted agent's live socket. It is also the format audit rows,
 * `hub/principal`, /api/whoami and the approval ledger all read — a display spelling is
 * no place to put an access check, and coupling the two would make renaming either one
 * silently change the other's meaning.
 */
export function principalKey(p: Principal): string {
  // deps: none
  switch (p.kind) {
    case "user":
    case "admin":
      return `user:${p.userId}`;
    case "agent":
      return `agent:${p.agentId}`;
  }
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
 * The prefix per `token`-table kind — the ONE place the wire spelling of an `agent`/`app`
 * credential lives. Written at mint (identity.issueToken), matched at resolve, and never
 * trusted as evidence of kind (that is the `kind` column's job, §6). It sits in this leaf
 * rather than in identity for the same reason the principal format does: the §15 scrubbers
 * have to NAME credential material while only identity may MINT it, and a scrubber that
 * transcribed the grammar instead of importing it stops matching the day a prefix is
 * rotated or extended. Deliberately two-membered forever: `admin_token` is its own table
 * with its own prefix below, never a third `TokenKind` (§22.1).
 */
export const TOKEN_PREFIX = {
  agent: "pmcp_agt_",
  app: "pmcp_app_",
} as const;

/**
 * §22.1's `pmcp_adm_` admin-token prefix — deliberately NOT a `TOKEN_PREFIX` member (that
 * union stays two-membered, one per `token.kind` value) even though it joins the same
 * credential grammar below. Written at mint (identity.issueAdminToken), matched at resolve
 * (identity.resolveCredential's `pmcp_adm_` leg).
 */
export const ADMIN_TOKEN_PREFIX = "pmcp_adm_";

/**
 * The credential grammar as a matcher, derived from every live prefix — `TOKEN_PREFIX`'s
 * two plus `ADMIN_TOKEN_PREFIX` — so a new one is hunted by every §15 sink the day it is
 * minted: the audit and Sentry scrubbers, the gateway URI scrubber, the database hygiene
 * sweep, and the contract sweep. The prefix grammar and the token-KIND union (TokenKind,
 * two-membered) are deliberately different things: §22.1 is what separated them, since
 * `admin_token` needed a third wire prefix without a third `token.kind` value to match it.
 * `minBody` is what separates token MATERIAL from §5's deliberately-stored display prefix:
 * a real secret's body is base64url over 256 bits, while `token.prefix` is a dozen
 * characters the schema means to keep, so a sweep over stored columns asks for a floor and
 * a scrubber over prose does not.
 */
export function tokenPattern(minBody = 1, flags = ""): RegExp {
  // deps: none
  const prefixes = [...Object.values(TOKEN_PREFIX), ADMIN_TOKEN_PREFIX];
  return new RegExp(`(?:${prefixes.join("|")})[A-Za-z0-9_-]{${minBody},}`, flags);
}
