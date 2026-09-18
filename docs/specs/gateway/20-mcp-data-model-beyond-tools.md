## 20. The MCP data model beyond tools

*Added 2026-08-26. Reverses §18 decision 4 and revises decision 9; decisions 26–27 carry
the owner-level calls. Implemented as its own workflow, **after** §19.*

v1 proxied tools because tools were what agents used. Both Claude surfaces now consume
more: Claude Code turns an app's prompts into `/mcp__<server>__<prompt>` slash
commands and its resources into `@server:uri` mentions (auto-materializing list/read
tools for them), and hosted connectors list Tools, prompts, and resources as supported.
A tunneled app that already declares prompts **answers them over the socket today** —
the client libraries are transparent transports, and `AppConnection.forward` is
method-agnostic. The hub is the only thing saying `-32601`.

### 20.1 What is in, and what is deferred with its reason

| Family | Methods | Status |
|---|---|---|
| Prompts | `prompts/list`, `prompts/get` | **In on real scoped apps.** The aggregate hub surface returns `-32601`; programs do not expose prompts in the first release (§23). |
| Resources | `resources/list`, `resources/read` | **In on real scoped apps.** Programs additionally list/read through their structured canonical-service + raw-URI API (§23); public application resources still do not aggregate. |
| Resource templates | `resources/templates/list` | **In on real scoped apps** and as local immutable program snapshot metadata; templates are never fetched through a rewritten URI. |
| Completions | `completion/complete` | **In on real scoped apps only.** Aggregate/hub and programs return/offer no completion surface. |
| MRTR (elicitation / sampling / roots) | `input_required` results on `prompts/get` and `resources/read` | **In.** It is a *result shape*, not a stream: the hub already relays an `input_required` leg verbatim for `tools/call`, and §7's `clientCapabilities` mirroring already tells the app what the consumer can answer. |
| `subscriptions/listen` | — | **In** *(2026-09-01, §21; **Deferred** at first writing)*. The deferral reasoned that piping an app notification into a consumer's open stream needs a DO→worker push channel that did not exist, and that a permanently-open subscription inverts the DO's hibernation discipline ("an unresolved inbound request blocks hibernation"). The D14 probe measured both away: the **Worker** holds the `text/event-stream` (CPU-billed — an idle stream is effectively free) and reaches each app DO over a **hibernatable WebSocket**, which is the missing push channel and hibernates like any socket. §21 is the spec. |
| `notifications/*/list_changed` **to consumers**, `resources/updated` | — | **In** *(2026-09-01, §21)* — deliverable now that the listen stream is served. The consequence pin survives with its sign flipped: **never declare a capability the transport cannot honor** was the reason for `listChanged: false` (a declared-but-unserved capability makes a Claude Code v2 client open a listen stream, take `-32601`, and burn its reopen budget — 3 reopens then a stop; 5 in an hour then a ~6 h wait), and it is now the reason declaration and transport flip **in the same deploy** (§21.5): a served-but-undeclared stream is one no client ever opens. |
| `logging/*`, `notifications/message` | — | **Out.** Deprecated in 2026-07-28 itself, and per-request SSE would be needed to carry it. |
| Server-initiated JSON-RPC requests | — | **Impossible in this revision** — servers MUST NOT send them; MRTR replaced them. |

Freshness without notifications is carried by `ttlMs` (§20.5): the hub's own view stays
current because the DO still invalidates on an app's `list_changed`; only the
consumer's view lags by the TTL. *(Amended 2026-09-01: §21's doorbell closes that lag for
a consumer holding a listen stream; `ttlMs` remains the floor for streamless consumers —
claude.ai's proxy is one, §21.)*

### 20.2 Routing at the door

The 2026-09-18 aggregate cutover in §23 removes aggregate application-family routing.
The aggregate and virtual `hub` endpoints serve only hub tools and hub-owned declaration
resources. Application prompts, resources, resource templates, completions, subscriptions,
and tools remain on `/<user>/mcp/<slug>` with canonical names and raw URIs.

