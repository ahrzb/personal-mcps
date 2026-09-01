## 20. The MCP data model beyond tools

*Added 2026-08-26. Reverses §18 decision 4 and revises decision 9; decisions 26–27 carry
the owner-level calls. Implemented as its own workflow, **after** §19.*

v1 proxied tools because tools were what agents used. Both Claude surfaces now consume
more: Claude Code turns a service's prompts into `/mcp__<server>__<prompt>` slash
commands and its resources into `@server:uri` mentions (auto-materializing list/read
tools for them), and hosted connectors list Tools, prompts, and resources as supported.
A tunneled service that already declares prompts **answers them over the socket today** —
the client libraries are transparent transports, and `ServiceConnection.forward` is
method-agnostic. The hub is the only thing saying `-32601`.

### 20.1 What is in, and what is deferred with its reason

| Family | Methods | Status |
|---|---|---|
| Prompts | `prompts/list`, `prompts/get` | **In.** Request/response on the existing envelope. |
| Resources | `resources/list`, `resources/read` | **In**, scoped endpoint only (§18 decision 26). |
| Resource templates | `resources/templates/list` | **In**, scoped endpoint only, same reason. |
| Completions | `completion/complete` | **In**, scoped endpoint only, and **filtered by its `ref`** like every other read (§20.2) — it is a relay, not a pass-through, because an unfiltered one is a read straight past the caller's patterns. Served for conformance; nothing observably consumes it, so it gets no CLI command. |
| MRTR (elicitation / sampling / roots) | `input_required` results on `prompts/get` and `resources/read` | **In.** It is a *result shape*, not a stream: the hub already relays an `input_required` leg verbatim for `tools/call`, and §7's `clientCapabilities` mirroring already tells the service what the consumer can answer. |
| `subscriptions/listen` | — | **Deferred.** In this revision it is the *only* delivery mechanism for server→client notifications, and its response IS a long-lived `text/event-stream`. The consumer surface is POST/JSON with no stream at all, and the service socket lives in a Durable Object whose seam to the worker is strictly request/response — piping a service notification into a consumer's open stream needs a new DO→worker push channel, and a permanently-open subscription inverts the DO's hibernation discipline ("an unresolved inbound request blocks hibernation"). |
| `notifications/*/list_changed` **to consumers**, `resources/updated` | — | **Deferred**, same reason: they are only deliverable on a listen stream. Consequence, pinned: every capability the hub declares keeps `listChanged: false` and `resources.subscribe` is never declared. Declaring one without serving `subscriptions/listen` would make a Claude Code v2 client open a listen stream, take `-32601`, and burn its reopen budget (3 reopens then a stop; 5 in an hour then a ~6 h wait) — degrading that consumer's freshness for the rest of the day. **Never declare a capability the transport cannot honor.** |
| `logging/*`, `notifications/message` | — | **Out.** Deprecated in 2026-07-28 itself, and per-request SSE would be needed to carry it. |
| Server-initiated JSON-RPC requests | — | **Impossible in this revision** — servers MUST NOT send them; MRTR replaced them. |

Freshness without notifications is carried by `ttlMs` (§20.5): the hub's own view stays
current because the DO still invalidates on a service's `list_changed`; only the
consumer's view lags by the TTL.

### 20.2 Routing at the door

§7's method table gains seven entries. Refusal vocabulary, filter-first ordering, and
the archived/availability checks are unchanged — a new family reuses the pipeline
rather than growing one.

**Aggregated `/<user>/mcp`** — tools and prompts only:

- `prompts/list` — every prompt the caller may use across the namespace, names prefixed
  `<slug>_<prompt>`, split at the first `_` by the same `splitAggregatedName` the tools
  path uses (slugs contain no `_`, §7). Same parallel fan-out, same 10 s per-upstream
  deadline, same `_meta["pmcp/unavailable"]`, same "the aggregate always succeeds" rule.
  Filtered by name, on the existing pure code — see the matching-key rules below, which is
  where the families stop being interchangeable.
- `prompts/get` — prefix split, then filter → archived → availability. **No approval
  gate** (§18 decision 27).
- `resources/*` and `completion/complete` → `-32601`, and the aggregated endpoint does
  not declare those capabilities. §18 decision 26 has the reasoning; the short form is
  that a URI cannot take a `<slug>_` prefix and still be the URI the service knows, and
  rewriting URIs would have to reach inside `resource_link` and embedded resource blocks
  in *tool* results too — ending "the response is relayed verbatim".

