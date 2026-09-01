## 16. Testing

- **server**: vitest + `@cloudflare/vitest-pool-workers`. Core integration test: fake
  service connects over WS to the DO, consumer POSTs `tools/list`/`tools/call` through
  both the aggregated and scoped endpoints, asserts role filtering, prefix routing,
  namespace isolation (cross-user 404), offline/archived errors, timeout behavior,
  connection replacement; a proxied service backed by an in-test fake upstream asserts
  forwarding, virtual-role filtering, and upstream-failure mapping (unreachable, HTTP
  401/500, non-JSON-RPC body — all `-32000`, upstream body never echoed) — including
  aggregated `tools/list` with one failing or hanging upstream: the aggregate succeeds
  without that service's tools (slug listed in `_meta.pmcp/unavailable`) while the
  scoped list fails `-32000`.
- **clients/py**: pytest; the WS↔anyio bridge tested against an in-process websocket
  server; reconnect/backoff logic unit-tested with a fake clock.
- **clients/js**: vitest; same shape.
- **cli**: unit tests for YAML diff (pure function: desired + current → plan).
- **pattern matching**: regression tests pinned by §7 — `foo|bar` must NOT match
  `foox` (naive `^foo|bar$` parses as `(^foo)|(bar$)` and matches it via the `^foo`
  branch; correct `^(?:foo|bar)$` rejects it) but must match `foo` and `bar` exactly;
  literal-grammar patterns (`^[A-Za-z0-9._-]+$`) compare literally — pattern
  `get.news` must NOT match tool `getXnews` — while patterns outside the grammar
  still compile (`search_.*` matches `search_news`).
- **approval flow**: call → `-32003` with link → approve → identical retry executes
  once → second identical call opens a fresh pending; N concurrent identical calls
  against one approval dispatch exactly once (the CAS claim; losers get `-32003`);
  retry while still pending returns the same approvalId without a new row; a
  past-expiry pending row reads as expired everywhere and emits `approval.expired`
  exactly once; changed args don't match; reject and expiry paths; an MRTR exchange
  rides one approval — an approved call returning `input_required` restores it, the
  follow-up leg carrying `inputResponses`/`requestState` executes and a `complete`
  result marks it `used`, and `inputResponses` never appear in the stored `args_json`;
  `writeOnly` and config-declared fields masked in the stored `args_json`; audit
  bodies recorded per `log_bodies` (tunneled default on, proxied default off, either
  flips): args and result structuredContent masked in both directions — input-schema
  and output-schema `writeOnly` plus `redact`/`redact_results` paths — unstructured
  blocks stored as stubs, an over-cap body as an `oversize` stub, `writeOnly`
  stripped from served outputSchemas, and `token_issue`'s key masked in its recorded
  result by the uniform rule; identity
  `_meta` present on tunneled calls with the consumer's `clientCapabilities` mirrored
  onto the forwarded request (both kinds, `{}` when absent); a consumer-supplied
  `_meta` key under `hub/` (e.g. a forged `hub/roles`) is stripped before forwarding
  while non-reserved keys like `progressToken` survive; `X-Pmcp-*` headers present
  only with `forward_identity: true` and absent by default.
- **upstream oauth**: fake AS in-test — expired access token triggers refresh before
  forwarding; failed refresh surfaces needs-reconnect and calls fail `-32000`; a
  callback carrying a valid code but a missing, consumed, expired, or other-session
  `state` is rejected and writes nothing.
- **inbound oauth** (§19): the discovery documents are served at the exact probed paths
  and the AS document's `issuer` is byte-identical to the URL it was fetched from; the
  401 challenge on `/<user>/mcp` names the per-user `resource_metadata` and is the same
  bytes for a live and an absent namespace; a JWT for another namespace's audience, an
  unsigned/expired one, and one whose binding is revoked or gone are each refused with
  that same challenge; a valid one resolves to `sa:<slug>` and is thereafter
  indistinguishable from a `pmcp_sa_` key (same grants, same refusals, same audit
  principal, still no `pmcp` grants — including on the scoped shape, which the
  namespace-wide audience of §19.6 keeps reachable); a JWT minted from a live session at
  `/api/auth/token` is refused at the door, because hub-signed is never the acceptance
  test; no OAuth-leg failure of any kind resolves as the owner (the leg is terminal); a
  registration whose `redirect_uri` is not an exact registered string is refused before
  any consent screen renders, and one carrying its own `client_id` gets a different,
  server-assigned one; the consent screen names the client, the redirect origin and the
  unverified-identity marker, and renders its empty state with no service accounts; the
  consent POST without a CSRF token is refused;
  D11's allowlist admits an `Authorization` header under `/api/auth` only at `/sign-out`
  and `/device/*`, so `/api/auth/token` refuses one while the whole OAuth round-trip
  completes without ever sending one. `scripts/smoke.ts` runs that round-trip against the
  deployed worker with no browser (§19).
- **the router walk** (§2's reserved-list equivalence): the walk decides "is this segment
  served?" by probing a path under it and comparing the answer with an unrouted path. For
  every segment so far that probe is `/<seg>`; for `.well-known` it must be the entry's
  own **document path** (`/.well-known/oauth-authorization-server`), because that mount
  serves two exact documents and answers the ordinary anonymous 404 for everything else,
  `/.well-known` itself included (§19.2). The probe path is per-entry **data** in the
  walk's table, not a special case in its logic — every future mount that serves only
  exact paths needs the same thing, and the alternative (a distinguishable segment-404 so
  the walk can tell) would spend the one-404 doctrine to buy a test convenience.
- **data model beyond tools** (§20): per-family door cases on both endpoint shapes
  (aggregated prompts prefixed and split, resources scoped-only, `-32601` where a family
  is not served); a bare role list still means tools and grants nothing in another
  family; a resource pattern matches by the family's literal rule, and matches the
  resource's **`uri`** — a resource whose *name* matches a granted pattern while its URI
  matches none is neither listed nor readable; `completion/complete` refuses a `ref` no
  pattern matches; a role that gains a family under live grants writes
  `connect.roles_widened`; a service that stops declaring a family has that catalog
  cleared while a merely *failed* warm still leaves the previous one; a public
  `cacheScope` from a service is downgraded to private; read rows land in audit with the
  prompt name / query-redacted resource URI and their contents stubbed.
- **push** (§21): the listen stream on both shapes (ungranted → a stream that never
  rings; scoped archived → `-32002`; availability never checked); the bell-at-the-write
  rule (no-op `list_changed` rings nothing; undeclare of a non-empty family rings;
  absent ≡ `[]`; either resource catalog rings the one resources bell, once per warm;
  the floor coalesces to a final ring); the Worker-side shape filter (no resources bell
  on an aggregated stream); subscribe/unsubscribe (grant-filtered by URI,
  principal-equality match, caps → `-32602`, exact-match `updated` routing — a rogue
  frame for an unsubscribed URI rings nobody); the re-auth tick (revoked token closes
  the stream, revoked grant drops the socket and its subscriptions); capability flags
  flip with the transport, fixture in the same commit; a `sub:`-tagged socket never
  answers a `getWebSockets(service.id)` lookup. The held-stream economics and the real
  fan-out width are out-of-process obligations (strategy §10).
- One `scripts/e2e.md` runbook (manual): deploy to a dev worker, run the example service,
  `pmcp call` round-trip.

