## 18. Decisions made by default — review these

1. **CLI auth = device flow → session token**, not a full OAuth 2.1 provider (§14). The
   full provider is the documented upgrade path when external MCP clients need to log in
   on their own. *(Amended 2026-08-26: that upgrade landed as §19, and the CLI did **not**
   move onto it — the device flow issues an owner session, §19 issues service-account
   authority, and those are different powers. The CLI stays where it is.)*
2. **Namespaces are silos.** Each user fully controls their own namespace and can't see
   any other; there is no sharing, no global admin, no cross-namespace grants. Sharing a
   service between users would be a real design extension — out of scope until wanted.
3. **Tunneled apps declare roles in service code at registration.** Owners may add
   narrower roles beside them through the UI, admin wire, or provider; an app-declared
   name wins a collision. Proxied apps have only owner-defined roles.
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
6. **OpenTofu is the sole declarative owner of hub contents.** Its state is additive:
   imperative UI and CLI changes coexist, and destroy reaches only managed objects.
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
   list, so every existing declaration and `serve({roles})` call keeps its exact meaning.
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
    (`auth: oauth`, §7). The mode is ordinary app configuration; the credential envelope
    is write-only, encrypted at rest, and wiped when the mode flips (§8).
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
21. **The web surface is a PWA** (manifest + minimal service worker) and approval
    requests are Web Push-notified through it (§13). Blocking-until-decided remains
    future work. *(Amended 2026-09-18: the decision's "pages stay server-rendered, no
    SPA" half is withdrawn for two route families and only those. `/apps/*` and
    `/agents/*` are a React SPA over a cookie-authenticated JSON surface at `/api/hub`;
    login/device, Settings, approvals, audit and the consent screen stay server-rendered.
    What forced it: every pane of `/apps/<slug>` blocked its HTML on four live MCP
    catalog reads with no deadline, so one silent upstream held the whole document, and
    every interaction was a full-page form POST that lost the editor's draft on refusal.
    The PWA and push halves stand unchanged — the service worker still has no fetch
    handler and still does not intercept navigation.)*
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
26. **Application resources do not aggregate on the public MCP wire** (§20, narrowed
    2026-09-18 by decision 33). A resource URI is canonical application data and is never
    prefixed or rewritten. Direct clients therefore read it on the app's scoped endpoint.
    A §23 program may read the same resource only through the separate structured
    `(canonical service, raw URI)` API, which re-enters scoped authorization/audit; this
    does not make the application resource catalog part of the aggregate wire surface.
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
29. **The domain nouns are `app` and `agent`** (2026-09-01, owner call, pre-1.0). A
    registered MCP entry — tunneled or proxied — is an **app**, not a "service"; a
    consumer identity holding grants (`claude`, `cron`, `pi`) is an **agent**, not a
    "service account"; the owner's credential page is **Settings** at `/settings`, not
    `/account`. "Service" had to carry the registry row, the protocol role, and the
    generic English word at once, and "service account" read as infrastructure rather
    than as the AI agents it actually names. The rename is **lexical and total**, with
    no behavior, IA, or rule change riding along: SQL tables `app` / `agent` and columns
    `app_id` / `agent_id` (§5); token prefixes `pmcp_app_` / `pmcp_agt_` and token kinds
    `"app"` / `"agent"`; audit principals `app:<slug>` / `agent:<slug>` and the `audit.app`
    column; admin tools `service_*` → `app_*` and `account_*` → `agent_*`, with their
    audit events following (`admin.app_create`, …) — while `grant_set`, `token_*`,
    `approval_*`, `audit_query` and `connection_*` keep their names and rename only their
    fields; CLI nouns become `pmcp app` / `pmcp agent` with `--app` / `--agent` flags and
    `app/` / `agent/` refs (§10); routes become `/apps`, `/agents`, `/settings` (§13);
    **clients** stay clients (§19), "MCP server" stays the protocol role a tunneled bot
    plays, better-auth's own `user`/`session`/`account` tables are untouched, and `pmcp`
    stays the reserved slug, the CLI name, and the package prefix. **No legacy aliases**:
    existing `pmcp_svc_` / `pmcp_sa_` tokens simply stop validating and are re-issued
    after deploy — a pre-1.0 hub with one operator buys nothing from a compatibility
    shim, and a shim is exactly the thing that would keep the old vocabulary alive.