On a real scoped endpoint, `prompts/list`, `prompts/get`, `resources/list`,
`resources/templates/list`, `resources/read`, and `completion/complete` retain this
section's filter-first pipeline and family-specific matching. A read is routed by the
addressed slug, never the URI: two apps may serve the same URI and authorization is still
evaluated against the selected app.

§18 decision 26 is narrowed, not reversed: **application resources do not aggregate on
the public MCP wire**. A §23 program uses the separate structured address
`mcp.<service>.resources.read(rawUri)`. The raw URI is never prefixed/re-written and the
operation re-enters the same scoped `resources/read` dispatcher and audit policy.

**Capabilities.** `initialize` and `server/discover` remain Worker-answered and share
one producer:

- aggregate and scoped `hub`: tools/resources with `listChanged: false`, no prompts,
  completions, or subscribe (§23);
- scoped tunneled real app: stored registration capabilities, with §21 push flags;
- never-connected or unresolvable scoped slug: tools with `listChanged: true`;
- scoped proxied real app: owner-declared families, all push flags false;
- scoped `pmcp`: tools only, `listChanged: false`.

No capability answer performs a live upstream call. The old union/intersection question
and first-underscore prompt/tool splitting no longer exist.

**Access control.** Every real-app family is filtered by current grants before listing or
forwarding. Owners see everything. Program catalog reads use the same filters and then
freeze the visible result for local list/template/search operations; actual tool/read
dispatch reauthorizes current credential and grants.

An agent with no matching pattern receives an empty list and `-32001` on a fetch.
Three family-specific matcher rules remain because a generic name matcher is unsafe:

- **Prompts are matched by `name`.** `registry.buildToolFilter`'s `filterList` is already
  generic over `{name}`, so prompt filtering needs no new pure code.
- **Resources are matched by `uri`, never by `name`.** An MCP resource carries both, and
  §20.3's patterns are URI patterns — so reusing the name-keyed `filterList` here would
  filter a URI keyspace with a display string, and a resource whose *name* happened to
  match a granted pattern would be listed and readable although its URI matches nothing
  the caller was granted. Resource **templates** are matched by their raw `uriTemplate`
  string under the same rule, and `resources/templates/list` is filtered with it before
  anything is returned. The family argument §20.3 adds to the filter therefore selects the
  **key** as well as the pattern list; a family-aware filter that still reads `.name` is
  the bug this sentence exists to prevent.
