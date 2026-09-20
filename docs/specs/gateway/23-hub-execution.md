## 23. Hub JavaScript execution

*Added 2026-09-18 and revised 2026-09-19. This section replaces the aggregate
application catalog with a hub-owned JavaScript orchestration surface. Application
resources remain scoped on the public MCP wire as decision 26 requires; programs receive
a separate structured resource API and do not rewrite resource URIs.*

### 23.1 Public surface and virtual service

`POST /<user>/mcp` is the aggregate hub endpoint. It exposes exactly two tools,
`hub_execute` and `hub_search_types`, plus hub-owned TypeScript declaration resources.
It exposes no application tools, prompts, resources, completions, or generic
`<slug>_<name>` dispatch. `POST /<user>/mcp/hub` exposes the same surface with
unprefixed tool names `execute` and `search_types`. Ordinary scoped
`POST /<user>/mcp/<app>` endpoints, including `/pmcp`, retain their existing behavior.

`hub` is a reserved virtual slug beside `pmcp`, never an `app` row or app page. Every
app-creation path rejects it. A deployment must first query remote D1 for a real app
whose slug is `hub`; any match blocks the cutover and names the owner and app for an
explicit migration. The hub never shadows or auto-renames that row.

The virtual hub app is local, unarchivable, always availability-probeable, and has
`logBodies: false`. Its fixed access filter admits only its two tools and declaration
URIs. It is absent from `app_list`, `/apps`, and `/apps/hub`.

Both aggregate and scoped-hub endpoints answer `initialize` and `server/discover` from
one capability producer, in this order:

```json
{
  "tools": { "listChanged": false },
  "resources": { "listChanged": false }
}
```

They advertise no prompts, completions, or resource subscription. `tools/list` returns
only the two hub tools. Unknown or malformed tool names use the existing
indistinguishable `-32001`. `prompts/*`, `completion/complete`,
`resources/subscribe`, and `resources/unsubscribe` return `-32601`.

`subscriptions/listen` remains available on both endpoint shapes through §21's common
principal-resolution and reauthorization path. The virtual hub opens no application
subscriber sockets and emits authenticated SSE keepalives only. Its push flags remain
false.

Admin credentials remain refused on the aggregate endpoint and every real app endpoint.
They are admitted to scoped `/mcp/hub`, where their program catalog contains only the
same `pmcp` subset returned by `adminOpsFor`; in particular they cannot approve or mint
an admin successor. A zero-grant agent may use either hub endpoint for pure TypeScript.

### 23.2 Hub tools and declaration resources

`execute` takes a closed object with required string `code` and optional integer
`timeout_ms`. `code` is the body of an async TypeScript function with read-only `mcp` and
`console` bindings; top-level `await` and `return` are valid. The source is at most 64 KiB
after UTF-8 encoding. `timeout_ms` is in the inclusive range 1,000–300,000 and must not
exceed the owner's configured maximum. Shape, source-size, type, and lower-bound failures
use the existing payload-free `-32602`. An integer `timeout_ms` above the effective owner
maximum returns `-32602` with `data: { field: "timeout_ms", max }`, making the dynamic
ceiling discoverable; the hub never clamps a requested timeout.

`search_types` takes a closed object:

- `query`: required string, non-empty after trimming, at most 256 UTF-8 bytes before
  trimming;
- `surface`: optional `"program" | "client"`, default `"program"`;
- `limit`: optional integer 1–50, default 10.

The search is case-insensitive and non-fuzzy. Rank exact TypeScript path/canonical
identity, then prefix, then substring, then description substring. Tie by kind,
canonical service, then canonical subject. A result names its kind (`tool`, `resource`,
`resourceTemplate`, or `hubTool`), surface, TypeScript path, canonical service and
subject, rendered signature, direct declaration URI, and bounded mapping/catalog
diagnostics. Search starts no execution runtime.

`resources/list` returns these UTF-8 `text/typescript` resources:

- `pmcp://hub/types/client.d.ts`
- `pmcp://hub/types/program.d.ts`

`resources/templates/list` returns exactly:

