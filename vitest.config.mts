// vitest.config.ts — the four-and-a-bit projects the testing strategy §2 pins, in one
// place. Nothing here decides WHAT is tested; it decides only where each suite runs and
// what the runtime under it is.
//
//   unit     plain Node, parallel, milliseconds — pure seams (deps line `none`)
//   worker   workerd via @cloudflare/vitest-plugin, real D1, per-file storage isolation
//   tunnel   the same runtime, SERIAL and un-isolated — WebSockets and Durable Objects
//            are the two things per-file isolation cannot cover
//   cli      plain Node — the diff planner
//   clients  plain Node — clients/js plus scripts/test (§2's "`scripts` + clients" row)
//
// D1: migrations are read HOST-side (readD1Migrations is exported from the package's
// main entry; the JSDoc pointing at `/config` is stale) and handed to the pool as a
// binding, which server/test/setup/d1.ts applies inside workerd. applyD1Migrations is
// idempotent, so per-file re-application is free.

import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// `.mts`, and therefore ESM: the top-level await below is a build error under the CJS
// output Vite falls back to for a plain `.ts` config.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "server/migrations"));

/** Everything the two workerd projects share: the repo's real wrangler config and the migration set. */
const workersPool = {
  wrangler: { configPath: "./wrangler.jsonc" },
  miniflare: {
    // Read by server/test/setup/d1.ts, which is the only thing that touches it.
    bindings: { TEST_MIGRATIONS: migrations },
  },
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["server/test/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [cloudflareTest(workersPool)],
        test: {
          name: "worker",
          include: ["server/test/worker/**/*.test.ts"],
          setupFiles: ["./server/test/setup/d1.ts"],
        },
      },
      {
        plugins: [cloudflareTest(workersPool)],
        test: {
          name: "tunnel",
          include: ["server/test/tunnel/**/*.test.ts"],
          setupFiles: ["./server/test/setup/d1.ts"],
          // Serial and un-isolated: a hibernating socket and a Durable Object outlive
          // the per-file storage reset, so this project trades isolation for them and
          // every case mints its own service id instead (tunnel/smoke.test.ts).
          fileParallelism: false,
          isolate: false,
          maxWorkers: 1,
          minWorkers: 1,
          // Its own group, so vitest runs it as a phase of its own after the parallel
          // projects — a project whose maxWorkers differs may not share a group order.
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "cli",
          environment: "node",
          include: ["cli/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "clients",
          environment: "node",
          include: ["clients/js/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
        },
      },
    ],
  },
});
