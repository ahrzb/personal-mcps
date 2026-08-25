-- 0001_auth.sql — better-auth's own schema (§4 "Schema migrations", §5 "better-auth owns").
--
-- SCOPE: this file is better-auth's, not ours. Every table and column below is what
-- `@better-auth/cli generate` emits for the pinned plugin list — username, twoFactor,
-- passkey, deviceAuthorization, bearer (§4) — against its SQLite dialect, which is the
-- same dialect D1 runs, so the emitted SQL is checked in unchanged (§4). Nothing here is
-- hand-tuned, and our one extension to better-auth's tables (`passkey.last_used_at`, §5)
-- lives in 0002 rather than in this file, so regenerating replaces this file WHOLESALE
-- without taking our column with it.
--
-- Consequences for the rest of the schema: identifiers are better-auth's camelCase and
-- stay quoted, while ours (0002, 0003) are snake_case — the two conventions are how you
-- tell whose table you are looking at. The four columns of ours that
-- `REFERENCES "user"("id")` (§5) are declared in 0002/0003 and depend on this file
-- running first, which the 0001 prefix guarantees.
--
-- 2026-08-25: three transcription deltas corrected in place against better-auth 1.7.1's
-- own models, each observed as a runtime failure before it was fixed (D4's probe):
-- `account.issuer` was missing, `twoFactor` was missing verified/failedVerificationCount/
-- lockedUntil, and `deviceCode` carried createdAt/updatedAt that better-auth never writes.
-- The upgrade path below is unchanged and still the real fix.
--
-- ponytail: transcribed by hand from better-auth ≥ 1.7's SQLite generator output — the
-- CLI cannot run yet (better-auth is not a dependency of this repo, and adding one is
-- outside the migrations phase). Upgrade path when it lands: run the §4 CLI-only auth
-- config against a local SQLite dialect and replace THIS FILE with its output verbatim,
-- then diff — a column better-auth adds that this transcription missed shows up as a
-- better-auth runtime error, never as a silent wrong answer, because nothing in
-- server/src reads these tables directly.

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  -- username plugin: login is username + password; `email` above is the synthesized
  -- `<username>@users.local` placeholder and is never used (§4).
  "username" TEXT UNIQUE,
  "displayUsername" TEXT,
  -- twoFactor plugin.
  "twoFactorEnabled" INTEGER
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  -- 1.7's account-identity scoping: required, and written as 'local:credential' for a
  -- password account. Missing from the original transcription — sign-up failed 500.
  "issuer" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE,
  "updatedAt" DATE
);

CREATE TABLE "twoFactor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "secret" TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- TOTP enrollment/verification state (optional in the model, so no NOT NULL).
  "verified" INTEGER,
  "failedVerificationCount" INTEGER,
  "lockedUntil" DATE
);

CREATE TABLE "passkey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT,
  "createdAt" DATE,
  "aaguid" TEXT
);

CREATE TABLE "deviceCode" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceCode" TEXT NOT NULL,
  "userCode" TEXT NOT NULL,
  "userId" TEXT,
  "expiresAt" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "lastPolledAt" DATE,
  "pollingInterval" INTEGER,
  "clientId" TEXT,
  "scope" TEXT
  -- No createdAt/updatedAt: better-auth 1.7's deviceCode model declares neither, so its
  -- INSERT omits both. Declared NOT NULL here, they failed every device/code call with a
  -- NOT NULL constraint violation — an EXTRA-column mismatch, which never surfaces as
  -- "no such column".
);
