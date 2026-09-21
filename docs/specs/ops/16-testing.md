## 16. Testing

- **server**: vitest + `@cloudflare/vitest-plugin`. Core scoped tunnel/proxy tests retain
  role filtering, identity metadata, check ordering, approval, failures, audit, push, and
  hibernation. New hub rows assert aggregate/scoped-hub expose only two tools and type
  resources, while every real scoped application method remains unchanged.
- **clients/py**: pytest; the WS↔anyio bridge tested against an in-process websocket
  server; reconnect/backoff logic unit-tested with a fake clock.
- **clients/js**: vitest; same shape.
- **cli**: command parsing, profile precedence, output/error contracts, and admin/MCP dispatch.
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
- **the audit explorer** (§13, decision 36) — **written before the implementation it pins**.
  Worker rows: `audit_query`'s additions, each on its own (`id`, owner-scoped, so
  another namespace's id is absent and not a row; `text`, over every string column and both
  body columns, with the `LIKE` escaping proved by a needle of `%` matching only a literal
  `%`; `bodies: false`, whose rows carry `argsHead` and `hasResult` and **never** `args` or
  `result`; `outcome` as a sixth exact filter **on the op**, taking a raw recorded value; and
  the module read's list form of those six, an empty list being no filter); the
  two new `/api/hub` reads (401 without a session, the `404` for an id outside the namespace,
  an `offset` past `AUDIT_EXPLORER_ROWS` answering an empty page, an offset **not** aligned to
  `AUDIT_EXPLORER_PAGE` never reading past the ceiling either, the echoed window); the
  export's repeated keys, `outcome=` among them in raw codes, plus the three rules review
  added — two `target=` pairs export **neither** cross-product row, a malformed `target` is a
  `400` rather than an ignored filter, and a selection past `AUDIT_EXPORT_MAX_VALUES` is a
  `400` **before any read**, beside its allow-twin one value under the bound; the window rule
  (a `range` or a `since`/`until` pair narrows; no window at all exports the whole ledger, not
  a 24-hour default); `detail.approvalId` on **both**
  call rows — the one refused `-32003` and the one dispatched after a claim, the latter
  merged with a `failureClass` when the dispatch then failed; and the SPA shell on
  `GET /audit` behind the session gate, `no-store`. Pure rows:
  `server/test/unit/audit-derive.test.ts` over the page's one pure module — outcome classes
  with their **labels and sentences verbatim**, the `Cause: <failureClass>.` suffix on a
  `-32000` that carries one, an outcome the table does not know falling back to its raw
  value with no sentence, and **what the record's outcome row prints for a given outcome** —
  no word twice, so `ok` is the chip alone, `error` the chip over its sentence, a refusal
  chip · label · code;
  titles (`<app>/<tool>` for the three call events alone, the event name for everything else,
  so an `approval.*` row naming an app and a tool never reads as a call, **and the chain-row
  exception** — a chain titled by its call while the record it opens keeps the head row's
  title), facet counts
  excluding their own group, the chain merge and its **(ts, id)** order (`approval.requested`
  heads the chain although the refused call may share its millisecond), ×N runs and that a
  chain never joins one, the waterfall fold threshold, the three insight rules — including
  that the first-seen one is **absent** on a partial load (over the ceiling, or a search text
  active) and that the changes one's "show me" carries **every** distinct change event it
  counted — the export href (class → raw codes, the tool pair as `target=`, repeated keys,
  `q` → `text`), the JSON tree's open paths for a tree and a query (the first two levels, plus
  every ancestor of a match) and its match finding, and the
  lanes' worst-outcome and not-loaded cells. The
  two `/audit` `describe`s in `server/test/worker/web-pages.test.ts` go with the page they
  pinned; what they pinned that still holds — the three no-bodies sentences and the stub
  size spellings — moves to that unit file rather than being dropped. The preview gallery
  gains an `audit` fixture set, one seed per page state §13 names plus the views, a session
  opened, the record in each of its no-bodies and stub shapes, a chain record, a
  `recordSearch` seed (a query with its ancestors opened, and one with no match), and one
  long-data seed; the visual gate is the gallery beside the boards at both widths.
- **upstream oauth**: fake AS in-test — expired access token triggers refresh before
  forwarding; failed refresh surfaces needs-reconnect and calls fail `-32000`; a
  callback carrying a valid code but a missing, consumed, expired, or other-session
  `state` is rejected and writes nothing.
- **inbound oauth** (§19): the discovery documents are served at the exact probed paths
  and the AS document's `issuer` is byte-identical to the URL it was fetched from; the
  401 challenge on `/<user>/mcp` names the per-user `resource_metadata` and is the same
  bytes for a live and an absent namespace; a JWT for another namespace's audience, an
  unsigned/expired one, and one whose binding is revoked or gone are each refused with
  that same challenge; a valid one resolves to `agent:<slug>` and is thereafter
  indistinguishable from a `pmcp_agt_` key (same grants, same refusals, same audit
  principal, still no `pmcp` grants — including on the scoped shape, which the
  namespace-wide audience of §19.6 keeps reachable); a JWT minted from a live session at
  `/api/auth/token` is refused at the door, because hub-signed is never the acceptance
  test; no OAuth-leg failure of any kind resolves as the owner (the leg is terminal); a
  registration whose `redirect_uri` is not an exact registered string is refused before
  any consent screen renders, and one carrying its own `client_id` gets a different,
  server-assigned one; the consent screen names the client, the redirect origin and the
  unverified-identity marker, and renders its empty state with no agents; the
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
- **data model beyond tools** (§20/§23): application prompts/resources/completions remain
  scoped, raw resource URIs route by explicit service, and the program snapshot cannot
  create a generic dispatch escape. Pure tests compile hostile/recursive declarations,
  exercise stable alias reservations/collisions/tombstones/concurrency, and prove
  unsupported/external schemas become `unknown`. Worker rows cover exact credential
  authority, reauthorization, settings, limits, declaration reads, and shared
  dispatch/audit ordering.
- **push** (§21): the listen stream on both shapes (ungranted → a stream that never
  rings; scoped archived → `-32002`; availability never checked); the bell-at-the-write
  rule (no-op `list_changed` rings nothing; undeclare of a non-empty family rings;
  absent ≡ `[]`; either resource catalog rings the one resources bell, once per warm;
  the floor coalesces to a final ring); scoped shape filtering; subscribe/unsubscribe;
  reauthorization; and tagged-socket separation. Aggregate/hub listen tests assert
  keepalives with zero app fan-out and false push flags. Held-stream economics and real
  fan-out remain out-of-process obligations.
- One `scripts/e2e.md` runbook (manual): deploy to a dev worker, run the example app,
  `pmcp call` round-trip.
- **QuickJS deployed proof** (§23): workerd executes the real pinned Wasm artifact and
  proves fresh contexts, asynchronous host-promise resumption, dynamic-compiler removal,
  interruption, output/result contracts, and shared dispatch. Post-deploy smoke must also
  complete aggregate and scoped execution through the production Worker.

