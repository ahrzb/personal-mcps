import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const HERE = process.env.HERE;
const CHROME = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
let s = fs.readFileSync("design/concepts/AgentMobileDemo.html", "utf8");
const tail = "render();\n</script>";
if (!s.includes(tail)) throw new Error("tail");
// every state is one phone: the .phone element's outerHTML after driving the demo there
const script = String.raw`
const OUT = {};
const clean = (el) => { const c = el.cloneNode(true); for (const n of [c, ...c.querySelectorAll("*")]) { if (n.id) n.classList.add("id-" + n.id); for (const a of ["onclick","oninput","onchange","id"]) n.removeAttribute(a); } return c; };
const phoneNow = () => clean(document.querySelector(".phone")).outerHTML;
function reset() { current = "news"; view = "app"; draft = null; selected = null; filterText = ""; picked = null; reveal = null; confirmRemove = false; confirmRevoke = null; pendingSwitch = null; grantQuery = ""; openApps = new Set(); callsShown = PAGE; level = 1; phone.classList.remove("menu-open"); render(); }
try {
reset(); OUT.level1 = phoneNow();
reset(); level = 2; render(); OUT.level2 = phoneNow();
reset(); level = 3; selected = { kind: "tool", name: "get_news" }; render(); OUT.level3 = phoneNow();
reset(); phone.classList.add("menu-open"); OUT.sidebar = phoneNow();
reset(); setEntry("tool/subscribe", "allow"); level = 2; render(); OUT.draft = phoneNow();
reset(); view = "grant"; openApps = new Set(["gh"]); level = 2; render(); OUT.grant = phoneNow();
reset(); view = "credentials"; level = 2; render(); OUT.credentials = phoneNow();
reset(); view = "activity"; level = 2; render(); document.querySelector("#list .more").scrollIntoView(); OUT.activity = phoneNow();
reset(); view = "activity"; picked = { kind: "approval", id: "a1" }; level = 3; render(); OUT.approval = phoneNow();
} catch (e) { OUT.error = String(e && e.stack || e); }
const pre = document.createElement("pre"); pre.id = "out"; pre.textContent = JSON.stringify(OUT); document.body.replaceChildren(pre);
`;
s = s.replace(tail, "render();\n" + script + "\n</script>");
const tmpHtml = path.join(HERE, "capture-mobile.html");
fs.writeFileSync(tmpHtml, s);
const url = "file:///" + tmpHtml.split(path.sep).join("/");
const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--dump-dom", url], { maxBuffer: 64 << 20 }).toString();
const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) throw new Error("no out: " + dom.slice(0, 300));
const F = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&"));
if (F.error) throw new Error(F.error);

// the board frame: the demo's whole stylesheet, phones laid out in a row
const demo = fs.readFileSync("design/concepts/AgentMobileDemo.html", "utf8");
const css = demo.slice(demo.indexOf("<style>") + 7, demo.indexOf("</style>"))
  .split("\n").filter((l) => !/\.toast/.test(l)).join("\n").replace(/#([a-z]+)/g, ".id-$1") +
  `  body{background:#fafafa}
  .phone{margin:0;height:auto;min-height:844px;box-shadow:0 8px 30px rgba(0,0,0,.14);border:1px solid #d4d4d8}
  .phone .scroll{overflow:visible}
  .phone .listing,.phone .details,.phone .rail{overflow:visible}
  .phone .menu{transition:none}.phone .scrim{transition:none}
  .board{display:flex;gap:40px;padding:32px;align-items:flex-start}
  .slot{display:flex;flex-direction:column;gap:10px;width:390px;flex-shrink:0}
  .lab{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#71717a}
  .lab span{text-transform:none;letter-spacing:0;font-weight:400;color:#a1a1aa}
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
${body}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;
const slot = (label, sub, html) => `<div class="slot"><div class="lab">${label}${sub ? ` <span>— ${sub}</span>` : ""}</div>${html}</div>`;
const main = `<div class="board" style="width:1330px;box-sizing:border-box">
${slot("Level 1 — the agent", "the rail as a list: apps, grant another, the agent's panes; ‹ Agents goes back to the list", F.level1)}
${slot("Level 2 — the listing", "what was tapped; the same rows and controls as the desktop listing; Save at the bottom right", F.level2)}
${slot("Level 3 — the details", "the row tapped there; ‹ names the listing", F.level3)}
</div>`;
const states = `<div class="board" style="width:2620px;box-sizing:border-box">
${slot("Sidebar", "the hamburger slides it in from its own side; scrim behind; Sign out at the foot", F.sidebar)}
${slot("Draft", "a row changed: the unsaved badge, the count in the level header, the dot in the title", F.draft)}
${slot("Grant another app", "cards, one endpoint list open; Grant lands on the app's listing", F.grant)}
${slot("Credentials", "Issue with its expiry, Revoke on live keys, Remove on expired ones", F.credentials)}
${slot("Activity, paged", "twenty calls, then Load more and how many the week still holds", F.activity)}
${slot("A waiting request", "level 3 of Activity: arguments, why it waits, the two buttons", F.approval)}
</div>`;
const boards = { "MobileAgentDetail.dc.html": [1330, main], "MobileAgentDetailStates.dc.html": [2620, states] };
const sizes = {};
for (const [file, [w, body]] of Object.entries(boards)) {
  const tmp = path.join(HERE, "m-" + file);
  fs.writeFileSync(tmp, frame(w, 100, body).replace("</body>", `<script>window.addEventListener("load",()=>{document.title=String(document.documentElement.scrollHeight)})</script></body>`));
  const d = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--virtual-time-budget=3000", "--dump-dom", "file:///" + tmp.split(path.sep).join("/")], { maxBuffer: 64 << 20 }).toString();
  const h = Math.ceil((Number(d.match(/<title>(\d+)<\/title>/)?.[1] || 0) + 20) / 20) * 20;
  sizes[file] = [w, h];
  fs.writeFileSync(path.join("design", file), frame(w, h, body));
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars", `--window-size=${w},${h}`, `--screenshot=${path.join(HERE, file.replace(".dc.html", ".png"))}`, "file:///" + path.resolve("design", file).split(path.sep).join("/")], { stdio: "ignore" });
}
console.log(JSON.stringify(sizes));
