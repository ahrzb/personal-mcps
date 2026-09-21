## 5. Data model

better-auth owns: `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`,
`deviceCode` — plus, from 2026-08-26, the seven `oauth*` tables and `jwks` that §19's
authorization server brings (their DDL and the hub's own `oauth_binding` are pinned
there, not repeated here). One extension of ours on `passkey`: a `last_used_at` column the hub
stamps after each successful passkey sign-in (better-auth's schema only tracks
`createdAt`) — cheap (one UPDATE per human passkey login) and it backs the "last used"
line on `/settings`'s passkey rows.

Ours, in D1:

```sql
CREATE TABLE app (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                  -- [a-z0-9-], used in /<user>/mcp/<slug>
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'tunnel' CHECK (kind IN ('tunnel', 'proxy')),
                                       -- kind is immutable after create (app_update rejects
                                       -- changes; recreate to convert)
  upstream_url TEXT,                   -- proxy kind only
  upstream_auth_mode TEXT CHECK (upstream_auth_mode IN ('headers', 'oauth')),
                                       -- proxy kind only; default 'headers'. Deliberately
                                       -- separate from upstream_auth_json: the mode is
                                       -- configuration and survives Disconnect; the
                                       -- credential envelope exists only while connected.
  forward_identity INTEGER NOT NULL DEFAULT 0,
                                       -- proxy kind only; send X-Pmcp-* identity headers
                                       -- upstream (§7, "Caller identity forwarding")
  upstream_auth_json TEXT,             -- proxy kind only; AES-GCM envelope-encrypted (WebCrypto,
                                       -- key in a wrangler secret) so D1 exports/dumps don't leak
                                       -- upstream credentials. Inside: {kind: 'headers', headers}
                                       -- (set through app_set_upstream_auth or a provider
                                       -- write-only argument) or {kind: 'oauth', tokens,
                                       -- as_metadata, client} (populated by the connect flow, §7).
                                       -- Envelope kind always matches upstream_auth_mode.
  roles_json TEXT NOT NULL DEFAULT '{}',  -- {"reader": ["get_news","search_.*"], ...}
                                          -- tunnel: written at registration; proxy: via config
  owner_roles_json TEXT NOT NULL DEFAULT '{}',
                                          -- the roles the OWNER defined on a TUNNELED app
                                          -- (2026-09-17, decision 32), same normalized
                                          -- per-family shape as roles_json (§20.3). A proxied
                                          -- app keeps its roles in roles_json — they are already
                                          -- all the owner's — and leaves this '{}'. The door
                                          -- resolves against the merge of the two, the app's
                                          -- declaration winning a name collision (§20.3); a
                                          -- reconnect rewrites roles_json alone, so owner roles
                                          -- survive it.
  typescript_aliases_json TEXT NOT NULL DEFAULT '{}',
                                          -- owner-set hub-local service/tool aliases (§23).
                                          -- This configuration is separate from durable
                                          -- resolved reservations; omission on update does
                                          -- not clear it.
  redact_json TEXT NOT NULL DEFAULT '{}', -- config-declared sensitive ARGUMENT paths per
                                          -- tool-or-pattern (§7) — either kind
  redact_results_json TEXT NOT NULL DEFAULT '{}',
                                          -- same shape, applied to result structuredContent (§7)
  log_bodies INTEGER NOT NULL,            -- audit body logging for this app (§15); set at
                                          -- create: an absent input defaults by kind —
                                          -- tunnel 1, proxy 0
  created_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  archived_at INTEGER,                 -- non-NULL = archived (§6, "App lifecycle")
  UNIQUE (owner_id, slug)
);

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE TABLE grant_ (                   -- "grant" is an SQL keyword
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- an entry: a role name, the built-in 'all', or an
                                         -- inline item family/pattern (§8) — 'tool/get_news',
                                         -- 'resource/news://feed/*' (2026-09-16, decision 31:
                                         -- the column keeps its name; the string is stored and
                                         -- relayed unchanged, mode lives in `mode`)
  mode TEXT NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'approval')),
  PRIMARY KEY (agent_id, app_id, role)
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
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
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'app')),
  ref_id TEXT NOT NULL,                  -- agent.id or app.id per kind
  hash TEXT NOT NULL UNIQUE,             -- SHA-256 of the full token string
  prefix TEXT NOT NULL,                  -- first ~12 chars, for display in listings
  expires_at INTEGER,                    -- pmcp_agt_ tokens default to 90 d (overridable, incl.
                                         -- 'never'); pmcp_app_ default to no expiry (telegram-bot
                                         -- model: revoke on compromise)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                  -- coarse (updated at most hourly), shown in token_list —
                                         -- makes leaked-token use and rotation state observable
  revoked_at INTEGER
);

CREATE TABLE hub_execution_setting (
  owner_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  default_timeout_ms INTEGER NOT NULL,
  max_timeout_ms INTEGER NOT NULL,
  CHECK (default_timeout_ms >= 1000),
  CHECK (default_timeout_ms <= max_timeout_ms),
  CHECK (max_timeout_ms <= 300000)
);

CREATE TABLE typescript_name_reservation (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,                    -- immutable app identity; intentionally no FK so
                                           -- app deletion can tombstone rather than erase
  family TEXT NOT NULL CHECK (family IN ('service', 'tool')),
  canonical_name TEXT NOT NULL,
  typescript_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner', 'sdk', 'generated')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  superseded_at INTEGER,
  PRIMARY KEY (owner_id, app_id, family, canonical_name, typescript_name)
);
CREATE UNIQUE INDEX typescript_service_name_reserved
  ON typescript_name_reservation(owner_id, typescript_name)
  WHERE family = 'service';
CREATE UNIQUE INDEX typescript_tool_name_reserved
  ON typescript_name_reservation(app_id, typescript_name)
  WHERE family = 'tool';

-- The absence of hub_execution_setting means default/max 30000 ms. Reservation rows
-- remain after app deletion: a deleted/recreated slug receives a different app id and
-- cannot claim the old service name. Owner deletion cascades both tables.
```

