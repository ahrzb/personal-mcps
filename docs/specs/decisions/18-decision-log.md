## 18. Decisions made by default — review these

1. **CLI auth = device flow → session token**, not a full OAuth 2.1 provider (§14). The
   full provider is the documented upgrade path when external MCP clients need to log in
   on their own. *(Amended 2026-08-26: that upgrade landed as §19, and the CLI did **not**
   move onto it — the device flow issues an owner session, §19 issues service-account
   authority, and those are different powers. The CLI stays where it is.)*
2. **Namespaces are silos.** Each user fully controls their own namespace and can't see
   any other; there is no sharing, no global admin, no cross-namespace grants. Sharing a
   service between users would be a real design extension — out of scope until wanted.
3. **Tunneled services' roles live in service code**, declared at registration — the
   YAML only references them; central YAML definitions for tunneled roles were rejected
   because only the service knows its tools. Proxied services are the exception: their
   virtual roles are defined in config, because the upstream can't declare any.
4. ~~**v1 proxies tools only** — no resources, prompts, or push notification streams.~~
   **Revised 2026-08-26 (§20): the hub proxies the MCP data model.** Prompts,
   resources, resource templates and completions are served; MRTR (elicitation,
   sampling, roots) extends to `prompts/get` and `resources/read`. Only the
   *push* half of the original sentence survives: `subscriptions/listen` and every
   server→consumer notification stay out, because the consumer surface is POST/JSON
   with no stream and the DO↔worker seam is request/response — §20 records the reason
   per feature, and the corollary rule that no capability may be declared that the
   transport cannot honor (a declared `listChanged` would make a v2 client open a
   listen stream, get `-32601`, and spend its reopen budget). *(Re-revised 2026-09-01:
   the push half fell too — §21 serves `subscriptions/listen`, the consumer doorbells,
   and `resources/subscribe`/`updated`; decision 28 carries the call and the probe
   economics. Nothing of the original sentence survives.)*
5. **Usernames, not emails**, with synthesized placeholder emails internally.
6. **`apply` deletes by default** (after showing the diff and confirming) — the YAML is
   desired state, not additive patches.
7. Naming: repo `personal-mcps`, CLI/binary `pmcp`, packages `@personal-mcps/*` /
   `pmcp-client`.
8. **Service/service-account tokens are our own hashed-token table**, not the
   `@better-auth/api-key` plugin — the plugin can only bind keys to users/organizations
   and can mint sessions from keys, which would bypass the grants model (§4).