**Scoped `/<user>/mcp/<slug>`** — everything, unprefixed and unrewritten:
`prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`,
`resources/read`, `completion/complete`. This is the mount for a prompt- or
resource-heavy service, and the documentation should say so: an aggregated prompt
reaches Claude Code as `/mcp__<hubentry>__<slug>_<prompt>`, doubly prefixed, while the
scoped mount gives `/mcp__<service>__<prompt>`.

**A read is routed by the addressed slug, never by the URI it names.** §18 decision 26
resolves aggregation by not aggregating, which leaves one residual worth pinning: two
services may legitimately serve the same URI (`file:///notes.txt` is nobody's private
namespace). A caller granted that URI on service A reads it on **A's** scoped endpoint;
the identical URI on B's scoped endpoint is judged against the caller's grants *on B* and
refuses `-32001` when they do not cover it. The URI never selects the service — the URL
does. Routing by URI would be the confused-deputy shape this design has otherwise avoided
by construction.

**Capabilities.** `initialize` stays exactly what §7 pins it as — **Worker-answered,
stateless, and never a live upstream call**. Two static answers, one per endpoint shape:

- **Aggregated**: `tools` and `prompts`, both `listChanged: false`, unconditionally. An
  empty `prompts/list` is a legal answer, and a constant beats composing a union that
  could only ever tell a consumer to expect nothing. Because it is one fixed result,
  `contracts/initialize.json` keeps pinning it byte-for-byte: that fixture gains the
  `prompts` capability and stays a fixture.
- **Scoped**: derived from what the hub already **stores** for that service — the
  capability set learned at registration (§6's `server/discover`, cached in the DO) for
  tunneled services; for proxied services, an **owner-declared `capabilities` list** on
  the service's own config (§9's YAML and the `service_create`/`service_update` wire gain
  the optional key, values a subset of `tools`/`prompts`/`resources`/`completions`;
  absent means `tools` only, so every existing proxied service is unchanged). Declared
  configuration, not cache — §20.5's "proxied services cache nothing" stands — and the
  declaration gates only what the handshake *advertises*: routing stays grant-filtered
  either way, so a wrong declaration can mislead a client's feature detection but never
  widen access. All of it — with `listChanged`
  and `subscribe` forced false whatever the service claims, since the hub cannot honor
  them and must not republish them. **Never a live upstream call**: an earlier draft of
  this paragraph said "live for proxied", which would have put an unbounded round trip
  inside the handshake, with no deadline and no answer for a down upstream, in the one
  method §7 pins as stateless. A tunneled service that has **never connected** advertises
  `tools` only — the same answer it already gives, and consistent with the empty
  `tools/list` it serves from an empty catalog. A capability the hub has never been told
  about is not declared.

The union-or-intersection question the aggregated constant sidesteps has one answer worth
recording: intersection would let a single tools-only service suppress every other
service's prompts.

The **consumer→hub** `server/discover` (distinct from §6's hub→service method of the same
name) answers from those same two static pictures and changes in lockstep with this
paragraph. One source, two spellings: a divergence between what `initialize` and
`server/discover` advertise is a bug, not a degree of freedom.

**Access control.** Every family is filtered by the caller's grants before anything is
listed or forwarded, using the per-family pattern lists of §20.3. A service account with
no matching pattern in a family gets an empty list and `-32001` on a fetch —
indistinguishable from not-permitted, as everywhere else. Owners see everything. Three
rules the families do **not** share, each pinned because the obvious implementation gets
it wrong in a way nothing else catches:

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
  service. Unfiltered, this method is a read straight past the role's patterns: a caller
  with zero prompt and resource grants could enumerate whatever the service completes —
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

A role's declaration gains a family dimension (§18 decision 9). Wire shape, in
`hub/register`, in `contracts/tunnel-frames.json`, in the YAML, and in both libraries'
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
  `{ tools: [...] }` — so every service in the field, every YAML file, and every
  `serve({roles})` call keeps its exact current meaning, and a role that grants tools
  grants *nothing* in another family. The two spellings may be mixed across roles in one
  declaration. Normalization happens once, in the hub (`registry.validateRoles` and the
  filter builder); neither client library gains a rule that could disagree with it.
- **Storage**: `service.roles_json` holds the normalized per-family object. Existing rows
  hold bare lists and are read as tools-only, so no data migration exists.
