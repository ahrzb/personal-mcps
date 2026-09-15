-- 0009_admin_token.sql — §22.1's `pmcp_adm_` credential family, in its OWN table rather
-- than a third `token.kind`: that CHECK (kind IN ('agent','app'), 0007_rename_app_agent.sql)
-- would have to grow a polymorphic referent, and OWNED_BY/TOKEN_READ/TOKEN_PREFIX/referentOf
-- /expiryFor/deleteUser would all need surgery on live credential paths — for a row whose
-- `ref_slug` would be a username, punning on a column that means "what this token is bound
-- to". This table has no referent at all: an admin token is bound to its owner alone.
--
-- `owner_id` carries an ON DELETE CASCADE the shared `token` table's `ref_id` deliberately
-- does not (0002_hub.sql's header): user deletion disposes of admin tokens structurally,
-- with no sweep for admin.deleteUser to perform. `hash` is UNIQUE because credential
-- resolution is a hash lookup (identity.resolveCredential's `pmcp_adm_` leg); `owner_id` is
-- indexed because admin_token_list and admin_token_revoke both filter by it.
--
-- Expiry is fixed, not sliding (§22.1: an admin token is not a session) — `expires_at` is
-- written once, at issue, and never advanced. `last_used_at` is the same coarse rotation
-- signal `token.last_used_at` is (limits.TOKEN_LAST_USED_STAMP_MS).

CREATE TABLE admin_token (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL UNIQUE,   -- SHA-256 of the plaintext, as token.hash
  prefix       TEXT NOT NULL,          -- display only, never a lookup key
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                -- NULL means never
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX admin_token_owner ON admin_token(owner_id);
