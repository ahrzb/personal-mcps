// The `worker` and `tunnel` projects' D1 setup: apply every migration in
// server/migrations to the isolated D1 the pool hands each test file.
//
// The migration list is read on the Node side (vitest.config.ts) because workerd has no
// filesystem; it arrives here as the TEST_MIGRATIONS binding. applyD1Migrations is
// idempotent, so running it per file — including in the un-isolated `tunnel` project —
// is a no-op after the first.

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
