// capabilities.test.ts — the kind-aware capability shape, as the D14 oracle rows pin it.
//
// PINS §21.5's capability picture, whole-object deep equality on every row: the shape
// is a function of the app's KIND — "tunnel" | "proxy" | "builtin" — and of the
// stored capability set only in WHICH families appear. Proxied apps keep every
// push flag false whatever their owner-declared list says (§21.2: no channel to ring
// from), and so does the pmcp builtin (§21.2: no DO to ring at all); the kind-fallback
// an is-not-proxy implementation gets wrong is the builtin reading as "tunnel".
// Completions shapes as the empty object on every kind — only the three bell-ringing
// families carry a listChanged flag, because no completions bell exists. And the
// aggregated constant is pinned here as well as in the fixtures (§20.2/§21.5): tools
// and prompts both {listChanged: true}, no resources, no completions, no subscribe.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. deps line `none`: no D1, no
// DO, no crypto; the single transitive import outside this module is
// approvals.canonicalJson, already loadable outside workerd (canonical.test.ts), and
// the module under test must never touch gateway/admin/tunnel (constraint 4).
//
// NOT HERE: that initialize.json pinning the picture byte-for-byte (worker/
// contracts.test.ts), that server/discover answers from the same picture (§20.2's
// one-source-two-spellings — worker/listen.test.ts), and that the DO's real stored
// capability set for a registered app feeds `stored` (tunnel/push.test.ts). This
// file pins the pure function's verdict over every kind.

import { describe, expect, it } from "vitest";
import {
  AGGREGATED_CAPABILITIES,
  DEFAULT_APP_CAPABILITIES,
  capabilityShape,
  type CapabilityKind,
} from "../../src/capabilities";
import type { AppCapability } from "../../src/registry";

describe("§21.5 · capabilityShape — the kind-aware capability picture", () => {
  it("§21.5 · shape([\"tools\",\"resources\"], \"tunnel\") deep-equals {tools: {listChanged: true}, resources: {listChanged: true, subscribe: true}} — no subscribe key on a non-resources family, no family the stored set lacks", () => {
    const stored: AppCapability[] = ["tools", "resources"];
    expect(capabilityShape(stored, "tunnel")).toEqual({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    });

    // Key order is the wire order the fixtures pin byte-for-byte: families render in
    // canonical APP_CAPABILITIES order (never the stored set's own, which is
    // arbitrary for an owner-declared list), and listChanged before subscribe inside
    // resources. A stored set spelling the families in reverse order must still
    // render tools first.
    expect(Object.keys(capabilityShape(["resources", "tools"] as AppCapability[], "tunnel"))).toEqual([
      "tools",
      "resources",
    ]);
    expect(Object.keys(capabilityShape(stored, "tunnel").resources)).toEqual(["listChanged", "subscribe"]);
  });

  it("§21.5 · the same stored set on kind \"proxy\" deep-equals {tools: {listChanged: false}, resources: {listChanged: false}} — every push flag false, subscribe absent (the twin)", () => {
    const stored: AppCapability[] = ["tools", "resources"];
    expect(capabilityShape(stored, "proxy")).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
  });

  it("§21.5 · shape(DEFAULT_APP_CAPABILITIES, \"tunnel\") deep-equals {tools: {listChanged: true}} — the never-connected app's answer, and the unresolvable slug's identical one (§20.2's anti-enumeration)", () => {
    expect(capabilityShape(DEFAULT_APP_CAPABILITIES, "tunnel")).toEqual({
      tools: { listChanged: true },
    });
  });

  it("§21.5 · kind \"builtin\" forces every push flag false on the same default set — {tools: {listChanged: false}} — the kind-fallback an is-not-proxy implementation gets wrong", () => {
    expect(capabilityShape(DEFAULT_APP_CAPABILITIES, "builtin")).toEqual({
      tools: { listChanged: false },
    });
  });

  it("§21.3/§21.5 · a stored completions shapes as the empty object on every kind — only the three bell-ringing families carry a listChanged flag, because no completions bell exists", () => {
    const stored: AppCapability[] = ["completions"];
    const kinds: CapabilityKind[] = ["tunnel", "proxy", "builtin"];
    for (const kind of kinds) {
      expect(capabilityShape(stored, kind), `kind "${kind}"`).toEqual({ completions: {} });
    }
  });

  it("§21.5/§20.2 · the aggregated constant is tools and prompts both {listChanged: true}, no resources, no completions, no subscribe — pinned here so the fixture regeneration is not the only guard", () => {
    expect(AGGREGATED_CAPABILITIES).toEqual({
      tools: { listChanged: true },
      prompts: { listChanged: true },
    });
    // The same APP_CAPABILITIES order the scoped pictures render in, so the
    // fixture emission cannot reorder it.
    expect(Object.keys(AGGREGATED_CAPABILITIES)).toEqual(["tools", "prompts"]);
  });
});