- `pmcp://hub/types/services/{service}.d.ts`
- `pmcp://hub/types/tools/{service}/{tool}.d.ts`
- `pmcp://hub/types/resources/{service}/{uri}.d.ts`
- `pmcp://hub/types/resource-templates/{service}/{uriTemplate}.d.ts`

Each placeholder is one canonical string segment in exact `encodeURIComponent` form.
The reader decodes once, re-encodes, requires a byte-identical round trip, then matches
one caller-visible snapshot record. Encoded `/`, `%`, `{`, and `}` never become path
structure. A successful read returns one text block and audits only the bounded URI,
never declaration text.

Hub tool schemas, declaration templates, capability shape, and limits are exported as
named producers. `server/test/worker/contracts.test.ts` alone emits
`contracts/hub.json` and `contracts/initialize.json`. Re-generating
`contracts/errors.json` must be byte-identical: the vocabulary remains exactly six
codes and `-32602` carries no data.

### 23.3 Owner execution settings

D1 stores at most one settings row per owner:

```sql
CREATE TABLE hub_execution_setting (
  owner_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  default_timeout_ms INTEGER NOT NULL,
  max_timeout_ms INTEGER NOT NULL,
  CHECK (default_timeout_ms >= 1000),
  CHECK (default_timeout_ms <= max_timeout_ms),
  CHECK (max_timeout_ms <= 300000)
);
```

No row means the pinned defaults `30_000/30_000`. Settings are snapshotted when an
execution is admitted; later updates affect only new executions.

The `pmcp` operations are:

- `hub_settings_get({})` →
  `{ settings: { defaultTimeoutMs, maxTimeoutMs } }`;
- `hub_settings_update({ default_timeout_ms, max_timeout_ms })` requires both integers,
  validates `1_000 <= default <= max <= 300_000`, atomically upserts, and returns the
  same read shape.

These operations use `adminOpsFor` unchanged. The recent-authenticated
`/settings/execution` pane, CLI get/set commands, and external provider singleton
`pmcp_hub_settings` are presentation/declarative fronts over those operations. The
provider imports and stores the authenticated owner id, refreshes with get, updates the
pair together, and restores the default pair on destroy. No credential enters provider
state. The admin fixture remains the single schema producer.

### 23.4 Authenticated caller and reauthorization

The consumer door returns `AuthenticatedCaller = { principal, credential }`. `Principal`
continues to carry authorization and audit identity. `credential` carries only the
serializable, non-secret reference used to reauthorize. No digest or stable execution
identity is derived from the bearer.

References and liveness checks are family-specific:

- local agent key: token row id; re-read the live, unexpired row and live agent;
- Better Auth session bearer: session id; directly read the session and joined user,
  parse Better Auth's Kysely/D1 ISO-8601 `expiresAt` text as an absolute instant, and do
  not extend `updateAge` or freshness;
- OAuth JWT: live binding id, original agent id, and verified `exp`; re-read the binding
  and agent and reject expiry or principal-key change;
- admin token: row id, owner id, and original expiry; re-read the live row and same owner.

A worker test creates a session through Better Auth and pins the raw D1 date
representation. Initial resolution remains credential-first and namespace-second,
including prefix terminality, terminal OAuth failure, and the existing 401/404
anti-enumeration matrix.

Every program call/read reauthorizes the non-secret reference, compares its principal key
to the execution's original key, and re-reads current grants. Expiry, revocation,
account/agent deletion, rebinding, or a reused slug now pointing at a different immutable
app id returns `-32001`. The executor reserves up to the final 500 ms of the admitted
budget, never more than half of a short budget, then reauthorizes immediately before
publication. Refusal or failure to finish that check by the absolute outer deadline
discards result, diagnostics, stdout, and stderr and makes the outer call a metadata-only
audited `-32001`. An already-dispatched operation remains at-most-once.

The invoking bearer never enters the QuickJS runtime, guest globals, results, audit,
product logs, or errors. An authorized `pmcp` operation may intentionally return a newly
issued credential to an owner/admin program exactly as a direct call does; existing
`writeOnly` masking and metadata-only outer audit apply.

### 23.5 Caller-visible catalog

The catalog collector is an internal orchestration snapshot, not a public aggregate
list. In canonical service order it:

