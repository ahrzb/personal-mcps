## 23. Hub TypeScript execution

*Added 2026-09-18. This section replaces the aggregate application catalog with a
hub-owned TypeScript orchestration surface. Application resources remain scoped on
the public MCP wire as decision 26 requires; programs receive a separate structured
resource API and do not rewrite resource URIs.*

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
`timeout_ms`. The source is at most 64 KiB after UTF-8 encoding. `timeout_ms` is in the
inclusive range 1,000–300,000 and must not exceed the owner's configured maximum.
Shape, source-size, and dynamic-maximum failures use the existing payload-free
`-32602`; the hub never clamps a requested timeout.

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
diagnostics. Search starts no Sandbox.

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
continues to carry authorization and audit identity. `credential` carries only:

- `sandboxKey`: lowercase, domain-separated SHA-256 of the exact presented bearer;
- a serializable, non-secret reference used to reauthorize.

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

Every bridge call/read reauthorizes the non-secret reference, compares its principal key
to the execution's original key, and re-reads current grants. Expiry, revocation,
account/agent deletion, rebinding, or a reused slug now pointing at a different immutable
app id returns `-32001`. The coordinator reserves up to the final 500 ms of the admitted
budget, never more than half of a short budget, then reauthorizes immediately before
publication. Refusal or failure to finish that check by the absolute outer deadline
discards result, diagnostics, stdout, and stderr and makes the outer call a metadata-only
audited `-32001`. An already-dispatched operation remains at-most-once.

The invoking bearer never enters Sandbox state, files, environment, argv, declarations,
results, audit, product logs, or errors. The digest is not an authenticator and may appear
only in Cloudflare platform diagnostics. An authorized `pmcp` operation may intentionally
return a newly issued credential to an owner/admin program exactly as a direct call does;
existing `writeOnly` masking and metadata-only outer audit apply.

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
depth 64, and 10,000 nodes. Overflow makes `execute` fail before Sandbox start,
`search_types` return a deterministic prefix with `incomplete: true`, and declaration
resources render a diagnostic banner plus an `unknown` root rather than a partially
callable API.

### 23.6 Stable hub-local TypeScript names

Name allocation and declaration rendering live in a Node-clean pure module whose
transitive imports do not touch `cloudflare:workers`, gateway, admin, tunnel, or Sandbox.
Runtime dispatch and generated declarations consume one immutable explicit map and never
reverse a TypeScript name heuristically. Upstreams always receive their original MCP
service/tool names. A proxied server needs no SDK and never renames its wire API.

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

### 23.7 Declaration contexts and schema renderer

`program.d.ts` declares read-only global `mcp: ProgramMcp`:

- `mcp.<service>.<tool>(input)` returns `Promise<CallToolResult<Output>>`; absent output
  schemas become `unknown`;
- `.resources.list()` and `.templates()` return the immutable filtered snapshot locally;
- `.resources.read(rawUri)` calls the trusted bridge using canonical service plus raw URI;
- `mcp.hub.searchTypes(input)` searches the immutable program snapshot locally.

`pmcp` appears only when the exact credential snapshot admits an operation. The program
has no `mcp.hub.execute`, generic canonical call, prompt/completion/subscription API, or
credential-bearing fetch. `client.d.ts` documents the external ergonomic facade,
including `mcp.hub.execute` and `mcp.hub.searchTypes`; it is never loaded into the program
checker.

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
into source/comments. Tests compile hostile, recursive, and fallback declarations with
TypeScript. No schema-rendering dependency is added.

### 23.8 Sandbox identity and Cloudflare configuration

The only new Worker runtime dependency is the exact-pinned
`@cloudflare/sandbox@next` platform package and its lockfile-pinned transitive closure.
Wrangler adds `enable_request_signal`, exports `HubSandbox extends Sandbox` and
`ContainerProxy`, binds `HUB_SANDBOX`, and appends a new SQLite Durable Object migration
without changing `AppConnection` history.

The container is `instance_type: "basic"` (one quarter vCPU, 1 GiB),
`max_instances: 10`, `sleepAfter: "6m"`. The deployment limit is the authoritative
account-wide capacity and maximum spend-rate guardrail; cumulative monthly usage still
depends on traffic. It does not promise a distinct user-visible capacity refusal:
Cloudflare may queue or interrupt a saturated start instead. Six minutes exceeds the 300 s
execution ceiling plus cleanup margin. A minimal multi-stage image copies the matching
Sandbox control binary into a pinned Deno base, then only immutable
`runner.ts`, `worker.ts`, and `deno.json`. A dry-run contract checks package/image
compatibility.

