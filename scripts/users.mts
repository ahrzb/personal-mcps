// scripts/users.mts — the executable face of scripts/users.ts, plus the one bridge to the
// CLI's profiles, and nothing else lives here.
//   PMCP_URL=https://… BOOTSTRAP_SECRET=… pnpm users <create|list|delete|reset-password> [username]
//   pnpm users --profile local create amir     # same two values, read from config.toml
// applyProfile fills PMCP_URL / BOOTSTRAP_SECRET from the profile only where the
// environment has not already spoken, so users.ts stays env-only — its tested contract.
import { applyProfile } from "../cli/src/main.ts";
import { main } from "./users.ts";

process.exit(await main(applyProfile(process.argv.slice(2))));
