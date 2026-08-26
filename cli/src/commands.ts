/**
 * cli/src/commands.ts — §10's command surface as DATA: every subcommand and what it
 * fronts. main.ts dispatches through these names; `server/test/worker/contracts.test.ts`
 * reads the table as the left-hand side of parity direction D (§4, §8).
 *
 * It is a module of its own rather than a `const` in main.ts because the parity suite is a
 * reader of DATA, not of the CLI: main.ts reaches for node:fs and node:os to read the
 * config file, and the suite that checks the mapping has no business loading that (it runs
 * inside workerd, where those are a compatibility shim rather than a filesystem). Nothing
 * here imports anything. main.ts re-exports the table, so a CLI consumer still finds it
 * where the command surface lives.
 */

/**
 * One row of the CLI's command table: an argv spelling and what it fronts.
 *
 * `ops` is the §8 admin ops the subcommand actually calls — the left-hand side of parity
 * direction D. `method` is for the two commands that front the GATEWAY rather than an
 * admin op: `pmcp tools` and `pmcp call` are the MCP tool surface itself (any agent
 * holding the same token calls tools/list and tools/call directly), so they are not a CLI
 * capability that needs a tool of its own — §8's exception list does not mention them
 * because they are not an exception to it. `exception` names §8's pinned parity
 * exceptions — the auth/credential family, the upstream-OAuth consent redirect, and
 * `/audit`'s JSONL export — so a name that fronts no op of its own is always explicitly
 * accounted for rather than skipped.
 */
export type CliCommand = {
  name: string;
  ops: readonly string[];
  method?: string;
  exception?: "auth" | "oauth-consent" | "jsonl-export";
};

/**
 * Every subcommand of §10's surface, as data. A table rather than a switch so the mapping
 * is inspectable from outside the CLI; main.ts dispatches through the same names.
 */
export const COMMANDS: readonly CliCommand[] = [
  { name: "login", ops: [], exception: "auth" },
  { name: "logout", ops: [], exception: "auth" },
  { name: "whoami", ops: [], exception: "auth" },
  { name: "ls", ops: ["service_list"] },
  { name: "tools", ops: [], method: "tools/list" },
  { name: "call", ops: [], method: "tools/call" },
  // A tunneled service is unusable without its token, so §6's lifecycle makes this create
  // two calls rather than one.
  { name: "service create", ops: ["service_create", "token_issue"] },
  { name: "service archive", ops: ["service_archive"] },
  { name: "service unarchive", ops: ["service_unarchive"] },
  { name: "service delete", ops: ["service_delete"] },
  { name: "service disconnect", ops: ["service_disconnect"] },
  { name: "service set-auth", ops: ["service_set_upstream_auth"] },
  { name: "account list", ops: ["account_list"] },
  { name: "account create", ops: ["account_create"] },
  { name: "account delete", ops: ["account_delete"] },
  { name: "approvals", ops: ["approval_list"] },
  { name: "approve", ops: ["approval_decide"] },
  { name: "reject", ops: ["approval_decide"] },
  { name: "token issue", ops: ["token_issue"] },
  { name: "token list", ops: ["token_list"] },
  { name: "token revoke", ops: ["token_revoke"] },
  { name: "audit", ops: ["audit_query"] },
  // A serialization of the same query, not a new capability (§8's third pinned exception).
  { name: "audit --export jsonl", ops: ["audit_query"], exception: "jsonl-export" },
  // The consent REDIRECT is browser-only (§8); the command itself only checks the slug
  // and prints the URL.
  { name: "connect", ops: ["service_get"], exception: "oauth-consent" },
  // §19/§8: the OAuth clients connected to this namespace (inbound OAuth, distinct from
  // `connect`'s outbound upstream flow above). No exception here — unlike the consent
  // SCREEN it manages, this pair is grants-shaped and fronts a real op each.
  { name: "connections", ops: ["connection_list"] },
  { name: "connection revoke", ops: ["connection_revoke"] },
  { name: "diff", ops: ["service_list", "account_list"] },
  {
    name: "apply",
    // The planner's whole vocabulary plus the two reads it plans against — `apply` is the
    // only front for service_update and grant_set (§9: grants are declarative).
    ops: [
      "service_list",
      "account_list",
      "service_create",
      "service_update",
      "service_delete",
      "service_archive",
      "service_unarchive",
      "account_create",
      "account_delete",
      "grant_set",
    ],
  },
];
