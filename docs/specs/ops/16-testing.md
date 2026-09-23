## 16. Testing

- **server**: vitest + `@cloudflare/vitest-plugin`. Core scoped tunnel/proxy tests retain
  role filtering, identity metadata, check ordering, approval, failures, audit, push, and
  hibernation. New hub rows assert aggregate/scoped-hub expose only two tools and type
  resources, while every real scoped application method remains unchanged.
- **clients/py**: pytest; the WS↔anyio bridge tested against an in-process websocket
  server; reconnect/backoff logic unit-tested with a fake clock.
- **clients/js**: vitest; same shape.
- **clients/go**: `go test`; official SDK dispatch, tunnel contracts, reconnect policy, and
  caller/schema helpers run against an in-process WebSocket hub.
- **clients/rust**: `cargo test`; official RMCP discovery and legacy resource subscriptions,
  tunnel contracts, reconnect policy, and caller/schema helpers run against an in-process
  WebSocket hub.
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
  merged with a `failureClass` when the dispatch then failed; **`detail.reason` on a
  `-32001`** *(decision 37)* — for each reason reachable through a consumer door, the refusal
  leaves exactly **one** row carrying that reason and **no bodies**, beside the row that
  matters more: the JSON-RPC error objects of `no_app`, `no_grant`, `not_in_catalog` and
  `unsound_schema` are **deep-equal to one another** and carry no reason anywhere, which is
  the wire half of §7's rule asserted as an equality rather than as four separate shapes, with
  `not_decidable` pinned to its own message as §7's named exception; the same refusal recording
  its reason on the **read** paths too, now that all four audited ones carry
  `HubError.auditDetail` into their row (§15), a `-32000` there recording its `failureClass`
  where it recorded nothing before; `server/test/unit/errors.test.ts` pinning the vocabulary
  purely — `auditDetail` is `{ reason }` for all nine, one wire answer for every one of them,
  the cause in nothing a consumer could serialize, the factory's argument required; and
  the SPA shell on
  `GET /audit` behind the session gate, `no-store`. Pure rows:
  `server/test/unit/audit-derive.test.ts` over the page's one pure module — outcome classes
  with their **labels and sentences verbatim** — the nine `-32001` reason sentences among
  them, plus the no-reason fallback and the unknown-token one *(decision 37)* — the
  `Cause: <failureClass>.` suffix on a
  `-32000` that carries one, an outcome the table does not know falling back to its raw
  value with no sentence, the **cause in words** on a refusal's preview line (a `-32001`'s
  short words; a `-32000`'s humanized `failureClass`, and `upstream_status` with a numeric
  `detail.upstreamStatus` reading "upstream status 502" with no second `upstreamStatus=` pair,
  a non-numeric one falling back to the words plus the pair), the run
  signature splitting on the **recorded cause**, Refusals grouped by cause, and **what the
  record's outcome row prints for a given outcome** —
  no word twice, so `ok` is the chip alone, `error` the chip over its sentence, a refusal
  chip · label · code;
  titles (`<app>/<tool>` for the three call events alone, the event name for everything else,
  so an `approval.*` row naming an app and a tool never reads as a call, **and the chain-row
  exception** — a chain titled by its call while the record it opens keeps the head row's
  title), facet counts
  excluding their own group, the chain merge and its **(ts, id)** order (`approval.requested`
  heads the chain although the refused call may share its millisecond), a chain's **when**
  being its newest event's `ts` while its head still titles it — and, over the fixture week,
  the merged list's `when` never increasing — ×N runs **keyed on
  seven fields incl. `argsHead`** (so five calls with five different queries stay five rows)
  and that a chain never joins one, the waterfall fold threshold, the three insight rules — including
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
  `recordSearch` seed (a query with its ancestors opened, and one with no match),
  `eventsRunOpen` (a run expanded on its members), `searchLive` — a read that **answers
  late** rather than a seeded cache, because a seed that is permanently fresh cannot express a
  refetch and that is exactly the gap the 2026-09-21 postmortem names — and one
  long-data seed; the visual gate is the gallery beside the boards at both widths. One
  **dev-only browser walk** joins `visual-compare.mts` and `drawer-check.mts`,
  `web/scripts/audit-search-check.mts`: it types with pauses longer than the debounce and
  asserts that the input is the **same node**, still focused, its value intact, and that no
  skeleton was ever attached — the one thing no fixture and no pure test can see, since the
  actor is the network.
