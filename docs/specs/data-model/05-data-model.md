## 5. Data model

better-auth owns: `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`,
`deviceCode` — plus, from 2026-08-26, the seven `oauth*` tables and `jwks` that §19's
authorization server brings (their DDL and the hub's own `oauth_binding` are pinned
there, not repeated here). One extension of ours on `passkey`: a `last_used_at` column the hub
stamps after each successful passkey sign-in (better-auth's schema only tracks
`createdAt`) — cheap (one UPDATE per human passkey login) and it backs the "last used"
line on `/account`'s passkey rows.

Ours, in D1:

```sql
CREATE TABLE service (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                  -- [a-z0-9-], referenced in YAML and /<user>/mcp/<slug>
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'tunnel' CHECK (kind IN ('tunnel', 'proxy')),
                                       -- kind is immutable after create (service_update rejects
                                       -- changes; recreate to convert)
  upstream_url TEXT,                   -- proxy kind only
  upstream_auth_mode TEXT CHECK (upstream_auth_mode IN ('headers', 'oauth')),
                                       -- proxy kind only; the declared `auth` mode (§7, §9),
                                       -- default 'headers'. Deliberately separate from
                                       -- upstream_auth_json: the mode is configuration and
                                       -- survives Disconnect; the envelope is credentials and
                                       -- exists only while connected/configured.
  forward_identity INTEGER NOT NULL DEFAULT 0,
                                       -- proxy kind only; send X-Pmcp-* identity headers
                                       -- upstream (§7, "Caller identity forwarding")
  upstream_auth_json TEXT,             -- proxy kind only; AES-GCM envelope-encrypted (WebCrypto,
                                       -- key in a wrangler secret) so D1 exports/dumps don't leak
                                       -- upstream credentials. Inside: {kind: 'headers', headers}
                                       -- (set imperatively, §8) or {kind: 'oauth', tokens,
                                       -- as_metadata, client} (populated by the connect flow, §7).
                                       -- Never via YAML either way. Envelope kind always matches
                                       -- upstream_auth_mode.
  roles_json TEXT NOT NULL DEFAULT '{}',  -- {"reader": ["get_news","search_.*"], ...}
                                          -- tunnel: written at registration; proxy: via config
  redact_json TEXT NOT NULL DEFAULT '{}', -- config-declared sensitive ARGUMENT paths per
                                          -- tool-or-pattern (§7) — either kind
  redact_results_json TEXT NOT NULL DEFAULT '{}',
                                          -- same shape, applied to result structuredContent (§7)
  log_bodies INTEGER NOT NULL,            -- audit body logging for this service (§15); set at
                                          -- create: an absent input defaults by kind —
                                          -- tunnel 1, proxy 0
  created_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  archived_at INTEGER,                 -- non-NULL = archived (§6, "Service lifecycle")
  UNIQUE (owner_id, slug)
);

CREATE TABLE service_account (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE TABLE grant_ (                   -- "grant" is an SQL keyword
  service_account_id TEXT NOT NULL REFERENCES service_account(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- exact role name, or the built-in 'all' (§9)
  mode TEXT NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'approval')),
  PRIMARY KEY (service_account_id, service_id, role)
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  service_account_id TEXT NOT NULL REFERENCES service_account(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,               -- SHA-256 of the canonical (sorted-keys) JSON of
                                         -- params.arguments ONLY, computed POST-redaction (§7 —
                                         -- no digest of a secret); MRTR inputResponses/requestState
                                         -- are outside the binding and never persisted (§7)
  args_json TEXT NOT NULL,               -- the arguments SHOWN to the owner — stored
                                         -- post-redaction (§7), like every persisted
                                         -- body in the hub (§15)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'used')),
                                         -- past expires_at is treated as expired on every read;
                                         -- rows are flipped lazily (§7)
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL            -- 1 h from creation; covers both the pending
                                         -- wait and the post-approval retry window
);
CREATE INDEX approval_owner_status ON approval(owner_id, status, created_at);

CREATE TABLE token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service_account', 'service')),
  ref_id TEXT NOT NULL,                  -- service_account.id or service.id per kind
  hash TEXT NOT NULL UNIQUE,             -- SHA-256 of the full token string
  prefix TEXT NOT NULL,                  -- first ~12 chars, for display in listings
  expires_at INTEGER,                    -- pmcp_sa_ tokens default to 90 d (overridable, incl.
                                         -- 'never'); pmcp_svc_ default to no expiry (telegram-bot
                                         -- model: revoke on compromise)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                  -- coarse (updated at most hourly), shown in token_list —
                                         -- makes leaked-token use and rotation state observable
  revoked_at INTEGER
);
```