Hand-written Worker environment types remain authoritative. `Env` gains `HUB_SANDBOX`;
the ambient namespace type gains only the used `idFromString`/RPC members; tests bind it
as `unknown`. Both workerd projects prebundle the Sandbox module with containers disabled,
and worker tests fake one narrow adapter rather than a container.

The Sandbox/DO key is the exact-token digest. One token admits one active execution. A
concurrent second call returns transient `limit_exceeded(active_execution)` without
launch. Before its first await, admission stores the original principal key, non-secret
credential reference, client metadata, immutable catalog/map, absolute deadline, call
and concurrency counters, unguessable nonce, and generation. An expired admission that
no `run` RPC claimed may be reclaimed because it could not have touched the workspace.
Once `run` claims a generation, expiry or cancellation retains the slot until cleanup and
every timed-out SDK operation actually settles; the DO registers that quiescence promise
with its own `waitUntil`, without extending the bounded RPC response. A late operation
therefore cannot overlap or mutate a successor's workspace even after event teardown.

Each run creates a fresh fixed-layout directory, writes source, sanitized declarations,
mapping/catalog JSON, immutable runner/worker files, and `deno.json`, then performs a
bounded offline `deno check`. A failed check evaluates no user module and dispatches no
inner operation. The parent runs the identical source bytes, reads one bounded result
envelope, captures stdout/stderr separately, reauthorizes publication, and deletes the
directory. Uncertain cleanup destroys/replaces the container.

### 23.9 Deno and bridge boundary

The trusted parent runs a pinned Deno with:

- `--unstable-worker-options`;
- `--no-prompt --frozen --cached-only --no-remote --no-npm`;
- `--allow-net=mcp.internal:80` only;
- read permission for the fresh execution directory only;
- write permission for one result-envelope path only;
- `--allow-env=PMCP_EXECUTION_ID` only, containing the generation nonce;
- no run, FFI, broad filesystem, broad environment, or package permission.

The parent creates one module Worker with `deno.permissions: "none"` and transfers a
private `MessagePort` with the snapshot. The fixed entry keeps that port lexical, installs
the `mcp` global, then dynamically imports `program.ts`, awaits the required default
export, validates accessors and JSON shape through pre-import captured intrinsics, and
posts the result through the private port. Static sibling imports are insufficient here:
Deno may evaluate `program.ts` while a separate installer's top-level await is pending.
The parent owns captured fetch, nonce, and explicit alias map; caller-supplied canonical
targets and global Worker messages are ignored. The result path is outside the user
Worker's write permission.

`enableInternet` is false, and the pinned Sandbox preview exposes `outboundByHost` rather
than a separate `allowedHosts` surface. The sole registered outbound host is
`mcp.internal`. `ContainerProxy` accepts bounded POSTs on fixed call/read paths. It trusts
only platform-authored `ctx.containerId`, resolves it through
`env.HUB_SANDBOX.idFromString`, and RPCs that exact DO. It accepts no caller-supplied
sandbox id, principal, roles, app id, credential, URL, binding, or generic JSON-RPC
method.

Each bridge request presents the active nonce. The DO verifies nonce, generation,
deadline, credential, counters, and the immutable mapping before invoking the internal
dispatcher. Worker permissions are defense in depth; the load-bearing boundary is exact-
token DO/container identity, platform-authored container identity, operation-time
reauthorization, explicit mapping, limits, egress denial, and remote process timeout.

### 23.10 Reused dispatch and program semantics

The gateway extracts `dispatchTool` and `dispatchResourceRead`, and ordinary scoped
routes migrate to them before the Sandbox calls them. `dispatchTool` preserves resolve →
current filter → archived → known availability/approval ordering → availability →
strip-then-set `hub/*` metadata → backend → approval settlement → exactly one audit row.
`dispatchResourceRead` preserves resolve → current URI filter → archived → availability →
strip-then-set metadata → backend → cache decoration → exactly one URI-scrubbed audit row.
The availability-first approval rule already pinned in §7 remains authoritative.

Sandbox traffic supplies no arbitrary outer `_meta`; client capability metadata is `{}`.
A narrow request lifecycle `{ signal, waitUntil }` is threaded from Hono to the hub
backend. It owns abort cleanup and keeps the `execute` continuation alive through its
outer audit after a disconnect. An optional earlier absolute deadline travels through
backend context. An inner call/read deadline is the minimum of the existing 30 s direct
call timeout, 10 s hub-inner timeout, and remaining execution time. Direct scoped calls
retain their existing timeout.

The submitted TypeScript is one ES module with top-level await and a required default
export. Programs are non-transactional. Completed earlier calls may already have effects
when a later call, approval, runtime error, limit, or disconnect occurs. Approval-required
`-32003` is delivered as the existing typed JSON-RPC error; the program may catch it, but
continuation after human approval is never automatic. A human reruns the whole program
with the partial-effect warning.