1. selects caller-visible real apps, excluding the virtual `hub`;
2. includes virtual `pmcp` only for user/admin credentials, using `adminOpsFor`; agents
   never receive it and admins receive no real apps;
3. skips archived apps;
4. reads tools and supported resource/template families with a 3 s per-family deadline;
5. applies the same `Registry.resolveAccess().filterList` rules as scoped listing;
6. records bounded, sanitized diagnostics for omitted unavailable/failed families;
7. retains canonical identities, bounded descriptions, schemas, and capability data.

Catalog collection allocates aliases from a fetched canonical family before caller
filtering, but a caller sees only authorized entries and diagnostics that do not identify
hidden contenders. The execution snapshot is immutable. New grants and catalog entries
appear on the next search, declaration read, or execution; revoked grants still bite at
each inner operation.

A visible catalog is capped at 256 entries and 2 MiB of raw schema/catalog bytes.
Canonical subjects are at most 8 KiB UTF-8, descriptions 4 KiB, and schemas 64 KiB,
depth 64, and 10,000 nodes. Overflow makes `execute` fail before runtime creation,
`search_types` return a deterministic prefix with `incomplete: true`, and declaration
resources render a diagnostic banner plus an `unknown` root rather than a partially
callable API.

### 23.6 Stable hub-local TypeScript names

Name allocation and declaration rendering live in a Node-clean pure module whose
transitive imports do not touch `cloudflare:workers`, gateway, admin, tunnel, or the
QuickJS runtime. Runtime dispatch and generated declarations consume one immutable
explicit map and never reverse a TypeScript name heuristically. Upstreams always receive
their original MCP service/tool names. A proxied server needs no SDK and never renames its
wire API.

D1 stores durable reservations:

```sql
CREATE TABLE typescript_name_reservation (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('service', 'tool')),
  canonical_name TEXT NOT NULL,
  typescript_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner', 'sdk', 'generated')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (owner_id, app_id, family, canonical_name, typescript_name)
);
```

Partial unique indexes reserve service aliases per owner and tool aliases per immutable
app id across active rows and tombstones. Exact index/identity columns may be normalized
in migrations, but these invariants are mandatory. Disappearance, superseded aliases,
and app deletion tombstone instead of releasing a name; owner deletion cascades. D1
atomic batches and unique constraints arbitrate concurrent discovery, and a loser
re-reads committed reservations before publishing.

Aliases have two lanes:

- tunneled `hub/register` may include
  `typescriptAliases: { service?: string, tools?: Record<canonicalName, alias> }`;
  JS, Python, and Go transports preserve that shape;
- app create/update may include owner `typescript_aliases` with the same inner shape;
  UI, CLI, and provider expose it, including for proxied apps.

App reads expose owner configuration as `typescriptAliases`, separately from resolved
mapping diagnostics. Owner configuration outranks SDK hints, which outrank generated
defaults. Omission never clears an assignment. Invalid syntax returns payload-free
`-32602`. An owner collision refuses the whole write atomically. An SDK collision does
not disconnect a healthy tunnel: registration succeeds, established assignments remain,
the conflicting unassigned member is omitted, and a bounded `alias_conflict` diagnostic
is attached to the existing connect audit decision and owner/search views. There is no
extra progress audit row.

An explicit valid alias is ASCII `[A-Za-z_$][A-Za-z0-9_$]*`, 1–128 bytes, excluding
JavaScript keywords, Object-prototype/Promise-sensitive names including `then`, fixed
namespace members, root `hub`/`pmcp`, and per-service `resources`.

Generated candidates:

1. split the canonical name on runs of non-ASCII-alphanumeric characters;
2. lower-camel by lowercasing the first ASCII letter of the first segment and
   uppercasing the first ASCII letter of each later segment, preserving other casing;
3. prefix `_` for a leading digit or a reserved/sensitive name;
4. omit with a diagnostic when no ASCII-alphanumeric segment exists.

Group every unassigned identity by candidate before writing. A singleton with a free
candidate is persisted. An established active/tombstoned reservation keeps its API and
newcomers are omitted. Two or more identities first appearing together for one free
candidate are all omitted. Never suffix or sort-to-pick. A deliberate alias change is a
clean cutover for new snapshots and tombstones the old path. No release/reuse interface
exists.

