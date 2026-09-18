## 21. Push: the listen stream and server→consumer notifications

*Added 2026-09-01. Reverses the last surviving half of §18 decision 4; decision 28
carries the owner call ("support the entirety of the MCP spec"). Implemented as its own
workflow (D14), after §20.*

§20 deferred `subscriptions/listen` and every server→consumer notification for one
architectural reason: the consumer surface was POST/JSON with no stream, and the DO↔worker
seam was request/response — delivering an app's notification into a consumer's open
stream needed a push channel that did not exist, and holding a stream open in a DO
inverts its hibernation discipline. The D14 probe (2026-08-31) measured that reason away
rather than arguing with it: a **Worker invocation can hold the consumer's
`text/event-stream` itself** — Workers bill CPU, not wall-clock, so an idle held stream
is effectively free — and it reaches each app's DO over an **outbound WebSocket the
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

`subscriptions/listen` remains on aggregate, virtual `hub`, and scoped endpoints. It is
listing-class and reauthenticates on the keepalive cadence. Scoped real apps retain this
section's filter → archived ordering and never check availability.

The aggregate replacement changes its fan-out: aggregate and scoped `hub` open no
application subscriber sockets because the hub capability flags are fixed false. Their
streams emit authenticated SSE comment keepalives only. Real scoped tunneled apps retain
their subscriber socket and notification behavior; proxied and `pmcp` scoped streams
likewise remain non-ringing.
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

On a real scoped tunneled stream the Worker opens the app's tagged subscriber WebSocket
exactly as specified below. Aggregate and scoped-hub streams deliberately open none.
For a real scoped stream, frames are admission-filtered to the app's three list-changed
families plus exact-URI `resources/updated`. The invocation ends when the consumer
disconnects.

- **Subscriber sockets are a class of their own.** §6's at-most-one-connection invariant
  is about the *app* socket — the one the bot registers on. A DO holds at most one of
  those and any number of subscriber sockets; a subscriber socket never receives consumer
  traffic, never counts as "online", and is never evicted by `hub/replaced` — all three
  properties bought by the `sub:` tag prefix above. **Archive and token revocation touch
  only the app socket**: `app_archive` severs the app connection (close
  `4002`, §6) and a token revoke severs the socket that token opened (`4001`) —
  subscriber sockets carry neither credential and stay open, and the archived case
  reaches streams through the re-auth tick below. App **delete** closes subscriber
  sockets too. **Any subscriber-socket close the
  Worker did not initiate ends the whole SSE stream** — app delete, DO restart, and
  hub deploy (§15's "deploys terminate all WebSockets" covers this class too) alike.
  Fail loud, not deaf: a stream that silently stopped hearing one of its apps is the
  one failure a doorbell design cannot afford, and the client's ordinary reopen rebuilds
  the fan-out against current state.
- **The stream re-authorizes itself on the keepalive cadence.** It resolves the same
  non-secret credential reference §23 uses. Revocation, expiry, account/agent deletion,
  or principal-key change closes the stream. On a real scoped app, lost grant/archive/
  deletion closes it as a fresh request would; changed grants narrow or widen on the next
  tick and newly added grants ring only the supported family intersection. Aggregate/hub
  have no app fan-out to reconcile, so the tick only preserves credential liveness.
- **Fan-out width is capped, and must be measured before it is trusted.** The platform
  caps simultaneous open connections per invocation (documented at six), and the D14
  probe measured **one** held subscriber socket, not many. `LISTEN_FANOUT_MAX`
  (`limits.ts`) bounds how many DOs one stream subscribes — apps taken in
  deterministic slug order, the excess silent until reopen (recorded ceiling, §21.7;
  upgrade path: fan in through one DO). Verifying the real concurrent-hold width is a
  D14 implementation-time probe obligation; the constant's value follows the
  measurement.
- **Proxied apps never ring.** There is no channel to ring from: a Worker cannot
  hold a long-lived outbound stream to the upstream past its own invocation, and proxied
  apps have no DO by design (§20.5 "proxied apps cache nothing"). Their
  capabilities stay `listChanged: false` / no `subscribe` (§21.5) so a correct client
  never expects otherwise. The `pmcp` builtin contributes no bell either — its tools
  never change.

### 21.3 What rings: doorbell, not data

The hub forwards the **fact** of change, never content. On real scoped tunneled streams,
the three list-changed frames carry only `method`, and `resources/updated` carries the
verbatim URI as §21.4 specifies. Aggregate/hub push flags are false and those streams
forward none of these frames. Content always re-enters a current filtered list/read
path; the remaining scoped timing oracle is confined to an app the caller already holds.

**The bell rings when the hub's stored catalog changes, not when the app says
something changed.** The DO already invalidates and re-warms on an app's
`list_changed` (§6); the consumer bell rings at the *write*, when the re-warmed
catalog's **canonical JSON serialization** differs from the stored one's — the DO reads
before it writes, and the comparison is over that serialization because DO storage
round-trips structured clones, not bytes. **Absent and stored `[]` compare equal for
ringing** (they already answer the same empty list, §20.5), so a first registration
writing `[]` into never-warmed family keys rings nothing; the undeclare that rings is
the one that emptied a non-empty catalog. Consequences, each intended: a noisy app
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
cancels no pending ring, and a subscriber accept never arms the deadline. An app flipping
Catalog writes remain rate-limited and coalesced per app DO, preventing a rogue app from
forcing unbounded scoped re-list traffic. Clients debounce their scoped re-list.
Aggregate/hub streams subscribe to no app DO and have no cross-app coalescing question.

**Hub-originated changes ring only through the re-auth tick** (§21.2): a grant added or
revoked, an archive, or a delete changes the stream's subscribed-app set within one
keepalive interval, and the Worker rings the affected family bells itself when the set
changes — it is the party that knows. The residue is pattern-level drift: a role edit
that changes *which entries* a caller sees without changing *which apps* rings
nothing (recorded ceiling — bells originate in app DOs, and the tick compares
membership, not patterns). Proxied apps stay unrung in every case.

### 21.4 `resources/subscribe` and `resources/updated`

Scoped endpoint, tunneled apps only — the one push feature that is per-URI rather
than per-catalog. On a proxied app or the builtin both methods are `-32601`: the
capability is never advertised for them (§21.5) and there is nowhere to forward.

- **Subscribe is filtered like a read.** The URI is matched against the caller's
  resource patterns (§20.3) and refused `-32001` before anything reaches the app —
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
  exact-match check is what makes a rogue frame inert — an app emitting `updated` for
  URIs nobody subscribed rings nobody, and one for a URI *someone* subscribed reaches
  exactly the streams that proved their right to it. Everything else the app
  originates is still dropped.

### 21.5 Capabilities flip in lockstep with the transport

§20's consequence pin was **never declare a capability the transport cannot honor** —
never "declare false forever". It now binds the other direction with equal force: the
declaration and the transport flip **in the same deploy**, because a served-but-undeclared
stream is a client that never opens it (Claude Code registers `list_changed` handlers
only per advertised capability — probe-verified), and a declared-but-unserved one burns
the client's reopen budget (§20.1's original warning).

