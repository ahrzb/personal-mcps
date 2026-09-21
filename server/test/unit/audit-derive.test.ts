// The audit explorer as a pure table (§13 decision 36, strategy §3): every reading `/audit`
// makes of one row set, with no React, no DOM and no clock of its own.
//
// The ONE `unit` file over `web/` source. That is what `derive.ts`'s "no React, no `@/`
// runtime imports" buys, and it is the reason this file may exist at all: the module is
// reachable from a plain-Node program, so the rules that decide what a row SAYS are pinned
// here rather than through a browser.
//
// Written before the module it pins.

import { describe, expect, it } from "vitest";
import {
  NO_BODIES_SENTENCE,
  ceilingNotice,
  changesOf,
  chainWords,
  exportHref,
  facetGroups,
  insightsOf,
  lanesOf,
  matchesFilters,
  mergeEvents,
  outcomeClass,
  outcomeCodes,
  selectionOf,
  sessionsOf,
  stubLabel,
  summaryOf,
  titleOf,
  titleOfMerged,
  treeSearch,
  waterfallOf,
  windowPagePath,
} from "../../../web/src/features/audit/derive.ts";
import type { AuditSelection } from "../../../web/src/features/audit/derive.ts";
import type { AuditWindowRow } from "../../../web/src/lib/types.ts";

/** The instant the fixture week ends on — `web/src/preview/clock.ts`'s `FROZEN_NOW`, so a row
 *  built here and a row built for the gallery sit at the same place in the same window. */