Only service/tool names have aliases. Resources retain raw URIs. Snapshot entries pin
immutable app id plus canonical slug/name. A bridge operation returns `-32001` when the
slug now resolves to another app id. A returning canonical tool may reactivate only its
own unchanged reservation. Recreating an app requires a new TypeScript service alias
even if its wire slug is reused.

### 23.7 Declaration contexts and program surface

`program.d.ts` documents the read-only `mcp: ProgramMcp` binding:

- `mcp.<service>.<tool>(input)` returns `Promise<CallToolResult<Output>>`; absent output
  schemas become `unknown`;
- each tool function carries frozen `inputSchema` and `outputSchema` properties containing
  a bounded JSON copy of the upstream schemas, or `null` when absent;
- `.resources.list()` and `.templates()` return the immutable filtered snapshot locally;
- `.resources.read(rawUri)` calls trusted host dispatch using canonical service plus raw
  URI;
- `mcp.hub.searchTypes(input)` searches the immutable program snapshot locally.

`pmcp` appears only when the exact credential snapshot admits an operation. The program
has no `mcp.hub.execute`, generic canonical call, prompt/completion/subscription API,
credential-bearing fetch, module loader, or host global. `client.d.ts` documents the
external ergonomic facade, including `mcp.hub.execute` and `mcp.hub.searchTypes`.

The in-repo schema renderer handles only a bounded type-shaping subset: primitives and
type arrays; JSON `enum`/`const`; objects with `properties`, `required`, and
`additionalProperties`; arrays/tuples with `items`/`prefixItems`; `anyOf`/`oneOf` unions;
`allOf` intersections; and local JSON Pointer refs represented by deterministic,
pointer-sorted aliases so cycles are legal. Validation-only constraints may broaden the
TypeScript type. Invalid/external refs, unsupported type-shaping keywords, over-limit
nodes, or unsafe values become `unknown` with a diagnostic, never a narrower type.

The renderer deep-copies JSON values after byte/node/depth validation, performs no I/O,
never resolves file/HTTP/package references, uses `JSON.stringify` for literals, emits
only validated generated identifiers, and never injects upstream descriptions or names
into source/comments. The exact-pinned TypeScript compiler checks each submitted body
against this caller-specific declaration before QuickJS starts. Syntax and semantic
failures return bounded diagnostics with submitted-source line and column; no guest code
or inner operation has run. An unknown `mcp.<service>.<tool>` member is shortened to the
service and misspelled member, with a nearest unambiguous tool suggestion when available;
the diagnostic never dumps the service's complete structural type.

### 23.8 QuickJS runtime and Cloudflare configuration

The Worker exact-pins `typescript`, `@cfworker/json-schema`,
`quickjs-emscripten-core`, and `@jitl/quickjs-wasmfile-release-sync`. TypeScript performs
the in-memory preflight and emits JavaScript; the Worker-safe validator interprets
application input schemas without dynamic code generation. Wrangler only recognizes the
deployable QuickJS artifact when it is imported relative to Worker source, so
`server/src/quickjs-release-sync.wasm` is a byte-for-byte copy of the pinned package's
`dist/emscripten-module.wasm`; update the package and copy together. Wrangler imports that
file as a Worker `WebAssembly.Module` and instantiates it once per Worker isolate. It is
not the Asyncify variant: host operations return native QuickJS promises and resume the
guest by executing pending jobs after settlement.

Each execution typechecks and emits the submitted body in memory before loading QuickJS.
Only a clean compilation creates a fresh QuickJS runtime and context, installs limits and
bindings, evaluates the emitted uninvoked async function, removes every guest-reachable
dynamic source compiler, invokes the function, and disposes the whole runtime in a
`finally` block. The context retains QuickJS's Eval intrinsic only for trusted host-side
compilation and bounded JSON conversion; before guest code runs, `eval`, `Function`, and
the constructor property on ordinary, async, generator, and async-generator function
prototypes are irreversibly replaced with `undefined`. Heap, global objects, prototypes,
pending jobs, and module state are never reused between executions. The Worker exposes no
filesystem, environment, socket, Worker binding, `fetch`, timer, module loader, `eval`, or
`Function` capability to the guest. QuickJS built-ins are available only inside the
isolated guest heap.

