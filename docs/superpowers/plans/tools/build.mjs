import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const HERE = process.env.HERE;
const CHROME = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const F = JSON.parse(fs.readFileSync(path.join(HERE, "fragments.json"), "utf8"));
const demo = fs.readFileSync("design/concepts/AgentThreePaneDemo.html", "utf8");
const css = demo.slice(demo.indexOf("<style>") + 7, demo.indexOf("</style>"))
  .split("\n").filter((l) => !/\.toast|\.hint/.test(l)).join("\n") +
  `  .panes{height:auto}
  .scroll,.details{overflow:visible}
  .lh .filter{cursor:text}
  .notes{display:flex;flex-direction:column;gap:4px}
  .notes .note b{color:#09090b;font-weight:500}
  .frame{width:520px;border:1px solid #e4e4e7;border-radius:10px;background:#fff;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05)}
  .frame .listing{width:auto;border-right:none}
  .frame .rail{width:180px;border-right:none}
  .frame .details{background:#fafafa}
  .panel{display:flex;flex-direction:column;gap:8px}
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
${css}  </style>
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
const mono = (t) => `<span class="mono">${t}</span>`;
const notes = (title, items) => `<div class="panel" style="padding-top:8px"><div class="eyebrow">${title}</div><div class="notes">${items.map((i) => `<div class="note">&bull; ${i}</div>`).join("")}</div></div>`;

// 1 · the page
const mainNotes = notes("Board notes", [
  `<b>Three panes.</b> A <b>rail</b> of the apps ${mono("claude")} holds a grant on (amber dot: an ask entry on that app; dash: dormant &mdash; the app is archived, or an entry matches nothing today; blue dot: an unsaved draft), then <b>+ Grant another app&hellip;</b>, then the agent&rsquo;s own panes: Credentials, Activity, Danger zone. The <b>listing</b> shows everything the app advertises &mdash; roles, tools, prompts, resources, and the agent&rsquo;s pattern entries &mdash; and the <b>details</b> pane opens the selected row.`,
  `<b>One control on every row: none &middot; ask &middot; allow.</b> Solid when set on that row itself; hollow when a role implies it, with the role named beneath (&ldquo;via reader&rdquo;). The states below what a role grants are disabled &mdash; lower the role to lower them. Highest wins: allow over ask. There is no deny; nothing granted is simply <em>none</em> (§7).`,
  `<b>Roles carry the same control.</b> A role row lists its patterns per §20 family and how many items they match today; the built-in ${mono("all")} is last. A tunneled app declares its roles at connect; a proxied app&rsquo;s come from config.`,
  `<b>Direct entries beside roles.</b> Setting a tool, prompt or resource on its own row writes an inline entry ${mono("tool/&lt;name&gt;")}, ${mono("prompt/&lt;name&gt;")} or ${mono("resource/&lt;uri&gt;")} into the same grant set (role names never contain ${mono("/")}, so the two never collide). Text typed into the filter that is not one exact name is offered as a pattern; pattern entries live in their own group with what they match today.`,
  `<b>One draft per app.</b> A changed row carries the amber dashed <b>unsaved</b> badge, the rail entry the blue dot, the foot counts the changes with Discard / Save &mdash; Save is one ${mono("grant_set")} for the (agent &times; app) pair, replacing the set. Switching app or pane with a draft shows the save-or-discard banner (on ${mono("AgentDetailStates")}).`,
  `<b>Remove from claude</b> sits in the foot: ${mono("grant_set")} with an empty set. History stays; a waiting request expires.`,
  `Every column reads from ops that exist: ${mono("agent_list")} and ${mono("app_get")} (catalog, roles), ${mono("token_list")}, ${mono("connection_list")}, ${mono("approval_list")}, ${mono("audit_query")}. Header tiles are the agent&rsquo;s totals across its apps.`,
]);
const main = `<div style="width:1240px;box-sizing:border-box;background:#fff;display:flex;flex-direction:column">
${F.nav.replace('<span class="badge">clickable demo</span>', "")}
${F.main.replace(/<\/div>\s*$/, mainNotes + "</div>")}
</div>`;

// 2 · the other panes
const pane = (label, sub, html) => `<div class="panel"><div class="eyebrow">${label}</div>${sub ? `<div class="note">${sub}</div>` : ""}${html}</div>`;
const panes = `<div style="width:1060px;box-sizing:border-box;background:#fafafa;padding:32px;display:flex;flex-direction:column;gap:28px">
  <div class="note">The other panes of <span class="mono">/agents/claude</span>, at pane width &mdash; the shell, header and rail are on <span class="mono">AgentDetail</span>. Each rail entry under <b>Agent</b> opens one of these in the same listing + details frame; <b>+ Grant another app&hellip;</b> takes the listing alone, wide.</div>