- **Aggregate and scoped `hub`**: one constant, byte-for-byte fixture:
  `tools` then `resources`, both `listChanged: false`; no subscribe.
- **Scoped, tunneled real app**: `listChanged: true` on each stored family and
  `resources.subscribe: true` when resources are stored. Never-connected and
  unresolvable slugs use tools with `listChanged: true`.
- **Scoped, proxied**: owner-declared families, all push flags false.
- **Scoped, `pmcp`**: tools with `listChanged: false`; no subscribe.
- `server/discover` uses the same producer as `initialize`.


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
app changed, and a revoked grant keeps that signal for at most one keepalive
interval (§21.2/§21.3; upgrade path: ring on the caller-filtered projection).
Pattern-level role drift rings nothing (§21.3) — and, the other half of the same gap,
it revokes nothing: the re-authorization tick compares grant MEMBERSHIP, so drift that
narrows a role's `resources` patterns while leaving the grant standing leaves live
per-URI subscriptions in place, and `updated` keeps arriving for a URI the caller's
current patterns would now deny (grant filtering happened at subscribe time, §21.4).
Bounded by the stream's own lifetime; ended by losing the grant, or by a reopen
(§21.1's "subscriptions die with the stream"). Upgrade path: re-run `resolveAccess` per
subscribed URI on the tick and prune the attachment. Cross-app bursts are not coalesced
(§21.3). `LISTEN_FANOUT_MAX` bounds a stream's subscriber sockets, excess apps
silent until reopen (§21.2; upgrade path: fan in through one DO). A
non-Worker-initiated subscriber-socket close ends the whole stream, so one DO restart
costs an N-app stream a reopen (§21.2 — chosen over deafness). N open streams from
one principal hold N subscriber-socket sets with no fan-in dedupe — at personal scale, N
is small and the sockets are near-free. Each has its upgrade path written beside it;
none blocks conformance, because MCP requires honoring the transport, not clairvoyance.