Wrangler declares one Wasm module rule and retains `enable_request_signal`; it has no
`HUB_SANDBOX` binding, Container declaration, Sandbox SDK, container image, or execution
Durable Object export. Migration tags remain immutable history: a new migration deletes
the obsolete `HubSandbox` class without changing `AppConnection` history. Removing the
binding and container eliminates warm residency and per-token container capacity.

### 23.9 Host-call boundary

The host builds `mcp` directly from the immutable catalog snapshot. Every callable closes
over the canonical service, immutable app id, and canonical tool name; user input contains
only tool arguments or a resource URI and can never select another target. The installed
tree and each schema value are recursively frozen. Runtime dispatch never reconstructs a
canonical name from a JavaScript alias.

A host callable validates the guest argument against the bounded application input schema
before incrementing counters or dispatching. A refusal rejects the guest promise with
`-32602` plus a bounded `input...` path and reason, so user code may catch it; an uncaught
refusal becomes a reported runtime exception with no inner operation. An admitted call
then checks the execution deadline, concurrency, operation and byte caps before starting
the existing Worker dispatcher. When dispatch settles, the host converts the bounded JSON
answer or a typed JSON-RPC error into the guest heap, settles the QuickJS promise, and
pumps pending jobs. No generic bridge request, private hostname, nonce,
container id, or guest-controlled JSON-RPC method exists.

Cloudflare freezes `Date.now()` while CPU-only Worker code executes, so a wall-clock check
alone cannot stop a non-yielding guest in production. The QuickJS interrupt handler checks
the absolute deadline and request abort signal when the platform clock or signal advances,
and also consumes a deterministic 10,000-callback CPU budget across compilation and
execution. Exhausting that budget returns `limit_exceeded` for `cpu`. Memory and stack
limits are installed before emitted JavaScript evaluation. While the guest is suspended on a host
promise, the dispatcher's own deadline is the minimum of the existing direct-call timeout,
ten seconds, and the remaining execution budget. A timed-out or disconnected run is
disposed; late host work may finish and audit once but never re-enters the disposed guest.

### 23.10 Reused dispatch and program semantics

The gateway extracts `dispatchTool` and `dispatchResourceRead`, and ordinary scoped
routes use the same functions the QuickJS host bindings use. `dispatchTool` preserves
resolve → current filter → archived → known availability/approval ordering → availability
→ strip-then-set `hub/*` metadata → backend → approval settlement → exactly one audit row.
`dispatchResourceRead` preserves resolve → current URI filter → archived → availability
→ strip-then-set metadata → backend → cache decoration → exactly one URI-scrubbed audit
row. The availability-first approval rule already pinned in §7 remains authoritative.

Program traffic supplies no arbitrary outer `_meta`; client capability metadata is `{}`.
A narrow request lifecycle `{ signal, waitUntil }` is threaded from Hono to the hub
backend. It owns abort disposal and keeps the `execute` continuation alive through its
outer audit after a disconnect. An optional earlier absolute deadline travels through
backend context. An inner call/read deadline is the minimum of the existing 30 s direct
call timeout, 10 s hub-inner timeout, and remaining execution time. Direct scoped calls
retain their existing timeout.

The submitted source is an async TypeScript function body. Programs are
non-transactional. Completed earlier calls may already have effects when a later call,
approval, runtime error, limit, or disconnect occurs. Approval-required `-32003` is
delivered as an error carrying the existing JSON-RPC code and data; the program may catch
it, but continuation after human approval is never automatic. A human reruns the whole
program with the partial-effect warning. The executor never automatically replays source
or an inner operation.

### 23.11 Result and limit contract

`execute` returns a bounded union:

- `completed`: JSON return value, bounded stdout/stderr, truncation flags, and operation
  counts;
- `type_error`: bounded TypeScript diagnostics with code/message and submitted-source
  location when available; it is non-transient and `mayHaveRun` is false;
- `runtime_error`: sanitized cause, bounded exception message and stack, bounded output,
  `transient`, and `mayHaveRun`;
