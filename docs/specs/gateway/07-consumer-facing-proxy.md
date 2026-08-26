## 7. Consumer-facing proxy

Two shapes, one pipeline — both stateless 2026-07-28 MCP endpoints (via
`createMcpHandler`, user and service resolved from the URL):

- `POST /<user>/mcp` — **aggregated**: every tool the caller may use across `<user>`'s
  services, tool names prefixed `<slug>_<tool>`. Slugs contain no `_`, so the first `_`
  splits the name unambiguously. The built-in `pmcp` service participates like any
  other — owners see `pmcp_service_list` etc.; service accounts can't hold `pmcp`
  grants (§8), so admin tools never reach them.
- `POST /<user>/mcp/<slug>` — **scoped** to one service, unprefixed tool names. This is
  also how `pmcp` is reached (`/<user>/mcp/pmcp`).

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
   Resolution: `pmcp_sa_` prefix → SHA-256 lookup
   in `token` with an explicit `kind = 'service_account'` check (unrevoked, unexpired,
   `ref_id` resolves to a live service account) → service account; `pmcp_svc_` /
   `pmcp_sa_`-prefixed tokens **never** fall through to session lookup; anything else →
   *(amended 2026-08-26, §19: a **JWT-shaped** bearer — exactly three `.`-separated
   base64url segments, the predicate pinned byte-for-byte in §19.6 step 3 because it is
   what selects between two credential regimes — is answered by the OAuth leg **alone**:
   signature, issuer, audience, token type, `mcp` scope and binding row, which together
   answer **service account**, so nothing past this step knows the difference. The leg is
   **terminal and fails closed**: every failure in it is a 401, and none of them falls
   through to the session lookup — the same hard rule the `pmcp_` prefixes already carry
   one clause earlier, for a sharper reason. better-auth can resolve some of its own
   signed tokens to a *session*, and a session resolves to the **owner**; a fall-through
   would turn "this token's binding was revoked" into "this token is the owner", the
   exact inversion §18 decision 23 forbids. The leg runs **only on `/<user>/mcp*`**,
   where the addressed namespace supplies the canonical URL its audience check needs;
   §8's `/api/whoami` mirrors the rest of this step but refuses a JWT-shaped bearer
   outright, because it has no `<user>` to supply one. Then)* better-auth session lookup
   → user. Failure
   matrix: any request that doesn't resolve
   to a valid principal → **401** with a `WWW-Authenticate: Bearer` header, regardless
   of whether `<user>` exists (so unauthenticated probes can't enumerate usernames)
   — *(amended 2026-08-26, §19: on `/<user>/mcp` that header additionally carries
   `error="invalid_token"` and the `resource_metadata` URL, interpolated from the
   request **path** and never from a lookup, so the challenge on a live namespace and
   on a nonexistent one stay the same bytes)*. A
   *resolved* principal on another user's namespace (or a nonexistent user) → **404**
   (namespaces don't leak existence).
2. Resolve the allowed-tool filter (per service):
   - owner → all tools (sees everything in their namespace);
   - service account → the union of anchored-regex patterns of its granted roles,
     resolved against the service's `roles_json` **at request time**; the built-in
     `all` role contributes `.*` without ever appearing in `roles_json`. A granted role no
     longer present in `roles_json` resolves to the empty pattern set — it still counts
     as a grant (the account gets an empty `tools/list` and `-32001`, not a 404). On the
     scoped endpoint a service account gets **404** both for a nonexistent slug and for
     a service it holds no grants on — indistinguishable, so zero-grant accounts can't
     enumerate the namespace. The aggregated endpoint spans the services with at least
     one grant.

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
   - `server/discover` → answered by the Worker (hub capabilities).
   - `tools/list` → tunneled: served from the DO's **cached** list (kept in DO SQLite,
     so it survives disconnects — deploy-induced reconnect flapping doesn't churn agent
     tool lists; a service that has never connected lists no tools). Proxied: forwarded
     live to the upstream endpoint with the stored auth headers. Both filtered by the
     allowed patterns; aggregated adds the slug prefix and fans out over the relevant
     services **in parallel**, skipping archived ones, with a **10 s per-upstream
     deadline** (inside §15's 30 s request budget — tunneled services answer from cache
     and are unaffected). A proxied upstream that errors, times out, or is in
     needs-reconnect (§7, "Upstream OAuth") contributes zero tools and the aggregated
     list still succeeds; the omitted slugs are reported in the result's `_meta`
     (`pmcp/unavailable: ["<slug>", …]`) and logged as an ops event (not an audit row —
     §15 keeps `tools/list` out of audit). The scoped endpoint is where that failure
     surfaces: scoped `tools/list` against an unreachable or needs-reconnect proxied
     upstream fails `-32000`, and an archived service fails with `-32002` like every
     other request to it. `ttlMs`/`cacheScope` hints set so clients can cache.
     *(Amended 2026-08-26: `prompts/list` obeys every sentence of this bullet — same
     cache, same live fetch, same filter, same `<slug>_` prefix, same fan-out, same
     `_meta` — and §20 adds `resources/list`, `resources/templates/list`,
     `resources/read`, `prompts/get` and `completion/complete` with the scoping rules
     it pins there.)*
   - `tools/call` → (aggregated: split off the slug prefix first; a prefix matching no
     service → `-32001`, indistinguishable from not-permitted) checks run in a fixed
     order, identical on both endpoint shapes: **filter first** (`-32001` "tool not
     permitted" — so an ungranted account can't even learn a service is archived), then
     **archived** (`-32002`), then the **approval gate** (`-32003`, below), then
     **availability** (tunnel-not-connected or upstream-unreachable → `-32000` "service
     unavailable"). Passing all four, the call is forwarded — through the DO to the live
     connection (tunneled) or to the upstream endpoint (proxied) — with the caller
     identity attached (below), and the response relayed back verbatim. For proxied
     services, "verbatim" applies only to a well-formed JSON-RPC response from the
     upstream; any HTTP-level failure — non-2xx status, a body that is not a JSON-RPC
     message, TLS or transport error — maps to `-32000` with a generic "service
     unavailable" message. The upstream's status line, headers (including
     `WWW-Authenticate`), and body are never echoed to the consumer (extending §15's
     log-hygiene rule); the audit row's `detail` records the failure class (e.g.
     `upstream_status: 401` vs `unreachable`) so the owner can tell expired static
     headers from a down upstream.
   - anything else → `-32601`. *(Amended 2026-08-26: §20's seven methods join this
     table; everything outside it — `subscriptions/listen`, `logging/*`, any
     server-initiated request — is still `-32601`, and §20 records why for each.)*

### Approval flow

When the caller's only path to a tool is through approval-mode grants (§2), the call
does not execute on its own. The gate consults **known availability first**: a service
the hub already knows cannot execute — tunneled with no live registered connection,
proxied flagged `not_connected` or `needs_reconnect` — fails `-32000` before any
approval row is read, created, or consumed. The owner is never asked to approve a call
that cannot run (no pending row, no push), and an existing approved pass survives
untouched; the agent's retry once the service returns is what opens the pending. This
is stored knowledge only — no dial is attempted, so a `connected` proxied upstream
that is genuinely unreachable still surfaces at dispatch. Past that refusal:

1. The Worker looks for an `approval` row matching (account, service, tool,
   `args_hash`) with `status: approved` and unexpired. Found → the call proceeds
   through the availability check; on unavailability the row is left `approved` — an
   approved retry that hits an offline service gets `-32000` **without consuming the
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
   the service (every `tools/call` is at-most-once, §15), so reverting the row would
   risk a second execution — the caller's retry gets a fresh `-32003` and the owner
   re-approves. One exception restores the row: a leg whose relayed result is MRTR
   `input_required` (below) flips it back to `approved` with the same CAS discipline,
   so the exchange can continue on the original approval.
2. Otherwise, if an unexpired `pending` row already exists for the same (account,
   service, tool, `args_hash`), no new row is inserted and no new `approval.requested`
   audit row is written — the reply is `-32003` carrying that row's existing
   `approvalId`/`expiresAt`, so retries see a stable id and link. Only when no such
   row exists does it record a fresh `pending` approval — arguments stored
   **post-redaction** (below); for tunneled services a pending row is only created for
   a tool present in the cached catalog (no schema → no redaction map → refuse with
   `-32001` instead, the same code as not-permitted/unknown, so a probing agent cannot
   use the refusal to map its own grant patterns; such a call could not execute
   anyway, and the catalog heals at the service's next registration) — and reply with JSON-RPC
   error **`-32003`** ("approval required"), whose `data` carries
   `{ approvalId, approvalUrl, expiresAt }`. The message text includes the URL too, so
   an agent that only surfaces error strings still hands the user something
   actionable. `approval.tool` stores the **unprefixed** tool name (aggregated calls
   split off the slug prefix before the gate, above), so retries through either
   endpoint shape match the same row.
3. The owner opens the link (or `pmcp approvals`), sees the request detail — account,
   service, tool, redacted arguments, requested time — and approves or rejects.
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
result or service error consumes it, with `expires_at` (1 h) bounding the exchange.

Approvals are single-use, args-bound, and expire 1 h after creation. Every transition
writes an audit row (`approval.requested` / `approval.approved` / `approval.rejected` /
`approval.expired`). Expiry is enforced **lazily**: every path that reads or decides
approvals — the step-1 and step-2 lookups, `approval_list`, `/approvals`,
`approval_decide` — treats `expires_at < now` as expired regardless of stored status,
and at that moment flips any such `pending` row to `expired`, writing the
`approval.expired` audit row exactly once. The daily cron (§15) additionally sweeps
remaining past-expiry `pending` rows to `expired` (same audit row) before pruning;
there is no hourly job. v1 never blocks the original request while waiting —
blocking-until-decided is explicitly future work. The owner is push-notified instead:
creating a `pending` approval row sends a Web Push to every `push_subscription` row
(§5, §13) naming the service and tool plus the approval id — never arguments (push
payloads rest on third-party push services; §15's hygiene applies). Tapping the
notification opens `/approvals/<id>`. Push is best-effort; the dashboard stays the
source of truth.
`tools/list` shows approval-gated tools like any other (the agent must see them to
call them).

### Caller identity forwarding

Services can do their own fine-grained authorization on top of the hub's role gate —
useful when one tool serves several roles. Every forwarded `tools/call` carries the
caller's identity and resolved roles (proxied: only when enabled, below):

- **Tunneled**: `_meta` fields on the forwarded request —
  `hub/principal` (`"sa:claude"` or `"user:ahrzb"`) and `hub/roles` (the caller's
  granted role names on this service, exactly as granted — the built-in wildcard is
  forwarded literally as `"all"`, never expanded into declared role names; owners get
  `["all"]`). The client libraries surface these on the tool context (e.g.
  `ctx.principal`, `ctx.roles`, `ctx.has_role("editor")`); `has_role(x)` returns true
  when the list contains `x` or `"all"`, so owner and `all`-granted calls behave
  identically, and `all` can never collide with a real role name (§6 rejects it in
  declarations).
- **Proxied**: only when the service sets `forward_identity: true` (default **false**):
  real HTTP headers on the upstream request — `X-Pmcp-Principal` and `X-Pmcp-Roles`
  (comma-separated, same values — including a literal `all`) — so an upstream you also
  control can branch on them. Third-party upstreams (Notion, Linear) have no need for
  internal identifiers, so with the flag off no `X-Pmcp-*` headers are sent.

The `hub/` prefix in `_meta` is **reserved**: before forwarding, the hub deletes every
consumer-supplied `_meta` key beginning with `hub/` and then sets its own values —
overwrite, never merge — so any `hub/*` field a service sees was written by the hub,
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
unrecognized vendor `_meta` still passes through to services untouched, as above.

Alongside identity, the hub forwards the consumer's declared
`io.modelcontextprotocol/clientCapabilities` unchanged: copied into the forwarded
request's `_meta` (tunneled, §6) and into the per-request `Client` configuration so
the upstream sees the consumer's capabilities, not the hub's (proxied). An
`input_required` result flows back to the consumer through the existing relay-verbatim
path, and the consumer's retry (with `inputResponses` + `requestState`) is an ordinary
`tools/call` re-entering the same pipeline — the hub itself never answers an
inputRequest. Legacy consumers that declare no capabilities are forwarded `{}`, so
services correctly refrain from elicitation/sampling for them.

Identity is informational for the service's own logic; the hub's grant check has
already run and services must not treat these fields as secrets. Services *may* trust
`hub/*` values for their own fine-grained checks precisely because the hub strips
inbound copies — a consumer cannot inject them.

### Upstream OAuth (proxied services)

A proxied service's upstream auth is one of two kinds, declared as `auth: headers`
(default) or `auth: oauth` on the service:

- **headers** — static headers stored via `service_set_upstream_auth` (as before).
- **oauth** — for upstreams that require sign-in (Linear, etc.). The owner clicks
  **Connect** on the `/services` page (or follows the URL `pmcp connect <slug>`
  prints): the hub discovers the upstream's authorization server via its RFC 9728
  protected-resource metadata, obtains a client identity (CIMD document hosted by the
  hub, falling back to Dynamic Client Registration where the AS still wants it), and
  runs the authorization-code + PKCE flow in the owner's browser with callback
  `/oauth/upstream/callback`. Connect initiation mints a one-time unguessable `state`,
  stored server-side bound to {owner, service, expected AS issuer + token endpoint,
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
  refreshes proactively. A failed refresh flips the service to **needs reconnect** —
  calls fail `-32000` and `/services` shows a Reconnect button — and Disconnect wipes
  the bundle. Connect/disconnect/refresh-failure all write audit rows
  (`upstream.oauth_*`). The YAML declares only the `auth` mode; tokens never appear in
  it, and the mode is diffed like any other field.

### Sensitive-field redaction

Some tool arguments and results (passwords, tokens) must never be persisted — not
even in the approval record or the audit body columns (§15). Sensitivity is declared
per direction, from two sources, unioned:

- **Schema-declared** (tunneled): any property marked with standard JSON Schema
  **`writeOnly: true`** (at any depth) in a tool's input **or output** schema is
  sensitive. The hub derives both maps from the catalog cached in the service's DO
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
  catalog warm — echoed to the service and logged; registration still succeeds —
  and such a tool is cached **schema-unsound**: it has no derivable redaction map,
  so approval-gated calls refuse `-32001` (the catalog-miss rule below) and its
  bodies are never recorded (§15). Inlining `$defs` client-side remains optional
  sugar, not a requirement.
- **Config-declared** (both kinds): the owner lists redaction paths per tool —
  `redact: { "<tool-or-pattern>": ["password", "credentials.token"] }` for
  arguments, and `redact_results:` (identical shape, applied to the result's
  `structuredContent`) — in the YAML / `service_update`. This is the **only** path
  for proxied services in v1: their `tools/list` is forwarded live and never cached,
  so there is no schema to derive from (honoring upstream `writeOnly` becomes
  possible if a proxied schema cache is ever added).

Redacted fields are replaced with `"‹redacted›"` before anything is stored or shown:
the approval `args_json` (§5), the audit body columns (`args_json` / `result_json`,
§15), any error message that echoes arguments, and any debug surface. "Stored or
shown" means the hub's OWN surfaces — approval detail, audit views, error echoes;
the caller's live JSON-RPC reply is never redacted (a `token_issue` caller must
receive the key, once — masking exists for persistence and display, not for the
wire). This extends
§15's log-hygiene rule. Only *structured* data is ever redactable — which is why
unstructured result content is never persisted at all, only stubbed (§15).

The hub terminates auth entirely; client tokens are never forwarded to services
(MCP audience-binding rules forbid pass-through anyway).

