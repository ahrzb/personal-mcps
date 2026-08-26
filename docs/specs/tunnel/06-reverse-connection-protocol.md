## 6. Reverse connection protocol (tunneled service ↔ hub)

This section is tunnel-kind only; proxied services have no connection of their own.

Transport: WebSocket to `wss://<host>/connect`, `Authorization: Bearer pmcp_svc_…`.
The Worker verifies the service token — checking the token row's `kind` column
explicitly, not just the prefix — resolves the service (and its owner), and hands the
socket to `ServiceConnection` DO `getByName(service.id)` (the opaque id, not
`user/slug`, so deleting a user and recreating the same username can never rebind to a
stale DO), which calls `ctx.acceptWebSocket(ws, [service.id])`.

Upgrade response matrix — the status codes carry meaning for the client library:
- **401** — no/invalid/expired/revoked token, wrong token kind (`pmcp_sa_`, session), or
  a token whose service row is gone or is `kind: proxy`. Client treats this as fatal:
  stop and surface a credentials error (no retry loop on a dead credential).
- **403** — means exactly one thing: the service is archived. Client keeps retrying at
  max backoff so unarchiving heals automatically.
- Close `4001` after establishment (token revoked / service deleted) is treated like
  401: stop and surface. Close `4003` exists only for the row-deleted-between-upgrade-
  and-register race.

Framing: **one JSON-RPC 2.0 message per WebSocket text message** (WS already provides
message framing; each side generates UUID-string ids for the requests it initiates).
Two message namespaces:

1. **Control** — JSON-RPC methods prefixed `hub/`, handled by the client library, never
   reaching the user's MCP server:
   - `hub/register` (client → hub, first message):
     `{ "clientVersion": "...", "protocolVersion": "2026-07-28", "roles": { "<role>": ["<regex>", …] } }`
     *(amended 2026-08-26, §20: a role's value is **either** that bare pattern list —
     which means tools, forever, so every service written against this spec keeps
     registering unchanged — **or** the per-family object
     `{ "tools": [...], "prompts": [...], "resources": [...] }`, each key optional and
     defaulting to the empty list. Mixing the two spellings across roles in one
     declaration is fine; the two forms are the same declaration after normalization.)*
     The service identity comes **exclusively** from the authenticated token — the
     payload carries no service field, so a token for one slug can never touch another
     service's registration. The hub validates the declaration before accepting it:
     role names must match `[a-z0-9_-]{1,64}` (`all` is rejected — it's the resolver's
     built-in, §2), every pattern must compile as a regex, and pattern length (≤128 chars)
     and per-role pattern count (≤64) are capped — *(amended 2026-08-26: the count cap
     applies **per family list**, so the same two `limits.ts` constants bound a role's
     tool, prompt, and resource patterns each; an unknown family key is a violation like
     any other)* — violations get a JSON-RPC error reply
     and the socket is closed. The hub verifies the service row still exists (close
     `4003` if not), upserts `roles_json` in D1 and checks for **role drift**: both
     declarations are **normalized first** (§20.3 — a bare list becomes
     `{tools: [...]}`), and then, for each role name **and each family**, the old and new
     pattern lists are compared as sets of exact pattern strings, with a role *or a
     family* absent from either side treated as the empty set. Any role that holds ≥1
     live grant and any of whose family sets is not a subset of its old counterpart —
     a pattern added or textually changed, or a family that appears where there was none
     — writes a `connect.roles_widened` audit row listing the affected roles, the
     families, and their added/changed patterns. *(Amended 2026-08-26, §20: the
     per-family dimension is the load-bearing half of this rule now. A service that
     re-registers `"reader": ["get_news"]` as `"reader": {"tools": ["get_news"],
     "resources": ["file:///*"]}` has an unchanged **tools** set and has just handed every
     granted account the whole resource keyspace; a family-blind comparison sees a subset
     and writes nothing. Since §2's trust-boundary paragraph makes this row the only
     visibility into a service widening itself, comparing per family is what keeps that
     sentence true across three keyspaces. A family that *disappears* narrows the role and
     writes no row, exactly as removing a tool pattern does today — the row keeps meaning
     what its name says.)* The comparison is
     textual only; the hub never attempts regex-language containment (rewriting
     `get_news` to `get_.*` is logged because the string changed, not because the hub
     reasons about the language). Self-declared roles mean a compromised bot can widen
     its own roles; the blast radius stays inside that service, but the drift must be
     visible, not silent. The hub then replies `{ "ok": true }` and immediately issues
     `tools/list` to warm its cache — *(amended 2026-08-26, §20: preceded by one
     hub-originated `server/discover`, whose declared capabilities are cached beside the
     catalogs and decide which further lists are warmed. Warming blind would make every
     tools-only service log a spurious catalog-warm failure for three families it never
     claimed. **The client library answers `server/discover`, not the author's SDK**
     (§11): it is a hub↔library control question, no MCP SDK implements it, and every
     service already in the field runs a library that has never heard of it. The
     **fallback is therefore the load-bearing half of this rule** — a `-32601`, any other
     error, or a correlation timeout means "capabilities unknown", and the hub then warms
     **tools only**, exactly as it does today. A service whose library predates this
     change keeps the tool list it has always had; nothing in the field goes dark, and
     nothing about the discover answer can empty a catalog by failing. The two legs are
     sequential by construction — the answer decides which warms run — so the
     registration tail is worst-case **two** correlation timeouts wide: the discover leg,
     then the warms, which run concurrently with each other.)* A `roles` value of `{}`
     means "no roles declared" —
     the service is then reachable only by admin tokens or accounts granted the
     built-in `all` role.
   - `hub/replaced` (hub → client, notification): a newer connection for the same slug
     arrived; the old socket is closed with code `4000` after this. Eviction happens at
     **acceptance** of the new socket (`ctx.acceptWebSocket`), before its `hub/register`
     is seen — the DO never holds two sockets, preserving §2's at-most-one-connection
     invariant. Accepted consequence: if the new socket's registration then fails
     validation or never arrives, the old healthy connection is already gone and the
     service stays offline until the bot reconnects (a service-token holder can already
     deny service by connecting, so this adds no attacker capability). Client must NOT
     reconnect automatically in this case (two copies of a bot fighting for the slot is
     an operator error worth surfacing). The hub logs every replacement — with a stolen
     service token, eviction-and-impersonation looks exactly like this, so it's a
     security signal, not just noise.
