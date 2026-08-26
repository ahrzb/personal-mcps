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
 * The generic half of every -32000: what a consumer is told happened, which is nothing
 * beyond "not right now" (§7 — the class never leaves the ledger). Declared ABOVE its
 * reader, like everything else this module's temporal-dead-zone note is about.
 */
const UNAVAILABLE = "service unavailable";

/**
 * The failure classes that CERTAINLY dispatched nothing — the whole of the exception to
 * the disclosure rule in `unavailable`, and the reason each is in it: "offline" (a tunnel
 * with no live socket: nothing was sent and the hub has no outbox), "catalog_unreachable"
 * (a cached-catalog read, which never reaches the service at all), "needs_reconnect" (a
 * stored credential the hub already knows is dead, so no dial is attempted).
 *
 * A SET rather than the inverse list, and that asymmetry is the safety rule: an unknown
 * class discloses. Over-warning costs a consumer one avoidable retry decision;
 * under-warning is §15's at-most-once lie, and a class added to a dispatching layer
 * without a thought here must fail in the harmless direction.
 */
const DISPATCHED_NOTHING: ReadonlySet<string> = new Set([
  "offline",
  "catalog_unreachable",
  "needs_reconnect",
]);

/**
 * -32000, and the ONE place the hub decides what a -32000 says. `failureClass` is the
 * dispatching layer's own name for what went wrong — "offline" / "timeout" /
 * "disconnected" for a tunnel, upstream.ts's five classes for a proxy — and does two
 * things: it rides `auditDetail` to the ledger, and it decides §15's at-most-once
 * disclosure through the table above. A class that certainly dispatched nothing keeps the
 * bare "service unavailable"; every other class appends ": the call may have executed".
 *
 * The MESSAGE is where that disclosure has to live, and the message is the whole of what
 * a caller may vary: §7 makes dispatch failures indistinguishable by code, and -32000 is
 * pinned to carry no `data` (contracts/errors.json), so a consumer deciding whether a
 * retry is safe has nowhere else to read it. Deciding it here rather than at the throw
 * sites is the same rule the three payload-free factories below follow — two backends
 * asking the same question of the world must not answer a consumer differently.
 *
 * No class at all is the bare message: the caller genuinely cannot classify, and a warning
 * about a dispatch nobody claims happened would be noise rather than caution.
 */
export const unavailable = (failureClass?: string): HubError => {
  const err = new HubError(
    CODES.unavailable,
    failureClass === undefined || DISPATCHED_NOTHING.has(failureClass)
      ? UNAVAILABLE
      : `${UNAVAILABLE}: the call may have executed`,
  );
  if (failureClass !== undefined) err.auditDetail = { failureClass };
  return err;
};

export const notPermitted = (): HubError => new HubError(CODES.notPermitted, "tool not permitted");
export const archived = (): HubError => new HubError(CODES.archived, "service archived");
