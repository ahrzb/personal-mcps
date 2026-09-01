## 19. Inbound OAuth — the hub as an authorization server

*Added 2026-08-26. Reverses §14's deferral and §18 decision 13; §18 decisions 23–25
carry the owner-level calls. Implemented as its own workflow, ahead of §20.*

The gap this closes: a spec-conformant remote MCP client — claude.ai's custom
connectors first — cannot be handed a `pmcp_agt_` key through a header field. It expects
to discover an authorization server from the MCP endpoint, run authorization-code +
PKCE in the owner's browser, and present the resulting access token. Today
`/<user>/mcp` answers 401 with a bare `WWW-Authenticate: Bearer`, nothing serves
`/.well-known/*`, and the client's legacy fallback walks to a path-stripped
`/authorize` that does not exist. Everything below exists to make that walk end at a
consent screen instead of a 404.

**What it is not**: a second way to be the owner. §18 decision 23 is the whole security
story — an OAuth connection binds to an **agent**, and from the moment the
token reaches the door it is indistinguishable from that agent's `pmcp_agt_` key:
same grants, same approval gates, same `agent:<slug>` audit principal, and the same
inability to hold a `pmcp` grant (§8), so no connected client can ever reach an admin
tool. The access model of §2 is untouched. What is new is a credential shape.

### 19.1 Vehicle

`oauthProvider()` from **`@better-auth/oauth-provider`** (1.7.1, in lockstep with
core), plus better-auth's `jwt()` plugin, which the provider requires and throws
`jwt_config` without. Two findings shaped this and are recorded because they contradict
what §14 assumed:

- `oidcProvider` and `mcp` no longer exist inside `better-auth` 1.7.1 — they were
  extracted into separate packages. `@better-auth/mcp` is not a companion plugin: it
  **is** `oauthProvider()` with MCP presets and explicitly cannot be combined with it.
- `mcp()`'s presets take exactly **one** `resource` string and serve RFC 9728 metadata
  for that identifier alone. This hub is multi-tenant — the resource identifier is
  `https://<origin>/<user>/mcp`, one per namespace — so the presets do not fit. The hub
  takes `oauthProvider()` and serves its own protected-resource documents, which is
  five lines of JSON interpolated from a path parameter.

**The verify side, settled by the D12 probe (2026-08-26).** This paragraph was wrong
twice before it was run. The first draft named `verifyAccessTokenRequest` /
`verifyJwsAccessToken` from `better-auth/oauth2` and cached JWKS in-process with no
hot-path D1 read; a revision then declared those symbols nonexistent and reduced the door
to a `verifyJWT`-vs-`jose` choice marked "blocking probe observation." The probe ran each
call against the installed 1.7.1 tree under workerd — and the *first* draft had the symbol
right. What the tree actually exports, verified by running it:

- `better-auth/oauth2` **does** re-export the resource-server verifiers —
  `verifyJwsAccessToken`, `verifyBearerToken`, `verifyAccessTokenRequest`,
  `requestToResourceInput` — via `export * from "@better-auth/core/oauth2"` (source in
  `@better-auth/core/oauth2/verify.ts`), alongside the outbound social-provider helpers.
  The door's primitive is **`verifyJwsAccessToken(token, { jwksFetch, verifyOptions: {
  issuer, audience } })`**. Called with a **function** `jwksFetch` source it verifies
  signature, `iss`, `aud` and `exp` with **pure `jose` local verification and zero D1 or
  adapter reads** — the module-level 5-minute cache exists only for *string URL* sources,
  which this path does not use. The probe minted a hub-signed JWT via `/api/auth/token`,
  verified it, and confirmed a wrong `aud` is rejected (`JWTClaimValidationFailed`). **No
  direct `jose` dependency is added** — `verifyJwsAccessToken` already ships through
  better-auth. `verifyBearerToken` / `verifyAccessTokenRequest` are *not* the door's
  primitive: they accept only a *string* `jwksUrl` (a self-`fetch`) or introspection; only
  the lower-level `verifyJwsAccessToken` takes a function source, so it is the one the door
  uses.
- `verifyJWT` from `better-auth/plugins/jwt` is confirmed **unusable from a Hono handler**:
  called outside a better-auth endpoint context it throws `No auth context found` (it reads
  its auth context out of AsyncLocalStorage and resolves the key through the adapter).
  That was the one fact the probe was to decide, and it decides *against* `verifyJWT` for
  the door, which runs in the composition root and not inside a provider endpoint.

So the door verifies with `verifyJwsAccessToken` and a function `jwksFetch` source, checks
the `mcp` scope itself, and then reads `oauth_binding` (§19.6 step 4) — **one** D1 read per
call, the same one a `pmcp_agt_` key already pays, with verification adding none. The
earlier "a path that adds one D1 read is a bounded regression" hedge is void: there is no
extra read on the verify side, and §19.6's revocation argument holds with the binding row
as the sole per-request cost.

### 19.2 Routes and documents

One new top-level segment, `.well-known` (§2; the dot keeps it outside the username
charset, and it joins `ROUTES` so the §16 router walk stays total and the reservation
cannot drift). The segment claims its subtree like every other mount:

| Path | Method | What it answers |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 AS metadata, from the provider's own `oauthProviderAuthServerMetadata(auth)` helper — which exists precisely because a `basePath` (`/api/auth`) otherwise keeps this document off the root. |
| `/.well-known/oauth-protected-resource/:user/mcp` | GET | RFC 9728 protected-resource metadata for that namespace, built by the hub. |
| `/api/auth/oauth2/*` | (plugin) | `authorize`, `token`, `register`, `revoke`, `introspect`, `consent`, `continue`, `public-client(-prelogin)` and the client-management endpoints — all under the **existing** `api` segment, mounted by the plugin, no route work. |
| `/api/auth/jwks` | (plugin) | The JWKS the door verifies against (§19.1). Public by construction — it is public keys. |
| `/api/auth/token` | (plugin) | **Named here because it is easy to miss, and this table would otherwise read as complete.** `jwt()` mounts it as a side effect, and it converts a live *cookie session* into a hub-signed JWT. It is no part of §19's flow and nothing here ever calls it. Two independent things keep it harmless: §19.7's allowlist means no bearer can reach it, and §19.6 step 3 means the door refuses any hub-signed JWT that is not an access token for the addressed namespace — so even a cookie-holding browser that mints one gains nothing at `/<user>/mcp`. |
| `/oauth/consent` | GET, POST | §19.5's screen, under the **existing** `oauth` segment. |
| `/oauth/connections` | GET, POST | The connections list and its Revoke, same segment. |

Pinned properties of the two documents:

- **Issuer is the origin root.** `jwt`'s `issuer` is set to `PUBLIC_ORIGIN`, so a client
  that reads `authorization_servers: ["https://<origin>"]` probes exactly
  `/.well-known/oauth-authorization-server` and the document's own `issuer` is
  byte-identical to the URL it built — a client MUST NOT use metadata where it is not.
  Endpoints inside the document keep pointing at `${baseURL}/oauth2/*`
  (`/api/auth/oauth2/…`); an issuer and its endpoints need not share a path.
- **The PRM is per-namespace and derived from the path**, never from a lookup:
  `{ resource: "<origin>/<user>/mcp", authorization_servers: ["<origin>"],
  bearer_methods_supported: ["header"], scopes_supported: ["mcp"] }`. A username that
  does not exist gets a well-formed document, for the same anti-enumeration reason §7
  step 1 gives the 401 the same bytes either way. `authorization_servers` has exactly
  one entry — Claude reads entry [0] and never falls back to a later one.
- **The root PRM (`/.well-known/oauth-protected-resource`, no path) is deliberately not
  served** — 404. It could only name one namespace, and serving both forms raises a
  precedence question (which wins, and whether a non-matching `resource` is rejected or
  silently used) that not serving it removes.
- **Every unrouted path under `/.well-known` answers the hub's ONE anonymous 404**, the
  same bytes as any other unrouted path anywhere on the origin — `/.well-known` itself
  included. The mount serves exactly the two documents above and claims nothing else, and
  the one-404 doctrine is not weakened to make discovery legible: a client learns which
  documents exist by fetching them, and learns nothing from a miss. The alternative
  considered and rejected was a distinguishable "segment 404" so §16's router walk could
  tell served-from-reserved by probing `/<seg>`; that spends a security property on a test
  convenience. The walk changes instead — it probes this entry's own **document path** —
  and §16 pins that.
- **CORS.** `GET` on **the two served well-known documents** answers with
  `Access-Control-Allow-Origin: *`: they are public metadata, carry no credential and no
  per-caller content, and a browser-side client fetching them cross-origin is a supported
  way to discover the hub. The header lives on the documents, never on the mount — an
  unrouted path under `/.well-known` answers the ONE anonymous 404 with no CORS header,
  byte-identical to any other unrouted path, which the bullet above depends on.
  `/api/auth/oauth2/token` keeps the provider's own posture and gains no CORS headers —
  its callers are server-side, and adding them would only invite a browser to attempt a
  code exchange from script.
- The 401 challenge on `/<user>/mcp` is the other half of discovery, and the half that
  matters most: `WWW-Authenticate: Bearer error="invalid_token",
  resource_metadata="<origin>/.well-known/oauth-protected-resource/<user>/mcp",
  scope="mcp"`. It must ride a **401** — a `WWW-Authenticate` on a 200, or a JSON-RPC
  error payload, produces no auth prompt in Claude at all. The `<user>` in that URL is
  interpolated from the request **path**, and the reason no unvalidated text can reach a
  response *header* is an **ordering** property rather than an escaping one: the
  composition root rejects any first segment outside the username charset — or on the
  reserved list — with the anonymous 404 *before* the door runs, so by the time the
  challenge is built the segment is already known to be `[a-z0-9-]`. That ordering is what
  the byte-identical-challenge rule rests on; reordering the two is how this becomes a
  header-injection surface. `/api/whoami` keeps the bare `Bearer` challenge: it is not an
  MCP resource and has no metadata to name.

### 19.3 Provider options, pinned

- `scopes: ["mcp", "offline_access"]`. One functional scope, so the challenge's `scope`,
  the PRM's `scopes_supported`, and what the consent screen displays are trivially the
  same string. **No `openid`** — a connection is not a login, which also means no
  id_tokens and no `/.well-known/openid-configuration` to serve.
- `offline_access` is what mints refresh tokens; without it a connector dies at every
  access-token expiry. Rotation is the provider's default and stays on (both Claude
  surfaces register as public clients, where OAuth 2.1 requires it).
- PKCE S256 is required for every client — the provider's default, and Claude's
  unconditional behavior. Only `response_type=code`, only `response_mode=query`.
- `authorization_response_iss_parameter_supported: true`, and the `iss` parameter on
  every redirect: Claude Code's v2 runtime fails a sign-in whose authorization response
  names an unexpected issuer.
- **Dynamic client registration is on** (`allowDynamicClientRegistration` and
  `allowUnauthenticatedClientRegistration`), because it is the only mechanism both
  hosted Claude and Claude Code take with nothing typed by the owner. The accepted cost,
  stated plainly: anyone who can reach the origin can create a row in `oauthClient`
  (rate-limited by the provider at 5/60 s and by §15's WAF rule). A registered client
  authorizes **nothing** — it cannot obtain a token without the owner signing in and
  consenting in their own browser — so the exposure is table growth, not access. The
  daily cron (§15) deletes clients older than the retention window that hold no consent
  and no binding. Two properties below (`client_id` assignment and redirect matching) are
  what make "authorizes nothing" true; without them, open registration is open
  impersonation.
- **Client identity is assigned by the authorization server.** A `client_id` present in a
  registration body is **ignored**, and a fresh server-assigned id is minted; a
  registration can never name an id that already exists, and never inherits one. This is
  load-bearing, not hygiene: §19.4's `UNIQUE (owner_id, client_id)` and §19.6 step 4
  resolve authority from `(owner, client_id)` alone, so a client able to choose its own id
  would step straight into an already-consented binding — full impersonation of a
  consented client, through an unauthenticated endpoint, with no consent screen anywhere
  in the path. Verified as a **blocking probe observation**, not assumed: a registration
  body carrying `client_id` must come back with a different one.
- **Redirect URIs are matched as exact strings** against the set registered for that
  client: no wildcard, no prefix or suffix match, no path-relative match, no
  port-agnostic or scheme-agnostic comparison for `https` URIs, and no normalization
  beyond what registration itself stored. Pinned here rather than left to the provider
  because §19.5 step 4 ends with **the hub** redirecting the owner's browser to the URI
  the provider hands back: an unauthenticated registration endpoint plus a redirect target
  nobody validated is an open redirector carrying an authorization code, which is the
  classic way an authorization server gives its codes away. So: the hub never redirects a
  browser to a URI the provider did not validate, a mismatch is refused **before the
  consent screen renders** (there is nothing to consent to yet), and the provider's
  enforcement of exact matching is the third **blocking probe observation** — if it
  matches loosely for any shape, the hub validates before redirecting rather than
  shipping on trust. RFC 8252 loopback redirects, where port-agnostic matching is the
  *correct* behavior, are out of scope with Claude Code itself (§19.9); nothing in v1
  registers one, so no exception to exact matching exists.
- `enforcePerClientResources: false`. The alternative links each client to each
  namespace's resource at registration time — before the owner has consented, and
  through a table that would hold a second, weaker copy of the rule the door already
  enforces (`aud` must equal this endpoint's canonical URL, and the binding names the
  namespace). One rule, enforced where the traffic is.
- One `oauthResource` row per user, identifier `https://<origin>/<user>/mcp` — the same
  string the PRM names as `resource` and the door checks as `aud`, so the row, the
  document and the audience are one value with one spelling. Written by the same
  `/internal/users` path that creates the user (§12), removed by the same path that
  deletes one alongside §15's teardown, and **back-filled for pre-existing users by
  `0005` itself** — in the migration, not by a lazy first-request write. Both directions
  are pinned because their failure modes are silent and asymmetric: a missing row at
  provisioning means a *brand-new* user can never complete an authorization, and a
  missing back-fill means the *existing* owner — the one person this whole section was
  built for — cannot. Whether the provider strictly needs the row when
  `enforcePerClientResources` is false is the plan's open question 1; the row is written
  either way, because an unnecessary row costs one INSERT and a missing necessary one
  costs the entire flow.

### 19.4 Data model

Migration `0005_oauth.sql`, generated the way §4 already requires — `@better-auth/cli
generate` against a local SQLite dialect with the identical plugin list, emitted SQL
checked in unchanged. The 0001 postmortem (three hand-transcription deltas found at
runtime) is the argument: better-auth is a dependency now, so nothing here is
transcribed by hand. The generated half brings the provider's seven tables —
`oauthClient`, `oauthResource`, `oauthClientResource`, `oauthAccessToken`,
`oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion` — plus `jwks` from the jwt
plugin. Authorization codes and DPoP replay reservations reuse better-auth's existing
`verification` table; nothing else is added to what §5 already has.

The hub's own table is written by hand in the same migration, in this repo's snake_case
convention, and is the only one pinned in `migrations.test.ts`'s `SCHEMA_TABLES` (as
with `user` and `session`, better-auth's camelCase tables stay outside it):

```sql
CREATE TABLE oauth_binding (            -- §19: one OAuth client ↔ one agent
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,             -- oauthClient.clientId; no FK (better-auth owns
                                       -- that table, and §5 already takes this posture
                                       -- for token.ref_id)
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
                                       -- deleting the agent revokes the connection by
                                       -- construction: the door reads this row per call
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                -- coarse, same TOKEN_LAST_USED_STAMP_MS window as
                                       -- token.last_used_at (§5) — the same staleness
                                       -- signal, for the same reason
  revoked_at INTEGER,
  UNIQUE (owner_id, client_id)         -- one binding per client per namespace; re-consent
                                       -- with a different agent UPDATEs it (audit row
                                       -- `oauth.rebound`) instead of accumulating rows
);
```

### 19.5 The consent screen

The provider owns the state machine and ships no pages; the hub owns every pixel.
`loginPage: "/login"` and `consentPage: "/oauth/consent"` are required options.

1. `/api/auth/oauth2/authorize` with no session → 302 to `/login?<signed query>`. §13's
   login page carries that query through and, on success, redirects back to `authorize`
   with it verbatim — the provider then re-runs the request, now with a session. **The
   post-login target is a constant**: the hub's own `/api/auth/oauth2/authorize`, built in
   code, with the signed query appended as the only thing taken from the request. The
   login page never reads a destination out of the query — no `next=`, no `return_to=`, no
   "carry through whatever URL was there". "Carries the query through" means exactly the
   opaque signed blob and nothing else. This is spelled out because the sentence invites
   the other reading, and a login page that immediately precedes an authorization grant is
   the highest-value phishing target the hub has: a generic post-login redirect parameter
   there is how it gets lost.
2. With a session and no covering consent → 302 to `/oauth/consent?<signed query>`. The
   query is the whole authorization request re-serialized plus `exp`, an issued-at, and
   an HMAC `sig` over the canonicalized parameters. **The page must echo it back
   byte-for-byte**; it cannot invent, drop or edit a parameter, which is exactly the
   property that keeps the screen from being a place where authority is widened. That
   signature is an asserted behavior of a package this repo has not installed yet, and the
   entire unforgeability argument rests on it, so it joins §19.1's verify API and §19.3's
   two client rules as a **blocking probe observation**: watch `authorize` actually sign
   the query, `public-client-prelogin` actually accept it, and `/oauth2/consent` actually
   take `{accept, oauth_query}` — before a line of the consent page is written against
   them.
3. The page (cookie session required, `requireOwnerSession`) is the whole security
   boundary of §19 (§18 decision 24), and every string it shows about the client came out
   of a body anyone could POST to an unauthenticated registration endpoint. It therefore
   shows, always:
   - the client's **name**, read from the provider's `public-client-prelogin` endpoint
     (which accepts the same signed query) — rendered as untrusted text, never as markup,
     never as a live link;
   - the **origin of the `redirect_uri`** the authorization code would be sent to. This is
     the one attacker-controlled string that actually decides where the authority lands,
     and the only one a human can check against "the thing I am trying to connect";
   - for a self-registered (DCR) client, an explicit **"registered itself — identity
     unverified"** marker beside the name. The hub vouches for nothing here, and the
     screen must not let a familiar-looking name read as a verified one;
   - the requested scopes, and the **namespace** the token will be audience-bound to;
   - an **agent picker**: a `<select>` over `agent_list`, defaulted to nothing,
     beside the plain sentence that the client will be able to do exactly what that
     agent can. This is the lazy binding decision made explicit — the agent is chosen
     at the moment the owner is already looking at the request, so no separate
     provisioning step exists.

   **Empty state, pinned**: a namespace with zero agents is the first-run path,
   not an edge case — the owner this section exists for may never have created one. With
   no agents, the picker renders an empty state naming `/apps` as the place to
   create one, the submit control is **disabled**, and consent is simply impossible until
   an agent exists; Deny still works. There is deliberately no inline create and no
   implicit "default" agent: an authority-granting screen is the wrong place to mint the
   thing that will hold the authority.
4. The POST goes to `/oauth/consent` (the hub's own route, through §13's `mutation`
   gate: session → form → CSRF → body — the same discipline as `/apps`, not a
   weaker one, because this POST both writes a binding and authorizes a client). The
   handler **verifies before it writes**: it first calls the provider's
   `/oauth2/consent` endpoint with `{ accept, oauth_query }` carrying the session —
   which is where the signature over `oauth_query` is enforced — and only on the
   provider's success does it upsert `oauth_binding`, write `oauth.consented` (or
   `oauth.rebound`), and redirect the browser to the `redirect_uri` the provider
   returned. A provider refusal writes nothing: no binding, no audit row, no code —
   otherwise every failed call would strand an `oauth_binding` for an authorization
   that never completed, and the §19.8 row "an edited `oauth_query` is refused and
   writes no binding" could not hold. Deny posts `accept: false` and the client
   receives `access_denied`.

CSRF posture, stated once: the hub's own CSRF token gates the POST; the provider's
signed `oauth_query` is what makes the *request being consented to* unforgeable; and
because the POST carries a cookie it is additionally subject to better-auth's origin
check, which the hub's own origin satisfies by default. Cookie-less machine POSTs from
a connector to `/oauth2/token` and `/oauth2/register` bypass that check by design and
need no `trustedOrigins` entry.

### 19.6 The token, end to end

1. claude.ai discovers the PRM from the 401 (or by probing), reads the AS document, and
   registers or reuses a client. Its one redirect URI is
   `https://claude.ai/api/mcp/auth_callback`.
2. It sends the RFC 8707 `resource` parameter — `https://<origin>/<user>/mcp`, canonical
   form, path included — on **both** the authorization and token requests. That
   parameter is what makes the issued access token a **signed JWT** rather than an
   opaque string, with `aud` = the resource. A client that omits it silently receives an
   opaque token instead; the hub cannot validate one in-worker (validation needs an API
   reachable only from inside a provider endpoint), so an opaque token is refused at the
   door with the ordinary challenge. MCP clients are spec-required to send `resource`,
   and this is the failure mode to look for first when a client cannot connect.
3. **At the door** (§7 step 1, `identity.resolveCredential`'s prefix dispatch — the same
   function that resolves `pmcp_agt_` keys, gaining one leg, so `resolvePrincipal` and
   everything past it are unchanged). Four rules, each an authorization boundary rather
   than an implementation note:

   **The predicate.** A bearer carrying neither `pmcp_` prefix is **JWT-shaped** when it
   is exactly three `.`-separated segments, each non-empty and each drawn from the
   base64url alphabet `[A-Za-z0-9_-]`. Nothing looser — not "contains a dot", not "decodes
   to JSON". This predicate selects between two credential regimes, so it is pinned at the
   byte level; a fuzzy version of it is a way to route a credential into the wrong one.

   **The leg is terminal.** A JWT-shaped bearer is answered by the OAuth leg **alone**.
   Every failure in it — malformed, bad signature, wrong issuer, wrong audience, expired,
   missing `mcp` scope, wrong token type, no binding row, revoked binding, deleted agent
   — is a **401**, and none of them falls through to the better-auth session lookup. Same
   hard rule the `pmcp_` prefixes carry, sharper reason: better-auth resolves some of its
   own signed tokens to a *session*, and a session resolves to the **owner**, so a
   fall-through would silently promote "this token's binding was revoked" to "this token
   is the owner" — the exact inversion §18 decision 23 exists to forbid. Fail closed,
   always.

   **Hub-signed is not sufficient.** The leg verifies, against the hub's own JWKS:
   signature; `iss` = the hub issuer; `exp`; the `mcp` scope; **and that the token is an
   access token minted by this authorization server for this namespace** — the `aud` rule
   below, plus the provider's own access-token claims. `jwt()` also mounts
   `/api/auth/token` (§19.2), which turns a live *cookie session* into a JWT that is
   correctly signed, correctly issued, and carries none of the rest. §19.7's allowlist
   means no bearer can reach that endpoint; the claim checks here mean it would not matter
   if one could. "Signed by our JWKS" is never the acceptance test, and a design that
   makes it one has handed every browser session an MCP credential.

   **Audience is namespace-wide.** `aud` must equal the namespace's canonical **aggregated**
   URL, `https://<origin>/<user>/mcp` — one identifier per namespace, the same string as
   the `oauthResource` row and the PRM's `resource` (§19.3). The door accepts that audience
   on the aggregated shape **and** on `/<user>/mcp/<slug>` within the same namespace;
   grants then filter per slug exactly as they do for a `pmcp_agt_` key, so the scoped
   endpoint refuses what the agent may not reach and **404s** what it holds no grant on
   — `/<user>/mcp/pmcp` included, which refuses like it refuses a key (§8), not as a
   resolution failure. The alternative, an audience per addressed URL, was rejected because
   it makes an OAuth token strictly *weaker* than the key it is supposed to be
   indistinguishable from, and turns §16's "indistinguishable from a `pmcp_agt_` key" into
   a false sentence on every scoped URL. A token whose `aud` names a **different**
   namespace is not "a resolved principal on a foreign namespace" (§7's 404 rule) but no
   principal at all: the same 401 challenge as no token, learning nothing about whether
   that namespace exists.
4. The verified `azp`/`client_id` plus the addressed owner resolve `oauth_binding`. No
   row, or `revoked_at` set, or the agent gone → the same 401 challenge, which is also
   the actionable answer: the owner can re-consent. A live row yields an
   `agent` principal — the identical shape `pmcp_agt_` produces — and stamps
   `last_used_at` under the same coarse window.
5. Everything downstream is §7 unchanged: grants, `-32001`/`-32002`/`-32003`, approvals,
   `hub/principal: "agent:<slug>"`, `hub/roles`, and audit rows under principal
   `agent:<slug>`. Nothing in the pipeline branches on how the credential arrived.

Lifetimes: access tokens keep the provider's ordinary hour, refresh tokens 30 days with
rotation. The usual objection to a JWT — that the fast path never re-checks revocation —
does not apply here, because step 4 reads the binding row on every call. That read is
the same one-per-request D1 cost a `pmcp_agt_` key already pays — and the *only* one, since
`verifyJwsAccessToken` verifies locally against the JWKS with no adapter read (§19.1) — and
it buys immediate
revocation: **the connection is revoked when the binding says so**, mid-session, without
waiting for `exp`. Revoking additionally deletes the provider's `oauthConsent` row, so
the client's next attempt walks the consent screen again rather than refreshing
silently.

### 19.7 Interaction with D11's credential-family gate

D11 landed a gate over `Authorization`-bearing requests to the `/api/auth` mount, so a
stolen CLI session token cannot enroll a second factor or revoke sessions (plan:
`docs/superpowers/plans/2026-08-26-d11-remediation.md`; the shape below is that plan's
PSD follow-up, which **inverted** the original deny-list). §19 mounts a whole plugin
bundle under the same prefix — including one endpoint, `/api/auth/token`, that must never
see a bearer. The invariant §19 relies on, and the one a test must pin in both directions:

> The gate is a fail-closed **allowlist**, not a rule about the mount and not a list of
> forbidden paths: under `/api/auth`, an `Authorization` header is admitted at
> **`/sign-out` and `/device/*`, and nowhere else**. Every other path on that mount —
> named, unnamed, or added tomorrow by a plugin nobody re-audited — refuses a
> bearer-carrying request.

Three consequences, stated rather than assumed:

- **`/api/auth/token` is out of reach by construction.** `jwt()` mounts it as a side
  effect and it converts a live session into a hub-signed JWT (§19.2). Under a deny-list
  it would have had to be *remembered* — precisely the class of mistake an allowlist makes
  structurally impossible. This is why §19 can adopt a plugin bundle without first
  auditing its whole route surface for credential-shaped endpoints, and it is the single
  most load-bearing thing D11 bought this section.
- **No §19 endpoint needs an allowlist entry**, because every client the hub supports is a
  **public** client: anonymous DCR forbids confidential registration, both Claude surfaces
  register with `token_endpoint_auth_method: "none"`, and PKCE S256 is required of
  everyone (§19.3). So `/oauth2/token` and `/oauth2/register` are reached by cookie-less,
  `Authorization`-less POSTs, and `/oauth2/introspect` is never called at all (§19.9). An
  `Authorization` header arriving at any of them is refused, and that refusal is correct
  rather than a gap: the day a confidential client is genuinely wanted, adding one
  allowlist entry is a deliberate reviewed edit, which is the entire point of the shape.
- **The door does not depend on any of this.** §19.6 step 3 refuses a hub-signed JWT that
  is not an access token for the addressed namespace, on its claims, whether or not one
  could ever have been minted. The allowlist is why `/api/auth/token` cannot be reached
  with a stolen CLI token; the claim checks are why it would not matter if it could. Two
  independent answers to one question, which is what a boundary this cheap should have.

The corollary is §18 decision 25 and §8's exception list: none of these endpoints, and
not `/oauth/consent`, ever appears on an MCP surface. The only MCP-reachable part of
§19 is `connection_list` / `connection_revoke` — grants-shaped ops on the caller's own
namespace, exactly what the `/oauth/connections` page fronts.

### 19.8 Failure modes

| Situation | Answer |
|---|---|
| No token, malformed token, expired token | 401 + challenge naming the per-user `resource_metadata`. Same bytes whether `<user>` exists or not. |
| Opaque token (client omitted `resource`) | Same 401 + challenge — the hub validates JWTs only, and says so here rather than pretending otherwise. |
| Token whose `aud` names another namespace | Same 401 + challenge. Audience is a resolution failure, not a namespace judgment, so no 404 and no existence signal about the namespace it was minted for or the one it was presented to. |
| Token whose `aud` names *this* namespace, addressed to `/<user>/mcp/<slug>` | **Accepted** — the audience is namespace-wide (§19.6 step 3). The slug is then judged by grants alone, exactly as for a `pmcp_agt_` key: `-32001` / `-32002` / 404 per §7, never an audience refusal. |
| Token whose `aud` is a *scoped* URL (`…/mcp/<slug>`) rather than the namespace's canonical aggregated URL | Same 401 + challenge, on both endpoint shapes. Namespace-wide means exactly one string; nothing issues that audience, so presenting it means the token came from somewhere else. |
| A hub-signed JWT that is not an access token — e.g. one minted from a cookie session at `/api/auth/token` | Same 401 + challenge. Correct signature and issuer are not the acceptance test (§19.6 step 3). |
| Any failure at all in the OAuth leg | 401. The leg is terminal — no failure falls through to a session lookup, so no failure can resolve as the owner (§19.6 step 3). |
| Unknown client (no binding row) | Same 401 + challenge; re-consent is the fix, and only the owner's browser session can perform it. |
| Binding revoked mid-session | The next call refuses with the same challenge; in-flight calls are not interrupted. The provider's consent row is gone too, so a refresh cannot resurrect it. |
| Agent deleted | The FK cascade removes the binding: identical to revoked, with no cleanup step to forget. |
| Consent POST without a valid CSRF token, or with an edited `oauth_query` | Refused by §13's `mutation` gate and by the provider's signature check respectively — nothing is written and no code is issued. |

### 19.9 Explicitly out of scope

Recorded so a later reader knows these were seen, not missed. None blocks the claude.ai
or Claude Code flows:

- **Advertising a scoped endpoint as its own OAuth resource** — no PRM is served at
  `/.well-known/oauth-protected-resource/<user>/mcp/<slug>` and no per-app
  `oauthResource` row exists, so a client cannot *discover* a scoped mount or obtain a
  token audience-bound to one. It can still *use* one: the audience is namespace-wide
  (§19.6 step 3), so an issued token works on `/<user>/mcp/<slug>` under that namespace's
  grants, which is what keeps §16's "indistinguishable from a `pmcp_agt_` key" true. What
  is out of scope is only the discovery half — one more route and one more resource row
  per app, the day a connector wants to mount a single app directly.
- **CIMD** (`@better-auth/cimd`, MCP 2026-07-28 Client ID Metadata Documents) — its
  bundled fetch transport is Node-only and would need a Workers replacement with
  private-range validation. DCR covers both clients today.
- **DPoP** — supported by the provider and advertised; no client here asks for it and no
  resource demands it.
- **Introspection as a validation path** — the endpoint exists (the provider mounts it)
  but the hub never calls it: it demands client credentials, so the hub would have to
  register itself as a client and POST to itself per request.
- **Claude Code over OAuth** — best-effort. Its existing `Authorization: Bearer
  pmcp_agt_…` header keeps working untouched and stays the supported CLI route; a
  configured header wins over OAuth in Claude Code anyway. Two unverified behaviors sit
  behind this — whether its DCR body declares `application_type: "native"` alongside its
  `http://localhost:PORT/callback` redirect (the provider's `"web"` default would
  otherwise reject it), and whether it sends `resource` — and both are recorded as open
  questions in the plan rather than designed around.

