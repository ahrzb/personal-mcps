## 21. Push: the listen stream and server→consumer notifications

*Added 2026-09-01. Reverses the last surviving half of §18 decision 4; decision 28
carries the owner call ("support the entirety of the MCP spec"). Implemented as its own
workflow (D14), after §20.*

§20 deferred `subscriptions/listen` and every server→consumer notification for one
architectural reason: the consumer surface was POST/JSON with no stream, and the DO↔worker
seam was request/response — delivering a service's notification into a consumer's open
stream needed a push channel that did not exist, and holding a stream open in a DO
inverts its hibernation discipline. The D14 probe (2026-08-31) measured that reason away
rather than arguing with it: a **Worker invocation can hold the consumer's
`text/event-stream` itself** — Workers bill CPU, not wall-clock, so an idle held stream
is effectively free — and it reaches each service's DO over an **outbound WebSocket the
DO accepts as a hibernatable socket**, which is precisely the missing push channel and
hibernates like any other (~1e-5 USD/day per idle stream, measured). The shape the
deferral rightly feared — the *DO* holding the stream — bills wall-clock (~$4/month per
idle stream, also measured) and stays refused. With the reason gone, the posture is the
owner's: the hub is a full intermediary, honoring every transport feature of MCP
2026-07-28 whether or not today's consumers exercise it. One of them doesn't: claude.ai's
connector proxy never opens a listen stream (verified live in the probe; the vendor calls
it not planned), so the hosted surface cannot hear any of this — **inert there, not
broken**, and Claude Code opens the stream today.

### 21.1 The listen stream

`subscriptions/listen` joins §7's method table on **both** endpoint shapes. It is
**listing-class**: it always succeeds for an authenticated caller the door admits, and an
empty stream is a legal answer exactly as an empty list is.

