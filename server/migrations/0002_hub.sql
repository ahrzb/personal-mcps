-- 0002_hub.sql — the hub's own control plane (§5), minus `approval`, which is approvals'
-- own migration (0003) because the module owns the table and the partial unique index
-- together (approvals.ts's contract header).
--
-- Transcribed from §5's DDL and deliberately NOTHING MORE: every CHECK, UNIQUE and NOT
-- NULL here has a pinned oracle row in server/test/worker/migrations.test.ts, and that
-- file's exhaustiveness case derives its coverage from this SQL — so a "harmless" extra
-- constraint (an `IN (0, 1)` on the INTEGER booleans, a NOT NULL on a TEXT PRIMARY KEY)
-- fails the suite rather than passing unpinned. Add a constraint here only together with
-- its row.
--
-- Two absences are load-bearing, not oversights:
--   · `token.ref_id` carries NO foreign key — it points at `service_account.id` OR
--     `service.id` per `kind`, which SQL cannot express (§5's parenthetical). Removing a
--     dangling token row is admin's cascade (`service_delete` / `account_delete`, §8),
--     which is where it gets audited; an FK added here would move that removal out of
--     audited code.
--   · `audit.owner_id` carries no foreign key either — the record of record outlives the
--     namespace it describes, and retention (§15) prunes it, never a cascade.
--
-- NO column a domain writer always binds carries a DEFAULT. The reasoning is §15's, for
-- `log_bodies` first: SQLite applies a DEFAULT when the column is OMITTED, so
-- `NOT NULL DEFAULT 1` would silently give proxied services bodies-on and defeat the
-- by-kind resolution registry.createService does (tunnel 1, proxy 0, always written
-- concretely). The same holds for every column createService/createAccount/setGrants bind
-- unconditionally — kind, description, forward_identity, the three *_json columns,
-- grant_.mode — so the DEFAULT is dropped from all of them rather than from one. A
-- DEFAULT there is a SECOND answer to "what does an absent value mean", never exercised
-- by the only writer and so never tested, and the next writer (a backfill, a raw-SQL
-- oracle row, a future service_import) would silently get the schema's answer instead of
-- the domain's. Omission now fails on the NOT NULL where there is one, and lands NULL —
-- which registry already reads as "" — on the two nullable `description` columns.
-- A DEFAULT survives here only where omission is a legitimate call; none currently is.

-- Ours, on better-auth's table (§5): stamped after each successful passkey sign-in, so
-- /account can show "last used" (better-auth's own schema tracks createdAt only). Kept
-- out of 0001 so regenerating better-auth's file never drops it.
ALTER TABLE "passkey" ADD COLUMN "last_used_at" INTEGER;

CREATE TABLE service (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  slug TEXT NOT NULL,                     -- [a-z0-9-], referenced in YAML and /<user>/mcp/<slug>
  name TEXT NOT NULL,
  description TEXT,                       -- always bound by createService; absent reads as ''
  kind TEXT NOT NULL CHECK (kind IN ('tunnel', 'proxy')),
                                          -- immutable after create (service_update rejects
                                          -- changes; recreate to convert). Same vocabulary
                                          -- as registry.ServiceKind.
  upstream_url TEXT,                      -- proxy kind only
  upstream_auth_mode TEXT CHECK (upstream_auth_mode IN ('headers', 'oauth')),
                                          -- proxy kind only; the declared `auth` mode (§7,
                                          -- §9). Configuration, so it survives Disconnect —
                                          -- deliberately separate from upstream_auth_json,
                                          -- which is credentials.
  forward_identity INTEGER NOT NULL,
                                          -- proxy kind only; send X-Pmcp-* identity headers
                                          -- upstream (§7)
  upstream_auth_json TEXT,                -- proxy kind only; AES-GCM envelope-encrypted
                                          -- (WebCrypto, key in a wrangler secret) so D1
                                          -- exports don't leak upstream credentials. Envelope
                                          -- kind always matches upstream_auth_mode.
  roles_json TEXT NOT NULL,               -- {"reader": ["get_news","search_.*"], ...}
  redact_json TEXT NOT NULL,              -- sensitive ARGUMENT paths per tool-or-pattern (§7)
  redact_results_json TEXT NOT NULL,      -- same shape, applied to result structuredContent (§7)
  log_bodies INTEGER NOT NULL,            -- audit body logging (§15); set at create, defaulted
                                          -- BY KIND there, never here (see header)
  created_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  archived_at INTEGER,                    -- non-NULL = archived (§6, "Service lifecycle")
  UNIQUE (owner_id, slug)                 -- §2: (owner, slug) identifies a service
);

CREATE TABLE service_account (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,                       -- always bound by createAccount; absent reads as ''
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE TABLE grant_ (                     -- "grant" is an SQL keyword
  service_account_id TEXT NOT NULL REFERENCES service_account (id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  role TEXT NOT NULL,                     -- exact role name, or the built-in 'all' (§9)
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'approval')),
                                          -- registry.AccessMode's third member, `deny`, is a
                                          -- RESOLVER answer and never a stored grant — the
                                          -- CHECK is where that distinction is structural
  PRIMARY KEY (service_account_id, service_id, role)
);

CREATE TABLE token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service_account', 'service')),
                                          -- read explicitly at every resolve, never inferred
                                          -- from the pmcp_sa_/pmcp_svc_ prefix (§6)
  ref_id TEXT NOT NULL,                   -- service_account.id or service.id per kind; NO FK
                                          -- (see header)
  hash TEXT NOT NULL UNIQUE,              -- SHA-256 of the full token string
  prefix TEXT NOT NULL,                   -- first ~12 chars, for display in listings
  expires_at INTEGER,                     -- pmcp_sa_ default 90 d (overridable, incl. never);
                                          -- pmcp_svc_ default no expiry
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                   -- coarse (at most hourly), shown in token_list
  revoked_at INTEGER
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  owner_id TEXT NOT NULL,                 -- namespace the event happened in; NO FK (see header)
  principal TEXT NOT NULL,                -- 'user:<name>' | 'sa:<slug>' | 'svc:<slug>' | 'bootstrap'
  event TEXT NOT NULL,                    -- 'tools/call' | 'admin.<tool>' | 'connect.register' | …
  service TEXT,                           -- slug, when applicable
  tool TEXT,
  outcome TEXT NOT NULL,                  -- 'ok' | '-32000' | … | 'error'. NOT NULL with NO CHECK
                                          -- by design: the vocabulary grows with every new
                                          -- JSON-RPC code, and a CHECK would make a new refusal
                                          -- code a migration.
  duration_ms INTEGER,                    -- hub-measured wall time; NULL for non-call events
  client_name TEXT,                       -- consumer clientInfo.name, when sent (§7)
  client_version TEXT,
  client_session_id TEXT,
  args_json TEXT,                         -- tools/call rows when the service's log_bodies is on
                                          -- (§15): params.arguments POST-redaction, size-capped —
                                          -- an over-cap body is a stub, never truncated JSON
  result_json TEXT,                       -- same gate; structuredContent post-redaction, content
                                          -- blocks as typed size stubs, never bytes
  detail TEXT                             -- small JSON summary; NEVER token material
);
CREATE INDEX audit_owner_ts ON audit (owner_id, ts);

CREATE TABLE push_subscription (          -- Web Push targets for approval notifications (§13)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,          -- what makes re-subscribing one browser an upsert
                                          -- rather than a duplicate notification
  keys_json TEXT NOT NULL,                -- p256dh + auth as handed out by the browser
  created_at INTEGER NOT NULL
);