The migrations enforce reservation ownership/identity consistency around these raw
tables: registry writes resolve the app before batching, never publish a mapping before
its unique constraints commit, and tombstone deleted/disappeared/superseded names.


(`ref_id` can't be a foreign key to two tables; `app_delete` / `agent_delete`
delete matching token rows as a server-side side effect (§8), and verification
additionally rejects tokens whose referenced row no longer exists (§6 for app
tokens, §7 for agent tokens).)

```sql
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  owner_id TEXT NOT NULL,              -- namespace the event happened in
  principal TEXT NOT NULL,             -- 'user:<name>' | 'agent:<slug>' | 'app:<slug>' | 'bootstrap'
  event TEXT NOT NULL,                 -- 'tools/call' | 'admin.<tool>' | 'connect.register' |
                                       -- 'connect.replaced' | 'connect.roles_widened' |
                                       -- 'auth.login' | 'auth.device_approved' | …
  app TEXT,                            -- slug, when applicable
  tool TEXT,
  outcome TEXT NOT NULL,               -- 'ok' | '-32000' | '-32001' | '-32002' | '-32003' | 'error'
  duration_ms INTEGER,                 -- hub-measured wall time from consumer request to
                                       -- response; set on every tools/call row (denials are
                                       -- just fast), NULL for non-call events
  client_name TEXT,                    -- consumer clientInfo.name (e.g. 'claude-code'), when sent (§7)
  client_version TEXT,
  client_session_id TEXT,              -- client-declared session id (e.g. Claude Code's), when sent
  args_json TEXT,                      -- tools/call rows, when the app's log_bodies is on
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
                                       -- live only in the two capped columns above.
                                       -- What it may hold, by event (2026-09-21, decision
                                       -- 36): `approvalId` on the four approval.* rows, on
                                       -- the tools/call row refused -32003, and on the
                                       -- tools/call row dispatched under a claimed approval
                                       -- (§7 step 1) — MERGED with whatever else the
                                       -- outcome owes, so a -32000 after a claim carries
                                       -- both failureClass and approvalId; `failureClass`
                                       -- on a -32000 (§15); and the bounded decision
                                       -- summary a mutating admin.<tool> row writes (§8).
                                       -- An approval id is not token
                                       -- material and no `reason` is ever recorded for a
                                       -- -32001 — §15 pins both.
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
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
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

`AppConnection` keeps per-app volatile/cached state in its own SQLite: cached family
catalogs, connection metadata, alarm purpose, ring timing and subscriber attachments.
Hub execution adds no Durable Object or D1 job/workspace state: every invocation owns one
ephemeral in-Worker QuickJS runtime, while durable owner timeout settings and TypeScript
reservations live in D1 tables above.

App socket identity/auth facts ride in `serializeAttachment` (≤16 KB); subscriber
attachments additionally carry principal and capped subscriptions as §21 requires.

