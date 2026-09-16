# The agents pages, redrawn as three panes — the dispatch brief (2026-09-16)

The owner chose the agent page's direction on 2026-09-16 (`design/AgentDetail`,
`AgentDetailPanes`, `AgentDetailStates`, `Agents`; the clickable reference is
`design/concepts/AgentThreePaneDemo.html`; the decisions are summarised in
`design/README.md` § "Agents, redrawn as three panes"). This brief turns the boards into
code. Everything here is decided; an agent that finds a contradiction between this brief
and a board follows the brief and reports the contradiction in its final report.

Boards are the visual contract; this brief pins URLs, form names, op shapes and strings so
tests and pages agree without talking to each other.

## 1 · The grant entry, widened (core)

A grant set for an (agent × app) pair is a list of **entries**. An entry is either

- a **role name** — `[a-z0-9_-]+`, as today (`all` the built-in), or
- an **inline item** — `tool/<pattern>`, `prompt/<pattern>` or `resource/<uri-pattern>`,
  where the pattern is §7's pattern language for that family (§20.3's three keyspaces:
  `tool` → `tools`, `prompt` → `prompts`, `resource` → `resources`).

Role names never contain `/`, so the two kinds never collide. Each entry carries a mode:
allow (bare) or approval (the `:approval` suffix). **Mode parsing is by suffix**, not by
the first `:` — a resource URI carries colons (`resource/news://feed/*:approval`).

Storage: the entry string goes into `grant_.role` unchanged (the column keeps its name; §5
gains a comment). `agent_list` keeps relaying the strings as stored.

Resolution (`buildToolFilter`): an inline entry matches a subject when its family equals
the subject's family and `matchesPattern(pattern, subject, family)` holds; it contributes
its mode exactly like a role's pattern does, so allow still wins over approval and there is
still no deny. `Reach.roles` (catalog-view) names the inline entry itself as the matching
"role" (e.g. `tool/get_news`), which is what the page uses to say "via reader" vs "direct".