- **Read shape**, pinned in one canonical wire form, because storage being normalized does
  not by itself say what a *read* returns. `service_list` / `service_get`, the YAML the
  planner diffs against, and anything the CLI prints all render the **canonical** form: a
  bare list when the role is tools-only, the per-family object otherwise. Both directions
  are pinned, and that is the point. Always rendering the object would make every YAML
  file written before this change diff against the server on the first `pmcp diff` after
  it lands; rendering whichever spelling happened to register would make the read shape a
  function of history, so `pmcp diff` would be stable or noisy by accident. One canonical
  form keeps an older CLI typed `Record<string, string[]>` correct for every tools-only
  service — which is every service in the field today — and makes the diff a function of
  meaning rather than of spelling.
- **Validation** (§6, applied identically to proxied virtual roles, §8): role names and
  the reserved `all` are unchanged; an unknown family key is a violation; every pattern
  must compile; `ROLE_PATTERN_MAX_LENGTH` bounds each pattern and `ROLE_PATTERNS_MAX`
  bounds **each family list** — the same two `limits.ts` constants, applied three times,
  so no new magic number enters the system.
- **The built-in `all` role** spans every family, present and future: it contributes
  `.*` in each without appearing in any declaration. Owners keep `["all"]`.
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
  `log_bodies` is **on** for tunneled services *because* our libraries declare secrets in
  both schema directions; prompts have neither direction, so the reason does not reach
  them. **Prompt-argument bodies therefore take the proxied posture regardless of the
  service's kind or transport**: a `prompts/get` row records `params.arguments` only when
  `log_bodies` is on **and** the service's `redact` map has an entry matching that prompt
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
  `?key=`) and §15's scrubbing grammar knows only the hub's *own* `pmcp_(sa|svc)_` shape —
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
  spec lets a service mark `cacheScope: "public"`, and a public result from an
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
service saying it no longer serves that family. Without the clear, a service that drops
prompts serves its stale prompt catalog forever and every `prompts/get` against it becomes
a `-32000` against a list the hub is still publishing. Undeclare clears; failure does not.
The two are distinguishable precisely because the discover leg either answered or did
not. *(Pinned 2026-08-27:)* **tools is a family like any other for this rule** — a
successful discover answer omitting `tools` clears the tools catalog too. Safe for the
same two reasons the rule exists at all: only an affirmative answer can undeclare (the
`-32601`/timeout fallback warms tools and clears nothing), and the declaration is derived
by the client library from what the author's SDK actually registered (§11), never
hand-written — so an omitted `tools` means the service genuinely has none.

`resources/read` results are **never** cached: per-caller, potentially large, and the
method can answer `input_required`. Proxied services cache nothing at all, as today —
their scoped handshake advertises the owner-declared `capabilities` config (§20.2),
which is configuration read per request, not a cache.

Consumer cache hints follow §7: `resultType: "complete"`, a `ttlMs`, and `cacheScope`
always `private` — a listing is grant-filtered, so a shared cache would serve one
account's view to another. A result carrying `inputResponses`/`requestState` is never
given a `ttlMs` at all.

**Known ceilings, recorded rather than solved**: the hub returns whole lists and never
emits `nextCursor` (pagination is optional for servers), so a *paginating* service is
silently truncated to its first page — which is already true for `tools/list` today and
matters more for resource lists; the hub mints its own TTL constant rather than composing
`min(service ttlMs)` across a fan-out; and a **`resource_link` inside a tool result is
dead on the aggregated endpoint**. §18 decision 26 relays such a block verbatim (rewriting
it is the thing that decision refuses), but `resources/read` answers `-32601` there, so the
link names a URI the consumer cannot fetch from the endpoint it is talking to. The scoped
mount is where a resource-linking service belongs, and §20.2 already says to document that;
this is the residue when an author does not.

### 20.6 Surfaces

- **CLI** (§10): `pmcp prompts <service>` (`prompts/list`), `pmcp prompt <service>
  <name> [key=value …]` (`prompts/get`), `pmcp resources <service> [--templates]`
  (`resources/list` / `resources/templates/list`), `pmcp read <service> <uri>`
  (`resources/read`). All four are gateway sugar of the kind `tools`/`call` already are —
  they front an MCP method, not an admin op, so §8's parity list is untouched.
- **Client libraries** (§11): no new API beyond the widened `roles` shape. The bridge is
  transparent, so a service that declares prompts or resources with its own SDK serves
  them through the hub with no library change; the libraries pass the declaration through
  and let the hub validate it.
- **The `pmcp` builtin**: tools only. Its scoped endpoint answers empty prompt and
  resource lists and declares neither capability.
