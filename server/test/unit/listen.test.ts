// listen.test.ts — the §21 pure push core, as the D14 oracle rows pin it.
//
// PINS the Node-clean seams of capabilities.ts (the dispatch's group A constraint 4 —
// nothing in this file's import graph touches cloudflare:workers, so the `unit`
// project runs with NO Workers pool):
//
// - catalogChanged: the canonical-catalog comparator the DO's bell rings on (§21.3).
//   Absent and stored [] compare EQUAL, so a first registration writing [] into a
//   never-warmed family key is not a change; array order is significant and never
//   sorted for an app's list; entry-object property order is irrelevant because
//   the comparison delegates to canonicalJson, not JSON.stringify.
// - subscriberTag / parseSubscriberTag: the `sub:` tag is a CONSTRUCTION rule (§21.2)
//   — the prefix is the sole class separator, since app ids are themselves UUIDs;
//   a bare id parses as no subscriber tag at all, and the builder/parser round-trip.
// - admits(): the Worker-side endpoint-shape filter (§21.2/§21.3) — aggregated
//   forwards tools and prompts bells ONLY; scoped forwards all three bells plus
//   notifications/resources/updated; every other method is dropped on both.
// - familyBell: the family→bell map (§21.3/§6) — BOTH resource catalogs (the list and
//   the templates) ring the one notifications/resources/list_changed; tools and
//   prompts ring their own; completions rings no bell at all.
// - bellFrame: the method-only JSON-RPC notification (§21.3) — no params, no names,
//   no counts, no id, for each of the three list_changed methods.
// - The subscription-set seam (§21.4): SUBSCRIBE_URI_MAX_BYTES measured in UTF-8
//   BYTES — a multi-byte URI at the boundary is refused where its char count would
//   pass — and the LISTEN_SUBSCRIPTIONS_MAX off-by-one pinned at the pure boundary
//   (the MAX-th URI accepted, the one after refused).
// - LISTEN_FANOUT_MAX: an integer in [1, 6] (§21.2) — the platform's documented
//   ceiling is a hard upper bound the gate's live measurement can only lower.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. deps line `none`: no D1, no
// DO, no crypto; every case is one pure call over plain values. All five limits come
// from limits.ts by name, never as literals (strategy §7: a cap moving is a one-line
// limits.ts edit with zero row churn).
//
// NOT HERE: that the DO rings on a catalogChanged verdict (tunnel/push.test.ts),
// that the wrong socket is never selected by class (tunnel/push.test.ts), how the
// Worker applies admits() to a live stream (worker/listen.test.ts), and that a socket
// really held LISTEN_SUBSCRIPTIONS_MAX attachments inside serializeAttachment's 16 KB
// (tunnel/subscriptions.test.ts).

import { describe, expect, it } from "vitest";
import {
  BELL_PROMPTS,
  BELL_RESOURCES,
  BELL_TOOLS,
  RESOURCES_UPDATED,
  admits,
  bellFrame,
  catalogChanged,
  familyBell,
  parseSubscriberTag,
  subscribeAllowed,
  subscriberTag,
  uriByteLength,
} from "../../src/capabilities";
import { LISTEN_FANOUT_MAX, LISTEN_SUBSCRIPTIONS_MAX, SUBSCRIBE_URI_MAX_BYTES } from "../../src/limits";