Validation (`setGrants`): an inline entry needs no declaration and is never "undeclared"
(the tunneled warning / proxied error stay role-only). A pattern that compiles to nothing
valid is refused: `"roles" entry "tool/(" is not a valid pattern`. A duplicate entry, or
the same entry in both modes, is refused as today. Empty patterns (`tool/`) are refused.
`grant_set`'s `roles` field description becomes: `Entries: a role name, or tool/<pattern>,
prompt/<pattern>, resource/<uri-pattern>; each optionally suffixed ":approval".`

The CLI's declarative `apply` (`cli/src/plan.ts`: `parseGrant`, `grantProblems`,
`grantStep`) accepts the same grammar with the same suffix rule; inline entries are never
flagged undeclared. The OpenTofu provider (§22, separate repo) takes strings in its `allow`
/ `approval` sets unchanged — §22 gains one sentence saying inline entries are legal there.

Exported helper, in `server/src/registry.ts` (the pages depend on this signature):

```ts
/** One grant entry, parsed: a role name, or an inline item of one family. */
export type GrantEntryKind = { kind: "role"; role: string } | { kind: "item"; family: RoleFamily; pattern: string };
export function parseGrantEntry(entry: string): GrantEntryKind;   // never throws; unknown family → role
export function itemEntry(family: RoleFamily, pattern: string): string; // "tool/<pattern>" etc.
```

## 2 · URLs and panes (web)

`/agents/<slug>` is a paned page: a **rail** (the agent's apps, then `+ Grant another
app…`, then an `Agent` group: Credentials, Activity, and the ungrouped Danger zone), a
**listing** pane and a **details** pane. Pane URLs:

| Pane | URL | Query |
|---|---|---|
| an app's grants (the listing + details) | `/agents/<slug>/apps/<app>` | `sel=<kind>:<name>` selects a row for details (`kind` ∈ `role`, `tool`, `prompt`, `resource`, `pattern`); `q=` the filter text |
| grant another app (wide: listing alone) | `/agents/<slug>/grant` | `q=` search; `show=<app>` opens that card's endpoint list |
| Credentials | `/agents/<slug>/credentials` | `sel=token:<id>` / `sel=client:<id>` |
| Activity | `/agents/<slug>/activity` | `sel=approval:<id>` / `sel=call:<id>` |
| Danger zone | `/agents/<slug>/danger` | — |

`/agents/<slug>` itself (the landing) renders **the first app in slug order the agent holds
a grant on**, in place; an agent holding no grants lands on the grant step, in place. No
alias URL for the landing pane (the §13 pane rule). `/agents/<slug>/apps/<app>` for an
active app the agent holds nothing on renders the **new-grant state** (an empty set, the
header's dashed "new grant · nothing saved yet" badge, the rail showing the app); an
unknown, builtin, foreign or (ungranted) archived app is `noSuchPage()`. An unknown pane
segment is `noSuchPage()`.

Old URLs: `GET /agents/<slug>/grants/<app>` → `301` to `/agents/<slug>/apps/<app>`;
`GET /agents/<slug>/grants` → `301` to `/agents/<slug>/grant`. `grant-editor.tsx` is
deleted; `PagePropsByName` loses `grant-editor`. The app page's Agents pane row action
(`app-detail.tsx`, "Edit grants") links to `/agents/<agent>/apps/<app>`.

**The rail** is `PaneRail` with groups: `Apps · N` (one entry per granted app in slug
order — marker: `rail-dot--warn` amber when the set holds an approval entry, a `—` dash
when the app is archived or every entry matches nothing today; a `+ Grant another app…`
entry carrying the count of grantable apps), `Agent` (Credentials with `live · clients`
counts, Activity with the pending-approval count), then the tail group Danger zone. Active
entry `aria-current="page"`; archived apps are `rail-link--dim`. Mobile: `PanePills`.

**Header**: breadcrumb `Agents / <slug>` (plus `/ <app>` on an app pane), the slug, an
`agent` badge, the name when it differs, the description, `Created`; tiles: `N apps ·
A allow · K ask first · D dormant` — counted over the grant sets, no catalog read (the
list and the header never fetch a catalog; only the open app pane does).

## 3 · The app pane (listing + details)

Reads: `agent_list` (the set), `app_list` (kind, status, declared roles), the catalog of
the one open app through `ownerCatalog(env, ownerId, slug, kind)` per advertised family —
exactly as `appDetailProps` does, including the `unconnected` / `undeclared` / `unread`
family states, rendered as one note line in the family's group ("<app> has not connected
yet — nothing to list until it does." / the family "is not advertised" / "could not be
read just now").

Listing header: the app's name, slug, kind badge, status badge; the **reach line**
`<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources` (computed
with `reachabilityFor` over the saved set); then the filter as its own row — a GET form
(`q`) with placeholder `filter, or type a pattern…`.

Groups, in order, each a heading with its count: `Roles · N` (`declared by the app at
connect` / `defined in config`), then any **undeclared** held role rows, `Tools · N`
(`R reached · U not`), `Prompts · N`, `Resources · N` (`matched by URI`), `Patterns · N`
(`entries that are not one item` — the inline entries whose pattern is not a literal), then
the **pattern offer** when `q` is non-empty and not a literal name: heading `As a pattern`,
one row `tool/<q>` (or `resource/<q>` when `q` contains `://`) with `would match N today,
and any added later` / `matches nothing today` and two submit buttons `Ask` / `Allow`.
With `q` set, rows are filtered by name or description substring; patterns stay; nothing
matching renders `Nothing matches “<q>”.`

**Rows.** A role row: name (`all` with a `built-in` badge, last), beneath it the patterns
per family and `matches N`; right: the control. An item row: name, description; right:
`via <roles>` / `also via <roles>` text when a role matches it, then the control. A
pattern row: the entry, `matches N today` / `matches nothing today`; the control. An
undeclared role row: name, `undeclared` badge, `granted, but the app has not declared it —
dormant`, right: an `in Allowed` / `in Ask first` badge with a `×` remove button.

**The control** is one radio group per row, three `<input type="radio">` in a `.seg`, in
this order and with these labels: `none` · `ask` · `allow`; field name `e.<entry>` (the
entry string: the role name, or `tool/<name>` / `prompt/<name>` / `resource/<uri>`), values
`none` / `approval` / `allow`. For an item row the group's checked value is the **direct**
entry's mode (none when there is none); when a role implies a higher mode the implied
button is drawn hollow (`.impl`, plus `.warn` for ask) and the buttons *below* the implied
mode are `disabled` with a `title` of `<roles> grants <ask|allow> — change the role to lower
it`. A direct entry at ask under a role that allows renders the `ask entry · no effect`
badge (title `allow wins over ask`) with a `×` remove button. Everything is one `<form
method="post">` per app pane, `action="/agents/<slug>/apps/<app>/grant_set"`, with the
CSRF field; the foot holds **Remove from <agent>** (left), the count text and `Discard`
(a link back to the pane) and `Save` (right).

**Save** composes the entry list: every `e.<entry>` field at `allow` → `<entry>`, at
`approval` → `<entry>:approval`, at `none` → nothing; plus the pattern offer's `add`
field (`add=<entry>` with the pressed button's value in `mode=allow|approval`) and minus
any `drop=<entry>` (the `×` buttons, submit buttons named `drop`). One `grant_set` for the
pair. A refusal (the proxied undeclared role, a bad pattern) redraws the pane at 400 with
the reason in a danger alert above the listing, the submitted choices preserved (never a
redirect). Success → 303 to the pane with the notice. **Remove from <agent>** →
`?confirm=remove-app` on the pane (dialog title `Remove <app> from <agent>?`, body `<agent>
loses every entry on <app>. History stays; a waiting request expires.`), whose form posts
`clear=1` to the same action → `grant_set` with `roles: []` → 303 to `/agents/<slug>` with
the notice.

**Details pane** (from `sel`): nothing selected → the app's name, kind, `Select a role,
tool, prompt or resource on the left for its details.`, a Catalog card (`Tools T · R
reached by <agent>` …) and the `Grant set for <agent>` card (`Allowed: …`, `Ask first: …`).
A role → `role` badge, `Declared by <app> at connect.` / `Built in: every family, present
and future.`, For-agent card (Standing `in Allowed` / `in Ask first` / `not granted`), a
Patterns card, a `Matches today` card, the note `A role widens when the app widens it. To
keep a single item regardless, add it directly from its row.` A tool → its description,
Standing (`allowed · via <roles>` / `allowed · direct` / `ask · …` / `not reachable`),
Approval sentence (`Not asked — allow wins over any ask entry, so adding one here would not
gate it while <roles> allows it.` / `Asked — each call waits for you.` / `—`), an Arguments
table, a `What only the hub knows` card (`Called as <app>_<tool> on the aggregated
endpoint`, `Reachable by`, `Redaction`). A prompt / resource: the same without arguments. A
pattern → `pattern` badge, `An entry that is not one item: anchored, * aliases .*.`,
Standing, `Matches today · N` with the names.

A small inline script (the audit expand precedent) may mark rows whose radio differs from
its initial value with the `unsaved` badge and count them in the foot; with scripting off
Save still replaces the set and the page is complete. The rail's blue draft dot is
script-only; nothing in a test depends on the script.

## 4 · The other panes

**Grant another app** (`/agents/<slug>/grant`): header `Grant another app` · `apps <agent>
holds nothing on`, a GET search form (`q`, placeholder `search apps and endpoints…`), the
sentence `What each app does; open it to see every endpoint and which roles grant it. Grant
opens the app with nothing granted yet.`; group `Apps · N` (`active, not archived · nothing
is written until you save`); one card per active non-builtin app the agent holds nothing
on: name, slug, kind badge, status badge, description, `T tools · P prompts · R resources
· roles <names>`, a `show all N` link (`?show=<app>`, `hide` when open) revealing the
endpoint list (`.eps`, each row: family label, name, an info marker whose `title` is the
description, and the role badges that grant it or `only via all or by name`), and a
**Grant** link (`btn btn--primary`) to `/agents/<slug>/apps/<app>`. `q` filters cards by
app name/slug/description or any endpoint name, and opens matching cards' lists. Empty:
`<agent> already holds a grant on every active app. Archived apps are not listed; unarchive
one to grant it.` The endpoint list reads that app's catalog (`ownerCatalog`) only for open
cards.

**Credentials** (`/agents/<slug>/credentials`): `Tokens · N` (unrevoked, `token_list` kind
`agent`), a group-heading control `expires in <select name="expires_in">` (`30d` →
`2592000`, `90d · default` → `7776000`, `1y` → `31536000`, `never` → `never`) beside an
**Issue token** button — one form posting to the existing `/agents/<slug>/token_issue`
(200 in place, `TokenReveal` above the list and a `new` badge on the row; the pane URL is
what re-renders). Rows: prefix, `expired` badge when expired, `created … · expires … (N d)
· used …`; right: **Revoke** (`?confirm=revoke-token&id=`) or, on an expired row,
**Remove** (`?confirm=remove-token&id=`, title `Remove expired token <prefix>?`, body `It
expired <date>; removing it keeps its history.`) — both post `token_revoke`. `Connected
clients · N` from `connection_list` for this agent, read-only, each row linking to
`/settings/clients`, the note `One OAuth client signs in as this agent, so its calls carry
these grants. Revoking lives with the other credentials in Settings → Connected clients.`
Details: a token → prefix, `token` badge, created/expires/last used/`Carries: every grant
in the Apps list — a key is the agent, not a subset of it`, Recent use (the last three
audit rows for `principal=agent:<slug>` whose token prefix matches when the trail records
it, else the agent's last three); a client → name, `OAuth client` badge, redirect origin,
consented, last used, registered (`by you, at consent` / `registered itself — identity
unverified`); nothing → the Summary card.

**Activity** (`/agents/<slug>/activity`): header `Activity` · `the last 7 days, the
retention window`, link `full trail · /audit?principal=agent:<slug>`; summary `N calls ·
ok · denied · awaiting approval`; `Awaiting approval · N` (`each expires an hour after it
was asked`): rows with app, tool, args (post-redaction, one line), age, and **Reject** /
**Approve** buttons — forms posting `approval_decide` to `/agents/<slug>/approval_decide`
(landing back on this pane); decided rows dimmed with their status badge; `Recent calls ·
N` from `audit_query` (`principal=agent:<slug>`, limit 50): app, tool, when, ms, outcome
badge (`ok` / `approval required` / `not permitted` / the failure). Details: an approval →
tool, status badge, `<agent> wants to call this on <app> · asked … · expires in …`,
Arguments (post-redaction) card, `Why it waits` (`<role> is in Ask first on <app>` — the
entry that matched with mode approval), the same two buttons; a call → the audit row's
sentences: bodies when recorded, else `Refused before the call was made, so there are no
bodies to show.` / the other two §13 no-bodies sentences, and `The same row the audit page
shows … Open in the audit trail.` linking `/audit?expand=<id>#event-<id>`.

