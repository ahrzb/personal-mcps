## 8. Admin MCP (the built-in `pmcp` app)

Built into the Worker at `POST /<user>/mcp/pmcp` — same proxy pipeline, but tools are
implemented locally instead of forwarded to a DO, and every tool operates on the
namespace of the `<user>` in the URL (which step 1 already proved is the caller's own).
Tools (names final, shapes reviewed at implementation time):

- `app_list` / `app_get` — includes kind, canonical slug, declared roles in the
  canonical read shape, redact paths, `log_bodies`, archive/connection state, proxied
  endpoint/auth/identity settings, and tunneled `ownerRoles`. It additionally exposes
  owner `typescriptAliases` separately from the resolved §23 reservation map and bounded
  alias diagnostics. Canonical upstream identities are never replaced in these rows.
- `app_create` / `app_update` — retain the existing kind, endpoint, auth,
  `forward_identity`, capabilities, roles/owner_roles, redaction, and body-logging
  fields and validation. Both additionally accept optional
  `typescript_aliases: { service?: string, tools?: Record<canonicalName, alias> }`.
  The owner lane is authoritative over SDK hints. Syntax is validated with §23's exact
  identifier rules; any reservation collision refuses the entire write atomically with
  payload-free `-32602`. Omission preserves established configuration. Setup preflights a
  reachable live catalog, but proxied apps need no SDK and retain canonical upstream
  names. `kind` remains immutable.
  *(2026-09-17, decision 32: both ops also take `owner_roles`, optional and `roles`-shaped
  — described to the model as "Owner-defined roles on a tunneled app — the app's own
  declaration wins on a name collision." — validated by exactly the same rules as `roles`
  (`validateRoles`: the reserved `all` refused, every pattern must compile, the same caps),
  and **refused on a proxied app**, violation field `owner_roles`, reason `owner_roles is
  for tunneled apps — a proxied app's roles are "roles"`. `roles` on a tunneled app stays
  what it was: the app's own declaration, written at registration and not writable here.
  The Roles pane of §13 posts one `app_update` carrying whichever of the two fields the
  app's kind names, never both. The audit trail is unchanged — the existing
  `admin.app_update` row's `fields` list names `owner_roles` like any other field, and no
  new event type exists.)* Changing `auth` in either direction is accepted but
  destructive: any stored `upstream_auth_json` is wiped (audit row
  `upstream.auth_mode_changed`), leaving the app not-connected until the owner runs
  Connect (`auth: oauth`) or `app_set_upstream_auth` (`auth: headers`). A refused create
  or update reports every violation at once in a `-32602` error whose message joins the
  field-specific causes.
  `app_set_upstream_auth`
  is rejected on `auth: oauth` apps, and the Connect flow (§7) is rejected on
  `auth: headers` ones — each mode has exactly one credential path. `app_list` /
  `app_get` additionally report the OAuth connection status for `auth: oauth`
  apps (not connected / connected / needs reconnect). Proxied role definitions get the same validation
  as `hub/register` (§6): name charset, `all` rejected, patterns must compile, caps. Delete
  also deletes the app's `token` rows, tells its DO to close any live socket (code
  `4001`) and drop cached state (DO side effects apply to tunneled apps only —
  proxied apps have no DO and no tokens).
- `app_set_upstream_auth` — proxied only: stores the headers (e.g. a bearer token)
  the hub sends upstream. Write-only, like `token_issue`: secrets never appear in read
  tools or provider state.
- `app_disconnect` — `auth: oauth` proxied apps only: wipes the stored token
  bundle (audit row `upstream.disconnected`), leaving the app not-connected until
  Connect runs again (§7). The web Disconnect button fronts this tool. Connect/Reconnect
  have no tool equivalent — the consent redirect is inherently a browser interaction
  (`pmcp connect` prints the URL).
- `app_archive` / `app_unarchive` — archive severs any live socket (close
  `4002`) and hides the app from consumers; everything is retained for unarchive
  (§6, "App lifecycle").
- `agent_list` / `agent_create` / `agent_delete` — delete also deletes the
  agent's `token` rows. `agent_list` returns each agent's grants inline; there is no
  separate grant-read tool.
- `grant_set` — replaces the full grant set for (agent, app); each entry is a
  role name plus optional mode (`reader` or `reader:approval`).
  *(2026-09-16, decision 31: an entry is a role name **or an inline item** —
  `tool/<pattern>`, `prompt/<pattern>` or `resource/<uri-pattern>`, the pattern being §7's
  language for that family and the family being §20.3's keyspace for it. Role names never
  contain `/`, so the two kinds never collide. **Mode is read from the `:approval`
  suffix**, never from the first `:` — a resource URI carries colons of its own, so
  `resource/news://feed/*:approval` is one approval-mode entry. An inline entry needs no
  declaration and is never "undeclared": the tunneled warning and the proxied error below
  stay role-only. An entry whose pattern does not compile is refused — `"roles" entry
  "tool/(" is not a valid pattern` — and so is an empty pattern (`tool/`); a duplicate
  entry, or the same entry in both modes, is refused as it always was. The `roles` field
  description reads, verbatim: `Entries: a role name, or tool/<pattern>, prompt/<pattern>,
  resource/<uri-pattern>; each optionally suffixed ":approval".` The entry string is
  stored unchanged in `grant_.role` (§5) and relayed unchanged by `agent_list`.)*
  Applies the app declaration's role validation: undeclared roles warn for tunneled apps,
  hard-error for proxied ones; a role literally named `all` is never declarable, only
  grantable (it is the built-in).
