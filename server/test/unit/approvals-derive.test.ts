// `/approvals` and `/approvals/<id>` as pure rules (decision 38, family 1): what a row SAYS,
// what the history section holds, and where a decision lands — the web half of the rows the
// routes design assigns to the client, over `web/src/features/approvals/derive.ts` and
// `web/src/lib/notice.ts`, both reachable from plain Node for `audit-derive.test.ts`'s reason.
//
// The server half — `approval_decide` answering 200 then 422 with the op's one message — is
// pinned at `/api/hub/ops` by the worker suite; this file pins what the owner then READS.

import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  decisionLanding,
  detailBadge,
  detailStamp,
  explanation,
  formatArgs,
  historyLimitOf,
  historyOf,
  historyOutcome,
  historyReadLimit,
  listStamp,
  minutesUntil,
  relative,
  timeRows,
} from "../../../web/src/features/approvals/derive.ts";
import { noticeOf } from "../../../web/src/lib/notice.ts";
import type { ApprovalRow } from "../../../web/src/lib/types.ts";

/** The instant the gallery renders at — the retired server states preview's own, kept so a state reads the same. */
const NOW = Date.parse("2026-08-24T14:47:00.000Z");

const row = (over: Partial<ApprovalRow>): ApprovalRow => ({
  id: "apr_8f2k",
  agentSlug: "claude",
  appSlug: "home",
  tool: "set_scene",
  args: { scene: "movie_night" },
  status: "pending",
  createdAt: "2026-08-24T14:29:55.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:29:55.000Z",
  ...over,
});

describe("a decision's landing (G52: the 303 either page made, now a client navigation)", () => {
  it("a lost race lands as the warning, whatever words the op refused with", () => {
    const landing = decisionLanding({ ok: false, reason: "no decidable approval request" });
    expect(landing).toEqual({ failed: "approval_decide", reason: "no decidable approval request" });
    // Not a failure of the owner's: warning tone, no "failed" title, and the op's own
    // wording never reaches the screen — every lost race reads the same sentence.
    expect(noticeOf(new URLSearchParams(landing))).toEqual({
      tone: "warning",
      message: "That request is no longer pending.",
    });
  });

  it("a decision that went through lands as the op's done line", () => {
    const landing = decisionLanding({ ok: true });
    expect(landing).toEqual({ done: "approval_decide" });
    expect(noticeOf(new URLSearchParams(landing))).toEqual({ tone: "success", message: "Approval decide done." });
  });

  it("an empty refusal carries no reason key, as noticeUrl left it off", () => {
    expect(decisionLanding({ ok: false, reason: "" })).toEqual({ failed: "approval_decide" });
  });

  it("any OTHER op's failure stays a titled danger — the warning is keyed on the op, not the prose", () => {
    expect(noticeOf(new URLSearchParams({ failed: "token_revoke", reason: "That request is no longer pending." }))).toEqual({
      tone: "danger",
      title: "Token revoke failed",
      message: "That request is no longer pending.",
    });
  });
});

describe("the history section (the server page's approvalsProps, now the client's)", () => {
  it("?limit= is model.ts's positive(): a whole number ≥ 0, else the default", () => {
    expect(historyLimitOf(undefined)).toBe(HISTORY_LIMIT);
    expect(HISTORY_LIMIT).toBe(20);
    expect(historyLimitOf("50")).toBe(50);
    expect(historyLimitOf("0")).toBe(0);
    for (const junk of ["", " ", "abc", "2.5", "-1"]) expect(historyLimitOf(junk)).toBe(HISTORY_LIMIT);
  });

  it("the read pays for the pending rows and one more, to know whether Older → is worth drawing", () => {
    expect(historyReadLimit(20, 2)).toBe(23);
    expect(historyReadLimit(20, 0)).toBe(21);
  });

  it("drops pending rows, keeps the listing's order, caps, and says whether more exist", () => {
    const listed = [
      row({ id: "p1" }),
      row({ id: "a", status: "approved" }),
      row({ id: "b", status: "rejected", decidedAt: "2026-08-24T14:00:00.000Z" }),
      row({ id: "c", status: "expired" }),
    ];
    expect(historyOf(listed, 2)).toEqual({ history: [listed[1], listed[2]], hasMore: true });
    expect(historyOf(listed, 3).hasMore).toBe(false);
  });

  it("history outcomes: executed for a spent pass, danger only for rejected, expired stays amber", () => {
    expect(historyOutcome("used")).toEqual({ label: "executed", tone: "success" });
    expect(historyOutcome("rejected")).toEqual({ label: "rejected", tone: "danger" });
    expect(historyOutcome("approved")).toEqual({ label: "approved", tone: "warning" });
    expect(historyOutcome("expired")).toEqual({ label: "expired", tone: "warning" });
  });
});