describe("§21.3 · catalogChanged — the canonical-catalog comparator", () => {
  it("§21.3 · absent and a stored [] compare EQUAL — the first registration's write into a never-warmed family key is not a change", () => {
    // DO storage.get returns undefined for a never-warmed family key; the write of an
    // empty catalog answers the same empty list the absent key already serves (§20.5).
    expect(catalogChanged(undefined, [])).toBe(false);
  });

  it("§21.3 · emptying a NON-empty catalog compares as changed — the undeclare that clears a served family (the twin of absent ≡ [])", () => {
    expect(catalogChanged([{ name: "get_news" }], [])).toBe(true);
  });

  it("§21.3 · the comparison delegates to canonicalJson — two catalogs whose entry objects carry the same properties in different insertion order compare EQUAL, where a JSON.stringify comparator would ring", () => {
    const oneOrder = [{ name: "get_news", description: "the news" }];
    const otherOrder = [{ description: "the news", name: "get_news" }];
    // The witness that this row is about canonicalJson and not about string luck.
    expect(JSON.stringify(oneOrder)).not.toBe(JSON.stringify(otherOrder));
    expect(catalogChanged(oneOrder, otherOrder)).toBe(false);
    expect(catalogChanged(otherOrder, oneOrder)).toBe(false);
  });

  it("§21.3 · a real change is detected — an entry whose description differs, and an entry appended to a non-empty catalog, each compare as changed · the same entries in a different ARRAY order also compare as changed (the canonicalizer preserves array order, and the hub does not sort an app's list)", () => {
    const base = [{ name: "get_news", description: "the news" }];
    const second = { name: "search_docs", description: "docs" };

    expect(catalogChanged(base, [{ name: "get_news", description: "the NEWS" }])).toBe(true);
    expect(catalogChanged(base, [...base, second])).toBe(true);

    // The canonicalizer keeps array order — the hub does not sort an app's list —
    // so the same entries in a different order are a change, not an equality.
    expect(catalogChanged([...base, second], [second, ...base])).toBe(true);
  });
});

describe("§21.2 · the sub: tag builder/parser — the class invariant", () => {
  it("§21.2 · the sub: tag is a construction rule — built by prefixing, and a bare app id parses as no subscriber tag at all, while a sub:-tagged UUID parses back to the id it was built from", () => {
    const appId = "d0f5c9e2-4b7a-4370-9c8d-1a2b3c4d5e6f";

    expect(subscriberTag(appId)).toBe(`sub:${appId}`);

    // A bare app id is not a subscriber tag: getWebSockets(app.id) can never
    // return a subscriber socket, because a prefixed tag never equals a bare id.
    expect(parseSubscriberTag(appId)).toBeNull();

    // The round trip: a sub:-tagged UUID parses back to the id it was built from.
    expect(parseSubscriberTag(subscriberTag(appId))).toBe(appId);
  });
});

describe("§21.2/§21.3 · admits() — the Worker-side shape filter", () => {
  it("§21.2/§21.3 · admits() is the Worker-side shape filter — the aggregated shape forwards tools and prompts bells ONLY, and the scoped shape forwards all three bells plus notifications/resources/updated; every other method is dropped on both", () => {
    // The aggregated shape: tools and prompts bells only.
    expect(admits(BELL_TOOLS, "aggregated")).toBe(true);
    expect(admits(BELL_PROMPTS, "aggregated")).toBe(true);
    expect(admits(BELL_RESOURCES, "aggregated")).toBe(false);
    expect(admits(RESOURCES_UPDATED, "aggregated")).toBe(false);

    // The scoped shape: all three bells plus resources/updated.
    expect(admits(BELL_TOOLS, "scoped")).toBe(true);
    expect(admits(BELL_PROMPTS, "scoped")).toBe(true);
    expect(admits(BELL_RESOURCES, "scoped")).toBe(true);
    expect(admits(RESOURCES_UPDATED, "scoped")).toBe(true);

    // Everything else — the rest of the method table, app-originated frames
    // included — is dropped on both shapes.
    const dropped = [
      "tools/list",
      "tools/call",
      "prompts/list",
      "prompts/get",
      "resources/list",
      "resources/read",
      "resources/subscribe",
      "resources/unsubscribe",
      "completion/complete",
      "server/discover",
      "logging/setLevel",
      "notifications/logging/message",
    ];
    for (const method of dropped) {
      expect(admits(method, "aggregated"), `aggregated drops ${method}`).toBe(false);
      expect(admits(method, "scoped"), `scoped drops ${method}`).toBe(false);
    }
  });
});

