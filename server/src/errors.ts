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

/** One thing an admin op refused, in the op's own field name (§8) — see `HubError.violations`. */
export type Violation = { field: string; reason: string };

/**
 * The hub's one error vocabulary. `code` is a code from the pinned table — -32000
 * app unavailable · -32001 tool not permitted / unknown (deliberately
 * indistinguishable, §7) · -32002 app archived · -32003 approval required, `data`
 * carrying `{ approvalId, approvalUrl, expiresAt }` · -32601 method not found · -32602
 * invalid params (§21.4's over-cap subscribe and §23's discoverable dynamic timeout
 * maximum). Thrown anywhere in the pipeline or backends; it reaches the wire only through
 * gateway's mapping, so no module ever builds a JSON-RPC error object of its own.
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
   * at-most-once question §15 exists to let the ledger answer — and, since decision 37,
   * how one -32001 can tell an ungranted tool from an app that is not there
   * (`RefusalReason`). §15's hygiene applies like
   * anywhere else: classes and bare numbers, never a status line, header, or body.
   */
  auditDetail?: Record<string, unknown>;
  /**
   * §8's field-scoped list behind a `-32602` from an admin op — every violation the call
   * found, in the op's own field names — for the in-process callers that place each
   * sentence under a control (the add-app page). Like `auditDetail`, never serialized:
   * admin-op violations carry `code` and `message` only. The distinct execute-admission
   * refusal may put its dynamic timeout ceiling in `data`; it does not use this field.
   */
  violations?: readonly Violation[];
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
  /** JSON-RPC's "invalid params", in two vocabularies: an owner's configuration request
   * being wrong, and caller input rejected at a consumer boundary. Most uses are
   * payload-free; §23's over-max `timeout_ms` carries only `{ field, max }`, while §21.4's
   * subscription count/URI caps remain payload-free. */
  invalidParams: -32602,
  /** The generic mapping for anything that is not a HubError — never a cause, ever. */
  internal: -32603,
} as const;

/**
 * The generic half of every -32000: what a consumer is told happened, which is nothing
 * beyond "not right now" (§7 — the class never leaves the ledger). Declared ABOVE its
 * reader, like everything else this module's temporal-dead-zone note is about.
 */
const UNAVAILABLE = "app unavailable";

/**
 * The failure classes that CERTAINLY dispatched nothing — the whole of the exception to
 * the disclosure rule in `unavailable`, and the reason each is in it: "offline" (a tunnel
 * with no live socket: nothing was sent and the hub has no outbox), "catalog_unreachable"
 * (a cached-catalog read, which never reaches the app at all), "needs_reconnect" (a
 * stored credential the hub already knows is dead, so no dial is attempted),
 * "deadline_passed" (§23.10: the operation's own deadline had already elapsed, so it was
 * never sent — a LATER operation in the same execution may still dispatch), and
 * "execution_unavailable" (no QuickJS executor is installed, so no program ever started).
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
  "deadline_passed",
  "execution_unavailable",
]);

/**
 * -32000, and the ONE place the hub decides what a -32000 says. `failureClass` is the
 * dispatching layer's own name for what went wrong — "offline" / "timeout" /
 * "disconnected" for a tunnel, upstream.ts's five classes for a proxy — and does two
 * things: it rides `auditDetail` to the ledger, and it decides §15's at-most-once
 * disclosure through the table above. A class that certainly dispatched nothing keeps the
 * bare "app unavailable"; every other class appends ": the call may have executed".
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

/**
 * Why a -32001 was refused, as the LEDGER records it (§15, decision 37) — a closed
 * vocabulary of classes, never free text and never a name the caller typed beyond what the
 * row already holds in its own `app` and `tool` columns.
 *
 * The wire is unchanged and stays unchanged: §7 answers all nine with one
 * `{ code: -32001, message: "tool not permitted" }` and no `data`, so a probing agent can
 * still not map its grants, enumerate a namespace, or learn that an app is real. What makes
 * recording the cause safe is WHO reads the ledger: an `agent` principal reaches no audit
 * read at all (`admin.adminOpsFor` gives it the empty set) and every other audit surface
 * needs the owner's session or the owner's own admin token — so the oracle a refusal
 * withholds stays withheld from exactly the caller it was withheld from.
 *
 * - `no_app` — the addressed slug resolves to no app this caller can see. The scoped shape
 *   is the only one that addresses an app at all: §23.1 removed the aggregated
 *   `<slug>_<tool>` namespace, so an aggregate name reaches the hub's own two tools and is
 *   refused `no_grant` or `not_in_catalog` — never this.
 * - `app_changed` — §23.6: a program's pinned `expectAppId` no longer matches the slug.
 * - `no_grant` — the access filter answered `deny` (tools, prompts, resources, and the
 *   hub's own fixed list).
 * - `not_in_catalog` — the backend holds no catalog entry for the subject, the hub's own
 *   tools and declaration URIs included.
 * - `unsound_schema` — the tool is cached schema-unsound, so no redaction map can be
 *   derived and nothing may run (§7).
 * - `credential_lapsed` — §23.4: the credential was revoked, expired or rebound while the
 *   program that made this call was still running.
 * - `op_withheld` — `admin.adminOpsFor` does not admit this op to this kind of credential.
 * - `not_decidable` — approvals: there is no decidable request here for this caller.
 * - `wrong_endpoint` — the credential is not admitted at the endpoint it arrived on.
 */
export type RefusalReason =
  | "no_app"
  | "app_changed"
  | "no_grant"
  | "not_in_catalog"
  | "unsound_schema"
  | "credential_lapsed"
  | "op_withheld"
  | "not_decidable"
  | "wrong_endpoint";

/**
 * §7's -32001, and the one place a refusal's cause is attached to it. The reason is
 * REQUIRED so the compiler finds every call site and no future one can answer "not
 * permitted" without saying why — the state decision 37 exists to end. It rides
 * `auditDetail`, which `gateway.toWire` never serializes and `gateway.dispatchTool` merges
 * into the row's `detail`; `code` and `message` are the pinned ones and do not vary with
 * it, which is the whole of the indistinguishability §7 asks for.
 */
export const notPermitted = (reason: RefusalReason): HubError => {
  const err = new HubError(CODES.notPermitted, "tool not permitted");
  err.auditDetail = { reason };
  return err;
};

export const archived = (): HubError => new HubError(CODES.archived, "app archived");

/**
 * §7's -32601, spelled once: an unserved method and a served one the ADDRESSED shape does
 * not answer are the same refusal, so neither can be told from the other.
 *
 * Lives here rather than in the gateway because a BACKEND needs it too. The gateway routes
 * `tools/call`, `prompts/get` and `resources/read` through one `AppBackend.call`, so a
 * backend that serves only one of the three is the only place that knows the other two are
 * unserved — and it cannot say so in the hub's own words from a module that does not export
 * them (admin.adminBackend.call).
 */
export const methodNotFound = (): HubError => new HubError(CODES.methodNotFound, "method not found");

/**
 * -32602 as a CONSUMER meets it (§21.4): a `resources/subscribe` refused because the
 * socket's subscription set is full or the URI is over its byte cap. Payload-free like the
 * three above — the cap is not echoed (§21's open question pins `data` unset), and the
 * message says nothing a caller could not derive from its own request, so a refusal
 * carries no signal about the stream it aimed at.
 */
export const invalidParams = (): HubError => new HubError(CODES.invalidParams, "invalid params");
