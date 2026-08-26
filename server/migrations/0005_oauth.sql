-- 0005_oauth.sql — §19 inbound OAuth: the hub as an authorization server.
--
-- Two halves, one migration, exactly as §19.4 pins.
--
-- GENERATED HALF (below, camelCase, lowercase DDL): the eight tables the
-- @better-auth/oauth-provider + jwt() plugins add — `jwks` from jwt(), and the seven
-- provider tables oauthClient / oauthResource / oauthClientResource / oauthRefreshToken
-- / oauthAccessToken / oauthConsent / oauthClientAssertion. Authorization codes and DPoP
-- replay reservations reuse better-auth's existing `verification` table (0001); nothing
-- else is added there. These statements are EMITTED, not transcribed — the 0001
-- postmortem (three hand-transcription deltas found at runtime) is the argument, and
-- better-auth is a dependency now. They were produced by `getMigrations(config,
-- {throwOnUnsafe:false}).compileMigrations()` (the same plan `@better-auth/cli generate`
-- runs) against a node:sqlite in-memory DB with the IDENTICAL plugin list to identity.ts's
-- auth(), then filtered to the eight tables 0001 does not already create. Their camelCase
-- names and lowercase DDL are the generator's and stay OUT of migrations.test.ts's
-- SCHEMA_TABLES, exactly as `user`/`session` already do (§19.4).
--
-- Regeneration path (unchanged from 0001's): re-run that command with identity.ts's plugin
-- list, filter to the same eight tables, replace the generated block below verbatim. A
-- column better-auth adds that a stale block missed shows up as a better-auth runtime
-- error, never a silent wrong answer — nothing in server/src reads these tables directly.
--
-- HAND-WRITTEN HALF: `oauth_binding` (this repo's snake_case, §19.4's exact CREATE TABLE)
-- is the hub's own table and the only §19 table pinned in SCHEMA_TABLES. Then the §19.3
-- back-fill: one `oauthResource` row per pre-existing user, so the owner this whole section
-- was built for is not left unable to complete an authorization. New users get their row on
-- the provisioning path (admin.provisionUser); this covers everyone who existed first.

-- ─────────────────────────── generated half (do not edit by hand) ───────────────────────────

create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date, "alg" text, "crv" text);

create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);

create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);

create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);

create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);

create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);

create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);

create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null);

create index "oauthClient_userId_idx" on "oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- ─────────────────────────── hand-written half (this repo's convention) ───────────────────────────

CREATE TABLE oauth_binding (            -- §19: one OAuth client to one service account
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  client_id TEXT NOT NULL,             -- oauthClient.clientId, no FK (better-auth owns that
                                       -- table, and §5 already takes this posture for
                                       -- token.ref_id)
  service_account_id TEXT NOT NULL REFERENCES service_account (id) ON DELETE CASCADE,
                                       -- deleting the account revokes the connection by
                                       -- construction: the door reads this row per call
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,                -- coarse, same TOKEN_LAST_USED_STAMP_MS window as
                                       -- token.last_used_at (§5) — the same staleness signal
  revoked_at INTEGER,
  UNIQUE (owner_id, client_id)         -- one binding per client per namespace; re-consent
                                       -- with a different account UPDATEs it (audit row
                                       -- oauth.rebound) instead of accumulating rows
);

-- §19.3 back-fill: an oauthResource row for every PRE-EXISTING user, so the existing owner
-- (the one person this section was built for) can complete an authorization. The identifier
-- is https://<origin>/<user>/mcp — the same string the PRM names as `resource`, the door
-- checks as `aud`, and admin.provisionUser writes for NEW users. `name` mirrors that seam
-- (the username). `id` is 'oauthres_' || user.id: deterministic and unique per user, so a
-- re-run cannot double-insert (the NOT EXISTS guard is belt-and-braces on the UNIQUE
-- identifier). Users with no username own no namespace, so they get no row.
--
-- ponytail: the origin is a LITERAL here because a .sql migration cannot read the
-- PUBLIC_ORIGIN var. It MUST equal wrangler.jsonc's PUBLIC_ORIGIN (and admin.provisionUser's
-- env.PUBLIC_ORIGIN) or a back-filled identifier will not match what the PRM/door use.
-- Change PUBLIC_ORIGIN and every absolute URL the hub emits breaks anyway; this line is one
-- of them, not a new coupling.
INSERT INTO "oauthResource" ("id", "identifier", "name")
SELECT 'oauthres_' || "user"."id",
       'https://personal-mcps.ahrzb.workers.dev/' || "user"."username" || '/mcp',
       "user"."username"
  FROM "user"
 WHERE "user"."username" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "oauthResource"
      WHERE "oauthResource"."identifier" =
            'https://personal-mcps.ahrzb.workers.dev/' || "user"."username" || '/mcp'
   );