- **every page is the SPA** *(2026-09-23, decision 38; per page family, rows before code)*.
  **Rows move; they are not deleted.** A `web-pages.test.ts` row that pins a server check —
  a gate, a CSRF or origin barrier, the relative-only landing, the consent binding, the device
  claim, an audit row, a notice's landing pane — is **ported** onto the route that replaces
  the handler it pinned (the per-row map is
  `docs/superpowers/plans/2026-09-23-everything-spa-routes.md`); a row that pins only what a
  page draws moves to the web side — a pure view rule (the confirm dialog's owning pane, the
  token filter, the password-field mapping, the password notice copy, the execution
  sentences' placement) as a `server/test/unit/` row over a `web/src/…/derive.ts` module in
  `audit-derive.test.ts`'s manner, and the drawing itself as a gallery state. Worker rows for
  what is new: each shell's gate **before** the document and its document-level answer (the
  `404` for a foreign approval, the consent screen's `400`, none on `/login`), the three
  headers at all six URLs, `/login`'s `#pmcp-login` island with **no** `#pmcp-bootstrap`, and a
  hostile `?next=` whose bytes appear nowhere raw in the document; the recent-authentication
  prefix over `/api/hub/settings/*` — a stale and a bearer-sourced session are the same `401`
  at every read and write, beside a fresh twin; every `{ next, reload }` answer's `next`
  equal to the `Location` the form's 303 named, and `reload` true exactly when the answer
  carried `Set-Cookie`; the consent read's `oauthQuery` byte-equal to the query it was asked
  with, an edited query `400` at the document and at the read, and its key set exactly what
  the screen shows; the device read claiming the code for the reader and answering the
  confirm card's five facts and nothing else, the decision refused without `X-Pmcp-Csrf`
  with the code left pending; and the push subscription route, which had no route-level row
  at all. Two walks retire and one replaces them: the CSRF-field walk over server HTML
  (case 4) and the credential-form walk (case 24) have no server forms left to walk, and in
  their place a walk over the form targets the **bundle** renders asserts each is one of the
  kept form routes (`/login`'s four, the consent POST, `/apps/connect`) and answers a
  form-encoded post with neither `415` nor `404` — the walk that would have caught a Sign out
  posted straight at better-auth. Rows 16 and 17 (the approvals forms' parity) retire into 18
  and 18b, the op allowlist and its schema check, which already cover `approval_decide`.
  **The gallery replaces the server preview**: every `server/dev/fixtures.ts` fixture becomes
  a React gallery state under the **same** page and state names
  (`/__preview/<page>/<state>` ↔ `/preview/<page>/<fixture>`), and the preview, its fixtures
  and `wrangler.preview.jsonc` retire with the last page. **The gate is the baselines**:
  `web/scripts/server-baselines.mts` — a dev-only, hand-run browser walk like
  `visual-compare.mts` — shot every page × fixture of the server preview at 1280×900 and
  390×844 into `design/baseline/<page>__<fixture>__<w>x<h>.png` **once, before any page
  moved**, sharing `shots.mts`' context and viewports so a baseline and its candidate are
  captured alike, exiting non-zero on a page that fails to load, renders no text, or yields a
  PNG not exactly the viewport's width, and stopping the dev server it started. A baseline
  shot after a page moved would prove nothing, so it is committed, not re-shot per change;
  `visual:compare` diffs each migrated family's gallery against it, a right difference named
  in `web/visual-accepted.json` with its reason, and pass 2 reuses the same files *(2026-09-23,
  pass 1's close: the script is deleted with the preview it shot from — neither can run again
  — and its committed PNGs are pass 2's reference; the pairs pass 1 accepted are re-shot from
  the SPA, next bullet)*. The smoke's
  three HTML scrapes move with their pages: `/settings`' rail and control strings become the
  statuses plus `GET /api/hub/settings`, the bearer-only change-password post expects `401`
  at its JSON route, `/login`'s `callbackURL` is read from `#pmcp-login`, and the consent
  walk takes `csrf` from `#pmcp-bootstrap` and `oauth_query` from the consent read.
- **pass 2's gate** *(2026-09-23, decision 38's pass-2 amendment)* — every phase ends with
  `visual:compare` exiting 0 carrying only that phase's expected entries, every phone PNG
  exactly the viewport's width, `check:drawer` and `check:audit-search` exiting 0, and the
  owners' test files by exit code. Three things change from pass 1. **The accepted pairs are
  re-shot**: the pairs pass 1 accepted are shot again from the SPA gallery at pass 1's closing
  commit, replacing their server PNGs in `design/baseline/`, and `web/visual-accepted.json`
  starts pass 2 empty — an accepted pair passes at any ratio, so an accepted pair is an
  ungated one, and pass 2's list may hold only pass 2's own differences. **A component gate
  joins the page gate**: the gallery gains a non-route `primitives` page, one state per
  component, each drawing the legacy classes beside the component replacing them in every
  variant × size × state (rest, focus, invalid, disabled, checked, and narrow at 390), and
  `visual-compare.mts` gains a **crop-compare mode** that compares each state's new column
  against its old column at **budget 0** — the per-pair budget of
  a full-page shot absorbs exactly the radius or placeholder colour a component gets wrong,
  and a component no page uses yet has no page pair at all. A component is used on a page
  only after its crop compares clean or its difference is named. **`drawer-check.mts` checks
  behaviour only** — the press opens the drawer where the sheet puts it, Escape, a tap beside
  it and its close button each close it and hand focus back to the hamburger, an entry
  navigates and closes it, the scroll lock is released — against the SPA gallery; its pixel
  comparison went with the server preview it compared against, and the drawer's look is
  `visual-compare`'s. And one worker row moves: the `web-pages.test.ts` row proving the shell's
  static assets stay cacheable while its pages are `no-store` takes `/app.css` as its asset
  once `/styles.css` is no longer served — ported, not deleted.
- **fresh authentication at better-auth's mount** *(2026-09-23, decision 39)* — one worker
  file, `server/test/worker/fresh-auth.test.ts`, whose **table of guarded endpoints is the
  endpoint list** decision 39 names by category. Per row: a cookie session aged past
  `freshAge`, posting straight at `/api/auth/<endpoint>` with the hub's `Origin` and no
  `Authorization` (so the bearer allowlist is not what refuses it), is answered `403
  SESSION_NOT_FRESH` **and changes nothing** — the old password still signs in, the factor's
  state, the passkey row and every session are as they were — beside its twin, the same body
  from a session signed in moments ago, which succeeds. Beside the table, the flows the
  decision leaves unguarded, each walked with a stale session present and completing as
  before: sign-in by password and by passkey, the second-factor verify that completes a
  sign-in, sign-out, the device flow's code, claim, approve and token legs, and the OAuth
  provider's authorize, consent and token legs; and the hub's own `/api/hub/settings/*`
  writes, which a fresh session still completes through both checks. The `web-pages.test.ts`
  row that pinned the gap ("better-auth's own /change-password mount enforces no freshness")
  flips: its direct leg is now the refusal, and it moves here. *(2026-09-23, decision 40 —
  the same file, a separate `describe`, because the rule is an invariant and not a
  freshness condition:)* `POST /api/auth/update-user` from a session signed in **moments
  ago** — the session decision 39 would admit — carrying a new `username` is answered `404
  Not Found`, byte-identical to an endpoint better-auth lists in `disabledPaths`, and the
  username is unchanged afterwards: the owner still signs in under it, `/api/whoami` still
  answers `user:<username>`, and `/<username>/mcp` still resolves; the same post carrying
  only `name`, and only `image`, is refused the same way, so no field is a way in; a stale
  session is refused identically, so the answer says nothing about freshness. The second
  barrier is pinned on its own, since the first hides it from any HTTP caller: better-auth's
  `updateUser` called in-process, past the mount, with a username that differs from the
  session's is refused `USERNAME_IS_IMMUTABLE`, beside its twin carrying the session's own
  username, which is not.
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

