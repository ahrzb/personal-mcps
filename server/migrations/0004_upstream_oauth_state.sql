-- 0004_upstream_oauth_state.sql — the upstream-OAuth connect flow's one-time `state`
-- record (§7, "Upstream OAuth"). upstream.ts owns the whole lifecycle of this table:
-- beginConnect writes a row, handleCallback consumes it by compare-and-set DELETE, and
-- cleanupStaleState sweeps what neither reached.
--
-- Separate from 0002 for the ordinary reason migrations are separate: it lands after the
-- tables it references (`user`, `service`) and reads as the change it is. Nothing here
-- rewrites an earlier file.
--
-- WHAT A ROW IS: §7's "one-time unguessable `state`, stored server-side bound to {owner,
-- service, expected AS issuer + token endpoint, PKCE verifier} and to the initiating
-- cookie session, expiring in ~10 minutes". Every column below is one clause of that
-- sentence, and the binding is the point: because the one callback URL
-- (`/oauth/upstream/callback`) is shared across every authorization server, this row is
-- ALSO the mix-up defense — the code is redeemed, with the bound verifier, only at
-- `token_endpoint`, never at an endpoint the callback's own response names.
--
-- `code_verifier` is stored in PLAINTEXT, deliberately and not for lack of an envelope
-- (upstream.ts has one). The verifier is not a hub credential: it lives ~10 minutes, it
-- authorizes nothing on its own, and an attacker who can read this table can already read
-- the authorization code and the sealed token bundle beside it — so sealing it buys
-- nothing an intercepted code would not already defeat. What DOES bind: the value must
-- never appear in a log line, an audit `detail`, or an error message (§15).
--
-- `expires_at` is enforced at READ time by handleCallback, never by this schema and never
-- by the sweep: the daily cron (§15) is hygiene, so a past-TTL row is already dead to the
-- callback before anything deletes it.
--
-- NO DEFAULT on any column, for 0002's reason: every column here is bound unconditionally
-- by beginConnect, the only writer, so a DEFAULT would be a second, never-exercised answer
-- to "what does an absent value mean".
--
-- ponytail: NOT pinned by migrations.test.ts's constraint oracle. Pinning an eighth table
-- there requires new rows in `schemaConstraintRows` and new members in `cascadeRows`, both
-- OWNER-AUTHORED tables that agents may not fill (strategy §9 rule 1). Add the rows and
-- this table to that file's SchemaTable/SCHEMA_TABLES/baseRow/ctxFilter when an owner
-- authors them; until then the DDL below is unpinned.

CREATE TABLE upstream_oauth_state (
  state TEXT PRIMARY KEY,                 -- the unguessable nonce itself; also the `state`
                                          -- parameter, so resolving a callback is one lookup
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,               -- identity.OwnerSession.sessionId — only the browser
                                          -- session that began the flow may complete it (§7);
                                          -- no FK: better-auth owns `session` and a signed-out
                                          -- session must not silently delete a live state row
  issuer TEXT NOT NULL,                   -- the AS issuer discovered at initiation; RFC 9207's
                                          -- `iss` is compared against THIS, never against the
                                          -- callback's own claim
  token_endpoint TEXT NOT NULL,           -- the mix-up defense: the code is redeemed here alone
  client_id TEXT NOT NULL,                -- the CIMD URL, or the id DCR handed back
  code_verifier TEXT NOT NULL,            -- PKCE S256 verifier; plaintext (see header)
  redirect_uri TEXT NOT NULL,             -- what was sent to /authorize, replayed at redemption
  issuer_advertised INTEGER NOT NULL,     -- 0/1: did the AS metadata declare
                                          -- authorization_response_iss_parameter_supported?
                                          -- §7's `iss` check is CONDITIONAL on it, so the
                                          -- condition is recorded at initiation rather than
                                          -- re-derived from an attacker-influenced response
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL             -- created_at + limits.OAUTH_STATE_TTL_MS
);

-- The sweep's whole access pattern (`DELETE ... WHERE expires_at < ?`), and nothing else
-- reads by anything but the primary key.
CREATE INDEX upstream_oauth_state_expires ON upstream_oauth_state (expires_at);
