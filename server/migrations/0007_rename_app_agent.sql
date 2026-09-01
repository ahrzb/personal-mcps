-- 0007_rename_app_agent.sql — the 2026-09-01 lingo rename, in the schema: a registered
-- MCP entry is an `app` (was `service`) and a consumer identity is an `agent` (was
-- `service_account`). Vocabulary only: not one row's meaning changes, no column gains or
-- loses a rule, and every constraint below is the same constraint 0002/0003/0005 declared.
--
-- RENAME, never drop-and-recreate. `ALTER TABLE … RENAME TO` and `… RENAME COLUMN` carry
-- the data AND rewrite every reference SQLite knows about — the REFERENCES clauses in
-- `grant_`, `approval`, `upstream_oauth_state` and `oauth_binding`, and the column lists of
-- `approval_pending_binding` and `approval_owner_status` — so nothing here has to restate a
-- foreign key or rebuild an index. (This is why 0002..0006 are left exactly as they were:
-- migrations are history, and a live database gets here by replaying them and then this.)
--
-- The ONE exception is `token.kind`, whose vocabulary is CHECK-constrained: SQLite cannot
-- alter a CHECK, so the column's two values are remapped through the documented table
-- rebuild — a new table, every row COPIED over with its kind translated, and only then the
-- old one dropped. Nothing references `token` (`ref_id` deliberately carries no foreign
-- key, §5), so the rebuild has no reference to re-point.
--
-- NOT renamed, deliberately: better-auth's own world — `user`, `session`, `verification`,
-- and its `account` table, which is OAuth account LINKING and has never been our noun.
--
-- Old `pmcp_svc_` / `pmcp_sa_` tokens stop validating at this deploy by owner decision (no
-- compatibility aliases); their rows are carried over rather than deleted, so `token_list`
-- still shows what has to be re-issued.

ALTER TABLE service RENAME TO app;
ALTER TABLE service_account RENAME TO agent;

ALTER TABLE grant_ RENAME COLUMN service_account_id TO agent_id;
ALTER TABLE grant_ RENAME COLUMN service_id TO app_id;

ALTER TABLE approval RENAME COLUMN service_account_id TO agent_id;
ALTER TABLE approval RENAME COLUMN service_id TO app_id;

ALTER TABLE upstream_oauth_state RENAME COLUMN service_id TO app_id;

ALTER TABLE oauth_binding RENAME COLUMN service_account_id TO agent_id;

-- The audit ledger's per-row subject slug (§5: "slug, when applicable").
ALTER TABLE audit RENAME COLUMN service TO app;

-- token.kind: 'service_account' → 'agent', 'service' → 'app'. The CHECK is the reason this
-- one is a rebuild; the column keeps its meaning (read explicitly at every resolve, never
-- inferred from the token prefix, §6).
CREATE TABLE token_renamed (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'app')),
  ref_id TEXT NOT NULL,                   -- agent.id or app.id per kind; NO FK (0002's header)
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  expires_at INTEGER,                     -- pmcp_agt_ default 90 d (overridable, incl. never);
                                          -- pmcp_app_ default no expiry
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
INSERT INTO token_renamed (id, kind, ref_id, hash, prefix, expires_at, created_at, last_used_at, revoked_at)
  SELECT id,
         CASE kind WHEN 'service_account' THEN 'agent' WHEN 'service' THEN 'app' ELSE kind END,
         ref_id, hash, prefix, expires_at, created_at, last_used_at, revoked_at
    FROM token;
DROP TABLE token;
ALTER TABLE token_renamed RENAME TO token;