const NOW = Date.parse("2026-08-24T14:47:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK_START = NOW - 7 * DAY;

/** One row, with only what the case under test reads spelled out. `id` doubles as the
 *  tiebreaker the chain order is pinned on, so it is always given. */
function row(over: Partial<AuditWindowRow> & { id: number }): AuditWindowRow {
  return {
    ts: NOW - HOUR,
    principal: "agent:claude",
    event: "tools/call",
    outcome: "ok",
    hasResult: false,
    ...over,
  };
}

/** The whole loaded window, unbrushed and unfiltered — what every case starts from. */
const WINDOW = { start: WEEK_START, end: NOW };
const bare = (over: Partial<AuditSelection> = {}): AuditSelection => ({
  ...selectionOf({}, WINDOW),
  ...over,
});

describe("outcome classes", () => {
  it("folds the six recorded outcomes into five classes, denied taking two codes", () => {
    expect(outcomeClass("ok")).toBe("ok");
    expect(outcomeClass("-32003")).toBe("approval");
    expect(outcomeClass("-32002")).toBe("archived");
    expect(outcomeClass("-32001")).toBe("denied");
    expect(outcomeClass("-32000")).toBe("denied");
    expect(outcomeClass("error")).toBe("error");
  });

  it("reads an outcome it has never seen as error rather than throwing", () => {
    // A recorded value the page does not know is still a row somebody has to look at.
    expect(outcomeClass("-31999")).toBe("error");
  });

  it("expands a class back to the raw codes the export filter takes", () => {
    expect(outcomeCodes("denied")).toEqual(["-32001", "-32000"]);
    expect(outcomeCodes("ok")).toEqual(["ok"]);
  });
});

describe("titles", () => {
  it("titles the three call events by <app>/<tool>", () => {
    for (const event of ["tools/call", "prompts/get", "resources/read"]) {
      expect(titleOf(row({ id: 1, event, app: "news", tool: "search_news" }))).toEqual({
        title: "news/search_news",
        secondary: null,
      });
    }
  });

  it("titles every other event by its event name, the target beside it as secondary text", () => {
    // The rule this case exists for: an `approval.*` row names an app and a tool, and a
    // title of `news/search_news` would read as the call itself.
    expect(titleOf(row({ id: 2, event: "approval.requested", app: "news", tool: "search_news" }))).toEqual({
      title: "approval.requested",
      secondary: "news/search_news",
    });
    expect(titleOf(row({ id: 3, event: "admin.app_create", app: "linear" }))).toEqual({
      title: "admin.app_create",
      secondary: "linear",
    });
    expect(titleOf(row({ id: 4, event: "admin.settings_update" }))).toEqual({
      title: "admin.settings_update",
      secondary: null,
    });
  });
});

describe("facet counts", () => {
  const rows = [
    row({ id: 1, principal: "agent:cron", app: "news", tool: "search_news", outcome: "-32001" }),
    row({ id: 2, principal: "agent:cron", app: "news", tool: "search_news", outcome: "-32001" }),
    row({ id: 3, principal: "agent:claude", app: "notion", tool: "search", outcome: "ok" }),
    row({ id: 4, principal: "agent:claude", app: "notion", tool: "get_page", outcome: "error" }),
  ];

  it("counts a group's values under every OTHER group's filters but not its own", () => {
    const groups = facetGroups(rows, bare({ filters: [{ field: "outcome", value: "denied" }] }));
    // principal is filtered by outcome=denied, so only the cron rows count…
    const principals = groups.find((group) => group.field === "principal");
    expect(principals?.values).toEqual([{ value: "agent:cron", count: 2, on: false }]);
    // …while outcome, the group that carries the filter, still counts every class. Hearst's
    // exhaustive counts: a group whose own values zeroed each other out could never be widened.
    const outcomes = groups.find((group) => group.field === "outcome");
    expect(outcomes?.values.map((each) => [each.value, each.count, each.on])).toEqual([
      ["denied", 2, true],
      ["ok", 1, false],
      ["error", 1, false],
    ]);
  });

  it("names a tool by its app and never lists session", () => {
    const groups = facetGroups(rows, bare());
    expect(groups.find((group) => group.field === "tool")?.values.map((each) => each.value)).toEqual([
      "news/search_news",
      "notion/search",
      "notion/get_page",
    ]);
    expect(groups.some((group) => (group.field as string) === "session")).toBe(false);
  });

  it("counts under the search text as well as the other groups", () => {
    const groups = facetGroups(rows, bare({ q: "get_page" }));
    expect(groups.find((group) => group.field === "principal")?.values).toEqual([
      { value: "agent:claude", count: 1, on: false },
    ]);
  });
});

describe("the chain merge", () => {
  /**
   * §1's shape: the refused call, the request, the answer and the dispatch, all carrying one
   * `detail.approvalId`. The refused call shares the request's millisecond on purpose.
   *
   * Listed NEWEST FIRST, the order the window read answers in — so the merge is exercised on
   * the order it actually receives and the group's own (ts, id) sort is doing real work.
   */
  const chain = [
    row({ id: 13, ts: NOW - HOUR + 1000, event: "tools/call", app: "news", tool: "publish", outcome: "ok", durationMs: 1200, detail: { approvalId: "ap_1" } }),
    row({ id: 12, ts: NOW - HOUR, event: "approval.approved", app: "news", tool: "publish", outcome: "ok", detail: { approvalId: "ap_1" } }),
    row({ id: 11, ts: NOW - 2 * HOUR, event: "approval.requested", app: "news", tool: "publish", outcome: "ok", detail: { approvalId: "ap_1" } }),
    row({ id: 10, ts: NOW - 2 * HOUR, event: "tools/call", app: "news", tool: "publish", outcome: "-32003", detail: { approvalId: "ap_1" } }),
  ];

  it("draws every row sharing an approvalId as one row, ordered by (ts, id)", () => {
    const merged = mergeEvents(chain);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("chain");
    expect(merged[0]?.group.map((each) => each.id)).toEqual([10, 11, 12, 13]);
  });

  it("heads the chain with approval.requested although the refused call shares its millisecond", () => {
    expect(mergeEvents(chain)[0]?.head.id).toBe(11);
    // …and with the earliest row when no request was recorded.
    const headless = chain.filter((each) => each.event !== "approval.requested");
    expect(mergeEvents(headless)[0]?.head.id).toBe(10);
  });

  it("wears the state of its LAST event, not its head's", () => {
    expect(mergeEvents(chain)[0]?.state).toBe("ok");
  });

  it("treats the refused call as the ask rather than as a step of its own", () => {
    // Four rows, three words: the -32003 tools/call IS "asked for approval".
    expect(chainWords(mergeEvents(chain)[0]?.group ?? [])).toEqual([
      "asked for approval",
      "you approved 13:47",
      "ran ok 1.2 s",
    ]);
  });

  it("titles the chain ROW by the call it is the story of, and its record by the head row", () => {
    // The one exception to the titles rule: a chain headed by `approval.requested` is still the
    // story of `news/publish`, and titling the row by the head would file one event under two
    // names depending on whether the ask was recorded.
    const merged = mergeEvents(chain)[0]!;
    expect(titleOfMerged(merged)).toEqual({ title: "news/publish", secondary: null });
    expect(titleOf(merged.head)).toEqual({ title: "approval.requested", secondary: "news/publish" });
    // An un-chained row is the general rule, through the same function.
    expect(titleOfMerged(mergeEvents([row({ id: 30, event: "admin.app_create", app: "linear" })])[0]!)).toEqual({
      title: "admin.app_create",
      secondary: "linear",
    });
  });

  it("does not fold a lone approvalId into a chain", () => {
    // One row carrying an id nothing else shares is one row, not a chain of one.
    const merged = mergeEvents([row({ id: 20, detail: { approvalId: "ap_lonely" } })]);
    expect(merged[0]?.kind).toBe("one");
  });
});

describe("×N runs", () => {
  const refusal = (id: number, over: Partial<AuditWindowRow> = {}): AuditWindowRow =>
    row({ id, ts: NOW - id * HOUR, app: "news", tool: "search_news", principal: "agent:cron", outcome: "-32001", ...over });

  it("collapses consecutive rows with the same signature", () => {
    const merged = mergeEvents([refusal(1), refusal(2), refusal(3)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.runs).toBe(3);
  });

  it("splits on any of the six signature fields, failureClass among them", () => {
    expect(mergeEvents([refusal(1), refusal(2, { tool: "get_news" })])).toHaveLength(2);
    expect(mergeEvents([refusal(1), refusal(2, { principal: "agent:claude" })])).toHaveLength(2);
    expect(mergeEvents([refusal(1), refusal(2, { outcome: "-32000" })])).toHaveLength(2);
    expect(mergeEvents([refusal(1), refusal(2, { event: "prompts/get" })])).toHaveLength(2);
    expect(mergeEvents([refusal(1), refusal(2, { app: "notion" })])).toHaveLength(2);
    expect(
      mergeEvents([
        refusal(1, { outcome: "-32000", detail: { failureClass: "upstream_unreachable" } }),
        refusal(2, { outcome: "-32000", detail: { failureClass: "token_refresh_failed" } }),
      ]),
    ).toHaveLength(2);
  });

  it("never joins a chain to a run", () => {
    // Two rows with an identical signature, one of them part of a chain: the chain stays its
    // own row, and the ×N never swallows it.
    const merged = mergeEvents([
      refusal(1),
      refusal(2, { detail: { approvalId: "ap_2" } }),
      row({ id: 3, ts: NOW - 3 * HOUR, event: "approval.requested", app: "news", tool: "search_news", principal: "agent:cron", outcome: "ok", detail: { approvalId: "ap_2" } }),
      refusal(4),
    ]);
    expect(merged.map((each) => [each.kind, each.runs])).toEqual([
      ["one", 1],
      ["chain", 1],
      ["one", 1],
    ]);
  });
});

describe("the salience waterfall", () => {
  const call = (id: number, over: Partial<AuditWindowRow> = {}): AuditWindowRow =>
    row({ id, ts: NOW - (30 - id) * 60_000, client: { sessionId: "s1" }, app: "notion", tool: "search", durationMs: 100, ...over });

  const waterfall = (rows: AuditWindowRow[]) => waterfallOf(sessionsOf(rows)[0]!);

  it("keeps a run of exactly two ok calls as two lines", () => {
    // The threshold is "more than two", so two is where folding must NOT start: folding a
    // pair hides as much as it saves.
    expect(waterfall([call(1), call(2)]).map((each) => each.kind)).toEqual(["event", "event"]);
  });

  it("folds a run of three", () => {
    const rows = waterfall([call(1), call(2), call(3)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "fold", n: 3, apps: ["notion"] });
  });

  it("never folds anything but an ok tools/call", () => {
    const rows = waterfall([
      call(1),
      call(2, { outcome: "-32001" }),
      call(3),
      call(4, { event: "approval.requested", outcome: "ok" }),
      call(5),
      call(6),
      call(7),
    ]);
    // The refusal and the approval break the run, so nothing before them reaches three.
    expect(rows.map((each) => each.kind)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "fold",
    ]);
  });
});

describe("the window read's pages", () => {
  it("leaves page 0's window open and pins every later page to the one it echoed", () => {
    // The invariant this exists for: without the echoed pair the server resolves a fresh
    // `until = now` per request, so one row recorded between two pages shifts every later
    // offset by one and the concatenation carries a duplicate at each seam.
    expect(windowPagePath({ offset: 0, text: "" })).toBe("/audit/window?offset=0");
    expect(windowPagePath({ offset: 1000, text: "", since: 111, until: 222 })).toBe(
      "/audit/window?offset=1000&since=111&until=222",
    );
  });

  it("sends the search box as the read's own name for it", () => {
    expect(windowPagePath({ offset: 0, text: "wire guard" })).toBe("/audit/window?offset=0&text=wire+guard");
  });
});

describe("changes to the setup", () => {
  it("keeps the API's newest-first order", () => {
    // The rows arrive newest first, so the newest change is the FIRST one — the prototype's
    // `.slice(-5).reverse()` was for an ascending fixture and would show the five oldest.
    const rows = [
      row({ id: 3, ts: NOW - HOUR, event: "admin.grant_set" }),
      row({ id: 2, ts: NOW - DAY, event: "upstream.oauth_connected" }),
      row({ id: 1, ts: NOW - 2 * DAY, event: "tools/call" }),
      row({ id: 0, ts: NOW - 3 * DAY, event: "admin.app_create" }),
    ];
    expect(changesOf(rows).map((each) => each.id)).toEqual([3, 2, 0]);
  });
});

describe("the three worth-a-look rules", () => {
  /** The whole window loaded and nothing searched — the only case in which "first seen" is
   *  knowable at all. */
  const WHOLE = { wholeWindow: true };

  const refusals = (n: number): AuditWindowRow[] =>
    Array.from({ length: n }, (_, index) =>
      row({ id: 100 + index, ts: WEEK_START + index * HOUR, principal: "agent:cron", app: "news", tool: "get_news", outcome: "-32001" }),
    );

  it("says nothing about a refused pair at or below five", () => {
    expect(insightsOf(refusals(5), refusals(5), NOW, WHOLE)).toEqual([]);
  });

  it("names the worst refused pair past five, ending at the outcome class", () => {
    // No `reason` exists in the ledger (§15), so the sentence may not invent one.
    const [worst] = insightsOf(refusals(6), refusals(6), NOW, WHOLE);
    expect(worst?.parts.map((part) => part.text).join("")).toBe(
      "agent:cron was refused 6 times calling news/get_news — denied.",
    );
    expect(worst?.filters).toEqual([
      { field: "principal", value: "agent:cron" },
      { field: "tool", value: "news/get_news" },
    ]);
  });

  /** Newest first, as the API answers. */
  const firstSeenRows = [
    row({ id: 2, ts: NOW - DAY, app: "linear", tool: "create_issue" }),
    row({ id: 1, ts: WEEK_START, app: "notion", tool: "search" }),
  ];
  const freshOf = (over: { wholeWindow: boolean }) =>
    insightsOf(firstSeenRows, firstSeenRows, NOW, over).find((each) =>
      each.parts.some((part) => part.text.includes("first time")),
    );

  it("names tools first seen in the last two days of the loaded window", () => {
    const fresh = freshOf(WHOLE);
    expect(fresh?.parts.map((part) => part.text).join("")).toBe(
      "1 tool was called for the first time in the last two days: linear/create_issue.",
    );
    expect(fresh?.filters).toEqual([{ field: "tool", value: "linear/create_issue" }]);
  });

  it("says nothing about first-seen when the loaded rows are not the whole window", () => {
    // Past the ceiling, older rows exist that were never loaded — on a day and a half of a
    // busy ledger EVERY tool would read as new. The same holds under a search: the loaded
    // rows are only the matching ones, so the first match is not the first call.
    expect(freshOf({ wholeWindow: false })).toBeUndefined();
  });

  it("names changes to the setup and opens ALL of them", () => {
    const loaded = [
      row({ id: 2, ts: NOW - HOUR, event: "upstream.oauth_connected", app: "linear", tool: undefined }),
      row({ id: 1, ts: NOW - DAY, event: "admin.app_create", app: "linear", tool: undefined }),
    ];
    const change = insightsOf(loaded, loaded, NOW, WHOLE).find((each) =>
      each.parts.some((part) => part.text.includes("to your setup")),
    );
    // Newest first in the sentence, as the rows arrive…
    expect(change?.parts.map((part) => part.text).join("")).toBe(
      "2 changes to your setup: upstream.oauth_connected, admin.app_create.",
    );
    // …and "show me" opens the list the sentence counted — every distinct event, OR-ed in one
    // group — not the one event that happened to be last.
    expect(change?.filters).toEqual([
      { field: "event", value: "upstream.oauth_connected" },
      { field: "event", value: "admin.app_create" },
    ]);
  });

  it("counts first-seen over the LOADED rows and refusals over the selection", () => {
    // The two halves read different sets on purpose: "first seen" is a fact about the window
    // that was loaded, and narrowing the brush must not make a year-old tool look new.
    const loaded = [row({ id: 1, ts: WEEK_START, app: "notion", tool: "search" })];
    const selected = [row({ id: 2, ts: NOW - HOUR, app: "notion", tool: "search" })];
    expect(insightsOf(selected, loaded, NOW, WHOLE)).toEqual([]);
  });
});

describe("searching inside a record", () => {
  const body = {
    title: "Weekly report",
    credentials: { token: "‹redacted›" },
    content: [{ stub: "blob", contentType: "image/png", bytes: 4_404_019 }],
  };

  it("opens every ancestor of a match, so a nested hit is on screen", () => {
    const found = treeSearch(body, "arguments", "redacted");
    expect(found.matches).toBe(1);
    expect([...found.ancestors].sort()).toEqual(["arguments", "arguments.credentials"]);
  });

  it("matches a KEY as well as a value", () => {
    expect(treeSearch(body, "arguments", "credentials").matches).toBe(1);
  });

  it("searches a stub by the label it RENDERS as, not by its recorded fields", () => {
    // The reader sees `‹blob image/png · 4.2 MB›`; `bytes` and `4404019` are never on screen,
    // so searching for what is on screen has to work.
    expect(treeSearch(body, "arguments", "4.2 MB").matches).toBe(1);
    // The stub's OWN path is not among them: a stub renders as a leaf, so there is nothing
    // there to open — only the two nodes above it.
    expect([...treeSearch(body, "arguments", "4.2 MB").ancestors].sort()).toEqual([
      "arguments",
      "arguments.content",
    ]);
  });

  it("finds nothing for a needle that is not there, and everything for an empty one", () => {
    expect(treeSearch(body, "arguments", "wireguard").matches).toBe(0);
    expect(treeSearch(body, "arguments", "   ").matches).toBe(0);
  });
});

describe("the export href", () => {
  const paramsOf = (href: string): URLSearchParams =>
    new URLSearchParams(href.includes("?") ? href.slice(href.indexOf("?") + 1) : "");

  it("expands an outcome class to its raw codes and sends a tool as a whole target", () => {
    const href = exportHref(
      bare({
        q: "wireguard",
        brushed: true,
        since: NOW - DAY,
        filters: [
          { field: "outcome", value: "denied" },
          { field: "tool", value: "news/search_news" },
          { field: "principal", value: "agent:cron" },
        ],
      }),
    );
    const params = paramsOf(href);
    expect(href.startsWith("/audit/export.jsonl?")).toBe(true);
    expect(params.getAll("outcome")).toEqual(["-32001", "-32000"]);
    expect(params.getAll("principal")).toEqual(["agent:cron"]);
    // `q` is the page's name for it; the read's name is `text`.
    expect(params.get("text")).toBe("wireguard");
    expect(params.get("since")).toBe(String(NOW - DAY));
    expect(params.get("until")).toBe(String(NOW));
  });

  it("never splits a tool pair into an app and a tool", () => {
    // Splitting two pairs would export their CROSS PRODUCT: `app=news&app=notion&
    // tool=get_news&tool=search` also matches `news/search`, which nobody selected.
    const href = exportHref(
      bare({
        filters: [
          { field: "tool", value: "news/get_news" },
          { field: "tool", value: "notion/search" },
        ],
      }),
    );
    const params = paramsOf(href);
    expect(params.getAll("target")).toEqual(["news/get_news", "notion/search"]);
    expect(params.getAll("tool")).toEqual([]);
    expect(params.getAll("app")).toEqual([]);
  });

  it("repeats a key once per value in one group", () => {
    const href = exportHref(
      bare({ filters: [{ field: "app", value: "news" }, { field: "app", value: "notion" }] }),
    );
    expect(paramsOf(href).getAll("app")).toEqual(["news", "notion"]);
  });

  it("omits the brush when it is the whole window, and the text when nothing was searched", () => {
    // The export's own default IS the whole retention window, so writing it out would pin the
    // link to the instant it was copied.
    expect(exportHref(bare())).toBe("/audit/export.jsonl");
  });
});

describe("the tool filter's two spellings", () => {
  const rows = [
    row({ id: 1, app: "news", tool: "search" }),
    row({ id: 2, app: "notion", tool: "search" }),
    row({ id: 3, app: "news", tool: "get_news" }),
  ];
  const keep = (over: Partial<AuditSelection>): number[] =>
    rows.filter((each) => matchesFilters(each, bare(over))).map((each) => each.id);

  it("matches one app's tool when the value is a pair", () => {
    expect(keep({ filters: [{ field: "tool", value: "news/search" }] })).toEqual([1]);
  });

  it("matches the tool name across apps when a legacy deep link carries no slash", () => {
    // `/audit?tool=search` is what the agent and app pages emitted before the facet named a
    // tool by its app, and it has to keep meaning what it meant.
    expect(keep({ filters: [{ field: "tool", value: "search" }] })).toEqual([1, 2]);
  });
});

describe("the URL is the state", () => {
  it("reads the legacy deep links the agent and app pages emit", () => {
    expect(selectionOf({ principal: "agent:cron" }, WINDOW).filters).toEqual([
      { field: "principal", value: "agent:cron" },
    ]);
    expect(selectionOf({ session: "49404b1e" }, WINDOW).filters).toEqual([
      { field: "session", value: "49404b1e" },
    ]);
    expect(selectionOf({ expand: "39970" }, WINDOW).expand).toBe("39970");
  });

  it("reads ?range= as a window ending at the loaded window's end, 30d as the whole of it", () => {
    expect(selectionOf({ range: "1h" }, WINDOW)).toMatchObject({ since: NOW - HOUR, until: NOW, brushed: true });
    expect(selectionOf({ range: "24h" }, WINDOW)).toMatchObject({ since: NOW - DAY, brushed: true });
    expect(selectionOf({ range: "7d" }, WINDOW)).toMatchObject({ since: NOW - 7 * DAY, brushed: true });
    expect(selectionOf({ range: "30d" }, WINDOW)).toMatchObject({ since: WEEK_START, until: NOW, brushed: false });
  });

  it("prefers explicit since/until, and ignores an unreadable one", () => {
    expect(selectionOf({ since: String(NOW - DAY), until: String(NOW) }, WINDOW)).toMatchObject({
      since: NOW - DAY,
      brushed: true,
    });
    expect(selectionOf({ since: "yesterday" }, WINDOW)).toMatchObject({ since: WEEK_START, brushed: false });
  });

  it("defaults the view to summary and ignores a view it does not have", () => {
    expect(selectionOf({}, WINDOW).view).toBe("summary");
    expect(selectionOf({ view: "events" }, WINDOW).view).toBe("events");
    expect(selectionOf({ view: "waterfall" }, WINDOW).view).toBe("summary");
  });
});

describe("the lane strip", () => {
  const hours = 7 * 24;
  const at = (hour: number): number => WEEK_START + hour * HOUR;

  it("colours a cell by the WORST outcome in its hour", () => {
    const lanes = lanesOf(
      [
        row({ id: 1, ts: at(3) + 60_000, outcome: "ok" }),
        row({ id: 2, ts: at(3) + 120_000, outcome: "-32001" }),
        row({ id: 3, ts: at(3) + 180_000, outcome: "-32003" }),
      ],
      { start: WEEK_START, hours, oldestLoaded: WEEK_START },
    );
    // denied outranks approval outranks ok; an empty hour stays null.
    expect(lanes[0]?.cells[3]).toBe("denied");
    expect(lanes[0]?.cells[4]).toBe(null);
  });

  it("gives the six busiest principals a lane and folds the rest into one", () => {
    const rows: AuditWindowRow[] = [];
    // Eight principals, the first the busiest, so the folded lane holds the last two.
    for (let which = 0; which < 8; which += 1) {
      for (let n = 0; n <= 8 - which; n += 1) {
        rows.push(row({ id: which * 100 + n, ts: at(which), principal: `agent:p${which}` }));
      }
    }
    const lanes = lanesOf(rows, { start: WEEK_START, hours, oldestLoaded: WEEK_START });
    expect(lanes).toHaveLength(7);
    expect(lanes.map((lane) => lane.name).slice(0, 6)).toEqual([
      "agent:p0",
      "agent:p1",
      "agent:p2",
      "agent:p3",
      "agent:p4",
      "agent:p5",
    ]);
    expect(lanes[6]).toMatchObject({ name: "2 others", title: "agent:p6, agent:p7" });
    // The folded lane carries both principals' cells, not one of them.
    expect(lanes[6]?.cells[6]).toBe("ok");
    expect(lanes[6]?.cells[7]).toBe("ok");
  });

  it("draws an hour older than the oldest loaded row as not loaded, never as empty", () => {
    // Past the ceiling the page holds no rows for the start of the window, and an empty cell
    // would claim nothing happened there.
    const lanes = lanesOf([row({ id: 1, ts: at(50) })], {
      start: WEEK_START,
      hours,
      oldestLoaded: at(48),
    });
    expect(lanes[0]?.cells[0]).toBe("not-loaded");
    expect(lanes[0]?.cells[47]).toBe("not-loaded");
    expect(lanes[0]?.cells[48]).toBe(null);
    expect(lanes[0]?.cells[50]).toBe("ok");
  });
});

describe("the sentences a body cannot say for itself", () => {
  it("keeps §13's three no-bodies sentences verbatim", () => {
    expect(NO_BODIES_SENTENCE).toEqual({
      off: "Call bodies aren't recorded for this app (body logging is off).",
      refused: "Refused before the call was made, so there are no bodies to show.",
      unrecorded: "No bodies were recorded for this call.",
    });
  });

  it("spells a stub's size in KB under a megabyte and MB with one decimal above", () => {
    // A 20 KB body reading "0.0 MB" is a size nobody can act on, which is why the rule exists.
    expect(stubLabel({ stub: "oversize", bytes: 20_480 })).toBe("‹oversize · 20 KB›");
    expect(stubLabel({ stub: "blob", contentType: "image/png", bytes: 4_404_019 })).toBe(
      "‹blob image/png · 4.2 MB›",
    );
    expect(stubLabel({ stub: "blob", bytes: 1_048_576 })).toBe("‹blob unknown · 1.0 MB›");
  });

  it("renders the over-ceiling notice from the response's own two numbers", () => {
    expect(ceilingNotice(5000, 12_481)).toBe(
      "Showing the newest 5,000 of 12,481 events — narrow the search, or export JSONL for all of them.",
    );
  });
});

describe("the summary tiles", () => {
  it("counts calls and refusals and reads the median and p95 off ok calls alone", () => {
    const rows = [
      row({ id: 1, durationMs: 100 }),
      row({ id: 2, durationMs: 200 }),
      row({ id: 3, durationMs: 300 }),
      row({ id: 4, durationMs: 4000 }),
      row({ id: 5, outcome: "-32001", durationMs: 3 }),
      row({ id: 6, event: "admin.app_create", outcome: "ok" }),
    ];
    expect(summaryOf(rows)).toEqual({
      events: 6,
      calls: 5,
      refused: 1,
      median: 300,
      p95: 4000,
    });
  });

  it("has no latency to report when nothing ran", () => {
    expect(summaryOf([row({ id: 1, outcome: "-32001" })])).toMatchObject({ median: null, p95: null });
  });
});

describe("sessions", () => {
  it("groups rows without a session id under their principal, newest first", () => {
    const sessions = sessionsOf([
      row({ id: 1, ts: NOW - 3 * HOUR, principal: "agent:cron" }),
      row({ id: 2, ts: NOW - 2 * HOUR, principal: "agent:claude", client: { sessionId: "s1" } }),
      row({ id: 3, ts: NOW - HOUR, principal: "agent:cron" }),
    ]);
    expect(sessions.map((each) => each.id)).toEqual(["agent:cron · no session", "s1"]);
    expect(sessions[0]).toMatchObject({ noSession: true, first: NOW - 3 * HOUR, last: NOW - HOUR });
  });
});
