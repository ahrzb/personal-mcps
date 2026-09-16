# The app page, redrawn as three panes — the dispatch brief (2026-09-17)

The owner asked for `design/concepts/AppThreePaneDemo.html` (the clickable prototype of
`/apps/<slug>` as three panes, drawn 2026-09-16 at the owner's ask and refined with the
owner through that day — its Recording pane is the approved `AppRecordingDemo` in the
three-pane grammar) to be **boarded, added to the design docs, implemented and deployed**,
whole — owner-defined roles ("New role") included. This brief turns the prototype into
code. Everything here is decided; an agent that finds a contradiction between this brief
and the prototype follows the brief and reports the contradiction in its final report.

The demo is the visual contract; this brief pins storage, ops, URLs, form names and
strings so the five agents agree without talking to each other. Two things the demo has
that the pages do NOT: the **unsaved-changes banner** ("Save and go / Discard and go /
Stay") and the **blue draft dots** — both script-only state, and the pages are
server-rendered with scripting off, exactly as the agent page dropped them. A draft here
is the form's own unsaved state, and leaving the page loses it, as on the agent page.

## 1 · Owner-defined roles (core)

**Storage.** `app.owner_roles_json TEXT NOT NULL DEFAULT '{}'` (migration
`server/migrations/0010_owner_roles.sql`, header comment in the house style): the roles the
**owner** defined on a **tunneled** app, in the same normalized per-family form
`roles_json` stores (§20.3). A proxied app keeps its roles in `roles_json` as today — "a
proxied app's roles are already all the owner's" — and its `owner_roles_json` stays `{}`.

**Effective roles.** `registry.ts` exports

```ts
/** The roles the door resolves against: the owner's, then the app's declaration on top —
 *  a name the app declares replaces the owner's definition of it (§20.3, 2026-09-17). */
export function effectiveRoles(detail: Pick<AppDetail, "declaredRoles" | "ownerRoles">): RoleDeclaration;
```

`AppDetail` gains `ownerRoles: RoleDeclaration` (canonical read shape, like
`declaredRoles`). **Every** gate-side reader of the declaration reads the effective map:
`resolveFilter` (the `buildToolFilter` call at the door), `setGrants`'s undeclared check
(an owner role IS declared for it — the tunneled warning / proxied error fire only for a
name in neither map), `catalog-view.reachabilityFor`'s callers (`pages/model.ts`,
`admin.ts`), and the hub's `hub/roles` forwarding (unchanged: it forwards the GRANTED
names). `upsertDeclaredRoles` (connect) is untouched: it replaces `roles_json` only, owner
roles persist, and a collision is resolved at read time with the app's declaration winning
— which is what the Roles pane says with its `app · replaced yours` badge.

**Ops.** `app_get` / `app_list` rows gain `ownerRoles: RoleDeclaration` on the **tunnel
variant** (`TunnelRow`; §8's completeness rule: a compile error until every producer
carries it). `app_create` and `app_update` gain `owner_roles` (a `roles`-shaped field,
optional; description `Owner-defined roles on a tunneled app — the app's own declaration
wins on a name collision.`), validated exactly like `roles` (`validateRoles`: `all`
reserved, pattern validity), and **refused on a proxied app** with the violation
`owner_roles is for tunneled apps — a proxied app's roles are "roles"`. Audit: the
existing `admin.app_update` row's `fields` list names it, nothing new.

**CLI** (`cli/src/plan.ts`): a tunneled app in YAML may carry `owner_roles:` (the `roles:`
grammar); `roles:` on a tunneled app stays the hard error it is; `owner_roles:` on a
proxied app is a hard error (`owner_roles is for tunneled apps`). `pmcp diff` compares the
file's `owner_roles` to the row's `ownerRoles` (absent ≡ `{}`) and plans `app_update {
owner_roles }`. `contracts/admin-ops.json` regenerated (`pnpm contracts:update`).

**Catalog schema leaves** (`catalog-view.ts`), which the Catalog details and the Recording
pane both read:

