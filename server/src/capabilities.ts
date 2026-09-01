// capabilities.ts — the §21 push core, extracted as the repo's Node-clean pure seams.
//
// PINS the D14 dispatch's pure contracts, each in the shape the suites and the
// contracts producers consume:
//
// - catalogChanged — the canonical-catalog comparator the DO's bell rings on (§21.3):
//   absent and stored [] compare EQUAL (a first registration writing [] into a
//   never-warmed family key is not a change), array order is SIGNIFICANT, and entry
//   objects are compared by canonicalJson, so insertion-order differences inside an
//   entry never ring where a JSON.stringify comparator would.
// - capabilityShape — the KIND-AWARE capability shape for both handshakes (§21.5):
//   kind is "tunnel" | "proxy" | "builtin", and the stored capability set gates only
//   WHICH families appear — this is the kind-fallback an is-not-proxy implementation
//   gets wrong. Resolves over SERVICE_CAPABILITIES order, never the stored set's own
//   (arbitrary for an owner-declared list), so the emitted object's key order is the
//   canonical order the contracts fixtures pin byte-for-byte. AGGREGATED_CAPABILITIES
//   is the §20.2/§21.5 constant this function renders.
// - subscriberTag / parseSubscriberTag — the `sub:` prefix is the class invariant
//   (§21.2): a getWebSockets(service.id) lookup can never return a subscriber socket,
//   because a prefixed tag never equals a bare id. The prefix is the sole separator —
//   service ids are themselves UUIDs, so nothing about an id's shape can carry it.
// - admits — the Worker-side endpoint-shape filter (§21.2): the aggregated shape
//   forwards tools and prompts bells ONLY; the scoped shape forwards all three bells
//   plus notifications/resources/updated. Everything else is dropped on both.
// - familyBell — the family→bell map (§21.3/§6): BOTH resource catalogs — the list
//   and the templates — ring the one notifications/resources/list_changed; tools and
//   prompts ring their own; completions rings NO bell.
// - bellFrame — the method-only JSON-RPC notification (§21.3): no params, no names,
//   no counts, no id.
// - subscribeAllowed / uriByteLength — the subscription-set seam (§21.4): the URI cap
//   is measured in UTF-8 BYTES (the AUDIT_URI_CAP_BYTES discipline), and the count cap
//   is LISTEN_SUBSCRIPTIONS_MAX with the off-by-one pinned at this pure boundary.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. deps line: `none` in the test
// sense — no D1, no DO, no workerd binding. The one transitive import of note is
// approvals.canonicalJson, already loadable outside workerd (unit/canonical.test.ts);
// this module MUST never import gateway, admin, or tunnel — each drags
// `cloudflare:workers` in through admin.ts, which would kill the unit project's pool
// (constraint 4).
//
// NOT HERE: where a comparison result is used (tunnel.ts's bell — group B), how the
// shape reaches the wire (initialize/server/discover answer from it; gateway.ts
// re-exports — group C), who builds or parses socket tags in the DO (group B), or how
// subscriptions attach to sockets (the DO's socket attachment — group B). This file
// owns the pure verdicts alone.

import { canonicalJson } from "./approvals";
import { SERVICE_CAPABILITIES } from "./registry";
import type { ServiceCapability } from "./registry";
import { LISTEN_SUBSCRIPTIONS_MAX, SUBSCRIBE_URI_MAX_BYTES } from "./limits";

/**
 * §21.3 — the canonical-catalog comparator: does WARMING a family change the hub's
 * stored catalog? The DO reads before it writes, and the comparison is over
 * canonicalJson serializations because DO storage round-trips structured clones, not
 * bytes. `stored` is the pre-write value — undefined when the family key was never
 * warmed — and absent ≡ stored [] (both already answer the same empty list, §20.5),
 * so a first registration writing [] rings nothing and the undeclare that rings is
 * the one that emptied a NON-empty catalog.
 */
export function catalogChanged(stored: unknown, next: unknown): boolean {
  return canonicalJson(stored ?? []) !== canonicalJson(next ?? []);
}

/** §21.5 — the one axis a service's push posture flips on: kind, not stored set. */
export type CapabilityKind = "tunnel" | "proxy" | "builtin";

/** §21.5/§20.2 — the family set an undeclared, never-connected, or unresolvable service is read as: tools only. */
export const DEFAULT_SERVICE_CAPABILITIES: readonly ServiceCapability[] = ["tools"];

/**
 * §21.5 — the kind-aware capability shape for BOTH handshakes (`initialize` and
 * `server/discover`). `stored` decides only which families appear; the kind decides
 * every flag: "tunnel" rings (listChanged true, resources gains subscribe: true),
 * "proxy" and "builtin" keep every push flag false and subscribe absent — proxy has
 * no channel to ring from (§21.2), the builtin has no DO to ring at all. Families
 * render in canonical SERVICE_CAPABILITIES order and completions renders as the empty
 * object, because no completions bell exists.
 */