30. **Settings and the app page are panes behind a rail; a password is self-serve to
    *change* and script-only to *reset*; the connections list lives in Settings**
    (2026-09-02, owner-reviewed design; §13, §4, §12, §8, §19, §20.6). Three calls in one
    redesign. **(a) Panes.** `/settings` first became six panes behind a left rail —
    Sign-in (Password, Two-factor, Passkeys) and Access (Sessions, Tokens, Connected
    clients) — with one route per pane and at-a-glance markers. Decision 33 later adds
    Runtime / Execution as the seventh pane without changing this layout or the
    credential-family decisions below.
    `/apps/<slug>` gained the same rail for catalog/access/configuration; decision 32
    later replaced its family panes with the three-pane Catalog design. Decision 33
    replaces the old displayed aggregate prefixed name with separate canonical scoped
    and hub-local TypeScript identities. Reach, approval, and redaction remain computed
    by the door's own matcher, never a second one. **(b) Password.** The Password pane
    **reverses §4's "no self-serve password change" — for the change half only.** An owner
    who knows the
    password changes it on `/settings`, behind the recent-authentication gate, current
    password required, "sign out my other sessions" on by default: core better-auth's
    `/change-password`, verified against 1.7.1, which on that flag deletes every session
    (the CLI's and the current one) and re-mints the browser's in the same response — so
    the gate is the hub's (the endpoint checks no freshness of its own in 1.7.1) and the
    cookie must be forwarded. An owner who has *forgotten* it is still reset only by
    `pnpm users reset-password` (§12), because no email is on file (decision 5) and
    therefore no reset link can exist; the pane says so in its own footer. Change and
    reset are kept distinct in every spec sentence so the script's path and the pane's
    cannot drift into one another, and tokens are untouched by either: nothing derives
    from the password. `minPasswordLength` becomes 12. **(c) Connected clients.**
    `/oauth/connections` was unreachable — its route and POST dispatcher existed and no
    page linked to them — and becomes the third Access pane at `/settings/clients`, with a
    `301` from the old URL: Sessions, Tokens and Connected clients are one family,
    everything holding a live way in, each with a Revoke, differing only in who holds it
    (`user:<name>` with owner authority; the owner's own apps and agents; outside software
    acting *as an agent*, confined by `oauth_binding.agent_id`). Keeping the `/oauth/` URL
    and only shelling it into the rail was acceptable and lost to one-prefix uniformity —
    rail state and §4's gate as a single rule — and to the redirect costing one route.
    `/oauth/consent` keeps no nav slot on purpose (a step inside the authorize redirect,
    never navigated to) and §13 now says so in as many words. **Scope, pinned.** *(2026-09-03:
    the `/agents` list, `/agents/<slug>` and the (agent × app) grant editor are now
    specced in §13 — roadmap step 9 — with their three boards adopted as contract; the
    rest of this paragraph's deferrals stand as written.)* *(2026-09-03, later: the audit
    expanded-row states landed with roadmap step 10 and the proxied add-app states with
    step 11 — both boards adopted as contract, §13 pins their strings. Two calls made
    there: the endpoint rule is `https://` only, `http://` for loopback, checked at the
    ops (the owner's trust boundary; the registry stays a storage layer so seeds and
    tests may store what they like), and the connecting page is a 200 with a link and no
    auto-open — a page cannot open a tab without a script, and a create must not depend
    on one — so the owner clicks "Continue to <name>" and the same-tab flow §7 already
    runs takes over.)* Only the
    reviewed pages are specced: the `/agents` list and detail, the grant editor, the audit
    expanded-row states and the proxied add-app states stay unreviewed and deferred; where
    the new pages point at them (the app page's Edit grants, agent slugs as links, the
    agent page's read-only clients row) §13 says "deferred" instead of inventing them,
    ~~`agents` does not join §2's reserved segments~~ *(reversed 2026-09-03: `agents` IS
    reserved ahead of its page — a username `agents` registered first would shadow the
    route for good and reserving early costs nothing; until the page lands `/agents`
    answers its own not-built-yet text so the §2 walk sees it served)*, and the mobile top nav's missing
    `Agents` entry is recorded as the follow-up it is. One reservation rides along: `new`
    and `connect` — the static segments under `/apps/` — can no longer be app slugs,
    derived from the route table exactly as §2 derives usernames. **Spec ahead of code**:
    nothing in this entry is implemented; it is its own workflow after §21 (D14) *(true
    when written; implemented by D15 on 2026-09-02 — amended 2026-09-03, G38)*. Two
    design-side follow-ups are recorded, not solved: the full-shell `SettingsTokens` and
    `OauthConnections` boards duplicate pane content the `…Panes` boards now carry, and
    `/apps/<slug>` has no mobile board.

31. **The agent page is three panes; grant sets take inline entries** (2026-09-16,
    owner-reviewed design; §13, §8, §7, §5, §20.3, §22). Two calls, one redesign.
    **(a) Three panes.** `/agents/<slug>` becomes a paned page on the same shell as
    `/settings` and `/apps/<slug>` — **rail · listing · details** — reversing decision
    30-era §13's "NOT a paned page: an agent has three holdings and no listing to browse".
    The reasoning fell the moment the page lists what every granted app *advertises*: the
    agent's apps are the listing, one rail entry each (amber dot for an ask entry, a dash
    when the app is archived — dormant — and nothing else, since the rail is drawn on
    every pane and must read the same on all of them, so nothing catalog-dependent may
    feed it), with `+ Grant another app…` and the agent's own panes — Credentials,
    Activity, Danger zone — beneath them. The (agent × app) grant set is now the app pane,
    listing roles, tools, prompts, resources and pattern entries with **one control per
    row, `none` · `ask` · `allow`**: solid when set on the row, hollow when a role implies
    it (the role named), the states below a role's disabled. `/agents` drops to a plain
    list — the whole row a stretched anchor, Delete the only control, Access one line of
    counts — because every per-app detail and every edit now has somewhere better to live.
    **(b) Inline entries.** A grant set's entries widen from role names to role names **or
    items**: `tool/<pattern>`, `prompt/<pattern>`, `resource/<uri-pattern>`, so a single
    tool can be granted or asked on its own row and a pattern typed into the filter can be
    added as an entry. Role names never contain `/`, so the two kinds never collide; mode
    is the `:approval` **suffix**, read from the end, because a resource URI carries colons
    of its own. `grant_set` and the provider's `pmcp_grant` (§22) take the same list; an
    inline entry needs no declaration and is therefore never "undeclared".
    **Alternatives the owner rejected across the design rounds.** *A separate grant-editor
    page* (`/agents/<slug>/grants/<app>`, shipped 2026-09-03): kept as a route it would be
    a second place to edit the same set, and as a page it could not show the app's catalog
    beside the choice — which is the whole point of the redraw. It is deleted, its board
    (`GrantEditorStates`) with it, and the old URLs answer `301`s. *A deny mode* — a fourth
    control state that subtracts: it was asked for and refused. Grants are a union (§7);
    the strongest matching entry wins and allow beats approval, so a deny would make the
    result order-dependent and make "what can this agent reach" unanswerable by reading the
    set. Nothing granted is simply `none`. *Catalog-driven totals on `/agents`* — reach
    counts per family on every row: dropped because a proxied app's catalog is a **live
    read** of the upstream, so the list page would fan out one network read per app per
    render and would go slow or wrong exactly when an upstream is down. The list and the
    agent header count over the stored grant sets only; the open app pane is the one place
    that reads a catalog, and "dormant" on the list means an archived app or an undeclared
    role, never "matches nothing today".
    **Irreversibility, pinned.** Entries are stored in `grant_.role` unchanged and the
    **column keeps its name** (§5 gains a comment, not a migration). That is deliberate and
    forward-compatible in both directions: an older reader sees strings it does not
    recognise as role names and resolves them to the empty pattern set, which is the
    existing behaviour for a role no longer in `roles_json` — an agent gets less, never
    more. Rolling back the pages leaves inline entries sitting in the table as
    unrecognised roles; they grant nothing until the parser returns. Renaming the column
    to `entry` was considered and dropped: it buys a word and costs a migration on the one
    table whose primary key it is part of.
    **The phone rendering** *(owner-approved 2026-09-16, `MobileAgentDetail` /
    `MobileAgentDetailStates`; no new number — it is how (a) renders below 900 px)*. The
    three panes become **three levels of navigation**, one screen each — the rail as a
    list, then the listing, then the details — the level chosen from the URL by the server
    (`data-level="1|2|3"`, CSS shows one), each headed by a back link naming the level
    above (`‹ Agents`, `‹ claude`, `‹ News MCP`) with the current thing as the title, so a
    listing header never repeats what the level header shows. It brought **one shell-wide
    change**: the narrow top nav is no longer a horizontally scrolling five-entry row but
    brand + **hamburger** + a `:target`-driven **sidebar** from the hamburger's side, with
    the five entries, the Approvals pill, the username and Sign out at its foot, a close
    control and a scrim — no script. The sidebar replaces the scroller **on every page**
    below 900 px, not only this one; the wide shell is untouched. The alternative rejected:
    *a drop-down panel under the bar* — a sidebar sliding in from the hamburger's own side
    is the convention the owner asked for, and the drop-down would have kept the five
    entries fighting for the same 390 px the scroller already lost on. The agent page also
    drops `PanePills` entirely (the rail-as-list is its replacement); `/settings` and
    `/apps/<slug>` keep the pill row, so decision 30's mobile rule now has one exception
    rather than a rewrite.
    **One ladder for every width and height** *(2026-09-16, later the same day; §13,
    `design/layout-and-density.md`)*. Drawing the third paned page made the drift visible
    and the owner named it — "very inconsistent right now": five page widths (1140, 1176,
    1180, 1220, fluid), two rail widths (200 and the framed rail's 180), five button
    heights (36, 32, 30, 28, 22), three badge heights, two auth-card widths and two row
    paddings, none of them decided, each the residue of whichever board was drawn last. The
    fix is a single ladder, adopted from what the **published systems already agree on** —
    Material 3 (window size classes and canonical layouts, via the AndroidX
    `PaneScaffoldDirective`), GitHub **Primer**, IBM **Carbon**, **Atlassian** Design
    System, Ant Design, Shopify **Polaris**, Microsoft **Fluent 2** and Apple's **HIG**,
    plus NN/g and WCAG 2.2 for line length and target size — rather than invented here:
    three page shapes (**document** 760, the auth card 400 · **table** 1280 · **workspace**
    full width with the *panes* capped, Carbon's high-density exception), one **rail 200**,
    breakpoints **768** and **1024** replacing the single 900 (nobody publishes 900), rows
    **32 / 40 / 44**, controls **36 / 32 / 24 / 44**, one **badge 20**, no type under 11 px,
    prose at **72ch**, gutters **16 → 24** at wide. Two consequences are decisions, not
    arithmetic. **Settings and the app page join the framed workspace shape**: their rail
    and pane move inside the one bordered frame the agent page uses, ending "a rail beside a
    card" and the page width each carried for it — the three paned pages now differ in what
    they list, never in how they are built. And the agent page is **the one page whose
    levels and whose shell change at different widths** — levels below 1024 (rail 200 +
    listing 520 + details 360 needs 1080 px; M3 calls two panes below expanded "too
    packed"), hamburger below 768. §13 now states the shapes and defers every number to
    `design/layout-and-density.md`, whose reasoning, sources and today-vs-fix table live
    there and whose values live in `styles.css` `:root` and the **Layout & density** panel
    of `design/Main.dc.html`; applying it to the pages and the boards is its own dispatch,
    gated page by page beside its board per
    `docs/superpowers/postmortems/2026-09-16-agent-page-layout-not-the-board.md`.
    *2026-09-17, owner:* the app page takes what the agent page got — the crumb
    folded into its title line ("Apps › <name>", the "Apps / <slug>" line gone), the
    **two levels** below 1024 (rail-as-list, then the pane) behind the same level header,
    no pill row — and every `/apps` row is the link, stretched as the agents list's. The
    pill row is now `/settings`'s alone.

32. **The app page is three panes; a tunneled app's owner defines roles of their own**
    (2026-09-17, owner-reviewed design; §13, §5, §8, §20.3, §22). The owner asked for
    `design/concepts/AppThreePaneDemo.html`, the clickable prototype drawn after the agent
    page landed and refined with the owner through that day, then shipped whole.
    **(a) Three panes, and seven of them.** `/apps/<slug>` stops being a rail beside one
    region and becomes **rail · listing · details**, the shape decision 31 gave the agent
    page, in the framed workspace box all three paned pages now share. The eight panes
    become seven, and the arithmetic is not a tidy-up. **Tools, Prompts and Resources fold
    into one Catalog** — three rail entries that answered the same question ("what does
    this app expose?") with three copies of one row grammar, and whose separate counts said
    less than one summary line does; the families survive as groups inside the listing, each
    with its own "none advertised" note, so an app that declares no prompts still says so in
    the place a reader is looking. **Recording is a new pane**, the approved
    `AppRecordingDemo` redrawn in the three-pane grammar: `log_bodies` as a switch and
    `redact` / `redact_results` as ticks on schema paths — three `app_update` fields the
    page had no control for, only Overview's read-only lines, which this entry removes.
    **Roles becomes editable** (below). **Agents gains the grant editor**: the same rows,
    the same `none` · `ask` · `allow` controls and the same field names the agent page's app
    pane has, extracted into one component and rendered by both — never a second editor for
    one `grant_set`, which is the rule §13 already states for the door's matcher applied to
    an edit surface. Granting a **new** agent deliberately does not start here (owner,
    2026-09-16: it complicated the flow); the pane edits and removes the grants that exist
    and points at the agent's own page for a new one. Overview and Danger zone render the
    listing alone, as does Token on a proxied app, which holds nothing to select. Two
    consequences ride along: `/apps/<slug>/prompts` and `/apps/<slug>/resources` answer
    `301`s to `/apps/<slug>/catalog` — the Catalog holds them and a bookmark should still
    land; the pane keeps a URL of its own beside the landing that renders it, because below
    the breakpoint the two are different levels of one page (§13's recorded exception) — and
    the **two levels** pinned for this page hours earlier become **three**, because a page
    with a details pane has a third thing to show on a phone; the level header, its back
    links and the `data-level` attribute are the agent page's, unchanged.
    Two things the prototype has that the pages do **not**: the unsaved-changes banner
    ("Save and go / Discard and go / Stay") and the blue draft dots. Both are script-only
    state, and the pages are server-rendered with scripting off — exactly as the agent page
    dropped them. A draft here is the form's own unsaved state and leaving the page loses
    it; every pane's Save replaces what its form owns, whole, in one op.
    **(b) Owner-defined roles.** A tunneled app declares its own roles at connect and the
    owner could previously only read them — so the one thing an owner could not do was carve
    a narrower set out of what an app offers, which is the whole point of a role. The fix is
    storage beside the declaration, not instead of it: `app.owner_roles_json` (§5) in
    §20.3's normalized per-family shape, `owner_roles` on `app_create` / `app_update` and
    the provider, `ownerRoles` on the tunnel row, and one merge rule — **the owner's, then
    the app's declaration on top; a name the app declares replaces the owner's definition
    of it, whole**. Every gate-side reader takes that effective map and no other
    (the door's filter, `setGrants`'s undeclared check, reachability), so a page can never
    disagree with the door about what a role grants. Resolving the collision at **read**
    time rather than at write time is the load-bearing half: `hub/register` keeps replacing
    `roles_json` blindly on every reconnect, the owner's map is untouched by it, and no
    write can lose either side. The owner sees the collision as one badge, `app · replaced
    yours`. A **proxied** app is deliberately asymmetric and carries no `owner_roles` at all
    — its `roles` are config, already all the owner's — and the op refuses the field there
    rather than storing a map nothing would read. Alternatives rejected: *merging pattern by
    pattern* on a collision, which would produce a role neither the app nor the owner
    wrote and could only widen what the app declared; *renaming the owner's role out of the
    way*, which would silently break the grants naming it; and *one map with a source flag
    per name*, which buys the same answer and costs a migration on the column the registry
    writes on every connect.
    **(c) Three forms, three ops, no new ones.** Roles posts `/apps/<slug>/role_set`,
    Recording `/apps/<slug>/recording_set`, Agents `/apps/<slug>/grant_set` — each composing
    **one** existing op (`app_update { owner_roles | roles }`, `app_update { log_bodies,
    redact, redact_results }`, `grant_set`) from fields that are not the op's keys verbatim,
    the D15 constraint 35 shape the agent page's editor already has. §8's parity list does
    not change and no audit event type is added: the existing `admin.app_update` row's
    `fields` list names `owner_roles` like any other field. The Recording form carries one
    rule worth restating because it is a data-loss guard rather than a layout choice: a path
    masked on **some** but not all of its tools renders expanded, with no whole-path
    checkbox, so no save can silently clear a partial state — and every stored entry the
    rows cannot represent (a tool or path no schema declares) rides back as a hidden `keep`
    field, so a save never drops what evidence put there.

33. **The aggregate endpoint is a hub-owned synchronous TypeScript orchestrator**
    *(2026-09-18, §23)*. The old aggregate application tools/prompts and generic
    first-underscore dispatch are removed in one clean cutover; scoped applications keep
    their canonical surfaces. Aggregate `hub_execute`/`hub_search_types` and scoped
    `/mcp/hub` use hub-owned declaration resources and one explicit TypeScript-to-
    canonical map. Programs call tools and read resources only through the existing
    scoped dispatch chokepoints, so grants, archive, availability-first approval,
    redaction, metadata hygiene, backend behavior, and audit do not fork.

    The execution authority is the exact invoking credential, not merely its principal:
    owner sessions receive full owner `pmcp`, admin tokens receive `adminOpsFor`, and
    agents/OAuth receive no `pmcp`. Exact bearer bytes select a Sandbox; a
    domain-separated digest is identity only and the bearer never enters untrusted state.
    Reauthorization happens on every inner operation and before publication.

    TypeScript aliases are hub-local, sticky reservations. Owners configure either app
    kind through admin/UI/CLI/provider; tunneled SDKs may send lower-precedence hints.
    Proxied upstreams need no SDK and never rename a canonical MCP method. Established
    paths survive later collision; simultaneous first collisions omit all; removal and
    app deletion tombstone names. Recreating a slug is a new app identity and cannot
    inherit the old TypeScript service path. This stronger stability is intentionally
    easier to adopt than undo, so no release/reuse escape hatch is introduced.

    Execution remains synchronous and non-transactional. Owner settings choose a default
    and maximum from 1–300 seconds (initially 30/30); each call may request a duration
    within that maximum. Inner count/concurrency/deadline limits do not grow with wall
    time. There is no job/resume, package installation, workspace, rollback, or automatic
    approval continuation. Cloudflare's exact-pinned Sandbox preview is the one narrowly
    admitted Worker runtime dependency; a bounded in-repo schema renderer avoids a second
    dependency. Container idle sleep is six minutes so it cannot interrupt the five-
    minute ceiling, accepting longer idle residency instead of a heartbeat lifecycle.

34. **Hub execution is a fresh in-Worker QuickJS/Wasm runtime per invocation**
    *(2026-09-19, supersedes decision 33's Sandbox/runtime paragraphs; §23)*. The aggregate
    and scoped hub surfaces, catalog snapshot, TypeScript alias map, settings, dispatch
    chokepoints and reauthorization contract from decision 33 remain. Submitted `code` is
    now the body of an async JavaScript function: top-level `await` and `return` are valid,
    and there is no TypeScript compilation or `export default`.

    The Worker exact-pins `quickjs-emscripten-core` and the release-sync Wasm artifact,
    lazily instantiates one module per isolate, and creates and disposes a memory-, stack-
    and deadline-bounded runtime for every call. Host MCP operations are the only
    capabilities and resume guest promises without Asyncify. The host compiles the
    submitted body before invocation, then removes guest access to `eval`, `Function`, and
    every function-family constructor. No filesystem, network, timer, module loader,
    Worker binding, bearer, or stable runtime identity enters the guest.

    This deliberately removes the Sandbox SDK, Container application, execution Durable
    Object, Deno image, exact-bearer digest, warm reuse and four-way typecheck/runtime
    lifecycle. The deciding consideration is operational weight: the required
    orchestration needs a bounded interpreter and explicit host calls, not a remotely
    managed operating-system process. Alternatives rejected were retaining Containers
    for stronger process isolation at the cost of startup, capacity, billing and a second
    deployment plane; and evaluating in the Worker realm, which neither provides a
    capability boundary nor a disposable heap. The externally visible source/result
    contract is the hard-to-reverse part: adopting JavaScript-only bodies is easier than
    later restoring transparent TypeScript, so declarations remain discovery material and
    the schema says JavaScript explicitly.

35. **QuickJS execution restores TypeScript preflight and reports bounded failures**
    *(2026-09-20, supersedes decision 34's JavaScript-only/no-typecheck clauses; §23)*.
    Submitted `code` remains an async function body, but the exact-pinned TypeScript
    compiler checks it against the caller-specific generated declaration and emits the
    JavaScript that QuickJS evaluates. A syntax or semantic failure returns `type_error`
    diagnostics before QuickJS starts; each diagnostic carries its stable code, bounded
    message, and submitted-source location when available.

    Tool arguments also cross an interpreted JSON Schema gate before any counter or
    dispatcher changes. The exact-pinned Worker-safe validator is preferred over an
    in-repo partial validator because silently ignoring an unfamiliar schema keyword would
    recreate the bug at a more dangerous boundary. An uncaught guest exception returns its
    bounded message and source-mapped stack to the same authenticated caller; neither is
    logged or audited.

    The deciding consideration is failure locality: a program that cannot typecheck or a
    call that cannot satisfy its advertised schema must fail before it can create effects.
    This adds compiler size and startup work, but adopting weak checking is easier than
    removing it after programs depend on false acceptance. The alternative—JavaScript-only
    execution with declarations as documentation—was smaller and operationally simpler,
    but its opaque `syntax_error`/`program_error` labels and downstream schema failures
    made orchestration materially harder to correct.

36. **`/audit` is the SPA's third route family, redrawn as an explorer**
    *(2026-09-21, §13; `design/concepts/AuditDemo.html` adopted whole, the research behind
    it in `docs/superpowers/reports/2026-09-20-audit-visualization-research.md`)*. The
    server-rendered table is deleted, not decorated: it answered "what happened" with one
    ordering, one page at a time, and every other question — which agent is being refused,
    which session did this, what ran under that approval — by retyping filters into a form
    and losing the place. The explorer is **three readings of one filtered set** (Summary,
    Sessions, Events) under a per-principal lane strip with a brush and a facet rail with
    live counts, each reading over the same rows, so a question is asked by narrowing rather
    than by navigating.

    Three things make it hold, and each is a deliberate cost. **The window is loaded, not
    paged**: one body-less read of the whole retention window up to
    `AUDIT_EXPLORER_ROWS`, after which facets, brush, merging and sessions are arithmetic
    in the client and no click waits on the network — the cost is the ceiling, which the
    page states in words and points at the export for, and a body-less projection done in
    SQL because a Worker that parsed thousands of capped bodies to discard them would meet a
    memory ceiling no in-process test can see (§16). **Related rows merge**: rows sharing a
    `detail.approvalId` read as one chain and consecutive identical rows as one ×N run, which
    is why §15 records that id on the refused and the claimed `tools/call` rows — a ledger
    join, changing nothing on the wire (§7). **Every colour is named**: the five outcome
    classes always print their class beside their swatch, since a ledger read in a hurry is
    exactly where colour-only encoding fails.

    The rejected alternative was **modelling the page on a generic log viewer** — Grafana's
    Loki UI, which the owner first asked for by name: a flat list of log lines carrying a
    level and a label set, filtered by labels, each line expanding to its fields. A concept
    was drawn on that model, and then, rather than trusting a memory of the tool, Loki and
    Grafana were run locally and our own rows — our schema, a fixture week — pushed through
    them. The model does not fit the rows. Its JSON parser flattens a nested body into
    underscore-joined keys and silently drops arrays, so a blob stub inside `content` simply
    vanishes; it renames any field that collides with a stream label (`…_extracted`); and it
    classed 1,287 of 1,319 events as level `unknown`, because a JSON-RPC outcome code is not
    a log level. The owner's verdict on the rendered result was that it looked awful, the
    direction was dropped, and the research above is what replaced it. The reason it loses is
    structural rather than aesthetic: an audit row is a nested call record with an outcome, an
    approval and a session, not a line with a level and labels, and a viewer whose primitives
    are lines and labels has to destroy the first in order to display the second.

    **Two questions are deliberately left open** and are not part of this decision. Whether
    `outcome` splits into a mechanism and a reason — why a `-32001` was a `-32001` — which
    §7 today keeps indistinguishable on the wire and §15 therefore keeps indistinguishable in
    the ledger; the explorer is written to work without it, and its first insight sentence
    ends at the outcome class for exactly that reason. And whether a weekly digest exists at
    all: the page answers a question being asked, and a digest asks the question for the
    owner, which is a different product decision.