(`ref_id` can't be a foreign key to two tables; `service_delete` / `account_delete`
delete matching token rows as a server-side side effect (§8), and verification
additionally rejects tokens whose referenced row no longer exists (§6 for service
tokens, §7 for service-account tokens).)

```sql
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  owner_id TEXT NOT NULL,              -- namespace the event happened in
  principal TEXT NOT NULL,             -- 'user:<name>' | 'sa:<slug>' | 'svc:<slug>' | 'bootstrap'
  event TEXT NOT NULL,                 -- 'tools/call' | 'admin.<tool>' | 'connect.register' |
                                       -- 'connect.replaced' | 'connect.roles_widened' |
                                       -- 'auth.login' | 'auth.device_approved' | …
  service TEXT,                        -- slug, when applicable
  tool TEXT,
  outcome TEXT NOT NULL,               -- 'ok' | '-32000' | '-32001' | '-32002' | '-32003' | 'error'
  duration_ms INTEGER,                 -- hub-measured wall time from consumer request to
                                       -- response; set on every tools/call row (denials are
                                       -- just fast), NULL for non-call events
  client_name TEXT,                    -- consumer clientInfo.name (e.g. 'claude-code'), when sent (§7)
  client_version TEXT,
  client_session_id TEXT,              -- client-declared session id (e.g. Claude Code's), when sent
  args_json TEXT,                      -- tools/call rows, when the service's log_bodies is on
                                       -- (§15): params.arguments POST-redaction (§7's union),
                                       -- size-capped — an over-cap body is a stub, never
                                       -- truncated JSON
  result_json TEXT,                    -- same gate; envelope pinned (§15): mirrors the
                                       -- MCP result's two carriers — structuredContent
                                       -- post-redaction, content as one typed size stub
                                       -- ({stub, contentType?, bytes}) per block, never
                                       -- bytes; a result with only content blocks
                                       -- stores {content: [...]}
  detail TEXT                          -- small JSON summary; NEVER token material — bodies
                                       -- live only in the two capped columns above
);
CREATE INDEX audit_owner_ts ON audit(owner_id, ts);

CREATE TABLE push_subscription (       -- Web Push targets for approval notifications (§13)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,             -- p256dh + auth as handed out by the browser
  created_at INTEGER NOT NULL
);

CREATE TABLE upstream_oauth_state (    -- §7 upstream-OAuth connect flow's one-time state
                                       -- record (added 2026-08-25, migration 0004 — this
                                       -- table was implied by §7's prose but missing from
                                       -- this DDL as first written). upstream.ts owns the
                                       -- lifecycle: beginConnect writes, handleCallback
                                       -- consumes by compare-and-set DELETE, the daily
                                       -- cron sweeps stragglers past TTL.
  state TEXT PRIMARY KEY,              -- the unguessable nonce; also the `state` parameter
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,            -- only the browser session that began the flow may
                                       -- complete it; no FK (better-auth owns `session`)
  issuer TEXT NOT NULL,                -- RFC 9207 `iss` compares against THIS, never the
                                       -- callback's own claim
  token_endpoint TEXT NOT NULL,        -- mix-up defense: code redeemed here alone
  client_id TEXT NOT NULL,             -- CIMD URL, or the id DCR handed back
  code_verifier TEXT NOT NULL,         -- PKCE S256 verifier; plaintext DELIBERATELY — it
                                       -- lives ~10 min, authorizes nothing alone, and a
                                       -- reader of this table already sees the code and
                                       -- sealed bundle beside it; §15 still bans it from
                                       -- logs/audit/errors
  redirect_uri TEXT NOT NULL,
  issuer_advertised INTEGER NOT NULL,  -- 0/1: AS metadata declared iss support; §7's check
                                       -- is conditional on it, recorded at initiation
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL          -- created_at + ~10 min; enforced at read, swept daily
);
CREATE INDEX upstream_oauth_state_expires ON upstream_oauth_state(expires_at);
```

The DO keeps per-service volatile/cached state in its own SQLite: cached `tools/list`
result, connection metadata. Identity/auth facts for the socket ride in
`serializeAttachment` (≤16 KB) *(amended 2026-09-01, §21.4: a subscriber socket's
attachment additionally carries its principal and its capped subscription set —
`LISTEN_SUBSCRIPTIONS_MAX` × `SUBSCRIBE_URI_MAX_BYTES` keeps it far inside the 16 KB)*.