export function capabilityShape(
  stored: readonly ServiceCapability[],
  kind: CapabilityKind,
): Record<string, Record<string, boolean>> {
  const result: Record<string, Record<string, boolean>> = {};
  for (const family of SERVICE_CAPABILITIES) {
    if (!stored.includes(family)) continue;
    if (family === "completions") {
      result[family] = {};
      continue;
    }
    const push = kind === "tunnel";
    result[family] = { listChanged: push };
    if (family === "resources" && push) result[family].subscribe = true;
  }
  return result;
}

/**
 * §20.2/§21.5 — the aggregated endpoint's one static answer: tools and prompts, both
 * listChanged true, no resources, no completions, no subscribe. Still one fixed
 * result whatever the namespace holds, and still the byte-for-byte fixture — it flips
 * shapes with the transport in the same deploy. Rendered from the shape function so
 * the two handshakes cannot describe a family differently.
 */
export const AGGREGATED_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, boolean>>>> =
  capabilityShape(["tools", "prompts"], "tunnel");

/** §21.2 — the class invariant's prefix: a socket tagged `sub:<session-id>` is a subscriber
 *  socket; a bare id is the service socket. NOT exported: the builder and the parser below
 *  are the whole interface, so no caller can spell the prefix a second way. */
const SUBSCRIBER_TAG_PREFIX = "sub:";

/** §21.2 — builds a subscriber socket's tag from the stream's minted session id. */
export function subscriberTag(sessionId: string): string {
  return `${SUBSCRIBER_TAG_PREFIX}${sessionId}`;
}

/**
 * §21.2 — the tag parser: a `sub:`-prefixed tag parses back to the session id it was
 * built from; anything else — a bare service id in particular — is no subscriber tag
 * at all (returns null).
 */
export function parseSubscriberTag(tag: string): string | null {
  return tag.startsWith(SUBSCRIBER_TAG_PREFIX) ? tag.slice(SUBSCRIBER_TAG_PREFIX.length) : null;
}

/**
 * The three consumer-facing catalog bells (§21.3) and the one per-URI routing frame
 * (§21.4). Named once here so the family map, the ring path, and the frame builder
 * cannot disagree about a wire method.
 */
export const BELL_TOOLS = "notifications/tools/list_changed";
export const BELL_PROMPTS = "notifications/prompts/list_changed";
export const BELL_RESOURCES = "notifications/resources/list_changed";
export const RESOURCES_UPDATED = "notifications/resources/updated";

/** §21.2 — the endpoint shape an open listen stream was minted for. */
export type EndpointShape = "aggregated" | "scoped";

/**
 * §21.2 — the Worker-side admission filter over frames the DO rang at a subscriber
 * socket. The DO rings every subscriber socket it holds and knows no shapes; the
 * invocation knows its own endpoint shape and forwards only what serves it: tools and
 * prompts bells on an aggregated stream; all three bells plus resources/updated on a
 * scoped one. Every other method is dropped on both.
 */
export function admits(method: string, endpoint: EndpointShape): boolean {
  if (endpoint === "aggregated") {
    return method === BELL_TOOLS || method === BELL_PROMPTS;
  }
  return (
    method === BELL_TOOLS ||
    method === BELL_PROMPTS ||
    method === BELL_RESOURCES ||
    method === RESOURCES_UPDATED
  );
}

/**
 * §21.3/§6 — the family→bell map: which bell a warm of which catalog family rings.
 * The two resource catalogs — the resource list and the templates list — both ring
 * the one notifications/resources/list_changed (MCP defines no templates frame);
 * tools and prompts ring their own; completions has no catalog and rings no bell.
 * Unknown families ring nothing rather than throwing.
 */
export function familyBell(family: string): string | null {
  switch (family) {
    case "tools":
      return BELL_TOOLS;
    case "prompts":
      return BELL_PROMPTS;
    case "resources":
    case "resourceTemplates":
      return BELL_RESOURCES;
    default:
      return null;
  }
}

/** §21.3 — the consumer-facing bell frame: a JSON-RPC notification carrying its method and
 *  NOTHING else. Names `bellFrame`'s result; no caller needs to spell the type. */
type BellFrame = { jsonrpc: "2.0"; method: string };

/** §21.3 — builds the method-only notification. No params, no names, no counts, no id. */
export function bellFrame(method: string): BellFrame {
  return { jsonrpc: "2.0", method };
}

/** §21.4 — a subscribed URI's size in UTF-8 bytes, the same discipline AUDIT_URI_CAP_BYTES applies (§20.4). */
export function uriByteLength(uri: string): number {
  return new TextEncoder().encode(uri).byteLength;
}

/**
 * §21.4 — the subscription-set seam: may a socket holding `currentCount` URIs accept
 * `uri`? Both caps bind, and both off-by-ones are pinned at this pure boundary: the
 * LISTEN_SUBSCRIPTIONS_MAX-th URI is accepted (currentCount < MAX), the one after it
 * refused; the URI is measured in UTF-8 BYTES, so a multi-byte URI at the byte
 * boundary is refused where its char count would pass.
 */
export function subscribeAllowed(currentCount: number, uri: string): boolean {
  return currentCount < LISTEN_SUBSCRIPTIONS_MAX && uriByteLength(uri) <= SUBSCRIBE_URI_MAX_BYTES;
}