```ts
export type SchemaLeaf = { path: string; type: string; required: boolean; writeOnly: boolean; hasDefault: boolean; default?: unknown };
/** A JSON schema's leaves as dotted paths (`credentials.token`), objects recursed into,
 *  arrays printed as `<type>[]` and not recursed; `required` from each level's list. */
export function schemaLeaves(schema: unknown): SchemaLeaf[];
```

`argumentRows` stays for callers that want the top level; the app page no longer uses it.

## 2 · URLs and panes (web)

`/apps/<slug>` is a paned page: a **rail**, a **listing** pane and a **details** pane,
the framed workspace box, exactly the agent page's shape. Panes and URLs:

| Group | Pane | URL | Rail marker | Query |
|---|---|---|---|---|
| App | Catalog | `/apps/<slug>` (landing) | tools + prompts + resources count; blank when a family could not be read; dimmed `—` when the app never connected | `sel=tool:<name>` / `prompt:<name>` / `resource:<uri>`; `q=` |
| App | Roles | `/apps/<slug>/roles` | effective role count, or `none` | `sel=role:<name>`; `new=1` (the new-role editor); `q=` (the editor's filter) |
| App | Recording | `/apps/<slug>/recording` | a status dot: `rail-dot--on` when body logging is on, `rail-dot--off` otherwise (the Two-factor dot's markup, `sr-only` text `on` / `off`) | `q=`; `which=args:<path>` / `results:<path>` (expands one path's per-tool rows, repeatable) |
| App | Overview | `/apps/<slug>/overview` | none | — |
| Access | Agents | `/apps/<slug>/access` | agents holding ≥ 1 grant | `sel=agent:<slug>` |
| Access | Token | `/apps/<slug>/token` | live token count; dimmed `—` for proxied | `sel=token:<id>` |
| — | Danger zone | `/apps/<slug>/danger` | none | — |

`APP_PANES` (`app-routes.ts`) becomes `["roles", "recording", "overview", "access",
"token", "danger"]`. `GET /apps/<slug>/prompts` and `GET /apps/<slug>/resources` → `301`
to `/apps/<slug>` (the Catalog holds them; the query is dropped). `/apps/<slug>/catalog`
and `/apps/<slug>/tools` are 404s (no alias for the landing). Unknown pane → `noSuchPage`.

**Wide panes.** Overview, Danger zone, and Token for a **proxied** app render the listing
alone (`listing--wide`, as the agent page's grant step); every other pane is listing +
details. On the phone: three levels — 1 the landing (header + rail-as-list), 2 a pane
(listing), 3 a pane with `sel` (details) — `data-level="1|2|3"`, the level header's back
link and title exactly per the agent page's table (`‹ Apps` → `/apps` titled with the
name; `‹ <name>` → `/apps/<slug>` titled with the pane label; `‹ <pane label>` → the pane
URL without `sel` (keeping `q`, `new`, `which`) titled with the selected row's name). A
wide pane has no level 3.

**Header.** The title row: `Apps ›` crumb, the name, then the slug / kind / status badges
(`badge--title`), then the description as the subtitle. One **tiles** line under it:
`T tools · P prompts · R resources · A agents · body logging on|off` and, tunneled,
` · last seen <relative>`. No separate "Last seen" note. The proxied header card
(endpoint / auth / forward identity + Connect / Disconnect) stays above the pane on every
pane except Overview, as today.

**Rail** headings `App` / `Access`, then the tail group Danger zone. Active entry
`aria-current="page"`.

## 3 · The Catalog pane

Reads: the catalog of the app through `ownerCatalog` per advertised family (the
`unconnected` / `undeclared` / `unread` states as today), the grants of every agent on
this app (`agent_list`), the roles (effective), the redaction maps (`app_get`).

Listing header (`.lh`): title **Catalog**, subtitle tunneled `advertised by the app on its
last connect · re-listed on every reconnect` / proxied `fetched live from the upstream`;
the summary line `T tools · P prompts · R resources · reachable by N agent(s)`; the
filter (GET form, `q`, placeholder `filter tools, prompts, resources…`).

Groups `Tools · N`, `Prompts · N`, `Resources · N` (resources and templates in one group,
templates by their raw `uriTemplate`); a group of an unadvertised family reads `none
advertised` beside its heading and one note row (tunneled `This app declared no <family>
capability on its last connect.` / proxied `The capabilities configured for this app omit
<family>.`); never-connected: one note `This app has never connected, so the hub has no
catalog to list yet.` in place of all three; unread: `Couldn't reach <endpoint> — the live
listing failed, so nothing is shown; calls return errors until it answers again.` /
`Token refresh failed — calls return errors until you reconnect.` + Reconnect, as today.
A row: name (mono), description beneath (Markdown inline, one line); right: one badge per
agent that reaches it — `<agent>` (allow) or `<agent> · ask` (`badge--warning`) — or the
dim text `no agent`. The row IS the `?sel=` link (the agent page's row grammar); `q`
filters by name or description substring; nothing matching reads `no match` under the
group heading.

Details, nothing selected: title **Catalog**, `Select a tool, prompt or resource for its
details.`, a card `Where this comes from`: `Schemas` → tunneled `the app's last tools/list
— the hub stores them, it does not author them` / proxied `the upstream's live listing,
under a 10 s deadline`; `Reach` → `computed with the gate's own matcher over each agent's
grant`. Selected: header — name, family badge (`tool` / `prompt` / `resource`), the full
description (Markdown, `.md`). Cards: **Arguments** (tools and prompts): one row per
schema leaf — path (mono), type, and a `writeOnly · masked` warning badge where declared
(`none` when the schema has none); **Result · outputSchema** (tools with one), the same
rows; **Resource** (resources): `URI`, `Type` (mime), `Served on` → `the scoped endpoint
only — <origin>/<user>/mcp/<slug>` (copyable, as today), `Matched` → `by URI, never by
name`; **What only the hub knows**: `Called as` → `<slug>_<name> on the aggregated
endpoint` (not for resources), `Reachable by` → one line per agent `<agent> · via
<entries>` or `no agent yet`, `Approval` → tools: `asked for <agents>` / `none required`;
prompts: `never asked for prompts`; absent for resources, `Redaction` → `arguments <paths>
· results <paths>` (config entries plus `writeOnly` leaves) or `no redacted fields`
(absent for resources). Foot note: `The same block the audit row and the agent page show
for this <family>. Editing reach happens on Agents, masking on Recording.` (both links).

## 4 · The Roles pane

Listing header: **Roles**, subtitle `named sets of what this app exposes`; summary
`D declared by the app · Y yours · plus the built-in all` + tunneled ` · the app's
declaration wins when it declares a name you defined` / proxied ` · a proxied app declares
none, so every role is yours`. No filter on the listing. Rows, one per effective role then
`all` last: name (mono), a small source badge — `built-in` / `app` / `app · replaced
yours` (title `the app declares this name — its declaration replaced yours`) / `yours`
(`badge--success`) — beneath it `tools a, b · prompts c` (`every tool, prompt and
resource, present and future` for `all`) ` · matches N` (N = catalog items any of its
patterns match); right: one badge per agent holding it (`<agent>` / `<agent> · ask`) or
dim `held by no agent`. The row is the `?sel=role:<name>` link. The foot: **New role**
(a link to `?new=1`) on the left.

For a **proxied** app "yours" means `roles` (config) and there is no `app` source; for a
**tunneled** app "yours" means `owner_roles`, `app` the declaration. Which op field the
save writes follows the kind; the page never mixes them.

Details, nothing selected: **Roles**, `Select a role to see what it can do, or add one of
your own.`, a card `Two sources, one rule`: `The app's` → tunneled `declared at connect;
read-only here — the app owns them` / proxied `none: a proxied app declares no roles`;
`Yours` → `defined here by ticking items or adding patterns; usable in grants like any
role`; `Collision` → `if the app later declares a name you defined, its declaration
replaces yours — the row says so`.

Selected role (or `new=1`): header — the name (mono; for `new=1` an `<input name="role">`
placeholder `role name`, pattern `[a-z0-9_-]+`), the source badge (`built-in` /
`declared by the app` / `yours`), the holders' badges; the explanation: `all` → `Every
tool, prompt and resource, present and future. Never declarable, only grantable.`; app →
`Declared by <name> at connect. Read-only: the app owns it and may widen it on its next
connect.` or, shadowed, `<name> declares this name, so its declaration replaced the one
you had defined. Read-only: the app owns it.`; yours, tunneled → `Defined by you. If
<name> later declares a role named <role>, the app's declaration replaces this one.`;
yours, proxied → `Defined by you. A proxied app declares no roles, so this is the only
kind it has.`. Editable roles get the filter (GET, `q`, placeholder `filter, or type a
pattern…`, carrying `sel`).

Groups `Tools · K of N`, `Prompts · K of N`, `Resources · K of N` (K = in the role; a
family the app has none of is omitted): rows name, description, ` · via <pattern>` when a
non-literal pattern matches it; right: **editable** → a checkbox `<input type="checkbox"
name="i.<family>/<name>" value="1">` checked when the literal is in the role, or a locked
check (`.cb.lock`, title `matched by <patterns>`) when a pattern matches it; **read-only**
→ a locked check (title `in this role`) or an empty box (`not in this role`). Then
`Patterns · N` (`anchored · * aliases .*`): each non-literal pattern as a row — pattern,
family, `matches N today, and any added later` — with a remove submit button (`name="drop"
value="<family>/<pattern>"`) when editable, a locked check otherwise; and, when editable
and `q` is a non-literal, the offer row `<q>` · tools · `would match N today, and any added
later` with **Add as pattern** (`name="add" value="<q>"`; the family is `resources` when
`q` contains `://`, else `tools`). The foot (editable, saved role): **Delete role**
(`name="delete" value="1"`, a danger button) with the hint `grants naming it keep the name
and match nothing until it exists again` — no dialog: the op is reversible by re-adding;
right: **Discard** (link to the pane URL) and **Save**.

**The form**: one `<form method="post" action="/apps/<slug>/role_set">` around the
editor, CSRF, hidden `was=<name>` (the role being edited; empty for new), `role` (the
name: hidden for a saved role, the input for new), hidden `keep=<family>/<pattern>` per
existing pattern row (so a pattern the form still lists survives the save), the `i.`
checkboxes, `add` / `drop` / `delete` buttons. `web.ts` composes: the stored owner map
(`ownerRoles` for tunnel, `roles` for proxy), minus `was`, plus `role` → { per family:
the checked literals + the `keep` patterns − `drop` + `add` } (empty families omitted) —
or minus `was` alone on `delete` — and posts ONE `app_update { slug, owner_roles | roles
}`. Refusal (bad name, `all`, bad pattern, collision with the app's declaration: `<name>
is declared by the app — its declaration would replace yours`) redraws the pane at 400
with the reason in a danger alert and the submitted choices preserved. Success → 303 to
`/apps/<slug>/roles?sel=role:<name>` (`/apps/<slug>/roles` after delete) with the notice.

## 5 · The Recording pane

The approved `AppRecordingDemo` in the three-pane grammar. Listing header: **Recording**,
subtitle `what the audit trail keeps, and what it masks`; at the right edge the switch
**Record call bodies** — a real `<input type="checkbox" name="log" value="1">` styled as
the switch (label text visible, `.sw`); the summary line `body logging on|off · <kind>
default | set explicitly · M masked path(s) by config` + ` · W declared writeOnly by the
app` when any; the filter (GET, `q`, placeholder `filter paths…`). Proxied app with
logging on and nothing masked: the warning `A proxied app's schema is not cached at call
time, so nothing is masked automatically. Tick what is secret before you save, or it is
stored in the clear for 7 days.` above the sections.

Two sections, `Arguments · N path(s)` (`from each tool's inputSchema`) and `Results · N
path(s)` (`from outputSchema, where declared`), each path once (indexed over every tool's
`schemaLeaves`), sorted by how many tools take it then by name. A path row: the path
(mono), its type, `T tool(s)` ` · declared writeOnly[ on K]` / ` · masked on its tool |
all T | K of T`, and a **which** link (`?which=<dir>:<path>`, `hide` when open) whenever
more than one tool takes it or any declares it writeOnly; right: the unsaved badge is
script-only and ABSENT; the control is a checkbox `name="p.<dir>.<path>" value="1"` —
checked when every editable tool masks it; `disabled` + locked when no tool is editable
(all writeOnly). **A path masked on some but not all of its tools renders expanded**
(its per-tool rows shown, the path checkbox replaced by the locked-mixed glyph and no `p.`
field), so no save can silently clear a partial state. Expanded (open by `which=` or by
being mixed): one sub-row per tool — tool name, `declared by the app — always masked` and
a locked check for writeOnly, else a checkbox `name="m.<dir>.<tool>.<path>" value="1"`.
Under Results, when tools declare no output schema and `q` is empty: the note `<tools or
"N tools"> declare no output schema — a result path there can only come from a recorded
call (mask from evidence).` Empty section: `no path matches` / `no schema declares any
field`.

The foot: left `Recorded calls to <slug> →` linking `/audit?app=<slug>`; right
**Discard** (link) and **Save**. Details: **Masked before recording** — `These fields are
replaced with ‹redacted› before a call is written to the trail. Everything else in the
body is kept as sent.` / logging off: `Body logging is off, so no bodies reach the trail;
the masks below apply once it is turned on.`; a card per direction `Arguments · N masked`
/ `Results · N masked` listing each masked path with `on <tools>` (`N tools` past three)
and `declared writeOnly by <tools>`, or `nothing masked — arguments|results are recorded
whole`; the card `What a recorded call keeps`: `Arguments` → `params.arguments,
post-redaction`; `Results` → `structuredContent post-redaction; text, image and resource
blocks become size stubs, never bytes`; `Cap` → `16 KiB per body — an over-cap body is one
oversize stub`; `Kept for` → `7 days, then pruned with the rest of the audit table ·
Export JSONL to keep longer` (link to the audit export); `Never` → `refused calls, token
material, writeOnly and config-masked fields`; the note `A tick writes one literal (tool,
path) entry per tool; nothing here is a pattern and nothing is typed. Masking applies to
the approval record too.`

**The form**: `<form method="post" action="/apps/<slug>/recording_set">` around the
listing, CSRF, `log`, the `p.` and `m.` checkboxes, and hidden `keep.<dir>=<tool>:<path>`
for every stored entry the rows do not represent (a tool or path no schema declares —
entries added from evidence, or a pattern key), so a save never drops them. `web.ts`
composes `redact` / `redact_results` as: for each `p.` path → every editable tool that
takes it; each `m.` → that tool; plus the `keep` entries; and posts ONE `app_update {
slug, log_bodies, redact, redact_results }`. Success → 303 back to the pane with the
notice; refusal → 400 redraw with the reason.

## 6 · The Agents pane

Listing header: **Agents**, subtitle `who can call this app, and how`; summary `N agent(s)
hold a grant · open one to edit its grant on <slug>`. Rows (agents holding ≥ 1 grant):
the agent slug (mono), its description; beneath: `allowed` + one mono badge per allow
entry (or `—`), `ask first` + one warning badge per approval entry (or `—`), then `reaches
R of T tools · K ask first[ · P of PT prompts][ · Q of QT resources] · C calls · 7 d`
(calls from `audit_query { principal: agent:<slug>, app, since 7 d }`, the count of
`tools/call` rows); no right-hand control. After the rows the note `Granting a new agent
starts from the agent's own page — Agents → the agent → Grant another app.` (link to
`/agents`).

Details, nothing selected: **Agents**, `Select an agent to edit what it may call on
<slug>.`, a card `Per tool`: the first six tools, each with the agents reaching it
(`<agent>[ (ask)]`, comma-joined, or `no agent`), then `… N more in the Catalog`.

Selected agent: the header — slug (mono), an `agent` badge, the description, an **open
agent page** link to `/agents/<agent>/apps/<slug>`; `<agent>'s grant on <slug>. Solid: set
on the row · hollow: implied by a role · a row cannot lower what a role grants.` Then
**the agent page's grant editor**, verbatim: the reach summary line, the groups `Roles`,
`Tools · N`, `Prompts · N`, `Resources · N`, `Patterns · N` with the same rows, the same
`none · ask · allow` radio controls, the same field names (`e.<entry>`, `drop`, `carry`)
— extracted from `agent-detail.tsx` into `server/src/pages/grant-rows.tsx` and rendered
by both pages, the listing groups built by the same model builder. No pattern offer here
(no filter in the details). The foot: **Remove <agent>** (left; opens
`?confirm=remove-agent&agent=<slug>` on this pane — dialog `Remove <agent> from <slug>?`,
`<agent> loses every entry on <slug>. History stays; a waiting request expires.`, whose
form posts `clear=1`), **Discard** (link) and **Save** (right). The form: `<form
method="post" action="/apps/<slug>/grant_set">` with hidden `agent=<slug>`, composing the
same `grant_set` the agent page's route does (one shared composer in `web.ts`); success
→ 303 to `/apps/<slug>/access?sel=agent:<agent>` with the notice; refusal → 400 redraw
with the reason above the editor and the choices preserved.

## 7 · Token, Overview, Danger zone

**Token** (tunneled): header **Token**, subtitle `what the app presents to dial in`, an
**Issue new token** button at the right edge (the existing `token_issue` route, 200 in
place, the reveal drawn in the details of the new token, which is selected); summary
`L live · app tokens have no expiry — rotate by issuing, then revoking the old one.
Revoking the key a live socket used closes it.` Rows: prefix (mono), `holds the live
socket` (success badge) when it does, `new` when just issued; `issued <relative> · used
<relative> | never used`; right: **Revoke** → `?confirm=revoke-token&id=` (the existing
dialog; body `Revoking closes the app's live connection.` when live, else `The app can no
longer connect with it.`). Empty: `No live token — the app cannot connect until one is
issued.` Details: prefix, `app token` badge, `Only valid for opening the reverse WebSocket
as <slug>.`; the reveal card (`Shown once — copy it now`, the key, `The previous token
keeps working until you revoke it.`) when just issued; then `Issued`, `Expires` → `never —
revoke on compromise`, `Last used`, `Connection` → `holds the live socket now` / `none`.
Proxied: wide, the note `Proxied apps hold no tokens — the hub dials the upstream; nothing
dials in.`

**Overview** (wide): `Slug`, `Kind`, `Created`, proxied `Endpoint` / `Auth` / `Forward
identity`, tunneled `Last seen`, `Body logging` (`On|Off — <kind> default` or the bare
word), `Description`. **Danger zone** (wide): the two cards as today — **Archive <slug>**
/ **Unarchive** and **Delete <slug>** (`Revokes its N token(s), closes the live connection
and removes every grant (A agent(s)). This cannot be undone.`), behind the existing
dialogs.

## 8 · What the spec says afterwards

§13's `/apps/<slug>` bullet is rewritten around the seven panes above (the table, the
header, the panes' listings and details, the three forms, the three levels); its
`/apps/<slug>/prompts` and `/resources` rows become the 301 note; the Recording pane
replaces Overview's redaction lines. §5 gains the column. §8 gains `owner_roles` on
`app_create` / `app_update`, `ownerRoles` on the tunnel row, and the refusal. §9 gains
`owner_roles:` under a tunneled app. §20.3 gains the merge rule (owner's, then the app's
declaration on top; the app's wins by name). §22 gains one sentence (`owner_roles`
attribute on a tunneled app). Decision log: entry **32** — the app page as three panes and
owner-defined roles, with the Recording pane and the reasons above.

## 9 · Boards and design docs

From the demo, by headless capture as the agent boards were (`design/AgentDetail*` were
captured from `AgentThreePaneDemo.html`; the scratchpad scripts `capture.mjs` / `build.mjs`
/ `mobile.mjs` / `capture-mobile.mjs` are the pattern — the boards agent gets copies):

- `design/AppDetail.dc.html` — the Catalog pane with a tool selected (replaces the
  eight-pane board); `design/AppDetailPanes.dc.html` — Roles (a role selected), Recording,
  Agents (an agent selected, the editor), Token (a token selected), Overview, Danger zone;
  `design/AppDetailStates.dc.html` — new role, `app · replaced yours`, a proxied app's
  Roles and Recording (the warning), the Catalog filter with no match, unconnected /
  unread Catalog, revoke confirm, the reveal, the remove-agent dialog.
- `design/concepts/AppMobileDemo.html` — the demo at 390 px as three levels (the transform
  `mobile.mjs` applied to `AgentMobileDemo.html`, applied here), then
  `design/MobileAppDetail.dc.html` (levels 1, 2, 3 on Catalog) and
  `design/MobileAppDetailStates.dc.html` (Roles editor, Recording, Agents editor, Token,
  the sidebar).
- `design/MobileAgents.dc.html` — the agents list on the phone, drawn as `MobileApps` is
  (the row as the link, the chevron), from `design/Agents.dc.html`'s rows.
- `design/README.md`: the artboard table rows (App detail: `AppDetail`, `AppDetailPanes` /
  `MobileAppDetail`, `MobileAppDetailStates` / `AppDetailStates`; Agents: `MobileAgents`),
  a new section "The app page, redrawn as three panes (2026-09-17)" recording the
  decisions above in the style of the agents section, the flows that mention the app page;
  `design/concepts/README.md`: the `AppThreePaneDemo.html` row marked adopted and where it
  went, `AppRecordingPane` / `AppRecordingDemo.html` rows marked adopted into the
  Recording pane; `design/canvas.json` re-laid out with no overlaps for the new boards.

## 10 · Ownership

| Agent | Owns | Must not touch |
|---|---|---|
| spec | `docs/specs/**` (§13, §5, §8, §9, §20, §22, decision 32) | code, tests, design |
| core | `server/migrations/0010_owner_roles.sql`, `server/src/registry.ts`, `server/src/admin.ts`, `server/src/catalog-view.ts`, `server/src/gateway.ts` (only if the door reads roles there), `cli/src/plan.ts`, `contracts/`, and its own test rows in `server/test/unit/**`, `server/test/worker/admin-ops*.test.ts`, `server/test/worker/filter*.test.ts`, `cli/test/**` | `server/src/pages/**`, `server/src/web.ts`, `server/test/worker/web-pages.test.ts` |
| pages | `server/src/pages/**` (incl. the new `grant-rows.tsx`), `server/src/web.ts`, `server/src/app-routes.ts`, `server/dev/fixtures.ts`, `server/dev/preview.ts` | the test files, registry/admin/catalog-view |
| tests | `server/test/worker/web-pages.test.ts`, `server/test/worker/routes.test.ts`, `scripts/smoke.ts` | everything else |
| boards | `design/**` | code, tests, spec |

Rows first: the tests agent commits `it.todo` rows before writing bodies; core commits its
own todo rows first. Each agent runs only its own files (`vitest run <file>`); the full
suite and the visual gate are the orchestrator's. The pages agent codes against the core
signatures pinned in §1 and expects `tsc` red until core lands — never stubs them. Pages
gets the demo's `<style>` to copy for the pane grammar the agent page does not already have
(the role checkboxes `.cb` / `.cb.lock` / `.cb.mixed`, the switch `.sw`, the sticky group
headings), and one long-data fixture per listing (a 300-character pattern, a 40-word
description, a 60-character slug) so overflow shows in the states preview.

Your context may be summarized mid-run. If a file contains unexpected work converging with
your plans, it is almost certainly your own — disk is truth: re-read and integrate, grep
for existing helpers before writing new ones, and never stop to wait on a collaborator.
Record nothing about "another writer" in your report.