- `limit_exceeded`: named limit, safe observed value, `transient`, and `mayHaveRun`.

Syntax and semantic failures are `type_error` results before QuickJS evaluation. Guest
exceptions and invalid return values are non-transient runtime errors and report whether
an operation dispatched. Exception stacks name `program.ts` locations but never include a
source excerpt. Deterministic count/size/concurrency, heap, stack, and CPU-interrupt limits are
non-transient; the outer wall-clock deadline still bounds waits and yielding programs.
`mayHaveRun` states whether an operation could have dispatched. Input shape, source, and
query failures remain `-32602`.

Limits are named constants in `server/src/limits.ts`:

- owner-selected outer wall clock, default/max initially 30 s, hard maximum 300 s, with up
  to 500 ms (never more than half) reserved for final credential reauthorization;
- each inner operation 10 s or remaining execution time;
- QuickJS heap 16 MiB, stack 64 KiB, and 10,000 interrupt callbacks per execution;
- at most 20 compiler diagnostics, 2 KiB per diagnostic/exception message, and an 8 KiB
  exception stack;
- source 64 KiB; search query 256 bytes;
- catalog 256 entries/2 MiB; subject 8 KiB; description 4 KiB; schema 64 KiB,
  depth 64, 10,000 nodes;
- generated declarations 1 MiB;
- 32 inner operations total, four in flight;
- host-call arguments 256 KiB and response 1 MiB;
- stdout and stderr 64 KiB each; returned value 256 KiB;
- search default 10/max 50/serialized response 256 KiB.

Only waits that tests must shrink receive positive-integer environment overrides through
the existing `limits.deadlines(env)` pattern.

The host accepts only acyclic JSON crossing either direction: null, booleans, strings,
finite numbers, arrays, and plain string-keyed objects. It rejects undefined, non-finite
numbers, bigint, functions, symbols, dates, maps, sets, accessors, cycles, and non-plain
prototypes before bounded serialization. Conversion uses JSON text produced only after
that validation, never executable caller-controlled fragments.

On request abort the executor rejects new host operations, checks the abort flag at
QuickJS interrupt callbacks, disposes the runtime, discards output, and registers any
already-dispatched operation with `waitUntil`. The deterministic CPU budget ensures
non-yielding bytecode still returns control even when the platform cannot deliver an abort
until synchronous Wasm execution ends. The invocation lifetime remains registered until
the outer execution audit is attempted. An already-dispatched inner call may finish and
audit once, but no later operation starts and no program response is published.

### 23.12 Audit and failure hygiene

The outer hub tool call writes one metadata-only row under app `hub` and canonical tool
`execute`/`search_types`, including outcome, duration, and bounded client metadata. Hub
declaration reads record only their sanitized URI. No outer row or Worker log contains
source, query, declarations, schemas, mapping data, diagnostics, returned value,
stdout/stderr, guest heap data, credential, or host-call body.

Inner tool/read calls retain their canonical app/service/tool/URI identity, existing
body policy, masking, and exactly one audit row. Local snapshot lists/templates/searches
write none. Newly issued credential results are masked in their inner record and absent
from the outer record. Failures name a bounded cause and explicitly state transience and
`mayHaveRun`; logs record decisions such as refusal, never progress.

### 23.13 Required proof boundary

Pure and workerd tests prove schemas, routing, identity references, reservation
concurrency/tombstones, renderer safety, limits, dispatch ordering, audit hygiene, guest
isolation, host-call target closure, interrupt handling, memory/stack caps, fresh runtime
state, and SDK/provider contracts. A staging deployment must additionally measure isolate
cold bootstrap and warm-isolate/fresh-runtime latency; exercise network, environment,
filesystem, dynamic-code, module-import and Worker-binding negatives; prove revocation
during execution, disconnect disposal, immutable admitted deadline during a settings
update, collision stability, and provider/three-SDK round trips. Observed facts and re-run
triggers are recorded in strategy §10.

### 23.14 Deliberate exclusions

There is no persistent workspace, package installation, remote/npm import, prompt,
completion, subscription API inside programs, asynchronous job/resume protocol,
automatic approval continuation, transaction/rollback, or saved program library. These
are excluded product capabilities, not placeholders.
