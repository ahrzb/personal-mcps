-- 0011_hub_execution.sql — §23's durable half: the owner's execution-timeout settings,
-- the hub-local TypeScript name reservations code is written against, and the app column
-- that holds the owner's alias configuration.
--
-- Four statements, each a pure ADD — nothing here rewrites an earlier file, and no
-- existing row changes meaning:
--
--   · app.typescript_aliases_json — §23.6's owner configuration lane, stored exactly as
--     written. NOT NULL DEFAULT '{}' for 0010_owner_roles.sql's reason: it makes the
--     column a pure add, and every reader (toDetail, admin's row shape) can then report
--     one shape. It is CONFIGURATION, deliberately separate from the resolved
--     reservations below: omission on `app_update` leaves it untouched (§23.6), so the
--     column is only rewritten when a caller supplies the key.
--
--   · hub_execution_setting — §23.3: at most one row per owner. ABSENCE is the pinned
--     default pair 30_000/30_000, and that answer belongs to the domain (registry), not
--     the schema — so there is NO DEFAULT clause here (0002_hub.sql's rule: a DEFAULT
--     would be a second, never-exercised answer to "what does an absent value mean").
--     The three CHECKs are the range §23.3's ops advertise and enforce
--     (`1_000 <= default <= max <= 300_000`; the ceiling is the compiled
--     limits.HUB_HARD_MAX_TIMEOUT_MS), stated table-level exactly as the spec's DDL
--     spells them.
--
--   · typescript_name_reservation — §23.6's durable name ledger. `app_id` carries NO
--     foreign key ON PURPOSE, like `token.ref_id` (0002_hub.sql's header): app deletion
--     TOMBSTONES (active = 0, superseded_at set) instead of erasing, so a deleted and
--     recreated slug — which gets a NEW app id, and so a new service alias — can never
--     claim the TypeScript code written against the old member. Owner deletion is the
--     one cascade. `superseded_at` is nullable and carries a timestamp only on
--     tombstones; `active` is the 0/1 boolean every reader branches on.
--
-- The two partial unique indexes are the concurrency arbitration §23.6 requires: a
-- service alias is unique PER OWNER and a tool alias PER IMMUTABLE APP ID, and the
-- predicates do NOT filter on `active = 1` — tombstones keep holding their name, which
-- is exactly what stops a later, different canonical identity from being handed a path
-- someone's code already uses. There is no release/reuse interface to drop one.

ALTER TABLE app ADD COLUMN typescript_aliases_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE hub_execution_setting (
  owner_id           TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  default_timeout_ms INTEGER NOT NULL,
  max_timeout_ms     INTEGER NOT NULL,
  CHECK (default_timeout_ms >= 1000),
  CHECK (default_timeout_ms <= max_timeout_ms),
  CHECK (max_timeout_ms <= 300000)
);

CREATE TABLE typescript_name_reservation (
  owner_id        TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  app_id          TEXT NOT NULL,          -- immutable app identity; NO FK (see header)
  family          TEXT NOT NULL CHECK (family IN ('service', 'tool')),
  canonical_name  TEXT NOT NULL,          -- the upstream's own service/tool name, verbatim
  typescript_name TEXT NOT NULL,          -- the hub-local alias code is written against
  source          TEXT NOT NULL CHECK (source IN ('owner', 'sdk', 'generated')),
  active          INTEGER NOT NULL CHECK (active IN (0, 1)),
  superseded_at   INTEGER,                -- non-NULL exactly when active = 0
  PRIMARY KEY (owner_id, app_id, family, canonical_name, typescript_name),
  CHECK ((active = 1 AND superseded_at IS NULL) OR (active = 0 AND superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX typescript_service_name_reserved
  ON typescript_name_reservation (owner_id, typescript_name)
  WHERE family = 'service';
CREATE UNIQUE INDEX typescript_tool_name_reserved
  ON typescript_name_reservation (app_id, typescript_name)
  WHERE family = 'tool';
