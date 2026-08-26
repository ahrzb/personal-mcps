// scripts/users.mts — the executable face of scripts/users.ts, nothing else lives here.
//   PMCP_URL=https://… BOOTSTRAP_SECRET=… pnpm users <create|list|delete|reset-password> [username]
import { main } from "./users.ts";

process.exit(await main(process.argv.slice(2)));
