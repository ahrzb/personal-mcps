## 7. Consumer-facing proxy

Three mounts, one authorization pipeline — stateless 2026-07-28 MCP POST endpoints
except for §21's held `subscriptions/listen` response:

- `POST /<user>/mcp` — the aggregate **hub** surface: only `hub_execute`,
  `hub_search_types`, and hub-owned declaration resources (§23). It has no application
  catalog and performs no generic first-underscore dispatch.
- `POST /<user>/mcp/hub` — the same virtual hub with unprefixed `execute` and
  `search_types`.
- `POST /<user>/mcp/<slug>` — one real app or virtual `pmcp`, with its canonical,
  unprefixed tools and the family surface §§20–21 assign to its kind.

The aggregate replacement is a clean cutover. Application callers use scoped endpoints;
there are no compatibility aliases for old `<slug>_<tool>` or prompt names.

Per request:

1. Authenticate. **`Authorization: Bearer` only** — session cookies are never consulted
   on `/<user>/mcp*` (this single rule removes the whole browser-CSRF surface for the
   admin MCP), tokens in query strings are rejected, `Content-Type: application/json`
   is required, and an `Origin` header, when present, must match the hub's own origin
   (else **403**); requests without an `Origin` pass — every legitimate consumer (CLI,
   agents, server-side MCP clients) is a non-browser client that sends none, so the
   check is pure defense-in-depth against browser-originated requests, with the same
   if-present-must-match semantics as the SDK's `originValidation` middleware (which
   `createMcpHandler` does not apply automatically — wire it in explicitly).
   Resolution: `pmcp_agt_` prefix → SHA-256 lookup
   in `token` with an explicit `kind = 'agent'` check (unrevoked, unexpired,
   `ref_id` resolves to a live agent) → agent; `pmcp_app_` /
   `pmcp_agt_`-prefixed tokens **never** fall through to session lookup; anything else →
   *(amended 2026-08-26, §19: a **JWT-shaped** bearer — exactly three `.`-separated
   base64url segments, the predicate pinned byte-for-byte in §19.6 step 3 because it is
   what selects between two credential regimes — is answered by the OAuth leg **alone**:
   signature, issuer, audience, token type, `mcp` scope and binding row, which together
   answer **agent**, so nothing past this step knows the difference. The leg is
   **terminal and fails closed**: every failure in it is a 401, and none of them falls
   through to the session lookup — the same hard rule the `pmcp_` prefixes already carry
   one clause earlier, for a sharper reason. better-auth can resolve some of its own
   signed tokens to a *session*, and a session resolves to the **owner**; a fall-through
   would turn "this token's binding was revoked" into "this token is the owner", the
   exact inversion §18 decision 23 forbids. The leg runs **only on `/<user>/mcp*`**,
   where the addressed namespace supplies the canonical URL its audience check needs;
   §8's `/api/whoami` mirrors the rest of this step but refuses a JWT-shaped bearer
   outright, because it has no `<user>` to supply one. Then)* better-auth session lookup
   → user. Failure matrix: any request that does not resolve to a valid
   `AuthenticatedCaller`
   (`{ principal, credential }`, §23.4) → **401** with a
   `WWW-Authenticate: Bearer` header, regardless of whether `<user>` exists (so
   unauthenticated probes cannot enumerate usernames). On `/<user>/mcp*` that header
   additionally carries `error="invalid_token"` and the path-derived
   `resource_metadata` URL, byte-identical for live and absent namespaces. A resolved
   principal on another user's namespace (or a nonexistent user) → **404**.
   `Principal` remains the authorization/audit identity. The credential reference is
   non-secret and supports §23 operation-time and final-publication reauthorization;
   its exact-bearer digest supplies only the Sandbox identity.