describe("§21.3/§6 · familyBell — the family→bell map", () => {
  it("§21.3/§6 · the family→bell map sends BOTH resource catalogs — the resource list and the templates list — to the one notifications/resources/list_changed, tools and prompts to their own, and completions to no bell at all", () => {
    expect(familyBell("tools")).toBe(BELL_TOOLS);
    expect(familyBell("prompts")).toBe(BELL_PROMPTS);
    expect(familyBell("resources")).toBe(BELL_RESOURCES);
    expect(familyBell("resourceTemplates")).toBe(BELL_RESOURCES);
    expect(familyBell("completions")).toBeNull();
  });
});

describe("§21.3 · bellFrame — the method-only notification", () => {
  it("§21.3 · the bell frame builder emits a JSON-RPC notification carrying its method and NOTHING else — no params, no names, no counts — for each of the three list_changed methods", () => {
    for (const method of [BELL_TOOLS, BELL_PROMPTS, BELL_RESOURCES]) {
      const frame = bellFrame(method);
      expect(frame).toEqual({ jsonrpc: "2.0", method });
      expect(Object.keys(frame).sort()).toEqual(["jsonrpc", "method"]);
      expect("params" in frame).toBe(false);
      expect("id" in frame).toBe(false);
    }
  });
});

describe("§21.4 · the subscription-set seam — both caps at the pure boundary", () => {
  it("§21.4 · SUBSCRIBE_URI_MAX_BYTES is measured in UTF-8 BYTES, not JS string length — a multi-byte URI at the boundary is refused where its char count would pass (the AUDIT_URI_CAP_BYTES discipline)", () => {
    // One multi-byte char is 4 UTF-8 bytes; enough of them to cross the byte cap
    // while the CHAR count stays under it — the case a string-length check would let
    // through.
    const multiByte = "😀".repeat(Math.ceil(SUBSCRIBE_URI_MAX_BYTES / 4) + 1);
    expect(multiByte.length).toBeLessThan(SUBSCRIBE_URI_MAX_BYTES);
    expect(uriByteLength(multiByte)).toBeGreaterThan(SUBSCRIBE_URI_MAX_BYTES);
    expect(subscribeAllowed(0, multiByte)).toBe(false);

    // The boundary itself: exactly at the cap in bytes is accepted, one byte over refused.
    const atCap = "a".repeat(SUBSCRIBE_URI_MAX_BYTES);
    expect(subscribeAllowed(0, atCap)).toBe(true);
    expect(subscribeAllowed(0, `${atCap}a`)).toBe(false);
  });

  it("§21.4 · the subscription-set seam accepts the LISTEN_SUBSCRIPTIONS_MAX-th URI and refuses the one after it — the off-by-one pinned at the pure boundary", () => {
    const uri = "file:///notes.txt";
    // currentCount runs 0..MAX-1 for the 1st..MAX-th accepted URI.
    for (let count = 0; count < LISTEN_SUBSCRIPTIONS_MAX; count++) {
      expect(subscribeAllowed(count, uri), `the ${count + 1}-th URI must be accepted`).toBe(true);
    }
    // A socket already holding MAX URIs refuses the MAX+1-th.
    expect(subscribeAllowed(LISTEN_SUBSCRIPTIONS_MAX, uri)).toBe(false);
  });
});

describe("§21.2 · LISTEN_FANOUT_MAX", () => {
  it("§21.2 · LISTEN_FANOUT_MAX is an integer in [1, 6] — the platform's documented per-invocation connection ceiling is a hard upper bound the probe measurement can only lower", () => {
    expect(Number.isInteger(LISTEN_FANOUT_MAX)).toBe(true);
    expect(LISTEN_FANOUT_MAX).toBeGreaterThanOrEqual(1);
    expect(LISTEN_FANOUT_MAX).toBeLessThanOrEqual(6);
  });
});