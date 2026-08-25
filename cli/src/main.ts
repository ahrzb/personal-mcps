/**
 * cli/src/main.ts — the pmcp command surface (§10): argv in, exit code out.
 *
 * This module OWNS the CLI's presentation layer: the argv grammar (command and
 * flag spelling, `--json` vs `key=value` tool arguments, the `<slug>_<tool>`
 * aggregated-name split), the config file (`~/.config/pmcp/config.json` —
 * server origin + session token) and the PMCP_URL / PMCP_TOKEN override order,
 * every table/plan/confirmation rendering and exit-code decision, and the
 * CLI's copies of the three pinned wire shapes below. It HIDES the transport:
 * every command except the auth family is presentation sugar over MCP
 * tools/call through the official MCP client (@modelcontextprotocol/client —
 * implementation-time only, never imported here), so no command is a
 * capability an agent holding the same token lacks (§8's parity invariant —
 * only the UX differs). plan.ts stays pure: this module performs all I/O —
 * file reads, tool calls, prompts — and hands the planner plain data. Grants
 * have no imperative family on purpose: they are managed declaratively via
 * diff/apply, or through `pmcp call pmcp grant_set` like any other tool.
 */

import type { CurrentState, Plan } from "./plan";

/**
 * COPIED wire shape — the GET /api/whoami response, pinned by §8 as the
 * CLI↔server contract. Deliberately duplicated here rather than shared through
 * a package; tests pin both sides. `principal` is `"user:<name>"` or
 * `"sa:<slug>"`; `namespace` is the owner username every `/<user>/mcp…` URL is
 * built from — the CLI never guesses it.
 */
export type WhoamiResponse = { principal: string; namespace: string };

/**
 * COPIED wire shape — the `data` of a -32003 "approval required" error (§7).
 * Deliberately duplicated (no shared package; tests pin both sides).
 * `approvalUrl` is absolute and ready to print; `expiresAt` is an ISO-8601
 * instant bounding both the pending wait and the post-approval retry window.
 */
export type ApprovalRequiredData = {
  approvalId: string;
  approvalUrl: string;
  expiresAt: string;
};

/**
 * COPIED wire vocabulary — the hub's JSON-RPC error codes (§7). Deliberately
 * duplicated (no shared package; tests pin both sides). The CLI renders these
 * — -32003 gets its ApprovalRequiredData surfaced as instructions — and treats
 * any other code as a plain failure.
 */
export const HUB_ERRORS = {
  serviceUnavailable: -32000,
  toolNotPermitted: -32001,
  serviceArchived: -32002,
  approvalRequired: -32003,
  methodNotFound: -32601,
} as const;

/**
 * A JSON-RPC error reply as a thrown value — the CLI-local mirror of the hub's
 * error vocabulary (HUB_ERRORS). `data` is the wire `error.data` verbatim; for
 * code -32003 it is ApprovalRequiredData. Thrown by the MCP seams below,
 * rendered only by `call` and main's last-resort handler.
 */
export class HubRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    // deps: none
    super(message);
    throw new Error("unimplemented");
  }
}

/**
 * Everything a resolved command needs to reach the hub: the https origin, the
 * bearer token (session or `pmcp_sa_` — never `pmcp_svc_`, §10), and the
 * whoami-resolved identity. `namespace` is the sole source of `/<user>/mcp…`
 * URLs. Built once per invocation by resolveContext; commands never read
 * config or environment themselves.
 */
export type CliContext = {
  origin: string;
  token: string;
  principal: string;
  namespace: string;
};

/**
 * Builds the per-invocation context: stored config overlaid by PMCP_URL /
 * PMCP_TOKEN, then one GET /api/whoami to learn principal and namespace (§10 —
 * this is how a service-account key learns whose namespace it lives in). A
 * `pmcp_svc_`-prefixed token is refused here with a clear message — every
 * consumer surface rejects service tokens, so failing early beats a confusing
 * server 401; no token at all fails with a "run pmcp login" hint.
 */
