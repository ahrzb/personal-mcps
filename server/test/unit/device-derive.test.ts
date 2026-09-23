// `/device` as pure rules (decision 38, family 3): which moment the URL asks for, and when the
// page may call the read that CLAIMS a code — over `web/src/features/device/derive.ts`,
// reachable from plain Node for `audit-derive.test.ts`'s reason.
//
// The server half — the read's five facts, its 404, the decide's `next` — is pinned at
// `/api/hub/device*` by the worker suite; this file pins that the client only ever sends a
// present, non-empty code, and never on a decided landing (routes design §3).

import { describe, expect, it } from "vitest";
import { deviceViewOf, relativeTime } from "../../../web/src/features/device/derive.ts";

const NOW = Date.parse("2026-08-24T14:47:00.000Z");

describe("the URL's moment (model.ts's deviceStep, its URL half)", () => {
  it("a decided landing wins over everything and verifies nothing", () => {
    expect(deviceViewOf({ decided: "approved", user_code: "BDWJ-KTQP" })).toEqual({
      kind: "decided",
      decision: "approved",
    });
    expect(deviceViewOf({ decided: "denied" })).toEqual({ kind: "decided", decision: "denied" });
  });

  it("only a present, non-empty user_code is sent to be verified", () => {
    expect(deviceViewOf({ user_code: "BDWJ-KTQP" })).toEqual({ kind: "verify", userCode: "BDWJ-KTQP" });
    expect(deviceViewOf({ user_code: "" })).toEqual({ kind: "enter-code", error: null });
    expect(deviceViewOf({})).toEqual({ kind: "enter-code", error: null });
  });

  it("?error= is carried as display text onto the empty card; an unknown decided is no verdict", () => {
    expect(deviceViewOf({ error: "<img src=x onerror=alert(1)>" })).toEqual({
      kind: "enter-code",
      error: "<img src=x onerror=alert(1)>",
    });
    expect(deviceViewOf({ decided: "maybe" })).toEqual({ kind: "enter-code", error: null });
  });
});

describe("the Requested row", () => {
  it("reads just now, then minutes, then hours", () => {
    expect(relativeTime("2026-08-24T14:46:56.000Z", NOW)).toBe("Just now");
    expect(relativeTime("2026-08-24T14:46:00.000Z", NOW)).toBe("1 min ago");
    expect(relativeTime("2026-08-24T14:30:00.000Z", NOW)).toBe("17 mins ago");
    expect(relativeTime("2026-08-24T12:47:00.000Z", NOW)).toBe("2 hours ago");
  });
});