- **Refusals mirror the listings, not the calls.** A caller whose grants match nothing
  gets a stream that never rings — indistinguishable from a namespace where nothing
  changes, the same anti-enumeration posture as an empty `tools/list`. That sentence is
  shape-aware: on the **aggregated** endpoint it is literal (zero grants namespace-wide
  still opens a stream); on the **scoped** endpoint §7's access rules run first — a
  caller with no grant on the addressed service gets §7's **404** exactly as for any
  other method (the stream must not become the one method that leaks a service's
  existence), and the never-ringing stream belongs to the caller §7 admits whose
  patterns match nothing. On the scoped
  endpoint an archived service refuses `-32002` before the stream opens for a caller §7
  admits — a 404-class caller stays 404 and never learns archived (every scoped
  method's rule); on the aggregated endpoint archived services are simply not subscribed.
  **Availability is never checked**: a stream against an offline service is the point —
  the bell rings when it comes back changed.
- **The response is a `text/event-stream` held open by the Worker invocation**, carrying
  JSON-RPC notifications as SSE data frames and an SSE comment as keepalive every
  `LISTEN_KEEPALIVE_MS` (a `limits.ts` constant; the value is incidental, the existence
  of a keepalive is not — intermediaries kill silent connections). The same tick carries
  the stream's re-authorization (§21.2), so the constant does double duty and the
  revocation window equals the keepalive window.
- **Session id is correlation, never authentication.** The response carries an
  `Mcp-Session-Id` the hub **always mints** (UUID) — a client-supplied one is never
  echoed, so the id's shape and uniqueness are the hub's own and it can never collide
  with another stream's by accident or by choice. The bearer token decides everything
  on every request, exactly as §7 pins; the session id's one load-bearing use is
  matching a `resources/subscribe` to the stream it should feed, and that match
  requires **principal equality as well as the session id** (§21.4) — the id selects
  among the caller's *own* streams and nothing else. A guessed or replayed session id
  therefore steals nothing: aimed at another principal's stream it matches nothing,
  and aimed at one's own it aims a doorbell that bearer already had the right to hear.
- **No replay.** A reopened stream starts fresh: no `Last-Event-ID`, no buffered
  missed doorbells, no resumption. A doorbell is a hint to re-list, and a client that
  just reopened re-lists anyway; buffering hints for the disconnected is state without a
  customer. Subscriptions (§21.4) die with the stream for the same reason.

### 21.2 Delivery: Worker holds the stream, DOs ring it

On stream open the Worker resolves the principal and reads its grants — the same reads
the aggregated fan-out already performs — and opens one outbound WebSocket to each
granted **tunneled** service's DO, which the DO accepts via `ctx.acceptWebSocket`
tagged **`sub:<session-id>`**, with the resolved principal stored in the socket's
attachment. The `sub:` prefix is the class invariant, not a convention: a
`getWebSockets(service.id)` lookup can never return a subscriber socket, because a
prefixed tag never equals a bare id — and the prefix is the *only* thing separating the
classes, since service ids are themselves UUIDs (§6 tags the service socket with the
bare id), so nothing about an id's shape can carry the invariant. Every reader inside
the DO therefore selects by **class, never by position**: the service socket is the one
tagged with the bare service id, whatever else the DO holds and in whatever order the
sockets were accepted. This is the mechanism behind every "subscriber sockets are
different" claim below. Frames arriving on those sockets
are pumped to the SSE stream **payload-verbatim, admission-filtered**: the invocation
knows its endpoint shape and forwards only the frames that shape serves — tools and
prompts bells on an aggregated stream; all three bells plus `resources/updated` on a
scoped one. (The DO rings every subscriber socket it holds; the shape filter lives in
the Worker, the only party that knows the shape.) The invocation ends when the consumer
disconnects; the subscriber sockets close with it.

- **Subscriber sockets are a class of their own.** §6's at-most-one-connection invariant
  is about the *service* socket — the one the bot registers on. A DO holds at most one of
  those and any number of subscriber sockets; a subscriber socket never receives consumer
  traffic, never counts as "online", and is never evicted by `hub/replaced` — all three
  properties bought by the `sub:` tag prefix above. **Archive and token revocation touch
  only the service socket**: `service_archive` severs the service connection (close
  `4002`, §6) and a token revoke severs the socket that token opened (`4001`) —
  subscriber sockets carry neither credential and stay open, and the archived case
  reaches streams through the re-auth tick below. Service **delete** closes subscriber
  sockets too. **Any subscriber-socket close the
  Worker did not initiate ends the whole SSE stream** — service delete, DO restart, and
  hub deploy (§15's "deploys terminate all WebSockets" covers this class too) alike.
  Fail loud, not deaf: a stream that silently stopped hearing one of its services is the
  one failure a doorbell design cannot afford, and the client's ordinary reopen rebuilds
  the fan-out against current state.
- **The stream re-authorizes itself on the keepalive cadence.** A held stream is one
  request, and §15's "revocation is immediate" is a per-request property — so on every
  `LISTEN_KEEPALIVE_MS` tick the Worker re-resolves the bearer and re-reads the grant
  set, the same reads the open performed. A revoked or expired token, a deleted account,
  or (scoped) an archived or deleted service **closes the stream**; a grant revoked
  mid-stream **drops that service's subscriber socket**, and the subscriptions riding it
  (§21.4) die with the socket, so no `resources/updated` outlives the grant that
  authorized it — on the aggregated shape the stream narrows and stays open, while a
  scoped stream whose caller lost its last grant on the service **closes** (a fresh open
  would now 404, and the tick answers as the door would); a grant added mid-stream is
  subscribed on the next tick, and the Worker itself rings once **the family bells its
  endpoint shape serves that the changed service's stored capability set contains** — a
  tools-only service granted mid-stream rings the tools bell alone, because no other
  family of the caller's view changed. Between ticks the stale window is at most one
  keepalive interval, and what fits in that window is a doorbell — content still
  re-enters the filter-first pipeline on every re-list.
- **Fan-out width is capped, and must be measured before it is trusted.** The platform
  caps simultaneous open connections per invocation (documented at six), and the D14
  probe measured **one** held subscriber socket, not many. `LISTEN_FANOUT_MAX`
  (`limits.ts`) bounds how many DOs one stream subscribes — services taken in
  deterministic slug order, the excess silent until reopen (recorded ceiling, §21.7;
  upgrade path: fan in through one DO). Verifying the real concurrent-hold width is a
  D14 implementation-time probe obligation; the constant's value follows the
  measurement.
- **Proxied services never ring.** There is no channel to ring from: a Worker cannot
  hold a long-lived outbound stream to the upstream past its own invocation, and proxied
  services have no DO by design (§20.5 "proxied services cache nothing"). Their
  capabilities stay `listChanged: false` / no `subscribe` (§21.5) so a correct client
  never expects otherwise. The `pmcp` builtin contributes no bell either — its tools
  never change.

### 21.3 What rings: doorbell, not data

The hub forwards the **fact** of change, never content. A consumer-facing
`notifications/tools/list_changed` / `prompts/list_changed` / `resources/list_changed`
frame carries nothing but its method — so the aggregated endpoint's `<slug>_` prefix
question never arises (there is no name to prefix), and push adds **no second path to
content past grants**: the only way to learn *what* changed is to re-list, and the
re-list is grant-filtered like every read since §7. This is the security half of
decision 28. The qualifier is deliberate: the bell is computed on the **whole** stored
catalog, not the caller's filtered view, so a caller granted a sliver of a service can
learn *that* something changed, and when, in parts it cannot see — a change-**timing**
oracle, confined to services the caller already holds some grant on, recorded as a
ceiling in §21.7 with its upgrade path.

**The bell rings when the hub's stored catalog changes, not when the service says
something changed.** The DO already invalidates and re-warms on a service's
`list_changed` (§6); the consumer bell rings at the *write*, when the re-warmed
catalog's **canonical JSON serialization** differs from the stored one's — the DO reads
before it writes, and the comparison is over that serialization because DO storage
round-trips structured clones, not bytes. **Absent and stored `[]` compare equal for
ringing** (they already answer the same empty list, §20.5), so a first registration
writing `[]` into never-warmed family keys rings nothing; the undeclare that rings is
the one that emptied a non-empty catalog. Consequences, each intended: a noisy service
that spams `list_changed` without changing anything rings no consumer bell; a
registration whose discover answer undeclares a non-empty family (§20.5 — the clear *is*
a catalog change) rings; a failed warm (which changes nothing, §20.5) does not. A write
to **either** resource catalog — the resource list or the templates list — rings
`notifications/resources/list_changed`, once per warm: MCP defines no templates frame,
the same one-frame-covers-both rule §6 pins. And the bell has a floor: the first ring in
a quiet window is immediate (leading edge); further changes inside
`LISTEN_BELL_MIN_INTERVAL_MS` (`limits.ts`) are suppressed and coalesced into one
trailing ring at the interval's end, fired by the DO's alarm **unconditionally when it
runs** — so a burst delivers at most two frames, the leading one and the final state,
and **the final state always rings**. The coalescing alarm shares the DO's single alarm
slot with §6's registration deadline: multiplexed, never clobbered — a socket accept
cancels no pending ring, and a subscriber accept never arms the deadline. A service flipping
its catalog at socket speed therefore drives each consumer to at most one re-list per
interval — no more than any consumer could already inflict on the fan-out unprompted, so
push hands a rogue service no lever a curious consumer didn't have. Aggregated streams
ring the family's bell whichever granted service changed; bursts across *services* are
not coalesced (clients debounce their re-list).

Families follow the endpoint shape of §20.2: an aggregated stream rings tools and
prompts bells only; a scoped stream rings all three families for its service, plus
`resources/updated` (§21.4).

**Hub-originated changes ring only through the re-auth tick** (§21.2): a grant added or
revoked, an archive, or a delete changes the stream's subscribed-service set within one
keepalive interval, and the Worker rings the affected family bells itself when the set
changes — it is the party that knows. The residue is pattern-level drift: a role edit
that changes *which entries* a caller sees without changing *which services* rings
nothing (recorded ceiling — bells originate in service DOs, and the tick compares
membership, not patterns). Proxied services stay unrung in every case.

### 21.4 `resources/subscribe` and `resources/updated`

Scoped endpoint, tunneled services only — the one push feature that is per-URI rather
than per-catalog. On a proxied service or the builtin both methods are `-32601`: the
capability is never advertised for them (§21.5) and there is nowhere to forward.

- **Subscribe is filtered like a read.** The URI is matched against the caller's
  resource patterns (§20.3) and refused `-32001` before anything reaches the service —
  an unfiltered subscribe is a standing read past the role's patterns. Passing, the
  frame is forwarded with its params unrewritten over the socket (the frame shape is
  §6's, unchanged; the author's SDK answers it natively, so neither client library
  changes), carrying the same `_meta` §7 pins — `hub/principal`, `hub/roles`, the
  mirrored `clientCapabilities` — under the same `hub/*` strip-then-set hygiene as
  every forwarded family (§20.2).
- **The subscription set lives on the subscriber socket**, as its attachment in the DO:
  the DO locates the socket tagged `sub:<session-id>` **and requires the socket's stored
  principal to equal the subscriber's** before adding the URI — the session id selects,
  the principal authorizes, so a subscribe can never mutate another bearer's stream
  (§21.1's safety sentence rests on this check). The set is bounded like every
  caller-supplied list (§20.3's discipline): at most `LISTEN_SUBSCRIPTIONS_MAX` URIs per
  socket, each at most `SUBSCRIBE_URI_MAX_BYTES` (both `limits.ts`) — a subscribe past
  either cap is refused `-32602` before anything is stored or forwarded, which keeps the
  attachment far inside `serializeAttachment`'s 16 KB (§5) — and `-32602` thereby joins
  §7's consumer-visible refusal vocabulary (and its `errors.json` fixture) as the sixth
  code, the first the door has ever emitted to a consumer. Attachments survive
  hibernation (pinned by the testing strategy's `smoke.test.ts` / `hibernation.test.ts`,
  strategy §3), and the set dies with the socket — the correct MCP lifetime, since
  subscriptions are session-scoped, and also the revocation path: §21.2's tick drops the
  socket when the grant goes, and no `updated` outlives it. A subscribe whose
  session-and-principal pair matches no live stream is still forwarded (it is a legal
  MCP request) and its notifications are simply undeliverable. `resources/unsubscribe`
  mirrors: filter, match, remove from the attachment, forward.
- **`notifications/resources/updated` joins the frames the DO reads** (§6's read-set
  amendment) and is routed **only** to subscriber sockets whose set contains the frame's
  URI, by exact string match. Grant filtering already happened at subscribe time; the
  exact-match check is what makes a rogue frame inert — a service emitting `updated` for
  URIs nobody subscribed rings nobody, and one for a URI *someone* subscribed reaches
  exactly the streams that proved their right to it. Everything else the service
  originates is still dropped.

### 21.5 Capabilities flip in lockstep with the transport

§20's consequence pin was **never declare a capability the transport cannot honor** —
never "declare false forever". It now binds the other direction with equal force: the
declaration and the transport flip **in the same deploy**, because a served-but-undeclared
stream is a client that never opens it (Claude Code registers `list_changed` handlers
only per advertised capability — probe-verified), and a declared-but-unserved one burns
the client's reopen budget (§20.1's original warning).

- **Aggregated**: still one constant, still a byte-for-byte fixture
  (`contracts/initialize.json`): `tools` and `prompts`, both `listChanged: true`.
- **Scoped, tunneled**: `listChanged: true` on each family the stored capability set
  contains; `resources.subscribe: true` when `resources` is among them. A never-connected
  service advertises `tools` with `listChanged: true` — honest before the first
  registration because the bell rings on the first write that **changes** a stored
  catalog, which the first non-empty registration is (§21.3's absent ≡ `[]` keeps an
  empty first warm silent, and an empty catalog has nothing to hear about). An
  **unresolvable slug** answers this same never-connected shape — the handshake must not
  become a service-existence oracle (§20.2's anti-enumeration posture).
- **Scoped, proxied**: unchanged — `listChanged: false` everywhere, `subscribe` never;
  §21.2 has the reason. The owner-declared `capabilities` list (§20.2) still gates only
  which families are *advertised*, and none of it advertises push.
- **Scoped, `pmcp` builtin**: `listChanged: false` everywhere, `subscribe` never — no
  DO, no channel to ring from (§21.2), the same reason as proxied. The capability shape
  is therefore a function of the service's *kind*, not only of its stored capability
  list.
- `server/discover` (consumer-facing) answers from the same two pictures — §20.2's
  one-source-two-spellings rule carries the flip with no new rule.

### 21.6 Audit

- **Streams, doorbells, and `updated` relays write no rows** — listing-class, §15's
  polling-noise rule. A stream's open is visible in ordinary request logs; a bell
  carries nothing worth recording.
- **`resources/subscribe` and `resources/unsubscribe` write rows like a read** — rare,
  deliberate, and they name a URI, which is exactly the sensitivity `resources/read`
  records: same event/`tool`-column shape, same §20.4 URI hygiene (query dropped to
  `?…`, 1 KiB cap), no bodies (there are none).

### 21.7 Ceilings, recorded rather than solved

No replay buffer (§21.1). The change-timing oracle: the bell is computed on the whole
catalog, so a narrowly-granted caller learns *that* and *when* unseen parts of a granted
service changed, and a revoked grant keeps that signal for at most one keepalive
interval (§21.2/§21.3; upgrade path: ring on the caller-filtered projection).
Pattern-level role drift rings nothing (§21.3) — and, the other half of the same gap,
it revokes nothing: the re-authorization tick compares grant MEMBERSHIP, so drift that
narrows a role's `resources` patterns while leaving the grant standing leaves live
per-URI subscriptions in place, and `updated` keeps arriving for a URI the caller's
current patterns would now deny (grant filtering happened at subscribe time, §21.4).
Bounded by the stream's own lifetime; ended by losing the grant, or by a reopen
(§21.1's "subscriptions die with the stream"). Upgrade path: re-run `resolveAccess` per
subscribed URI on the tick and prune the attachment. Cross-service bursts are not coalesced
(§21.3). `LISTEN_FANOUT_MAX` bounds a stream's subscriber sockets, excess services
silent until reopen (§21.2; upgrade path: fan in through one DO). A
non-Worker-initiated subscriber-socket close ends the whole stream, so one DO restart
costs an N-service stream a reopen (§21.2 — chosen over deafness). N open streams from
one principal hold N subscriber-socket sets with no fan-in dedupe — at personal scale, N
is small and the sockets are near-free. Each has its upgrade path written beside it;
none blocks conformance, because MCP requires honoring the transport, not clairvoyance.
