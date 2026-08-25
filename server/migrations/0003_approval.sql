-- 0003_approval.sql — the approval gate's table (§5) and the two indexes it is read and
-- raced through (§7). Approvals' own migration: approvals.ts owns the whole lifecycle of
-- this table, and the partial unique index below is part of that module's contract, not a
-- schema detail bolted on elsewhere.
--
-- Separate from 0002 for the ordinary reason migrations are separate — it lands after the
-- tables it references (`user`, `service_account`, `service`) and can therefore be read as
-- the change it is. Nothing here rewrites an earlier file.
--
-- Constraint discipline is 0002's: every CHECK, UNIQUE and NOT NULL below has a pinned
-- oracle row, and nothing beyond them is declared.

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  service_account_id TEXT NOT NULL REFERENCES service_account (id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  tool TEXT NOT NULL,                     -- the UNPREFIXED tool name, so a retry through
                                          -- either endpoint shape matches the same row (§7)
  args_hash TEXT NOT NULL,                -- SHA-256 of the canonical (sorted-keys) JSON of
                                          -- params.arguments ONLY, computed POST-redaction
                                          -- (§7 — no digest of a secret); MRTR
                                          -- inputResponses/requestState are outside the
                                          -- binding and never persisted
  args_json TEXT NOT NULL,                -- the arguments SHOWN to the owner — stored
                                          -- post-redaction (§7), like every persisted body (§15)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'used')),
                                          -- same five-member vocabulary as
                                          -- approvals.ApprovalStatus; past expires_at reads as
                                          -- expired on every read, and rows are flipped lazily (§7)
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL             -- limits.APPROVAL_WINDOW_MS from creation; covers both
                                          -- the pending wait and the post-approval retry window
);

CREATE INDEX approval_owner_status ON approval (owner_id, status, created_at);

-- §7 step 2: the dedup of concurrent identical first calls, made by the CONSTRAINT rather
-- than by application code — a losing insert re-reads and returns the winner's row.
--
-- PARTIAL on purpose: once a row leaves `pending` (approved, rejected, expired, used) the
-- same binding must be free to open a fresh request, so the predicate is total over the
-- rest of the ApprovalStatus vocabulary.
--
-- `tool` is a KEY column, not payload. Two no-argument approval-gated tools on one service
-- hash to the identical canonical `{}`, so an index over (account, service, args_hash)
-- alone would refuse the second pending row and make the gate re-read the OTHER tool's
-- row — approving tool A would silently authorize tool B.
CREATE UNIQUE INDEX approval_pending_binding
  ON approval (service_account_id, service_id, tool, args_hash)
  WHERE status = 'pending';