2. Resolve the allowed-tool filter (per app):
   - owner → all tools (sees everything in their namespace);
   - agent → the union of anchored-regex patterns of its granted roles,
     resolved against the app's `roles_json` **at request time**; the built-in
     `all` role contributes `.*` without ever appearing in `roles_json`.
     *(2026-09-16, decision 31: a grant entry may also be an **inline item** —
     `tool/<pattern>`, `prompt/<pattern>`, `resource/<uri-pattern>` (§8) — which
     contributes its own pattern to the union **in its own family only**, exactly as one
     of a role's patterns does and under the same composition rule: the strongest mode a
     matching entry carries wins, so allow beats approval. There is **no deny mode** —
     nothing on either side of this union subtracts; a subject nobody's entry matches is
     simply not reachable.)* A granted role no longer present in `roles_json` resolves
     to the empty pattern set — it still counts as a grant (the agent gets an empty
     `tools/list` and `-32001`, not a 404). On a real scoped endpoint an agent gets
     **404** both for a nonexistent slug and for an app it holds no grants on. Virtual
     `hub` is deliberately addressable by a zero-grant agent; its fixed access filter
     grants only the §23 surface. Aggregate hub admission likewise does not require an
     app grant.

   Pattern semantics, pinned: compile as `^(?:<pattern>)$` with no flags (naive
   `'^'+p+'$'` breaks on top-level `|` — `^foo|bar$` matches `foox` via its `^foo`
   branch; §16 has the regression test). A pattern consisting only of tool-name
   characters (`^[A-Za-z0-9._-]+$` — `*` and `|` fall outside this set, so
   `search_.*` and `a|b` still compile as regexes) is compared as a literal string,
   never compiled — so an exact-looking role entry `get.news` matches only the tool
   `get.news`, not `getXnews`.
3. Dispatch:
   - `initialize` → answered by the Worker (amended 2026-08-26, shift-left D7: the
     MCP handshake every standards-compliant client opens with — protocolVersion,
     capabilities, serverInfo — answered statelessly on both endpoint shapes; the
     follow-up `notifications/initialized` is a notification and is absorbed like
     every notification, 202 with no body. Before this amendment `initialize` fell
     to `-32601` and no real MCP client could connect).
   - `server/discover` → answered by the Worker from the same capability producer as
     `initialize`.
   - On aggregate or scoped `hub`, `tools/list`, hub `resources/list`,
     `resources/templates/list`, `resources/read`, `tools/call`, and
     `subscriptions/listen` follow §23. Every other family method is `-32601`.
   - On a real scoped app, `tools/list` is unchanged: tunneled apps use the DO's cached
     list, proxied apps forward live, both filter by current grants. Scoped unreachable
     or needs-reconnect proxied listing fails `-32000`; archived listing fails `-32002`.
     Prompts/resources/completions follow §20 and push follows §21.
   - `tools/call` on a real scoped app checks the current filter first (`-32001`),
     archived (`-32002`), the availability-aware approval gate (`-32003`), then dispatch
     availability (`-32000`). It forwards canonical names unmodified. A proxied
     HTTP/transport/protocol failure remains a generic `-32000` and exposes only its
     bounded failure class in audit.
   - A hub program operation resolves its explicit TypeScript map to canonical service
     and subject, then calls the same extracted `dispatchTool` or
     `dispatchResourceRead` used by ordinary scoped routes. The app id, current
     credential/grants, check order, redaction, metadata strip-then-set, approval,
     backend, and exactly-once audit are rechecked; no second authorization path exists.
   - Unknown methods return `-32601`; unknown/not-permitted addressed subjects return
     the existing indistinguishable `-32001`.

### Approval flow

When the caller's only path to a tool is through approval-mode grants (§2), the call
does not execute on its own. The gate consults **known availability first**: an app
the hub already knows cannot execute — tunneled with no live registered connection,
proxied flagged `not_connected` or `needs_reconnect` — fails `-32000` before any
approval row is read, created, or consumed. The owner is never asked to approve a call
that cannot run (no pending row, no push), and an existing approved pass survives
untouched; the agent's retry once the app returns is what opens the pending. This
is stored knowledge only — no dial is attempted, so a `connected` proxied upstream
that is genuinely unreachable still surfaces at dispatch. Past that refusal:

1. The Worker looks for an `approval` row matching (agent, app, tool,
   `args_hash`) with `status: approved` and unexpired. Found → the call proceeds
   through the availability check; on unavailability the row is left `approved` — an
   approved retry that hits an offline app gets `-32000` **without consuming the
   approval**, so the owner never has to re-approve because a bot was mid-reconnect.
   If availability passes, the Worker **claims the row atomically** before dispatching
   — a compare-and-set (`UPDATE approval SET status = 'used', decided_at = ? WHERE id
   = ? AND status = 'approved'`, checking the statement's changed-row count) — and
   dispatches only if the claim changed a row. A claim that changes no rows means a
   concurrent identical call already consumed the approval: treat it as no approval
   and fall through to step 2 (fresh `pending`, `-32003`). The initial SELECT alone
   never authorizes dispatch — N concurrent identical calls must resolve to exactly
   one execution. If dispatch fails *after* a successful claim (30 s timeout, socket
   dropped mid-call), the approval stays consumed: the call may already have reached
   the app (every `tools/call` is at-most-once, §15), so reverting the row would
   risk a second execution — the caller's retry gets a fresh `-32003` and the owner
   re-approves. One exception restores the row: a leg whose relayed result is MRTR
   `input_required` (below) flips it back to `approved` with the same CAS discipline,
   so the exchange can continue on the original approval.
2. Otherwise, if an unexpired `pending` row already exists for the same (agent,
   app, tool, `args_hash`), no new row is inserted and no new `approval.requested`
   audit row is written — the reply is `-32003` carrying that row's existing
   `approvalId`/`expiresAt`, so retries see a stable id and link. Only when no such
   row exists does it record a fresh `pending` approval — arguments stored
   **post-redaction** (below); for tunneled apps a pending row is only created for
   a tool present in the cached catalog (no schema → no redaction map → refuse with
   `-32001` instead, the same code as not-permitted/unknown, so a probing agent cannot
   use the refusal to map its own grant patterns; such a call could not execute
   anyway, and the catalog heals at the app's next registration) — and reply with JSON-RPC
   error **`-32003`** ("approval required"), whose `data` carries
   `{ approvalId, approvalUrl, expiresAt }`. The message text includes the URL too, so
   an agent that only surfaces error strings still hands the user something
   actionable. `approval.tool` stores the canonical unprefixed tool name. A direct
   scoped retry and a §23 program retry therefore match the same row; aggregate prefix
   parsing no longer exists.
3. The owner opens the link (or `pmcp approvals`), sees the request detail — agent,
   app, tool, redacted arguments, requested time — and approves or rejects.
4. The agent retries the **identical** call (same canonical-JSON arguments — the hash
   must match). Approved → executes (once); still pending → `-32003` with the same
   `approvalId` (no new row, per step 2); rejected or expired → `-32003` again with a
   fresh pending record and link.

`args_hash` is computed over the **post-redaction** canonical JSON: no digest of a
sensitive value is ever persisted (a hash of a low-entropy password is offline-
crackable). The accepted trade-off, stated plainly: redacted fields are excluded from
the args binding, so a retry differing only in a sensitive field still matches — the
owner is approving the visible arguments.

MRTR (2026-07-28 Multi Round-Trip Requests): the args binding is `params.arguments`
only — `inputResponses` and `requestState` on a retry are excluded from `args_hash`,
excluded from the stored `args_json`, and never persisted or displayed anywhere
(elicited values are exactly the secrets `writeOnly` exists for; they pass through
the hub verbatim and never enter any persisted body — approval rows and the audit
body columns alike, §15). One approval covers the whole MRTR exchange: a
forwarded leg that returns `resultType: "input_required"` restores the claimed row to
`approved` (step 1), so follow-up legs (same `params.arguments`, plus
`inputResponses`/`requestState`) pass on the original approval until a `complete`
result or app error consumes it, with `expires_at` (1 h) bounding the exchange.

Approvals are single-use, args-bound, and expire 1 h after creation. Every transition
writes an audit row (`approval.requested` / `approval.approved` / `approval.rejected` /
`approval.expired`). *(Amended 2026-09-21, decision 36: so do the two `tools/call` rows at
either end of the wait — the row refused `-32003` at step 2 and the row dispatched after
step 1's successful claim each record `detail.approvalId` (§15). That is a ledger join and
not a wire change: the `-32003` already hands the caller `approvalId` in its `data`, a
dispatch under a claimed approval stays byte-identical to one that needed no approval, and
the `-32001` refusals this section makes indistinguishable gain no `reason` — the ledger
never becomes the oracle a refusal withholds.)* Expiry is enforced **lazily**: every path
that reads or decides
approvals — the step-1 and step-2 lookups, `approval_list`, `/approvals`,
`approval_decide` — treats `expires_at < now` as expired regardless of stored status,
and at that moment flips any such `pending` row to `expired`, writing the
`approval.expired` audit row exactly once. The daily cron (§15) additionally sweeps
remaining past-expiry `pending` rows to `expired` (same audit row) before pruning;
there is no hourly job. v1 never blocks the original request while waiting —
blocking-until-decided is explicitly future work. The owner is push-notified instead:
creating a `pending` approval row sends a Web Push to every `push_subscription` row
(§5, §13) naming the app and tool plus the approval id — never arguments (push
payloads rest on third-party push services; §15's hygiene applies). Tapping the
notification opens `/approvals/<id>`. Push is best-effort; the dashboard stays the
source of truth.
`tools/list` shows approval-gated tools like any other (the agent must see them to
call them).

### Caller identity forwarding

Apps can do their own fine-grained authorization on top of the hub's role gate —
useful when one tool serves several roles. Every forwarded `tools/call` carries the
caller's identity and resolved roles (proxied: only when enabled, below):

- **Tunneled**: `_meta` fields on the forwarded request —
  `hub/principal` (`"agent:claude"` or `"user:ahrzb"`) and `hub/roles` (the caller's
  granted role names on this app, exactly as granted — the built-in wildcard is
  forwarded literally as `"all"`, never expanded into declared role names; owners get
  `["all"]`). The client libraries surface these on the tool context (e.g.
  `ctx.principal`, `ctx.roles`, `ctx.has_role("editor")`); `has_role(x)` returns true
  when the list contains `x` or `"all"`, so owner and `all`-granted calls behave
  identically, and `all` can never collide with a real role name (§6 rejects it in
  declarations).
- **Proxied**: only when the app sets `forward_identity: true` (default **false**):
  real HTTP headers on the upstream request — `X-Pmcp-Principal` and `X-Pmcp-Roles`
  (comma-separated, same values — including a literal `all`) — so an upstream you also
  control can branch on them. Third-party upstreams (Notion, Linear) have no need for
  internal identifiers, so with the flag off no `X-Pmcp-*` headers are sent.

The `hub/` prefix in `_meta` is **reserved**: before forwarding, the hub deletes every
consumer-supplied `_meta` key beginning with `hub/` and then sets its own values —
overwrite, never merge — so any `hub/*` field an app sees was written by the hub,
never the caller. (Other consumer `_meta` keys, e.g. `progressToken`, pass through
untouched. The proxied analogue holds by construction: `X-Pmcp-*` headers are set on
the hub's own upstream request, which never copies consumer headers.)

**Client metadata capture**: AI consumers identify themselves — `clientInfo`
(name/version) plus vendor `_meta` keys such as a client session id (Claude Code sends
one). The hub copies `clientInfo.name`, `clientInfo.version`, and a recognized
session-id key onto each `tools/call` audit row (`client_name` / `client_version` /
`client_session_id`, §5), each truncated to 128 chars and treated strictly as untrusted
display data — never parsed, never part of any authorization decision. The recognized
session-id keys are a small allowlist maintained in code (Claude Code's first);
unrecognized vendor `_meta` still passes through to apps untouched, as above.

Alongside identity, the hub forwards the consumer's declared
`io.modelcontextprotocol/clientCapabilities` unchanged: copied into the forwarded
request's `_meta` (tunneled, §6) and into the per-request `Client` configuration so
the upstream sees the consumer's capabilities, not the hub's (proxied). An
`input_required` result flows back to the consumer through the existing relay-verbatim
path, and the consumer's retry (with `inputResponses` + `requestState`) is an ordinary
`tools/call` re-entering the same pipeline — the hub itself never answers an
inputRequest. Legacy consumers that declare no capabilities are forwarded `{}`, so
apps correctly refrain from elicitation/sampling for them.

Identity is informational for the app's own logic; the hub's grant check has
already run and apps must not treat these fields as secrets. Apps *may* trust
`hub/*` values for their own fine-grained checks precisely because the hub strips
inbound copies — a consumer cannot inject them.

### Hub-program dispatch context

Hub execution calls never inherit arbitrary outer `_meta`. They advertise empty
`io.modelcontextprotocol/clientCapabilities`, while the executor carries bounded
display-only client metadata separately for audit. `prepareForward` remains the single
authoritative `hub/*` strip-then-set step. An optional earlier absolute deadline travels
through backend context only for execution-originated operations; the effective backend
timeout is the minimum of the existing direct-call timeout, ten seconds, and the
remaining execution budget. Direct scoped behavior retains its existing 30-second deadline.

### Upstream OAuth (proxied apps)

A proxied app's upstream auth is one of two kinds, declared as `auth: headers`
(default) or `auth: oauth` on the app:

- **headers** — static headers stored via `app_set_upstream_auth` (as before).
- **oauth** — for upstreams that require sign-in (Linear, etc.). The owner clicks
  **Connect** on the `/apps` page (or follows the URL `pmcp connect <slug>`
  prints): the hub discovers the upstream's authorization server via its RFC 9728
  protected-resource metadata, obtains a client identity (CIMD document hosted by the
  hub, falling back to Dynamic Client Registration where the AS still wants it), and
  runs the authorization-code + PKCE flow in the owner's browser with callback
  `/oauth/upstream/callback`. Connect initiation mints a one-time unguessable `state`,
  stored server-side bound to {owner, app, expected AS issuer + token endpoint,
  PKCE verifier} and to the initiating cookie session, expiring in ~10 minutes. PKCE
  is not the CSRF defense here — RFC 9700 permits that only when the client has
  ensured the AS enforces PKCE, which a dynamically discovered upstream can't
  guarantee. The callback requires a valid owner cookie session (§13), resolves
  `state` to a live, unconsumed record belonging to that same session — consuming it
  single-use; missing, mismatched, expired, or replayed `state` rejects the callback
  with nothing stored — and, when the AS advertises RFC 9207 support, verifies the
  response's `iss` equals the recorded issuer. Because the one callback URL is shared
  across authorization servers, the `state` record is also the mix-up defense: the
  code is only ever redeemed, with the bound verifier, at the token endpoint recorded
  at initiation. The token bundle lands in the encrypted
  `upstream_auth_json`; the hub attaches `Authorization: Bearer` upstream and
  refreshes proactively. A failed refresh flips the app to **needs reconnect** —
  calls fail `-32000` and `/apps` shows a Reconnect button — and Disconnect wipes
  the bundle. Connect/disconnect/refresh-failure all write audit rows
  (`upstream.oauth_*`). The auth mode is ordinary app configuration; token bundles are
  write-only and never returned.

### Sensitive-field redaction

Some tool arguments and results (passwords, tokens) must never be persisted — not
even in the approval record or the audit body columns (§15). Sensitivity is declared
per direction, from two sources, unioned:

- **Schema-declared** (tunneled): any property marked with standard JSON Schema
  **`writeOnly: true`** (at any depth) in a tool's input **or output** schema is
  sensitive. The hub derives both maps from the catalog cached in the app's DO
  at `tools/list` time; the client libraries make declaring it natural (§11): a
  `Secret` field type in pydantic-/zod-style tool definitions emits `writeOnly`
  wherever it appears — input and output models alike — plus path-based sugar for
  hand-written schemas. On an *output* schema the keyword is the hub's internal
  marker only (its standard meaning, "sent but never returned", doesn't fit an
  output field): the hub strips `writeOnly` from every outputSchema it serves to
  consumers, so the co-opt never reaches the wire. Input schemas are served as
  declared — `writeOnly` on an input is standard usage.

  "At any depth" includes indirection, because SDK schema generators emit
  `$defs`+`$ref` by default: the hub's walk resolves same-document `#/…` refs by
  JSON Pointer, unions marks across `allOf`/`anyOf`/`oneOf` branches (secret in any
  branch masks — over-masking is safe), and cuts secret-free cycles. What the walk
  cannot soundly resolve is refused LOUDLY, never skipped — an unresolved ref could
  conceal a mark: external or non-local refs, `$id`/`$anchor`/`$dynamicRef`
  resolution, and a recursive cycle carrying a secret (its path set is infinite —
  no finite path list can express the mask). Violations are reported per tool at
  catalog warm — echoed to the app and logged; registration still succeeds —
  and such a tool is cached **schema-unsound**: it has no derivable redaction map,
  so approval-gated calls refuse `-32001` (the catalog-miss rule below) and its
  bodies are never recorded (§15). Inlining `$defs` client-side remains optional
  sugar, not a requirement.
- **Owner-declared** (both kinds): redaction paths per tool —
  `redact: { "<tool-or-pattern>": ["password", "credentials.token"] }` for arguments and
  `redact_results` for result `structuredContent` — are set through `app_update`, the web
  UI, or the provider. This is the only path for proxied apps in v1 because their
  `tools/list` is forwarded live and never cached.

Redacted fields are replaced with `"‹redacted›"` before anything is stored or shown:
the approval `args_json` (§5), the audit body columns (`args_json` / `result_json`,
§15), any error message that echoes arguments, and any debug surface. "Stored or
shown" means the hub's OWN surfaces — approval detail, audit views, error echoes;
the caller's live JSON-RPC reply is never redacted (a `token_issue` caller must
receive the key, once — masking exists for persistence and display, not for the
wire). This extends
§15's log-hygiene rule. Only *structured* data is ever redactable — which is why
unstructured result content is never persisted at all, only stubbed (§15).

The hub terminates auth entirely; client tokens are never forwarded to apps
(MCP audience-binding rules forbid pass-through anyway).