Only a proven pre-launch `ContainerUnavailableError` may receive one short bounded retry
when time remains. Operation interruption, transport failure, process-wait abort, and any
failure after possible launch are never replayed.

### 23.11 Result and limit contract

`execute` returns a bounded union:

- `completed`: JSON value, bounded stdout/stderr, truncation flags, and operation counts;
- `type_error`: bounded deterministic diagnostics, `transient: false`,
  `mayHaveRun: false`;
- `runtime_error`: sanitized cause, bounded output, `transient`, `mayHaveRun`, and
  cleanup-escalation state;
- `limit_exceeded`: named limit, safe observed value, `transient`, and `mayHaveRun`.

Active-execution and an SDK failure proven to be a pre-launch capacity or cold-start
refusal are transient and did not run. The deployment's `max_instances` bound is a
guardrail, not a promise that Cloudflare will identify saturation separately; a queued or
interrupted saturated start keeps the stage-specific result the coordinator can actually
prove rather than being relabeled as capacity. Typecheck timeout is non-transient and did
not run. Deterministic count/size/concurrency limits and wall-clock expiry after evaluation
are non-transient; `mayHaveRun` states whether an operation could have dispatched. Input
shape/source/query failures remain `-32602`.

Limits are named constants in `server/src/limits.ts`:

- owner-selected outer wall clock, default/max initially 30 s, hard maximum 300 s, with up
  to 500 ms (never more than half) reserved for final credential reauthorization;
- typecheck 5 s; each inner operation 10 s or remaining execution time;
- source 64 KiB; search query 256 bytes;
- catalog 256 entries/2 MiB; subject 8 KiB; description 4 KiB; schema 64 KiB,
  depth 64, 10,000 nodes;
- generated declarations 1 MiB;
- 32 inner operations total, four in flight;
- bridge arguments 256 KiB and response 1 MiB;
- stdout and stderr 64 KiB each; default export 256 KiB;
- search default 10/max 50/serialized response 256 KiB;
- one active execution per exact token, ten containers account-wide.

Only waits that tests must shrink receive positive-integer environment overrides through
the existing `limits.deadlines(env)` pattern.

The worker structured-clones the export, then accepts only acyclic JSON: null, booleans,
strings, finite numbers, arrays, and plain string-keyed objects. It rejects undefined,
non-finite numbers, bigint, functions, symbols, dates, maps, sets, accessors, cycles, and
non-plain prototypes before bounded serialization.

A remote process timeout is mandatory; local observation timeout or `AbortSignal` is not
termination proof. On request abort the coordinator cancels the generation, rejects new
bridge traffic, terminates the process group, escalates to hard kill/container destroy
after bounded grace, discards output, and registers cleanup with `waitUntil`. The same
invocation lifetime remains registered until the outer execution audit is attempted. An
already-dispatched inner call may finish and audit once, but no later operation starts and
no program response is published.

### 23.12 Audit and failure hygiene

The outer hub tool call writes one metadata-only row under app `hub` and canonical tool
`execute`/`search_types`, including outcome, duration, and bounded client metadata. Hub
declaration reads record only their sanitized URI. No outer row or Worker log contains
source, query, declarations, schemas, mapping data, diagnostics, returned value,
stdout/stderr, nonce, Sandbox id, credential, or bridge body.

Inner tool/read calls retain their canonical app/service/tool/URI identity, existing
body policy, masking, and exactly one audit row. Local snapshot lists/templates/searches
write none. Newly issued credential results are masked in their inner record and absent
from the outer record. Failures name a bounded cause and explicitly state transience and
`mayHaveRun`; logs record decisions such as refusal/replacement, never progress.

### 23.13 Required proof boundary

Pure and workerd tests prove schemas, routing, identity references, reservation
concurrency/tombstones, renderer safety, limits, dispatch ordering, audit hygiene, and
SDK/provider contracts. They do not prove the Deno permission model, container network,
remote process kill, Cloudflare instance cap, package/image compatibility, or idle sleep.
A staging deployment must therefore exercise the negative permission matrix, exact-token
reuse/isolation and OAuth rotation, bridge forgery refusal, revocation during execution,
150 s execution across the former two-minute window, immutable admitted deadline during a
settings update, six-minute idle sleep, disconnect cleanup, collision stability, and
provider/three-SDK round trips. Observed facts and re-run triggers are recorded in
strategy §10.

### 23.14 Deliberate exclusions

There is no persistent workspace, package installation, remote/npm import, prompt,
completion, subscription API inside programs, asynchronous job/resume protocol,
automatic approval continuation, transaction/rollback, or saved program library. These
are excluded product capabilities, not placeholders.