describe("the spellings, each as its own server page wrote it", () => {
  it("the list leaves the day unpadded, the detail pads it", () => {
    expect(listStamp("2026-08-03T09:05:01.000Z")).toBe("Aug 3 09:05:01");
    expect(detailStamp("2026-08-03T09:05:01.000Z")).toBe("Aug 03 09:05:01");
  });

  it("expires in N min counts to the nearest minute and never goes negative", () => {
    expect(minutesUntil(NOW, "2026-08-24T15:29:55.000Z")).toBe(43);
    expect(minutesUntil(NOW, "2026-08-24T14:00:00.000Z")).toBe(0);
  });

  it("relative times scale from minutes to hours to days, both directions", () => {
    expect(relative("2026-08-24T14:29:55.000Z", NOW)).toBe("17 minutes ago");
    expect(relative("2026-08-24T15:29:55.000Z", NOW)).toBe("in 43 minutes");
    expect(relative("2026-08-24T14:46:50.000Z", NOW)).toBe("under a minute ago");
    expect(relative("2026-08-24T12:47:00.000Z", NOW)).toBe("2 hours ago");
    expect(relative("2026-08-22T14:47:00.000Z", NOW)).toBe("2 days ago");
    expect(relative("2026-08-24T14:48:00.000Z", NOW)).toBe("in 1 minute");
  });

  it("arguments on the detail are one spaced line, nested and all", () => {
    expect(formatArgs({ scene: "movie_night" })).toBe('{ "scene": "movie_night" }');
    expect(formatArgs({ a: [1, { b: null }], c: {}, d: [] })).toBe('{ "a": [ 1, { "b": null } ], "c": {}, "d": [] }');
  });
});

describe("the detail card, by status (as the server's detail page drew it)", () => {
  it("a live request counts down; a terminal one is a fixed record", () => {
    expect(timeRows({ ...row({}), status: "pending" }, NOW)).toEqual([
      { label: "Requested", value: "17 minutes ago · Aug 24 14:29:55" },
      { label: "Expires", value: "in 43 minutes · Aug 24 15:29:55" },
    ]);
    expect(
      timeRows({ ...row({ expiresAt: "2026-08-24T14:29:55.000Z" }), status: "expired" }, NOW).map((each) => each.label),
    ).toEqual(["Requested", "Expired"]);
    expect(timeRows({ ...row({}), status: "used", decidedAt: "2026-08-24T14:45:37.000Z" }, NOW)).toEqual([
      { label: "Requested", value: "Aug 24 14:29:55" },
      { label: "Decided", value: "Aug 24 14:45:37" },
    ]);
  });

  it("a lone expired request reads muted, where the history table keeps it amber", () => {
    expect(detailBadge("expired")).toEqual({ label: "expired", tone: "muted" });
    expect(detailBadge("pending")).toEqual({ label: "pending", tone: "warning" });
    expect(detailBadge("used")).toEqual({ label: "executed", tone: "success" });
  });

  it("an approved pass names when it lapses", () => {
    expect(explanation(row({ status: "approved" }))).toBe(
      "Approved — the agent can run this exact call once when it retries. Expires Aug 24 15:29:55.",
    );
  });
});