async function resolveContext(): Promise<CliContext> {
  // deps: node:fs · node:os · node:process · fetch GET /api/whoami
  throw new Error("unimplemented");
}

/**
 * One tools/list against `POST <origin>/<namespace>/mcp/<slug>` through the
 * official MCP client — a short-lived stateless session per invocation (the
 * hub is POST-only, §7). Returns the grant-filtered descriptors exactly as the
 * hub sent them; a JSON-RPC error reply is thrown as HubRpcError.
 */
async function mcpList(ctx: CliContext, slug: string): Promise<unknown[]> {
  // deps: @modelcontextprotocol/client (Streamable HTTP transport) · HubRpcError
  throw new Error("unimplemented");
}

/**
 * One tools/call against the scoped endpoint — the whole transport of every
 * non-auth command, admin work included (slug "pmcp" reaches §8's ops table).
 * Returns the result verbatim on success; a JSON-RPC error reply is thrown as
 * HubRpcError so renderers can branch on HUB_ERRORS. Never retries — an
 * approval retry is the caller's explicit, identical-args act (§7).
 */
async function mcpCall(
  ctx: CliContext,
  slug: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // deps: @modelcontextprotocol/client (Streamable HTTP transport) · HubRpcError
  throw new Error("unimplemented");
}

/**
 * The diff planner's entire view of the server, read in exactly two calls —
 * service_list plus account_list (§8 pins that grants ride account_list
 * inline; there is no separate grant-read tool) — reshaped into
 * plan.CurrentState. Read-only.
 */
async function readCurrentState(ctx: CliContext): Promise<CurrentState> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * The one human rendering of a Plan, shared by diff and apply so the two can
 * never disagree about what a plan looks like: one summary line per step with
 * destructive steps flagged, then warnings, then hard errors. Pure string
 * building; printing is the caller's.
 */
