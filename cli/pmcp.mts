// cli/pmcp.mts — the executable face of cli/src/main.ts, nothing else lives here.
// Run through the repo script:  pnpm pmcp <command …>   (flags that collide with
// pnpm's own go after a `--`:  pnpm pmcp -- apply --yes).
import { main } from "./src/main.ts";

process.exit(await main(process.argv.slice(2)));