- `approval_list` — `{ status?, limit? }` → approval requests, newest first (pending
  and history alike).
- `approval_decide` — `{ id, decision: "approve" | "reject" }`. The web approval page
  (§13) and `pmcp approve/reject` are both fronts for this.
- `token_issue` — `{ kind: "agent" | "app", slug, expires_in? }` → plaintext
  key (shown once). `kind: "app"` is rejected for proxied apps (nothing connects).
  Agent tokens default to 90 d expiry (pass `expires_in` to override,
  including `never`) — these are the tokens pasted into agent configs; app tokens
  default to no expiry (revoke-on-compromise, the telegram-bot model). The issued
  key is a `writeOnly`-marked field in this tool's *output* schema, so §15's uniform
  body rule masks it wherever bodies are recorded — no pmcp-specific logging rule
  exists or is needed.
- `token_list` / `token_revoke` — listings include `last_used_at`; revoking an `app`
  token also closes that app's live socket (code `4001`) if the connection was
  opened with it.
- `connection_list` / `connection_revoke` *(added 2026-08-26, §19)* — the OAuth clients
  connected to this namespace: client name and id, the agent each is bound to,
  created/last-used, revoked state *(amended 2026-09-02, decision 30: plus the origin of
  the client's registered redirect URI and whether it self-registered — the two identity
  strings §19.5's consent screen shows, so §13's pane can repeat them)*. `connection_revoke`
  takes `{ id }` and is what the Connected clients pane's Revoke button fronts (§13;
  `/settings/clients`, formerly `/oauth/connections`). These exist because §19's connections
  are grants-shaped, not credential-shaped: the parity invariant below applies to them
  in full, and the consent SCREEN — not the binding it writes — is the browser-only part.

- `hub_settings_get` — `{}` → `{ settings: { defaultTimeoutMs, maxTimeoutMs } }`,
  reading the absent-row default pair `30_000/30_000`.
- `hub_settings_update` — requires both `{ default_timeout_ms, max_timeout_ms }`,
  validates `1_000 <= default <= max <= 300_000`, atomically upserts, and returns the
  same settings shape. `adminOpsFor` applies unchanged, so owner sessions and admin
  tokens may call both.

