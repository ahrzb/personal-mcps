## 8. Admin MCP (the built-in `pmcp` app)

Built into the Worker at `POST /<user>/mcp/pmcp` — same proxy pipeline, but tools are
implemented locally instead of forwarded to a DO, and every tool operates on the
namespace of the `<user>` in the URL (which step 1 already proved is the caller's own).
Tools (names final, shapes reviewed at implementation time):

- `app_list` / `app_get` — includes kind, declared roles *(amended 2026-08-26,
  §20.3: returned in the **canonical read shape** — a bare pattern list iff the role is
  tools-only, the per-family object otherwise, whichever spelling registered it. Pinned
  because `pmcp diff`'s stability depends on this response, not on how an app happened
  to declare itself)*, a proxied app's stored `capabilities` list *(amended
  2026-08-27: part of the row, absent when never configured — pinned for the same
  reason as roles; until this amendment the field was create-only and invisible to
  `pmcp diff`)*, redact paths
  (`redact` and `redact_results`), `log_bodies`, archived status, and for proxied
  apps the endpoint, the `auth` mode, and
  `forward_identity`; connection status and last seen apply to tunneled apps only
  (proxied rows report `kind: proxy` in their place). diff/apply depend on kind,
  endpoint, auth, forward_identity, roles, redact, redact_results, log_bodies, and
  archived all being readable here.
- `app_create` / `app_update` / `app_delete` — create takes `kind`,
  `redact` / `redact_results` (sensitive-field paths, §7 — either kind),
  `log_bodies` (audit body logging, §15 — either kind; absent defaults by kind,
  tunneled on / proxied off) and, for proxied apps,
  `endpoint`, `roles` (the virtual role definitions), `auth` (`headers` | `oauth`,
  §7), and `forward_identity` (identity headers, §7; default false); update takes the
  same minus `kind`, which is **immutable** (recreate to convert — conversion would
  orphan app tokens and DO state). Changing `auth` in either direction is accepted
  but destructive: any stored `upstream_auth_json` is wiped (audit row
  `upstream.auth_mode_changed`), leaving the app not-connected until the owner
  runs Connect (`auth: oauth`) or `app_set_upstream_auth` (`auth: headers`);
  `pmcp diff` flags a mode flip as destructive in the plan. `app_set_upstream_auth`
  is rejected on `auth: oauth` apps, and the Connect flow (§7) is rejected on
  `auth: headers` ones — each mode has exactly one credential path. `app_list` /
  `app_get` additionally report the OAuth connection status for `auth: oauth`
  apps (not connected / connected / needs reconnect). Proxied role definitions get the same validation
  as `hub/register` (§6): name charset, `all` rejected, patterns must compile, caps. Delete
  also deletes the app's `token` rows, tells its DO to close any live socket (code
  `4001`) and drop cached state (DO side effects apply to tunneled apps only —
  proxied apps have no DO and no tokens).
- `app_set_upstream_auth` — proxied only: stores the headers (e.g. a bearer token)
  the hub sends upstream. Imperative and write-only, like `token_issue` — secrets never
  appear in YAML or in read tools.
- `app_disconnect` — `auth: oauth` proxied apps only: wipes the stored token
  bundle (audit row `upstream.disconnected`), leaving the app not-connected until
  Connect runs again (§7). The web Disconnect button fronts this tool. Connect/Reconnect
  have no tool equivalent — the consent redirect is inherently a browser interaction
  (`pmcp connect` prints the URL).
- `app_archive` / `app_unarchive` — archive severs any live socket (close
  `4002`) and hides the app from consumers; everything is retained for unarchive
  (§6, "App lifecycle").
- `agent_list` / `agent_create` / `agent_delete` — delete also deletes the
  agent's `token` rows. `agent_list` returns each agent's grants inline
  (per app: role names and modes), so reading the full desired-state picture
  is one `app_list` plus one `agent_list` — the CLI diff planner depends on
  this; there is no separate grant-read tool.
- `grant_set` — replaces the full grant set for (agent, app); each entry is a
  role name plus optional mode (`reader` or `reader:approval`, the same syntax as §9).
  Applies the same role validation as the YAML layer (§9): undeclared roles warn for
  tunneled apps, hard-error for proxied ones; a role literally named `all` is never
  declarable, only grantable (it's the built-in).
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
  created/last-used, revoked state. `connection_revoke` takes `{ id }` and is what the
  `/oauth/connections` Revoke button fronts (§13). These exist because §19's connections
  are grants-shaped, not credential-shaped: the parity invariant below applies to them
  in full, and the consent SCREEN — not the binding it writes — is the browser-only part.

- `audit_query` — `{ principal?, app?, event?, tool?, session?, since?, until?,
  limit? (default 100), offset? (default 0) }` → `{ rows, total }`, newest first
  (`session` matches `client_session_id`, §5); `total`
  counts every row matching the filters (a COUNT over the retention-pruned table is
  cheap, and it backs the web UI's page numbers and "N events match" line). Rows carry
  the recorded body columns when present (§15) — post-redaction and stub-substituted,
  like everything persisted. Read-only;
  like everything else, `pmcp audit` is sugar over this tool.

Every tool that takes an app slug rejects `pmcp` with the same error (`grant_set`,
`app_*`, `token_issue` alike) — the reservation is uniform, not per-tool. Every
mutating `pmcp` tool writes an `admin.<tool>` audit row with a summary of the change
(never secrets — `token_issue` logs that a token was issued and for whom, not the key).

The `pmcp` slug is **reserved and virtual**: no `app` row exists for it.
`app_list` includes it flagged `builtin: true`. Access is admin (user) tokens only in v1 —
agents can't hold `pmcp` grants. Turning `pmcp` into a grantable app later
is a config change, not a design change.

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
rows, different framing).

The CLI performs every admin operation by calling these tools — the CLI has no private
admin API. (`diff`/`apply` are CLI-side compositions of `*_list` reads and `*_create` /
`*_delete` / `*_archive` / `*_unarchive` / `grant_set` writes.) The only non-MCP
traffic the CLI ever sends is the auth-session family: `login` and `logout` ride
better-auth's endpoints unchanged, while `whoami` is a hub-owned route,
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

