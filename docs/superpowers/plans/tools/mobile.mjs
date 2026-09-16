import fs from "node:fs";
let s = fs.readFileSync("design/concepts/AgentThreePaneDemo.html", "utf8");
const must = (from, to) => { if (!s.includes(from)) throw new Error("not found: " + from.slice(0, 80)); s = s.replace(from, to); };

must("<title>", "<title>Mobile · ");
// phone frame + level CSS
must("</style>", `
  /* ---- mobile: three levels, one visible at a time ---- */
  body{background:#e4e4e7}
  .phone{width:390px;height:844px;margin:24px auto;background:#fff;border-radius:36px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;display:flex;flex-direction:column;position:relative}
  .nav{height:52px;padding:0 8px 0 16px;flex-shrink:0;position:relative;z-index:3}
  .nav .brand{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600}
  .burger{width:40px;height:40px;border:0;background:none;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:#09090b;cursor:pointer}
  .burger:hover,.phone.menu-open .burger{background:#f4f4f5}
  .menu{position:absolute;top:0;bottom:0;right:0;width:280px;background:#fff;box-shadow:0 0 40px rgba(0,0,0,.18);padding:8px;z-index:5;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s ease;box-sizing:border-box}
  .phone.menu-open .menu{transform:none}
  .scrim{position:absolute;inset:0;background:rgba(9,9,11,.35);z-index:4;opacity:0;pointer-events:none;transition:opacity .22s ease}
  .phone.menu-open .scrim{opacity:1;pointer-events:auto}
  .menu .dh2{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 0 0 12px;margin-bottom:6px;border-bottom:1px solid #f4f4f5}
  .menu .dh2 .brand{font-size:15px}
  .menu .who{margin-top:auto;border-top:1px solid #f4f4f5;padding-top:10px}
  .menu .mi{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 12px;border-radius:10px;font-size:15px;font-weight:500;color:#71717a;cursor:pointer}
  .menu .mi:hover{background:#f4f4f5}
  .menu .mi.on{background:#f4f4f5;color:#09090b}
  .menu .sep{height:1px;background:#f4f4f5;margin:6px 4px}
  .menu .who{display:flex;align-items:center;justify-content:space-between;padding:6px 12px 4px;font-size:13px;color:#71717a}
  .pill{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#dc2626;color:#fff;font-size:11px;font-weight:600}
  .wrap{width:auto;margin:0;padding:0;flex:1;min-height:0;display:flex;flex-direction:column;gap:0}
  .head{padding:12px 16px 8px;border-bottom:1px solid #e4e4e7;display:none;flex-direction:column;gap:6px}
  .phone[data-level="1"] .head{display:flex}
  .tile{flex-wrap:wrap;gap:8px 14px}
  .mh{display:none;align-items:center;gap:8px;height:48px;padding:0 8px;border-bottom:1px solid #e4e4e7;flex-shrink:0;background:#fff}
  .mh{display:flex}
  .head #crumb,.head .row > .mono,.head .row > .pre,.head .row > .sep{display:none}
  .head .row > .cell{font-size:13px}
  .mh .back{border:0;background:none;color:#2563eb;font-size:14px;font-weight:500;display:inline-flex;align-items:center;gap:2px;padding:0 6px;height:36px;border-radius:8px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mh .back:hover{background:#eff6ff}
  .mh .mt{font-weight:600;font-size:15px;flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mh .sp{width:80px;flex-shrink:0;text-align:right}
  #banner{padding:8px 12px 0}
  #banner:empty{padding:0}
  .banner{font-size:12px;flex-wrap:wrap}
  .panes{border:0;border-radius:0;box-shadow:none;height:auto;flex:1;min-height:0;flex-direction:column}
  .rail,.listing,.details{display:none;width:100%;box-sizing:border-box;flex:1;min-height:0;border-right:0}
  .ri{box-sizing:border-box}
  .phone[data-level="1"] .rail{display:flex;padding:12px 12px 24px;background:#fff}
  .phone[data-level="2"] .listing{display:flex}
  .phone[data-level="3"] .details{display:flex}
  .panes.wide .details{display:none}
  .panes.wide .listing{width:100%}
  .rh{padding:10px 8px 4px}
  .ri{height:44px;font-size:15px;padding:0 10px;border-radius:10px}
  .ri.on{background:none;box-shadow:none;font-weight:400}
  .ri .rm::after{content:"›";font-size:18px;color:#a1a1aa;margin-left:8px}
  .ri.dorm .rm::after{color:#d4d4d8}
  .lh{padding:12px 14px}
  /* the level header already names the pane or app: the listing header keeps only what it adds */
  .phone[data-level="2"] .lh .row > span:first-child[style*="font-weight:600"]{display:none}
  .phone[data-level="2"] .lh .cell:first-child,.phone[data-level="2"] .lh .row > .cell:nth-child(2){font-size:13px;color:#52525b}
  .sum{font-size:12px}
  .filter{width:100%!important}
  .cr{padding:10px 14px;grid-template-columns:1fr auto}
  .cr .st{flex-wrap:wrap;justify-content:flex-end;gap:4px 6px;max-width:190px}
  .via{display:block;width:100%;text-align:right;font-size:10px}
  .save{padding:10px 12px;flex-wrap:nowrap;gap:8px;position:sticky;bottom:0}
  .save > .row{flex-wrap:nowrap}
  .save > .row:first-child{min-width:0}
  .save > .row:first-child > .row{flex-wrap:wrap;font-size:11px}
  .save > .row:last-child{flex-shrink:0;margin-left:auto}
  .save .cell{display:none}
  .save .btn{height:32px;padding:0 10px;font-size:12px}
  .dh{padding:12px 14px}
  .db{padding:12px 14px}
  .appcard{grid-template-columns:1fr;row-gap:10px;padding:14px}
  .appcard > div:last-child{align-items:stretch}
  .appcard .btn{width:100%}
  .eps{max-height:220px}
  .details .kv{flex-direction:column;gap:2px}.details .kv .k{width:auto}
  .note.hint{display:none}
  .toast{bottom:80px;width:340px;text-align:center;font-size:12px}
  .home{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:134px;height:5px;border-radius:3px;background:#09090b;opacity:.9;pointer-events:none}
</style>`);
// shell: wrap nav + wrap in a phone; the header block gets a class, the level header is added
{
  const a = s.indexOf(`<body>\n<div class="nav">`), b = s.indexOf(`<div class="wrap">`);
  if (a < 0 || b < a) throw new Error("nav block");
  s = s.slice(0, a) + `<body>
<div class="phone" data-level="1">
<div class="nav">
  <div class="brand"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#09090b" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"></circle><path d="M12 8.5V3.5"></path><path d="M14.5 14.5L18.5 18.5"></path><path d="M9.5 14.5L5.5 18.5"></path></svg>personal-mcps</div>
  <button class="burger" aria-label="Menu" aria-expanded="false" onclick="phone.classList.toggle('menu-open');this.setAttribute('aria-expanded',phone.classList.contains('menu-open'))"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>
</div>
<div class="scrim" onclick="phone.classList.remove('menu-open')"></div>
<div class="menu" role="menu">
  <div class="dh2"><div class="brand"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#09090b" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"></circle><path d="M12 8.5V3.5"></path><path d="M14.5 14.5L18.5 18.5"></path><path d="M9.5 14.5L5.5 18.5"></path></svg>personal-mcps</div><button class="burger" aria-label="Close menu" onclick="phone.classList.remove('menu-open')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>
  <div class="mi">Apps</div><div class="mi on">Agents</div><div class="mi">Audit</div><div class="mi">Approvals<span class="pill">2</span></div><div class="mi">Settings</div>
  <div class="sep"></div>
  <div class="who"><span>ahrzb</span><span class="btn" style="height:28px;padding:0 10px;font-size:12px">Sign out</span></div>
</div>
` + s.slice(b);
}
must(`<div class="wrap">\n  <div style="display:flex;justify-content:space-between;align-items:flex-end">`, `<div class="wrap">\n  <div class="mh" id="mh"></div>\n  <div class="head">`);
must(`<div class="toast" id="toast"></div>`, `<div class="home"></div>\n</div>\n<div class="toast" id="toast"></div>`);
// the desktop hint is not the mobile hint
s = s.replace(/<div class="note">Try: [\s\S]*?<\/div>\n<\/div>/, `</div>`);

