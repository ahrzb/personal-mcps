// cli/pmcp.mts — the executable face of cli/src/main.ts, nothing else lives here.
// Run through the repo script:  pnpm pmcp <command …>   (flags that collide with
// pnpm's own go after a `--`:  pnpm pmcp -- apply --yes).
import { main } from "./src/main.ts";

// `exitCode`, not `exit()`: process.exit() tears the loop down mid-flight, and on Windows
// Node ≤24.19 that aborts with a libuv assertion (src\win\async.c) once two or more fetch()
// calls have run — nodejs/node#56645, fixed upstream only in v26.7.0. Letting the loop drain
// costs ~1ms here; nothing in the CLI holds a handle open past the last await.
process.exitCode = await main(process.argv.slice(2));