9. **Role patterns are anchored regexes** (a bare tool name matches itself; `*` is an
   alias for `.*`), for both tunneled-declared and proxied virtual roles — one pattern
   language everywhere, and regex was wanted for virtual roles anyway.
   **Revised 2026-08-26 (§20): the same language, now over three keyspaces.** A role
   holds a pattern list per family (tools, prompts, resources); a bare list is the tools
   list, so every existing declaration, YAML file and `serve({roles})` call keeps its
   exact meaning. The one addition the regex language needed is a second literal fast
   path: the tool/prompt rule (`^[A-Za-z0-9._-]+$` → compared as a string) cannot cover
   URIs, whose `:` and `/` would drop every resource pattern into regex compilation
   where `.` matches anything. Resource patterns are therefore compared literally when
   they contain no regex metacharacter (`* + ? ( ) [ ] { } | ^ $ \`) — which leaves
   `.` literal in both families, the property the §7 regression test already pins for
   `get.news`.
10. **The wildcard role is named `all`, built-in on every service** (both kinds),
    matching all tools present and future; it never appears in `roles_json`, is
    rejected in declarations (it fits the role-name charset, so the rejection is
    explicit), and is resolved at request time. Renamed from `*`, which read like a
    regex; `*` remains only as a pattern alias for `.*` (item 9).
11. **Proxied upstream auth is static headers (default) or interactive OAuth**
    (`auth: oauth`, §7) — connected from `/services`, tokens encrypted at rest (§5),
    never in YAML (which declares only the mode; the mode is stored in its own
    `upstream_auth_mode` column, distinct from the credential envelope, and flipping
    it wipes stored credentials, §8).
12. **Token expiry defaults differ by kind**: 90 d for service-account tokens (they get
    pasted into agent configs), none for service tokens (telegram-bot model, bots on
    home servers shouldn't silently die) — both overridable at issue time.
13. ~~**No MCP-native OAuth discovery in v1**~~ **Revised 2026-08-26 (§19): the hub is
    an authorization server.** The upgrade path this item promised is the one that was
    taken — the 401 gained `resource_metadata`, the hub serves RFC 9728 and RFC 8414
    documents, and claude.ai connects with no manual header. Manually configured bearer
    headers keep working unchanged and stay the supported route for Claude Code (which
    prefers a configured `Authorization` header over OAuth anyway, and fails rather than
    falling back if one is set).
14. **Roles are not a boundary against the service itself** (§2): grants confine
    accounts; the service is trusted. Drift logging, not pinning, is the v1 answer.
15. **Approvals never block the original request** in v1 — the agent gets `-32003` +
    a link immediately, and an approval is a single-use, args-hash-bound pass consumed
    by an identical retry. Blocking-until-decided is declared future work (§7); the
    owner is Web Push-notified through the PWA instead (§13). The retry-with-identical-args contract is the simplification to
    revisit if agents handle it poorly. An approval spans a full MRTR exchange —
    consumed on `resultType: "complete"` (or service error), not at first dispatch —
    and the args binding is `params.arguments` only, excluding
    `inputResponses`/`requestState` (§7).
16. **Sensitive fields are declared as JSON Schema `writeOnly`** (standard keyword, no
    invented syntax) for tunneled services — in **both directions**: the client
    libraries' `Secret` field type emits it in input and output schemas alike, and the
    hub strips it from outputSchemas served to consumers (internal marker only, §7) —
    plus config-declared `redact` / `redact_results` paths on
    either kind — config is the *only* proxied path in v1, since proxied schemas are
    never cached (§7). The walk resolves same-document `$ref`s and unions
    composition branches; indirection it cannot soundly resolve (external refs,
    `$id`/`$dynamicRef`, recursive-secret cycles) makes the tool loudly
    schema-unsound — no map, `-32001` on gated calls, no recorded bodies — never a
    silent skip (§7). The approval `args_hash` binds post-redaction arguments only.
17. **Caller identity rides `_meta` (tunneled) / `X-Pmcp-*` headers (proxied)** —
    informational for the hub — never a boundary the hub itself relies on — but
    trustworthy for service-side fine-grained checks because the hub strips
    consumer-supplied `hub/*` `_meta` keys before injecting its own (§7). Proxied
    identity headers are opt-in per service (`forward_identity`, default off) — never
    sent to upstreams the owner hasn't marked.
18. **Forwarded requests assert the consumer's `clientCapabilities`**, mirrored per
    request — the hub never advertises input capabilities of its own; MRTR round-trips
    pass through as ordinary `tools/call` retries (§7).
19. **Parity invariant**: everything the web UI and CLI can do has an equivalent
    `pmcp` tool, so AI agents with an admin token have full capability. The pinned
    exceptions — the auth/credential family, the OAuth consent redirect, and the
    JSONL export serialization — are §8's list; the auth family is deliberately never
    exposed to models.
20. **Client metadata is captured on audit rows** (`clientInfo` name/version plus an
    allowlisted vendor session-id `_meta` key, e.g. Claude Code's) — truncated,
    untrusted, display-and-filter only (`audit_query.session`), never authorization
    input (§5, §7).
21. **The web surface is a PWA** (manifest + minimal service worker; pages stay
    server-rendered, no SPA) and approval requests are Web Push-notified through it
    (§13). Blocking-until-decided remains future work.
22. **Audit rows carry call bodies, post-redaction, under short retention** (§15):
    per-service `log_bodies` (tunneled default on, proxied default off — proxied
    schemas can't be trusted, so the owner opts in and covers secrets with config
    paths); results only as masked `structuredContent`; unstructured content and
    over-cap bodies become typed size stubs (cap `AUDIT_BODY_CAP_BYTES`, default
    16 KiB); retention default **7 days** (`AUDIT_RETENTION_DAYS` overrides) — short
    retention is the accepted mitigation for `audit_query` exposing whatever the
    table holds, and the JSONL export is the archive path. Storing the stubbed blobs
    themselves (e.g. R2, referenced from the stub) is the natural future upgrade.
23. **An OAuth-connected client gets service-account power, never owner power** (§19).
    The connection binds to one service account chosen by the owner at consent, and is
    confined by that account's grants exactly like a `pmcp_sa_` key — so it can never
    hold `pmcp` grants and never reaches an admin tool. §2's access model gains a new
    way to *present* a credential and no new kind of authority.
24. **Consent is an explicit screen, and the binding is the revocation handle** (§19).
    No silent auto-approve, no per-client trust flag: the owner sees what the client
    asks for, picks the service account, and can revoke from `/oauth/connections` or
    `connection_revoke`. Revocation is immediate because the door reads the binding row
    on every call — the same one-read-per-request cost a `pmcp_sa_` key already pays,
    which is what lets access tokens keep an ordinary lifetime instead of being cut
    short to bound a JWT the fast path never re-checks.
25. **The auth/credential family is never widened by the authorization server** (§19).
    *(Revised 2026-08-26 with D11's PSD follow-up: the gate became a fail-closed
    **allowlist** — an `Authorization` header is admitted under `/api/auth` only at
    `/sign-out` and `/device/*`, everything else on the mount refuses one. That is
    strictly stronger than the "names the credential paths explicitly" deny-list this
    item first described, and it is what makes adopting a plugin bundle safe rather than
    an audit exercise: `jwt()` mounts `/api/auth/token`, a session→hub-signed-JWT
    converter nobody would have thought to deny-list, and the allowlist refuses it
    without being told. §19's own endpoints need no entry either, because every client the
    hub supports is a public client that sends no `Authorization` at all — §19.7 has both
    arguments.)* None of these endpoints gains an MCP tool (§8's exception list), and the
    door never treats "signed by the hub" as sufficient authority (§19.6 step 3).
26. **Resources do not aggregate** (§20). Tools and prompts are addressed by name and
    take the existing `<slug>_` prefix; resources are addressed by URI, and no prefix
    can ride a URI without rewriting it — in listings, in templates, in read results,
    and inside every `resource_link` or embedded resource block a *tool* result may
    carry. Rewriting there would end "the response is relayed verbatim". So the
    aggregated endpoint serves tools and prompts, the scoped endpoint
    `/<user>/mcp/<slug>` serves everything, and a resource-heavy service is mounted
    scoped — a shape the hub already supports first-class.
27. **Reads are audited, never approval-gated** (§20). Approvals stay a `tools/call`
    concern: `prompts/get` and `resources/read` write audit rows like a call, under the
    same `log_bodies` gate and redaction rules, but never open a pending approval. The
    reason is mechanical as well as conceptual — `approval`'s pending-binding index is
    `(account, service, tool, args_hash)`, so gating another family would let a prompt
    and a tool of the same name share one approval. No migration, no discriminator
    column, no ambiguity.
28. **The hub is a full intermediary: push is served, not deferred** (§21). Owner call,
    2026-09-01 — "support the entirety of the MCP spec" — made over the orchestrator's
    park recommendation, and made *informed*: the primary hosted consumer (claude.ai's
    connector proxy) never opens a listen stream, so the feature is inert there, and the
    owner ordered it anyway because the hub honors the transport, not one vendor's use of
    it. The 2026-08-26 deferral was architectural, not economic, and the D14 probe
    (2026-08-31) dissolved it with measurements rather than arguments: a Worker-held
    `text/event-stream` bills CPU only (idle ≈ free) and subscribes to service DOs over
    hibernatable WebSockets (~1e-5 USD/day per idle stream), while the feared shape — the
    DO holding the stream — bills wall-clock (~$4/month idle, no hibernation for
    non-WebSocket streams) and stays refused. The security half of the call is
    **doorbell-not-data** (§21.3): the hub relays the fact of change and never content,
    so the consumer's re-list re-enters the filter-first pipeline and push adds no second
    path past grants. Logging (`logging/*`, `notifications/message`) stays out — 2026-07-28
    deprecated it upstream — and server-initiated JSON-RPC requests stay impossible by
    MCP's own MUST NOT, so with §21 the hub's answer to "which of the revision's features
    do you proxy?" is: all of the live ones.