- `audit_query` — `{ principal?, app?, event?, tool?, session?, since?, until?,
  limit? (default 100), offset? (default 0) }` → `{ rows, total }`, newest first
  (`session` matches `client_session_id`, §5); `total`
  counts every row matching the filters (a COUNT over the retention-pruned table is
  cheap, and it backs the web UI's page numbers and "N events match" line). Rows carry
  the recorded body columns when present (§15) — post-redaction and stub-substituted,
  like everything persisted. Read-only;
  like everything else, `pmcp audit` is sugar over this tool.
  *(Amended 2026-09-21, decision 36 — four options, each described to the model in the
  house style. `id?` (a count): one row by id, owner-scoped like every other read, so a row
  in another namespace is absent exactly as an id that never existed is — §13's record read.
  `text?`: a case-insensitive substring over `principal`, `event`, `app`, `tool`,
  `client_session_id`, `detail`, `args_json` and `result_json`, OR-ed across the eight; a
  `LIKE` with an explicit `ESCAPE` character, and `%`, `_` and the escape character itself
  escaped in the needle, so a search for `%` matches a literal `%` and not every row. It is
  a scan of a retention-pruned table and gets **no index**, by decision: the window is seven
  days (§15), and an index over eight columns would tax every write of the hub to speed up
  one reader's search box. Blank or whitespace-only is no filter, so an empty box is not a
  filter matching nothing. `bodies?` (a flag, default true): `false` selects every column
  **except** the two body ones and adds `argsHead` — the first `AUDIT_ARGS_HEAD_CHARS`
  characters of the STORED arguments JSON, already masked and possibly an oversize stub's own
  JSON, absent when the row recorded no arguments — and `hasResult`, which says a result
  column exists without shipping it. The projection happens in **SQL**, not in the Worker: a
  reader that lists thousands of rows must never parse a body of up to
  `AUDIT_BODY_CAP_BYTES` in order to throw it away, which is a memory ceiling in-process
  tests cannot see (§16). And `outcome?`: a **sixth exact filter** beside the five, a
  single-valued `text` field like them — "Exact outcome string, e.g. ok or -32001." — the
  raw recorded value (§5) and never one of §13's five display classes, which fold two codes
  into `denied` and are the page's own grouping. All six exact filters stay
  **single-valued** on the op. What is *not* on the op is the module read's own two forms:
  the **list form** — one value **or a list** per exact filter, a list matching any of its
  values, an empty list being no filter — and the **pair form**, `targets`, which matches
  `(app, tool)` pairs rather than the two columns independently, because §13's export selects
  tools by their app and two independent lists would widen to their cross product. Exactly
  one caller uses either: the JSONL export, which §13's explorer links with a whole selection
  in it. Neither is an op capability, so the parity list below is unchanged, and so is the
  form-fields parity direction — `/audit` renders no form at all. A body-less row is the same
  row minus two columns, never a second shape with a second meaning.)*

Every tool that takes an app slug rejects both virtual slugs `pmcp` and `hub` uniformly.
`app_create` additionally refuses static `/apps/` route segments. Mutating tools write
one bounded `admin.<tool>` decision row; alias writes use the existing `admin.app_update`
summary and never log a discovery-progress row.

`pmcp` and `hub` are reserved virtual slugs with no `app` rows. `app_list` includes
`pmcp` as the existing `builtin: true` inventory row and never includes `hub`. Agents
cannot hold `pmcp` grants. Admin credentials remain unable to address aggregate or real
app endpoints, but may address scoped `/mcp/hub`; their program snapshot contains only
the operations returned by `adminOpsFor`, still excluding `approval_decide` and
`admin_token_issue`.

**Parity invariant, pinned**: anything the web UI or CLI can do has an equivalent
`pmcp` tool — UI and CLI are presentation layers, so an AI agent holding an admin
token can do everything the owner can. Exceptions, also pinned: the auth/credential
family (login, device approval, TOTP/passkey enrollment, sessions, passwords — §12's
users script and §13's `/settings`; deliberately never exposed to models), the
upstream-OAuth consent redirect (browser-only; its Disconnect counterpart *is* a
tool) — *(amended 2026-08-26: and §19's **inbound** consent screen, the same exception
for the same reason: `/oauth/consent` and every `/api/auth/oauth2/*` endpoint under it
are a browser interaction that mints authority, so they get no tool, while
`connection_list`/`connection_revoke` cover everything the connections page can do)* —
and `/audit`'s JSONL export (a streaming serialization of `audit_query` — same
rows, different framing) *(amended 2026-09-21, decision 36: the export's repeated
`principal` / `app` / `event` / `tool` / `session` / `outcome` and `target` keys sit inside
this same exception and do not widen it — they are the module read's list form and its pair
form, reached only through the serialization that was already excepted, and every one of them
is expressible to `audit_query` one value, or one `app` + `tool` pair, per call, which is why
`outcome` is on the op and not only in the module. The explorer itself is not an exception:
its two reads are that op with `bodies: false` and with `id`, both of which an admin token
can call)*.

The CLI performs admin operations on scoped `/mcp/pmcp`; there is no aggregate admin
alias. Its generic `pmcp call pmcp <operation>` form reaches every operation admitted by
the presented credential. The only non-MCP traffic is the auth-session family:
`login` and `logout` ride better-auth's endpoints unchanged, while `whoami` is a
hub-owned route,
`GET /api/whoami` (`whoami` can't be MCP even in principle: endpoint URLs embed the
username, which is exactly what `whoami` discovers — and it must also resolve
`pmcp_agt_` keys, which better-auth cannot, §4). Resolution mirrors §7 step 1: a
`pmcp_agt_`-prefixed bearer → SHA-256 lookup in `token` with an explicit
`kind = 'agent'` check (unrevoked, unexpired, `ref_id` resolves to a live
agent) → `{ "principal": "agent:<slug>", "namespace": "<owner username>" }`; a
`pmcp_app_`-prefixed bearer → **401**, never a session lookup; *(amended 2026-08-26,
§19: a **JWT-shaped** bearer (§19.6 step 3's predicate) → **401** as well — never a
session lookup, and never the OAuth leg either. §19's leg runs **only** on
`/<user>/mcp*`, because its audience check needs the addressed namespace's canonical URL
and this route has no `<user>` in it to supply one; off that path a JWT-shaped bearer is
not a credential. Pinned in both directions so the two resolvers cannot drift into a
version where `whoami` answers `agent:<slug>` for a token the door itself would refuse — the
"mirrors §7 step 1" sentence above is a claim two implementations must keep true, not a
description of one of them;)* anything else →
better-auth session lookup → `{ "principal": "user:<name>", "namespace": "<name>" }`;
no valid principal → **401** with `WWW-Authenticate: Bearer` (the bare challenge —
`/api/whoami` is not an MCP resource and names no `resource_metadata`, §19.2). This
response shape is pinned — it is the CLI↔server contract §10 depends on.

