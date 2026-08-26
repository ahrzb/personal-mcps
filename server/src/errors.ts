// errors.ts — the hub's one error vocabulary: the HubError class, §7's pinned refusal
// codes, and the factories for the three that carry no payload.
//
// A LEAF: it imports nothing, and that is the whole design. Refusing is something every
// layer does — the consumer pipeline, approvals, admin's ops table, both backends — so a
// vocabulary that lived inside the pipeline would make `class UpstreamError extends
// HubError` an import cycle and would drag `cloudflare:workers` and better-auth into every
// module that merely needs to say "no". Here nobody pays for anybody else's dependencies.
//
// What this module does NOT own: the mapping onto the JSON-RPC wire. A HubError reaches a
// consumer only through gateway.toWire, which stays the one place a JSON-RPC error object
// is built.

/**
 * The hub's one error vocabulary. `code` is a code from the pinned table — -32000
 * service unavailable · -32001 tool not permitted / unknown (deliberately
 * indistinguishable, §7) · -32002 service archived · -32003 approval required, `data`
 * carrying { approvalId, approvalUrl, expiresAt } · -32601 method not found. Thrown
 * anywhere in the pipeline or backends; it reaches the wire only through gateway's
 * mapping, so no module ever builds a JSON-RPC error object of its own.
 */
export class HubError extends Error {
  code: number;
  data?: unknown;
  /**
   * What this refusal contributes to the `tools/call` audit row's `detail` (§7, §15) —
   * set by whichever layer knew the real cause, copied verbatim by the gateway, and never
   * serialized to a consumer (toWire sends `code`, `message` and `data` alone). It is how
   * one -32000 on the wire can still tell an owner which failure class it was: an upstream
   * status vs a dead bundle, a tunnel that was offline vs one that timed out — the
   * at-most-once question §15 exists to let the ledger answer. §15's hygiene applies like
   * anywhere else: classes and bare numbers, never a status line, header, or body.
   */
  auditDetail?: Record<string, unknown>;
  /** `message` must already respect log hygiene (§15): no secrets, no upstream bodies. */
  constructor(code: number, message: string, data?: unknown) {
    // deps: none
    super(message);
    this.code = code;
    // Set only when there is one, so `data` is absent — not `undefined` — on every code
    // but -32003, which the indistinguishability rows compare on.
    if (data !== undefined) this.data = data;
  }
}

/**
 * §7's pinned refusal codes, named once for the whole hub. The prose beside each is
 * equally pinned: the three -32001 sources (ungranted, unknown prefix, unsplittable name)
 * must answer IDENTICALLY, which a per-site message would quietly break — which is why the
 * three factories below exist beside the table rather than at the throw sites.
 */
export const CODES = {
  unavailable: -32000,
  notPermitted: -32001,
  archived: -32002,
  approvalRequired: -32003,
  /** Not §7's own, but JSON-RPC's: a body that is not a request at all. */
  invalidRequest: -32600,
  methodNotFound: -32601,
  /** JSON-RPC's "invalid params" — an OWNER's configuration request being wrong, which is
   *  a different thing from §7's four consumer refusals (admin.ts's vocabulary note). */
  invalidParams: -32602,
  /** The generic mapping for anything that is not a HubError — never a cause, ever. */
  internal: -32603,
} as const;

/**
 * -32000. `failureClass` is the dispatching layer's own name for what went wrong —
 * "offline" / "timeout" for a tunnel, upstream.ts's five classes for a proxy — and rides
 * `auditDetail` to the ledger. Omitted where the caller genuinely cannot classify.
 */
export const unavailable = (failureClass?: string): HubError => {
  const err = new HubError(CODES.unavailable, "service unavailable");
  if (failureClass !== undefined) err.auditDetail = { failureClass };
  return err;
};
export const notPermitted = (): HubError => new HubError(CODES.notPermitted, "tool not permitted");
export const archived = (): HubError => new HubError(CODES.archived, "service archived");