- **`completion/complete` is filtered by its `ref`.** The method's `ref` names a prompt
  (`ref/prompt` → matched by name against the caller's prompt patterns) or a resource
  template (`ref/resource` → matched by its template string against the resource
  patterns). A `ref` no pattern matches is `-32001`, refused before anything reaches the
  app. Unfiltered, this method is a read straight past the role's patterns: a caller
  with zero prompt and resource grants could enumerate whatever the app completes —
  document titles, ids, user handles — which is exactly the data the patterns exist to
  confine. **Audit posture, decided rather than inherited:** it stays listing-class
  (§20.4, no row), like `prompts/list`. The refusal is what makes it safe; a row would be
  polling noise from a method a client calls on every keystroke.

**Identity and MRTR.** Forwarded requests in every family carry the same `_meta` §7
pins — `hub/principal`, `hub/roles`, the consumer's mirrored
`io.modelcontextprotocol/clientCapabilities` — with the same `hub/*` strip-then-set
hygiene. An `input_required` result relays back verbatim and the consumer's retry is an
ordinary request re-entering the pipeline; `requestState` stays opaque to the hub, never
inspected and never rewritten.

### 20.3 Roles: one language, three keyspaces

A role's declaration gains a family dimension (§18 decision 9). The same wire shape is
used by `hub/register`, admin operations, the provider, and both libraries'
`serve({roles})`:

```jsonc
"roles": {
  "reader":  ["get_news", "search_.*"],              // bare list = tools. Unchanged, forever.
  "curator": { "tools":     ["publish"],             // per-family object; every key optional
               "prompts":   ["digest_.*"],
               "resources": ["news://feed/*"] }
}
```

- **Backward compatibility is total.** A bare list is normalized to
  `{ tools: [...] }`, so every deployed app and every existing `serve({roles})` call keeps
  its meaning. A role that grants tools grants nothing in another family. The two
  spellings may be mixed across roles in one declaration. Normalization happens once in
  the hub.
- **Storage**: `app.roles_json` holds the normalized per-family object. Existing rows
  hold bare lists and are read as tools-only, so no data migration exists.
- **Two sources, one rule** *(2026-09-17, decision 32)*: a **tunneled** app's owner may
  define roles of their own, stored in `app.owner_roles_json` (§5) in this same normalized
  per-family shape. The roles anything resolves against are the **effective** map — the
  owner's, then the app's declaration on top: **a name the app declares replaces the
  owner's definition of it**, whole, never merged pattern-by-pattern. A proxied app
  declares nothing, so its `roles` (config) are already all the owner's and its
  `owner_roles_json` stays `{}`. Every gate-side reader takes the effective map and no
  other: the door's filter, `setGrants`'s undeclared check (an owner role **is** declared
  for it — the tunneled warning and the proxied error fire only for a name in neither
  map), and reachability wherever a page or an op computes it. The app's declaration
  winning is what makes a reconnect safe to be blind: `hub/register` replaces `roles_json`
  alone, the owner's map is untouched, and a collision is resolved at read time rather than
  by a write that could lose one side. The consequence an owner sees is one badge on the
  Roles pane, `app · replaced yours` (§13).
- **Read shape** is canonical: `app_list` / `app_get` render a bare list when a role is
  tools-only and the per-family object otherwise. The result is a function of meaning,
  not of whichever spelling happened to be stored or registered.
- **Validation** (§6, applied identically to proxied virtual roles, §8): role names and
  the reserved `all` are unchanged; an unknown family key is a violation; every pattern
  must compile; `ROLE_PATTERN_MAX_LENGTH` bounds each pattern and `ROLE_PATTERNS_MAX`
  bounds **each family list** — the same two `limits.ts` constants, applied three times,
  so no new magic number enters the system.
- **The built-in `all` role** spans every family, present and future: it contributes
  `.*` in each without appearing in any declaration. Owners keep `["all"]`.
- **Inline grant entries ride these same three keyspaces** *(2026-09-16, decision 31)*: a
  grant set's `tool/<pattern>` lands in `tools`, `prompt/<pattern>` in `prompts` and
  `resource/<uri-pattern>` in `resources` (§8), with that family's pattern grammar and
  literal fast path below — no fourth keyspace, and no family an inline entry can reach
  that a role cannot.
- **Pattern grammar**: the anchored-regex language of §7, with the per-family literal
  fast path §18 decision 9 pins — tool and prompt patterns are literal when they are
  tool-name characters only, resource patterns are literal when they carry no regex
  metacharacter (`* + ? ( ) [ ] { } | ^ $ \`). `.` stays literal in both, `*` still
  aliases `.*` in both, so `news://feed/*` means what its author thinks it means and
  `file:///notes.txt` does not match `file:///notesXtxt`.
  The metacharacter test is applied to the **pattern**, never to the subject — which is
  what makes resource *templates* answerable. `{` and `}` in a `uriTemplate`
  (`news://feed/{id}`) are ordinary characters of the string being matched: a pattern with
  no metacharacter is compared to that template byte-for-byte, and a pattern carrying one
  compiles and matches it as a regex, so `news://feed/*` covers `news://feed/{id}` because
  `*` aliases `.*`. A **template-shaped pattern** (`news://feed/{id}`) is by that same
  test *not* literal — `{` and `}` are metacharacters, so it **compiles** — and it still
  matches exactly its own template, because an unquantified brace sequence like `{id}` is
  a literal in the flagless regex grammar §7 pins (a `u`-flagged engine would refuse the
  very same pattern as a syntax error, which is one more place the no-flags rule is
  load-bearing, not stylistic). The
  hub never expands a template, never enumerates the concrete URIs it could produce, and
  never matches a template against a pattern's expansion. Without this rule the oracle
  "templates are filtered by the caller's resource patterns" is not assertable, because
  `{` and `}` are in the metacharacter set and every reader would guess differently.
- **Redaction keys stay family-blind.** §7's `redact:` / `redact_results:` maps are keyed
  by tool-or-pattern and now also match prompt names. Over-masking is safe (§7 says so
  for composition branches already), and the alternative — a second map per family —
  doubles the config surface to buy nothing. Prompts have no JSON Schema and therefore no
  `writeOnly` half, and that is not a cosmetic difference — it decides a default. §15's
  `log_bodies` is **on** for tunneled apps *because* our libraries declare secrets in
  both schema directions; prompts have neither direction, so the reason does not reach
  them. **Prompt-argument bodies therefore take the proxied posture regardless of the
  app's kind or transport**: a `prompts/get` row records `params.arguments` only when
  `log_bodies` is on **and** the app's `redact` map has an entry matching that prompt
  name — the owner having written that entry is the declaration that stands in for the
  missing schema. With no entry, the arguments are simply not recorded; the row, its
  outcome, timing, principal and prompt name still are. Anything else gives this family
  the strong default and none of the protection that earned it. (Prompt *results* were
  never at issue: they are message content blocks, and §15 stubs those — §20.4.)

### 20.4 Audit and hygiene per family

- **Recorded** (§15): `prompts/get` and `resources/read` write an audit row like a call —
  `event` carries the method, `tool` carries the prompt name or the resource URI (both
  columns are generic `TEXT` with no CHECK, so no migration; the URI is query-redacted and
  capped first — see below), with `duration_ms`, outcome, and the caller's client
  metadata.
- **Not recorded**: `prompts/list`, `resources/list`, `resources/templates/list`,
  `completion/complete` — listings, by §15's existing "`tools/list` is agent polling
  noise" rule.
- **Bodies** ride the same `log_bodies` gate and the same envelope: structured data
  post-redaction, unstructured content as typed size stubs. Nothing new is needed for
  prompt messages or resource contents *because* they are content blocks, and §15
  already stubs those — "the resource returned a 4 MB png" is visible without the bytes.
  Prompt **arguments** are the one place a §15 default does not carry over: §20.3 puts
  them on the proxied posture, because a prompt has no schema to declare secrets in.
- **A resource URI is not a body, and is not recorded verbatim either.** It is the row's
  `tool` column, and this is the one place §20 *tightens* a §15 rule rather than
  inheriting it. Before the URI enters `audit.tool`, its **query component is dropped and
  replaced by the literal `?…`**, and the result is capped at **1 KiB**. URIs carry
  credentials in their query strings as a matter of routine (`?access_token=`, `?sig=`,
  `?key=`) and §15's scrubbing grammar knows only the hub's *own* `pmcp_(agt|app)_` shape —
  so a verbatim URI is a documented way to write somebody else's bearer token into a
  column that any admin-token agent can read back through `audit_query` for the whole
  retention window, against §15's "token material never, in any column". The cap is there
  for the reason every body column has one: the value is caller-supplied and otherwise
  unbounded, and while 128 chars (client metadata) is too short for a real URI, 1 KiB is
  past every legitimate one. What an owner actually reads the row for — scheme, host and
  path — survives intact.
- **No approvals** (§18 decision 27), hence no new refusal code and no new column on
  `approval`.
- **The other new hygiene rule** (the URI rule above is the first): `resources/read` is the first relayed result the
  spec lets an app mark `cacheScope: "public"`, and a public result from an
  authenticated endpoint may be shared across access tokens. The hub's authorization
  context is per-token, so **the hub downgrades `public` to `private` on every result it
  relays**, in every family. One line in the serving path, and the only place where
  verbatim relay is actually unsafe.

### 20.5 Caching

The DO's catalog discipline (§6) extends unchanged to three more durable keys —
`catalog:prompts`, `catalog:resources`, `catalog:resourceTemplates` — alongside the
capability set learned at registration. Whole-write, whole-read, "a warm that draws
nothing leaves the previous cache in place", "absent means never-warmed, so re-warm;
stored `[]` is a genuinely empty set", wiped on delete. Invalidated by the matching
`notifications/prompts|resources/list_changed` frame, which the DO now routes instead of
dropping.

One rule is genuinely new, and it inverts that conservatism in exactly one case because
the reason for the conservatism does not hold there: **a successful registration whose
declared capability set omits a family clears that family's cache.** "Leave the previous
cache in place" exists to survive a *failed* warm — a transient error must never empty a
catalog — and it still does: a warm that errors or times out changes nothing, and neither
does a `server/discover` leg that fails (§6 then warms tools only, and touches no other
key). But an omission in a *successful* discover answer is not a failure; it is the
app saying it no longer serves that family. Without the clear, an app that drops
prompts serves its stale prompt catalog forever and every `prompts/get` against it becomes
a `-32000` against a list the hub is still publishing. Undeclare clears; failure does not.
The two are distinguishable precisely because the discover leg either answered or did
not. *(Pinned 2026-08-27:)* **tools is a family like any other for this rule** — a
successful discover answer omitting `tools` clears the tools catalog too. Safe for the
same two reasons the rule exists at all: only an affirmative answer can undeclare (the
`-32601`/timeout fallback warms tools and clears nothing), and the declaration is derived
by the client library from what the author's SDK actually registered (§11), never
hand-written — so an omitted `tools` means the app genuinely has none.

`resources/read` results are **never** cached: per-caller, potentially large, and the
method can answer `input_required`. Proxied apps cache nothing at all, as today —
their scoped handshake advertises the owner-declared `capabilities` config (§20.2),
which is configuration read per request, not a cache.

Consumer cache hints follow §7: `resultType: "complete"`, a `ttlMs`, and `cacheScope`
always `private` — a listing is grant-filtered, so a shared cache would serve one
agent's view to another. A result carrying `inputResponses`/`requestState` is never
given a `ttlMs` at all.

**Known ceilings, recorded rather than solved**: the hub returns whole scoped lists and
never emits `nextCursor`, so a paginating app is truncated to its first page. Consumer
cache hints remain private. A `resource_link` inside a direct application tool result is
usable from that application's scoped mount. The aggregate hub never publishes
application results or resource links; inside a program, application resources are read
only through the structured canonical-service + raw-URI API, so no embedded URI is
rewritten or made globally routable.

### 20.6 Surfaces

- **CLI** (§10): `pmcp prompts <app>` (`prompts/list`), `pmcp prompt <app>
  <name> [key=value …]` (`prompts/get`), `pmcp resources <app> [--templates]`
  (`resources/list` / `resources/templates/list`), `pmcp read <app> <uri>`
  (`resources/read`). All four are gateway sugar of the kind `tools`/`call` already are —
  they front an MCP method, not an admin op, so §8's parity list is untouched.
- **Web** (§13): `/apps/<slug>/catalog` renders the owner's scoped catalog and the
  current hub-local TypeScript mapping/diagnostics. It shows canonical scoped identity,
  not an obsolete aggregate `<slug>_<name>`. Reachability, approval, and redaction use
  the door's own matcher and policies, never page-local copies.
- **Client libraries** (§11): their transport remains transparent. The only §23 addition
  is optional `typescriptAliases` on `hub/register`; it is an author hint and does not
  change any canonical upstream service/tool name.
- **The `pmcp` builtin**: tools only. Its scoped endpoint answers empty prompt/resource
  lists and declares neither capability. Its backend reads `msg.method`, not only
  `params.name`, so another family cannot execute an admin op. §23's program catalog
  includes only the exact `adminOpsFor` subset admitted by the invoking credential.
