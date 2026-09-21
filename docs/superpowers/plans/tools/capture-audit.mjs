/**
 * The four `/audit` boards, captured headlessly from the adopted prototype
 * `design/concepts/AuditDemo.html` — the same method capture.mjs / build.mjs /
 * capture-mobile.mjs used for the agent and app pages: drive the demo to a state, take a
 * cleaned `outerHTML`, wrap the fragments in the `.dc.html` frame with the demo's own
 * stylesheet, then measure each board's height by rendering it once.
 *
 * The phone rendering is a media query in the demo, not a second file, so it cannot be
 * triggered by a 390 px box inside a 1380 px board. Every rule in the demo's narrow block
 * therefore begins with `body ` (the demo says so at the block), and `phoneCss()` swaps
 * that one token for `.phone` — same rules, same specificity, re-scoped to one phone.
 *
 *   node docs/superpowers/plans/tools/capture-audit.mjs     (run from the repo root)
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "file:///C:/Users/AmirHossein/repos/github.com/ahrzb/personal-mcps/web/node_modules/playwright/index.mjs";

const REPO = process.cwd();
const DEMO = path.join(REPO, "design/concepts/AuditDemo.html");
const URL = "file:///" + DEMO.split(path.sep).join("/");
const SHOTS = process.env.SHOTS ?? null;

// ── the demo's stylesheet, re-scoped ────────────────────────────────────────────────
const demoSrc = fs.readFileSync(DEMO, "utf8");
const sheet = demoSrc.slice(demoSrc.indexOf("<style>") + 7, demoSrc.indexOf("</style>"));
const narrowStart = sheet.indexOf("@media (max-width:767px){");
const narrowEnd = sheet.indexOf("\n  }", narrowStart);
const narrowBlock = sheet.slice(sheet.indexOf("\n", narrowStart) + 1, narrowEnd);
const regularStart = sheet.indexOf("@media (min-width:768px) and (max-width:1023px){");
const regularEnd = sheet.indexOf("\n  }", regularStart);

/** The demo's rules with both media blocks removed and the toast dropped. */
const baseCss = (sheet.slice(0, regularStart) + sheet.slice(narrowEnd + 4))
  .split("\n")
  .filter((l) => !/\.toast/.test(l))
  .join("\n");

/** The narrow block, every `body ` swapped for `.phone `, so one 390 px box renders it. */
const phoneCss = () =>
  narrowBlock
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/")) return l; // a comment rides along
      if (!l.startsWith("body")) throw new Error("narrow rule does not start with `body`: " + l);
      return ".phone" + l.slice(4);
    })
    .join("\n");

const BOARD_CSS = `${baseCss}
  /* the board, not the page: nothing scrolls, nothing is fixed */
  body{background:#fafafa}
  .rail{position:static;max-height:none;overflow:visible}
  .drawer{position:static;width:620px;height:auto;box-shadow:0 1px 2px rgba(0,0,0,.05);border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
  .dbody{overflow:visible}
  .board{box-sizing:border-box;background:#fff}
  .sheet{box-sizing:border-box;background:#fafafa;padding:32px;display:flex;flex-direction:column;gap:28px}
  .panel{display:flex;flex-direction:column;gap:8px}
  .lab{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#71717a}
  .lab span{text-transform:none;letter-spacing:0;font-weight:400;color:#a1a1aa}
  .notes{display:flex;flex-direction:column;gap:6px}
  .notes .note{max-width:80ch}
  .notes .note b{color:#09090b;font-weight:500}
  .pane{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
  .row2{display:grid;grid-template-columns:620px 620px;gap:32px;align-items:start}
  .phones{display:flex;gap:40px;align-items:flex-start}
  .slot{display:flex;flex-direction:column;gap:10px;width:390px;flex-shrink:0}
  .phone{position:relative;width:390px;min-height:844px;background:#fff;border:1px solid #d4d4d8;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.14)}
  .phone .level,.phone .drawer{position:absolute;inset:0;width:auto;height:auto;border:0;border-radius:0;box-shadow:none}
  .phone .drawer{background:#fff}
  .phone .rail{display:none}
${phoneCss()}
`;