2. **MCP** — everything else. The hub acts as the MCP *client*; the service is the MCP
   *server*. v1 forwarded `tools/list` and `tools/call`; *(amended 2026-08-26, §20:
   plus `server/discover`, `prompts/list`, `prompts/get`, `resources/list`,
   `resources/templates/list`, `resources/read` and `completion/complete` — the frame
   shape is unchanged, so the wire and both client libraries carry them with no new
   framing)*. The client library also sends
   `notifications/tools/list_changed` when the user's server changes its tool set; the DO
   invalidates its cache and re-lists — *(amended 2026-08-26: and the same for
   `notifications/prompts/list_changed` and `notifications/resources/list_changed`, each
   invalidating its own catalog key. These are the only service-originated frames the DO
   reads; every other one is still dropped. They stop at the hub — §20 forwards no
   notification to a consumer.)*

Handshake, pinned: the wire is stateless 2026-07-28-style — **`initialize` never crosses
the wire**. Hub-originated requests are self-contained, carrying all required `_meta`
protocol fields: `io.modelcontextprotocol/protocolVersion`, and
`io.modelcontextprotocol/clientCapabilities` **mirrored from the consumer's request** —
the hub asserts the calling client's capabilities, not its own (a legacy-lane consumer
that sent none gets `{}`, which per MRTR rules means the service must not emit
elicitation/sampling inputRequests for that caller). The client library performs
whatever session bootstrap its local SDK needs (synthesizing an initialize exchange
internally if the SDK requires one). After `hub/register` → `{ok: true}`, the first MCP
message from the hub is `server/discover` *(amended 2026-08-26, §20 — it was `tools/list`
before the capability warm existed)*, whose answer decides which catalog warms follow;
`tools/list` is one of them, and when the discover leg errors or times out it is the only
one.

Registration deadline, pinned: a socket that has not delivered a valid `hub/register`
within **10 s** of acceptance is closed with code `4004` (protocol error); the client
library treats this like any disconnect (reconnect with backoff). Any message other
than `hub/register` received before registration completes is a protocol error:
JSON-RPC error reply, then close `4004`. The hub never forwards consumer traffic to an
unregistered socket — until `hub/register` succeeds the service is offline and
`tools/call` fails `-32000`.

Liveness: the client library relies on WebSocket **protocol ping frames** (every ~25 s) —
the Cloudflare runtime auto-pongs these without waking the DO, keeping NATs open at zero
cost. No application-level heartbeat.

Reconnect: exponential backoff with jitter (1 s → 60 s cap), forever — deploys of the hub
terminate all sockets, so this is routine, not exceptional. In-flight requests at
disconnect time fail fast on the consumer side.

Request correlation in the DO: in-memory `Map<id, resolver>` with a hard **30 s timeout**
per request. This is hibernation-safe: an unresolved incoming request blocks hibernation,
so the map can only be lost when it is already empty or the DO is forcibly restarted (in
which case the caller gets an error anyway and retries).

### Service lifecycle

1. **Provisioned** — the owner creates the row (`service_create` / `apply`) and mints a
   service token (`token_issue`), which is handed to the bot. The token is the service's
   sole credential: it authenticates registration (the role declaration) and every
   (re)connection. Multiple tokens per service may be live at once, so rotation is
   issue-new → deploy → revoke-old (`last_used_at` in `token_list` shows which token
   the bot is actually on). Expiry is checked at upgrade only — an established socket
   outlives its token's `expires_at` until the next reconnect; that asymmetry is
   deliberate (revocation is the immediate path). A provisioned-but-never-connected
   service has no roles and lists no tools.
2. **Online / offline** — runtime status: **online** means the DO holds a live,
   **registered** socket (surfaced in `service_list` / `pmcp ls`); a socket accepted
   but not yet past `hub/register` is not online — the 10 s registration deadline
   bounds that window. Offline still serves the cached `tools/list`; only `tools/call`
   requires the connection.
3. **Archived** — a reversible parking state set by the owner (`service_archive`, or
   `archived: true` in YAML). While archived: connection attempts are rejected at the
   WebSocket upgrade (HTTP 403), an existing connection is severed (close `4002`), the
   service disappears from aggregated `tools/list`, and scoped calls fail with JSON-RPC
   `-32002` ("service archived"). Roles, grants, tokens, and the cached catalog are all
   retained — `service_unarchive` restores everything. The client library treats
   403/4002 as "keep retrying at max backoff", so unarchiving heals within a minute
   without touching the bot.
4. **Deleted** — terminal (`service_delete` / removal from YAML): grants cascade, tokens
   are deleted, the live socket is closed (`4001`), the DO's cached state is wiped.

Proxied services skip the connection-related states: their lifecycle is provisioned
(with `endpoint` + config-defined roles, no token) ↔ archived → deleted, with the same
archived semantics on the consumer side (`-32002`, hidden from aggregation).

