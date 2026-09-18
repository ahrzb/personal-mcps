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
 * direction D. `method` marks commands that front the GATEWAY rather than an admin op:
 * `pmcp tools`, `pmcp call`, and the hub/data-model commands are MCP surface sugar (any
 * admitted agent holding the same token can call those methods directly), so they do not
 * need separately named admin capabilities and are not parity exceptions. `exception`
 * names §8's pinned parity
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
  { name: "ls", ops: ["app_list"] },
  { name: "tools", ops: [], method: "tools/list" },
  { name: "call", ops: [], method: "tools/call" },
  // §23.1: the hub's own two tools, on the virtual `hub` app's scoped endpoint. They front
  // `tools/call` rather than an admin op for the same reason `call` does — any credential
  // (admin tokens included, §23.1) that reaches `/mcp/hub` calls them directly, so no
  // separately-named capability appears here; the aggregate `hub_execute` /
  // `hub_search_types` spelling belongs to the consumer endpoint and never to this table.
  { name: "hub execute", ops: [], method: "tools/call" },
  { name: "hub search-types", ops: [], method: "tools/call" },
  // §23.3's owner-scoped execution settings: real ops, unlike the two rows above — the
  // pair lives in D1 behind `pmcp`, is not an MCP method of its own, and is the same one the
  // `/settings/execution` pane and the provider's `pmcp_hub_settings` front.
  { name: "hub settings get", ops: ["hub_settings_get"] },
  { name: "hub settings set", ops: ["hub_settings_update"] },
  // §20.6 (added 2026-08-26): gateway sugar of exactly the same kind as the two rows above
  // — they front an MCP method on the scoped endpoint, not an admin op, so they sit outside
  // §8's parity list rather than inside it (§10's amendment note).
  { name: "prompts", ops: [], method: "prompts/list" },
  { name: "prompt", ops: [], method: "prompts/get" },
  { name: "resources", ops: [], method: "resources/list" },
  { name: "read", ops: [], method: "resources/read" },
  // A tunneled app is unusable without its token, so §6's lifecycle makes this create
  // two calls rather than one.
  { name: "app create", ops: ["app_create", "token_issue"] },
  { name: "app archive", ops: ["app_archive"] },
  { name: "app unarchive", ops: ["app_unarchive"] },
  { name: "app delete", ops: ["app_delete"] },
  { name: "app disconnect", ops: ["app_disconnect"] },
  { name: "app set-auth", ops: ["app_set_upstream_auth"] },
  // §23.6's owner lane for hub-local TypeScript names: one `app_update` carrying
  // `typescript_aliases` (create carries the same object through the `app create` row
  // above). Display-only renaming on the hub side — the upstream keeps its canonical MCP
  // service/tool names, and reservations/tombstones outlive any single write.
  { name: "app aliases set", ops: ["app_update"] },
  { name: "agent list", ops: ["agent_list"] },
  { name: "agent create", ops: ["agent_create"] },
  { name: "agent update", ops: ["agent_update"] },
  { name: "agent delete", ops: ["agent_delete"] },
  { name: "approvals", ops: ["approval_list"] },
  { name: "approve", ops: ["approval_decide"] },
  { name: "reject", ops: ["approval_decide"] },
  { name: "token issue", ops: ["token_issue"] },
  { name: "token list", ops: ["token_list"] },
  { name: "token revoke", ops: ["token_revoke"] },
  { name: "admin-token issue", ops: ["admin_token_issue"] },
  { name: "admin-token list", ops: ["admin_token_list"] },
  { name: "admin-token revoke", ops: ["admin_token_revoke"] },
  { name: "audit", ops: ["audit_query"] },
  // A serialization of the same query, not a new capability (§8's third pinned exception).
  { name: "audit --export jsonl", ops: ["audit_query"], exception: "jsonl-export" },
  // The consent REDIRECT is browser-only (§8); the command itself only checks the slug
  // and prints the URL.
  { name: "connect", ops: ["app_get"], exception: "oauth-consent" },
  // §19/§8: the OAuth clients connected to this namespace (inbound OAuth, distinct from
  // `connect`'s outbound upstream flow above). No exception here — unlike the consent
  // SCREEN it manages, this pair is grants-shaped and fronts a real op each.
  { name: "connections", ops: ["connection_list"] },
  { name: "connection revoke", ops: ["connection_revoke"] },
];
