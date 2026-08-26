#!/usr/bin/env node
// cli/pmcp.mts — the executable face of cli/src/main.ts, nothing else lives here.
// Run through the repo script:  pnpm pmcp <command …>   (flags that collide with
// pnpm's own go after a `--`:  pnpm pmcp -- apply --yes), or without a clone via
// the root package's bin:  npx github:ahrzb/personal-mcps <command …>  (needs a
// Node whose type stripping is on by default, ≥22.18 / ≥23.6 — the shebang runs
// this .mts file as-is).
import { main } from "./src/main.ts";

// `exitCode`, not `exit()`: process.exit() tears the loop down mid-flight, and on Windows
// Node ≤24.19 that aborts with a libuv assertion (src\win\async.c) once two or more fetch()
// calls have run — nodejs/node#56645, fixed upstream only in v26.7.0. Letting the loop drain
// costs ~1ms here; nothing in the CLI holds a handle open past the last await.
process.exitCode = await main(process.argv.slice(2));