function renderPlan(p: Plan): string {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * The auth family — the only commands that are not MCP-tool sugar (§10) and
 * the only writer of `~/.config/pmcp/config.json`. `login` runs the RFC 8628
 * device flow against better-auth's endpoints: prints the user code and the
 * /device URL, polls until approved (~10 min device-code lifetime, §13), then
 * stores origin + session token; `url` (or PMCP_URL) picks the hub. `logout`
 * revokes the session server-side and clears the stored token. `whoami` prints
 * the pinned WhoamiResponse from GET /api/whoami — it works with a
 * service-account key too. Exit 0 on success, 1 on any failure.
 */
export async function auth(
  cmd: { sub: "login"; url?: string } | { sub: "logout" } | { sub: "whoami" },
): Promise<number> {
  // deps: fetch (better-auth device-authorization + session endpoints, GET /api/whoami) · node:fs · node:os
  throw new Error("unimplemented");
}

/**
 * `pmcp ls` — the namespace at a glance: every service with kind, status
 * (online/offline for tunneled; not-connected/connected/needs-reconnect for
 * `auth: oauth` proxied, plain "proxy" otherwise), declared roles, and
 * archived flag; the builtin `pmcp` row shows as builtin. Sugar over
 * service_list — with a service-account key it fails like every admin-backed
 * command, since accounts never hold `pmcp` grants (§8, §10).
 */
export async function ls(ctx: CliContext): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * `pmcp tools <service>` — the service's tools/list exactly as the current
 * token sees it (hub-filtered by grants, unprefixed names): what an agent
 * holding this token could call. Hub errors pass through as sent — -32002
 * archived, -32000 unreachable — never rephrased into something softer.
 */
export async function tools(ctx: CliContext, service: string): Promise<number> {
  // deps: mcpList
  throw new Error("unimplemented");
}

/**
 * `pmcp call` — one tools/call against the scoped endpoint, result JSON to
 * stdout. `target` arrives already split by main (`<slug>_<tool>` aggregated
 * names split at the first `_`, unambiguous because slugs contain no
 * underscore, §7); `args` is the parsed `--json`/`key=value` object, sent
 * verbatim. A -32003 reply renders as instructions, not noise: the URL and
 * expiry from ApprovalRequiredData plus the retry-the-identical-call rule
 * (§7). Exit 0 only when the call executed.
 */
export async function call(
  ctx: CliContext,
  target: { service: string; tool: string },
  args: Record<string, unknown>,
): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * One imperative service command, normalized from `pmcp service …` argv by
 * main. `create` of a tunneled service is two tool calls — service_create,
 * then token_issue — because a tunneled service is unusable without its token
 * (§6 lifecycle); proxied create carries endpoint + auth mode instead.
 * `set-auth` holds the full replacement header set (repeatable `--header`
 * flags, write-only, headers-mode services only, §8); `disconnect` wipes an
 * OAuth bundle (`auth: oauth` only).
 */
export type ServiceCommand =
  | { sub: "create"; slug: string; kind: "tunnel" }
  | { sub: "create"; slug: string; kind: "proxy"; endpoint: string; auth: "headers" | "oauth" }
  | { sub: "archive" | "unarchive" | "delete" | "disconnect"; slug: string }
  | { sub: "set-auth"; slug: string; headers: Record<string, string> };

/**
 * `pmcp service …` — the one-off actions the web UI does with buttons (§10);
 * declarative management belongs to diff/apply. Each sub maps onto its §8
 * tool. Tunneled `create` prints the minted service token exactly once — the
 * CLI never stores it. `delete` is destructive (grants cascade, tokens
 * deleted, socket severed — all server-side effects) and asks for
 * confirmation unless `yes`. The reserved `pmcp` slug is rejected uniformly by
 * the server; no client-side gate duplicates that.
 */
export async function service(
  ctx: CliContext,
  cmd: ServiceCommand,
  opts: { yes?: boolean },
): Promise<number> {
  // deps: mcpCall · node:readline
  throw new Error("unimplemented");
}

/** One service-account command, normalized from `pmcp account …` argv. */
export type AccountCommand =
  | { sub: "list" }
  | { sub: "create"; slug: string; name?: string; description?: string }
  | { sub: "delete"; slug: string };

/**
 * `pmcp account …` — sugar over account_list / account_create /
 * account_delete (§8). `list` prints each account with its grants inline (per
 * service: role names and modes) — the same single read the diff planner
 * rides. `delete` is destructive — grants cascade and the account's tokens are
 * deleted server-side — and asks for confirmation unless `yes`.
 */
export async function account(
  ctx: CliContext,
  cmd: AccountCommand,
  opts: { yes?: boolean },
): Promise<number> {
  // deps: mcpCall · node:readline
  throw new Error("unimplemented");
}

/**
 * One approval command: `list` fronts approval_list (default everything,
 * newest first; `filter` narrows), `approve`/`reject` front approval_decide.
 */
export type ApprovalCommand =
  | { sub: "list"; filter?: "pending" | "history" }
  | { sub: "approve" | "reject"; id: string };

/**
 * `pmcp approvals | approve | reject` (§10) — the CLI front of the approval
 * dashboard (§8's approval_list / approval_decide; the web page is the other
 * front). `list` shows pending rows first — id, account, service, tool,
 * stored post-redaction arguments, expiry — then decision history. Deciding an
 * already-expired request fails server-side; the error passes through.
 */
export async function approval(ctx: CliContext, cmd: ApprovalCommand): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * One token command, normalized from `pmcp token …` argv: `issue` targets a
 * service account or a (tunneled) service by slug; `expires` passes through
 * verbatim ("90d", "never" — defaults differ by kind, §5).
 */
export type TokenCommand =
  | { sub: "issue"; kind: "service_account" | "service"; slug: string; expires?: string }
  | { sub: "list" }
  | { sub: "revoke"; id: string };

/**
 * `pmcp token …` — sugar over token_issue / token_list / token_revoke (§8).
 * `issue` prints the plaintext key exactly once and the CLI never stores it.
 * `list` shows prefix, expiry, and the coarse last_used_at that makes
 * rotation state observable (§5). Revoking a service token also severs that
 * service's live socket — a server-side effect, merely reported here.
 */
export async function token(ctx: CliContext, cmd: TokenCommand): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * Filters for `pmcp audit`, mirroring audit_query's parameters (§8) with CLI
 * sugar main resolves before the call: `account` becomes principal
 * `"sa:<slug>"`; `since`/`until` accept relative durations ("7d") or ISO
 * instants. `limit` is the page (and export chunk) size, server default 100.
 */
export type AuditFilters = {
  account?: string;
  service?: string;
  event?: string;
  tool?: string;
  session?: string;
  since?: string;
  until?: string;
  limit?: number;
};

/**
 * `pmcp audit` — audit_query presentation (§8). Default: one page as a table,
 * newest first, plus the "N events match" line from `total`; recorded bodies
 * (§15 — post-redaction and stub-substituted, the only stored form) render in a
 * row's detail, with stubs shown as typed size placeholders
 * (`‹blob image/png · 4.2 MB›`), never raw. `exportJsonl`
 * instead streams EVERY matching row to stdout, one JSON object per line —
 * bodies included verbatim as stored — by
 * re-querying in limit-sized chunks — the same rows as the web export (§10,
 * §13), never held in memory at once. Exit 0 even when nothing matches.
 */
export async function audit(
  ctx: CliContext,
  filters: AuditFilters,
  opts: { exportJsonl?: boolean },
): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * `pmcp diff -f mcps.yaml` — read the file, read the server (one service_list
 * plus one account_list), print the plan: creates/updates/deletes and
 * archive transitions with destructive steps flagged, then warnings, then
 * hard errors (§9). Exit 0 when the plan is applicable — even a non-empty one
 * — and 1 when the file has hard errors. Never mutates anything.
 */
export async function diff(ctx: CliContext, opts: { file: string }): Promise<number> {
  // deps: yaml (parse) · node:fs · plan.parseDesired · plan.planChanges · readCurrentState · renderPlan
  throw new Error("unimplemented");
}

/**
 * `pmcp apply -f mcps.yaml [--yes]` — shows exactly the plan diff prints,
 * refuses outright while it carries hard errors, asks for confirmation
 * (skipped by `yes`), then executes the steps strictly in plan order, one
 * tool call each, stopping at the first failure and reporting the completed
 * prefix — steps are individual admin calls; there is no transaction to roll
 * back. Exit 0 only when every step succeeded.
 */
export async function apply(
  ctx: CliContext,
  opts: { file: string; yes?: boolean },
): Promise<number> {
  // deps: yaml (parse) · node:fs · node:readline · plan.parseDesired · plan.planChanges · readCurrentState · renderPlan · mcpCall
  throw new Error("unimplemented");
}

/**
 * `pmcp connect <service>` — prints the /services OAuth connect URL for an
 * `auth: oauth` proxied service (§7, §10). The consent redirect is inherently
 * a browser interaction (§8 pins Connect outside the tool surface), so
 * printing the URL is the whole command — the CLI never runs the flow. Checks
 * the slug via service_get first, so a typo or a headers-mode service fails
 * here, not in the browser.
 */
export async function connect(ctx: CliContext, service: string): Promise<number> {
  // deps: mcpCall
  throw new Error("unimplemented");
}

/**
 * Process entry: parse argv into exactly one family invocation, resolve the
 * context once (the auth family skips resolution — login must work while
 * logged out), dispatch, return the exit code. Owns the whole argv grammar —
 * command and flag spelling, `--json` vs repeated `key=value` tool arguments,
 * the aggregated-name split for `pmcp call <slug>_<tool>` — and the
 * last-resort error rendering: a HubRpcError prints the hub's message (§15's
 * hygiene means it is safe to show), anything else one terse line; stack
 * traces never reach the user.
 */
export async function main(argv: string[]): Promise<number> {
  // deps: resolveContext · auth · ls · tools · call · service · account · approval · token · audit · diff · apply · connect
  throw new Error("unimplemented");
}