// behaviour: levels, back, the header, delegation
must(`render();\n</script>`, `render();

// ---- mobile levels -------------------------------------------------------------
let level = 1;
const phone = document.querySelector(".phone");
const desktopRender = render;
render = function () {
  desktopRender();
  phone.dataset.level = String(level);
  const titles = { credentials: "Credentials", activity: "Activity", grant: "Grant another app", danger: "Danger zone" };
  const l2 = view === "app" ? APPS[current].name : titles[view];
  let l3 = "";
  if (view === "app" && selected) l3 = selected.name;
  else if (picked) l3 = picked.kind === "token" ? TOKENS.find((t) => t.id === picked.id).prefix : picked.kind === "client" ? CLIENTS.find((c) => c.id === picked.id).name : picked.kind === "approval" ? APPROVALS.find((a) => a.id === picked.id).tool : CALLS.find((c) => c.id === picked.id).tool;
  else l3 = l2;
  const dot = draft && isDirty() ? \`<span title="unsaved" style="color:#2563eb;margin-left:4px">●</span>\` : "";
  document.getElementById("mh").innerHTML = level === 1
    ? '<button class="back">‹ Agents</button><span class="mt mono">claude</span><span class="sp"></span>'
    : level === 2
    ? \`<button class="back" onclick="up()">‹ claude</button><span class="mt">\${esc(l2)}\${dot}</span><span class="sp cell" style="font-size:11px">\${view === "app" && dirty2() ? changeCount() + " unsaved" : ""}</span>\`
    : \`<button class="back" onclick="up()">‹ \${esc(l2)}</button><span class="mt mono">\${esc(l3)}</span><span class="sp"></span>\`;
};
function dirty2() { return draft && isDirty(); }
function up() { if (level === 3) { level = 2; } else if (level === 2) { level = 1; } render(); }
// a rail tap opens the listing; a row tap (outside its control) opens the details
document.getElementById("rail").addEventListener("click", (e) => { if (e.target.closest(".ri")) { level = 2; render(); } });
document.getElementById("list").addEventListener("click", (e) => {
  if (e.target.closest(".st") || e.target.closest("button") || e.target.closest("a") || e.target.closest("input") || e.target.closest("select")) return;
  if (e.target.closest(".cr") && !e.target.closest(".appcard")) { level = 3; render(); }
});
// the wide grant step has no details level: a Grant button lands on the app's listing
const desktopStartGrant = startGrant;
startGrant = function (app) { level = 2; desktopStartGrant(app); };
render();
</script>`);
fs.writeFileSync("design/concepts/AgentMobileDemo.html", s);
console.log("ok", s.length);