**Danger zone** (`/agents/<slug>/danger`): the `Delete agent` card (`Deleting an agent
deletes its tokens, revokes its clients and removes its grants everywhere. This cannot be
undone.`) with **Delete <agent>** → the existing `?confirm=delete-agent` dialog → landing
on `/agents`; details `What deletion removes`: Grants (N apps), Tokens, Clients (`— the
binding cascades`), History (`kept — audit rows name the principal, not the row`).

Mutations follow the pane rule through the generic `/agents/:slug/:op` dispatcher with an
op → pane table: `token_revoke` → credentials, `approval_decide` → activity, `agent_delete`
→ `/agents`; `grant_set` has its own route (above).

## 5 · The list (`/agents`)

Title `Agents`, subtitle `Identities that call your apps — each holds grants and keys.`,
**New agent** (unchanged form). One row per agent: the slug as an anchor stretched over the
whole row (`class="row-link"`; the row has `class="agent-row"` and a trailing chevron), the
description beneath; **Access** in one line: `N apps · A allowed · K ask first · D
dormant` (dormant counts grants on archived apps and undeclared roles; `no grants` when
none); **Tokens** as today; **Created**; row control: **Delete** only (the existing
dialog). No catalog is read. Empty state and footer strings unchanged.

## 6 · Ownership

