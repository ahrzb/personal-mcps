import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const HERE = process.env.HERE;
const CHROME = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
let s = fs.readFileSync("design/concepts/AgentThreePaneDemo.html", "utf8");
const tail = "render();\n</script>";
if (!s.includes(tail)) throw new Error("tail");
const script = String.raw`
const OUT = {};
const clean = (el) => { const c = el.cloneNode(true); for (const n of [c, ...c.querySelectorAll("*")]) for (const a of ["onclick","oninput","onchange"]) n.removeAttribute(a); return c; };
const grab = (sel) => clean(document.querySelector(sel)).outerHTML;
const rowBy = (pred) => { const r = [...document.querySelectorAll("#list .cr")].find(pred); if (!r) throw new Error("row"); return clean(r).outerHTML; };
const row = (name) => rowBy((r) => r.querySelector(".mono") && r.querySelector(".mono").textContent === name);
const panesNoRail = () => { const c = clean(document.querySelector(".panes")); c.querySelector("#rail").remove(); return c.outerHTML; };
const wrapNoHint = () => { const c = clean(document.querySelector(".wrap")); [...c.children].filter((n) => n.classList.contains("note")).forEach((n) => n.remove()); return c.outerHTML; };
function reset() { current = "news"; view = "app"; draft = null; selected = null; filterText = ""; picked = null; reveal = null; confirmRemove = false; confirmRevoke = null; pendingSwitch = null; grantQuery = ""; openApps = new Set(); render(); }
try {
reset(); selected = { kind: "tool", name: "get_news" }; render(); OUT.nav = grab(".nav"); OUT.main = wrapNoHint();
reset(); view = "credentials"; picked = { kind: "token", id: "t1" }; render(); OUT.credentials = panesNoRail();
reset(); view = "activity"; picked = { kind: "approval", id: "a1" }; render(); OUT.activity = panesNoRail();
reset(); view = "grant"; openApps = new Set(["gh"]); render(); OUT.grant = panesNoRail();
reset(); view = "danger"; render(); OUT.danger = panesNoRail();
reset(); setEntry("tool/subscribe", "allow"); setEntry("admin", null); setEntry("tool/search_*", "allow"); render();
OUT.rail = grab("#rail"); OUT.lhDirty = grab("#lh"); OUT.rowImplied = row("get_news"); OUT.rowDirect = row("subscribe"); OUT.rowRole = row("admin"); OUT.rowPattern = row("tool/search_*"); OUT.foot = grab("#save");
selected = { kind: "pattern", name: "tool/search_*" }; render(); OUT.detPattern = grab("#details");
confirmRemove = true; render(); OUT.footConfirm = grab("#save");
confirmRemove = false; pendingSwitch = "linear"; render(); OUT.banner = grab("#banner");
pendingSwitch = null; filterText = "admin_*"; render(); { const gh = [...document.querySelectorAll("#list .gh")].find((g) => g.textContent.includes("As a pattern")); OUT.offer = clean(gh).outerHTML + clean(gh.nextElementSibling).outerHTML; OUT.lhFilter = grab("#lh"); }
filterText = "zzz"; render(); OUT.nothing = grab("#list");
reset(); draft = { app: "news", allow: SAVED.news.allow.slice(), approval: [...SAVED.news.approval, "tool/get_news"] }; render(); OUT.rowNoEffect = row("get_news");
SAVED.news.allow.push("editor"); reset(); OUT.rowUndeclared = row("editor"); SAVED.news.allow.pop();
reset(); selected = { kind: "role", name: "reader" }; render(); OUT.detRole = grab("#details");
reset(); selected = { kind: "resource", name: "news://config" }; render(); OUT.detResource = grab("#details"); OUT.rowResource = row("news://config");
reset(); startGrant("gh"); OUT.lhNew = grab("#lh"); OUT.railNew = grab("#rail"); OUT.footNew = grab("#save");
reset(); view = "credentials"; render(); issueToken(); OUT.reveal = grab("#details"); OUT.rowTokenNew = row(TOKENS[0].prefix);
reveal = null; picked = { kind: "token", id: "t2" }; render(); OUT.rowExpired = row("pmcp_agt_2mQv…8xT"); OUT.detExpired = grab("#details");
confirmRevoke = "t2"; render(); OUT.detExpiredConfirm = grab("#details"); OUT.rowExpiredConfirm = row("pmcp_agt_2mQv…8xT");
confirmRevoke = null; picked = { kind: "client", id: "c1" }; render(); OUT.detClient = grab("#details"); OUT.rowClient = rowBy((r) => r.textContent.includes("claude.ai"));
reset(); view = "activity"; render(); OUT.rowApproval = rowBy((r) => r.textContent.includes("admin_purge_cache"));
picked = { kind: "call", id: "e3" }; render(); OUT.detCallRefused = grab("#details"); OUT.rowCallRefused = rowBy((r) => r.classList.contains("cur"));
picked = { kind: "call", id: "e2" }; render(); OUT.detCallOk = grab("#details");
reset(); view = "grant"; openApps = new Set(["gh"]); render(); { const tip = document.querySelector(".ep .tip"); tip.style.display = "block"; OUT.card = clean(document.querySelector(".appcard")).outerHTML; }
grantQuery = "merge"; render(); OUT.grantSearch = grab("#lh") + grab("#list");
grantQuery = ""; SAVED.gh = { allow: [], approval: [] }; render(); OUT.grantEmpty = grab("#list"); delete SAVED.gh;
} catch (e) { OUT.error = String(e && e.stack || e); }
const pre = document.createElement("pre"); pre.id = "out"; pre.textContent = JSON.stringify(OUT); document.body.replaceChildren(pre);
`;
s = s.replace(tail, "render();\n" + script + "\n</script>");
const tmpHtml = path.join(HERE, "capture.html");
fs.writeFileSync(tmpHtml, s);
const url = "file:///" + tmpHtml.split(path.sep).join("/");
const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--dump-dom", url], { maxBuffer: 64 << 20 }).toString();
const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) throw new Error("no out: " + dom.slice(0, 300));
const json = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const out = JSON.parse(json);
fs.writeFileSync(path.join(HERE, "fragments.json"), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([k, v]) => k + ":" + v.length).join("  "));
if (out.error) console.log("ERROR", out.error);