const frame = (w, h, body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&amp;display=swap">
  <style>
${BOARD_CSS}  </style>
</helmet>
${body.replace(/ id="[^"]*"/g, "")}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;

// ── in-page helpers, injected into every page ──────────────────────────────────────
const HELPERS = `
  window.__clean = (el) => {
    const c = el.cloneNode(true);
    for (const n of [c, ...c.querySelectorAll("*")]) for (const a of ["onclick", "oninput", "onchange"]) n.removeAttribute(a);
    for (const i of c.querySelectorAll("input")) i.setAttribute("value", i.value);
    return c.outerHTML;
  };
  window.__grab = (sel) => window.__clean(document.querySelector(sel));
  window.__page = () => {
    const c = document.querySelector(".wrap").cloneNode(true);
    c.querySelector("#hint")?.remove();               // the demo's "Try:" line is not a page element
    return window.__clean(document.querySelector(".nav")).replace(/<span class="chip[^"]*">clickable demo<\\/span>/, "") + window.__clean(c);
  };
  window.__phone = () => {
    const wrap = document.querySelector(".wrap").cloneNode(true);
    wrap.querySelector("#hint")?.remove();
    const parts = [window.__grab(".nav"), window.__clean(wrap)];
    for (const sel of ["#flevel", "#drawer"]) { const el = document.querySelector(sel); if (el && !el.hidden) parts.push(window.__clean(el)); }
    return '<div class="phone">' + parts.join("") + "</div>";
  };
`;

const browser = await chromium.launch();
const errors = [];
async function open(w, h, query = "") {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${w}px${query}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error") errors.push(`${w}px${query}: ${m.text()}`); });
  await p.goto(URL + query, { waitUntil: "load" });
  await p.addScriptTag({ content: HELPERS });
  await p.waitForTimeout(150);
  return { p, ctx };
}
const F = {};

// ── 1 · the page, whole window, nothing filtered ───────────────────────────────────
{
  const { p, ctx } = await open(1380, 1400);
  F.summary = await p.evaluate(() => window.__page());
  await ctx.close();
}

// ── 2 · the two other views ────────────────────────────────────────────────────────
{
  const { p, ctx } = await open(1380, 1400);
  // Events: a brush, two facet chips, and a body that holds BOTH a chain row and a ×N run.
  const picked = await p.evaluate(() => {
    const day = 864e5;
    const tries = [
      [{ f: "principal", v: "agent:claude" }, { f: "app", v: "home" }],
      [{ f: "principal", v: "agent:claude" }, { f: "app", v: "linear" }],
      [{ f: "principal", v: "agent:claude" }, { f: "app", v: "slack" }],
      [{ f: "app", v: "home" }, { f: "event", v: "tools/call" }],
    ];
    // A board draws the grammar, not the page size: ten rows, with the Load more foot
    // still saying how many the view holds and that it pages 120 at a time.
    S.eventsShown = 10; S.sessionsShown = 5;
    for (const spans of [3, 5, 7]) {
      for (const filters of tries) {
        S.filters = filters.map((x) => ({ ...x }));
        S.view = "events"; S.from = NOW - spans * day; S.to = NOW; S.open = null;
        render();
        const html = document.querySelector("#main").innerHTML;
        if (html.includes('class="chain"') && html.includes("runs</span>")) {
          const sel = [...document.querySelectorAll("tr.ev")].find((r) => r.querySelector(".chain"));
          S.open = Number(sel.dataset.idx); render();
          return { filters, spans };
        }
      }
    }
    return null;
  });
  if (!picked) throw new Error("no filter pair draws a chain and a run together");
  F.events = await p.evaluate(() => window.__page());
  F.eventsWhat = picked;

  // Sessions: the busiest session that holds more than one outcome class, opened.
  await p.evaluate(() => {
    S.filters = []; S.q = ""; S.from = WEEK_START; S.to = NOW; S.view = "sessions"; S.open = null;
    S.sessionsShown = 5;
    render();
    const best = [...document.querySelectorAll(".sess")]
      .map((el) => ({ el, n: el.querySelectorAll(".counts .chip").length }))
      .sort((a, b) => b.n - a.n)[0];
    S.sessOpen = best.el.querySelector(".shead").dataset.id;
    render();
  });
  F.sessions = await p.evaluate(() => window.__page());
  await ctx.close();
}

// ── 3 · the record, and the page states ────────────────────────────────────────────
{
  const { p, ctx } = await open(1380, 1400);
  const drawer = async (pick) => {
    await p.evaluate(pick);
    return p.evaluate(() => window.__grab("#drawer"));
  };
  F.recBodies = await drawer(() => {
    const e = EV.find((x) => JSON.stringify(x.result ?? {}).includes('"stub":"blob"') && JSON.stringify(x.args ?? {}).includes("redacted"));
    S.open = e.idx; S.drawerQ = "";
    S.treeOpen = { "result.content": true, "result.structuredContent": true, "arguments.credentials": true };
    renderDrawer();
  });
  // §15: a body past the cap is replaced WHOLE, so the oversize stub is the column, never
  // a block inside `content`.
  F.recOversize = await drawer(() => {
    const e = EV.find((x) => x.result?.stub === "oversize" && x.args);
    S.open = e.idx; S.drawerQ = ""; S.treeOpen = {}; renderDrawer();
  });
  for (const why of ["off", "refused", "unrecorded"]) {
    F["rec_" + why] = await drawer(new Function("", `
      const e = EV.find((x) => x.noBodies === ${JSON.stringify(why)} && x.event === "tools/call");
      S.open = e.idx; S.drawerQ = ""; S.treeOpen = {}; renderDrawer();`));
  }
  F.recChain = await drawer(() => {
    const byId = new Map();
    for (const e of EV) if (e.detail?.approvalId) byId.set(e.detail.approvalId, (byId.get(e.detail.approvalId) ?? 0) + 1);
    const full = [...byId].filter(([, n]) => n >= 4)[0][0];
    const e = EV.filter((x) => x.detail?.approvalId === full).pop();
    S.open = e.idx; S.drawerQ = ""; S.treeOpen = {}; renderDrawer();
  });
  F.recSearch = await drawer(() => {
    const e = EV.find((x) => x.args && x.result?.structuredContent && x.tool === "create_page");
    S.open = e.idx; S.drawerQ = "report"; S.treeOpen = {}; renderDrawer();
  });
  F.recAdmin = await drawer(() => {
    const e = EV.filter((x) => x.event.startsWith("admin.")).pop();
    S.open = e.idx; S.drawerQ = ""; S.treeOpen = {}; renderDrawer();
  });
  await ctx.close();
}
for (const [key, state, sel] of [
  ["stLoading", "loading", ["#strip", ".body"]],
  ["stFailed", "failed", ["#failcard"]],
  ["stEmpty", "empty", [".body"]],
  ["stNothing", "nomatch", ["#filterbar", ".main"]],
  ["stCeiling", "ceiling", ["#strip"]],
  ["recLoading", "recordloading", ["#drawer"]],
  ["recGone", "recordmissing", ["#drawer"]],
]) {
  const { p, ctx } = await open(1380, 1200, "?state=" + state);
  F[key] = await p.evaluate((s) => s.map((x) => window.__grab(x)).join(""), sel);
  await ctx.close();
}

// ── 4 · the phone ──────────────────────────────────────────────────────────────────
{
  const { p, ctx } = await open(390, 844);
  await p.evaluate(() => { S.eventsShown = 8; S.sessionsShown = 4; render(); });
  F.mSummary = await p.evaluate(() => window.__phone());
  F.mEvents = await p.evaluate(() => { S.view = "events"; render(); return window.__phone(); });
  F.mSessions = await p.evaluate(() => {
    S.view = "sessions"; render();
    const best = [...document.querySelectorAll(".sess")].map((el) => ({ el, n: el.querySelectorAll(".counts .chip").length })).sort((a, b) => b.n - a.n)[0];
    S.sessOpen = best.el.querySelector(".shead").dataset.id; render();
    return window.__phone();
  });
  F.mFilters = await p.evaluate(() => {
    S.view = "events"; S.sessOpen = null; S.filters = [{ f: "principal", v: "agent:claude" }]; S.filterLevel = true; render();
    return window.__phone();
  });
  F.mRecord = await p.evaluate(() => {
    S.filterLevel = false; S.filters = []; render();
    const e = EV.find((x) => x.args && x.result && x.event === "tools/call" && x.ms > NOW - 864e5);
    S.open = e.idx; S.treeOpen = {}; render();
    return window.__phone();
  });
  await ctx.close();
}
if (errors.length) throw new Error("demo errors during capture:\n" + errors.join("\n"));

// ── the boards ─────────────────────────────────────────────────────────────────────
const mono = (t) => `<span class="mono">${t}</span>`;
const notes = (items) =>
  `<div class="panel" style="padding:0 24px 24px"><div class="eyebrow">Board notes</div><div class="notes">${items
    .map((i) => `<div class="note">&bull; ${i}</div>`)
    .join("")}</div></div>`;
const panel = (label, sub, html) =>
  `<div class="panel"><div class="lab">${label}${sub ? ` <span>— ${sub}</span>` : ""}</div>${html}</div>`;
const slot = (label, sub, html) => `<div class="slot"><div class="lab">${label}${sub ? ` <span>— ${sub}</span>` : ""}</div>${html}</div>`;

const audit = `<div class="board" style="width:1380px">
${F.summary}
${notes([
  `<b>Three readings of one filtered set.</b> <b>Summary</b> answers &ldquo;is anything wrong?&rdquo;, <b>Sessions</b> reads a client&rsquo;s visit end to end, <b>Events</b> is the log itself (${mono("AuditViews")}). The window, the facets and the search are one state in the URL &mdash; ${mono("view")}, ${mono("since")}/${mono("until")}, repeated ${mono("principal")} / ${mono("app")} / ${mono("event")} / ${mono("tool")} / ${mono("outcome")} / ${mono("session")}, ${mono("q")}, ${mono("expand")}, ${mono("open")} &mdash; so every state here is a link.`,
  `<b>The workspace shape</b> (layout &amp; density ladder &sect;2): full width inside 24 px gutters, the facet rail 200 px as its own card, 12 px between cards. Rows are dense (32 px, 6 / 16), controls 32 / 24, badges and chips 20 / 11, nothing below 11 px. ${mono("Audit")} moves out of the table row of the shape table into the workspace row.`,
  `<b>The lane strip is the window control.</b> One lane per principal (at most six, busiest first, the rest folded into &ldquo;N others&rdquo; whose name carries them on hover), one cell per hour of the retention window, each cell the <b>worst</b> outcome in that hour under the current facets and search. Drag selects; <b>1h &middot; 24h &middot; 7d</b> sit beside the title (the last labelled from ${mono("retentionDays")}, so the label never names a week the deployment may not keep) and <b>Whole window</b> clears. The strip is focusable: &larr;/&rarr; move the brush by an hour, Shift+&larr;/&rarr; resize it.`,
  `<b>Colour never carries an outcome alone.</b> Five classes &mdash; ${mono("ok")}, ${mono("approval")} (&minus;32003), ${mono("archived")} (&minus;32002), ${mono("denied")} (&minus;32001, &minus;32000), ${mono("error")} &mdash; and the class NAME is printed beside every swatch, chip and legend entry, with the raw codes after it where they differ.`,
  `<b>Facets count exhaustively</b> (Hearst): a value&rsquo;s count is taken under every other filter but its own group&rsquo;s, so a group never collapses to one row as you click. Several values in one group OR, groups AND, top 5 (6 for tool and event) with <b>Show all N</b> expanding in place. ${mono("session")} is never listed &mdash; it is set from a record.`,
  `<b>Worth a look</b> is three hand-written rules, each with <b>show me</b>: the worst refused (principal, target) pair past 5, tools first called in the last two days, and changes to the setup (${mono("admin.*")}, ${mono("upstream.*")}). With no ${mono("reason")} in the ledger the first sentence ends at the outcome class &mdash; &ldquo;refused 230 times calling ${mono("news/search_news")} &mdash; denied.&rdquo;`,
  `<b>Export JSONL</b> is a plain link to ${mono("/audit/export")} carrying the current selection &mdash; the same read serialized, never a second one. An outcome class expands to its codes and ${mono("&lt;app&gt;/&lt;tool&gt;")} splits, because the export filters the columns the ledger has.`,
  `<b>One query per window.</b> Facets, lanes, merging and sessions are computed client-side over the loaded rows, so a facet click never fetches and dragging the brush never fetches. Over the ceiling (${mono("AUDIT_EXPLORER_ROWS")} = 5,000) the page says so and the hours it could not load draw hatched, never empty (${mono("AuditDetailStates")}).`,
])}
</div>`;

const views = `<div class="sheet" style="width:1380px">
  <div class="note">The two readings ${mono("Audit")} does not draw. Same page, same state, same rail &mdash; only ${mono("view")} differs.</div>
${panel(
  "EVENTS &mdash; brushed, two facets, a chain row, a &times;N run, a row selected",
  `A ${picked(F.eventsWhat)} window; the chips above the pane repeat the rail&rsquo;s choices and remove with &times;.`,
  `<div class="board" style="width:1332px;border-radius:12px;overflow:hidden">${F.events}</div>`,
)}
${panel(
  "SESSIONS &mdash; one session open on its waterfall",
  "One row per client.sessionId (rows without one group under &ldquo;principal &middot; no session&rdquo;), newest first, 40 behind Load more.",
  `<div class="board" style="width:1332px;border-radius:12px;overflow:hidden">${F.sessions}</div>`,
)}
${notes([
  `<b>Events merges what belongs together.</b> Rows sharing a ${mono("detail.approvalId")} are one <b>chain row</b>, headed by the ${mono("approval.requested")} row but <b>titled by the call it is the story of</b> (${mono("home/set_scene")}, not ${mono("approval.requested")}) &mdash; the sentence beneath already says an approval was asked for. It carries that sentence (&ldquo;asked for approval &rarr; you approved 18:00 &rarr; ran ok 1.2 s&rdquo;) and the state of its LAST event; the refused ${mono("tools/call")} is the ask itself, not a step in it. Consecutive un-chained rows with the same (event, app, tool, principal, outcome, ${mono("detail.failureClass")}) collapse to <b>&times;N runs</b>; a chain never joins a run.`,
  `<b>Only a call is titled like one.</b> ${mono("tools/call")}, ${mono("prompts/get")} and ${mono("resources/read")} are titled ${mono("&lt;app&gt;/&lt;tool&gt;")}; every other event is titled by its event name with ${mono("&lt;app&gt;/&lt;tool&gt;")} dim beside it &mdash; an ${mono("approval.requested")} carries an app and a tool too, and titling it like a call makes the request and the refused call it caused read as the same row. The one exception is a <b>chain row</b>, which is one call&rsquo;s story and takes that call&rsquo;s title; the record it opens is still headed ${mono("approval.requested home/set_scene")}. The rule holds in un-chained Events rows, the waterfall, the record head and the chain timeline.`,
  `<b>The third line is evidence, not decoration.</b> ${mono("argsHead")} clipped to 110 characters (an oversize stub renders as its placeholder), else the first three ${mono("detail")} pairs &mdash; which is how a ${mono("detail.approvalId")} or a ${mono("failureClass")} is readable without opening the record. 120 rows at a time behind <b>Load more</b>; the foot counts rows against events.`,
  `<b>Sessions is salience, not completeness.</b> Opening one draws the waterfall: runs of more than two ${mono("ok")} ${mono("tools/call")} rows fold to &ldquo;N ok calls &mdash; apps&rdquo;, everything else keeps its own line and opens its record. The right-hand text is the duration for an ${mono("ok")} and the outcome class plus its ${mono("failureClass")} or raw code otherwise.`,
  `<b>Brushing is not filtering.</b> The brush is ${mono("since")}/${mono("until")} applied client-side over the loaded rows and drawn ON the strip &mdash; the strip itself is never dimmed by it, because the point of the strip is to show what lies outside the selection.`,
])}
</div>`;
function picked(w) {
  return w ? `${w.spans}-day` : "brushed";
}

const detail = `<div class="sheet" style="width:1380px">
  <div class="note">The record (${mono("?expand=&lt;id&gt;")}) as a right-hand drawer over a scrim &mdash; a Base UI Dialog, 620 px, focus-trapped, Escape closes. Drawn here as a static panel. Below it, the page states.</div>
  <div class="row2">
${panel("RECORD &mdash; a call with bodies", "one blob stub per unstructured block, a &lsquo;redacted&rsquo; leaf; every id a button that filters by it and closes", F.recBodies)}
${panel("RECORD &mdash; a body over the cap", "past AUDIT_BODY_CAP_BYTES the whole column is replaced by one oversize stub &mdash; it is never a block inside content", F.recOversize)}
${panel("RECORD &mdash; a chain, with its timeline", "every row sharing one detail.approvalId in write order (ts, then id): requested &rarr; call refused &rarr; you approved &rarr; call ran", F.recChain)}
${panel("RECORD &mdash; search within the record", "Search this record… highlights every match in the trees", F.recSearch)}
${panel("RECORD &mdash; a config change", "an admin.* row: no bodies to have, so no sentence either", F.recAdmin)}
${panel("RECORD &mdash; no bodies: body logging is off", "&sect;13&rsquo;s first sentence, verbatim", F.rec_off)}
${panel("RECORD &mdash; no bodies: refused", "&sect;13&rsquo;s second sentence &mdash; a refusal never had bodies, whatever log_bodies says", F.rec_refused)}
${panel("RECORD &mdash; no bodies: unrecorded", "&sect;13&rsquo;s third sentence", F.rec_unrecorded)}
${panel("RECORD &mdash; loading", "the field table is already drawn from the slim row; only the bodies wait on GET /api/hub/audit/:id", F.recLoading)}
${panel("RECORD &mdash; not found", "an id outside the caller&rsquo;s namespace and an id that aged out are one answer", F.recGone)}
  </div>
${panel("PAGE &mdash; loading skeleton", "one query per (since, until, q): page 0, then the rest to the ceiling in parallel", `<div class="pane">${F.stLoading}</div>`)}
${panel("PAGE &mdash; over the ceiling", "the newest 5,000 of N, and the hours with nothing loaded hatched &mdash; never drawn as quiet", `<div class="pane">${F.stCeiling}</div>`)}
${panel("PAGE &mdash; filters match nothing", "the window and the facets are still there to widen; Clear drops both", `<div class="pane">${F.stNothing}</div>`)}
${panel("PAGE &mdash; empty ledger", "nothing recorded yet, which is not the same as nothing matching", `<div class="pane">${F.stEmpty}</div>`)}
${panel("PAGE &mdash; load failed", "the shell&rsquo;s error card and Try again; the header keeps the retention line, which needs no read", `<div class="pane">${F.stFailed}</div>`)}
${notes([
  `<b>The record is a request inspector.</b> Head: the outcome swatch, the title, the time, Close. Body: <b>Search this record…</b>, the <b>Record</b> field table (when, principal, event, app, tool, outcome with its raw code, duration, client, session, id &mdash; every id a button that filters by it and closes the drawer), then <b>Arguments</b> / <b>Result</b> / <b>Detail</b> as collapsible JSON trees with the first level open.`,
  `<b>Stubs and redactions are shown as what they are</b>, and the two stubs are not the same thing: ${mono("content")} holds one ${mono("&lsquo;blob image/png &middot; 4.2 MB&rsquo;")} per unstructured block, while a body past ${mono("AUDIT_BODY_CAP_BYTES")} replaces its whole column with a single ${mono("&lsquo;oversize &middot; 20 KB&rsquo;")} (&sect;15) &mdash; sizes per &sect;13&rsquo;s KB/MB rule. ${mono("&lsquo;redacted&rsquo;")} draws as a stub chip: a masked leaf is never an empty string.`,
  `<b>The three no-bodies sentences are &sect;13&rsquo;s, verbatim</b>, and the refusal one wins first: several refusals happen before any redaction map exists, so no setting could have made bodies appear.`,
  `<b>The chain timeline is the ledger&rsquo;s own join.</b> ${mono("detail.approvalId")} now rides the four ${mono("approval.*")} rows, the ${mono("tools/call")} refused &minus;32003, and the ${mono("tools/call")} dispatched after the claim (brief &sect;1) &mdash; which is the whole of what makes &ldquo;asked &rarr; you approved &rarr; ran&rdquo; drawable. It reads in WRITE order, ts then id: ${mono("approvals.check")} records the request before the gateway records the refusal it threw, so the request always takes the lower id.`,
  `<b>Bodies arrive on their own.</b> The window read is slim (no ${mono("args_json")} / ${mono("result_json")} &mdash; projected away in SQL, never parsed to be thrown away); the drawer fetches ${mono("GET /api/hub/audit/:id")} when it opens, so a record id outside the loaded rows still opens.`,
  `<b>No reason is invented.</b> A &minus;32001 carries no ${mono("detail")} at all &mdash; &sect;7 keeps its three sources indistinguishable &mdash; so the record shows the class, the raw code, and nothing it does not have. A &minus;32000 carries ${mono("detail.failureClass")} (plus ${mono("upstreamStatus")} where an upstream answered one), which is what lets an owner tell a down upstream from a timed-out tunnel.`,
])}
</div>`;

const mobile = `<div class="sheet" style="width:2174px">
  <div class="note">${mono("/audit")} at 390 px. Not a second demo: the same file&rsquo;s ${mono("@media (max-width:767px)")} rules, re-scoped to one phone for this board.</div>
  <div class="phones">
${slot("SUMMARY", "the narrow shell: brand + hamburger; Export and the view segment full width at 44 px", F.mSummary)}
${slot("EVENTS", "two-line cards: time &middot; principal &middot; outcome chip, then the mono title, the chain line and &times;N", F.mEvents)}
${slot("SESSIONS", "a header wrapped to two lines; the waterfall puts each label above its bar", F.mSessions)}
${slot("FILTERS", "the rail as a full-screen level headed &lsquo;&nbsp;Audit, 44 px rows, a sticky Show N events", F.mFilters)}
${slot("RECORD", "a full-screen level headed &lsquo;&nbsp;Audit, not a drawer", F.mRecord)}
  </div>
${notes([
  `<b>One column, and the window set without a drag.</b> Touch has no hover and no precise drag, so the brush is not drawn at narrow: the <b>1h &middot; 24h &middot; 7d</b> presets and <b>tapping a day</b> on the axis set the window, and the tapped day is marked. The lanes stay &mdash; each name sits <b>above</b> its cells, and the cells lose their 1 px gaps so an hour is still a readable band at this width.`,
  `<b>The rail becomes Filters &middot; N</b>, a full-screen level headed ${mono("&lsquo; Audit")} with the same groups at 44 px rows, the same exhaustive counts and <b>Show all N</b>, and a sticky <b>Show N events</b> at the foot. The level names itself, so the rail&rsquo;s own &ldquo;Filter&rdquo; title is dropped there &mdash; a listing header never repeats what the level header shows.`,
  `<b>The record is a level, not a drawer</b>, headed ${mono("&lsquo; Audit")}; Close belongs to the pointer rendering. Every id in the field table keeps its 44 px target, which is why the table reads as a list of rows here rather than the two tight columns the drawer draws.`,
  `<b>An event card is two lines.</b> The ${mono("argsHead")} preview is the one thing the phone drops &mdash; it is the widest and the least answerable at this width, and the record is one tap away. 768&ndash;1023 keeps the desktop layout with the rail above the main pane as a wrapping row of groups.`,
  `<b>Same shell as the other phone boards</b> (${mono("MobileAppDetail")}, ${mono("MobileAgentDetail")}): the brand and a hamburger whose sidebar carries the five nav entries, the Approvals count and Sign out.`,
])}
  </div>`;

const boards = {
  "Audit.dc.html": [1380, audit],
  "AuditViews.dc.html": [1380, views],
  "AuditDetailStates.dc.html": [1380, detail],
  "MobileAudit.dc.html": [2174, mobile],
};
const sizes = {};
const measure = await browser.newContext({ viewport: { width: 1400, height: 900 } });
for (const [file, [w, body]] of Object.entries(boards)) {
  const out = path.join(REPO, "design", file);
  fs.writeFileSync(out, frame(w, 100, body));
  const p = await measure.newPage();
  await p.setViewportSize({ width: w, height: 800 });
  await p.goto("file:///" + out.split(path.sep).join("/"), { waitUntil: "load" });
  await p.waitForTimeout(400);
  const h = Math.ceil(((await p.evaluate(() => document.documentElement.scrollHeight)) + 20) / 20) * 20;
  await p.close();
  sizes[file] = [w, h];
  fs.writeFileSync(out, frame(w, h, body));
  if (SHOTS) {
    const s = await browser.newContext({ viewport: { width: w, height: Math.min(h, 4000) }, deviceScaleFactor: 1 });
    const sp = await s.newPage();
    await sp.goto("file:///" + out.split(path.sep).join("/"), { waitUntil: "load" });
    await sp.waitForTimeout(400);
    await sp.screenshot({ path: path.join(SHOTS, file.replace(".dc.html", ".png")), fullPage: true });
    await s.close();
  }
}
await measure.close();
await browser.close();
console.log(JSON.stringify(sizes, null, 1));