| Agent | Owns (may edit) | Must not touch |
|---|---|---|
| spec | `docs/specs/**`, `docs/specs/decisions/18-decision-log.md` (entry 31) | code, tests, design |
| core | `server/src/registry.ts`, `server/src/admin.ts` (grantEntries + the field description), `server/src/catalog-view.ts`, `cli/src/plan.ts`, `server/test/unit/filter.test.ts`, `server/test/unit/pattern.test.ts`, `server/test/worker/registry.test.ts`, `server/test/worker/admin-ops.test.ts`, `cli/test/**` | pages, web.ts, fixtures |
| pages | `server/src/pages/**` (delete `grant-editor.tsx`), `server/src/web.ts`, `server/src/app-routes.ts`, `server/dev/fixtures.ts`, `server/dev/preview.ts`, `scripts/smoke.ts` (the two agent legs only) | registry/admin internals (read only), the test files |
| web tests | `server/test/worker/web-pages.test.ts` (the agents describes only) | everything else |

Test runs: each agent runs only its own files (`npx vitest run <file>`); the full suite is
the orchestrator's gate and runs alone. Do not start `wrangler dev`.

Your context may be summarized mid-run. If a file contains unexpected work converging with
your plans, it is almost certainly your own — disk is truth: re-read and integrate, grep
for existing helpers before writing new ones, and never stop to wait on a collaborator.
Record nothing about "another writer" in your report.