${pane("Credentials &mdash; a token selected", `Tokens from ${mono("token_list")} (${mono("kind = agent")}), the expiry for the next issue chosen beside <b>Issue</b>; the agent&rsquo;s OAuth client from ${mono("connection_list")}, read-only here &mdash; revoking a client lives in Settings &rarr; Connected clients (§19.6). Issue answers in place with the once-only key (${mono("AgentDetailStates")}); an expired token&rsquo;s verb reads <b>Remove</b> and is the same ${mono("token_revoke")}.`, F.credentials)}
${pane("Activity &mdash; a waiting request selected", `${mono("approval_list")} for this agent, Approve / Reject on the row (${mono("approval_decide")}), then the last seven days of ${mono("audit_query?principal=agent:claude")}; a refused call has no bodies to show, a recorded one shows arguments and result post-redaction.`, F.activity)}
${pane("Grant another app &mdash; wide, the listing alone", `Active apps ${mono("claude")} holds nothing on, one card each: what the app does, its counts and roles, <b>show all N</b> opening a scrollable endpoint list with the roles that grant each one and an info hover, and a search over apps and endpoints. <b>Grant</b> opens the app in the listing with an empty draft &mdash; nothing is written until Save.`, F.grant)}
${pane("Danger zone", `<b>Delete agent</b> &mdash; the same dialog as the list&rsquo;s (${mono("Dialogs")}); the details pane says what the delete removes and that audit rows stay.`, F.danger)}
</div>`;

// 3 · states
const L = (h) => `<div class="frame"><div class="listing">${h}</div></div>`;
const D = (h) => `<div class="frame" style="width:480px;display:flex">${h.replace('class="details"', 'class="details" style="flex:1"')}</div>`;
const R = (h) => `<div class="frame" style="width:180px;background:#fafafa">${h}</div>`;
const st = (label, html, sub) => `<div class="panel"><div class="eyebrow">${label}</div>${sub ? `<div class="note">${sub}</div>` : ""}${html}</div>`;
const col1 = [
  st("RAIL &mdash; draft, ask, dormant", R(F.rail), `Blue dot: unsaved draft on that app. Amber dot: at least one ask entry. Dash: dormant.`),
  st("HEADER &mdash; reach, with the draft&rsquo;s delta", L(F.lhDirty), `The reach line recomputes from the draft; the filter is its own row.`),
  st("ROW &mdash; implied by a role", L(F.rowImplied), `Hollow allow, &ldquo;via reader&rdquo;; none and ask are disabled &mdash; the title says which role to lower.`),
  st("ROW &mdash; direct entry, unsaved", L(F.rowDirect)),
  st("ROW &mdash; role set to none, unsaved", L(F.rowRole)),
  st("ROW &mdash; pattern entry", L(F.rowPattern), `An entry that is not one item, with what it matches today.`),
  st("ROW &mdash; ask entry with no effect", L(F.rowNoEffect), `A direct ask under a role that allows: kept, badged, removable with &times;. Allow wins (§7).`),
  st("ROW &mdash; undeclared role", L(F.rowUndeclared), `Granted, but the app has not declared it &mdash; dormant until it does (tunneled apps declare at connect).`),
  st("FILTER &mdash; typed text offered as a pattern", L(F.lhFilter + F.offer)),
  st("FILTER &mdash; nothing matches", L(F.nothing)),
  st("FOOT &mdash; unsaved changes", L(F.foot)),
  st("FOOT &mdash; Remove from claude, confirming", L(F.footConfirm)),
  st("BANNER &mdash; switching with a draft", F.banner),
  st("DETAILS &mdash; a pattern", D(F.detPattern)),
  st("DETAILS &mdash; a role", D(F.detRole)),
  st("DETAILS &mdash; a resource", D(F.detResource)),
  st("NEW GRANT &mdash; nothing saved yet", L(F.lhNew + F.footNew), `After <b>Grant</b> on the grant step: an empty draft on the app, the rail entry marked, Save enabled once something is set.`),
];
const col2 = [
  st("CREDENTIALS &mdash; key shown once", L(F.rowTokenNew) + D(F.reveal), `${mono("token_issue")} answers 200 in place; the plaintext never rides a URL (§4/§15).`),
  st("CREDENTIALS &mdash; expired token, Remove", L(F.rowExpired + F.rowExpiredConfirm), `The same ${mono("token_revoke")}, relabelled: an expired key is only a row to clear.`),
  st("CREDENTIALS &mdash; the OAuth client", L(F.rowClient) + D(F.detClient)),
  st("ACTIVITY &mdash; waiting request", L(F.rowApproval)),
  st("ACTIVITY &mdash; refused call", L(F.rowCallRefused) + D(F.detCallRefused)),
  st("ACTIVITY &mdash; recorded call", D(F.detCallOk)),
  st("GRANT STEP &mdash; a card, endpoints shown, info hovered", `<div class="frame" style="width:560px">${F.card}</div>`),
  st("GRANT STEP &mdash; search", L(F.grantSearch)),
  st("GRANT STEP &mdash; every app granted", L(F.grantEmpty)),
];
const states = `<div style="width:1240px;box-sizing:border-box;background:#fafafa;padding:32px;display:grid;grid-template-columns:1fr 1fr;column-gap:32px;row-gap:28px;align-items:start">
  <div class="note" style="grid-column:1/-1">States of <span class="mono">/agents/claude</span> (<span class="mono">AgentDetail</span>, <span class="mono">AgentDetailPanes</span>), each at its own width. Rows are the listing&rsquo;s; details are the right pane&rsquo;s.</div>
  <div style="display:flex;flex-direction:column;gap:28px">${col1.join("\n")}</div>
  <div style="display:flex;flex-direction:column;gap:28px">${col2.join("\n")}</div>
</div>`;

const boards = { "AgentDetail.dc.html": [1240, main], "AgentDetailPanes.dc.html": [1060, panes], "AgentDetailStates.dc.html": [1240, states] };
const sizes = {};
for (const [file, [w, body]] of Object.entries(boards)) {
  const draft = frame(w, 100, body);
  const tmp = path.join(HERE, "m-" + file);
  fs.writeFileSync(tmp, draft.replace("</body>", `<script>window.addEventListener("load",()=>{document.title=String(document.documentElement.scrollHeight)})</script></body>`));
  const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--virtual-time-budget=3000", "--dump-dom", "file:///" + tmp.split(path.sep).join("/")], { maxBuffer: 64 << 20 }).toString();
  const h = Math.ceil((Number(dom.match(/<title>(\d+)<\/title>/)?.[1] || 0) + 20) / 20) * 20;
  sizes[file] = [w, h];
  fs.writeFileSync(path.join("design", file), frame(w, h, body));
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars", `--window-size=${w},${h}`, `--screenshot=${path.join(HERE, file.replace(".dc.html", ".png"))}`, "file:///" + path.resolve("design", file).split(path.sep).join("/")], { stdio: "ignore" });
}
console.log(JSON.stringify(sizes));
